/**
 * Owner cookie hardening (findings.md P2:2338 + v2 upgrade P2:2348).
 *
 * The owner cookie previously had no `Secure` attribute — a single HTTP hop
 * (non-HTTPS redirect, subdomain misconfig) could leak it. And `isOwner()`
 * returned `false` silently when `LAIN_OWNER_TOKEN` was unset, which is
 * indistinguishable from "user is not logged in" and has masked production
 * misconfigurations.
 *
 * These tests pin:
 *   - `issueOwnerCookie` emits `Secure` when the request arrives over TLS,
 *     either directly (`socket.encrypted`) or via a trusted proxy asserting
 *     `X-Forwarded-Proto: https`.
 *   - Untrusted peers cannot cause a `Secure` cookie via forged X-F-P.
 *   - `isOwner` emits a one-shot warning when `LAIN_OWNER_TOKEN` is missing.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  issueOwnerCookie,
  isOwner,
  isRequestSecure,
  _resetMissingTokenWarnForTests,
} from '../src/web/owner-auth.js';
import { makeV2Cookie } from './fixtures/owner-cookie-v2.js';

function mockReq(opts: {
  encrypted?: boolean;
  remote?: string;
  xfp?: string | string[];
  cookie?: string;
}): IncomingMessage {
  return {
    socket: { encrypted: opts.encrypted, remoteAddress: opts.remote } as never,
    headers: {
      ...(opts.xfp !== undefined ? { 'x-forwarded-proto': opts.xfp } : {}),
      ...(opts.cookie !== undefined ? { cookie: opts.cookie } : {}),
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

describe('isRequestSecure (findings.md P2:2338)', () => {
  let prevTrusted: string | undefined;
  beforeEach(() => {
    prevTrusted = process.env['LAIN_TRUSTED_PROXIES'];
    delete process.env['LAIN_TRUSTED_PROXIES'];
  });
  afterEach(() => {
    if (prevTrusted === undefined) delete process.env['LAIN_TRUSTED_PROXIES'];
    else process.env['LAIN_TRUSTED_PROXIES'] = prevTrusted;
  });

  it('true when socket.encrypted is true (direct TLS)', () => {
    expect(isRequestSecure(mockReq({ encrypted: true, remote: '1.2.3.4' }))).toBe(true);
  });

  it('true when loopback peer asserts X-Forwarded-Proto: https', () => {
    expect(isRequestSecure(mockReq({ remote: '127.0.0.1', xfp: 'https' }))).toBe(true);
  });

  it('true when allowlisted proxy asserts X-Forwarded-Proto: https', () => {
    process.env['LAIN_TRUSTED_PROXIES'] = '10.0.0.1';
    expect(isRequestSecure(mockReq({ remote: '10.0.0.1', xfp: 'https' }))).toBe(true);
  });

  it('false when untrusted direct peer forges X-Forwarded-Proto: https (attack case)', () => {
    expect(isRequestSecure(mockReq({ remote: '203.0.113.7', xfp: 'https' }))).toBe(false);
  });

  it('false when loopback peer asserts http (plaintext nginx front-end)', () => {
    expect(isRequestSecure(mockReq({ remote: '127.0.0.1', xfp: 'http' }))).toBe(false);
  });

  it('false when no TLS signal anywhere', () => {
    expect(isRequestSecure(mockReq({ remote: '127.0.0.1' }))).toBe(false);
  });

  it('handles XFP header delivered as an array', () => {
    expect(isRequestSecure(mockReq({ remote: '127.0.0.1', xfp: ['https, http'] }))).toBe(true);
  });
});

/**
 * issueOwnerCookie writes a nonce row to the authoritative store, which is
 * WL-only and requires an initialised DB. Set both up for this describe
 * block; tear down afterwards so we don't leak state.
 */
describe('issueOwnerCookie (findings.md P2:2338 + P2:2348)', () => {
  let tmpDir: string;
  let prevCharId: string | undefined;

  beforeAll(async () => {
    prevCharId = process.env['LAIN_CHARACTER_ID'];
    process.env['LAIN_CHARACTER_ID'] = 'wired-lain';
    tmpDir = mkdtempSync(join(tmpdir(), 'lain-owner-cookie-'));
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

  it('includes HttpOnly, SameSite=Strict, Path=/, Max-Age in every call', () => {
    const res = mockRes();
    issueOwnerCookie(res, 'the-token', mockReq({ remote: '127.0.0.1' }));
    const c = res._headers['Set-Cookie']!;
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Strict');
    expect(c).toContain('Path=/');
    expect(c).toContain('Max-Age=31536000');
    expect(c).toMatch(/^lain_owner_v2=/);
  });

  it('emits Secure when req is TLS-encrypted', () => {
    const res = mockRes();
    issueOwnerCookie(res, 'the-token', mockReq({ encrypted: true, remote: '1.2.3.4' }));
    expect(res._headers['Set-Cookie']).toContain('Secure');
  });

  it('emits Secure when req arrives via loopback with XFP=https', () => {
    const res = mockRes();
    issueOwnerCookie(res, 'the-token', mockReq({ remote: '127.0.0.1', xfp: 'https' }));
    expect(res._headers['Set-Cookie']).toContain('Secure');
  });

  it('does NOT emit Secure when untrusted direct peer forges XFP=https', () => {
    const res = mockRes();
    issueOwnerCookie(res, 'the-token', mockReq({ remote: '203.0.113.7', xfp: 'https' }));
    expect(res._headers['Set-Cookie']).not.toContain('Secure');
  });

  it('does NOT emit Secure on a plaintext local connection', () => {
    const res = mockRes();
    issueOwnerCookie(res, 'the-token', mockReq({ remote: '127.0.0.1' }));
    expect(res._headers['Set-Cookie']).not.toContain('Secure');
  });
});

describe('isOwner missing-token log-once (findings.md P2:2338)', () => {
  let prev: string | undefined;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    prev = process.env['LAIN_OWNER_TOKEN'];
    delete process.env['LAIN_OWNER_TOKEN'];
    _resetMissingTokenWarnForTests();
    // Spy on the concrete logger returned by getLogger.
    const { getLogger } = await import('../src/utils/logger.js');
    warnSpy = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    if (prev === undefined) delete process.env['LAIN_OWNER_TOKEN'];
    else process.env['LAIN_OWNER_TOKEN'] = prev;
    warnSpy.mockRestore();
  });

  it('warns exactly once across many isOwner() calls when token is missing', () => {
    const cookie = makeV2Cookie('some-token');
    for (let i = 0; i < 5; i++) {
      expect(isOwner(mockReq({ cookie }))).toBe(false);
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/LAIN_OWNER_TOKEN is not set/);
  });

  it('does not warn when LAIN_OWNER_TOKEN is set', () => {
    process.env['LAIN_OWNER_TOKEN'] = 'the-token';
    expect(isOwner(mockReq({ cookie: '' }))).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
