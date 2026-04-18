/**
 * Commune subsystem tests — buildings, location, weather.
 *
 * Covers the spatial grid, location state management, and
 * weather condition computation with 50+ tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
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

// ─────────────────────────────────────────────────────────
// 1. BUILDINGS — 3x3 spatial grid definitions
// ─────────────────────────────────────────────────────────
describe('Buildings', () => {
  it('BUILDINGS has exactly 9 entries', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    expect(BUILDINGS).toHaveLength(9);
  });

  it('each building has all required fields', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    for (const b of BUILDINGS) {
      expect(b).toHaveProperty('id');
      expect(b).toHaveProperty('name');
      expect(b).toHaveProperty('emoji');
      expect(b).toHaveProperty('row');
      expect(b).toHaveProperty('col');
      expect(b).toHaveProperty('description');
    }
  });

  it('each building id is a non-empty string', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    for (const b of BUILDINGS) {
      expect(typeof b.id).toBe('string');
      expect(b.id.length).toBeGreaterThan(0);
    }
  });

  it('each building name is a non-empty string', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    for (const b of BUILDINGS) {
      expect(typeof b.name).toBe('string');
      expect(b.name.length).toBeGreaterThan(0);
    }
  });

  it('each building emoji is a non-empty string', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    for (const b of BUILDINGS) {
      expect(typeof b.emoji).toBe('string');
      expect(b.emoji.length).toBeGreaterThan(0);
    }
  });

  it('each building description is a non-empty string', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    for (const b of BUILDINGS) {
      expect(typeof b.description).toBe('string');
      expect(b.description.length).toBeGreaterThan(0);
    }
  });

  it('no duplicate building IDs', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    const ids = BUILDINGS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('no duplicate row/col pairs', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    const coords = BUILDINGS.map((b) => `${b.row},${b.col}`);
    expect(new Set(coords).size).toBe(coords.length);
  });

  it('grid is exactly 3x3 with rows 0-2 and cols 0-2', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    const rows = new Set(BUILDINGS.map((b) => b.row));
    const cols = new Set(BUILDINGS.map((b) => b.col));
    expect(rows).toEqual(new Set([0, 1, 2]));
    expect(cols).toEqual(new Set([0, 1, 2]));
  });

  it('all expected building IDs are present', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    const ids = BUILDINGS.map((b) => b.id);
    const expected = [
      'library', 'bar', 'field',
      'windmill', 'lighthouse', 'school',
      'market', 'locksmith', 'threshold',
    ];
    for (const id of expected) {
      expect(ids).toContain(id);
    }
  });

  it('row 0 buildings are library, bar, field', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    const row0 = BUILDINGS.filter((b) => b.row === 0).map((b) => b.id).sort();
    expect(row0).toEqual(['bar', 'field', 'library']);
  });

  it('row 1 buildings are windmill, lighthouse, school', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    const row1 = BUILDINGS.filter((b) => b.row === 1).map((b) => b.id).sort();
    expect(row1).toEqual(['lighthouse', 'school', 'windmill']);
  });

  it('row 2 buildings are market, locksmith, threshold', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    const row2 = BUILDINGS.filter((b) => b.row === 2).map((b) => b.id).sort();
    expect(row2).toEqual(['locksmith', 'market', 'threshold']);
  });

  it('BUILDING_MAP contains all 9 buildings by ID', async () => {
    const { BUILDINGS, BUILDING_MAP } = await import('../src/commune/buildings.js');
    expect(BUILDING_MAP.size).toBe(9);
    for (const b of BUILDINGS) {
      expect(BUILDING_MAP.has(b.id)).toBe(true);
      expect(BUILDING_MAP.get(b.id)).toBe(b);
    }
  });

  it('isValidBuilding returns true for all valid building IDs', async () => {
    const { BUILDINGS, isValidBuilding } = await import('../src/commune/buildings.js');
    for (const b of BUILDINGS) {
      expect(isValidBuilding(b.id)).toBe(true);
    }
  });

  it('isValidBuilding returns false for empty string', async () => {
    const { isValidBuilding } = await import('../src/commune/buildings.js');
    expect(isValidBuilding('')).toBe(false);
  });

  it('isValidBuilding returns false for nonexistent building', async () => {
    const { isValidBuilding } = await import('../src/commune/buildings.js');
    expect(isValidBuilding('nonexistent')).toBe(false);
  });

  it('isValidBuilding returns false for random strings', async () => {
    const { isValidBuilding } = await import('../src/commune/buildings.js');
    expect(isValidBuilding('castle')).toBe(false);
    expect(isValidBuilding('tavern')).toBe(false);
    expect(isValidBuilding('LIBRARY')).toBe(false);
    expect(isValidBuilding('Library')).toBe(false);
    expect(isValidBuilding('123')).toBe(false);
  });

  it('building rows are integers 0-2', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    for (const b of BUILDINGS) {
      expect(Number.isInteger(b.row)).toBe(true);
      expect(b.row).toBeGreaterThanOrEqual(0);
      expect(b.row).toBeLessThanOrEqual(2);
    }
  });

  it('building cols are integers 0-2', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    for (const b of BUILDINGS) {
      expect(Number.isInteger(b.col)).toBe(true);
      expect(b.col).toBeGreaterThanOrEqual(0);
      expect(b.col).toBeLessThanOrEqual(2);
    }
  });

  it('lighthouse is the center building at (1,1)', async () => {
    const { BUILDING_MAP } = await import('../src/commune/buildings.js');
    const lighthouse = BUILDING_MAP.get('lighthouse');
    expect(lighthouse).toBeDefined();
    expect(lighthouse!.row).toBe(1);
    expect(lighthouse!.col).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────
// 2. BUILDINGS — Source-level structural tests
// ─────────────────────────────────────────────────────────
describe('Buildings source structure', () => {
  const src = readFileSync(
    join(__dirname, '..', 'src', 'commune', 'buildings.ts'),
    'utf-8',
  );

  it('exports BUILDINGS array', () => {
    expect(src).toContain('export const BUILDINGS');
  });

  it('exports BUILDING_MAP', () => {
    expect(src).toContain('export const BUILDING_MAP');
  });

  it('exports isValidBuilding function', () => {
    expect(src).toContain('export function isValidBuilding');
  });

  it('exports getDefaultLocationsFromManifest function', () => {
    expect(src).toContain('export function getDefaultLocationsFromManifest');
  });

  it('exports Building interface', () => {
    expect(src).toContain('export interface Building');
  });

  it('exports BuildingId type', () => {
    expect(src).toContain('export type BuildingId');
  });

  it('BUILDINGS is marked readonly', () => {
    expect(src).toContain('as const');
  });
});

// ─────────────────────────────────────────────────────────
// 3. WEATHER — getWeatherEffect (pure function, no DB needed)
// ─────────────────────────────────────────────────────────
describe('Weather — getWeatherEffect', () => {
  it('returns effects for storm condition', async () => {
    const { getWeatherEffect } = await import('../src/commune/weather.js');
    const effect = getWeatherEffect('storm');
    expect(effect).toHaveProperty('energy');
    expect(effect).toHaveProperty('intellectual_arousal');
  });

  it('returns effects for rain condition', async () => {
    const { getWeatherEffect } = await import('../src/commune/weather.js');
    const effect = getWeatherEffect('rain');
    expect(effect).toHaveProperty('emotional_weight');
    expect(effect).toHaveProperty('sociability');
  });

  it('returns effects for fog condition', async () => {
    const { getWeatherEffect } = await import('../src/commune/weather.js');
    const effect = getWeatherEffect('fog');
    expect(effect).toHaveProperty('energy');
    expect(effect).toHaveProperty('valence');
  });

  it('returns effects for aurora condition', async () => {
    const { getWeatherEffect } = await import('../src/commune/weather.js');
    const effect = getWeatherEffect('aurora');
    expect(effect).toHaveProperty('energy');
    expect(effect).toHaveProperty('valence');
    expect(effect).toHaveProperty('sociability');
  });

  it('returns effects for clear condition', async () => {
    const { getWeatherEffect } = await import('../src/commune/weather.js');
    const effect = getWeatherEffect('clear');
    expect(effect).toHaveProperty('energy');
  });

  it('returns empty object for overcast condition', async () => {
    const { getWeatherEffect } = await import('../src/commune/weather.js');
    const effect = getWeatherEffect('overcast');
    expect(Object.keys(effect)).toHaveLength(0);
  });

  it('returns empty object for unknown conditions', async () => {
    const { getWeatherEffect } = await import('../src/commune/weather.js');
    expect(Object.keys(getWeatherEffect('blizzard'))).toHaveLength(0);
    expect(Object.keys(getWeatherEffect(''))).toHaveLength(0);
    expect(Object.keys(getWeatherEffect('sunny'))).toHaveLength(0);
  });

  it('storm effect values are in range [-1, 1]', async () => {
    const { getWeatherEffect } = await import('../src/commune/weather.js');
    const effect = getWeatherEffect('storm');
    for (const val of Object.values(effect)) {
      if (typeof val === 'number') {
        expect(Math.abs(val)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('rain effect values are in range [-1, 1]', async () => {
    const { getWeatherEffect } = await import('../src/commune/weather.js');
    const effect = getWeatherEffect('rain');
    for (const val of Object.values(effect)) {
      if (typeof val === 'number') {
        expect(Math.abs(val)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('fog effect values are in range [-1, 1]', async () => {
    const { getWeatherEffect } = await import('../src/commune/weather.js');
    const effect = getWeatherEffect('fog');
    for (const val of Object.values(effect)) {
      if (typeof val === 'number') {
        expect(Math.abs(val)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('aurora effect values are in range [-1, 1]', async () => {
    const { getWeatherEffect } = await import('../src/commune/weather.js');
    const effect = getWeatherEffect('aurora');
    for (const val of Object.values(effect)) {
      if (typeof val === 'number') {
        expect(Math.abs(val)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('clear effect values are in range [-1, 1]', async () => {
    const { getWeatherEffect } = await import('../src/commune/weather.js');
    const effect = getWeatherEffect('clear');
    for (const val of Object.values(effect)) {
      if (typeof val === 'number') {
        expect(Math.abs(val)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('storm reduces energy', async () => {
    const { getWeatherEffect } = await import('../src/commune/weather.js');
    const effect = getWeatherEffect('storm');
    expect(effect.energy).toBeDefined();
    expect(effect.energy!).toBeLessThan(0);
  });

  it('aurora increases energy, valence, and sociability', async () => {
    const { getWeatherEffect } = await import('../src/commune/weather.js');
    const effect = getWeatherEffect('aurora');
    expect(effect.energy!).toBeGreaterThan(0);
    expect(effect.valence!).toBeGreaterThan(0);
    expect(effect.sociability!).toBeGreaterThan(0);
  });

  it('rain increases emotional weight', async () => {
    const { getWeatherEffect } = await import('../src/commune/weather.js');
    const effect = getWeatherEffect('rain');
    expect(effect.emotional_weight!).toBeGreaterThan(0);
  });

  it('rain decreases sociability', async () => {
    const { getWeatherEffect } = await import('../src/commune/weather.js');
    const effect = getWeatherEffect('rain');
    expect(effect.sociability!).toBeLessThan(0);
  });

  it('fog decreases energy', async () => {
    const { getWeatherEffect } = await import('../src/commune/weather.js');
    const effect = getWeatherEffect('fog');
    expect(effect.energy!).toBeLessThan(0);
  });

  it('clear increases energy', async () => {
    const { getWeatherEffect } = await import('../src/commune/weather.js');
    const effect = getWeatherEffect('clear');
    expect(effect.energy!).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────
// 4. WEATHER — computeWeather (needs DB for getMeta/setMeta)
// ─────────────────────────────────────────────────────────
describe('Weather — computeWeather', () => {
  const testDir = join(tmpdir(), `lain-test-weather-${Date.now()}`);
  const dbPath = join(testDir, 'test.db');
  const originalEnv = process.env['LAIN_HOME'];

  beforeEach(async () => {
    vi.resetModules();
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
    try {
      await rm(testDir, { recursive: true });
    } catch {}
  });

  it('returns overcast for empty states array', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const weather = await computeWeather([]);
    expect(weather.condition).toBe('overcast');
    expect(weather.intensity).toBe(0.5);
    expect(weather.description).toBe('quiet day in the town');
    expect(weather.computed_at).toBeGreaterThan(0);
  });

  it('returns storm when emotional_weight and intellectual_arousal are high', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const state = {
      energy: 0.5,
      sociability: 0.5,
      intellectual_arousal: 0.8,
      emotional_weight: 0.8,
      valence: 0.5,
      primary_color: 'intense',
      updated_at: Date.now(),
    };
    const weather = await computeWeather([state]);
    expect(weather.condition).toBe('storm');
    expect(weather.intensity).toBeGreaterThan(0);
    expect(weather.intensity).toBeLessThanOrEqual(1);
  });

  it('returns aurora when intellectual_arousal and valence are high', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const state = {
      energy: 0.5,
      sociability: 0.5,
      intellectual_arousal: 0.8,
      emotional_weight: 0.3,
      valence: 0.8,
      primary_color: 'luminous',
      updated_at: Date.now(),
    };
    const weather = await computeWeather([state]);
    expect(weather.condition).toBe('aurora');
  });

  it('returns rain when emotional_weight is moderately high', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const state = {
      energy: 0.5,
      sociability: 0.5,
      intellectual_arousal: 0.3,
      emotional_weight: 0.65,
      valence: 0.5,
      primary_color: 'heavy',
      updated_at: Date.now(),
    };
    const weather = await computeWeather([state]);
    expect(weather.condition).toBe('rain');
  });

  it('returns fog when energy is low', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const state = {
      energy: 0.2,
      sociability: 0.5,
      intellectual_arousal: 0.3,
      emotional_weight: 0.3,
      valence: 0.4,
      primary_color: 'dim',
      updated_at: Date.now(),
    };
    const weather = await computeWeather([state]);
    expect(weather.condition).toBe('fog');
  });

  it('returns clear when valence is high and emotional_weight is low', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const state = {
      energy: 0.6,
      sociability: 0.5,
      intellectual_arousal: 0.4,
      emotional_weight: 0.3,
      valence: 0.7,
      primary_color: 'bright',
      updated_at: Date.now(),
    };
    const weather = await computeWeather([state]);
    expect(weather.condition).toBe('clear');
  });

  it('returns overcast as the fallback condition', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const state = {
      energy: 0.5,
      sociability: 0.5,
      intellectual_arousal: 0.5,
      emotional_weight: 0.5,
      valence: 0.5,
      primary_color: 'neutral',
      updated_at: Date.now(),
    };
    const weather = await computeWeather([state]);
    expect(weather.condition).toBe('overcast');
    expect(weather.intensity).toBe(0.5);
  });

  it('averages multiple states correctly for rain', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    // Two states: average emotional_weight = 0.65 → rain
    const states = [
      {
        energy: 0.5, sociability: 0.5, intellectual_arousal: 0.3,
        emotional_weight: 0.9, valence: 0.5, primary_color: 'heavy', updated_at: Date.now(),
      },
      {
        energy: 0.5, sociability: 0.5, intellectual_arousal: 0.3,
        emotional_weight: 0.4, valence: 0.5, primary_color: 'light', updated_at: Date.now(),
      },
    ];
    const weather = await computeWeather(states);
    expect(weather.condition).toBe('rain');
  });

  it('weather has a computed_at timestamp close to now', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const before = Date.now();
    const weather = await computeWeather([]);
    const after = Date.now();
    expect(weather.computed_at).toBeGreaterThanOrEqual(before);
    expect(weather.computed_at).toBeLessThanOrEqual(after);
  });

  it('intensity is clamped to max 1', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const state = {
      energy: 0.9, sociability: 0.9, intellectual_arousal: 0.95,
      emotional_weight: 0.95, valence: 0.9, primary_color: 'extreme', updated_at: Date.now(),
    };
    const weather = await computeWeather([state]);
    expect(weather.intensity).toBeLessThanOrEqual(1);
  });

  it('intensity is non-negative', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const state = {
      energy: 0.1, sociability: 0.1, intellectual_arousal: 0.1,
      emotional_weight: 0.1, valence: 0.1, primary_color: 'dull', updated_at: Date.now(),
    };
    const weather = await computeWeather([state]);
    expect(weather.intensity).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────
// 5. WEATHER — Source-level structural tests
// ─────────────────────────────────────────────────────────
describe('Weather source structure', () => {
  const src = readFileSync(
    join(__dirname, '..', 'src', 'commune', 'weather.ts'),
    'utf-8',
  );

  it('exports Weather interface', () => {
    expect(src).toContain('export interface Weather');
  });

  it('exports computeWeather function', () => {
    expect(src).toContain('export async function computeWeather');
  });

  it('exports getCurrentWeather function', () => {
    expect(src).toContain('export function getCurrentWeather');
  });

  it('exports getWeatherEffect function', () => {
    expect(src).toContain('export function getWeatherEffect');
  });

  it('exports startWeatherLoop function', () => {
    expect(src).toContain('export function startWeatherLoop');
  });

  it('Weather condition type includes all 6 conditions', () => {
    const conditions = ['clear', 'overcast', 'rain', 'fog', 'storm', 'aurora'];
    for (const c of conditions) {
      expect(src).toContain(`'${c}'`);
    }
  });

  it('weather loop interval is 4 hours', () => {
    expect(src).toContain('4 * 60 * 60 * 1000');
  });

  it('getWeatherEffect has entries for all 6 conditions', () => {
    const conditions = ['storm', 'rain', 'fog', 'aurora', 'clear', 'overcast'];
    for (const c of conditions) {
      expect(src).toContain(`${c}:`);
    }
  });
});

// ─────────────────────────────────────────────────────────
// 6. WEATHER — Condition threshold verification
// ─────────────────────────────────────────────────────────
describe('Weather condition thresholds', () => {
  const src = readFileSync(
    join(__dirname, '..', 'src', 'commune', 'weather.ts'),
    'utf-8',
  );

  it('storm requires emotional_weight > 0.7 and intellectual_arousal > 0.6', () => {
    expect(src).toContain('avgState.emotional_weight > 0.7');
    expect(src).toContain('avgState.intellectual_arousal > 0.6');
  });

  it('aurora requires intellectual_arousal > 0.7 and valence > 0.7', () => {
    expect(src).toContain('avgState.intellectual_arousal > 0.7');
    expect(src).toContain('avgState.valence > 0.7');
  });

  it('rain requires emotional_weight > 0.6', () => {
    expect(src).toContain('avgState.emotional_weight > 0.6');
  });

  it('fog requires energy < 0.35', () => {
    expect(src).toContain('avgState.energy < 0.35');
  });

  it('clear requires valence > 0.6 and emotional_weight < 0.4', () => {
    expect(src).toContain('avgState.valence > 0.6');
    expect(src).toContain('avgState.emotional_weight < 0.4');
  });
});

// ─────────────────────────────────────────────────────────
// 7. LOCATION — State management and movement
// ─────────────────────────────────────────────────────────
describe('Location', () => {
  const testDir = join(tmpdir(), `lain-test-location-${Date.now()}`);
  const dbPath = join(testDir, 'test.db');
  const originalEnv = process.env['LAIN_HOME'];

  beforeEach(async () => {
    vi.resetModules();
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
    try {
      await rm(testDir, { recursive: true });
    } catch {}
  });

  it('getCurrentLocation returns a location when nothing is persisted', async () => {
    const { getCurrentLocation } = await import('../src/commune/location.js');
    const { eventBus } = await import('../src/events/bus.js');
    eventBus.setCharacterId('test-char');
    const loc = getCurrentLocation();
    expect(typeof loc.building).toBe('string');
    expect(loc.building.length).toBeGreaterThan(0);
    expect(loc.timestamp).toBeGreaterThan(0);
  });

  it('default fallback location is lighthouse', async () => {
    const { getCurrentLocation } = await import('../src/commune/location.js');
    const { eventBus } = await import('../src/events/bus.js');
    // Use a character ID with no default location in manifest
    eventBus.setCharacterId('unknown-character-xyz');
    const loc = getCurrentLocation();
    expect(loc.building).toBe('lighthouse');
  });

  it('setCurrentLocation persists and retrieves location', async () => {
    const { getCurrentLocation, setCurrentLocation } = await import('../src/commune/location.js');
    const { eventBus } = await import('../src/events/bus.js');
    eventBus.setCharacterId('test-char');
    setCurrentLocation('library' as any, 'going to read');
    const loc = getCurrentLocation();
    expect(loc.building).toBe('library');
  });

  it('setCurrentLocation is a no-op when moving to same location', async () => {
    const { setCurrentLocation, getLocationHistory } = await import('../src/commune/location.js');
    const { eventBus } = await import('../src/events/bus.js');
    eventBus.setCharacterId('test-char');
    setCurrentLocation('library' as any, 'going to read');
    setCurrentLocation('library' as any, 'still here');
    const history = getLocationHistory();
    // Only one move should be recorded (initial to library)
    expect(history).toHaveLength(1);
  });

  it('getLocationHistory returns empty array initially', async () => {
    const { getLocationHistory } = await import('../src/commune/location.js');
    const history = getLocationHistory();
    expect(history).toEqual([]);
  });

  it('getLocationHistory records movement with from/to/reason/timestamp', async () => {
    const { setCurrentLocation, getLocationHistory } = await import('../src/commune/location.js');
    const { eventBus } = await import('../src/events/bus.js');
    eventBus.setCharacterId('test-char');
    setCurrentLocation('bar' as any, 'feeling social');
    const history = getLocationHistory();
    expect(history.length).toBeGreaterThan(0);
    const entry = history[0]!;
    expect(entry).toHaveProperty('from');
    expect(entry).toHaveProperty('to');
    expect(entry).toHaveProperty('reason');
    expect(entry).toHaveProperty('timestamp');
    expect(entry.to).toBe('bar');
    expect(entry.reason).toBe('feeling social');
  });

  it('location history caps at 20 entries', async () => {
    const { setCurrentLocation, getLocationHistory } = await import('../src/commune/location.js');
    const { eventBus } = await import('../src/events/bus.js');
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    eventBus.setCharacterId('test-char');

    const buildings = BUILDINGS.map((b) => b.id);

    // Move 25 times, cycling through buildings
    for (let i = 0; i < 25; i++) {
      const target = buildings[i % buildings.length]!;
      setCurrentLocation(target as any, `move ${i}`);
    }

    const history = getLocationHistory();
    expect(history.length).toBeLessThanOrEqual(20);
  });

  it('getLocationHistory respects limit parameter', async () => {
    const { setCurrentLocation, getLocationHistory } = await import('../src/commune/location.js');
    const { eventBus } = await import('../src/events/bus.js');
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    eventBus.setCharacterId('test-char');

    const buildings = BUILDINGS.map((b) => b.id);
    for (let i = 0; i < 10; i++) {
      const target = buildings[i % buildings.length]!;
      setCurrentLocation(target as any, `move ${i}`);
    }

    const limited = getLocationHistory(3);
    expect(limited.length).toBeLessThanOrEqual(3);
  });

  it('most recent movement is first in history', async () => {
    const { setCurrentLocation, getLocationHistory } = await import('../src/commune/location.js');
    const { eventBus } = await import('../src/events/bus.js');
    eventBus.setCharacterId('test-char');

    setCurrentLocation('library' as any, 'reading');
    setCurrentLocation('bar' as any, 'drinking');

    const history = getLocationHistory();
    expect(history[0]!.to).toBe('bar');
    expect(history[0]!.reason).toBe('drinking');
  });
});

// ─────────────────────────────────────────────────────────
// 8. LOCATION — Source-level structural tests
// ─────────────────────────────────────────────────────────
describe('Location source structure', () => {
  const src = readFileSync(
    join(__dirname, '..', 'src', 'commune', 'location.ts'),
    'utf-8',
  );

  it('exports getCurrentLocation function', () => {
    expect(src).toContain('export function getCurrentLocation');
  });

  it('exports setCurrentLocation function', () => {
    expect(src).toContain('export function setCurrentLocation');
  });

  it('exports getLocationHistory function', () => {
    expect(src).toContain('export function getLocationHistory');
  });

  it('MAX_HISTORY is 20', () => {
    expect(src).toContain('MAX_HISTORY = 20');
  });

  it('default fallback building is lighthouse', () => {
    expect(src).toContain("|| 'lighthouse'");
  });

  it('uses meta key town:current_location for persistence', () => {
    expect(src).toContain('town:current_location');
  });

  it('uses meta key town:location_history for history', () => {
    expect(src).toContain('town:location_history');
  });

  it('emits movement activity event type', () => {
    expect(src).toContain("type: 'movement'");
  });
});
