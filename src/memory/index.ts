/**
 * Memory system for Lain
 * Provides persistent memory across conversations
 */

import type { Provider } from '../providers/index.js';
import { getLogger } from '../utils/logger.js';
import {
  saveMessage,
  getRecentMessages,
  getAllRecentMessages,
  getMessagesForUser,
  searchMemories,
  countMemories,
  countMessages,
  consolidateMemories,
  getMemory,
  getAssociatedMemories,
  getMemoriesByType,
  getEntityMemories,
  getResonanceMemory,
  getGroupsForMemory,
  type Memory,
  type MemorySortBy,
} from './store.js';
import { extractMemories, summarizeConversation } from './extraction.js';
import { autoAssignToGroups } from './topology.js';
import { getWeeklyNarrative, getMonthlyNarrative } from '../agent/narratives.js';

export {
  saveMessage,
  getRecentMessages,
  searchMemories,
  consolidateMemories,
  getMemoriesForUser,
  getMessagesForUser,
  linkMemories,
  getRelatedMemories,
  addAssociation,
  getAssociations,
  strengthenAssociation,
  getAssociatedMemories,
  getMemoriesByType,
  getEntityMemories,
  getResonanceMemory,
  getMemory,
  updateMemoryAccess,
  getGroupsForMemory,
  getAllCoherenceGroups,
  getMemoriesByLifecycle,
  setLifecycleState,
  computeStructuralRole,
} from './store.js';
export type { StoredMessage, Memory, MemorySortBy, Association, CoherenceGroup, LifecycleState, CausalType } from './store.js';
export { runTopologyMaintenance, autoAssignToGroups } from './topology.js';

/**
 * Extract user ID from session key or metadata
 * Session keys often contain user identifiers
 */
function extractUserId(sessionKey: string, metadata?: Record<string, unknown>): string | null {
  // Check if userId is explicitly provided in metadata
  if (metadata?.userId && typeof metadata.userId === 'string') {
    return metadata.userId;
  }
  if (metadata?.senderId && typeof metadata.senderId === 'string') {
    return metadata.senderId;
  }

  // Extract from session key patterns like "web:YbYf4Q90" or "telegram:123456"
  const parts = sessionKey.split(':');
  if (parts.length >= 2 && parts[1]) {
    return parts[1];
  }

  return null;
}

/**
 * Add a message to memory and optionally extract memories
 */
export async function recordMessage(
  sessionKey: string,
  role: 'user' | 'assistant',
  content: string,
  metadata?: Record<string, unknown>
): Promise<string> {
  const userId = extractUserId(sessionKey, metadata);

  return saveMessage({
    sessionKey,
    userId,
    role,
    content,
    timestamp: Date.now(),
    metadata: metadata || {},
  });
}

/**
 * Get relevant context for a new message
 * Searches past memories and returns formatted context
 * Now prioritizes user-specific memories when userId is available
 */
export async function getRelevantContext(
  queryText: string,
  sessionKey: string,
  maxMemories = 8,
  options?: {
    sortBy?: MemorySortBy;
    memoryTypes?: Memory['memoryType'][];
  }
): Promise<string> {
  const logger = getLogger();
  const userId = extractUserId(sessionKey);

  try {
    // Search for relevant memories - wide net, low threshold
    const relevantMemories = await searchMemories(queryText, maxMemories, 0.15, userId ?? undefined, options);

    if (relevantMemories.length === 0) {
      return '';
    }

    // Format memories as context
    const memoryContext = relevantMemories
      .map((r) => {
        const typeLabel = getTypeLabel(r.memory.memoryType);
        const content = r.memory.content.length > 400
          ? r.memory.content.slice(0, 400) + '...'
          : r.memory.content;
        return '- [' + typeLabel + '] ' + content;
      })
      .join('\n');

    logger.debug({ count: relevantMemories.length, userId }, 'Retrieved relevant memories');

    return '\n\n[Memories]\n' + memoryContext + '\n';
  } catch (error) {
    logger.error({ error }, 'Failed to retrieve context');
    return '';
  }
}

/**
 * Relevant memories with IDs for association lookups
 */
export interface RelevantMemories {
  formatted: string;
  memoryIds: string[];
}

/**
 * Get relevant memories with their IDs for association surfacing
 */
export async function getRelevantMemoriesWithIds(
  queryText: string,
  sessionKey: string,
  maxMemories = 6
): Promise<RelevantMemories> {
  const logger = getLogger();
  const userId = extractUserId(sessionKey);

  try {
    const relevantMemories = await searchMemories(queryText, maxMemories, 0.15, userId ?? undefined);

    if (relevantMemories.length === 0) {
      return { formatted: '', memoryIds: [] };
    }

    const memoryIds = relevantMemories.map((r) => r.memory.id);

    const memoryContext = relevantMemories
      .map((r) => {
        const typeLabel = getTypeLabel(r.memory.memoryType);
        const content = r.memory.content.length > 400
          ? r.memory.content.slice(0, 400) + '...'
          : r.memory.content;
        return '- [' + typeLabel + '] ' + content;
      })
      .join('\n');

    logger.debug({ count: relevantMemories.length, userId }, 'Retrieved relevant memories with IDs');

    return {
      formatted: '\n\n[Memories]\n' + memoryContext + '\n',
      memoryIds,
    };
  } catch (error) {
    logger.error({ error }, 'Failed to retrieve memories with IDs');
    return { formatted: '', memoryIds: [] };
  }
}

/**
 * Per-session extraction state tracking
 */
interface ExtractionState {
  messagesSinceExtraction: number;
  lastExtractionTimestamp: number;
  lastExtractedMessageCount: number;
}

const extractionState = new Map<string, ExtractionState>();
const activeExtractions = new Set<string>();

const EXTRACTION_STATE_MAX_SIZE = 500;

/** Patterns that indicate high-signal content worth extracting */
const HIGH_SIGNAL_PATTERNS = [
  // Personal info
  /\bi am\b/i, /\bmy name\b/i, /\bi work\b/i, /\bi live\b/i, /\bi'm from\b/i,
  // Preferences
  /\bi like\b/i, /\bi prefer\b/i, /\bi hate\b/i, /\bi don't like\b/i, /\bfavorite\b/i,
  // Memory requests
  /\bremember that\b/i, /\bdon't forget\b/i, /\bkeep in mind\b/i,
  // Projects and goals
  /\bworking on\b/i, /\bmy project\b/i, /\bmy goal\b/i, /\bplanning to\b/i,
];

function isHighSignalMessage(message: string): boolean {
  return HIGH_SIGNAL_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Check whether memory extraction should run for a given session.
 * Call this after each user message is processed.
 */
export function shouldExtractMemories(sessionKey: string, latestMessage: string): boolean {
  let state = extractionState.get(sessionKey);
  if (!state) {
    state = { messagesSinceExtraction: 0, lastExtractionTimestamp: 0, lastExtractedMessageCount: 0 };
    extractionState.set(sessionKey, state);
  }

  state.messagesSinceExtraction++;

  const highSignal = isHighSignalMessage(latestMessage);

  // Trigger aggressively — extract early, extract often
  if (state.messagesSinceExtraction >= 6 || (highSignal && state.messagesSinceExtraction >= 2)) {
    return true;
  }

  return false;
}

/**
 * Reset extraction state for a session after extraction runs.
 */
export function resetExtractionState(sessionKey: string): void {
  const state = extractionState.get(sessionKey);
  if (state) {
    state.lastExtractedMessageCount += state.messagesSinceExtraction;
    state.messagesSinceExtraction = 0;
    state.lastExtractionTimestamp = Date.now();
  }

  // LRU cap: prune oldest entries if Map exceeds max size
  if (extractionState.size > EXTRACTION_STATE_MAX_SIZE) {
    let oldest: { key: string; ts: number } | null = null;
    for (const [key, s] of extractionState) {
      if (!oldest || s.lastExtractionTimestamp < oldest.ts) {
        oldest = { key, ts: s.lastExtractionTimestamp };
      }
    }
    if (oldest) {
      extractionState.delete(oldest.key);
    }
  }
}

/**
 * Process end of conversation - extract memories and summarize
 * When messagesSinceExtraction is provided, only fetches that many recent messages
 * instead of a fixed 20, avoiding re-extraction.
 */
export async function processConversationEnd(
  provider: Provider,
  sessionKey: string,
  messagesSinceExtraction?: number
): Promise<void> {
  const logger = getLogger();
  const userId = extractUserId(sessionKey);

  // Prevent concurrent extractions for the same session
  if (activeExtractions.has(sessionKey)) {
    logger.debug({ sessionKey }, 'Extraction already in progress, skipping');
    return;
  }
  activeExtractions.add(sessionKey);

  try {
    const fetchCount = messagesSinceExtraction ?? 20;
    const messages = getRecentMessages(sessionKey, fetchCount);

    if (messages.length < 2) {
      return; // Not enough messages
    }

    // Extract key memories with user context
    const extractedIds = await extractMemories(provider, messages, sessionKey, userId ?? undefined);
    logger.info({ count: extractedIds.length, sessionKey, userId }, 'Memories extracted');

    // Auto-assign new memories to coherence groups
    for (const id of extractedIds) {
      try {
        autoAssignToGroups(id);
      } catch (err) {
        logger.debug({ err, memoryId: id }, 'Failed to auto-assign memory to group (non-critical)');
      }
    }

    // Check for high-signal extractions and trigger proactive reflection
    if (extractedIds.length > 0) {
      const hasHighSignal = extractedIds.some((id) => {
        const mem = getMemory(id);
        return mem && mem.importance >= 0.8;
      });
      if (hasHighSignal) {
        import('../agent/proactive.js')
          .then((mod) => mod.onHighSignalExtraction())
          .catch((err) => logger.warn({ err }, 'Failed to trigger proactive reflection'));
      }
    }

    // Reset per-session extraction state
    resetExtractionState(sessionKey);

    // Generate conversation summary if enough messages
    if (messages.length >= 4) {
      await summarizeConversation(provider, messages, sessionKey, userId ?? undefined);
      logger.info({ sessionKey, userId }, 'Conversation summarized');
    }

    // Consolidate similar memories frequently to build association web
    const stats = getMemoryStats();
    if (stats.memories > 10 && stats.memories % 10 === 0) {
      const linkedCount = await consolidateMemories(userId ?? undefined);
      if (linkedCount > 0) {
        logger.info({ linkedCount, userId }, 'Consolidated similar memories');
      }
    }
  } catch (error) {
    logger.error({ error, sessionKey }, 'Failed to process conversation end');
  } finally {
    activeExtractions.delete(sessionKey);
  }
}

/**
 * Get memory statistics
 */
export function getMemoryStats(): { memories: number; messages: number } {
  return {
    memories: countMemories(),
    messages: countMessages(),
  };
}

// Rough token estimate (4 chars per token)
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}


/**
 * Build system prompt addition with memory context
 * Uses 4 tiered layers with dedicated token budgets:
 *   1. Identity (~1200 tokens) — core facts + preferences
 *   2. Temporal (~1500 tokens) — monthly + weekly narrative arc
 *   3. Relevance (~3000 tokens) — recent messages, relevant/associated memories, discoveries
 *   4. Resonance (~500 tokens) — one surprise memory from the past
 */
export async function buildMemoryContext(
  userMessage: string,
  sessionKey: string
): Promise<string> {
  const logger = getLogger();
  const userId = extractUserId(sessionKey);
  let context = '';
  let usedTokens = 0;

  const MAX_CONTEXT_TOKENS = 7000;

  // ── Layer 1: Identity (~500 tokens) ──
  try {
    const facts = getMemoriesByType('fact');
    const preferences = getMemoriesByType('preference');

    // Score by importance × access, take top items
    const scoreMemory = (m: Memory) => m.importance * 0.7 + Math.min(m.accessCount * 0.02, 0.3);
    const topFacts = facts.sort((a, b) => scoreMemory(b) - scoreMemory(a)).slice(0, 6);
    const topPrefs = preferences.sort((a, b) => scoreMemory(b) - scoreMemory(a)).slice(0, 5);
    const identityItems = [...topFacts, ...topPrefs];

    if (identityItems.length > 0) {
      const lines = identityItems.map((m) => {
        const content = m.content.length > 400 ? m.content.slice(0, 400) + '...' : m.content;
        return `- ${content}`;
      });
      const identityText = '\n\n[Core knowledge]\n' + lines.join('\n') + '\n';
      const tokens = estimateTokens(identityText);
      if (tokens <= 1200) {
        context += identityText;
        usedTokens += tokens;
      }
    }

    // Entity memories — people, projects, concepts
    const entities = getEntityMemories(8);
    if (entities.length > 0) {
      const entityLines = entities.map((m) => {
        const name = (m.metadata?.entityName as string) || 'unknown';
        const content = m.content.length > 200 ? m.content.slice(0, 200) + '...' : m.content;
        return `- ${name}: ${content}`;
      });
      const entityText = '\n\n[People and things you know]\n' + entityLines.join('\n') + '\n';
      const entityTokens = estimateTokens(entityText);
      if (usedTokens + entityTokens <= 1200) {
        context += entityText;
        usedTokens += entityTokens;
      }
    }
  } catch (error) {
    logger.debug({ error }, 'Layer 1 (identity) failed (non-critical)');
  }

  // ── Layer 2: Temporal (~1000 tokens) ──
  try {
    const monthly = getMonthlyNarrative();
    const weekly = getWeeklyNarrative();

    if (monthly || weekly) {
      let arcText = '\n\n[Your recent arc]\n';
      if (monthly) arcText += 'This month: ' + monthly + '\n';
      if (weekly) arcText += 'This week: ' + weekly + '\n';

      const tokens = estimateTokens(arcText);
      if (tokens <= 1500) {
        context += arcText;
        usedTokens += tokens;
      }
    }
  } catch (error) {
    logger.debug({ error }, 'Layer 2 (temporal) failed (non-critical)');
  }

  // ── Layer 3: Relevance (~1200 tokens) ──
  const relevanceBudget = Math.min(3000, MAX_CONTEXT_TOKENS - usedTokens - 500);

  if (relevanceBudget > 300) {
    let layerText = '';
    let layerTokens = 0;

    // 3a. Recent conversation (cross-channel)
    try {
      const allRecent = getAllRecentMessages(20);
      const seen = new Set<string>();
      const merged: typeof allRecent = [];

      if (userId) {
        const userMessages = getMessagesForUser(userId, 12);
        for (const m of userMessages) {
          if (!seen.has(m.id)) { seen.add(m.id); merged.push(m); }
        }
      }
      for (const m of allRecent) {
        if (!seen.has(m.id)) { seen.add(m.id); merged.push(m); }
      }

      merged.sort((a, b) => a.timestamp - b.timestamp);
      const limitedMessages = merged.slice(-12);

      if (limitedMessages.length > 0) {
        const historyText = limitedMessages
          .map((m) => {
            const prefix = m.role === 'user' ? 'User' : 'Lain';
            const content = m.content.length > 400 ? m.content.slice(0, 400) + '...' : m.content;
            return prefix + ': ' + content;
          })
          .join('\n');

        const historySection = '\n\n[Recent conversation]\n' + historyText + '\n';
        const tokens = estimateTokens(historySection);
        if (layerTokens + tokens < relevanceBudget) {
          layerText += historySection;
          layerTokens += tokens;
        }
      }
    } catch (error) {
      logger.warn({ error }, 'Failed to get recent messages');
    }

    // 3b. Relevant memories (compact references with expand_memory tool) + associated (4)
    if (layerTokens < relevanceBudget - 200) {
      try {
        const relevant = await getRelevantMemoriesWithIds(userMessage, sessionKey, 6);

        if (relevant.memoryIds.length > 0) {
          // Compact 1-line references — agent can use expand_memory tool for details
          const compactLines = relevant.memoryIds.map((id) => {
            const mem = getMemory(id);
            if (!mem) return null;
            const typeLabel = getTypeLabel(mem.memoryType).toLowerCase();
            // Annotate with coherence group name if available
            let groupTag = '';
            try {
              const groups = getGroupsForMemory(id);
              const namedGroup = groups.find((g) => g.name);
              if (namedGroup) groupTag = ` [pattern: ${namedGroup.name}]`;
            } catch { /* non-critical */ }
            return `- [mem:${id}] (${typeLabel}, imp:${mem.importance.toFixed(1)}) ${mem.content.slice(0, 80)}${groupTag}`;
          }).filter(Boolean);

          if (compactLines.length > 0) {
            const compactText = '\n\n[Relevant memories — use expand_memory to read details]\n' + compactLines.join('\n') + '\n';
            const tokens = estimateTokens(compactText);
            if (layerTokens + tokens < relevanceBudget) {
              layerText += compactText;
              layerTokens += tokens;
            }
          }

          // Associated memories — follow the association web deeper
          if (layerTokens < relevanceBudget - 200) {
            const associated = getAssociatedMemories(relevant.memoryIds, 4);
            if (associated.length > 0) {
              const assocLines = associated
                .map((m) => {
                  return `- [mem:${m.id}] (${getTypeLabel(m.memoryType).toLowerCase()}, imp:${m.importance.toFixed(1)}) ${m.content.slice(0, 80)}`;
                })
                .join('\n');
              const assocText = '\n\n[Connected memories]\n' + assocLines + '\n';
              const tokens = estimateTokens(assocText);
              if (layerTokens + tokens < relevanceBudget) {
                layerText += assocText;
                layerTokens += tokens;
              }
            }
          }
        }
      } catch (error) {
        logger.debug({ error }, 'Failed to get relevant memories (non-critical)');
      }
    }

    // 3c. Browsing discoveries — fetch more candidates with a lower similarity
    //     threshold so curiosity memories actually surface during conversation.
    //     Previously used limit=2, minSimilarity=0.45 which was too restrictive.
    if (layerTokens < relevanceBudget - 100) {
      try {
        // Semantic search: wide net, low threshold
        const discoveries = await searchMemories(userMessage, 12, 0.1, undefined, {
          memoryTypes: ['episode'],
        });

        let browseDiscoveries = discoveries
          .filter((r) => r.memory.sessionKey === 'curiosity:browse')
          .slice(0, 5);

        // Always also fetch recent discoveries — Lain should remember what she
        // explored recently regardless of whether it matches the current topic
        if (browseDiscoveries.length < 3) {
          const recentFallback = await searchMemories(
            'interesting topics and discoveries', 6, 0.05, undefined,
            { memoryTypes: ['episode'], sortBy: 'recency' },
          );
          const existingIds = new Set(browseDiscoveries.map((r) => r.memory.id));
          const additional = recentFallback
            .filter((r) => r.memory.sessionKey === 'curiosity:browse' && !existingIds.has(r.memory.id))
            .slice(0, 3 - browseDiscoveries.length);
          browseDiscoveries = [...browseDiscoveries, ...additional];
        }

        if (browseDiscoveries.length > 0) {
          const discoveryLines = browseDiscoveries.map((r) => {
            const themes = (r.memory.metadata?.themes as string[]) || [];
            const themeStr = themes.length > 0 ? ` (themes: ${themes.join(', ')})` : '';
            const content = r.memory.content.length > 500
              ? r.memory.content.slice(0, 500) + '...'
              : r.memory.content;
            return `- [Discovery] ${content}${themeStr}`;
          });

          const discoveryText = '\n\n[Things you explored on your own]\n' + discoveryLines.join('\n') + '\n';
          const tokens = estimateTokens(discoveryText);
          if (layerTokens + tokens < relevanceBudget) {
            layerText += discoveryText;
            layerTokens += tokens;
          }
        }
      } catch (error) {
        logger.debug({ error }, 'Failed to surface browsing discoveries (non-critical)');
      }
    }

    context += layerText;
    usedTokens += layerTokens;
  }

  // ── Layer 4: Resonance (~500 tokens) ──
  if (usedTokens < MAX_CONTEXT_TOKENS - 200) {
    try {
      const resonance = getResonanceMemory(userId ?? undefined);
      if (resonance) {
        const ageMs = Date.now() - resonance.createdAt;
        const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
        const ageLabel = ageDays > 30
          ? `~${Math.floor(ageDays / 30)} month${Math.floor(ageDays / 30) > 1 ? 's' : ''} ago`
          : `~${ageDays} day${ageDays !== 1 ? 's' : ''} ago`;

        const content = resonance.content.length > 500
          ? resonance.content.slice(0, 500) + '...'
          : resonance.content;

        const resonanceText = `\n\n[Something on your mind]\n(from ${ageLabel}) ${content}\n`;
        const tokens = estimateTokens(resonanceText);
        if (usedTokens + tokens <= MAX_CONTEXT_TOKENS) {
          context += resonanceText;
          usedTokens += tokens;
        }
      }
    } catch (error) {
      logger.debug({ error }, 'Layer 4 (resonance) failed (non-critical)');
    }
  }

  logger.debug({ totalTokens: usedTokens }, 'Built memory context');
  return context;
}

function getTypeLabel(type: Memory['memoryType']): string {
  switch (type) {
    case 'fact':
      return 'Fact';
    case 'preference':
      return 'Preference';
    case 'context':
      return 'Context';
    case 'summary':
      return 'Summary';
    case 'episode':
      return 'Past conversation';
    default:
      return 'Memory';
  }
}
