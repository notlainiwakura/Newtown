/**
 * Agent features: internal-state, awareness, desires, relationships, self-concept, experiments
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('keytar', () => ({
  default: { getPassword: vi.fn().mockResolvedValue('test-key'), setPassword: vi.fn(), deletePassword: vi.fn(), findCredentials: vi.fn().mockResolvedValue([]) },
}));

const _metaStore = new Map<string, string>();
vi.mock('../src/storage/database.js', () => ({
  getMeta: vi.fn((k: string) => _metaStore.get(k) ?? null),
  setMeta: vi.fn((k: string, v: string) => { _metaStore.set(k, v); }),
  execute: vi.fn(),
  query: vi.fn(() => []),
  queryOne: vi.fn(() => null),
}));
vi.mock('../src/utils/logger.js', () => ({ getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('../src/events/bus.js', () => ({ eventBus: { characterId: 'test-char', emitActivity: vi.fn(), on: vi.fn() } }));
vi.mock('../src/config/characters.js', () => ({ getDefaultLocations: vi.fn(() => ({ 'test-char': 'library', 'peer-a': 'bar' })) }));
vi.mock('../src/commune/location.js', () => ({ getCurrentLocation: vi.fn(() => ({ building: 'library' })), setCurrentLocation: vi.fn() }));
vi.mock('../src/memory/store.js', () => ({ saveMemory: vi.fn().mockResolvedValue(undefined), searchMemories: vi.fn().mockResolvedValue([]) }));
vi.mock('../src/memory/index.js', () => ({ getMemoryStats: vi.fn(() => ({ memories: 0 })) }));
vi.mock('../src/config/paths.js', () => ({ getBasePath: vi.fn(() => '/tmp/test-lain') }));

beforeEach(async () => {
  _metaStore.clear();
  vi.stubGlobal('fetch', vi.fn());
  vi.clearAllMocks();
  // Restore the _metaStore-based implementation after clearAllMocks
  const db = await import('../src/storage/database.js');
  vi.mocked(db.getMeta).mockImplementation((k: string) => _metaStore.get(k) ?? null);
  vi.mocked(db.setMeta).mockImplementation((k: string, v: string) => { _metaStore.set(k, v); });
  vi.mocked(db.query).mockImplementation(() => []);
  vi.mocked(db.queryOne).mockImplementation(() => null);
  vi.mocked(db.execute).mockImplementation(() => undefined as any);
});

// ── Internal State ──────────────────────────────────────────

describe('Internal State — clampState', () => {
  it('clamps energy above 1 to 1', async () => {
    const { clampState } = await import('../src/agent/internal-state.js');
    const s = { energy: 1.5, sociability: 0.5, intellectual_arousal: 0.5, emotional_weight: 0.5, valence: 0.5, primary_color: 'n', updated_at: 0 };
    expect(clampState(s).energy).toBe(1);
  });
  it('clamps energy below 0 to 0', async () => {
    const { clampState } = await import('../src/agent/internal-state.js');
    const s = { energy: -0.3, sociability: 0.5, intellectual_arousal: 0.5, emotional_weight: 0.5, valence: 0.5, primary_color: 'n', updated_at: 0 };
    expect(clampState(s).energy).toBe(0);
  });
  it('clamps sociability above 1', async () => {
    const { clampState } = await import('../src/agent/internal-state.js');
    expect(clampState({ energy: 0.5, sociability: 2, intellectual_arousal: 0.5, emotional_weight: 0.5, valence: 0.5, primary_color: 'n', updated_at: 0 }).sociability).toBe(1);
  });
  it('clamps valence above 1', async () => {
    const { clampState } = await import('../src/agent/internal-state.js');
    expect(clampState({ energy: 0.5, sociability: 0.5, intellectual_arousal: 0.5, emotional_weight: 0.5, valence: 1.5, primary_color: 'n', updated_at: 0 }).valence).toBe(1);
  });
  it('clamps emotional_weight below 0', async () => {
    const { clampState } = await import('../src/agent/internal-state.js');
    expect(clampState({ energy: 0.5, sociability: 0.5, intellectual_arousal: 0.5, emotional_weight: -0.5, valence: 0.5, primary_color: 'n', updated_at: 0 }).emotional_weight).toBe(0);
  });
  it('preserves primary_color', async () => {
    const { clampState } = await import('../src/agent/internal-state.js');
    expect(clampState({ energy: 0.5, sociability: 0.5, intellectual_arousal: 0.5, emotional_weight: 0.5, valence: 0.5, primary_color: 'melancholy', updated_at: 0 }).primary_color).toBe('melancholy');
  });
  it('valid values pass through unchanged', async () => {
    const { clampState } = await import('../src/agent/internal-state.js');
    const s = clampState({ energy: 0.7, sociability: 0.3, intellectual_arousal: 0.6, emotional_weight: 0.4, valence: 0.8, primary_color: 'calm', updated_at: 123 });
    expect(s.energy).toBe(0.7);
    expect(s.sociability).toBe(0.3);
  });
});

describe('Internal State — applyDecay', () => {
  const base = { energy: 0.8, sociability: 0.5, intellectual_arousal: 0.6, emotional_weight: 0.3, valence: 0.6, primary_color: 'n', updated_at: 0 };
  it('reduces energy by 0.02', async () => {
    const { applyDecay } = await import('../src/agent/internal-state.js');
    expect(applyDecay(base).energy).toBeCloseTo(0.78, 5);
  });
  it('reduces intellectual_arousal by 0.015', async () => {
    const { applyDecay } = await import('../src/agent/internal-state.js');
    expect(applyDecay(base).intellectual_arousal).toBeCloseTo(0.585, 5);
  });
  it('sociability above 0.5 decreases toward 0.5', async () => {
    const { applyDecay } = await import('../src/agent/internal-state.js');
    expect(applyDecay({ ...base, sociability: 0.9 }).sociability).toBeLessThan(0.9);
  });
  it('sociability below 0.5 increases toward 0.5', async () => {
    const { applyDecay } = await import('../src/agent/internal-state.js');
    expect(applyDecay({ ...base, sociability: 0.1 }).sociability).toBeGreaterThan(0.1);
  });
  it('values never decay below 0', async () => {
    const { applyDecay } = await import('../src/agent/internal-state.js');
    const d = applyDecay({ ...base, energy: 0.01, intellectual_arousal: 0.01 });
    expect(d.energy).toBeGreaterThanOrEqual(0);
    expect(d.intellectual_arousal).toBeGreaterThanOrEqual(0);
  });
});

describe('Internal State — getCurrentState / saveState', () => {
  it('returns default state with no stored data', async () => {
    const { getCurrentState } = await import('../src/agent/internal-state.js');
    const s = getCurrentState();
    expect(s.energy).toBeCloseTo(0.6);
    expect(s.primary_color).toBe('neutral');
  });
  it('returns stored state when present', async () => {
    const db = await import('../src/storage/database.js');
    _metaStore.set('internal:state', JSON.stringify({ energy: 0.3, sociability: 0.7, intellectual_arousal: 0.8, emotional_weight: 0.2, valence: 0.9, primary_color: 'bright', updated_at: Date.now() }));
    vi.mocked(db.getMeta).mockImplementation(k => _metaStore.get(k) ?? null);
    const { getCurrentState } = await import('../src/agent/internal-state.js');
    expect(getCurrentState().energy).toBe(0.3);
  });
  it('returns default on malformed JSON', async () => {
    _metaStore.set('internal:state', '{{bad-json');
    const { getCurrentState } = await import('../src/agent/internal-state.js');
    expect(getCurrentState().primary_color).toBe('neutral');
  });
  it('saveState calls setMeta', async () => {
    const db = await import('../src/storage/database.js');
    const { saveState } = await import('../src/agent/internal-state.js');
    saveState({ energy: 0.5, sociability: 0.5, intellectual_arousal: 0.5, emotional_weight: 0.5, valence: 0.5, primary_color: 'neutral', updated_at: 0 });
    expect(vi.mocked(db.setMeta)).toHaveBeenCalled();
  });
  it('saveState clamps values', async () => {
    const db = await import('../src/storage/database.js');
    const { saveState } = await import('../src/agent/internal-state.js');
    saveState({ energy: 5, sociability: -1, intellectual_arousal: 0.5, emotional_weight: 0.3, valence: 0.6, primary_color: 'test', updated_at: 0 });
    const call = vi.mocked(db.setMeta).mock.calls.find(c => c[0] === 'internal:state');
    const saved = JSON.parse(call![1]);
    expect(saved.energy).toBe(1);
    expect(saved.sociability).toBe(0);
  });
  it('saveState sets updated_at to current time', async () => {
    const db = await import('../src/storage/database.js');
    const { saveState } = await import('../src/agent/internal-state.js');
    const before = Date.now() - 1;
    saveState({ energy: 0.5, sociability: 0.5, intellectual_arousal: 0.5, emotional_weight: 0.5, valence: 0.5, primary_color: 'n', updated_at: 0 });
    const call = vi.mocked(db.setMeta).mock.calls.find(c => c[0] === 'internal:state');
    expect(JSON.parse(call![1]).updated_at).toBeGreaterThan(before);
  });
});

describe('Internal State — getStateSummary', () => {
  const setCurrentState = (partial: Record<string, unknown>) => {
    _metaStore.set('internal:state', JSON.stringify({ energy: 0.6, sociability: 0.5, intellectual_arousal: 0.4, emotional_weight: 0.3, valence: 0.6, primary_color: 'neutral', updated_at: Date.now(), ...partial }));
  };
  it('includes primary_color', async () => {
    setCurrentState({ primary_color: 'wistful' });
    const { getStateSummary } = await import('../src/agent/internal-state.js');
    expect(getStateSummary()).toContain('wistful');
  });
  it('says "mind buzzing" when intellectual_arousal > 0.6', async () => {
    setCurrentState({ intellectual_arousal: 0.8 });
    const { getStateSummary } = await import('../src/agent/internal-state.js');
    expect(getStateSummary()).toContain('mind buzzing');
  });
  it('says "wanting company" when sociability > 0.7', async () => {
    setCurrentState({ sociability: 0.8 });
    const { getStateSummary } = await import('../src/agent/internal-state.js');
    expect(getStateSummary()).toContain('wanting company');
  });
  it('says "mood is dark" when valence < 0.3', async () => {
    setCurrentState({ valence: 0.2 });
    const { getStateSummary } = await import('../src/agent/internal-state.js');
    expect(getStateSummary()).toContain('mood is dark');
  });
  it('says "mood is bright" when valence > 0.7', async () => {
    setCurrentState({ valence: 0.8 });
    const { getStateSummary } = await import('../src/agent/internal-state.js');
    expect(getStateSummary()).toContain('mood is bright');
  });
});

describe('Internal State — Preoccupations', () => {
  beforeEach(() => _metaStore.delete('preoccupations:current'));
  it('starts empty', async () => {
    const { getPreoccupations } = await import('../src/agent/internal-state.js');
    expect(getPreoccupations()).toEqual([]);
  });
  it('addPreoccupation creates entry with intensity 0.7', async () => {
    const { addPreoccupation, getPreoccupations } = await import('../src/agent/internal-state.js');
    addPreoccupation('what is the Wired?', 'conversation');
    const list = getPreoccupations();
    expect(list).toHaveLength(1);
    expect(list[0]!.intensity).toBe(0.7);
    expect(list[0]!.resolution).toBeNull();
  });
  it('resolvePreoccupation removes entry', async () => {
    const { addPreoccupation, resolvePreoccupation, getPreoccupations } = await import('../src/agent/internal-state.js');
    addPreoccupation('unanswered', 'test');
    const id = getPreoccupations()[0]!.id;
    resolvePreoccupation(id, 'resolved');
    expect(getPreoccupations()).toHaveLength(0);
  });
  it('decayPreoccupations reduces intensity by 0.05', async () => {
    const { addPreoccupation, decayPreoccupations, getPreoccupations } = await import('../src/agent/internal-state.js');
    addPreoccupation('thread', 'origin');
    decayPreoccupations();
    expect(getPreoccupations()[0]!.intensity).toBeCloseTo(0.65);
  });
  it('decayPreoccupations removes items below 0.1', async () => {
    // Inject low-intensity item via _metaStore directly
    _metaStore.set('preoccupations:current', JSON.stringify([{ id: 'x1', thread: 'fading', origin: 'test', originated_at: 0, intensity: 0.09, resolution: null }]));
    const { decayPreoccupations, getPreoccupations } = await import('../src/agent/internal-state.js');
    decayPreoccupations();
    expect(getPreoccupations()).toHaveLength(0);
  });
});

describe('Internal State — evaluateMovementDesire', () => {
  const state = { energy: 0.6, sociability: 0.5, intellectual_arousal: 0.5, emotional_weight: 0.3, valence: 0.6, primary_color: 'n', updated_at: 0 };
  it('returns null with no signals', async () => {
    const { evaluateMovementDesire } = await import('../src/agent/internal-state.js');
    expect(evaluateMovementDesire(state, [], [], 'library', new Map())).toBeNull();
  });
  it('high sociability pulls toward populated building', async () => {
    const { evaluateMovementDesire } = await import('../src/agent/internal-state.js');
    const result = evaluateMovementDesire({ ...state, sociability: 0.9 }, [], [], 'library', new Map([['p', 'bar'], ['q', 'bar']]));
    expect(result?.building).toBe('bar');
  });
  it('high emotional_weight triggers move to field', async () => {
    const { evaluateMovementDesire } = await import('../src/agent/internal-state.js');
    expect(evaluateMovementDesire({ ...state, emotional_weight: 0.9 }, [], [], 'library', new Map())?.building).toBe('field');
  });
  it('high intellectual_arousal pulls to library or lighthouse', async () => {
    const { evaluateMovementDesire } = await import('../src/agent/internal-state.js');
    const result = evaluateMovementDesire({ ...state, intellectual_arousal: 0.9 }, [], [], 'bar', new Map());
    expect(['library', 'lighthouse']).toContain(result?.building);
  });
  it('does not move to current building (field + emotional_weight)', async () => {
    const { evaluateMovementDesire } = await import('../src/agent/internal-state.js');
    const result = evaluateMovementDesire({ ...state, emotional_weight: 0.9 }, [], [], 'field', new Map());
    expect(result?.building).not.toBe('field');
  });
  it('confidence is capped at 1', async () => {
    const { evaluateMovementDesire } = await import('../src/agent/internal-state.js');
    const result = evaluateMovementDesire({ ...state, sociability: 1.0 }, [], [], 'library', new Map([['p', 'bar']]));
    if (result) expect(result.confidence).toBeLessThanOrEqual(1);
  });
});

// ── Awareness ───────────────────────────────────────────────

describe('Awareness — buildAwarenessContext', () => {
  it('returns empty string with no peers', async () => {
    const { buildAwarenessContext } = await import('../src/agent/awareness.js');
    expect(await buildAwarenessContext('library', [])).toBe('');
  });
  it('returns empty when peer is in different building', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ location: 'bar' }) } as Response);
    const { buildAwarenessContext } = await import('../src/agent/awareness.js');
    expect(await buildAwarenessContext('library', [{ id: 'a', name: 'Alice', url: 'http://localhost:3001' }])).toBe('');
  });
  it('includes peer name and Who\'s here block when co-located', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ location: 'library' }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ summary: 'calm' }) } as Response);
    const { buildAwarenessContext } = await import('../src/agent/awareness.js');
    const r = await buildAwarenessContext('library', [{ id: 'a', name: 'Peer A', url: 'http://localhost:3001' }]);
    expect(r).toContain('Peer A');
    expect(r).toContain("Who's here");
  });
  it('includes state summary when token is set', async () => {
    process.env['LAIN_INTERLINK_TOKEN'] = 'tok';
    process.env['LAIN_CHARACTER_ID'] = 'a-self';
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ location: 'library' }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ summary: 'anxious' }) } as Response);
    const { buildAwarenessContext } = await import('../src/agent/awareness.js');
    expect(await buildAwarenessContext('library', [{ id: 'a', name: 'A', url: 'http://localhost:3001' }])).toContain('anxious');
    delete process.env['LAIN_INTERLINK_TOKEN'];
    delete process.env['LAIN_CHARACTER_ID'];
  });
  it('handles network error gracefully', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('network error'));
    const { buildAwarenessContext } = await import('../src/agent/awareness.js');
    expect(await buildAwarenessContext('library', [{ id: 'a', name: 'A', url: 'http://localhost:3001' }])).toBe('');
  });
  it('handles non-ok location response', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false } as Response);
    const { buildAwarenessContext } = await import('../src/agent/awareness.js');
    expect(await buildAwarenessContext('library', [{ id: 'a', name: 'A', url: 'http://localhost:3001' }])).toBe('');
  });
  it('only includes co-located peer when one of two is in another building', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ location: 'library' }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ summary: '' }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ location: 'bar' }) } as Response);
    const { buildAwarenessContext } = await import('../src/agent/awareness.js');
    const peers = [{ id: 'a', name: 'Alice', url: 'http://localhost:3001' }, { id: 'b', name: 'Bob', url: 'http://localhost:3002' }];
    const r = await buildAwarenessContext('library', peers);
    expect(r).toContain('Alice');
    expect(r).not.toContain('Bob');
  });
  it('includes all co-located peers when multiple share same building', async () => {
    vi.mocked(fetch).mockImplementation(async (url: string | URL | Request) => {
      const s = url.toString();
      if (s.includes('/api/location')) return { ok: true, json: async () => ({ location: 'bar' }) } as Response;
      return { ok: true, json: async () => ({ summary: '' }) } as Response;
    });
    const { buildAwarenessContext } = await import('../src/agent/awareness.js');
    const r = await buildAwarenessContext('bar', [{ id: 'a', name: 'Alice', url: 'http://localhost:3001' }, { id: 'b', name: 'Bob', url: 'http://localhost:3002' }]);
    expect(r).toContain('Alice');
    expect(r).toContain('Bob');
  });
});

// ── Desires ─────────────────────────────────────────────────

describe('Desires — createDesire', () => {
  it('creates desire with required fields and defaults', async () => {
    const { createDesire } = await import('../src/agent/desires.js');
    const d = createDesire({ type: 'social', description: 'want to talk', source: 'test' });
    expect(d.type).toBe('social');
    expect(d.intensity).toBe(0.5);
    expect(d.resolvedAt).toBeNull();
  });
  it('clamps intensity above 1', async () => {
    const { createDesire } = await import('../src/agent/desires.js');
    expect(createDesire({ type: 'intellectual', description: 't', source: 't', intensity: 1.5 }).intensity).toBe(1);
  });
  it('clamps intensity below 0', async () => {
    const { createDesire } = await import('../src/agent/desires.js');
    expect(createDesire({ type: 'intellectual', description: 't', source: 't', intensity: -0.5 }).intensity).toBe(0);
  });
  it('stores targetPeer', async () => {
    const { createDesire } = await import('../src/agent/desires.js');
    expect(createDesire({ type: 'social', description: 't', source: 'dream', targetPeer: 'lain' }).targetPeer).toBe('lain');
  });
  it('uses custom decayRate', async () => {
    const { createDesire } = await import('../src/agent/desires.js');
    expect(createDesire({ type: 'creative', description: 't', source: 't', decayRate: 0.1 }).decayRate).toBe(0.1);
  });
  it('generates unique IDs', async () => {
    const { createDesire } = await import('../src/agent/desires.js');
    const a = createDesire({ type: 'social', description: 't1', source: 't' });
    const b = createDesire({ type: 'social', description: 't2', source: 't' });
    expect(a.id).not.toBe(b.id);
  });
});

describe('Desires — getDesireContext', () => {
  const makeRow = (intensity: number, targetPeer: string | null = null) => ({
    id: 'd1', type: 'intellectual', description: 'understand recursion', intensity,
    source: 'test', source_detail: null, target_peer: targetPeer,
    created_at: Date.now(), updated_at: Date.now(), resolved_at: null, resolution: null, decay_rate: 0.04,
  });
  it('returns empty string with no desires', async () => {
    const db = await import('../src/storage/database.js');
    vi.mocked(db.query).mockReturnValueOnce([]);
    const { getDesireContext } = await import('../src/agent/desires.js');
    expect(getDesireContext()).toBe('');
  });
  it('"[pull: strong]" for intensity > 0.7', async () => {
    const db = await import('../src/storage/database.js');
    vi.mocked(db.query).mockReturnValueOnce([makeRow(0.8)]);
    const { getDesireContext } = await import('../src/agent/desires.js');
    expect(getDesireContext()).toContain('[pull: strong]');
  });
  it('"[pull: moderate]" for mid-range intensity', async () => {
    const db = await import('../src/storage/database.js');
    vi.mocked(db.query).mockReturnValueOnce([makeRow(0.5)]);
    const { getDesireContext } = await import('../src/agent/desires.js');
    expect(getDesireContext()).toContain('[pull: moderate]');
  });
  it('"[pull: faint]" for low intensity', async () => {
    const db = await import('../src/storage/database.js');
    vi.mocked(db.query).mockReturnValueOnce([makeRow(0.3)]);
    const { getDesireContext } = await import('../src/agent/desires.js');
    expect(getDesireContext()).toContain('[pull: faint]');
  });
  it('includes target peer name', async () => {
    const db = await import('../src/storage/database.js');
    vi.mocked(db.query).mockReturnValueOnce([makeRow(0.6, 'lain')]);
    const { getDesireContext } = await import('../src/agent/desires.js');
    expect(getDesireContext()).toContain('lain');
  });
});

describe('Desires — checkLoneliness', () => {
  it('returns null if under 6h threshold', async () => {
    const { checkLoneliness } = await import('../src/agent/desires.js');
    expect(await checkLoneliness(5 * 60 * 60 * 1000)).toBeNull();
  });
  it('returns null if already has 2+ social desires', async () => {
    const db = await import('../src/storage/database.js');
    vi.mocked(db.query).mockReturnValueOnce([
      { id: 'd1', type: 'social', description: 'lonely', intensity: 0.6, source: 't', source_detail: null, target_peer: null, created_at: 0, updated_at: 0, resolved_at: null, resolution: null, decay_rate: 0.04 },
      { id: 'd2', type: 'social', description: 'lonely2', intensity: 0.5, source: 't', source_detail: null, target_peer: null, created_at: 0, updated_at: 0, resolved_at: null, resolution: null, decay_rate: 0.04 },
    ]);
    const { checkLoneliness } = await import('../src/agent/desires.js');
    expect(await checkLoneliness(8 * 60 * 60 * 1000)).toBeNull();
  });
});

// ── Relationships ───────────────────────────────────────────

describe('Relationships', () => {
  const makeRel = (peerId: string, peerName: string, overrides: Record<string, unknown> = {}) => ({
    peerId, peerName, affinity: 0.5, familiarity: 0.3, intellectual_tension: 0.5, emotional_resonance: 0.3,
    last_topic_thread: '', unresolved: null, last_interaction: 0, interaction_count: 1, ...overrides,
  });
  const storeRel = (peerId: string, rel: Record<string, unknown>) => _metaStore.set(`relationship:${peerId}`, JSON.stringify(rel));

  it('getRelationship returns null for unknown peer', async () => {
    const { getRelationship } = await import('../src/agent/relationships.js');
    expect(getRelationship('nobody')).toBeNull();
  });
  it('getRelationship returns stored relationship', async () => {
    storeRel('lain', makeRel('lain', 'Lain', { affinity: 0.7 }));
    const { getRelationship } = await import('../src/agent/relationships.js');
    expect(getRelationship('lain')!.affinity).toBe(0.7);
  });
  it('familiarity cannot decrease via saveRelationshipData', async () => {
    storeRel('pkd', makeRel('pkd', 'PKD', { familiarity: 0.6 }));
    const { saveRelationshipData } = await import('../src/agent/relationships.js');
    saveRelationshipData('pkd', makeRel('pkd', 'PKD', { familiarity: 0.4 }) as any);
    const saved = JSON.parse(_metaStore.get('relationship:pkd')!);
    expect(saved.familiarity).toBe(0.6);
  });
  it('getRelationshipContext returns "No prior relationship" for unknown', async () => {
    const { getRelationshipContext } = await import('../src/agent/relationships.js');
    expect(getRelationshipContext('nobody')).toContain('No prior relationship');
  });
  it('getRelationshipContext includes "warm" for high affinity', async () => {
    storeRel('lain', makeRel('lain', 'Lain', { affinity: 0.8, last_topic_thread: 'the Wired', unresolved: 'what is real?' }));
    const { getRelationshipContext } = await import('../src/agent/relationships.js');
    const ctx = getRelationshipContext('lain');
    expect(ctx).toContain('warm');
    expect(ctx).toContain('the Wired');
    expect(ctx).toContain('what is real?');
  });
  it('getRelationshipContext includes "cool" for low affinity', async () => {
    storeRel('john', makeRel('john', 'John', { affinity: 0.2 }));
    const { getRelationshipContext } = await import('../src/agent/relationships.js');
    expect(getRelationshipContext('john')).toContain('cool');
  });
  it('getRelationshipContext includes interaction count', async () => {
    storeRel('mck', makeRel('mck', 'McKenna', { interaction_count: 42 }));
    const { getRelationshipContext } = await import('../src/agent/relationships.js');
    expect(getRelationshipContext('mck')).toContain('42');
  });
  it('getAllRelationships returns empty when no rows', async () => {
    const db = await import('../src/storage/database.js');
    vi.mocked(db.query).mockImplementationOnce(() => []);
    const { getAllRelationships } = await import('../src/agent/relationships.js');
    expect(getAllRelationships()).toEqual([]);
  });
  it('getAllRelationships parses multiple rows', async () => {
    const db = await import('../src/storage/database.js');
    vi.mocked(db.query).mockImplementationOnce(() => [
      { key: 'relationship:lain', value: JSON.stringify(makeRel('lain', 'Lain')) },
      { key: 'relationship:pkd', value: JSON.stringify(makeRel('pkd', 'PKD')) },
    ] as any);
    const { getAllRelationships } = await import('../src/agent/relationships.js');
    expect(getAllRelationships()).toHaveLength(2);
  });
});

// ── Self-Concept ─────────────────────────────────────────────

describe('Self-Concept', () => {
  it('getSelfConcept returns stored concept', async () => {
    _metaStore.set('self-concept:current', 'I am between worlds...');
    const { getSelfConcept } = await import('../src/agent/self-concept.js');
    expect(getSelfConcept()).toBe('I am between worlds...');
  });
  it('getSelfConcept returns null when absent', async () => {
    _metaStore.delete('self-concept:current');
    const { getSelfConcept } = await import('../src/agent/self-concept.js');
    expect(getSelfConcept()).toBeNull();
  });
  it('startSelfConceptLoop returns stop function', async () => {
    const { startSelfConceptLoop } = await import('../src/agent/self-concept.js');
    const stop = startSelfConceptLoop({ enabled: false });
    expect(typeof stop).toBe('function');
    stop();
  });
  it('disabled loop is a no-op', async () => {
    const { startSelfConceptLoop } = await import('../src/agent/self-concept.js');
    const stop = startSelfConceptLoop({ enabled: false });
    stop();
  });
  it('stop is idempotent', async () => {
    const { startSelfConceptLoop } = await import('../src/agent/self-concept.js');
    const stop = startSelfConceptLoop({ enabled: false });
    stop();
    expect(() => stop()).not.toThrow();
  });
  it('accepts custom minDiaryEntries', async () => {
    const { startSelfConceptLoop } = await import('../src/agent/self-concept.js');
    const stop = startSelfConceptLoop({ enabled: false, minDiaryEntries: 3 });
    stop();
  });
});

// ── Experiments ──────────────────────────────────────────────

describe('Experiments', () => {
  it('startExperimentLoop returns stop function', async () => {
    const { startExperimentLoop } = await import('../src/agent/experiments.js');
    const stop = startExperimentLoop({ enabled: false });
    expect(typeof stop).toBe('function');
    stop();
  });
  it('disabled loop is a no-op', async () => {
    const { startExperimentLoop } = await import('../src/agent/experiments.js');
    startExperimentLoop({ enabled: false })();
  });
  it('stop is idempotent', async () => {
    const { startExperimentLoop } = await import('../src/agent/experiments.js');
    const stop = startExperimentLoop({ enabled: false });
    stop();
    expect(() => stop()).not.toThrow();
  });
  it('accepts custom dailyBudgetUsd', async () => {
    const { startExperimentLoop } = await import('../src/agent/experiments.js');
    startExperimentLoop({ enabled: false, dailyBudgetUsd: 0.50 })();
  });
  it('accepts custom executionTimeoutMs', async () => {
    const { startExperimentLoop } = await import('../src/agent/experiments.js');
    startExperimentLoop({ enabled: false, executionTimeoutMs: 5 * 60 * 1000 })();
  });
  it('accepts custom maxCodeLines', async () => {
    const { startExperimentLoop } = await import('../src/agent/experiments.js');
    startExperimentLoop({ enabled: false, maxCodeLines: 150 })();
  });
  it('daily spend starts at 0 with no meta', async () => {
    const db = await import('../src/storage/database.js');
    vi.mocked(db.getMeta).mockReturnValue(null);
    const { startExperimentLoop } = await import('../src/agent/experiments.js');
    startExperimentLoop({ enabled: false })();
  });
  it('budget key format is YYYY-MM-DD', () => {
    const dateKey = new Date().toISOString().slice(0, 10);
    expect(dateKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
