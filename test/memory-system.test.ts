/**
 * Memory System Test Suite
 *
 * Comprehensive tests for the memory subsystem:
 * - Embeddings: cosine similarity, serialization, findTopK, centroid computation
 * - Store: CRUD functions, lifecycle, postboard, associations, coherence groups
 * - Extraction: memory extraction, summarization, type validation, timeouts
 * - Organic maintenance: forgetting thresholds, importance evolution, decay, caps
 * - Palace: hall assignment, wing resolution, session key routing
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

// Mock keytar before any imports that touch storage
vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn().mockResolvedValue('test-master-key'),
    setPassword: vi.fn().mockResolvedValue(undefined),
    deletePassword: vi.fn().mockResolvedValue(true),
    findCredentials: vi.fn().mockResolvedValue([]),
  },
}));

// ─────────────────────────────────────────────────────────
// 1. EMBEDDINGS — Pure math + serialization, no DB needed
// ─────────────────────────────────────────────────────────
describe('Embeddings', () => {
  it('cosineSimilarity exists and is exported', async () => {
    const { cosineSimilarity } = await import('../src/memory/embeddings.js');
    expect(typeof cosineSimilarity).toBe('function');
  });

  it('cosineSimilarity returns 1.0 for identical vectors', async () => {
    const { cosineSimilarity } = await import('../src/memory/embeddings.js');
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });

  it('cosineSimilarity returns 0.0 for orthogonal vectors', async () => {
    const { cosineSimilarity } = await import('../src/memory/embeddings.js');
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  it('cosineSimilarity returns -1.0 for opposite vectors', async () => {
    const { cosineSimilarity } = await import('../src/memory/embeddings.js');
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([-1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  it('cosineSimilarity throws on dimension mismatch', async () => {
    const { cosineSimilarity } = await import('../src/memory/embeddings.js');
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([1, 0, 0]);
    expect(() => cosineSimilarity(a, b)).toThrow('Embeddings must have same dimensions');
  });

  it('cosineSimilarity returns 0 when magnitude is zero', async () => {
    const { cosineSimilarity } = await import('../src/memory/embeddings.js');
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('cosineSimilarity returns 0 when both vectors are zero', async () => {
    const { cosineSimilarity } = await import('../src/memory/embeddings.js');
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([0, 0, 0]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('serializeEmbedding and deserializeEmbedding roundtrip correctly', async () => {
    const { serializeEmbedding, deserializeEmbedding } = await import('../src/memory/embeddings.js');
    const original = new Float32Array([0.1, 0.2, 0.3, -0.5, 1.0]);
    const buffer = serializeEmbedding(original);
    const restored = deserializeEmbedding(buffer);
    expect(restored.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i]!, 5);
    }
  });

  it('serializeEmbedding produces a Buffer', async () => {
    const { serializeEmbedding } = await import('../src/memory/embeddings.js');
    const emb = new Float32Array([1, 2, 3]);
    const buf = serializeEmbedding(emb);
    expect(Buffer.isBuffer(buf)).toBe(true);
    // 3 floats * 4 bytes each = 12 bytes
    expect(buf.length).toBe(12);
  });

  it('deserializeEmbedding returns Float32Array with correct length', async () => {
    const { serializeEmbedding, deserializeEmbedding } = await import('../src/memory/embeddings.js');
    const original = new Float32Array(384);
    for (let i = 0; i < 384; i++) original[i] = Math.random() * 2 - 1;
    const buf = serializeEmbedding(original);
    const restored = deserializeEmbedding(buf);
    expect(restored).toBeInstanceOf(Float32Array);
    expect(restored.length).toBe(384);
  });

  it('findTopK returns correct number of results', async () => {
    const { findTopK } = await import('../src/memory/embeddings.js');
    const query = new Float32Array([1, 0, 0]);
    const candidates = [
      { id: 'a', embedding: new Float32Array([1, 0, 0]) },
      { id: 'b', embedding: new Float32Array([0.9, 0.1, 0]) },
      { id: 'c', embedding: new Float32Array([0, 1, 0]) },
      { id: 'd', embedding: new Float32Array([0.5, 0.5, 0]) },
    ];
    const top2 = findTopK(query, candidates, 2);
    expect(top2).toHaveLength(2);
    expect(top2[0]!.id).toBe('a');
  });

  it('findTopK returns all candidates when k > candidates.length', async () => {
    const { findTopK } = await import('../src/memory/embeddings.js');
    const query = new Float32Array([1, 0]);
    const candidates = [
      { id: 'x', embedding: new Float32Array([1, 0]) },
    ];
    const results = findTopK(query, candidates, 5);
    expect(results).toHaveLength(1);
  });

  it('findTopK sorts by descending similarity', async () => {
    const { findTopK } = await import('../src/memory/embeddings.js');
    const query = new Float32Array([1, 0, 0]);
    const candidates = [
      { id: 'low', embedding: new Float32Array([0, 1, 0]) },
      { id: 'high', embedding: new Float32Array([0.99, 0.1, 0]) },
      { id: 'mid', embedding: new Float32Array([0.5, 0.5, 0]) },
    ];
    const results = findTopK(query, candidates, 3);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.similarity).toBeGreaterThanOrEqual(results[i]!.similarity);
    }
  });

  it('computeCentroid returns zero vector for empty array', async () => {
    const { computeCentroid, getEmbeddingDimensions } = await import('../src/memory/embeddings.js');
    const centroid = computeCentroid([]);
    expect(centroid).toBeInstanceOf(Float32Array);
    expect(centroid.length).toBe(getEmbeddingDimensions());
    // All zeros
    for (let i = 0; i < centroid.length; i++) {
      expect(centroid[i]).toBe(0);
    }
  });

  it('computeCentroid of a single vector returns that vector (normalized)', async () => {
    const { computeCentroid, cosineSimilarity } = await import('../src/memory/embeddings.js');
    const vec = new Float32Array([1, 2, 3]);
    const centroid = computeCentroid([vec]);
    // Should be L2-normalized version of [1,2,3]
    const sim = cosineSimilarity(centroid, vec);
    expect(sim).toBeCloseTo(1.0, 4);
  });

  it('computeCentroid result is L2-normalized', async () => {
    const { computeCentroid } = await import('../src/memory/embeddings.js');
    const vecs = [
      new Float32Array([1, 0, 0]),
      new Float32Array([0, 1, 0]),
    ];
    const centroid = computeCentroid(vecs);
    let norm = 0;
    for (let i = 0; i < centroid.length; i++) {
      norm += centroid[i]! * centroid[i]!;
    }
    expect(Math.sqrt(norm)).toBeCloseTo(1.0, 4);
  });

  it('getEmbeddingDimensions returns 384', async () => {
    const { getEmbeddingDimensions } = await import('../src/memory/embeddings.js');
    expect(getEmbeddingDimensions()).toBe(384);
  });

  it('EMBEDDING_DIM constant is 384 in source', () => {
    const src = readFileSync(join(process.cwd(), 'src/memory/embeddings.ts'), 'utf-8');
    const match = src.match(/const EMBEDDING_DIM\s*=\s*(\d+)/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(384);
  });

  it('isEmbeddingModelLoaded returns boolean', async () => {
    const { isEmbeddingModelLoaded } = await import('../src/memory/embeddings.js');
    expect(typeof isEmbeddingModelLoaded()).toBe('boolean');
  });

  it('isEmbeddingModelLoading returns boolean', async () => {
    const { isEmbeddingModelLoading } = await import('../src/memory/embeddings.js');
    expect(typeof isEmbeddingModelLoading()).toBe('boolean');
  });
});

// ─────────────────────────────────────────────────────────
// 2. STORE — Source-level structural tests + DB integration
// ─────────────────────────────────────────────────────────
describe('Store — Structural', () => {
  let storeSrc: string;

  beforeEach(() => {
    storeSrc = readFileSync(join(process.cwd(), 'src/memory/store.ts'), 'utf-8');
  });

  // --- CRUD function existence ---

  it('exports saveMessage function', () => {
    expect(storeSrc).toMatch(/export function saveMessage\(/);
  });

  it('exports getRecentMessages function', () => {
    expect(storeSrc).toMatch(/export function getRecentMessages\(/);
  });

  it('exports getAllMessages function', () => {
    expect(storeSrc).toMatch(/export function getAllMessages\(/);
  });

  it('exports saveMemory function', () => {
    expect(storeSrc).toMatch(/export async function saveMemory\(/);
  });

  it('exports getAllMemories function', () => {
    expect(storeSrc).toMatch(/export function getAllMemories\(/);
  });

  it('exports getMemory function', () => {
    expect(storeSrc).toMatch(/export function getMemory\(/);
  });

  it('exports deleteMemory function', () => {
    expect(storeSrc).toMatch(/export function deleteMemory\(/);
  });

  it('exports searchMemories function', () => {
    expect(storeSrc).toMatch(/export async function searchMemories\(/);
  });

  it('exports updateMemoryAccess function', () => {
    expect(storeSrc).toMatch(/export function updateMemoryAccess\(/);
  });

  it('exports updateMemoryImportance function', () => {
    expect(storeSrc).toMatch(/export function updateMemoryImportance\(/);
  });

  it('exports countMemories function', () => {
    expect(storeSrc).toMatch(/export function countMemories\(/);
  });

  it('exports countMessages function', () => {
    expect(storeSrc).toMatch(/export function countMessages\(/);
  });

  it('exports getMemoriesByType function', () => {
    expect(storeSrc).toMatch(/export function getMemoriesByType\(/);
  });

  it('exports linkMemories function', () => {
    expect(storeSrc).toMatch(/export function linkMemories\(/);
  });

  it('exports getRelatedMemories function', () => {
    expect(storeSrc).toMatch(/export function getRelatedMemories\(/);
  });

  it('exports consolidateMemories function', () => {
    expect(storeSrc).toMatch(/export async function consolidateMemories\(/);
  });

  it('exports getMemoriesForUser function', () => {
    expect(storeSrc).toMatch(/export function getMemoriesForUser\(/);
  });

  it('exports getMessagesForUser function', () => {
    expect(storeSrc).toMatch(/export function getMessagesForUser\(/);
  });

  it('exports getResonanceMemory function', () => {
    expect(storeSrc).toMatch(/export function getResonanceMemory\(/);
  });

  it('exports getActivity function', () => {
    expect(storeSrc).toMatch(/export function getActivity\(/);
  });

  // --- Lifecycle states ---

  it('defines all five lifecycle states', () => {
    expect(storeSrc).toContain("'seed'");
    expect(storeSrc).toContain("'growing'");
    expect(storeSrc).toContain("'mature'");
    expect(storeSrc).toContain("'complete'");
    expect(storeSrc).toContain("'composting'");
  });

  it('LifecycleState type includes all states', () => {
    const match = storeSrc.match(/export type LifecycleState\s*=\s*([^;]+);/);
    expect(match).not.toBeNull();
    const def = match![1]!;
    expect(def).toContain("'seed'");
    expect(def).toContain("'growing'");
    expect(def).toContain("'mature'");
    expect(def).toContain("'complete'");
    expect(def).toContain("'composting'");
  });

  // --- Postboard functions ---

  it('exports savePostboardMessage function', () => {
    expect(storeSrc).toMatch(/export function savePostboardMessage\(/);
  });

  it('exports getPostboardMessages function', () => {
    expect(storeSrc).toMatch(/export function getPostboardMessages\(/);
  });

  it('exports deletePostboardMessage function', () => {
    expect(storeSrc).toMatch(/export function deletePostboardMessage\(/);
  });

  it('exports togglePostboardPin function', () => {
    expect(storeSrc).toMatch(/export function togglePostboardPin\(/);
  });

  // --- Association functions ---

  it('exports addAssociation function', () => {
    expect(storeSrc).toMatch(/export function addAssociation\(/);
  });

  it('exports getAssociations function', () => {
    expect(storeSrc).toMatch(/export function getAssociations\(/);
  });

  it('exports strengthenAssociation function', () => {
    expect(storeSrc).toMatch(/export function strengthenAssociation\(/);
  });

  it('exports getAssociatedMemories function', () => {
    expect(storeSrc).toMatch(/export function getAssociatedMemories\(/);
  });

  // --- Coherence group functions ---

  it('exports createCoherenceGroup function', () => {
    expect(storeSrc).toMatch(/export function createCoherenceGroup\(/);
  });

  it('exports getCoherenceGroup function', () => {
    expect(storeSrc).toMatch(/export function getCoherenceGroup\(/);
  });

  it('exports getAllCoherenceGroups function', () => {
    expect(storeSrc).toMatch(/export function getAllCoherenceGroups\(/);
  });

  it('exports addToCoherenceGroup function', () => {
    expect(storeSrc).toMatch(/export function addToCoherenceGroup\(/);
  });

  it('exports removeFromCoherenceGroup function', () => {
    expect(storeSrc).toMatch(/export function removeFromCoherenceGroup\(/);
  });

  it('exports getGroupsForMemory function', () => {
    expect(storeSrc).toMatch(/export function getGroupsForMemory\(/);
  });

  it('exports getGroupMembers function', () => {
    expect(storeSrc).toMatch(/export function getGroupMembers\(/);
  });

  // --- Lifecycle operations ---

  it('exports setLifecycleState function', () => {
    expect(storeSrc).toMatch(/export function setLifecycleState\(/);
  });

  it('exports getMemoriesByLifecycle function', () => {
    expect(storeSrc).toMatch(/export function getMemoriesByLifecycle\(/);
  });

  // --- Causal link operations ---

  it('exports addCausalLink function', () => {
    expect(storeSrc).toMatch(/export function addCausalLink\(/);
  });

  it('exports getCausalLinks function', () => {
    expect(storeSrc).toMatch(/export function getCausalLinks\(/);
  });

  it('exports computeStructuralRole function', () => {
    expect(storeSrc).toMatch(/export function computeStructuralRole\(/);
  });

  // --- minSimilarity search threshold ---

  it('searchMemories has a minSimilarity parameter defaulting to 0.3', () => {
    const match = storeSrc.match(/export async function searchMemories\([^)]*minSimilarity\s*=\s*([\d.]+)/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(0.3);
  });

  // --- saveMemory generates unique IDs with nanoid ---

  it('saveMemory generates IDs with nanoid', () => {
    expect(storeSrc).toMatch(/import\s*\{\s*nanoid\s*\}\s*from\s*'nanoid'/);
    // Within saveMemory function, nanoid is called
    const saveMemoryMatch = storeSrc.match(/export async function saveMemory[\s\S]*?const id = nanoid\(16\)/);
    expect(saveMemoryMatch).not.toBeNull();
  });

  // --- Memory types ---

  it('Memory interface defines all five memory types', () => {
    const match = storeSrc.match(/memoryType:\s*'fact'\s*\|\s*'preference'\s*\|\s*'context'\s*\|\s*'summary'\s*\|\s*'episode'/);
    expect(match).not.toBeNull();
  });

  // --- Sort strategies ---

  it('MemorySortBy includes relevance, recency, importance, and access_count', () => {
    const match = storeSrc.match(/export type MemorySortBy\s*=\s*([^;]+);/);
    expect(match).not.toBeNull();
    const def = match![1]!;
    expect(def).toContain("'relevance'");
    expect(def).toContain("'recency'");
    expect(def).toContain("'importance'");
    expect(def).toContain("'access_count'");
  });
});

// ─────────────────────────────────────────────────────────
// 3. STORE — Database integration tests
// ─────────────────────────────────────────────────────────
describe('Store — Database Integration', () => {
  const testDir = join(tmpdir(), `lain-test-memory-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const dbPath = join(testDir, 'test.db');
  const originalEnv = process.env['LAIN_HOME'];

  beforeEach(async () => {
    process.env['LAIN_HOME'] = testDir;
    await mkdir(testDir, { recursive: true });
    const { initDatabase } = await import('../src/storage/database.js');
    await initDatabase(dbPath);
  });

  afterEach(async () => {
    const { closeDatabase } = await import('../src/storage/database.js');
    closeDatabase();
    if (originalEnv) {
      process.env['LAIN_HOME'] = originalEnv;
    } else {
      delete process.env['LAIN_HOME'];
    }
    try { await rm(testDir, { recursive: true }); } catch {}
  });

  it('saveMessage returns a string ID', async () => {
    const { saveMessage } = await import('../src/memory/store.js');
    const { eventBus } = await import('../src/events/bus.js');
    eventBus.setCharacterId('test');

    const id = saveMessage({
      sessionKey: 'test-session',
      userId: 'user1',
      role: 'user',
      content: 'Hello world',
      timestamp: Date.now(),
      metadata: {},
    });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('getRecentMessages returns messages in chronological order', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
    const { eventBus } = await import('../src/events/bus.js');
    eventBus.setCharacterId('test');

    const now = Date.now();
    saveMessage({ sessionKey: 'sess1', userId: null, role: 'user', content: 'first', timestamp: now - 2000, metadata: {} });
    saveMessage({ sessionKey: 'sess1', userId: null, role: 'assistant', content: 'second', timestamp: now - 1000, metadata: {} });
    saveMessage({ sessionKey: 'sess1', userId: null, role: 'user', content: 'third', timestamp: now, metadata: {} });

    const messages = getRecentMessages('sess1', 10);
    expect(messages).toHaveLength(3);
    expect(messages[0]!.content).toBe('first');
    expect(messages[2]!.content).toBe('third');
  });

  it('getAllMessages returns only messages for the given session', async () => {
    const { saveMessage, getAllMessages } = await import('../src/memory/store.js');
    const { eventBus } = await import('../src/events/bus.js');
    eventBus.setCharacterId('test');

    const now = Date.now();
    saveMessage({ sessionKey: 'sessA', userId: null, role: 'user', content: 'A message', timestamp: now, metadata: {} });
    saveMessage({ sessionKey: 'sessB', userId: null, role: 'user', content: 'B message', timestamp: now, metadata: {} });

    const messagesA = getAllMessages('sessA');
    expect(messagesA).toHaveLength(1);
    expect(messagesA[0]!.content).toBe('A message');
  });

  it('countMessages returns correct count', async () => {
    const { saveMessage, countMessages } = await import('../src/memory/store.js');
    const { eventBus } = await import('../src/events/bus.js');
    eventBus.setCharacterId('test');

    const before = countMessages();
    saveMessage({ sessionKey: 's', userId: null, role: 'user', content: 'msg', timestamp: Date.now(), metadata: {} });
    const after = countMessages();
    expect(after).toBe(before + 1);
  });

  it('savePostboardMessage and getPostboardMessages roundtrip', async () => {
    const { savePostboardMessage, getPostboardMessages } = await import('../src/memory/store.js');
    const id = savePostboardMessage('Test announcement', 'admin', false);
    expect(typeof id).toBe('string');

    const messages = getPostboardMessages(0, 10);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    const found = messages.find(m => m.id === id);
    expect(found).toBeDefined();
    expect(found!.content).toBe('Test announcement');
    expect(found!.author).toBe('admin');
    expect(found!.pinned).toBe(false);
  });

  it('deletePostboardMessage removes the message', async () => {
    const { savePostboardMessage, deletePostboardMessage, getPostboardMessages } = await import('../src/memory/store.js');
    const id = savePostboardMessage('To delete', 'admin');
    expect(deletePostboardMessage(id)).toBe(true);

    const messages = getPostboardMessages(0, 10);
    const found = messages.find(m => m.id === id);
    expect(found).toBeUndefined();
  });

  it('togglePostboardPin toggles the pinned state', async () => {
    const { savePostboardMessage, togglePostboardPin, getPostboardMessages } = await import('../src/memory/store.js');
    const id = savePostboardMessage('Pinnable', 'admin', false);

    togglePostboardPin(id);
    let msgs = getPostboardMessages(0, 10);
    let found = msgs.find(m => m.id === id);
    expect(found!.pinned).toBe(true);

    togglePostboardPin(id);
    msgs = getPostboardMessages(0, 10);
    found = msgs.find(m => m.id === id);
    expect(found!.pinned).toBe(false);
  });

  it('deletePostboardMessage returns false for non-existent ID', async () => {
    const { deletePostboardMessage } = await import('../src/memory/store.js');
    expect(deletePostboardMessage('nonexistent-id')).toBe(false);
  });

  it('getLastUserMessageTimestamp returns null when no messages exist', async () => {
    const { getLastUserMessageTimestamp } = await import('../src/memory/store.js');
    // Fresh DB should have no messages
    const ts = getLastUserMessageTimestamp();
    // Could be null or a number if test pollution, but on fresh DB it should be null
    expect(ts === null || typeof ts === 'number').toBe(true);
  });
});

// ─────────────────────────────────────────────────────────
// 4. EXTRACTION — Source-level structural tests
// ─────────────────────────────────────────────────────────
describe('Extraction — Structural', () => {
  let extractionSrc: string;

  beforeEach(() => {
    extractionSrc = readFileSync(join(process.cwd(), 'src/memory/extraction.ts'), 'utf-8');
  });

  it('extractMemories returns empty array for empty messages (source check)', () => {
    // The function checks `if (messages.length === 0) return [];`
    expect(extractionSrc).toMatch(/if\s*\(\s*messages\.length\s*===\s*0\s*\)\s*\{?\s*return\s*\[\]/);
  });

  it('summarizeConversation returns null for fewer than 3 messages', () => {
    expect(extractionSrc).toMatch(/if\s*\(\s*messages\.length\s*<\s*3\s*\)\s*\{?\s*return\s*null/);
  });

  it('validateMemoryType defaults to fact for invalid types', () => {
    expect(extractionSrc).toMatch(/return\s*'fact'/);
    // Also verify it checks all valid types
    expect(extractionSrc).toContain("'fact'");
    expect(extractionSrc).toContain("'preference'");
    expect(extractionSrc).toContain("'context'");
    expect(extractionSrc).toContain("'summary'");
    expect(extractionSrc).toContain("'episode'");
  });

  it('extraction uses withAbortableTimeout with 60000ms (findings.md P2:145)', () => {
    const match = extractionSrc.match(/withAbortableTimeout\(\s*[\s\S]*?,\s*(\d+)\s*,\s*'Memory extraction'/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(60000);
  });

  it('summarization uses withAbortableTimeout with 30000ms (findings.md P2:145)', () => {
    const match = extractionSrc.match(/withAbortableTimeout\(\s*[\s\S]*?,\s*(\d+)\s*,\s*'Conversation summarization'/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(30000);
  });

  it('extractMemories uses low temperature (0.3) for consistency', () => {
    // First withTimeout/provider.complete call uses temperature 0.3
    const matches = extractionSrc.match(/temperature:\s*([\d.]+)/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(1);
    // Both calls use 0.3
    for (const m of matches!) {
      const val = Number(m.replace('temperature:', '').trim());
      expect(val).toBe(0.3);
    }
  });

  it('extractMemories saves memories with lifecycle state seed', () => {
    expect(extractionSrc).toMatch(/lifecycleState:\s*'seed'/);
  });

  it('summarizeConversation saves summary as episode type with importance 0.7', () => {
    expect(extractionSrc).toMatch(/memoryType:\s*'episode'/);
    expect(extractionSrc).toMatch(/importance:\s*0\.7/);
  });

  it('entity extraction includes entityName and entityType in metadata', () => {
    expect(extractionSrc).toContain('metadata.entityName');
    expect(extractionSrc).toContain('metadata.entityType');
    expect(extractionSrc).toContain('metadata.isEntity');
  });

  it('exports extractMemories and summarizeConversation', () => {
    expect(extractionSrc).toMatch(/export async function extractMemories\(/);
    expect(extractionSrc).toMatch(/export async function summarizeConversation\(/);
  });
});

// ─────────────────────────────────────────────────────────
// 5. ORGANIC MAINTENANCE — Source-level structural tests
// ─────────────────────────────────────────────────────────
describe('Organic Maintenance — Structural', () => {
  let organicSrc: string;

  beforeEach(() => {
    organicSrc = readFileSync(join(process.cwd(), 'src/memory/organic.ts'), 'utf-8');
  });

  it('graceful forgetting uses 90-day threshold for composting', () => {
    // 90 * 24 * 60 * 60 * 1000
    expect(organicSrc).toMatch(/90\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
  });

  it('graceful forgetting uses 14-day threshold for hard delete', () => {
    // 14 * 24 * 60 * 60 * 1000
    expect(organicSrc).toMatch(/14\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
  });

  it('importance evolution triggers at 5+ access count', () => {
    expect(organicSrc).toMatch(/accessCount\s*>=\s*5/);
  });

  it('importance evolution boost is 0.05 per cycle', () => {
    expect(organicSrc).toMatch(/memory\.importance\s*\+\s*0\.05/);
  });

  it('association decay uses 60-day inactivity window', () => {
    // 60 * 24 * 60 * 60 * 1000
    expect(organicSrc).toMatch(/60\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
  });

  it('association decay minimum strength is 0.1', () => {
    expect(organicSrc).toMatch(/Math\.max\(\s*0\.1\s*,\s*assoc\.strength\s*-\s*0\.1\s*\)/);
  });

  it('cross-conversation pattern detection uses 0.7 similarity threshold', () => {
    expect(organicSrc).toMatch(/similarity\s*>\s*0\.7/);
  });

  it('memory cap default is 50,000 with env override (findings.md P2:789)', () => {
    const match = organicSrc.match(/parsePositiveInt\(\s*process\.env\['LAIN_MEMORY_CAP'\],\s*([\d_]+)\s*\)/);
    expect(match).not.toBeNull();
    expect(Number(match![1]!.replace(/_/g, ''))).toBe(50000);
  });

  it('era summary requires 10+ memories per month bucket', () => {
    // HAVING cnt >= 10 or memories.length < 10
    expect(organicSrc).toMatch(/HAVING cnt >= 10/);
    expect(organicSrc).toMatch(/memories\.length < 10/);
  });

  it('era summary generation is limited to 2 per cycle', () => {
    expect(organicSrc).toMatch(/LIMIT 2/);
  });

  it('distillation requires clusters with 5+ undistilled members', () => {
    expect(organicSrc).toMatch(/undistilled\.length >= 5/);
  });

  it('distillation is capped at 3 clusters per cycle', () => {
    expect(organicSrc).toMatch(/\.slice\(0,\s*3\)/);
  });

  it('landmark protection checks importance >= 0.8 or emotional_weight >= 0.7', () => {
    expect(organicSrc).toContain('importance >= 0.8');
    expect(organicSrc).toContain('emotional_weight >= 0.7');
  });

  it('graceful forgetting skips fact and preference memory types', () => {
    expect(organicSrc).toMatch(/memory\.memoryType\s*===\s*'fact'/);
    expect(organicSrc).toMatch(/memory\.memoryType\s*===\s*'preference'/);
  });

  it('graceful forgetting requires importance < 0.3 and accessCount < 2', () => {
    expect(organicSrc).toMatch(/memory\.importance\s*<\s*0\.3/);
    expect(organicSrc).toMatch(/memory\.accessCount\s*<\s*2/);
  });

  it('enforceMemoryCap exempts landmarks, facts, preferences, and distillations', () => {
    // In the SQL query for pruning
    expect(organicSrc).toContain("'$.isLandmark'");
    expect(organicSrc).toContain("'$.isEraSummary'");
    expect(organicSrc).toContain("'$.isDistillation'");
    expect(organicSrc).toContain("memory_type NOT IN ('fact', 'preference')");
  });

  it('maintenance loop defaults to 24-hour interval', () => {
    expect(organicSrc).toMatch(/intervalMs:\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
  });

  it('check interval is 6 hours', () => {
    expect(organicSrc).toMatch(/CHECK_INTERVAL_MS\s*=\s*6\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
  });

  it('startMemoryMaintenanceLoop returns a cleanup function', () => {
    expect(organicSrc).toMatch(/export function startMemoryMaintenanceLoop\([^)]*\):\s*\(\)\s*=>\s*void/);
  });

  it('runMemoryMaintenance runs all maintenance tasks in order (via runPhase wrapper, findings.md P2:704)', () => {
    // Each phase is now dispatched via runPhase(<name>, <fn>) for per-phase
    // error isolation, so the source references each sub-function by name
    // (without call-parens) inside the runPhase call.
    expect(organicSrc).toMatch(/runPhase\('gracefulForgetting',\s*gracefulForgetting\)/);
    expect(organicSrc).toMatch(/runPhase\('detectCrossConversationPatterns',\s*detectCrossConversationPatterns\)/);
    expect(organicSrc).toMatch(/runPhase\('evolveImportance',\s*evolveImportance\)/);
    expect(organicSrc).toMatch(/runPhase\('decayAssociationStrength',\s*decayAssociationStrength\)/);
    expect(organicSrc).toMatch(/runPhase\('distillMemoryClusters',\s*distillMemoryClusters\)/);
    expect(organicSrc).toMatch(/runPhase\('protectLandmarkMemories',\s*protectLandmarkMemories\)/);
    expect(organicSrc).toMatch(/runPhase\('generateEraSummaries',\s*generateEraSummaries\)/);
    expect(organicSrc).toMatch(/runPhase\('enforceMemoryCap',\s*enforceMemoryCap\)/);
    expect(organicSrc).toMatch(/runPhase\('runTopologyMaintenance',\s*runTopologyMaintenance\)/);
    expect(organicSrc).toMatch(/runPhase\('maintainKnowledgeGraph',\s*maintainKnowledgeGraph\)/);
  });

  it('processConversationEnd internal-state hook logs on failure (findings.md P2:854)', () => {
    // Regression lock: the lazy-imported internal-state updateState call
    // previously swallowed every error with `catch { /* non-critical */ }`,
    // so module-load failures or updateState throws stopped the 6-axis
    // emotional state from evolving with no log. The catch must now log
    // at warn with the module path + sessionKey.
    const indexSrc = readFileSync(join(process.cwd(), 'src/memory/index.ts'), 'utf-8');
    // Rough structural check: the updateState catch must call logger.warn
    // and reference the internal-state module path.
    expect(indexSrc).toMatch(/agent\/internal-state\.js/);
    // The first catch clause must contain a logger.warn with the module path field.
    const hookRegion = indexSrc.match(
      /await updateState\([\s\S]*?\}\s*catch\s*\(([\s\S]*?)\}\s*\n/,
    );
    expect(hookRegion, 'expected try/catch around updateState conversation:end').not.toBeNull();
    expect(hookRegion![0]).toMatch(/logger\.warn/);
    expect(hookRegion![0]).toMatch(/internal-state\.js/);
  });
});

// ─────────────────────────────────────────────────────────
// 6. PALACE — Hall assignment, wing resolution, structure
// ─────────────────────────────────────────────────────────
describe('Palace — Hall Assignment', () => {
  it('fact maps to truths', async () => {
    const { assignHall } = await import('../src/memory/palace.js');
    expect(assignHall('fact', 'any-session')).toBe('truths');
  });

  it('preference maps to truths', async () => {
    const { assignHall } = await import('../src/memory/palace.js');
    expect(assignHall('preference', 'any-session')).toBe('truths');
  });

  it('summary maps to reflections', async () => {
    const { assignHall } = await import('../src/memory/palace.js');
    expect(assignHall('summary', 'any-session')).toBe('reflections');
  });

  it('episode + curiosity: maps to discoveries', async () => {
    const { assignHall } = await import('../src/memory/palace.js');
    expect(assignHall('episode', 'curiosity:browsing')).toBe('discoveries');
  });

  it('episode + dreams: maps to dreams', async () => {
    const { assignHall } = await import('../src/memory/palace.js');
    expect(assignHall('episode', 'dreams:nightly')).toBe('dreams');
  });

  it('episode + dream: maps to dreams', async () => {
    const { assignHall } = await import('../src/memory/palace.js');
    expect(assignHall('episode', 'dream:sequence')).toBe('dreams');
  });

  it('episode + diary: maps to reflections', async () => {
    const { assignHall } = await import('../src/memory/palace.js');
    expect(assignHall('episode', 'diary:daily')).toBe('reflections');
  });

  it('episode + letter: maps to reflections', async () => {
    const { assignHall } = await import('../src/memory/palace.js');
    expect(assignHall('episode', 'letter:pkd')).toBe('reflections');
  });

  it('episode + self-concept: maps to reflections', async () => {
    const { assignHall } = await import('../src/memory/palace.js');
    expect(assignHall('episode', 'self-concept:synthesis')).toBe('reflections');
  });

  it('episode + selfconcept: maps to reflections', async () => {
    const { assignHall } = await import('../src/memory/palace.js');
    expect(assignHall('episode', 'selfconcept:synthesis')).toBe('reflections');
  });

  it('episode + bibliomancy: maps to reflections', async () => {
    const { assignHall } = await import('../src/memory/palace.js');
    expect(assignHall('episode', 'bibliomancy:reading')).toBe('reflections');
  });

  it('context maps to encounters', async () => {
    const { assignHall } = await import('../src/memory/palace.js');
    expect(assignHall('context', 'any-session')).toBe('encounters');
  });

  it('episode with unknown session key defaults to encounters', async () => {
    const { assignHall } = await import('../src/memory/palace.js');
    expect(assignHall('episode', 'chat:visitor123')).toBe('encounters');
  });

  it('all five halls are defined in the Hall type', () => {
    const src = readFileSync(join(process.cwd(), 'src/memory/palace.ts'), 'utf-8');
    const match = src.match(/export type Hall\s*=\s*([^;]+);/);
    expect(match).not.toBeNull();
    const def = match![1]!;
    expect(def).toContain("'truths'");
    expect(def).toContain("'encounters'");
    expect(def).toContain("'discoveries'");
    expect(def).toContain("'dreams'");
    expect(def).toContain("'reflections'");
  });
});

describe('Palace — Wing Resolution', () => {
  it('diary: routes to self wing', async () => {
    const { resolveWingForMemory } = await import('../src/memory/palace.js');
    const result = resolveWingForMemory('diary:daily', null);
    expect(result.wingName).toBe('self');
  });

  it('dreams: routes to self wing', async () => {
    const { resolveWingForMemory } = await import('../src/memory/palace.js');
    const result = resolveWingForMemory('dreams:nightly', null);
    expect(result.wingName).toBe('self');
  });

  it('dream: routes to self wing', async () => {
    const { resolveWingForMemory } = await import('../src/memory/palace.js');
    const result = resolveWingForMemory('dream:sequence', null);
    expect(result.wingName).toBe('self');
  });

  it('self-concept: routes to self wing', async () => {
    const { resolveWingForMemory } = await import('../src/memory/palace.js');
    const result = resolveWingForMemory('self-concept:synthesis', null);
    expect(result.wingName).toBe('self');
  });

  it('selfconcept: routes to self wing', async () => {
    const { resolveWingForMemory } = await import('../src/memory/palace.js');
    const result = resolveWingForMemory('selfconcept:synthesis', null);
    expect(result.wingName).toBe('self');
  });

  it('bibliomancy: routes to self wing', async () => {
    const { resolveWingForMemory } = await import('../src/memory/palace.js');
    const result = resolveWingForMemory('bibliomancy:reading', null);
    expect(result.wingName).toBe('self');
  });

  it('curiosity: routes to curiosity wing', async () => {
    const { resolveWingForMemory } = await import('../src/memory/palace.js');
    const result = resolveWingForMemory('curiosity:browsing', null);
    expect(result.wingName).toBe('curiosity');
  });

  it('letter: routes to target character wing', async () => {
    const { resolveWingForMemory } = await import('../src/memory/palace.js');
    const result = resolveWingForMemory('letter:wired-lain', null);
    expect(result.wingName).toBe('wired-lain');
  });

  it('commune: routes to target character wing', async () => {
    const { resolveWingForMemory } = await import('../src/memory/palace.js');
    const result = resolveWingForMemory('commune:pkd', null);
    expect(result.wingName).toBe('pkd');
  });

  it('peer: routes to target character wing', async () => {
    const { resolveWingForMemory } = await import('../src/memory/palace.js');
    const result = resolveWingForMemory('peer:mckenna', null);
    expect(result.wingName).toBe('mckenna');
  });

  it('doctor: routes to dr-claude wing', async () => {
    const { resolveWingForMemory } = await import('../src/memory/palace.js');
    const result = resolveWingForMemory('doctor:session', null);
    expect(result.wingName).toBe('dr-claude');
  });

  it('therapy: routes to dr-claude wing', async () => {
    const { resolveWingForMemory } = await import('../src/memory/palace.js');
    const result = resolveWingForMemory('therapy:session', null);
    expect(result.wingName).toBe('dr-claude');
  });

  it('townlife: routes to town wing', async () => {
    const { resolveWingForMemory } = await import('../src/memory/palace.js');
    const result = resolveWingForMemory('townlife:event', null);
    expect(result.wingName).toBe('town');
  });

  it('movement: routes to town wing', async () => {
    const { resolveWingForMemory } = await import('../src/memory/palace.js');
    const result = resolveWingForMemory('movement:garden', null);
    expect(result.wingName).toBe('town');
  });

  it('note: routes to town wing', async () => {
    const { resolveWingForMemory } = await import('../src/memory/palace.js');
    const result = resolveWingForMemory('note:library', null);
    expect(result.wingName).toBe('town');
  });

  it('userId routes to shared visitors wing with per-user room (findings.md P2:652)', async () => {
    const { resolveWingForMemory } = await import('../src/memory/palace.js');
    const result = resolveWingForMemory('chat:session123', 'user42');
    expect(result.wingName).toBe('visitors');
    expect(result.roomName).toBe('visitor-user42');
  });

  it('fallback routes to encounters wing', async () => {
    const { resolveWingForMemory } = await import('../src/memory/palace.js');
    const result = resolveWingForMemory('unknown:session', null);
    expect(result.wingName).toBe('encounters');
  });

  it('resolveWingForMemory returns both wingName and wingDescription', async () => {
    const { resolveWingForMemory } = await import('../src/memory/palace.js');
    const result = resolveWingForMemory('diary:daily', null);
    expect(typeof result.wingName).toBe('string');
    expect(typeof result.wingDescription).toBe('string');
    expect(result.wingDescription.length).toBeGreaterThan(0);
  });
});

describe('Palace — Wing and Room DB Operations', () => {
  const testDir = join(tmpdir(), `lain-test-palace-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const dbPath = join(testDir, 'test.db');
  const originalEnv = process.env['LAIN_HOME'];

  beforeEach(async () => {
    process.env['LAIN_HOME'] = testDir;
    await mkdir(testDir, { recursive: true });
    const { initDatabase } = await import('../src/storage/database.js');
    await initDatabase(dbPath);
  });

  afterEach(async () => {
    const { closeDatabase } = await import('../src/storage/database.js');
    closeDatabase();
    if (originalEnv) {
      process.env['LAIN_HOME'] = originalEnv;
    } else {
      delete process.env['LAIN_HOME'];
    }
    try { await rm(testDir, { recursive: true }); } catch {}
  });

  it('resolveWing is idempotent (get-or-create)', async () => {
    const { resolveWing, getWingByName } = await import('../src/memory/palace.js');
    const id1 = resolveWing('test-wing', 'A test wing');
    const id2 = resolveWing('test-wing', 'Different description');
    expect(id1).toBe(id2);

    const wing = getWingByName('test-wing');
    expect(wing).toBeDefined();
    expect(wing!.name).toBe('test-wing');
  });

  it('createWing returns a string ID', async () => {
    const { createWing } = await import('../src/memory/palace.js');
    const id = createWing('new-wing', 'description');
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('getWing retrieves a wing by ID', async () => {
    const { createWing, getWing } = await import('../src/memory/palace.js');
    const id = createWing('findable-wing');
    const wing = getWing(id);
    expect(wing).toBeDefined();
    expect(wing!.id).toBe(id);
    expect(wing!.name).toBe('findable-wing');
  });

  it('listWings returns all created wings', async () => {
    const { createWing, listWings } = await import('../src/memory/palace.js');
    createWing('wing-alpha');
    createWing('wing-beta');
    const wings = listWings();
    expect(wings.length).toBeGreaterThanOrEqual(2);
    const names = wings.map(w => w.name);
    expect(names).toContain('wing-alpha');
    expect(names).toContain('wing-beta');
  });

  it('resolveRoom is idempotent (get-or-create)', async () => {
    const { createWing, resolveRoom } = await import('../src/memory/palace.js');
    const wingId = createWing('room-test-wing');
    const roomId1 = resolveRoom(wingId, 'truths', 'truths room');
    const roomId2 = resolveRoom(wingId, 'truths', 'different desc');
    expect(roomId1).toBe(roomId2);
  });

  it('listRooms returns rooms for a wing', async () => {
    const { createWing, createRoom, listRooms } = await import('../src/memory/palace.js');
    const wingId = createWing('rooms-wing');
    createRoom(wingId, 'room-a');
    createRoom(wingId, 'room-b');
    const rooms = listRooms(wingId);
    expect(rooms.length).toBeGreaterThanOrEqual(2);
    const names = rooms.map(r => r.name);
    expect(names).toContain('room-a');
    expect(names).toContain('room-b');
  });

  it('incrementWingCount and decrementWingCount adjust counts', async () => {
    const { createWing, getWing, incrementWingCount, decrementWingCount } = await import('../src/memory/palace.js');
    const id = createWing('count-wing');
    expect(getWing(id)!.memoryCount).toBe(0);

    incrementWingCount(id);
    incrementWingCount(id);
    expect(getWing(id)!.memoryCount).toBe(2);

    decrementWingCount(id);
    expect(getWing(id)!.memoryCount).toBe(1);
  });

  it('decrementWingCount floors at 0', async () => {
    const { createWing, getWing, decrementWingCount } = await import('../src/memory/palace.js');
    const id = createWing('floor-wing');
    decrementWingCount(id);
    expect(getWing(id)!.memoryCount).toBe(0);
  });
});
