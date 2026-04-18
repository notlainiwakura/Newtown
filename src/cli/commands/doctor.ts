/**
 * Doctor command - Diagnose issues
 */

import { access, constants } from 'node:fs/promises';
import { loadConfig, getPaths } from '../../config/index.js';
import { initDatabase, closeDatabase } from '../../storage/database.js';
import { getMasterKey, getAuthToken } from '../../storage/keychain.js';
import {
  displaySection,
  displaySuccess,
  displayError,
  displayWarning,
} from '../utils/prompts.js';

interface DiagnosticResult {
  name: string;
  ok: boolean;
  message: string;
}

const MIN_NODE_VERSION = 22;

/**
 * Run all diagnostics
 */
export async function doctor(): Promise<void> {
  console.log('\nLain Diagnostics\n');

  const results: DiagnosticResult[] = [];

  // Node.js version
  displaySection('Runtime');
  results.push(await checkNodeVersion());

  // Configuration
  displaySection('Configuration');
  results.push(await checkConfigFile());
  results.push(await checkConfigValid());

  // Storage
  displaySection('Storage');
  results.push(await checkDatabase());
  results.push(await checkKeychain());
  results.push(await checkAuthToken());

  // Workspace
  displaySection('Workspace');
  results.push(await checkWorkspace());

  // Environment
  displaySection('Environment');
  results.push(checkApiKey());

  // Summary
  displaySection('Summary');
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;

  if (failed === 0) {
    displaySuccess(`All ${passed} checks passed`);
  } else {
    displayWarning(`${passed} passed, ${failed} failed`);
  }

  console.log('');

  // Exit with error code if any checks failed
  if (failed > 0) {
    process.exit(1);
  }
}

async function checkNodeVersion(): Promise<DiagnosticResult> {
  const version = process.versions.node;
  const major = parseInt(version.split('.')[0] ?? '0', 10);
  const ok = major >= MIN_NODE_VERSION;

  if (ok) {
    displaySuccess(`Node.js ${version}`);
  } else {
    displayError(`Node.js ${version} (requires ${MIN_NODE_VERSION}+)`);
  }

  return {
    name: 'Node.js version',
    ok,
    message: ok ? `v${version}` : `v${version} (requires ${MIN_NODE_VERSION}+)`,
  };
}

async function checkConfigFile(): Promise<DiagnosticResult> {
  const paths = getPaths();

  try {
    await access(paths.config, constants.R_OK);
    displaySuccess('Config file exists');
    return { name: 'Config file', ok: true, message: 'Found' };
  } catch {
    displayWarning('Config file not found (will use defaults)');
    return { name: 'Config file', ok: true, message: 'Not found, using defaults' };
  }
}

async function checkConfigValid(): Promise<DiagnosticResult> {
  try {
    await loadConfig();
    displaySuccess('Config is valid');
    return { name: 'Config validation', ok: true, message: 'Valid' };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    displayError(`Config invalid: ${message}`);
    return { name: 'Config validation', ok: false, message };
  }
}

async function checkDatabase(): Promise<DiagnosticResult> {
  const paths = getPaths();

  try {
    await initDatabase(paths.database);
    closeDatabase();
    displaySuccess('Database connection OK');
    return { name: 'Database', ok: true, message: 'Connected' };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    displayError(`Database error: ${message}`);
    return { name: 'Database', ok: false, message };
  }
}

async function checkKeychain(): Promise<DiagnosticResult> {
  try {
    await getMasterKey();
    displaySuccess('Keychain access OK');
    return { name: 'Keychain', ok: true, message: 'Accessible' };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    displayError(`Keychain error: ${message}`);
    return { name: 'Keychain', ok: false, message };
  }
}

async function checkAuthToken(): Promise<DiagnosticResult> {
  try {
    const token = await getAuthToken();
    if (token) {
      displaySuccess('Auth token configured');
      return { name: 'Auth token', ok: true, message: 'Configured' };
    } else {
      displayWarning('Auth token not set');
      return { name: 'Auth token', ok: true, message: 'Not set (run onboard)' };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    displayError(`Auth token error: ${message}`);
    return { name: 'Auth token', ok: false, message };
  }
}

async function checkWorkspace(): Promise<DiagnosticResult> {
  const paths = getPaths();
  const files = ['SOUL.md', 'AGENTS.md', 'IDENTITY.md'];
  const missing: string[] = [];

  for (const file of files) {
    try {
      await access(`${paths.workspace}/${file}`, constants.R_OK);
    } catch {
      missing.push(file);
    }
  }

  if (missing.length === 0) {
    displaySuccess('Workspace files present');
    return { name: 'Workspace', ok: true, message: 'All files present' };
  } else if (missing.length === files.length) {
    displayWarning('Workspace not initialized');
    return { name: 'Workspace', ok: true, message: 'Not initialized (run onboard)' };
  } else {
    displayWarning(`Missing: ${missing.join(', ')}`);
    return { name: 'Workspace', ok: false, message: `Missing: ${missing.join(', ')}` };
  }
}

function checkApiKey(): DiagnosticResult {
  const apiKey = process.env['ANTHROPIC_API_KEY'];

  if (apiKey) {
    displaySuccess('ANTHROPIC_API_KEY set');
    return { name: 'API Key', ok: true, message: 'Set' };
  } else {
    displayWarning('ANTHROPIC_API_KEY not set');
    return { name: 'API Key', ok: true, message: 'Not set (required for AI features)' };
  }
}
