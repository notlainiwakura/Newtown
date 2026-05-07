/**
 * Default configuration values for Lain
 */

import type { LainConfig, ProviderConfig } from '../types/config.js';
import { getPaths } from './paths.js';

/**
 * findings.md P2:171 — default three-tier provider chain. Exported so the
 * character manifest loader (`src/config/characters.ts`) can fall back to
 * this when a `CharacterManifestEntry` omits `providers`. Order maps to
 * tiers `['personality', 'memory', 'light']` in `src/agent/index.ts:183-194`.
 * [1] and [2] both default to Haiku 4.5 because the Anthropic 4.x lineup does
 * not currently offer a tier strictly cheaper than Haiku 4.5; operators who
 * want a cheaper background tier override [2] per-character in `characters.json`.
 */
export const DEFAULT_PROVIDERS: ProviderConfig[] = [
  {
    type: 'anthropic',
    model: 'claude-sonnet-4-6',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    fallbackModels: ['claude-sonnet-4-5-20241022', 'claude-sonnet-4-20250514', 'claude-sonnet-latest'],
  },
  {
    type: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    fallbackModels: ['claude-haiku-4-5-latest', 'claude-haiku-latest'],
  },
  {
    type: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    fallbackModels: ['claude-haiku-4-5-latest', 'claude-haiku-latest'],
  },
];

export function getDefaultConfig(): LainConfig {
  const paths = getPaths();

  return {
    version: '1',
    gateway: {
      socketPath: paths.socket,
      socketPermissions: 0o600,
      pidFile: paths.pidFile,
      rateLimit: {
        connectionsPerMinute: 60,
        requestsPerSecond: 10,
        burstSize: 20,
      },
    },
    security: {
      requireAuth: true,
      tokenLength: 32,
      inputSanitization: true,
      maxMessageLength: 100000,
      keyDerivation: {
        algorithm: 'argon2id',
        memoryCost: 65536, // 64 MiB
        timeCost: 3,
        parallelism: 4,
      },
    },
    logging: {
      level: 'info',
      prettyPrint: true,
    },
  };
}

/**
 * Generate a sample configuration file content with comments
 */
export function generateSampleConfig(): string {
  return `// Lain Configuration
// See documentation for full options: https://github.com/lain/lain#configuration
//
// findings.md P2:171 — agent/provider configuration lives in
// characters.json, not here. Each character entry may declare its own
// "providers" array (tiered [personality, memory, light]); omitting it
// uses the baked-in DEFAULT_PROVIDERS chain.
{
  "version": "1",

  // Gateway settings
  "gateway": {
    // Unix socket path for local communication
    // "socketPath": "~/.lain/gateway.sock",

    // Socket file permissions (octal)
    // "socketPermissions": 384, // 0600

    // Rate limiting
    "rateLimit": {
      "connectionsPerMinute": 60,
      "requestsPerSecond": 10,
      "burstSize": 20
    }
  },

  // Security settings
  "security": {
    // Require authentication for all connections
    "requireAuth": true,

    // Enable input sanitization (prompt injection defense)
    "inputSanitization": true,

    // Maximum message length in characters
    "maxMessageLength": 100000
  },

  // Logging settings
  "logging": {
    "level": "info",
    "prettyPrint": true
    // "file": "~/.lain/lain.log"
  }
}
`;
}
