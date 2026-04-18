/**
 * Shared owner authentication via HMAC-signed cookie.
 *
 * The main server (server.ts) sets the cookie via /gate?token=<LAIN_OWNER_TOKEN>.
 * All servers (character-server, doctor-server) can independently verify it
 * using the same LAIN_OWNER_TOKEN env var — no shared session state needed.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { ServerResponse } from 'node:http';

const COOKIE_NAME = 'lain_owner';
const HMAC_MESSAGE = 'lain-owner-v1';

/**
 * Derive the deterministic HMAC cookie value from the owner token.
 * Same token always produces the same value, so any server can verify.
 */
export function deriveOwnerCookie(ownerToken: string): string {
  return createHmac('sha256', ownerToken).update(HMAC_MESSAGE).digest('hex');
}

/**
 * Check if the request has a valid owner cookie.
 */
export function isOwner(req: IncomingMessage): boolean {
  const ownerToken = process.env['LAIN_OWNER_TOKEN'];
  if (!ownerToken) return false;

  const cookie = req.headers['cookie'];
  if (!cookie) return false;

  const match = cookie.match(/(?:^|;\s*)lain_owner=([a-f0-9]+)/);
  if (!match?.[1]) return false;

  const expected = deriveOwnerCookie(ownerToken);
  const provided = match[1];

  // Timing-safe comparison
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

/**
 * Set the owner cookie on the response.
 */
export function setOwnerCookie(res: ServerResponse, ownerToken: string): void {
  const value = deriveOwnerCookie(ownerToken);
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`
  );
}
