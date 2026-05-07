# `src/cli/commands/status.ts`

Read-only status report. 1 function.

## Functions

### `status()`, line 18

**Purpose:** report gateway running/not, config presence/validity, auth token, DB, workspace.

**Fits the system?** Same fossil pattern as `doctor.ts` / `onboard.ts` — probes `paths.workspace` = `{LAIN_HOME or ~/.lain}/workspace/{SOUL,AGENTS,IDENTITY}.md`. For the multi-char town runtime, this workspace path is not the source of truth. `config.agents.length` is printed from `loadConfig()` but that list is read from `lain.json5`, not from the actual `characters.json` manifest — so "Agents: N" may misrepresent how many characters the town *actually* has.

**Gaps / bugs:**
- **P2** — `status` reports workspace health using legacy single-char path. Users running a town get "Workspace: Not found" even though the town has workspaces at `workspace/characters/<id>/`.
- **P2** — "Agents: N" reads `config.agents.length`, not `characters.json`. The two can (and in practice do) diverge. Town health should surface `characters.json` count, defaulted roles, and per-character home dirs.
- No check for the running character servers (`lain-wired`, `lain-main`, `lain-pkd`, ...). `status` tells you about the *gateway* only. For the multi-char town this is like a "server status" command that only reports whether the front door is open. Consider either:
  - rename to `gateway-status` to honestly scope,
  - or expand to probe all character servers (port-by-port from manifest).
  - **P2**.
- No color/icon legend. Cosmetic. **P3**.

---

## File-level notes

- `displayStatus('Path', paths.config, true)` always passes `true` (ok). Accurate — displaying the path is informational, not a check. Consistent.
- `try { const config = await loadConfig() } catch` swallows the error inside a try that already has an outer existence guard. Fine.
- Same duplicated legacy-file list as `doctor.ts` and `onboard.ts`. Three-way duplication of `['SOUL.md', 'AGENTS.md', 'IDENTITY.md']`. **P3**.

## Verdict

**Lift to findings.md:**
- (Bundled into the doctor/onboard P2s — same root issue.) Will note in `findings.md` that `doctor`, `status`, and `onboard` all target the legacy single-user layout and are misleading in a multi-char town.
