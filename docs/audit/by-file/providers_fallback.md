# `src/providers/fallback.ts`

Wraps a provider with a model fallback chain. 170 lines. When the active model returns "model gone" (404/410 or string-match "deprecated"/"decommissioned"/etc.), transparently advances to the next model in the list and promotes it.

## Functions

### `isModelGoneError(error)`, line 25

Checks status 404/410 or string patterns.

**Gaps / bugs:**
- **Case-insensitive message matching.** Good.
- **404 is ambiguous.** A misconfigured endpoint (wrong base URL, wrong path) also returns 404. The fallback logic would then march through every model in the chain, each hitting the same misconfigured endpoint, before giving up with "all models exhausted". Operators see a chain of "model X is gone" warnings when the real issue is misconfig. **P3** — could narrow by requiring status==404 AND a model-not-found message.
- **Anthropic often returns 400 with message "model not found"** — not 404. Good thing we fall through to message-pattern matching. Catches this case.
- **`'invalid model'` pattern** also catches OpenAI's "Invalid model" and Google's "model is not valid" error texts. OK.

### `createFallbackProvider(primaryProvider, fallbackModels, factory)`, line 52

Core factory. Returns a proxy Provider.

**Gaps / bugs:**
- **Empty fallback list returns primary unchanged.** Good — no wrapping cost.
- **`activeProvider` mutation via closure** — concurrent in-flight requests can race on promotion. Worst case: after promotion, a slightly-stale reader calls `activeProvider.model` and gets the new model name. Eventually consistent, no correctness bug, but log lines during a transition can be misleading. **P3.**
- **`failedModels` is never cleared.** Once a model is marked failed (even for a transient deployment blip), it stays failed for the entire process lifetime. Anthropic rolling out a fresh SKU with propagation lag could get marked failed and never retried until process restart. **P3** — could add a TTL on the failed-models set.
- **No "reset to primary" signal.** If the primary model recovers, we don't re-try it. The promoted fallback becomes the permanent choice. For deployments where primary == cheaper / faster, this means post-incident we stay on the worse model. **P3.**
- **`factory(model)` called fresh every iteration.** The factory is expected to return a usable provider for the given model name. No caching — if the factory is expensive (initializes SDK client, reads keychain), we pay that cost per-fallback-attempt. In practice it's cheap. **P3.**
- **`ProviderFactory` interface is insufficient for cross-provider fallback.** Only takes a model name. If the fallback list contains models from DIFFERENT providers (e.g. Anthropic Sonnet → OpenAI GPT), the factory has to figure out which SDK to instantiate based on the model string — awkward, error-prone. Acceptable for intra-provider fallback chains (the common case). **P3.**
- **Error on exhaustion is a plain `new Error(...)`, not typed.** Callers can't distinguish "fallback exhausted" from any other Error. **P3.**
- **`failedModels` set is closed-over per proxy instance.** Each character has its own proxy (their own fallback state). Fine.

### `completeStream` proxy, line 116

**Gaps / bugs:**
- **Silent streaming downgrade.** `p.completeStream ? p.completeStream(options, onChunk) : p.complete(options)` — if the current active provider doesn't implement streaming (OpenAI, Google providers don't), the fallback proxy calls `complete(options)` instead. The `onChunk` callback is never invoked; the caller thinks they're getting a streamed response but actually gets one delayed batch at the end. **P2 — lift**: fallback proxy silently drops the `onChunk` callback when active provider has no streaming; caller cannot detect the downgrade.
- Same pattern in `completeWithToolsStream` (line 135) and `continueWithToolResultsStream` (line 160).

### Proxy provider getters, line 108

`name` and `model` are read-through getters on `activeProvider`. OK — callers reading these see the current active, not the primary.

**Gaps / bugs:**
- **`name` getter always reflects active.** If primary is Anthropic and fallback is OpenAI, calling `provider.name` after promotion returns `'openai'`. Consumers that branch on provider name (e.g. for cache-control, caching hints) would silently flip behavior. Intentional? Probably yes. **P3.**

### Non-streaming proxy methods, lines 112-151

Straightforward. Delegate via `withFallback`. OK.

---

## File-level notes

- **No metrics / ops signal.** Fallback activation is a meaningful operational event (primary model deprecated) but the only signal is `logger.warn` / `logger.info`. No emit to event bus, no counter. Operators can't answer "how often are fallbacks firing?" without log grep.
- **No concurrency guard on promotion.** If 20 requests concurrently hit the active provider and it fails with model-gone, all 20 run through the fallback chain independently, each calling `factory(model)` for each model in the list until success. Correct but wasteful — a simple promise-coalescing cache would collapse 20 factory calls to 1. **P3.**
- **`isModelGoneError` doesn't consider `insufficient_quota`** — which OpenAI returns when the API key has hit its usage cap. That's not "model gone" but it's another "switch to a different provider" signal. Currently propagates, no fallback. **P3** — likely out of scope for this module.
- **Interaction with `withRetry`:** the retry happens INSIDE `fn` (the provider's concrete `complete` call which internally uses `withRetry`). So on a 429, retry fires first; if retry exhausts, the error bubbles up to `withFallback`, which checks `isModelGoneError` — false for 429 — propagates. Good composition. No interference.

## Verdict

**Lift to findings.md:**
- **P2**: Fallback proxy silently downgrades streaming to non-streaming when the active provider has no stream impl. The `onChunk` callback passed by the caller is never invoked. Caller can't detect the downgrade — no warning, no error, just delayed buffered response. Ties to the OpenAI/Google providers lacking streaming P2 lifted earlier.
