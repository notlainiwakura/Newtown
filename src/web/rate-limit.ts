/**
 * Shared per-IP rate limiter.
 *
 * findings.md P2:2494 — character-server and doctor-server used to run
 * with no rate limiting at all. Any interlink-token holder or (for
 * public endpoints) any direct client could hammer those processes as
 * hard as they wanted — chat bodies, meta probes, you name it. Main
 * server's chat rate limiter lived inline in server.ts. Extract into
 * a shared module so all three HTTP servers key off the same
 * `createRateLimiter()` and share identical semantics (trusted-proxy
 * XFF handling, same window/cap defaults, same 429 shape).
 *
 * Each caller gets its own bucket (its own Map) so that a burst of
 * /api/chat on the main server does not evict a legitimate caller on
 * the doctor server. This also makes test isolation simpler.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { getClientIp } from './client-ip.js';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export interface RateLimiterOptions {
  /** Window size in milliseconds. Default: 60 000 (1 minute). */
  windowMs?: number;
  /** Max requests per window per key. Default: 30. */
  max?: number;
  /** Janitor sweep interval in milliseconds. Default: 5 * 60 000. */
  sweepMs?: number;
}

export interface RateLimiter {
  /** Returns true if the request is within the cap; false if it should be 429'd. */
  check(ip: string): boolean;
  /**
   * Convenience wrapper — derives the client IP via `getClientIp`, runs
   * the cap check, and writes a 429 response if exceeded. Returns true
   * if the handler may continue, false if the 429 was already sent.
   */
  guard(req: IncomingMessage, res: ServerResponse): boolean;
}

export function createRateLimiter(opts: RateLimiterOptions = {}): RateLimiter {
  const windowMs = opts.windowMs ?? 60_000;
  const max = opts.max ?? 30;
  const sweepMs = opts.sweepMs ?? 5 * 60_000;
  const map = new Map<string, RateLimitEntry>();

  const janitor = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of map) {
      if (now > entry.resetAt) map.delete(ip);
    }
  }, sweepMs);
  // Don't keep the process alive for the janitor — matches the pattern
  // used elsewhere so CLI commands and tests can exit cleanly.
  if (typeof janitor.unref === 'function') janitor.unref();

  function check(ip: string): boolean {
    const now = Date.now();
    const entry = map.get(ip);
    if (!entry || now > entry.resetAt) {
      map.set(ip, { count: 1, resetAt: now + windowMs });
      return true;
    }
    entry.count++;
    return entry.count <= max;
  }

  function guard(req: IncomingMessage, res: ServerResponse): boolean {
    const ip = getClientIp(req);
    if (check(ip)) return true;
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Too many requests' }));
    return false;
  }

  return { check, guard };
}
