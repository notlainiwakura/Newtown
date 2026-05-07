/**
 * Memory storage operations
 * Handles persistent storage and retrieval of memories
 */

import { nanoid } from 'nanoid';
import { execute, query, queryOne, transaction } from '../storage/database.js';
import { serializeEmbedding, deserializeEmbedding, generateEmbedding, cosineSimilarity, CURRENT_EMBEDDING_MODEL } from './embeddings.js';
import { getLogger } from '../utils/logger.js';
import { eventBus, parseEventType } from '../events/bus.js';
import { mirrorMemoryToChroma } from './chroma.js';

export type MemorySortBy = 'relevance' | 'recency' | 'importance' | 'access_count';
export type LifecycleState = 'seed' | 'growing' | 'mature' | 'complete' | 'composting' | 'archived';
export type CausalType = 'prerequisite' | 'tension' | 'completion' | 'reinforcement';

export interface Memory {
  id: string;
  sessionKey: string | null;
  userId: string | null;
  content: string;
  memoryType: 'fact' | 'preference' | 'context' | 'summary' | 'episode';
  importance: number;
  emotionalWeight: number;
  embedding: Float32Array | null;
  createdAt: number;
  lastAccessed: number | null;
  accessCount: number;
  relatedTo: string | null;
  sourceMessageId: string | null;
  metadata: Record<string, unknown>;
  lifecycleState: LifecycleState;
  lifecycleChangedAt: number | null;
  phase: string | null;
  wingId: string | null;
  roomId: string | null;
  hall: string | null;
  aaakContent: string | null;
  aaakCompressedAt: number | null;
  /**
   * findings.md P2:517 — identifier of the embedding model that produced
   * this row's `embedding`. NULL for rows written before the column was
   * added; new rows carry `CURRENT_EMBEDDING_MODEL`. Search code skips
   * rows whose stamp is non-NULL and differs from the current model to
   * avoid comparing cosines across incompatible vector spaces.
   */
  embeddingModel: string | null;
}

export interface Association {
  sourceId: string;
  targetId: string;
  associationType: 'similar' | 'evolved_from' | 'pattern' | 'cross_topic' | 'dream';
  strength: number;
  createdAt: number;
}

export interface CoherenceGroup {
  id: string;
  name: string | null;
  signature: Float32Array | null;
  memberCount: number;
  createdAt: number;
  lastReinforcedAt: number | null;
  phase: string | null;
}

export interface StoredMessage {
  id: string;
  sessionKey: string;
  userId: string | null;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  metadata: Record<string, unknown>;
}

interface MemoryRow {
  id: string;
  session_key: string | null;
  user_id: string | null;
  content: string;
  memory_type: string;
  importance: number;
  emotional_weight: number;
  embedding: Buffer | null;
  created_at: number;
  last_accessed: number | null;
  access_count: number;
  related_to: string | null;
  source_message_id: string | null;
  metadata: string;
  lifecycle_state: string | null;
  lifecycle_changed_at: number | null;
  phase: string | null;
  wing_id: string | null;
  room_id: string | null;
  hall: string | null;
  aaak_content: string | null;
  aaak_compressed_at: number | null;
  embedding_model: string | null;
}

interface CoherenceGroupRow {
  id: string;
  name: string | null;
  signature: Buffer | null;
  member_count: number;
  created_at: number;
  last_reinforced_at: number | null;
  phase: string | null;
}

interface AssociationRow {
  source_id: string;
  target_id: string;
  association_type: string;
  strength: number;
  created_at: number;
  causal_type: string | null;
}

interface MessageRow {
  id: string;
  session_key: string;
  user_id: string | null;
  role: string;
  content: string;
  timestamp: number;
  metadata: string;
}

/**
 * Save a message to the database
 */
export function saveMessage(message: Omit<StoredMessage, 'id'>): string {
  const id = nanoid(16);

  execute(
    `INSERT INTO messages (id, session_key, user_id, role, content, timestamp, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      message.sessionKey,
      message.userId,
      message.role,
      message.content,
      message.timestamp,
      JSON.stringify(message.metadata || {}),
    ]
  );

  eventBus.emitActivity({
    type: parseEventType(message.sessionKey),
    sessionKey: message.sessionKey,
    content: message.content,
    timestamp: message.timestamp,
  });

  return id;
}

/**
 * Get recent messages for a session
 */
export function getRecentMessages(sessionKey: string, limit = 50): StoredMessage[] {
  const rows = query<MessageRow>(
    `SELECT * FROM messages
     WHERE session_key = ?
     ORDER BY timestamp DESC, rowid DESC
     LIMIT ?`,
    [sessionKey, limit]
  );

  return rows.reverse().map(rowToMessage);
}

/**
 * Get all messages for a session
 */
export function getAllMessages(sessionKey: string): StoredMessage[] {
  const rows = query<MessageRow>(
    `SELECT * FROM messages 
     WHERE session_key = ? 
     ORDER BY timestamp ASC`,
    [sessionKey]
  );

  return rows.map(rowToMessage);
}

/**
 * Get messages across all sessions within a time range
 */
export function getMessagesByTimeRange(
  startTime: number,
  endTime: number,
  limit = 100
): StoredMessage[] {
  const rows = query<MessageRow>(
    `SELECT * FROM messages
     WHERE timestamp BETWEEN ? AND ?
     ORDER BY timestamp DESC
     LIMIT ?`,
    [startTime, endTime, limit]
  );

  return rows.map(rowToMessage);
}

/**
 * Get all recent messages across all sessions
 */
export function getAllRecentMessages(limit = 50): StoredMessage[] {
  const rows = query<MessageRow>(
    `SELECT * FROM messages
     ORDER BY timestamp DESC
     LIMIT ?`,
    [limit]
  );

  return rows.reverse().map(rowToMessage);
}

/**
 * Get recent messages from visitor/user sessions only.
 *
 * findings.md P2:393 — this function used to inline an 8-prefix exclude
 * list that disagreed with the 22-prefix `BACKGROUND_PREFIXES` constant
 * used by `getActivity`. The drift meant diary / dream / curiosity /
 * self-concept / narrative / bibliomancy / alien / therapy / movement /
 * note / document / gift / research / townlife / object messages
 * silently counted as "visitor" traffic. Single source of truth is now
 * `BACKGROUND_PREFIXES` below.
 *
 * findings.md P2:818 / P2:393-followup — the original filter only
 * matched the background prefix as the FIRST segment (`LIKE 'letter:%'`),
 * so char-namespaced variants like `lain:letter:sent` leaked through as
 * visitor messages. Context Layer 3a then labelled Lain's own letter
 * drafts as "a visitor said ...". The filter now excludes the prefix
 * wherever it appears as a *segment* — first (`prefix:%`), middle
 * (`%:prefix:%`), trailing (`%:prefix`), or exact match — so
 * `letter:sent`, `lain:letter:sent`, and `wired-lain:letter` are all
 * correctly classified as background traffic.
 */
export function getRecentVisitorMessages(limit = 50): StoredMessage[] {
  // For each background prefix we reject the session_key if the prefix
  // appears as first / middle / trailing segment, or exact match.
  // Four LIKE patterns per prefix, fine for a LIMIT-capped query.
  const excludeClauses = BACKGROUND_PREFIXES.map(
    () =>
      '(session_key NOT LIKE ? AND session_key NOT LIKE ? AND session_key NOT LIKE ? AND session_key <> ?)'
  ).join(' AND ');
  const excludeParams: string[] = [];
  for (const prefix of BACKGROUND_PREFIXES) {
    excludeParams.push(`${prefix}:%`); // first segment
    excludeParams.push(`%:${prefix}:%`); // middle segment
    excludeParams.push(`%:${prefix}`); // trailing segment
    excludeParams.push(prefix); // exact match
  }
  const rows = query<MessageRow>(
    `SELECT * FROM messages
     WHERE ${excludeClauses}
     ORDER BY timestamp DESC
     LIMIT ?`,
    [...excludeParams, limit]
  );

  return rows.reverse().map(rowToMessage);
}

/**
 * Save a memory with embedding
 */
export async function saveMemory(
  memory: Omit<Memory, 'id' | 'embedding' | 'createdAt' | 'lastAccessed' | 'accessCount' | 'lifecycleState' | 'lifecycleChangedAt' | 'phase' | 'wingId' | 'roomId' | 'hall' | 'aaakContent' | 'aaakCompressedAt' | 'embeddingModel'> & {
    lifecycleState?: LifecycleState;
    skipEmbedding?: boolean;
  }
): Promise<string> {
  const logger = getLogger();
  const id = nanoid(16);
  const now = Date.now();
  const lifecycleState = memory.lifecycleState ?? 'seed';

  // Generate embedding for the memory content
  let embeddingBuffer: Buffer | null = null;
  let embedding: Float32Array | null = null;
  if (!memory.skipEmbedding) {
    try {
      embedding = await generateEmbedding(memory.content);
      embeddingBuffer = serializeEmbedding(embedding);
    } catch (error) {
      logger.warn({ error }, 'Failed to generate embedding for memory');
    }
  }

  // Assign palace placement
  const { assignHall, resolveWingForMemory, resolveWing, resolveRoom, incrementWingCount, incrementRoomCount } = await import('./palace.js');
  const hall = assignHall(memory.memoryType, memory.sessionKey ?? '');
  const { wingName, wingDescription, roomName, roomDescription } =
    resolveWingForMemory(memory.sessionKey ?? '', memory.userId ?? null, memory.metadata || {});
  const wingId = resolveWing(wingName, wingDescription);
  // findings.md P2:652 — when the wing-resolver returned a roomName
  // override (currently only the shared `visitors` wing), use it so
  // per-user grouping happens at the lighter room level instead of
  // creating a new wing per visitor.
  const effectiveRoomName = roomName ?? hall;
  const effectiveRoomDescription = roomDescription ?? `${hall} in ${wingName}`;
  const roomId = resolveRoom(wingId, effectiveRoomName, effectiveRoomDescription);
  incrementWingCount(wingId);
  incrementRoomCount(roomId);

  // findings.md P2:381 — memories row and its vec0 embedding must commit
  // atomically. The prior code wrapped vec0 INSERT in a silent try/catch, so
  // a failure left the memory retrievable by id but invisible to any search
  // using the KNN path. Over time coverage degraded monotonically. Transaction
  // guarantees either both rows land or neither.
  transaction(() => {
    execute(
      `INSERT INTO memories (id, session_key, user_id, content, memory_type, importance, emotional_weight, embedding, created_at, related_to, source_message_id, metadata, lifecycle_state, lifecycle_changed_at, wing_id, room_id, hall, embedding_model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        memory.sessionKey,
        memory.userId,
        memory.content,
        memory.memoryType,
        memory.importance,
        memory.emotionalWeight ?? 0,
        embeddingBuffer,
        now,
        memory.relatedTo,
        memory.sourceMessageId,
        JSON.stringify(memory.metadata || {}),
        lifecycleState,
        now,
        wingId,
        roomId,
        hall,
        // findings.md P2:517 — stamp the generating model so future
        // searches can detect drift. NULL iff embedding generation failed,
        // since there's no stamp to compare and brute-force similarity
        // can't run on a missing vector anyway.
        embeddingBuffer ? CURRENT_EMBEDDING_MODEL : null,
      ]
    );

    if (embeddingBuffer) {
      const embedding = deserializeEmbedding(embeddingBuffer);
      const nextEmbeddingRow = queryOne<{ rowid: number | bigint | null }>(
        'SELECT COALESCE(MAX(rowid), 0) + 1 AS rowid FROM memory_embeddings'
      );
      execute(
        'INSERT INTO memory_embeddings(rowid, embedding, memory_id) VALUES (?, ?, ?)',
        [BigInt(nextEmbeddingRow?.rowid ?? 1), embedding, id]
      );
    }
  });

  try {
    await mirrorMemoryToChroma({
      id,
      characterId: process.env['LAIN_CHARACTER_ID'] || eventBus.characterId,
      sessionKey: memory.sessionKey,
      userId: memory.userId,
      content: memory.content,
      memoryType: memory.memoryType,
      importance: memory.importance,
      emotionalWeight: memory.emotionalWeight ?? 0,
      embedding,
      createdAt: now,
      relatedTo: memory.relatedTo,
      sourceMessageId: memory.sourceMessageId,
      metadata: memory.metadata || {},
      lifecycleState,
      phase: null,
      wingId,
      roomId,
      hall,
    });
  } catch (error) {
    logger.warn({ error, memoryId: id }, 'Failed to mirror memory to Chroma');
  }

  eventBus.emitActivity({
    type: parseEventType(memory.sessionKey),
    sessionKey: memory.sessionKey ?? 'unknown',
    content: memory.content,
    timestamp: now,
  });

  return id;
}

/**
 * Get all memories (for similarity search + maintenance sweeps).
 *
 * findings.md P2:423 — was hard-capped at 2000 rows ordered by
 * importance DESC. With 15k production memories the bottom 87% of the
 * corpus was invisible to every consumer: `gracefulForgetting`
 * couldn't prune low-importance old memories (the whole point),
 * `evolveImportance` and `detectCrossConversationPatterns` sampled
 * only the top, and the `searchMemories` brute-force fallback missed
 * recent-but-low-importance retrievals. Default is now unbounded; the
 * optional `limit` parameter lets a caller opt into a bounded window
 * when they genuinely want top-N by importance (e.g. a UI preview).
 */
export function getAllMemories(limit?: number): Memory[] {
  if (limit !== undefined) {
    const rows = query<MemoryRow>(
      `SELECT * FROM memories ORDER BY importance DESC LIMIT ?`,
      [limit],
    );
    return rows.map(rowToMemory);
  }
  const rows = query<MemoryRow>(`SELECT * FROM memories ORDER BY importance DESC`);
  return rows.map(rowToMemory);
}

/**
 * Get memories by type
 */
export function getMemoriesByType(memoryType: Memory['memoryType']): Memory[] {
  const rows = query<MemoryRow>(
    `SELECT * FROM memories WHERE memory_type = ? ORDER BY importance DESC`,
    [memoryType]
  );
  return rows.map(rowToMemory);
}

/**
 * Calculate effective importance with access-based boosting
 * Memories accessed more frequently become stronger
 */
function calculateEffectiveImportance(memory: Memory): number {
  const baseImportance = memory.importance;
  // Stronger reinforcement: each access makes the memory stickier
  const accessBoost = Math.min(memory.accessCount * 0.04, 0.4);

  // Wider recency window: memories accessed in the last 72h get a boost
  let recencyBoost = 0;
  if (memory.lastAccessed) {
    const hoursSinceAccess = (Date.now() - memory.lastAccessed) / (1000 * 60 * 60);
    if (hoursSinceAccess < 72) {
      recencyBoost = 0.15 * (1 - hoursSinceAccess / 72);
    }
  }

  return Math.min(baseImportance + accessBoost + recencyBoost, 1.0);
}

/**
 * Search memories by semantic similarity.
 * Uses SQLite-vec (vec0) KNN search when the index has entries;
 * falls back to brute-force cosine similarity when the index is empty.
 */
export async function searchMemories(
  queryText: string,
  limit = 10,
  minSimilarity = 0.3,
  userId?: string,
  options?: {
    sortBy?: MemorySortBy;
    memoryTypes?: Memory['memoryType'][];
    wingId?: string;
    hall?: string;
    // findings.md P2:465 — autonomous background loops (curiosity,
    // dreams, commune-loop, diary, self-concept, etc.) that sample
    // memories every N minutes pass skipAccessBoost=true so their
    // repeated retrievals don't act as "engagement signal" and peg-lock
    // a small cluster of frequently-sampled memories at importance 1.0
    // via updateMemoryAccess -> evolveImportance. Only real retrievals
    // tied to a user turn (processMessage context injection) leave it
    // undefined so genuine engagement still reinforces.
    skipAccessBoost?: boolean;
  }
): Promise<{ memory: Memory; similarity: number; effectiveScore: number }[]> {
  const logger = getLogger();
  const sortBy = options?.sortBy ?? 'relevance';

  // Generate embedding for query
  let queryEmbedding: Float32Array;
  try {
    queryEmbedding = await generateEmbedding(queryText);
  } catch (error) {
    logger.error({ error }, 'Failed to generate query embedding');
    return [];
  }

  // Check if vec0 index has entries
  const vecCountRow = queryOne<{ count: number }>('SELECT COUNT(*) as count FROM memory_embeddings');
  const vecCount = vecCountRow?.count ?? 0;

  const results: { memory: Memory; similarity: number; effectiveScore: number }[] = [];

  if (vecCount > 0) {
    // ── vec0 KNN path ──────────────────────────────────────────────────────────
    const k = Math.min(limit * 5, vecCount);
    let vecRows: Array<{ memory_id: string; distance: number }> = [];
    try {
      vecRows = query<{ memory_id: string; distance: number }>(
        'SELECT memory_id, distance FROM memory_embeddings WHERE embedding MATCH ? AND k = ?',
        [queryEmbedding, k]
      );
    } catch (error) {
      logger.warn({ error }, 'vec0 KNN search failed, falling back to brute-force');
    }

    for (const { memory_id, distance } of vecRows) {
      // Map cosine distance [0, 2] to similarity [1, -1]; clamp to [0, 1]
      const similarity = Math.max(0, 1 - distance);
      if (similarity < minSimilarity) continue;

      const memory = getMemory(memory_id);
      if (!memory) continue;
      // findings.md P2:755 — exclude both composting and archived memories
      // from retrieval. Era-summary-archived rows stay in the DB for the
      // summary itself to reference, but shouldn't compete with the summary
      // for retrieval slots.
      if (memory.lifecycleState === 'composting' || memory.lifecycleState === 'archived') continue;
      // findings.md P2:517 — skip rows stamped with a non-current embedding
      // model. NULL (legacy, pre-migration) is grandfathered in as "presumed
      // current"; only an explicit non-matching stamp is rejected.
      if (memory.embeddingModel && memory.embeddingModel !== CURRENT_EMBEDDING_MODEL) continue;
      if (userId && memory.userId !== userId && memory.userId !== null) continue;
      if (options?.memoryTypes && options.memoryTypes.length > 0 && !options.memoryTypes.includes(memory.memoryType)) continue;
      if (options?.wingId && memory.wingId !== options.wingId) continue;
      if (options?.hall && memory.hall !== options.hall) continue;

      const effectiveImportance = calculateEffectiveImportance(memory);
      const daysSinceCreated = (Date.now() - memory.createdAt) / (1000 * 60 * 60 * 24);
      const recencyFactor = Math.max(0.4, 1 - daysSinceCreated / 730);
      const emotionalRelevance = (memory.emotionalWeight ?? 0) * recencyFactor;
      let effectiveScore = similarity * 0.35 + effectiveImportance * 0.35 + emotionalRelevance * 0.30;
      if (memory.metadata?.distilledInto) effectiveScore -= 0.3;
      results.push({ memory, similarity, effectiveScore });
    }
  } else {
    // ── Brute-force fallback (pre-vec0 memories or empty index) ───────────────
    let memories = getAllMemories().filter(
      // findings.md P2:755 — brute-force fallback mirrors the KNN lifecycle filter.
      (m) => m.embedding !== null && m.lifecycleState !== 'composting' && m.lifecycleState !== 'archived'
    );

    if (userId) {
      memories = memories.filter((m) => m.userId === userId || m.userId === null);
    }
    if (options?.memoryTypes && options.memoryTypes.length > 0) {
      memories = memories.filter((m) => options.memoryTypes!.includes(m.memoryType));
    }
    if (options?.wingId) {
      memories = memories.filter((m) => m.wingId === options.wingId);
    }
    if (options?.hall) {
      memories = memories.filter((m) => m.hall === options.hall);
    }

    for (const memory of memories) {
      if (!memory.embedding) continue;
      // findings.md P2:517 — mirror the KNN-path filter so brute-force
      // search can't silently include cross-model vectors either.
      if (memory.embeddingModel && memory.embeddingModel !== CURRENT_EMBEDDING_MODEL) continue;
      const similarity = cosineSimilarity(queryEmbedding, memory.embedding);
      if (similarity < minSimilarity) continue;
      const effectiveImportance = calculateEffectiveImportance(memory);
      const daysSinceCreated = (Date.now() - memory.createdAt) / (1000 * 60 * 60 * 24);
      const recencyFactor = Math.max(0.4, 1 - daysSinceCreated / 730);
      const emotionalRelevance = (memory.emotionalWeight ?? 0) * recencyFactor;
      let effectiveScore = similarity * 0.35 + effectiveImportance * 0.35 + emotionalRelevance * 0.30;
      if (memory.metadata?.distilledInto) effectiveScore -= 0.3;
      results.push({ memory, similarity, effectiveScore });
    }
  }

  // Sort based on chosen strategy
  switch (sortBy) {
    case 'recency':
      results.sort((a, b) => b.memory.createdAt - a.memory.createdAt);
      break;
    case 'importance':
      results.sort((a, b) => calculateEffectiveImportance(b.memory) - calculateEffectiveImportance(a.memory));
      break;
    case 'access_count':
      results.sort((a, b) => b.memory.accessCount - a.memory.accessCount);
      break;
    case 'relevance':
    default:
      results.sort((a, b) => b.effectiveScore - a.effectiveScore);
      break;
  }

  // Update access counts for retrieved memories (unless the caller asked to
  // skip — see findings.md P2:465 note above on skipAccessBoost).
  const topResults = results.slice(0, limit);
  if (!options?.skipAccessBoost) {
    for (const { memory } of topResults) {
      updateMemoryAccess(memory.id);
    }
  }

  return topResults;
}

/**
 * Get memories for a specific user
 */
export function getMemoriesForUser(userId: string, limit = 50): Memory[] {
  const rows = query<MemoryRow>(
    `SELECT * FROM memories
     WHERE user_id = ? OR user_id IS NULL
     ORDER BY importance DESC, access_count DESC
     LIMIT ?`,
    [userId, limit]
  );
  return rows.map(rowToMemory);
}

/**
 * Get messages for a specific user
 */
export function getMessagesForUser(userId: string, limit = 50): StoredMessage[] {
  const rows = query<MessageRow>(
    `SELECT * FROM messages
     WHERE user_id = ?
     ORDER BY timestamp DESC
     LIMIT ?`,
    [userId, limit]
  );
  return rows.reverse().map(rowToMessage);
}

/**
 * Link two memories together (creates a relationship)
 */
export function linkMemories(memoryId: string, relatedToId: string): void {
  execute(
    `UPDATE memories SET related_to = ? WHERE id = ?`,
    [relatedToId, memoryId]
  );
}

/**
 * Get memories related to a specific memory
 */
export function getRelatedMemories(memoryId: string): Memory[] {
  const rows = query<MemoryRow>(
    `SELECT * FROM memories
     WHERE related_to = ? OR id = (SELECT related_to FROM memories WHERE id = ?)
     ORDER BY importance DESC`,
    [memoryId, memoryId]
  );
  return rows.map(rowToMemory);
}

/**
 * Find and link similar memories automatically
 */
export async function consolidateMemories(userId?: string): Promise<number> {
  const logger = getLogger();
  let linkedCount = 0;

  const memories = userId ? getMemoriesForUser(userId, 200) : getAllMemories();
  const memoriesWithEmbeddings = memories.filter(m => m.embedding !== null && !m.relatedTo).slice(0, 200);

  for (let i = 0; i < memoriesWithEmbeddings.length; i++) {
    const memory = memoriesWithEmbeddings[i];
    if (!memory || !memory.embedding) continue;

    for (let j = i + 1; j < memoriesWithEmbeddings.length; j++) {
      const other = memoriesWithEmbeddings[j];
      if (!other || !other.embedding || other.relatedTo) continue;

      const similarity = cosineSimilarity(memory.embedding, other.embedding);

      // If very similar (>0.85), link them together
      if (similarity > 0.85) {
        // Link the less important one to the more important one
        if (memory.importance >= other.importance) {
          linkMemories(other.id, memory.id);
        } else {
          linkMemories(memory.id, other.id);
        }
        // Also create an association entry
        addAssociation(memory.id, other.id, 'similar', similarity);
        linkedCount++;
        logger.debug({ memory1: memory.id, memory2: other.id, similarity }, 'Linked similar memories');
      }
    }
  }

  return linkedCount;
}

/**
 * Update memory access timestamp and count
 */
export function updateMemoryAccess(memoryId: string): void {
  const now = Date.now();
  execute(
    `UPDATE memories
     SET last_accessed = ?, access_count = access_count + 1
     WHERE id = ?`,
    [now, memoryId]
  );
  // Reinforce coherence groups this memory belongs to
  reinforceGroups(memoryId, now);
}

/**
 * Update memory importance
 */
export function updateMemoryImportance(memoryId: string, importance: number): void {
  execute(`UPDATE memories SET importance = ? WHERE id = ?`, [importance, memoryId]);
}

/**
 * Delete a memory
 */
export function deleteMemory(memoryId: string): boolean {
  return transaction(() => {
    execute(`DELETE FROM coherence_memberships WHERE memory_id = ?`, [memoryId]);
    // findings.md P2:381 — the vec0 row was previously orphaned on delete.
    // KNN search returned the ghost memory_id, getMemory() returned undefined,
    // and the result was silently skipped — KNN slots wasted on ghosts,
    // search quality degraded. Delete the vec0 row inside the same tx.
    execute(`DELETE FROM memory_embeddings WHERE memory_id = ?`, [memoryId]);
    // findings.md P2:445 — associations were left dangling on memory delete.
    // getAssociations returned ghost rows; getAssociatedMemories silently
    // skipped them after getMemory() returned undefined. The table grew
    // unbounded. Cascade inside the same transaction on both sides of the
    // edge (source_id OR target_id).
    execute(`DELETE FROM memory_associations WHERE source_id = ? OR target_id = ?`, [
      memoryId,
      memoryId,
    ]);
    const result = execute(`DELETE FROM memories WHERE id = ?`, [memoryId]);
    return result.changes > 0;
  });
}

/**
 * Get memory by ID
 */
export function getMemory(memoryId: string): Memory | undefined {
  const row = queryOne<MemoryRow>(`SELECT * FROM memories WHERE id = ?`, [memoryId]);
  return row ? rowToMemory(row) : undefined;
}

/**
 * Get entity memories (memories with isEntity metadata)
 */
export function getEntityMemories(limit = 8): Memory[] {
  const rows = query<MemoryRow>(
    `SELECT * FROM memories
     WHERE json_extract(metadata, '$.isEntity') = 1
     ORDER BY importance DESC, access_count DESC
     LIMIT ?`,
    [limit]
  );
  return rows.map(rowToMemory);
}

/**
 * Count total memories
 */
export function countMemories(): number {
  const result = queryOne<{ count: number }>(`SELECT COUNT(*) as count FROM memories`);
  return result?.count ?? 0;
}

/**
 * Count messages
 */
export function countMessages(): number {
  const result = queryOne<{ count: number }>(`SELECT COUNT(*) as count FROM messages`);
  return result?.count ?? 0;
}

/**
 * Get the timestamp of the most recent user message
 */
export function getLastUserMessageTimestamp(): number | null {
  const row = queryOne<{ timestamp: number }>(
    `SELECT timestamp FROM messages WHERE role = 'user' ORDER BY timestamp DESC LIMIT 1`
  );
  return row?.timestamp ?? null;
}

// --- Association network operations ---

/**
 * Add an association between two memories
 */
export function addAssociation(
  sourceId: string,
  targetId: string,
  type: 'similar' | 'evolved_from' | 'pattern' | 'cross_topic' | 'dream',
  strength = 0.5,
  causalType?: CausalType
): void {
  execute(
    `INSERT OR REPLACE INTO memory_associations (source_id, target_id, association_type, strength, created_at, causal_type)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [sourceId, targetId, type, strength, Date.now(), causalType ?? null]
  );
}

/**
 * Get associations for a memory
 */
export function getAssociations(memoryId: string, limit = 20): Association[] {
  const rows = query<AssociationRow>(
    `SELECT * FROM memory_associations
     WHERE source_id = ? OR target_id = ?
     ORDER BY strength DESC
     LIMIT ?`,
    [memoryId, memoryId, limit]
  );
  return rows.map(rowToAssociation);
}

/**
 * Strengthen an existing association
 */
export function strengthenAssociation(sourceId: string, targetId: string, boost = 0.1): void {
  execute(
    `UPDATE memory_associations
     SET strength = MIN(1.0, strength + ?)
     WHERE source_id = ? AND target_id = ?`,
    [boost, sourceId, targetId]
  );
}

/**
 * Given a set of memory IDs (from direct search results),
 * find connected memories not already in the result set.
 * This is the "remembering one thing surfaces related things" mechanism.
 */
export function getAssociatedMemories(memoryIds: string[], limit = 2): Memory[] {
  if (memoryIds.length === 0) return [];

  const placeholders = memoryIds.map(() => '?').join(',');
  const idSet = new Set(memoryIds);

  // Find all associations connected to any of the input memory IDs
  const rows = query<AssociationRow>(
    `SELECT * FROM memory_associations
     WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})
     ORDER BY strength DESC`,
    [...memoryIds, ...memoryIds]
  );

  // Collect connected memory IDs not already in the result set
  const connectedIds = new Map<string, number>(); // id -> max strength
  for (const row of rows) {
    const otherId = idSet.has(row.source_id) ? row.target_id : row.source_id;
    if (!idSet.has(otherId)) {
      const existing = connectedIds.get(otherId) ?? 0;
      if (row.strength > existing) {
        connectedIds.set(otherId, row.strength);
      }
    }
  }

  // Sort by strength and take top N
  const sortedIds = [...connectedIds.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id);

  // Fetch the actual memories
  const memories: Memory[] = [];
  for (const id of sortedIds) {
    const mem = getMemory(id);
    if (mem) memories.push(mem);
  }

  return memories;
}

/**
 * Get a "resonance" memory — something forgotten or surprising to surface.
 * Three strategies rotate hourly: emotional, anniversary, random.
 * Does NOT update lastAccessed so resonance memories stay "forgotten".
 */
export function getResonanceMemory(userId?: string): Memory | null {
  const strategy = Math.floor(Date.now() / 3600000) % 3;

  const userFilter = userId
    ? ' AND (user_id = ? OR user_id IS NULL)'
    : '';
  const userParams = userId ? [userId] : [];

  // Strategy 0: Emotional — any emotional weight, not accessed in 3+ days
  if (strategy === 0) {
    const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
    const rows = query<MemoryRow>(
      `SELECT * FROM memories
       WHERE emotional_weight >= 0.3
         AND (last_accessed IS NULL OR last_accessed < ?)
         ${userFilter}
       ORDER BY emotional_weight DESC
       LIMIT 10`,
      [threeDaysAgo, ...userParams]
    );
    if (rows.length > 0) {
      const pick = rows[Math.floor(Math.random() * rows.length)];
      if (pick) return rowToMemory(pick);
    }
  }

  // Strategy 1: Anniversary — same day-of-week, 1+ weeks old, importance >= 0.2
  if (strategy === 1) {
    const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const currentDow = new Date().getDay();
    const rows = query<MemoryRow>(
      `SELECT * FROM memories
       WHERE created_at < ?
         AND importance >= 0.2
         ${userFilter}
       ORDER BY importance DESC
       LIMIT 50`,
      [oneWeekAgo, ...userParams]
    );
    const sameDow = rows.filter((r) => new Date(r.created_at).getDay() === currentDow);
    const candidates = sameDow.length > 0 ? sameDow.slice(0, 10) : [];
    if (candidates.length > 0) {
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      if (pick) return rowToMemory(pick);
    }
  }

  // Strategy 2 (or fallback): Random memory with importance >= 0.2
  const rows = query<MemoryRow>(
    `SELECT * FROM memories
     WHERE importance >= 0.2
       ${userFilter}
     ORDER BY RANDOM()
     LIMIT 1`,
    [...userParams]
  );
  if (rows.length > 0 && rows[0]) {
    return rowToMemory(rows[0]);
  }

  return null;
}

// --- Activity feed (unified view of memories + messages) ---

export interface ActivityEntry {
  id: string;
  kind: 'memory' | 'message';
  sessionKey: string;
  content: string;
  timestamp: number;
  metadata: Record<string, unknown>;
}

export interface GetActivityOptions {
  includeVisitorChat?: boolean;
  chatPrefixes?: string[];
}

// Session key prefixes for autonomous background loops (not user chat).
// Exported so memory/index.ts's `extractUserId` can avoid hallucinating a
// userId out of background session keys (findings.md P2:787).
export const BACKGROUND_PREFIXES = [
  'diary', 'dream', 'commune', 'curiosity', 'self-concept', 'selfconcept',
  'narrative', 'letter', 'wired', 'bibliomancy', 'alien', 'peer',
  'therapy', 'proactive', 'doctor', 'movement', 'move', 'note', 'document', 'gift',
  'research', 'townlife', 'object',
];

/**
 * Prefixes that identify sessions originating from an external user.
 * findings.md P2:787 — only these shapes carry a userId as the second
 * segment. Everything else (background loops, peer/letter/commune, even
 * char-namespaced variants like `lain:letter:...`) returns null from
 * `extractUserId`.
 */
export const USER_SESSION_PREFIXES = ['web', 'telegram', 'user', 'chat', 'owner'];

const BACKGROUND_SQL_FILTER = BACKGROUND_PREFIXES.map(() => `session_key LIKE ?`).join(' OR ');
const BACKGROUND_SQL_PARAMS = BACKGROUND_PREFIXES.map((p) => `${p}:%`);

function buildVisitorChatFilter(prefixes: string[]): { filter: string; params: string[] } | null {
  const normalized = [...new Set(prefixes.filter((prefix) => prefix.trim().length > 0))];
  const clauses: string[] = [];
  const params: string[] = [];

  for (const prefix of normalized) {
    clauses.push('session_key LIKE ?');
    params.push(`${prefix}:%`);
  }

  clauses.push('session_key LIKE ?');
  params.push('stranger:%');

  if (clauses.length === 0) return null;
  return {
    filter: clauses.join(' OR '),
    params,
  };
}

/**
 * Get recent activity across both memories and messages tables.
 * Only returns background loop activity (diary, dreams, commune, etc.),
 * excluding user chat sessions.
 */
export function getActivity(from: number, to: number, limit = 500, options?: GetActivityOptions): ActivityEntry[] {
  const memories = query<MemoryRow>(
    `SELECT * FROM memories WHERE created_at BETWEEN ? AND ? AND (${BACKGROUND_SQL_FILTER}) ORDER BY created_at DESC LIMIT ?`,
    [from, to, ...BACKGROUND_SQL_PARAMS, limit]
  );

  const backgroundMessages = query<MessageRow>(
    `SELECT * FROM messages WHERE timestamp BETWEEN ? AND ? AND (${BACKGROUND_SQL_FILTER}) ORDER BY timestamp DESC LIMIT ?`,
    [from, to, ...BACKGROUND_SQL_PARAMS, limit]
  );

  const visitorChat = options?.includeVisitorChat
    ? buildVisitorChatFilter(options.chatPrefixes ?? ['web'])
    : null;

  const visitorMessages = visitorChat
    ? query<MessageRow>(
        `SELECT * FROM messages WHERE timestamp BETWEEN ? AND ? AND (${visitorChat.filter}) ORDER BY timestamp DESC LIMIT ?`,
        [from, to, ...visitorChat.params, limit]
      )
    : [];

  const entries: ActivityEntry[] = [];

  for (const row of memories) {
    entries.push({
      id: row.id,
      kind: 'memory',
      sessionKey: row.session_key ?? 'unknown',
      content: row.content,
      timestamp: row.created_at,
      metadata: {
        ...JSON.parse(row.metadata || '{}'),
        memoryType: row.memory_type,
        importance: row.importance,
      },
    });
  }

  for (const row of [...backgroundMessages, ...visitorMessages]) {
    entries.push({
      id: row.id,
      kind: 'message',
      sessionKey: row.session_key,
      content: row.content,
      timestamp: row.timestamp,
      metadata: {
        ...JSON.parse(row.metadata || '{}'),
        role: row.role,
      },
    });
  }

  entries.sort((a, b) => b.timestamp - a.timestamp);
  return entries.slice(0, limit);
}

// Helper functions
function safeParseJson(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function rowToMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    sessionKey: row.session_key,
    userId: row.user_id,
    content: row.content,
    memoryType: row.memory_type as Memory['memoryType'],
    importance: row.importance,
    emotionalWeight: row.emotional_weight ?? 0,
    embedding: row.embedding ? deserializeEmbedding(row.embedding) : null,
    createdAt: row.created_at,
    lastAccessed: row.last_accessed,
    accessCount: row.access_count,
    relatedTo: row.related_to,
    sourceMessageId: row.source_message_id,
    metadata: safeParseJson(row.metadata),
    lifecycleState: (row.lifecycle_state as LifecycleState) ?? 'mature',
    lifecycleChangedAt: row.lifecycle_changed_at ?? null,
    phase: row.phase ?? null,
    wingId: row.wing_id ?? null,
    roomId: row.room_id ?? null,
    hall: row.hall ?? null,
    aaakContent: row.aaak_content ?? null,
    aaakCompressedAt: row.aaak_compressed_at ?? null,
    embeddingModel: row.embedding_model ?? null,
  };
}

function rowToAssociation(row: AssociationRow): Association {
  return {
    sourceId: row.source_id,
    targetId: row.target_id,
    associationType: row.association_type as Association['associationType'],
    strength: row.strength,
    createdAt: row.created_at,
  };
}

function rowToMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    sessionKey: row.session_key,
    userId: row.user_id,
    role: row.role as 'user' | 'assistant',
    content: row.content,
    timestamp: row.timestamp,
    metadata: safeParseJson(row.metadata),
  };
}

function rowToCoherenceGroup(row: CoherenceGroupRow): CoherenceGroup {
  return {
    id: row.id,
    name: row.name,
    signature: row.signature ? deserializeEmbedding(row.signature) : null,
    memberCount: row.member_count,
    createdAt: row.created_at,
    lastReinforcedAt: row.last_reinforced_at,
    phase: row.phase,
  };
}

// --- Coherence group operations ---

export function createCoherenceGroup(name: string | null, signature: Float32Array | null, phase?: string): string {
  const id = nanoid(16);
  const now = Date.now();
  execute(
    `INSERT INTO coherence_groups (id, name, signature, member_count, created_at, last_reinforced_at, phase)
     VALUES (?, ?, ?, 0, ?, ?, ?)`,
    [id, name, signature ? serializeEmbedding(signature) : null, now, now, phase ?? null]
  );
  return id;
}

export function getCoherenceGroup(id: string): CoherenceGroup | undefined {
  const row = queryOne<CoherenceGroupRow>(`SELECT * FROM coherence_groups WHERE id = ?`, [id]);
  return row ? rowToCoherenceGroup(row) : undefined;
}

export function getAllCoherenceGroups(limit = 100): CoherenceGroup[] {
  const rows = query<CoherenceGroupRow>(
    `SELECT * FROM coherence_groups ORDER BY member_count DESC LIMIT ?`,
    [limit]
  );
  return rows.map(rowToCoherenceGroup);
}

export function updateGroupSignature(id: string, signature: Float32Array, memberCount: number): void {
  execute(
    `UPDATE coherence_groups SET signature = ?, member_count = ? WHERE id = ?`,
    [serializeEmbedding(signature), memberCount, id]
  );
}

export function deleteCoherenceGroup(id: string): void {
  transaction(() => {
    execute(`DELETE FROM coherence_memberships WHERE group_id = ?`, [id]);
    execute(`DELETE FROM coherence_groups WHERE id = ?`, [id]);
  });
}

export function addToCoherenceGroup(memoryId: string, groupId: string): void {
  transaction(() => {
    execute(
      `INSERT OR IGNORE INTO coherence_memberships (memory_id, group_id, joined_at) VALUES (?, ?, ?)`,
      [memoryId, groupId, Date.now()]
    );
    execute(
      `UPDATE coherence_groups SET member_count = (SELECT COUNT(*) FROM coherence_memberships WHERE group_id = ?) WHERE id = ?`,
      [groupId, groupId]
    );
  });
}

export function removeFromCoherenceGroup(memoryId: string, groupId: string): void {
  transaction(() => {
    execute(`DELETE FROM coherence_memberships WHERE memory_id = ? AND group_id = ?`, [memoryId, groupId]);
    execute(
      `UPDATE coherence_groups SET member_count = (SELECT COUNT(*) FROM coherence_memberships WHERE group_id = ?) WHERE id = ?`,
      [groupId, groupId]
    );
  });
}

export function getGroupsForMemory(memoryId: string): CoherenceGroup[] {
  const rows = query<CoherenceGroupRow>(
    `SELECT cg.* FROM coherence_groups cg
     JOIN coherence_memberships cm ON cm.group_id = cg.id
     WHERE cm.memory_id = ?`,
    [memoryId]
  );
  return rows.map(rowToCoherenceGroup);
}

export function getGroupMembers(groupId: string): string[] {
  const rows = query<{ memory_id: string }>(
    `SELECT memory_id FROM coherence_memberships WHERE group_id = ?`,
    [groupId]
  );
  return rows.map((r) => r.memory_id);
}

// --- Lifecycle operations ---

export function setLifecycleState(memoryId: string, state: LifecycleState): void {
  execute(
    `UPDATE memories SET lifecycle_state = ?, lifecycle_changed_at = ? WHERE id = ?`,
    [state, Date.now(), memoryId]
  );
}

export function getMemoriesByLifecycle(state: LifecycleState, limit = 200): Memory[] {
  const rows = query<MemoryRow>(
    `SELECT * FROM memories WHERE lifecycle_state = ? ORDER BY created_at DESC LIMIT ?`,
    [state, limit]
  );
  return rows.map(rowToMemory);
}

// --- Causal link operations ---

export function addCausalLink(
  sourceId: string,
  targetId: string,
  assocType: Association['associationType'],
  causalType: CausalType,
  strength = 0.5
): void {
  addAssociation(sourceId, targetId, assocType, strength, causalType);
}

export function getCausalLinks(memoryId: string, causalType?: CausalType): (Association & { causalType: CausalType | null })[] {
  const filter = causalType ? ' AND causal_type = ?' : '';
  const params = causalType ? [memoryId, memoryId, causalType] : [memoryId, memoryId];
  const rows = query<AssociationRow>(
    `SELECT * FROM memory_associations
     WHERE (source_id = ? OR target_id = ?) AND causal_type IS NOT NULL${filter}
     ORDER BY strength DESC`,
    params
  );
  return rows.map((row) => ({
    ...rowToAssociation(row),
    causalType: row.causal_type as CausalType | null,
  }));
}

// --- Structural role computation ---

export function computeStructuralRole(memoryId: string): 'foundational' | 'bridge' | 'ephemeral' {
  // Count associations
  const assocCount = queryOne<{ count: number }>(
    `SELECT COUNT(*) as count FROM memory_associations WHERE source_id = ? OR target_id = ?`,
    [memoryId, memoryId]
  )?.count ?? 0;

  // Count group memberships
  const groupCount = queryOne<{ count: number }>(
    `SELECT COUNT(*) as count FROM coherence_memberships WHERE memory_id = ?`,
    [memoryId]
  )?.count ?? 0;

  // Foundational: many connections (5+) or in multiple groups (2+)
  if (assocCount >= 5 || groupCount >= 2) return 'foundational';

  // Bridge: connects to memories in different groups
  if (groupCount >= 1 && assocCount >= 2) return 'bridge';

  // Ephemeral: few connections
  return 'ephemeral';
}

// --- Group reinforcement (called from updateMemoryAccess) ---

function reinforceGroups(memoryId: string, now: number): void {
  execute(
    `UPDATE coherence_groups SET last_reinforced_at = ?
     WHERE id IN (SELECT group_id FROM coherence_memberships WHERE memory_id = ?)`,
    [now, memoryId]
  );
}

// --- Building notes query (for note discovery across characters) ---

export interface BuildingNote {
  content: string;
  author: string;
  timestamp: number;
}

export function getNotesByBuilding(building: string, since?: number): BuildingNote[] {
  const sinceTs = since ?? Date.now() - 7 * 24 * 60 * 60 * 1000;
  const rows = query<MemoryRow>(
    `SELECT content, metadata, created_at FROM memories
     WHERE session_key LIKE 'note:%'
     AND json_extract(metadata, '$.building') = ?
     AND created_at > ?
     ORDER BY created_at DESC LIMIT 10`,
    [building, sinceTs]
  );
  return rows.map((row) => {
    const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) as Record<string, unknown> : {};
    return {
      content: row.content,
      author: (meta.author as string) || 'unknown',
      timestamp: row.created_at,
    };
  });
}

// --- Character documents query (for document discovery across characters) ---

export interface CharacterDocument {
  id: string;
  title: string;
  content: string;
  author: string;
  writtenAt: number;
}

export function getDocumentsByAuthor(authorId?: string, limit = 20): CharacterDocument[] {
  const since = Date.now() - 30 * 24 * 60 * 60 * 1000; // last 30 days
  let rows: MemoryRow[];
  if (authorId) {
    rows = query<MemoryRow>(
      `SELECT id, content, metadata, created_at FROM memories
       WHERE session_key LIKE 'document:%'
       AND json_extract(metadata, '$.author') = ?
       AND created_at > ?
       ORDER BY created_at DESC LIMIT ?`,
      [authorId, since, limit]
    );
  } else {
    rows = query<MemoryRow>(
      `SELECT id, content, metadata, created_at FROM memories
       WHERE session_key LIKE 'document:%'
       AND created_at > ?
       ORDER BY created_at DESC LIMIT ?`,
      [since, limit]
    );
  }
  return rows.map((row) => {
    const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) as Record<string, unknown> : {};
    const fullContent = row.content.replace(/^\[Document: "[^"]*"\]\n\n/, '');
    return {
      id: row.id,
      title: (meta.title as string) || 'Untitled',
      content: fullContent,
      author: (meta.author as string) || 'unknown',
      writtenAt: (meta.writtenAt as number) || row.created_at,
    };
  });
}

// --- Postboard operations (admin → all inhabitants direct line) ---

export interface PostboardMessage {
  id: string;
  author: string;
  content: string;
  pinned: boolean;
  createdAt: number;
}

interface PostboardRow {
  id: string;
  author: string;
  content: string;
  pinned: number;
  created_at: number;
}

function rowToPostboardMessage(row: PostboardRow): PostboardMessage {
  return {
    id: row.id,
    author: row.author,
    content: row.content,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
  };
}

export function savePostboardMessage(content: string, author = 'admin', pinned = false): string {
  const id = nanoid(16);
  execute(
    `INSERT INTO postboard_messages (id, author, content, pinned, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [id, author, content, pinned ? 1 : 0, Date.now()]
  );
  return id;
}

export function getPostboardMessages(since?: number, limit = 20): PostboardMessage[] {
  const sinceTs = since ?? 0;
  const rows = query<PostboardRow>(
    `SELECT * FROM postboard_messages
     WHERE created_at > ?
     ORDER BY pinned DESC, created_at DESC
     LIMIT ?`,
    [sinceTs, limit]
  );
  return rows.map(rowToPostboardMessage);
}

export function deletePostboardMessage(id: string): boolean {
  const result = execute(`DELETE FROM postboard_messages WHERE id = ?`, [id]);
  return result.changes > 0;
}

export function togglePostboardPin(id: string): boolean {
  const result = execute(
    `UPDATE postboard_messages SET pinned = CASE WHEN pinned = 1 THEN 0 ELSE 1 END WHERE id = ?`,
    [id]
  );
  return result.changes > 0;
}

// --- Unassigned memories query (for topology formation) ---

/**
 * findings.md P2:660 — sampling strategy for `getUnassignedMemories`.
 * The old default ('newest') only ever returned the top-N by created_at,
 * so any memory that failed to be assigned on its first topology cycle
 * was effectively invisible forever once N newer memories arrived. The
 * 'mixed' default now splits the budget ~50/50 between newest and
 * random, giving stragglers eventual coverage without losing freshness
 * on brand-new memories. Callers that genuinely want pure-newest or
 * pure-random behavior can pass the option explicitly.
 */
export type UnassignedSampleStrategy = 'newest' | 'random' | 'mixed';

export function getUnassignedMemories(
  lifecycleStates: LifecycleState[],
  limit = 200,
  strategy: UnassignedSampleStrategy = 'mixed',
): Memory[] {
  const placeholders = lifecycleStates.map(() => '?').join(',');
  const whereBody = `WHERE m.lifecycle_state IN (${placeholders})
       AND m.embedding IS NOT NULL
       AND m.id NOT IN (SELECT memory_id FROM coherence_memberships)`;

  if (strategy === 'newest') {
    const rows = query<MemoryRow>(
      `SELECT m.* FROM memories m
       ${whereBody}
       ORDER BY m.created_at DESC
       LIMIT ?`,
      [...lifecycleStates, limit]
    );
    return rows.map(rowToMemory);
  }

  if (strategy === 'random') {
    const rows = query<MemoryRow>(
      `SELECT m.* FROM memories m
       ${whereBody}
       ORDER BY RANDOM()
       LIMIT ?`,
      [...lifecycleStates, limit]
    );
    return rows.map(rowToMemory);
  }

  // 'mixed' — half the budget to newest, half to a random sample. De-dup
  // via a Map<id, Memory> because the two halves can overlap.
  const newestBudget = Math.max(1, Math.floor(limit / 2));
  const randomBudget = Math.max(1, limit - newestBudget);

  const newestRows = query<MemoryRow>(
    `SELECT m.* FROM memories m
     ${whereBody}
     ORDER BY m.created_at DESC
     LIMIT ?`,
    [...lifecycleStates, newestBudget]
  );
  const randomRows = query<MemoryRow>(
    `SELECT m.* FROM memories m
     ${whereBody}
     ORDER BY RANDOM()
     LIMIT ?`,
    [...lifecycleStates, randomBudget]
  );

  const merged = new Map<string, Memory>();
  for (const row of newestRows) {
    const memory = rowToMemory(row);
    merged.set(memory.id, memory);
  }
  for (const row of randomRows) {
    const memory = rowToMemory(row);
    merged.set(memory.id, memory);
  }
  return Array.from(merged.values());
}
