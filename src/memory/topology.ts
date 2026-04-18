/**
 * Memory topology maintenance
 *
 * Manages memory lifecycle states, coherence groups (constellations of
 * mutually-protecting memories), and causal link inference. Memories have
 * lifecycles (seed -> growing -> mature -> complete -> composting) and
 * naturally cluster into coherence groups based on embedding similarity.
 *
 * Runs as part of the organic memory maintenance cycle.
 */

import { getLogger } from '../utils/logger.js';
import {
  getMemory,
  getAssociations,
  setLifecycleState,
  getMemoriesByLifecycle,
  getAllCoherenceGroups,
  getGroupMembers,
  createCoherenceGroup,
  addToCoherenceGroup,
  removeFromCoherenceGroup,
  updateGroupSignature,
  deleteCoherenceGroup,
  getUnassignedMemories,
  addCausalLink,
  deleteMemory,
  type Memory,
} from './store.js';
import { cosineSimilarity, computeCentroid } from './embeddings.js';

/**
 * Run all topology maintenance operations in order.
 */
export async function runTopologyMaintenance(): Promise<void> {
  const logger = getLogger();

  try {
    const lifecycleChanges = advanceLifecycles();
    logger.info({ lifecycleChanges }, 'Topology: lifecycle advancement complete');

    const groupsFormed = formCoherenceGroups();
    logger.info({ groupsFormed }, 'Topology: coherence group formation complete');

    const mergedCount = mergeOverlappingGroups();
    logger.info({ mergedCount }, 'Topology: group merging complete');

    const prunedCount = pruneIncoherentMembers();
    logger.info({ prunedCount }, 'Topology: incoherent member pruning complete');

    const causalLinks = inferCausalLinks();
    logger.info({ causalLinks }, 'Topology: causal link inference complete');
  } catch (err) {
    logger.error({ error: String(err) }, 'Topology maintenance error');
  }
}

/**
 * Advance memory lifecycle states based on heuristics.
 * No LLM calls — purely age/access-based transitions.
 */
function advanceLifecycles(): number {
  const logger = getLogger();
  const now = Date.now();
  const ONE_HOUR = 60 * 60 * 1000;
  const ONE_DAY = 24 * ONE_HOUR;
  let changes = 0;

  // seed -> growing: accessCount >= 1 OR age > 24h
  const seeds = getMemoriesByLifecycle('seed', 500);
  for (const m of seeds) {
    const age = now - m.createdAt;
    if (m.accessCount >= 1 || age > ONE_DAY) {
      setLifecycleState(m.id, 'growing');
      changes++;
    }
  }

  // growing -> mature: accessCount >= 3 OR age > 7d
  const growing = getMemoriesByLifecycle('growing', 500);
  for (const m of growing) {
    const age = now - m.createdAt;
    if (m.accessCount >= 3 || age > 7 * ONE_DAY) {
      setLifecycleState(m.id, 'mature');
      changes++;
    }
  }

  // mature -> complete: importance < 0.3 AND accessCount > 10 AND age > 30d
  const mature = getMemoriesByLifecycle('mature', 500);
  for (const m of mature) {
    const age = now - m.createdAt;
    if (m.importance < 0.3 && m.accessCount > 10 && age > 30 * ONE_DAY) {
      setLifecycleState(m.id, 'complete');
      changes++;
    }
  }

  // complete -> composting: complete for 30+ days
  const complete = getMemoriesByLifecycle('complete', 500);
  for (const m of complete) {
    const timeSinceComplete = now - (m.lifecycleChangedAt ?? m.createdAt);
    if (timeSinceComplete > 30 * ONE_DAY) {
      setLifecycleState(m.id, 'composting');
      changes++;
    }
  }

  // composting: delete after 14 days
  const composting = getMemoriesByLifecycle('composting', 500);
  for (const m of composting) {
    const timeSinceCompost = now - (m.lifecycleChangedAt ?? m.createdAt);
    if (timeSinceCompost > 14 * ONE_DAY) {
      deleteMemory(m.id);
      changes++;
      logger.debug({ memoryId: m.id }, 'Composted memory deleted');
    }
  }

  return changes;
}

/**
 * Form coherence groups by assigning unassigned memories to existing groups
 * or creating new ones. Greedy assignment based on embedding similarity.
 */
function formCoherenceGroups(maxMemories = 200): number {
  const unassigned = getUnassignedMemories(['mature', 'growing'], maxMemories);
  if (unassigned.length === 0) return 0;

  const groups = getAllCoherenceGroups(50);
  const modifiedGroupIds = new Set<string>();
  let formed = 0;

  for (const memory of unassigned) {
    if (!memory.embedding) continue;

    let bestGroupId: string | null = null;
    let bestSimilarity = 0;

    // Compare to existing group centroids
    for (const group of groups) {
      if (!group.signature) continue;
      const sim = cosineSimilarity(memory.embedding, group.signature);
      if (sim > bestSimilarity && sim > 0.65) {
        bestSimilarity = sim;
        bestGroupId = group.id;
      }
    }

    if (bestGroupId) {
      addToCoherenceGroup(memory.id, bestGroupId);
      modifiedGroupIds.add(bestGroupId);
      formed++;
    } else {
      // Create new group if memory has 2+ associations
      const associations = getAssociations(memory.id, 3);
      if (associations.length >= 2) {
        const groupId = createCoherenceGroup(null, memory.embedding!);
        addToCoherenceGroup(memory.id, groupId);
        modifiedGroupIds.add(groupId);
        formed++;
      }
    }
  }

  // Recompute centroids for modified groups
  for (const groupId of modifiedGroupIds) {
    recomputeGroupCentroid(groupId);
  }

  return formed;
}

/**
 * Merge groups whose centroids are very similar (> 0.85).
 */
function mergeOverlappingGroups(): number {
  const groups = getAllCoherenceGroups(100);
  let mergedCount = 0;
  const deletedIds = new Set<string>();

  for (let i = 0; i < groups.length; i++) {
    const a = groups[i]!;
    if (deletedIds.has(a.id) || !a.signature) continue;

    for (let j = i + 1; j < groups.length; j++) {
      const b = groups[j]!;
      if (deletedIds.has(b.id) || !b.signature) continue;

      const sim = cosineSimilarity(a.signature!, b.signature!);
      if (sim > 0.85) {
        // Merge b into a
        const bMembers = getGroupMembers(b.id);
        for (const memId of bMembers) {
          addToCoherenceGroup(memId, a.id);
        }
        deleteCoherenceGroup(b.id);
        deletedIds.add(b.id);
        mergedCount++;

        // Recompute a's centroid
        recomputeGroupCentroid(a.id);
        // Update a's signature in our local reference
        const updated = getAllCoherenceGroups(1).find((g) => g.id === a.id);
        if (updated) {
          a.signature = updated.signature;
          a.memberCount = updated.memberCount;
        }
      }
    }
  }

  return mergedCount;
}

/**
 * Remove members with < 0.4 similarity to their group centroid.
 * Dissolve groups with < 2 members.
 */
function pruneIncoherentMembers(): number {
  const groups = getAllCoherenceGroups(100);
  let prunedCount = 0;

  for (const group of groups) {
    if (!group.signature) continue;

    const memberIds = getGroupMembers(group.id);
    for (const memId of memberIds) {
      const memory = getMemory(memId);
      if (!memory?.embedding) continue;

      const sim = cosineSimilarity(memory.embedding, group.signature);
      if (sim < 0.4) {
        removeFromCoherenceGroup(memId, group.id);
        prunedCount++;
      }
    }

    // Check if group is too small after pruning
    const remainingMembers = getGroupMembers(group.id);
    if (remainingMembers.length < 2) {
      deleteCoherenceGroup(group.id);
    } else {
      recomputeGroupCentroid(group.id);
    }
  }

  return prunedCount;
}

/**
 * Within coherence groups, infer causal link types from temporal order + similarity.
 * Processes up to 5 groups per cycle.
 */
function inferCausalLinks(): number {
  const groups = getAllCoherenceGroups(50);
  let linksCreated = 0;
  let groupsProcessed = 0;

  for (const group of groups) {
    if (groupsProcessed >= 5) break;

    const memberIds = getGroupMembers(group.id);
    if (memberIds.length < 2) continue;

    // Load memories for this group
    const members: Memory[] = [];
    for (const id of memberIds) {
      const mem = getMemory(id);
      if (mem?.embedding) members.push(mem);
    }

    if (members.length < 2) continue;
    groupsProcessed++;

    // Sort by creation time
    members.sort((a, b) => a.createdAt - b.createdAt);

    // Compare pairs (limit to avoid quadratic blowup on large groups)
    const limit = Math.min(members.length, 15);
    for (let i = 0; i < limit; i++) {
      for (let j = i + 1; j < limit; j++) {
        const a = members[i]!;
        const b = members[j]!;
        if (!a.embedding || !b.embedding) continue;

        // Check if causal link already exists
        const existing = getAssociations(a.id, 50);
        const alreadyCausal = existing.some(
          (assoc) =>
            (assoc.sourceId === b.id || assoc.targetId === b.id)
        );
        if (alreadyCausal) continue;

        const sim = cosineSimilarity(a.embedding, b.embedding);

        // A before B, similarity > 0.6 -> prerequisite
        if (sim > 0.6 && sim <= 0.75) {
          addCausalLink(a.id, b.id, 'pattern', 'prerequisite', sim);
          linksCreated++;
        }
        // High similarity (> 0.75), both recently accessed -> reinforcement
        else if (sim > 0.75) {
          const recentThreshold = Date.now() - 7 * 24 * 60 * 60 * 1000;
          if (
            (a.lastAccessed && a.lastAccessed > recentThreshold) ||
            (b.lastAccessed && b.lastAccessed > recentThreshold)
          ) {
            addCausalLink(a.id, b.id, 'similar', 'reinforcement', sim);
            linksCreated++;
          }
        }
        // Low similarity (< 0.3) but same group -> tension
        else if (sim < 0.3) {
          addCausalLink(a.id, b.id, 'cross_topic', 'tension', 0.3);
          linksCreated++;
        }
      }
    }
  }

  return linksCreated;
}

/**
 * Recompute a group's centroid from its current members.
 */
function recomputeGroupCentroid(groupId: string): void {
  const memberIds = getGroupMembers(groupId);
  const embeddings: Float32Array[] = [];

  for (const id of memberIds) {
    const mem = getMemory(id);
    if (mem?.embedding) {
      embeddings.push(mem.embedding);
    }
  }

  if (embeddings.length === 0) return;

  const centroid = computeCentroid(embeddings);
  updateGroupSignature(groupId, centroid, memberIds.length);
}

/**
 * Auto-assign a single memory to matching coherence groups.
 * Called after memory extraction to immediately place new memories.
 */
export function autoAssignToGroups(memoryId: string): void {
  const memory = getMemory(memoryId);
  if (!memory?.embedding) return;

  const groups = getAllCoherenceGroups(50);
  for (const group of groups) {
    if (!group.signature) continue;
    const sim = cosineSimilarity(memory.embedding, group.signature);
    if (sim > 0.65) {
      addToCoherenceGroup(memoryId, group.id);
      recomputeGroupCentroid(group.id);
      return; // Assign to first matching group
    }
  }
}
