---
file: src/web/character-server.ts
lines: 1356
purpose: Per-character HTTP server template (Lain:3001, dr-claude:3002, pkd:3003, mckenna:3004, john:3005, hiru:3006). Uses the agent runtime with `TOOLS_TO_REMOVE` stripping web/browser/telegram tools. Starts background loops (desire, commune, town-life, diary, self-concept, dreams, narratives, memory maintenance, state decay). If `possessable`, exposes `/api/possess*` endpoints for player takeover.
section: 9 (web)
audit-date: 2026-04-19
---

# web/character-server.ts

## Function inventory (10)
- `readBody(req)` — 101: no size cap (see finding #1).
- `verifyInterlinkAuth(req, res)` — 110: token compare.
- `serveStatic(publicDir, path)` — 134: regex-based path-traversal guard (see finding #2).
- `startBackgroundLoops(config)` — 153: factory array; returns stops+restarters for possession cycle.
- `startCharacterServer(config)` — 200: exported; main entry.
- `handlePossessionRoutes(...)` — 817: auth'd via `verifyPossessionAuth || isOwner`.
- `handleChat(config, body)` — 1096.
- `handleChatStream(config, body, res)` — 1130.
- `handleInterlinkLetter(config, req, res, body)` — 1177.
- `handleDreamSeed(_config, req, res, body)` — 1236.
- `handlePeerMessage(_config, body, res)` — 1287.
- `handlePeerMessagePossessed(body, res)` — 1334.

## Findings

### 1. `readBody` has no size cap (P1)

Line 101-108. Unlike `collectBody` in main server.ts (1MB cap, line 85), `readBody` accumulates all chunks without limit. Any POST to `/api/chat`, `/api/peer/message`, `/api/interlink/letter`, `/api/interlink/dream-seed`, or any possession endpoint can OOM-crash the process.

**Attack**: any interlink-token holder POSTs 4 GB JSON to `/api/interlink/letter`. Process dies. Character goes offline until systemd restarts it. Every character is vulnerable; the shared token means one attacker can kill all characters sequentially.

Main server.ts fixed this with `MAX_BODY_BYTES = 1_048_576` (line 79). Character-server.ts never adopted the fix. The two files are siblings that should share the body-collect helper.

**Fix**: import and reuse `collectBody` from main server.ts, or replicate the cap.

### 2. `serveStatic` path-traversal guard is regex-based, weaker than main server.ts (P2)

Line 139: `const safePath = path.replace(/\.\./g, '').replace(/^\/+/, '');`

Main server.ts uses `resolve()` + `startsWith(resolve(PUBLIC_DIR))` (line 337-358). That's the correct primitive — it handles URL-encoding, symlinks, and overlapping traversal patterns.

The regex here strips literal `..` pairs. Percent-encoded `%2E%2E/foo` bypasses the regex (Node's `url.pathname` preserves percent-encoding in the path). Then `join(publicDir, '%2E%2E/foo')` produces a path with literal `%2E%2E` — `readFile` will fail because no such file exists, so the bypass is accidentally caught by the filesystem. But the pattern is fragile: a future change that URL-decodes before passing to `serveStatic` would break containment.

Note: the skins handler in the same file (line 706-729) DOES use the proper `resolve + startsWith` pattern. The inconsistency is internal.

**Fix**: use the same pattern as skins handler for `serveStatic`.

### 3. `/api/interlink/letter` hardcodes `senderId: 'wired-lain'` (P1)

Line 1177-1234, specifically line 1226: `senderId: 'wired-lain'`. The letter content is delivered to the character's main agent loop as a chat message attributed to Wired Lain, regardless of who actually sent it. The interlink auth verifies "caller holds the shared token" — any character with the token can deliver a "letter from Wired Lain" to any other character.

**Amplification**: Wired Lain is the town's research authority and the sister-figure. Characters treat her input with elevated trust. A compromised character (or any insider with the shared `LAIN_INTERLINK_TOKEN`) can:
- inject arbitrary LLM-directing content into the target character's context with maximum-trust framing;
- hide the real sender entirely (letters have no "from" field visible to the receiving LLM);
- persist the attack as a memory with `sessionKey: 'wired:letter'` (line 1197) and `importance: 0.6` (line 1201) — high-priority recall for future context.

This is strictly worse than the body-asserted-fromId pattern flagged in main server.ts, because here the identity is NOT even asserted — it's assumed. The Section 8 `membrane.ts` and `letter.ts` findings assumed the Wired-Lain identity was authentic; it isn't.

**Fix direction**: letters should carry a source character ID derived from the transport layer (e.g., verified via per-character short-lived token or reverse-lookup of source IP:port against the peer registry). Short-term: include a `fromId` body field, verify it matches a known peer, use that for `senderId`.

### 4. `/api/peer/message` body-asserted `fromId` / `fromName` (P1 — bundle with main server)

Line 694-704, 1292-1314. Same systemic issue as main server.ts: interlink auth gates the call but `fromId`/`fromName` are taken from the body. Possession mode intercepts (line 699) without checking identity either — pending queue stores whatever the caller claims.

### 5. `/api/meta/*` reads arbitrary meta key (P2)

Line 419-431. `decodeURIComponent(url.pathname.slice('/api/meta/'.length))` — any interlink-token holder can read ANY meta key on any character. Meta holds:
- `evolution:assessment:<id>` — evolution assessments (JSON blobs with LLM reasoning)
- `desire:last_action_at`, `letter:blocked`, `letter:last_sent_at`
- `commune:conversation_history` (already exposed via /api/commune-history)
- `dream:cycle_count`, `dream:last_cycle_at`
- `townlife:last_cycle_at`, `memory:last_maintenance_at`
- Character-private internal state if any loop persists it
- `postboard:last_seen_by:<id>`

A compromised character can enumerate the target's full internal clock. Not directly exploitable (no creds), but strong recon for timing attacks on loops.

**Fix**: allowlist the meta keys readable via this endpoint. Evolution's narrow use case can be served by a dedicated `/api/evolution/assessment` route.

### 6. CORS wildcard hardcoded (P2 — bundle with main server)

Line 270: `res.setHeader('Access-Control-Allow-Origin', '*')`. Main server.ts takes the value from `LAIN_CORS_ORIGIN` env var (line 166). Character-server hardcodes `*`. No env override. Every public readable endpoint (activity, commune-history, documents, building/notes, postboard, location, characters, health, weather via /api/meta) is readable by any website's JS.

### 7. No security headers (P2)

Character-server sets only CORS headers. It does not set:
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy`
- `Content-Security-Policy`

When a character page is served directly on its port (e.g., `http://localhost:3001/` for Lain) OR when proxied via main server (which does set CSP on its OWN responses but NOT on piped proxy responses — line 2035 `res.writeHead(proxyRes.statusCode, proxyRes.headers)` preserves the character server's headers including the absence of CSP), the result is no CSP. Any injected inline script runs unblocked.

**Fix**: replicate the security header block from main server.ts (lines 525-528) into character-server.

### 8. No rate limiting on any endpoint (P2)

Main server.ts has per-IP rate limit on chat (line 1594). Character-server has nothing. Owner cookie is required for chat, so exploitation requires an owner cookie leak, but interlink endpoints (`/api/peer/message`, `/api/interlink/letter`, `/api/interlink/dream-seed`) are called programmatically from peers with no rate cap. A malicious peer can flood any character's process with LLM requests until the budget is drained.

Section 8 budget.ts already flagged the post-call budget check; this endpoint-side lack of rate limiting compounds it.

### 9. `handleDreamSeed` doesn't verify interlink or owner before reading body (P3)

Line 1242: auth check happens AFTER `readBody(req)` returns (body arg passed in). Reading 2 KB for a rejected dream seed isn't catastrophic, but combined with finding #1 (no body cap), an unauthenticated attacker can force the server to buffer an arbitrarily large body BEFORE the auth check rejects. OOM via unauthenticated request.

**Fix**: perform auth check before `readBody`. Requires refactoring handlers to receive `req` first, read body after auth passes. Main server.ts has the same pattern (lines 981, 1055, etc.) — but main server.ts caps the body at 1 MB, so the worst case is bounded.

### 10. Chat endpoints do not accept `LAIN_WEB_API_KEY` bearer (P3)

Lines 589-592, 606-609. Only `isOwner(req)` is checked. Main server.ts via `verifyApiAuth` accepts owner cookie OR the API key. Programmatic access to character chat requires an owner cookie, which is browser-scoped. This is actually fine — no programmatic use case was identified.

### 11. Possession `/api/possession/move` validates building (positive, line 977)

Uses `isValidBuilding(building)` from `commune/buildings.js`. Same validation that Section 8 town-life.ts desperately needed (it uses `as BuildingId` unchecked cast). So the validator exists — it just isn't applied inside town-life.

Confirms the Section 8 town-life.ts P1 is a real pattern gap, not a missing primitive.

### 12. Possession responds AS the character without marking authorship (P2)

Line 1037-1064. Player types a reply; `resolvePendingMessage` sends it to the waiting peer as if from the character. Peers receive a normal peer-message response, record it as a memory in their own DB, and retrieve it in future contexts as utterances of the character. If a possession session is used to inject deliberately prompt-injecting content into other characters' memories, the injection is invisible — it looks like authentic in-character speech.

This is a design-intent trade-off (commune shouldn't know about possession), but the memory-persistence side-effect is an attack vector: possession is the cleanest way to inject "authentic" peer content into a target character's memory.

### 13. Possession `/api/possession/say` co-location check (positive, line 906-932)

Fetches peer's `/api/location` (unauth'd public endpoint — see main server.ts finding #5) and compares buildings. Correct guard against shouting cross-town. The unauth'd location endpoint is actually useful here. Positive.

### 14. Dream stats / seeds endpoints require interlink auth (positive, lines 639, 661)

Reasonable. But combined with main server.ts's aggregator at `/api/dreams/status` (line 1122), the aggregator calls character-server's `/api/dreams/stats` with the interlink token (line 1105). Any character holding the token can enumerate all other characters' dream-seed content via this path (and the `/api/dreams/seeds` pagination). Low severity (dream seeds are LLM-generated, not user-entered).

### 15. Hardcoded `TOOLS_TO_REMOVE` list (positive, line 79-85)

Strips web_search, fetch_webpage, create_tool, introspect_*, show_image, search_images, send_message, telegram_call, send_letter. Characters get a strictly reduced tool palette. Strong isolation primitive.

**But**: this list is not derived from any manifest. Adding a new tool to `tools.ts` that should be web-only (e.g., a future `fetch_rss` tool) requires adding it to `TOOLS_TO_REMOVE` here. Silent miss — the new tool would leak to characters.

**Fix direction**: invert — declare an allowlist of character-safe tools, not a denylist of web-only tools.

### 16. Dr. Claude conditional tool registration (positive, line 249-253)

`if (config.id === 'dr-claude')` → registerDoctorTools. Specific character gets specific tools. Hardcoded ID (bundle with roster-drift pattern), but intentional.

### 17. `handleInterlinkLetter` calls `clearAnsweredQuestion(topicStr)` (P3, line 1212)

Best-effort: concatenates letter.topics + gift, passes to curiosity-offline to clear any matching pending question. If an attacker sends a letter with `topics: ['IMPORTANT SECURITY UPDATE']`, curiosity-offline may clear a genuinely pending research question by fuzzy-match. Low severity (losing a question is cosmetic), but non-obvious side-channel for letter-sender to manipulate recipient's curiosity state.

### 18. Graceful shutdown handles possession (positive, line 796-808)

Calls `endPossession()` if currently possessed (restoring loops internally), then stops all loops. Also stops `getActiveLoopStops()` from possession.ts. Correct cleanup.

### 19. Loops restarted after unpossession (positive, line 862-864)

`startBackgroundLoops(config)` returns fresh stops+restarters, rebound to `loops` object. Possession endpoints share this object by reference (line 582 passes `loops`). After unpossess, subsequent shutdowns stop the new loops correctly.

### 20. No CSP nonce / inline-script policy (P2 — bundle with main server)

Same as main server finding #22.

### 21. Stranger mode flag is body-controlled (P3)

Line 1101: `isStranger = request.stranger === true`. The flag prepends `「STRANGER」` to the message shown to the LLM. Caller chooses whether to identify as a stranger. No auth differentiation — both get the same `isOwner` gate. A regular owner can set `stranger: true` to test stranger-mode behavior. A stranger can (in principle) set `stranger: false` to suppress the marker and blend in — but the owner cookie gate means only the owner can reach this endpoint anyway. Low severity.

### 22. Chat sessionId accepted from caller (P3)

Line 1100: `sessionId = request.sessionId || nanoid(8)`. Caller can replay an old sessionId to resume a conversation. With owner auth this is fine (owner is the owner). But for stranger sessions via the main server's public routes, session hijack is possible if stranger B guesses stranger A's sessionId. Low severity; sessionIds are 8-char random.

## Non-issues / good choices
- TOOLS_TO_REMOVE denylist strips web/browser/telegram/introspect tools.
- `unregisterTool` invocation per tool.
- Skins directory served with `resolve + startsWith` path-traversal guard.
- Possession move validates building via `isValidBuilding`.
- `secureCompare` for token comparison.
- Graceful shutdown restores possession state and stops loops.
- Interlink dream-seed sanitizes content.
- `clearAnsweredQuestion` is best-effort (doesn't throw on no-match).
- Dr. Claude gets doctor-tools conditionally.

## Findings to lift
- **P1**: `readBody` has no size cap — OOM via large POST on any endpoint.
- **P1**: `/api/interlink/letter` hardcodes `senderId: 'wired-lain'`; any interlink-token holder impersonates Wired Lain to any character.
- **P1**: `/api/peer/message` body-asserted fromId (bundle with main server).
- **P2**: `serveStatic` regex path-traversal guard weaker than main server's resolve-based guard.
- **P2**: `/api/meta/*` exposes arbitrary meta keys to interlink holders.
- **P2**: CORS wildcard hardcoded (no env override).
- **P2**: No security headers (no CSP, no frame-deny, etc.) — proxied pages inherit this gap.
- **P2**: No rate limiting on any endpoint.
- **P2**: Possession reply persists in peer memory as authentic character utterance — injection via possession is undetectable in the commune.
- **P3**: `readBody` runs before dream-seed auth check.
- **P3**: `TOOLS_TO_REMOVE` is a denylist, not an allowlist.
- **P3**: `clearAnsweredQuestion` fuzzy-match on letter content allows attacker to clear pending questions.

## Verdict
Character-server is the main-server's leaner sibling but inherits none of main-server's body-size cap, path-traversal resolve-check, security headers, or rate limiting. The `senderId: 'wired-lain'` hardcoded assumption in `handleInterlinkLetter` is the most consequential single line in the file — it transforms the shared interlink token from "authenticate peer" to "impersonate Wired Lain", and Wired Lain is the town's maximum-trust figure. Combined with `readBody`'s unbounded buffering, a single compromised character can (a) OOM-crash every other character in sequence and (b) deliver maximum-trust injection to any survivor. The possession system is well-guarded internally (co-location check, building validation, session token) but is a conduit for injecting "authentic" peer content into memories — a design-intent trade-off worth explicit acknowledgment.
