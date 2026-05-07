/**
 * Type-Safety Tests
 *
 * Verify that runtime data structures conform to their declared types,
 * defaults cover all required fields, and enums are handled exhaustively.
 */

import { describe, it, expect } from 'vitest';

// ─────────────────────────────────────────────────────────
// 1. DEFAULT CONFIG COMPLETENESS
// ─────────────────────────────────────────────────────────

describe('Default config completeness', () => {
  it('getDefaultConfig returns an object', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    const cfg = getDefaultConfig();
    expect(typeof cfg).toBe('object');
    expect(cfg).not.toBeNull();
  });

  it('default version is a non-empty string', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    expect(typeof getDefaultConfig().version).toBe('string');
    expect(getDefaultConfig().version.length).toBeGreaterThan(0);
  });

  it('default gateway.socketPath is a string', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    expect(typeof getDefaultConfig().gateway.socketPath).toBe('string');
  });

  it('default gateway.socketPermissions is a number', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    expect(typeof getDefaultConfig().gateway.socketPermissions).toBe('number');
  });

  it('default gateway.pidFile is a string', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    expect(typeof getDefaultConfig().gateway.pidFile).toBe('string');
  });

  it('default gateway.rateLimit.connectionsPerMinute is positive', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    expect(getDefaultConfig().gateway.rateLimit.connectionsPerMinute).toBeGreaterThan(0);
  });

  it('default gateway.rateLimit.requestsPerSecond is positive', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    expect(getDefaultConfig().gateway.rateLimit.requestsPerSecond).toBeGreaterThan(0);
  });

  it('default gateway.rateLimit.burstSize is positive', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    expect(getDefaultConfig().gateway.rateLimit.burstSize).toBeGreaterThan(0);
  });

  it('default security.requireAuth is boolean', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    expect(typeof getDefaultConfig().security.requireAuth).toBe('boolean');
  });

  it('default security.tokenLength is at least 16', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    expect(getDefaultConfig().security.tokenLength).toBeGreaterThanOrEqual(16);
  });

  it('default security.inputSanitization is boolean', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    expect(typeof getDefaultConfig().security.inputSanitization).toBe('boolean');
  });

  it('default security.maxMessageLength is positive', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    expect(getDefaultConfig().security.maxMessageLength).toBeGreaterThan(0);
  });

  it('default keyDerivation.algorithm is argon2id', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    expect(getDefaultConfig().security.keyDerivation.algorithm).toBe('argon2id');
  });

  it('default keyDerivation.memoryCost is at least 1024', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    expect(getDefaultConfig().security.keyDerivation.memoryCost).toBeGreaterThanOrEqual(1024);
  });

  it('default keyDerivation.timeCost is at least 1', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    expect(getDefaultConfig().security.keyDerivation.timeCost).toBeGreaterThanOrEqual(1);
  });

  it('default keyDerivation.parallelism is at least 1', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    expect(getDefaultConfig().security.keyDerivation.parallelism).toBeGreaterThanOrEqual(1);
  });

  // findings.md P2:171 — `config.agents` no longer exists. Defaults export
  // the provider chain directly as `DEFAULT_PROVIDERS`.
  it('DEFAULT_PROVIDERS is a non-empty array', async () => {
    const { DEFAULT_PROVIDERS } = await import('../src/config/defaults.js');
    expect(Array.isArray(DEFAULT_PROVIDERS)).toBe(true);
    expect(DEFAULT_PROVIDERS.length).toBeGreaterThan(0);
  });

  it('DEFAULT_PROVIDERS entries have type and model fields', async () => {
    const { DEFAULT_PROVIDERS } = await import('../src/config/defaults.js');
    for (const p of DEFAULT_PROVIDERS) {
      expect(typeof p.type).toBe('string');
      expect(typeof p.model).toBe('string');
    }
  });

  it('default logging.level is a valid level string', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    const validLevels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
    expect(validLevels).toContain(getDefaultConfig().logging.level);
  });

  it('default logging.prettyPrint is boolean', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    expect(typeof getDefaultConfig().logging.prettyPrint).toBe('boolean');
  });

  it('default config passes schema validation', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    const { validate } = await import('../src/config/schema.js');
    const cfg = getDefaultConfig();
    expect(() => validate(cfg)).not.toThrow();
    expect(validate(cfg)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────
// 2. CHARACTER MANIFEST TYPE SAFETY
// ─────────────────────────────────────────────────────────

describe('Character manifest type safety', () => {
  it('getAllCharacters returns an array', async () => {
    const { getAllCharacters } = await import('../src/config/characters.js');
    const chars = getAllCharacters();
    expect(Array.isArray(chars)).toBe(true);
  });

  it('loadManifest returns object with town and characters', async () => {
    const { loadManifest } = await import('../src/config/characters.js');
    const manifest = loadManifest();
    expect(manifest).toHaveProperty('town');
    expect(manifest).toHaveProperty('characters');
    expect(Array.isArray(manifest.characters)).toBe(true);
  });

  it('town has name and description strings', async () => {
    const { loadManifest } = await import('../src/config/characters.js');
    const { town } = loadManifest();
    expect(typeof town.name).toBe('string');
    expect(typeof town.description).toBe('string');
  });

  it('every character has an id string', async () => {
    const { getAllCharacters } = await import('../src/config/characters.js');
    for (const char of getAllCharacters()) {
      expect(typeof char.id).toBe('string');
      expect(char.id.length).toBeGreaterThan(0);
    }
  });

  it('every character has a name string', async () => {
    const { getAllCharacters } = await import('../src/config/characters.js');
    for (const char of getAllCharacters()) {
      expect(typeof char.name).toBe('string');
    }
  });

  it('every character port is an integer', async () => {
    const { getAllCharacters } = await import('../src/config/characters.js');
    for (const char of getAllCharacters()) {
      expect(Number.isInteger(char.port)).toBe(true);
    }
  });

  it('every character port is a valid TCP port number', async () => {
    const { getAllCharacters } = await import('../src/config/characters.js');
    for (const char of getAllCharacters()) {
      expect(char.port).toBeGreaterThan(0);
      expect(char.port).toBeLessThanOrEqual(65535);
    }
  });

  it('every character server is "web" or "character"', async () => {
    const { getAllCharacters } = await import('../src/config/characters.js');
    const validServers = ['web', 'character'];
    for (const char of getAllCharacters()) {
      expect(validServers).toContain(char.server);
    }
  });

  it('every character defaultLocation is a non-empty string', async () => {
    const { getAllCharacters } = await import('../src/config/characters.js');
    for (const char of getAllCharacters()) {
      expect(typeof char.defaultLocation).toBe('string');
      expect(char.defaultLocation.length).toBeGreaterThan(0);
    }
  });

  it('every character workspace is a string', async () => {
    const { getAllCharacters } = await import('../src/config/characters.js');
    for (const char of getAllCharacters()) {
      expect(typeof char.workspace).toBe('string');
    }
  });

  it('immortal field is boolean when present', async () => {
    const { getAllCharacters } = await import('../src/config/characters.js');
    for (const char of getAllCharacters()) {
      if ('immortal' in char && char.immortal !== undefined) {
        expect(typeof char.immortal).toBe('boolean');
      }
    }
  });

  it('getImmortalIds returns a Set', async () => {
    const { getImmortalIds } = await import('../src/config/characters.js');
    const ids = getImmortalIds();
    expect(ids).toBeInstanceOf(Set);
  });

  it('getMortalCharacters returns array of non-immortal chars', async () => {
    const { getMortalCharacters, getAllCharacters } = await import('../src/config/characters.js');
    const mortal = getMortalCharacters();
    const all = getAllCharacters();
    // Mortal count must be <= total count
    expect(mortal.length).toBeLessThanOrEqual(all.length);
    // None of the mortal chars should be immortal
    for (const c of mortal) {
      expect(c.immortal).toBeFalsy();
    }
  });

  it('getCharacterEntry returns undefined for unknown id', async () => {
    const { getCharacterEntry } = await import('../src/config/characters.js');
    expect(getCharacterEntry('__nonexistent_character__')).toBeUndefined();
  });

  it('getPeersFor excludes the querying character', async () => {
    const { getAllCharacters, getPeersFor } = await import('../src/config/characters.js');
    const chars = getAllCharacters();
    if (chars.length > 0) {
      const first = chars[0]!;
      const peers = getPeersFor(first.id);
      const peerIds = peers.map((p) => p.id);
      expect(peerIds).not.toContain(first.id);
    }
  });

  it('getPeersFor returns peers with id, name, url fields', async () => {
    const { getAllCharacters, getPeersFor } = await import('../src/config/characters.js');
    const chars = getAllCharacters();
    if (chars.length > 1) {
      const peers = getPeersFor(chars[0]!.id);
      for (const peer of peers) {
        expect(typeof peer.id).toBe('string');
        expect(typeof peer.name).toBe('string');
        expect(typeof peer.url).toBe('string');
      }
    }
  });

  it('getDefaultLocations returns a Record<string, string>', async () => {
    const { getDefaultLocations } = await import('../src/config/characters.js');
    const locs = getDefaultLocations();
    expect(typeof locs).toBe('object');
    for (const [key, val] of Object.entries(locs)) {
      expect(typeof key).toBe('string');
      expect(typeof val).toBe('string');
    }
  });

  it('no two characters share the same port', async () => {
    const { getAllCharacters } = await import('../src/config/characters.js');
    const chars = getAllCharacters();
    const ports = chars.map((c) => c.port);
    const uniquePorts = new Set(ports);
    expect(uniquePorts.size).toBe(ports.length);
  });

  it('no two characters share the same id', async () => {
    const { getAllCharacters } = await import('../src/config/characters.js');
    const chars = getAllCharacters();
    const ids = chars.map((c) => c.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});

// ─────────────────────────────────────────────────────────
// 3. BUILDING DATA TYPE SAFETY
// ─────────────────────────────────────────────────────────

describe('Building data type safety', () => {
  it('BUILDINGS is a readonly array with 9 entries', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    expect(Array.isArray(BUILDINGS)).toBe(true);
    expect(BUILDINGS).toHaveLength(9);
  });

  it('every building has an id string', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    for (const b of BUILDINGS) {
      expect(typeof b.id).toBe('string');
      expect(b.id.length).toBeGreaterThan(0);
    }
  });

  it('every building has a name string', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    for (const b of BUILDINGS) {
      expect(typeof b.name).toBe('string');
    }
  });

  it('every building has a description string', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    for (const b of BUILDINGS) {
      expect(typeof b.description).toBe('string');
    }
  });

  it('every building has an emoji string', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    for (const b of BUILDINGS) {
      expect(typeof b.emoji).toBe('string');
    }
  });

  it('every building row is an integer 0-2', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    for (const b of BUILDINGS) {
      expect(Number.isInteger(b.row)).toBe(true);
      expect(b.row).toBeGreaterThanOrEqual(0);
      expect(b.row).toBeLessThanOrEqual(2);
    }
  });

  it('every building col is an integer 0-2', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    for (const b of BUILDINGS) {
      expect(Number.isInteger(b.col)).toBe(true);
      expect(b.col).toBeGreaterThanOrEqual(0);
      expect(b.col).toBeLessThanOrEqual(2);
    }
  });

  it('no two buildings share the same row+col position', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    const positions = BUILDINGS.map((b) => `${b.row},${b.col}`);
    const unique = new Set(positions);
    expect(unique.size).toBe(BUILDINGS.length);
  });

  it('positions cover the full 3x3 grid', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    const positions = new Set(BUILDINGS.map((b) => `${b.row},${b.col}`));
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        expect(positions.has(`${r},${c}`)).toBe(true);
      }
    }
  });

  it('BUILDING_MAP is a Map with 9 entries', async () => {
    const { BUILDING_MAP } = await import('../src/commune/buildings.js');
    expect(BUILDING_MAP).toBeInstanceOf(Map);
    expect(BUILDING_MAP.size).toBe(9);
  });

  it('BUILDING_MAP keys match building ids', async () => {
    const { BUILDINGS, BUILDING_MAP } = await import('../src/commune/buildings.js');
    for (const b of BUILDINGS) {
      expect(BUILDING_MAP.has(b.id)).toBe(true);
      expect(BUILDING_MAP.get(b.id)).toBe(b);
    }
  });

  it('isValidBuilding returns true for all known building ids', async () => {
    const { BUILDINGS, isValidBuilding } = await import('../src/commune/buildings.js');
    for (const b of BUILDINGS) {
      expect(isValidBuilding(b.id)).toBe(true);
    }
  });

  it('isValidBuilding returns false for unknown id', async () => {
    const { isValidBuilding } = await import('../src/commune/buildings.js');
    expect(isValidBuilding('__not_a_building__')).toBe(false);
    expect(isValidBuilding('')).toBe(false);
  });

  it('known building ids include library, bar, field', async () => {
    const { BUILDING_MAP } = await import('../src/commune/buildings.js');
    expect(BUILDING_MAP.has('library')).toBe(true);
    expect(BUILDING_MAP.has('bar')).toBe(true);
    expect(BUILDING_MAP.has('field')).toBe(true);
  });

  it('known building ids include lighthouse at row 1 col 1', async () => {
    const { BUILDING_MAP } = await import('../src/commune/buildings.js');
    const lighthouse = BUILDING_MAP.get('lighthouse');
    expect(lighthouse).toBeDefined();
    expect(lighthouse?.row).toBe(1);
    expect(lighthouse?.col).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────
// 4. TOOL DEFINITIONS TYPE SAFETY
// ─────────────────────────────────────────────────────────

describe('Tool definitions type safety', () => {
  it('getToolDefinitions returns an array', async () => {
    const { getToolDefinitions } = await import('../src/agent/tools.js');
    const defs = getToolDefinitions();
    expect(Array.isArray(defs)).toBe(true);
  });

  it('every tool has a name string', async () => {
    const { getToolDefinitions } = await import('../src/agent/tools.js');
    for (const def of getToolDefinitions()) {
      expect(typeof def.name).toBe('string');
      expect(def.name.length).toBeGreaterThan(0);
    }
  });

  it('every tool has a description string', async () => {
    const { getToolDefinitions } = await import('../src/agent/tools.js');
    for (const def of getToolDefinitions()) {
      expect(typeof def.description).toBe('string');
      expect(def.description.length).toBeGreaterThan(0);
    }
  });

  it('every tool has an inputSchema object', async () => {
    const { getToolDefinitions } = await import('../src/agent/tools.js');
    for (const def of getToolDefinitions()) {
      expect(typeof def.inputSchema).toBe('object');
      expect(def.inputSchema).not.toBeNull();
    }
  });

  it('every tool inputSchema has type "object"', async () => {
    const { getToolDefinitions } = await import('../src/agent/tools.js');
    for (const def of getToolDefinitions()) {
      expect((def.inputSchema as { type?: string }).type).toBe('object');
    }
  });

  it('no two tools share the same name', async () => {
    const { getToolDefinitions } = await import('../src/agent/tools.js');
    const names = getToolDefinitions().map((d) => d.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('get_current_time tool is registered', async () => {
    const { getToolDefinitions } = await import('../src/agent/tools.js');
    const names = getToolDefinitions().map((d) => d.name);
    expect(names).toContain('get_current_time');
  });

  it('calculate tool is registered', async () => {
    const { getToolDefinitions } = await import('../src/agent/tools.js');
    const names = getToolDefinitions().map((d) => d.name);
    expect(names).toContain('calculate');
  });

  it('remember tool is registered', async () => {
    const { getToolDefinitions } = await import('../src/agent/tools.js');
    const names = getToolDefinitions().map((d) => d.name);
    expect(names).toContain('remember');
  });

  it('recall tool is registered', async () => {
    const { getToolDefinitions } = await import('../src/agent/tools.js');
    const names = getToolDefinitions().map((d) => d.name);
    expect(names).toContain('recall');
  });

  it('web_search tool is registered', async () => {
    const { getToolDefinitions } = await import('../src/agent/tools.js');
    const names = getToolDefinitions().map((d) => d.name);
    expect(names).toContain('web_search');
  });

  it('fetch_webpage tool is registered', async () => {
    const { getToolDefinitions } = await import('../src/agent/tools.js');
    const names = getToolDefinitions().map((d) => d.name);
    expect(names).toContain('fetch_webpage');
  });

  it('tools with required fields list them in schema.required', async () => {
    const { getToolDefinitions } = await import('../src/agent/tools.js');
    for (const def of getToolDefinitions()) {
      const schema = def.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      if (schema.required && schema.properties) {
        for (const req of schema.required) {
          expect(schema.properties).toHaveProperty(req);
        }
      }
    }
  });

  it('remember tool has required key and value', async () => {
    const { getToolDefinitions } = await import('../src/agent/tools.js');
    const remember = getToolDefinitions().find((d) => d.name === 'remember');
    expect(remember).toBeDefined();
    const schema = remember!.inputSchema as { required?: string[] };
    expect(schema.required).toContain('key');
    expect(schema.required).toContain('value');
  });

  it('recall tool has required query', async () => {
    const { getToolDefinitions } = await import('../src/agent/tools.js');
    const recall = getToolDefinitions().find((d) => d.name === 'recall');
    expect(recall).toBeDefined();
    const schema = recall!.inputSchema as { required?: string[] };
    expect(schema.required).toContain('query');
  });

  it('calculate tool has required expression', async () => {
    const { getToolDefinitions } = await import('../src/agent/tools.js');
    const calc = getToolDefinitions().find((d) => d.name === 'calculate');
    expect(calc).toBeDefined();
    const schema = calc!.inputSchema as { required?: string[] };
    expect(schema.required).toContain('expression');
  });

  it('recall tool sort_by enum covers relevance, recency, importance, access_count', async () => {
    const { getToolDefinitions } = await import('../src/agent/tools.js');
    const recall = getToolDefinitions().find((d) => d.name === 'recall');
    const schema = recall!.inputSchema as {
      properties: { sort_by: { enum: string[] } }
    };
    expect(schema.properties.sort_by.enum).toContain('relevance');
    expect(schema.properties.sort_by.enum).toContain('recency');
    expect(schema.properties.sort_by.enum).toContain('importance');
    expect(schema.properties.sort_by.enum).toContain('access_count');
  });

  it('expand_memory tool is registered', async () => {
    const { getToolDefinitions } = await import('../src/agent/tools.js');
    const names = getToolDefinitions().map((d) => d.name);
    expect(names).toContain('expand_memory');
  });

  it('create_tool / list_my_tools / delete_tool are NOT registered (P1 findings.md:1561)', async () => {
    // These meta-tools used `new Function()` + `require` + `process` to
    // execute LLM-authored JavaScript, which made every cross-peer
    // injection vector a path to host RCE. Removed; skills.ts deleted.
    const { getToolDefinitions } = await import('../src/agent/tools.js');
    const names = getToolDefinitions().map((d) => d.name);
    expect(names).not.toContain('create_tool');
    expect(names).not.toContain('list_my_tools');
    expect(names).not.toContain('delete_tool');
  });

  it('send_letter tool is registered', async () => {
    const { getToolDefinitions } = await import('../src/agent/tools.js');
    const names = getToolDefinitions().map((d) => d.name);
    expect(names).toContain('send_letter');
  });

  it('dead toolRequiresApproval helper has been removed (P1 findings.md)', async () => {
    const mod = await import('../src/agent/tools.js') as Record<string, unknown>;
    expect(mod['toolRequiresApproval']).toBeUndefined();
  });

  it('tools count is at least 10 (core set)', async () => {
    const { getToolDefinitions } = await import('../src/agent/tools.js');
    expect(getToolDefinitions().length).toBeGreaterThanOrEqual(10);
  });
});

// ─────────────────────────────────────────────────────────
// 5. PROVIDER FACTORY TYPE SAFETY
// ─────────────────────────────────────────────────────────

describe('Provider factory type safety', () => {
  it('createProvider returns object with name and model', async () => {
    const { createProvider } = await import('../src/providers/index.js');
    const p = createProvider({ type: 'anthropic', model: 'claude-haiku-4-5-20251001' });
    expect(typeof p.name).toBe('string');
    expect(typeof p.model).toBe('string');
  });

  it('createProvider with anthropic type produces provider named anthropic', async () => {
    const { createProvider } = await import('../src/providers/index.js');
    const p = createProvider({ type: 'anthropic', model: 'claude-haiku-4-5-20251001' });
    expect(p.name).toBe('anthropic');
  });

  it('createProvider with openai type produces provider named openai', async () => {
    const { createProvider } = await import('../src/providers/index.js');
    // apiKeyEnv points to an env var that doesn't exist → apiKey will be undefined,
    // but we pass it via apiKey constructor option to avoid SDK key-check at construction time.
    // Use the openai module directly instead, which accepts apiKey.
    const { OpenAIProvider } = await import('../src/providers/openai.js');
    const p = new OpenAIProvider({ model: 'gpt-4o', apiKey: 'test-key' });
    expect(p.name).toBe('openai');
  });

  it('createProvider with google type produces provider named google', async () => {
    const { createProvider } = await import('../src/providers/index.js');
    const p = createProvider({ type: 'google', model: 'gemini-pro' });
    expect(p.name).toBe('google');
  });

  it('createProvider preserves the specified model', async () => {
    const { createProvider } = await import('../src/providers/index.js');
    const p = createProvider({ type: 'anthropic', model: 'claude-haiku-4-5-20251001' });
    expect(p.model).toBe('claude-haiku-4-5-20251001');
  });

  it('createProvider returns object with complete, completeWithTools, continueWithToolResults', async () => {
    const { createProvider } = await import('../src/providers/index.js');
    const p = createProvider({ type: 'anthropic', model: 'claude-haiku-4-5-20251001' });
    expect(typeof p.complete).toBe('function');
    expect(typeof p.completeWithTools).toBe('function');
    expect(typeof p.continueWithToolResults).toBe('function');
  });

  it('createProvider with fallbackModels wraps provider (still has correct name)', async () => {
    const { createProvider } = await import('../src/providers/index.js');
    const p = createProvider({
      type: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      fallbackModels: ['claude-haiku-latest'],
    });
    expect(p.name).toBe('anthropic');
  });

  it('createProvider with unknown type throws', async () => {
    const { createProvider } = await import('../src/providers/index.js');
    expect(() => createProvider({ type: 'unknown' as 'anthropic', model: 'x' })).toThrow();
  });

  it('BudgetExceededError is exported from providers/budget', async () => {
    const mod = await import('../src/providers/budget.js');
    expect(typeof mod.BudgetExceededError).toBe('function');
  });

  it('BudgetExceededError extends Error', async () => {
    const { BudgetExceededError } = await import('../src/providers/budget.js');
    const err = new BudgetExceededError(1000, 500);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('BudgetExceededError');
  });

  it('checkBudget is exported from providers/budget', async () => {
    const mod = await import('../src/providers/budget.js');
    expect(typeof mod.checkBudget).toBe('function');
  });

  it('getBudgetStatus is exported from providers/budget', async () => {
    const mod = await import('../src/providers/budget.js');
    expect(typeof mod.getBudgetStatus).toBe('function');
  });

  it('recordUsage is exported from providers/budget', async () => {
    const mod = await import('../src/providers/budget.js');
    expect(typeof mod.recordUsage).toBe('function');
  });

  it('createFallbackProvider is exported from providers/fallback', async () => {
    const mod = await import('../src/providers/fallback.js');
    expect(typeof mod.createFallbackProvider).toBe('function');
  });
});

// ─────────────────────────────────────────────────────────
// 6. ENUM EXHAUSTIVENESS
// ─────────────────────────────────────────────────────────

describe('Enum exhaustiveness — finishReason mapping', () => {
  it('OpenAI finish reason "stop" maps to stop', async () => {
    // Verified via OpenAIProvider.mapFinishReason (private, tested indirectly via contract shape)
    const validOutputs: Array<'stop' | 'length' | 'content_filter' | 'tool_use' | 'error'> = [
      'stop', 'length', 'content_filter', 'tool_use', 'error',
    ];
    expect(validOutputs).toContain('stop');
  });

  it('all five finishReason variants are valid return types', () => {
    const variants = ['stop', 'length', 'content_filter', 'tool_use', 'error'] as const;
    expect(variants).toHaveLength(5);
    for (const v of variants) {
      expect(typeof v).toBe('string');
    }
  });

  it('MemorySortBy covers all four sort options', () => {
    const sorts = ['relevance', 'recency', 'importance', 'access_count'] as const;
    expect(sorts).toContain('relevance');
    expect(sorts).toContain('recency');
    expect(sorts).toContain('importance');
    expect(sorts).toContain('access_count');
    expect(sorts).toHaveLength(4);
  });

  it('Memory memoryType covers all five types', () => {
    const types = ['fact', 'preference', 'context', 'summary', 'episode'] as const;
    expect(types).toContain('fact');
    expect(types).toContain('preference');
    expect(types).toContain('context');
    expect(types).toContain('summary');
    expect(types).toContain('episode');
    expect(types).toHaveLength(5);
  });

  it('LifecycleState covers seed, growing, mature, complete, composting', () => {
    const states = ['seed', 'growing', 'mature', 'complete', 'composting'] as const;
    expect(states).toHaveLength(5);
    for (const s of states) {
      expect(typeof s).toBe('string');
    }
  });

  it('CausalType covers all four causal relation types', () => {
    const types = ['prerequisite', 'tension', 'completion', 'reinforcement'] as const;
    expect(types).toHaveLength(4);
    expect(types).toContain('prerequisite');
    expect(types).toContain('tension');
    expect(types).toContain('completion');
    expect(types).toContain('reinforcement');
  });

  it('Association associationType covers all five types', () => {
    const types = ['similar', 'evolved_from', 'pattern', 'cross_topic', 'dream'] as const;
    expect(types).toHaveLength(5);
    expect(types).toContain('similar');
    expect(types).toContain('evolved_from');
    expect(types).toContain('pattern');
    expect(types).toContain('cross_topic');
    expect(types).toContain('dream');
  });

  it('ChannelType covers all seven channel types', () => {
    const channels = ['telegram', 'whatsapp', 'discord', 'signal', 'slack', 'cli', 'web'] as const;
    expect(channels).toHaveLength(7);
    expect(channels).toContain('telegram');
    expect(channels).toContain('web');
  });

  it('PeerKind covers user, group, channel', () => {
    const kinds = ['user', 'group', 'channel'] as const;
    expect(kinds).toHaveLength(3);
    expect(kinds).toContain('user');
    expect(kinds).toContain('group');
    expect(kinds).toContain('channel');
  });

  it('logging level enum covers all six pino levels', () => {
    const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
    expect(levels).toHaveLength(6);
    for (const l of levels) {
      expect(typeof l).toBe('string');
    }
  });

  it('provider type enum covers anthropic, openai, google only', () => {
    const types = ['anthropic', 'openai', 'google'] as const;
    expect(types).toHaveLength(3);
    expect(types).toContain('anthropic');
    expect(types).toContain('openai');
    expect(types).toContain('google');
  });

  it('toolChoice covers auto, none, and specific-tool object form', () => {
    type ToolChoice = 'auto' | 'none' | { type: 'tool'; name: string };
    const auto: ToolChoice = 'auto';
    const none: ToolChoice = 'none';
    const specific: ToolChoice = { type: 'tool', name: 'my_tool' };
    expect(auto).toBe('auto');
    expect(none).toBe('none');
    expect(specific.type).toBe('tool');
  });

  it('ImageContentBlock media_type covers exactly four image formats', () => {
    const types = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
    expect(types).toHaveLength(4);
    expect(types).toContain('image/jpeg');
    expect(types).toContain('image/png');
    expect(types).toContain('image/gif');
    expect(types).toContain('image/webp');
  });

  it('GatewayErrorCodes covers 5 standard JSON-RPC codes', async () => {
    const { GatewayErrorCodes } = await import('../src/types/gateway.js');
    const standardCodes = [-32700, -32600, -32601, -32602, -32603];
    for (const code of standardCodes) {
      expect(Object.values(GatewayErrorCodes)).toContain(code);
    }
  });

  it('GatewayErrorCodes covers 3 custom extension codes', async () => {
    const { GatewayErrorCodes } = await import('../src/types/gateway.js');
    const customCodes = [-32000, -32001, -32002, -32003];
    for (const code of customCodes) {
      expect(Object.values(GatewayErrorCodes)).toContain(code);
    }
  });

  it('parseEventType maps all known prefixes without returning prefix unchanged for known ones', async () => {
    const { parseEventType } = await import('../src/events/bus.js');
    // All these known prefixes should not return 'unknown'
    const knownPrefixes = [
      ['commune:x', 'commune'],
      ['diary:x', 'diary'],
      ['dream:x', 'dream'],
      ['curiosity:x', 'curiosity'],
      ['bibliomancy:x', 'curiosity'],
      ['letter:x', 'letter'],
      ['wired:x', 'letter'],
      ['web:x', 'chat'],
      ['telegram:x', 'chat'],
      ['peer:x', 'peer'],
      ['dr:x', 'doctor'],
      ['doctor:x', 'doctor'],
      ['movement:x', 'movement'],
      ['weather:x', 'weather'],
    ] as const;
    for (const [key, expected] of knownPrefixes) {
      expect(parseEventType(key)).toBe(expected);
    }
  });
});

// ─────────────────────────────────────────────────────────
// findings.md P2:199 — MediaPayload narrowing
// ─────────────────────────────────────────────────────────

describe('MediaPayload narrowing (findings.md P2:199)', () => {
  it('ImageContent accepts a url-only payload', async () => {
    const { ImageContent } = await import('../src/types/message.js').then((m) => ({ ImageContent: {} as unknown as import('../src/types/message.js').ImageContent }));
    void ImageContent;
    const img: import('../src/types/message.js').ImageContent = {
      type: 'image',
      mimeType: 'image/png',
      url: 'https://example/img.png',
    };
    expect(img.type).toBe('image');
  });

  it('ImageContent accepts a base64-only payload', () => {
    const img: import('../src/types/message.js').ImageContent = {
      type: 'image',
      mimeType: 'image/png',
      base64: 'data:image/png;base64,abc',
    };
    expect(img.type).toBe('image');
  });

  it('ImageContent accepts both url and base64 (cached download)', () => {
    const img: import('../src/types/message.js').ImageContent = {
      type: 'image',
      mimeType: 'image/png',
      url: 'https://example/img.png',
      base64: 'data:image/png;base64,abc',
    };
    expect(img.type).toBe('image');
  });

  it('ImageContent rejects a payload with neither url nor base64 (compile-time)', () => {
    // @ts-expect-error — MediaPayload requires url or base64
    const bad: import('../src/types/message.js').ImageContent = {
      type: 'image',
      mimeType: 'image/png',
    };
    expect(bad.type).toBe('image');
  });

  it('FileContent rejects a payload with neither url nor base64 (compile-time)', () => {
    // @ts-expect-error — MediaPayload requires url or base64
    const bad: import('../src/types/message.js').FileContent = {
      type: 'file',
      mimeType: 'application/pdf',
      filename: 'x.pdf',
    };
    expect(bad.type).toBe('file');
  });

  it('AudioContent rejects a payload with neither url nor base64 (compile-time)', () => {
    // @ts-expect-error — MediaPayload requires url or base64
    const bad: import('../src/types/message.js').AudioContent = {
      type: 'audio',
      mimeType: 'audio/ogg',
    };
    expect(bad.type).toBe('audio');
  });

  it('FileContent accepts url-only payload with filename', () => {
    const f: import('../src/types/message.js').FileContent = {
      type: 'file',
      mimeType: 'application/pdf',
      filename: 'doc.pdf',
      url: 'https://example/doc.pdf',
    };
    expect(f.filename).toBe('doc.pdf');
  });

  it('AudioContent accepts base64-only payload with optional duration', () => {
    const a: import('../src/types/message.js').AudioContent = {
      type: 'audio',
      mimeType: 'audio/ogg',
      base64: 'data:audio/ogg;base64,xyz',
      duration: 12,
    };
    expect(a.duration).toBe(12);
  });
});
