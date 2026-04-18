/**
 * Organic memory maintenance for Lain
 * Background processes: graceful forgetting, cross-conversation pattern detection,
 * importance evolution, and association strength decay.
 * Follows the timer loop pattern of diary.ts and self-concept.ts.
 */

import { getLogger } from '../utils/logger.js';
import { getMeta, setMeta, query, execute } from '../storage/database.js';
import {
  getAllMemories,
  getAssociations,
  addAssociation,
  deleteMemory,
  updateMemoryImportance,
  saveMemory,
  getMemory,
  setLifecycleState,
  getMemoriesByLifecycle,
  type Memory,
} from './store.js';
import { cosineSimilarity } from './embeddings.js';
import { getProvider } from '../agent/index.js';
import { runTopologyMaintenance } from './topology.js';

export interface MemoryMaintenanceConfig {
  intervalMs: number;
  enabled: boolean;
}

const DEFAULT_CONFIG: MemoryMaintenanceConfig = {
  intervalMs: 24 * 60 * 60 * 1000, // 24 hours
  enabled: true,
};

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // Check every 6 hours

/**
 * Start the memory maintenance loop.
 * Returns a cleanup function to stop the timer.
 */
export function startMemoryMaintenanceLoop(config?: Partial<MemoryMaintenanceConfig>): () => void {
  const logger = getLogger();
  const cfg: MemoryMaintenanceConfig = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled) {
    logger.info('Memory maintenance loop disabled');
    return () => {};
  }

  logger.info(
    { interval: `${(cfg.intervalMs / 3600000).toFixed(0)}h` },
    'Starting memory maintenance loop'
  );

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function getInitialDelay(): number {
    try {
      const lastRun = getMeta('memory:last_maintenance_at');
      if (lastRun) {
        const elapsed = Date.now() - parseInt(lastRun, 10);
        if (elapsed < cfg.intervalMs) {
          const remaining = cfg.intervalMs - elapsed;
          logger.debug(
            { remainingHours: (remaining / 3600000).toFixed(1) },
            'Memory maintenance ran recently, scheduling next run'
          );
          return remaining;
        }
        // Overdue — run soon with small jitter
        return Math.random() * 5 * 60 * 1000; // 0-5min
      }
    } catch {
      // Fall through to default
    }
    // First run ever — wait a bit
    return 10 * 60 * 1000 + Math.random() * 20 * 60 * 1000; // 10-30 minutes
  }

  function scheduleNext(delay?: number): void {
    if (stopped) return;
    const d = delay ?? CHECK_INTERVAL_MS;

    logger.debug(
      { delayHours: (d / 3600000).toFixed(1) },
      'Next memory maintenance scheduled'
    );

    timer = setTimeout(async () => {
      if (stopped) return;

      // Check if enough time has passed
      const lastRun = getMeta('memory:last_maintenance_at');
      const elapsed = lastRun ? Date.now() - parseInt(lastRun, 10) : Infinity;

      if (elapsed >= cfg.intervalMs) {
        logger.info('Memory maintenance cycle firing now');
        try {
          await runMemoryMaintenance();
          setMeta('memory:last_maintenance_at', Date.now().toString());
        } catch (err) {
          logger.error({ error: String(err) }, 'Memory maintenance top-level error');
        }
      } else {
        logger.debug('Memory maintenance not yet due');
      }

      scheduleNext();
    }, d);
  }

  scheduleNext(getInitialDelay());

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    logger.info('Memory maintenance loop stopped');
  };
}

/**
 * Run all maintenance tasks
 */
export async function runMemoryMaintenance(): Promise<void> {
  const logger = getLogger();

  logger.info('Running memory maintenance');

  const forgottenCount = gracefulForgetting();
  logger.info({ forgottenCount }, 'Graceful forgetting complete');

  const patternsFound = detectCrossConversationPatterns();
  logger.info({ patternsFound }, 'Cross-conversation pattern detection complete');

  const evolvedCount = evolveImportance();
  logger.info({ evolvedCount }, 'Importance evolution complete');

  const decayedCount = decayAssociationStrength();
  logger.info({ decayedCount }, 'Association strength decay complete');

  const distilledCount = await distillMemoryClusters();
  logger.info({ distilledCount }, 'Memory distillation complete');

  await runTopologyMaintenance();
  logger.info('Topology maintenance complete');
}

/**
 * Graceful forgetting: transition memories to composting instead of hard delete.
 * Only hard-deletes memories that have been composting for 14+ days.
 * Never touches core identity memories (fact, preference).
 */
function gracefulForgetting(): number {
  const logger = getLogger();
  const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const fourteenDaysAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
  let forgottenCount = 0;

  // Phase 1: Transition eligible mature memories to composting
  const allMemories = getAllMemories();

  for (const memory of allMemories) {
    // Skip core identity memory types
    if (memory.memoryType === 'fact' || memory.memoryType === 'preference') {
      continue;
    }

    // Skip already composting/complete memories (handled by topology lifecycle)
    if (memory.lifecycleState === 'composting' || memory.lifecycleState === 'complete') {
      continue;
    }

    // Must match ALL criteria to begin composting
    if (
      memory.createdAt < ninetyDaysAgo &&
      memory.importance < 0.3 &&
      (memory.emotionalWeight ?? 0) < 0.1 &&
      memory.accessCount < 2
    ) {
      // Check for associations — don't compost connected memories
      const associations = getAssociations(memory.id, 1);
      if (associations.length > 0) {
        continue;
      }

      logger.debug(
        {
          memoryId: memory.id,
          content: memory.content.slice(0, 80),
          importance: memory.importance,
          accessCount: memory.accessCount,
        },
        'Transitioning memory to composting'
      );

      setLifecycleState(memory.id, 'composting');
      forgottenCount++;
    }
  }

  // Phase 2: Hard-delete memories composting for 14+ days
  const composting = getMemoriesByLifecycle('composting', 500);
  for (const memory of composting) {
    const changedAt = memory.lifecycleChangedAt ?? memory.createdAt;
    if (changedAt < fourteenDaysAgo) {
      deleteMemory(memory.id);
      forgottenCount++;
      logger.debug({ memoryId: memory.id }, 'Deleted fully composted memory');
    }
  }

  return forgottenCount;
}

/**
 * Detect patterns across different conversations/sessions.
 * Find memories with high embedding similarity that aren't already associated.
 */
function detectCrossConversationPatterns(): number {
  const allMemories = getAllMemories();
  const memoriesWithEmbeddings = allMemories.filter(
    (m) => m.embedding !== null && m.sessionKey !== null
  );

  let patternsFound = 0;

  // Group by session to find cross-session similarities
  const bySession = new Map<string, Memory[]>();
  for (const m of memoriesWithEmbeddings) {
    const key = m.sessionKey!;
    const list = bySession.get(key) ?? [];
    list.push(m);
    bySession.set(key, list);
  }

  const sessionKeys = [...bySession.keys()];
  if (sessionKeys.length < 2) return 0;

  // Compare memories across different sessions (limit comparisons)
  for (let i = 0; i < sessionKeys.length && i < 10; i++) {
    const sessionA = bySession.get(sessionKeys[i]!);
    if (!sessionA) continue;

    for (let j = i + 1; j < sessionKeys.length && j < 10; j++) {
      const sessionB = bySession.get(sessionKeys[j]!);
      if (!sessionB) continue;

      // Sample memories to limit computation
      const sampleA = sessionA.slice(0, 5);
      const sampleB = sessionB.slice(0, 5);

      for (const a of sampleA) {
        if (!a.embedding) continue;
        for (const b of sampleB) {
          if (!b.embedding) continue;

          const similarity = cosineSimilarity(a.embedding, b.embedding);
          if (similarity > 0.7) {
            // Check if already associated
            const existing = getAssociations(a.id, 50);
            const alreadyLinked = existing.some(
              (assoc) => assoc.sourceId === b.id || assoc.targetId === b.id
            );

            if (!alreadyLinked) {
              addAssociation(a.id, b.id, 'cross_topic', similarity);
              patternsFound++;
            }
          }
        }
      }
    }
  }

  return patternsFound;
}

/**
 * Importance evolution: memories accessed 5+ times get an importance boost.
 * Memories that prove useful become more important over time.
 */
function evolveImportance(): number {
  const logger = getLogger();
  let evolvedCount = 0;

  // Find memories with high access count that could be boosted
  const candidates = getAllMemories().filter(
    (m) => m.accessCount >= 5 && m.importance < 1.0
  );

  for (const memory of candidates) {
    const newImportance = Math.min(1.0, memory.importance + 0.05);
    if (newImportance !== memory.importance) {
      updateMemoryImportance(memory.id, newImportance);
      evolvedCount++;
      logger.debug(
        { memoryId: memory.id, oldImportance: memory.importance, newImportance },
        'Evolved memory importance'
      );
    }
  }

  return evolvedCount;
}

/**
 * Association strength decay: reduce strength of associations
 * whose connected memories haven't been co-accessed in 60+ days.
 */
function decayAssociationStrength(): number {
  const sixtyDaysAgo = Date.now() - 60 * 24 * 60 * 60 * 1000;
  let decayedCount = 0;

  interface AssocWithAccess {
    source_id: string;
    target_id: string;
    strength: number;
    source_last_accessed: number | null;
    target_last_accessed: number | null;
  }

  // Find associations where both memories haven't been accessed recently
  const staleAssociations = query<AssocWithAccess>(
    `SELECT ma.source_id, ma.target_id, ma.strength,
            m1.last_accessed as source_last_accessed,
            m2.last_accessed as target_last_accessed
     FROM memory_associations ma
     JOIN memories m1 ON m1.id = ma.source_id
     JOIN memories m2 ON m2.id = ma.target_id
     WHERE ma.strength > 0.1
       AND (m1.last_accessed IS NULL OR m1.last_accessed < ?)
       AND (m2.last_accessed IS NULL OR m2.last_accessed < ?)`,
    [sixtyDaysAgo, sixtyDaysAgo]
  );

  for (const assoc of staleAssociations) {
    const newStrength = Math.max(0.1, assoc.strength - 0.1);
    if (newStrength !== assoc.strength) {
      execute(
        `UPDATE memory_associations SET strength = ? WHERE source_id = ? AND target_id = ?`,
        [newStrength, assoc.source_id, assoc.target_id]
      );
      decayedCount++;
    }
  }

  return decayedCount;
}

/**
 * Distill clusters of associated memories into compressed narrative summaries.
 * Uses BFS on the association graph to find connected components,
 * then LLM-synthesizes clusters with 5+ undistilled members.
 * Cap: 3 clusters per cycle to limit LLM cost.
 */
async function distillMemoryClusters(): Promise<number> {
  const logger = getLogger();

  const provider = getProvider('default', 'light');
  if (!provider) {
    logger.debug('Memory distillation: no provider available');
    return 0;
  }

  // Build adjacency list from associations
  interface AssocRow { source_id: string; target_id: string; }
  const assocRows = query<AssocRow>(
    `SELECT source_id, target_id FROM memory_associations WHERE strength >= 0.3`
  );

  const adjacency = new Map<string, Set<string>>();
  for (const row of assocRows) {
    if (!adjacency.has(row.source_id)) adjacency.set(row.source_id, new Set());
    if (!adjacency.has(row.target_id)) adjacency.set(row.target_id, new Set());
    adjacency.get(row.source_id)!.add(row.target_id);
    adjacency.get(row.target_id)!.add(row.source_id);
  }

  // BFS to find connected components
  const visited = new Set<string>();
  const clusters: string[][] = [];

  for (const nodeId of adjacency.keys()) {
    if (visited.has(nodeId)) continue;

    const cluster: string[] = [];
    const queue = [nodeId];
    visited.add(nodeId);

    while (queue.length > 0) {
      const current = queue.shift()!;
      cluster.push(current);

      const neighbors = adjacency.get(current);
      if (neighbors) {
        for (const neighbor of neighbors) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push(neighbor);
          }
        }
      }
    }

    clusters.push(cluster);
  }

  // Filter to clusters with 5+ undistilled members, cap at 3
  let distilledCount = 0;

  const eligibleClusters = clusters
    .map((ids) => {
      const undistilled = ids.filter((id) => {
        const mem = getMemory(id);
        return mem && !mem.metadata?.distilledInto && !mem.metadata?.isDistillation;
      });
      return { ids, undistilled };
    })
    .filter((c) => c.undistilled.length >= 5)
    .slice(0, 3);

  for (const cluster of eligibleClusters) {
    try {
      // Gather undistilled memories (cap 20 for prompt)
      const memoryTexts: string[] = [];
      const sourceIds: string[] = [];

      for (const id of cluster.undistilled.slice(0, 20)) {
        const mem = getMemory(id);
        if (mem) {
          const content = mem.content.length > 200 ? mem.content.slice(0, 200) + '...' : mem.content;
          memoryTexts.push(`- [${mem.memoryType}] ${content}`);
          sourceIds.push(id);
        }
      }

      if (memoryTexts.length < 5) continue;

      const prompt = `You are compressing a cluster of related memories into a single narrative summary. Preserve the key facts, feelings, and connections. Be concise.

MEMORIES:
${memoryTexts.join('\n')}

Write a compressed narrative (~2-3 sentences) that captures the essence of these memories.`;

      const result = await provider.complete({
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 200,
        temperature: 0.3,
      });

      const summary = result.content.trim();
      if (!summary || summary.length < 20) continue;

      // Save distillation as summary memory
      const summaryId = await saveMemory({
        sessionKey: 'distillation:cluster',
        userId: null,
        content: summary,
        memoryType: 'summary',
        importance: 0.6,
        emotionalWeight: 0.3,
        relatedTo: null,
        sourceMessageId: null,
        metadata: {
          isDistillation: true,
          sourceCount: sourceIds.length,
          distilledAt: Date.now(),
        },
      });

      // Mark source memories and create associations
      for (const sourceId of sourceIds) {
        const mem = getMemory(sourceId);
        if (mem) {
          const updatedMetadata = { ...mem.metadata, distilledInto: summaryId };
          execute(
            `UPDATE memories SET metadata = ? WHERE id = ?`,
            [JSON.stringify(updatedMetadata), sourceId]
          );
        }
        addAssociation(summaryId, sourceId, 'evolved_from', 0.8);
      }

      distilledCount++;
      logger.debug(
        { summaryId, sourceCount: sourceIds.length },
        'Distilled memory cluster'
      );
    } catch (err) {
      logger.warn({ error: String(err) }, 'Failed to distill memory cluster');
    }
  }

  return distilledCount;
}
