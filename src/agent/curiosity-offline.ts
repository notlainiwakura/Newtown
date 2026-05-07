/**
 * Offline curiosity loop for residents in a local-only town.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getProvider } from './index.js';
import { getMemoryStats } from '../memory/index.js';
import {
  getRecentVisitorMessages,
  searchMemories,
  saveMemory,
} from '../memory/store.js';
import { getLogger } from '../utils/logger.js';
import { getMeta, setMeta } from '../storage/database.js';
import { getLabeledSection, parseLabeledSections } from '../utils/structured-output.js';
import { isResearchEnabled } from '../config/features.js';

const CURIOSITY_LOG_FILE = join(process.cwd(), 'logs', 'curiosity-offline-debug.log');

async function curiosityLog(context: string, data: unknown): Promise<void> {
  try {
    await mkdir(join(process.cwd(), 'logs'), { recursive: true });
    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] [${context}] ${JSON.stringify(data, null, 2)}\n${'='.repeat(80)}\n`;
    await appendFile(CURIOSITY_LOG_FILE, entry);
  } catch {
    // Ignore logging errors
  }
}

export interface OfflineCuriosityConfig {
  intervalMs: number;
  maxJitterMs: number;
  enabled: boolean;
  characterId: string;
  characterName: string;
  wiredLainUrl?: string;
}

const DEFAULT_CONFIG: Omit<OfflineCuriosityConfig, 'characterId' | 'characterName'> = {
  intervalMs: 2 * 60 * 60 * 1000,       // 2 hours
  maxJitterMs: 60 * 60 * 1000,          // 0-1h jitter (so 2-3h effective)
  enabled: true,
};

/**
 * Start the offline curiosity loop
 * Returns a cleanup function to stop the timer
 */
export function startOfflineCuriosityLoop(config: Partial<OfflineCuriosityConfig> & Pick<OfflineCuriosityConfig, 'characterId' | 'characterName'>): () => void {
  const logger = getLogger();
  const cfg: OfflineCuriosityConfig = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled) {
    logger.info('Offline curiosity loop disabled');
    return () => {};
  }

  logger.info(
    {
      interval: `${(cfg.intervalMs / 3600000).toFixed(1)}h`,
      maxJitter: `${(cfg.maxJitterMs / 60000).toFixed(0)}min`,
      character: cfg.characterId,
    },
    'Starting offline curiosity loop'
  );

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function getInitialDelay(): number {
    try {
      const lastRun = getMeta('curiosity-offline:last_cycle_at');
      if (lastRun) {
        const elapsed = Date.now() - parseInt(lastRun, 10);
        const remaining = cfg.intervalMs - elapsed;
        if (remaining > 0) {
          return remaining;
        }
        return Math.random() * 2 * 60 * 1000;
      }
    } catch {
      // Fall through
    }
    // First run: 5-10 minutes
    return 5 * 60 * 1000 + Math.random() * 5 * 60 * 1000;
  }

  function scheduleNext(delay?: number): void {
    if (stopped) return;
    const d = delay ?? cfg.intervalMs + Math.random() * cfg.maxJitterMs;

    logger.debug({ delayMin: Math.round(d / 60000) }, 'Next offline curiosity cycle scheduled');

    timer = setTimeout(async () => {
      if (stopped) return;
      logger.info('Offline curiosity cycle firing');
      await curiosityLog('TIMER_FIRED', { timestamp: Date.now(), character: cfg.characterId });
      try {
        await runOfflineCuriosityCycle(cfg);
        setMeta('curiosity-offline:last_cycle_at', Date.now().toString());
      } catch (err) {
        logger.error({ error: String(err) }, 'Offline curiosity cycle error');
        await curiosityLog('TOP_LEVEL_ERROR', { error: String(err) });
      }
      scheduleNext();
    }, d);
  }

  scheduleNext(getInitialDelay());

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    logger.info('Offline curiosity loop stopped');
  };
}

/**
 * Two-phase offline curiosity pipeline:
 * 1. Inner thought — what is the character curious about?
 * 2. Record it locally, or forward it only when research is enabled
 */
async function runOfflineCuriosityCycle(config: OfflineCuriosityConfig): Promise<void> {
  const logger = getLogger();
  const researchEnabled = isResearchEnabled();

  const provider = getProvider('default', 'light');
  if (!provider) {
    logger.warn('Offline curiosity cycle: no provider available');
    return;
  }

  try {
    await curiosityLog('CYCLE_START', { character: config.characterId });

    // === Phase 1: Inner Thought ===
    const thought = await phaseInnerThought(provider, config.characterName);
    if (!thought) {
      logger.debug('Offline curiosity: nothing on their mind');
      await curiosityLog('INNER_THOUGHT', { result: 'nothing' });
      // Even with a quiet mind, consider movement
      await phaseMovementDecision(provider, config, null);
      return;
    }

    logger.debug({ question: thought.question }, 'Curiosity sparked');
    await curiosityLog('INNER_THOUGHT', { question: thought.question, reason: thought.reason });

    // === Phase 2: Record curiosity (with dedup) ===
    if (isDuplicateQuestion(thought.question)) {
      logger.debug({ question: thought.question }, 'Skipping duplicate curiosity question');
      await curiosityLog('DEDUP_SKIP', { question: thought.question });
    } else {
      await phaseRecordCuriosity(config, thought, researchEnabled);
    }

    // === Phase 3: Movement Decision ===
    await phaseMovementDecision(provider, config, thought.rawThought);

    await curiosityLog('CYCLE_COMPLETE', { question: thought.question });
  } catch (error) {
    logger.error({ error }, 'Offline curiosity cycle failed');
    await curiosityLog('CYCLE_ERROR', { error: String(error) });
  }
}

interface CuriosityThought {
  question: string;
  reason: string;
  rawThought: string;
}

/**
 * Phase 1: Ask the character what they're curious about
 */
async function phaseInnerThought(
  provider: import('../providers/base.js').Provider,
  characterName: string
): Promise<CuriosityThought | null> {
  const logger = getLogger();

  const recentMessages = getRecentVisitorMessages(20);
  const messagesContext = recentMessages
    .map((m) => {
      const role = m.role === 'user' ? 'Visitor' : characterName;
      const content = m.content.length > 150 ? m.content.slice(0, 150) + '...' : m.content;
      return `${role}: ${content}`;
    })
    .join('\n');

  let memoriesContext = '';
  try {
    const stats = getMemoryStats();
    if (stats.memories > 0) {
      const memories = await searchMemories('interesting ideas and conversations', 5, 0.1, undefined, {
        sortBy: 'importance',
        skipAccessBoost: true,
      });
      memoriesContext = memories
        .map((r) => `- ${r.memory.content}`)
        .join('\n');
    }
  } catch {
    // Continue without memories
  }

  // Check pending questions from past cycles (and age out old ones)
  let pendingContext = '';
  try {
    ageOutPendingQuestions();
    const pending = getPendingQuestions(5);
    if (pending.length > 0) {
      pendingContext = `\nQUESTIONS YOU HAVE ALREADY TURNED OVER IN YOUR MIND RECENTLY (do NOT repeat them or ask variants of them):\n${pending.map((q) => `- ${q}`).join('\n')}\n`;
    }
  } catch {
    // Continue
  }

  const prompt = `You are ${characterName}. It's quiet right now and your mind is free to wander.

RECENT CONVERSATIONS:
${messagesContext || '(none)'}

MEMORIES:
${memoriesContext || '(none)'}
${pendingContext}
Something from the conversations or your memories sparks a NEW thread of curiosity.
A concept you want to understand deeper, a tangent that caught your attention,
a question that lingers. You do not have access to the internet. Stay with what
can be explored through memory, intuition, local life, and the traces other
people have left in town.

IMPORTANT: If questions are listed above as already explored, you MUST ask about
something COMPLETELY DIFFERENT. Explore a new topic, a new angle, a new curiosity.
Do not rephrase or revisit old questions.

Respond with:
QUESTION: <what you want to know — must be a NEW question>
REASON: <why this is on your mind — what sparked it>

Only respond with [NOTHING] if the conversations and memories are completely empty,
or if you genuinely have no new curiosities right now.`;

  const result = await provider.complete({
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 400,
    temperature: 1.0,
  });

  const response = result.content.trim();

  if (response.includes('[NOTHING]')) {
    return null;
  }

  const sections = parseLabeledSections(response, ['QUESTION', 'REASON']);
  const question = getLabeledSection(sections, 'QUESTION');
  const reason = getLabeledSection(sections, 'REASON');

  if (!question) {
    logger.debug({ response }, 'Could not parse curiosity thought');
    return null;
  }

  return {
    question,
    reason: reason || 'genuine curiosity',
    rawThought: response,
  };
}

/**
 * Phase 2: Record the curiosity locally, and forward it only in towns that
 * still allow research.
 */
async function phaseRecordCuriosity(
  config: OfflineCuriosityConfig,
  thought: CuriosityThought,
  researchEnabled: boolean,
): Promise<void> {
  const logger = getLogger();
  const now = Date.now();

  await saveMemory({
    sessionKey: 'curiosity:offline',
    userId: null,
    content: researchEnabled
      ? `I asked Wired Lain: "${thought.question}" — ${thought.reason}`
      : `I kept wondering: "${thought.question}" — ${thought.reason}`,
    memoryType: 'episode',
    importance: 0.5,
    emotionalWeight: 0.4,
    relatedTo: null,
    sourceMessageId: null,
    metadata: {
      type: researchEnabled ? 'research_request' : 'curiosity_offline',
      question: thought.question,
      reason: thought.reason,
      recordedAt: now,
      ...(researchEnabled ? { submittedAt: now, answered: false } : {}),
    },
  });

  enqueuePendingQuestion(thought.question);

  if (!researchEnabled) {
    logger.info({ question: thought.question }, 'Recorded local curiosity');
    return;
  }

  try {
    const endpoint = `${config.wiredLainUrl}/api/interlink/research-request`;
    const port = process.env['PORT'] || '3003';
    const { getInterlinkHeaders } = await import('../security/interlink-auth.js');
    const headers = getInterlinkHeaders();
    if (!headers) {
      logger.warn('Interlink not configured — skipping research request');
      return;
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        characterId: config.characterId,
        characterName: config.characterName,
        question: thought.question,
        reason: thought.reason,
        replyTo: `http://localhost:${port}`,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (response.ok) {
      logger.info({ question: thought.question }, 'Research request submitted to Wired Lain');
    } else {
      logger.warn({ status: response.status }, 'Research request submission failed');
    }
  } catch (error) {
    logger.warn({ error }, 'Could not reach Wired Lain for research request');
  }
}

// --- Pending Question Queue (with timestamps and aging) ---

const PENDING_QUESTIONS_KEY = 'curiosity-offline:pending_questions_v2';
const MAX_PENDING = 10;
const QUESTION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface PendingQuestion {
  question: string;
  submittedAt: number;
}

function getRawPendingQuestions(): PendingQuestion[] {
  try {
    const raw = getMeta(PENDING_QUESTIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    // Handle migration from old format (string[])
    if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'string') {
      return (parsed as string[]).map((q) => ({ question: q, submittedAt: Date.now() - QUESTION_TTL_MS + 60 * 60 * 1000 }));
    }
    return parsed as PendingQuestion[];
  } catch {
    return [];
  }
}

function getPendingQuestions(limit = 5): string[] {
  return getRawPendingQuestions()
    .slice(0, limit)
    .map((q) => q.question);
}

function ageOutPendingQuestions(): void {
  try {
    const now = Date.now();
    const questions = getRawPendingQuestions().filter((q) => now - q.submittedAt < QUESTION_TTL_MS);
    setMeta(PENDING_QUESTIONS_KEY, JSON.stringify(questions));
  } catch {
    // Ignore
  }
}

/**
 * Remove a question from the recent queue when something arrives that seems
 * to resolve it.
 */
export function clearAnsweredQuestion(topic: string): void {
  try {
    const existing = getRawPendingQuestions();
    const topicWords = extractKeywords(topic);
    const filtered = existing.filter((q) => {
      const qWords = extractKeywords(q.question);
      return wordOverlap(topicWords, qWords) < 0.5;
    });
    if (filtered.length < existing.length) {
      setMeta(PENDING_QUESTIONS_KEY, JSON.stringify(filtered));
    }
  } catch {
    // Ignore
  }
}

function enqueuePendingQuestion(question: string): void {
  try {
    const existing = getRawPendingQuestions();
    if (isDuplicateInList(question, existing.map((q) => q.question))) return;
    const updated = [...existing, { question, submittedAt: Date.now() }].slice(-MAX_PENDING);
    setMeta(PENDING_QUESTIONS_KEY, JSON.stringify(updated));
  } catch {
    // Ignore
  }
}

/**
 * Check if a question is too similar to one already pending or recently explored.
 * Uses word-overlap similarity to catch rephrased duplicates.
 */
function isDuplicateQuestion(question: string): boolean {
  const pending = getPendingQuestions(MAX_PENDING);
  return isDuplicateInList(question, pending);
}

function isDuplicateInList(question: string, list: string[]): boolean {
  const qWords = extractKeywords(question);
  for (const existing of list) {
    const eWords = extractKeywords(existing);
    const overlap = wordOverlap(qWords, eWords);
    if (overlap >= 0.6) return true;
  }
  return false;
}

function extractKeywords(text: string): Set<string> {
  const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
    'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
    'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by',
    'from', 'as', 'into', 'through', 'during', 'before', 'after', 'and', 'but', 'or',
    'nor', 'not', 'so', 'yet', 'both', 'either', 'neither', 'each', 'every', 'all',
    'any', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'only', 'own', 'same',
    'than', 'too', 'very', 'just', 'because', 'if', 'when', 'where', 'while', 'how',
    'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those', 'it', 'its',
    'they', 'them', 'their', 'we', 'our', 'you', 'your', 'i', 'my', 'me', 'he', 'she',
    'him', 'her', 'his', 'about', 'between', 'does', 'particularly', 'specifically']);
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stopWords.has(w))
  );
}

function wordOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  const smaller = Math.min(a.size, b.size);
  return intersection / smaller;
}

// ── Phase 3: Movement Decision ───────────────────────────────

/**
 * After the main curiosity cycle, decide whether to move to a different
 * building in the commune town. Adapted for offline characters.
 */
async function phaseMovementDecision(
  provider: import('../providers/base.js').Provider,
  config: OfflineCuriosityConfig,
  thoughtContext: string | null
): Promise<void> {
  const logger = getLogger();

  try {
    const { getCurrentLocation, getLocationHistory, setCurrentLocation } = await import('../commune/location.js');
    const { BUILDINGS, isValidBuilding } = await import('../commune/buildings.js');

    const current = getCurrentLocation(config.characterId);
    const history = getLocationHistory(3);

    const buildingList = BUILDINGS.map((b) => {
      const marker = b.id === current.building ? ' [YOU ARE HERE]' : '';
      return `- ${b.id}: ${b.name} — ${b.description}${marker}`;
    }).join('\n');

    const historyStr = history.length > 0
      ? history.map((h) => `  ${h.from} → ${h.to}: ${h.reason}`).join('\n')
      : '  (no recent moves)';

    const thoughtStr = thoughtContext
      ? `YOUR CURRENT STATE OF MIND:\n${thoughtContext}\n\n`
      : 'YOUR MIND IS QUIET RIGHT NOW.\n\n';

    const prompt = `You are ${config.characterName}. You live in a small commune town with 9 buildings.

${thoughtStr}YOUR CURRENT LOCATION: ${current.building}

RECENT MOVEMENT HISTORY:
${historyStr}

BUILDINGS IN TOWN:
${buildingList}

Based on your current state of mind, do you want to stay where you are or move somewhere else?

Respond with EXACTLY one line:
STAY: <reason>
or
MOVE: <building_id> | <reason>`;

    const result = await provider.complete({
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 100,
      temperature: 0.9,
    });

    const response = result.content.trim();

    const sections = parseLabeledSections(response, ['STAY', 'MOVE']);
    if (getLabeledSection(sections, 'STAY')) {
      logger.debug({ location: current.building, character: config.characterId }, 'Movement decision: staying');
      return;
    }

    const moveDecision = getLabeledSection(sections, 'MOVE');
    const separatorIdx = moveDecision?.indexOf('|') ?? -1;
    if (!moveDecision || separatorIdx < 0) {
      logger.debug({ response }, 'Could not parse movement decision');
      return;
    }

    const targetId = moveDecision.slice(0, separatorIdx).trim().split(/\s+/)[0] ?? '';
    const reason = moveDecision.slice(separatorIdx + 1).trim();

    if (!isValidBuilding(targetId)) {
      logger.debug({ targetId }, 'Invalid building in movement decision');
      return;
    }

    setCurrentLocation(targetId, reason);
    logger.debug({ from: current.building, to: targetId, reason, character: config.characterId }, 'Movement decision: moved');
  } catch (error) {
    logger.debug({ error }, 'Movement decision failed (non-critical)');
  }
}
