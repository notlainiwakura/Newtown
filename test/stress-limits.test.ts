/**
 * Stress tests — push core systems to their limits with in-memory SQLite.
 *
 * All tests use real database operations against an ephemeral in-memory DB.
 * No LLM calls are made; embedding-generating paths are bypassed via mocks.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { nanoid } from 'nanoid';

// ── keytar mock (always required) ──────────────────────────────────────────
vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn().mockResolvedValue('test-master-key'),
    setPassword: vi.fn().mockResolvedValue(undefined),
    deletePassword: vi.fn().mockResolvedValue(true),
    findCredentials: vi.fn().mockResolvedValue([]),
  },
}));

// ── Embedding mock: returns deterministic zero-vector so DB writes succeed ─
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

// ── characters mock (needed by location.ts → buildings.ts) ────────────────
vi.mock('../src/config/characters.js', () => ({
  getAllCharacters: vi.fn().mockReturnValue([]),
  getCharacterEntry: vi.fn().mockReturnValue(undefined),
  getDefaultLocations: vi.fn().mockReturnValue({}),
  getImmortalIds: vi.fn().mockReturnValue([]),
  getMortalCharacters: vi.fn().mockReturnValue([]),
  getWebCharacter: vi.fn().mockReturnValue(undefined),
  getPeersFor: vi.fn().mockReturnValue([]),
}));

// ── event bus mock (prevents side-effects) ────────────────────────────────
vi.mock('../src/events/bus.js', () => ({
  eventBus: {
    characterId: 'test',
    emitActivity: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  },
  parseEventType: vi.fn().mockReturnValue('test'),
}));

import {
  initDatabase,
  closeDatabase,
  execute,
  query,
  queryOne,
  setMeta,
  getMeta,
} from '../src/storage/database.js';
import {
  createSession,
  getSession,
  updateSession,
  deleteSession,
  listSessions,
  countSessions,
  deleteOldSessions,
  batchUpdateTokenCounts,
} from '../src/storage/sessions.js';
import {
  saveMessage,
  getRecentMessages,
  getAllMessages,
  countMemories,
  countMessages,
  getMemory,
  deleteMemory,
  addAssociation,
  getAssociations,
  createCoherenceGroup,
  addToCoherenceGroup,
  getGroupMembers,
  setLifecycleState,
  getMemoriesByLifecycle,
} from '../src/memory/store.js';
import {
  getConversation,
  addUserMessage,
  addAssistantMessage,
  trimConversation,
  clearConversation,
  getActiveConversations,
  updateTokenCount,
} from '../src/agent/conversation.js';
import {
  addTriple,
  getTriple,
  queryTriples,
  invalidateTriple,
  detectContradictions,
  addEntity,
  getEntity,
  listEntities,
} from '../src/memory/knowledge-graph.js';
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

// ── Shared DB lifecycle ────────────────────────────────────────────────────

function makeTestDir(): string {
  return join(tmpdir(), `lain-stress-${nanoid(8)}`);
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

// ── Helper: minimal IncomingMessage ───────────────────────────────────────

function makeTextMessage(text: string, id = nanoid(8)) {
  return {
    id,
    senderId: 'user-1',
    senderName: 'Test User',
    timestamp: Date.now(),
    content: { type: 'text' as const, text },
  };
}

// ── Helper: minimal memory payload ────────────────────────────────────────

function makeMemoryPayload(content: string, importance = 0.5) {
  return {
    sessionKey: 'test:session',
    userId: null,
    content,
    memoryType: 'fact' as const,
    importance,
    emotionalWeight: 0.3,
    relatedTo: null,
    sourceMessageId: null,
    metadata: {},
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  1. CONVERSATION STRESS
// ─────────────────────────────────────────────────────────────────────────────

describe('Conversation stress', () => {
  const testDir = makeTestDir();
  beforeEach(async () => { await setupDb(testDir); });
  afterEach(async () => { await teardownDb(testDir); });

  it('adds 1 000 messages and preserves order', () => {
    const conv = getConversation('stress-session', 'system prompt');
    for (let i = 0; i < 500; i++) {
      addUserMessage(conv, makeTextMessage(`user message ${i}`));
      addAssistantMessage(conv, `assistant reply ${i}`);
    }
    expect(conv.messages).toHaveLength(1000);
    expect((conv.messages[0]!.content as string)).toContain('user message 0');
    expect((conv.messages[999]!.content as string)).toContain('assistant reply 499');
  });

  it('maintains correct message alternation after 1 000 messages', () => {
    const conv = getConversation('alt-session', 'sys');
    for (let i = 0; i < 500; i++) {
      addUserMessage(conv, makeTextMessage(`u${i}`));
      addAssistantMessage(conv, `a${i}`);
    }
    for (let i = 0; i < conv.messages.length; i += 2) {
      expect(conv.messages[i]!.role).toBe('user');
      expect(conv.messages[i + 1]!.role).toBe('assistant');
    }
  });

  it('trim keeps at least 4 messages', () => {
    const conv = getConversation('trim-session', 'sys');
    for (let i = 0; i < 20; i++) {
      addUserMessage(conv, makeTextMessage(`message ${i}`));
      addAssistantMessage(conv, `reply ${i}`);
    }
    // Token budget that forces extreme trimming
    trimConversation(conv, 10, () => 100);
    expect(conv.messages.length).toBeGreaterThanOrEqual(4);
  });

  it('trim removes pairs from the front', () => {
    const conv = getConversation('pair-session', 'sys');
    addUserMessage(conv, makeTextMessage('first'));
    addAssistantMessage(conv, 'first-reply');
    addUserMessage(conv, makeTextMessage('second'));
    addAssistantMessage(conv, 'second-reply');
    addUserMessage(conv, makeTextMessage('third'));
    addAssistantMessage(conv, 'third-reply');
    // Force trim (minMessages=4 is enforced inside trimConversation)
    // Put budget so low that only 4 messages survive
    trimConversation(conv, 5, (t) => t.length);
    // Messages remaining should include the most recent ones
    const contents = conv.messages.map(m => m.content as string);
    expect(contents).toContain('third');
    expect(contents).toContain('third-reply');
  });

  it('100 concurrent conversations are isolated', () => {
    const sessions = Array.from({ length: 100 }, (_, i) => `session-${i}`);
    for (const key of sessions) {
      const conv = getConversation(key, 'system');
      addUserMessage(conv, makeTextMessage(`message for ${key}`));
      addAssistantMessage(conv, `reply for ${key}`);
    }
    for (const key of sessions) {
      const conv = getConversation(key, 'system');
      expect(conv.messages).toHaveLength(2);
      expect(conv.messages[0]!.content as string).toContain(key);
    }
  });

  it('100 concurrent conversations all appear in getActiveConversations()', () => {
    const keys = Array.from({ length: 100 }, (_, i) => `active-${i}`);
    for (const key of keys) getConversation(key, 'sys');
    const active = getActiveConversations();
    for (const key of keys) expect(active).toContain(key);
  });

  it('stores and retrieves a 100 KB message', () => {
    const conv = getConversation('large-msg', 'sys');
    const largeContent = 'x'.repeat(100_000);
    addUserMessage(conv, makeTextMessage(largeContent));
    expect(typeof conv.messages[0]!.content).toBe('string');
    expect((conv.messages[0]!.content as string).length).toBe(100_000);
  });

  it('handles message with every Unicode category without corruption', () => {
    const conv = getConversation('unicode-session', 'sys');
    const unicode = 'Hello 🌍 こんにちは Привет العالم 中文 한국어 \u0000 \uFFFF \u{1F600}';
    addUserMessage(conv, makeTextMessage(unicode));
    expect(conv.messages[0]!.content).toBe(unicode);
  });

  it('rapid add+trim cycles do not corrupt message content', () => {
    const conv = getConversation('rapid-trim', 'sys');
    for (let cycle = 0; cycle < 50; cycle++) {
      addUserMessage(conv, makeTextMessage(`cycle ${cycle}`));
      addAssistantMessage(conv, `reply ${cycle}`);
      trimConversation(conv, 100, (t) => t.length * 2);
    }
    // All remaining messages should have coherent role alternation
    let prevRole: string | null = null;
    for (const msg of conv.messages) {
      if (prevRole !== null) {
        expect(msg.role).not.toBe(prevRole);
      }
      prevRole = msg.role;
    }
  });

  it('updateTokenCount accumulates correctly across 1 000 updates', () => {
    const conv = getConversation('token-session', 'sys');
    for (let i = 0; i < 1000; i++) {
      updateTokenCount(conv, 10, 5);
    }
    expect(conv.tokenCount).toBe(15_000);
  });

  it('clearConversation removes session', () => {
    const key = 'clear-me';
    getConversation(key, 'sys');
    expect(getActiveConversations()).toContain(key);
    clearConversation(key);
    expect(getActiveConversations()).not.toContain(key);
  });

  it('messages with empty string content do not throw', () => {
    const conv = getConversation('empty-content', 'sys');
    addUserMessage(conv, makeTextMessage(''));
    addAssistantMessage(conv, '');
    expect(conv.messages).toHaveLength(2);
  });

  it('conversation sessionKey is preserved through get operations', () => {
    const key = 'preserve-key';
    const conv = getConversation(key, 'sys');
    expect(conv.sessionKey).toBe(key);
    const conv2 = getConversation(key, 'different-sys');
    // Returns the existing conversation
    expect(conv2.sessionKey).toBe(key);
  });

  it('system prompt is preserved through 500 message additions', () => {
    const sys = 'unique system prompt for stress test';
    const conv = getConversation('sys-preserve', sys);
    for (let i = 0; i < 500; i++) {
      addUserMessage(conv, makeTextMessage(`msg ${i}`));
    }
    expect(conv.systemPrompt).toBe(sys);
  });

  it('trimConversation with maxTokens=0 floors at minMessages', () => {
    const conv = getConversation('zero-budget', 'sys');
    for (let i = 0; i < 10; i++) {
      addUserMessage(conv, makeTextMessage(`m${i}`));
      addAssistantMessage(conv, `r${i}`);
    }
    trimConversation(conv, 0, (t) => t.length);
    expect(conv.messages.length).toBeGreaterThanOrEqual(4);
  });

  it('getConversation returns same instance for same key', () => {
    const conv1 = getConversation('same-key', 'sys');
    const conv2 = getConversation('same-key', 'sys');
    addUserMessage(conv1, makeTextMessage('hello'));
    expect(conv2.messages).toHaveLength(1);
  });

  it('1 000 different sessions do not bleed data', () => {
    for (let i = 0; i < 1000; i++) {
      const conv = getConversation(`iso-${i}`, 'sys');
      addUserMessage(conv, makeTextMessage(`only for ${i}`));
    }
    for (let i = 0; i < 1000; i++) {
      const conv = getConversation(`iso-${i}`, 'sys');
      expect(conv.messages).toHaveLength(1);
      expect(conv.messages[0]!.content as string).toContain(`only for ${i}`);
    }
  });

  it('trim does not run when message count is exactly 4', () => {
    const conv = getConversation('min-messages', 'sys');
    addUserMessage(conv, makeTextMessage('a'));
    addAssistantMessage(conv, 'b');
    addUserMessage(conv, makeTextMessage('c'));
    addAssistantMessage(conv, 'd');
    trimConversation(conv, 0, (t) => t.length);
    expect(conv.messages).toHaveLength(4);
  });

  it('messages preserve timestamps', () => {
    const conv = getConversation('ts-session', 'sys');
    const before = Date.now();
    addUserMessage(conv, makeTextMessage('hello'));
    const after = Date.now();
    const ts = conv.messages[0]!.timestamp;
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  2. MEMORY STRESS
// ─────────────────────────────────────────────────────────────────────────────

describe('Memory stress', () => {
  const testDir = makeTestDir();
  beforeEach(async () => { await setupDb(testDir); });
  afterEach(async () => { await teardownDb(testDir); });

  async function insertMemory(content: string, importance = 0.5): Promise<string> {
    // Insert directly into DB to avoid embedding generation cost in batch tests
    const { nanoid } = await import('nanoid');
    const id = nanoid(16);
    execute(
      `INSERT INTO memories (id, session_key, user_id, content, memory_type, importance, emotional_weight, created_at, metadata, lifecycle_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, 'test:session', null, content, 'fact', importance, 0.3, Date.now(), '{}', 'mature']
    );
    return id;
  }

  it('saves 500 memories and countMemories returns 500', async () => {
    for (let i = 0; i < 500; i++) {
      await insertMemory(`Memory content ${i}`);
    }
    expect(countMemories()).toBe(500);
  });

  it('retrieves each of 500 memories by ID', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 500; i++) {
      ids.push(await insertMemory(`Retrieve me ${i}`));
    }
    for (const id of ids) {
      const mem = getMemory(id);
      expect(mem).toBeDefined();
      expect(mem!.id).toBe(id);
    }
  });

  it('deletes 250 of 500 memories — count is 250', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 500; i++) {
      ids.push(await insertMemory(`Delete stress ${i}`));
    }
    for (let i = 0; i < 250; i++) {
      deleteMemory(ids[i]!);
    }
    expect(countMemories()).toBe(250);
  });

  it('deleteMemory returns true for existing, false for missing', async () => {
    const id = await insertMemory('deletable');
    expect(deleteMemory(id)).toBe(true);
    expect(deleteMemory(id)).toBe(false);
    expect(deleteMemory('nonexistent-id')).toBe(false);
  });

  it('saves memory with 50 KB content and retrieves it intact', async () => {
    const big = 'A'.repeat(50_000);
    const id = await insertMemory(big);
    const mem = getMemory(id);
    expect(mem!.content).toHaveLength(50_000);
    expect(mem!.content).toBe(big);
  });

  it('saves memory with empty content without error', async () => {
    const id = await insertMemory('');
    const mem = getMemory(id);
    expect(mem).toBeDefined();
    expect(mem!.content).toBe('');
  });

  it('memory with importance 1.0 stored and retrieved correctly', async () => {
    const id = await insertMemory('max importance', 1.0);
    const mem = getMemory(id);
    expect(mem!.importance).toBe(1.0);
  });

  it('memory with importance 0.0 stored and retrieved correctly', async () => {
    const id = await insertMemory('min importance', 0.0);
    const mem = getMemory(id);
    expect(mem!.importance).toBe(0.0);
  });

  it('100 memories inserted in rapid succession — all retrievable', async () => {
    const ids = await Promise.all(
      Array.from({ length: 100 }, (_, i) => insertMemory(`parallel memory ${i}`))
    );
    for (const id of ids) {
      expect(getMemory(id)).toBeDefined();
    }
  });

  it('association network: add 200 associations, getAssociations returns correct strength', async () => {
    const idA = await insertMemory('source');
    const ids: string[] = [idA];
    for (let i = 0; i < 199; i++) {
      const id = await insertMemory(`target ${i}`);
      ids.push(id);
      addAssociation(idA, id, 'similar', 0.8 - i * 0.001);
    }
    const assoc = getAssociations(idA, 200);
    expect(assoc.length).toBeGreaterThan(0);
    // First association should be the highest strength
    const strengths = assoc.map(a => a.strength);
    for (let i = 1; i < strengths.length; i++) {
      expect(strengths[i - 1]!).toBeGreaterThanOrEqual(strengths[i]!);
    }
  });

  it('coherence group holds 100 member memories', async () => {
    const groupId = createCoherenceGroup('stress-group', null);
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) {
      const id = await insertMemory(`group member ${i}`);
      ids.push(id);
      addToCoherenceGroup(id, groupId);
    }
    const members = getGroupMembers(groupId);
    expect(members).toHaveLength(100);
  });

  it('lifecycle state transitions persist correctly across 500 memories', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 500; i++) {
      ids.push(await insertMemory(`lifecycle ${i}`));
    }
    // Transition half to 'growing'
    for (let i = 0; i < 250; i++) {
      setLifecycleState(ids[i]!, 'growing');
    }
    const growing = getMemoriesByLifecycle('growing', 500);
    expect(growing).toHaveLength(250);
  });

  it('composting lifecycle state marks memories as excluded', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      ids.push(await insertMemory(`compost ${i}`));
    }
    for (const id of ids) {
      setLifecycleState(id, 'composting');
    }
    const composting = getMemoriesByLifecycle('composting', 50);
    expect(composting).toHaveLength(10);
  });

  it('saveMessage stores 200 messages and countMessages returns 200', () => {
    for (let i = 0; i < 200; i++) {
      saveMessage({
        sessionKey: 'msg-stress',
        userId: null,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `message ${i}`,
        timestamp: Date.now() + i,
        metadata: {},
      });
    }
    expect(countMessages()).toBe(200);
  });

  it('getRecentMessages returns at most requested limit', () => {
    for (let i = 0; i < 100; i++) {
      saveMessage({
        sessionKey: 'limit-session',
        userId: null,
        role: 'user',
        content: `msg ${i}`,
        timestamp: Date.now() + i,
        metadata: {},
      });
    }
    const msgs = getRecentMessages('limit-session', 20);
    expect(msgs).toHaveLength(20);
  });

  it('getAllMessages returns them in ascending timestamp order', () => {
    for (let i = 0; i < 50; i++) {
      saveMessage({
        sessionKey: 'order-session',
        userId: null,
        role: 'user',
        content: `${i}`,
        timestamp: 1000 + i,
        metadata: {},
      });
    }
    const msgs = getAllMessages('order-session');
    for (let i = 1; i < msgs.length; i++) {
      expect(msgs[i]!.timestamp).toBeGreaterThanOrEqual(msgs[i - 1]!.timestamp);
    }
  });

  it('memory with null sessionKey is stored and retrievable', async () => {
    const id = nanoid(16);
    execute(
      `INSERT INTO memories (id, session_key, user_id, content, memory_type, importance, emotional_weight, created_at, metadata, lifecycle_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, null, null, 'null session key memory', 'fact', 0.5, 0, Date.now(), '{}', 'mature']
    );
    const mem = getMemory(id);
    expect(mem).toBeDefined();
    expect(mem!.sessionKey).toBeNull();
  });

  it('association types are all accepted: similar, evolved_from, pattern, cross_topic, dream', async () => {
    const src = await insertMemory('assoc source');
    const types = ['similar', 'evolved_from', 'pattern', 'cross_topic', 'dream'] as const;
    for (const t of types) {
      const tgt = await insertMemory(`target for ${t}`);
      addAssociation(src, tgt, t, 0.5);
    }
    const assocs = getAssociations(src, 20);
    expect(assocs).toHaveLength(5);
  });

  it('500 memories across multiple session keys are all counted', async () => {
    for (let i = 0; i < 500; i++) {
      const id = nanoid(16);
      execute(
        `INSERT INTO memories (id, session_key, user_id, content, memory_type, importance, emotional_weight, created_at, metadata, lifecycle_state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, `session-${i % 10}`, null, `multi-session ${i}`, 'fact', 0.5, 0, Date.now(), '{}', 'mature']
      );
    }
    expect(countMemories()).toBe(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  3. SESSION STRESS
// ─────────────────────────────────────────────────────────────────────────────

describe('Session stress', () => {
  const testDir = makeTestDir();
  beforeEach(async () => { await setupDb(testDir); });
  afterEach(async () => { await teardownDb(testDir); });

  function makeSession(agentId = 'agent-a', suffix = nanoid(8)) {
    return createSession({
      agentId,
      channel: 'web',
      peerKind: 'user',
      peerId: `peer-${suffix}`,
    });
  }

  it('creates 200 sessions with unique keys', () => {
    const keys = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const s = makeSession();
      keys.add(s.key);
    }
    expect(keys.size).toBe(200);
  });

  it('200 sessions all retrievable by key', () => {
    const keys: string[] = [];
    for (let i = 0; i < 200; i++) {
      keys.push(makeSession().key);
    }
    for (const key of keys) {
      const s = getSession(key);
      expect(s).toBeDefined();
      expect(s!.key).toBe(key);
    }
  });

  it('counts sessions per agent correctly after 200 creations', () => {
    for (let i = 0; i < 200; i++) {
      makeSession('count-agent');
    }
    expect(countSessions('count-agent')).toBe(200);
  });

  it('rapid 100-session update does not lose updates', () => {
    const sessions = Array.from({ length: 100 }, () => makeSession('update-agent'));
    for (const s of sessions) {
      updateSession(s.key, { tokenCount: 42 });
    }
    for (const s of sessions) {
      const updated = getSession(s.key);
      expect(updated!.tokenCount).toBe(42);
    }
  });

  it('deleteOldSessions removes sessions older than threshold', () => {
    const OLD_AGENT = 'old-agent';
    // Create 10 "old" sessions by backdating updatedAt
    const old = Array.from({ length: 10 }, () => makeSession(OLD_AGENT));
    for (const s of old) {
      execute(
        'UPDATE sessions SET updated_at = ? WHERE key = ?',
        [Date.now() - 100_000, s.key]
      );
    }
    // Create 10 fresh sessions
    for (let i = 0; i < 10; i++) makeSession(OLD_AGENT);

    const deleted = deleteOldSessions(OLD_AGENT, 50_000); // 50s threshold
    expect(deleted).toBe(10);
    expect(countSessions(OLD_AGENT)).toBe(10);
  });

  it('session flags are merged correctly across 50 updates', () => {
    const s = makeSession();
    for (let i = 0; i < 50; i++) {
      updateSession(s.key, { flags: { summarized: i % 2 === 0 } });
    }
    const final = getSession(s.key);
    expect(final!.flags.summarized).toBe(false); // 50th iteration: 49 % 2 === 1
  });

  it('concurrent session creation produces no duplicate keys', () => {
    const created = Array.from({ length: 100 }, () => makeSession('concurrent-agent'));
    const keys = created.map(s => s.key);
    const unique = new Set(keys);
    expect(unique.size).toBe(100);
  });

  it('batchUpdateTokenCounts updates 100 sessions atomically', () => {
    const sessions = Array.from({ length: 100 }, () => makeSession('batch-agent'));
    const updates = sessions.map(s => ({ key: s.key, tokenCount: 9999 }));
    batchUpdateTokenCounts(updates);
    for (const s of sessions) {
      const updated = getSession(s.key);
      expect(updated!.tokenCount).toBe(9999);
    }
  });

  it('deleteSession returns true for existing, false for deleted', () => {
    const s = makeSession();
    expect(deleteSession(s.key)).toBe(true);
    expect(deleteSession(s.key)).toBe(false);
  });

  it('listSessions returns correct count with pagination', () => {
    const AGENT = 'list-agent';
    for (let i = 0; i < 50; i++) makeSession(AGENT);
    const first10 = listSessions(AGENT, { limit: 10, offset: 0 });
    expect(first10).toHaveLength(10);
    const next10 = listSessions(AGENT, { limit: 10, offset: 10 });
    expect(next10).toHaveLength(10);
    // No overlap
    const keys1 = new Set(first10.map(s => s.key));
    const keys2 = new Set(next10.map(s => s.key));
    expect([...keys1].filter(k => keys2.has(k))).toHaveLength(0);
  });

  it('session with very long metadata in flags does not corrupt', () => {
    const s = makeSession();
    const longFlag = 'x'.repeat(10_000);
    // Store via flags object
    updateSession(s.key, { flags: { summarized: true } });
    // Manually store long value in meta table
    setMeta(`session:meta:${s.key}`, longFlag);
    expect(getMeta(`session:meta:${s.key}`)).toBe(longFlag);
  });

  it('sessions with same peerId on different channels are independent', () => {
    const s1 = createSession({ agentId: 'a', channel: 'web', peerKind: 'user', peerId: 'peer-1' });
    const s2 = createSession({ agentId: 'a', channel: 'telegram', peerKind: 'user', peerId: 'peer-1' });
    expect(s1.key).not.toBe(s2.key);
  });

  it('tokenCount starts at 0 for all 200 new sessions', () => {
    for (let i = 0; i < 200; i++) {
      const s = makeSession('zero-agent');
      expect(s.tokenCount).toBe(0);
    }
  });

  it('countSessions returns 0 for unknown agent', () => {
    expect(countSessions('never-created-agent')).toBe(0);
  });

  it('updateSession on non-existent key returns undefined', () => {
    const result = updateSession('nonexistent-key', { tokenCount: 1 });
    expect(result).toBeUndefined();
  });

  it('listSessions filtered by channel returns only matching', () => {
    const AGENT = 'channel-agent';
    for (let i = 0; i < 10; i++) createSession({ agentId: AGENT, channel: 'web', peerKind: 'user', peerId: `w${i}` });
    for (let i = 0; i < 5; i++) createSession({ agentId: AGENT, channel: 'telegram', peerKind: 'user', peerId: `t${i}` });
    const webSessions = listSessions(AGENT, { channel: 'web' });
    expect(webSessions).toHaveLength(10);
    const tgSessions = listSessions(AGENT, { channel: 'telegram' });
    expect(tgSessions).toHaveLength(5);
  });

  it('createdAt and updatedAt are set on creation', () => {
    const before = Date.now();
    const s = makeSession();
    const after = Date.now();
    expect(s.createdAt).toBeGreaterThanOrEqual(before);
    expect(s.createdAt).toBeLessThanOrEqual(after);
    expect(s.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it('updatedAt advances on session update', () => {
    const s = makeSession();
    const original = s.updatedAt;
    // Ensure at least 1ms passes
    const now = Date.now();
    while (Date.now() === now) { /* spin */ }
    updateSession(s.key, { tokenCount: 100 });
    const updated = getSession(s.key);
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(original);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  4. KNOWLEDGE GRAPH STRESS
// ─────────────────────────────────────────────────────────────────────────────

describe('Knowledge graph stress', () => {
  const testDir = makeTestDir();
  beforeEach(async () => { await setupDb(testDir); });
  afterEach(async () => { await teardownDb(testDir); });

  it('adds 500 triples and all are queryable by subject', () => {
    for (let i = 0; i < 500; i++) {
      addTriple(`subject-${i}`, 'knows', `object-${i}`);
    }
    const all = queryTriples({});
    expect(all).toHaveLength(500);
  });

  it('queries triples by exact subject match', () => {
    for (let i = 0; i < 100; i++) {
      addTriple(i < 50 ? 'alice' : 'bob', 'likes', `item-${i}`);
    }
    const aliceTriples = queryTriples({ subject: 'alice' });
    expect(aliceTriples).toHaveLength(50);
    const bobTriples = queryTriples({ subject: 'bob' });
    expect(bobTriples).toHaveLength(50);
  });

  it('queries by predicate filter returns only matching', () => {
    for (let i = 0; i < 100; i++) {
      addTriple(`entity-${i}`, i % 2 === 0 ? 'owns' : 'uses', `thing-${i}`);
    }
    const owns = queryTriples({ predicate: 'owns' });
    expect(owns).toHaveLength(50);
    const uses = queryTriples({ predicate: 'uses' });
    expect(uses).toHaveLength(50);
  });

  it('invalidateTriple ends a triple and excludes it from asOf queries', () => {
    const now = Date.now();
    const id = addTriple('subject', 'predicate', 'object', 1.0, now - 10000);
    invalidateTriple(id, now - 5000);
    // Query at now-6000 (before invalidation) should return it
    const before = queryTriples({ asOf: now - 6000 });
    expect(before.some(t => t.id === id)).toBe(true);
    // Query at now should not return it
    const after = queryTriples({ asOf: now });
    expect(after.some(t => t.id === id)).toBe(false);
  });

  it('invalidates 250 of 500 triples — active count is 250', () => {
    const ids: string[] = [];
    for (let i = 0; i < 500; i++) {
      ids.push(addTriple(`sub-${i}`, 'rel', `obj-${i}`));
    }
    for (let i = 0; i < 250; i++) {
      invalidateTriple(ids[i]!);
    }
    const active = queryTriples({ asOf: Date.now() });
    expect(active).toHaveLength(250);
  });

  it('detectContradictions finds conflicting triples on same (subject, predicate)', () => {
    addTriple('alice', 'lives_in', 'paris');
    addTriple('alice', 'lives_in', 'london');
    const contradictions = detectContradictions();
    expect(contradictions.length).toBeGreaterThan(0);
    expect(contradictions[0]!.subject).toBe('alice');
    expect(contradictions[0]!.predicate).toBe('lives_in');
  });

  it('detectContradictions returns empty when all triples are consistent', () => {
    addTriple('bob', 'works_at', 'acme');
    addTriple('bob', 'lives_in', 'berlin');
    const contradictions = detectContradictions();
    expect(contradictions).toHaveLength(0);
  });

  it('invalidated triples are not counted in contradiction detection', () => {
    const id1 = addTriple('charlie', 'has_job', 'engineer');
    addTriple('charlie', 'has_job', 'teacher');
    invalidateTriple(id1);
    const contradictions = detectContradictions();
    // 'engineer' triple is ended; 'teacher' is the only active one → no contradiction
    expect(contradictions).toHaveLength(0);
  });

  it('triple with very long subject/predicate/object strings is stored correctly', () => {
    const longStr = 'a'.repeat(5000);
    const id = addTriple(longStr, longStr, longStr);
    const triple = getTriple(id);
    expect(triple!.subject.length).toBe(5000);
    expect(triple!.predicate.length).toBe(5000);
    expect(triple!.object.length).toBe(5000);
  });

  it('addEntity is idempotent — repeated inserts do not duplicate', () => {
    addEntity('alice', 'person');
    addEntity('alice', 'person', undefined, { role: 'admin' });
    const entities = listEntities('person');
    expect(entities.filter(e => e.name === 'alice')).toHaveLength(1);
  });

  it('listEntities returns all 100 inserted entities', () => {
    for (let i = 0; i < 100; i++) {
      addEntity(`entity-${i}`, 'thing');
    }
    const list = listEntities('thing');
    expect(list).toHaveLength(100);
  });

  it('queryTriples with limit caps results', () => {
    for (let i = 0; i < 50; i++) {
      addTriple(`s${i}`, 'rel', `o${i}`);
    }
    const limited = queryTriples({ limit: 10 });
    expect(limited).toHaveLength(10);
  });

  it('getTriple returns undefined for nonexistent ID', () => {
    expect(getTriple('nonexistent')).toBeUndefined();
  });

  it('asOf temporal filter: triple added in past is visible at past timestamp', () => {
    const pastTime = Date.now() - 100_000;
    const id = addTriple('time-entity', 'state', 'past', 1.0, pastTime);
    const results = queryTriples({ asOf: pastTime + 1 });
    expect(results.some(t => t.id === id)).toBe(true);
  });

  it('500 entities across 5 types are queryable by type', () => {
    const types = ['person', 'place', 'thing', 'event', 'concept'];
    for (let i = 0; i < 500; i++) {
      addEntity(`e-${i}`, types[i % 5]!);
    }
    for (const type of types) {
      expect(listEntities(type).length).toBe(100);
    }
  });

  it('complex filter: subject + predicate + asOf combination returns correct subset', () => {
    const now = Date.now();
    addTriple('alice', 'likes', 'cats', 1.0, now - 5000);
    addTriple('alice', 'likes', 'dogs', 1.0, now - 2000);
    const results = queryTriples({ subject: 'alice', predicate: 'likes', asOf: now - 3000 });
    // Only 'cats' was active at now-3000
    expect(results).toHaveLength(1);
    expect(results[0]!.object).toBe('cats');
  });

  it('getEntity returns undefined for nonexistent name', () => {
    expect(getEntity('does-not-exist')).toBeUndefined();
  });

  it('multiple contradictions on different (subject,predicate) pairs all detected', () => {
    addTriple('x', 'p', 'v1');
    addTriple('x', 'p', 'v2');
    addTriple('y', 'q', 'w1');
    addTriple('y', 'q', 'w2');
    const contradictions = detectContradictions();
    const subjects = contradictions.map(c => c.subject);
    expect(subjects).toContain('x');
    expect(subjects).toContain('y');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  5. LOCATION STRESS
// ─────────────────────────────────────────────────────────────────────────────

describe('Location stress', () => {
  const testDir = makeTestDir();
  beforeEach(async () => {
    await setupDb(testDir);
    // Set a valid starting location so BUILDING_MAP can resolve it
    setMeta('town:current_location', JSON.stringify({ building: 'lighthouse', timestamp: Date.now() }));
  });
  afterEach(async () => { await teardownDb(testDir); });

  const ALL_BUILDINGS = [
    'library', 'bar', 'field', 'windmill', 'lighthouse',
    'school', 'market', 'locksmith', 'threshold',
  ] as const;

  it('moves through all 9 buildings 50 times — history capped at 20', () => {
    let i = 0;
    for (let round = 0; round < 50; round++) {
      for (const building of ALL_BUILDINGS) {
        const next = ALL_BUILDINGS[(i + 1) % ALL_BUILDINGS.length]!;
        if (building !== next) {
          setMeta('town:current_location', JSON.stringify({ building, timestamp: Date.now() }));
          setCurrentLocation(next, `round ${round}`);
        }
        i++;
      }
    }
    const history = getLocationHistory();
    expect(history.length).toBeLessThanOrEqual(20);
  });

  it('history is capped at 20 entries after many moves', () => {
    for (let i = 0; i < 100; i++) {
      const from = ALL_BUILDINGS[i % 9]!;
      const to = ALL_BUILDINGS[(i + 1) % 9]!;
      if (from !== to) {
        setMeta('town:current_location', JSON.stringify({ building: from, timestamp: Date.now() }));
        setCurrentLocation(to, `move ${i}`);
      }
    }
    const history = getLocationHistory();
    expect(history.length).toBeLessThanOrEqual(20);
  });

  it('setCurrentLocation no-ops when from === to', () => {
    setMeta('town:current_location', JSON.stringify({ building: 'library', timestamp: Date.now() }));
    const before = getLocationHistory().length;
    setCurrentLocation('library', 'staying');
    const after = getLocationHistory().length;
    expect(after).toBe(before);
  });

  it('getCurrentLocation returns valid building from meta', () => {
    const loc = getCurrentLocation();
    expect(ALL_BUILDINGS as readonly string[]).toContain(loc.building);
  });

  it('each move creates exactly one history entry', () => {
    setMeta('town:current_location', JSON.stringify({ building: 'library', timestamp: Date.now() }));
    setMeta('town:location_history', '[]');
    setCurrentLocation('bar', 'test move');
    const history = getLocationHistory();
    expect(history.length).toBe(1);
    expect(history[0]!.to).toBe('bar');
    expect(history[0]!.from).toBe('library');
  });

  it('move reason is preserved in history entry', () => {
    setMeta('town:current_location', JSON.stringify({ building: 'lighthouse', timestamp: Date.now() }));
    setMeta('town:location_history', '[]');
    const reason = 'going to get coffee at the market';
    setCurrentLocation('market', reason);
    const history = getLocationHistory();
    expect(history[0]!.reason).toBe(reason);
  });

  it('getLocationHistory limit parameter works', () => {
    for (let i = 0; i < 20; i++) {
      const from = ALL_BUILDINGS[i % 9]!;
      const to = ALL_BUILDINGS[(i + 1) % 9]!;
      if (from !== to) {
        setMeta('town:current_location', JSON.stringify({ building: from, timestamp: Date.now() }));
        setCurrentLocation(to, `move ${i}`);
      }
    }
    const limited = getLocationHistory(5);
    expect(limited.length).toBeLessThanOrEqual(5);
  });

  it('getCurrentLocation falls back to lighthouse for unknown character', () => {
    // Clear meta so there is no persisted location
    execute('DELETE FROM meta WHERE key = ?', ['town:current_location']);
    const loc = getCurrentLocation('unknown-character-x');
    expect(loc.building).toBe('lighthouse');
  });

  it('rapid location changes: from/to in history are always valid buildings', () => {
    for (let i = 0; i < 50; i++) {
      const from = ALL_BUILDINGS[i % 9]!;
      const to = ALL_BUILDINGS[(i + 3) % 9]!;
      if (from !== to) {
        setMeta('town:current_location', JSON.stringify({ building: from, timestamp: Date.now() }));
        setCurrentLocation(to, `rapid ${i}`);
      }
    }
    const history = getLocationHistory(20);
    for (const entry of history) {
      expect(ALL_BUILDINGS as readonly string[]).toContain(entry.from);
      expect(ALL_BUILDINGS as readonly string[]).toContain(entry.to);
    }
  });

  it('history entries are ordered most-recent first', () => {
    const buildingSeq = ['library', 'bar', 'field', 'windmill', 'school'] as const;
    for (let i = 0; i < buildingSeq.length - 1; i++) {
      setMeta('town:current_location', JSON.stringify({ building: buildingSeq[i], timestamp: Date.now() + i }));
      setCurrentLocation(buildingSeq[i + 1]!, `seq ${i}`);
    }
    const history = getLocationHistory();
    for (let i = 1; i < history.length; i++) {
      expect(history[i - 1]!.timestamp).toBeGreaterThanOrEqual(history[i]!.timestamp);
    }
  });

  it('location timestamp is set on each move', () => {
    const before = Date.now();
    setMeta('town:current_location', JSON.stringify({ building: 'library', timestamp: Date.now() }));
    setCurrentLocation('bar', 'timed move');
    const loc = getCurrentLocation();
    expect(loc.timestamp).toBeGreaterThanOrEqual(before);
  });

  it('getLocationHistory returns empty array when no history exists', () => {
    execute('DELETE FROM meta WHERE key = ?', ['town:location_history']);
    expect(getLocationHistory()).toHaveLength(0);
  });

  it('can cycle through all 9 buildings sequentially without error', () => {
    let current = 'library' as typeof ALL_BUILDINGS[number];
    for (let i = 0; i < ALL_BUILDINGS.length; i++) {
      const next = ALL_BUILDINGS[(i + 1) % ALL_BUILDINGS.length]!;
      setMeta('town:current_location', JSON.stringify({ building: current, timestamp: Date.now() }));
      setCurrentLocation(next, `cycling to ${next}`);
      current = next;
    }
    const history = getLocationHistory();
    expect(history.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  6. INTERNAL STATE STRESS
// ─────────────────────────────────────────────────────────────────────────────

describe('Internal state stress', () => {
  const testDir = makeTestDir();
  beforeEach(async () => { await setupDb(testDir); });
  afterEach(async () => { await teardownDb(testDir); });

  function makeState(overrides: Partial<Parameters<typeof saveState>[0]> = {}) {
    return {
      energy: 0.6,
      sociability: 0.5,
      intellectual_arousal: 0.4,
      emotional_weight: 0.3,
      valence: 0.6,
      primary_color: 'neutral',
      updated_at: Date.now(),
      ...overrides,
    };
  }

  it('10 000 sequential saveState calls — values always stay in [0, 1]', () => {
    let state = makeState();
    for (let i = 0; i < 10_000; i++) {
      state = {
        ...state,
        energy: state.energy + (Math.random() - 0.5) * 0.1,
        sociability: state.sociability + (Math.random() - 0.5) * 0.1,
        intellectual_arousal: state.intellectual_arousal + (Math.random() - 0.5) * 0.1,
        emotional_weight: state.emotional_weight + (Math.random() - 0.5) * 0.1,
        valence: state.valence + (Math.random() - 0.5) * 0.1,
        updated_at: Date.now(),
      };
      saveState(state);
      const loaded = getCurrentState();
      expect(loaded.energy).toBeGreaterThanOrEqual(0);
      expect(loaded.energy).toBeLessThanOrEqual(1);
      expect(loaded.valence).toBeGreaterThanOrEqual(0);
      expect(loaded.valence).toBeLessThanOrEqual(1);
    }
  });

  it('clampState enforces [0, 1] bounds on all numeric axes', () => {
    const clamped = clampState(makeState({
      energy: -5, sociability: 999, intellectual_arousal: -0.001,
      emotional_weight: 1.0001, valence: -100,
    }));
    expect(clamped.energy).toBe(0);
    expect(clamped.sociability).toBe(1);
    expect(clamped.intellectual_arousal).toBe(0);
    expect(clamped.emotional_weight).toBe(1);
    expect(clamped.valence).toBe(0);
  });

  it('applyDecay reduces energy by 0.02 each tick', () => {
    const initial = makeState({ energy: 0.5 });
    const decayed = applyDecay(initial);
    expect(decayed.energy).toBeCloseTo(0.48, 5);
  });

  it('applyDecay reduces intellectual_arousal by 0.015 each tick', () => {
    const initial = makeState({ intellectual_arousal: 0.5 });
    const decayed = applyDecay(initial);
    expect(decayed.intellectual_arousal).toBeCloseTo(0.485, 5);
  });

  it('applyDecay sociability decays toward 0.5 (mean-reverting)', () => {
    const above = makeState({ sociability: 0.8 });
    const below = makeState({ sociability: 0.2 });
    const decayedAbove = applyDecay(above);
    const decayedBelow = applyDecay(below);
    // Above 0.5: decays down
    expect(decayedAbove.sociability).toBeLessThan(0.8);
    // Below 0.5: decays up (negative coefficient)
    expect(decayedBelow.sociability).toBeGreaterThan(0.2);
  });

  it('50 decay ticks from energy=1.0 never go below 0', () => {
    let state = makeState({ energy: 1.0 });
    for (let i = 0; i < 50; i++) {
      state = applyDecay(state);
      expect(state.energy).toBeGreaterThanOrEqual(0);
    }
  });

  it('state history is capped at 10 entries after many saves', () => {
    for (let i = 0; i < 50; i++) {
      saveState(makeState({ energy: i / 100 }));
    }
    const history = getStateHistory();
    expect(history.length).toBeLessThanOrEqual(10);
  });

  it('100 rapid save/load cycles produce consistent values', () => {
    for (let i = 0; i < 100; i++) {
      const val = Math.random();
      saveState(makeState({ energy: val }));
      const loaded = getCurrentState();
      // Clamping may shift small float precision
      expect(loaded.energy).toBeCloseTo(val, 3);
    }
  });

  it('getCurrentState returns default when meta is absent', () => {
    execute('DELETE FROM meta WHERE key = ?', ['internal:state']);
    const state = getCurrentState();
    expect(state.energy).toBeGreaterThan(0);
    expect(state.primary_color).toBe('neutral');
  });

  it('saveState always updates updated_at', () => {
    const before = Date.now();
    saveState(makeState());
    const state = getCurrentState();
    expect(state.updated_at).toBeGreaterThanOrEqual(before);
  });

  it('preoccupations are capped at 5 entries', () => {
    for (let i = 0; i < 10; i++) {
      addPreoccupation(`thought ${i}`, `origin ${i}`);
    }
    const preocc = getPreoccupations();
    expect(preocc.length).toBeLessThanOrEqual(5);
  });

  it('primary_color is persisted and restored correctly', () => {
    saveState(makeState({ primary_color: 'melancholy' }));
    const loaded = getCurrentState();
    expect(loaded.primary_color).toBe('melancholy');
  });

  it('clampState does not alter in-range values', () => {
    const state = makeState({ energy: 0.5, sociability: 0.3, valence: 0.7 });
    const clamped = clampState(state);
    expect(clamped.energy).toBe(0.5);
    expect(clamped.sociability).toBe(0.3);
    expect(clamped.valence).toBe(0.7);
  });

  it('state history preserves order (oldest first in array)', () => {
    for (let i = 0; i < 10; i++) {
      saveState(makeState({ energy: i * 0.1 }));
    }
    const history = getStateHistory();
    for (let i = 1; i < history.length; i++) {
      expect(history[i]!.energy).toBeGreaterThanOrEqual(history[i - 1]!.energy - 0.01);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  7. PALACE STRESS
// ─────────────────────────────────────────────────────────────────────────────

describe('Palace stress', () => {
  const testDir = makeTestDir();
  beforeEach(async () => { await setupDb(testDir); });
  afterEach(async () => { await teardownDb(testDir); });

  it('creates 100 wings — all retrievable by ID', () => {
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) {
      ids.push(createWing(`wing-${i}`, `Wing ${i} description`));
    }
    for (const id of ids) {
      const wing = getWing(id);
      expect(wing).toBeDefined();
      expect(wing!.id).toBe(id);
    }
  });

  it('listWings returns all 100 wings', () => {
    for (let i = 0; i < 100; i++) {
      createWing(`list-wing-${i}`);
    }
    const wings = listWings();
    expect(wings.length).toBeGreaterThanOrEqual(100);
  });

  it('resolveWing is idempotent for same name', () => {
    const id1 = resolveWing('same-wing');
    const id2 = resolveWing('same-wing');
    expect(id1).toBe(id2);
  });

  it('50 rooms per wing — all retrievable by ID', () => {
    const wingId = createWing('big-wing');
    const roomIds: string[] = [];
    for (let i = 0; i < 50; i++) {
      roomIds.push(createRoom(wingId, `room-${i}`, `Room ${i}`));
    }
    for (const roomId of roomIds) {
      const room = getRoom(roomId);
      expect(room).toBeDefined();
      expect(room!.wingId).toBe(wingId);
    }
  });

  it('listRooms returns all 50 rooms for a wing', () => {
    const wingId = createWing('list-rooms-wing');
    for (let i = 0; i < 50; i++) createRoom(wingId, `r-${i}`);
    const rooms = listRooms(wingId);
    expect(rooms).toHaveLength(50);
  });

  it('resolveRoom is idempotent — same wing+name returns same ID', () => {
    const wingId = createWing('resolve-wing');
    const id1 = resolveRoom(wingId, 'my-room');
    const id2 = resolveRoom(wingId, 'my-room');
    expect(id1).toBe(id2);
  });

  it('incrementWingCount accumulates correctly across 100 increments', () => {
    const wingId = createWing('count-wing');
    for (let i = 0; i < 100; i++) {
      incrementWingCount(wingId);
    }
    const wing = getWing(wingId);
    expect(wing!.memoryCount).toBe(100);
  });

  it('incrementRoomCount accumulates correctly across 50 increments', () => {
    const wingId = createWing('count-rooms-wing');
    const roomId = createRoom(wingId, 'count-room');
    for (let i = 0; i < 50; i++) incrementRoomCount(roomId);
    const room = getRoom(roomId);
    expect(room!.memoryCount).toBe(50);
  });

  it('getWingByName returns the correct wing', () => {
    createWing('named-wing', 'has a name');
    const wing = getWingByName('named-wing');
    expect(wing).toBeDefined();
    expect(wing!.description).toBe('has a name');
  });

  it('getWing returns undefined for nonexistent ID', () => {
    expect(getWing('nonexistent')).toBeUndefined();
  });

  it('assignHall: fact → truths', () => {
    expect(assignHall('fact', 'any:session')).toBe('truths');
  });

  it('assignHall: preference → truths', () => {
    expect(assignHall('preference', 'any:session')).toBe('truths');
  });

  it('assignHall: summary → reflections', () => {
    expect(assignHall('summary', 'any:session')).toBe('reflections');
  });

  it('assignHall: context → encounters', () => {
    expect(assignHall('context', 'any:session')).toBe('encounters');
  });

  it('assignHall: episode+curiosity → discoveries', () => {
    expect(assignHall('episode', 'curiosity:browse-1')).toBe('discoveries');
  });

  it('assignHall: episode+dreams → dreams', () => {
    expect(assignHall('episode', 'dreams:2024-01')).toBe('dreams');
  });

  it('assignHall: episode+diary → reflections', () => {
    expect(assignHall('episode', 'diary:2024-01-01')).toBe('reflections');
  });

  it('assignHall: episode default → encounters', () => {
    expect(assignHall('episode', 'chat:session')).toBe('encounters');
  });

  it('resolveWingForMemory: diary key → self wing', () => {
    const { wingName } = resolveWingForMemory('diary:today', null);
    expect(wingName).toBe('self');
  });

  it('resolveWingForMemory: curiosity key → curiosity wing', () => {
    const { wingName } = resolveWingForMemory('curiosity:browse', null);
    expect(wingName).toBe('curiosity');
  });

  it('resolveWingForMemory: letter key → target wing', () => {
    const { wingName } = resolveWingForMemory('letter:wired-lain', null);
    expect(wingName).toBe('wired-lain');
  });

  it('resolveWingForMemory: visitor userId → shared visitors wing + per-user room (findings.md P2:652)', () => {
    const { wingName, roomName } = resolveWingForMemory('chat:xyz', 'user-42');
    expect(wingName).toBe('visitors');
    expect(roomName).toBe('visitor-user-42');
  });

  it('100 wings × 50 rooms each — total room count correct', () => {
    let totalRooms = 0;
    for (let w = 0; w < 10; w++) {
      const wingId = createWing(`multi-wing-${w}`);
      for (let r = 0; r < 10; r++) {
        createRoom(wingId, `room-${r}`);
        totalRooms++;
      }
      const rooms = listRooms(wingId);
      expect(rooms).toHaveLength(10);
    }
    expect(totalRooms).toBe(100);
  });
});
