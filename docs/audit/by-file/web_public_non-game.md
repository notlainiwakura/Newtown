---
file: src/web/public/{laintown-nav,laintown-telemetry,action-mapper,app,commune-map}.js
lines: 69 + 365 + 122 + 479 + 1033 = 2068
purpose: Non-game frontend JS. laintown-nav injects the shared nav bar across pages; laintown-telemetry polls every character server and renders a live activity feed; action-mapper is a pure keyword→expression helper; app.js is the chat UI for /lain and per-character pages; commune-map.js is the top-down town view with SSE event streams + floating notifications + a spectator stranger-chat mode.
section: 11 (frontend — non-game)
audit-date: 2026-04-19
---

# web/public/ non-game (consolidated)

Files: `laintown-nav.js` (69), `laintown-telemetry.js` (365), `action-mapper.js` (122), `app.js` (479), `commune-map.js` (1033).

## Function inventory

**laintown-nav.js:** `isActive(href)`, `insertNav()` (IIFE).

**laintown-telemetry.js:** `parseType(sessionKey)`, `parseCommuneTarget(sessionKey)`, `charNameById(id)`, `charColorById(id)`, `renderEntry(entry)`, `fetchEndpoint(endpoint, from, to)`, `fetchAll(fromTs, isInitial)`, `escapeHtml(str)`, poll loop.

**action-mapper.js:** `resolve(text)` — keyword → expression token.

**app.js:** `escapeHtml(text)`, `formatLainResponse(text)`, `processImageFile(file)`, `clearPendingImage()`, `sendMessageStream(...)`, `sendMessage(...)`, drag/paste handlers, easter-egg glitch effect.

**commune-map.js:** `buildCharacterEntry(c, isHost)`, `getCharacterColors()`, `getTypeColors()`, `getBuildingIcons()`, `parseType(sessionKey)`, `connectSSE(char, onOpen)`, `handleEvent(char, event)`, `loadActivity(char)`, `createNotification(char, event)`, `renderEntry(entry)`, `sendStrangerMessage(text)`, `getRandomCannedPhrase(charId)`, skin-aware theme readers.

## Findings

### 1. XSS in `commune-map.js createNotification` — LLM-authored content interpolated via `innerHTML` (P1)

`commune-map.js:565-567`:

```js
const snippet = (event.content || '').slice(0, 60);
const typeColor = TYPE_COLORS[event.type] || '#6090c0';
el.innerHTML = `<span style="color:${char.color}">${char.name}</span> <span style="color:${typeColor}">${event.type}</span>: ${snippet}`;
```

`event.content` is the free-form text payload of an SSE activity event — originates from LLM output (chat replies, peer messages, diary entries, dreams, etc.). Any character that ever emits `<img src=x onerror="fetch('/api/telemetry',{method:'POST',body:document.cookie})">` in a diary entry or peer message will render as executable HTML in every commune-map viewer's browser, running in the owner's authenticated session origin. Compounded by:

- `char.name` and `event.type` are also unescaped, but those come from the character manifest / type-registry (server-controlled trust surface).
- `char.color` is interpolated into a `style=` attribute; if a future manifest ever accepts operator-provided color strings, `color:red"onclick="..."` breaks out of the attribute.
- `snippet.slice(0, 60)` doesn't help — 60 characters is plenty of room for `<img src=x onerror=alert(1)>`.

**Fix:** rebuild with `createElement` + `textContent` (pattern already used by `laintown-nav.js`). Or escape `snippet` (and ideally `char.name`, `event.type`) with the existing `escapeHtml` helper.

### 2. XSS in `commune-map.js renderEntry` — server/LLM-authored `entry.kind` interpolated (P2)

`commune-map.js:684-690`:

```js
el.innerHTML =
  `<div class="entry-header">` +
  `<span class="entry-type" style="color:${typeColor}">${type}</span>` +
  `<span class="entry-kind">${entry.kind}</span>` +
  `<span class="entry-time">${time}</span>` +
  `</div>` +
  `<div class="entry-content">${escapeHtml(fullContent)}</div>`;
```

`fullContent` is escaped (good), but `entry.kind` is not. `entry.kind` originates server-side; current values are a fixed enum (`chat`, `diary`, `dream`, etc.) but there's no code-level invariant locking that to the safe set — any future code path that writes a new kind string to the activity store pipes straight through to innerHTML.

**Fix:** escape `entry.kind` consistently, or switch to DOM-construction.

### 3. XSS via `onclick="window.open('${escapeHtml(img.url)}', ...)"` — `javascript:` scheme bypass (P1)

`app.js:111-119` (`formatLainResponse`). Lain's LLM response may emit `[IMAGE: caption](URL)`. The code extracts the URL, HTML-escapes it, and embeds in an `onclick` attribute:

```js
onclick="window.open('${escapeHtml(img.url)}', '_blank')"
```

`escapeHtml` uses `div.textContent = ...; div.innerHTML` which encodes `<>&"'` but not the `javascript:` URI scheme. If Lain's LLM ever emits `[IMAGE: desc](javascript:fetch('/api/...',{method:'POST'}))`, clicking the image opens a new tab executing JS in the owner's session origin. Modern browsers block `javascript:` URLs in `window.open` from user-gesture contexts in some conditions, but not universally — Safari and older Firefox still pass them through, and the click IS a user gesture.

**Fix:** validate URL scheme before rendering — require `url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:image/')`. Also migrate off inline `onclick` handlers.

### 4. Polling loop never stops on navigation — `setInterval` leak (P2)

`laintown-telemetry.js:346-350`. `pollTimer = setInterval(function () { fetchAll(from, false); }, POLL_INTERVAL);` — no `beforeunload` or `pagehide` cleanup. Multiple poll timers can accumulate on bfcache restore, and on SPA-style navigation within the town the old interval runs alongside the new one. On production (long-running owner sessions), these add up. Compounded because `fetchAll` fans out to 6 endpoints, so each leaked timer is 6 requests/poll.

**Fix:** listener on `pagehide` / `beforeunload` → `clearInterval(pollTimer)`.

### 5. Hardcoded 6-character roster in `laintown-telemetry.js` ENDPOINTS + per-character color map (P2)

`laintown-telemetry.js:6-13, 15-53`. Endpoint list and the `CHAR_COLORS` / `CHAR_NAMES` maps hardcode `pkd, mckenna, john, dr-claude, hiru` + implicit `lain`. The same hardcode was flagged in `server.ts` (charPorts 681-688) and `skins/{early-load, loader}.js` — telemetry is a fourth drift point. First generational succession breaks this: the replacement character's events show as `undefined` name / default color, and old-character endpoints 404 the poll endlessly until redeployed.

Meanwhile `commune-map.js` fetches `/api/characters` dynamically (positive pattern). Telemetry should copy that approach.

### 6. `commune-map.js` `CANNED_PHRASES` hardcodes same 6-character roster (P2)

`commune-map.js:765-809`. Same concern as finding 5; different file. Spectator stranger-mode replies get a hardcoded dict keyed by character id. New characters fall back to a generic placeholder with no operator signal.

### 7. `commune-map.js` stale-entry loop — no max reconnect count (P2)

`commune-map.js:478-484`. SSE reconnect uses exponential backoff capped at 30s. But there's no max-attempts ceiling: a persistently-failing character server on a week-long owner session spawns thousands of reconnect attempts. Each failed `connectSSE` creates new closures. Eventually a drag on memory + log noise.

**Fix:** cap attempts; after N failures mark that character as offline in the UI rather than retry indefinitely.

### 8. `commune-map.js` silent empty-map when `/api/characters` fetch fails (P2)

`commune-map.js:222-237` (`loadCharactersFromManifest`). Catch-all swallows the error; `CHARACTERS` stays empty; the entire map renders blank with no error banner. Classic "API down = white screen" UX failure.

**Fix:** on load failure, render an error banner with retry button.

### 9. `commune-map.js` no shape validation on fetched character entries (P2)

`commune-map.js:225-232`. The code checks `data.characters.length` but not per-entry fields. `buildCharacterEntry` assumes `c.id`, `c.name`, `c.defaultLocation` exist; server schema drift silently breaks downstream rendering (e.g., nodes positioned at `undefined` coordinates, endpoints constructed as `/undefined/api/events` → 404 infinite reconnect).

### 10. `app.js` SSE stream cannot distinguish server-close from completion (P2)

`app.js:264-305`. `reader.read()` returning `{done: true}` terminates the loop and fires `onDone()`. A mid-stream network drop looks identical to a successful completion — user sees a truncated reply as if it were complete. No retry, no "stream interrupted" banner.

**Fix:** server emits a terminal `{type: 'done'}` marker; client treats premature EOF as error. Retry on transient failure or show "connection lost, please retry."

### 11. `app.js` sessionId persisted in localStorage with no TTL (P2)

`app.js:26-27, 287, 332`. Session IDs can live in localStorage indefinitely. On a shared device (coworking owner's laptop, shared family device) or after browser sync to a compromised device, the sessionId remains valid — and while it's not an auth token, sessionId grants access to the conversation's LLM memory context via resumed sessions.

**Fix:** short TTL (24 hours) with purge-on-expiry; or sessionStorage (scoped to tab) for sessions that shouldn't cross-tab.

### 12. `commune-map.js` per-character `stranger-session-*` localStorage entries accumulate (P2)

`commune-map.js:839, 841, 967`. Stranger mode stores one session key per character-visited. Over time a casual visitor accumulates 7+ session IDs persisted forever. Same concern as finding 11, with a multiplier.

### 13. Client-side owner gating via meta tag is pure UX — server still enforces (P3)

`app.js:16, 343-353, 358`. `IS_OWNER = meta[name=lain-owner].content === 'true'`. A non-owner can toggle the meta tag in devtools, unhide the chat form, submit — server rejects. Client-side check is UX only; recording it as P3 because the *actual* auth is server-side and correct.

### 14. `buildCharacterEntry` path construction trusts `c.id` without sanitization (P3)

`commune-map.js:20`. `const prefix = isHost ? '' : '/' + c.id;` — if a manifest ever ships a malformed id (`../../admin`), it ends up in SSE URLs. Manifest is server-controlled trust surface, but the pattern is fragile.

**Fix:** `encodeURIComponent(c.id)` and/or validate `/^[a-z][a-z0-9-]*$/` on load.

### 15. Visitor name from localStorage with no UI to clear (P3)

`app.js:29`. `window.LAIN_SENDER_NAME = localStorage.getItem('lain-sender-name') || 'SHRAII';` — persists forever. Minor privacy concern for shared-device use; not security.

### 16. `TYPE_COLORS` / `TYPE_LABELS` duplicated between telemetry + commune-map (P3)

`laintown-telemetry.js:15-53` vs `commune-map.js:34-52`. Two sources of truth for event-type display. Drift has no security impact but means new event types only appear in one UI.

## Non-issues / good choices
- `laintown-nav.js` uses `createElement`/`textContent` exclusively — clean.
- `action-mapper.js` is a pure function over hardcoded data — no attack surface.
- `app.js escapeHtml` is the correct DOM-textnode-roundtrip pattern.
- `commune-map.js` reads characters dynamically from `/api/characters` — the right pattern.
- SSE reconnect uses exponential backoff (30s cap).
- Owner-chat flow defends in depth (client check + server auth).

## Findings to lift
- **P1**: `commune-map.js createNotification` XSS via LLM-authored `event.content` → `innerHTML`.
- **P1**: `app.js formatLainResponse` XSS via `javascript:` URI in image URL interpolated into `onclick`.
- **P2**: `commune-map.js renderEntry` unescaped `entry.kind`.
- **P2**: `laintown-telemetry.js` poll-interval leak on navigation.
- **P2**: Hardcoded 6-character rosters in `laintown-telemetry.js` (2 places) and `commune-map.js` (canned phrases).
- **P2**: `commune-map.js` silent empty-map on manifest-fetch failure; no shape validation.
- **P2**: `app.js` SSE stream conflates network drop with completion.
- **P2**: `app.js` + `commune-map.js` localStorage sessionIds with no TTL, per-character.

## Verdict
Owner-authenticated UI + stranger-mode UI. XSS surface exists because LLM-generated content flows directly into `innerHTML` in two places (one high-traffic: every SSE notification on the commune map). Fix: switch to `textContent` or `escapeHtml` at every innerHTML site where any server/LLM string reaches the template. Cross-file drift (telemetry + canned phrases hardcode character rosters while commune-map fetches dynamically) is the same drift pattern flagged in every prior section.
