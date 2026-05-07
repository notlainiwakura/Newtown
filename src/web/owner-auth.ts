/**
 * Shared owner authentication via HMAC-signed cookie.
 *
 * findings.md P2:2348 — v2 cookies carry a random nonce so the owner can
 * revoke a single device, or log out of every device at once, without
 * rotating LAIN_OWNER_TOKEN and bouncing every server. Previously the
 * cookie was a deterministic HMAC(token, "lain-owner-v1") — same value on
 * every login, no way to invalidate one device while keeping another.
 *
 * Format: `lain_owner_v2=<payloadB64>.<sigHex>`
 *   payloadB64 = base64url(JSON.stringify({ iat, nonce }))
 *   sigHex     = HMAC-SHA256(LAIN_OWNER_TOKEN, `lain-owner-v2|${payloadB64}`)
 *
 * Legacy v1 cookies (`lain_owner=<hex>`) are no longer accepted. Deploying
 * this change forces a one-time re-login on every device.
 *
 * Verification additionally consults `owner-nonce-store`: on Wired Lain
 * that's a local SQLite lookup, on other servers it's a cached HTTP check
 * against WL with a stale-grace window (so a WL outage doesn't immediately
 * log every owner out of every mortal server).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { ServerResponse } from 'node:http';
import { getLogger } from '../utils/logger.js';
import { issueNonce, isNonceRevoked } from './owner-nonce-store.js';

const COOKIE_NAME = 'lain_owner_v2';
const HMAC_MESSAGE_PREFIX = 'lain-owner-v2';

function sign(ownerToken: string, payloadB64: string): string {
  return createHmac('sha256', ownerToken)
    .update(`${HMAC_MESSAGE_PREFIX}|${payloadB64}`)
    .digest('hex');
}

function encodePayload(iat: number, nonce: string): string {
  const json = JSON.stringify({ iat, nonce });
  return Buffer.from(json, 'utf-8').toString('base64url');
}

function decodePayload(payloadB64: string): { iat: number; nonce: string } | null {
  try {
    const json = Buffer.from(payloadB64, 'base64url').toString('utf-8');
    const obj = JSON.parse(json) as { iat?: unknown; nonce?: unknown };
    if (typeof obj.iat !== 'number' || typeof obj.nonce !== 'string') return null;
    if (!Number.isFinite(obj.iat) || obj.nonce.length === 0) return null;
    return { iat: obj.iat, nonce: obj.nonce };
  } catch {
    return null;
  }
}

/**
 * findings.md P2:2338 — parse the same `LAIN_TRUSTED_PROXIES` allowlist that
 * `server.ts:getClientIp` uses. Without this, a direct attacker could assert
 * `X-Forwarded-Proto: https` and trick us into setting `Secure` on a plaintext
 * cookie.
 */
function trustedProxies(): Set<string> {
  const raw = process.env['LAIN_TRUSTED_PROXIES'];
  const base = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
  if (!raw) return base;
  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    base.add(entry);
  }
  return base;
}

/**
 * Is this request arriving over TLS? True if:
 *   - the socket is directly TLS-encrypted, OR
 *   - the direct peer is an allowlisted proxy and it asserts
 *     X-Forwarded-Proto: https (standard nginx-in-front-of-node deployment).
 * Untrusted peers cannot cause a `true` return.
 */
export function isRequestSecure(req: IncomingMessage): boolean {
  const sock = req.socket as { encrypted?: boolean; remoteAddress?: string };
  if (sock.encrypted) return true;
  const remote = sock.remoteAddress ?? '';
  if (!trustedProxies().has(remote)) return false;
  const xfp = req.headers['x-forwarded-proto'];
  const header = Array.isArray(xfp) ? xfp[0] : xfp;
  return typeof header === 'string' && header.split(',')[0]?.trim().toLowerCase() === 'https';
}

// findings.md P2:2338 — warn-once when LAIN_OWNER_TOKEN is not set.
let missingTokenWarned = false;
function warnMissingTokenOnce(): void {
  if (missingTokenWarned) return;
  missingTokenWarned = true;
  getLogger().warn('LAIN_OWNER_TOKEN is not set — owner-only routes are effectively disabled (isOwner always false).');
}

/** Test-only. Resets the warn-once latch so tests can assert emission order. */
export function _resetMissingTokenWarnForTests(): void {
  missingTokenWarned = false;
}

/**
 * Parse the v2 cookie from the request, HMAC-verify, and consult the nonce
 * store for per-device revocation. Returns null when anything fails;
 * callers treat that as "not owner."
 */
function verifyOwnerCookie(req: IncomingMessage): { nonce: string; iat: number } | null {
  const ownerToken = process.env['LAIN_OWNER_TOKEN'];
  if (!ownerToken) {
    warnMissingTokenOnce();
    return null;
  }

  const cookie = req.headers['cookie'];
  if (!cookie) return null;

  const match = cookie.match(/(?:^|;\s*)lain_owner_v2=([A-Za-z0-9_\-]+)\.([a-f0-9]+)/);
  if (!match?.[1] || !match[2]) return null;

  const payloadB64 = match[1];
  const provided = match[2];
  const expected = sign(ownerToken, payloadB64);
  if (expected.length !== provided.length) return null;
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(provided))) return null;

  const payload = decodePayload(payloadB64);
  if (!payload) return null;

  if (isNonceRevoked(payload.nonce)) return null;

  return payload;
}

/**
 * Check if the request has a valid owner cookie.
 * findings.md P2:2348 — adds per-device revocation via the owner-nonce store.
 */
export function isOwner(req: IncomingMessage): boolean {
  return verifyOwnerCookie(req) !== null;
}

/**
 * Extract the nonce from a valid owner cookie (for /owner/logout to revoke
 * the CALLING device's nonce). Returns null if the cookie isn't valid.
 */
export function getOwnerNonce(req: IncomingMessage): string | null {
  const payload = verifyOwnerCookie(req);
  return payload?.nonce ?? null;
}

/**
 * Issue a new v2 owner cookie. Must be called on Wired Lain (the server
 * that owns the nonce table). Writes a row to the nonce store and sets
 * the signed cookie on the response.
 *
 * `Secure` is added when the request arrived over TLS (or when a trusted
 * proxy asserts `X-Forwarded-Proto: https`). In dev/localhost, `Secure`
 * is omitted so the cookie round-trips over plain HTTP.
 */
export function issueOwnerCookie(
  res: ServerResponse,
  ownerToken: string,
  req: IncomingMessage,
  opts?: { deviceLabel?: string },
): void {
  const nonce = issueNonce(opts?.deviceLabel ?? deriveDeviceLabel(req));
  const iat = Date.now();
  const payloadB64 = encodePayload(iat, nonce);
  const sig = sign(ownerToken, payloadB64);
  const value = `${payloadB64}.${sig}`;

  const secure = isRequestSecure(req);
  const attrs = ['HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=31536000'];
  if (secure) attrs.push('Secure');
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${value}; ${attrs.join('; ')}`);
}

function deriveDeviceLabel(req: IncomingMessage): string {
  // Not a security primitive — just a human-readable breadcrumb so the
  // dashboard can say "revoke the one from Firefox on macOS." Trim to keep
  // rows small.
  const ua = req.headers['user-agent'];
  if (!ua) return 'unknown';
  return typeof ua === 'string' ? ua.slice(0, 120) : 'unknown';
}

/**
 * Clear the owner cookie on the response. Pairs with `revokeNonce` in the
 * nonce store for a complete logout.
 */
export function clearOwnerCookie(res: ServerResponse, req: IncomingMessage): void {
  const secure = isRequestSecure(req);
  const attrs = ['HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=0'];
  if (secure) attrs.push('Secure');
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; ${attrs.join('; ')}`);
}
