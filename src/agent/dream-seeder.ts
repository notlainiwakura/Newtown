/**
 * Auto Dream Seeder — keeps characters supplied with fresh dream material.
 *
 * Runs on Wired Lain only. Periodically checks each character's pending
 * seed count and replenishes from RSS feeds and Wikipedia when low.
 * Ensures the town's subconscious never runs dry.
 */

import { request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getMeta, setMeta } from '../storage/database.js';
import { getLogger } from '../utils/logger.js';

// ── Types ──────────────────────────────────────────────────

interface SeederConfig {
  /** How often to check seed levels (default: 12h) */
  checkIntervalMs: number;
  /** Replenish if a character has fewer than this many pending seeds */
  minPendingThreshold: number;
  /** How many fragments to seed per replenish cycle */
  batchSize: number;
  /** Peers to seed */
  peers: Array<{ id: string; name: string; port: number }>;
}

interface SourcesConfig {
  rss: Array<{ url: string; name: string }>;
  wikipedia: { enabled: boolean; endpoint: string };
}

const DEFAULT_CONFIG: SeederConfig = {
  checkIntervalMs: 12 * 60 * 60 * 1000, // 12 hours
  minPendingThreshold: 50,
  batchSize: 30,
  peers: [
    { id: 'wired-lain', name: 'Wired Lain', port: 3000 },
    { id: 'lain', name: 'Lain', port: 3001 },
    { id: 'dr-claude', name: 'Dr. Claude', port: 3002 },
    { id: 'pkd', name: 'PKD', port: 3003 },
    { id: 'mckenna', name: 'McKenna', port: 3004 },
    { id: 'john', name: 'John', port: 3005 },
    { id: 'hiru', name: 'Hiru', port: 3006 },
  ],
};

// ── Content fetching ───────────────────────────────────────

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').trim();
}

async function loadSourcesConfig(workspaceDir: string): Promise<SourcesConfig> {
  const raw = await readFile(join(workspaceDir, 'novelty', 'sources.json'), 'utf-8');
  return JSON.parse(raw) as SourcesConfig;
}

/** Fetch a full article excerpt from an RSS feed (longer than novelty fragments) */
async function fetchRssArticle(sources: SourcesConfig): Promise<string | null> {
  if (sources.rss.length === 0) return null;
  const feed = sources.rss[Math.floor(Math.random() * sources.rss.length)]!;
  try {
    const resp = await fetch(feed.url, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) return null;
    const xml = await resp.text();
    // Extract all content descriptions
    const items = xml.match(/<(?:description|summary|content:encoded)>([\s\S]*?)<\/(?:description|summary|content:encoded)>/gi) ?? [];
    if (items.length < 2) return null; // Skip feed-level description
    // Pick a random article (skip first which is often feed description)
    const idx = 1 + Math.floor(Math.random() * (items.length - 1));
    const item = items[idx]!;
    const text = stripHtml(item.replace(/<\/?(?:description|summary|content:encoded)>/gi, ''));
    return text.length >= 50 ? text.slice(0, 1500) : null;
  } catch {
    return null;
  }
}

/** Fetch a Wikipedia article summary */
async function fetchWikipediaArticle(sources: SourcesConfig): Promise<string | null> {
  if (!sources.wikipedia.enabled) return null;
  try {
    const resp = await fetch(sources.wikipedia.endpoint, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return null;
    const data = await resp.json() as { extract?: string; title?: string };
    if (!data.extract || data.extract.length < 80) return null;
    return data.extract.slice(0, 1500);
  } catch {
    return null;
  }
}

/** Fetch a batch of fresh content fragments suitable for dream seeding */
async function fetchDreamContent(workspaceDir: string, count: number): Promise<string[]> {
  const logger = getLogger();
  const sources = await loadSourcesConfig(workspaceDir);
  const fragments: string[] = [];

  for (let i = 0; i < count * 2 && fragments.length < count; i++) {
    try {
      const article = Math.random() < 0.5
        ? await fetchRssArticle(sources)
        : await fetchWikipediaArticle(sources);

      if (article && article.length >= 50) {
        // Split long articles into dream-sized fragments (200-800 chars)
        const sentences = article.match(/[^.!?]+[.!?]+/g) ?? [article];
        let chunk = '';
        for (const sentence of sentences) {
          if ((chunk + sentence).length > 800 && chunk.length >= 200) {
            fragments.push(chunk.trim());
            chunk = '';
            if (fragments.length >= count) break;
          }
          chunk += sentence;
        }
        if (chunk.trim().length >= 100 && fragments.length < count) {
          fragments.push(chunk.trim());
        }
      }
    } catch (err) {
      logger.debug({ error: String(err) }, 'Dream seeder: content fetch failed');
    }
  }

  return fragments;
}

// ── HTTP helpers ───────────────────────────────────────────

function fetchPeerStats(port: number, token: string): Promise<{ pending: number } | null> {
  return new Promise((resolve) => {
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path: '/api/dreams/stats', method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` }, timeout: 5000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString()) as { pending: number }); }
          catch { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function postSeed(port: number, token: string, content: string): Promise<boolean> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ content, emotionalWeight: 0.4 + Math.random() * 0.3 });
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path: '/api/interlink/dream-seed', method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json',
                   'Content-Length': Buffer.byteLength(body).toString() },
        timeout: 10000 },
      (res) => {
        res.resume(); // drain
        resolve(res.statusCode === 200);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(body);
    req.end();
  });
}

// ── Main loop ──────────────────────────────────────────────

async function runSeederCycle(workspaceDir: string, config: SeederConfig): Promise<void> {
  const logger = getLogger();
  const token = process.env['LAIN_INTERLINK_TOKEN'] || '';
  if (!token) {
    logger.warn('Dream seeder: no LAIN_INTERLINK_TOKEN, skipping');
    return;
  }

  logger.info('Dream seeder: checking seed levels');

  // Check each peer's pending count
  const needsSeeding: Array<{ id: string; name: string; port: number; pending: number }> = [];

  for (const peer of config.peers) {
    const stats = await fetchPeerStats(peer.port, token);
    if (stats && stats.pending < config.minPendingThreshold) {
      needsSeeding.push({ ...peer, pending: stats.pending });
      logger.info({ character: peer.name, pending: stats.pending, threshold: config.minPendingThreshold },
        'Dream seeder: character needs replenishment');
    }
  }

  if (needsSeeding.length === 0) {
    logger.info('Dream seeder: all characters above threshold, no action needed');
    setMeta('dream-seeder:last_check_at', Date.now().toString());
    return;
  }

  // Fetch content for all characters that need it
  const totalNeeded = needsSeeding.length * config.batchSize;
  logger.info({ totalNeeded, characters: needsSeeding.length }, 'Dream seeder: fetching content');

  const content = await fetchDreamContent(workspaceDir, totalNeeded);
  if (content.length === 0) {
    logger.warn('Dream seeder: could not fetch any content from external sources');
    return;
  }

  logger.info({ fetched: content.length }, 'Dream seeder: content fetched, seeding characters');

  // Distribute fragments to characters
  let contentIdx = 0;
  let totalSeeded = 0;

  for (const peer of needsSeeding) {
    let seeded = 0;
    for (let i = 0; i < config.batchSize && contentIdx < content.length; i++) {
      const success = await postSeed(peer.port, token, content[contentIdx]!);
      if (success) seeded++;
      contentIdx++;
    }
    totalSeeded += seeded;
    logger.info({ character: peer.name, seeded }, 'Dream seeder: seeded character');
  }

  setMeta('dream-seeder:last_check_at', Date.now().toString());
  setMeta('dream-seeder:last_seeded_count', totalSeeded.toString());
  logger.info({ totalSeeded }, 'Dream seeder: cycle complete');
}

export function startDreamSeederLoop(params: { workspaceDir: string }): () => void {
  const logger = getLogger();
  const config = DEFAULT_CONFIG;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  // Calculate initial delay from last check
  function getInitialDelay(): number {
    const last = getMeta('dream-seeder:last_check_at');
    if (!last) return 60_000; // First run: wait 1 min for services to start
    const elapsed = Date.now() - parseInt(last, 10);
    const remaining = config.checkIntervalMs - elapsed;
    return Math.max(60_000, remaining);
  }

  function scheduleNext(delay?: number): void {
    if (stopped) return;
    const d = delay ?? config.checkIntervalMs;
    timer = setTimeout(async () => {
      if (stopped) return;
      try {
        await runSeederCycle(params.workspaceDir, config);
      } catch (err) {
        logger.error({ error: String(err) }, 'Dream seeder cycle error');
      }
      scheduleNext();
    }, d);
  }

  logger.info({ intervalMs: config.checkIntervalMs, threshold: config.minPendingThreshold },
    'Dream seeder loop started');
  scheduleNext(getInitialDelay());

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    logger.info('Dream seeder loop stopped');
  };
}
