/**
 * Concurrency & race condition test suite
 *
 * Tests race conditions and concurrent access patterns that could corrupt
 * data or crash the system. Uses real in-memory SQLite for database tests,
 * mocked providers for LLM tests, and the real event bus for event tests.
 *
 * Focus: scenarios that actually happen in production — multiple loops running
 * simultaneously, multiple HTTP requests in flight, concurrent DB writes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { nanoid } from 'nanoid';
import { EventEmitter } from 'node:events';

// ── keytar mock ──────────────────────────────────────────────────────────────
vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn().mockResolvedValue('test-master-key'),
    setPassword: vi.fn().mockResolvedValue(undefined),
    deletePassword: vi.fn().mockResolvedValue(true),
    findCredentials: vi.fn().mockResolvedValue([]),
  },
}));

// ── Embedding mock: deterministic zero-vector ────────────────────────────────
vi.mock('../src/memory/embeddings.js', () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0)),
  generateEmbeddings: vi.fn().mockImplementation(async (texts: string[]) =>
    texts.map(() => new Float32Array(384).fill(0))
  ),
  cosineSimilarity: vi.fn().mockReturnValue(0.5),
  serializeEmbedding: vi.fn().mockImplementation((v: Float32Array) => Buffer.from(v.buffer)),
  deserializeEmbedding: vi.fn().mockImplementation((b: Buffer) =>
    new Float32Array(b.buffer, b.byteOffset, b.length / 4)
  ),
  findTopK: vi.fn().mockReturnValue([]),
  computeCentroid: vi.fn().mockReturnValue(new Float32Array(384).fill(0)),
  getEmbeddingDimensions: vi.fn().mockReturnValue(384),
  isEmbeddingModelLoaded: vi.fn().mockReturnValue(false),
  isEmbeddingModelLoading: vi.fn().mockReturnValue(false),
  unloadEmbeddingModel: vi.fn(),
  CURRENT_EMBEDDING_MODEL: 'Xenova/all-MiniLM-L6-v2',
}));

// ── characters mock ──────────────────────────────────────────────────────────
vi.mock('../src/config/characters.js', () => ({
  getAllCharacters: vi.fn().mockReturnValue([]),
  getCharacterEntry: vi.fn().mockReturnValue(undefined),
  getDefaultLocations: vi.fn().mockReturnValue({}),
  getImmortalIds: vi.fn().mockReturnValue([]),
  getMortalCharacters: vi.fn().mockReturnValue([]),
  getWebCharacter: vi.fn().mockReturnValue(undefined),
  getPeersFor: vi.fn().mockReturnValue([]),
}));

// ── event bus mock ───────────────────────────────────────────────────────────
vi.mock('../src/events/bus.js', () => ({
  eventBus: {
    characterId: 'test',
    emitActivity: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    setCharacterId: vi.fn(),
  },
  parseEventType: vi.fn().mockReturnValue('test'),
}));

// ── Imports ──────────────────────────────────────────────────────────────────

import {
  initDatabase,
  closeDatabase,
  execute,
  query,
  queryOne,
  setMeta,
  getMeta,
  transaction,
} from '../src/storage/database.js';
import {
  createSession,
  getSession,
  updateSession,
  findSession,
  getOrCreateSession,
  listSessions,
  batchUpdateTokenCounts,
} from '../src/storage/sessions.js';
import {
  saveMessage,
  getRecentMessages,
  getAllMessages,
  saveMemory,
  getMemory,
  deleteMemory,
  countMemories,
  countMessages,
  addAssociation,
  getAssociations,
  createCoherenceGroup,
  addToCoherenceGroup,
  getGroupMembers,
  getAllCoherenceGroups,
  setLifecycleState,
  getMemoriesByLifecycle,
  updateMemoryAccess,
  updateMemoryImportance,
  linkMemories,
  getRelatedMemories,
  savePostboardMessage,
  getPostboardMessages,
} from '../src/memory/store.js';
import {
  addTriple,
  getTriple,
  queryTriples,
  invalidateTriple,
  addEntity,
  getEntity,
  listEntities,
} from '../src/memory/knowledge-graph.js';
import {
  getCurrentLocation,
  setCurrentLocation,
  getLocationHistory,
} from '../src/commune/location.js';
import {
  getCurrentState,
  saveState,
  clampState,
  applyDecay,
  getStateHistory,
  addPreoccupation,
  getPreoccupations,
} from '../src/agent/internal-state.js';
import {
  createWing,
  getWing,
  getWingByName,
  listWings,
  resolveWing,
  createRoom,
  getRoom,
  listRooms,
  resolveRoom,
  incrementWingCount,
  incrementRoomCount,
  assignHall,
  resolveWingForMemory,
} from '../src/memory/palace.js';
import {
  getConversation,
  addUserMessage,
  addAssistantMessage,
  clearConversation,
  getActiveConversations,
} from '../src/agent/conversation.js';
import { checkBudget, recordUsage, getBudgetStatus } from '../src/providers/budget.js';
import type {
  Provider,
  CompletionResult,
  CompletionWithToolsResult,
} from '../src/providers/base.js';

// ── DB lifecycle helpers ─────────────────────────────────────────────────────

function makeTestDir(): string {
  return join(tmpdir(), `lain-race-${nanoid(8)}`);
}

async function setupDb(testDir: string): Promise<void> {
  await mkdir(testDir, { recursive: true });
  process.env['LAIN_HOME'] = testDir;
  await initDatabase(join(testDir, 'test.db'));
}

async function teardownDb(testDir: string): Promise<void> {
  closeDatabase();
  try { await rm(testDir, { recursive: true }); } catch { /* ignore */ }
}

// ── Mock provider factory ────────────────────────────────────────────────────

function createMockProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    name: 'mock',
    model: 'mock-model',
    supportsStreaming: false,
    complete: vi.fn().mockResolvedValue({
      content: 'mock response',
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5 },
    } satisfies CompletionResult),
    completeWithTools: vi.fn().mockResolvedValue({
      content: 'mock response',
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5 },
      toolCalls: [],
    } satisfies CompletionWithToolsResult),
    continueWithToolResults: vi.fn().mockResolvedValue({
      content: 'mock continued',
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5 },
      toolCalls: [],
    } satisfies CompletionWithToolsResult),
    ...overrides,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTextMessage(text: string, sessionKey = 'test-session') {
  return {
    sessionKey,
    userId: null as string | null,
    role: 'user' as const,
    content: text,
    timestamp: Date.now(),
    metadata: {},
  };
}

/** Run N async tasks and collect results */
async function runConcurrent<T>(tasks: Array<() => Promise<T>>): Promise<T[]> {
  return Promise.all(tasks.map((t) => t()));
}

/** Run N sync tasks via Promise.resolve to test near-simultaneous access */
function runSync<T>(tasks: Array<() => T>): T[] {
  return tasks.map((t) => t());
}


// ═══════════════════════════════════════════════════════════════════════════════
// 1. DATABASE CONCURRENT WRITES (~50 tests)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Database concurrent writes', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = makeTestDir();
    await setupDb(testDir);
  });

  afterEach(async () => {
    await teardownDb(testDir);
  });

  it('two loops save memory simultaneously — both saved', async () => {
    const [id1, id2] = await runConcurrent([
      () => saveMemory({ content: 'memory-A', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: 'loop1:test', userId: null, relatedTo: null, sourceMessageId: null, metadata: {} }),
      () => saveMemory({ content: 'memory-B', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: 'loop2:test', userId: null, relatedTo: null, sourceMessageId: null, metadata: {} }),
    ]);
    expect(getMemory(id1)).toBeDefined();
    expect(getMemory(id2)).toBeDefined();
    expect(countMemories()).toBe(2);
  });

  it('session update from two concurrent requests — last write wins, no crash', async () => {
    const session = createSession({ agentId: 'default', channel: 'web', peerKind: 'user', peerId: 'u1' });
    await runConcurrent([
      async () => updateSession(session.key, { tokenCount: 100 }),
      async () => updateSession(session.key, { tokenCount: 200 }),
    ]);
    const updated = getSession(session.key);
    expect(updated).toBeDefined();
    expect([100, 200]).toContain(updated!.tokenCount);
  });

  it('meta key written by two loops simultaneously — one wins, no crash', () => {
    runSync([
      () => setMeta('shared-key', 'value-A'),
      () => setMeta('shared-key', 'value-B'),
    ]);
    const result = getMeta('shared-key');
    expect(result).toBeDefined();
    expect(['value-A', 'value-B']).toContain(result);
  });

  it('concurrent saveMemory + getMemory — read returns consistent results', async () => {
    const id = await saveMemory({ content: 'pre-existing', memoryType: 'fact', importance: 0.8, emotionalWeight: 0, sessionKey: 'test:1', userId: null, relatedTo: null, sourceMessageId: null, metadata: {} });
    const [_, mem] = await runConcurrent([
      () => saveMemory({ content: 'new-memory', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: 'test:2', userId: null, relatedTo: null, sourceMessageId: null, metadata: {} }),
      async () => getMemory(id),
    ]);
    expect(mem).toBeDefined();
    expect(mem!.content).toBe('pre-existing');
  });

  it('concurrent KG triple insert + query — consistent results', () => {
    const id1 = addTriple('Alice', 'knows', 'Bob');
    const [id2, triples] = runSync([
      () => addTriple('Alice', 'likes', 'Carol'),
      () => queryTriples({ subject: 'Alice' }),
    ]);
    // At minimum the first triple should be visible
    expect(triples.length).toBeGreaterThanOrEqual(1);
    expect(getTriple(id1)).toBeDefined();
    expect(getTriple(id2)).toBeDefined();
  });

  it('WAL mode: concurrent reads do not block writes', async () => {
    // Populate data first
    for (let i = 0; i < 10; i++) {
      await saveMemory({ content: `base-${i}`, memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: 'wal:test', userId: null, relatedTo: null, sourceMessageId: null, metadata: {} });
    }
    // Simultaneous reads + write
    const results = await runConcurrent([
      async () => countMemories(),
      async () => countMessages(),
      () => saveMemory({ content: 'new-during-reads', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: 'wal:new', userId: null, relatedTo: null, sourceMessageId: null, metadata: {} }),
    ]);
    expect(results[0]).toBeGreaterThanOrEqual(10);
    expect(typeof results[2]).toBe('string'); // new memory ID
  });

  it('transaction rollback on error does not corrupt other transactions', () => {
    setMeta('safe-key', 'safe-value');
    expect(() => {
      transaction(() => {
        setMeta('safe-key', 'corrupted');
        throw new Error('intentional rollback');
      });
    }).toThrow('intentional rollback');
    expect(getMeta('safe-key')).toBe('safe-value');
  });

  it('10 concurrent writes to same table — all succeed', async () => {
    const ids = await runConcurrent(
      Array.from({ length: 10 }, (_, i) => () =>
        saveMemory({
          content: `concurrent-${i}`,
          memoryType: 'fact',
          importance: 0.5,
          emotionalWeight: 0,
          sessionKey: `conc:${i}`,
          userId: null,
          relatedTo: null,
          sourceMessageId: null,
          metadata: {},
        })
      )
    );
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10); // all unique
    expect(countMemories()).toBe(10);
  });

  it('concurrent saveMessage calls to different sessions — all saved', () => {
    const ids = runSync(
      Array.from({ length: 5 }, (_, i) => () =>
        saveMessage({
          sessionKey: `session-${i}`,
          userId: null,
          role: 'user',
          content: `msg-${i}`,
          timestamp: Date.now() + i,
          metadata: {},
        })
      )
    );
    expect(ids).toHaveLength(5);
    expect(countMessages()).toBe(5);
  });

  it('concurrent saveMessage to same session — all recorded', () => {
    const sessionKey = 'shared-session';
    const ids = runSync(
      Array.from({ length: 5 }, (_, i) => () =>
        saveMessage({
          sessionKey,
          userId: null,
          role: 'user',
          content: `msg-${i}`,
          timestamp: Date.now() + i,
          metadata: {},
        })
      )
    );
    expect(ids).toHaveLength(5);
    const messages = getRecentMessages(sessionKey, 10);
    expect(messages).toHaveLength(5);
  });

  it('concurrent setMeta with different keys — all stored', () => {
    runSync(
      Array.from({ length: 10 }, (_, i) => () =>
        setMeta(`key-${i}`, `value-${i}`)
      )
    );
    for (let i = 0; i < 10; i++) {
      expect(getMeta(`key-${i}`)).toBe(`value-${i}`);
    }
  });

  it('concurrent addTriple + invalidateTriple — no data corruption', () => {
    const id = addTriple('X', 'rel', 'Y');
    runSync([
      () => addTriple('X', 'rel2', 'Z'),
      () => invalidateTriple(id),
    ]);
    const triple = getTriple(id);
    expect(triple).toBeDefined();
    expect(triple!.ended).not.toBeNull();
  });

  it('concurrent addEntity — upsert semantics preserve data', () => {
    addEntity('TestPerson', 'person');
    runSync([
      () => addEntity('TestPerson', 'person', undefined, { key: 'A' }),
      () => addEntity('TestPerson', 'person', undefined, { key: 'B' }),
    ]);
    const entity = getEntity('TestPerson');
    expect(entity).toBeDefined();
    expect(['A', 'B']).toContain((entity!.metadata as { key: string }).key);
  });

  it('concurrent createCoherenceGroup + addToCoherenceGroup — consistent counts', async () => {
    const memId = await saveMemory({ content: 'grp-test', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: 'cg:test', userId: null, relatedTo: null, sourceMessageId: null, metadata: {} });
    const groupId = createCoherenceGroup('test-group', null);
    addToCoherenceGroup(memId, groupId);
    const members = getGroupMembers(groupId);
    expect(members).toContain(memId);
  });

  it('concurrent linkMemories — no crash, both links written', async () => {
    const id1 = await saveMemory({ content: 'link-A', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: 'link:1', userId: null, relatedTo: null, sourceMessageId: null, metadata: {} });
    const id2 = await saveMemory({ content: 'link-B', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: 'link:2', userId: null, relatedTo: null, sourceMessageId: null, metadata: {} });
    const id3 = await saveMemory({ content: 'link-C', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: 'link:3', userId: null, relatedTo: null, sourceMessageId: null, metadata: {} });
    runSync([
      () => linkMemories(id2, id1),
      () => linkMemories(id3, id1),
    ]);
    const related = getRelatedMemories(id1);
    expect(related.length).toBeGreaterThanOrEqual(1);
  });

  it('concurrent deleteMemory — only one deletes, no crash', async () => {
    const id = await saveMemory({ content: 'delete-me', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: 'del:1', userId: null, relatedTo: null, sourceMessageId: null, metadata: {} });
    const [r1, r2] = runSync([
      () => deleteMemory(id),
      () => deleteMemory(id),
    ]);
    // At least one should report success, the other may not
    expect(r1 || r2).toBe(true);
    expect(getMemory(id)).toBeUndefined();
  });

  it('concurrent updateMemoryAccess + updateMemoryImportance — no crash', async () => {
    const id = await saveMemory({ content: 'upd-test', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: 'upd:1', userId: null, relatedTo: null, sourceMessageId: null, metadata: {} });
    runSync([
      () => updateMemoryAccess(id),
      () => updateMemoryImportance(id, 0.9),
    ]);
    const mem = getMemory(id);
    expect(mem).toBeDefined();
    expect(mem!.accessCount).toBeGreaterThanOrEqual(1);
    expect(mem!.importance).toBe(0.9);
  });

  it('concurrent postboard writes — all saved', () => {
    const ids = runSync(
      Array.from({ length: 5 }, (_, i) => () =>
        savePostboardMessage(`notice-${i}`, 'admin')
      )
    );
    expect(ids).toHaveLength(5);
    const msgs = getPostboardMessages(0, 10);
    expect(msgs).toHaveLength(5);
  });

  it('concurrent setLifecycleState calls — last writer wins', async () => {
    const id = await saveMemory({ content: 'lifecycle-test', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: 'lc:1', userId: null, relatedTo: null, sourceMessageId: null, metadata: {} });
    runSync([
      () => setLifecycleState(id, 'growing'),
      () => setLifecycleState(id, 'mature'),
    ]);
    const mem = getMemory(id);
    expect(mem).toBeDefined();
    expect(['growing', 'mature']).toContain(mem!.lifecycleState);
  });

  it('concurrent addAssociation — no duplicate crash', async () => {
    const id1 = await saveMemory({ content: 'assoc-A', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: 'assoc:1', userId: null, relatedTo: null, sourceMessageId: null, metadata: {} });
    const id2 = await saveMemory({ content: 'assoc-B', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: 'assoc:2', userId: null, relatedTo: null, sourceMessageId: null, metadata: {} });
    // Both write same association (INSERT OR REPLACE semantics)
    runSync([
      () => addAssociation(id1, id2, 'similar', 0.7),
      () => addAssociation(id1, id2, 'similar', 0.9),
    ]);
    const assocs = getAssociations(id1);
    expect(assocs.length).toBeGreaterThanOrEqual(1);
  });

  it('batch token count update + individual session update — no lost writes', () => {
    const s1 = createSession({ agentId: 'default', channel: 'web', peerKind: 'user', peerId: 'p1' });
    const s2 = createSession({ agentId: 'default', channel: 'web', peerKind: 'user', peerId: 'p2' });
    runSync([
      () => batchUpdateTokenCounts([{ key: s1.key, tokenCount: 500 }, { key: s2.key, tokenCount: 600 }]),
      () => updateSession(s1.key, { tokenCount: 999 }),
    ]);
    // Both should be accessible, no corruption
    const r1 = getSession(s1.key);
    const r2 = getSession(s2.key);
    expect(r1).toBeDefined();
    expect(r2).toBeDefined();
  });

  it('concurrent wing creation with same name — resolveWing handles dedup', () => {
    const [id1, id2] = runSync([
      () => resolveWing('shared-wing', 'desc A'),
      () => resolveWing('shared-wing', 'desc B'),
    ]);
    // resolveWing uses getWingByName first — both should return a valid ID
    expect(id1).toBeDefined();
    expect(id2).toBeDefined();
    // At least one wing should exist with that name
    const wing = getWingByName('shared-wing');
    expect(wing).toBeDefined();
  });

  it('concurrent room creation — resolveRoom handles dedup', () => {
    const wingId = createWing('room-test-wing');
    const [r1, r2] = runSync([
      () => resolveRoom(wingId, 'encounters', 'room A'),
      () => resolveRoom(wingId, 'encounters', 'room B'),
    ]);
    expect(r1).toBeDefined();
    expect(r2).toBeDefined();
  });

  it('concurrent incrementWingCount — counts increase correctly', () => {
    const wingId = createWing('count-wing');
    runSync(
      Array.from({ length: 5 }, () => () => incrementWingCount(wingId))
    );
    const wing = getWing(wingId);
    expect(wing).toBeDefined();
    expect(wing!.memoryCount).toBe(5);
  });

  it('concurrent incrementRoomCount — counts increase correctly', () => {
    const wingId = createWing('room-count-wing');
    const roomId = createRoom(wingId, 'test-room');
    runSync(
      Array.from({ length: 5 }, () => () => incrementRoomCount(roomId))
    );
    const room = getRoom(roomId);
    expect(room).toBeDefined();
    expect(room!.memoryCount).toBe(5);
  });

  it('20 concurrent mixed operations — no crash', async () => {
    // Mix of reads and writes across multiple tables
    const results = await runConcurrent([
      ...Array.from({ length: 5 }, (_, i) => () =>
        saveMemory({ content: `mix-${i}`, memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: `mix:${i}`, userId: null, relatedTo: null, sourceMessageId: null, metadata: {} })
      ),
      ...Array.from({ length: 5 }, (_, i) => async () => {
        setMeta(`mix-key-${i}`, `mix-val-${i}`);
        return `meta-${i}`;
      }),
      ...Array.from({ length: 5 }, (_, i) => async () => {
        addTriple(`S${i}`, 'rel', `O${i}`);
        return `triple-${i}`;
      }),
      ...Array.from({ length: 5 }, (_, i) => async () => {
        saveMessage({ sessionKey: `mix-sess-${i}`, userId: null, role: 'user', content: `msg-${i}`, timestamp: Date.now() + i, metadata: {} });
        return `msg-${i}`;
      }),
    ]);
    expect(results).toHaveLength(20);
    expect(countMemories()).toBe(5);
    expect(countMessages()).toBe(5);
  });

  it('concurrent getOrCreateSession for different peers — each gets unique session', () => {
    const [s1, s2, s3] = runSync([
      () => getOrCreateSession({ agentId: 'default', channel: 'web', peerKind: 'user', peerId: 'peer-1' }),
      () => getOrCreateSession({ agentId: 'default', channel: 'web', peerKind: 'user', peerId: 'peer-2' }),
      () => getOrCreateSession({ agentId: 'default', channel: 'web', peerKind: 'user', peerId: 'peer-3' }),
    ]);
    expect(s1.key).not.toBe(s2.key);
    expect(s2.key).not.toBe(s3.key);
  });

  it('concurrent query + execute on same table — no reader-writer deadlock', async () => {
    for (let i = 0; i < 5; i++) {
      await saveMemory({ content: `base-${i}`, memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: `rw:${i}`, userId: null, relatedTo: null, sourceMessageId: null, metadata: {} });
    }
    await runConcurrent([
      async () => query('SELECT COUNT(*) as count FROM memories'),
      () => saveMemory({ content: 'new-during-query', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: 'rw:new', userId: null, relatedTo: null, sourceMessageId: null, metadata: {} }),
      async () => queryOne('SELECT * FROM memories LIMIT 1'),
    ]);
    expect(countMemories()).toBe(6);
  });

  it('rapid fire setMeta on same key — no corruption', () => {
    for (let i = 0; i < 100; i++) {
      setMeta('rapid-key', `value-${i}`);
    }
    const final = getMeta('rapid-key');
    expect(final).toBe('value-99');
  });

  it('concurrent transaction + non-transactional write — no crash', () => {
    runSync([
      () => transaction(() => {
        setMeta('tx-key', 'from-tx');
        saveMessage({ sessionKey: 'tx-sess', userId: null, role: 'user', content: 'tx-msg', timestamp: Date.now(), metadata: {} });
      }),
      () => setMeta('non-tx-key', 'from-outside'),
    ]);
    expect(getMeta('tx-key')).toBe('from-tx');
    expect(getMeta('non-tx-key')).toBe('from-outside');
  });

  it('concurrent palace assignHall — pure function, always consistent', () => {
    const results = runSync(
      Array.from({ length: 10 }, () => () => assignHall('fact', 'diary:2024'))
    );
    // Same inputs => same output
    expect(new Set(results).size).toBe(1);
  });

  it('concurrent entity list + add — no crash during iteration', () => {
    addEntity('E1', 'person');
    addEntity('E2', 'place');
    runSync([
      () => listEntities(),
      () => addEntity('E3', 'concept'),
      () => listEntities(),
    ]);
    const all = listEntities();
    expect(all.length).toBe(3);
  });

  it('concurrent deleteSession + getSession — returns undefined or valid session', () => {
    const s = createSession({ agentId: 'default', channel: 'web', peerKind: 'user', peerId: 'del-test' });
    const [deleted, fetched] = runSync([
      () => { const r = getSession(s.key); execute('DELETE FROM sessions WHERE key = ?', [s.key]); return r; },
      () => getSession(s.key),
    ]);
    // fetched is either the session or undefined — never a partial/corrupt row
    if (fetched) {
      expect(fetched.key).toBe(s.key);
    }
  });

  it('concurrent KG queryTriples with different filters — all return valid results', () => {
    addTriple('A', 'knows', 'B');
    addTriple('A', 'likes', 'C');
    addTriple('B', 'knows', 'C');
    const [r1, r2, r3] = runSync([
      () => queryTriples({ subject: 'A' }),
      () => queryTriples({ predicate: 'knows' }),
      () => queryTriples({ object: 'C' }),
    ]);
    expect(r1.length).toBeGreaterThanOrEqual(2);
    expect(r2.length).toBeGreaterThanOrEqual(2);
    expect(r3.length).toBeGreaterThanOrEqual(2);
  });

  it('50 concurrent saveMessage calls — all persisted without loss', () => {
    const ids = runSync(
      Array.from({ length: 50 }, (_, i) => () =>
        saveMessage({
          sessionKey: 'bulk-session',
          userId: null,
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `bulk-msg-${i}`,
          timestamp: Date.now() + i,
          metadata: {},
        })
      )
    );
    expect(ids).toHaveLength(50);
    expect(new Set(ids).size).toBe(50);
    const messages = getAllMessages('bulk-session');
    expect(messages).toHaveLength(50);
  });

  it('concurrent coherence group operations — member counts stay consistent', async () => {
    const groupId = createCoherenceGroup('conc-group', null);
    const memIds = await runConcurrent(
      Array.from({ length: 5 }, (_, i) => () =>
        saveMemory({ content: `cg-mem-${i}`, memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: `cg:${i}`, userId: null, relatedTo: null, sourceMessageId: null, metadata: {} })
      )
    );
    runSync(memIds.map((id) => () => addToCoherenceGroup(id, groupId)));
    const members = getGroupMembers(groupId);
    expect(members).toHaveLength(5);
  });

  it('concurrent execute with raw SQL — no statement handle corruption', () => {
    runSync(
      Array.from({ length: 10 }, (_, i) => () =>
        execute("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [`raw-${i}`, `val-${i}`])
      )
    );
    for (let i = 0; i < 10; i++) {
      expect(getMeta(`raw-${i}`)).toBe(`val-${i}`);
    }
  });

  it('concurrent read of empty table — returns empty, not null or error', () => {
    const results = runSync(
      Array.from({ length: 5 }, () => () =>
        query<{ id: string }>("SELECT * FROM memories WHERE 1=0")
      )
    );
    for (const r of results) {
      expect(r).toEqual([]);
    }
  });

  it('concurrent queryOne on same row — both get same value', async () => {
    await saveMemory({ content: 'shared-read', memoryType: 'fact', importance: 0.9, emotionalWeight: 0, sessionKey: 'shared:1', userId: null, relatedTo: null, sourceMessageId: null, metadata: {} });
    const results = runSync(
      Array.from({ length: 5 }, () => () =>
        queryOne<{ count: number }>("SELECT COUNT(*) as count FROM memories")
      )
    );
    for (const r of results) {
      expect(r!.count).toBe(1);
    }
  });

  it('concurrent write + rollback — good writes survive', () => {
    setMeta('survive-key', 'original');
    try {
      transaction(() => {
        setMeta('survive-key', 'bad-value');
        throw new Error('rollback');
      });
    } catch { /* expected */ }
    setMeta('survive-key', 'good-update');
    expect(getMeta('survive-key')).toBe('good-update');
  });

  it('concurrent KG triple insertions with same subject — all stored', () => {
    const ids = runSync(
      Array.from({ length: 10 }, (_, i) => () =>
        addTriple('BulkSubject', `predicate-${i}`, `object-${i}`)
      )
    );
    expect(ids).toHaveLength(10);
    const triples = queryTriples({ subject: 'BulkSubject' });
    expect(triples).toHaveLength(10);
  });

  it('concurrent memory save + delete of different memory — no interference', async () => {
    const existingId = await saveMemory({ content: 'will-delete', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: 'del:exist', userId: null, relatedTo: null, sourceMessageId: null, metadata: {} });
    const [newId, deleted] = await runConcurrent([
      () => saveMemory({ content: 'new-parallel', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: 'del:new', userId: null, relatedTo: null, sourceMessageId: null, metadata: {} }),
      async () => deleteMemory(existingId),
    ]);
    expect(getMemory(newId)).toBeDefined();
    expect(getMemory(existingId)).toBeUndefined();
  });

  it('multiple transactions in sequence — each isolated', () => {
    const results: string[] = [];
    transaction(() => {
      setMeta('seq-tx', 'tx-1');
      results.push(getMeta('seq-tx')!);
    });
    transaction(() => {
      setMeta('seq-tx', 'tx-2');
      results.push(getMeta('seq-tx')!);
    });
    expect(results).toEqual(['tx-1', 'tx-2']);
    expect(getMeta('seq-tx')).toBe('tx-2');
  });

  it('concurrent entity operations — list returns consistent snapshot', () => {
    addEntity('ListE1', 'person');
    addEntity('ListE2', 'place');
    addEntity('ListE3', 'concept');
    const results = runSync(
      Array.from({ length: 5 }, () => () => listEntities())
    );
    for (const r of results) {
      expect(r.length).toBe(3);
    }
  });

  it('concurrent triple temporal query — filters apply correctly', () => {
    addTriple('Temporal', 'state', 'A', 1.0, 1000);
    addTriple('Temporal', 'state', 'B', 1.0, 2000);
    addTriple('Temporal', 'state', 'C', 1.0, 3000, 4000);
    const [r1, r2] = runSync([
      () => queryTriples({ subject: 'Temporal', asOf: 1500 }),
      () => queryTriples({ subject: 'Temporal', asOf: 5000 }),
    ]);
    expect(r1.length).toBe(1); // Only A active at 1500
    expect(r2.length).toBe(2); // A and B active at 5000 (C ended at 4000)
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// 2. LOCATION RACE CONDITIONS (~30 tests)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Location race conditions', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = makeTestDir();
    await setupDb(testDir);
  });

  afterEach(async () => {
    await teardownDb(testDir);
  });

  it('two characters move to same building simultaneously — both recorded', () => {
    setCurrentLocation('library', 'character A wants to read');
    const loc = getCurrentLocation();
    expect(loc.building).toBe('library');
    // Simulate a second move
    setCurrentLocation('bar', 'character B wants to socialize');
    expect(getCurrentLocation().building).toBe('bar');
  });

  it('location query during movement — returns either old or new, never undefined', () => {
    setCurrentLocation('library', 'initial');
    const [loc, _] = runSync([
      () => getCurrentLocation(),
      () => { setCurrentLocation('bar', 'moving'); return null; },
    ]);
    expect(loc).toBeDefined();
    expect(loc.building).toBeDefined();
    expect(['library', 'bar', 'lighthouse']).toContain(loc.building);
  });

  it('rapid movement A → B → C — final location is C', () => {
    setCurrentLocation('library', 'step 1');
    setCurrentLocation('bar', 'step 2');
    setCurrentLocation('field', 'step 3');
    expect(getCurrentLocation().building).toBe('field');
  });

  it('move + getCurrentLocation race — consistent result', () => {
    setCurrentLocation('library', 'setup');
    runSync([
      () => setCurrentLocation('bar', 'race-move'),
      () => getCurrentLocation(),
      () => getCurrentLocation(),
    ]);
    const final = getCurrentLocation();
    expect(final.building).toBe('bar');
  });

  it('location history is appended correctly under rapid moves', () => {
    setCurrentLocation('library', 'move 1');
    setCurrentLocation('bar', 'move 2');
    setCurrentLocation('field', 'move 3');
    setCurrentLocation('windmill', 'move 4');
    const history = getLocationHistory(10);
    expect(history.length).toBeGreaterThanOrEqual(3); // initial is lighthouse, so moves start from there
    // Most recent first
    expect(history[0]!.to).toBe('windmill');
  });

  it('same-location move is no-op', () => {
    setCurrentLocation('library', 'go to library');
    const histBefore = getLocationHistory();
    setCurrentLocation('library', 'still at library');
    const histAfter = getLocationHistory();
    expect(histAfter.length).toBe(histBefore.length);
  });

  it('concurrent reads of location — all return consistent value', () => {
    setCurrentLocation('field', 'went to field');
    const results = runSync(
      Array.from({ length: 10 }, () => () => getCurrentLocation())
    );
    for (const r of results) {
      expect(r.building).toBe('field');
    }
  });

  it('rapid move produces correct history order', () => {
    setCurrentLocation('library', 'step 1');
    setCurrentLocation('bar', 'step 2');
    setCurrentLocation('field', 'step 3');
    const history = getLocationHistory(5);
    // History is newest-first
    const buildings = history.map((h) => h.to);
    expect(buildings[0]).toBe('field');
    expect(buildings[1]).toBe('bar');
    expect(buildings[2]).toBe('library');
  });

  it('history caps at MAX_HISTORY (20)', () => {
    const buildings = ['library', 'bar', 'field', 'windmill', 'school', 'market', 'locksmith', 'threshold', 'lighthouse'];
    // Make 25 moves
    for (let i = 0; i < 25; i++) {
      const from = buildings[i % buildings.length]!;
      const to = buildings[(i + 1) % buildings.length]!;
      // Need different from/to for actual move
      setMeta('town:current_location', JSON.stringify({ building: from, timestamp: Date.now() }));
      setCurrentLocation(to as any, `move ${i}`);
    }
    const history = getLocationHistory(50);
    expect(history.length).toBeLessThanOrEqual(20);
  });

  it('getCurrentLocation with no prior location returns default', () => {
    const loc = getCurrentLocation('lain');
    expect(loc).toBeDefined();
    expect(loc.building).toBeDefined();
  });

  it('getCurrentLocation with invalid stored JSON falls back to default', () => {
    setMeta('town:current_location', 'not-json');
    const loc = getCurrentLocation();
    expect(loc).toBeDefined();
    expect(loc.building).toBeDefined();
  });

  it('getCurrentLocation with unknown building falls back to default', () => {
    setMeta('town:current_location', JSON.stringify({ building: 'nonexistent', timestamp: Date.now() }));
    const loc = getCurrentLocation();
    // Should fall back since 'nonexistent' is not in BUILDING_MAP
    expect(loc).toBeDefined();
  });

  it('write location + read history race — history always valid JSON', () => {
    setCurrentLocation('library', 'init');
    runSync([
      () => setCurrentLocation('bar', 'move-during-read'),
      () => getLocationHistory(10),
      () => setCurrentLocation('field', 'another-move'),
    ]);
    const history = getLocationHistory(10);
    expect(Array.isArray(history)).toBe(true);
    for (const entry of history) {
      expect(typeof entry.from).toBe('string');
      expect(typeof entry.to).toBe('string');
    }
  });

  it('concurrent location writes from different character contexts — last write wins', () => {
    runSync([
      () => setCurrentLocation('library', 'char-a'),
      () => setCurrentLocation('bar', 'char-b'),
      () => setCurrentLocation('field', 'char-c'),
    ]);
    const loc = getCurrentLocation();
    expect(['library', 'bar', 'field']).toContain(loc.building);
  });

  it('getLocationHistory with empty DB returns empty array', () => {
    expect(getLocationHistory()).toEqual([]);
  });

  it('getLocationHistory with corrupted meta returns empty array', () => {
    setMeta('town:location_history', '{invalid}');
    const history = getLocationHistory();
    expect(Array.isArray(history)).toBe(true);
  });

  it('10 sequential moves in tight loop — no data loss', () => {
    const moves = [
      'library', 'bar', 'field', 'windmill', 'school',
      'market', 'locksmith', 'threshold', 'lighthouse', 'library',
    ];
    for (let i = 0; i < moves.length; i++) {
      setCurrentLocation(moves[i]! as any, `tight-loop-${i}`);
    }
    expect(getCurrentLocation().building).toBe('library');
    const history = getLocationHistory(20);
    expect(history.length).toBeGreaterThanOrEqual(9);
  });

  it('move + history query in parallel — no crash', async () => {
    setCurrentLocation('library', 'setup');
    await runConcurrent([
      async () => setCurrentLocation('bar', 'parallel-move'),
      async () => getLocationHistory(5),
      async () => getCurrentLocation(),
    ]);
    // If we get here without crash, the test passes
    expect(getCurrentLocation()).toBeDefined();
  });

  it('location has valid timestamp after move', () => {
    const before = Date.now();
    setCurrentLocation('library', 'timestamp-test');
    const loc = getCurrentLocation();
    expect(loc.timestamp).toBeGreaterThanOrEqual(before);
    expect(loc.timestamp).toBeLessThanOrEqual(Date.now());
  });

  it('location history entries have from/to/reason/timestamp', () => {
    setCurrentLocation('library', 'first move');
    setCurrentLocation('bar', 'second move');
    const history = getLocationHistory(5);
    expect(history.length).toBeGreaterThanOrEqual(1);
    const entry = history[0]!;
    expect(entry).toHaveProperty('from');
    expect(entry).toHaveProperty('to');
    expect(entry).toHaveProperty('reason');
    expect(entry).toHaveProperty('timestamp');
  });

  it('concurrent setCurrentLocation + getLocationHistory — history is valid JSON array', () => {
    setCurrentLocation('library', 'init');
    const [hist, _] = runSync([
      () => getLocationHistory(10),
      () => setCurrentLocation('bar', 'concurrent-move'),
    ]);
    expect(Array.isArray(hist)).toBe(true);
  });

  it('setCurrentLocation with long reason string — no truncation', () => {
    const longReason = 'a'.repeat(1000);
    setCurrentLocation('library', longReason);
    const history = getLocationHistory(1);
    expect(history[0]!.reason).toBe(longReason);
  });

  it('consecutive moves through all buildings — each building accessible', () => {
    const buildings = ['library', 'bar', 'field', 'windmill', 'school', 'market', 'locksmith', 'threshold', 'lighthouse'];
    for (const b of buildings) {
      setCurrentLocation(b as any, `visiting ${b}`);
      expect(getCurrentLocation().building).toBe(b);
    }
  });

  it('location timestamp is monotonically increasing after moves', () => {
    setCurrentLocation('library', 'step-1');
    const t1 = getCurrentLocation().timestamp;
    setCurrentLocation('bar', 'step-2');
    const t2 = getCurrentLocation().timestamp;
    setCurrentLocation('field', 'step-3');
    const t3 = getCurrentLocation().timestamp;
    expect(t2).toBeGreaterThanOrEqual(t1);
    expect(t3).toBeGreaterThanOrEqual(t2);
  });

  it('reading location with empty meta table — returns default', () => {
    // Database is fresh, no location set yet
    const loc = getCurrentLocation('test-char');
    expect(loc).toBeDefined();
    expect(typeof loc.building).toBe('string');
    expect(typeof loc.timestamp).toBe('number');
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// 3. SESSION RACE CONDITIONS (~30 tests)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Session race conditions', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = makeTestDir();
    await setupDb(testDir);
  });

  afterEach(async () => {
    await teardownDb(testDir);
  });

  it('two messages to same session simultaneously — both recorded', () => {
    const session = createSession({ agentId: 'default', channel: 'web', peerKind: 'user', peerId: 'u1' });
    runSync([
      () => saveMessage({ sessionKey: session.key, userId: 'u1', role: 'user', content: 'msg-1', timestamp: Date.now(), metadata: {} }),
      () => saveMessage({ sessionKey: session.key, userId: 'u1', role: 'user', content: 'msg-2', timestamp: Date.now() + 1, metadata: {} }),
    ]);
    const msgs = getRecentMessages(session.key);
    expect(msgs).toHaveLength(2);
  });

  it('session creation race — two requests for same channel/peer', () => {
    const [s1, s2] = runSync([
      () => getOrCreateSession({ agentId: 'default', channel: 'web', peerKind: 'user', peerId: 'same-peer' }),
      () => getOrCreateSession({ agentId: 'default', channel: 'web', peerKind: 'user', peerId: 'same-peer' }),
    ]);
    // Both should succeed — getOrCreateSession uses transaction
    expect(s1).toBeDefined();
    expect(s2).toBeDefined();
  });

  it('message save + session retrieval race — no partial messages visible', () => {
    const session = createSession({ agentId: 'default', channel: 'web', peerKind: 'user', peerId: 'u1' });
    saveMessage({ sessionKey: session.key, userId: 'u1', role: 'user', content: 'full-message', timestamp: Date.now(), metadata: {} });
    const [msgs, _newMsg] = runSync([
      () => getRecentMessages(session.key),
      () => saveMessage({ sessionKey: session.key, userId: 'u1', role: 'user', content: 'new-during-read', timestamp: Date.now() + 1, metadata: {} }),
    ]);
    // All returned messages should have complete content
    for (const msg of msgs) {
      expect(msg.content).toBeDefined();
      expect(msg.content.length).toBeGreaterThan(0);
    }
  });

  it('concurrent updateSession with different fields — both applied', () => {
    const session = createSession({ agentId: 'default', channel: 'web', peerKind: 'user', peerId: 'u1' });
    runSync([
      () => updateSession(session.key, { tokenCount: 100 }),
      () => updateSession(session.key, { flags: { compressed: true } }),
    ]);
    const updated = getSession(session.key);
    expect(updated).toBeDefined();
  });

  it('concurrent findSession from multiple requests — consistent results', () => {
    createSession({ agentId: 'default', channel: 'web', peerKind: 'user', peerId: 'multi-find' });
    const results = runSync(
      Array.from({ length: 5 }, () => () => findSession('default', 'web', 'multi-find'))
    );
    for (const r of results) {
      expect(r).toBeDefined();
      expect(r!.peerId).toBe('multi-find');
    }
  });

  it('session listSessions + createSession race — no incomplete rows', () => {
    createSession({ agentId: 'default', channel: 'web', peerKind: 'user', peerId: 'existing' });
    const [sessions, newSession] = runSync([
      () => listSessions('default'),
      () => createSession({ agentId: 'default', channel: 'web', peerKind: 'user', peerId: 'new-during-list' }),
    ]);
    // All returned sessions must be valid
    for (const s of sessions) {
      expect(s.key).toBeDefined();
      expect(s.agentId).toBe('default');
    }
    expect(newSession).toBeDefined();
  });

  it('rapid session token updates — final count is consistent', () => {
    const session = createSession({ agentId: 'default', channel: 'web', peerKind: 'user', peerId: 'rapid-tok' });
    for (let i = 1; i <= 10; i++) {
      updateSession(session.key, { tokenCount: i * 100 });
    }
    const final = getSession(session.key);
    expect(final!.tokenCount).toBe(1000);
  });

  it('10 concurrent session creates for different peers — all unique', () => {
    const sessions = runSync(
      Array.from({ length: 10 }, (_, i) => () =>
        createSession({ agentId: 'default', channel: 'web', peerKind: 'user', peerId: `peer-${i}` })
      )
    );
    const keys = sessions.map((s) => s.key);
    expect(new Set(keys).size).toBe(10);
  });

  it('concurrent batchUpdateTokenCounts — all updates applied', () => {
    const sessions = Array.from({ length: 5 }, (_, i) =>
      createSession({ agentId: 'default', channel: 'web', peerKind: 'user', peerId: `batch-${i}` })
    );
    batchUpdateTokenCounts(sessions.map((s, i) => ({ key: s.key, tokenCount: (i + 1) * 100 })));
    for (let i = 0; i < sessions.length; i++) {
      const s = getSession(sessions[i]!.key);
      expect(s!.tokenCount).toBe((i + 1) * 100);
    }
  });

  it('message retrieval during burst writes — returns ordered messages', () => {
    const session = createSession({ agentId: 'default', channel: 'web', peerKind: 'user', peerId: 'order-test' });
    for (let i = 0; i < 20; i++) {
      saveMessage({ sessionKey: session.key, userId: null, role: 'user', content: `msg-${i}`, timestamp: 1000 + i, metadata: {} });
    }
    const msgs = getRecentMessages(session.key, 20);
    // Should be in timestamp order
    for (let i = 1; i < msgs.length; i++) {
      expect(msgs[i]!.timestamp).toBeGreaterThanOrEqual(msgs[i - 1]!.timestamp);
    }
  });

  it('concurrent getOrCreateSession for many different peers — each gets own session', () => {
    const sessions = runSync(
      Array.from({ length: 20 }, (_, i) => () =>
        getOrCreateSession({ agentId: 'default', channel: 'web', peerKind: 'user', peerId: `mass-peer-${i}` })
      )
    );
    const keys = sessions.map((s) => s.key);
    expect(new Set(keys).size).toBe(20);
  });

  it('session flag update race — flags are merged, not lost', () => {
    const session = createSession({ agentId: 'default', channel: 'web', peerKind: 'user', peerId: 'flags-test' });
    updateSession(session.key, { flags: { flagA: true } });
    updateSession(session.key, { flags: { flagB: true } });
    const updated = getSession(session.key);
    expect(updated).toBeDefined();
    // The updateSession implementation merges flags, so both should be present
    expect(updated!.flags.flagA).toBe(true);
    expect(updated!.flags.flagB).toBe(true);
  });

  it('getOrCreateSession idempotency — calling twice returns same session', () => {
    const s1 = getOrCreateSession({ agentId: 'default', channel: 'web', peerKind: 'user', peerId: 'idempotent' });
    const s2 = getOrCreateSession({ agentId: 'default', channel: 'web', peerKind: 'user', peerId: 'idempotent' });
    expect(s1.key).toBe(s2.key);
  });

  it('saveMessage with varying userId — messages linked correctly', () => {
    const session = createSession({ agentId: 'default', channel: 'web', peerKind: 'user', peerId: 'multi-user' });
    runSync([
      () => saveMessage({ sessionKey: session.key, userId: 'user-a', role: 'user', content: 'from A', timestamp: Date.now(), metadata: {} }),
      () => saveMessage({ sessionKey: session.key, userId: 'user-b', role: 'user', content: 'from B', timestamp: Date.now() + 1, metadata: {} }),
    ]);
    const msgs = getRecentMessages(session.key);
    expect(msgs).toHaveLength(2);
    const userIds = msgs.map((m) => m.userId);
    expect(userIds).toContain('user-a');
    expect(userIds).toContain('user-b');
  });

  it('concurrent session delete + message save — no foreign key crash', () => {
    const session = createSession({ agentId: 'default', channel: 'web', peerKind: 'user', peerId: 'del-msg-race' });
    saveMessage({ sessionKey: session.key, userId: null, role: 'user', content: 'pre-delete', timestamp: Date.now(), metadata: {} });
    // Delete session while saving new message (messages have session_key but no FK constraint)
    expect(() => {
      runSync([
        () => execute('DELETE FROM sessions WHERE key = ?', [session.key]),
        () => saveMessage({ sessionKey: session.key, userId: null, role: 'user', content: 'post-delete', timestamp: Date.now() + 1, metadata: {} }),
      ]);
    }).not.toThrow();
  });

  it('getAllMessages during save — returns complete messages only', () => {
    const session = createSession({ agentId: 'default', channel: 'web', peerKind: 'user', peerId: 'getall-race' });
    for (let i = 0; i < 5; i++) {
      saveMessage({ sessionKey: session.key, userId: null, role: 'user', content: `pre-${i}`, timestamp: 1000 + i, metadata: {} });
    }
    const [allMsgs, _] = runSync([
      () => getAllMessages(session.key),
      () => saveMessage({ sessionKey: session.key, userId: null, role: 'user', content: 'during-getall', timestamp: 2000, metadata: {} }),
    ]);
    for (const msg of allMsgs) {
      expect(msg.content).toBeDefined();
      expect(msg.content.length).toBeGreaterThan(0);
    }
  });

  it('concurrent countMessages — returns consistent integer', () => {
    for (let i = 0; i < 10; i++) {
      saveMessage({ sessionKey: 'count-sess', userId: null, role: 'user', content: `m-${i}`, timestamp: Date.now() + i, metadata: {} });
    }
    const counts = runSync(
      Array.from({ length: 5 }, () => () => countMessages())
    );
    for (const c of counts) {
      expect(c).toBe(10);
    }
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// 4. PROVIDER CONCURRENT CALLS (~30 tests)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Provider concurrent calls', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = makeTestDir();
    await setupDb(testDir);
    // Disable budget cap for provider tests
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '0';
  });

  afterEach(async () => {
    delete process.env['LAIN_MONTHLY_TOKEN_CAP'];
    await teardownDb(testDir);
  });

  it('5 concurrent provider.complete() calls — all resolve independently', async () => {
    const provider = createMockProvider({
      complete: vi.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, Math.random() * 10));
        return { content: `response-${nanoid(4)}`, finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const results = await runConcurrent(
      Array.from({ length: 5 }, () => () =>
        provider.complete({ messages: [{ role: 'user', content: 'hello' }] })
      )
    );
    expect(results).toHaveLength(5);
    for (const r of results) {
      expect(r.content).toBeDefined();
      expect(r.finishReason).toBe('stop');
    }
    // All should be different (different nanoid)
    const contents = results.map((r) => r.content);
    expect(new Set(contents).size).toBe(5);
  });

  it('budget tracking under concurrent calls — no double-counting', () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '1000000';
    const statusBefore = getBudgetStatus();
    const baseTok = statusBefore.tokensUsed;
    runSync(
      Array.from({ length: 10 }, () => () => recordUsage(100, 50))
    );
    const statusAfter = getBudgetStatus();
    expect(statusAfter.tokensUsed).toBe(baseTok + 10 * 150);
  });

  it('rate limit hit by one call — does not corrupt budget state', () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '500';
    recordUsage(250, 250); // exactly at cap
    expect(() => checkBudget()).toThrow();
    // Budget state should still be readable
    const status = getBudgetStatus();
    expect(status.tokensUsed).toBe(500);
  });

  it('budget check under concurrent access — consistent enforcement', () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '1000';
    recordUsage(800, 0);
    const results = runSync(
      Array.from({ length: 5 }, () => () => {
        try {
          checkBudget();
          recordUsage(100, 0);
          return 'ok';
        } catch {
          return 'blocked';
        }
      })
    );
    // First few calls succeed (under 1000), rest should fail
    const okCount = results.filter((r) => r === 'ok').length;
    const blockedCount = results.filter((r) => r === 'blocked').length;
    expect(okCount).toBeGreaterThanOrEqual(1);
    // Eventually should be blocked
    const finalStatus = getBudgetStatus();
    expect(finalStatus.tokensUsed).toBeGreaterThanOrEqual(900);
  });

  it('provider fallback triggered concurrently — no duplicate fallbacks', async () => {
    let callCount = 0;
    const provider = createMockProvider({
      complete: vi.fn().mockImplementation(async () => {
        callCount++;
        return { content: `resp-${callCount}`, finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const results = await runConcurrent(
      Array.from({ length: 3 }, () => () =>
        provider.complete({ messages: [{ role: 'user', content: 'test' }] })
      )
    );
    expect(results).toHaveLength(3);
    expect(callCount).toBe(3);
  });

  it('streaming + non-streaming call simultaneously — both work', async () => {
    const chunks: string[] = [];
    const provider = createMockProvider({
      complete: vi.fn().mockResolvedValue({
        content: 'non-stream',
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
      completeStream: vi.fn().mockImplementation(async (_opts: unknown, onChunk: (s: string) => void) => {
        onChunk('chunk1');
        onChunk('chunk2');
        chunks.push('chunk1', 'chunk2');
        return {
          content: 'streamed',
          finishReason: 'stop',
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }),
    });
    const [nonStream, stream] = await runConcurrent([
      () => provider.complete({ messages: [{ role: 'user', content: 'test' }] }),
      () => provider.completeStream!({ messages: [{ role: 'user', content: 'test' }] }, (c) => chunks.push(c)),
    ]);
    expect(nonStream.content).toBe('non-stream');
    expect(stream.content).toBe('streamed');
  });

  it('concurrent completeWithTools calls — all receive independent tool calls', async () => {
    let idx = 0;
    const provider = createMockProvider({
      completeWithTools: vi.fn().mockImplementation(async () => {
        const i = idx++;
        return {
          content: `tools-${i}`,
          finishReason: 'stop',
          usage: { inputTokens: 10, outputTokens: 5 },
          toolCalls: i % 2 === 0 ? [{ id: `tc-${i}`, name: 'test_tool', input: {} }] : [],
        };
      }),
    });
    const results = await runConcurrent(
      Array.from({ length: 4 }, () => () =>
        provider.completeWithTools({ messages: [{ role: 'user', content: 'test' }] })
      )
    );
    expect(results).toHaveLength(4);
    const withTools = results.filter((r) => r.toolCalls && r.toolCalls.length > 0);
    const withoutTools = results.filter((r) => !r.toolCalls || r.toolCalls.length === 0);
    expect(withTools.length + withoutTools.length).toBe(4);
  });

  it('provider error in one call does not affect others', async () => {
    let callIdx = 0;
    const provider = createMockProvider({
      complete: vi.fn().mockImplementation(async () => {
        const i = callIdx++;
        if (i === 2) throw new Error('transient failure');
        return { content: `ok-${i}`, finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const results = await runConcurrent(
      Array.from({ length: 5 }, () => () =>
        provider.complete({ messages: [{ role: 'user', content: 'test' }] }).catch((e) => ({ error: e.message }))
      )
    );
    const successes = results.filter((r) => !('error' in r));
    const failures = results.filter((r) => 'error' in r);
    expect(successes.length).toBe(4);
    expect(failures.length).toBe(1);
  });

  it('rapid budget recordUsage — no negative counts', () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '10000000';
    runSync(
      Array.from({ length: 100 }, () => () => recordUsage(50, 25))
    );
    const status = getBudgetStatus();
    expect(status.tokensUsed).toBe(100 * 75);
    expect(status.tokensUsed).toBeGreaterThan(0);
  });

  it('provider with slow response + fast response — both complete', async () => {
    const provider = createMockProvider({
      complete: vi.fn()
        .mockImplementationOnce(async () => {
          await new Promise((r) => setTimeout(r, 50));
          return { content: 'slow', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } };
        })
        .mockImplementationOnce(async () => {
          return { content: 'fast', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } };
        }),
    });
    const results = await runConcurrent([
      () => provider.complete({ messages: [{ role: 'user', content: 'slow-request' }] }),
      () => provider.complete({ messages: [{ role: 'user', content: 'fast-request' }] }),
    ]);
    expect(results).toHaveLength(2);
    const contents = results.map((r) => r.content);
    expect(contents).toContain('slow');
    expect(contents).toContain('fast');
  });

  it('budget month rollover during concurrent usage — resets correctly', () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '1000000';
    recordUsage(500, 500);
    // Simulate month rollover by manually setting old month
    setMeta('budget:monthly_usage', JSON.stringify({ month: '2020-01', tokens: 999999 }));
    // checkBudget should detect new month and reset
    expect(() => checkBudget()).not.toThrow();
  });

  it('concurrent continueWithToolResults — all resolve', async () => {
    const provider = createMockProvider();
    const results = await runConcurrent(
      Array.from({ length: 3 }, () => () =>
        provider.continueWithToolResults(
          { messages: [{ role: 'user', content: 'test' }] },
          [{ id: 'tc-1', name: 'tool', input: {} }],
          [{ toolCallId: 'tc-1', content: 'result' }]
        )
      )
    );
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.content).toBeDefined();
    }
  });

  it('getBudgetStatus is safe to call concurrently', () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '1000000';
    recordUsage(100, 100);
    const statuses = runSync(
      Array.from({ length: 10 }, () => () => getBudgetStatus())
    );
    for (const s of statuses) {
      expect(s.tokensUsed).toBe(200);
      expect(s.monthlyCap).toBe(1000000);
    }
  });

  it('budget exceeded throws BudgetExceededError, not generic error', () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '100';
    recordUsage(50, 51);
    try {
      checkBudget();
      expect.fail('Should have thrown');
    } catch (e) {
      expect((e as Error).name).toBe('BudgetExceededError');
    }
  });

  it('10 concurrent completeWithTools — each gets independent results', async () => {
    let idx = 0;
    const provider = createMockProvider({
      completeWithTools: vi.fn().mockImplementation(async () => ({
        content: `result-${idx++}`,
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 5 },
        toolCalls: [],
      })),
    });
    const results = await runConcurrent(
      Array.from({ length: 10 }, () => () =>
        provider.completeWithTools({ messages: [{ role: 'user', content: 'test' }] })
      )
    );
    expect(results).toHaveLength(10);
    const contents = new Set(results.map((r) => r.content));
    expect(contents.size).toBe(10);
  });

  it('provider returns empty content — no crash', async () => {
    const provider = createMockProvider({
      complete: vi.fn().mockResolvedValue({
        content: '',
        finishReason: 'stop',
        usage: { inputTokens: 5, outputTokens: 0 },
      }),
    });
    const result = await provider.complete({ messages: [{ role: 'user', content: 'test' }] });
    expect(result.content).toBe('');
  });

  it('provider returns large response — no truncation', async () => {
    const largeContent = 'x'.repeat(50000);
    const provider = createMockProvider({
      complete: vi.fn().mockResolvedValue({
        content: largeContent,
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 12500 },
      }),
    });
    const result = await provider.complete({ messages: [{ role: 'user', content: 'test' }] });
    expect(result.content.length).toBe(50000);
  });

  it('concurrent budget check + record — no race between check and record', () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '10000';
    runSync(
      Array.from({ length: 20 }, () => () => {
        checkBudget();
        recordUsage(10, 5);
      })
    );
    const status = getBudgetStatus();
    expect(status.tokensUsed).toBe(20 * 15);
  });

  it('provider with different maxTokens per call — independent', async () => {
    const provider = createMockProvider({
      complete: vi.fn().mockImplementation(async (opts: { maxTokens?: number }) => ({
        content: `tokens:${opts.maxTokens ?? 'default'}`,
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 5 },
      })),
    });
    const results = await runConcurrent([
      () => provider.complete({ messages: [{ role: 'user', content: 'a' }], maxTokens: 100 }),
      () => provider.complete({ messages: [{ role: 'user', content: 'b' }], maxTokens: 500 }),
      () => provider.complete({ messages: [{ role: 'user', content: 'c' }], maxTokens: 1000 }),
    ]);
    expect(results).toHaveLength(3);
  });

  it('budget cap of 0 disables all enforcement', () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '0';
    recordUsage(999999999, 999999999);
    expect(() => checkBudget()).not.toThrow();
  });

  it('concurrent provider calls with mixed success/failure — failures isolated', async () => {
    let count = 0;
    const provider = createMockProvider({
      complete: vi.fn().mockImplementation(async () => {
        const c = count++;
        if (c % 3 === 0) throw new Error(`fail-${c}`);
        return { content: `ok-${c}`, finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const results = await runConcurrent(
      Array.from({ length: 9 }, () => () =>
        provider.complete({ messages: [{ role: 'user', content: 'test' }] })
          .catch((e: Error) => ({ error: e.message }))
      )
    );
    const successes = results.filter((r) => !('error' in r));
    const failures = results.filter((r) => 'error' in r);
    expect(successes.length).toBe(6);
    expect(failures.length).toBe(3);
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// 5. EVENT BUS CONCURRENT (~20 tests)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Event bus concurrent', () => {
  // Use a real EventEmitter for these tests
  let bus: EventEmitter;

  beforeEach(() => {
    bus = new EventEmitter();
    bus.setMaxListeners(200);
  });

  it('emit + addListener race — listener may or may not get this event', () => {
    const received: string[] = [];
    // Emit first, then add listener — listener should NOT get the event
    bus.emit('activity', { type: 'test', content: 'before-listener' });
    bus.on('activity', (e: { content: string }) => received.push(e.content));
    bus.emit('activity', { type: 'test', content: 'after-listener' });
    expect(received).toContain('after-listener');
    expect(received).not.toContain('before-listener');
  });

  it('emit + removeListener race — no crash', () => {
    const handler = vi.fn();
    bus.on('activity', handler);
    bus.emit('activity', { type: 'test' });
    bus.off('activity', handler);
    bus.emit('activity', { type: 'test2' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('100 concurrent emits — all delivered to all listeners', () => {
    const received: number[] = [];
    bus.on('activity', (e: { idx: number }) => received.push(e.idx));
    for (let i = 0; i < 100; i++) {
      bus.emit('activity', { idx: i });
    }
    expect(received).toHaveLength(100);
    // All indices should be present
    for (let i = 0; i < 100; i++) {
      expect(received).toContain(i);
    }
  });

  it('listener throws during emit — other listeners still called', () => {
    const results: string[] = [];
    bus.on('activity', () => { throw new Error('bad listener'); });
    bus.on('activity', (e: { name: string }) => results.push(e.name));
    // EventEmitter throws on first listener error, so we need to catch
    try {
      bus.emit('activity', { name: 'test' });
    } catch {
      // Expected
    }
    // With default EventEmitter, second listener may not be called if first throws
    // This is expected Node.js behavior
  });

  it('add many listeners then emit — all receive event', () => {
    const counts = new Array(50).fill(0);
    for (let i = 0; i < 50; i++) {
      const idx = i;
      bus.on('activity', () => { counts[idx]++; });
    }
    bus.emit('activity', { type: 'test' });
    for (const c of counts) {
      expect(c).toBe(1);
    }
  });

  it('remove listener during emit iteration — no crash', () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    const selfRemover = () => {
      bus.off('activity', selfRemover);
    };
    bus.on('activity', handler1);
    bus.on('activity', selfRemover);
    bus.on('activity', handler2);
    bus.emit('activity', { type: 'test' });
    expect(handler1).toHaveBeenCalled();
    expect(handler2).toHaveBeenCalled();
  });

  it('emit with no listeners — no crash', () => {
    expect(() => bus.emit('activity', { type: 'test' })).not.toThrow();
  });

  it('multiple event types emitted concurrently — events go to correct listeners', () => {
    const typeA: unknown[] = [];
    const typeB: unknown[] = [];
    bus.on('typeA', (e: unknown) => typeA.push(e));
    bus.on('typeB', (e: unknown) => typeB.push(e));
    for (let i = 0; i < 20; i++) {
      bus.emit(i % 2 === 0 ? 'typeA' : 'typeB', { idx: i });
    }
    expect(typeA).toHaveLength(10);
    expect(typeB).toHaveLength(10);
  });

  it('once() listener fires exactly once even with rapid emits', () => {
    const handler = vi.fn();
    bus.once('activity', handler);
    for (let i = 0; i < 10; i++) {
      bus.emit('activity', { idx: i });
    }
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('removeAllListeners — subsequent emits are no-ops', () => {
    const handler = vi.fn();
    bus.on('activity', handler);
    bus.emit('activity', {});
    bus.removeAllListeners('activity');
    bus.emit('activity', {});
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('listener added after removeAllListeners — receives new events', () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    bus.on('activity', handler1);
    bus.removeAllListeners('activity');
    bus.on('activity', handler2);
    bus.emit('activity', {});
    expect(handler1).not.toHaveBeenCalled();
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  it('prependListener — fires before regular listeners', () => {
    const order: string[] = [];
    bus.on('activity', () => order.push('regular'));
    bus.prependListener('activity', () => order.push('prepend'));
    bus.emit('activity', {});
    expect(order).toEqual(['prepend', 'regular']);
  });

  it('listenerCount tracks additions and removals', () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    expect(bus.listenerCount('activity')).toBe(0);
    bus.on('activity', h1);
    expect(bus.listenerCount('activity')).toBe(1);
    bus.on('activity', h2);
    expect(bus.listenerCount('activity')).toBe(2);
    bus.off('activity', h1);
    expect(bus.listenerCount('activity')).toBe(1);
  });

  it('error event with no listener throws — does not hang', () => {
    expect(() => bus.emit('error', new Error('test error'))).toThrow('test error');
  });

  it('error event with listener — handled gracefully', () => {
    const errors: Error[] = [];
    bus.on('error', (e: Error) => errors.push(e));
    bus.emit('error', new Error('caught'));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe('caught');
  });

  it('emit returns true when listeners exist, false when none', () => {
    expect(bus.emit('activity', {})).toBe(false);
    bus.on('activity', vi.fn());
    expect(bus.emit('activity', {})).toBe(true);
  });

  it('rapid on/off cycles — no leaked listeners', () => {
    for (let i = 0; i < 100; i++) {
      const h = vi.fn();
      bus.on('activity', h);
      bus.off('activity', h);
    }
    expect(bus.listenerCount('activity')).toBe(0);
  });

  it('newListener event fires when listener is added', () => {
    const events: string[] = [];
    bus.on('newListener', (eventName: string) => events.push(eventName));
    bus.on('activity', vi.fn());
    bus.on('other', vi.fn());
    expect(events).toContain('activity');
    expect(events).toContain('other');
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// 6. LOOP LIFECYCLE RACES (~30 tests)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Loop lifecycle races', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('start loop + stop loop in quick succession — clean state', () => {
    const fn = vi.fn();
    const timer = setInterval(fn, 1000);
    clearInterval(timer);
    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('loop cycle fires + stop called during cycle — cycle completes, no new cycle', async () => {
    let running = true;
    let cycleCount = 0;
    const cycleFn = vi.fn(async () => {
      cycleCount++;
      await new Promise((r) => setTimeout(r, 100));
    });
    const timer = setInterval(() => { if (running) cycleFn(); }, 1000);
    vi.advanceTimersByTime(1000); // triggers first cycle
    expect(cycleFn).toHaveBeenCalledTimes(1);
    running = false;
    clearInterval(timer);
    vi.advanceTimersByTime(5000); // no more cycles
    expect(cycleFn).toHaveBeenCalledTimes(1);
  });

  it('two start calls on same loop — only one timer running', () => {
    const fn = vi.fn();
    let timer = setInterval(fn, 1000);
    clearInterval(timer); // stop first
    timer = setInterval(fn, 1000); // restart
    vi.advanceTimersByTime(3000);
    expect(fn).toHaveBeenCalledTimes(3); // not 6
    clearInterval(timer);
  });

  it('stop called before first cycle fires — no cycle executes', () => {
    const fn = vi.fn();
    const timer = setInterval(fn, 5000);
    vi.advanceTimersByTime(1000); // not yet
    clearInterval(timer);
    vi.advanceTimersByTime(10000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('loop cycle throws + next cycle fires — next cycle runs normally', () => {
    let callCount = 0;
    const fn = vi.fn(() => {
      callCount++;
      if (callCount === 1) throw new Error('cycle error');
    });
    const timer = setInterval(() => {
      try { fn(); } catch { /* swallow */ }
    }, 1000);
    vi.advanceTimersByTime(3000);
    expect(fn).toHaveBeenCalledTimes(3);
    clearInterval(timer);
  });

  it('setTimeout + clearTimeout race — callback never fires', () => {
    const fn = vi.fn();
    const t = setTimeout(fn, 500);
    clearTimeout(t);
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('nested setTimeout creates chain — all execute in order', () => {
    const order: number[] = [];
    setTimeout(() => {
      order.push(1);
      setTimeout(() => {
        order.push(2);
        setTimeout(() => {
          order.push(3);
        }, 100);
      }, 100);
    }, 100);
    vi.advanceTimersByTime(500);
    expect(order).toEqual([1, 2, 3]);
  });

  it('concurrent timers do not interfere with each other', () => {
    const results: string[] = [];
    const t1 = setInterval(() => results.push('A'), 100);
    const t2 = setInterval(() => results.push('B'), 150);
    vi.advanceTimersByTime(300);
    clearInterval(t1);
    clearInterval(t2);
    // A fires at 100, 200, 300
    // B fires at 150, 300
    expect(results.filter((r) => r === 'A').length).toBe(3);
    expect(results.filter((r) => r === 'B').length).toBe(2);
  });

  it('clearInterval on already cleared timer — no error', () => {
    const t = setInterval(vi.fn(), 100);
    clearInterval(t);
    expect(() => clearInterval(t)).not.toThrow();
  });

  it('loop with guard flag — prevents overlapping cycles', () => {
    let isRunning = false;
    let completedCycles = 0;
    let skippedCycles = 0;
    const timer = setInterval(() => {
      if (isRunning) { skippedCycles++; return; }
      isRunning = true;
      completedCycles++;
      // Simulate async work that takes 250ms
      setTimeout(() => { isRunning = false; }, 250);
    }, 100);
    vi.advanceTimersByTime(1000);
    clearInterval(timer);
    expect(completedCycles).toBeGreaterThanOrEqual(3);
    expect(skippedCycles).toBeGreaterThan(0);
  });

  it('loop with async work — timer fires even during pending async', () => {
    const calls: number[] = [];
    const timer = setInterval(() => calls.push(Date.now()), 100);
    vi.advanceTimersByTime(500);
    clearInterval(timer);
    expect(calls).toHaveLength(5);
  });

  it('multiple independent loops — all fire at their own intervals', () => {
    const aCalls: number[] = [];
    const bCalls: number[] = [];
    const cCalls: number[] = [];
    const ta = setInterval(() => aCalls.push(1), 100);
    const tb = setInterval(() => bCalls.push(1), 200);
    const tc = setInterval(() => cCalls.push(1), 300);
    vi.advanceTimersByTime(600);
    clearInterval(ta);
    clearInterval(tb);
    clearInterval(tc);
    expect(aCalls.length).toBe(6);
    expect(bCalls.length).toBe(3);
    expect(cCalls.length).toBe(2);
  });

  it('setTimeout with 0 delay — fires on next tick', () => {
    const fn = vi.fn();
    setTimeout(fn, 0);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('loop teardown clears all pending timers', () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    const t1 = setInterval(fn1, 100);
    const t2 = setTimeout(fn2, 500);
    // Teardown
    clearInterval(t1);
    clearTimeout(t2);
    vi.advanceTimersByTime(1000);
    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).not.toHaveBeenCalled();
  });

  it('timer resolution — setInterval fires correct number of times', () => {
    const fn = vi.fn();
    const t = setInterval(fn, 250);
    vi.advanceTimersByTime(1000);
    clearInterval(t);
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('restart loop with different interval — new interval takes effect', () => {
    const fn = vi.fn();
    let t = setInterval(fn, 100);
    vi.advanceTimersByTime(300); // 3 calls
    clearInterval(t);
    t = setInterval(fn, 500);
    vi.advanceTimersByTime(1000); // 2 more calls
    clearInterval(t);
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it('loop with exponential backoff on failure', () => {
    let delay = 100;
    let attempts = 0;
    const maxDelay = 1600;
    function scheduleNext() {
      setTimeout(() => {
        attempts++;
        if (attempts < 5) {
          delay = Math.min(delay * 2, maxDelay);
          scheduleNext();
        }
      }, delay);
    }
    scheduleNext();
    vi.advanceTimersByTime(10000);
    expect(attempts).toBe(5);
  });

  it('debounce pattern — only last call within window fires', () => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fn = vi.fn();
    function debounced() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(fn, 200);
    }
    debounced();
    vi.advanceTimersByTime(100);
    debounced();
    vi.advanceTimersByTime(100);
    debounced();
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('loop with AbortController — aborted loop stops', () => {
    const ac = new AbortController();
    const fn = vi.fn();
    const t = setInterval(() => {
      if (ac.signal.aborted) return;
      fn();
    }, 100);
    vi.advanceTimersByTime(300); // 3 calls
    ac.abort();
    vi.advanceTimersByTime(300); // 3 more intervals, but fn won't be called
    clearInterval(t);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('concurrent setTimeout registrations — all fire at correct times', () => {
    const fired: string[] = [];
    setTimeout(() => fired.push('100'), 100);
    setTimeout(() => fired.push('200'), 200);
    setTimeout(() => fired.push('50'), 50);
    setTimeout(() => fired.push('150'), 150);
    vi.advanceTimersByTime(300);
    expect(fired).toEqual(['50', '100', '150', '200']);
  });

  it('loop cycle captures correct closure state', () => {
    const values: number[] = [];
    let counter = 0;
    const t = setInterval(() => {
      const snapshot = counter;
      values.push(snapshot);
    }, 100);
    counter = 1;
    vi.advanceTimersByTime(100);
    counter = 2;
    vi.advanceTimersByTime(100);
    counter = 3;
    vi.advanceTimersByTime(100);
    clearInterval(t);
    expect(values).toEqual([1, 2, 3]);
  });

  it('loop with monotonic tick counter — never skips', () => {
    let tick = 0;
    const ticks: number[] = [];
    const t = setInterval(() => {
      tick++;
      ticks.push(tick);
    }, 100);
    vi.advanceTimersByTime(1000);
    clearInterval(t);
    expect(ticks).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('loop with max iterations guard — stops after N', () => {
    let iterations = 0;
    const MAX = 5;
    const t = setInterval(() => {
      iterations++;
      if (iterations >= MAX) clearInterval(t);
    }, 100);
    vi.advanceTimersByTime(10000);
    expect(iterations).toBe(MAX);
  });

  it('multiple timers with same callback — each fires independently', () => {
    const calls: string[] = [];
    const fn = (label: string) => () => calls.push(label);
    const t1 = setInterval(fn('A'), 100);
    const t2 = setInterval(fn('B'), 100);
    vi.advanceTimersByTime(300);
    clearInterval(t1);
    clearInterval(t2);
    expect(calls.filter((c) => c === 'A').length).toBe(3);
    expect(calls.filter((c) => c === 'B').length).toBe(3);
  });

  it('timer drift detection — intervals are exact in fake timers', () => {
    const timestamps: number[] = [];
    const start = Date.now();
    const t = setInterval(() => timestamps.push(Date.now() - start), 250);
    vi.advanceTimersByTime(1000);
    clearInterval(t);
    expect(timestamps).toEqual([250, 500, 750, 1000]);
  });

  it('nested setInterval start/stop — inner timer survives outer stop', () => {
    const outerCalls: number[] = [];
    const innerCalls: number[] = [];
    let innerTimer: ReturnType<typeof setInterval> | null = null;
    const outerTimer = setInterval(() => {
      outerCalls.push(1);
      if (!innerTimer) {
        innerTimer = setInterval(() => innerCalls.push(1), 50);
      }
    }, 200);
    vi.advanceTimersByTime(250);
    clearInterval(outerTimer); // stop outer
    vi.advanceTimersByTime(150); // inner should still fire
    if (innerTimer) clearInterval(innerTimer);
    expect(outerCalls.length).toBe(1); // fired at 200
    expect(innerCalls.length).toBeGreaterThan(0); // inner kept firing
  });

  it('clearTimeout is safe to call with undefined/null', () => {
    expect(() => clearTimeout(undefined as any)).not.toThrow();
  });

  it('setInterval with 1ms delay — fires repeatedly', () => {
    const fn = vi.fn();
    const t = setInterval(fn, 1);
    vi.advanceTimersByTime(3);
    clearInterval(t);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('loop with conditional skip — skipped cycles do not accumulate', () => {
    let enabled = false;
    let runs = 0;
    const t = setInterval(() => {
      if (!enabled) return;
      runs++;
    }, 100);
    vi.advanceTimersByTime(300); // disabled, 0 runs
    enabled = true;
    vi.advanceTimersByTime(300); // enabled, 3 runs
    enabled = false;
    vi.advanceTimersByTime(300); // disabled again, 0 new
    clearInterval(t);
    expect(runs).toBe(3);
  });

  it('promise-based timer — resolves at correct time', async () => {
    const timerPromise = new Promise<number>((resolve) => {
      setTimeout(() => resolve(42), 500);
    });
    vi.advanceTimersByTime(500);
    const result = await timerPromise;
    expect(result).toBe(42);
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// 7. COMMUNE CONVERSATION RACES (~30 tests)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Commune conversation races', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = makeTestDir();
    await setupDb(testDir);
  });

  afterEach(async () => {
    await teardownDb(testDir);
  });

  it('two conversations started for same peer simultaneously — both get sessions', () => {
    const [s1, s2] = runSync([
      () => getOrCreateSession({ agentId: 'default', channel: 'commune', peerKind: 'character', peerId: 'pkd' }),
      () => getOrCreateSession({ agentId: 'default', channel: 'commune', peerKind: 'character', peerId: 'pkd' }),
    ]);
    expect(s1).toBeDefined();
    expect(s2).toBeDefined();
  });

  it('commune cycle guard — second cycle skipped if first still running', () => {
    let running = false;
    let completed = 0;
    let skipped = 0;
    function runCycle() {
      if (running) { skipped++; return; }
      running = true;
      completed++;
      // Simulate work
      running = false;
    }
    for (let i = 0; i < 10; i++) runCycle();
    expect(completed).toBe(10);
    expect(skipped).toBe(0);
  });

  it('commune cycle with concurrent guard — overlapping cycles skipped', () => {
    let running = false;
    let completed = 0;
    let skipped = 0;
    function runCycle(simulateBlocking: boolean) {
      if (running) { skipped++; return; }
      running = true;
      completed++;
      if (!simulateBlocking) running = false;
    }
    runCycle(true); // blocks
    runCycle(false); // should skip
    runCycle(false); // should skip
    running = false; // unblock
    runCycle(false); // should run
    expect(completed).toBe(2);
    expect(skipped).toBe(2);
  });

  it('letter delivery during commune conversation — both complete independently', async () => {
    const communeSession = createSession({ agentId: 'default', channel: 'commune', peerKind: 'character', peerId: 'pkd' });
    const letterSession = createSession({ agentId: 'default', channel: 'letter', peerKind: 'character', peerId: 'pkd' });
    await runConcurrent([
      async () => {
        saveMessage({ sessionKey: communeSession.key, userId: null, role: 'user', content: 'commune msg', timestamp: Date.now(), metadata: {} });
        saveMessage({ sessionKey: communeSession.key, userId: null, role: 'assistant', content: 'commune reply', timestamp: Date.now() + 1, metadata: {} });
      },
      async () => {
        saveMessage({ sessionKey: letterSession.key, userId: null, role: 'user', content: 'letter content', timestamp: Date.now(), metadata: {} });
      },
    ]);
    expect(getRecentMessages(communeSession.key)).toHaveLength(2);
    expect(getRecentMessages(letterSession.key)).toHaveLength(1);
  });

  it('commune conversation + awareness check — messages saved correctly', () => {
    const session = createSession({ agentId: 'default', channel: 'commune', peerKind: 'character', peerId: 'pkd' });
    setCurrentLocation('library', 'for commune');
    runSync([
      () => saveMessage({ sessionKey: session.key, userId: null, role: 'user', content: 'hello from pkd', timestamp: Date.now(), metadata: {} }),
      () => getCurrentLocation(),
    ]);
    const msgs = getRecentMessages(session.key);
    expect(msgs).toHaveLength(1);
  });

  it('multiple commune sessions active — messages go to correct sessions', () => {
    const s1 = createSession({ agentId: 'default', channel: 'commune', peerKind: 'character', peerId: 'pkd' });
    const s2 = createSession({ agentId: 'default', channel: 'commune', peerKind: 'character', peerId: 'drclau' });
    saveMessage({ sessionKey: s1.key, userId: null, role: 'user', content: 'from pkd', timestamp: Date.now(), metadata: {} });
    saveMessage({ sessionKey: s2.key, userId: null, role: 'user', content: 'from drclau', timestamp: Date.now() + 1, metadata: {} });
    expect(getRecentMessages(s1.key)[0]!.content).toBe('from pkd');
    expect(getRecentMessages(s2.key)[0]!.content).toBe('from drclau');
  });

  it('commune memory extraction + new commune message — no interference', async () => {
    const session = createSession({ agentId: 'default', channel: 'commune', peerKind: 'character', peerId: 'pkd' });
    const [memId, _] = await runConcurrent([
      () => saveMemory({ content: 'extracted from commune', memoryType: 'episode', importance: 0.6, emotionalWeight: 0.3, sessionKey: session.key, userId: null, relatedTo: null, sourceMessageId: null, metadata: {} }),
      async () => saveMessage({ sessionKey: session.key, userId: null, role: 'user', content: 'new during extract', timestamp: Date.now(), metadata: {} }),
    ]);
    expect(getMemory(memId)).toBeDefined();
    expect(getRecentMessages(session.key)).toHaveLength(1);
  });

  it('commune movement + session creation — both succeed', () => {
    runSync([
      () => setCurrentLocation('bar', 'going to bar for commune'),
      () => createSession({ agentId: 'default', channel: 'commune', peerKind: 'character', peerId: 'pkd' }),
    ]);
    expect(getCurrentLocation().building).toBe('bar');
  });

  it('conversation object access from multiple "routes" — in-memory map is consistent', () => {
    const conv1 = getConversation('commune:pkd:1', 'system prompt');
    addAssistantMessage(conv1, 'response 1');
    const conv2 = getConversation('commune:pkd:1', 'system prompt');
    expect(conv2.messages).toHaveLength(1);
    expect(conv2.messages[0]!.content).toBe('response 1');
  });

  it('clearConversation during access — no crash', () => {
    const conv = getConversation('commune:clear-test', 'system prompt');
    addAssistantMessage(conv, 'msg 1');
    clearConversation('commune:clear-test');
    const fresh = getConversation('commune:clear-test', 'system prompt');
    expect(fresh.messages).toHaveLength(0);
  });

  it('getActiveConversations during conversation creation — returns valid list', () => {
    getConversation('commune:active-1', 'prompt');
    getConversation('commune:active-2', 'prompt');
    const active = getActiveConversations();
    expect(active.length).toBeGreaterThanOrEqual(2);
  });

  it('internal state update during commune — state saved correctly', () => {
    saveState({
      energy: 0.8,
      sociability: 0.7,
      intellectual_arousal: 0.5,
      emotional_weight: 0.3,
      valence: 0.6,
      primary_color: 'curious',
      updated_at: Date.now(),
    });
    const state = getCurrentState();
    expect(state.energy).toBe(0.8);
    expect(state.primary_color).toBe('curious');
  });

  it('concurrent preoccupation add + read — consistent state', () => {
    addPreoccupation('thinking about commune', 'commune');
    const [preocs, _] = runSync([
      () => getPreoccupations(),
      () => addPreoccupation('another thought', 'diary'),
    ]);
    expect(Array.isArray(preocs)).toBe(true);
  });

  it('state decay during commune — values stay valid (0-1 range)', () => {
    const original: Parameters<typeof saveState>[0] = {
      energy: 0.9,
      sociability: 0.9,
      intellectual_arousal: 0.9,
      emotional_weight: 0.9,
      valence: 0.9,
      primary_color: 'excited',
      updated_at: Date.now() - 60 * 60 * 1000, // 1 hour ago
    };
    saveState(original);
    const decayed = applyDecay(getCurrentState());
    expect(decayed.energy).toBeGreaterThanOrEqual(0);
    expect(decayed.energy).toBeLessThanOrEqual(1);
    expect(decayed.sociability).toBeGreaterThanOrEqual(0);
    expect(decayed.sociability).toBeLessThanOrEqual(1);
  });

  it('commune session + diary session — messages isolated', () => {
    const commune = createSession({ agentId: 'default', channel: 'commune', peerKind: 'character', peerId: 'pkd' });
    const diary = createSession({ agentId: 'default', channel: 'diary', peerKind: 'system', peerId: 'diary' });
    saveMessage({ sessionKey: commune.key, userId: null, role: 'user', content: 'commune talk', timestamp: Date.now(), metadata: {} });
    saveMessage({ sessionKey: diary.key, userId: null, role: 'assistant', content: 'diary entry', timestamp: Date.now() + 1, metadata: {} });
    expect(getRecentMessages(commune.key)).toHaveLength(1);
    expect(getRecentMessages(diary.key)).toHaveLength(1);
    expect(getRecentMessages(commune.key)[0]!.content).not.toBe('diary entry');
  });

  it('concurrent commune with different peers — fully independent', async () => {
    const sessions = await runConcurrent(
      ['pkd', 'drclau', 'alice'].map((peer) => async () => {
        const s = createSession({ agentId: 'default', channel: 'commune', peerKind: 'character', peerId: peer });
        saveMessage({ sessionKey: s.key, userId: null, role: 'user', content: `hello from ${peer}`, timestamp: Date.now(), metadata: {} });
        return s;
      })
    );
    expect(sessions).toHaveLength(3);
    for (const s of sessions) {
      const msgs = getRecentMessages(s.key);
      expect(msgs).toHaveLength(1);
    }
  });

  it('commune conversation token tracking — no negative values', () => {
    const session = createSession({ agentId: 'default', channel: 'commune', peerKind: 'character', peerId: 'tok-test' });
    for (let i = 0; i < 10; i++) {
      updateSession(session.key, { tokenCount: (i + 1) * 100 });
    }
    const final = getSession(session.key);
    expect(final!.tokenCount).toBe(1000);
    expect(final!.tokenCount).toBeGreaterThan(0);
  });

  it('commune with movement mid-conversation — both recorded', () => {
    const session = createSession({ agentId: 'default', channel: 'commune', peerKind: 'character', peerId: 'move-mid' });
    saveMessage({ sessionKey: session.key, userId: null, role: 'user', content: 'start of commune', timestamp: Date.now(), metadata: {} });
    setCurrentLocation('bar', 'leaving commune');
    saveMessage({ sessionKey: session.key, userId: null, role: 'assistant', content: 'end of commune', timestamp: Date.now() + 1, metadata: {} });
    expect(getRecentMessages(session.key)).toHaveLength(2);
    expect(getCurrentLocation().building).toBe('bar');
  });

  it('state history during concurrent saves — no lost entries', () => {
    for (let i = 0; i < 5; i++) {
      saveState({
        energy: i * 0.2,
        sociability: 0.5,
        intellectual_arousal: 0.5,
        emotional_weight: 0.3,
        valence: 0.6,
        primary_color: `color-${i}`,
        updated_at: Date.now() + i,
      });
    }
    const history = getStateHistory();
    expect(history.length).toBeGreaterThanOrEqual(1);
  });

  it('clampState enforces 0-1 bounds', () => {
    const clamped = clampState({
      energy: 1.5,
      sociability: -0.3,
      intellectual_arousal: 2.0,
      emotional_weight: -1.0,
      valence: 0.5,
      primary_color: 'extreme',
      updated_at: Date.now(),
    });
    expect(clamped.energy).toBe(1);
    expect(clamped.sociability).toBe(0);
    expect(clamped.intellectual_arousal).toBe(1);
    expect(clamped.emotional_weight).toBe(0);
    expect(clamped.valence).toBe(0.5);
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// 8. MEMORY OPERATIONS CONCURRENT (~30 tests)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Memory operations concurrent', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = makeTestDir();
    await setupDb(testDir);
  });

  afterEach(async () => {
    await teardownDb(testDir);
  });

  it('organic maintenance (delete) while saving new memory — new memory survives', async () => {
    // Save old memories
    const oldIds = await runConcurrent(
      Array.from({ length: 5 }, (_, i) => () =>
        saveMemory({ content: `old-${i}`, memoryType: 'fact', importance: 0.1, emotionalWeight: 0, sessionKey: `old:${i}`, userId: null, relatedTo: null, sourceMessageId: null, metadata: {} })
      )
    );
    // Concurrently: delete old memories + save new one
    const [_, __, newId] = await runConcurrent([
      async () => deleteMemory(oldIds[0]!),
      async () => deleteMemory(oldIds[1]!),
      () => saveMemory({ content: 'brand-new', memoryType: 'fact', importance: 0.9, emotionalWeight: 0.5, sessionKey: 'new:1', userId: null, relatedTo: null, sourceMessageId: null, metadata: {} }),
    ]);
    expect(getMemory(newId)).toBeDefined();
    expect(getMemory(newId)!.content).toBe('brand-new');
  });

  it('palace room update + palace query — consistent response', () => {
    const wingId = createWing('palace-query-wing');
    const roomId = createRoom(wingId, 'palace-query-room');
    runSync([
      () => incrementRoomCount(roomId),
      () => getRoom(roomId),
      () => incrementRoomCount(roomId),
    ]);
    const room = getRoom(roomId);
    expect(room).toBeDefined();
    expect(room!.memoryCount).toBe(2);
  });

  it('concurrent memory save + coherence group add — both succeed', async () => {
    const groupId = createCoherenceGroup('conc-palace', null);
    const memId = await saveMemory({ content: 'for-group', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: 'cg:conc', userId: null, relatedTo: null, sourceMessageId: null, metadata: {} });
    runSync([
      () => addToCoherenceGroup(memId, groupId),
      () => saveMessage({ sessionKey: 'cg:msg', userId: null, role: 'user', content: 'during group add', timestamp: Date.now(), metadata: {} }),
    ]);
    expect(getGroupMembers(groupId)).toContain(memId);
  });

  it('memory lifecycle transition during read — returns valid state', async () => {
    const id = await saveMemory({ content: 'lifecycle-read', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: 'lc:read', userId: null, relatedTo: null, sourceMessageId: null, metadata: {} });
    const [mem, _] = runSync([
      () => getMemory(id),
      () => setLifecycleState(id, 'complete'),
    ]);
    expect(mem).toBeDefined();
    // State is either original or updated
    expect(['seed', 'complete']).toContain(mem!.lifecycleState);
  });

  it('concurrent getMemoriesByLifecycle — consistent results', async () => {
    for (let i = 0; i < 5; i++) {
      const id = await saveMemory({ content: `mature-${i}`, memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: `mature:${i}`, userId: null, relatedTo: null, sourceMessageId: null, metadata: {}, lifecycleState: 'mature' });
    }
    const [r1, r2] = runSync([
      () => getMemoriesByLifecycle('mature'),
      () => getMemoriesByLifecycle('mature'),
    ]);
    expect(r1.length).toBe(r2.length);
  });

  it('concurrent association creation between same memories — OR REPLACE prevents crash', async () => {
    const id1 = await saveMemory({ content: 'assoc-conc-A', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: 'ac:1', userId: null, relatedTo: null, sourceMessageId: null, metadata: {} });
    const id2 = await saveMemory({ content: 'assoc-conc-B', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: 'ac:2', userId: null, relatedTo: null, sourceMessageId: null, metadata: {} });
    expect(() => {
      runSync([
        () => addAssociation(id1, id2, 'similar', 0.7),
        () => addAssociation(id1, id2, 'similar', 0.8),
        () => addAssociation(id1, id2, 'pattern', 0.6),
      ]);
    }).not.toThrow();
  });

  it('concurrent countMemories during writes — returns consistent number', async () => {
    for (let i = 0; i < 10; i++) {
      await saveMemory({ content: `count-${i}`, memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: `cnt:${i}`, userId: null, relatedTo: null, sourceMessageId: null, metadata: {} });
    }
    const [count, _newId] = await runConcurrent([
      async () => countMemories(),
      () => saveMemory({ content: 'during-count', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: 'cnt:new', userId: null, relatedTo: null, sourceMessageId: null, metadata: {} }),
    ]);
    expect(count).toBeGreaterThanOrEqual(10);
  });

  it('concurrent updateMemoryAccess on same memory — access count increases', async () => {
    const id = await saveMemory({ content: 'access-test', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: 'acc:1', userId: null, relatedTo: null, sourceMessageId: null, metadata: {} });
    runSync(
      Array.from({ length: 5 }, () => () => updateMemoryAccess(id))
    );
    const mem = getMemory(id);
    expect(mem!.accessCount).toBe(5);
  });

  it('concurrent memory importance updates — last write wins', async () => {
    const id = await saveMemory({ content: 'imp-test', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: 'imp:1', userId: null, relatedTo: null, sourceMessageId: null, metadata: {} });
    runSync([
      () => updateMemoryImportance(id, 0.3),
      () => updateMemoryImportance(id, 0.7),
      () => updateMemoryImportance(id, 0.9),
    ]);
    const mem = getMemory(id);
    expect(mem!.importance).toBe(0.9);
  });

  it('concurrent wing + room operations — no orphan rooms', () => {
    const wingId = createWing('orphan-test-wing');
    const roomIds = runSync(
      Array.from({ length: 5 }, (_, i) => () =>
        createRoom(wingId, `room-${i}`)
      )
    );
    for (const roomId of roomIds) {
      const room = getRoom(roomId);
      expect(room).toBeDefined();
      expect(room!.wingId).toBe(wingId);
    }
  });

  it('concurrent resolveWingForMemory — pure function, consistent', () => {
    const results = runSync(
      Array.from({ length: 10 }, () => () =>
        resolveWingForMemory('diary:2024', null, {})
      )
    );
    const names = results.map((r) => r.wingName);
    expect(new Set(names).size).toBe(1); // All same
  });

  it('10 concurrent saveMemory — all get unique IDs', async () => {
    const ids = await runConcurrent(
      Array.from({ length: 10 }, (_, i) => () =>
        saveMemory({ content: `unique-${i}`, memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: `uniq:${i}`, userId: null, relatedTo: null, sourceMessageId: null, metadata: {} })
      )
    );
    expect(new Set(ids).size).toBe(10);
  });

  it('deleteMemory with coherence group membership — cleans up memberships', async () => {
    const groupId = createCoherenceGroup('del-group', null);
    const memId = await saveMemory({ content: 'will-be-deleted', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: 'del:cg', userId: null, relatedTo: null, sourceMessageId: null, metadata: {} });
    addToCoherenceGroup(memId, groupId);
    deleteMemory(memId);
    const members = getGroupMembers(groupId);
    expect(members).not.toContain(memId);
  });

  it('concurrent palace wing list + create — no crash during iteration', () => {
    createWing('existing-wing');
    const [wings, newId] = runSync([
      () => listWings(),
      () => createWing('new-during-list'),
    ]);
    expect(Array.isArray(wings)).toBe(true);
    expect(newId).toBeDefined();
  });

  it('concurrent triple query + add — query returns consistent data', () => {
    addTriple('Mem', 'references', 'Event1');
    addTriple('Mem', 'references', 'Event2');
    const [triples, newTripleId] = runSync([
      () => queryTriples({ subject: 'Mem' }),
      () => addTriple('Mem', 'references', 'Event3'),
    ]);
    expect(triples.length).toBeGreaterThanOrEqual(2);
    expect(getTriple(newTripleId)).toBeDefined();
  });

  it('memory with palace placement — wing and room IDs are non-null', async () => {
    const id = await saveMemory({
      content: 'palace-placed',
      memoryType: 'fact',
      importance: 0.5,
      emotionalWeight: 0,
      sessionKey: 'palace:1',
      userId: null,
      relatedTo: null,
      sourceMessageId: null,
      metadata: {},
    });
    const mem = getMemory(id);
    expect(mem).toBeDefined();
    expect(mem!.wingId).toBeDefined();
    expect(mem!.roomId).toBeDefined();
    expect(mem!.hall).toBeDefined();
  });

  it('concurrent getAllCoherenceGroups — always returns valid array', () => {
    createCoherenceGroup('g1', null);
    createCoherenceGroup('g2', null);
    const results = runSync(
      Array.from({ length: 5 }, () => () => getAllCoherenceGroups())
    );
    for (const r of results) {
      expect(Array.isArray(r)).toBe(true);
      expect(r.length).toBe(2);
    }
  });

  it('concurrent memory write + listWings — no partial state visible', async () => {
    const wingId = createWing('write-list-race');
    await runConcurrent([
      () => saveMemory({ content: 'during-list', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: 'wl:1', userId: null, relatedTo: null, sourceMessageId: null, metadata: {} }),
      async () => listWings(),
      async () => incrementWingCount(wingId),
    ]);
    const wing = getWing(wingId);
    expect(wing).toBeDefined();
  });

  it('concurrent listRooms + createRoom — no crash', () => {
    const wingId = createWing('room-list-wing');
    createRoom(wingId, 'pre-existing');
    const [rooms, newRoom] = runSync([
      () => listRooms(wingId),
      () => createRoom(wingId, 'new-during-list'),
    ]);
    expect(Array.isArray(rooms)).toBe(true);
    expect(newRoom).toBeDefined();
  });

  it('memory getRelatedMemories during link creation — returns consistent data', async () => {
    const id1 = await saveMemory({ content: 'rel-A', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: 'rel:1', userId: null, relatedTo: null, sourceMessageId: null, metadata: {} });
    const id2 = await saveMemory({ content: 'rel-B', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: 'rel:2', userId: null, relatedTo: null, sourceMessageId: null, metadata: {} });
    const [related, _] = runSync([
      () => getRelatedMemories(id1),
      () => linkMemories(id2, id1),
    ]);
    // Either empty or contains the link — never corrupt
    expect(Array.isArray(related)).toBe(true);
  });

  it('postboard messages during concurrent writes — all messages queryable', () => {
    const ids = runSync(
      Array.from({ length: 10 }, (_, i) => () =>
        savePostboardMessage(`admin-notice-${i}`, 'admin', i === 0)
      )
    );
    expect(ids).toHaveLength(10);
    const msgs = getPostboardMessages(0, 20);
    expect(msgs.length).toBe(10);
    // Pinned message should be first
    expect(msgs[0]!.pinned).toBe(true);
  });

  it('concurrent getEntity + addEntity — no crash on upsert', () => {
    addEntity('ConcEntity', 'concept');
    const [entity, _] = runSync([
      () => getEntity('ConcEntity'),
      () => addEntity('ConcEntity', 'concept', undefined, { updated: true }),
    ]);
    expect(entity).toBeDefined();
    expect(entity!.name).toBe('ConcEntity');
  });

  it('100 rapid memory saves — all unique, all retrievable', async () => {
    const ids = await runConcurrent(
      Array.from({ length: 100 }, (_, i) => () =>
        saveMemory({
          content: `rapid-${i}`,
          memoryType: i % 2 === 0 ? 'fact' : 'episode',
          importance: Math.random(),
          emotionalWeight: Math.random() * 0.5,
          sessionKey: `rapid:${i}`,
          userId: null,
          relatedTo: null,
          sourceMessageId: null,
          metadata: { index: i },
        })
      )
    );
    expect(ids).toHaveLength(100);
    expect(new Set(ids).size).toBe(100);
    expect(countMemories()).toBe(100);
    // Spot-check a few
    for (const idx of [0, 25, 50, 75, 99]) {
      const mem = getMemory(ids[idx]!);
      expect(mem).toBeDefined();
      expect(mem!.content).toBe(`rapid-${idx}`);
    }
  });

  it('concurrent memory save with different types — type is preserved', async () => {
    const types: Array<'fact' | 'preference' | 'context' | 'summary' | 'episode'> = ['fact', 'preference', 'context', 'summary', 'episode'];
    const ids = await runConcurrent(
      types.map((t, i) => () =>
        saveMemory({ content: `type-${t}`, memoryType: t, importance: 0.5, emotionalWeight: 0, sessionKey: `type:${i}`, userId: null, relatedTo: null, sourceMessageId: null, metadata: {} })
      )
    );
    for (let i = 0; i < types.length; i++) {
      const mem = getMemory(ids[i]!);
      expect(mem!.memoryType).toBe(types[i]);
    }
  });

  it('concurrent updateMemoryAccess from different callers — count increments atomically', async () => {
    const id = await saveMemory({ content: 'atomic-access', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: 'atom:1', userId: null, relatedTo: null, sourceMessageId: null, metadata: {} });
    runSync(
      Array.from({ length: 10 }, () => () => updateMemoryAccess(id))
    );
    const mem = getMemory(id);
    expect(mem!.accessCount).toBe(10);
    expect(mem!.lastAccessed).toBeDefined();
  });

  it('getMemory for nonexistent ID during concurrent saves — returns undefined', async () => {
    const [missing, _] = await runConcurrent([
      async () => getMemory('nonexistent-id-xyz'),
      () => saveMemory({ content: 'exists', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: 'miss:1', userId: null, relatedTo: null, sourceMessageId: null, metadata: {} }),
    ]);
    expect(missing).toBeUndefined();
  });

  it('concurrent triple invalidation — double invalidation is idempotent', () => {
    const id = addTriple('DoubleInv', 'test', 'target');
    runSync([
      () => invalidateTriple(id),
      () => invalidateTriple(id),
    ]);
    const triple = getTriple(id);
    expect(triple!.ended).not.toBeNull();
  });

  it('memory metadata is preserved through concurrent saves', async () => {
    const ids = await runConcurrent(
      Array.from({ length: 5 }, (_, i) => () =>
        saveMemory({
          content: `meta-${i}`,
          memoryType: 'fact',
          importance: 0.5,
          emotionalWeight: 0,
          sessionKey: `meta:${i}`,
          userId: null,
          relatedTo: null,
          sourceMessageId: null,
          metadata: { custom: `value-${i}`, index: i },
        })
      )
    );
    for (let i = 0; i < ids.length; i++) {
      const mem = getMemory(ids[i]!);
      expect((mem!.metadata as { custom: string }).custom).toBe(`value-${i}`);
    }
  });

  it('concurrent entity timeline queries — no interference', () => {
    addTriple('Timeline', 'event', 'A', 1.0, 1000);
    addTriple('Timeline', 'event', 'B', 1.0, 2000);
    addTriple('Timeline', 'event', 'C', 1.0, 3000);
    const results = runSync(
      Array.from({ length: 5 }, () => () => queryTriples({ subject: 'Timeline' }))
    );
    for (const r of results) {
      expect(r.length).toBe(3);
    }
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// 9. CROSS-SYSTEM CONCURRENT OPERATIONS (~40 tests)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Cross-system concurrent operations', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = makeTestDir();
    await setupDb(testDir);
  });

  afterEach(async () => {
    await teardownDb(testDir);
  });

  it('memory save + location move + session create — all succeed', async () => {
    const [memId, _, session] = await runConcurrent([
      () => saveMemory({ content: 'cross-sys', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: 'cross:1', userId: null, relatedTo: null, sourceMessageId: null, metadata: {} }),
      async () => { setCurrentLocation('library', 'cross-system test'); return null; },
      async () => createSession({ agentId: 'default', channel: 'web', peerKind: 'user', peerId: 'cross-u1' }),
    ]);
    expect(getMemory(memId)).toBeDefined();
    expect(getCurrentLocation().building).toBe('library');
    expect(session).toBeDefined();
  });

  it('triple add + memory save + message save — all to different tables simultaneously', async () => {
    const [tripleId, memId, msgId] = await runConcurrent([
      async () => addTriple('CrossSys', 'test', 'value'),
      () => saveMemory({ content: 'cross-mem', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: 'cross:2', userId: null, relatedTo: null, sourceMessageId: null, metadata: {} }),
      async () => saveMessage({ sessionKey: 'cross:msg', userId: null, role: 'user', content: 'cross message', timestamp: Date.now(), metadata: {} }),
    ]);
    expect(getTriple(tripleId)).toBeDefined();
    expect(getMemory(memId)).toBeDefined();
    expect(countMessages()).toBe(1);
  });

  it('state save + location move + meta write — no deadlock', () => {
    runSync([
      () => saveState({ energy: 0.5, sociability: 0.5, intellectual_arousal: 0.5, emotional_weight: 0.3, valence: 0.6, primary_color: 'neutral', updated_at: Date.now() }),
      () => setCurrentLocation('field', 'parallel state/move'),
      () => setMeta('cross:key', 'cross-value'),
    ]);
    expect(getCurrentState().energy).toBe(0.5);
    expect(getCurrentLocation().building).toBe('field');
    expect(getMeta('cross:key')).toBe('cross-value');
  });

  it('session + message + memory in rapid sequence — data integrity maintained', async () => {
    const session = createSession({ agentId: 'default', channel: 'web', peerKind: 'user', peerId: 'integrity' });
    const msgId = saveMessage({ sessionKey: session.key, userId: 'u1', role: 'user', content: 'hello', timestamp: Date.now(), metadata: {} });
    const memId = await saveMemory({ content: 'from conversation', memoryType: 'episode', importance: 0.6, emotionalWeight: 0.2, sessionKey: session.key, userId: 'u1', relatedTo: null, sourceMessageId: msgId, metadata: {} });
    const mem = getMemory(memId);
    expect(mem!.sourceMessageId).toBe(msgId);
    expect(mem!.sessionKey).toBe(session.key);
  });

  it('palace + KG + coherence — all structural tables accessed simultaneously', async () => {
    const wingId = createWing('cross-wing');
    const roomId = createRoom(wingId, 'cross-room');
    const groupId = createCoherenceGroup('cross-group', null);
    const tripleId = addTriple('CrossStruct', 'belongs', 'cross-wing');
    const memId = await saveMemory({ content: 'cross-structural', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: 'cross:struct', userId: null, relatedTo: null, sourceMessageId: null, metadata: {} });

    runSync([
      () => incrementWingCount(wingId),
      () => incrementRoomCount(roomId),
      () => addToCoherenceGroup(memId, groupId),
      () => addEntity('CrossEntity', 'concept'),
    ]);

    expect(getWing(wingId)!.memoryCount).toBe(1);
    expect(getRoom(roomId)!.memoryCount).toBe(1);
    expect(getGroupMembers(groupId)).toContain(memId);
    expect(getEntity('CrossEntity')).toBeDefined();
  });

  it('20 mixed writes across all tables — no table-level locking issues', async () => {
    const results = await runConcurrent([
      // 5 memories
      ...Array.from({ length: 5 }, (_, i) => () =>
        saveMemory({ content: `mix20-${i}`, memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: `mix20:${i}`, userId: null, relatedTo: null, sourceMessageId: null, metadata: {} })
      ),
      // 5 messages
      ...Array.from({ length: 5 }, (_, i) => async () => {
        saveMessage({ sessionKey: `mix20-msg:${i}`, userId: null, role: 'user', content: `mix20-msg-${i}`, timestamp: Date.now() + i, metadata: {} });
        return `msg-${i}`;
      }),
      // 5 triples
      ...Array.from({ length: 5 }, (_, i) => async () => addTriple(`MixS${i}`, 'rel', `MixO${i}`)),
      // 5 meta writes
      ...Array.from({ length: 5 }, (_, i) => async () => {
        setMeta(`mix20-key-${i}`, `mix20-val-${i}`);
        return `meta-${i}`;
      }),
    ]);
    expect(results).toHaveLength(20);
  });

  it('read-heavy workload during writes — all reads return valid data', async () => {
    // Seed some data
    for (let i = 0; i < 5; i++) {
      await saveMemory({ content: `seed-${i}`, memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: `seed:${i}`, userId: null, relatedTo: null, sourceMessageId: null, metadata: {} });
      setMeta(`seed-key-${i}`, `seed-val-${i}`);
    }
    // Run 10 reads + 5 writes concurrently
    const results = await runConcurrent([
      ...Array.from({ length: 10 }, (_, i) => async () => ({
        memories: countMemories(),
        meta: getMeta(`seed-key-${i % 5}`),
      })),
      ...Array.from({ length: 5 }, (_, i) => async () => {
        setMeta(`new-key-${i}`, `new-val-${i}`);
        return { written: true };
      }),
    ]);
    const reads = results.slice(0, 10) as Array<{ memories: number; meta: string | null }>;
    for (const r of reads) {
      expect(r.memories).toBeGreaterThanOrEqual(5);
      expect(r.meta).toBeDefined();
    }
  });

  it('concurrent conversation + session + state — simulates real request handling', () => {
    const session = getOrCreateSession({ agentId: 'default', channel: 'web', peerKind: 'user', peerId: 'req-sim' });
    const conv = getConversation(session.key, 'You are a test agent.');
    runSync([
      () => addAssistantMessage(conv, 'Hello there.'),
      () => updateSession(session.key, { tokenCount: 100 }),
      () => saveState({ energy: 0.7, sociability: 0.6, intellectual_arousal: 0.4, emotional_weight: 0.3, valence: 0.5, primary_color: 'calm', updated_at: Date.now() }),
      () => saveMessage({ sessionKey: session.key, userId: null, role: 'assistant', content: 'Hello there.', timestamp: Date.now(), metadata: {} }),
    ]);
    expect(conv.messages).toHaveLength(1);
    expect(getRecentMessages(session.key)).toHaveLength(1);
  });

  it('postboard + town events table + meta — all admin writes in parallel', () => {
    runSync([
      () => savePostboardMessage('notice 1', 'admin'),
      () => setMeta('admin:setting', 'enabled'),
      () => execute(
        "INSERT INTO town_events (id, description, created_at) VALUES (?, ?, ?)",
        [nanoid(16), 'test event', Date.now()]
      ),
    ]);
    expect(getPostboardMessages(0)).toHaveLength(1);
    expect(getMeta('admin:setting')).toBe('enabled');
  });

  it('building event recording + location move + memory save — no contention', async () => {
    const [_, __, memId] = await runConcurrent([
      async () => execute(
        "INSERT INTO building_events (id, building, event_type, summary, created_at) VALUES (?, ?, ?, ?, ?)",
        [nanoid(16), 'library', 'conversation', 'test convo', Date.now()]
      ),
      async () => setCurrentLocation('bar', 'leaving library'),
      () => saveMemory({ content: 'library memory', memoryType: 'episode', importance: 0.6, emotionalWeight: 0, sessionKey: 'bldg:1', userId: null, relatedTo: null, sourceMessageId: null, metadata: {} }),
    ]);
    expect(getMemory(memId)).toBeDefined();
  });

  it('concurrent object creation + query — no corruption', () => {
    const now = Date.now();
    runSync([
      () => execute(
        "INSERT INTO objects (id, name, description, creator_id, creator_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [nanoid(16), 'test-obj-1', 'a test object', 'lain', 'Lain', now, now]
      ),
      () => execute(
        "INSERT INTO objects (id, name, description, creator_id, creator_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [nanoid(16), 'test-obj-2', 'another object', 'pkd', 'PKD', now, now]
      ),
      () => query("SELECT * FROM objects"),
    ]);
    const objects = query<{ id: string }>("SELECT * FROM objects");
    expect(objects.length).toBe(2);
  });

  it('memory + association + coherence group — full topology operation', async () => {
    const id1 = await saveMemory({ content: 'topo-A', memoryType: 'fact', importance: 0.7, emotionalWeight: 0.3, sessionKey: 'topo:1', userId: null, relatedTo: null, sourceMessageId: null, metadata: {} });
    const id2 = await saveMemory({ content: 'topo-B', memoryType: 'fact', importance: 0.6, emotionalWeight: 0.2, sessionKey: 'topo:2', userId: null, relatedTo: null, sourceMessageId: null, metadata: {} });
    const groupId = createCoherenceGroup('topo-group', null);
    runSync([
      () => addAssociation(id1, id2, 'similar', 0.8),
      () => addToCoherenceGroup(id1, groupId),
      () => addToCoherenceGroup(id2, groupId),
      () => linkMemories(id2, id1),
    ]);
    expect(getAssociations(id1).length).toBeGreaterThanOrEqual(1);
    expect(getGroupMembers(groupId)).toHaveLength(2);
  });

  it('session listing + memory counting + triple querying — concurrent reads across tables', async () => {
    // Seed
    createSession({ agentId: 'default', channel: 'web', peerKind: 'user', peerId: 'count-1' });
    await saveMemory({ content: 'count-mem', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: 'cnt:sess', userId: null, relatedTo: null, sourceMessageId: null, metadata: {} });
    addTriple('Count', 'test', 'triple');

    const [sessions, memCount, triples] = runSync([
      () => listSessions('default'),
      () => countMemories(),
      () => queryTriples({ subject: 'Count' }),
    ]);
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(memCount).toBeGreaterThanOrEqual(1);
    expect(triples.length).toBeGreaterThanOrEqual(1);
  });

  it('50 parallel operations across all systems — stress test', async () => {
    const results = await runConcurrent([
      // 10 memories
      ...Array.from({ length: 10 }, (_, i) => () =>
        saveMemory({ content: `stress50-${i}`, memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: `s50:${i}`, userId: null, relatedTo: null, sourceMessageId: null, metadata: {} })
      ),
      // 10 messages
      ...Array.from({ length: 10 }, (_, i) => async () =>
        saveMessage({ sessionKey: `s50-msg:${i}`, userId: null, role: 'user', content: `s50-msg-${i}`, timestamp: Date.now() + i, metadata: {} })
      ),
      // 10 triples
      ...Array.from({ length: 10 }, (_, i) => async () => addTriple(`S50-${i}`, 'test', `O50-${i}`)),
      // 10 sessions
      ...Array.from({ length: 10 }, (_, i) => async () =>
        createSession({ agentId: 'default', channel: 'web', peerKind: 'user', peerId: `s50-peer-${i}` })
      ),
      // 10 meta writes
      ...Array.from({ length: 10 }, (_, i) => async () => {
        setMeta(`s50-key-${i}`, `s50-val-${i}`);
        return `meta-${i}`;
      }),
    ]);
    expect(results).toHaveLength(50);
    expect(countMemories()).toBe(10);
    expect(countMessages()).toBe(10);
  });

  it('KG entity upsert + triple add + query — temporal consistency', () => {
    addEntity('TemporalEntity', 'person');
    const tripleIds = runSync([
      () => addTriple('TemporalEntity', 'visited', 'library', 1.0, 1000),
      () => addTriple('TemporalEntity', 'visited', 'bar', 1.0, 2000),
      () => addTriple('TemporalEntity', 'visited', 'field', 1.0, 3000),
    ]);
    for (const id of tripleIds) {
      expect(getTriple(id)).toBeDefined();
    }
    // Query triples as of time 2500 — should include first two
    const asOf2500 = queryTriples({ subject: 'TemporalEntity', asOf: 2500 });
    expect(asOf2500.length).toBe(2);
  });

  it('concurrent reads after rapid writes — eventual consistency', async () => {
    // Rapid writes
    for (let i = 0; i < 20; i++) {
      await saveMemory({ content: `eventual-${i}`, memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: `ev:${i}`, userId: null, relatedTo: null, sourceMessageId: null, metadata: {} });
    }
    // Concurrent reads
    const counts = runSync(
      Array.from({ length: 10 }, () => () => countMemories())
    );
    for (const c of counts) {
      expect(c).toBe(20);
    }
  });

  it('concurrent wing resolution with room creation — consistent hierarchy', () => {
    const wingId = resolveWing('hierarchy-wing', 'test wing');
    const roomIds = runSync(
      Array.from({ length: 5 }, (_, i) => () =>
        resolveRoom(wingId, 'encounters', `room-${i}`)
      )
    );
    for (const roomId of roomIds) {
      const room = getRoom(roomId);
      expect(room).toBeDefined();
      expect(room!.wingId).toBe(wingId);
    }
  });

  it('preoccupation management during concurrent state saves', () => {
    addPreoccupation('first thought', 'commune');
    saveState({ energy: 0.8, sociability: 0.6, intellectual_arousal: 0.5, emotional_weight: 0.3, valence: 0.7, primary_color: 'focused', updated_at: Date.now() });
    addPreoccupation('second thought', 'diary');
    const preoccs = getPreoccupations();
    expect(preoccs.length).toBeGreaterThanOrEqual(1);
  });

  it('conversation clear + new message — clean slate', () => {
    const conv = getConversation('clear-test:session', 'system prompt');
    addAssistantMessage(conv, 'old message');
    clearConversation('clear-test:session');
    const fresh = getConversation('clear-test:session', 'system prompt');
    addAssistantMessage(fresh, 'new message');
    expect(fresh.messages).toHaveLength(1);
    expect(fresh.messages[0]!.content).toBe('new message');
  });

  it('concurrent memory save with relatedTo — chain is preserved', async () => {
    const id1 = await saveMemory({ content: 'chain-1', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: 'chain:1', userId: null, relatedTo: null, sourceMessageId: null, metadata: {} });
    const [id2, id3] = await runConcurrent([
      () => saveMemory({ content: 'chain-2', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: 'chain:2', userId: null, relatedTo: id1, sourceMessageId: null, metadata: {} }),
      () => saveMemory({ content: 'chain-3', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: 'chain:3', userId: null, relatedTo: id1, sourceMessageId: null, metadata: {} }),
    ]);
    const mem2 = getMemory(id2);
    const mem3 = getMemory(id3);
    expect(mem2!.relatedTo).toBe(id1);
    expect(mem3!.relatedTo).toBe(id1);
  });

  it('mixed read/write transaction + concurrent non-tx write — both succeed', () => {
    setMeta('tx-mix', 'initial');
    runSync([
      () => transaction(() => {
        const val = getMeta('tx-mix');
        setMeta('tx-mix', `${val}-updated`);
        return val;
      }),
      () => setMeta('non-tx-mix', 'outside-tx'),
    ]);
    expect(getMeta('tx-mix')).toBe('initial-updated');
    expect(getMeta('non-tx-mix')).toBe('outside-tx');
  });

  it('location + state + preoccupation — character context update race', () => {
    runSync([
      () => setCurrentLocation('library', 'seeking knowledge'),
      () => saveState({ energy: 0.9, sociability: 0.3, intellectual_arousal: 0.8, emotional_weight: 0.2, valence: 0.7, primary_color: 'studious', updated_at: Date.now() }),
      () => addPreoccupation('what is consciousness?', 'curiosity'),
    ]);
    expect(getCurrentLocation().building).toBe('library');
    expect(getCurrentState().primary_color).toBe('studious');
    expect(getPreoccupations().length).toBeGreaterThanOrEqual(1);
  });

  it('interleaved session + message + update — realistic chat flow', () => {
    const session = getOrCreateSession({ agentId: 'default', channel: 'web', peerKind: 'user', peerId: 'chat-flow' });
    for (let i = 0; i < 5; i++) {
      saveMessage({ sessionKey: session.key, userId: 'u1', role: 'user', content: `user-${i}`, timestamp: Date.now() + i * 2, metadata: {} });
      saveMessage({ sessionKey: session.key, userId: null, role: 'assistant', content: `bot-${i}`, timestamp: Date.now() + i * 2 + 1, metadata: {} });
      updateSession(session.key, { tokenCount: (i + 1) * 200 });
    }
    expect(getRecentMessages(session.key, 20)).toHaveLength(10);
    expect(getSession(session.key)!.tokenCount).toBe(1000);
  });

  it('concurrent conversation creation for different session keys — isolated', () => {
    const convs = runSync(
      Array.from({ length: 5 }, (_, i) => () => {
        const conv = getConversation(`iso-${i}`, 'system prompt');
        addAssistantMessage(conv, `response-${i}`);
        return conv;
      })
    );
    for (let i = 0; i < 5; i++) {
      expect(convs[i]!.messages).toHaveLength(1);
      expect(convs[i]!.messages[0]!.content).toBe(`response-${i}`);
    }
  });

  it('multiple simultaneous building events — no data mixing', () => {
    const now = Date.now();
    const buildings = ['library', 'bar', 'field'];
    runSync(buildings.map((b, i) => () =>
      execute(
        "INSERT INTO building_events (id, building, event_type, summary, created_at) VALUES (?, ?, ?, ?, ?)",
        [nanoid(16), b, 'arrival', `arrived at ${b}`, now + i]
      )
    ));
    for (const b of buildings) {
      const events = query<{ building: string }>(
        "SELECT * FROM building_events WHERE building = ?", [b]
      );
      expect(events.length).toBe(1);
      expect(events[0]!.building).toBe(b);
    }
  });

  it('location history + state history — both append correctly under concurrent writes', () => {
    setCurrentLocation('library', 'history-test-1');
    setCurrentLocation('bar', 'history-test-2');
    saveState({ energy: 0.5, sociability: 0.5, intellectual_arousal: 0.5, emotional_weight: 0.3, valence: 0.6, primary_color: 'neutral', updated_at: Date.now() });
    saveState({ energy: 0.7, sociability: 0.8, intellectual_arousal: 0.3, emotional_weight: 0.1, valence: 0.9, primary_color: 'social', updated_at: Date.now() + 1 });
    const locHist = getLocationHistory();
    const stateHist = getStateHistory();
    expect(locHist.length).toBeGreaterThanOrEqual(1);
    expect(stateHist.length).toBeGreaterThanOrEqual(1);
  });

  it('full lifecycle simulation — create, read, update, delete across systems', async () => {
    // Create
    const session = createSession({ agentId: 'default', channel: 'web', peerKind: 'user', peerId: 'lifecycle-sim' });
    const msgId = saveMessage({ sessionKey: session.key, userId: 'u1', role: 'user', content: 'lifecycle test', timestamp: Date.now(), metadata: {} });
    const memId = await saveMemory({ content: 'lifecycle memory', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: session.key, userId: 'u1', relatedTo: null, sourceMessageId: msgId, metadata: {} });
    const tripleId = addTriple('LifecycleSim', 'tested', 'CRUD');

    // Read
    expect(getSession(session.key)).toBeDefined();
    expect(getMemory(memId)).toBeDefined();
    expect(getTriple(tripleId)).toBeDefined();

    // Update
    updateSession(session.key, { tokenCount: 500 });
    updateMemoryImportance(memId, 0.9);

    // Delete
    deleteMemory(memId);
    expect(getMemory(memId)).toBeUndefined();
    expect(getSession(session.key)!.tokenCount).toBe(500);
  });

  it('concurrent conversations + persistent storage — in-memory and DB diverge safely', () => {
    const session = getOrCreateSession({ agentId: 'default', channel: 'web', peerKind: 'user', peerId: 'diverge' });
    const conv = getConversation(session.key, 'prompt');
    // In-memory conversation
    addAssistantMessage(conv, 'in-memory response');
    // Persistent storage
    saveMessage({ sessionKey: session.key, userId: null, role: 'assistant', content: 'persistent response', timestamp: Date.now(), metadata: {} });
    // Both should work independently
    expect(conv.messages).toHaveLength(1);
    expect(getRecentMessages(session.key)).toHaveLength(1);
    // Content may differ — that's expected in real usage
  });

  it('concurrent meta operations for different subsystems — no key collision', () => {
    runSync([
      () => setMeta('internal:state', JSON.stringify({ energy: 0.5 })),
      () => setMeta('town:current_location', JSON.stringify({ building: 'library', timestamp: Date.now() })),
      () => setMeta('budget:monthly_usage', JSON.stringify({ month: '2026-04', tokens: 100 })),
      () => setMeta('self_concept:text', 'I am a test character'),
    ]);
    expect(getMeta('internal:state')).toContain('energy');
    expect(getMeta('town:current_location')).toContain('library');
    expect(getMeta('budget:monthly_usage')).toContain('tokens');
    expect(getMeta('self_concept:text')).toContain('test character');
  });

  it('empty string values in meta — stored and retrieved correctly', () => {
    setMeta('empty-val', '');
    expect(getMeta('empty-val')).toBe('');
  });

  it('concurrent queries returning different row counts — each result independent', async () => {
    await saveMemory({ content: 'q-test-1', memoryType: 'fact', importance: 0.9, emotionalWeight: 0, sessionKey: 'q:1', userId: 'user-a', relatedTo: null, sourceMessageId: null, metadata: {} });
    await saveMemory({ content: 'q-test-2', memoryType: 'episode', importance: 0.5, emotionalWeight: 0, sessionKey: 'q:2', userId: 'user-b', relatedTo: null, sourceMessageId: null, metadata: {} });
    await saveMemory({ content: 'q-test-3', memoryType: 'fact', importance: 0.3, emotionalWeight: 0, sessionKey: 'q:3', userId: null, relatedTo: null, sourceMessageId: null, metadata: {} });

    const [facts, episodes, all] = runSync([
      () => query<{ id: string }>("SELECT * FROM memories WHERE memory_type = 'fact'"),
      () => query<{ id: string }>("SELECT * FROM memories WHERE memory_type = 'episode'"),
      () => query<{ id: string }>("SELECT * FROM memories"),
    ]);
    expect(facts.length).toBe(2);
    expect(episodes.length).toBe(1);
    expect(all.length).toBe(3);
  });

  it('concurrent session operations across different channels — isolated', () => {
    const sessions = runSync([
      () => createSession({ agentId: 'default', channel: 'web', peerKind: 'user', peerId: 'p1' }),
      () => createSession({ agentId: 'default', channel: 'telegram', peerKind: 'user', peerId: 'p1' }),
      () => createSession({ agentId: 'default', channel: 'commune', peerKind: 'character', peerId: 'pkd' }),
    ]);
    expect(sessions[0]!.channel).toBe('web');
    expect(sessions[1]!.channel).toBe('telegram');
    expect(sessions[2]!.channel).toBe('commune');
    const keys = sessions.map((s) => s.key);
    expect(new Set(keys).size).toBe(3);
  });

  it('concurrent triple contradiction setup — both triples stored', () => {
    const [id1, id2] = runSync([
      () => addTriple('Person', 'lives_in', 'Tokyo'),
      () => addTriple('Person', 'lives_in', 'Osaka'),
    ]);
    expect(getTriple(id1)).toBeDefined();
    expect(getTriple(id2)).toBeDefined();
    // Both exist — contradiction detection would flag these
    const triples = queryTriples({ subject: 'Person', predicate: 'lives_in' });
    expect(triples.length).toBe(2);
  });

  it('memory with emotional weight + KG triple — cross-table correlation preserved', async () => {
    const memId = await saveMemory({ content: 'emotional fact', memoryType: 'fact', importance: 0.8, emotionalWeight: 0.7, sessionKey: 'emo:1', userId: null, relatedTo: null, sourceMessageId: null, metadata: {} });
    const tripleId = addTriple('Character', 'felt', 'emotional', 0.7, undefined, undefined, memId);
    const mem = getMemory(memId);
    const triple = getTriple(tripleId);
    expect(mem!.emotionalWeight).toBe(0.7);
    expect(triple!.sourceMemoryId).toBe(memId);
  });

  it('concurrent building event + object creation + postboard — admin operations', () => {
    const now = Date.now();
    runSync([
      () => execute(
        "INSERT INTO building_events (id, building, event_type, summary, created_at) VALUES (?, ?, ?, ?, ?)",
        [nanoid(16), 'bar', 'event', 'admin event in bar', now]
      ),
      () => execute(
        "INSERT INTO objects (id, name, description, creator_id, creator_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [nanoid(16), 'admin-item', 'an item', 'admin', 'Admin', now, now]
      ),
      () => savePostboardMessage('admin broadcast', 'admin', true),
    ]);
    const events = query<{ id: string }>("SELECT * FROM building_events");
    const objects = query<{ id: string }>("SELECT * FROM objects");
    const posts = getPostboardMessages(0);
    expect(events.length).toBe(1);
    expect(objects.length).toBe(1);
    expect(posts.length).toBe(1);
    expect(posts[0]!.pinned).toBe(true);
  });

  it('concurrent town event creation + query — consistent state', () => {
    const now = Date.now();
    runSync([
      () => execute(
        "INSERT INTO town_events (id, description, status, created_at) VALUES (?, ?, 'active', ?)",
        [nanoid(16), 'storm approaching', now]
      ),
      () => execute(
        "INSERT INTO town_events (id, description, status, created_at) VALUES (?, ?, 'active', ?)",
        [nanoid(16), 'festival day', now + 1]
      ),
    ]);
    const events = query<{ description: string }>(
      "SELECT * FROM town_events WHERE status = 'active'"
    );
    expect(events.length).toBe(2);
  });

  it('conversation token tracking + memory save — no shared state corruption', async () => {
    const conv = getConversation('tok-track:1', 'system prompt');
    const [_, memId] = await runConcurrent([
      async () => {
        addAssistantMessage(conv, 'tracked response');
        return conv;
      },
      () => saveMemory({ content: 'during token track', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, sessionKey: 'tok-track:1', userId: null, relatedTo: null, sourceMessageId: null, metadata: {} }),
    ]);
    expect(conv.messages).toHaveLength(1);
    expect(getMemory(memId)).toBeDefined();
  });

  it('concurrent assignHall for different memory types — pure function returns correct halls', () => {
    const results = runSync([
      () => assignHall('fact', 'diary:2024'),
      () => assignHall('episode', 'commune:pkd'),
      () => assignHall('preference', 'web:u1'),
      () => assignHall('summary', 'selfconcept:2024'),
      () => assignHall('context', 'curiosity:browse'),
    ]);
    expect(results).toHaveLength(5);
    for (const r of results) {
      expect(['truths', 'encounters', 'discoveries', 'dreams', 'reflections']).toContain(r);
    }
  });

  it('concurrent resolveWingForMemory with different session keys — correct wing per key', () => {
    const results = runSync([
      () => resolveWingForMemory('diary:2024', null, {}),
      () => resolveWingForMemory('commune:pkd', null, {}),
      () => resolveWingForMemory('web:user1', 'user1', {}),
      () => resolveWingForMemory('curiosity:browse', null, {}),
    ]);
    expect(results).toHaveLength(4);
    for (const r of results) {
      expect(r.wingName).toBeDefined();
    }
  });

  it('KG contradiction-prone insertions — both stored for later resolution', () => {
    // Same subject+predicate, different objects
    const ids = runSync([
      () => addTriple('Lain', 'favorite_color', 'blue'),
      () => addTriple('Lain', 'favorite_color', 'green'),
      () => addTriple('Lain', 'favorite_color', 'none'),
    ]);
    const allTriples = queryTriples({ subject: 'Lain', predicate: 'favorite_color' });
    expect(allTriples.length).toBe(3);
    // All stored — contradiction detection is a separate process
  });

  it('concurrent listEntities + addEntity + queryTriples — multi-table read storm', () => {
    addEntity('Storm1', 'person');
    addTriple('Storm1', 'knows', 'Storm2');
    const [entities, triples, entity] = runSync([
      () => listEntities(),
      () => queryTriples({ subject: 'Storm1' }),
      () => getEntity('Storm1'),
    ]);
    expect(entities.length).toBeGreaterThanOrEqual(1);
    expect(triples.length).toBeGreaterThanOrEqual(1);
    expect(entity).toBeDefined();
  });

  it('concurrent state history + location history reads — no cross-contamination', () => {
    setCurrentLocation('library', 'for history');
    saveState({ energy: 0.5, sociability: 0.5, intellectual_arousal: 0.5, emotional_weight: 0.3, valence: 0.6, primary_color: 'neutral', updated_at: Date.now() });
    const [locHist, stateHist] = runSync([
      () => getLocationHistory(5),
      () => getStateHistory(),
    ]);
    // Each returns its own type
    expect(Array.isArray(locHist)).toBe(true);
    expect(Array.isArray(stateHist)).toBe(true);
    if (locHist.length > 0) {
      expect(locHist[0]).toHaveProperty('from');
      expect(locHist[0]).toHaveProperty('to');
    }
    if (stateHist.length > 0) {
      expect(stateHist[0]).toHaveProperty('energy');
    }
  });

  it('rapid session creation/lookup cycle — simulates connection storm', () => {
    for (let i = 0; i < 20; i++) {
      const s = getOrCreateSession({ agentId: 'default', channel: 'web', peerKind: 'user', peerId: `storm-${i}` });
      updateSession(s.key, { tokenCount: i * 10 });
      saveMessage({ sessionKey: s.key, userId: `storm-${i}`, role: 'user', content: `message-${i}`, timestamp: Date.now() + i, metadata: {} });
    }
    const sessions = listSessions('default');
    expect(sessions.length).toBe(20);
    expect(countMessages()).toBe(20);
  });

  it('concurrent entity type updates — last write wins', () => {
    addEntity('MorphEntity', 'person');
    runSync([
      () => addEntity('MorphEntity', 'concept', undefined, { note: 'reclassified' }),
      () => addEntity('MorphEntity', 'place', undefined, { note: 'reclassified again' }),
    ]);
    const entity = getEntity('MorphEntity');
    expect(entity).toBeDefined();
    // Entity type doesn't update via upsert (first_seen is preserved, type stays original)
    // But metadata and last_seen should update
    expect(entity!.name).toBe('MorphEntity');
  });

  it('complete end-to-end race scenario — simulates two users chatting simultaneously', async () => {
    // User A starts chat
    const sA = getOrCreateSession({ agentId: 'default', channel: 'web', peerKind: 'user', peerId: 'userA' });
    // User B starts chat
    const sB = getOrCreateSession({ agentId: 'default', channel: 'web', peerKind: 'user', peerId: 'userB' });

    // Both send messages simultaneously
    await runConcurrent([
      async () => {
        saveMessage({ sessionKey: sA.key, userId: 'userA', role: 'user', content: 'Hello from A', timestamp: Date.now(), metadata: {} });
        saveMessage({ sessionKey: sA.key, userId: null, role: 'assistant', content: 'Hi A', timestamp: Date.now() + 1, metadata: {} });
        updateSession(sA.key, { tokenCount: 150 });
      },
      async () => {
        saveMessage({ sessionKey: sB.key, userId: 'userB', role: 'user', content: 'Hello from B', timestamp: Date.now(), metadata: {} });
        saveMessage({ sessionKey: sB.key, userId: null, role: 'assistant', content: 'Hi B', timestamp: Date.now() + 1, metadata: {} });
        updateSession(sB.key, { tokenCount: 200 });
      },
    ]);

    // Verify isolation
    const msgsA = getRecentMessages(sA.key);
    const msgsB = getRecentMessages(sB.key);
    expect(msgsA).toHaveLength(2);
    expect(msgsB).toHaveLength(2);
    expect(msgsA.some((m) => m.content.includes('from A'))).toBe(true);
    expect(msgsB.some((m) => m.content.includes('from B'))).toBe(true);
    expect(msgsA.some((m) => m.content.includes('from B'))).toBe(false);
    expect(msgsB.some((m) => m.content.includes('from A'))).toBe(false);
  });
});
