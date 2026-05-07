/**
 * OS Keychain integration for secure credential storage
 */

import { existsSync } from 'node:fs';
import keytar from 'keytar';
import { KeychainError } from '../utils/errors.js';
import { generateToken } from '../utils/crypto.js';
import { getLogger } from '../utils/logger.js';

const SERVICE_NAME = 'lain';
const MASTER_KEY_ACCOUNT = 'master-key';
const AUTH_TOKEN_ACCOUNT = 'auth-token';

/**
 * Get the master key from the keychain, generating one if it doesn't exist.
 *
 * findings.md P2:383 — on a droplet rebuild the OS keychain can be wiped
 * while an existing encrypted `lain.db` remains on disk. Silently
 * generating a fresh master key in that situation orphans the old DB
 * forever. When `dbPath` is supplied and a file exists at that path but
 * the keychain has no key, this refuses and throws a loud KeychainError
 * that points the operator at the recovery path (`LAIN_MASTER_KEY` env
 * var or a restored keychain). Fresh-install generation still works —
 * it just warn-logs so operators have an audit trail.
 */
export async function getMasterKey(dbPath?: string): Promise<string> {
  // Allow env var override for headless servers without a keyring
  const envKey = process.env['LAIN_MASTER_KEY'];
  if (envKey) return envKey;

  try {
    let key = await keytar.getPassword(SERVICE_NAME, MASTER_KEY_ACCOUNT);

    if (!key) {
      const logger = getLogger();
      if (dbPath && existsSync(dbPath)) {
        // Existing encrypted DB + missing keychain entry = almost
        // certainly a lost keychain, not a fresh install. Generating
        // a new key here would leave the old DB un-decryptable forever.
        const msg =
          `Master key missing from OS keychain but existing database found at ${dbPath}. ` +
          `This looks like a lost keychain after a rebuild — generating a fresh key would orphan the DB. ` +
          `Recovery options: ` +
          `1) restore the keychain from backup, ` +
          `2) set LAIN_MASTER_KEY env var to the original master key, or ` +
          `3) if the DB is expendable, delete ${dbPath} (and its .bak / salt sidecars) and restart to let a new install generate fresh credentials.`;
        logger.error({ dbPath }, msg);
        throw new KeychainError(msg);
      }
      logger.warn(
        { dbPath: dbPath ?? '(not provided)' },
        'No master key found in OS keychain; generating a new one. ' +
        'If this is not a fresh install, your old encrypted database will be un-decryptable with the new key.',
      );
      key = generateToken(32);
      await keytar.setPassword(SERVICE_NAME, MASTER_KEY_ACCOUNT, key);
    }

    return key;
  } catch (error) {
    if (error instanceof KeychainError) throw error;
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
