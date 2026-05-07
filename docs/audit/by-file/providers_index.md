# `src/providers/index.ts`

Barrel re-exports + `createProvider` factory. 130 lines. Wraps the provider chain: primary → optional fallback → budget proxy.

## Functions

### `createSingleProvider(type, model, apiKey)`, line 50

Switch over 3 types. Trivial.

**Gaps / bugs:**
- **Hardcoded switch.** Adding a new provider (Mistral, local llama.cpp, Ollama, Bedrock) means editing this file + the config type union + writing a new provider file. Not a plugin system. **P3** — acceptable for 3 providers, noted if the surface grows.
- **`cfg: Parameters<typeof createAnthropicProvider>[0]`** — derives config type from the factory. Clever but ties this file to the provider's internal config shape.

### `trackUsage(result)`, line 73

`recordUsage(result.usage.inputTokens, result.usage.outputTokens)`.

**Gaps / bugs:**
- **Silent no-op if `result.usage` is missing.** The outer `withBudget` proxy guards `'usage' in result` before calling, so the function itself won't crash. But a provider that returns a response without usage (bug, streaming truncation, fake mock) records 0 tokens and still passes the budget check next time. **P3.**
- **Doesn't account for cache read/write tokens.** Ties to base.ts usage P2.

### `withBudget(provider)`, line 81

Proxy-wraps all 6 API methods with `checkBudget()` before + `trackUsage(result)` after.

**Gaps / bugs:**
- **`apiMethods` Set is hardcoded.** If a new method is added to `Provider` (e.g. future `countTokens` or `generateEmbedding`), it must be added here or it bypasses budget. **P3.**
- **`checkBudget()` calls `getMeta` on SQLite every invocation.** Fast but not free. For a character doing 100 API calls in a burst, 100 extra SQLite reads. Cheap but redundant. Could cache with short TTL. **P3.**
- **Proxy's `get` handler uses `Reflect.get`** which invokes getters properly (preserving `name` and `model` pass-through). OK.
- **No error path recording.** If the underlying call throws, `trackUsage` never fires. Generally correct (failed calls don't cost tokens). BUT: a call that succeeds partially then throws (e.g. streaming SDK emitted 1500 output tokens then the connection broke) still costs you tokens at the provider — and we don't record them. Undercounts usage in those edge cases. **P3** — acceptable given rarity.
- **`result as CompletionResult`** cast (line 100) — we've already checked `'usage' in result`, so the cast is type-narrowing only. Fine.

### `createProvider(config)`, line 113

Primary → optional fallback → budget wrap.

**Gaps / bugs:**
- **`apiKey: config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined`** — if `apiKeyEnv` is set but the env var is undefined, `process.env[config.apiKeyEnv]` returns `undefined`. OK.
- **If env var is set to empty string, returns `''`.** This gets passed to the concrete provider factory:
  - `AnthropicProvider`: `config.apiKey ?? process.env['ANTHROPIC_API_KEY']` — `''` is not nullish, so it's USED. Never falls back to the default env var name.
  - `GoogleProvider`: `config.apiKey ?? process.env['GOOGLE_API_KEY'] ?? ''` — same issue.
  - `OpenAIProvider`: same pattern.
  
  So if someone sets `apiKeyEnv: LAIN_ANTHROPIC_KEY` and that env is blank (common deployment mistake — config mentions env var but it wasn't populated), the provider initializes with an empty API key. The SDK then rejects on first call with a cryptic 401. **P2 — lift**: empty-string API key from a configured-but-blank env var doesn't trigger fallback to default env var; silent misconfig path.
- **Fallback factory captures initial `apiKey`.** If env rotates mid-process, fallback models still use the old key. Acceptable — key rotation typically requires process restart anyway. **P3.**
- **Fallback `factory` uses the SAME `config.type` for every model in the list.** So `fallbackModels: ['gpt-4o']` on an Anthropic primary would create an `AnthropicProvider` with model `gpt-4o` — which Anthropic doesn't know about → 400 → treated as model-gone → fall through to next. Eventually exhaust the chain with confusing errors. **P2 — lift**: fallback chain is locked to the primary's provider type; cross-provider fallback (Anthropic → OpenAI) not supported. The feature is silently rigid.
- **`withBudget` wraps the OUTER provider** — so all calls through the caller's handle go through budget. OK.
- **No caching of `createProvider` results.** Callers typically create once at startup and reuse. Fine.

### Re-exports, lines 5-37

Barrel. Fine.

---

## File-level notes

- **3 providers × no plugin mechanism.** Extending to new SDKs means editing at least 3 files (types/config, providers/index, new provider). **P3.**
- **Provider chain order fixed: primary → fallback → budget.** Retry is baked INTO the concrete provider (inline in Anthropic, via `withRetry` helper in OpenAI/Google). So the order is: budget → fallback → retry → HTTP. That ordering means:
  - Budget check fires once per "request attempt" (including fallback attempts).
  - Retry fires per-provider-call (each fallback model gets its own retry budget).
  - Fallback advances on persistent `isModelGoneError` only.
  
  Mostly sensible. One surprise: a failing retry chain (exhausted MAX_RETRIES=3 on a 429) does NOT trigger fallback, because 429 isn't a model-gone error. The character stays hammering the rate-limited primary and never tries the fallback. **P3** — arguable design choice.
- **`withBudget` proxy is lightweight** — no per-method array / indexed access, just a Set check. Proxy-overhead is negligible for LLM-call latency.

## Verdict

**Lift to findings.md:**
- **P2**: Empty-string API key from a configured `apiKeyEnv` doesn't trigger fallback to the default env var — provider initializes with `apiKey: ''` and fails on every call with a cryptic 401. Common deployment misconfig (env var referenced but not populated). Treat `''` as missing and fall back to the default env var or fail fast at construction.
- **P2**: Fallback chain is locked to the primary's provider type. `fallbackModels: [...]` all run through the SAME provider factory (same `config.type`). Cross-provider fallback (Anthropic → OpenAI → Google) is not supported; the structure silently forces every fallback through an SDK that doesn't know the model, causing a cascade of model-gone errors and eventual chain exhaustion. Either document the intra-provider-only limit or plumb per-model provider type through `ProviderConfig`.
