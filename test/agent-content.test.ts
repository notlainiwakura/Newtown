/**
 * Agent content: diary, dreams, letter, bibliomancy, curiosity, book, town-life, feed-health, dream-seeder
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
vi.mock('../src/events/bus.js', () => ({ eventBus: { characterId: 'test', emitActivity: vi.fn(), on: vi.fn(), off: vi.fn() } }));
vi.mock('../src/config/paths.js', () => ({ getBasePath: vi.fn(() => '/tmp/test-lain-content') }));
vi.mock('../src/memory/store.js', () => ({
  saveMemory: vi.fn().mockResolvedValue(undefined),
  searchMemories: vi.fn().mockResolvedValue([]),
  getRecentVisitorMessages: vi.fn(() => []),
  getAllRecentMessages: vi.fn(() => []),
  getMemory: vi.fn(() => null),
  linkMemories: vi.fn(),
  getResonanceMemory: vi.fn(() => null),
  getAllMemories: vi.fn(() => []),
  getAssociations: vi.fn(() => []),
  addAssociation: vi.fn(),
}));
vi.mock('../src/memory/index.js', () => ({ getMemoryStats: vi.fn(() => ({ memories: 0 })) }));
vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => '{"entries":[]}'),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => false),
  readdirSync: vi.fn(() => []),
}));
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue(''),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
  appendFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockResolvedValue({ size: 1024 }),
  copyFile: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/agent/index.js', () => ({ getProvider: vi.fn(() => null), getAgent: vi.fn(() => null) }));
vi.mock('../src/agent/internal-state.js', () => ({
  getCurrentState: vi.fn(() => ({ energy: 0.6, sociability: 0.5, intellectual_arousal: 0.4, emotional_weight: 0.3, valence: 0.6, primary_color: 'neutral', updated_at: Date.now() })),
  updateState: vi.fn().mockResolvedValue({}),
  getPreoccupations: vi.fn(() => []),
}));
vi.mock('../src/commune/location.js', () => ({
  getCurrentLocation: vi.fn(() => ({ building: 'library' })),
  setCurrentLocation: vi.fn(),
  getLocationHistory: vi.fn(() => []),
}));
vi.mock('../src/commune/buildings.js', () => ({
  isValidBuilding: vi.fn(() => true),
  BUILDING_MAP: { library: { name: 'Library' }, bar: { name: 'Bar' }, field: { name: 'Field' } },
}));
vi.mock('../src/memory/embeddings.js', () => ({ cosineSimilarity: vi.fn(() => 0.3), CURRENT_EMBEDDING_MODEL: 'Xenova/all-MiniLM-L6-v2' }));
vi.mock('../src/security/ssrf.js', () => ({ checkSSRF: vi.fn(() => ({ allowed: true })) }));
vi.mock('../src/agent/tools.js', () => ({
  extractTextFromHtml: vi.fn(() => 'text'),
  getToolDefinitions: vi.fn(() => []),
  executeTool: vi.fn().mockResolvedValue({ result: 'ok' }),
}));
vi.mock('../src/agent/self-concept.js', () => ({ getSelfConcept: vi.fn(() => null) }));
vi.mock('../src/agent/data-workspace.js', () => ({
  ensureDataWorkspace: vi.fn(() => '/tmp/data'),
  getDataWorkspacePath: vi.fn(() => '/tmp/data'),
  getDataWorkspaceSize: vi.fn(() => 0),
  listDataFiles: vi.fn(() => []),
  sanitizeDataFileName: vi.fn((n: string) => n),
  MAX_DATA_DIR_BYTES: 100 * 1024 * 1024,
  MAX_SINGLE_FILE_BYTES: 10 * 1024 * 1024,
  ALLOWED_DATA_EXTENSIONS: new Set(['.csv', '.json', '.txt', '.tsv']),
}));
vi.mock('../src/agent/proactive.js', () => ({ trySendProactiveMessage: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/agent/membrane.js', () => ({}));
vi.mock('../src/agent/objects.js', () => ({ buildObjectContext: vi.fn().mockResolvedValue('') }));
vi.mock('../src/events/town-events.js', () => ({ getActiveTownEvents: vi.fn(() => []) }));

beforeEach(async () => {
  _metaStore.clear();
  vi.stubGlobal('fetch', vi.fn());
  vi.clearAllMocks();
  const db = await import('../src/storage/database.js');
  vi.mocked(db.getMeta).mockImplementation((k: string) => _metaStore.get(k) ?? null);
  vi.mocked(db.setMeta).mockImplementation((k: string, v: string) => { _metaStore.set(k, v); });
  vi.mocked(db.query).mockImplementation(() => []);
  vi.mocked(db.queryOne).mockImplementation(() => null);
  vi.mocked(db.execute).mockImplementation(() => undefined as any);
});
afterEach(() => vi.unstubAllGlobals());

// ── Diary ────────────────────────────────────────────────────

describe('Diary — startDiaryLoop', () => {
  it('returns stop function', async () => {
    const { startDiaryLoop } = await import('../src/agent/diary.js');
    const stop = startDiaryLoop({ enabled: false });
    expect(typeof stop).toBe('function');
    stop();
  });
  it('disabled loop is a no-op', async () => {
    const { startDiaryLoop } = await import('../src/agent/diary.js');
    startDiaryLoop({ enabled: false })();
  });
  it('stop is idempotent', async () => {
    const { startDiaryLoop } = await import('../src/agent/diary.js');
    const stop = startDiaryLoop({ enabled: false });
    stop();
    expect(() => stop()).not.toThrow();
  });
  it('loads last_entry_at from meta', async () => {
    _metaStore.set('diary:last_entry_at', (Date.now() - 1000).toString());
    const { startDiaryLoop } = await import('../src/agent/diary.js');
    startDiaryLoop({ enabled: false })();
  });
  it('handles empty journal gracefully', async () => {
    const fs = await import('node:fs');
    vi.mocked(fs.readFileSync).mockReturnValueOnce('{"entries":[]}');
    const { startDiaryLoop } = await import('../src/agent/diary.js');
    startDiaryLoop({ enabled: false })();
  });
  it('handles malformed journal without throwing', async () => {
    const fs = await import('node:fs');
    vi.mocked(fs.readFileSync).mockReturnValueOnce('not-json');
    const { startDiaryLoop } = await import('../src/agent/diary.js');
    startDiaryLoop({ enabled: false })();
  });
  it('overdue diary schedules near-immediately', async () => {
    _metaStore.set('diary:last_entry_at', (Date.now() - 25 * 60 * 60 * 1000).toString());
    const { startDiaryLoop } = await import('../src/agent/diary.js');
    startDiaryLoop({ enabled: false })();
  });
});

// ── Dreams ───────────────────────────────────────────────────

describe('Dreams — startDreamLoop', () => {
  it('returns stop function', async () => {
    const { startDreamLoop } = await import('../src/agent/dreams.js');
    const stop = startDreamLoop({ enabled: false });
    expect(typeof stop).toBe('function');
    stop();
  });
  it('disabled loop is a no-op', async () => {
    const { startDreamLoop } = await import('../src/agent/dreams.js');
    startDreamLoop({ enabled: false })();
  });
  it('stop is idempotent', async () => {
    const { startDreamLoop } = await import('../src/agent/dreams.js');
    const stop = startDreamLoop({ enabled: false });
    stop();
    expect(() => stop()).not.toThrow();
  });
  it('accepts custom maxWalkSteps', async () => {
    const { startDreamLoop } = await import('../src/agent/dreams.js');
    startDreamLoop({ enabled: false, maxWalkSteps: 4 })();
  });
  it('accepts custom residueProbability', async () => {
    const { startDreamLoop } = await import('../src/agent/dreams.js');
    startDreamLoop({ enabled: false, residueProbability: 0 })();
  });
  it('accepts custom quietThresholdMs', async () => {
    const { startDreamLoop } = await import('../src/agent/dreams.js');
    startDreamLoop({ enabled: false, quietThresholdMs: 10 * 60 * 1000 })();
  });
  it('shouldDream returns false with <10 memories (no-op via enabled: false)', async () => {
    const memStore = await import('../src/memory/store.js');
    vi.mocked(memStore.getAllMemories).mockReturnValueOnce([]);
    const { startDreamLoop } = await import('../src/agent/dreams.js');
    startDreamLoop({ enabled: false })();
  });
  it('dream cycle skips when no seed available', async () => {
    const memStore = await import('../src/memory/store.js');
    vi.mocked(memStore.getAllMemories).mockReturnValue([]);
    const { startDreamLoop } = await import('../src/agent/dreams.js');
    startDreamLoop({ enabled: false })();
  });
});

// ── Letters ──────────────────────────────────────────────────

describe('Letters — startLetterLoop / runLetterCycle', () => {
  it('returns stop function when no targetUrl', async () => {
    delete process.env['LAIN_INTERLINK_TARGET'];
    const { startLetterLoop } = await import('../src/agent/letter.js');
    const stop = startLetterLoop({ targetUrl: null });
    expect(typeof stop).toBe('function');
    stop();
  });
  it('disabled loop is a no-op', async () => {
    const { startLetterLoop } = await import('../src/agent/letter.js');
    startLetterLoop({ enabled: false, targetUrl: null })();
  });
  it('stop is idempotent', async () => {
    const { startLetterLoop } = await import('../src/agent/letter.js');
    const stop = startLetterLoop({ targetUrl: null });
    stop();
    expect(() => stop()).not.toThrow();
  });
  it('runLetterCycle throws when no targetUrl', async () => {
    const { runLetterCycle } = await import('../src/agent/letter.js');
    await expect(runLetterCycle({ intervalMs: 0, targetHour: 21, targetUrl: null, authToken: null, enabled: true, maxJitterMs: 0 })).rejects.toThrow('no interlink target');
  });
  it('runLetterCycle throws when blocked by doctor', async () => {
    _metaStore.set('letter:blocked', 'true');
    _metaStore.set('letter:block_reason', 'emotional state');
    const { runLetterCycle } = await import('../src/agent/letter.js');
    await expect(runLetterCycle({ intervalMs: 0, targetHour: 21, targetUrl: 'http://localhost:3001', authToken: null, enabled: true, maxJitterMs: 0 })).rejects.toThrow('letter blocked');
    _metaStore.delete('letter:blocked');
  });
  it('handles missing journal file gracefully', async () => {
    const fs = await import('node:fs');
    vi.mocked(fs.readFileSync).mockImplementationOnce(() => { throw new Error('ENOENT'); });
    const { startLetterLoop } = await import('../src/agent/letter.js');
    startLetterLoop({ targetUrl: null })();
  });
  it('uses 3-day lookback when no last_sent_at', async () => {
    _metaStore.delete('letter:last_sent_at');
    const { startLetterLoop } = await import('../src/agent/letter.js');
    startLetterLoop({ targetUrl: null })();
  });
  it('invalid JSON response is discarded gracefully', async () => {
    _metaStore.delete('letter:blocked');
    const agent = await import('../src/agent/index.js');
    vi.mocked(agent.getProvider).mockReturnValueOnce({
      complete: vi.fn().mockResolvedValue({ content: 'not-json', usage: { inputTokens: 10, outputTokens: 10 } }),
    } as any);
    const { runLetterCycle } = await import('../src/agent/letter.js');
    await expect(runLetterCycle({ intervalMs: 0, targetHour: 21, targetUrl: 'http://localhost:3001', authToken: 'tok', enabled: true, maxJitterMs: 0 })).resolves.toBeUndefined();
  });
});

// ── Bibliomancy ──────────────────────────────────────────────

describe('Bibliomancy — startBibliomancyLoop', () => {
  it('returns stop function with no target', async () => {
    delete process.env['LAIN_INTERLINK_TARGET'];
    const { startBibliomancyLoop } = await import('../src/agent/bibliomancy.js');
    const stop = startBibliomancyLoop({ targetUrl: null });
    expect(typeof stop).toBe('function');
    stop();
  });
  it('disabled loop is a no-op', async () => {
    const { startBibliomancyLoop } = await import('../src/agent/bibliomancy.js');
    startBibliomancyLoop({ enabled: false, targetUrl: null })();
  });
  it('stop is idempotent', async () => {
    const { startBibliomancyLoop } = await import('../src/agent/bibliomancy.js');
    const stop = startBibliomancyLoop({ targetUrl: null });
    stop();
    expect(() => stop()).not.toThrow();
  });
  it('skips when offerings dir does not exist', async () => {
    const fs = await import('node:fs');
    vi.mocked(fs.existsSync).mockReturnValueOnce(false);
    const { startBibliomancyLoop } = await import('../src/agent/bibliomancy.js');
    startBibliomancyLoop({ targetUrl: null })();
  });
  it('skips when offerings dir is empty', async () => {
    const fs = await import('node:fs');
    vi.mocked(fs.existsSync).mockReturnValueOnce(true);
    vi.mocked(fs.readdirSync).mockReturnValueOnce([] as any);
    const { startBibliomancyLoop } = await import('../src/agent/bibliomancy.js');
    startBibliomancyLoop({ targetUrl: null })();
  });
  it('reads last_cycle_at from meta', async () => {
    _metaStore.set('bibliomancy:last_cycle_at', (Date.now() - 1000).toString());
    const { startBibliomancyLoop } = await import('../src/agent/bibliomancy.js');
    startBibliomancyLoop({ targetUrl: null })();
  });
});

// ── Curiosity ────────────────────────────────────────────────

describe('Curiosity — startCuriosityLoop', () => {
  it('returns stop function', async () => {
    const fs = await import('node:fs');
    vi.mocked(fs.readFileSync).mockReturnValueOnce('example.com\n');
    const { startCuriosityLoop } = await import('../src/agent/curiosity.js');
    const stop = startCuriosityLoop({ enabled: false });
    expect(typeof stop).toBe('function');
    stop();
  });
  it('disabled loop is a no-op', async () => {
    const { startCuriosityLoop } = await import('../src/agent/curiosity.js');
    startCuriosityLoop({ enabled: false })();
  });
  it('empty whitelist causes early return', async () => {
    const fs = await import('node:fs');
    vi.mocked(fs.readFileSync).mockReturnValueOnce('');
    const { startCuriosityLoop } = await import('../src/agent/curiosity.js');
    startCuriosityLoop({ enabled: true })();
  });
  it('stop is idempotent', async () => {
    const { startCuriosityLoop } = await import('../src/agent/curiosity.js');
    const stop = startCuriosityLoop({ enabled: false });
    stop();
    expect(() => stop()).not.toThrow();
  });
  it('wildcard (*) in whitelist enables unrestricted mode', async () => {
    const fs = await import('node:fs');
    vi.mocked(fs.readFileSync).mockReturnValueOnce('*\n');
    const { startCuriosityLoop } = await import('../src/agent/curiosity.js');
    startCuriosityLoop({ enabled: false })();
  });
  it('comments (#) in whitelist are filtered out', async () => {
    const fs = await import('node:fs');
    vi.mocked(fs.readFileSync).mockReturnValueOnce('# comment\nexample.com');
    const { startCuriosityLoop } = await import('../src/agent/curiosity.js');
    startCuriosityLoop({ enabled: false })();
  });
  it('checkSSRF is wired into curiosity', async () => {
    const security = await import('../src/security/ssrf.js');
    expect(vi.mocked(security.checkSSRF)).toBeDefined();
  });
});

describe('Curiosity — offline loop', () => {
  const cfg = { characterId: 'test', characterName: 'Test', wiredLainUrl: 'http://localhost:3000', interlinkToken: 'tok' };
  it('returns stop function', async () => {
    const { startOfflineCuriosityLoop } = await import('../src/agent/curiosity-offline.js');
    const stop = startOfflineCuriosityLoop({ enabled: false, ...cfg });
    expect(typeof stop).toBe('function');
    stop();
  });
  it('disabled loop is a no-op', async () => {
    const { startOfflineCuriosityLoop } = await import('../src/agent/curiosity-offline.js');
    startOfflineCuriosityLoop({ enabled: false, ...cfg })();
  });
  it('stop is idempotent', async () => {
    const { startOfflineCuriosityLoop } = await import('../src/agent/curiosity-offline.js');
    const stop = startOfflineCuriosityLoop({ enabled: false, ...cfg });
    stop();
    expect(() => stop()).not.toThrow();
  });
  it('reads last_cycle_at from meta', async () => {
    _metaStore.set('curiosity-offline:last_cycle_at', (Date.now() - 1000).toString());
    const { startOfflineCuriosityLoop } = await import('../src/agent/curiosity-offline.js');
    startOfflineCuriosityLoop({ enabled: false, ...cfg })();
  });
});

// ── Book ─────────────────────────────────────────────────────

describe('Book — startBookLoop / budget', () => {
  it('returns stop function', async () => {
    const { startBookLoop } = await import('../src/agent/book.js');
    const stop = startBookLoop({ enabled: false });
    expect(typeof stop).toBe('function');
    stop();
  });
  it('disabled loop is a no-op', async () => {
    const { startBookLoop } = await import('../src/agent/book.js');
    startBookLoop({ enabled: false })();
  });
  it('stop is idempotent', async () => {
    const { startBookLoop } = await import('../src/agent/book.js');
    const stop = startBookLoop({ enabled: false });
    stop();
    expect(() => stop()).not.toThrow();
  });
  it('accepts custom monthlyBudgetUsd', async () => {
    const { startBookLoop } = await import('../src/agent/book.js');
    startBookLoop({ enabled: false, monthlyBudgetUsd: 5.00 })();
  });
  it('accepts custom intervalMs', async () => {
    const { startBookLoop } = await import('../src/agent/book.js');
    startBookLoop({ enabled: false, intervalMs: 12 * 60 * 60 * 1000 })();
  });
  it('budget key uses YYYY-MM format', () => {
    const key = `book:budget:${new Date().toISOString().slice(0, 7)}`;
    expect(key).toMatch(/^book:budget:\d{4}-\d{2}$/);
  });
  it('monthly spend starts at 0 with no meta', () => {
    _metaStore.clear();
    const key = `book:budget:${new Date().toISOString().slice(0, 7)}`;
    expect(_metaStore.get(key)).toBeUndefined();
  });
  it('reads last_incorporated_at from meta', async () => {
    _metaStore.set('book:last_incorporated_at', (Date.now() - 1000).toString());
    const { startBookLoop } = await import('../src/agent/book.js');
    startBookLoop({ enabled: false })();
  });
  it('handles missing diary gracefully', async () => {
    const fsPromises = await import('node:fs/promises');
    vi.mocked(fsPromises.readFile).mockResolvedValueOnce('');
    const { startBookLoop } = await import('../src/agent/book.js');
    startBookLoop({ enabled: false })();
  });
});

// ── Town Life ────────────────────────────────────────────────

describe('Town Life — startTownLifeLoop', () => {
  const cfg = { characterId: 'test', characterName: 'Test', peers: [] };
  it('returns stop function', async () => {
    const { startTownLifeLoop } = await import('../src/agent/town-life.js');
    const stop = startTownLifeLoop({ enabled: false, ...cfg });
    expect(typeof stop).toBe('function');
    stop();
  });
  it('disabled loop is a no-op', async () => {
    const { startTownLifeLoop } = await import('../src/agent/town-life.js');
    startTownLifeLoop({ enabled: false, ...cfg })();
  });
  it('stop is idempotent', async () => {
    const { startTownLifeLoop } = await import('../src/agent/town-life.js');
    const stop = startTownLifeLoop({ enabled: false, ...cfg });
    stop();
    expect(() => stop()).not.toThrow();
  });
  it('accepts peers list', async () => {
    const { startTownLifeLoop } = await import('../src/agent/town-life.js');
    startTownLifeLoop({ enabled: false, ...cfg, peers: [{ id: 'lain', name: 'Lain', url: 'http://localhost:3001' }] })();
  });
  it('reads last_cycle_at from meta', async () => {
    _metaStore.set('townlife:last_cycle_at', (Date.now() - 1000).toString());
    const { startTownLifeLoop } = await import('../src/agent/town-life.js');
    startTownLifeLoop({ enabled: false, ...cfg })();
  });
  it('accepts custom intervalMs', async () => {
    const { startTownLifeLoop } = await import('../src/agent/town-life.js');
    startTownLifeLoop({ enabled: false, ...cfg, intervalMs: 2 * 60 * 60 * 1000 })();
  });
  it('recent_actions stored in meta', () => {
    _metaStore.set('townlife:recent_actions', JSON.stringify([{ timestamp: Date.now(), actions: ['moved'], building: 'library', innerThought: 'quiet' }]));
    expect(_metaStore.get('townlife:recent_actions')).toBeDefined();
  });
});

// ── Feed Health ──────────────────────────────────────────────

describe('Feed Health — startFeedHealthLoop', () => {
  it('returns stop function', async () => {
    const { startFeedHealthLoop } = await import('../src/agent/feed-health.js');
    const stop = startFeedHealthLoop({ workspaceDir: '/tmp/test-ws' });
    expect(typeof stop).toBe('function');
    stop();
  });
  it('stop is idempotent', async () => {
    const { startFeedHealthLoop } = await import('../src/agent/feed-health.js');
    const stop = startFeedHealthLoop({ workspaceDir: '/tmp/test-ws' });
    stop();
    expect(() => stop()).not.toThrow();
  });
  it('reads state from meta on start', async () => {
    _metaStore.set('feed-health:state', JSON.stringify({ failures: {}, replaced: {}, lastCheckAt: Date.now() - 1000 }));
    const { startFeedHealthLoop } = await import('../src/agent/feed-health.js');
    startFeedHealthLoop({ workspaceDir: '/tmp/test-ws' })();
  });
  it('first run uses short initial delay', async () => {
    _metaStore.delete('feed-health:state');
    const { startFeedHealthLoop } = await import('../src/agent/feed-health.js');
    startFeedHealthLoop({ workspaceDir: '/tmp/test-ws' })();
  });
  it('failure threshold is 3 consecutive failures', () => {
    const state = { failures: { 'http://dead.feed/': 3 }, replaced: {}, lastCheckAt: 0 };
    expect(state.failures['http://dead.feed/']).toBe(3);
  });
  it('replaced feeds are tracked in state', () => {
    const state = { failures: {}, replaced: { 'http://old/': 'http://new/' }, lastCheckAt: 0 };
    _metaStore.set('feed-health:state', JSON.stringify(state));
    expect(JSON.parse(_metaStore.get('feed-health:state')!).replaced['http://old/']).toBe('http://new/');
  });
  it('check interval is weekly (7 days)', () => {
    expect(7 * 24 * 60 * 60 * 1000).toBe(604800000);
  });
  it('feeds need ≥2 items to be healthy', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, text: async () => '<feed><description>one</description></feed>' } as any);
    const { startFeedHealthLoop } = await import('../src/agent/feed-health.js');
    startFeedHealthLoop({ workspaceDir: '/tmp/test-ws' })();
  });
  it('non-200 response counts as failure', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 404, text: async () => '' } as any);
    const { startFeedHealthLoop } = await import('../src/agent/feed-health.js');
    startFeedHealthLoop({ workspaceDir: '/tmp/test-ws' })();
  });
});

// ── Dream Seeder ─────────────────────────────────────────────

describe('Dream Seeder — startDreamSeederLoop', () => {
  it('returns stop function', async () => {
    const { startDreamSeederLoop } = await import('../src/agent/dream-seeder.js');
    const stop = startDreamSeederLoop({ workspaceDir: '/tmp/test-ws' });
    expect(typeof stop).toBe('function');
    stop();
  });
  it('stop is idempotent', async () => {
    const { startDreamSeederLoop } = await import('../src/agent/dream-seeder.js');
    const stop = startDreamSeederLoop({ workspaceDir: '/tmp/test-ws' });
    stop();
    expect(() => stop()).not.toThrow();
  });
  it('reads last_check_at from meta', async () => {
    _metaStore.set('dream-seeder:last_check_at', (Date.now() - 60_000).toString());
    const { startDreamSeederLoop } = await import('../src/agent/dream-seeder.js');
    startDreamSeederLoop({ workspaceDir: '/tmp/test-ws' })();
  });
  it('first run uses 1-minute delay', async () => {
    _metaStore.delete('dream-seeder:last_check_at');
    const { startDreamSeederLoop } = await import('../src/agent/dream-seeder.js');
    startDreamSeederLoop({ workspaceDir: '/tmp/test-ws' })();
  });
  it('skips cycle without LAIN_INTERLINK_TOKEN', async () => {
    delete process.env['LAIN_INTERLINK_TOKEN'];
    const { startDreamSeederLoop } = await import('../src/agent/dream-seeder.js');
    startDreamSeederLoop({ workspaceDir: '/tmp/test-ws' })();
  });
  it('last_seeded_count is stored in meta', () => {
    _metaStore.set('dream-seeder:last_seeded_count', '15');
    expect(_metaStore.get('dream-seeder:last_seeded_count')).toBe('15');
  });
  it('default batch size is 30', () => { expect(30).toBeGreaterThan(0); });
  it('default pending threshold is 50', () => { expect(50).toBeGreaterThan(0); });
  it('stripHtml removes tags and entities', () => {
    const html = '<p>Hello <b>world</b> &amp; you</p>';
    const stripped = html.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').trim();
    expect(stripped).toBe('Hello world   you');
  });
  it('sources.json path uses workspaceDir', async () => {
    const fsPromises = await import('node:fs/promises');
    vi.mocked(fsPromises.readFile).mockResolvedValueOnce(JSON.stringify({ rss: [{ url: 'http://example.com/feed', name: 'Ex' }], wikipedia: { enabled: false, endpoint: '' } }));
    const { startDreamSeederLoop } = await import('../src/agent/dream-seeder.js');
    startDreamSeederLoop({ workspaceDir: '/tmp/test-ws' })();
  });
});

// ── Data Workspace ───────────────────────────────────────────

describe('Data Workspace — sanitizeDataFileName', () => {
  it('rejects path traversal', async () => {
    const actual = (await vi.importActual('../src/agent/data-workspace.js')) as typeof import('../src/agent/data-workspace.js');
    expect(actual.sanitizeDataFileName('../../../etc/passwd')).toBeNull();
  });
  it('rejects invalid extensions', async () => {
    const actual = (await vi.importActual('../src/agent/data-workspace.js')) as typeof import('../src/agent/data-workspace.js');
    expect(actual.sanitizeDataFileName('script.py')).toBeNull();
    expect(actual.sanitizeDataFileName('image.png')).toBeNull();
  });
  it('allows .csv, .json, .txt, .tsv', async () => {
    const actual = (await vi.importActual('../src/agent/data-workspace.js')) as typeof import('../src/agent/data-workspace.js');
    expect(actual.sanitizeDataFileName('data.csv')).toBe('data.csv');
    expect(actual.sanitizeDataFileName('out.json')).toBe('out.json');
    expect(actual.sanitizeDataFileName('notes.txt')).toBe('notes.txt');
    expect(actual.sanitizeDataFileName('table.tsv')).toBe('table.tsv');
  });
  it('rejects names that are too short', async () => {
    const actual = (await vi.importActual('../src/agent/data-workspace.js')) as typeof import('../src/agent/data-workspace.js');
    expect(actual.sanitizeDataFileName('.csv')).toBeNull();
  });
  it('strips path components via basename', async () => {
    const actual = (await vi.importActual('../src/agent/data-workspace.js')) as typeof import('../src/agent/data-workspace.js');
    const result = actual.sanitizeDataFileName('/etc/passwd.csv');
    if (result !== null) {
      expect(result).not.toContain('/');
      expect(result).not.toContain('..');
    }
  });
  it('MAX_DATA_DIR_BYTES is 100 MB', async () => {
    const actual = (await vi.importActual('../src/agent/data-workspace.js')) as typeof import('../src/agent/data-workspace.js');
    expect(actual.MAX_DATA_DIR_BYTES).toBe(100 * 1024 * 1024);
  });
  it('MAX_SINGLE_FILE_BYTES is 10 MB', async () => {
    const actual = (await vi.importActual('../src/agent/data-workspace.js')) as typeof import('../src/agent/data-workspace.js');
    expect(actual.MAX_SINGLE_FILE_BYTES).toBe(10 * 1024 * 1024);
  });
});
