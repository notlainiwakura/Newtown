/**
 * Town Events — admin-triggered events that affect all inhabitants.
 *
 * Events can be narrative (injected as context), mechanical (block buildings,
 * force relocations, change weather), or both. They can be instant (fire once)
 * or persistent (last until expired or manually ended).
 */

import { nanoid } from 'nanoid';
import { getInhabitants } from '../config/characters.js';
import { getDatabase } from '../storage/database.js';
import { getLogger } from '../utils/logger.js';
import { getInterlinkHeaders } from '../security/interlink-auth.js';

export interface TownEvent {
  id: string;
  description: string;
  narrative: boolean;
  mechanical: boolean;
  instant: boolean;
  persistent: boolean;
  natural: boolean;
  liminal: boolean;
  source: 'admin' | 'novelty' | 'system' | null;
  effects: EventEffects;
  status: 'active' | 'ended';
  createdAt: number;
  expiresAt: number | null;
  endedAt: number | null;
}

export interface EventEffects {
  blockedBuildings?: string[];
  forceLocation?: string;
  weather?: string;
}

interface TownEventRow {
  id: string;
  description: string;
  narrative: number;
  mechanical: number;
  instant: number;
  persistent: number;
  natural_event: number;
  liminal: number;
  source: string | null;
  effects: string;
  status: string;
  created_at: number;
  expires_at: number | null;
  ended_at: number | null;
}

function rowToEvent(row: TownEventRow): TownEvent {
  let effects: EventEffects = {};
  try { effects = JSON.parse(row.effects); } catch { /* empty */ }
  return {
    id: row.id,
    description: row.description,
    narrative: row.narrative === 1,
    mechanical: row.mechanical === 1,
    instant: row.instant === 1,
    persistent: row.persistent === 1,
    natural: row.natural_event === 1,
    liminal: row.liminal === 1,
    source: (row.source as TownEvent['source']) ?? null,
    effects,
    status: row.status as 'active' | 'ended',
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    endedAt: row.ended_at,
  };
}

export interface CreateEventParams {
  description: string;
  narrative?: boolean;
  mechanical?: boolean;
  instant?: boolean;
  persistent?: boolean;
  natural?: boolean;
  liminal?: boolean;
  source?: 'admin' | 'novelty' | 'system';
  effects?: EventEffects;
  expiresInMs?: number;
}

export function createTownEvent(params: CreateEventParams): TownEvent {
  const db = getDatabase();
  const id = nanoid(16);
  const now = Date.now();
  const isInstant = params.instant === true;
  const INSTANT_WINDOW_MS = 30 * 60 * 1000;
  const ADMIN_DEFAULT_MS = 72 * 60 * 60 * 1000; // 72 hours for admin events

  // findings.md P2:275 — the `source` column is now created by schema v13
  // in src/storage/database.ts; the per-call lazy ALTER TABLE is gone.

  const expiresAt = params.expiresInMs ? now + params.expiresInMs
    : isInstant ? now + INSTANT_WINDOW_MS
    : params.source === 'admin' ? now + ADMIN_DEFAULT_MS
    : null;

  db.prepare(`
    INSERT INTO town_events (id, description, narrative, mechanical, instant, persistent,
      natural_event, liminal, source, effects, status, created_at, expires_at, ended_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    params.description,
    params.narrative ? 1 : 0,
    params.mechanical ? 1 : 0,
    isInstant ? 1 : 0,
    params.persistent ? 1 : 0,
    params.natural ? 1 : 0,
    params.liminal ? 1 : 0,
    params.source ?? null,
    JSON.stringify(params.effects || {}),
    'active',
    now,
    expiresAt,
    null,
  );

  const event: TownEvent = {
    id,
    description: params.description,
    narrative: params.narrative ?? false,
    mechanical: params.mechanical ?? false,
    instant: isInstant,
    persistent: params.persistent ?? false,
    natural: params.natural ?? false,
    liminal: params.liminal ?? false,
    source: params.source ?? null,
    effects: params.effects || {},
    status: 'active',
    createdAt: now,
    expiresAt,
    endedAt: null,
  };

  // Actively notify all inhabitants so they react even if their loops don't fire
  notifyInhabitants(event);

  return event;
}

// ── Inhabitant notification ──────────────────────────────────

// findings.md P2:263 — missing-config and per-peer failures used to log at
// `debug`, which is invisible under the default `info` level. An admin
// fired a town event and zero inhabitants saw it, with no actionable
// signal in the logs. We now warn-once on missing config and warn per
// failed peer with id + status so operators can see the breakage.
let _warnedInterlinkMissing = false;

/** Test-only hook: rearm the warn-once guard. */
export function _resetInterlinkWarnForTests(): void {
  _warnedInterlinkMissing = false;
}

/**
 * Notify all inhabitants of a new town event via peer messages.
 * This ensures they react even if their loops don't fire during the event window.
 * Runs asynchronously — does not block event creation.
 */
function notifyInhabitants(event: TownEvent): void {
  const logger = getLogger();

  const tags: string[] = [];
  if (event.instant) tags.push('flash');
  if (event.natural) tags.push('natural');
  if (event.liminal) tags.push('liminal');
  if (event.persistent) tags.push('ongoing');
  if (event.source === 'admin') tags.push('important');
  const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';

  const message = `[something is happening in the town${tagStr}] ${event.description}`;

  const headers = getInterlinkHeaders();
  const fromId = process.env['LAIN_CHARACTER_ID'];
  if (!headers || !fromId) {
    if (!_warnedInterlinkMissing) {
      _warnedInterlinkMissing = true;
      logger.warn(
        {
          eventId: event.id,
          hasInterlinkToken: !!process.env['LAIN_INTERLINK_TOKEN'],
          hasCharacterId: !!fromId,
        },
        'Town event notification skipped: interlink is not configured — set LAIN_INTERLINK_TOKEN and LAIN_CHARACTER_ID. Inhabitants will not receive active pushes.',
      );
    }
    return;
  }

  // Body fromId is bound to authenticated character (the process creating the
  // event — e.g. wired-lain). fromName carries the display framing.
  for (const inhabitant of getInhabitants()) {
    fetch(`http://localhost:${inhabitant.port}/api/peer/message`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        fromId,
        fromName: 'The Town',
        message,
        timestamp: Date.now(),
      }),
      signal: AbortSignal.timeout(10000),
    })
      .then((res) => {
        if (res.ok) {
          logger.debug({ inhabitant: inhabitant.id, status: res.status }, 'Notified inhabitant of town event');
        } else {
          logger.warn(
            { inhabitant: inhabitant.id, status: res.status, eventId: event.id },
            'Town event notification rejected by inhabitant',
          );
        }
      })
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        logger.warn(
          { inhabitant: inhabitant.id, reason, eventId: event.id },
          'Could not notify inhabitant of town event',
        );
      });
  }
}

export function getActiveTownEvents(): TownEvent[] {
  const db = getDatabase();
  const now = Date.now();

  // findings.md P2:275 — `source` is promoted to schema v13; no lazy ALTER.

  const rows = db.prepare(`
    SELECT * FROM town_events
    WHERE status = 'active' AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY created_at DESC
  `).all(now) as TownEventRow[];
  return rows.map(rowToEvent);
}

export function getAllTownEvents(limit = 50): TownEvent[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM town_events ORDER BY created_at DESC LIMIT ?
  `).all(limit) as TownEventRow[];
  return rows.map(rowToEvent);
}

export function endTownEvent(id: string): boolean {
  const db = getDatabase();
  const result = db.prepare(`
    UPDATE town_events SET status = 'ended', ended_at = ? WHERE id = ? AND status = 'active'
  `).run(Date.now(), id);
  return result.changes > 0;
}

export function expireStaleEvents(): number {
  const db = getDatabase();
  const now = Date.now();
  const result = db.prepare(`
    UPDATE town_events SET status = 'ended', ended_at = ?
    WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?
  `).run(now, now);
  return result.changes;
}

/**
 * findings.md P2:285 — `getActiveTownEvents()` filters expired rows out of
 * query results, but nothing transitions them to `status='ended'` on disk.
 * Every process that can write town_events (web server, character servers
 * via agent/novelty.ts and agent/evolution.ts) therefore accumulated
 * zombie `active` rows over time. This helper owns the timer so both
 * servers share the same 5-minute cadence and handle cleanup uniformly.
 *
 * Returns a stop fn that callers plug into their shutdown path.
 */
export function startExpireStaleEventsLoop(
  intervalMs = 5 * 60 * 1000,
): () => void {
  const logger = getLogger();
  const timer = setInterval(() => {
    try {
      const expired = expireStaleEvents();
      if (expired > 0) {
        logger.debug({ expired }, 'Expired stale town events');
      }
    } catch (error) {
      logger.warn({ error: String(error) }, 'expireStaleEvents failed');
    }
  }, intervalMs);
  // Don't keep the process alive on this timer alone.
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Merge all active mechanical events' effects into a single object.
 * Blocked buildings are unioned. forceLocation / weather resolve to the
 * NEWEST event's value — getActiveTownEvents() returns DESC, so iterate
 * oldest-first and let the newest (last) assignment win.
 */
export function getActiveEffects(): EventEffects {
  const events = getActiveTownEvents().filter((e) => e.mechanical);
  const merged: EventEffects = {};
  const blocked = new Set<string>();

  // getActiveTownEvents() returns newest-first (ORDER BY created_at DESC).
  // Iterate in reverse so the newest event's forceLocation/weather is the
  // final assignment — matching operator intent.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.effects.blockedBuildings) {
      for (const b of e.effects.blockedBuildings) blocked.add(b);
    }
    if (e.effects.forceLocation) merged.forceLocation = e.effects.forceLocation;
    if (e.effects.weather) merged.weather = e.effects.weather;
  }

  if (blocked.size > 0) merged.blockedBuildings = [...blocked];
  return merged;
}
