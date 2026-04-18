/**
 * Character-specific tools for Newtown residents.
 */

import { registerTool } from './tools.js';
import { getLogger } from '../utils/logger.js';
import { isValidBuilding, BUILDINGS } from '../commune/buildings.js';
import { setCurrentLocation, getCurrentLocation } from '../commune/location.js';
import { saveMemory } from '../memory/store.js';

export interface PeerConfig {
  id: string;
  name: string;
  url: string;
}

export function registerCharacterTools(
  characterId: string,
  characterName: string,
  _unusedBaseUrl: string,
  _unusedToken: string,
  peers: PeerConfig[]
): void {
  const logger = getLogger();

  registerTool({
    definition: {
      name: 'send_peer_message',
      description:
        'Send a direct message to another resident of the town. ' +
        'This is a synchronous exchange and returns their reply immediately.',
      inputSchema: {
        type: 'object',
        properties: {
          peer_id: {
            type: 'string',
            description: `The ID of the resident to message. Available peers: ${peers.map((peer) => `"${peer.id}" (${peer.name})`).join(', ')}`,
          },
          message: {
            type: 'string',
            description: 'The message to send',
          },
        },
        required: ['peer_id', 'message'],
      },
    },
    handler: async (input) => {
      const peerId = input.peer_id as string;
      const message = input.message as string;

      const peer = peers.find((candidate) => candidate.id === peerId);
      if (!peer) {
        return `Unknown peer "${peerId}". Available: ${peers.map((candidate) => candidate.id).join(', ')}`;
      }

      try {
        const response = await fetch(`${peer.url}/api/peer/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fromId: characterId,
            fromName: characterName,
            message,
            timestamp: Date.now(),
          }),
          signal: AbortSignal.timeout(60000),
        });

        if (!response.ok) {
          return `${peer.name} did not respond (${response.status}).`;
        }

        const result = await response.json() as { response: string };
        return `${peer.name}: ${result.response}`;
      } catch (error) {
        logger.error({ error, peerId }, 'Peer message error');
        return `Could not reach ${peer.name}: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });

  const buildingList = BUILDINGS.map((building) =>
    `"${building.id}" (${building.name} - ${building.description})`
  ).join(', ');

  registerTool({
    definition: {
      name: 'move_to_building',
      description:
        'Move to a different building in town. ' +
        `Available buildings: ${buildingList}`,
      inputSchema: {
        type: 'object',
        properties: {
          building: {
            type: 'string',
            description: 'The building ID',
          },
          reason: {
            type: 'string',
            description: 'Why you want to go there',
          },
        },
        required: ['building', 'reason'],
      },
    },
    handler: async (input) => {
      const building = input.building as string;
      const reason = input.reason as string;

      if (!isValidBuilding(building)) {
        return `Unknown building "${building}". Available: ${BUILDINGS.map((candidate) => candidate.id).join(', ')}`;
      }

      const current = getCurrentLocation(characterId);
      if (current.building === building) {
        return `You are already at ${building}.`;
      }

      setCurrentLocation(building, reason);

      const now = Date.now();
      await saveMemory({
        sessionKey: `move:${characterId}:${building}:${now}`,
        userId: null,
        content: `Moved to ${building}: ${reason}`,
        memoryType: 'episode',
        importance: 0.3,
        emotionalWeight: 0.1,
        relatedTo: null,
        sourceMessageId: null,
        metadata: { action: 'move', building, reason },
      });

      const target = BUILDINGS.find((candidate) => candidate.id === building);
      return `You head toward the ${target?.name ?? building}. ${reason}`;
    },
  });

  registerTool({
    definition: {
      name: 'leave_note',
      description:
        'Leave a note at the current building or a specified one. Other residents may discover it.',
      inputSchema: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'The note text',
          },
          location: {
            type: 'string',
            description: 'Optional building ID; defaults to your current location',
          },
        },
        required: ['content'],
      },
    },
    handler: async (input) => {
      const content = input.content as string;
      const location = (input.location as string | undefined) ?? undefined;

      let buildingId: string;
      if (location) {
        if (!isValidBuilding(location)) {
          return `Unknown building "${location}". Available: ${BUILDINGS.map((candidate) => candidate.id).join(', ')}`;
        }
        buildingId = location;
      } else {
        buildingId = getCurrentLocation(characterId).building;
      }

      const now = Date.now();
      await saveMemory({
        sessionKey: `note:${characterId}:${now}`,
        userId: null,
        content: `[Note left at ${buildingId}] ${content}`,
        memoryType: 'episode',
        importance: 0.4,
        emotionalWeight: 0.2,
        relatedTo: null,
        sourceMessageId: null,
        metadata: { action: 'note', building: buildingId, author: characterId },
      });

      const target = BUILDINGS.find((candidate) => candidate.id === buildingId);
      return `Note left at the ${target?.name ?? buildingId}.`;
    },
  });

  registerTool({
    definition: {
      name: 'write_document',
      description:
        'Write a titled document such as an essay, dialogue fragment, poem, or field note.',
      inputSchema: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'The title of the document',
          },
          content: {
            type: 'string',
            description: 'The body of the document',
          },
        },
        required: ['title', 'content'],
      },
    },
    handler: async (input) => {
      const title = input.title as string;
      const content = input.content as string;
      const sanitizedTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
      const now = Date.now();

      await saveMemory({
        sessionKey: `document:${characterId}:${sanitizedTitle}`,
        userId: null,
        content: `[Document: "${title}"]\n\n${content}`,
        memoryType: 'episode',
        importance: 0.5,
        emotionalWeight: 0.2,
        relatedTo: null,
        sourceMessageId: null,
        metadata: { action: 'document', title, author: characterId, writtenAt: now },
      });

      return `Document "${title}" saved.`;
    },
  });

  registerTool({
    definition: {
      name: 'read_document',
      description:
        'Read a document written by another resident.',
      inputSchema: {
        type: 'object',
        properties: {
          peer_id: {
            type: 'string',
            description: `The ID of the peer whose document you want to read. Available peers: ${peers.map((peer) => `"${peer.id}" (${peer.name})`).join(', ')}`,
          },
          title: {
            type: 'string',
            description: 'Optional title or exact document name',
          },
        },
        required: ['peer_id'],
      },
    },
    handler: async (input) => {
      const peerId = input.peer_id as string;
      const title = (input.title as string | undefined) ?? undefined;
      const peer = peers.find((candidate) => candidate.id === peerId);

      if (!peer) {
        return `Unknown peer "${peerId}". Available: ${peers.map((candidate) => candidate.id).join(', ')}`;
      }

      try {
        const query = title ? `?title=${encodeURIComponent(title)}` : '';
        const response = await fetch(`${peer.url}/api/documents${query}`, {
          signal: AbortSignal.timeout(10000),
        });

        if (!response.ok) {
          return `Could not fetch documents from ${peer.name}.`;
        }

        if (title) {
          const doc = await response.json() as { title: string; content: string } | null;
          if (!doc) {
            return `No document titled "${title}" found from ${peer.name}.`;
          }
          return `[Document by ${peer.name}: "${doc.title}"]\n\n${doc.content}`;
        }

        const docs = await response.json() as { title: string; content: string }[];
        if (docs.length === 0) {
          return `${peer.name} has not written any documents yet.`;
        }

        return `Documents by ${peer.name}:\n${docs.map((doc) => `- "${doc.title}": ${doc.content.slice(0, 100)}...`).join('\n')}`;
      } catch (error) {
        return `Could not reach ${peer.name}: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });

  registerTool({
    definition: {
      name: 'give_gift',
      description:
        'Give a symbolic gift to another resident, optionally with a message.',
      inputSchema: {
        type: 'object',
        properties: {
          peer_id: {
            type: 'string',
            description: `The ID of the peer to receive the gift. Available peers: ${peers.map((peer) => `"${peer.id}" (${peer.name})`).join(', ')}`,
          },
          description: {
            type: 'string',
            description: 'A description of the gift',
          },
          message: {
            type: 'string',
            description: 'Optional message to accompany the gift',
          },
        },
        required: ['peer_id', 'description'],
      },
    },
    handler: async (input) => {
      const peerId = input.peer_id as string;
      const description = input.description as string;
      const message = (input.message as string | undefined) ?? '';
      const peer = peers.find((candidate) => candidate.id === peerId);

      if (!peer) {
        return `Unknown peer "${peerId}". Available: ${peers.map((candidate) => candidate.id).join(', ')}`;
      }

      try {
        const giftMessage = `[GIFT: ${description}] ${message}`.trim();
        const response = await fetch(`${peer.url}/api/peer/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fromId: characterId,
            fromName: characterName,
            message: giftMessage,
            timestamp: Date.now(),
          }),
          signal: AbortSignal.timeout(60000),
        });

        const now = Date.now();
        await saveMemory({
          sessionKey: `gift:${characterId}:${peerId}:${now}`,
          userId: null,
          content: `Gave a gift to ${peer.name}: ${description}${message ? `. "${message}"` : ''}`,
          memoryType: 'episode',
          importance: 0.5,
          emotionalWeight: 0.4,
          relatedTo: null,
          sourceMessageId: null,
          metadata: { action: 'gift', recipient: peerId, description, message },
        });

        if (!response.ok) {
          return `Gift sent but ${peer.name} may not have received it (${response.status}).`;
        }

        const result = await response.json() as { response: string };
        return `Gift delivered to ${peer.name}. Their response: ${result.response}`;
      } catch (error) {
        logger.error({ error, peerId }, 'Gift delivery error');
        return `Could not reach ${peer.name}: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });

  logger.info({ characterId, peers: peers.map((peer) => peer.id) }, 'Character tools registered');
}
