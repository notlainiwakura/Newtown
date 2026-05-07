# `src/providers/openai.ts`

OpenAI SDK wrapper. 275 lines — roughly 1/3 the size of Anthropic provider. Implements only `complete`, `completeWithTools`, `continueWithToolResults`. **No streaming methods implemented.**

## Methods

### `getTextContent(content)` helper, line 20

`filter → map → join(' ')` on content blocks.

**Gaps / bugs:**
- **Drops ALL non-text content silently.** For an `ImageContentBlock` passed to OpenAI, the image data is simply omitted. OpenAI has supported vision (GPT-4V) since 2023 — gpt-4o, gpt-4.1, etc. all accept image blocks. The wrapper doesn't translate them, so a caller that sends an image to the OpenAI provider gets a text-only response. **P2 — lift**: OpenAI provider silently drops image blocks; vision is broken.
- `.join(' ')` (single space) can merge text blocks into nonsense when the LLM meant structured output. **P3.**

### `constructor(config)`, line 43

Passes `baseURL` through to SDK. Supports proxy / self-hosted endpoints. Good.

**Gaps / bugs:**
- Same no-early-validation-of-API-key concern as Anthropic. Fine for a pass-through. **P3.**
- `defaultMaxTokens = 8192` — OK.

### `complete(options)`, line 53

Non-streaming completion.

**Gaps / bugs:**
- **`max_tokens` is the deprecated OpenAI param.** Modern OpenAI API uses `max_completion_tokens` — and the reasoning models (o1, o3, o4-mini) REJECT `max_tokens` outright, throwing `BadRequestError: Unsupported parameter: 'max_tokens'`. Any character configured with an o-series OpenAI model will fail every call. **P2 — lift**: uses deprecated `max_tokens` param, incompatible with OpenAI o-series reasoning models.
- **`temperature: options.temperature ?? 1`** — o-series models only accept `temperature: 1` (any other value errors). A caller setting `temperature: 0.3` on an o-series model fails. **P2** — bundled.
- **`role: m.role`** — if `m.role === 'system'` and the model is an o-series reasoning model, OpenAI wants `role: 'developer'` (or omits system messages entirely). Not translated. **P2** — bundled.
- Uses shared `withRetry` from `./retry.js` — different pattern from Anthropic's inline retry. Consistency concern covered in retry.ts audit.
- **No `stream: true` option** — fine, this is the non-streaming path.

### `completeWithTools(options)`, line 91

Tool-use path.

**Gaps / bugs:**
- **`JSON.parse(tc.function.arguments)` not wrapped.** (line 138) — if OpenAI returns malformed JSON in tool arguments (rare but documented edge case under high temperature or when the model reaches token limit mid-argument), this throws and the entire response fails. The Anthropic streaming path wraps parse in try/catch; this non-streaming path doesn't. **P2 — lift**: unguarded `JSON.parse` on tool-call arguments crashes the whole response on any malformed tool call.
- Same `max_tokens` / `temperature` / `role` issues as `complete`.
- **No `refusal` field extraction.** `choice.message.refusal` is a newer field (since mid-2024) where the model declines to answer. When present, `choice.message.content` is `null`, and this code returns `content: ''` with no indication WHY. Caller has no way to distinguish safety refusal from empty response. **P2 — lift**: OpenAI `refusal` field ignored — safety-refusal responses look identical to empty completions.
- `enableCaching` is entirely ignored. OpenAI does support prompt caching (automatic, no opt-in needed — happens based on the prompt prefix); but `cached_tokens` in `prompt_tokens_details` is also ignored. **P3.**

### `continueWithToolResults(options, toolCalls, toolResults)`, line 155

Advance tool-use conversation.

**Gaps / bugs:**
- **`role: m.role as 'system' | 'user' | 'assistant'`** — blank cast. If any existing message has `role === 'tool'` (which is a valid OpenAI role), the cast lies at compile time and the SDK receives it anyway. Luckily, the cast is a no-op at runtime, so passthrough works, but TS won't catch mistakes. **P3.**
- **`options.toolChoice` is NOT passed through** (same as Anthropic's `continueWithToolResults`). **P2** — already lifted as a cross-provider issue.
- **Replays tool_use blocks as a SEPARATE assistant message** (line 167-178). This is the OpenAI-native shape: an assistant message with `content: null` and `tool_calls: [...]`. No preceding text narration loss here (since OpenAI's assistant message already doesn't include text alongside tool calls in the same way Anthropic does). Fine.
- Same unguarded `JSON.parse` on `tc.function.arguments` (line 223).
- Tool-result messages (line 179) are `role: 'tool'`. Fine.
- **No handling of parallel tool calls order.** OpenAI returns multiple tool calls in one turn; caller must return ALL tool results as separate `role: 'tool'` messages. This loop does that correctly — one message per tool result. OK.

### `mapFinishReason(reason)`, line 240

Switch over `stop | length | content_filter | tool_calls`.

**Gaps / bugs:**
- **Default → 'stop'.** Unknown finish reasons (`'function_call'` for legacy models, `'refusal'`, or future additions) become 'stop'. Same silent-swallow P2 lifted from Anthropic. **P2** — bundled (cross-provider pattern).

### `mapToolChoice(choice)`, line 257

Simple translation.

**Gaps / bugs:**
- **`'none' → 'none'`** — CORRECT here (unlike Anthropic's buggy mapping). OK.
- **Object case returns `{ type: 'function', function: { name } }`** — OK, matches OpenAI spec.

### Missing methods

**Gaps / bugs:**
- **No `completeStream` / `completeWithToolsStream` / `continueWithToolResultsStream`.** Callers that use `provider.completeStream?.(...)` with the OpenAI provider silently get undefined and must fall back to buffered non-streaming. Since the base interface has these as optional, the type system doesn't flag it — but any character configured with OpenAI is effectively non-streaming. **P2 — lift**: OpenAI provider has NO streaming support. Characters on OpenAI get buffered responses (full latency wait) instead of progressive streaming.

### `createOpenAIProvider(config)`, line 273

Trivial factory.

---

## File-level notes

- **Significantly less featureful than the Anthropic provider.** Missing: streaming (4 methods), prompt caching (`enableCaching`), refusal handling, vision support, o-series compatibility, cache-token usage accounting.
- **Uses shared `withRetry` from retry.ts** — different from Anthropic's inline retry. When retry.ts is audited, check whether its classifier handles OpenAI-specific error shapes (429, `insufficient_quota`, `model_not_found`).
- **`baseURL` plumbing exists** (good for proxies, LMStudio, LocalAI, etc.) but no validation — caller can pass malformed URLs.
- **No error-class translation** — raw SDK errors propagate. Same as Anthropic.
- **No `stop_sequences` mapping issue** — OpenAI's `stop` field accepts the same array shape. OK.
- **Given the CLAUDE.md positions this platform as multi-provider, OpenAI support is load-bearing** for any BYOK scenario. The gaps here (no streaming, no vision, no o-series) are meaningful blockers.

## Verdict

**Lift to findings.md:**
- **P2**: OpenAI provider drops image blocks silently — vision support is broken. `getTextContent` filters to text-only; image content blocks vanish. Any character configured with a vision-capable OpenAI model (gpt-4o, gpt-4.1) that receives an image input gets a text-only response, no error.
- **P2**: Uses deprecated `max_tokens` param — incompatible with o-series (o1, o3, o4-mini) reasoning models, which require `max_completion_tokens`. Should switch to the new param and gracefully fall back for legacy models.
- **P2**: Unguarded `JSON.parse(tc.function.arguments)` in both `completeWithTools` and `continueWithToolResults`. Any malformed tool-call arguments from OpenAI throw synchronously and crash the entire response path.
- **P2**: OpenAI `choice.message.refusal` field is never extracted. Safety refusals look identical to empty completions to the caller. Map it to a new `finishReason: 'refusal'` (requires adding to the union in base.ts).
- **P2**: OpenAI provider has NO streaming implementations (`completeStream`, `completeWithToolsStream`, `continueWithToolResultsStream`). Callers using optional-chain fall back to buffered non-streaming silently. Characters on OpenAI lose progressive chat UX.
