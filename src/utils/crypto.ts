/**
 * Cryptographic utilities
 */

import { randomBytes, createHash, pbkdf2Sync } from 'node:crypto';
import type { KeyDerivationConfig } from '../types/config.js';

const DEFAULT_TOKEN_LENGTH = 32;

/**
 * Generate a secure random token (hex encoded)
 */
export function generateToken(length: number = DEFAULT_TOKEN_LENGTH): string {
  return randomBytes(length).toString('hex');
}

/**
 * Generate a secure random bytes buffer
 */
export function generateRandomBytes(length: number): Buffer {
  return randomBytes(length);
}

/**
 * Derive an encryption key from a password.
 * We map the configured cost values onto PBKDF2 so Newtown remains portable
 * on machines where native Argon2 bindings are unavailable.
 */
export async function deriveKey(
  password: string,
  salt: Buffer,
  config: KeyDerivationConfig
): Promise<Buffer> {
  const iterations = Math.max(100_000, config.timeCost * config.parallelism * 120_000);
  return pbkdf2Sync(password, salt, iterations, 32, 'sha256');
}

/**
 * Hash a token for storage (one-way)
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Constant-time string comparison to prevent timing attacks
 */
export function secureCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Generate a salt for key derivation
 */
export function generateSalt(length: number = 16): Buffer {
  return randomBytes(length);
}
