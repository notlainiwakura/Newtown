/**
 * End-to-end coverage for the v2 owner cookie (findings.md P2:2348).
 *
 * The v2 cookie carries `{ iat, nonce }` in a base64url payload signed with
 * HMAC-SHA256(LAIN_OWNER_TOKEN). On Wired Lain the nonce lives in a SQLite
 * table; `isOwner()` consults it on every check so a single-device logout
 * (`/owner/logout`) and an every-device logout (`/owner/logout-all`) can
 * invalidate live cookies without rotating LAIN_OWNER_TOKEN and bouncing
 * every server.
 *
 * These tests pin the full loop on the authoritative (WL) path:
 *   - issue → verify → isOwner = true
 *   - revokeNonce → isOwner = false for that cookie, siblings still valid
 *   - revokeAllNonces → every live cookie rejected
 *   - unknown nonce (forged signature, valid MAC) is rejected
 *   - legacy v1 cookies rejected outright
 *   - Set-Cookie attributes: HttpOnly, SameSite=Strict, Path=/, Max-Age,
 *     Secure iff TLS signal present
 *   - clearOwnerCookie emits Max-Age=0
 *   - getOwnerNonce matches the issued nonce round-trip
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  issueOwnerCookie,
  clearOwnerCookie,
  isOwner,
  getOwnerNonce,
} from '../src/web/owner-auth.js';
import {
  revokeNonce,
  revokeAllNonces,
  _resetOwnerNonceStoreForTests,
} from '../src/web/owner-nonce-store.js';
import { makeV2Cookie } from './fixtures/owner-cookie-v2.js';

const OWNER_TOKEN = 'p2-2348-test-owner-token';

function mockReq(opts: {
  encrypted?: boolean;
  remote?: string;
  cookie?: string;
  ua?: string;
}): IncomingMessage {
  return {
    socket: { encrypted: opts.encrypted, remoteAddress: opts.remote ?? '127.0.0.1' } as never,
    headers: {
      ...(opts.cookie !== undefined ? { cookie: opts.cookie } : {}),
      ...(opts.ua !== undefined ? { 'user-agent': opts.ua } : {}),
    },
  } as unknown as IncomingMessage;
}

function mockRes(): ServerResponse & { _headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  return {
    setHeader: (k: string, v: string) => {
      headers[k] = v;
    },
    _headers: headers,
  } as unknown as ServerResponse & { _headers: Record<string, string> };
}

function cookieFromRes(res: ServerResponse & { _headers: Record<string, string> }): string {
  const set = res._headers['Set-Cookie']!;
  return set.split(';')[0]!.trim();
}

describe('v2 owner cookie end-to-end (findings.md P2:2348)', () => {
  let tmpDir: string;
  let prevCharId: string | undefined;
  let prevOwnerToken: string | undefined;

  beforeAll(async () => {
    prevCharId = process.env['LAIN_CHARACTER_ID'];
    process.env['LAIN_CHARACTER_ID'] = 'wired-lain';
    tmpDir = mkdtempSync(join(tmpdir(), 'lain-owner-v2-p2-2348-'));
    const { initDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(tmpDir, 'test.db'));
  });

  afterAll(async () => {
    const { closeDatabase } = await import('../src/storage/database.js');
    closeDatabase();
    rmSync(tmpDir, { recursive: true, force: true });
    if (prevCharId === undefined) delete process.env['LAIN_CHARACTER_ID'];
    else process.env['LAIN_CHARACTER_ID'] = prevCharId;
  });

  beforeEach(() => {
    prevOwnerToken = process.env['LAIN_OWNER_TOKEN'];
    process.env['LAIN_OWNER_TOKEN'] = OWNER_TOKEN;
    _resetOwnerNonceStoreForTests();
    revokeAllNonces();
  });

  afterEach(() => {
    if (prevOwnerToken === undefined) delete process.env['LAIN_OWNER_TOKEN'];
    else process.env['LAIN_OWNER_TOKEN'] = prevOwnerToken;
  });

  it('issue → verify roundtrip: isOwner returns true for the issued cookie', () => {
    const res = mockRes();
    issueOwnerCookie(res, OWNER_TOKEN, mockReq({}));
    const cookie = cookieFromRes(res);
    expect(isOwner(mockReq({ cookie }))).toBe(true);
  });

  it('revokeNonce invalidates the cookie on subsequent isOwner() calls', () => {
    const res = mockRes();
    issueOwnerCookie(res, OWNER_TOKEN, mockReq({}));
    const cookie = cookieFromRes(res);
    const req = mockReq({ cookie });
    expect(isOwner(req)).toBe(true);

    const nonce = getOwnerNonce(req)!;
    expect(nonce).toBeTruthy();
    revokeNonce(nonce);

    expect(isOwner(mockReq({ cookie }))).toBe(false);
  });

  it('revokeNonce only invalidates the targeted device; siblings remain valid', () => {
    const resA = mockRes();
    issueOwnerCookie(resA, OWNER_TOKEN, mockReq({ ua: 'device-A' }));
    const cookieA = cookieFromRes(resA);

    const resB = mockRes();
    issueOwnerCookie(resB, OWNER_TOKEN, mockReq({ ua: 'device-B' }));
    const cookieB = cookieFromRes(resB);

    const nonceA = getOwnerNonce(mockReq({ cookie: cookieA }))!;
    revokeNonce(nonceA);

    expect(isOwner(mockReq({ cookie: cookieA }))).toBe(false);
    expect(isOwner(mockReq({ cookie: cookieB }))).toBe(true);
  });

  it('revokeAllNonces invalidates every live cookie and reports the count', () => {
    const res1 = mockRes();
    issueOwnerCookie(res1, OWNER_TOKEN, mockReq({ ua: 'd1' }));
    const res2 = mockRes();
    issueOwnerCookie(res2, OWNER_TOKEN, mockReq({ ua: 'd2' }));
    const res3 = mockRes();
    issueOwnerCookie(res3, OWNER_TOKEN, mockReq({ ua: 'd3' }));

    const cookies = [cookieFromRes(res1), cookieFromRes(res2), cookieFromRes(res3)];
    for (const c of cookies) expect(isOwner(mockReq({ cookie: c }))).toBe(true);

    const count = revokeAllNonces();
    expect(count).toBe(3);
    for (const c of cookies) expect(isOwner(mockReq({ cookie: c }))).toBe(false);
  });

  it('unknown nonce (forged) with a valid HMAC is rejected on Wired Lain', () => {
    // The helper signs with OWNER_TOKEN, so the MAC is valid — but the
    // embedded nonce was never persisted. WL treats unknown = revoked.
    const cookie = makeV2Cookie(OWNER_TOKEN, { iat: Date.now(), nonce: 'never-issued' });
    expect(isOwner(mockReq({ cookie }))).toBe(false);
  });

  it('legacy v1 cookie (lain_owner=<hex>) is rejected outright', () => {
    const req = mockReq({ cookie: 'lain_owner=aabbccddeeff0011' });
    expect(isOwner(req)).toBe(false);
  });

  it('Set-Cookie has HttpOnly, SameSite=Strict, Path=/, Max-Age=31536000', () => {
    const res = mockRes();
    issueOwnerCookie(res, OWNER_TOKEN, mockReq({}));
    const set = res._headers['Set-Cookie']!;
    expect(set).toMatch(/^lain_owner_v2=/);
    expect(set).toContain('HttpOnly');
    expect(set).toContain('SameSite=Strict');
    expect(set).toContain('Path=/');
    expect(set).toContain('Max-Age=31536000');
  });

  it('Set-Cookie includes Secure on TLS-encrypted requests', () => {
    const res = mockRes();
    issueOwnerCookie(res, OWNER_TOKEN, mockReq({ encrypted: true, remote: '1.2.3.4' }));
    expect(res._headers['Set-Cookie']).toContain('Secure');
  });

  it('Set-Cookie omits Secure on plaintext local connections', () => {
    const res = mockRes();
    issueOwnerCookie(res, OWNER_TOKEN, mockReq({ remote: '127.0.0.1' }));
    expect(res._headers['Set-Cookie']).not.toContain('Secure');
  });

  it('clearOwnerCookie emits Max-Age=0 (browser drops the cookie)', () => {
    const res = mockRes();
    clearOwnerCookie(res, mockReq({}));
    const set = res._headers['Set-Cookie']!;
    expect(set).toMatch(/^lain_owner_v2=;/);
    expect(set).toContain('Max-Age=0');
    expect(set).toContain('HttpOnly');
    expect(set).toContain('SameSite=Strict');
    expect(set).toContain('Path=/');
  });

  it('getOwnerNonce returns the embedded nonce for a valid cookie', () => {
    const res = mockRes();
    issueOwnerCookie(res, OWNER_TOKEN, mockReq({}));
    const cookie = cookieFromRes(res);
    const nonce = getOwnerNonce(mockReq({ cookie }));
    expect(nonce).toBeTruthy();
    expect(typeof nonce).toBe('string');
    // Nonce is 16 random bytes base64url-encoded → 22 chars, no padding.
    expect(nonce!.length).toBeGreaterThanOrEqual(20);
  });

  it('getOwnerNonce returns null when the cookie is invalid', () => {
    const cookie = makeV2Cookie('wrong-token', { iat: 1, nonce: 'x' });
    expect(getOwnerNonce(mockReq({ cookie }))).toBeNull();
  });

  it('two cookies issued in the same millisecond carry different nonces', () => {
    const resA = mockRes();
    issueOwnerCookie(resA, OWNER_TOKEN, mockReq({ ua: 'A' }));
    const resB = mockRes();
    issueOwnerCookie(resB, OWNER_TOKEN, mockReq({ ua: 'B' }));
    const nonceA = getOwnerNonce(mockReq({ cookie: cookieFromRes(resA) }))!;
    const nonceB = getOwnerNonce(mockReq({ cookie: cookieFromRes(resB) }))!;
    expect(nonceA).not.toBe(nonceB);
  });
});
