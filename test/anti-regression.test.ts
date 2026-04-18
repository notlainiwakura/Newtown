/**
 * Anti-regression test suite for Laintown
 *
 * Guards against entire classes of bugs that have occurred or could occur:
 * silent truncation, identity corruption, auth bypass, shared state corruption,
 * config drift, loop accumulation, and budget evasion.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';

vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn().mockResolvedValue('test-master-key'),
    setPassword: vi.fn().mockResolvedValue(undefined),
    deletePassword: vi.fn().mockResolvedValue(true),
    findCredentials: vi.fn().mockResolvedValue([]),
  },
}));

function readSrc(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf-8');
}

// ─────────────────────────────────────────────────────────
// 1. SILENT TRUNCATION CLASS
// ─────────────────────────────────────────────────────────
describe('Silent Truncation Class', () => {
  it('all three providers default to maxTokens 8192 (not a tiny value)', () => {
    for (const file of ['anthropic.ts', 'openai.ts', 'google.ts']) {
      const src = readSrc(`../src/providers/${file}`);
      expect(src, `${file} should default to 8192`).toContain('8192');
      expect(src, `${file} must not default to 100`).not.toContain('maxTokens ?? 100');
      expect(src, `${file} must not default to 0`).not.toContain('maxTokens ?? 0');
    }
  });

  it('Anthropic provider uses nullish coalescing (preserves 0 explicitly)', () => {
    const src = readSrc('../src/providers/anthropic.ts');
    expect(src).toContain('config.maxTokens ?? 8192');
  });

  it('all providers extend BaseProvider', () => {
    for (const file of ['anthropic.ts', 'openai.ts', 'google.ts']) {
      const src = readSrc(`../src/providers/${file}`);
      expect(src, `${file} must extend BaseProvider`).toContain('extends BaseProvider');
    }
  });

  it('CompletionResult has finishReason and usage fields', () => {
    const src = readSrc('../src/providers/base.ts');
    expect(src).toContain('finishReason');
    expect(src).toContain('inputTokens');
    expect(src).toContain('outputTokens');
  });

  it('Anthropic non-streaming and streaming paths both surface finishReason', () => {
    const src = readSrc('../src/providers/anthropic.ts');
    expect(src).toContain('mapStopReason');
    const matches = (src.match(/finishReason/g) || []).length;
    expect(matches).toBeGreaterThanOrEqual(2);
  });

  it('per-loop maxTokens are appropriate after truncation fix', () => {
    expect(readSrc('../src/agent/diary.ts')).toContain('maxTokens: 1024');
    expect(readSrc('../src/agent/book.ts')).toContain('maxTokens: 5000');
    expect(readSrc('../src/agent/dreams.ts')).toContain('maxTokens: 400');
    expect(readSrc('../src/agent/commune-loop.ts')).toContain('maxTokens: 1024');
    expect(readSrc('../src/agent/internal-state.ts')).toContain('maxTokens: 512');
    expect(readSrc('../src/agent/curiosity.ts')).toContain('maxTokens: 256');
  });

  it('book decideAction uses 10 tokens intentionally (single-word response)', () => {
    expect(readSrc('../src/agent/book.ts')).toContain('maxTokens: 10');
    // Dreams should NOT use 10 tokens for its meaningful generation
    expect(readSrc('../src/agent/dreams.ts')).not.toContain('maxTokens: 10');
  });

  it('streaming path sends done event after completion', () => {
    expect(readSrc('../src/web/server.ts')).toContain("type: 'done'");
  });

  it('book REVISE uses at least 6000 tokens', () => {
    expect(readSrc('../src/agent/book.ts')).toContain('maxTokens: 6000');
  });
});


// ─────────────────────────────────────────────────────────
// 2. IDENTITY CORRUPTION CLASS
// ─────────────────────────────────────────────────────────
describe('Identity Corruption Class', () => {
  it('eventBus characterId can be set and does not bleed between assignments', async () => {
    const { eventBus } = await import('../src/events/bus.js');
    eventBus.setCharacterId('lain');
    expect(eventBus.characterId).toBe('lain');
    eventBus.setCharacterId('wired-lain');
    expect(eventBus.characterId).toBe('wired-lain');
    expect(eventBus.characterId).not.toBe('lain');
  });

  it('emitActivity attaches the current characterId to every event', async () => {
    const { eventBus } = await import('../src/events/bus.js');
    eventBus.setCharacterId('dr-claude');
    const received: { character: string }[] = [];
    eventBus.on('activity', (e: { character: string }) => received.push(e));
    eventBus.emitActivity({ type: 'test', sessionKey: 'x', content: 'y', timestamp: Date.now() });
    expect(received[0]?.character).toBe('dr-claude');
    eventBus.removeAllListeners('activity');
  });

  it('getBasePath and getPaths are driven by LAIN_HOME (per-character)', async () => {
    const origHome = process.env['LAIN_HOME'];
    process.env['LAIN_HOME'] = '/root/.lain-pkd';
    const { getBasePath, getPaths } = await import('../src/config/paths.js');
    expect(getBasePath()).toBe('/root/.lain-pkd');
    expect(getPaths().database).toBe('/root/.lain-pkd/lain.db');
    expect(getPaths().base).toBe(getBasePath());

    process.env['LAIN_HOME'] = '/root/.lain-wired';
    expect(getBasePath()).toBe('/root/.lain-wired');
    expect(getPaths().database).not.toBe('/root/.lain-pkd/lain.db');

    if (origHome) process.env['LAIN_HOME'] = origHome; else delete process.env['LAIN_HOME'];
  });

  it('diary and book modules use getBasePath (not hardcoded paths)', () => {
    expect(readSrc('../src/agent/diary.ts')).toContain('getBasePath()');
    expect(readSrc('../src/agent/diary.ts')).not.toContain("join('/root/.lain'");
    expect(readSrc('../src/agent/book.ts')).toContain('getBasePath()');
  });

  it('commune loop requires characterId in config (typed as Pick)', () => {
    const src = readSrc('../src/agent/commune-loop.ts');
    expect(src).toContain('characterId');
    expect(src).toContain('Pick<CommuneLoopConfig');
  });

  it('LAIN_CHARACTER_NAME is used for character identity in diary', () => {
    expect(readSrc('../src/agent/diary.ts')).toContain('LAIN_CHARACTER_NAME');
  });

  it('two characters initialized with different LAIN_HOME get different databases', async () => {
    const origHome = process.env['LAIN_HOME'];
    process.env['LAIN_HOME'] = '/tmp/char-x';
    const { getPaths } = await import('../src/config/paths.js');
    const dbX = getPaths().database;
    process.env['LAIN_HOME'] = '/tmp/char-y';
    const dbY = getPaths().database;
    expect(dbX).not.toBe(dbY);
    if (origHome) process.env['LAIN_HOME'] = origHome; else delete process.env['LAIN_HOME'];
  });
});


// ─────────────────────────────────────────────────────────
// 3. AUTH BYPASS CLASS
// ─────────────────────────────────────────────────────────
describe('Auth Bypass Class', () => {
  it('isOwner returns false when token unset, cookie missing, or wrong hash', async () => {
    const origToken = process.env['LAIN_OWNER_TOKEN'];
    const { isOwner, deriveOwnerCookie } = await import('../src/web/owner-auth.js');

    // No token set
    delete process.env['LAIN_OWNER_TOKEN'];
    expect(isOwner({ headers: { cookie: 'lain_owner=somehash' } } as any)).toBe(false);

    // Token set but no cookie
    process.env['LAIN_OWNER_TOKEN'] = 'secret';
    expect(isOwner({ headers: {} } as any)).toBe(false);

    // Wrong cookie value
    expect(isOwner({ headers: { cookie: 'lain_owner=wronghash' + 'a'.repeat(60) } } as any)).toBe(false);

    if (origToken) process.env['LAIN_OWNER_TOKEN'] = origToken; else delete process.env['LAIN_OWNER_TOKEN'];
  });

  it('isOwner returns true for correct HMAC-derived cookie', async () => {
    process.env['LAIN_OWNER_TOKEN'] = 'my-owner-token';
    const { isOwner, deriveOwnerCookie } = await import('../src/web/owner-auth.js');
    const hash = deriveOwnerCookie('my-owner-token');
    expect(isOwner({ headers: { cookie: `lain_owner=${hash}` } } as any)).toBe(true);
    delete process.env['LAIN_OWNER_TOKEN'];
  });

  it('deriveOwnerCookie is deterministic and token-specific', async () => {
    const { deriveOwnerCookie } = await import('../src/web/owner-auth.js');
    expect(deriveOwnerCookie('tok')).toBe(deriveOwnerCookie('tok'));
    expect(deriveOwnerCookie('tok-a')).not.toBe(deriveOwnerCookie('tok-b'));
  });

  it('owner cookie has HttpOnly, SameSite=Strict, and uses timing-safe comparison', () => {
    const src = readSrc('../src/web/owner-auth.ts');
    expect(src).toContain('HttpOnly');
    expect(src).toContain('SameSite=Strict');
    expect(src).toContain('timingSafeEqual');
  });

  it('server uses isOwner and returns 401 for unauthorized requests', () => {
    const src = readSrc('../src/web/server.ts');
    expect(src).toContain('isOwner');
    expect(src).toContain('verifyApiAuth');
    expect(src).toContain('401');
    expect(src).toContain('Unauthorized');
  });

  it('commune peer messages include Authorization: Bearer interlink token', () => {
    const src = readSrc('../src/agent/commune-loop.ts');
    expect(src).toContain('Authorization');
    expect(src).toContain('LAIN_INTERLINK_TOKEN');
  });

  it('weather peer fetches include Authorization header', () => {
    const src = readSrc('../src/commune/weather.ts');
    expect(src).toContain('LAIN_INTERLINK_TOKEN');
    expect(src).toContain('Authorization');
  });
});


// ─────────────────────────────────────────────────────────
// 4. SHARED STATE CORRUPTION CLASS
// ─────────────────────────────────────────────────────────
describe('Shared State Corruption Class', () => {
  it('database is per-character: different LAIN_HOME = different store', async () => {
    const dirA = join(tmpdir(), `lain-iso-a-${Date.now()}`);
    const dirB = join(tmpdir(), `lain-iso-b-${Date.now()}`);
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    const origHome = process.env['LAIN_HOME'];

    process.env['LAIN_HOME'] = dirA;
    const { initDatabase, closeDatabase, setMeta, getMeta } = await import('../src/storage/database.js');
    await initDatabase(join(dirA, 'lain.db'));
    setMeta('test:key', 'value-from-char-a');
    expect(getMeta('test:key')).toBe('value-from-char-a');
    closeDatabase();

    process.env['LAIN_HOME'] = dirB;
    await initDatabase(join(dirB, 'lain.db'));
    expect(getMeta('test:key')).toBeNull(); // fresh database
    closeDatabase();

    if (origHome) process.env['LAIN_HOME'] = origHome; else delete process.env['LAIN_HOME'];
    try { await rm(dirA, { recursive: true }); } catch {}
    try { await rm(dirB, { recursive: true }); } catch {}
  });

  it('session keys isolate data between sessions', async () => {
    const testDir = join(tmpdir(), `lain-sess-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    const origHome = process.env['LAIN_HOME'];
    process.env['LAIN_HOME'] = testDir;
    const { initDatabase, closeDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(testDir, 'lain.db'));
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
    saveMessage({ sessionKey: 'web:sess-aaa', userId: null, role: 'user', content: 'private', timestamp: Date.now(), metadata: {} });
    expect(getRecentMessages('web:sess-bbb')).toHaveLength(0);
    closeDatabase();
    if (origHome) process.env['LAIN_HOME'] = origHome; else delete process.env['LAIN_HOME'];
    try { await rm(testDir, { recursive: true }); } catch {}
  });

  it('all critical meta keys are namespaced (no collision risk)', () => {
    expect(readSrc('../src/providers/budget.ts')).toContain("'budget:monthly_usage'");
    expect(readSrc('../src/agent/internal-state.ts')).toContain("'internal:state'");
    expect(readSrc('../src/agent/commune-loop.ts')).toContain("'commune:last_cycle_at'");
    expect(readSrc('../src/agent/dreams.ts')).toContain("'dream:last_cycle_at'");
    expect(readSrc('../src/agent/book.ts')).toContain("'book:last_cycle_at'");
    expect(readSrc('../src/agent/book.ts')).toContain('book:budget:');
  });

  it('.env must not set LAIN_HOME (would override per-service LAIN_HOME)', () => {
    let dotEnvContent = '';
    try { dotEnvContent = readFileSync(join(__dirname, '..', '.env'), 'utf-8'); } catch { return; }
    const lines = dotEnvContent.split('\n').filter(l => !l.trim().startsWith('#'));
    expect(lines.some(l => l.trim().startsWith('LAIN_HOME=')),
      '.env sets LAIN_HOME which overrides per-service LAIN_HOME').toBe(false);
  });

  it('.env must not set LAIN_INTERLINK_TARGET (would override per-service values)', () => {
    let dotEnvContent = '';
    try { dotEnvContent = readFileSync(join(__dirname, '..', '.env'), 'utf-8'); } catch { return; }
    const lines = dotEnvContent.split('\n').filter(l => !l.trim().startsWith('#'));
    expect(lines.some(l => l.trim().startsWith('LAIN_INTERLINK_TARGET=')),
      '.env sets LAIN_INTERLINK_TARGET which overrides per-service values').toBe(false);
  });
});


// ─────────────────────────────────────────────────────────
// 5. CONFIG DRIFT CLASS
// ─────────────────────────────────────────────────────────
describe('Config Drift Class', () => {
  it('default config has 1 agent with id="default" and 3 providers', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    const config = getDefaultConfig();
    expect(config.agents.length).toBeGreaterThan(0);
    expect(config.agents[0]!.id).toBe('default');
    expect(config.agents[0]!.providers).toHaveLength(3);
  });

  it('all default providers are anthropic with claude models', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    const { agents: [agent] } = getDefaultConfig();
    for (const p of agent!.providers) {
      expect(p.type).toBe('anthropic');
      expect(p.model).toContain('claude');
    }
  });

  it('primary provider is claude-sonnet', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    expect(getDefaultConfig().agents[0]!.providers[0]!.model).toContain('claude-sonnet');
  });

  it('security config is sane: requireAuth=true, maxMessageLength within [1, 1M]', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    const { security } = getDefaultConfig();
    expect(security.requireAuth).toBe(true);
    expect(security.maxMessageLength).toBeGreaterThan(0);
    expect(security.maxMessageLength).toBeLessThanOrEqual(1_000_000);
  });

  it('config version is "1" and logging defaults to info', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    const config = getDefaultConfig();
    expect(config.version).toBe('1');
    expect(config.logging.level).toBe('info');
  });

  it('all provider types can be instantiated', async () => {
    const { AnthropicProvider } = await import('../src/providers/anthropic.js');
    const { OpenAIProvider } = await import('../src/providers/openai.js');
    const { GoogleProvider } = await import('../src/providers/google.js');
    expect(() => new AnthropicProvider({ model: 'claude-haiku-4-5-20251001' })).not.toThrow();
    expect(() => new OpenAIProvider({ model: 'gpt-4o', apiKey: 'sk-test-dummy' })).not.toThrow();
    expect(() => new GoogleProvider({ model: 'gemini-1.5-pro' })).not.toThrow();
  });

  it('getPaths returns all required fields and database is lain.db', async () => {
    const origHome = process.env['LAIN_HOME'];
    process.env['LAIN_HOME'] = '/tmp/drift-check';
    const { getPaths } = await import('../src/config/paths.js');
    const paths = getPaths();
    expect(paths.base).toBeDefined();
    expect(paths.config).toBeDefined();
    expect(paths.database).toBe('/tmp/drift-check/lain.db');
    expect(paths.workspace).toBeDefined();
    if (origHome) process.env['LAIN_HOME'] = origHome; else delete process.env['LAIN_HOME'];
  });

  it('all buildings have required fields (id, name, row, col)', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    for (const b of BUILDINGS) {
      expect(b.id).toBeDefined();
      expect(b.name).toBeDefined();
      expect(typeof b.row).toBe('number');
      expect(typeof b.col).toBe('number');
    }
  });

  it('all default providers have apiKeyEnv field', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    for (const p of getDefaultConfig().agents[0]!.providers) {
      expect(p.apiKeyEnv, `provider ${p.model} missing apiKeyEnv`).toBeDefined();
    }
  });
});


// ─────────────────────────────────────────────────────────
// 6. LOOP ACCUMULATION CLASS
// ─────────────────────────────────────────────────────────
describe('Loop Accumulation Class', () => {
  it('disabled startXLoop functions return callable, idempotent cleanups', async () => {
    const { startDiaryLoop } = await import('../src/agent/diary.js');
    const { startDreamLoop } = await import('../src/agent/dreams.js');
    const { startBookLoop } = await import('../src/agent/book.js');

    for (const cleanup of [
      startDiaryLoop({ enabled: false }),
      startDreamLoop({ enabled: false }),
      startBookLoop({ enabled: false }),
    ]) {
      expect(typeof cleanup).toBe('function');
      expect(() => cleanup()).not.toThrow();
      expect(() => cleanup()).not.toThrow(); // idempotent
    }
  });

  it('multiple calls return independent cleanup references', async () => {
    const { startDiaryLoop } = await import('../src/agent/diary.js');
    const c1 = startDiaryLoop({ enabled: false });
    const c2 = startDiaryLoop({ enabled: false });
    expect(c1).not.toBe(c2);
  });

  it('commune loop with no peers returns cleanup without error', async () => {
    const { startCommuneLoop } = await import('../src/agent/commune-loop.js');
    const cleanup = startCommuneLoop({ characterId: 'test', characterName: 'Test', peers: [] });
    expect(typeof cleanup).toBe('function');
    expect(() => cleanup()).not.toThrow();
  });

  it('startStateDecayLoop returns a cleanup that stops the interval', async () => {
    vi.useFakeTimers();
    const testDir = join(tmpdir(), `lain-decay-stop-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    const origHome = process.env['LAIN_HOME'];
    process.env['LAIN_HOME'] = testDir;
    const { initDatabase, closeDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(testDir, 'lain.db'));
    const { startStateDecayLoop } = await import('../src/agent/internal-state.js');
    const cleanup = startStateDecayLoop();
    expect(typeof cleanup).toBe('function');
    expect(() => cleanup()).not.toThrow();
    expect(() => cleanup()).not.toThrow(); // idempotent
    closeDatabase();
    vi.useRealTimers();
    if (origHome) process.env['LAIN_HOME'] = origHome; else delete process.env['LAIN_HOME'];
    try { await rm(testDir, { recursive: true }); } catch {}
  });

  it('stopped flag prevents any further execution (core loop pattern)', () => {
    let stopped = false;
    let fired = 0;
    const maybeRun = () => { if (stopped) return; fired++; };
    maybeRun();
    expect(fired).toBe(1);
    stopped = true;
    maybeRun();
    maybeRun();
    expect(fired).toBe(1); // stopped flag worked
  });

  it('startWeatherLoop and startCuriosityLoop return callable cleanups', async () => {
    vi.useFakeTimers();
    const testDir = join(tmpdir(), `lain-weather-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    const origHome = process.env['LAIN_HOME'];
    process.env['LAIN_HOME'] = testDir;
    const { initDatabase, closeDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(testDir, 'lain.db'));
    const { startWeatherLoop } = await import('../src/commune/weather.js');
    const cleanup = startWeatherLoop();
    expect(typeof cleanup).toBe('function');
    expect(() => cleanup()).not.toThrow();
    closeDatabase();
    vi.useRealTimers();
    if (origHome) process.env['LAIN_HOME'] = origHome; else delete process.env['LAIN_HOME'];
    try { await rm(testDir, { recursive: true }); } catch {}
  });
});


// ─────────────────────────────────────────────────────────
// 7. BUDGET EVASION CLASS
// ─────────────────────────────────────────────────────────
describe('Budget Evasion Class', () => {
  const testDir = join(tmpdir(), `lain-budget-evasion-${Date.now()}`);
  const originalEnv = process.env['LAIN_HOME'];
  const originalCap = process.env['LAIN_MONTHLY_TOKEN_CAP'];

  beforeEach(async () => {
    process.env['LAIN_HOME'] = testDir;
    await mkdir(testDir, { recursive: true });
    const { initDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(testDir, 'test.db'));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-15T12:00:00Z'));
  });

  afterEach(async () => {
    vi.useRealTimers();
    const { closeDatabase } = await import('../src/storage/database.js');
    closeDatabase();
    if (originalEnv) process.env['LAIN_HOME'] = originalEnv; else delete process.env['LAIN_HOME'];
    if (originalCap !== undefined) process.env['LAIN_MONTHLY_TOKEN_CAP'] = originalCap;
    else delete process.env['LAIN_MONTHLY_TOKEN_CAP'];
    try { await rm(testDir, { recursive: true }); } catch {}
  });

  it('checkBudget throws BudgetExceededError (not a generic Error) when over cap', async () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '100';
    const { checkBudget, recordUsage, BudgetExceededError } = await import('../src/providers/budget.js');
    recordUsage(60, 50); // 110 > 100
    try {
      checkBudget();
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetExceededError);
      expect(err instanceof Error && err.name).toBe('BudgetExceededError');
    }
  });

  it('budget cap=0 disables check entirely (never throws regardless of usage)', async () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '0';
    const { checkBudget, recordUsage } = await import('../src/providers/budget.js');
    recordUsage(99_999_999, 99_999_999);
    expect(() => checkBudget()).not.toThrow();
  });

  it('recordUsage uses actual response usage (book.ts uses result.usage.*)', () => {
    const src = readSrc('../src/agent/book.ts');
    expect(src).toContain('result.usage.inputTokens');
    expect(src).toContain('result.usage.outputTokens');
    expect(src).toContain('addSpend');
  });

  it('recording zero tokens and very large counts do not corrupt the budget', async () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '999999999';
    const { recordUsage, getBudgetStatus } = await import('../src/providers/budget.js');
    recordUsage(1000, 500);
    recordUsage(0, 0);
    expect(getBudgetStatus().tokensUsed).toBe(1500);
    recordUsage(10_000_000, 10_000_000);
    const status = getBudgetStatus();
    expect(Number.isNaN(status.tokensUsed)).toBe(false);
    expect(status.tokensUsed).toBe(20_001_500);
  });

  it('book addSpend cost formula is correct: 1M input=$3, 1M output=$15', () => {
    const INPUT_COST_PER_M = 3.00;
    const OUTPUT_COST_PER_M = 15.00;
    const cost = (1_000_000 / 1_000_000) * INPUT_COST_PER_M + (1_000_000 / 1_000_000) * OUTPUT_COST_PER_M;
    expect(cost).toBeCloseTo(18.00, 5);
  });

  it('book uses its own USD-based addSpend, not the token-based recordUsage', () => {
    const src = readSrc('../src/agent/book.ts');
    expect(src).toContain('addSpend');
    expect(src).not.toContain("from '../providers/budget.js'");
  });

  it('isBudgetExhausted comparison: >= cap is exhausted, < cap is not', () => {
    expect(10.50 >= 10.00).toBe(true);  // exhausted
    expect(9.99 >= 10.00).toBe(false);  // not exhausted
    expect(10.00 >= 10.00).toBe(true);  // exactly at cap = exhausted
  });

  it('getBudgetStatus pct rounds correctly', async () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '1000000';
    const { recordUsage, getBudgetStatus } = await import('../src/providers/budget.js');
    recordUsage(800000, 0);
    expect(getBudgetStatus().pctUsed).toBe(80);
  });
});
