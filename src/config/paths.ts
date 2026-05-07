/**
 * Path resolution utilities for Lain configuration
 */

import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import type { ConfigPaths } from '../types/config.js';

const DEFAULT_HOME_DIR = '.newtown';
const CONFIG_FILE = 'newtown.json5';
const SOCKET_FILE = 'gateway.sock';
const PID_FILE = 'gateway.pid';
const DATABASE_FILE = 'newtown.db';

function getSocketPath(base: string): string {
  if (platform() !== 'win32') {
    return join(base, SOCKET_FILE);
  }

  const pipeName = base
    .replace(/[:\\\/]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();

  return `\\\\.\\pipe\\${pipeName}-${SOCKET_FILE}`;
}

/**
 * Get the base Lain directory path
 */
export function getBasePath(): string {
  return process.env['LAIN_HOME'] ?? process.env['NEWTOWN_HOME'] ?? join(homedir(), DEFAULT_HOME_DIR);
}

/**
 * Get all standard Lain paths
 */
export function getPaths(): ConfigPaths {
  const base = getBasePath();

  return {
    base,
    config: join(base, CONFIG_FILE),
    socket: getSocketPath(base),
    pidFile: join(base, PID_FILE),
    database: join(base, DATABASE_FILE),
    workspace: join(base, 'workspace'),
    agents: join(base, 'agents'),
    extensions: join(base, 'extensions'),
    credentials: join(base, 'credentials'),
  };
}

/**
 * Get path for a specific agent's data
 */
export function getAgentPath(agentId: string): string {
  const paths = getPaths();
  return join(paths.agents, agentId);
}

/**
 * Get path for agent sessions
 */
export function getAgentSessionsPath(agentId: string): string {
  return join(getAgentPath(agentId), 'sessions');
}

/**
 * Get path for agent transcripts
 */
export function getAgentTranscriptsPath(agentId: string): string {
  return join(getAgentPath(agentId), 'transcripts');
}
