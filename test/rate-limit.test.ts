/**
 * Shared rate limiter (findings.md P2:2494).
 *
 * Guards the property: character-server and doctor-server now share the
 * same per-IP cap semantics as the main server. Before this, a leaked
 * owner cookie or interlink token could burst those processes with no
 * throttle at all.
 */

import { describe, it, expect } from 'vitest';
import { createRateLimiter } from '../src/web/rate-limit.js';

describe('createRateLimiter (findings.md P2:2494)', () => {
  it('allows up to `max` requests per key in the window', () => {
    const rl = createRateLimiter({ max: 3, windowMs: 60_000 });
    expect(rl.check('ip-a')).toBe(true);
    expect(rl.check('ip-a')).toBe(true);
    expect(rl.check('ip-a')).toBe(true);
    expect(rl.check('ip-a')).toBe(false);
  });

  it('tracks distinct keys independently', () => {
    const rl = createRateLimiter({ max: 1, windowMs: 60_000 });
    expect(rl.check('ip-a')).toBe(true);
    expect(rl.check('ip-b')).toBe(true);
    expect(rl.check('ip-a')).toBe(false);
    expect(rl.check('ip-b')).toBe(false);
  });

  it('resets after the window elapses', async () => {
    const rl = createRateLimiter({ max: 1, windowMs: 30 });
    expect(rl.check('ip-a')).toBe(true);
    expect(rl.check('ip-a')).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(rl.check('ip-a')).toBe(true);
  });

  it('guard() writes a 429 JSON response when over cap', () => {
    const rl = createRateLimiter({ max: 1, windowMs: 60_000 });
    const mockReq = {
      socket: { remoteAddress: '203.0.113.7' },
      headers: {},
    } as unknown as import('node:http').IncomingMessage;
    let writeHeadCalls: Array<[number, unknown]> = [];
    let endPayload = '';
    const mockRes = {
      writeHead(code: number, headers: unknown) {
        writeHeadCalls.push([code, headers]);
        return this;
      },
      end(body: string) {
        endPayload = body;
      },
    } as unknown as import('node:http').ServerResponse;

    expect(rl.guard(mockReq, mockRes)).toBe(true);
    expect(writeHeadCalls).toEqual([]);
    expect(rl.guard(mockReq, mockRes)).toBe(false);
    expect(writeHeadCalls).toHaveLength(1);
    expect(writeHeadCalls[0]?.[0]).toBe(429);
    expect(JSON.parse(endPayload)).toEqual({ error: 'Too many requests' });
  });
});
