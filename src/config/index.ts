/**
 * Configuration loader for Lain
 */

import { readFile, writeFile, mkdir, access, constants } from 'node:fs/promises';
import { dirname } from 'node:path';
import JSON5 from 'json5';
import type { LainConfig } from '../types/config.js';
import { ConfigError } from '../utils/errors.js';
import { getDefaultConfig, generateSampleConfig } from './defaults.js';
import { getPaths } from './paths.js';
import { validate } from './schema.js';

export { getPaths, getBasePath } from './paths.js';
export { getDefaultConfig, generateSampleConfig } from './defaults.js';
export { validate, getSchema } from './schema.js';

let cachedConfig: LainConfig | null = null;

/**
 * Load configuration from file, merging with defaults
 */
export async function loadConfig(configPath?: string): Promise<LainConfig> {
  const paths = getPaths();
  const path = configPath ?? paths.config;

  const defaults = getDefaultConfig();

  // Check if config file exists
  try {
    await access(path, constants.R_OK);
  } catch {
    // Config doesn't exist, return defaults
    cachedConfig = defaults;
    return defaults;
  }

  try {
    const content = await readFile(path, 'utf-8');
    const parsed = JSON5.parse(content) as Partial<LainConfig>;

    // Deep merge with defaults
    const merged = deepMerge(defaults, parsed);

    // Validate the merged config
    validate(merged);

    cachedConfig = merged;
    return merged;
  } catch (error) {
    if (error instanceof Error) {
      throw new ConfigError(`Failed to load config from ${path}: ${error.message}`, error);
    }
    throw error;
  }
}

/**
 * Get the cached configuration (must call loadConfig first)
 */
export function getConfig(): LainConfig {
  if (!cachedConfig) {
    throw new ConfigError('Configuration not loaded. Call loadConfig() first.');
  }
  return cachedConfig;
}

/**
 * Check if configuration has been loaded
 */
export function isConfigLoaded(): boolean {
  return cachedConfig !== null;
}

/**
 * Save configuration to file
 */
export async function saveConfig(config: LainConfig, configPath?: string): Promise<void> {
  const paths = getPaths();
  const path = configPath ?? paths.config;

  // Validate before saving
  validate(config);

  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON5.stringify(config, null, 2));
    cachedConfig = config;
  } catch (error) {
    if (error instanceof Error) {
      throw new ConfigError(`Failed to save config to ${path}: ${error.message}`, error);
    }
    throw error;
  }
}

/**
 * Create initial configuration file with sample content
 */
export async function createInitialConfig(configPath?: string): Promise<void> {
  const paths = getPaths();
  const path = configPath ?? paths.config;

  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, generateSampleConfig());
  } catch (error) {
    if (error instanceof Error) {
      throw new ConfigError(`Failed to create config at ${path}: ${error.message}`, error);
    }
    throw error;
  }
}

/**
 * Reset cached configuration
 */
export function resetConfig(): void {
  cachedConfig = null;
}

/**
 * Deep merge two objects
 */
function deepMerge(target: LainConfig, source: Partial<LainConfig>): LainConfig {
  const result = { ...target };

  for (const key of Object.keys(source) as Array<keyof LainConfig>) {
    const sourceValue = source[key];
    const targetValue = target[key];

    if (
      sourceValue !== undefined &&
      typeof sourceValue === 'object' &&
      sourceValue !== null &&
      !Array.isArray(sourceValue) &&
      typeof targetValue === 'object' &&
      targetValue !== null &&
      !Array.isArray(targetValue)
    ) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (result as any)[key] = deepMergeObject(
        targetValue as unknown as Record<string, unknown>,
        sourceValue as unknown as Record<string, unknown>
      );
    } else if (sourceValue !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (result as any)[key] = sourceValue;
    }
  }

  return result;
}

function deepMergeObject(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    const sourceValue = source[key];
    const targetValue = target[key];

    if (
      sourceValue !== undefined &&
      typeof sourceValue === 'object' &&
      sourceValue !== null &&
      !Array.isArray(sourceValue) &&
      typeof targetValue === 'object' &&
      targetValue !== null &&
      !Array.isArray(targetValue)
    ) {
      result[key] = deepMergeObject(
        targetValue as Record<string, unknown>,
        sourceValue as Record<string, unknown>
      );
    } else if (sourceValue !== undefined) {
      result[key] = sourceValue;
    }
  }

  return result;
}
