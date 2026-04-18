/**
 * Character commands â€” start Newtown resident server instances
 */

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCharacterServer, type CharacterConfig } from '../../web/character-server.js';
import { displayError } from '../utils/prompts.js';
import type { PeerConfig } from '../../agent/character-tools.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SRC_DIR = join(__dirname, '..', '..', '..');

function parsePeerConfig(): PeerConfig[] {
  const raw = process.env['PEER_CONFIG'];
  if (!raw) return [];
  try {
    return JSON.parse(raw) as PeerConfig[];
  } catch {
    console.warn('Warning: Could not parse PEER_CONFIG env var');
    return [];
  }
}

function buildCharacterConfig(
  id: string,
  name: string,
  port: number
): CharacterConfig {
  return {
    id,
    name,
    port,
    publicDir: join(SRC_DIR, 'src', 'web', 'public-character'),
    peers: parsePeerConfig(),
    // The game dashboard expects a possessable resident as the player avatar.
    possessable: id === 'joe',
  };
}

export async function startNeo(port: number = 3003): Promise<void> {
  try {
    await startCharacterServer(buildCharacterConfig('neo', 'Neo', port));
  } catch (error) {
    displayError(`Failed to start Neo server: ${error}`);
    process.exit(1);
  }
}

export async function startPlato(port: number = 3004): Promise<void> {
  try {
    await startCharacterServer(buildCharacterConfig('plato', 'Plato', port));
  } catch (error) {
    displayError(`Failed to start Plato server: ${error}`);
    process.exit(1);
  }
}

export async function startJoe(port: number = 3005): Promise<void> {
  try {
    await startCharacterServer(buildCharacterConfig('joe', 'Joe', port));
  } catch (error) {
    displayError(`Failed to start Joe server: ${error}`);
    process.exit(1);
  }
}

const CHARACTER_MAP: Record<string, (port: number) => Promise<void>> = {
  neo: startNeo,
  plato: startPlato,
  joe: startJoe,
};

export async function startCharacter(characterId: string, port: number): Promise<void> {
  const starter = CHARACTER_MAP[characterId];
  if (!starter) {
    displayError(`Unknown character: ${characterId}. Available: ${Object.keys(CHARACTER_MAP).join(', ')}`);
    process.exit(1);
  }
  await starter(port);
}
