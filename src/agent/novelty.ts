/**
 * Novelty Engine — periodic diegetic events that break topic repetition loops.
 * Zero LLM cost. Template expansion + random selection + external feeds.
 *
 * Events are delivered ONLY as town events (external world state).
 * Characters encounter them naturally and form memories through their
 * existing reaction pipeline — just like the physical world.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { BUILDING_MAP } from '../commune/buildings.js';
import { getMeta, setMeta } from '../storage/database.js';
import { getLogger } from '../utils/logger.js';

export function expandTemplate(template: string, fills: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => fills[key] ?? match);
}

export function pickRandom<T>(pool: T[]): T {
  return pool[Math.floor(Math.random() * pool.length)]!;
}

export function pickRandomBuilding(): string {
  const buildings = Array.from(BUILDING_MAP.values());
  return pickRandom(buildings).name;
}

export function pickRandomTime(): string {
  const hour = Math.floor(Math.random() * 12) + 1;
  const minute = Math.floor(Math.random() * 60);
  const ampm = Math.random() < 0.5 ? 'AM' : 'PM';
  return `${hour}:${minute.toString().padStart(2, '0')} ${ampm}`;
}

// ── Fragment cache ──────────────────────────────────────────

let fragmentCache: string[] = [];
export let cacheLastRefreshed = 0;

interface SourceWeights {
  rss: number;
  wikipedia: number;
  static: number;
}

interface SourcesConfig {
  rss: Array<{ url: string; name: string }>;
  wikipedia: { enabled: boolean; endpoint: string };
}

export async function loadStaticFragments(workspaceDir: string): Promise<string[]> {
  const path = join(workspaceDir, 'novelty', 'fragments.json');
  const raw = await readFile(path, 'utf-8');
  const data = JSON.parse(raw) as { fragments: string[] };
  return data.fragments;
}

async function loadSourcesConfig(workspaceDir: string): Promise<SourcesConfig> {
  const path = join(workspaceDir, 'novelty', 'sources.json');
  const raw = await readFile(path, 'utf-8');
  return JSON.parse(raw) as SourcesConfig;
}

export function truncateToSentence(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const truncated = text.slice(0, maxLength);
  const lastPeriod = truncated.lastIndexOf('. ');
  const lastExclaim = truncated.lastIndexOf('! ');
  const lastQuestion = truncated.lastIndexOf('? ');
  const lastBoundary = Math.max(lastPeriod, lastExclaim, lastQuestion);
  if (lastBoundary > 0) return text.slice(0, lastBoundary + 1);
  const lastSpace = truncated.lastIndexOf(' ');
  return lastSpace > 0 ? text.slice(0, lastSpace) : truncated;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').trim();
}

async function fetchRssFragment(sources: SourcesConfig): Promise<string | null> {
  if (sources.rss.length === 0) return null;
  const feed = pickRandom(sources.rss);
  try {
    const resp = await fetch(feed.url, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return null;
    const xml = await resp.text();
    const items = xml.match(/<(?:description|summary)>([\s\S]*?)<\/(?:description|summary)>/gi) ?? [];
    if (items.length === 0) return null;
    const item = pickRandom(items);
    const content = item.replace(/<\/?(?:description|summary)>/gi, '');
    const text = stripHtml(content);
    if (text.length < 20) return null;
    return truncateToSentence(text, 200);
  } catch {
    return null;
  }
}

async function fetchWikipediaFragment(sources: SourcesConfig): Promise<string | null> {
  if (!sources.wikipedia.enabled) return null;
  try {
    const resp = await fetch(sources.wikipedia.endpoint, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return null;
    const data = await resp.json() as { extract?: string };
    if (!data.extract || data.extract.length < 20) return null;
    return truncateToSentence(data.extract, 200);
  } catch {
    return null;
  }
}

export async function pickFragment(
  workspaceDir: string,
  weights: SourceWeights = { rss: 0.4, wikipedia: 0.3, static: 0.3 }
): Promise<string> {
  if (fragmentCache.length === 0) {
    fragmentCache = await loadStaticFragments(workspaceDir);
  }
  const sourcesConfig = await loadSourcesConfig(workspaceDir);
  const roll = Math.random();
  let fragment: string | null = null;
  if (roll < weights.rss) {
    fragment = await fetchRssFragment(sourcesConfig);
  } else if (roll < weights.rss + weights.wikipedia) {
    fragment = await fetchWikipediaFragment(sourcesConfig);
  }
  if (!fragment) {
    fragment = pickRandom(fragmentCache);
  }
  return fragment;
}

export async function refreshFragmentCache(workspaceDir: string, cacheSize: number): Promise<void> {
  const sourcesConfig = await loadSourcesConfig(workspaceDir);
  const newCache: string[] = [];
  for (let i = 0; i < cacheSize; i++) {
    const roll = Math.random();
    let fragment: string | null = null;
    if (roll < 0.5) {
      fragment = await fetchRssFragment(sourcesConfig);
    } else {
      fragment = await fetchWikipediaFragment(sourcesConfig);
    }
    if (fragment) newCache.push(fragment);
  }
  const staticFragments = await loadStaticFragments(workspaceDir);
  while (newCache.length < cacheSize && staticFragments.length > 0) {
    newCache.push(pickRandom(staticFragments));
  }
  fragmentCache = newCache;
  cacheLastRefreshed = Date.now();
}

// ── Template loading ────────────────────────────────────────

interface AmbientTemplate {
  id: string;
  category: string;
  template: string;
  placeholders: string[];
}

interface AmbientTemplatesFile {
  staticPools: Record<string, string[]>;
  templates: AmbientTemplate[];
}

interface MajorSeed {
  id: string;
  name: string;
  template: string;
  beats?: string[];
  persistMs?: number;
}

interface MajorSeedsFile {
  seeds: MajorSeed[];
}

export interface NoveltyEvent {
  content: string;
  category: 'ambient' | 'major';
  templateId: string;
  seedId?: string;
  persistMs: number;
}

async function loadAmbientTemplates(workspaceDir: string): Promise<AmbientTemplatesFile> {
  const path = join(workspaceDir, 'novelty', 'ambient-templates.json');
  const raw = await readFile(path, 'utf-8');
  return JSON.parse(raw) as AmbientTemplatesFile;
}

async function loadMajorSeeds(workspaceDir: string): Promise<MajorSeedsFile> {
  const path = join(workspaceDir, 'novelty', 'major-seeds.json');
  const raw = await readFile(path, 'utf-8');
  return JSON.parse(raw) as MajorSeedsFile;
}

function buildFills(
  placeholders: string[],
  staticPools: Record<string, string[]>,
  fragment: string
): Record<string, string> {
  const fills: Record<string, string> = {};
  for (const p of placeholders) {
    if (p === 'fragment') {
      fills.fragment = fragment;
    } else if (p === 'building' || p === 'building2') {
      fills[p] = pickRandomBuilding();
    } else if (p === 'time') {
      fills[p] = pickRandomTime();
    } else if (staticPools[p]) {
      fills[p] = pickRandom(staticPools[p]);
    }
  }
  return fills;
}

export async function generateAmbientEvent(workspaceDir: string, config?: NoveltyConfig): Promise<NoveltyEvent> {
  const data = await loadAmbientTemplates(workspaceDir);
  const template = pickRandom(data.templates);
  const fragment = await pickFragment(workspaceDir);
  const fills = buildFills(template.placeholders, data.staticPools, fragment);
  const content = expandTemplate(template.template, fills);
  const durations = config?.categoryDurations ?? {};
  const persistMs = durations[template.category] ?? durations['major-default'] ?? 14400000;
  return { content, category: 'ambient', templateId: template.id, persistMs };
}

export async function generateMajorEvent(workspaceDir: string, config?: NoveltyConfig): Promise<NoveltyEvent> {
  const data = await loadMajorSeeds(workspaceDir);
  const seed = pickRandom(data.seeds);
  const fragment = await pickFragment(workspaceDir);
  const placeholderMatches = seed.template.match(/\{(\w+)\}/g) ?? [];
  const placeholders = placeholderMatches.map((m) => m.slice(1, -1));
  const ambientData = await loadAmbientTemplates(workspaceDir);
  const fills = buildFills(placeholders, ambientData.staticPools, fragment);
  const content = expandTemplate(seed.template, fills);
  const durations = config?.categoryDurations ?? {};
  const persistMs = seed.persistMs ?? durations['major-default'] ?? 43200000;
  return { content, category: 'major', templateId: seed.id, seedId: seed.id, persistMs };
}

// ── Rate limiting ───────────────────────────────────────────

function getWeekKey(): string {
  const now = new Date();
  const jan1 = new Date(now.getFullYear(), 0, 1);
  const week = Math.ceil(((now.getTime() - jan1.getTime()) / 86400000 + jan1.getDay() + 1) / 7);
  return `${now.getFullYear()}-W${week}`;
}

export function isMajorLimitReached(maxPerWeek: number): boolean {
  const key = `novelty:major_count:${getWeekKey()}`;
  const raw = getMeta(key);
  const count = raw ? parseInt(raw, 10) : 0;
  return count >= maxPerWeek;
}

export function recordMajorFiring(): void {
  const key = `novelty:major_count:${getWeekKey()}`;
  const raw = getMeta(key);
  const count = raw ? parseInt(raw, 10) : 0;
  setMeta(key, (count + 1).toString());
  setMeta('novelty:last_major', Date.now().toString());
}

function isRecentlyUsedTemplate(templateId: string): boolean {
  const raw = getMeta('novelty:recent_templates');
  if (!raw) return false;
  const recent = JSON.parse(raw) as string[];
  return recent.includes(templateId);
}

function recordTemplateUse(templateId: string, maxRecent: number): void {
  const raw = getMeta('novelty:recent_templates');
  const recent: string[] = raw ? (JSON.parse(raw) as string[]) : [];
  recent.unshift(templateId);
  if (recent.length > maxRecent) recent.length = maxRecent;
  setMeta('novelty:recent_templates', JSON.stringify(recent));
}

// ── Configuration ───────────────────────────────────────────

export interface NoveltyConfig {
  enabled: boolean;
  ambient: {
    checkIntervalMs: number;
    fireChance: number;
    maxPerDayPerCharacter: number;
    targetCount: [number, number];
  };
  major: {
    checkIntervalMs: number;
    fireChance: number;
    maxPerWeek: number;
  };
  categoryDurations: Record<string, number>;
  peers: PeerTarget[];
  sources: {
    refreshIntervalMs: number;
    cacheSize: number;
    weights: SourceWeights;
  };
}

export interface PeerTarget {
  id: string;
  name: string;
  url: string;
}

export async function loadNoveltyConfig(workspaceDir: string): Promise<NoveltyConfig> {
  const path = join(workspaceDir, 'novelty', 'config.json');
  const raw = await readFile(path, 'utf-8');
  return JSON.parse(raw) as NoveltyConfig;
}

// ── Main loop ───────────────────────────────────────────────

export interface NoveltyLoopParams {
  workspaceDir: string;
}

export function startNoveltyLoop(params: NoveltyLoopParams): () => void {
  const logger = getLogger();
  let timer: ReturnType<typeof setInterval> | null = null;
  let cacheTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  async function init(): Promise<void> {
    const config = await loadNoveltyConfig(params.workspaceDir);
    if (!config.enabled) {
      logger.info('Novelty engine disabled');
      return;
    }

    logger.info(
      {
        ambientChance: config.ambient.fireChance,
        majorChance: config.major.fireChance,
        interval: `${config.ambient.checkIntervalMs / 60000}min`,
      },
      'Starting novelty engine'
    );

    // Initial cache populate
    await refreshFragmentCache(params.workspaceDir, config.sources.cacheSize).catch((err) => {
      logger.debug({ error: String(err) }, 'Initial fragment cache refresh failed');
    });

    // Cache refresh timer
    cacheTimer = setInterval(async () => {
      if (stopped) return;
      await refreshFragmentCache(params.workspaceDir, config.sources.cacheSize).catch((err) => {
        logger.debug({ error: String(err) }, 'Fragment cache refresh failed');
      });
    }, config.sources.refreshIntervalMs);

    // Main check timer
    timer = setInterval(async () => {
      if (stopped) return;
      try {
        await runNoveltyCheck(config, params);
      } catch (err) {
        logger.debug({ error: String(err) }, 'Novelty check error');
      }
    }, config.ambient.checkIntervalMs);

    // First check after a short delay (5 minutes after startup)
    setTimeout(async () => {
      if (stopped) return;
      try {
        await runNoveltyCheck(config, params);
      } catch (err) {
        logger.debug({ error: String(err) }, 'Initial novelty check error');
      }
    }, 5 * 60 * 1000);
  }

  init().catch((err) => {
    logger.warn({ error: String(err) }, 'Novelty engine init failed');
  });

  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
    if (cacheTimer) clearInterval(cacheTimer);
    logger.info('Novelty engine stopped');
  };
}

async function runNoveltyCheck(config: NoveltyConfig, params: NoveltyLoopParams): Promise<void> {
  const logger = getLogger();

  // Check for pending multi-beat events first
  const pendingRaw = getMeta('novelty:pending_beats');
  if (pendingRaw) {
    const pending = JSON.parse(pendingRaw) as { beats: string[]; currentIndex: number; persistMs: number };
    if (pending.currentIndex < pending.beats.length) {
      const beat = pending.beats[pending.currentIndex]!;
      try {
        const { createTownEvent } = await import('../events/town-events.js');
        createTownEvent({
          description: beat,
          narrative: true,
          natural: true,
          source: 'novelty',
          expiresInMs: pending.persistMs,
        });
      } catch (err) {
        logger.debug({ error: String(err) }, 'Could not create town event for multi-beat');
      }
      pending.currentIndex++;
      if (pending.currentIndex >= pending.beats.length) {
        setMeta('novelty:pending_beats', '');
      } else {
        setMeta('novelty:pending_beats', JSON.stringify(pending));
      }
      recordMajorFiring();
      logger.info({ beat: pending.currentIndex }, 'Delivered multi-beat event continuation');
      return;
    }
  }

  // Roll for major event
  if (Math.random() < config.major.fireChance && !isMajorLimitReached(config.major.maxPerWeek)) {
    const event = await generateMajorEvent(params.workspaceDir, config);
    if (!isRecentlyUsedTemplate(event.templateId)) {
      try {
        const { createTownEvent } = await import('../events/town-events.js');
        createTownEvent({
          description: event.content,
          narrative: true,
          natural: true,
          source: 'novelty',
          expiresInMs: event.persistMs,
        });
      } catch (err) {
        logger.debug({ error: String(err) }, 'Could not create town event for major novelty');
      }

      recordMajorFiring();
      recordTemplateUse(event.templateId, 5);
      logger.info({ template: event.templateId, persistMs: event.persistMs, content: event.content.slice(0, 80) }, 'Major novelty event fired');
    }
  }

  // Roll for ambient event
  if (Math.random() < config.ambient.fireChance) {
    const event = await generateAmbientEvent(params.workspaceDir, config);
    if (!isRecentlyUsedTemplate(event.templateId)) {
      try {
        const { createTownEvent } = await import('../events/town-events.js');
        createTownEvent({
          description: event.content,
          narrative: true,
          natural: true,
          source: 'novelty',
          expiresInMs: event.persistMs,
        });
      } catch (err) {
        logger.debug({ error: String(err) }, 'Could not create town event for ambient novelty');
      }

      recordTemplateUse(event.templateId, 10);
      logger.info(
        { template: event.templateId, persistMs: event.persistMs, content: event.content.slice(0, 80) },
        'Ambient novelty event fired'
      );
    }
  }
}
