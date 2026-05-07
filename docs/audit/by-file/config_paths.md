# `src/config/paths.ts`

Resolves `~/.lain/` directory structure. 4 functions.

## Functions

### `getBasePath()`, line 18

**Purpose:** `LAIN_HOME || ~/.lain`. Single-char install root OR per-character override (`LAIN_HOME=/root/.lain-pkd` in systemd units).

**Fits the system?** Yes — this is THE hinge that makes multi-character deploys work. Per MEMORY: `.env` must NOT set `LAIN_HOME` because it overrides per-service env.

**Gaps / bugs:** None in isolation. The entire multi-char deploy correctness depends on this function being the single source of "where does this character's data live?". Good that it's a single choke point.

### `getPaths()`, line 25

**Purpose:** return all standard paths (base, config, socket, pidFile, database, workspace, agents, extensions, credentials).

**Gaps / bugs:**
- `workspace: join(base, 'workspace')` — this is the legacy single-char workspace path that doctor/status/onboard all use. The multi-char runtime doesn't actually use this; it uses `{repoRoot}/workspace/characters/<id>/`. So `paths.workspace` is a legacy leftover. **P3**, ties to the lifted "legacy workspace" P2.
- `agents: join(base, 'agents')` — this is for per-agent subdirectories (transcripts, sessions). Used by `getAgentPath()`/`getAgentSessionsPath()`. Still valid.

### `getAgentPath(agentId)`, line 44 + `getAgentSessionsPath`, `getAgentTranscriptsPath`

**Purpose:** derive per-agent directories inside the per-character `LAIN_HOME`.

**Gaps / bugs:** Sessions and transcripts are under `LAIN_HOME/agents/<id>/`. In practice, each character is ONE agent (`id` = character id), so we have `/root/.lain-pkd/agents/pkd/sessions/`. One extra directory layer, consistent. No issue.

---

## File-level notes

- `LAIN_DIR = '.lain'`, hard-coded. If a user wanted a non-dot directory, they'd need to set `LAIN_HOME` explicitly. Fine.
- No validation that `LAIN_HOME`, when set, is absolute / writable / exists. A typo would cascade into confusing "ENOENT" from every downstream call. **P3**.

## Verdict

No findings to lift. P3 notes about path validation and the vestigial `workspace` path.
