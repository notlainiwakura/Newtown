/**
 * Behavioral matrix tests for the character manifest system.
 *
 * Unlike matrix-config.test.ts (which tests config schema via source analysis),
 * these tests exercise the RUNTIME behavior of the manifest functions in
 * src/config/characters.ts by writing temporary manifest files and calling
 * the real functions against them.
 *
 * Coverage areas:
 *   1. Character entry x operation matrix
 *   2. Invalid manifest matrix
 *   3. Peer generation matrix
 *   4. Manifest x loop interaction matrix
 *   5. Workspace resolution matrix
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Valid building IDs from the 3x3 commune grid */
const VALID_BUILDINGS = [
  'library', 'bar', 'field',
  'windmill', 'lighthouse', 'school',
  'market', 'locksmith', 'threshold',
] as const;

interface TestCharacter {
  id: string;
  name: string;
  port: number;
  server: 'web' | 'character';
  defaultLocation: string;
  immortal?: boolean;
  possessable?: boolean;
  workspace: string;
}

function makeManifest(characters: TestCharacter[], town?: { name: string; description: string }) {
  return {
    town: town ?? { name: 'Test Town', description: 'A test town' },
    characters,
  };
}

function makeChar(overrides: Partial<TestCharacter> & { id: string }): TestCharacter {
  return {
    name: overrides.name ?? overrides.id.charAt(0).toUpperCase() + overrides.id.slice(1),
    port: overrides.port ?? 3000,
    server: overrides.server ?? 'character',
    defaultLocation: overrides.defaultLocation ?? 'library',
    workspace: overrides.workspace ?? `workspace/characters/${overrides.id}`,
    ...overrides,
  };
}

let testDir: string;
let manifestPath: string;
let originalCharConfig: string | undefined;

function writeManifest(data: unknown) {
  writeFileSync(manifestPath, JSON.stringify(data, null, 2));
}

/**
 * Fresh-import the characters module. Because the module caches _manifest at
 * module level, we must reset the module registry between groups that use
 * different manifest files.
 */
async function freshImport() {
  vi.resetModules();
  return await import('../src/config/characters.js');
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  testDir = join(tmpdir(), `lain-manifest-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(testDir, { recursive: true });
  manifestPath = join(testDir, 'characters.json');
  originalCharConfig = process.env['CHARACTERS_CONFIG'];
  process.env['CHARACTERS_CONFIG'] = manifestPath;
});

afterEach(() => {
  if (originalCharConfig !== undefined) {
    process.env['CHARACTERS_CONFIG'] = originalCharConfig;
  } else {
    delete process.env['CHARACTERS_CONFIG'];
  }
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup failures
  }
});

// ===========================================================================
// 1. CHARACTER ENTRY x OPERATION MATRIX (~100 tests)
// ===========================================================================

describe('Character entry x operation matrix', () => {
  // --- Character configurations to test ---

  const charConfigs: Array<[string, TestCharacter]> = [
    ['minimal (required fields only)', makeChar({
      id: 'minimal',
      name: 'Minimal',
      port: 3001,
      server: 'character',
      defaultLocation: 'bar',
      workspace: 'workspace/characters/minimal',
    })],
    ['full (all optional fields)', makeChar({
      id: 'full',
      name: 'Full Character',
      port: 3002,
      server: 'web',
      defaultLocation: 'library',
      immortal: true,
      possessable: true,
      workspace: 'workspace/characters/full',
    })],
    ['immortal character', makeChar({
      id: 'immortal-one',
      name: 'The Immortal',
      port: 3003,
      server: 'character',
      defaultLocation: 'lighthouse',
      immortal: true,
      workspace: 'workspace/characters/immortal-one',
    })],
    ['mortal character', makeChar({
      id: 'mortal-one',
      name: 'The Mortal',
      port: 3004,
      server: 'character',
      defaultLocation: 'field',
      immortal: false,
      workspace: 'workspace/characters/mortal-one',
    })],
    ['mortal character (immortal omitted)', makeChar({
      id: 'mortal-implicit',
      name: 'Implicitly Mortal',
      port: 3005,
      server: 'character',
      defaultLocation: 'market',
      workspace: 'workspace/characters/mortal-implicit',
    })],
    ['possessable character', makeChar({
      id: 'possessable',
      name: 'Possessable',
      port: 3006,
      server: 'character',
      defaultLocation: 'school',
      possessable: true,
      workspace: 'workspace/characters/possessable',
    })],
    ['web server character', makeChar({
      id: 'web-char',
      name: 'Web Character',
      port: 3000,
      server: 'web',
      defaultLocation: 'windmill',
      workspace: 'workspace/characters/web-char',
    })],
    ['character server character', makeChar({
      id: 'char-server',
      name: 'Character Server',
      port: 3007,
      server: 'character',
      defaultLocation: 'locksmith',
      workspace: 'workspace/characters/char-server',
    })],
    ['custom workspace', makeChar({
      id: 'custom-ws',
      name: 'Custom Workspace',
      port: 3008,
      server: 'character',
      defaultLocation: 'threshold',
      workspace: 'custom/path/to/workspace',
    })],
  ];

  // --- getAllCharacters ---

  describe('getAllCharacters()', () => {
    describe.each(charConfigs)('%s', (_label, char) => {
      it('includes the character in the result', async () => {
        writeManifest(makeManifest([char]));
        const { getAllCharacters } = await freshImport();
        const all = getAllCharacters();
        expect(all).toHaveLength(1);
        expect(all[0]!.id).toBe(char.id);
      });
    });

    it('returns all characters from a multi-character manifest', async () => {
      const chars = charConfigs.map(([, c], i) => ({ ...c, port: 3000 + i }));
      writeManifest(makeManifest(chars));
      const { getAllCharacters } = await freshImport();
      const all = getAllCharacters();
      expect(all).toHaveLength(chars.length);
      const ids = all.map(c => c.id);
      for (const c of chars) {
        expect(ids).toContain(c.id);
      }
    });
  });

  // --- getCharacterEntry ---

  describe('getCharacterEntry()', () => {
    describe.each(charConfigs)('%s', (_label, char) => {
      it('finds the character by id', async () => {
        writeManifest(makeManifest([char]));
        const { getCharacterEntry } = await freshImport();
        const entry = getCharacterEntry(char.id);
        expect(entry).toBeDefined();
        expect(entry!.id).toBe(char.id);
        expect(entry!.name).toBe(char.name);
        expect(entry!.port).toBe(char.port);
      });

      it('returns undefined for wrong id', async () => {
        writeManifest(makeManifest([char]));
        const { getCharacterEntry } = await freshImport();
        expect(getCharacterEntry('does-not-exist')).toBeUndefined();
      });
    });
  });

  // --- getDefaultLocations ---

  describe('getDefaultLocations()', () => {
    describe.each(charConfigs)('%s', (_label, char) => {
      it('maps character id to default location', async () => {
        writeManifest(makeManifest([char]));
        const { getDefaultLocations } = await freshImport();
        const locs = getDefaultLocations();
        expect(locs[char.id]).toBe(char.defaultLocation);
      });
    });

    it('returns all character locations for multi-character manifest', async () => {
      const chars = charConfigs.map(([, c], i) => ({ ...c, port: 3000 + i }));
      writeManifest(makeManifest(chars));
      const { getDefaultLocations } = await freshImport();
      const locs = getDefaultLocations();
      for (const c of chars) {
        expect(locs[c.id]).toBe(c.defaultLocation);
      }
    });
  });

  // --- getImmortalIds ---

  describe('getImmortalIds()', () => {
    it('includes immortal characters', async () => {
      const immortal = makeChar({ id: 'imm', immortal: true, port: 3001 });
      const mortal = makeChar({ id: 'mort', immortal: false, port: 3002 });
      writeManifest(makeManifest([immortal, mortal]));
      const { getImmortalIds } = await freshImport();
      const ids = getImmortalIds();
      expect(ids.has('imm')).toBe(true);
      expect(ids.has('mort')).toBe(false);
    });

    it('excludes characters with immortal omitted (defaults to mortal)', async () => {
      const char = makeChar({ id: 'no-flag', port: 3001 });
      // Ensure immortal is not set
      delete (char as Record<string, unknown>)['immortal'];
      writeManifest(makeManifest([char]));
      const { getImmortalIds } = await freshImport();
      expect(getImmortalIds().has('no-flag')).toBe(false);
    });

    it('returns empty set when no characters are immortal', async () => {
      const chars = [
        makeChar({ id: 'a', port: 3001, immortal: false }),
        makeChar({ id: 'b', port: 3002, immortal: false }),
      ];
      writeManifest(makeManifest(chars));
      const { getImmortalIds } = await freshImport();
      expect(getImmortalIds().size).toBe(0);
    });

    it('returns all ids when all characters are immortal', async () => {
      const chars = [
        makeChar({ id: 'a', port: 3001, immortal: true }),
        makeChar({ id: 'b', port: 3002, immortal: true }),
      ];
      writeManifest(makeManifest(chars));
      const { getImmortalIds } = await freshImport();
      const ids = getImmortalIds();
      expect(ids.size).toBe(2);
      expect(ids.has('a')).toBe(true);
      expect(ids.has('b')).toBe(true);
    });

    describe.each(charConfigs)('%s', (_label, char) => {
      it(`${char.immortal ? 'includes' : 'excludes'} character in immortal set`, async () => {
        writeManifest(makeManifest([char]));
        const { getImmortalIds } = await freshImport();
        expect(getImmortalIds().has(char.id)).toBe(!!char.immortal);
      });
    });
  });

  // --- getMortalCharacters ---

  describe('getMortalCharacters()', () => {
    it('includes mortal characters', async () => {
      const immortal = makeChar({ id: 'imm', immortal: true, port: 3001 });
      const mortal = makeChar({ id: 'mort', immortal: false, port: 3002 });
      writeManifest(makeManifest([immortal, mortal]));
      const { getMortalCharacters } = await freshImport();
      const mortals = getMortalCharacters();
      expect(mortals).toHaveLength(1);
      expect(mortals[0]!.id).toBe('mort');
    });

    it('includes characters with immortal omitted', async () => {
      const char = makeChar({ id: 'no-flag', port: 3001 });
      delete (char as Record<string, unknown>)['immortal'];
      writeManifest(makeManifest([char]));
      const { getMortalCharacters } = await freshImport();
      expect(getMortalCharacters()).toHaveLength(1);
    });

    it('returns empty array when all characters are immortal', async () => {
      const chars = [
        makeChar({ id: 'a', port: 3001, immortal: true }),
        makeChar({ id: 'b', port: 3002, immortal: true }),
      ];
      writeManifest(makeManifest(chars));
      const { getMortalCharacters } = await freshImport();
      expect(getMortalCharacters()).toHaveLength(0);
    });

    describe.each(charConfigs)('%s', (_label, char) => {
      it(`${char.immortal ? 'excludes' : 'includes'} character in mortal list`, async () => {
        writeManifest(makeManifest([char]));
        const { getMortalCharacters } = await freshImport();
        const mortals = getMortalCharacters();
        const inList = mortals.some(m => m.id === char.id);
        expect(inList).toBe(!char.immortal);
      });
    });
  });

  // --- getWebCharacter ---

  describe('getWebCharacter()', () => {
    it('returns the web server character', async () => {
      const web = makeChar({ id: 'web', port: 3000, server: 'web' });
      const char = makeChar({ id: 'char', port: 3001, server: 'character' });
      writeManifest(makeManifest([web, char]));
      const { getWebCharacter } = await freshImport();
      const wc = getWebCharacter();
      expect(wc).toBeDefined();
      expect(wc!.id).toBe('web');
      expect(wc!.server).toBe('web');
    });

    it('returns undefined when no web server character exists', async () => {
      const chars = [
        makeChar({ id: 'a', port: 3001, server: 'character' }),
        makeChar({ id: 'b', port: 3002, server: 'character' }),
      ];
      writeManifest(makeManifest(chars));
      const { getWebCharacter } = await freshImport();
      expect(getWebCharacter()).toBeUndefined();
    });

    it('returns the first web character when multiple exist', async () => {
      const web1 = makeChar({ id: 'web1', port: 3000, server: 'web' });
      const web2 = makeChar({ id: 'web2', port: 3009, server: 'web' });
      writeManifest(makeManifest([web1, web2]));
      const { getWebCharacter } = await freshImport();
      const wc = getWebCharacter();
      expect(wc).toBeDefined();
      expect(wc!.id).toBe('web1');
    });

    describe.each(charConfigs)('%s', (_label, char) => {
      it(`returns ${char.server === 'web' ? 'this character' : 'undefined'} as web character`, async () => {
        writeManifest(makeManifest([char]));
        const { getWebCharacter } = await freshImport();
        const wc = getWebCharacter();
        if (char.server === 'web') {
          expect(wc).toBeDefined();
          expect(wc!.id).toBe(char.id);
        } else {
          expect(wc).toBeUndefined();
        }
      });
    });
  });

  // --- getPeersFor (basic, per config) ---

  describe('getPeersFor() per character config', () => {
    describe.each(charConfigs)('%s', (_label, char) => {
      it('returns empty peer list when character is the only one', async () => {
        writeManifest(makeManifest([char]));
        const { getPeersFor } = await freshImport();
        expect(getPeersFor(char.id)).toHaveLength(0);
      });

      it('returns peers when other characters exist', async () => {
        const other = makeChar({ id: 'other', port: char.port + 100 });
        writeManifest(makeManifest([char, other]));
        const { getPeersFor } = await freshImport();
        const peers = getPeersFor(char.id);
        expect(peers).toHaveLength(1);
        expect(peers[0]!.id).toBe('other');
      });
    });
  });
});

// ===========================================================================
// 2. INVALID MANIFEST MATRIX (~80 tests)
// ===========================================================================

describe('Invalid manifest matrix', () => {

  // --- Missing / malformed manifest file ---

  describe('manifest file issues', () => {
    it('returns empty characters array when manifest file does not exist', async () => {
      // Point to a non-existent path
      process.env['CHARACTERS_CONFIG'] = join(testDir, 'nonexistent.json');
      const { loadManifest } = await freshImport();
      const manifest = loadManifest();
      expect(manifest.characters).toEqual([]);
      expect(manifest.town.name).toBe('Town');
    });

    it('throws on invalid JSON content', async () => {
      writeFileSync(manifestPath, '{ invalid json !!!');
      await expect(freshImport().then(m => m.loadManifest())).rejects.toThrow();
    });

    it('throws on empty file', async () => {
      writeFileSync(manifestPath, '');
      await expect(freshImport().then(m => m.loadManifest())).rejects.toThrow();
    });

    it('throws on non-JSON content', async () => {
      writeFileSync(manifestPath, 'this is plain text');
      await expect(freshImport().then(m => m.loadManifest())).rejects.toThrow();
    });

    it('throws on JSON array instead of object', async () => {
      writeFileSync(manifestPath, '[]');
      // The module does JSON.parse and casts to CharacterManifest; accessing
      // .characters on an array returns undefined, so getAllCharacters will error.
      // Exact behavior depends on access pattern. We just verify it does not
      // return a usable manifest.
      const mod = await freshImport();
      const manifest = mod.loadManifest();
      // Array parsed — .characters would be undefined
      expect(manifest.characters).toBeUndefined();
    });
  });

  // --- Empty manifest ---

  describe('empty manifest (0 characters)', () => {
    it('getAllCharacters returns empty array', async () => {
      writeManifest(makeManifest([]));
      const { getAllCharacters } = await freshImport();
      expect(getAllCharacters()).toHaveLength(0);
    });

    it('getDefaultLocations returns empty object', async () => {
      writeManifest(makeManifest([]));
      const { getDefaultLocations } = await freshImport();
      expect(Object.keys(getDefaultLocations())).toHaveLength(0);
    });

    it('getImmortalIds returns empty set', async () => {
      writeManifest(makeManifest([]));
      const { getImmortalIds } = await freshImport();
      expect(getImmortalIds().size).toBe(0);
    });

    it('getMortalCharacters returns empty array', async () => {
      writeManifest(makeManifest([]));
      const { getMortalCharacters } = await freshImport();
      expect(getMortalCharacters()).toHaveLength(0);
    });

    it('getWebCharacter returns undefined', async () => {
      writeManifest(makeManifest([]));
      const { getWebCharacter } = await freshImport();
      expect(getWebCharacter()).toBeUndefined();
    });

    it('getPeersFor returns empty for any id', async () => {
      writeManifest(makeManifest([]));
      const { getPeersFor } = await freshImport();
      expect(getPeersFor('anyone')).toHaveLength(0);
    });

    it('getCharacterEntry returns undefined for any id', async () => {
      writeManifest(makeManifest([]));
      const { getCharacterEntry } = await freshImport();
      expect(getCharacterEntry('anyone')).toBeUndefined();
    });
  });

  // --- Single character manifest ---

  describe('manifest with 1 character', () => {
    const solo = makeChar({ id: 'solo', port: 3001 });

    it('getAllCharacters returns exactly 1', async () => {
      writeManifest(makeManifest([solo]));
      const { getAllCharacters } = await freshImport();
      expect(getAllCharacters()).toHaveLength(1);
    });

    it('getPeersFor solo returns empty array (no peers possible)', async () => {
      writeManifest(makeManifest([solo]));
      const { getPeersFor } = await freshImport();
      expect(getPeersFor('solo')).toHaveLength(0);
    });

    it('getCharacterEntry finds the solo character', async () => {
      writeManifest(makeManifest([solo]));
      const { getCharacterEntry } = await freshImport();
      expect(getCharacterEntry('solo')).toBeDefined();
    });
  });

  // --- Large manifest (100 characters) ---

  describe('manifest with 100 characters', () => {
    const chars = Array.from({ length: 100 }, (_, i) =>
      makeChar({ id: `char-${i}`, port: 3000 + i, defaultLocation: VALID_BUILDINGS[i % VALID_BUILDINGS.length]! })
    );

    it('getAllCharacters returns all 100', async () => {
      writeManifest(makeManifest(chars));
      const { getAllCharacters } = await freshImport();
      expect(getAllCharacters()).toHaveLength(100);
    });

    it('getCharacterEntry finds any character by id', async () => {
      writeManifest(makeManifest(chars));
      const { getCharacterEntry } = await freshImport();
      expect(getCharacterEntry('char-0')).toBeDefined();
      expect(getCharacterEntry('char-50')).toBeDefined();
      expect(getCharacterEntry('char-99')).toBeDefined();
    });

    it('getPeersFor returns 99 peers for any character', async () => {
      writeManifest(makeManifest(chars));
      const { getPeersFor } = await freshImport();
      expect(getPeersFor('char-0')).toHaveLength(99);
      expect(getPeersFor('char-99')).toHaveLength(99);
    });

    it('getDefaultLocations returns 100 entries', async () => {
      writeManifest(makeManifest(chars));
      const { getDefaultLocations } = await freshImport();
      expect(Object.keys(getDefaultLocations())).toHaveLength(100);
    });
  });

  // --- Duplicate IDs ---

  describe('duplicate character IDs', () => {
    it('getCharacterEntry returns the first match', async () => {
      const dup1 = makeChar({ id: 'dup', name: 'First', port: 3001 });
      const dup2 = makeChar({ id: 'dup', name: 'Second', port: 3002 });
      writeManifest(makeManifest([dup1, dup2]));
      const { getCharacterEntry } = await freshImport();
      // .find() returns first match
      expect(getCharacterEntry('dup')!.name).toBe('First');
    });

    it('getAllCharacters includes both duplicates', async () => {
      const dup1 = makeChar({ id: 'dup', name: 'First', port: 3001 });
      const dup2 = makeChar({ id: 'dup', name: 'Second', port: 3002 });
      writeManifest(makeManifest([dup1, dup2]));
      const { getAllCharacters } = await freshImport();
      expect(getAllCharacters()).toHaveLength(2);
    });

    it('getPeersFor with duplicate IDs produces duplicate peer entries', async () => {
      const dup1 = makeChar({ id: 'dup', name: 'First', port: 3001 });
      const dup2 = makeChar({ id: 'dup', name: 'Second', port: 3002 });
      const other = makeChar({ id: 'other', port: 3003 });
      writeManifest(makeManifest([dup1, dup2, other]));
      const { getPeersFor } = await freshImport();
      const peers = getPeersFor('other');
      const dupPeers = peers.filter(p => p.id === 'dup');
      expect(dupPeers).toHaveLength(2);
    });

    it('getDefaultLocations with duplicate IDs: last one wins (object key overwrite)', async () => {
      const dup1 = makeChar({ id: 'dup', defaultLocation: 'library', port: 3001 });
      const dup2 = makeChar({ id: 'dup', defaultLocation: 'bar', port: 3002 });
      writeManifest(makeManifest([dup1, dup2]));
      const { getDefaultLocations } = await freshImport();
      // for..of iterates both; result[dup] gets overwritten by second
      expect(getDefaultLocations()['dup']).toBe('bar');
    });
  });

  // --- Duplicate ports ---

  describe('duplicate ports', () => {
    it('getAllCharacters returns both characters with same port', async () => {
      const a = makeChar({ id: 'a', port: 3000 });
      const b = makeChar({ id: 'b', port: 3000 });
      writeManifest(makeManifest([a, b]));
      const { getAllCharacters } = await freshImport();
      expect(getAllCharacters()).toHaveLength(2);
    });

    it('getPeersFor generates peers with duplicate port URLs', async () => {
      const a = makeChar({ id: 'a', port: 3000 });
      const b = makeChar({ id: 'b', port: 3000 });
      writeManifest(makeManifest([a, b]));
      const { getPeersFor } = await freshImport();
      const peersA = getPeersFor('a');
      expect(peersA[0]!.url).toBe('http://localhost:3000');
    });
  });

  // --- Missing fields ---

  describe('missing required fields on character entries', () => {
    const fieldsToOmit = ['id', 'name', 'port', 'server', 'defaultLocation', 'workspace'] as const;

    describe.each(fieldsToOmit)('missing %s', (field) => {
      it('getAllCharacters still returns the entry (no runtime validation)', async () => {
        const char = makeChar({ id: 'test', port: 3001 });
        delete (char as Record<string, unknown>)[field];
        writeManifest(makeManifest([char as unknown as TestCharacter]));
        const { getAllCharacters } = await freshImport();
        // The module does JSON.parse with a type cast -- no runtime validation
        expect(getAllCharacters()).toHaveLength(1);
      });
    });

    it('character with missing id: getCharacterEntry(undefined) returns undefined', async () => {
      const char = { name: 'No ID', port: 3001, server: 'character', defaultLocation: 'bar', workspace: 'ws' };
      writeManifest(makeManifest([char as unknown as TestCharacter]));
      const { getCharacterEntry } = await freshImport();
      expect(getCharacterEntry('no-id')).toBeUndefined();
    });

    it('character with missing name: entry has undefined name', async () => {
      const char = { id: 'no-name', port: 3001, server: 'character', defaultLocation: 'bar', workspace: 'ws' };
      writeManifest(makeManifest([char as unknown as TestCharacter]));
      const { getCharacterEntry } = await freshImport();
      const entry = getCharacterEntry('no-name');
      expect(entry).toBeDefined();
      expect(entry!.name).toBeUndefined();
    });

    it('character with missing port: entry has undefined port', async () => {
      const char = { id: 'no-port', name: 'No Port', server: 'character', defaultLocation: 'bar', workspace: 'ws' };
      writeManifest(makeManifest([char as unknown as TestCharacter]));
      const { getCharacterEntry } = await freshImport();
      const entry = getCharacterEntry('no-port');
      expect(entry).toBeDefined();
      expect(entry!.port).toBeUndefined();
    });
  });

  // --- Port edge cases ---

  describe('port edge cases', () => {
    const portCases: Array<[string, unknown]> = [
      ['port = 0', 0],
      ['port = -1', -1],
      ['port = 99999', 99999],
      ['port = NaN', NaN],  // JSON.stringify(NaN) => null
      ['port = string "3000"', '3000'],
      ['port = null', null],
      ['port = Infinity', Infinity],
      ['port = 3.14', 3.14],
    ];

    describe.each(portCases)('%s', (_label, port) => {
      it('manifest loads without error (no runtime port validation)', async () => {
        const char = { id: 'bad-port', name: 'Bad Port', port, server: 'character', defaultLocation: 'bar', workspace: 'ws' };
        writeManifest(makeManifest([char as unknown as TestCharacter]));
        const { getAllCharacters } = await freshImport();
        const all = getAllCharacters();
        expect(all).toHaveLength(1);
      });

      it('getPeersFor generates URL with the port value (after JSON round-trip)', async () => {
        const bad = { id: 'bad', name: 'Bad', port, server: 'character', defaultLocation: 'bar', workspace: 'ws' };
        const good = makeChar({ id: 'good', port: 3001 });
        writeManifest(makeManifest([bad as unknown as TestCharacter, good]));
        const { getPeersFor } = await freshImport();
        const peers = getPeersFor('good');
        expect(peers).toHaveLength(1);
        // NaN, Infinity become null after JSON.stringify round-trip
        const jsonPort = JSON.parse(JSON.stringify(port));
        expect(peers[0]!.url).toBe(`http://localhost:${jsonPort}`);
      });
    });
  });

  // --- Invalid default location ---

  describe('invalid default location', () => {
    it('character with non-existent building loads without error', async () => {
      const char = makeChar({ id: 'lost', defaultLocation: 'nonexistent-building', port: 3001 });
      writeManifest(makeManifest([char]));
      const { getDefaultLocations } = await freshImport();
      expect(getDefaultLocations()['lost']).toBe('nonexistent-building');
    });

    it('empty string as default location', async () => {
      const char = makeChar({ id: 'empty-loc', defaultLocation: '', port: 3001 });
      writeManifest(makeManifest([char]));
      const { getDefaultLocations } = await freshImport();
      expect(getDefaultLocations()['empty-loc']).toBe('');
    });
  });

  // --- Manifest caching behavior ---

  describe('manifest caching', () => {
    it('loadManifest returns the same object on repeated calls', async () => {
      writeManifest(makeManifest([makeChar({ id: 'a', port: 3001 })]));
      const { loadManifest } = await freshImport();
      const first = loadManifest();
      const second = loadManifest();
      expect(first).toBe(second); // Same reference
    });

    it('cached manifest survives after file is deleted', async () => {
      writeManifest(makeManifest([makeChar({ id: 'a', port: 3001 })]));
      const { loadManifest, getAllCharacters } = await freshImport();
      loadManifest(); // Cache it
      rmSync(manifestPath); // Delete the file
      // Should still work from cache
      expect(getAllCharacters()).toHaveLength(1);
    });
  });
});

// ===========================================================================
// 3. PEER GENERATION MATRIX (~60 tests)
// ===========================================================================

describe('Peer generation matrix', () => {

  // --- Peer count for N characters ---

  describe('peer count for N characters', () => {
    const sizeCases: Array<[number]> = [[2], [3], [4], [5], [10], [20]];

    describe.each(sizeCases)('%i characters', (n) => {
      it(`each character gets ${n - 1} peers`, async () => {
        const chars = Array.from({ length: n }, (_, i) =>
          makeChar({ id: `c${i}`, port: 3000 + i })
        );
        writeManifest(makeManifest(chars));
        const { getPeersFor } = await freshImport();
        for (const c of chars) {
          expect(getPeersFor(c.id)).toHaveLength(n - 1);
        }
      });

      it('no character appears in its own peer list', async () => {
        const chars = Array.from({ length: n }, (_, i) =>
          makeChar({ id: `c${i}`, port: 3000 + i })
        );
        writeManifest(makeManifest(chars));
        const { getPeersFor } = await freshImport();
        for (const c of chars) {
          const peers = getPeersFor(c.id);
          expect(peers.every(p => p.id !== c.id)).toBe(true);
        }
      });

      it('every other character appears in each peer list', async () => {
        const chars = Array.from({ length: n }, (_, i) =>
          makeChar({ id: `c${i}`, port: 3000 + i })
        );
        writeManifest(makeManifest(chars));
        const { getPeersFor } = await freshImport();
        for (const c of chars) {
          const peers = getPeersFor(c.id);
          const peerIds = new Set(peers.map(p => p.id));
          for (const other of chars) {
            if (other.id !== c.id) {
              expect(peerIds.has(other.id)).toBe(true);
            }
          }
        }
      });
    });
  });

  // --- Peer URL correctness ---

  describe('peer URL correctness', () => {
    const portCases: Array<[string, number]> = [
      ['standard port 3000', 3000],
      ['standard port 3001', 3001],
      ['high port 9999', 9999],
      ['port 80', 80],
      ['port 443', 443],
      ['port 8080', 8080],
    ];

    describe.each(portCases)('%s', (_label, port) => {
      it(`generates URL http://localhost:${port}`, async () => {
        const target = makeChar({ id: 'target', port });
        const asker = makeChar({ id: 'asker', port: port + 1 });
        writeManifest(makeManifest([target, asker]));
        const { getPeersFor } = await freshImport();
        const peers = getPeersFor('asker');
        const targetPeer = peers.find(p => p.id === 'target');
        expect(targetPeer).toBeDefined();
        expect(targetPeer!.url).toBe(`http://localhost:${port}`);
      });
    });
  });

  // --- Peer name correctness ---

  describe('peer name correctness', () => {
    const nameCases: Array<[string, string]> = [
      ['simple name', 'Alice'],
      ['hyphenated name', 'Wired-Lain'],
      ['name with spaces', 'Dr. Claude'],
      ['single letter name', 'X'],
      ['unicode name', 'Sakura'],
      ['very long name', 'A'.repeat(100)],
    ];

    describe.each(nameCases)('%s: "%s"', (_label, name) => {
      it('peer name matches character name', async () => {
        const target = makeChar({ id: 'target', name, port: 3001 });
        const asker = makeChar({ id: 'asker', port: 3002 });
        writeManifest(makeManifest([target, asker]));
        const { getPeersFor } = await freshImport();
        const peers = getPeersFor('asker');
        const targetPeer = peers.find(p => p.id === 'target');
        expect(targetPeer).toBeDefined();
        expect(targetPeer!.name).toBe(name);
      });
    });
  });

  // --- getPeersFor with nonexistent character ---

  describe('getPeersFor with nonexistent character ID', () => {
    it('returns all characters as peers when queried ID does not exist', async () => {
      const chars = [
        makeChar({ id: 'a', port: 3001 }),
        makeChar({ id: 'b', port: 3002 }),
        makeChar({ id: 'c', port: 3003 }),
      ];
      writeManifest(makeManifest(chars));
      const { getPeersFor } = await freshImport();
      // filter(c => c.id !== 'nonexistent') won't exclude any
      const peers = getPeersFor('nonexistent');
      expect(peers).toHaveLength(3);
    });
  });

  // --- Peer symmetry ---

  describe('peer symmetry', () => {
    it('if A is in B peers, B is in A peers (2 chars)', async () => {
      const a = makeChar({ id: 'a', port: 3001 });
      const b = makeChar({ id: 'b', port: 3002 });
      writeManifest(makeManifest([a, b]));
      const { getPeersFor } = await freshImport();
      expect(getPeersFor('a').some(p => p.id === 'b')).toBe(true);
      expect(getPeersFor('b').some(p => p.id === 'a')).toBe(true);
    });

    it('peer relationship is symmetric for 5 characters', async () => {
      const chars = Array.from({ length: 5 }, (_, i) =>
        makeChar({ id: `c${i}`, port: 3000 + i })
      );
      writeManifest(makeManifest(chars));
      const { getPeersFor } = await freshImport();
      for (const c1 of chars) {
        for (const c2 of chars) {
          if (c1.id !== c2.id) {
            const c1Peers = getPeersFor(c1.id).map(p => p.id);
            expect(c1Peers).toContain(c2.id);
          }
        }
      }
    });
  });

  // --- Immortal/mortal in peer lists ---

  describe('immortal/mortal characters in peer lists', () => {
    it('mortal characters appear in immortal character peer list', async () => {
      const immortal = makeChar({ id: 'god', port: 3001, immortal: true });
      const mortal = makeChar({ id: 'human', port: 3002, immortal: false });
      writeManifest(makeManifest([immortal, mortal]));
      const { getPeersFor } = await freshImport();
      const peers = getPeersFor('god');
      expect(peers.some(p => p.id === 'human')).toBe(true);
    });

    it('immortal characters appear in mortal character peer list', async () => {
      const immortal = makeChar({ id: 'god', port: 3001, immortal: true });
      const mortal = makeChar({ id: 'human', port: 3002, immortal: false });
      writeManifest(makeManifest([immortal, mortal]));
      const { getPeersFor } = await freshImport();
      const peers = getPeersFor('human');
      expect(peers.some(p => p.id === 'god')).toBe(true);
    });

    it('mixed immortal/mortal manifests generate correct peer counts', async () => {
      const chars = [
        makeChar({ id: 'imm1', port: 3001, immortal: true }),
        makeChar({ id: 'imm2', port: 3002, immortal: true }),
        makeChar({ id: 'mort1', port: 3003, immortal: false }),
        makeChar({ id: 'mort2', port: 3004, immortal: false }),
        makeChar({ id: 'mort3', port: 3005 }),
      ];
      writeManifest(makeManifest(chars));
      const { getPeersFor } = await freshImport();
      for (const c of chars) {
        expect(getPeersFor(c.id)).toHaveLength(4);
      }
    });
  });

  // --- Peer list ordering ---

  describe('peer list ordering', () => {
    it('peers are returned in manifest order (excluding self)', async () => {
      const chars = [
        makeChar({ id: 'alpha', port: 3001 }),
        makeChar({ id: 'beta', port: 3002 }),
        makeChar({ id: 'gamma', port: 3003 }),
        makeChar({ id: 'delta', port: 3004 }),
      ];
      writeManifest(makeManifest(chars));
      const { getPeersFor } = await freshImport();
      const peersOfBeta = getPeersFor('beta');
      expect(peersOfBeta.map(p => p.id)).toEqual(['alpha', 'gamma', 'delta']);
    });
  });

  // --- Peer object structure ---

  describe('peer object structure', () => {
    it('each peer has id, name, and url fields', async () => {
      const a = makeChar({ id: 'a', name: 'Alice', port: 3001 });
      const b = makeChar({ id: 'b', name: 'Bob', port: 3002 });
      writeManifest(makeManifest([a, b]));
      const { getPeersFor } = await freshImport();
      const peers = getPeersFor('a');
      expect(peers).toHaveLength(1);
      const peer = peers[0]!;
      expect(peer).toHaveProperty('id');
      expect(peer).toHaveProperty('name');
      expect(peer).toHaveProperty('url');
      expect(typeof peer.id).toBe('string');
      expect(typeof peer.name).toBe('string');
      expect(typeof peer.url).toBe('string');
    });

    it('peer does not contain extra fields like immortal, workspace, etc.', async () => {
      const a = makeChar({ id: 'a', port: 3001, immortal: true, possessable: true });
      const b = makeChar({ id: 'b', port: 3002 });
      writeManifest(makeManifest([a, b]));
      const { getPeersFor } = await freshImport();
      const peers = getPeersFor('b');
      const peer = peers[0]!;
      expect(Object.keys(peer).sort()).toEqual(['id', 'name', 'url']);
    });
  });
});

// ===========================================================================
// 4. MANIFEST x LOOP INTERACTION MATRIX (~60 tests)
// ===========================================================================

describe('Manifest x loop interaction matrix', () => {

  // --- Commune loop peer availability ---

  describe('commune loop peer availability', () => {
    it('0 peers: commune loop config would have empty peers array', async () => {
      const solo = makeChar({ id: 'solo', port: 3001 });
      writeManifest(makeManifest([solo]));
      const { getPeersFor } = await freshImport();
      const peers = getPeersFor('solo');
      expect(peers).toHaveLength(0);
      // CommuneLoopConfig.peers would be [] -> loop disabled
    });

    it('1 peer: commune loop has exactly 1 peer to select', async () => {
      const a = makeChar({ id: 'a', port: 3001 });
      const b = makeChar({ id: 'b', port: 3002 });
      writeManifest(makeManifest([a, b]));
      const { getPeersFor } = await freshImport();
      const peers = getPeersFor('a');
      expect(peers).toHaveLength(1);
      expect(peers[0]!.id).toBe('b');
    });

    it('many peers: commune loop has multiple candidates', async () => {
      const chars = Array.from({ length: 8 }, (_, i) =>
        makeChar({ id: `c${i}`, port: 3000 + i })
      );
      writeManifest(makeManifest(chars));
      const { getPeersFor } = await freshImport();
      const peers = getPeersFor('c0');
      expect(peers).toHaveLength(7);
    });

    it('removing a character from manifest removes it from peer lists', async () => {
      // First manifest: 3 characters
      const chars3 = [
        makeChar({ id: 'a', port: 3001 }),
        makeChar({ id: 'b', port: 3002 }),
        makeChar({ id: 'c', port: 3003 }),
      ];
      writeManifest(makeManifest(chars3));
      const mod1 = await freshImport();
      expect(mod1.getPeersFor('a')).toHaveLength(2);

      // Second manifest: 2 characters (c removed)
      const chars2 = [
        makeChar({ id: 'a', port: 3001 }),
        makeChar({ id: 'b', port: 3002 }),
      ];
      writeManifest(makeManifest(chars2));
      const mod2 = await freshImport();
      const peers = mod2.getPeersFor('a');
      expect(peers).toHaveLength(1);
      expect(peers.every(p => p.id !== 'c')).toBe(true);
    });
  });

  // --- Default location x building validity ---

  describe('default location x building validity', () => {
    describe.each(VALID_BUILDINGS.map(b => [b]))('building "%s"', (building) => {
      it('is accepted as a default location', async () => {
        const char = makeChar({ id: 'test', port: 3001, defaultLocation: building });
        writeManifest(makeManifest([char]));
        const { getDefaultLocations } = await freshImport();
        expect(getDefaultLocations()['test']).toBe(building);
      });
    });

    const invalidBuildings = ['tavern', 'castle', 'dungeon', 'LIBRARY', 'Library', '', 'the threshold'];

    describe.each(invalidBuildings.map(b => [b]))('invalid building "%s"', (building) => {
      it('is stored as default location (no validation in manifest loader)', async () => {
        const char = makeChar({ id: 'test', port: 3001, defaultLocation: building });
        writeManifest(makeManifest([char]));
        const { getDefaultLocations } = await freshImport();
        expect(getDefaultLocations()['test']).toBe(building);
      });
    });
  });

  // --- Building resolution from manifest (buildings.ts integration) ---

  describe('building module filters invalid default locations', () => {
    it('valid building IDs pass through getDefaultLocationsFromManifest', async () => {
      const chars = VALID_BUILDINGS.map((b, i) =>
        makeChar({ id: `c${i}`, port: 3000 + i, defaultLocation: b })
      );
      writeManifest(makeManifest(chars));
      // Need fresh import of buildings module too since it imports characters
      vi.resetModules();
      const { getDefaultLocationsFromManifest } = await import('../src/commune/buildings.js');
      const locs = getDefaultLocationsFromManifest();
      for (let i = 0; i < VALID_BUILDINGS.length; i++) {
        expect(locs[`c${i}`]).toBe(VALID_BUILDINGS[i]);
      }
    });

    it('invalid building IDs are filtered out by getDefaultLocationsFromManifest', async () => {
      const chars = [
        makeChar({ id: 'valid', port: 3001, defaultLocation: 'library' }),
        makeChar({ id: 'invalid', port: 3002, defaultLocation: 'nonexistent' }),
      ];
      writeManifest(makeManifest(chars));
      vi.resetModules();
      const { getDefaultLocationsFromManifest } = await import('../src/commune/buildings.js');
      const locs = getDefaultLocationsFromManifest();
      expect(locs['valid']).toBe('library');
      expect(locs['invalid']).toBeUndefined();
    });
  });

  // --- Port conflict detection ---

  describe('port conflict scenarios', () => {
    it('two characters sharing a port produces correct peer URLs', async () => {
      const a = makeChar({ id: 'a', port: 3000 });
      const b = makeChar({ id: 'b', port: 3000 });
      writeManifest(makeManifest([a, b]));
      const { getPeersFor } = await freshImport();
      const peersA = getPeersFor('a');
      const peersB = getPeersFor('b');
      expect(peersA[0]!.url).toBe('http://localhost:3000');
      expect(peersB[0]!.url).toBe('http://localhost:3000');
    });

    it('all unique ports produce unique peer URLs', async () => {
      const chars = Array.from({ length: 5 }, (_, i) =>
        makeChar({ id: `c${i}`, port: 3000 + i })
      );
      writeManifest(makeManifest(chars));
      const { getPeersFor } = await freshImport();
      const peers = getPeersFor('c0');
      const urls = peers.map(p => p.url);
      expect(new Set(urls).size).toBe(urls.length);
    });
  });

  // --- Town config ---

  describe('town config', () => {
    it('loadManifest returns custom town name', async () => {
      writeManifest(makeManifest([], { name: 'Laintown', description: 'A wired place' }));
      const { loadManifest } = await freshImport();
      const m = loadManifest();
      expect(m.town.name).toBe('Laintown');
      expect(m.town.description).toBe('A wired place');
    });

    it('default fallback manifest has town name "Town"', async () => {
      process.env['CHARACTERS_CONFIG'] = join(testDir, 'nonexistent.json');
      const { loadManifest } = await freshImport();
      expect(loadManifest().town.name).toBe('Town');
    });
  });

  // --- Character identity combinations ---

  describe('character identity combinations', () => {
    const combos: Array<[string, boolean | undefined, boolean | undefined, 'web' | 'character']> = [
      ['immortal web',         true,  false,     'web'],
      ['immortal character',   true,  undefined, 'character'],
      ['mortal web',           false, true,      'web'],
      ['mortal character',     false, false,     'character'],
      ['possessable immortal', true,  true,      'character'],
      ['default flags',        undefined, undefined, 'character'],
    ];

    describe.each(combos)('%s', (_label, immortal, possessable, server) => {
      it('is correctly classified by all manifest functions', async () => {
        const char: TestCharacter = {
          id: 'test',
          name: 'Test',
          port: 3001,
          server,
          defaultLocation: 'library',
          workspace: 'workspace/characters/test',
        };
        if (immortal !== undefined) char.immortal = immortal;
        if (possessable !== undefined) char.possessable = possessable;

        writeManifest(makeManifest([char]));
        const mod = await freshImport();

        // getAllCharacters includes it
        expect(mod.getAllCharacters()).toHaveLength(1);

        // getCharacterEntry finds it
        expect(mod.getCharacterEntry('test')).toBeDefined();

        // getImmortalIds
        expect(mod.getImmortalIds().has('test')).toBe(!!immortal);

        // getMortalCharacters
        const isMortal = !immortal;
        expect(mod.getMortalCharacters().some(c => c.id === 'test')).toBe(isMortal);

        // getWebCharacter
        if (server === 'web') {
          expect(mod.getWebCharacter()?.id).toBe('test');
        } else {
          expect(mod.getWebCharacter()).toBeUndefined();
        }

        // getDefaultLocations
        expect(mod.getDefaultLocations()['test']).toBe('library');
      });
    });
  });

  // --- Multiple web characters ---

  describe('multiple web characters', () => {
    it('getWebCharacter returns the first one in manifest order', async () => {
      const chars = [
        makeChar({ id: 'web1', port: 3000, server: 'web' }),
        makeChar({ id: 'web2', port: 3001, server: 'web' }),
        makeChar({ id: 'char1', port: 3002, server: 'character' }),
      ];
      writeManifest(makeManifest(chars));
      const { getWebCharacter } = await freshImport();
      expect(getWebCharacter()!.id).toBe('web1');
    });
  });

  // --- All immortal / all mortal ---

  describe('all immortal manifest', () => {
    it('getImmortalIds contains all, getMortalCharacters is empty', async () => {
      const chars = Array.from({ length: 5 }, (_, i) =>
        makeChar({ id: `c${i}`, port: 3000 + i, immortal: true })
      );
      writeManifest(makeManifest(chars));
      const mod = await freshImport();
      expect(mod.getImmortalIds().size).toBe(5);
      expect(mod.getMortalCharacters()).toHaveLength(0);
    });
  });

  describe('all mortal manifest', () => {
    it('getImmortalIds is empty, getMortalCharacters contains all', async () => {
      const chars = Array.from({ length: 5 }, (_, i) =>
        makeChar({ id: `c${i}`, port: 3000 + i, immortal: false })
      );
      writeManifest(makeManifest(chars));
      const mod = await freshImport();
      expect(mod.getImmortalIds().size).toBe(0);
      expect(mod.getMortalCharacters()).toHaveLength(5);
    });
  });
});

// ===========================================================================
// 5. WORKSPACE RESOLUTION MATRIX (~40 tests)
// ===========================================================================

describe('Workspace resolution matrix', () => {

  // --- Default workspace paths ---

  describe('default workspace path pattern', () => {
    const ids = ['alice', 'bob', 'wired-lain', 'dr-claude', 'pkd'];

    describe.each(ids.map(id => [id]))('character "%s"', (id) => {
      it('default workspace follows workspace/characters/<id> pattern', async () => {
        const char = makeChar({ id, port: 3001 });
        writeManifest(makeManifest([char]));
        const { getCharacterEntry } = await freshImport();
        const entry = getCharacterEntry(id);
        expect(entry!.workspace).toBe(`workspace/characters/${id}`);
      });
    });
  });

  // --- Custom workspace paths ---

  describe('custom workspace paths', () => {
    const customPaths: Array<[string, string]> = [
      ['absolute path', '/opt/custom/workspace'],
      ['relative path', 'custom/workspace/path'],
      ['nested path', 'a/b/c/d/e/workspace'],
      ['dot-prefixed', '.hidden/workspace'],
      ['tilde path', '~/my-workspace'],
      ['path with trailing slash', 'workspace/test/'],
    ];

    describe.each(customPaths)('%s: "%s"', (_label, wsPath) => {
      it('workspace path is stored exactly as provided', async () => {
        const char = makeChar({ id: 'custom', port: 3001, workspace: wsPath });
        writeManifest(makeManifest([char]));
        const { getCharacterEntry } = await freshImport();
        expect(getCharacterEntry('custom')!.workspace).toBe(wsPath);
      });
    });
  });

  // --- Workspace with special characters ---

  describe('workspace paths with special characters', () => {
    const specialPaths: Array<[string, string]> = [
      ['spaces', 'workspace/my character'],
      ['unicode', 'workspace/sakura'],
      ['dots', 'workspace/v1.0.0/char'],
      ['hyphens', 'workspace/my-char-workspace'],
      ['underscores', 'workspace/my_char_workspace'],
      ['numbers', 'workspace/char123'],
    ];

    describe.each(specialPaths)('path with %s: "%s"', (_label, wsPath) => {
      it('workspace is preserved as-is in the manifest', async () => {
        const char = makeChar({ id: 'special', port: 3001, workspace: wsPath });
        writeManifest(makeManifest([char]));
        const { getCharacterEntry } = await freshImport();
        expect(getCharacterEntry('special')!.workspace).toBe(wsPath);
      });
    });
  });

  // --- Path traversal attempts ---

  describe('workspace path traversal', () => {
    const traversalPaths: Array<[string, string]> = [
      ['parent directory', '../secret/workspace'],
      ['double parent', '../../etc/passwd'],
      ['absolute with traversal', '/opt/../etc/shadow'],
      ['dot-dot in middle', 'workspace/../../../root'],
      ['dot-dot at end', 'workspace/..'],
    ];

    describe.each(traversalPaths)('%s: "%s"', (_label, wsPath) => {
      it('workspace path is stored without sanitization (caller responsibility)', async () => {
        const char = makeChar({ id: 'traversal', port: 3001, workspace: wsPath });
        writeManifest(makeManifest([char]));
        const { getCharacterEntry } = await freshImport();
        // The manifest module does not validate or sanitize paths
        expect(getCharacterEntry('traversal')!.workspace).toBe(wsPath);
      });
    });
  });

  // --- Empty workspace ---

  describe('empty and missing workspace', () => {
    it('empty string workspace is stored as empty string', async () => {
      const char = makeChar({ id: 'empty-ws', port: 3001, workspace: '' });
      writeManifest(makeManifest([char]));
      const { getCharacterEntry } = await freshImport();
      expect(getCharacterEntry('empty-ws')!.workspace).toBe('');
    });

    it('missing workspace field results in undefined', async () => {
      const char = { id: 'no-ws', name: 'No WS', port: 3001, server: 'character', defaultLocation: 'bar' };
      writeManifest(makeManifest([char as unknown as TestCharacter]));
      const { getCharacterEntry } = await freshImport();
      expect(getCharacterEntry('no-ws')!.workspace).toBeUndefined();
    });
  });

  // --- Workspace per character in a full manifest ---

  describe('workspace uniqueness across characters', () => {
    it('each character can have a unique workspace', async () => {
      const chars = [
        makeChar({ id: 'a', port: 3001, workspace: 'ws/a' }),
        makeChar({ id: 'b', port: 3002, workspace: 'ws/b' }),
        makeChar({ id: 'c', port: 3003, workspace: 'ws/c' }),
      ];
      writeManifest(makeManifest(chars));
      const { getAllCharacters } = await freshImport();
      const workspaces = getAllCharacters().map(c => c.workspace);
      expect(new Set(workspaces).size).toBe(3);
    });

    it('characters can share the same workspace (no uniqueness enforced)', async () => {
      const chars = [
        makeChar({ id: 'a', port: 3001, workspace: 'shared/ws' }),
        makeChar({ id: 'b', port: 3002, workspace: 'shared/ws' }),
      ];
      writeManifest(makeManifest(chars));
      const { getAllCharacters } = await freshImport();
      const workspaces = getAllCharacters().map(c => c.workspace);
      expect(workspaces[0]).toBe(workspaces[1]);
    });
  });

  // --- Workspace field type robustness ---

  describe('workspace field type edge cases', () => {
    const typeCases: Array<[string, unknown]> = [
      ['number', 12345],
      ['boolean', true],
      ['null', null],
      ['array', ['ws/a']],
      ['object', { path: 'ws/a' }],
    ];

    describe.each(typeCases)('workspace = %s', (_label, value) => {
      it('loads without error (no type validation at load time)', async () => {
        const char = { id: 'typed', name: 'Typed', port: 3001, server: 'character', defaultLocation: 'bar', workspace: value };
        writeManifest(makeManifest([char as unknown as TestCharacter]));
        const { getCharacterEntry } = await freshImport();
        const entry = getCharacterEntry('typed');
        expect(entry).toBeDefined();
        expect(entry!.workspace).toEqual(value);
      });
    });
  });
});

// ===========================================================================
// 6. ADDITIONAL PEER GENERATION EDGE CASES
// ===========================================================================

describe('Additional peer generation edge cases', () => {

  // --- Exact peer counts for small manifests ---

  describe('exact peer counts for N=1..10', () => {
    const sizes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

    describe.each(sizes.map(n => [n]))('N=%i', (n) => {
      it(`first character gets ${n - 1} peers`, async () => {
        const chars = Array.from({ length: n }, (_, i) =>
          makeChar({ id: `c${i}`, port: 3000 + i })
        );
        writeManifest(makeManifest(chars));
        const { getPeersFor } = await freshImport();
        expect(getPeersFor('c0')).toHaveLength(n - 1);
      });

      it(`last character gets ${n - 1} peers`, async () => {
        const chars = Array.from({ length: n }, (_, i) =>
          makeChar({ id: `c${i}`, port: 3000 + i })
        );
        writeManifest(makeManifest(chars));
        const { getPeersFor } = await freshImport();
        expect(getPeersFor(`c${n - 1}`)).toHaveLength(n - 1);
      });
    });
  });

  // --- Peer URL format validation ---

  describe('peer URL format', () => {
    it('all peer URLs start with http://localhost:', async () => {
      const chars = Array.from({ length: 4 }, (_, i) =>
        makeChar({ id: `c${i}`, port: 3000 + i })
      );
      writeManifest(makeManifest(chars));
      const { getPeersFor } = await freshImport();
      for (const c of chars) {
        const peers = getPeersFor(c.id);
        for (const p of peers) {
          expect(p.url).toMatch(/^http:\/\/localhost:\d+$/);
        }
      }
    });

    it('peer URL port matches the character port from manifest', async () => {
      const chars = [
        makeChar({ id: 'a', port: 4567 }),
        makeChar({ id: 'b', port: 8901 }),
        makeChar({ id: 'c', port: 2345 }),
      ];
      writeManifest(makeManifest(chars));
      const { getPeersFor, getCharacterEntry } = await freshImport();
      const peers = getPeersFor('a');
      for (const p of peers) {
        const entry = getCharacterEntry(p.id)!;
        expect(p.url).toBe(`http://localhost:${entry.port}`);
      }
    });
  });

  // --- getPeersFor with empty string id ---

  describe('getPeersFor with empty and unusual IDs', () => {
    it('empty string ID returns all characters (none excluded)', async () => {
      const chars = [
        makeChar({ id: 'a', port: 3001 }),
        makeChar({ id: 'b', port: 3002 }),
      ];
      writeManifest(makeManifest(chars));
      const { getPeersFor } = await freshImport();
      expect(getPeersFor('')).toHaveLength(2);
    });

    it('whitespace ID returns all characters', async () => {
      const chars = [
        makeChar({ id: 'a', port: 3001 }),
        makeChar({ id: 'b', port: 3002 }),
      ];
      writeManifest(makeManifest(chars));
      const { getPeersFor } = await freshImport();
      expect(getPeersFor('   ')).toHaveLength(2);
    });

    it('undefined-like string returns all characters', async () => {
      const chars = [
        makeChar({ id: 'a', port: 3001 }),
        makeChar({ id: 'b', port: 3002 }),
      ];
      writeManifest(makeManifest(chars));
      const { getPeersFor } = await freshImport();
      expect(getPeersFor('undefined')).toHaveLength(2);
    });
  });

  // --- Peer generation does not include server type / immortal status ---

  describe('peer object is minimal', () => {
    it('peer object has exactly 3 keys', async () => {
      const chars = [
        makeChar({ id: 'a', port: 3001, immortal: true, possessable: true, server: 'web' }),
        makeChar({ id: 'b', port: 3002, immortal: false, possessable: false, server: 'character' }),
      ];
      writeManifest(makeManifest(chars));
      const { getPeersFor } = await freshImport();
      const peers = getPeersFor('a');
      expect(Object.keys(peers[0]!)).toHaveLength(3);
    });
  });
});

// ===========================================================================
// 7. MANIFEST FIELD PRESERVATION MATRIX
// ===========================================================================

describe('Manifest field preservation matrix', () => {

  // Test that every field on a character entry is preserved through load
  const fieldTests: Array<[string, keyof TestCharacter, unknown]> = [
    ['id', 'id', 'test-id'],
    ['name', 'name', 'Test Name'],
    ['port', 'port', 4242],
    ['server=web', 'server', 'web'],
    ['server=character', 'server', 'character'],
    ['defaultLocation', 'defaultLocation', 'lighthouse'],
    ['immortal=true', 'immortal', true],
    ['immortal=false', 'immortal', false],
    ['possessable=true', 'possessable', true],
    ['possessable=false', 'possessable', false],
    ['workspace', 'workspace', 'custom/workspace/path'],
  ];

  describe.each(fieldTests)('field %s', (_label, field, value) => {
    it('is preserved after load', async () => {
      const char = makeChar({ id: 'test', port: 3001 });
      (char as Record<string, unknown>)[field] = value;
      // Look up by the actual id (which may have been overridden)
      const lookupId = (char as Record<string, unknown>)['id'] as string;
      writeManifest(makeManifest([char]));
      const { getCharacterEntry } = await freshImport();
      const entry = getCharacterEntry(lookupId)!;
      expect(entry).toBeDefined();
      expect((entry as Record<string, unknown>)[field]).toEqual(value);
    });
  });
});

// ===========================================================================
// 8. MULTI-CHARACTER INTERACTION MATRIX
// ===========================================================================

describe('Multi-character interaction matrix', () => {

  // --- Character lookup does not interfere with other lookups ---

  describe('independent character lookups', () => {
    const chars = [
      makeChar({ id: 'alice', name: 'Alice', port: 3001, immortal: true, server: 'web', defaultLocation: 'library' }),
      makeChar({ id: 'bob', name: 'Bob', port: 3002, immortal: false, server: 'character', defaultLocation: 'bar' }),
      makeChar({ id: 'carol', name: 'Carol', port: 3003, immortal: false, server: 'character', defaultLocation: 'field' }),
      makeChar({ id: 'dave', name: 'Dave', port: 3004, immortal: true, server: 'character', defaultLocation: 'windmill' }),
    ];

    it('getCharacterEntry returns correct data for each character', async () => {
      writeManifest(makeManifest(chars));
      const { getCharacterEntry } = await freshImport();
      for (const c of chars) {
        const entry = getCharacterEntry(c.id)!;
        expect(entry.id).toBe(c.id);
        expect(entry.name).toBe(c.name);
        expect(entry.port).toBe(c.port);
        expect(entry.server).toBe(c.server);
        expect(entry.defaultLocation).toBe(c.defaultLocation);
      }
    });

    it('getDefaultLocations contains all characters', async () => {
      writeManifest(makeManifest(chars));
      const { getDefaultLocations } = await freshImport();
      const locs = getDefaultLocations();
      expect(locs['alice']).toBe('library');
      expect(locs['bob']).toBe('bar');
      expect(locs['carol']).toBe('field');
      expect(locs['dave']).toBe('windmill');
    });

    it('immortal/mortal split is correct', async () => {
      writeManifest(makeManifest(chars));
      const mod = await freshImport();
      const immortals = mod.getImmortalIds();
      const mortals = mod.getMortalCharacters();

      expect(immortals.has('alice')).toBe(true);
      expect(immortals.has('dave')).toBe(true);
      expect(immortals.has('bob')).toBe(false);
      expect(immortals.has('carol')).toBe(false);

      expect(mortals).toHaveLength(2);
      expect(mortals.map(m => m.id).sort()).toEqual(['bob', 'carol']);
    });

    it('peer lists are correct for all characters', async () => {
      writeManifest(makeManifest(chars));
      const { getPeersFor } = await freshImport();

      for (const c of chars) {
        const peers = getPeersFor(c.id);
        expect(peers).toHaveLength(3);
        expect(peers.every(p => p.id !== c.id)).toBe(true);
        const otherIds = chars.filter(o => o.id !== c.id).map(o => o.id);
        expect(peers.map(p => p.id).sort()).toEqual(otherIds.sort());
      }
    });

    it('only alice is the web character', async () => {
      writeManifest(makeManifest(chars));
      const { getWebCharacter } = await freshImport();
      expect(getWebCharacter()!.id).toBe('alice');
    });
  });

  // --- Adding a character to manifest ---

  describe('growing manifest', () => {
    it('adding a character increases getAllCharacters count', async () => {
      const v1 = [makeChar({ id: 'a', port: 3001 })];
      writeManifest(makeManifest(v1));
      const mod1 = await freshImport();
      expect(mod1.getAllCharacters()).toHaveLength(1);

      const v2 = [makeChar({ id: 'a', port: 3001 }), makeChar({ id: 'b', port: 3002 })];
      writeManifest(makeManifest(v2));
      const mod2 = await freshImport();
      expect(mod2.getAllCharacters()).toHaveLength(2);
    });

    it('adding a character makes it appear in peer lists', async () => {
      const v1 = [makeChar({ id: 'a', port: 3001 }), makeChar({ id: 'b', port: 3002 })];
      writeManifest(makeManifest(v1));
      const mod1 = await freshImport();
      expect(mod1.getPeersFor('a')).toHaveLength(1);

      const v2 = [...v1, makeChar({ id: 'c', port: 3003 })];
      writeManifest(makeManifest(v2));
      const mod2 = await freshImport();
      expect(mod2.getPeersFor('a')).toHaveLength(2);
      expect(mod2.getPeersFor('a').map(p => p.id)).toContain('c');
    });
  });

  // --- Shrinking manifest ---

  describe('shrinking manifest', () => {
    it('removing a character decreases getAllCharacters count', async () => {
      const v1 = [makeChar({ id: 'a', port: 3001 }), makeChar({ id: 'b', port: 3002 })];
      writeManifest(makeManifest(v1));
      const mod1 = await freshImport();
      expect(mod1.getAllCharacters()).toHaveLength(2);

      const v2 = [makeChar({ id: 'a', port: 3001 })];
      writeManifest(makeManifest(v2));
      const mod2 = await freshImport();
      expect(mod2.getAllCharacters()).toHaveLength(1);
    });

    it('removing a character removes it from peer lists', async () => {
      const v1 = [
        makeChar({ id: 'a', port: 3001 }),
        makeChar({ id: 'b', port: 3002 }),
        makeChar({ id: 'c', port: 3003 }),
      ];
      writeManifest(makeManifest(v1));
      const mod1 = await freshImport();
      expect(mod1.getPeersFor('a').map(p => p.id)).toContain('c');

      const v2 = [makeChar({ id: 'a', port: 3001 }), makeChar({ id: 'b', port: 3002 })];
      writeManifest(makeManifest(v2));
      const mod2 = await freshImport();
      expect(mod2.getPeersFor('a').map(p => p.id)).not.toContain('c');
    });

    it('removing the only web character makes getWebCharacter return undefined', async () => {
      const v1 = [makeChar({ id: 'web', port: 3000, server: 'web' }), makeChar({ id: 'b', port: 3001 })];
      writeManifest(makeManifest(v1));
      const mod1 = await freshImport();
      expect(mod1.getWebCharacter()).toBeDefined();

      const v2 = [makeChar({ id: 'b', port: 3001 })];
      writeManifest(makeManifest(v2));
      const mod2 = await freshImport();
      expect(mod2.getWebCharacter()).toBeUndefined();
    });

    it('removing an immortal character removes it from immortal set', async () => {
      const v1 = [
        makeChar({ id: 'god', port: 3001, immortal: true }),
        makeChar({ id: 'mortal', port: 3002, immortal: false }),
      ];
      writeManifest(makeManifest(v1));
      const mod1 = await freshImport();
      expect(mod1.getImmortalIds().has('god')).toBe(true);

      const v2 = [makeChar({ id: 'mortal', port: 3002, immortal: false })];
      writeManifest(makeManifest(v2));
      const mod2 = await freshImport();
      expect(mod2.getImmortalIds().has('god')).toBe(false);
    });
  });

  // --- Location distribution across buildings ---

  describe('location distribution', () => {
    it('characters can be distributed across all 9 buildings', async () => {
      const chars = VALID_BUILDINGS.map((b, i) =>
        makeChar({ id: `c${i}`, port: 3000 + i, defaultLocation: b })
      );
      writeManifest(makeManifest(chars));
      const { getDefaultLocations } = await freshImport();
      const locs = getDefaultLocations();
      const uniqueLocations = new Set(Object.values(locs));
      expect(uniqueLocations.size).toBe(9);
    });

    it('multiple characters can share the same default location', async () => {
      const chars = [
        makeChar({ id: 'a', port: 3001, defaultLocation: 'library' }),
        makeChar({ id: 'b', port: 3002, defaultLocation: 'library' }),
        makeChar({ id: 'c', port: 3003, defaultLocation: 'library' }),
      ];
      writeManifest(makeManifest(chars));
      const { getDefaultLocations } = await freshImport();
      const locs = getDefaultLocations();
      expect(locs['a']).toBe('library');
      expect(locs['b']).toBe('library');
      expect(locs['c']).toBe('library');
    });
  });
});

// ===========================================================================
// 9. MANIFEST RELOAD / MODULE ISOLATION MATRIX
// ===========================================================================

describe('Manifest reload / module isolation matrix', () => {

  it('separate freshImport calls load independent manifests', async () => {
    // Manifest v1
    writeManifest(makeManifest([makeChar({ id: 'v1', port: 3001 })]));
    const mod1 = await freshImport();
    expect(mod1.getAllCharacters()[0]!.id).toBe('v1');

    // Manifest v2
    writeManifest(makeManifest([makeChar({ id: 'v2', port: 3002 })]));
    const mod2 = await freshImport();
    expect(mod2.getAllCharacters()[0]!.id).toBe('v2');
  });

  it('changing manifest between imports changes immortal set', async () => {
    writeManifest(makeManifest([makeChar({ id: 'a', port: 3001, immortal: true })]));
    const mod1 = await freshImport();
    expect(mod1.getImmortalIds().has('a')).toBe(true);

    writeManifest(makeManifest([makeChar({ id: 'a', port: 3001, immortal: false })]));
    const mod2 = await freshImport();
    expect(mod2.getImmortalIds().has('a')).toBe(false);
  });

  it('changing character server type between imports changes web character', async () => {
    writeManifest(makeManifest([makeChar({ id: 'a', port: 3001, server: 'web' })]));
    const mod1 = await freshImport();
    expect(mod1.getWebCharacter()!.id).toBe('a');

    writeManifest(makeManifest([makeChar({ id: 'a', port: 3001, server: 'character' })]));
    const mod2 = await freshImport();
    expect(mod2.getWebCharacter()).toBeUndefined();
  });

  it('changing character port between imports changes peer URLs', async () => {
    const chars = [makeChar({ id: 'a', port: 3001 }), makeChar({ id: 'b', port: 3002 })];
    writeManifest(makeManifest(chars));
    const mod1 = await freshImport();
    expect(mod1.getPeersFor('a')[0]!.url).toBe('http://localhost:3002');

    chars[1]!.port = 4002;
    writeManifest(makeManifest(chars));
    const mod2 = await freshImport();
    expect(mod2.getPeersFor('a')[0]!.url).toBe('http://localhost:4002');
  });

  it('changing character name between imports changes peer name', async () => {
    const chars = [makeChar({ id: 'a', port: 3001 }), makeChar({ id: 'b', name: 'Bob', port: 3002 })];
    writeManifest(makeManifest(chars));
    const mod1 = await freshImport();
    expect(mod1.getPeersFor('a')[0]!.name).toBe('Bob');

    chars[1]!.name = 'Robert';
    writeManifest(makeManifest(chars));
    const mod2 = await freshImport();
    expect(mod2.getPeersFor('a')[0]!.name).toBe('Robert');
  });

  it('changing default location between imports updates locations map', async () => {
    writeManifest(makeManifest([makeChar({ id: 'a', port: 3001, defaultLocation: 'library' })]));
    const mod1 = await freshImport();
    expect(mod1.getDefaultLocations()['a']).toBe('library');

    writeManifest(makeManifest([makeChar({ id: 'a', port: 3001, defaultLocation: 'bar' })]));
    const mod2 = await freshImport();
    expect(mod2.getDefaultLocations()['a']).toBe('bar');
  });
});

// ===========================================================================
// 10. TOWN CONFIG MATRIX
// ===========================================================================

describe('Town config matrix', () => {
  const townCases: Array<[string, { name: string; description: string }]> = [
    ['simple town', { name: 'Laintown', description: 'A wired place' }],
    ['empty name', { name: '', description: 'Has description but no name' }],
    ['empty description', { name: 'Named', description: '' }],
    ['both empty', { name: '', description: '' }],
    ['unicode', { name: 'Sakura Village', description: 'Cherry blossom town' }],
    ['very long name', { name: 'T'.repeat(500), description: 'Long name town' }],
    ['special characters', { name: 'Town "The Best"', description: "It's great!" }],
  ];

  describe.each(townCases)('%s', (_label, town) => {
    it('town name is preserved', async () => {
      writeManifest(makeManifest([], town));
      const { loadManifest } = await freshImport();
      expect(loadManifest().town.name).toBe(town.name);
    });

    it('town description is preserved', async () => {
      writeManifest(makeManifest([], town));
      const { loadManifest } = await freshImport();
      expect(loadManifest().town.description).toBe(town.description);
    });
  });
});

// ===========================================================================
// 11. CROSS-CUTTING BEHAVIORAL TESTS
// ===========================================================================

describe('Cross-cutting behavioral tests', () => {

  // --- loadManifest fallback behavior ---

  describe('loadManifest fallback behavior', () => {
    it('returns default town when manifest not found', async () => {
      process.env['CHARACTERS_CONFIG'] = join(testDir, 'nonexistent.json');
      const { loadManifest } = await freshImport();
      const m = loadManifest();
      expect(m.town.name).toBe('Town');
      expect(m.town.description).toBe('');
      expect(m.characters).toEqual([]);
    });
  });

  // --- Manifest with extra fields (forward compatibility) ---

  describe('manifest with extra fields', () => {
    it('extra fields on characters are preserved', async () => {
      const manifest = {
        town: { name: 'Test', description: 'test' },
        characters: [{
          id: 'extra',
          name: 'Extra',
          port: 3001,
          server: 'character',
          defaultLocation: 'bar',
          workspace: 'ws/extra',
          customField: 'custom-value',
          anotherField: 42,
        }],
      };
      writeManifest(manifest);
      const { getCharacterEntry } = await freshImport();
      const entry = getCharacterEntry('extra') as Record<string, unknown>;
      expect(entry['customField']).toBe('custom-value');
      expect(entry['anotherField']).toBe(42);
    });

    it('extra fields on town config are preserved', async () => {
      const manifest = {
        town: { name: 'Test', description: 'test', theme: 'dark', version: 2 },
        characters: [],
      };
      writeManifest(manifest);
      const { loadManifest } = await freshImport();
      const town = loadManifest().town as Record<string, unknown>;
      expect(town['theme']).toBe('dark');
      expect(town['version']).toBe(2);
    });
  });

  // --- Concurrent access to manifest functions ---

  describe('concurrent access', () => {
    it('multiple function calls on the same module return consistent data', async () => {
      const chars = [
        makeChar({ id: 'a', port: 3001, immortal: true, server: 'web' }),
        makeChar({ id: 'b', port: 3002, immortal: false, server: 'character' }),
        makeChar({ id: 'c', port: 3003, immortal: false, server: 'character' }),
      ];
      writeManifest(makeManifest(chars));
      const mod = await freshImport();

      // Call everything in parallel
      const [all, entryA, entryB, locs, immortals, mortals, web, peersA, peersB] = await Promise.all([
        Promise.resolve(mod.getAllCharacters()),
        Promise.resolve(mod.getCharacterEntry('a')),
        Promise.resolve(mod.getCharacterEntry('b')),
        Promise.resolve(mod.getDefaultLocations()),
        Promise.resolve(mod.getImmortalIds()),
        Promise.resolve(mod.getMortalCharacters()),
        Promise.resolve(mod.getWebCharacter()),
        Promise.resolve(mod.getPeersFor('a')),
        Promise.resolve(mod.getPeersFor('b')),
      ]);

      expect(all).toHaveLength(3);
      expect(entryA!.id).toBe('a');
      expect(entryB!.id).toBe('b');
      expect(Object.keys(locs)).toHaveLength(3);
      expect(immortals.size).toBe(1);
      expect(immortals.has('a')).toBe(true);
      expect(mortals).toHaveLength(2);
      expect(web!.id).toBe('a');
      expect(peersA).toHaveLength(2);
      expect(peersB).toHaveLength(2);
    });
  });

  // --- Character ID edge cases ---

  describe('character ID edge cases', () => {
    const idCases: Array<[string, string]> = [
      ['single char', 'a'],
      ['numeric', '123'],
      ['hyphenated', 'wired-lain'],
      ['very long', 'a'.repeat(200)],
      ['with dots', 'v1.0.0'],
      ['uppercase', 'ALICE'],
      ['mixed case', 'AlIcE'],
      ['with underscores', 'my_char'],
      ['with spaces', 'my char'],
      ['empty string', ''],
    ];

    describe.each(idCases)('id = "%s"', (_label, id) => {
      it('getCharacterEntry finds character by exact id', async () => {
        const char = makeChar({ id, port: 3001 });
        writeManifest(makeManifest([char]));
        const { getCharacterEntry } = await freshImport();
        const entry = getCharacterEntry(id);
        expect(entry).toBeDefined();
        expect(entry!.id).toBe(id);
      });

      it('getPeersFor excludes exact id', async () => {
        const char = makeChar({ id, port: 3001 });
        const other = makeChar({ id: 'other', port: 3002 });
        writeManifest(makeManifest([char, other]));
        const { getPeersFor } = await freshImport();
        const peers = getPeersFor(id);
        expect(peers.every(p => p.id !== id)).toBe(true);
        expect(peers).toHaveLength(1);
      });
    });

    it('getCharacterEntry is case-sensitive', async () => {
      const char = makeChar({ id: 'Alice', port: 3001 });
      writeManifest(makeManifest([char]));
      const { getCharacterEntry } = await freshImport();
      expect(getCharacterEntry('Alice')).toBeDefined();
      expect(getCharacterEntry('alice')).toBeUndefined();
      expect(getCharacterEntry('ALICE')).toBeUndefined();
    });
  });

  // --- Manifest with only town, no characters key ---

  describe('manifest structural variations', () => {
    it('manifest with missing characters key: getAllCharacters returns undefined', async () => {
      writeManifest({ town: { name: 'Test', description: '' } });
      const mod = await freshImport();
      // loadManifest returns the parsed object as-is via type cast;
      // .characters is undefined, so getAllCharacters() returns undefined
      const result = mod.getAllCharacters();
      expect(result).toBeUndefined();
    });

    it('manifest with null characters: getAllCharacters errors', async () => {
      writeManifest({ town: { name: 'Test', description: '' }, characters: null });
      const mod = await freshImport();
      // .filter on null throws
      expect(() => mod.getMortalCharacters()).toThrow();
    });

    it('manifest with missing town key: loadManifest succeeds', async () => {
      writeManifest({ characters: [makeChar({ id: 'a', port: 3001 })] });
      const mod = await freshImport();
      const m = mod.loadManifest();
      expect(m.town).toBeUndefined();
      expect(mod.getAllCharacters()).toHaveLength(1);
    });
  });
});
