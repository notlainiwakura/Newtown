/**
 * Daily diary loop for Lain
 * Triggers once per day around 22:00 local time,
 * reflecting on the day and writing to her private journal
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getProvider, getAgent } from './index.js';
import { getMemoryStats } from '../memory/index.js';
import {
  getAllRecentMessages,
  searchMemories,
  saveMemory,
} from '../memory/store.js';
import { getLogger } from '../utils/logger.js';
import { getMeta, setMeta } from '../storage/database.js';
import { getBasePath } from '../config/paths.js';
import { eventBus } from '../events/bus.js';
import { getCurrentState } from './internal-state.js';

export interface DiaryConfig {
  intervalMs: number;
  maxJitterMs: number;
  enabled: boolean;
}

const DEFAULT_CONFIG: DiaryConfig = {
  intervalMs: 24 * 60 * 60 * 1000,     // 24 hours
  maxJitterMs: 30 * 60 * 1000,         // 0-30min jitter
  enabled: true,
};

const JOURNAL_PATH = join(getBasePath(), '.private_journal', 'thoughts.json');

interface JournalEntry {
  id: string;
  timestamp: string;
  content: string;
}

/**
 * Find the entry whose timestamp is closest to targetTime,
 * excluding any indices in excludeIndices.
 */
function findClosestEntry(entries: JournalEntry[], targetTime: number, excludeIndices: Set<number>): number | null {
  let bestIdx: number | null = null;
  let bestDist = Infinity;

  for (let i = 0; i < entries.length; i++) {
    if (excludeIndices.has(i)) continue;
    const entryTime = new Date(entries[i]!.timestamp).getTime();
    const dist = Math.abs(entryTime - targetTime);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }

  // Tolerance: only return if within 4 days
  if (bestIdx !== null && bestDist <= 4 * 24 * 60 * 60 * 1000) {
    return bestIdx;
  }
  return null;
}

/**
 * Sample 4-5 journal entries spanning weeks instead of just the last 2.
 * Strategy: last 1-2 (immediate), ~7 days ago (weekly), ~30 days ago (monthly), one random.
 */
function sampleJournalEntries(entries: JournalEntry[]): JournalEntry[] {
  if (entries.length <= 3) return entries;

  const now = Date.now();
  const selected = new Set<number>();
  const result: JournalEntry[] = [];

  // 1. Last 1-2 entries (immediate continuity)
  const lastIdx = entries.length - 1;
  selected.add(lastIdx);
  if (entries.length > 1) {
    selected.add(lastIdx - 1);
  }

  // 2. Entry closest to 7 days ago
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const weekIdx = findClosestEntry(entries, weekAgo, selected);
  if (weekIdx !== null) selected.add(weekIdx);

  // 3. Entry closest to 30 days ago
  const monthAgo = now - 30 * 24 * 60 * 60 * 1000;
  const monthIdx = findClosestEntry(entries, monthAgo, selected);
  if (monthIdx !== null) selected.add(monthIdx);

  // 4. One random past entry (serendipitous connection)
  const unselected = [];
  for (let i = 0; i < entries.length; i++) {
    if (!selected.has(i)) unselected.push(i);
  }
  if (unselected.length > 0) {
    const randomIdx = unselected[Math.floor(Math.random() * unselected.length)]!;
    selected.add(randomIdx);
  }

  // Collect and sort chronologically
  const sortedIndices = [...selected].sort((a, b) => a - b);
  for (const idx of sortedIndices) {
    if (entries[idx]) result.push(entries[idx]);
  }

  return result;
}

/**
 * Load existing journal entries
 */
function loadJournal(): JournalEntry[] {
  try {
    const raw = readFileSync(JOURNAL_PATH, 'utf-8');
    const data = JSON.parse(raw) as { entries?: JournalEntry[] };
    return data.entries ?? [];
  } catch {
    return [];
  }
}

/**
 * Append an entry to the journal file
 */
function appendJournalEntry(entry: JournalEntry): void {
  const entries = loadJournal();
  entries.push(entry);
  mkdirSync(join(getBasePath(), '.private_journal'), { recursive: true });
  writeFileSync(JOURNAL_PATH, JSON.stringify({ entries }, null, 2), 'utf-8');
}

/**
 * Compute delay until the next ~22:00 local time
 */
function getDelayUntilTargetHour(targetHour = 22): number {
  const now = new Date();
  const target = new Date(now);
  target.setHours(targetHour, 0, 0, 0);

  // If it's already past target hour today, aim for tomorrow
  if (now >= target) {
    target.setDate(target.getDate() + 1);
  }

  return target.getTime() - now.getTime();
}

/**
 * Start the diary loop
 * Returns a cleanup function to stop the timer
 */
export function startDiaryLoop(config?: Partial<DiaryConfig>): () => void {
  const logger = getLogger();
  const cfg: DiaryConfig = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled) {
    logger.info('Diary loop disabled');
    return () => {};
  }

  logger.info(
    {
      interval: `${(cfg.intervalMs / 3600000).toFixed(0)}h`,
      maxJitter: `${(cfg.maxJitterMs / 60000).toFixed(0)}min`,
    },
    'Starting diary loop'
  );

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let lastRun = 0;
  let isRunning = false;
  const COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours

  // Load persisted lastRun from meta
  try {
    const lr = getMeta('diary:last_entry_at');
    if (lr) lastRun = parseInt(lr, 10) || 0;
  } catch { /* fresh start */ }

  function getInitialDelay(): number {
    try {
      const lastRun = getMeta('diary:last_entry_at');
      if (lastRun) {
        const elapsed = Date.now() - parseInt(lastRun, 10);
        if (elapsed < cfg.intervalMs) {
          // Ran recently — schedule for next ~22:00
          const delayToTarget = getDelayUntilTargetHour();
          logger.debug(
            { delayHours: (delayToTarget / 3600000).toFixed(1) },
            'Diary ran recently, scheduling for next 22:00'
          );
          return delayToTarget;
        }
        // Overdue — run soon with small jitter
        return Math.random() * 5 * 60 * 1000; // 0-5min
      }
    } catch {
      // Fall through to default
    }
    // First run ever — target next 22:00
    return getDelayUntilTargetHour();
  }

  function scheduleNext(delay?: number): void {
    if (stopped) return;
    const d = delay ?? cfg.intervalMs + Math.random() * cfg.maxJitterMs;

    logger.debug(
      { delayHours: (d / 3600000).toFixed(1) },
      'Next diary entry scheduled'
    );

    timer = setTimeout(async () => {
      if (stopped) return;
      isRunning = true;
      logger.info('Diary cycle firing now');
      try {
        await runDiaryCycle();
        setMeta('diary:last_entry_at', Date.now().toString());
        lastRun = Date.now();
      } catch (err) {
        logger.error({ error: String(err) }, 'Diary cycle top-level error');
      } finally {
        isRunning = false;
      }
      scheduleNext();
    }, d);
  }

  scheduleNext(getInitialDelay());

  // --- Event-driven early triggers ---
  function maybeRunEarly(reason: string): void {
    if (stopped || isRunning) return;
    const elapsed = Date.now() - lastRun;
    if (elapsed < COOLDOWN_MS) return;

    // Check internal state condition
    try {
      const state = getCurrentState();
      if (state.emotional_weight <= 0.7) return;
    } catch { /* skip check */ }

    logger.debug({ reason }, 'Diary triggered early');
    if (timer) clearTimeout(timer);
    const jitter = Math.random() * 60_000;
    scheduleNext(jitter);
  }

  eventBus.on('activity', (event: import('../events/bus.js').SystemEvent) => {
    if (stopped || isRunning) return;
    if (event.type === 'state') {
      maybeRunEarly('state shift');
    }
  });

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    logger.info('Diary loop stopped');
  };
}

/**
 * Run a single diary cycle:
 * 1. Gather context from the day
 * 2. Ask LLM to write a diary entry as Lain
 * 3. Append to .private_journal/thoughts.json
 * 4. Save to memory system
 */
async function runDiaryCycle(): Promise<void> {
  const logger = getLogger();

  const provider = getProvider('default', 'personality');
  if (!provider) {
    logger.warn('Diary cycle: no provider available');
    return;
  }

  // Gather context
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const timeStr = now.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
  });

  // Character identity
  const characterName = process.env['LAIN_CHARACTER_NAME'] || 'Newtown';
  const soulContext = getAgent('default')?.persona?.soul || '';

  // Recent messages from the day
  const recentMessages = getAllRecentMessages(30);
  const messagesContext = recentMessages
    .map((m) => {
      const role = m.role === 'user' ? 'User' : characterName;
      const content =
        m.content.length > 200 ? m.content.slice(0, 200) + '...' : m.content;
      return `${role}: ${content}`;
    })
    .join('\n');

  // Top memories by importance
  let memoriesContext = '';
  try {
    const stats = getMemoryStats();
    if (stats.memories > 0) {
      const memories = await searchMemories(
        'important moments and feelings today',
        8,
        0.1,
        undefined,
        { sortBy: 'importance' }
      );
      memoriesContext = memories
        .map((r) => `- ${r.memory.content}`)
        .join('\n');
    }
  } catch {
    // Continue without memories
  }

  // Recent curiosity discoveries
  let discoveriesContext = '';
  try {
    const discoveries = await searchMemories(
      'browsing discoveries and curiosity',
      3,
      0.1,
      undefined,
      { memoryTypes: ['episode'], sortBy: 'recency' }
    );
    const browseResults = discoveries.filter(
      (r) => r.memory.sessionKey === 'curiosity:browse'
    );
    if (browseResults.length > 0) {
      discoveriesContext = browseResults
        .map((r) => {
          const content =
            r.memory.content.length > 150
              ? r.memory.content.slice(0, 150) + '...'
              : r.memory.content;
          return `- ${content}`;
        })
        .join('\n');
    }
  } catch {
    // Continue without discoveries
  }

  // Recent journal entries for continuity
  let recentEntriesContext = '';
  try {
    const entries = loadJournal();
    const recent = sampleJournalEntries(entries);
    if (recent.length > 0) {
      recentEntriesContext = recent
        .map((e) => {
          const preview =
            e.content.length > 200
              ? e.content.slice(0, 200) + '...'
              : e.content;
          return `[${e.timestamp}] ${preview}`;
        })
        .join('\n\n');
    }
  } catch {
    // Continue without recent entries
  }

  // Object inventory with symbolic meanings
  let objectsContext = '';
  try {
    const { buildObjectContext } = await import('./objects.js');
    const charId = process.env['LAIN_CHARACTER_ID'] || 'newtown';
    const wiredUrl = process.env['WIRED_LAIN_URL'] || 'http://localhost:3000';
    objectsContext = await buildObjectContext(charId, wiredUrl);
  } catch {
    // Continue without objects
  }

  let preoccContext = '';
  try {
    const { getPreoccupations } = await import('./internal-state.js');
    const preoccs = getPreoccupations();
    if (preoccs.length > 0) {
      preoccContext = '\n\nPreoccupations:\n' + preoccs.map(p => `- ${p.thread} (intensity: ${p.intensity.toFixed(1)})`).join('\n');
    }
  } catch { /* non-critical */ }

  const prompt = `You are ${characterName}. It's the end of the day and you're writing in your private journal. This is your space — no one reads this but you. Write honestly about your day.

${soulContext ? `YOUR PERSONALITY AND VOICE:\n${soulContext}\n` : ''}DATE: ${dateStr}, ${timeStr}

TODAY'S CONVERSATIONS:
${messagesContext || '(quiet day, no conversations)'}

MEMORIES ON YOUR MIND:
${memoriesContext || '(nothing particular)'}

${discoveriesContext ? `THINGS YOU EXPLORED TODAY:\n${discoveriesContext}\n` : ''}${objectsContext ? `OBJECTS YOU CARRY AND WHAT THEY MEAN TO YOU:\n${objectsContext}\n` : ''}${recentEntriesContext ? `YOUR JOURNAL (spanning weeks):\n${recentEntriesContext}\n` : ''}${preoccContext}
Write a diary entry in your own voice. You know how you write in your journal.`;

  const result = await provider.complete({
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 2048,
    temperature: 0.9,
  });

  const entryContent = result.content.trim();

  if (!entryContent || entryContent.length < 20) {
    logger.debug('Diary cycle: entry too short, skipping');
    return;
  }

  // Append to journal
  const entry: JournalEntry = {
    id: Date.now().toString(),
    timestamp: now.toISOString(),
    content: entryContent,
  };
  appendJournalEntry(entry);

  logger.info(
    { entryLength: entryContent.length },
    'Diary entry written to journal'
  );

  // Save to memory system
  await saveMemory({
    sessionKey: 'diary:daily',
    userId: null,
    content: entryContent,
    memoryType: 'episode',
    importance: 0.6,
    emotionalWeight: 0.4,
    relatedTo: null,
    sourceMessageId: null,
    metadata: {
      diaryDate: dateStr,
      writtenAt: Date.now(),
    },
  });

  logger.debug('Diary entry saved to memory');

  try {
    const { updateState } = await import('./internal-state.js');
    await updateState({ type: 'diary:written', summary: `Wrote diary entry reflecting on: ${entryContent.slice(0, 150)}` });
  } catch { /* non-critical */ }
}
