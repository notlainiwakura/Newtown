# `src/security/ssrf.ts`

SSRF (Server-Side Request Forgery) defense. 297 lines, 5 exports: `checkSSRF`, `isPrivateIP`, `sanitizeURL`, `safeFetch`, `isAllowedDomain`, `isBlockedDomain`. Only `safeFetch` has a caller in the application (`web/server.ts:2339` — the research-gateway URL-fetch route, used by characters asking Wired Lain to research a link). `checkSSRF` is additionally imported by `browser/browser.ts:7` and `agent/curiosity.ts:24` where it guards an internal fetch.

The call-site context matters: **the URLs being fetched come from character requests**, which ultimately trace back to model output (tool calls) or user messages. Any SSRF bypass turns Wired Lain into a proxy for internal-network probing from the droplet.

## Functions

### `checkSSRF(url)`, line 61

Parses URL → scheme allowlist/denylist → hostname denylist → if IP, check private; if hostname, resolve DNS (IPv4 then IPv6 fallback) and check each returned IP.

**Gaps / bugs:**

- **DNS rebinding race with `safeFetch`.** `checkSSRF` performs its own DNS lookup via `dns.resolve4`/`dns.resolve6`. `safeFetch` then calls `fetch()`, which does its own DNS lookup again at the HTTP layer. An attacker controlling DNS for a hostname responds with a public IP on the first query (passes the SSRF check) and a private IP (169.254.169.254, 127.0.0.1, 10.0.x.x) on the second query. The actual fetch connects to the private IP. Classic TOCTOU bypass, well-documented SSRF defense anti-pattern.

  With the research gateway as the attack surface (character posts a URL at `/api/research`), the attacker gets a proxy into the droplet's internal network. AWS-style metadata services, internal Postgres, another character's server (`localhost:3001`), etc. are all reachable. **P1 — lift**: DNS rebinding vulnerability in `safeFetch` — DNS is resolved by `checkSSRF` separately from `fetch()`'s own resolution; attacker controlling DNS bypasses the check by returning public IP on first resolve and private IP on the actual request. Fix: resolve once, then issue fetch to the resolved IP with the original hostname in the `Host` header (via custom undici dispatcher or node's http.Agent with `lookup` function).

- **IPv6 ULA regex is underspecified.** `PRIVATE_IP_RANGES` includes `/^fc00:/i` and `/^fd00:/i`. The actual ULA range is **fc00::/7** — the first byte is `fc` or `fd`, the second byte is anything. An address like `fcab:cd::1` or `fd12:3456::1` bypasses these regexes because they only match the exact prefix `fc00:` / `fd00:`. A DNS-controlled attacker returning `fcab::1` passes. **P2 — lift**: IPv6 ULA range check is too narrow — `/^fc00:/i` and `/^fd00:/i` only match strings literally beginning with those prefixes; fc00::/7 requires matching `fc` or `fd` followed by any two hex digits, then `:`.

- **IPv4-mapped IPv6 not normalized.** `::ffff:127.0.0.1` is IPv4 loopback wearing an IPv6 costume. `isIP('::ffff:127.0.0.1')` returns 6 (IPv6). `isPrivateIP` doesn't match `/^127\./` because the string starts with `::ffff:`. None of the IPv6 patterns match either. Bypass. Same applies to `::ffff:169.254.169.254`, `::ffff:10.0.0.1`, etc. **P2 — lift**: `isPrivateIP` doesn't normalize IPv4-mapped IPv6 addresses (`::ffff:a.b.c.d`) before pattern-matching; all IPv4 private ranges bypass when wrapped in the IPv4-mapped IPv6 form.

- **IPv4 ranges missing: 0.0.0.0/8, 224.0.0.0/4 (multicast), 240.0.0.0/4 (reserved), 255.255.255.255.** `0.0.0.0` is blocklisted as a hostname but `0.0.0.1` through `0.255.255.255` aren't. On some Linux kernels `0.0.0.0:port` is reachable as a local-interface alias; other addresses in 0.0.0.0/8 are a subject of varying kernel behavior. Multicast and reserved are less exploitable but harden anyway. **P2** — bundled with the IPv6 gap.

- **Dual-stack preference: IPv4 first, IPv6 only on IPv4 failure.** If a hostname has BOTH A and AAAA records, `dns.resolve4` returns the A records, loop runs, no private match, returns `safe: true` — AAAA records are never checked. A host returning a public A record AND a private AAAA record (link-local `fe80::`, ULA `fd...`) passes SSRF because only IPv4 was inspected. When fetch runs, Node's dual-stack resolver may pick either address family; on some OSes IPv6 wins by default (Happy Eyeballs). So you pass SSRF on IPv4 and actually connect on IPv6 to a private address. **P2 — lift**: dual-stack DNS check inspects IPv4 only when A records exist; AAAA records are never checked for hosts with both. Fix: resolve and inspect BOTH families before returning safe.

- **DNS timeout hardcoded at 5000ms** — not configurable. **P3.**
- **BLOCKED_HOSTNAMES entry `'[::1]'` is dead.** `new URL('http://[::1]/').hostname` returns `'::1'` (brackets stripped). The list literal never matches. The `::1` case is correctly handled via `PRIVATE_IP_RANGES`'s `/^::1$/` further down. **P3.**
- **BLOCKED_HOSTNAMES has `'metadata.google.internal'` twice** (lines 41 and 43). Harmless duplicate. **P3.**
- **No check for NAT64 prefixes** (`64:ff9b::/96`). These translate IPv4 addresses to IPv6. `64:ff9b::a00:1` == `10.0.0.1`. A route via a NAT64 gateway reaches the private IPv4 space. **P3** — niche, most deployments don't run NAT64.
- **No user/password-bearing URL is rejected at checkSSRF.** Credentials don't imply SSRF, but a URL like `http://attacker.com@internal.svc:80/` parses with hostname `internal.svc`. Good — the hostname extraction is correct, checkSSRF looks at `internal.svc`. But if a naive caller logs or reuses the URL string without going through `sanitizeURL`, the creds leak. Minor. **P3.**

### `isPrivateIP(ip)`, line 173

Just runs the pattern array.

**Gaps / bugs:**
- **Inherits every gap in PRIVATE_IP_RANGES** (IPv6 ULA narrowness, IPv4-mapped IPv6 blind spot, missing 0/8 and multicast/reserved).
- **Called by `checkSSRF` AND by `browser/browser.ts` via the security/index barrel (separately) — consistent behavior, but any fix needs to cover both call paths.

### `sanitizeURL(url)`, line 185

Strips credentials, normalizes hostname, rejects non-http(s).

**Gaps / bugs:**
- **Never called directly by any caller**; only used internally by `safeFetch` at line 225. Re-exported via `security/index.ts` but nobody imports from the barrel. If the barrel ever drops it, only safeFetch still compiles. **P3** — dead external API surface.
- **Doesn't canonicalize path**. Percent-encoded `..%2f..%2f` sequences pass through. If any caller eventually compares the URL's path to a whitelist, canonicalization matters; current callers just forward the URL to fetch. **P3.**
- **Normalizes hostname with `.toLowerCase()` BUT not IDN**. Internationalized domain names (Punycode / Unicode) aren't converted. `xn--bcher-kva.example` and `bücher.example` look different but route the same. Could bypass allowlist checks in `isAllowedDomain`. **P3** — depends on whether allow/block list callers care; today nobody calls those.

### `safeFetch(url, options)`, line 210

Runs `checkSSRF`, sanitizes, fetches with `redirect: 'manual'` and a 30s AbortController, manually inspects Location header on 3xx.

**Gaps / bugs:**
- **DNS rebinding (lifted above as the primary finding).** The SSRF check is decoupled from the fetch; attacker can flip the DNS answer in between.
- **30s fetch timeout is hardcoded.** Caller's `options.signal` is overwritten by `controller.signal` on line 239. The caller's abort is lost. If the caller already passed a tighter `AbortSignal.timeout(15000)` (as server.ts:2344 does), that signal is replaced by the 30s controller — so the caller's 15s timeout never fires. **P2 — lift**: `safeFetch` overrides caller's `AbortSignal` with its own fixed 30s timeout controller. Caller cannot enforce a shorter timeout or cancel the request externally. Fix: compose signals with `AbortSignal.any([controller.signal, options.signal])` or respect caller's signal if present.
- **Redirect check handles one hop only.** The manual redirect inspection only covers the single 3xx response this call returns. The caller receives the redirect response and must decide whether to follow. If they invoke `safeFetch` recursively, each hop is checked; if they follow via plain fetch, they bypass. The current caller (server.ts:2339) just reads `response.text()` on non-redirect responses and returns an error on non-`ok`; it doesn't follow 3xx at all. OK in practice today. **P3** — document for future callers.
- **Doesn't verify that `response.url` matches the pre-fetch-resolved IP.** Even without DNS rebinding, a MITM could redirect at a lower layer. Out of scope for this module. **P3.**
- **Redirect Location header may be relative** (`Location: /admin`). The current code does `checkSSRF(location)` which parses `/admin` as a URL — fails, returns `safe: false`, `reason: 'Invalid URL: ...'`. OK — fails safe. But the code THROWS on `!redirectCheck.safe`, so the caller sees the redirect as an error rather than as a redirect to the same host. Relative Location headers are normal and valid. **P3** — resolve relative Location against response.url before checking.

### `isAllowedDomain(url, allowedDomains)`, line 263

Hostname match or subdomain (`.endsWith('.' + domain)`).

**Gaps / bugs:**
- **Never called anywhere.** Re-exported via `security/index.ts`, no importer. Dead API. **P2 — bundled with dead-exports below.**
- **No port enforcement.** `example.com:8080` matches the `example.com` allowlist entry. For most uses this is desired; for strict defense it might not be. **P3.**
- **No IDN normalization.** See `sanitizeURL` note.

### `isBlockedDomain(url, blocklist)`, line 284

Mirror of `isAllowedDomain`. Returns `true` (block) on parse failure — fail-closed, good.

**Gaps / bugs:**
- **Never called anywhere.** Dead API. **P2 — bundled.**

## File-level notes

- **One real SSRF defense path**: checkSSRF + safeFetch, used once (web/server.ts:2339 research gateway). The other callers (curiosity.ts, browser.ts) invoke `checkSSRF` alone and then do their own fetch — meaning the DNS rebinding race applies to curiosity and browser-tool paths too, not just safeFetch. That multiplies the blast radius of the TOCTOU gap.
- **No CIDR library**. IP range checks are regex. Any serious SSRF defense should use a CIDR matcher (e.g. `ipaddr.js`) against the full IANA special-use list. The manual regex approach will always have gaps.
- **No tests visible** for this module. For security code, that's the usual caveat but more pointed: edge cases like IPv4-mapped IPv6 and ULA wildcards are exactly the kind of bug tests would catch.
- **Observability**: blocked requests log at `warn` (checkSSRF failures inside safeFetch). No counter, no rate-limiter — a character being tricked into probing 1000 internal IPs in a loop would produce 1000 log lines and no aggregate signal. **P3.**
- **No redirect-chain limit.** If a caller follows redirects via repeated safeFetch calls, there's no infinite-redirect protection from this module. **P3** — caller responsibility, but worth documenting.

## Verdict

**Lift to findings.md:**
- **P1**: DNS rebinding vulnerability — `checkSSRF` resolves DNS separately from the subsequent `fetch()` call. Attacker controlling DNS for a hostname serves a public IP on the first lookup (passes SSRF) and a private IP on the second lookup (actual fetch). The research gateway (`web/server.ts:2339`) accepts URLs from characters and is the primary attack surface; curiosity and browser tools share the same race. Fix: resolve DNS once in `checkSSRF`, then pin the fetch to the resolved IP via a custom undici dispatcher or `http.Agent` with a `lookup` function that returns the pre-resolved address. Route the original hostname through the `Host` header so TLS SNI and vhost routing still work.
- **P2**: IPv6 ULA range check too narrow — `/^fc00:/i` and `/^fd00:/i` only match the exact `fc00:`/`fd00:` prefix. The fc00::/7 range means any address beginning with `fc` or `fd` followed by any two hex digits, then `:`. `fcab:cd::1` bypasses. Fix: use `/^(fc|fd)[0-9a-f]{2}:/i` or a binary CIDR matcher.
- **P2**: `isPrivateIP` doesn't normalize IPv4-mapped IPv6 addresses. `::ffff:127.0.0.1`, `::ffff:169.254.169.254`, `::ffff:10.0.0.1` all bypass every private-IP regex. Fix: strip the `::ffff:` prefix and re-test as IPv4 before the IPv6 patterns.
- **P2**: Dual-stack DNS check inspects A records first and skips AAAA when A succeeds. A hostname with both public A and private AAAA records (link-local `fe80::`, ULA) passes SSRF on IPv4; the subsequent fetch may happen over IPv6 to the private address depending on OS dual-stack preference. Fix: resolve BOTH families and fail if EITHER contains a private address.
- **P2**: `safeFetch` replaces the caller's `AbortSignal` with its internal 30s-timeout controller. `web/server.ts:2344` passes `AbortSignal.timeout(15000)` expecting a tighter timeout; that signal is dropped. Callers cannot enforce shorter timeouts or cancel externally. Fix: combine via `AbortSignal.any([controller.signal, options.signal])` when the caller provides one.
- **P2**: Dead exports — `sanitizeURL`, `isAllowedDomain`, `isBlockedDomain` are re-exported from `security/index.ts` but have zero external callers. Either wire them into the intended use (allow/blocklist a domain policy per character) or remove from the API surface.
