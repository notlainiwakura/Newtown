/**
 * File-backed credential storage for local Newtown deployments.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { KeychainError } from '../utils/errors.js';
import { generateToken } from '../utils/crypto.js';
import { getPaths } from '../config/paths.js';

type CredentialMap = Record<string, string>;

const SERVICE_NAME = 'newtown';
const MASTER_KEY_ACCOUNT = 'master-key';
const AUTH_TOKEN_ACCOUNT = 'auth-token';

async function credentialsFile(): Promise<string> {
  return getPaths().credentials + '.json';
}

async function loadCredentialMap(): Promise<CredentialMap> {
  const path = await credentialsFile();
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as CredentialMap;
  } catch {
    return {};
  }
}

async function saveCredentialMap(data: CredentialMap): Promise<void> {
  const path = await credentialsFile();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2), 'utf-8');
}

async function setStoredValue(account: string, value: string): Promise<void> {
  try {
    const data = await loadCredentialMap();
    data[`${SERVICE_NAME}:${account}`] = value;
    await saveCredentialMap(data);
  } catch (error) {
    if (error instanceof Error) {
      throw new KeychainError(`Failed to store credential '${account}': ${error.message}`, error);
    }
    throw error;
  }
}

async function getStoredValue(account: string): Promise<string | null> {
  try {
    const data = await loadCredentialMap();
    return data[`${SERVICE_NAME}:${account}`] ?? null;
  } catch (error) {
    if (error instanceof Error) {
      throw new KeychainError(`Failed to read credential '${account}': ${error.message}`, error);
    }
    throw error;
  }
}

export async function getMasterKey(): Promise<string> {
  const envKey = process.env['LAIN_MASTER_KEY'];
  if (envKey) return envKey;

  let key = await getStoredValue(MASTER_KEY_ACCOUNT);
  if (!key) {
    key = generateToken(32);
    await setStoredValue(MASTER_KEY_ACCOUNT, key);
  }
  return key;
}

export async function setMasterKey(key: string): Promise<void> {
  await setStoredValue(MASTER_KEY_ACCOUNT, key);
}

export async function getAuthToken(): Promise<string | null> {
  return await getStoredValue(AUTH_TOKEN_ACCOUNT);
}

export async function setAuthToken(token: string): Promise<void> {
  await setStoredValue(AUTH_TOKEN_ACCOUNT, token);
}

export async function generateAuthToken(length = 32): Promise<string> {
  const token = generateToken(length);
  await setAuthToken(token);
  return token;
}

export async function deleteAuthToken(): Promise<boolean> {
  return await deleteCredential(AUTH_TOKEN_ACCOUNT);
}

export async function setCredential(account: string, value: string): Promise<void> {
  await setStoredValue(account, value);
}

export async function getCredential(account: string): Promise<string | null> {
  return await getStoredValue(account);
}

export async function deleteCredential(account: string): Promise<boolean> {
  try {
    const data = await loadCredentialMap();
    const key = `${SERVICE_NAME}:${account}`;
    const existed = key in data;
    delete data[key];
    await saveCredentialMap(data);
    return existed;
  } catch (error) {
    if (error instanceof Error) {
      throw new KeychainError(`Failed to delete credential '${account}': ${error.message}`, error);
    }
    throw error;
  }
}

export async function listCredentials(): Promise<Array<{ account: string }>> {
  const data = await loadCredentialMap();
  return Object.keys(data)
    .filter((key) => key.startsWith(`${SERVICE_NAME}:`))
    .map((key) => ({ account: key.slice(`${SERVICE_NAME}:`.length) }));
}
