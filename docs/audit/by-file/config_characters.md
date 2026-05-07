# `src/config/characters.ts`

Character manifest loader. Reads `characters.json` (or `.json5` or `CHARACTERS_CONFIG` env path). 15 functions, 1 module-level cache.

## Functions

### `_resetManifestCache()`, line 31

**Purpose:** test hook to clear the module-level `_manifest` cache.

**Gaps / bugs:** Leading underscore signals "don't call in prod". Correct convention. No issue.

### `findManifestPath()`, line 35

**Purpose:** look for manifest at `CHARACTERS_CONFIG` env, then `cwd/characters.json`, then `cwd/characters.json5`. Return first hit.

**Gaps / bugs:**
- `process.cwd()` — brittle if the process is started from a non-repo directory. Systemd units run from `WorkingDirectory=/opt/local-lain`, fine. But `node dist/...` from random directories would fail. **P3**.
- No explicit log when manifest is NOT found. Caller sees empty `{ characters: [] }`. Silent degradation. **P2** — lift. Very common root cause for "my town is empty" troubleshooting.

### `loadManifest()`, line 48

**Purpose:** cache-or-load from disk. Returns `{ town, characters: [] }` when no manifest file found.

**Gaps / bugs:**
- **No schema validation.** `JSON.parse(raw) as CharacterManifest` — any malformed JSON that parses is accepted. Missing `characters` field → crash at first iteration. Typo in `role` silently demotes character (documented in the inline NOTE at line 115). Numeric `port` as string would break `getPeersFor`. **P1/P2** — lift as P2 unless corroborated stronger during runtime audit.
- **Module-level cache** — `_manifest` is set once and never refreshed. A deploy that updates `characters.json` but doesn't restart the process won't see the change. Fine for systemd (restart on deploy) but surprising. **P3**.
- **Empty-manifest fallback returns `{ town: { name: 'Town', description: '' }, characters: [] }`.** No character IDs means `getAllCharacters()` returns `[]`, `getPeersFor()` returns `[]`, commune weather aggregation sees no one. Processes come up "healthy" but the town is invisible. **P2** (bundled into "silent degradation").

### `getCharacterEntry(id)`, line 61

**Purpose:** find by id. Returns `undefined` on miss.

**Gaps / bugs:** Callers must null-check. Some do (see `startCharacterById` in `commands/character.ts`), some might not. **Deferred** per-caller check.

### `getAllCharacters()`, `getDefaultLocations()`, `getImmortalIds()`, `getMortalCharacters()`, `getWebCharacter()`, `getPeersFor()`, `getSystemdUnit()`, `getHomeDir()`, `getInhabitants()`, `getOracles()`, `getHealthCheckTargets()`, `getDossierSubjects()`, `getDreamSeedTargets()`, `getCharacterDatabases()`

All derive from `loadManifest()`. All pure-ish (mutate `result` records locally).

**Gaps / bugs:**
- **`getPeersFor`** hard-codes `http://localhost:${c.port}`. Works on a single droplet where every character runs on 127.0.0.1. In a multi-host deploy, this would break. Not a bug today — architectural ceiling. `PEER_CONFIG` env var is the override path. **P3**.
- **`getHomeDir`** default falls back to `/root/.lain-${id}`. Hard-coded `/root/` assumes droplet-root deploy. Local dev on macOS gives nonexistent `/root/.lain-<id>/`. This is why `LAIN_HOME` must be set per-service. **P3** — documented assumption, not a bug.
- **`getSystemdUnit`** default: `lain-${id}`. Matches the deploy convention.
- **`getWebCharacter()`** returns the character where `server === 'web'`. Only one character should be the "web" host. If two are set, `.find` returns the first — silent mis-configuration. **P2**.
- **`getImmortalIds`**: per MEMORY, only Lain + Wired Lain are immortal. Used for the generational system. If manifest lacks `immortal: true` flags entirely, all characters are mortal and dossier logic runs on everyone. Defer to dossier audit.
- **`getInhabitants()`** defaults role to `'inhabitant'` when unset. Good. But an invalid role string (`'inhabitnat'`) is filtered out of BOTH `getInhabitants` and `getOracles`. Documented in the NOTE at line 115 but still a silent data-loss mode. **P2**.
- **`getHealthCheckTargets()`** returns *all* characters including oracles. Correct.
- **`getDossierSubjects(writerId)`** is `everyone except writer`. Per MEMORY this is used by the "parent names child" flow — needs writer to actually be a manifest character. No error if `writerId` doesn't match any.
- **`getCharacterDatabases`** duplicates the `homeDir` fallback logic (`c.homeDir ?? /root/.lain-${c.id}`). Same `/root/` assumption. Should just delegate to `getHomeDir(id)` to keep one source of truth. **P3**.

---

## File-level notes

- **Cache invalidation**: `_resetManifestCache` is test-only. Prod has no "reload" path. Any change to `characters.json` requires process restart. Documented architecturally, not a bug.
- **Multiple "which characters?" predicates** (`getAll`, `getImmortal`, `getMortal`, `getInhabitants`, `getOracles`, `getHealthCheckTargets`, `getDossierSubjects`, `getDreamSeedTargets`) — proliferating purpose-specific filters rather than a general "filter by manifest criteria" function. Mild API surface growth. **P3**.
- **No `Record<id, Entry>` index** — every getter does `.find(c => c.id === id)` which is O(n). With ~6 characters, fine. At scale (imagined commune platform with 50+ characters), suboptimal. **P3**.

## Verdict

**Lift to findings.md:**
- P2: `loadManifest` has no schema validation. Malformed `characters.json` causes silent data loss or late-binding crashes.
- P2: Missing `characters.json` produces silent empty-town fallback with no logged warning. Hard to troubleshoot "town is empty".
- P2: `getWebCharacter()` + invalid-role filtering silently lose characters. (Reinforces the "no schema" P2.)
