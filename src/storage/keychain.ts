/**
 * OS Keychain integration for secure credential storage
 */

import keytar from 'keytar';
import { KeychainError } from '../utils/errors.js';
import { generateToken } from '../utils/crypto.js';

const SERVICE_NAME = 'lain';
const MASTER_KEY_ACCOUNT = 'master-key';
const AUTH_TOKEN_ACCOUNT = 'auth-token';

/**
 * Get the master key from the keychain, generating one if it doesn't exist
 */
export async function getMasterKey(): Promise<string> {
  // Allow env var override for headless servers without a keyring
  const envKey = process.env['LAIN_MASTER_KEY'];
  if (envKey) return envKey;

  try {
    let key = await keytar.getPassword(SERVICE_NAME, MASTER_KEY_ACCOUNT);

    if (!key) {
      // Generate a new master key
      key = generateToken(32);
      await keytar.setPassword(SERVICE_NAME, MASTER_KEY_ACCOUNT, key);
    }

    return key;
  } catch (error) {
    if (error instanceof Error) {
      throw new KeychainError(`Failed to access master key: ${error.message}`, error);
    }
    throw error;
  }
}

/**
 * Set a new master key (used for testing or recovery)
 */
export async function setMasterKey(key: string): Promise<void> {
  try {
    await keytar.setPassword(SERVICE_NAME, MASTER_KEY_ACCOUNT, key);
  } catch (error) {
    if (error instanceof Error) {
      throw new KeychainError(`Failed to set master key: ${error.message}`, error);
    }
    throw error;
  }
}

/**
 * Get the authentication token from the keychain
 */
export async function getAuthToken(): Promise<string | null> {
  try {
    return await keytar.getPassword(SERVICE_NAME, AUTH_TOKEN_ACCOUNT);
  } catch (error) {
    if (error instanceof Error) {
      throw new KeychainError(`Failed to access auth token: ${error.message}`, error);
    }
    throw error;
  }
}

/**
 * Set or update the authentication token
 */
export async function setAuthToken(token: string): Promise<void> {
  try {
    await keytar.setPassword(SERVICE_NAME, AUTH_TOKEN_ACCOUNT, token);
  } catch (error) {
    if (error instanceof Error) {
      throw new KeychainError(`Failed to set auth token: ${error.message}`, error);
    }
    throw error;
  }
}

/**
 * Generate and store a new authentication token
 */
export async function generateAuthToken(length: number = 32): Promise<string> {
  const token = generateToken(length);
  await setAuthToken(token);
  return token;
}

/**
 * Delete the authentication token
 */
export async function deleteAuthToken(): Promise<boolean> {
  try {
    return await keytar.deletePassword(SERVICE_NAME, AUTH_TOKEN_ACCOUNT);
  } catch (error) {
    if (error instanceof Error) {
      throw new KeychainError(`Failed to delete auth token: ${error.message}`, error);
    }
    throw error;
  }
}

/**
 * Store a custom credential
 */
export async function setCredential(account: string, value: string): Promise<void> {
  try {
    await keytar.setPassword(SERVICE_NAME, account, value);
  } catch (error) {
    if (error instanceof Error) {
      throw new KeychainError(`Failed to set credential '${account}': ${error.message}`, error);
    }
    throw error;
  }
}

/**
 * Retrieve a custom credential
 */
export async function getCredential(account: string): Promise<string | null> {
  try {
    return await keytar.getPassword(SERVICE_NAME, account);
  } catch (error) {
    if (error instanceof Error) {
      throw new KeychainError(`Failed to get credential '${account}': ${error.message}`, error);
    }
    throw error;
  }
}

/**
 * Delete a custom credential
 */
export async function deleteCredential(account: string): Promise<boolean> {
  try {
    return await keytar.deletePassword(SERVICE_NAME, account);
  } catch (error) {
    if (error instanceof Error) {
      throw new KeychainError(`Failed to delete credential '${account}': ${error.message}`, error);
    }
    throw error;
  }
}

/**
 * List all Lain credentials in the keychain
 */
export async function listCredentials(): Promise<Array<{ account: string }>> {
  try {
    const credentials = await keytar.findCredentials(SERVICE_NAME);
    return credentials.map((c) => ({ account: c.account }));
  } catch (error) {
    if (error instanceof Error) {
      throw new KeychainError(`Failed to list credentials: ${error.message}`, error);
    }
    throw error;
  }
}
