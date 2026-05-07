# `src/providers/anthropic.ts`

Anthropic SDK wrapper. Extends `BaseProvider`. 758 lines, ~14 methods (including helpers). Primary code path for every character — this is the default provider.

## Methods

### `constructor(config)`, line 34

**Gaps / bugs:**
- **No env-var validation at construction.** `apiKey: config.apiKey ?? process.env['ANTHROPIC_API_KEY']` — if both are undefined, the SDK silently accepts `apiKey: undefined`. The first actual API call throws a cryptic "Missing API key" from deep in the SDK. An early guard (`if (!resolvedKey) throw new ConfigurationError(...)`) would fail fast at provider init. **P3.**
- **`defaultMaxTokens = 8192` hardcoded.** Different models have different practical defaults. Haiku 4.5's default might differ from Opus 4.7's. Tied to `ProviderConfig` tunables P2. **P3.**

### `withRetry<T>(fn)`, line 47

Exponential backoff: 1s, 2s, 4s → throw. Retries only on overloaded/timeout errors.

**Gaps / bugs:**
- **String-matching on `.message`.** `isOverloadedError` and `isTimeoutError` both string-match error message text. Anthropic SDK wraps errors in structured classes (`APIError` / `APIOverloadedError` subclass). Should use `instanceof` where possible. Translation changes or SDK upgrades would silently break retry logic. **P2 — lift**: retry classifier is string-match on error message.
- **Does NOT retry on 429 rate-limit responses.** Anthropic API returns `429 rate_limit_error` with `retry-after` header. The current classifier catches "timeout" and "overloaded" — not rate limits. Rate-limit errors go directly to the caller, bypassing the retry path. Likely explains intermittent production failures during traffic spikes. **P2 — lift**: 429 rate-limits are not retried.
- **Does NOT honor `Retry-After` header.** Even if the retry classifier were extended to 429s, the current backoff is fixed 1s/2s/4s. A server hint of "retry after 30s" is ignored. **P2** — bundled.
- **Not cancelable.** `await new Promise((resolve) => setTimeout(resolve, delay))` — no AbortSignal check. If the outer request was abandoned, the retry loop keeps consuming up to 1+2+4 = 7s of backoff + the API calls themselves. Ties to the abortSignal plumbing P2 from base.ts. **P2** — bundled.
- **`throw new Error('unreachable')`** after the loop — dead code (TS wants a return). Fine, but `throw new Error('unreachable')` leaks through in stack traces. **P3.**
- **MAX_RETRIES = 3 + initial = 4 total attempts.** No exposure to config. `ProviderConfig` tunables P2 — bundled.

### `isOverloadedError(error)`, line 68 / `isTimeoutError(error)`, line 77

Trivial string checks.

**Gaps / bugs:**
- `name === 'AbortError'` in `isTimeoutError` is treated as a retryable condition. If a caller aborts the request deliberately, `withRetry` would keep retrying — likely not what the caller wanted. **P2 — lift**: deliberate aborts retried as if they were timeouts.

### `complete(options)`, line 85

Non-streaming completion path. Separates system prompt, builds Anthropic params, calls `withRetry`.

**Gaps / bugs:**
- **`temperature: options.temperature ?? 1`** — default 1.0 is hot. Anthropic's own default is also 1. OK. Fine.
- **Only extracts FIRST text block.** `response.content.find((c) => c.type === 'text')` — if the model returns interleaved text + tool_use blocks, only the first text is surfaced. Subsequent text blocks (e.g. post-tool-use narration) are dropped. For `complete()` without tools, there's no interleaving, so this is fine. But the pattern is repeated in `completeWithTools` below where it MATTERS. **P2 — lift**: only first text block returned from response — loses interleaved assistant narration.
- **`mapStopReason` on `response.stop_reason`** — doesn't check for `'refusal'` or future reasons. Silent fallback to `'stop'`. **P3.**
- `enableCaching` is IGNORED by `complete()` (caching helpers only invoked in `completeWithTools*`). A caller passing `enableCaching: true` to `complete` silently gets no caching. **P2 — lift**: `enableCaching` silently ignored by `complete()`.

### `completeStream(options, onChunk)`, line 123

Streaming version of `complete`. Same shape.

**Gaps / bugs:**
- Same `enableCaching` ignored.
- Same first-text-only extraction.
- **`event.message?.usage.input_tokens`** on `message_start` — captures input tokens once. `cache_read_input_tokens` and `cache_creation_input_tokens` (separate fields in Anthropic's streaming events) are NOT captured. Bundled with the base.ts usage P2.
- Streaming has no timeout/abort. `for await (const event of stream)` can hang indefinitely if the stream stalls mid-response. Anthropic's SDK may have its own timeout, but nothing here enforces one. **P3.**

### `completeWithTools(options)`, line 190

Tool-use path with optional caching.

**Gaps / bugs:**
- **First-text-only extraction (line 225-226).** `response.content.find((c) => c.type === 'text')`. After a tool-use block, the model often emits thinking text before the `tool_use` block AND sometimes after. Only one is returned. **Already lifted above, but this is the high-impact site** — tool-use flows are the most common pattern (every character interaction).
- **`options.enableCaching ?? false`** — default NO caching. Meaning every agent call without explicit `enableCaching: true` pays full per-token cost. Audit needed in `src/agent/index.ts` to confirm callers pass the flag. **P2 — lift**: caching defaults to OFF — potentially big cost left on the table.
- **Unknown `block.type` fallback** in `toAnthropicMessages` returns `[unknownType]` as a text block, silently. New content block types from the base abstraction (e.g. future `document` block) become the literal string `[document]` in the prompt. **P3**.

### `completeWithToolsStream(options, onChunk)`, line 250

Streaming tool-use path.

**Gaps / bugs:**
- **Partial-JSON tool call dropped silently.** If the stream is interrupted mid-`tool_use` block (network glitch), `JSON.parse(currentToolCall.inputJson || '{}')` throws and the catch logs a warning. The tool call is NOT added to `newToolCalls`. But the LLM's `finishReason === 'tool_use'` indicates a tool call was emitted. Downstream `continueWithToolResults` then receives an empty `toolCalls` array and fails to advance the conversation — OR, worse, the caller sees `toolCalls.length === 0` and treats the response as final, when actually it was incomplete. **P2 — lift**: partial tool-call parse failure silently drops the call, caller can't distinguish from "no tool call".
- Same first-text-only, no cache-token usage, no abort.
- **Massive code duplication with `completeWithTools`.** Same streaming handler shape duplicated in `continueWithToolResultsStream`. **P3.**

### `continueWithToolResults(options, toolCalls, toolResults)`, line 357

Advance a tool-use conversation.

**Gaps / bugs:**
- **`options.toolChoice` is IGNORED.** The continue params don't pass `tool_choice`. If the caller wants to force a specific tool on the continuation turn, or force no tool use, the hint is dropped. **P2 — lift**: toolChoice not passed through on `continueWithToolResults` (both streaming and non-streaming).
- **Assistant-message content is ONLY the tool-use blocks** (line 367) — NOT the preceding text the model emitted before the tool call. The first-text-only extraction combined with this means: every time we continue from a tool call, we forget the assistant's text from that turn. The model sees its own tool_use without the context of the narration it wrote around it. For conversational agents this degrades coherence. **P2 — lift**: tool-continue loses assistant text, only replays tool_use blocks.
- **Builds `allMessages` including tool results but does NOT re-apply tool definitions.** Actually, looking again, `tools` IS built and passed. OK.
- **No inline `assistantContent` cache control.** Even with `enableCaching`, only the last user message (tool results) gets cache_control. The assistant's tool_use block doesn't participate in the cache breakpoint plan. Acceptable — next iteration's assistant output won't be cached anyway.

### `continueWithToolResultsStream(...)`, line 442

Streaming version. Same issues as non-streaming continue + same issues as completeWithToolsStream. Duplication.

### `separateSystemPrompt(messages)`, line 572

Pulls system messages out, joins with `\n\n`.

**Gaps / bugs:**
- **Non-string content in a system message silently becomes `''`** (line 581: `typeof m.content === 'string' ? m.content : ''`). A caller who passes a system message with content blocks (e.g. to embed cache breakpoints or image context) loses it entirely. Anthropic API supports content-block system prompts but this wrapper strips them. **P3** — latent.
- **Joins with `\n\n`** — fine, but fixed separator collapses any structural intent the caller had with multiple system messages. **P3.**

### `toAnthropicMessages(messages)`, line 594

Translates generic `Message[]` → `Anthropic.MessageParam[]`.

**Gaps / bugs:**
- **Unknown block types become `[type]` text**. Already noted.
- **No handling for `'tool'` role.** If a caller passes `role: 'tool'` (OpenAI-style tool result), the mapping `m.role as 'user' | 'assistant'` type-coerces silently to a wrong role. The Anthropic API would then reject or interpret strangely. Since the base interface doesn't define `'tool'` role, callers *shouldn't* pass it — but nothing enforces this. **P3.**

### `buildCachedSystem(systemPrompt)`, line 639

Wraps system text in a single text block with `cache_control: { type: 'ephemeral' }`.

**Gaps / bugs:**
- **Returns `[]` for empty system prompt.** Anthropic SDK may not accept `system: []` — verify. If it throws, every call with no system prompt + caching fails. Likely the SDK accepts empty arrays, so OK in practice. **P3.**

### `buildCachedTools(tools, enableCaching)`, line 655

Applies cache_control to the LAST tool only — which caches ALL tools together per Anthropic docs.

**Gaps / bugs:**
- Fine — last-tool cache anchor is the documented pattern.

### `withMessageCaching(messages)`, line 685

Adds cache_control to the last content block of the last USER message.

**Gaps / bugs:**
- **String content is converted to a single-block array with cache_control.** Fine.
- **Uses `as unknown as typeof last`** type cast for existing-block cases (line 716) — "cache_control is supported on all content block types but not yet in all SDK type definitions". Acceptable for the type-system workaround.
- **Doesn't add cache control to the ASSISTANT message that preceded.** On a multi-turn conversation, only the last user message has a cache breakpoint — the assistant responses between don't. That's fine for the Anthropic cache model (breakpoints divide the conversation into cacheable prefixes up to the breakpoint).
- **4-breakpoint limit:** system(1) + last-tool(1) + last-user-message(1) = 3 breakpoints used. OK, one to spare. **No bug.**

### `mapStopReason(reason)`, line 723

Switch over `end_turn | stop_sequence | max_tokens | tool_use`.

**Gaps / bugs:**
- **Default case returns `'stop'` for any unknown reason.** If Anthropic adds a new `stop_reason` (e.g. `'refusal'` — which they've indicated may come for safety), it silently becomes `'stop'`. Caller can't distinguish a refusal from a normal completion. **P2 — lift**: unknown stop reasons silently map to `'stop'` — safety refusals invisible to caller.

### `mapToolChoice(choice)`, line 739

Maps generic `toolChoice` to Anthropic's shape.

**Gaps / bugs:**
- **`'none' → { type: 'any' }`.** The inline comment says "Anthropic doesn't have 'none', use 'any'". This is backwards. Anthropic's `'any'` means "MUST use a tool, any tool". Anthropic's `'none'` means "MUST NOT use tools" (supported via `{ type: 'none' }` in modern SDK). These are OPPOSITES. A caller passing `toolChoice: 'none'` expecting the LLM to NOT use tools gets forced-tool-use instead. **P1 — lift**: `toolChoice: 'none'` maps to `'any'`, forcing exactly the opposite behavior the caller asked for.

### `createAnthropicProvider(config)`, line 755

Trivial factory. Fine.

---

## File-level notes

- **Streaming and non-streaming paths duplicate ~200 lines of handler logic.** A shared `parseStream(stream, onChunk)` helper that returns `{ content, toolCalls, usage, finishReason }` would collapse all 4 implementations into something maintainable. **P3.**
- **Cache-token counts are never exposed** (`cache_creation_input_tokens`, `cache_read_input_tokens` in Anthropic's usage shape). The `CompletionResult.usage` only has `inputTokens` / `outputTokens`. Budget accounting is off by the cache delta. Already lifted as P2 in base.ts.
- **Error handling collapses all error kinds.** Overloaded, timeout, 429, 500, network, auth, invalid model — all go through `isOverloadedError` / `isTimeoutError` or straight through to the caller with the raw SDK error. No translation to the app's `RateLimitError` / `ConfigurationError` / etc. in `utils/errors.ts`. **P3.**
- **No tests visible in file.** Assume external test coverage lives elsewhere. Confirm during test audit.
- **No hook for budget or rate-limit accounting.** Every call bypasses any central "did this cost too much?" check. The budget module (to be audited) must wrap the provider externally.

## Verdict

**Lift to findings.md:**
- **P1**: `toolChoice: 'none'` is mapped to Anthropic's `'any'` — literally the opposite behavior. Any code path that disables tool use via the abstract `'none'` actually FORCES tool use. Simple fix: `return { type: 'none' };` (or remove the option and document that `'none'` isn't reliably supported across providers).
- **P2**: Retry classifier is string-match on `.message`. Uses `instanceof Anthropic.APIError` (or similar) would be robust against SDK phrasing changes.
- **P2**: 429 rate-limits are not retried. `isOverloadedError` / `isTimeoutError` don't cover them. Add `isRateLimitError` + honor `Retry-After` header.
- **P2**: Deliberate `AbortError`s are retried as if they were timeouts — caller's cancel signal is defeated by `withRetry`.
- **P2**: Only the FIRST text block is extracted from responses. Assistant narration that interleaves with tool_use blocks is silently dropped, affecting every tool-using conversation.
- **P2**: `enableCaching` is silently ignored by `complete()` (it only takes effect on `completeWithTools*`). Callers with system-prompt-heavy non-tool completions pay full cost.
- **P2**: `enableCaching` defaults to `false`. Every agent call without explicit opt-in pays full per-token cost. Verify during agent audit whether the defaults are being set.
- **P2**: Partial tool-call JSON parse failure in streaming drops the tool call silently while `finishReason='tool_use'` is still reported. Caller can't distinguish from "no tool call".
- **P2**: `continueWithToolResults` does not pass through `options.toolChoice` — the caller's tool-choice hint is ignored on the continuation turn.
- **P2**: `continueWithToolResults` replays only tool_use blocks for the assistant turn, not the preceding text narration. Conversation coherence suffers on each tool round.
- **P2**: `mapStopReason` silently falls back to `'stop'` for unknown reasons. A future `'refusal'` from Anthropic would be invisible to the caller — critical for safety monitoring.
