---
file: src/web/doctor-server.ts
lines: 499
purpose: Dr. Claude's self-contained HTTP server (default port 3002). Uses its own ad-hoc chat loop (not the agent runtime) with doctor-specific diagnostic tools. Reads the shared database for telemetry. No background loops. In-memory session history per sessionId.
section: 9 (web)
audit-date: 2026-04-19
---

# web/doctor-server.ts

## Function inventory (5)
- `runDoctorChat(provider, systemPrompt, sessionId, userMessage, onChunk?)` — 60: own tool-loop (MAX_TOOL_ITERATIONS=6).
- `handleChat(provider, systemPrompt, body)` — 199.
- `handleChatStream(provider, systemPrompt, body, res)` — 217.
- `serveStatic(path)` — 253: regex-based path-traversal guard (same pattern as character-server).
- `startDoctorServer(port)` — 270: exported; main entry.

## Route inventory
- `GET /api/location` 331 — **hardcoded** `{ location: 'school', row: 1, col: 2 }` (no real location read).
- `GET /api/meta/identity` 345 — hardcoded `{ id: 'dr-claude' }`.
- `GET /api/events` 352 — public SSE stream of background events.
- `GET /api/activity` 375 — public 7-day activity history.
- `POST /api/chat/stream` 388 — owner-auth'd SSE chat.
- `POST /api/chat` 411 — owner-auth'd chat.
- Static file serving with owner gate on HTML.

## Findings

### 1. `/api/location` is hardcoded — real location never queried (P2)

Line 331-342. Returns `{ location: 'school' }` with `row: 1, col: 2` for all time. Doctor never appears to move.

Cross-references:
- Section 8 desires.ts / town-life.ts expect `getCurrentLocation(char.id)` to reflect the character's actual building.
- Main server.ts `/api/relationships` aggregator (line 681-688) doesn't include dr-claude in its port map, so this hardcoded location isn't aggregated anywhere — cosmetic for now.
- If Dr. Claude's location ever does change (via desires loop from a future refactor), this hardcoded endpoint will report stale data. Silent divergence.

Character-server.ts has the proper `getCurrentLocation(config.id)` read (line 312). Doctor-server was not refactored when location tracking was generalized.

**Fix**: use `getCurrentLocation('dr-claude')` like other characters.

### 2. `runDoctorChat` maintains own in-memory session map — no persistence (P2)

Lines 49, 68-72, 187-190. `sessions: Map<string, Message[]>` is in-memory only. On restart, all Dr. Claude conversation history is lost. No memory persistence, no diary, no self-concept — Dr. Claude is effectively stateless across restarts.

This is a design choice (the header says "independent; shares Lain's database for telemetry access"). But it means:
- Every conversation is a cold start; no context from prior sessions.
- The `MAX_TOOL_ITERATIONS = 6` cap is per-call, so a session can accumulate 40 messages (line 187 trim) each with tool history, but nothing persists.
- The 40-message trim at line 187-190 isn't a hard cap — a single very-long message (20KB LLM response) lives until trimmed to position >40 messages. No token/size cap.

**Consequence**: memory cost grows unboundedly per session. An attacker with owner cookie can create many sessionIds (line 205: `sessionId = request.sessionId || nanoid(8)`, but caller can supply arbitrary sessionId) and accumulate memory usage across many parallel sessions. No session-count cap, no TTL, no expiry.

**Fix**: add a session-count cap and TTL (e.g., 24-hour idle expiry).

### 3. `sessionId` is caller-chosen and un-authenticated to a specific caller (P3)

Line 205, 224: `sessionId = request.sessionId || nanoid(8)`. Two owner-auth'd callers could race on the same sessionId and interleave each other's conversation history. Since owner auth is a single cookie and all owner traffic comes from the same logical person, low severity.

### 4. No body size cap (P2 — bundle with character-server finding #1)

Lines 394-406 and 417-430. `body += chunk.toString()` in a `data` handler with no size check. Unbounded. Owner-auth gate means only owner-cookie holders can trigger this, so severity is lower than character-server (where peer characters can trigger it unauth'd). Still: an XSS or CSRF bug elsewhere that reaches owner-auth would allow OOM here.

### 5. `serveStatic` regex path-traversal guard (P2 — bundle with character-server finding #2)

Line 255. Same weaker-than-main-server pattern. `path.replace(/\.\./g, '').replace(/^\/+/, '')`. Bypass class same as character-server.

### 6. CORS wildcard hardcoded (P2 — bundle with character-server finding #6)

Line 320. `Access-Control-Allow-Origin: '*'`. No env override. SSE `/api/events` and `/api/activity` leak to any cross-origin caller.

### 7. No security headers (P2 — bundle with character-server finding #7)

No CSP, no frame-deny, no nosniff, no referrer-policy. Same as character-server.

### 8. No rate limiting (P2)

Owner-only auth on chat endpoints. Compromised owner cookie = unlimited chat calls drawing from Anthropic budget. Bundle with budget.ts post-call-check finding.

### 9. Owner cookie checked via `isOwner(req)` from shared `owner-auth.ts` (positive, line 389, 412, 439)

Consistent with other servers. Owner cookie is HMAC-derived from LAIN_OWNER_TOKEN — same secret across main/character/doctor servers.

### 10. `loadPersona` reads `workspace/doctor` (line 290-291)

Hardcoded `join(process.cwd(), 'workspace', 'doctor')`. Uses `process.cwd()` — depends on where the process is started from. If run from `/opt/local-lain/`, looks at `/opt/local-lain/workspace/doctor/`. Fine under systemd. But not `getBasePath()`-isolated — Dr. Claude's persona is shared across all deployments of this codebase, not per-character-home-path.

**Cross-ref**: Section 8's `persona.ts` audit and the per-character DB isolation primitive. Doctor's persona being source-controlled (rather than per-home-path) is fine, but it means editing `workspace/doctor/SOUL.md` on droplet requires a deploy.

### 11. `executeDoctorTools` / doctor-tools not audited here (covered by Section 8)

The tool-call loop (line 108-153) invokes `executeDoctorTools(currentToolCalls)`. The tools include shell access per the banner on line 484: "Tools: diagnostics, telemetry, file ops, shell". High-trust; only Dr. Claude's LLM can trigger. Per Section 8 doctor-tools audit, the tools are the main attack surface if Dr. Claude's LLM context is poisoned.

Doctor's context comes from:
- Owner-typed chat (trusted)
- Tool results (reflected into context at lines 147-152; truncated to 2000 chars)

No cross-character input (peer messages, letters, dream seeds) reaches Dr. Claude's context via this server. Isolation is stronger than other characters.

### 12. Uses `createProvider(providerConfig)` directly (line 284) — no fallback chain (P3)

Unlike character-server (line 212-219 with `DEFAULT_FALLBACKS`), doctor-server uses only the primary model config. If Anthropic's Sonnet is deprecated or rate-limited, Dr. Claude's chat breaks. No fallback.

**Cross-ref**: Section 8's budget.ts and character-server's fallback chain.

### 13. `activityEvents` SSE stream shared with eventBus global (P3)

Line 352-372. Handler listens on `eventBus.on('activity', ...)`. Since `eventBus` is a global singleton imported from `events/bus.js`, Dr. Claude's server listens to activity events emitted by any loop running in this process. But Dr. Claude has NO background loops (only runs startCharacterServer equivalents for itself). So the event bus in doctor-server is empty, and the SSE stream is perpetually heartbeat-only.

Unless... the eventBus state is process-wide but emit source is whatever's imported. Since doctor-server doesn't import `startDiaryLoop` etc., nothing emits on this bus. Dead stream.

The public can watch the `/api/events` stream and see nothing. Harmless but misleading.

### 14. `shared database with Lain` (P2)

Line 5 comment and line 276 `initDatabase(paths.database)`. Dr. Claude reads and writes to Lain's database. Cross-references:
- Dr. Claude reads `getActivity()` from main database (line 381).
- Dr. Claude's tools (per Section 8) may write memories, run SQL, etc.
- Deploy note in CLAUDE.md: each character has its own `.lain*/lain.db`. So "shared with Lain" means doctor-server uses `getBasePath()` which is `/opt/lain/.lain-dr/`. Let me verify — actually `paths.database` goes through `getPaths()` which uses `getBasePath()` (Section 2 audit). So Dr. Claude's DB is isolated if `LAIN_HOME=/root/.lain-dr/` is set on the process.

**But**: the file header claims "Shares Lain's database for telemetry access". This is either a stale comment or a deployment detail where LAIN_HOME is deliberately NOT set for Dr. Claude → defaults to Lain's `~/.lain/`. If that's true, Dr. Claude's chat history (if it were persisted) and tool writes go into Lain's DB.

Per CLAUDE.md memory: "CRITICAL: `.env` must NOT set LAIN_HOME (it overrides per-service LAIN_HOME and causes shared DB bug)". Previous shared-DB bugs exist. If doctor-server isn't deployed with `LAIN_HOME=/root/.lain-dr/`, it shares Lain's DB.

**Action**: verify deployment — but per file header, sharing is intentional. Bundle with Section 7 database isolation findings if relevant.

### 15. `workspace/doctor/` persona load uses `process.cwd()` (P2 — bundle with #10)

If `process.cwd()` isn't the project root, persona load fails silently. Doctor-server has no test for this.

### 16. `sessions` map leaks across reconfigured personas (P3)

If the persona is hot-reloaded (not supported today), old sessions still carry the old systemPrompt reference only via the messages array (line 78 passes current systemPrompt in). Actually, systemPrompt is included ONLY in the current request's messages construction (line 78). Old history is `{role, content}` pairs without systemPrompt. So hot-reload works — but hot-reload isn't implemented.

### 17. Unused `loadPersona` fields? (P3)

`persona` has soul/agents/identity (line 294-306). Doctor-server uses all three in systemPrompt. Full persona is loaded. No gap.

### 18. No interlink auth variant (P2)

Unlike main server and character-server, doctor-server exposes no interlink endpoints (`/api/peer/message`, `/api/interlink/letter`, etc.). Dr. Claude is not part of the commune-peer message flow. This is an architectural choice consistent with Dr. Claude being a player-facing diagnostic tool, not a fellow inhabitant.

**But**: Section 8 `commune-loop.ts` / `desires.ts` flagged that Dr. Claude was missing from the hardcoded `charPorts` map in main server's `/api/relationships`. That's consistent with this — Dr. Claude is not a peer, doesn't participate in conversations, doesn't have commune-history. The "missing from relationships map" is actually correct. Cross-section correction: downgrade that specific concern.

**Cross-reference correction for Section 8**: the `dr-claude` gap in `/api/relationships` hardcoded port map is intentional, not a bug. Dr. Claude doesn't do commune conversations.

### 19. Heartbeat interval leak on disconnect (positive, line 364-369)

`req.on('close')` clears both the event handler and the heartbeat interval. Correct cleanup.

### 20. No `healthcheck` endpoint (P2)

Main server has `/api/health`. Character-server has `/api/health`. Doctor-server does not. `./deploy/status.sh` probes every service — if it expects `/api/health` on port 3002, it fails for Dr. Claude.

Let me not speculate on that; but the consistency gap is real.

### 21. Owner HTML gate but no owner-only routing on `/api/activity` (P3)

Line 375-385: `/api/activity` returns 7-day activity history publicly. On main server this is also public. But main server filters background events only for SSE. Doctor-server doesn't filter `/api/activity` — if any Dr. Claude-process event emit occurred (which per finding #13 doesn't happen), it would leak.

## Non-issues / good choices
- Owner-auth on chat endpoints via shared `isOwner`.
- In-memory-only session state means no PII persists.
- Tool iteration cap (MAX_TOOL_ITERATIONS=6) prevents tool-loop runaway.
- Tool results truncated to 2000 chars before reinjection (line 150).
- Graceful SIGINT/SIGTERM shutdown.
- Strong persona isolation (no peer message, no letter, no dream seed).

## Findings to lift
- **P2**: `/api/location` hardcoded to school; stale if location tracking changes.
- **P2**: In-memory session map with no TTL or count cap — DoS amplifier.
- **P2**: No body size cap on chat POSTs.
- **P2**: `serveStatic` regex path-traversal guard (bundle with character-server).
- **P2**: CORS wildcard hardcoded (bundle).
- **P2**: No security headers (bundle).
- **P2**: No rate limiting (bundle).
- **P2**: No `/api/health` (bundle: deploy-probe inconsistency).
- **P2**: `workspace/doctor/` persona path uses `process.cwd()` instead of `getBasePath()`.
- **P3**: No model fallback chain.
- **P3**: Dead SSE activity stream (no background loops emit).
- **P3**: `sessionId` caller-chosen.

## Cross-section correction
- The "Dr. Claude missing from /api/relationships" concern in Section 8 / main server finding #3 is INTENT — Dr. Claude is not a commune-peer. Downgrade that portion.

## Verdict
Dr. Claude runs a self-contained, minimal, owner-only chat server with NO cross-character surface area. The isolation is excellent — no peer messages, no letters, no dream seeds reach Dr. Claude's LLM context. The trade-offs are: no persistent memory (cold start every session), no location updates (hardcoded to school), no rate limiting, no body caps, no fallback model. Severity is bounded by owner-only auth, but the in-memory `sessions` map with no TTL or count cap is a meaningful DoS vector for a compromised owner cookie. The `/api/location` hardcode is a latent bug — if the desires/town-life loops ever start moving Dr. Claude, observers will see stale "at school" for all time.
