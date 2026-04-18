/**
 * Plugin loader for extensible functionality
 */

import { readdir, readFile, access, constants } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getLogger } from '../utils/logger.js';
import type { Tool } from '../agent/tools.js';
import { registerTool, unregisterTool } from '../agent/tools.js';

export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  main: string;
  tools?: string[];
  hooks?: string[];
}

export interface PluginHooks {
  onMessage?: (message: unknown) => Promise<unknown>;
  onResponse?: (response: unknown) => Promise<unknown>;
  onStart?: () => Promise<void>;
  onStop?: () => Promise<void>;
}

export interface Plugin {
  manifest: PluginManifest;
  tools: Tool[];
  hooks: PluginHooks;
  enabled: boolean;
}

const plugins = new Map<string, Plugin>();

/**
 * Load a plugin from a directory
 */
export async function loadPlugin(pluginPath: string): Promise<Plugin> {
  const logger = getLogger();
  const name = basename(pluginPath);

  logger.info({ pluginPath, name }, 'Loading plugin');

  // Read manifest
  const manifestPath = join(pluginPath, 'manifest.json');
  try {
    await access(manifestPath, constants.R_OK);
  } catch {
    throw new Error(`Plugin manifest not found: ${manifestPath}`);
  }

  const manifestContent = await readFile(manifestPath, 'utf-8');
  const manifest = JSON.parse(manifestContent) as PluginManifest;

  // Validate manifest
  if (!manifest.name || !manifest.version || !manifest.main) {
    throw new Error(`Invalid plugin manifest: missing required fields`);
  }

  // Load main module
  const mainPath = join(pluginPath, manifest.main);
  const mainUrl = pathToFileURL(mainPath).href;

  let module: unknown;
  try {
    module = await import(mainUrl);
  } catch (error) {
    throw new Error(
      `Failed to load plugin module: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const mod = module as Record<string, unknown>;

  // Extract tools
  const tools: Tool[] = [];
  if (manifest.tools) {
    for (const toolName of manifest.tools) {
      const tool = mod[toolName];
      if (tool && typeof tool === 'object' && 'definition' in tool && 'handler' in tool) {
        tools.push(tool as Tool);
      } else {
        logger.warn({ pluginName: manifest.name, toolName }, 'Tool not found or invalid');
      }
    }
  }

  // Extract hooks
  const hooks: PluginHooks = {};
  if (typeof mod.onMessage === 'function') {
    hooks.onMessage = mod.onMessage as (message: unknown) => Promise<unknown>;
  }
  if (typeof mod.onResponse === 'function') {
    hooks.onResponse = mod.onResponse as (response: unknown) => Promise<unknown>;
  }
  if (typeof mod.onStart === 'function') {
    hooks.onStart = mod.onStart as () => Promise<void>;
  }
  if (typeof mod.onStop === 'function') {
    hooks.onStop = mod.onStop as () => Promise<void>;
  }

  const plugin: Plugin = {
    manifest,
    tools,
    hooks,
    enabled: false,
  };

  plugins.set(manifest.name, plugin);
  logger.info({ pluginName: manifest.name, toolCount: tools.length }, 'Plugin loaded');

  return plugin;
}

/**
 * Enable a plugin (register its tools)
 */
export async function enablePlugin(name: string): Promise<void> {
  const logger = getLogger();
  const plugin = plugins.get(name);

  if (!plugin) {
    throw new Error(`Plugin not found: ${name}`);
  }

  if (plugin.enabled) {
    logger.warn({ pluginName: name }, 'Plugin already enabled');
    return;
  }

  // Register tools
  for (const tool of plugin.tools) {
    registerTool(tool);
  }

  // Call onStart hook
  if (plugin.hooks.onStart) {
    await plugin.hooks.onStart();
  }

  plugin.enabled = true;
  logger.info({ pluginName: name }, 'Plugin enabled');
}

/**
 * Disable a plugin (unregister its tools)
 */
export async function disablePlugin(name: string): Promise<void> {
  const logger = getLogger();
  const plugin = plugins.get(name);

  if (!plugin) {
    throw new Error(`Plugin not found: ${name}`);
  }

  if (!plugin.enabled) {
    logger.warn({ pluginName: name }, 'Plugin already disabled');
    return;
  }

  // Call onStop hook
  if (plugin.hooks.onStop) {
    await plugin.hooks.onStop();
  }

  // Unregister tools
  for (const tool of plugin.tools) {
    unregisterTool(tool.definition.name);
  }

  plugin.enabled = false;
  logger.info({ pluginName: name }, 'Plugin disabled');
}

/**
 * Load all plugins from a directory
 */
export async function loadPluginsFromDirectory(pluginsDir: string): Promise<Plugin[]> {
  const logger = getLogger();
  const loaded: Plugin[] = [];

  try {
    const entries = await readdir(pluginsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const pluginPath = join(pluginsDir, entry.name);

      try {
        const plugin = await loadPlugin(pluginPath);
        loaded.push(plugin);
      } catch (error) {
        logger.error(
          { pluginPath, error },
          'Failed to load plugin'
        );
      }
    }
  } catch (error) {
    logger.warn({ pluginsDir, error }, 'Failed to read plugins directory');
  }

  return loaded;
}

/**
 * Get a loaded plugin by name
 */
export function getPlugin(name: string): Plugin | undefined {
  return plugins.get(name);
}

/**
 * Get all loaded plugins
 */
export function getAllPlugins(): Plugin[] {
  return Array.from(plugins.values());
}

/**
 * Get all enabled plugins
 */
export function getEnabledPlugins(): Plugin[] {
  return Array.from(plugins.values()).filter((p) => p.enabled);
}

/**
 * Unload a plugin completely
 */
export async function unloadPlugin(name: string): Promise<void> {
  const logger = getLogger();
  const plugin = plugins.get(name);

  if (!plugin) {
    return;
  }

  // Disable first if enabled
  if (plugin.enabled) {
    await disablePlugin(name);
  }

  plugins.delete(name);
  logger.info({ pluginName: name }, 'Plugin unloaded');
}

/**
 * Run message hooks for all enabled plugins
 */
export async function runMessageHooks(message: unknown): Promise<unknown> {
  let result = message;

  for (const plugin of getEnabledPlugins()) {
    if (plugin.hooks.onMessage) {
      result = await plugin.hooks.onMessage(result);
    }
  }

  return result;
}

/**
 * Run response hooks for all enabled plugins
 */
export async function runResponseHooks(response: unknown): Promise<unknown> {
  let result = response;

  for (const plugin of getEnabledPlugins()) {
    if (plugin.hooks.onResponse) {
      result = await plugin.hooks.onResponse(result);
    }
  }

  return result;
}
