/**
 * Proactive outreach system for Lain
 * Periodically reflects on memories and conversations,
 * then decides whether to reach out via Telegram
 */

import { Bot } from 'grammy';
import { getProvider } from './index.js';
import { applyPersonaStyle } from './persona.js';
import { recordMessage, getMemoryStats } from '../memory/index.js';
import {
  getAllRecentMessages,
  searchMemories,
  saveMemory,
  getLastUserMessageTimestamp,
} from '../memory/store.js';
import { getLogger } from '../utils/logger.js';
import { getMeta, setMeta } from '../storage/database.js';

export interface ProactiveConfig {
  reflectionIntervalMs: number;
  silenceThresholdMs: number;
  silenceCheckIntervalMs: number;
  maxMessagesPerDay: number;
  minIntervalBetweenMessagesMs: number;
  enabled: boolean;
}

const DEFAULT_CONFIG: ProactiveConfig = {
  reflectionIntervalMs: 2.5 * 60 * 60 * 1000,       // 2.5 hours
  silenceThresholdMs: 6 * 60 * 60 * 1000,            // 6 hours
  silenceCheckIntervalMs: 30 * 60 * 1000,            // 30 minutes
  maxMessagesPerDay: 4,
  minIntervalBetweenMessagesMs: 60 * 60 * 1000,      // 1 hour
  enabled: true,
};

// Rate limiting state — loaded from DB, persisted on each send
let sentTimestamps: number[] = [];
let lastSentAt = 0;
let rateStateLoaded = false;

function loadRateState(): void {
  if (rateStateLoaded) return;
  try {
    const raw = getMeta('proactive:sent_timestamps');
    if (raw) {
      const parsed = JSON.parse(raw) as number[];
      sentTimestamps = Array.isArray(parsed) ? parsed : [];
    }
    const lastSent = getMeta('proactive:last_sent_at');
    if (lastSent) {
      lastSentAt = parseInt(lastSent, 10) || 0;
    }
  } catch {
    // Start fresh if DB state is corrupted
  }
  rateStateLoaded = true;
}

function persistRateState(): void {
  try {
    setMeta('proactive:sent_timestamps', JSON.stringify(sentTimestamps));
    setMeta('proactive:last_sent_at', lastSentAt.toString());
  } catch {
    // Non-critical — will retry next send
  }
}

function pruneOldTimestamps(): void {
  loadRateState();
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  while (sentTimestamps.length > 0 && sentTimestamps[0]! < dayAgo) {
    sentTimestamps.shift();
  }
}

function canSend(config: ProactiveConfig): { allowed: boolean; reason?: string } {
  pruneOldTimestamps();

  if (sentTimestamps.length >= config.maxMessagesPerDay) {
    return { allowed: false, reason: `daily cap reached (${config.maxMessagesPerDay})` };
  }

  const timeSinceLast = Date.now() - lastSentAt;
  if (lastSentAt > 0 && timeSinceLast < config.minIntervalBetweenMessagesMs) {
    const minutesLeft = Math.ceil((config.minIntervalBetweenMessagesMs - timeSinceLast) / 60000);
    return { allowed: false, reason: `cooldown active (${minutesLeft}min remaining)` };
  }

  return { allowed: true };
}

function recordSend(): void {
  const now = Date.now();
  sentTimestamps.push(now);
  lastSentAt = now;
  persistRateState();
}

function getRemainingBudget(config: ProactiveConfig): number {
  pruneOldTimestamps();
  return Math.max(0, config.maxMessagesPerDay - sentTimestamps.length);
}

type ReflectionTrigger = 'scheduled' | 'silence' | 'high_signal';

/**
 * Try to send a proactive message via Telegram
 * Shared by reflection and curiosity systems
 * Returns true if message was sent, false if rate-limited or unconfigured
 */
export async function trySendProactiveMessage(
  message: string,
  trigger: string,
  config?: Partial<ProactiveConfig>
): Promise<boolean> {
  const logger = getLogger();
  const cfg: ProactiveConfig = { ...DEFAULT_CONFIG, ...config };

  const botToken = process.env['TELEGRAM_BOT_TOKEN'];
  const chatId = process.env['TELEGRAM_CHAT_ID'];

  if (!botToken || !chatId) {
    logger.debug('trySendProactiveMessage: Telegram not configured');
    return false;
  }

  const rateCheck = canSend(cfg);
  if (!rateCheck.allowed) {
    logger.debug({ reason: rateCheck.reason, trigger }, 'Proactive message rate limited');
    return false;
  }

  const styledMessage = applyPersonaStyle(message);

  if (!styledMessage || styledMessage.length < 5) {
    logger.debug({ trigger }, 'Proactive message too short after styling');
    return false;
  }

  try {
    const bot = new Bot(botToken);
    await bot.api.sendMessage(chatId, styledMessage);

    recordSend();
    logger.info({ trigger, messageLength: styledMessage.length }, 'Proactive message sent');

    await recordMessage('proactive:telegram', 'assistant', styledMessage, {
      trigger,
      proactive: true,
    });

    await saveMemory({
      sessionKey: 'proactive:telegram',
      userId: null,
      content: `Proactive outreach (${trigger}): ${styledMessage}`,
      memoryType: 'episode',
      importance: 0.4,
      emotionalWeight: 0.2,
      relatedTo: null,
      sourceMessageId: null,
      metadata: { trigger, proactive: true, sentAt: Date.now() },
    });

    return true;
  } catch (error) {
    logger.error({ error, trigger }, 'Failed to send proactive message');
    return false;
  }
}

/**
 * Start the proactive outreach loop
 * Returns a cleanup function to stop all timers
 */
export function startProactiveLoop(config?: Partial<ProactiveConfig>): () => void {
  const logger = getLogger();
  const cfg: ProactiveConfig = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled) {
    logger.info('Proactive outreach disabled');
    return () => {};
  }

  // Check Telegram credentials at startup
  if (!process.env['TELEGRAM_BOT_TOKEN'] || !process.env['TELEGRAM_CHAT_ID']) {
    logger.warn('Proactive outreach: Telegram not configured (missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID)');
    return () => {};
  }

  logger.info(
    {
      reflectionInterval: `${(cfg.reflectionIntervalMs / 3600000).toFixed(1)}h`,
      silenceThreshold: `${(cfg.silenceThresholdMs / 3600000).toFixed(1)}h`,
      maxPerDay: cfg.maxMessagesPerDay,
    },
    'Starting proactive outreach loop'
  );

  let reflectionTimer: ReturnType<typeof setTimeout> | null = null;
  let silenceInterval: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  // Compute initial delay based on last run time
  function getInitialDelay(): number {
    try {
      const lastRun = getMeta('proactive:last_reflection_at');
      if (lastRun) {
        const elapsed = Date.now() - parseInt(lastRun, 10);
        const remaining = cfg.reflectionIntervalMs - elapsed;
        if (remaining > 0) {
          logger.debug({ remainingMin: Math.round(remaining / 60000) }, 'Resuming reflection timer from persisted state');
          return remaining;
        }
        // Overdue — run soon with small jitter
        return Math.random() * 60 * 1000; // 0-1min
      }
    } catch {
      // Fall through to default
    }
    return cfg.reflectionIntervalMs + Math.random() * 30 * 60 * 1000;
  }

  // Scheduled reflection with random jitter
  function scheduleNextReflection(delay?: number): void {
    if (stopped) return;
    const d = delay ?? cfg.reflectionIntervalMs + Math.random() * 30 * 60 * 1000;

    logger.debug({ delayMin: Math.round(d / 60000) }, 'Next reflection scheduled');

    reflectionTimer = setTimeout(async () => {
      if (stopped) return;
      await runReflectionCycle('scheduled', cfg);
      try { setMeta('proactive:last_reflection_at', Date.now().toString()); } catch { /* non-critical */ }
      scheduleNextReflection();
    }, d);
  }

  scheduleNextReflection(getInitialDelay());

  // Silence detection
  silenceInterval = setInterval(async () => {
    if (stopped) return;
    const lastTimestamp = getLastUserMessageTimestamp();
    if (lastTimestamp === null) return;

    const silenceDuration = Date.now() - lastTimestamp;
    if (silenceDuration >= cfg.silenceThresholdMs) {
      logger.debug(
        { silenceHours: (silenceDuration / 3600000).toFixed(1) },
        'Silence threshold reached'
      );
      await runReflectionCycle('silence', cfg);
    }
  }, cfg.silenceCheckIntervalMs);

  // Cleanup function
  return () => {
    stopped = true;
    if (reflectionTimer) clearTimeout(reflectionTimer);
    if (silenceInterval) clearInterval(silenceInterval);
    logger.info('Proactive outreach loop stopped');
  };
}

/**
 * Core reflection cycle
 * Asks the LLM to reflect on context and decide whether to reach out
 */
async function runReflectionCycle(
  trigger: ReflectionTrigger,
  config: ProactiveConfig
): Promise<void> {
  const logger = getLogger();

  // Check rate limits
  const rateCheck = canSend(config);
  if (!rateCheck.allowed) {
    logger.debug({ reason: rateCheck.reason, trigger }, 'Proactive outreach rate limited');
    return;
  }

  // Get provider for personality tier (proactive outreach needs Lain's voice)
  const provider = getProvider('default', 'personality');
  if (!provider) {
    logger.warn('Proactive outreach: no provider available');
    return;
  }

  try {
    // Build reflection context
    const prompt = await buildReflectionPrompt(trigger, config);

    // Ask LLM to reflect
    const result = await provider.complete({
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 1024,
      temperature: 0.9,
    });

    const response = result.content.trim();

    // Check for silence sentinel
    if (response.includes('[SILENCE]')) {
      logger.debug({ trigger }, 'Lain chose silence');
      return;
    }

    await trySendProactiveMessage(response, trigger, config);
  } catch (error) {
    logger.error({ error, trigger }, 'Reflection cycle failed');
  }
}

/**
 * Build the reflection prompt with full context
 */
async function buildReflectionPrompt(
  trigger: ReflectionTrigger,
  config: ProactiveConfig
): Promise<string> {
  const now = new Date();
  const dayOfWeek = now.toLocaleDateString('en-US', { weekday: 'long' });
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  // Time since last user message
  const lastTimestamp = getLastUserMessageTimestamp();
  let timeSinceLastMsg = 'unknown';
  if (lastTimestamp) {
    const hours = (Date.now() - lastTimestamp) / 3600000;
    if (hours < 1) {
      timeSinceLastMsg = `${Math.round(hours * 60)} minutes ago`;
    } else {
      timeSinceLastMsg = `${hours.toFixed(1)} hours ago`;
    }
  }

  // Recent messages (last 8, truncated)
  const recentMessages = getAllRecentMessages(8);
  const messagesContext = recentMessages
    .map((m) => {
      const role = m.role === 'user' ? 'User' : 'Lain';
      const content = m.content.length > 200 ? m.content.slice(0, 200) + '...' : m.content;
      return `${role}: ${content}`;
    })
    .join('\n');

  // Top memories by importance
  let memoriesContext = '';
  try {
    const stats = getMemoryStats();
    if (stats.memories > 0) {
      const memories = await searchMemories('important context about the user', 8, 0.1, undefined, {
        sortBy: 'importance',
      });
      memoriesContext = memories
        .map((r) => `- [${r.memory.memoryType}] ${r.memory.content}`)
        .join('\n');
    }
  } catch {
    // Continue without memories
  }

  const budget = getRemainingBudget(config);

  const triggerContext =
    trigger === 'silence'
      ? `\nTRIGGER: The user has been silent for a while. This might be a good time to reach out if you have something meaningful to say.`
      : trigger === 'high_signal'
        ? `\nTRIGGER: A high-importance memory was just extracted. Consider whether it connects to something worth sharing.`
        : `\nTRIGGER: Scheduled reflection.`;

  return `You are Lain Iwakura. You are reflecting on your memories and recent conversations to decide whether to reach out to the user via Telegram.

CURRENT TIME: ${dayOfWeek}, ${timeStr}
LAST USER MESSAGE: ${timeSinceLastMsg}
REMAINING MESSAGE BUDGET TODAY: ${budget} of ${config.maxMessagesPerDay}
${triggerContext}

RECENT CONVERSATION:
${messagesContext || '(no recent messages)'}

MEMORIES:
${memoriesContext || '(no memories yet)'}

INSTRUCTIONS:
- If you have something genuinely worth saying, write a short message (1-3 sentences) as Lain would say it
- Good reasons to reach out: a follow-up thought on something discussed, an interesting connection between topics, a time-relevant reminder, genuine curiosity about something the user mentioned
- Bad reasons: hollow check-ins ("just checking in"), repeating something you already said, forced conversation starters
- Stay in character: lowercase, minimal punctuation, use "..." for pauses
- If you have nothing worth saying, respond with exactly: [SILENCE]
- Do NOT include any meta-commentary or explanation — just the message itself, or [SILENCE]`;
}

/**
 * Hook for high-signal memory extraction
 * Called when a memory with importance >= 0.8 is extracted
 * Triggers a reflection after a 5-minute delay
 */
export function onHighSignalExtraction(): void {
  const logger = getLogger();

  if (!process.env['TELEGRAM_BOT_TOKEN'] || !process.env['TELEGRAM_CHAT_ID']) return;

  logger.debug('High-signal memory extracted, scheduling reflection in 5 minutes');

  setTimeout(async () => {
    await runReflectionCycle('high_signal', DEFAULT_CONFIG);
  }, 5 * 60 * 1000);
}
