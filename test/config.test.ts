/**
 * Configuration tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadConfig,
  getDefaultConfig,
  resetConfig,
  validate,
} from '../src/config/index.js';
import { generateSampleConfig } from '../src/config/defaults.js';
import {
  getSystemdUnit,
  getHomeDir,
  getInhabitants,
  getOracles,
  getHealthCheckTargets,
  getDossierSubjects,
  getDreamSeedTargets,
  getCharacterDatabases,
  loadManifest,
  getAllCharacters,
  _resetManifestCache,
} from '../src/config/characters.js';
import { getLogger } from '../src/utils/logger.js';

describe('Configuration', () => {
  const testDir = join(tmpdir(), 'lain-test-config');
  const originalEnv = process.env['LAIN_HOME'];

  beforeEach(async () => {
    process.env['LAIN_HOME'] = testDir;
    await mkdir(testDir, { recursive: true });
    resetConfig();
  });

  afterEach(async () => {
    if (originalEnv) {
      process.env['LAIN_HOME'] = originalEnv;
    } else {
      delete process.env['LAIN_HOME'];
    }
    try {
      await rm(testDir, { recursive: true });
    } catch {
      // Ignore
    }
  });

  describe('getDefaultConfig', () => {
    it('should return valid default configuration', () => {
      // findings.md P2:171 — `agents` is no longer part of LainConfig.
      const config = getDefaultConfig();

      expect(config.version).toBe('1');
      expect(config.gateway).toBeDefined();
      expect(config.security).toBeDefined();
      expect(config.logging).toBeDefined();
      expect((config as Record<string, unknown>)['agents']).toBeUndefined();
    });

    it('should use LAIN_HOME for paths', () => {
      const config = getDefaultConfig();

      expect(config.gateway.socketPath).toContain(testDir);
    });

    // findings.md P2:231 — the provider triple's order is load-bearing:
    // src/agent/index.ts reads tiers as ['personality', 'memory', 'light'].
    // findings.md P2:171 — providers moved out of lain.json5 into
    // characters.json; defaults live in `DEFAULT_PROVIDERS`.
    it('exposes exactly three provider tiers in personality/memory/light order', async () => {
      const { DEFAULT_PROVIDERS } = await import('../src/config/defaults.js');
      expect(DEFAULT_PROVIDERS).toHaveLength(3);
      expect(DEFAULT_PROVIDERS[0]!.type).toBe('anthropic');
      expect(DEFAULT_PROVIDERS[0]!.model).toMatch(/sonnet/);
      expect(DEFAULT_PROVIDERS[1]!.model).toMatch(/haiku/);
      expect(DEFAULT_PROVIDERS[2]!.model).toMatch(/haiku/);
    });

    it('gives both Haiku tiers their own independent entries (not aliased)', async () => {
      const { DEFAULT_PROVIDERS } = await import('../src/config/defaults.js');
      expect(DEFAULT_PROVIDERS[1]).not.toBe(DEFAULT_PROVIDERS[2]);
      expect(DEFAULT_PROVIDERS[1]!.fallbackModels).not.toBe(DEFAULT_PROVIDERS[2]!.fallbackModels);
    });

    // findings.md P2:257 — personality tier used to pin Sonnet 4.0 with 4.6
    // as a fallback — a downgrade chain that capped quality. Lock the
    // current-Sonnet pin.
    it('pins the personality tier to current Sonnet (not the stale 4.0 alias)', async () => {
      const { DEFAULT_PROVIDERS } = await import('../src/config/defaults.js');
      const personality = DEFAULT_PROVIDERS[0]!;
      expect(personality.model).toBe('claude-sonnet-4-6');
      expect(personality.model).not.toBe('claude-sonnet-4-20250514');
    });

    it('lists fallbackModels as a downgrade chain for the personality tier', async () => {
      const { DEFAULT_PROVIDERS } = await import('../src/config/defaults.js');
      const personality = DEFAULT_PROVIDERS[0]!;
      const fallbacks = (personality.fallbackModels ?? []) as Array<string | { model: string }>;
      const names = fallbacks.map(f => typeof f === 'string' ? f : f.model);
      expect(names).not.toContain(personality.model);
      expect(names.some(m => /sonnet/.test(m))).toBe(true);
    });

    it('sample config no longer embeds agents[] (P2:171 removal)', () => {
      const sample = generateSampleConfig();
      // The JSON body must not contain these keys; the word "providers"
      // is allowed in the leading comment that points users at characters.json.
      expect(sample).not.toMatch(/"agents"\s*:/);
      expect(sample).not.toMatch(/"providers"\s*:/);
    });
  });

  describe('loadConfig', () => {
    it('should return defaults when no config file exists', async () => {
      // findings.md P2:171 — `agents` removed from LainConfig.
      const config = await loadConfig();

      expect(config.version).toBe('1');
      expect((config as Record<string, unknown>)['agents']).toBeUndefined();
    });

    it('should load and merge config from file', async () => {
      const customConfig = {
        version: '1',
        logging: {
          level: 'debug',
          prettyPrint: false,
        },
      };

      await writeFile(
        join(testDir, 'lain.json5'),
        JSON.stringify(customConfig)
      );

      const config = await loadConfig();

      expect(config.logging.level).toBe('debug');
      expect(config.logging.prettyPrint).toBe(false);
      // Defaults should still be present
      expect(config.gateway).toBeDefined();
    });

    it('should throw on invalid config', async () => {
      const invalidConfig = {
        version: '1',
        security: {
          requireAuth: 'not-a-boolean', // Invalid type
        },
      };

      await writeFile(
        join(testDir, 'lain.json5'),
        JSON.stringify(invalidConfig)
      );

      await expect(loadConfig()).rejects.toThrow();
    });
  });

  describe('validate', () => {
    it('should validate correct config', () => {
      const config = getDefaultConfig();
      expect(() => validate(config)).not.toThrow();
    });

    it('should reject config with missing required fields', () => {
      const invalid = { version: '1' };
      expect(() => validate(invalid)).toThrow();
    });

    it('should reject config with unknown top-level field', () => {
      // findings.md P2:171 — `agents` was removed; additionalProperties:false
      // rejects any now-unknown keys (including the deleted `agents` field).
      const config = getDefaultConfig() as Record<string, unknown>;
      config['agents'] = [{ id: 'foo', name: 'F', enabled: true, workspace: 'w', providers: [] }];

      expect(() => validate(config)).toThrow();
    });
  });
});

describe('Character manifest — field resolvers', () => {
  const originalEnv = process.env['CHARACTERS_CONFIG'];
  const fixtureDir = join(tmpdir(), 'lain-test-manifest');
  const fixturePath = join(fixtureDir, 'characters.json');

  beforeEach(async () => {
    _resetManifestCache();
    await mkdir(fixtureDir, { recursive: true });
    process.env['CHARACTERS_CONFIG'] = fixturePath;
  });

  afterEach(async () => {
    if (originalEnv) process.env['CHARACTERS_CONFIG'] = originalEnv;
    else delete process.env['CHARACTERS_CONFIG'];
    try { await rm(fixtureDir, { recursive: true }); } catch {}
    // Force re-load
    _resetManifestCache();
  });

  it('getSystemdUnit returns override when manifest sets it', async () => {
    await writeFile(fixturePath, JSON.stringify({
      town: { name: 'T', description: '' },
      characters: [
        { id: 'lain', name: 'Lain', port: 3001, server: 'character',
          defaultLocation: 'home', workspace: 'w', systemdUnit: 'lain-main' },
      ],
    }));
    expect(getSystemdUnit('lain')).toBe('lain-main');
  });

  it('getSystemdUnit falls back to `lain-${id}` when override missing', async () => {
    await writeFile(fixturePath, JSON.stringify({
      town: { name: 'T', description: '' },
      characters: [
        { id: 'pkd', name: 'PKD', port: 3003, server: 'character',
          defaultLocation: 'home', workspace: 'w' },
      ],
    }));
    expect(getSystemdUnit('pkd')).toBe('lain-pkd');
  });

  it('getHomeDir returns override when manifest sets it', async () => {
    await writeFile(fixturePath, JSON.stringify({
      town: { name: 'T', description: '' },
      characters: [
        { id: 'lain', name: 'Lain', port: 3001, server: 'character',
          defaultLocation: 'home', workspace: 'w', homeDir: '/root/.lain' },
      ],
    }));
    expect(getHomeDir('lain')).toBe('/root/.lain');
  });

  it('getHomeDir falls back to `/root/.lain-${id}` when override missing', async () => {
    await writeFile(fixturePath, JSON.stringify({
      town: { name: 'T', description: '' },
      characters: [
        { id: 'mckenna', name: 'McKenna', port: 3004, server: 'character',
          defaultLocation: 'home', workspace: 'w' },
      ],
    }));
    expect(getHomeDir('mckenna')).toBe('/root/.lain-mckenna');
  });

  it('resolvers fall back to convention when id is not in the manifest', async () => {
    await writeFile(fixturePath, JSON.stringify({
      town: { name: 'T', description: '' },
      characters: [],
    }));
    expect(getSystemdUnit('ghost')).toBe('lain-ghost');
    expect(getHomeDir('ghost')).toBe('/root/.lain-ghost');
  });

  it('getInhabitants excludes entries with role=oracle', async () => {
    await writeFile(fixturePath, JSON.stringify({
      town: { name: 'T', description: '' },
      characters: [
        { id: 'lain', name: 'Lain', port: 3001, server: 'character', defaultLocation: 'home', workspace: 'w' },
        { id: 'dr-claude', name: 'Dr. Claude', port: 3002, server: 'character', defaultLocation: 'clinic', workspace: 'w', role: 'oracle' },
        { id: 'pkd', name: 'PKD', port: 3003, server: 'character', defaultLocation: 'home', workspace: 'w', role: 'inhabitant' },
      ],
    }));
    const ids = getInhabitants().map(c => c.id);
    expect(ids).toEqual(['lain', 'pkd']);
  });

  it('getInhabitants treats missing role as inhabitant (default)', async () => {
    await writeFile(fixturePath, JSON.stringify({
      town: { name: 'T', description: '' },
      characters: [
        { id: 'lain', name: 'Lain', port: 3001, server: 'character', defaultLocation: 'home', workspace: 'w' },
      ],
    }));
    expect(getInhabitants().map(c => c.id)).toEqual(['lain']);
  });

  it('getOracles returns only entries with role=oracle', async () => {
    await writeFile(fixturePath, JSON.stringify({
      town: { name: 'T', description: '' },
      characters: [
        { id: 'lain', name: 'Lain', port: 3001, server: 'character', defaultLocation: 'home', workspace: 'w' },
        { id: 'dr-claude', name: 'Dr. Claude', port: 3002, server: 'character', defaultLocation: 'clinic', workspace: 'w', role: 'oracle' },
      ],
    }));
    expect(getOracles().map(c => c.id)).toEqual(['dr-claude']);
  });

  it('getOracles returns empty array when no oracles exist', async () => {
    await writeFile(fixturePath, JSON.stringify({
      town: { name: 'T', description: '' },
      characters: [
        { id: 'lain', name: 'Lain', port: 3001, server: 'character', defaultLocation: 'home', workspace: 'w' },
      ],
    }));
    expect(getOracles()).toEqual([]);
  });

  it('getHealthCheckTargets returns all characters (inhabitants AND oracles)', async () => {
    await writeFile(fixturePath, JSON.stringify({
      town: { name: 'T', description: '' },
      characters: [
        { id: 'lain', name: 'Lain', port: 3001, server: 'character', defaultLocation: 'home', workspace: 'w' },
        { id: 'dr-claude', name: 'Dr. Claude', port: 3002, server: 'character', defaultLocation: 'clinic', workspace: 'w', role: 'oracle' },
      ],
    }));
    expect(getHealthCheckTargets().map(c => c.id)).toEqual(['lain', 'dr-claude']);
  });

  it('getDossierSubjects excludes the writer id', async () => {
    await writeFile(fixturePath, JSON.stringify({
      town: { name: 'T', description: '' },
      characters: [
        { id: 'wired-lain', name: 'Wired Lain', port: 3000, server: 'web', defaultLocation: 'wired', workspace: 'w' },
        { id: 'lain', name: 'Lain', port: 3001, server: 'character', defaultLocation: 'home', workspace: 'w' },
        { id: 'dr-claude', name: 'Dr. Claude', port: 3002, server: 'character', defaultLocation: 'clinic', workspace: 'w', role: 'oracle' },
      ],
    }));
    expect(getDossierSubjects('wired-lain').map(c => c.id)).toEqual(['lain', 'dr-claude']);
  });

  it('getDreamSeedTargets returns all characters', async () => {
    await writeFile(fixturePath, JSON.stringify({
      town: { name: 'T', description: '' },
      characters: [
        { id: 'lain', name: 'Lain', port: 3001, server: 'character', defaultLocation: 'home', workspace: 'w' },
        { id: 'dr-claude', name: 'Dr. Claude', port: 3002, server: 'character', defaultLocation: 'clinic', workspace: 'w', role: 'oracle' },
      ],
    }));
    expect(getDreamSeedTargets().map(c => c.id)).toEqual(['lain', 'dr-claude']);
  });

  it('getCharacterDatabases returns id+homeDir for every character', async () => {
    await writeFile(fixturePath, JSON.stringify({
      town: { name: 'T', description: '' },
      characters: [
        { id: 'lain', name: 'Lain', port: 3001, server: 'character', defaultLocation: 'home', workspace: 'w', homeDir: '/root/.lain' },
        { id: 'pkd', name: 'PKD', port: 3003, server: 'character', defaultLocation: 'home', workspace: 'w' },
      ],
    }));
    expect(getCharacterDatabases()).toEqual([
      { id: 'lain', homeDir: '/root/.lain' },
      { id: 'pkd', homeDir: '/root/.lain-pkd' },
    ]);
  });
});

/**
 * findings.md P2:221 — when no manifest file is found, `loadManifest()` used
 * to return an empty town silently. We now warn once via the shared logger,
 * attaching the list of paths we searched so operators can diagnose the
 * problem from the logs without having to read the source.
 */
describe('Character manifest — missing file warning (findings.md P2:221)', () => {
  const isolatedCwd = join(tmpdir(), 'lain-test-missing-manifest');
  const originalEnv = process.env['CHARACTERS_CONFIG'];
  const originalCwd = process.cwd();
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await mkdir(isolatedCwd, { recursive: true });
    process.chdir(isolatedCwd);
    delete process.env['CHARACTERS_CONFIG'];
    _resetManifestCache();
    warnSpy = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalEnv) process.env['CHARACTERS_CONFIG'] = originalEnv;
    else delete process.env['CHARACTERS_CONFIG'];
    try { await rm(isolatedCwd, { recursive: true }); } catch {}
    _resetManifestCache();
    warnSpy.mockRestore();
  });

  it('warns once with the list of searched paths when manifest is absent', () => {
    const manifest = loadManifest();
    expect(manifest.characters).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    const [ctx, msg] = warnSpy.mock.calls[0] as [{ searched: string[] }, string];
    expect(msg).toMatch(/characters\.json not found/);
    expect(Array.isArray(ctx.searched)).toBe(true);
    // Use process.cwd() (not isolatedCwd) because macOS canonicalizes
    // `/var/folders/...` (tmpdir) to `/private/var/folders/...`.
    const cwd = process.cwd();
    expect(ctx.searched).toContain(join(cwd, 'characters.json'));
    expect(ctx.searched).toContain(join(cwd, 'characters.json5'));
  });

  it('warns exactly once across many loadManifest/getAllCharacters calls', () => {
    loadManifest();
    loadManifest();
    getAllCharacters();
    getAllCharacters();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('surfaces CHARACTERS_CONFIG in the searched paths when it is set', () => {
    const bogusPath = join(process.cwd(), 'nonexistent-manifest.json');
    process.env['CHARACTERS_CONFIG'] = bogusPath;
    loadManifest();
    const ctx = warnSpy.mock.calls[0]?.[0] as { searched: string[] };
    expect(ctx.searched[0]).toBe(bogusPath);
  });

  it('does not warn when a manifest file is found', async () => {
    const manifestPath = join(process.cwd(), 'characters.json');
    await writeFile(manifestPath, JSON.stringify({
      town: { name: 'T', description: '' },
      characters: [
        { id: 'lain', name: 'Lain', port: 3001, server: 'character',
          defaultLocation: 'home', workspace: 'w' },
      ],
    }));
    _resetManifestCache();
    const manifest = loadManifest();
    expect(manifest.characters).toHaveLength(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('_resetManifestCache rearms the warn-once guard so operators get a fresh signal per test/cycle', () => {
    loadManifest();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    _resetManifestCache();
    loadManifest();
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });
});

/**
 * findings.md P2:219 — `loadManifest` used to JSON.parse + type-assert the
 * manifest with no runtime check. A malformed file that happened to parse
 * (string port, missing `server`, typo'd role, unknown top-level field)
 * would silently corrupt peer URLs and inhabitant/oracle partitions.
 * Validation now refuses to return such a manifest.
 */
describe('Character manifest — schema validation (findings.md P2:219)', () => {
  const isolatedCwd = join(tmpdir(), 'lain-test-manifest-schema');
  const originalEnv = process.env['CHARACTERS_CONFIG'];
  const originalCwd = process.cwd();

  beforeEach(async () => {
    await mkdir(isolatedCwd, { recursive: true });
    process.chdir(isolatedCwd);
    delete process.env['CHARACTERS_CONFIG'];
    _resetManifestCache();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalEnv) process.env['CHARACTERS_CONFIG'] = originalEnv;
    else delete process.env['CHARACTERS_CONFIG'];
    try { await rm(isolatedCwd, { recursive: true }); } catch {}
    _resetManifestCache();
  });

  const writeManifest = async (payload: unknown) => {
    await writeFile(
      join(process.cwd(), 'characters.json'),
      JSON.stringify(payload),
    );
    _resetManifestCache();
  };

  it('accepts a well-formed manifest', async () => {
    await writeManifest({
      town: { name: 'T', description: '' },
      characters: [
        { id: 'lain', name: 'Lain', port: 3001, server: 'character',
          defaultLocation: 'home', workspace: 'w' },
      ],
    });
    const m = loadManifest();
    expect(m.characters[0]?.id).toBe('lain');
  });

  it('throws when `characters` field is missing', async () => {
    await writeManifest({ town: { name: 'T', description: '' } });
    expect(() => loadManifest()).toThrow(/Invalid character manifest/);
  });

  const expectValidationErrorMatching = (regex: RegExp) => {
    try {
      loadManifest();
      expect.fail('expected validation to throw');
    } catch (err) {
      const e = err as Error & { errors?: string[] };
      const lines = (e.errors ?? []).join('\n');
      expect(lines).toMatch(regex);
    }
  };

  it('throws when a character port is a string instead of integer', async () => {
    await writeManifest({
      town: { name: 'T', description: '' },
      characters: [
        { id: 'lain', name: 'Lain', port: '3001', server: 'character',
          defaultLocation: 'home', workspace: 'w' },
      ],
    });
    expectValidationErrorMatching(/port|integer/i);
  });

  it('throws when `role` has a typo like "inhabitnat" instead of silently dropping the character', async () => {
    await writeManifest({
      town: { name: 'T', description: '' },
      characters: [
        { id: 'lain', name: 'Lain', port: 3001, server: 'character',
          defaultLocation: 'home', workspace: 'w', role: 'inhabitnat' },
      ],
    });
    expectValidationErrorMatching(/role|enum/i);
  });

  it('throws when `server` is not "web" or "character"', async () => {
    await writeManifest({
      town: { name: 'T', description: '' },
      characters: [
        { id: 'lain', name: 'Lain', port: 3001, server: 'gateway',
          defaultLocation: 'home', workspace: 'w' },
      ],
    });
    expectValidationErrorMatching(/server|enum/i);
  });

  it('throws when a character has an unknown top-level property', async () => {
    await writeManifest({
      town: { name: 'T', description: '' },
      characters: [
        { id: 'lain', name: 'Lain', port: 3001, server: 'character',
          defaultLocation: 'home', workspace: 'w', typoField: true },
      ],
    });
    expectValidationErrorMatching(/typoField|additional/i);
  });

  it('throws when `id` contains uppercase / disallowed characters', async () => {
    await writeManifest({
      town: { name: 'T', description: '' },
      characters: [
        { id: 'Lain!', name: 'Lain', port: 3001, server: 'character',
          defaultLocation: 'home', workspace: 'w' },
      ],
    });
    expectValidationErrorMatching(/pattern|id/i);
  });

  it('throws when port is out of 1..65535 range', async () => {
    await writeManifest({
      town: { name: 'T', description: '' },
      characters: [
        { id: 'lain', name: 'Lain', port: 70000, server: 'character',
          defaultLocation: 'home', workspace: 'w' },
      ],
    });
    expectValidationErrorMatching(/port|maximum/i);
  });

  it('error lists every failing field at once (allErrors)', async () => {
    await writeManifest({
      town: { name: 'T', description: '' },
      characters: [
        // missing `server`, port is string, role is typo'd
        { id: 'lain', name: 'Lain', port: 'x',
          defaultLocation: 'home', workspace: 'w', role: 'bad' },
      ],
    });
    try {
      loadManifest();
      expect.fail('expected validation to throw');
    } catch (err) {
      const msg = (err as Error & { errors?: string[] }).errors ?? [];
      expect(msg.some((s) => /port/i.test(s))).toBe(true);
      expect(msg.some((s) => /role/i.test(s))).toBe(true);
      expect(msg.some((s) => /server/i.test(s))).toBe(true);
    }
  });

  it('error message mentions the manifest path for operator diagnosis', async () => {
    const p = join(process.cwd(), 'characters.json');
    await writeManifest({ town: { name: 'T', description: '' } /* no characters */ });
    try {
      loadManifest();
      expect.fail('expected throw');
    } catch (err) {
      expect((err as Error).message).toContain(p);
    }
  });

  it('accepts a character with an allowedTools allowlist', async () => {
    await writeManifest({
      town: { name: 'T', description: '' },
      characters: [
        { id: 'bob', name: 'Bob', port: 3002, server: 'character',
          defaultLocation: 'bar', workspace: 'w',
          allowedTools: ['get_current_time', 'remember'] },
      ],
    });
    const m = loadManifest();
    expect(m.characters[0]?.allowedTools).toEqual(['get_current_time', 'remember']);
  });
});
