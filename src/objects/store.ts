/**
 * Persistent object store for the Laintown world.
 * Objects exist in buildings (on the ground) or in character inventories.
 * Wired Lain's DB is the canonical registry; all characters query via HTTP.
 */

import { nanoid } from 'nanoid';
import { query, queryOne, execute, transaction } from '../storage/database.js';

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
    metadata: JSON.parse(row.metadata || '{}') as Record<string, unknown>,
  };
}

/** Create a new object on the ground at a location. */
export function createObject(
  name: string,
  description: string,
  creatorId: string,
  creatorName: string,
  location: string,
  metadata?: Record<string, unknown>
): WorldObject {
  const id = nanoid(16);
  const now = Date.now();
  execute(
    `INSERT INTO objects (id, name, description, creator_id, creator_name, owner_id, owner_name, location, created_at, updated_at, metadata)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
    [id, name, description, creatorId, creatorName, location, now, now, JSON.stringify(metadata ?? {})]
  );
  return {
    id, name, description, creatorId, creatorName,
    ownerId: null, ownerName: null, location,
    createdAt: now, updatedAt: now, metadata: metadata ?? {},
  };
}

/** Get a single object by ID. */
export function getObject(id: string): WorldObject | null {
  const row = queryOne<ObjectRow>('SELECT * FROM objects WHERE id = ?', [id]);
  return row ? rowToObject(row) : null;
}

/** Get all objects at a building (on the ground, unowned). */
export function getObjectsByLocation(buildingId: string): WorldObject[] {
  const rows = query<ObjectRow>(
    'SELECT * FROM objects WHERE location = ? AND owner_id IS NULL ORDER BY created_at DESC',
    [buildingId]
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

/** Get all objects in the world. */
export function getAllObjects(): WorldObject[] {
  const rows = query<ObjectRow>('SELECT * FROM objects ORDER BY updated_at DESC');
  return rows.map(rowToObject);
}

/** Pick up an object from the ground into a character's inventory. Returns false if already owned. */
export function pickupObject(objectId: string, ownerId: string, ownerName: string): boolean {
  return transaction(() => {
    const result = execute(
      `UPDATE objects SET owner_id = ?, owner_name = ?, location = NULL, updated_at = ?
       WHERE id = ? AND owner_id IS NULL`,
      [ownerId, ownerName, Date.now(), objectId]
    );
    return result.changes > 0;
  });
}

/** Drop an object from inventory onto the ground at a building. */
export function dropObject(objectId: string, characterId: string, location: string): boolean {
  return transaction(() => {
    const result = execute(
      `UPDATE objects SET owner_id = NULL, owner_name = NULL, location = ?, updated_at = ?
       WHERE id = ? AND owner_id = ?`,
      [location, Date.now(), objectId, characterId]
    );
    return result.changes > 0;
  });
}

/** Transfer an object from one character to another. */
export function transferObject(objectId: string, fromId: string, toId: string, toName: string): boolean {
  return transaction(() => {
    const result = execute(
      `UPDATE objects SET owner_id = ?, owner_name = ?, updated_at = ?
       WHERE id = ? AND owner_id = ?`,
      [toId, toName, Date.now(), objectId, fromId]
    );
    return result.changes > 0;
  });
}

/** Destroy an object. Only the owner (or creator if unowned) can destroy it. */
export function destroyObject(objectId: string, characterId: string): boolean {
  return transaction(() => {
    const result = execute(
      `DELETE FROM objects WHERE id = ? AND (owner_id = ? OR (owner_id IS NULL AND creator_id = ?))`,
      [objectId, characterId, characterId]
    );
    return result.changes > 0;
  });
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
  const row = queryOne<{ cnt: number }>(
    'SELECT COUNT(*) as cnt FROM objects WHERE location = ? AND owner_id IS NULL',
    [location]
  );
  return row?.cnt ?? 0;
}

/** Check if an object is a fixture (immovable building furniture). */
export function isFixture(objectId: string): boolean {
  const obj = getObject(objectId);
  if (!obj) return false;
  return obj.metadata['fixture'] === true;
}
