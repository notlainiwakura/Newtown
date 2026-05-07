/**
 * Timeout wrapper for async operations
 */

export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Wrap a promise with a timeout. Rejects with TimeoutError if the promise
 * doesn't resolve within `ms` milliseconds.
 *
 * findings.md P2:145 — this form RACES a timer against the promise but does
 * NOT cancel the wrapped work on timer fire. The inner promise keeps
 * running and consumes CPU / sockets / budget for the full original
 * duration. Only use this for truly abandonment-safe operations
 * (e.g. DNS lookups, local in-memory work). For any operation that
 * supports AbortSignal-based cancellation — LLM HTTP calls, retryable
 * I/O — prefer `withAbortableTimeout(fn, ms, label)` below so timer
 * fire also aborts the request.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(label, ms));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * findings.md P2:145 — abortable timeout. Creates an AbortController,
 * hands the signal to the caller-supplied builder, and aborts on timer
 * fire so the wrapped operation can actually cancel rather than
 * continuing to consume resources after the outer Promise has rejected.
 *
 * Wire the signal into operations that honour AbortSignal:
 *   withAbortableTimeout(
 *     (signal) => provider.complete({ ..., abortSignal: signal }),
 *     60_000,
 *     'Memory extraction',
 *   );
 *
 * If the builder throws synchronously, the timer is cleaned up and the
 * error propagates unchanged.
 */
export function withAbortableTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError(label, ms));
    }, ms);

    let inner: Promise<T>;
    try {
      inner = fn(controller.signal);
    } catch (error) {
      clearTimeout(timer);
      reject(error);
      return;
    }

    inner.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
