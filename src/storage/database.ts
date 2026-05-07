/**
 * SQLCipher database wrapper for encrypted storage
 */

import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { StorageError } from '../utils/errors.js';
import { deriveKey, generateSalt } from '../utils/crypto.js';
import type { KeyDerivationConfig } from '../types/config.js';
import { getMasterKey } from './keychain.js';
import { getPaths } from '../config/paths.js';
import { getLogger } from '../utils/logger.js';

let db: DatabaseType | null = null;

const SCHEMA_VERSION = 17;

const MIGRATIONS = [
  // Version 1: Initial schema
  `
  CREATE TABLE IF NOT EXISTS sessions (
    key TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    peer_kind TEXT NOT NULL,
    peer_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    token_count INTEGER DEFAULT 0,
    transcript_path TEXT,
    flags TEXT DEFAULT '{}'
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_channel ON sessions(channel, peer_id);

  CREATE TABLE IF NOT EXISTS credentials (
    key TEXT PRIMARY KEY,
    value BLOB NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // Version 2: Memory system tables
  `
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_key TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    metadata TEXT DEFAULT '{}'
  );

  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_key);
  CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);

  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    session_key TEXT,
    content TEXT NOT NULL,
    memory_type TEXT NOT NULL,
    importance REAL DEFAULT 0.5,
    embedding BLOB,
    created_at INTEGER NOT NULL,
    last_accessed INTEGER,
    access_count INTEGER DEFAULT 0,
    metadata TEXT DEFAULT '{}'
  );

  CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type);
  CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);
  CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_key);
  `,
  // Version 3: User-specific memories and relationships
  `
  ALTER TABLE messages ADD COLUMN user_id TEXT;
  ALTER TABLE memories ADD COLUMN user_id TEXT;
  ALTER TABLE memories ADD COLUMN related_to TEXT;
  ALTER TABLE memories ADD COLUMN source_message_id TEXT;

  CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);
  CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);
  CREATE INDEX IF NOT EXISTS idx_memories_related ON memories(related_to);
  `,
  // Version 4: Network-native memory (emotional weight, association network)
  `
  ALTER TABLE memories ADD COLUMN emotional_weight REAL DEFAULT 0;

  CREATE TABLE IF NOT EXISTS memory_associations (
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    association_type TEXT NOT NULL,
    strength REAL DEFAULT 0.5,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (source_id, target_id)
  );

  CREATE INDEX IF NOT EXISTS idx_assoc_source ON memory_associations(source_id);
  CREATE INDEX IF NOT EXISTS idx_assoc_target ON memory_associations(target_id);
  CREATE INDEX IF NOT EXISTS idx_assoc_type ON memory_associations(association_type);
  `,
  // Version 5: Memory topology — lifecycle states, coherence groups, causal links
  `
  ALTER TABLE memories ADD COLUMN lifecycle_state TEXT DEFAULT 'mature';
  ALTER TABLE memories ADD COLUMN lifecycle_changed_at INTEGER;
  ALTER TABLE memories ADD COLUMN phase TEXT;

  CREATE TABLE IF NOT EXISTS coherence_groups (
    id TEXT PRIMARY KEY,
    name TEXT,
    signature BLOB,
    member_count INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_reinforced_at INTEGER,
    phase TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_cg_phase ON coherence_groups(phase);

  CREATE TABLE IF NOT EXISTS coherence_memberships (
    memory_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (memory_id, group_id)
  );

  CREATE INDEX IF NOT EXISTS idx_cm_group ON coherence_memberships(group_id);
  CREATE INDEX IF NOT EXISTS idx_cm_memory ON coherence_memberships(memory_id);

  ALTER TABLE memory_associations ADD COLUMN causal_type TEXT;
  `,
  // Version 6: Postboard — direct line from the administrator to all inhabitants
  `
  CREATE TABLE IF NOT EXISTS postboard_messages (
    id TEXT PRIMARY KEY,
    author TEXT NOT NULL DEFAULT 'admin',
    content TEXT NOT NULL,
    pinned INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_postboard_created ON postboard_messages(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_postboard_pinned ON postboard_messages(pinned);
  `,
  // Version 7: Persistent objects / inventory system
  `
  CREATE TABLE IF NOT EXISTS objects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    creator_id TEXT NOT NULL,
    creator_name TEXT NOT NULL,
    owner_id TEXT,
    owner_name TEXT,
    location TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    metadata TEXT DEFAULT '{}'
  );

  CREATE INDEX IF NOT EXISTS idx_objects_owner ON objects(owner_id);
  CREATE INDEX IF NOT EXISTS idx_objects_location ON objects(location);
  `,
  // Version 8: Town events — admin-triggered events that affect all inhabitants
  `
  CREATE TABLE IF NOT EXISTS town_events (
    id TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    narrative INTEGER DEFAULT 0,
    mechanical INTEGER DEFAULT 0,
    instant INTEGER DEFAULT 0,
    persistent INTEGER DEFAULT 0,
    natural_event INTEGER DEFAULT 0,
    liminal INTEGER DEFAULT 0,
    effects TEXT DEFAULT '{}',
    status TEXT DEFAULT 'active',
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    ended_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_town_events_status ON town_events(status);
  CREATE INDEX IF NOT EXISTS idx_town_events_created ON town_events(created_at DESC);
  `,
  // Version 9: Building memory — spatial residue from conversations, arrivals, objects
  `
  CREATE TABLE IF NOT EXISTS building_events (
    id TEXT PRIMARY KEY,
    building TEXT NOT NULL,
    event_type TEXT NOT NULL,
    summary TEXT NOT NULL,
    emotional_tone REAL DEFAULT 0,
    actors TEXT DEFAULT '[]',
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_building_events_building ON building_events(building, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_building_events_created ON building_events(created_at DESC);
  `,
  // Version 10: Palace wings/rooms + knowledge graph tables
  `
  CREATE TABLE IF NOT EXISTS palace_wings (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    created_at INTEGER NOT NULL,
    memory_count INTEGER DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_palace_wings_name ON palace_wings(name);

  CREATE TABLE IF NOT EXISTS palace_rooms (
    id TEXT PRIMARY KEY,
    wing_id TEXT NOT NULL REFERENCES palace_wings(id),
    name TEXT NOT NULL,
    description TEXT,
    created_at INTEGER NOT NULL,
    memory_count INTEGER DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_palace_rooms_wing ON palace_rooms(wing_id);
  CREATE INDEX IF NOT EXISTS idx_palace_rooms_name ON palace_rooms(name);

  CREATE TABLE IF NOT EXISTS kg_triples (
    id TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    predicate TEXT NOT NULL,
    object TEXT NOT NULL,
    strength REAL DEFAULT 1.0,
    valid_from INTEGER NOT NULL,
    ended INTEGER,
    source_memory_id TEXT,
    metadata TEXT DEFAULT '{}'
  );

  CREATE INDEX IF NOT EXISTS idx_kg_subject ON kg_triples(subject);
  CREATE INDEX IF NOT EXISTS idx_kg_object ON kg_triples(object);
  CREATE INDEX IF NOT EXISTS idx_kg_predicate ON kg_triples(predicate);
  CREATE INDEX IF NOT EXISTS idx_kg_valid ON kg_triples(valid_from, ended);

  CREATE TABLE IF NOT EXISTS kg_entities (
    name TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    metadata TEXT DEFAULT '{}'
  );

  CREATE INDEX IF NOT EXISTS idx_kg_entities_type ON kg_entities(entity_type);
  `,
  // Version 11: Palace columns on memories + vec0 virtual table for embeddings
  `
  ALTER TABLE memories ADD COLUMN wing_id TEXT;
  ALTER TABLE memories ADD COLUMN room_id TEXT;
  ALTER TABLE memories ADD COLUMN hall TEXT;
  ALTER TABLE memories ADD COLUMN aaak_content TEXT;
  ALTER TABLE memories ADD COLUMN aaak_compressed_at INTEGER;

  CREATE INDEX IF NOT EXISTS idx_memories_wing ON memories(wing_id);
  CREATE INDEX IF NOT EXISTS idx_memories_room ON memories(room_id);
  CREATE INDEX IF NOT EXISTS idx_memories_hall ON memories(hall);

  CREATE VIRTUAL TABLE IF NOT EXISTS memory_embeddings USING vec0(embedding float[384] distance_metric=cosine, +memory_id text);
  `,
  // Version 12: Owner session nonces for per-device revocation
  // (findings.md P2:2348). Rows live on Wired Lain's DB; other servers
  // query via the interlink endpoint. `revoked_at IS NULL` means active;
  // a non-null value means the cookie carrying this nonce is rejected.
  `
  CREATE TABLE IF NOT EXISTS owner_nonces (
    nonce TEXT PRIMARY KEY,
    issued_at INTEGER NOT NULL,
    device_label TEXT,
    revoked_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_owner_nonces_revoked ON owner_nonces(revoked_at);
  `,
  // Version 13: Promote the lazy town_events.source migration into the real
  // migration path (findings.md P2:275). Previously `createTownEvent` and
  // `getActiveTownEvents` each ran `ALTER TABLE town_events ADD COLUMN source
  // TEXT` wrapped in a try/catch "column already exists" on every call. The
  // migration runner catches "duplicate column name" so this ALTER is a
  // no-op on DBs that already had the lazy migration applied.
  `
  ALTER TABLE town_events ADD COLUMN source TEXT;
  `,
  // Version 14: Covering index for the activity feed (findings.md P2:457).
  // `getActivity` issues
  //   SELECT ... FROM memories WHERE created_at BETWEEN ? AND ?
  //     AND (session_key LIKE ? OR ...22 times)
  //     ORDER BY created_at DESC LIMIT ?
  // every time the dashboard / commune map loads. Until now `memories` had
  // no index on `created_at`, so each call was a full scan + in-memory sort
  // across the whole table (~15k rows on production). Adding an index on
  // `created_at DESC` lets SQLite walk the time range in reverse, apply the
  // prefix filter in-flight, and stop at LIMIT. Messages already has
  // `idx_messages_timestamp`, which the planner uses in either direction.
  `
  CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at DESC);
  `,
  // Version 15: Embedding-model stamp (findings.md P2:517). Previously
  // every row in `memory_embeddings` was assumed to come from the
  // hard-coded `MODEL_NAME`. If the model were ever swapped, new vectors
  // would be commingled with old vectors in the same cosine space and
  // search quality would silently collapse — nothing in the code or
  // schema would flag it. This column records which model produced each
  // embedding so search-side code can exclude mismatched rows. Existing
  // rows stay NULL and are treated as "presumed current" until a
  // deliberate model swap triggers a backfill migration.
  `
  ALTER TABLE memories ADD COLUMN embedding_model TEXT;
  `,
  // Version 16: Object audit trail (findings.md P2:3364). Previously
  // `destroyObject` hard-deleted the row and `transferObject` overwrote
  // owner fields with no history. In a narrative simulation where objects
  // are meant to be story artifacts, their provenance evaporated the
  // moment they changed hands. This append-only ledger records every
  // create/pickup/drop/transfer/destroy so the town's physical history is
  // recoverable even after the underlying object row is gone.
  `
  CREATE TABLE IF NOT EXISTS object_events (
    id TEXT PRIMARY KEY,
    object_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    actor_name TEXT,
    subject_id TEXT,
    subject_name TEXT,
    location TEXT,
    metadata TEXT DEFAULT '{}',
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_object_events_object ON object_events(object_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_object_events_created ON object_events(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_object_events_type ON object_events(event_type);
  `,
  // Version 17: Ground object expiry. Loose character-created objects were
  // accumulating forever on the WALK map. Fixtures and held inventory remain
  // permanent; ground objects get a decay timestamp that the object store
  // prunes and hides from map queries.
  `
  ALTER TABLE objects ADD COLUMN expires_at INTEGER;

  UPDATE objects
     SET expires_at = created_at + 259200000
   WHERE owner_id IS NULL
     AND expires_at IS NULL
     AND (metadata IS NULL OR metadata NOT LIKE '%"fixture":true%');

  CREATE INDEX IF NOT EXISTS idx_objects_expires ON objects(expires_at);
  `,
];

/**
 * Initialize the database connection with encryption
 */
export async function initDatabase(
  dbPath?: string,
  keyDerivationConfig?: KeyDerivationConfig
): Promise<DatabaseType> {
  if (db) {
    return db;
  }

  const paths = getPaths();
  const path = dbPath ?? paths.database;

  try {
    // Ensure directory exists
    await mkdir(dirname(path), { recursive: true });

    // Get master key from keychain.
    // findings.md P2:383 — pass the DB path so a missing keychain
    // entry cannot silently orphan an existing encrypted DB.
    const masterKey = await getMasterKey(path);

    // Derive encryption key
    const config = keyDerivationConfig ?? {
      algorithm: 'argon2id' as const,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
    };

    // Persist salt alongside the DB so the derived SQLCipher key is stable
    // across restarts. Salts are not secrets — they only need to be unique
    // per derivation — so colocating with the DB is the correct primitive.
    const salt = await loadOrCreateSalt(path);

    // For SQLCipher, we need a hex key
    const encryptionKey = await deriveKey(masterKey, salt, config);
    const hexKey = encryptionKey.toString('hex');

    // Open database
    db = new Database(path);

    // Load sqlite-vec extension for vector similarity search
    sqliteVec.load(db);

    // Configure SQLCipher. Stock better-sqlite3 (no SQLCipher linkage) does
    // NOT throw on `PRAGMA key` — it silently ignores unknown pragmas and
    // leaves the DB plaintext. So a try/catch alone is insufficient; we must
    // probe `PRAGMA cipher_version` to verify SQLCipher is actually present.
    let pragmaError: unknown;
    try {
      db.pragma(`key = '${hexKey}'`);
    } catch (err) {
      pragmaError = err;
    }

    // cipher_version returns the SQLCipher version string when compiled in,
    // or undefined/empty on stock SQLite (unknown pragma → no-op).
    const cipherVersion = (() => {
      try {
        const rows = db.pragma('cipher_version') as Array<{ cipher_version?: string }>;
        const row = rows[0];
        return row?.cipher_version ?? null;
      } catch {
        return null;
      }
    })();
    const encryptionActive = !pragmaError && !!cipherVersion;

    if (!encryptionActive) {
      const logger = getLogger();
      const reason = pragmaError instanceof Error ? pragmaError.message : 'SQLCipher not linked into better-sqlite3';
      if (process.env.LAIN_REQUIRE_ENCRYPTION === '1') {
        // Close the connection before throwing so we don't leak an open
        // plaintext DB handle that held the derived-key state.
        try { db.close(); } catch { /* ignore */ }
        db = null;
        throw new StorageError(
          `Database encryption required (LAIN_REQUIRE_ENCRYPTION=1) but unavailable: ${reason}. ` +
          `Rebuild better-sqlite3 against SQLCipher (see https://github.com/WiseLibs/better-sqlite3/blob/master/docs/troubleshooting.md) ` +
          `or unset LAIN_REQUIRE_ENCRYPTION to run plaintext.`
        );
      }
      logger.warn(
        { path, reason, requireEncryption: false },
        'SQLCipher not active — database is running in PLAINTEXT. ' +
        'Set LAIN_REQUIRE_ENCRYPTION=1 to make this a hard failure.',
      );
    }

    // Enable foreign keys and WAL mode for better performance
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    // Allow concurrent writers to wait up to 5s instead of failing immediately
    db.pragma('busy_timeout = 5000');

    // Run migrations
    await runMigrations(db);

    // findings.md P2:370 — bridge between inline MIGRATIONS (bumped on
    // schema changes) and the one-off `migrateMemoriesToPalace` backfill
    // (`src/memory/migration.ts`, invoked by `dist/scripts/run-palace-
    // migration.js`). Nothing in the boot path enforces both have run
    // against a given DB, so a droplet upgraded with fresh code but no
    // backfill can carry schema version N with pre-palace memories that
    // `resolveWingForMemory` never places. We can't call the backfill
    // automatically (it needs a DB backup step), but we can make the gap
    // visible: count memories missing `wing_id` and warn loudly. After
    // the backfill runs the count drops to 0 and the warn goes silent.
    try {
      const row = db
        .prepare(
          'SELECT COUNT(*) AS unmigrated FROM memories WHERE wing_id IS NULL',
        )
        .get() as { unmigrated: number } | undefined;
      const unmigrated = row?.unmigrated ?? 0;
      if (unmigrated > 0) {
        getLogger().warn(
          { path, unmigrated },
          `Found ${unmigrated} pre-palace memories with no wing assignment. ` +
            'Run `LAIN_HOME=<dir> node dist/scripts/run-palace-migration.js` to backfill them — ' +
            'until then they are invisible to palace-scoped retrieval.',
        );
      }
    } catch {
      // Memory table may not exist yet on an impossibly fresh DB where
      // MIGRATIONS[1] hasn't landed (the try/catch keeps boot alive
      // rather than failing over a diagnostic).
    }

    return db;
  } catch (error) {
    if (error instanceof Error) {
      throw new StorageError(`Failed to initialize database: ${error.message}`, error);
    }
    throw error;
  }
}

/**
 * Get the database instance (must call initDatabase first)
 */
export function getDatabase(): DatabaseType {
  if (!db) {
    throw new StorageError('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

/**
 * Check if database is initialized
 */
export function isDatabaseInitialized(): boolean {
  return db !== null;
}

/**
 * Close the database connection
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Load the persistent salt for this database, creating it on first use.
 * Written to `${dbPath}.salt` as 32 hex chars. Atomic write via tmp+rename
 * so a crash mid-write can't leave a zero-byte file.
 */
async function loadOrCreateSalt(dbPath: string): Promise<Buffer> {
  const saltPath = `${dbPath}.salt`;
  try {
    const hex = (await readFile(saltPath, 'utf8')).trim();
    if (!/^[0-9a-f]{32}$/.test(hex)) {
      throw new StorageError(
        `Salt file ${saltPath} is malformed. Expected 32 hex chars, got ${hex.length}. ` +
          `Refusing to overwrite — delete the file manually only if the DB is fresh.`
      );
    }
    return Buffer.from(hex, 'hex');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
  }

  const salt = generateSalt(16);
  const tmpPath = `${saltPath}.tmp`;
  await writeFile(tmpPath, salt.toString('hex'), { encoding: 'utf8', mode: 0o600 });
  await rename(tmpPath, saltPath);
  return salt;
}

/**
 * Run database migrations
 */
async function runMigrations(database: DatabaseType): Promise<void> {
  // Get current version
  let currentVersion = 0;
  try {
    const row = database
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    if (row) {
      currentVersion = parseInt(row.value, 10);
    }
  } catch {
    // Table doesn't exist yet, that's fine
  }

  // Run pending migrations
  for (let i = currentVersion; i < MIGRATIONS.length; i++) {
    const migration = MIGRATIONS[i];
    if (migration) {
      // Run ALTER TABLEs individually (they don't support IF NOT EXISTS),
      // then run the rest as a batch.
      const lines = migration.split('\n');
      const alters: string[] = [];
      const rest: string[] = [];
      for (const line of lines) {
        if (line.trim().toUpperCase().startsWith('ALTER TABLE')) {
          alters.push(line.trim().replace(/;$/, ''));
        } else {
          rest.push(line);
        }
      }

      // Run ALTERs individually, skip duplicates
      for (const alter of alters) {
        try {
          database.exec(alter);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('duplicate column name')) continue;
          throw err;
        }
      }

      // Run remaining statements (CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS)
      const batchSql = rest.join('\n').trim();
      if (batchSql) {
        database.exec(batchSql);
      }
    }
  }

  // Update version
  database
    .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)")
    .run(SCHEMA_VERSION.toString());
}

/**
 * Execute a query with automatic error handling
 */
export function query<T>(sql: string, params?: unknown[]): T[] {
  const database = getDatabase();
  try {
    const stmt = database.prepare(sql);
    return (params ? stmt.all(...params) : stmt.all()) as T[];
  } catch (error) {
    if (error instanceof Error) {
      throw new StorageError(`Query failed: ${error.message}`, error);
    }
    throw error;
  }
}

/**
 * Execute a single row query
 */
export function queryOne<T>(sql: string, params?: unknown[]): T | undefined {
  const database = getDatabase();
  try {
    const stmt = database.prepare(sql);
    return (params ? stmt.get(...params) : stmt.get()) as T | undefined;
  } catch (error) {
    if (error instanceof Error) {
      throw new StorageError(`Query failed: ${error.message}`, error);
    }
    throw error;
  }
}

/**
 * Execute a write operation
 */
export function execute(
  sql: string,
  params?: unknown[]
): { changes: number; lastInsertRowid: number | bigint } {
  const database = getDatabase();
  try {
    const stmt = database.prepare(sql);
    return params ? stmt.run(...params) : stmt.run();
  } catch (error) {
    if (error instanceof Error) {
      throw new StorageError(`Execute failed: ${error.message}`, error);
    }
    throw error;
  }
}

/**
 * Run multiple statements in a transaction
 */
export function transaction<T>(fn: () => T): T {
  const database = getDatabase();
  return database.transaction(fn)();
}

/**
 * Get a value from the meta key-value store
 */
export function getMeta(key: string): string | null {
  const row = queryOne<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key]);
  return row?.value ?? null;
}

/**
 * Set a value in the meta key-value store
 */
export function setMeta(key: string, value: string): void {
  execute('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [key, value]);
}

/**
 * findings.md P2:1110 — atomically increment a JSON counter field on a
 * meta row, resetting the whole row when the period field changed.
 *
 * Semantics:
 *   - key absent:            insert `freshJson`
 *   - stored period matches: `counter += delta` in place
 *   - stored period differs: overwrite with `freshJson` (new period reset)
 *
 * Runs as a single SQLite statement so concurrent callers can't lose
 * increments between a naive read-modify-write pair.
 *
 * `freshJson` must encode `{ [periodField]: periodValue, [counterField]: delta }`.
 * Returns the stored JSON after the operation.
 */
export function atomicMetaIncrementCounter(params: {
  key: string;
  freshJson: string;
  periodField: string;
  periodValue: string;
  counterField: string;
  delta: number;
}): string {
  const database = getDatabase();
  try {
    const stmt = database.prepare(`
      INSERT INTO meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = CASE
        WHEN json_extract(value, ?) = ?
        THEN json_set(value, ?, COALESCE(json_extract(value, ?), 0) + ?)
        ELSE excluded.value
      END
      RETURNING value
    `);
    const periodPath = `$.${params.periodField}`;
    const counterPath = `$.${params.counterField}`;
    const row = stmt.get(
      params.key,
      params.freshJson,
      periodPath,
      params.periodValue,
      counterPath,
      counterPath,
      params.delta,
    ) as { value: string } | undefined;
    return row?.value ?? params.freshJson;
  } catch (error) {
    if (error instanceof Error) {
      throw new StorageError(`atomicMetaIncrementCounter failed: ${error.message}`, error);
    }
    throw error;
  }
}
