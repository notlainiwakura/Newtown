# `src/providers/retry.ts`

Shared retry helper used by OpenAI + Google providers (Anthropic has its own inline version — inconsistency). 58 lines, 2 exports.

## Functions

### `isRetryableError(error, statusCodes)`, line 22

Checks if an error has retryable status code or matches one of several patterns.

**Gaps / bugs:**
- **String-match fallback on message.** `statusCodes.some((code) => msg.includes(String(code)))` — matches `'404'` in `'error code 404'` but also matches `'404'` in `'request_id: abc404xyz'`. False positives possible. **P3.**
- **Regex `/overloaded|rate.?limit|too many requests|server error|bad gateway|service unavailable/i`** — catches English-language error text, misses non-English (some self-hosted proxies may localize). **P3.**
- **Does NOT inspect `error.headers['retry-after']`.** If present, that's authoritative — should use it instead of fixed backoff. **P2** — bundled with the fixed-backoff finding below.
- **Does NOT distinguish between retryable and non-retryable 4xx.** 429 is retryable but 400 (bad request), 401 (unauthorized), 404 (model not found) are NOT. The regex catches "rate limit" but not "unauthorized", so most 4xx won't match the string fallback. OK by accident — but the design is fragile. **P3.**
- **Treats `AbortError` implicitly.** No special-case. If an abort was fired by the caller, this would return `isRetryableError = false` (no matching status, no matching message pattern). Good — deliberate aborts aren't retried here. **Contrast with Anthropic's local withRetry which DOES catch AbortError as a timeout.** Cross-provider inconsistency.

### `withRetry(fn, providerName, config)`, line 34

Exponential backoff: base × 2^attempt → 1s, 2s, 4s → throw.

**Gaps / bugs:**
- **No jitter.** Fixed backoff means concurrent callers that failed at the same instant all retry at the same instant. Thundering herd on a rate-limited endpoint. **P2 — lift**: retry backoff has no jitter; concurrent callers all retry synchronously.
- **No `Retry-After` honored.** If the provider's 429 response includes `Retry-After: 30`, the code waits 1s / 2s / 4s regardless. In a real rate-limit scenario, this triple-taps the API and burns all retries in 7 seconds. **P2 — lift**: `Retry-After` header ignored; rapid retry during rate limit.
- **No AbortSignal.** `await new Promise((resolve) => setTimeout(resolve, delay))` — no cancel path. Ties to the base.ts abort P2.
- **`maxRetries = 3` means 4 total attempts (attempts 0-3).** Off-by-one on the mental model — the name suggests 3 retries but matches 3 retries + 1 initial = 4 attempts. OK mathematically, confusing naming. **P3.**
- **Default `retryableStatusCodes: [429, 500, 502, 503]`** — missing 504 (Gateway Timeout), 520-524 (Cloudflare), 529 (Anthropic Overloaded), 408 (Request Timeout). Cloud-hosted LLM proxies commonly return 504 during long inference. **P2 — lift**: default retryable status codes miss 504 and Anthropic's 529.
- **`throw new Error('unreachable')`** — dead code to satisfy TS return-type inference. Fine.
- **Inconsistent with Anthropic provider's inline `withRetry`** (anthropic.ts:47). Anthropic's version:
  - Uses its own `isOverloadedError` / `isTimeoutError` instead of `isRetryableError`.
  - Does NOT use status codes (pure string matching).
  - Has `MAX_RETRIES = 3` and `BASE_DELAY_MS = 1000` as class statics.
  - Treats AbortError as retryable timeout (lifted P2).
  - No jitter, no Retry-After.
  
  So Anthropic provider has bugs that this shared helper would have FIXED if anthropic just used it. **P2 — lift**: Anthropic provider doesn't use shared `withRetry`; parallel retry implementations with different semantics.

---

## File-level notes

- **Cross-provider inconsistency is the big structural finding.** Two retry implementations, two sets of classifier rules, two sets of backoff schedules. A fix to one (e.g. adding Retry-After support) doesn't automatically apply to the other.
- **No instrumentation hook.** `logger.warn` is the only signal. No counter / histogram for retry attempts per provider, no emit to event bus. Ops can't answer "is the Anthropic endpoint thrashing?" without grep-ing logs.
- **Per-provider config isn't exposed.** `config: Partial<RetryConfig>` exists in the signature but no provider actually passes one. Hardcoded defaults everywhere.
- **The `AbortError` inconsistency** between Anthropic's local withRetry (treats abort as timeout, retries it) and this shared withRetry (doesn't recognize, passes through) means: abort behavior depends on which provider you're using. User cancels a character response on Anthropic → model keeps retrying for 7s. User cancels on OpenAI/Google → aborts immediately.

## Verdict

**Lift to findings.md:**
- **P2**: `withRetry` has no jitter. Thundering-herd on retry when many callers failed simultaneously (e.g. provider-wide rate-limit / outage).
- **P2**: `Retry-After` header is not honored. A provider returning `429 Retry-After: 30` gets hammered again 1s, 2s, 4s after — burning retries while rate-limited.
- **P2**: Default retryable status codes `[429, 500, 502, 503]` miss 504 (Gateway Timeout, common for cloud-hosted LLM proxies) and 529 (Anthropic Overloaded). 408 also commonly appropriate.
- **P2**: Anthropic provider has its own inline `withRetry` (anthropic.ts:47) that doesn't use this shared helper. Two retry code paths with different classifiers, different backoff, different AbortError behavior. Any improvement to one bypasses the other. Unify.
