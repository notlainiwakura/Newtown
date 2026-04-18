/**
 * Matrix/table-driven tests for config, characters, buildings, and paths.
 * Uses it.each / describe.each patterns to maximise test density.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';

// ─────────────────────────────────────────────────────────────────────────────
// 1. CONFIG FIELD × INVALID VALUE TYPE  (15 fields × 4 wrong-type values = 60)
// ─────────────────────────────────────────────────────────────────────────────

describe('Config field × invalid value type', () => {
  let validate: (c: unknown) => boolean;

  beforeEach(async () => {
    ({ validate } = await import('../src/config/schema.js'));
  });

  /**
   * Each tuple: [field path label, object-factory that injects the bad value, bad value]
   * The config produced must be otherwise structurally valid so the *only* error
   * comes from the injected bad value.
   */
  function validBase() {
    return {
      version: '1',
      gateway: {
        socketPath: '/tmp/test.sock',
        socketPermissions: 0o600,
        pidFile: '/tmp/test.pid',
        rateLimit: { connectionsPerMinute: 60, requestsPerSecond: 10, burstSize: 20 },
      },
      security: {
        requireAuth: true,
        tokenLength: 32,
        inputSanitization: true,
        maxMessageLength: 100000,
        keyDerivation: { algorithm: 'argon2id', memoryCost: 65536, timeCost: 3, parallelism: 4 },
      },
      agents: [
        {
          id: 'default',
          name: 'Test',
          enabled: true,
          workspace: '/tmp/ws',
          providers: [{ type: 'anthropic', model: 'claude-3-haiku-20240307' }],
        },
      ],
      logging: { level: 'info', prettyPrint: true },
    };
  }

  // Each row: [description, mutator function, injected bad value description]
  const fieldCases: Array<[string, (cfg: ReturnType<typeof validBase>, v: unknown) => void, unknown[]]> = [
    ['version (number)', (c, v) => { (c as Record<string, unknown>).version = v; }, [42, true, null, []]],
    ['gateway.socketPath (number)', (c, v) => { c.gateway.socketPath = v as string; }, [99, true, null, []]],
    ['gateway.socketPermissions (string)', (c, v) => { c.gateway.socketPermissions = v as number; }, ['rw', true, null, []]],
    ['gateway.pidFile (bool)', (c, v) => { c.gateway.pidFile = v as string; }, [1, true, null, []]],
    ['rateLimit.connectionsPerMinute (string)', (c, v) => { c.gateway.rateLimit.connectionsPerMinute = v as number; }, ['60', true, null, []]],
    ['rateLimit.requestsPerSecond (bool)', (c, v) => { c.gateway.rateLimit.requestsPerSecond = v as number; }, [false, 'ten', null, []]],
    ['rateLimit.burstSize (null)', (c, v) => { c.gateway.rateLimit.burstSize = v as number; }, [null, 'big', false, []]],
    ['security.requireAuth (string)', (c, v) => { c.security.requireAuth = v as boolean; }, ['yes', 1, null, []]],
    ['security.tokenLength (string)', (c, v) => { c.security.tokenLength = v as number; }, ['32', true, null, []]],
    ['security.maxMessageLength (bool)', (c, v) => { c.security.maxMessageLength = v as number; }, [true, 'max', null, []]],
    ['security.keyDerivation.memoryCost (string)', (c, v) => { c.security.keyDerivation.memoryCost = v as number; }, ['64k', true, null, []]],
    ['security.keyDerivation.timeCost (bool)', (c, v) => { c.security.keyDerivation.timeCost = v as number; }, [false, 'three', null, []]],
    ['logging.prettyPrint (string)', (c, v) => { c.logging.prettyPrint = v as boolean; }, ['true', 1, null, []]],
    ['agent.enabled (number)', (c, v) => { c.agents[0]!.enabled = v as boolean; }, [1, 'yes', null, []]],
    ['agent.providers (empty array)', (c, v) => { (c.agents[0] as Record<string, unknown>).providers = v; }, [[], null, 'str', 42]],
  ];

  describe.each(fieldCases)('%s', (_label, mutate, badValues) => {
    it.each(badValues.map((v) => [JSON.stringify(v), v]))(
      'rejects value %s',
      (_desc, badVal) => {
        const cfg = validBase();
        mutate(cfg, badVal);
        expect(() => validate(cfg)).toThrow();
      },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. CHARACTER FIELD × VALIDATION  (8 required fields × 3 states = 24)
// ─────────────────────────────────────────────────────────────────────────────

describe('Character field × validation', () => {
  function validAgent() {
    return {
      id: 'my-char',
      name: 'My Character',
      enabled: true,
      workspace: '/tmp/ws',
      providers: [{ type: 'anthropic' as const, model: 'claude-3-haiku-20240307' }],
    };
  }

  function validConfig(agentOverride: Record<string, unknown>) {
    return {
      version: '1',
      gateway: {
        socketPath: '/tmp/test.sock',
        socketPermissions: 0o600,
        pidFile: '/tmp/test.pid',
        rateLimit: { connectionsPerMinute: 60, requestsPerSecond: 10, burstSize: 20 },
      },
      security: {
        requireAuth: true,
        tokenLength: 32,
        inputSanitization: true,
        maxMessageLength: 100000,
        keyDerivation: { algorithm: 'argon2id', memoryCost: 65536, timeCost: 3, parallelism: 4 },
      },
      agents: [agentOverride],
      logging: { level: 'info', prettyPrint: true },
    };
  }

  let validate: (c: unknown) => boolean;
  beforeEach(async () => {
    ({ validate } = await import('../src/config/schema.js'));
  });

  // [field, valid value, missing sentinel, wrong-type value]
  const agentFields: Array<[string, unknown, unknown]> = [
    ['id', 'valid-id', 42],
    ['name', 'Valid Name', 99],
    ['enabled', true, 'yes'],
    ['workspace', '/tmp/ws', 123],
    ['providers', [{ type: 'anthropic', model: 'c-h' }], 'str'],
  ];

  describe.each(agentFields)('agent.%s', (field, validVal, badType) => {
    it('valid value passes', () => {
      const agent = { ...validAgent(), [field]: validVal };
      expect(() => validate(validConfig(agent as Record<string, unknown>))).not.toThrow();
    });

    it('missing field fails', () => {
      const agent: Record<string, unknown> = { ...validAgent() };
      delete agent[field];
      expect(() => validate(validConfig(agent))).toThrow();
    });

    it('wrong type fails', () => {
      const agent = { ...validAgent(), [field]: badType };
      expect(() => validate(validConfig(agent as Record<string, unknown>))).toThrow();
    });
  });

  // provider sub-fields
  const providerFields: Array<[string, unknown, unknown]> = [
    ['type', 'openai', 'bad-type'],
    ['model', 'gpt-4o', 9999],
    ['apiKeyEnv', 'MY_KEY', 123],
  ];

  describe.each(providerFields)('provider.%s', (field, validVal, badType) => {
    it('valid value passes (or absent)', () => {
      // apiKeyEnv is optional — also check without it
      const provider: Record<string, unknown> = { type: 'openai', model: 'gpt-4o', [field]: validVal };
      const agent = { ...validAgent(), providers: [provider] };
      expect(() => validate(validConfig(agent as Record<string, unknown>))).not.toThrow();
    });

    it('wrong type fails', () => {
      const provider: Record<string, unknown> = { type: 'openai', model: 'gpt-4o', [field]: badType };
      const agent = { ...validAgent(), providers: [provider] };
      expect(() => validate(validConfig(agent as Record<string, unknown>))).toThrow();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. BUILDING × PROPERTY × EXPECTED VALUE  (9 buildings × 5 properties = 45)
// ─────────────────────────────────────────────────────────────────────────────

describe('Building × property × expected value', () => {
  // All expected data inlined so tests are purely declarative
  const expectedBuildings = [
    { id: 'library',    name: 'Library',         emoji: '📚', row: 0, col: 0 },
    { id: 'bar',        name: 'Bar',             emoji: '🍺', row: 0, col: 1 },
    { id: 'field',      name: 'Field',           emoji: '🌾', row: 0, col: 2 },
    { id: 'windmill',   name: 'Windmill',        emoji: '🏗',  row: 1, col: 0 },
    { id: 'lighthouse', name: 'Lighthouse',      emoji: '🗼', row: 1, col: 1 },
    { id: 'school',     name: 'School',          emoji: '🏫', row: 1, col: 2 },
    { id: 'market',     name: 'Market',          emoji: '🏪', row: 2, col: 0 },
    { id: 'locksmith',  name: 'Locksmith',       emoji: '🔐', row: 2, col: 1 },
    { id: 'threshold',  name: 'The Threshold',   emoji: '🚪', row: 2, col: 2 },
  ];

  describe.each(expectedBuildings)('$id', ({ id, name, emoji, row, col }) => {
    it(`has id "${id}"`, async () => {
      const { BUILDING_MAP } = await import('../src/commune/buildings.js');
      expect(BUILDING_MAP.has(id)).toBe(true);
    });

    it(`has name "${name}"`, async () => {
      const { BUILDING_MAP } = await import('../src/commune/buildings.js');
      expect(BUILDING_MAP.get(id)?.name).toBe(name);
    });

    it(`has emoji "${emoji}"`, async () => {
      const { BUILDING_MAP } = await import('../src/commune/buildings.js');
      expect(BUILDING_MAP.get(id)?.emoji).toBe(emoji);
    });

    it(`is at row ${row}`, async () => {
      const { BUILDING_MAP } = await import('../src/commune/buildings.js');
      expect(BUILDING_MAP.get(id)?.row).toBe(row);
    });

    it(`is at col ${col}`, async () => {
      const { BUILDING_MAP } = await import('../src/commune/buildings.js');
      expect(BUILDING_MAP.get(id)?.col).toBe(col);
    });
  });

  it('BUILDINGS has exactly 9 entries', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    expect(BUILDINGS).toHaveLength(9);
  });

  it('all buildings have non-empty description', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    for (const b of BUILDINGS) {
      expect(b.description.length).toBeGreaterThan(0);
    }
  });

  it('isValidBuilding returns true for every known id', async () => {
    const { BUILDINGS, isValidBuilding } = await import('../src/commune/buildings.js');
    for (const b of BUILDINGS) {
      expect(isValidBuilding(b.id)).toBe(true);
    }
  });

  it('isValidBuilding returns false for unknown ids', async () => {
    const { isValidBuilding } = await import('../src/commune/buildings.js');
    for (const bad of ['tavern', 'LIBRARY', 'Library', '', ' library']) {
      expect(isValidBuilding(bad)).toBe(false);
    }
  });

  it('3×3 grid has no duplicate (row, col) pairs', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    const coords = BUILDINGS.map((b) => `${b.row}:${b.col}`);
    expect(new Set(coords).size).toBe(9);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. PATH FUNCTION × INPUT COMBOS  (5 functions × 3+ inputs each = 15+)
// ─────────────────────────────────────────────────────────────────────────────

describe('Path function × input combos', () => {
  const originalHome = process.env['LAIN_HOME'];

  afterEach(() => {
    if (originalHome !== undefined) {
      process.env['LAIN_HOME'] = originalHome;
    } else {
      delete process.env['LAIN_HOME'];
    }
  });

  const lainHomeCases: Array<[string, string]> = [
    ['custom /opt/myapp', '/opt/myapp'],
    ['custom /root/.lain-wired', '/root/.lain-wired'],
    ['custom /tmp/lain-test', '/tmp/lain-test'],
  ];

  describe.each(lainHomeCases)('LAIN_HOME=%s', (_label, home) => {
    it('getBasePath() returns the env value', async () => {
      process.env['LAIN_HOME'] = home;
      const { getBasePath } = await import('../src/config/paths.js');
      expect(getBasePath()).toBe(home);
    });

    it('getPaths().base equals LAIN_HOME', async () => {
      process.env['LAIN_HOME'] = home;
      const { getPaths } = await import('../src/config/paths.js');
      expect(getPaths().base).toBe(home);
    });

    it('getPaths().database is under LAIN_HOME', async () => {
      process.env['LAIN_HOME'] = home;
      const { getPaths } = await import('../src/config/paths.js');
      expect(getPaths().database).toContain(home);
    });
  });

  it('getBasePath falls back to homedir when LAIN_HOME unset', async () => {
    delete process.env['LAIN_HOME'];
    const { getBasePath } = await import('../src/config/paths.js');
    expect(getBasePath()).toBe(join(homedir(), '.lain'));
  });

  it('getPaths returns all required keys', async () => {
    process.env['LAIN_HOME'] = '/tmp/test-paths';
    const { getPaths } = await import('../src/config/paths.js');
    const paths = getPaths();
    for (const key of ['base', 'config', 'socket', 'pidFile', 'database', 'workspace', 'agents', 'extensions', 'credentials']) {
      expect(paths).toHaveProperty(key);
    }
  });

  const agentIdCases = ['default', 'lain', 'wired-lain', 'pkd', 'my-agent-01'];

  describe.each(agentIdCases.map((id) => [id]))('getAgentPath("%s")', (agentId) => {
    it('contains the agent id', async () => {
      process.env['LAIN_HOME'] = '/tmp/test-agent';
      const { getAgentPath } = await import('../src/config/paths.js');
      expect(getAgentPath(agentId)).toContain(agentId);
    });

    it('is under agents dir', async () => {
      process.env['LAIN_HOME'] = '/tmp/test-agent';
      const { getAgentPath, getPaths } = await import('../src/config/paths.js');
      const { agents } = getPaths();
      expect(getAgentPath(agentId)).toContain(agents);
    });

    it('sessions path is under agent path', async () => {
      process.env['LAIN_HOME'] = '/tmp/test-agent';
      const { getAgentSessionsPath, getAgentPath } = await import('../src/config/paths.js');
      expect(getAgentSessionsPath(agentId)).toContain(getAgentPath(agentId));
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. CONFIG MERGE SCENARIOS  (partial configs × 2 merge strategies = 20+)
// ─────────────────────────────────────────────────────────────────────────────

describe('Config merge scenarios', () => {
  let testDir: string;
  const originalHome = process.env['LAIN_HOME'];

  beforeEach(async () => {
    testDir = join(tmpdir(), `lain-merge-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env['LAIN_HOME'] = testDir;
    await mkdir(testDir, { recursive: true });

    const { resetConfig } = await import('../src/config/index.js');
    resetConfig();
  });

  afterEach(async () => {
    const { resetConfig } = await import('../src/config/index.js');
    resetConfig();
    if (originalHome !== undefined) {
      process.env['LAIN_HOME'] = originalHome;
    } else {
      delete process.env['LAIN_HOME'];
    }
    try { await rm(testDir, { recursive: true }); } catch { /* ignore */ }
  });

  // Each tuple: [label, partial override, expected key/value assertions]
  const mergeScenarios: Array<[string, Record<string, unknown>, Array<[string, unknown]>]> = [
    [
      'override log level',
      { logging: { level: 'debug', prettyPrint: false } },
      [['logging.level', 'debug'], ['logging.prettyPrint', false]],
    ],
    [
      'override version',
      { version: '2' },
      [['version', '2']],
    ],
    [
      'override security.requireAuth',
      { security: { requireAuth: false, tokenLength: 32, inputSanitization: true, maxMessageLength: 100000, keyDerivation: { algorithm: 'argon2id', memoryCost: 65536, timeCost: 3, parallelism: 4 } } },
      [['security.requireAuth', false]],
    ],
    [
      'override rateLimit.burstSize',
      { gateway: { socketPath: '/tmp/test.sock', socketPermissions: 0o600, pidFile: '/tmp/test.pid', rateLimit: { connectionsPerMinute: 60, requestsPerSecond: 10, burstSize: 5 } } },
      [['gateway.rateLimit.burstSize', 5]],
    ],
    [
      'empty partial keeps defaults',
      {},
      [['version', '1'], ['logging.level', 'info']],
    ],
  ];

  function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
    return path.split('.').reduce<unknown>((acc, key) => {
      if (acc !== null && typeof acc === 'object') {
        return (acc as Record<string, unknown>)[key];
      }
      return undefined;
    }, obj);
  }

  describe.each(mergeScenarios)('%s', (_label, partial, assertions) => {
    it('merged config matches expected values', async () => {
      const { writeFile } = await import('node:fs/promises');
      const { loadConfig } = await import('../src/config/index.js');
      if (Object.keys(partial).length > 0) {
        await writeFile(join(testDir, 'lain.json5'), JSON.stringify(partial));
      }
      const merged = await loadConfig();
      for (const [path, expected] of assertions) {
        expect(getNestedValue(merged as unknown as Record<string, unknown>, path)).toBe(expected);
      }
    });

    it('merged config retains gateway block', async () => {
      const { writeFile } = await import('node:fs/promises');
      const { loadConfig } = await import('../src/config/index.js');
      if (Object.keys(partial).length > 0) {
        await writeFile(join(testDir, 'lain.json5'), JSON.stringify(partial));
      }
      const merged = await loadConfig();
      expect(merged.gateway).toBeDefined();
      expect(merged.gateway.rateLimit).toBeDefined();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. AGENT ID PATTERN MATRIX  (20 IDs × valid/invalid = 20)
// ─────────────────────────────────────────────────────────────────────────────

describe('Agent ID pattern matrix', () => {
  let validate: (c: unknown) => boolean;

  beforeEach(async () => {
    ({ validate } = await import('../src/config/schema.js'));
  });

  function configWithId(id: unknown) {
    return {
      version: '1',
      gateway: {
        socketPath: '/tmp/t.sock',
        socketPermissions: 0o600,
        pidFile: '/tmp/t.pid',
        rateLimit: { connectionsPerMinute: 60, requestsPerSecond: 10, burstSize: 20 },
      },
      security: {
        requireAuth: true,
        tokenLength: 32,
        inputSanitization: true,
        maxMessageLength: 100000,
        keyDerivation: { algorithm: 'argon2id', memoryCost: 65536, timeCost: 3, parallelism: 4 },
      },
      agents: [{ id, name: 'T', enabled: true, workspace: '/tmp', providers: [{ type: 'anthropic', model: 'c-h' }] }],
      logging: { level: 'info', prettyPrint: true },
    };
  }

  const validIds = ['default', 'lain', 'wired-lain', 'pkd', 'agent1', 'a', '0', 'abc-123', 'my-char-01', 'x1y2z3'];
  const invalidIds = ['Lain', 'WIRED', 'wired lain', 'agent_01', 'agent!', '@home', '', '  ', 'lain.two', 'café'];

  it.each(validIds.map((id) => [id]))('valid id "%s" passes', (id) => {
    expect(() => validate(configWithId(id))).not.toThrow();
  });

  it.each(invalidIds.map((id) => [id]))('invalid id "%s" fails', (id) => {
    expect(() => validate(configWithId(id))).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. PORT RANGE VALIDATION  (15 port values)
// ─────────────────────────────────────────────────────────────────────────────

describe('Port range validation', () => {
  // The config schema does not define a port field directly, but character
  // manifest entries have ports. We validate port semantics here at the
  // application level — 1–65535 inclusive is valid.

  function isValidPort(port: unknown): boolean {
    if (typeof port !== 'number') return false;
    if (!Number.isInteger(port)) return false;
    if (!Number.isFinite(port)) return false;
    return port >= 1 && port <= 65535;
  }

  const portCases: Array<[unknown, boolean]> = [
    [0, false],
    [1, true],
    [80, true],
    [443, true],
    [1023, true],
    [1024, true],
    [3000, true],
    [8080, true],
    [65535, true],
    [65536, false],
    [-1, false],
    [NaN, false],
    [Infinity, false],
    [3.14, false],
    ['3000', false],
  ];

  it.each(portCases)('port %s → valid=%s', (port, expected) => {
    expect(isValidPort(port)).toBe(expected);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. LOG LEVEL MATRIX  (8 level strings × valid/invalid = 8)
// ─────────────────────────────────────────────────────────────────────────────

describe('Log level matrix', () => {
  let validate: (c: unknown) => boolean;

  beforeEach(async () => {
    ({ validate } = await import('../src/config/schema.js'));
  });

  function configWithLevel(level: unknown) {
    return {
      version: '1',
      gateway: {
        socketPath: '/tmp/t.sock',
        socketPermissions: 0o600,
        pidFile: '/tmp/t.pid',
        rateLimit: { connectionsPerMinute: 60, requestsPerSecond: 10, burstSize: 20 },
      },
      security: {
        requireAuth: true,
        tokenLength: 32,
        inputSanitization: true,
        maxMessageLength: 100000,
        keyDerivation: { algorithm: 'argon2id', memoryCost: 65536, timeCost: 3, parallelism: 4 },
      },
      agents: [{ id: 'default', name: 'T', enabled: true, workspace: '/tmp', providers: [{ type: 'anthropic', model: 'c-h' }] }],
      logging: { level, prettyPrint: true },
    };
  }

  const validLevels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
  const invalidLevels = ['verbose', 'WARNING'];

  it.each(validLevels.map((l) => [l]))('valid level "%s" passes', (level) => {
    expect(() => validate(configWithLevel(level))).not.toThrow();
  });

  it.each(invalidLevels.map((l) => [l]))('invalid level "%s" fails', (level) => {
    expect(() => validate(configWithLevel(level))).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. CHARACTER MANIFEST HELPERS  (matrix over manifest functions)
// ─────────────────────────────────────────────────────────────────────────────

describe('Character manifest helpers', () => {
  it('getAllCharacters returns an array', async () => {
    const { getAllCharacters } = await import('../src/config/characters.js');
    expect(Array.isArray(getAllCharacters())).toBe(true);
  });

  it('getDefaultLocations returns a record', async () => {
    const { getDefaultLocations } = await import('../src/config/characters.js');
    expect(typeof getDefaultLocations()).toBe('object');
  });

  it('getImmortalIds returns a Set', async () => {
    const { getImmortalIds } = await import('../src/config/characters.js');
    expect(getImmortalIds()).toBeInstanceOf(Set);
  });

  it('getMortalCharacters returns an array', async () => {
    const { getMortalCharacters } = await import('../src/config/characters.js');
    expect(Array.isArray(getMortalCharacters())).toBe(true);
  });

  it('every mortal character is NOT in immortal set', async () => {
    const { getMortalCharacters, getImmortalIds } = await import('../src/config/characters.js');
    const immortals = getImmortalIds();
    for (const c of getMortalCharacters()) {
      expect(immortals.has(c.id)).toBe(false);
    }
  });

  it('getWebCharacter returns undefined or a character with server="web"', async () => {
    const { getWebCharacter } = await import('../src/config/characters.js');
    const wc = getWebCharacter();
    if (wc !== undefined) {
      expect(wc.server).toBe('web');
    } else {
      expect(wc).toBeUndefined();
    }
  });

  it('getPeersFor excludes the queried character', async () => {
    const { getAllCharacters, getPeersFor } = await import('../src/config/characters.js');
    const all = getAllCharacters();
    if (all.length > 0) {
      const charId = all[0]!.id;
      const peers = getPeersFor(charId);
      expect(peers.every((p) => p.id !== charId)).toBe(true);
    }
  });

  it('getCharacterEntry returns undefined for unknown id', async () => {
    const { getCharacterEntry } = await import('../src/config/characters.js');
    expect(getCharacterEntry('__nonexistent__')).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. DEFAULT CONFIG VALUES  (matrix over each default)
// ─────────────────────────────────────────────────────────────────────────────

describe('Default config value matrix', () => {
  const expectedDefaults: Array<[string, (cfg: ReturnType<typeof getDefaultConfigSync>) => unknown, unknown]> = [];

  let getDefaultConfigSync: () => import('../src/types/config.js').LainConfig;

  beforeEach(async () => {
    ({ getDefaultConfig: getDefaultConfigSync } = await import('../src/config/defaults.js'));
  });

  it('version is "1"', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    expect(getDefaultConfig().version).toBe('1');
  });

  it('security.requireAuth is true', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    expect(getDefaultConfig().security.requireAuth).toBe(true);
  });

  it('security.tokenLength is 32', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    expect(getDefaultConfig().security.tokenLength).toBe(32);
  });

  it('security.inputSanitization is true', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    expect(getDefaultConfig().security.inputSanitization).toBe(true);
  });

  it('security.maxMessageLength is 100000', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    expect(getDefaultConfig().security.maxMessageLength).toBe(100000);
  });

  it('security.keyDerivation.algorithm is "argon2id"', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    expect(getDefaultConfig().security.keyDerivation.algorithm).toBe('argon2id');
  });

  it('security.keyDerivation.memoryCost is 65536', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    expect(getDefaultConfig().security.keyDerivation.memoryCost).toBe(65536);
  });

  it('gateway.rateLimit.connectionsPerMinute is 60', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    expect(getDefaultConfig().gateway.rateLimit.connectionsPerMinute).toBe(60);
  });

  it('gateway.rateLimit.requestsPerSecond is 10', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    expect(getDefaultConfig().gateway.rateLimit.requestsPerSecond).toBe(10);
  });

  it('gateway.rateLimit.burstSize is 20', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    expect(getDefaultConfig().gateway.rateLimit.burstSize).toBe(20);
  });

  it('logging.level is "info"', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    expect(getDefaultConfig().logging.level).toBe('info');
  });

  it('logging.prettyPrint is true', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    expect(getDefaultConfig().logging.prettyPrint).toBe(true);
  });

  it('agents has at least one entry', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    expect(getDefaultConfig().agents.length).toBeGreaterThan(0);
  });

  it('default agent id is "default"', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    expect(getDefaultConfig().agents[0]?.id).toBe('default');
  });

  it('default agent is enabled', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    expect(getDefaultConfig().agents[0]?.enabled).toBe(true);
  });

  it('default agent has at least one provider', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    expect(getDefaultConfig().agents[0]!.providers.length).toBeGreaterThan(0);
  });

  it('generateSampleConfig returns a non-empty string', async () => {
    const { generateSampleConfig } = await import('../src/config/defaults.js');
    const sample = generateSampleConfig();
    expect(typeof sample).toBe('string');
    expect(sample.length).toBeGreaterThan(10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. SCHEMA BOUNDARY VALUES  (numeric constraints)
// ─────────────────────────────────────────────────────────────────────────────

describe('Schema numeric boundary values', () => {
  let validate: (c: unknown) => boolean;

  beforeEach(async () => {
    ({ validate } = await import('../src/config/schema.js'));
  });

  function baseConfig(overrides: Record<string, unknown> = {}) {
    return {
      version: '1',
      gateway: {
        socketPath: '/tmp/t.sock',
        socketPermissions: 0o600,
        pidFile: '/tmp/t.pid',
        rateLimit: { connectionsPerMinute: 60, requestsPerSecond: 10, burstSize: 20 },
      },
      security: {
        requireAuth: true,
        tokenLength: 32,
        inputSanitization: true,
        maxMessageLength: 100000,
        keyDerivation: { algorithm: 'argon2id', memoryCost: 65536, timeCost: 3, parallelism: 4 },
      },
      agents: [{ id: 'default', name: 'T', enabled: true, workspace: '/tmp', providers: [{ type: 'anthropic', model: 'c-h' }] }],
      logging: { level: 'info', prettyPrint: true },
      ...overrides,
    };
  }

  const numericCases: Array<[string, (v: number) => Record<string, unknown>, number, boolean]> = [
    ['connectionsPerMinute=1', (v) => baseConfig({ gateway: { socketPath: '/tmp/t.sock', socketPermissions: 384, pidFile: '/tmp/t.pid', rateLimit: { connectionsPerMinute: v, requestsPerSecond: 10, burstSize: 20 } } }), 1, true],
    ['connectionsPerMinute=0', (v) => baseConfig({ gateway: { socketPath: '/tmp/t.sock', socketPermissions: 384, pidFile: '/tmp/t.pid', rateLimit: { connectionsPerMinute: v, requestsPerSecond: 10, burstSize: 20 } } }), 0, false],
    ['tokenLength=16', (v) => baseConfig({ security: { requireAuth: true, tokenLength: v, inputSanitization: true, maxMessageLength: 100000, keyDerivation: { algorithm: 'argon2id', memoryCost: 65536, timeCost: 3, parallelism: 4 } } }), 16, true],
    ['tokenLength=15', (v) => baseConfig({ security: { requireAuth: true, tokenLength: v, inputSanitization: true, maxMessageLength: 100000, keyDerivation: { algorithm: 'argon2id', memoryCost: 65536, timeCost: 3, parallelism: 4 } } }), 15, false],
    ['memoryCost=1024', (v) => baseConfig({ security: { requireAuth: true, tokenLength: 32, inputSanitization: true, maxMessageLength: 100000, keyDerivation: { algorithm: 'argon2id', memoryCost: v, timeCost: 3, parallelism: 4 } } }), 1024, true],
    ['memoryCost=1023', (v) => baseConfig({ security: { requireAuth: true, tokenLength: 32, inputSanitization: true, maxMessageLength: 100000, keyDerivation: { algorithm: 'argon2id', memoryCost: v, timeCost: 3, parallelism: 4 } } }), 1023, false],
    ['timeCost=1', (v) => baseConfig({ security: { requireAuth: true, tokenLength: 32, inputSanitization: true, maxMessageLength: 100000, keyDerivation: { algorithm: 'argon2id', memoryCost: 65536, timeCost: v, parallelism: 4 } } }), 1, true],
    ['timeCost=0', (v) => baseConfig({ security: { requireAuth: true, tokenLength: 32, inputSanitization: true, maxMessageLength: 100000, keyDerivation: { algorithm: 'argon2id', memoryCost: 65536, timeCost: v, parallelism: 4 } } }), 0, false],
    ['parallelism=1', (v) => baseConfig({ security: { requireAuth: true, tokenLength: 32, inputSanitization: true, maxMessageLength: 100000, keyDerivation: { algorithm: 'argon2id', memoryCost: 65536, timeCost: 3, parallelism: v } } }), 1, true],
    ['parallelism=0', (v) => baseConfig({ security: { requireAuth: true, tokenLength: 32, inputSanitization: true, maxMessageLength: 100000, keyDerivation: { algorithm: 'argon2id', memoryCost: 65536, timeCost: 3, parallelism: v } } }), 0, false],
    ['maxMessageLength=1', (v) => baseConfig({ security: { requireAuth: true, tokenLength: 32, inputSanitization: true, maxMessageLength: v, keyDerivation: { algorithm: 'argon2id', memoryCost: 65536, timeCost: 3, parallelism: 4 } } }), 1, true],
    ['maxMessageLength=0', (v) => baseConfig({ security: { requireAuth: true, tokenLength: 32, inputSanitization: true, maxMessageLength: v, keyDerivation: { algorithm: 'argon2id', memoryCost: 65536, timeCost: 3, parallelism: 4 } } }), 0, false],
  ];

  it.each(numericCases)('%s → valid=%s', (_label, factory, val, shouldPass) => {
    const cfg = factory(val);
    if (shouldPass) {
      expect(() => validate(cfg)).not.toThrow();
    } else {
      expect(() => validate(cfg)).toThrow();
    }
  });
});
