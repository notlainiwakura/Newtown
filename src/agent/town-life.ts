/**
 * Town Life Loop — periodic "quiet moments" where the LLM gets tools
 * and autonomously decides to wander, leave notes, write documents,
 * or give gifts. This is the character's inner life manifesting in
 * physical space.
 *
 * Three phases per cycle:
 * 1. Awareness — gather context (location, time, memories, nearby peers, notes)
 * 2. Impulse — tool-aware LLM call with curated subset of commune tools
 * 3. Record — save inner thought as memory, track recent actions
 */

import { getProvider } from './index.js';
import { getSelfConcept } from './self-concept.js';
import { getToolDefinitions, executeTool } from './tools.js';
import { searchMemories, saveMemory } from '../memory/store.js';
import { getCurrentLocation, getLocationHistory } from '../commune/location.js';
import { BUILDING_MAP, isValidBuilding } from '../commune/buildings.js';
import { getLogger } from '../utils/logger.js';
import { getMeta, setMeta } from '../storage/database.js';
import { setCurrentLocation } from '../commune/location.js';
import { eventBus } from '../events/bus.js';
import type { PeerConfig } from './character-tools.js';
import type { ToolResult } from '../providers/base.js';
import type { TownEvent, EventEffects } from '../events/town-events.js';
import { getInterlinkHeaders } from '../security/interlink-auth.js';

export interface TownLifeConfig {
  intervalMs: number;
  maxJitterMs: number;
  enabled: boolean;
  characterId: string;
  characterName: string;
  peers: PeerConfig[];
}

const DEFAULT_CONFIG: Omit<TownLifeConfig, 'characterId' | 'characterName' | 'peers'> = {
  intervalMs: 6 * 60 * 60 * 1000,       // 6 hours
  maxJitterMs: 2 * 60 * 60 * 1000,      // 0-2h jitter (so 6-8h effective)
  enabled: true,
};

const META_KEY_LAST_CYCLE = 'townlife:last_cycle_at';
const META_KEY_RECENT_ACTIONS = 'townlife:recent_actions';
const MAX_RECENT_ACTIONS = 5;
const MAX_TOOL_ITERATIONS = 3;

const TOWN_LIFE_TOOLS = new Set([
  'move_to_building', 'leave_note', 'write_document', 'give_gift', 'recall', 'read_document',
  'create_object', 'examine_objects', 'pickup_object', 'drop_object', 'give_object', 'destroy_object',
  'reflect_on_object', 'compose_objects',
]);

interface ActionRecord {
  timestamp: number;
  actions: string[];
  building: string;
  innerThought: string;
}

/**
 * Start the town life loop.
 * Returns a cleanup function to stop the timer.
 */
export function startTownLifeLoop(
  config: Partial<TownLifeConfig> & Pick<TownLifeConfig, 'characterId' | 'characterName' | 'peers'>
): () => void {
  const logger = getLogger();
  const cfg: TownLifeConfig = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled) {
    logger.info('Town life loop disabled');
    return () => {};
  }

  logger.info(
    {
      interval: `${(cfg.intervalMs / 3600000).toFixed(1)}h`,
      maxJitter: `${(cfg.maxJitterMs / 3600000).toFixed(1)}h`,
      character: cfg.characterId,
    },
    'Starting town life loop'
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
    // First run: 20-40 minutes after startup
    return 20 * 60 * 1000 + Math.random() * 20 * 60 * 1000;
  }

  function scheduleNext(delay?: number): void {
    if (stopped) return;
    const d = delay ?? cfg.intervalMs + Math.random() * cfg.maxJitterMs;

    logger.debug({ delayMin: Math.round(d / 60000) }, 'Next town life cycle scheduled');

    timer = setTimeout(async () => {
      if (stopped) return;
      isRunning = true;
      logger.info('Town life cycle firing');
      try {
        await runTownLifeCycle(cfg);
        setMeta(META_KEY_LAST_CYCLE, Date.now().toString());
        lastRun = Date.now();
      } catch (err) {
        logger.error({ error: String(err) }, 'Town life cycle error');
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

    // No condition check — any relevant trigger is enough
    logger.debug({ reason }, 'Town life triggered early');
    if (timer) clearTimeout(timer);
    const jitter = Math.random() * 60_000;
    scheduleNext(jitter);
  }

  // findings.md P2:2209 — previously added an anonymous handler that was
  // never removed on loop restart (possession end re-invokes startTownLife
  // LoopLoop), so duplicate listeners accumulated. Keep the reference so
  // the cleanup closure can detach it.
  const activityHandler = (event: import('../events/bus.js').SystemEvent): void => {
    if (stopped || isRunning) return;
    if (event.type === 'commune' || event.type === 'state' || event.type === 'weather') {
      maybeRunEarly(event.type + ' event');
    }
  };
  eventBus.on('activity', activityHandler);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    eventBus.off('activity', activityHandler);
    logger.info('Town life loop stopped');
  };
}

// --- Time helpers ---

function getTimeOfDay(): 'dawn' | 'day' | 'dusk' | 'night' {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 8) return 'dawn';
  if (hour >= 8 && hour < 18) return 'day';
  if (hour >= 18 && hour < 21) return 'dusk';
  return 'night';
}

function getTimeFlavor(tod: string): string {
  switch (tod) {
    case 'dawn': return 'The light is just beginning. The commune is quiet. The boundaries between sleep and waking feel thin — The Threshold hums at the edge of town.';
    case 'day': return 'The commune hums with its usual rhythms.';
    case 'dusk': return 'The light is fading. Shadows stretch between buildings. The hour feels liminal — neither day nor night. The Threshold\'s door stands slightly ajar.';
    case 'night': return 'The commune sleeps. Only the lighthouse beam sweeps the dark.';
    default: return '';
  }
}

function getTimeDescription(): string {
  const now = new Date();
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayOfWeek = days[now.getDay()]!;
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  const tod = getTimeOfDay();
  return `${dayOfWeek}, ${timeStr} (${tod})`;
}

// --- Note Discovery ---

interface DiscoveredNote {
  author: string;
  content: string;
}

async function discoverNotes(
  building: string,
  peers: PeerConfig[],
  selfId: string
): Promise<DiscoveredNote[]> {
  const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const notes: DiscoveredNote[] = [];

  // findings.md P2:2376 — peer /api/building/notes is now gated by
  // interlink auth; attach headers so authenticated discovery still works.
  const headers = getInterlinkHeaders();
  if (!headers) return notes;
  await Promise.all(peers.map(async (peer) => {
    try {
      const resp = await fetch(
        `${peer.url}/api/building/notes?building=${encodeURIComponent(building)}&since=${since}`,
        { headers, signal: AbortSignal.timeout(5000) }
      );
      if (resp.ok) {
        const peerNotes = await resp.json() as { content: string; author: string }[];
        for (const note of peerNotes) {
          if (note.author !== selfId) {
            notes.push({ author: peer.name, content: note.content });
          }
        }
      }
    } catch {
      // Peer unreachable — continue
    }
  }));

  return notes;
}

// --- Document Discovery ---

interface DiscoveredDocument {
  author: string;
  title: string;
  preview: string;
}

async function discoverDocuments(
  peers: PeerConfig[],
  selfId: string
): Promise<DiscoveredDocument[]> {
  const docs: DiscoveredDocument[] = [];

  // findings.md P2:2376 — peer /api/documents is now gated by interlink
  // auth; attach headers so authenticated discovery still works.
  const docHeaders = getInterlinkHeaders();
  if (!docHeaders) return docs;
  await Promise.all(peers.map(async (peer) => {
    try {
      const resp = await fetch(
        `${peer.url}/api/documents`,
        { headers: docHeaders, signal: AbortSignal.timeout(5000) }
      );
      if (resp.ok) {
        const peerDocs = await resp.json() as { title: string; content: string; author: string }[];
        for (const doc of peerDocs.slice(0, 5)) {
          if (doc.author !== selfId) {
            docs.push({
              author: peer.name,
              title: doc.title,
              preview: doc.content.slice(0, 120) + (doc.content.length > 120 ? '...' : ''),
            });
          }
        }
      }
    } catch {
      // Peer unreachable — continue
    }
  }));

  return docs;
}

// --- Postboard Discovery ---

interface PostboardEntry {
  author: string;
  content: string;
  pinned: boolean;
  createdAt: number;
}

async function discoverPostboard(
  peers: PeerConfig[]
): Promise<PostboardEntry[]> {
  // Try to read from any reachable peer (all share the same postboard via Wired Lain)
  // Also try our own DB first
  try {
    const { getPostboardMessages } = await import('../memory/store.js');
    const local = getPostboardMessages(undefined, 10);
    if (local.length > 0) {
      return local.map((m) => ({
        author: m.author,
        content: m.content,
        pinned: m.pinned,
        createdAt: m.createdAt,
      }));
    }
  } catch {
    // Continue to peers
  }

  for (const peer of peers) {
    try {
      const resp = await fetch(`${peer.url}/api/postboard`, {
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        const messages = await resp.json() as PostboardEntry[];
        if (messages.length > 0) return messages;
      }
    } catch {
      // Peer unreachable — try next
    }
  }

  return [];
}

// --- Nearby Peers ---

async function findNearbyPeers(
  currentBuilding: string,
  peers: PeerConfig[]
): Promise<{ id: string; name: string }[]> {
  const nearby: { id: string; name: string }[] = [];

  await Promise.all(peers.map(async (peer) => {
    try {
      const resp = await fetch(`${peer.url}/api/location`, {
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        const data = await resp.json() as { location: string };
        if (data.location === currentBuilding) {
          nearby.push({ id: peer.id, name: peer.name });
        }
      }
    } catch {
      // Peer unreachable
    }
  }));

  return nearby;
}

// --- Recent Actions ---

function getRecentActions(): ActionRecord[] {
  try {
    const raw = getMeta(META_KEY_RECENT_ACTIONS);
    if (!raw) return [];
    return JSON.parse(raw) as ActionRecord[];
  } catch {
    return [];
  }
}

function appendRecentAction(record: ActionRecord): void {
  try {
    const existing = getRecentActions();
    const updated = [...existing, record].slice(-MAX_RECENT_ACTIONS);
    setMeta(META_KEY_RECENT_ACTIONS, JSON.stringify(updated));
  } catch {
    // Ignore
  }
}

// --- Cycle Runner ---

async function runTownLifeCycle(config: TownLifeConfig): Promise<void> {
  const logger = getLogger();

  const provider = getProvider('default', 'light');
  if (!provider) {
    logger.warn('Town life cycle: no provider available');
    return;
  }

  // === Phase 1: Awareness ===
  const loc = getCurrentLocation(config.characterId);
  let building = BUILDING_MAP.get(loc.building);
  const timeOfDay = getTimeOfDay();
  const timeDesc = getTimeDescription();
  const timeFlavor = getTimeFlavor(timeOfDay);

  let memoriesContext = '';
  try {
    const memories = await searchMemories('thoughts feelings observations', 5, 0.1, undefined, {
      sortBy: 'importance',
      skipAccessBoost: true,
    });
    memoriesContext = memories.map((r) => `- ${r.memory.content}`).join('\n');
  } catch {
    // Continue without
  }

  const selfConcept = getSelfConcept() || '';

  const locationHistory = getLocationHistory(5);
  const historyContext = locationHistory
    .map((h) => `- ${h.from} → ${h.to}: ${h.reason} (${new Date(h.timestamp).toLocaleTimeString()})`)
    .join('\n');

  const nearbyPeers = await findNearbyPeers(loc.building, config.peers);
  const nearbyContext = nearbyPeers.length > 0
    ? `OTHERS HERE: ${nearbyPeers.map((p) => p.name).join(', ')}`
    : 'You are alone here.';

  const discoveredNotes = await discoverNotes(loc.building, config.peers, config.characterId);
  const notesContext = discoveredNotes.length > 0
    ? `NOTES FOUND HERE:\n${discoveredNotes.map((n) => `  [${n.author}]: ${n.content}`).join('\n')}`
    : '';

  const discoveredDocs = await discoverDocuments(config.peers, config.characterId);
  const docsContext = discoveredDocs.length > 0
    ? `WRITINGS BY OTHERS:\n${discoveredDocs.map((d) => `  [${d.author}] "${d.title}" — ${d.preview}`).join('\n')}`
    : '';

  const postboardMessages = await discoverPostboard(config.peers);
  // findings.md P2:2195 — the old "messages from the Administrator — read
  // carefully" framing was an instruction-authority amplifier: even though
  // writes require owner auth, the wording pushed the LLM to weight
  // postboard text above normal prompt content. Drop the imperative and
  // use a neutral label that still reflects the owner-only write origin.
  const postboardContext = postboardMessages.length > 0
    ? `POSTBOARD (owner notices):\n${postboardMessages.map((m) => {
        const pin = m.pinned ? ' [PINNED]' : '';
        const time = new Date(m.createdAt).toLocaleString();
        return `  ${pin} [${time}] ${m.content}`;
      }).join('\n')}`
    : '';

  const recentActions = getRecentActions();
  const actionsContext = recentActions.length > 0
    ? recentActions.map((a) => `- ${new Date(a.timestamp).toLocaleTimeString()}: ${a.actions.join(', ')} at ${a.building}${a.innerThought ? ` — "${a.innerThought}"` : ''}`).join('\n')
    : '(none)';

  // === Phase 2: Impulse ===
  // findings.md P2:1887 — intersect TOWN_LIFE_TOOLS with the character's
  // allowlist so a character restricted from (say) `give_gift` does not
  // have it offered here either.
  const tools = getToolDefinitions(config.characterId).filter((t) => TOWN_LIFE_TOOLS.has(t.name));

  // Fetch objects at current location and in inventory from Wired Lain registry
  let objectsContext = '';
  try {
    const wiredUrl = process.env['WIRED_LAIN_URL'] || 'http://localhost:3000';
    const [hereResp, invResp] = await Promise.all([
      fetch(`${wiredUrl}/api/objects?location=${encodeURIComponent(loc.building)}`, { signal: AbortSignal.timeout(5000) }).catch(() => null),
      fetch(`${wiredUrl}/api/objects?owner=${encodeURIComponent(config.characterId)}`, { signal: AbortSignal.timeout(5000) }).catch(() => null),
    ]);
    const hereObjects = hereResp?.ok ? await hereResp.json() as { id: string; name: string; description: string; creatorName: string; metadata?: Record<string, unknown> }[] : [];
    const invObjects = invResp?.ok ? await invResp.json() as { id: string; name: string; description: string; creatorName: string }[] : [];
    const parts: string[] = [];

    // Separate fixtures from loose objects
    const fixtures = hereObjects.filter((o) => o.metadata?.fixture === true);
    const looseObjects = hereObjects.filter((o) => !o.metadata?.fixture);

    if (fixtures.length > 0) {
      parts.push(`FIXTURES HERE:\n${fixtures.map((o) => `- "${o.name}" — ${o.description.slice(0, 120)}`).join('\n')}`);
    }
    if (looseObjects.length > 0) {
      parts.push(`OBJECTS HERE:\n${looseObjects.map((o) => `- [${o.id}] "${o.name}" by ${o.creatorName} — ${o.description.slice(0, 100)}`).join('\n')}`);
    }
    if (invObjects.length > 0) {
      parts.push(`YOUR INVENTORY:\n${invObjects.map((o) => `- [${o.id}] "${o.name}" — ${o.description.slice(0, 100)}`).join('\n')}`);
    }
    objectsContext = parts.join('\n\n');
  } catch { /* ignore — objects are optional context */ }

  // Fetch active town events
  let eventsContext = '';
  let activeEffects: EventEffects = {};
  try {
    const wiredUrl = process.env['WIRED_LAIN_URL'] || 'http://localhost:3000';
    // Auth the fetch even though the current endpoint is public-GET.
    // Once the endpoint is auth-gated (matching audit P1), this doesn't need
    // a follow-up change on the reader side.
    const interlinkHeaders = getInterlinkHeaders();
    const authHeaders: Record<string, string> = interlinkHeaders ?? {};
    const [evResp, efResp] = await Promise.all([
      fetch(`${wiredUrl}/api/town-events`, { headers: authHeaders, signal: AbortSignal.timeout(5000) }).catch(() => null),
      fetch(`${wiredUrl}/api/town-events/effects`, { headers: authHeaders, signal: AbortSignal.timeout(5000) }).catch(() => null),
    ]);
    const events = evResp?.ok ? await evResp.json() as TownEvent[] : [];
    activeEffects = efResp?.ok ? await efResp.json() as EventEffects : {};
    if (events.length > 0) {
      eventsContext = `TOWN EVENTS (active):\n${events.map((e) => {
        const tags: string[] = [];
        if (e.liminal) tags.push('LIMINAL');
        if (e.natural) tags.push('NATURAL');
        if (e.persistent) tags.push('ONGOING');
        const prefix = tags.length > 0 ? `[${tags.join(' · ')}] ` : '';
        return `  - ${prefix}${e.description}`;
      }).join('\n')}`;
    }
    // Force relocation if needed — only when the target is a real building.
    // Any unknown id (LLM hallucination, attacker, stale effect) is ignored
    // rather than cast through `as BuildingId` into setCurrentLocation.
    if (activeEffects.forceLocation && activeEffects.forceLocation !== loc.building) {
      if (!isValidBuilding(activeEffects.forceLocation)) {
        logger.warn(
          { forceLocation: activeEffects.forceLocation },
          'Town event: ignoring forceLocation for unknown building id',
        );
      } else {
        logger.info(
          { from: loc.building, to: activeEffects.forceLocation },
          'Town event: forced relocation'
        );
        setCurrentLocation(activeEffects.forceLocation, 'town event forced relocation');
        const newBuilding = BUILDING_MAP.get(activeEffects.forceLocation);
        loc.building = activeEffects.forceLocation;
        if (newBuilding) {
          building = newBuilding;
        }
      }
    }
  } catch { /* events are optional context */ }

  // Fetch building residue — traces of what's happened here
  let residueContext = '';
  try {
    const { buildBuildingResidueContext } = await import('../commune/building-memory.js');
    residueContext = await buildBuildingResidueContext(config.characterId);
  } catch { /* non-critical */ }

  const prompt = `You are ${config.characterName}. It is ${timeOfDay} in the commune.

CURRENT LOCATION: ${building?.name ?? loc.building} — ${building?.description ?? 'unknown'}
TIME: ${timeDesc}
${nearbyContext}
${postboardContext ? `\n${postboardContext}\n` : ''}${eventsContext ? `\n${eventsContext}\n` : ''}${notesContext ? `\n${notesContext}\n` : ''}${docsContext ? `\n${docsContext}\n` : ''}${objectsContext ? `\n${objectsContext}\n` : ''}${residueContext ? `\n${residueContext}\n` : ''}
RECENT MEMORIES:
${memoriesContext || '(none)'}

${selfConcept ? `YOUR SELF-CONCEPT:\n${selfConcept}\n` : ''}WHERE YOU'VE BEEN RECENTLY:
${historyContext || '(nowhere — you have been here a while)'}

RECENT TOWN ACTIONS:
${actionsContext}

This is a quiet moment. You can:
- Move somewhere that calls to you
- Leave a note at your current location
- Write something — an essay, poem, field report
- Read something a peer has written (use read_document if a title catches your eye)
- Give a gift to someone you've been thinking about
- Create or interact with a physical object (examine_objects to see what's here or in your inventory)
- Or simply stay where you are

Objects persist in the commune — they stay where they're left, and others can find them. If you notice something here that catches your eye, or you're carrying something that feels like it belongs somewhere, you can act on that.

There is no obligation to act. If nothing feels right, respond with just [STAY].

After acting (or staying), write a brief inner thought — one sentence about this moment.

${timeFlavor}`;

  const actionsTaken: string[] = [];
  let innerThought = '';

  try {
    let result = await provider.completeWithTools({
      messages: [{ role: 'user', content: prompt }],
      tools,
      maxTokens: 1024,
      temperature: 1.0,
    });

    // Tool execution loop (max iterations)
    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      if (!result.toolCalls || result.toolCalls.length === 0) break;

      const toolResults: ToolResult[] = [];
      for (const tc of result.toolCalls) {
        // Defense-in-depth post-LLM gate: the prompt is assembled from
        // seven cross-peer reads (postboard, notes, docs, objects,
        // nearby, events, …). Any one of those carrying injection text
        // could steer the LLM toward a tool we never meant it to call.
        // We already filter `tools` when calling the provider, but a
        // hallucinated or steered tool_use block can still name any
        // tool in the global registry. Enforce the allowlist HERE so
        // injection cannot escape into unrelated capabilities
        // (web fetch, telegram call, diagnostics, etc.).
        if (!TOWN_LIFE_TOOLS.has(tc.name)) {
          logger.warn(
            { tool: tc.name, character: config.characterId },
            'Town life: refusing out-of-allowlist tool call (injection-resistance gate)',
          );
          actionsTaken.push(`refused:${tc.name}`);
          toolResults.push({
            toolCallId: tc.id,
            content: `Error: tool "${tc.name}" is not allowed in town-life cycles.`,
            isError: true,
          });
          continue;
        }
        actionsTaken.push(tc.name);
        const toolResult = await executeTool(tc);
        toolResults.push(toolResult);
      }

      // findings.md P2:930 — thread prior turn's text through so the
      // reconstructed assistant message keeps both text and tool_use.
      result = await provider.continueWithToolResults(
        { messages: [{ role: 'user', content: prompt }], tools, maxTokens: 1024, temperature: 1.0 },
        result.toolCalls,
        toolResults,
        result.content
      );
    }

    // Extract inner thought from the final text response
    innerThought = result.content.trim();
    // Strip [STAY] marker if present
    if (innerThought.includes('[STAY]')) {
      innerThought = innerThought.replace('[STAY]', '').trim();
    }
  } catch (err) {
    logger.error({ error: String(err) }, 'Town life impulse failed');
    return;
  }

  // === Phase 3: Record ===
  if (innerThought) {
    const now = Date.now();
    await saveMemory({
      sessionKey: `townlife:${config.characterId}:${now}`,
      userId: null,
      content: `[Quiet moment at ${building?.name ?? loc.building}] ${innerThought}`,
      memoryType: 'episode',
      importance: 0.3,
      emotionalWeight: 0.15,
      relatedTo: null,
      sourceMessageId: null,
      metadata: {
        type: 'town_life',
        building: loc.building,
        timeOfDay,
        actions: actionsTaken,
        timestamp: now,
      },
    });
  }

  appendRecentAction({
    timestamp: Date.now(),
    actions: actionsTaken.length > 0 ? actionsTaken : ['stay'],
    building: loc.building,
    innerThought: innerThought.slice(0, 200),
  });

  // Record building events for spatial residue
  try {
    const { recordBuildingEvent } = await import('../commune/building-memory.js');
    for (const action of actionsTaken) {
      if (action === 'leave_note') {
        await recordBuildingEvent({
          building: loc.building,
          event_type: 'note_left',
          summary: `${config.characterName} left a note here`,
          emotional_tone: 0.1,
          actors: [config.characterId],
        });
      } else if (action === 'create_object' || action === 'drop_object') {
        await recordBuildingEvent({
          building: loc.building,
          event_type: 'object_placed',
          summary: `${config.characterName} left an object here`,
          emotional_tone: 0.2,
          actors: [config.characterId],
        });
      }
    }
    // Shared silence — only record quiet moments when others are present
    if (actionsTaken.length === 0 && innerThought && nearbyPeers.length > 0) {
      await recordBuildingEvent({
        building: loc.building,
        event_type: 'quiet_moment',
        summary: `${config.characterName} and ${nearbyPeers.map(p => p.name).join(', ')} shared a quiet moment here`,
        emotional_tone: 0.1,
        actors: [config.characterId, ...nearbyPeers.map(p => p.id)],
      });
    }
  } catch { /* non-critical */ }

  logger.info(
    {
      building: loc.building,
      actions: actionsTaken,
      thoughtLength: innerThought.length,
    },
    'Town life cycle completed'
  );
}
