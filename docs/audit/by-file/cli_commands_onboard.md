# `src/cli/commands/onboard.ts`

Interactive setup wizard. 4 functions (1 exported + 3 helpers).

## Functions

### `checkNodeVersion()`, line 24

**Purpose:** return `{ ok, version }` for Node >= 22.

**Gaps / bugs:** duplicate of `doctor.ts:checkNodeVersion` with different return shape. Minor code duplication. **P3**.

### `createDirectories(paths)`, line 36

**Purpose:** `mkdir -p` the standard Lain directories: base, workspace, agents, extensions, credentials.

**Fits the system?** Yes, for the single-user CLI install. For a multi-character town repo, none of these directories are actually used by the runtime (town uses repo-relative `workspace/characters/<id>/` + per-character `~/.lain-<id>/`). **Deferred concern**.

**Gaps / bugs:** None in isolation. Creates the legacy layout. It's the *caller* that decides whether this is still meaningful.

### `copyWorkspaceFiles(sourcePath, targetPath)`, line 53

**Purpose:** copy `SOUL.md`, `AGENTS.md`, `IDENTITY.md` from `sourcePath` to `targetPath`, skipping missing sources, skipping existing targets.

**Fits the system?** No — caller passes `sourcePath = join(process.cwd(), 'workspace')` (line 130). The repo's `workspace/` directory no longer contains top-level `SOUL.md` / `AGENTS.md` / `IDENTITY.md` — those live under `workspace/characters/<id>/`. So:
- `access(source, constants.R_OK)` fails for each of the three files,
- `continue` skips all three silently,
- user sees no files copied, no `✓ Copied X` messages, and no warning that nothing was copied,
- `onboard()` then reports "Lain is ready" and exits.

**Gaps / bugs:**
- **P2** — Onboard never copies character files in the current multi-char repo layout. The silent-skip loop means the user gets a "setup complete" with an empty workspace. Running `lain chat` afterwards has no character persona to load.
- **P3** — error branch on line 134 (caller): `displayInfo('Workspace files not copied: ${error}')` downgrades an error to info. Only reaches here on unexpected access errors since the inner loop swallows "file not found" silently.

### `onboard()`, line 84

**Purpose:** drive the full setup: node check → prompts → dirs → config → workspace copy → DB init → auth token.

**Gaps / bugs:**
- After DB init, `generateAuthToken()` writes to keychain. If keychain is locked (macOS first use), the error handler says "You can generate a token later with: lain token generate" — but grep shows no `lain token` subcommand in `src/cli/index.ts`. Dead guidance. **P2**.
- `createInitialConfig()` is called when config is missing but no error handler — if it throws (keychain locked, no write perms), onboard dies without a clean rollback of created directories. Not destructive, just messy.
- No detection of "this is a multi-char repo, you probably want `characters.json`" — onboard will succeed on a repo where the user actually wanted a town. **P2**, linked to above.

---

## File-level notes

- Onboard appears to be a fossil from the original single-user Lain CLI. The multi-char town flow uses `./start.sh` / `./deploy/*`, not `lain onboard`. Either this needs to be updated to the multi-char model OR it needs a clear "this only sets up single-user mode; for a town, see SETUP.md" message. **P2**.
- No idempotency test — running onboard twice should be safe. Re-running today: config skipped (good), workspace silently skipped (bad / empty), DB init is harmless, token generation would overwrite (confirm when keychain audit happens).

## Verdict

**Lift to findings.md:**
- P2: `lain onboard` is stale — targets pre-multi-char layout. Silently skips all workspace files in the current repo, claims "ready" with no character set up.
- P2: Error path points to nonexistent `lain token generate` subcommand.
