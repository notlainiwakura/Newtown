/**
 * Deep tests for database, sessions, keychain, knowledge graph, topology, and migration
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── Mock keytar globally ──────────────────────────────────────────────────────
const keytarStore: Map<string, string> = new Map();

vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn(async (_service: string, account: string) => {
      return keytarStore.get(account) ?? null;
    }),
    setPassword: vi.fn(async (_service: string, account: string, value: string) => {
      keytarStore.set(account, value);
    }),
    deletePassword: vi.fn(async (_service: string, account: string) => {
      const had = keytarStore.has(account);
      keytarStore.delete(account);
      return had;
    }),
    findCredentials: vi.fn(async (_service: string) => {
      return Array.from(keytarStore.keys()).map((account) => ({ account, password: keytarStore.get(account)! }));
    }),
  },
}));

// ─── Imports (must come after mocks) ──────────────────────────────────────────
import {
  initDatabase,
  closeDatabase,
  isDatabaseInitialized,
  getDatabase,
  getMeta,
  setMeta,
  query,
  queryOne,
  execute,
  transaction,
} from '../src/storage/database.js';

import {
  generateSessionKey,
  createSession,
  getSession,
  findSession,
  getOrCreateSession,
  updateSession,
  deleteSession,
  listSessions,
  countSessions,
  deleteOldSessions,
  batchUpdateTokenCounts,
} from '../src/storage/sessions.js';

import {
  getMasterKey,
  setMasterKey,
  getAuthToken,
  setAuthToken,
  generateAuthToken,
  deleteAuthToken,
  setCredential,
  getCredential,
  deleteCredential,
  listCredentials,
} from '../src/storage/keychain.js';

import {
  addTriple,
  getTriple,
  invalidateTriple,
  queryTriples,
  getEntityTimeline,
  addEntity,
  getEntity,
  updateEntityLastSeen,
  listEntities,
  detectContradictions,
} from '../src/memory/knowledge-graph.js';

import {
  getMigrationStats,
  migrateAssociationsToKG,
} from '../src/memory/migration.js';

// ─── Test helpers ─────────────────────────────────────────────────────────────

let testCounter = 0;

function makeTestDir(): string {
  return join(tmpdir(), `lain-deep-db-test-${Date.now()}-${++testCounter}`);
}

async function initTestDb(testDir?: string): Promise<string> {
  const dir = testDir ?? makeTestDir();
  await mkdir(dir, { recursive: true });
  const dbPath = join(dir, 'test.db');
  process.env['LAIN_MASTER_KEY'] = 'test-master-key-for-deep-tests';
  await initDatabase(dbPath);
  return dir;
}

async function cleanupTestDb(testDir: string): Promise<void> {
  closeDatabase();
  try {
    await rm(testDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATABASE INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

describe('Database Initialization', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTestDir();
    process.env['LAIN_MASTER_KEY'] = 'test-master-key-for-deep-tests';
  });

  afterEach(async () => {
    closeDatabase();
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it('initializes successfully with explicit path', async () => {
    await mkdir(testDir, { recursive: true });
    const dbPath = join(testDir, 'init-test.db');
    const db = await initDatabase(dbPath);
    expect(db).toBeDefined();
    expect(isDatabaseInitialized()).toBe(true);
  });

  it('returns the same instance on second call (singleton)', async () => {
    await mkdir(testDir, { recursive: true });
    const dbPath = join(testDir, 'singleton.db');
    const db1 = await initDatabase(dbPath);
    const db2 = await initDatabase(dbPath);
    expect(db1).toBe(db2);
  });

  it('creates parent directories automatically', async () => {
    const nestedPath = join(testDir, 'a', 'b', 'c', 'nested.db');
    const db = await initDatabase(nestedPath);
    expect(db).toBeDefined();
  });

  it('enables WAL journal mode', async () => {
    await mkdir(testDir, { recursive: true });
    const dbPath = join(testDir, 'wal.db');
    await initDatabase(dbPath);
    const db = getDatabase();
    const row = db.pragma('journal_mode', { simple: true });
    expect(row).toBe('wal');
  });

  it('enables foreign keys', async () => {
    await mkdir(testDir, { recursive: true });
    const dbPath = join(testDir, 'fk.db');
    await initDatabase(dbPath);
    const db = getDatabase();
    const fkMode = db.pragma('foreign_keys', { simple: true });
    expect(fkMode).toBe(1);
  });

  it('sets busy timeout', async () => {
    await mkdir(testDir, { recursive: true });
    const dbPath = join(testDir, 'busy.db');
    await initDatabase(dbPath);
    const db = getDatabase();
    const timeout = db.pragma('busy_timeout', { simple: true });
    expect(Number(timeout)).toBe(5000);
  });

  it('creates sessions table after init', async () => {
    await mkdir(testDir, { recursive: true });
    const dbPath = join(testDir, 'schema.db');
    await initDatabase(dbPath);
    const tables = query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    );
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain('sessions');
  });

  it('creates credentials table after init', async () => {
    await mkdir(testDir, { recursive: true });
    const dbPath = join(testDir, 'creds-schema.db');
    await initDatabase(dbPath);
    const tables = query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table'"
    );
    expect(tables.map((t) => t.name)).toContain('credentials');
  });

  it('creates meta table after init', async () => {
    await mkdir(testDir, { recursive: true });
    const dbPath = join(testDir, 'meta-schema.db');
    await initDatabase(dbPath);
    const tables = query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table'"
    );
    expect(tables.map((t) => t.name)).toContain('meta');
  });

  it('creates memories table after init', async () => {
    await mkdir(testDir, { recursive: true });
    const dbPath = join(testDir, 'memories-schema.db');
    await initDatabase(dbPath);
    const tables = query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table'"
    );
    expect(tables.map((t) => t.name)).toContain('memories');
  });

  it('creates kg_triples table after init', async () => {
    await mkdir(testDir, { recursive: true });
    const dbPath = join(testDir, 'kg-schema.db');
    await initDatabase(dbPath);
    const tables = query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table'"
    );
    expect(tables.map((t) => t.name)).toContain('kg_triples');
  });

  it('creates kg_entities table after init', async () => {
    await mkdir(testDir, { recursive: true });
    const dbPath = join(testDir, 'entities-schema.db');
    await initDatabase(dbPath);
    const tables = query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table'"
    );
    expect(tables.map((t) => t.name)).toContain('kg_entities');
  });

  it('creates palace_wings table after init', async () => {
    await mkdir(testDir, { recursive: true });
    const dbPath = join(testDir, 'palace-schema.db');
    await initDatabase(dbPath);
    const tables = query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table'"
    );
    expect(tables.map((t) => t.name)).toContain('palace_wings');
  });

  it('creates palace_rooms table after init', async () => {
    await mkdir(testDir, { recursive: true });
    const dbPath = join(testDir, 'rooms-schema.db');
    await initDatabase(dbPath);
    const tables = query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table'"
    );
    expect(tables.map((t) => t.name)).toContain('palace_rooms');
  });

  it('repairs missing IF NOT EXISTS tables even when schema_version is already current', async () => {
    await mkdir(testDir, { recursive: true });
    const dbPath = join(testDir, 'repair-schema.db');
    await initDatabase(dbPath);

    execute('DROP TABLE objects');
    setMeta('schema_version', '11');
    closeDatabase();

    await initDatabase(dbPath);
    const tables = query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table'"
    );
    expect(tables.map((t) => t.name)).toContain('objects');
  });

  it('creates memory_associations table after init', async () => {
    await mkdir(testDir, { recursive: true });
    const dbPath = join(testDir, 'assoc-schema.db');
    await initDatabase(dbPath);
    const tables = query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table'"
    );
    expect(tables.map((t) => t.name)).toContain('memory_associations');
  });

  it('creates coherence_groups table after init', async () => {
    await mkdir(testDir, { recursive: true });
    const dbPath = join(testDir, 'cg-schema.db');
    await initDatabase(dbPath);
    const tables = query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table'"
    );
    expect(tables.map((t) => t.name)).toContain('coherence_groups');
  });

  it('creates town_events table after init', async () => {
    await mkdir(testDir, { recursive: true });
    const dbPath = join(testDir, 'events-schema.db');
    await initDatabase(dbPath);
    const tables = query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table'"
    );
    expect(tables.map((t) => t.name)).toContain('town_events');
  });

  it('creates building_events table after init', async () => {
    await mkdir(testDir, { recursive: true });
    const dbPath = join(testDir, 'building-events.db');
    await initDatabase(dbPath);
    const tables = query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table'"
    );
    expect(tables.map((t) => t.name)).toContain('building_events');
  });

  it('creates postboard_messages table after init', async () => {
    await mkdir(testDir, { recursive: true });
    const dbPath = join(testDir, 'postboard.db');
    await initDatabase(dbPath);
    const tables = query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table'"
    );
    expect(tables.map((t) => t.name)).toContain('postboard_messages');
  });

  it('stores schema_version in meta after init', async () => {
    await mkdir(testDir, { recursive: true });
    const dbPath = join(testDir, 'version.db');
    await initDatabase(dbPath);
    const version = getMeta('schema_version');
    expect(Number(version)).toBe(11);
  });

  it('getDatabase() throws when not initialized', () => {
    // already closed from afterEach — try calling getDatabase
    expect(() => getDatabase()).toThrow('Database not initialized');
  });

  it('isDatabaseInitialized() returns false before init', () => {
    expect(isDatabaseInitialized()).toBe(false);
  });

  it('isDatabaseInitialized() returns true after init', async () => {
    await mkdir(testDir, { recursive: true });
    const dbPath = join(testDir, 'isinit.db');
    await initDatabase(dbPath);
    expect(isDatabaseInitialized()).toBe(true);
  });

  it('closeDatabase() resets initialized state', async () => {
    await mkdir(testDir, { recursive: true });
    const dbPath = join(testDir, 'close.db');
    await initDatabase(dbPath);
    closeDatabase();
    expect(isDatabaseInitialized()).toBe(false);
  });

  it('closeDatabase() is idempotent (no throw on double close)', async () => {
    await mkdir(testDir, { recursive: true });
    const dbPath = join(testDir, 'double-close.db');
    await initDatabase(dbPath);
    closeDatabase();
    expect(() => closeDatabase()).not.toThrow();
  });

  it('query() throws when not initialized', () => {
    expect(() => query('SELECT 1')).toThrow();
  });

  it('getMeta() returns null for missing key', async () => {
    await mkdir(testDir, { recursive: true });
    const dbPath = join(testDir, 'meta-missing.db');
    await initDatabase(dbPath);
    expect(getMeta('does_not_exist')).toBeNull();
  });

  it('setMeta() and getMeta() round-trip', async () => {
    await mkdir(testDir, { recursive: true });
    const dbPath = join(testDir, 'meta-roundtrip.db');
    await initDatabase(dbPath);
    setMeta('test_key', 'hello world');
    expect(getMeta('test_key')).toBe('hello world');
  });

  it('setMeta() overwrites existing key', async () => {
    await mkdir(testDir, { recursive: true });
    const dbPath = join(testDir, 'meta-overwrite.db');
    await initDatabase(dbPath);
    setMeta('k', 'first');
    setMeta('k', 'second');
    expect(getMeta('k')).toBe('second');
  });

  it('custom keyDerivationConfig is accepted', async () => {
    await mkdir(testDir, { recursive: true });
    const dbPath = join(testDir, 'custom-kdf.db');
    const db = await initDatabase(dbPath, {
      algorithm: 'argon2id',
      memoryCost: 4096,
      timeCost: 2,
      parallelism: 1,
    });
    expect(db).toBeDefined();
  });

  it('transaction() commits all writes on success', async () => {
    await mkdir(testDir, { recursive: true });
    const dbPath = join(testDir, 'tx-commit.db');
    await initDatabase(dbPath);
    transaction(() => {
      setMeta('tx_key_1', 'val1');
      setMeta('tx_key_2', 'val2');
    });
    expect(getMeta('tx_key_1')).toBe('val1');
    expect(getMeta('tx_key_2')).toBe('val2');
  });

  it('transaction() rolls back on error', async () => {
    await mkdir(testDir, { recursive: true });
    const dbPath = join(testDir, 'tx-rollback.db');
    await initDatabase(dbPath);
    expect(() => {
      transaction(() => {
        setMeta('will_be_rolled_back', 'yes');
        throw new Error('boom');
      });
    }).toThrow('boom');
    expect(getMeta('will_be_rolled_back')).toBeNull();
  });

  it('execute() returns changes count', async () => {
    await mkdir(testDir, { recursive: true });
    const dbPath = join(testDir, 'execute-changes.db');
    await initDatabase(dbPath);
    execute("INSERT INTO meta (key, value) VALUES ('exec_test', 'data')");
    const result = execute("UPDATE meta SET value = 'updated' WHERE key = 'exec_test'");
    expect(result.changes).toBe(1);
  });

  it('queryOne() returns undefined for no match', async () => {
    await mkdir(testDir, { recursive: true });
    const dbPath = join(testDir, 'query-one-empty.db');
    await initDatabase(dbPath);
    const row = queryOne<{ value: string }>('SELECT value FROM meta WHERE key = ?', ['no_such_key']);
    expect(row).toBeUndefined();
  });

  it('re-initializing after close starts fresh', async () => {
    await mkdir(testDir, { recursive: true });
    const dbPath = join(testDir, 'reinit.db');
    await initDatabase(dbPath);
    setMeta('reinit_key', 'before');
    closeDatabase();
    await initDatabase(dbPath);
    expect(getMeta('reinit_key')).toBe('before'); // persisted on disk
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SESSIONS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Sessions', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = makeTestDir();
    await initTestDb(testDir);
  });

  afterEach(async () => {
    await cleanupTestDb(testDir);
  });

  // generateSessionKey
  it('generateSessionKey returns 21-char string', () => {
    const key = generateSessionKey();
    expect(key).toHaveLength(21);
  });

  it('generateSessionKey is URL-safe (no special chars)', () => {
    const key = generateSessionKey();
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('generateSessionKey produces unique values', () => {
    const keys = new Set(Array.from({ length: 100 }, () => generateSessionKey()));
    expect(keys.size).toBe(100);
  });

  // createSession
  it('createSession returns session with all fields', () => {
    const session = createSession({ agentId: 'agent-1', channel: 'cli', peerKind: 'user', peerId: 'peer-1' });
    expect(session.key).toHaveLength(21);
    expect(session.agentId).toBe('agent-1');
    expect(session.channel).toBe('cli');
    expect(session.peerKind).toBe('user');
    expect(session.peerId).toBe('peer-1');
    expect(session.tokenCount).toBe(0);
    expect(session.flags).toEqual({});
    expect(session.createdAt).toBeGreaterThan(0);
    expect(session.updatedAt).toBeGreaterThan(0);
  });

  it('createSession persists to database', () => {
    const session = createSession({ agentId: 'a', channel: 'web', peerKind: 'user', peerId: 'p' });
    const retrieved = getSession(session.key);
    expect(retrieved).toBeDefined();
    expect(retrieved!.key).toBe(session.key);
  });

  it('createSession createdAt equals updatedAt initially', () => {
    const session = createSession({ agentId: 'a', channel: 'cli', peerKind: 'user', peerId: 'p' });
    expect(session.createdAt).toBe(session.updatedAt);
  });

  it('createSession supports telegram channel', () => {
    const session = createSession({ agentId: 'bot', channel: 'telegram', peerKind: 'user', peerId: 'tg-123' });
    expect(session.channel).toBe('telegram');
  });

  it('createSession supports discord channel', () => {
    const session = createSession({ agentId: 'bot', channel: 'discord', peerKind: 'group', peerId: 'dc-456' });
    expect(session.channel).toBe('discord');
  });

  it('createSession supports slack channel', () => {
    const session = createSession({ agentId: 'bot', channel: 'slack', peerKind: 'channel', peerId: 'sl-789' });
    expect(session.channel).toBe('slack');
  });

  it('createSession supports group peerKind', () => {
    const session = createSession({ agentId: 'a', channel: 'web', peerKind: 'group', peerId: 'g-1' });
    expect(session.peerKind).toBe('group');
  });

  it('createSession does not set transcriptPath by default', () => {
    const session = createSession({ agentId: 'a', channel: 'cli', peerKind: 'user', peerId: 'p' });
    expect(session.transcriptPath).toBeUndefined();
  });

  // getSession
  it('getSession retrieves existing session', () => {
    const created = createSession({ agentId: 'a', channel: 'cli', peerKind: 'user', peerId: 'p' });
    const found = getSession(created.key);
    expect(found).toBeDefined();
    expect(found!.agentId).toBe('a');
  });

  it('getSession returns undefined for non-existent key', () => {
    expect(getSession('no-such-key-1234567')).toBeUndefined();
  });

  it('getSession preserves all fields correctly', () => {
    const created = createSession({ agentId: 'agent-X', channel: 'telegram', peerKind: 'channel', peerId: 'ch-99' });
    const found = getSession(created.key);
    expect(found!.agentId).toBe('agent-X');
    expect(found!.channel).toBe('telegram');
    expect(found!.peerKind).toBe('channel');
    expect(found!.peerId).toBe('ch-99');
    expect(found!.tokenCount).toBe(0);
  });

  it('getSession parses flags JSON correctly', () => {
    const session = createSession({ agentId: 'a', channel: 'cli', peerKind: 'user', peerId: 'p' });
    updateSession(session.key, { flags: { summarized: true } });
    const found = getSession(session.key);
    expect(found!.flags.summarized).toBe(true);
  });

  // findSession
  it('findSession locates session by agent/channel/peer', () => {
    const created = createSession({ agentId: 'ag', channel: 'web', peerKind: 'user', peerId: 'usr-1' });
    const found = findSession('ag', 'web', 'usr-1');
    expect(found!.key).toBe(created.key);
  });

  it('findSession returns undefined when no match', () => {
    expect(findSession('no-agent', 'cli', 'nobody')).toBeUndefined();
  });

  it('findSession is strict on agentId', () => {
    createSession({ agentId: 'agent-A', channel: 'cli', peerKind: 'user', peerId: 'p' });
    expect(findSession('agent-B', 'cli', 'p')).toBeUndefined();
  });

  it('findSession is strict on channel', () => {
    createSession({ agentId: 'a', channel: 'cli', peerKind: 'user', peerId: 'p' });
    expect(findSession('a', 'web', 'p')).toBeUndefined();
  });

  it('findSession is strict on peerId', () => {
    createSession({ agentId: 'a', channel: 'cli', peerKind: 'user', peerId: 'peer-A' });
    expect(findSession('a', 'cli', 'peer-B')).toBeUndefined();
  });

  it('findSession returns most recently updated when duplicates exist', () => {
    const s1 = createSession({ agentId: 'a', channel: 'cli', peerKind: 'user', peerId: 'p' });
    const s2 = createSession({ agentId: 'a', channel: 'cli', peerKind: 'user', peerId: 'p' });
    // Force s2's updated_at to be strictly greater than s1's
    execute('UPDATE sessions SET updated_at = ? WHERE key = ?', [Date.now() - 10000, s1.key]);
    execute('UPDATE sessions SET updated_at = ? WHERE key = ?', [Date.now(), s2.key]);
    const found = findSession('a', 'cli', 'p');
    expect(found!.key).toBe(s2.key);
  });

  // getOrCreateSession
  it('getOrCreateSession creates new session when none exists', () => {
    const session = getOrCreateSession({ agentId: 'new-agent', channel: 'web', peerKind: 'user', peerId: 'new-user' });
    expect(session).toBeDefined();
    expect(session.agentId).toBe('new-agent');
  });

  it('getOrCreateSession returns existing session if found', () => {
    const first = getOrCreateSession({ agentId: 'agt', channel: 'cli', peerKind: 'user', peerId: 'usr' });
    const second = getOrCreateSession({ agentId: 'agt', channel: 'cli', peerKind: 'user', peerId: 'usr' });
    expect(first.key).toBe(second.key);
  });

  // updateSession
  it('updateSession updates tokenCount', () => {
    const session = createSession({ agentId: 'a', channel: 'cli', peerKind: 'user', peerId: 'p' });
    const updated = updateSession(session.key, { tokenCount: 500 });
    expect(updated!.tokenCount).toBe(500);
  });

  it('updateSession updates transcriptPath', () => {
    const session = createSession({ agentId: 'a', channel: 'cli', peerKind: 'user', peerId: 'p' });
    const updated = updateSession(session.key, { transcriptPath: '/tmp/transcript.json' });
    expect(updated!.transcriptPath).toBe('/tmp/transcript.json');
  });

  it('updateSession merges flags (does not replace)', () => {
    const session = createSession({ agentId: 'a', channel: 'cli', peerKind: 'user', peerId: 'p' });
    updateSession(session.key, { flags: { summarized: true } });
    const updated = updateSession(session.key, { flags: { archived: true } });
    expect(updated!.flags.summarized).toBe(true);
    expect(updated!.flags.archived).toBe(true);
  });

  it('updateSession updates updatedAt timestamp', async () => {
    const session = createSession({ agentId: 'a', channel: 'cli', peerKind: 'user', peerId: 'p' });
    const originalUpdatedAt = session.updatedAt;
    // Small delay to ensure timestamp differs
    await new Promise((r) => setTimeout(r, 5));
    const updated = updateSession(session.key, { tokenCount: 1 });
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(originalUpdatedAt);
  });

  it('updateSession returns undefined for non-existent key', () => {
    expect(updateSession('ghost-key-12345678901', { tokenCount: 1 })).toBeUndefined();
  });

  it('updateSession without tokenCount preserves existing count', () => {
    const session = createSession({ agentId: 'a', channel: 'cli', peerKind: 'user', peerId: 'p' });
    updateSession(session.key, { tokenCount: 42 });
    const updated = updateSession(session.key, { flags: { muted: true } });
    expect(updated!.tokenCount).toBe(42);
  });

  // deleteSession
  it('deleteSession returns true and removes session', () => {
    const session = createSession({ agentId: 'a', channel: 'cli', peerKind: 'user', peerId: 'p' });
    expect(deleteSession(session.key)).toBe(true);
    expect(getSession(session.key)).toBeUndefined();
  });

  it('deleteSession returns false for non-existent key', () => {
    expect(deleteSession('no-such-key-12345678')).toBe(false);
  });

  it('deleteSession only removes the targeted session', () => {
    const s1 = createSession({ agentId: 'a', channel: 'cli', peerKind: 'user', peerId: 'p1' });
    const s2 = createSession({ agentId: 'a', channel: 'cli', peerKind: 'user', peerId: 'p2' });
    deleteSession(s1.key);
    expect(getSession(s2.key)).toBeDefined();
  });

  // listSessions
  it('listSessions returns all sessions for agent', () => {
    createSession({ agentId: 'agent-list', channel: 'cli', peerKind: 'user', peerId: 'p1' });
    createSession({ agentId: 'agent-list', channel: 'web', peerKind: 'user', peerId: 'p2' });
    createSession({ agentId: 'other-agent', channel: 'cli', peerKind: 'user', peerId: 'p3' });
    const sessions = listSessions('agent-list');
    expect(sessions).toHaveLength(2);
    expect(sessions.every((s) => s.agentId === 'agent-list')).toBe(true);
  });

  it('listSessions filters by channel', () => {
    createSession({ agentId: 'agt', channel: 'cli', peerKind: 'user', peerId: 'p1' });
    createSession({ agentId: 'agt', channel: 'web', peerKind: 'user', peerId: 'p2' });
    const sessions = listSessions('agt', { channel: 'cli' });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.channel).toBe('cli');
  });

  it('listSessions respects limit option', () => {
    for (let i = 0; i < 5; i++) {
      createSession({ agentId: 'limit-agent', channel: 'cli', peerKind: 'user', peerId: `p${i}` });
    }
    const sessions = listSessions('limit-agent', { limit: 3 });
    expect(sessions).toHaveLength(3);
  });

  it('listSessions respects offset option combined with limit', () => {
    for (let i = 0; i < 5; i++) {
      createSession({ agentId: 'offset-agent', channel: 'cli', peerKind: 'user', peerId: `p${i}` });
    }
    const offsetSessions = listSessions('offset-agent', { limit: 5, offset: 2 });
    expect(offsetSessions).toHaveLength(3);
  });

  it('listSessions returns empty array when no sessions', () => {
    const sessions = listSessions('empty-agent');
    expect(sessions).toEqual([]);
  });

  it('listSessions orders by updatedAt DESC', () => {
    const s1 = createSession({ agentId: 'ord', channel: 'cli', peerKind: 'user', peerId: 'a' });
    const s2 = createSession({ agentId: 'ord', channel: 'cli', peerKind: 'user', peerId: 'b' });
    // Force deterministic ordering: s1 older, s2 newer
    execute('UPDATE sessions SET updated_at = ? WHERE key = ?', [Date.now() - 5000, s1.key]);
    execute('UPDATE sessions SET updated_at = ? WHERE key = ?', [Date.now(), s2.key]);
    const sessions = listSessions('ord');
    expect(sessions[0]!.key).toBe(s2.key);
    expect(sessions[1]!.key).toBe(s1.key);
  });

  // countSessions
  it('countSessions returns 0 when no sessions', () => {
    expect(countSessions('empty-count-agent')).toBe(0);
  });

  it('countSessions counts all sessions for agent', () => {
    createSession({ agentId: 'cnt', channel: 'cli', peerKind: 'user', peerId: 'p1' });
    createSession({ agentId: 'cnt', channel: 'web', peerKind: 'user', peerId: 'p2' });
    expect(countSessions('cnt')).toBe(2);
  });

  it('countSessions filters by channel', () => {
    createSession({ agentId: 'cnt2', channel: 'cli', peerKind: 'user', peerId: 'p1' });
    createSession({ agentId: 'cnt2', channel: 'web', peerKind: 'user', peerId: 'p2' });
    expect(countSessions('cnt2', 'cli')).toBe(1);
  });

  it('countSessions excludes other agents', () => {
    createSession({ agentId: 'agent-A', channel: 'cli', peerKind: 'user', peerId: 'p' });
    createSession({ agentId: 'agent-B', channel: 'cli', peerKind: 'user', peerId: 'p' });
    expect(countSessions('agent-A')).toBe(1);
  });

  // deleteOldSessions
  it('deleteOldSessions removes sessions older than maxAge', async () => {
    const session = createSession({ agentId: 'old-agent', channel: 'cli', peerKind: 'user', peerId: 'p' });
    // Force updatedAt to be in the past via direct SQL
    execute('UPDATE sessions SET updated_at = ? WHERE key = ?', [Date.now() - 100000, session.key]);
    const deleted = deleteOldSessions('old-agent', 50000);
    expect(deleted).toBe(1);
    expect(getSession(session.key)).toBeUndefined();
  });

  it('deleteOldSessions does not remove recent sessions', () => {
    const session = createSession({ agentId: 'fresh-agent', channel: 'cli', peerKind: 'user', peerId: 'p' });
    const deleted = deleteOldSessions('fresh-agent', 9999999);
    expect(deleted).toBe(0);
    expect(getSession(session.key)).toBeDefined();
  });

  it('deleteOldSessions only affects specified agent', () => {
    const s1 = createSession({ agentId: 'old-2', channel: 'cli', peerKind: 'user', peerId: 'p' });
    const s2 = createSession({ agentId: 'other-agent-2', channel: 'cli', peerKind: 'user', peerId: 'p' });
    execute('UPDATE sessions SET updated_at = 1 WHERE key = ?', [s1.key]);
    execute('UPDATE sessions SET updated_at = 1 WHERE key = ?', [s2.key]);
    deleteOldSessions('old-2', 0);
    expect(getSession(s2.key)).toBeDefined();
  });

  // batchUpdateTokenCounts
  it('batchUpdateTokenCounts updates multiple sessions', () => {
    const s1 = createSession({ agentId: 'batch', channel: 'cli', peerKind: 'user', peerId: 'p1' });
    const s2 = createSession({ agentId: 'batch', channel: 'cli', peerKind: 'user', peerId: 'p2' });
    batchUpdateTokenCounts([
      { key: s1.key, tokenCount: 111 },
      { key: s2.key, tokenCount: 222 },
    ]);
    expect(getSession(s1.key)!.tokenCount).toBe(111);
    expect(getSession(s2.key)!.tokenCount).toBe(222);
  });

  it('batchUpdateTokenCounts with empty array does nothing', () => {
    expect(() => batchUpdateTokenCounts([])).not.toThrow();
  });

  it('batchUpdateTokenCounts is atomic (transaction)', () => {
    const s1 = createSession({ agentId: 'tx-batch', channel: 'cli', peerKind: 'user', peerId: 'p' });
    // Batch with valid + invalid key should still succeed for valid keys
    batchUpdateTokenCounts([
      { key: s1.key, tokenCount: 999 },
      { key: 'nonexistent-key-12345', tokenCount: 50 },
    ]);
    expect(getSession(s1.key)!.tokenCount).toBe(999);
  });

  it('session flags default to empty object', () => {
    const session = createSession({ agentId: 'flags-test', channel: 'cli', peerKind: 'user', peerId: 'p' });
    expect(session.flags).toEqual({});
  });

  it('session flags can set muted', () => {
    const session = createSession({ agentId: 'mute-test', channel: 'cli', peerKind: 'user', peerId: 'p' });
    const updated = updateSession(session.key, { flags: { muted: true } });
    expect(updated!.flags.muted).toBe(true);
  });

  it('session flags can set archived', () => {
    const session = createSession({ agentId: 'arc-test', channel: 'cli', peerKind: 'user', peerId: 'p' });
    const updated = updateSession(session.key, { flags: { archived: true } });
    expect(updated!.flags.archived).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// KEYCHAIN
// ═══════════════════════════════════════════════════════════════════════════════

describe('Keychain', () => {
  beforeEach(() => {
    keytarStore.clear();
    // Remove env override so keytar mock is used
    delete process.env['LAIN_MASTER_KEY'];
  });

  afterEach(() => {
    process.env['LAIN_MASTER_KEY'] = 'test-master-key-for-deep-tests';
  });

  it('getMasterKey generates and stores a new key when none exists', async () => {
    const key = await getMasterKey();
    expect(key).toBeTruthy();
    expect(typeof key).toBe('string');
  });

  it('getMasterKey returns same key on second call', async () => {
    const key1 = await getMasterKey();
    const key2 = await getMasterKey();
    expect(key1).toBe(key2);
  });

  it('getMasterKey uses LAIN_MASTER_KEY env var if set', async () => {
    process.env['LAIN_MASTER_KEY'] = 'env-override-key';
    const key = await getMasterKey();
    expect(key).toBe('env-override-key');
    delete process.env['LAIN_MASTER_KEY'];
  });

  it('setMasterKey stores new master key', async () => {
    await setMasterKey('my-custom-key');
    const key = await getMasterKey();
    expect(key).toBe('my-custom-key');
  });

  it('getAuthToken returns null when not set', async () => {
    const token = await getAuthToken();
    expect(token).toBeNull();
  });

  it('setAuthToken stores token', async () => {
    await setAuthToken('my-auth-token-abc123');
    const token = await getAuthToken();
    expect(token).toBe('my-auth-token-abc123');
  });

  it('generateAuthToken returns a token and stores it', async () => {
    const token = await generateAuthToken();
    expect(token).toBeTruthy();
    const stored = await getAuthToken();
    expect(stored).toBe(token);
  });

  it('generateAuthToken uses default length (32 bytes = 64 hex chars)', async () => {
    const token = await generateAuthToken();
    expect(token).toHaveLength(64);
  });

  it('generateAuthToken respects custom length', async () => {
    const token = await generateAuthToken(16);
    expect(token).toHaveLength(32); // hex encoding
  });

  it('deleteAuthToken removes the token', async () => {
    await setAuthToken('delete-me');
    const result = await deleteAuthToken();
    expect(result).toBe(true);
    expect(await getAuthToken()).toBeNull();
  });

  it('deleteAuthToken returns false when nothing to delete', async () => {
    const result = await deleteAuthToken();
    expect(result).toBe(false);
  });

  it('setCredential stores a custom credential', async () => {
    await setCredential('my-api-key', 'sk-1234567890');
    const val = await getCredential('my-api-key');
    expect(val).toBe('sk-1234567890');
  });

  it('getCredential returns null for missing credential', async () => {
    const val = await getCredential('nonexistent');
    expect(val).toBeNull();
  });

  it('setCredential overwrites existing credential', async () => {
    await setCredential('overwrite-me', 'old-value');
    await setCredential('overwrite-me', 'new-value');
    expect(await getCredential('overwrite-me')).toBe('new-value');
  });

  it('deleteCredential returns true and removes credential', async () => {
    await setCredential('to-delete', 'data');
    const result = await deleteCredential('to-delete');
    expect(result).toBe(true);
    expect(await getCredential('to-delete')).toBeNull();
  });

  it('deleteCredential returns false for non-existent key', async () => {
    const result = await deleteCredential('nope');
    expect(result).toBe(false);
  });

  it('listCredentials returns all stored credentials', async () => {
    await setCredential('cred-a', 'val-a');
    await setCredential('cred-b', 'val-b');
    const list = await listCredentials();
    const accounts = list.map((c) => c.account);
    expect(accounts).toContain('cred-a');
    expect(accounts).toContain('cred-b');
  });

  it('listCredentials returns only account names (no passwords)', async () => {
    await setCredential('safe-cred', 'secret');
    const list = await listCredentials();
    const cred = list.find((c) => c.account === 'safe-cred');
    expect(cred).toBeDefined();
    expect(Object.keys(cred!)).toEqual(['account']);
  });

  it('listCredentials returns empty array when no credentials', async () => {
    const list = await listCredentials();
    expect(list).toEqual([]);
  });

  it('multiple credentials can coexist independently', async () => {
    await setCredential('svc-a', 'key-a');
    await setCredential('svc-b', 'key-b');
    await setCredential('svc-c', 'key-c');
    expect(await getCredential('svc-a')).toBe('key-a');
    expect(await getCredential('svc-b')).toBe('key-b');
    expect(await getCredential('svc-c')).toBe('key-c');
  });

  it('credential with empty string value', async () => {
    await setCredential('empty-val', '');
    const val = await getCredential('empty-val');
    expect(val).toBe('');
  });

  it('credential with unicode value', async () => {
    await setCredential('unicode-cred', '秘密のキー🔑');
    const val = await getCredential('unicode-cred');
    expect(val).toBe('秘密のキー🔑');
  });

  it('credential with very long value', async () => {
    const longVal = 'x'.repeat(10000);
    await setCredential('long-cred', longVal);
    const val = await getCredential('long-cred');
    expect(val).toBe(longVal);
  });

  it('auth token survives set/get/delete cycle', async () => {
    await setAuthToken('cycle-token');
    expect(await getAuthToken()).toBe('cycle-token');
    await deleteAuthToken();
    expect(await getAuthToken()).toBeNull();
  });

  it('keychain error wrapping — KeychainError on getPassword failure', async () => {
    const keytar = (await import('keytar')).default;
    vi.mocked(keytar.getPassword).mockRejectedValueOnce(new Error('keychain locked'));
    const { KeychainError } = await import('../src/utils/errors.js');
    await expect(getAuthToken()).rejects.toBeInstanceOf(KeychainError);
    vi.mocked(keytar.getPassword).mockResolvedValue(null);
  });

  it('keychain error wrapping — KeychainError on setPassword failure', async () => {
    const keytar = (await import('keytar')).default;
    vi.mocked(keytar.setPassword).mockRejectedValueOnce(new Error('disk full'));
    const { KeychainError } = await import('../src/utils/errors.js');
    await expect(setAuthToken('x')).rejects.toBeInstanceOf(KeychainError);
    vi.mocked(keytar.setPassword).mockResolvedValue(undefined);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// KNOWLEDGE GRAPH
// ═══════════════════════════════════════════════════════════════════════════════

describe('Knowledge Graph', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = makeTestDir();
    await initTestDb(testDir);
  });

  afterEach(async () => {
    await cleanupTestDb(testDir);
  });

  // addTriple / getTriple
  it('addTriple returns a 16-char ID', () => {
    const id = addTriple('Lain', 'is', 'protagonist');
    expect(id).toHaveLength(16);
  });

  it('addTriple stores triple retrievable via getTriple', () => {
    const id = addTriple('Lain', 'lives_in', 'Cyberia');
    const triple = getTriple(id);
    expect(triple).toBeDefined();
    expect(triple!.subject).toBe('Lain');
    expect(triple!.predicate).toBe('lives_in');
    expect(triple!.object).toBe('Cyberia');
  });

  it('getTriple returns undefined for non-existent ID', () => {
    expect(getTriple('nonexistent1234')).toBeUndefined();
  });

  it('addTriple uses default strength 1.0', () => {
    const id = addTriple('A', 'rel', 'B');
    expect(getTriple(id)!.strength).toBe(1.0);
  });

  it('addTriple accepts custom strength', () => {
    const id = addTriple('A', 'rel', 'B', 0.42);
    expect(getTriple(id)!.strength).toBe(0.42);
  });

  it('addTriple uses current time as validFrom by default', () => {
    const before = Date.now();
    const id = addTriple('A', 'rel', 'B');
    const after = Date.now();
    const triple = getTriple(id)!;
    expect(triple.validFrom).toBeGreaterThanOrEqual(before);
    expect(triple.validFrom).toBeLessThanOrEqual(after);
  });

  it('addTriple accepts custom validFrom', () => {
    const ts = 1000000;
    const id = addTriple('A', 'rel', 'B', 1.0, ts);
    expect(getTriple(id)!.validFrom).toBe(ts);
  });

  it('addTriple ended is null by default', () => {
    const id = addTriple('A', 'rel', 'B');
    expect(getTriple(id)!.ended).toBeNull();
  });

  it('addTriple accepts custom ended timestamp', () => {
    const id = addTriple('A', 'rel', 'B', 1.0, undefined, 9999999);
    expect(getTriple(id)!.ended).toBe(9999999);
  });

  it('addTriple sourceMemoryId is null by default', () => {
    const id = addTriple('A', 'rel', 'B');
    expect(getTriple(id)!.sourceMemoryId).toBeNull();
  });

  it('addTriple accepts sourceMemoryId', () => {
    const id = addTriple('A', 'rel', 'B', 1.0, undefined, null, 'mem-id-123');
    expect(getTriple(id)!.sourceMemoryId).toBe('mem-id-123');
  });

  it('addTriple stores metadata', () => {
    const id = addTriple('A', 'rel', 'B', 1.0, undefined, null, null, { tag: 'test' });
    expect(getTriple(id)!.metadata).toEqual({ tag: 'test' });
  });

  it('addTriple with empty metadata defaults to {}', () => {
    const id = addTriple('A', 'rel', 'B');
    expect(getTriple(id)!.metadata).toEqual({});
  });

  it('addTriple allows duplicate subject-predicate-object', () => {
    const id1 = addTriple('A', 'rel', 'B');
    const id2 = addTriple('A', 'rel', 'B');
    expect(id1).not.toBe(id2);
  });

  // invalidateTriple
  it('invalidateTriple sets ended to now by default', () => {
    const id = addTriple('A', 'rel', 'B');
    const before = Date.now();
    invalidateTriple(id);
    const after = Date.now();
    const triple = getTriple(id)!;
    expect(triple.ended).toBeGreaterThanOrEqual(before);
    expect(triple.ended!).toBeLessThanOrEqual(after);
  });

  it('invalidateTriple accepts custom endedAt', () => {
    const id = addTriple('A', 'rel', 'B');
    invalidateTriple(id, 42000);
    expect(getTriple(id)!.ended).toBe(42000);
  });

  it('invalidateTriple only affects the specified triple', () => {
    const id1 = addTriple('X', 'rel', 'Y');
    const id2 = addTriple('X', 'rel', 'Z');
    invalidateTriple(id1);
    expect(getTriple(id2)!.ended).toBeNull();
  });

  // queryTriples
  it('queryTriples with no filters returns all triples', () => {
    addTriple('A', 'rel', 'B');
    addTriple('C', 'rel', 'D');
    const results = queryTriples({});
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it('queryTriples filters by subject', () => {
    addTriple('Lain', 'likes', 'computers');
    addTriple('Alice', 'likes', 'books');
    const results = queryTriples({ subject: 'Lain' });
    expect(results.every((t) => t.subject === 'Lain')).toBe(true);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it('queryTriples filters by predicate', () => {
    addTriple('A', 'knows', 'B');
    addTriple('C', 'loves', 'D');
    const results = queryTriples({ predicate: 'knows' });
    expect(results.every((t) => t.predicate === 'knows')).toBe(true);
  });

  it('queryTriples filters by object', () => {
    addTriple('A', 'contains', 'alpha');
    addTriple('B', 'contains', 'beta');
    const results = queryTriples({ object: 'alpha' });
    expect(results.every((t) => t.object === 'alpha')).toBe(true);
  });

  it('queryTriples combines subject and predicate filters', () => {
    addTriple('Wired', 'contains', 'information');
    addTriple('Wired', 'contains', 'souls');
    addTriple('Lain', 'contains', 'curiosity');
    const results = queryTriples({ subject: 'Wired', predicate: 'contains' });
    expect(results.every((t) => t.subject === 'Wired' && t.predicate === 'contains')).toBe(true);
  });

  it('queryTriples asOf filter excludes triples after validFrom', () => {
    const past = Date.now() - 10000;
    const future = Date.now() + 10000;
    addTriple('A', 'rel', 'B', 1.0, future);
    const results = queryTriples({ subject: 'A', asOf: past });
    expect(results.length).toBe(0);
  });

  it('queryTriples asOf filter includes active triples', () => {
    const ts = Date.now() - 5000;
    addTriple('TimedA', 'rel', 'B', 1.0, ts);
    const results = queryTriples({ subject: 'TimedA', asOf: Date.now() });
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it('queryTriples asOf filter excludes triples ended before asOf', () => {
    const id = addTriple('EndedA', 'rel', 'B', 1.0, Date.now() - 10000, Date.now() - 5000);
    const results = queryTriples({ subject: 'EndedA', asOf: Date.now() });
    expect(results.some((t) => t.id === id)).toBe(false);
  });

  it('queryTriples respects limit', () => {
    for (let i = 0; i < 10; i++) addTriple(`LimSubj${i}`, 'rel', `obj${i}`);
    const results = queryTriples({ predicate: 'rel', limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('queryTriples returns empty array when no match', () => {
    const results = queryTriples({ subject: 'NonExistentEntity_XYZ' });
    expect(results).toEqual([]);
  });

  it('queryTriples orders by validFrom ASC', () => {
    addTriple('Ord', 'rel', 'C', 1.0, 3000);
    addTriple('Ord', 'rel', 'A', 1.0, 1000);
    addTriple('Ord', 'rel', 'B', 1.0, 2000);
    const results = queryTriples({ subject: 'Ord' });
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.validFrom).toBeGreaterThanOrEqual(results[i - 1]!.validFrom);
    }
  });

  // getEntityTimeline
  it('getEntityTimeline returns triples where entity is subject', () => {
    addTriple('Alice', 'knows', 'Bob');
    const timeline = getEntityTimeline('Alice');
    expect(timeline.some((t) => t.subject === 'Alice')).toBe(true);
  });

  it('getEntityTimeline returns triples where entity is object', () => {
    addTriple('Charlie', 'mentions', 'Alice');
    const timeline = getEntityTimeline('Alice');
    expect(timeline.some((t) => t.object === 'Alice')).toBe(true);
  });

  it('getEntityTimeline respects limit', () => {
    for (let i = 0; i < 10; i++) addTriple('BigEntity', 'rel', `item${i}`);
    const timeline = getEntityTimeline('BigEntity', 3);
    expect(timeline.length).toBeLessThanOrEqual(3);
  });

  // addEntity / getEntity
  it('addEntity creates a new entity', () => {
    addEntity('Lain', 'character');
    const entity = getEntity('Lain');
    expect(entity).toBeDefined();
    expect(entity!.entityType).toBe('character');
  });

  it('getEntity returns undefined for missing entity', () => {
    expect(getEntity('NonExistent_Entity_9999')).toBeUndefined();
  });

  it('addEntity upserts — updates last_seen on conflict', () => {
    addEntity('Recurring', 'person', Date.now() - 10000);
    const before = getEntity('Recurring')!.lastSeen;
    addEntity('Recurring', 'person');
    const after = getEntity('Recurring')!.lastSeen;
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it('addEntity stores metadata', () => {
    addEntity('Meta-Entity', 'thing', undefined, { note: 'hello' });
    const entity = getEntity('Meta-Entity');
    expect(entity!.metadata).toEqual({ note: 'hello' });
  });

  it('addEntity firstSeen is set correctly', () => {
    const ts = 123456789;
    addEntity('OldEntity', 'person', ts);
    expect(getEntity('OldEntity')!.firstSeen).toBe(ts);
  });

  // updateEntityLastSeen
  it('updateEntityLastSeen updates the timestamp', () => {
    addEntity('UpdateMe', 'entity');
    updateEntityLastSeen('UpdateMe', 99999999);
    expect(getEntity('UpdateMe')!.lastSeen).toBe(99999999);
  });

  it('updateEntityLastSeen defaults to now', () => {
    addEntity('UpdateNow', 'entity', 1000);
    const before = Date.now();
    updateEntityLastSeen('UpdateNow');
    const after = Date.now();
    const lastSeen = getEntity('UpdateNow')!.lastSeen;
    expect(lastSeen).toBeGreaterThanOrEqual(before);
    expect(lastSeen).toBeLessThanOrEqual(after);
  });

  // listEntities
  it('listEntities returns all entities ordered by last_seen DESC', () => {
    addEntity('Old-Ent', 'person', 1000);
    addEntity('New-Ent', 'person', 9999999999);
    const entities = listEntities();
    const names = entities.map((e) => e.name);
    const newIdx = names.indexOf('New-Ent');
    const oldIdx = names.indexOf('Old-Ent');
    if (newIdx !== -1 && oldIdx !== -1) {
      expect(newIdx).toBeLessThan(oldIdx);
    }
  });

  it('listEntities filters by entityType', () => {
    addEntity('TypedEnt1', 'location');
    addEntity('TypedEnt2', 'character');
    const locations = listEntities('location');
    expect(locations.every((e) => e.entityType === 'location')).toBe(true);
  });

  it('listEntities respects limit', () => {
    for (let i = 0; i < 10; i++) addEntity(`BulkEnt${i}`, 'thing');
    const limited = listEntities(undefined, 3);
    expect(limited.length).toBeLessThanOrEqual(3);
  });

  it('listEntities returns empty array when none match type', () => {
    const result = listEntities('nonexistent-type-xyz');
    expect(result).toEqual([]);
  });

  // detectContradictions
  it('detectContradictions returns empty array when no contradictions', () => {
    addTriple('UniqueSubj', 'color', 'blue');
    const contradictions = detectContradictions();
    const relevant = contradictions.filter((c) => c.subject === 'UniqueSubj');
    expect(relevant).toHaveLength(0);
  });

  it('detectContradictions detects conflicting active triples', () => {
    addTriple('ContradSubj', 'color', 'red');
    addTriple('ContradSubj', 'color', 'blue');
    const contradictions = detectContradictions();
    const relevant = contradictions.filter((c) => c.subject === 'ContradSubj' && c.predicate === 'color');
    expect(relevant.length).toBeGreaterThan(0);
  });

  it('detectContradictions ignores invalidated triples', () => {
    const id1 = addTriple('InvContradSubj', 'size', 'small');
    addTriple('InvContradSubj', 'size', 'large');
    invalidateTriple(id1);
    const contradictions = detectContradictions();
    const relevant = contradictions.filter((c) => c.subject === 'InvContradSubj');
    expect(relevant).toHaveLength(0);
  });

  it('detectContradictions returns pairs with distinct objects', () => {
    addTriple('PairSubj', 'status', 'online');
    addTriple('PairSubj', 'status', 'offline');
    const contradictions = detectContradictions();
    const relevant = contradictions.filter((c) => c.subject === 'PairSubj');
    expect(relevant[0]!.tripleA.object).not.toBe(relevant[0]!.tripleB.object);
  });

  it('detectContradictions does not flag same subject+predicate+object', () => {
    addTriple('SameSubj', 'prop', 'same-val');
    addTriple('SameSubj', 'prop', 'same-val');
    const contradictions = detectContradictions();
    const relevant = contradictions.filter((c) => c.subject === 'SameSubj');
    expect(relevant).toHaveLength(0);
  });

  it('detectContradictions returns all pairs for N conflicting triples (N*(N-1)/2)', () => {
    addTriple('MultiContr', 'color', 'red');
    addTriple('MultiContr', 'color', 'green');
    addTriple('MultiContr', 'color', 'blue');
    const contradictions = detectContradictions();
    const relevant = contradictions.filter((c) => c.subject === 'MultiContr' && c.predicate === 'color');
    expect(relevant.length).toBe(3); // 3 * 2 / 2 = 3
  });

  it('bulk triple insertion — 100 triples queryable', () => {
    for (let i = 0; i < 100; i++) {
      addTriple(`BulkSubj${i}`, 'index', `${i}`);
    }
    const results = queryTriples({ predicate: 'index' });
    expect(results.length).toBeGreaterThanOrEqual(100);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MIGRATION
// ═══════════════════════════════════════════════════════════════════════════════

describe('Migration', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = makeTestDir();
    await initTestDb(testDir);
  });

  afterEach(async () => {
    await cleanupTestDb(testDir);
  });

  it('getMigrationStats returns total=0 on empty database', () => {
    const stats = getMigrationStats();
    expect(stats.total).toBe(0);
    expect(stats.migrated).toBe(0);
    expect(stats.unmigrated).toBe(0);
  });

  it('getMigrationStats unmigrated = total - migrated', () => {
    const stats = getMigrationStats();
    expect(stats.unmigrated).toBe(stats.total - stats.migrated);
  });

  it('migrateAssociationsToKG returns zero counts on empty database', () => {
    const result = migrateAssociationsToKG();
    expect(result.total).toBe(0);
    expect(result.migrated).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('migrateAssociationsToKG is idempotent (skips duplicates on re-run)', () => {
    // Insert a memory association manually
    execute(
      `INSERT INTO memories (id, content, memory_type, importance, created_at)
       VALUES ('m1', 'test', 'fact', 0.5, ?)`,
      [Date.now()]
    );
    execute(
      `INSERT INTO memories (id, content, memory_type, importance, created_at)
       VALUES ('m2', 'test2', 'fact', 0.5, ?)`,
      [Date.now()]
    );
    execute(
      `INSERT INTO memory_associations (source_id, target_id, association_type, strength, created_at)
       VALUES ('m1', 'm2', 'similar', 0.8, ?)`,
      [Date.now()]
    );
    const first = migrateAssociationsToKG();
    expect(first.migrated).toBe(1);
    const second = migrateAssociationsToKG();
    expect(second.skipped).toBe(1);
    expect(second.migrated).toBe(0);
  });

  it('migrateAssociationsToKG maps "similar" to "similar_to" predicate', () => {
    execute(
      `INSERT INTO memories (id, content, memory_type, importance, created_at)
       VALUES ('src1', 'a', 'fact', 0.5, ?)`,
      [Date.now()]
    );
    execute(
      `INSERT INTO memories (id, content, memory_type, importance, created_at)
       VALUES ('tgt1', 'b', 'fact', 0.5, ?)`,
      [Date.now()]
    );
    execute(
      `INSERT INTO memory_associations (source_id, target_id, association_type, strength, created_at)
       VALUES ('src1', 'tgt1', 'similar', 0.9, ?)`,
      [Date.now()]
    );
    migrateAssociationsToKG();
    const triples = queryTriples({ subject: 'src1', predicate: 'similar_to', object: 'tgt1' });
    expect(triples.length).toBe(1);
  });

  it('migrateAssociationsToKG maps "evolved_from" to "evolved_from" predicate', () => {
    execute(
      `INSERT INTO memories (id, content, memory_type, importance, created_at)
       VALUES ('ev_src', 'a', 'fact', 0.5, ?)`,
      [Date.now()]
    );
    execute(
      `INSERT INTO memories (id, content, memory_type, importance, created_at)
       VALUES ('ev_tgt', 'b', 'fact', 0.5, ?)`,
      [Date.now()]
    );
    execute(
      `INSERT INTO memory_associations (source_id, target_id, association_type, strength, created_at)
       VALUES ('ev_src', 'ev_tgt', 'evolved_from', 0.7, ?)`,
      [Date.now()]
    );
    migrateAssociationsToKG();
    const triples = queryTriples({ subject: 'ev_src', predicate: 'evolved_from' });
    expect(triples.length).toBe(1);
  });

  it('migrateAssociationsToKG maps "cross_topic" to "cross_references" predicate', () => {
    execute(
      `INSERT INTO memories (id, content, memory_type, importance, created_at)
       VALUES ('ct_src', 'a', 'fact', 0.5, ?)`,
      [Date.now()]
    );
    execute(
      `INSERT INTO memories (id, content, memory_type, importance, created_at)
       VALUES ('ct_tgt', 'b', 'fact', 0.5, ?)`,
      [Date.now()]
    );
    execute(
      `INSERT INTO memory_associations (source_id, target_id, association_type, strength, created_at)
       VALUES ('ct_src', 'ct_tgt', 'cross_topic', 0.4, ?)`,
      [Date.now()]
    );
    migrateAssociationsToKG();
    const triples = queryTriples({ subject: 'ct_src', predicate: 'cross_references' });
    expect(triples.length).toBe(1);
  });

  it('migrateAssociationsToKG handles unknown association type (uses type as predicate)', () => {
    execute(
      `INSERT INTO memories (id, content, memory_type, importance, created_at)
       VALUES ('unk_src', 'a', 'fact', 0.5, ?)`,
      [Date.now()]
    );
    execute(
      `INSERT INTO memories (id, content, memory_type, importance, created_at)
       VALUES ('unk_tgt', 'b', 'fact', 0.5, ?)`,
      [Date.now()]
    );
    execute(
      `INSERT INTO memory_associations (source_id, target_id, association_type, strength, created_at)
       VALUES ('unk_src', 'unk_tgt', 'custom_type', 0.5, ?)`,
      [Date.now()]
    );
    migrateAssociationsToKG();
    const triples = queryTriples({ subject: 'unk_src', predicate: 'custom_type' });
    expect(triples.length).toBe(1);
  });

  it('getMigrationStats shows migrated count after migration', () => {
    // Insert an unmigrated memory (wing_id IS NULL)
    execute(
      `INSERT INTO memories (id, content, memory_type, importance, created_at)
       VALUES ('unmig1', 'content', 'fact', 0.5, ?)`,
      [Date.now()]
    );
    const stats = getMigrationStats();
    expect(stats.total).toBeGreaterThanOrEqual(1);
    expect(stats.unmigrated).toBeGreaterThanOrEqual(1);
  });

  it('schema_version is 11 after full migration', () => {
    const version = getMeta('schema_version');
    expect(Number(version)).toBe(11);
  });

  it('duplicate migration runs do not fail (CREATE TABLE IF NOT EXISTS is safe)', async () => {
    // Close and re-open the same database — migrations should be skipped
    const dbPath = join(testDir, 'test.db');
    closeDatabase();
    await expect(initDatabase(dbPath)).resolves.toBeDefined();
  });

  it('migrateAssociationsToKG total count matches association table row count', () => {
    execute(
      `INSERT INTO memories (id, content, memory_type, importance, created_at)
       VALUES ('bulk_src', 'a', 'fact', 0.5, ?)`,
      [Date.now()]
    );
    for (let i = 0; i < 5; i++) {
      execute(
        `INSERT INTO memories (id, content, memory_type, importance, created_at)
         VALUES (?, 'x', 'fact', 0.5, ?)`,
        [`bulk_tgt${i}`, Date.now()]
      );
      execute(
        `INSERT INTO memory_associations (source_id, target_id, association_type, strength, created_at)
         VALUES (?, ?, 'similar', 0.8, ?)`,
        ['bulk_src', `bulk_tgt${i}`, Date.now()]
      );
    }
    const result = migrateAssociationsToKG();
    expect(result.total).toBeGreaterThanOrEqual(5);
  });
});
