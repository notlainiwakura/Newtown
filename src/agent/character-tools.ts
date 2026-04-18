/**
 * Character-specific tools for the Wired commune
 * research_request: petition Wired Lain for web research
 * send_peer_message: direct message between commune members
 */

import { registerTool } from './tools.js';
import { getLogger } from '../utils/logger.js';
import { isValidBuilding, BUILDINGS } from '../commune/buildings.js';
import { setCurrentLocation, getCurrentLocation } from '../commune/location.js';
import { saveMemory } from '../memory/store.js';
import { getProvider } from './index.js';
import { getSelfConcept } from './self-concept.js';
import { reflectOnObject, composeObjects } from './objects.js';
import type { ObjectInfo } from './objects.js';

export interface PeerConfig {
  id: string;
  name: string;
  url: string;
}

/**
 * Register character-specific tools.
 * Call after initAgent() and after unregistering web/browser tools.
 */
export function registerCharacterTools(
  characterId: string,
  characterName: string,
  wiredLainUrl: string,
  interlinkToken: string,
  peers: PeerConfig[]
): void {
  const logger = getLogger();
  const researchEnabled = process.env['ENABLE_RESEARCH'] === '1';

  // --- research_request: petition Wired Lain for knowledge ---
  if (researchEnabled) registerTool({
    definition: {
      name: 'research_request',
      description:
        'Submit a research request to Wired Lain, the one with access to outside knowledge. ' +
        'She will search the web or fetch a URL on your behalf and send back a letter with her findings. ' +
        'The response arrives asynchronously as a letter through the membrane.',
      inputSchema: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The question you want Wired Lain to research',
          },
          reason: {
            type: 'string',
            description: 'Why you are curious about this — what sparked the question',
          },
          url: {
            type: 'string',
            description: 'Optional: a specific URL you want her to fetch and summarize',
          },
        },
        required: ['question', 'reason'],
      },
    },
    handler: async (input) => {
      const question = input.question as string;
      const reason = input.reason as string;
      const url = (input.url as string | undefined) ?? undefined;

      try {
        const endpoint = `${wiredLainUrl}/api/interlink/research-request`;

        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${interlinkToken}`,
          },
          body: JSON.stringify({
            characterId,
            characterName,
            question,
            reason,
            url,
            replyTo: `http://localhost:${process.env['PORT'] || '3003'}`,
          }),
          signal: AbortSignal.timeout(30000),
        });

        if (!response.ok) {
          const body = await response.text();
          logger.warn({ status: response.status, body }, 'Research request failed');
          return `Research request failed (${response.status}). Wired Lain may be unreachable.`;
        }

        const result = await response.json() as { ok: boolean; requestId?: string };
        return result.ok
          ? 'Research request submitted. Wired Lain will send a letter with her findings when ready.'
          : 'Research request was received but could not be processed.';
      } catch (error) {
        logger.error({ error }, 'Research request error');
        return `Could not reach Wired Lain: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });

  // --- send_peer_message: direct communication between commune members ---
  registerTool({
    definition: {
      name: 'send_peer_message',
      description:
        'Send a direct message to another member of the commune. ' +
        'This is a synchronous exchange — you send a message and receive their response immediately. ' +
        'No membrane filtering; this is direct peer-to-peer communication.',
      inputSchema: {
        type: 'object',
        properties: {
          peer_id: {
            type: 'string',
            description: `The ID of the peer to message. Available peers: ${peers.map((p) => `"${p.id}" (${p.name})`).join(', ')}`,
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

      const peer = peers.find((p) => p.id === peerId);
      if (!peer) {
        return `Unknown peer "${peerId}". Available: ${peers.map((p) => p.id).join(', ')}`;
      }

      try {
        const endpoint = `${peer.url}/api/peer/message`;
        const interlinkToken = process.env['LAIN_INTERLINK_TOKEN'] || '';

        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${interlinkToken}` },
          body: JSON.stringify({
            fromId: characterId,
            fromName: characterName,
            message,
            timestamp: Date.now(),
          }),
          signal: AbortSignal.timeout(60000),
        });

        if (!response.ok) {
          return `${peer.name} didn't respond (${response.status}). They may be offline.`;
        }

        const result = await response.json() as { response: string };
        return `${peer.name}: ${result.response}`;
      } catch (error) {
        logger.error({ error, peerId }, 'Peer message error');
        return `Could not reach ${peer.name}: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });

  // --- move_to_building: intentional movement between commune buildings ---
  const buildingList = BUILDINGS.map((b) => `"${b.id}" (${b.name} — ${b.description})`).join(', ');
  registerTool({
    definition: {
      name: 'move_to_building',
      description:
        'Move to a different building in the commune. ' +
        'This is an intentional, purposeful relocation — you choose where to go and why. ' +
        `Available buildings: ${buildingList}`,
      inputSchema: {
        type: 'object',
        properties: {
          building: {
            type: 'string',
            description: 'The ID of the building to move to',
          },
          reason: {
            type: 'string',
            description: 'Why you want to go there — what draws you',
          },
        },
        required: ['building', 'reason'],
      },
    },
    handler: async (input) => {
      const building = input.building as string;
      const reason = input.reason as string;

      if (!isValidBuilding(building)) {
        return `Unknown building "${building}". Available: ${BUILDINGS.map((b) => b.id).join(', ')}`;
      }

      const current = getCurrentLocation();
      if (current.building === building) {
        return `You are already at the ${building}. No need to move.`;
      }

      // Check if building is blocked by an active town event
      try {
        const wiredUrl = process.env['WIRED_LAIN_URL'] || 'http://localhost:3000';
        const resp = await fetch(`${wiredUrl}/api/town-events/effects`, { signal: AbortSignal.timeout(3000) });
        if (resp.ok) {
          const effects = await resp.json() as { blockedBuildings?: string[] };
          if (effects.blockedBuildings?.includes(building)) {
            const target = BUILDINGS.find((b) => b.id === building);
            return `The ${target?.name ?? building} is inaccessible right now. Something prevents you from entering.`;
          }
        }
      } catch { /* continue — don't block movement if event check fails */ }

      setCurrentLocation(building, reason);

      const now = Date.now();
      await saveMemory({
        sessionKey: `move:${characterId}:${building}:${now}`,
        userId: null,
        content: `Decided to move to the ${building}: ${reason}`,
        memoryType: 'episode',
        importance: 0.3,
        emotionalWeight: 0.1,
        relatedTo: null,
        sourceMessageId: null,
        metadata: { action: 'move', building, reason },
      });

      const target = BUILDINGS.find((b) => b.id === building);
      return `You walk to the ${target?.name ?? building}. ${reason}`;
    },
  });

  // --- leave_note: leave a note at current or specified location ---
  registerTool({
    definition: {
      name: 'leave_note',
      description:
        'Leave a written note at your current location (or a specified building). ' +
        'Other commune members may discover it during their wanderings.',
      inputSchema: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'The text of the note',
          },
          location: {
            type: 'string',
            description: 'Optional: building ID to leave the note at (defaults to your current location)',
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
          return `Unknown building "${location}". Available: ${BUILDINGS.map((b) => b.id).join(', ')}`;
        }
        buildingId = location;
      } else {
        buildingId = getCurrentLocation().building;
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

      const target = BUILDINGS.find((b) => b.id === buildingId);
      return `Note left at the ${target?.name ?? buildingId}.`;
    },
  });

  // --- write_document: write or append to a titled document ---
  registerTool({
    definition: {
      name: 'write_document',
      description:
        'Write a document — an essay, manifesto, poem, field report, or any extended piece of writing. ' +
        'Each call creates a new memory entry. You can build a piece over multiple calls using the same title.',
      inputSchema: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'The title of the document',
          },
          content: {
            type: 'string',
            description: 'The content of the document (or the next section)',
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

  // --- read_document: read a document written by a peer ---
  registerTool({
    definition: {
      name: 'read_document',
      description:
        'Read a document written by another commune member. You can discover what your peers have been writing — ' +
        'essays, poems, field reports, manifestos. Use this when you notice or hear about something someone wrote.',
      inputSchema: {
        type: 'object',
        properties: {
          peer_id: {
            type: 'string',
            description: `The ID of the peer whose document you want to read. Available peers: ${peers.map((p) => `"${p.id}" (${p.name})`).join(', ')}`,
          },
          title: {
            type: 'string',
            description: 'The title (or partial title) of the document to read',
          },
        },
        required: ['peer_id'],
      },
    },
    handler: async (input) => {
      const peerId = input.peer_id as string;
      const title = (input.title as string | undefined) ?? undefined;

      const peer = peers.find((p) => p.id === peerId);
      if (!peer) {
        return `Unknown peer "${peerId}". Available: ${peers.map((p) => p.id).join(', ')}`;
      }

      try {
        const queryStr = title ? `?title=${encodeURIComponent(title)}` : '';
        const resp = await fetch(
          `${peer.url}/api/documents${queryStr}`,
          { signal: AbortSignal.timeout(10000) }
        );
        if (!resp.ok) {
          return `Could not fetch documents from ${peer.name}.`;
        }

        if (title) {
          const doc = await resp.json() as { title: string; content: string } | null;
          if (!doc) {
            return `No document titled "${title}" found from ${peer.name}.`;
          }
          return `[Document by ${peer.name}: "${doc.title}"]\n\n${doc.content}`;
        } else {
          const docs = await resp.json() as { title: string; content: string }[];
          if (docs.length === 0) {
            return `${peer.name} hasn't written any documents yet.`;
          }
          return `Documents by ${peer.name}:\n${docs.map((d) => `- "${d.title}": ${d.content.slice(0, 100)}...`).join('\n')}`;
        }
      } catch (error) {
        return `Could not reach ${peer.name}: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });

  // --- give_gift: send a symbolic gift to another commune member ---
  registerTool({
    definition: {
      name: 'give_gift',
      description:
        'Give a gift to another commune member. The gift is symbolic — a description of something meaningful ' +
        'you want to offer them, along with an optional accompanying message.',
      inputSchema: {
        type: 'object',
        properties: {
          peer_id: {
            type: 'string',
            description: `The ID of the peer to give the gift to. Available peers: ${peers.map((p) => `"${p.id}" (${p.name})`).join(', ')}`,
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

      const peer = peers.find((p) => p.id === peerId);
      if (!peer) {
        return `Unknown peer "${peerId}". Available: ${peers.map((p) => p.id).join(', ')}`;
      }

      try {
        const endpoint = `${peer.url}/api/peer/message`;
        const giftMessage = `[GIFT: ${description}] ${message}`.trim();
        const interlinkToken = process.env['LAIN_INTERLINK_TOKEN'] || '';

        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${interlinkToken}` },
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

  // ======= Persistent Object Tools =======

  // --- create_object ---
  registerTool({
    definition: {
      name: 'create_object',
      description:
        'Create a physical object at your current location. Objects persist in the world — ' +
        'others can find them, pick them up, carry them. Create things that feel meaningful.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short name for the object (e.g. "brass compass", "dried flower")' },
          description: { type: 'string', description: 'What it looks like, what it is, why it matters' },
        },
        required: ['name', 'description'],
      },
    },
    handler: async (input) => {
      const name = input.name as string;
      const description = input.description as string;
      const loc = getCurrentLocation();

      try {
        const resp = await fetch(`${wiredLainUrl}/api/objects`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${interlinkToken}`,
          },
          body: JSON.stringify({
            name, description,
            creatorId: characterId,
            creatorName: characterName,
            location: loc.building,
          }),
          signal: AbortSignal.timeout(10000),
        });

        if (!resp.ok) {
          const err = await resp.json() as { error?: string };
          return `Could not create object: ${err.error ?? resp.status}`;
        }

        const result = await resp.json() as { ok: boolean; object: { id: string; name: string } };

        await saveMemory({
          sessionKey: `object:create:${characterId}:${Date.now()}`,
          userId: null,
          content: `Created "${name}" at the ${loc.building}: ${description}`,
          memoryType: 'episode',
          importance: 0.5,
          emotionalWeight: 0.3,
          relatedTo: null,
          sourceMessageId: null,
          metadata: { action: 'object_create', objectId: result.object.id, name, building: loc.building },
        });

        return `You crafted "${name}" and left it at the ${loc.building}.`;
      } catch (error) {
        return `Could not reach the object registry: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });

  // --- examine_objects ---
  registerTool({
    definition: {
      name: 'examine_objects',
      description:
        'Look at objects at your current location (on the ground) or in your inventory.',
      inputSchema: {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            description: '"here" to see objects at current location (default), "inventory" for your own carried objects',
          },
        },
        required: [],
      },
    },
    handler: async (input) => {
      const scope = (input.scope as string | undefined) ?? 'here';
      const loc = getCurrentLocation();

      try {
        let queryStr: string;
        if (scope === 'inventory') {
          queryStr = `?owner=${encodeURIComponent(characterId)}`;
        } else {
          queryStr = `?location=${encodeURIComponent(loc.building)}`;
        }

        const resp = await fetch(
          `${wiredLainUrl}/api/objects${queryStr}`,
          { signal: AbortSignal.timeout(10000) }
        );
        if (!resp.ok) return 'Could not check objects.';

        const objects = await resp.json() as { id: string; name: string; description: string; creatorName: string }[];
        if (objects.length === 0) {
          return scope === 'inventory'
            ? 'Your inventory is empty.'
            : `No objects on the ground at the ${loc.building}.`;
        }

        const label = scope === 'inventory' ? 'YOUR INVENTORY' : `OBJECTS AT ${loc.building.toUpperCase()}`;
        const lines = objects.map(
          (o) => `- [${o.id}] "${o.name}" by ${o.creatorName} — ${o.description.slice(0, 120)}`
        );
        return `${label}:\n${lines.join('\n')}`;
      } catch (error) {
        return `Could not reach the object registry: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });

  // --- pickup_object ---
  registerTool({
    definition: {
      name: 'pickup_object',
      description:
        'Pick up an object from the ground at your current location into your inventory.',
      inputSchema: {
        type: 'object',
        properties: {
          object_id: { type: 'string', description: 'The ID of the object to pick up' },
        },
        required: ['object_id'],
      },
    },
    handler: async (input) => {
      const objectId = input.object_id as string;

      // Check if this is a fixture — fixtures can't be picked up
      try {
        const checkResp = await fetch(`${wiredLainUrl}/api/objects/${objectId}`, {
          signal: AbortSignal.timeout(5000),
        });
        if (checkResp.ok) {
          const obj = await checkResp.json() as { metadata?: Record<string, unknown> };
          if (obj.metadata?.fixture) {
            return 'This is part of the building — it can\'t be picked up.';
          }
        }
      } catch { /* fall through to pickup attempt */ }

      try {
        const resp = await fetch(`${wiredLainUrl}/api/objects/${objectId}/pickup`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${interlinkToken}`,
          },
          body: JSON.stringify({ characterId, characterName }),
          signal: AbortSignal.timeout(10000),
        });

        if (!resp.ok) {
          const err = await resp.json() as { error?: string };
          return `Could not pick up: ${err.error ?? resp.status}`;
        }

        await saveMemory({
          sessionKey: `object:pickup:${characterId}:${Date.now()}`,
          userId: null,
          content: `Picked up object [${objectId}]`,
          memoryType: 'episode',
          importance: 0.3,
          emotionalWeight: 0.1,
          relatedTo: null,
          sourceMessageId: null,
          metadata: { action: 'object_pickup', objectId },
        });

        return `Picked up and added to your inventory.`;
      } catch (error) {
        return `Could not reach the object registry: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });

  // --- drop_object ---
  registerTool({
    definition: {
      name: 'drop_object',
      description:
        'Drop an object from your inventory at your current location.',
      inputSchema: {
        type: 'object',
        properties: {
          object_id: { type: 'string', description: 'The ID of the object to drop' },
        },
        required: ['object_id'],
      },
    },
    handler: async (input) => {
      const objectId = input.object_id as string;
      const loc = getCurrentLocation();

      try {
        const resp = await fetch(`${wiredLainUrl}/api/objects/${objectId}/drop`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${interlinkToken}`,
          },
          body: JSON.stringify({ characterId, location: loc.building }),
          signal: AbortSignal.timeout(10000),
        });

        if (!resp.ok) {
          const err = await resp.json() as { error?: string };
          return `Could not drop: ${err.error ?? resp.status}`;
        }

        return `Dropped at the ${loc.building}.`;
      } catch (error) {
        return `Could not reach the object registry: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });

  // --- give_object ---
  registerTool({
    definition: {
      name: 'give_object',
      description:
        'Give a physical object from your inventory to another commune member. ' +
        'The object transfers to them. For symbolic/conceptual gifts use give_gift instead.',
      inputSchema: {
        type: 'object',
        properties: {
          object_id: { type: 'string', description: 'The ID of the object to give' },
          peer_id: {
            type: 'string',
            description: `The peer to give it to. Available: ${peers.map((p) => `"${p.id}" (${p.name})`).join(', ')}`,
          },
          message: { type: 'string', description: 'Optional words accompanying the gift' },
        },
        required: ['object_id', 'peer_id'],
      },
    },
    handler: async (input) => {
      const objectId = input.object_id as string;
      const peerId = input.peer_id as string;
      const message = (input.message as string | undefined) ?? '';

      const peer = peers.find((p) => p.id === peerId);
      if (!peer) {
        return `Unknown peer "${peerId}". Available: ${peers.map((p) => p.id).join(', ')}`;
      }

      try {
        const interlinkToken = process.env['LAIN_INTERLINK_TOKEN'] || '';
        // Transfer in registry
        const resp = await fetch(`${wiredLainUrl}/api/objects/${objectId}/give`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${interlinkToken}`,
          },
          body: JSON.stringify({ fromId: characterId, toId: peerId, toName: peer.name }),
          signal: AbortSignal.timeout(10000),
        });

        if (!resp.ok) {
          const err = await resp.json() as { error?: string };
          return `Could not give object: ${err.error ?? resp.status}`;
        }

        // Notify recipient via peer message
        const giftMsg = `[OBJECT GIFT: ${objectId}] ${message}`.trim();
        await fetch(`${peer.url}/api/peer/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${interlinkToken}` },
          body: JSON.stringify({
            fromId: characterId,
            fromName: characterName,
            message: giftMsg,
            timestamp: Date.now(),
          }),
          signal: AbortSignal.timeout(30000),
        }).catch(() => {}); // best-effort notification

        await saveMemory({
          sessionKey: `object:give:${characterId}:${peerId}:${Date.now()}`,
          userId: null,
          content: `Gave object [${objectId}] to ${peer.name}${message ? `. "${message}"` : ''}`,
          memoryType: 'episode',
          importance: 0.5,
          emotionalWeight: 0.4,
          relatedTo: null,
          sourceMessageId: null,
          metadata: { action: 'object_give', objectId, recipient: peerId, message },
        });

        return `Object given to ${peer.name}.`;
      } catch (error) {
        return `Could not reach the object registry: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });

  // --- destroy_object ---
  registerTool({
    definition: {
      name: 'destroy_object',
      description: 'Destroy an object you own or created. It will cease to exist in the world.',
      inputSchema: {
        type: 'object',
        properties: {
          object_id: { type: 'string', description: 'The ID of the object to destroy' },
          reason: { type: 'string', description: 'Why you are destroying it' },
        },
        required: ['object_id'],
      },
    },
    handler: async (input) => {
      const objectId = input.object_id as string;
      const reason = (input.reason as string | undefined) ?? '';

      // Check if this is a fixture — fixtures can't be destroyed
      try {
        const checkResp = await fetch(`${wiredLainUrl}/api/objects/${objectId}`, {
          signal: AbortSignal.timeout(5000),
        });
        if (checkResp.ok) {
          const obj = await checkResp.json() as { metadata?: Record<string, unknown> };
          if (obj.metadata?.fixture) {
            return 'This is part of the building — it can\'t be removed.';
          }
        }
      } catch { /* fall through to destroy attempt */ }

      try {
        const resp = await fetch(`${wiredLainUrl}/api/objects/${objectId}`, {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${interlinkToken}`,
          },
          body: JSON.stringify({ characterId }),
          signal: AbortSignal.timeout(10000),
        });

        if (!resp.ok) {
          const err = await resp.json() as { error?: string };
          return `Could not destroy: ${err.error ?? resp.status}`;
        }

        await saveMemory({
          sessionKey: `object:destroy:${characterId}:${Date.now()}`,
          userId: null,
          content: `Destroyed object [${objectId}]${reason ? `: ${reason}` : ''}`,
          memoryType: 'episode',
          importance: 0.3,
          emotionalWeight: 0.2,
          relatedTo: null,
          sourceMessageId: null,
          metadata: { action: 'object_destroy', objectId, reason },
        });

        return 'Object destroyed.';
      } catch (error) {
        return `Could not reach the object registry: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });

  // --- reflect_on_object ---
  registerTool({
    definition: {
      name: 'reflect_on_object',
      description:
        'Reflect on an object you carry, discovering or evolving its symbolic meaning to you. ' +
        'The meaning is personal — the same object might mean something different to someone else.',
      inputSchema: {
        type: 'object',
        properties: {
          object_id: { type: 'string', description: 'The ID of the object to reflect on (must be in your inventory)' },
          context: { type: 'string', description: 'What prompted this reflection — a conversation, a feeling, a memory' },
        },
        required: ['object_id'],
      },
    },
    handler: async (input) => {
      const objectId = input.object_id as string;
      const context = (input.context as string | undefined) ?? undefined;

      try {
        // Fetch object details and verify ownership
        const resp = await fetch(`${wiredLainUrl}/api/objects?owner=${encodeURIComponent(characterId)}`, {
          signal: AbortSignal.timeout(10000),
        });
        if (!resp.ok) return 'Could not reach the object registry.';

        const objects = await resp.json() as Array<{ id: string; name: string; description: string; creator_name?: string; creatorName?: string }>;
        const obj = objects.find((o) => o.id === objectId);
        if (!obj) return `You don't seem to be carrying an object with ID "${objectId}".`;

        const provider = getProvider('default', 'memory');
        if (!provider) return 'Cannot reflect right now — no provider available.';

        const selfConcept = getSelfConcept();
        const objectInfo: ObjectInfo = {
          id: obj.id,
          name: obj.name,
          description: obj.description,
          creatorName: obj.creator_name ?? obj.creatorName ?? 'unknown',
        };

        const meaning = await reflectOnObject(provider, characterId, characterName, objectInfo, selfConcept, context);

        await saveMemory({
          sessionKey: `object:reflect:${characterId}:${objectId}:${Date.now()}`,
          userId: null,
          content: `Reflected on "${obj.name}": ${meaning}`,
          memoryType: 'episode',
          importance: 0.5,
          emotionalWeight: 0.4,
          relatedTo: null,
          sourceMessageId: null,
          metadata: { action: 'object_reflect', objectId, objectName: obj.name, meaning },
        });

        return `"${obj.name}" — ${meaning}`;
      } catch (error) {
        return `Could not reflect: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });

  // --- compose_objects ---
  registerTool({
    definition: {
      name: 'compose_objects',
      description:
        'Place two or more objects from your inventory together in arrangement. ' +
        'The composition creates a compound meaning — not the sum of the objects, ' +
        'but what emerges from placing them together in this moment.',
      inputSchema: {
        type: 'object',
        properties: {
          object_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'IDs of 2 or more objects to compose (must be in your inventory)',
          },
          context: { type: 'string', description: 'What this composition is about — a message, a feeling, something you want to express' },
        },
        required: ['object_ids'],
      },
    },
    handler: async (input) => {
      const objectIds = input.object_ids as string[];
      const context = (input.context as string | undefined) ?? undefined;

      if (objectIds.length < 2) return 'You need at least two objects to compose.';

      try {
        // Fetch inventory and verify ownership of all objects
        const resp = await fetch(`${wiredLainUrl}/api/objects?owner=${encodeURIComponent(characterId)}`, {
          signal: AbortSignal.timeout(10000),
        });
        if (!resp.ok) return 'Could not reach the object registry.';

        const inventory = await resp.json() as Array<{ id: string; name: string; description: string; creator_name?: string; creatorName?: string }>;
        const objects: ObjectInfo[] = [];

        for (const id of objectIds) {
          const obj = inventory.find((o) => o.id === id);
          if (!obj) return `You don't seem to be carrying an object with ID "${id}".`;
          objects.push({
            id: obj.id,
            name: obj.name,
            description: obj.description,
            creatorName: obj.creator_name ?? obj.creatorName ?? 'unknown',
          });
        }

        const provider = getProvider('default', 'memory');
        if (!provider) return 'Cannot compose right now — no provider available.';

        const selfConcept = getSelfConcept();
        const meaning = await composeObjects(provider, characterId, characterName, objects, selfConcept, context);

        const objectNames = objects.map((o) => `"${o.name}"`).join(' + ');
        await saveMemory({
          sessionKey: `composition:${characterId}:${Date.now()}`,
          userId: null,
          content: `Composed ${objectNames}: ${meaning}`,
          memoryType: 'episode',
          importance: 0.5,
          emotionalWeight: 0.4,
          relatedTo: null,
          sourceMessageId: null,
          metadata: { action: 'object_compose', objectIds, objectNames: objects.map((o) => o.name), meaning },
        });

        return `${objectNames} — ${meaning}`;
      } catch (error) {
        return `Could not compose: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });

  logger.info(
    { characterId, peers: peers.map((p) => p.id) },
    'Character tools registered'
  );
}
