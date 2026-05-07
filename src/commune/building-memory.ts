/**
 * Building Memory — spatial residue system.
 *
 * Buildings accumulate traces of what happens in them: conversations,
 * arrivals, objects left behind, quiet moments. Characters sense these
 * traces when present, making the spatial grid a living space.
 *
 * Events are stored centrally on Wired Lain's database. Characters
 * record events via POST and read residue via GET.
 */

import { nanoid } from 'nanoid';
import { getLogger } from '../utils/logger.js';
import { getCurrentLocation } from './location.js';
import { BUILDING_MAP } from './buildings.js';
import { getInterlinkHeaders } from '../security/interlink-auth.js';

const WIRED_LAIN_URL = process.env['WIRED_LAIN_URL'] || 'http://localhost:3000';

export interface BuildingEvent {
  id: string;
  building: string;
  event_type: 'conversation' | 'arrival' | 'departure' | 'note_left' | 'object_placed' | 'object_taken' | 'quiet_moment';
  summary: string;
  emotional_tone: number; // -1.0 to 1.0
  actors: string[];       // character IDs
  created_at: number;
}

/**
 * findings.md P2:1500 — Wired Lain was a single point of failure for
 * every character's spatial residue. Every write fired a fresh POST,
 * every read fired a fresh GET. A WL outage (restart, partition) meant
 * the entire town's "atmosphere" context went blank for the duration.
 *
 * Per WL-as-authority architectural commitment (2026-04-22), clients
 * now absorb transient WL unavailability:
 *   - writes buffer into a bounded in-memory FIFO, drained async
 *   - reads cache per (building, hours), fresh TTL + stale-grace during
 *     outages
 * Tradeoff: queued events are lost on process exit. The queue is
 * process-local, not SQLite-persisted. SIGTERM during a WL outage drops
 * recent events. Deferred durability because bounded systemd restarts
 * are seconds, not minutes.
 */
const MAX_QUEUE_SIZE = 500;
const RETRY_INTERVAL_MS = 30_000;
const CACHE_FRESH_TTL_MS = 60_000;
const CACHE_STALE_GRACE_MS = 30 * 60 * 1000;
const POST_TIMEOUT_MS = 5000;

/**
 * findings.md P2:1450 — recordBuildingEvent used to swallow every
 * failure mode (Wired Lain down, misconfigured URL, missing/empty
 * interlink token → 401, 5s timeout, network error) behind a single
 * bare `catch {}`. Per-process consecutive-failure streak escalates to
 * WARN once the queue drain has failed FAILURE_STREAK_WARN_THRESHOLD
 * times in a row; the first success after a streak also logs WARN.
 */
const FAILURE_STREAK_WARN_THRESHOLD = 3;
let buildingMemoryFailureStreak = 0;
let buildingMemoryTotalFailures = 0;
let buildingMemoryTotalSuccesses = 0;

interface QueuedEvent {
  event: BuildingEvent;
  enqueuedAt: number;
  attempts: number;
}

const writeQueue: QueuedEvent[] = [];
let drainPromise: Promise<void> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let queueTotalDropped = 0;

interface CacheEntry {
  events: RawBuildingEvent[];
  fetchedAt: number;
}
const residueCache = new Map<string, CacheEntry>();
let cacheHits = 0;
let cacheMisses = 0;
let cacheStaleServes = 0;

export function getBuildingMemoryHealth(): {
  failureStreak: number;
  totalFailures: number;
  totalSuccesses: number;
  queueDepth: number;
  queueDropped: number;
  cacheHits: number;
  cacheMisses: number;
  cacheStaleServes: number;
} {
  return {
    failureStreak: buildingMemoryFailureStreak,
    totalFailures: buildingMemoryTotalFailures,
    totalSuccesses: buildingMemoryTotalSuccesses,
    queueDepth: writeQueue.length,
    queueDropped: queueTotalDropped,
    cacheHits,
    cacheMisses,
    cacheStaleServes,
  };
}

/**
 * Record a building event by enqueuing it for async POST to Wired Lain.
 * Returns once the event is queued — never blocks on WL reachability.
 * Drops the oldest queued event if at MAX_QUEUE_SIZE capacity.
 */
export async function recordBuildingEvent(event: Omit<BuildingEvent, 'id' | 'created_at'>): Promise<void> {
  const log = getLogger();
  const headers = getInterlinkHeaders();
  if (!headers) {
    // Missing/empty interlink token. Previously indistinguishable from
    // a successful write — now emits DEBUG so misconfiguration is at
    // least discoverable with LOG_LEVEL=debug.
    log.debug(
      { building: event.building, event_type: event.event_type },
      'building-memory: no interlink headers — skipping event record',
    );
    return;
  }

  const fullEvent: BuildingEvent = {
    id: nanoid(16),
    ...event,
    created_at: Date.now(),
  };

  if (writeQueue.length >= MAX_QUEUE_SIZE) {
    const dropped = writeQueue.shift();
    queueTotalDropped++;
    if (queueTotalDropped === 1 || queueTotalDropped % 50 === 0) {
      log.warn(
        { dropped: dropped?.event.event_type, queueTotalDropped, queueDepth: writeQueue.length },
        'building-memory: write queue at capacity — dropping oldest event',
      );
    }
  }
  writeQueue.push({ event: fullEvent, enqueuedAt: Date.now(), attempts: 0 });
  scheduleDrain();
}

function scheduleDrain(): Promise<void> {
  if (drainPromise) return drainPromise;
  drainPromise = (async () => {
    // Yield a microtask so recordBuildingEvent() returns before the
    // first POST is attempted — the "enqueue, return fast" contract.
    await Promise.resolve();
    try {
      await drainQueue();
    } finally {
      drainPromise = null;
    }
  })();
  return drainPromise;
}

async function drainQueue(): Promise<void> {
  while (writeQueue.length > 0) {
    const head = writeQueue[0]!;
    const ok = await attemptPostEvent(head.event);
    if (ok) {
      writeQueue.shift();
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    } else {
      head.attempts++;
      armRetryTimer();
      return;
    }
  }
}

function armRetryTimer(): void {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    scheduleDrain();
  }, RETRY_INTERVAL_MS);
  if (typeof (retryTimer as { unref?: () => void }).unref === 'function') {
    (retryTimer as { unref: () => void }).unref();
  }
}

async function attemptPostEvent(event: BuildingEvent): Promise<boolean> {
  const log = getLogger();
  const headers = getInterlinkHeaders();
  if (!headers) {
    log.debug(
      { building: event.building, event_type: event.event_type },
      'building-memory: interlink headers missing at drain time — pausing',
    );
    return false;
  }
  try {
    const resp = await fetch(`${WIRED_LAIN_URL}/api/buildings/${encodeURIComponent(event.building)}/event`, {
      method: 'POST',
      headers,
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    buildingMemoryTotalSuccesses++;
    if (buildingMemoryFailureStreak >= FAILURE_STREAK_WARN_THRESHOLD) {
      log.warn(
        { priorStreak: buildingMemoryFailureStreak, totalFailures: buildingMemoryTotalFailures, queueDepth: writeQueue.length },
        'building-memory: recovered after consecutive failures',
      );
    }
    buildingMemoryFailureStreak = 0;
    return true;
  } catch (err) {
    buildingMemoryFailureStreak++;
    buildingMemoryTotalFailures++;
    if (buildingMemoryFailureStreak === FAILURE_STREAK_WARN_THRESHOLD) {
      log.warn(
        { err, streak: buildingMemoryFailureStreak, building: event.building, event_type: event.event_type, queueDepth: writeQueue.length, url: WIRED_LAIN_URL },
        'building-memory: consecutive write failures — queueing events for retry',
      );
    } else {
      log.debug(
        { err, streak: buildingMemoryFailureStreak, building: event.building, event_type: event.event_type },
        'building-memory: event POST failed — will retry',
      );
    }
    return false;
  }
}

/** Raw event from the API */
interface RawBuildingEvent {
  id: string;
  building: string;
  event_type: string;
  summary: string;
  emotional_tone: number;
  actors: string[];
  created_at: number;
}

/**
 * Fetch recent building residue. Serves fresh cache (< CACHE_FRESH_TTL_MS)
 * without any network hop; on network/HTTP failure, serves stale cache
 * within CACHE_STALE_GRACE_MS; else returns [].
 */
async function getBuildingResidue(building: string, hours = 24): Promise<RawBuildingEvent[]> {
  const cacheKey = `${building}:${hours}`;
  const now = Date.now();
  const cached = residueCache.get(cacheKey);
  if (cached && now - cached.fetchedAt < CACHE_FRESH_TTL_MS) {
    cacheHits++;
    return cached.events;
  }
  cacheMisses++;
  try {
    const events = await fetchResidueFromWL(building, hours);
    residueCache.set(cacheKey, { events, fetchedAt: now });
    return events;
  } catch {
    if (cached && now - cached.fetchedAt < CACHE_FRESH_TTL_MS + CACHE_STALE_GRACE_MS) {
      cacheStaleServes++;
      return cached.events;
    }
    return [];
  }
}

async function fetchResidueFromWL(building: string, hours: number): Promise<RawBuildingEvent[]> {
  const resp = await fetch(
    `${WIRED_LAIN_URL}/api/buildings/${encodeURIComponent(building)}/residue?hours=${hours}`,
    { signal: AbortSignal.timeout(POST_TIMEOUT_MS) },
  );
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return await resp.json() as RawBuildingEvent[];
}

/**
 * Build a prompt context section describing the atmosphere of the character's
 * current building. Returns empty string if no residue or on error.
 *
 * Token budget: ~300-500 tokens max.
 */
export async function buildBuildingResidueContext(characterId: string): Promise<string> {
  const logger = getLogger();

  try {
    const loc = getCurrentLocation(characterId);
    const building = BUILDING_MAP.get(loc.building);
    if (!building) return '';

    const events = await getBuildingResidue(loc.building, 24);
    if (events.length === 0) return '';

    const now = Date.now();
    const ONE_HOUR = 60 * 60 * 1000;
    const SIX_HOURS = 6 * ONE_HOUR;

    // Categorize by freshness
    const vivid: RawBuildingEvent[] = [];   // < 1h
    const fading: RawBuildingEvent[] = [];  // 1-6h
    const echoes: RawBuildingEvent[] = [];  // 6-24h

    // findings.md P2:1461 — the self-exclusion filter used to be
    // case-sensitive (`e.actors.includes(characterId)`). With
    // characterIds flowing from env vars, the manifest, and per-
    // module conventions, case drift between writer and reader is
    // plausible — and when it happens a character perceives their
    // own arrival/departure traces as if another character did them.
    // Normalize both sides at read time.
    const selfLower = characterId.toLowerCase();
    for (const e of events) {
      if (e.actors.some((a) => a.toLowerCase() === selfLower)) continue;

      const age = now - e.created_at;
      if (age < ONE_HOUR) vivid.push(e);
      else if (age < SIX_HOURS) fading.push(e);
      else echoes.push(e);
    }

    // Cap entries to stay within token budget
    const lines: string[] = [];
    for (const e of vivid.slice(0, 3)) {
      lines.push(`[Vivid — just now] ${e.summary}`);
    }
    for (const e of fading.slice(0, 2)) {
      lines.push(`[Fading — a few hours ago] ${e.summary}`);
    }
    for (const e of echoes.slice(0, 1)) {
      lines.push(`[Echo — yesterday] ${e.summary}`);
    }

    if (lines.length === 0) return '';

    return '\n\n---\n\n## The Atmosphere Here\n\n' +
      `You are at the ${building.name}. You sense traces of what has happened in this place recently.\n\n` +
      lines.join('\n');
  } catch (err) {
    logger.debug({ err }, 'Failed to build building residue context');
    return '';
  }
}

/**
 * Store a building event directly in the local database (for Wired Lain's server).
 */
export function storeBuildingEventLocal(
  db: import('better-sqlite3').Database,
  event: BuildingEvent
): void {
  db.prepare(
    `INSERT OR IGNORE INTO building_events (id, building, event_type, summary, emotional_tone, actors, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    event.id,
    event.building,
    event.event_type,
    event.summary,
    event.emotional_tone,
    JSON.stringify(event.actors),
    event.created_at
  );
}

/**
 * findings.md P2:1473 — prune-on-read moved out of queryBuildingEvents.
 *
 * The DELETE used to run on every read call; each residue query then:
 *  - added a write to every read,
 *  - took the SQLite write lock, blocking concurrent readers AND
 *    concurrent writers (storeBuildingEventLocal),
 *  - wasted CPU re-running the same DELETE every few seconds.
 *
 * Now callers schedule `startBuildingMemoryPruneLoop` (see below) and
 * the query path is read-only. Exposed for tests and for opportunistic
 * pruning from the HTTP POST handler.
 */
const RETENTION_HOURS = 48;

export function pruneBuildingEvents(
  db: import('better-sqlite3').Database,
  retentionHours = RETENTION_HOURS,
): number {
  const threshold = Date.now() - retentionHours * 60 * 60 * 1000;
  const info = db.prepare('DELETE FROM building_events WHERE created_at < ?').run(threshold);
  return Number(info.changes ?? 0);
}

/**
 * Start a periodic prune loop on the provided DB. Returns a stop function.
 * Intended to be called once at process startup — typically on Wired Lain
 * (where the centralized building_events table lives), though it is safe
 * and cheap on other character DBs whose tables stay empty.
 */
export function startBuildingMemoryPruneLoop(
  db: import('better-sqlite3').Database,
  intervalMs = 60 * 60 * 1000, // 1 hour is plenty for 48h retention
): () => void {
  const log = getLogger();
  let stopped = false;
  const tick = (): void => {
    if (stopped) return;
    try {
      const removed = pruneBuildingEvents(db);
      if (removed > 0) {
        log.debug({ removed }, 'building-memory: pruned expired events');
      }
    } catch (err) {
      log.warn({ err }, 'building-memory: prune failed');
    }
  };
  const timer = setInterval(tick, intervalMs);
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * Query building events from the local database (for Wired Lain's server).
 * Read-only — pruning runs on its own cadence (see startBuildingMemoryPruneLoop).
 */
export function queryBuildingEvents(
  db: import('better-sqlite3').Database,
  building: string,
  hours = 24
): BuildingEvent[] {
  // Give callers a tiny wall-clock tolerance around the boundary. These
  // traces are atmospheric, so including an event that is milliseconds past
  // the cutoff is better than dropping a just-inside event during a slow read.
  const since = Date.now() - hours * 60 * 60 * 1000 - 1000;

  const rows = db.prepare(
    `SELECT id, building, event_type, summary, emotional_tone, actors, created_at
     FROM building_events
     WHERE building = ? AND created_at >= ?
     ORDER BY created_at DESC
     LIMIT 20`
  ).all(building, since) as Array<{
    id: string;
    building: string;
    event_type: string;
    summary: string;
    emotional_tone: number;
    actors: string;
    created_at: number;
  }>;

  return rows.map((r) => ({
    id: r.id,
    building: r.building,
    event_type: r.event_type as BuildingEvent['event_type'],
    summary: r.summary,
    emotional_tone: r.emotional_tone,
    actors: JSON.parse(r.actors) as string[],
    created_at: r.created_at,
  }));
}
