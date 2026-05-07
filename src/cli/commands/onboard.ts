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

  // findings.md P2:78 — when a characters.json exists, the source workspace
  // directory no longer contains top-level SOUL.md/AGENTS.md/IDENTITY.md —
  // those files live under `workspace/characters/<id>/`. The old
  // copyWorkspaceFiles() silently skipped every file and then reported
  // "Lain is ready", leaving the target workspace empty. Detect the
  // multi-char layout and point the operator at the real setup path
  // instead of claiming success on an empty copy.
  const { getManifestPath, getAllCharacters } = await import('../../config/characters.js');
  const manifestPath = getManifestPath();
  if (manifestPath) {
    const characters = getAllCharacters();
    displayInfo(`Multi-char town detected (${manifestPath}, ${characters.length} characters).`);
    displayInfo(
      'Workspace files live under workspace/characters/<id>/ per character. ' +
        'Edit characters.json and create SOUL.md/AGENTS.md/IDENTITY.md under the matching workspace/ subdir. See SETUP.md.',
    );
  } else {
    const sourceWorkspace = join(process.cwd(), 'workspace');
    try {
      await copyWorkspaceFiles(sourceWorkspace, paths.workspace);
    } catch (error) {
      displayInfo(`Workspace files not copied: ${error}`);
    }
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
      // findings.md P2:105 — the previous guidance pointed at a
      // `lain token generate` subcommand that does not exist. Onboard is
      // the only code path that generates the auth token, so direct the
      // user back here once the keychain is accessible again.
      displayError(`Failed to generate token: ${error}`);
      displayInfo(
        'Check keychain access (macOS: unlock login keychain; Linux: start libsecret/gnome-keyring) and re-run `lain onboard`.',
      );
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
