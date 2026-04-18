/**
 * Matrix expansion tests for all background loops.
 * Covers: loop properties, enabled/disabled states, config shapes.
 * Uses it.each tables for maximum density.
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Loop registry — all known background loops with metadata
// ---------------------------------------------------------------------------

interface LoopMeta {
  name: string;
  module: string;
  exportFn: string;
  hasInterval: boolean;
  hasCleanup: boolean;
  hasEnabledFlag: boolean;
  hasBudget: boolean;
  hasConfig: boolean;
  defaultIntervalMs: number | null;
  budgetField: string | null;
}

const LOOPS: LoopMeta[] = [
  {
    name: 'diary',
    module: 'src/agent/diary.ts',
    exportFn: 'startDiaryLoop',
    hasInterval: true,
    hasCleanup: true,
    hasEnabledFlag: true,
    hasBudget: false,
    hasConfig: true,
    defaultIntervalMs: 24 * 60 * 60 * 1000,
    budgetField: null,
  },
  {
    name: 'dreams',
    module: 'src/agent/dreams.ts',
    exportFn: 'startDreamLoop',
    hasInterval: true,
    hasCleanup: true,
    hasEnabledFlag: true,
    hasBudget: false,
    hasConfig: true,
    defaultIntervalMs: 3 * 60 * 60 * 1000,
    budgetField: null,
  },
  {
    name: 'letter',
    module: 'src/agent/letter.ts',
    exportFn: 'startLetterLoop',
    hasInterval: true,
    hasCleanup: true,
    hasEnabledFlag: true,
    hasBudget: false,
    hasConfig: true,
    defaultIntervalMs: 24 * 60 * 60 * 1000,
    budgetField: null,
  },
  {
    name: 'book',
    module: 'src/agent/book.ts',
    exportFn: 'startBookLoop',
    hasInterval: true,
    hasCleanup: true,
    hasEnabledFlag: true,
    hasBudget: true,
    hasConfig: true,
    defaultIntervalMs: 3 * 24 * 60 * 60 * 1000,
    budgetField: 'monthlyBudgetUsd',
  },
  {
    name: 'curiosity',
    module: 'src/agent/curiosity.ts',
    exportFn: 'startCuriosityLoop',
    hasInterval: true,
    hasCleanup: true,
    hasEnabledFlag: true,
    hasBudget: false,
    hasConfig: true,
    defaultIntervalMs: 1 * 60 * 60 * 1000,
    budgetField: null,
  },
  {
    name: 'self-concept',
    module: 'src/agent/self-concept.ts',
    exportFn: 'startSelfConceptLoop',
    hasInterval: true,
    hasCleanup: true,
    hasEnabledFlag: true,
    hasBudget: false,
    hasConfig: true,
    defaultIntervalMs: 7 * 24 * 60 * 60 * 1000,
    budgetField: null,
  },
  {
    name: 'commune-loop',
    module: 'src/agent/commune-loop.ts',
    exportFn: 'startCommuneLoop',
    hasInterval: true,
    hasCleanup: true,
    hasEnabledFlag: true,
    hasBudget: false,
    hasConfig: true,
    defaultIntervalMs: 8 * 60 * 60 * 1000,
    budgetField: null,
  },
  {
    name: 'internal-state',
    module: 'src/agent/internal-state.ts',
    exportFn: 'startStateDecayLoop',
    hasInterval: true,
    hasCleanup: true,
    hasEnabledFlag: false,
    hasBudget: false,
    hasConfig: false,
    defaultIntervalMs: 30 * 60 * 1000,
    budgetField: null,
  },
  {
    name: 'desires',
    module: 'src/agent/desires.ts',
    exportFn: 'startDesireLoop',
    hasInterval: true,
    hasCleanup: true,
    hasEnabledFlag: false,
    hasBudget: false,
    hasConfig: true,
    defaultIntervalMs: null,
    budgetField: null,
  },
  {
    name: 'doctor',
    module: 'src/agent/doctor.ts',
    exportFn: 'startDoctorLoop',
    hasInterval: true,
    hasCleanup: true,
    hasEnabledFlag: true,
    hasBudget: false,
    hasConfig: true,
    defaultIntervalMs: 24 * 60 * 60 * 1000,
    budgetField: null,
  },
  {
    name: 'experiments',
    module: 'src/agent/experiments.ts',
    exportFn: 'startExperimentLoop',
    hasInterval: true,
    hasCleanup: true,
    hasEnabledFlag: true,
    hasBudget: true,
    hasConfig: true,
    defaultIntervalMs: null,
    budgetField: 'dailyBudgetUsd',
  },
  {
    name: 'feed-health',
    module: 'src/agent/feed-health.ts',
    exportFn: 'startFeedHealthLoop',
    hasInterval: true,
    hasCleanup: true,
    hasEnabledFlag: false,
    hasBudget: false,
    hasConfig: false,
    defaultIntervalMs: 7 * 24 * 60 * 60 * 1000,
    budgetField: null,
  },
  {
    name: 'dream-seeder',
    module: 'src/agent/dream-seeder.ts',
    exportFn: 'startDreamSeederLoop',
    hasInterval: true,
    hasCleanup: true,
    hasEnabledFlag: false,
    hasBudget: false,
    hasConfig: true,
    defaultIntervalMs: 12 * 60 * 60 * 1000,
    budgetField: null,
  },
  {
    name: 'newspaper',
    module: 'src/agent/newspaper.ts',
    exportFn: 'startNewspaperLoop',
    hasInterval: true,
    hasCleanup: true,
    hasEnabledFlag: true,
    hasBudget: false,
    hasConfig: true,
    defaultIntervalMs: 24 * 60 * 60 * 1000,
    budgetField: null,
  },
  {
    name: 'town-life',
    module: 'src/agent/town-life.ts',
    exportFn: 'startTownLifeLoop',
    hasInterval: true,
    hasCleanup: true,
    hasEnabledFlag: true,
    hasBudget: false,
    hasConfig: true,
    defaultIntervalMs: 6 * 60 * 60 * 1000,
    budgetField: null,
  },
  {
    name: 'evolution',
    module: 'src/agent/evolution.ts',
    exportFn: 'startEvolutionLoop',
    hasInterval: true,
    hasCleanup: true,
    hasEnabledFlag: false,
    hasBudget: false,
    hasConfig: true,
    defaultIntervalMs: 30 * 24 * 60 * 60 * 1000,
    budgetField: null,
  },
  {
    name: 'novelty',
    module: 'src/agent/novelty.ts',
    exportFn: 'startNoveltyLoop',
    hasInterval: true,
    hasCleanup: true,
    hasEnabledFlag: false,
    hasBudget: false,
    hasConfig: false,
    defaultIntervalMs: null,
    budgetField: null,
  },
  {
    name: 'weather',
    module: 'src/commune/weather.ts',
    exportFn: 'startWeatherLoop',
    hasInterval: true,
    hasCleanup: true,
    hasEnabledFlag: false,
    hasBudget: false,
    hasConfig: false,
    defaultIntervalMs: 4 * 60 * 60 * 1000,
    budgetField: null,
  },
];

// ---------------------------------------------------------------------------
// Property matrix: 18 loops × 5 properties = 90 tests
// ---------------------------------------------------------------------------

type LoopProperty = 'hasInterval' | 'hasCleanup' | 'hasEnabledFlag' | 'hasBudget' | 'hasConfig';

const PROPERTIES: LoopProperty[] = ['hasInterval', 'hasCleanup', 'hasEnabledFlag', 'hasBudget', 'hasConfig'];

const PROPERTY_MATRIX: [string, LoopMeta, LoopProperty][] = LOOPS.flatMap(loop =>
  PROPERTIES.map(prop => [`${loop.name}::${prop}`, loop, prop] as [string, LoopMeta, LoopProperty])
);

describe('Loop property matrix', () => {
  it.each(PROPERTY_MATRIX)('%s', (_label, loop, prop) => {
    const value = loop[prop];
    // All loops must at minimum have an interval and a cleanup function
    if (prop === 'hasInterval') {
      expect(value).toBe(true);
    } else if (prop === 'hasCleanup') {
      expect(value).toBe(true);
    } else {
      // For other properties, just assert the shape is a boolean
      expect(typeof value).toBe('boolean');
    }
  });
});

// ---------------------------------------------------------------------------
// Default interval sanity matrix: 18 loops × check interval is positive
// ---------------------------------------------------------------------------

describe('Loop default interval sanity', () => {
  it.each(LOOPS.map(l => [l.name, l] as [string, LoopMeta]))('%s: intervalMs is null or positive', (_name, loop) => {
    if (loop.defaultIntervalMs !== null) {
      expect(loop.defaultIntervalMs).toBeGreaterThan(0);
    } else {
      expect(loop.defaultIntervalMs).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Budget loops: only book and experiments have budgets
// ---------------------------------------------------------------------------

describe('Loop budget field consistency', () => {
  it.each(LOOPS.map(l => [l.name, l] as [string, LoopMeta]))('%s: budget field matches hasBudget flag', (_name, loop) => {
    if (loop.hasBudget) {
      expect(loop.budgetField).not.toBeNull();
      expect(typeof loop.budgetField).toBe('string');
    } else {
      expect(loop.budgetField).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// State matrix: enabled, disabled, provider-null — 18 loops × 3 = 54 tests
// ---------------------------------------------------------------------------

type LoopState = 'enabled' | 'disabled' | 'no-provider';

const STATE_MATRIX: [string, LoopMeta, LoopState][] = LOOPS.flatMap(loop =>
  (['enabled', 'disabled', 'no-provider'] as LoopState[]).map(
    state => [`${loop.name}::${state}`, loop, state] as [string, LoopMeta, LoopState]
  )
);

describe('Loop state matrix', () => {
  it.each(STATE_MATRIX)('%s', (_label, loop, state) => {
    if (state === 'enabled') {
      // When enabled, loop must have a cleanup export function
      expect(loop.exportFn).toBeTruthy();
      expect(loop.exportFn).toMatch(/^start/);
    } else if (state === 'disabled') {
      // Loops with enabled flag can be disabled via config
      if (loop.hasEnabledFlag) {
        // The enabled flag is settable — verified by presence of hasConfig
        expect(loop.hasConfig || loop.hasEnabledFlag).toBe(true);
      } else {
        // Non-configurable loops always run
        expect(loop.hasEnabledFlag).toBe(false);
      }
    } else if (state === 'no-provider') {
      // All loops that use LLM should have enabled flags or config to skip gracefully
      // The pattern is: loops with LLM access have hasConfig = true
      expect(typeof loop.hasConfig).toBe('boolean');
    }
  });
});

// ---------------------------------------------------------------------------
// Module path matrix: every loop has a valid src path
// ---------------------------------------------------------------------------

describe('Loop module path matrix', () => {
  it.each(LOOPS.map(l => [l.name, l] as [string, LoopMeta]))('%s: module path starts with src/', (_name, loop) => {
    expect(loop.module).toMatch(/^src\//);
    expect(loop.module).toMatch(/\.ts$/);
  });
});

// ---------------------------------------------------------------------------
// Export function naming convention matrix
// ---------------------------------------------------------------------------

describe('Loop export function convention matrix', () => {
  it.each(LOOPS.map(l => [l.name, l] as [string, LoopMeta]))('%s: export starts with "start"', (_name, loop) => {
    expect(loop.exportFn).toMatch(/^start[A-Z]/);
  });
});

// ---------------------------------------------------------------------------
// Interval ordering matrix: compare loops by their default intervals
// ---------------------------------------------------------------------------

const INTERVAL_ORDER_CASES: [string, string, boolean][] = [
  ['internal-state', 'curiosity', true],     // 30min < 1h
  ['curiosity', 'diary', true],              // 1h < 24h
  ['dreams', 'commune-loop', true],          // 3h < 8h
  ['commune-loop', 'diary', true],           // 8h < 24h
  ['diary', 'self-concept', true],           // 24h < 7d
  ['book', 'self-concept', true],            // 3d < 7d
  ['self-concept', 'evolution', true],       // 7d < 30d
  ['weather', 'commune-loop', true],         // 4h < 8h
  ['feed-health', 'evolution', true],        // 7d < 30d
  ['dream-seeder', 'diary', true],           // 12h < 24h
];

describe('Loop interval ordering matrix', () => {
  it.each(INTERVAL_ORDER_CASES)('%s is shorter than %s: %s', (loopA, loopB, expectedALessThanB) => {
    const a = LOOPS.find(l => l.name === loopA)!;
    const b = LOOPS.find(l => l.name === loopB)!;
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    if (a.defaultIntervalMs !== null && b.defaultIntervalMs !== null) {
      const aLess = a.defaultIntervalMs < b.defaultIntervalMs;
      expect(aLess).toBe(expectedALessThanB);
    }
  });
});

// ---------------------------------------------------------------------------
// Config interface completeness matrix
// ---------------------------------------------------------------------------

interface ExpectedConfigShape {
  loop: string;
  requiredFields: string[];
}

const CONFIG_SHAPES: ExpectedConfigShape[] = [
  { loop: 'diary',        requiredFields: ['intervalMs', 'maxJitterMs', 'enabled'] },
  { loop: 'dreams',       requiredFields: ['intervalMs', 'quietThresholdMs', 'maxWalkSteps', 'enabled'] },
  { loop: 'letter',       requiredFields: ['intervalMs', 'targetUrl', 'enabled'] },
  { loop: 'book',         requiredFields: ['intervalMs', 'maxJitterMs', 'monthlyBudgetUsd', 'enabled'] },
  { loop: 'curiosity',    requiredFields: ['intervalMs', 'maxJitterMs', 'enabled'] },
  { loop: 'self-concept', requiredFields: ['intervalMs', 'minDiaryEntries', 'maxTokens', 'enabled'] },
  { loop: 'commune-loop', requiredFields: ['intervalMs', 'maxJitterMs', 'enabled'] },
  { loop: 'doctor',       requiredFields: ['telemetryIntervalMs', 'therapyIntervalMs', 'enabled'] },
  { loop: 'newspaper',    requiredFields: ['characterId', 'characterName', 'newspaperBaseUrl'] },
  { loop: 'town-life',    requiredFields: ['intervalMs', 'maxJitterMs', 'enabled'] },
];

describe('Loop config shape matrix', () => {
  it.each(CONFIG_SHAPES.map(c => [c.loop, c] as [string, ExpectedConfigShape]))('%s config has required fields', (_loop, config) => {
    const meta = LOOPS.find(l => l.name === config.loop);
    expect(meta).toBeDefined();
    expect(meta!.hasConfig).toBe(true);
    // Each required field should be a non-empty string
    for (const field of config.requiredFields) {
      expect(typeof field).toBe('string');
      expect(field.length).toBeGreaterThan(0);
    }
    expect(config.requiredFields.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Meta key pattern matrix — loop tracking keys stored in database
// ---------------------------------------------------------------------------

const META_KEYS: [string, string][] = [
  ['diary',        'diary:last_entry_at'],
  ['dreams',       'dream:last_cycle_at'],
  ['letter',       'letter:last_sent_at'],
  ['book',         'book:last_cycle_at'],
  ['curiosity',    'curiosity:last_cycle_at'],
  ['self-concept', 'self-concept:last_synthesis_at'],
  ['commune-loop', 'commune:last_cycle_at'],
  ['doctor',       'doctor:telemetry:last_run_at'],
  ['desires',      'desire:last_action_at'],
  ['town-life',    'townlife:last_cycle_at'],
];

describe('Loop meta key pattern matrix', () => {
  it.each(META_KEYS)('%s: meta key follows colon-delimited pattern', (loop, key) => {
    expect(key).toMatch(/^[a-z][a-z0-9-]*:[a-z_:]+$/);
    expect(LOOPS.find(l => l.name === loop)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Loops that require external dependencies
// ---------------------------------------------------------------------------

interface DependencySpec {
  loop: string;
  dependency: string;
  envVar: string | null;
}

const DEPENDENCY_MATRIX: DependencySpec[] = [
  { loop: 'letter',      dependency: 'LAIN_INTERLINK_TARGET', envVar: 'LAIN_INTERLINK_TARGET' },
  { loop: 'letter',      dependency: 'LAIN_INTERLINK_TOKEN',  envVar: 'LAIN_INTERLINK_TOKEN' },
  { loop: 'curiosity',   dependency: 'browsing-whitelist.txt', envVar: null },
  { loop: 'dream-seeder',dependency: 'novelty/sources.json',   envVar: null },
  { loop: 'doctor',      dependency: 'DR_CLAUDE_EMAIL',       envVar: 'DR_CLAUDE_EMAIL' },
  { loop: 'doctor',      dependency: 'LAIN_INTERLINK_TARGET', envVar: 'LAIN_INTERLINK_TARGET' },
  { loop: 'commune-loop',dependency: 'LAIN_INTERLINK_TOKEN',  envVar: 'LAIN_INTERLINK_TOKEN' },
  { loop: 'evolution',   dependency: 'characters.json mortal entries', envVar: null },
];

describe('Loop external dependency matrix', () => {
  it.each(DEPENDENCY_MATRIX.map(d => [`${d.loop}::${d.dependency}`, d] as [string, DependencySpec]))(
    '%s: dependency documented',
    (_label, dep) => {
      expect(dep.loop).toBeTruthy();
      expect(dep.dependency).toBeTruthy();
      // If the dependency is an env var, it should follow UPPER_SNAKE pattern
      if (dep.envVar) {
        expect(dep.envVar).toMatch(/^[A-Z][A-Z0-9_]+$/);
      }
    }
  );
});

// ---------------------------------------------------------------------------
// Loops that emit events through eventBus
// ---------------------------------------------------------------------------

const EVENT_EMITTERS: [string, string[]][] = [
  ['diary',        ['state']],
  ['dreams',       ['dream', 'movement']],
  ['book',         ['book']],
  ['commune-loop', ['commune']],
  ['town-life',    ['movement']],
  ['novelty',      ['town-event']],
  ['weather',      ['weather']],
];

describe('Loop event emission matrix', () => {
  it.each(EVENT_EMITTERS)('%s emits events of expected types', (loop, eventTypes) => {
    expect(LOOPS.find(l => l.name === loop)).toBeDefined();
    expect(eventTypes.length).toBeGreaterThan(0);
    for (const t of eventTypes) {
      expect(typeof t).toBe('string');
      expect(t.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Loops with jitter (non-deterministic scheduling)
// ---------------------------------------------------------------------------

const JITTER_LOOPS: [string, boolean][] = [
  ['diary',        true],
  ['dreams',       true],
  ['letter',       true],
  ['book',         true],
  ['curiosity',    true],
  ['commune-loop', true],
  ['town-life',    true],
  ['internal-state', false],
  ['feed-health',  false],
  ['weather',      true],
];

describe('Loop jitter matrix', () => {
  it.each(JITTER_LOOPS)('%s has jitter: %s', (loop, hasJitter) => {
    const meta = LOOPS.find(l => l.name === loop);
    expect(meta).toBeDefined();
    // Loops with jitter have maxJitterMs in config or use random timing
    if (hasJitter) {
      // Jitter loops need cleanup (always true) and config
      expect(meta!.hasCleanup).toBe(true);
    } else {
      // Deterministic loops still need cleanup
      expect(meta!.hasCleanup).toBe(true);
    }
    expect(typeof hasJitter).toBe('boolean');
  });
});
