/**
 * X-Forwarded-For trust (findings.md P2:2446).
 *
 * Guards the property: a direct attacker cannot rotate their rate-limit key
 * by spoofing X-Forwarded-For. Without an allowlist, any client that can
 * reach the server directly could send `X-Forwarded-For: 1.2.3.<random>`
 * per request and trivially bypass the 30-requests-per-minute cap on
 * /api/chat and /api/chat/stream.
 *
 * getClientIp only trusts XFF when the direct peer (req.socket.remoteAddress)
 * is loopback OR appears in LAIN_TRUSTED_PROXIES.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getClientIp } from '../src/web/server.js';

function mockReq(remoteAddress: string | undefined, xff?: string | string[]): import('node:http').IncomingMessage {
  return {
    socket: { remoteAddress },
    headers: xff !== undefined ? { 'x-forwarded-for': xff } : {},
  } as unknown as import('node:http').IncomingMessage;
}

describe('getClientIp — X-Forwarded-For trust (findings.md P2:2446)', () => {
  let prevTrusted: string | undefined;
  beforeEach(() => {
    prevTrusted = process.env['LAIN_TRUSTED_PROXIES'];
    delete process.env['LAIN_TRUSTED_PROXIES'];
  });
  afterEach(() => {
    if (prevTrusted === undefined) delete process.env['LAIN_TRUSTED_PROXIES'];
    else process.env['LAIN_TRUSTED_PROXIES'] = prevTrusted;
  });

  it('ignores XFF from an untrusted direct peer (the rate-limit-bypass case)', () => {
    // Attacker connects directly from 203.0.113.7 and claims to be behind a
    // proxy as 1.2.3.4. Pre-fix: we keyed on 1.2.3.4 and they rotated per-request.
    const req = mockReq('203.0.113.7', '1.2.3.4');
    expect(getClientIp(req)).toBe('203.0.113.7');
  });

  it('honors XFF when the direct peer is loopback IPv4', () => {
    const req = mockReq('127.0.0.1', '198.51.100.9');
    expect(getClientIp(req)).toBe('198.51.100.9');
  });

  it('honors XFF when the direct peer is loopback IPv6', () => {
    const req = mockReq('::1', '198.51.100.9');
    expect(getClientIp(req)).toBe('198.51.100.9');
  });

  it('honors XFF when the direct peer is loopback IPv4 mapped as IPv6', () => {
    const req = mockReq('::ffff:127.0.0.1', '198.51.100.9');
    expect(getClientIp(req)).toBe('198.51.100.9');
  });

  it('returns the first XFF entry when the header contains a chain', () => {
    // RFC 7239 convention: client, proxy1, proxy2 — leftmost is the original.
    const req = mockReq('127.0.0.1', '198.51.100.9, 10.0.0.1, 10.0.0.2');
    expect(getClientIp(req)).toBe('198.51.100.9');
  });

  it('falls through to remoteAddress when XFF header is present but empty', () => {
    const req = mockReq('127.0.0.1', '');
    expect(getClientIp(req)).toBe('127.0.0.1');
  });

  it('honors LAIN_TRUSTED_PROXIES for a non-loopback reverse proxy', () => {
    process.env['LAIN_TRUSTED_PROXIES'] = '10.0.0.1, 10.0.0.2';
    const req = mockReq('10.0.0.1', '198.51.100.9');
    expect(getClientIp(req)).toBe('198.51.100.9');
  });

  it('does not honor XFF for a non-loopback peer NOT in LAIN_TRUSTED_PROXIES', () => {
    process.env['LAIN_TRUSTED_PROXIES'] = '10.0.0.1';
    const req = mockReq('10.0.0.99', '198.51.100.9');
    expect(getClientIp(req)).toBe('10.0.0.99');
  });

  it('returns "unknown" when there is no remoteAddress and XFF is untrusted', () => {
    const req = mockReq(undefined, '198.51.100.9');
    expect(getClientIp(req)).toBe('unknown');
  });

  it('handles XFF delivered as an array (node multi-header form)', () => {
    const req = mockReq('127.0.0.1', ['198.51.100.9, 10.0.0.1']);
    expect(getClientIp(req)).toBe('198.51.100.9');
  });

  it('trims whitespace around the first XFF entry', () => {
    const req = mockReq('127.0.0.1', '   198.51.100.9  , 10.0.0.1');
    expect(getClientIp(req)).toBe('198.51.100.9');
  });
});
