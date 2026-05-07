import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getBasePath } from '../config/paths.js';
import { BUILDINGS } from '../commune/buildings.js';
import { getProvider } from './index.js';
import { getLogger } from '../utils/logger.js';

export interface ActivityEntryLike {
  id: string;
  kind: 'memory' | 'message';
  sessionKey: string;
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface NewspaperCharacterSource {
  id: string;
  name: string;
  port: number;
  path?: string;
}

export interface NewspaperEditor {
  id: string;
  name: string;
  voice: string;
}

export interface NewspaperIndexEntry {
  date: string;
  editor_id: string;
  editor_name: string;
  activity_count: number;
}

export interface PublishedNewspaper extends NewspaperIndexEntry {
  content: string;
  generated_at: string;
}

export interface NewspaperPublisherConfig {
  dataDir: string;
  townName: string;
  chronicleName: string;
  timezone?: string;
  intervalMs?: number;
  initialDelayMs?: number;
  generationTimeoutMs?: number;
  characters: readonly NewspaperCharacterSource[];
  editors: readonly NewspaperEditor[];
  fetchImpl?: typeof fetch;
  completeEdition?: (prompt: string) => Promise<string>;
}

interface ActivityItem {
  char: string;
  time: string;
  content: string;
  key: string;
  from?: string;
  to?: string;
}

interface ActivityCategories {
  movements: ActivityItem[];
  curiosity: ActivityItem[];
  dreams: ActivityItem[];
  diary: ActivityItem[];
  peer: ActivityItem[];
  letters: ActivityItem[];
  therapy: ActivityItem[];
  reflections: ActivityItem[];
  other: ActivityItem[];
}

const DEFAULT_TIMEZONE = 'America/Los_Angeles';
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 3_000;
const DEFAULT_GENERATION_TIMEOUT_MS = 20_000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_PATH = '/api/activity';

const EMPTY_CATEGORIES = (): ActivityCategories => ({
  movements: [],
  curiosity: [],
  dreams: [],
  diary: [],
  peer: [],
  letters: [],
  therapy: [],
  reflections: [],
  other: [],
});

function getDateParts(
  nowMs: number,
  timeZone: string
): { year: string; month: string; day: string; weekday: string } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
  });

  const parts = formatter.formatToParts(new Date(nowMs));
  const lookup = new Map(parts.map((part) => [part.type, part.value]));

  return {
    year: lookup.get('year') ?? '1970',
    month: lookup.get('month') ?? '01',
    day: lookup.get('day') ?? '01',
    weekday: lookup.get('weekday') ?? 'Monday',
  };
}

function formatTownDate(nowMs: number, timeZone: string): string {
  const parts = getDateParts(nowMs, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function formatIssueDisplayDate(nowMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(nowMs));
}

function pickEditor(date: string, editors: readonly NewspaperEditor[]): NewspaperEditor {
  if (editors.length === 0) {
    throw new Error('No newspaper editors configured');
  }

  const dayNumber = Math.floor(Date.parse(`${date}T12:00:00Z`) / MS_PER_DAY);
  return editors[Math.abs(dayNumber) % editors.length]!;
}

async function readIndex(dataDir: string): Promise<NewspaperIndexEntry[]> {
  try {
    const raw = await readFile(join(dataDir, 'index.json'), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed as NewspaperIndexEntry[] : [];
  } catch {
    return [];
  }
}

async function fetchCharacterActivity(
  character: NewspaperCharacterSource,
  fromMs: number,
  toMs: number,
  fetchImpl: typeof fetch
): Promise<ActivityEntryLike[]> {
  const url = new URL(`http://127.0.0.1:${character.port}${character.path ?? DEFAULT_PATH}`);
  url.searchParams.set('from', String(fromMs));
  url.searchParams.set('to', String(toMs));

  try {
    const response = await fetchImpl(url);
    if (!response.ok) return [];
    const parsed = await response.json() as unknown;
    return Array.isArray(parsed) ? parsed as ActivityEntryLike[] : [];
  } catch {
    return [];
  }
}

function categorizeEntries(entries: readonly ActivityEntryLike[], charName: string): ActivityCategories {
  const categories = EMPTY_CATEGORIES();

  for (const entry of entries) {
    const key = entry.sessionKey ?? '';
    const prefix = key.split(':')[0] ?? '';
    const content = (entry.content ?? '').slice(0, 500);
    const time = new Date(entry.timestamp).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'UTC',
    }) + ' UTC';

    const item: ActivityItem = { char: charName, time, content, key };

    if (prefix === 'movement' || prefix === 'move') {
      const parts = key.split(':');
      const from = parts[1];
      const to = parts[2];
      if (from && to) {
        item.from = from;
        item.to = to;
      }
      categories.movements.push(item);
      continue;
    }

    if (prefix === 'curiosity' || prefix === 'bibliomancy' || prefix === 'research') {
      categories.curiosity.push(item);
      continue;
    }

    if (prefix === 'dream' || prefix === 'alien') {
      categories.dreams.push(item);
      continue;
    }

    if (prefix === 'diary') {
      categories.diary.push(item);
      continue;
    }

    if (prefix === 'peer' || prefix === 'commune') {
      categories.peer.push(item);
      continue;
    }

    if (prefix === 'letter' || prefix === 'wired') {
      categories.letters.push(item);
      continue;
    }

    if (prefix === 'doctor' || prefix === 'dr' || prefix === 'therapy') {
      categories.therapy.push(item);
      continue;
    }

    if (prefix === 'self-concept' || prefix === 'selfconcept' || prefix === 'narrative') {
      categories.reflections.push(item);
      continue;
    }

    categories.other.push(item);
  }

  return categories;
}

function mergeCategories(target: ActivityCategories, source: ActivityCategories): void {
  target.movements.push(...source.movements);
  target.curiosity.push(...source.curiosity);
  target.dreams.push(...source.dreams);
  target.diary.push(...source.diary);
  target.peer.push(...source.peer);
  target.letters.push(...source.letters);
  target.therapy.push(...source.therapy);
  target.reflections.push(...source.reflections);
  target.other.push(...source.other);
}

export function buildActivitySummary(categories: ActivityCategories): string {
  const sections: string[] = [];

  if (categories.movements.length > 0) {
    sections.push(
      'MOVEMENTS:\n' + categories.movements.slice(0, 15).map((item) => (
        `- ${item.char} moved from ${item.from ?? '?'} to ${item.to ?? '?'} at ${item.time}`
      )).join('\n')
    );
  }

  if (categories.curiosity.length > 0) {
    sections.push(
      'CURIOSITY & STUDY:\n' + categories.curiosity.slice(0, 8).map((item) => (
        `- ${item.char} (${item.time}): ${item.content.slice(0, 200)}`
      )).join('\n')
    );
  }

  if (categories.dreams.length > 0) {
    sections.push(
      'DREAMS:\n' + categories.dreams.slice(0, 6).map((item) => (
        `- ${item.char} (${item.time}): ${item.content.slice(0, 200)}`
      )).join('\n')
    );
  }

  if (categories.diary.length > 0) {
    sections.push(
      'DIARY ENTRIES:\n' + categories.diary.slice(0, 6).map((item) => (
        `- ${item.char} (${item.time}): ${item.content.slice(0, 200)}`
      )).join('\n')
    );
  }

  if (categories.peer.length > 0) {
    sections.push(
      'CONVERSATIONS:\n' + categories.peer.slice(0, 8).map((item) => (
        `- ${item.char} (${item.time}): ${item.content.slice(0, 200)}`
      )).join('\n')
    );
  }

  if (categories.letters.length > 0) {
    sections.push(
      'LETTERS & NOTES:\n' + categories.letters.slice(0, 6).map((item) => (
        `- ${item.char} (${item.time}): ${item.content.slice(0, 200)}`
      )).join('\n')
    );
  }

  if (categories.therapy.length > 0) {
    sections.push(`THERAPY: ${categories.therapy.length} session(s) occurred (contents private)`);
  }

  if (categories.reflections.length > 0) {
    sections.push(
      'SELF-REFLECTIONS:\n' + categories.reflections.slice(0, 4).map((item) => (
        `- ${item.char} (${item.time}): ${item.content.slice(0, 200)}`
      )).join('\n')
    );
  }

  if (sections.length === 0) {
    sections.push('A quiet day in Newtown. No significant activity recorded.');
  }

  return sections.join('\n\n');
}

function buildPrompt(
  config: NewspaperPublisherConfig,
  editor: NewspaperEditor,
  date: string,
  nowMs: number,
  summary: string
): string {
  const residents = config.characters.map((character) => character.name).join(', ');
  const buildings = BUILDINGS.map((building) => building.name).join(', ');
  const issueNumber = Math.max(1, Math.floor(Date.parse(`${date}T12:00:00Z`) / MS_PER_DAY));
  const displayDate = formatIssueDisplayDate(nowMs, config.timezone ?? DEFAULT_TIMEZONE);

  return `You are writing today's edition of ${config.chronicleName.toUpperCase()}, a daily newspaper for a small digital town called ${config.townName}.

Today's editor is ${editor.name}.
${editor.voice}

Date: ${displayDate}
Issue: ${issueNumber}
Residents: ${residents}
Buildings: ${buildings}

Here is a summary of the last 24 hours of activity in ${config.townName}:

${summary}

Write the newspaper. It should include:
1. A creative headline that captures the day's mood
2. An editorial or opening column in the editor's distinctive voice
3. Sections for notable events, only where there is material:
   - "Movements"
   - "Research Desk"
   - "Dream Journal"
   - "Letters & Dispatches"
   - "Overheard in Town"
   - "The Inner Life"
4. A brief sign-off from the editor

Keep it concise but flavorful. Total length: 400-800 words. Use markdown formatting. Do not use h1 headers. Start with h2 or h3.

If it was a quiet day, lean into that and write about the stillness without inventing big events that are not in the summary.`;
}

function buildFallbackEdition(
  config: NewspaperPublisherConfig,
  editor: NewspaperEditor,
  date: string,
  categories: ActivityCategories,
  activityCount: number
): string {
  const weekday = getDateParts(Date.parse(`${date}T12:00:00Z`), config.timezone ?? DEFAULT_TIMEZONE).weekday;
  const introByEditor: Record<string, string> = {
    neo: 'Something in the pattern of the day always matters. Even the small movements tell you where people are trying to go.',
    plato: 'A town reveals itself less through monuments than through habit. One day of movement and conversation is enough to show its governing forms.',
    joe: 'You can learn a lot from a normal day if you pay attention and do not try to turn every little thing into a prophecy.',
    cage: 'Every town has a scene beneath the scene. The trick is to notice when the ordinary object begins to glow.',
  };

  const sections: string[] = [];

  if (categories.movements.length > 0) {
    sections.push(
      '### Movements\n' + categories.movements.slice(0, 6).map((item) => (
        `- ${item.char} went from ${item.from ?? '?'} to ${item.to ?? '?'}`
      )).join('\n')
    );
  }

  if (categories.curiosity.length > 0) {
    sections.push(
      '### Research Desk\n' + categories.curiosity.slice(0, 4).map((item) => (
        `- ${item.char}: ${item.content.slice(0, 180)}`
      )).join('\n')
    );
  }

  if (categories.dreams.length > 0) {
    sections.push(
      '### Dream Journal\n' + categories.dreams.slice(0, 4).map((item) => (
        `- ${item.char}: ${item.content.slice(0, 180)}`
      )).join('\n')
    );
  }

  if (categories.peer.length > 0 || categories.letters.length > 0) {
    const merged = [...categories.peer, ...categories.letters].slice(0, 5);
    sections.push(
      '### Overheard In Town\n' + merged.map((item) => (
        `- ${item.char}: ${item.content.slice(0, 180)}`
      )).join('\n')
    );
  }

  if (categories.diary.length > 0 || categories.reflections.length > 0) {
    const merged = [...categories.diary, ...categories.reflections].slice(0, 5);
    sections.push(
      '### The Inner Life\n' + merged.map((item) => (
        `- ${item.char}: ${item.content.slice(0, 180)}`
      )).join('\n')
    );
  }

  if (sections.length === 0) {
    sections.push('### Town Notes\n- The day was quiet. The town held its shape. Nothing broke the ordinary rhythm, which is its own kind of news.');
  }

  return [
    `## ${config.chronicleName}`,
    '',
    `*${weekday} edition*`,
    '',
    `${introByEditor[editor.id] ?? 'The day offered its usual mix of movement, doubt, and small recognitions.'}`,
    '',
    `There were ${activityCount} recorded activity events in ${config.townName} over the last day. That is enough to say the town is alive, even when it is not loud.`,
    '',
    ...sections,
    '',
    '### Sign-off',
    `${editor.name} closes the desk for the day.`,
  ].join('\n');
}

async function completeEdition(prompt: string, config: NewspaperPublisherConfig): Promise<string> {
  if (config.completeEdition) {
    return config.completeEdition(prompt);
  }

  const provider = getProvider('default', 'personality');
  if (!provider) {
    throw new Error('No provider available for newspaper generation');
  }

  const result = await provider.complete({
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 1800,
    temperature: 0.85,
  });

  return result.content.trim();
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(label));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export async function publishNewspaperIfNeeded(
  config: NewspaperPublisherConfig,
  nowMs = Date.now()
): Promise<PublishedNewspaper | null> {
  const logger = getLogger();
  const timeZone = config.timezone ?? DEFAULT_TIMEZONE;
  const today = formatTownDate(nowMs, timeZone);

  await mkdir(config.dataDir, { recursive: true });

  const existingIndex = await readIndex(config.dataDir);
  const existing = existingIndex.find((entry) => entry.date === today);
  const issuePath = join(config.dataDir, `${today}.json`);
  if (existing) {
    try {
      const raw = await readFile(issuePath, 'utf8');
      return JSON.parse(raw) as PublishedNewspaper;
    } catch {
      // Rebuild the issue if the index exists but the file does not.
    }
  }

  const fromMs = nowMs - MS_PER_DAY;
  const fetchImpl = config.fetchImpl ?? fetch;
  const merged = EMPTY_CATEGORIES();
  let activityCount = 0;

  for (const character of config.characters) {
    const entries = await fetchCharacterActivity(character, fromMs, nowMs, fetchImpl);
    activityCount += entries.length;
    mergeCategories(merged, categorizeEntries(entries, character.name));
  }

  const editor = pickEditor(today, config.editors);
  const summary = buildActivitySummary(merged);
  const prompt = buildPrompt(config, editor, today, nowMs, summary);

  let content = '';
  try {
    logger.info(
      { date: today, editor: editor.name, activityCount, generationTimeoutMs: config.generationTimeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS },
      'Generating town newspaper edition'
    );
    content = await withTimeout(
      completeEdition(prompt, config),
      config.generationTimeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS,
      'Newspaper generation timed out'
    );
  } catch (error) {
    logger.warn({ error: String(error) }, 'Falling back to deterministic newspaper edition');
  }

  if (!content || content.length < 80) {
    content = buildFallbackEdition(config, editor, today, merged, activityCount);
  }

  const newspaper: PublishedNewspaper = {
    date: today,
    editor_id: editor.id,
    editor_name: editor.name,
    content,
    generated_at: new Date(nowMs).toISOString(),
    activity_count: activityCount,
  };

  await writeFile(issuePath, JSON.stringify(newspaper, null, 2));

  const nextIndex = existingIndex.filter((entry) => entry.date !== today);
  nextIndex.unshift({
    date: newspaper.date,
    editor_id: newspaper.editor_id,
    editor_name: newspaper.editor_name,
    activity_count: newspaper.activity_count,
  });
  await writeFile(join(config.dataDir, 'index.json'), JSON.stringify(nextIndex.slice(0, 90), null, 2));

  logger.info(
    { date: today, editor: editor.name, activityCount, outputDir: config.dataDir },
    'Published town newspaper'
  );

  return newspaper;
}

export function startNewspaperPublishingLoop(config: NewspaperPublisherConfig): () => void {
  const logger = getLogger();
  const intervalMs = config.intervalMs ?? DEFAULT_INTERVAL_MS;
  const initialDelayMs = config.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  const schedule = (delay: number): void => {
    if (stopped) return;
    timer = setTimeout(async () => {
      if (stopped || running) {
        schedule(intervalMs);
        return;
      }

      running = true;
      try {
        await publishNewspaperIfNeeded(config);
      } catch (error) {
        logger.error({ error: String(error) }, 'Newspaper publisher loop failed');
      } finally {
        running = false;
        schedule(intervalMs);
      }
    }, delay);
  };

  logger.info(
    { dataDir: config.dataDir, intervalMs, initialDelayMs, chronicleName: config.chronicleName },
    'Starting newspaper publishing loop'
  );

  schedule(initialDelayMs);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    logger.info('Newspaper publishing loop stopped');
  };
}

export function getNewspaperDataDir(basePath = getBasePath()): string {
  return join(basePath, 'newspapers');
}

export function getDefaultNewtownNewspaperConfig(
  dataDir = getNewspaperDataDir()
): NewspaperPublisherConfig {
  return {
    dataDir,
    townName: 'Newtown',
    chronicleName: 'The Newtown Chronicle',
    timezone: DEFAULT_TIMEZONE,
    characters: [
      { id: 'neo', name: 'Neo', port: 3003 },
      { id: 'plato', name: 'Plato', port: 3004 },
      { id: 'joe', name: 'Joe', port: 3005 },
      { id: 'cage', name: 'Nicolas Cage', port: 3006 },
    ],
    editors: [
      {
        id: 'neo',
        name: 'Neo',
        voice: 'Write as Neo — restrained, observant, skeptical of easy explanations, but compassionate. The tone should be precise, calm, and alert to signs of pressure, performance, and choice.',
      },
      {
        id: 'plato',
        name: 'Plato',
        voice: 'Write as Plato — lucid, formal without stiffness, interested in what appearances reveal about deeper order. Guide the reader from incident to principle without sounding like a textbook.',
      },
      {
        id: 'joe',
        name: 'Joe',
        voice: 'Write as Joe — plainspoken, dry, grounded, practical, and mildly suspicious of grand theories. Sound like the one person in town making sure words still connect to ordinary life.',
      },
      {
        id: 'cage',
        name: 'Nicolas Cage',
        voice: 'Write as Nicolas Cage — vivid, sincere, theatrical but not hollow. Find the charged object in ordinary events, then bring the sentence back to something human.',
      },
    ],
  };
}
