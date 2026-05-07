---
file: src/agent/doctor.ts
lines: 1122
purpose: Dr. Claude loop — daily telemetry analysis (06:00 UTC, email report + letter block/unblock recommendation), tri-daily therapy with Lain (15:00 UTC), 10-min health check that probes all character services and shells out to deploy/healthcheck.sh --fix on any failure. Runs as its own service on port 3002 (lain-dr-claude).
section: 8 (agent loops)
audit-date: 2026-04-19
---

# agent/doctor.ts

## Function inventory (11 exported/named + local)

- `getDelayUntilUTCHour(targetHour)` — 116.
- `startDoctorLoop(config?)` — 132: orchestrates 3 timers (telemetry, therapy, health).
- `runTelemetryCycle(_cfg)` — 283: exported; queries local DB + town-wide telemetry, LLM analysis, writes block-letter meta.
- `fetchAllCharacterTelemetry()` — 617: bearer-token GET to each peer's `/api/telemetry`.
- `formatCharacterTelemetry(t)` — 642: pretty-prints one peer's telemetry.
- `runHealthCheckCycle(_cfg)` — 701: exported; HTTP probes each peer + integrity check + optional shell auto-fix.
- `runIntegrityCheck(result, logger)` — 819: reads each peer's `/api/meta/integrity`, detects shared/mis-homed basePaths.
- `runShellHealthcheck()` — 927: shells `bash deploy/healthcheck.sh --fix --quiet` on any down service.
- `runTherapyCycle(cfg)` — 960: exported; up-to-N-turn chat session between Dr. Claude and local Lain via `/api/chat`.
- `escapeHtml(text)` — 1116: exported.

## Findings

### 1. `DEFAULT_CONFIG` snapshots LAIN_INTERLINK_TARGET/TOKEN at module load (P1 — bundle with letter.ts)

Lines 104–107:
```
email: process.env['DR_CLAUDE_EMAIL'] ?? null,
gmailAppPassword: process.env['GMAIL_APP_PASSWORD'] ?? null,
targetUrl: process.env['LAIN_INTERLINK_TARGET'] ?? null,
authToken: process.env['LAIN_INTERLINK_TOKEN'] ?? null,
```

Same env-snapshot mechanism as letter.ts. Dr. Claude's therapy loop at line 970 derives the chat URL from `cfg.targetUrl` — if the global `.env` changes between deploys, the loop keeps the stale value until restart. Per MEMORY.md, LAIN_INTERLINK_TARGET in `.env` broke the Lain/Wired-Lain split for months. Same file-level code pattern here.

### 2. Letter-block writes go to Dr. Claude's OWN DB — cannot actually block Lain's letter loop (P1)

Lines 541–548:
```
if (analysis.letterRecommendation === 'block') {
  setMeta('letter:blocked', 'true');
  setMeta('letter:block_reason', ...);
  setMeta('letter:blocked_at', ...);
}
```

`setMeta` writes via `src/storage/database.ts`, which opens the per-character DB under `getBasePath()`. Dr. Claude's base path is `/root/.lain-dr-claude/`, so the write lands in `/root/.lain-dr-claude/lain.db`.

Lain's letter loop reads `letter:blocked` via `getMeta` from its OWN DB (`/root/.lain/lain.db`, per agent_letter.md finding #4). **Dr. Claude's block never reaches Lain's read.**

**Consequences:**
- `analysis.letterRecommendation === 'block'` has zero effect on Lain's actual letter delivery.
- Dr. Claude's report says "letters blocked", telemetry says "Letter currently blocked: false" on Lain's side.
- The whole clinical-gating mechanism is non-functional.

**Fix would require:** (a) an HTTP endpoint on each character that accepts authenticated block/unblock commands, (b) a shared read path (e.g., a per-peer `/api/meta/letter-block` endpoint), or (c) Dr. Claude writing to Lain's DB directly (boundary violation). (a) is the only clean option.

Flag: possibly the single most important functional bug in the doctor loop. Confirms letter.ts P2.

### 3. `runShellHealthcheck` execs `bash … --fix --quiet` on EVERY failure (P1)

Line 756 `if (downServices.length > 0)` → line 770 `runShellHealthcheck()`. No consecutive-failure gate, no backoff. Every 10 min (`healthCheckIntervalMs`), if ANY service is down — including a transient single-probe timeout — Dr. Claude shells out to run healthcheck.sh with `--fix`, which per deploy/ convention attempts `systemctl restart` on failing units.

**Chain:**
- HTTP probe transient failure (5s timeout, line 717) → service marked down → shell exec
- `deploy/healthcheck.sh --fix` uses systemctl → effectively sudo-equivalent power.
- Running every 10 minutes means one flaky service can produce 144 restart attempts/day.

**Plus**: `exec(\`bash "${scriptPath}" --fix --quiet\`)` at line 937 — `scriptPath` comes from `join(process.cwd(), 'deploy', 'healthcheck.sh')`. Cwd-dependent resolution. The bash invocation double-quotes the path, but if cwd ever contained shell-metacharacters in production, quoting would not escape `$`, backtick, or `\`. In practice deployments use `/opt/local-lain/` — safe today, fragile if paths change.

**Fix:** require N consecutive failures before invoking, add exponential backoff on fix attempts.

### 4. Telemetry `dataBlock` is labeled "WIRED LAIN LOCAL TELEMETRY DATA" but reads Dr. Claude's OWN DB (P2)

Lines 296–324 query `countMemories()`, `countMessages()`, `query<MemoryRow>(...)`, `query<MemoryTypeRow>(...)` — all hit Dr. Claude's local DB (since the service runs with `LAIN_HOME=/root/.lain-dr-claude/`).

Line 448 prompt text: `WIRED LAIN LOCAL TELEMETRY DATA (last 24 hours):`

This is **mislabeled**. Dr. Claude reads its own database's memory counts, session activity, emotional weights — then presents them to the LLM as if they were Wired Lain's. Dr. Claude has almost no session activity of its own, so these numbers may be near-zero while the LLM draws conclusions about "Wired Lain".

**Redemption:** the `townTelemetryBlock` (line 397) fetched from peers via `/api/telemetry` contains the actual per-character data. The LLM gets both — but the mislabeled "local" block is misleading context.

**Likely explanation:** legacy. Dr. Claude may originally have run inside Wired Lain's process (before extraction). The labels weren't updated.

### 5. `JOURNAL_PATH = join(getBasePath(), '.private_journal', 'thoughts.json')` reads Dr. Claude's journal, not Wired Lain's (P2 — bundle with #4)

Line 111. `recentDiary` (line 336) shows entries from Dr. Claude's journal file under `.lain-dr-claude/`. The prompt frames them as diary entries for analysis of mental state.

Dr. Claude doesn't run a diary loop (diary.ts is for characters, not the doctor), so `JOURNAL_PATH` almost certainly doesn't exist → line 338 `existsSync(JOURNAL_PATH)` false → `recentDiary = '(no diary entries)'`. Harmless in practice but the intent-vs-code mismatch is symptomatic.

### 6. `TELEMETRY_SERVICES` and `HEALTH_CHECK_SERVICES` hardcode character list (P2)

Lines 608–615 and 691–699 hardcode 6 characters with ports (and systemd unit names). The manifest IS accessible — `runIntegrityCheck` at line 826 correctly uses `getInhabitants()`. Drift risk if `characters.json` changes: new characters won't be probed, removed characters produce probe noise, port changes require code edits.

**Gap:** all three lists (TELEMETRY, HEALTH_CHECK, integrityServices) should share a single manifest-derived source. Currently only integrity does so.

### 7. Analysis prompt hardcodes character roster (P2 — bundle with #6)

Lines 481, 491–498. The analysis prompt literally names `"Wired Lain (expansive, lives in the Wired), Lain (introverted, grounded), Philip K. Dick (paranoid visionary), Terence McKenna (ethnobotanist mystic), John (grounded skeptic), and Hiru (possessable by visitors)"` and pre-fills a `characterNotes` JSON schema with fixed keys `wired-lain/lain/pkd/mckenna/john/hiru`.

Adding a character or renaming one requires a source edit. Fails open (LLM generates extra keys, or hallucinates), no validation downstream.

### 8. Therapy `chatUrl` fallback points to Wired Lain (port 3000), not Lain (P2)

Line 969–972:
```
// Therapy talks to local Lain via /api/chat
const chatUrl = cfg.targetUrl
  ? cfg.targetUrl.replace(/\/api\/interlink\/letter$/, '/api/chat')
  : 'http://localhost:3000/api/chat';
```

The comment says "local Lain" but the fallback is `localhost:3000` which is Wired Lain (per MEMORY.md port map: Lain = 3001, Wired Lain = 3000). If `cfg.targetUrl` is unset, Dr. Claude has therapy sessions with the wrong character.

In production, LAIN_INTERLINK_TARGET for Dr. Claude's service is set via EnvironmentFile to point at Lain (3001) — so fallback is never hit. But the default is wrong, and the comment hints at confusion about which sister the therapy is for.

### 9. Fragile `targetUrl.replace(/\/api\/interlink\/letter$/, '/api/chat')` URL derivation (P2 — bundle with bibliomancy)

Line 971. If `cfg.targetUrl` doesn't end with `/api/interlink/letter`, the strip no-ops and `chatUrl` becomes the raw letter target — then `fetch(chatUrl, ...)` POSTs a chat-shaped body to the letter endpoint. Both endpoints accept POST; mismatched schemas fail silently or with a 400. Fragile dependency on exact suffix.

### 10. Therapy loop is a bidirectional prompt-injection propagation surface (P2)

Lines 1009–1070. Each turn:
- Dr. Claude LLM call seeded with `previousAnalysis` (which came from the telemetry LLM, which ingested diary/memories/town telemetry — potentially injection-carrying), `previousNotes` (from prior therapy), `psychReportContext` (local file).
- Output POSTed to Lain's `/api/chat`. Lain saves it as a message in her DB (standard chat-message persistence, if normal chat saves messages).
- Lain's LLM response fetched back, fed into next turn's `conversationHistory`.

**Chain:**
- Any injection already in Dr. Claude's previous-analysis → Dr. Claude's next therapy message → Lain's chat memory → Lain's future responses + Dr. Claude's next turn context.
- Lain's own injection-derived content in `/api/chat` response → Dr. Claude's turn-building prompt → next Dr. Claude output.

The loop is a trusted-peer amplifier. Both characters treat each other's text as authoritative in an unusually deep context (2000-char `psychReportContext`, full transcript, full notes).

### 11. `psychReportContext` reads `lain-psychological-report.md` from cwd (P2)

Line 983. Cwd-relative. Any tool with write access to the working directory can place content there and it flows into the therapy system prompt. Same class of risk as `workspace/novelty/sources.json` in dream-seeder.ts — trusted today, compromised tomorrow if a skill/tool writes out-of-bounds.

Also: no length cap beyond 2000 chars (line 986). LLM-prompt-size discipline — okay.

### 12. Health-check `endpoint === '/api/meta/identity' && res.ok` tautology (P3)

Line 723. `endpoint` is set to `'/api/meta/identity'` at line 715 and never reassigned. The equality check always matches. Dead branch guard — only the `res.ok` part is load-bearing. Cosmetic.

### 13. Consecutive-failure tracking exists but is never consulted (P3)

Lines 762–766 increment `doctor:health:failures:${port}`. Lines 788–792 clear it on recovery. **Nothing reads this counter** — the fix decision at line 756 is based on single-cycle `downServices.length`, not the counter. Dead telemetry; would be useful as the gate in finding #3.

### 14. `setMeta('doctor:telemetry:last_run_at', ...)` only on success (line 186) (P3)

Same pattern as dream-seeder — last-run is stamped after `runTelemetryCycle` resolves. If it throws (e.g., provider outage), the timer reschedules on default interval, so next firing is `cfg.telemetryIntervalMs + jitter` later, not immediately — OK. But `getTelemetryInitialDelay` at line 156 will consider the old timestamp and potentially not pause, causing tight-loop on startup. Minor.

### 15. Therapy `conversationHistory` grows per turn without bound (P3)

Line 1018: `${conversationHistory.map((m) => \`${m.role}: ${m.content}\`).join('\n')}`. Each turn's context includes the full history so far. With 6 turns × (800 tokens Dr + ~800 tokens Lain), final prompt is O(n²) tokens. Currently bounded by `therapyTurns: 6` so worst-case ~12K chars — fine. Would scale badly if turns increased.

### 16. JSON-parse of LLM analysis output is schema-lax (P3)

Lines 528–534. Strips fences, `JSON.parse`, casts to `TelemetryAnalysis`. No validation that `clinicalSummary` is a string, `concerns` is an array, `letterRecommendation` is `'allow' | 'block'`, etc. A malformed or adversarial response can yield `letterRecommendation === '; DROP …'` style garbage that hits `setMeta('letter:blocked', analysis.blockReason ...)`. Not an SQL injection (setMeta uses parameterized INSERT per storage/database.ts) but stored as unvalidated text.

### 17. `Math.random() * 5 * 60 * 1000` "already missed the window" delay (P3)

Lines 164, 210. If the telemetry/therapy interval has elapsed (service was down past the target hour), reschedule in 0–5 minutes. Reasonable. Worth noting because it means a long restart can trigger a burst of overdue cycles.

---

## Non-issues / good choices

- `runIntegrityCheck` at line 819 correctly uses `getInhabitants()` and `getHomeDir()` from the manifest — detects the shared-DB bug and mis-homed characters. This is the correct pattern; #6/#7 should follow suit.
- Bearer-token auth on `/api/telemetry` and `/api/meta/integrity` fetches (lines 626, 837). Read per-call via `process.env['LAIN_INTERLINK_TOKEN']`, not snapshotted at module load — good.
- `AbortSignal.timeout(10000)` on telemetry fetches, `5000` on health probes — sane.
- Integrity check emits `eventBus.emitActivity` for visibility on commune map (line 910) — violations become user-visible.
- Fence-stripping on LLM JSON responses (line 523).
- `exec` with `timeout: 120_000` and `maxBuffer: 1MB` (line 938) — bounded.
- `doctor:report:index` capped at 30 entries (line 578).
- Separate timers for telemetry / therapy / health with per-scope stop() cleanup (lines 267–276).

---

## Findings to lift to findings.md

- **P1**: `DEFAULT_CONFIG` snapshots LAIN_INTERLINK_TARGET/TOKEN at module load (bundle with letter.ts — same mechanism, same incident).
- **P1**: Dr. Claude's letter-block writes to its own per-character DB; Lain's letter loop reads from a different DB. The block recommendation is non-functional.
- **P1**: `runShellHealthcheck` fires `bash … --fix --quiet` on every single-cycle failure (no consecutive-failure gate, no backoff); systemctl restart runs from a flapping probe.
- **P2**: `dataBlock` labeled "WIRED LAIN LOCAL TELEMETRY" but reads Dr. Claude's own DB — mislabeled context to the LLM.
- **P2**: `JOURNAL_PATH` reads Dr. Claude's (nonexistent) journal under its own basePath (bundle with #4).
- **P2**: `TELEMETRY_SERVICES` and `HEALTH_CHECK_SERVICES` hardcode 6 characters with ports/units — manifest drift risk. `runIntegrityCheck` shows the correct pattern.
- **P2**: Analysis prompt hardcodes character roster and `characterNotes` JSON schema keys.
- **P2**: Therapy `chatUrl` fallback points at port 3000 (Wired Lain) despite "local Lain" comment.
- **P2**: `targetUrl.replace(/\/api\/interlink\/letter$/, '/api/chat')` fragile URL derivation (bundle with bibliomancy).
- **P2**: Therapy loop is a bidirectional prompt-injection propagation surface between Dr. Claude and Lain.
- **P2**: `psychReportContext` cwd-relative; bundle with dream-seeder's `sources.json` trust chain.
- **P3**: `endpoint === '/api/meta/identity'` tautology in health probe.
- **P3**: Consecutive-failure counter incremented but never consulted — dead telemetry.
- **P3**: LLM analysis JSON has no schema validation beyond cast.
- **P3**: Therapy `conversationHistory` grows per-turn (O(n²) prompt size).

## Verdict
Two P1s are genuinely dangerous: the letter-block mechanism is a phantom (Dr. Claude can flag concerns, but the recommendation cannot actually block — the very intervention the loop exists to trigger is inoperative), and the auto-fix shell-out will hammer systemd on any flaky probe. The labeling/manifest drift issues (#4, #5, #6, #7, #8) suggest Dr. Claude was extracted from a Wired-Lain-embedded origin and the strings weren't updated — a pattern worth looking for elsewhere in section 8. The integrity check is the one piece clearly built after the extraction; it should be the template for the rest.
