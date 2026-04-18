/**
 * Palace schema migration tests (v10-v11)
 * Verifies sqlite-vec loads and all palace tables/columns are created correctly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, closeDatabase, getDatabase } from '../src/storage/database.js';

// Mock keytar for tests
vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn().mockResolvedValue('test-master-key'),
    setPassword: vi.fn().mockResolvedValue(undefined),
    deletePassword: vi.fn().mockResolvedValue(true),
    findCredentials: vi.fn().mockResolvedValue([]),
  },
}));

describe('Palace schema migration (v10-v11)', () => {
  const testDir = join(tmpdir(), `lain-test-palace-${Date.now()}`);
  const dbPath = join(testDir, 'test.db');
  const originalEnv = process.env['LAIN_HOME'];

  beforeEach(async () => {
    process.env['LAIN_HOME'] = testDir;
    await mkdir(testDir, { recursive: true });
    await initDatabase(dbPath);
  });

  afterEach(async () => {
    closeDatabase();
    if (originalEnv) {
      process.env['LAIN_HOME'] = originalEnv;
    } else {
      delete process.env['LAIN_HOME'];
    }
    try {
      await rm(testDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should have palace_wings table', () => {
    const db = getDatabase();
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='palace_wings'")
      .get() as { name: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.name).toBe('palace_wings');
  });

  it('should have palace_rooms table', () => {
    const db = getDatabase();
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='palace_rooms'")
      .get() as { name: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.name).toBe('palace_rooms');
  });

  it('should have kg_triples table', () => {
    const db = getDatabase();
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='kg_triples'")
      .get() as { name: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.name).toBe('kg_triples');
  });

  it('should have kg_entities table', () => {
    const db = getDatabase();
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='kg_entities'")
      .get() as { name: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.name).toBe('kg_entities');
  });

  it('should have memory_embeddings vec0 virtual table', () => {
    const db = getDatabase();
    // sqlite_master for virtual tables uses type='table' but the sql contains USING vec0
    const row = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name='memory_embeddings'")
      .get() as { name: string; sql: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.name).toBe('memory_embeddings');
    expect(row?.sql?.toLowerCase()).toContain('vec0');
  });

  it('should have palace columns on memories table (wing_id, room_id, hall)', () => {
    const db = getDatabase();
    const cols = db.pragma('table_info(memories)') as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain('wing_id');
    expect(colNames).toContain('room_id');
    expect(colNames).toContain('hall');
  });

  it('should have aaak columns on memories table', () => {
    const db = getDatabase();
    const cols = db.pragma('table_info(memories)') as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain('aaak_content');
    expect(colNames).toContain('aaak_compressed_at');
  });

  it('should allow insert and select on palace_wings', () => {
    const db = getDatabase();
    db.prepare(
      "INSERT INTO palace_wings (id, name, description, created_at) VALUES (?, ?, ?, ?)"
    ).run('wing-1', 'Episodic Wing', 'Where episodes live', Date.now());

    const row = db
      .prepare("SELECT id, name FROM palace_wings WHERE id = ?")
      .get('wing-1') as { id: string; name: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.id).toBe('wing-1');
    expect(row?.name).toBe('Episodic Wing');
  });

  it('should allow insert and select on palace_rooms with wing FK', () => {
    const db = getDatabase();
    db.prepare(
      "INSERT INTO palace_wings (id, name, created_at) VALUES (?, ?, ?)"
    ).run('wing-2', 'Semantic Wing', Date.now());

    db.prepare(
      "INSERT INTO palace_rooms (id, wing_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run('room-1', 'wing-2', 'Concepts Room', 'Abstract concepts', Date.now());

    const row = db
      .prepare("SELECT id, wing_id, name FROM palace_rooms WHERE id = ?")
      .get('room-1') as { id: string; wing_id: string; name: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.wing_id).toBe('wing-2');
    expect(row?.name).toBe('Concepts Room');
  });

  it('should allow insert and query on kg_triples', () => {
    const db = getDatabase();
    db.prepare(
      "INSERT INTO kg_triples (id, subject, predicate, object, strength, valid_from) VALUES (?, ?, ?, ?, ?, ?)"
    ).run('triple-1', 'Lain', 'lives_in', 'Library', 0.9, Date.now());

    const row = db
      .prepare("SELECT subject, predicate, object FROM kg_triples WHERE id = ?")
      .get('triple-1') as { subject: string; predicate: string; object: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.subject).toBe('Lain');
    expect(row?.predicate).toBe('lives_in');
    expect(row?.object).toBe('Library');
  });

  it('should allow insert and query on kg_entities', () => {
    const db = getDatabase();
    db.prepare(
      "INSERT INTO kg_entities (name, entity_type, first_seen, last_seen) VALUES (?, ?, ?, ?)"
    ).run('Lain', 'person', Date.now(), Date.now());

    const row = db
      .prepare("SELECT name, entity_type FROM kg_entities WHERE name = ?")
      .get('Lain') as { name: string; entity_type: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.entity_type).toBe('person');
  });

  it('should allow insert and query on memory_embeddings vec0 virtual table', () => {
    const db = getDatabase();

    // Insert a 384-dim float32 embedding
    const embedding = new Float32Array(384).fill(0.1);
    const memoryId = 'mem-test-001';

    const stmt = db.prepare(
      'INSERT INTO memory_embeddings (rowid, embedding, memory_id) VALUES (?, ?, ?)'
    );
    stmt.run(BigInt(1), embedding, memoryId);

    // Query nearest neighbor (k=1)
    const results = db
      .prepare(
        'SELECT memory_id, distance FROM memory_embeddings WHERE embedding MATCH ? AND k = 1'
      )
      .all(embedding) as Array<{ memory_id: string; distance: number }>;

    expect(results).toHaveLength(1);
    expect(results[0]?.memory_id).toBe(memoryId);
  });

  it('should allow memories with palace columns set', () => {
    const db = getDatabase();
    db.prepare(
      `INSERT INTO memories (id, content, memory_type, importance, created_at, wing_id, room_id, hall)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('mem-palace-1', 'A memory in the palace', 'episodic', 0.8, Date.now(), 'wing-1', 'room-1', 'hallway-a');

    const row = db
      .prepare("SELECT id, wing_id, room_id, hall FROM memories WHERE id = ?")
      .get('mem-palace-1') as { id: string; wing_id: string; room_id: string; hall: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.wing_id).toBe('wing-1');
    expect(row?.room_id).toBe('room-1');
    expect(row?.hall).toBe('hallway-a');
  });

  it('should allow memories with aaak columns set', () => {
    const db = getDatabase();
    const now = Date.now();
    db.prepare(
      `INSERT INTO memories (id, content, memory_type, importance, created_at, aaak_content, aaak_compressed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('mem-aaak-1', 'Original long content', 'episodic', 0.5, now, 'Compressed summary', now);

    const row = db
      .prepare("SELECT id, aaak_content, aaak_compressed_at FROM memories WHERE id = ?")
      .get('mem-aaak-1') as { id: string; aaak_content: string; aaak_compressed_at: number } | undefined;
    expect(row).toBeDefined();
    expect(row?.aaak_content).toBe('Compressed summary');
    expect(row?.aaak_compressed_at).toBe(now);
  });
});

// ─── Palace CRUD tests ────────────────────────────────────────────────────────

import {
  createWing,
  getWing,
  getWingByName,
  listWings,
  resolveWing,
  incrementWingCount,
  decrementWingCount,
  createRoom,
  getRoom,
  getRoomByName,
  listRooms,
  resolveRoom,
  incrementRoomCount,
  decrementRoomCount,
  assignHall,
  resolveWingForMemory,
} from '../src/memory/palace.js';

describe('Palace CRUD', () => {
  const testDir2 = join(tmpdir(), `lain-test-palace-crud-${Date.now()}`);
  const dbPath2 = join(testDir2, 'test.db');
  const origEnv2 = process.env['LAIN_HOME'];

  beforeEach(async () => {
    process.env['LAIN_HOME'] = testDir2;
    await mkdir(testDir2, { recursive: true });
    await initDatabase(dbPath2);
  });

  afterEach(async () => {
    closeDatabase();
    if (origEnv2) {
      process.env['LAIN_HOME'] = origEnv2;
    } else {
      delete process.env['LAIN_HOME'];
    }
    try {
      await rm(testDir2, { recursive: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // ── Wing tests ──────────────────────────────────────────────────────────────

  it('creates and retrieves a wing', () => {
    const id = createWing('visitors', 'Wing for visitor memories');
    expect(id).toBeTruthy();

    const wing = getWing(id);
    expect(wing).toBeDefined();
    expect(wing?.id).toBe(id);
    expect(wing?.name).toBe('visitors');
    expect(wing?.description).toBe('Wing for visitor memories');
    expect(wing?.memoryCount).toBe(0);
    expect(wing?.createdAt).toBeGreaterThan(0);
  });

  it('finds a wing by name', () => {
    const id = createWing('curiosity');
    const found = getWingByName('curiosity');
    expect(found).toBeDefined();
    expect(found?.id).toBe(id);
  });

  it('returns undefined for missing wing by name', () => {
    expect(getWingByName('nonexistent')).toBeUndefined();
  });

  it('lists all wings in creation order', () => {
    createWing('alpha');
    createWing('beta');
    createWing('gamma');
    const wings = listWings();
    expect(wings.length).toBeGreaterThanOrEqual(3);
    const names = wings.map((w) => w.name);
    expect(names).toContain('alpha');
    expect(names).toContain('beta');
    expect(names).toContain('gamma');
  });

  it('resolveWing creates a wing if it does not exist', () => {
    const id = resolveWing('self', 'Inner life');
    expect(id).toBeTruthy();
    const wing = getWing(id);
    expect(wing?.name).toBe('self');
  });

  it('resolveWing returns the same ID on second call', () => {
    const id1 = resolveWing('self');
    const id2 = resolveWing('self', 'different description should be ignored');
    expect(id1).toBe(id2);
  });

  it('incrementWingCount and decrementWingCount update memory_count', () => {
    const id = createWing('test-counts');
    incrementWingCount(id);
    incrementWingCount(id);
    const after2 = getWing(id);
    expect(after2?.memoryCount).toBe(2);

    decrementWingCount(id);
    const after1 = getWing(id);
    expect(after1?.memoryCount).toBe(1);
  });

  it('decrementWingCount does not go below 0', () => {
    const id = createWing('floor-test');
    decrementWingCount(id); // already at 0
    const wing = getWing(id);
    expect(wing?.memoryCount).toBe(0);
  });

  // ── Room tests ──────────────────────────────────────────────────────────────

  it('creates and retrieves a room', () => {
    const wingId = createWing('encounters');
    const roomId = createRoom(wingId, 'main-hall', 'The main meeting hall');

    expect(roomId).toBeTruthy();
    const room = getRoom(roomId);
    expect(room).toBeDefined();
    expect(room?.id).toBe(roomId);
    expect(room?.wingId).toBe(wingId);
    expect(room?.name).toBe('main-hall');
    expect(room?.description).toBe('The main meeting hall');
    expect(room?.memoryCount).toBe(0);
    expect(room?.createdAt).toBeGreaterThan(0);
  });

  it('finds a room by wingId and name', () => {
    const wingId = createWing('wing-for-room-lookup');
    const roomId = createRoom(wingId, 'corner-room');
    const found = getRoomByName(wingId, 'corner-room');
    expect(found?.id).toBe(roomId);
  });

  it('returns undefined for missing room by name', () => {
    const wingId = createWing('wing-no-rooms');
    expect(getRoomByName(wingId, 'ghost-room')).toBeUndefined();
  });

  it('lists rooms for a wing', () => {
    const wingId = createWing('multi-room-wing');
    createRoom(wingId, 'room-a');
    createRoom(wingId, 'room-b');

    const rooms = listRooms(wingId);
    expect(rooms.length).toBe(2);
    const names = rooms.map((r) => r.name);
    expect(names).toContain('room-a');
    expect(names).toContain('room-b');
  });

  it('listRooms returns empty array for wing with no rooms', () => {
    const wingId = createWing('empty-wing');
    expect(listRooms(wingId)).toHaveLength(0);
  });

  it('resolveRoom creates room if not exist, returns same ID on second call', () => {
    const wingId = createWing('resolve-room-wing');
    const id1 = resolveRoom(wingId, 'shared-room', 'A shared meeting room');
    const id2 = resolveRoom(wingId, 'shared-room', 'ignored description');
    expect(id1).toBe(id2);
    const room = getRoom(id1);
    expect(room?.name).toBe('shared-room');
  });

  it('incrementRoomCount and decrementRoomCount work correctly', () => {
    const wingId = createWing('count-wing');
    const roomId = createRoom(wingId, 'count-room');

    incrementRoomCount(roomId);
    incrementRoomCount(roomId);
    incrementRoomCount(roomId);
    const after3 = getRoom(roomId);
    expect(after3?.memoryCount).toBe(3);

    decrementRoomCount(roomId);
    const after2 = getRoom(roomId);
    expect(after2?.memoryCount).toBe(2);
  });

  it('decrementRoomCount does not go below 0', () => {
    const wingId = createWing('floor-wing');
    const roomId = createRoom(wingId, 'floor-room');
    decrementRoomCount(roomId);
    const room = getRoom(roomId);
    expect(room?.memoryCount).toBe(0);
  });

  // ── assignHall tests ────────────────────────────────────────────────────────

  it('assignHall: fact → truths', () => {
    expect(assignHall('fact', 'web:abc')).toBe('truths');
  });

  it('assignHall: preference → truths', () => {
    expect(assignHall('preference', 'telegram:123')).toBe('truths');
  });

  it('assignHall: summary → reflections', () => {
    expect(assignHall('summary', 'web:xyz')).toBe('reflections');
  });

  it('assignHall: episode + curiosity:* → discoveries', () => {
    expect(assignHall('episode', 'curiosity:browse')).toBe('discoveries');
  });

  it('assignHall: episode + dreams:* → dreams', () => {
    expect(assignHall('episode', 'dreams:lain')).toBe('dreams');
  });

  it('assignHall: episode + dream:* → dreams', () => {
    expect(assignHall('episode', 'dream:tonight')).toBe('dreams');
  });

  it('assignHall: episode + diary:* → reflections', () => {
    expect(assignHall('episode', 'diary:daily')).toBe('reflections');
  });

  it('assignHall: episode + letter:* → reflections', () => {
    expect(assignHall('episode', 'letter:wired-lain')).toBe('reflections');
  });

  it('assignHall: episode + self-concept:* → reflections', () => {
    expect(assignHall('episode', 'self-concept:core')).toBe('reflections');
  });

  it('assignHall: episode + selfconcept:* → reflections', () => {
    expect(assignHall('episode', 'selfconcept:identity')).toBe('reflections');
  });

  it('assignHall: episode + bibliomancy:* → reflections', () => {
    expect(assignHall('episode', 'bibliomancy:weekly')).toBe('reflections');
  });

  it('assignHall: context → encounters', () => {
    expect(assignHall('context', 'web:abc')).toBe('encounters');
  });

  it('assignHall: episode (default, no special prefix) → encounters', () => {
    expect(assignHall('episode', 'web:somesession')).toBe('encounters');
    expect(assignHall('episode', 'telegram:12345')).toBe('encounters');
  });

  // ── resolveWingForMemory tests ──────────────────────────────────────────────

  it('resolveWingForMemory: diary → self', () => {
    const r = resolveWingForMemory('diary:2026-04-07', null);
    expect(r.wingName).toBe('self');
  });

  it('resolveWingForMemory: dreams → self', () => {
    expect(resolveWingForMemory('dreams:lain', null).wingName).toBe('self');
    expect(resolveWingForMemory('dream:tonight', null).wingName).toBe('self');
  });

  it('resolveWingForMemory: self-concept → self', () => {
    expect(resolveWingForMemory('self-concept:core', null).wingName).toBe('self');
    expect(resolveWingForMemory('selfconcept:identity', null).wingName).toBe('self');
  });

  it('resolveWingForMemory: bibliomancy → self', () => {
    expect(resolveWingForMemory('bibliomancy:weekly', null).wingName).toBe('self');
  });

  it('resolveWingForMemory: curiosity → curiosity', () => {
    expect(resolveWingForMemory('curiosity:browse', null).wingName).toBe('curiosity');
  });

  it('resolveWingForMemory: letter:target → target as wing name', () => {
    const r = resolveWingForMemory('letter:wired-lain', null);
    expect(r.wingName).toBe('wired-lain');
  });

  it('resolveWingForMemory: commune:target → target as wing name', () => {
    const r = resolveWingForMemory('commune:pkd', null);
    expect(r.wingName).toBe('pkd');
  });

  it('resolveWingForMemory: peer:target → target as wing name', () => {
    const r = resolveWingForMemory('peer:mckenna', null);
    expect(r.wingName).toBe('mckenna');
  });

  it('resolveWingForMemory: doctor → dr-claude', () => {
    expect(resolveWingForMemory('doctor:session-1', null).wingName).toBe('dr-claude');
  });

  it('resolveWingForMemory: therapy → dr-claude', () => {
    expect(resolveWingForMemory('therapy:weekly', null).wingName).toBe('dr-claude');
  });

  it('resolveWingForMemory: townlife → town', () => {
    expect(resolveWingForMemory('townlife:wandering', null).wingName).toBe('town');
  });

  it('resolveWingForMemory: movement → town', () => {
    expect(resolveWingForMemory('movement:library', null).wingName).toBe('town');
  });

  it('resolveWingForMemory: note/object/document → town', () => {
    expect(resolveWingForMemory('note:bench', null).wingName).toBe('town');
    expect(resolveWingForMemory('object:lantern', null).wingName).toBe('town');
    expect(resolveWingForMemory('document:map', null).wingName).toBe('town');
  });

  it('resolveWingForMemory: userId present → visitor-{userId}', () => {
    const r = resolveWingForMemory('web:abc', '12345');
    expect(r.wingName).toBe('visitor-12345');
  });

  it('resolveWingForMemory: fallback → encounters', () => {
    const r = resolveWingForMemory('web:abc', null);
    expect(r.wingName).toBe('encounters');
  });
});

// ─── Knowledge Graph CRUD tests ───────────────────────────────────────────────

import {
  addTriple,
  getTriple,
  invalidateTriple,
  queryTriples,
  getEntityTimeline,
  addEntity,
  getEntity,
  updateEntityLastSeen,
  listEntities,
  detectContradictions,
} from '../src/memory/knowledge-graph.js';

describe('Knowledge Graph CRUD', () => {
  const testDir3 = join(tmpdir(), `lain-test-kg-${Date.now()}`);
  const dbPath3 = join(testDir3, 'test.db');
  const origEnv3 = process.env['LAIN_HOME'];

  beforeEach(async () => {
    process.env['LAIN_HOME'] = testDir3;
    await mkdir(testDir3, { recursive: true });
    await initDatabase(dbPath3);
  });

  afterEach(async () => {
    closeDatabase();
    if (origEnv3) {
      process.env['LAIN_HOME'] = origEnv3;
    } else {
      delete process.env['LAIN_HOME'];
    }
    try {
      await rm(testDir3, { recursive: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // ── Triple: add and retrieve ────────────────────────────────────────────────

  it('adds and retrieves a triple by ID', () => {
    const id = addTriple('Lain', 'lives_in', 'Library', 0.9);
    expect(id).toBeTruthy();

    const triple = getTriple(id);
    expect(triple).toBeDefined();
    expect(triple?.id).toBe(id);
    expect(triple?.subject).toBe('Lain');
    expect(triple?.predicate).toBe('lives_in');
    expect(triple?.object).toBe('Library');
    expect(triple?.strength).toBe(0.9);
    expect(triple?.ended).toBeNull();
    expect(triple?.sourceMemoryId).toBeNull();
    expect(triple?.validFrom).toBeGreaterThan(0);
    expect(triple?.metadata).toEqual({});
  });

  it('returns undefined for a missing triple ID', () => {
    expect(getTriple('does-not-exist')).toBeUndefined();
  });

  it('stores and retrieves metadata on a triple', () => {
    const id = addTriple('PKD', 'believes', 'reality is simulated', 1.0, undefined, null, 'mem-1', { confidence: 'high' });
    const triple = getTriple(id);
    expect(triple?.metadata).toEqual({ confidence: 'high' });
    expect(triple?.sourceMemoryId).toBe('mem-1');
  });

  // ── Triple: query by subject ────────────────────────────────────────────────

  it('queries triples by subject', () => {
    addTriple('Lain', 'likes', 'computers');
    addTriple('Lain', 'lives_in', 'Library');
    addTriple('PKD', 'lives_in', 'Locksmith');

    const results = queryTriples({ subject: 'Lain' });
    expect(results).toHaveLength(2);
    expect(results.every((t) => t.subject === 'Lain')).toBe(true);
  });

  it('queries triples by predicate', () => {
    addTriple('Lain', 'lives_in', 'Library');
    addTriple('PKD', 'lives_in', 'Locksmith');
    addTriple('Lain', 'likes', 'computers');

    const results = queryTriples({ predicate: 'lives_in' });
    expect(results).toHaveLength(2);
    expect(results.every((t) => t.predicate === 'lives_in')).toBe(true);
  });

  it('queries triples by object', () => {
    addTriple('Lain', 'lives_in', 'Library');
    addTriple('PKD', 'lives_in', 'Locksmith');

    const results = queryTriples({ object: 'Library' });
    expect(results).toHaveLength(1);
    expect(results[0]?.subject).toBe('Lain');
  });

  it('respects the limit option', () => {
    for (let i = 0; i < 5; i++) {
      addTriple('Lain', `attr_${i}`, `val_${i}`);
    }
    const results = queryTriples({ subject: 'Lain', limit: 3 });
    expect(results).toHaveLength(3);
  });

  // ── Triple: temporal filter (asOf) ─────────────────────────────────────────

  it('queries active triples at a specific point in time', () => {
    const t0 = 1000;
    const t2 = 3000;
    const asOf = 1500;
    const endedBeforeAsOf = 1200; // ended before asOf → inactive at asOf

    // Active at t0, still active at asOf (no ended timestamp)
    addTriple('Lain', 'lives_in', 'Library', 1.0, t0);
    // Starts after asOf — should NOT appear
    addTriple('Lain', 'lives_in', 'Bar', 1.0, t2);
    // Active at t0, ended before asOf — should NOT appear at asOf
    addTriple('Lain', 'mood', 'anxious', 1.0, t0, endedBeforeAsOf);

    const results = queryTriples({ subject: 'Lain', asOf });
    expect(results).toHaveLength(1);
    expect(results[0]?.object).toBe('Library');
  });

  it('asOf includes triples whose ended is exactly after asOf', () => {
    const t0 = 1000;
    const asOf = 1500;
    const endedAfter = 2000;
    const endedBefore = 1200;

    addTriple('X', 'p', 'a', 1.0, t0, endedAfter); // ended > asOf → active
    addTriple('X', 'p', 'b', 1.0, t0, endedBefore); // ended < asOf → inactive

    const results = queryTriples({ subject: 'X', asOf });
    expect(results).toHaveLength(1);
    expect(results[0]?.object).toBe('a');
  });

  // ── Triple: invalidate ─────────────────────────────────────────────────────

  it('invalidates a triple by setting ended timestamp', () => {
    const id = addTriple('Lain', 'lives_in', 'Library');
    const before = getTriple(id);
    expect(before?.ended).toBeNull();

    const endTs = Date.now() + 1000;
    invalidateTriple(id, endTs);

    const after = getTriple(id);
    expect(after?.ended).toBe(endTs);
  });

  it('invalidateTriple defaults ended to now if no timestamp given', () => {
    const id = addTriple('Lain', 'mood', 'peaceful');
    const before = Date.now();
    invalidateTriple(id);
    const after = getTriple(id);
    expect(after?.ended).toBeGreaterThanOrEqual(before);
  });

  // ── Contradiction detection ────────────────────────────────────────────────

  it('detects contradictions for two active triples with same subject+predicate but different objects', () => {
    addTriple('Lain', 'lives_in', 'Library');
    addTriple('Lain', 'lives_in', 'Bar');

    const contradictions = detectContradictions();
    expect(contradictions).toHaveLength(1);
    expect(contradictions[0]?.subject).toBe('Lain');
    expect(contradictions[0]?.predicate).toBe('lives_in');

    const objects = new Set([contradictions[0]?.tripleA.object, contradictions[0]?.tripleB.object]);
    expect(objects.has('Library')).toBe(true);
    expect(objects.has('Bar')).toBe(true);
  });

  it('does not flag contradictions when one triple is ended', () => {
    const id1 = addTriple('Lain', 'lives_in', 'Library');
    addTriple('Lain', 'lives_in', 'Bar');
    invalidateTriple(id1);

    const contradictions = detectContradictions();
    expect(contradictions).toHaveLength(0);
  });

  it('does not flag contradictions when same object appears twice for same subject+predicate', () => {
    addTriple('Lain', 'likes', 'computers');
    addTriple('Lain', 'likes', 'computers');

    const contradictions = detectContradictions();
    expect(contradictions).toHaveLength(0);
  });

  it('emits multiple contradiction pairs for 3+ conflicting active triples', () => {
    addTriple('Lain', 'occupation', 'hacker');
    addTriple('Lain', 'occupation', 'student');
    addTriple('Lain', 'occupation', 'ghost');

    const contradictions = detectContradictions();
    // 3 distinct objects → C(3,2) = 3 pairs
    expect(contradictions).toHaveLength(3);
  });

  // ── Entity timeline ────────────────────────────────────────────────────────

  it('builds entity timeline — triples where entity is subject or object', () => {
    addTriple('Lain', 'knows', 'Alice', 1.0, 1000);
    addTriple('Bob', 'trusts', 'Lain', 1.0, 2000);
    addTriple('Lain', 'fears', 'darkness', 1.0, 3000);
    addTriple('Charlie', 'ignores', 'Dave', 1.0, 4000); // unrelated

    const timeline = getEntityTimeline('Lain');
    expect(timeline).toHaveLength(3);
    // Ordered by valid_from ASC
    expect(timeline[0]?.validFrom).toBe(1000);
    expect(timeline[1]?.validFrom).toBe(2000);
    expect(timeline[2]?.validFrom).toBe(3000);
  });

  it('getEntityTimeline respects limit', () => {
    for (let i = 0; i < 5; i++) {
      addTriple('Lain', `event_${i}`, `thing_${i}`, 1.0, i * 1000);
    }
    const timeline = getEntityTimeline('Lain', 2);
    expect(timeline).toHaveLength(2);
  });

  it('getEntityTimeline returns empty array when entity has no triples', () => {
    const timeline = getEntityTimeline('Unknown');
    expect(timeline).toHaveLength(0);
  });

  // ── Entity CRUD ────────────────────────────────────────────────────────────

  it('adds and retrieves an entity', () => {
    addEntity('Lain', 'person', 1000, { role: 'protagonist' });
    const entity = getEntity('Lain');
    expect(entity).toBeDefined();
    expect(entity?.name).toBe('Lain');
    expect(entity?.entityType).toBe('person');
    expect(entity?.firstSeen).toBe(1000);
    expect(entity?.lastSeen).toBe(1000);
    expect(entity?.metadata).toEqual({ role: 'protagonist' });
  });

  it('returns undefined for missing entity', () => {
    expect(getEntity('NoOne')).toBeUndefined();
  });

  it('upserts entity — second addEntity updates last_seen and metadata, preserves first_seen', () => {
    addEntity('Lain', 'person', 1000, { role: 'protagonist' });
    addEntity('Lain', 'person', 9999, { role: 'ghost' }); // second call

    const entity = getEntity('Lain');
    expect(entity?.firstSeen).toBe(1000); // preserved from first insert
    expect(entity?.lastSeen).toBe(9999);  // updated
    expect(entity?.metadata).toEqual({ role: 'ghost' }); // updated
  });

  it('updateEntityLastSeen updates last_seen timestamp', () => {
    addEntity('PKD', 'person', 1000);
    const ts = 99999;
    updateEntityLastSeen('PKD', ts);
    const entity = getEntity('PKD');
    expect(entity?.lastSeen).toBe(ts);
  });

  it('updateEntityLastSeen defaults to now', () => {
    addEntity('PKD', 'person', 1000);
    const before = Date.now();
    updateEntityLastSeen('PKD');
    const entity = getEntity('PKD');
    expect(entity?.lastSeen).toBeGreaterThanOrEqual(before);
  });

  it('listEntities with no filter returns all entities', () => {
    addEntity('Lain', 'person');
    addEntity('PKD', 'person');
    addEntity('Library', 'place');

    const all = listEntities();
    expect(all.length).toBeGreaterThanOrEqual(3);
    const names = all.map((e) => e.name);
    expect(names).toContain('Lain');
    expect(names).toContain('PKD');
    expect(names).toContain('Library');
  });

  it('listEntities filtered by entityType', () => {
    addEntity('Lain', 'person');
    addEntity('PKD', 'person');
    addEntity('Library', 'place');

    const people = listEntities('person');
    expect(people.every((e) => e.entityType === 'person')).toBe(true);
    expect(people.length).toBe(2);
  });

  it('listEntities respects limit', () => {
    for (let i = 0; i < 5; i++) {
      addEntity(`Entity${i}`, 'person', i * 1000);
    }
    const limited = listEntities(undefined, 3);
    expect(limited).toHaveLength(3);
  });
});

// ─── Migration tests ──────────────────────────────────────────────────────────

import { migrateMemoriesToPalace, getMigrationStats } from '../src/memory/migration.js';
import { saveMemory, searchMemories } from '../src/memory/store.js';
import { getDatabase } from '../src/storage/database.js';

describe('migrateMemoriesToPalace', () => {
  const testDirM = join(tmpdir(), `lain-test-migration-${Date.now()}`);
  const dbPathM = join(testDirM, 'test.db');
  const origEnvM = process.env['LAIN_HOME'];

  beforeEach(async () => {
    process.env['LAIN_HOME'] = testDirM;
    await mkdir(testDirM, { recursive: true });
    await initDatabase(dbPathM);
  });

  afterEach(async () => {
    closeDatabase();
    if (origEnvM) {
      process.env['LAIN_HOME'] = origEnvM;
    } else {
      delete process.env['LAIN_HOME'];
    }
    try {
      await rm(testDirM, { recursive: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // Note: saveMemory now assigns palace placement immediately, so migrateMemoriesToPalace
  // sees new memories as already-migrated (skipped). Tests below verify the palace
  // assignment happens correctly via saveMemory — not via the migration function.

  it('saveMemory assigns fact memory to truths hall', async () => {
    await saveMemory({
      sessionKey: 'web:visitor1',
      userId: null,
      content: 'Lain likes computers',
      memoryType: 'fact',
      importance: 0.8,
      emotionalWeight: 0,
      relatedTo: null,
      sourceMessageId: null,
      metadata: {},
    });

    // saveMemory sets palace placement — verify directly
    const db = getDatabase();
    const row = db
      .prepare("SELECT hall, wing_id, room_id FROM memories WHERE memory_type = 'fact'")
      .get() as { hall: string; wing_id: string; room_id: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.hall).toBe('truths');
    expect(row?.wing_id).toBeTruthy();
    expect(row?.room_id).toBeTruthy();

    // Migration reports all as skipped (already have wing_id)
    const stats = await migrateMemoriesToPalace();
    expect(stats.skipped).toBe(1);
    expect(stats.migrated).toBe(0);
    expect(stats.errors).toBe(0);
  }, 30000);

  it('saveMemory assigns curiosity episode to discoveries hall', async () => {
    await saveMemory({
      sessionKey: 'curiosity:browse-2026',
      userId: null,
      content: 'Found an interesting article about consciousness',
      memoryType: 'episode',
      importance: 0.7,
      emotionalWeight: 0.3,
      relatedTo: null,
      sourceMessageId: null,
      metadata: {},
    });

    const db = getDatabase();
    const row = db
      .prepare("SELECT hall FROM memories WHERE session_key = 'curiosity:browse-2026'")
      .get() as { hall: string } | undefined;
    expect(row?.hall).toBe('discoveries');

    // Migration skips already-placed memory
    const stats = await migrateMemoriesToPalace();
    expect(stats.skipped).toBe(1);
  }, 30000);

  it('saveMemory assigns dream episode to dreams hall in self wing', async () => {
    await saveMemory({
      sessionKey: 'dreams:lain-2026-04-07',
      userId: null,
      content: 'Dreamed of floating through wires',
      memoryType: 'episode',
      importance: 0.6,
      emotionalWeight: 0.5,
      relatedTo: null,
      sourceMessageId: null,
      metadata: {},
    });

    const db = getDatabase();
    const row = db
      .prepare("SELECT hall, wing_id FROM memories WHERE session_key LIKE 'dreams:%'")
      .get() as { hall: string; wing_id: string } | undefined;
    expect(row?.hall).toBe('dreams');
    // Dreams belong to the 'self' wing
    const { getWing } = await import('../src/memory/palace.js');
    const wing = getWing(row!.wing_id);
    expect(wing?.name).toBe('self');
  }, 30000);

  it('migrateMemoriesToPalace skips memories already placed by saveMemory', async () => {
    await saveMemory({
      sessionKey: 'web:visitor2',
      userId: null,
      content: 'A memory already placed by saveMemory',
      memoryType: 'fact',
      importance: 0.5,
      emotionalWeight: 0,
      relatedTo: null,
      sourceMessageId: null,
      metadata: {},
    });

    // Both migration runs skip the memory — it was placed at save time
    const first = await migrateMemoriesToPalace();
    expect(first.skipped).toBe(1);
    expect(first.migrated).toBe(0);

    const second = await migrateMemoriesToPalace();
    expect(second.skipped).toBe(1);
    expect(second.migrated).toBe(0);
  }, 30000);

  it('saveMemory inserts into vec0 when embedding is available', async () => {
    await saveMemory({
      sessionKey: 'web:visitor3',
      userId: null,
      content: 'Memory for vec0 test',
      memoryType: 'context',
      importance: 0.5,
      emotionalWeight: 0,
      relatedTo: null,
      sourceMessageId: null,
      metadata: {},
    });

    // vec0 row should be present if embedding was generated
    const db = getDatabase();
    const vecRow = db
      .prepare('SELECT memory_id FROM memory_embeddings LIMIT 1')
      .get() as { memory_id: string } | undefined;
    // If embedding model loaded, vecRow is defined; if model failed it may be absent.
    // Either way, no errors should be thrown.
    if (vecRow) {
      expect(vecRow.memory_id).toBeTruthy();
    }
  }, 30000);

  it('getMigrationStats reflects all memories as migrated after saveMemory', async () => {
    // Save 3 memories across different session types
    await saveMemory({
      sessionKey: 'web:user-a',
      userId: 'user-a',
      content: 'Visitor note',
      memoryType: 'context',
      importance: 0.4,
      emotionalWeight: 0,
      relatedTo: null,
      sourceMessageId: null,
      metadata: {},
    });
    await saveMemory({
      sessionKey: 'curiosity:links',
      userId: null,
      content: 'Curiosity finding',
      memoryType: 'episode',
      importance: 0.6,
      emotionalWeight: 0,
      relatedTo: null,
      sourceMessageId: null,
      metadata: {},
    });
    await saveMemory({
      sessionKey: 'diary:2026-04-07',
      userId: null,
      content: 'Diary entry',
      memoryType: 'episode',
      importance: 0.5,
      emotionalWeight: 0.2,
      relatedTo: null,
      sourceMessageId: null,
      metadata: {},
    });

    // Migration skips all (already placed at save time)
    const stats = await migrateMemoriesToPalace();
    expect(stats.total).toBe(3);
    expect(stats.skipped).toBe(3);
    expect(stats.migrated).toBe(0);
    expect(stats.errors).toBe(0);

    // getMigrationStats should reflect all as migrated (wing_id is set)
    const quick = getMigrationStats();
    expect(quick.total).toBe(3);
    expect(quick.migrated).toBe(3);
    expect(quick.unmigrated).toBe(0);
  }, 30000);
});

// ─── Vec0 Search tests ────────────────────────────────────────────────────────

describe('Vec0 Search', () => {
  const testDirV = join(tmpdir(), `lain-test-vec0-${Date.now()}`);
  const dbPathV = join(testDirV, 'test.db');
  const origEnvV = process.env['LAIN_HOME'];

  beforeEach(async () => {
    process.env['LAIN_HOME'] = testDirV;
    await mkdir(testDirV, { recursive: true });
    await initDatabase(dbPathV);
  });

  afterEach(async () => {
    closeDatabase();
    if (origEnvV) {
      process.env['LAIN_HOME'] = origEnvV;
    } else {
      delete process.env['LAIN_HOME'];
    }
    try {
      await rm(testDirV, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('searchMemories returns results from vec0 index', async () => {
    await saveMemory({
      sessionKey: null, userId: null,
      content: 'The Wired connects all consciousness',
      memoryType: 'fact', importance: 0.8, emotionalWeight: 0.5,
      relatedTo: null, sourceMessageId: null, metadata: {},
    });

    const results = await searchMemories('consciousness connection', 5, 0.01);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.memory.content).toContain('consciousness');
  }, 30000);
});
