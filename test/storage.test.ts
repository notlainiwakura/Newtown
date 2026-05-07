/**
 * Storage tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  generateToken,
  hashToken,
  secureCompare,
  generateSalt,
} from '../src/utils/crypto.js';
import {
  createSession,
  getSession,
  findSession,
  updateSession,
  deleteSession,
  listSessions,
  countSessions,
} from '../src/storage/sessions.js';
import {
  initDatabase,
  closeDatabase,
  isDatabaseInitialized,
  atomicMetaIncrementCounter,
  getMeta,
} from '../src/storage/database.js';

// Mock keytar for tests
vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn().mockResolvedValue('test-master-key'),
    setPassword: vi.fn().mockResolvedValue(undefined),
    deletePassword: vi.fn().mockResolvedValue(true),
    findCredentials: vi.fn().mockResolvedValue([]),
  },
}));

describe('Crypto Utilities', () => {
  describe('generateToken', () => {
    it('should generate token of specified length', () => {
      const token = generateToken(16);
      expect(token).toHaveLength(32); // hex encoding doubles length
    });

    it('should generate unique tokens', () => {
      const token1 = generateToken();
      const token2 = generateToken();
      expect(token1).not.toBe(token2);
    });
  });

  describe('hashToken', () => {
    it('should produce consistent hash', () => {
      const token = 'test-token';
      const hash1 = hashToken(token);
      const hash2 = hashToken(token);
      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different tokens', () => {
      const hash1 = hashToken('token1');
      const hash2 = hashToken('token2');
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('secureCompare', () => {
    it('should return true for equal strings', () => {
      expect(secureCompare('test', 'test')).toBe(true);
    });

    it('should return false for different strings', () => {
      expect(secureCompare('test1', 'test2')).toBe(false);
    });

    it('should return false for different lengths', () => {
      expect(secureCompare('short', 'longer-string')).toBe(false);
    });
  });

  describe('generateSalt', () => {
    it('should generate salt of specified length', () => {
      const salt = generateSalt(16);
      expect(salt).toHaveLength(16);
    });

    it('should generate unique salts', () => {
      const salt1 = generateSalt();
      const salt2 = generateSalt();
      expect(salt1.equals(salt2)).toBe(false);
    });
  });
});

describe('Database salt persistence', () => {
  const testDir = join(tmpdir(), 'lain-test-salt');
  const dbPath = join(testDir, 'test.db');
  const saltPath = `${dbPath}.salt`;
  const originalEnv = process.env['LAIN_HOME'];

  beforeEach(async () => {
    process.env['LAIN_HOME'] = testDir;
    await rm(testDir, { recursive: true, force: true });
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    closeDatabase();
    if (originalEnv) {
      process.env['LAIN_HOME'] = originalEnv;
    } else {
      delete process.env['LAIN_HOME'];
    }
    try {
      await rm(testDir, { recursive: true });
    } catch {
      // Ignore
    }
  });

  it('creates a salt file alongside the DB on first init', async () => {
    await initDatabase(dbPath);
    const info = await stat(saltPath);
    expect(info.isFile()).toBe(true);

    const saltHex = (await readFile(saltPath, 'utf8')).trim();
    // 16 bytes = 32 hex chars
    expect(saltHex).toMatch(/^[0-9a-f]{32}$/);
  });

  it('reuses the same salt across close/reopen cycles', async () => {
    await initDatabase(dbPath);
    const firstSalt = (await readFile(saltPath, 'utf8')).trim();

    closeDatabase();

    await initDatabase(dbPath);
    const secondSalt = (await readFile(saltPath, 'utf8')).trim();

    expect(secondSalt).toBe(firstSalt);
  });

  it('does not overwrite an existing salt file', async () => {
    // Simulate an existing DB from a prior boot with a known salt.
    const { writeFile } = await import('node:fs/promises');
    const knownSalt = 'deadbeefcafebabe0123456789abcdef';
    await writeFile(saltPath, knownSalt, 'utf8');

    await initDatabase(dbPath);

    const saltAfter = (await readFile(saltPath, 'utf8')).trim();
    expect(saltAfter).toBe(knownSalt);
  });
});

// findings.md P2:1110 — the budget's monthly token counter relies on
// this helper to avoid read-modify-write races between parallel loops.
// The logic that used to live in budget.ts (reset on month change, add
// delta to existing tokens, create fresh row) now lives inside a single
// SQLite statement, so it needs real-DB coverage — mocks can't exercise
// `INSERT ... ON CONFLICT ... json_set ...` semantics.
describe('atomicMetaIncrementCounter', () => {
  const testDir = join(tmpdir(), 'lain-test-atomic-meta');
  const dbPath = join(testDir, 'test.db');
  const originalEnv = process.env['LAIN_HOME'];

  beforeEach(async () => {
    process.env['LAIN_HOME'] = testDir;
    await mkdir(testDir, { recursive: true });
    await initDatabase(dbPath);
  });

  afterEach(async () => {
    closeDatabase();
    if (originalEnv) {
      process.env['LAIN_HOME'] = originalEnv;
    } else {
      delete process.env['LAIN_HOME'];
    }
    try {
      await rm(testDir, { recursive: true });
    } catch {
      // Ignore
    }
  });

  function incr(month: string, delta: number): string {
    return atomicMetaIncrementCounter({
      key: 'budget:monthly_usage',
      freshJson: JSON.stringify({ month, tokens: delta }),
      periodField: 'month',
      periodValue: month,
      counterField: 'tokens',
      delta,
    });
  }

  it('inserts fresh row when key absent', () => {
    const result = incr('2026-04', 150);
    expect(JSON.parse(result)).toEqual({ month: '2026-04', tokens: 150 });
    expect(JSON.parse(getMeta('budget:monthly_usage')!)).toEqual({
      month: '2026-04',
      tokens: 150,
    });
  });

  it('adds delta when period matches', () => {
    incr('2026-04', 150);
    const result = incr('2026-04', 200);
    expect(JSON.parse(result)).toEqual({ month: '2026-04', tokens: 350 });
  });

  it('overwrites with fresh row when period changed', () => {
    incr('2026-03', 500);
    const result = incr('2026-04', 100);
    expect(JSON.parse(result)).toEqual({ month: '2026-04', tokens: 100 });
  });

  it('handles zero-delta increment without mutating counter', () => {
    incr('2026-04', 100);
    const result = incr('2026-04', 0);
    expect(JSON.parse(result)).toEqual({ month: '2026-04', tokens: 100 });
  });

  it('serialized bursts accumulate correctly (proxy for atomicity contract)', () => {
    for (let i = 0; i < 100; i++) incr('2026-04', 7);
    expect(JSON.parse(getMeta('budget:monthly_usage')!)).toEqual({
      month: '2026-04',
      tokens: 700,
    });
  });
});

describe('Session Storage', () => {
  const testDir = join(tmpdir(), 'lain-test-storage');
  const dbPath = join(testDir, 'test.db');
  const originalEnv = process.env['LAIN_HOME'];

  beforeEach(async () => {
    process.env['LAIN_HOME'] = testDir;
    await mkdir(testDir, { recursive: true });
    await initDatabase(dbPath);
  });

  afterEach(async () => {
    closeDatabase();
    if (originalEnv) {
      process.env['LAIN_HOME'] = originalEnv;
    } else {
      delete process.env['LAIN_HOME'];
    }
    try {
      await rm(testDir, { recursive: true });
    } catch {
      // Ignore
    }
  });

  describe('createSession', () => {
    it('should create a new session', () => {
      const session = createSession({
        agentId: 'default',
        channel: 'cli',
        peerKind: 'user',
        peerId: 'user-1',
      });

      expect(session.key).toBeDefined();
      expect(session.agentId).toBe('default');
      expect(session.channel).toBe('cli');
      expect(session.peerKind).toBe('user');
      expect(session.peerId).toBe('user-1');
      expect(session.tokenCount).toBe(0);
    });
  });

  describe('getSession', () => {
    it('should retrieve existing session', () => {
      const created = createSession({
        agentId: 'default',
        channel: 'cli',
        peerKind: 'user',
        peerId: 'user-1',
      });

      const retrieved = getSession(created.key);

      expect(retrieved).toBeDefined();
      expect(retrieved?.key).toBe(created.key);
    });

    it('should return undefined for non-existent session', () => {
      const session = getSession('non-existent');
      expect(session).toBeUndefined();
    });
  });

  describe('findSession', () => {
    it('should find session by agent, channel, and peer', () => {
      const created = createSession({
        agentId: 'default',
        channel: 'telegram',
        peerKind: 'user',
        peerId: 'tg-user-123',
      });

      const found = findSession('default', 'telegram', 'tg-user-123');

      expect(found).toBeDefined();
      expect(found?.key).toBe(created.key);
    });

    it('should return undefined when not found', () => {
      const found = findSession('default', 'telegram', 'non-existent');
      expect(found).toBeUndefined();
    });
  });

  describe('updateSession', () => {
    it('should update session fields', () => {
      const session = createSession({
        agentId: 'default',
        channel: 'cli',
        peerKind: 'user',
        peerId: 'user-1',
      });

      const updated = updateSession(session.key, {
        tokenCount: 100,
        flags: { summarized: true },
      });

      expect(updated?.tokenCount).toBe(100);
      expect(updated?.flags.summarized).toBe(true);
    });

    it('should return undefined for non-existent session', () => {
      const result = updateSession('non-existent', { tokenCount: 100 });
      expect(result).toBeUndefined();
    });
  });

  describe('deleteSession', () => {
    it('should delete existing session', () => {
      const session = createSession({
        agentId: 'default',
        channel: 'cli',
        peerKind: 'user',
        peerId: 'user-1',
      });

      const deleted = deleteSession(session.key);
      expect(deleted).toBe(true);

      const retrieved = getSession(session.key);
      expect(retrieved).toBeUndefined();
    });

    it('should return false for non-existent session', () => {
      const deleted = deleteSession('non-existent');
      expect(deleted).toBe(false);
    });

    // findings.md P2:368 — deleteSession must remove the session's
    // `messages` rows in the same transaction but leave long-term
    // `memories` intact (memories are character state, not session
    // transcript). Test inserts rows directly via the DB layer to stay
    // focused on the session-delete invariant rather than pulling in
    // saveMemory's palace-assignment side effects.
    it('deletes the session\'s messages but preserves its memories', async () => {
      const { query, execute } = await import('../src/storage/database.js');
      const session = createSession({
        agentId: 'default',
        channel: 'cli',
        peerKind: 'user',
        peerId: 'p2-368-user',
      });

      execute(
        'INSERT INTO messages (id, session_key, role, content, timestamp, metadata) VALUES (?, ?, ?, ?, ?, ?)',
        ['msg-p2-368', session.key, 'user', 'hello', Date.now(), '{}'],
      );
      execute(
        'INSERT INTO memories (id, session_key, content, memory_type, importance, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['mem-p2-368', session.key, 'long-term fact', 'fact', 0.9, Date.now(), '{}'],
      );

      expect(deleteSession(session.key)).toBe(true);

      const msgsAfter = query<{ id: string }>(
        'SELECT id FROM messages WHERE session_key = ?',
        [session.key],
      );
      expect(msgsAfter).toHaveLength(0);

      const memsAfter = query<{ id: string; content: string }>(
        'SELECT id, content FROM memories WHERE id = ?',
        ['mem-p2-368'],
      );
      expect(memsAfter).toHaveLength(1);
      expect(memsAfter[0]!.content).toBe('long-term fact');
    });
  });

  // findings.md P2:368 — bulk cleanup must behave the same way.
  describe('deleteOldSessions', () => {
    it('deletes old sessions + messages but preserves memories and newer sessions', async () => {
      const { deleteOldSessions } = await import('../src/storage/sessions.js');
      const { query, execute } = await import('../src/storage/database.js');

      const oldSession = createSession({
        agentId: 'cleanup-agent',
        channel: 'cli',
        peerKind: 'user',
        peerId: 'old-user',
      });
      const freshSession = createSession({
        agentId: 'cleanup-agent',
        channel: 'cli',
        peerKind: 'user',
        peerId: 'fresh-user',
      });

      // Rewind the old session's updated_at so it falls past the cutoff.
      execute('UPDATE sessions SET updated_at = ? WHERE key = ?', [1000, oldSession.key]);

      execute(
        'INSERT INTO messages (id, session_key, role, content, timestamp, metadata) VALUES (?, ?, ?, ?, ?, ?)',
        ['msg-stale', oldSession.key, 'user', 'stale', Date.now(), '{}'],
      );
      execute(
        'INSERT INTO messages (id, session_key, role, content, timestamp, metadata) VALUES (?, ?, ?, ?, ?, ?)',
        ['msg-fresh', freshSession.key, 'user', 'fresh', Date.now(), '{}'],
      );
      execute(
        'INSERT INTO memories (id, session_key, content, memory_type, importance, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['mem-from-old', oldSession.key, 'survives', 'fact', 0.8, Date.now(), '{}'],
      );

      const removed = deleteOldSessions('cleanup-agent', 60_000);
      expect(removed).toBe(1);

      // Fresh session untouched.
      expect(getSession(freshSession.key)).toBeDefined();
      const freshMsgs = query<{ id: string }>(
        'SELECT id FROM messages WHERE session_key = ?',
        [freshSession.key],
      );
      expect(freshMsgs).toHaveLength(1);

      // Old session + its messages gone.
      expect(getSession(oldSession.key)).toBeUndefined();
      const orphanMsgs = query<{ id: string }>(
        'SELECT id FROM messages WHERE session_key = ?',
        [oldSession.key],
      );
      expect(orphanMsgs).toHaveLength(0);

      // Memory survives — it is long-term character state.
      const surviving = query<{ id: string }>(
        'SELECT id FROM memories WHERE id = ?',
        ['mem-from-old'],
      );
      expect(surviving).toHaveLength(1);
    });
  });

  describe('listSessions', () => {
    it('should list sessions for an agent', () => {
      createSession({
        agentId: 'agent-1',
        channel: 'cli',
        peerKind: 'user',
        peerId: 'user-1',
      });

      createSession({
        agentId: 'agent-1',
        channel: 'telegram',
        peerKind: 'user',
        peerId: 'user-2',
      });

      createSession({
        agentId: 'agent-2',
        channel: 'cli',
        peerKind: 'user',
        peerId: 'user-3',
      });

      const sessions = listSessions('agent-1');
      expect(sessions).toHaveLength(2);
    });

    it('should filter by channel', () => {
      createSession({
        agentId: 'agent-1',
        channel: 'cli',
        peerKind: 'user',
        peerId: 'user-1',
      });

      createSession({
        agentId: 'agent-1',
        channel: 'telegram',
        peerKind: 'user',
        peerId: 'user-2',
      });

      const sessions = listSessions('agent-1', { channel: 'cli' });
      expect(sessions).toHaveLength(1);
    });
  });

  describe('countSessions', () => {
    it('should count sessions for an agent', () => {
      createSession({
        agentId: 'agent-1',
        channel: 'cli',
        peerKind: 'user',
        peerId: 'user-1',
      });

      createSession({
        agentId: 'agent-1',
        channel: 'telegram',
        peerKind: 'user',
        peerId: 'user-2',
      });

      const count = countSessions('agent-1');
      expect(count).toBe(2);
    });
  });
});
