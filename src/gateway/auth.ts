/**
 * Gateway authentication
 */

import { createHash } from 'node:crypto';
import type { AuthenticatedConnection } from '../types/gateway.js';
import { AuthenticationError } from '../utils/errors.js';
import { secureCompare } from '../utils/crypto.js';
import { getAuthToken } from '../storage/keychain.js';
import { canAuthenticate } from './rate-limiter.js';

const authenticatedConnections = new Map<string, AuthenticatedConnection>();

// findings.md P2:2636 — idle-sweep defaults. A SIGKILL'd peer leaves
// the TCP socket open until the OS reaps it; without an idle TTL the
// authenticatedConnections map accumulates stale records for the life
// of the gateway process. 30min idle is long enough that a legit
// operator in a pause isn't nuked but short enough that dead peers
// don't linger.
const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000;

/**
 * Fingerprint a raw token so we can distinguish operators in audit logs
 * without retaining the cleartext. Truncated SHA-256 is plenty for this
 * use (hundreds to low thousands of distinct tokens, not cryptographic).
 */
export function fingerprintToken(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

/**
 * Refresh the cached token hash (placeholder for future optimization)
 */
export async function refreshTokenCache(): Promise<void> {
  // This function is a placeholder for future token caching optimization
  await getAuthToken();
}

/**
 * Authenticate a connection with a token
 */
export async function authenticate(
  connectionId: string,
  token: string
): Promise<AuthenticatedConnection> {
  // Get the stored token
  const storedToken = await getAuthToken();

  if (!storedToken) {
    throw new AuthenticationError('No authentication token configured');
  }

  // Compare tokens using constant-time comparison
  if (!secureCompare(token, storedToken)) {
    throw new AuthenticationError('Invalid authentication token');
  }

  // findings.md P2:2616 — enforce the authenticated-connection quota here,
  // after token validation. The pre-auth quota in canConnect() is a cheap
  // DoS backstop; this is the real per-minute cap for legit operators.
  const authResult = canAuthenticate();
  if (!authResult.allowed) {
    throw new AuthenticationError(
      `Authentication rate limit exceeded, retry after ${authResult.retryAfter ?? 60}s`,
    );
  }

  const now = Date.now();
  const connection: AuthenticatedConnection = {
    id: connectionId,
    authenticatedAt: now,
    // findings.md P2:2636 — lastActivityAt/tokenFingerprint are the
    // audit-and-TTL surface. Fingerprint is truncated sha256 so audit
    // logs can distinguish operators without holding the raw token.
    lastActivityAt: now,
    tokenFingerprint: fingerprintToken(token),
    rateLimit: {
      requestCount: 0,
      windowStart: now,
      blocked: false,
    },
  };

  authenticatedConnections.set(connectionId, connection);
  return connection;
}

/**
 * Mark a connection as active now. Called on every handled message so
 * the idle sweep keeps long-running but active clients. See
 * findings.md P2:2636.
 */
export function touchConnection(connectionId: string): void {
  const conn = authenticatedConnections.get(connectionId);
  if (conn) conn.lastActivityAt = Date.now();
}

/**
 * Sweep stale entries whose lastActivityAt is older than `idleTtlMs`.
 * Returns the number of evicted entries. See findings.md P2:2636.
 */
export function sweepIdleConnections(idleTtlMs: number = DEFAULT_IDLE_TTL_MS): number {
  const now = Date.now();
  let evicted = 0;
  for (const [id, conn] of authenticatedConnections) {
    if (now - conn.lastActivityAt > idleTtlMs) {
      authenticatedConnections.delete(id);
      evicted++;
    }
  }
  return evicted;
}

/**
 * Check if a connection is authenticated
 */
export function isAuthenticated(connectionId: string): boolean {
  return authenticatedConnections.has(connectionId);
}

/**
 * Get authenticated connection info
 */
export function getConnection(connectionId: string): AuthenticatedConnection | undefined {
  return authenticatedConnections.get(connectionId);
}

/**
 * Set agent ID for an authenticated connection
 */
export function setConnectionAgent(connectionId: string, agentId: string): boolean {
  const connection = authenticatedConnections.get(connectionId);
  if (!connection) {
    return false;
  }

  connection.agentId = agentId;
  return true;
}

/**
 * Remove authentication for a connection
 */
export function deauthenticate(connectionId: string): boolean {
  return authenticatedConnections.delete(connectionId);
}

/**
 * Get all authenticated connections
 */
export function getAuthenticatedConnections(): AuthenticatedConnection[] {
  return Array.from(authenticatedConnections.values());
}

/**
 * Count authenticated connections
 */
export function getAuthenticatedConnectionCount(): number {
  return authenticatedConnections.size;
}

/**
 * Clear all authenticated connections (for shutdown)
 */
export function clearAuthentications(): void {
  authenticatedConnections.clear();
}
