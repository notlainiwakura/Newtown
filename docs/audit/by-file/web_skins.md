---
file: src/web/skins/early-load.js + loader.js + picker.js
lines: 36 + 184 + 104 = 324
purpose: Client-side skin system. `early-load.js` runs in <head> to inject initial CSS before render (prevents FOUC). `loader.js` exposes `window.LaintownSkins` API (setSkin, onSkinChange, getSpriteConfig). `picker.js` renders the 🎨 skin picker UI. Per-character pages have their own `/skins/` route, other pages use root `/skins/`.
section: 9 (web)
audit-date: 2026-04-19
---

# web/skins/*.js

## Function inventory (combined)
- `early-load.js`: IIFE at line 4. Inlined in main server's nav injection? No — served as separate script. Reads `?skin=` query, falls back to localStorage, then default. Injects `<link>` to `/skins/<id>/skin.css`.
- `loader.js`: `skinsBasePath()` 12, `detectSkin()` 25, `getRegistry()` 34, `fetchManifest(skinId)` 45, `applySkinCSS(skinId)` 51, `applyFonts(manifest)` 73, `updateUrl(skinId)` 84, `setSkin(skinId)` 94, `getSkinId()` 113, `getSkinManifest()` 117, `getAvailableSkins()` 121, `onSkinChange(cb)` 133, `getSpriteConfig()` 139, `initSkin()` 157. Exported as `window.LaintownSkins`.
- `picker.js`: single IIFE at line 1. Builds toggle button + panel, subscribes to LaintownSkins.

## Findings

### 1. Hardcoded character path list in THREE places (P2)

- `early-load.js` line 22: `['/pkd', '/mckenna', '/john', '/doctor', '/hiru', '/local']`
- `loader.js` line 15: same list
- `server.ts` line 2007-2014: similar list with different keys (`/dr-claude/` not `/doctor/`)

**Divergence alert**: client skin code uses `/doctor` but server proxy map uses `/dr-claude/`. This suggests `/doctor` is either a legacy alias or the skin system was never updated when the server route was renamed. If a user visits `/dr-claude/`, the skin code's `charPaths` list does NOT include it, so:

Line 22-29 early-load falls through to `path = '/skins'` (the root). Then line 32: `link.href = '/skins/<id>/skin.css'`. But the main server hosts `/skins/*` (line 2052 in server.ts). Main server.ts proxy preserves the request path to the character server. So a browser at `/dr-claude/` requests `/skins/gothic/skin.css` → main server serves it. OK, works by accident.

But: when `/doctor` is hit (no such route per server.ts lines 2007-2014, since `doctor-server.ts` isn't in the proxy map — only `/dr-claude/` is), the early-load tries `/doctor/skins/...` which doesn't exist. Fallback to default skin fails silently — skin CSS request 404s.

**Impact**: inconsistency between three lists. Adding a new character requires editing all three. This is the same hardcoded-roster pattern flagged repeatedly; here it surfaces as visual UX breakage rather than security.

**Fix**: derive from `/api/characters` (which is public on all servers). Or unify the list in a single client-side module.

### 2. `skin` query parameter is unsanitized — reflected into URL and fetch path (P2)

`early-load.js` line 15: `new URLSearchParams(location.search).get('skin')` — raw string.
Line 32: `link.href = path + '/' + skinId + '/skin.css'` — direct interpolation.

`skinId = 'foo/../../api/telemetry'` would produce `/skins/foo/../../api/telemetry/skin.css`. The browser normalizes the URL before fetching: `/skins/foo/../../api/telemetry/skin.css` → `/api/telemetry/skin.css` (after `.. /..` pop `/skins/foo` → ``, then append `/api/telemetry/skin.css`). That URL doesn't exist. Browser's CSS loader gets 404 → silent.

But: if an attacker constructs `?skin=../public/chat.html` → resolves to `/public/chat.html` as a stylesheet. Browser tries to load as CSS, fails due to MIME check or content. No active XSS.

However: `loader.js` line 89: `url.searchParams.set('skin', skinId)` — `skinId` is written back to the URL. `history.replaceState` with an unsanitized value is fine (browsers handle it), and URLSearchParams URL-encodes on set. So the URL ends up like `?skin=foo%2F..%2F..%2Fapi%2Ftelemetry`. Persisted in history.

Then line 105 `localStorage.setItem(SKIN_STORAGE_KEY, skinId)` — persists the raw (decoded) string. Next page load: `detectSkin()` reads from localStorage, and the cycle continues.

Also line 107: `document.documentElement.dataset.skin = skinId`. Dataset attributes are HTML-safe (browser encodes on set). But CSS selectors can target them: `[data-skin~="gothic"]`. An attacker-chosen skinId with spaces or semicolons becomes a CSS selector target. Probably exploitable only in creative ways.

**Bigger concern**: `registry` (line 38) is fetched from `/skins/registry.json`. Line 96: `if (!reg.includes(skinId))` — validates against the registry. GOOD GUARD. Only skins in the registry can be applied via `setSkin`.

But: `early-load.js` does NOT consult the registry — it trusts `skinId` from query/localStorage directly (lines 15-35). So between early-load running and loader.js validating, a malicious `skinId` reaches the DOM.

In `applySkinCSS` (line 51), `loader.js` checks the existing early-loaded link at line 53-64: if `earlyLink.href.endsWith('/<skinId>/skin.css')` matches the (now-validated) skinId, adopt it. If not, remove it and re-inject. Good.

So the worst case: a stylesheet request to an attacker-controlled path during page load. Impact:
- Request is issued for anything at `/skins/<path>/skin.css`.
- If the path resolves (after browser URL normalization) to an endpoint the user has auth for (e.g., `/api/dreams/seeds`), the browser sends the owner cookie (same-origin).
- The response is loaded as a stylesheet. Cross-origin stylesheet CSS-leak risks exist (e.g., reading error messages via CSS-error-message channel) but only if the response is cooperatively parseable as CSS.

**Severity assessment**: low-real-impact, but:
- Crafted links shared in chat can cause cross-surface fetches carrying owner cookie.
- `/skins/<path>/skin.css` is unreachable for most attacker paths due to the `/skin.css` suffix.
- Reflected query into localStorage + URL + DOM dataset gives multi-channel persistence.

**Fix**: `early-load.js` should validate `skinId` matches `/^[a-z0-9-]+$/` before using it in a URL.

### 3. `getSkinId` / `getSkinManifest` expose manifest via `window.LaintownSkins` (P3)

Manifest may contain `googleFontsUrl` (line 75). An attacker who controls the skin file (e.g., via a registry.json compromise) can load arbitrary Google Fonts URL. Since CSS is scoped to the document, this is low risk — but any cross-origin `<link>` injection is a tracking + fingerprinting channel.

If `manifest.googleFontsUrl` could be `https://attacker.com/evil.css`, it would be loaded as a stylesheet. Line 78: direct interpolation into `href`. No URL scheme check.

**But**: to control a manifest, attacker needs write to `src/web/skins/<id>/manifest.json` — which requires filesystem access to the server. If they have that, they have a bigger problem than XSS.

Low severity unless there's a way for a user to register their own skin (which there isn't — registry is server-filesystem).

### 4. `registry.json` fetched without error handling of response type (P3)

Line 37-42. `res.json()` will throw if body isn't JSON. Caught by outer try, falls back to `[DEFAULT_SKIN]`. OK.

But: if `registry.json` is served with non-200 status but valid JSON body (e.g., some proxy returning a 403 HTML page that happens to parse as JSON — unlikely), the fallback isn't triggered. Low risk.

### 5. `applySkinCSS` removes old link before inserting new (positive, line 63, 65)

DOM-clean transitions. No duplicate `<link>` accumulation.

### 6. Skin picker appends to `document.body` directly (line 102-103) — no shadow DOM isolation (P3)

`skin-picker-toggle` and `skin-picker-panel` share the document's global CSS scope. A skin CSS file could override the picker's own styles. Not a security issue, just fragile UI.

### 7. `setSkin` dispatches `skin-changed` CustomEvent (positive, line 108-110)

Subscribers via `onSkinChange` get notified. Good pub-sub pattern.

### 8. `getSpriteConfig` falls back to default (positive, line 139-152)

If character's skin doesn't have a sprites.json, falls back to default's sprites.json. Nice graceful degradation. Used by the game client (see Section 11).

### 9. Image loading `link` for fonts is unrestricted (P3 — bundle with #3)

`applyFonts` loads `manifest.googleFontsUrl` via `<link rel="stylesheet">`. No SRI. No URL allowlist. Trusts the manifest fully. Since manifests are server-static files, this is fine — but if ever someone dynamically composes a manifest from user input, it becomes a stylesheet injection vector.

### 10. `_ready` promise never rejects (P3)

Line 155-165. `_readyResolve` is called even on init failure (line 164 is inside the outer function, always reached). `_ready` always resolves, never rejects. Callers (picker.js line 14) await it. If skin init fails, picker still initializes — but picker calls `getAvailableSkins` → `getRegistry` which handles its own errors.

OK, intentional design.

### 11. Picker uses `setTimeout(initPicker, 500)` for retry (P3, line 8)

If `window.LaintownSkins` isn't available on DOMContentLoaded, re-tries in 500ms. Silent infinite retry if loader.js never loads. Not a big deal — page loads with no picker. Observable via console log at line 2.

### 12. `detectSkin` reads URL search param FIRST, then localStorage (P3, line 27-31)

URL-param wins. Someone emails a `?skin=gothic` link, the target's localStorage is overwritten via the URL → localStorage flow at `setSkin` line 105. That's the expected UX (share a link preloaded with your skin), not a bug.

### 13. `LaintownSkins` object exposed on window (P3, line 167-178)

No namespace collision check. Any other script that sets `window.LaintownSkins` stomps it. Low concern — no other code uses this name.

### 14. Character-server's `/skins/` path resolution differs from main server (P2)

Main server (line 2052 of server.ts): `url.pathname.startsWith('/skins/')` → serves from `SKINS_DIR`.
Character-server (line 708): also `/skins/` OR regex `/^(?:\/[^/]+)?\/skins\/(.+)$/` — matches `/pkd/skins/foo.css` too.

So client-side `charPaths + '/skins'` works at the character-server level. Main server proxies `/pkd/` and `/pkd/skins/` to the character server. Character server's regex path matches. Chain works.

**But**: when main server serves a page at `/pkd/something.html` (proxied), the HTML links to `/pkd/skins/gothic/skin.css`. Main server sees the path, attempts its proxy map match for `/pkd/` → proxies to character server at port 3003. Character server sees `/pkd/skins/gothic/skin.css` in the URL. Its regex handles it. Character server's own SKINS_DIR is the SAME as main server's (both point to `src/web/skins/`). OK.

Nothing breaks, but the path-resolution logic duplicated across three places (early-load.js, loader.js, character-server.ts proxy) is brittle.

## Non-issues / good choices
- Registry-based skin validation in `setSkin` prevents arbitrary skin loading after the initial early-load.
- `initSkin` handles errors gracefully — page loads even if skin init fails.
- No `eval` / no `innerHTML` with user content.
- All dynamic content uses `textContent` / `dataset` / DOM APIs, not HTML strings.
- Skin picker swatches use `color` directly but only from `skin.previewColors` which comes from the server-owned manifest.
- CSP in main server (`script-src 'self' 'unsafe-inline'`) permits inline skin-picker code.

## Findings to lift
- **P2**: Hardcoded character path list in `early-load.js` and `loader.js` drifts from server.ts proxy map (`/doctor` vs `/dr-claude`).
- **P2**: `early-load.js` trusts `?skin=` query unsanitized before registry validation loads.
- **P2**: Path resolution logic duplicated across early-load.js, loader.js, and character-server.ts.
- **P3**: `manifest.googleFontsUrl` directly interpolated into `<link href>` (no URL-scheme check).
- **P3**: `localStorage` persists whatever the URL supplied for `?skin=`.

## Verdict
A tidy client-side skin system with a registry-based validation primitive that catches most of the reflected-skin concern — except during the early-load phase, where the registry hasn't loaded yet and the `?skin=` query flows directly into a stylesheet `<link>`. The biggest concrete issue is the hardcoded character path list drifting from the server-side routing map (`/doctor` appears client-side but `/dr-claude/` is the actual route). Otherwise this is the least-attack-surface component in Section 9 — all skin assets are server-filesystem-sourced, the network IO is `<link>`-based and bounded by MIME-sniff behavior, and the API is a small, well-named façade.
