---
file: src/web/owner-auth.ts
lines: 54
purpose: Shared owner authentication via HMAC-signed cookie. Main server (server.ts) sets the cookie via `/gate?token=<LAIN_OWNER_TOKEN>`. Character-server and doctor-server independently verify using the same LAIN_OWNER_TOKEN env var — no shared session state.
section: 9 (web)
audit-date: 2026-04-19
---

# web/owner-auth.ts

## Function inventory (3)
- `deriveOwnerCookie(ownerToken)` — 20: exported.
- `isOwner(req)` — 27: exported.
- `setOwnerCookie(res, ownerToken)` — 48: exported.

## Findings

### 1. Deterministic cookie value — no rotation, no revocation (P2)

Line 20-22. `createHmac('sha256', ownerToken).update('lain-owner-v1').digest('hex')`. The cookie value is a pure function of the owner token. Consequences:

- **No session revocation**: if the cookie is stolen (device theft, XSS-adjacent leak, log capture, browser sync to compromised device), the only revocation path is rotating `LAIN_OWNER_TOKEN` which invalidates the owner's access to every surface simultaneously and requires a re-deploy (env var change → systemd restart).
- **No issued-at timestamp**: even the `Max-Age=31536000` (1 year) is cosmetic; a leaked cookie is valid forever until the token changes.
- **No per-device distinguishability**: the same cookie value is used from owner's phone, laptop, work machine. No way to tell which device logged in.

**Mitigation**: HttpOnly + SameSite=Strict reduces XSS and CSRF exposure. Token rotation is the nuclear option but is available.

**Fix direction**: include an issued-at timestamp and a per-device random in the signed payload (`HMAC(token, "v2:" + iat + ":" + nonce)`), verify age on `isOwner`. Requires migration from v1 cookie format.

### 2. `HMAC_MESSAGE = 'lain-owner-v1'` is constant — not bound to request, server, or timestamp (P2)

Line 14. Since the HMAC input is always the literal string `'lain-owner-v1'`, the cookie value is just `HMAC(token, "lain-owner-v1")`. Anyone who knows `LAIN_OWNER_TOKEN` can trivially compute the cookie — which is fine because knowing the token IS the authentication primitive (per `/gate?token=` route). But it also means any code path that leaks the token value leaks the cookie value permanently.

**Audit implication**: check every place `LAIN_OWNER_TOKEN` is read — any log line, error message, or debug dump that includes it is equivalent to leaking the cookie.

### 3. `isOwner` returns `false` silently on missing token (P2)

Line 29. `if (!ownerToken) return false`. If `LAIN_OWNER_TOKEN` env is unset in any of the character/doctor server processes (systemd misconfig), owner can't access any of those surfaces silently — and the owner can't tell "auth is misconfigured" from "I'm not authenticated". Consistent 401 with no differentiation.

**Fix**: log.warn(once) on cold path if LAIN_OWNER_TOKEN is unset.

### 4. `timingSafeEqual` used correctly (positive, line 42)

Guards against timing-attack comparison of the cookie. Length check at line 41 before `timingSafeEqual` is correct (tSE throws on unequal lengths, so the guard is required). Positive pattern.

### 5. Cookie regex `[a-f0-9]+` — bounded charset (positive, line 34)

Matches lowercase-hex only — matches `digest('hex')` output. Tight.

### 6. `HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` cookie attributes (positive, line 52)

- `HttpOnly` — JS can't read. Good.
- `SameSite=Strict` — CSRF guard. Good.
- `Path=/` — sent to all paths. Fine.
- `Max-Age=31536000` (1 year). **Missing `Secure` attribute.**

### 7. Missing `Secure` attribute on cookie (P2)

Line 52. Cookie is NOT marked `Secure`. Over HTTP (dev, or misconfigured production), cookie flows in cleartext. Production deploys at `https://laintown.com/` (per prior session context about nginx) — but the cookie itself doesn't enforce HTTPS transport. If a single HTTP redirect hop or a subdomain over HTTP ever fires, cookie leaks.

**Fix**: add `Secure` conditionally when request was received over HTTPS or unconditionally in production. Consider `__Host-` prefix: `__Host-lain_owner=...; Secure; Path=/; ...` for strongest browser enforcement.

### 8. `v1` suffix in HMAC_MESSAGE suggests forward-looking migration (positive)

Line 14. The `-v1` hints at awareness that the scheme may need bumping. Good. But there's no `v2` pathway today — rotation requires a code deploy.

## Non-issues / good choices
- HMAC-based stateless verification — every server can validate without shared state.
- `timingSafeEqual` for comparison.
- Hex charset regex prevents exotic injection into cookie parsing.
- `HttpOnly` + `SameSite=Strict` on the cookie.
- No shared session storage reduces attack surface.

## Findings to lift
- **P2**: No session revocation / rotation primitive beyond global `LAIN_OWNER_TOKEN` rotation.
- **P2**: Missing `Secure` cookie attribute.
- **P2**: `isOwner` silently returns false on missing env — owner misconfig looks identical to unauthenticated state.

## Verdict
Small, focused, reasonably-written auth primitive. The cookie scheme is stateless-by-design (no server-side session table), which eliminates one class of bugs (session-fixation, session-desync between servers) at the cost of revocation ergonomics. `Secure` attribute missing is the one concrete gap. `v1` versioning shows forward thought.
