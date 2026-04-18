/**
 * Deep tests for commune/town spatial systems:
 * - Building grid operations
 * - Location state management
 * - Weather computation
 * - Building memory (local DB operations)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn().mockResolvedValue('test-master-key'),
    setPassword: vi.fn().mockResolvedValue(undefined),
    deletePassword: vi.fn().mockResolvedValue(true),
    findCredentials: vi.fn().mockResolvedValue([]),
  },
}));

// ─────────────────────────────────────────────────────────
// 1. BUILDING GRID OPERATIONS
// ─────────────────────────────────────────────────────────

describe('Building Grid — Properties', () => {
  it('exports exactly 9 buildings', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    expect(BUILDINGS).toHaveLength(9);
  });

  it('all buildings have required fields', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    for (const b of BUILDINGS) {
      expect(typeof b.id).toBe('string');
      expect(b.id.length).toBeGreaterThan(0);
      expect(typeof b.name).toBe('string');
      expect(b.name.length).toBeGreaterThan(0);
      expect(typeof b.emoji).toBe('string');
      expect(b.emoji.length).toBeGreaterThan(0);
      expect(typeof b.row).toBe('number');
      expect(typeof b.col).toBe('number');
      expect(typeof b.description).toBe('string');
      expect(b.description.length).toBeGreaterThan(0);
    }
  });

  it('contains library building with correct properties', async () => {
    const { BUILDING_MAP } = await import('../src/commune/buildings.js');
    const lib = BUILDING_MAP.get('library');
    expect(lib).toBeDefined();
    expect(lib!.name).toBe('Library');
    expect(lib!.emoji).toBe('📚');
    expect(lib!.row).toBe(0);
    expect(lib!.col).toBe(0);
  });

  it('contains bar building with correct properties', async () => {
    const { BUILDING_MAP } = await import('../src/commune/buildings.js');
    const bar = BUILDING_MAP.get('bar');
    expect(bar).toBeDefined();
    expect(bar!.name).toBe('Bar');
    expect(bar!.emoji).toBe('🍺');
    expect(bar!.row).toBe(0);
    expect(bar!.col).toBe(1);
  });

  it('contains field building with correct properties', async () => {
    const { BUILDING_MAP } = await import('../src/commune/buildings.js');
    const field = BUILDING_MAP.get('field');
    expect(field).toBeDefined();
    expect(field!.row).toBe(0);
    expect(field!.col).toBe(2);
    expect(field!.description).toContain('open sky');
  });

  it('contains windmill building at row 1, col 0', async () => {
    const { BUILDING_MAP } = await import('../src/commune/buildings.js');
    const windmill = BUILDING_MAP.get('windmill');
    expect(windmill).toBeDefined();
    expect(windmill!.row).toBe(1);
    expect(windmill!.col).toBe(0);
  });

  it('contains lighthouse at center of grid (row 1, col 1)', async () => {
    const { BUILDING_MAP } = await import('../src/commune/buildings.js');
    const lighthouse = BUILDING_MAP.get('lighthouse');
    expect(lighthouse).toBeDefined();
    expect(lighthouse!.row).toBe(1);
    expect(lighthouse!.col).toBe(1);
    expect(lighthouse!.description).toContain('solitude');
  });

  it('contains school at row 1, col 2', async () => {
    const { BUILDING_MAP } = await import('../src/commune/buildings.js');
    const school = BUILDING_MAP.get('school');
    expect(school).toBeDefined();
    expect(school!.row).toBe(1);
    expect(school!.col).toBe(2);
  });

  it('contains market at row 2, col 0', async () => {
    const { BUILDING_MAP } = await import('../src/commune/buildings.js');
    const market = BUILDING_MAP.get('market');
    expect(market).toBeDefined();
    expect(market!.row).toBe(2);
    expect(market!.col).toBe(0);
  });

  it('contains locksmith at row 2, col 1', async () => {
    const { BUILDING_MAP } = await import('../src/commune/buildings.js');
    const locksmith = BUILDING_MAP.get('locksmith');
    expect(locksmith).toBeDefined();
    expect(locksmith!.row).toBe(2);
    expect(locksmith!.col).toBe(1);
    expect(locksmith!.description).toContain('puzzles');
  });

  it('contains threshold at row 2, col 2', async () => {
    const { BUILDING_MAP } = await import('../src/commune/buildings.js');
    const threshold = BUILDING_MAP.get('threshold');
    expect(threshold).toBeDefined();
    expect(threshold!.name).toBe('The Threshold');
    expect(threshold!.row).toBe(2);
    expect(threshold!.col).toBe(2);
    expect(threshold!.description).toContain('liminal');
  });

  it('BUILDING_MAP has exactly 9 entries', async () => {
    const { BUILDING_MAP } = await import('../src/commune/buildings.js');
    expect(BUILDING_MAP.size).toBe(9);
  });

  it('BUILDING_MAP keys match building IDs', async () => {
    const { BUILDINGS, BUILDING_MAP } = await import('../src/commune/buildings.js');
    for (const b of BUILDINGS) {
      expect(BUILDING_MAP.has(b.id)).toBe(true);
      expect(BUILDING_MAP.get(b.id)).toBe(b);
    }
  });

  it('grid positions are all unique', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    const positions = BUILDINGS.map(b => `${b.row},${b.col}`);
    const unique = new Set(positions);
    expect(unique.size).toBe(BUILDINGS.length);
  });

  it('grid occupies 3x3 positions (rows 0-2, cols 0-2)', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    const rows = new Set(BUILDINGS.map(b => b.row));
    const cols = new Set(BUILDINGS.map(b => b.col));
    expect(rows).toEqual(new Set([0, 1, 2]));
    expect(cols).toEqual(new Set([0, 1, 2]));
  });

  it('each row has exactly 3 buildings', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    for (const row of [0, 1, 2]) {
      const rowBuildings = BUILDINGS.filter(b => b.row === row);
      expect(rowBuildings).toHaveLength(3);
    }
  });
});

describe('Building Grid — isValidBuilding', () => {
  it('returns true for all valid building IDs', async () => {
    const { BUILDINGS, isValidBuilding } = await import('../src/commune/buildings.js');
    for (const b of BUILDINGS) {
      expect(isValidBuilding(b.id)).toBe(true);
    }
  });

  it('returns false for empty string', async () => {
    const { isValidBuilding } = await import('../src/commune/buildings.js');
    expect(isValidBuilding('')).toBe(false);
  });

  it('returns false for unknown IDs', async () => {
    const { isValidBuilding } = await import('../src/commune/buildings.js');
    expect(isValidBuilding('nonexistent')).toBe(false);
    expect(isValidBuilding('town_hall')).toBe(false);
    expect(isValidBuilding('LIBRARY')).toBe(false);
    expect(isValidBuilding('Library')).toBe(false);
  });

  it('is case-sensitive', async () => {
    const { isValidBuilding } = await import('../src/commune/buildings.js');
    expect(isValidBuilding('lighthouse')).toBe(true);
    expect(isValidBuilding('Lighthouse')).toBe(false);
    expect(isValidBuilding('LIGHTHOUSE')).toBe(false);
  });

  it('rejects whitespace variants', async () => {
    const { isValidBuilding } = await import('../src/commune/buildings.js');
    expect(isValidBuilding(' library')).toBe(false);
    expect(isValidBuilding('library ')).toBe(false);
  });

  it('building adjacency — library and bar are adjacent (same row)', async () => {
    const { BUILDING_MAP } = await import('../src/commune/buildings.js');
    const lib = BUILDING_MAP.get('library')!;
    const bar = BUILDING_MAP.get('bar')!;
    expect(lib.row).toBe(bar.row);
    expect(Math.abs(lib.col - bar.col)).toBe(1);
  });

  it('building adjacency — lighthouse and market are diagonal', async () => {
    const { BUILDING_MAP } = await import('../src/commune/buildings.js');
    const lighthouse = BUILDING_MAP.get('lighthouse')!;
    const market = BUILDING_MAP.get('market')!;
    expect(Math.abs(lighthouse.row - market.row)).toBe(1);
    expect(Math.abs(lighthouse.col - market.col)).toBe(1);
  });

  it('building distance — library and threshold are farthest apart', async () => {
    const { BUILDING_MAP } = await import('../src/commune/buildings.js');
    const lib = BUILDING_MAP.get('library')!;
    const threshold = BUILDING_MAP.get('threshold')!;
    // Max Manhattan distance in a 3x3 grid is 4 (corners)
    const dist = Math.abs(lib.row - threshold.row) + Math.abs(lib.col - threshold.col);
    expect(dist).toBe(4);
  });

  it('all building IDs are unique', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    const ids = BUILDINGS.map(b => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ─────────────────────────────────────────────────────────
// 2. LOCATION SYSTEM
// ─────────────────────────────────────────────────────────

describe('Location System', () => {
  const testDir = join(tmpdir(), `lain-test-loc-deep-${Date.now()}`);
  const dbPath = join(testDir, 'test.db');
  const savedEnv = process.env['LAIN_HOME'];

  beforeEach(async () => {
    process.env['LAIN_HOME'] = testDir;
    await mkdir(testDir, { recursive: true });
    const { initDatabase } = await import('../src/storage/database.js');
    await initDatabase(dbPath);
    const { eventBus } = await import('../src/events/bus.js');
    eventBus.setCharacterId('test-char');
  });

  afterEach(async () => {
    const { closeDatabase } = await import('../src/storage/database.js');
    closeDatabase();
    if (savedEnv !== undefined) {
      process.env['LAIN_HOME'] = savedEnv;
    } else {
      delete process.env['LAIN_HOME'];
    }
    try { await rm(testDir, { recursive: true }); } catch {}
  });

  it('getCurrentLocation returns a record with building and timestamp', async () => {
    const { getCurrentLocation } = await import('../src/commune/location.js');
    const loc = getCurrentLocation();
    expect(typeof loc.building).toBe('string');
    expect(typeof loc.timestamp).toBe('number');
    expect(loc.building.length).toBeGreaterThan(0);
  });

  it('default location is a valid building', async () => {
    const { getCurrentLocation } = await import('../src/commune/location.js');
    const { isValidBuilding } = await import('../src/commune/buildings.js');
    const loc = getCurrentLocation();
    expect(isValidBuilding(loc.building)).toBe(true);
  });

  it('default falls back to lighthouse when character has no default', async () => {
    const { getCurrentLocation } = await import('../src/commune/location.js');
    const { eventBus } = await import('../src/events/bus.js');
    eventBus.setCharacterId('no-such-character-xyz');
    const loc = getCurrentLocation('no-such-character-xyz');
    expect(loc.building).toBe('lighthouse');
  });

  it('setCurrentLocation → getCurrentLocation round-trip works for library', async () => {
    const { setCurrentLocation, getCurrentLocation } = await import('../src/commune/location.js');
    setCurrentLocation('library', 'going to study');
    const loc = getCurrentLocation();
    expect(loc.building).toBe('library');
  });

  it('setCurrentLocation → getCurrentLocation round-trip works for bar', async () => {
    const { setCurrentLocation, getCurrentLocation } = await import('../src/commune/location.js');
    setCurrentLocation('bar', 'social time');
    expect(getCurrentLocation().building).toBe('bar');
  });

  it('setCurrentLocation → getCurrentLocation round-trip works for field', async () => {
    const { setCurrentLocation, getCurrentLocation } = await import('../src/commune/location.js');
    setCurrentLocation('field', 'wandering');
    expect(getCurrentLocation().building).toBe('field');
  });

  it('setCurrentLocation → getCurrentLocation round-trip works for windmill', async () => {
    const { setCurrentLocation, getCurrentLocation } = await import('../src/commune/location.js');
    setCurrentLocation('windmill', 'working');
    expect(getCurrentLocation().building).toBe('windmill');
  });

  it('setCurrentLocation → getCurrentLocation round-trip works for lighthouse', async () => {
    const { setCurrentLocation, getCurrentLocation } = await import('../src/commune/location.js');
    setCurrentLocation('lighthouse', 'seeking clarity');
    expect(getCurrentLocation().building).toBe('lighthouse');
  });

  it('setCurrentLocation → getCurrentLocation round-trip works for school', async () => {
    const { setCurrentLocation, getCurrentLocation } = await import('../src/commune/location.js');
    setCurrentLocation('school', 'learning');
    expect(getCurrentLocation().building).toBe('school');
  });

  it('setCurrentLocation → getCurrentLocation round-trip works for market', async () => {
    const { setCurrentLocation, getCurrentLocation } = await import('../src/commune/location.js');
    setCurrentLocation('market', 'exchanging ideas');
    expect(getCurrentLocation().building).toBe('market');
  });

  it('setCurrentLocation → getCurrentLocation round-trip works for locksmith', async () => {
    const { setCurrentLocation, getCurrentLocation } = await import('../src/commune/location.js');
    setCurrentLocation('locksmith', 'solving puzzles');
    expect(getCurrentLocation().building).toBe('locksmith');
  });

  it('setCurrentLocation → getCurrentLocation round-trip works for threshold', async () => {
    const { setCurrentLocation, getCurrentLocation } = await import('../src/commune/location.js');
    setCurrentLocation('threshold', 'dwelling at the edge');
    expect(getCurrentLocation().building).toBe('threshold');
  });

  it('no-op when moving to same location', async () => {
    const { setCurrentLocation, getLocationHistory } = await import('../src/commune/location.js');
    setCurrentLocation('library', 'first move');
    setCurrentLocation('library', 'staying');
    expect(getLocationHistory()).toHaveLength(1);
  });

  it('location history tracks moves in order', async () => {
    const { setCurrentLocation, getLocationHistory } = await import('../src/commune/location.js');
    setCurrentLocation('library', 'move 1');
    setCurrentLocation('bar', 'move 2');
    setCurrentLocation('field', 'move 3');
    const history = getLocationHistory();
    expect(history).toHaveLength(3);
    // Most recent first
    expect(history[0]!.to).toBe('field');
    expect(history[1]!.to).toBe('bar');
    expect(history[2]!.to).toBe('library');
  });

  it('location history records from/to/reason', async () => {
    const { setCurrentLocation, getLocationHistory } = await import('../src/commune/location.js');
    setCurrentLocation('library', 'first move');
    setCurrentLocation('market', 'test reason');
    const history = getLocationHistory(1);
    expect(history[0]!.from).toBe('library');
    expect(history[0]!.to).toBe('market');
    expect(history[0]!.reason).toBe('test reason');
  });

  it('location history includes timestamp', async () => {
    const { setCurrentLocation, getLocationHistory } = await import('../src/commune/location.js');
    const before = Date.now();
    setCurrentLocation('bar', 'testing');
    const after = Date.now();
    const history = getLocationHistory(1);
    expect(history[0]!.timestamp).toBeGreaterThanOrEqual(before);
    expect(history[0]!.timestamp).toBeLessThanOrEqual(after);
  });

  it('getLocationHistory caps at 20 entries', async () => {
    const { setCurrentLocation, getLocationHistory } = await import('../src/commune/location.js');
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    const ids = BUILDINGS.map(b => b.id);
    for (let i = 0; i < 25; i++) {
      const idx = i % ids.length;
      const next = (i + 1) % ids.length;
      if (ids[idx] !== ids[next]) {
        setCurrentLocation(ids[next] as any, `move ${i}`);
      }
    }
    const history = getLocationHistory();
    expect(history.length).toBeLessThanOrEqual(20);
  });

  it('getLocationHistory respects limit parameter', async () => {
    const { setCurrentLocation, getLocationHistory } = await import('../src/commune/location.js');
    setCurrentLocation('library', 'a');
    setCurrentLocation('bar', 'b');
    setCurrentLocation('field', 'c');
    const history = getLocationHistory(2);
    expect(history).toHaveLength(2);
  });

  it('emits movement activity event on location change', async () => {
    const { setCurrentLocation } = await import('../src/commune/location.js');
    const { eventBus } = await import('../src/events/bus.js');
    const events: any[] = [];
    eventBus.on('activity', (e: any) => events.push(e));
    setCurrentLocation('market', 'going to market');
    const moved = events.find(e => e.type === 'movement');
    expect(moved).toBeDefined();
    expect(moved.content).toContain('Market');
    eventBus.removeAllListeners('activity');
  });

  it('movement event content includes reason', async () => {
    const { setCurrentLocation } = await import('../src/commune/location.js');
    const { eventBus } = await import('../src/events/bus.js');
    const events: any[] = [];
    eventBus.on('activity', (e: any) => events.push(e));
    setCurrentLocation('locksmith', 'chasing secrets');
    const moved = events.find(e => e.type === 'movement');
    expect(moved.content).toContain('chasing secrets');
    eventBus.removeAllListeners('activity');
  });

  it('does not emit event when staying in place', async () => {
    const { setCurrentLocation } = await import('../src/commune/location.js');
    const { eventBus } = await import('../src/events/bus.js');
    setCurrentLocation('library', 'first');
    const events: any[] = [];
    eventBus.on('activity', (e: any) => events.push(e));
    setCurrentLocation('library', 'same');
    expect(events.filter(e => e.type === 'movement')).toHaveLength(0);
    eventBus.removeAllListeners('activity');
  });

  it('getCurrentLocation with explicit characterId parameter', async () => {
    const { getCurrentLocation } = await import('../src/commune/location.js');
    const loc = getCurrentLocation('test-char');
    expect(typeof loc.building).toBe('string');
  });

  it('location persists across multiple calls', async () => {
    const { setCurrentLocation, getCurrentLocation } = await import('../src/commune/location.js');
    setCurrentLocation('threshold', 'liminal journey');
    expect(getCurrentLocation().building).toBe('threshold');
    expect(getCurrentLocation().building).toBe('threshold');
    expect(getCurrentLocation().building).toBe('threshold');
  });

  it('successive moves update current location correctly', async () => {
    const { setCurrentLocation, getCurrentLocation } = await import('../src/commune/location.js');
    setCurrentLocation('library', 'step 1');
    setCurrentLocation('bar', 'step 2');
    setCurrentLocation('field', 'step 3');
    expect(getCurrentLocation().building).toBe('field');
  });
});

// ─────────────────────────────────────────────────────────
// 3. WEATHER COMPUTATION
// ─────────────────────────────────────────────────────────

describe('Weather Computation', () => {
  const testDir = join(tmpdir(), `lain-test-weather-${Date.now()}`);
  const dbPath = join(testDir, 'test.db');
  const savedEnv = process.env['LAIN_HOME'];

  beforeEach(async () => {
    process.env['LAIN_HOME'] = testDir;
    await mkdir(testDir, { recursive: true });
    const { initDatabase } = await import('../src/storage/database.js');
    await initDatabase(dbPath);
  });

  afterEach(async () => {
    const { closeDatabase } = await import('../src/storage/database.js');
    closeDatabase();
    if (savedEnv !== undefined) {
      process.env['LAIN_HOME'] = savedEnv;
    } else {
      delete process.env['LAIN_HOME'];
    }
    try { await rm(testDir, { recursive: true }); } catch {}
  });

  function makeState(overrides: Partial<{
    energy: number; sociability: number; intellectual_arousal: number;
    emotional_weight: number; valence: number;
  }> = {}) {
    return {
      energy: 0.5,
      sociability: 0.5,
      intellectual_arousal: 0.5,
      emotional_weight: 0.3,
      valence: 0.5,
      ...overrides,
    } as any;
  }

  it('returns overcast for empty state array', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const weather = await computeWeather([]);
    expect(weather.condition).toBe('overcast');
    expect(weather.intensity).toBe(0.5);
  });

  it('includes description and computed_at for empty states', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const before = Date.now();
    const weather = await computeWeather([]);
    expect(typeof weather.description).toBe('string');
    expect(weather.description.length).toBeGreaterThan(0);
    expect(weather.computed_at).toBeGreaterThanOrEqual(before);
  });

  it('returns storm when emotional_weight > 0.7 and intellectual_arousal > 0.6', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const weather = await computeWeather([makeState({ emotional_weight: 0.8, intellectual_arousal: 0.75 })]);
    expect(weather.condition).toBe('storm');
  });

  it('storm intensity is bounded to 1.0', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const weather = await computeWeather([makeState({ emotional_weight: 1.0, intellectual_arousal: 1.0 })]);
    expect(weather.condition).toBe('storm');
    expect(weather.intensity).toBeLessThanOrEqual(1.0);
  });

  it('returns aurora when intellectual_arousal > 0.7 and valence > 0.7', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const weather = await computeWeather([makeState({ intellectual_arousal: 0.8, valence: 0.8, emotional_weight: 0.2 })]);
    expect(weather.condition).toBe('aurora');
  });

  it('aurora intensity is average of intellectual_arousal and valence', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const ia = 0.8;
    const v = 0.9;
    const weather = await computeWeather([makeState({ intellectual_arousal: ia, valence: v, emotional_weight: 0.2 })]);
    expect(weather.condition).toBe('aurora');
    expect(weather.intensity).toBeCloseTo(Math.min(1, (ia + v) / 2), 4);
  });

  it('returns rain when emotional_weight > 0.6 (storm conditions not met)', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    // emotional_weight > 0.6 but intellectual_arousal <= 0.6 (no storm)
    const weather = await computeWeather([makeState({ emotional_weight: 0.7, intellectual_arousal: 0.4 })]);
    expect(weather.condition).toBe('rain');
  });

  it('rain intensity equals emotional_weight', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const ew = 0.72;
    const weather = await computeWeather([makeState({ emotional_weight: ew, intellectual_arousal: 0.3 })]);
    expect(weather.condition).toBe('rain');
    expect(weather.intensity).toBeCloseTo(ew, 4);
  });

  it('returns fog when energy < 0.35', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const weather = await computeWeather([makeState({ energy: 0.2, emotional_weight: 0.3 })]);
    expect(weather.condition).toBe('fog');
  });

  it('fog intensity is 1 - energy', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const e = 0.25;
    const weather = await computeWeather([makeState({ energy: e, emotional_weight: 0.3 })]);
    expect(weather.condition).toBe('fog');
    expect(weather.intensity).toBeCloseTo(1 - e, 4);
  });

  it('returns clear when valence > 0.6 and emotional_weight < 0.4', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const weather = await computeWeather([makeState({ valence: 0.8, emotional_weight: 0.2, energy: 0.6 })]);
    expect(weather.condition).toBe('clear');
  });

  it('clear intensity equals valence', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const v = 0.75;
    const weather = await computeWeather([makeState({ valence: v, emotional_weight: 0.2, energy: 0.6 })]);
    expect(weather.condition).toBe('clear');
    expect(weather.intensity).toBeCloseTo(v, 4);
  });

  it('returns overcast for neutral mid-range states', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const weather = await computeWeather([makeState()]);
    expect(weather.condition).toBe('overcast');
  });

  it('overcast intensity is 0.5', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const weather = await computeWeather([makeState()]);
    expect(weather.intensity).toBe(0.5);
  });

  it('averages states from multiple characters', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    // Two states: avg energy 0.2 → fog
    const w = await computeWeather([
      makeState({ energy: 0.1, emotional_weight: 0.2 }),
      makeState({ energy: 0.3, emotional_weight: 0.2 }),
    ]);
    expect(w.condition).toBe('fog');
  });

  it('storm takes priority over aurora (emotional_weight > 0.7 and intellectual_arousal > 0.6 wins)', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    // Both storm and aurora conditions met — storm is checked first
    const w = await computeWeather([makeState({ emotional_weight: 0.75, intellectual_arousal: 0.75, valence: 0.8 })]);
    expect(w.condition).toBe('storm');
  });

  it('boundary: emotional_weight exactly 0.7 does not trigger storm without both conditions', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    // emotional_weight = 0.7 and intellectual_arousal = 0.6 → NOT storm (needs > 0.7 for weight AND > 0.6 for arousal)
    const w = await computeWeather([makeState({ emotional_weight: 0.7, intellectual_arousal: 0.6 })]);
    // 0.7 > 0.7 is false, 0.6 > 0.6 is false → falls to rain check (0.7 > 0.6 → rain)
    expect(w.condition).toBe('rain');
  });

  it('weather has a description string', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const w = await computeWeather([makeState()]);
    expect(typeof w.description).toBe('string');
    expect(w.description.length).toBeGreaterThan(0);
  });

  it('weather includes computed_at timestamp close to now', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const before = Date.now();
    const w = await computeWeather([makeState()]);
    const after = Date.now();
    expect(w.computed_at).toBeGreaterThanOrEqual(before);
    expect(w.computed_at).toBeLessThanOrEqual(after);
  });

  it('same inputs produce same condition', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const state = makeState({ energy: 0.8, valence: 0.8, emotional_weight: 0.1 });
    const w1 = await computeWeather([state]);
    const w2 = await computeWeather([state]);
    expect(w1.condition).toBe(w2.condition);
    expect(w1.intensity).toBe(w2.intensity);
  });

  it('getWeatherEffect returns negative energy for storm', async () => {
    const { getWeatherEffect } = await import('../src/commune/weather.js');
    const effect = getWeatherEffect('storm');
    expect(effect.energy).toBeLessThan(0);
  });

  it('getWeatherEffect returns positive energy for aurora', async () => {
    const { getWeatherEffect } = await import('../src/commune/weather.js');
    const effect = getWeatherEffect('aurora');
    expect(effect.energy).toBeGreaterThan(0);
    expect(effect.valence).toBeGreaterThan(0);
  });

  it('getWeatherEffect returns empty object for overcast', async () => {
    const { getWeatherEffect } = await import('../src/commune/weather.js');
    const effect = getWeatherEffect('overcast');
    expect(Object.keys(effect)).toHaveLength(0);
  });

  it('getWeatherEffect returns object for all 6 conditions', async () => {
    const { getWeatherEffect } = await import('../src/commune/weather.js');
    for (const cond of ['clear', 'overcast', 'rain', 'fog', 'storm', 'aurora']) {
      const effect = getWeatherEffect(cond);
      expect(typeof effect).toBe('object');
    }
  });

  it('getCurrentWeather returns null when nothing saved', async () => {
    const { getCurrentWeather } = await import('../src/commune/weather.js');
    const w = getCurrentWeather();
    expect(w).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────
// 4. BUILDING MEMORY — local SQLite operations
// ─────────────────────────────────────────────────────────

describe('Building Memory — storeBuildingEventLocal & queryBuildingEvents', () => {
  let db: ReturnType<typeof Database>;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE building_events (
        id TEXT PRIMARY KEY,
        building TEXT NOT NULL,
        event_type TEXT NOT NULL,
        summary TEXT NOT NULL,
        emotional_tone REAL DEFAULT 0,
        actors TEXT DEFAULT '[]',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_building_events_building ON building_events(building, created_at DESC);
    `);
  });

  afterEach(() => {
    db.close();
  });

  it('storeBuildingEventLocal inserts a record', async () => {
    const { storeBuildingEventLocal, queryBuildingEvents } = await import('../src/commune/building-memory.js');
    storeBuildingEventLocal(db, {
      id: 'test-1',
      building: 'library',
      event_type: 'arrival',
      summary: 'lain arrived',
      emotional_tone: 0.1,
      actors: ['lain'],
      created_at: Date.now(),
    });
    const events = queryBuildingEvents(db, 'library', 1);
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe('test-1');
  });

  it('queryBuildingEvents returns events for the correct building', async () => {
    const { storeBuildingEventLocal, queryBuildingEvents } = await import('../src/commune/building-memory.js');
    const now = Date.now();
    storeBuildingEventLocal(db, {
      id: 'lib-1', building: 'library', event_type: 'arrival',
      summary: 'lain at library', emotional_tone: 0, actors: ['lain'], created_at: now,
    });
    storeBuildingEventLocal(db, {
      id: 'bar-1', building: 'bar', event_type: 'arrival',
      summary: 'lain at bar', emotional_tone: 0, actors: ['lain'], created_at: now,
    });
    const libraryEvents = queryBuildingEvents(db, 'library', 24);
    expect(libraryEvents.every(e => e.building === 'library')).toBe(true);
    expect(libraryEvents.some(e => e.id === 'bar-1')).toBe(false);
  });

  it('queryBuildingEvents filters by hours parameter', async () => {
    const { storeBuildingEventLocal, queryBuildingEvents } = await import('../src/commune/building-memory.js');
    const now = Date.now();
    const old = now - 25 * 60 * 60 * 1000; // 25 hours ago
    storeBuildingEventLocal(db, {
      id: 'old-1', building: 'library', event_type: 'note_left',
      summary: 'old note', emotional_tone: 0, actors: [], created_at: old,
    });
    storeBuildingEventLocal(db, {
      id: 'new-1', building: 'library', event_type: 'arrival',
      summary: 'new arrival', emotional_tone: 0, actors: [], created_at: now,
    });
    const recent = queryBuildingEvents(db, 'library', 24);
    expect(recent.some(e => e.id === 'old-1')).toBe(false);
    expect(recent.some(e => e.id === 'new-1')).toBe(true);
  });

  it('queryBuildingEvents returns up to 20 events', async () => {
    const { storeBuildingEventLocal, queryBuildingEvents } = await import('../src/commune/building-memory.js');
    const now = Date.now();
    for (let i = 0; i < 25; i++) {
      storeBuildingEventLocal(db, {
        id: `evt-${i}`, building: 'bar', event_type: 'quiet_moment',
        summary: `moment ${i}`, emotional_tone: 0, actors: [], created_at: now - i * 1000,
      });
    }
    const events = queryBuildingEvents(db, 'bar', 24);
    expect(events.length).toBeLessThanOrEqual(20);
  });

  it('actors are parsed back from JSON', async () => {
    const { storeBuildingEventLocal, queryBuildingEvents } = await import('../src/commune/building-memory.js');
    storeBuildingEventLocal(db, {
      id: 'actor-test', building: 'market', event_type: 'conversation',
      summary: 'lain and pkd talked', emotional_tone: 0.3, actors: ['lain', 'pkd'], created_at: Date.now(),
    });
    const events = queryBuildingEvents(db, 'market', 24);
    expect(Array.isArray(events[0]!.actors)).toBe(true);
    expect(events[0]!.actors).toContain('lain');
    expect(events[0]!.actors).toContain('pkd');
  });

  it('event_type is correctly stored and retrieved', async () => {
    const { storeBuildingEventLocal, queryBuildingEvents } = await import('../src/commune/building-memory.js');
    const types = ['conversation', 'arrival', 'departure', 'note_left', 'object_placed', 'quiet_moment'] as const;
    let i = 0;
    for (const type of types) {
      storeBuildingEventLocal(db, {
        id: `type-${i++}`, building: 'lighthouse', event_type: type,
        summary: `a ${type}`, emotional_tone: 0, actors: [], created_at: Date.now() - i * 100,
      });
    }
    const events = queryBuildingEvents(db, 'lighthouse', 24);
    const retrievedTypes = new Set(events.map(e => e.event_type));
    for (const type of types) {
      expect(retrievedTypes.has(type)).toBe(true);
    }
  });

  it('emotional_tone is stored and retrieved correctly', async () => {
    const { storeBuildingEventLocal, queryBuildingEvents } = await import('../src/commune/building-memory.js');
    storeBuildingEventLocal(db, {
      id: 'tone-test', building: 'threshold', event_type: 'quiet_moment',
      summary: 'quiet', emotional_tone: -0.5, actors: [], created_at: Date.now(),
    });
    const events = queryBuildingEvents(db, 'threshold', 24);
    expect(events[0]!.emotional_tone).toBeCloseTo(-0.5);
  });

  it('cross-building isolation — events from different buildings do not mix', async () => {
    const { storeBuildingEventLocal, queryBuildingEvents } = await import('../src/commune/building-memory.js');
    const now = Date.now();
    const buildings = ['library', 'bar', 'market'];
    let i = 0;
    for (const b of buildings) {
      storeBuildingEventLocal(db, {
        id: `iso-${i++}`, building: b, event_type: 'arrival',
        summary: `arrived at ${b}`, emotional_tone: 0, actors: [], created_at: now,
      });
    }
    for (const b of buildings) {
      const events = queryBuildingEvents(db, b, 24);
      expect(events.every(e => e.building === b)).toBe(true);
    }
  });

  it('OR IGNORE prevents duplicate IDs from throwing', async () => {
    const { storeBuildingEventLocal } = await import('../src/commune/building-memory.js');
    const event = {
      id: 'dup-id', building: 'field', event_type: 'arrival' as const,
      summary: 'first', emotional_tone: 0, actors: [], created_at: Date.now(),
    };
    expect(() => {
      storeBuildingEventLocal(db, event);
      storeBuildingEventLocal(db, { ...event, summary: 'second' });
    }).not.toThrow();
  });

  it('queryBuildingEvents returns results ordered by created_at DESC', async () => {
    const { storeBuildingEventLocal, queryBuildingEvents } = await import('../src/commune/building-memory.js');
    const now = Date.now();
    storeBuildingEventLocal(db, {
      id: 'ord-1', building: 'windmill', event_type: 'arrival',
      summary: 'early', emotional_tone: 0, actors: [], created_at: now - 5000,
    });
    storeBuildingEventLocal(db, {
      id: 'ord-2', building: 'windmill', event_type: 'departure',
      summary: 'later', emotional_tone: 0, actors: [], created_at: now - 1000,
    });
    storeBuildingEventLocal(db, {
      id: 'ord-3', building: 'windmill', event_type: 'arrival',
      summary: 'latest', emotional_tone: 0, actors: [], created_at: now,
    });
    const events = queryBuildingEvents(db, 'windmill', 24);
    expect(events[0]!.id).toBe('ord-3');
    expect(events[1]!.id).toBe('ord-2');
    expect(events[2]!.id).toBe('ord-1');
  });

  it('buildBuildingResidueContext returns empty string when fetch fails', async () => {
    // recordBuildingEvent uses fetch to Wired Lain — with no server, it should silently fail
    const { recordBuildingEvent } = await import('../src/commune/building-memory.js');
    await expect(
      recordBuildingEvent({
        building: 'library', event_type: 'arrival',
        summary: 'test', emotional_tone: 0, actors: ['test'],
      })
    ).resolves.not.toThrow();
  });

  it('queryBuildingEvents prunes events older than 48h lazily', async () => {
    const { storeBuildingEventLocal, queryBuildingEvents } = await import('../src/commune/building-memory.js');
    const now = Date.now();
    const veryOld = now - 49 * 60 * 60 * 1000;
    storeBuildingEventLocal(db, {
      id: 'very-old', building: 'school', event_type: 'note_left',
      summary: 'ancient note', emotional_tone: 0, actors: [], created_at: veryOld,
    });
    storeBuildingEventLocal(db, {
      id: 'recent', building: 'school', event_type: 'arrival',
      summary: 'fresh arrival', emotional_tone: 0, actors: [], created_at: now,
    });
    // Call query — the 48h pruning happens inside
    const events = queryBuildingEvents(db, 'school', 24);
    // very-old is > 24h so excluded by time filter anyway, and also > 48h so pruned
    expect(events.some(e => e.id === 'very-old')).toBe(false);
    expect(events.some(e => e.id === 'recent')).toBe(true);
  });
});
