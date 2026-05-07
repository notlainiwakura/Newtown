/**
 * findings.md P2:195 — zod schemas on GatewayResponse methods.
 *
 * These tests verify three things:
 *   1. Every built-in method's schema accepts the shape its handler
 *      actually returns, and rejects the shapes that used to slip through
 *      `'key' in result` checks.
 *   2. `registerTypedMethod` validates handler output at send time and
 *      returns INTERNAL_ERROR rather than shipping malformed data.
 *   3. The auth result schema specifically rejects the P2:46 bug shape
 *      (`{ authenticated: false }`), which was the motivating incident.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';

vi.mock('../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../src/agent/index.js', () => ({
  processMessage: vi.fn(),
}));

import {
  AuthResultSchema,
  ChatResultSchema,
  EchoResultSchema,
  PingResultSchema,
  SetAgentResultSchema,
  StatusResultSchema,
  GatewayResultSchemas,
} from '../src/gateway/schemas.js';
import {
  handleMessage,
  registerTypedMethod,
  unregisterMethod,
} from '../src/gateway/router.js';
import { GatewayErrorCodes } from '../src/types/gateway.js';

describe('findings.md P2:195 — zod schemas for GatewayResponse', () => {
  describe('AuthResultSchema', () => {
    it('accepts the canonical success shape', () => {
      const ok = AuthResultSchema.safeParse({
        authenticated: true,
        connectionId: 'conn-1',
      });
      expect(ok.success).toBe(true);
    });

    it('rejects `{ authenticated: false }` — the P2:46 bug shape', () => {
      // Before P2:195, chat.ts used `'authenticated' in result`, which
      // matched `{ authenticated: false }` and silently entered chat mode.
      // The schema's `z.literal(true)` must refuse that payload.
      const bad = AuthResultSchema.safeParse({
        authenticated: false,
        connectionId: 'conn-1',
      });
      expect(bad.success).toBe(false);
    });

    it('rejects missing connectionId', () => {
      const bad = AuthResultSchema.safeParse({ authenticated: true });
      expect(bad.success).toBe(false);
    });
  });

  describe('PingResultSchema', () => {
    it('accepts { pong: true, timestamp }', () => {
      const ok = PingResultSchema.safeParse({ pong: true, timestamp: 1 });
      expect(ok.success).toBe(true);
    });

    it('rejects { pong: false } — stale handler sentinel', () => {
      const bad = PingResultSchema.safeParse({ pong: false, timestamp: 1 });
      expect(bad.success).toBe(false);
    });
  });

  describe('ChatResultSchema', () => {
    it('accepts response + sessionKey without tokenUsage', () => {
      const ok = ChatResultSchema.safeParse({
        response: 'hi',
        sessionKey: 'cli:u',
      });
      expect(ok.success).toBe(true);
    });

    it('accepts partial tokenUsage (mock agent shape)', () => {
      // The test mock in gateway-behavioral returns only { input, output };
      // production providers sometimes omit total too. All three fields
      // are optional per the schema.
      const ok = ChatResultSchema.safeParse({
        response: 'hi',
        sessionKey: 'cli:u',
        tokenUsage: { input: 10, output: 5 },
      });
      expect(ok.success).toBe(true);
    });

    it('rejects missing response field', () => {
      const bad = ChatResultSchema.safeParse({ sessionKey: 'cli:u' });
      expect(bad.success).toBe(false);
    });
  });

  describe('SetAgentResultSchema', () => {
    it('rejects { success: false } — avoid silent failure ack', () => {
      const bad = SetAgentResultSchema.safeParse({
        success: false,
        agentId: 'x',
      });
      expect(bad.success).toBe(false);
    });
  });

  describe('EchoResultSchema', () => {
    it('accepts any echo payload', () => {
      expect(EchoResultSchema.safeParse({ echo: { any: 'thing' } }).success).toBe(true);
      expect(EchoResultSchema.safeParse({ echo: 42 }).success).toBe(true);
      expect(EchoResultSchema.safeParse({ echo: undefined }).success).toBe(true);
    });
  });

  describe('StatusResultSchema', () => {
    it('requires all three fields with correct types', () => {
      expect(
        StatusResultSchema.safeParse({
          status: 'running',
          timestamp: 1,
          uptime: 2,
        }).success,
      ).toBe(true);
      expect(
        StatusResultSchema.safeParse({
          status: 'running',
          timestamp: '1',
          uptime: 2,
        }).success,
      ).toBe(false);
    });
  });

  describe('GatewayResultSchemas registry', () => {
    it('covers every built-in method name', () => {
      expect(Object.keys(GatewayResultSchemas).sort()).toEqual(
        ['auth', 'chat', 'echo', 'ping', 'setAgent', 'status'].sort(),
      );
    });
  });

  describe('registerTypedMethod validation at send time', () => {
    it('fails loudly when handler returns the wrong shape', async () => {
      registerTypedMethod(
        'driftTest',
        z.object({ ok: z.literal(true) }),
        () => ({ ok: false }) as unknown as { ok: true },
      );
      try {
        const resp = await handleMessage(
          'conn-1',
          { id: 'm1', method: 'driftTest' },
          false,
        );
        expect(resp.result).toBeUndefined();
        expect(resp.error?.code).toBe(GatewayErrorCodes.INTERNAL_ERROR);
        expect(resp.error?.message).toMatch(/does not match its schema/);
      } finally {
        unregisterMethod('driftTest');
      }
    });

    it('forwards the parsed result when shape is valid', async () => {
      registerTypedMethod(
        'okTest',
        z.object({ ok: z.literal(true), n: z.number() }),
        () => ({ ok: true, n: 7 }),
      );
      try {
        const resp = await handleMessage(
          'conn-1',
          { id: 'm1', method: 'okTest' },
          false,
        );
        expect(resp.error).toBeUndefined();
        expect(resp.result).toEqual({ ok: true, n: 7 });
      } finally {
        unregisterMethod('okTest');
      }
    });

    it('looks up built-in schema by method name when no schema passed', async () => {
      // ping's built-in schema is in GatewayResultSchemas. Using the
      // built-in name variant of registerTypedMethod must pull that.
      registerTypedMethod('ping', () => ({ pong: true, timestamp: 42 }));
      try {
        const resp = await handleMessage(
          'conn-1',
          { id: 'm1', method: 'ping' },
          false,
        );
        expect(resp.error).toBeUndefined();
        expect(resp.result).toEqual({ pong: true, timestamp: 42 });
      } finally {
        // Re-register the original built-in to restore state for other tests.
        registerTypedMethod('ping', () => ({
          pong: true,
          timestamp: Date.now(),
        }));
      }
    });
  });
});
