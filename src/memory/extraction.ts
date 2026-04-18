/**
 * Memory extraction from conversations
 * Uses LLM to extract key facts and memories
 */

import type { Provider } from '../providers/index.js';
import type { StoredMessage, Memory } from './store.js';
import { saveMemory } from './store.js';
import { getLogger } from '../utils/logger.js';
import { withTimeout } from '../utils/timeout.js';

const EXTRACTION_PROMPT = `You are a memory extraction system. Analyze the conversation and extract key memories.

For each memory, identify:
1. Facts about the user (preferences, background, work, relationships)
2. Important context (ongoing projects, goals, problems)
3. User preferences (communication style, interests, dislikes)
4. Emotional significance (how emotionally meaningful is this moment?)
5. Named entities — specific people, projects, systems, or concepts mentioned by name

Output JSON array of memories:
[
  {
    "content": "clear description of the memory",
    "type": "fact" | "preference" | "context",
    "importance": 0.0-1.0,
    "emotionalWeight": 0.0-1.0
  }
]

For entities, include an "entity" field:
  {
    "content": "description of entity and what's known",
    "type": "fact",
    "importance": 0.0-1.0,
    "emotionalWeight": 0.0-1.0,
    "entity": { "name": "entity name", "entityType": "person | project | concept | system | place" }
  }

emotionalWeight guidelines:
- 0.0: Routine, purely informational
- 0.3: Mildly personal or interesting
- 0.5: Meaningful conversation, shared something real
- 0.7: Vulnerable moment, deep connection, significant revelation
- 1.0: Defining moment in the relationship

Only extract genuinely important information. Skip trivial or temporary details.
If no significant memories, return empty array: []

Conversation:
`;

/**
 * Extract memories from a conversation using LLM
 * Associates memories with specific users when userId is provided
 */
export async function extractMemories(
  provider: Provider,
  messages: StoredMessage[],
  sessionKey: string,
  userId?: string
): Promise<string[]> {
  const logger = getLogger();

  if (messages.length === 0) {
    return [];
  }

  // Format conversation for extraction
  const conversationText = messages
    .map((m) => m.role.toUpperCase() + ': ' + m.content)
    .join('\n');

  try {
    const result = await withTimeout(
      provider.complete({
        messages: [
          {
            role: 'user',
            content: EXTRACTION_PROMPT + conversationText,
          },
        ],
        maxTokens: 2048,
        temperature: 0.3, // Low temperature for consistent extraction
        enableCaching: true,
      }),
      60000,
      'Memory extraction'
    );

    // Parse extracted memories
    const jsonMatch = result.content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      logger.debug('No memories extracted from conversation');
      return [];
    }

    const extracted = JSON.parse(jsonMatch[0]) as Array<{
      content: string;
      type: string;
      importance: number;
      emotionalWeight?: number;
      entity?: { name: string; entityType: string };
    }>;

    // Save each memory with user association
    const savedIds: string[] = [];
    for (const mem of extracted) {
      const memoryType = validateMemoryType(mem.type);
      const importance = Math.max(0, Math.min(1, mem.importance || 0.5));
      const emotionalWeight = Math.max(0, Math.min(1, mem.emotionalWeight ?? 0));

      const metadata: Record<string, unknown> = {
        extractedFrom: sessionKey,
        messageCount: messages.length,
      };

      // Add entity metadata if present
      if (mem.entity?.name) {
        metadata.isEntity = true;
        metadata.entityName = mem.entity.name;
        metadata.entityType = mem.entity.entityType || 'concept';
      }

      const id = await saveMemory({
        sessionKey,
        userId: userId ?? null,
        content: mem.content,
        memoryType,
        importance,
        emotionalWeight,
        relatedTo: null,
        sourceMessageId: null,
        metadata,
        lifecycleState: 'seed',
      });

      savedIds.push(id);
      logger.debug({ memoryId: id, type: memoryType, userId, isEntity: !!mem.entity }, 'Memory extracted and saved');
    }

    return savedIds;
  } catch (error) {
    logger.error({ error }, 'Failed to extract memories');
    return [];
  }
}

/**
 * Generate a summary of a conversation
 * Associates summary with specific user when userId is provided
 */
export async function summarizeConversation(
  provider: Provider,
  messages: StoredMessage[],
  sessionKey: string,
  userId?: string
): Promise<string | null> {
  const logger = getLogger();

  if (messages.length < 3) {
    return null; // Not enough messages to summarize
  }

  const conversationText = messages
    .map((m) => m.role.toUpperCase() + ': ' + m.content)
    .join('\n');

  const prompt = 'Summarize this conversation in 3-5 sentences, focusing on the main topics discussed, emotional tone, any conclusions or decisions made, and any personal details shared:\n\n' + conversationText + '\n\nSummary:';

  try {
    const result = await withTimeout(
      provider.complete({
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 512,
        temperature: 0.3,
        enableCaching: true,
      }),
      30000,
      'Conversation summarization'
    );

    const summary = result.content.trim();

    // Save as episode memory with user association
    await saveMemory({
      sessionKey,
      userId: userId ?? null,
      content: 'Conversation summary: ' + summary,
      memoryType: 'episode',
      importance: 0.7,
      emotionalWeight: 0.4,
      relatedTo: null,
      sourceMessageId: null,
      metadata: {
        type: 'conversation_summary',
        messageCount: messages.length,
        timeRange: {
          start: messages[0]?.timestamp,
          end: messages[messages.length - 1]?.timestamp,
        },
      },
    });

    return summary;
  } catch (error) {
    logger.error({ error }, 'Failed to summarize conversation');
    return null;
  }
}

function validateMemoryType(type: string): Memory['memoryType'] {
  const validTypes: Memory['memoryType'][] = ['fact', 'preference', 'context', 'summary', 'episode'];
  if (validTypes.includes(type as Memory['memoryType'])) {
    return type as Memory['memoryType'];
  }
  return 'fact'; // Default
}
