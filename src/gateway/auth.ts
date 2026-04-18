/**
 * Gateway authentication
 */

import type { AuthenticatedConnection } from '../types/gateway.js';
import { AuthenticationError } from '../utils/errors.js';
import { secureCompare } from '../utils/crypto.js';
import { getAuthToken } from '../storage/keychain.js';

const authenticatedConnections = new Map<string, AuthenticatedConnection>();

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

  const connection: AuthenticatedConnection = {
    id: connectionId,
    authenticatedAt: Date.now(),
    rateLimit: {
      requestCount: 0,
      windowStart: Date.now(),
      blocked: false,
    },
  };

  authenticatedConnections.set(connectionId, connection);
  return connection;
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
