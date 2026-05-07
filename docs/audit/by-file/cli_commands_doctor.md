# `src/cli/commands/doctor.ts`

Diagnostics runner: walks through Node version, config, DB, keychain, auth token, workspace, API key. 9 functions (1 exported + 8 `check*` helpers).

## Functions

### `doctor()`, line 27

**Purpose:** orchestrate all diagnostic checks, print summary, exit non-zero if anything failed.

**Fits the system?** Partially. It targets the *single-user CLI install* model (`~/.lain/`) — the pre-multi-character layout. For a developer running the project as a multi-character town, this command checks a layout the runtime no longer primarily uses.

**Gaps / bugs:**
- Calls `checkWorkspace()` which only looks at `~/.lain/workspace/{SOUL,AGENTS,IDENTITY}.md` — see below. Misleading "all checks passed" for multi-char setups.
- `checkConfigFile()` returns `ok: true` even when the config is missing, with message "Not found, using defaults" — correct UX but the result counts as a pass. Fine, just worth noting.
- Exit code 1 on any failed check is good; used by shell integrations.

### `checkNodeVersion()`, line 74

**Purpose:** enforce `node >= 22`.

**Gaps / bugs:** `parseInt(version.split('.')[0] ?? '0', 10)` — if `process.versions.node` is malformed (never happens in practice) treats as 0 → fail. Fine. **No findings.**

### `checkConfigFile()`, line 92

**Purpose:** confirm config file is readable. Missing-file case is treated as `ok: true`.

**Gaps / bugs:** see above — semantic: "file not found" is NOT a failure because the loader falls back to defaults. Consistent with `checkConfigValid`. No findings.

### `checkConfigValid()`, line 105

**Purpose:** `loadConfig()` and report any parse/validation error.

**Gaps / bugs:** None — real failure surfaces here if the JSON5 is malformed.

### `checkDatabase()`, line 117

**Purpose:** open/close the DB to verify the file is usable.

**Gaps / bugs:** `initDatabase(paths.database)` takes only one arg in the signature here — missing the `keyDerivation` option, unlike `gateway.ts:45` which passes it. If DB encryption is gated on `keyDerivation`, `doctor` might open an un-keyed handle against an encrypted DB and fail with a confusing error. **Defer to `storage/database.ts` audit** — will verify the signature then. Provisional **P3**.

### `checkKeychain()`, line 132

**Purpose:** confirm `getMasterKey()` works (keychain service is reachable and has the key).

**Gaps / bugs:** None visible. A freshly-installed user without keychain entries will get a real error here and `checkWorkspace`/etc. can't fall back — but that's correct behavior.

### `checkAuthToken()`, line 144

**Purpose:** report whether an auth token has been generated.

**Gaps / bugs:** Returns `ok: true` when no token is set, with "Not set (run onboard)". Same pattern as `checkConfigFile` — a missing token is a warning, not a failure. Intentional.

### `checkWorkspace()`, line 161

**Purpose:** verify `SOUL.md`, `AGENTS.md`, `IDENTITY.md` exist in `paths.workspace`.

**Gaps / bugs:**
- **P2** — `paths.workspace` resolves to `{LAIN_HOME or ~/.lain}/workspace`. The repo's actual workspace layout is `workspace/characters/<id>/` (multi-character). This doctor check targets the legacy single-user CLI install model. For anyone who has run `npm run build && ./start.sh` without `lain onboard`, workspace is reported "Not initialized" even though the town may be fully functional.
- Returns `ok: true` in the "all missing" case (labelled "Not initialized") and `ok: false` in the partial-missing case. Odd inversion — partial init is worse than no init. Probably intentional (onboard never ran vs. onboard ran broken), but counter-intuitive.
- No attempt to detect multi-char workspace (look for `workspace/characters/*/`). Given the project has fully moved to multi-char, this check is mostly misleading.

### `checkApiKey()`, line 186

**Purpose:** warn if `ANTHROPIC_API_KEY` unset. Returns `ok: true` either way.

**Gaps / bugs:** Does not check `OPENAI_API_KEY` or `GOOGLE_API_KEY` — if the user intends to use a non-Anthropic provider exclusively, this flags a false warning. Minor. **P3**.

---

## File-level notes

- No check for `LAIN_INTERLINK_TOKEN` / `LAIN_OWNER_TOKEN` — both are required env vars per CLAUDE.md for any inter-character / owner flow. Doctor not flagging their absence is a gap. **P2**.
- No check that `characters.json` exists / parses. The entire multi-char runtime depends on it. **P2**.
- No check that PEER_CONFIG env (when present) has valid shape. Ties to the `parsePeerConfig` finding already lifted.
- No check for the SQLite extensions / sqlite-vec binding availability — this is a silent way embeddings die in prod. **P3** — defer until `memory/embeddings.ts` is audited to confirm.

## Verdict

**Lift to findings.md:**
- P2: `doctor` workspace check targets legacy single-user layout; misleading for multi-char installs.
- P2: `doctor` doesn't check `characters.json` or the required interlink/owner tokens.

Related (defer until multi-file corroboration): `initDatabase` signature mismatch.
