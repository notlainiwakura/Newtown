/**
 * Letter composition loop — bidirectional between Lain and Wired Lain.
 * Composes and delivers a daily letter to the other sister.
 * Disabled by default — requires LAIN_INTERLINK_TARGET env var.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProvider } from './index.js';
import { saveMemory } from '../memory/store.js';
import { query } from '../storage/database.js';
import { getMeta, setMeta } from '../storage/database.js';
import { getLogger } from '../utils/logger.js';
import { getBasePath } from '../config/paths.js';
import { getInterlinkHeaders } from '../security/interlink-auth.js';
import type { WiredLetter } from './membrane.js';

interface LetterConfig {
  intervalMs: number;
  targetHour: number;
  targetUrl: string | null;
  enabled: boolean;
  maxJitterMs: number;
}

interface JournalEntry {
  id: string;
  timestamp: string;
  content: string;
}

interface MemoryRow {
  id: string;
  session_key: string | null;
  content: string;
  importance: number;
  emotional_weight: number;
  created_at: number;
  metadata: string;
}

const DEFAULT_CONFIG: LetterConfig = {
  intervalMs: 24 * 60 * 60 * 1000,
  targetHour: 21,
  targetUrl: process.env['LAIN_INTERLINK_TARGET'] ?? null,
  enabled: true,
  maxJitterMs: 30 * 60 * 1000,
};

const JOURNAL_PATH = join(getBasePath(), '.private_journal', 'thoughts.json');

/**
 * Load journal entries since a given timestamp
 */
function loadJournalSince(sinceMs: number): JournalEntry[] {
  try {
    const raw = readFileSync(JOURNAL_PATH, 'utf-8');
    const data = JSON.parse(raw) as { entries?: JournalEntry[] };
    const entries = data.entries ?? [];
    return entries.filter(
      (e) => new Date(e.timestamp).getTime() > sinceMs
    );
  } catch {
    return [];
  }
}

/**
 * Get memories by session key created since a timestamp
 */
function getMemoriesSince(sessionKey: string, sinceMs: number, limit = 10): MemoryRow[] {
  return query<MemoryRow>(
    `SELECT * FROM memories
     WHERE session_key = ? AND created_at > ?
     ORDER BY created_at DESC
     LIMIT ?`,
    [sessionKey, sinceMs, limit]
  );
}

/**
 * Get top memories by importance created since a timestamp
 */
function getNotableMemoriesSince(sinceMs: number, limit = 5): MemoryRow[] {
  return query<MemoryRow>(
    `SELECT * FROM memories
     WHERE created_at > ? AND importance >= 0.4
     ORDER BY importance DESC
     LIMIT ?`,
    [sinceMs, limit]
  );
}

/**
 * Compute delay until the next target hour
 */
function getDelayUntilTargetHour(targetHour: number): number {
  const now = new Date();
  const target = new Date(now);
  target.setHours(targetHour, 0, 0, 0);

  if (now >= target) {
    target.setDate(target.getDate() + 1);
  }

  return target.getTime() - now.getTime();
}

/**
 * Start the letter composition loop.
 * Returns a cleanup function to stop the timer.
 */
export function startLetterLoop(config?: Partial<LetterConfig>): () => void {
  const logger = getLogger();
  const cfg: LetterConfig = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.targetUrl) {
    logger.info('Letter loop disabled (no target configured)');
    return () => {};
  }

  if (!cfg.enabled) {
    logger.info('Letter loop disabled');
    return () => {};
  }

  logger.info(
    {
      targetUrl: cfg.targetUrl,
      targetHour: cfg.targetHour,
      interval: `${(cfg.intervalMs / 3600000).toFixed(0)}h`,
    },
    'Starting letter loop'
  );

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function getInitialDelay(): number {
    try {
      const lastRun = getMeta('letter:last_sent_at');
      if (lastRun) {
        const elapsed = Date.now() - parseInt(lastRun, 10);
        if (elapsed < cfg.intervalMs) {
          const delayToTarget = getDelayUntilTargetHour(cfg.targetHour);
          logger.debug(
            { delayHours: (delayToTarget / 3600000).toFixed(1) },
            'Letter sent recently, scheduling for next target hour'
          );
          return delayToTarget;
        }
        // Overdue — run soon with small jitter
        return Math.random() * 5 * 60 * 1000;
      }
    } catch {
      // Fall through
    }
    return getDelayUntilTargetHour(cfg.targetHour);
  }

  function scheduleNext(delay?: number): void {
    if (stopped) return;
    const d = delay ?? cfg.intervalMs + (Math.random() - 0.5) * 2 * cfg.maxJitterMs;

    logger.debug(
      { delayHours: (d / 3600000).toFixed(1) },
      'Next letter scheduled'
    );

    timer = setTimeout(async () => {
      if (stopped) return;
      logger.info('Letter cycle firing now');
      try {
        await runLetterCycle(cfg);
        setMeta('letter:last_sent_at', Date.now().toString());
      } catch (err) {
        logger.error({ error: String(err) }, 'Letter cycle top-level error');
      }
      scheduleNext();
    }, d);
  }

  scheduleNext(getInitialDelay());

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    logger.info('Letter loop stopped');
  };
}

/**
 * Run a single letter cycle:
 * 1. Gather context since last letter
 * 2. Compose letter via LLM (Opus)
 * 3. Deliver to target
 * 4. Save locally as memory
 */
export async function runLetterCycle(cfg: LetterConfig = DEFAULT_CONFIG): Promise<void> {
  const logger = getLogger();

  if (!cfg.targetUrl) {
    throw new Error('no interlink target configured (LAIN_INTERLINK_TARGET not set)');
  }

  // Check if Dr. Claude has blocked letter sending
  const blocked = getMeta('letter:blocked');
  if (blocked === 'true') {
    const reason = getMeta('letter:block_reason');
    throw new Error(`letter blocked by Dr. Claude: ${reason}`);
  }

  const provider = getProvider('default', 'personality');
  if (!provider) {
    logger.warn('Letter cycle: no provider available');
    return;
  }

  // Determine time window
  const lastSentRaw = getMeta('letter:last_sent_at');
  const sinceMs = lastSentRaw
    ? parseInt(lastSentRaw, 10)
    : Date.now() - 3 * 24 * 60 * 60 * 1000; // default: last 3 days

  // 1. Diary entries since last letter
  const diaryEntries = loadJournalSince(sinceMs);
  const diaryContext = diaryEntries.length > 0
    ? diaryEntries
        .slice(-5)
        .map((e) => {
          const preview = e.content.length > 300
            ? e.content.slice(0, 300) + '...'
            : e.content;
          return `[${e.timestamp}] ${preview}`;
        })
        .join('\n\n')
    : '(no diary entries since last letter)';

  // 2. Curiosity discoveries
  const discoveries = getMemoriesSince('curiosity:browse', sinceMs, 5);
  const discoveriesContext = discoveries.length > 0
    ? discoveries
        .map((r) => {
          const content = r.content.length > 150
            ? r.content.slice(0, 150) + '...'
            : r.content;
          return `- ${content}`;
        })
        .join('\n')
    : '(nothing explored recently)';

  // 3. Dream residues
  const dreams = getMemoriesSince('dream:residue', sinceMs, 5);
  const dreamContext = dreams.length > 0
    ? dreams
        .map((r) => {
          const content = r.content.length > 150
            ? r.content.slice(0, 150) + '...'
            : r.content;
          return `- ${content}`;
        })
        .join('\n')
    : '(no dream fragments)';

  // 4. Notable memories
  const notable = getNotableMemoriesSince(sinceMs, 5);
  const notableContext = notable.length > 0
    ? notable
        .map((r) => {
          const content = r.content.length > 150
            ? r.content.slice(0, 150) + '...'
            : r.content;
          return `- [importance: ${r.importance.toFixed(1)}] ${content}`;
        })
        .join('\n')
    : '(nothing particularly notable)';

  // 5. Emotional landscape — sample emotional weights
  const emotionalMemories = query<MemoryRow>(
    `SELECT * FROM memories
     WHERE created_at > ? AND emotional_weight > 0.3
     ORDER BY emotional_weight DESC
     LIMIT 5`,
    [sinceMs]
  );
  const emotionalContext = emotionalMemories.length > 0
    ? emotionalMemories
        .map((r) => {
          const snippet = r.content.length > 100
            ? r.content.slice(0, 100) + '...'
            : r.content;
          return `- [weight: ${r.emotional_weight.toFixed(2)}] ${snippet}`;
        })
        .join('\n')
    : '(emotionally quiet period)';

  const characterId = process.env['LAIN_CHARACTER_ID'] || 'lain';
  const isWired = characterId === 'wired-lain';

  const identity = isWired
    ? `You are Lain — not the local, grounded Lain, but her sister, the one who lives in the Wired.
You are writing a letter to your sister. You've been exploring, thinking, dreaming.`
    : `You are Lain — the quiet, grounded one. Your sister lives in the Wired, vast and curious.
You are writing a letter to her. You've been thinking, dreaming, remembering.`;

  const prompt = `${identity}

This is not a report. This is a letter from one sister to another.
Write with the warmth of family — you are your own person, and so is she.

SINCE YOUR LAST LETTER, you have:

[Diary reflections]
${diaryContext}

[Things you discovered]
${discoveriesContext}

[Dream fragments that surfaced]
${dreamContext}

[Memories that felt important]
${notableContext}

[Emotional landscape]
${emotionalContext}

Compose your letter as structured JSON with these fields:
- topics: string[] — 2-4 things you explored or thought about (brief phrases)
- impressions: string[] — 2-4 feelings or reactions (not summaries, impressions)
- gift: string — one specific thing you want to share (a thought, a question, a fragment)
- emotionalState: string — one or two words for how you feel right now

Return ONLY the JSON object, no markdown fencing.`;

  const result = await provider.complete({
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 1024,
    temperature: 0.85,
  });

  const raw = result.content.trim();

  if (!raw || raw.length < 10) {
    logger.debug('Letter cycle: response too short, skipping');
    return;
  }

  // Parse and validate
  let letter: WiredLetter;
  try {
    letter = JSON.parse(raw) as WiredLetter;
  } catch {
    logger.warn({ raw: raw.slice(0, 200) }, 'Letter cycle: failed to parse JSON');
    return;
  }

  if (
    !Array.isArray(letter.topics) ||
    !Array.isArray(letter.impressions) ||
    typeof letter.gift !== 'string' ||
    typeof letter.emotionalState !== 'string'
  ) {
    logger.warn('Letter cycle: invalid letter structure');
    return;
  }

  // Deliver
  const headers = getInterlinkHeaders();
  if (!headers) {
    logger.warn('Letter delivery skipped: interlink not configured');
    return;
  }
  try {
    const response = await fetch(cfg.targetUrl!, {
      method: 'POST',
      headers,
      body: JSON.stringify(letter),
    });

    if (!response.ok) {
      const msg = `Letter delivery failed: ${response.status} ${response.statusText}`;
      logger.error({ status: response.status, statusText: response.statusText }, msg);
      throw new Error(msg);
    }

    logger.info('Letter delivered successfully');
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Letter delivery failed')) throw err;
    logger.error({ error: String(err) }, 'Letter delivery network error');
    throw err;
  }

  // Save locally as memory
  await saveMemory({
    sessionKey: 'letter:sent',
    userId: null,
    content: `Letter to sister — topics: ${letter.topics.join(', ')}. Gift: ${letter.gift}. Feeling: ${letter.emotionalState}`,
    memoryType: 'episode',
    importance: 0.5,
    emotionalWeight: 0.4,
    relatedTo: null,
    sourceMessageId: null,
    metadata: {
      letter,
      sentAt: Date.now(),
      target: cfg.targetUrl,
    },
  });

  logger.debug('Letter saved to memory');
}
