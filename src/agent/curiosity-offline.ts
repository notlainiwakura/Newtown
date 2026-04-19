/**
 * Offline curiosity loop for characters without web access.
 * It can either hand questions off to Wired Lain or keep them local-only.
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
  wiredLainUrl: string;
  interlinkToken: string;
  submitResearchRequests: boolean;
}

const DEFAULT_CONFIG: Omit<OfflineCuriosityConfig, 'characterId' | 'characterName' | 'wiredLainUrl' | 'interlinkToken'> = {
  intervalMs: 2 * 60 * 60 * 1000,
  maxJitterMs: 60 * 60 * 1000,
  enabled: true,
  submitResearchRequests: true,
};

/**
 * Start the offline curiosity loop.
 * Returns a cleanup function to stop the timer.
 */
export function startOfflineCuriosityLoop(
  config: Partial<OfflineCuriosityConfig> & Pick<OfflineCuriosityConfig, 'characterId' | 'characterName' | 'wiredLainUrl' | 'interlinkToken'>
): () => void {
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
      submitResearchRequests: cfg.submitResearchRequests,
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

    if (!cfg.submitResearchRequests) {
      return 20 * 1000 + Math.random() * 20 * 1000;
    }

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
 * 1. Inner thought - what is the character curious about?
 * 2. Record it locally or submit it to Wired Lain.
 */
async function runOfflineCuriosityCycle(config: OfflineCuriosityConfig): Promise<void> {
  const logger = getLogger();

  const provider = getProvider('default', 'light');
  if (!provider) {
    logger.warn('Offline curiosity cycle: no provider available');
    return;
  }

  try {
    await curiosityLog('CYCLE_START', { character: config.characterId });

    const thought = await phaseInnerThought(provider, config.characterName, config.submitResearchRequests);
    if (!thought) {
      logger.debug('Offline curiosity: nothing on their mind');
      await curiosityLog('INNER_THOUGHT', { result: 'nothing' });
      await phaseMovementDecision(provider, config, null);
      return;
    }

    logger.debug({ question: thought.question }, 'Curiosity sparked');
    await curiosityLog('INNER_THOUGHT', { question: thought.question, reason: thought.reason });

    if (isDuplicateQuestion(thought.question)) {
      logger.debug({ question: thought.question }, 'Skipping duplicate curiosity question');
      await curiosityLog('DEDUP_SKIP', { question: thought.question });
    } else {
      await phaseSubmitRequest(config, thought);
    }

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

async function phaseInnerThought(
  provider: import('../providers/base.js').Provider,
  characterName: string,
  submitResearchRequests: boolean
): Promise<CuriosityThought | null> {
  const logger = getLogger();

  const recentMessages = getRecentVisitorMessages(20);
  const messagesContext = recentMessages
    .map((m) => {
      const role = m.role === 'user' ? 'Visitor' : characterName;
      const content = m.content.length > 150 ? `${m.content.slice(0, 150)}...` : m.content;
      return `${role}: ${content}`;
    })
    .join('\n');

  let memoriesContext = '';
  try {
    const stats = getMemoryStats();
    if (stats.memories > 0) {
      const memories = await searchMemories('interesting ideas and conversations', 5, 0.1, undefined, {
        sortBy: 'importance',
      });
      memoriesContext = memories.map((r) => `- ${r.memory.content}`).join('\n');
    }
  } catch {
    // Continue without memories
  }

  let pendingContext = '';
  try {
    ageOutPendingQuestions();
    const pending = getPendingQuestions(5);
    if (pending.length > 0) {
      const heading = submitResearchRequests
        ? 'QUESTIONS ALREADY SUBMITTED TO WIRED LAIN (do NOT repeat them or ask variants of them):'
        : 'QUESTIONS YOU HAVE BEEN TURNING OVER LATELY (do NOT repeat them or ask variants of them):';
      pendingContext = `\n${heading}\n${pending.map((q) => `- ${q}`).join('\n')}\n`;
    }
  } catch {
    // Continue
  }

  const accessLine = submitResearchRequests
    ? 'You do not have access to the internet yourself, but you can ask Wired Lain to research things for you.'
    : 'You do not have access to the internet or outside research tools. Let the question stand on its own and follow what genuinely tugs at your attention.';

  const prompt = `You are ${characterName}. It is quiet right now and your mind is free to wander.

RECENT CONVERSATIONS:
${messagesContext || '(none)'}

MEMORIES:
${memoriesContext || '(none)'}
${pendingContext}
Something from the conversations or your memories sparks a NEW thread of curiosity.
A concept you want to understand more deeply, a tangent that caught your attention,
a question that lingers. ${accessLine}

IMPORTANT: If questions are listed above as already submitted, you MUST ask about
something COMPLETELY DIFFERENT. Explore a new topic, a new angle, a new curiosity.
Do not rephrase or revisit old questions.

Respond with:
QUESTION: <what you want to know - must be a NEW question>
REASON: <why this is on your mind - what sparked it>

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

  const questionMatch = response.match(/QUESTION:\s*(.+)/i);
  const reasonMatch = response.match(/REASON:\s*(.+)/i);

  if (!questionMatch) {
    logger.debug({ response }, 'Could not parse curiosity thought');
    return null;
  }

  return {
    question: questionMatch[1]!.trim(),
    reason: reasonMatch?.[1]?.trim() || 'genuine curiosity',
    rawThought: response,
  };
}

async function phaseSubmitRequest(
  config: OfflineCuriosityConfig,
  thought: CuriosityThought
): Promise<void> {
  const logger = getLogger();

  if (!config.submitResearchRequests) {
    await saveMemory({
      sessionKey: 'curiosity:offline',
      userId: null,
      content: `I keep wondering: "${thought.question}" - ${thought.reason}`,
      memoryType: 'episode',
      importance: 0.5,
      emotionalWeight: 0.35,
      relatedTo: null,
      sourceMessageId: null,
      metadata: {
        type: 'local_curiosity',
        question: thought.question,
        reason: thought.reason,
        submittedAt: Date.now(),
        answered: true,
        localOnly: true,
      },
    });

    enqueuePendingQuestion(thought.question);
    logger.info({ question: thought.question }, 'Local curiosity recorded without research handoff');
    return;
  }

  await saveMemory({
    sessionKey: 'curiosity:offline',
    userId: null,
    content: `I asked Wired Lain: "${thought.question}" - ${thought.reason}`,
    memoryType: 'episode',
    importance: 0.5,
    emotionalWeight: 0.4,
    relatedTo: null,
    sourceMessageId: null,
    metadata: {
      type: 'research_request',
      question: thought.question,
      reason: thought.reason,
      submittedAt: Date.now(),
      answered: false,
    },
  });

  enqueuePendingQuestion(thought.question);

  try {
    const endpoint = `${config.wiredLainUrl}/api/interlink/research-request`;
    const port = process.env['PORT'] || '3003';

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.interlinkToken}`,
      },
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

const PENDING_QUESTIONS_KEY = 'curiosity-offline:pending_questions_v2';
const MAX_PENDING = 10;
const QUESTION_TTL_MS = 24 * 60 * 60 * 1000;

interface PendingQuestion {
  question: string;
  submittedAt: number;
}

function getRawPendingQuestions(): PendingQuestion[] {
  try {
    const raw = getMeta(PENDING_QUESTIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'string') {
      return (parsed as string[]).map((q) => ({
        question: q,
        submittedAt: Date.now() - QUESTION_TTL_MS + 60 * 60 * 1000,
      }));
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
 * Remove a question from the pending queue when it has been answered.
 * Uses keyword overlap to match, since the response topic may not be verbatim.
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
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
    'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
    'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by',
    'from', 'as', 'into', 'through', 'during', 'before', 'after', 'and', 'but', 'or',
    'nor', 'not', 'so', 'yet', 'both', 'either', 'neither', 'each', 'every', 'all',
    'any', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'only', 'own', 'same',
    'than', 'too', 'very', 'just', 'because', 'if', 'when', 'where', 'while', 'how',
    'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those', 'it', 'its',
    'they', 'them', 'their', 'we', 'our', 'you', 'your', 'i', 'my', 'me', 'he', 'she',
    'him', 'her', 'his', 'about', 'between', 'does', 'particularly', 'specifically',
  ]);

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
      return `- ${b.id}: ${b.name} - ${b.description}${marker}`;
    }).join('\n');

    const historyStr = history.length > 0
      ? history.map((h) => `  ${h.from} -> ${h.to}: ${h.reason}`).join('\n')
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

    if (response.startsWith('STAY')) {
      logger.debug({ location: current.building, character: config.characterId }, 'Movement decision: staying');
      return;
    }

    const moveMatch = response.match(/^MOVE:\s*(\S+)\s*\|\s*(.+)/i);
    if (!moveMatch) {
      logger.debug({ response }, 'Could not parse movement decision');
      return;
    }

    const targetId = moveMatch[1]!.trim();
    const reason = moveMatch[2]!.trim();

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
