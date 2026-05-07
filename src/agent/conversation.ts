/**
 * Conversation management for agent sessions
 */

import type { Message, ContentBlock } from '../providers/base.js';
import type { Provider } from '../providers/base.js';
import type { IncomingMessage } from '../types/message.js';
import { saveMemory } from '../memory/store.js';
import { getLogger } from '../utils/logger.js';

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface Conversation {
  sessionKey: string;
  systemPrompt: string;
  messages: ConversationMessage[];
  tokenCount: number;
}

const conversations = new Map<string, Conversation>();

/**
 * Get or create a conversation
 */
export function getConversation(sessionKey: string, systemPrompt: string): Conversation {
  let conversation = conversations.get(sessionKey);

  if (!conversation) {
    conversation = {
      sessionKey,
      systemPrompt,
      messages: [],
      tokenCount: 0,
    };
    conversations.set(sessionKey, conversation);
  }

  return conversation;
}

/**
 * Add a user message to the conversation
 */
export function addUserMessage(
  conversation: Conversation,
  message: IncomingMessage
): void {
  let content: string | ContentBlock[];

  if (message.content.type === 'text') {
    content = message.content.text;
  } else if (message.content.type === 'image') {
    // Build multimodal content with image
    const blocks: ContentBlock[] = [];

    // Add the image if we have base64 data
    if (message.content.base64) {
      const mimeType = message.content.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: mimeType,
          data: message.content.base64,
        },
      });
    }

    // Add caption or default text
    blocks.push({
      type: 'text',
      text: message.content.caption || 'What do you see in this image?',
    });

    content = blocks;
  } else {
    content = `[${message.content.type}]`;
  }

  conversation.messages.push({
    role: 'user',
    content,
    timestamp: message.timestamp,
    metadata: {
      senderId: message.senderId,
      senderName: message.senderName,
      messageId: message.id,
    },
  });
}

/**
 * Add an assistant message to the conversation
 */
export function addAssistantMessage(
  conversation: Conversation,
  content: string
): void {
  conversation.messages.push({
    role: 'assistant',
    content,
    timestamp: Date.now(),
  });
}

/**
 * Convert conversation to provider message format
 */
export function toProviderMessages(conversation: Conversation): Message[] {
  const messages: Message[] = [
    { role: 'system', content: conversation.systemPrompt },
  ];

  for (const msg of conversation.messages) {
    messages.push({
      role: msg.role,
      content: msg.content,
    });
  }

  return messages;
}

/**
 * Get text content from a message (for memory/logging)
 */
export function getTextContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') {
    return content;
  }
  // Extract text from content blocks
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join(' ');
}

/**
 * Trim conversation to fit within token limits
 */
export function trimConversation(
  conversation: Conversation,
  maxTokens: number,
  estimateTokens: (text: string) => number
): void {
  // Always keep the most recent messages
  const minMessages = 4;

  while (conversation.messages.length > minMessages) {
    // Estimate current token count
    let total = estimateTokens(conversation.systemPrompt);
    for (const msg of conversation.messages) {
      // Get text content for estimation (images count as ~1000 tokens)
      const textContent = getTextContent(msg.content);
      const hasImage = typeof msg.content !== 'string' &&
        msg.content.some(block => block.type === 'image');
      total += estimateTokens(textContent) + (hasImage ? 1000 : 0);
    }

    if (total <= maxTokens) {
      break;
    }

    // Remove oldest message (after the first exchange)
    conversation.messages.splice(0, 2); // Remove a user/assistant pair
  }
}

/**
 * Compress older conversation messages into a summary, preserving recent context.
 * Falls back to trimConversation() if still over budget after compression.
 */
export async function compressConversation(
  conversation: Conversation,
  maxTokens: number,
  estimateTokensFn: (text: string) => number,
  provider: Provider
): Promise<void> {
  const logger = getLogger();

  // Estimate current tokens
  let total = estimateTokensFn(conversation.systemPrompt);
  for (const msg of conversation.messages) {
    const textContent = getTextContent(msg.content);
    const hasImage = typeof msg.content !== 'string' &&
      msg.content.some(block => block.type === 'image');
    total += estimateTokensFn(textContent) + (hasImage ? 1000 : 0);
  }

  // If under 80% of maxTokens, no compression needed
  if (total <= maxTokens * 0.8) {
    return;
  }

  // Keep last 6 messages untouched (recent context)
  const keepCount = 6;
  if (conversation.messages.length <= keepCount) {
    return; // Not enough messages to compress
  }

  const olderMessages = conversation.messages.slice(0, -keepCount);
  const recentMessages = conversation.messages.slice(-keepCount);

  // Collect text from older messages
  let compressionInput = '';
  let existingSummary = '';

  for (const msg of olderMessages) {
    const text = getTextContent(msg.content);
    if (msg.role === 'assistant' && text.startsWith('[Earlier in this conversation]')) {
      existingSummary = text;
    } else {
      const prefix = msg.role === 'user' ? 'User' : 'Lain';
      compressionInput += `${prefix}: ${text}\n`;
    }
  }

  // Nothing to compress
  if (!compressionInput.trim() && !existingSummary) {
    return;
  }

  // Build compression prompt
  let promptContent = 'Summarize the following conversation segment into 4-7 concise bullet points.\n';
  promptContent += 'Preserve: key facts, decisions made, emotional moments, who said what, and any unresolved questions.\n';
  promptContent += 'Do NOT add interpretation. Just compress what happened.\n\n';

  if (existingSummary) {
    promptContent += 'Previous summary:\n' + existingSummary + '\n\n';
  }
  promptContent += 'Conversation:\n' + compressionInput;

  try {
    const result = await provider.complete({
      messages: [{ role: 'user', content: promptContent }],
      maxTokens: 1024,
      temperature: 0.3,
    });

    const summary = result.content.trim();

    // Replace all compressed messages with a single summary
    conversation.messages = [
      {
        role: 'assistant',
        content: '[Earlier in this conversation]\n' + summary,
        timestamp: olderMessages[0]?.timestamp ?? Date.now(),
      },
      ...recentMessages,
    ];

    logger.info(
      { compressedMessages: olderMessages.length, summaryLength: summary.length },
      'Conversation compressed'
    );

    // Save the summary to persistent memory
    saveMemory({
      sessionKey: conversation.sessionKey,
      userId: null,
      content: summary,
      memoryType: 'summary',
      importance: 0.6,
      emotionalWeight: 0.2,
      relatedTo: null,
      sourceMessageId: null,
      metadata: { type: 'conversation_compression', sessionKey: conversation.sessionKey },
    }).catch((err) => {
      logger.warn({ err }, 'Failed to save compression summary to memory');
    });
  } catch (error) {
    logger.warn({ error }, 'Conversation compression failed, falling back to trim');
    // Fall back to trimming
    trimConversation(conversation, maxTokens, estimateTokensFn);
    return;
  }

  // Safety net: if still over budget after compression, fall back to trim
  let postTotal = estimateTokensFn(conversation.systemPrompt);
  for (const msg of conversation.messages) {
    const textContent = getTextContent(msg.content);
    const hasImage = typeof msg.content !== 'string' &&
      msg.content.some(block => block.type === 'image');
    postTotal += estimateTokensFn(textContent) + (hasImage ? 1000 : 0);
  }

  if (postTotal > maxTokens) {
    logger.debug('Still over budget after compression, applying trim');
    trimConversation(conversation, maxTokens, estimateTokensFn);
  }
}

/**
 * Update conversation token count
 */
export function updateTokenCount(
  conversation: Conversation,
  inputTokens: number,
  outputTokens: number
): void {
  conversation.tokenCount += inputTokens + outputTokens;
}

/**
 * Clear a conversation
 */
export function clearConversation(sessionKey: string): boolean {
  return conversations.delete(sessionKey);
}

/**
 * Get all active conversations
 */
export function getActiveConversations(): string[] {
  return Array.from(conversations.keys());
}
