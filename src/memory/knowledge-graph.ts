/**
 * Knowledge Graph — temporal triples, entities, and contradiction detection.
 *
 * Triples are fact statements of the form (subject, predicate, object) with
 * temporal validity windows (valid_from / ended). Entities are named nodes with
 * type metadata. Contradiction detection finds active triples that disagree on
 * the same (subject, predicate) pair.
 */

import { nanoid } from 'nanoid';
import { execute, query, queryOne } from '../storage/database.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface KGTriple {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  strength: number;
  validFrom: number;
  ended: number | null;
  sourceMemoryId: string | null;
  metadata: Record<string, unknown>;
}

export interface KGEntity {
  name: string;
  entityType: string;
  firstSeen: number;
  lastSeen: number;
  metadata: Record<string, unknown>;
}

export interface Contradiction {
  subject: string;
  predicate: string;
  tripleA: KGTriple;
  tripleB: KGTriple;
}

export interface TripleQuery {
  subject?: string;
  predicate?: string;
  object?: string;
  /** Temporal filter: return triples active at this epoch-ms timestamp */
  asOf?: number;
  limit?: number;
}

// ─── DB row shapes ─────────────────────────────────────────────────────────────

interface TripleRow {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  strength: number;
  valid_from: number;
  ended: number | null;
  source_memory_id: string | null;
  metadata: string;
}

interface EntityRow {
  name: string;
  entity_type: string;
  first_seen: number;
  last_seen: number;
  metadata: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function rowToTriple(r: TripleRow): KGTriple {
  return {
    id: r.id,
    subject: r.subject,
    predicate: r.predicate,
    object: r.object,
    strength: r.strength,
    validFrom: r.valid_from,
    ended: r.ended,
    sourceMemoryId: r.source_memory_id,
    metadata: JSON.parse(r.metadata) as Record<string, unknown>,
  };
}

function rowToEntity(r: EntityRow): KGEntity {
  return {
    name: r.name,
    entityType: r.entity_type,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    metadata: JSON.parse(r.metadata) as Record<string, unknown>,
  };
}

// ─── Triple CRUD ───────────────────────────────────────────────────────────────

/**
 * Add a triple to the knowledge graph and return its generated ID.
 */
export function addTriple(
  subject: string,
  predicate: string,
  object: string,
  strength = 1.0,
  validFrom?: number,
  ended?: number | null,
  sourceMemoryId?: string | null,
  metadata?: Record<string, unknown>,
): string {
  const id = nanoid(16);
  const now = Date.now();
  execute(
    `INSERT INTO kg_triples
       (id, subject, predicate, object, strength, valid_from, ended, source_memory_id, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      subject,
      predicate,
      object,
      strength,
      validFrom ?? now,
      ended ?? null,
      sourceMemoryId ?? null,
      JSON.stringify(metadata ?? {}),
    ],
  );
  return id;
}

/** Get a triple by ID. */
export function getTriple(id: string): KGTriple | undefined {
  const row = queryOne<TripleRow>('SELECT * FROM kg_triples WHERE id = ?', [id]);
  return row ? rowToTriple(row) : undefined;
}

/**
 * Invalidate (end) a triple by setting its `ended` timestamp.
 * Defaults to now if no timestamp is provided.
 */
export function invalidateTriple(id: string, endedAt?: number): void {
  execute('UPDATE kg_triples SET ended = ? WHERE id = ?', [endedAt ?? Date.now(), id]);
}

/**
 * Query triples with optional filters.
 * The `asOf` temporal filter returns only triples that were active at that time:
 *   valid_from <= asOf AND (ended IS NULL OR ended > asOf)
 */
export function queryTriples(q: TripleQuery): KGTriple[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (q.subject !== undefined) {
    conditions.push('subject = ?');
    params.push(q.subject);
  }
  if (q.predicate !== undefined) {
    conditions.push('predicate = ?');
    params.push(q.predicate);
  }
  if (q.object !== undefined) {
    conditions.push('object = ?');
    params.push(q.object);
  }
  if (q.asOf !== undefined) {
    conditions.push('valid_from <= ?');
    params.push(q.asOf);
    conditions.push('(ended IS NULL OR ended > ?)');
    params.push(q.asOf);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = q.limit !== undefined ? `LIMIT ${q.limit}` : '';

  const rows = query<TripleRow>(
    `SELECT * FROM kg_triples ${where} ORDER BY valid_from ASC ${limit}`,
    params,
  );
  return rows.map(rowToTriple);
}

/**
 * Get all triples where the entity appears as subject OR object,
 * ordered by valid_from ascending (oldest first).
 */
export function getEntityTimeline(entityName: string, limit?: number): KGTriple[] {
  const limitClause = limit !== undefined ? `LIMIT ${limit}` : '';
  const rows = query<TripleRow>(
    `SELECT * FROM kg_triples WHERE subject = ? OR object = ? ORDER BY valid_from ASC ${limitClause}`,
    [entityName, entityName],
  );
  return rows.map(rowToTriple);
}

// ─── Entity CRUD ───────────────────────────────────────────────────────────────

/**
 * Insert or update an entity. If the entity already exists, `last_seen` and
 * `metadata` are updated (upsert semantics).
 */
export function addEntity(
  name: string,
  entityType: string,
  firstSeen?: number,
  metadata?: Record<string, unknown>,
): void {
  const now = Date.now();
  const ts = firstSeen ?? now;
  execute(
    `INSERT INTO kg_entities (name, entity_type, first_seen, last_seen, metadata)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       last_seen = excluded.last_seen,
       metadata  = excluded.metadata`,
    [name, entityType, ts, ts, JSON.stringify(metadata ?? {})],
  );
}

/** Get an entity by name. */
export function getEntity(name: string): KGEntity | undefined {
  const row = queryOne<EntityRow>('SELECT * FROM kg_entities WHERE name = ?', [name]);
  return row ? rowToEntity(row) : undefined;
}

/** Update the `last_seen` timestamp for an entity. Defaults to now. */
export function updateEntityLastSeen(name: string, timestamp?: number): void {
  execute('UPDATE kg_entities SET last_seen = ? WHERE name = ?', [timestamp ?? Date.now(), name]);
}

/**
 * List entities, optionally filtered by type.
 * Ordered by last_seen descending (most recently active first).
 */
export function listEntities(entityType?: string, limit?: number): KGEntity[] {
  const limitClause = limit !== undefined ? `LIMIT ${limit}` : '';
  if (entityType !== undefined) {
    const rows = query<EntityRow>(
      `SELECT * FROM kg_entities WHERE entity_type = ? ORDER BY last_seen DESC ${limitClause}`,
      [entityType],
    );
    return rows.map(rowToEntity);
  }
  const rows = query<EntityRow>(
    `SELECT * FROM kg_entities ORDER BY last_seen DESC ${limitClause}`,
  );
  return rows.map(rowToEntity);
}

// ─── Contradiction detection ───────────────────────────────────────────────────

/**
 * Detect contradictions: active triples that share the same (subject, predicate)
 * but have different objects.
 *
 * Returns one Contradiction per conflicting pair. If a subject+predicate has
 * N conflicting objects, this returns N*(N-1)/2 pairs.
 */
export function detectContradictions(): Contradiction[] {
  // Find subject+predicate combos with multiple active triples having distinct objects
  interface ConflictRow {
    subject: string;
    predicate: string;
  }

  const conflicts = query<ConflictRow>(
    `SELECT subject, predicate
     FROM kg_triples
     WHERE ended IS NULL
     GROUP BY subject, predicate
     HAVING COUNT(DISTINCT object) > 1`,
  );

  const contradictions: Contradiction[] = [];

  for (const { subject, predicate } of conflicts) {
    const triples = query<TripleRow>(
      `SELECT * FROM kg_triples WHERE subject = ? AND predicate = ? AND ended IS NULL ORDER BY valid_from ASC`,
      [subject, predicate],
    );

    // Emit every unique pair
    for (let i = 0; i < triples.length; i++) {
      for (let j = i + 1; j < triples.length; j++) {
        const a = triples[i];
        const b = triples[j];
        if (a && b && a.object !== b.object) {
          contradictions.push({
            subject,
            predicate,
            tripleA: rowToTriple(a),
            tripleB: rowToTriple(b),
          });
        }
      }
    }
  }

  return contradictions;
}
