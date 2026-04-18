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
import { BUILDING_MAP } from '../commune/buildings.js';
import { getLogger } from '../utils/logger.js';
import { getMeta, setMeta } from '../storage/database.js';
import type { PeerConfig } from './character-tools.js';
import type { ToolResult } from '../providers/base.js';

export interface TownLifeConfig {
  intervalMs: number;
  maxJitterMs: number;
  enabled: boolean;
  characterId: string;
  characterName: string;
  peers: PeerConfig[];
}

const DEFAULT_CONFIG: Omit<TownLifeConfig, 'characterId' | 'characterName' | 'peers'> = {
  intervalMs: 2 * 60 * 60 * 1000,       // 2 hours
  maxJitterMs: 1 * 60 * 60 * 1000,      // 0-1h jitter (so 2-3h effective)
  enabled: true,
};

const META_KEY_LAST_CYCLE = 'townlife:last_cycle_at';
const META_KEY_RECENT_ACTIONS = 'townlife:recent_actions';
const MAX_RECENT_ACTIONS = 5;
const MAX_TOOL_ITERATIONS = 3;

const TOWN_LIFE_TOOLS = new Set([
  'move_to_building', 'leave_note', 'write_document', 'give_gift', 'recall', 'read_document',
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
      logger.info('Town life cycle firing');
      try {
        await runTownLifeCycle(cfg);
        setMeta(META_KEY_LAST_CYCLE, Date.now().toString());
      } catch (err) {
        logger.error({ error: String(err) }, 'Town life cycle error');
      }
      scheduleNext();
    }, d);
  }

  scheduleNext(getInitialDelay());

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
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
    case 'dawn': return 'The light is just beginning. The commune is quiet.';
    case 'day': return 'The commune hums with its usual rhythms.';
    case 'dusk': return 'The light is fading. Shadows stretch between buildings.';
    case 'night': return 'The town has gone quiet. Windows glow here and there, but most doors stay shut.';
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

  await Promise.all(peers.map(async (peer) => {
    try {
      const resp = await fetch(
        `${peer.url}/api/building/notes?building=${encodeURIComponent(building)}&since=${since}`,
        { signal: AbortSignal.timeout(5000) }
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

  await Promise.all(peers.map(async (peer) => {
    try {
      const resp = await fetch(
        `${peer.url}/api/documents`,
        { signal: AbortSignal.timeout(5000) }
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

  const provider = getProvider('default', 'personality');
  if (!provider) {
    logger.warn('Town life cycle: no provider available');
    return;
  }

  // === Phase 1: Awareness ===
  const loc = getCurrentLocation(config.characterId);
  const building = BUILDING_MAP.get(loc.building);
  const timeOfDay = getTimeOfDay();
  const timeDesc = getTimeDescription();
  const timeFlavor = getTimeFlavor(timeOfDay);

  let memoriesContext = '';
  try {
    const memories = await searchMemories('thoughts feelings observations', 5, 0.1, undefined, {
      sortBy: 'importance',
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

  const recentActions = getRecentActions();
  const actionsContext = recentActions.length > 0
    ? recentActions.map((a) => `- ${new Date(a.timestamp).toLocaleTimeString()}: ${a.actions.join(', ')} at ${a.building}${a.innerThought ? ` — "${a.innerThought}"` : ''}`).join('\n')
    : '(none)';

  // === Phase 2: Impulse ===
  const tools = getToolDefinitions().filter((t) => TOWN_LIFE_TOOLS.has(t.name));

  const prompt = `You are ${config.characterName}. It is ${timeOfDay} in the commune.

CURRENT LOCATION: ${building?.name ?? loc.building} — ${building?.description ?? 'unknown'}
TIME: ${timeDesc}
${nearbyContext}
${notesContext ? `\n${notesContext}\n` : ''}${docsContext ? `\n${docsContext}\n` : ''}
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
- Or simply stay where you are

There is no obligation to act. If nothing feels right, respond with just [STAY].

After acting (or staying), write a brief inner thought — one sentence about this moment.

${timeFlavor}`;

  const actionsTaken: string[] = [];
  let innerThought = '';

  try {
    let result = await provider.completeWithTools({
      messages: [{ role: 'user', content: prompt }],
      tools,
      maxTokens: 800,
      temperature: 1.0,
    });

    // Tool execution loop (max iterations)
    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      if (!result.toolCalls || result.toolCalls.length === 0) break;

      const toolResults: ToolResult[] = [];
      for (const tc of result.toolCalls) {
        actionsTaken.push(tc.name);
        const toolResult = await executeTool(tc);
        toolResults.push(toolResult);
      }

      result = await provider.continueWithToolResults(
        { messages: [{ role: 'user', content: prompt }], tools, maxTokens: 800, temperature: 1.0 },
        result.toolCalls,
        toolResults
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

  logger.info(
    {
      building: loc.building,
      actions: actionsTaken,
      thoughtLength: innerThought.length,
    },
    'Town life cycle completed'
  );
}
