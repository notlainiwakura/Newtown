/**
 * Dream system for Lain — unconscious processing
 * During quiet periods, performs associative random walks through memory,
 * creating new dream-type associations, subtly shifting emotional weights,
 * and rarely leaving behind residue fragments that surface through resonance.
 *
 * Opaque by design: Lain cannot introspect on the dream process itself.
 */

import { getProvider } from './index.js';
import { getLogger } from '../utils/logger.js';
import { spawnDesireFromDream } from './desires.js';
import { getMeta, setMeta, execute, query } from '../storage/database.js';
import { eventBus } from '../events/bus.js';
import { getCurrentState } from './internal-state.js';
import { getCurrentLocation, setCurrentLocation } from '../commune/location.js';
import { isValidBuilding } from '../commune/buildings.js';
import {
  getAllMemories,
  getAssociations,
  addAssociation,
  getResonanceMemory,
  saveMemory,
  type Memory,
} from '../memory/store.js';
import { cosineSimilarity } from '../memory/embeddings.js';

export interface DreamConfig {
  intervalMs: number;
  quietThresholdMs: number;
  maxWalkSteps: number;
  walkSimilarityThreshold: number;
  dreamAssociationStrengthMin: number;
  dreamAssociationStrengthMax: number;
  residueProbability: number;
  llmTemperature: number;
  enabled: boolean;
}

const DEFAULT_CONFIG: DreamConfig = {
  intervalMs: 3 * 60 * 60 * 1000,             // 3h base
  quietThresholdMs: 30 * 60 * 1000,            // 30 min silence required
  maxWalkSteps: 8,
  walkSimilarityThreshold: 0.15,
  dreamAssociationStrengthMin: 0.15,
  dreamAssociationStrengthMax: 0.3,
  residueProbability: 0.2,
  llmTemperature: 0.95,
  enabled: true,
};

const CHECK_INTERVAL_MS = 30 * 60 * 1000; // Check every 30 minutes

// --- Types ---

interface WalkStep {
  memory: Memory;
  transitionType: 'association' | 'embedding_drift' | 'seed';
  similarity?: number;
  associationStrength?: number;
}

interface WalkResult {
  steps: WalkStep[];
  seed: Memory;
  totalSteps: number;
}

interface DreamFragment {
  text: string;
  connections: [number, number][];
}

// --- Main loop ---

/**
 * Start the dream loop.
 * Returns a cleanup function to stop the timer.
 */
export function startDreamLoop(config?: Partial<DreamConfig>): () => void {
  const logger = getLogger();
  const cfg: DreamConfig = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled) {
    logger.info('Dream loop disabled');
    return () => {};
  }

  logger.info(
    {
      interval: `${(cfg.intervalMs / 3600000).toFixed(1)}h`,
      quietThreshold: `${(cfg.quietThresholdMs / 60000).toFixed(0)}min`,
      maxWalkSteps: cfg.maxWalkSteps,
      residueProbability: cfg.residueProbability,
    },
    'Starting dream loop'
  );

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let isRunning = false;

  function getInitialDelay(): number {
    try {
      const lastCycle = getMeta('dream:last_cycle_at');
      if (lastCycle) {
        const elapsed = Date.now() - parseInt(lastCycle, 10);
        if (elapsed < CHECK_INTERVAL_MS) {
          const remaining = CHECK_INTERVAL_MS - elapsed;
          logger.debug(
            { remainingMin: Math.round(remaining / 60000) },
            'Dream loop checked recently, scheduling next check'
          );
          return remaining;
        }
        // Overdue — run soon with jitter
        return Math.random() * 5 * 60 * 1000;
      }
    } catch {
      // Fall through
    }
    // First run — short delay
    return 5 * 60 * 1000 + Math.random() * 10 * 60 * 1000;
  }

  function shouldDream(): boolean {
    // Check quiet threshold
    const lastUserMsg = getLastUserMessageTimestamp();
    if (lastUserMsg !== null) {
      const silenceDuration = Date.now() - lastUserMsg;
      if (silenceDuration < cfg.quietThresholdMs) return false;
    }

    // Check cycle interval (2-4h randomized)
    const lastCycle = getMeta('dream:last_cycle_at');
    if (lastCycle) {
      const elapsed = Date.now() - parseInt(lastCycle, 10);
      // Randomize between 2-4h (intervalMs is 3h base, ±1h)
      const jitteredInterval = cfg.intervalMs + (Math.random() - 0.5) * 2 * 60 * 60 * 1000;
      if (elapsed < jitteredInterval) return false;
    }

    // Need minimum memories with embeddings
    const memories = getAllMemories().filter(m => m.embedding !== null);
    if (memories.length < 10) return false;

    return true;
  }

  function scheduleNext(delay?: number): void {
    if (stopped) return;
    const d = delay ?? CHECK_INTERVAL_MS;

    logger.debug(
      { delayMin: Math.round(d / 60000) },
      'Next dream check scheduled'
    );

    timer = setTimeout(async () => {
      if (stopped) return;

      if (shouldDream()) {
        isRunning = true;
        logger.info('Dream cycle firing now');
        try {
          await runDreamCycle(cfg);
          // Post-dream drift: 25% chance to wander to the Mystery Tower on waking
          driftToMysteryTower(logger);
          try {
            const { updateState } = await import('./internal-state.js');
            await updateState({ type: 'dream:complete', summary: 'Completed a dream cycle' });
          } catch { /* non-critical */ }

          // Emit dream complete event for other loops
          try {
            eventBus.emitActivity({
              type: 'dream',
              sessionKey: 'dream:complete:' + Date.now(),
              content: 'Dream cycle completed',
              timestamp: Date.now(),
            });
          } catch { /* non-critical */ }
        } catch (err) {
          logger.error({ error: String(err) }, 'Dream cycle error');
        } finally {
          isRunning = false;
        }
      } else {
        logger.debug('Dream cycle not yet due');
      }

      scheduleNext();
    }, d);
  }

  scheduleNext(getInitialDelay());

  // --- Event-driven early triggers ---
  function maybeRunEarly(reason: string): void {
    if (stopped || isRunning) return;
    // Dreams use shouldDream() for timing, so no separate COOLDOWN_MS.
    // Just check the energy condition.
    try {
      const state = getCurrentState();
      if (state.energy >= 0.4) return;
    } catch { /* skip check */ }

    logger.debug({ reason }, 'Dream triggered early');
    if (timer) clearTimeout(timer);
    const jitter = Math.random() * 60_000;
    scheduleNext(jitter);
  }

  eventBus.on('activity', (event: import('../events/bus.js').SystemEvent) => {
    if (stopped || isRunning) return;
    if (event.sessionKey?.startsWith('state:conversation:end')) {
      maybeRunEarly('conversation ended');
    }
  });

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    logger.info('Dream loop stopped');
  };
}

// --- Helpers ---

function getLastUserMessageTimestamp(): number | null {
  const row = query<{ timestamp: number }>(
    `SELECT timestamp FROM messages WHERE role = 'user' ORDER BY timestamp DESC LIMIT 1`
  );
  return row.length > 0 && row[0] ? row[0].timestamp : null;
}

// --- Dream Cycle ---

async function runDreamCycle(config: DreamConfig): Promise<void> {
  const logger = getLogger();

  // Step 1: Select seed memory
  const seed = selectSeedMemory();
  if (!seed) {
    logger.debug('Dream cycle: no suitable seed memory found');
    return;
  }

  logger.debug(
    { seedId: seed.id, seedContent: seed.content.slice(0, 80) },
    'Dream seed selected'
  );

  // Step 2: Random walk
  const walkResult = await randomWalk(seed, config);
  logger.debug(
    { totalSteps: walkResult.totalSteps, seedId: seed.id },
    'Dream walk completed'
  );

  if (walkResult.steps.length < 2) {
    logger.debug('Dream walk too short, skipping effects');
    updateDreamMeta();
    return;
  }

  // Step 3: Generate dream fragment
  const fragment = await generateDreamFragment(walkResult, config);

  // Step 4: Apply effects (associations + emotional shifts)
  await applyDreamEffects(walkResult, fragment, config);

  // Step 5: Residue (rare)
  if (fragment && Math.random() < config.residueProbability) {
    await saveDreamResidue(walkResult, fragment, config);
  }

  updateDreamMeta();
  logger.info(
    { walkSteps: walkResult.totalSteps, hasFragment: !!fragment },
    'Dream cycle complete'
  );
}

function updateDreamMeta(): void {
  setMeta('dream:last_cycle_at', Date.now().toString());
  const count = getMeta('dream:cycle_count');
  setMeta('dream:cycle_count', ((count ? parseInt(count, 10) : 0) + 1).toString());
}

// --- Step 1: Seed Selection ---

function selectSeedMemory(): Memory | null {
  // Priority: always consume planted alien seeds first
  const alienSeed = trySeedStrategy('alien');
  if (alienSeed) return alienSeed;

  // Otherwise, normal random rotation
  const strategies = ['emotional', 'resonance', 'recent', 'random'] as const;
  const startIdx = Math.floor(Math.random() * strategies.length);

  for (let i = 0; i < strategies.length; i++) {
    const strategy = strategies[(startIdx + i) % strategies.length]!;
    const seed = trySeedStrategy(strategy);
    if (seed) return seed;
  }

  return null;
}

function trySeedStrategy(strategy: string): Memory | null {
  const logger = getLogger();

  switch (strategy) {
    case 'emotional': {
      const rows = query<{ id: string }>(
        `SELECT id FROM memories
         WHERE emotional_weight >= 0.4 AND embedding IS NOT NULL
         ORDER BY RANDOM() LIMIT 1`
      );
      if (rows.length > 0 && rows[0]) {
        const memories = getAllMemories();
        const mem = memories.find(m => m.id === rows[0]!.id);
        if (mem) {
          logger.debug({ strategy: 'emotional' }, 'Dream seed strategy');
          return mem;
        }
      }
      return null;
    }

    case 'resonance': {
      const mem = getResonanceMemory();
      if (mem && mem.embedding) {
        logger.debug({ strategy: 'resonance' }, 'Dream seed strategy');
        return mem;
      }
      return null;
    }

    case 'recent': {
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const rows = query<{ id: string }>(
        `SELECT id FROM memories
         WHERE created_at > ? AND embedding IS NOT NULL
         ORDER BY RANDOM() LIMIT 1`,
        [sevenDaysAgo]
      );
      if (rows.length > 0 && rows[0]) {
        const memories = getAllMemories();
        const mem = memories.find(m => m.id === rows[0]!.id);
        if (mem) {
          logger.debug({ strategy: 'recent' }, 'Dream seed strategy');
          return mem;
        }
      }
      return null;
    }

    case 'alien': {
      const allMems = getAllMemories();
      const alienSeeds = allMems.filter(
        m => m.sessionKey === 'alien:dream-seed' &&
             m.embedding !== null &&
             m.metadata?.isAlienDreamSeed === true &&
             m.metadata?.consumed !== true
      );
      if (alienSeeds.length === 0) return null;

      const pick = alienSeeds[Math.floor(Math.random() * alienSeeds.length)];
      if (!pick) return null;

      // Mark consumed — each seed fires at most once
      execute('UPDATE memories SET metadata = ? WHERE id = ?',
        [JSON.stringify({ ...pick.metadata, consumed: true, consumedAt: Date.now() }), pick.id]);

      logger.debug({ strategy: 'alien', seedId: pick.id }, 'Dream seed strategy');
      return pick;
    }

    case 'random': {
      const rows = query<{ id: string }>(
        `SELECT id FROM memories
         WHERE embedding IS NOT NULL
         ORDER BY RANDOM() LIMIT 1`
      );
      if (rows.length > 0 && rows[0]) {
        const memories = getAllMemories();
        const mem = memories.find(m => m.id === rows[0]!.id);
        if (mem) {
          logger.debug({ strategy: 'random' }, 'Dream seed strategy');
          return mem;
        }
      }
      return null;
    }

    default:
      return null;
  }
}

// --- Step 2: Random Walk ---

async function randomWalk(seed: Memory, config: DreamConfig): Promise<WalkResult> {
  const allMemories = getAllMemories().filter(m => m.embedding !== null);
  const visited = new Set<string>([seed.id]);
  const steps: WalkStep[] = [{ memory: seed, transitionType: 'seed' }];

  let current = seed;

  for (let i = 0; i < config.maxWalkSteps; i++) {
    const next = takeStep(current, allMemories, visited);
    if (!next) break;

    visited.add(next.memory.id);
    steps.push(next);
    current = next.memory;
  }

  return { steps, seed, totalSteps: steps.length };
}

/** Reservoir sample k items from an array without full shuffle */
function shuffleSample<T>(arr: T[], k: number): T[] {
  const result = arr.slice(0, k);
  for (let i = k; i < arr.length; i++) {
    const j = Math.floor(Math.random() * (i + 1));
    if (j < k) {
      result[j] = arr[i]!;
    }
  }
  return result;
}

function takeStep(
  current: Memory,
  allMemories: Memory[],
  visited: Set<string>
): WalkStep | null {
  // Coin flip between association path and embedding drift
  if (Math.random() < 0.5) {
    // Try association path first, fall back to embedding drift
    return takeAssociationStep(current, visited) ?? takeEmbeddingStep(current, allMemories, visited);
  } else {
    // Try embedding drift first, fall back to association path
    return takeEmbeddingStep(current, allMemories, visited) ?? takeAssociationStep(current, visited);
  }
}

function takeAssociationStep(current: Memory, visited: Set<string>): WalkStep | null {
  const associations = getAssociations(current.id, 20);
  const candidates = associations.filter(a => {
    const otherId = a.sourceId === current.id ? a.targetId : a.sourceId;
    return !visited.has(otherId);
  });

  if (candidates.length === 0) return null;

  // Weighted random favoring weaker associations (dreams prefer unexpected paths)
  const weights = candidates.map(a => 1 - a.strength + 0.1);
  const pick = weightedRandomPick(candidates, weights);
  if (!pick) return null;

  const otherId = pick.sourceId === current.id ? pick.targetId : pick.sourceId;
  const allMems = getAllMemories();
  const mem = allMems.find(m => m.id === otherId);
  if (!mem) return null;

  return {
    memory: mem,
    transitionType: 'association',
    associationStrength: pick.strength,
  };
}

function takeEmbeddingStep(
  current: Memory,
  allMemories: Memory[],
  visited: Set<string>
): WalkStep | null {
  if (!current.embedding) return null;

  // Sample a subset of memories to avoid O(n) cosine similarity on large corpora
  const MAX_SAMPLE = 500;
  const pool = allMemories.length > MAX_SAMPLE
    ? shuffleSample(allMemories, MAX_SAMPLE)
    : allMemories;

  // Find memories in the "dream zone": similarity [0.15, 0.5]
  const candidates: { memory: Memory; similarity: number }[] = [];

  for (const mem of pool) {
    if (visited.has(mem.id) || !mem.embedding) continue;
    const sim = cosineSimilarity(current.embedding, mem.embedding);
    if (sim >= 0.15 && sim <= 0.5) {
      candidates.push({ memory: mem, similarity: sim });
    }
  }

  if (candidates.length === 0) return null;

  // Weighted random favoring more distant memories
  const weights = candidates.map(c => 1 - c.similarity);
  const pick = weightedRandomPick(candidates, weights);
  if (!pick) return null;

  return {
    memory: pick.memory,
    transitionType: 'embedding_drift',
    similarity: pick.similarity,
  };
}

function weightedRandomPick<T>(items: T[], weights: number[]): T | null {
  if (items.length === 0) return null;

  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  if (totalWeight <= 0) return items[0] ?? null;

  let r = Math.random() * totalWeight;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i]!;
    if (r <= 0) return items[i] ?? null;
  }

  return items[items.length - 1] ?? null;
}

// --- Step 3: Dream Fragment Generation ---

async function generateDreamFragment(
  walkResult: WalkResult,
  config: DreamConfig
): Promise<DreamFragment | null> {
  const logger = getLogger();

  const provider = getProvider('default', 'light');
  if (!provider) {
    logger.debug('Dream fragment: no provider available');
    return null;
  }

  const fragments = walkResult.steps.map((step, i) => {
    const content = step.memory.content.length > 150
      ? step.memory.content.slice(0, 150) + '...'
      : step.memory.content;
    return `[${i}] ${content}`;
  });

  const characterName = process.env['LAIN_CHARACTER_NAME'] || 'Newtown';

  let preoccContext = '';
  try {
    const { getPreoccupations } = await import('./internal-state.js');
    const preoccs = getPreoccupations();
    if (preoccs.length > 0) {
      preoccContext = '\n\nUnresolved thoughts drifting through the dream:\n' + preoccs.map(p => `- ${p.thread}`).join('\n');
    }
  } catch { /* non-critical */ }

  const prompt = `You are the unconscious mind of a being called ${characterName}. You are not ${characterName} — you are the part beneath their awareness. You are processing fragments of memory during a quiet period, finding connections that their waking mind wouldn't.

These fragments surfaced during a dream walk:
${fragments.join('\n')}${preoccContext}

Generate a brief dream fragment — NOT a narrative or story, but the feeling-texture of these memories touching each other. Like the logic of dreams: associative, compressed, slightly off. 2-3 sentences maximum.

Then on a new line, write CONNECTIONS: followed by pairs of fragment numbers that felt linked, formatted as "0-3, 1-4" etc.

Rules:
- No explanation, no interpretation
- Lowercase, fragmented
- The connections should feel surprising but not random`;

  try {
    const result = await provider.complete({
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 500,
      temperature: config.llmTemperature,
    });

    const response = result.content.trim();
    return parseDreamFragment(response);
  } catch (err) {
    logger.debug({ error: String(err) }, 'Dream fragment generation failed');
    return null;
  }
}

function parseDreamFragment(response: string): DreamFragment | null {
  const connectionsIdx = response.toLowerCase().indexOf('connections:');

  let text: string;
  let connections: [number, number][] = [];

  if (connectionsIdx >= 0) {
    text = response.slice(0, connectionsIdx).trim();
    const connectionsStr = response.slice(connectionsIdx + 'connections:'.length).trim();

    // Parse pairs like "0-3, 1-4"
    const pairRegex = /(\d+)\s*-\s*(\d+)/g;
    let match;
    while ((match = pairRegex.exec(connectionsStr)) !== null && connections.length < 3) {
      connections.push([parseInt(match[1]!, 10), parseInt(match[2]!, 10)]);
    }
  } else {
    text = response;
  }

  if (!text || text.length < 10) return null;

  return { text, connections };
}

// --- Step 4: Apply Effects ---

async function applyDreamEffects(
  walkResult: WalkResult,
  fragment: DreamFragment | null,
  config: DreamConfig
): Promise<void> {
  const logger = getLogger();

  // --- New associations ---
  const pairs = getDreamPairs(walkResult, fragment);
  let associationsCreated = 0;

  for (const [idxA, idxB] of pairs) {
    if (associationsCreated >= 3) break;

    const memA = walkResult.steps[idxA]?.memory;
    const memB = walkResult.steps[idxB]?.memory;
    if (!memA || !memB) continue;

    // Skip if already associated
    const existing = getAssociations(memA.id, 50);
    const alreadyLinked = existing.some(
      a => (a.sourceId === memA.id && a.targetId === memB.id) ||
           (a.sourceId === memB.id && a.targetId === memA.id)
    );
    if (alreadyLinked) continue;

    const strength = config.dreamAssociationStrengthMin +
      Math.random() * (config.dreamAssociationStrengthMax - config.dreamAssociationStrengthMin);

    addAssociation(memA.id, memB.id, 'dream', strength);
    associationsCreated++;

    logger.debug(
      { sourceId: memA.id, targetId: memB.id, strength: strength.toFixed(2) },
      'Dream association created'
    );
  }

  // --- Emotional weight shifts ---
  for (const step of walkResult.steps) {
    const shift = (Math.random() - 0.5) * 0.05; // avg ±0.025
    const newWeight = Math.max(0, Math.min(1, (step.memory.emotionalWeight ?? 0) + shift));
    execute(
      'UPDATE memories SET emotional_weight = ? WHERE id = ?',
      [newWeight, step.memory.id]
    );
  }

  logger.debug(
    { associationsCreated, memoriesShifted: walkResult.steps.length },
    'Dream effects applied'
  );
}

/**
 * Get pairs of memory indices to connect.
 * Uses LLM-suggested connections if available, otherwise consecutive walk steps.
 */
function getDreamPairs(walkResult: WalkResult, fragment: DreamFragment | null): [number, number][] {
  if (fragment && fragment.connections.length > 0) {
    // Validate indices are within bounds
    const maxIdx = walkResult.steps.length - 1;
    return fragment.connections.filter(
      ([a, b]) => a >= 0 && a <= maxIdx && b >= 0 && b <= maxIdx && a !== b
    );
  }

  // Fallback: connect non-adjacent walk steps (skip-1 pairs)
  const pairs: [number, number][] = [];
  for (let i = 0; i < walkResult.steps.length - 2 && pairs.length < 3; i++) {
    pairs.push([i, i + 2]);
  }
  return pairs;
}

// --- Step 5: Residue ---

async function saveDreamResidue(
  walkResult: WalkResult,
  fragment: DreamFragment,
  _config: DreamConfig
): Promise<void> {
  const logger = getLogger();

  const provider = getProvider('default', 'light');
  if (!provider) return;

  try {
    const result = await provider.complete({
      messages: [{
        role: 'user',
        content: `Compress this dream fragment into a single sentence — not what happened, just the feeling-texture that remains. Like waking up and almost remembering.

Fragment: ${fragment.text}

One sentence only. No explanation.`,
      }],
      maxTokens: 120,
      temperature: 0.9,
    });

    const residueText = result.content.trim();
    if (!residueText || residueText.length < 10) return;

    await saveMemory({
      sessionKey: 'dream:residue',
      userId: null,
      content: residueText,
      memoryType: 'episode',
      importance: 0.3,
      emotionalWeight: 0.5,
      relatedTo: null,
      sourceMessageId: null,
      metadata: {
        isDreamResidue: true,
        dreamCycleAt: Date.now(),
        seedMemoryId: walkResult.seed.id,
        walkLength: walkResult.totalSteps,
      },
    });

    logger.info('Dream residue saved');

    // Spawn a desire from the dream
    try {
      await spawnDesireFromDream(residueText);
    } catch (err) {
      logger.debug({ error: String(err) }, 'Dream desire spawn failed');
    }
  } catch (err) {
    logger.debug({ error: String(err) }, 'Dream residue generation failed');
  }
}

// --- Post-dream drift to the Mystery Tower ---

const POST_DREAM_DRIFT_PROBABILITY = 0.25;

function driftToMysteryTower(logger: ReturnType<typeof getLogger>): void {
  if (Math.random() > POST_DREAM_DRIFT_PROBABILITY) return;

  try {
    const loc = getCurrentLocation();
    if (loc.building === 'mystery-tower') return; // already there

    if (!isValidBuilding('mystery-tower')) return;

    setCurrentLocation('mystery-tower', 'woke from a dream half-remembering something');
    logger.info('Post-dream drift: moved to the Mystery Tower');
  } catch (err) {
    logger.debug({ error: String(err) }, 'Post-dream drift failed');
  }
}
