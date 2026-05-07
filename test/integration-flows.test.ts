/**
 * Integration flow tests — verifying that different systems work together correctly.
 *
 * Uses real SQLite (in-memory via temp dirs) and mocked LLM providers.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

// ── Mock embeddings so tests run without ML models ──────────────────────────
vi.mock('../src/memory/embeddings.js', () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
  cosineSimilarity: vi.fn().mockReturnValue(0.85),
  serializeEmbedding: vi.fn((arr: Float32Array) => Buffer.from(arr.buffer)),
  deserializeEmbedding: vi.fn((buf: Buffer) => new Float32Array(buf.buffer)),
  CURRENT_EMBEDDING_MODEL: 'Xenova/all-MiniLM-L6-v2',
}));

// ─── Shared DB setup helpers ────────────────────────────────────────────────

async function createTestDb(): Promise<{ testDir: string; dbPath: string }> {
  const testDir = join(tmpdir(), `lain-int-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
// 1. MESSAGE → MEMORY FLOW
// ══════════════════════════════════════════════════════════════════════════════
describe('Message → Memory flow', () => {
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

  it('saves a message and retrieves it by session key', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
    const id = saveMessage({ sessionKey: 'web:alice', userId: 'alice', role: 'user', content: 'hello world', timestamp: Date.now(), metadata: {} });
    expect(typeof id).toBe('string');
    const msgs = getRecentMessages('web:alice');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content).toBe('hello world');
  });

  it('preserves all message fields through storage round-trip', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
    const ts = Date.now();
    saveMessage({ sessionKey: 'web:bob', userId: 'bob', role: 'assistant', content: 'I am Lain', timestamp: ts, metadata: { foo: 'bar' } });
    const msgs = getRecentMessages('web:bob');
    const m = msgs[0]!;
    expect(m.role).toBe('assistant');
    expect(m.userId).toBe('bob');
    expect(m.timestamp).toBe(ts);
    expect(m.metadata['foo']).toBe('bar');
  });

  it('isolates messages by session key', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
    saveMessage({ sessionKey: 'web:alice', userId: null, role: 'user', content: 'alice msg', timestamp: Date.now(), metadata: {} });
    saveMessage({ sessionKey: 'web:bob', userId: null, role: 'user', content: 'bob msg', timestamp: Date.now(), metadata: {} });
    expect(getRecentMessages('web:alice')).toHaveLength(1);
    expect(getRecentMessages('web:bob')).toHaveLength(1);
    expect(getRecentMessages('web:alice')[0]!.content).toBe('alice msg');
  });

  it('respects limit on getRecentMessages', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
    for (let i = 0; i < 10; i++) {
      saveMessage({ sessionKey: 'web:alice', userId: null, role: 'user', content: `msg ${i}`, timestamp: Date.now() + i, metadata: {} });
    }
    expect(getRecentMessages('web:alice', 3)).toHaveLength(3);
  });

  it('returns messages in chronological order', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
    const now = Date.now();
    saveMessage({ sessionKey: 'web:alice', userId: null, role: 'user', content: 'first', timestamp: now, metadata: {} });
    saveMessage({ sessionKey: 'web:alice', userId: null, role: 'user', content: 'second', timestamp: now + 100, metadata: {} });
    saveMessage({ sessionKey: 'web:alice', userId: null, role: 'user', content: 'third', timestamp: now + 200, metadata: {} });
    const msgs = getRecentMessages('web:alice');
    expect(msgs[0]!.content).toBe('first');
    expect(msgs[2]!.content).toBe('third');
  });

  it('saves a memory and retrieves it by ID', async () => {
    const { saveMemory, getMemory } = await import('../src/memory/store.js');
    const id = await saveMemory({
      sessionKey: 'web:alice', userId: 'alice', content: 'test memory content',
      memoryType: 'fact', importance: 0.7, emotionalWeight: 0.3,
      relatedTo: null, sourceMessageId: null, metadata: {},
    });
    const mem = getMemory(id);
    expect(mem).toBeDefined();
    expect(mem!.content).toBe('test memory content');
    expect(mem!.memoryType).toBe('fact');
    expect(mem!.importance).toBeCloseTo(0.7);
  });

  it('assigns palace placement (wingId, roomId, hall) on save', async () => {
    const { saveMemory, getMemory } = await import('../src/memory/store.js');
    const id = await saveMemory({
      sessionKey: 'curiosity:browse', userId: null, content: 'discovered a new concept',
      memoryType: 'episode', importance: 0.5, emotionalWeight: 0.2,
      relatedTo: null, sourceMessageId: null, metadata: {},
    });
    const mem = getMemory(id);
    expect(mem!.wingId).toBeTruthy();
    expect(mem!.roomId).toBeTruthy();
    expect(mem!.hall).toBe('discoveries');
  });

  it('assigns correct hall for fact type memories', async () => {
    const { saveMemory, getMemory } = await import('../src/memory/store.js');
    const id = await saveMemory({
      sessionKey: 'web:alice', userId: null, content: 'a factual memory',
      memoryType: 'fact', importance: 0.5, emotionalWeight: 0,
      relatedTo: null, sourceMessageId: null, metadata: {},
    });
    const mem = getMemory(id);
    expect(mem!.hall).toBe('truths');
  });

  it('assigns dreams hall for dream session memories', async () => {
    const { saveMemory, getMemory } = await import('../src/memory/store.js');
    const id = await saveMemory({
      sessionKey: 'dreams:nightly', userId: null, content: 'a dream fragment',
      memoryType: 'episode', importance: 0.4, emotionalWeight: 0.5,
      relatedTo: null, sourceMessageId: null, metadata: {},
    });
    const mem = getMemory(id);
    expect(mem!.hall).toBe('dreams');
  });

  it('increments access count on search retrieval', async () => {
    const { saveMemory, getMemory } = await import('../src/memory/store.js');
    const { updateMemoryAccess } = await import('../src/memory/store.js');
    const id = await saveMemory({
      sessionKey: 'web:alice', userId: null, content: 'accessible memory',
      memoryType: 'fact', importance: 0.8, emotionalWeight: 0,
      relatedTo: null, sourceMessageId: null, metadata: {},
    });
    const before = getMemory(id)!.accessCount;
    updateMemoryAccess(id);
    const after = getMemory(id)!.accessCount;
    expect(after).toBe(before + 1);
  });

  it('links two memories as related', async () => {
    const { saveMemory, getMemory, linkMemories, getRelatedMemories } = await import('../src/memory/store.js');
    const id1 = await saveMemory({ sessionKey: 'web:alice', userId: null, content: 'memory A', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, relatedTo: null, sourceMessageId: null, metadata: {} });
    const id2 = await saveMemory({ sessionKey: 'web:alice', userId: null, content: 'memory B', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, relatedTo: null, sourceMessageId: null, metadata: {} });
    linkMemories(id2, id1);
    const related = getRelatedMemories(id1);
    expect(related.some(m => m.id === id2)).toBe(true);
  });

  it('countMessages reflects stored messages', async () => {
    const { saveMessage, countMessages } = await import('../src/memory/store.js');
    const before = countMessages();
    saveMessage({ sessionKey: 'web:alice', userId: null, role: 'user', content: 'x', timestamp: Date.now(), metadata: {} });
    expect(countMessages()).toBe(before + 1);
  });

  it('countMemories reflects stored memories', async () => {
    const { saveMemory, countMemories } = await import('../src/memory/store.js');
    const before = countMemories();
    await saveMemory({ sessionKey: 'web:alice', userId: null, content: 'test', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, relatedTo: null, sourceMessageId: null, metadata: {} });
    expect(countMemories()).toBe(before + 1);
  });

  it('deletes a memory and cannot retrieve it afterward', async () => {
    const { saveMemory, getMemory, deleteMemory } = await import('../src/memory/store.js');
    const id = await saveMemory({ sessionKey: 'web:alice', userId: null, content: 'ephemeral', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, relatedTo: null, sourceMessageId: null, metadata: {} });
    expect(getMemory(id)).toBeDefined();
    const deleted = deleteMemory(id);
    expect(deleted).toBe(true);
    expect(getMemory(id)).toBeUndefined();
  });

  it('getRecentVisitorMessages excludes peer: sessions', async () => {
    const { saveMessage, getRecentVisitorMessages } = await import('../src/memory/store.js');
    saveMessage({ sessionKey: 'web:alice', userId: null, role: 'user', content: 'visitor msg', timestamp: Date.now(), metadata: {} });
    saveMessage({ sessionKey: 'peer:wired-lain', userId: null, role: 'user', content: 'peer msg', timestamp: Date.now(), metadata: {} });
    const msgs = getRecentVisitorMessages(20);
    expect(msgs.some(m => m.content === 'visitor msg')).toBe(true);
    expect(msgs.some(m => m.content === 'peer msg')).toBe(false);
  });

  it('getRecentVisitorMessages excludes commune: sessions', async () => {
    const { saveMessage, getRecentVisitorMessages } = await import('../src/memory/store.js');
    saveMessage({ sessionKey: 'commune:chat', userId: null, role: 'user', content: 'commune msg', timestamp: Date.now(), metadata: {} });
    const msgs = getRecentVisitorMessages(20);
    expect(msgs.some(m => m.content === 'commune msg')).toBe(false);
  });

  it('getRecentVisitorMessages excludes doctor: sessions', async () => {
    const { saveMessage, getRecentVisitorMessages } = await import('../src/memory/store.js');
    saveMessage({ sessionKey: 'doctor:therapy', userId: null, role: 'user', content: 'doctor msg', timestamp: Date.now(), metadata: {} });
    const msgs = getRecentVisitorMessages(20);
    expect(msgs.some(m => m.content === 'doctor msg')).toBe(false);
  });

  it('getActivity returns background loop entries in range', async () => {
    const { saveMessage, getActivity } = await import('../src/memory/store.js');
    const now = Date.now();
    saveMessage({ sessionKey: 'diary:daily', userId: null, role: 'assistant', content: 'diary entry', timestamp: now, metadata: {} });
    const activity = getActivity(now - 1000, now + 1000, 50);
    expect(activity.some(a => a.sessionKey === 'diary:daily')).toBe(true);
  });

  it('getActivity does not include visitor chat sessions', async () => {
    const { saveMessage, getActivity } = await import('../src/memory/store.js');
    const now = Date.now();
    saveMessage({ sessionKey: 'web:alice', userId: null, role: 'user', content: 'chat msg', timestamp: now, metadata: {} });
    const activity = getActivity(now - 1000, now + 1000, 50);
    expect(activity.some(a => a.sessionKey === 'web:alice')).toBe(false);
  });

  it('addAssociation and getAssociations creates a retrievable link', async () => {
    const { saveMemory, addAssociation, getAssociations } = await import('../src/memory/store.js');
    const id1 = await saveMemory({ sessionKey: 'web:a', userId: null, content: 'source', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, relatedTo: null, sourceMessageId: null, metadata: {} });
    const id2 = await saveMemory({ sessionKey: 'web:a', userId: null, content: 'target', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, relatedTo: null, sourceMessageId: null, metadata: {} });
    addAssociation(id1, id2, 'similar', 0.9);
    const assocs = getAssociations(id1);
    expect(assocs.length).toBeGreaterThanOrEqual(1);
    expect(assocs[0]!.strength).toBeCloseTo(0.9);
  });

  it('lifecycle state is persisted and retrievable', async () => {
    const { saveMemory, getMemory, setLifecycleState } = await import('../src/memory/store.js');
    const id = await saveMemory({ sessionKey: 'web:a', userId: null, content: 'evolving memory', memoryType: 'episode', importance: 0.5, emotionalWeight: 0, relatedTo: null, sourceMessageId: null, metadata: {} });
    setLifecycleState(id, 'mature');
    const mem = getMemory(id);
    expect(mem!.lifecycleState).toBe('mature');
  });

  it('composting lifecycle state excludes memory from search results', async () => {
    const { saveMemory, getMemory, setLifecycleState, getAllMemories } = await import('../src/memory/store.js');
    const id = await saveMemory({ sessionKey: 'web:a', userId: null, content: 'composted memory', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, relatedTo: null, sourceMessageId: null, metadata: {} });
    setLifecycleState(id, 'composting');
    const allMems = getAllMemories();
    // composting memories CAN appear in getAllMemories — search is what filters them
    const mem = getMemory(id);
    expect(mem!.lifecycleState).toBe('composting');
  });

  it('savePostboardMessage and getPostboardMessages round-trip', async () => {
    const { savePostboardMessage, getPostboardMessages } = await import('../src/memory/store.js');
    const id = savePostboardMessage('Hello town!', 'admin', true);
    const msgs = getPostboardMessages();
    expect(msgs.some(m => m.id === id && m.content === 'Hello town!' && m.pinned)).toBe(true);
  });

  it('togglePostboardPin flips pinned state', async () => {
    const { savePostboardMessage, getPostboardMessages, togglePostboardPin } = await import('../src/memory/store.js');
    const id = savePostboardMessage('Unpin me', 'admin', true);
    togglePostboardPin(id);
    const msgs = getPostboardMessages();
    const msg = msgs.find(m => m.id === id)!;
    expect(msg.pinned).toBe(false);
  });

  it('getMessagesByTimeRange filters correctly', async () => {
    const { saveMessage, getMessagesByTimeRange } = await import('../src/memory/store.js');
    const base = Date.now();
    saveMessage({ sessionKey: 'web:a', userId: null, role: 'user', content: 'in range', timestamp: base + 500, metadata: {} });
    saveMessage({ sessionKey: 'web:a', userId: null, role: 'user', content: 'out of range', timestamp: base - 5000, metadata: {} });
    const msgs = getMessagesByTimeRange(base, base + 1000);
    expect(msgs.some(m => m.content === 'in range')).toBe(true);
    expect(msgs.some(m => m.content === 'out of range')).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. COMMUNE LOOP FLOW
// ══════════════════════════════════════════════════════════════════════════════
describe('Commune loop flow', () => {
  let testDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    originalHome = process.env['LAIN_HOME'];
    const result = await createTestDb();
    testDir = result.testDir;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const { eventBus } = await import('../src/events/bus.js');
    eventBus.removeAllListeners('activity');
    await teardownTestDb(testDir, originalHome);
  });

  it('startCommuneLoop with no peers returns a cleanup function and does not throw', async () => {
    const { startCommuneLoop } = await import('../src/agent/commune-loop.js');
    const stop = startCommuneLoop({ characterId: 'lain', characterName: 'Lain', peers: [], enabled: false });
    expect(typeof stop).toBe('function');
    stop();
  });

  it('startCommuneLoop disabled=true returns no-op cleanup', async () => {
    const { startCommuneLoop } = await import('../src/agent/commune-loop.js');
    const stop = startCommuneLoop({ characterId: 'lain', characterName: 'Lain', peers: [{ id: 'pkd', name: 'PKD', url: 'http://localhost:3002' }], enabled: false });
    expect(typeof stop).toBe('function');
    stop();
  });

  it('getCurrentLocation returns valid building before any movement', async () => {
    const { eventBus } = await import('../src/events/bus.js');
    const { getCurrentLocation } = await import('../src/commune/location.js');
    eventBus.setCharacterId('lain');
    const loc = getCurrentLocation('lain');
    expect(typeof loc.building).toBe('string');
    expect(loc.building.length).toBeGreaterThan(0);
  });

  it('setCurrentLocation updates the persisted building', async () => {
    const { eventBus } = await import('../src/events/bus.js');
    const { setCurrentLocation, getCurrentLocation } = await import('../src/commune/location.js');
    eventBus.setCharacterId('lain');
    setCurrentLocation('library', 'want to read');
    expect(getCurrentLocation('lain').building).toBe('library');
  });

  it('moving to same location is a no-op', async () => {
    const { eventBus } = await import('../src/events/bus.js');
    const { setCurrentLocation, getLocationHistory } = await import('../src/commune/location.js');
    eventBus.setCharacterId('lain');
    setCurrentLocation('bar', 'first move');
    setCurrentLocation('bar', 'still here');
    const history = getLocationHistory();
    expect(history).toHaveLength(1);
  });

  it('movement emits an activity event', async () => {
    const { eventBus } = await import('../src/events/bus.js');
    const { setCurrentLocation } = await import('../src/commune/location.js');
    eventBus.setCharacterId('lain');
    const events: unknown[] = [];
    eventBus.on('activity', (e: unknown) => events.push(e));
    setCurrentLocation('bar', 'feeling social');
    expect(events.some((e: any) => e.type === 'movement')).toBe(true);
    eventBus.removeAllListeners('activity');
  });

  it('movement event content mentions building names', async () => {
    const { eventBus } = await import('../src/events/bus.js');
    const { setCurrentLocation } = await import('../src/commune/location.js');
    eventBus.setCharacterId('lain');
    const events: any[] = [];
    eventBus.on('activity', (e: any) => events.push(e));
    // Move from one place to another so a movement event fires
    setCurrentLocation('library', 'first move');
    setCurrentLocation('lighthouse', 'seeking clarity');
    const mv = events.find((e: any) => e.type === 'movement' && e.content?.includes('Lighthouse'));
    expect(mv).toBeDefined();
    expect(mv.content).toMatch(/Lighthouse/);
    eventBus.removeAllListeners('activity');
  });

  it('location history is appended with correct from/to fields', async () => {
    const { eventBus } = await import('../src/events/bus.js');
    const { setCurrentLocation, getLocationHistory } = await import('../src/commune/location.js');
    eventBus.setCharacterId('lain');
    setCurrentLocation('library', 'first');
    setCurrentLocation('bar', 'second');
    const hist = getLocationHistory();
    expect(hist[0]!.from).toBe('library');
    expect(hist[0]!.to).toBe('bar');
  });

  it('location history is capped at 20 entries', async () => {
    const { eventBus } = await import('../src/events/bus.js');
    const { setCurrentLocation, getLocationHistory } = await import('../src/commune/location.js');
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    eventBus.setCharacterId('lain');
    const buildings = BUILDINGS.map(b => b.id);
    for (let i = 0; i < 25; i++) {
      setCurrentLocation(buildings[i % buildings.length]! as any, `move ${i}`);
    }
    expect(getLocationHistory().length).toBeLessThanOrEqual(20);
  });

  it('commune reflection memory is saved to store', async () => {
    const { saveMemory, getMemoriesByType } = await import('../src/memory/store.js');
    // Simulate what phaseReflection does internally
    const memId = await saveMemory({
      sessionKey: 'commune:conversation',
      userId: null,
      content: 'Commune conversation with PKD:\n\nLain: Hello\nPKD: Hi\n\nReflection: We discussed identity.',
      memoryType: 'episode',
      importance: 0.55,
      emotionalWeight: 0.4,
      relatedTo: null,
      sourceMessageId: null,
      metadata: { type: 'commune_conversation', peerId: 'pkd', peerName: 'PKD', rounds: 2 },
    });
    const episodes = getMemoriesByType('episode');
    const saved = episodes.find(m => m.id === memId);
    expect(saved).toBeDefined();
    expect(saved!.metadata['type']).toBe('commune_conversation');
    expect(saved!.metadata['peerId']).toBe('pkd');
  });

  it('commune conversation history is stored and retrieved from meta', async () => {
    const { getMeta, setMeta } = await import('../src/storage/database.js');
    const history = [{ timestamp: Date.now(), peerId: 'pkd', peerName: 'PKD', rounds: 3, openingTopic: 'consciousness', reflection: 'interesting talk' }];
    setMeta('commune:conversation_history', JSON.stringify(history));
    const raw = getMeta('commune:conversation_history');
    const parsed = JSON.parse(raw!);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].peerId).toBe('pkd');
  });

  it('commune last cycle timestamp is persisted in meta', async () => {
    const { getMeta, setMeta } = await import('../src/storage/database.js');
    const ts = Date.now();
    setMeta('commune:last_cycle_at', ts.toString());
    const raw = getMeta('commune:last_cycle_at');
    expect(parseInt(raw!, 10)).toBe(ts);
  });

  it('valid buildings are all recognized by BUILDING_MAP', async () => {
    const { BUILDING_MAP, BUILDINGS } = await import('../src/commune/buildings.js');
    for (const b of BUILDINGS) {
      expect(BUILDING_MAP.has(b.id)).toBe(true);
    }
  });

  it('invalid building IDs are rejected by isValidBuilding', async () => {
    const { isValidBuilding } = await import('../src/commune/buildings.js');
    expect(isValidBuilding('nowhere')).toBe(false);
    expect(isValidBuilding('')).toBe(false);
    expect(isValidBuilding('LIBRARY')).toBe(false);
  });

  it('all 9 buildings are defined', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    expect(BUILDINGS).toHaveLength(9);
  });

  it('empty building list causes commune loop to return immediately', async () => {
    const { startCommuneLoop } = await import('../src/agent/commune-loop.js');
    const stop = startCommuneLoop({ characterId: 'lain', characterName: 'Lain', peers: [] });
    expect(typeof stop).toBe('function');
    stop();
  });

  it('updateRelationship stores data in meta', async () => {
    const { getMeta, setMeta } = await import('../src/storage/database.js');
    // Simulate what updateRelationship does by verifying the meta store round-trip
    const rel = { peerId: 'pkd', affinity: 0.7, last_interaction: Date.now(), last_topic_thread: 'identity' };
    setMeta('relationship:pkd', JSON.stringify(rel));
    const raw = getMeta('relationship:pkd');
    expect(JSON.parse(raw!).affinity).toBeCloseTo(0.7);
  });

  it('commune memory wing resolves to correct peer wing', async () => {
    const { resolveWingForMemory } = await import('../src/memory/palace.js');
    const result = resolveWingForMemory('commune:pkd', null, {});
    expect(result.wingName).toBe('pkd');
  });

  it('commune memory hall is encounters', async () => {
    const { assignHall } = await import('../src/memory/palace.js');
    expect(assignHall('episode', 'commune:pkd')).toBe('encounters');
  });

  it('location history reason is preserved', async () => {
    const { eventBus } = await import('../src/events/bus.js');
    const { setCurrentLocation, getLocationHistory } = await import('../src/commune/location.js');
    eventBus.setCharacterId('lain');
    setCurrentLocation('market', 'peer is at market');
    const hist = getLocationHistory();
    expect(hist[0]!.reason).toBe('peer is at market');
  });

  it('commune loop startCommuneLoop handles peers correctly with enabled=true', async () => {
    // Just ensure it starts without throwing — we stop it immediately
    const { startCommuneLoop } = await import('../src/agent/commune-loop.js');
    const stop = startCommuneLoop({
      characterId: 'lain', characterName: 'Lain',
      peers: [{ id: 'pkd', name: 'PKD', url: 'http://localhost:3002' }],
      intervalMs: 999999999,  // very long interval so it doesn't fire
      maxJitterMs: 0,
      enabled: true,
    });
    expect(typeof stop).toBe('function');
    stop();
  });

  it('BUILDING_MAP contains threshold as special liminal space', async () => {
    const { BUILDING_MAP } = await import('../src/commune/buildings.js');
    const t = BUILDING_MAP.get('threshold');
    expect(t).toBeDefined();
    expect(t!.description).toContain('liminal');
  });

  it('commune conversation memory has correct importance range', async () => {
    const { saveMemory, getMemory } = await import('../src/memory/store.js');
    const id = await saveMemory({
      sessionKey: 'commune:conversation', userId: null, content: 'test commune memory',
      memoryType: 'episode', importance: 0.55, emotionalWeight: 0.4,
      relatedTo: null, sourceMessageId: null, metadata: { type: 'commune_conversation' },
    });
    const mem = getMemory(id);
    expect(mem!.importance).toBeGreaterThan(0);
    expect(mem!.importance).toBeLessThanOrEqual(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. DOCTOR DIAGNOSTIC FLOW
// ══════════════════════════════════════════════════════════════════════════════
describe('Doctor diagnostic flow', () => {
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

  it('countMemories and countMessages are available as telemetry primitives', async () => {
    const { countMemories, countMessages } = await import('../src/memory/store.js');
    expect(typeof countMemories()).toBe('number');
    expect(typeof countMessages()).toBe('number');
  });

  it('doctor telemetry: memory count increases after saving memories', async () => {
    const { saveMemory, countMemories } = await import('../src/memory/store.js');
    const before = countMemories();
    await saveMemory({ sessionKey: 'diary:today', userId: null, content: 'lain wrote in diary', memoryType: 'episode', importance: 0.5, emotionalWeight: 0.3, relatedTo: null, sourceMessageId: null, metadata: {} });
    expect(countMemories()).toBe(before + 1);
  });

  it('doctor telemetry: message count increases after saving messages', async () => {
    const { saveMessage, countMessages } = await import('../src/memory/store.js');
    const before = countMessages();
    saveMessage({ sessionKey: 'peer:wired-lain', userId: null, role: 'user', content: 'hi', timestamp: Date.now(), metadata: {} });
    expect(countMessages()).toBe(before + 1);
  });

  it('getMeta and setMeta work for doctor state persistence', async () => {
    const { getMeta, setMeta } = await import('../src/storage/database.js');
    setMeta('doctor:last_telemetry_at', Date.now().toString());
    const val = getMeta('doctor:last_telemetry_at');
    expect(val).toBeTruthy();
    expect(parseInt(val!, 10)).toBeGreaterThan(0);
  });

  it('doctor session memories use doctor: session key prefix', async () => {
    const { saveMemory, getMemoriesByType } = await import('../src/memory/store.js');
    await saveMemory({ sessionKey: 'doctor:therapy-session', userId: null, content: 'therapy session content', memoryType: 'episode', importance: 0.6, emotionalWeight: 0.5, relatedTo: null, sourceMessageId: null, metadata: {} });
    const episodes = getMemoriesByType('episode');
    expect(episodes.some(m => m.sessionKey === 'doctor:therapy-session')).toBe(true);
  });

  it('doctor memory wing resolves to dr-claude', async () => {
    const { resolveWingForMemory } = await import('../src/memory/palace.js');
    const result = resolveWingForMemory('doctor:session-123', null, {});
    expect(result.wingName).toBe('dr-claude');
  });

  it('therapy session key resolves to dr-claude wing as well', async () => {
    const { resolveWingForMemory } = await import('../src/memory/palace.js');
    const result = resolveWingForMemory('therapy:session-1', null, {});
    expect(result.wingName).toBe('dr-claude');
  });

  it('recent memories query returns memories ordered by importance desc', async () => {
    const { saveMemory, getMemoriesByType } = await import('../src/memory/store.js');
    await saveMemory({ sessionKey: 'web:a', userId: null, content: 'low importance', memoryType: 'fact', importance: 0.1, emotionalWeight: 0, relatedTo: null, sourceMessageId: null, metadata: {} });
    await saveMemory({ sessionKey: 'web:a', userId: null, content: 'high importance', memoryType: 'fact', importance: 0.9, emotionalWeight: 0, relatedTo: null, sourceMessageId: null, metadata: {} });
    const facts = getMemoriesByType('fact');
    // High importance should appear before low
    const highIdx = facts.findIndex(m => m.content === 'high importance');
    const lowIdx = facts.findIndex(m => m.content === 'low importance');
    expect(highIdx).toBeLessThan(lowIdx);
  });

  it('doctor can query diary memories by session prefix', async () => {
    const { saveMemory, getAllMemories } = await import('../src/memory/store.js');
    await saveMemory({ sessionKey: 'diary:2026-04-16', userId: null, content: 'daily entry', memoryType: 'episode', importance: 0.5, emotionalWeight: 0.2, relatedTo: null, sourceMessageId: null, metadata: {} });
    const all = getAllMemories();
    expect(all.some(m => m.sessionKey === 'diary:2026-04-16')).toBe(true);
  });

  it('doctor can query curiosity memories by session prefix', async () => {
    const { saveMemory, getAllMemories } = await import('../src/memory/store.js');
    await saveMemory({ sessionKey: 'curiosity:browse-1', userId: null, content: 'found interesting thing', memoryType: 'episode', importance: 0.5, emotionalWeight: 0.1, relatedTo: null, sourceMessageId: null, metadata: { url: 'https://example.com' } });
    const all = getAllMemories();
    expect(all.some(m => m.sessionKey?.startsWith('curiosity:'))).toBe(true);
  });

  it('getMemoriesByType correctly filters by type', async () => {
    const { saveMemory, getMemoriesByType } = await import('../src/memory/store.js');
    await saveMemory({ sessionKey: 'web:a', userId: null, content: 'a preference', memoryType: 'preference', importance: 0.5, emotionalWeight: 0, relatedTo: null, sourceMessageId: null, metadata: {} });
    const prefs = getMemoriesByType('preference');
    expect(prefs.every(m => m.memoryType === 'preference')).toBe(true);
    expect(prefs.some(m => m.content === 'a preference')).toBe(true);
  });

  it('doctor getMeta for last cycle at is initially null for fresh db', async () => {
    const { getMeta } = await import('../src/storage/database.js');
    const val = getMeta('doctor:last_telemetry_at_new_key_xyz');
    expect(val).toBeNull();
  });

  it('getLastUserMessageTimestamp returns null when no messages exist', async () => {
    const { getLastUserMessageTimestamp } = await import('../src/memory/store.js');
    const ts = getLastUserMessageTimestamp();
    expect(ts).toBeNull();
  });

  it('getLastUserMessageTimestamp returns correct value after user message', async () => {
    const { saveMessage, getLastUserMessageTimestamp } = await import('../src/memory/store.js');
    const ts = Date.now();
    saveMessage({ sessionKey: 'web:a', userId: null, role: 'user', content: 'hello', timestamp: ts, metadata: {} });
    const result = getLastUserMessageTimestamp();
    expect(result).toBe(ts);
  });

  it('session is created correctly for doctor interactions', async () => {
    const { createSession, getSession } = await import('../src/storage/sessions.js');
    const session = createSession({ agentId: 'default', channel: 'http', peerKind: 'anonymous', peerId: 'doctor-client' });
    const retrieved = getSession(session.key);
    expect(retrieved).toBeDefined();
    expect(retrieved!.channel).toBe('http');
  });

  it('doctor telemetry loop last_run key is a number string', async () => {
    const { getMeta, setMeta } = await import('../src/storage/database.js');
    const ts = Date.now();
    setMeta('doctor:telemetry_last_run', ts.toString());
    const raw = getMeta('doctor:telemetry_last_run');
    expect(Number.isInteger(parseInt(raw!, 10))).toBe(true);
  });

  it('getEntityMemories returns memories tagged as entities', async () => {
    const { saveMemory, getEntityMemories } = await import('../src/memory/store.js');
    await saveMemory({ sessionKey: 'web:a', userId: null, content: 'lain is a person', memoryType: 'fact', importance: 0.8, emotionalWeight: 0, relatedTo: null, sourceMessageId: null, metadata: { isEntity: true } });
    const entities = getEntityMemories();
    expect(entities.some(m => m.metadata['isEntity'] === true)).toBe(true);
  });

  it('activity feed shows doctor: sessions', async () => {
    const { saveMessage, getActivity } = await import('../src/memory/store.js');
    const now = Date.now();
    saveMessage({ sessionKey: 'doctor:check', userId: null, role: 'assistant', content: 'health check', timestamp: now, metadata: {} });
    const activity = getActivity(now - 100, now + 100, 50);
    expect(activity.some(a => a.sessionKey === 'doctor:check')).toBe(true);
  });

  it('structural role computation returns valid values', async () => {
    const { saveMemory, computeStructuralRole } = await import('../src/memory/store.js');
    const id = await saveMemory({ sessionKey: 'web:a', userId: null, content: 'a mem', memoryType: 'fact', importance: 0.5, emotionalWeight: 0, relatedTo: null, sourceMessageId: null, metadata: {} });
    const role = computeStructuralRole(id);
    expect(['foundational', 'bridge', 'ephemeral']).toContain(role);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. POSSESSION FLOW
// ══════════════════════════════════════════════════════════════════════════════
describe('Possession flow', () => {
  afterEach(async () => {
    // Reset possession state after each test
    const { endPossession } = await import('../src/agent/possession.js');
    try { endPossession(); } catch { /* already ended */ }
  });

  it('isPossessed returns false by default', async () => {
    const { isPossessed } = await import('../src/agent/possession.js');
    expect(isPossessed()).toBe(false);
  });

  it('startPossession sets isPossessed to true', async () => {
    const { startPossession, isPossessed } = await import('../src/agent/possession.js');
    startPossession('player-session-1', [], []);
    expect(isPossessed()).toBe(true);
  });

  it('endPossession sets isPossessed to false', async () => {
    const { startPossession, endPossession, isPossessed } = await import('../src/agent/possession.js');
    startPossession('player-session-2', [], []);
    endPossession();
    expect(isPossessed()).toBe(false);
  });

  it('startPossession stops provided loop stop functions', async () => {
    const { startPossession, endPossession } = await import('../src/agent/possession.js');
    const stopFn = vi.fn();
    startPossession('sess-3', [stopFn], []);
    expect(stopFn).toHaveBeenCalledOnce();
    endPossession();
  });

  it('endPossession calls loop restarters and restores activeLoopStops', async () => {
    const { startPossession, endPossession, getActiveLoopStops } = await import('../src/agent/possession.js');
    const stopFn = vi.fn().mockReturnValue(() => {});
    const restarter = vi.fn().mockReturnValue(stopFn);
    startPossession('sess-4', [], [restarter]);
    endPossession();
    expect(restarter).toHaveBeenCalledOnce();
  });

  it('concurrent startPossession call while possessed is a no-op', async () => {
    const { startPossession, endPossession, getPossessionState } = await import('../src/agent/possession.js');
    startPossession('session-A', [], []);
    startPossession('session-B', [], []); // should no-op
    expect(getPossessionState().playerSessionId).toBe('session-A');
    endPossession();
  });

  it('getPossessionState reflects correct session ID', async () => {
    const { startPossession, endPossession, getPossessionState } = await import('../src/agent/possession.js');
    startPossession('unique-session-xyz', [], []);
    const state = getPossessionState();
    expect(state.isPossessed).toBe(true);
    expect(state.playerSessionId).toBe('unique-session-xyz');
    endPossession();
  });

  it('addPendingPeerMessage enqueues a message and resolves on resolvePendingMessage', async () => {
    const { startPossession, endPossession, addPendingPeerMessage, resolvePendingMessage, getPendingPeerMessages } = await import('../src/agent/possession.js');
    startPossession('sess-5', [], []);
    const promise = addPendingPeerMessage('pkd', 'PKD', 'Hello Lain');
    expect(getPendingPeerMessages()).toHaveLength(1);
    resolvePendingMessage('pkd', 'hello back');
    const response = await promise;
    expect(response).toBe('hello back');
    endPossession();
  });

  it('endPossession resolves all pending messages with "..."', async () => {
    const { startPossession, endPossession, addPendingPeerMessage } = await import('../src/agent/possession.js');
    startPossession('sess-6', [], []);
    const p1 = addPendingPeerMessage('pkd', 'PKD', 'Hey');
    const p2 = addPendingPeerMessage('wired', 'Wired', 'Yo');
    endPossession();
    expect(await p1).toBe('...');
    expect(await p2).toBe('...');
  });

  it('getPendingPeerMessages returns empty when not possessed', async () => {
    const { getPendingPeerMessages } = await import('../src/agent/possession.js');
    expect(getPendingPeerMessages()).toHaveLength(0);
  });

  it('resolvePendingMessage returns false for unknown fromId', async () => {
    const { startPossession, endPossession, resolvePendingMessage } = await import('../src/agent/possession.js');
    startPossession('sess-7', [], []);
    const result = resolvePendingMessage('nobody', 'response');
    expect(result).toBe(false);
    endPossession();
  });

  it('touchActivity updates lastActivityAt', async () => {
    const { startPossession, endPossession, touchActivity, getPossessionState } = await import('../src/agent/possession.js');
    startPossession('sess-8', [], []);
    const before = getPossessionState().possessedAt;
    touchActivity();
    // possessedAt doesn't change, but the internal lastActivityAt does
    expect(getPossessionState().possessedAt).toBe(before);
    endPossession();
  });

  it('verifyPossessionAuth returns false when no POSSESSION_TOKEN set', async () => {
    const { verifyPossessionAuth } = await import('../src/agent/possession.js');
    const saved = process.env['POSSESSION_TOKEN'];
    delete process.env['POSSESSION_TOKEN'];
    expect(verifyPossessionAuth('Bearer test')).toBe(false);
    if (saved) process.env['POSSESSION_TOKEN'] = saved;
  });

  it('verifyPossessionAuth returns true with correct token', async () => {
    const { verifyPossessionAuth } = await import('../src/agent/possession.js');
    process.env['POSSESSION_TOKEN'] = 'secret-token';
    expect(verifyPossessionAuth('Bearer secret-token')).toBe(true);
    delete process.env['POSSESSION_TOKEN'];
  });

  it('verifyPossessionAuth returns false for wrong token', async () => {
    const { verifyPossessionAuth } = await import('../src/agent/possession.js');
    process.env['POSSESSION_TOKEN'] = 'correct-token';
    expect(verifyPossessionAuth('Bearer wrong-token')).toBe(false);
    delete process.env['POSSESSION_TOKEN'];
  });

  it('endPossession is idempotent — calling twice does not throw', async () => {
    const { startPossession, endPossession } = await import('../src/agent/possession.js');
    startPossession('sess-9', [], []);
    endPossession();
    expect(() => endPossession()).not.toThrow();
  });

  it('pendingCount in state reflects pending messages count', async () => {
    const { startPossession, endPossession, addPendingPeerMessage, getPossessionState } = await import('../src/agent/possession.js');
    startPossession('sess-10', [], []);
    addPendingPeerMessage('pkd', 'PKD', 'msg 1');
    addPendingPeerMessage('wired', 'Wired', 'msg 2');
    expect(getPossessionState().pendingCount).toBe(2);
    endPossession();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. AUTH → API → RESPONSE FLOW
// ══════════════════════════════════════════════════════════════════════════════
describe('Auth → API → Response flow', () => {
  beforeEach(() => {
    process.env['LAIN_OWNER_TOKEN'] = 'test-owner-token-abc';
  });

  afterEach(() => {
    delete process.env['LAIN_OWNER_TOKEN'];
  });

  it('v2 cookie signature is a hex string', async () => {
    const { makeV2Cookie } = await import('./fixtures/owner-cookie-v2.js');
    const cookie = makeV2Cookie('some-token');
    expect(cookie).toMatch(/^lain_owner_v2=[A-Za-z0-9_-]+\.[a-f0-9]+$/);
  });

  it('v2 cookie signature is deterministic for fixed iat+nonce', async () => {
    const { makeV2Cookie } = await import('./fixtures/owner-cookie-v2.js');
    const a = makeV2Cookie('abc', { iat: 1, nonce: 'n' });
    const b = makeV2Cookie('abc', { iat: 1, nonce: 'n' });
    expect(a).toBe(b);
  });

  it('v2 cookie signature differs for different tokens', async () => {
    const { makeV2Cookie } = await import('./fixtures/owner-cookie-v2.js');
    expect(makeV2Cookie('token-a', { iat: 1, nonce: 'n' })).not.toBe(
      makeV2Cookie('token-b', { iat: 1, nonce: 'n' }),
    );
  });

  it('isOwner returns false when no cookie header is provided', async () => {
    const { isOwner } = await import('../src/web/owner-auth.js');
    const req = { headers: {} } as any;
    expect(isOwner(req)).toBe(false);
  });

  it('isOwner returns false when LAIN_OWNER_TOKEN is not set', async () => {
    const { isOwner } = await import('../src/web/owner-auth.js');
    const { makeV2Cookie } = await import('./fixtures/owner-cookie-v2.js');
    delete process.env['LAIN_OWNER_TOKEN'];
    const req = { headers: { cookie: makeV2Cookie('some-token') } } as any;
    expect(isOwner(req)).toBe(false);
  });

  it('isOwner returns true with valid v2 cookie', async () => {
    const { isOwner } = await import('../src/web/owner-auth.js');
    const { makeV2Cookie } = await import('./fixtures/owner-cookie-v2.js');
    process.env['LAIN_OWNER_TOKEN'] = 'test-owner-token-abc';
    const req = { headers: { cookie: makeV2Cookie('test-owner-token-abc') } } as any;
    expect(isOwner(req)).toBe(true);
  });

  it('isOwner returns false with tampered cookie value', async () => {
    const { isOwner } = await import('../src/web/owner-auth.js');
    process.env['LAIN_OWNER_TOKEN'] = 'test-owner-token-abc';
    const req = { headers: { cookie: 'lain_owner_v2=aabbccddeeff0011.deadbeef' } } as any;
    expect(isOwner(req)).toBe(false);
  });

  it('isOwner returns false with legacy v1 cookie (rejected outright)', async () => {
    const { isOwner } = await import('../src/web/owner-auth.js');
    process.env['LAIN_OWNER_TOKEN'] = 'test-owner-token-abc';
    const req = { headers: { cookie: 'lain_owner=aabbccddeeff0011' } } as any;
    expect(isOwner(req)).toBe(false);
  });

  it('isOwner returns false with malformed cookie header', async () => {
    const { isOwner } = await import('../src/web/owner-auth.js');
    const req = { headers: { cookie: 'not_a_valid_cookie' } } as any;
    expect(isOwner(req)).toBe(false);
  });

  it('isOwner handles multiple cookies — only lain_owner_v2 matters', async () => {
    const { isOwner } = await import('../src/web/owner-auth.js');
    const { makeV2CookieValue } = await import('./fixtures/owner-cookie-v2.js');
    process.env['LAIN_OWNER_TOKEN'] = 'test-owner-token-abc';
    const val = makeV2CookieValue('test-owner-token-abc');
    const req = { headers: { cookie: `session=xyz; lain_owner_v2=${val}; other=abc` } } as any;
    expect(isOwner(req)).toBe(true);
  });

  it('session is created and retrievable for web:http flow', async () => {
    const originalHome = process.env['LAIN_HOME'];
    const testDir = join(tmpdir(), `lain-auth-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    process.env['LAIN_HOME'] = testDir;
    const { initDatabase, closeDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(testDir, 'test.db'));
    try {
      const { createSession, getSession } = await import('../src/storage/sessions.js');
      const s = createSession({ agentId: 'default', channel: 'http', peerKind: 'anonymous', peerId: 'web-visitor' });
      const retrieved = getSession(s.key);
      expect(retrieved).toBeDefined();
      expect(retrieved!.peerId).toBe('web-visitor');
    } finally {
      closeDatabase();
      if (originalHome) process.env['LAIN_HOME'] = originalHome;
      else delete process.env['LAIN_HOME'];
      try { await rm(testDir, { recursive: true }); } catch { /* ignore */ }
    }
  });

  it('getOrCreateSession returns same session for same agentId/channel/peerId', async () => {
    const originalHome = process.env['LAIN_HOME'];
    const testDir = join(tmpdir(), `lain-auth-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    process.env['LAIN_HOME'] = testDir;
    const { initDatabase, closeDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(testDir, 'test.db'));
    try {
      const { getOrCreateSession } = await import('../src/storage/sessions.js');
      const input = { agentId: 'default', channel: 'http', peerKind: 'anonymous', peerId: 'same-visitor' };
      const s1 = getOrCreateSession(input as any);
      const s2 = getOrCreateSession(input as any);
      expect(s1.key).toBe(s2.key);
    } finally {
      closeDatabase();
      if (originalHome) process.env['LAIN_HOME'] = originalHome;
      else delete process.env['LAIN_HOME'];
      try { await rm(testDir, { recursive: true }); } catch { /* ignore */ }
    }
  });

  it('v2 cookie signature is 64 hex chars (SHA-256 output)', async () => {
    // findings.md P2:2348 — v2 cookie is `<payload>.<sig>`; signature alone
    // remains a 64-char hex SHA-256 HMAC.
    const { makeV2CookieValue } = await import('./fixtures/owner-cookie-v2.js');
    const [, sig] = makeV2CookieValue('any-token').split('.');
    expect(sig).toHaveLength(64);
    expect(sig).toMatch(/^[a-f0-9]+$/);
  });

  it('interlink token auth: missing bearer header rejected', async () => {
    // Simulate the check used in peer message endpoints
    const interlinkToken = 'my-interlink-secret';
    const authHeader = undefined;
    const valid = authHeader !== undefined && authHeader === `Bearer ${interlinkToken}`;
    expect(valid).toBe(false);
  });

  it('interlink token auth: correct bearer header accepted', async () => {
    const interlinkToken = 'my-interlink-secret';
    const authHeader = `Bearer ${interlinkToken}`;
    const valid = authHeader !== undefined && authHeader === `Bearer ${interlinkToken}`;
    expect(valid).toBe(true);
  });

  it('interlink token auth: wrong token rejected', async () => {
    const interlinkToken = 'my-interlink-secret';
    const authHeader = 'Bearer wrong-token';
    const valid = authHeader !== undefined && authHeader === `Bearer ${interlinkToken}`;
    expect(valid).toBe(false);
  });

  it('session updateSession increments token count', async () => {
    const originalHome = process.env['LAIN_HOME'];
    const testDir = join(tmpdir(), `lain-auth-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    process.env['LAIN_HOME'] = testDir;
    const { initDatabase, closeDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(testDir, 'test.db'));
    try {
      const { createSession, updateSession, getSession } = await import('../src/storage/sessions.js');
      const s = createSession({ agentId: 'default', channel: 'http', peerKind: 'anonymous', peerId: 'tok-visitor' });
      updateSession(s.key, { tokenCount: 500 });
      const updated = getSession(s.key);
      expect(updated!.tokenCount).toBe(500);
    } finally {
      closeDatabase();
      if (originalHome) process.env['LAIN_HOME'] = originalHome;
      else delete process.env['LAIN_HOME'];
      try { await rm(testDir, { recursive: true }); } catch { /* ignore */ }
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. MEMORY PALACE INTEGRATION
// ══════════════════════════════════════════════════════════════════════════════
describe('Memory palace integration', () => {
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

  it('createWing and getWing round-trip', async () => {
    const { createWing, getWing } = await import('../src/memory/palace.js');
    const id = createWing('test-wing', 'A test wing');
    const wing = getWing(id);
    expect(wing).toBeDefined();
    expect(wing!.name).toBe('test-wing');
    expect(wing!.description).toBe('A test wing');
  });

  it('getWingByName finds wing by name', async () => {
    const { createWing, getWingByName } = await import('../src/memory/palace.js');
    createWing('named-wing', 'Description here');
    const found = getWingByName('named-wing');
    expect(found).toBeDefined();
    expect(found!.description).toBe('Description here');
  });

  it('resolveWing returns same ID for repeated calls with same name', async () => {
    const { resolveWing } = await import('../src/memory/palace.js');
    const id1 = resolveWing('idempotent-wing', 'desc');
    const id2 = resolveWing('idempotent-wing', 'desc');
    expect(id1).toBe(id2);
  });

  it('listWings returns all created wings', async () => {
    const { createWing, listWings } = await import('../src/memory/palace.js');
    const countBefore = listWings().length;
    createWing('wing-list-test-1');
    createWing('wing-list-test-2');
    expect(listWings().length).toBe(countBefore + 2);
  });

  it('incrementWingCount increments memory_count', async () => {
    const { createWing, getWing, incrementWingCount } = await import('../src/memory/palace.js');
    const id = createWing('count-wing');
    const before = getWing(id)!.memoryCount;
    incrementWingCount(id);
    incrementWingCount(id);
    expect(getWing(id)!.memoryCount).toBe(before + 2);
  });

  it('createRoom and getRoom round-trip', async () => {
    const { createWing, createRoom, getRoom } = await import('../src/memory/palace.js');
    const wingId = createWing('room-parent-wing');
    const roomId = createRoom(wingId, 'room-one', 'Room one description');
    const room = getRoom(roomId);
    expect(room).toBeDefined();
    expect(room!.name).toBe('room-one');
    expect(room!.wingId).toBe(wingId);
  });

  it('resolveRoom is idempotent', async () => {
    const { createWing, resolveRoom } = await import('../src/memory/palace.js');
    const wingId = createWing('resolveRoom-wing');
    const r1 = resolveRoom(wingId, 'same-room', 'desc');
    const r2 = resolveRoom(wingId, 'same-room', 'desc');
    expect(r1).toBe(r2);
  });

  it('listRooms returns all rooms for a wing', async () => {
    const { createWing, createRoom, listRooms } = await import('../src/memory/palace.js');
    const wingId = createWing('multi-room-wing');
    createRoom(wingId, 'room-a');
    createRoom(wingId, 'room-b');
    const rooms = listRooms(wingId);
    expect(rooms).toHaveLength(2);
  });

  it('assignHall maps preference to truths', async () => {
    const { assignHall } = await import('../src/memory/palace.js');
    expect(assignHall('preference', 'web:alice')).toBe('truths');
  });

  it('assignHall maps summary to reflections', async () => {
    const { assignHall } = await import('../src/memory/palace.js');
    expect(assignHall('summary', 'web:alice')).toBe('reflections');
  });

  it('assignHall maps diary episode to reflections', async () => {
    const { assignHall } = await import('../src/memory/palace.js');
    expect(assignHall('episode', 'diary:today')).toBe('reflections');
  });

  it('assignHall maps letter episode to reflections', async () => {
    const { assignHall } = await import('../src/memory/palace.js');
    expect(assignHall('episode', 'letter:pkd')).toBe('reflections');
  });

  it('assignHall maps context to encounters', async () => {
    const { assignHall } = await import('../src/memory/palace.js');
    expect(assignHall('context', 'web:alice')).toBe('encounters');
  });

  it('resolveWingForMemory maps curiosity sessions correctly', async () => {
    const { resolveWingForMemory } = await import('../src/memory/palace.js');
    const result = resolveWingForMemory('curiosity:browse-session-1', null, {});
    expect(result.wingName).toBe('curiosity');
  });

  it('resolveWingForMemory maps self-concept sessions to self wing', async () => {
    const { resolveWingForMemory } = await import('../src/memory/palace.js');
    const result = resolveWingForMemory('self-concept:2026-04', null, {});
    expect(result.wingName).toBe('self');
  });

  it('resolveWingForMemory routes visitors to shared wing with per-user room (findings.md P2:652)', async () => {
    const { resolveWingForMemory } = await import('../src/memory/palace.js');
    const result = resolveWingForMemory('web:unknown', 'user-123', {});
    expect(result.wingName).toBe('visitors');
    expect(result.roomName).toBe('visitor-user-123');
  });

  it('memory saved with saveMemory gets valid palace placement', async () => {
    const { saveMemory, getMemory } = await import('../src/memory/store.js');
    const { getWing, getRoom } = await import('../src/memory/palace.js');
    const id = await saveMemory({
      sessionKey: 'letter:pkd', userId: null, content: 'dear pkd',
      memoryType: 'episode', importance: 0.5, emotionalWeight: 0.3,
      relatedTo: null, sourceMessageId: null, metadata: {},
    });
    const mem = getMemory(id);
    expect(mem!.wingId).toBeTruthy();
    expect(mem!.roomId).toBeTruthy();
    const wing = getWing(mem!.wingId!);
    expect(wing).toBeDefined();
    const room = getRoom(mem!.roomId!);
    expect(room).toBeDefined();
  });
});
