/**
 * Rate limiting for gateway connections
 */

import type { RateLimitConfig } from '../types/config.js';
import type { ConnectionRateLimit } from '../types/gateway.js';

interface RateLimitState {
  connections: Map<string, ConnectionState>;
  // findings.md P2:2616 — `canConnect()` used to share a single global
  // counter with the authenticated-connection limit, so unauth'd
  // connect storms ate the budget and locked out legit users. Split
  // into a cheap pre-auth quota (big enough that single-attacker DoS
  // is hard but not impossible) and a separate authenticated quota
  // bumped from the configured `connectionsPerMinute`.
  preAuthConnectionCount: number;
  preAuthWindowStart: number;
  authConnectionCount: number;
  authWindowStart: number;
}

interface ConnectionState {
  requestCount: number;
  windowStart: number;
  blocked: boolean;
  blockedUntil: number;
}

const state: RateLimitState = {
  connections: new Map(),
  preAuthConnectionCount: 0,
  preAuthWindowStart: Date.now(),
  authConnectionCount: 0,
  authWindowStart: Date.now(),
};

// Pre-auth budget is 10x the authenticated rate, floored at 1000/min —
// cheap enough that a single client can't starve it accidentally but
// still a backstop against runaway connect loops on a shared host.
const PRE_AUTH_BUDGET_MULTIPLIER = 10;
const PRE_AUTH_MIN_PER_MINUTE = 1000;

let config: RateLimitConfig = {
  connectionsPerMinute: 60,
  requestsPerSecond: 10,
  burstSize: 20,
};

/**
 * Configure rate limiting
 */
export function configureRateLimiter(rateLimitConfig: RateLimitConfig): void {
  config = rateLimitConfig;
}

/**
 * Pre-auth connection throttle — cheap per-minute cap that prevents
 * unauth'd connect storms from starving the authenticated connection
 * budget. See findings.md P2:2616.
 */
export function canConnect(): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const windowDuration = 60 * 1000; // 1 minute

  if (now - state.preAuthWindowStart > windowDuration) {
    state.preAuthConnectionCount = 0;
    state.preAuthWindowStart = now;
  }

  const preAuthLimit = Math.max(
    PRE_AUTH_MIN_PER_MINUTE,
    config.connectionsPerMinute * PRE_AUTH_BUDGET_MULTIPLIER,
  );

  if (state.preAuthConnectionCount >= preAuthLimit) {
    const retryAfter = Math.ceil((state.preAuthWindowStart + windowDuration - now) / 1000);
    return { allowed: false, retryAfter };
  }

  state.preAuthConnectionCount++;
  return { allowed: true };
}

/**
 * Authenticated-connection throttle — enforced on successful auth.
 * Uses the configured `connectionsPerMinute`. Separate from the pre-auth
 * counter so unauth'd noise can't lock out legitimate operators.
 * See findings.md P2:2616.
 */
export function canAuthenticate(): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const windowDuration = 60 * 1000;

  if (now - state.authWindowStart > windowDuration) {
    state.authConnectionCount = 0;
    state.authWindowStart = now;
  }

  if (state.authConnectionCount >= config.connectionsPerMinute) {
    const retryAfter = Math.ceil((state.authWindowStart + windowDuration - now) / 1000);
    return { allowed: false, retryAfter };
  }

  state.authConnectionCount++;
  return { allowed: true };
}

/**
 * Register a new connection for rate limiting
 */
export function registerConnection(connectionId: string): void {
  state.connections.set(connectionId, {
    requestCount: 0,
    windowStart: Date.now(),
    blocked: false,
    blockedUntil: 0,
  });
}

/**
 * Remove a connection from rate limiting tracking
 */
export function unregisterConnection(connectionId: string): void {
  state.connections.delete(connectionId);
}

/**
 * Check if a request is allowed for a connection
 */
export function canRequest(connectionId: string): {
  allowed: boolean;
  retryAfter?: number;
} {
  const connState = state.connections.get(connectionId);
  if (!connState) {
    return { allowed: false, retryAfter: 1 };
  }

  const now = Date.now();

  // Check if blocked
  if (connState.blocked) {
    if (now < connState.blockedUntil) {
      const retryAfter = Math.ceil((connState.blockedUntil - now) / 1000);
      return { allowed: false, retryAfter };
    }
    // Unblock
    connState.blocked = false;
    connState.requestCount = 0;
    connState.windowStart = now;
  }

  const windowDuration = 1000; // 1 second

  // Reset window if needed
  if (now - connState.windowStart > windowDuration) {
    connState.requestCount = 0;
    connState.windowStart = now;
  }

  // Check burst limit
  if (connState.requestCount >= config.burstSize) {
    // Block for 10 seconds
    connState.blocked = true;
    connState.blockedUntil = now + 10000;
    return { allowed: false, retryAfter: 10 };
  }

  // Check rate limit
  if (connState.requestCount >= config.requestsPerSecond) {
    const retryAfter = Math.ceil((connState.windowStart + windowDuration - now) / 1000);
    return { allowed: false, retryAfter: retryAfter > 0 ? retryAfter : 1 };
  }

  connState.requestCount++;
  return { allowed: true };
}

/**
 * Get rate limit status for a connection
 */
export function getRateLimitStatus(connectionId: string): ConnectionRateLimit | null {
  const connState = state.connections.get(connectionId);
  if (!connState) {
    return null;
  }

  const result: ConnectionRateLimit = {
    requestCount: connState.requestCount,
    windowStart: connState.windowStart,
    blocked: connState.blocked,
  };
  if (connState.blocked) {
    result.blockedUntil = connState.blockedUntil;
  }
  return result;
}

/**
 * Reset all rate limiting state (for testing)
 */
export function resetRateLimiter(): void {
  state.connections.clear();
  state.preAuthConnectionCount = 0;
  state.preAuthWindowStart = Date.now();
  state.authConnectionCount = 0;
  state.authWindowStart = Date.now();
}

/**
 * Get current connection count
 */
export function getConnectionCount(): number {
  return state.connections.size;
}
