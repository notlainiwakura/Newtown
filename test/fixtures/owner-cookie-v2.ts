/**
 * Test helper for the v2 owner cookie (findings.md P2:2348).
 *
 * The production code constructs v2 cookies by calling `issueOwnerCookie`,
 * which calls `issueNonce` — and `issueNonce` throws unless the process
 * identifies as Wired Lain AND the database is initialised. Most tests just
 * want a cookie string that `isOwner(req)` accepts; they don't want the DB
 * dance. This helper builds that string without any global setup.
 *
 * On non-WL processes (the default in tests), `isNonceRevoked` falls into the
 * cache path; first sight of an unknown nonce returns "not revoked" so
 * `isOwner` returns true. That's exactly the first-sight-optimism behaviour
 * documented in owner-nonce-store.ts, and it's what the v1-era tests were
 * indirectly exercising too (v1 had no revocation).
 *
 * Tests that specifically exercise revocation should drive the nonce store
 * directly (see test/owner-cookie-v2.test.ts for examples).
 */

import { createHmac, randomBytes } from 'node:crypto';

const HMAC_MESSAGE_PREFIX = 'lain-owner-v2';
const COOKIE_NAME = 'lain_owner_v2';

export interface MakeV2CookieOpts {
  /** Override the random nonce. */
  nonce?: string;
  /** Override the issued-at timestamp. */
  iat?: number;
  /** Sign with a DIFFERENT token than the one the server trusts (for forgery tests). */
  signWith?: string;
}

/**
 * Build a full `Cookie:` header value that `isOwner(req)` accepts when
 * `LAIN_OWNER_TOKEN === token`.
 */
export function makeV2Cookie(token: string, opts: MakeV2CookieOpts = {}): string {
  const iat = opts.iat ?? Date.now();
  const nonce = opts.nonce ?? randomBytes(16).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify({ iat, nonce }), 'utf-8').toString('base64url');
  const signingToken = opts.signWith ?? token;
  const sig = createHmac('sha256', signingToken)
    .update(`${HMAC_MESSAGE_PREFIX}|${payloadB64}`)
    .digest('hex');
  return `${COOKIE_NAME}=${payloadB64}.${sig}`;
}

/** The raw `nonce.sig` value (no cookie name) — useful when composing headers. */
export function makeV2CookieValue(token: string, opts: MakeV2CookieOpts = {}): string {
  const header = makeV2Cookie(token, opts);
  return header.slice(`${COOKIE_NAME}=`.length);
}

export const OWNER_COOKIE_NAME = COOKIE_NAME;
