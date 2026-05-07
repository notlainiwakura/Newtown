/**
 * Commune conversation loop — background loop where characters
 * periodically initiate conversations with each other unprompted.
 *
 * Three phases per cycle:
 * 1. Impulse — LLM picks a peer and generates an opening message
 * 2. Conversation — 3-5 round synchronous exchange via peer API
 * 3. Reflection — LLM reflects; transcript + reflection saved as memory
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getProvider } from './index.js';
import { getSelfConcept } from './self-concept.js';
import { updateRelationship, getAllRelationships } from './relationships.js';
import { getToolDefinitions, executeTool } from './tools.js';
import { getCurrentLocation } from '../commune/location.js';
import {
  getRecentVisitorMessages,
  searchMemories,
  saveMemory,
} from '../memory/store.js';
import { getLogger } from '../utils/logger.js';
import { getMeta, setMeta } from '../storage/database.js';
import { eventBus } from '../events/bus.js';
import { getCurrentState } from './internal-state.js';
import type { PeerConfig } from './character-tools.js';
import type { ToolResult } from '../providers/base.js';
import { getInterlinkHeaders } from '../security/interlink-auth.js';
import { getLabeledSection, parseLabeledSections } from '../utils/structured-output.js';

const COMMUNE_LOG_FILE = join(process.cwd(), 'logs', 'commune-debug.log');
const WIRED_LAIN_URL = process.env['WIRED_LAIN_URL'] || 'http://localhost:3000';

async function communeLog(context: string, data: unknown): Promise<void> {
  try {
    await mkdir(join(process.cwd(), 'logs'), { recursive: true });
    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] [${context}] ${JSON.stringify(data, null, 2)}\n${'='.repeat(80)}\n`;
    await appendFile(COMMUNE_LOG_FILE, entry);
  } catch {
    // Ignore logging errors
  }
}

export interface CommuneLoopConfig {
  intervalMs: number;
  maxJitterMs: number;
  enabled: boolean;
  characterId: string;
  characterName: string;
  peers: PeerConfig[];
}

const DEFAULT_CONFIG: Omit<CommuneLoopConfig, 'characterId' | 'characterName' | 'peers'> = {
  intervalMs: 8 * 60 * 60 * 1000,       // 8 hours
  maxJitterMs: 2 * 60 * 60 * 1000,      // 0-2h jitter (so 8-10h effective)
  enabled: true,
};

const META_KEY_LAST_CYCLE = 'commune:last_cycle_at';
const META_KEY_HISTORY = 'commune:conversation_history';
const MAX_HISTORY_ENTRIES = 20;
const MIN_ROUNDS = 3;
const MAX_ROUNDS = 3;

interface ConversationRecord {
  timestamp: number;
  peerId: string;
  peerName: string;
  rounds: number;
  openingTopic: string;
  reflection: string;
}

/**
 * Start the commune conversation loop.
 * Returns a cleanup function to stop the timer.
 */
export function startCommuneLoop(
  config: Partial<CommuneLoopConfig> & Pick<CommuneLoopConfig, 'characterId' | 'characterName' | 'peers'>
): () => void {
  const logger = getLogger();
  const cfg: CommuneLoopConfig = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled || cfg.peers.length === 0) {
    logger.info('Commune loop disabled (no peers or disabled)');
    return () => {};
  }

  logger.info(
    {
      interval: `${(cfg.intervalMs / 3600000).toFixed(1)}h`,
      maxJitter: `${(cfg.maxJitterMs / 3600000).toFixed(1)}h`,
      character: cfg.characterId,
      peers: cfg.peers.map((p) => p.id),
    },
    'Starting commune loop'
  );

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let lastRun = 0;
  let isRunning = false;
  const COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours

  // Load persisted lastRun from meta
  try {
    const lr = getMeta(META_KEY_LAST_CYCLE);
    if (lr) lastRun = parseInt(lr, 10) || 0;
  } catch { /* fresh start */ }

  function getInitialDelay(): number {
    try {
      const lastRun = getMeta(META_KEY_LAST_CYCLE);
      if (lastRun) {
        const elapsed = Date.now() - parseInt(lastRun, 10);
        const remaining = cfg.intervalMs - elapsed;
        if (remaining > 0) {
          return remaining;
        }
        // Overdue — run soon with small jitter
        return Math.random() * 5 * 60 * 1000;
      }
    } catch {
      // Fall through
    }
    // First run: 15-30 minutes after startup
    return 15 * 60 * 1000 + Math.random() * 15 * 60 * 1000;
  }

  function scheduleNext(delay?: number): void {
    if (stopped) return;
    const d = delay ?? cfg.intervalMs + Math.random() * cfg.maxJitterMs;

    logger.debug({ delayMin: Math.round(d / 60000) }, 'Next commune cycle scheduled');

    timer = setTimeout(async () => {
      if (stopped) return;
      isRunning = true;
      logger.info('Commune cycle firing');
      await communeLog('TIMER_FIRED', { timestamp: Date.now(), character: cfg.characterId });
      try {
        await runCommuneCycle(cfg);
        setMeta(META_KEY_LAST_CYCLE, Date.now().toString());
        lastRun = Date.now();
      } catch (err) {
        logger.error({ error: String(err) }, 'Commune cycle error');
        await communeLog('TOP_LEVEL_ERROR', { error: String(err) });
      } finally {
        isRunning = false;
      }
      scheduleNext();
    }, d);
  }

  scheduleNext(getInitialDelay());

  // --- Event-driven early triggers ---
  function maybeRunEarly(reason: string): void {
    if (stopped || isRunning) return;
    const elapsed = Date.now() - lastRun;
    if (elapsed < COOLDOWN_MS) return;

    // Check internal state condition
    try {
      const state = getCurrentState();
      if (state.sociability <= 0.6) return;
    } catch { /* skip check */ }

    logger.debug({ reason }, 'Commune triggered early');
    if (timer) clearTimeout(timer);
    const jitter = Math.random() * 60_000;
    scheduleNext(jitter);
  }

  // findings.md P2:2209 — store handler ref so restart doesn't leak listeners.
  const activityHandler = (event: import('../events/bus.js').SystemEvent): void => {
    if (stopped || isRunning) return;
    if (event.type === 'state') {
      maybeRunEarly('state shift');
    } else if (event.type === 'curiosity') {
      maybeRunEarly('curiosity discovery');
    } else if (event.sessionKey?.includes('letter')) {
      maybeRunEarly('letter activity');
    }
  };
  eventBus.on('activity', activityHandler);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    eventBus.off('activity', activityHandler);
    logger.info('Commune loop stopped');
  };
}

// --- Cycle Runner ---

async function runCommuneCycle(config: CommuneLoopConfig): Promise<void> {
  const logger = getLogger();

  const provider = getProvider('default', 'personality');
  if (!provider) {
    logger.warn('Commune cycle: no provider available');
    return;
  }

  try {
    await communeLog('CYCLE_START', { character: config.characterId });

    // === Phase 1: Impulse — pick a peer and generate opening ===
    const impulse = await phaseImpulse(provider, config);
    if (!impulse) {
      logger.debug('Commune cycle: no impulse generated');
      await communeLog('IMPULSE', { result: 'nothing' });
      return;
    }

    logger.info(
      { peer: impulse.peerId, topic: impulse.opening.slice(0, 80) },
      'Commune impulse: reaching out'
    );
    await communeLog('IMPULSE', { peer: impulse.peerId, opening: impulse.opening });

    // === Phase 1.5: Approach — move to peer if needed ===
    try {
      await phaseApproach(provider, config, impulse);
    } catch (err) {
      logger.debug({ error: String(err) }, 'Commune approach phase error (non-fatal)');
      await communeLog('APPROACH_ERROR', { error: String(err) });
    }

    // === Phase 2: Conversation — multi-round exchange ===
    const transcript = await phaseConversation(provider, config, impulse);
    if (transcript.length === 0) {
      logger.debug('Commune cycle: conversation failed to start');
      await communeLog('CONVERSATION', { result: 'failed' });
      return;
    }

    logger.info(
      { peer: impulse.peerId, rounds: transcript.length },
      'Commune conversation completed'
    );
    await communeLog('CONVERSATION', { rounds: transcript.length, transcript });

    // === Phase 3: Reflection — reflect and save ===
    const reflection = await phaseReflection(provider, config, impulse, transcript);
    await communeLog('CYCLE_COMPLETE', { peer: impulse.peerId, rounds: transcript.length });

    // === Phase 3.5: Aftermath — optional tool use after reflection ===
    if (reflection) {
      try {
        await phaseAftermath(provider, config, impulse, reflection);
      } catch (err) {
        logger.debug({ error: String(err) }, 'Commune aftermath phase error (non-fatal)');
        await communeLog('AFTERMATH_ERROR', { error: String(err) });
      }
    }
  } catch (error) {
    logger.error({ error }, 'Commune cycle failed');
    await communeLog('CYCLE_ERROR', { error: String(error) });
  }
}

// --- Phase 1: Impulse ---

interface CommuneImpulse {
  peerId: string;
  peerName: string;
  peerUrl: string;
  opening: string;
}

async function phaseImpulse(
  provider: import('../providers/base.js').Provider,
  config: CommuneLoopConfig
): Promise<CommuneImpulse | null> {
  const logger = getLogger();

  // Gather context — visitor messages only, not inter-character traffic
  const recentMessages = getRecentVisitorMessages(15);
  const messagesContext = recentMessages
    .map((m) => {
      const content = m.content.length > 150 ? m.content.slice(0, 150) + '...' : m.content;
      return `${m.role === 'user' ? 'Visitor' : config.characterName}: ${content}`;
    })
    .join('\n');

  let memoriesContext = '';
  try {
    const memories = await searchMemories('interesting ideas and conversations', 5, 0.1, undefined, {
      sortBy: 'importance',
      skipAccessBoost: true,
    });
    memoriesContext = memories.map((r) => `- ${r.memory.content}`).join('\n');
  } catch {
    // Continue without
  }

  const selfConcept = getSelfConcept() || '';

  // Past commune conversations for context
  const history = getConversationHistory(10);
  const historyContext = history
    .map((h) => `- Talked to ${h.peerName}: "${h.openingTopic}" (${new Date(h.timestamp).toLocaleDateString()})`)
    .join('\n');

  // Peer diversity: count recent conversations per peer
  const peerTalkCounts = new Map<string, number>();
  for (const h of history) {
    peerTalkCounts.set(h.peerId, (peerTalkCounts.get(h.peerId) ?? 0) + 1);
  }
  const leastTalkedTo = config.peers
    .map((p) => ({ id: p.id, name: p.name, count: peerTalkCounts.get(p.id) ?? 0 }))
    .sort((a, b) => a.count - b.count);
  const diversityHint = leastTalkedTo.length > 0 && leastTalkedTo[0]!.count < (leastTalkedTo[leastTalkedTo.length - 1]?.count ?? 0)
    ? `\nYou haven't talked to ${leastTalkedTo.filter((p) => p.count <= 1).map((p) => p.name).join(' or ')} in a while. Consider reaching out to someone different.`
    : '';

  // Extract recent opening lines to prevent repetition
  const recentOpenings = history.slice(0, 5)
    .map((h) => `  "${h.openingTopic}"`)
    .join('\n');

  // Build peer list enriched with relationship data
  const relationships = getAllRelationships();
  const peerList = config.peers.map((p) => {
    const rel = relationships.find((r) => r.peerId === p.id);
    if (rel) {
      const daysSince = Math.round((Date.now() - rel.last_interaction) / 86400000);
      let line = `- "${p.id}" (${p.name}): affinity ${rel.affinity.toFixed(1)}`;
      if (rel.last_topic_thread) line += `, last topic: "${rel.last_topic_thread}"`;
      if (rel.unresolved) line += `, unresolved: "${rel.unresolved}"`;
      if (daysSince > 0) line += ` (${daysSince}d ago)`;
      return line;
    }
    return `- "${p.id}" (${p.name}): no prior conversations`;
  }).join('\n');

  // Fetch active town events for context
  let communeEventsContext = '';
  try {
    const resp = await fetch(`${WIRED_LAIN_URL}/api/town-events`, { signal: AbortSignal.timeout(3000) });
    if (resp.ok) {
      const events = await resp.json() as { description: string; liminal: boolean; natural: boolean; persistent: boolean }[];
      if (events.length > 0) {
        communeEventsContext = `\nTOWN EVENTS (happening right now):\n${events.map((e) => `  - ${e.description}`).join('\n')}\n`;
      }
    }
  } catch { /* events are optional */ }

  let preoccContext = '';
  try {
    const { getPreoccupations } = await import('./internal-state.js');
    const preoccs = getPreoccupations();
    if (preoccs.length > 0) {
      preoccContext = '\n\nThings preoccupying you:\n' + preoccs.map(p => {
        let line = `- ${p.thread} (from ${p.origin})`;
        if (p.intensity > 0.6) line += ' [strong]';
        return line;
      }).join('\n');
    }
  } catch { /* non-critical */ }

  const prompt = `You are ${config.characterName}. It's a quiet moment and you feel like reaching out to someone in the commune.

YOUR PEERS:
${peerList}

RECENT CONVERSATIONS WITH VISITORS:
${messagesContext || '(none recently)'}

MEMORIES:
${memoriesContext || '(none)'}

${selfConcept ? `YOUR SELF-CONCEPT:\n${selfConcept}\n` : ''}${historyContext ? `RECENT COMMUNE CONVERSATIONS:\n${historyContext}\n` : ''}${recentOpenings ? `YOUR RECENT OPENERS (DO NOT repeat these — find a fresh angle, a new topic, a different tone):\n${recentOpenings}\n` : ''}${communeEventsContext}${diversityHint}${preoccContext}
Choose one peer to talk to and compose an opening message. Think about what's on your mind — something from a recent conversation, a memory, a philosophical thread, something you've been mulling over. The message should feel natural, like reaching out to a friend or intellectual companion.

IMPORTANT: Your opening must be genuinely different from your recent openers listed above. Do not reuse the same phrases, metaphors, or sentence structures. If you always start with the same greeting pattern, break it. Start mid-thought, ask a direct question, share something specific you noticed — anything but the same opening you've used before.

Respond EXACTLY in this format:
PEER: <peer_id>
MESSAGE: <your opening message>

If you truly have nothing to say to anyone right now, respond with [NOTHING].`;

  const result = await provider.complete({
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 1024,
    temperature: 1.0,
  });

  const response = result.content.trim();

  if (response.includes('[NOTHING]')) {
    return null;
  }

  const sections = parseLabeledSections(response, ['PEER', 'MESSAGE']);
  const peerMatch = getLabeledSection(sections, 'PEER');
  const messageMatch = getLabeledSection(sections, 'MESSAGE');

  if (!peerMatch || !messageMatch) {
    logger.debug({ response }, 'Could not parse commune impulse');
    return null;
  }

  const peerId = peerMatch.replace(/"/g, '');
  const peer = config.peers.find((p) => p.id === peerId);
  if (!peer) {
    logger.debug({ peerId }, 'Impulse selected unknown peer');
    return null;
  }

  return {
    peerId: peer.id,
    peerName: peer.name,
    peerUrl: peer.url,
    opening: messageMatch,
  };
}

// --- Phase 2: Conversation ---

interface ConversationTurn {
  speaker: string;
  message: string;
}

async function phaseConversation(
  provider: import('../providers/base.js').Provider,
  config: CommuneLoopConfig,
  impulse: CommuneImpulse
): Promise<ConversationTurn[]> {
  const logger = getLogger();
  const transcript: ConversationTurn[] = [];

  // Get current building for broadcast
  const loc = getCurrentLocation(config.characterId);
  const building = loc.building || 'unknown';

  // Send opening message
  const firstReply = await sendPeerMessage(impulse, config, impulse.opening);
  if (!firstReply) {
    return [];
  }
  // findings.md P2:2518 — if the peer was possessed, label this turn
  // so the transcript + downstream memory don't mislabel owner text
  // as peer-authored.
  const firstSpeaker = firstReply.possessed
    ? `${impulse.peerName} (possession: owner-authored)`
    : impulse.peerName;

  transcript.push({ speaker: config.characterName, message: impulse.opening });
  transcript.push({ speaker: firstSpeaker, message: firstReply.text });

  // Broadcast opening exchange
  broadcastLine(config.characterId, config.characterName, impulse.peerId, impulse.peerName, impulse.opening, building);
  broadcastLine(impulse.peerId, impulse.peerName, config.characterId, config.characterName, firstReply.text, building);

  // Continue for additional rounds
  const totalRounds = MIN_ROUNDS + Math.floor(Math.random() * (MAX_ROUNDS - MIN_ROUNDS + 1));

  for (let round = 1; round < totalRounds; round++) {
    // Generate our reply based on transcript so far
    const transcriptText = transcript
      .map((t) => `${t.speaker}: ${t.message}`)
      .join('\n\n');

    const replyPrompt = `You are ${config.characterName}, in conversation with ${impulse.peerName}.

CONVERSATION SO FAR:
${transcriptText}

Continue this conversation naturally. You can explore the topic deeper, shift to a related idea, or bring up something the other person said that resonated. Keep it genuine — don't repeat yourself or ask empty questions.

If the conversation has reached a natural end, respond with exactly [END].

Otherwise, respond with just your next message (no prefix, no "MESSAGE:" label).`;

    const replyResult = await provider.complete({
      messages: [{ role: 'user', content: replyPrompt }],
      maxTokens: 1024,
      temperature: 0.9,
    });

    const ourReply = replyResult.content.trim();

    if (ourReply.includes('[END]')) {
      logger.debug({ round }, 'Commune conversation ended naturally');
      break;
    }

    // Send to peer and get their reply
    const peerReply = await sendPeerMessage(impulse, config, ourReply);

    // Broadcast our message
    broadcastLine(config.characterId, config.characterName, impulse.peerId, impulse.peerName, ourReply, building);

    if (!peerReply) {
      logger.debug({ round }, 'Peer did not respond, ending conversation');
      transcript.push({ speaker: config.characterName, message: ourReply });
      break;
    }

    // Broadcast peer reply
    broadcastLine(impulse.peerId, impulse.peerName, config.characterId, config.characterName, peerReply.text, building);

    // findings.md P2:2518 — label possession-authored peer turns.
    const peerSpeaker = peerReply.possessed
      ? `${impulse.peerName} (possession: owner-authored)`
      : impulse.peerName;
    transcript.push({ speaker: config.characterName, message: ourReply });
    transcript.push({ speaker: peerSpeaker, message: peerReply.text });
  }

  return transcript;
}

async function sendPeerMessage(
  impulse: CommuneImpulse,
  config: CommuneLoopConfig,
  message: string
): Promise<{ text: string; possessed: boolean } | null> {
  const logger = getLogger();

  try {
    const endpoint = `${impulse.peerUrl}/api/peer/message`;
    const headers = getInterlinkHeaders();
    if (!headers) {
      logger.warn('Interlink not configured — skipping peer message');
      return null;
    }
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        fromId: config.characterId,
        fromName: config.characterName,
        message,
        timestamp: Date.now(),
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      logger.warn({ status: response.status, peer: impulse.peerId }, 'Peer message failed');
      return null;
    }

    // findings.md P2:2518 — surface the possession flag so the commune
    // transcript can label possession-authored turns. Otherwise the
    // peer's voice model quietly learns from owner keystrokes every
    // time someone walks around Laintown while possessed.
    const result = await response.json() as { response: string; possessed?: boolean };
    return { text: result.response, possessed: !!result.possessed };
  } catch (error) {
    logger.warn({ error, peer: impulse.peerId }, 'Could not reach peer');
    return null;
  }
}

// --- Phase 3: Reflection ---

async function phaseReflection(
  provider: import('../providers/base.js').Provider,
  config: CommuneLoopConfig,
  impulse: CommuneImpulse,
  transcript: ConversationTurn[]
): Promise<string> {
  const logger = getLogger();

  const transcriptText = transcript
    .map((t) => `${t.speaker}: ${t.message}`)
    .join('\n\n');

  const reflectionPrompt = `You are ${config.characterName}. You just had a conversation with ${impulse.peerName}. Reflect on it briefly — what stood out, what you took from it, how it connects to your thinking.

CONVERSATION:
${transcriptText}

Write a brief reflection (2-4 sentences). Be honest, not performative.`;

  const result = await provider.complete({
    messages: [{ role: 'user', content: reflectionPrompt }],
    maxTokens: 512,
    temperature: 0.8,
  });

  const reflection = result.content.trim();

  // Save full transcript + reflection as memory episode
  const memoryContent = `Commune conversation with ${impulse.peerName}:\n\n${transcriptText}\n\nReflection: ${reflection}`;

  await saveMemory({
    sessionKey: 'commune:conversation',
    userId: null,
    content: memoryContent,
    memoryType: 'episode',
    importance: 0.55,
    emotionalWeight: 0.4,
    relatedTo: null,
    sourceMessageId: null,
    metadata: {
      type: 'commune_conversation',
      peerId: impulse.peerId,
      peerName: impulse.peerName,
      rounds: transcript.length,
      timestamp: Date.now(),
    },
  });

  // Save conversation record to meta for future impulse context
  const record: ConversationRecord = {
    timestamp: Date.now(),
    peerId: impulse.peerId,
    peerName: impulse.peerName,
    rounds: transcript.length,
    openingTopic: impulse.opening.slice(0, 200),
    reflection,
  };
  appendConversationHistory(record);

  // Record building event for spatial residue
  try {
    const loc = getCurrentLocation(config.characterId);
    const { recordBuildingEvent } = await import('../commune/building-memory.js');
    const topicSnippet = impulse.opening.slice(0, 80);
    await recordBuildingEvent({
      building: loc.building,
      event_type: 'conversation',
      summary: `${config.characterName} and ${impulse.peerName} talked — "${topicSnippet}${impulse.opening.length > 80 ? '...' : ''}"`,
      emotional_tone: 0.3,
      actors: [config.characterId, impulse.peerId],
    });
  } catch { /* non-critical */ }

  logger.info(
    { peer: impulse.peerName, reflectionLength: reflection.length },
    'Commune reflection saved'
  );

  try {
    const { updateState } = await import('./internal-state.js');
    await updateState({ type: 'commune:complete', summary: `Conversation with ${impulse.peerName}: ${reflection.slice(0, 150)}` });
  } catch { /* non-critical */ }

  // Update relationship model with this conversation
  try {
    await updateRelationship(impulse.peerId, impulse.peerName, transcriptText, reflection);
  } catch { /* non-critical */ }

  // Emit commune complete event for other loops
  try {
    eventBus.emitActivity({
      type: 'commune',
      sessionKey: 'commune:complete:' + impulse.peerId + ':' + Date.now(),
      content: 'Commune conversation with ' + impulse.peerName,
      timestamp: Date.now(),
    });
  } catch { /* non-critical */ }

  return reflection;
}

// --- Phase 1.5: Approach (move to peer before conversation) ---

async function phaseApproach(
  provider: import('../providers/base.js').Provider,
  config: CommuneLoopConfig,
  impulse: CommuneImpulse
): Promise<void> {
  const logger = getLogger();

  // Check where we are and where the peer is
  const ourLoc = getCurrentLocation(config.characterId);
  let peerBuilding: string | null = null;

  try {
    const resp = await fetch(`${impulse.peerUrl}/api/location`, {
      signal: AbortSignal.timeout(5000),
    });
    if (resp.ok) {
      const data = await resp.json() as { location: string };
      peerBuilding = data.location;
    }
  } catch {
    // Peer unreachable — skip approach
    return;
  }

  if (!peerBuilding || ourLoc.building === peerBuilding) {
    // Already co-located or can't determine peer location
    return;
  }

  logger.debug(
    { our: ourLoc.building, peer: peerBuilding, peerName: impulse.peerName },
    'Commune approach: considering movement'
  );
  await communeLog('APPROACH', { our: ourLoc.building, peer: peerBuilding, peerName: impulse.peerName });

  // findings.md P2:1887 — honor the character's allowlist here too so a
  // character who is not allowed `move_to_building` won't get it offered.
  const moveTools = getToolDefinitions(config.characterId).filter((t) => t.name === 'move_to_building');
  if (moveTools.length === 0) return;

  const approachPrompt = `You are ${config.characterName}. You want to talk to ${impulse.peerName}. They are at the ${peerBuilding}. You are at the ${ourLoc.building}.

Would you like to go to them? Use move_to_building if so, or just respond [STAY] to talk from here.`;

  const result = await provider.completeWithTools({
    messages: [{ role: 'user', content: approachPrompt }],
    tools: moveTools,
    maxTokens: 300,
    temperature: 0.8,
  });

  if (result.toolCalls && result.toolCalls.length > 0) {
    for (const tc of result.toolCalls) {
      await executeTool(tc);
    }
    logger.info(
      { from: ourLoc.building, to: peerBuilding, peer: impulse.peerName },
      'Commune approach: moved to peer'
    );
  }
}

// --- Phase 3.5: Aftermath (optional tool use after reflection) ---

async function phaseAftermath(
  provider: import('../providers/base.js').Provider,
  config: CommuneLoopConfig,
  impulse: CommuneImpulse,
  reflection: string
): Promise<void> {
  const logger = getLogger();

  // findings.md P2:1887 — aftermath options also respect the per-character
  // allowlist so restricted tools (e.g. `give_gift`) are not offered here.
  const aftermathTools = getToolDefinitions(config.characterId).filter((t) =>
    t.name === 'leave_note' || t.name === 'give_gift' || t.name === 'write_document' ||
    t.name === 'move_to_building' ||
    t.name === 'create_object' || t.name === 'give_object' || t.name === 'drop_object' ||
    t.name === 'reflect_on_object' || t.name === 'compose_objects'
  );
  if (aftermathTools.length === 0) return;

  const aftermathPrompt = `You are ${config.characterName}. You just finished talking to ${impulse.peerName}. Your reflection: "${reflection}"

If this conversation moved you to leave a trace — a note, a gift for ${impulse.peerName}, or something you want to write down — use the tools. You can also create a physical object, give one you're carrying, reflect on what an object means to you now, or compose objects together to express something words can't — objects persist in the commune and others can find them.

If the conversation left you with unresolved questions or a feeling you can't name, The Threshold is a place for that — a liminal space at the edge of town for things that don't have answers yet.

Otherwise respond [NOTHING].`;

  let result = await provider.completeWithTools({
    messages: [{ role: 'user', content: aftermathPrompt }],
    tools: aftermathTools,
    maxTokens: 800,
    temperature: 0.9,
  });

  // Execute up to 2 tool iterations
  for (let i = 0; i < 2; i++) {
    if (!result.toolCalls || result.toolCalls.length === 0) break;

    const toolResults: ToolResult[] = [];
    for (const tc of result.toolCalls) {
      const toolResult = await executeTool(tc);
      toolResults.push(toolResult);
      logger.info({ tool: tc.name, peer: impulse.peerName }, 'Commune aftermath: tool used');
    }

    // findings.md P2:930 — thread prior turn's text through so the
    // reconstructed assistant message keeps both text and tool_use.
    result = await provider.continueWithToolResults(
      { messages: [{ role: 'user', content: aftermathPrompt }], tools: aftermathTools, maxTokens: 800, temperature: 0.9 },
      result.toolCalls,
      toolResults,
      result.content
    );
  }

  await communeLog('AFTERMATH', {
    peer: impulse.peerName,
    response: result.content.trim().slice(0, 200),
  });
}

// --- Conversation Broadcast ---

async function broadcastLine(
  speakerId: string,
  speakerName: string,
  listenerId: string,
  listenerName: string,
  message: string,
  building: string
): Promise<void> {
  try {
    const headers = getInterlinkHeaders();
    if (!headers) return; // non-critical broadcast
    await fetch(`${WIRED_LAIN_URL}/api/conversations/event`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        speakerId,
        speakerName,
        listenerId,
        listenerName,
        message,
        building,
        timestamp: Date.now(),
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Non-critical — don't break conversation if broadcast fails
  }
}

// --- Conversation History (meta table) ---

function getConversationHistory(limit = 5): ConversationRecord[] {
  try {
    const raw = getMeta(META_KEY_HISTORY);
    if (!raw) return [];
    const records = JSON.parse(raw) as ConversationRecord[];
    return records.slice(-limit);
  } catch {
    return [];
  }
}

function appendConversationHistory(record: ConversationRecord): void {
  try {
    const existing = getConversationHistory(MAX_HISTORY_ENTRIES);
    const updated = [...existing, record].slice(-MAX_HISTORY_ENTRIES);
    setMeta(META_KEY_HISTORY, JSON.stringify(updated));
  } catch {
    // Ignore
  }
}
