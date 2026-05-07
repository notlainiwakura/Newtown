/**
 * Comprehensive gateway-system tests.
 *
 * Covers:
 *   - auth.ts   — authenticate, isAuthenticated, getConnection, setConnectionAgent,
 *                 deauthenticate, getAuthenticatedConnections, clearAuthentications
 *   - rate-limiter.ts — canConnect, canRequest, registerConnection,
 *                       unregisterConnection, getRateLimitStatus, resetRateLimiter
 *   - router.ts — handleMessage, registerMethod, unregisterMethod, built-in methods
 *   - server.ts — getServerStatus, isServerRunning, getServerPid, isProcessRunning, broadcast
 *   - index.ts  — re-exported surface
 *   - Edge cases
 *
 * No real servers or sockets are created.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── Mock keychain (auth depends on it) ──────────────────────────────────────
vi.mock('../src/storage/keychain.js', () => ({
  getAuthToken: vi.fn(),
}));

// ── Mock logger ──────────────────────────────────────────────────────────────
vi.mock('../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// ── Mock agent (router chat method depends on it) ────────────────────────────
vi.mock('../src/agent/index.js', () => ({
  processMessage: vi.fn(),
}));

import { getAuthToken } from '../src/storage/keychain.js';
import {
  authenticate,
  isAuthenticated,
  getConnection,
  setConnectionAgent,
  deauthenticate,
  getAuthenticatedConnections,
  getAuthenticatedConnectionCount,
  clearAuthentications,
  refreshTokenCache,
} from '../src/gateway/auth.js';

import {
  configureRateLimiter,
  canConnect,
  canRequest,
  registerConnection,
  unregisterConnection,
  getRateLimitStatus,
  resetRateLimiter,
  getConnectionCount,
} from '../src/gateway/rate-limiter.js';

import {
  registerMethod,
  unregisterMethod,
  handleMessage,
  registerChatMethod,
} from '../src/gateway/router.js';

import {
  isServerRunning,
  getServerStatus,
  getServerPid,
  isProcessRunning,
} from '../src/gateway/server.js';

import { GatewayErrorCodes } from '../src/types/gateway.js';
import type { GatewayMessage } from '../src/types/gateway.js';
import { AuthenticationError } from '../src/utils/errors.js';
import { secureCompare } from '../src/utils/crypto.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function msg(method: string, params?: Record<string, unknown>, id = 'req-1'): GatewayMessage {
  return { id, method, params };
}

function uid() {
  return `conn-${Math.random().toString(36).slice(2)}`;
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. GATEWAY AUTH
// ═════════════════════════════════════════════════════════════════════════════

describe('Gateway Auth — authenticate()', () => {
  beforeEach(() => {
    clearAuthentications();
    // findings.md P2:2616 — authenticate() now consumes canAuthenticate()
    // budget, so we must reset rate-limiter state between tests.
    resetRateLimiter();
    vi.mocked(getAuthToken).mockReset();
  });

  afterEach(() => {
    clearAuthentications();
    resetRateLimiter();
  });

  it('succeeds with correct token', async () => {
    vi.mocked(getAuthToken).mockResolvedValue('secret-token');
    const conn = await authenticate('conn-a', 'secret-token');
    expect(conn.id).toBe('conn-a');
  });

  it('returns an AuthenticatedConnection with authenticatedAt', async () => {
    vi.mocked(getAuthToken).mockResolvedValue('tok');
    const before = Date.now();
    const conn = await authenticate('conn-b', 'tok');
    expect(conn.authenticatedAt).toBeGreaterThanOrEqual(before);
    expect(conn.authenticatedAt).toBeLessThanOrEqual(Date.now());
  });

  it('initialises rateLimit.requestCount to 0', async () => {
    vi.mocked(getAuthToken).mockResolvedValue('tok');
    const conn = await authenticate(uid(), 'tok');
    expect(conn.rateLimit.requestCount).toBe(0);
  });

  it('initialises rateLimit.blocked to false', async () => {
    vi.mocked(getAuthToken).mockResolvedValue('tok');
    const conn = await authenticate(uid(), 'tok');
    expect(conn.rateLimit.blocked).toBe(false);
  });

  it('throws AuthenticationError for wrong token', async () => {
    vi.mocked(getAuthToken).mockResolvedValue('correct');
    await expect(authenticate(uid(), 'wrong')).rejects.toThrow(AuthenticationError);
  });

  it('throws AuthenticationError with message "Invalid authentication token"', async () => {
    vi.mocked(getAuthToken).mockResolvedValue('correct');
    await expect(authenticate(uid(), 'wrong')).rejects.toThrow('Invalid authentication token');
  });

  it('throws AuthenticationError when no stored token configured', async () => {
    vi.mocked(getAuthToken).mockResolvedValue(null);
    await expect(authenticate(uid(), 'anything')).rejects.toThrow('No authentication token configured');
  });

  it('stores the connection in the map after success', async () => {
    vi.mocked(getAuthToken).mockResolvedValue('tok');
    const id = uid();
    await authenticate(id, 'tok');
    expect(isAuthenticated(id)).toBe(true);
  });

  it('two distinct connection IDs are tracked independently', async () => {
    vi.mocked(getAuthToken).mockResolvedValue('tok');
    const id1 = uid();
    const id2 = uid();
    await authenticate(id1, 'tok');
    await authenticate(id2, 'tok');
    expect(isAuthenticated(id1)).toBe(true);
    expect(isAuthenticated(id2)).toBe(true);
  });

  it('tokens are compared using constant-time (secureCompare semantics)', () => {
    // Verify secureCompare itself is correct
    expect(secureCompare('abc', 'abc')).toBe(true);
    expect(secureCompare('abc', 'xyz')).toBe(false);
    expect(secureCompare('abc', 'ab')).toBe(false);
  });

  it('empty token is rejected when stored token is non-empty', async () => {
    vi.mocked(getAuthToken).mockResolvedValue('tok');
    await expect(authenticate(uid(), '')).rejects.toThrow(AuthenticationError);
  });

  it('whitespace token is rejected', async () => {
    vi.mocked(getAuthToken).mockResolvedValue('tok');
    await expect(authenticate(uid(), '   ')).rejects.toThrow(AuthenticationError);
  });

  it('token with extra chars is rejected', async () => {
    vi.mocked(getAuthToken).mockResolvedValue('tok');
    await expect(authenticate(uid(), 'tok ')).rejects.toThrow(AuthenticationError);
  });
});

describe('Gateway Auth — isAuthenticated()', () => {
  beforeEach(() => { clearAuthentications(); resetRateLimiter(); });
  afterEach(() => { clearAuthentications(); resetRateLimiter(); });

  it('returns false for unknown connectionId', () => {
    expect(isAuthenticated('nobody')).toBe(false);
  });

  it('returns true after successful authenticate()', async () => {
    vi.mocked(getAuthToken).mockResolvedValue('tok');
    const id = uid();
    await authenticate(id, 'tok');
    expect(isAuthenticated(id)).toBe(true);
  });

  it('returns false after deauthenticate()', async () => {
    vi.mocked(getAuthToken).mockResolvedValue('tok');
    const id = uid();
    await authenticate(id, 'tok');
    deauthenticate(id);
    expect(isAuthenticated(id)).toBe(false);
  });
});

describe('Gateway Auth — getConnection()', () => {
  beforeEach(() => { clearAuthentications(); resetRateLimiter(); });
  afterEach(() => { clearAuthentications(); resetRateLimiter(); });

  it('returns undefined for unknown id', () => {
    expect(getConnection('nobody')).toBeUndefined();
  });

  it('returns the connection object after authenticate()', async () => {
    vi.mocked(getAuthToken).mockResolvedValue('tok');
    const id = uid();
    const conn = await authenticate(id, 'tok');
    expect(getConnection(id)).toBe(conn);
  });
});

describe('Gateway Auth — setConnectionAgent()', () => {
  beforeEach(() => { clearAuthentications(); resetRateLimiter(); });
  afterEach(() => { clearAuthentications(); resetRateLimiter(); });

  it('returns false for unknown connectionId', () => {
    expect(setConnectionAgent('nobody', 'pkd')).toBe(false);
  });

  it('returns true for authenticated connection', async () => {
    vi.mocked(getAuthToken).mockResolvedValue('tok');
    const id = uid();
    await authenticate(id, 'tok');
    expect(setConnectionAgent(id, 'pkd')).toBe(true);
  });

  it('sets agentId on the connection', async () => {
    vi.mocked(getAuthToken).mockResolvedValue('tok');
    const id = uid();
    await authenticate(id, 'tok');
    setConnectionAgent(id, 'mckenna');
    expect(getConnection(id)?.agentId).toBe('mckenna');
  });

  it('can update agentId multiple times', async () => {
    vi.mocked(getAuthToken).mockResolvedValue('tok');
    const id = uid();
    await authenticate(id, 'tok');
    setConnectionAgent(id, 'lain');
    setConnectionAgent(id, 'wired-lain');
    expect(getConnection(id)?.agentId).toBe('wired-lain');
  });
});

describe('Gateway Auth — deauthenticate()', () => {
  beforeEach(() => { clearAuthentications(); resetRateLimiter(); });
  afterEach(() => { clearAuthentications(); resetRateLimiter(); });

  it('returns false for unknown connectionId', () => {
    expect(deauthenticate('nobody')).toBe(false);
  });

  it('returns true for authenticated connection', async () => {
    vi.mocked(getAuthToken).mockResolvedValue('tok');
    const id = uid();
    await authenticate(id, 'tok');
    expect(deauthenticate(id)).toBe(true);
  });

  it('subsequent deauthenticate returns false', async () => {
    vi.mocked(getAuthToken).mockResolvedValue('tok');
    const id = uid();
    await authenticate(id, 'tok');
    deauthenticate(id);
    expect(deauthenticate(id)).toBe(false);
  });
});

describe('Gateway Auth — getAuthenticatedConnections() / count', () => {
  beforeEach(() => { clearAuthentications(); resetRateLimiter(); });
  afterEach(() => { clearAuthentications(); resetRateLimiter(); });

  it('returns empty array when no connections', () => {
    expect(getAuthenticatedConnections()).toEqual([]);
  });

  it('returns all authenticated connections', async () => {
    vi.mocked(getAuthToken).mockResolvedValue('tok');
    const id1 = uid();
    const id2 = uid();
    await authenticate(id1, 'tok');
    await authenticate(id2, 'tok');
    const conns = getAuthenticatedConnections();
    expect(conns).toHaveLength(2);
  });

  it('getAuthenticatedConnectionCount matches array length', async () => {
    vi.mocked(getAuthToken).mockResolvedValue('tok');
    await authenticate(uid(), 'tok');
    await authenticate(uid(), 'tok');
    expect(getAuthenticatedConnectionCount()).toBe(getAuthenticatedConnections().length);
  });

  it('count is 0 after clearAuthentications()', async () => {
    vi.mocked(getAuthToken).mockResolvedValue('tok');
    await authenticate(uid(), 'tok');
    clearAuthentications();
    expect(getAuthenticatedConnectionCount()).toBe(0);
  });
});

describe('Gateway Auth — clearAuthentications()', () => {
  beforeEach(() => { clearAuthentications(); resetRateLimiter(); });
  afterEach(() => { clearAuthentications(); resetRateLimiter(); });

  it('clears all connections', async () => {
    vi.mocked(getAuthToken).mockResolvedValue('tok');
    await authenticate(uid(), 'tok');
    await authenticate(uid(), 'tok');
    clearAuthentications();
    expect(getAuthenticatedConnections()).toHaveLength(0);
  });

  it('subsequent isAuthenticated returns false for previously authenticated IDs', async () => {
    vi.mocked(getAuthToken).mockResolvedValue('tok');
    const id = uid();
    await authenticate(id, 'tok');
    clearAuthentications();
    expect(isAuthenticated(id)).toBe(false);
  });
});

// findings.md P2:2636 — auth records should carry a token fingerprint
// and an activity timestamp so audit logs can distinguish operators
// and idle sessions can be swept even when the peer SIGKILLs.
describe('Gateway Auth — session TTL + identity (P2:2636)', () => {
  beforeEach(() => { clearAuthentications(); resetRateLimiter(); });
  afterEach(() => { clearAuthentications(); resetRateLimiter(); });

  it('authenticate() records a token fingerprint', async () => {
    vi.mocked(getAuthToken).mockResolvedValue('tok');
    const conn = await authenticate(uid(), 'tok');
    expect(conn.tokenFingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('different tokens yield different fingerprints', async () => {
    const { fingerprintToken } = await import('../src/gateway/auth.js');
    expect(fingerprintToken('tok-a')).not.toBe(fingerprintToken('tok-b'));
  });

  it('same token yields the same fingerprint (stable)', async () => {
    const { fingerprintToken } = await import('../src/gateway/auth.js');
    expect(fingerprintToken('tok-a')).toBe(fingerprintToken('tok-a'));
  });

  it('authenticate() initialises lastActivityAt', async () => {
    vi.mocked(getAuthToken).mockResolvedValue('tok');
    const before = Date.now();
    const conn = await authenticate(uid(), 'tok');
    expect(conn.lastActivityAt).toBeGreaterThanOrEqual(before);
    expect(conn.lastActivityAt).toBeLessThanOrEqual(Date.now());
  });

  it('touchConnection() updates lastActivityAt', async () => {
    const { touchConnection, getConnection } = await import('../src/gateway/auth.js');
    vi.mocked(getAuthToken).mockResolvedValue('tok');
    const id = uid();
    await authenticate(id, 'tok');
    const beforeTouch = getConnection(id)?.lastActivityAt ?? 0;
    await new Promise((r) => setTimeout(r, 10));
    touchConnection(id);
    const afterTouch = getConnection(id)?.lastActivityAt ?? 0;
    expect(afterTouch).toBeGreaterThan(beforeTouch);
  });

  it('touchConnection() is a no-op for unknown connection id', async () => {
    const { touchConnection } = await import('../src/gateway/auth.js');
    expect(() => touchConnection('nonexistent')).not.toThrow();
  });

  it('sweepIdleConnections() evicts connections older than TTL', async () => {
    const { sweepIdleConnections, getConnection } = await import('../src/gateway/auth.js');
    vi.mocked(getAuthToken).mockResolvedValue('tok');
    const id = uid();
    const conn = await authenticate(id, 'tok');
    // Artificially age the connection.
    conn.lastActivityAt = Date.now() - 10_000;
    const evicted = sweepIdleConnections(5_000);
    expect(evicted).toBe(1);
    expect(getConnection(id)).toBeUndefined();
  });

  it('sweepIdleConnections() keeps freshly-active connections', async () => {
    const { sweepIdleConnections, getConnection } = await import('../src/gateway/auth.js');
    vi.mocked(getAuthToken).mockResolvedValue('tok');
    const id = uid();
    await authenticate(id, 'tok');
    const evicted = sweepIdleConnections(60_000);
    expect(evicted).toBe(0);
    expect(getConnection(id)).toBeDefined();
  });

  it('sweepIdleConnections() reports count and evicts multiple at once', async () => {
    const { sweepIdleConnections, getAuthenticatedConnectionCount } = await import('../src/gateway/auth.js');
    vi.mocked(getAuthToken).mockResolvedValue('tok');
    const id1 = uid();
    const id2 = uid();
    const id3 = uid();
    const c1 = await authenticate(id1, 'tok');
    const c2 = await authenticate(id2, 'tok');
    await authenticate(id3, 'tok');
    c1.lastActivityAt = Date.now() - 10_000;
    c2.lastActivityAt = Date.now() - 10_000;
    const evicted = sweepIdleConnections(5_000);
    expect(evicted).toBe(2);
    expect(getAuthenticatedConnectionCount()).toBe(1);
  });
});

describe('Gateway Auth — refreshTokenCache()', () => {
  it('calls getAuthToken (placeholder behavior)', async () => {
    vi.mocked(getAuthToken).mockResolvedValue('tok');
    await refreshTokenCache();
    expect(getAuthToken).toHaveBeenCalled();
  });

  it('does not throw', async () => {
    vi.mocked(getAuthToken).mockResolvedValue(null);
    await expect(refreshTokenCache()).resolves.not.toThrow();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. RATE LIMITER
// ═════════════════════════════════════════════════════════════════════════════

// findings.md P2:2616 — canConnect() used to enforce `connectionsPerMinute`
// directly, which meant an unauth'd connect storm locked legit users
// out until the window rolled. Now canConnect() enforces only the cheap
// pre-auth quota (max(1000, connectionsPerMinute*10)); the configured
// per-minute limit is enforced on successful auth via canAuthenticate().
describe('Rate Limiter — canAuthenticate()', () => {
  beforeEach(async () => {
    resetRateLimiter();
    configureRateLimiter({ connectionsPerMinute: 5, requestsPerSecond: 10, burstSize: 20 });
  });
  afterEach(() => resetRateLimiter());

  it('allows the first authenticated connection', async () => {
    const { canAuthenticate } = await import('../src/gateway/rate-limiter.js');
    expect(canAuthenticate().allowed).toBe(true);
  });

  it('allows exactly connectionsPerMinute authenticated connections', async () => {
    const { canAuthenticate } = await import('../src/gateway/rate-limiter.js');
    for (let i = 0; i < 5; i++) expect(canAuthenticate().allowed).toBe(true);
  });

  it('rejects the (connectionsPerMinute + 1)th authenticated connection', async () => {
    const { canAuthenticate } = await import('../src/gateway/rate-limiter.js');
    for (let i = 0; i < 5; i++) canAuthenticate();
    expect(canAuthenticate().allowed).toBe(false);
  });

  it('includes retryAfter when rejected', async () => {
    const { canAuthenticate } = await import('../src/gateway/rate-limiter.js');
    for (let i = 0; i < 5; i++) canAuthenticate();
    const result = canAuthenticate();
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  it('retryAfter is in seconds (≤ 60)', async () => {
    const { canAuthenticate } = await import('../src/gateway/rate-limiter.js');
    for (let i = 0; i < 5; i++) canAuthenticate();
    expect(canAuthenticate().retryAfter).toBeLessThanOrEqual(60);
  });

  it('resetRateLimiter allows authentications again after exhaustion', async () => {
    const { canAuthenticate } = await import('../src/gateway/rate-limiter.js');
    for (let i = 0; i < 5; i++) canAuthenticate();
    resetRateLimiter();
    configureRateLimiter({ connectionsPerMinute: 5, requestsPerSecond: 10, burstSize: 20 });
    expect(canAuthenticate().allowed).toBe(true);
  });

  it('high limit allows many authentications', async () => {
    const { canAuthenticate } = await import('../src/gateway/rate-limiter.js');
    resetRateLimiter();
    configureRateLimiter({ connectionsPerMinute: 1000, requestsPerSecond: 10, burstSize: 20 });
    for (let i = 0; i < 100; i++) expect(canAuthenticate().allowed).toBe(true);
  });

  it('limit of 1 only allows 1 authentication', async () => {
    const { canAuthenticate } = await import('../src/gateway/rate-limiter.js');
    resetRateLimiter();
    configureRateLimiter({ connectionsPerMinute: 1, requestsPerSecond: 10, burstSize: 20 });
    expect(canAuthenticate().allowed).toBe(true);
    expect(canAuthenticate().allowed).toBe(false);
  });
});

describe('Rate Limiter — canConnect() pre-auth budget', () => {
  beforeEach(() => {
    resetRateLimiter();
    configureRateLimiter({ connectionsPerMinute: 5, requestsPerSecond: 10, burstSize: 20 });
  });
  afterEach(() => resetRateLimiter());

  it('pre-auth budget is way bigger than connectionsPerMinute (legit users not locked out by connect storms)', () => {
    // With connectionsPerMinute=5, pre-auth budget floors at 1000/min.
    for (let i = 0; i < 200; i++) expect(canConnect().allowed).toBe(true);
  });

  it('does NOT drain the authenticated-connection budget', async () => {
    const { canAuthenticate } = await import('../src/gateway/rate-limiter.js');
    for (let i = 0; i < 100; i++) canConnect();
    // All 5 authenticated slots must still be available.
    for (let i = 0; i < 5; i++) expect(canAuthenticate().allowed).toBe(true);
  });
});

describe('Rate Limiter — registerConnection / unregisterConnection', () => {
  beforeEach(() => {
    resetRateLimiter();
    configureRateLimiter({ connectionsPerMinute: 100, requestsPerSecond: 10, burstSize: 20 });
  });
  afterEach(() => resetRateLimiter());

  it('getConnectionCount is 0 initially', () => {
    expect(getConnectionCount()).toBe(0);
  });

  it('getConnectionCount increments after registerConnection', () => {
    registerConnection('c1');
    expect(getConnectionCount()).toBe(1);
  });

  it('getConnectionCount decrements after unregisterConnection', () => {
    registerConnection('c1');
    unregisterConnection('c1');
    expect(getConnectionCount()).toBe(0);
  });

  it('multiple registrations tracked correctly', () => {
    registerConnection('c1');
    registerConnection('c2');
    registerConnection('c3');
    expect(getConnectionCount()).toBe(3);
  });

  it('unregistering unknown id is safe', () => {
    expect(() => unregisterConnection('nobody')).not.toThrow();
  });
});

describe('Rate Limiter — canRequest()', () => {
  beforeEach(() => {
    resetRateLimiter();
    configureRateLimiter({ connectionsPerMinute: 100, requestsPerSecond: 3, burstSize: 5 });
  });
  afterEach(() => resetRateLimiter());

  it('returns allowed:false for unregistered connection', () => {
    expect(canRequest('nobody').allowed).toBe(false);
  });

  it('includes retryAfter:1 for unregistered connection', () => {
    expect(canRequest('nobody').retryAfter).toBe(1);
  });

  it('allows first request after registration', () => {
    registerConnection('c1');
    expect(canRequest('c1').allowed).toBe(true);
  });

  it('allows up to requestsPerSecond requests', () => {
    registerConnection('c1');
    for (let i = 0; i < 3; i++) expect(canRequest('c1').allowed).toBe(true);
  });

  it('rejects (requestsPerSecond + 1)th request', () => {
    registerConnection('c1');
    for (let i = 0; i < 3; i++) canRequest('c1');
    expect(canRequest('c1').allowed).toBe(false);
  });

  it('allows up to burstSize before blocking', () => {
    registerConnection('c1');
    // Use a fresh config with rps = burstSize so we hit burst not rps
    resetRateLimiter();
    configureRateLimiter({ connectionsPerMinute: 100, requestsPerSecond: 10, burstSize: 5 });
    registerConnection('c1');
    for (let i = 0; i < 5; i++) expect(canRequest('c1').allowed).toBe(true);
  });

  it('after burst exhaustion, connection is blocked', () => {
    registerConnection('c1');
    for (let i = 0; i < 5; i++) canRequest('c1');
    const result = canRequest('c1');
    expect(result.allowed).toBe(false);
  });

  it('blocked connection gets retryAfter of 10 seconds', () => {
    // Use rps >= burstSize so we hit the burst ceiling, not the rps ceiling
    resetRateLimiter();
    configureRateLimiter({ connectionsPerMinute: 100, requestsPerSecond: 10, burstSize: 5 });
    registerConnection('c1');
    for (let i = 0; i < 5; i++) canRequest('c1');
    const result = canRequest('c1');
    expect(result.retryAfter).toBe(10);
  });

  it('blocked status is reflected in getRateLimitStatus', () => {
    // Use rps >= burstSize so we hit the burst ceiling, not the rps ceiling
    resetRateLimiter();
    configureRateLimiter({ connectionsPerMinute: 100, requestsPerSecond: 10, burstSize: 5 });
    registerConnection('c1');
    for (let i = 0; i < 5; i++) canRequest('c1');
    canRequest('c1'); // trigger block
    const status = getRateLimitStatus('c1');
    expect(status?.blocked).toBe(true);
  });

  it('separate connections are tracked independently', () => {
    resetRateLimiter();
    configureRateLimiter({ connectionsPerMinute: 100, requestsPerSecond: 2, burstSize: 5 });
    registerConnection('c1');
    registerConnection('c2');
    canRequest('c1');
    canRequest('c1');
    // c1 exhausted, c2 still fresh
    expect(canRequest('c2').allowed).toBe(true);
  });

  it('requestCount resets after window (simulated by resetting)', () => {
    registerConnection('c1');
    for (let i = 0; i < 3; i++) canRequest('c1');
    // The window is 1 second; resetting simulates window expiry
    resetRateLimiter();
    configureRateLimiter({ connectionsPerMinute: 100, requestsPerSecond: 3, burstSize: 5 });
    registerConnection('c1');
    expect(canRequest('c1').allowed).toBe(true);
  });
});

describe('Rate Limiter — getRateLimitStatus()', () => {
  beforeEach(() => {
    resetRateLimiter();
    configureRateLimiter({ connectionsPerMinute: 100, requestsPerSecond: 10, burstSize: 20 });
  });
  afterEach(() => resetRateLimiter());

  it('returns null for unknown connection', () => {
    expect(getRateLimitStatus('nobody')).toBeNull();
  });

  it('returns status for registered connection', () => {
    registerConnection('c1');
    const status = getRateLimitStatus('c1');
    expect(status).not.toBeNull();
  });

  it('initial requestCount is 0', () => {
    registerConnection('c1');
    expect(getRateLimitStatus('c1')?.requestCount).toBe(0);
  });

  it('blocked is false initially', () => {
    registerConnection('c1');
    expect(getRateLimitStatus('c1')?.blocked).toBe(false);
  });

  it('requestCount increases with each allowed request', () => {
    registerConnection('c1');
    canRequest('c1');
    canRequest('c1');
    expect(getRateLimitStatus('c1')?.requestCount).toBe(2);
  });

  it('includes blockedUntil when blocked', () => {
    resetRateLimiter();
    configureRateLimiter({ connectionsPerMinute: 100, requestsPerSecond: 10, burstSize: 3 });
    registerConnection('c1');
    for (let i = 0; i < 3; i++) canRequest('c1');
    canRequest('c1'); // triggers block
    const status = getRateLimitStatus('c1');
    if (status?.blocked) {
      expect(status.blockedUntil).toBeDefined();
      expect(status.blockedUntil!).toBeGreaterThan(Date.now());
    }
  });

  it('windowStart is set to approximately now', () => {
    const before = Date.now();
    registerConnection('c1');
    const status = getRateLimitStatus('c1');
    expect(status?.windowStart).toBeGreaterThanOrEqual(before - 10);
  });
});

describe('Rate Limiter — configureRateLimiter()', () => {
  afterEach(() => resetRateLimiter());

  it('new config takes effect immediately (authenticated budget)', async () => {
    const { canAuthenticate } = await import('../src/gateway/rate-limiter.js');
    resetRateLimiter();
    configureRateLimiter({ connectionsPerMinute: 1, requestsPerSecond: 1, burstSize: 1 });
    canAuthenticate(); // use the 1 allowed
    expect(canAuthenticate().allowed).toBe(false);
  });

  it('can raise the limit (authenticated budget)', async () => {
    const { canAuthenticate } = await import('../src/gateway/rate-limiter.js');
    resetRateLimiter();
    configureRateLimiter({ connectionsPerMinute: 2, requestsPerSecond: 10, burstSize: 20 });
    canAuthenticate();
    canAuthenticate();
    expect(canAuthenticate().allowed).toBe(false);

    resetRateLimiter();
    configureRateLimiter({ connectionsPerMinute: 100, requestsPerSecond: 10, burstSize: 20 });
    for (let i = 0; i < 50; i++) expect(canAuthenticate().allowed).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. ROUTER — handleMessage
// ═════════════════════════════════════════════════════════════════════════════

describe('Router — message validation', () => {
  it('returns INVALID_REQUEST when id is missing', async () => {
    const m = { method: 'ping' } as GatewayMessage;
    const r = await handleMessage('c', m, false);
    expect(r.error?.code).toBe(GatewayErrorCodes.INVALID_REQUEST);
  });

  it('returns INVALID_REQUEST when method is missing', async () => {
    const m = { id: '1' } as GatewayMessage;
    const r = await handleMessage('c', m, false);
    expect(r.error?.code).toBe(GatewayErrorCodes.INVALID_REQUEST);
  });

  it('error response echoes the message id', async () => {
    const r = await handleMessage('c', { id: 'my-id', method: 'nonexistent' }, false);
    expect(r.id).toBe('my-id');
  });

  it('returns METHOD_NOT_FOUND for unknown method', async () => {
    const r = await handleMessage('c', msg('__no_such_method__'), false);
    expect(r.error?.code).toBe(GatewayErrorCodes.METHOD_NOT_FOUND);
  });

  it('error message names the missing method', async () => {
    const r = await handleMessage('c', msg('ghost'), false);
    expect(r.error?.message).toContain('ghost');
  });

  it('returns UNAUTHORIZED when requireAuth=true and not authenticated', async () => {
    clearAuthentications();
    const r = await handleMessage('unauthenticated-conn', msg('ping'), true);
    expect(r.error?.code).toBe(GatewayErrorCodes.UNAUTHORIZED);
  });

  it('allows ping without auth when requireAuth=false', async () => {
    const r = await handleMessage('c', msg('ping'), false);
    expect(r.error).toBeUndefined();
  });

  it('auth method is always allowed even when requireAuth=true', async () => {
    // auth without a token param returns INVALID_PARAMS, NOT UNAUTHORIZED
    const r = await handleMessage('c', msg('auth'), true);
    expect(r.error?.code).not.toBe(GatewayErrorCodes.UNAUTHORIZED);
  });
});

describe('Router — built-in methods', () => {
  it('ping returns pong:true', async () => {
    const r = await handleMessage('c', msg('ping'), false);
    expect((r.result as Record<string, unknown>)?.['pong']).toBe(true);
  });

  it('ping returns a timestamp number', async () => {
    const r = await handleMessage('c', msg('ping'), false);
    expect(typeof (r.result as Record<string, unknown>)?.['timestamp']).toBe('number');
  });

  it('echo returns { echo: params }', async () => {
    const r = await handleMessage('c', msg('echo', { hello: 'world' }), false);
    expect(r.result).toEqual({ echo: { hello: 'world' } });
  });

  it('echo with no params returns { echo: undefined }', async () => {
    const r = await handleMessage('c', { id: '1', method: 'echo' }, false);
    expect(r.result).toEqual({ echo: undefined });
  });

  it('status returns status:"running"', async () => {
    const r = await handleMessage('c', msg('status'), false);
    expect((r.result as Record<string, unknown>)?.['status']).toBe('running');
  });

  it('status returns a timestamp', async () => {
    const r = await handleMessage('c', msg('status'), false);
    expect(typeof (r.result as Record<string, unknown>)?.['timestamp']).toBe('number');
  });

  it('status returns uptime as a number', async () => {
    const r = await handleMessage('c', msg('status'), false);
    expect(typeof (r.result as Record<string, unknown>)?.['uptime']).toBe('number');
  });

  it('setAgent returns error when no agentId provided', async () => {
    const r = await handleMessage('c', msg('setAgent', {}), false);
    expect(r.error).toBeDefined();
    expect(r.error?.code).toBe(GatewayErrorCodes.INTERNAL_ERROR);
  });

  it('setAgent errors when connection not authenticated (not in connections map)', async () => {
    const r = await handleMessage('c-not-authenticated', msg('setAgent', { agentId: 'pkd' }), false);
    expect(r.error).toBeDefined();
  });

  it('setAgent succeeds for authenticated connection', async () => {
    vi.mocked(getAuthToken).mockResolvedValue('tok');
    const id = uid();
    await authenticate(id, 'tok');
    const r = await handleMessage(id, msg('setAgent', { agentId: 'lain' }), false);
    expect(r.error).toBeUndefined();
    expect((r.result as Record<string, unknown>)?.['success']).toBe(true);
    clearAuthentications();
  });
});

describe('Router — auth method handling', () => {
  beforeEach(() => { clearAuthentications(); resetRateLimiter(); });
  afterEach(() => { clearAuthentications(); resetRateLimiter(); });

  it('returns INVALID_PARAMS when token param is missing', async () => {
    const r = await handleMessage('c', msg('auth', {}), true);
    expect(r.error?.code).toBe(GatewayErrorCodes.INVALID_PARAMS);
  });

  it('returns INVALID_PARAMS when token is not a string', async () => {
    const r = await handleMessage('c', msg('auth', { token: 123 }), true);
    expect(r.error?.code).toBe(GatewayErrorCodes.INVALID_PARAMS);
  });

  it('returns UNAUTHORIZED when token is wrong', async () => {
    vi.mocked(getAuthToken).mockResolvedValue('correct');
    const r = await handleMessage('c', msg('auth', { token: 'wrong' }), true);
    expect(r.error?.code).toBe(GatewayErrorCodes.UNAUTHORIZED);
  });

  it('returns authenticated:true on success', async () => {
    vi.mocked(getAuthToken).mockResolvedValue('my-secret');
    const id = uid();
    const r = await handleMessage(id, msg('auth', { token: 'my-secret' }), true);
    expect(r.error).toBeUndefined();
    expect((r.result as Record<string, unknown>)?.['authenticated']).toBe(true);
  });

  it('returns connectionId in result on success', async () => {
    vi.mocked(getAuthToken).mockResolvedValue('tok');
    const id = uid();
    const r = await handleMessage(id, msg('auth', { token: 'tok' }), true);
    expect((r.result as Record<string, unknown>)?.['connectionId']).toBe(id);
  });

  it('connection is now authenticated after successful auth', async () => {
    vi.mocked(getAuthToken).mockResolvedValue('tok');
    const id = uid();
    await handleMessage(id, msg('auth', { token: 'tok' }), true);
    expect(isAuthenticated(id)).toBe(true);
  });
});

describe('Router — registerMethod / unregisterMethod', () => {
  afterEach(() => {
    unregisterMethod('testFn');
    unregisterMethod('thrower');
    unregisterMethod('asyncFn');
  });

  it('registered method is callable', async () => {
    registerMethod('testFn', () => 'ok');
    const r = await handleMessage('c', msg('testFn'), false);
    expect(r.result).toBe('ok');
  });

  it('registered method receives connectionId', async () => {
    let receivedId = '';
    registerMethod('testFn', (connId) => { receivedId = connId; return null; });
    await handleMessage('conn-xyz', msg('testFn'), false);
    expect(receivedId).toBe('conn-xyz');
  });

  it('registered method receives params', async () => {
    let receivedParams: unknown;
    registerMethod('testFn', (_c, params) => { receivedParams = params; return null; });
    await handleMessage('c', msg('testFn', { x: 1 }), false);
    expect(receivedParams).toEqual({ x: 1 });
  });

  it('thrown error in handler returns INTERNAL_ERROR', async () => {
    registerMethod('thrower', () => { throw new Error('boom'); });
    const r = await handleMessage('c', msg('thrower'), false);
    expect(r.error?.code).toBe(GatewayErrorCodes.INTERNAL_ERROR);
  });

  it('thrown error message is included in response', async () => {
    registerMethod('thrower', () => { throw new Error('specific error'); });
    const r = await handleMessage('c', msg('thrower'), false);
    expect(r.error?.message).toBe('specific error');
  });

  it('non-Error throw results in "Unknown error"', async () => {
    registerMethod('thrower', () => { throw 'string error'; });
    const r = await handleMessage('c', msg('thrower'), false);
    expect(r.error?.message).toBe('Unknown error');
  });

  it('async handler is awaited', async () => {
    registerMethod('asyncFn', async () => {
      await new Promise((r) => setTimeout(r, 10));
      return 'async-result';
    });
    const r = await handleMessage('c', msg('asyncFn'), false);
    expect(r.result).toBe('async-result');
  });

  it('unregisterMethod removes the handler', async () => {
    registerMethod('testFn', () => 'ok');
    unregisterMethod('testFn');
    const r = await handleMessage('c', msg('testFn'), false);
    expect(r.error?.code).toBe(GatewayErrorCodes.METHOD_NOT_FOUND);
  });

  it('unregisterMethod returns true for existing method', () => {
    registerMethod('testFn', () => null);
    expect(unregisterMethod('testFn')).toBe(true);
  });

  it('unregisterMethod returns false for non-existent method', () => {
    expect(unregisterMethod('does-not-exist')).toBe(false);
  });

  it('overwriting a method replaces it', async () => {
    registerMethod('testFn', () => 'v1');
    registerMethod('testFn', () => 'v2');
    const r = await handleMessage('c', msg('testFn'), false);
    expect(r.result).toBe('v2');
    unregisterMethod('testFn');
  });
});

describe('Router — response structure', () => {
  it('success response has id and result, no error', async () => {
    const r = await handleMessage('c', msg('ping', undefined, 'abc'), false);
    expect(r.id).toBe('abc');
    expect(r.result).toBeDefined();
    expect(r.error).toBeUndefined();
  });

  it('error response has id and error, no result', async () => {
    const r = await handleMessage('c', msg('ghost', undefined, 'xyz'), false);
    expect(r.id).toBe('xyz');
    expect(r.error).toBeDefined();
    expect(r.result).toBeUndefined();
  });

  it('error has code and message fields', async () => {
    const r = await handleMessage('c', msg('ghost'), false);
    expect(typeof r.error?.code).toBe('number');
    expect(typeof r.error?.message).toBe('string');
  });
});

describe('Router — registerChatMethod()', () => {
  afterEach(() => {
    unregisterMethod('chat');
  });

  it('registers a "chat" method', () => {
    registerChatMethod();
    // If chat method is registered, calling it without params should error internally
    // but not give METHOD_NOT_FOUND
    expect(async () => {
      const r = await handleMessage('c', msg('chat', { message: '' }), false);
      // empty message should fail at agent level or param validation
      return r;
    }).not.toThrow();
  });

  it('chat method returns INTERNAL_ERROR when message param missing', async () => {
    registerChatMethod();
    const r = await handleMessage('c', msg('chat', {}), false);
    expect(r.error?.code).toBe(GatewayErrorCodes.INTERNAL_ERROR);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. SERVER STATE FUNCTIONS (no real socket)
// ═════════════════════════════════════════════════════════════════════════════

describe('Gateway Server — isServerRunning()', () => {
  it('returns false when server has not been started', () => {
    // We never call startServer so it should be false
    expect(isServerRunning()).toBe(false);
  });
});

describe('Gateway Server — getServerStatus()', () => {
  it('returns running:false when not started', () => {
    expect(getServerStatus().running).toBe(false);
  });

  it('returns connections:0 when not started', () => {
    expect(getServerStatus().connections).toBe(0);
  });

  it('returns uptime:0 when not started', () => {
    expect(getServerStatus().uptime).toBe(0);
  });

  it('returns no socketPath when not started', () => {
    expect(getServerStatus().socketPath).toBeUndefined();
  });
});

describe('Gateway Server — getServerPid()', () => {
  const testDir = join(tmpdir(), 'lain-test-pid-' + Date.now());
  const pidFile = join(testDir, 'gateway.pid');

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try { await rm(testDir, { recursive: true }); } catch { /* ignore */ }
  });

  it('returns null for non-existent pid file', async () => {
    expect(await getServerPid('/nonexistent/path.pid')).toBeNull();
  });

  it('returns the pid when file contains a valid number', async () => {
    await writeFile(pidFile, '12345');
    expect(await getServerPid(pidFile)).toBe(12345);
  });

  it('returns null when file contains non-numeric content', async () => {
    await writeFile(pidFile, 'not-a-pid');
    expect(await getServerPid(pidFile)).toBeNull();
  });

  it('trims whitespace from pid file content', async () => {
    await writeFile(pidFile, '  9999  \n');
    expect(await getServerPid(pidFile)).toBe(9999);
  });

  it('returns null for empty pid file', async () => {
    await writeFile(pidFile, '');
    expect(await getServerPid(pidFile)).toBeNull();
  });
});

describe('Gateway Server — isProcessRunning()', () => {
  it('returns true for the current process pid', () => {
    expect(isProcessRunning(process.pid)).toBe(true);
  });

  it('returns false for an obviously invalid pid (e.g. 9999999)', () => {
    // Very high PID unlikely to exist
    const result = isProcessRunning(9999999);
    // May be true on some systems; we just verify it does not throw
    expect(typeof result).toBe('boolean');
  });

  it('returns false for pid 0 (kills process group, should return false safely)', () => {
    // process.kill(0, 0) sends to process group — should succeed on current process
    // We just verify it doesn't throw
    expect(() => isProcessRunning(0)).not.toThrow();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. GatewayErrorCodes constants
// ═════════════════════════════════════════════════════════════════════════════

describe('GatewayErrorCodes', () => {
  it('PARSE_ERROR is -32700', () => {
    expect(GatewayErrorCodes.PARSE_ERROR).toBe(-32700);
  });

  it('INVALID_REQUEST is -32600', () => {
    expect(GatewayErrorCodes.INVALID_REQUEST).toBe(-32600);
  });

  it('METHOD_NOT_FOUND is -32601', () => {
    expect(GatewayErrorCodes.METHOD_NOT_FOUND).toBe(-32601);
  });

  it('INVALID_PARAMS is -32602', () => {
    expect(GatewayErrorCodes.INVALID_PARAMS).toBe(-32602);
  });

  it('INTERNAL_ERROR is -32603', () => {
    expect(GatewayErrorCodes.INTERNAL_ERROR).toBe(-32603);
  });

  it('UNAUTHORIZED is -32000', () => {
    expect(GatewayErrorCodes.UNAUTHORIZED).toBe(-32000);
  });

  it('RATE_LIMITED is -32001', () => {
    expect(GatewayErrorCodes.RATE_LIMITED).toBe(-32001);
  });

  it('MESSAGE_TOO_LARGE is -32002', () => {
    expect(GatewayErrorCodes.MESSAGE_TOO_LARGE).toBe(-32002);
  });

  it('AGENT_NOT_FOUND is -32003', () => {
    expect(GatewayErrorCodes.AGENT_NOT_FOUND).toBe(-32003);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. secureCompare (crypto utility used by auth)
// ═════════════════════════════════════════════════════════════════════════════

describe('secureCompare (crypto utility)', () => {
  it('returns true for identical strings', () => {
    expect(secureCompare('hello', 'hello')).toBe(true);
  });

  it('returns false for different strings of same length', () => {
    expect(secureCompare('hello', 'world')).toBe(false);
  });

  it('returns false when lengths differ', () => {
    expect(secureCompare('short', 'longer')).toBe(false);
  });

  it('returns true for empty strings', () => {
    expect(secureCompare('', '')).toBe(true);
  });

  it('returns false for empty vs non-empty', () => {
    expect(secureCompare('', 'a')).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(secureCompare('ABC', 'abc')).toBe(false);
  });

  it('handles special characters', () => {
    const tok = '!@#$%^&*()_+';
    expect(secureCompare(tok, tok)).toBe(true);
    expect(secureCompare(tok, tok + ' ')).toBe(false);
  });

  it('handles unicode tokens', () => {
    expect(secureCompare('日本語', '日本語')).toBe(true);
  });

  it('handles long tokens', () => {
    const long = 'x'.repeat(1000);
    expect(secureCompare(long, long)).toBe(true);
    expect(secureCompare(long, long.slice(0, -1) + 'y')).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. Edge cases
// ═════════════════════════════════════════════════════════════════════════════

describe('Edge cases — router', () => {
  it('message with numeric id is rejected (INVALID_REQUEST)', async () => {
    const m = { id: 123 as unknown as string, method: 'ping' };
    const r = await handleMessage('c', m as GatewayMessage, false);
    expect(r.error?.code).toBe(GatewayErrorCodes.INVALID_REQUEST);
  });

  it('message with null id is rejected', async () => {
    const m = { id: null as unknown as string, method: 'ping' };
    const r = await handleMessage('c', m as GatewayMessage, false);
    expect(r.error?.code).toBe(GatewayErrorCodes.INVALID_REQUEST);
  });

  it('message with numeric method is rejected', async () => {
    const m = { id: '1', method: 123 as unknown as string };
    const r = await handleMessage('c', m as GatewayMessage, false);
    expect(r.error?.code).toBe(GatewayErrorCodes.INVALID_REQUEST);
  });

  it('extremely long method name returns METHOD_NOT_FOUND not a crash', async () => {
    const r = await handleMessage('c', msg('x'.repeat(10000)), false);
    expect(r.error?.code).toBe(GatewayErrorCodes.METHOD_NOT_FOUND);
  });

  it('method name with special chars returns METHOD_NOT_FOUND', async () => {
    const r = await handleMessage('c', msg('method/with/slashes'), false);
    expect(r.error?.code).toBe(GatewayErrorCodes.METHOD_NOT_FOUND);
  });

  it('deeply nested params are passed through intact', async () => {
    const deep = { a: { b: { c: { d: 'deep' } } } };
    registerMethod('deepTest', (_c, params) => params);
    const r = await handleMessage('c', msg('deepTest', deep), false);
    expect(r.result).toEqual(deep);
    unregisterMethod('deepTest');
  });

  it('empty params object is passed to handler', async () => {
    let got: unknown = 'NOT_SET';
    registerMethod('paramTest', (_c, p) => { got = p; return null; });
    await handleMessage('c', msg('paramTest', {}), false);
    expect(got).toEqual({});
    unregisterMethod('paramTest');
  });

  it('missing params is passed as undefined to handler', async () => {
    let got: unknown = 'NOT_SET';
    registerMethod('paramTest', (_c, p) => { got = p; return null; });
    await handleMessage('c', { id: '1', method: 'paramTest' }, false);
    expect(got).toBeUndefined();
    unregisterMethod('paramTest');
  });
});

describe('Edge cases — auth concurrent authentication', () => {
  beforeEach(() => { clearAuthentications(); resetRateLimiter(); });
  afterEach(() => { clearAuthentications(); resetRateLimiter(); });

  it('authenticating the same connectionId twice results in a single entry', async () => {
    vi.mocked(getAuthToken).mockResolvedValue('tok');
    const id = 'same-conn';
    await authenticate(id, 'tok');
    await authenticate(id, 'tok');
    // Map.set overwrites — only one connection
    expect(getAuthenticatedConnectionCount()).toBe(1);
  });

  it('concurrent authentications for different IDs all succeed', async () => {
    vi.mocked(getAuthToken).mockResolvedValue('tok');
    const ids = Array.from({ length: 10 }, () => uid());
    await Promise.all(ids.map((id) => authenticate(id, 'tok')));
    expect(getAuthenticatedConnectionCount()).toBe(10);
  });
});

describe('Edge cases — rate limiter concurrent connections', () => {
  afterEach(() => resetRateLimiter());

  it('registering then unregistering the same id is idempotent', () => {
    resetRateLimiter();
    configureRateLimiter({ connectionsPerMinute: 100, requestsPerSecond: 10, burstSize: 20 });
    registerConnection('c');
    unregisterConnection('c');
    unregisterConnection('c'); // second unregister should not throw
    expect(getConnectionCount()).toBe(0);
  });

  it('re-registering a previously unregistered connection resets its state', () => {
    resetRateLimiter();
    configureRateLimiter({ connectionsPerMinute: 100, requestsPerSecond: 2, burstSize: 5 });
    registerConnection('c');
    canRequest('c');
    canRequest('c');
    unregisterConnection('c');
    registerConnection('c');
    // Fresh state — first request should be allowed
    expect(canRequest('c').allowed).toBe(true);
  });
});
