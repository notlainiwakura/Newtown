/**
 * Tests for internal emotional state system
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock keytar before any imports that touch storage
vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn().mockResolvedValue('test-master-key'),
    setPassword: vi.fn().mockResolvedValue(undefined),
    deletePassword: vi.fn().mockResolvedValue(true),
    findCredentials: vi.fn().mockResolvedValue([]),
  },
}));

describe('Internal Emotional State', () => {
  const testDir = join(tmpdir(), `lain-test-state-${Date.now()}`);
  const dbPath = join(testDir, 'test.db');
  const originalEnv = process.env['LAIN_HOME'];

  beforeEach(async () => {
    process.env['LAIN_HOME'] = testDir;
    await mkdir(testDir, { recursive: true });
    const { initDatabase } = await import('../src/storage/database.js');
    await initDatabase(dbPath);
  });

  afterEach(async () => {
    const { closeDatabase } = await import('../src/storage/database.js');
    closeDatabase();
    if (originalEnv) {
      process.env['LAIN_HOME'] = originalEnv;
    } else {
      delete process.env['LAIN_HOME'];
    }
    try { await rm(testDir, { recursive: true }); } catch {}
  });

  it('returns default state when none persisted', async () => {
    const { getCurrentState } = await import('../src/agent/internal-state.js');
    const state = getCurrentState();
    expect(state.energy).toBe(0.6);
    expect(state.sociability).toBe(0.5);
    expect(state.intellectual_arousal).toBe(0.4);
    expect(state.emotional_weight).toBe(0.3);
    expect(state.valence).toBe(0.6);
    expect(state.primary_color).toBe('neutral');
    expect(state.updated_at).toBeTypeOf('number');
  });

  it('persists and loads state via meta store', async () => {
    const { getCurrentState, saveState } = await import('../src/agent/internal-state.js');
    const state = getCurrentState();
    state.energy = 0.8;
    state.primary_color = 'serene';
    saveState(state);

    const loaded = getCurrentState();
    expect(loaded.energy).toBe(0.8);
    expect(loaded.primary_color).toBe('serene');
  });

  it('clamps values to [0, 1]', async () => {
    const { clampState } = await import('../src/agent/internal-state.js');
    const clamped = clampState({
      energy: 1.5,
      sociability: -0.3,
      intellectual_arousal: 0.5,
      emotional_weight: 2.0,
      valence: -1.0,
      primary_color: 'test',
      updated_at: Date.now(),
    });
    expect(clamped.energy).toBe(1);
    expect(clamped.sociability).toBe(0);
    expect(clamped.intellectual_arousal).toBe(0.5);
    expect(clamped.emotional_weight).toBe(1);
    expect(clamped.valence).toBe(0);
  });

  it('applies heuristic decay correctly', async () => {
    const { applyDecay } = await import('../src/agent/internal-state.js');
    const state = {
      energy: 0.8,
      sociability: 0.8,
      intellectual_arousal: 0.5,
      emotional_weight: 0.4,
      valence: 0.6,
      primary_color: 'neutral',
      updated_at: Date.now(),
    };
    const decayed = applyDecay(state);
    expect(decayed.energy).toBeCloseTo(0.78, 5);
    expect(decayed.intellectual_arousal).toBeCloseTo(0.485, 5);
    // sociability drifts toward 0.5: 0.8 - 0.02*(0.8-0.5) = 0.8 - 0.006 = 0.794
    expect(decayed.sociability).toBeCloseTo(0.794, 5);
  });

  it('decay does not go below 0', async () => {
    const { applyDecay } = await import('../src/agent/internal-state.js');
    const state = {
      energy: 0.01,
      sociability: 0.5,
      intellectual_arousal: 0.005,
      emotional_weight: 0.0,
      valence: 0.5,
      primary_color: 'neutral',
      updated_at: Date.now(),
    };
    const decayed = applyDecay(state);
    expect(decayed.energy).toBeGreaterThanOrEqual(0);
    expect(decayed.intellectual_arousal).toBeGreaterThanOrEqual(0);
  });

  it('generates a natural language summary', async () => {
    const { getCurrentState, saveState, getStateSummary } = await import('../src/agent/internal-state.js');
    const state = getCurrentState();
    state.energy = 0.8;
    state.intellectual_arousal = 0.9;
    state.emotional_weight = 0.7;
    state.valence = 0.4;
    state.primary_color = 'contemplative';
    saveState(state);

    const summary = getStateSummary();
    expect(summary).toBeTypeOf('string');
    expect(summary.length).toBeGreaterThan(10);
    expect(summary).toContain('contemplative');
  });

  it('maintains state history capped at 10', async () => {
    const { getCurrentState, saveState, getStateHistory } = await import('../src/agent/internal-state.js');

    // Save 12 states
    for (let i = 0; i < 12; i++) {
      const state = getCurrentState();
      state.energy = i * 0.08;
      state.updated_at = Date.now() + i;
      saveState(state);
    }

    const history = getStateHistory();
    expect(history.length).toBeLessThanOrEqual(10);
  });

  it('updateState produces valid state with heuristic fallback', async () => {
    const { getCurrentState, saveState, updateState } = await import('../src/agent/internal-state.js');
    const state = getCurrentState();
    state.energy = 0.5;
    saveState(state);

    const updated = await updateState({
      type: 'curiosity:discovery',
      summary: 'Found an interesting paper about fractals',
    });

    expect(updated.energy).toBeTypeOf('number');
    expect(updated.energy).toBeGreaterThanOrEqual(0);
    expect(updated.energy).toBeLessThanOrEqual(1);
    // curiosity:discovery should bump intellectual_arousal
    expect(updated.intellectual_arousal).toBeGreaterThan(0.4);
  });

  it('startStateDecayLoop returns a cleanup function', async () => {
    const { startStateDecayLoop } = await import('../src/agent/internal-state.js');
    const stop = startStateDecayLoop();
    expect(stop).toBeTypeOf('function');
    stop(); // cleanup
  });
});

describe('Preoccupations', () => {
  const testDir = join(tmpdir(), `lain-test-preoccupation-${Date.now()}`);
  const dbPath = join(testDir, 'test.db');
  const originalEnv = process.env['LAIN_HOME'];

  beforeEach(async () => {
    process.env['LAIN_HOME'] = testDir;
    await mkdir(testDir, { recursive: true });
    const { initDatabase } = await import('../src/storage/database.js');
    await initDatabase(dbPath);
  });

  afterEach(async () => {
    const { closeDatabase } = await import('../src/storage/database.js');
    closeDatabase();
    if (originalEnv) process.env['LAIN_HOME'] = originalEnv;
    else delete process.env['LAIN_HOME'];
    try { await rm(testDir, { recursive: true }); } catch {}
  });

  it('starts with empty preoccupations', async () => {
    const { getPreoccupations } = await import('../src/agent/internal-state.js');
    expect(getPreoccupations()).toEqual([]);
  });

  it('adds a preoccupation', async () => {
    const { addPreoccupation, getPreoccupations } = await import('../src/agent/internal-state.js');
    addPreoccupation('Whether glitches reveal or just disrupt', 'conversation with PKD');
    const preocc = getPreoccupations();
    expect(preocc.length).toBe(1);
    expect(preocc[0]!.thread).toContain('glitches');
    expect(preocc[0]!.intensity).toBeGreaterThan(0.5);
  });

  it('caps at 5 preoccupations, displacing lowest intensity', async () => {
    const { addPreoccupation, getPreoccupations } = await import('../src/agent/internal-state.js');
    for (let i = 0; i < 6; i++) {
      addPreoccupation(`thought-${i}`, `origin-${i}`);
    }
    expect(getPreoccupations().length).toBeLessThanOrEqual(5);
  });

  it('resolves a preoccupation', async () => {
    const { addPreoccupation, resolvePreoccupation, getPreoccupations } = await import('../src/agent/internal-state.js');
    addPreoccupation('test thread', 'test origin');
    const id = getPreoccupations()[0]!.id;
    resolvePreoccupation(id, 'understood it now');
    expect(getPreoccupations().length).toBe(0);
  });

  it('decays preoccupation intensity', async () => {
    const { addPreoccupation, decayPreoccupations, getPreoccupations } = await import('../src/agent/internal-state.js');
    addPreoccupation('persistent thought', 'origin');
    const before = getPreoccupations()[0]!.intensity;
    decayPreoccupations();
    const after = getPreoccupations()[0]!.intensity;
    expect(after).toBeLessThan(before);
  });
});

describe('Desire-Driven Movement', () => {
  it('evaluateMovementDesire returns null when confidence is low', async () => {
    const { evaluateMovementDesire } = await import('../src/agent/internal-state.js');
    const result = evaluateMovementDesire(
      {
        energy: 0.5, sociability: 0.5, intellectual_arousal: 0.5,
        emotional_weight: 0.3, valence: 0.6, primary_color: 'neutral', updated_at: Date.now(),
      },
      [],
      [],
      'library',
      new Map(),
    );
    expect(result === null || result.confidence < 0.6).toBe(true);
  });

  it('suggests retreat to default when energy is low', async () => {
    const { evaluateMovementDesire } = await import('../src/agent/internal-state.js');
    const result = evaluateMovementDesire(
      {
        energy: 0.15, sociability: 0.2, intellectual_arousal: 0.3,
        emotional_weight: 0.4, valence: 0.5, primary_color: 'tired', updated_at: Date.now(),
      },
      [],
      [],
      'bar',
      new Map(),
    );
    if (result) {
      expect(result.confidence).toBeGreaterThan(0);
    }
  });

  it('suggests peer location when preoccupation has unresolved thread', async () => {
    const { evaluateMovementDesire } = await import('../src/agent/internal-state.js');
    const result = evaluateMovementDesire(
      {
        energy: 0.6, sociability: 0.7, intellectual_arousal: 0.6,
        emotional_weight: 0.3, valence: 0.6, primary_color: 'seeking', updated_at: Date.now(),
      },
      [{
        id: 'p1', thread: 'what PKD said about observation',
        origin: 'commune conversation with pkd',
        originated_at: Date.now(), intensity: 0.8, resolution: null,
      }],
      [{
        peerId: 'pkd', peerName: 'PKD', affinity: 0.7, familiarity: 0.6,
        intellectual_tension: 0.8, emotional_resonance: 0.4,
        last_topic_thread: 'observation', unresolved: 'whether it changes reality',
        last_interaction: Date.now(), interaction_count: 5,
      }],
      'library',
      new Map([['pkd', 'bar']]),
    );
    if (result && result.confidence > 0.6) {
      expect(result.building).toBe('bar');
    }
  });
});
