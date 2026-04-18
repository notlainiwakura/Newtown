/**
 * Rate limiting for gateway connections
 */

import type { RateLimitConfig } from '../types/config.js';
import type { ConnectionRateLimit } from '../types/gateway.js';

interface RateLimitState {
  connections: Map<string, ConnectionState>;
  globalConnectionCount: number;
  globalWindowStart: number;
}

interface ConnectionState {
  requestCount: number;
  windowStart: number;
  blocked: boolean;
  blockedUntil: number;
}

const state: RateLimitState = {
  connections: new Map(),
  globalConnectionCount: 0,
  globalWindowStart: Date.now(),
};

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
 * Check if a new connection is allowed
 */
export function canConnect(): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const windowDuration = 60 * 1000; // 1 minute

  // Reset window if needed
  if (now - state.globalWindowStart > windowDuration) {
    state.globalConnectionCount = 0;
    state.globalWindowStart = now;
  }

  if (state.globalConnectionCount >= config.connectionsPerMinute) {
    const retryAfter = Math.ceil((state.globalWindowStart + windowDuration - now) / 1000);
    return { allowed: false, retryAfter };
  }

  state.globalConnectionCount++;
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
  state.globalConnectionCount = 0;
  state.globalWindowStart = Date.now();
}

/**
 * Get current connection count
 */
export function getConnectionCount(): number {
  return state.connections.size;
}
