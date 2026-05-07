/**
 * Per-character interlink authentication.
 *
 * Background (findings.md P1:2289): a single shared `LAIN_INTERLINK_TOKEN`
 * combined with body-asserted identity fields (`fromId`, `senderId`,
 * `characterId`, `creatorId`, `authorId`) meant any process holding the
 * token could impersonate any character on every interlink endpoint.
 *
 * Scheme:
 *   - Each character has a derived token:
 *       derived = HMAC-SHA256(LAIN_INTERLINK_TOKEN, "interlink:" + id)
 *   - Outbound callers send:
 *       X-Interlink-From: <own character id>
 *       Authorization: Bearer <own derived token>
 *   - Inbound handlers re-derive the expected token from
 *     `X-Interlink-From` and constant-time compare. The verified
 *     `fromId` becomes the source of truth for identity — body fields
 *     that claim a different identity are rejected outright.
 *
 * The raw master token is never sent over the wire. Intercepting a single
 * character's traffic reveals only that character's derived token, not the
 * master and not other characters' tokens.
 */

import { createHmac } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { secureCompare } from '../utils/crypto.js';

const DERIVATION_LABEL = 'interlink:';

function getMasterToken(): string | null {
  const m = process.env['LAIN_INTERLINK_TOKEN'];
  return m && m.length > 0 ? m : null;
}

function getOwnCharacterId(): string | null {
  const id = process.env['LAIN_CHARACTER_ID'];
  return id && id.length > 0 ? id : null;
}

/**
 * HMAC-SHA256(master, "interlink:" + id).hex — returns null if the master is
 * missing. The id is not trusted; verification re-derives using the id from
 * the request header.
 */
export function deriveInterlinkToken(characterId: string, masterOverride?: string): string | null {
  const master = masterOverride ?? getMasterToken();
  if (!master) return null;
  return createHmac('sha256', master).update(DERIVATION_LABEL + characterId).digest('hex');
}

export interface InterlinkHeaders {
  Authorization: string;
  'Content-Type': string;
  'X-Interlink-From': string;
  [header: string]: string;
}

/**
 * Outbound headers for the current process: identity + derived-token bearer.
 *
 * Returns null when LAIN_INTERLINK_TOKEN is missing or LAIN_CHARACTER_ID is
 * not set (and no override is given). Callers should treat null as
 * "interlink unavailable" and skip the remote call.
 */
export function getInterlinkHeaders(ownIdOverride?: string): InterlinkHeaders | null {
  const id = ownIdOverride ?? getOwnCharacterId();
  if (!id) return null;
  const token = deriveInterlinkToken(id);
  if (!token) return null;
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-Interlink-From': id,
  };
}

export type InterlinkAuthResult =
  | { ok: true; fromId: string }
  | { ok: false; status: 401 | 403 | 503; error: string };

/**
 * Verify an inbound interlink request. On success, returns the authenticated
 * `fromId`. Handlers MUST treat this as the source of truth for identity and
 * reject body fields that claim a different identity (see
 * `assertBodyIdentity`).
 */
export function verifyInterlinkRequest(req: Pick<IncomingMessage, 'headers'>): InterlinkAuthResult {
  const master = getMasterToken();
  if (!master) return { ok: false, status: 503, error: 'Interlink not configured' };

  const fromHeader = req.headers['x-interlink-from'];
  const fromId = Array.isArray(fromHeader) ? fromHeader[0] : fromHeader;
  if (!fromId || typeof fromId !== 'string') {
    return { ok: false, status: 401, error: 'Missing X-Interlink-From header' };
  }

  const authHeader = req.headers['authorization'];
  const auth = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!auth || typeof auth !== 'string' || !auth.startsWith('Bearer ')) {
    return { ok: false, status: 401, error: 'Missing or invalid Authorization header' };
  }

  const provided = auth.slice('Bearer '.length);
  const expected = deriveInterlinkToken(fromId, master);
  if (!expected) return { ok: false, status: 503, error: 'Interlink not configured' };

  if (!secureCompare(provided, expected)) {
    return { ok: false, status: 403, error: 'Invalid interlink token' };
  }
  return { ok: true, fromId };
}

/**
 * Enforce that a body-asserted identity field (if present) matches the
 * authenticated `fromId`. Returns:
 *   - { ok: true } when the body omits the field, or the value matches.
 *   - { ok: false, reason } when the body claims a different identity.
 *
 * Handlers should treat a mismatch as a 403 response.
 */
export function assertBodyIdentity(
  authenticatedFromId: string,
  bodyValue: unknown,
): { ok: true } | { ok: false; reason: string } {
  if (bodyValue === undefined || bodyValue === null || bodyValue === '') return { ok: true };
  if (typeof bodyValue !== 'string') {
    return { ok: false, reason: 'identity field is not a string' };
  }
  if (bodyValue !== authenticatedFromId) {
    return {
      ok: false,
      reason: `body claims identity "${bodyValue}" but authenticated as "${authenticatedFromId}"`,
    };
  }
  return { ok: true };
}
