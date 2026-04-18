/**
 * Gateway tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connect } from 'node:net';
import {
  configureRateLimiter,
  canConnect,
  canRequest,
  registerConnection,
  unregisterConnection,
  resetRateLimiter,
} from '../src/gateway/rate-limiter.js';
import { handleMessage, registerMethod, unregisterMethod } from '../src/gateway/router.js';
import type { GatewayMessage } from '../src/types/gateway.js';

describe('Rate Limiter', () => {
  beforeEach(() => {
    resetRateLimiter();
    configureRateLimiter({
      connectionsPerMinute: 5,
      requestsPerSecond: 3,
      burstSize: 5,
    });
  });

  afterEach(() => {
    resetRateLimiter();
  });

  describe('canConnect', () => {
    it('should allow connections within limit', () => {
      for (let i = 0; i < 5; i++) {
        const result = canConnect();
        expect(result.allowed).toBe(true);
      }
    });

    it('should reject connections over limit', () => {
      for (let i = 0; i < 5; i++) {
        canConnect();
      }

      const result = canConnect();
      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBeGreaterThan(0);
    });
  });

  describe('canRequest', () => {
    it('should allow requests within limit', () => {
      registerConnection('test-conn');

      for (let i = 0; i < 3; i++) {
        const result = canRequest('test-conn');
        expect(result.allowed).toBe(true);
      }
    });

    it('should reject requests over limit', () => {
      registerConnection('test-conn');

      for (let i = 0; i < 3; i++) {
        canRequest('test-conn');
      }

      const result = canRequest('test-conn');
      expect(result.allowed).toBe(false);
    });

    it('should reject requests for unknown connections', () => {
      const result = canRequest('unknown');
      expect(result.allowed).toBe(false);
    });
  });
});

describe('Message Router', () => {
  beforeEach(() => {
    // Register a test method
    registerMethod('testMethod', (_connId, params) => {
      return { received: params };
    });
  });

  afterEach(() => {
    unregisterMethod('testMethod');
  });

  describe('handleMessage', () => {
    it('should return error for invalid message id', async () => {
      const message = { method: 'ping' } as GatewayMessage;
      const response = await handleMessage('conn-1', message, false);

      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32600);
    });

    it('should return error for missing method', async () => {
      const message = { id: '1' } as GatewayMessage;
      const response = await handleMessage('conn-1', message, false);

      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32600);
    });

    it('should return error for unknown method', async () => {
      const message: GatewayMessage = {
        id: '1',
        method: 'unknownMethod',
      };
      const response = await handleMessage('conn-1', message, false);

      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32601);
    });

    it('should handle ping method', async () => {
      const message: GatewayMessage = {
        id: '1',
        method: 'ping',
      };
      const response = await handleMessage('conn-1', message, false);

      expect(response.error).toBeUndefined();
      expect(response.result).toHaveProperty('pong', true);
    });

    it('should handle echo method', async () => {
      const message: GatewayMessage = {
        id: '1',
        method: 'echo',
        params: { test: 'value' },
      };
      const response = await handleMessage('conn-1', message, false);

      expect(response.error).toBeUndefined();
      expect(response.result).toEqual({ echo: { test: 'value' } });
    });

    it('should handle custom registered methods', async () => {
      const message: GatewayMessage = {
        id: '1',
        method: 'testMethod',
        params: { foo: 'bar' },
      };
      const response = await handleMessage('conn-1', message, false);

      expect(response.error).toBeUndefined();
      expect(response.result).toEqual({ received: { foo: 'bar' } });
    });

    it('should require auth when configured', async () => {
      const message: GatewayMessage = {
        id: '1',
        method: 'ping',
      };
      const response = await handleMessage('conn-1', message, true);

      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32000); // Unauthorized
    });
  });
});
