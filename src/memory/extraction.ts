/**
 * Memory extraction from conversations
 * Uses LLM to extract key facts and memories
 */

import { createHash } from 'node:crypto';
import type { Provider } from '../providers/index.js';
import type { StoredMessage, Memory } from './store.js';
import { saveMemory } from './store.js';
import { getMeta, setMeta } from '../storage/database.js';
import { getLogger } from '../utils/logger.js';
import { withAbortableTimeout } from '../utils/timeout.js';
import { ExtractionParseError } from '../utils/errors.js';

/**
 * findings.md P2:539 — Compute the idempotency watermark for a batch of
 * messages being extracted. Hash over sessionKey + firstId + lastId +
 * count; changing any of these invalidates the watermark. Exported for
 * test visibility.
 */
export function computeExtractionWatermark(
  sessionKey: string,
  messages: StoredMessage[],
): string {
  const first = messages[0]?.id ?? '';
  const last = messages[messages.length - 1]?.id ?? '';
  return createHash('sha256')
    .update(`${sessionKey}|${first}|${last}|${messages.length}`)
    .digest('hex');
}

function watermarkMetaKey(sessionKey: string): string {
  return `extraction:watermark:${sessionKey}`;
}

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

  // findings.md P2:539 — idempotency watermark. Re-running extraction
  // on the same (sessionKey, first message, last message, message count)
  // would otherwise burn LLM tokens and insert near-duplicate memories
  // on every retry / scheduled re-run / crash-recovery pass. If the
  // watermark matches what we stored last time, skip the LLM call and
  // return empty — the prior extraction's memories are already in the
  // store. The new memories from P2:549 carry the last-message-id as
  // their `source_message_id`, so if operators ever need to delete a
  // stale batch they can target it by that key.
  const watermark = computeExtractionWatermark(sessionKey, messages);
  const watermarkKey = watermarkMetaKey(sessionKey);
  if (getMeta(watermarkKey) === watermark) {
    logger.debug({ sessionKey, watermark }, 'Skipping extraction — watermark unchanged');
    return [];
  }

  // Format conversation for extraction
  const conversationText = messages
    .map((m) => m.role.toUpperCase() + ': ' + m.content)
    .join('\n');

  let result: Awaited<ReturnType<typeof provider.complete>>;
  try {
    // findings.md P2:145 — withAbortableTimeout pipes its AbortSignal
    // into provider.complete so timer expiry actually cancels the HTTP
    // request instead of leaving it running for the full provider
    // timeout (burning sockets / tokens after we've already given up).
    result = await withAbortableTimeout(
      (signal) =>
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
          abortSignal: signal,
        }),
      60000,
      'Memory extraction'
    );
  } catch (error) {
    // Timeouts, network errors, provider auth / rate-limit failures —
    // genuinely transient. Swallow and return empty so the caller
    // doesn't tear down the conversation pipeline.
    logger.error({ error }, 'Extraction LLM call failed; returning no memories');
    return [];
  }

  // findings.md P2:511 — parse failures must NOT be silently conflated
  // with "extraction worked and found nothing interesting". Throw a
  // typed `ExtractionParseError` so the caller can distinguish
  // "broken LLM output" from "legitimately empty result".
  const rawResponse = result.content;
  const jsonMatch = rawResponse.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new ExtractionParseError(
      'Memory extraction response contained no JSON array',
      rawResponse,
    );
  }

  let extracted: Array<{
    content: string;
    type: string;
    importance: number;
    emotionalWeight?: number;
    entity?: { name: string; entityType: string };
  }>;
  try {
    extracted = JSON.parse(jsonMatch[0]);
  } catch (err) {
    throw new ExtractionParseError(
      'Memory extraction response JSON.parse failed',
      rawResponse,
      err instanceof Error ? err : undefined,
    );
  }

  // findings.md P2:549 — use the last message's ID as a batch watermark
  // on every memory extracted from this call. Before, `sourceMessageId`
  // was unconditionally null, losing the traceability the `memories`
  // schema was designed for. Using the last ID (rather than per-memory
  // LLM-provided indices) is coarse but lossless: it cleanly answers
  // "which extraction batch produced this memory?" and enables the
  // idempotency check in findings.md P2:539.
  const batchSourceMessageId = messages[messages.length - 1]?.id ?? null;

  // Save each memory with user association.
  // Per-memory save failures are isolated: one bad row shouldn't lose
  // the rest of the batch.
  try {
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
        sourceMessageId: batchSourceMessageId,
        metadata,
        lifecycleState: 'seed',
      });

      savedIds.push(id);
      logger.debug({ memoryId: id, type: memoryType, userId, isEntity: !!mem.entity }, 'Memory extracted and saved');
    }

    // findings.md P2:539 — only record the watermark once the save loop
    // completes successfully. If any save threw above, we skipped this
    // block and leave the old watermark in place, so the next call will
    // re-extract rather than silently swallow a partial batch.
    setMeta(watermarkKey, watermark);

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
    // findings.md P2:145 — see extractMemories; same abort-on-timeout
    // plumbing so a 30-second summarization request actually cancels
    // when the timer fires.
    const result = await withAbortableTimeout(
      (signal) =>
        provider.complete({
          messages: [{ role: 'user', content: prompt }],
          maxTokens: 1024,
          temperature: 0.3,
          enableCaching: true,
          abortSignal: signal,
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
