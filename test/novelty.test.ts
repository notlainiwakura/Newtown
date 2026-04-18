import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { join } from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  expandTemplate,
  pickRandom,
  pickRandomBuilding,
  pickRandomTime,
  loadStaticFragments,
  truncateToSentence,
  pickFragment,
  generateAmbientEvent,
  generateMajorEvent,
  isMajorLimitReached,
  recordMajorFiring,
  loadNoveltyConfig,
} from '../src/agent/novelty.js';
import {
  initDatabase,
  closeDatabase,
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

describe('Template Engine', () => {
  it('should expand a template with all placeholders filled', () => {
    const template = 'A small {object} was found near the {building}. {detail}';
    const fills: Record<string, string> = {
      object: 'glass lens',
      building: 'Library',
      detail: 'It was warm to the touch.',
    };
    const result = expandTemplate(template, fills);
    expect(result).toBe('A small glass lens was found near the Library. It was warm to the touch.');
  });

  it('should leave unfilled placeholders as-is', () => {
    const result = expandTemplate('Found near {building}: {fragment}', { building: 'Bar' });
    expect(result).toBe('Found near Bar: {fragment}');
  });

  it('should pick a random item from a pool', () => {
    const pool = ['a', 'b', 'c'];
    const result = pickRandom(pool);
    expect(pool).toContain(result);
  });

  it('should pick a random building name', () => {
    const name = pickRandomBuilding();
    expect(typeof name).toBe('string');
    expect(name.length).toBeGreaterThan(0);
  });

  it('should generate a random time string', () => {
    const time = pickRandomTime();
    expect(typeof time).toBe('string');
    expect(time.length).toBeGreaterThan(0);
  });
});

describe('Source Fetcher', () => {
  const testDir = join(tmpdir(), `lain-test-novelty-source-${Date.now()}`);

  beforeAll(async () => {
    await mkdir(join(testDir, 'novelty'), { recursive: true });
    await writeFile(
      join(testDir, 'novelty', 'fragments.json'),
      JSON.stringify({ fragments: ['test fragment one', 'test fragment two', 'test fragment three'] })
    );
    await writeFile(
      join(testDir, 'novelty', 'sources.json'),
      JSON.stringify({ rss: [], wikipedia: { enabled: false, endpoint: '' } })
    );
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('should load static fragments from a directory', async () => {
    const fragments = await loadStaticFragments(testDir);
    expect(fragments).toEqual(['test fragment one', 'test fragment two', 'test fragment three']);
  });

  it('should pick a fragment from static pool when external sources are disabled', async () => {
    const fragment = await pickFragment(testDir, { rss: 0, wikipedia: 0, static: 1.0 });
    expect(['test fragment one', 'test fragment two', 'test fragment three']).toContain(fragment);
  });

  it('should truncate long fragments to sentence boundaries', () => {
    const long = 'This is the first sentence. This is the second sentence. This is the third sentence that goes on for a while.';
    const result = truncateToSentence(long, 60);
    expect(result).toBe('This is the first sentence. This is the second sentence.');
  });

  it('should return the whole string if under the limit', () => {
    const short = 'A brief thought.';
    expect(truncateToSentence(short, 200)).toBe('A brief thought.');
  });
});

describe('Event Generator', () => {
  const testDir = join(tmpdir(), `lain-test-novelty-gen-${Date.now()}`);

  beforeAll(async () => {
    await mkdir(join(testDir, 'novelty'), { recursive: true });
    await writeFile(join(testDir, 'novelty', 'fragments.json'), JSON.stringify({
      fragments: ['test fragment'],
    }));
    await writeFile(join(testDir, 'novelty', 'sources.json'), JSON.stringify({
      rss: [], wikipedia: { enabled: false, endpoint: '' },
    }));
    await writeFile(join(testDir, 'novelty', 'ambient-templates.json'), JSON.stringify({
      staticPools: {
        object: ['glass lens'],
        detail: ['It hummed faintly.'],
        sensory_detail: ['copper and ozone'],
      },
      templates: [{
        id: 'test-01',
        category: 'found-object',
        template: 'A {object} was found near the {building}. {detail}',
        placeholders: ['object', 'building', 'detail'],
      }],
    }));
    await writeFile(join(testDir, 'novelty', 'major-seeds.json'), JSON.stringify({
      seeds: [{
        id: 'test-major-01',
        name: 'Test Event',
        template: 'Something happened at the {building}: "{fragment}"',
      }],
    }));
    await writeFile(join(testDir, 'novelty', 'config.json'), JSON.stringify({
      enabled: true,
      ambient: {
        checkIntervalMs: 1800000,
        fireChance: 0.10,
        maxPerDayPerCharacter: 3,
        targetCount: [1, 2],
      },
      major: {
        checkIntervalMs: 1800000,
        fireChance: 0.03,
        maxPerWeek: 3,
      },
      categoryDurations: {
        'found-object': 86400000,
        'major-default': 43200000,
      },
      peers: [],
      sources: {
        refreshIntervalMs: 14400000,
        cacheSize: 20,
        weights: { rss: 0.4, wikipedia: 0.3, static: 0.3 },
      },
    }));
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('should generate an ambient event with all placeholders filled', async () => {
    const event = await generateAmbientEvent(testDir);
    expect(event).toBeDefined();
    expect(event.content).toBeDefined();
    expect(event.content).not.toContain('{');
    expect(event.templateId).toBe('test-01');
    expect(event.category).toBe('ambient');
  });

  it('should generate a major event with all placeholders filled', async () => {
    const event = await generateMajorEvent(testDir);
    expect(event).toBeDefined();
    expect(event.content).toBeDefined();
    expect(event.content).not.toContain('{');
    expect(event.seedId).toBe('test-major-01');
    expect(event.category).toBe('major');
  });

  it('ambient event carries persistMs from category config', async () => {
    const config = await loadNoveltyConfig(testDir);
    const event = await generateAmbientEvent(testDir, config);
    expect(event.persistMs).toBe(86400000); // found-object category
  });

  it('major event carries persistMs from seed or default', async () => {
    const config = await loadNoveltyConfig(testDir);
    const event = await generateMajorEvent(testDir, config);
    expect(event.persistMs).toBe(43200000); // major-default (no seed override)
  });
});

describe('Rate Limiting', () => {
  const testDir = join(tmpdir(), `lain-test-novelty-rate-${Date.now()}`);
  const dbPath = join(testDir, 'lain.db');
  const originalEnv = process.env['LAIN_HOME'];

  beforeAll(async () => {
    await mkdir(testDir, { recursive: true });
    process.env['LAIN_HOME'] = testDir;
    await initDatabase(dbPath);
  });

  afterAll(async () => {
    closeDatabase();
    if (originalEnv) {
      process.env['LAIN_HOME'] = originalEnv;
    } else {
      delete process.env['LAIN_HOME'];
    }
    await rm(testDir, { recursive: true, force: true });
  });

  it('should check if major limit is reached', () => {
    expect(isMajorLimitReached(2)).toBe(false);
    recordMajorFiring();
    expect(isMajorLimitReached(2)).toBe(false);
    recordMajorFiring();
    expect(isMajorLimitReached(2)).toBe(true);
  });
});

describe('No planted memory channel', () => {
  it('does not export injection functions', async () => {
    const novelty = await import('../src/agent/novelty.js');
    expect('validateInjectPayload' in novelty).toBe(false);
    expect('buildInjectPayload' in novelty).toBe(false);
    expect('deliverEvent' in novelty).toBe(false);
    expect('pickTargets' in novelty).toBe(false);
  });
});

describe('Novelty Config', () => {
  const testDir = join(tmpdir(), `lain-test-novelty-loop-${Date.now()}`);

  beforeAll(async () => {
    await mkdir(join(testDir, 'novelty'), { recursive: true });
    await writeFile(join(testDir, 'novelty', 'config.json'), JSON.stringify({
      enabled: true,
      ambient: {
        checkIntervalMs: 1800000,
        fireChance: 0.10,
        maxPerDayPerCharacter: 3,
        targetCount: [1, 2],
      },
      major: {
        checkIntervalMs: 1800000,
        fireChance: 0.03,
        maxPerWeek: 3,
      },
      categoryDurations: {
        'sound': 3600000,
        'found-object': 86400000,
        'major-default': 43200000,
      },
      peers: [
        { id: 'test-char', name: 'Test', url: 'http://localhost:9999' },
      ],
      sources: {
        refreshIntervalMs: 14400000,
        cacheSize: 20,
        weights: { rss: 0.4, wikipedia: 0.3, static: 0.3 },
      },
    }));
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('should load novelty config with categoryDurations', async () => {
    const config = await loadNoveltyConfig(testDir);
    expect(config.enabled).toBe(true);
    expect(config.ambient.fireChance).toBe(0.10);
    expect(config.major.maxPerWeek).toBe(3);
    expect(config.categoryDurations['found-object']).toBe(86400000);
    expect(config.categoryDurations['sound']).toBe(3600000);
  });
});
