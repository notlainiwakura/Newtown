# `src/browser/browser.ts`

Playwright-based browser automation. 364 lines, 8 exports. Uses `chromium` from `playwright-core ^1.49.1` (a ~100 MB dep). Module-level `browser` and `context` singletons.

**Context check first.** Grep for any importer inside `src/` other than `src/browser/index.ts` turns up **nothing**. The top-level barrel `src/index.ts:53` does `export * from './browser/index.js'` but `package.json`'s `"main": "./dist/index.js"` is effectively for self-consumption — there's no external consumer. **The entire browser module is dead code right now**, but it's heavy dead code (hauls Playwright + its chromium binary along).

That context matters because most of the security gaps below are **latent**: they don't hurt today, but if a future character tool wires `browse()` to LLM-initiated URLs, a handful become real.

## Functions

### `initBrowser(config)`, line 65

Launches chromium + creates a default context. Idempotent via `if (browser)` guard.

**Gaps / bugs:**
- **Singleton**: one process-wide `browser` + `context`. All eventual callers share cookies, localStorage, and fingerprint. If character A logs into a site (hypothetically, via `fillForm`), character B's next `browse()` inherits those cookies. No per-character isolation. **P2.**
- **`setDefaultTimeout(cfg.timeout ?? 30000)` applies to every concurrent page under the shared context.** Fine as a default but non-configurable per-call. **P3.**
- **`DEFAULT_CONFIG.timeout!` non-null assertion** (line 93). Works because `DEFAULT_CONFIG` sets `timeout: 30000`. Brittle: if anyone ever drops the default, assertion silently allows `undefined` through. **P3.**
- **No `--host-resolver-rules` or equivalent DNS pinning.** Once `checkSSRF` resolves the URL, Chromium resolves again at navigation time. Same DNS rebinding race as ssrf.ts (lifted there). Worse: unlike `fetch()` which you could wrap with a custom `lookup`, Chromium DNS is bolted in without custom hooks short of launch args. **P2** — inherits ssrf.ts P1 DNS-rebinding lift.

### `isBrowserInitialized()`, line 101

Trivial. OK.

### `closeBrowser()`, line 108

Awaits close with error swallowing. Idempotent.

**Gaps / bugs:**
- **No SIGINT/SIGTERM hook.** If the host process crashes or is killed with SIGKILL, the chromium subprocess persists. Over repeated restarts on the droplet, zombie chromium processes accumulate. **P3.**
- **Errors swallowed with `.catch(() => {})`.** Legitimate close failures (ETIMEDOUT, OS resource issues) become invisible. **P3.**

### `browse(url, options)`, line 128

Load a URL, extract title + content + links + optional screenshot.

**Gaps / bugs:**
- **Only the initial URL is SSRF-checked.** `page.goto(url)` follows redirects transparently (Playwright default). A 302 → `http://169.254.169.254/` is fetched by Chromium with no recheck. Same for meta-refresh redirects inside HTML. The `checkSSRF` at line 142 guards only the caller-specified URL. **P1 (latent)** — once `browse` is wired to LLM-supplied URLs, redirects become the primary SSRF bypass. Fix: either `page.setRequestInterception` + per-request SSRF check, or navigate with `referrer: '...'` and manually handle redirects via `page.on('response')` inspecting 3xx before allowing continuation.
- **Sub-resource loads not SSRF-checked at all.** A page can include `<script src="http://10.0.0.1/">`, `<img src="file:///etc/passwd">` (blocked by Chromium scheme policy, but `file://` in `<link>` may load), or a WebSocket to an internal port. Chromium fetches these during navigation. No interception configured. **P1 (latent)** — same gating as above.
- **`content.slice(0, 10000)` silent truncation.** Caller with a large-document use case sees partial content without a flag. **P3.**
- **`EXTRACT_CONTENT_SCRIPT` strips script/style/noscript** but not: `<object>`, `<embed>`, `<iframe>`, shadow DOM. Some pages put visible text in shadow DOM (modern web components) — extraction misses it. Edge case. **P3.**
- **`EXTRACT_LINKS_SCRIPT` caps at 50, DOM-ordered.** Header/nav links usually win over footer/content links. A character trying to find a "next page" link via DOM-order may miss it if buried past position 50. **P3.**
- **Screenshots as base64 data URIs** — no size cap. A `fullPage: false` on a complex page is ~50-200KB base64; fullPage is easily 1-3 MB. If returned to the LLM as-is, that's 15k-800k tokens. **P3.**
- **`waitUntil: options.waitFor ?? 'domcontentloaded'`** — domcontentloaded fires before async content loads. Many modern SPAs render via XHR after DCL; extraction sees a shell page. Default should probably be `'networkidle'` for characters scraping rendered content. **P3.**

### `screenshot(url, options)`, line 187

Same pattern as browse but screenshot-only. `waitUntil: 'networkidle'` (better default here).

**Gaps / bugs:**
- **Same redirect / sub-resource SSRF gaps** as `browse`. **P1 (latent).**
- **`options.quality` only applied when `type === 'jpeg'`.** Fine. **P3.**
- **No `clip` option exposed** — can't take region screenshots; forced full-viewport or full-page. **P3.**

### `evaluate(url, script)`, line 230

**The danger function.** Navigates to URL, runs arbitrary JS, returns result.

**Gaps / bugs:**
- **`script` is arbitrary JavaScript string, parameter unfiltered.** If any caller passes LLM-generated script here, the model gets arbitrary JS execution inside a Chromium tab sharing cookies with the whole singleton context. Capabilities include:
  - Exfiltrate DOM from authenticated sites visited earlier in the same context.
  - Probe internal network via `fetch('http://10.0.0.1/')` — checkSSRF happens on the initial URL (line 241), but fetch calls inside the page's JS context execute in Chromium's network stack without SSRF checks.
  - Schedule `setTimeout(..., 999999)` to tie up resources.
  - Redirect the page via `window.location` to unchecked URLs.
  
  Nobody calls this today. If a character tool ever exposes it, the tool description MUST make clear the script parameter is effectively "execute code on the server's browser." **P2 — lift**: `evaluate(url, script)` is arbitrary-JS-execution primitive with inadequate sandboxing — any future tool exposing it to an LLM gives the model a shell-equivalent capability (internal network probing via in-page `fetch`, access to any cookies the shared context has accumulated). Either gate behind an explicit per-character capability flag, or refactor into pre-defined extraction primitives instead of raw `script` strings.
- **Navigation redirect / sub-resource SSRF gaps** as above.
- **`as T` cast at line 252** — caller's T is whatever, no runtime check. Wrong shape crashes downstream. **P3.**

### `fillForm(url, formData, submitSelector?)`, line 261

Navigate → fill fields → optionally submit → re-extract.

**Gaps / bugs:**
- **Same redirect / sub-resource SSRF gaps.**
- **`waitForNavigation` on submit is deprecated in Playwright 1.49+** (replaced by `page.waitForURL` or `page.waitForLoadState`). Will emit deprecation warnings; may break in a future Playwright major. **P3.**
- **`formData` is Record<selector, value>.** If selectors or values come from LLM output, a malicious selector like `body` + a destructive value can mutate the page. But this is essentially "fill whatever the caller specified" — the trust model is whoever calls `fillForm`. OK. **P3.**
- **No CSRF token handling.** If a form includes a server-rendered CSRF token, fillForm doesn't touch it — submit will often fail. Sometimes that's desired; sometimes it's opaque. **P3.**
- **Submission target URL is NOT re-checked for SSRF.** A form's action attribute could point to `http://169.254.169.254/`. `page.click(submitSelector)` follows it. Same bypass. **P2** — bundled with browse() redirect P1-latent.

### `click(url, selector, options)`, line 317

Navigate → click selector → optionally waitForNavigation → extract.

**Gaps / bugs:**
- **`page.waitForTimeout(1000)`** (line 348) when `waitForNavigation` is false. Arbitrary 1s wait. Better: wait for a state change (network idle, selector appearance). **P3.**
- **`waitForNavigation` same deprecation concern as `fillForm`.** **P3.**
- **Clicked link's destination URL not SSRF-checked.** Same pattern. **P2** — bundled.
- **No way to pass click options** (button, modifiers, force, timeout). **P3.**

## File-level notes

- **Whole module is dead.** No internal importers. Playwright dep + chromium binary (~100 MB) are hauled along for nothing until a caller materializes. Either: (a) delete + remove the dep, or (b) gate behind a capability flag so only characters with `browser: true` in their manifest can use it. **P2 — lift**: entire browser module is dead code — no internal callers, no tests, but the playwright-core dependency and its chromium binary remain installed. Clean up or gate behind capability flag.
- **Security posture if activated**: SSRF defense through `checkSSRF` at every entrypoint, but the defense is **initial-URL-only** — follow-on redirects, sub-resources, form submissions, link clicks all bypass. The ssrf.ts DNS rebinding P1 applies too. Activating `browse`/`screenshot`/etc. without fixing these creates a multi-layer SSRF vulnerability.
- **Singleton context leaks state across "users".** If `browse` is later wired per-character, they'll share cookies/storage by default. Need per-character `browser.newContext()` with explicit eviction.
- **`evaluate(url, script)` is the most dangerous primitive in the codebase currently** (measured by "what could this do in the wrong hands"), and it's reachable via `src/index.ts` barrel. The only thing keeping it safe today is that nothing calls it. Document prominently.
- **No tests visible.** Standard caveat; especially pointed for security-adjacent code.
- **No observability.** Logger.debug on each entrypoint; no counter, no page-load outcome telemetry, no budget. If any future loop (e.g. Wired Lain's curiosity) ever uses browse() heavily, there's no way to detect runaway usage or abuse.

## Verdict

**Lift to findings.md:**
- **P2**: Entire browser module is dead code — no internal callers, yet playwright-core + its chromium binary remain installed (~100 MB). Either delete the module + dep, or gate behind a per-character capability flag so only characters configured with `browser: true` pull it in.
- **P2 (latent-P1)**: `browse`/`screenshot`/`evaluate`/`fillForm`/`click` SSRF defense is initial-URL-only. Redirects, sub-resources, form-submit targets, and click-destinations all pass through `page.goto`/`page.click` without per-hop `checkSSRF`. The module is dormant today, but the moment it's wired to LLM-supplied URLs this becomes a straight SSRF bypass (redirect to 169.254.169.254 or `http://localhost:3001/`). Fix: `page.setRequestInterception(true)` + per-request SSRF check, or manual redirect handling via `page.on('response')`.
- **P2**: `evaluate(url, script)` executes arbitrary JavaScript in a shared Chromium context. If any tool exposes this to LLM output as-is, the model gains server-side code execution, access to any cookies the shared context has accumulated, and the ability to probe the internal network via in-page `fetch` (which bypasses our SSRF layer entirely). Gate behind an explicit capability flag; prefer pre-defined extraction primitives over raw script strings.
- **P2**: Module-level `browser` + `context` singletons — if ever wired per-character, cookies/storage leak across characters. Need per-caller `browser.newContext()` with explicit lifecycle.
