/**
 * Memory Palace migration — one-time script to assign palace placement
 * (wing_id, room_id, hall) to existing memories and populate the vec0 table.
 *
 * Safe to re-run: memories that already have a wing_id are skipped.
 */

import { query, execute, transaction } from '../storage/database.js';
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

/**
 * Per-row failure detail — written to migration-errors-<ts>.json by the runner
 * scripts when `errors > 0`. findings.md P2:2928: previously the only signal on
 * partial failure was exit code 1 and a scrape-able log line per row, which
 * made "which memory IDs failed" an operator guess.
 */
export interface MigrationError {
  id: string;
  reason: string;
}

export interface MigrationStats {
  total: number;
  migrated: number;
  skipped: number;
  errors: number;
  wings: number;
  rooms: number;
  vecInserted: number;
  errorDetails: MigrationError[];
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
  const errorDetails: MigrationError[] = [];

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

      // 2. Resolve wing. (resolveWing/resolveRoom are INSERT OR IGNORE +
      //    SELECT — safe to run outside the transaction below; they act
      //    as name-to-id resolution and are idempotent.)
      const { wingName, wingDescription, roomName, roomDescription } =
        resolveWingForMemory(sessionKey, row.user_id, metadata);
      const wingId = resolveWing(wingName, wingDescription);
      wingsSeen.add(wingId);

      // 3. Resolve room (using hall name as room name within the wing,
      //    unless the wing-resolver supplied an override — see
      //    findings.md P2:652 for the shared `visitors` wing case).
      const effectiveRoomName = roomName ?? hall;
      const effectiveRoomDescription = roomDescription ?? `${hall} room in wing ${wingName}`;
      const roomId = resolveRoom(wingId, effectiveRoomName, effectiveRoomDescription);
      roomsSeen.add(roomId);

      // 4–6. Atomic per-row mutations (findings.md P2:543). Before this
      // wrap, steps 4/5/6 ran as independent auto-commits; a crash
      // between them left the wing/room counters out of sync with the
      // actual rows (incrementWingCount without a corresponding
      // memories.wing_id UPDATE) or the vec0 index partially populated.
      // Re-running in that state would double-count on the next row.
      // With `transaction(() => { ... })` the whole set commits or
      // none of it does — re-run is cleanly idempotent against
      // `wing_id IS NOT NULL`.
      let rowVecInserted = false;
      let vecError: unknown = null;
      transaction(() => {
        // 4. UPDATE the memory row.
        execute(
          `UPDATE memories SET wing_id = ?, room_id = ?, hall = ? WHERE id = ?`,
          [wingId, roomId, hall, row.id],
        );

        // 5. Increment counts.
        incrementWingCount(wingId);
        incrementRoomCount(roomId);

        // 6. Insert embedding into vec0 table if present. vec0 insert
        //    failures are not fatal — the memory is still usable via
        //    sqlite fallback — so we note the error and commit the
        //    rest of the row. The palace assignment in particular
        //    (UPDATE + counters) is the load-bearing atomic unit.
        if (row.embedding !== null) {
          try {
            const embedding = deserializeEmbedding(row.embedding);
            vecRowId++;
            execute(
              `INSERT INTO memory_embeddings (rowid, embedding, memory_id) VALUES (?, ?, ?)`,
              [BigInt(vecRowId), embedding, row.id],
            );
            rowVecInserted = true;
          } catch (vecErr) {
            vecError = vecErr;
          }
        }
      });
      if (rowVecInserted) vecInserted++;
      if (vecError) logger.warn({ memoryId: row.id, error: vecError }, 'Failed to insert embedding into vec0 table');

      migrated++;
    } catch (err) {
      logger.error({ memoryId: row.id, error: err }, 'Error migrating memory to palace');
      errors++;
      errorDetails.push({ id: row.id, reason: err instanceof Error ? err.message : String(err) });
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
    errorDetails,
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
export function migrateAssociationsToKG(): { total: number; migrated: number; skipped: number; errors: number; errorDetails: MigrationError[] } {
  const logger = getLogger();

  const rows = query<AssociationMigrationRow>(
    `SELECT source_id, target_id, association_type, strength, created_at
     FROM memory_associations
     ORDER BY created_at ASC`,
  );

  let migrated = 0;
  let skipped = 0;
  let errors = 0;
  const errorDetails: MigrationError[] = [];

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
      errorDetails.push({
        id: `${row.source_id}→${row.target_id}`,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const stats = { total: rows.length, migrated, skipped, errors, errorDetails };
  logger.info({ total: stats.total, migrated, skipped, errors }, 'Association → KG migration complete');
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
