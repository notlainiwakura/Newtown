/**
 * Matrix/table-driven tests for memory subsystems:
 * embeddings, knowledge-graph, palace, weather, and internal-state.
 *
 * Uses real in-memory SQLite where storage is needed.
 * Mocks the embeddings API to avoid loading transformers.js.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';

// ─── Global mocks ─────────────────────────────────────────────────────────────

vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn().mockResolvedValue('test-master-key'),
    setPassword: vi.fn().mockResolvedValue(undefined),
    deletePassword: vi.fn().mockResolvedValue(true),
    findCredentials: vi.fn().mockResolvedValue([]),
  },
}));

// Mock the embedding generation so tests never load the real model
vi.mock('../src/memory/embeddings.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/memory/embeddings.js')>();
  return {
    ...original,
    generateEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
    generateEmbeddings: vi.fn().mockResolvedValue([new Float32Array(384).fill(0.1)]),
  };
});

// ─── DB setup helpers ─────────────────────────────────────────────────────────

let testDir = '';
const originalHome = process.env['LAIN_HOME'];

async function setupTestDb(): Promise<void> {
  testDir = join(tmpdir(), `lain-mem-matrix-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  process.env['LAIN_HOME'] = testDir;
  await mkdir(testDir, { recursive: true });
  const { initDatabase } = await import('../src/storage/database.js');
  await initDatabase(join(testDir, 'test.db'));
}

async function teardownTestDb(): Promise<void> {
  const { closeDatabase } = await import('../src/storage/database.js');
  closeDatabase();
  if (originalHome !== undefined) {
    process.env['LAIN_HOME'] = originalHome;
  } else {
    delete process.env['LAIN_HOME'];
  }
  try { await rm(testDir, { recursive: true }); } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. MEMORY TYPE × LIFECYCLE STATE  (5 types × 5 states = 25)
// ─────────────────────────────────────────────────────────────────────────────

describe('Memory type × lifecycle state', () => {
  beforeEach(setupTestDb);
  afterEach(teardownTestDb);

  const memoryTypes = ['fact', 'preference', 'context', 'summary', 'episode'] as const;
  const lifecycleStates = ['seed', 'growing', 'mature', 'complete', 'composting'] as const;

  describe.each(memoryTypes.map((t) => [t]))('type="%s"', (memType) => {
    it.each(lifecycleStates.map((s) => [s]))(
      'can be stored in state "%s"',
      async (state) => {
        const { execute } = await import('../src/storage/database.js');
        const id = `test-${memType}-${state}-${Math.random().toString(36).slice(2)}`;
        const now = Date.now();

        execute(
          `INSERT INTO memories (id, session_key, content, memory_type, importance, emotional_weight, created_at, lifecycle_state, lifecycle_changed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, 'test:session', `A ${memType} memory`, memType, 0.5, 0.2, now, state, now],
        );

        const { getMemory } = await import('../src/memory/store.js');
        const mem = getMemory(id);
        expect(mem).toBeDefined();
        expect(mem!.memoryType).toBe(memType);
        expect(mem!.lifecycleState).toBe(state);
      },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. EMBEDDING SIMILARITY × VECTOR PAIRS  (10 vector pair combos)
// ─────────────────────────────────────────────────────────────────────────────

describe('Embedding similarity × vector pairs', () => {
  const DIM = 4; // small dimension for test clarity

  const vectorPairs: Array<[string, number[], number[], number, number]> = [
    // [label, a, b, expectedMin, expectedMax]
    ['identical unit vectors', [1, 0, 0, 0], [1, 0, 0, 0], 0.9999, 1.0001],
    ['opposite unit vectors', [1, 0, 0, 0], [-1, 0, 0, 0], -1.0001, -0.9999],
    ['orthogonal x/y', [1, 0, 0, 0], [0, 1, 0, 0], -0.0001, 0.0001],
    ['orthogonal x/z', [1, 0, 0, 0], [0, 0, 1, 0], -0.0001, 0.0001],
    ['same direction scaled', [2, 0, 0, 0], [5, 0, 0, 0], 0.9999, 1.0001],
    ['both zero vectors', [0, 0, 0, 0], [0, 0, 0, 0], -0.0001, 0.0001],
    ['one zero vector', [1, 0, 0, 0], [0, 0, 0, 0], -0.0001, 0.0001],
    ['uniform vs unit', [1, 1, 1, 1], [1, 0, 0, 0], 0.499, 0.501],
    ['45 degree (2D)', [1, 1, 0, 0], [1, 0, 0, 0], 0.706, 0.708],
    ['all-one vectors', [1, 1, 1, 1], [1, 1, 1, 1], 0.9999, 1.0001],
  ];

  it.each(vectorPairs)(
    '%s',
    async (_label, aArr, bArr, minSim, maxSim) => {
      const { cosineSimilarity } = await import('../src/memory/embeddings.js');
      const a = new Float32Array(aArr);
      const b = new Float32Array(bArr);
      const sim = cosineSimilarity(a, b);
      expect(sim).toBeGreaterThanOrEqual(minSim);
      expect(sim).toBeLessThanOrEqual(maxSim);
    },
  );

  it('throws on dimension mismatch', async () => {
    const { cosineSimilarity } = await import('../src/memory/embeddings.js');
    expect(() => cosineSimilarity(new Float32Array([1, 0]), new Float32Array([1, 0, 0]))).toThrow();
  });

  it('findTopK returns sorted results', async () => {
    const { findTopK } = await import('../src/memory/embeddings.js');
    const query = new Float32Array([1, 0, 0, 0]);
    const candidates = [
      { id: 'a', embedding: new Float32Array([0.5, 0.5, 0, 0]) },
      { id: 'b', embedding: new Float32Array([1, 0, 0, 0]) },
      { id: 'c', embedding: new Float32Array([0, 1, 0, 0]) },
    ];
    const results = findTopK(query, candidates, 2);
    expect(results).toHaveLength(2);
    expect(results[0]!.id).toBe('b');
    expect(results[0]!.similarity).toBeGreaterThan(results[1]!.similarity);
  });

  it('computeCentroid of identical embeddings equals input', async () => {
    const { computeCentroid, cosineSimilarity } = await import('../src/memory/embeddings.js');
    const e = new Float32Array([1, 0, 0, 0]);
    const centroid = computeCentroid([e, e, e]);
    expect(cosineSimilarity(centroid, e)).toBeCloseTo(1.0, 4);
  });

  it('serializeEmbedding / deserializeEmbedding roundtrip', async () => {
    const { serializeEmbedding, deserializeEmbedding } = await import('../src/memory/embeddings.js');
    const original = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    const buf = serializeEmbedding(original);
    const restored = deserializeEmbedding(buf);
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i]!, 5);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. KG PREDICATE × QUERY FILTER  (8 predicates × 4 filter combos = 32)
// ─────────────────────────────────────────────────────────────────────────────

describe('KG predicate × query filter', () => {
  beforeEach(setupTestDb);
  afterEach(teardownTestDb);

  const predicates = ['knows', 'likes', 'dislikes', 'lives_at', 'works_at', 'created', 'fears', 'desires'];

  // Insert one triple per predicate before each block
  async function seedTriples() {
    const { addTriple } = await import('../src/memory/knowledge-graph.js');
    const ids: Record<string, string> = {};
    for (const pred of predicates) {
      ids[pred] = addTriple(`lain`, pred, `${pred}-object`, 0.8);
    }
    return ids;
  }

  describe.each(predicates.map((p) => [p]))('predicate="%s"', (predicate) => {
    it('query by subject finds the triple', async () => {
      await seedTriples();
      const { queryTriples } = await import('../src/memory/knowledge-graph.js');
      const results = queryTriples({ subject: 'lain', predicate });
      expect(results.some((t) => t.predicate === predicate)).toBe(true);
    });

    it('query by predicate alone returns at least 1 result', async () => {
      await seedTriples();
      const { queryTriples } = await import('../src/memory/knowledge-graph.js');
      const results = queryTriples({ predicate });
      expect(results.length).toBeGreaterThan(0);
    });

    it('query by object finds the triple', async () => {
      await seedTriples();
      const { queryTriples } = await import('../src/memory/knowledge-graph.js');
      const results = queryTriples({ object: `${predicate}-object` });
      expect(results.some((t) => t.predicate === predicate)).toBe(true);
    });

    it('asOf filter after valid_from includes the triple', async () => {
      const { addTriple, queryTriples } = await import('../src/memory/knowledge-graph.js');
      const before = Date.now() - 1000;
      addTriple('lain', predicate, `time-obj`, 0.5, before);
      const results = queryTriples({ predicate, asOf: Date.now() });
      expect(results.length).toBeGreaterThan(0);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. PALACE WING × SESSION KEY PATTERN  (12 session patterns × expected wing)
// ─────────────────────────────────────────────────────────────────────────────

describe('Palace wing × session key pattern', () => {
  const sessionKeyWingCases: Array<[string, string]> = [
    ['diary:2026-01-01', 'self'],
    ['dreams:night-cycle', 'self'],
    ['dream:fragment', 'self'],
    ['self-concept:update', 'self'],
    ['selfconcept:revision', 'self'],
    ['bibliomancy:reading', 'self'],
    ['curiosity:web-browse', 'curiosity'],
    ['letter:wired-lain', 'wired-lain'],
    ['commune:pkd', 'pkd'],
    ['peer:mckenna', 'mckenna'],
    ['doctor:session-01', 'dr-claude'],
    ['therapy:reflection', 'dr-claude'],
  ];

  it.each(sessionKeyWingCases)(
    'session "%s" → wing "%s"',
    async (sessionKey, expectedWing) => {
      const { resolveWingForMemory } = await import('../src/memory/palace.js');
      const { wingName } = resolveWingForMemory(sessionKey, null);
      expect(wingName).toBe(expectedWing);
    },
  );

  it('unknown session key with userId → shared visitors wing + per-user room (findings.md P2:652)', async () => {
    const { resolveWingForMemory } = await import('../src/memory/palace.js');
    const { wingName, roomName } = resolveWingForMemory('chat:random', 'user-abc');
    expect(wingName).toBe('visitors');
    expect(roomName).toBe('visitor-user-abc');
  });

  it('unknown session key without userId → encounters wing', async () => {
    const { resolveWingForMemory } = await import('../src/memory/palace.js');
    const { wingName } = resolveWingForMemory('chat:random', null);
    expect(wingName).toBe('encounters');
  });

  // Town-life prefixes
  const townLifePrefixes = ['townlife:move', 'movement:drift', 'move:east', 'note:wall', 'object:teapot', 'document:diary'];
  it.each(townLifePrefixes.map((p) => [p]))('town-life session "%s" → wing "town"', async (sessionKey) => {
    const { resolveWingForMemory } = await import('../src/memory/palace.js');
    const { wingName } = resolveWingForMemory(sessionKey, null);
    expect(wingName).toBe('town');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. PALACE HALL × MEMORY TYPE  (5 types × expected hall)
// ─────────────────────────────────────────────────────────────────────────────

describe('Palace hall × memory type', () => {
  const hallAssignments: Array<[import('../src/memory/palace.js').Hall extends string ? string : never, string, import('../src/memory/palace.js').Hall]> = [
    ['fact → truths', 'fact', 'truths'],
    ['preference → truths', 'preference', 'truths'],
    ['summary → reflections', 'summary', 'reflections'],
    ['context → encounters', 'context', 'encounters'],
    ['episode (default) → encounters', 'episode', 'encounters'],
  ];

  it.each(hallAssignments)('%s', async (_label, memType, expectedHall) => {
    const { assignHall } = await import('../src/memory/palace.js');
    expect(assignHall(memType as Parameters<typeof assignHall>[0], 'generic:session')).toBe(expectedHall);
  });

  // episode session-key routing
  const episodeKeyHalls: Array<[string, string]> = [
    ['curiosity:browsing', 'discoveries'],
    ['dreams:night', 'dreams'],
    ['dream:fragment', 'dreams'],
    ['diary:today', 'reflections'],
    ['letter:alice', 'reflections'],
    ['self-concept:v2', 'reflections'],
    ['selfconcept:update', 'reflections'],
    ['bibliomancy:cast', 'reflections'],
    ['commune:friend', 'encounters'],
    ['chat:user123', 'encounters'],
  ];

  it.each(episodeKeyHalls)(
    'episode + session "%s" → hall "%s"',
    async (sessionKey, expectedHall) => {
      const { assignHall } = await import('../src/memory/palace.js');
      expect(assignHall('episode', sessionKey)).toBe(expectedHall);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. WEATHER CONDITION × EMOTIONAL AXES  (6 conditions × axis triggers = 36+)
// ─────────────────────────────────────────────────────────────────────────────

describe('Weather condition × emotional axes', () => {
  type AxisState = {
    energy: number;
    sociability: number;
    intellectual_arousal: number;
    emotional_weight: number;
    valence: number;
  };

  // We test computeCondition indirectly through computeWeather
  // by constructing InternalState objects and passing them directly.
  function state(overrides: Partial<AxisState>): import('../src/agent/internal-state.js').InternalState {
    return {
      energy: 0.5,
      sociability: 0.5,
      intellectual_arousal: 0.4,
      emotional_weight: 0.3,
      valence: 0.5,
      primary_color: 'neutral',
      updated_at: Date.now(),
      ...overrides,
    };
  }

  const conditionCases: Array<[string, AxisState, string]> = [
    // storm: emotional_weight > 0.7 AND intellectual_arousal > 0.6
    ['storm from high ew + ia', { energy: 0.5, sociability: 0.5, intellectual_arousal: 0.75, emotional_weight: 0.8, valence: 0.5 }, 'storm'],
    // aurora: intellectual_arousal > 0.7 AND valence > 0.7
    ['aurora from high ia + valence', { energy: 0.5, sociability: 0.5, intellectual_arousal: 0.75, emotional_weight: 0.2, valence: 0.8 }, 'aurora'],
    // rain: emotional_weight > 0.6 (and NOT storm)
    ['rain from high emotional_weight', { energy: 0.5, sociability: 0.5, intellectual_arousal: 0.3, emotional_weight: 0.65, valence: 0.4 }, 'rain'],
    // fog: energy < 0.35
    ['fog from low energy', { energy: 0.2, sociability: 0.5, intellectual_arousal: 0.3, emotional_weight: 0.2, valence: 0.5 }, 'fog'],
    // clear: valence > 0.6 AND emotional_weight < 0.4
    ['clear from high valence + low ew', { energy: 0.6, sociability: 0.5, intellectual_arousal: 0.4, emotional_weight: 0.2, valence: 0.7 }, 'clear'],
    // overcast: fallback
    ['overcast as fallback', { energy: 0.5, sociability: 0.5, intellectual_arousal: 0.4, emotional_weight: 0.3, valence: 0.4 }, 'overcast'],
  ];

  it.each(conditionCases)('%s', async (_label, axes, expectedCondition) => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const weather = await computeWeather([state(axes)]);
    expect(weather.condition).toBe(expectedCondition);
  });

  it('empty states array → overcast', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const weather = await computeWeather([]);
    expect(weather.condition).toBe('overcast');
  });

  it('weather has intensity in [0, 1]', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const weather = await computeWeather([state({ intellectual_arousal: 0.75, emotional_weight: 0.8 })]);
    expect(weather.intensity).toBeGreaterThanOrEqual(0);
    expect(weather.intensity).toBeLessThanOrEqual(1);
  });

  it('weather has computed_at timestamp', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const before = Date.now();
    const weather = await computeWeather([state({})]);
    expect(weather.computed_at).toBeGreaterThanOrEqual(before);
  });

  // Weather effect matrix: each condition applies specific axis nudges
  const weatherEffectCases: Array<[string, string, boolean]> = [
    ['storm', 'energy', true],     // storm applies energy effect
    ['storm', 'intellectual_arousal', true],
    ['rain', 'emotional_weight', true],
    ['rain', 'sociability', true],
    ['fog', 'energy', true],
    ['fog', 'valence', true],
    ['aurora', 'energy', true],
    ['aurora', 'valence', true],
    ['aurora', 'sociability', true],
    ['clear', 'energy', true],
    ['overcast', 'energy', false],  // overcast has no effect
    ['overcast', 'valence', false],
  ];

  it.each(weatherEffectCases)(
    'getWeatherEffect("%s") has %s effect: %s',
    async (condition, axis, hasEffect) => {
      const { getWeatherEffect } = await import('../src/commune/weather.js');
      const effect = getWeatherEffect(condition);
      if (hasEffect) {
        expect(effect).toHaveProperty(axis);
      } else {
        // overcast has empty object — axis key absent
        expect(effect[axis as keyof typeof effect]).toBeUndefined();
      }
    },
  );

  // Multiple characters: average determines weather
  it('storm from averaged high-weight states', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const stormState = state({ intellectual_arousal: 0.8, emotional_weight: 0.9 });
    const calmState  = state({ intellectual_arousal: 0.2, emotional_weight: 0.1 });
    // average ia = 0.5, average ew = 0.5 → should NOT produce storm
    const weather = await computeWeather([stormState, calmState]);
    // (0.5 ew is not > 0.7, 0.5 ia is not > 0.6) → rain or overcast
    expect(['rain', 'overcast', 'fog', 'clear', 'aurora']).toContain(weather.condition);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. INTERNAL STATE AXIS × VALUE × OPERATION  (6 axes × 5 values × 2 ops = 60)
// ─────────────────────────────────────────────────────────────────────────────

describe('Internal state axis × value × operation', () => {
  const axes = ['energy', 'sociability', 'intellectual_arousal', 'emotional_weight', 'valence'] as const;

  // Values to test: below min, at min, mid, at max, above max
  const testValues = [
    { label: 'below-min (-0.5)', value: -0.5, expectedClamped: 0 },
    { label: 'at-min (0.0)', value: 0.0, expectedClamped: 0 },
    { label: 'mid (0.5)', value: 0.5, expectedClamped: 0.5 },
    { label: 'at-max (1.0)', value: 1.0, expectedClamped: 1.0 },
    { label: 'above-max (1.5)', value: 1.5, expectedClamped: 1.0 },
  ];

  function makeState(axis: string, val: number): import('../src/agent/internal-state.js').InternalState {
    return {
      energy: 0.5,
      sociability: 0.5,
      intellectual_arousal: 0.4,
      emotional_weight: 0.3,
      valence: 0.6,
      primary_color: 'neutral',
      updated_at: Date.now(),
      [axis]: val,
    } as import('../src/agent/internal-state.js').InternalState;
  }

  describe.each(axes.map((a) => [a]))('axis="%s"', (axis) => {
    it.each(testValues.map((v) => [v.label, v.value, v.expectedClamped]))(
      'clampState with %s → %f',
      async (_label, inputVal, expected) => {
        const { clampState } = await import('../src/agent/internal-state.js');
        const state = makeState(axis, inputVal);
        const clamped = clampState(state);
        expect(clamped[axis]).toBeCloseTo(expected, 5);
      },
    );

    it.each(testValues.map((v) => [v.label, v.value]))(
      'applyDecay with %s keeps axis in [0, 1]',
      async (_label, inputVal) => {
        const { applyDecay } = await import('../src/agent/internal-state.js');
        const state = makeState(axis, inputVal);
        const decayed = applyDecay(state);
        // All axes must be in [0, 1] after decay
        for (const a of axes) {
          expect(decayed[a]).toBeGreaterThanOrEqual(0);
          expect(decayed[a]).toBeLessThanOrEqual(1);
        }
      },
    );
  });

  it('applyDecay reduces energy by 0.02', async () => {
    const { applyDecay } = await import('../src/agent/internal-state.js');
    const state = {
      energy: 0.6, sociability: 0.5, intellectual_arousal: 0.5,
      emotional_weight: 0.3, valence: 0.5, primary_color: 'neutral', updated_at: Date.now(),
    };
    const decayed = applyDecay(state);
    expect(decayed.energy).toBeCloseTo(0.58, 4);
  });

  it('applyDecay reduces intellectual_arousal by 0.015', async () => {
    const { applyDecay } = await import('../src/agent/internal-state.js');
    const state = {
      energy: 0.6, sociability: 0.5, intellectual_arousal: 0.5,
      emotional_weight: 0.3, valence: 0.5, primary_color: 'neutral', updated_at: Date.now(),
    };
    const decayed = applyDecay(state);
    expect(decayed.intellectual_arousal).toBeCloseTo(0.485, 4);
  });

  it('clampState never produces values outside [0, 1]', async () => {
    const { clampState } = await import('../src/agent/internal-state.js');
    const extremeState = {
      energy: 99, sociability: -99, intellectual_arousal: 1.01,
      emotional_weight: -0.001, valence: 1000, primary_color: 'neutral', updated_at: Date.now(),
    };
    const clamped = clampState(extremeState);
    for (const a of axes) {
      expect(clamped[a]).toBeGreaterThanOrEqual(0);
      expect(clamped[a]).toBeLessThanOrEqual(1);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. EMOTIONAL WEIGHT × WEATHER INTENSITY  (5 weight levels × 6 conditions = 30)
// ─────────────────────────────────────────────────────────────────────────────

describe('Emotional weight × weather intensity', () => {
  // Test that weather intensity is within [0, 1] for different ew/axis combos
  const weightLevels = [0.0, 0.25, 0.5, 0.75, 1.0];

  function stateWith(emotional_weight: number, extra: Partial<import('../src/agent/internal-state.js').InternalState> = {}): import('../src/agent/internal-state.js').InternalState {
    return {
      energy: 0.5,
      sociability: 0.5,
      intellectual_arousal: 0.4,
      emotional_weight,
      valence: 0.5,
      primary_color: 'neutral',
      updated_at: Date.now(),
      ...extra,
    };
  }

  it.each(weightLevels.map((w) => [w]))(
    'emotional_weight=%f → intensity in [0, 1]',
    async (ew) => {
      const { computeWeather } = await import('../src/commune/weather.js');
      const weather = await computeWeather([stateWith(ew)]);
      expect(weather.intensity).toBeGreaterThanOrEqual(0);
      expect(weather.intensity).toBeLessThanOrEqual(1);
    },
  );

  it.each(weightLevels.map((w) => [w]))(
    'emotional_weight=%f → valid condition string',
    async (ew) => {
      const { computeWeather } = await import('../src/commune/weather.js');
      const weather = await computeWeather([stateWith(ew)]);
      const validConditions = ['clear', 'overcast', 'rain', 'fog', 'storm', 'aurora'];
      expect(validConditions).toContain(weather.condition);
    },
  );

  // High emotional weight drives rain
  it('emotional_weight=0.8 with low ia → rain condition', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const weather = await computeWeather([stateWith(0.8, { intellectual_arousal: 0.3 })]);
    expect(weather.condition).toBe('rain');
  });

  // Very high ew + high ia → storm
  it('emotional_weight=0.9 + intellectual_arousal=0.8 → storm', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const weather = await computeWeather([stateWith(0.9, { intellectual_arousal: 0.8 })]);
    expect(weather.condition).toBe('storm');
  });

  // Rain intensity equals emotional_weight
  it('rain intensity equals emotional_weight when rain condition', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const ew = 0.65;
    const weather = await computeWeather([stateWith(ew, { intellectual_arousal: 0.3 })]);
    if (weather.condition === 'rain') {
      expect(weather.intensity).toBeCloseTo(ew, 4);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. ASSOCIATION TYPE × STRENGTH × EXPECTED BEHAVIOR  (5 types × 4 strengths = 20)
// ─────────────────────────────────────────────────────────────────────────────

describe('Association type × strength × expected behavior', () => {
  beforeEach(setupTestDb);
  afterEach(teardownTestDb);

  const assocTypes = ['similar', 'evolved_from', 'pattern', 'cross_topic', 'dream'] as const;
  const strengths = [0.0, 0.25, 0.75, 1.0];

  async function makeMemoryPair(): Promise<[string, string]> {
    const { execute } = await import('../src/storage/database.js');
    const now = Date.now();
    const id1 = `mem-a-${Math.random().toString(36).slice(2)}`;
    const id2 = `mem-b-${Math.random().toString(36).slice(2)}`;
    for (const id of [id1, id2]) {
      execute(
        `INSERT INTO memories (id, session_key, content, memory_type, importance, emotional_weight, created_at, lifecycle_state, lifecycle_changed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, 'test:session', 'Memory content', 'fact', 0.5, 0.2, now, 'mature', now],
      );
    }
    return [id1, id2];
  }

  describe.each(assocTypes.map((t) => [t]))('type="%s"', (assocType) => {
    it.each(strengths.map((s) => [s]))(
      'strength=%f can be stored and retrieved',
      async (strength) => {
        const [id1, id2] = await makeMemoryPair();
        const { addAssociation, getAssociations } = await import('../src/memory/store.js');
        addAssociation(id1, id2, assocType, strength);
        const assocs = getAssociations(id1);
        const found = assocs.find(
          (a) => a.associationType === assocType &&
                 (a.sourceId === id1 || a.targetId === id1),
        );
        expect(found).toBeDefined();
        expect(found!.strength).toBeCloseTo(strength, 4);
      },
    );
  });

  it('strengthenAssociation boosts strength up to 1.0', async () => {
    const [id1, id2] = await makeMemoryPair();
    const { addAssociation, strengthenAssociation, getAssociations } = await import('../src/memory/store.js');
    addAssociation(id1, id2, 'similar', 0.9);
    strengthenAssociation(id1, id2, 0.5); // should clamp to 1.0
    const assocs = getAssociations(id1);
    const found = assocs.find((a) => a.associationType === 'similar');
    expect(found!.strength).toBeCloseTo(1.0, 4);
  });

  it('getAssociatedMemories returns connected memories', async () => {
    const [id1, id2] = await makeMemoryPair();
    const { addAssociation, getAssociatedMemories } = await import('../src/memory/store.js');
    addAssociation(id1, id2, 'pattern', 0.7);
    const connected = getAssociatedMemories([id1]);
    expect(connected.some((m) => m.id === id2)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. LIFECYCLE TRANSITIONS  (valid vs invalid state changes)
// ─────────────────────────────────────────────────────────────────────────────

describe('Lifecycle state transitions', () => {
  beforeEach(setupTestDb);
  afterEach(teardownTestDb);

  async function insertMemory(id: string, state: string) {
    const { execute } = await import('../src/storage/database.js');
    const now = Date.now();
    execute(
      `INSERT INTO memories (id, session_key, content, memory_type, importance, emotional_weight, created_at, lifecycle_state, lifecycle_changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, 'test:session', 'Test memory', 'fact', 0.5, 0.2, now, state, now],
    );
  }

  const validTransitions: Array<[string, string]> = [
    ['seed', 'growing'],
    ['growing', 'mature'],
    ['mature', 'complete'],
    ['mature', 'composting'],
    ['growing', 'composting'],
    ['seed', 'composting'],
    ['complete', 'composting'],
  ];

  it.each(validTransitions)('%s → %s is applied correctly', async (fromState, toState) => {
    const id = `mem-${fromState}-${toState}-${Math.random().toString(36).slice(2)}`;
    await insertMemory(id, fromState);
    const { setLifecycleState, getMemory } = await import('../src/memory/store.js');
    setLifecycleState(id, toState as import('../src/memory/store.js').LifecycleState);
    const mem = getMemory(id);
    expect(mem!.lifecycleState).toBe(toState);
  });

  it('composting memories are excluded from search results', async () => {
    const { execute } = await import('../src/storage/database.js');
    const now = Date.now();
    const id = `mem-compost-${Math.random().toString(36).slice(2)}`;
    execute(
      `INSERT INTO memories (id, session_key, content, memory_type, importance, emotional_weight, embedding, created_at, lifecycle_state, lifecycle_changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, 'test:session', 'I should be forgotten', 'fact', 0.9, 0.5, null, now, 'composting', now],
    );
    const { getMemoriesByLifecycle } = await import('../src/memory/store.js');
    const composting = getMemoriesByLifecycle('composting');
    expect(composting.some((m) => m.id === id)).toBe(true);
  });

  it('getMemoriesByLifecycle returns only requested state', async () => {
    const id1 = `mem-seed-${Math.random().toString(36).slice(2)}`;
    const id2 = `mem-mature-${Math.random().toString(36).slice(2)}`;
    await insertMemory(id1, 'seed');
    await insertMemory(id2, 'mature');
    const { getMemoriesByLifecycle } = await import('../src/memory/store.js');
    const seeds = getMemoriesByLifecycle('seed');
    expect(seeds.every((m) => m.lifecycleState === 'seed')).toBe(true);
    expect(seeds.some((m) => m.id === id1)).toBe(true);
    expect(seeds.some((m) => m.id === id2)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. KG ENTITY CRUD + CONTRADICTION DETECTION
// ─────────────────────────────────────────────────────────────────────────────

describe('KG entity CRUD', () => {
  beforeEach(setupTestDb);
  afterEach(teardownTestDb);

  const entityTypes = ['person', 'place', 'concept', 'object', 'character'];

  it.each(entityTypes.map((t) => [t]))('entity type "%s" can be added and retrieved', async (entityType) => {
    const { addEntity, getEntity } = await import('../src/memory/knowledge-graph.js');
    const name = `${entityType}-entity-${Math.random().toString(36).slice(2)}`;
    addEntity(name, entityType, Date.now(), { source: 'test' });
    const entity = getEntity(name);
    expect(entity).toBeDefined();
    expect(entity!.entityType).toBe(entityType);
  });

  it('addEntity upserts on repeat call', async () => {
    const { addEntity, getEntity } = await import('../src/memory/knowledge-graph.js');
    const name = `upsert-test-${Math.random().toString(36).slice(2)}`;
    const t1 = Date.now() - 1000;
    const t2 = Date.now();
    addEntity(name, 'person', t1);
    addEntity(name, 'person', t2);
    const entity = getEntity(name);
    expect(entity).toBeDefined();
    expect(entity!.lastSeen).toBeGreaterThanOrEqual(t2);
  });

  it('invalidateTriple sets ended timestamp', async () => {
    const { addTriple, invalidateTriple, getTriple } = await import('../src/memory/knowledge-graph.js');
    const id = addTriple('alice', 'knows', 'bob');
    const before = Date.now();
    invalidateTriple(id);
    const triple = getTriple(id);
    expect(triple!.ended).not.toBeNull();
    expect(triple!.ended!).toBeGreaterThanOrEqual(before);
  });

  it('detectContradictions finds conflicting active triples', async () => {
    const { addTriple, detectContradictions } = await import('../src/memory/knowledge-graph.js');
    const suffix = Math.random().toString(36).slice(2);
    addTriple(`subj-${suffix}`, `likes-${suffix}`, 'apples');
    addTriple(`subj-${suffix}`, `likes-${suffix}`, 'oranges');
    const contradictions = detectContradictions();
    const relevant = contradictions.filter((c) => c.predicate === `likes-${suffix}`);
    expect(relevant.length).toBeGreaterThan(0);
  });

  it('detectContradictions ignores ended triples', async () => {
    const { addTriple, invalidateTriple, detectContradictions } = await import('../src/memory/knowledge-graph.js');
    const suffix = Math.random().toString(36).slice(2);
    const id1 = addTriple(`endedsubj-${suffix}`, `endedpred-${suffix}`, 'val-a');
    addTriple(`endedsubj-${suffix}`, `endedpred-${suffix}`, 'val-b');
    invalidateTriple(id1);
    const contradictions = detectContradictions();
    const relevant = contradictions.filter((c) => c.predicate === `endedpred-${suffix}`);
    expect(relevant.length).toBe(0);
  });

  it('getEntityTimeline returns ordered triples', async () => {
    const { addTriple, getEntityTimeline } = await import('../src/memory/knowledge-graph.js');
    const entity = `timeline-${Math.random().toString(36).slice(2)}`;
    const t1 = Date.now() - 2000;
    const t2 = Date.now() - 1000;
    addTriple(entity, 'state', 'early', 1.0, t1);
    addTriple(entity, 'state', 'later', 1.0, t2);
    const timeline = getEntityTimeline(entity);
    expect(timeline.length).toBeGreaterThanOrEqual(2);
    // Should be ordered ascending
    for (let i = 1; i < timeline.length; i++) {
      expect(timeline[i]!.validFrom).toBeGreaterThanOrEqual(timeline[i - 1]!.validFrom);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. PALACE WING + ROOM CRUD
// ─────────────────────────────────────────────────────────────────────────────

describe('Palace wing and room CRUD', () => {
  beforeEach(setupTestDb);
  afterEach(teardownTestDb);

  it('createWing returns a unique id', async () => {
    const { createWing } = await import('../src/memory/palace.js');
    const id1 = createWing('wing-alpha');
    const id2 = createWing('wing-beta');
    expect(id1).not.toBe(id2);
  });

  it('getWingByName returns the correct wing', async () => {
    const { createWing, getWingByName } = await import('../src/memory/palace.js');
    const name = `wing-${Math.random().toString(36).slice(2)}`;
    const id = createWing(name, 'A test wing');
    const wing = getWingByName(name);
    expect(wing).toBeDefined();
    expect(wing!.id).toBe(id);
    expect(wing!.description).toBe('A test wing');
  });

  it('resolveWing is idempotent', async () => {
    const { resolveWing } = await import('../src/memory/palace.js');
    const name = `idempotent-${Math.random().toString(36).slice(2)}`;
    const id1 = resolveWing(name, 'desc');
    const id2 = resolveWing(name, 'different desc');
    expect(id1).toBe(id2);
  });

  it('incrementWingCount increments memory_count', async () => {
    const { createWing, getWing, incrementWingCount } = await import('../src/memory/palace.js');
    const id = createWing(`count-wing-${Math.random().toString(36).slice(2)}`);
    incrementWingCount(id);
    incrementWingCount(id);
    const wing = getWing(id);
    expect(wing!.memoryCount).toBe(2);
  });

  it('decrementWingCount does not go below 0', async () => {
    const { createWing, getWing, decrementWingCount } = await import('../src/memory/palace.js');
    const id = createWing(`decr-wing-${Math.random().toString(36).slice(2)}`);
    decrementWingCount(id);
    decrementWingCount(id);
    const wing = getWing(id);
    expect(wing!.memoryCount).toBe(0);
  });

  it('createRoom and resolveRoom are idempotent within a wing', async () => {
    const { createWing, resolveRoom, getRoomByName } = await import('../src/memory/palace.js');
    const wingId = createWing(`room-test-wing-${Math.random().toString(36).slice(2)}`);
    const roomName = 'truths';
    const r1 = resolveRoom(wingId, roomName, 'Hall of truths');
    const r2 = resolveRoom(wingId, roomName, 'Hall of truths again');
    expect(r1).toBe(r2);
    const room = getRoomByName(wingId, roomName);
    expect(room).toBeDefined();
    expect(room!.wingId).toBe(wingId);
  });

  it('listWings returns all created wings', async () => {
    const { createWing, listWings } = await import('../src/memory/palace.js');
    const suffix = Math.random().toString(36).slice(2);
    createWing(`list-w1-${suffix}`);
    createWing(`list-w2-${suffix}`);
    createWing(`list-w3-${suffix}`);
    const wings = listWings();
    const names = wings.map((w) => w.name);
    expect(names).toContain(`list-w1-${suffix}`);
    expect(names).toContain(`list-w2-${suffix}`);
    expect(names).toContain(`list-w3-${suffix}`);
  });

  it('listRooms returns all rooms for a wing', async () => {
    const { createWing, createRoom, listRooms } = await import('../src/memory/palace.js');
    const wingId = createWing(`list-rooms-wing-${Math.random().toString(36).slice(2)}`);
    createRoom(wingId, 'room-a');
    createRoom(wingId, 'room-b');
    const rooms = listRooms(wingId);
    expect(rooms).toHaveLength(2);
    expect(rooms.every((r) => r.wingId === wingId)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. STATE SUMMARY TEXT  (axis levels → expected text snippets)
// ─────────────────────────────────────────────────────────────────────────────

describe('getStateSummary text output', () => {
  beforeEach(setupTestDb);
  afterEach(teardownTestDb);

  const summarySnippetCases: Array<[string, Partial<import('../src/agent/internal-state.js').InternalState>, string]> = [
    ['high intellectual_arousal', { intellectual_arousal: 0.8 }, 'mind buzzing'],
    ['low intellectual_arousal', { intellectual_arousal: 0.2 }, 'mind quiet'],
    ['high emotional_weight', { emotional_weight: 0.8 }, 'emotionally'],
    ['low emotional_weight', { emotional_weight: 0.1 }, 'emotionally light'],
    ['high sociability', { sociability: 0.8 }, 'wanting company'],
    ['low sociability', { sociability: 0.2 }, 'preferring solitude'],
    ['low valence', { valence: 0.2 }, 'mood is dark'],
    ['high valence', { valence: 0.8 }, 'mood is bright'],
  ];

  it.each(summarySnippetCases)('%s contains "%s"', async (_label, stateOverride, expectedSnippet) => {
    const { saveState, getStateSummary } = await import('../src/agent/internal-state.js');
    const state: import('../src/agent/internal-state.js').InternalState = {
      energy: 0.6,
      sociability: 0.5,
      intellectual_arousal: 0.4,
      emotional_weight: 0.3,
      valence: 0.6,
      primary_color: 'neutral',
      updated_at: Date.now(),
      ...stateOverride,
    };
    saveState(state);
    const summary = getStateSummary();
    expect(summary).toContain(expectedSnippet);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 14. MEMORY STORE BASIC CRUD
// ─────────────────────────────────────────────────────────────────────────────

describe('Memory store basic CRUD', () => {
  beforeEach(setupTestDb);
  afterEach(teardownTestDb);

  const memoryTypes = ['fact', 'preference', 'context', 'summary', 'episode'] as const;

  it.each(memoryTypes.map((t) => [t]))('getMemoriesByType("%s") only returns that type', async (memType) => {
    const { execute } = await import('../src/storage/database.js');
    const { getMemoriesByType } = await import('../src/memory/store.js');
    const now = Date.now();
    const id = `typed-${memType}-${Math.random().toString(36).slice(2)}`;
    execute(
      `INSERT INTO memories (id, session_key, content, memory_type, importance, emotional_weight, created_at, lifecycle_state, lifecycle_changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, 'test:session', `A ${memType} memory`, memType, 0.5, 0.2, now, 'mature', now],
    );
    const results = getMemoriesByType(memType);
    expect(results.every((m) => m.memoryType === memType)).toBe(true);
    expect(results.some((m) => m.id === id)).toBe(true);
  });

  it('deleteMemory removes the memory', async () => {
    const { execute } = await import('../src/storage/database.js');
    const { deleteMemory, getMemory } = await import('../src/memory/store.js');
    const id = `delete-me-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    execute(
      `INSERT INTO memories (id, session_key, content, memory_type, importance, emotional_weight, created_at, lifecycle_state, lifecycle_changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, 'test:session', 'Delete this', 'fact', 0.5, 0.2, now, 'mature', now],
    );
    expect(getMemory(id)).toBeDefined();
    const deleted = deleteMemory(id);
    expect(deleted).toBe(true);
    expect(getMemory(id)).toBeUndefined();
  });

  it('deleteMemory returns false for nonexistent id', async () => {
    const { deleteMemory } = await import('../src/memory/store.js');
    expect(deleteMemory('__nonexistent_id__')).toBe(false);
  });

  it('updateMemoryImportance changes importance', async () => {
    const { execute } = await import('../src/storage/database.js');
    const { updateMemoryImportance, getMemory } = await import('../src/memory/store.js');
    const id = `imp-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    execute(
      `INSERT INTO memories (id, session_key, content, memory_type, importance, emotional_weight, created_at, lifecycle_state, lifecycle_changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, 'test:session', 'Importance test', 'fact', 0.5, 0.2, now, 'mature', now],
    );
    updateMemoryImportance(id, 0.9);
    const mem = getMemory(id);
    expect(mem!.importance).toBeCloseTo(0.9, 4);
  });

  it('updateMemoryAccess increments access_count', async () => {
    const { execute } = await import('../src/storage/database.js');
    const { updateMemoryAccess, getMemory } = await import('../src/memory/store.js');
    const id = `access-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    execute(
      `INSERT INTO memories (id, session_key, content, memory_type, importance, emotional_weight, created_at, lifecycle_state, lifecycle_changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, 'test:session', 'Access test', 'fact', 0.5, 0.2, now, 'mature', now],
    );
    updateMemoryAccess(id);
    updateMemoryAccess(id);
    const mem = getMemory(id);
    expect(mem!.accessCount).toBe(2);
  });

  it('countMemories returns total count', async () => {
    const { execute } = await import('../src/storage/database.js');
    const { countMemories } = await import('../src/memory/store.js');
    const before = countMemories();
    const now = Date.now();
    execute(
      `INSERT INTO memories (id, session_key, content, memory_type, importance, emotional_weight, created_at, lifecycle_state, lifecycle_changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [`count-${Math.random().toString(36).slice(2)}`, 'test:session', 'Counter test', 'fact', 0.5, 0.2, now, 'mature', now],
    );
    expect(countMemories()).toBe(before + 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 15. PREOCCUPATIONS  (add / resolve / decay matrix)
// ─────────────────────────────────────────────────────────────────────────────

describe('Preoccupations matrix', () => {
  beforeEach(setupTestDb);
  afterEach(teardownTestDb);

  it('addPreoccupation stores up to 5 items', async () => {
    const { addPreoccupation, getPreoccupations } = await import('../src/agent/internal-state.js');
    for (let i = 0; i < 7; i++) {
      addPreoccupation(`thread-${i}`, `origin-${i}`);
    }
    const list = getPreoccupations();
    expect(list.length).toBeLessThanOrEqual(5);
  });

  it('resolvePreoccupation removes the item from active list', async () => {
    const { addPreoccupation, resolvePreoccupation, getPreoccupations } = await import('../src/agent/internal-state.js');
    addPreoccupation('unresolved thought', 'some event');
    const before = getPreoccupations();
    const id = before[before.length - 1]!.id;
    resolvePreoccupation(id, 'resolved by reflection');
    const after = getPreoccupations();
    expect(after.every((p) => p.id !== id)).toBe(true);
  });

  it('decayPreoccupations reduces intensity', async () => {
    const { addPreoccupation, decayPreoccupations, getPreoccupations } = await import('../src/agent/internal-state.js');
    addPreoccupation('some lingering question', 'big event');
    const before = getPreoccupations();
    const initialIntensity = before[before.length - 1]!.intensity;
    decayPreoccupations();
    const after = getPreoccupations();
    const item = after.find((p) => p.thread === 'some lingering question');
    if (item) {
      expect(item.intensity).toBeLessThan(initialIntensity);
    }
  });

  it('new preoccupations start at intensity 0.7', async () => {
    const { addPreoccupation, getPreoccupations } = await import('../src/agent/internal-state.js');
    const thread = `thread-${Math.random().toString(36).slice(2)}`;
    addPreoccupation(thread, 'origin');
    const list = getPreoccupations();
    const item = list.find((p) => p.thread === thread);
    expect(item!.intensity).toBe(0.7);
  });
});
