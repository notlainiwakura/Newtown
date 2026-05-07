# `src/utils/timeout.ts`

Promise-with-timeout wrapper. 1 function + 1 class.

## `TimeoutError` class, line 5

Extends `Error` (NOT `LainError`). Carries the label + ms into the message.

**Gaps / bugs:**
- Does not extend `LainError` — callers can't catch with a single `instanceof LainError` check. Either fold into `src/utils/errors.ts` or extend the hierarchy. **P3**.
- No `code`, no `cause`. If the wrapped promise could signal why it's slow, there's no way to attach that data. Minor.

## `withTimeout(promise, ms, label)`, line 16

**Purpose:** race the input promise against a timeout. If timeout fires, reject with `TimeoutError`.

**Gaps / bugs:**
- **Does NOT abort the underlying operation.** It only rejects the wrapper. The caller's `promise` continues to consume resources (open HTTP, spawned subprocess). For LLM calls, an abandoned fetch with a keep-alive socket can quietly run for its full server-side duration before getting GC'd. Expected for "dumb" timeouts but worth explicit doc. Consumers should pair with an `AbortController`. **P2** — the callers who rely on this need audit; if they don't propagate abort, we're accumulating zombie work under load.
- `ms` is not validated. Negative or 0 → timer fires immediately. Probably fine, just a semantic oddity. **P3**.
- No way to "reset" the timeout (for idle-timeout patterns on streams). Use case for `AbortController.timeout` family. Nice-to-have. **P3**.

---

## File-level notes

- Used in `memory/extraction.ts` (confirmed via grep). Not re-exported from `src/utils/index.ts` — the barrel re-exports `errors`, `logger`, `crypto` only. Callers must `import from '../utils/timeout.js'` directly. Minor inconsistency. **P3**.
- `providers/anthropic.ts` mentions `TimeoutError` in a grep hit but likely defines its own local class (matches the `providers/retry.ts` convention of per-provider shims). Defer confirmation.

## Verdict

**Lift to findings.md:**
- P2: `withTimeout` does not abort the wrapped operation. Callers of `withTimeout` must pair it with an `AbortController`; audit all call sites to confirm. If not, we're leaking work on every timeout.

P3 notes kept in file.
