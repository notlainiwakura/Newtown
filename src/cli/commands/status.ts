/**
 * Status command - Check gateway and system status
 */

import { access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, getPaths } from '../../config/index.js';
import { getServerPid, isProcessRunning } from '../../gateway/server.js';
import { getAuthToken } from '../../storage/keychain.js';
import { getManifestPath, getAllCharacters } from '../../config/characters.js';
import {
  displaySection,
  displayStatus,
  displayInfo,
} from '../utils/prompts.js';

/**
 * Check the status of Lain components
 */
export async function status(): Promise<void> {
  const paths = getPaths();

  // Gateway status
  displaySection('Gateway');

  const pid = await getServerPid(paths.pidFile);
  const running = pid ? isProcessRunning(pid) : false;

  displayStatus('Status', running ? 'Running' : 'Stopped', running);

  if (running && pid) {
    displayStatus('PID', pid.toString(), true);
  }

  displayStatus('Socket', paths.socket, true);

  // Configuration status
  displaySection('Configuration');

  let configExists = false;
  try {
    await access(paths.config, constants.R_OK);
    configExists = true;
  } catch {
    // Config doesn't exist
  }

  displayStatus('Config file', configExists ? 'Found' : 'Not found', configExists);
  displayStatus('Path', paths.config, true);

  if (configExists) {
    try {
      const config = await loadConfig();
      displayStatus('Version', config.version, true);
      displayStatus('Auth required', config.security.requireAuth ? 'Yes' : 'No', true);
      // findings.md P2:78 / P2:171 — characters.json is now the only source
      // for agent/character counts; the legacy `lain.json5 agents[]` field
      // has been removed.
      const manifestPath = getManifestPath();
      if (manifestPath) {
        const characters = getAllCharacters();
        displayStatus('Characters (manifest)', characters.length.toString(), true);
        displayStatus('Manifest', manifestPath, true);
      } else {
        displayStatus('Characters (manifest)', 'Not found — add characters.json', false);
      }
    } catch (error) {
      displayStatus('Parse', `Error: ${error}`, false);
    }
  }

  // Authentication status
  displaySection('Authentication');

  try {
    const token = await getAuthToken();
    displayStatus('Token', token ? 'Configured' : 'Not set', !!token);
  } catch (error) {
    displayStatus('Keychain', `Error: ${error}`, false);
  }

  // Database status
  displaySection('Database');

  let dbExists = false;
  try {
    await access(paths.database, constants.R_OK);
    dbExists = true;
  } catch {
    // DB doesn't exist
  }

  displayStatus('Database', dbExists ? 'Found' : 'Not initialized', dbExists);
  displayStatus('Path', paths.database, true);

  // Workspace status
  displaySection('Workspace');

  // findings.md P2:78 — when a characters.json is present, show each
  // character's `workspace/characters/<id>/` subdir status; the legacy
  // single-user `~/.lain/workspace/` layout only applies when no manifest
  // exists.
  const manifestPathForWorkspace = getManifestPath();
  if (manifestPathForWorkspace) {
    const characters = getAllCharacters();
    const files = ['SOUL.md', 'AGENTS.md', 'IDENTITY.md'];
    displayStatus('Layout', 'Multi-char town', true);
    for (const c of characters) {
      const base = join(process.cwd(), c.workspace);
      const missing: string[] = [];
      for (const f of files) {
        try {
          await access(join(base, f), constants.R_OK);
        } catch {
          missing.push(f);
        }
      }
      if (missing.length === 0) {
        displayStatus(`  ${c.id}`, 'OK', true);
      } else {
        displayStatus(`  ${c.id}`, `missing ${missing.join(', ')}`, false);
      }
    }
  } else {
    let workspaceExists = false;
    try {
      await access(paths.workspace, constants.R_OK);
      workspaceExists = true;
    } catch {
      // Workspace doesn't exist
    }

    displayStatus('Workspace', workspaceExists ? 'Found' : 'Not found', workspaceExists);
    displayStatus('Path', paths.workspace, true);

    if (workspaceExists) {
      const files = ['SOUL.md', 'AGENTS.md', 'IDENTITY.md'];
      for (const file of files) {
        try {
          await access(`${paths.workspace}/${file}`, constants.R_OK);
          displayStatus(`  ${file}`, 'Present', true);
        } catch {
          displayStatus(`  ${file}`, 'Missing', false);
        }
      }
    }
  }

  // Summary
  displaySection('Summary');

  if (!configExists) {
    displayInfo('Run "lain onboard" to set up Lain');
  } else if (!running) {
    displayInfo('Run "lain gateway" to start the gateway');
  } else {
    displayInfo('Lain is ready');
  }

  console.log('');
}
