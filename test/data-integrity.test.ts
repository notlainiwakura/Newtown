/**
 * Data integrity tests — verifying data consistency, schema correctness,
 * round-trips, concurrent access patterns, and state machine validity.
 *
 * Uses real SQLite (temp directories) and no LLM calls.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── Mock keytar before any storage imports ──────────────────────────────────
vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn().mockResolvedValue('test-master-key'),
    setPassword: vi.fn().mockResolvedValue(undefined),
    deletePassword: vi.fn().mockResolvedValue(true),
    findCredentials: vi.fn().mockResolvedValue([]),
  },
}));

// ── Mock embeddings ──────────────────────────────────────────────────────────
vi.mock('../src/memory/embeddings.js', () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
  cosineSimilarity: vi.fn().mockReturnValue(0.85),
  serializeEmbedding: vi.fn((arr: Float32Array) => Buffer.from(arr.buffer)),
  deserializeEmbedding: vi.fn((buf: Buffer) => new Float32Array(buf.buffer)),
  CURRENT_EMBEDDING_MODEL: 'Xenova/all-MiniLM-L6-v2',
}));

// ─── Shared DB setup helpers ────────────────────────────────────────────────

async function createTestDb(): Promise<{ testDir: string; dbPath: string }> {
  const testDir = join(tmpdir(), `lain-di-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const dbPath = join(testDir, 'test.db');
  await mkdir(testDir, { recursive: true });
  process.env['LAIN_HOME'] = testDir;
  const { initDatabase } = await import('../src/storage/database.js');
  await initDatabase(dbPath);
  return { testDir, dbPath };
}

async function teardownTestDb(testDir: string, originalHome: string | undefined): Promise<void> {
  const { closeDatabase } = await import('../src/storage/database.js');
  closeDatabase();
  if (originalHome !== undefined) {
    process.env['LAIN_HOME'] = originalHome;
  } else {
    delete process.env['LAIN_HOME'];
  }
  try { await rm(testDir, { recursive: true }); } catch { /* ignore */ }
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. DATABASE SCHEMA INTEGRITY
// ══════════════════════════════════════════════════════════════════════════════
describe('Database schema integrity', () => {
  let testDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    originalHome = process.env['LAIN_HOME'];
    const result = await createTestDb();
    testDir = result.testDir;
  });

  afterEach(async () => {
    await teardownTestDb(testDir, originalHome);
  });

  it('sessions table exists with required columns', async () => {
    const { query } = await import('../src/storage/database.js');
    const cols = query<{ name: string }>('PRAGMA table_info(sessions)');
    const names = cols.map(c => c.name);
    expect(names).toContain('key');
    expect(names).toContain('agent_id');
    expect(names).toContain('channel');
    expect(names).toContain('peer_kind');
    expect(names).toContain('peer_id');
    expect(names).toContain('created_at');
    expect(names).toContain('updated_at');
    expect(names).toContain('token_count');
  });

  it('messages table exists with required columns', async () => {
    const { query } = await import('../src/storage/database.js');
    const cols = query<{ name: string }>('PRAGMA table_info(messages)');
    const names = cols.map(c => c.name);
    expect(names).toContain('id');
    expect(names).toContain('session_key');
    expect(names).toContain('role');
    expect(names).toContain('content');
    expect(names).toContain('timestamp');
    expect(names).toContain('user_id');
    expect(names).toContain('metadata');
  });

  it('memories table exists with required columns', async () => {
    const { query } = await import('../src/storage/database.js');
    const cols = query<{ name: string }>('PRAGMA table_info(memories)');
    const names = cols.map(c => c.name);
    expect(names).toContain('id');
    expect(names).toContain('session_key');
    expect(names).toContain('content');
    expect(names).toContain('memory_type');
    expect(names).toContain('importance');
    expect(names).toContain('embedding');
    expect(names).toContain('created_at');
    expect(names).toContain('emotional_weight');
  });

  it('memories table has palace columns (wing_id, room_id, hall)', async () => {
    const { query } = await import('../src/storage/database.js');
    const cols = query<{ name: string }>('PRAGMA table_info(memories)');
    const names = cols.map(c => c.name);
    expect(names).toContain('wing_id');
    expect(names).toContain('room_id');
    expect(names).toContain('hall');
  });

  it('memories table has aaak columns', async () => {
    const { query } = await import('../src/storage/database.js');
    const cols = query<{ name: string }>('PRAGMA table_info(memories)');
    const names = cols.map(c => c.name);
    expect(names).toContain('aaak_content');
    expect(names).toContain('aaak_compressed_at');
  });

  it('meta table exists', async () => {
    const { query } = await import('../src/storage/database.js');
    const cols = query<{ name: string }>('PRAGMA table_info(meta)');
    expect(cols.length).toBeGreaterThan(0);
  });

  it('memory_associations table exists', async () => {
    const { query } = await import('../src/storage/database.js');
    const cols = query<{ name: string }>('PRAGMA table_info(memory_associations)');
    const names = cols.map(c => c.name);
    expect(names).toContain('source_id');
    expect(names).toContain('target_id');
    expect(names).toContain('association_type');
    expect(names).toContain('strength');
    expect(names).toContain('causal_type');
  });

  it('coherence_groups table exists', async () => {
    const { query } = await import('../src/storage/database.js');
    const cols = query<{ name: string }>('PRAGMA table_info(coherence_groups)');
    expect(cols.length).toBeGreaterThan(0);
    const names = cols.map(c => c.name);
    expect(names).toContain('id');
    expect(names).toContain('member_count');
  });

  it('coherence_memberships table exists', async () => {
    const { query } = await import('../src/storage/database.js');
    const cols = query<{ name: string }>('PRAGMA table_info(coherence_memberships)');
    const names = cols.map(c => c.name);
    expect(names).toContain('memory_id');
    expect(names).toContain('group_id');
  });

  it('palace_wings table exists with required columns', async () => {
    const { query } = await import('../src/storage/database.js');
    const cols = query<{ name: string }>('PRAGMA table_info(palace_wings)');
    const names = cols.map(c => c.name);
    expect(names).toContain('id');
    expect(names).toContain('name');
    expect(names).toContain('memory_count');
  });

  it('palace_rooms table exists with wing_id foreign key column', async () => {
    const { query } = await import('../src/storage/database.js');
    const cols = query<{ name: string }>('PRAGMA table_info(palace_rooms)');
    const names = cols.map(c => c.name);
    expect(names).toContain('wing_id');
    expect(names).toContain('memory_count');
  });

  it('kg_triples table exists with temporal columns', async () => {
    const { query } = await import('../src/storage/database.js');
    const cols = query<{ name: string }>('PRAGMA table_info(kg_triples)');
    const names = cols.map(c => c.name);
    expect(names).toContain('subject');
    expect(names).toContain('predicate');
    expect(names).toContain('object');
    expect(names).toContain('valid_from');
    expect(names).toContain('ended');
    expect(names).toContain('strength');
  });

  it('kg_entities table exists', async () => {
    const { query } = await import('../src/storage/database.js');
    const cols = query<{ name: string }>('PRAGMA table_info(kg_entities)');
    const names = cols.map(c => c.name);
    expect(names).toContain('name');
    expect(names).toContain('entity_type');
    expect(names).toContain('first_seen');
    expect(names).toContain('last_seen');
  });

  it('postboard_messages table exists', async () => {
    const { query } = await import('../src/storage/database.js');
    const cols = query<{ name: string }>('PRAGMA table_info(postboard_messages)');
    const names = cols.map(c => c.name);
    expect(names).toContain('id');
    expect(names).toContain('content');
    expect(names).toContain('pinned');
    expect(names).toContain('author');
  });

  it('town_events table exists', async () => {
    const { query } = await import('../src/storage/database.js');
    const cols = query<{ name: string }>('PRAGMA table_info(town_events)');
    const names = cols.map(c => c.name);
    expect(names).toContain('id');
    expect(names).toContain('description');
    expect(names).toContain('status');
  });

  it('schema_version is at least 11', async () => {
    const { getMeta } = await import('../src/storage/database.js');
    const version = parseInt(getMeta('schema_version') ?? '0', 10);
    expect(version).toBeGreaterThanOrEqual(11);
  });

  it('indexes exist on sessions table', async () => {
    const { query } = await import('../src/storage/database.js');
    const indexes = query<{ name: string }>('PRAGMA index_list(sessions)');
    expect(indexes.length).toBeGreaterThan(0);
  });

  it('indexes exist on messages table', async () => {
    const { query } = await import('../src/storage/database.js');
    const indexes = query<{ name: string }>('PRAGMA index_list(messages)');
    expect(indexes.length).toBeGreaterThan(0);
  });

  it('indexes exist on memories table', async () => {
    const { query } = await import('../src/storage/database.js');
    const indexes = query<{ name: string }>('PRAGMA index_list(memories)');
    expect(indexes.length).toBeGreaterThan(0);
  });

  it('WAL journal mode is enabled', async () => {
    const { getDatabase } = await import('../src/storage/database.js');
    const db = getDatabase();
    const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(row.journal_mode).toBe('wal');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. DATA ROUND-TRIP
// ══════════════════════════════════════════════════════════════════════════════
describe('Data round-trip', () => {
  let testDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    originalHome = process.env['LAIN_HOME'];
    const result = await createTestDb();
    testDir = result.testDir;
  });

  afterEach(async () => {
    await teardownTestDb(testDir, originalHome);
  });

  it('message round-trip: content is preserved exactly', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
    const content = 'The Wired is calling — can you hear it? 電脳世界 🌐';
    saveMessage({ sessionKey: 'web:x', userId: null, role: 'user', content, timestamp: Date.now(), metadata: {} });
    const msgs = getRecentMessages('web:x');
    expect(msgs[0]!.content).toBe(content);
  });

  it('message round-trip: timestamp precision is preserved', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
    const ts = 1713200000000; // arbitrary epoch ms
    saveMessage({ sessionKey: 'web:x', userId: null, role: 'user', content: 'ts test', timestamp: ts, metadata: {} });
    const msgs = getRecentMessages('web:x');
    expect(msgs[0]!.timestamp).toBe(ts);
  });

  it('message round-trip: metadata object is preserved', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
    const meta = { senderId: 'u1', nested: { value: 42 } };
    saveMessage({ sessionKey: 'web:x', userId: null, role: 'user', content: 'meta', timestamp: Date.now(), metadata: meta });
    const msgs = getRecentMessages('web:x');
    expect(msgs[0]!.metadata['senderId']).toBe('u1');
  });

  it('message round-trip: user role preserved', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
    saveMessage({ sessionKey: 'web:y', userId: null, role: 'user', content: 'from user', timestamp: Date.now(), metadata: {} });
    expect(getRecentMessages('web:y')[0]!.role).toBe('user');
  });

  it('message round-trip: assistant role preserved', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
    saveMessage({ sessionKey: 'web:y', userId: null, role: 'assistant', content: 'from assistant', timestamp: Date.now(), metadata: {} });
    expect(getRecentMessages('web:y')[0]!.role).toBe('assistant');
  });

  it('memory round-trip: importance value preserved', async () => {
    const { saveMemory, getMemory } = await import('../src/memory/store.js');
    const id = await saveMemory({ sessionKey: 'web:a', userId: null, content: 'imp test', memoryType: 'fact', importance: 0.73, emotionalWeight: 0, relatedTo: null, sourceMessageId: null, metadata: {} });
    expect(getMemory(id)!.importance).toBeCloseTo(0.73);
  });

  it('memory round-trip: emotional weight preserved', async () => {
    const { saveMemory, getMemory } = await import('../src/memory/store.js');
    const id = await saveMemory({ sessionKey: 'web:a', userId: null, content: 'em test', memoryType: 'episode', importance: 0.5, emotionalWeight: 0.88, relatedTo: null, sourceMessageId: null, metadata: {} });
    expect(getMemory(id)!.emotionalWeight).toBeCloseTo(0.88);
  });

  it('memory round-trip: metadata object preserved', async () => {
    const { saveMemory, getMemory } = await import('../src/memory/store.js');
    const meta = { type: 'commune_conversation', peerId: 'pkd', rounds: 5 };
    const id = await saveMemory({ sessionKey: 'commune:pkd', userId: null, content: 'commune mem', memoryType: 'episode', importance: 0.5, emotionalWeight: 0.2, relatedTo: null, sourceMessageId: null, metadata: meta });
    const mem = getMemory(id)!;
    expect(mem.metadata['type']).toBe('commune_conversation');
    expect(mem.metadata['peerId']).toBe('pkd');
    expect(mem.metadata['rounds']).toBe(5);
  });

  it('memory round-trip: lifecycle state preserved', async () => {
    const { saveMemory, getMemory } = await import('../src/memory/store.js');
    const id = await saveMemory({ sessionKey: 'web:a', userId: null, content: 'lifecycle test', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, relatedTo: null, sourceMessageId: null, metadata: {}, lifecycleState: 'growing' });
    expect(getMemory(id)!.lifecycleState).toBe('growing');
  });

  it('session round-trip: all fields preserved', async () => {
    const { createSession, getSession } = await import('../src/storage/sessions.js');
    const s = createSession({ agentId: 'default', channel: 'http', peerKind: 'anonymous', peerId: 'visitor-1' });
    const r = getSession(s.key);
    expect(r!.agentId).toBe('default');
    expect(r!.channel).toBe('http');
    expect(r!.peerKind).toBe('anonymous');
    expect(r!.peerId).toBe('visitor-1');
    expect(r!.tokenCount).toBe(0);
  });

  it('session round-trip: flags object preserved', async () => {
    const { createSession, updateSession, getSession } = await import('../src/storage/sessions.js');
    const s = createSession({ agentId: 'default', channel: 'http', peerKind: 'anonymous', peerId: 'flag-visitor' });
    updateSession(s.key, { flags: { greeting: true } });
    const r = getSession(s.key);
    expect(r!.flags['greeting']).toBe(true);
  });

  it('meta round-trip: key/value preserved exactly', async () => {
    const { getMeta, setMeta } = await import('../src/storage/database.js');
    setMeta('test:round-trip', 'hello-world-123');
    expect(getMeta('test:round-trip')).toBe('hello-world-123');
  });

  it('meta round-trip: JSON value preserved', async () => {
    const { getMeta, setMeta } = await import('../src/storage/database.js');
    const val = JSON.stringify({ complex: true, count: 42 });
    setMeta('test:json-rt', val);
    expect(JSON.parse(getMeta('test:json-rt')!).count).toBe(42);
  });

  it('meta setMeta with same key overwrites value', async () => {
    const { getMeta, setMeta } = await import('../src/storage/database.js');
    setMeta('test:overwrite', 'v1');
    setMeta('test:overwrite', 'v2');
    expect(getMeta('test:overwrite')).toBe('v2');
  });

  it('KG triple round-trip: subject/predicate/object preserved', async () => {
    const { addTriple, getTriple } = await import('../src/memory/knowledge-graph.js');
    const id = addTriple('Lain', 'is_at', 'library', 0.9);
    const triple = getTriple(id);
    expect(triple).toBeDefined();
    expect(triple!.subject).toBe('Lain');
    expect(triple!.predicate).toBe('is_at');
    expect(triple!.object).toBe('library');
    expect(triple!.strength).toBeCloseTo(0.9);
  });

  it('KG triple round-trip: valid_from timestamp preserved', async () => {
    const { addTriple, getTriple } = await import('../src/memory/knowledge-graph.js');
    const ts = Date.now();
    const id = addTriple('PKD', 'knows', 'Lain', 1.0, ts);
    const triple = getTriple(id);
    expect(triple!.validFrom).toBe(ts);
    expect(triple!.ended).toBeNull();
  });

  it('KG entity round-trip: type and metadata preserved', async () => {
    const { addEntity, getEntity } = await import('../src/memory/knowledge-graph.js');
    addEntity('Alice', 'person', Date.now(), { notes: 'regular visitor' });
    const entity = getEntity('Alice');
    expect(entity).toBeDefined();
    expect(entity!.entityType).toBe('person');
    expect(entity!.metadata['notes']).toBe('regular visitor');
  });

  it('KG entity upsert updates last_seen on conflict', async () => {
    const { addEntity, getEntity } = await import('../src/memory/knowledge-graph.js');
    const t1 = Date.now() - 5000;
    const t2 = Date.now();
    addEntity('Bob', 'person', t1);
    addEntity('Bob', 'person', t2);
    const entity = getEntity('Bob');
    expect(entity!.lastSeen).toBe(t2);
  });

  it('postboard message round-trip: pinned state preserved', async () => {
    const { savePostboardMessage, getPostboardMessages } = await import('../src/memory/store.js');
    const id = savePostboardMessage('pinned msg', 'admin', true);
    const msgs = getPostboardMessages();
    const m = msgs.find(x => x.id === id);
    expect(m!.pinned).toBe(true);
  });

  it('postboard message round-trip: author preserved', async () => {
    const { savePostboardMessage, getPostboardMessages } = await import('../src/memory/store.js');
    const id = savePostboardMessage('from operator', 'operator');
    const msgs = getPostboardMessages();
    expect(msgs.find(m => m.id === id)!.author).toBe('operator');
  });

  it('getAllMessages returns all messages for a session in order', async () => {
    const { saveMessage, getAllMessages } = await import('../src/memory/store.js');
    const now = Date.now();
    saveMessage({ sessionKey: 'web:z', userId: null, role: 'user', content: 'A', timestamp: now, metadata: {} });
    saveMessage({ sessionKey: 'web:z', userId: null, role: 'assistant', content: 'B', timestamp: now + 10, metadata: {} });
    saveMessage({ sessionKey: 'web:z', userId: null, role: 'user', content: 'C', timestamp: now + 20, metadata: {} });
    const msgs = getAllMessages('web:z');
    expect(msgs).toHaveLength(3);
    expect(msgs[0]!.content).toBe('A');
    expect(msgs[2]!.content).toBe('C');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. CONCURRENT ACCESS
// ══════════════════════════════════════════════════════════════════════════════
describe('Concurrent access', () => {
  let testDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    originalHome = process.env['LAIN_HOME'];
    const result = await createTestDb();
    testDir = result.testDir;
  });

  afterEach(async () => {
    await teardownTestDb(testDir, originalHome);
  });

  it('simultaneous saveMessage calls produce correct count', async () => {
    const { saveMessage, countMessages } = await import('../src/memory/store.js');
    const before = countMessages();
    const writes = Array.from({ length: 20 }, (_, i) =>
      saveMessage({ sessionKey: 'web:concurrent', userId: null, role: 'user', content: `msg-${i}`, timestamp: Date.now() + i, metadata: {} })
    );
    // All writes are synchronous (better-sqlite3 is sync), so all should succeed
    expect(writes).toHaveLength(20);
    expect(countMessages()).toBe(before + 20);
  });

  it('simultaneous saveMemory calls produce correct count', async () => {
    const { saveMemory, countMemories } = await import('../src/memory/store.js');
    const before = countMemories();
    const promises = Array.from({ length: 10 }, (_, i) =>
      saveMemory({ sessionKey: 'web:concurrent', userId: null, content: `mem-${i}`, memoryType: 'fact', importance: 0.5, emotionalWeight: 0, relatedTo: null, sourceMessageId: null, metadata: {} })
    );
    await Promise.all(promises);
    expect(countMemories()).toBe(before + 10);
  });

  it('concurrent createSession calls produce unique keys', async () => {
    const { createSession } = await import('../src/storage/sessions.js');
    const sessions = Array.from({ length: 10 }, (_, i) =>
      createSession({ agentId: 'default', channel: 'http', peerKind: 'anonymous', peerId: `visitor-${i}` })
    );
    const keys = sessions.map(s => s.key);
    const unique = new Set(keys);
    expect(unique.size).toBe(10);
  });

  it('transaction wraps multiple operations atomically', async () => {
    const { transaction, getMeta, setMeta } = await import('../src/storage/database.js');
    const { saveMessage, countMessages } = await import('../src/memory/store.js');
    const before = countMessages();
    transaction(() => {
      saveMessage({ sessionKey: 'web:tx', userId: null, role: 'user', content: 'tx msg 1', timestamp: Date.now(), metadata: {} });
      saveMessage({ sessionKey: 'web:tx', userId: null, role: 'user', content: 'tx msg 2', timestamp: Date.now() + 1, metadata: {} });
      setMeta('tx:test-key', 'tx-value');
    });
    expect(countMessages()).toBe(before + 2);
    expect(getMeta('tx:test-key')).toBe('tx-value');
  });

  it('parallel wing resolution produces same ID', async () => {
    const { resolveWing } = await import('../src/memory/palace.js');
    // Simulating concurrent resolution (sync in better-sqlite3)
    const ids = Array.from({ length: 5 }, () => resolveWing('concurrent-wing', 'desc'));
    const unique = new Set(ids);
    expect(unique.size).toBe(1); // All should resolve to same ID
  });

  it('parallel room resolution produces same ID', async () => {
    const { createWing, resolveRoom } = await import('../src/memory/palace.js');
    const wingId = createWing('room-concurrent-wing');
    const ids = Array.from({ length: 5 }, () => resolveRoom(wingId, 'same-room', 'desc'));
    expect(new Set(ids).size).toBe(1);
  });

  it('parallel memory saves to same session do not corrupt session key', async () => {
    const { saveMemory, getAllMemories } = await import('../src/memory/store.js');
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        saveMemory({ sessionKey: 'web:shared', userId: null, content: `parallel-${i}`, memoryType: 'fact', importance: 0.5, emotionalWeight: 0, relatedTo: null, sourceMessageId: null, metadata: {} })
      )
    );
    const all = getAllMemories();
    const shared = all.filter(m => m.sessionKey === 'web:shared');
    expect(shared.length).toBeGreaterThanOrEqual(5);
  });

  it('parallel KG triple inserts produce unique IDs', async () => {
    const { addTriple } = await import('../src/memory/knowledge-graph.js');
    const ids = Array.from({ length: 5 }, (_, i) =>
      addTriple('subject', 'predicate', `object-${i}`, 0.5)
    );
    expect(new Set(ids).size).toBe(5);
  });

  it('incrementWingCount under parallel calls is consistent', async () => {
    const { createWing, getWing, incrementWingCount } = await import('../src/memory/palace.js');
    const wingId = createWing('parallel-count-wing');
    const N = 20;
    for (let i = 0; i < N; i++) incrementWingCount(wingId);
    expect(getWing(wingId)!.memoryCount).toBe(N);
  });

  it('batchUpdateTokenCounts updates all sessions correctly', async () => {
    const { createSession, getSession, batchUpdateTokenCounts } = await import('../src/storage/sessions.js');
    const s1 = createSession({ agentId: 'default', channel: 'http', peerKind: 'anonymous', peerId: 'batch-1' });
    const s2 = createSession({ agentId: 'default', channel: 'http', peerKind: 'anonymous', peerId: 'batch-2' });
    batchUpdateTokenCounts([{ key: s1.key, tokenCount: 100 }, { key: s2.key, tokenCount: 200 }]);
    expect(getSession(s1.key)!.tokenCount).toBe(100);
    expect(getSession(s2.key)!.tokenCount).toBe(200);
  });

  it('reads during writes return consistent data via getDatabase', async () => {
    const { saveMessage, getRecentMessages, countMessages } = await import('../src/memory/store.js');
    const sessionKey = 'web:consistent';
    // interleave writes and reads
    saveMessage({ sessionKey, userId: null, role: 'user', content: 'msg1', timestamp: Date.now(), metadata: {} });
    const c1 = countMessages();
    saveMessage({ sessionKey, userId: null, role: 'user', content: 'msg2', timestamp: Date.now() + 1, metadata: {} });
    const msgs = getRecentMessages(sessionKey);
    expect(msgs.length).toBeGreaterThanOrEqual(2);
    expect(countMessages()).toBeGreaterThanOrEqual(c1);
  });

  it('addToCoherenceGroup is idempotent', async () => {
    const { saveMemory, createCoherenceGroup, addToCoherenceGroup, getGroupMembers } = await import('../src/memory/store.js');
    const memId = await saveMemory({ sessionKey: 'web:a', userId: null, content: 'idempotent add', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, relatedTo: null, sourceMessageId: null, metadata: {} });
    const groupId = createCoherenceGroup('idempotent-group', null);
    addToCoherenceGroup(memId, groupId);
    addToCoherenceGroup(memId, groupId); // second call should be no-op
    const members = getGroupMembers(groupId);
    expect(members.filter(id => id === memId)).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. CHARACTER MANIFEST CONSISTENCY
// ══════════════════════════════════════════════════════════════════════════════
describe('Character manifest consistency', () => {
  it('loadManifest returns object with town and characters array', async () => {
    const { loadManifest } = await import('../src/config/characters.js');
    const manifest = loadManifest();
    expect(manifest).toBeDefined();
    expect(typeof manifest.town).toBe('object');
    expect(Array.isArray(manifest.characters)).toBe(true);
  });

  it('getAllCharacters returns an array', async () => {
    const { getAllCharacters } = await import('../src/config/characters.js');
    const chars = getAllCharacters();
    expect(Array.isArray(chars)).toBe(true);
  });

  it('each character has required string fields', async () => {
    const { getAllCharacters } = await import('../src/config/characters.js');
    for (const char of getAllCharacters()) {
      expect(typeof char.id).toBe('string');
      expect(char.id.length).toBeGreaterThan(0);
      expect(typeof char.name).toBe('string');
      expect(char.name.length).toBeGreaterThan(0);
      expect(typeof char.defaultLocation).toBe('string');
    }
  });

  it('each character has a valid port number', async () => {
    const { getAllCharacters } = await import('../src/config/characters.js');
    for (const char of getAllCharacters()) {
      expect(typeof char.port).toBe('number');
      expect(char.port).toBeGreaterThan(0);
      expect(char.port).toBeLessThan(65536);
    }
  });

  it('character IDs are unique', async () => {
    const { getAllCharacters } = await import('../src/config/characters.js');
    const chars = getAllCharacters();
    const ids = chars.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('character ports are unique', async () => {
    const { getAllCharacters } = await import('../src/config/characters.js');
    const chars = getAllCharacters();
    const ports = chars.map(c => c.port);
    expect(new Set(ports).size).toBe(ports.length);
  });

  it('character server type is either web or character', async () => {
    const { getAllCharacters } = await import('../src/config/characters.js');
    for (const char of getAllCharacters()) {
      expect(['web', 'character']).toContain(char.server);
    }
  });

  it('all default locations are valid building IDs', async () => {
    const { getAllCharacters } = await import('../src/config/characters.js');
    const { isValidBuilding } = await import('../src/commune/buildings.js');
    for (const char of getAllCharacters()) {
      if (char.defaultLocation) {
        expect(isValidBuilding(char.defaultLocation), `${char.id} defaultLocation '${char.defaultLocation}' invalid`).toBe(true);
      }
    }
  });

  it('getCharacterEntry finds by ID', async () => {
    const { getAllCharacters, getCharacterEntry } = await import('../src/config/characters.js');
    const chars = getAllCharacters();
    if (chars.length === 0) return; // skip if no characters defined
    const first = chars[0]!;
    const found = getCharacterEntry(first.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(first.id);
  });

  it('getCharacterEntry returns undefined for unknown ID', async () => {
    const { getCharacterEntry } = await import('../src/config/characters.js');
    expect(getCharacterEntry('nonexistent-char-xyz')).toBeUndefined();
  });

  it('getDefaultLocations returns object with character ID keys', async () => {
    const { getDefaultLocations, getAllCharacters } = await import('../src/config/characters.js');
    const locs = getDefaultLocations();
    for (const char of getAllCharacters()) {
      expect(locs).toHaveProperty(char.id);
    }
  });

  it('getPeersFor excludes the queried character', async () => {
    const { getAllCharacters, getPeersFor } = await import('../src/config/characters.js');
    const chars = getAllCharacters();
    if (chars.length < 2) return;
    const char = chars[0]!;
    const peers = getPeersFor(char.id);
    expect(peers.every(p => p.id !== char.id)).toBe(true);
  });

  it('getPeersFor generates URLs with character ports', async () => {
    const { getAllCharacters, getPeersFor } = await import('../src/config/characters.js');
    const chars = getAllCharacters();
    if (chars.length < 2) return;
    const char = chars[0]!;
    const peers = getPeersFor(char.id);
    for (const peer of peers) {
      const peerChar = chars.find(c => c.id === peer.id)!;
      expect(peer.url).toBe(`http://localhost:${peerChar.port}`);
    }
  });

  it('getImmortalIds returns a Set', async () => {
    const { getImmortalIds } = await import('../src/config/characters.js');
    const immortals = getImmortalIds();
    expect(immortals instanceof Set).toBe(true);
  });

  it('getMortalCharacters excludes immortal characters', async () => {
    const { getMortalCharacters, getImmortalIds } = await import('../src/config/characters.js');
    const mortals = getMortalCharacters();
    const immortals = getImmortalIds();
    for (const char of mortals) {
      expect(immortals.has(char.id)).toBe(false);
    }
  });

  it('getWebCharacter returns a character with server=web', async () => {
    const { getWebCharacter } = await import('../src/config/characters.js');
    const webChar = getWebCharacter();
    if (webChar) {
      expect(webChar.server).toBe('web');
    }
  });

  it('town config has name and description fields', async () => {
    const { loadManifest } = await import('../src/config/characters.js');
    const manifest = loadManifest();
    expect(typeof manifest.town.name).toBe('string');
    expect(typeof manifest.town.description).toBe('string');
  });

  it('workspace field exists on every character entry', async () => {
    const { getAllCharacters } = await import('../src/config/characters.js');
    for (const char of getAllCharacters()) {
      expect(typeof char.workspace).toBe('string');
    }
  });

  it('BUILDINGS has 9 unique IDs', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    const ids = BUILDINGS.map(b => b.id);
    expect(new Set(ids).size).toBe(9);
  });

  it('BUILDINGS covers all 3x3 grid positions uniquely', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    const positions = BUILDINGS.map(b => `${b.row},${b.col}`);
    expect(new Set(positions).size).toBe(9);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. STATE MACHINE CONSISTENCY
// ══════════════════════════════════════════════════════════════════════════════
describe('State machine consistency', () => {
  let testDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    originalHome = process.env['LAIN_HOME'];
    const result = await createTestDb();
    testDir = result.testDir;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const { endPossession } = await import('../src/agent/possession.js');
    try { endPossession(); } catch { /* already ended */ }
    await teardownTestDb(testDir, originalHome);
  });

  it('character can only be in one building at a time', async () => {
    const { eventBus } = await import('../src/events/bus.js');
    const { setCurrentLocation, getCurrentLocation } = await import('../src/commune/location.js');
    eventBus.setCharacterId('lain');
    setCurrentLocation('library', 'going');
    setCurrentLocation('bar', 'going again');
    const loc = getCurrentLocation('lain');
    // Only one location is active
    expect(loc.building).toBe('bar');
  });

  it('location transitions record from/to correctly', async () => {
    const { eventBus } = await import('../src/events/bus.js');
    const { setCurrentLocation, getLocationHistory } = await import('../src/commune/location.js');
    eventBus.setCharacterId('lain');
    setCurrentLocation('library', 'step 1');
    setCurrentLocation('bar', 'step 2');
    setCurrentLocation('school', 'step 3');
    const hist = getLocationHistory();
    expect(hist[0]!.from).toBe('bar');
    expect(hist[0]!.to).toBe('school');
    expect(hist[1]!.from).toBe('library');
    expect(hist[1]!.to).toBe('bar');
  });

  it('lifecycle transitions: seed → growing → mature → complete → composting', async () => {
    const { saveMemory, getMemory, setLifecycleState } = await import('../src/memory/store.js');
    const id = await saveMemory({ sessionKey: 'web:a', userId: null, content: 'lifecycle journey', memoryType: 'episode', importance: 0.5, emotionalWeight: 0, relatedTo: null, sourceMessageId: null, metadata: {}, lifecycleState: 'seed' });
    expect(getMemory(id)!.lifecycleState).toBe('seed');
    setLifecycleState(id, 'growing');
    expect(getMemory(id)!.lifecycleState).toBe('growing');
    setLifecycleState(id, 'mature');
    expect(getMemory(id)!.lifecycleState).toBe('mature');
    setLifecycleState(id, 'complete');
    expect(getMemory(id)!.lifecycleState).toBe('complete');
    setLifecycleState(id, 'composting');
    expect(getMemory(id)!.lifecycleState).toBe('composting');
  });

  it('lifecycle_changed_at is updated on transition', async () => {
    const { saveMemory, getMemory, setLifecycleState } = await import('../src/memory/store.js');
    const id = await saveMemory({ sessionKey: 'web:a', userId: null, content: 'ts test', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, relatedTo: null, sourceMessageId: null, metadata: {} });
    const before = getMemory(id)!.lifecycleChangedAt;
    await new Promise(r => setTimeout(r, 5));
    setLifecycleState(id, 'growing');
    const after = getMemory(id)!.lifecycleChangedAt;
    expect(after).toBeGreaterThanOrEqual(before ?? 0);
  });

  it('possession state machine: not possessed → possessed → not possessed', async () => {
    const { isPossessed, startPossession, endPossession } = await import('../src/agent/possession.js');
    expect(isPossessed()).toBe(false);
    startPossession('sess-sm-1', [], []);
    expect(isPossessed()).toBe(true);
    endPossession();
    expect(isPossessed()).toBe(false);
  });

  it('possession: re-entering while possessed is blocked', async () => {
    const { startPossession, endPossession, getPossessionState } = await import('../src/agent/possession.js');
    startPossession('sess-A', [], []);
    startPossession('sess-B', [], []); // blocked
    expect(getPossessionState().playerSessionId).toBe('sess-A');
    endPossession();
  });

  it('KG triple: invalidated triple has ended timestamp set', async () => {
    const { addTriple, invalidateTriple, getTriple } = await import('../src/memory/knowledge-graph.js');
    const id = addTriple('Lain', 'loves', 'the Wired', 0.9);
    expect(getTriple(id)!.ended).toBeNull();
    invalidateTriple(id);
    expect(getTriple(id)!.ended).not.toBeNull();
  });

  it('KG triple temporal filter: asOf excludes ended triples', async () => {
    const { addTriple, invalidateTriple, queryTriples } = await import('../src/memory/knowledge-graph.js');
    const t1 = Date.now() - 10000;
    const t2 = Date.now() - 5000;
    const id = addTriple('X', 'has', 'Y', 1.0, t1);
    invalidateTriple(id, t2);
    // Query at time before invalidation — should find it
    const atT1 = queryTriples({ subject: 'X', predicate: 'has', asOf: t2 - 1000 });
    expect(atT1.some(t => t.id === id)).toBe(true);
    // Query at time after invalidation — should not find it
    const atNow = queryTriples({ subject: 'X', predicate: 'has', asOf: Date.now() });
    expect(atNow.some(t => t.id === id)).toBe(false);
  });

  it('contradiction detection finds conflicting triples for same subject+predicate', async () => {
    const { addTriple, detectContradictions } = await import('../src/memory/knowledge-graph.js');
    const ts = Date.now();
    addTriple('Lain', 'location', 'library', 1.0, ts - 1000);
    addTriple('Lain', 'location', 'bar', 1.0, ts);
    const contradictions = detectContradictions();
    expect(contradictions.some(c => c.subject === 'Lain' && c.predicate === 'location')).toBe(true);
  });

  it('no contradiction when same subject/predicate/object', async () => {
    const { addTriple, detectContradictions } = await import('../src/memory/knowledge-graph.js');
    const before = detectContradictions().length;
    addTriple('Lain', 'is_type', 'character', 1.0);
    addTriple('Lain', 'is_type', 'character', 1.0);
    // Same object — no contradiction
    const after = detectContradictions();
    const lainContradictions = after.filter(c => c.subject === 'Lain' && c.predicate === 'is_type');
    expect(lainContradictions).toHaveLength(0);
  });

  it('session state: createdAt <= updatedAt always', async () => {
    const { createSession, updateSession, getSession } = await import('../src/storage/sessions.js');
    const s = createSession({ agentId: 'default', channel: 'http', peerKind: 'anonymous', peerId: 'time-test' });
    updateSession(s.key, { tokenCount: 50 });
    const r = getSession(s.key);
    expect(r!.createdAt).toBeLessThanOrEqual(r!.updatedAt);
  });

  it('deleteSession removes session and returns true', async () => {
    const { createSession, deleteSession, getSession } = await import('../src/storage/sessions.js');
    const s = createSession({ agentId: 'default', channel: 'http', peerKind: 'anonymous', peerId: 'del-test' });
    expect(deleteSession(s.key)).toBe(true);
    expect(getSession(s.key)).toBeUndefined();
  });

  it('deleteSession returns false for nonexistent key', async () => {
    const { deleteSession } = await import('../src/storage/sessions.js');
    expect(deleteSession('nonexistent-key-xyz')).toBe(false);
  });

  it('strengthenAssociation boosts strength up to 1.0', async () => {
    const { saveMemory, addAssociation, strengthenAssociation, getAssociations } = await import('../src/memory/store.js');
    const id1 = await saveMemory({ sessionKey: 'web:a', userId: null, content: 's1', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, relatedTo: null, sourceMessageId: null, metadata: {} });
    const id2 = await saveMemory({ sessionKey: 'web:a', userId: null, content: 's2', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, relatedTo: null, sourceMessageId: null, metadata: {} });
    addAssociation(id1, id2, 'similar', 0.5);
    strengthenAssociation(id1, id2, 0.3);
    const assocs = getAssociations(id1);
    const assoc = assocs.find(a => (a.sourceId === id1 && a.targetId === id2) || (a.sourceId === id2 && a.targetId === id1));
    expect(assoc!.strength).toBeCloseTo(0.8);
  });

  it('strengthenAssociation does not exceed 1.0', async () => {
    const { saveMemory, addAssociation, strengthenAssociation, getAssociations } = await import('../src/memory/store.js');
    const id1 = await saveMemory({ sessionKey: 'web:a', userId: null, content: 'sc1', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, relatedTo: null, sourceMessageId: null, metadata: {} });
    const id2 = await saveMemory({ sessionKey: 'web:a', userId: null, content: 'sc2', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, relatedTo: null, sourceMessageId: null, metadata: {} });
    addAssociation(id1, id2, 'similar', 0.9);
    strengthenAssociation(id1, id2, 0.5); // would push to 1.4 without clamp
    const assocs = getAssociations(id1);
    const assoc = assocs.find(a => (a.sourceId === id1 && a.targetId === id2) || (a.sourceId === id2 && a.targetId === id1));
    expect(assoc!.strength).toBeLessThanOrEqual(1.0);
  });
});
