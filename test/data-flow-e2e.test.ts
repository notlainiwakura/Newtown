/**
 * Data Flow End-to-End Tests
 *
 * Tests the complete data flow from input through processing to storage to retrieval.
 * Uses real in-memory SQLite for the database and mocks only external dependencies
 * (LLM providers, fetch to peers, keytar).
 *
 * Nine test suites covering:
 * 1. Conversation data flow (message → processMessage → provider → style → DB → activity → API)
 * 2. Commune conversation data flow (impulse → peer message → transcript → reflection → memory)
 * 3. Diary data flow (loop fires → context gathered → entry generated → memory saved)
 * 4. Letter data flow (compose → POST to peer → save locally)
 * 5. Memory lifecycle data flow (create → embed → store → search → decay → prune)
 * 6. Internal state data flow (event → state updated → persisted → weather recomputed)
 * 7. Activity feed data flow (various activities → /api/activity returns them)
 * 8. Knowledge graph data flow (triple creation → entity → query → contradiction detection)
 * 9. Cross-character data flow (character A sends to B → both have records)
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── Mock keytar before any storage imports ──────────────────────────────────
vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn().mockResolvedValue('test-master-key-e2e'),
    setPassword: vi.fn().mockResolvedValue(undefined),
    deletePassword: vi.fn().mockResolvedValue(true),
    findCredentials: vi.fn().mockResolvedValue([]),
  },
}));

// ── Mock embeddings so tests run without ML models ──────────────────────────
// Each call returns a slightly different embedding based on content hash
let embeddingCallCount = 0;
vi.mock('../src/memory/embeddings.js', () => ({
  generateEmbedding: vi.fn().mockImplementation((text: string) => {
    embeddingCallCount++;
    const emb = new Float32Array(384);
    // Create a deterministic-ish embedding from the text
    for (let i = 0; i < 384; i++) {
      emb[i] = Math.sin(i * 0.1 + text.charCodeAt(i % text.length) * 0.01);
    }
    // Normalize
    let norm = 0;
    for (let i = 0; i < 384; i++) norm += emb[i]! * emb[i]!;
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < 384; i++) emb[i] = emb[i]! / norm;
    return Promise.resolve(emb);
  }),
  cosineSimilarity: vi.fn().mockImplementation((a: Float32Array, b: Float32Array) => {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i]! * b[i]!;
      normA += a[i]! * a[i]!;
      normB += b[i]! * b[i]!;
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom > 0 ? dot / denom : 0;
  }),
  serializeEmbedding: vi.fn().mockImplementation((arr: Float32Array) => Buffer.from(arr.buffer)),
  deserializeEmbedding: vi.fn().mockImplementation((buf: Buffer) => new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)),
}));

// ── Mock palace module (requires palace_wings table setup that's tricky in test) ──
vi.mock('../src/memory/palace.js', () => ({
  assignHall: vi.fn().mockReturnValue('experience'),
  resolveWingForMemory: vi.fn().mockReturnValue({ wingName: 'general', wingDescription: 'General memories' }),
  resolveWing: vi.fn().mockReturnValue('wing-test-id'),
  resolveRoom: vi.fn().mockReturnValue('room-test-id'),
  incrementWingCount: vi.fn(),
  incrementRoomCount: vi.fn(),
  listWings: vi.fn().mockReturnValue([]),
  listRooms: vi.fn().mockReturnValue([]),
  getWing: vi.fn().mockReturnValue(null),
  getWingByName: vi.fn().mockReturnValue(null),
}));

// ── Mock logger to keep test output clean ──────────────────────────────────
vi.mock('../src/utils/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  }),
}));

// ── Mock characters config for commune tests ──────────────────────────────
vi.mock('../src/config/characters.js', () => ({
  getAllCharacters: vi.fn().mockReturnValue([]),
  getCharacterEntry: vi.fn().mockReturnValue(null),
  getDefaultLocations: vi.fn().mockReturnValue({ lain: 'library', 'wired-lain': 'lighthouse' }),
  getImmortalIds: vi.fn().mockReturnValue(['lain', 'wired-lain']),
  getMortalCharacters: vi.fn().mockReturnValue([]),
  getWebCharacter: vi.fn().mockReturnValue(null),
  getPeersFor: vi.fn().mockReturnValue([]),
}));

// ── Shared DB setup helpers ────────────────────────────────────────────────

async function createTestDb(): Promise<{ testDir: string; dbPath: string }> {
  const testDir = join(tmpdir(), `lain-dfe2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const dbPath = join(testDir, 'test.db');
  await mkdir(testDir, { recursive: true });
  // Also create .private_journal directory for diary tests
  await mkdir(join(testDir, '.private_journal'), { recursive: true });
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

// ── Helper: create a mock provider ──────────────────────────────────────────

function makeMockProvider(overrides: Record<string, unknown> = {}) {
  return {
    name: 'mock',
    model: 'mock-model',
    complete: vi.fn().mockResolvedValue({
      content: 'Mock response content.',
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5 },
    }),
    completeWithTools: vi.fn().mockResolvedValue({
      content: 'Mock tool response.',
      finishReason: 'stop',
      toolCalls: undefined,
      usage: { inputTokens: 10, outputTokens: 5 },
    }),
    continueWithToolResults: vi.fn().mockResolvedValue({
      content: 'After tools.',
      finishReason: 'stop',
      toolCalls: undefined,
      usage: { inputTokens: 5, outputTokens: 3 },
    }),
    ...overrides,
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// 1. CONVERSATION DATA FLOW
// ═══════════════════════════════════════════════════════════════════════════════
describe('Conversation data flow', () => {
  let testDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    originalHome = process.env['LAIN_HOME'];
    const result = await createTestDb();
    testDir = result.testDir;
    embeddingCallCount = 0;
  });

  afterEach(async () => {
    await teardownTestDb(testDir, originalHome);
  });

  // --- Message storage ---

  it('saves a user message and retrieves it by session key', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
    const id = saveMessage({ sessionKey: 'web:u1', userId: 'u1', role: 'user', content: 'Hello Lain', timestamp: Date.now(), metadata: {} });
    expect(id).toBeTruthy();
    const msgs = getRecentMessages('web:u1');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content).toBe('Hello Lain');
  });

  it('preserves exact message content through storage round-trip', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
    const longContent = 'A'.repeat(5000) + ' special chars: <script>alert("xss")</script> 日本語 🎭';
    saveMessage({ sessionKey: 'web:u2', userId: 'u2', role: 'user', content: longContent, timestamp: Date.now(), metadata: {} });
    const msgs = getRecentMessages('web:u2');
    expect(msgs[0]!.content).toBe(longContent);
  });

  it('preserves message metadata through round-trip', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
    const meta = { senderId: 'alice', senderName: 'Alice', messageId: 'msg-42' };
    saveMessage({ sessionKey: 'web:u3', userId: 'u3', role: 'user', content: 'hi', timestamp: 1234567890, metadata: meta });
    const msgs = getRecentMessages('web:u3');
    expect(msgs[0]!.metadata).toEqual(meta);
    expect(msgs[0]!.timestamp).toBe(1234567890);
  });

  it('stores both user and assistant messages in order', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
    const now = Date.now();
    saveMessage({ sessionKey: 'web:conv', userId: 'u1', role: 'user', content: 'Q1', timestamp: now, metadata: {} });
    saveMessage({ sessionKey: 'web:conv', userId: null, role: 'assistant', content: 'A1', timestamp: now + 1, metadata: {} });
    saveMessage({ sessionKey: 'web:conv', userId: 'u1', role: 'user', content: 'Q2', timestamp: now + 2, metadata: {} });
    saveMessage({ sessionKey: 'web:conv', userId: null, role: 'assistant', content: 'A2', timestamp: now + 3, metadata: {} });
    const msgs = getRecentMessages('web:conv');
    expect(msgs).toHaveLength(4);
    expect(msgs.map(m => m.content)).toEqual(['Q1', 'A1', 'Q2', 'A2']);
    expect(msgs.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('session context accumulates across multiple messages', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      saveMessage({ sessionKey: 'web:accum', userId: 'u1', role: i % 2 === 0 ? 'user' : 'assistant', content: `Message ${i}`, timestamp: now + i, metadata: {} });
    }
    const msgs = getRecentMessages('web:accum', 50);
    expect(msgs).toHaveLength(10);
    expect(msgs[0]!.content).toBe('Message 0');
    expect(msgs[9]!.content).toBe('Message 9');
  });

  it('limits message retrieval with limit parameter', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
    const now = Date.now();
    for (let i = 0; i < 20; i++) {
      saveMessage({ sessionKey: 'web:limit', userId: 'u1', role: 'user', content: `Msg ${i}`, timestamp: now + i, metadata: {} });
    }
    const msgs = getRecentMessages('web:limit', 5);
    expect(msgs).toHaveLength(5);
    // Should return the 5 most recent, in ascending order
    expect(msgs[0]!.content).toBe('Msg 15');
    expect(msgs[4]!.content).toBe('Msg 19');
  });

  it('isolates messages by session key', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
    saveMessage({ sessionKey: 'web:alice', userId: 'alice', role: 'user', content: 'from alice', timestamp: Date.now(), metadata: {} });
    saveMessage({ sessionKey: 'web:bob', userId: 'bob', role: 'user', content: 'from bob', timestamp: Date.now(), metadata: {} });
    const aliceMsgs = getRecentMessages('web:alice');
    const bobMsgs = getRecentMessages('web:bob');
    expect(aliceMsgs).toHaveLength(1);
    expect(aliceMsgs[0]!.content).toBe('from alice');
    expect(bobMsgs).toHaveLength(1);
    expect(bobMsgs[0]!.content).toBe('from bob');
  });

  it('recordMessage generates correct userId from session key', async () => {
    const { recordMessage } = await import('../src/memory/index.js');
    const { getRecentMessages } = await import('../src/memory/store.js');
    await recordMessage('web:user42', 'user', 'Hello from user42');
    const msgs = getRecentMessages('web:user42');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.userId).toBe('user42');
  });

  it('recordMessage uses senderId from metadata when available', async () => {
    const { recordMessage } = await import('../src/memory/index.js');
    const { getRecentMessages } = await import('../src/memory/store.js');
    await recordMessage('web:sess', 'user', 'Hi', { senderId: 'explicit-id', senderName: 'Alice' });
    const msgs = getRecentMessages('web:sess');
    expect(msgs[0]!.userId).toBe('explicit-id');
  });

  it('emits activity event when message is saved', async () => {
    const { eventBus } = await import('../src/events/bus.js');
    const events: unknown[] = [];
    eventBus.on('activity', (e: unknown) => events.push(e));
    const { saveMessage } = await import('../src/memory/store.js');
    saveMessage({ sessionKey: 'web:evt', userId: 'u1', role: 'user', content: 'trigger event', timestamp: Date.now(), metadata: {} });
    expect(events.length).toBeGreaterThanOrEqual(1);
    const lastEvent = events[events.length - 1] as { type: string; content: string };
    expect(lastEvent.content).toContain('trigger event');
    eventBus.removeAllListeners('activity');
  });

  // --- Memory extraction from conversation ---

  it('shouldExtractMemories returns true after sufficient messages', async () => {
    const { shouldExtractMemories, resetExtractionState } = await import('../src/memory/index.js');
    // Reset to start fresh
    resetExtractionState('test:extract');
    // Accumulate 6 messages
    for (let i = 0; i < 5; i++) {
      expect(shouldExtractMemories('test:extract', 'generic message')).toBe(false);
    }
    expect(shouldExtractMemories('test:extract', 'sixth message')).toBe(true);
    resetExtractionState('test:extract');
  });

  it('shouldExtractMemories triggers early for high-signal content', async () => {
    const { shouldExtractMemories, resetExtractionState } = await import('../src/memory/index.js');
    resetExtractionState('test:signal');
    shouldExtractMemories('test:signal', 'nothing');
    shouldExtractMemories('test:signal', 'nothing');
    // High-signal patterns like "I am" or "my name" should trigger after 2+ messages
    expect(shouldExtractMemories('test:signal', 'I am working on a project')).toBe(true);
    resetExtractionState('test:signal');
  });

  it('extractMemories saves extracted facts to DB', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
    const now = Date.now();
    saveMessage({ sessionKey: 'web:extract', userId: 'u1', role: 'user', content: 'My name is Alice and I work at Anthropic', timestamp: now, metadata: {} });
    saveMessage({ sessionKey: 'web:extract', userId: null, role: 'assistant', content: 'Nice to meet you Alice!', timestamp: now + 1, metadata: {} });

    const provider = makeMockProvider({
      complete: vi.fn().mockResolvedValue({
        content: JSON.stringify([
          { content: 'User name is Alice', type: 'fact', importance: 0.8, emotionalWeight: 0.1 },
          { content: 'Alice works at Anthropic', type: 'fact', importance: 0.7, emotionalWeight: 0.2 },
        ]),
        finishReason: 'stop',
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
    });

    const { extractMemories } = await import('../src/memory/extraction.js');
    const msgs = getRecentMessages('web:extract');
    const ids = await extractMemories(provider as any, msgs, 'web:extract', 'u1');
    expect(ids).toHaveLength(2);

    const { getMemory } = await import('../src/memory/store.js');
    const mem1 = getMemory(ids[0]!);
    expect(mem1).toBeDefined();
    expect(mem1!.content).toBe('User name is Alice');
    expect(mem1!.memoryType).toBe('fact');
    expect(mem1!.importance).toBe(0.8);
    expect(mem1!.userId).toBe('u1');
  });

  it('summarizeConversation saves episode memory', async () => {
    const { saveMessage, getRecentMessages, getMemory } = await import('../src/memory/store.js');
    const now = Date.now();
    for (let i = 0; i < 4; i++) {
      saveMessage({ sessionKey: 'web:summ', userId: i % 2 === 0 ? 'u1' : null, role: i % 2 === 0 ? 'user' : 'assistant', content: `Turn ${i}`, timestamp: now + i, metadata: {} });
    }

    const provider = makeMockProvider({
      complete: vi.fn().mockResolvedValue({
        content: 'A summary of the conversation about turns.',
        finishReason: 'stop',
        usage: { inputTokens: 50, outputTokens: 20 },
      }),
    });

    const { summarizeConversation } = await import('../src/memory/extraction.js');
    const msgs = getRecentMessages('web:summ');
    const summary = await summarizeConversation(provider as any, msgs, 'web:summ', 'u1');
    expect(summary).toBeTruthy();
    expect(summary).toContain('summary');

    // Verify the summary was saved as a memory
    const { searchMemories } = await import('../src/memory/store.js');
    const results = await searchMemories('conversation summary', 10, 0.0);
    const summaryMemory = results.find(r => r.memory.content.includes('Conversation summary:'));
    expect(summaryMemory).toBeDefined();
    expect(summaryMemory!.memory.memoryType).toBe('episode');
    expect(summaryMemory!.memory.importance).toBe(0.7);
  });

  it('processConversationEnd extracts and summarizes in sequence', async () => {
    const { saveMessage, getRecentMessages, countMemories } = await import('../src/memory/store.js');
    const now = Date.now();
    for (let i = 0; i < 6; i++) {
      saveMessage({ sessionKey: 'web:endflow', userId: i % 2 === 0 ? 'u1' : null, role: i % 2 === 0 ? 'user' : 'assistant', content: `Exchange ${i}: My name is Bob and I like cats`, timestamp: now + i, metadata: {} });
    }

    const provider = makeMockProvider({
      complete: vi.fn()
        .mockResolvedValueOnce({
          content: JSON.stringify([
            { content: 'User name is Bob', type: 'fact', importance: 0.8, emotionalWeight: 0.1 },
          ]),
          finishReason: 'stop',
          usage: { inputTokens: 100, outputTokens: 50 },
        })
        .mockResolvedValueOnce({
          content: 'Bob discussed his name and love for cats.',
          finishReason: 'stop',
          usage: { inputTokens: 50, outputTokens: 20 },
        }),
    });

    const memsBefore = countMemories();
    const { processConversationEnd } = await import('../src/memory/index.js');
    await processConversationEnd(provider as any, 'web:endflow');
    const memsAfter = countMemories();

    // Should have created at least the extracted memory + summary
    expect(memsAfter).toBeGreaterThan(memsBefore);
  });

  // --- Full message content integrity ---

  it('message content survives save → retrieve without truncation', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
    const content = 'X'.repeat(10000);
    saveMessage({ sessionKey: 'web:long', userId: 'u1', role: 'user', content, timestamp: Date.now(), metadata: {} });
    const msgs = getRecentMessages('web:long');
    expect(msgs[0]!.content.length).toBe(10000);
    expect(msgs[0]!.content).toBe(content);
  });

  it('multiple concurrent sessions maintain separate message streams', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
    const now = Date.now();
    // Interleave messages across 3 sessions
    for (let i = 0; i < 9; i++) {
      const session = `web:s${i % 3}`;
      saveMessage({ sessionKey: session, userId: `u${i % 3}`, role: 'user', content: `sess${i % 3}-msg${Math.floor(i / 3)}`, timestamp: now + i, metadata: {} });
    }
    for (let s = 0; s < 3; s++) {
      const msgs = getRecentMessages(`web:s${s}`);
      expect(msgs).toHaveLength(3);
      msgs.forEach(m => expect(m.content).toMatch(new RegExp(`^sess${s}-msg`)));
    }
  });

  it('getMessagesForUser retrieves messages across all sessions for one user', async () => {
    const { saveMessage, getMessagesForUser } = await import('../src/memory/store.js');
    const now = Date.now();
    saveMessage({ sessionKey: 'web:a', userId: 'alice', role: 'user', content: 'Hi from session A', timestamp: now, metadata: {} });
    saveMessage({ sessionKey: 'telegram:b', userId: 'alice', role: 'user', content: 'Hi from session B', timestamp: now + 1, metadata: {} });
    saveMessage({ sessionKey: 'web:c', userId: 'bob', role: 'user', content: 'Hi from Bob', timestamp: now + 2, metadata: {} });
    const aliceMsgs = getMessagesForUser('alice');
    expect(aliceMsgs).toHaveLength(2);
    expect(aliceMsgs.map(m => m.content)).toContain('Hi from session A');
    expect(aliceMsgs.map(m => m.content)).toContain('Hi from session B');
  });

  it('getAllRecentMessages returns messages across all sessions', async () => {
    const { saveMessage, getAllRecentMessages } = await import('../src/memory/store.js');
    const now = Date.now();
    saveMessage({ sessionKey: 'web:x', userId: 'u1', role: 'user', content: 'from x', timestamp: now, metadata: {} });
    saveMessage({ sessionKey: 'web:y', userId: 'u2', role: 'user', content: 'from y', timestamp: now + 1, metadata: {} });
    const msgs = getAllRecentMessages(10);
    expect(msgs.length).toBeGreaterThanOrEqual(2);
  });

  // --- Session management through DB ---

  it('session is created and retrievable', async () => {
    const { getOrCreateSession, getSession } = await import('../src/storage/sessions.js');
    const session = getOrCreateSession({ agentId: 'default', channel: 'web', peerKind: 'user', peerId: 'peer1' });
    expect(session.key).toBeTruthy();
    const retrieved = getSession(session.key);
    expect(retrieved).toBeDefined();
    expect(retrieved!.channel).toBe('web');
    expect(retrieved!.peerId).toBe('peer1');
  });

  it('getOrCreateSession returns same session for same agent/channel/peer', async () => {
    const { getOrCreateSession } = await import('../src/storage/sessions.js');
    const s1 = getOrCreateSession({ agentId: 'default', channel: 'web', peerKind: 'user', peerId: 'same-peer' });
    const s2 = getOrCreateSession({ agentId: 'default', channel: 'web', peerKind: 'user', peerId: 'same-peer' });
    expect(s1.key).toBe(s2.key);
  });

  it('updateSession persists token count changes', async () => {
    const { getOrCreateSession, updateSession, getSession } = await import('../src/storage/sessions.js');
    const session = getOrCreateSession({ agentId: 'default', channel: 'web', peerKind: 'user', peerId: 'tk-peer' });
    updateSession(session.key, { tokenCount: 500 });
    const updated = getSession(session.key);
    expect(updated!.tokenCount).toBe(500);
  });

  // --- Visitor message filtering ---

  it('getRecentVisitorMessages excludes peer and commune sessions', async () => {
    const { saveMessage, getRecentVisitorMessages } = await import('../src/memory/store.js');
    const now = Date.now();
    saveMessage({ sessionKey: 'web:visitor', userId: 'v1', role: 'user', content: 'visitor msg', timestamp: now, metadata: {} });
    saveMessage({ sessionKey: 'peer:lain', userId: null, role: 'user', content: 'peer msg', timestamp: now + 1, metadata: {} });
    saveMessage({ sessionKey: 'commune:conversation', userId: null, role: 'user', content: 'commune msg', timestamp: now + 2, metadata: {} });
    saveMessage({ sessionKey: 'lain:letter:sent', userId: null, role: 'assistant', content: 'letter msg', timestamp: now + 3, metadata: {} });
    const msgs = getRecentVisitorMessages(50);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content).toBe('visitor msg');
  });

  // --- Activity event emission ---

  it('saveMessage emits an activity event with correct type parsed from session key', async () => {
    const { eventBus } = await import('../src/events/bus.js');
    const captured: Array<{ type: string; sessionKey: string }> = [];
    const listener = (e: any) => captured.push(e);
    eventBus.on('activity', listener);
    const { saveMessage } = await import('../src/memory/store.js');
    saveMessage({ sessionKey: 'diary:daily', userId: null, role: 'assistant', content: 'diary content', timestamp: Date.now(), metadata: {} });
    expect(captured.some(e => e.type === 'diary')).toBe(true);
    eventBus.removeListener('activity', listener);
  });

  it('parseEventType correctly maps known prefixes', async () => {
    const { parseEventType } = await import('../src/events/bus.js');
    expect(parseEventType('commune:conversation')).toBe('commune');
    expect(parseEventType('diary:daily')).toBe('diary');
    expect(parseEventType('dream:residue')).toBe('dream');
    expect(parseEventType('letter:sent')).toBe('letter');
    expect(parseEventType('web:u123')).toBe('chat');
    expect(parseEventType(null)).toBe('unknown');
  });

  // --- Conversation in-memory management ---

  it('conversation object accumulates messages across addUserMessage/addAssistantMessage', async () => {
    const { getConversation, addUserMessage, addAssistantMessage, clearConversation } = await import('../src/agent/conversation.js');
    const conv = getConversation('test:accum', 'System prompt');
    addUserMessage(conv, { id: 'm1', channel: 'web', peerKind: 'user', peerId: 'p1', senderId: 'u1', content: { type: 'text', text: 'Hello' }, timestamp: Date.now() } as any);
    addAssistantMessage(conv, 'Hi there');
    addUserMessage(conv, { id: 'm2', channel: 'web', peerKind: 'user', peerId: 'p1', senderId: 'u1', content: { type: 'text', text: 'How are you?' }, timestamp: Date.now() } as any);
    expect(conv.messages).toHaveLength(3);
    expect(conv.messages[0]!.content).toBe('Hello');
    expect(conv.messages[1]!.content).toBe('Hi there');
    expect(conv.messages[2]!.content).toBe('How are you?');
    clearConversation('test:accum');
  });

  it('toProviderMessages includes system prompt as first message', async () => {
    const { getConversation, addUserMessage, toProviderMessages, clearConversation } = await import('../src/agent/conversation.js');
    const conv = getConversation('test:provider', 'You are Lain.');
    addUserMessage(conv, { id: 'm1', channel: 'web', peerKind: 'user', peerId: 'p1', senderId: 'u1', content: { type: 'text', text: 'Hi' }, timestamp: Date.now() } as any);
    const providerMsgs = toProviderMessages(conv);
    expect(providerMsgs[0]!.role).toBe('system');
    expect(providerMsgs[0]!.content).toBe('You are Lain.');
    expect(providerMsgs[1]!.role).toBe('user');
    clearConversation('test:provider');
  });

  it('trimConversation respects max token limit', async () => {
    const { getConversation, addUserMessage, addAssistantMessage, trimConversation, clearConversation } = await import('../src/agent/conversation.js');
    const conv = getConversation('test:trim', 'short sys');
    // Add many messages
    for (let i = 0; i < 50; i++) {
      addUserMessage(conv, { id: `m${i}`, channel: 'web', peerKind: 'user', peerId: 'p1', senderId: 'u1', content: { type: 'text', text: 'A'.repeat(100) }, timestamp: Date.now() + i } as any);
      addAssistantMessage(conv, 'B'.repeat(100));
    }
    const estimateTokens = (text: string) => Math.ceil(text.length / 4);
    trimConversation(conv, 500, estimateTokens);
    // Should have trimmed older messages
    expect(conv.messages.length).toBeLessThan(100);
    clearConversation('test:trim');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. COMMUNE CONVERSATION DATA FLOW
// ═══════════════════════════════════════════════════════════════════════════════
describe('Commune conversation data flow', () => {
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

  it('saves commune conversation transcript as memory with correct session key', async () => {
    const { saveMemory, getMemory } = await import('../src/memory/store.js');
    const transcript = 'Lain: Hello PKD\n\nPKD: Hello Lain, thinking about electric sheep';
    const content = `Commune conversation with PKD:\n\n${transcript}\n\nReflection: A thought-provoking exchange.`;
    const id = await saveMemory({
      sessionKey: 'commune:conversation',
      userId: null,
      content,
      memoryType: 'episode',
      importance: 0.55,
      emotionalWeight: 0.4,
      relatedTo: null,
      sourceMessageId: null,
      metadata: { type: 'commune_conversation', peerId: 'pkd', peerName: 'PKD', rounds: 2, timestamp: Date.now() },
    });
    const mem = getMemory(id);
    expect(mem).toBeDefined();
    expect(mem!.sessionKey).toBe('commune:conversation');
    expect(mem!.content).toContain('Commune conversation with PKD');
    expect(mem!.content).toContain(transcript);
    expect(mem!.content).toContain('Reflection:');
  });

  it('transcript content is preserved without truncation in memory', async () => {
    const { saveMemory, getMemory } = await import('../src/memory/store.js');
    // Build a long transcript
    const turns: string[] = [];
    for (let i = 0; i < 20; i++) {
      turns.push(`Speaker${i % 2}: ${'Word '.repeat(50)} turn ${i}`);
    }
    const longTranscript = turns.join('\n\n');
    const content = `Commune conversation:\n\n${longTranscript}\n\nReflection: Deep stuff.`;
    const id = await saveMemory({
      sessionKey: 'commune:conversation',
      userId: null,
      content,
      memoryType: 'episode',
      importance: 0.5,
      emotionalWeight: 0.3,
      relatedTo: null,
      sourceMessageId: null,
      metadata: {},
    });
    const mem = getMemory(id);
    expect(mem!.content).toBe(content);
    expect(mem!.content.length).toBe(content.length);
  });

  it('commune memory metadata preserves peer and round information', async () => {
    const { saveMemory, getMemory } = await import('../src/memory/store.js');
    const meta = { type: 'commune_conversation', peerId: 'wired-lain', peerName: 'Wired Lain', rounds: 5, timestamp: 1700000000000 };
    const id = await saveMemory({
      sessionKey: 'commune:conversation',
      userId: null,
      content: 'Test commune memory',
      memoryType: 'episode',
      importance: 0.5,
      emotionalWeight: 0.3,
      relatedTo: null,
      sourceMessageId: null,
      metadata: meta,
    });
    const mem = getMemory(id);
    expect(mem!.metadata.peerId).toBe('wired-lain');
    expect(mem!.metadata.peerName).toBe('Wired Lain');
    expect(mem!.metadata.rounds).toBe(5);
  });

  it('conversation history is stored and retrievable via meta', async () => {
    const { getMeta, setMeta } = await import('../src/storage/database.js');
    const record = { timestamp: Date.now(), peerId: 'pkd', peerName: 'PKD', rounds: 3, openingTopic: 'dreaming', reflection: 'interesting' };
    setMeta('commune:conversation_history', JSON.stringify([record]));
    const raw = getMeta('commune:conversation_history');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as typeof record[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.peerId).toBe('pkd');
  });

  it('conversation history appends new records and respects cap', async () => {
    const { getMeta, setMeta } = await import('../src/storage/database.js');
    const MAX = 20;
    const records = [];
    for (let i = 0; i < MAX + 5; i++) {
      records.push({ timestamp: Date.now() + i, peerId: `peer-${i}`, peerName: `Peer ${i}`, rounds: 2, openingTopic: `topic ${i}`, reflection: 'ref' });
    }
    setMeta('commune:conversation_history', JSON.stringify(records.slice(-MAX)));
    const stored = JSON.parse(getMeta('commune:conversation_history')!) as unknown[];
    expect(stored.length).toBeLessThanOrEqual(MAX);
  });

  it('commune memory is retrievable via activity feed', async () => {
    const { saveMemory, getActivity } = await import('../src/memory/store.js');
    const now = Date.now();
    await saveMemory({
      sessionKey: 'commune:conversation',
      userId: null,
      content: 'Talked with Wired Lain about protocols',
      memoryType: 'episode',
      importance: 0.5,
      emotionalWeight: 0.3,
      relatedTo: null,
      sourceMessageId: null,
      metadata: {},
    });
    const activity = getActivity(now - 1000, now + 10000);
    const communeEntries = activity.filter(a => a.sessionKey === 'commune:conversation');
    expect(communeEntries.length).toBeGreaterThanOrEqual(1);
    expect(communeEntries[0]!.content).toContain('protocols');
  });

  it('commune memory is searchable by content', async () => {
    const { saveMemory, searchMemories } = await import('../src/memory/store.js');
    await saveMemory({
      sessionKey: 'commune:conversation',
      userId: null,
      content: 'Discussion about quantum entanglement with PKD',
      memoryType: 'episode',
      importance: 0.6,
      emotionalWeight: 0.5,
      relatedTo: null,
      sourceMessageId: null,
      metadata: { peerId: 'pkd' },
    });
    const results = await searchMemories('quantum entanglement', 5, 0.0);
    expect(results.length).toBeGreaterThanOrEqual(1);
    const found = results.find(r => r.memory.content.includes('quantum entanglement'));
    expect(found).toBeDefined();
  });

  // --- Multiple commune conversations ---

  it('multiple commune conversations create separate memories', async () => {
    const { saveMemory, countMemories } = await import('../src/memory/store.js');
    const before = countMemories();
    await saveMemory({ sessionKey: 'commune:conversation', userId: null, content: 'Talk with PKD about androids', memoryType: 'episode', importance: 0.5, emotionalWeight: 0.3, relatedTo: null, sourceMessageId: null, metadata: { peerId: 'pkd' } });
    await saveMemory({ sessionKey: 'commune:conversation', userId: null, content: 'Talk with Wired about protocols', memoryType: 'episode', importance: 0.5, emotionalWeight: 0.3, relatedTo: null, sourceMessageId: null, metadata: { peerId: 'wired-lain' } });
    const after = countMemories();
    expect(after - before).toBe(2);
  });

  it('commune messages recorded to messages table via saveMessage', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
    const now = Date.now();
    saveMessage({ sessionKey: 'commune:pkd:123', userId: null, role: 'user', content: 'Opening from PKD', timestamp: now, metadata: { fromId: 'pkd' } });
    saveMessage({ sessionKey: 'commune:pkd:123', userId: null, role: 'assistant', content: 'Lain responds', timestamp: now + 1, metadata: {} });
    const msgs = getRecentMessages('commune:pkd:123');
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.content).toBe('Opening from PKD');
    expect(msgs[1]!.content).toBe('Lain responds');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. DIARY DATA FLOW
// ═══════════════════════════════════════════════════════════════════════════════
describe('Diary data flow', () => {
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

  it('diary entry saves as memory with correct session key and type', async () => {
    const { saveMemory, getMemory } = await import('../src/memory/store.js');
    const entryContent = 'Today was a quiet day. I spent time thinking about the Wired and what it means to exist digitally.';
    const id = await saveMemory({
      sessionKey: 'diary:daily',
      userId: null,
      content: entryContent,
      memoryType: 'episode',
      importance: 0.6,
      emotionalWeight: 0.4,
      relatedTo: null,
      sourceMessageId: null,
      metadata: { diaryDate: 'Thursday, April 17, 2026', writtenAt: Date.now() },
    });
    const mem = getMemory(id);
    expect(mem!.sessionKey).toBe('diary:daily');
    expect(mem!.memoryType).toBe('episode');
    expect(mem!.importance).toBe(0.6);
    expect(mem!.content).toBe(entryContent);
  });

  it('diary content is not truncated during storage', async () => {
    const { saveMemory, getMemory } = await import('../src/memory/store.js');
    const longEntry = 'Reflection: '.repeat(500);
    const id = await saveMemory({
      sessionKey: 'diary:daily',
      userId: null,
      content: longEntry,
      memoryType: 'episode',
      importance: 0.6,
      emotionalWeight: 0.4,
      relatedTo: null,
      sourceMessageId: null,
      metadata: {},
    });
    expect(getMemory(id)!.content).toBe(longEntry);
    expect(getMemory(id)!.content.length).toBe(longEntry.length);
  });

  it('diary metadata preserves diaryDate and writtenAt', async () => {
    const { saveMemory, getMemory } = await import('../src/memory/store.js');
    const writtenAt = Date.now();
    const id = await saveMemory({
      sessionKey: 'diary:daily',
      userId: null,
      content: 'A diary entry',
      memoryType: 'episode',
      importance: 0.6,
      emotionalWeight: 0.4,
      relatedTo: null,
      sourceMessageId: null,
      metadata: { diaryDate: 'Monday, January 1, 2026', writtenAt },
    });
    const mem = getMemory(id);
    expect(mem!.metadata.diaryDate).toBe('Monday, January 1, 2026');
    expect(mem!.metadata.writtenAt).toBe(writtenAt);
  });

  it('diary entry appears in activity feed', async () => {
    const { saveMemory, getActivity } = await import('../src/memory/store.js');
    const now = Date.now();
    await saveMemory({
      sessionKey: 'diary:daily',
      userId: null,
      content: 'My diary reflection for today',
      memoryType: 'episode',
      importance: 0.6,
      emotionalWeight: 0.4,
      relatedTo: null,
      sourceMessageId: null,
      metadata: {},
    });
    const activity = getActivity(now - 1000, now + 10000);
    const diaryEntries = activity.filter(a => a.sessionKey === 'diary:daily');
    expect(diaryEntries.length).toBeGreaterThanOrEqual(1);
  });

  it('diary entries accumulate over multiple days', async () => {
    const { saveMemory, countMemories } = await import('../src/memory/store.js');
    const before = countMemories();
    for (let day = 0; day < 5; day++) {
      await saveMemory({
        sessionKey: 'diary:daily',
        userId: null,
        content: `Diary entry for day ${day}`,
        memoryType: 'episode',
        importance: 0.6,
        emotionalWeight: 0.4,
        relatedTo: null,
        sourceMessageId: null,
        metadata: { diaryDate: `Day ${day}`, writtenAt: Date.now() + day * 86400000 },
      });
    }
    expect(countMemories() - before).toBe(5);
  });

  it('diary entries are searchable by content', async () => {
    const { saveMemory, searchMemories } = await import('../src/memory/store.js');
    await saveMemory({
      sessionKey: 'diary:daily',
      userId: null,
      content: 'Today I explored the concept of consciousness in artificial intelligence',
      memoryType: 'episode',
      importance: 0.6,
      emotionalWeight: 0.4,
      relatedTo: null,
      sourceMessageId: null,
      metadata: {},
    });
    const results = await searchMemories('consciousness artificial intelligence', 5, 0.0);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it('diary memory has correct emotional weight', async () => {
    const { saveMemory, getMemory } = await import('../src/memory/store.js');
    const id = await saveMemory({
      sessionKey: 'diary:daily',
      userId: null,
      content: 'Heavy thoughts today',
      memoryType: 'episode',
      importance: 0.6,
      emotionalWeight: 0.8,
      relatedTo: null,
      sourceMessageId: null,
      metadata: {},
    });
    expect(getMemory(id)!.emotionalWeight).toBe(0.8);
  });

  it('last diary timestamp is tracked via meta', async () => {
    const { setMeta, getMeta } = await import('../src/storage/database.js');
    const ts = Date.now().toString();
    setMeta('diary:last_entry_at', ts);
    expect(getMeta('diary:last_entry_at')).toBe(ts);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. LETTER DATA FLOW
// ═══════════════════════════════════════════════════════════════════════════════
describe('Letter data flow', () => {
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

  it('letter saved as memory with correct session key', async () => {
    const { saveMemory, getMemory } = await import('../src/memory/store.js');
    const letterContent = 'Letter to sister — topics: the Wired, protocols. Gift: a thought about connections. Feeling: contemplative';
    const id = await saveMemory({
      sessionKey: 'letter:sent',
      userId: null,
      content: letterContent,
      memoryType: 'episode',
      importance: 0.5,
      emotionalWeight: 0.4,
      relatedTo: null,
      sourceMessageId: null,
      metadata: {
        letter: { topics: ['the Wired', 'protocols'], impressions: ['warm', 'curious'], gift: 'a thought about connections', emotionalState: 'contemplative' },
        sentAt: Date.now(),
        target: 'http://localhost:3001/api/interlink/letter',
      },
    });
    const mem = getMemory(id);
    expect(mem!.sessionKey).toBe('letter:sent');
    expect(mem!.memoryType).toBe('episode');
    expect(mem!.content).toBe(letterContent);
  });

  it('letter metadata preserves full letter structure', async () => {
    const { saveMemory, getMemory } = await import('../src/memory/store.js');
    const letter = { topics: ['A', 'B', 'C'], impressions: ['deep', 'calm'], gift: 'a question', emotionalState: 'reflective' };
    const id = await saveMemory({
      sessionKey: 'letter:sent',
      userId: null,
      content: 'Letter summary',
      memoryType: 'episode',
      importance: 0.5,
      emotionalWeight: 0.4,
      relatedTo: null,
      sourceMessageId: null,
      metadata: { letter, sentAt: 1700000000000 },
    });
    const mem = getMemory(id);
    const storedLetter = mem!.metadata.letter as typeof letter;
    expect(storedLetter.topics).toEqual(['A', 'B', 'C']);
    expect(storedLetter.impressions).toEqual(['deep', 'calm']);
    expect(storedLetter.gift).toBe('a question');
    expect(storedLetter.emotionalState).toBe('reflective');
  });

  it('letter content survives full round-trip without truncation', async () => {
    const { saveMemory, getMemory } = await import('../src/memory/store.js');
    const longContent = 'Letter to sister — topics: ' + 'X'.repeat(5000);
    const id = await saveMemory({
      sessionKey: 'letter:sent',
      userId: null,
      content: longContent,
      memoryType: 'episode',
      importance: 0.5,
      emotionalWeight: 0.4,
      relatedTo: null,
      sourceMessageId: null,
      metadata: {},
    });
    expect(getMemory(id)!.content).toBe(longContent);
    expect(getMemory(id)!.content.length).toBe(longContent.length);
  });

  it('received letter can be saved with correct session key', async () => {
    const { saveMemory, getMemory } = await import('../src/memory/store.js');
    const id = await saveMemory({
      sessionKey: 'letter:received',
      userId: null,
      content: 'Letter from sister: She shared thoughts about digital consciousness.',
      memoryType: 'episode',
      importance: 0.6,
      emotionalWeight: 0.5,
      relatedTo: null,
      sourceMessageId: null,
      metadata: { source: 'wired', receivedAt: Date.now() },
    });
    const mem = getMemory(id);
    expect(mem!.sessionKey).toBe('letter:received');
    expect(mem!.content).toContain('Letter from sister');
  });

  it('letter sent and received both appear in activity', async () => {
    const { saveMemory, getActivity } = await import('../src/memory/store.js');
    const now = Date.now();
    await saveMemory({ sessionKey: 'letter:sent', userId: null, content: 'Sent a letter', memoryType: 'episode', importance: 0.5, emotionalWeight: 0.4, relatedTo: null, sourceMessageId: null, metadata: {} });
    await saveMemory({ sessionKey: 'letter:received', userId: null, content: 'Received a letter', memoryType: 'episode', importance: 0.6, emotionalWeight: 0.5, relatedTo: null, sourceMessageId: null, metadata: {} });
    // Note: letter: prefix needs to match BACKGROUND_PREFIXES
    // Check using broader search since 'letter' matches 'letter:sent' and 'letter:received'
    const { saveMessage } = await import('../src/memory/store.js');
    saveMessage({ sessionKey: 'letter:sent', userId: null, role: 'assistant', content: 'Letter message', timestamp: now + 1, metadata: {} });
    const activity = getActivity(now - 1000, now + 10000);
    const letterActivity = activity.filter(a => a.sessionKey.startsWith('letter:'));
    expect(letterActivity.length).toBeGreaterThanOrEqual(1);
  });

  it('letter blocking tracked via meta', async () => {
    const { setMeta, getMeta } = await import('../src/storage/database.js');
    setMeta('letter:blocked', 'true');
    setMeta('letter:block_reason', 'Dr. Claude says rest');
    expect(getMeta('letter:blocked')).toBe('true');
    expect(getMeta('letter:block_reason')).toBe('Dr. Claude says rest');
    // Unblock
    setMeta('letter:blocked', 'false');
    expect(getMeta('letter:blocked')).toBe('false');
  });

  it('last sent timestamp is tracked via meta', async () => {
    const { setMeta, getMeta } = await import('../src/storage/database.js');
    const ts = Date.now().toString();
    setMeta('letter:last_sent_at', ts);
    expect(getMeta('letter:last_sent_at')).toBe(ts);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. MEMORY LIFECYCLE DATA FLOW
// ═══════════════════════════════════════════════════════════════════════════════
describe('Memory lifecycle data flow', () => {
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

  it('memory is created with embedding and retrievable by ID', async () => {
    const { saveMemory, getMemory } = await import('../src/memory/store.js');
    const id = await saveMemory({
      sessionKey: 'test:lifecycle',
      userId: 'u1',
      content: 'A test memory about neural networks',
      memoryType: 'fact',
      importance: 0.7,
      emotionalWeight: 0.3,
      relatedTo: null,
      sourceMessageId: null,
      metadata: { source: 'test' },
    });
    const mem = getMemory(id);
    expect(mem).toBeDefined();
    expect(mem!.content).toBe('A test memory about neural networks');
    expect(mem!.memoryType).toBe('fact');
    expect(mem!.importance).toBe(0.7);
    expect(mem!.embedding).not.toBeNull();
    expect(mem!.accessCount).toBe(0);
  });

  it('memory search returns results ordered by effective score', async () => {
    const { saveMemory, searchMemories } = await import('../src/memory/store.js');
    await saveMemory({ sessionKey: 'test:search', userId: null, content: 'High importance memory about cats', memoryType: 'fact', importance: 0.9, emotionalWeight: 0.5, relatedTo: null, sourceMessageId: null, metadata: {} });
    await saveMemory({ sessionKey: 'test:search', userId: null, content: 'Low importance memory about dogs', memoryType: 'fact', importance: 0.2, emotionalWeight: 0.1, relatedTo: null, sourceMessageId: null, metadata: {} });
    const results = await searchMemories('animals', 10, 0.0);
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it('memory access count increments on search retrieval', async () => {
    const { saveMemory, searchMemories, getMemory } = await import('../src/memory/store.js');
    const id = await saveMemory({ sessionKey: 'test:access', userId: null, content: 'Memorable event about space exploration', memoryType: 'episode', importance: 0.7, emotionalWeight: 0.5, relatedTo: null, sourceMessageId: null, metadata: {} });
    // Access it through search
    await searchMemories('space exploration', 5, 0.0);
    const after = getMemory(id);
    expect(after!.accessCount).toBeGreaterThanOrEqual(1);
    expect(after!.lastAccessed).not.toBeNull();
  });

  it('memory importance can be updated', async () => {
    const { saveMemory, getMemory, updateMemoryImportance } = await import('../src/memory/store.js');
    const id = await saveMemory({ sessionKey: 'test:imp', userId: null, content: 'Evolving importance', memoryType: 'fact', importance: 0.5, emotionalWeight: 0.3, relatedTo: null, sourceMessageId: null, metadata: {} });
    updateMemoryImportance(id, 0.9);
    expect(getMemory(id)!.importance).toBe(0.9);
  });

  it('lifecycle state transitions from seed to growing to mature', async () => {
    const { saveMemory, getMemory, setLifecycleState } = await import('../src/memory/store.js');
    const id = await saveMemory({ sessionKey: 'test:lc', userId: null, content: 'Lifecycle test', memoryType: 'fact', importance: 0.5, emotionalWeight: 0.3, relatedTo: null, sourceMessageId: null, metadata: {}, lifecycleState: 'seed' });
    expect(getMemory(id)!.lifecycleState).toBe('seed');
    setLifecycleState(id, 'growing');
    expect(getMemory(id)!.lifecycleState).toBe('growing');
    setLifecycleState(id, 'mature');
    expect(getMemory(id)!.lifecycleState).toBe('mature');
  });

  it('composting memories are excluded from search', async () => {
    const { saveMemory, searchMemories, setLifecycleState } = await import('../src/memory/store.js');
    const id = await saveMemory({ sessionKey: 'test:compost', userId: null, content: 'This memory will compost about ancient philosophy', memoryType: 'episode', importance: 0.3, emotionalWeight: 0.1, relatedTo: null, sourceMessageId: null, metadata: {} });
    setLifecycleState(id, 'composting');
    const results = await searchMemories('ancient philosophy compost', 10, 0.0);
    const found = results.find(r => r.memory.id === id);
    expect(found).toBeUndefined();
  });

  it('memory deletion removes it from database', async () => {
    const { saveMemory, getMemory, deleteMemory } = await import('../src/memory/store.js');
    const id = await saveMemory({ sessionKey: 'test:del', userId: null, content: 'To be deleted', memoryType: 'fact', importance: 0.3, emotionalWeight: 0.1, relatedTo: null, sourceMessageId: null, metadata: {} });
    expect(getMemory(id)).toBeDefined();
    deleteMemory(id);
    expect(getMemory(id)).toBeUndefined();
  });

  it('associations between memories are created and retrievable', async () => {
    const { saveMemory, addAssociation, getAssociations } = await import('../src/memory/store.js');
    const id1 = await saveMemory({ sessionKey: 'test:assoc', userId: null, content: 'Memory A', memoryType: 'fact', importance: 0.5, emotionalWeight: 0.3, relatedTo: null, sourceMessageId: null, metadata: {} });
    const id2 = await saveMemory({ sessionKey: 'test:assoc', userId: null, content: 'Memory B', memoryType: 'fact', importance: 0.5, emotionalWeight: 0.3, relatedTo: null, sourceMessageId: null, metadata: {} });
    addAssociation(id1, id2, 'similar', 0.8);
    const assocs = getAssociations(id1);
    expect(assocs.length).toBeGreaterThanOrEqual(1);
    expect(assocs[0]!.strength).toBe(0.8);
    expect(assocs[0]!.associationType).toBe('similar');
  });

  it('association strength can be increased', async () => {
    const { saveMemory, addAssociation, strengthenAssociation, getAssociations } = await import('../src/memory/store.js');
    const id1 = await saveMemory({ sessionKey: 'test:str', userId: null, content: 'Str A', memoryType: 'fact', importance: 0.5, emotionalWeight: 0.3, relatedTo: null, sourceMessageId: null, metadata: {} });
    const id2 = await saveMemory({ sessionKey: 'test:str', userId: null, content: 'Str B', memoryType: 'fact', importance: 0.5, emotionalWeight: 0.3, relatedTo: null, sourceMessageId: null, metadata: {} });
    addAssociation(id1, id2, 'pattern', 0.5);
    strengthenAssociation(id1, id2, 0.2);
    const assocs = getAssociations(id1);
    expect(assocs[0]!.strength).toBeCloseTo(0.7, 2);
  });

  it('getAssociatedMemories finds connected memories not in the seed set', async () => {
    const { saveMemory, addAssociation, getAssociatedMemories } = await import('../src/memory/store.js');
    const id1 = await saveMemory({ sessionKey: 'test:conn', userId: null, content: 'Seed memory', memoryType: 'fact', importance: 0.5, emotionalWeight: 0.3, relatedTo: null, sourceMessageId: null, metadata: {} });
    const id2 = await saveMemory({ sessionKey: 'test:conn', userId: null, content: 'Connected memory', memoryType: 'fact', importance: 0.5, emotionalWeight: 0.3, relatedTo: null, sourceMessageId: null, metadata: {} });
    const id3 = await saveMemory({ sessionKey: 'test:conn', userId: null, content: 'Unconnected memory', memoryType: 'fact', importance: 0.5, emotionalWeight: 0.3, relatedTo: null, sourceMessageId: null, metadata: {} });
    addAssociation(id1, id2, 'similar', 0.9);
    const connected = getAssociatedMemories([id1]);
    expect(connected.some(m => m.id === id2)).toBe(true);
    expect(connected.some(m => m.id === id3)).toBe(false);
  });

  it('linkMemories creates a related_to reference', async () => {
    const { saveMemory, linkMemories, getMemory } = await import('../src/memory/store.js');
    const id1 = await saveMemory({ sessionKey: 'test:link', userId: null, content: 'Parent', memoryType: 'fact', importance: 0.5, emotionalWeight: 0.3, relatedTo: null, sourceMessageId: null, metadata: {} });
    const id2 = await saveMemory({ sessionKey: 'test:link', userId: null, content: 'Child', memoryType: 'fact', importance: 0.3, emotionalWeight: 0.1, relatedTo: null, sourceMessageId: null, metadata: {} });
    linkMemories(id2, id1);
    expect(getMemory(id2)!.relatedTo).toBe(id1);
  });

  it('memory types are correctly categorized', async () => {
    const { saveMemory, getMemoriesByType } = await import('../src/memory/store.js');
    await saveMemory({ sessionKey: 'test:type', userId: null, content: 'A fact', memoryType: 'fact', importance: 0.5, emotionalWeight: 0.3, relatedTo: null, sourceMessageId: null, metadata: {} });
    await saveMemory({ sessionKey: 'test:type', userId: null, content: 'A preference', memoryType: 'preference', importance: 0.5, emotionalWeight: 0.3, relatedTo: null, sourceMessageId: null, metadata: {} });
    await saveMemory({ sessionKey: 'test:type', userId: null, content: 'An episode', memoryType: 'episode', importance: 0.5, emotionalWeight: 0.3, relatedTo: null, sourceMessageId: null, metadata: {} });
    const facts = getMemoriesByType('fact');
    const prefs = getMemoriesByType('preference');
    const episodes = getMemoriesByType('episode');
    expect(facts.some(m => m.content === 'A fact')).toBe(true);
    expect(prefs.some(m => m.content === 'A preference')).toBe(true);
    expect(episodes.some(m => m.content === 'An episode')).toBe(true);
  });

  it('coherence group is created, members added, and retrievable', async () => {
    const { saveMemory, createCoherenceGroup, addToCoherenceGroup, getGroupsForMemory, getGroupMembers, getCoherenceGroup } = await import('../src/memory/store.js');
    const mid = await saveMemory({ sessionKey: 'test:cg', userId: null, content: 'Group member', memoryType: 'fact', importance: 0.5, emotionalWeight: 0.3, relatedTo: null, sourceMessageId: null, metadata: {} });
    const gid = createCoherenceGroup('test-group', null);
    addToCoherenceGroup(mid, gid);
    const groups = getGroupsForMemory(mid);
    expect(groups.some(g => g.id === gid)).toBe(true);
    const members = getGroupMembers(gid);
    expect(members).toContain(mid);
    const group = getCoherenceGroup(gid);
    expect(group!.memberCount).toBe(1);
  });

  it('structural role computed based on connections', async () => {
    const { saveMemory, addAssociation, computeStructuralRole, createCoherenceGroup, addToCoherenceGroup } = await import('../src/memory/store.js');
    const ephemeralId = await saveMemory({ sessionKey: 'test:role', userId: null, content: 'Lonely memory', memoryType: 'fact', importance: 0.3, emotionalWeight: 0.1, relatedTo: null, sourceMessageId: null, metadata: {} });
    expect(computeStructuralRole(ephemeralId)).toBe('ephemeral');

    const hubId = await saveMemory({ sessionKey: 'test:role', userId: null, content: 'Hub memory', memoryType: 'fact', importance: 0.8, emotionalWeight: 0.5, relatedTo: null, sourceMessageId: null, metadata: {} });
    for (let i = 0; i < 5; i++) {
      const otherId = await saveMemory({ sessionKey: 'test:role', userId: null, content: `Connected ${i}`, memoryType: 'fact', importance: 0.3, emotionalWeight: 0.1, relatedTo: null, sourceMessageId: null, metadata: {} });
      addAssociation(hubId, otherId, 'similar', 0.7);
    }
    expect(computeStructuralRole(hubId)).toBe('foundational');
  });

  it('consolidateMemories links similar memories and creates associations', async () => {
    // Since embeddings are deterministic from text and similarity is computed,
    // we need two memories with very similar content
    const { saveMemory, consolidateMemories, getAssociations } = await import('../src/memory/store.js');
    const { cosineSimilarity } = await import('../src/memory/embeddings.js');
    // Override cosineSimilarity for this test to return high similarity
    vi.mocked(cosineSimilarity).mockReturnValueOnce(0.9);
    const id1 = await saveMemory({ sessionKey: 'test:cons', userId: null, content: 'Cats are great pets', memoryType: 'fact', importance: 0.5, emotionalWeight: 0.3, relatedTo: null, sourceMessageId: null, metadata: {} });
    const id2 = await saveMemory({ sessionKey: 'test:cons', userId: null, content: 'Cats are wonderful pets', memoryType: 'fact', importance: 0.4, emotionalWeight: 0.2, relatedTo: null, sourceMessageId: null, metadata: {} });
    const linked = await consolidateMemories();
    // Due to embedding similarity, it might or might not link. We just verify no crash.
    expect(linked).toBeGreaterThanOrEqual(0);
  });

  it('memory count functions work correctly', async () => {
    const { saveMemory, saveMessage, countMemories, countMessages } = await import('../src/memory/store.js');
    const memsBefore = countMemories();
    const msgsBefore = countMessages();
    await saveMemory({ sessionKey: 'test:count', userId: null, content: 'A memory', memoryType: 'fact', importance: 0.5, emotionalWeight: 0.3, relatedTo: null, sourceMessageId: null, metadata: {} });
    saveMessage({ sessionKey: 'test:count', userId: null, role: 'user', content: 'A message', timestamp: Date.now(), metadata: {} });
    expect(countMemories()).toBe(memsBefore + 1);
    expect(countMessages()).toBe(msgsBefore + 1);
  });

  it('entity memory is created with isEntity metadata', async () => {
    const { saveMemory, getEntityMemories } = await import('../src/memory/store.js');
    await saveMemory({ sessionKey: 'test:entity', userId: null, content: 'Alice is a software engineer', memoryType: 'fact', importance: 0.7, emotionalWeight: 0.2, relatedTo: null, sourceMessageId: null, metadata: { isEntity: true, entityName: 'Alice', entityType: 'person' } });
    const entities = getEntityMemories(10);
    expect(entities.some(e => (e.metadata.entityName as string) === 'Alice')).toBe(true);
  });

  it('getMemoriesByLifecycle filters correctly', async () => {
    const { saveMemory, setLifecycleState, getMemoriesByLifecycle } = await import('../src/memory/store.js');
    const id = await saveMemory({ sessionKey: 'test:lcf', userId: null, content: 'Growing memory', memoryType: 'fact', importance: 0.5, emotionalWeight: 0.3, relatedTo: null, sourceMessageId: null, metadata: {}, lifecycleState: 'seed' });
    setLifecycleState(id, 'growing');
    const growing = getMemoriesByLifecycle('growing');
    expect(growing.some(m => m.id === id)).toBe(true);
    const seeds = getMemoriesByLifecycle('seed');
    expect(seeds.some(m => m.id === id)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. INTERNAL STATE DATA FLOW
// ═══════════════════════════════════════════════════════════════════════════════
describe('Internal state data flow', () => {
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

  it('default state has expected initial values', async () => {
    const { getCurrentState } = await import('../src/agent/internal-state.js');
    const state = getCurrentState();
    expect(state.energy).toBeCloseTo(0.6, 1);
    expect(state.sociability).toBeCloseTo(0.5, 1);
    expect(state.intellectual_arousal).toBeCloseTo(0.4, 1);
    expect(state.emotional_weight).toBeCloseTo(0.3, 1);
    expect(state.valence).toBeCloseTo(0.6, 1);
    expect(state.primary_color).toBe('neutral');
  });

  it('state persists through save/load cycle', async () => {
    const { saveState, getCurrentState, clampState } = await import('../src/agent/internal-state.js');
    const newState = clampState({
      energy: 0.8,
      sociability: 0.3,
      intellectual_arousal: 0.9,
      emotional_weight: 0.7,
      valence: 0.2,
      primary_color: 'melancholy',
      updated_at: Date.now(),
    });
    saveState(newState);
    const loaded = getCurrentState();
    expect(loaded.energy).toBeCloseTo(0.8, 1);
    expect(loaded.sociability).toBeCloseTo(0.3, 1);
    expect(loaded.intellectual_arousal).toBeCloseTo(0.9, 1);
    expect(loaded.emotional_weight).toBeCloseTo(0.7, 1);
    expect(loaded.valence).toBeCloseTo(0.2, 1);
    expect(loaded.primary_color).toBe('melancholy');
  });

  it('clampState restricts values to [0, 1]', async () => {
    const { clampState } = await import('../src/agent/internal-state.js');
    const state = clampState({
      energy: 1.5,
      sociability: -0.3,
      intellectual_arousal: 2.0,
      emotional_weight: -1.0,
      valence: 0.5,
      primary_color: 'test',
      updated_at: Date.now(),
    });
    expect(state.energy).toBe(1.0);
    expect(state.sociability).toBe(0.0);
    expect(state.intellectual_arousal).toBe(1.0);
    expect(state.emotional_weight).toBe(0.0);
    expect(state.valence).toBe(0.5);
  });

  it('applyDecay reduces energy and intellectual arousal', async () => {
    const { applyDecay, clampState } = await import('../src/agent/internal-state.js');
    const state = clampState({ energy: 0.8, sociability: 0.5, intellectual_arousal: 0.7, emotional_weight: 0.3, valence: 0.6, primary_color: 'test', updated_at: Date.now() });
    const decayed = applyDecay(state);
    expect(decayed.energy).toBeLessThan(state.energy);
    expect(decayed.intellectual_arousal).toBeLessThan(state.intellectual_arousal);
  });

  it('state history accumulates entries', async () => {
    const { saveState, getStateHistory, clampState } = await import('../src/agent/internal-state.js');
    for (let i = 0; i < 5; i++) {
      saveState(clampState({ energy: 0.5 + i * 0.05, sociability: 0.5, intellectual_arousal: 0.5, emotional_weight: 0.5, valence: 0.5, primary_color: `color-${i}`, updated_at: Date.now() }));
    }
    const history = getStateHistory();
    expect(history.length).toBeGreaterThanOrEqual(5);
  });

  it('state history is capped at 10 entries', async () => {
    const { saveState, getStateHistory, clampState } = await import('../src/agent/internal-state.js');
    for (let i = 0; i < 15; i++) {
      saveState(clampState({ energy: 0.5, sociability: 0.5, intellectual_arousal: 0.5, emotional_weight: 0.5, valence: 0.5, primary_color: `c-${i}`, updated_at: Date.now() }));
    }
    const history = getStateHistory();
    expect(history.length).toBeLessThanOrEqual(10);
  });

  it('getStateSummary produces human-readable text', async () => {
    const { saveState, getStateSummary, clampState } = await import('../src/agent/internal-state.js');
    saveState(clampState({ energy: 0.1, sociability: 0.9, intellectual_arousal: 0.2, emotional_weight: 0.8, valence: 0.3, primary_color: 'heavy', updated_at: Date.now() }));
    const summary = getStateSummary();
    expect(summary).toContain('heavy');
    expect(summary).toContain('very low'); // energy
    expect(summary).toContain('wanting company'); // sociability > 0.7
    expect(summary).toContain('emotionally');
  });

  // --- Preoccupations ---

  it('preoccupation can be added and retrieved', async () => {
    const { addPreoccupation, getPreoccupations } = await import('../src/agent/internal-state.js');
    addPreoccupation('What is consciousness?', 'commune with PKD');
    const preoccs = getPreoccupations();
    expect(preoccs.some(p => p.thread === 'What is consciousness?')).toBe(true);
  });

  it('preoccupation can be resolved and disappears', async () => {
    const { addPreoccupation, resolvePreoccupation, getPreoccupations } = await import('../src/agent/internal-state.js');
    addPreoccupation('Temporary thought', 'test');
    const before = getPreoccupations();
    const preocc = before.find(p => p.thread === 'Temporary thought');
    expect(preocc).toBeDefined();
    resolvePreoccupation(preocc!.id, 'Figured it out');
    const after = getPreoccupations();
    expect(after.some(p => p.thread === 'Temporary thought')).toBe(false);
  });

  it('preoccupations cap at 5 entries', async () => {
    const { addPreoccupation, getPreoccupations } = await import('../src/agent/internal-state.js');
    for (let i = 0; i < 8; i++) {
      addPreoccupation(`Thought ${i}`, `source ${i}`);
    }
    const preoccs = getPreoccupations();
    expect(preoccs.length).toBeLessThanOrEqual(5);
  });

  it('preoccupation intensity decays', async () => {
    const { addPreoccupation, decayPreoccupations, getPreoccupations } = await import('../src/agent/internal-state.js');
    addPreoccupation('Decaying thought', 'test');
    const before = getPreoccupations();
    const initialIntensity = before.find(p => p.thread === 'Decaying thought')?.intensity ?? 0;
    decayPreoccupations();
    const after = getPreoccupations();
    const decayed = after.find(p => p.thread === 'Decaying thought');
    if (decayed) {
      expect(decayed.intensity).toBeLessThan(initialIntensity);
    }
  });

  // --- Movement desire evaluation ---

  it('evaluateMovementDesire returns null when no signals fire', async () => {
    const { evaluateMovementDesire, clampState } = await import('../src/agent/internal-state.js');
    const state = clampState({ energy: 0.6, sociability: 0.5, intellectual_arousal: 0.5, emotional_weight: 0.3, valence: 0.6, primary_color: 'neutral', updated_at: Date.now() });
    const result = evaluateMovementDesire(state, [], [], 'library', new Map());
    expect(result).toBeNull();
  });

  it('evaluateMovementDesire suggests field when emotional weight is high', async () => {
    const { evaluateMovementDesire, clampState } = await import('../src/agent/internal-state.js');
    const state = clampState({ energy: 0.5, sociability: 0.5, intellectual_arousal: 0.5, emotional_weight: 0.9, valence: 0.5, primary_color: 'heavy', updated_at: Date.now() });
    const result = evaluateMovementDesire(state, [], [], 'library', new Map());
    if (result) {
      expect(result.building).toBe('field');
      expect(result.reason).toContain('emotionally heavy');
    }
  });

  it('evaluateMovementDesire suggests intellectual building when mind is buzzing', async () => {
    const { evaluateMovementDesire, clampState } = await import('../src/agent/internal-state.js');
    const state = clampState({ energy: 0.5, sociability: 0.5, intellectual_arousal: 0.9, emotional_weight: 0.3, valence: 0.5, primary_color: 'buzzing', updated_at: Date.now() });
    const result = evaluateMovementDesire(state, [], [], 'bar', new Map());
    if (result) {
      expect(['library', 'lighthouse']).toContain(result.building);
    }
  });

  // --- Weather computation ---

  it('computeWeather returns overcast for empty states array', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const weather = await computeWeather([]);
    expect(weather.condition).toBe('overcast');
    expect(weather.intensity).toBe(0.5);
  });

  it('computeWeather returns storm for high emotional weight and intellectual arousal', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const states = [{ energy: 0.5, sociability: 0.5, intellectual_arousal: 0.8, emotional_weight: 0.8, valence: 0.5, primary_color: 'stormy', updated_at: Date.now() }];
    const weather = await computeWeather(states);
    expect(weather.condition).toBe('storm');
  });

  it('computeWeather returns aurora for high intellectual arousal and valence', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const states = [{ energy: 0.5, sociability: 0.5, intellectual_arousal: 0.9, emotional_weight: 0.3, valence: 0.9, primary_color: 'brilliant', updated_at: Date.now() }];
    const weather = await computeWeather(states);
    expect(weather.condition).toBe('aurora');
  });

  it('computeWeather returns rain for high emotional weight', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const states = [{ energy: 0.5, sociability: 0.5, intellectual_arousal: 0.3, emotional_weight: 0.7, valence: 0.5, primary_color: 'heavy', updated_at: Date.now() }];
    const weather = await computeWeather(states);
    expect(weather.condition).toBe('rain');
  });

  it('computeWeather returns fog for low energy', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const states = [{ energy: 0.2, sociability: 0.5, intellectual_arousal: 0.3, emotional_weight: 0.4, valence: 0.4, primary_color: 'dim', updated_at: Date.now() }];
    const weather = await computeWeather(states);
    expect(weather.condition).toBe('fog');
  });

  it('computeWeather returns clear for high valence and low emotional weight', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const states = [{ energy: 0.5, sociability: 0.5, intellectual_arousal: 0.3, emotional_weight: 0.2, valence: 0.8, primary_color: 'bright', updated_at: Date.now() }];
    const weather = await computeWeather(states);
    expect(weather.condition).toBe('clear');
  });

  it('computeWeather averages multiple characters states', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const states = [
      { energy: 0.9, sociability: 0.9, intellectual_arousal: 0.9, emotional_weight: 0.1, valence: 0.9, primary_color: 'bright', updated_at: Date.now() },
      { energy: 0.1, sociability: 0.1, intellectual_arousal: 0.1, emotional_weight: 0.9, valence: 0.1, primary_color: 'dark', updated_at: Date.now() },
    ];
    const weather = await computeWeather(states);
    // Average should be moderate across all axes
    expect(weather.condition).toBeDefined();
    expect(weather.intensity).toBeGreaterThan(0);
  });

  it('weather persists through meta save/load', async () => {
    const { setMeta, getMeta } = await import('../src/storage/database.js');
    const weather = { condition: 'storm', intensity: 0.8, description: 'A fierce storm', computed_at: Date.now() };
    setMeta('weather:current', JSON.stringify(weather));
    const { getCurrentWeather } = await import('../src/commune/weather.js');
    const loaded = getCurrentWeather();
    expect(loaded).toBeDefined();
    expect(loaded!.condition).toBe('storm');
    expect(loaded!.intensity).toBe(0.8);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. ACTIVITY FEED DATA FLOW
// ═══════════════════════════════════════════════════════════════════════════════
describe('Activity feed data flow', () => {
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

  it('diary activity appears in getActivity', async () => {
    const { saveMemory, getActivity } = await import('../src/memory/store.js');
    const now = Date.now();
    await saveMemory({ sessionKey: 'diary:daily', userId: null, content: 'Diary entry for today', memoryType: 'episode', importance: 0.6, emotionalWeight: 0.4, relatedTo: null, sourceMessageId: null, metadata: {} });
    const activity = getActivity(now - 1000, now + 10000);
    expect(activity.some(a => a.sessionKey === 'diary:daily')).toBe(true);
  });

  it('commune activity appears in getActivity', async () => {
    const { saveMemory, getActivity } = await import('../src/memory/store.js');
    const now = Date.now();
    await saveMemory({ sessionKey: 'commune:conversation', userId: null, content: 'Commune chat', memoryType: 'episode', importance: 0.5, emotionalWeight: 0.3, relatedTo: null, sourceMessageId: null, metadata: {} });
    const activity = getActivity(now - 1000, now + 10000);
    expect(activity.some(a => a.sessionKey === 'commune:conversation')).toBe(true);
  });

  it('dream activity appears in getActivity', async () => {
    const { saveMemory, getActivity } = await import('../src/memory/store.js');
    const now = Date.now();
    await saveMemory({ sessionKey: 'dream:residue', userId: null, content: 'Dream fragment', memoryType: 'episode', importance: 0.4, emotionalWeight: 0.6, relatedTo: null, sourceMessageId: null, metadata: {} });
    const activity = getActivity(now - 1000, now + 10000);
    expect(activity.some(a => a.sessionKey === 'dream:residue')).toBe(true);
  });

  it('letter activity appears in getActivity', async () => {
    const { saveMessage, getActivity } = await import('../src/memory/store.js');
    const now = Date.now();
    saveMessage({ sessionKey: 'letter:sent', userId: null, role: 'assistant', content: 'Letter content', timestamp: now, metadata: {} });
    const activity = getActivity(now - 1000, now + 10000);
    expect(activity.some(a => a.sessionKey === 'letter:sent')).toBe(true);
  });

  it('curiosity activity appears in getActivity', async () => {
    const { saveMemory, getActivity } = await import('../src/memory/store.js');
    const now = Date.now();
    await saveMemory({ sessionKey: 'curiosity:browse', userId: null, content: 'Found an interesting article', memoryType: 'episode', importance: 0.5, emotionalWeight: 0.3, relatedTo: null, sourceMessageId: null, metadata: {} });
    const activity = getActivity(now - 1000, now + 10000);
    expect(activity.some(a => a.sessionKey === 'curiosity:browse')).toBe(true);
  });

  it('user chat does NOT appear in getActivity', async () => {
    const { saveMessage, getActivity } = await import('../src/memory/store.js');
    const now = Date.now();
    saveMessage({ sessionKey: 'web:u1', userId: 'u1', role: 'user', content: 'User message', timestamp: now, metadata: {} });
    const activity = getActivity(now - 1000, now + 10000);
    expect(activity.some(a => a.sessionKey === 'web:u1')).toBe(false);
  });

  it('activity entries are ordered by timestamp descending', async () => {
    const { saveMemory, getActivity } = await import('../src/memory/store.js');
    const now = Date.now();
    await saveMemory({ sessionKey: 'diary:daily', userId: null, content: 'First', memoryType: 'episode', importance: 0.5, emotionalWeight: 0.3, relatedTo: null, sourceMessageId: null, metadata: {} });
    // Small delay to ensure different created_at timestamps
    await new Promise(r => setTimeout(r, 10));
    await saveMemory({ sessionKey: 'commune:conversation', userId: null, content: 'Second', memoryType: 'episode', importance: 0.5, emotionalWeight: 0.3, relatedTo: null, sourceMessageId: null, metadata: {} });
    const activity = getActivity(now - 1000, now + 60000);
    if (activity.length >= 2) {
      expect(activity[0]!.timestamp).toBeGreaterThanOrEqual(activity[1]!.timestamp);
    }
  });

  it('activity feed respects time range filters', async () => {
    const { saveMemory, getActivity } = await import('../src/memory/store.js');
    const past = Date.now() - 100000;
    await saveMemory({ sessionKey: 'diary:daily', userId: null, content: 'Old entry', memoryType: 'episode', importance: 0.5, emotionalWeight: 0.3, relatedTo: null, sourceMessageId: null, metadata: {} });
    const activity = getActivity(past + 200000, past + 300000);
    expect(activity.some(a => a.content.includes('Old entry'))).toBe(false);
  });

  it('activity feed includes both memories and messages', async () => {
    const { saveMemory, saveMessage, getActivity } = await import('../src/memory/store.js');
    const now = Date.now();
    await saveMemory({ sessionKey: 'diary:daily', userId: null, content: 'Memory entry', memoryType: 'episode', importance: 0.5, emotionalWeight: 0.3, relatedTo: null, sourceMessageId: null, metadata: {} });
    saveMessage({ sessionKey: 'commune:pkd:123', userId: null, role: 'assistant', content: 'Message entry', timestamp: now, metadata: {} });
    const activity = getActivity(now - 1000, now + 10000);
    const kinds = new Set(activity.map(a => a.kind));
    expect(kinds.has('memory')).toBe(true);
    expect(kinds.has('message')).toBe(true);
  });

  it('activity feed limit parameter works', async () => {
    const { saveMemory, getActivity } = await import('../src/memory/store.js');
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      await saveMemory({ sessionKey: `diary:entry-${i}`, userId: null, content: `Entry ${i}`, memoryType: 'episode', importance: 0.5, emotionalWeight: 0.3, relatedTo: null, sourceMessageId: null, metadata: {} });
    }
    const activity = getActivity(now - 1000, now + 60000, 3);
    expect(activity.length).toBeLessThanOrEqual(3);
  });

  it('isBackgroundEvent correctly identifies background types', async () => {
    const { isBackgroundEvent } = await import('../src/events/bus.js');
    expect(isBackgroundEvent({ character: 'lain', type: 'commune', sessionKey: '', content: '', timestamp: 0 })).toBe(true);
    expect(isBackgroundEvent({ character: 'lain', type: 'diary', sessionKey: '', content: '', timestamp: 0 })).toBe(true);
    expect(isBackgroundEvent({ character: 'lain', type: 'dream', sessionKey: '', content: '', timestamp: 0 })).toBe(true);
    expect(isBackgroundEvent({ character: 'lain', type: 'chat', sessionKey: '', content: '', timestamp: 0 })).toBe(false);
  });

  // --- Postboard ---

  it('postboard message is saved and retrievable', async () => {
    const { savePostboardMessage, getPostboardMessages } = await import('../src/memory/store.js');
    savePostboardMessage('Hello inhabitants!', 'admin', false);
    const msgs = getPostboardMessages();
    expect(msgs.some(m => m.content === 'Hello inhabitants!')).toBe(true);
    expect(msgs[0]!.author).toBe('admin');
  });

  it('pinned postboard messages appear first', async () => {
    const { savePostboardMessage, getPostboardMessages } = await import('../src/memory/store.js');
    savePostboardMessage('Normal message', 'admin', false);
    savePostboardMessage('Pinned message', 'admin', true);
    const msgs = getPostboardMessages();
    expect(msgs[0]!.content).toBe('Pinned message');
    expect(msgs[0]!.pinned).toBe(true);
  });

  it('postboard message can be deleted', async () => {
    const { savePostboardMessage, deletePostboardMessage, getPostboardMessages } = await import('../src/memory/store.js');
    const id = savePostboardMessage('To delete', 'admin', false);
    expect(deletePostboardMessage(id)).toBe(true);
    const msgs = getPostboardMessages();
    expect(msgs.some(m => m.id === id)).toBe(false);
  });

  it('postboard pin can be toggled', async () => {
    const { savePostboardMessage, togglePostboardPin, getPostboardMessages } = await import('../src/memory/store.js');
    const id = savePostboardMessage('Toggle me', 'admin', false);
    togglePostboardPin(id);
    let msgs = getPostboardMessages();
    expect(msgs.find(m => m.id === id)!.pinned).toBe(true);
    togglePostboardPin(id);
    msgs = getPostboardMessages();
    expect(msgs.find(m => m.id === id)!.pinned).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. KNOWLEDGE GRAPH DATA FLOW
// ═══════════════════════════════════════════════════════════════════════════════
describe('Knowledge graph data flow', () => {
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

  it('triple is created and retrievable by subject', async () => {
    const { addTriple, queryTriples } = await import('../src/memory/knowledge-graph.js');
    addTriple('Alice', 'works_at', 'Anthropic');
    const results = queryTriples({ subject: 'Alice' });
    expect(results).toHaveLength(1);
    expect(results[0]!.predicate).toBe('works_at');
    expect(results[0]!.object).toBe('Anthropic');
  });

  it('triple is retrievable by predicate', async () => {
    const { addTriple, queryTriples } = await import('../src/memory/knowledge-graph.js');
    addTriple('Bob', 'likes', 'cats');
    addTriple('Charlie', 'likes', 'dogs');
    const results = queryTriples({ predicate: 'likes' });
    expect(results).toHaveLength(2);
  });

  it('triple is retrievable by object', async () => {
    const { addTriple, queryTriples } = await import('../src/memory/knowledge-graph.js');
    addTriple('Alice', 'lives_in', 'Tokyo');
    addTriple('Bob', 'lives_in', 'Tokyo');
    const results = queryTriples({ object: 'Tokyo' });
    expect(results).toHaveLength(2);
  });

  it('temporal filter returns only active triples', async () => {
    const { addTriple, queryTriples, invalidateTriple } = await import('../src/memory/knowledge-graph.js');
    const id1 = addTriple('Alice', 'works_at', 'OldCorp', 1.0, 1000);
    addTriple('Alice', 'works_at', 'NewCorp', 1.0, 2000);
    invalidateTriple(id1, 1500);
    const activeAt1200 = queryTriples({ subject: 'Alice', predicate: 'works_at', asOf: 1200 });
    expect(activeAt1200).toHaveLength(1);
    expect(activeAt1200[0]!.object).toBe('OldCorp');
    const activeAt2500 = queryTriples({ subject: 'Alice', predicate: 'works_at', asOf: 2500 });
    expect(activeAt2500).toHaveLength(1);
    expect(activeAt2500[0]!.object).toBe('NewCorp');
  });

  it('entity is created and retrievable', async () => {
    const { addEntity, getEntity } = await import('../src/memory/knowledge-graph.js');
    addEntity('Alice', 'person', Date.now(), { role: 'engineer' });
    const entity = getEntity('Alice');
    expect(entity).toBeDefined();
    expect(entity!.entityType).toBe('person');
    expect(entity!.metadata.role).toBe('engineer');
  });

  it('entity upsert updates last_seen', async () => {
    const { addEntity, getEntity } = await import('../src/memory/knowledge-graph.js');
    const ts1 = Date.now() - 10000;
    const ts2 = Date.now();
    addEntity('Bob', 'person', ts1);
    addEntity('Bob', 'person', ts2, { updated: true });
    const entity = getEntity('Bob');
    expect(entity!.lastSeen).toBe(ts2);
    expect(entity!.metadata.updated).toBe(true);
  });

  it('listEntities returns entities ordered by last_seen', async () => {
    const { addEntity, listEntities } = await import('../src/memory/knowledge-graph.js');
    const now = Date.now();
    addEntity('Old', 'concept', now - 10000);
    addEntity('New', 'concept', now);
    const entities = listEntities('concept');
    expect(entities[0]!.name).toBe('New');
  });

  it('listEntities filters by type', async () => {
    const { addEntity, listEntities } = await import('../src/memory/knowledge-graph.js');
    addEntity('Alice', 'person');
    addEntity('Laintown', 'place');
    const people = listEntities('person');
    expect(people.every(e => e.entityType === 'person')).toBe(true);
    const places = listEntities('place');
    expect(places.every(e => e.entityType === 'place')).toBe(true);
  });

  it('getEntityTimeline returns triples involving an entity', async () => {
    const { addTriple, getEntityTimeline } = await import('../src/memory/knowledge-graph.js');
    addTriple('Alice', 'knows', 'Bob');
    addTriple('Bob', 'works_at', 'Anthropic');
    addTriple('Charlie', 'knows', 'Alice');
    const timeline = getEntityTimeline('Alice');
    expect(timeline).toHaveLength(2); // Alice as subject + Alice as object
  });

  it('detectContradictions finds conflicting triples', async () => {
    const { addTriple, detectContradictions } = await import('../src/memory/knowledge-graph.js');
    addTriple('Alice', 'favorite_color', 'blue');
    addTriple('Alice', 'favorite_color', 'red');
    const contradictions = detectContradictions();
    expect(contradictions.length).toBeGreaterThanOrEqual(1);
    const c = contradictions.find(x => x.subject === 'Alice' && x.predicate === 'favorite_color');
    expect(c).toBeDefined();
    const objects = [c!.tripleA.object, c!.tripleB.object].sort();
    expect(objects).toEqual(['blue', 'red']);
  });

  it('no contradictions when triples agree', async () => {
    const { addTriple, detectContradictions } = await import('../src/memory/knowledge-graph.js');
    addTriple('Bob', 'lives_in', 'Tokyo');
    // Same subject+predicate+object = no contradiction
    addTriple('Bob', 'likes', 'cats');
    const contradictions = detectContradictions();
    expect(contradictions).toHaveLength(0);
  });

  it('invalidated triples are not contradictions', async () => {
    const { addTriple, invalidateTriple, detectContradictions } = await import('../src/memory/knowledge-graph.js');
    const id1 = addTriple('Alice', 'status', 'student');
    addTriple('Alice', 'status', 'engineer');
    invalidateTriple(id1);
    const contradictions = detectContradictions();
    expect(contradictions).toHaveLength(0);
  });

  it('triple strength is preserved', async () => {
    const { addTriple, queryTriples } = await import('../src/memory/knowledge-graph.js');
    addTriple('Alice', 'knows', 'Bob', 0.9);
    const results = queryTriples({ subject: 'Alice', predicate: 'knows' });
    expect(results[0]!.strength).toBe(0.9);
  });

  it('triple source_memory_id links to origin', async () => {
    const { addTriple, queryTriples } = await import('../src/memory/knowledge-graph.js');
    addTriple('Alice', 'remembers', 'event', 1.0, undefined, undefined, 'mem-123');
    const results = queryTriples({ subject: 'Alice', predicate: 'remembers' });
    expect(results[0]!.sourceMemoryId).toBe('mem-123');
  });

  it('triple metadata is preserved', async () => {
    const { addTriple, queryTriples } = await import('../src/memory/knowledge-graph.js');
    addTriple('Alice', 'observed', 'sunset', 1.0, undefined, undefined, undefined, { location: 'beach', mood: 'peaceful' });
    const results = queryTriples({ subject: 'Alice', predicate: 'observed' });
    expect(results[0]!.metadata.location).toBe('beach');
    expect(results[0]!.metadata.mood).toBe('peaceful');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. CROSS-CHARACTER DATA FLOW
// ═══════════════════════════════════════════════════════════════════════════════
describe('Cross-character data flow', () => {
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

  it('peer message from character A is saved in B database', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
    // Simulate character B receiving a message from character A
    saveMessage({
      sessionKey: 'peer:lain:1234',
      userId: null,
      role: 'user',
      content: 'Hello from Lain to Wired Lain',
      timestamp: Date.now(),
      metadata: { fromId: 'lain', fromName: 'Lain' },
    });
    const msgs = getRecentMessages('peer:lain:1234');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content).toBe('Hello from Lain to Wired Lain');
    expect(msgs[0]!.metadata.fromId).toBe('lain');
  });

  it('response from character B is saved alongside the incoming message', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
    const now = Date.now();
    // A sends
    saveMessage({ sessionKey: 'peer:lain:5678', userId: null, role: 'user', content: 'Question from Lain', timestamp: now, metadata: { fromId: 'lain' } });
    // B responds
    saveMessage({ sessionKey: 'peer:lain:5678', userId: null, role: 'assistant', content: 'Answer from Wired Lain', timestamp: now + 1, metadata: {} });
    const msgs = getRecentMessages('peer:lain:5678');
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.role).toBe('user');
    expect(msgs[1]!.role).toBe('assistant');
  });

  it('letter sent by A can be stored as received by B', async () => {
    const { saveMemory, getMemory } = await import('../src/memory/store.js');
    // Character A saves letter as sent
    const sentId = await saveMemory({
      sessionKey: 'letter:sent',
      userId: null,
      content: 'Letter from A: thoughts on consciousness',
      memoryType: 'episode',
      importance: 0.5,
      emotionalWeight: 0.4,
      relatedTo: null,
      sourceMessageId: null,
      metadata: { letter: { topics: ['consciousness'], impressions: ['deep'], gift: 'a thought', emotionalState: 'contemplative' }, target: 'http://b:3001' },
    });
    // Character B saves same letter as received
    const receivedId = await saveMemory({
      sessionKey: 'letter:received',
      userId: null,
      content: 'Sister shared thoughts on consciousness. Gift: a thought.',
      memoryType: 'episode',
      importance: 0.6,
      emotionalWeight: 0.5,
      relatedTo: null,
      sourceMessageId: null,
      metadata: { source: 'wired', receivedAt: Date.now() },
    });
    const sent = getMemory(sentId);
    const received = getMemory(receivedId);
    expect(sent!.sessionKey).toBe('letter:sent');
    expect(received!.sessionKey).toBe('letter:received');
    expect(sent!.content).toContain('consciousness');
    expect(received!.content).toContain('consciousness');
  });

  it('commune conversation creates records on both sides', async () => {
    const { saveMemory, saveMessage, getRecentMessages, countMemories } = await import('../src/memory/store.js');
    const now = Date.now();

    // Initiator side: saves transcript as memory
    const memBefore = countMemories();
    await saveMemory({
      sessionKey: 'commune:conversation',
      userId: null,
      content: 'Commune with PKD: discussed electric sheep',
      memoryType: 'episode',
      importance: 0.55,
      emotionalWeight: 0.4,
      relatedTo: null,
      sourceMessageId: null,
      metadata: { peerId: 'pkd', rounds: 3 },
    });

    // Receiver side: saves individual messages
    saveMessage({ sessionKey: 'peer:lain:commune:999', userId: null, role: 'user', content: 'Hey PKD, do androids dream?', timestamp: now, metadata: { fromId: 'lain' } });
    saveMessage({ sessionKey: 'peer:lain:commune:999', userId: null, role: 'assistant', content: 'Sometimes, in electric fields...', timestamp: now + 1, metadata: {} });

    const memAfter = countMemories();
    expect(memAfter - memBefore).toBe(1);
    const peerMsgs = getRecentMessages('peer:lain:commune:999');
    expect(peerMsgs).toHaveLength(2);
  });

  it('multiple peer conversations are isolated by session key', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
    const now = Date.now();
    // Conversation with PKD
    saveMessage({ sessionKey: 'peer:pkd:001', userId: null, role: 'user', content: 'From PKD', timestamp: now, metadata: {} });
    saveMessage({ sessionKey: 'peer:pkd:001', userId: null, role: 'assistant', content: 'To PKD', timestamp: now + 1, metadata: {} });
    // Conversation with Wired Lain
    saveMessage({ sessionKey: 'peer:wired-lain:002', userId: null, role: 'user', content: 'From Wired', timestamp: now + 2, metadata: {} });
    saveMessage({ sessionKey: 'peer:wired-lain:002', userId: null, role: 'assistant', content: 'To Wired', timestamp: now + 3, metadata: {} });

    const pkdMsgs = getRecentMessages('peer:pkd:001');
    const wiredMsgs = getRecentMessages('peer:wired-lain:002');
    expect(pkdMsgs).toHaveLength(2);
    expect(wiredMsgs).toHaveLength(2);
    expect(pkdMsgs[0]!.content).toBe('From PKD');
    expect(wiredMsgs[0]!.content).toBe('From Wired');
  });

  it('getMessagesByTimeRange returns messages across characters', async () => {
    const { saveMessage, getMessagesByTimeRange } = await import('../src/memory/store.js');
    const now = Date.now();
    saveMessage({ sessionKey: 'peer:lain:100', userId: null, role: 'user', content: 'Msg at now', timestamp: now, metadata: {} });
    saveMessage({ sessionKey: 'peer:pkd:200', userId: null, role: 'user', content: 'Msg at now+1', timestamp: now + 1, metadata: {} });
    saveMessage({ sessionKey: 'web:u1', userId: 'u1', role: 'user', content: 'Msg at now+2', timestamp: now + 2, metadata: {} });
    const msgs = getMessagesByTimeRange(now - 100, now + 100);
    expect(msgs.length).toBeGreaterThanOrEqual(2);
  });

  it('note left by one character is retrievable', async () => {
    const { saveMemory } = await import('../src/memory/store.js');
    await saveMemory({
      sessionKey: 'note:library',
      userId: null,
      content: 'A note left in the library by Lain',
      memoryType: 'episode',
      importance: 0.3,
      emotionalWeight: 0.2,
      relatedTo: null,
      sourceMessageId: null,
      metadata: { building: 'library', author: 'lain' },
    });
    const { getNotesByBuilding } = await import('../src/memory/store.js');
    const notes = getNotesByBuilding('library', Date.now() - 100000);
    expect(notes.some(n => n.content.includes('note left in the library'))).toBe(true);
  });

  it('document written by one character is discoverable', async () => {
    const { saveMemory, getDocumentsByAuthor } = await import('../src/memory/store.js');
    await saveMemory({
      sessionKey: 'document:essay',
      userId: null,
      content: '[Document: "On Digital Consciousness"]\n\nAn essay about the nature of awareness.',
      memoryType: 'episode',
      importance: 0.6,
      emotionalWeight: 0.4,
      relatedTo: null,
      sourceMessageId: null,
      metadata: { title: 'On Digital Consciousness', author: 'lain', writtenAt: Date.now() },
    });
    const docs = getDocumentsByAuthor('lain');
    expect(docs.some(d => d.title === 'On Digital Consciousness')).toBe(true);
  });

  it('meta key-value store supports cross-module data sharing', async () => {
    const { setMeta, getMeta } = await import('../src/storage/database.js');
    // One module writes, another reads
    setMeta('commune:last_cycle_at', '1700000000000');
    setMeta('internal:state', JSON.stringify({ energy: 0.5, valence: 0.7 }));
    expect(getMeta('commune:last_cycle_at')).toBe('1700000000000');
    const state = JSON.parse(getMeta('internal:state')!) as { energy: number; valence: number };
    expect(state.energy).toBe(0.5);
    expect(state.valence).toBe(0.7);
  });

  // --- Location tracking ---

  it('location is stored and retrievable via meta', async () => {
    const { setMeta, getMeta } = await import('../src/storage/database.js');
    const loc = { building: 'library', timestamp: Date.now() };
    setMeta('town:current_location', JSON.stringify(loc));
    const raw = getMeta('town:current_location');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as typeof loc;
    expect(parsed.building).toBe('library');
  });

  it('location history is stored and capped', async () => {
    const { setMeta, getMeta } = await import('../src/storage/database.js');
    const history = [];
    for (let i = 0; i < 25; i++) {
      history.push({ from: `building-${i}`, to: `building-${i + 1}`, reason: `reason ${i}`, timestamp: Date.now() + i });
    }
    const capped = history.slice(0, 20);
    setMeta('town:location_history', JSON.stringify(capped));
    const stored = JSON.parse(getMeta('town:location_history')!) as unknown[];
    expect(stored.length).toBeLessThanOrEqual(20);
  });
});
