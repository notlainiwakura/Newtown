# `src/providers/google.ts`

Gemini SDK wrapper. 301 lines. Like OpenAI provider: implements `complete`, `completeWithTools`, `continueWithToolResults`, but **no streaming**.

## Methods

### `getTextContent(content)` helper, line 21

Same as OpenAI provider — drops all non-text blocks.

**Gaps / bugs:**
- **Gemini supports vision (Gemini 1.5+, 2.0, 2.5 all accept image/video/audio).** This wrapper silently discards image blocks. Multimodal characters on Google provider lose media capability. **P2** — bundled with the OpenAI image-drop finding (cross-provider pattern: both OpenAI and Google providers silently drop images; only Anthropic translates them).

### `constructor(config)`, line 43

`new GoogleGenerativeAI(config.apiKey ?? process.env['GOOGLE_API_KEY'] ?? '')`

**Gaps / bugs:**
- **Falls back to empty string `''`.** If both `config.apiKey` and env var are undefined, passes `''` to the SDK. Worse than `undefined` because the `??` chain never sees "missing"; the SDK initializes with a blank key and fails on first use with a cryptic 401 / 403. **P3** — add an early "missing API key" check.

### `complete(options)`, line 52

**Gaps / bugs:**
- **`response.text()` throws on safety-blocked responses.** The Google SDK's `text()` accessor intentionally throws if the response was blocked (`finishReason = 'SAFETY'` or similar). This code calls `text()` unconditionally (line 72). A safety-blocked completion throws synchronously, bypassing the `mapFinishReason` that would have returned `'content_filter'`. Caller sees an exception instead of a graceful "blocked" result. **P2 — lift**: `response.text()` unguarded — safety-blocked responses throw instead of returning mapped finishReason.
- **`buildGenerationConfig` applied to every model.** Includes `thinkingConfig: { thinkingBudget: 0 }`. See notes below.
- `systemInstruction` passed via `getGenerativeModel` — correct for Gemini API.

### `completeWithTools(options)`, line 84

Tool-use path.

**Gaps / bugs:**
- **Synthesized tool call IDs.** `id: \`call_${toolCalls.length}\`` (line 130). Google's function-calling API doesn't emit IDs, so the wrapper generates sequential ones. But `continueWithToolResults` then matches `toolResults[i].toolCallId` against these synthesized IDs. If the caller crosses wires (stored a tool call, restarted the process, tried to continue from disk), the synthetic IDs don't carry identity — two different calls could both be `call_0`. Order-dependent identity. **P2 — lift**: Google tool-call IDs are synthesized by counter; not stable across retries / restarts; matching is order-dependent.
- **No check that `functionCall.name` is a known tool.** If the model hallucinates a function name, it goes through untouched — the handler downstream has to validate. **P3.**
- **`functionCall.args` cast to `Record<string, unknown>`** with `?? {}` fallback. Safe for the common path. **P3.**
- **No explicit `toolChoice` mapping.** Options includes `toolChoice` but it's never read in this file. Google has its own `toolConfig.functionCallingConfig.mode` (`AUTO | ANY | NONE`) — not plumbed through. Every request falls back to the Gemini default. **P2 — lift**: `toolChoice` option completely ignored by Google provider.
- **`genModelParams as unknown as Parameters<...>`** double-cast (line 113). Workaround for SDK typing. Fine but ugly. **P3.**

### `continueWithToolResults(options, toolCalls, toolResults)`, line 151

**Gaps / bugs:**
- **`toolCalls.find((tc) => tc.id === tr.toolCallId)?.name ?? 'unknown'`** (line 175). If a tool result's `toolCallId` doesn't match any tool call in the turn (mismatched input, stale ID, caller bug), the function name becomes `'unknown'`. Gemini API either rejects the request or executes a nonsensical function-response for a nonexistent function. Either way the caller gets garbage with no clue why. **P2 — lift**: mismatched tool-call IDs produce `functionResponse.name: 'unknown'` — silent corruption of the continuation request.
- **`functionResponse.response: { result: tr.content }`** — wraps the string content in `{ result: ... }`. Gemini accepts structured responses, but a `{ result: "..." }` envelope isn't idiomatic. Caller-side tools that return JSON would prefer passing it through unwrapped. Currently the string is a flat scalar; downstream model sees `{"result": "..."}`. **P3**.
- **`options.toolChoice` still ignored.**
- Same image-drop, no-streaming, double-cast workaround.

### `convertMessages(messages)`, line 248

Separates system messages, maps `'assistant' → 'model'`, wraps content in `parts: [{text: ...}]`.

**Gaps / bugs:**
- **Always produces a single text Part.** Doesn't emit `{ inlineData: { mimeType, data } }` for image blocks. Confirms the vision-drop. **Covered by P2 above.**
- `role` mapping: only `assistant → model`; everything else (including `'tool'`) becomes `'user'`. If a caller passes a `'tool'` role message, it becomes a user message. Not a bug today (our base doesn't use `'tool'` role), but silent. **P3.**
- System messages are joined with `\n\n` into a single string. OK.

### `buildGenerationConfig(options)`, line 266

Builds the Gemini `generationConfig`.

**Gaps / bugs:**
- **`thinkingConfig: { thinkingBudget: 0 }` hardcoded.** Comment explains it's a workaround for Gemini 2.5 Flash thinking mode consuming the output budget. BUT this is applied to EVERY model — Gemini 2.0 / 1.5 don't have thinking mode and may either (a) ignore the field silently, or (b) error out. Also: anyone who WANTS thinking mode (e.g. using Gemini 2.5 Pro for complex reasoning) has no way to enable it — the option isn't exposed. **P2 — lift**: `thinkingBudget: 0` hardcoded — blocks thinking mode for all callers on all Gemini models, no knob to enable.
- **No `topP` / `topK` / `candidateCount` / `responseMimeType` / `responseSchema` exposed.** Gemini supports JSON-mode structured output via `responseSchema`, which would eliminate the `JSON.parse` tool-call parsing risks. Not plumbed through. Tied to `ProviderConfig` tunables P2.

### `mapFinishReason(reason)`, line 281

Switch: `STOP | MAX_TOKENS | SAFETY | default → 'stop'`.

**Gaps / bugs:**
- **Only handles 3 of ~8 Gemini finish reasons.** Missing: `RECITATION` (model regurgitated training data), `OTHER`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII` (sensitive personally identifiable info), `MALFORMED_FUNCTION_CALL`. All silently become `'stop'`. Content-safety signals invisible to caller. **P2** — bundled with cross-provider "unknown stop reason silently maps to stop" pattern.

### `createGoogleProvider(config)`, line 298

Trivial factory.

---

## File-level notes

- **No streaming at all.** Same gap as OpenAI. Any character on Google provider loses progressive chat UX.
- **No tests visible.** Standard caveat.
- **Google provider is the most-translated:** system prompt goes to a different top-level field, role mapping, tool_calls become `functionCall` parts, usage fields renamed. Lots of surface area for silent bugs as the SDK evolves.
- **`thinkingBudget: 0` is a silent performance/quality tradeoff.** For any character using a Gemini 2.5+ reasoning-capable model, this disables the model's reasoning entirely. If someone deploys a character expecting Gemini 2.5 Pro reasoning, they get non-reasoning completions. Should be per-character configurable.
- **Tool-call IDs are synthesized** — this breaks every feature built around stable tool IDs (audit logs, retries, partial-continue patterns). Consider synthesizing a content-hash-based ID instead of counter-based.

## Verdict

**Lift to findings.md:**
- **P2**: `response.text()` called unguarded — Google SDK throws on safety-blocked responses. The caller gets an exception instead of the mapped `'content_filter'` finishReason. Wrap in try/catch or read `candidates[0].content.parts` directly.
- **P2**: Google tool-call IDs are synthesized as `call_0`, `call_1`, ... by position in the response. IDs aren't stable across retries, process restarts, or partial continues. Any flow that stores tool calls and resumes later breaks silently.
- **P2**: `options.toolChoice` is completely ignored by the Google provider. Not translated to Gemini's `toolConfig.functionCallingConfig.mode`. `toolChoice: 'none'` doesn't disable tools; `toolChoice: { name: 'x' }` doesn't force that tool. The caller's hint is dropped.
- **P2**: `toolCalls.find(...)?.name ?? 'unknown'` on tool-result mismatch — if a `toolResult.toolCallId` doesn't match any pending tool call, the function name becomes `'unknown'` and gets sent to Gemini. Silent corruption of the continuation request.
- **P2**: `thinkingConfig: { thinkingBudget: 0 }` is hardcoded in every Google request. Blocks Gemini 2.5 reasoning entirely, with no way for callers to opt in. Older Gemini 1.5/2.0 models may error or log warnings on the unknown field.
