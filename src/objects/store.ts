/**
 * Persistent object store for the Laintown world.
 * Objects exist in buildings (on the ground) or in character inventories.
 * Wired Lain's DB is the canonical registry; all characters query via HTTP.
 */

import { nanoid } from 'nanoid';
import { query, queryOne, execute, transaction } from '../storage/database.js';
import { getLogger } from '../utils/logger.js';

const warnedCorruptMetadata = new Set<string>();
export const DEFAULT_GROUND_OBJECT_TTL_HOURS = 72;
export const DEFAULT_GROUND_OBJECT_TTL_MS = DEFAULT_GROUND_OBJECT_TTL_HOURS * 60 * 60 * 1000;
export const OBJECT_EXPIRY_BATCH_SIZE = 500;

function getGroundObjectTtlMs(): number | null {
  const raw = process.env['LAIN_OBJECT_TTL_HOURS'];
  if (!raw) return DEFAULT_GROUND_OBJECT_TTL_MS;
  const normalized = raw.trim().toLowerCase();
  if (normalized === '0' || normalized === 'off' || normalized === 'false' || normalized === 'never') {
    return null;
  }
  const hours = Number(normalized);
  if (!Number.isFinite(hours) || hours <= 0) {
    getLogger().warn(
      { value: raw, defaultHours: DEFAULT_GROUND_OBJECT_TTL_HOURS },
      'objects/store: invalid LAIN_OBJECT_TTL_HOURS, using default',
    );
    return DEFAULT_GROUND_OBJECT_TTL_MS;
  }
  return hours * 60 * 60 * 1000;
}

function parseMetadata(raw: string | null | undefined, objectId: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch (err) {
    if (!warnedCorruptMetadata.has(objectId)) {
      warnedCorruptMetadata.add(objectId);
      getLogger().warn(
        { err: String(err), objectId, rawPrefix: raw.slice(0, 64) },
        'objects/store: corrupt metadata JSON — falling back to empty object',
      );
    }
    return {};
  }
}

export interface WorldObject {
  id: string;
  name: string;
  description: string;
  creatorId: string;
  creatorName: string;
  ownerId: string | null;
  ownerName: string | null;
  location: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  metadata: Record<string, unknown>;
}

interface ObjectRow {
  id: string;
  name: string;
  description: string;
  creator_id: string;
  creator_name: string;
  owner_id: string | null;
  owner_name: string | null;
  location: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
  metadata: string;
}

function rowToObject(row: ObjectRow): WorldObject {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    creatorId: row.creator_id,
    creatorName: row.creator_name,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    location: row.location,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at ?? null,
    metadata: parseMetadata(row.metadata, row.id),
  };
}

/**
 * findings.md P2:3334 — `metadata.fixture` lets any caller mint an
 * un-destructible, un-movable object. Strip it at the store layer so only
 * explicit system seeders (isSystem: true) can produce fixtures.
 */
function sanitizeMetadata(
  metadata: Record<string, unknown> | undefined,
  isSystem: boolean,
): Record<string, unknown> {
  if (!metadata) return {};
  if (isSystem) return metadata;
  if (!('fixture' in metadata)) return metadata;
  const { fixture: _stripped, ...rest } = metadata;
  getLogger().warn(
    { metadataKeys: Object.keys(metadata) },
    'objects/store: stripped metadata.fixture from non-system createObject call',
  );
  return rest;
}

function isFixtureMetadata(metadata: Record<string, unknown>): boolean {
  return metadata['fixture'] === true;
}

function computeGroundObjectExpiresAt(
  metadata: Record<string, unknown>,
  now: number,
  options?: { expiresAt?: number | null; ttlMs?: number | null }
): number | null {
  if (isFixtureMetadata(metadata)) return null;
  if (options && 'expiresAt' in options) return options.expiresAt ?? null;

  const ttlMs = options && 'ttlMs' in options ? options.ttlMs : getGroundObjectTtlMs();
  if (ttlMs === null) return null;
  return now + ttlMs;
}

/**
 * findings.md P2:3364 — append-only audit trail for every object state
 * transition. Survives DELETE of the underlying row (no FK) so destroyed
 * objects still have a recoverable history.
 */
export interface ObjectEvent {
  id: string;
  objectId: string;
  eventType: 'create' | 'pickup' | 'drop' | 'transfer' | 'destroy' | 'expire';
  actorId: string;
  actorName: string | null;
  subjectId: string | null;
  subjectName: string | null;
  location: string | null;
  metadata: Record<string, unknown>;
  createdAt: number;
}

interface ObjectEventRow {
  id: string;
  object_id: string;
  event_type: string;
  actor_id: string;
  actor_name: string | null;
  subject_id: string | null;
  subject_name: string | null;
  location: string | null;
  metadata: string;
  created_at: number;
}

function rowToEvent(row: ObjectEventRow): ObjectEvent {
  return {
    id: row.id,
    objectId: row.object_id,
    eventType: row.event_type as ObjectEvent['eventType'],
    actorId: row.actor_id,
    actorName: row.actor_name,
    subjectId: row.subject_id,
    subjectName: row.subject_name,
    location: row.location,
    metadata: parseMetadata(row.metadata, row.id),
    createdAt: row.created_at,
  };
}

function logObjectEvent(event: Omit<ObjectEvent, 'id' | 'createdAt'> & { createdAt?: number }): void {
  execute(
    `INSERT INTO object_events (id, object_id, event_type, actor_id, actor_name, subject_id, subject_name, location, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      nanoid(16),
      event.objectId,
      event.eventType,
      event.actorId,
      event.actorName,
      event.subjectId,
      event.subjectName,
      event.location,
      JSON.stringify(event.metadata ?? {}),
      event.createdAt ?? Date.now(),
    ]
  );
}

/** Create a new object on the ground at a location. */
export function createObject(
  name: string,
  description: string,
  creatorId: string,
  creatorName: string,
  location: string,
  metadata?: Record<string, unknown>,
  options?: { isSystem?: boolean; expiresAt?: number | null; ttlMs?: number | null; now?: number }
): WorldObject {
  const id = nanoid(16);
  const now = options?.now ?? Date.now();
  const safeMetadata = sanitizeMetadata(metadata, options?.isSystem === true);
  const expiresAt = computeGroundObjectExpiresAt(safeMetadata, now, options);
  transaction(() => {
    execute(
      `INSERT INTO objects (id, name, description, creator_id, creator_name, owner_id, owner_name, location, created_at, updated_at, expires_at, metadata)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
      [id, name, description, creatorId, creatorName, location, now, now, expiresAt, JSON.stringify(safeMetadata)]
    );
    logObjectEvent({
      objectId: id,
      eventType: 'create',
      actorId: creatorId,
      actorName: creatorName,
      subjectId: null,
      subjectName: null,
      location,
      metadata: { name, description, expiresAt },
      createdAt: now,
    });
  });
  return {
    id, name, description, creatorId, creatorName,
    ownerId: null, ownerName: null, location,
    createdAt: now, updatedAt: now, expiresAt, metadata: safeMetadata,
  };
}

/** Get a single object by ID. */
export function getObject(id: string): WorldObject | null {
  const row = queryOne<ObjectRow>('SELECT * FROM objects WHERE id = ?', [id]);
  return row ? rowToObject(row) : null;
}

/** Get all objects at a building (on the ground, unowned). */
export function getObjectsByLocation(buildingId: string): WorldObject[] {
  const now = Date.now();
  const rows = query<ObjectRow>(
    `SELECT * FROM objects
     WHERE location = ?
       AND owner_id IS NULL
       AND (expires_at IS NULL OR expires_at > ?)
     ORDER BY created_at DESC`,
    [buildingId, now]
  );
  return rows.map(rowToObject);
}

/** Get all objects owned by a character (inventory). */
export function getObjectsByOwner(ownerId: string): WorldObject[] {
  const rows = query<ObjectRow>(
    'SELECT * FROM objects WHERE owner_id = ? ORDER BY created_at DESC',
    [ownerId]
  );
  return rows.map(rowToObject);
}

/**
 * findings.md P2:3354 — unbounded `SELECT *` on a growing table. Default
 * cap prevents a dashboard fetch from pulling thousands of rows.
 */
export const DEFAULT_OBJECT_PAGE_SIZE = 500;
export const MAX_OBJECT_PAGE_SIZE = 1000;

/** Get all objects in the world, capped at DEFAULT_OBJECT_PAGE_SIZE for safety. */
export function getAllObjects(): WorldObject[] {
  const now = Date.now();
  const rows = query<ObjectRow>(
    `SELECT * FROM objects
     WHERE owner_id IS NOT NULL OR expires_at IS NULL OR expires_at > ?
     ORDER BY updated_at DESC, id DESC LIMIT ?`,
    [now, DEFAULT_OBJECT_PAGE_SIZE]
  );
  return rows.map(rowToObject);
}

/**
 * Paginated list of all objects. Cursor encodes `<updated_at>:<id>` of the
 * last-seen row; pass it back to fetch the next page. Stable because
 * (updated_at, id) is a total order.
 */
export function listObjectsPage(
  options: { limit?: number; cursor?: string | null } = {}
): { objects: WorldObject[]; nextCursor: string | null } {
  const requested = options.limit ?? DEFAULT_OBJECT_PAGE_SIZE;
  const limit = Math.max(1, Math.min(requested, MAX_OBJECT_PAGE_SIZE));

  let rows: ObjectRow[];
  const now = Date.now();
  const liveWhere = 'owner_id IS NOT NULL OR expires_at IS NULL OR expires_at > ?';
  if (options.cursor) {
    const [updatedAtStr, lastId] = options.cursor.split(':', 2);
    const updatedAt = Number(updatedAtStr);
    if (!Number.isFinite(updatedAt) || !lastId) {
      rows = query<ObjectRow>(
        `SELECT * FROM objects
         WHERE ${liveWhere}
         ORDER BY updated_at DESC, id DESC LIMIT ?`,
        [now, limit + 1]
      );
    } else {
      rows = query<ObjectRow>(
        `SELECT * FROM objects
         WHERE (${liveWhere})
           AND ((updated_at < ?) OR (updated_at = ? AND id < ?))
         ORDER BY updated_at DESC, id DESC LIMIT ?`,
        [now, updatedAt, updatedAt, lastId, limit + 1]
      );
    }
  } else {
    rows = query<ObjectRow>(
      `SELECT * FROM objects
       WHERE ${liveWhere}
       ORDER BY updated_at DESC, id DESC LIMIT ?`,
      [now, limit + 1]
    );
  }

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? `${last.updated_at}:${last.id}` : null;
  return { objects: page.map(rowToObject), nextCursor };
}

/** Pick up an object from the ground into a character's inventory. Returns false if already owned. */
export function pickupObject(objectId: string, ownerId: string, ownerName: string): boolean {
  return transaction(() => {
    const prior = queryOne<ObjectRow>('SELECT * FROM objects WHERE id = ?', [objectId]);
    const now = Date.now();
    const result = execute(
      `UPDATE objects
       SET owner_id = ?, owner_name = ?, location = NULL, expires_at = NULL, updated_at = ?
       WHERE id = ?
         AND owner_id IS NULL
         AND (expires_at IS NULL OR expires_at > ?)`,
      [ownerId, ownerName, now, objectId, now]
    );
    if (result.changes > 0) {
      logObjectEvent({
        objectId,
        eventType: 'pickup',
        actorId: ownerId,
        actorName: ownerName,
        subjectId: null,
        subjectName: null,
        location: prior?.location ?? null,
        metadata: {},
        createdAt: now,
      });
    }
    return result.changes > 0;
  });
}

/** Drop an object from inventory onto the ground at a building. */
export function dropObject(objectId: string, characterId: string, location: string): boolean {
  return transaction(() => {
    const prior = queryOne<ObjectRow>('SELECT * FROM objects WHERE id = ?', [objectId]);
    const now = Date.now();
    const metadata = prior ? parseMetadata(prior.metadata, prior.id) : {};
    const expiresAt = computeGroundObjectExpiresAt(metadata, now);
    const result = execute(
      `UPDATE objects SET owner_id = NULL, owner_name = NULL, location = ?, expires_at = ?, updated_at = ?
       WHERE id = ? AND owner_id = ?`,
      [location, expiresAt, now, objectId, characterId]
    );
    if (result.changes > 0) {
      logObjectEvent({
        objectId,
        eventType: 'drop',
        actorId: characterId,
        actorName: prior?.owner_name ?? null,
        subjectId: null,
        subjectName: null,
        location,
        metadata: { expiresAt },
        createdAt: now,
      });
    }
    return result.changes > 0;
  });
}

/** Transfer an object from one character to another. */
export function transferObject(objectId: string, fromId: string, toId: string, toName: string): boolean {
  return transaction(() => {
    const prior = queryOne<ObjectRow>('SELECT * FROM objects WHERE id = ?', [objectId]);
    const now = Date.now();
    const result = execute(
      `UPDATE objects SET owner_id = ?, owner_name = ?, expires_at = NULL, updated_at = ?
       WHERE id = ? AND owner_id = ?`,
      [toId, toName, now, objectId, fromId]
    );
    if (result.changes > 0) {
      logObjectEvent({
        objectId,
        eventType: 'transfer',
        actorId: fromId,
        actorName: prior?.owner_name ?? null,
        subjectId: toId,
        subjectName: toName,
        location: null,
        metadata: {},
        createdAt: now,
      });
    }
    return result.changes > 0;
  });
}

/** Destroy an object. Only the owner (or creator if unowned) can destroy it. */
export function destroyObject(objectId: string, characterId: string): boolean {
  return transaction(() => {
    const prior = queryOne<ObjectRow>('SELECT * FROM objects WHERE id = ?', [objectId]);
    const now = Date.now();
    const result = execute(
      `DELETE FROM objects WHERE id = ? AND (owner_id = ? OR (owner_id IS NULL AND creator_id = ?))`,
      [objectId, characterId, characterId]
    );
    if (result.changes > 0 && prior) {
      logObjectEvent({
        objectId,
        eventType: 'destroy',
        actorId: characterId,
        actorName: prior.owner_name ?? prior.creator_name,
        subjectId: null,
        subjectName: null,
        location: prior.location,
        metadata: {
          name: prior.name,
          description: prior.description,
          creatorId: prior.creator_id,
          creatorName: prior.creator_name,
          priorOwnerId: prior.owner_id,
          priorOwnerName: prior.owner_name,
        },
        createdAt: now,
      });
    }
    return result.changes > 0;
  });
}

/** Delete expired loose ground objects, keeping fixtures and inventories intact. */
export function expireStaleObjects(
  now = Date.now(),
  limit = OBJECT_EXPIRY_BATCH_SIZE
): number {
  return transaction(() => {
    const candidates = query<ObjectRow>(
      `SELECT * FROM objects
       WHERE owner_id IS NULL
         AND expires_at IS NOT NULL
         AND expires_at <= ?
       ORDER BY expires_at ASC, id ASC
       LIMIT ?`,
      [now, Math.max(1, limit)]
    );

    let expired = 0;
    for (const row of candidates) {
      const metadata = parseMetadata(row.metadata, row.id);
      if (isFixtureMetadata(metadata)) continue;

      const result = execute(
        `DELETE FROM objects
         WHERE id = ?
           AND owner_id IS NULL
           AND expires_at IS NOT NULL
           AND expires_at <= ?`,
        [row.id, now]
      );
      if (result.changes <= 0) continue;

      expired += 1;
      logObjectEvent({
        objectId: row.id,
        eventType: 'expire',
        actorId: 'system',
        actorName: 'Town',
        subjectId: null,
        subjectName: null,
        location: row.location,
        metadata: {
          name: row.name,
          description: row.description,
          creatorId: row.creator_id,
          creatorName: row.creator_name,
          expiresAt: row.expires_at,
        },
        createdAt: now,
      });
    }
    return expired;
  });
}

/** Start the periodic object expiry loop. Returns a stop function. */
export function startObjectExpiryLoop(
  intervalMs = 60 * 60 * 1000,
): () => void {
  const logger = getLogger();
  const tick = (): void => {
    try {
      const expired = expireStaleObjects();
      if (expired > 0) {
        logger.debug({ expired }, 'Expired stale ground objects');
      }
    } catch (error) {
      logger.warn({ error: String(error) }, 'expireStaleObjects failed');
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Read the audit ledger for a single object (newest first). */
export function getObjectEvents(objectId: string, limit = 100): ObjectEvent[] {
  const rows = query<ObjectEventRow>(
    'SELECT * FROM object_events WHERE object_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
    [objectId, limit]
  );
  return rows.map(rowToEvent);
}

/** Read recent audit events across all objects (newest first). */
export function getRecentObjectEvents(limit = 100): ObjectEvent[] {
  const rows = query<ObjectEventRow>(
    'SELECT * FROM object_events ORDER BY created_at DESC, id DESC LIMIT ?',
    [limit]
  );
  return rows.map(rowToEvent);
}

/** Count objects owned by a character. */
export function countByOwner(ownerId: string): number {
  const row = queryOne<{ cnt: number }>(
    'SELECT COUNT(*) as cnt FROM objects WHERE owner_id = ?',
    [ownerId]
  );
  return row?.cnt ?? 0;
}

/** Count objects at a location. */
export function countByLocation(location: string): number {
  const now = Date.now();
  const row = queryOne<{ cnt: number }>(
    `SELECT COUNT(*) as cnt
     FROM objects
     WHERE location = ?
       AND owner_id IS NULL
       AND (expires_at IS NULL OR expires_at > ?)`,
    [location, now]
  );
  return row?.cnt ?? 0;
}

/** Check if an object is a fixture (immovable building furniture). */
export function isFixture(objectId: string): boolean {
  const obj = getObject(objectId);
  if (!obj) return false;
  return isFixtureMetadata(obj.metadata);
}
