/**
 * Shared retry logic for LLM providers
 */

import { getLogger } from '../utils/logger.js';

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  retryableStatusCodes: number[];
  /**
   * findings.md P2:1080 — caller-supplied retryability check. When set
   * it fully REPLACES the default status/message classifier so providers
   * with stricter semantics (Anthropic only retries on overloaded/
   * rate-limit/timeout) aren't accidentally opted into the generic
   * "server error" message regex the default uses for OpenAI/Google.
   * Leave unset to get the default classifier.
   */
  isRetryable?: (error: unknown) => boolean;
  /**
   * findings.md P2:788 — caller-driven cancellation. When the signal
   * aborts mid-retry the backoff sleep wakes immediately and no
   * further attempts are made — the last error re-throws. Without
   * this a Ctrl-C during a multi-second jittered backoff kept the
   * caller blocked until the sleep expired, even though the HTTP
   * request itself had already been cancelled by the SDK.
   */
  abortSignal?: AbortSignal;
}

// findings.md P2:1070 — default status codes were missing transient upstream
// errors we observe in the wild:
//   408 Request Timeout (client-perceived timeout, worth retrying)
//   504 Gateway Timeout (upstream slow, usually transient)
//   520-524 Cloudflare origin errors (see Anthropic + Cloudflare notes)
//   529 Anthropic "overloaded" (documented retryable error)
const DEFAULT_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  retryableStatusCodes: [408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529],
};

/**
 * Check if an error has a retryable HTTP status code.
 */
function isRetryableError(error: unknown, statusCodes: number[]): boolean {
  if (!error || typeof error !== 'object') return false;
  const status = (error as { status?: number }).status;
  if (typeof status === 'number' && statusCodes.includes(status)) return true;
  const msg = String((error as { message?: string }).message ?? '');
  return statusCodes.some((code) => msg.includes(String(code))) ||
    /overloaded|rate.?limit|too many requests|server error|bad gateway|service unavailable/i.test(msg);
}

/**
 * findings.md P2:1060 — parse the Retry-After header the provider sent.
 * RFC 7231 allows two shapes: delta-seconds (`"30"`) or an HTTP-date
 * (`"Wed, 21 Oct 2015 07:28:00 GMT"`). Accept both. Return ms, or null
 * when the header is absent / unparseable / in the past.
 */
function parseRetryAfter(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const headers = (error as { headers?: Record<string, string | string[] | undefined> }).headers;
  if (!headers) return null;
  const raw = headers['retry-after'] ?? headers['Retry-After'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const timestamp = Date.parse(value);
  if (!Number.isNaN(timestamp)) {
    const delta = timestamp - Date.now();
    return delta > 0 ? delta : 0;
  }
  return null;
}

/**
 * Retry a function with exponential backoff on transient errors.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  providerName: string,
  config: Partial<RetryConfig> = {}
): Promise<T> {
  const logger = getLogger();
  const merged = { ...DEFAULT_CONFIG, ...config };
  const { maxRetries, baseDelayMs, retryableStatusCodes, isRetryable, abortSignal } = merged;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      // findings.md P2:788 — if the caller cancelled, bail out
      // immediately instead of classifying + sleeping. The SDK has
      // already surfaced an AbortError; retrying would send another
      // request after the user asked us to stop.
      if (abortSignal?.aborted) {
        throw error;
      }
      const retryable = isRetryable
        ? isRetryable(error)
        : isRetryableError(error, retryableStatusCodes);
      if (!retryable || attempt === maxRetries) {
        throw error;
      }
      // findings.md P2:1050 — fixed exponential backoff synchronized
      // concurrent callers who both failed at the same instant, amplifying
      // the load spike that caused the failure. Apply full jitter: pick a
      // delay uniformly in [0, baseDelay * 2^attempt] so 20 colocated
      // characters hitting a rate limit stagger across the window instead
      // of retrying in lockstep.
      const cap = baseDelayMs * Math.pow(2, attempt);
      const jittered = Math.floor(Math.random() * cap);
      // findings.md P2:1060 — if the provider sent Retry-After we'd better
      // wait at least that long; hitting again inside the rate-limit window
      // just wastes retries. Use max(retryAfter, jitteredBackoff) so jitter
      // still stands in the common case and server intent wins when it's
      // longer.
      const retryAfterMs = parseRetryAfter(error);
      const delay = retryAfterMs !== null ? Math.max(retryAfterMs, jittered) : jittered;
      logger.warn(
        { provider: providerName, attempt: attempt + 1, delayMs: delay, capMs: cap, retryAfterMs },
        'Retryable error, backing off'
      );
      // findings.md P2:788 — abortable sleep. If the signal fires
      // during backoff we wake up, clear the timer so it doesn't leak
      // into the next tick, remove our listener, and re-throw the
      // original error on the next loop iteration (which sees
      // abortSignal.aborted and bails before the next attempt).
      await abortableSleep(delay, abortSignal);
    }
  }
  throw new Error('unreachable');
}

function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
