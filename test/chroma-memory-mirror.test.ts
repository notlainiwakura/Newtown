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

vi.mock('../src/memory/embeddings.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/memory/embeddings.js')>();
  return {
    ...original,
    generateEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
  };
});

const envKeys = [
  'LAIN_HOME',
  'LAIN_CHARACTER_ID',
  'CHROMA_MIRROR_ENABLED',
  'CHROMA_BASE_URL',
  'CHROMA_TENANT',
  'CHROMA_DATABASE',
  'CHROMA_COLLECTION_PREFIX',
  'CHROMA_TIMEOUT_MS',
] as const;

const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

describe('Chroma mirror helpers', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    const { clearChromaCollectionCache } = await import('../src/memory/chroma.js');
    clearChromaCollectionCache();
  });

  afterEach(async () => {
    const { clearChromaCollectionCache } = await import('../src/memory/chroma.js');
    clearChromaCollectionCache();
    restoreEnv();
  });

  it('builds config and a sanitized per-character collection name from env', async () => {
    process.env['CHROMA_MIRROR_ENABLED'] = '1';
    process.env['CHROMA_BASE_URL'] = 'http://192.168.68.69:8001/';
    process.env['CHROMA_TENANT'] = 'default_tenant';
    process.env['CHROMA_DATABASE'] = 'default_database';
    process.env['CHROMA_COLLECTION_PREFIX'] = 'Newtown Memory';
    process.env['CHROMA_TIMEOUT_MS'] = '5500';

    const { getChromaMirrorConfig, resolveChromaCollectionName } = await import('../src/memory/chroma.js');
    const config = getChromaMirrorConfig();

    expect(config).toEqual({
      baseUrl: 'http://192.168.68.69:8001',
      tenant: 'default_tenant',
      database: 'default_database',
      collectionPrefix: 'newtown-memory',
      timeoutMs: 5500,
    });
    expect(resolveChromaCollectionName('Neo Smith')).toBe('newtown-memory-neo-smith');
  });

  it('sanitizes nested metadata into Chroma-safe scalar fields', async () => {
    const { sanitizeChromaMetadata } = await import('../src/memory/chroma.js');

    expect(sanitizeChromaMetadata({
      mood: 'calm',
      score: 0.75,
      tags: ['wake', 'mirror'],
      flags: [true, false],
      nested: { phase: 'dawn' },
      mixed: ['neo', 1],
      missing: null,
    })).toEqual({
      mood: 'calm',
      score: 0.75,
      tags: ['wake', 'mirror'],
      flags: [true, false],
      nested: JSON.stringify({ phase: 'dawn' }),
      mixed: JSON.stringify(['neo', 1]),
    });
  });

  it('creates a collection once and upserts mirrored records', async () => {
    process.env['CHROMA_MIRROR_ENABLED'] = '1';
    process.env['CHROMA_BASE_URL'] = 'http://chroma.test';
    process.env['CHROMA_COLLECTION_PREFIX'] = 'newtown-memory';

    const fetchMock = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/collections')) {
        return new Response(JSON.stringify({ id: 'collection-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url.endsWith('/collections/collection-1/upsert')) {
        return new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response('not found', { status: 404 });
    });

    const { mirrorMemoryToChroma } = await import('../src/memory/chroma.js');

    const baseMemory = {
      id: 'memory-1',
      characterId: 'neo',
      sessionKey: 'chat:user-1',
      userId: 'user-1',
      content: 'There is no spoon.',
      memoryType: 'fact' as const,
      importance: 0.95,
      emotionalWeight: 0.2,
      embedding: new Float32Array([0.1, 0.2, 0.3]),
      createdAt: 1_700_000_000_000,
      relatedTo: null,
      sourceMessageId: 'msg-1',
      metadata: { topic: 'simulation', nested: { certainty: 'high' } },
      lifecycleState: 'seed',
      phase: null,
      wingId: 'wing-1',
      roomId: 'room-1',
      hall: 'fact-hall',
    };

    await mirrorMemoryToChroma(baseMemory, { fetchImpl: fetchMock, logger: { debug: vi.fn() } });
    await mirrorMemoryToChroma({ ...baseMemory, id: 'memory-2' }, { fetchImpl: fetchMock, logger: { debug: vi.fn() } });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'http://chroma.test/api/v2/tenants/default_tenant/databases/default_database/collections'
    );

    const firstUpsert = fetchMock.mock.calls[1];
    expect(String(firstUpsert?.[0])).toBe(
      'http://chroma.test/api/v2/tenants/default_tenant/databases/default_database/collections/collection-1/upsert'
    );
    const upsertBody = JSON.parse(String(firstUpsert?.[1]?.body)) as {
      ids: string[];
      documents: string[];
      metadatas: Array<Record<string, unknown>>;
    };
    expect(upsertBody.ids).toEqual(['memory-1']);
    expect(upsertBody.documents).toEqual(['There is no spoon.']);
    expect(upsertBody.metadatas[0]?.characterId).toBe('neo');
    expect(upsertBody.metadatas[0]?.meta_nested).toBe(JSON.stringify({ certainty: 'high' }));
  });
});

describe('saveMemory with Chroma mirroring', () => {
  let testDir = '';

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    testDir = join(tmpdir(), `newtown-chroma-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env['LAIN_HOME'] = testDir;
    process.env['LAIN_CHARACTER_ID'] = 'neo';
    process.env['CHROMA_MIRROR_ENABLED'] = '1';
    process.env['CHROMA_BASE_URL'] = 'http://chroma.test';
    await mkdir(testDir, { recursive: true });

    const { initDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(testDir, 'test.db'));

    const { clearChromaCollectionCache } = await import('../src/memory/chroma.js');
    clearChromaCollectionCache();
  });

  afterEach(async () => {
    const { closeDatabase } = await import('../src/storage/database.js');
    closeDatabase();

    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup failures in tests
    }

    restoreEnv();
  });

  it('keeps the local memory save working when the Chroma mirror fails', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => new Response('boom', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    const { saveMemory, getMemory } = await import('../src/memory/store.js');
    const id = await saveMemory({
      sessionKey: 'chat:user-1',
      userId: 'user-1',
      content: 'Joe wants a quiet afternoon at the pub.',
      memoryType: 'episode',
      importance: 0.6,
      emotionalWeight: 0.1,
      relatedTo: null,
      sourceMessageId: null,
      metadata: { building: 'pub' },
    });

    const stored = getMemory(id);
    expect(stored).toBeDefined();
    expect(stored?.content).toBe('Joe wants a quiet afternoon at the pub.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function restoreEnv(): void {
  for (const key of envKeys) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  vi.unstubAllGlobals();
}
