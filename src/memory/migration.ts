/**
 * Memory Palace migration — one-time script to assign palace placement
 * (wing_id, room_id, hall) to existing memories and populate the vec0 table.
 *
 * Safe to re-run: memories that already have a wing_id are skipped.
 */

import { query, execute } from '../storage/database.js';
import { deserializeEmbedding } from './embeddings.js';
import {
  assignHall,
  resolveWing,
  resolveRoom,
  resolveWingForMemory,
  incrementWingCount,
  incrementRoomCount,
} from './palace.js';
import { addTriple, queryTriples } from './knowledge-graph.js';
import { getLogger } from '../utils/logger.js';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface MigrationStats {
  total: number;
  migrated: number;
  skipped: number;
  errors: number;
  wings: number;
  rooms: number;
  vecInserted: number;
}

// ─── Internal row shape ────────────────────────────────────────────────────────

interface MemoryMigrationRow {
  id: string;
  session_key: string | null;
  user_id: string | null;
  content: string;
  memory_type: 'fact' | 'preference' | 'context' | 'summary' | 'episode';
  importance: number;
  embedding: Buffer | null;
  created_at: number;
  wing_id: string | null;
  metadata: string | null;
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Migrate all unmigrated memories to palace format.
 *
 * For each memory without a wing_id:
 *   1. Determine hall via assignHall()
 *   2. Resolve wing via resolveWingForMemory() + resolveWing()
 *   3. Resolve room within the wing using the hall as the room name
 *   4. UPDATE the memory row with wing_id, room_id, hall
 *   5. Increment wing and room counts
 *   6. If an embedding BLOB exists, insert into memory_embeddings vec0 table
 *
 * Returns migration statistics.
 */
export async function migrateMemoriesToPalace(): Promise<MigrationStats> {
  const logger = getLogger();

  const rows = query<MemoryMigrationRow>(
    `SELECT id, session_key, user_id, content, memory_type, importance,
            embedding, created_at, wing_id, metadata
     FROM memories
     ORDER BY created_at ASC`,
  );

  // Track unique wings and rooms created during this run.
  const wingsSeen = new Set<string>();
  const roomsSeen = new Set<string>();

  let migrated = 0;
  let skipped = 0;
  let errors = 0;
  let vecInserted = 0;

  // Determine starting rowid for vec0 inserts.
  const maxRowResult = query<{ max_rowid: number | null }>(
    `SELECT MAX(rowid) AS max_rowid FROM memory_embeddings`,
  );
  let vecRowId = Number(maxRowResult[0]?.max_rowid ?? 0);

  for (const row of rows) {
    // Skip already-migrated memories.
    if (row.wing_id !== null) {
      skipped++;
      continue;
    }

    try {
      const sessionKey = row.session_key ?? 'unknown';
      const memoryType = row.memory_type;

      // Parse metadata (may be null or invalid JSON — treat as empty object).
      let metadata: Record<string, unknown> = {};
      if (row.metadata) {
        try {
          metadata = JSON.parse(row.metadata) as Record<string, unknown>;
        } catch {
          // ignore parse errors
        }
      }

      // 1. Determine hall.
      const hall = assignHall(memoryType, sessionKey);

      // 2. Resolve wing.
      const { wingName, wingDescription } = resolveWingForMemory(
        sessionKey,
        row.user_id,
        metadata,
      );
      const wingId = resolveWing(wingName, wingDescription);
      wingsSeen.add(wingId);

      // 3. Resolve room (using hall name as room name within the wing).
      const roomId = resolveRoom(wingId, hall, `${hall} room in wing ${wingName}`);
      roomsSeen.add(roomId);

      // 4. UPDATE the memory row.
      execute(
        `UPDATE memories SET wing_id = ?, room_id = ?, hall = ? WHERE id = ?`,
        [wingId, roomId, hall, row.id],
      );

      // 5. Increment counts.
      incrementWingCount(wingId);
      incrementRoomCount(roomId);

      // 6. Insert embedding into vec0 table if present.
      if (row.embedding !== null) {
        try {
          const embedding = deserializeEmbedding(row.embedding);
          vecRowId++;
          execute(
            `INSERT INTO memory_embeddings (rowid, embedding, memory_id) VALUES (?, ?, ?)`,
            [BigInt(vecRowId), embedding, row.id],
          );
          vecInserted++;
        } catch (vecErr) {
          logger.warn({ memoryId: row.id, error: vecErr }, 'Failed to insert embedding into vec0 table');
        }
      }

      migrated++;
    } catch (err) {
      logger.error({ memoryId: row.id, error: err }, 'Error migrating memory to palace');
      errors++;
    }
  }

  const stats: MigrationStats = {
    total: rows.length,
    migrated,
    skipped,
    errors,
    wings: wingsSeen.size,
    rooms: roomsSeen.size,
    vecInserted,
  };

  logger.info(stats, 'Memory palace migration complete');

  return stats;
}

// ─── Association → Knowledge Graph migration ─────────────────────────────────

interface AssociationMigrationRow {
  source_id: string;
  target_id: string;
  association_type: string;
  strength: number;
  created_at: number;
}

/**
 * Type-map from association types to KG predicates.
 */
const ASSOC_TO_PREDICATE: Record<string, string> = {
  similar: 'similar_to',
  evolved_from: 'evolved_from',
  pattern: 'shares_pattern',
  cross_topic: 'cross_references',
  dream: 'dream_linked',
};

/**
 * Migrate existing memory_associations into kg_triples.
 *
 * For each association row:
 *   - Maps association_type to a KG predicate
 *   - Creates a triple (sourceId, predicate, targetId) with valid_from = association created_at
 *   - Skips duplicates (same subject + predicate + object)
 *
 * Safe to re-run: checks for existing triples before inserting.
 */
export function migrateAssociationsToKG(): { total: number; migrated: number; skipped: number; errors: number } {
  const logger = getLogger();

  const rows = query<AssociationMigrationRow>(
    `SELECT source_id, target_id, association_type, strength, created_at
     FROM memory_associations
     ORDER BY created_at ASC`,
  );

  let migrated = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of rows) {
    try {
      const predicate = ASSOC_TO_PREDICATE[row.association_type] ?? row.association_type;

      // Check for existing triple to avoid duplicates
      const existing = queryTriples({
        subject: row.source_id,
        predicate,
        object: row.target_id,
        limit: 1,
      });
      if (existing.length > 0) {
        skipped++;
        continue;
      }

      addTriple(
        row.source_id,
        predicate,
        row.target_id,
        row.strength,
        row.created_at,
        null,
        row.source_id,
        { migratedFrom: 'memory_associations', originalType: row.association_type },
      );
      migrated++;
    } catch (err) {
      logger.warn({ sourceId: row.source_id, targetId: row.target_id, error: err }, 'Failed to migrate association to KG');
      errors++;
    }
  }

  const stats = { total: rows.length, migrated, skipped, errors };
  logger.info(stats, 'Association → KG migration complete');
  return stats;
}

/**
 * Quick summary of migration progress — no side effects.
 */
export function getMigrationStats(): { total: number; migrated: number; unmigrated: number } {
  const rows = query<{ total: number; migrated: number }>(
    `SELECT
       COUNT(*) AS total,
       COUNT(wing_id) AS migrated
     FROM memories`,
  );

  const row = rows[0] ?? { total: 0, migrated: 0 };
  return {
    total: row.total,
    migrated: row.migrated,
    unmigrated: row.total - row.migrated,
  };
}
