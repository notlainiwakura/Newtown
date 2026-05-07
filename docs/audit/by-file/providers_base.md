# `src/providers/base.ts`

Pure interface file. Defines `Message`, `CompletionOptions`, `CompletionResult`, `Tool*`, `Provider` interface, and an `abstract class BaseProvider` that adds nothing beyond re-asserting the three abstract methods.

No executable logic. Just types. But types shape every consumer.

## Types / interfaces

### `StreamCallback`, line 5

`(chunk: string) => void`. Fine.

### `TextContentBlock` / `ImageContentBlock`, lines 7-19

Anthropic-flavored shapes. `ImageContentBlock.source` has `type: 'base64'` as the ONLY option — no URL-based images.

**Gaps / bugs:**
- **Provider coupling at the type level.** The shape `source: { type: 'base64', media_type: ..., data: ... }` is literally the Anthropic API shape. OpenAI and Google providers must translate on every call. If they forget to translate for a new block type, the request fails at runtime with a provider-specific error. **P2 — lift**: provider-neutral message content type leaks Anthropic API shape.
- **Diverges from `src/types/message.ts:ImageContent`** which supports `url | base64`. Two parallel content types in the codebase. `types/message.ts` is user-facing (internal app model); this file is provider-facing. No translation layer is enforced — if a caller passes a `types/message.ts`-shaped image block into a provider, it blows up. **P3** (or P2 if the gap is actually exploited; defer until provider audits confirm).

### `Message`, line 23

`role: 'system' | 'user' | 'assistant'`, `content: string | ContentBlock[]`.

**Gaps / bugs:**
- **No `'tool'` role.** Tool results are passed through `continueWithToolResults(toolCalls, toolResults)` as a separate argument — but Anthropic internally represents tool results as a user message with `tool_result` content blocks, and OpenAI represents them as `role: 'tool'`. Without a `'tool'` role in the abstract shape, every provider has to invent its own pattern for threading prior tool turns back into `messages[]` when the conversation continues across multiple tool rounds. If a provider forgets, multi-round tool use breaks silently. **P3** — verify during provider implementations.
- `content: string | ContentBlock[]` — no way to express "assistant emitted tool_use blocks" via this type. That information only lives in the `toolCalls` returned from the last `completeWithTools` call, not in `messages[]`. If the caller wants to persist conversation state and resume, they have to reassemble the turn themselves.

### `CompletionOptions`, line 28

`messages`, `maxTokens?`, `temperature?`, `stopSequences?`, `enableCaching?`.

**Gaps / bugs:**
- **No `timeout?` / `abortSignal?`.** The `withTimeout` P2 already lifted (timer fires but inner call keeps running) applies to every `provider.complete` path. Without a plumbing point for `AbortSignal`, there's no clean way to fix it. Adding an `abortSignal?: AbortSignal` to this interface would be the natural spine for a system-wide fix. **P2 — lift**: no abort/timeout plumbing in provider contract.
- **No `topP?` / `topK?` / `seed?` / `maxToolRounds?`.** Provider-specific knobs that callers need to tune per character (e.g. creative-writing vs. analytical). Currently every consumer has to reach into the provider's concrete impl to change them, breaking the abstraction. Ties to `ProviderConfig missing tunables` P2 already lifted. **P2** — bundled.
- **`enableCaching?` is Anthropic-specific.** OpenAI doesn't support the same prompt-cache semantics; Google has its own context-cache API with different granularity. Passing `enableCaching: true` to the OpenAI/Google implementations is either silently ignored or incorrectly interpreted. **P3** — rename to `providerHints` generic object, or scope the flag per provider.

### `CompletionResult`, line 37

`content`, `finishReason`, `usage`.

**Gaps / bugs:**
- **`finishReason: 'tool_use'`** on `CompletionResult` but `CompletionResult` has no `toolCalls` field — only `CompletionWithToolsResult` does. If a plain `complete()` call somehow returns `finishReason: 'tool_use'` (shouldn't happen by convention but nothing in the type prevents it), the caller has no toolCalls to consume. Dead reason on this type. **P3** — remove `'tool_use'` from `CompletionResult.finishReason`, keep only on `CompletionWithToolsResult`.
- **`usage.cacheReadTokens` / `cacheCreationTokens` missing.** Prompt-caching returns these as separate line items in the Anthropic API and factor heavily into cost accounting. `providers/budget.ts` (deferred) probably has to scrape them from elsewhere. **P2 — lift**: usage shape doesn't expose cache token counts.
- **No `rateLimitInfo` / `retryAfter`.** Providers like Anthropic return rate-limit headers (`anthropic-ratelimit-requests-remaining`, etc.). Currently surfacing those requires reading through raw response data that the abstraction hides. Budget / backoff can't tune without it. **P3** — extension gap.

### `ToolDefinition` / `ToolCall` / `ToolResult`, lines 46-62

`inputSchema: Record<string, unknown>` on ToolDefinition, `input: Record<string, unknown>` on ToolCall.

**Gaps / bugs:**
- **No schema validation on `input`.** `ToolCall.input` comes back from the LLM as a parsed JSON object. Nothing enforces it matches the `inputSchema` declared on the tool. Tool handlers have to defensively validate every field. **P3** — could add a zod-based validator helper, but this is widely accepted practice in LLM tooling.
- **`ToolResult.content: string` — strings only.** Can't return structured output (e.g. an image the tool fetched, a JSON object a tool computed). For image-returning tools (browser screenshots, diagram generation) the handler has to base64-encode + embed-in-markdown. Awkward. **P3** — extension gap.
- **`ToolResult.toolCallId` naming.** Anthropic uses `tool_use_id`, OpenAI uses `tool_call_id`. This library's `toolCallId` is fine as an abstraction, but every provider has to translate.

### `CompletionWithToolsOptions` / `CompletionWithToolsResult`, lines 64-71

Extends Completion types with `tools` + `toolChoice`.

**Gaps / bugs:**
- **`toolChoice` shape is Anthropic-ish.** `'auto' | 'none' | { type: 'tool'; name: string }`. OpenAI's `tool_choice` supports `{ type: 'function', function: { name: ... } }`. Translation needed per provider. **P3** — acceptable abstraction.
- **`toolCalls?: ToolCall[]` is optional on result.** A caller iterating tool calls has to null-check every time. Should be `toolCalls: ToolCall[]` (empty array when none) — same discipline as `usage` being required. **P3** — stylistic.

### `Provider` interface, line 73

Methods: `complete`, `completeStream?`, `completeWithTools`, `completeWithToolsStream?`, `continueWithToolResults`, `continueWithToolResultsStream?`.

**Gaps / bugs:**
- **Stream methods are optional.** A consumer calling `provider.completeStream?.(...)` has to defensively handle the `undefined` case. If every concrete provider is expected to implement streaming, these should be required. If not, the optional-chain at every call site is error-prone — easy to miss, easy to silently fall back to non-streaming. **P2 — lift**: streaming methods optional on Provider, no indicator of which providers implement them.
- **No `countTokens(messages)` method.** Callers who want to check token budget before sending (e.g. `buildMemoryContext` in memory/index.ts) have to rely on the `text.length / 4` heuristic (already lifted as a P3). Adding `countTokens?: (messages) => Promise<number>` would allow a provider-accurate count. **P3** — extension gap.
- **No `getModelInfo()` or `getContextWindow()` method.** Every consumer hardcodes assumptions about context limits (`MAX_CONTEXT_TOKENS = 7000` in memory/index.ts, already lifted P2). The provider itself knows its window; it should expose it. **P2** — bundled with MAX_CONTEXT_TOKENS P2.
- **No `close()` / `dispose()`.** Providers may hold SDK clients with HTTP keep-alive pools or background timers. On process shutdown, no clean-up signal. **P3** — lifecycle gap.

### `BaseProvider` abstract class, line 123

Abstract class that just re-declares the three required methods as abstract. Provides NO shared behavior.

**Gaps / bugs:**
- **Zero shared logic.** If `BaseProvider` exists to host helpers (retry wrappers, logging, usage-merging across tool rounds, auto-translation between Anthropic-flavored content and OpenAI-flavored), it's not doing any of that. As written, `extends BaseProvider` offers nothing beyond `implements Provider` — the abstract class is dead code. **P3** — either put shared helpers here or drop the class.
- **Doesn't declare the optional stream methods.** So `class Anthropic extends BaseProvider` has to add `completeStream` separately, and its type won't be checked against `Provider.completeStream?`'s signature unless the concrete impl also adds `implements Provider`. Easy to get a signature drift between stream and non-stream variants on the same provider. **P3.**

---

## File-level notes

- **Pure type file, no runtime behavior** — but the type surface here dictates the contract for every provider. A missing field here cascades into every consumer.
- **Provider-specific leakage**: `ImageContentBlock.source`, `enableCaching`, `toolChoice` shape, Anthropic-style multi-turn tool use. The abstraction pretends to be neutral; in practice it's ~80% Anthropic-shaped. Honest labeling would be: "adapters translate from Anthropic-flavored to OpenAI/Google shapes."
- **Nothing about rate limits, retries, cost estimation, or budget** lives in the base. Those concerns live in sibling files (retry, budget, fallback) — not threaded through. This audit should look at how much they work against the grain of the base interface.

## Verdict

**Lift to findings.md:**
- **P2**: No `abortSignal` / `timeout` plumbing in `CompletionOptions`. The `withTimeout` no-abort P2 can't be properly fixed until the provider contract includes a cancel mechanism. Adding `abortSignal?: AbortSignal` would be the single point of leverage.
- **P2**: Provider-neutral message content type (`ImageContentBlock.source: { type: 'base64', ... }`) is literally the Anthropic API shape. OpenAI/Google providers must translate on every call. A new block type (e.g. Anthropic adds `document` blocks) propagates into non-Anthropic paths silently.
- **P2**: `usage` shape doesn't expose cache read/write token counts. Prompt-caching (`enableCaching`) affects cost dramatically; budget/logging can't account for it without those numbers. Usage should be `{ inputTokens, outputTokens, cacheReadTokens?, cacheCreationTokens? }`.
- **P2**: Streaming methods (`completeStream?`, `completeWithToolsStream?`, `continueWithToolResultsStream?`) are optional on `Provider`. Callers either optional-chain defensively or hardcode "provider X supports streaming" knowledge. Either make them required (with a default "stream-then-buffer" implementation on BaseProvider) or add a `supportsStreaming: boolean` flag.
- **P2**: No `getContextWindow()` / model-info method on `Provider`. Every consumer hardcodes context-window assumptions. Bundled with the `MAX_CONTEXT_TOKENS = 7000` P2 from memory/index.ts.
