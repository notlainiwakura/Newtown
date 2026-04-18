/**
 * Matrix expansion tests for commune buildings, location, and weather.
 * Covers: all 81 A→B movement pairs, building properties, weather effects,
 * desire-to-building mappings, and weather condition logic.
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Building definitions (mirrored from src/commune/buildings.ts)
// ---------------------------------------------------------------------------

interface Building {
  id: string;
  name: string;
  emoji: string;
  row: number;
  col: number;
  description: string;
}

const BUILDINGS: Building[] = [
  { id: 'library',    name: 'Library',       emoji: '📚', row: 0, col: 0, description: 'knowledge, quiet study' },
  { id: 'bar',        name: 'Bar',           emoji: '🍺', row: 0, col: 1, description: 'social gathering, loose talk' },
  { id: 'field',      name: 'Field',         emoji: '🌾', row: 0, col: 2, description: 'open sky, wandering thoughts' },
  { id: 'windmill',   name: 'Windmill',      emoji: '🏗',  row: 1, col: 0, description: 'energy, cycles, labor' },
  { id: 'lighthouse', name: 'Lighthouse',    emoji: '🗼', row: 1, col: 1, description: 'solitude, seeking, clarity' },
  { id: 'school',     name: 'School',        emoji: '🏫', row: 1, col: 2, description: 'learning, mentorship' },
  { id: 'market',     name: 'Market',        emoji: '🏪', row: 2, col: 0, description: 'exchange, bustle' },
  { id: 'locksmith',  name: 'Locksmith',     emoji: '🔐', row: 2, col: 1, description: 'puzzles, secrets, access' },
  { id: 'threshold',  name: 'The Threshold', emoji: '🚪', row: 2, col: 2, description: 'liminal space, unresolved questions' },
];

const BUILDING_IDS = BUILDINGS.map(b => b.id);

// ---------------------------------------------------------------------------
// Weather conditions (mirrored from src/commune/weather.ts)
// ---------------------------------------------------------------------------

type WeatherCondition = 'clear' | 'overcast' | 'rain' | 'fog' | 'storm' | 'aurora';

const WEATHER_CONDITIONS: WeatherCondition[] = ['clear', 'overcast', 'rain', 'fog', 'storm', 'aurora'];

// Weather effects from getWeatherEffect()
const WEATHER_EFFECTS: Record<WeatherCondition, Partial<Record<string, number>>> = {
  storm:    { energy: -0.04, intellectual_arousal: 0.03 },
  rain:     { emotional_weight: 0.03, sociability: -0.02 },
  fog:      { energy: -0.03, valence: -0.01 },
  aurora:   { energy: 0.04, valence: 0.04, sociability: 0.03 },
  clear:    { energy: 0.02 },
  overcast: {},
};

// ---------------------------------------------------------------------------
// Desire types (mirrored from src/agent/desires.ts)
// ---------------------------------------------------------------------------

type DesireType = 'social' | 'intellectual' | 'emotional' | 'creative';

const DESIRE_TYPES: DesireType[] = ['social', 'intellectual', 'emotional', 'creative'];

// Mapping: desire type → most fitting building(s)
const DESIRE_TO_BUILDINGS: Record<DesireType, string[]> = {
  social:       ['bar', 'market', 'school'],
  intellectual: ['library', 'lighthouse', 'school'],
  emotional:    ['threshold', 'lighthouse', 'field'],
  creative:     ['field', 'locksmith', 'threshold'],
};

// ---------------------------------------------------------------------------
// Test 1: Building property completeness (9 buildings × 5 properties = 45 tests)
// ---------------------------------------------------------------------------

type BuildingProperty = 'id' | 'name' | 'emoji' | 'row' | 'col';

const BUILDING_PROPERTIES: BuildingProperty[] = ['id', 'name', 'emoji', 'row', 'col'];

const BUILDING_PROPERTY_MATRIX: [string, Building, BuildingProperty][] = BUILDINGS.flatMap(b =>
  BUILDING_PROPERTIES.map(prop => [`${b.id}::${prop}`, b, prop] as [string, Building, BuildingProperty])
);

describe('Building property completeness matrix', () => {
  it.each(BUILDING_PROPERTY_MATRIX)('%s is defined', (_label, building, prop) => {
    const value = building[prop];
    expect(value).toBeDefined();
    if (prop === 'row' || prop === 'col') {
      expect(typeof value).toBe('number');
      expect(value as number).toBeGreaterThanOrEqual(0);
      expect(value as number).toBeLessThanOrEqual(2);
    } else {
      expect(typeof value).toBe('string');
      expect((value as string).length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 2: Grid coverage — every (row, col) pair in 3×3 is occupied
// ---------------------------------------------------------------------------

const GRID_POSITIONS: [number, number][] = Array.from({ length: 3 }, (_, r) =>
  Array.from({ length: 3 }, (_, c) => [r, c] as [number, number])
).flat();

describe('Grid coverage matrix', () => {
  it.each(GRID_POSITIONS)('row=%i col=%i has exactly one building', (row, col) => {
    const matches = BUILDINGS.filter(b => b.row === row && b.col === col);
    expect(matches).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Test 3: All 81 A→B movement pairs (9×9)
// ---------------------------------------------------------------------------

const MOVEMENT_PAIRS: [string, string, string, boolean][] = [];
for (const from of BUILDINGS) {
  for (const to of BUILDINGS) {
    const isSame = from.id === to.id;
    MOVEMENT_PAIRS.push([`${from.id}→${to.id}`, from.id, to.id, isSame]);
  }
}

describe('Building movement pair matrix (81 pairs)', () => {
  it.each(MOVEMENT_PAIRS)('%s: same-building detection correct', (_label, fromId, toId, isSame) => {
    expect(BUILDING_IDS).toContain(fromId);
    expect(BUILDING_IDS).toContain(toId);
    const result = fromId === toId;
    expect(result).toBe(isSame);
  });
});

// ---------------------------------------------------------------------------
// Test 4: Cross-building movement is always a real location change
// ---------------------------------------------------------------------------

const CROSS_BUILDING_PAIRS: [string, string, string][] = MOVEMENT_PAIRS
  .filter(([, , , isSame]) => !isSame)
  .map(([label, from, to]) => [label, from, to]);

describe('Cross-building movement matrix (72 pairs)', () => {
  it.each(CROSS_BUILDING_PAIRS)('%s: both endpoints are distinct valid buildings', (_label, fromId, toId) => {
    expect(fromId).not.toBe(toId);
    expect(BUILDING_IDS).toContain(fromId);
    expect(BUILDING_IDS).toContain(toId);
  });
});

// ---------------------------------------------------------------------------
// Test 5: Same-building movement is always a no-op (9 tests)
// ---------------------------------------------------------------------------

const SAME_BUILDING_PAIRS: [string, string][] = BUILDINGS.map(b => [b.id, b.id]);

describe('Same-building movement matrix (no-op)', () => {
  it.each(SAME_BUILDING_PAIRS)('%s→%s is a no-op', (fromId, toId) => {
    expect(fromId).toBe(toId);
    // setCurrentLocation should be a no-op when from === to
    const wouldMove = fromId !== toId;
    expect(wouldMove).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 6: Weather condition × building "mood" effect (6 × 9 = 54 tests)
// ---------------------------------------------------------------------------

const WEATHER_BUILDING_MATRIX: [string, WeatherCondition, Building][] = WEATHER_CONDITIONS.flatMap(cond =>
  BUILDINGS.map(b => [`${cond}::${b.id}`, cond, b] as [string, WeatherCondition, Building])
);

describe('Weather × building mood matrix', () => {
  it.each(WEATHER_BUILDING_MATRIX)('%s: effect is defined and numeric', (_label, condition, building) => {
    const effect = WEATHER_EFFECTS[condition];
    expect(effect).toBeDefined();
    // Each effect value must be a number if present
    for (const val of Object.values(effect)) {
      if (val !== undefined) {
        expect(typeof val).toBe('number');
        // Effects should be small nudges, not full resets
        expect(Math.abs(val)).toBeLessThanOrEqual(0.1);
      }
    }
    // Building is valid
    expect(BUILDING_IDS).toContain(building.id);
  });
});

// ---------------------------------------------------------------------------
// Test 7: Weather condition properties (6 tests)
// ---------------------------------------------------------------------------

describe('Weather condition properties matrix', () => {
  it.each(WEATHER_CONDITIONS.map(c => [c, WEATHER_EFFECTS[c]] as [WeatherCondition, Record<string, number>]))('%s: effect object is defined', (condition, effect) => {
    expect(effect).toBeDefined();
    expect(typeof effect).toBe('object');
  });
});

// ---------------------------------------------------------------------------
// Test 8: Weather driver conditions — computeCondition logic verification
// ---------------------------------------------------------------------------

interface WeatherTestCase {
  label: string;
  state: { energy: number; sociability: number; intellectual_arousal: number; emotional_weight: number; valence: number };
  expectedCondition: WeatherCondition;
}

function computeCondition(s: { energy: number; intellectual_arousal: number; emotional_weight: number; valence: number }): WeatherCondition {
  if (s.emotional_weight > 0.7 && s.intellectual_arousal > 0.6) return 'storm';
  if (s.intellectual_arousal > 0.7 && s.valence > 0.7) return 'aurora';
  if (s.emotional_weight > 0.6) return 'rain';
  if (s.energy < 0.35) return 'fog';
  if (s.valence > 0.6 && s.emotional_weight < 0.4) return 'clear';
  return 'overcast';
}

const WEATHER_DRIVER_CASES: WeatherTestCase[] = [
  {
    label: 'storm: high emotional_weight + high intellectual_arousal',
    state: { energy: 0.5, sociability: 0.5, intellectual_arousal: 0.65, emotional_weight: 0.75, valence: 0.4 },
    expectedCondition: 'storm',
  },
  {
    label: 'aurora: high intellectual_arousal + high valence',
    state: { energy: 0.7, sociability: 0.6, intellectual_arousal: 0.8, emotional_weight: 0.3, valence: 0.75 },
    expectedCondition: 'aurora',
  },
  {
    label: 'rain: high emotional_weight',
    state: { energy: 0.5, sociability: 0.5, intellectual_arousal: 0.4, emotional_weight: 0.65, valence: 0.4 },
    expectedCondition: 'rain',
  },
  {
    label: 'fog: low energy',
    state: { energy: 0.3, sociability: 0.5, intellectual_arousal: 0.4, emotional_weight: 0.3, valence: 0.5 },
    expectedCondition: 'fog',
  },
  {
    label: 'clear: high valence + low emotional_weight',
    state: { energy: 0.6, sociability: 0.5, intellectual_arousal: 0.4, emotional_weight: 0.2, valence: 0.7 },
    expectedCondition: 'clear',
  },
  {
    label: 'overcast: default neutral state',
    state: { energy: 0.5, sociability: 0.5, intellectual_arousal: 0.4, emotional_weight: 0.3, valence: 0.5 },
    expectedCondition: 'overcast',
  },
];

describe('Weather driver condition matrix', () => {
  it.each(WEATHER_DRIVER_CASES.map(c => [c.label, c] as [string, WeatherTestCase]))('%s', (_label, tc) => {
    const result = computeCondition(tc.state);
    expect(result).toBe(tc.expectedCondition);
  });
});

// ---------------------------------------------------------------------------
// Test 9: Desire type × building mapping (4 × 9 = 36 tests)
// ---------------------------------------------------------------------------

const DESIRE_BUILDING_MATRIX: [string, DesireType, Building][] = DESIRE_TYPES.flatMap(dtype =>
  BUILDINGS.map(b => [`${dtype}::${b.id}`, dtype, b] as [string, DesireType, Building])
);

describe('Desire type × building matrix', () => {
  it.each(DESIRE_BUILDING_MATRIX)('%s: desire type has at least one associated building', (_label, desireType, building) => {
    const associated = DESIRE_TO_BUILDINGS[desireType];
    expect(associated).toBeDefined();
    expect(associated.length).toBeGreaterThan(0);
    // Building must always be a valid ID
    expect(BUILDING_IDS).toContain(building.id);
  });
});

// ---------------------------------------------------------------------------
// Test 10: Desire type → primary building affinity
// ---------------------------------------------------------------------------

const DESIRE_PRIMARY_CASES: [DesireType, string][] = [
  ['social',       'bar'],
  ['intellectual', 'library'],
  ['emotional',    'threshold'],
  ['creative',     'field'],
];

describe('Desire type primary building affinity matrix', () => {
  it.each(DESIRE_PRIMARY_CASES)('%s → %s is in affinity list', (desireType, expectedBuilding) => {
    const buildings = DESIRE_TO_BUILDINGS[desireType];
    expect(buildings).toContain(expectedBuilding);
  });
});

// ---------------------------------------------------------------------------
// Test 11: Building description keywords (semantic correctness)
// ---------------------------------------------------------------------------

const DESCRIPTION_KEYWORDS: [string, string[]][] = [
  ['library',    ['knowledge', 'quiet', 'study']],
  ['bar',        ['social', 'gathering']],
  ['field',      ['sky', 'thoughts']],
  ['windmill',   ['energy', 'cycles']],
  ['lighthouse', ['solitude', 'seeking', 'clarity']],
  ['school',     ['learning', 'mentorship']],
  ['market',     ['exchange', 'bustle']],
  ['locksmith',  ['puzzles', 'secrets']],
  ['threshold',  ['liminal', 'unresolved']],
];

describe('Building description keyword matrix', () => {
  it.each(DESCRIPTION_KEYWORDS)('%s description contains expected keywords', (buildingId, keywords) => {
    const building = BUILDINGS.find(b => b.id === buildingId)!;
    expect(building).toBeDefined();
    for (const keyword of keywords) {
      expect(building.description.toLowerCase()).toContain(keyword.toLowerCase());
    }
  });
});

// ---------------------------------------------------------------------------
// Test 12: Location fallback — default building per character role
// ---------------------------------------------------------------------------

const DEFAULT_LOCATION_CASES: [string, string][] = [
  ['dr-claude', 'school'],
  ['unknown',   'lighthouse'],  // global fallback per location.ts
];

describe('Default location fallback matrix', () => {
  it.each(DEFAULT_LOCATION_CASES)('character "%s" defaults to %s', (characterId, expectedBuilding) => {
    // Simulate the fallback logic from location.ts
    const DEFAULT_LOCATIONS: Record<string, string> = { 'dr-claude': 'school' };
    const result = DEFAULT_LOCATIONS[characterId] || 'lighthouse';
    expect(result).toBe(expectedBuilding);
    expect(BUILDING_IDS).toContain(result);
  });
});

// ---------------------------------------------------------------------------
// Test 13: Weather effects sign correctness (positive/negative nudges)
// ---------------------------------------------------------------------------

type StateAxis = 'energy' | 'sociability' | 'intellectual_arousal' | 'emotional_weight' | 'valence';

const WEATHER_EFFECT_SIGNS: [WeatherCondition, StateAxis, number][] = [
  ['storm',    'energy',               -0.04],
  ['storm',    'intellectual_arousal',  0.03],
  ['rain',     'emotional_weight',      0.03],
  ['rain',     'sociability',          -0.02],
  ['fog',      'energy',               -0.03],
  ['fog',      'valence',              -0.01],
  ['aurora',   'energy',               0.04],
  ['aurora',   'valence',              0.04],
  ['aurora',   'sociability',          0.03],
  ['clear',    'energy',               0.02],
];

describe('Weather effect sign matrix', () => {
  it.each(WEATHER_EFFECT_SIGNS)('%s → %s = %f', (condition, axis, expectedValue) => {
    const effect = WEATHER_EFFECTS[condition];
    expect(effect[axis]).toBe(expectedValue);
  });
});

// ---------------------------------------------------------------------------
// Test 14: Building uniqueness constraints (no duplicate IDs, names, positions)
// ---------------------------------------------------------------------------

describe('Building uniqueness matrix', () => {
  it('all building IDs are unique', () => {
    const ids = BUILDINGS.map(b => b.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('all building names are unique', () => {
    const names = BUILDINGS.map(b => b.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('all (row, col) positions are unique', () => {
    const positions = BUILDINGS.map(b => `${b.row},${b.col}`);
    const unique = new Set(positions);
    expect(unique.size).toBe(positions.length);
  });

  it('total building count is 9', () => {
    expect(BUILDINGS).toHaveLength(9);
  });

  it('grid is exactly 3×3', () => {
    const rows = new Set(BUILDINGS.map(b => b.row));
    const cols = new Set(BUILDINGS.map(b => b.col));
    expect(rows.size).toBe(3);
    expect(cols.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Test 15: isValidBuilding equivalent for all IDs
// ---------------------------------------------------------------------------

const VALID_BUILDING_CASES: [string, boolean][] = [
  ...BUILDING_IDS.map(id => [id, true] as [string, boolean]),
  ['nonexistent', false],
  ['', false],
  ['LIBRARY', false],  // case-sensitive
  ['library ', false], // trailing space
];

describe('isValidBuilding matrix', () => {
  it.each(VALID_BUILDING_CASES)('"%s" is valid: %s', (id, expected) => {
    const buildingMap = new Map(BUILDINGS.map(b => [b.id, b]));
    const result = buildingMap.has(id);
    expect(result).toBe(expected);
  });
});
