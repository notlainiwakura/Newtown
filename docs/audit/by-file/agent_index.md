# `src/agent/index.ts`

THE core agent loop. 1153 lines. Two parallel entrypoints (`processMessage` and `processMessageStream`) that are ~95% identical, plus `initAgent` / state management.

## Functions

### Re-exports (no logic)

Lines 128-142 re-export `loadPersona`, `buildSystemPrompt`, `applyPersonaStyle`, `registerTool`, `unregisterTool`, `getToolDefinitions`, `executeTool`, `executeTools`, `getConversation`, `addUserMessage`, `addAssistantMessage`, `clearConversation`. OK.

### `getPostboardContext()`, line 38 (private, async)

Reads pinned+recent postboard messages, injects into system prompt. Tries local DB first, then HTTP fallback to Wired Lain.

**Gaps / bugs:**
- **Silent catch** (line 64). If parse, fetch, or anything throws, returns empty string. Matches module pattern (all context injections swallow). Collectively these become a silent-context-degradation family — see file-level notes.
- **Pin/recent mixing** takes all pinned + up to 5 non-pinned. If 50 pins exist, the prompt blows up. **P3.**
- **`recent.slice(0, 5)` vs. pinned count unbounded** — no total size guard. **P3.**

### `getTownEventContext()`, line 69 (private, async)

Same shape as postboard: local first, HTTP fallback. Splits events by `source === 'admin'`.

**Gaps / bugs:**
- **Silent catch** (line 110). Same pattern.
- **Labels leak into system prompt verbatim** — if event description contains prompt-injection characters, they land inside a system-prompt template. `sanitize()` not applied. Bundled with cross-cutting P2 on sanitizer not centrally enforced. **P3.**

### `agentLog(context, data)`, line 117

Writes debug JSON to `logs/agent-debug.log` under `process.cwd()`.

**Gaps / bugs:**
- **CWD-relative path** — all 7 character processes write to the SAME log file (under whichever dir systemd starts from). Interleaved output across characters. No per-character scoping. **P2 — lift**: agentLog (and the parallel toolLog in tools.ts) writes to a single process-cwd-relative `logs/agent-debug.log` shared by every character process, producing interleaved debug output with no per-character scoping.
- **No size cap, no rotation.** Every LLM response, every tool call, every tool result gets JSON.stringified with `null, 2` and appended. For a 100KB streaming response this writes 100KB per cycle, per character. On a busy droplet this grows fast and will eventually fill the disk. **P2** bundled.
- **No log-level gate.** Runs on every request regardless of env (no `DEBUG=1` check). Always-on debug logging. **P2** bundled.
- **Silent failure** (line 123). OK in isolation, but combined with above, log loss can mask issues. **P3.**

### `initAgent(config)`, line 161

Loads persona, builds system prompt, initializes 3-tier providers (`personality`, `memory`, `light`), then calls `loadCustomTools()`.

**Gaps / bugs:**
- **`loadCustomTools()` called at init registers any previously-LLM-created tool code.** These tools have `process`, `require`, `fetch`, `Buffer` in scope (see `skills.ts` P1). So on every process start, all custom tools are re-registered and become callable. If a prior LLM invocation created a malicious tool, the malice persists across restarts. **P1** — noted in `agent_skills.md`.
- **Provider init catches errors per-tier** but if `personality` tier fails, `provider` stays null → falls to echo mode for every message with no visible error to the user. Logger only warns. **P2** — lift: when personality-tier provider init fails, agent falls to echo mode silently (only a WARN log). The running character speaks only the echo-mode scripted replies. User perceives character as "broken but saying stuff" — no runtime surface that says "provider failed."
- **Hardcoded tier-name order** (line 170) `['personality', 'memory', 'light']` — first config entry is personality. If the operator's `characters.json` flips the order or adds a tier, everything misaligns. **P3.**
- **`config.id` used as agent registry key** (line 200), but `processMessage` always looks up `'default'` (line 245). So `initAgent({ id: 'pkd' })` stores under key `'pkd'` but `processMessage` hits the 'default' slot and fails to echo. **P2 — lift**: `initAgent` registers under `config.id`, but `processMessage` / `processMessageStream` hardcode `agentId = 'default'`. Any agent whose config.id isn't exactly `'default'` is silently unreachable — processMessage falls to echo mode. The agents-Map architecture looks multi-tenant but is single-tenant in practice.

### `getAgent(agentId)`, line 220 / `isAgentInitialized(agentId)`, line 227

Trivial lookups.

### `getProvider(agentId, tier)`, line 234

Tier lookup with fallback to `personality` then `provider`.

**Gaps / bugs:**
- **`agents.get(agentId)` hits the real key**, so if external caller passes agent id `'pkd'` but processMessage uses `'default'`, these two code paths see different worlds. **P3** bundled.

### `processMessage(request)`, line 243 (MAIN)

Builds session → composes an enhanced system prompt from 10 context sources → adds to conversation → compresses/trims → calls provider with tools → applies persona style → records memory → fires memory-extraction background task.

**Gaps / bugs:**
- **Code duplication with `processMessageStream`** — ~270 lines, ~95% duplicated. Every context injection, every provider choice, every recordMessage / updateSession / memory-extraction / error path exists twice. When someone adds a new context injection (e.g. "inject building-memory residue"), they must remember to add it to BOTH. The current code already diverges in subtle ways if you read closely (e.g. `_no chunking on non-stream success path_ vs `onChunk(result.content)` in stream path). **P1 — lift**: `processMessage` and `processMessageStream` are ~270 lines of near-identical code (identical system-prompt assembly, identical persistence, identical error path). Any change to the request lifecycle must be made in two places, and drift is silent. Classic bug-farm. Extract the common body into a helper that takes an optional `onChunk`.
- **10 separate context-injection try/catch blocks** (lines 283-393): internal state, preoccupations, location, weather, awareness, objects, postboard, town events, building residue, memory context. Each `try { await import(...) } catch { /* non-critical */ }`. If any of these modules breaks, the character loses that context silently with NO log. Combined family makes character behavior mysteriously degrade (e.g. "the character suddenly doesn't know where they are") with zero observability. **P2 — lift**: 10 context-injection blocks in `processMessage` (and the mirrored 10 in `processMessageStream`) swallow all errors via empty `catch {}`. When any module (internal-state, awareness, objects, commune/location, building-memory, etc.) throws, the character invisibly loses that context. For a system whose liveness depends on these signals, silent degradation is the worst failure mode. Emit WARN per catch.
- **`getSelfConcept()` NOT wrapped in try/catch** (line 275). If that throws, processMessage errors out entirely. Inconsistent with the rest. **P3.**
- **`MAX_CONTEXT_TOKENS = 100000` hardcoded** (line 155). Different models have different context windows; some are 200k, some 32k. Fixed value assumes one model class. Already lifted P2 from `memory/index.ts` — bundled here. **P3 — bundled.**
- **`estimateTokens(text) = ceil(text.length / 4)`** (line 691). Rough; can under/over-estimate by 2× for non-ASCII. Same pattern as elsewhere. **P3.**
- **No rate-limiting** at the processMessage layer. Channels (web, telegram, gateway) have their own, but the agent runtime trusts inputs. **P3** bundled with cross-cutting.
- **`updateSession(tokenCount: session.tokenCount + ...)` read-modify-write** on session row (line 472). Two concurrent messages on the same session race; one write wins. Not catastrophic (just under-counts) but another instance of the module-wide RMW pattern. **P3.**
- **Memory extraction fire-and-forget** (line 466) — good. But its `.catch` only logs WARN. If extraction is persistently failing (provider rate-limited, DB locked), a rolling counter would let ops spot it. **P3.**
- **Primary-to-light fallback only retries once** (lines 428-438). `memory` tier is never tried. If both `personality` and `light` fail, the user gets the generic error message. **P3.**
- **Error message hardcoded Lain-style** (line 500) `'...something went wrong. the wired is unstable right now...'`. Every character speaks this if their provider crashes — character-integrity violation for PKD/McKenna/Dr-Claude/etc. **P2 — lift**: error-path message in both `processMessage` and `processMessageStream` is hardcoded Lain-speak ("...the wired is unstable..."), which leaks Lain's voice into every non-Lain character's error responses. Move the error copy behind the persona layer (or at minimum out of Lain-specific wording).
- **`eventBus.emitActivity` with sessionKey prefixed `state:conversation:end:${session.key}`** (line 459). Synthetic event format; consumers must parse. Fragile coupling. **P3.**
- **`PEER_CONFIG` parsed fresh twice per message** (lines 324, 352; stream 790, 818). Each parse re-allocates; each try-catch swallows a parse failure silently. **P3.**
- **`PEER_CONFIG` type expectations differ** — weather path uses `Array<{ id, url }>` (line 326) but awareness path uses `PeerConfig[]` (line 354) importing from character-tools (which has `{ id, name, url }`). Casting looseness means if the real shape drifts, one of the two paths crashes silently. **P3.**

### `generateResponseWithTools`, line 520 (private)

Runs up to 8 tool iterations. Feeds toolCalls+toolResults back through `continueWithToolResults`; also pushes synthetic `[Used toolName: ...]` messages into the outbound messages array for future iterations.

**Gaps / bugs:**
- **Hard cap MAX_TOOL_ITERATIONS = 8** (line 156). If the LLM is mid-multi-step research at iteration 8, we silently return whatever the last continue returned — possibly empty text with unanswered tool calls. No telemetry that we hit the cap. **P3.**
- **Mixed representation of tool iterations**: iter-1 ends up in messages as synthetic text (line 587-598), but the provider's `continueWithToolResults` handles iter-N as proper tool_use/tool_result blocks internally. So for iter N > 1, the model sees a mix — synthetic text for past iterations + protocol blocks for current. May confuse or double-up context. **P3.**
- **`tr.content.slice(0, 2000)` truncation** of synthetic messages (line 596) but the CURRENT-iteration toolResults passed to the provider are untruncated — asymmetric. **P3.**
- **`enableCaching: true` hardcoded** (line 539). Not tunable per call. For providers that don't support caching this is a no-op; for the ones that do, it's always on which is usually desired. **P3.**
- **`maxTokens: 8192` hardcoded**. Same comment — tied to Anthropic defaults. **P3.**
- **`isIncomplete` heuristic requests a summary** (line 615-638). If the LLM legitimately returns empty text after a successful multi-tool run, we force a "Summarize what you found" follow-up call. Extra LLM cost per response with empty-text tool-heavy runs. Works, but the guard is heuristic — would benefit from a finish-reason based gate. **P3.**

### `generateResponseWithToolsStream`, line 973 (private)

Same as `generateResponseWithTools` but with streaming via `completeWithToolsStream` when available, falling back to buffered `completeWithTools`.

- **All the same issues as above**, duplicated.
- **If `completeWithToolsStream` is missing on the provider but `continueWithToolResultsStream` IS present**, the first call is buffered (line 995-1007) but subsequent iterations stream. Inconsistent user experience within a single request. **P3.**

### `createEchoResponse`, line 652

Fallback when no provider.

**Gaps / bugs:**
- **Echo mode hardcoded as Lain**: line 662 `"i'm lain... lain iwakura"`. PKD/McKenna/Dr-Claude/John/Hiru without a provider all introduce themselves as Lain. **P2 — lift**: echo-mode response text in `createEchoResponse` is hardcoded Lain ("i'm lain... lain iwakura"), producing character-identity corruption for any non-Lain character whose provider failed to init. Route through persona layer instead.

### `estimateTokens(text)`, line 691 — rough 4-chars/token. OK gate, noted above.

### `processMessageStream(request, onChunk)`, line 701 — duplicate of processMessage. Bundled.

### `shutdownAgents()`, line 1151 — clears the agents map. OK.

## File-level notes

- **Whole module is effectively single-tenant** despite the `Map<string, AgentState>` shape. Any future multi-tenant use needs the agentId plumbed through (currently hardcoded `'default'` in message processors).
- **Observability**: WARN on primary-provider fallback (good), WARN on memory-context failure (good). Everything else is DEBUG / silent. The context-injection catch family (10 x empty-catch) is the biggest observability hole.
- **No tests visible for processMessage / processMessageStream**. The heaviest path in the system has zero test coverage visible in test/.

## Verdict

**Lift to findings.md:**
- **P1**: `processMessage` and `processMessageStream` are ~270 lines of duplicated logic — every context-injection, provider path, persistence, and error branch exists twice. Drift between them is silent. Extract common body to a helper that takes an optional `onChunk`.
- **P2**: 10 context-injection `try/catch {}` blocks swallow every failure silently in both processors. When internal-state / awareness / objects / location / building-memory / weather modules throw, the character silently loses that context. Emit WARN per catch.
- **P2**: `initAgent` registers the agent under `config.id`, but message processors hardcode lookup to `'default'`. Any non-default config.id is silently unreachable — processMessage falls to echo mode. Architecture looks multi-tenant but isn't.
- **P2**: When personality-tier provider init fails, agent falls silently to echo mode with only a WARN log. User perceives a "broken but talking" character. Should surface a health-check bit.
- **P2**: Error-path message in both processors is hardcoded Lain-speak. Non-Lain characters leak Lain's voice during any provider failure.
- **P2**: Echo-mode response in `createEchoResponse` hardcodes `"i'm lain... lain iwakura"`. Any non-Lain character without a provider identifies as Lain.
- **P2**: `agentLog` (and parallel `toolLog` in tools.ts) writes to a single `logs/agent-debug.log` shared by every character process (cwd-relative). No size cap, no rotation, no log-level gate. Grows unbounded with interleaved debug from all characters.
