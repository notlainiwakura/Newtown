/**
 * Configuration tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadConfig,
  getDefaultConfig,
  resetConfig,
  validate,
} from '../src/config/index.js';

describe('Configuration', () => {
  const testDir = join(tmpdir(), 'lain-test-config');
  const originalEnv = process.env['LAIN_HOME'];

  beforeEach(async () => {
    process.env['LAIN_HOME'] = testDir;
    await mkdir(testDir, { recursive: true });
    resetConfig();
  });

  afterEach(async () => {
    if (originalEnv) {
      process.env['LAIN_HOME'] = originalEnv;
    } else {
      delete process.env['LAIN_HOME'];
    }
    try {
      await rm(testDir, { recursive: true });
    } catch {
      // Ignore
    }
  });

  describe('getDefaultConfig', () => {
    it('should return valid default configuration', () => {
      const config = getDefaultConfig();

      expect(config.version).toBe('1');
      expect(config.gateway).toBeDefined();
      expect(config.security).toBeDefined();
      expect(config.agents).toHaveLength(1);
      expect(config.logging).toBeDefined();
    });

    it('should use LAIN_HOME for paths', () => {
      const config = getDefaultConfig();

      expect(config.gateway.socketPath).toContain(testDir);
    });
  });

  describe('loadConfig', () => {
    it('should return defaults when no config file exists', async () => {
      const config = await loadConfig();

      expect(config.version).toBe('1');
      expect(config.agents).toHaveLength(1);
    });

    it('should load and merge config from file', async () => {
      const customConfig = {
        version: '1',
        logging: {
          level: 'debug',
          prettyPrint: false,
        },
      };

      await writeFile(
        join(testDir, 'lain.json5'),
        JSON.stringify(customConfig)
      );

      const config = await loadConfig();

      expect(config.logging.level).toBe('debug');
      expect(config.logging.prettyPrint).toBe(false);
      // Defaults should still be present
      expect(config.gateway).toBeDefined();
    });

    it('should throw on invalid config', async () => {
      const invalidConfig = {
        version: '1',
        security: {
          requireAuth: 'not-a-boolean', // Invalid type
        },
      };

      await writeFile(
        join(testDir, 'lain.json5'),
        JSON.stringify(invalidConfig)
      );

      await expect(loadConfig()).rejects.toThrow();
    });
  });

  describe('validate', () => {
    it('should validate correct config', () => {
      const config = getDefaultConfig();
      expect(() => validate(config)).not.toThrow();
    });

    it('should reject config with missing required fields', () => {
      const invalid = { version: '1' };
      expect(() => validate(invalid)).toThrow();
    });

    it('should reject config with invalid agent id', () => {
      const config = getDefaultConfig();
      config.agents[0]!.id = 'Invalid ID With Spaces';

      expect(() => validate(config)).toThrow();
    });
  });
});
