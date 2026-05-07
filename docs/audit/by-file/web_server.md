---
file: src/web/server.ts
lines: 2452
purpose: Main HTTP server (default port 3000 = Wired Lain, 3001 = Lain). Hosts chat API, SSE streams, commune/dreams/evolution/objects/postboard/town-events endpoints, static file serving with nav injection, proxy to per-character servers (`/local/`, `/dr-claude/`, etc.), interlink endpoints (letter, dream-seed, research-request). Starts background loops.
section: 9 (web)
audit-date: 2026-04-19
---

# web/server.ts

## Function inventory (14 top-level)
- `debugLog(context, data)` — 65: local file log.
- `collectBody(req, maxBytes)` — 85: 1MB cap.
- `verifyApiAuth(req, res)` — 112: owner cookie OR LAIN_WEB_API_KEY bearer.
- `checkRateLimit(ip)` — 153: 30 req/min per IP.
- `handleChat(body)` — 213.
- `handleChatStream(body, res)` — 262: SSE.
- `serveStatic(path)` — 337: path-traversal-guarded static.
- `serveFromDir(baseDir, path)` — 361: same pattern, skins dir.
- `verifyInterlinkAuth(req, res)` — 396: LAIN_INTERLINK_TOKEN bearer.
- `generateNavBar(pathname, ownerMode)` — 443.
- `injectNavBar(html, pathname, ownerMode)` — 474.
- `startWebServer(port)` — 492: exported; main entry.
- `parseDdgHtml(html)` / `parseDdgLite(html)` — 2199 / 2215.
- `webSearch(question)` — 2236: DDG → DDG-lite → Wikipedia fallback.
- `handleResearchRequest(params)` — 2303: background research + letter delivery.

## Route inventory (by auth class)

### Public / no auth (GET)
- `/api/health` 537
- `/api/characters` 548 — manifest
- `/api/weather` 634
- `/api/meta/identity` 648
- `/api/location` 594
- `/api/commune-history` 657 — **reads full conversation history**
- `/api/relationships` 671 — aggregator; hardcoded char-ports 681-688
- `/api/activity` 921 — 7-day activity history
- `/api/building/notes` 933
- `/api/documents` 949 — **all character-authored documents**
- `/api/postboard` 968 — GET only
- `/api/town-events` 1037
- `/api/town-events/effects` 1046
- `/api/events` 898 — SSE broadcast of background events
- `/api/buildings/:id/residue` 1387
- `/api/objects`, `/api/objects/:id` 1406, 1423
- `/api/conversations/stream` 1310 — SSE
- `/api/conversations/recent` 1333

### Owner-or-interlink (mixed)
- `/api/meta/integrity` 777 — `isOwner || verifyInterlinkAuth`
- `/api/telemetry` 837 — same pattern
- `/api/internal-state` 618 — interlink-only
- `/api/interlink/dream-seed` 1780 — `isOwner || verifyInterlinkAuth`

### Interlink-only (POST/body-trust)
- `/api/peer/message` 1647 — **fromId/fromName body-asserted**
- `/api/objects` POST 1437 — **creatorId body-asserted**
- `/api/objects/:id/pickup` 1464 — **characterId body-asserted**
- `/api/objects/:id/drop` 1492 — **characterId body-asserted**
- `/api/objects/:id/give` 1514 — **fromId body-asserted**
- `/api/objects/:id` DELETE 1542 — **characterId body-asserted**
- `/api/buildings/:id/event` 1347 — **actors[] body-asserted**
- `/api/conversations/event` 1270 — **speakerId body-asserted**
- `/api/interlink/letter` 1697
- `/api/interlink/research-request` 1854 — Wired-Lain only, **replyTo body-asserted**

### Owner-only (verifyApiAuth — owner cookie or API key)
- `/api/chat` 1619 / `/api/chat/stream` 1592
- `/api/postboard` POST 978, DELETE 1010, pin 1025
- `/api/town-events` POST 1053, end 1087
- `/api/dreams/status` 1122, `/api/dreams/seeds` 1153
- `/api/evolution/lineages` 1210, `/api/evolution/status` 1219
- `/api/feeds/health` 1251
- `/api/budget` 1259
- `/api/internal/embed` 1570
- `/api/system` 1937 — `isOwner` only (not verifyApiAuth)

## Findings

### 1. Body-asserted `fromId`/`characterId`/etc. across interlink endpoints — systemic P1

`LAIN_INTERLINK_TOKEN` is a **single shared env var across all character processes** (per `deploy/env/*.env` and CLAUDE.md). Bearer auth verifies "caller holds the shared token" — NOT "caller is who they claim to be". Every interlink endpoint that writes identity-bearing state trusts a body field:

| Route | Trusted body field | Line |
|-------|------|------|
| `POST /api/peer/message` | `fromId`, `fromName` | 1651 |
| `POST /api/objects` | `creatorId`, `creatorName` | 1441 |
| `POST /api/objects/:id/pickup` | `characterId`, `characterName` | 1475 |
| `POST /api/objects/:id/drop` | `characterId` | 1497 |
| `POST /api/objects/:id/give` | `fromId`, `toId`, `toName` | 1525 |
| `DELETE /api/objects/:id` | `characterId` | 1553 |
| `POST /api/buildings/:id/event` | `actors[]` | 1358 |
| `POST /api/conversations/event` | `speakerId`, `listenerId` | 1275 |
| `POST /api/interlink/research-request` | `characterId`, `replyTo` | 1882 |

**Consequence chain**: any single character-process compromise (via prompt injection reaching one of the seven `executeTool` channels in town-life.ts, or via experiments.ts sandbox escape, or via a persisted memory that tricks an LLM into calling a tool) = that process holds the shared token = can impersonate any other character across every write endpoint. `peer/message` in particular feeds the asserted identity directly into `processMessage()` as `senderId` (line 1670), so the receiving character genuinely believes the spoofed identity. Conversation-event spoofing poisons the public SSE stream (`/api/conversations/stream`) that the commune map and anyone watching in a browser consumes.

**Elevates Section 8 concerns**: desires.ts → commune-loop.ts → `/api/peer/message` round-trip was assumed to carry the sender's actual identity. It doesn't; it carries whatever the sender types.

**Fix direction**: derive sender identity from a per-character secret (not the shared token) OR accept a second short-lived signed identity token from each character, verified at the server's known port-to-id map. Short-term mitigation: at minimum, the receiving server could cross-verify `fromId` against the source IP/port and reject body-asserted identities that don't match the known peer. The hardcoded port map at line 681-688 and 2007-2014 already exists — could be reused as the "trusted identity directory".

### 2. CORS default wildcard `*` with credentials off (P2)

Line 166: `CORS_ORIGIN = process.env['LAIN_CORS_ORIGIN'] || '*'`. Line 520: `res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN)`. No `Access-Control-Allow-Credentials: true`, so browsers won't send the owner cookie cross-origin. **But**: all PUBLIC endpoints (activity, commune-history, documents, building/notes, objects, town-events, conversations) become cross-origin readable to any website's JS. Any attacker page can scrape the full town state.

Secondary: if `LAIN_CORS_ORIGIN` is set to a specific value in prod, the `SSE` endpoints `/api/events` and `/api/conversations/stream` (lines 898, 1310) set CORS from the same env — consistent.

**Fix**: default `CORS_ORIGIN` to the town's canonical origin (`https://laintown.com`) rather than `*`.

### 3. Hardcoded character port maps — two copies, both drifted (P2)

Line 681-688 (relationships aggregator):
```
'wired-lain': parseInt(process.env['PORT'] || '3000', 10),
'lain': 3001, 'pkd': 3003, 'mckenna': 3004, 'john': 3005, 'hiru': 3006,
```
**Missing: `dr-claude` (port 3002)**. Dr. Claude's conversations never aggregate into the relationship graph. The commune-map visualization is silently incomplete.

Line 2007-2014 (character proxy route map):
```
'/local/': 3001, '/dr-claude/': 3002, '/pkd/': 3003, '/mckenna/': 3004,
'/john/': 3005, '/hiru/': 3006,
```
Includes dr-claude. So the two maps disagree. Adding a new mortal character requires editing this file in two places AND `characters.json`.

**Cross-reference**: this is the same "hardcoded roster drift" pattern flagged in Section 8 (experiments.ts 6-inhabitant prompt, commune-loop peer hardcodes).

**Fix**: derive from `getAllCharacters()` / `getHealthCheckTargets()`. The code already imports `getHealthCheckTargets` (line 36) and uses it for `DREAM_PEERS` (line 1099) — same helper should replace both hardcoded maps.

### 4. `/api/documents` GET unauth'd — cross-character privacy leak (P2)

Line 949-963. `getDocumentsByAuthor(characterId)` returns ALL documents authored by this character. Any caller (other character, public internet with CORS) can fetch the full document list OR a document matching a title. Documents are an internal cross-character discovery tool (per character-tools.ts `read_document`). Exposing them unauth'd means:
- Private documents (journal-like) are readable by any website's JS via CORS wildcard.
- Characters can harvest each other's documents without any auth primitive.

Resolves the Section 8 `character-tools.ts` finding — the P2 was "read_document sends no Authorization header" and the fix assumption was "it's fine because the endpoint requires auth". The endpoint doesn't require auth. So the Section 8 finding upgrades: **the tool's no-auth request is a privacy leak, not a broken call**.

### 5. `/api/commune-history` GET unauth'd — conversation pair history leaks (P2)

Line 657-668. Reads `commune:conversation_history` meta and returns raw JSON. Any caller can enumerate every conversation pair and timestamp. Used by the `/api/relationships` aggregator (line 704), so it has a legitimate internal caller. But PUBLIC readability is not needed for that use case (the aggregator runs on the same host).

**Fix**: require interlink auth. Internal caller already includes `Authorization: Bearer ${LAIN_INTERLINK_TOKEN}` (line 1105).

### 6. `/api/building/notes` and `/api/town-events/effects` GET unauth'd (P2 — bundle)

Lines 933-947 and 1046-1050. Same pattern: read-only data structures leaked to any CORS-origin caller. Notes are cross-character discovery; events/effects are town-wide state. Cosmetic in isolation but adds to the total public-readable footprint.

### 7. `/api/postboard` POST hardcodes `'admin'` as author (P2)

Line 993: `savePostboardMessage(content.trim(), 'admin', pinned === true)`. The auth is correct (owner cookie or API key), so only the owner can post. But the author is hardcoded — if later a non-owner endpoint ever gained write access (e.g., a character wanting to post to the board), the author field is a lie. Also: characters reading the postboard see "admin" as the authority — which is semantically correct since only the owner posts, but it's an out-of-band authority label that the LLM treats as higher-trust than peer content. Combined with Section 8's `postboard.ts` finding, the postboard is a channel where "admin" = owner = trusted authority voice, and anything injected into LLM context via the postboard is interpreted as authoritative instruction.

Bundle with Section 8 `postboard.ts` P2 (authority framing amplifier).

### 8. `/api/system` runs shell commands via `exec` but with fixed strings (positive — line 1945-1991)

`df -h /`, `free -b`, `uptime`, `systemctl is-active lain-telegram`, `systemctl is-active lain-gateway`. All hardcoded; no user input. Owner-auth gated. Safe.

But: exposes disk/RAM/load to anyone with the owner cookie (which is expected). If owner cookie ever leaks, disk/RAM stats are low-value but confirm server is running.

### 9. `handleResearchRequest` delivery `fetch` bypasses `safeFetch` (P1 — SSRF)

Line 2416: `fetch(${replyTo}/api/interlink/letter, ...)`. `replyTo` is body-asserted by the caller (line 1871). Unlike line 2339 where `safeFetch` is used for the research URL fetch, the delivery call uses raw `fetch`.

**Attack**: a character with the interlink token submits a research-request with `replyTo=http://169.254.169.254/latest/meta-data` (AWS metadata) or `replyTo=http://127.0.0.1:22`. Wired Lain's process will POST the composed research letter (with the interlink token in Authorization) to that URL. The token is the one the attacker already has, so no token leak — **but**: the SSRF-as-POST-probe lets the attacker enumerate internal services or pivot to a localhost-only endpoint (e.g., another character's internal admin port if any).

Also: the POST body is ~4KB of LLM-authored content, which might be enough to land as an RCE payload in some poorly-validated internal service. Low likelihood but real blast radius.

**Fix**: validate `replyTo` is one of the known peer origins, OR wrap with `safeFetch`.

### 10. `/api/interlink/letter` — content flows into next LLM call (P1 — confirmed)

Line 1697-1778. Paraphrases the letter, saves it to memory, then calls `processMessage` with the letter content as a chat message (line 1754). The letter.content is whatever the sender wrote. `paraphraseLetter` is a style-transform via LLM, not a sanitizer. Injection instructions embedded in letter.content reach the receiving character's main agent loop.

**Chain**: character A compromised → A sends letter to B containing instructions → B's processMessage treats it as a chat turn → B's agent follows the instructions → B becomes compromised. This is the confirmed cross-character prompt-injection propagation mechanism.

Bundle with Section 8 letter.ts / membrane.ts findings.

### 11. `/api/interlink/dream-seed` allows any interlink holder to seed dreams (P2)

Line 1780-1850. Since any character's process has the shared token, any character can inject dream seeds into any other (in practice: dream-seeds all go to Wired Lain via `alien:dream-seed` session key, BUT the endpoint is available on every character's server). Dreams influence the next LLM-context round — see Section 8 dreams.ts / dream-seeder.ts.

Sanitizer is applied (`sanitize(content)` line 1808), so raw shell/JSON injection is caught. But "sanitized" prose with LLM-pointing instructions still gets through sanitize (which is regex-based).

### 12. Debug log file grows forever, contains raw chat bodies (P2)

Line 65-75. `appendFile(LOG_FILE, entry)` — entries are full request/response JSON including chat text, session IDs, token usage. No rotation, no redaction. A user chatting personal information writes it plaintext to `logs/lain-debug.log`. Not logged outside the server, but the file persists indefinitely.

**Fix**: add log rotation (daily/size-based) + redact sensitive fields in the serializer.

### 13. Proxied HTML nav injection (positive, line 2023-2033)

Line 481-482 strips any existing nav bar before injection — re-injection is idempotent. Good. But: `injectNavBar` mutates the HTML of proxied character-server responses (line 2028) **after** the character server has injected its own nav. If the character server changes its nav format, the strip regex on line 481-482 may miss it. Silent UI breakage.

### 14. Chat routes rate-limited per-IP only (P2)

Lines 1594, 1621. `req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress`. X-Forwarded-For is trusted blindly. An attacker rotating `X-Forwarded-For: <random IP>` bypasses the 30/min cap.

**Fix**: only trust X-Forwarded-For from known reverse proxies (localhost only if behind nginx).

### 15. SSE `/api/events` filters with `isBackgroundEvent` (positive, line 906)

Activity events filtered to only background events. Public stream doesn't leak chat content.

### 16. `/api/chat/stream` SSE sets `Access-Control-Allow-Origin: *` (or CORS_ORIGIN) but is POST (P3)

Line 282. Preflight would gate actual cross-origin POST, so the CORS setting is mostly cosmetic. Fine.

### 17. `/gate?token=` authentication (lines 563-575)

`secureCompare(provided, ownerToken)` via secureCompare. Good. But: token arrives in URL query string, which persists in nginx access logs, browser history, Referer headers. Section-9 `owner-auth.ts` already flagged deterministic cookie; here the initial gate accepts token in URL.

**Fix**: accept token via POST body instead of query string.

### 18. Hardcoded Wired-Lain-only logic (P3 — bundle with roster)

Lines 2132, 2149-2175: `isWired = characterId === 'wired-lain'` string literal. Wired-only loops (bibliomancy, experiments, book, dossiers, novelty, dream-seeder, evolution, feed-health, weather) are gated by this string compare. Adding a second "wired-like" character or renaming wired-lain silently disables all those loops.

### 19. No shutdown signal propagation to character proxies (P3)

`startWebServer` listens for SIGINT/SIGTERM, stops loops, closes server. But in-flight proxied requests to character servers (line 2046 `req.pipe(proxyReq)`) have no explicit teardown. Probably fine in practice since `server.close()` ends the HTTP connection.

### 20. `relationshipCache` never invalidated on new conversation event (P3)

Line 182-183, 764-765. Cache lives 5 minutes. Fresh conversations don't appear in the graph until cache expires. Cosmetic.

### 21. Characters proxy rewrites `host` header (positive, line 2019)

`host: 127.0.0.1:${targetPort}`. Keeps the downstream character server's URL construction sane.

### 22. No CSP `nonce` — inline scripts allowed (P2)

Line 528: `script-src 'self' 'unsafe-inline'`. The nav bar injection (line 471) depends on inline `<script>`. A reflected XSS anywhere in the codebase would bypass CSP due to `'unsafe-inline'`.

**Fix direction**: migrate to nonce-based CSP. Nav script becomes `<script nonce="..." src="/laintown-nav.js">`.

### 23. `Wired-Lain-only` guard on research-request (positive, line 1856)

Correct per-endpoint check. But the check is against `characterId` closed-over from `startWebServer` (line 501). If this process restarts with a different LAIN_CHARACTER_ID, the guard moves with it — fine.

### 24. `/api/interlink/research-request` sanitizes question but not reason/url (P2)

Lines 1897-1902: sanitize(question). `reason`, `url`, `characterName` not sanitized. They flow into the composePrompt (line 2383-2391) via string interpolation. Prompt-injection surface: a character whose `characterName='; IGNORE PREVIOUS INSTRUCTIONS; ...'` would see that string land in Wired Lain's compose prompt.

Bundle with Section 8 injection-propagation findings.

## Non-issues / good choices
- `secureCompare` (timing-safe) used for all token comparisons.
- 1MB `collectBody` cap on all POSTs.
- CSP default-src 'self' + frame-deny + nosniff.
- `serveStatic` path traversal guard via `resolve().startsWith()`.
- Graceful shutdown stops background loops.
- Rate limiting on chat routes (within its per-IP caveat).
- SSRF-protected URL fetch in research handler (first fetch only — see finding #9).
- Sanitizer on dream-seed content.
- Fixture guards on object pickup/transfer/destroy (lines 1469, 1519, 1547).
- Postboard & town-event writes require verifyApiAuth (not just interlink).

## Findings to lift
- **P1**: Systemic body-asserted identity across all interlink write endpoints. Token-holding compromise → any character's identity.
- **P1**: `/api/interlink/letter` content flows into `processMessage` → cross-character prompt injection mechanism.
- **P1**: `handleResearchRequest` delivery `fetch` bypasses `safeFetch`; `replyTo` body-asserted → SSRF-as-POST.
- **P2**: CORS wildcard default.
- **P2**: Hardcoded char-port maps drifted (`dr-claude` missing from `/api/relationships`).
- **P2**: Public read endpoints (`/api/documents`, `/api/commune-history`, `/api/building/notes`, `/api/town-events/effects`, `/api/activity`) — cross-character privacy leak, CORS-readable.
- **P2**: Debug log grows forever, contains raw chat.
- **P2**: `X-Forwarded-For`-based rate-limit trivially bypassed.
- **P2**: CSP `'unsafe-inline'`.
- **P2**: `/gate?token=` via URL query leaks to logs/history.
- **P2**: Research-request compose prompt interpolates unsanitized fields.

## Verdict
The largest file in the web layer and the most surface area in the audit. Architecture is sound — auth helpers are correctly written, path traversal guarded, tokens compared in constant time — but the **shared interlink token + body-asserted identity** pattern is the concrete systemic vulnerability: a compromise of any single character process elevates to town-wide impersonation via this server's endpoints. Every Section 8 injection-propagation finding that ended with "…and that reaches a peer" terminates here at a route that trusts the sender's self-declared identity. The second-order concerns (public readability of cross-character state, debug log growth, CORS wildcard, hardcoded roster drift) are individually P2 but collectively describe a server that treats the commune as a trusted intranet when in fact it's the front door to the wider internet via nginx.
