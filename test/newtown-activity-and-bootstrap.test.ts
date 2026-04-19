import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn().mockResolvedValue('test-master-key'),
    setPassword: vi.fn().mockResolvedValue(undefined),
    deletePassword: vi.fn().mockResolvedValue(true),
    findCredentials: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../src/memory/embeddings.js', () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
  cosineSimilarity: vi.fn().mockReturnValue(0.85),
  serializeEmbedding: vi.fn((arr: Float32Array) => Buffer.from(arr.buffer)),
  deserializeEmbedding: vi.fn((buf: Buffer) => new Float32Array(buf.buffer)),
}));

async function createTestDb(): Promise<string> {
  const testDir = join(tmpdir(), `newtown-activity-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(testDir, { recursive: true });
  process.env['LAIN_HOME'] = testDir;
  const { initDatabase } = await import('../src/storage/database.js');
  await initDatabase(join(testDir, 'newtown.db'));
  return testDir;
}

async function teardownTestDb(testDir: string, originalHome: string | undefined): Promise<void> {
  const { closeDatabase } = await import('../src/storage/database.js');
  closeDatabase();
  if (originalHome !== undefined) {
    process.env['LAIN_HOME'] = originalHome;
  } else {
    delete process.env['LAIN_HOME'];
  }
  try {
    await rm(testDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures in tests
  }
}

describe('Newtown activity feed and bootstrap seeds', () => {
  let testDir = '';
  let originalHome: string | undefined;

  beforeEach(async () => {
    originalHome = process.env['LAIN_HOME'];
    testDir = await createTestDb();
  });

  afterEach(async () => {
    await teardownTestDb(testDir, originalHome);
  });

  it('can include resident chat sessions when explicitly requested', async () => {
    const { saveMessage, getActivity } = await import('../src/memory/store.js');
    const now = Date.now();

    saveMessage({
      sessionKey: 'neo:session-1',
      userId: null,
      role: 'user',
      content: 'hello neo',
      timestamp: now,
      metadata: {},
    });
    saveMessage({
      sessionKey: 'stranger:neo:session-2',
      userId: null,
      role: 'assistant',
      content: 'who goes there',
      timestamp: now + 1,
      metadata: {},
    });

    const defaultActivity = getActivity(now - 1000, now + 1000, 50);
    expect(defaultActivity.some((entry) => entry.sessionKey === 'neo:session-1')).toBe(false);

    const chatActivity = getActivity(now - 1000, now + 1000, 50, {
      includeVisitorChat: true,
      chatPrefixes: ['neo'],
    });
    expect(chatActivity.some((entry) => entry.sessionKey === 'neo:session-1')).toBe(true);
    expect(chatActivity.some((entry) => entry.sessionKey === 'stranger:neo:session-2')).toBe(true);
  });

  it('ships starter self concepts and letters for all Newtown residents', async () => {
    const {
      INITIAL_SELF_CONCEPTS,
      RESIDENT_CHATS,
      RESIDENT_LETTERS,
    } = await import('../src/scripts/bootstrap-data.js');

    for (const resident of ['neo', 'plato', 'joe'] as const) {
      expect(INITIAL_SELF_CONCEPTS[resident]).toBeTruthy();
      expect(INITIAL_SELF_CONCEPTS[resident]!.length).toBeGreaterThan(40);
      expect(Array.isArray(RESIDENT_LETTERS[resident])).toBe(true);
      expect(RESIDENT_LETTERS[resident]!.length).toBeGreaterThan(0);
      expect(RESIDENT_LETTERS[resident]![0]!.content.length).toBeGreaterThan(40);
      expect(Array.isArray(RESIDENT_CHATS[resident])).toBe(true);
      expect(RESIDENT_CHATS[resident]!.length).toBeGreaterThan(1);
      expect(RESIDENT_CHATS[resident]![0]!.content.length).toBeGreaterThan(10);
    }
  });
});
