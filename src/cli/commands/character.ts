/**
 * Character commands — Start character server instances from manifest
 */

import { startCharacterServer, type CharacterConfig } from '../../web/character-server.js';
import { displayError } from '../utils/prompts.js';
import { getCharacterEntry, getPeersFor } from '../../config/characters.js';
import type { PeerConfig } from '../../agent/character-tools.js';

export function parsePeerConfig(characterId: string): PeerConfig[] {
  const raw = process.env['PEER_CONFIG'];
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      const validated = validatePeerConfigShape(parsed);
      if (validated) return validated;
      // findings.md P2:66 — previously `JSON.parse(raw) as PeerConfig[]`
      // silently handed malformed env to downstream loops, which then
      // crashed in startDesireLoop / startCommuneLoop with opaque
      // "peers[i].url is undefined"-style errors. Warn + fall back.
      console.warn(
        'Warning: PEER_CONFIG env var has wrong shape (expected array of {id,name,url}); falling back to manifest',
      );
    } catch {
      console.warn('Warning: Could not parse PEER_CONFIG env var');
    }
  }
  return getPeersFor(characterId);
}

function validatePeerConfigShape(value: unknown): PeerConfig[] | null {
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof (entry as { id?: unknown }).id !== 'string' ||
      typeof (entry as { name?: unknown }).name !== 'string' ||
      typeof (entry as { url?: unknown }).url !== 'string'
    ) {
      return null;
    }
  }
  return value as PeerConfig[];
}

export async function startCharacterById(characterId: string, portOverride?: number): Promise<void> {
  const entry = getCharacterEntry(characterId);
  if (!entry) {
    displayError(`Unknown character: ${characterId}. Add it to characters.json first.`);
    process.exit(1);
  }

  const config: CharacterConfig = {
    id: entry.id,
    name: entry.name,
    port: portOverride ?? entry.port,
    peers: parsePeerConfig(entry.id),
  };

  process.env['LAIN_CHARACTER_ID'] = entry.id;
  process.env['LAIN_CHARACTER_NAME'] = entry.name;

  if (entry.possessable) {
    config.possessable = true;
  }

  try {
    await startCharacterServer(config);
  } catch (error) {
    displayError(`Failed to start ${entry.name} server: ${error}`);
    process.exit(1);
  }
}
