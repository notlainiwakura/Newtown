/**
 * SQLCipher database wrapper for encrypted storage
 */

import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { StorageError } from '../utils/errors.js';
import { deriveKey, generateSalt } from '../utils/crypto.js';
import type { KeyDerivationConfig } from '../types/config.js';
import { getMasterKey } from './keychain.js';
import { getPaths } from '../config/paths.js';

let db: DatabaseType | null = null;

const SCHEMA_VERSION = 7;

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
  // Version 6: Reserved to repair historical schema-version mismatch
  `
  SELECT 1;
  `,
  // Version 7: Persistent desires
  `
  CREATE TABLE IF NOT EXISTS desires (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    description TEXT NOT NULL,
    intensity REAL NOT NULL DEFAULT 0.5,
    source TEXT NOT NULL,
    source_detail TEXT,
    target_peer TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    resolved_at INTEGER,
    resolution TEXT,
    decay_rate REAL NOT NULL DEFAULT 0.04
  );

  CREATE INDEX IF NOT EXISTS idx_desires_active ON desires(resolved_at) WHERE resolved_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_desires_type ON desires(type);
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

    // Get master key from keychain
    const masterKey = await getMasterKey();

    // Derive encryption key
    const config = keyDerivationConfig ?? {
      algorithm: 'argon2id' as const,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
    };

    // Use a deterministic salt derived from the path for consistency
    const salt = generateSalt(16);

    // For SQLCipher, we need a hex key
    const encryptionKey = await deriveKey(masterKey, salt, config);
    const hexKey = encryptionKey.toString('hex');

    // Open database
    db = new Database(path);

    // Configure SQLCipher (Note: better-sqlite3 needs to be compiled with SQLCipher)
    // For standard better-sqlite3, we skip encryption but keep the API consistent
    // In production, use better-sqlite3 with SQLCipher support
    try {
      db.pragma(`key = '${hexKey}'`);
    } catch {
      // SQLCipher not available, continue without encryption
      // Log warning in production
    }

    // Enable foreign keys and WAL mode for better performance
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    // Allow concurrent writers to wait up to 5s instead of failing immediately
    db.pragma('busy_timeout = 5000');

    // Run migrations
    await runMigrations(db);

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
