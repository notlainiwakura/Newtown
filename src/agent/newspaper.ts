/**
 * Newspaper reading loop for commune characters
 * Each character periodically checks for a new daily newspaper,
 * reads it, and saves a brief personal reaction to memory.
 */

import { getProvider } from './index.js';
import { saveMemory } from '../memory/store.js';
import { getLogger } from '../utils/logger.js';
import { getMeta, setMeta } from '../storage/database.js';

export interface NewspaperConfig {
  characterId: string;
  characterName: string;
  newspaperBaseUrl: string;   // e.g. 'http://localhost:3000'
  paperName?: string;
  townName?: string;
  intervalMs?: number;
  enabled?: boolean;
}

interface NewspaperIndex {
  date: string;
  editor_id: string;
  editor_name: string;
  activity_count: number;
}

interface Newspaper {
  date: string;
  editor_id: string;
  editor_name: string;
  content: string;
  generated_at: string;
  activity_count: number;
}

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Start the newspaper reading loop.
 * Returns a cleanup function to stop the timer.
 */
export function startNewspaperLoop(config: NewspaperConfig): () => void {
  const logger = getLogger();
  const intervalMs = config.intervalMs ?? DEFAULT_INTERVAL_MS;
  const enabled = config.enabled ?? true;

  if (!enabled) {
    logger.info('Newspaper loop disabled');
    return () => {};
  }

  logger.info(
    { characterId: config.characterId, interval: `${(intervalMs / 3600000).toFixed(0)}h` },
    'Starting newspaper reading loop'
  );

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function getInitialDelay(): number {
    try {
      const lastRead = getMeta('newspaper:last_read_date');
      const today = new Date().toISOString().slice(0, 10);
      if (lastRead === today) {
        // Already read today's paper — wait for next cycle
        return intervalMs + Math.random() * 5 * 60 * 1000;
      }
    } catch {
      // Fall through
    }
    // Haven't read today — start with small jitter (0-5 min)
    return Math.random() * 5 * 60 * 1000;
  }

  function scheduleNext(delay?: number): void {
    if (stopped) return;
    const d = delay ?? intervalMs;

    logger.debug(
      { delayHours: (d / 3600000).toFixed(1) },
      'Next newspaper check scheduled'
    );

    timer = setTimeout(async () => {
      if (stopped) return;
      try {
        await checkAndReadNewspaper(config);
      } catch (err) {
        logger.error({ error: String(err) }, 'Newspaper check error');
      }
      scheduleNext();
    }, d);
  }

  scheduleNext(getInitialDelay());

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    logger.info('Newspaper loop stopped');
  };
}

async function checkAndReadNewspaper(config: NewspaperConfig): Promise<void> {
  const logger = getLogger();
  const lastReadDate = getMeta('newspaper:last_read_date') ?? '';

  // Fetch newspaper index
  let index: NewspaperIndex[];
  try {
    const resp = await fetch(`${config.newspaperBaseUrl}/newspapers/index.json`);
    if (!resp.ok) {
      logger.debug({ status: resp.status }, 'Failed to fetch newspaper index');
      return;
    }
    index = await resp.json() as NewspaperIndex[];
  } catch (err) {
    logger.debug({ error: String(err) }, 'Could not reach newspaper index');
    return;
  }

  if (!Array.isArray(index) || index.length === 0) {
    logger.debug('Newspaper index empty');
    return;
  }

  // Latest edition is first in the array
  const latest = index[0]!;

  if (latest.date <= lastReadDate) {
    logger.debug({ lastRead: lastReadDate, latest: latest.date }, 'No new newspaper');
    return;
  }

  // Editor skips self — they already know the content
  if (latest.editor_id === config.characterId) {
    logger.info(
      { date: latest.date },
      'Skipping newspaper — this character was the editor'
    );
    setMeta('newspaper:last_read_date', latest.date);
    return;
  }

  // Fetch the full newspaper
  let newspaper: Newspaper;
  try {
    const resp = await fetch(`${config.newspaperBaseUrl}/newspapers/${latest.date}.json`);
    if (!resp.ok) {
      logger.warn({ status: resp.status, date: latest.date }, 'Failed to fetch newspaper');
      return;
    }
    newspaper = await resp.json() as Newspaper;
  } catch (err) {
    logger.warn({ error: String(err) }, 'Could not fetch newspaper content');
    return;
  }

  await readNewspaper(newspaper, config);
}

async function readNewspaper(newspaper: Newspaper, config: NewspaperConfig): Promise<void> {
  const logger = getLogger();

  const provider = getProvider('default', 'personality');
  if (!provider) {
    logger.warn('Newspaper reading: no provider available');
    return;
  }

  // Truncate very long newspapers
  let content = newspaper.content;
  if (content.length > 2000) {
    content = content.slice(0, 2000) + '\n\n[...truncated]';
  }

  const paperName = config.paperName ?? 'The Laintown Chronicle';
  const townName = config.townName ?? 'Laintown';

  const prompt = `You just read today's edition of ${paperName}, edited by ${newspaper.editor_name}.

Here's the newspaper:
---
${content}
---

Write a brief, natural reaction to what you read. What caught your attention? What do you think about the events described in ${townName}? Did anything surprise you or remind you of something? Keep it to 2-3 sentences — this is your internal thought after reading, not a published response.`;

  const result = await provider.complete({
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 512,
    temperature: 0.8,
  });

  const reaction = result.content.trim();
  if (!reaction || reaction.length < 10) {
    logger.debug('Newspaper reading: reaction too short, skipping');
    setMeta('newspaper:last_read_date', newspaper.date);
    return;
  }

  // Save reaction to memory
  await saveMemory({
    sessionKey: 'newspaper:reading',
    userId: null,
    content: `Read today's newspaper (edited by ${newspaper.editor_name}): ${reaction}`,
    memoryType: 'episode',
    importance: 0.4,
    emotionalWeight: 0.3,
    relatedTo: null,
    sourceMessageId: null,
    metadata: {
      newspaperDate: newspaper.date,
      editorId: newspaper.editor_id,
      readAt: Date.now(),
    },
  });

  setMeta('newspaper:last_read_date', newspaper.date);

  logger.info(
    { date: newspaper.date, editor: newspaper.editor_name, reactionLength: reaction.length },
    `${config.characterName} read today's newspaper`
  );
}
