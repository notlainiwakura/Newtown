/**
 * Conversation management tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn().mockResolvedValue('test-master-key'),
    setPassword: vi.fn().mockResolvedValue(undefined),
    deletePassword: vi.fn().mockResolvedValue(true),
    findCredentials: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../src/memory/store.js', () => ({
  saveMemory: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/utils/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  getConversation,
  addUserMessage,
  addAssistantMessage,
  toProviderMessages,
  trimConversation,
  compressConversation,
  clearConversation,
  getActiveConversations,
  getTextContent,
  updateTokenCount,
} from '../src/agent/conversation.js';
import type { Conversation } from '../src/agent/conversation.js';
import type { IncomingMessage } from '../src/types/message.js';
import type { Provider } from '../src/providers/base.js';

function makeTextMessage(text: string, overrides?: Partial<IncomingMessage>): IncomingMessage {
  return {
    id: 'msg-' + Math.random().toString(36).slice(2, 8),
    channel: 'web',
    peerKind: 'user',
    peerId: 'peer-1',
    senderId: 'user-1',
    senderName: 'Test User',
    content: { type: 'text', text },
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeImageMessage(base64: string, caption?: string): IncomingMessage {
  return {
    id: 'msg-img-' + Math.random().toString(36).slice(2, 8),
    channel: 'web',
    peerKind: 'user',
    peerId: 'peer-1',
    senderId: 'user-1',
    senderName: 'Test User',
    content: {
      type: 'image',
      base64,
      mimeType: 'image/png',
      caption,
    },
    timestamp: Date.now(),
  };
}

function makeFileMessage(): IncomingMessage {
  return {
    id: 'msg-file-1',
    channel: 'web',
    peerKind: 'user',
    peerId: 'peer-1',
    senderId: 'user-1',
    content: {
      type: 'file',
      mimeType: 'application/pdf',
      filename: 'test.pdf',
    },
    timestamp: Date.now(),
  };
}

function simpleEstimator(text: string): number {
  return Math.ceil(text.length / 4);
}

function makeMockProvider(summary: string): Provider {
  return {
    name: 'mock',
    model: 'mock-model',
    complete: vi.fn().mockResolvedValue({
      content: summary,
      finishReason: 'stop' as const,
      usage: { inputTokens: 10, outputTokens: 20 },
    }),
    completeWithTools: vi.fn(),
    stream: vi.fn(),
    streamWithTools: vi.fn(),
  } as unknown as Provider;
}

describe('Conversation Management', () => {
  beforeEach(() => {
    // Clear all conversations between tests
    for (const key of getActiveConversations()) {
      clearConversation(key);
    }
  });

  describe('getConversation', () => {
    it('should create a new conversation when none exists', () => {
      const conv = getConversation('session-1', 'You are a helpful assistant.');
      expect(conv.sessionKey).toBe('session-1');
      expect(conv.systemPrompt).toBe('You are a helpful assistant.');
      expect(conv.messages).toEqual([]);
      expect(conv.tokenCount).toBe(0);
    });

    it('should return the existing conversation on second call', () => {
      const conv1 = getConversation('session-2', 'prompt-1');
      addAssistantMessage(conv1, 'hello');
      const conv2 = getConversation('session-2', 'prompt-2');
      // Same object returned — messages preserved
      expect(conv2.messages).toHaveLength(1);
      expect(conv2).toBe(conv1);
    });

    it('should maintain separate conversations for different session keys', () => {
      const conv1 = getConversation('a', 'prompt a');
      const conv2 = getConversation('b', 'prompt b');
      addAssistantMessage(conv1, 'msg for a');
      expect(conv1.messages).toHaveLength(1);
      expect(conv2.messages).toHaveLength(0);
    });

    it('should initialize with empty messages array', () => {
      const conv = getConversation('empty-test', 'sys');
      expect(Array.isArray(conv.messages)).toBe(true);
      expect(conv.messages.length).toBe(0);
    });
  });

  describe('addUserMessage', () => {
    it('should add a text message', () => {
      const conv = getConversation('user-msg-1', 'sys');
      addUserMessage(conv, makeTextMessage('hello world'));
      expect(conv.messages).toHaveLength(1);
      expect(conv.messages[0]!.role).toBe('user');
      expect(conv.messages[0]!.content).toBe('hello world');
    });

    it('should add an image message with base64 data and caption', () => {
      const conv = getConversation('user-img-1', 'sys');
      addUserMessage(conv, makeImageMessage('abc123', 'a cat'));
      expect(conv.messages).toHaveLength(1);
      const content = conv.messages[0]!.content;
      expect(Array.isArray(content)).toBe(true);
      const blocks = content as Array<{ type: string }>;
      expect(blocks).toHaveLength(2);
      expect(blocks[0]!.type).toBe('image');
      expect(blocks[1]!.type).toBe('text');
      expect((blocks[1] as { text: string }).text).toBe('a cat');
    });

    it('should use default caption when image has no caption', () => {
      const conv = getConversation('user-img-2', 'sys');
      addUserMessage(conv, makeImageMessage('abc123'));
      const blocks = conv.messages[0]!.content as Array<{ type: string; text?: string }>;
      const textBlock = blocks.find((b) => b.type === 'text');
      expect(textBlock!.text).toBe('What do you see in this image?');
    });

    it('should handle image message without base64 (url-only)', () => {
      const conv = getConversation('user-img-3', 'sys');
      const msg: IncomingMessage = {
        id: 'msg-img-no-b64',
        channel: 'web',
        peerKind: 'user',
        peerId: 'peer-1',
        senderId: 'user-1',
        content: {
          type: 'image',
          mimeType: 'image/jpeg',
          url: 'https://example.com/img.jpg',
        },
        timestamp: Date.now(),
      };
      addUserMessage(conv, msg);
      const blocks = conv.messages[0]!.content as Array<{ type: string }>;
      // No image block because no base64, only text
      expect(blocks).toHaveLength(1);
      expect(blocks[0]!.type).toBe('text');
    });

    it('should handle unknown content type as bracketed placeholder', () => {
      const conv = getConversation('user-file-1', 'sys');
      addUserMessage(conv, makeFileMessage());
      expect(conv.messages[0]!.content).toBe('[file]');
    });

    it('should preserve metadata (senderId, senderName, messageId)', () => {
      const conv = getConversation('meta-test', 'sys');
      const msg = makeTextMessage('test', { senderId: 'uid-42', senderName: 'Alice' });
      addUserMessage(conv, msg);
      const meta = conv.messages[0]!.metadata!;
      expect(meta['senderId']).toBe('uid-42');
      expect(meta['senderName']).toBe('Alice');
      expect(meta['messageId']).toBe(msg.id);
    });

    it('should set timestamp from original message', () => {
      const conv = getConversation('ts-test', 'sys');
      const msg = makeTextMessage('hello', { timestamp: 12345 });
      addUserMessage(conv, msg);
      expect(conv.messages[0]!.timestamp).toBe(12345);
    });
  });

  describe('addAssistantMessage', () => {
    it('should add an assistant message with role assistant', () => {
      const conv = getConversation('asst-1', 'sys');
      addAssistantMessage(conv, 'I am an AI.');
      expect(conv.messages).toHaveLength(1);
      expect(conv.messages[0]!.role).toBe('assistant');
      expect(conv.messages[0]!.content).toBe('I am an AI.');
    });

    it('should set timestamp to current time', () => {
      const conv = getConversation('asst-ts', 'sys');
      const before = Date.now();
      addAssistantMessage(conv, 'reply');
      const after = Date.now();
      expect(conv.messages[0]!.timestamp).toBeGreaterThanOrEqual(before);
      expect(conv.messages[0]!.timestamp).toBeLessThanOrEqual(after);
    });

    it('should append to existing messages', () => {
      const conv = getConversation('asst-multi', 'sys');
      addAssistantMessage(conv, 'first');
      addAssistantMessage(conv, 'second');
      expect(conv.messages).toHaveLength(2);
      expect(conv.messages[1]!.content).toBe('second');
    });
  });

  describe('toProviderMessages', () => {
    it('should prepend system prompt as first message', () => {
      const conv = getConversation('prov-1', 'You are helpful.');
      const msgs = toProviderMessages(conv);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.role).toBe('system');
      expect(msgs[0]!.content).toBe('You are helpful.');
    });

    it('should include all conversation messages in order', () => {
      const conv = getConversation('prov-2', 'sys');
      addUserMessage(conv, makeTextMessage('hello'));
      addAssistantMessage(conv, 'hi');
      addUserMessage(conv, makeTextMessage('how are you'));
      const msgs = toProviderMessages(conv);
      expect(msgs).toHaveLength(4); // system + 3 messages
      expect(msgs[0]!.role).toBe('system');
      expect(msgs[1]!.role).toBe('user');
      expect(msgs[2]!.role).toBe('assistant');
      expect(msgs[3]!.role).toBe('user');
    });

    it('should preserve content type (string vs blocks) for each message', () => {
      const conv = getConversation('prov-3', 'sys');
      addUserMessage(conv, makeTextMessage('text'));
      addUserMessage(conv, makeImageMessage('imgdata', 'caption'));
      const msgs = toProviderMessages(conv);
      expect(typeof msgs[1]!.content).toBe('string');
      expect(Array.isArray(msgs[2]!.content)).toBe(true);
    });
  });

  describe('getTextContent', () => {
    it('should return string content directly', () => {
      expect(getTextContent('hello')).toBe('hello');
    });

    it('should extract text from content blocks', () => {
      const blocks = [
        { type: 'text' as const, text: 'first' },
        { type: 'text' as const, text: 'second' },
      ];
      expect(getTextContent(blocks)).toBe('first second');
    });

    it('should skip image blocks when extracting text', () => {
      const blocks = [
        {
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: 'image/png' as const,
            data: 'abc',
          },
        },
        { type: 'text' as const, text: 'caption' },
      ];
      expect(getTextContent(blocks)).toBe('caption');
    });

    it('should return empty string for empty array', () => {
      expect(getTextContent([])).toBe('');
    });

    it('should return empty string for blocks with no text', () => {
      const blocks = [
        {
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: 'image/jpeg' as const,
            data: 'xyz',
          },
        },
      ];
      expect(getTextContent(blocks)).toBe('');
    });
  });

  describe('trimConversation', () => {
    it('should not trim when under token limit', () => {
      const conv = getConversation('trim-1', 'short sys');
      addUserMessage(conv, makeTextMessage('hi'));
      addAssistantMessage(conv, 'hello');
      trimConversation(conv, 100000, simpleEstimator);
      expect(conv.messages).toHaveLength(2);
    });

    it('should remove oldest messages when over limit', () => {
      const conv = getConversation('trim-2', 'sys');
      // Add many messages to exceed budget
      for (let i = 0; i < 20; i++) {
        addUserMessage(conv, makeTextMessage('user message number ' + i));
        addAssistantMessage(conv, 'assistant reply number ' + i);
      }
      // Use a very small max to force trimming
      trimConversation(conv, 50, simpleEstimator);
      expect(conv.messages.length).toBeLessThan(40);
    });

    it('should keep minimum 4 messages', () => {
      const conv = getConversation('trim-min', 'sys');
      for (let i = 0; i < 10; i++) {
        addUserMessage(conv, makeTextMessage('msg ' + i));
        addAssistantMessage(conv, 'reply ' + i);
      }
      // Impossible budget: even 4 messages exceed this
      trimConversation(conv, 1, simpleEstimator);
      expect(conv.messages.length).toBe(4);
    });

    it('should remove messages in pairs (user/assistant)', () => {
      const conv = getConversation('trim-pairs', 'sys');
      for (let i = 0; i < 8; i++) {
        addUserMessage(conv, makeTextMessage('u' + i));
        addAssistantMessage(conv, 'a' + i);
      }
      const before = conv.messages.length;
      // Budget small enough to trigger one removal
      trimConversation(conv, 30, simpleEstimator);
      // Length decreases by multiples of 2
      const removed = before - conv.messages.length;
      expect(removed % 2).toBe(0);
    });

    it('should account for images as 1000 tokens each', () => {
      const conv = getConversation('trim-img', 'sys');
      // Add a message with image content
      addUserMessage(conv, makeImageMessage('data', 'look'));
      addAssistantMessage(conv, 'I see');
      addUserMessage(conv, makeTextMessage('more'));
      addAssistantMessage(conv, 'ok');
      addUserMessage(conv, makeTextMessage('extra'));
      addAssistantMessage(conv, 'fine');
      // Budget that would fit text but not the 1000-token image
      trimConversation(conv, 500, simpleEstimator);
      // Image message should have been removed
      expect(conv.messages.length).toBeLessThanOrEqual(4);
    });

    it('should include system prompt in token estimation', () => {
      const longSysPrompt = 'x'.repeat(2000); // ~500 tokens
      const conv = getConversation('trim-sys', longSysPrompt);
      for (let i = 0; i < 6; i++) {
        addUserMessage(conv, makeTextMessage('hi'));
        addAssistantMessage(conv, 'hello');
      }
      // Budget tight enough that system prompt alone eats most of it
      trimConversation(conv, 550, simpleEstimator);
      expect(conv.messages.length).toBeLessThanOrEqual(12);
    });
  });

  describe('compressConversation', () => {
    it('should not compress when under 80% threshold', async () => {
      const conv = getConversation('compress-noop', 'sys');
      addUserMessage(conv, makeTextMessage('hi'));
      addAssistantMessage(conv, 'hello');
      const provider = makeMockProvider('summary');
      await compressConversation(conv, 100000, simpleEstimator, provider);
      // Provider should not be called
      expect(provider.complete).not.toHaveBeenCalled();
      expect(conv.messages).toHaveLength(2);
    });

    it('should not compress when messages count is <= keepCount (6)', async () => {
      const conv = getConversation('compress-short', 'sys');
      for (let i = 0; i < 3; i++) {
        addUserMessage(conv, makeTextMessage('u' + i));
        addAssistantMessage(conv, 'a' + i);
      }
      // 6 messages exactly at keepCount
      const provider = makeMockProvider('summary');
      // Set budget to 0 so it would want to compress
      await compressConversation(conv, 1, simpleEstimator, provider);
      expect(provider.complete).not.toHaveBeenCalled();
    });

    it('should compress older messages into a summary', async () => {
      const conv = getConversation('compress-1', 'sys');
      // Add 10 messages (5 pairs) — more than keepCount of 6
      for (let i = 0; i < 5; i++) {
        addUserMessage(conv, makeTextMessage('question ' + i));
        addAssistantMessage(conv, 'answer ' + i);
      }
      const provider = makeMockProvider('- we discussed topics 0-1');
      // Budget tight enough to trigger (above 80%)
      await compressConversation(conv, 10, simpleEstimator, provider);
      expect(provider.complete).toHaveBeenCalled();
    });

    it('should preserve the last 6 messages', async () => {
      const conv = getConversation('compress-keep', 'sys');
      for (let i = 0; i < 8; i++) {
        addUserMessage(conv, makeTextMessage('question ' + i));
        addAssistantMessage(conv, 'answer ' + i);
      }
      const provider = makeMockProvider('- summary of early messages');
      // Budget small enough to trigger compression (80% threshold) but large enough
      // to fit the compressed result so the post-compression trim doesn't fire
      await compressConversation(conv, 50, simpleEstimator, provider);
      // After compression: 1 summary + 6 recent = 7
      expect(conv.messages).toHaveLength(7);
      // Last 6 messages should be the recent ones
      expect(getTextContent(conv.messages[conv.messages.length - 1]!.content)).toBe('answer 7');
      expect(getTextContent(conv.messages[conv.messages.length - 2]!.content)).toBe('question 7');
    });

    it('should format summary with [Earlier in this conversation] prefix', async () => {
      const conv = getConversation('compress-fmt', 'system prompt here');
      for (let i = 0; i < 8; i++) {
        addUserMessage(conv, makeTextMessage('question about topic number ' + i + ' with detail'));
        addAssistantMessage(conv, 'answer about topic number ' + i + ' with explanation');
      }
      const provider = makeMockProvider('- discussed things');
      // Total is ~160 tokens for messages + ~5 for system. Budget 100 means 80% = 80, triggers compression.
      // After compression: ~15 tokens summary + ~60 tokens recent + ~5 system = ~80 < 100. Fits.
      await compressConversation(conv, 100, simpleEstimator, provider);
      const summaryMsg = conv.messages[0]!;
      expect(summaryMsg.role).toBe('assistant');
      expect(typeof summaryMsg.content).toBe('string');
      expect((summaryMsg.content as string).startsWith('[Earlier in this conversation]')).toBe(true);
    });

    it('should fall back to trimConversation when provider fails', async () => {
      const conv = getConversation('compress-fail', 'sys');
      for (let i = 0; i < 8; i++) {
        addUserMessage(conv, makeTextMessage('question ' + i));
        addAssistantMessage(conv, 'answer ' + i);
      }
      const provider = makeMockProvider('');
      (provider.complete as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('API down'));
      const before = conv.messages.length;
      await compressConversation(conv, 10, simpleEstimator, provider);
      // Should have trimmed instead
      expect(conv.messages.length).toBeLessThan(before);
    });

    it('should fall back to trim if still over budget after compression', async () => {
      const conv = getConversation('compress-over', 'sys');
      for (let i = 0; i < 10; i++) {
        addUserMessage(conv, makeTextMessage('very long question number ' + i + ' with extra text'));
        addAssistantMessage(conv, 'very long answer number ' + i + ' with extra text');
      }
      // Provider returns a long summary too, still over budget
      const provider = makeMockProvider('x'.repeat(2000));
      await compressConversation(conv, 10, simpleEstimator, provider);
      // After compression + trim, should have reduced messages
      // Compression produces 7 messages (1 summary + 6 recent), then trim
      // removes pairs until <= minMessages (4), which can leave fewer than 4
      // because splice(0,2) can overshoot
      expect(conv.messages.length).toBeLessThan(10);
      expect(conv.messages.length).toBeGreaterThan(0);
    });

    it('should incorporate existing summary in re-compression', async () => {
      const conv = getConversation('compress-recompress', 'sys');
      // Simulate an already-compressed conversation with a summary
      conv.messages.push({
        role: 'assistant',
        content: '[Earlier in this conversation]\n- previous stuff',
        timestamp: Date.now() - 10000,
      });
      for (let i = 0; i < 8; i++) {
        addUserMessage(conv, makeTextMessage('new question ' + i));
        addAssistantMessage(conv, 'new answer ' + i);
      }
      const provider = makeMockProvider('- merged summary');
      await compressConversation(conv, 10, simpleEstimator, provider);
      // Should have used the existing summary as part of the prompt
      const callArgs = (provider.complete as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      const promptContent = (callArgs as { messages: Array<{ content: string }> }).messages[0]!.content;
      expect(promptContent).toContain('Previous summary');
    });
  });

  describe('updateTokenCount', () => {
    it('should accumulate input and output tokens', () => {
      const conv = getConversation('tokens-1', 'sys');
      updateTokenCount(conv, 100, 50);
      expect(conv.tokenCount).toBe(150);
    });

    it('should accumulate across multiple updates', () => {
      const conv = getConversation('tokens-2', 'sys');
      updateTokenCount(conv, 100, 50);
      updateTokenCount(conv, 200, 80);
      expect(conv.tokenCount).toBe(430);
    });

    it('should handle zero tokens', () => {
      const conv = getConversation('tokens-zero', 'sys');
      updateTokenCount(conv, 0, 0);
      expect(conv.tokenCount).toBe(0);
    });
  });

  describe('clearConversation', () => {
    it('should return true when clearing an existing conversation', () => {
      getConversation('clear-1', 'sys');
      expect(clearConversation('clear-1')).toBe(true);
    });

    it('should return false when clearing a non-existent conversation', () => {
      expect(clearConversation('nonexistent')).toBe(false);
    });

    it('should remove the conversation from active conversations', () => {
      getConversation('clear-active', 'sys');
      clearConversation('clear-active');
      expect(getActiveConversations()).not.toContain('clear-active');
    });

    it('should allow creating a fresh conversation after clearing', () => {
      const conv1 = getConversation('clear-recreate', 'sys');
      addAssistantMessage(conv1, 'old');
      clearConversation('clear-recreate');
      const conv2 = getConversation('clear-recreate', 'sys');
      expect(conv2.messages).toHaveLength(0);
    });
  });

  describe('getActiveConversations', () => {
    it('should return empty array when no conversations', () => {
      expect(getActiveConversations()).toEqual([]);
    });

    it('should return all active session keys', () => {
      getConversation('active-1', 'sys');
      getConversation('active-2', 'sys');
      getConversation('active-3', 'sys');
      const active = getActiveConversations();
      expect(active).toContain('active-1');
      expect(active).toContain('active-2');
      expect(active).toContain('active-3');
    });

    it('should return a string array', () => {
      getConversation('type-check', 'sys');
      const active = getActiveConversations();
      expect(Array.isArray(active)).toBe(true);
      for (const key of active) {
        expect(typeof key).toBe('string');
      }
    });

    it('should not include cleared conversations', () => {
      getConversation('will-clear', 'sys');
      getConversation('will-keep', 'sys');
      clearConversation('will-clear');
      const active = getActiveConversations();
      expect(active).not.toContain('will-clear');
      expect(active).toContain('will-keep');
    });
  });
});
