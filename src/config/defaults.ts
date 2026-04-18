/**
 * Default configuration values for Newtown
 */

import type { LainConfig } from '../types/config.js';
import { getPaths } from './paths.js';

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
    agents: [
      {
        id: 'default',
        name: process.env['LAIN_CHARACTER_NAME'] || 'Newtown Guide',
        enabled: true,
        workspace: paths.workspace,
        providers: [
          {
            type: 'openai',
            model: process.env['OPENAI_MODEL'] || 'MiniMax-M2.7',
            apiKeyEnv: 'OPENAI_API_KEY',
            baseURL: process.env['OPENAI_BASE_URL'] || 'http://192.168.68.69:8080/v1',
          },
          {
            type: 'openai',
            model: process.env['OPENAI_MODEL'] || 'MiniMax-M2.7',
            apiKeyEnv: 'OPENAI_API_KEY',
            baseURL: process.env['OPENAI_BASE_URL'] || 'http://192.168.68.69:8080/v1',
          },
          {
            type: 'openai',
            model: process.env['OPENAI_MODEL'] || 'MiniMax-M2.7',
            apiKeyEnv: 'OPENAI_API_KEY',
            baseURL: process.env['OPENAI_BASE_URL'] || 'http://192.168.68.69:8080/v1',
          },
        ],
      },
    ],
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
  return `// Newtown Configuration
{
  "version": "1",

  // Gateway settings
  "gateway": {
    // Unix socket path for local communication
    // "socketPath": "~/.newtown/newtown.sock",

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

  // Agent configurations
  "agents": [
    {
      "id": "default",
      "name": "Newtown Guide",
      "enabled": true,
      // "workspace": "~/.newtown/workspace",
      // Providers by tier: [0]=personality, [1]=memory, [2]=light
      "providers": [
        {
          "type": "openai",
          "model": "MiniMax-M2.7",
          "apiKeyEnv": "OPENAI_API_KEY",
          "baseURL": "http://192.168.68.69:8080/v1"
        },
        {
          "type": "openai",
          "model": "MiniMax-M2.7",
          "apiKeyEnv": "OPENAI_API_KEY",
          "baseURL": "http://192.168.68.69:8080/v1"
        },
        {
          "type": "openai",
          "model": "MiniMax-M2.7",
          "apiKeyEnv": "OPENAI_API_KEY",
          "baseURL": "http://192.168.68.69:8080/v1"
        }
      ]
    }
  ],

  // Logging settings
  "logging": {
    "level": "info",
    "prettyPrint": true
    // "file": "~/.newtown/newtown.log"
  }
}
`;
}
