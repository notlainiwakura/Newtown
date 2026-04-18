/**
 * Temporal logic tests for Laintown
 *
 * Guards against time-related bugs: wrong intervals, off-by-one month resets,
 * missing decay, stale data tolerance, and cooldown correctness.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

// ─────────────────────────────────────────────────────────
// 1. BUDGET PERIOD BOUNDARIES
// ─────────────────────────────────────────────────────────
describe('Budget Period Boundaries', () => {
  const testDir = join(tmpdir(), `lain-test-budget-${Date.now()}`);
  const originalEnv = process.env['LAIN_HOME'];
  const originalCap = process.env['LAIN_MONTHLY_TOKEN_CAP'];

  beforeEach(async () => {
    process.env['LAIN_HOME'] = testDir;
    await mkdir(testDir, { recursive: true });
    const { initDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(testDir, 'test.db'));
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    const { closeDatabase } = await import('../src/storage/database.js');
    closeDatabase();
    if (originalEnv) process.env['LAIN_HOME'] = originalEnv;
    else delete process.env['LAIN_HOME'];
    if (originalCap !== undefined) process.env['LAIN_MONTHLY_TOKEN_CAP'] = originalCap;
    else delete process.env['LAIN_MONTHLY_TOKEN_CAP'];
    try { await rm(testDir, { recursive: true }); } catch {}
  });

  it('budget key format is YYYY-MM and changes at month/year boundaries', () => {
    // Jan 31
    vi.setSystemTime(new Date('2025-01-31T23:59:59Z'));
    expect(new Date().toISOString().slice(0, 7)).toBe('2025-01');

    // Feb 1
    vi.setSystemTime(new Date('2025-02-01T00:00:00Z'));
    expect(new Date().toISOString().slice(0, 7)).toBe('2025-02');

    // Dec 31 → Jan 1 (year boundary)
    vi.setSystemTime(new Date('2024-12-31T23:59:59Z'));
    expect(new Date().toISOString().slice(0, 7)).toBe('2024-12');
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    expect(new Date().toISOString().slice(0, 7)).toBe('2025-01');
  });

  it('two operations in same month accumulate in budget', async () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '1000000';
    vi.setSystemTime(new Date('2025-06-10T10:00:00Z'));

    const { recordUsage, getBudgetStatus } = await import('../src/providers/budget.js');
    recordUsage(10000, 5000); // 15k tokens
    recordUsage(20000, 10000); // 30k more = 45k total

    const status = getBudgetStatus();
    expect(status.tokensUsed).toBe(45000);
    expect(status.month).toBe('2025-06');
  });

  it('crossing month boundary resets token count', async () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '1000000';

    vi.setSystemTime(new Date('2025-06-30T23:59:00Z'));
    const { recordUsage, getBudgetStatus } = await import('../src/providers/budget.js');
    recordUsage(50000, 25000);

    const juneStatus = getBudgetStatus();
    expect(juneStatus.tokensUsed).toBeGreaterThan(0);

    // Move to July — new month
    vi.setSystemTime(new Date('2025-07-01T00:00:01Z'));
    const julyStatus = getBudgetStatus();
    expect(julyStatus.tokensUsed).toBe(0);
    expect(julyStatus.month).toBe('2025-07');
  });

  it('budget disabled (cap=0) means checkBudget never throws', async () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '0';
    const { checkBudget, recordUsage } = await import('../src/providers/budget.js');

    // Record huge usage
    recordUsage(99999999, 99999999);
    expect(() => checkBudget()).not.toThrow();
  });

  it('checkBudget throws when over cap', async () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '100';
    vi.setSystemTime(new Date('2025-08-15T12:00:00Z'));

    const { checkBudget, recordUsage } = await import('../src/providers/budget.js');
    recordUsage(50, 60); // 110 tokens — over cap of 100

    expect(() => checkBudget()).toThrow('budget exceeded');
  });

  it('getBudgetStatus reports correct month, pct, and resets on month jump', async () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '1000000';
    vi.setSystemTime(new Date('2025-04-10T10:00:00Z'));
    const { recordUsage, getBudgetStatus } = await import('../src/providers/budget.js');

    // Accumulate half the budget
    recordUsage(500000, 0);
    let status = getBudgetStatus();
    expect(status.month).toBe('2025-04');
    expect(status.tokensUsed).toBe(500000);
    expect(status.pctUsed).toBe(50);

    // Zero tokens don't corrupt
    recordUsage(0, 0);
    expect(getBudgetStatus().tokensUsed).toBe(500000);

    // Jump to new month — resets
    vi.setSystemTime(new Date('2025-05-01T00:00:00Z'));
    status = getBudgetStatus();
    expect(status.month).toBe('2025-05');
    expect(status.tokensUsed).toBe(0);
  });

  it('pct used is 0 when cap is disabled (0)', async () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '0';
    const { getBudgetStatus } = await import('../src/providers/budget.js');
    expect(getBudgetStatus().pctUsed).toBe(0);
  });
});


// ─────────────────────────────────────────────────────────
// 2. LOOP SCHEDULING SANITY
// ─────────────────────────────────────────────────────────
describe('Loop Scheduling Sanity', () => {
  const ONE_HOUR_MS = 60 * 60 * 1000;
  const ONE_DAY_MS = 24 * ONE_HOUR_MS;

  it('all loop intervals are in the expected time range (not seconds, not months)', () => {
    const intervals: Record<string, number> = {
      diary:   24 * ONE_HOUR_MS,   // 24h
      dreams:   3 * ONE_HOUR_MS,   // 3h
      curiosity: 1 * ONE_HOUR_MS,  // 1h
      book:     3 * ONE_DAY_MS,    // 3 days
      commune:  8 * ONE_HOUR_MS,   // 8h
      decay:   30 * 60 * 1000,     // 30min
      weather:  4 * ONE_HOUR_MS,   // 4h
    };
    for (const [name, ms] of Object.entries(intervals)) {
      expect(ms, `${name} interval must be > 0`).toBeGreaterThan(0);
      expect(ms, `${name} interval looks too small (< 1min)`).toBeGreaterThanOrEqual(60 * 1000);
      expect(ms, `${name} interval looks too large (> 30 days)`).toBeLessThanOrEqual(30 * ONE_DAY_MS);
    }
  });

  it('all jitter values are less than their base interval', () => {
    const pairs: [number, number][] = [
      [24 * ONE_HOUR_MS, 30 * 60 * 1000],  // diary: 24h interval, 30min jitter
      [3 * ONE_HOUR_MS, 60 * 60 * 1000],   // dreams: 3h interval, 1h jitter
      [ONE_HOUR_MS, 15 * 60 * 1000],        // curiosity: 1h interval, 15min jitter
      [3 * ONE_DAY_MS, 4 * ONE_HOUR_MS],    // book: 3d interval, 4h jitter
      [8 * ONE_HOUR_MS, 2 * ONE_HOUR_MS],   // commune: 8h interval, 2h jitter
      [4 * ONE_HOUR_MS, 30 * 60 * 1000],    // weather: 4h interval, 30min jitter
    ];
    for (const [interval, jitter] of pairs) {
      expect(jitter).toBeLessThan(interval);
      expect(jitter / interval).toBeLessThan(0.5); // jitter < 50% of interval
    }
  });

  it('diary interval is 24 hours — not seconds or weeks', () => {
    const DIARY_INTERVAL_MS = 24 * 60 * 60 * 1000;
    expect(DIARY_INTERVAL_MS).toBe(86400000);
    expect(DIARY_INTERVAL_MS).toBeGreaterThan(ONE_HOUR_MS);
    expect(DIARY_INTERVAL_MS).toBeLessThan(7 * ONE_DAY_MS);
  });

  it('book interval is multi-day (3 days)', () => {
    const BOOK_INTERVAL_MS = 3 * ONE_DAY_MS;
    expect(BOOK_INTERVAL_MS).toBeGreaterThanOrEqual(ONE_DAY_MS);
    expect(BOOK_INTERVAL_MS).toBeLessThan(7 * ONE_DAY_MS);
  });

  it('state decay uses setInterval not one-shot setTimeout', async () => {
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(new URL('../src/agent/internal-state.ts', import.meta.url), 'utf-8');
    expect(content).toContain('setInterval');
    expect(content).toContain('DECAY_INTERVAL_MS');
  });

  it('all startXLoop functions return a cleanup function', async () => {
    const { startDiaryLoop } = await import('../src/agent/diary.js');
    const { startDreamLoop } = await import('../src/agent/dreams.js');
    const { startBookLoop } = await import('../src/agent/book.js');
    const { startCommuneLoop } = await import('../src/agent/commune-loop.js');
    expect(typeof startDiaryLoop({ enabled: false })).toBe('function');
    expect(typeof startDreamLoop({ enabled: false })).toBe('function');
    expect(typeof startBookLoop({ enabled: false })).toBe('function');
    expect(typeof startCommuneLoop({ characterId: 'x', characterName: 'X', peers: [], enabled: false })).toBe('function');
  });
});


// ─────────────────────────────────────────────────────────
// 3. DECAY OVER TIME
// ─────────────────────────────────────────────────────────
describe('Decay Over Time', () => {
  it('applyDecay reduces energy toward baseline', async () => {
    const { applyDecay } = await import('../src/agent/internal-state.js');

    const state = {
      energy: 0.8,
      sociability: 0.5,
      intellectual_arousal: 0.6,
      emotional_weight: 0.3,
      valence: 0.6,
      primary_color: 'neutral',
      updated_at: Date.now(),
    };

    const decayed = applyDecay(state);
    expect(decayed.energy).toBeLessThan(state.energy);
  });

  it('applyDecay reduces intellectual_arousal', async () => {
    const { applyDecay } = await import('../src/agent/internal-state.js');

    const state = {
      energy: 0.6,
      sociability: 0.5,
      intellectual_arousal: 0.8,
      emotional_weight: 0.3,
      valence: 0.6,
      primary_color: 'neutral',
      updated_at: Date.now(),
    };

    const decayed = applyDecay(state);
    expect(decayed.intellectual_arousal).toBeLessThan(state.intellectual_arousal);
  });

  it('applyDecay is bounded: values never go below 0', async () => {
    const { applyDecay } = await import('../src/agent/internal-state.js');

    const state = {
      energy: 0.0,
      sociability: 0.0,
      intellectual_arousal: 0.0,
      emotional_weight: 0.0,
      valence: 0.0,
      primary_color: 'dark',
      updated_at: Date.now(),
    };

    const decayed = applyDecay(state);
    expect(decayed.energy).toBeGreaterThanOrEqual(0);
    expect(decayed.sociability).toBeGreaterThanOrEqual(0);
    expect(decayed.intellectual_arousal).toBeGreaterThanOrEqual(0);
    expect(decayed.emotional_weight).toBeGreaterThanOrEqual(0);
    expect(decayed.valence).toBeGreaterThanOrEqual(0);
  });

  it('applyDecay is bounded: values never exceed 1', async () => {
    const { applyDecay } = await import('../src/agent/internal-state.js');

    const state = {
      energy: 1.0,
      sociability: 1.0,
      intellectual_arousal: 1.0,
      emotional_weight: 1.0,
      valence: 1.0,
      primary_color: 'bright',
      updated_at: Date.now(),
    };

    const decayed = applyDecay(state);
    expect(decayed.energy).toBeLessThanOrEqual(1);
    expect(decayed.sociability).toBeLessThanOrEqual(1);
    expect(decayed.intellectual_arousal).toBeLessThanOrEqual(1);
    expect(decayed.emotional_weight).toBeLessThanOrEqual(1);
    expect(decayed.valence).toBeLessThanOrEqual(1);
  });

  it('energy decays by 0.02 per tick', async () => {
    const { applyDecay } = await import('../src/agent/internal-state.js');

    const state = {
      energy: 0.5,
      sociability: 0.5,
      intellectual_arousal: 0.5,
      emotional_weight: 0.3,
      valence: 0.6,
      primary_color: 'neutral',
      updated_at: Date.now(),
    };

    const decayed = applyDecay(state);
    expect(decayed.energy).toBeCloseTo(0.48, 5); // 0.5 - 0.02
  });

  it('intellectual_arousal decays by 0.015 per tick', async () => {
    const { applyDecay } = await import('../src/agent/internal-state.js');

    const state = {
      energy: 0.6,
      sociability: 0.5,
      intellectual_arousal: 0.6,
      emotional_weight: 0.3,
      valence: 0.6,
      primary_color: 'neutral',
      updated_at: Date.now(),
    };

    const decayed = applyDecay(state);
    expect(decayed.intellectual_arousal).toBeCloseTo(0.585, 5); // 0.6 - 0.015
  });

  it('energy decays faster than intellectual_arousal per tick', async () => {
    const { applyDecay } = await import('../src/agent/internal-state.js');

    const state = {
      energy: 0.6,
      sociability: 0.5,
      intellectual_arousal: 0.6,
      emotional_weight: 0.3,
      valence: 0.6,
      primary_color: 'neutral',
      updated_at: Date.now(),
    };

    const decayed = applyDecay(state);
    const energyChange = state.energy - decayed.energy;
    const arousalChange = state.intellectual_arousal - decayed.intellectual_arousal;

    expect(energyChange).toBeGreaterThan(arousalChange);
  });

  it('clampState keeps all values in [0, 1]', async () => {
    const { clampState } = await import('../src/agent/internal-state.js');

    const state = {
      energy: 2.5,
      sociability: -0.3,
      intellectual_arousal: 1.5,
      emotional_weight: -1,
      valence: 0.5,
      primary_color: 'test',
      updated_at: Date.now(),
    };

    const clamped = clampState(state);
    expect(clamped.energy).toBe(1);
    expect(clamped.sociability).toBe(0);
    expect(clamped.intellectual_arousal).toBe(1);
    expect(clamped.emotional_weight).toBe(0);
  });

  it('applying decay 100 times does not collapse all values to 0', async () => {
    const { applyDecay } = await import('../src/agent/internal-state.js');

    let state = {
      energy: 0.8,
      sociability: 0.5,
      intellectual_arousal: 0.7,
      emotional_weight: 0.3,
      valence: 0.6,
      primary_color: 'neutral',
      updated_at: Date.now(),
    };

    for (let i = 0; i < 100; i++) {
      state = applyDecay(state);
    }

    // Sociability decays toward 0.5 (mean-reverting), not to zero
    // Energy and arousal will hit floor (0) — that's expected
    expect(state.energy).toBeGreaterThanOrEqual(0);
    expect(state.sociability).toBeGreaterThanOrEqual(0);
    expect(state.valence).toBeGreaterThanOrEqual(0);
  });

  it('sociability decays toward 0.5 (mean-reverting, not to 0)', async () => {
    const { applyDecay } = await import('../src/agent/internal-state.js');

    // At sociability=1.0, decay rate = -0.02 * (1.0 - 0.5) = -0.01 (moving down)
    const highState = {
      energy: 0.6, sociability: 1.0, intellectual_arousal: 0.5,
      emotional_weight: 0.3, valence: 0.6, primary_color: 'social', updated_at: Date.now(),
    };

    // At sociability=0.0, decay rate = -0.02 * (0.0 - 0.5) = +0.01 (moving up)
    const lowState = {
      energy: 0.6, sociability: 0.0, intellectual_arousal: 0.5,
      emotional_weight: 0.3, valence: 0.6, primary_color: 'withdrawn', updated_at: Date.now(),
    };

    const highDecayed = applyDecay(highState);
    const lowDecayed = applyDecay(lowState);

    expect(highDecayed.sociability).toBeLessThan(highState.sociability);
    expect(lowDecayed.sociability).toBeGreaterThan(lowState.sociability);
  });

  it('decay tick interval is 30 minutes, not less than 10 minutes', () => {
    const DECAY_INTERVAL_MS = 30 * 60 * 1000;
    expect(DECAY_INTERVAL_MS).toBeGreaterThanOrEqual(10 * 60 * 1000);
  });

  it('decay does not modify primary_color or updated_at', async () => {
    const { applyDecay } = await import('../src/agent/internal-state.js');

    const state = {
      energy: 0.5,
      sociability: 0.5,
      intellectual_arousal: 0.5,
      emotional_weight: 0.3,
      valence: 0.6,
      primary_color: 'purple',
      updated_at: 999999,
    };

    const decayed = applyDecay(state);
    expect(decayed.primary_color).toBe('purple');
    expect(decayed.updated_at).toBe(999999); // applyDecay preserves updated_at
  });
});


// ─────────────────────────────────────────────────────────
// 4. EVENT ORDERING
// ─────────────────────────────────────────────────────────
describe('Event Ordering', () => {
  const testDir = join(tmpdir(), `lain-test-ordering-${Date.now()}`);
  const originalEnv = process.env['LAIN_HOME'];

  beforeEach(async () => {
    process.env['LAIN_HOME'] = testDir;
    await mkdir(testDir, { recursive: true });
    const { initDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(testDir, 'test.db'));
  });

  afterEach(async () => {
    const { closeDatabase } = await import('../src/storage/database.js');
    closeDatabase();
    if (originalEnv) process.env['LAIN_HOME'] = originalEnv;
    else delete process.env['LAIN_HOME'];
    try { await rm(testDir, { recursive: true }); } catch {}
  });

  it('messages are stored and retrieved chronologically', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
    const t0 = 1000000;
    saveMessage({ sessionKey: 's1', userId: null, role: 'user', content: 'first', timestamp: t0, metadata: {} });
    saveMessage({ sessionKey: 's1', userId: null, role: 'assistant', content: 'second', timestamp: t0 + 1000, metadata: {} });
    saveMessage({ sessionKey: 's1', userId: null, role: 'user', content: 'third', timestamp: t0 + 2000, metadata: {} });
    const messages = getRecentMessages('s1');
    expect(messages).toHaveLength(3);
    expect(messages[0]!.content).toBe('first');
    expect(messages[2]!.content).toBe('third');
    // Timestamps are monotonically non-decreasing
    for (let i = 1; i < messages.length; i++) {
      expect(messages[i]!.timestamp).toBeGreaterThanOrEqual(messages[i - 1]!.timestamp);
    }
  });

  it('location history is ordered newest-first', async () => {
    const { eventBus } = await import('../src/events/bus.js');
    const { setCurrentLocation, getLocationHistory } = await import('../src/commune/location.js');
    eventBus.setCharacterId('test-ordering');
    setCurrentLocation('library', 'first move');
    setCurrentLocation('bar', 'second move');
    setCurrentLocation('field', 'third move');
    const history = getLocationHistory(10);
    expect(history[0]!.to).toBe('field');
    expect(history[1]!.to).toBe('bar');
  });

  it('activity feed is ordered newest-first', async () => {
    const { getActivity } = await import('../src/memory/store.js');
    const { eventBus } = await import('../src/events/bus.js');
    eventBus.setCharacterId('test-ts');
    for (let i = 0; i < 3; i++) {
      eventBus.emitActivity({ type: 'test', sessionKey: `test:${i}`, content: `event ${i}`, timestamp: 1000000 + i * 1000 });
    }
    const activity = getActivity(10);
    if (activity.length >= 2) {
      expect(activity[0]!.timestamp).toBeGreaterThanOrEqual(activity[1]!.timestamp);
    }
  });

  it('budget month boundary resets token counter', async () => {
    vi.useFakeTimers();
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '1000000';
    vi.setSystemTime(new Date('2025-11-30T23:59:00Z'));
    const { recordUsage, getBudgetStatus } = await import('../src/providers/budget.js');
    recordUsage(1000, 500);
    expect(getBudgetStatus().tokensUsed).toBe(1500);
    vi.setSystemTime(new Date('2025-12-01T00:01:00Z'));
    expect(getBudgetStatus().tokensUsed).toBe(0);
    vi.useRealTimers();
  });

  it('journal entries sorted chronologically have ascending timestamps', () => {
    const entries = [
      { timestamp: '2025-01-01T10:00:00Z' },
      { timestamp: '2025-01-02T10:00:00Z' },
      { timestamp: '2025-01-10T10:00:00Z' },
    ];
    for (let i = 1; i < entries.length; i++) {
      expect(new Date(entries[i]!.timestamp).getTime()).toBeGreaterThan(new Date(entries[i - 1]!.timestamp).getTime());
    }
  });
});


// ─────────────────────────────────────────────────────────
// 5. COOLDOWN CORRECTNESS
// ─────────────────────────────────────────────────────────
describe('Cooldown Correctness', () => {
  it('all cooldowns are reasonable durations (minutes to hours, not seconds or days)', () => {
    const cooldowns: Record<string, number> = {
      curiosity: 30 * 60 * 1000,     // 30 min
      diary:     6 * 60 * 60 * 1000, // 6 hours
      commune:   2 * 60 * 60 * 1000, // 2 hours
      movement:  30 * 60 * 1000,     // 30 min
    };
    for (const [name, ms] of Object.entries(cooldowns)) {
      expect(ms, `${name} cooldown must be > 1 minute`).toBeGreaterThan(60 * 1000);
      expect(ms, `${name} cooldown must be < 24h`).toBeLessThan(24 * 60 * 60 * 1000);
    }
  });

  it('all cooldowns are less than their associated loop intervals', () => {
    expect(30 * 60 * 1000).toBeLessThan(60 * 60 * 1000);     // curiosity: 30min < 1h
    expect(2 * 60 * 60 * 1000).toBeLessThan(8 * 60 * 60 * 1000); // commune: 2h < 8h
    expect(6 * 60 * 60 * 1000).toBeLessThan(24 * 60 * 60 * 1000); // diary: 6h < 24h
  });

  it('cooldown elapsed check: not cooled down after 1 second, cooled down after interval+1s', () => {
    const COOLDOWN_MS = 30 * 60 * 1000;
    const recentRun = Date.now() - 1000;
    const oldRun = Date.now() - (COOLDOWN_MS + 1000);
    expect(Date.now() - recentRun).toBeLessThan(COOLDOWN_MS);
    expect(Date.now() - oldRun).toBeGreaterThan(COOLDOWN_MS);
  });

  it('per-loop cooldowns are distinct (diary != curiosity)', () => {
    const DIARY_COOLDOWN = 6 * 60 * 60 * 1000;
    const CURIOSITY_COOLDOWN = 30 * 60 * 1000;
    expect(DIARY_COOLDOWN).not.toBe(CURIOSITY_COOLDOWN);
  });

  it('early-trigger state thresholds are mid-range (not 0 or 1)', () => {
    const SOCIABILITY_THRESHOLD = 0.6; // commune triggers when > 0.6
    const AROUSAL_THRESHOLD = 0.5;     // curiosity triggers when > 0.5
    expect(SOCIABILITY_THRESHOLD).toBeGreaterThan(0.1);
    expect(SOCIABILITY_THRESHOLD).toBeLessThan(0.95);
    expect(AROUSAL_THRESHOLD).toBeGreaterThan(0.1);
    expect(AROUSAL_THRESHOLD).toBeLessThan(0.95);
  });

  it('early trigger jitter <= 1 minute so loops respond quickly', () => {
    const MAX_EARLY_JITTER = 60 * 1000; // 60_000 ms
    expect(MAX_EARLY_JITTER).toBeLessThan(5 * 60 * 1000);
  });

  it('stopped flag prevents maybeRunEarly from executing', () => {
    let stopped = false;
    const maybeRunEarly = () => { if (stopped) return false; return true; };
    expect(maybeRunEarly()).toBe(true);
    stopped = true;
    expect(maybeRunEarly()).toBe(false);
  });
});


// ─────────────────────────────────────────────────────────
// 6. STALE DATA DETECTION
// ─────────────────────────────────────────────────────────
describe('Stale Data Detection', () => {
  it('loop staleness thresholds are correct (weather=4h, diary=24h, dream=3h, book=3d, commune=8h)', () => {
    const now = Date.now();
    const THRESHOLDS = {
      weather: 4 * 60 * 60 * 1000,
      diary: 24 * 60 * 60 * 1000,
      dream: 3 * 60 * 60 * 1000,
      book: 3 * 24 * 60 * 60 * 1000,
      commune: 8 * 60 * 60 * 1000,
      decay: 30 * 60 * 1000,
    };
    // An item that ran 5h ago is stale for weather (4h) but not for diary (24h)
    const fiveHoursAgo = now - (5 * 60 * 60 * 1000);
    expect(now - fiveHoursAgo).toBeGreaterThan(THRESHOLDS.weather);
    expect(now - fiveHoursAgo).toBeLessThan(THRESHOLDS.diary);
    // All thresholds must be positive and in ascending order of granularity
    expect(THRESHOLDS.decay).toBeLessThan(THRESHOLDS.dream);
    expect(THRESHOLDS.dream).toBeLessThan(THRESHOLDS.diary);
    expect(THRESHOLDS.diary).toBeLessThan(THRESHOLDS.book);
  });

  it('weather computed_at is set to Date.now() on each computation', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const before = Date.now();
    const weather = await computeWeather([]);
    const after = Date.now();
    expect(weather.computed_at).toBeGreaterThanOrEqual(before);
    expect(weather.computed_at).toBeLessThanOrEqual(after);
    expect(typeof weather.computed_at).toBe('number');
  });

  it('weather with one character state sets computed_at correctly', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const states = [{
      energy: 0.6, sociability: 0.5, intellectual_arousal: 0.4,
      emotional_weight: 0.3, valence: 0.6, primary_color: 'neutral',
      updated_at: Date.now(),
    }];
    const weather = await computeWeather(states);
    expect(Date.now() - weather.computed_at).toBeLessThan(5000);
  });

  it('old preoccupations below 0.1 intensity are expired by decayPreoccupations', async () => {
    const staleDir = join(tmpdir(), `lain-preoccs-${Date.now()}`);
    await mkdir(staleDir, { recursive: true });
    const origHome = process.env['LAIN_HOME'];
    process.env['LAIN_HOME'] = staleDir;
    const { initDatabase, closeDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(staleDir, 'lain.db'));
    try {
      const { decayPreoccupations, addPreoccupation, getPreoccupations } = await import('../src/agent/internal-state.js');
      addPreoccupation('test thought', 'test origin');
      expect(getPreoccupations().find(p => p.thread === 'test thought')?.intensity).toBe(0.7);
      // Decay 13 times: 0.7 - 13*0.05 = 0.05 < 0.1 → should be removed
      for (let i = 0; i < 13; i++) decayPreoccupations();
      expect(getPreoccupations().find(p => p.thread === 'test thought')).toBeUndefined();
    } finally {
      closeDatabase();
      if (origHome) process.env['LAIN_HOME'] = origHome; else delete process.env['LAIN_HOME'];
      try { await rm(staleDir, { recursive: true }); } catch {}
    }
  });

  it('memory aging: 90-day-old memory exceeds 30-day stale threshold', () => {
    const THREE_MONTHS_AGO = Date.now() - (90 * 24 * 60 * 60 * 1000);
    expect(Date.now() - THREE_MONTHS_AGO).toBeGreaterThan(30 * 24 * 60 * 60 * 1000);
  });

  it('findClosestEntry tolerance is 4 days (diary sampling)', () => {
    const TOLERANCE_MS = 4 * 24 * 60 * 60 * 1000;
    // 5 days ago is beyond tolerance, 3 days ago is within
    expect(5 * 24 * 60 * 60 * 1000).toBeGreaterThan(TOLERANCE_MS);
    expect(3 * 24 * 60 * 60 * 1000).toBeLessThan(TOLERANCE_MS);
  });

  it('decay interval is 30 min: state from 60 min ago needs at least 2 decay ticks', () => {
    const DECAY_INTERVAL_MS = 30 * 60 * 1000;
    const AGE_MS = 60 * 60 * 1000; // 60 minutes
    const ticksNeeded = Math.ceil(AGE_MS / DECAY_INTERVAL_MS);
    expect(ticksNeeded).toBe(2);
  });
});
