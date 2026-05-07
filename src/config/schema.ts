/**
 * JSON Schema validation for Lain configuration
 */

import Ajv, { type JSONSchemaType, type ErrorObject } from 'ajv';
import type { LainConfig } from '../types/config.js';
import { ValidationError } from '../utils/errors.js';

const configSchema: JSONSchemaType<LainConfig> = {
  type: 'object',
  properties: {
    version: { type: 'string' },
    gateway: {
      type: 'object',
      properties: {
        socketPath: { type: 'string' },
        socketPermissions: { type: 'number' },
        pidFile: { type: 'string' },
        rateLimit: {
          type: 'object',
          properties: {
            connectionsPerMinute: { type: 'number', minimum: 1 },
            requestsPerSecond: { type: 'number', minimum: 1 },
            burstSize: { type: 'number', minimum: 1 },
          },
          required: ['connectionsPerMinute', 'requestsPerSecond', 'burstSize'],
          additionalProperties: false,
        },
      },
      required: ['socketPath', 'socketPermissions', 'pidFile', 'rateLimit'],
      additionalProperties: false,
    },
    security: {
      type: 'object',
      properties: {
        requireAuth: { type: 'boolean' },
        tokenLength: { type: 'number', minimum: 16 },
        inputSanitization: { type: 'boolean' },
        maxMessageLength: { type: 'number', minimum: 1 },
        keyDerivation: {
          type: 'object',
          properties: {
            algorithm: { type: 'string', const: 'argon2id' },
            memoryCost: { type: 'number', minimum: 1024 },
            timeCost: { type: 'number', minimum: 1 },
            parallelism: { type: 'number', minimum: 1 },
          },
          required: ['algorithm', 'memoryCost', 'timeCost', 'parallelism'],
          additionalProperties: false,
        },
      },
      required: [
        'requireAuth',
        'tokenLength',
        'inputSanitization',
        'maxMessageLength',
        'keyDerivation',
      ],
      additionalProperties: false,
    },
    logging: {
      type: 'object',
      properties: {
        level: {
          type: 'string',
          enum: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'],
        },
        prettyPrint: { type: 'boolean' },
        file: { type: 'string', nullable: true },
      },
      required: ['level', 'prettyPrint'],
      additionalProperties: false,
    },
  },
  required: ['version', 'gateway', 'security', 'logging'],
  additionalProperties: false,
};

const ajv = new Ajv.default({ allErrors: true, verbose: true });
const validateConfig = ajv.compile(configSchema);

/**
 * Validate a configuration object against the schema
 */
export function validate(config: unknown): config is LainConfig {
  const valid = validateConfig(config);

  if (!valid && validateConfig.errors) {
    const errors = validateConfig.errors.map((err: ErrorObject) => {
      const path = err.instancePath || '/';
      return `${path}: ${err.message ?? 'unknown error'}`;
    });
    throw new ValidationError('Invalid configuration', errors);
  }

  return true;
}

/**
 * Get schema for documentation purposes
 */
export function getSchema(): JSONSchemaType<LainConfig> {
  return configSchema;
}
