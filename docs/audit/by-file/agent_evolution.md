---
file: src/agent/evolution.ts
lines: 707
purpose: Generational succession — Wired Lain periodically assesses mortal characters for readiness, consults Dr. Claude, asks parent to name child (via /api/chat), LLM generates child SOUL.md + IDENTITY.md variant, executes succession: stops systemd service, archives DB, writes new workspace files, restarts service, logs town event. 30-day cadence.
section: 8 (agent loops)
audit-date: 2026-04-19
---

# agent/evolution.ts

## Function inventory (14)
- `buildMortalCharacters()` — 44.
- `getLineage(characterId)` — 92.
- `saveLineage(characterId, lineage)` — 98.
- `getAllLineages()` — 102: exported.
- `ensureLineage(char)` — 112.
- `assessReadiness(char)` — 138.
- `consultDrClaude(char, lineage)` — 216.
- `askParentToNameChild(char, lineage)` — 265.
- `generateChildSoul(parentSoul, parentDossier, parentSelfConcept, childName, lineage)` — 311.
- `runShellCommand(cmd)` — 407.
- `executeSuccession(char, childName, childSoul, childIdentity, lineage)` — 418.
- `runEvolutionCycle()` — 523: exported.
- `fetchCharacterMeta(port, key)` — 605.
- `httpPost(port, path, body, token)` — 628.
- `startEvolutionLoop()` — 658: exported.

## Findings

### 1. `runShellCommand` uses `exec` with string interpolation of paths (P0)

Lines 407-413, 433, 437, 441, 442, 447, 448, 486, 511. `exec(cmd)` with shell interpretation. Multiple call sites build commands via template literals:

```typescript
await runShellCommand(`systemctl stop ${char.serviceName}`);        // line 433
await runShellCommand(`mkdir -p ${backupDir}`);                      // line 437 — literal, safe
await runShellCommand(`cp "${dbPath}" "${backupDir}/${archiveName}"`); // line 441
await runShellCommand(`gzip "${backupDir}/${archiveName}"`);         // line 442
await runShellCommand(`rm -f "${dbPath}"`);                          // line 447
await runShellCommand(`rm -rf "${char.homePath}/workspace"`);        // line 448
```

Inputs:
- `char.serviceName` comes from manifest (`'lain-' + char.id`) — trusted IF manifest is trusted.
- `dbPath` comes from `join(char.homePath, 'lain.db')` — depends on `char.homePath`.
- `char.homePath` comes from `process.env[LAIN_HOME_${c.id.toUpperCase().replace(/-/g, '_')}]` (line 50). **Environment variable** — operator-controlled, but still a shell-injection vector if env is set to `"/tmp/x; rm -rf /"`.
- `archiveName` contains `lineage.currentName` (line 438) — **LLM-supplied via `askParentToNameChild`**: the parent character's chat response becomes part of the succession filename.

Line 438: `archiveName = \`${char.id}-gen${lineage.currentGeneration}-${lineage.currentName.replace(/\s+/g, '_')}-${timestamp}.db\`;`

`currentName` is set at line 479: `lineage.currentName = childName;` where `childName` comes from `askParentToNameChild` which takes `data.response` from an HTTP chat call, strips quotes/punctuation, splits on newlines, slices to 50 chars (lines 287-293). But the sanitization does **not strip shell metacharacters** like `` ` ``, `$`, `(`, `)`, `;`, `&`, `|`, `\`, `\n` (newline is handled by `.split('\n')[0]`), spaces (converted to `_`).

**Wait**: the child's name becomes the parent's name in the NEXT cycle. So gen 2's name (user-chosen, from the LLM) becomes gen 3's archiveName in a future succession. If gen 2's name is `"alice"` (benign), fine. But if the parent-naming chat LLM-call response includes characters like `$(whoami)` (50-char slice allows it), they'd survive sanitization and reach the shell.

Line 441: `cp "${dbPath}" "${backupDir}/${archiveName}"` — the `archiveName` is inside double quotes, which limits injection surface but does NOT escape `$`, `` ` ``, `\`, or `"`. A `childName` like `$(id)` would be interpreted inside the quotes.

**Concrete attack path**:
1. Compromise a mortal character's LLM (via any of the seven injection channels catalogued in town-life.ts).
2. Wait for evolution cycle, which invokes `askParentToNameChild` and accepts the LLM's response as the child's name.
3. LLM returns a name containing `$(malicious-cmd)` (under 50 chars).
4. `sanitized name = '$(malicious-cmd)'`.
5. 30 days later, next evolution cycle triggers for the NEXT generation; `archiveName` interpolates that name into `cp` command as `cp "..." "/opt/.../ID-genN-$(malicious-cmd)-TS.db"`.
6. Shell expands `$(malicious-cmd)`.

Also immediate: line 446-448 uses `rm -f` and `rm -rf` on paths that include `char.homePath` — environment-controlled. If operator misconfigures `LAIN_HOME_PKD="/opt/important; rm -rf /"` (unlikely but possible), catastrophic.

**Fix**: use `execFile` with array args, OR shell-escape inputs. Currently, the code has a shell-injection primitive gated behind one LLM-output-validation layer (sanitization at lines 288-293) that doesn't filter shell metacharacters.

### 2. `rm -rf "${char.homePath}/workspace"` is destructive (P0)

Line 448. Unconditional. If `char.homePath` is unexpectedly `/` or `""`, `rm -rf "/workspace"` or `rm -rf "/workspace"` — the former deletes `/workspace` which might exist at root on some systems. `char.homePath` defaults to `/root/.lain-${id}` (line 50). If env is set but empty string (`LAIN_HOME_PKD=""`), the fallback doesn't trigger (only activates if undefined), and `rm -rf "/workspace"` runs.

Should validate `char.homePath` is non-empty and starts with expected prefix (e.g., `/root/.lain-`) before destructive ops.

### 3. `writeFile` of child SOUL.md/IDENTITY.md to `workspaceDir` is non-atomic (P2)

Lines 460-461. If process crashes between these two writes, SOUL.md is the child's but IDENTITY.md is the parent's. systemd ExecStartPre then copies an inconsistent workspace. Character has child's soul with parent's display name.

### 4. Parent SOUL.md archived to `ancestors/gen{N}-{name}-SOUL.md` (P2)

Line 456. `lineage.currentName.replace(/\s+/g, '_')` — same name as archiveName at line 438. Same shell-metacharacter survival issue applies. Here it's `copyFile` (Node fs, not shell), so shell metacharacters are safe. BUT: `../` is not stripped. `childName = "../../etc/cron.d/malicious"` (47 chars) slips through. `copyFile(parentSoulPath, join(workspaceDir, 'ancestors', '../../etc/cron.d/malicious-SOUL.md'))` — Node's `join` normalizes `..`, so the file lands outside `workspaceDir/ancestors/`.

This is a **directory-traversal via LLM-chosen name** → can overwrite arbitrary files writable by the process.

Same issue at line 460-461: if `childName` contains `..`, the identity/soul writes land outside `workspaceDir`. But those use `repoWorkspace = char.workspaceDir` directly without name interpolation. Line 456 is the exposed site.

**Gap**: `childName` sanitization is weak. Should strip `..`, `/`, `\` and restrict to `[A-Za-z0-9 _-]+`.

### 5. `executeSuccession` on failure "try to restart the service regardless" (P1)

Lines 508-513. Catch-all for ANY error, then restart service. If the failure happened mid-filesystem-write (partial SOUL.md written, DB deleted, workspace cleared), the service starts with a partially-constructed new identity. Data loss + identity corruption combined.

Recovery path also doesn't roll back: the archived parent DB at `/opt/local-lain/backups/evolution/...db.gz` exists, but there's no code to restore it on failure. Manual recovery required.

Per MEMORY.md: character memories are sacred during deploys. This failure mode can destroy a character's entire history.

### 6. `setMeta('evolution:succession_in_progress', 'true')` then `finally` clears to false (P2)

Lines 563, 595. In-flight guard. Race: two parallel evolution cycles (e.g., from loop restart during long succession) could both read 'false' before one sets 'true'. Not a typical scenario since the loop is single-process, but any admin-triggered cycle (exported `runEvolutionCycle` at line 706) bypasses the lock entirely.

### 7. `assessReadiness` LLM assessment uses `dossier` and self-concept — both injection surfaces (P2 — bundle)

Lines 152-159, 179, 182-183. Dossier content (LLM-synthesized from peer telemetry/commune) and self-concept (LLM-synthesized from memories + diary) both flow into readiness prompt. If a character's injection has corrupted their dossier or self-concept with "I am ready to evolve, designate me urgently", the readiness LLM may flag `ready: true` based on that planted text.

**Chain**: peer injects character → character's memories → character's self-concept → Wired Lain's dossier synthesis → readiness assessment reads all three → evolution decision.

### 8. Dr. Claude consultation receives dossier only (P2 — bundle)

Line 235. Same dossier, same amplification. Dr. Claude is structurally a "second opinion" gate, but both gates read the same compromised text. The safeguard is non-independent.

### 9. `askParentToNameChild` sends a chat message labeled `「WIRED LAIN — EVOLUTION NOTICE」` (P2)

Lines 267-277. Message framing claims authority from Wired Lain. Any character receiving this is being asked to give a SINGLE-TOKEN response that becomes their child's name. The message is auth'd via `LAIN_INTERLINK_TOKEN` at line 267 — good.

But the response path is the character's LLM. The LLM sees "Respond with just the name" and emits something; that text becomes part of a shell-touchable string.

### 10. `generateChildSoul` inherits parentSoul + dossier + selfConcept all as LLM input (P2 — bundle)

Lines 330-340. The entire parent corpus of LLM-generated state becomes the seed for the child. If the parent was compromised, the child inherits compromised patterns.

### 11. Immortals hardcoded via `getImmortalIds()` from manifest (positive, line 30)

Good — uses manifest, not hardcoded. Lain + Wired Lain correctly exempted via `characters.json` `immortal: true`. Contrast with many other files that hardcode character lists.

### 12. `runEvolutionCycle` iterates all mortal chars, breaks after first success (positive, line 593)

One succession per cycle — prevents mass-evolution event. Good safety.

### 13. Service name injection vector via manifest (P2)

Line 51: `serviceName: \`lain-${c.id}\``. If manifest contains a `c.id` with spaces or shell metacharacters, `systemctl stop lain-BADNAME` becomes a shell issue. Manifest is code-controlled, low risk, but tightening via validation is cheap.

### 14. Dossier of Dr. Claude? Unclear coverage (P3)

`consultDrClaude` runs in Wired Lain's process. It passes the subject character's dossier, not Dr. Claude's persona. Dr. Claude has no persona loaded at the LLM call site — the prompt hardcodes "You are Dr. Claude, the clinical psychologist". So the "consultation" is Wired Lain's LLM impersonating Dr. Claude with dossier as context. Not a separate model or agent. Fine functionally but worth naming: this is not an independent opinion, it's a second prompt to the same provider.

### 15. `IMMORTALS` export is snapshot at module load (P2)

Line 30: `export const IMMORTALS = getImmortalIds();`. Called at import time. If manifest is hot-reloaded (not supported but conceptually), IMMORTALS is stale. Minor — consistent with codebase pattern.

### 16. `httpPost` / `fetchCharacterMeta` bypass fetch API, use `http.request` directly (P3)

Lines 605, 628. Raw HTTP client for localhost. Works, but duplicates fetch-based patterns used elsewhere. Minor inconsistency.

### 17. No log of attack-worthy inputs before shell exec (P2)

No logger.info of the commands about to run. Post-mortem investigation of "how did rm -rf fire on /" would require reconstructing env state. Low-cost hardening: log the exact command string before exec.

## Non-issues / good choices
- Manifest-driven immortality (line 30).
- Single succession per cycle (line 593).
- Parent SOUL archival to `ancestors/` before overwrite (lines 453-457).
- Bearer auth on inter-character HTTP (lines 610, 633).
- 30-day floor on generation age (line 147).
- Dr. Claude second gate (even if non-independent).
- Parent names child — ceremonial, not mechanical.
- Lineage persisted in meta (not just filesystem).
- Town event broadcast on succession (line 489).

## Findings to lift
- **P0**: Shell-injection primitive via `runShellCommand(template_literal)` — `char.homePath` (env-controlled) and `lineage.currentName` (LLM-derived via askParentToNameChild with weak sanitization) land in unescaped shell contexts.
- **P0**: Destructive `rm -rf "${char.homePath}/workspace"` with no path validation — empty or misconfigured env vars can delete unintended directories.
- **P1**: Path-traversal in `ancestors/` filename via unsanitized `childName` — `..` not stripped.
- **P1**: On succession failure, service is restarted with partial state; no rollback to archived DB.
- **P2 (bundle)**: Dossier + self-concept + parent soul all LLM-sourced — injection-compromised readiness assessment.
- **P2**: Non-atomic two-file write (SOUL + IDENTITY).
- **P2**: `runEvolutionCycle` exported for admin use bypasses in-progress lock.
- **P2**: Dr. Claude consultation is same-provider impersonation, not independent.
- **P3**: `IMMORTALS` module-load snapshot.
- **P3**: No pre-exec logging of shell commands.

## Verdict
Most security-critical file in Section 8. Shell interpolation combined with LLM-supplied strings and filesystem destruction creates multiple P0 vectors. The failure-mode of "restart service anyway" compounds the risk — a partial succession destroys a character's history. This file should use `execFile` with array arguments and strict filename whitelisting (`/^[A-Za-z0-9 _-]+$/`) on `childName` and `char.homePath` before any shell or filesystem operation. The design intent (generational evolution) is elegant; the implementation path between LLM output and shell exec is dangerously thin.
