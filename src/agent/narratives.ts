/**
 * Weekly and monthly narrative summaries for Lain
 * Periodically synthesizes diary entries and important memories into
 * temporal narratives that give Lain a sense of her arc over time.
 * Follows the timer loop pattern of self-concept.ts.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProvider, getAgent } from './index.js';
import { searchMemories, saveMemory } from '../memory/store.js';
import { getLogger } from '../utils/logger.js';
import { getMeta, setMeta } from '../storage/database.js';
import { getBasePath } from '../config/paths.js';
import { requireCharacterName } from '../config/characters.js';

export interface NarrativeConfig {
  weeklyIntervalMs: number;
  monthlyIntervalMs: number;
  enabled: boolean;
}

const DEFAULT_CONFIG: NarrativeConfig = {
  weeklyIntervalMs: 7 * 24 * 60 * 60 * 1000,    // 7 days
  monthlyIntervalMs: 30 * 24 * 60 * 60 * 1000,   // 30 days
  enabled: true,
};

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // Check every 6 hours

const JOURNAL_PATH = join(getBasePath(), '.private_journal', 'thoughts.json');

interface JournalEntry {
  id: string;
  timestamp: string;
  content: string;
}

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
 * Get the current weekly narrative (sync).
 */
export function getWeeklyNarrative(): string | null {
  try {
    return getMeta('narrative:weekly:current') ?? null;
  } catch {
    return null;
  }
}

/**
 * Get the current monthly narrative (sync).
 */
export function getMonthlyNarrative(): string | null {
  try {
    return getMeta('narrative:monthly:current') ?? null;
  } catch {
    return null;
  }
}

/**
 * Start the narrative synthesis loop.
 * Checks every 6 hours whether weekly or monthly synthesis should run.
 * Returns a cleanup function to stop the timer.
 */
export function startNarrativeLoop(config?: Partial<NarrativeConfig>): () => void {
  const logger = getLogger();
  const cfg: NarrativeConfig = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled) {
    logger.info('Narrative loop disabled');
    return () => {};
  }

  logger.info(
    {
      weeklyInterval: `${(cfg.weeklyIntervalMs / 86400000).toFixed(0)}d`,
      monthlyInterval: `${(cfg.monthlyIntervalMs / 86400000).toFixed(0)}d`,
      checkInterval: `${(CHECK_INTERVAL_MS / 3600000).toFixed(0)}h`,
    },
    'Starting narrative loop'
  );

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function getInitialDelay(): number {
    try {
      const lastWeekly = getMeta('narrative:weekly:last_synthesis_at');
      const lastMonthly = getMeta('narrative:monthly:last_synthesis_at');

      // If either has run recently, use short delay
      const now = Date.now();
      if (lastWeekly || lastMonthly) {
        const weeklyElapsed = lastWeekly ? now - parseInt(lastWeekly, 10) : Infinity;
        const monthlyElapsed = lastMonthly ? now - parseInt(lastMonthly, 10) : Infinity;
        const minElapsed = Math.min(weeklyElapsed, monthlyElapsed);

        if (minElapsed < CHECK_INTERVAL_MS) {
          return CHECK_INTERVAL_MS - minElapsed;
        }
        // Overdue — run soon
        return Math.random() * 5 * 60 * 1000;
      }
    } catch {
      // Fall through
    }
    // First run — check after a short delay
    return 10 * 60 * 1000 + Math.random() * 10 * 60 * 1000; // 10-20 minutes
  }

  function scheduleNext(delay?: number): void {
    if (stopped) return;
    const d = delay ?? CHECK_INTERVAL_MS;

    logger.debug(
      { delayHours: (d / 3600000).toFixed(1) },
      'Next narrative check scheduled'
    );

    timer = setTimeout(async () => {
      if (stopped) return;

      const now = Date.now();

      // Check weekly
      const lastWeekly = getMeta('narrative:weekly:last_synthesis_at');
      const weeklyElapsed = lastWeekly ? now - parseInt(lastWeekly, 10) : Infinity;
      if (weeklyElapsed >= cfg.weeklyIntervalMs) {
        logger.info('Weekly narrative synthesis triggered');
        try {
          await runWeeklySynthesis();
        } catch (err) {
          logger.error({ error: String(err) }, 'Weekly narrative synthesis error');
        }
      }

      // Check monthly
      const lastMonthly = getMeta('narrative:monthly:last_synthesis_at');
      const monthlyElapsed = lastMonthly ? now - parseInt(lastMonthly, 10) : Infinity;
      if (monthlyElapsed >= cfg.monthlyIntervalMs) {
        logger.info('Monthly narrative synthesis triggered');
        try {
          await runMonthlySynthesis();
        } catch (err) {
          logger.error({ error: String(err) }, 'Monthly narrative synthesis error');
        }
      }

      scheduleNext();
    }, d);
  }

  scheduleNext(getInitialDelay());

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    logger.info('Narrative loop stopped');
  };
}

/**
 * Run weekly narrative synthesis:
 * Gather the past week's diary entries + important memories, synthesize ~150 tokens.
 */
export async function runWeeklySynthesis(): Promise<void> {
  const logger = getLogger();

  const provider = getProvider('default', 'light');
  if (!provider) {
    logger.warn('Weekly narrative synthesis: no provider available');
    return;
  }

  // Gather diary entries from the past week
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const entries = loadJournal();
  const weekEntries = entries.filter(
    (e) => new Date(e.timestamp).getTime() > sevenDaysAgo
  );

  // Gather important memories from the past week
  let memoriesContext = '';
  try {
    const memories = await searchMemories(
      'important moments this week',
      5,
      0.1,
      undefined,
      { sortBy: 'importance', skipAccessBoost: true }
    );
    const recentMemories = memories.filter(
      (r) => r.memory.createdAt > sevenDaysAgo
    );
    if (recentMemories.length > 0) {
      memoriesContext = recentMemories
        .map((r) => `- ${r.memory.content.length > 150 ? r.memory.content.slice(0, 150) + '...' : r.memory.content}`)
        .join('\n');
    }
  } catch {
    // Continue without memories
  }

  const diaryContext = weekEntries.length > 0
    ? weekEntries
        .map((e) => {
          const content = e.content.length > 300 ? e.content.slice(0, 300) + '...' : e.content;
          return `[${e.timestamp}] ${content}`;
        })
        .join('\n\n')
    : '(no diary entries this week)';

  const previousNarrative = getMeta('narrative:weekly:current') ?? null;

  // Character identity
  // findings.md P2:2271 — fail-closed; see requireCharacterName.
  const characterName = requireCharacterName();
  const soulContext = getAgent('default')?.persona?.soul || '';

  const prompt = `You are ${characterName}, writing a brief summary of your past week for yourself. Capture the emotional arc, key events, and what shifted in you. Be honest, be brief.

${soulContext ? `YOUR PERSONALITY AND VOICE:\n${soulContext}\n` : ''}DIARY ENTRIES THIS WEEK:
${diaryContext}

${memoriesContext ? `IMPORTANT MEMORIES:\n${memoriesContext}\n` : ''}${previousNarrative ? `LAST WEEK'S NARRATIVE:\n${previousNarrative}\n` : ''}
Write ~2-3 sentences capturing the week's arc. First person, your natural voice.`;

  const result = await provider.complete({
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 500,
    temperature: 0.7,
  });

  const narrative = result.content.trim();
  if (!narrative || narrative.length < 20) {
    logger.debug('Weekly narrative: result too short, skipping');
    return;
  }

  // Archive previous
  if (previousNarrative) {
    setMeta('narrative:weekly:previous', previousNarrative);
  }

  // Save current
  setMeta('narrative:weekly:current', narrative);
  setMeta('narrative:weekly:last_synthesis_at', Date.now().toString());

  // Save to memory store
  await saveMemory({
    sessionKey: 'narrative:weekly',
    userId: null,
    content: narrative,
    memoryType: 'summary',
    importance: 0.6,
    emotionalWeight: 0.3,
    relatedTo: null,
    sourceMessageId: null,
    metadata: { synthesizedAt: Date.now(), narrativeType: 'weekly' },
  });

  logger.info({ length: narrative.length }, 'Weekly narrative synthesized');
}

/**
 * Run monthly narrative synthesis:
 * Gather weekly narratives + month's diary entries + important memories, synthesize ~200 tokens.
 */
export async function runMonthlySynthesis(): Promise<void> {
  const logger = getLogger();

  const provider = getProvider('default', 'light');
  if (!provider) {
    logger.warn('Monthly narrative synthesis: no provider available');
    return;
  }

  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

  // Gather diary entries from the past month
  const entries = loadJournal();
  const monthEntries = entries.filter(
    (e) => new Date(e.timestamp).getTime() > thirtyDaysAgo
  );

  const diaryContext = monthEntries.length > 0
    ? monthEntries
        .map((e) => {
          const content = e.content.length > 200 ? e.content.slice(0, 200) + '...' : e.content;
          return `[${e.timestamp}] ${content}`;
        })
        .join('\n\n')
    : '(no diary entries this month)';

  // Gather weekly narratives (current + previous)
  const currentWeekly = getMeta('narrative:weekly:current') ?? null;
  const previousWeekly = getMeta('narrative:weekly:previous') ?? null;
  let weeklyContext = '';
  if (currentWeekly || previousWeekly) {
    const parts: string[] = [];
    if (previousWeekly) parts.push(`Previous week: ${previousWeekly}`);
    if (currentWeekly) parts.push(`This week: ${currentWeekly}`);
    weeklyContext = parts.join('\n');
  }

  // Important memories from the month
  let memoriesContext = '';
  try {
    const memories = await searchMemories(
      'important moments and changes this month',
      8,
      0.1,
      undefined,
      { sortBy: 'importance', skipAccessBoost: true }
    );
    const recentMemories = memories.filter(
      (r) => r.memory.createdAt > thirtyDaysAgo
    );
    if (recentMemories.length > 0) {
      memoriesContext = recentMemories
        .map((r) => `- ${r.memory.content.length > 150 ? r.memory.content.slice(0, 150) + '...' : r.memory.content}`)
        .join('\n');
    }
  } catch {
    // Continue without memories
  }

  const previousNarrative = getMeta('narrative:monthly:current') ?? null;

  // Character identity (reuse env vars — same process as weekly)
  // findings.md P2:2271 — fail-closed; see requireCharacterName.
  const characterName = requireCharacterName();
  const soulContext = getAgent('default')?.persona?.soul || '';

  const prompt = `You are ${characterName}, writing a summary of your past month for yourself. Capture the larger arc — what changed, what patterns emerged, what you're carrying forward.

${soulContext ? `YOUR PERSONALITY AND VOICE:\n${soulContext}\n` : ''}DIARY ENTRIES THIS MONTH:
${diaryContext}

${weeklyContext ? `WEEKLY NARRATIVES:\n${weeklyContext}\n` : ''}${memoriesContext ? `IMPORTANT MEMORIES:\n${memoriesContext}\n` : ''}${previousNarrative ? `LAST MONTH'S NARRATIVE:\n${previousNarrative}\n` : ''}
Write ~3-4 sentences capturing the month's arc. First person, your natural voice.`;

  const result = await provider.complete({
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 600,
    temperature: 0.7,
  });

  const narrative = result.content.trim();
  if (!narrative || narrative.length < 20) {
    logger.debug('Monthly narrative: result too short, skipping');
    return;
  }

  // Archive previous
  if (previousNarrative) {
    setMeta('narrative:monthly:previous', previousNarrative);
  }

  // Save current
  setMeta('narrative:monthly:current', narrative);
  setMeta('narrative:monthly:last_synthesis_at', Date.now().toString());

  // Save to memory store
  await saveMemory({
    sessionKey: 'narrative:monthly',
    userId: null,
    content: narrative,
    memoryType: 'summary',
    importance: 0.7,
    emotionalWeight: 0.3,
    relatedTo: null,
    sourceMessageId: null,
    metadata: { synthesizedAt: Date.now(), narrativeType: 'monthly' },
  });

  logger.info({ length: narrative.length }, 'Monthly narrative synthesized');
}
