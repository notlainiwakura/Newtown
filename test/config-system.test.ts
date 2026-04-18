/**
 * Config system tests
 * Comprehensive tests for the configuration system:
 *   - src/config/index.ts (loadConfig, getConfig, saveConfig, deepMerge)
 *   - src/config/defaults.ts (getDefaultConfig, generateSampleConfig)
 *   - src/config/schema.ts (validate, getSchema)
 *   - src/config/paths.ts (getBasePath, getPaths)
 *   - src/config/characters.ts (getAllCharacters, getCharacterEntry, etc.)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn().mockResolvedValue('test-master-key'),
    setPassword: vi.fn().mockResolvedValue(undefined),
    deletePassword: vi.fn().mockResolvedValue(true),
    findCredentials: vi.fn().mockResolvedValue([]),
  },
}));

// ============================================================================
// loadConfig / getConfig / resetConfig
// ============================================================================

describe('Config loader (index.ts)', () => {
  const testDir = join(tmpdir(), 'lain-test-config-system-' + Date.now());
  const originalEnv = process.env['LAIN_HOME'];

  beforeEach(async () => {
    process.env['LAIN_HOME'] = testDir;
    await mkdir(testDir, { recursive: true });
    // Reset cached config between tests
    const { resetConfig } = await import('../src/config/index.js');
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

  it('loadConfig returns defaults when no config file exists', async () => {
    const { loadConfig } = await import('../src/config/index.js');
    const config = await loadConfig();

    expect(config).toBeDefined();
    expect(config.version).toBe('1');
    expect(config.agents).toHaveLength(1);
    expect(config.gateway).toBeDefined();
    expect(config.security).toBeDefined();
    expect(config.logging).toBeDefined();
  });

  it('getConfig throws when not loaded', async () => {
    const { resetConfig, getConfig } = await import('../src/config/index.js');
    resetConfig();

    expect(() => getConfig()).toThrow(/not loaded/i);
  });

  it('getConfig returns config after loadConfig', async () => {
    const { loadConfig, getConfig } = await import('../src/config/index.js');
    await loadConfig();
    const config = getConfig();

    expect(config).toBeDefined();
    expect(config.version).toBe('1');
  });

  it('loadConfig merges file with defaults (deep merge)', async () => {
    const { loadConfig } = await import('../src/config/index.js');

    const customConfig = {
      version: '1',
      logging: {
        level: 'debug',
        prettyPrint: false,
      },
    };

    await writeFile(join(testDir, 'lain.json5'), JSON.stringify(customConfig));
    const config = await loadConfig();

    expect(config.logging.level).toBe('debug');
    expect(config.logging.prettyPrint).toBe(false);
    // Defaults for other sections should still exist
    expect(config.gateway).toBeDefined();
    expect(config.security).toBeDefined();
    expect(config.agents).toHaveLength(1);
  });

  it('loadConfig throws on invalid config in file', async () => {
    const { loadConfig } = await import('../src/config/index.js');

    const invalidConfig = {
      version: '1',
      security: {
        requireAuth: 'not-a-boolean',
      },
    };

    await writeFile(join(testDir, 'lain.json5'), JSON.stringify(invalidConfig));
    await expect(loadConfig()).rejects.toThrow();
  });

  it('saveConfig validates before saving', async () => {
    const { saveConfig, getDefaultConfig } = await import('../src/config/index.js');
    const config = getDefaultConfig();

    // Valid config should save without error
    await expect(saveConfig(config, join(testDir, 'saved.json5'))).resolves.not.toThrow();
  });

  it('saveConfig rejects invalid config', async () => {
    const { saveConfig } = await import('../src/config/index.js');

    const badConfig = { version: '1' } as any;
    await expect(saveConfig(badConfig, join(testDir, 'bad.json5'))).rejects.toThrow();
  });

  it('resetConfig clears cached config', async () => {
    const { loadConfig, getConfig, resetConfig } = await import('../src/config/index.js');
    await loadConfig();
    expect(() => getConfig()).not.toThrow();

    resetConfig();
    expect(() => getConfig()).toThrow();
  });

  it('isConfigLoaded returns correct state', async () => {
    const { loadConfig, resetConfig, isConfigLoaded } = await import('../src/config/index.js');
    resetConfig();
    expect(isConfigLoaded()).toBe(false);

    await loadConfig();
    expect(isConfigLoaded()).toBe(true);
  });
});

// ============================================================================
// getDefaultConfig / generateSampleConfig (defaults.ts)
// ============================================================================

describe('Default config (defaults.ts)', () => {
  const originalEnv = process.env['LAIN_HOME'];
  const testDir = join(tmpdir(), 'lain-test-defaults-' + Date.now());

  beforeEach(async () => {
    process.env['LAIN_HOME'] = testDir;
    await mkdir(testDir, { recursive: true });
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

  it('getDefaultConfig returns valid config', async () => {
    const { getDefaultConfig, validate } = await import('../src/config/index.js');
    const config = getDefaultConfig();

    expect(() => validate(config)).not.toThrow();
  });

  it('default config has version "1"', async () => {
    const { getDefaultConfig } = await import('../src/config/index.js');
    const config = getDefaultConfig();
    expect(config.version).toBe('1');
  });

  it('default provider count is 3 (personality, memory, light)', async () => {
    const { getDefaultConfig } = await import('../src/config/index.js');
    const config = getDefaultConfig();
    expect(config.agents[0]!.providers).toHaveLength(3);
  });

  it('default security requires auth', async () => {
    const { getDefaultConfig } = await import('../src/config/index.js');
    const config = getDefaultConfig();
    expect(config.security.requireAuth).toBe(true);
  });

  it('default max message length is 100000', async () => {
    const { getDefaultConfig } = await import('../src/config/index.js');
    const config = getDefaultConfig();
    expect(config.security.maxMessageLength).toBe(100000);
  });

  it('default token length is 32', async () => {
    const { getDefaultConfig } = await import('../src/config/index.js');
    const config = getDefaultConfig();
    expect(config.security.tokenLength).toBe(32);
  });

  it('default agent id is "default"', async () => {
    const { getDefaultConfig } = await import('../src/config/index.js');
    const config = getDefaultConfig();
    expect(config.agents[0]!.id).toBe('default');
  });

  it('default logging level is "info"', async () => {
    const { getDefaultConfig } = await import('../src/config/index.js');
    const config = getDefaultConfig();
    expect(config.logging.level).toBe('info');
  });

  it('default key derivation algorithm is argon2id', async () => {
    const { getDefaultConfig } = await import('../src/config/index.js');
    const config = getDefaultConfig();
    expect(config.security.keyDerivation.algorithm).toBe('argon2id');
  });

  it('generateSampleConfig returns non-empty string', async () => {
    const { generateSampleConfig } = await import('../src/config/index.js');
    const sample = generateSampleConfig();

    expect(sample).toBeDefined();
    expect(typeof sample).toBe('string');
    expect(sample.length).toBeGreaterThan(0);
  });

  it('generateSampleConfig contains JSON5 comments', async () => {
    const { generateSampleConfig } = await import('../src/config/index.js');
    const sample = generateSampleConfig();

    // JSON5 supports // comments
    expect(sample).toContain('//');
  });

  it('generateSampleConfig contains version field', async () => {
    const { generateSampleConfig } = await import('../src/config/index.js');
    const sample = generateSampleConfig();

    expect(sample).toContain('"version"');
  });
});

// ============================================================================
// Schema validation (schema.ts)
// ============================================================================

describe('Schema validation (schema.ts)', () => {
  const originalEnv = process.env['LAIN_HOME'];
  const testDir = join(tmpdir(), 'lain-test-schema-' + Date.now());

  beforeEach(async () => {
    process.env['LAIN_HOME'] = testDir;
    await mkdir(testDir, { recursive: true });
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

  it('validates correct config', async () => {
    const { getDefaultConfig, validate } = await import('../src/config/index.js');
    const config = getDefaultConfig();
    expect(() => validate(config)).not.toThrow();
    expect(validate(config)).toBe(true);
  });

  it('rejects invalid agent IDs with uppercase', async () => {
    const { getDefaultConfig, validate } = await import('../src/config/index.js');
    const config = getDefaultConfig();
    config.agents[0]!.id = 'InvalidUpperCase';
    expect(() => validate(config)).toThrow();
  });

  it('rejects invalid agent IDs with spaces', async () => {
    const { getDefaultConfig, validate } = await import('../src/config/index.js');
    const config = getDefaultConfig();
    config.agents[0]!.id = 'has space';
    expect(() => validate(config)).toThrow();
  });

  it('rejects invalid agent IDs with special characters', async () => {
    const { getDefaultConfig, validate } = await import('../src/config/index.js');
    const config = getDefaultConfig();
    config.agents[0]!.id = 'agent@name!';
    expect(() => validate(config)).toThrow();
  });

  it('accepts valid agent IDs with lowercase and hyphens', async () => {
    const { getDefaultConfig, validate } = await import('../src/config/index.js');
    const config = getDefaultConfig();
    config.agents[0]!.id = 'my-agent-01';
    expect(() => validate(config)).not.toThrow();
  });

  it('requires at least 1 provider', async () => {
    const { getDefaultConfig, validate } = await import('../src/config/index.js');
    const config = getDefaultConfig();
    config.agents[0]!.providers = [];
    expect(() => validate(config)).toThrow();
  });

  it('allows only anthropic/openai/google provider types', async () => {
    const { getDefaultConfig, validate } = await import('../src/config/index.js');
    const config = getDefaultConfig();
    (config.agents[0]!.providers[0] as any).type = 'invalid-provider';
    expect(() => validate(config)).toThrow();
  });

  it('allows anthropic provider type', async () => {
    const { getDefaultConfig, validate } = await import('../src/config/index.js');
    const config = getDefaultConfig();
    config.agents[0]!.providers[0]!.type = 'anthropic';
    expect(() => validate(config)).not.toThrow();
  });

  it('allows openai provider type', async () => {
    const { getDefaultConfig, validate } = await import('../src/config/index.js');
    const config = getDefaultConfig();
    config.agents[0]!.providers = [{
      type: 'openai',
      model: 'gpt-4',
    }];
    expect(() => validate(config)).not.toThrow();
  });

  it('allows google provider type', async () => {
    const { getDefaultConfig, validate } = await import('../src/config/index.js');
    const config = getDefaultConfig();
    config.agents[0]!.providers = [{
      type: 'google',
      model: 'gemini-pro',
    }];
    expect(() => validate(config)).not.toThrow();
  });

  it('enforces minimum token length of 16', async () => {
    const { getDefaultConfig, validate } = await import('../src/config/index.js');
    const config = getDefaultConfig();
    config.security.tokenLength = 8; // Below minimum
    expect(() => validate(config)).toThrow();
  });

  it('accepts token length >= 16', async () => {
    const { getDefaultConfig, validate } = await import('../src/config/index.js');
    const config = getDefaultConfig();
    config.security.tokenLength = 16;
    expect(() => validate(config)).not.toThrow();
  });

  it('rejects missing required top-level fields', async () => {
    const { validate } = await import('../src/config/index.js');
    const incomplete = { version: '1' };
    expect(() => validate(incomplete)).toThrow();
  });

  it('getSchema returns schema object', async () => {
    const { getSchema } = await import('../src/config/index.js');
    const schema = getSchema();

    expect(schema).toBeDefined();
    expect(schema.type).toBe('object');
    expect(schema.properties).toBeDefined();
    expect(schema.required).toContain('version');
    expect(schema.required).toContain('gateway');
    expect(schema.required).toContain('security');
    expect(schema.required).toContain('agents');
    expect(schema.required).toContain('logging');
  });
});

// ============================================================================
// Paths (paths.ts)
// ============================================================================

describe('Paths (paths.ts)', () => {
  const originalEnv = process.env['LAIN_HOME'];

  afterEach(() => {
    if (originalEnv) {
      process.env['LAIN_HOME'] = originalEnv;
    } else {
      delete process.env['LAIN_HOME'];
    }
  });

  it('getPaths returns all standard paths', async () => {
    process.env['LAIN_HOME'] = '/tmp/lain-paths-test';
    const { getPaths } = await import('../src/config/paths.js');
    const paths = getPaths();

    expect(paths.base).toBeDefined();
    expect(paths.config).toBeDefined();
    expect(paths.socket).toBeDefined();
    expect(paths.pidFile).toBeDefined();
    expect(paths.database).toBeDefined();
    expect(paths.workspace).toBeDefined();
    expect(paths.agents).toBeDefined();
    expect(paths.extensions).toBeDefined();
    expect(paths.credentials).toBeDefined();
  });

  it('getPaths uses correct file names', async () => {
    process.env['LAIN_HOME'] = '/tmp/lain-paths-test';
    const { getPaths } = await import('../src/config/paths.js');
    const paths = getPaths();

    expect(paths.config).toContain('lain.json5');
    expect(paths.socket).toContain('gateway.sock');
    expect(paths.pidFile).toContain('gateway.pid');
    expect(paths.database).toContain('lain.db');
  });

  it('getBasePath uses LAIN_HOME env var when set', async () => {
    const customPath = '/custom/lain/home';
    process.env['LAIN_HOME'] = customPath;
    const { getBasePath } = await import('../src/config/paths.js');

    expect(getBasePath()).toBe(customPath);
  });

  it('getBasePath falls back to ~/.lain when LAIN_HOME unset', async () => {
    delete process.env['LAIN_HOME'];
    const { getBasePath } = await import('../src/config/paths.js');

    expect(getBasePath()).toBe(join(homedir(), '.lain'));
  });

  it('getPaths paths are rooted under base path', async () => {
    process.env['LAIN_HOME'] = '/tmp/lain-root-test';
    const { getPaths } = await import('../src/config/paths.js');
    const paths = getPaths();

    expect(paths.config).toContain(paths.base);
    expect(paths.socket).toContain(paths.base);
    expect(paths.pidFile).toContain(paths.base);
    expect(paths.database).toContain(paths.base);
    expect(paths.workspace).toContain(paths.base);
    expect(paths.agents).toContain(paths.base);
    expect(paths.extensions).toContain(paths.base);
    expect(paths.credentials).toContain(paths.base);
  });
});

// ============================================================================
// Characters (characters.ts)
// ============================================================================

describe('Characters (characters.ts)', () => {
  it('getAllCharacters returns an array', async () => {
    const { getAllCharacters } = await import('../src/config/characters.js');
    const chars = getAllCharacters();
    expect(Array.isArray(chars)).toBe(true);
  });

  it('getDefaultLocations returns a record', async () => {
    const { getDefaultLocations } = await import('../src/config/characters.js');
    const locations = getDefaultLocations();
    expect(typeof locations).toBe('object');
    expect(locations).not.toBeNull();
  });

  it('loadManifest returns object with characters array', async () => {
    const { loadManifest } = await import('../src/config/characters.js');
    const manifest = loadManifest();
    expect(manifest).toBeDefined();
    expect(Array.isArray(manifest.characters)).toBe(true);
  });

  it('loadManifest returns object with town config', async () => {
    const { loadManifest } = await import('../src/config/characters.js');
    const manifest = loadManifest();
    expect(manifest.town).toBeDefined();
    expect(typeof manifest.town.name).toBe('string');
  });

  it('getCharacterEntry returns undefined for nonexistent character', async () => {
    const { getCharacterEntry } = await import('../src/config/characters.js');
    const entry = getCharacterEntry('nonexistent-character-id-xyz');
    expect(entry).toBeUndefined();
  });

  it('getImmortalIds returns a Set', async () => {
    const { getImmortalIds } = await import('../src/config/characters.js');
    const ids = getImmortalIds();
    expect(ids instanceof Set).toBe(true);
  });

  it('getMortalCharacters returns an array', async () => {
    const { getMortalCharacters } = await import('../src/config/characters.js');
    const mortals = getMortalCharacters();
    expect(Array.isArray(mortals)).toBe(true);
  });

  it('getPeersFor returns array excluding the given character', async () => {
    const { getPeersFor, getAllCharacters } = await import('../src/config/characters.js');
    const chars = getAllCharacters();
    if (chars.length > 0) {
      const peers = getPeersFor(chars[0]!.id);
      expect(Array.isArray(peers)).toBe(true);
      // Should not include the character itself
      const selfIncluded = peers.some(p => p.id === chars[0]!.id);
      expect(selfIncluded).toBe(false);
    }
  });

  it('each character entry has required fields', async () => {
    const { getAllCharacters } = await import('../src/config/characters.js');
    const chars = getAllCharacters();
    for (const c of chars) {
      expect(typeof c.id).toBe('string');
      expect(typeof c.name).toBe('string');
      expect(typeof c.port).toBe('number');
      expect(typeof c.defaultLocation).toBe('string');
    }
  });
});
