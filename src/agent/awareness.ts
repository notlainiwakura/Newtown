/**
 * Ambient awareness — builds context about co-located peers for system prompt injection.
 *
 * When a character is in a building, this module checks which peers are also
 * in that building and fetches their emotional state summary + relationship data.
 */

import { getLogger } from '../utils/logger.js';
import { getRelationshipContext } from './relationships.js';
import type { PeerConfig } from './character-tools.js';

/**
 * Build a prompt block describing who else is in the same building.
 * Returns empty string if nobody is co-located or all fetches fail.
 */
export async function buildAwarenessContext(
  currentBuilding: string,
  peers: PeerConfig[]
): Promise<string> {
  const logger = getLogger();
  const token = process.env['LAIN_INTERLINK_TOKEN'];
  const lines: string[] = [];

  await Promise.all(peers.map(async (peer) => {
    try {
      // 1. Check if peer is in the same building
      const locResp = await fetch(`${peer.url}/api/location`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!locResp.ok) return;
      const locData = await locResp.json() as { location: string };
      if (locData.location !== currentBuilding) return;

      // 2. Fetch peer's internal state (requires interlink auth)
      let stateSummary = '';
      if (token) {
        try {
          const stateResp = await fetch(`${peer.url}/api/internal-state`, {
            headers: { 'Authorization': `Bearer ${token}` },
            signal: AbortSignal.timeout(5000),
          });
          if (stateResp.ok) {
            const stateData = await stateResp.json() as { summary?: string };
            stateSummary = stateData.summary || '';
          }
        } catch {
          // Non-critical — state fetch failed silently
        }
      }

      // 3. Get relationship context from local store
      const relationshipCtx = getRelationshipContext(peer.id);

      // 4. Assemble the line
      let line = `- ${peer.name} is here.`;
      if (stateSummary) {
        line += ` ${stateSummary}`;
      }
      if (relationshipCtx) {
        line += `\n  ${relationshipCtx}`;
      }
      lines.push(line);
    } catch {
      // Peer unreachable or fetch failed — skip silently
      logger.debug({ peerId: peer.id }, 'Awareness: failed to check peer');
    }
  }));

  if (lines.length === 0) return '';
  return '\n\n[Who\'s here]\n' + lines.join('\n');
}
