/**
 * Cryptographic utilities
 */

import { randomBytes, createHash } from 'node:crypto';
import argon2 from 'argon2';
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
 * Derive an encryption key from a password using Argon2id
 */
export async function deriveKey(
  password: string,
  salt: Buffer,
  config: KeyDerivationConfig
): Promise<Buffer> {
  const hash = await argon2.hash(password, {
    type: argon2.argon2id,
    salt,
    memoryCost: config.memoryCost,
    timeCost: config.timeCost,
    parallelism: config.parallelism,
    hashLength: 32,
    raw: true,
  });
  return hash;
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
