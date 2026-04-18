/**
 * Onboard command - Interactive setup wizard
 */

import { mkdir, copyFile, access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { getPaths, createInitialConfig } from '../../config/index.js';
import { initDatabase } from '../../storage/database.js';
import { generateAuthToken } from '../../storage/keychain.js';
import {
  displayBanner,
  displaySuccess,
  displayError,
  displayInfo,
  displaySection,
  promptOnboard,
} from '../utils/prompts.js';

const MIN_NODE_VERSION = 22;

/**
 * Check Node.js version
 */
function checkNodeVersion(): { ok: boolean; version: string } {
  const version = process.versions.node;
  const major = parseInt(version.split('.')[0] ?? '0', 10);
  return {
    ok: major >= MIN_NODE_VERSION,
    version,
  };
}

/**
 * Create directory structure
 */
async function createDirectories(paths: ReturnType<typeof getPaths>): Promise<void> {
  const dirs = [
    paths.base,
    paths.workspace,
    paths.agents,
    paths.extensions,
    paths.credentials,
  ];

  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
  }
}

/**
 * Copy workspace files if they don't exist
 */
async function copyWorkspaceFiles(
  sourcePath: string,
  targetPath: string
): Promise<void> {
  const files = ['SOUL.md', 'AGENTS.md', 'IDENTITY.md'];

  for (const file of files) {
    const source = join(sourcePath, file);
    const target = join(targetPath, file);

    // Check if source exists
    try {
      await access(source, constants.R_OK);
    } catch {
      continue; // Skip if source doesn't exist
    }

    // Check if target already exists
    try {
      await access(target, constants.R_OK);
      displayInfo(`${file} already exists, skipping`);
    } catch {
      await copyFile(source, target);
      displaySuccess(`Copied ${file}`);
    }
  }
}

/**
 * Run the onboard command
 */
export async function onboard(): Promise<void> {
  displayBanner();

  // Check Node.js version
  displaySection('System Check');
  const nodeCheck = checkNodeVersion();
  if (!nodeCheck.ok) {
    displayError(`Node.js ${MIN_NODE_VERSION}+ required (found ${nodeCheck.version})`);
    process.exit(1);
  }
  displaySuccess(`Node.js ${nodeCheck.version}`);

  // Get paths
  const paths = getPaths();

  // Prompt user
  displaySection('Setup');
  const answers = await promptOnboard();

  if (!answers.confirmSetup) {
    displayInfo('Setup cancelled');
    return;
  }

  // Create directories
  displaySection('Creating Directories');
  try {
    await createDirectories(paths);
    displaySuccess(`Created ${paths.base}`);
  } catch (error) {
    displayError(`Failed to create directories: ${error}`);
    process.exit(1);
  }

  // Create config file
  displaySection('Configuration');
  try {
    await access(paths.config, constants.R_OK);
    displayInfo('Config file already exists');
  } catch {
    await createInitialConfig();
    displaySuccess('Created lain.json5');
  }

  // Copy workspace files
  displaySection('Workspace');
  const sourceWorkspace = join(process.cwd(), 'workspace');
  try {
    await copyWorkspaceFiles(sourceWorkspace, paths.workspace);
  } catch (error) {
    displayInfo(`Workspace files not copied: ${error}`);
  }

  // Initialize database
  displaySection('Database');
  try {
    await initDatabase();
    displaySuccess('Database initialized');
  } catch (error) {
    displayError(`Failed to initialize database: ${error}`);
    process.exit(1);
  }

  // Generate auth token
  if (answers.generateToken) {
    displaySection('Authentication');
    try {
      const token = await generateAuthToken();
      displaySuccess('Authentication token generated');
      displayInfo(`Token: ${token}`);
      displayInfo('Store this token securely - you will need it to connect');
    } catch (error) {
      displayError(`Failed to generate token: ${error}`);
      displayInfo('You can generate a token later with: lain token generate');
    }
  }

  // Done
  displaySection('Complete');
  displaySuccess('Lain is ready');
  console.log(`
Next steps:
  1. Configure your API key: export ANTHROPIC_API_KEY=your-key
  2. Start the gateway: lain gateway
  3. Check status: lain status
  4. Start chatting: lain chat
`);
}
