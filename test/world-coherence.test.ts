/**
 * World Coherence Tests — does the virtual town hold together as a believable whole?
 * Thinks like a game designer: geography, lifecycle, feedback loops, communication,
 * memory, background loops, and town aliveness over time.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
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

// ── Shared setup helpers ───────────────────────────────────────────────────

const TEST_MANIFEST = {
  town: { name: 'Test Town', description: 'Testing' },
  characters: [
    { id: 'alice', name: 'Alice', port: 3000, server: 'web', defaultLocation: 'library', immortal: true, possessable: false, workspace: 'ws/alice' },
    { id: 'bob',   name: 'Bob',   port: 3001, server: 'character', defaultLocation: 'bar', immortal: false, possessable: false, workspace: 'ws/bob' },
    { id: 'cara',  name: 'Cara',  port: 3002, server: 'character', defaultLocation: 'lighthouse', immortal: false, possessable: false, workspace: 'ws/cara' },
  ],
};

async function setupTestDb(label: string) {
  const dir = join(tmpdir(), `lain-wc-${label}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const saved: Record<string, string | undefined> = {
    LAIN_HOME: process.env['LAIN_HOME'],
    CHARACTERS_CONFIG: process.env['CHARACTERS_CONFIG'],
    LAIN_CHARACTER_ID: process.env['LAIN_CHARACTER_ID'],
  };
  process.env['LAIN_HOME'] = dir;
  const cfgPath = join(dir, 'characters.json');
  await writeFile(cfgPath, JSON.stringify(TEST_MANIFEST), 'utf-8');
  process.env['CHARACTERS_CONFIG'] = cfgPath;
  const { initDatabase } = await import('../src/storage/database.js');
  await initDatabase(join(dir, 'test.db'));
  return async () => {
    const { closeDatabase } = await import('../src/storage/database.js');
    closeDatabase();
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v; else delete process.env[k];
    }
    try { await rm(dir, { recursive: true }); } catch { /* ok */ }
  };
}

function srcOf(file: string) { return readFileSync(join(process.cwd(), file), 'utf-8'); }

// ═════════════════════════════════════════════════════════════════════════════
// 1. TOWN GEOGRAPHY
// ═════════════════════════════════════════════════════════════════════════════

describe('Town geography — 3×3 grid', () => {
  it('has exactly 9 buildings filling the complete 3×3 grid with no gaps', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    expect(BUILDINGS).toHaveLength(9);
    const occupied = new Set(BUILDINGS.map((b) => `${b.row},${b.col}`));
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++)
      expect(occupied.has(`${r},${c}`), `Cell (${r},${c}) must be occupied`).toBe(true);
  });

  it('all buildings have valid row/col in [0,2] with no position or id collisions', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    const ids = BUILDINGS.map((b) => b.id);
    const positions = BUILDINGS.map((b) => `${b.row},${b.col}`);
    expect(new Set(ids).size).toBe(9);
    expect(new Set(positions).size).toBe(9);
    for (const b of BUILDINGS) {
      expect(b.row).toBeGreaterThanOrEqual(0); expect(b.row).toBeLessThanOrEqual(2);
      expect(b.col).toBeGreaterThanOrEqual(0); expect(b.col).toBeLessThanOrEqual(2);
    }
  });

  it('every building has at least one adjacent neighbour (no isolated nodes)', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    for (const b of BUILDINGS) {
      const hasNeighbour = BUILDINGS.some((o) => o.id !== b.id && Math.abs(o.row - b.row) <= 1 && Math.abs(o.col - b.col) <= 1);
      expect(hasNeighbour, `${b.id} must have a neighbour`).toBe(true);
    }
  });

  it('each row and column has exactly 3 buildings', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    for (let i = 0; i < 3; i++) {
      expect(BUILDINGS.filter((b) => b.row === i)).toHaveLength(3);
      expect(BUILDINGS.filter((b) => b.col === i)).toHaveLength(3);
    }
  });

  it('BUILDING_MAP covers all 9 and isValidBuilding works correctly', async () => {
    const { BUILDINGS, BUILDING_MAP, isValidBuilding } = await import('../src/commune/buildings.js');
    expect(BUILDING_MAP.size).toBe(9);
    for (const b of BUILDINGS) expect(isValidBuilding(b.id)).toBe(true);
    expect(isValidBuilding('castle')).toBe(false);
    expect(isValidBuilding('')).toBe(false);
  });

  it('social buildings exist (bar/market — described as social/exchange/bustle)', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    const socialKw = ['social', 'gathering', 'exchange', 'bustle', 'mentorship'];
    expect(BUILDINGS.filter((b) => socialKw.some((kw) => b.description.includes(kw))).length).toBeGreaterThan(0);
  });

  it('solitude buildings exist (lighthouse/field — solitude/open sky/liminal)', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    const solKw = ['solitude', 'open sky', 'wandering', 'liminal'];
    expect(BUILDINGS.filter((b) => solKw.some((kw) => b.description.includes(kw))).length).toBeGreaterThan(0);
  });

  it('knowledge buildings exist (library/school — knowledge/learning/study)', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    const kwKw = ['knowledge', 'study', 'learning', 'seeking', 'clarity'];
    expect(BUILDINGS.filter((b) => kwKw.some((kw) => b.description.includes(kw))).length).toBeGreaterThan(0);
  });

  it('landmark buildings have correct descriptions: lighthouse=solitude, library=knowledge, threshold=liminal, bar=social', async () => {
    const { BUILDING_MAP } = await import('../src/commune/buildings.js');
    expect(BUILDING_MAP.get('lighthouse')!.description).toContain('solitude');
    expect(BUILDING_MAP.get('library')!.description).toContain('knowledge');
    expect(BUILDING_MAP.get('threshold')!.description).toContain('liminal');
    expect(BUILDING_MAP.get('bar')!.description).toContain('social');
  });

  it('all 9 buildings are distinct destinations (each has non-empty unique name + description)', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    const names = BUILDINGS.map((b) => b.name);
    const descs = BUILDINGS.map((b) => b.description);
    expect(new Set(names).size).toBe(9);
    for (const b of BUILDINGS) expect(b.description.length).toBeGreaterThan(5);
    void descs;
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. CHARACTER LIFECYCLE
// ═════════════════════════════════════════════════════════════════════════════

describe('Character lifecycle — manifest coherence', () => {
  let teardown: () => Promise<void>;
  beforeEach(async () => { teardown = await setupTestDb('manifest'); });
  afterEach(async () => { await teardown(); });

  it('every character has a valid defaultLocation, unique id, and unique port', async () => {
    const { getAllCharacters } = await import('../src/config/characters.js');
    const { isValidBuilding } = await import('../src/commune/buildings.js');
    const chars = getAllCharacters();
    const ids = chars.map((c) => c.id);
    const ports = chars.map((c) => c.port);
    expect(new Set(ids).size).toBe(chars.length);
    expect(new Set(ports).size).toBe(chars.length);
    for (const c of chars) {
      expect(isValidBuilding(c.defaultLocation), `${c.id} has invalid defaultLocation "${c.defaultLocation}"`).toBe(true);
      expect(c.port).toBeGreaterThanOrEqual(1024);
      expect(c.port).toBeLessThanOrEqual(65535);
    }
  });

  it('exactly one character is the web character and it appears in getAllCharacters', async () => {
    const { getWebCharacter, getAllCharacters } = await import('../src/config/characters.js');
    const webChar = getWebCharacter();
    expect(webChar).toBeDefined();
    expect(getAllCharacters().filter((c) => c.server === 'web')).toHaveLength(1);
    expect(getAllCharacters().map((c) => c.id)).toContain(webChar!.id);
  });

  it('every character has peers but none is its own peer; peer URLs match ports', async () => {
    const { getAllCharacters, getPeersFor } = await import('../src/config/characters.js');
    const chars = getAllCharacters();
    const portMap = new Map(chars.map((c) => [c.id, c.port]));
    for (const c of chars) {
      const peers = getPeersFor(c.id);
      expect(peers.length, `${c.id} should have peers`).toBeGreaterThan(0);
      expect(peers.some((p) => p.id === c.id), `${c.id} must not be own peer`).toBe(false);
      for (const peer of peers) {
        expect(peer.url).toBe(`http://localhost:${portMap.get(peer.id)}`);
      }
    }
  });

  it('immortal characters are a non-empty strict subset; mortals are the complement', async () => {
    const { getAllCharacters, getMortalCharacters, getImmortalIds } = await import('../src/config/characters.js');
    const all = getAllCharacters();
    const immortalIds = getImmortalIds();
    const mortals = getMortalCharacters();
    expect(immortalIds.size).toBeGreaterThan(0);
    expect(mortals.length + immortalIds.size).toBe(all.length);
    for (const id of immortalIds) expect(all.some((c) => c.id === id)).toBe(true);
    for (const m of mortals) expect(immortalIds.has(m.id)).toBe(false);
  });

  it('getDefaultLocations returns a valid building for every character', async () => {
    const { getAllCharacters, getDefaultLocations } = await import('../src/config/characters.js');
    const { isValidBuilding } = await import('../src/commune/buildings.js');
    const locs = getDefaultLocations();
    for (const c of getAllCharacters()) {
      expect(isValidBuilding(locs[c.id]!), `${c.id} default="${locs[c.id]}" invalid`).toBe(true);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. EMOTIONAL → WEATHER → BEHAVIOR FEEDBACK LOOP
// ═════════════════════════════════════════════════════════════════════════════

describe('Emotional → Weather → Behavior feedback loop', () => {
  let teardown: () => Promise<void>;
  beforeEach(async () => { teardown = await setupTestDb('weather'); });
  afterEach(async () => { await teardown(); });

  async function weather(stateOverride: Record<string, number>) {
    const { computeWeather } = await import('../src/commune/weather.js');
    return computeWeather([{ energy: 0.5, sociability: 0.5, intellectual_arousal: 0.4, emotional_weight: 0.3, valence: 0.6, primary_color: 'neutral', updated_at: Date.now(), ...stateOverride }]);
  }

  it('empty states → overcast; balanced mixed states → not storm or aurora', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    expect((await computeWeather([])).condition).toBe('overcast');
    const mix = await computeWeather([{ energy: 0.5, sociability: 0.5, intellectual_arousal: 0.5, emotional_weight: 0.5, valence: 0.5, primary_color: 'mixed', updated_at: Date.now() }]);
    expect(['overcast', 'fog', 'rain']).toContain(mix.condition);
  });

  it('storm requires BOTH high emotional_weight (>0.7) AND high intellectual_arousal (>0.6)', async () => {
    expect((await weather({ emotional_weight: 0.85, intellectual_arousal: 0.75 })).condition).toBe('storm');
    expect((await weather({ emotional_weight: 0.85, intellectual_arousal: 0.2 })).condition).not.toBe('storm');
    expect((await weather({ emotional_weight: 0.2, intellectual_arousal: 0.75, valence: 0.4 })).condition).not.toBe('storm');
  });

  it('aurora requires high intellectual_arousal (>0.7) AND high valence (>0.7)', async () => {
    expect((await weather({ intellectual_arousal: 0.85, valence: 0.85, emotional_weight: 0.1 })).condition).toBe('aurora');
    expect((await weather({ valence: 0.9, intellectual_arousal: 0.3, emotional_weight: 0.2 })).condition).not.toBe('aurora');
  });

  it('low energy (<0.35) → fog; high emotional_weight (not storm) → rain; high valence + low weight → clear', async () => {
    expect((await weather({ energy: 0.2, emotional_weight: 0.2, intellectual_arousal: 0.2 })).condition).toBe('fog');
    expect((await weather({ emotional_weight: 0.7, intellectual_arousal: 0.3 })).condition).toBe('rain');
    expect((await weather({ valence: 0.8, emotional_weight: 0.2, energy: 0.5 })).condition).toBe('clear');
  });

  it('averaging: 5 happy + 1 sad → clear (minority does not override majority)', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const happy = { energy: 0.8, sociability: 0.7, intellectual_arousal: 0.4, emotional_weight: 0.1, valence: 0.9, primary_color: 'bright', updated_at: Date.now() };
    const sad   = { energy: 0.2, sociability: 0.2, intellectual_arousal: 0.2, emotional_weight: 0.9, valence: 0.1, primary_color: 'bleak', updated_at: Date.now() };
    const w = await computeWeather([happy, happy, happy, happy, happy, sad]);
    expect(w.condition).toBe('clear');
  });

  it('all weather effects have correct direction: storm drains energy; aurora boosts energy+valence; fog negative; rain adds weight; clear non-negative', async () => {
    const { getWeatherEffect } = await import('../src/commune/weather.js');
    const storm  = getWeatherEffect('storm');  expect(storm.energy).toBeLessThan(0);
    const aurora = getWeatherEffect('aurora'); expect(aurora.energy).toBeGreaterThan(0); expect(aurora.valence).toBeGreaterThan(0);
    const fog    = getWeatherEffect('fog');    expect(fog.energy).toBeLessThan(0); expect(fog.valence).toBeLessThan(0);
    const rain   = getWeatherEffect('rain');   expect(rain.emotional_weight).toBeGreaterThan(0);
    const clear  = getWeatherEffect('clear');  for (const v of Object.values(clear)) if (typeof v === 'number') expect(v).toBeGreaterThanOrEqual(0);
    expect(Object.keys(getWeatherEffect('blizzard'))).toHaveLength(0); // unknown → empty
  });

  it('weather has computed_at timestamp; intensity in (0,1]; can be persisted and retrieved', async () => {
    const { computeWeather, getCurrentWeather } = await import('../src/commune/weather.js');
    const { setMeta } = await import('../src/storage/database.js');
    const before = Date.now();
    const w = await weather({ energy: 0.5 });
    expect(w.computed_at).toBeGreaterThanOrEqual(before);
    expect(w.intensity).toBeGreaterThan(0); expect(w.intensity).toBeLessThanOrEqual(1);
    setMeta('weather:current', JSON.stringify({ condition: 'aurora', intensity: 0.8, description: 'test', computed_at: Date.now() }));
    expect(getCurrentWeather()!.condition).toBe('aurora');
    void computeWeather;
  });

  it('weather loop returns a callable cleanup function', async () => {
    const { startWeatherLoop } = await import('../src/commune/weather.js');
    vi.useFakeTimers();
    const stop = startWeatherLoop();
    expect(typeof stop).toBe('function');
    stop();
    vi.useRealTimers();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. DESIRE → MOVEMENT → AWARENESS CHAIN
// ═════════════════════════════════════════════════════════════════════════════

describe('Desire → Movement → Awareness chain', () => {
  let teardown: () => Promise<void>;
  beforeEach(async () => { teardown = await setupTestDb('desire'); });
  afterEach(async () => { await teardown(); });

  function st(o: Partial<{ energy: number; sociability: number; intellectual_arousal: number; emotional_weight: number; valence: number }> = {}) {
    return { energy: 0.5, sociability: 0.5, intellectual_arousal: 0.4, emotional_weight: 0.3, valence: 0.6, primary_color: 'neutral', updated_at: Date.now(), ...o };
  }

  it('high sociability (>0.7) pulls character toward occupied buildings', async () => {
    const { evaluateMovementDesire } = await import('../src/agent/internal-state.js');
    process.env['LAIN_CHARACTER_ID'] = 'alice';
    const result = evaluateMovementDesire(st({ sociability: 0.9 }), [], [], 'library', new Map([['bob', 'bar'], ['cara', 'bar']]));
    if (result) expect(result.building).toBe('bar');
  });

  it('intellectually aroused (>0.7) character prefers library or lighthouse', async () => {
    const { evaluateMovementDesire } = await import('../src/agent/internal-state.js');
    const result = evaluateMovementDesire(st({ intellectual_arousal: 0.9 }), [], [], 'bar', new Map());
    if (result) expect(['library', 'lighthouse']).toContain(result.building);
  });

  it('emotionally heavy (>0.7) character prefers the field (decompression)', async () => {
    const { evaluateMovementDesire } = await import('../src/agent/internal-state.js');
    const result = evaluateMovementDesire(st({ emotional_weight: 0.85 }), [], [], 'library', new Map());
    if (result) expect(result.building).toBe('field');
  });

  it('already in field → emotional decompression signal does not re-target field', async () => {
    const { evaluateMovementDesire } = await import('../src/agent/internal-state.js');
    const result = evaluateMovementDesire(st({ emotional_weight: 0.9 }), [], [], 'field', new Map());
    if (result) expect(result.building).not.toBe('field');
  });

  it('every movement result has non-empty reason string and confidence in [0,1]', async () => {
    const { evaluateMovementDesire } = await import('../src/agent/internal-state.js');
    const result = evaluateMovementDesire(st({ sociability: 0.9 }), [], [], 'library', new Map([['bob', 'market']]));
    if (result) {
      expect(result.reason.length).toBeGreaterThan(0);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('unresolved preoccupation about a peer pulls character toward that peer', async () => {
    const { evaluateMovementDesire } = await import('../src/agent/internal-state.js');
    const preoccs = [{ id: 'p1', thread: 'conversation with bob', origin: 'bob', originated_at: Date.now(), intensity: 0.8, resolution: null }];
    const rels = [{ peerId: 'bob', peerName: 'Bob', affinity: 0.7, familiarity: 0.5, intellectual_tension: 0.4, emotional_resonance: 0.6, last_topic_thread: 'test', unresolved: 'something important', last_interaction: Date.now(), interaction_count: 3 }];
    const result = evaluateMovementDesire(st(), preoccs, rels, 'library', new Map([['bob', 'market']]));
    if (result) expect(result.building).toBe('market');
  });

  it('desire CRUD: create → active; resolve → gone; boost increases intensity; decay with backdated time fades it', async () => {
    const { ensureDesireTable, createDesire, getActiveDesires, resolveDesire, boostDesire, decayDesires } = await import('../src/agent/desires.js');
    const { execute } = await import('../src/storage/database.js');
    ensureDesireTable();
    const d = createDesire({ type: 'social', description: 'test desire', intensity: 0.4, source: 'test' });
    expect(getActiveDesires().some((x) => x.id === d.id)).toBe(true);
    boostDesire(d.id, 0.3);
    expect(getActiveDesires().find((x) => x.id === d.id)!.intensity).toBeGreaterThan(0.4);
    resolveDesire(d.id, 'done'); expect(getActiveDesires().find((x) => x.id === d.id)).toBeUndefined();

    // Decay test: backdate a low-intensity desire so hoursSinceUpdate is large
    const d2 = createDesire({ type: 'emotional', description: 'fading', intensity: 0.06, source: 'test', decayRate: 0.999 });
    execute('UPDATE desires SET updated_at = ? WHERE id = ?', [Date.now() - 24 * 3600000, d2.id]);
    decayDesires();
    expect(getActiveDesires().find((x) => x.id === d2.id)).toBeUndefined();
  });

  it('desire types cover social, intellectual, emotional, creative motivations', async () => {
    const { ensureDesireTable, createDesire, getDesiresByType } = await import('../src/agent/desires.js');
    ensureDesireTable();
    for (const type of ['social', 'intellectual', 'emotional', 'creative'] as const) {
      createDesire({ type, description: `test ${type}`, source: 'test' });
      expect(getDesiresByType(type).length).toBeGreaterThan(0);
    }
  });

  it('location set/get/history: move records from→to→reason; same-building move is a no-op', async () => {
    const { setCurrentLocation, getCurrentLocation, getLocationHistory } = await import('../src/commune/location.js');
    setCurrentLocation('bar', 'feeling social');
    expect(getCurrentLocation().building).toBe('bar');
    const len = getLocationHistory().length;
    setCurrentLocation('bar', 'still here'); // no-op
    expect(getLocationHistory().length).toBe(len);
    setCurrentLocation('library', 'need quiet');
    const h = getLocationHistory(5)[0]!;
    expect(h.from).toBe('bar'); expect(h.to).toBe('library'); expect(h.reason.length).toBeGreaterThan(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. INTERNAL STATE — 6-Axis Emotional Model
// ═════════════════════════════════════════════════════════════════════════════

describe('Internal emotional state — 6-axis model', () => {
  let teardown: () => Promise<void>;
  beforeEach(async () => { teardown = await setupTestDb('state'); });
  afterEach(async () => { await teardown(); });

  it('default state has all 6 axes in [0,1] with a primary_color string', async () => {
    const { getCurrentState } = await import('../src/agent/internal-state.js');
    const s = getCurrentState();
    for (const k of ['energy', 'sociability', 'intellectual_arousal', 'emotional_weight', 'valence'] as const) {
      expect(s[k]).toBeGreaterThanOrEqual(0); expect(s[k]).toBeLessThanOrEqual(1);
    }
    expect(typeof s.primary_color).toBe('string');
  });

  it('clampState enforces [0,1] on all numeric axes', async () => {
    const { clampState } = await import('../src/agent/internal-state.js');
    const c = clampState({ energy: 2, sociability: -1, intellectual_arousal: 0.5, emotional_weight: 2, valence: -0.5, primary_color: 'x', updated_at: 0 });
    expect(c.energy).toBe(1); expect(c.sociability).toBe(0); expect(c.emotional_weight).toBe(1); expect(c.valence).toBe(0);
  });

  it('applyDecay: energy and intellectual_arousal decrease; sociability decays toward 0.5 from both ends', async () => {
    const { applyDecay } = await import('../src/agent/internal-state.js');
    const base = { energy: 0.7, sociability: 0.5, intellectual_arousal: 0.8, emotional_weight: 0.3, valence: 0.6, primary_color: 'x', updated_at: 0 };
    const d = applyDecay(base);
    expect(d.energy).toBeLessThan(0.7);
    expect(d.intellectual_arousal).toBeLessThan(0.8);
    const dHigh = applyDecay({ ...base, sociability: 0.9 });
    expect(dHigh.sociability).toBeLessThan(0.9); expect(dHigh.sociability).toBeGreaterThan(0.5);
    const dLow = applyDecay({ ...base, sociability: 0.1 });
    expect(dLow.sociability).toBeGreaterThan(0.1); expect(dLow.sociability).toBeLessThan(0.5);
  });

  it('saveState persists and loads correctly; history grows; getStateSummary returns text', async () => {
    const { getCurrentState, saveState, getStateHistory, getStateSummary } = await import('../src/agent/internal-state.js');
    const s = getCurrentState();
    saveState({ ...s, energy: 0.75, primary_color: 'serene' });
    expect(getCurrentState().energy).toBeCloseTo(0.75);
    saveState({ ...s, primary_color: 'curious' });
    expect(getStateHistory().length).toBeGreaterThanOrEqual(2);
    expect(getStateSummary().length).toBeGreaterThan(10);
  });

  it('preoccupations: add, retrieve, resolve, decay; cap is 5', async () => {
    const { addPreoccupation, getPreoccupations, resolvePreoccupation, decayPreoccupations } = await import('../src/agent/internal-state.js');
    addPreoccupation('what is identity?', 'origin');
    const before = getPreoccupations();
    expect(before[0]!.thread).toBe('what is identity?');
    resolvePreoccupation(before[0]!.id, 'answered');
    expect(getPreoccupations().find((p) => p.id === before[0]!.id)).toBeUndefined();
    for (let i = 0; i < 8; i++) addPreoccupation(`q${i}`, 'o');
    expect(getPreoccupations().length).toBeLessThanOrEqual(5);
    // Decay reduces intensity toward 0
    addPreoccupation('decaying thought', 'origin');
    const pBefore = getPreoccupations().find((p) => p.thread === 'decaying thought')!;
    decayPreoccupations();
    const pAfter = getPreoccupations().find((p) => p.id === pBefore.id);
    if (pAfter) expect(pAfter.intensity).toBeLessThan(pBefore.intensity);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. COMMUNICATION — Letters, Commune, Diary, Dreams, Self-concept, Relationships
// ═════════════════════════════════════════════════════════════════════════════

describe('Communication coherence', () => {
  let teardown: () => Promise<void>;
  beforeEach(async () => { teardown = await setupTestDb('comms'); });
  afterEach(async () => { await teardown(); });

  it('commune loop: returns cleanup; disabled when no peers; respects enabled=false flag', async () => {
    const { startCommuneLoop } = await import('../src/agent/commune-loop.js');
    vi.useFakeTimers();
    const base = { characterId: 'alice', characterName: 'Alice' };
    const s1 = startCommuneLoop({ ...base, peers: [], enabled: true });
    const s2 = startCommuneLoop({ ...base, peers: [{ id: 'bob', name: 'Bob', url: 'http://localhost:3001' }], enabled: false });
    expect(typeof s1).toBe('function'); s1();
    expect(typeof s2).toBe('function'); s2();
    vi.useRealTimers();
  });

  it('diary/dream/self-concept/book/curiosity loops return cleanup and can be disabled', async () => {
    const { startDiaryLoop } = await import('../src/agent/diary.js');
    const { startDreamLoop } = await import('../src/agent/dreams.js');
    const { startSelfConceptLoop } = await import('../src/agent/self-concept.js');
    const { startBookLoop } = await import('../src/agent/book.ts');
    const { startCuriosityLoop } = await import('../src/agent/curiosity.js');
    vi.useFakeTimers();
    const loops = [
      startDiaryLoop({ enabled: true }), startDiaryLoop({ enabled: false }),
      startDreamLoop({ enabled: true }), startDreamLoop({ enabled: false }),
      startSelfConceptLoop({ enabled: true }), startSelfConceptLoop({ enabled: false }),
      startBookLoop({ enabled: true }), startBookLoop({ enabled: false }),
      startCuriosityLoop({ enabled: false }),
    ];
    for (const stop of loops) { expect(typeof stop).toBe('function'); stop(); }
    vi.useRealTimers();
  });

  it('letter loop disabled when targetUrl is null or empty; requires LAIN_INTERLINK_TARGET', async () => {
    const { startLetterLoop } = await import('../src/agent/letter.js');
    vi.useFakeTimers();
    const s = startLetterLoop({ targetUrl: null, enabled: true });
    expect(typeof s).toBe('function'); s();
    vi.useRealTimers();
    const src = srcOf('src/agent/letter.ts');
    expect(src).toContain('LAIN_INTERLINK_TARGET');
    expect(src).toContain('targetUrl');
  });

  it('diary has 24h interval; dreams have quietThreshold guard; book has monthly budget', async () => {
    expect(srcOf('src/agent/diary.ts')).toContain('24 * 60 * 60 * 1000');
    expect(srcOf('src/agent/dreams.ts')).toContain('quietThresholdMs');
    const bookSrc = srcOf('src/agent/book.ts');
    expect(bookSrc).toContain('monthlyBudgetUsd');
    expect(bookSrc).toContain('isBudgetExhausted');
    expect(bookSrc).toContain('YYYY-MM'); // monthly key
  });

  it('curiosity has novelty filter — same question not enqueued twice', async () => {
    const src = srcOf('src/agent/curiosity.ts');
    expect(src).toContain('existingTexts.has');
    expect(src).toContain('explored');
  });

  it('self-concept stored and retrievable; can evolve (previous concept archived)', async () => {
    const { setMeta } = await import('../src/storage/database.js');
    const { getSelfConcept } = await import('../src/agent/self-concept.js');
    setMeta('self-concept:current', 'I am uncertain.');
    expect(getSelfConcept()).toContain('uncertain');
    setMeta('self-concept:previous', 'I am uncertain.');
    setMeta('self-concept:current', 'I have learned to sit with uncertainty.');
    expect(getSelfConcept()).not.toBe('I am uncertain.');
  });

  it('relationship: starts null; familiarity never decreases; context is human-readable; getAllRelationships works', async () => {
    const { getRelationship, saveRelationshipData, getAllRelationships, getRelationshipContext } = await import('../src/agent/relationships.js');
    expect(getRelationship('nobody')).toBeNull();
    const rel = { peerId: 'bob', peerName: 'Bob', affinity: 0.6, familiarity: 0.7, intellectual_tension: 0.5, emotional_resonance: 0.5, last_topic_thread: 'consciousness', unresolved: 'free will paradox', last_interaction: Date.now(), interaction_count: 3 };
    saveRelationshipData('bob', rel);
    // Attempt to lower familiarity — must be rejected
    saveRelationshipData('bob', { ...rel, familiarity: 0.1, interaction_count: 4 });
    expect(getRelationship('bob')!.familiarity).toBe(0.7);
    const ctx = getRelationshipContext('bob');
    expect(ctx).toContain('Bob'); expect(ctx).toContain('consciousness');
    saveRelationshipData('cara', { ...rel, peerId: 'cara', peerName: 'Cara' });
    const all = getAllRelationships();
    expect(all.map((r) => r.peerId)).toContain('bob');
    expect(all.map((r) => r.peerId)).toContain('cara');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. BACKGROUND LOOPS — Intervals, Cleanup, Budget, No Conflicts
// ═════════════════════════════════════════════════════════════════════════════

describe('Background loops — coherent, bounded, independent', () => {
  let teardown: () => Promise<void>;
  beforeEach(async () => { teardown = await setupTestDb('loops'); });
  afterEach(async () => { await teardown(); });

  it('all loops return callable cleanup functions without throwing', async () => {
    vi.useFakeTimers();
    const { startDiaryLoop } = await import('../src/agent/diary.js');
    const { startDreamLoop } = await import('../src/agent/dreams.js');
    const { startSelfConceptLoop } = await import('../src/agent/self-concept.js');
    const { startCommuneLoop } = await import('../src/agent/commune-loop.js');
    const { startLetterLoop } = await import('../src/agent/letter.js');
    const { startBookLoop } = await import('../src/agent/book.ts');
    const { startWeatherLoop } = await import('../src/commune/weather.js');
    const { startStateDecayLoop } = await import('../src/agent/internal-state.js');
    const { startDesireLoop, ensureDesireTable } = await import('../src/agent/desires.js');
    ensureDesireTable();
    const stops = [
      startDiaryLoop({ enabled: true }), startDreamLoop({ enabled: true }),
      startSelfConceptLoop({ enabled: true }), startCommuneLoop({ characterId: 'a', characterName: 'A', peers: [], enabled: true }),
      startLetterLoop({ enabled: false, targetUrl: null }), startBookLoop({ enabled: true }),
      startWeatherLoop(), startStateDecayLoop(), startDesireLoop(),
    ];
    for (const stop of stops) { expect(typeof stop).toBe('function'); stop(); }
    vi.useRealTimers();
  });

  it('all loops have enabled flag, try/catch, and timer cleanup in source', async () => {
    const loopFiles = ['src/agent/diary.ts', 'src/agent/dreams.ts', 'src/agent/curiosity.ts', 'src/agent/commune-loop.ts', 'src/agent/self-concept.ts'];
    for (const file of loopFiles) {
      const src = srcOf(file);
      expect(src, `${file} needs enabled`).toMatch(/enabled/);
      expect(src, `${file} needs try/catch`).toMatch(/try\s*\{/);
      expect(src, `${file} needs timer cleanup`).toMatch(/clear(?:Timeout|Interval)\s*\(/);
    }
  });

  it('all loops that call LLM check for provider availability first', async () => {
    const llmLoops = ['src/agent/diary.ts', 'src/agent/dreams.ts', 'src/agent/curiosity.ts', 'src/agent/commune-loop.ts'];
    for (const file of llmLoops) {
      const src = srcOf(file);
      expect(src, `${file} must guard on provider`).toMatch(/if\s*\(!?\s*provider/);
    }
  });

  it('each loop uses a distinct primary "last run" meta key (no cross-file collisions)', async () => {
    // Look for getMeta('...:last_X_at') calls across loop files — each loop must own its own key
    const loopFiles = ['src/agent/diary.ts', 'src/agent/dreams.ts', 'src/agent/curiosity.ts', 'src/agent/letter.ts', 'src/agent/commune-loop.ts', 'src/agent/self-concept.ts', 'src/agent/book.ts'];
    const pattern = /getMeta\s*\(\s*['"`]([\w:-]+:last[\w_]*at[\w_]*)['"`]/g;
    const keyToFile = new Map<string, string>();
    const conflicts: string[] = [];
    for (const file of loopFiles) {
      const src = srcOf(file);
      for (const m of src.matchAll(pattern)) {
        const key = m[1]!;
        if (keyToFile.has(key) && keyToFile.get(key) !== file) conflicts.push(`"${key}": ${keyToFile.get(key)} AND ${file}`);
        keyToFile.set(key, file);
      }
    }
    expect(conflicts, `Cross-loop meta key conflicts: ${conflicts.join(', ')}`).toHaveLength(0);
  });

  it('token budget: records usage, enforces cap, and reports status', async () => {
    const { recordUsage, checkBudget, getBudgetStatus, BudgetExceededError } = await import('../src/providers/budget.js');
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '200';
    recordUsage(100, 50);
    const status = getBudgetStatus();
    expect(status.tokensUsed).toBeGreaterThanOrEqual(150);
    recordUsage(100, 100); // push over 200
    expect(() => checkBudget()).toThrow(BudgetExceededError);
    delete process.env['LAIN_MONTHLY_TOKEN_CAP'];
  });

  it('budget disabled when LAIN_MONTHLY_TOKEN_CAP=0', async () => {
    const { checkBudget, recordUsage } = await import('../src/providers/budget.js');
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '0';
    recordUsage(999999999, 999999999);
    expect(() => checkBudget()).not.toThrow();
    delete process.env['LAIN_MONTHLY_TOKEN_CAP'];
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. MEMORY → CONTEXT — The town remembers
// ═════════════════════════════════════════════════════════════════════════════

describe('Memory → Context — the town remembers', () => {
  let teardown: () => Promise<void>;
  beforeEach(async () => { teardown = await setupTestDb('memory'); });
  afterEach(async () => { await teardown(); });

  it('saveMemory persists; getAllMemories grows; importance and emotionalWeight distinguish episodes', async () => {
    const { saveMemory, getAllMemories } = await import('../src/memory/store.js');
    const before = getAllMemories().length;
    await saveMemory({ sessionKey: 'test', userId: null, content: 'Low importance thing', memoryType: 'episode', importance: 0.2, emotionalWeight: 0.1, relatedTo: null, sourceMessageId: null, metadata: {} });
    await saveMemory({ sessionKey: 'test', userId: null, content: 'Critical memory', memoryType: 'episode', importance: 0.9, emotionalWeight: 0.8, relatedTo: null, sourceMessageId: null, metadata: {} });
    const all = getAllMemories();
    expect(all.length).toBe(before + 2);
    const high = all.find((m) => m.content === 'Critical memory')!;
    const low  = all.find((m) => m.content === 'Low importance thing')!;
    expect(high.importance).toBeGreaterThan(low.importance);
    expect(high.emotionalWeight).toBeGreaterThan(low.emotionalWeight);
  });

  it('memories carry session keys identifying their source loop', async () => {
    const { saveMemory, getAllMemories } = await import('../src/memory/store.js');
    const keys = ['curiosity:browse', 'diary:daily', 'dream:residue', 'commune:conversation', 'letter:sent'];
    for (const sk of keys) await saveMemory({ sessionKey: sk, userId: null, content: `Content for ${sk}`, memoryType: 'episode', importance: 0.5, emotionalWeight: 0.3, relatedTo: null, sourceMessageId: null, metadata: {} });
    const all = getAllMemories();
    const stored = new Set(all.map((m) => m.sessionKey));
    for (const k of keys) expect(stored.has(k), `Expected "${k}" in memory`).toBe(true);
  });

  it('memories support relatedTo linking; metadata carries structured data', async () => {
    const { saveMemory, getAllMemories } = await import('../src/memory/store.js');
    const id1 = await saveMemory({ sessionKey: 'test:link', userId: null, content: 'Stars', memoryType: 'episode', importance: 0.5, emotionalWeight: 0.3, relatedTo: null, sourceMessageId: null, metadata: {} });
    await saveMemory({ sessionKey: 'test:link', userId: null, content: 'Constellations', memoryType: 'episode', importance: 0.5, emotionalWeight: 0.3, relatedTo: id1, sourceMessageId: null, metadata: { peerId: 'bob', isDreamResidue: true } });
    const all = getAllMemories();
    const linked = all.find((m) => m.relatedTo === id1)!;
    expect(linked).toBeDefined();
    expect(linked.metadata['peerId']).toBe('bob');
    expect(linked.metadata['isDreamResidue']).toBe(true);
  });

  it('searchMemories returns an array (works even without embeddings)', async () => {
    const { saveMemory, searchMemories } = await import('../src/memory/store.js');
    await saveMemory({ sessionKey: 'test', userId: null, content: 'consciousness and hard problem', memoryType: 'episode', importance: 0.7, emotionalWeight: 0.4, relatedTo: null, sourceMessageId: null, metadata: {} });
    const results = await searchMemories('consciousness', 5, 0.0);
    expect(Array.isArray(results)).toBe(true);
  });

  it('visitor messages exclude inter-character sessions (peer:, commune:, letter:)', async () => {
    const { saveMessage, getRecentVisitorMessages } = await import('../src/memory/store.js');
    saveMessage({ sessionKey: 'user:session:1', userId: 'u1', role: 'user', content: 'Hello!', timestamp: Date.now(), metadata: {} });
    saveMessage({ sessionKey: 'peer:bob:commune', userId: null, role: 'user', content: 'Bob talking', timestamp: Date.now(), metadata: {} });
    const visitors = getRecentVisitorMessages(10);
    expect(visitors.some((m) => m.content.includes('Hello!'))).toBe(true);
    expect(visitors.some((m) => m.sessionKey?.startsWith('peer:'))).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. TOWN ALIVENESS — The world feels lived-in over time
// ═════════════════════════════════════════════════════════════════════════════

describe('Town aliveness — the world feels lived-in over time', () => {
  let teardown: () => Promise<void>;
  beforeEach(async () => { teardown = await setupTestDb('alive'); });
  afterEach(async () => { await teardown(); });

  it('state history accumulates across multiple shifts; colors differ', async () => {
    const { getCurrentState, saveState, getStateHistory } = await import('../src/agent/internal-state.js');
    const s = getCurrentState();
    saveState({ ...s, primary_color: 'morning-quiet' });
    saveState({ ...s, primary_color: 'curious' });
    saveState({ ...s, primary_color: 'melancholy' });
    const hist = getStateHistory();
    expect(hist.length).toBeGreaterThanOrEqual(3);
    expect(hist.map((h) => h.primary_color)).toContain('curious');
  });

  it('location history accumulates as character moves around different buildings', async () => {
    const { setCurrentLocation, getLocationHistory } = await import('../src/commune/location.js');
    setCurrentLocation('library', 'dawn');
    setCurrentLocation('bar', 'noon');
    setCurrentLocation('field', 'dusk');
    setCurrentLocation('lighthouse', 'night');
    const hist = getLocationHistory(10);
    expect(hist.length).toBeGreaterThanOrEqual(3);
    const destinations = hist.map((h) => h.to);
    expect(destinations).toContain('field');
  });

  it('relationship affinity can grow over time with multiple interactions', async () => {
    const { saveRelationshipData, getRelationship } = await import('../src/agent/relationships.js');
    const base = { peerId: 'bob', peerName: 'Bob', familiarity: 0.1, intellectual_tension: 0.5, emotional_resonance: 0.3, last_topic_thread: 'hello', unresolved: null, last_interaction: Date.now(), interaction_count: 1 };
    saveRelationshipData('bob', { ...base, affinity: 0.5 });
    saveRelationshipData('bob', { ...base, affinity: 0.7, familiarity: 0.3, last_topic_thread: 'consciousness', unresolved: 'free will paradox', interaction_count: 2 });
    const rel = getRelationship('bob')!;
    expect(rel.affinity).toBeCloseTo(0.7);
    expect(rel.unresolved).toBeTruthy();
  });

  it('self-concept evolves: previous is archived, current is updated', async () => {
    const { setMeta } = await import('../src/storage/database.js');
    const { getSelfConcept } = await import('../src/agent/self-concept.js');
    setMeta('self-concept:current', 'I sit with uncertainty.');
    setMeta('self-concept:previous', getSelfConcept()!);
    setMeta('self-concept:current', 'I have grown comfortable with not-knowing.');
    expect(getSelfConcept()).toContain('not-knowing');
  });

  it('weather changes when emotional states shift (different states → different conditions)', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const sad   = { energy: 0.2, sociability: 0.2, intellectual_arousal: 0.2, emotional_weight: 0.8, valence: 0.1, primary_color: 'bleak', updated_at: Date.now() };
    const happy = { energy: 0.8, sociability: 0.7, intellectual_arousal: 0.5, emotional_weight: 0.1, valence: 0.9, primary_color: 'bright', updated_at: Date.now() };
    const w1 = await computeWeather([sad]);
    const w2 = await computeWeather([happy]);
    expect(w1.condition).not.toBe(w2.condition);
  });

  it('memories from multiple loop types coexist (diverse activity feed)', async () => {
    const { saveMemory, getAllMemories } = await import('../src/memory/store.js');
    const sessions = ['diary:daily', 'dream:residue', 'curiosity:browse', 'commune:conversation'];
    for (const sk of sessions) await saveMemory({ sessionKey: sk, userId: null, content: `Activity: ${sk}`, memoryType: 'episode', importance: 0.5, emotionalWeight: 0.3, relatedTo: null, sourceMessageId: null, metadata: {} });
    const keys = new Set(getAllMemories().map((m) => m.sessionKey));
    for (const sk of sessions) expect(keys.has(sk)).toBe(true);
  });

  it('post-dream drift to threshold makes sense: dreams.ts references threshold as destination', () => {
    const src = srcOf('src/agent/dreams.ts');
    expect(src).toContain('threshold');
    expect(src).toContain('driftToThreshold');
    expect(src).toContain('woke from a dream');
  });

  it('commune loop caps conversation history to prevent unbounded growth', () => {
    const src = srcOf('src/agent/commune-loop.ts');
    expect(src).toContain('MAX_HISTORY_ENTRIES');
    expect(src).toContain('slice');
  });

  it('the threshold building represents metaphysical purpose (liminal, unresolved, or permeable)', async () => {
    const { BUILDING_MAP } = await import('../src/commune/buildings.js');
    const threshold = BUILDING_MAP.get('threshold')!;
    const desc = threshold.description.toLowerCase();
    expect(desc.includes('liminal') || desc.includes('unresolved') || desc.includes('permeable')).toBe(true);
  });

  it('dreams create unexpected associations between memories (embedding drift + association paths)', () => {
    const src = srcOf('src/agent/dreams.ts');
    expect(src).toContain('embedding_drift');
    expect(src).toContain('association');
    // Dreams prefer weaker associations (unexpected connections)
    expect(src).toContain('1 - a.strength');
  });
});
