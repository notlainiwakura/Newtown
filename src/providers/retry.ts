/**
 * Shared retry logic for LLM providers
 */

import { getLogger } from '../utils/logger.js';

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  retryableStatusCodes: number[];
}

const DEFAULT_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  retryableStatusCodes: [429, 500, 502, 503],
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
 * Retry a function with exponential backoff on transient errors.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  providerName: string,
  config: Partial<RetryConfig> = {}
): Promise<T> {
  const logger = getLogger();
  const { maxRetries, baseDelayMs, retryableStatusCodes } = { ...DEFAULT_CONFIG, ...config };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      if (!isRetryableError(error, retryableStatusCodes) || attempt === maxRetries) {
        throw error;
      }
      const delay = baseDelayMs * Math.pow(2, attempt);
      logger.warn(
        { provider: providerName, attempt: attempt + 1, delayMs: delay },
        'Retryable error, backing off'
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error('unreachable');
}
