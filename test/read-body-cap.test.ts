/**
 * readBody size-cap tests for character-server.ts.
 *
 * Regression guard: without a cap, a single large POST OOMs the inhabitant
 * process. server.ts already enforces a 1 MB cap via collectBody; this test
 * ensures character-server's readBody has been backported to the same cap.
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';

vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn().mockResolvedValue('test-master-key'),
    setPassword: vi.fn().mockResolvedValue(undefined),
    deletePassword: vi.fn().mockResolvedValue(true),
    findCredentials: vi.fn().mockResolvedValue([]),
  },
}));

import { readBody, MAX_BODY_BYTES } from '../src/web/character-server.js';

function mockReq(): IncomingMessage & { destroy: () => void; destroyed?: boolean } {
  const req = new EventEmitter() as unknown as IncomingMessage & { destroy: () => void; destroyed?: boolean };
  req.destroy = vi.fn(() => { (req as { destroyed?: boolean }).destroyed = true; });
  return req;
}

describe('character-server readBody', () => {
  it('exports a body-size cap', () => {
    expect(typeof MAX_BODY_BYTES).toBe('number');
    expect(MAX_BODY_BYTES).toBeGreaterThan(0);
  });

  it('resolves with the body when under the cap', async () => {
    const req = mockReq();
    const p = readBody(req);
    setImmediate(() => {
      req.emit('data', Buffer.from('hello'));
      req.emit('end');
    });
    await expect(p).resolves.toBe('hello');
  });

  it('rejects and destroys the request when body exceeds the cap', async () => {
    const req = mockReq();
    const p = readBody(req);
    setImmediate(() => {
      const oversized = Buffer.alloc(MAX_BODY_BYTES + 1, 'a');
      req.emit('data', oversized);
    });
    await expect(p).rejects.toThrow(/PAYLOAD_TOO_LARGE|too large/i);
    expect(req.destroy).toHaveBeenCalled();
  });

  it('rejects when cumulative chunks exceed the cap', async () => {
    const req = mockReq();
    const p = readBody(req);
    const chunk = Buffer.alloc(Math.floor(MAX_BODY_BYTES / 2) + 1, 'b');
    setImmediate(() => {
      req.emit('data', chunk);
      req.emit('data', chunk);
    });
    await expect(p).rejects.toThrow(/PAYLOAD_TOO_LARGE|too large/i);
  });
});
