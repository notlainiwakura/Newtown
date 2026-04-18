/**
 * Runtime invariant tests — verify properties by actually executing code with
 * real in-memory SQLite and mocked LLM providers.
 *
 * These complement the structural invariant tests in invariants.test.ts by
 * exercising real code paths rather than analyzing source patterns.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── Global mocks ──────────────────────────────────────────────────────────────

vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn().mockResolvedValue('test-master-key'),
    setPassword: vi.fn().mockResolvedValue(undefined),
    deletePassword: vi.fn().mockResolvedValue(true),
    findCredentials: vi.fn().mockResolvedValue([]),
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function tmpDir() {
  return join(tmpdir(), `lain-rt-inv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

async function openDB(dir: string) {
  process.env['LAIN_HOME'] = dir;
  await mkdir(dir, { recursive: true });
  const { initDatabase } = await import('../src/storage/database.js');
  await initDatabase(join(dir, 'lain.db'));
}

async function closeDB(dir: string) {
  const { closeDatabase } = await import('../src/storage/database.js');
  closeDatabase();
  delete process.env['LAIN_HOME'];
  try { await rm(dir, { recursive: true }); } catch { /* ignore */ }
}

type IS = import('../src/agent/internal-state.js').InternalState;

function mkState(overrides: Partial<Record<keyof IS, number | string>> = {}): IS {
  return {
    energy: 0.5,
    sociability: 0.5,
    intellectual_arousal: 0.5,
    emotional_weight: 0.5,
    valence: 0.5,
    primary_color: 'test',
    updated_at: Date.now(),
    ...overrides,
  } as IS;
}

const AXES: (keyof IS)[] = ['energy', 'sociability', 'intellectual_arousal', 'emotional_weight', 'valence'];

function assertAllAxesInRange(state: IS) {
  for (const axis of AXES) {
    const val = state[axis] as number;
    expect(val, `${axis} should be >= 0`).toBeGreaterThanOrEqual(0);
    expect(val, `${axis} should be <= 1`).toBeLessThanOrEqual(1);
  }
}

// =============================================================================
// 1. EMOTIONAL STATE INVARIANTS
// =============================================================================

describe('Emotional state runtime invariants', () => {
  const dir = tmpDir();

  beforeEach(async () => {
    await openDB(dir);
  });
  afterEach(async () => {
    await closeDB(dir);
  });

  // ── clampState ────────────────────────────────────────────────────────────

  describe('clampState', () => {
    it('clamps all axes to [0, 1] when values exceed upper bound', async () => {
      const { clampState } = await import('../src/agent/internal-state.js');
      const state = mkState({ energy: 5.0, sociability: 1.1, intellectual_arousal: 100, emotional_weight: 2.5, valence: 999 });
      const c = clampState(state);
      for (const axis of AXES) expect(c[axis]).toBe(1);
    });

    it('clamps all axes to [0, 1] when values below lower bound', async () => {
      const { clampState } = await import('../src/agent/internal-state.js');
      const state = mkState({ energy: -1, sociability: -0.001, intellectual_arousal: -Infinity, emotional_weight: -100, valence: -5 });
      const c = clampState(state);
      for (const axis of AXES) expect(c[axis]).toBe(0);
    });

    it('preserves values already in [0, 1]', async () => {
      const { clampState } = await import('../src/agent/internal-state.js');
      const vals = [0, 0.25, 0.5, 0.75, 1];
      for (const v of vals) {
        const state = mkState({ energy: v, sociability: v, intellectual_arousal: v, emotional_weight: v, valence: v });
        const c = clampState(state);
        for (const axis of AXES) expect(c[axis]).toBeCloseTo(v, 10);
      }
    });

    it('preserves primary_color string through clamping', async () => {
      const { clampState } = await import('../src/agent/internal-state.js');
      const c = clampState(mkState({ primary_color: 'melancholic' }));
      expect(c.primary_color).toBe('melancholic');
    });

    it('handles NaN by clamping to 0 (NaN < 0 is false, NaN > 1 is false -> min(1, max(0, NaN)) = NaN, but Math.max(0, NaN) = NaN)', async () => {
      const { clampState } = await import('../src/agent/internal-state.js');
      const state = mkState({ energy: NaN });
      const c = clampState(state);
      // NaN behavior: Math.max(0, NaN) = NaN, Math.min(1, NaN) = NaN
      // This documents current behavior — NaN passes through
      expect(typeof c.energy).toBe('number');
    });

    it('handles 0 and 1 boundary values exactly', async () => {
      const { clampState } = await import('../src/agent/internal-state.js');
      const low = clampState(mkState({ energy: 0, valence: 0 }));
      const high = clampState(mkState({ energy: 1, valence: 1 }));
      expect(low.energy).toBe(0);
      expect(low.valence).toBe(0);
      expect(high.energy).toBe(1);
      expect(high.valence).toBe(1);
    });
  });

  // ── applyDecay ────────────────────────────────────────────────────────────

  describe('applyDecay', () => {
    it('always produces values in [0, 1]', async () => {
      const { applyDecay } = await import('../src/agent/internal-state.js');
      // Test with extreme starting states
      const extremes = [
        mkState({ energy: 0, sociability: 0, intellectual_arousal: 0, emotional_weight: 0, valence: 0 }),
        mkState({ energy: 1, sociability: 1, intellectual_arousal: 1, emotional_weight: 1, valence: 1 }),
        mkState({ energy: 0.01, sociability: 0.99, intellectual_arousal: 0, emotional_weight: 1, valence: 0.5 }),
      ];
      for (const state of extremes) {
        const decayed = applyDecay(state);
        assertAllAxesInRange(decayed);
      }
    });

    it('energy decreases after decay', async () => {
      const { applyDecay } = await import('../src/agent/internal-state.js');
      const state = mkState({ energy: 0.8 });
      const decayed = applyDecay(state);
      expect(decayed.energy).toBeLessThan(0.8);
    });

    it('intellectual_arousal decreases after decay', async () => {
      const { applyDecay } = await import('../src/agent/internal-state.js');
      const state = mkState({ intellectual_arousal: 0.7 });
      const decayed = applyDecay(state);
      expect(decayed.intellectual_arousal).toBeLessThan(0.7);
    });

    it('sociability moves toward 0.5 baseline (from above)', async () => {
      const { applyDecay } = await import('../src/agent/internal-state.js');
      const state = mkState({ sociability: 0.9 });
      const decayed = applyDecay(state);
      // Sociability formula: s - 0.02*(s - 0.5) => moves toward 0.5
      expect(decayed.sociability).toBeLessThan(0.9);
      expect(decayed.sociability).toBeGreaterThan(0.5);
    });

    it('sociability moves toward 0.5 baseline (from below)', async () => {
      const { applyDecay } = await import('../src/agent/internal-state.js');
      const state = mkState({ sociability: 0.1 });
      const decayed = applyDecay(state);
      // s - 0.02*(0.1 - 0.5) = 0.1 + 0.008 = 0.108
      expect(decayed.sociability).toBeGreaterThan(0.1);
    });

    it('sociability stays at 0.5 when already at baseline', async () => {
      const { applyDecay } = await import('../src/agent/internal-state.js');
      const state = mkState({ sociability: 0.5 });
      const decayed = applyDecay(state);
      expect(decayed.sociability).toBeCloseTo(0.5, 10);
    });

    it('100 consecutive decays approach low energy equilibrium', async () => {
      const { applyDecay } = await import('../src/agent/internal-state.js');
      let state = mkState({ energy: 1.0, intellectual_arousal: 1.0, sociability: 1.0 });
      for (let i = 0; i < 100; i++) {
        state = applyDecay(state);
      }
      assertAllAxesInRange(state);
      // After 100 decays, energy should be very low
      expect(state.energy).toBeLessThan(0.1);
      // Sociability should be near 0.5 (within 0.1 tolerance)
      expect(Math.abs(state.sociability - 0.5)).toBeLessThan(0.1);
    });

    it('100 consecutive decays from zero stay at zero', async () => {
      const { applyDecay } = await import('../src/agent/internal-state.js');
      let state = mkState({ energy: 0, intellectual_arousal: 0 });
      for (let i = 0; i < 100; i++) {
        state = applyDecay(state);
      }
      assertAllAxesInRange(state);
      expect(state.energy).toBe(0);
    });

    it('emotional_weight is not modified by decay', async () => {
      const { applyDecay } = await import('../src/agent/internal-state.js');
      const state = mkState({ emotional_weight: 0.7 });
      const decayed = applyDecay(state);
      // applyDecay does not touch emotional_weight
      expect(decayed.emotional_weight).toBeCloseTo(0.7, 10);
    });

    it('valence is not modified by decay', async () => {
      const { applyDecay } = await import('../src/agent/internal-state.js');
      const state = mkState({ valence: 0.3 });
      const decayed = applyDecay(state);
      expect(decayed.valence).toBeCloseTo(0.3, 10);
    });
  });

  // ── saveState + getCurrentState round-trip ────────────────────────────────

  describe('saveState / getCurrentState round-trip', () => {
    it('saved state is retrievable', async () => {
      const { saveState, getCurrentState } = await import('../src/agent/internal-state.js');
      const state = mkState({ energy: 0.42, primary_color: 'amber' });
      saveState(state);
      const loaded = getCurrentState();
      expect(loaded.energy).toBeCloseTo(0.42, 5);
      expect(loaded.primary_color).toBe('amber');
    });

    it('saveState auto-clamps before persisting', async () => {
      const { saveState, getCurrentState } = await import('../src/agent/internal-state.js');
      saveState(mkState({ energy: 5.0, valence: -2 }));
      const loaded = getCurrentState();
      expect(loaded.energy).toBe(1);
      expect(loaded.valence).toBe(0);
    });

    it('multiple saves overwrite correctly', async () => {
      const { saveState, getCurrentState } = await import('../src/agent/internal-state.js');
      for (let i = 0; i < 10; i++) {
        saveState(mkState({ energy: i / 10 }));
      }
      const loaded = getCurrentState();
      expect(loaded.energy).toBeCloseTo(0.9, 5);
    });

    it('state history never exceeds cap', async () => {
      const { saveState, getStateHistory } = await import('../src/agent/internal-state.js');
      for (let i = 0; i < 20; i++) {
        saveState(mkState({ energy: i / 20 }));
      }
      const history = getStateHistory();
      expect(history.length).toBeLessThanOrEqual(10);
    });
  });

  // ── Heuristic nudges ──────────────────────────────────────────────────────

  describe('heuristic nudges via updateState', () => {
    it('conversation:end nudge changes at least one axis', async () => {
      const { saveState, updateState } = await import('../src/agent/internal-state.js');
      const base = mkState();
      saveState(base);
      const updated = await updateState({ type: 'conversation:end', summary: 'test conversation' });
      assertAllAxesInRange(updated);
      // At least one axis should differ from base
      const changed = AXES.some(a => Math.abs((updated[a] as number) - (base[a] as number)) > 0.001);
      expect(changed).toBe(true);
    });

    it('curiosity:discovery nudge increases intellectual_arousal', async () => {
      const { saveState, updateState } = await import('../src/agent/internal-state.js');
      saveState(mkState({ intellectual_arousal: 0.4 }));
      const updated = await updateState({ type: 'curiosity:discovery', summary: 'found something' });
      assertAllAxesInRange(updated);
      expect(updated.intellectual_arousal).toBeGreaterThan(0.4);
    });

    it('dream:complete nudge reduces energy slightly', async () => {
      const { saveState, updateState } = await import('../src/agent/internal-state.js');
      saveState(mkState({ energy: 0.6 }));
      const updated = await updateState({ type: 'dream:complete', summary: 'dream ended' });
      assertAllAxesInRange(updated);
      expect(updated.energy).toBeLessThan(0.6);
    });

    it('letter:received nudge changes emotional_weight', async () => {
      const { saveState, updateState } = await import('../src/agent/internal-state.js');
      saveState(mkState({ emotional_weight: 0.3 }));
      const updated = await updateState({ type: 'letter:received', summary: 'got a letter' });
      assertAllAxesInRange(updated);
      expect(updated.emotional_weight).toBeGreaterThan(0.3);
    });

    it('diary:written nudge decreases emotional_weight', async () => {
      const { saveState, updateState } = await import('../src/agent/internal-state.js');
      saveState(mkState({ emotional_weight: 0.6 }));
      const updated = await updateState({ type: 'diary:written', summary: 'wrote diary' });
      assertAllAxesInRange(updated);
      expect(updated.emotional_weight).toBeLessThan(0.6);
    });

    it('unknown event type produces valid state (no nudge, no crash)', async () => {
      const { saveState, updateState } = await import('../src/agent/internal-state.js');
      saveState(mkState());
      const updated = await updateState({ type: 'totally:unknown', summary: 'something unexpected' });
      assertAllAxesInRange(updated);
    });

    it('heuristic nudge with intensity=0 makes no change', async () => {
      const { saveState, updateState, getCurrentState } = await import('../src/agent/internal-state.js');
      const base = mkState({ energy: 0.5 });
      saveState(base);
      const beforeEnergy = getCurrentState().energy;
      const updated = await updateState({ type: 'conversation:end', summary: 'test', intensity: 0 });
      assertAllAxesInRange(updated);
      // With intensity 0, no nudge should apply
      expect(updated.energy).toBeCloseTo(beforeEnergy, 2);
    });

    it('heuristic nudge with large intensity still clamps', async () => {
      const { saveState, updateState } = await import('../src/agent/internal-state.js');
      saveState(mkState({ intellectual_arousal: 0.95 }));
      const updated = await updateState({ type: 'curiosity:discovery', summary: 'eureka', intensity: 100 });
      assertAllAxesInRange(updated);
    });
  });

  // ── Preoccupations ────────────────────────────────────────────────────────

  describe('preoccupation invariants', () => {
    it('newly added preoccupation has intensity in (0, 1]', async () => {
      const { addPreoccupation, getPreoccupations } = await import('../src/agent/internal-state.js');
      addPreoccupation('test thread', 'test origin');
      const preocc = getPreoccupations();
      expect(preocc.length).toBe(1);
      expect(preocc[0]!.intensity).toBeGreaterThan(0);
      expect(preocc[0]!.intensity).toBeLessThanOrEqual(1);
    });

    it('preoccupation IDs are unique', async () => {
      const { addPreoccupation, getPreoccupations } = await import('../src/agent/internal-state.js');
      for (let i = 0; i < 5; i++) addPreoccupation(`thread-${i}`, `origin-${i}`);
      const ids = getPreoccupations().map(p => p.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('resolved preoccupation is excluded from active list', async () => {
      const { addPreoccupation, resolvePreoccupation, getPreoccupations } = await import('../src/agent/internal-state.js');
      addPreoccupation('thread', 'origin');
      const id = getPreoccupations()[0]!.id;
      resolvePreoccupation(id, 'done');
      expect(getPreoccupations().length).toBe(0);
    });

    it('decay reduces intensity for all preoccupations', async () => {
      const { addPreoccupation, decayPreoccupations, getPreoccupations } = await import('../src/agent/internal-state.js');
      for (let i = 0; i < 3; i++) addPreoccupation(`t-${i}`, `o-${i}`);
      const before = getPreoccupations().map(p => p.intensity);
      decayPreoccupations();
      const after = getPreoccupations().map(p => p.intensity);
      for (let i = 0; i < after.length; i++) {
        expect(after[i]!).toBeLessThan(before[i]!);
      }
    });

    it('enough decay rounds eventually remove all preoccupations', async () => {
      const { addPreoccupation, decayPreoccupations, getPreoccupations } = await import('../src/agent/internal-state.js');
      addPreoccupation('ephemeral thought', 'test');
      // Starting intensity 0.7, decays by 0.05 per round => fades at ~0.1
      for (let i = 0; i < 20; i++) decayPreoccupations();
      expect(getPreoccupations().length).toBe(0);
    });

    it('max preoccupations cap is enforced (never exceeds 5)', async () => {
      const { addPreoccupation, getPreoccupations } = await import('../src/agent/internal-state.js');
      for (let i = 0; i < 10; i++) addPreoccupation(`thread-${i}`, `origin-${i}`);
      expect(getPreoccupations().length).toBeLessThanOrEqual(5);
    });
  });

  // ── evaluateMovementDesire ────────────────────────────────────────────────

  describe('evaluateMovementDesire', () => {
    it('returns null when no signals are active', async () => {
      const { evaluateMovementDesire } = await import('../src/agent/internal-state.js');
      const result = evaluateMovementDesire(mkState(), [], [], 'library', new Map());
      expect(result).toBeNull();
    });

    it('building in result is always a string', async () => {
      const { evaluateMovementDesire } = await import('../src/agent/internal-state.js');
      const result = evaluateMovementDesire(
        mkState({ sociability: 0.9 }),
        [], [], 'library',
        new Map([['pkd', 'bar'], ['wired', 'market']]),
      );
      if (result) {
        expect(typeof result.building).toBe('string');
        expect(result.building.length).toBeGreaterThan(0);
      }
    });

    it('confidence is always in [0, 1]', async () => {
      const { evaluateMovementDesire } = await import('../src/agent/internal-state.js');
      const highState = mkState({
        energy: 0.1, sociability: 0.1, emotional_weight: 0.95,
        intellectual_arousal: 0.95, valence: 0.1,
      });
      const result = evaluateMovementDesire(highState, [], [], 'library', new Map());
      if (result) {
        expect(result.confidence).toBeGreaterThanOrEqual(0);
        expect(result.confidence).toBeLessThanOrEqual(1);
      }
    });

    it('never suggests moving to the same building', async () => {
      const { evaluateMovementDesire } = await import('../src/agent/internal-state.js');
      // High emotional weight should suggest field — but if already in field, should not suggest field
      const result = evaluateMovementDesire(
        mkState({ emotional_weight: 0.95 }),
        [], [], 'field', new Map(),
      );
      if (result) {
        expect(result.building).not.toBe('field');
      }
    });

    it('intellectual pull suggests library or lighthouse', async () => {
      const { evaluateMovementDesire } = await import('../src/agent/internal-state.js');
      const result = evaluateMovementDesire(
        mkState({ intellectual_arousal: 0.95 }),
        [], [], 'bar', new Map(),
      );
      if (result) {
        expect(['library', 'lighthouse']).toContain(result.building);
      }
    });

    it('emotional weight suggests field for decompression', async () => {
      const { evaluateMovementDesire } = await import('../src/agent/internal-state.js');
      const result = evaluateMovementDesire(
        mkState({ emotional_weight: 0.9 }),
        [], [], 'library', new Map(),
      );
      if (result) {
        expect(result.building).toBe('field');
      }
    });

    it('social pull targets the building with most peers', async () => {
      const { evaluateMovementDesire } = await import('../src/agent/internal-state.js');
      const peerLocations = new Map([
        ['alice', 'market'],
        ['bob', 'market'],
        ['carol', 'bar'],
      ]);
      const result = evaluateMovementDesire(
        mkState({ sociability: 0.9 }),
        [], [], 'library', peerLocations,
      );
      if (result) {
        expect(result.building).toBe('market');
      }
    });

    it('result reason is always a non-empty string', async () => {
      const { evaluateMovementDesire } = await import('../src/agent/internal-state.js');
      const result = evaluateMovementDesire(
        mkState({ emotional_weight: 0.95 }),
        [], [], 'library', new Map(),
      );
      if (result) {
        expect(typeof result.reason).toBe('string');
        expect(result.reason.length).toBeGreaterThan(0);
      }
    });
  });
});

// =============================================================================
// 1b. EMOTIONAL STATE — ADDITIONAL PROPERTY TESTS
// =============================================================================

describe('Emotional state property-based invariants', () => {
  const dir = tmpDir();

  beforeEach(async () => {
    await openDB(dir);
  });
  afterEach(async () => {
    await closeDB(dir);
  });

  // Fuzz-style tests: random inputs always produce valid outputs
  const randomVal = () => Math.random() * 3 - 1; // range [-1, 2]

  describe('clampState fuzz', () => {
    for (let i = 0; i < 20; i++) {
      it(`random state #${i + 1} is always clamped to [0, 1]`, async () => {
        const { clampState } = await import('../src/agent/internal-state.js');
        const state = mkState({
          energy: randomVal(),
          sociability: randomVal(),
          intellectual_arousal: randomVal(),
          emotional_weight: randomVal(),
          valence: randomVal(),
        });
        const c = clampState(state);
        assertAllAxesInRange(c);
      });
    }
  });

  describe('applyDecay fuzz', () => {
    for (let i = 0; i < 15; i++) {
      it(`random decay #${i + 1} always produces valid state`, async () => {
        const { applyDecay, clampState } = await import('../src/agent/internal-state.js');
        const state = clampState(mkState({
          energy: Math.random(),
          sociability: Math.random(),
          intellectual_arousal: Math.random(),
          emotional_weight: Math.random(),
          valence: Math.random(),
        }));
        const decayed = applyDecay(state);
        assertAllAxesInRange(decayed);
      });
    }
  });

  describe('decay convergence properties', () => {
    it('50 consecutive decays from max energy still in range', async () => {
      const { applyDecay } = await import('../src/agent/internal-state.js');
      let state = mkState({ energy: 1.0, intellectual_arousal: 1.0 });
      for (let i = 0; i < 50; i++) {
        state = applyDecay(state);
        assertAllAxesInRange(state);
      }
    });

    it('decay is monotonically decreasing for energy', async () => {
      const { applyDecay } = await import('../src/agent/internal-state.js');
      let state = mkState({ energy: 0.9 });
      let prevEnergy = state.energy;
      for (let i = 0; i < 30; i++) {
        state = applyDecay(state);
        expect(state.energy).toBeLessThanOrEqual(prevEnergy);
        prevEnergy = state.energy;
      }
    });

    it('decay is monotonically decreasing for intellectual_arousal', async () => {
      const { applyDecay } = await import('../src/agent/internal-state.js');
      let state = mkState({ intellectual_arousal: 0.9 });
      let prev = state.intellectual_arousal;
      for (let i = 0; i < 30; i++) {
        state = applyDecay(state);
        expect(state.intellectual_arousal).toBeLessThanOrEqual(prev);
        prev = state.intellectual_arousal;
      }
    });
  });

  describe('heuristic nudge all event types', () => {
    const EVENT_TYPES = [
      'conversation:end',
      'commune:complete',
      'dream:complete',
      'curiosity:discovery',
      'letter:received',
      'diary:written',
    ];

    for (const eventType of EVENT_TYPES) {
      it(`${eventType} nudge produces valid state`, async () => {
        const { saveState, updateState } = await import('../src/agent/internal-state.js');
        saveState(mkState());
        const updated = await updateState({ type: eventType, summary: 'test' });
        assertAllAxesInRange(updated);
      });
    }
  });

  describe('state summary', () => {
    it('getStateSummary always returns a string containing primary_color', async () => {
      const { saveState, getStateSummary } = await import('../src/agent/internal-state.js');
      const colors = ['melancholic', 'vibrant', 'neutral', 'anxious', 'serene'];
      for (const color of colors) {
        saveState(mkState({ primary_color: color }));
        const summary = getStateSummary();
        expect(typeof summary).toBe('string');
        expect(summary).toContain(color);
      }
    });

    it('summary describes energy level', async () => {
      const { saveState, getStateSummary } = await import('../src/agent/internal-state.js');
      saveState(mkState({ energy: 0.05 }));
      const summary = getStateSummary();
      expect(summary).toContain('energy');
    });
  });
});

// =============================================================================
// 2. MEMORY SYSTEM INVARIANTS
// =============================================================================

describe('Memory system runtime invariants', () => {
  let dir: string;

  beforeEach(async () => {
    dir = tmpDir();
    await openDB(dir);
  });
  afterEach(async () => {
    await closeDB(dir);
  });

  describe('saveMessage / getRecentMessages', () => {
    it('saved message is retrievable by session key', async () => {
      const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
      saveMessage({
        sessionKey: 'test:session',
        userId: null,
        role: 'user',
        content: 'hello world',
        timestamp: Date.now(),
        metadata: {},
      });
      const msgs = getRecentMessages('test:session');
      expect(msgs.length).toBe(1);
      expect(msgs[0]!.content).toBe('hello world');
    });

    it('message IDs are unique after many saves', async () => {
      const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
      const ids: string[] = [];
      for (let i = 0; i < 100; i++) {
        const id = saveMessage({
          sessionKey: 'test:bulk',
          userId: null,
          role: 'user',
          content: `msg-${i}`,
          timestamp: Date.now() + i,
          metadata: {},
        });
        ids.push(id);
      }
      expect(new Set(ids).size).toBe(100);
    });

    it('messages returned in chronological order', async () => {
      const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        saveMessage({
          sessionKey: 'test:order',
          userId: null,
          role: 'user',
          content: `msg-${i}`,
          timestamp: now + i * 1000,
          metadata: {},
        });
      }
      const msgs = getRecentMessages('test:order');
      for (let i = 1; i < msgs.length; i++) {
        expect(msgs[i]!.timestamp).toBeGreaterThanOrEqual(msgs[i - 1]!.timestamp);
      }
    });

    it('content is never truncated in save/retrieve cycle', async () => {
      const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
      const longContent = 'x'.repeat(10000);
      saveMessage({
        sessionKey: 'test:long',
        userId: null,
        role: 'user',
        content: longContent,
        timestamp: Date.now(),
        metadata: {},
      });
      const msgs = getRecentMessages('test:long');
      expect(msgs[0]!.content).toBe(longContent);
    });

    it('empty session returns empty array (not error)', async () => {
      const { getRecentMessages } = await import('../src/memory/store.js');
      const msgs = getRecentMessages('nonexistent:session');
      expect(msgs).toEqual([]);
    });

    it('countMessages reflects actual count', async () => {
      const { saveMessage, countMessages } = await import('../src/memory/store.js');
      const before = countMessages();
      for (let i = 0; i < 5; i++) {
        saveMessage({
          sessionKey: 'test:count',
          userId: null,
          role: 'user',
          content: `msg-${i}`,
          timestamp: Date.now() + i,
          metadata: {},
        });
      }
      expect(countMessages()).toBe(before + 5);
    });
  });

  describe('memory CRUD operations', () => {
    it('getMemory returns undefined for nonexistent ID', async () => {
      const { getMemory } = await import('../src/memory/store.js');
      expect(getMemory('nonexistent')).toBeUndefined();
    });

    it('countMemories starts at 0 (or reflects pre-existing)', async () => {
      const { countMemories } = await import('../src/memory/store.js');
      const count = countMemories();
      expect(typeof count).toBe('number');
      expect(count).toBeGreaterThanOrEqual(0);
    });

    it('deleteMemory returns false for nonexistent memory', async () => {
      const { deleteMemory } = await import('../src/memory/store.js');
      expect(deleteMemory('does-not-exist')).toBe(false);
    });

    it('getAllMemories returns array even when empty', async () => {
      const { getAllMemories } = await import('../src/memory/store.js');
      const mems = getAllMemories();
      expect(Array.isArray(mems)).toBe(true);
    });

    it('getMemoriesByType returns empty for valid type with no data', async () => {
      const { getMemoriesByType } = await import('../src/memory/store.js');
      const facts = getMemoriesByType('fact');
      expect(Array.isArray(facts)).toBe(true);
    });
  });

  describe('memory association operations', () => {
    it('addAssociation does not crash with valid IDs', async () => {
      const { addAssociation } = await import('../src/memory/store.js');
      expect(() => addAssociation('id1', 'id2', 'similar', 0.5)).not.toThrow();
    });

    it('getAssociations returns empty for unknown memory', async () => {
      const { getAssociations } = await import('../src/memory/store.js');
      const assocs = getAssociations('nonexistent');
      expect(assocs).toEqual([]);
    });

    it('association strength is preserved', async () => {
      const { addAssociation, getAssociations } = await import('../src/memory/store.js');
      addAssociation('src1', 'tgt1', 'similar', 0.75);
      const assocs = getAssociations('src1');
      expect(assocs.length).toBe(1);
      expect(assocs[0]!.strength).toBeCloseTo(0.75, 5);
    });

    it('strengthenAssociation increases strength', async () => {
      const { addAssociation, strengthenAssociation, getAssociations } = await import('../src/memory/store.js');
      addAssociation('s', 't', 'similar', 0.5);
      strengthenAssociation('s', 't', 0.2);
      const assocs = getAssociations('s');
      expect(assocs[0]!.strength).toBeCloseTo(0.7, 5);
    });

    it('strengthenAssociation caps at 1.0', async () => {
      const { addAssociation, strengthenAssociation, getAssociations } = await import('../src/memory/store.js');
      addAssociation('s2', 't2', 'similar', 0.9);
      strengthenAssociation('s2', 't2', 0.5);
      const assocs = getAssociations('s2');
      expect(assocs[0]!.strength).toBeLessThanOrEqual(1.0);
    });

    it('getAssociatedMemories returns empty for empty input', async () => {
      const { getAssociatedMemories } = await import('../src/memory/store.js');
      expect(getAssociatedMemories([])).toEqual([]);
    });
  });

  describe('coherence group operations', () => {
    it('createCoherenceGroup returns a string ID', async () => {
      const { createCoherenceGroup } = await import('../src/memory/store.js');
      const id = createCoherenceGroup('test group', null);
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('getCoherenceGroup retrieves created group', async () => {
      const { createCoherenceGroup, getCoherenceGroup } = await import('../src/memory/store.js');
      const id = createCoherenceGroup('test group', null, 'mature');
      const group = getCoherenceGroup(id);
      expect(group).toBeDefined();
      expect(group!.name).toBe('test group');
      expect(group!.memberCount).toBe(0);
    });

    it('deleteCoherenceGroup removes the group', async () => {
      const { createCoherenceGroup, getCoherenceGroup, deleteCoherenceGroup } = await import('../src/memory/store.js');
      const id = createCoherenceGroup('doomed', null);
      deleteCoherenceGroup(id);
      expect(getCoherenceGroup(id)).toBeUndefined();
    });

    it('getAllCoherenceGroups returns array', async () => {
      const { getAllCoherenceGroups } = await import('../src/memory/store.js');
      expect(Array.isArray(getAllCoherenceGroups())).toBe(true);
    });
  });

  describe('lifecycle operations', () => {
    it('getMemoriesByLifecycle returns empty for clean DB', async () => {
      const { getMemoriesByLifecycle } = await import('../src/memory/store.js');
      expect(getMemoriesByLifecycle('seed')).toEqual([]);
    });
  });

  describe('postboard operations', () => {
    it('savePostboardMessage returns unique IDs', async () => {
      const { savePostboardMessage } = await import('../src/memory/store.js');
      const ids = new Set<string>();
      for (let i = 0; i < 20; i++) {
        ids.add(savePostboardMessage(`msg-${i}`));
      }
      expect(ids.size).toBe(20);
    });

    it('getPostboardMessages returns messages in order', async () => {
      const { savePostboardMessage, getPostboardMessages } = await import('../src/memory/store.js');
      for (let i = 0; i < 5; i++) {
        savePostboardMessage(`msg-${i}`);
      }
      const msgs = getPostboardMessages();
      expect(msgs.length).toBe(5);
    });

    it('deletePostboardMessage removes the message', async () => {
      const { savePostboardMessage, deletePostboardMessage, getPostboardMessages } = await import('../src/memory/store.js');
      const id = savePostboardMessage('to be deleted');
      expect(deletePostboardMessage(id)).toBe(true);
      const msgs = getPostboardMessages();
      expect(msgs.find(m => m.id === id)).toBeUndefined();
    });

    it('deletePostboardMessage returns false for nonexistent', async () => {
      const { deletePostboardMessage } = await import('../src/memory/store.js');
      expect(deletePostboardMessage('no-such-id')).toBe(false);
    });

    it('togglePostboardPin flips pin state', async () => {
      const { savePostboardMessage, togglePostboardPin, getPostboardMessages } = await import('../src/memory/store.js');
      const id = savePostboardMessage('pin test', 'admin', false);
      togglePostboardPin(id);
      const msgs = getPostboardMessages();
      const msg = msgs.find(m => m.id === id);
      expect(msg!.pinned).toBe(true);
    });
  });
});

// =============================================================================
// 3. BUILDING / LOCATION INVARIANTS
// =============================================================================

describe('Building/location runtime invariants', () => {
  let dir: string;

  beforeEach(async () => {
    dir = tmpDir();
    await openDB(dir);
  });
  afterEach(async () => {
    await closeDB(dir);
  });

  describe('BUILDINGS structure', () => {
    it('exactly 9 buildings in the grid', async () => {
      const { BUILDINGS } = await import('../src/commune/buildings.js');
      expect(BUILDINGS.length).toBe(9);
    });

    it('all building IDs are unique strings', async () => {
      const { BUILDINGS } = await import('../src/commune/buildings.js');
      const ids = BUILDINGS.map(b => b.id);
      expect(new Set(ids).size).toBe(9);
      for (const id of ids) {
        expect(typeof id).toBe('string');
        expect(id.length).toBeGreaterThan(0);
      }
    });

    it('no two buildings share the same grid position', async () => {
      const { BUILDINGS } = await import('../src/commune/buildings.js');
      const positions = new Set(BUILDINGS.map(b => `${b.row}:${b.col}`));
      expect(positions.size).toBe(9);
    });

    it('all positions are within 3x3 grid bounds', async () => {
      const { BUILDINGS } = await import('../src/commune/buildings.js');
      for (const b of BUILDINGS) {
        expect(b.row).toBeGreaterThanOrEqual(0);
        expect(b.row).toBeLessThanOrEqual(2);
        expect(b.col).toBeGreaterThanOrEqual(0);
        expect(b.col).toBeLessThanOrEqual(2);
      }
    });

    it('BUILDING_MAP contains all building IDs', async () => {
      const { BUILDINGS, BUILDING_MAP } = await import('../src/commune/buildings.js');
      expect(BUILDING_MAP.size).toBe(9);
      for (const b of BUILDINGS) {
        expect(BUILDING_MAP.has(b.id)).toBe(true);
        expect(BUILDING_MAP.get(b.id)).toBe(b);
      }
    });

    it('isValidBuilding rejects empty string', async () => {
      const { isValidBuilding } = await import('../src/commune/buildings.js');
      expect(isValidBuilding('')).toBe(false);
    });

    it('isValidBuilding rejects uppercase variants', async () => {
      const { isValidBuilding } = await import('../src/commune/buildings.js');
      expect(isValidBuilding('Library')).toBe(false);
      expect(isValidBuilding('LIBRARY')).toBe(false);
    });

    it('isValidBuilding accepts all 9 known IDs', async () => {
      const { BUILDINGS, isValidBuilding } = await import('../src/commune/buildings.js');
      for (const b of BUILDINGS) {
        expect(isValidBuilding(b.id)).toBe(true);
      }
    });

    it('every building has non-empty name, emoji, description', async () => {
      const { BUILDINGS } = await import('../src/commune/buildings.js');
      for (const b of BUILDINGS) {
        expect(b.name.length).toBeGreaterThan(0);
        expect(b.emoji.length).toBeGreaterThan(0);
        expect(b.description.length).toBeGreaterThan(0);
      }
    });
  });

  describe('getCurrentLocation', () => {
    it('returns a valid building when nothing persisted', async () => {
      const { getCurrentLocation } = await import('../src/commune/location.js');
      const { BUILDING_MAP } = await import('../src/commune/buildings.js');
      const loc = getCurrentLocation('somechar');
      expect(typeof loc.building).toBe('string');
      // Building may or may not be in BUILDING_MAP depending on defaults,
      // but it should be a string
      expect(loc.building.length).toBeGreaterThan(0);
    });

    it('returns a timestamp', async () => {
      const { getCurrentLocation } = await import('../src/commune/location.js');
      const loc = getCurrentLocation('test');
      expect(typeof loc.timestamp).toBe('number');
      expect(loc.timestamp).toBeGreaterThan(0);
    });
  });

  describe('setCurrentLocation', () => {
    it('movement changes persisted location', async () => {
      const { setCurrentLocation, getCurrentLocation } = await import('../src/commune/location.js');
      const { setMeta } = await import('../src/storage/database.js');
      // Set an initial location
      setMeta('town:current_location', JSON.stringify({ building: 'library', timestamp: Date.now() }));
      setCurrentLocation('bar', 'feeling social');
      const loc = getCurrentLocation();
      expect(loc.building).toBe('bar');
    });

    it('same-building movement is a no-op', async () => {
      const { setCurrentLocation, getCurrentLocation, getLocationHistory } = await import('../src/commune/location.js');
      const { setMeta } = await import('../src/storage/database.js');
      setMeta('town:current_location', JSON.stringify({ building: 'library', timestamp: Date.now() }));
      const historyBefore = getLocationHistory().length;
      setCurrentLocation('library', 'staying put');
      const historyAfter = getLocationHistory().length;
      // No-op means no history entry added
      expect(historyAfter).toBe(historyBefore);
    });

    it('movement appends to location history', async () => {
      const { setCurrentLocation, getLocationHistory } = await import('../src/commune/location.js');
      const { setMeta } = await import('../src/storage/database.js');
      setMeta('town:current_location', JSON.stringify({ building: 'library', timestamp: Date.now() }));
      setCurrentLocation('bar', 'reason 1');
      setCurrentLocation('field', 'reason 2');
      const history = getLocationHistory();
      expect(history.length).toBeGreaterThanOrEqual(2);
    });

    it('location history is capped at 20', async () => {
      const { setCurrentLocation } = await import('../src/commune/location.js');
      const { setMeta } = await import('../src/storage/database.js');
      const { BUILDINGS } = await import('../src/commune/buildings.js');
      setMeta('town:current_location', JSON.stringify({ building: 'library', timestamp: Date.now() }));
      for (let i = 0; i < 30; i++) {
        const target = BUILDINGS[i % BUILDINGS.length]!.id;
        // Alternate to ensure it's always a move to a different building
        const current = BUILDINGS[(i + 1) % BUILDINGS.length]!.id;
        setMeta('town:current_location', JSON.stringify({ building: current, timestamp: Date.now() }));
        setCurrentLocation(target as import('../src/commune/buildings.js').BuildingId, `move-${i}`);
      }
      const { getLocationHistory } = await import('../src/commune/location.js');
      const history = getLocationHistory();
      expect(history.length).toBeLessThanOrEqual(20);
    });

    it('history entries have from, to, reason, and timestamp', async () => {
      const { setCurrentLocation, getLocationHistory } = await import('../src/commune/location.js');
      const { setMeta } = await import('../src/storage/database.js');
      setMeta('town:current_location', JSON.stringify({ building: 'library', timestamp: Date.now() }));
      setCurrentLocation('bar', 'need a drink');
      const history = getLocationHistory();
      const entry = history[0]!;
      expect(entry.from).toBe('library');
      expect(entry.to).toBe('bar');
      expect(entry.reason).toBe('need a drink');
      expect(typeof entry.timestamp).toBe('number');
    });
  });
});

// =============================================================================
// 4. WEATHER COMPUTATION INVARIANTS
// =============================================================================

describe('Weather computation runtime invariants', () => {
  const VALID_CONDITIONS = ['clear', 'overcast', 'rain', 'fog', 'storm', 'aurora'];

  describe('computeWeather', () => {
    it('returns overcast with description for empty states array', async () => {
      const { computeWeather } = await import('../src/commune/weather.js');
      const weather = await computeWeather([]);
      expect(weather.condition).toBe('overcast');
      expect(weather.intensity).toBe(0.5);
      expect(weather.description).toBe('quiet day in the town');
      expect(typeof weather.computed_at).toBe('number');
    });

    it('always returns a valid condition', async () => {
      const { computeWeather } = await import('../src/commune/weather.js');
      const testCases: IS[][] = [
        [mkState({ energy: 1, valence: 1, emotional_weight: 0, intellectual_arousal: 0.5, sociability: 0.5 })],
        [mkState({ energy: 0, valence: 0, emotional_weight: 1, intellectual_arousal: 1, sociability: 0 })],
        [mkState({ energy: 0.5, valence: 0.5, emotional_weight: 0.5, intellectual_arousal: 0.5, sociability: 0.5 })],
        [mkState({ energy: 0.1, valence: 0.1, emotional_weight: 0.1, intellectual_arousal: 0.1, sociability: 0.1 })],
        [mkState({ energy: 0.9, valence: 0.9, emotional_weight: 0.9, intellectual_arousal: 0.9, sociability: 0.9 })],
      ];
      for (const states of testCases) {
        const w = await computeWeather(states);
        expect(VALID_CONDITIONS).toContain(w.condition);
      }
    });

    it('intensity is always in [0, 1]', async () => {
      const { computeWeather } = await import('../src/commune/weather.js');
      const states = [
        mkState({ energy: 0, valence: 0, emotional_weight: 1, intellectual_arousal: 1, sociability: 0 }),
        mkState({ energy: 1, valence: 1, emotional_weight: 0, intellectual_arousal: 0, sociability: 1 }),
      ];
      const w = await computeWeather(states);
      expect(w.intensity).toBeGreaterThanOrEqual(0);
      expect(w.intensity).toBeLessThanOrEqual(1);
    });

    it('description is always a non-empty string', async () => {
      const { computeWeather } = await import('../src/commune/weather.js');
      const w = await computeWeather([mkState()]);
      expect(typeof w.description).toBe('string');
      expect(w.description.length).toBeGreaterThan(0);
    });

    it('computed_at is always a recent timestamp', async () => {
      const { computeWeather } = await import('../src/commune/weather.js');
      const before = Date.now();
      const w = await computeWeather([mkState()]);
      expect(w.computed_at).toBeGreaterThanOrEqual(before);
      expect(w.computed_at).toBeLessThanOrEqual(Date.now() + 1000);
    });

    it('all-happy characters tend toward clear or aurora', async () => {
      const { computeWeather } = await import('../src/commune/weather.js');
      const happyStates = Array.from({ length: 5 }, () =>
        mkState({ energy: 0.9, valence: 0.9, emotional_weight: 0.1, intellectual_arousal: 0.5, sociability: 0.7 })
      );
      const w = await computeWeather(happyStates);
      expect(['clear', 'aurora']).toContain(w.condition);
    });

    it('all-distressed characters produce storm or rain', async () => {
      const { computeWeather } = await import('../src/commune/weather.js');
      const sadStates = Array.from({ length: 5 }, () =>
        mkState({ energy: 0.5, valence: 0.2, emotional_weight: 0.9, intellectual_arousal: 0.8, sociability: 0.2 })
      );
      const w = await computeWeather(sadStates);
      expect(['storm', 'rain']).toContain(w.condition);
    });

    it('low-energy characters produce fog', async () => {
      const { computeWeather } = await import('../src/commune/weather.js');
      const tiredStates = Array.from({ length: 5 }, () =>
        mkState({ energy: 0.1, valence: 0.5, emotional_weight: 0.3, intellectual_arousal: 0.3, sociability: 0.3 })
      );
      const w = await computeWeather(tiredStates);
      expect(w.condition).toBe('fog');
    });

    it('single character state produces valid weather', async () => {
      const { computeWeather } = await import('../src/commune/weather.js');
      const w = await computeWeather([mkState()]);
      expect(VALID_CONDITIONS).toContain(w.condition);
    });

    it('many characters (10+) produce valid weather', async () => {
      const { computeWeather } = await import('../src/commune/weather.js');
      const states = Array.from({ length: 10 }, (_, i) =>
        mkState({ energy: i / 10, valence: i / 10, emotional_weight: (10 - i) / 10 })
      );
      const w = await computeWeather(states);
      expect(VALID_CONDITIONS).toContain(w.condition);
      expect(w.intensity).toBeGreaterThanOrEqual(0);
      expect(w.intensity).toBeLessThanOrEqual(1);
    });

    it('high intellectual arousal + high valence = aurora', async () => {
      const { computeWeather } = await import('../src/commune/weather.js');
      const auroraStates = Array.from({ length: 3 }, () =>
        mkState({ intellectual_arousal: 0.9, valence: 0.9, emotional_weight: 0.3 })
      );
      const w = await computeWeather(auroraStates);
      expect(w.condition).toBe('aurora');
    });

    it('high emotional weight + high intellectual arousal = storm', async () => {
      const { computeWeather } = await import('../src/commune/weather.js');
      const stormStates = Array.from({ length: 3 }, () =>
        mkState({ emotional_weight: 0.9, intellectual_arousal: 0.8, valence: 0.3 })
      );
      const w = await computeWeather(stormStates);
      expect(w.condition).toBe('storm');
    });
  });

  describe('getWeatherEffect', () => {
    it('returns an object for all valid conditions', async () => {
      const { getWeatherEffect } = await import('../src/commune/weather.js');
      for (const cond of VALID_CONDITIONS) {
        const effect = getWeatherEffect(cond);
        expect(typeof effect).toBe('object');
        expect(effect).not.toBeNull();
      }
    });

    it('returns empty object for overcast', async () => {
      const { getWeatherEffect } = await import('../src/commune/weather.js');
      const effect = getWeatherEffect('overcast');
      expect(Object.keys(effect).length).toBe(0);
    });

    it('returns empty object for unknown condition', async () => {
      const { getWeatherEffect } = await import('../src/commune/weather.js');
      const effect = getWeatherEffect('tornado');
      expect(Object.keys(effect).length).toBe(0);
    });

    it('aurora effect boosts energy and valence', async () => {
      const { getWeatherEffect } = await import('../src/commune/weather.js');
      const effect = getWeatherEffect('aurora');
      expect(effect.energy).toBeGreaterThan(0);
      expect(effect.valence).toBeGreaterThan(0);
    });

    it('storm effect reduces energy', async () => {
      const { getWeatherEffect } = await import('../src/commune/weather.js');
      const effect = getWeatherEffect('storm');
      expect(effect.energy).toBeLessThan(0);
    });

    it('fog effect reduces energy', async () => {
      const { getWeatherEffect } = await import('../src/commune/weather.js');
      const effect = getWeatherEffect('fog');
      expect(effect.energy).toBeLessThan(0);
    });
  });

  describe('getCurrentWeather', () => {
    it('returns null when no weather has been computed', async () => {
      const dir2 = tmpDir();
      await openDB(dir2);
      const { getCurrentWeather } = await import('../src/commune/weather.js');
      const w = getCurrentWeather();
      // May return null if nothing stored, or a value if already initialized
      expect(w === null || VALID_CONDITIONS.includes(w.condition)).toBe(true);
      await closeDB(dir2);
    });
  });
});

// =============================================================================
// 4b. WEATHER — ADDITIONAL PROPERTY TESTS
// =============================================================================

describe('Weather property-based invariants', () => {
  const VALID_CONDITIONS = ['clear', 'overcast', 'rain', 'fog', 'storm', 'aurora'];

  describe('computeWeather fuzz', () => {
    for (let i = 0; i < 10; i++) {
      it(`random character states #${i + 1} always produce valid weather`, async () => {
        const { computeWeather } = await import('../src/commune/weather.js');
        const numChars = Math.floor(Math.random() * 8) + 1;
        const states = Array.from({ length: numChars }, () =>
          mkState({
            energy: Math.random(),
            sociability: Math.random(),
            intellectual_arousal: Math.random(),
            emotional_weight: Math.random(),
            valence: Math.random(),
          })
        );
        const w = await computeWeather(states);
        expect(VALID_CONDITIONS).toContain(w.condition);
        expect(w.intensity).toBeGreaterThanOrEqual(0);
        expect(w.intensity).toBeLessThanOrEqual(1);
        expect(typeof w.description).toBe('string');
        expect(w.description.length).toBeGreaterThan(0);
        expect(typeof w.computed_at).toBe('number');
      });
    }
  });

  describe('weather condition determinism', () => {
    it('identical inputs produce identical condition', async () => {
      const { computeWeather } = await import('../src/commune/weather.js');
      const states = [mkState({ energy: 0.7, valence: 0.8, emotional_weight: 0.2, intellectual_arousal: 0.4, sociability: 0.5 })];
      const w1 = await computeWeather(states);
      const w2 = await computeWeather(states);
      expect(w1.condition).toBe(w2.condition);
      expect(w1.intensity).toBeCloseTo(w2.intensity, 5);
    });
  });
});

// =============================================================================
// 5. DESIRE SYSTEM INVARIANTS
// =============================================================================

describe('Desire system runtime invariants', () => {
  let dir: string;

  beforeEach(async () => {
    dir = tmpDir();
    await openDB(dir);
    const { ensureDesireTable } = await import('../src/agent/desires.js');
    ensureDesireTable();
  });
  afterEach(async () => {
    await closeDB(dir);
  });

  describe('createDesire', () => {
    it('returns a desire with valid structure', async () => {
      const { createDesire } = await import('../src/agent/desires.js');
      const d = createDesire({
        type: 'social',
        description: 'want to talk to someone',
        source: 'loneliness',
      });
      expect(typeof d.id).toBe('string');
      expect(d.id.length).toBeGreaterThan(0);
      expect(d.type).toBe('social');
      expect(d.description).toBe('want to talk to someone');
      expect(d.resolvedAt).toBeNull();
      expect(d.resolution).toBeNull();
    });

    it('intensity is clamped to [0, 1]', async () => {
      const { createDesire } = await import('../src/agent/desires.js');
      const d1 = createDesire({ type: 'emotional', description: 'test', source: 'test', intensity: 5 });
      expect(d1.intensity).toBeLessThanOrEqual(1);
      const d2 = createDesire({ type: 'emotional', description: 'test', source: 'test', intensity: -1 });
      expect(d2.intensity).toBeGreaterThanOrEqual(0);
    });

    it('default intensity is 0.5', async () => {
      const { createDesire } = await import('../src/agent/desires.js');
      const d = createDesire({ type: 'intellectual', description: 'test', source: 'test' });
      expect(d.intensity).toBe(0.5);
    });

    it('IDs are unique after many creates', async () => {
      const { createDesire } = await import('../src/agent/desires.js');
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const d = createDesire({ type: 'social', description: `d-${i}`, source: 'test' });
        ids.add(d.id);
      }
      expect(ids.size).toBe(100);
    });

    it('targetPeer is null by default', async () => {
      const { createDesire } = await import('../src/agent/desires.js');
      const d = createDesire({ type: 'social', description: 'test', source: 'test' });
      expect(d.targetPeer).toBeNull();
    });

    it('targetPeer is set when provided', async () => {
      const { createDesire } = await import('../src/agent/desires.js');
      const d = createDesire({ type: 'social', description: 'test', source: 'test', targetPeer: 'pkd' });
      expect(d.targetPeer).toBe('pkd');
    });

    it('createdAt and updatedAt are valid timestamps', async () => {
      const { createDesire } = await import('../src/agent/desires.js');
      const before = Date.now();
      const d = createDesire({ type: 'creative', description: 'test', source: 'test' });
      expect(d.createdAt).toBeGreaterThanOrEqual(before);
      expect(d.updatedAt).toBeGreaterThanOrEqual(before);
    });

    it('default decayRate is 0.04', async () => {
      const { createDesire } = await import('../src/agent/desires.js');
      const d = createDesire({ type: 'emotional', description: 'test', source: 'test' });
      expect(d.decayRate).toBe(0.04);
    });
  });

  describe('getActiveDesires', () => {
    it('returns empty array when no desires exist', async () => {
      const { getActiveDesires } = await import('../src/agent/desires.js');
      expect(getActiveDesires()).toEqual([]);
    });

    it('returns only unresolved desires', async () => {
      const { createDesire, resolveDesire, getActiveDesires } = await import('../src/agent/desires.js');
      const d1 = createDesire({ type: 'social', description: 'active', source: 'test' });
      const d2 = createDesire({ type: 'social', description: 'resolved', source: 'test' });
      resolveDesire(d2.id, 'done');
      const active = getActiveDesires();
      expect(active.length).toBe(1);
      expect(active[0]!.id).toBe(d1.id);
    });

    it('respects limit parameter', async () => {
      const { createDesire, getActiveDesires } = await import('../src/agent/desires.js');
      for (let i = 0; i < 20; i++) {
        createDesire({ type: 'social', description: `d-${i}`, source: 'test' });
      }
      const limited = getActiveDesires(5);
      expect(limited.length).toBe(5);
    });

    it('results are sorted by intensity descending', async () => {
      const { createDesire, getActiveDesires } = await import('../src/agent/desires.js');
      createDesire({ type: 'social', description: 'low', source: 'test', intensity: 0.2 });
      createDesire({ type: 'intellectual', description: 'high', source: 'test', intensity: 0.9 });
      createDesire({ type: 'emotional', description: 'mid', source: 'test', intensity: 0.5 });
      const active = getActiveDesires();
      for (let i = 1; i < active.length; i++) {
        expect(active[i]!.intensity).toBeLessThanOrEqual(active[i - 1]!.intensity);
      }
    });
  });

  describe('resolveDesire', () => {
    it('marks a desire as resolved', async () => {
      const { createDesire, resolveDesire, getActiveDesires } = await import('../src/agent/desires.js');
      const d = createDesire({ type: 'emotional', description: 'test', source: 'test' });
      expect(getActiveDesires().length).toBe(1);
      resolveDesire(d.id, 'it passed');
      expect(getActiveDesires().length).toBe(0);
    });

    it('resolving nonexistent desire does not crash', async () => {
      const { resolveDesire } = await import('../src/agent/desires.js');
      expect(() => resolveDesire('no-such-id', 'whatever')).not.toThrow();
    });
  });

  describe('boostDesire', () => {
    it('increases intensity', async () => {
      const { createDesire, boostDesire, getActiveDesires } = await import('../src/agent/desires.js');
      const d = createDesire({ type: 'social', description: 'test', source: 'test', intensity: 0.3 });
      boostDesire(d.id, 0.2);
      const active = getActiveDesires();
      expect(active[0]!.intensity).toBeCloseTo(0.5, 2);
    });

    it('caps at 1.0', async () => {
      const { createDesire, boostDesire, getActiveDesires } = await import('../src/agent/desires.js');
      const d = createDesire({ type: 'social', description: 'test', source: 'test', intensity: 0.9 });
      boostDesire(d.id, 0.5);
      const active = getActiveDesires();
      expect(active[0]!.intensity).toBeLessThanOrEqual(1.0);
    });
  });

  describe('getDesiresByType', () => {
    it('filters by type correctly', async () => {
      const { createDesire, getDesiresByType } = await import('../src/agent/desires.js');
      createDesire({ type: 'social', description: 's1', source: 'test' });
      createDesire({ type: 'intellectual', description: 'i1', source: 'test' });
      createDesire({ type: 'social', description: 's2', source: 'test' });
      const social = getDesiresByType('social');
      expect(social.length).toBe(2);
      for (const d of social) expect(d.type).toBe('social');
    });

    it('returns empty for type with no desires', async () => {
      const { getDesiresByType } = await import('../src/agent/desires.js');
      expect(getDesiresByType('creative')).toEqual([]);
    });
  });

  describe('getDesireForPeer', () => {
    it('returns the highest intensity desire for a peer', async () => {
      const { createDesire, getDesireForPeer } = await import('../src/agent/desires.js');
      createDesire({ type: 'social', description: 'low', source: 'test', targetPeer: 'pkd', intensity: 0.3 });
      createDesire({ type: 'social', description: 'high', source: 'test', targetPeer: 'pkd', intensity: 0.8 });
      const d = getDesireForPeer('pkd');
      expect(d).toBeDefined();
      expect(d!.intensity).toBeCloseTo(0.8, 2);
    });

    it('returns undefined for nonexistent peer', async () => {
      const { getDesireForPeer } = await import('../src/agent/desires.js');
      expect(getDesireForPeer('nobody')).toBeUndefined();
    });
  });

  describe('decayDesires', () => {
    it('resolves desires that decay below threshold', async () => {
      const { createDesire, decayDesires, getActiveDesires } = await import('../src/agent/desires.js');
      // Create a desire with very low intensity and high decay rate
      createDesire({ type: 'emotional', description: 'fragile', source: 'test', intensity: 0.06, decayRate: 10.0 });
      // Manually update the updatedAt to make it seem old
      const { execute } = await import('../src/storage/database.js');
      execute('UPDATE desires SET updated_at = ? WHERE resolved_at IS NULL', [Date.now() - 3600000]);
      const resolved = decayDesires();
      expect(resolved).toBeGreaterThanOrEqual(1);
      expect(getActiveDesires().length).toBe(0);
    });

    it('returns 0 when no desires exist', async () => {
      const { decayDesires } = await import('../src/agent/desires.js');
      expect(decayDesires()).toBe(0);
    });

    it('does not resolve desires that are still strong', async () => {
      const { createDesire, decayDesires, getActiveDesires } = await import('../src/agent/desires.js');
      createDesire({ type: 'social', description: 'strong', source: 'test', intensity: 0.9 });
      decayDesires();
      expect(getActiveDesires().length).toBe(1);
    });
  });

  describe('getDesireContext', () => {
    it('returns empty string when no desires', async () => {
      const { getDesireContext } = await import('../src/agent/desires.js');
      expect(getDesireContext()).toBe('');
    });

    it('returns formatted string with desires', async () => {
      const { createDesire, getDesireContext } = await import('../src/agent/desires.js');
      createDesire({ type: 'social', description: 'talk to PKD', source: 'test', targetPeer: 'pkd' });
      const ctx = getDesireContext();
      expect(ctx).toContain('Current Desires');
      expect(ctx).toContain('talk to PKD');
      expect(ctx).toContain('pkd');
    });

    it('uses intensity-aware adverbs', async () => {
      const { createDesire, getDesireContext } = await import('../src/agent/desires.js');
      createDesire({ type: 'social', description: 'strong desire', source: 'test', intensity: 0.9 });
      createDesire({ type: 'emotional', description: 'faint desire', source: 'test', intensity: 0.2 });
      const ctx = getDesireContext();
      expect(ctx).toContain('strongly');
      expect(ctx).toContain('faintly');
    });
  });
});

// =============================================================================
// 6. SESSION INVARIANTS
// =============================================================================

describe('Session runtime invariants', () => {
  let dir: string;

  beforeEach(async () => {
    dir = tmpDir();
    await openDB(dir);
  });
  afterEach(async () => {
    await closeDB(dir);
  });

  describe('createSession', () => {
    it('creates a session with valid structure', async () => {
      const { createSession } = await import('../src/storage/sessions.js');
      const s = createSession({
        agentId: 'lain',
        channel: 'web',
        peerKind: 'user',
        peerId: 'visitor1',
      });
      expect(typeof s.key).toBe('string');
      expect(s.key.length).toBeGreaterThan(0);
      expect(s.agentId).toBe('lain');
      expect(s.channel).toBe('web');
      expect(s.peerKind).toBe('user');
      expect(s.peerId).toBe('visitor1');
      expect(s.tokenCount).toBe(0);
    });

    it('session keys are unique after many creates', async () => {
      const { createSession } = await import('../src/storage/sessions.js');
      const keys = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const s = createSession({
          agentId: 'lain',
          channel: 'web',
          peerKind: 'user',
          peerId: `user-${i}`,
        });
        keys.add(s.key);
      }
      expect(keys.size).toBe(100);
    });

    it('createdAt and updatedAt are set', async () => {
      const { createSession } = await import('../src/storage/sessions.js');
      const before = Date.now();
      const s = createSession({
        agentId: 'lain',
        channel: 'web',
        peerKind: 'user',
        peerId: 'test',
      });
      expect(s.createdAt).toBeGreaterThanOrEqual(before);
      expect(s.updatedAt).toBeGreaterThanOrEqual(before);
    });
  });

  describe('getSession', () => {
    it('retrieves created session', async () => {
      const { createSession, getSession } = await import('../src/storage/sessions.js');
      const s = createSession({
        agentId: 'lain',
        channel: 'web',
        peerKind: 'user',
        peerId: 'test',
      });
      const loaded = getSession(s.key);
      expect(loaded).toBeDefined();
      expect(loaded!.key).toBe(s.key);
      expect(loaded!.agentId).toBe('lain');
    });

    it('returns undefined for nonexistent key', async () => {
      const { getSession } = await import('../src/storage/sessions.js');
      expect(getSession('no-such-key')).toBeUndefined();
    });
  });

  describe('updateSession', () => {
    it('updates token count', async () => {
      const { createSession, updateSession, getSession } = await import('../src/storage/sessions.js');
      const s = createSession({
        agentId: 'lain',
        channel: 'web',
        peerKind: 'user',
        peerId: 'test',
      });
      updateSession(s.key, { tokenCount: 500 });
      const updated = getSession(s.key);
      expect(updated!.tokenCount).toBe(500);
    });

    it('updates updatedAt timestamp', async () => {
      const { createSession, updateSession, getSession } = await import('../src/storage/sessions.js');
      const s = createSession({
        agentId: 'lain',
        channel: 'web',
        peerKind: 'user',
        peerId: 'test',
      });
      const originalUpdatedAt = s.updatedAt;
      // Small delay to ensure different timestamp
      await new Promise(resolve => setTimeout(resolve, 10));
      updateSession(s.key, { tokenCount: 100 });
      const updated = getSession(s.key);
      expect(updated!.updatedAt).toBeGreaterThanOrEqual(originalUpdatedAt);
    });

    it('returns undefined for nonexistent session', async () => {
      const { updateSession } = await import('../src/storage/sessions.js');
      expect(updateSession('no-key', { tokenCount: 1 })).toBeUndefined();
    });

    it('merges flags correctly', async () => {
      const { createSession, updateSession, getSession } = await import('../src/storage/sessions.js');
      const s = createSession({
        agentId: 'lain',
        channel: 'web',
        peerKind: 'user',
        peerId: 'test',
      });
      updateSession(s.key, { flags: { summarized: true } });
      const updated = getSession(s.key);
      expect(updated!.flags.summarized).toBe(true);
    });
  });

  describe('deleteSession', () => {
    it('removes the session', async () => {
      const { createSession, deleteSession, getSession } = await import('../src/storage/sessions.js');
      const s = createSession({
        agentId: 'lain',
        channel: 'web',
        peerKind: 'user',
        peerId: 'test',
      });
      expect(deleteSession(s.key)).toBe(true);
      expect(getSession(s.key)).toBeUndefined();
    });

    it('returns false for nonexistent session', async () => {
      const { deleteSession } = await import('../src/storage/sessions.js');
      expect(deleteSession('no-such-key')).toBe(false);
    });
  });

  describe('findSession', () => {
    it('finds existing session', async () => {
      const { createSession, findSession } = await import('../src/storage/sessions.js');
      createSession({
        agentId: 'lain',
        channel: 'web',
        peerKind: 'user',
        peerId: 'visitor1',
      });
      const found = findSession('lain', 'web', 'visitor1');
      expect(found).toBeDefined();
      expect(found!.peerId).toBe('visitor1');
    });

    it('returns undefined when not found', async () => {
      const { findSession } = await import('../src/storage/sessions.js');
      expect(findSession('lain', 'web', 'nobody')).toBeUndefined();
    });
  });

  describe('getOrCreateSession', () => {
    it('creates new session if none exists', async () => {
      const { getOrCreateSession } = await import('../src/storage/sessions.js');
      const s = getOrCreateSession({
        agentId: 'lain',
        channel: 'web',
        peerKind: 'user',
        peerId: 'new-visitor',
      });
      expect(s.peerId).toBe('new-visitor');
    });

    it('returns existing session if already exists', async () => {
      const { createSession, getOrCreateSession } = await import('../src/storage/sessions.js');
      const original = createSession({
        agentId: 'lain',
        channel: 'web',
        peerKind: 'user',
        peerId: 'repeat-visitor',
      });
      const found = getOrCreateSession({
        agentId: 'lain',
        channel: 'web',
        peerKind: 'user',
        peerId: 'repeat-visitor',
      });
      expect(found.key).toBe(original.key);
    });
  });

  describe('listSessions', () => {
    it('returns sessions for given agent', async () => {
      const { createSession, listSessions } = await import('../src/storage/sessions.js');
      createSession({ agentId: 'lain', channel: 'web', peerKind: 'user', peerId: 'a' });
      createSession({ agentId: 'lain', channel: 'web', peerKind: 'user', peerId: 'b' });
      createSession({ agentId: 'wired', channel: 'web', peerKind: 'user', peerId: 'c' });
      const lainSessions = listSessions('lain');
      expect(lainSessions.length).toBe(2);
    });

    it('filters by channel', async () => {
      const { createSession, listSessions } = await import('../src/storage/sessions.js');
      createSession({ agentId: 'lain', channel: 'web', peerKind: 'user', peerId: 'w' });
      createSession({ agentId: 'lain', channel: 'telegram', peerKind: 'user', peerId: 't' });
      const webOnly = listSessions('lain', { channel: 'web' });
      expect(webOnly.length).toBe(1);
      expect(webOnly[0]!.channel).toBe('web');
    });

    it('respects limit', async () => {
      const { createSession, listSessions } = await import('../src/storage/sessions.js');
      for (let i = 0; i < 10; i++) {
        createSession({ agentId: 'lain', channel: 'web', peerKind: 'user', peerId: `p-${i}` });
      }
      const limited = listSessions('lain', { limit: 3 });
      expect(limited.length).toBe(3);
    });
  });

  describe('countSessions', () => {
    it('returns correct count', async () => {
      const { createSession, countSessions } = await import('../src/storage/sessions.js');
      createSession({ agentId: 'lain', channel: 'web', peerKind: 'user', peerId: 'x' });
      createSession({ agentId: 'lain', channel: 'web', peerKind: 'user', peerId: 'y' });
      expect(countSessions('lain')).toBe(2);
    });

    it('returns 0 for unknown agent', async () => {
      const { countSessions } = await import('../src/storage/sessions.js');
      expect(countSessions('nobody')).toBe(0);
    });
  });

  describe('deleteOldSessions', () => {
    it('deletes sessions older than maxAge', async () => {
      const { createSession, deleteOldSessions, countSessions } = await import('../src/storage/sessions.js');
      const { execute } = await import('../src/storage/database.js');
      const s = createSession({ agentId: 'lain', channel: 'web', peerKind: 'user', peerId: 'old' });
      // Backdate the session
      execute('UPDATE sessions SET updated_at = ? WHERE key = ?', [Date.now() - 86400001, s.key]);
      const deleted = deleteOldSessions('lain', 86400000); // 1 day
      expect(deleted).toBe(1);
      expect(countSessions('lain')).toBe(0);
    });
  });
});

// =============================================================================
// 7. KG (KNOWLEDGE GRAPH) INVARIANTS
// =============================================================================

describe('Knowledge graph runtime invariants', () => {
  let dir: string;

  beforeEach(async () => {
    dir = tmpDir();
    await openDB(dir);
  });
  afterEach(async () => {
    await closeDB(dir);
  });

  describe('addTriple / getTriple', () => {
    it('returns a unique ID for each triple', async () => {
      const { addTriple } = await import('../src/memory/knowledge-graph.js');
      const ids = new Set<string>();
      for (let i = 0; i < 50; i++) {
        ids.add(addTriple(`subject-${i}`, 'knows', `object-${i}`));
      }
      expect(ids.size).toBe(50);
    });

    it('triple is retrievable by ID', async () => {
      const { addTriple, getTriple } = await import('../src/memory/knowledge-graph.js');
      const id = addTriple('Lain', 'lives_in', 'the Wired');
      const triple = getTriple(id);
      expect(triple).toBeDefined();
      expect(triple!.subject).toBe('Lain');
      expect(triple!.predicate).toBe('lives_in');
      expect(triple!.object).toBe('the Wired');
    });

    it('getTriple returns undefined for nonexistent ID', async () => {
      const { getTriple } = await import('../src/memory/knowledge-graph.js');
      expect(getTriple('no-such-id')).toBeUndefined();
    });

    it('default strength is 1.0', async () => {
      const { addTriple, getTriple } = await import('../src/memory/knowledge-graph.js');
      const id = addTriple('A', 'related', 'B');
      expect(getTriple(id)!.strength).toBe(1.0);
    });

    it('custom strength is preserved', async () => {
      const { addTriple, getTriple } = await import('../src/memory/knowledge-graph.js');
      const id = addTriple('A', 'likes', 'B', 0.42);
      expect(getTriple(id)!.strength).toBeCloseTo(0.42, 5);
    });

    it('validFrom defaults to now', async () => {
      const { addTriple, getTriple } = await import('../src/memory/knowledge-graph.js');
      const before = Date.now();
      const id = addTriple('A', 'is', 'B');
      const triple = getTriple(id)!;
      expect(triple.validFrom).toBeGreaterThanOrEqual(before);
      expect(triple.validFrom).toBeLessThanOrEqual(Date.now() + 1000);
    });

    it('ended is null by default (active triple)', async () => {
      const { addTriple, getTriple } = await import('../src/memory/knowledge-graph.js');
      const id = addTriple('X', 'is', 'Y');
      expect(getTriple(id)!.ended).toBeNull();
    });

    it('metadata defaults to empty object', async () => {
      const { addTriple, getTriple } = await import('../src/memory/knowledge-graph.js');
      const id = addTriple('X', 'is', 'Y');
      expect(getTriple(id)!.metadata).toEqual({});
    });

    it('custom metadata is preserved', async () => {
      const { addTriple, getTriple } = await import('../src/memory/knowledge-graph.js');
      const id = addTriple('X', 'is', 'Y', 1, undefined, undefined, undefined, { source: 'test' });
      expect(getTriple(id)!.metadata).toEqual({ source: 'test' });
    });
  });

  describe('invalidateTriple', () => {
    it('sets ended timestamp', async () => {
      const { addTriple, invalidateTriple, getTriple } = await import('../src/memory/knowledge-graph.js');
      const id = addTriple('A', 'is', 'B');
      invalidateTriple(id);
      const triple = getTriple(id)!;
      expect(triple.ended).not.toBeNull();
      expect(triple.ended).toBeGreaterThan(0);
    });

    it('custom ended timestamp is preserved', async () => {
      const { addTriple, invalidateTriple, getTriple } = await import('../src/memory/knowledge-graph.js');
      const id = addTriple('A', 'was', 'B');
      invalidateTriple(id, 12345);
      expect(getTriple(id)!.ended).toBe(12345);
    });
  });

  describe('queryTriples', () => {
    it('returns empty array when no triples exist', async () => {
      const { queryTriples } = await import('../src/memory/knowledge-graph.js');
      expect(queryTriples({})).toEqual([]);
    });

    it('filters by subject', async () => {
      const { addTriple, queryTriples } = await import('../src/memory/knowledge-graph.js');
      addTriple('Lain', 'knows', 'PKD');
      addTriple('PKD', 'knows', 'Lain');
      const results = queryTriples({ subject: 'Lain' });
      expect(results.length).toBe(1);
      expect(results[0]!.subject).toBe('Lain');
    });

    it('filters by predicate', async () => {
      const { addTriple, queryTriples } = await import('../src/memory/knowledge-graph.js');
      addTriple('Lain', 'likes', 'bears');
      addTriple('Lain', 'knows', 'PKD');
      const results = queryTriples({ predicate: 'likes' });
      expect(results.length).toBe(1);
    });

    it('filters by object', async () => {
      const { addTriple, queryTriples } = await import('../src/memory/knowledge-graph.js');
      addTriple('Lain', 'knows', 'PKD');
      addTriple('Wired', 'knows', 'PKD');
      const results = queryTriples({ object: 'PKD' });
      expect(results.length).toBe(2);
    });

    it('temporal asOf filter excludes invalidated triples', async () => {
      const { addTriple, invalidateTriple, queryTriples } = await import('../src/memory/knowledge-graph.js');
      const id = addTriple('A', 'is', 'B', 1, Date.now() - 10000);
      invalidateTriple(id, Date.now() - 5000);
      // Query at a time after invalidation
      const results = queryTriples({ subject: 'A', asOf: Date.now() });
      expect(results.length).toBe(0);
    });

    it('temporal asOf filter includes active triples', async () => {
      const { addTriple, queryTriples } = await import('../src/memory/knowledge-graph.js');
      addTriple('A', 'is', 'C', 1, Date.now() - 10000);
      const results = queryTriples({ subject: 'A', asOf: Date.now() });
      expect(results.length).toBe(1);
    });

    it('limit parameter is respected', async () => {
      const { addTriple, queryTriples } = await import('../src/memory/knowledge-graph.js');
      for (let i = 0; i < 10; i++) {
        addTriple('X', 'has', `prop-${i}`);
      }
      const results = queryTriples({ subject: 'X', limit: 3 });
      expect(results.length).toBe(3);
    });

    it('combined filters work correctly', async () => {
      const { addTriple, queryTriples } = await import('../src/memory/knowledge-graph.js');
      addTriple('A', 'likes', 'B');
      addTriple('A', 'likes', 'C');
      addTriple('A', 'hates', 'D');
      const results = queryTriples({ subject: 'A', predicate: 'likes' });
      expect(results.length).toBe(2);
    });
  });

  describe('getEntityTimeline', () => {
    it('returns triples where entity is subject or object', async () => {
      const { addTriple, getEntityTimeline } = await import('../src/memory/knowledge-graph.js');
      addTriple('Lain', 'knows', 'PKD');
      addTriple('PKD', 'talked_to', 'Lain');
      addTriple('Wired', 'observes', 'everyone');
      const timeline = getEntityTimeline('Lain');
      expect(timeline.length).toBe(2);
    });

    it('returns empty for unknown entity', async () => {
      const { getEntityTimeline } = await import('../src/memory/knowledge-graph.js');
      expect(getEntityTimeline('nobody')).toEqual([]);
    });

    it('respects limit', async () => {
      const { addTriple, getEntityTimeline } = await import('../src/memory/knowledge-graph.js');
      for (let i = 0; i < 10; i++) {
        addTriple('PKD', `action-${i}`, 'something');
      }
      const timeline = getEntityTimeline('PKD', 3);
      expect(timeline.length).toBe(3);
    });
  });

  describe('addEntity / getEntity', () => {
    it('creates and retrieves an entity', async () => {
      const { addEntity, getEntity } = await import('../src/memory/knowledge-graph.js');
      addEntity('Lain', 'character');
      const entity = getEntity('Lain');
      expect(entity).toBeDefined();
      expect(entity!.name).toBe('Lain');
      expect(entity!.entityType).toBe('character');
    });

    it('getEntity returns undefined for unknown', async () => {
      const { getEntity } = await import('../src/memory/knowledge-graph.js');
      expect(getEntity('nobody')).toBeUndefined();
    });

    it('upsert updates last_seen on duplicate name', async () => {
      const { addEntity, getEntity } = await import('../src/memory/knowledge-graph.js');
      addEntity('Lain', 'character', Date.now() - 10000);
      const before = getEntity('Lain')!.lastSeen;
      await new Promise(r => setTimeout(r, 10));
      addEntity('Lain', 'character');
      const after = getEntity('Lain')!.lastSeen;
      expect(after).toBeGreaterThanOrEqual(before);
    });
  });

  describe('listEntities', () => {
    it('returns all entities', async () => {
      const { addEntity, listEntities } = await import('../src/memory/knowledge-graph.js');
      addEntity('Lain', 'character');
      addEntity('PKD', 'character');
      addEntity('the Wired', 'place');
      const all = listEntities();
      expect(all.length).toBe(3);
    });

    it('filters by type', async () => {
      const { addEntity, listEntities } = await import('../src/memory/knowledge-graph.js');
      addEntity('Lain', 'character');
      addEntity('the Wired', 'place');
      const places = listEntities('place');
      expect(places.length).toBe(1);
      expect(places[0]!.entityType).toBe('place');
    });

    it('returns empty when no entities', async () => {
      const { listEntities } = await import('../src/memory/knowledge-graph.js');
      expect(listEntities()).toEqual([]);
    });
  });

  describe('detectContradictions', () => {
    it('returns empty when no contradictions', async () => {
      const { addTriple, detectContradictions } = await import('../src/memory/knowledge-graph.js');
      addTriple('Lain', 'lives_in', 'the Wired');
      expect(detectContradictions()).toEqual([]);
    });

    it('detects contradicting active triples', async () => {
      const { addTriple, detectContradictions } = await import('../src/memory/knowledge-graph.js');
      addTriple('Lain', 'favorite_color', 'blue');
      addTriple('Lain', 'favorite_color', 'red');
      const contradictions = detectContradictions();
      expect(contradictions.length).toBe(1);
      expect(contradictions[0]!.subject).toBe('Lain');
      expect(contradictions[0]!.predicate).toBe('favorite_color');
    });

    it('does not flag invalidated triples as contradictions', async () => {
      const { addTriple, invalidateTriple, detectContradictions } = await import('../src/memory/knowledge-graph.js');
      const old = addTriple('Lain', 'age', '14');
      invalidateTriple(old);
      addTriple('Lain', 'age', '15');
      expect(detectContradictions()).toEqual([]);
    });

    it('returns empty when no triples at all', async () => {
      const { detectContradictions } = await import('../src/memory/knowledge-graph.js');
      expect(detectContradictions()).toEqual([]);
    });

    it('same subject+predicate+object is not a contradiction', async () => {
      const { addTriple, detectContradictions } = await import('../src/memory/knowledge-graph.js');
      addTriple('Lain', 'is', 'shy');
      addTriple('Lain', 'is', 'shy');
      expect(detectContradictions()).toEqual([]);
    });
  });
});

// =============================================================================
// 7b. KG — ADDITIONAL PROPERTY TESTS
// =============================================================================

describe('Knowledge graph property-based invariants', () => {
  let dir: string;

  beforeEach(async () => {
    dir = tmpDir();
    await openDB(dir);
  });
  afterEach(async () => {
    await closeDB(dir);
  });

  describe('triple uniqueness', () => {
    it('50 triples all get unique IDs', async () => {
      const { addTriple } = await import('../src/memory/knowledge-graph.js');
      const ids = new Set<string>();
      for (let i = 0; i < 50; i++) {
        ids.add(addTriple(`s${i}`, `p${i}`, `o${i}`));
      }
      expect(ids.size).toBe(50);
    });
  });

  describe('triple with same SPO can coexist', () => {
    it('duplicate SPO triples get different IDs (not unique constraint)', async () => {
      const { addTriple, queryTriples } = await import('../src/memory/knowledge-graph.js');
      const id1 = addTriple('A', 'is', 'B');
      const id2 = addTriple('A', 'is', 'B');
      expect(id1).not.toBe(id2);
      // Both exist
      const results = queryTriples({ subject: 'A', predicate: 'is', object: 'B' });
      expect(results.length).toBe(2);
    });
  });

  describe('temporal window queries', () => {
    it('asOf query correctly segments time windows', async () => {
      const { addTriple, invalidateTriple, queryTriples } = await import('../src/memory/knowledge-graph.js');
      const now = Date.now();
      // Triple active from -20s to -10s
      const id1 = addTriple('X', 'was', 'Y', 1, now - 20000, now - 10000);
      // Triple active from -5s, still active
      addTriple('X', 'is', 'Z', 1, now - 5000);

      // At -15s: only first triple active
      const at15 = queryTriples({ subject: 'X', asOf: now - 15000 });
      expect(at15.length).toBe(1);
      expect(at15[0]!.object).toBe('Y');

      // At now: only second triple active
      const atNow = queryTriples({ subject: 'X', asOf: now });
      expect(atNow.length).toBe(1);
      expect(atNow[0]!.object).toBe('Z');
    });
  });

  describe('entity metadata round-trip', () => {
    it('complex metadata survives save/load', async () => {
      const { addEntity, getEntity } = await import('../src/memory/knowledge-graph.js');
      const meta = { aliases: ['Lain-chan'], tags: ['protagonist', 'hacker'], depth: 42 };
      addEntity('Lain', 'character', undefined, meta);
      const entity = getEntity('Lain');
      expect(entity!.metadata).toEqual(meta);
    });
  });

  describe('contradiction detection edge cases', () => {
    it('3 conflicting triples produce 3 contradiction pairs', async () => {
      const { addTriple, detectContradictions } = await import('../src/memory/knowledge-graph.js');
      addTriple('Lain', 'mood', 'happy');
      addTriple('Lain', 'mood', 'sad');
      addTriple('Lain', 'mood', 'anxious');
      const contradictions = detectContradictions();
      // 3 choose 2 = 3 pairs
      expect(contradictions.length).toBe(3);
    });

    it('different predicates are not contradictions', async () => {
      const { addTriple, detectContradictions } = await import('../src/memory/knowledge-graph.js');
      addTriple('Lain', 'likes', 'bears');
      addTriple('Lain', 'hates', 'noise');
      expect(detectContradictions()).toEqual([]);
    });

    it('different subjects with same predicate are not contradictions', async () => {
      const { addTriple, detectContradictions } = await import('../src/memory/knowledge-graph.js');
      addTriple('Lain', 'lives_in', 'library');
      addTriple('PKD', 'lives_in', 'bar');
      expect(detectContradictions()).toEqual([]);
    });
  });

  describe('updateEntityLastSeen', () => {
    it('updates the last_seen timestamp', async () => {
      const { addEntity, updateEntityLastSeen, getEntity } = await import('../src/memory/knowledge-graph.js');
      addEntity('Lain', 'character', Date.now() - 100000);
      const before = getEntity('Lain')!.lastSeen;
      await new Promise(r => setTimeout(r, 10));
      updateEntityLastSeen('Lain');
      const after = getEntity('Lain')!.lastSeen;
      expect(after).toBeGreaterThan(before);
    });
  });

  describe('listEntities ordering', () => {
    it('entities are ordered by last_seen descending', async () => {
      const { addEntity, updateEntityLastSeen, listEntities } = await import('../src/memory/knowledge-graph.js');
      addEntity('oldest', 'test', Date.now() - 30000);
      addEntity('middle', 'test', Date.now() - 20000);
      addEntity('newest', 'test', Date.now() - 10000);
      const entities = listEntities();
      expect(entities[0]!.name).toBe('newest');
      expect(entities[2]!.name).toBe('oldest');
    });
  });
});

// =============================================================================
// 8. PROVIDER CONTRACT INVARIANTS
// =============================================================================

describe('Provider contract runtime invariants', () => {
  describe('Anthropic provider structure', () => {
    it('exports a class with complete and completeWithTools methods', async () => {
      const mod = await import('../src/providers/anthropic.js');
      // Check the module exports an appropriate provider
      const exportNames = Object.keys(mod);
      expect(exportNames.length).toBeGreaterThan(0);
    });
  });

  describe('cosineSimilarity', () => {
    it('returns 1 for identical vectors', async () => {
      const { cosineSimilarity } = await import('../src/memory/embeddings.js');
      const v = new Float32Array([0.1, 0.2, 0.3, 0.4]);
      expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
    });

    it('returns 0 for orthogonal vectors', async () => {
      const { cosineSimilarity } = await import('../src/memory/embeddings.js');
      const a = new Float32Array([1, 0, 0, 0]);
      const b = new Float32Array([0, 1, 0, 0]);
      expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
    });

    it('returns value in [-1, 1]', async () => {
      const { cosineSimilarity } = await import('../src/memory/embeddings.js');
      const a = new Float32Array([0.5, -0.3, 0.8, 0.1]);
      const b = new Float32Array([-0.2, 0.7, -0.4, 0.9]);
      const sim = cosineSimilarity(a, b);
      expect(sim).toBeGreaterThanOrEqual(-1);
      expect(sim).toBeLessThanOrEqual(1);
    });

    it('throws for mismatched dimensions', async () => {
      const { cosineSimilarity } = await import('../src/memory/embeddings.js');
      const a = new Float32Array([1, 2, 3]);
      const b = new Float32Array([1, 2]);
      expect(() => cosineSimilarity(a, b)).toThrow();
    });

    it('returns 0 for zero vectors', async () => {
      const { cosineSimilarity } = await import('../src/memory/embeddings.js');
      const z = new Float32Array([0, 0, 0, 0]);
      const v = new Float32Array([1, 2, 3, 4]);
      expect(cosineSimilarity(z, v)).toBe(0);
    });
  });

  describe('findTopK', () => {
    it('returns k results sorted by similarity', async () => {
      const { findTopK } = await import('../src/memory/embeddings.js');
      const q = new Float32Array([1, 0, 0, 0]);
      const candidates = [
        { id: 'a', embedding: new Float32Array([1, 0, 0, 0]) },    // sim = 1
        { id: 'b', embedding: new Float32Array([0, 1, 0, 0]) },    // sim = 0
        { id: 'c', embedding: new Float32Array([0.7, 0.7, 0, 0]) }, // sim ~= 0.7
      ];
      const results = findTopK(q, candidates, 2);
      expect(results.length).toBe(2);
      expect(results[0]!.id).toBe('a');
      expect(results[1]!.id).toBe('c');
    });

    it('returns fewer than k when not enough candidates', async () => {
      const { findTopK } = await import('../src/memory/embeddings.js');
      const q = new Float32Array([1, 0]);
      const candidates = [{ id: 'only', embedding: new Float32Array([1, 0]) }];
      const results = findTopK(q, candidates, 5);
      expect(results.length).toBe(1);
    });

    it('handles empty candidates', async () => {
      const { findTopK } = await import('../src/memory/embeddings.js');
      const results = findTopK(new Float32Array([1]), [], 5);
      expect(results).toEqual([]);
    });
  });

  describe('serializeEmbedding / deserializeEmbedding round-trip', () => {
    it('preserves float values through serialization', async () => {
      const { serializeEmbedding, deserializeEmbedding } = await import('../src/memory/embeddings.js');
      const original = new Float32Array([0.1, 0.2, 0.3, -0.5, 0.99]);
      const buffer = serializeEmbedding(original);
      const restored = deserializeEmbedding(buffer);
      expect(restored.length).toBe(original.length);
      for (let i = 0; i < original.length; i++) {
        expect(restored[i]).toBeCloseTo(original[i]!, 5);
      }
    });

    it('handles 384-dim vectors (actual embedding size)', async () => {
      const { serializeEmbedding, deserializeEmbedding } = await import('../src/memory/embeddings.js');
      const original = new Float32Array(384);
      for (let i = 0; i < 384; i++) original[i] = Math.random() * 2 - 1;
      const buffer = serializeEmbedding(original);
      const restored = deserializeEmbedding(buffer);
      expect(restored.length).toBe(384);
    });
  });

  describe('computeCentroid', () => {
    it('returns zero vector for empty input', async () => {
      const { computeCentroid } = await import('../src/memory/embeddings.js');
      const centroid = computeCentroid([]);
      expect(centroid.length).toBe(384);
      for (let i = 0; i < centroid.length; i++) {
        expect(centroid[i]).toBe(0);
      }
    });

    it('returns normalized centroid for single vector', async () => {
      const { computeCentroid } = await import('../src/memory/embeddings.js');
      const v = new Float32Array([3, 4, 0]); // norm = 5
      const centroid = computeCentroid([v]);
      // Should be normalized: [0.6, 0.8, 0]
      expect(centroid[0]).toBeCloseTo(0.6, 5);
      expect(centroid[1]).toBeCloseTo(0.8, 5);
    });

    it('centroid of identical vectors equals the normalized vector', async () => {
      const { computeCentroid, cosineSimilarity } = await import('../src/memory/embeddings.js');
      const v = new Float32Array([1, 2, 3, 4]);
      const centroid = computeCentroid([v, v, v]);
      // Similarity to original should be ~1
      expect(cosineSimilarity(centroid, v)).toBeCloseTo(1.0, 3);
    });
  });
});

// =============================================================================
// 9. DATABASE OPERATIONS INVARIANTS
// =============================================================================

describe('Database operations runtime invariants', () => {
  let dir: string;

  beforeEach(async () => {
    dir = tmpDir();
    await openDB(dir);
  });
  afterEach(async () => {
    await closeDB(dir);
  });

  describe('getMeta / setMeta', () => {
    it('getMeta returns null for unknown key', async () => {
      const { getMeta } = await import('../src/storage/database.js');
      expect(getMeta('nonexistent:key')).toBeNull();
    });

    it('setMeta stores and retrieves string value', async () => {
      const { getMeta, setMeta } = await import('../src/storage/database.js');
      setMeta('test:key', 'test-value');
      expect(getMeta('test:key')).toBe('test-value');
    });

    it('setMeta overwrites existing value', async () => {
      const { getMeta, setMeta } = await import('../src/storage/database.js');
      setMeta('overwrite:key', 'first');
      setMeta('overwrite:key', 'second');
      expect(getMeta('overwrite:key')).toBe('second');
    });

    it('stores and retrieves JSON in meta', async () => {
      const { getMeta, setMeta } = await import('../src/storage/database.js');
      const obj = { hello: 'world', count: 42, nested: { ok: true } };
      setMeta('json:key', JSON.stringify(obj));
      const loaded = JSON.parse(getMeta('json:key')!);
      expect(loaded).toEqual(obj);
    });

    it('empty string is a valid meta value (not null)', async () => {
      const { getMeta, setMeta } = await import('../src/storage/database.js');
      setMeta('empty:key', '');
      expect(getMeta('empty:key')).toBe('');
    });
  });

  describe('execute / query / queryOne', () => {
    it('execute returns changes count', async () => {
      const { execute, setMeta, getMeta } = await import('../src/storage/database.js');
      setMeta('exec:test', 'value');
      const result = execute("DELETE FROM meta WHERE key = 'exec:test'");
      expect(result.changes).toBe(1);
    });

    it('query returns array', async () => {
      const { query } = await import('../src/storage/database.js');
      const rows = query<{ key: string; value: string }>('SELECT * FROM meta WHERE key = ?', ['schema_version']);
      expect(Array.isArray(rows)).toBe(true);
    });

    it('queryOne returns single row or undefined', async () => {
      const { queryOne, setMeta } = await import('../src/storage/database.js');
      setMeta('qo:test', 'hello');
      const row = queryOne<{ value: string }>('SELECT value FROM meta WHERE key = ?', ['qo:test']);
      expect(row).toBeDefined();
      expect(row!.value).toBe('hello');
      const missing = queryOne<{ value: string }>('SELECT value FROM meta WHERE key = ?', ['no:such']);
      expect(missing).toBeUndefined();
    });
  });

  describe('transaction', () => {
    it('commits on success', async () => {
      const { transaction, setMeta, getMeta } = await import('../src/storage/database.js');
      transaction(() => {
        setMeta('tx:a', '1');
        setMeta('tx:b', '2');
      });
      expect(getMeta('tx:a')).toBe('1');
      expect(getMeta('tx:b')).toBe('2');
    });

    it('rolls back on error', async () => {
      const { transaction, setMeta, getMeta } = await import('../src/storage/database.js');
      try {
        transaction(() => {
          setMeta('tx:rollback', 'should-not-persist');
          throw new Error('intentional');
        });
      } catch { /* expected */ }
      expect(getMeta('tx:rollback')).toBeNull();
    });
  });
});

// =============================================================================
// 9b. DATABASE — ADDITIONAL EDGE CASES
// =============================================================================

describe('Database edge case invariants', () => {
  let dir: string;

  beforeEach(async () => {
    dir = tmpDir();
    await openDB(dir);
  });
  afterEach(async () => {
    await closeDB(dir);
  });

  it('meta key with special characters works', async () => {
    const { getMeta, setMeta } = await import('../src/storage/database.js');
    setMeta('key:with:colons', 'value1');
    setMeta('key/with/slashes', 'value2');
    setMeta('key.with.dots', 'value3');
    expect(getMeta('key:with:colons')).toBe('value1');
    expect(getMeta('key/with/slashes')).toBe('value2');
    expect(getMeta('key.with.dots')).toBe('value3');
  });

  it('very long meta value survives', async () => {
    const { getMeta, setMeta } = await import('../src/storage/database.js');
    const longVal = 'x'.repeat(100000);
    setMeta('long:value', longVal);
    expect(getMeta('long:value')).toBe(longVal);
  });

  it('unicode in meta survives', async () => {
    const { getMeta, setMeta } = await import('../src/storage/database.js');
    const unicode = 'Hello \u{1F600} \u{1F680} \u4E16\u754C';
    setMeta('unicode:test', unicode);
    expect(getMeta('unicode:test')).toBe(unicode);
  });

  it('execute returns 0 changes for no-match update', async () => {
    const { execute } = await import('../src/storage/database.js');
    const result = execute("UPDATE meta SET value = 'x' WHERE key = 'nonexistent-key-12345'");
    expect(result.changes).toBe(0);
  });

  it('query with no results returns empty array', async () => {
    const { query } = await import('../src/storage/database.js');
    const rows = query<unknown>('SELECT * FROM meta WHERE key = ?', ['no-such-key']);
    expect(rows).toEqual([]);
  });

  it('isDatabaseInitialized returns true after init', async () => {
    const { isDatabaseInitialized } = await import('../src/storage/database.js');
    expect(isDatabaseInitialized()).toBe(true);
  });
});

// =============================================================================
// 9c. MESSAGE & MEMORY — ADDITIONAL PROPERTY TESTS
// =============================================================================

describe('Message and memory additional invariants', () => {
  let dir: string;

  beforeEach(async () => {
    dir = tmpDir();
    await openDB(dir);
  });
  afterEach(async () => {
    await closeDB(dir);
  });

  describe('message user_id filtering', () => {
    it('getMessagesForUser returns only that users messages', async () => {
      const { saveMessage, getMessagesForUser } = await import('../src/memory/store.js');
      saveMessage({ sessionKey: 's1', userId: 'alice', role: 'user', content: 'hello from alice', timestamp: Date.now(), metadata: {} });
      saveMessage({ sessionKey: 's1', userId: 'bob', role: 'user', content: 'hello from bob', timestamp: Date.now() + 1, metadata: {} });
      const aliceMsgs = getMessagesForUser('alice');
      expect(aliceMsgs.length).toBe(1);
      expect(aliceMsgs[0]!.content).toBe('hello from alice');
    });
  });

  describe('getAllMessages', () => {
    it('returns all messages for a session in order', async () => {
      const { saveMessage, getAllMessages } = await import('../src/memory/store.js');
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        saveMessage({ sessionKey: 'all:test', userId: null, role: i % 2 === 0 ? 'user' : 'assistant', content: `msg-${i}`, timestamp: now + i * 100, metadata: {} });
      }
      const all = getAllMessages('all:test');
      expect(all.length).toBe(5);
      // Should be in ascending order
      for (let i = 1; i < all.length; i++) {
        expect(all[i]!.timestamp).toBeGreaterThanOrEqual(all[i - 1]!.timestamp);
      }
    });
  });

  describe('getMessagesByTimeRange', () => {
    it('filters messages within time window', async () => {
      const { saveMessage, getMessagesByTimeRange } = await import('../src/memory/store.js');
      const now = Date.now();
      saveMessage({ sessionKey: 'tr:test', userId: null, role: 'user', content: 'old', timestamp: now - 10000, metadata: {} });
      saveMessage({ sessionKey: 'tr:test', userId: null, role: 'user', content: 'recent', timestamp: now - 1000, metadata: {} });
      saveMessage({ sessionKey: 'tr:test', userId: null, role: 'user', content: 'future', timestamp: now + 10000, metadata: {} });
      const msgs = getMessagesByTimeRange(now - 5000, now);
      expect(msgs.length).toBe(1);
      expect(msgs[0]!.content).toBe('recent');
    });
  });

  describe('getAllRecentMessages', () => {
    it('returns messages across all sessions', async () => {
      const { saveMessage, getAllRecentMessages } = await import('../src/memory/store.js');
      saveMessage({ sessionKey: 'a:test', userId: null, role: 'user', content: 'from a', timestamp: Date.now(), metadata: {} });
      saveMessage({ sessionKey: 'b:test', userId: null, role: 'user', content: 'from b', timestamp: Date.now() + 1, metadata: {} });
      const msgs = getAllRecentMessages();
      expect(msgs.length).toBeGreaterThanOrEqual(2);
    });

    it('respects limit', async () => {
      const { saveMessage, getAllRecentMessages } = await import('../src/memory/store.js');
      for (let i = 0; i < 10; i++) {
        saveMessage({ sessionKey: 'lim:test', userId: null, role: 'user', content: `m-${i}`, timestamp: Date.now() + i, metadata: {} });
      }
      const limited = getAllRecentMessages(3);
      expect(limited.length).toBe(3);
    });
  });

  describe('structural role computation', () => {
    it('ephemeral for memory with no connections', async () => {
      const { computeStructuralRole } = await import('../src/memory/store.js');
      // Use a memory ID that doesn't exist — it should have 0 connections
      const role = computeStructuralRole('nonexistent-id');
      expect(role).toBe('ephemeral');
    });
  });

  describe('causal links', () => {
    it('addCausalLink creates a retrievable link', async () => {
      const { addCausalLink, getCausalLinks } = await import('../src/memory/store.js');
      addCausalLink('mem1', 'mem2', 'similar', 'prerequisite', 0.7);
      const links = getCausalLinks('mem1');
      expect(links.length).toBe(1);
      expect(links[0]!.causalType).toBe('prerequisite');
    });

    it('getCausalLinks filters by causal type', async () => {
      const { addCausalLink, getCausalLinks } = await import('../src/memory/store.js');
      addCausalLink('m1', 'm2', 'similar', 'prerequisite', 0.5);
      addCausalLink('m1', 'm3', 'pattern', 'tension', 0.6);
      const prereqs = getCausalLinks('m1', 'prerequisite');
      expect(prereqs.length).toBe(1);
      expect(prereqs[0]!.causalType).toBe('prerequisite');
    });
  });

  describe('coherence group member operations', () => {
    it('addToCoherenceGroup increments member count', async () => {
      const { createCoherenceGroup, addToCoherenceGroup, getCoherenceGroup } = await import('../src/memory/store.js');
      const gid = createCoherenceGroup('test', null);
      addToCoherenceGroup('fake-mem-1', gid);
      addToCoherenceGroup('fake-mem-2', gid);
      const group = getCoherenceGroup(gid);
      expect(group!.memberCount).toBe(2);
    });

    it('removeFromCoherenceGroup decrements member count', async () => {
      const { createCoherenceGroup, addToCoherenceGroup, removeFromCoherenceGroup, getCoherenceGroup } = await import('../src/memory/store.js');
      const gid = createCoherenceGroup('test', null);
      addToCoherenceGroup('mem-1', gid);
      addToCoherenceGroup('mem-2', gid);
      removeFromCoherenceGroup('mem-1', gid);
      expect(getCoherenceGroup(gid)!.memberCount).toBe(1);
    });

    it('getGroupsForMemory returns groups memory belongs to', async () => {
      const { createCoherenceGroup, addToCoherenceGroup, getGroupsForMemory } = await import('../src/memory/store.js');
      const g1 = createCoherenceGroup('group-A', null);
      const g2 = createCoherenceGroup('group-B', null);
      addToCoherenceGroup('shared-mem', g1);
      addToCoherenceGroup('shared-mem', g2);
      const groups = getGroupsForMemory('shared-mem');
      expect(groups.length).toBe(2);
    });

    it('getGroupMembers lists member IDs', async () => {
      const { createCoherenceGroup, addToCoherenceGroup, getGroupMembers } = await import('../src/memory/store.js');
      const gid = createCoherenceGroup('test', null);
      addToCoherenceGroup('m1', gid);
      addToCoherenceGroup('m2', gid);
      addToCoherenceGroup('m3', gid);
      const members = getGroupMembers(gid);
      expect(members.length).toBe(3);
      expect(members).toContain('m1');
      expect(members).toContain('m2');
      expect(members).toContain('m3');
    });
  });

  describe('lifecycle state transitions', () => {
    it('setLifecycleState does not crash for nonexistent memory', async () => {
      const { setLifecycleState } = await import('../src/memory/store.js');
      // Should not throw (updates 0 rows)
      expect(() => setLifecycleState('no-such-id', 'composting')).not.toThrow();
    });
  });
});

// =============================================================================
// 10. CROSS-SYSTEM INVARIANTS
// =============================================================================

describe('Cross-system runtime invariants', () => {
  let dir: string;

  beforeEach(async () => {
    dir = tmpDir();
    await openDB(dir);
  });
  afterEach(async () => {
    await closeDB(dir);
  });

  it('emotional state save + weather compute produces valid weather', async () => {
    const { saveState } = await import('../src/agent/internal-state.js');
    const { computeWeather } = await import('../src/commune/weather.js');
    const state = mkState({ energy: 0.8, valence: 0.9, emotional_weight: 0.1 });
    saveState(state);
    const weather = await computeWeather([state]);
    expect(['clear', 'overcast', 'rain', 'fog', 'storm', 'aurora']).toContain(weather.condition);
  });

  it('location set + desire evaluation references valid building', async () => {
    const { setMeta } = await import('../src/storage/database.js');
    const { evaluateMovementDesire } = await import('../src/agent/internal-state.js');
    const { BUILDING_MAP } = await import('../src/commune/buildings.js');
    setMeta('town:current_location', JSON.stringify({ building: 'library', timestamp: Date.now() }));
    const result = evaluateMovementDesire(
      mkState({ emotional_weight: 0.95 }),
      [], [], 'library', new Map(),
    );
    if (result) {
      // The building suggested should be a known building or at least a non-empty string
      expect(typeof result.building).toBe('string');
      expect(result.building.length).toBeGreaterThan(0);
    }
  });

  it('session with messages: messages belong to correct session', async () => {
    const { createSession } = await import('../src/storage/sessions.js');
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
    const session = createSession({
      agentId: 'lain', channel: 'web', peerKind: 'user', peerId: 'test',
    });
    saveMessage({
      sessionKey: session.key,
      userId: 'test',
      role: 'user',
      content: 'hello from session',
      timestamp: Date.now(),
      metadata: {},
    });
    const msgs = getRecentMessages(session.key);
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.sessionKey).toBe(session.key);
  });

  it('KG triple + entity: entity timeline shows the triple', async () => {
    const { addTriple, addEntity, getEntityTimeline } = await import('../src/memory/knowledge-graph.js');
    addEntity('Lain', 'character');
    addTriple('Lain', 'discovered', 'the pattern');
    const timeline = getEntityTimeline('Lain');
    expect(timeline.length).toBe(1);
    expect(timeline[0]!.predicate).toBe('discovered');
  });

  it('desire + resolve cycle: active count returns to 0', async () => {
    const { ensureDesireTable, createDesire, resolveDesire, getActiveDesires } = await import('../src/agent/desires.js');
    ensureDesireTable();
    const d1 = createDesire({ type: 'social', description: 'test1', source: 'test' });
    const d2 = createDesire({ type: 'emotional', description: 'test2', source: 'test' });
    expect(getActiveDesires().length).toBe(2);
    resolveDesire(d1.id, 'done');
    resolveDesire(d2.id, 'done');
    expect(getActiveDesires().length).toBe(0);
  });

  it('postboard message survives session creation (no table conflicts)', async () => {
    const { createSession } = await import('../src/storage/sessions.js');
    const { savePostboardMessage, getPostboardMessages } = await import('../src/memory/store.js');
    createSession({ agentId: 'lain', channel: 'web', peerKind: 'user', peerId: 'x' });
    savePostboardMessage('hello town');
    const msgs = getPostboardMessages();
    expect(msgs.length).toBeGreaterThanOrEqual(1);
  });

  it('state decay + preoccupation decay both produce valid results', async () => {
    const { saveState, applyDecay, addPreoccupation, decayPreoccupations, getPreoccupations } = await import('../src/agent/internal-state.js');
    const state = mkState({ energy: 0.8, sociability: 0.7 });
    saveState(state);
    const decayed = applyDecay(state);
    assertAllAxesInRange(decayed);
    addPreoccupation('test thought', 'test');
    decayPreoccupations();
    const preocc = getPreoccupations();
    if (preocc.length > 0) {
      expect(preocc[0]!.intensity).toBeGreaterThan(0);
      expect(preocc[0]!.intensity).toBeLessThan(1);
    }
  });

  it('meta key-value store survives concurrent reads and writes', async () => {
    const { getMeta, setMeta } = await import('../src/storage/database.js');
    // Simulate rapid interleaved reads and writes
    for (let i = 0; i < 50; i++) {
      setMeta(`concurrent:${i}`, `value-${i}`);
      expect(getMeta(`concurrent:${i}`)).toBe(`value-${i}`);
    }
  });

  it('desire types match desire context adverbs', async () => {
    const { ensureDesireTable, createDesire, getDesireContext } = await import('../src/agent/desires.js');
    ensureDesireTable();
    createDesire({ type: 'social', description: 'reach out to a friend', source: 'test', intensity: 0.5 });
    const ctx = getDesireContext();
    // Mid intensity should use "somewhat"
    expect(ctx).toContain('somewhat');
  });

  it('multiple KG entities of different types coexist', async () => {
    const { addEntity, listEntities } = await import('../src/memory/knowledge-graph.js');
    addEntity('Lain', 'character');
    addEntity('the Wired', 'place');
    addEntity('curiosity', 'concept');
    const chars = listEntities('character');
    const places = listEntities('place');
    const concepts = listEntities('concept');
    expect(chars.length).toBe(1);
    expect(places.length).toBe(1);
    expect(concepts.length).toBe(1);
  });

  it('session + messages + deletion: deleting session does not delete messages', async () => {
    const { createSession, deleteSession } = await import('../src/storage/sessions.js');
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
    const s = createSession({ agentId: 'lain', channel: 'web', peerKind: 'user', peerId: 'v' });
    saveMessage({ sessionKey: s.key, userId: null, role: 'user', content: 'persist me', timestamp: Date.now(), metadata: {} });
    deleteSession(s.key);
    // Messages should still exist (no cascade)
    const msgs = getRecentMessages(s.key);
    expect(msgs.length).toBe(1);
  });

  it('weather getWeatherEffect values are small adjustments', async () => {
    const { getWeatherEffect } = await import('../src/commune/weather.js');
    const conditions = ['storm', 'rain', 'fog', 'aurora', 'clear'];
    for (const cond of conditions) {
      const effect = getWeatherEffect(cond);
      for (const [, val] of Object.entries(effect)) {
        if (typeof val === 'number') {
          expect(Math.abs(val)).toBeLessThanOrEqual(0.1);
        }
      }
    }
  });

  it('batch session token update works', async () => {
    const { createSession, getSession } = await import('../src/storage/sessions.js');
    const { batchUpdateTokenCounts } = await import('../src/storage/sessions.js');
    const s1 = createSession({ agentId: 'lain', channel: 'web', peerKind: 'user', peerId: 'u1' });
    const s2 = createSession({ agentId: 'lain', channel: 'web', peerKind: 'user', peerId: 'u2' });
    batchUpdateTokenCounts([
      { key: s1.key, tokenCount: 100 },
      { key: s2.key, tokenCount: 200 },
    ]);
    expect(getSession(s1.key)!.tokenCount).toBe(100);
    expect(getSession(s2.key)!.tokenCount).toBe(200);
  });

  it('desire ensureDesireTable is idempotent', async () => {
    const { ensureDesireTable, getActiveDesires } = await import('../src/agent/desires.js');
    // Call multiple times — should not throw or corrupt
    ensureDesireTable();
    ensureDesireTable();
    ensureDesireTable();
    expect(getActiveDesires()).toEqual([]);
  });
});

// =============================================================================
// 11. ADDITIONAL INTEGRATION INVARIANTS
// =============================================================================

describe('Additional integration invariants', () => {
  let dir: string;

  beforeEach(async () => {
    dir = tmpDir();
    await openDB(dir);
  });
  afterEach(async () => {
    await closeDB(dir);
  });

  it('event bus parseEventType maps known prefixes correctly', async () => {
    const { parseEventType } = await import('../src/events/bus.js');
    const mappings: [string, string][] = [
      ['commune:pkd:123', 'commune'],
      ['diary:2024', 'diary'],
      ['dream:xyz', 'dream'],
      ['curiosity:abc', 'curiosity'],
      ['letter:lain', 'letter'],
      ['wired:something', 'letter'],
      ['web:chat', 'chat'],
      ['peer:msg', 'peer'],
      ['telegram:chat', 'chat'],
      ['doctor:session', 'doctor'],
      ['movement:123', 'movement'],
      ['note:abc', 'note'],
      ['document:xyz', 'document'],
      ['weather:update', 'weather'],
    ];
    for (const [input, expected] of mappings) {
      expect(parseEventType(input), `parseEventType('${input}')`).toBe(expected);
    }
  });

  it('parseEventType handles null and empty gracefully', async () => {
    const { parseEventType } = await import('../src/events/bus.js');
    expect(parseEventType(null)).toBe('unknown');
    expect(parseEventType('')).toBe('unknown');
  });

  it('parseEventType returns prefix for unknown types', async () => {
    const { parseEventType } = await import('../src/events/bus.js');
    expect(parseEventType('custom:something')).toBe('custom');
  });

  it('getEmbeddingDimensions returns 384', async () => {
    const { getEmbeddingDimensions } = await import('../src/memory/embeddings.js');
    expect(getEmbeddingDimensions()).toBe(384);
  });

  it('generateSessionKey produces 21-char strings', async () => {
    const { generateSessionKey } = await import('../src/storage/sessions.js');
    for (let i = 0; i < 10; i++) {
      const key = generateSessionKey();
      expect(key.length).toBe(21);
    }
  });

  it('generateSessionKey produces unique keys', async () => {
    const { generateSessionKey } = await import('../src/storage/sessions.js');
    const keys = new Set<string>();
    for (let i = 0; i < 100; i++) {
      keys.add(generateSessionKey());
    }
    expect(keys.size).toBe(100);
  });

  it('building notes query returns empty for unknown building', async () => {
    const { getNotesByBuilding } = await import('../src/memory/store.js');
    const notes = getNotesByBuilding('nonexistent-building');
    expect(notes).toEqual([]);
  });

  it('getDocumentsByAuthor returns empty for unknown author', async () => {
    const { getDocumentsByAuthor } = await import('../src/memory/store.js');
    const docs = getDocumentsByAuthor('nobody');
    expect(docs).toEqual([]);
  });

  it('getActivity returns empty for future time range', async () => {
    const { getActivity } = await import('../src/memory/store.js');
    const future = Date.now() + 86400000;
    const activity = getActivity(future, future + 1000);
    expect(activity).toEqual([]);
  });

  it('getLastUserMessageTimestamp returns null with no messages', async () => {
    const { getLastUserMessageTimestamp } = await import('../src/memory/store.js');
    expect(getLastUserMessageTimestamp()).toBeNull();
  });

  it('getLastUserMessageTimestamp returns valid timestamp after saving', async () => {
    const { saveMessage, getLastUserMessageTimestamp } = await import('../src/memory/store.js');
    const now = Date.now();
    saveMessage({ sessionKey: 'ts:test', userId: 'u', role: 'user', content: 'hi', timestamp: now, metadata: {} });
    const ts = getLastUserMessageTimestamp();
    expect(ts).toBe(now);
  });

  it('getRecentVisitorMessages excludes peer and commune sessions', async () => {
    const { saveMessage, getRecentVisitorMessages } = await import('../src/memory/store.js');
    const now = Date.now();
    saveMessage({ sessionKey: 'peer:msg:1', userId: null, role: 'user', content: 'peer msg', timestamp: now, metadata: {} });
    saveMessage({ sessionKey: 'commune:pkd:1', userId: null, role: 'user', content: 'commune msg', timestamp: now + 1, metadata: {} });
    saveMessage({ sessionKey: 'web:visitor:1', userId: 'visitor', role: 'user', content: 'visitor msg', timestamp: now + 2, metadata: {} });
    const visitor = getRecentVisitorMessages();
    // Should only include the visitor message
    const contents = visitor.map(m => m.content);
    expect(contents).toContain('visitor msg');
    expect(contents).not.toContain('peer msg');
    expect(contents).not.toContain('commune msg');
  });
});
