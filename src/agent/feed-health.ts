/**
 * RSS Feed Health Monitor — detects dead feeds and finds replacements.
 *
 * Runs weekly on Wired Lain. Checks each configured RSS feed for:
 * - HTTP reachability (200 response within 15s)
 * - Parseable content (at least 2 items with description/summary)
 *
 * After 3 consecutive failures, searches for a replacement feed in the
 * same literary/philosophical domain and swaps it into sources.json.
 *
 * Feed health state is tracked in the meta store.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getMeta, setMeta } from '../storage/database.js';
import { getLogger } from '../utils/logger.js';

interface FeedEntry {
  url: string;
  name: string;
}

interface SourcesConfig {
  rss: FeedEntry[];
  wikipedia: { enabled: boolean; endpoint: string };
}

interface FeedHealthState {
  /** Consecutive failure count per feed URL */
  failures: Record<string, number>;
  /** Feeds we've already retired (URL → replacement URL) */
  replaced: Record<string, string>;
  /** Last full health check timestamp */
  lastCheckAt: number;
}

const META_KEY = 'feed-health:state';
const FAILURE_THRESHOLD = 3;
const CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // weekly

/**
 * Known good RSS feeds in the same domain (literary, philosophical, cultural).
 * Used as a curated fallback pool before resorting to web search.
 */
const BACKUP_FEEDS: FeedEntry[] = [
  { url: 'https://www.openculture.com/feed', name: 'Open Culture' },
  { url: 'https://longreads.com/feed/', name: 'Longreads' },
  { url: 'https://theconversation.com/us/arts/articles.atom', name: 'The Conversation (Arts)' },
  { url: 'https://www.theparisreview.org/blog/feed/', name: 'The Paris Review' },
  { url: 'https://thereader.mitpress.mit.edu/feed/', name: 'MIT Press Reader' },
  { url: 'https://psyche.co/feed', name: 'Psyche' },
  { url: 'https://www.noemamag.com/feed/', name: 'Noema' },
  { url: 'https://hedgehogreview.com/feed', name: 'The Hedgehog Review' },
  { url: 'https://www.lrb.co.uk/feeds/rss', name: 'London Review of Books' },
  { url: 'https://www.nybooks.com/feed/', name: 'NY Review of Books' },
  { url: 'https://lithub.com/feed/', name: 'Literary Hub' },
  { url: 'https://www.thesmartset.com/feed/', name: 'The Smart Set' },
  { url: 'https://blog.longnow.org/feed/', name: 'Long Now' },
  { url: 'https://www.aldaily.com/feed/', name: 'Arts & Letters Daily' },
  { url: 'https://daily.jstor.org/feed/', name: 'JSTOR Daily' },
];

function getState(): FeedHealthState {
  const raw = getMeta(META_KEY);
  if (!raw) return { failures: {}, replaced: {}, lastCheckAt: 0 };
  return JSON.parse(raw) as FeedHealthState;
}

function saveState(state: FeedHealthState): void {
  setMeta(META_KEY, JSON.stringify(state));
}

/**
 * Check if a feed URL is healthy: returns HTTP 200 and has parseable items.
 */
async function checkFeed(url: string): Promise<{ ok: boolean; itemCount: number; error?: string }> {
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'Laintown/1.0 RSS Health Monitor' },
    });
    if (!resp.ok) {
      return { ok: false, itemCount: 0, error: `HTTP ${resp.status}` };
    }
    const xml = await resp.text();
    const items = xml.match(/<(?:description|summary|content:encoded)>([\s\S]*?)<\/(?:description|summary|content:encoded)>/gi) ?? [];
    if (items.length < 2) {
      return { ok: false, itemCount: items.length, error: 'Too few items' };
    }
    return { ok: true, itemCount: items.length };
  } catch (err) {
    return { ok: false, itemCount: 0, error: String(err).slice(0, 100) };
  }
}

/**
 * Find a replacement for a dead feed from the backup pool.
 * Returns the first backup feed that:
 * 1. Isn't already in the active feed list
 * 2. Isn't already a known-dead URL
 * 3. Passes a health check
 */
async function findReplacement(
  activeUrls: Set<string>,
  deadUrls: Set<string>,
): Promise<FeedEntry | null> {
  const logger = getLogger();

  // Shuffle backup feeds for variety
  const shuffled = [...BACKUP_FEEDS].sort(() => Math.random() - 0.5);

  for (const candidate of shuffled) {
    if (activeUrls.has(candidate.url)) continue;
    if (deadUrls.has(candidate.url)) continue;

    const health = await checkFeed(candidate.url);
    if (health.ok) {
      logger.info({ feed: candidate.name, url: candidate.url, items: health.itemCount }, 'Found healthy replacement feed');
      return candidate;
    }
    logger.debug({ feed: candidate.name, error: health.error }, 'Backup feed also unhealthy');
  }

  return null;
}

/**
 * Run a full health check cycle on all configured feeds.
 * Replaces dead feeds with backups from the curated pool.
 */
async function runHealthCheck(workspaceDir: string): Promise<void> {
  const logger = getLogger();
  const sourcesPath = join(workspaceDir, 'novelty', 'sources.json');
  const raw = await readFile(sourcesPath, 'utf-8');
  const sources = JSON.parse(raw) as SourcesConfig;
  const state = getState();

  logger.info({ feedCount: sources.rss.length }, 'Feed health check starting');

  const activeUrls = new Set(sources.rss.map(f => f.url));
  const deadUrls = new Set(Object.keys(state.replaced));
  let replacements = 0;

  for (let i = 0; i < sources.rss.length; i++) {
    const feed = sources.rss[i]!;
    const health = await checkFeed(feed.url);

    if (health.ok) {
      // Reset failure count on success
      if (state.failures[feed.url]) {
        logger.info({ feed: feed.name }, 'Feed recovered');
        delete state.failures[feed.url];
      }
      continue;
    }

    // Track failure
    const failures = (state.failures[feed.url] ?? 0) + 1;
    state.failures[feed.url] = failures;
    logger.warn({ feed: feed.name, url: feed.url, failures, error: health.error }, 'Feed check failed');

    if (failures < FAILURE_THRESHOLD) continue;

    // Feed is dead — find replacement
    logger.info({ feed: feed.name, failures }, 'Feed considered dead, searching for replacement');
    const replacement = await findReplacement(activeUrls, deadUrls);

    if (replacement) {
      // Swap in the replacement
      state.replaced[feed.url] = replacement.url;
      delete state.failures[feed.url];
      activeUrls.delete(feed.url);
      activeUrls.add(replacement.url);

      sources.rss[i] = replacement;
      replacements++;

      logger.info(
        { dead: feed.name, deadUrl: feed.url, replacement: replacement.name, replacementUrl: replacement.url },
        'Feed replaced',
      );
    } else {
      logger.warn({ feed: feed.name }, 'No replacement found — feed stays in config but will keep failing');
    }
  }

  // Save updated sources if any replacements were made
  if (replacements > 0) {
    await writeFile(sourcesPath, JSON.stringify(sources, null, 2) + '\n', 'utf-8');
    logger.info({ replacements }, 'Sources config updated with replacement feeds');
  }

  state.lastCheckAt = Date.now();
  saveState(state);

  logger.info(
    { healthy: sources.rss.length - replacements, replaced: replacements, totalFailures: Object.keys(state.failures).length },
    'Feed health check complete',
  );
}

// ── Loop ──────────────────────────────────────────────────

export function startFeedHealthLoop(opts: { workspaceDir: string }): () => void {
  const logger = getLogger();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function getInitialDelay(): number {
    const state = getState();
    if (!state.lastCheckAt) return 60_000; // First run: 1 minute after startup
    const elapsed = Date.now() - state.lastCheckAt;
    const remaining = CHECK_INTERVAL_MS - elapsed;
    return Math.max(60_000, remaining);
  }

  function scheduleNext(delay?: number): void {
    if (stopped) return;
    const d = delay ?? CHECK_INTERVAL_MS;
    timer = setTimeout(async () => {
      if (stopped) return;
      try {
        await runHealthCheck(opts.workspaceDir);
      } catch (err) {
        logger.error({ error: String(err) }, 'Feed health check error');
      }
      scheduleNext();
    }, d);
  }

  logger.info('Feed health monitor started');
  scheduleNext(getInitialDelay());

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    logger.info('Feed health monitor stopped');
  };
}

/** Export for admin API / manual trigger */
export { runHealthCheck, getState as getFeedHealthState };
