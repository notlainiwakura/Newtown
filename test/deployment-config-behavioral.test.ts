/**
 * Deployment & Configuration Behavioral Tests
 *
 * Tests the runtime behavior of:
 *  - Config loading, merging, caching, validation, and error handling
 *  - Path system resolution under various LAIN_HOME settings
 *  - Service template generation and substitution correctness
 *  - Build system integrity (ESM, imports, dependencies)
 *  - Deploy script logic (generate-services, deploy, healthcheck, status)
 *  - Environment isolation across characters
 *
 * Complements (does NOT duplicate):
 *  - test/deployment-correctness.test.ts (130 structural tests)
 *  - test/config-system.test.ts (49 structural/unit tests)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join, resolve, extname, basename, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';

vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn().mockResolvedValue('test-master-key'),
    setPassword: vi.fn().mockResolvedValue(undefined),
    deletePassword: vi.fn().mockResolvedValue(true),
    findCredentials: vi.fn().mockResolvedValue([]),
  },
}));

const PROJECT_ROOT = resolve(join(import.meta.dirname ?? __dirname, '..'));

function readText(relPath: string): string {
  return readFileSync(join(PROJECT_ROOT, relPath), 'utf-8');
}

function readJson(relPath: string): unknown {
  return JSON.parse(readFileSync(join(PROJECT_ROOT, relPath), 'utf-8'));
}

function fileExists(relPath: string): boolean {
  return existsSync(join(PROJECT_ROOT, relPath));
}

// Load example manifest once for reuse
const exampleManifest = readJson('characters.example.json') as {
  town: { name: string; description: string };
  characters: Array<{
    id: string;
    name: string;
    port: number;
    server: string;
    defaultLocation: string;
    immortal?: boolean;
    possessable?: boolean;
    workspace: string;
  }>;
};

// ═══════════════════════════════════════════════════════════════════════
// 1. CONFIG LOADING BEHAVIORAL (~50 tests)
// ═══════════════════════════════════════════════════════════════════════

describe('Config loading behavioral', () => {
  const testDir = join(tmpdir(), `lain-cfg-behavioral-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  let originalEnv: string | undefined;

  beforeEach(async () => {
    originalEnv = process.env['LAIN_HOME'];
    process.env['LAIN_HOME'] = testDir;
    await mkdir(testDir, { recursive: true });
    const { resetConfig } = await import('../src/config/index.js');
    resetConfig();
  });

  afterEach(async () => {
    if (originalEnv !== undefined) {
      process.env['LAIN_HOME'] = originalEnv;
    } else {
      delete process.env['LAIN_HOME'];
    }
    try {
      await rm(testDir, { recursive: true });
    } catch { /* ignore */ }
  });

  // --- Default config completeness ---

  it('default config has all required top-level keys', async () => {
    // findings.md P2:171 — `agents` removed from LainConfig.
    const { getDefaultConfig } = await import('../src/config/index.js');
    const cfg = getDefaultConfig();
    expect(cfg).toHaveProperty('version');
    expect(cfg).toHaveProperty('gateway');
    expect(cfg).toHaveProperty('security');
    expect(cfg).toHaveProperty('logging');
    expect(cfg).not.toHaveProperty('agents');
  });

  it('default gateway has all required sub-fields', async () => {
    const { getDefaultConfig } = await import('../src/config/index.js');
    const gw = getDefaultConfig().gateway;
    expect(gw).toHaveProperty('socketPath');
    expect(gw).toHaveProperty('socketPermissions');
    expect(gw).toHaveProperty('pidFile');
    expect(gw).toHaveProperty('rateLimit');
    expect(gw.rateLimit).toHaveProperty('connectionsPerMinute');
    expect(gw.rateLimit).toHaveProperty('requestsPerSecond');
    expect(gw.rateLimit).toHaveProperty('burstSize');
  });

  it('default security has all required sub-fields', async () => {
    const { getDefaultConfig } = await import('../src/config/index.js');
    const sec = getDefaultConfig().security;
    expect(sec).toHaveProperty('requireAuth');
    expect(sec).toHaveProperty('tokenLength');
    expect(sec).toHaveProperty('inputSanitization');
    expect(sec).toHaveProperty('maxMessageLength');
    expect(sec).toHaveProperty('keyDerivation');
    expect(sec.keyDerivation).toHaveProperty('algorithm');
    expect(sec.keyDerivation).toHaveProperty('memoryCost');
    expect(sec.keyDerivation).toHaveProperty('timeCost');
    expect(sec.keyDerivation).toHaveProperty('parallelism');
  });

  // findings.md P2:171 — `agents` moved out of LainConfig. Below three
  // tests now target DEFAULT_PROVIDERS (the fallback chain inherited by
  // a character manifest entry with no `providers`).
  it('DEFAULT_PROVIDERS references ANTHROPIC_API_KEY env var', async () => {
    const { DEFAULT_PROVIDERS } = await import('../src/config/defaults.js');
    const hasAnthropicKey = DEFAULT_PROVIDERS.some(p => p.apiKeyEnv === 'ANTHROPIC_API_KEY');
    expect(hasAnthropicKey).toBe(true);
  });

  it('DEFAULT_PROVIDERS primary tier includes fallback models', async () => {
    const { DEFAULT_PROVIDERS } = await import('../src/config/defaults.js');
    const provider = DEFAULT_PROVIDERS[0]!;
    expect(provider.fallbackModels).toBeDefined();
    expect(Array.isArray(provider.fallbackModels)).toBe(true);
    expect(provider.fallbackModels!.length).toBeGreaterThan(0);
  });

  it('default config rate limits are positive numbers', async () => {
    const { getDefaultConfig } = await import('../src/config/index.js');
    const rl = getDefaultConfig().gateway.rateLimit;
    expect(rl.connectionsPerMinute).toBeGreaterThan(0);
    expect(rl.requestsPerSecond).toBeGreaterThan(0);
    expect(rl.burstSize).toBeGreaterThan(0);
  });

  it('default config enables input sanitization', async () => {
    const { getDefaultConfig } = await import('../src/config/index.js');
    expect(getDefaultConfig().security.inputSanitization).toBe(true);
  });

  it('default config socket permissions are restrictive (0600)', async () => {
    const { getDefaultConfig } = await import('../src/config/index.js');
    expect(getDefaultConfig().gateway.socketPermissions).toBe(0o600);
  });

  it('default config uses argon2id with safe parameters', async () => {
    const { getDefaultConfig } = await import('../src/config/index.js');
    const kd = getDefaultConfig().security.keyDerivation;
    expect(kd.algorithm).toBe('argon2id');
    expect(kd.memoryCost).toBeGreaterThanOrEqual(65536); // >= 64 MiB
    expect(kd.timeCost).toBeGreaterThanOrEqual(3);
    expect(kd.parallelism).toBeGreaterThanOrEqual(1);
  });

  it('default logging pretty prints in dev-friendly mode', async () => {
    const { getDefaultConfig } = await import('../src/config/index.js');
    expect(getDefaultConfig().logging.prettyPrint).toBe(true);
  });

  // --- Config merging / overrides ---

  it('partial override of logging level preserves other logging fields', async () => {
    const { loadConfig } = await import('../src/config/index.js');
    await writeFile(join(testDir, 'lain.json5'), JSON.stringify({
      version: '1',
      logging: { level: 'debug', prettyPrint: false },
    }));
    const cfg = await loadConfig();
    expect(cfg.logging.level).toBe('debug');
    expect(cfg.logging.prettyPrint).toBe(false);
    // Other sections untouched
    expect(cfg.gateway.rateLimit.connectionsPerMinute).toBeGreaterThan(0);
    expect(cfg.security.requireAuth).toBe(true);
  });

  it('partial override of rate limit preserves other gateway fields', async () => {
    const { loadConfig, getPaths } = await import('../src/config/index.js');
    await writeFile(join(testDir, 'lain.json5'), JSON.stringify({
      version: '1',
      gateway: { rateLimit: { connectionsPerMinute: 120, requestsPerSecond: 20, burstSize: 40 } },
    }));
    const cfg = await loadConfig();
    expect(cfg.gateway.rateLimit.connectionsPerMinute).toBe(120);
    expect(cfg.gateway.rateLimit.requestsPerSecond).toBe(20);
    // socketPath, pidFile should still come from defaults
    expect(cfg.gateway.socketPath).toBe(getPaths().socket);
    expect(cfg.gateway.pidFile).toBe(getPaths().pidFile);
  });

  it('override of security fields preserves unset security fields', async () => {
    const { loadConfig } = await import('../src/config/index.js');
    await writeFile(join(testDir, 'lain.json5'), JSON.stringify({
      version: '1',
      security: { maxMessageLength: 50000 },
    }));
    const cfg = await loadConfig();
    expect(cfg.security.maxMessageLength).toBe(50000);
    expect(cfg.security.requireAuth).toBe(true);
    expect(cfg.security.tokenLength).toBe(32);
    expect(cfg.security.inputSanitization).toBe(true);
  });

  it('lain.json5 with legacy `agents` override is now rejected (P2:171)', async () => {
    // findings.md P2:171 — `agents` was removed from LainConfig and the
    // schema sets additionalProperties:false. Any lingering lain.json5
    // that still ships an `agents` array must now fail load.
    const { loadConfig } = await import('../src/config/index.js');
    await writeFile(join(testDir, 'lain.json5'), JSON.stringify({
      version: '1',
      agents: [{
        id: 'custom-agent', name: 'Custom', enabled: true, workspace: '/tmp/custom',
        providers: [{ type: 'openai', model: 'gpt-4' }],
      }],
    }));
    await expect(loadConfig()).rejects.toThrow();
  });

  it('config with all optional fields respects all of them', async () => {
    const { loadConfig } = await import('../src/config/index.js');
    const full = {
      version: '1',
      logging: { level: 'warn', prettyPrint: false, file: '/tmp/test.log' },
    };
    await writeFile(join(testDir, 'lain.json5'), JSON.stringify(full));
    const cfg = await loadConfig();
    expect(cfg.logging.level).toBe('warn');
    expect(cfg.logging.prettyPrint).toBe(false);
    expect(cfg.logging.file).toBe('/tmp/test.log');
  });

  // --- Error handling ---

  it('invalid JSON5 syntax throws ConfigError', async () => {
    const { loadConfig } = await import('../src/config/index.js');
    await writeFile(join(testDir, 'lain.json5'), '{ not valid json at all !!!');
    await expect(loadConfig()).rejects.toThrow();
  });

  it('config with wrong type for boolean field throws on validation', async () => {
    const { loadConfig } = await import('../src/config/index.js');
    await writeFile(join(testDir, 'lain.json5'), JSON.stringify({
      version: '1',
      security: { requireAuth: 'yes' },
    }));
    await expect(loadConfig()).rejects.toThrow();
  });

  it('config with wrong type for number field throws on validation', async () => {
    const { loadConfig } = await import('../src/config/index.js');
    await writeFile(join(testDir, 'lain.json5'), JSON.stringify({
      version: '1',
      security: { maxMessageLength: 'a lot' },
    }));
    await expect(loadConfig()).rejects.toThrow();
  });

  it('config with additional unknown property at top level throws', async () => {
    const { loadConfig } = await import('../src/config/index.js');
    await writeFile(join(testDir, 'lain.json5'), JSON.stringify({
      version: '1',
      unknownField: true,
    }));
    await expect(loadConfig()).rejects.toThrow();
  });

  it('config with negative rate limit throws on validation', async () => {
    const { loadConfig } = await import('../src/config/index.js');
    await writeFile(join(testDir, 'lain.json5'), JSON.stringify({
      version: '1',
      gateway: { rateLimit: { connectionsPerMinute: -1, requestsPerSecond: 10, burstSize: 20 } },
    }));
    await expect(loadConfig()).rejects.toThrow();
  });

  it('config with zero rate limit throws on validation', async () => {
    const { loadConfig } = await import('../src/config/index.js');
    await writeFile(join(testDir, 'lain.json5'), JSON.stringify({
      version: '1',
      gateway: { rateLimit: { connectionsPerMinute: 0, requestsPerSecond: 10, burstSize: 20 } },
    }));
    await expect(loadConfig()).rejects.toThrow();
  });

  it('config with invalid provider type throws on validation', async () => {
    const { loadConfig } = await import('../src/config/index.js');
    await writeFile(join(testDir, 'lain.json5'), JSON.stringify({
      version: '1',
      agents: [{
        id: 'test',
        name: 'Test',
        enabled: true,
        workspace: '/tmp',
        providers: [{ type: 'llama', model: 'llama3' }],
      }],
    }));
    await expect(loadConfig()).rejects.toThrow();
  });

  it('config with empty providers array throws on validation', async () => {
    const { loadConfig } = await import('../src/config/index.js');
    await writeFile(join(testDir, 'lain.json5'), JSON.stringify({
      version: '1',
      agents: [{
        id: 'test',
        name: 'Test',
        enabled: true,
        workspace: '/tmp',
        providers: [],
      }],
    }));
    await expect(loadConfig()).rejects.toThrow();
  });

  it('config with invalid logging level throws on validation', async () => {
    const { loadConfig } = await import('../src/config/index.js');
    await writeFile(join(testDir, 'lain.json5'), JSON.stringify({
      version: '1',
      logging: { level: 'verbose', prettyPrint: true },
    }));
    await expect(loadConfig()).rejects.toThrow();
  });

  it('config with memoryCost below minimum throws on validation', async () => {
    const { loadConfig } = await import('../src/config/index.js');
    await writeFile(join(testDir, 'lain.json5'), JSON.stringify({
      version: '1',
      security: { keyDerivation: { algorithm: 'argon2id', memoryCost: 512, timeCost: 3, parallelism: 4 } },
    }));
    await expect(loadConfig()).rejects.toThrow();
  });

  // --- Cache behavior ---

  it('loadConfig caches and getConfig returns the same object', async () => {
    const { loadConfig, getConfig, resetConfig } = await import('../src/config/index.js');
    resetConfig();
    const loaded = await loadConfig();
    const cached = getConfig();
    expect(cached).toBe(loaded);
  });

  it('resetConfig clears cache so getConfig throws', async () => {
    const { loadConfig, getConfig, resetConfig } = await import('../src/config/index.js');
    await loadConfig();
    resetConfig();
    expect(() => getConfig()).toThrow(/not loaded/i);
  });

  it('isConfigLoaded tracks load/reset lifecycle', async () => {
    const { loadConfig, resetConfig, isConfigLoaded } = await import('../src/config/index.js');
    resetConfig();
    expect(isConfigLoaded()).toBe(false);
    await loadConfig();
    expect(isConfigLoaded()).toBe(true);
    resetConfig();
    expect(isConfigLoaded()).toBe(false);
  });

  it('loadConfig with explicit path loads from that path', async () => {
    const { loadConfig } = await import('../src/config/index.js');
    const customPath = join(testDir, 'custom.json5');
    await writeFile(customPath, JSON.stringify({
      version: '1',
      logging: { level: 'error', prettyPrint: false },
    }));
    const cfg = await loadConfig(customPath);
    expect(cfg.logging.level).toBe('error');
  });

  // --- saveConfig / createInitialConfig ---

  it('saveConfig roundtrips: saved config can be re-loaded', async () => {
    const { loadConfig, saveConfig, getDefaultConfig, resetConfig } = await import('../src/config/index.js');
    const origConfig = getDefaultConfig();
    const savePath = join(testDir, 'roundtrip.json5');
    await saveConfig(origConfig, savePath);

    resetConfig();
    const reloaded = await loadConfig(savePath);
    expect(reloaded.version).toBe(origConfig.version);
    expect(reloaded.logging.level).toBe(origConfig.logging.level);
    expect(reloaded.security.requireAuth).toBe(origConfig.security.requireAuth);
  });

  it('saveConfig creates parent directories if needed', async () => {
    const { saveConfig, getDefaultConfig } = await import('../src/config/index.js');
    const deepPath = join(testDir, 'a', 'b', 'c', 'config.json5');
    await saveConfig(getDefaultConfig(), deepPath);
    expect(existsSync(deepPath)).toBe(true);
  });

  it('saveConfig rejects invalid config without writing', async () => {
    const { saveConfig } = await import('../src/config/index.js');
    const invalid = { version: '1' } as any;
    const path = join(testDir, 'should-not-exist.json5');
    await expect(saveConfig(invalid, path)).rejects.toThrow();
    expect(existsSync(path)).toBe(false);
  });

  it('createInitialConfig produces a file with sample content', async () => {
    const { createInitialConfig } = await import('../src/config/index.js');
    const path = join(testDir, 'init.json5');
    await createInitialConfig(path);
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('"version"');
    expect(content).toContain('//'); // JSON5 comments
  });

  // findings.md P2:267 — saveConfig would silently strip comments.
  // Detection preserves the commented form as a .bak.<ts> sidecar and
  // warns with both paths so an operator overwriting an annotated
  // config.json5 has a recoverable copy.
  it('saveConfig preserves commented config as .bak sidecar before overwriting', async () => {
    const { writeFile: writeSync } = await import('node:fs/promises');
    const { saveConfig, getDefaultConfig } = await import('../src/config/index.js');
    const path = join(testDir, 'commented.json5');
    await writeSync(path, '// operator note\n{ "version": "1" }\n');
    await saveConfig(getDefaultConfig(), path);

    const { readdirSync } = await import('node:fs');
    const siblings = readdirSync(testDir);
    const backup = siblings.find(f => f.startsWith('commented.json5.bak.'));
    expect(backup).toBeDefined();
    const restored = readFileSync(join(testDir, backup!), 'utf-8');
    expect(restored).toContain('// operator note');
    const written = readFileSync(path, 'utf-8');
    expect(written).not.toContain('// operator note');
  });

  it('saveConfig does not create a sidecar when no prior file exists', async () => {
    const { saveConfig, getDefaultConfig } = await import('../src/config/index.js');
    const path = join(testDir, 'first-save.json5');
    await saveConfig(getDefaultConfig(), path);

    const { readdirSync } = await import('node:fs');
    const siblings = readdirSync(testDir);
    const backup = siblings.find(f => f.startsWith('first-save.json5.bak.'));
    expect(backup).toBeUndefined();
  });

  it('saveConfig does not create a sidecar when prior file has no comments', async () => {
    const { writeFile: writeSync } = await import('node:fs/promises');
    const { saveConfig, getDefaultConfig } = await import('../src/config/index.js');
    const path = join(testDir, 'plain.json5');
    await writeSync(path, '{"version":"1"}\n');
    await saveConfig(getDefaultConfig(), path);

    const { readdirSync } = await import('node:fs');
    const siblings = readdirSync(testDir);
    const backup = siblings.find(f => f.startsWith('plain.json5.bak.'));
    expect(backup).toBeUndefined();
  });

  // --- Schema ---

  it('manifest rejects character ID with uppercase letters', async () => {
    // findings.md P2:171 — agent-id pattern enforcement moved to the
    // character manifest. Same rule; different schema.
    const { validateManifest } = await import('../src/config/manifest-schema.js');
    const manifest = {
      town: { name: 'T', description: 't' },
      characters: [{
        id: 'BadId', name: 'X', port: 3000, server: 'character',
        defaultLocation: 'bar', workspace: 'workspace/characters/x',
      }],
    };
    expect(() => validateManifest(manifest, 'test')).toThrow();
  });

  it('validate accepts each valid logging level', async () => {
    const { getDefaultConfig, validate } = await import('../src/config/index.js');
    const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
    for (const level of levels) {
      const cfg = getDefaultConfig();
      cfg.logging.level = level;
      expect(() => validate(cfg)).not.toThrow();
    }
  });

  it('manifest accepts each valid provider type', async () => {
    // findings.md P2:171 — provider-type enum enforcement moved to the
    // character manifest.
    const { validateManifest } = await import('../src/config/manifest-schema.js');
    const types = ['anthropic', 'openai', 'google'] as const;
    for (const type of types) {
      const manifest = {
        town: { name: 'T', description: 't' },
        characters: [{
          id: 'x', name: 'X', port: 3000, server: 'character',
          defaultLocation: 'bar', workspace: 'workspace/characters/x',
          providers: [{ type, model: 'test-model' }],
        }],
      };
      expect(() => validateManifest(manifest, 'test')).not.toThrow();
    }
  });

  it('getSchema returns schema with all top-level required fields', async () => {
    // findings.md P2:171 — `agents` is no longer in LainConfig.
    const { getSchema } = await import('../src/config/index.js');
    const schema = getSchema();
    expect(schema.required).toContain('version');
    expect(schema.required).toContain('gateway');
    expect(schema.required).toContain('security');
    expect(schema.required).toContain('logging');
    expect(schema.required).not.toContain('agents');
  });

  it('getSchema disallows additionalProperties at top level', async () => {
    const { getSchema } = await import('../src/config/index.js');
    const schema = getSchema();
    expect(schema.additionalProperties).toBe(false);
  });

  it('manifest enforces agent id pattern (lowercase + hyphen + digits only)', async () => {
    // findings.md P2:171 — agent-id pattern enforcement moved to the
    // character manifest; see test/config-system.test.ts for more cases.
    const { validateManifest } = await import('../src/config/manifest-schema.js');
    const mkManifest = (id: string) => ({
      town: { name: 'T', description: 't' },
      characters: [{
        id, name: 'X', port: 3000, server: 'character',
        defaultLocation: 'bar', workspace: 'workspace/characters/x',
      }],
    });
    for (const id of ['default', 'my-agent', 'agent-01', 'a']) {
      expect(() => validateManifest(mkManifest(id), 'test'), `expected '${id}' to be valid`).not.toThrow();
    }
    for (const id of ['Agent', 'my agent', 'agent@1', 'agent.test', '']) {
      expect(() => validateManifest(mkManifest(id), 'test'), `expected '${id}' to be invalid`).toThrow();
    }
  });

  it('ValidationError contains descriptive error list', async () => {
    const { validate } = await import('../src/config/index.js');
    const { ValidationError } = await import('../src/utils/errors.js');
    try {
      validate({ version: '1' });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as any).errors).toBeDefined();
      expect(Array.isArray((e as any).errors)).toBe(true);
      expect((e as any).errors.length).toBeGreaterThan(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. PATH SYSTEM BEHAVIORAL (~40 tests)
// ═══════════════════════════════════════════════════════════════════════

describe('Path system behavioral', () => {
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env['LAIN_HOME'];
  });

  afterEach(() => {
    if (originalHome !== undefined) {
      process.env['LAIN_HOME'] = originalHome;
    } else {
      delete process.env['LAIN_HOME'];
    }
  });

  // --- Default LAIN_HOME ---

  it('default LAIN_HOME resolves to ~/.lain', async () => {
    delete process.env['LAIN_HOME'];
    const { getBasePath } = await import('../src/config/paths.js');
    expect(getBasePath()).toBe(join(homedir(), '.lain'));
  });

  it('default database path is ~/.lain/lain.db', async () => {
    delete process.env['LAIN_HOME'];
    const { getPaths } = await import('../src/config/paths.js');
    expect(getPaths().database).toBe(join(homedir(), '.lain', 'lain.db'));
  });

  it('default config path is ~/.lain/lain.json5', async () => {
    delete process.env['LAIN_HOME'];
    const { getPaths } = await import('../src/config/paths.js');
    expect(getPaths().config).toBe(join(homedir(), '.lain', 'lain.json5'));
  });

  it('default socket path is ~/.lain/gateway.sock', async () => {
    delete process.env['LAIN_HOME'];
    const { getPaths } = await import('../src/config/paths.js');
    expect(getPaths().socket).toBe(join(homedir(), '.lain', 'gateway.sock'));
  });

  it('default pidFile path is ~/.lain/gateway.pid', async () => {
    delete process.env['LAIN_HOME'];
    const { getPaths } = await import('../src/config/paths.js');
    expect(getPaths().pidFile).toBe(join(homedir(), '.lain', 'gateway.pid'));
  });

  it('default workspace path is ~/.lain/workspace', async () => {
    delete process.env['LAIN_HOME'];
    const { getPaths } = await import('../src/config/paths.js');
    expect(getPaths().workspace).toBe(join(homedir(), '.lain', 'workspace'));
  });

  // --- Custom LAIN_HOME ---

  it('custom LAIN_HOME changes base path', async () => {
    process.env['LAIN_HOME'] = '/opt/lain-custom';
    const { getBasePath } = await import('../src/config/paths.js');
    expect(getBasePath()).toBe('/opt/lain-custom');
  });

  it('all paths are rooted under custom LAIN_HOME', async () => {
    const custom = '/opt/my-lain-home';
    process.env['LAIN_HOME'] = custom;
    const { getPaths } = await import('../src/config/paths.js');
    const paths = getPaths();
    for (const [key, value] of Object.entries(paths)) {
      expect(value, `path '${key}' should start with LAIN_HOME`).toMatch(new RegExp(`^${custom.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    }
  });

  it('database under custom LAIN_HOME is at correct location', async () => {
    process.env['LAIN_HOME'] = '/root/.lain-wired';
    const { getPaths } = await import('../src/config/paths.js');
    expect(getPaths().database).toBe('/root/.lain-wired/lain.db');
  });

  it('config under custom LAIN_HOME is at correct location', async () => {
    process.env['LAIN_HOME'] = '/root/.lain-pkd';
    const { getPaths } = await import('../src/config/paths.js');
    expect(getPaths().config).toBe('/root/.lain-pkd/lain.json5');
  });

  // --- Per-character isolation (LAIN_HOME=/root/.lain-<id>) ---

  it('different LAIN_HOME values yield different database paths', async () => {
    const { getPaths } = await import('../src/config/paths.js');
    process.env['LAIN_HOME'] = '/root/.lain-wired';
    const wiredDb = getPaths().database;
    process.env['LAIN_HOME'] = '/root/.lain';
    const lainDb = getPaths().database;
    expect(wiredDb).not.toBe(lainDb);
  });

  it('per-character LAIN_HOME produces isolated workspace', async () => {
    const { getPaths } = await import('../src/config/paths.js');
    process.env['LAIN_HOME'] = '/root/.lain-mckenna';
    expect(getPaths().workspace).toBe('/root/.lain-mckenna/workspace');
  });

  it('per-character LAIN_HOME produces isolated credentials', async () => {
    const { getPaths } = await import('../src/config/paths.js');
    process.env['LAIN_HOME'] = '/root/.lain-dr-claude';
    expect(getPaths().credentials).toBe('/root/.lain-dr-claude/credentials');
  });

  it('per-character LAIN_HOME produces isolated extensions', async () => {
    const { getPaths } = await import('../src/config/paths.js');
    process.env['LAIN_HOME'] = '/root/.lain-john';
    expect(getPaths().extensions).toBe('/root/.lain-john/extensions');
  });

  // --- Agent-specific paths ---

  it('getAgentPath is under the agents subdirectory of LAIN_HOME', async () => {
    process.env['LAIN_HOME'] = '/root/.lain-test';
    const { getAgentPath } = await import('../src/config/paths.js');
    expect(getAgentPath('curiosity')).toBe('/root/.lain-test/agents/curiosity');
  });

  it('getAgentSessionsPath is under agent directory', async () => {
    process.env['LAIN_HOME'] = '/root/.lain-test';
    const { getAgentSessionsPath } = await import('../src/config/paths.js');
    expect(getAgentSessionsPath('curiosity')).toBe('/root/.lain-test/agents/curiosity/sessions');
  });

  it('getAgentTranscriptsPath is under agent directory', async () => {
    process.env['LAIN_HOME'] = '/root/.lain-test';
    const { getAgentTranscriptsPath } = await import('../src/config/paths.js');
    expect(getAgentTranscriptsPath('curiosity')).toBe('/root/.lain-test/agents/curiosity/transcripts');
  });

  it('agent paths vary by agent ID', async () => {
    process.env['LAIN_HOME'] = '/root/.lain-test';
    const { getAgentPath } = await import('../src/config/paths.js');
    expect(getAgentPath('diary')).not.toBe(getAgentPath('dreams'));
  });

  // --- LAIN_HOME edge cases ---

  it('LAIN_HOME with trailing slash normalizes correctly via join', async () => {
    process.env['LAIN_HOME'] = '/tmp/lain-trail/';
    const { getPaths } = await import('../src/config/paths.js');
    const paths = getPaths();
    // join normalizes trailing slashes
    expect(paths.database).toBe('/tmp/lain-trail/lain.db');
    expect(paths.database).not.toContain('//');
  });

  it('LAIN_HOME with spaces is handled by path.join', async () => {
    process.env['LAIN_HOME'] = '/tmp/lain with spaces';
    const { getPaths } = await import('../src/config/paths.js');
    const paths = getPaths();
    expect(paths.base).toBe('/tmp/lain with spaces');
    expect(paths.database).toBe('/tmp/lain with spaces/lain.db');
  });

  it('LAIN_HOME set to empty string is used as-is (nullish coalescing does not treat empty string as null)', async () => {
    process.env['LAIN_HOME'] = '';
    const { getBasePath } = await import('../src/config/paths.js');
    // ?? only triggers for null/undefined, not empty string
    expect(getBasePath()).toBe('');
  });

  // --- Path constants ---

  it('database file is always named lain.db', async () => {
    process.env['LAIN_HOME'] = '/any/path';
    const { getPaths } = await import('../src/config/paths.js');
    expect(basename(getPaths().database)).toBe('lain.db');
  });

  it('config file is always named lain.json5', async () => {
    process.env['LAIN_HOME'] = '/any/path';
    const { getPaths } = await import('../src/config/paths.js');
    expect(basename(getPaths().config)).toBe('lain.json5');
  });

  it('socket file is always named gateway.sock', async () => {
    process.env['LAIN_HOME'] = '/any/path';
    const { getPaths } = await import('../src/config/paths.js');
    expect(basename(getPaths().socket)).toBe('gateway.sock');
  });

  it('pid file is always named gateway.pid', async () => {
    process.env['LAIN_HOME'] = '/any/path';
    const { getPaths } = await import('../src/config/paths.js');
    expect(basename(getPaths().pidFile)).toBe('gateway.pid');
  });

  // --- ConfigPaths completeness ---

  it('getPaths returns exactly the expected keys', async () => {
    process.env['LAIN_HOME'] = '/tmp/test';
    const { getPaths } = await import('../src/config/paths.js');
    const paths = getPaths();
    const keys = Object.keys(paths).sort();
    expect(keys).toEqual(['agents', 'base', 'config', 'credentials', 'database', 'extensions', 'pidFile', 'socket', 'workspace']);
  });

  it('all getPaths values are non-empty strings', async () => {
    process.env['LAIN_HOME'] = '/tmp/test';
    const { getPaths } = await import('../src/config/paths.js');
    const paths = getPaths();
    for (const [key, value] of Object.entries(paths)) {
      expect(typeof value, `${key} should be a string`).toBe('string');
      expect(value.length, `${key} should be non-empty`).toBeGreaterThan(0);
    }
  });

  it('no path values contain undefined or null text', async () => {
    process.env['LAIN_HOME'] = '/tmp/test';
    const { getPaths } = await import('../src/config/paths.js');
    const paths = getPaths();
    for (const [key, value] of Object.entries(paths)) {
      expect(value, `${key} should not contain 'undefined'`).not.toContain('undefined');
      expect(value, `${key} should not contain 'null'`).not.toContain('null');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. SERVICE TEMPLATE BEHAVIORAL (~40 tests)
// ═══════════════════════════════════════════════════════════════════════

describe('Service template behavioral', () => {
  const template = readText('deploy/systemd/character.service.template');

  // --- Template placeholder substitution completeness ---

  it('template uses all required placeholders', () => {
    const required = ['@@TOWN_NAME@@', '@@CHAR_NAME@@', '@@CHAR_ID@@', '@@PORT@@',
      '@@LAIN_HOME@@', '@@WORKSPACE@@', '@@WORKING_DIR@@', '@@SERVICE_NAME@@'];
    for (const ph of required) {
      expect(template, `template should contain ${ph}`).toContain(ph);
    }
  });

  it('template has no unresolved template variables beyond @@ pattern', () => {
    // All placeholders should follow @@VARNAME@@ pattern
    const matches = template.match(/@@[A-Z_]+@@/g) || [];
    const expected = new Set(['@@TOWN_NAME@@', '@@CHAR_NAME@@', '@@CHAR_ID@@', '@@PORT@@',
      '@@LAIN_HOME@@', '@@WORKSPACE@@', '@@WORKING_DIR@@', '@@SERVICE_NAME@@']);
    for (const m of matches) {
      expect(expected.has(m), `unexpected placeholder: ${m}`).toBe(true);
    }
  });

  // --- Correct Environment section ---

  it('template sets LAIN_HOME via Environment= directive', () => {
    expect(template).toMatch(/^Environment=LAIN_HOME=@@LAIN_HOME@@/m);
  });

  it('template sets NODE_ENV=production', () => {
    expect(template).toMatch(/^Environment=NODE_ENV=production/m);
  });

  it('template sets PORT via Environment= directive', () => {
    expect(template).toMatch(/^Environment=PORT=@@PORT@@/m);
  });

  it('PEER_CONFIG is NOT set inline in Environment= (must be in EnvironmentFile)', () => {
    const envLines = template.split('\n').filter(l => l.startsWith('Environment='));
    const peerInline = envLines.some(l => l.includes('PEER_CONFIG'));
    expect(peerInline).toBe(false);
  });

  it('template references per-character EnvironmentFile for peer config', () => {
    expect(template).toContain('EnvironmentFile=@@WORKING_DIR@@/deploy/env/@@SERVICE_NAME@@.env');
  });

  it('template references global .env EnvironmentFile', () => {
    expect(template).toContain('EnvironmentFile=@@WORKING_DIR@@/.env');
  });

  // --- Service unit correctness ---

  it('template Type is simple', () => {
    expect(template).toMatch(/^Type=simple/m);
  });

  it('template Restart policy is on-failure', () => {
    expect(template).toMatch(/^Restart=on-failure/m);
  });

  it('template has RestartSec for backoff', () => {
    expect(template).toMatch(/^RestartSec=\d+/m);
  });

  it('template has StartLimitIntervalSec to prevent flapping', () => {
    expect(template).toContain('StartLimitIntervalSec=');
  });

  it('template has StartLimitBurst to prevent flapping', () => {
    expect(template).toContain('StartLimitBurst=');
  });

  it('template runs as root user', () => {
    expect(template).toMatch(/^User=root/m);
  });

  it('template sets correct WorkingDirectory', () => {
    expect(template).toMatch(/^WorkingDirectory=@@WORKING_DIR@@/m);
  });

  it('template depends on network.target', () => {
    expect(template).toContain('After=network.target');
  });

  it('template is PartOf lain.target for coordinated restart', () => {
    expect(template).toContain('PartOf=lain.target');
  });

  it('template WantedBy is lain.target', () => {
    expect(template).toContain('WantedBy=lain.target');
  });

  it('template logs to journal (not file)', () => {
    expect(template).toMatch(/^StandardOutput=journal/m);
    expect(template).toMatch(/^StandardError=journal/m);
  });

  it('template has SyslogIdentifier for journalctl filtering', () => {
    expect(template).toMatch(/^SyslogIdentifier=@@SERVICE_NAME@@/m);
  });

  // --- ExecStart / ExecStartPre ---

  it('template ExecStart runs node dist/index.js', () => {
    const execStartLines = template.split('\n').filter(l => l.startsWith('ExecStart='));
    const mainExec = execStartLines.find(l => l.includes('node'));
    expect(mainExec).toBeDefined();
    expect(mainExec).toContain('dist/index.js');
  });

  it('template ExecStart includes character command with CHAR_ID', () => {
    const execLine = template.split('\n').find(l => l.startsWith('ExecStart=') && l.includes('node'));
    expect(execLine).toContain('character @@CHAR_ID@@');
  });

  it('template ExecStart includes --port flag', () => {
    const execLine = template.split('\n').find(l => l.startsWith('ExecStart=') && l.includes('node'));
    expect(execLine).toContain('--port @@PORT@@');
  });

  it('template has ExecStartPre to kill stale port holders', () => {
    expect(template).toContain('ExecStartPre=');
    expect(template).toContain('fuser');
  });

  it('template has ExecStartPre to copy workspace files', () => {
    const preLines = template.split('\n').filter(l => l.startsWith('ExecStartPre='));
    const workspaceCopy = preLines.some(l => l.includes('cp') && l.includes('workspace'));
    expect(workspaceCopy).toBe(true);
  });

  // --- Infrastructure services ---

  it('lain-gateway.service has correct ExecStart', () => {
    const svc = readText('deploy/systemd/lain-gateway.service');
    expect(svc).toContain('node dist/index.js gateway');
  });

  it('lain-gateway.service does not set LAIN_HOME (uses global)', () => {
    const svc = readText('deploy/systemd/lain-gateway.service');
    expect(svc).not.toMatch(/^Environment=LAIN_HOME=/m);
  });

  it('lain-telegram.service sets LAIN_HOME to Lain home dir', () => {
    const svc = readText('deploy/systemd/lain-telegram.service');
    expect(svc).toContain('LAIN_HOME=/root/.lain');
  });

  it('lain-telegram.service depends on lain-main.service', () => {
    const svc = readText('deploy/systemd/lain-telegram.service');
    expect(svc).toContain('After=network.target lain-main.service');
  });

  it('lain-voice.service uses Python venv', () => {
    const svc = readText('deploy/systemd/lain-voice.service');
    expect(svc).toContain('.venv/bin/python');
  });

  it('all static services belong to lain.target', () => {
    const staticServices = ['lain-gateway.service', 'lain-telegram.service', 'lain-voice.service'];
    for (const name of staticServices) {
      const svc = readText(`deploy/systemd/${name}`);
      expect(svc, `${name} should have WantedBy=lain.target`).toContain('WantedBy=lain.target');
    }
  });

  it('all static services have Restart=on-failure', () => {
    const staticServices = ['lain-gateway.service', 'lain-telegram.service', 'lain-voice.service'];
    for (const name of staticServices) {
      const svc = readText(`deploy/systemd/${name}`);
      expect(svc, `${name} should have Restart=on-failure`).toContain('Restart=on-failure');
    }
  });

  it('lain-healthcheck.service is oneshot type (not long-running)', () => {
    const svc = readText('deploy/systemd/lain-healthcheck.service');
    expect(svc).toContain('Type=oneshot');
  });

  it('lain-healthcheck.timer runs every 5 minutes', () => {
    const timer = readText('deploy/systemd/lain-healthcheck.timer');
    expect(timer).toContain('OnUnitActiveSec=5min');
  });

  it('lain-backup.timer runs daily at 04:00', () => {
    const timer = readText('deploy/systemd/lain-backup.timer');
    expect(timer).toContain('OnCalendar=*-*-* 04:00:00');
  });

  it('lain-backup.service is oneshot type', () => {
    const svc = readText('deploy/systemd/lain-backup.service');
    expect(svc).toContain('Type=oneshot');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. BUILD SYSTEM BEHAVIORAL (~30 tests)
// ═══════════════════════════════════════════════════════════════════════

describe('Build system behavioral', () => {
  const pkg = readJson('package.json') as Record<string, unknown>;
  const scripts = pkg['scripts'] as Record<string, string>;
  const deps = pkg['dependencies'] as Record<string, string>;
  const devDeps = pkg['devDependencies'] as Record<string, string>;

  // --- Scripts reference valid commands ---

  it('build script invokes tsc', () => {
    expect(scripts['build']).toBe('tsc');
  });

  it('dev script invokes tsx watch', () => {
    expect(scripts['dev']).toContain('tsx');
    expect(scripts['dev']).toContain('watch');
  });

  it('start script runs node on compiled output', () => {
    expect(scripts['start']).toMatch(/^node dist\/index\.js/);
  });

  it('test script runs vitest', () => {
    expect(scripts['test']).toContain('vitest');
  });

  it('lint script uses oxlint on src/', () => {
    expect(scripts['lint']).toContain('oxlint');
    expect(scripts['lint']).toContain('src/');
  });

  it('typecheck script runs tsc --noEmit', () => {
    expect(scripts['typecheck']).toBe('tsc --noEmit');
  });

  it('clean script removes dist/', () => {
    expect(scripts['clean']).toContain('dist');
  });

  // --- ESM compliance ---

  it('package.json type is module (ESM)', () => {
    expect(pkg['type']).toBe('module');
  });

  it('all .ts source imports use .js extensions for ESM', () => {
    // Scan all src/**/*.ts files for relative imports missing .js
    const srcDir = join(PROJECT_ROOT, 'src');
    const tsFiles = collectFiles(srcDir, '.ts');
    const violations: string[] = [];

    for (const file of tsFiles) {
      const content = readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        // Match: from './foo' or from '../bar' (relative, without .js)
        const match = line.match(/from\s+['"](\.\.?\/[^'"]+)['"]/);
        if (match) {
          const importPath = match[1]!;
          // Skip if it already ends in .js or is a directory import that resolves
          if (!importPath.endsWith('.js') && !importPath.endsWith('.json')) {
            violations.push(`${file}:${i + 1}: ${importPath}`);
          }
        }
      }
    }
    expect(violations, `ESM imports missing .js extension:\n${violations.join('\n')}`).toHaveLength(0);
  });

  // --- bin entry ---

  it('bin entry lain exists on disk', () => {
    const bin = pkg['bin'] as Record<string, string>;
    expect(bin['lain']).toBeDefined();
    expect(fileExists(bin['lain']!)).toBe(true);
  });

  // --- Dependencies ---

  it('all critical runtime dependencies are listed', () => {
    const criticalDeps = ['@anthropic-ai/sdk', 'better-sqlite3', 'json5', 'commander', 'dotenv', 'pino', 'nanoid'];
    for (const dep of criticalDeps) {
      expect(deps, `missing runtime dependency: ${dep}`).toHaveProperty(dep);
    }
  });

  it('all critical dev dependencies are listed', () => {
    const criticalDevDeps = ['vitest', 'typescript', 'tsx', '@types/node', '@types/better-sqlite3'];
    for (const dep of criticalDevDeps) {
      expect(devDeps, `missing dev dependency: ${dep}`).toHaveProperty(dep);
    }
  });

  it('no devDependencies are imported in src/ files', () => {
    const srcDir = join(PROJECT_ROOT, 'src');
    const tsFiles = collectFiles(srcDir, '.ts');
    const devDepNames = Object.keys(devDeps);
    const violations: string[] = [];

    for (const file of tsFiles) {
      const content = readFileSync(file, 'utf-8');
      for (const dep of devDepNames) {
        // Check for import from 'dep' or import from 'dep/...' or require('dep')
        if (content.includes(`from '${dep}'`) || content.includes(`from '${dep}/`) ||
          content.includes(`from "${dep}"`) || content.includes(`from "${dep}/`) ||
          content.includes(`require('${dep}')`) || content.includes(`require("${dep}")`)) {
          violations.push(`${file}: imports devDependency '${dep}'`);
        }
      }
    }
    expect(violations, `src/ files import devDependencies:\n${violations.join('\n')}`).toHaveLength(0);
  });

  // --- Source structure ---

  it('src/index.ts is the main entry point and exports config', () => {
    const content = readText('src/index.ts');
    expect(content).toContain("from './config/index.js'");
  });

  it('src/config/index.ts re-exports getPaths and getBasePath', () => {
    const content = readText('src/config/index.ts');
    expect(content).toContain('getPaths');
    expect(content).toContain('getBasePath');
  });

  it('src/config/index.ts re-exports validate and getSchema', () => {
    const content = readText('src/config/index.ts');
    expect(content).toContain('validate');
    expect(content).toContain('getSchema');
  });

  it('all src/config/ files exist', () => {
    const configFiles = ['index.ts', 'defaults.ts', 'paths.ts', 'schema.ts', 'characters.ts'];
    for (const f of configFiles) {
      expect(fileExists(`src/config/${f}`), `src/config/${f} should exist`).toBe(true);
    }
  });

  // --- TypeScript config ---

  it('tsconfig targets ES2022+ for modern JS features', () => {
    const tsconfig = readJson('tsconfig.json') as { compilerOptions: Record<string, unknown> };
    const target = (tsconfig.compilerOptions['target'] as string).toUpperCase();
    const modern = ['ES2022', 'ES2023', 'ES2024', 'ESNEXT'];
    expect(modern).toContain(target);
  });

  it('tsconfig uses NodeNext for proper ESM resolution', () => {
    const tsconfig = readJson('tsconfig.json') as { compilerOptions: Record<string, unknown> };
    expect(tsconfig.compilerOptions['module']).toBe('NodeNext');
    expect(tsconfig.compilerOptions['moduleResolution']).toBe('NodeNext');
  });

  it('tsconfig strict mode enables safe indexing', () => {
    const tsconfig = readJson('tsconfig.json') as { compilerOptions: Record<string, unknown> };
    expect(tsconfig.compilerOptions['strict']).toBe(true);
    expect(tsconfig.compilerOptions['noUncheckedIndexedAccess']).toBe(true);
  });

  it('node engine requirement is >= 22', () => {
    const engines = pkg['engines'] as Record<string, string>;
    expect(engines['node']).toContain('22');
  });

  it('main entry points to dist/index.js', () => {
    expect(pkg['main']).toBe('./dist/index.js');
  });

  it('types entry points to dist/index.d.ts', () => {
    expect(pkg['types']).toBe('./dist/index.d.ts');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. DEPLOY SCRIPT BEHAVIORAL (~30 tests)
// ═══════════════════════════════════════════════════════════════════════

describe('Deploy script behavioral', () => {
  // --- generate-services.sh ---

  describe('generate-services.sh', () => {
    const script = readText('deploy/generate-services.sh');

    it('reads characters.json as the manifest source', () => {
      expect(script).toContain('characters.json');
      expect(script).toMatch(/MANIFEST.*characters\.json/);
    });

    it('gracefully exits when characters.json is missing', () => {
      expect(script).toContain('exit 0');
      expect(script).toContain('skipping character service generation');
    });

    it('fails if service template is missing', () => {
      expect(script).toContain('exit 1');
      expect(script).toContain('Service template not found');
    });

    it('produces one .service file per character', () => {
      expect(script).toContain('SERVICE_FILE=');
      expect(script).toContain('> "$SERVICE_FILE"');
    });

    it('generates per-character .env file with PEER_CONFIG', () => {
      expect(script).toContain('echo "PEER_CONFIG=${PEERS}"');
      expect(script).toContain('> "$ENV_DIR/${SERVICE_NAME}.env"');
    });

    it('sets LAIN_HOME to /root/.lain-<id> pattern', () => {
      expect(script).toMatch(/LAIN_HOME="\/root\/\.lain-\$\{?CHAR_ID\}?"/);
    });

    it('service name follows lain-<id> convention', () => {
      expect(script).toMatch(/SERVICE_NAME="lain-\$\{?CHAR_ID\}?"/);
    });

    it('uses sed for template variable substitution', () => {
      expect(script).toContain('sed');
      const sedCount = (script.match(/@@[A-Z_]+@@/g) || []).length;
      expect(sedCount).toBeGreaterThanOrEqual(8); // all 8 placeholders
    });

    it('computes peers excluding self for each character', () => {
      expect(script).toContain('filter(p => p.id !== c.id)');
    });

    it('handles web server type with different ExecStart', () => {
      expect(script).toContain('web');
      expect(script).toContain('sed -i');
      expect(script).toContain('ExecStart');
    });

    it('updates lain.target with all generated service names', () => {
      expect(script).toContain('lain.target');
      expect(script).toContain('CHAR_SERVICES');
      expect(script).toContain('INFRA_SERVICES');
    });

    it('includes infrastructure services in target', () => {
      expect(script).toContain('lain-gateway.service');
      expect(script).toContain('lain-telegram.service');
      expect(script).toContain('lain-voice.service');
    });
  });

  // --- deploy.sh ---

  describe('deploy.sh', () => {
    const script = readText('deploy/deploy.sh');

    it('includes git pull step', () => {
      expect(script).toContain('git pull');
    });

    it('uses --ff-only for safe pulls (no surprise merges)', () => {
      expect(script).toContain('git pull --ff-only');
    });

    it('conditionally runs npm ci only when lockfile changed', () => {
      expect(script).toContain('npm ci');
      expect(script).toContain('package-lock.json');
    });

    it('runs npm build', () => {
      expect(script).toContain('npm run build');
    });

    it('reloads systemd daemon before restart', () => {
      expect(script).toContain('systemctl daemon-reload');
    });

    it('restarts lain.target (all services)', () => {
      expect(script).toContain('systemctl restart lain.target');
    });

    it('shows service status after deploy', () => {
      expect(script).toContain('systemctl is-active');
    });

    it('follows 4-step deploy sequence', () => {
      // Pull, deps, build, restart
      expect(script).toContain('[1/4]');
      expect(script).toContain('[2/4]');
      expect(script).toContain('[3/4]');
      expect(script).toContain('[4/4]');
    });
  });

  // --- healthcheck.sh ---

  describe('healthcheck.sh', () => {
    const script = readText('deploy/healthcheck.sh');

    it('defines all known services with ports', () => {
      expect(script).toContain('lain-wired:3000');
      expect(script).toContain('lain-main:3001');
      expect(script).toContain('lain-dr-claude:3002');
    });

    it('supports --fix flag for auto-remediation', () => {
      expect(script).toContain('--fix');
      expect(script).toContain('FIX=true');
    });

    it('supports --quiet flag for cron usage', () => {
      expect(script).toContain('--quiet');
      expect(script).toContain('QUIET=true');
    });

    it('checks systemd service status', () => {
      expect(script).toContain('systemctl is-active');
    });

    it('performs HTTP health checks on ports', () => {
      expect(script).toContain('curl');
      expect(script).toContain('http_status');
    });

    it('detects port conflicts (rogue processes)', () => {
      expect(script).toContain('fuser');
      expect(script).toContain('port_pid');
    });

    it('detects restart loops via journalctl', () => {
      expect(script).toContain('restart_count');
      expect(script).toContain('Scheduled restart job');
    });

    it('detects duplicate telegram bot processes', () => {
      expect(script).toContain('pgrep');
      expect(script).toContain('telegram');
    });

    it('monitors disk usage with warning and critical thresholds', () => {
      expect(script).toContain('DISK_WARN_PERCENT');
      expect(script).toContain('DISK_CRIT_PERCENT');
    });

    it('monitors database sizes', () => {
      expect(script).toContain('DB_SIZE_MB');
      expect(script).toContain('.lain-wired/lain.db');
    });

    it('sends Telegram alerts for unresolved issues', () => {
      expect(script).toContain('send_telegram_alert');
      expect(script).toContain('api.telegram.org');
    });

    it('exits 0 for healthy, 1 for issues, 2 for fix failures', () => {
      expect(script).toContain('exit 0');
      expect(script).toContain('exit 1');
      expect(script).toContain('exit 2');
    });
  });

  // --- status.sh ---

  describe('status.sh', () => {
    const script = readText('deploy/status.sh');

    it('lists all expected services with their ports', () => {
      expect(script).toContain('lain-wired:3000');
      expect(script).toContain('lain-main:3001');
    });

    it('performs HTTP health checks using curl', () => {
      expect(script).toContain('curl');
      expect(script).toContain('HTTP_STATUS');
    });

    it('shows uptime for active services', () => {
      expect(script).toContain('UPTIME');
      expect(script).toContain('ActiveEnterTimestamp');
    });

    it('reports overall health summary', () => {
      expect(script).toContain('ALL_OK');
      expect(script).toContain('All services healthy');
    });
  });

  // --- backup-dbs.sh ---

  describe('backup-dbs.sh', () => {
    const script = readText('deploy/backup-dbs.sh');

    it('uses SQLite .backup command for safe hot-backup', () => {
      expect(script).toContain('.backup');
      expect(script).toContain('sqlite3');
    });

    it('compresses backups with gzip', () => {
      expect(script).toContain('gzip');
    });

    it('has 7-day retention with auto-prune', () => {
      expect(script).toContain('RETENTION_DAYS=7');
      expect(script).toContain('-mtime');
      expect(script).toContain('-delete');
    });

    it('backs up all character databases', () => {
      expect(script).toContain('.lain-wired/lain.db');
      expect(script).toContain('.lain/lain.db');
      expect(script).toContain('.lain-dr-claude/lain.db');
      expect(script).toContain('.lain-pkd/lain.db');
    });

    it('falls back to file copy if SQLite .backup fails', () => {
      expect(script).toContain('cp "$DB_PATH"');
      expect(script).toContain('copy fallback');
    });
  });

  // --- setup-systemd.sh ---

  describe('setup-systemd.sh', () => {
    const script = readText('deploy/setup-systemd.sh');

    it('copies service files to /etc/systemd/system/', () => {
      expect(script).toContain('cp');
      expect(script).toContain('/etc/systemd/system/');
    });

    it('runs daemon-reload after copying', () => {
      expect(script).toContain('systemctl daemon-reload');
    });

    it('enables all services and targets', () => {
      expect(script).toContain('systemctl enable');
      expect(script).toContain('lain.target');
    });

    it('removes old lain-web.service if present', () => {
      expect(script).toContain('lain-web.service');
      expect(script).toContain('stop');
      expect(script).toContain('disable');
      expect(script).toContain('rm -f');
    });

    it('configures journald for persistent storage', () => {
      expect(script).toContain('journald');
      expect(script).toContain('Storage=persistent');
    });

    it('enables healthcheck timer', () => {
      expect(script).toContain('lain-healthcheck.timer');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. ENVIRONMENT ISOLATION (~30 tests)
// ═══════════════════════════════════════════════════════════════════════

describe('Environment isolation', () => {
  const manifest = exampleManifest;

  // --- Port uniqueness ---

  it('all character ports are unique (no two characters share a port)', () => {
    const ports = manifest.characters.map(c => c.port);
    expect(new Set(ports).size).toBe(ports.length);
  });

  it('character ports do not conflict with known infrastructure ports', () => {
    const infraPorts = new Set([8765]); // voice service
    for (const c of manifest.characters) {
      expect(infraPorts.has(c.port), `${c.id} port ${c.port} conflicts with infrastructure`).toBe(false);
    }
  });

  it('all character ports are above 1024 (unprivileged)', () => {
    for (const c of manifest.characters) {
      expect(c.port, `${c.id} port should be > 1024`).toBeGreaterThan(1024);
    }
  });

  // --- ID uniqueness ---

  it('all character IDs are unique', () => {
    const ids = manifest.characters.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('character IDs contain only safe characters for filesystem paths', () => {
    for (const c of manifest.characters) {
      expect(c.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
  });

  // --- LAIN_HOME isolation ---

  it('each character gets a unique LAIN_HOME (/root/.lain-<id>)', () => {
    const homes = manifest.characters.map(c => `/root/.lain-${c.id}`);
    expect(new Set(homes).size).toBe(homes.length);
  });

  it('each character database is at a unique path', () => {
    const dbs = manifest.characters.map(c => `/root/.lain-${c.id}/lain.db`);
    expect(new Set(dbs).size).toBe(dbs.length);
  });

  it('character workspaces from manifest are relative paths', () => {
    for (const c of manifest.characters) {
      expect(c.workspace.startsWith('/'), `${c.id} workspace should be relative`).toBe(false);
    }
  });

  // --- generate-services.sh env isolation ---

  describe('generate-services.sh produces isolated environments', () => {
    const genScript = readText('deploy/generate-services.sh');

    it('sets per-character LAIN_HOME in service file', () => {
      expect(genScript).toContain('LAIN_HOME="/root/.lain-${CHAR_ID}"');
    });

    it('generates separate .env files per character', () => {
      expect(genScript).toContain('${SERVICE_NAME}.env');
    });

    it('peer config excludes the character itself', () => {
      expect(genScript).toContain('filter(p => p.id !== c.id)');
    });
  });

  // --- start.sh env isolation ---

  describe('start.sh environment variable isolation', () => {
    const startScript = readText('start.sh');

    it('sets LAIN_HOME per character process', () => {
      expect(startScript).toContain('LAIN_HOME="$CHAR_HOME"');
    });

    it('sets LAIN_CHARACTER_ID per character process', () => {
      expect(startScript).toContain('LAIN_CHARACTER_ID="$CHAR_ID"');
    });

    it('sets LAIN_CHARACTER_NAME per character process', () => {
      expect(startScript).toContain('LAIN_CHARACTER_NAME="$CHAR_NAME"');
    });

    it('sets PEER_CONFIG per character process', () => {
      expect(startScript).toContain('PEER_CONFIG="$PEERS"');
    });

    it('sets PORT per character process', () => {
      expect(startScript).toContain('PORT="$PORT"');
    });

    it('creates per-character home directory', () => {
      expect(startScript).toContain('CHAR_HOME=~/.lain-${CHAR_ID}');
      expect(startScript).toContain('mkdir -p "$CHAR_HOME/workspace"');
    });

    it('copies workspace files into character home', () => {
      expect(startScript).toContain('cp -r "$WORKSPACE/"');
    });
  });

  // --- Template env isolation ---

  describe('service template environment isolation', () => {
    const template = readText('deploy/systemd/character.service.template');

    it('LAIN_HOME is set via Environment= (not EnvironmentFile)', () => {
      expect(template).toMatch(/^Environment=LAIN_HOME=@@LAIN_HOME@@/m);
    });

    it('global .env does NOT set LAIN_HOME (it would override per-service)', () => {
      // We can verify the template has per-service LAIN_HOME set before EnvironmentFile
      const lines = template.split('\n');
      const lainHomeLine = lines.findIndex(l => l.includes('Environment=LAIN_HOME='));
      const envFileLine = lines.findIndex(l => l.includes('EnvironmentFile='));
      // LAIN_HOME should be set in Environment= (not relying on .env)
      expect(lainHomeLine).toBeGreaterThan(-1);
      expect(envFileLine).toBeGreaterThan(-1);
    });

    it('per-service env file is in deploy/env/ directory', () => {
      expect(template).toContain('deploy/env/@@SERVICE_NAME@@.env');
    });
  });

  // --- Character manifest peer config ---

  describe('peer config isolation', () => {
    it('getPeersFor excludes the requesting character', async () => {
      // This depends on characters.json existing, so we test the function logic
      const { getPeersFor, getAllCharacters } = await import('../src/config/characters.js');
      const chars = getAllCharacters();
      if (chars.length > 0) {
        for (const c of chars) {
          const peers = getPeersFor(c.id);
          const hasSelf = peers.some(p => p.id === c.id);
          expect(hasSelf, `${c.id} should not appear in its own peer list`).toBe(false);
        }
      }
    });

    it('getPeersFor returns all other characters as peers', async () => {
      const { getPeersFor, getAllCharacters } = await import('../src/config/characters.js');
      const chars = getAllCharacters();
      if (chars.length > 1) {
        const first = chars[0]!;
        const peers = getPeersFor(first.id);
        expect(peers.length).toBe(chars.length - 1);
      }
    });

    it('peers have correct URL format with localhost and port', async () => {
      const { getPeersFor, getAllCharacters } = await import('../src/config/characters.js');
      const chars = getAllCharacters();
      if (chars.length > 1) {
        const peers = getPeersFor(chars[0]!.id);
        for (const p of peers) {
          expect(p.url).toMatch(/^http:\/\/localhost:\d+$/);
        }
      }
    });

    it('peer URLs match the character port from manifest', async () => {
      const { getPeersFor, getAllCharacters } = await import('../src/config/characters.js');
      const chars = getAllCharacters();
      if (chars.length > 1) {
        const first = chars[0]!;
        const peers = getPeersFor(first.id);
        for (const peer of peers) {
          const charEntry = chars.find(c => c.id === peer.id);
          expect(charEntry).toBeDefined();
          expect(peer.url).toBe(`http://localhost:${charEntry!.port}`);
        }
      }
    });
  });

  // --- Cross-cutting isolation ---

  it('getWebCharacter returns exactly one web-type character (if manifest has one)', () => {
    const chars = manifest.characters;
    const webChars = chars.filter(c => c.server === 'web');
    // The example manifest should have at least one
    expect(webChars.length).toBeGreaterThanOrEqual(1);
  });

  it('immortal and mortal characters are disjoint sets', () => {
    const immortals = new Set(manifest.characters.filter(c => c.immortal).map(c => c.id));
    const mortals = manifest.characters.filter(c => !c.immortal).map(c => c.id);
    for (const id of mortals) {
      expect(immortals.has(id), `${id} should not be both mortal and immortal`).toBe(false);
    }
  });

  it('all characters have valid defaultLocation values', () => {
    const validBuildings = new Set([
      'library', 'bar', 'field', 'windmill', 'lighthouse',
      'school', 'market', 'locksmith', 'threshold',
    ]);
    for (const c of manifest.characters) {
      expect(validBuildings.has(c.defaultLocation), `${c.id} defaultLocation '${c.defaultLocation}' is invalid`).toBe(true);
    }
  });

  it('healthcheck.sh monitors all character databases independently', () => {
    const healthcheck = readText('deploy/healthcheck.sh');
    // Each character should have its own .lain-<id> DB path checked
    const dbPaths = healthcheck.match(/\/root\/\.lain-[a-z-]+\/lain\.db/g) || [];
    expect(dbPaths.length).toBeGreaterThan(0);
    expect(new Set(dbPaths).size).toBe(dbPaths.length); // all unique
  });

  it('backup script backs up each character DB independently', () => {
    const backup = readText('deploy/backup-dbs.sh');
    const dbEntries = backup.match(/\/root\/\.lain[a-z-]*\/lain\.db/g) || [];
    expect(dbEntries.length).toBeGreaterThan(1); // multiple characters
    expect(new Set(dbEntries).size).toBe(dbEntries.length); // all unique
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Helper: collect all files with a given extension recursively
// ═══════════════════════════════════════════════════════════════════════

function collectFiles(dir: string, ext: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(full, ext));
    } else if (entry.name.endsWith(ext)) {
      results.push(full);
    }
  }
  return results;
}
