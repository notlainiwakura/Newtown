#!/usr/bin/env tsx
/**
 * Quick setup script for Lain - non-interactive version
 */

import { mkdir, writeFile, copyFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { setAuthToken } from '../src/storage/keychain.js';
import { initDatabase } from '../src/storage/database.js';
import { generateSampleConfig } from '../src/config/defaults.js';

const LAIN_DIR = join(homedir(), '.lain');
const WORKSPACE_SRC = join(process.cwd(), 'workspace');

async function setup() {
  console.log('Setting up Lain...\n');

  // Create directories
  console.log('Creating directories...');
  await mkdir(LAIN_DIR, { recursive: true });
  await mkdir(join(LAIN_DIR, 'workspace'), { recursive: true });
  await mkdir(join(LAIN_DIR, 'agents'), { recursive: true });
  await mkdir(join(LAIN_DIR, 'extensions'), { recursive: true });
  await mkdir(join(LAIN_DIR, 'credentials'), { recursive: true });

  // Generate and store auth token
  console.log('Generating auth token...');
  const token = randomBytes(32).toString('hex');
  await setAuthToken(token);
  console.log(`Token stored in keychain`);

  // Copy workspace files
  console.log('Copying workspace files...');
  for (const file of ['SOUL.md', 'AGENTS.md', 'IDENTITY.md']) {
    try {
      await copyFile(
        join(WORKSPACE_SRC, file),
        join(LAIN_DIR, 'workspace', file)
      );
      console.log(`  Copied ${file}`);
    } catch {
      console.log(`  Skipped ${file} (not found)`);
    }
  }

  // Create config file if it doesn't exist
  const configPath = join(LAIN_DIR, 'lain.json5');
  try {
    await access(configPath);
    console.log('Config file already exists, skipping...');
  } catch {
    console.log('Creating config file...');
    await writeFile(configPath, generateSampleConfig());
  }

  // Initialize database
  console.log('Initializing database...');
  const dbPath = join(LAIN_DIR, 'lain.db');
  await initDatabase(dbPath, {
    algorithm: 'argon2id',
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
  });

  console.log('\n✓ Setup complete!\n');
  console.log('To start chatting with Lain:');
  console.log('  1. Set your ANTHROPIC_API_KEY environment variable');
  console.log('  2. Run: node dist/index.js gateway');
  console.log('  3. In another terminal: node dist/index.js chat');
}

setup().catch(console.error);
