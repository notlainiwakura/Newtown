/**
 * Town Events — admin-triggered events that affect all inhabitants.
 *
 * Events can be narrative (injected as context), mechanical (block buildings,
 * force relocations, change weather), or both. They can be instant (fire once)
 * or persistent (last until expired or manually ended).
 */

import { nanoid } from 'nanoid';
import { getDatabase } from '../storage/database.js';
import { getLogger } from '../utils/logger.js';

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

  // Ensure source column exists (lazy migration)
  try {
    db.prepare('ALTER TABLE town_events ADD COLUMN source TEXT').run();
  } catch { /* column already exists */ }

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

const INHABITANT_PORTS = [
  { id: 'neo', name: 'Neo', port: 3003 },
  { id: 'plato', name: 'Plato', port: 3004 },
  { id: 'joe', name: 'Joe', port: 3005 },
];

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

  for (const inhabitant of INHABITANT_PORTS) {
    const interlinkToken = process.env['LAIN_INTERLINK_TOKEN'] || '';
    fetch(`http://localhost:${inhabitant.port}/api/peer/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${interlinkToken}` },
      body: JSON.stringify({
        fromId: 'town',
        fromName: 'The Town',
        message,
        timestamp: Date.now(),
      }),
      signal: AbortSignal.timeout(10000),
    })
      .then(() => logger.debug({ inhabitant: inhabitant.id }, 'Notified inhabitant of town event'))
      .catch(() => logger.debug({ inhabitant: inhabitant.id }, 'Could not notify inhabitant of town event'));
  }
}

export function getActiveTownEvents(): TownEvent[] {
  const db = getDatabase();
  const now = Date.now();

  // Ensure source column exists (lazy migration)
  try {
    db.prepare('ALTER TABLE town_events ADD COLUMN source TEXT').run();
  } catch { /* column already exists */ }

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
 * Merge all active mechanical events' effects into a single object.
 * Blocked buildings are unioned, last force_location wins, last weather wins.
 */
export function getActiveEffects(): EventEffects {
  const events = getActiveTownEvents().filter((e) => e.mechanical);
  const merged: EventEffects = {};
  const blocked = new Set<string>();

  for (const e of events) {
    if (e.effects.blockedBuildings) {
      for (const b of e.effects.blockedBuildings) blocked.add(b);
    }
    if (e.effects.forceLocation) merged.forceLocation = e.effects.forceLocation;
    if (e.effects.weather) merged.weather = e.effects.weather;
  }

  if (blocked.size > 0) merged.blockedBuildings = [...blocked];
  return merged;
}
