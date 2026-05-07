/**
 * Per-character interlink auth (findings.md P1:2289).
 *
 * Guards the end-to-end property: any process holding only the shared master
 * token previously could impersonate any character by setting body fields
 * like fromId / senderId. The new scheme derives per-character bearer tokens
 * from the master, sends the caller's id in X-Interlink-From, and verifies
 * that body-asserted identity matches the header-authenticated identity.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  deriveInterlinkToken,
  getInterlinkHeaders,
  verifyInterlinkRequest,
  assertBodyIdentity,
} from '../src/security/interlink-auth.js';

const MASTER = 'test-master-token';

function mockReq(headers: Record<string, string | string[] | undefined>) {
  return { headers };
}

describe('deriveInterlinkToken', () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env['LAIN_INTERLINK_TOKEN'];
    process.env['LAIN_INTERLINK_TOKEN'] = MASTER;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env['LAIN_INTERLINK_TOKEN'];
    else process.env['LAIN_INTERLINK_TOKEN'] = prev;
  });

  it('returns null when master token is missing', () => {
    delete process.env['LAIN_INTERLINK_TOKEN'];
    expect(deriveInterlinkToken('lain')).toBeNull();
  });

  it('returns null when master token is empty string', () => {
    process.env['LAIN_INTERLINK_TOKEN'] = '';
    expect(deriveInterlinkToken('lain')).toBeNull();
  });

  it('produces HMAC-SHA256 over "interlink:" + id, hex-encoded', () => {
    const expected = createHmac('sha256', MASTER).update('interlink:lain').digest('hex');
    expect(deriveInterlinkToken('lain')).toBe(expected);
  });

  it('is deterministic across invocations', () => {
    const a = deriveInterlinkToken('pkd');
    const b = deriveInterlinkToken('pkd');
    expect(a).toBe(b);
  });

  it('produces distinct tokens for distinct character ids', () => {
    const a = deriveInterlinkToken('lain');
    const b = deriveInterlinkToken('wired-lain');
    expect(a).not.toBe(b);
  });

  it('masterOverride takes precedence over env', () => {
    const other = createHmac('sha256', 'other-master').update('interlink:lain').digest('hex');
    expect(deriveInterlinkToken('lain', 'other-master')).toBe(other);
  });
});

describe('getInterlinkHeaders', () => {
  let prevId: string | undefined;
  let prevTok: string | undefined;
  beforeEach(() => {
    prevId = process.env['LAIN_CHARACTER_ID'];
    prevTok = process.env['LAIN_INTERLINK_TOKEN'];
    process.env['LAIN_CHARACTER_ID'] = 'lain';
    process.env['LAIN_INTERLINK_TOKEN'] = MASTER;
  });
  afterEach(() => {
    if (prevId === undefined) delete process.env['LAIN_CHARACTER_ID'];
    else process.env['LAIN_CHARACTER_ID'] = prevId;
    if (prevTok === undefined) delete process.env['LAIN_INTERLINK_TOKEN'];
    else process.env['LAIN_INTERLINK_TOKEN'] = prevTok;
  });

  it('returns null when LAIN_CHARACTER_ID is missing', () => {
    delete process.env['LAIN_CHARACTER_ID'];
    expect(getInterlinkHeaders()).toBeNull();
  });

  it('returns null when LAIN_INTERLINK_TOKEN is missing', () => {
    delete process.env['LAIN_INTERLINK_TOKEN'];
    expect(getInterlinkHeaders()).toBeNull();
  });

  it('sets X-Interlink-From to the caller id', () => {
    const h = getInterlinkHeaders();
    expect(h?.['X-Interlink-From']).toBe('lain');
  });

  it('Authorization is Bearer + derived token for the caller id', () => {
    const h = getInterlinkHeaders();
    const derived = deriveInterlinkToken('lain');
    expect(h?.Authorization).toBe(`Bearer ${derived}`);
  });

  it('sets Content-Type to application/json', () => {
    const h = getInterlinkHeaders();
    expect(h?.['Content-Type']).toBe('application/json');
  });

  it('honors ownIdOverride argument', () => {
    const h = getInterlinkHeaders('pkd');
    const derived = deriveInterlinkToken('pkd');
    expect(h?.['X-Interlink-From']).toBe('pkd');
    expect(h?.Authorization).toBe(`Bearer ${derived}`);
  });
});

describe('verifyInterlinkRequest', () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env['LAIN_INTERLINK_TOKEN'];
    process.env['LAIN_INTERLINK_TOKEN'] = MASTER;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env['LAIN_INTERLINK_TOKEN'];
    else process.env['LAIN_INTERLINK_TOKEN'] = prev;
  });

  it('returns 503 when master token is not configured', () => {
    delete process.env['LAIN_INTERLINK_TOKEN'];
    const res = verifyInterlinkRequest(mockReq({
      'x-interlink-from': 'lain',
      authorization: 'Bearer anything',
    }));
    expect(res).toEqual({ ok: false, status: 503, error: 'Interlink not configured' });
  });

  it('returns 401 when X-Interlink-From header is missing', () => {
    const res = verifyInterlinkRequest(mockReq({
      authorization: 'Bearer ' + deriveInterlinkToken('lain'),
    }));
    expect(res).toEqual({
      ok: false,
      status: 401,
      error: 'Missing X-Interlink-From header',
    });
  });

  it('returns 401 when Authorization header is missing', () => {
    const res = verifyInterlinkRequest(mockReq({ 'x-interlink-from': 'lain' }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(401);
      expect(res.error).toMatch(/Missing or invalid Authorization/);
    }
  });

  it('returns 401 when Authorization lacks the Bearer prefix', () => {
    const res = verifyInterlinkRequest(mockReq({
      'x-interlink-from': 'lain',
      authorization: 'Basic abc',
    }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(401);
  });

  it('returns 403 when the derived token does not match the header identity', () => {
    // Sender signs for "pkd" but header says "lain" — verifier re-derives for
    // "lain" and rejects. This is the core cross-character impersonation test.
    const pkdToken = deriveInterlinkToken('pkd')!;
    const res = verifyInterlinkRequest(mockReq({
      'x-interlink-from': 'lain',
      authorization: 'Bearer ' + pkdToken,
    }));
    expect(res).toEqual({
      ok: false,
      status: 403,
      error: 'Invalid interlink token',
    });
  });

  it('returns 403 when the raw master token is presented as bearer', () => {
    // A caller holding the master but not deriving per-character must fail.
    const res = verifyInterlinkRequest(mockReq({
      'x-interlink-from': 'lain',
      authorization: 'Bearer ' + MASTER,
    }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(403);
  });

  it('returns { ok, fromId } when a correctly-derived token matches the header', () => {
    const token = deriveInterlinkToken('lain')!;
    const res = verifyInterlinkRequest(mockReq({
      'x-interlink-from': 'lain',
      authorization: 'Bearer ' + token,
    }));
    expect(res).toEqual({ ok: true, fromId: 'lain' });
  });

  it('round-trips: getInterlinkHeaders() from one process is accepted by verifyInterlinkRequest', () => {
    const prevId = process.env['LAIN_CHARACTER_ID'];
    process.env['LAIN_CHARACTER_ID'] = 'wired-lain';
    try {
      const headers = getInterlinkHeaders();
      expect(headers).not.toBeNull();
      const res = verifyInterlinkRequest(mockReq({
        'x-interlink-from': headers!['X-Interlink-From'],
        authorization: headers!.Authorization,
      }));
      expect(res).toEqual({ ok: true, fromId: 'wired-lain' });
    } finally {
      if (prevId === undefined) delete process.env['LAIN_CHARACTER_ID'];
      else process.env['LAIN_CHARACTER_ID'] = prevId;
    }
  });
});

describe('assertBodyIdentity', () => {
  it('accepts when the body omits the identity field (undefined)', () => {
    expect(assertBodyIdentity('lain', undefined)).toEqual({ ok: true });
  });

  it('accepts when the body sets the identity field to null', () => {
    expect(assertBodyIdentity('lain', null)).toEqual({ ok: true });
  });

  it('accepts when the body sets the identity field to empty string', () => {
    expect(assertBodyIdentity('lain', '')).toEqual({ ok: true });
  });

  it('accepts when the body identity matches the authenticated id', () => {
    expect(assertBodyIdentity('lain', 'lain')).toEqual({ ok: true });
  });

  it('rejects when the body identity differs (cross-character impersonation)', () => {
    const res = assertBodyIdentity('lain', 'pkd');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toContain('"pkd"');
      expect(res.reason).toContain('"lain"');
    }
  });

  it('rejects when the body identity is a non-string type', () => {
    const res = assertBodyIdentity('lain', 42 as unknown);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/not a string/);
  });
});
