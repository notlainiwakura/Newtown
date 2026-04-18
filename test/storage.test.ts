/**
 * Storage tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
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
