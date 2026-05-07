# `src/config/index.ts`

Config loader + save + cache. 7 exported functions + 2 internal `deepMerge*` helpers. Also re-exports paths, defaults, schema modules.

## Functions

### `loadConfig(configPath?)`, line 23

**Purpose:** load `lain.json5` (or given path), deep-merge with defaults, validate, cache.

**Gaps / bugs:**
- Missing file → returns defaults. Sets `cachedConfig`. Same silent-degradation pattern flagged in `characters.ts`. **P3** — but for `lain.json5` this is probably desirable (tests pass without a real config).
- Parse error path throws `ConfigError`. Good.
- Validation error (`validate()` throws `ValidationError`) is *not* wrapped in `ConfigError` — it bubbles as `ValidationError`. Callers expecting only `ConfigError` would miss it. **P3**.
- Deep-merge then validate. If the user's config has `agents: []` (empty), the merge yields the user's empty array (source wins over defaults) and validation rejects it (`minItems: 1`). Clear failure, OK.

### `getConfig()`, line 61

**Purpose:** return cached config, throw if not loaded.

**Gaps / bugs:** Callers must have called `loadConfig` first. Gateway bootstrap does this; `status.ts` does too. If any new call site calls `getConfig()` without `loadConfig()`, they get `ConfigError`. Clear failure mode.

### `isConfigLoaded()`, line 71

Trivial null-check wrapper. Fine.

### `saveConfig(config, configPath?)`, line 78

**Purpose:** validate + write JSON5 to disk + update cache.

**Gaps / bugs:**
- **`JSON5.stringify(config, null, 2)`** — not all JSON5 features round-trip. Comments from `generateSampleConfig()` would be lost. If the user hand-annotated their `lain.json5` with comments, `saveConfig` would obliterate them on next save. **P2** — the save path isn't widely used today, but any future "save edited settings from UI" would hit this. Lift with a note that no current callers do this.
- `mkdir(dirname(path), { recursive: true })` before write — good.
- Race: two concurrent `saveConfig` calls would interleave writes. Not atomic. **P3** — locks or tempfile+rename.
- No callers today (grep for `saveConfig` to confirm).

### `createInitialConfig(configPath?)`, line 100

**Purpose:** write the sample config template. Called by `lain onboard`.

**Gaps / bugs:**
- Overwrites without warning if file exists — but onboard guards against that with an `access` check first. Still, API contract is "overwrites", should document. **P3**.

### `resetConfig()`, line 118

**Purpose:** test helper to clear cached config.

### `deepMerge(target, source)`, line 125 + `deepMergeObject`, line 155

**Purpose:** recursive object merge, source wins, arrays replace (not concat).

**Gaps / bugs:**
- **Array replacement semantics** — if user's `agents: [customAgent]`, it fully replaces defaults' `agents: [defaultAgent]`. Intended. But then user has to specify all fields of `customAgent` (providers, workspace) — they can't "add one and inherit defaults". Architectural choice, not a bug. **P3** — worth noting for user docs.
- **`sourceValue !== undefined` check** means explicit `undefined` in user config (impossible from JSON5 parse, possible programmatically) is treated as "skip". Correct.
- `Object.keys(source)` — doesn't handle `null` prototypes. JSON5 parse gives regular objects. Fine.
- `(result as any)[key]` x2 — documented with eslint-disable. OK.

---

## File-level notes

- **Cache is module-scoped**: same concern as manifest. Safe for systemd process-per-character. Tests use `resetConfig`.
- **No atomic write**: `writeFile` can leave a partial file on power loss. Temp-file-rename pattern would be safer. **P3**.

## Verdict

**Lift to findings.md:**
- P2: `saveConfig` strips JSON5 comments on round-trip. Any hand-annotated `lain.json5` would lose its comments if `saveConfig` is ever wired into a UI editor. No current callers, but surfacing the constraint now avoids surprise later.
