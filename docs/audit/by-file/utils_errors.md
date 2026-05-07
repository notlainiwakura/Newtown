# `src/utils/errors.ts`

Custom error hierarchy. 8 classes, each with a constructor. All extend `LainError` → `Error`.

## Classes

- `LainError(message, code, cause?)` — base. Captures stack. Has `name = 'LainError'` and `code: string`.
- `ConfigError` → `CONFIG_ERROR`
- `ValidationError(message, errors: string[], cause?)` → `VALIDATION_ERROR` — carries an array of per-field messages.
- `StorageError` → `STORAGE_ERROR`
- `KeychainError` → `KEYCHAIN_ERROR`
- `GatewayError(message, errorCode: number, cause?)` → `GATEWAY_ERROR` — additionally carries a numeric code (probably JSON-RPC-ish).
- `AuthenticationError` → `AUTH_ERROR`
- `RateLimitError(message, retryAfter: number, cause?)` → `RATE_LIMIT_ERROR`
- `AgentError` → `AGENT_ERROR`

## Gaps / bugs

- **Duplicate code semantics** — `LainError.code` is a string. `GatewayError` *additionally* has `errorCode: number`. Subclasses that actually need a different machine-readable code (GatewayError wanting `-32601` style JSON-RPC codes) have two fields that mean nearly the same thing. Consumers must know which to read. **P3**.
- **`cause` is typed as `Error`** but Node 16+ supports `cause` natively via the `Error(..., { cause })` constructor. Preserving it as a public property is fine, but not forwarding it to the native `super(message, { cause })` means stack dumps don't auto-chain. Error → "caused by" output will have to be assembled manually everywhere. **P3**.
- `RateLimitError.retryAfter` has no unit comment — seconds? milliseconds? Disagreement between call sites would silently backoff for the wrong duration. **P2** — defer until `providers/retry.ts` / `gateway/rate-limiter.ts` audit to see which unit is actually used and whether the ambiguity bites.
- `ValidationError.errors` is `string[]`. No per-field path, no programmatic access. Reasonable for a CLI error surface; limited for API responses. **P3**.
- No `TimeoutError` here — instead lives in `utils/timeout.ts` with no `LainError` parent. Diverges from the pattern; callers can't `instanceof LainError` to catch timeout errors. **P3**, flagged more fully in `utils_timeout.md`.
- No `ToolExecutionError`, `ProviderError`, `MemoryError`. Errors from those subsystems get bucketed into `AgentError` or bare `Error`, losing semantic information for handlers. **P3**.

---

## File-level notes

- All constructors call `super(message, 'CODE', cause)`. Consistent. Clean.
- `Error.captureStackTrace(this, this.constructor)` only in the base. Subclass stacks are correct by virtue of inheriting — fine.

## Verdict

**Lift to findings.md (tentative — to confirm during later audits):**
- P2: `RateLimitError.retryAfter` units are undocumented. Verify unit convergence when auditing providers/retry and gateway/rate-limiter.

P3 notes kept in file.
