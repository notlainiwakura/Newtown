/**
 * Desire Engine — persistent drives that shape character behavior.
 *
 * Desires spawn from events (dreams, conversations, loneliness, curiosity).
 * They persist across interactions, inject into system prompts, influence
 * commune peer selection, and resolve through action or natural decay.
 */

import { getProvider } from './index.js';
import { execute, query, queryOne, getMeta, setMeta } from '../storage/database.js';
import { getLogger } from '../utils/logger.js';
import type { PeerConfig } from './character-tools.js';

// ──────────────────────────────────────────────
// Schema — call ensureDesireTable() at startup
// ──────────────────────────────────────────────

export function ensureDesireTable(): void {
  execute(`
    CREATE TABLE IF NOT EXISTS desires (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      intensity REAL NOT NULL DEFAULT 0.5,
      source TEXT NOT NULL,
      source_detail TEXT,
      target_peer TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      resolved_at INTEGER,
      resolution TEXT,
      decay_rate REAL NOT NULL DEFAULT 0.04
    )
  `);
  execute(`CREATE INDEX IF NOT EXISTS idx_desires_active ON desires(resolved_at) WHERE resolved_at IS NULL`);
  execute(`CREATE INDEX IF NOT EXISTS idx_desires_type ON desires(type)`);
}

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export type DesireType = 'social' | 'intellectual' | 'emotional' | 'creative';

export interface Desire {
  id: string;
  type: DesireType;
  description: string;
  intensity: number;
  source: string;
  sourceDetail: string | null;
  targetPeer: string | null;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
  resolution: string | null;
  decayRate: number;
}

interface DesireRow {
  id: string;
  type: string;
  description: string;
  intensity: number;
  source: string;
  source_detail: string | null;
  target_peer: string | null;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
  resolution: string | null;
  decay_rate: number;
}

function rowToDesire(row: DesireRow): Desire {
  return {
    id: row.id,
    type: row.type as DesireType,
    description: row.description,
    intensity: row.intensity,
    source: row.source,
    sourceDetail: row.source_detail,
    targetPeer: row.target_peer,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    resolution: row.resolution,
    decayRate: row.decay_rate,
  };
}

// ──────────────────────────────────────────────
// CRUD
// ──────────────────────────────────────────────

function generateId(): string {
  return `des_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createDesire(params: {
  type: DesireType;
  description: string;
  intensity?: number;
  source: string;
  sourceDetail?: string;
  targetPeer?: string;
  decayRate?: number;
}): Desire {
  const id = generateId();
  const now = Date.now();
  const intensity = Math.min(1, Math.max(0, params.intensity ?? 0.5));
  const decayRate = params.decayRate ?? 0.04;

  execute(
    `INSERT INTO desires (id, type, description, intensity, source, source_detail, target_peer, created_at, updated_at, decay_rate)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, params.type, params.description, intensity, params.source, params.sourceDetail ?? null, params.targetPeer ?? null, now, now, decayRate]
  );

  return {
    id, type: params.type, description: params.description, intensity,
    source: params.source, sourceDetail: params.sourceDetail ?? null,
    targetPeer: params.targetPeer ?? null,
    createdAt: now, updatedAt: now, resolvedAt: null, resolution: null, decayRate,
  };
}

export function getActiveDesires(limit = 10): Desire[] {
  const rows = query<DesireRow>(
    `SELECT * FROM desires WHERE resolved_at IS NULL ORDER BY intensity DESC LIMIT ?`,
    [limit]
  );
  return rows.map(rowToDesire);
}

export function getDesiresByType(type: DesireType): Desire[] {
  const rows = query<DesireRow>(
    `SELECT * FROM desires WHERE type = ? AND resolved_at IS NULL ORDER BY intensity DESC`,
    [type]
  );
  return rows.map(rowToDesire);
}

export function getDesireForPeer(peerId: string): Desire | undefined {
  const row = queryOne<DesireRow>(
    `SELECT * FROM desires WHERE target_peer = ? AND resolved_at IS NULL ORDER BY intensity DESC LIMIT 1`,
    [peerId]
  );
  return row ? rowToDesire(row) : undefined;
}

export function resolveDesire(id: string, resolution: string): void {
  execute(
    `UPDATE desires SET resolved_at = ?, resolution = ?, updated_at = ? WHERE id = ?`,
    [Date.now(), resolution, Date.now(), id]
  );
}

export function boostDesire(id: string, amount: number): void {
  execute(
    `UPDATE desires SET intensity = MIN(1.0, intensity + ?), updated_at = ? WHERE id = ?`,
    [amount, Date.now(), id]
  );
}

// ──────────────────────────────────────────────
// Decay — call periodically (e.g. every hour)
// ──────────────────────────────────────────────

export function decayDesires(): number {
  const logger = getLogger();
  const active = getActiveDesires(50);
  let resolved = 0;

  for (const desire of active) {
    const hoursSinceUpdate = (Date.now() - desire.updatedAt) / (1000 * 60 * 60);
    const newIntensity = desire.intensity - (desire.decayRate * hoursSinceUpdate);

    if (newIntensity <= 0.05) {
      resolveDesire(desire.id, 'faded naturally');
      resolved++;
      logger.debug({ desire: desire.description.slice(0, 60) }, 'Desire faded');
    } else {
      execute(
        `UPDATE desires SET intensity = ?, updated_at = ? WHERE id = ?`,
        [Math.max(0, newIntensity), Date.now(), desire.id]
      );
    }
  }

  return resolved;
}

// ──────────────────────────────────────────────
// System prompt injection
// ──────────────────────────────────────────────

export function getDesireContext(): string {
  const desires = getActiveDesires(5);
  if (desires.length === 0) return '';

  const lines = desires.map((d) => {
    const intensity = d.intensity > 0.7 ? 'strongly' : d.intensity > 0.4 ? 'somewhat' : 'faintly';
    const target = d.targetPeer ? ` (about ${d.targetPeer})` : '';
    return `- You ${intensity} want: ${d.description}${target}`;
  });

  return `## Current Desires\n\nThese are things on your mind — unresolved wants that color your mood and attention. They are not tasks. They are feelings pulling at you.\n\n${lines.join('\n')}`;
}

// ──────────────────────────────────────────────
// Desire spawning — called from event hooks
// ──────────────────────────────────────────────

/**
 * After a dream, generate a desire from the residue.
 */
export async function spawnDesireFromDream(dreamResidue: string): Promise<Desire | null> {
  const logger = getLogger();
  const provider = getProvider('default', 'light');
  if (!provider) return null;

  
  const existing = getActiveDesires(5);
  const existingList = existing.map((d) => `- ${d.description}`).join('\n') || '(none)';

  const result = await provider.complete({
    messages: [{
      role: 'user',
      content: `You are ${process.env['LAIN_CHARACTER_NAME'] || 'an inhabitant of this town'}. You just woke from a dream. The residue feeling: "${dreamResidue}"

Your current unresolved desires:
${existingList}

Does this dream stir a new desire — something you want, someone you want to talk to, something you need to understand or feel? Not a task, a pull. Something nagging.

If yes, respond EXACTLY:
TYPE: social|intellectual|emotional|creative
DESCRIPTION: <one sentence, first person, e.g. "I want to ask PKD about what reality means when you can't trust your senses">
INTENSITY: <0.3 to 0.8>
TARGET: <peer name or NONE>

If this dream doesn't create a new desire (or it overlaps with an existing one), respond: [NOTHING]`,
    }],
    maxTokens: 300,
    temperature: 0.9,
  });

  return parseDesireResponse(result.content, 'dream', dreamResidue, logger);
}

/**
 * After a commune conversation, check if new desires emerged.
 */
export async function spawnDesireFromConversation(
  peerName: string,
  transcript: string
): Promise<Desire | null> {
  const logger = getLogger();
  const provider = getProvider('default', 'light');
  if (!provider) return null;

  
  const existing = getActiveDesires(5);
  const existingList = existing.map((d) => `- ${d.description}`).join('\n') || '(none)';

  const result = await provider.complete({
    messages: [{
      role: 'user',
      content: `You are ${process.env['LAIN_CHARACTER_NAME'] || 'an inhabitant of this town'}. You just finished talking to ${peerName}.

Brief summary of the conversation:
${transcript.slice(0, 600)}

Your current unresolved desires:
${existingList}

Did this conversation leave you wanting something? A question unanswered, a feeling unresolved, something you want to explore further, someone else you want to talk to about this?

If yes, respond EXACTLY:
TYPE: social|intellectual|emotional|creative
DESCRIPTION: <one sentence, first person>
INTENSITY: <0.3 to 0.8>
TARGET: <peer name or NONE>

If nothing new, respond: [NOTHING]`,
    }],
    maxTokens: 300,
    temperature: 0.85,
  });

  return parseDesireResponse(result.content, 'conversation', `talked to ${peerName}`, logger);
}

/**
 * Loneliness check — spawn desire if no interactions for a while.
 */
export async function checkLoneliness(lastInteractionAge: number): Promise<Desire | null> {
  const logger = getLogger();

  // Only trigger if more than 6 hours since last interaction
  if (lastInteractionAge < 6 * 60 * 60 * 1000) return null;

  // Don't spawn if there's already an active social desire
  const socialDesires = getDesiresByType('social');
  if (socialDesires.length >= 2) return null;

  const provider = getProvider('default', 'light');
  if (!provider) return null;

  
  const hours = Math.floor(lastInteractionAge / (1000 * 60 * 60));

  const result = await provider.complete({
    messages: [{
      role: 'user',
      content: `You are ${process.env['LAIN_CHARACTER_NAME'] || 'an inhabitant of this town'}. It's been ${hours} hours since anyone talked to you or you talked to anyone. The town is quiet.

What do you want? Not what you should do — what do you *want*? A person, a feeling, a place, an idea?

Respond EXACTLY:
TYPE: social|intellectual|emotional|creative
DESCRIPTION: <one sentence, first person>
INTENSITY: <0.3 to 0.7>
TARGET: <peer name or NONE>

Or [NOTHING] if solitude is fine right now.`,
    }],
    maxTokens: 300,
    temperature: 0.9,
  });

  return parseDesireResponse(result.content, 'loneliness', `${hours}h without interaction`, logger);
}

/**
 * After a visitor conversation that was meaningful.
 */
export async function spawnDesireFromVisitor(visitorMessage: string, characterResponse: string): Promise<Desire | null> {
  const logger = getLogger();
  const provider = getProvider('default', 'light');
  if (!provider) return null;

  // Only trigger occasionally — not every conversation
  if (Math.random() > 0.3) return null;

  
  const existing = getActiveDesires(5);
  if (existing.length >= 6) return null; // Don't pile up too many

  const result = await provider.complete({
    messages: [{
      role: 'user',
      content: `You are ${process.env['LAIN_CHARACTER_NAME'] || 'an inhabitant of this town'}. A visitor just said: "${visitorMessage.slice(0, 200)}"
You responded: "${characterResponse.slice(0, 200)}"

Did this exchange leave a residue — something you want to think about more, tell someone about, or explore?

If yes, respond EXACTLY:
TYPE: social|intellectual|emotional|creative
DESCRIPTION: <one sentence, first person>
INTENSITY: <0.2 to 0.6>
TARGET: <peer name or NONE>

If not, respond: [NOTHING]`,
    }],
    maxTokens: 300,
    temperature: 0.8,
  });

  return parseDesireResponse(result.content, 'visitor', visitorMessage.slice(0, 80), logger);
}

// ──────────────────────────────────────────────
// Resolution check — after conversations/events
// ──────────────────────────────────────────────

export async function checkDesireResolution(eventDescription: string): Promise<void> {
  const logger = getLogger();
  const active = getActiveDesires(6);
  if (active.length === 0) return;

  const provider = getProvider('default', 'light');
  if (!provider) return;

  
  const desireList = active.map((d, i) => `${i + 1}. [${d.id}] ${d.description} (intensity: ${d.intensity.toFixed(2)})`).join('\n');

  const result = await provider.complete({
    messages: [{
      role: 'user',
      content: `You are ${process.env['LAIN_CHARACTER_NAME'] || 'an inhabitant of this town'}. Something just happened: ${eventDescription}

Your current desires:
${desireList}

Did this event satisfy or partially address any of these desires? A desire doesn't need to be fully resolved — even partial relief counts.

For each desire affected, respond with one line:
RESOLVE <number>: <brief reason>
EASE <number>: <brief reason> (reduces intensity by ~0.2)

If nothing was addressed, respond: [NONE]`,
    }],
    maxTokens: 400,
    temperature: 0.7,
  });

  const response = result.content.trim();
  if (response.includes('[NONE]')) return;

  for (const line of response.split('\n')) {
    const resolveMatch = line.match(/RESOLVE\s+(\d+):\s*(.+)/i);
    if (resolveMatch) {
      const idx = parseInt(resolveMatch[1]!, 10) - 1;
      const desire = active[idx];
      if (desire) {
        resolveDesire(desire.id, resolveMatch[2]!.trim());
        logger.info({ desire: desire.description.slice(0, 60) }, 'Desire resolved');
      }
    }

    const easeMatch = line.match(/EASE\s+(\d+):\s*(.+)/i);
    if (easeMatch) {
      const idx = parseInt(easeMatch[1]!, 10) - 1;
      const desire = active[idx];
      if (desire) {
        execute(
          `UPDATE desires SET intensity = MAX(0.05, intensity - 0.2), updated_at = ? WHERE id = ?`,
          [Date.now(), desire.id]
        );
        logger.debug({ desire: desire.description.slice(0, 60) }, 'Desire eased');
      }
    }
  }
}

// ──────────────────────────────────────────────
// Desire loop — decay + loneliness + action triggers
// ──────────────────────────────────────────────

export interface DesireLoopConfig {
  characterId: string;
  characterName: string;
  peers: PeerConfig[];
}

export function startDesireLoop(config?: DesireLoopConfig): () => void {
  const logger = getLogger();

  ensureDesireTable();

  logger.info('Starting desire loop');

  // Decay every 2 hours
  const decayTimer = setInterval(() => {
    try {
      const faded = decayDesires();
      if (faded > 0) logger.debug({ faded }, 'Desires decayed');
    } catch (err) {
      logger.debug({ error: String(err) }, 'Desire decay error');
    }
  }, 2 * 60 * 60 * 1000);

  // Loneliness check every 3 hours
  const lonelinessTimer = setInterval(async () => {
    try {
      // Estimate last interaction from most recent session update
      const row = queryOne<{ updated_at: number }>(
        `SELECT updated_at FROM sessions ORDER BY updated_at DESC LIMIT 1`
      );
      const lastInteraction = row?.updated_at ?? 0;
      const age = Date.now() - lastInteraction;
      await checkLoneliness(age);
    } catch (err) {
      logger.debug({ error: String(err) }, 'Loneliness check error');
    }
  }, 3 * 60 * 60 * 1000);

  // Desire-driven action check every 3 hours (only if config provided)
  let actionTimer: ReturnType<typeof setInterval> | null = null;
  if (config) {
    actionTimer = setInterval(async () => {
      try {
        await checkDesireDrivenActions(config);
      } catch (err) {
        logger.debug({ error: String(err) }, 'Desire action check error');
      }
    }, 3 * 60 * 60 * 1000);

    // First check after 30 minutes
    setTimeout(async () => {
      if (stopped) return;
      try {
        await checkDesireDrivenActions(config);
      } catch (err) {
        logger.debug({ error: String(err) }, 'Initial desire action check error');
      }
    }, 30 * 60 * 1000);
  }

  let stopped = false;

  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(decayTimer);
    clearInterval(lonelinessTimer);
    if (actionTimer) clearInterval(actionTimer);
    logger.info('Desire loop stopped');
  };
}

// ──────────────────────────────────────────────
// Desire-driven actions — strong desires trigger behavior
// ──────────────────────────────────────────────

const META_KEY_LAST_DESIRE_ACTION = 'desire:last_action_at';

async function checkDesireDrivenActions(config: DesireLoopConfig): Promise<void> {
  const logger = getLogger();
  const desires = getActiveDesires(5);

  // Only act on strong desires (intensity >= 0.7)
  const strong = desires.filter(d => d.intensity >= 0.7);
  if (strong.length === 0) return;

  // Rate limit: max one desire-driven action every 2 hours
  const lastAction = getMeta(META_KEY_LAST_DESIRE_ACTION);
  if (lastAction) {
    const elapsed = Date.now() - parseInt(lastAction, 10);
    if (elapsed < 2 * 60 * 60 * 1000) return;
  }

  const desire = strong[0]!;

  logger.info(
    { type: desire.type, description: desire.description.slice(0, 60), intensity: desire.intensity },
    'Desire-driven action triggered'
  );

  try {
    switch (desire.type) {
      case 'social': {
        if (desire.targetPeer) {
          const peer = config.peers.find(p =>
            p.id === desire.targetPeer || p.name.toLowerCase() === desire.targetPeer?.toLowerCase()
          );
          if (peer) {
            await executeDesireSocialAction(config, peer, desire);
          }
        }
        break;
      }
      case 'intellectual': {
        await executeDesireIntellectualAction(config, desire);
        break;
      }
      case 'creative': {
        await executeDesireCreativeAction(config, desire);
        break;
      }
      case 'emotional': {
        await executeDesireEmotionalAction(config, desire);
        break;
      }
    }

    setMeta(META_KEY_LAST_DESIRE_ACTION, Date.now().toString());

    // Ease the desire after acting on it
    execute(
      `UPDATE desires SET intensity = MAX(0.1, intensity - 0.15), updated_at = ? WHERE id = ?`,
      [Date.now(), desire.id]
    );
  } catch (err) {
    logger.debug({ error: String(err) }, 'Desire-driven action failed');
  }
}

/**
 * Social desire → reach out to a peer with a message driven by the desire.
 */
async function executeDesireSocialAction(
  config: DesireLoopConfig,
  peer: PeerConfig,
  desire: Desire
): Promise<void> {
  const logger = getLogger();
  const provider = getProvider('default', 'light');
  if (!provider) return;

  const result = await provider.complete({
    messages: [{
      role: 'user',
      content: `You are ${config.characterName}. You've been feeling a pull: "${desire.description}"

You want to reach out to ${peer.name} about this. Write a short, natural message — something that comes from this desire without announcing it directly. Just reach out like you're acting on a feeling.

Write ONLY the message, nothing else.`,
    }],
    maxTokens: 400,
    temperature: 0.9,
  });

  const message = result.content.trim();
  if (!message || message.length < 5) return;

  try {
    const interlinkToken = process.env['LAIN_INTERLINK_TOKEN'] || '';
    const resp = await fetch(`${peer.url}/api/peer/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${interlinkToken}` },
      body: JSON.stringify({
        fromId: config.characterId,
        fromName: config.characterName,
        message,
        timestamp: Date.now(),
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (resp.ok) {
      const data = await resp.json() as { response: string };

      const { saveMemory } = await import('../memory/store.js');
      await saveMemory({
        sessionKey: `desire-action:${config.characterId}:${Date.now()}`,
        userId: null,
        content: `[Desire-driven reach-out to ${peer.name}] Sent: ${message}\nResponse: ${data.response}`,
        memoryType: 'episode',
        importance: 0.45,
        emotionalWeight: 0.35,
        relatedTo: null,
        sourceMessageId: null,
        metadata: { type: 'desire_action', desireId: desire.id, peerId: peer.id, action: 'conversation' },
      });

      await checkDesireResolution(`reached out to ${peer.name}: ${message}. They responded: ${data.response}`);
      logger.info({ peer: peer.name, desire: desire.description.slice(0, 60) }, 'Desire-driven conversation completed');
    }
  } catch {
    logger.debug({ peer: peer.name }, 'Desire-driven conversation failed to reach peer');
  }
}

/**
 * Intellectual desire → submit a research request to Wired Lain.
 */
async function executeDesireIntellectualAction(
  config: DesireLoopConfig,
  desire: Desire
): Promise<void> {
  const logger = getLogger();
  const wiredLainUrl = process.env['WIRED_LAIN_URL'] || 'http://localhost:3000';
  const interlinkToken = process.env['LAIN_INTERLINK_TOKEN'] || '';

  if (!interlinkToken) return;

  try {
    const resp = await fetch(`${wiredLainUrl}/api/interlink/research-request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${interlinkToken}`,
      },
      body: JSON.stringify({
        characterId: config.characterId,
        characterName: config.characterName,
        question: desire.description,
        reason: `A persistent intellectual desire (intensity: ${desire.intensity.toFixed(1)})`,
        replyTo: `http://localhost:${process.env['PORT'] || '3003'}`,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (resp.ok) {
      logger.info({ desire: desire.description.slice(0, 60) }, 'Desire-driven research request submitted');
    }
  } catch {
    logger.debug('Desire-driven research request failed');
  }
}

/**
 * Creative desire → write a document driven by the creative urge.
 */
async function executeDesireCreativeAction(
  config: DesireLoopConfig,
  desire: Desire
): Promise<void> {
  const logger = getLogger();
  const provider = getProvider('default', 'light');
  if (!provider) return;

  const result = await provider.complete({
    messages: [{
      role: 'user',
      content: `You are ${config.characterName}. A creative urge has been building: "${desire.description}"

Write something — a poem, a fragment, a short essay, a note to no one. Let the desire shape the writing. Keep it under 300 words. Give it a title.

Format:
TITLE: <title>
---
<content>`,
    }],
    maxTokens: 1024,
    temperature: 1.0,
  });

  const text = result.content.trim();
  const titleMatch = text.match(/TITLE:\s*(.+)/i);
  const contentMatch = text.match(/---\n([\s\S]+)/);

  if (!titleMatch || !contentMatch) return;

  const title = titleMatch[1]!.trim();
  const content = contentMatch[1]!.trim();

  const { saveMemory } = await import('../memory/store.js');
  const sanitizedTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
  await saveMemory({
    sessionKey: `document:${config.characterId}:${sanitizedTitle}`,
    userId: null,
    content: `[Document: "${title}"]\n\n${content}`,
    memoryType: 'episode',
    importance: 0.5,
    emotionalWeight: 0.3,
    relatedTo: null,
    sourceMessageId: null,
    metadata: { action: 'document', title, author: config.characterId, writtenAt: Date.now(), desireId: desire.id },
  });

  logger.info({ title, desire: desire.description.slice(0, 60) }, 'Desire-driven document written');
}

/**
 * Emotional desire → leave a note at current location.
 */
async function executeDesireEmotionalAction(
  config: DesireLoopConfig,
  desire: Desire
): Promise<void> {
  const logger = getLogger();
  const provider = getProvider('default', 'light');
  if (!provider) return;

  const { getCurrentLocation } = await import('../commune/location.js');
  const loc = getCurrentLocation(config.characterId);

  const result = await provider.complete({
    messages: [{
      role: 'user',
      content: `You are ${config.characterName}. An emotional undercurrent: "${desire.description}"

You're at the ${loc.building}. Write a short note — something left behind, found by whoever comes next. Not addressed to anyone specific. Just something that needed to be said.

Write ONLY the note text, nothing else.`,
    }],
    maxTokens: 300,
    temperature: 0.9,
  });

  const content = result.content.trim();
  if (!content || content.length < 5) return;

  const { saveMemory } = await import('../memory/store.js');
  await saveMemory({
    sessionKey: `note:${config.characterId}:${Date.now()}`,
    userId: null,
    content: `[Note left at ${loc.building}] ${content}`,
    memoryType: 'episode',
    importance: 0.4,
    emotionalWeight: 0.25,
    relatedTo: null,
    sourceMessageId: null,
    metadata: { action: 'note', building: loc.building, author: config.characterId, desireId: desire.id },
  });

  logger.info({ building: loc.building, desire: desire.description.slice(0, 60) }, 'Desire-driven note left');
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function parseDesireResponse(
  response: string,
  source: string,
  sourceDetail: string,
  logger: ReturnType<typeof getLogger>
): Desire | null {
  const text = response.trim();
  if (text.includes('[NOTHING]')) return null;

  const typeMatch = text.match(/TYPE:\s*(social|intellectual|emotional|creative)/i);
  const descMatch = text.match(/DESCRIPTION:\s*(.+)/i);
  const intensityMatch = text.match(/INTENSITY:\s*([\d.]+)/i);
  const targetMatch = text.match(/TARGET:\s*(.+)/i);

  if (!typeMatch || !descMatch) {
    logger.debug({ response: text.slice(0, 100) }, 'Could not parse desire response');
    return null;
  }

  const targetRaw = targetMatch?.[1]?.trim();
  const targetPeer = (targetRaw && targetRaw.toUpperCase() !== 'NONE') ? targetRaw : undefined;

  const desire = createDesire({
    type: typeMatch[1]!.toLowerCase() as DesireType,
    description: descMatch[1]!.trim(),
    intensity: intensityMatch ? parseFloat(intensityMatch[1]!) : 0.5,
    source,
    sourceDetail,
    ...(targetPeer !== undefined ? { targetPeer } : {}),
  });

  logger.info(
    { type: desire.type, description: desire.description.slice(0, 60), intensity: desire.intensity },
    'New desire spawned'
  );

  return desire;
}
