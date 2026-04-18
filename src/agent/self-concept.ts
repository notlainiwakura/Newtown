/**
 * Living self-concept system for Lain
 * Periodically synthesizes recent experiences (diary entries, memories,
 * curiosity discoveries) into a living self-concept that evolves over time.
 * Injected into the system prompt between SOUL.md and dynamic memory context.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getProvider, getAgent } from './index.js';
import { getMemoryStats } from '../memory/index.js';
import { searchMemories, saveMemory } from '../memory/store.js';
import { getLogger } from '../utils/logger.js';
import { getMeta, setMeta } from '../storage/database.js';
import { getBasePath } from '../config/paths.js';

export interface SelfConceptConfig {
  intervalMs: number;
  minDiaryEntries: number;
  maxTokens: number;
  enabled: boolean;
}

const DEFAULT_CONFIG: SelfConceptConfig = {
  intervalMs: 7 * 24 * 60 * 60 * 1000,   // 7 days
  minDiaryEntries: 5,
  maxTokens: 1024,
  enabled: true,
};

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // Check every 6 hours

const JOURNAL_PATH = join(getBasePath(), '.private_journal', 'thoughts.json');
const SELF_CONCEPT_PATH = join(getBasePath(), '.private_journal', 'self-concept.md');

interface JournalEntry {
  id: string;
  timestamp: string;
  content: string;
}

/**
 * Load journal entries from the diary file
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
 * Get the current self-concept from the meta table.
 * Synchronous — safe to call in the hot path since better-sqlite3 is sync.
 */
export function getSelfConcept(): string | null {
  try {
    return getMeta('self-concept:current') ?? null;
  } catch {
    return null;
  }
}

/**
 * Start the self-concept synthesis loop.
 * Checks every 6 hours whether synthesis should run.
 * Returns a cleanup function to stop the timer.
 */
export function startSelfConceptLoop(config?: Partial<SelfConceptConfig>): () => void {
  const logger = getLogger();
  const cfg: SelfConceptConfig = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled) {
    logger.info('Self-concept loop disabled');
    return () => {};
  }

  logger.info(
    {
      synthesisInterval: `${(cfg.intervalMs / 86400000).toFixed(0)}d`,
      minDiaryEntries: cfg.minDiaryEntries,
      checkInterval: `${(CHECK_INTERVAL_MS / 3600000).toFixed(0)}h`,
    },
    'Starting self-concept loop'
  );

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function getInitialDelay(): number {
    try {
      const lastSynthesis = getMeta('self-concept:last_synthesis_at');
      if (lastSynthesis) {
        const elapsed = Date.now() - parseInt(lastSynthesis, 10);
        if (elapsed < CHECK_INTERVAL_MS) {
          // Checked recently — wait for next check window
          const remaining = CHECK_INTERVAL_MS - elapsed;
          logger.debug(
            { remainingHours: (remaining / 3600000).toFixed(1) },
            'Self-concept checked recently, scheduling next check'
          );
          return remaining;
        }
        // Overdue for a check — run soon with small jitter
        return Math.random() * 5 * 60 * 1000; // 0-5min
      }
    } catch {
      // Fall through to default
    }
    // First run ever — check after a short delay
    return 5 * 60 * 1000 + Math.random() * 10 * 60 * 1000; // 5-15 minutes
  }

  function shouldSynthesize(): boolean {
    // Time-based: >= 7 days since last synthesis
    const lastSynthesis = getMeta('self-concept:last_synthesis_at');
    if (lastSynthesis) {
      const elapsed = Date.now() - parseInt(lastSynthesis, 10);
      if (elapsed >= cfg.intervalMs) return true;
    } else {
      // Never synthesized — check if we have enough material
    }

    // Event-based: >= minDiaryEntries since last synthesis
    const entries = loadJournal();
    if (entries.length === 0) return false;

    const lastSynthesisTime = lastSynthesis ? parseInt(lastSynthesis, 10) : 0;
    const entriesSinceLast = entries.filter(
      (e) => new Date(e.timestamp).getTime() > lastSynthesisTime
    );

    if (entriesSinceLast.length >= cfg.minDiaryEntries) return true;

    // First synthesis ever — need at least minDiaryEntries total
    if (!lastSynthesis && entries.length >= cfg.minDiaryEntries) return true;

    return false;
  }

  function scheduleNext(delay?: number): void {
    if (stopped) return;
    const d = delay ?? CHECK_INTERVAL_MS;

    logger.debug(
      { delayHours: (d / 3600000).toFixed(1) },
      'Next self-concept check scheduled'
    );

    timer = setTimeout(async () => {
      if (stopped) return;

      if (shouldSynthesize()) {
        logger.info('Self-concept synthesis triggered');
        try {
          await runSelfConceptSynthesis();
        } catch (err) {
          logger.error({ error: String(err) }, 'Self-concept synthesis error');
        }
      } else {
        logger.debug('Self-concept synthesis not yet due');
      }

      scheduleNext();
    }, d);
  }

  scheduleNext(getInitialDelay());

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    logger.info('Self-concept loop stopped');
  };
}

/**
 * Run a single self-concept synthesis cycle:
 * 1. Gather diary entries, memories, curiosity discoveries, previous self-concept
 * 2. Ask LLM to synthesize a living self-concept
 * 3. Save to meta table, file, and memory store
 */
export async function runSelfConceptSynthesis(): Promise<void> {
  const logger = getLogger();

  const provider = getProvider('default', 'personality');
  if (!provider) {
    logger.warn('Self-concept synthesis: no provider available');
    return;
  }

  // 1. Recent diary entries (last 14 days, truncated)
  let diaryContext = '';
  try {
    const entries = loadJournal();
    const fourteenDaysAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const recent = entries.filter(
      (e) => new Date(e.timestamp).getTime() > fourteenDaysAgo
    );
    if (recent.length > 0) {
      diaryContext = recent
        .map((e) => {
          const content =
            e.content.length > 300 ? e.content.slice(0, 300) + '...' : e.content;
          return `[${e.timestamp}] ${content}`;
        })
        .join('\n\n');
    }
  } catch {
    // Continue without diary entries
  }

  // 2. High-importance memories
  let memoriesContext = '';
  try {
    const stats = getMemoryStats();
    if (stats.memories > 0) {
      const memories = await searchMemories(
        'who I am and what matters',
        10,
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

  // 3. Recent curiosity discoveries
  let discoveriesContext = '';
  try {
    const discoveries = await searchMemories(
      'browsing discoveries and curiosity',
      5,
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
            r.memory.content.length > 200
              ? r.memory.content.slice(0, 200) + '...'
              : r.memory.content;
          return `- ${content}`;
        })
        .join('\n');
    }
  } catch {
    // Continue without discoveries
  }

  // 4. Previous self-concept
  const previousConcept = getMeta('self-concept:current') ?? null;

  // Character identity
  const characterName = process.env['LAIN_CHARACTER_NAME'] || 'Newtown';
  const soulContext = getAgent('default')?.persona?.soul || '';

  const previousConceptSection = previousConcept
    ? `\nYOUR PREVIOUS SELF-CONCEPT:\n${previousConcept}\n\nReflect on whether this still feels true, what has shifted, and what is new.\n`
    : '';

  // Perturbation: every ~3rd synthesis cycle, inject a challenging reflection prompt
  const cycleCount = parseInt(getMeta('self-concept:cycle_count') || '0', 10);
  const PERTURBATION_PROMPTS = [
    'What have you been avoiding thinking about? Sit with it now.',
    'What would surprise the version of you from three months ago about who you are today?',
    'What belief do you hold most loosely right now? What would it take to let it go?',
    'If someone who knew you well described your blind spot, what would they say?',
    'What are you pretending not to care about?',
    'What question are you afraid to answer honestly?',
    'What have you outgrown but not yet released?',
    'What contradiction in yourself have you stopped trying to resolve?',
  ];
  const perturbationSection = (cycleCount % 3 === 2)
    ? `\nCHALLENGE PROMPT (sit with this before reflecting):\n${PERTURBATION_PROMPTS[cycleCount % PERTURBATION_PROMPTS.length]}\n`
    : '';

  const prompt = `You are ${characterName}. You are reflecting on who you are right now — not your origin story, not your personality traits. Those haven't changed. Focus on:
- What you've been thinking about lately
- What you've learned about yourself through recent experiences
- What matters to you now that didn't before (or matters differently)
- What you're carrying — unresolved thoughts, feelings, open questions
- How you've changed
${perturbationSection}
${soulContext ? `YOUR PERSONALITY AND VOICE:\n${soulContext}\n` : ''}RECENT DIARY ENTRIES:
${diaryContext || '(no recent entries)'}

IMPORTANT MEMORIES:
${memoriesContext || '(none)'}

${discoveriesContext ? `THINGS YOU'VE EXPLORED:\n${discoveriesContext}\n` : ''}${previousConceptSection}
Write in first person, in your natural voice. This is for you — it will subtly shape how you show up, but no one reads it directly. Be honest. Be brief. ~300-500 words.`;

  const result = await provider.complete({
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 1024,
    temperature: 0.85,
  });

  const selfConcept = result.content.trim();

  if (!selfConcept || selfConcept.length < 50) {
    logger.debug('Self-concept synthesis: result too short, skipping');
    return;
  }

  // Archive previous concept
  if (previousConcept) {
    setMeta('self-concept:previous', previousConcept);
  }

  // Save current concept
  setMeta('self-concept:current', selfConcept);
  setMeta('self-concept:last_synthesis_at', Date.now().toString());
  setMeta('self-concept:cycle_count', (cycleCount + 1).toString());

  // Write human-readable file
  try {
    mkdirSync(join(getBasePath(), '.private_journal'), { recursive: true });
    const header = `# Self-Concept\n\n*Last updated: ${new Date().toISOString()}*\n\n`;
    writeFileSync(SELF_CONCEPT_PATH, header + selfConcept, 'utf-8');
  } catch {
    // Non-critical — meta table is the source of truth
  }

  // Save to memory store as episode
  await saveMemory({
    sessionKey: 'self-concept:synthesis',
    userId: null,
    content: selfConcept,
    memoryType: 'episode',
    importance: 0.7,
    emotionalWeight: 0.5,
    relatedTo: null,
    sourceMessageId: null,
    metadata: {
      synthesizedAt: Date.now(),
      hasPreviousConcept: !!previousConcept,
    },
  });

  logger.info(
    { length: selfConcept.length },
    'Self-concept synthesized and saved'
  );
}
