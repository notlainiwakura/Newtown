# Manifest-Authoritative Characters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `characters.json` the single source of truth for character enumeration, replacing 8 hardcoded character arrays scattered across `src/`. Fix three drift bugs exposed by the refactor (Hiru missing from experiments + town events; Dr. Claude's exclusions scattered).

**Architecture:** Extend `CharacterManifestEntry` with three optional fields (`role`, `systemdUnit`, `homeDir`) that fall back to conventions. Add purpose-specific accessors in `src/config/characters.ts` (`getInhabitants`, `getHealthCheckTargets`, etc.). Each hardcoded array in `src/` becomes a one-line call to an accessor. Backward-compatible: code ships before manifest edits since all new fields default.

**Tech Stack:** TypeScript (strict), Node.js 20+, vitest, ESM modules. Project root: `/Users/apopo0308/IdeaProjects/lain`.

**Spec:** `docs/superpowers/specs/2026-04-18-manifest-authoritative-characters-design.md`

---

## File Structure

**Modified files:**
- `src/config/characters.ts` — extend type, add ~8 new exported functions
- `src/agent/doctor.ts` — replace `TELEMETRY_SERVICES` and `HEALTH_CHECK_SERVICES`
- `src/agent/experiments.ts` — replace `TOWN_DBS` and `SHARE_PEERS`
- `src/web/server.ts` — replace inline `DREAM_PEERS` array
- `src/events/town-events.ts` — replace `INHABITANT_PORTS`
- `src/agent/dream-seeder.ts` — replace default `peers` array
- `src/agent/dossier.ts` — replace `DOSSIER_SUBJECTS`
- `test/config.test.ts` — add describe blocks for new accessors

**New files:**
- `test/fixtures/manifest-production.json` — canary fixture representing production manifest shape

**Untouched files (explicitly out of scope):**
- `src/web/public/*.html` — frontend lists; separate concern
- `deploy/healthcheck.sh` — bash script; separate concern
- `src/web/server.ts` beyond `DREAM_PEERS` — no broader server refactor

---

## Task 1: Extend manifest schema and add field-resolver accessors

**Why:** `systemdUnit` and `homeDir` currently follow conventions with exceptions (lain → `lain-main`, lain's home is `/root/.lain` not `/root/.lain-lain`). The manifest needs to carry these as optional overrides.

**Files:**
- Modify: `src/config/characters.ts`
- Test: `test/config.test.ts`

- [ ] **Step 1.1: Write failing tests for `getSystemdUnit` and `getHomeDir`**

Append to `test/config.test.ts` (after the existing `describe('Configuration', ...)` block, before closing the file):

```typescript
import {
  loadManifest,
  getAllCharacters,
  getSystemdUnit,
  getHomeDir,
} from '../src/config/characters.js';

describe('Character manifest — field resolvers', () => {
  const originalEnv = process.env['CHARACTERS_CONFIG'];
  const fixtureDir = join(tmpdir(), 'lain-test-manifest');
  const fixturePath = join(fixtureDir, 'characters.json');

  beforeEach(async () => {
    await mkdir(fixtureDir, { recursive: true });
    process.env['CHARACTERS_CONFIG'] = fixturePath;
  });

  afterEach(async () => {
    if (originalEnv) process.env['CHARACTERS_CONFIG'] = originalEnv;
    else delete process.env['CHARACTERS_CONFIG'];
    try { await rm(fixtureDir, { recursive: true }); } catch {}
    // Force re-load
    // @ts-expect-error — intentionally poking the internal cache
    (await import('../src/config/characters.js'))._resetManifestCache?.();
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
});
```

- [ ] **Step 1.2: Run tests and verify they fail**

Run: `npx vitest run test/config.test.ts`
Expected: 4 failures — `getSystemdUnit is not a function`, `getHomeDir is not a function`, plus cache-reset hook missing.

- [ ] **Step 1.3: Implement the schema extension and accessors**

Replace the entire contents of `src/config/characters.ts` with:

```typescript
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface CharacterManifestEntry {
  id: string;
  name: string;
  port: number;
  server: 'web' | 'character';
  defaultLocation: string;
  immortal?: boolean;
  possessable?: boolean;
  workspace: string;
  role?: 'inhabitant' | 'oracle';
  systemdUnit?: string;
  homeDir?: string;
}

export interface TownConfig {
  name: string;
  description: string;
}

export interface CharacterManifest {
  town: TownConfig;
  characters: CharacterManifestEntry[];
}

let _manifest: CharacterManifest | null = null;

/** Test-only: clear the module-level manifest cache so tests can reload fixtures. */
export function _resetManifestCache(): void {
  _manifest = null;
}

function findManifestPath(): string | null {
  const candidates = [
    process.env['CHARACTERS_CONFIG'],
    join(process.cwd(), 'characters.json'),
    join(process.cwd(), 'characters.json5'),
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

export function loadManifest(): CharacterManifest {
  if (_manifest) return _manifest;

  const path = findManifestPath();
  if (!path) {
    return { town: { name: 'Town', description: '' }, characters: [] };
  }

  const raw = readFileSync(path, 'utf-8');
  _manifest = JSON.parse(raw) as CharacterManifest;
  return _manifest;
}

export function getCharacterEntry(id: string): CharacterManifestEntry | undefined {
  return loadManifest().characters.find(c => c.id === id);
}

export function getAllCharacters(): CharacterManifestEntry[] {
  return loadManifest().characters;
}

export function getDefaultLocations(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const c of loadManifest().characters) {
    result[c.id] = c.defaultLocation;
  }
  return result;
}

export function getImmortalIds(): Set<string> {
  return new Set(
    loadManifest().characters.filter(c => c.immortal).map(c => c.id)
  );
}

export function getMortalCharacters(): CharacterManifestEntry[] {
  return loadManifest().characters.filter(c => !c.immortal);
}

export function getWebCharacter(): CharacterManifestEntry | undefined {
  return loadManifest().characters.find(c => c.server === 'web');
}

export function getPeersFor(characterId: string): Array<{ id: string; name: string; url: string }> {
  return loadManifest().characters
    .filter(c => c.id !== characterId)
    .map(c => ({ id: c.id, name: c.name, url: `http://localhost:${c.port}` }));
}

/**
 * Resolve the systemd unit name for a character.
 * Uses manifest override when present; otherwise falls back to `lain-${id}`.
 */
export function getSystemdUnit(id: string): string {
  const entry = getCharacterEntry(id);
  return entry?.systemdUnit ?? `lain-${id}`;
}

/**
 * Resolve the production home directory for a character.
 * Uses manifest override when present; otherwise falls back to `/root/.lain-${id}`.
 */
export function getHomeDir(id: string): string {
  const entry = getCharacterEntry(id);
  return entry?.homeDir ?? `/root/.lain-${id}`;
}
```

- [ ] **Step 1.4: Run tests and verify they pass**

Run: `npx vitest run test/config.test.ts`
Expected: all pass, including the 4 new tests.

- [ ] **Step 1.5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 1.6: Commit**

```bash
git add src/config/characters.ts test/config.test.ts
git commit -m "feat(config): add role, systemdUnit, homeDir to manifest schema

Extends CharacterManifestEntry with three optional fields plus
getSystemdUnit/getHomeDir resolvers that fall back to conventions.
Step 1 of making characters.json the authoritative source."
```

---

## Task 2: Add role-filtering accessors

**Why:** Dr. Claude is currently excluded from six different arrays by hardcoded omission. A `role: 'oracle'` marker in the manifest lets us express this once.

**Files:**
- Modify: `src/config/characters.ts`
- Test: `test/config.test.ts`

- [ ] **Step 2.1: Write failing tests**

Append to the same `describe('Character manifest — field resolvers', ...)` block in `test/config.test.ts`:

```typescript
  it('getInhabitants excludes entries with role=oracle', async () => {
    const { getInhabitants } = await import('../src/config/characters.js');
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
    const { getInhabitants } = await import('../src/config/characters.js');
    await writeFile(fixturePath, JSON.stringify({
      town: { name: 'T', description: '' },
      characters: [
        { id: 'lain', name: 'Lain', port: 3001, server: 'character', defaultLocation: 'home', workspace: 'w' },
      ],
    }));
    expect(getInhabitants().map(c => c.id)).toEqual(['lain']);
  });

  it('getOracles returns only entries with role=oracle', async () => {
    const { getOracles } = await import('../src/config/characters.js');
    await writeFile(fixturePath, JSON.stringify({
      town: { name: 'T', description: '' },
      characters: [
        { id: 'lain', name: 'Lain', port: 3001, server: 'character', defaultLocation: 'home', workspace: 'w' },
        { id: 'dr-claude', name: 'Dr. Claude', port: 3002, server: 'character', defaultLocation: 'clinic', workspace: 'w', role: 'oracle' },
      ],
    }));
    expect(getOracles().map(c => c.id)).toEqual(['dr-claude']);
  });
```

- [ ] **Step 2.2: Run and verify failure**

Run: `npx vitest run test/config.test.ts`
Expected: 3 new failures — `getInhabitants` / `getOracles` not exported.

- [ ] **Step 2.3: Add the two functions**

Append to `src/config/characters.ts` (after `getHomeDir`):

```typescript
/**
 * Returns all characters that are "inhabitants" of the town — i.e. NOT oracles.
 * Characters with no explicit role are treated as inhabitants (default).
 * Use for: telemetry aggregation, share-peers, town-event notifications.
 */
export function getInhabitants(): CharacterManifestEntry[] {
  return loadManifest().characters.filter(c => (c.role ?? 'inhabitant') === 'inhabitant');
}

/**
 * Returns characters with role='oracle' — observers/monitors who participate
 * in the town but are not themselves inhabitants (e.g. Dr. Claude).
 */
export function getOracles(): CharacterManifestEntry[] {
  return loadManifest().characters.filter(c => c.role === 'oracle');
}
```

- [ ] **Step 2.4: Run and verify pass**

Run: `npx vitest run test/config.test.ts`
Expected: all pass.

- [ ] **Step 2.5: Commit**

```bash
git add src/config/characters.ts test/config.test.ts
git commit -m "feat(config): add getInhabitants/getOracles role accessors

Centralizes the 'everyone except oracles' filter that was previously
expressed via hardcoded omission in six different arrays."
```

---

## Task 3: Add purpose-specific helpers

**Why:** Each hardcoded array has specific semantics (everyone, all-except-writer, all-with-homedir). Expressing them once in `characters.ts` means call sites become one-liners.

**Files:**
- Modify: `src/config/characters.ts`
- Test: `test/config.test.ts`

- [ ] **Step 3.1: Write failing tests**

Append to the `Character manifest — field resolvers` describe block:

```typescript
  it('getHealthCheckTargets returns all characters (inhabitants AND oracles)', async () => {
    const { getHealthCheckTargets } = await import('../src/config/characters.js');
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
    const { getDossierSubjects } = await import('../src/config/characters.js');
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
    const { getDreamSeedTargets } = await import('../src/config/characters.js');
    await writeFile(fixturePath, JSON.stringify({
      town: { name: 'T', description: '' },
      characters: [
        { id: 'a', name: 'A', port: 3001, server: 'character', defaultLocation: 'home', workspace: 'w' },
        { id: 'b', name: 'B', port: 3002, server: 'character', defaultLocation: 'home', workspace: 'w', role: 'oracle' },
      ],
    }));
    expect(getDreamSeedTargets().map(c => c.id)).toEqual(['a', 'b']);
  });

  it('getCharacterDatabases returns id+homeDir for every character', async () => {
    const { getCharacterDatabases } = await import('../src/config/characters.js');
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
```

- [ ] **Step 3.2: Run and verify failure**

Run: `npx vitest run test/config.test.ts`
Expected: 4 new failures.

- [ ] **Step 3.3: Implement the helpers**

Append to `src/config/characters.ts`:

```typescript
/**
 * Returns all characters eligible for HTTP health-checks. Includes oracles —
 * they are runnable services that can go down.
 */
export function getHealthCheckTargets(): CharacterManifestEntry[] {
  return loadManifest().characters;
}

/**
 * Returns the characters a dossier-writer composes dossiers about —
 * everyone except the writer themselves.
 */
export function getDossierSubjects(writerId: string): CharacterManifestEntry[] {
  return loadManifest().characters.filter(c => c.id !== writerId);
}

/**
 * Returns all characters that can receive seeded dreams.
 */
export function getDreamSeedTargets(): CharacterManifestEntry[] {
  return loadManifest().characters;
}

/**
 * Returns {id, homeDir} for every character, with homeDir resolved via getHomeDir.
 * Used by experiments to snapshot each character's SQLite DB into a sandbox.
 */
export function getCharacterDatabases(): Array<{ id: string; homeDir: string }> {
  return loadManifest().characters.map(c => ({
    id: c.id,
    homeDir: c.homeDir ?? `/root/.lain-${c.id}`,
  }));
}
```

- [ ] **Step 3.4: Run and verify pass**

Run: `npx vitest run test/config.test.ts`
Expected: all pass.

- [ ] **Step 3.5: Commit**

```bash
git add src/config/characters.ts test/config.test.ts
git commit -m "feat(config): add purpose-specific character accessors

Adds getHealthCheckTargets, getDossierSubjects, getDreamSeedTargets,
getCharacterDatabases so call sites can be one-liners instead of
maintaining their own hardcoded character arrays."
```

---

## Task 4: Add production-shape canary fixture + snapshot test

**Why:** Protects against accidental edits to the production manifest silently changing what each helper returns.

**Files:**
- Create: `test/fixtures/manifest-production.json`
- Create: `test/manifest-snapshot.test.ts`

- [ ] **Step 4.1: Create the production-shape fixture**

Create `test/fixtures/manifest-production.json` with the exact shape the droplet will have after deployment (includes the three overrides from §Deployment of the spec):

```json
{
  "town": {
    "name": "Laintown",
    "description": "An autonomous AI town"
  },
  "characters": [
    {
      "id": "wired-lain",
      "name": "Wired Lain",
      "port": 3000,
      "server": "web",
      "defaultLocation": "wired",
      "immortal": true,
      "possessable": false,
      "workspace": "workspace/characters/wired-lain",
      "systemdUnit": "lain-wired",
      "homeDir": "/root/.lain-wired"
    },
    {
      "id": "lain",
      "name": "Lain",
      "port": 3001,
      "server": "character",
      "defaultLocation": "home",
      "immortal": true,
      "possessable": false,
      "workspace": "workspace/characters/lain",
      "systemdUnit": "lain-main",
      "homeDir": "/root/.lain"
    },
    {
      "id": "dr-claude",
      "name": "Dr. Claude",
      "port": 3002,
      "server": "character",
      "defaultLocation": "clinic",
      "possessable": false,
      "workspace": "workspace/characters/dr-claude",
      "role": "oracle"
    },
    {
      "id": "pkd",
      "name": "Philip K. Dick",
      "port": 3003,
      "server": "character",
      "defaultLocation": "bar",
      "possessable": false,
      "workspace": "workspace/characters/pkd"
    },
    {
      "id": "mckenna",
      "name": "Terence McKenna",
      "port": 3004,
      "server": "character",
      "defaultLocation": "greenhouse",
      "possessable": false,
      "workspace": "workspace/characters/mckenna"
    },
    {
      "id": "john",
      "name": "John",
      "port": 3005,
      "server": "character",
      "defaultLocation": "diner",
      "possessable": false,
      "workspace": "workspace/characters/john"
    },
    {
      "id": "hiru",
      "name": "Hiru",
      "port": 3006,
      "server": "character",
      "defaultLocation": "park",
      "possessable": false,
      "workspace": "workspace/characters/hiru"
    }
  ]
}
```

Note: `defaultLocation` values above are placeholders. The actual production manifest on the droplet is the ground truth for location strings. If you have SSH access, run `ssh root@198.211.116.5 "cat /opt/local-lain/characters.json"` and update the fixture to match real `defaultLocation`/`workspace` values before running the snapshot test.

- [ ] **Step 4.2: Write the snapshot test**

Create `test/manifest-snapshot.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import {
  _resetManifestCache,
  getInhabitants,
  getOracles,
  getHealthCheckTargets,
  getDossierSubjects,
  getDreamSeedTargets,
  getCharacterDatabases,
  getSystemdUnit,
  getHomeDir,
} from '../src/config/characters.js';

describe('Manifest snapshot — production shape canary', () => {
  const fixturePath = join(process.cwd(), 'test', 'fixtures', 'manifest-production.json');
  const originalEnv = process.env['CHARACTERS_CONFIG'];

  beforeEach(() => {
    process.env['CHARACTERS_CONFIG'] = fixturePath;
    _resetManifestCache();
  });

  afterEach(() => {
    if (originalEnv) process.env['CHARACTERS_CONFIG'] = originalEnv;
    else delete process.env['CHARACTERS_CONFIG'];
    _resetManifestCache();
  });

  it('getInhabitants returns the 6 non-oracle characters', () => {
    expect(getInhabitants().map(c => c.id)).toEqual([
      'wired-lain', 'lain', 'pkd', 'mckenna', 'john', 'hiru',
    ]);
  });

  it('getOracles returns Dr. Claude only', () => {
    expect(getOracles().map(c => c.id)).toEqual(['dr-claude']);
  });

  it('getHealthCheckTargets returns all 7 characters', () => {
    expect(getHealthCheckTargets().map(c => c.id)).toEqual([
      'wired-lain', 'lain', 'dr-claude', 'pkd', 'mckenna', 'john', 'hiru',
    ]);
  });

  it('getDossierSubjects("wired-lain") returns 6 characters', () => {
    expect(getDossierSubjects('wired-lain').map(c => c.id)).toEqual([
      'lain', 'dr-claude', 'pkd', 'mckenna', 'john', 'hiru',
    ]);
  });

  it('getDreamSeedTargets returns all 7 characters', () => {
    expect(getDreamSeedTargets().map(c => c.id)).toEqual([
      'wired-lain', 'lain', 'dr-claude', 'pkd', 'mckenna', 'john', 'hiru',
    ]);
  });

  it('getCharacterDatabases returns id+homeDir for all 7', () => {
    expect(getCharacterDatabases()).toEqual([
      { id: 'wired-lain', homeDir: '/root/.lain-wired' },
      { id: 'lain', homeDir: '/root/.lain' },
      { id: 'dr-claude', homeDir: '/root/.lain-dr-claude' },
      { id: 'pkd', homeDir: '/root/.lain-pkd' },
      { id: 'mckenna', homeDir: '/root/.lain-mckenna' },
      { id: 'john', homeDir: '/root/.lain-john' },
      { id: 'hiru', homeDir: '/root/.lain-hiru' },
    ]);
  });

  it('getSystemdUnit resolves overrides then convention', () => {
    expect(getSystemdUnit('lain')).toBe('lain-main');
    expect(getSystemdUnit('wired-lain')).toBe('lain-wired');
    expect(getSystemdUnit('pkd')).toBe('lain-pkd');
    expect(getSystemdUnit('dr-claude')).toBe('lain-dr-claude');
  });

  it('getHomeDir resolves overrides then convention', () => {
    expect(getHomeDir('lain')).toBe('/root/.lain');
    expect(getHomeDir('wired-lain')).toBe('/root/.lain-wired');
    expect(getHomeDir('pkd')).toBe('/root/.lain-pkd');
    expect(getHomeDir('hiru')).toBe('/root/.lain-hiru');
  });
});
```

Note: the fixture represents the *post-deployment* production shape — it includes the three overrides that Task 12.5 will add to the real manifest on the droplet. The snapshot test verifies the accessors return what we expect *once the manifest has been updated*. Before Task 12 runs, the droplet's manifest won't carry these overrides, but the default fallbacks in the accessors keep behavior correct until then.

- [ ] **Step 4.3: Run the snapshot test**

Run: `npx vitest run test/manifest-snapshot.test.ts`
Expected: all pass.

- [ ] **Step 4.4: Commit**

```bash
git add test/fixtures/manifest-production.json test/manifest-snapshot.test.ts
git commit -m "test(config): add production-shape manifest canary

Snapshot test against a committed fixture that mirrors the production
manifest shape. Future edits to characters.json can't silently change
the output of any character-enumerating helper."
```

---

## Task 5: Refactor `doctor.ts` (TELEMETRY_SERVICES + HEALTH_CHECK_SERVICES)

**Why:** These two arrays are the originally-flagged legacy leak. Telemetry currently excludes Dr. Claude via hardcoded omission; after refactor, `getInhabitants()` expresses that via `role: 'oracle'`.

**Files:**
- Modify: `src/agent/doctor.ts:607-698`

- [ ] **Step 5.1: Replace TELEMETRY_SERVICES with manifest call**

In `src/agent/doctor.ts`, locate lines 607-614:

```typescript
const TELEMETRY_SERVICES = [
  { name: 'Wired Lain', port: 3000 },
  { name: 'Lain', port: 3001 },
  { name: 'PKD', port: 3003 },
  { name: 'McKenna', port: 3004 },
  { name: 'John', port: 3005 },
  { name: 'Hiru', port: 3006 },
];
```

Delete that block. Ensure the import block near the top of the file imports `getInhabitants` and `getHealthCheckTargets`:

```typescript
import { getInhabitants, getHealthCheckTargets, getSystemdUnit } from '../config/characters.js';
```

In the `fetchAllCharacterTelemetry` function (around line 616), replace the loop header from:

```typescript
for (const svc of TELEMETRY_SERVICES) {
```

to:

```typescript
for (const svc of getInhabitants()) {
```

Because `svc` was `{ name, port }` before but `getInhabitants()` yields `CharacterManifestEntry` (which has `name` and `port`), the loop body should compile as-is. Verify by reading the existing body: only `svc.port` and `svc.name` are used.

- [ ] **Step 5.2: Replace HEALTH_CHECK_SERVICES**

Delete lines 690-698 (the `HEALTH_CHECK_SERVICES` const). In `runHealthCheckCycle` (around line 711), replace the loop header:

```typescript
for (const svc of HEALTH_CHECK_SERVICES) {
```

with:

```typescript
for (const svc of getHealthCheckTargets()) {
```

The loop body uses `svc.port` and `svc.name`; both exist on `CharacterManifestEntry`. The `systemdUnit` field was unused by this function — no change needed to the body.

- [ ] **Step 5.3: Typecheck**

Run: `npm run typecheck`
Expected: no errors. If errors mention missing `systemdUnit`, grep `doctor.ts` for any remaining `.systemdUnit` accesses and replace with `getSystemdUnit(svc.id)`.

- [ ] **Step 5.4: Run tests**

Run: `npx vitest run`
Expected: no regressions. `doctor-system.test.ts` exercises this module.

- [ ] **Step 5.5: Commit**

```bash
git add src/agent/doctor.ts
git commit -m "refactor(doctor): read from manifest instead of hardcoded arrays

Replaces TELEMETRY_SERVICES and HEALTH_CHECK_SERVICES with
getInhabitants() and getHealthCheckTargets() from the manifest.
Behavior preserved: telemetry still excludes Dr. Claude (now via
role='oracle'); health-check still hits all 7 services."
```

---

## Task 6: Refactor `src/web/server.ts` (DREAM_PEERS)

**Why:** Even `server.ts` has its own hardcoded character list — ironic given it's the web server for the app whose config module provides exactly this data.

**Files:**
- Modify: `src/web/server.ts:1099-1107`

- [ ] **Step 6.1: Replace the inline array**

In `src/web/server.ts`, around line 1098-1107, find:

```typescript
    // Character definitions for dream aggregation
    const DREAM_PEERS: Array<{ id: string; name: string; port: number }> = [
      { id: 'wired-lain', name: 'Wired Lain', port: 3000 },
      { id: 'lain', name: 'Lain', port: 3001 },
      { id: 'dr-claude', name: 'Dr. Claude', port: 3002 },
      { id: 'pkd', name: 'PKD', port: 3003 },
      { id: 'mckenna', name: 'McKenna', port: 3004 },
      { id: 'john', name: 'John', port: 3005 },
      { id: 'hiru', name: 'Hiru', port: 3006 },
    ];
```

Replace with:

```typescript
    // Character definitions for dream aggregation — from the manifest
    const DREAM_PEERS = getHealthCheckTargets();
```

Add the import near the top of `server.ts` (look for the existing `from '../config/characters.js'` import and extend it; if none exists for this module, add):

```typescript
import { getHealthCheckTargets } from '../config/characters.js';
```

The downstream code uses `DREAM_PEERS.map(...)` with `peer.id`, `peer.name`, `peer.port` — all three exist on `CharacterManifestEntry`, so the body compiles unchanged.

- [ ] **Step 6.2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6.3: Run tests**

Run: `npx vitest run`
Expected: no regressions.

- [ ] **Step 6.4: Commit**

```bash
git add src/web/server.ts
git commit -m "refactor(server): read DREAM_PEERS from manifest

Eliminates the inline character array in the dreams aggregation
endpoint. Behavior preserved: same 7 characters in the same order
as the manifest."
```

---

## Task 7: Refactor `dream-seeder.ts`

**Files:**
- Modify: `src/agent/dream-seeder.ts:34-47`

- [ ] **Step 7.1: Replace the peers default**

In `src/agent/dream-seeder.ts`, around lines 34-47, find:

```typescript
const DEFAULT_CONFIG: SeederConfig = {
  checkIntervalMs: 12 * 60 * 60 * 1000, // 12 hours
  minPendingThreshold: 50,
  batchSize: 30,
  peers: [
    { id: 'wired-lain', name: 'Wired Lain', port: 3000 },
    { id: 'lain', name: 'Lain', port: 3001 },
    { id: 'dr-claude', name: 'Dr. Claude', port: 3002 },
    { id: 'pkd', name: 'PKD', port: 3003 },
    { id: 'mckenna', name: 'McKenna', port: 3004 },
    { id: 'john', name: 'John', port: 3005 },
    { id: 'hiru', name: 'Hiru', port: 3006 },
  ],
};
```

Replace with:

```typescript
const DEFAULT_CONFIG: SeederConfig = {
  checkIntervalMs: 12 * 60 * 60 * 1000, // 12 hours
  minPendingThreshold: 50,
  batchSize: 30,
  peers: getDreamSeedTargets().map(c => ({ id: c.id, name: c.name, port: c.port })),
};
```

Add to imports:

```typescript
import { getDreamSeedTargets } from '../config/characters.js';
```

- [ ] **Step 7.2: Typecheck and test**

Run: `npm run typecheck && npx vitest run`
Expected: no errors, no regressions.

- [ ] **Step 7.3: Commit**

```bash
git add src/agent/dream-seeder.ts
git commit -m "refactor(dream-seeder): read peers from manifest

Behavior preserved: same 7 characters seeded with dreams."
```

---

## Task 8: Refactor `dossier.ts`

**Files:**
- Modify: `src/agent/dossier.ts:30-37`

- [ ] **Step 8.1: Replace DOSSIER_SUBJECTS**

In `src/agent/dossier.ts`, around lines 29-37, find:

```typescript
/** Characters Wired Lain maintains dossiers for */
const DOSSIER_SUBJECTS = [
  { id: 'lain', name: 'Lain', port: 3001 },
  { id: 'dr-claude', name: 'Dr. Claude', port: 3002 },
  { id: 'pkd', name: 'Philip K. Dick', port: 3003 },
  { id: 'mckenna', name: 'Terence McKenna', port: 3004 },
  { id: 'john', name: 'John', port: 3005 },
  { id: 'hiru', name: 'Hiru', port: 3006 },
];
```

Replace with:

```typescript
import { getDossierSubjects } from '../config/characters.js';

/** Characters Wired Lain maintains dossiers for — everyone except herself. */
const DOSSIER_SUBJECTS = getDossierSubjects('wired-lain').map(c => ({
  id: c.id,
  name: c.name,
  port: c.port,
}));
```

(Move the `import` to the top with other imports; the inline form above just shows intent.)

- [ ] **Step 8.2: Typecheck and test**

Run: `npm run typecheck && npx vitest run`
Expected: no errors, no regressions.

- [ ] **Step 8.3: Commit**

```bash
git add src/agent/dossier.ts
git commit -m "refactor(dossier): read DOSSIER_SUBJECTS from manifest

Behavior preserved: Wired Lain still writes dossiers about the same
6 characters (everyone except herself)."
```

---

## Task 9: Refactor `experiments.ts` (TOWN_DBS + SHARE_PEERS)

**Why:** These two are where the Hiru drift bug lives. After refactor, Hiru is in both.

**Files:**
- Modify: `src/agent/experiments.ts:1097-1114` and `:1393-1398`

- [ ] **Step 9.1: Write a test that locks in Hiru inclusion**

Append to `test/manifest-snapshot.test.ts` inside the existing describe block:

```typescript
  it('drift fix — experiment DBs include Hiru', () => {
    const ids = getCharacterDatabases().map(c => c.id);
    expect(ids).toContain('hiru');
  });

  it('drift fix — experiment share-peers include Hiru', () => {
    const inhabitants = getInhabitants().filter(c => c.id !== 'wired-lain');
    const ids = inhabitants.map(c => c.id);
    expect(ids).toContain('hiru');
    expect(ids).not.toContain('wired-lain');
    expect(ids).not.toContain('dr-claude'); // oracle excluded
  });
```

Run: `npx vitest run test/manifest-snapshot.test.ts`
Expected: PASS (already satisfied by the fixture).

- [ ] **Step 9.2: Replace TOWN_DBS**

In `src/agent/experiments.ts`, around lines 1097-1105, find:

```typescript
  // Copy all town inhabitant databases into sandbox/data/ as read-only snapshots
  const TOWN_DBS: Array<{ id: string; homeDir: string }> = [
    { id: 'lain', homeDir: '/root/.lain' },
    { id: 'wired-lain', homeDir: '/root/.lain-wired' },
    { id: 'pkd', homeDir: '/root/.lain-pkd' },
    { id: 'mckenna', homeDir: '/root/.lain-mckenna' },
    { id: 'john', homeDir: '/root/.lain-john' },
    { id: 'dr-claude', homeDir: '/root/.lain-dr-claude' },
  ];
```

Replace with:

```typescript
  // Copy all town inhabitant databases into sandbox/data/ as read-only snapshots
  const TOWN_DBS = getCharacterDatabases();
```

Add to imports at the top of `experiments.ts`:

```typescript
import { getCharacterDatabases, getInhabitants } from '../config/characters.js';
```

- [ ] **Step 9.3: Replace SHARE_PEERS (preserve "Lain first" invariant explicitly)**

In `src/agent/experiments.ts` around lines 1393-1398, find:

```typescript
const SHARE_PEERS = [
  { id: 'lain', name: 'Lain', url: 'http://localhost:3001' },       // Sister
  { id: 'pkd', name: 'Philip K. Dick', url: 'http://localhost:3003' },
  { id: 'mckenna', name: 'Terence McKenna', url: 'http://localhost:3004' },
  { id: 'john', name: 'John', url: 'http://localhost:3005' },
];
```

Delete that constant. Then, in `shareWithPeers` (around line 1404-1415), the original code is:

```typescript
async function shareWithPeers(result: ExperimentResult): Promise<void> {
  const logger = getLogger();
  const hasOutput = result.stdout.trim().length > 0;
  const success = result.exitCode === 0 && !result.timedOut && hasOutput;

  // Always share with Lain
  const targets = [SHARE_PEERS[0]!];

  // Pick one random non-Lain peer
  const others = SHARE_PEERS.slice(1);
  const randomPeer = others[Math.floor(Math.random() * others.length)]!;
  targets.push(randomPeer);
```

Replace those lines (through the `targets.push(randomPeer)` line) with:

```typescript
async function shareWithPeers(result: ExperimentResult): Promise<void> {
  const logger = getLogger();
  const hasOutput = result.stdout.trim().length > 0;
  const success = result.exitCode === 0 && !result.timedOut && hasOutput;

  // Compute share candidates from the manifest: inhabitants except Wired Lain (self).
  const inhabitants = getInhabitants().filter(c => c.id !== 'wired-lain');
  const lain = inhabitants.find(c => c.id === 'lain');
  const others = inhabitants.filter(c => c.id !== 'lain');

  if (!lain || others.length === 0) {
    logger.debug('Skipping experiment share: Lain or peers missing from manifest');
    return;
  }

  const toPeer = (c: { id: string; name: string; port: number }) => ({
    id: c.id, name: c.name, url: `http://localhost:${c.port}`,
  });

  // Always share with Lain (sister), plus one random other inhabitant.
  const randomOther = others[Math.floor(Math.random() * others.length)]!;
  const targets = [toPeer(lain), toPeer(randomOther)];
```

The rest of the function (the `for (const peer of targets)` loop through the fetch call) remains unchanged.

- [ ] **Step 9.4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 9.5: Run tests**

Run: `npx vitest run`
Expected: no regressions.

- [ ] **Step 9.6: Commit**

```bash
git add src/agent/experiments.ts test/manifest-snapshot.test.ts
git commit -m "refactor(experiments): read DB list and share-peers from manifest

Replaces TOWN_DBS and SHARE_PEERS with getCharacterDatabases and
getInhabitants respectively. Fixes drift: Hiru's DB is now snapshotted
into experiment sandboxes, and Hiru now receives experiment result
messages — both were accidentally dropped when Hiru was added to the
manifest but not to these hardcoded arrays."
```

---

## Task 10: Refactor `events/town-events.ts`

**Why:** The town-events notification list was missing both Hiru and Dr. Claude. After refactor, `getInhabitants()` returns all non-oracles, so Hiru is included and Dr. Claude is correctly excluded (via `role: 'oracle'`).

**Files:**
- Modify: `src/events/town-events.ts:151-157` and `:177`

- [ ] **Step 10.1: Write a test that locks in the new behavior**

Append to `test/manifest-snapshot.test.ts`:

```typescript
  it('drift fix — town-events notifies Hiru, skips Dr. Claude (oracle)', () => {
    const ids = getInhabitants().map(c => c.id);
    expect(ids).toContain('hiru');
    expect(ids).not.toContain('dr-claude');
  });
```

Run: `npx vitest run test/manifest-snapshot.test.ts`
Expected: PASS.

- [ ] **Step 10.2: Replace INHABITANT_PORTS**

In `src/events/town-events.ts` around lines 151-157:

```typescript
const INHABITANT_PORTS = [
  { id: 'lain', name: 'Lain', port: 3001 },
  { id: 'wired-lain', name: 'Wired Lain', port: 3000 },
  { id: 'pkd', name: 'Philip K. Dick', port: 3003 },
  { id: 'mckenna', name: 'Terence McKenna', port: 3004 },
  { id: 'john', name: 'John', port: 3005 },
];
```

Delete it. Then in `notifyInhabitants` (around line 164-193), find the loop:

```typescript
  for (const inhabitant of INHABITANT_PORTS) {
```

Replace with:

```typescript
  for (const inhabitant of getInhabitants()) {
```

Add at the top of the file:

```typescript
import { getInhabitants } from '../config/characters.js';
```

The loop body uses `inhabitant.port` and `inhabitant.id`; both present on `CharacterManifestEntry`.

- [ ] **Step 10.3: Typecheck and test**

Run: `npm run typecheck && npx vitest run`
Expected: no errors, no regressions.

- [ ] **Step 10.4: Commit**

```bash
git add src/events/town-events.ts test/manifest-snapshot.test.ts
git commit -m "refactor(town-events): notify inhabitants from manifest

Replaces INHABITANT_PORTS hardcode with getInhabitants(). Fixes drift:
Hiru now receives town-event notifications (she was missing). Dr.
Claude is correctly excluded via role='oracle'."
```

---

## Task 11: Full verification pass

- [ ] **Step 11.1: Run the complete test suite**

Run: `npx vitest run`
Expected: all tests pass, zero failures.

- [ ] **Step 11.2: Run lint**

Run: `npm run lint`
Expected: no new warnings.

- [ ] **Step 11.3: Run typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 11.4: Grep for residual hardcoded character arrays**

Run these greps to confirm no backend call sites still carry hardcoded lists:

```bash
# Should return no matches (only comments/prose should reference these now):
grep -rn "port:\s*3003" src/ --include='*.ts' | grep -v '//' | grep -v 'test'
grep -rn "'lain', name: 'Lain'" src/ --include='*.ts'
grep -rn "'pkd', name:" src/ --include='*.ts'
```

If any backend TS file still has a hardcoded character list, note it in the commit message as out-of-scope and document in a follow-up issue.

- [ ] **Step 11.5: Manually inspect the diff for the whole series**

Run: `git log --oneline main..HEAD` — confirm 10 commits (one per Task 1-10) plus the spec commit already present.

Run: `git diff --stat main..HEAD` — expected touched files:
- `src/config/characters.ts`
- `src/agent/doctor.ts`
- `src/agent/dream-seeder.ts`
- `src/agent/dossier.ts`
- `src/agent/experiments.ts`
- `src/web/server.ts`
- `src/events/town-events.ts`
- `test/config.test.ts`
- `test/manifest-snapshot.test.ts`
- `test/fixtures/manifest-production.json`

If any file outside this list is modified, investigate before proceeding to deployment.

- [ ] **Step 11.6: Push to both remotes**

Per project memory: local pushes to `origin` (lain) and `wired` (wired-lain); droplet pulls from `origin` of the wired-lain repo.

```bash
git push origin main
git push wired main
```

Expected: clean pushes; no rejected non-fast-forwards.

---

## Task 12: Deploy to droplet and edit production manifest

**Why:** The code defaults match current hardcoded values (with drift fixes). Adding the three overrides makes the manifest explicit.

**Risk:** Drift fixes cause three behavior changes (Hiru starts receiving experiment shares and town events; Hiru's DB starts being snapshotted). These are desired. If unexpected noise appears, they can be rolled back by removing `role: 'oracle'` from Dr. Claude (making him an inhabitant) — but that's a manifest-only change, not a revert.

- [ ] **Step 12.1: Check current droplet status**

```bash
ssh root@198.211.116.5 "./deploy/status.sh"
```

Expected: all 7 services healthy (exact output format depends on deploy/status.sh).

- [ ] **Step 12.2: Back up the current production manifest and databases**

Per project memory ("character memories are sacred during deploys"):

```bash
ssh root@198.211.116.5 'cd /opt/local-lain && cp characters.json characters.json.bak-$(date +%Y%m%d-%H%M) && for d in /root/.lain /root/.lain-wired /root/.lain-pkd /root/.lain-mckenna /root/.lain-john /root/.lain-dr-claude /root/.lain-hiru; do [ -f "$d/lain.db" ] && cp "$d/lain.db" "$d/lain.db.bak-$(date +%Y%m%d-%H%M)"; done'
```

Expected: no error output. Backups are co-located with the originals, dated.

- [ ] **Step 12.3: Pull code and rebuild on droplet**

```bash
ssh root@198.211.116.5 "cd /opt/local-lain && git pull origin main && npm run build"
```

Expected: clean pull and build, no TS errors.

- [ ] **Step 12.4: Snapshot the production manifest shape**

Before editing, confirm what's there:

```bash
ssh root@198.211.116.5 "cat /opt/local-lain/characters.json"
```

Copy this output — it's the pre-edit state for rollback reference.

- [ ] **Step 12.5: Edit the production manifest to add the three overrides**

Three surgical edits to `/opt/local-lain/characters.json`:

1. On the `lain` entry, add `"systemdUnit": "lain-main"` and `"homeDir": "/root/.lain"`.
2. On the `wired-lain` entry, add `"systemdUnit": "lain-wired"` and `"homeDir": "/root/.lain-wired"`.
3. On the `dr-claude` entry, add `"role": "oracle"`.

The recommended way is a short Node one-liner that preserves formatting:

```bash
ssh root@198.211.116.5 'cd /opt/local-lain && node -e "
const fs = require(\"fs\");
const m = JSON.parse(fs.readFileSync(\"characters.json\", \"utf-8\"));
for (const c of m.characters) {
  if (c.id === \"lain\") { c.systemdUnit = \"lain-main\"; c.homeDir = \"/root/.lain\"; }
  if (c.id === \"wired-lain\") { c.systemdUnit = \"lain-wired\"; c.homeDir = \"/root/.lain-wired\"; }
  if (c.id === \"dr-claude\") { c.role = \"oracle\"; }
}
fs.writeFileSync(\"characters.json\", JSON.stringify(m, null, 2) + \"\n\");
"'
```

- [ ] **Step 12.6: Verify the edited manifest parses and has the expected shape**

```bash
ssh root@198.211.116.5 'cd /opt/local-lain && node -e "
const m = JSON.parse(require(\"fs\").readFileSync(\"characters.json\", \"utf-8\"));
const lain = m.characters.find(c => c.id === \"lain\");
const wl = m.characters.find(c => c.id === \"wired-lain\");
const dc = m.characters.find(c => c.id === \"dr-claude\");
console.log({lainHome: lain.homeDir, lainUnit: lain.systemdUnit, wlUnit: wl.systemdUnit, drRole: dc.role});
"'
```

Expected output: `{ lainHome: '/root/.lain', lainUnit: 'lain-main', wlUnit: 'lain-wired', drRole: 'oracle' }`.

- [ ] **Step 12.7: Restart all services**

```bash
ssh root@198.211.116.5 "systemctl restart lain.target"
```

- [ ] **Step 12.8: Verify health**

```bash
ssh root@198.211.116.5 "sleep 10 && ./deploy/status.sh"
```

Expected: all 7 services healthy.

- [ ] **Step 12.9: Spot-check a manifest-driven endpoint**

```bash
ssh root@198.211.116.5 "curl -s -H \"Authorization: Bearer \$(grep LAIN_OWNER_TOKEN /opt/local-lain/.env | cut -d= -f2)\" http://localhost:3000/api/dreams/status | head -c 500"
```

Expected: JSON with dream stats for multiple characters (including Hiru).

- [ ] **Step 12.10: Check logs for drift-fix behavior**

```bash
ssh root@198.211.116.5 "journalctl -u lain-wired --since '2 minutes ago' | grep -iE 'hiru|dr.claude|oracle' | head -20"
```

Expected: no errors. On the next experiment cycle, expect to see Hiru mentioned in share-peer log lines.

- [ ] **Step 12.11: Rollback procedure (document only — do not execute)**

If something goes wrong after deployment:

```bash
# Revert the manifest edits:
ssh root@198.211.116.5 'cd /opt/local-lain && cp characters.json.bak-<timestamp> characters.json && systemctl restart lain.target'
# If code is the problem, revert the git commits:
ssh root@198.211.116.5 "cd /opt/local-lain && git reset --hard <pre-deploy-sha> && npm run build && systemctl restart lain.target"
```

The backed-up databases from Step 12.2 are not touched by this refactor (no schema migrations), but they exist as insurance.

---

## Self-review notes (inline)

- **Spec coverage:** Every item in §Design (schema, accessors, call-site table, drift fixes, testing, deployment) maps to a task. §Testing is covered by Tasks 1-4 and 9-10 (drift-fix lock-ins).
- **Placeholder scan:** No TBD/TODO/"implement later" phrases. All test code is concrete.
- **Type consistency:** `CharacterManifestEntry` fields referenced in later tasks all match the schema added in Task 1. `getInhabitants` returns `CharacterManifestEntry[]` everywhere.
- **Naming:** `getHealthCheckTargets` used consistently in Tasks 5-7. `getDossierSubjects(writerId)` signature stable across Tasks 3 and 8. `_resetManifestCache` referenced in tests matches the export added in Task 1.
