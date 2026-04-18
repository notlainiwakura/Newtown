/**
 * Memory Palace — wing and room CRUD, hall assignment, and wing resolution.
 *
 * Wings are top-level groupings (e.g. a person or topic).
 * Rooms are sub-groupings within a wing (e.g. a specific theme or session type).
 * Halls are one of five fixed categories that every memory lands in.
 */

import { nanoid } from 'nanoid';
import { execute, query, queryOne } from '../storage/database.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type Hall = 'truths' | 'encounters' | 'discoveries' | 'dreams' | 'reflections';

export interface Wing {
  id: string;
  name: string;
  description: string | null;
  createdAt: number;
  memoryCount: number;
}

export interface Room {
  id: string;
  wingId: string;
  name: string;
  description: string | null;
  createdAt: number;
  memoryCount: number;
}

// ─── DB row shapes ─────────────────────────────────────────────────────────────

interface WingRow {
  id: string;
  name: string;
  description: string | null;
  created_at: number;
  memory_count: number;
}

interface RoomRow {
  id: string;
  wing_id: string;
  name: string;
  description: string | null;
  created_at: number;
  memory_count: number;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function rowToWing(r: WingRow): Wing {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    createdAt: r.created_at,
    memoryCount: r.memory_count,
  };
}

function rowToRoom(r: RoomRow): Room {
  return {
    id: r.id,
    wingId: r.wing_id,
    name: r.name,
    description: r.description,
    createdAt: r.created_at,
    memoryCount: r.memory_count,
  };
}

// ─── Wing CRUD ─────────────────────────────────────────────────────────────────

/** Create a new wing and return its ID. */
export function createWing(name: string, description?: string): string {
  const id = nanoid(16);
  const now = Date.now();
  execute(
    'INSERT INTO palace_wings (id, name, description, created_at, memory_count) VALUES (?, ?, ?, ?, 0)',
    [id, name, description ?? null, now],
  );
  return id;
}

/** Get a wing by ID. */
export function getWing(id: string): Wing | undefined {
  const row = queryOne<WingRow>('SELECT * FROM palace_wings WHERE id = ?', [id]);
  return row ? rowToWing(row) : undefined;
}

/** Get a wing by name (case-sensitive). */
export function getWingByName(name: string): Wing | undefined {
  const row = queryOne<WingRow>('SELECT * FROM palace_wings WHERE name = ?', [name]);
  return row ? rowToWing(row) : undefined;
}

/** List all wings ordered by creation time. */
export function listWings(): Wing[] {
  const rows = query<WingRow>('SELECT * FROM palace_wings ORDER BY created_at ASC');
  return rows.map(rowToWing);
}

/**
 * Get-or-create a wing by name.
 * If the wing already exists, its ID is returned without modification.
 * If it does not exist, it is created with the optional description.
 */
export function resolveWing(name: string, description?: string): string {
  const existing = getWingByName(name);
  if (existing) return existing.id;
  return createWing(name, description);
}

/** Atomically increment the memory_count for a wing. */
export function incrementWingCount(wingId: string): void {
  execute('UPDATE palace_wings SET memory_count = memory_count + 1 WHERE id = ?', [wingId]);
}

/** Atomically decrement the memory_count for a wing (floor: 0). */
export function decrementWingCount(wingId: string): void {
  execute(
    'UPDATE palace_wings SET memory_count = MAX(0, memory_count - 1) WHERE id = ?',
    [wingId],
  );
}

// ─── Room CRUD ─────────────────────────────────────────────────────────────────

/** Create a new room inside a wing and return its ID. */
export function createRoom(wingId: string, name: string, description?: string): string {
  const id = nanoid(16);
  const now = Date.now();
  execute(
    'INSERT INTO palace_rooms (id, wing_id, name, description, created_at, memory_count) VALUES (?, ?, ?, ?, ?, 0)',
    [id, wingId, name, description ?? null, now],
  );
  return id;
}

/** Get a room by ID. */
export function getRoom(id: string): Room | undefined {
  const row = queryOne<RoomRow>('SELECT * FROM palace_rooms WHERE id = ?', [id]);
  return row ? rowToRoom(row) : undefined;
}

/** Get a room by wing + name. */
export function getRoomByName(wingId: string, name: string): Room | undefined {
  const row = queryOne<RoomRow>(
    'SELECT * FROM palace_rooms WHERE wing_id = ? AND name = ?',
    [wingId, name],
  );
  return row ? rowToRoom(row) : undefined;
}

/** List all rooms for a wing ordered by creation time. */
export function listRooms(wingId: string): Room[] {
  const rows = query<RoomRow>(
    'SELECT * FROM palace_rooms WHERE wing_id = ? ORDER BY created_at ASC',
    [wingId],
  );
  return rows.map(rowToRoom);
}

/**
 * Get-or-create a room within a wing by name.
 * Idempotent: returns the same ID for repeated calls with the same wing+name.
 */
export function resolveRoom(wingId: string, name: string, description?: string): string {
  const existing = getRoomByName(wingId, name);
  if (existing) return existing.id;
  return createRoom(wingId, name, description);
}

/** Atomically increment the memory_count for a room. */
export function incrementRoomCount(roomId: string): void {
  execute('UPDATE palace_rooms SET memory_count = memory_count + 1 WHERE id = ?', [roomId]);
}

/** Atomically decrement the memory_count for a room (floor: 0). */
export function decrementRoomCount(roomId: string): void {
  execute(
    'UPDATE palace_rooms SET memory_count = MAX(0, memory_count - 1) WHERE id = ?',
    [roomId],
  );
}

// ─── Hall assignment ───────────────────────────────────────────────────────────

/**
 * Map a (memoryType, sessionKey) pair to the appropriate Hall.
 *
 * Rules (in priority order):
 *   fact | preference                          → truths
 *   summary                                    → reflections
 *   episode + curiosity:*                      → discoveries
 *   episode + dreams:* | dream:*               → dreams
 *   episode + diary:* | letter:* |
 *             self-concept:* | selfconcept:* |
 *             bibliomancy:*                    → reflections
 *   context                                    → encounters
 *   episode (default)                          → encounters
 */
export function assignHall(
  memoryType: 'fact' | 'preference' | 'context' | 'summary' | 'episode',
  sessionKey: string,
): Hall {
  if (memoryType === 'fact' || memoryType === 'preference') return 'truths';
  if (memoryType === 'summary') return 'reflections';

  if (memoryType === 'episode') {
    const key = sessionKey.toLowerCase();
    if (key.startsWith('curiosity:')) return 'discoveries';
    if (key.startsWith('dreams:') || key.startsWith('dream:')) return 'dreams';
    if (
      key.startsWith('diary:') ||
      key.startsWith('letter:') ||
      key.startsWith('self-concept:') ||
      key.startsWith('selfconcept:') ||
      key.startsWith('bibliomancy:')
    ) {
      return 'reflections';
    }
    // episode default
    return 'encounters';
  }

  // context (and anything else)
  return 'encounters';
}

// ─── Wing resolution for memories ─────────────────────────────────────────────

/**
 * Derive the wing name and description for a memory based on its session key,
 * user ID, and metadata. Does not touch the database — just returns names.
 *
 * Callers should follow up with resolveWing(wingName, wingDescription) to get
 * or create the actual wing ID.
 */
export function resolveWingForMemory(
  sessionKey: string,
  userId: string | null | undefined,
  _metadata?: Record<string, unknown>,
): { wingName: string; wingDescription: string } {
  const key = sessionKey.toLowerCase();

  // ── Internal background loops ──────────────────────────────────────────────
  if (
    key.startsWith('diary:') ||
    key.startsWith('dreams:') ||
    key.startsWith('dream:') ||
    key.startsWith('self-concept:') ||
    key.startsWith('selfconcept:') ||
    key.startsWith('bibliomancy:')
  ) {
    return { wingName: 'self', wingDescription: 'Inner life — diary, dreams, and self-reflection' };
  }

  if (key.startsWith('curiosity:')) {
    return { wingName: 'curiosity', wingDescription: 'Things discovered while browsing and exploring' };
  }

  // ── Inter-inhabitant communication ─────────────────────────────────────────
  if (key.startsWith('letter:')) {
    // e.g. 'letter:wired-lain' → 'wired-lain'
    const target = sessionKey.slice('letter:'.length).trim() || 'unknown';
    return { wingName: target, wingDescription: `Letters and correspondence with ${target}` };
  }

  if (key.startsWith('commune:') || key.startsWith('peer:')) {
    // e.g. 'commune:pkd' or 'peer:mckenna'
    const colonIdx = sessionKey.indexOf(':');
    const target = colonIdx >= 0 ? sessionKey.slice(colonIdx + 1).trim() : 'unknown';
    return { wingName: target, wingDescription: `Encounters and conversations with ${target}` };
  }

  // ── Dr. Claude / therapy ───────────────────────────────────────────────────
  if (key.startsWith('doctor:') || key.startsWith('therapy:')) {
    return { wingName: 'dr-claude', wingDescription: 'Therapy sessions with Dr. Claude' };
  }

  // ── Town life ──────────────────────────────────────────────────────────────
  if (
    key.startsWith('townlife:') ||
    key.startsWith('movement:') ||
    key.startsWith('move:') ||
    key.startsWith('note:') ||
    key.startsWith('object:') ||
    key.startsWith('document:')
  ) {
    return { wingName: 'town', wingDescription: 'Life in Laintown — movements, objects, and notes' };
  }

  // ── Visitor-specific wing ──────────────────────────────────────────────────
  if (userId) {
    return {
      wingName: `visitor-${userId}`,
      wingDescription: `Memories from interactions with visitor ${userId}`,
    };
  }

  // ── Fallback ───────────────────────────────────────────────────────────────
  return { wingName: 'encounters', wingDescription: 'General encounters and conversations' };
}
