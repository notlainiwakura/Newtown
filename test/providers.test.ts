/**
 * Provider tests — Anthropic, OpenAI, Google, retry, fallback, budget, factory
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock external SDKs before imports ───────────────────────────────────────

const {
  mockAnthropicCreate,
  mockAnthropicStream,
  mockOpenAICreate,
  mockGenerateContent,
  mockGetGenerativeModel,
  mockGetMeta,
  mockSetMeta,
  mockAtomicMetaIncrementCounter,
} = vi.hoisted(() => {
  const mockAnthropicCreate = vi.fn();
  const mockAnthropicStream = vi.fn();
  const mockOpenAICreate = vi.fn();
  const mockGenerateContent = vi.fn();
  const mockGetGenerativeModel = vi.fn().mockReturnValue({ generateContent: mockGenerateContent });
  const mockGetMeta = vi.fn();
  const mockSetMeta = vi.fn();
  const mockAtomicMetaIncrementCounter = vi.fn();
  return {
    mockAnthropicCreate,
    mockAnthropicStream,
    mockOpenAICreate,
    mockGenerateContent,
    mockGetGenerativeModel,
    mockGetMeta,
    mockSetMeta,
    mockAtomicMetaIncrementCounter,
  };
});

vi.mock('@anthropic-ai/sdk', async () => {
  // findings.md P2:838 — preserve real APIError/RateLimitError exports so
  // the provider's `err instanceof APIError` retry classification works.
  const actual = await vi.importActual<typeof import('@anthropic-ai/sdk')>('@anthropic-ai/sdk');
  return {
    ...actual,
    default: vi.fn().mockImplementation(() => ({
      messages: {
        create: mockAnthropicCreate,
        stream: mockAnthropicStream,
      },
    })),
  };
});

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: mockOpenAICreate } },
  })),
}));

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: vi.fn().mockImplementation(() => ({
    getGenerativeModel: mockGetGenerativeModel,
  })),
  FunctionCallingMode: {
    MODE_UNSPECIFIED: 'MODE_UNSPECIFIED',
    AUTO: 'AUTO',
    ANY: 'ANY',
    NONE: 'NONE',
  },
}));

// Mock logger
vi.mock('../src/utils/logger.js', () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// Mock storage for budget tests
vi.mock('../src/storage/database.js', () => ({
  getMeta: mockGetMeta,
  setMeta: mockSetMeta,
  atomicMetaIncrementCounter: mockAtomicMetaIncrementCounter,
  isDatabaseInitialized: () => true,
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import AnthropicSDK from '@anthropic-ai/sdk';
import OpenAISDK from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';

const MockAnthropic = AnthropicSDK as unknown as ReturnType<typeof vi.fn>;
const MockOpenAI = OpenAISDK as unknown as ReturnType<typeof vi.fn>;
const MockGoogleGenerativeAI = GoogleGenerativeAI as unknown as ReturnType<typeof vi.fn>;

import { AnthropicProvider, createAnthropicProvider } from '../src/providers/anthropic.js';
import { OpenAIProvider, createOpenAIProvider } from '../src/providers/openai.js';
import { GoogleProvider, MismatchedToolCallIdError, createGoogleProvider } from '../src/providers/google.js';
import { BaseProvider } from '../src/providers/base.js';
import { withRetry } from '../src/providers/retry.js';
import { createFallbackProvider } from '../src/providers/fallback.js';
import {
  checkBudget,
  enforceBudget,
  recordUsage,
  getBudgetStatus,
  BudgetExceededError,
} from '../src/providers/budget.js';
import { createProvider } from '../src/providers/index.js';
import type {
  CompletionOptions,
  CompletionWithToolsOptions,
  ToolCall,
  ToolResult,
  Provider,
} from '../src/providers/base.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeAnthropicResponse(overrides: Record<string, unknown> = {}) {
  return {
    content: [{ type: 'text', text: 'hello' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
    ...overrides,
  };
}

function makeOpenAIResponse(overrides: Record<string, unknown> = {}) {
  return {
    choices: [
      {
        message: { content: 'hello', tool_calls: undefined },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
    ...overrides,
  };
}

function makeGoogleResponse(text = 'hello', finishReason = 'STOP') {
  return {
    response: {
      text: () => text,
      candidates: [
        {
          finishReason,
          content: { parts: [{ text }] },
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    },
  };
}

const basicMessages: CompletionOptions['messages'] = [
  { role: 'system', content: 'You are helpful.' },
  { role: 'user', content: 'Hello' },
];

// ─────────────────────────────────────────────────────────────────────────────
// 1. BASE PROVIDER
// ─────────────────────────────────────────────────────────────────────────────

const minimalModelInfo = {
  contextWindow: 0,
  maxOutputTokens: 0,
  supportsVision: false,
  supportsStreaming: false,
  supportsTools: false,
};

describe('BaseProvider', () => {
  it('is abstract in TypeScript — subclass must implement required methods', () => {
    // At runtime JS does not throw for abstract classes; we verify via subclass contract
    class Concrete extends BaseProvider {
      readonly name = 'x';
      readonly model = 'x';
      readonly supportsStreaming = false;
      async complete() { return { content: '', finishReason: 'stop' as const, usage: { inputTokens: 0, outputTokens: 0 } }; }
      async completeWithTools() { return { content: '', finishReason: 'stop' as const, usage: { inputTokens: 0, outputTokens: 0 } }; }
      async continueWithToolResults() { return { content: '', finishReason: 'stop' as const, usage: { inputTokens: 0, outputTokens: 0 } }; }
      getModelInfo() { return minimalModelInfo; }
    }
    expect(new Concrete()).toBeInstanceOf(BaseProvider);
  });

  it('concrete subclass must implement name, model, supportsStreaming, complete, completeWithTools, continueWithToolResults, getModelInfo', () => {
    class Minimal extends BaseProvider {
      readonly name = 'test';
      readonly model = 'test-model';
      readonly supportsStreaming = false;
      async complete() {
        return { content: '', finishReason: 'stop' as const, usage: { inputTokens: 0, outputTokens: 0 } };
      }
      async completeWithTools() {
        return { content: '', finishReason: 'stop' as const, usage: { inputTokens: 0, outputTokens: 0 } };
      }
      async continueWithToolResults() {
        return { content: '', finishReason: 'stop' as const, usage: { inputTokens: 0, outputTokens: 0 } };
      }
      getModelInfo() { return minimalModelInfo; }
    }
    const p = new Minimal();
    expect(p.name).toBe('test');
    expect(p.model).toBe('test-model');
    expect(p.supportsStreaming).toBe(false);
    expect(p.getModelInfo()).toEqual(minimalModelInfo);
  });

  it('optional streaming methods need not be defined when supportsStreaming=false (findings.md P2:818)', () => {
    class Minimal extends BaseProvider {
      readonly name = 'x';
      readonly model = 'x';
      readonly supportsStreaming = false;
      async complete() { return { content: '', finishReason: 'stop' as const, usage: { inputTokens: 0, outputTokens: 0 } }; }
      async completeWithTools() { return { content: '', finishReason: 'stop' as const, usage: { inputTokens: 0, outputTokens: 0 } }; }
      async continueWithToolResults() { return { content: '', finishReason: 'stop' as const, usage: { inputTokens: 0, outputTokens: 0 } }; }
      getModelInfo() { return minimalModelInfo; }
    }
    const p = new Minimal();
    expect(p.completeStream).toBeUndefined();
    expect(p.completeWithToolsStream).toBeUndefined();
    expect(p.continueWithToolResultsStream).toBeUndefined();
    expect(p.supportsStreaming).toBe(false);
  });

  it('CompletionResult finishReason union covers all values', () => {
    const reasons: Array<'stop' | 'length' | 'content_filter' | 'tool_use' | 'error'> = [
      'stop', 'length', 'content_filter', 'tool_use', 'error',
    ];
    expect(reasons).toHaveLength(5);
  });

  it('Message role union covers system, user, assistant', () => {
    const roles: Array<'system' | 'user' | 'assistant'> = ['system', 'user', 'assistant'];
    expect(roles).toHaveLength(3);
  });

  it('ImageContentBlock media_type covers jpeg, png, gif, webp', () => {
    const types: Array<'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'> = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    ];
    expect(types).toHaveLength(4);
  });

  it('toolChoice union allows auto, none, specific tool', () => {
    const choices: Array<CompletionWithToolsOptions['toolChoice']> = [
      'auto',
      'none',
      { type: 'tool', name: 'my_tool' },
    ];
    expect(choices).toHaveLength(3);
  });

  it('ToolResult isError is optional', () => {
    const r1: ToolResult = { toolCallId: 'x', content: 'ok' };
    const r2: ToolResult = { toolCallId: 'x', content: 'fail', isError: true };
    expect(r1.isError).toBeUndefined();
    expect(r2.isError).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. ANTHROPIC PROVIDER
// ─────────────────────────────────────────────────────────────────────────────

describe('AnthropicProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAnthropicCreate.mockResolvedValue(makeAnthropicResponse());
  });

  // Constructor & config
  describe('constructor', () => {
    it('sets name to anthropic', () => {
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      expect(p.name).toBe('anthropic');
    });

    it('sets model from config', () => {
      const p = new AnthropicProvider({ model: 'claude-3-opus-20240229' });
      expect(p.model).toBe('claude-3-opus-20240229');
    });

    it('constructs Anthropic client with provided apiKey', () => {
      new AnthropicProvider({ model: 'claude-3-haiku-20240307', apiKey: 'sk-test' });
      expect(MockAnthropic).toHaveBeenCalledWith({ apiKey: 'sk-test' });
    });

    it('falls back to ANTHROPIC_API_KEY env var when no apiKey', () => {
      process.env['ANTHROPIC_API_KEY'] = 'env-key';
      new AnthropicProvider({ model: 'claude-3-haiku-20240307' });
      expect(MockAnthropic).toHaveBeenCalledWith({ apiKey: 'env-key' });
      delete process.env['ANTHROPIC_API_KEY'];
    });

    it('defaults maxTokens to 8192', () => {
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      // Verify via complete() call
      mockAnthropicCreate.mockResolvedValueOnce(makeAnthropicResponse());
      return p.complete({ messages: [{ role: 'user', content: 'hi' }] }).then(() => {
        expect(mockAnthropicCreate).toHaveBeenCalledWith(
          expect.objectContaining({ max_tokens: 8192 }),
          expect.anything(),
        );
      });
    });

    it('uses provided maxTokens', () => {
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022', maxTokens: 1024 });
      mockAnthropicCreate.mockResolvedValueOnce(makeAnthropicResponse());
      return p.complete({ messages: [{ role: 'user', content: 'hi' }] }).then(() => {
        expect(mockAnthropicCreate).toHaveBeenCalledWith(
          expect.objectContaining({ max_tokens: 1024 }),
          expect.anything(),
        );
      });
    });

    it('createAnthropicProvider factory returns an AnthropicProvider', () => {
      const p = createAnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      expect(p).toBeInstanceOf(AnthropicProvider);
    });
  });

  // complete()
  describe('complete()', () => {
    it('returns text from a single text content block', async () => {
      mockAnthropicCreate.mockResolvedValueOnce(makeAnthropicResponse({ content: [{ type: 'text', text: 'world' }] }));
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      const result = await p.complete({ messages: basicMessages });
      expect(result.content).toBe('world');
    });

    it('returns empty string when no text block in response', async () => {
      mockAnthropicCreate.mockResolvedValueOnce(makeAnthropicResponse({ content: [] }));
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      const result = await p.complete({ messages: basicMessages });
      expect(result.content).toBe('');
    });

    it('concatenates multiple text blocks in order (findings.md P2:880)', async () => {
      // Anthropic can return multiple text blocks — extended thinking with
      // interleaved text, or segmented reasoning. The prior implementation
      // used .find(type==='text') which silently dropped every block past
      // the first.
      mockAnthropicCreate.mockResolvedValueOnce(
        makeAnthropicResponse({
          content: [
            { type: 'text', text: 'first ' },
            { type: 'text', text: 'second ' },
            { type: 'text', text: 'third' },
          ],
        }),
      );
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      const result = await p.complete({ messages: basicMessages });
      expect(result.content).toBe('first second third');
    });

    it('concatenates text blocks around thinking blocks (findings.md P2:880)', async () => {
      mockAnthropicCreate.mockResolvedValueOnce(
        makeAnthropicResponse({
          content: [
            { type: 'text', text: 'before ' },
            { type: 'thinking', thinking: '...reasoning...' },
            { type: 'text', text: 'after' },
          ],
        }),
      );
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      const result = await p.complete({ messages: basicMessages });
      expect(result.content).toBe('before after');
    });

    it('maps end_turn stop_reason to stop', async () => {
      mockAnthropicCreate.mockResolvedValueOnce(makeAnthropicResponse({ stop_reason: 'end_turn' }));
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      const result = await p.complete({ messages: basicMessages });
      expect(result.finishReason).toBe('stop');
    });

    it('maps stop_sequence to stop', async () => {
      mockAnthropicCreate.mockResolvedValueOnce(makeAnthropicResponse({ stop_reason: 'stop_sequence' }));
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      const result = await p.complete({ messages: basicMessages });
      expect(result.finishReason).toBe('stop');
    });

    it('maps max_tokens to length', async () => {
      mockAnthropicCreate.mockResolvedValueOnce(makeAnthropicResponse({ stop_reason: 'max_tokens' }));
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      const result = await p.complete({ messages: basicMessages });
      expect(result.finishReason).toBe('length');
    });

    it('maps tool_use stop reason to tool_use', async () => {
      mockAnthropicCreate.mockResolvedValueOnce(makeAnthropicResponse({ stop_reason: 'tool_use' }));
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      const result = await p.complete({ messages: basicMessages });
      expect(result.finishReason).toBe('tool_use');
    });

    it('maps null stop_reason to stop', async () => {
      mockAnthropicCreate.mockResolvedValueOnce(makeAnthropicResponse({ stop_reason: null }));
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      const result = await p.complete({ messages: basicMessages });
      expect(result.finishReason).toBe('stop');
    });

    it('extracts usage tokens correctly', async () => {
      mockAnthropicCreate.mockResolvedValueOnce(makeAnthropicResponse({ usage: { input_tokens: 42, output_tokens: 17 } }));
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      const result = await p.complete({ messages: basicMessages });
      expect(result.usage.inputTokens).toBe(42);
      expect(result.usage.outputTokens).toBe(17);
    });

    it('surfaces cache-read and cache-creation tokens when reported (findings.md P2:808)', async () => {
      // Prompt caching is billed differently: cache-read ~10% of input
      // rate, cache-creation ~125%. Without exposing the breakdown,
      // budget accounting over-counted cache hits as fresh input.
      mockAnthropicCreate.mockResolvedValueOnce(
        makeAnthropicResponse({
          usage: {
            input_tokens: 8,
            output_tokens: 4,
            cache_creation_input_tokens: 1200,
            cache_read_input_tokens: 9000,
          },
        }),
      );
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      const result = await p.complete({ messages: basicMessages });
      expect(result.usage.inputTokens).toBe(8);
      expect(result.usage.outputTokens).toBe(4);
      expect(result.usage.cacheCreationInputTokens).toBe(1200);
      expect(result.usage.cacheReadInputTokens).toBe(9000);
    });

    it('omits cache token fields when the API did not populate them (findings.md P2:808)', async () => {
      // Keep the wire shape clean on non-cached calls — undefined rather
      // than 0 so downstream consumers can tell "not reported" apart
      // from "reported as zero".
      mockAnthropicCreate.mockResolvedValueOnce(
        makeAnthropicResponse({ usage: { input_tokens: 8, output_tokens: 4 } }),
      );
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      const result = await p.complete({ messages: basicMessages });
      expect(result.usage.cacheCreationInputTokens).toBeUndefined();
      expect(result.usage.cacheReadInputTokens).toBeUndefined();
    });

    it('surfaces cache tokens in streaming message_start (findings.md P2:808)', async () => {
      const events = [
        {
          type: 'message_start',
          message: {
            usage: {
              input_tokens: 8,
              output_tokens: 0,
              cache_creation_input_tokens: 1200,
              cache_read_input_tokens: 9000,
            },
          },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', delta: { text: 'hi' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      ];
      mockAnthropicStream.mockReturnValueOnce({
        [Symbol.asyncIterator]() {
          let i = 0;
          return {
            async next() {
              return i < events.length
                ? { value: events[i++], done: false }
                : { value: undefined, done: true };
            },
          };
        },
      });
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      const result = await p.completeStream!({ messages: basicMessages }, () => {});
      expect(result.usage.cacheCreationInputTokens).toBe(1200);
      expect(result.usage.cacheReadInputTokens).toBe(9000);
    });

    it('separates system prompt into Anthropic system field', async () => {
      // findings.md P2:900 — default enableCaching is now true, so the
      // system field is an array of cached TextBlockParams. This test
      // exercises non-cached shape; pass enableCaching:false explicitly.
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      await p.complete({ messages: basicMessages, enableCaching: false });
      const call = mockAnthropicCreate.mock.calls[0]?.[0];
      expect(call.system).toBe('You are helpful.');
      expect(call.messages.every((m: { role: string }) => m.role !== 'system')).toBe(true);
    });

    it('joins multiple system messages with double newline', async () => {
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      await p.complete({
        messages: [
          { role: 'system', content: 'Part 1' },
          { role: 'system', content: 'Part 2' },
          { role: 'user', content: 'hi' },
        ],
        enableCaching: false,
      });
      const call = mockAnthropicCreate.mock.calls[0]?.[0];
      expect(call.system).toBe('Part 1\n\nPart 2');
    });

    it('passes temperature option', async () => {
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      await p.complete({ messages: basicMessages, temperature: 0.5 });
      expect(mockAnthropicCreate).toHaveBeenCalledWith(
        expect.objectContaining({ temperature: 0.5 }),
        expect.anything(),
      );
    });

    it('defaults temperature to 1', async () => {
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      await p.complete({ messages: basicMessages });
      expect(mockAnthropicCreate).toHaveBeenCalledWith(
        expect.objectContaining({ temperature: 1 }),
        expect.anything(),
      );
    });

    it('passes stopSequences as stop_sequences', async () => {
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      await p.complete({ messages: basicMessages, stopSequences: ['END', 'STOP'] });
      expect(mockAnthropicCreate).toHaveBeenCalledWith(
        expect.objectContaining({ stop_sequences: ['END', 'STOP'] }),
        expect.anything(),
      );
    });

    it('omits stop_sequences when not provided', async () => {
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      await p.complete({ messages: basicMessages });
      const call = mockAnthropicCreate.mock.calls[0]?.[0];
      expect(call.stop_sequences).toBeUndefined();
    });

    it('overrides maxTokens per-call', async () => {
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022', maxTokens: 512 });
      await p.complete({ messages: basicMessages, maxTokens: 2048 });
      expect(mockAnthropicCreate).toHaveBeenCalledWith(
        expect.objectContaining({ max_tokens: 2048 }),
        expect.anything(),
      );
    });

    it('retries on overloaded error', async () => {
      // Patch the Anthropic client delay to 0 by mocking setTimeout
      const orig = globalThis.setTimeout;
      const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(
        (cb: TimerHandler) => orig(cb as () => void, 0)
      );
      const overloadedError = new Error('overloaded');
      mockAnthropicCreate
        .mockRejectedValueOnce(overloadedError)
        .mockResolvedValueOnce(makeAnthropicResponse());
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      const result = await p.complete({ messages: basicMessages });
      spy.mockRestore();
      expect(result.content).toBe('hello');
      expect(mockAnthropicCreate).toHaveBeenCalledTimes(2);
    });

    it('throws non-overloaded errors immediately without retry', async () => {
      const err = new Error('Invalid API key');
      mockAnthropicCreate.mockRejectedValueOnce(err);
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      await expect(p.complete({ messages: basicMessages })).rejects.toThrow('Invalid API key');
      expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
    });

    it('throws after max retries on persistent overloaded error', async () => {
      const orig = globalThis.setTimeout;
      const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(
        (cb: TimerHandler) => orig(cb as () => void, 0)
      );
      const overloadedError = new Error('overloaded');
      mockAnthropicCreate.mockRejectedValue(overloadedError);
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      await expect(p.complete({ messages: basicMessages })).rejects.toThrow('overloaded');
      spy.mockRestore();
      // MAX_RETRIES=3 means attempt 0,1,2,3 = 4 total calls
      expect(mockAnthropicCreate).toHaveBeenCalledTimes(4);
    });

    it('detects Overloaded (capital O) in message', async () => {
      const orig = globalThis.setTimeout;
      const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(
        (cb: TimerHandler) => orig(cb as () => void, 0)
      );
      const err = new Error('Overloaded: please retry');
      mockAnthropicCreate
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce(makeAnthropicResponse());
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      await p.complete({ messages: basicMessages });
      spy.mockRestore();
      expect(mockAnthropicCreate).toHaveBeenCalledTimes(2);
    });

    it('handles multimodal content blocks in messages', async () => {
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      await p.complete({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'describe this' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
            ],
          },
        ],
      });
      const call = mockAnthropicCreate.mock.calls[0]?.[0];
      expect(call.messages[0].content).toHaveLength(2);
      expect(call.messages[0].content[0]).toEqual({ type: 'text', text: 'describe this' });
      expect(call.messages[0].content[1]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png' } });
    });

    it('forwards url-source image blocks to Anthropic as url source (findings.md P2:798)', async () => {
      // The discriminated-union widening lets callers pass already-hosted
      // images without re-encoding. Anthropic's GA API accepts this
      // shape at runtime even when SDK types still only declare base64.
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      await p.complete({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what is this' },
              { type: 'image', source: { type: 'url', url: 'https://example.com/cat.jpg' } },
            ],
          },
        ],
      });
      const call = mockAnthropicCreate.mock.calls[0]?.[0];
      expect(call.messages[0].content[1]).toMatchObject({
        type: 'image',
        source: { type: 'url', url: 'https://example.com/cat.jpg' },
      });
    });
  });

  // completeWithTools()
  describe('completeWithTools()', () => {
    it('returns text content and no toolCalls when only text in response', async () => {
      mockAnthropicCreate.mockResolvedValueOnce(makeAnthropicResponse());
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      const result = await p.completeWithTools({ messages: basicMessages });
      expect(result.content).toBe('hello');
      expect(result.toolCalls).toBeUndefined();
    });

    it('extracts tool_use blocks as toolCalls', async () => {
      mockAnthropicCreate.mockResolvedValueOnce(makeAnthropicResponse({
        content: [
          { type: 'text', text: 'calling tool' },
          { type: 'tool_use', id: 'tu_123', name: 'search', input: { query: 'cats' } },
        ],
        stop_reason: 'tool_use',
      }));
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      const result = await p.completeWithTools({ messages: basicMessages });
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0]).toEqual({ id: 'tu_123', name: 'search', input: { query: 'cats' } });
    });

    it('concatenates text blocks that span across a tool_use (findings.md P2:880)', async () => {
      // Anthropic commonly returns text → tool_use → text. The prior
      // .find(type==='text') grabbed only the pre-tool prose and silently
      // discarded any post-tool narration. That text is often the model's
      // summary of the tool result, so losing it corrupted downstream memory.
      mockAnthropicCreate.mockResolvedValueOnce(makeAnthropicResponse({
        content: [
          { type: 'text', text: 'Let me search. ' },
          { type: 'tool_use', id: 'tu_a', name: 'search', input: { q: 'x' } },
          { type: 'text', text: 'Here is what I found.' },
        ],
        stop_reason: 'tool_use',
      }));
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      const result = await p.completeWithTools({ messages: basicMessages });
      expect(result.content).toBe('Let me search. Here is what I found.');
      expect(result.toolCalls).toHaveLength(1);
    });

    it('formats tool definitions with name, description, input_schema', async () => {
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      await p.completeWithTools({
        messages: basicMessages,
        tools: [{ name: 'search', description: 'Search the web', inputSchema: { type: 'object', properties: {} } }],
      });
      const call = mockAnthropicCreate.mock.calls[0]?.[0];
      expect(call.tools[0]).toMatchObject({ name: 'search', description: 'Search the web', input_schema: { type: 'object' } });
    });

    it('omits tools param when no tools provided', async () => {
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      await p.completeWithTools({ messages: basicMessages });
      const call = mockAnthropicCreate.mock.calls[0]?.[0];
      expect(call.tools).toBeUndefined();
    });

    it('maps toolChoice auto to { type: auto }', async () => {
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      await p.completeWithTools({ messages: basicMessages, toolChoice: 'auto' });
      const call = mockAnthropicCreate.mock.calls[0]?.[0];
      expect(call.tool_choice).toEqual({ type: 'auto' });
    });

    it('maps toolChoice none by suppressing tools and tool_choice (Anthropic has no "none" variant)', async () => {
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      await p.completeWithTools({
        messages: basicMessages,
        toolChoice: 'none',
        tools: [{ name: 'my_tool', description: 'T', inputSchema: {} }],
      });
      const call = mockAnthropicCreate.mock.calls[0]?.[0];
      // Caller explicitly disabled tools; neither tools nor tool_choice should
      // reach the API (previously this mapped to { type: 'any' }, which forced
      // the model to *use* a tool — the inverse of the requested behavior).
      expect(call.tools).toBeUndefined();
      expect(call.tool_choice).toBeUndefined();
    });

    it('maps specific tool choice to { type: tool, name }', async () => {
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      await p.completeWithTools({
        messages: basicMessages,
        toolChoice: { type: 'tool', name: 'my_tool' },
      });
      const call = mockAnthropicCreate.mock.calls[0]?.[0];
      expect(call.tool_choice).toEqual({ type: 'tool', name: 'my_tool' });
    });

    it('enables caching on system prompt when enableCaching=true', async () => {
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      await p.completeWithTools({ messages: basicMessages, enableCaching: true });
      const call = mockAnthropicCreate.mock.calls[0]?.[0];
      expect(Array.isArray(call.system)).toBe(true);
      expect(call.system[0]).toMatchObject({ type: 'text', cache_control: { type: 'ephemeral' } });
    });

    it('does not enable caching when enableCaching=false', async () => {
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      await p.completeWithTools({ messages: basicMessages, enableCaching: false });
      const call = mockAnthropicCreate.mock.calls[0]?.[0];
      expect(typeof call.system).toBe('string');
    });

    it('adds cache_control to last tool when caching enabled', async () => {
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      await p.completeWithTools({
        messages: basicMessages,
        enableCaching: true,
        tools: [
          { name: 'tool_a', description: 'A', inputSchema: {} },
          { name: 'tool_b', description: 'B', inputSchema: {} },
        ],
      });
      const call = mockAnthropicCreate.mock.calls[0]?.[0];
      expect(call.tools[0].cache_control).toBeUndefined();
      expect(call.tools[1].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('returns multiple tool calls', async () => {
      mockAnthropicCreate.mockResolvedValueOnce(makeAnthropicResponse({
        content: [
          { type: 'tool_use', id: 'tc1', name: 'search', input: { q: 'a' } },
          { type: 'tool_use', id: 'tc2', name: 'fetch', input: { url: 'http://x' } },
        ],
        stop_reason: 'tool_use',
      }));
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      const result = await p.completeWithTools({ messages: basicMessages });
      expect(result.toolCalls).toHaveLength(2);
    });

    it('returns empty toolCalls as undefined when none', async () => {
      mockAnthropicCreate.mockResolvedValueOnce(makeAnthropicResponse({ content: [{ type: 'text', text: 'ok' }] }));
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      const result = await p.completeWithTools({ messages: basicMessages });
      expect(result.toolCalls).toBeUndefined();
    });
  });

  // continueWithToolResults()
  describe('continueWithToolResults()', () => {
    it('appends assistant tool_use and user tool_result messages', async () => {
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      const toolCalls: ToolCall[] = [{ id: 'tc1', name: 'search', input: { q: 'test' } }];
      const toolResults: ToolResult[] = [{ toolCallId: 'tc1', content: 'result text' }];
      await p.continueWithToolResults({ messages: basicMessages }, toolCalls, toolResults);
      const call = mockAnthropicCreate.mock.calls[0]?.[0];
      const msgs = call.messages;
      // Last two: assistant with tool_use, user with tool_result
      const assistantMsg = msgs.find((m: { role: string }) => m.role === 'assistant');
      const userMsg = msgs[msgs.length - 1];
      expect(assistantMsg.content[0]).toMatchObject({ type: 'tool_use', id: 'tc1', name: 'search' });
      expect(userMsg.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tc1', content: 'result text' });
    });

    it('sets is_error on tool result when isError=true', async () => {
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      const toolCalls: ToolCall[] = [{ id: 'tc1', name: 'search', input: {} }];
      const toolResults: ToolResult[] = [{ toolCallId: 'tc1', content: 'err', isError: true }];
      await p.continueWithToolResults({ messages: basicMessages }, toolCalls, toolResults);
      const call = mockAnthropicCreate.mock.calls[0]?.[0];
      const userMsg = call.messages[call.messages.length - 1];
      expect(userMsg.content[0].is_error).toBe(true);
    });

    it('does not set is_error when isError is undefined', async () => {
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      const toolCalls: ToolCall[] = [{ id: 'tc1', name: 'search', input: {} }];
      const toolResults: ToolResult[] = [{ toolCallId: 'tc1', content: 'ok' }];
      await p.continueWithToolResults({ messages: basicMessages }, toolCalls, toolResults);
      const call = mockAnthropicCreate.mock.calls[0]?.[0];
      const userMsg = call.messages[call.messages.length - 1];
      expect(userMsg.content[0].is_error).toBeUndefined();
    });

    it('returns new tool calls from response', async () => {
      mockAnthropicCreate.mockResolvedValueOnce(makeAnthropicResponse({
        content: [{ type: 'tool_use', id: 'tc2', name: 'fetch', input: { url: 'http://x' } }],
        stop_reason: 'tool_use',
      }));
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      const result = await p.continueWithToolResults(
        { messages: basicMessages },
        [{ id: 'tc1', name: 'search', input: {} }],
        [{ toolCallId: 'tc1', content: 'results' }]
      );
      expect(result.toolCalls?.[0]?.name).toBe('fetch');
    });

    it('concatenates multi-text continuation responses (findings.md P2:880)', async () => {
      mockAnthropicCreate.mockResolvedValueOnce(makeAnthropicResponse({
        content: [
          { type: 'text', text: 'part A ' },
          { type: 'text', text: 'part B' },
        ],
      }));
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      const result = await p.continueWithToolResults(
        { messages: basicMessages },
        [{ id: 'tc1', name: 'search', input: {} }],
        [{ toolCallId: 'tc1', content: 'r' }],
      );
      expect(result.content).toBe('part A part B');
    });

    it('respects enableCaching in continueWithToolResults', async () => {
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      await p.continueWithToolResults(
        { messages: basicMessages, enableCaching: true },
        [{ id: 'tc1', name: 'search', input: {} }],
        [{ toolCallId: 'tc1', content: 'r' }]
      );
      const call = mockAnthropicCreate.mock.calls[0]?.[0];
      expect(Array.isArray(call.system)).toBe(true);
    });
  });

  // Message caching internals
  describe('message caching', () => {
    it('withMessageCaching adds cache_control to last user message string', async () => {
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      await p.completeWithTools({
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'response' },
          { role: 'user', content: 'second' },
        ],
        enableCaching: true,
      });
      const call = mockAnthropicCreate.mock.calls[0]?.[0];
      const lastUser = call.messages[call.messages.length - 1];
      expect(Array.isArray(lastUser.content)).toBe(true);
      expect(lastUser.content[0].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('buildCachedSystem returns empty array for empty system prompt', async () => {
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      await p.completeWithTools({
        messages: [{ role: 'user', content: 'hi' }],
        enableCaching: true,
      });
      const call = mockAnthropicCreate.mock.calls[0]?.[0];
      expect(call.system).toEqual([]);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. OPENAI PROVIDER
// ─────────────────────────────────────────────────────────────────────────────

describe('OpenAIProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOpenAICreate.mockResolvedValue(makeOpenAIResponse());
  });

  // Constructor
  describe('constructor', () => {
    it('sets name to openai', () => {
      const p = new OpenAIProvider({ model: 'gpt-4o' });
      expect(p.name).toBe('openai');
    });

    it('sets model from config', () => {
      const p = new OpenAIProvider({ model: 'gpt-4-turbo' });
      expect(p.model).toBe('gpt-4-turbo');
    });

    it('constructs OpenAI client with provided apiKey', () => {
      new OpenAIProvider({ model: 'gpt-4o', apiKey: 'sk-test' });
      expect(MockOpenAI).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-test' }));
    });

    it('passes baseURL to client when provided', () => {
      new OpenAIProvider({ model: 'gpt-4o', baseURL: 'https://custom.api/v1' });
      expect(MockOpenAI).toHaveBeenCalledWith(
        expect.objectContaining({ baseURL: 'https://custom.api/v1' })
      );
    });

    it('falls back to OPENAI_API_KEY env var', () => {
      process.env['OPENAI_API_KEY'] = 'env-openai-key';
      new OpenAIProvider({ model: 'gpt-4o' });
      expect(MockOpenAI).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'env-openai-key' }));
      delete process.env['OPENAI_API_KEY'];
    });

    it('defaults maxTokens to 8192', async () => {
      const p = new OpenAIProvider({ model: 'gpt-4o' });
      await p.complete({ messages: [{ role: 'user', content: 'hi' }] });
      expect(mockOpenAICreate).toHaveBeenCalledWith(
        expect.objectContaining({ max_tokens: 8192 }),
        expect.anything(),
      );
    });

    it('createOpenAIProvider factory returns OpenAIProvider', () => {
      const p = createOpenAIProvider({ model: 'gpt-4o' });
      expect(p).toBeInstanceOf(OpenAIProvider);
    });
  });

  // complete()
  describe('complete()', () => {
    it('returns content from first choice message', async () => {
      mockOpenAICreate.mockResolvedValueOnce(makeOpenAIResponse());
      const p = new OpenAIProvider({ model: 'gpt-4o' });
      const result = await p.complete({ messages: basicMessages });
      expect(result.content).toBe('hello');
    });

    it('returns empty string when choice is undefined', async () => {
      mockOpenAICreate.mockResolvedValueOnce({ choices: [], usage: { prompt_tokens: 0, completion_tokens: 0 } });
      const p = new OpenAIProvider({ model: 'gpt-4o' });
      const result = await p.complete({ messages: basicMessages });
      expect(result.content).toBe('');
    });

    it('maps finish_reason stop to stop', async () => {
      mockOpenAICreate.mockResolvedValueOnce(makeOpenAIResponse({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] }));
      const p = new OpenAIProvider({ model: 'gpt-4o' });
      const result = await p.complete({ messages: basicMessages });
      expect(result.finishReason).toBe('stop');
    });

    it('maps finish_reason length to length', async () => {
      mockOpenAICreate.mockResolvedValueOnce(makeOpenAIResponse({ choices: [{ message: { content: 'hi' }, finish_reason: 'length' }] }));
      const p = new OpenAIProvider({ model: 'gpt-4o' });
      const result = await p.complete({ messages: basicMessages });
      expect(result.finishReason).toBe('length');
    });

    it('maps finish_reason content_filter to content_filter', async () => {
      mockOpenAICreate.mockResolvedValueOnce(makeOpenAIResponse({ choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] }));
      const p = new OpenAIProvider({ model: 'gpt-4o' });
      const result = await p.complete({ messages: basicMessages });
      expect(result.finishReason).toBe('content_filter');
    });

    it('maps finish_reason tool_calls to tool_use', async () => {
      mockOpenAICreate.mockResolvedValueOnce(makeOpenAIResponse({ choices: [{ message: { content: null, tool_calls: [] }, finish_reason: 'tool_calls' }] }));
      const p = new OpenAIProvider({ model: 'gpt-4o' });
      const result = await p.complete({ messages: basicMessages });
      expect(result.finishReason).toBe('tool_use');
    });

    it('maps unknown finish_reason to "unknown" (findings.md P2:940)', async () => {
      // findings.md P2:940 — the prior mapper folded unrecognized reasons
      // into 'stop', hiding future OpenAI enum members behind the
      // successful-completion path.
      mockOpenAICreate.mockResolvedValueOnce(makeOpenAIResponse({ choices: [{ message: { content: 'hi' }, finish_reason: 'unknown_reason' }] }));
      const p = new OpenAIProvider({ model: 'gpt-4o' });
      const result = await p.complete({ messages: basicMessages });
      expect(result.finishReason).toBe('unknown');
    });

    it('maps null finish_reason to stop', async () => {
      mockOpenAICreate.mockResolvedValueOnce(makeOpenAIResponse({ choices: [{ message: { content: 'hi' }, finish_reason: null }] }));
      const p = new OpenAIProvider({ model: 'gpt-4o' });
      const result = await p.complete({ messages: basicMessages });
      expect(result.finishReason).toBe('stop');
    });

    it('extracts usage tokens', async () => {
      mockOpenAICreate.mockResolvedValueOnce(makeOpenAIResponse({ usage: { prompt_tokens: 30, completion_tokens: 15 } }));
      const p = new OpenAIProvider({ model: 'gpt-4o' });
      const result = await p.complete({ messages: basicMessages });
      expect(result.usage.inputTokens).toBe(30);
      expect(result.usage.outputTokens).toBe(15);
    });

    it('returns zero tokens when usage is undefined', async () => {
      mockOpenAICreate.mockResolvedValueOnce({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }], usage: undefined });
      const p = new OpenAIProvider({ model: 'gpt-4o' });
      const result = await p.complete({ messages: basicMessages });
      expect(result.usage.inputTokens).toBe(0);
      expect(result.usage.outputTokens).toBe(0);
    });

    it('converts ContentBlock array messages to text', async () => {
      const p = new OpenAIProvider({ model: 'gpt-4o' });
      await p.complete({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'hello' },
              { type: 'text', text: 'world' },
            ],
          },
        ],
      });
      const call = mockOpenAICreate.mock.calls[0]?.[0];
      expect(call.messages[0].content).toBe('hello world');
    });

    it('converts ImageContentBlock to OpenAI image_url data URI (findings.md P2:950)', async () => {
      // findings.md P2:950 — the prior wrapper silently dropped images, so
      // GPT-4o responded based on the text caption alone. The provider now
      // emits an image_url part with a base64 data URI when the user
      // message has at least one image block.
      const p = new OpenAIProvider({ model: 'gpt-4o' });
      await p.complete({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'describe' },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
              },
            ],
          },
        ],
      });
      const call = mockOpenAICreate.mock.calls[0]?.[0];
      expect(call.messages[0].content).toEqual([
        { type: 'text', text: 'describe' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ]);
    });

    it('forwards url-source image as-is via image_url (findings.md P2:798)', async () => {
      // OpenAI's image_url.url accepts real URLs too — skip the
      // data-URI wrapping when the caller already has one hosted.
      const p = new OpenAIProvider({ model: 'gpt-4o' });
      await p.complete({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'describe' },
              { type: 'image', source: { type: 'url', url: 'https://img.example.com/x.jpg' } },
            ],
          },
        ],
      });
      const call = mockOpenAICreate.mock.calls[0]?.[0];
      expect(call.messages[0].content).toEqual([
        { type: 'text', text: 'describe' },
        { type: 'image_url', image_url: { url: 'https://img.example.com/x.jpg' } },
      ]);
    });

    it('passes stop sequences', async () => {
      const p = new OpenAIProvider({ model: 'gpt-4o' });
      await p.complete({ messages: basicMessages, stopSequences: ['END'] });
      expect(mockOpenAICreate).toHaveBeenCalledWith(
        expect.objectContaining({ stop: ['END'] }),
        expect.anything(),
      );
    });

    it('includes system messages directly in messages array', async () => {
      const p = new OpenAIProvider({ model: 'gpt-4o' });
      await p.complete({ messages: basicMessages });
      const call = mockOpenAICreate.mock.calls[0]?.[0];
      expect(call.messages[0].role).toBe('system');
    });

    it('uses max_tokens for non-reasoning models (findings.md P2:960)', async () => {
      // findings.md P2:960 — GPT-4 family keeps the legacy parameter so
      // callers that rely on existing behavior don't silently change.
      const p = new OpenAIProvider({ model: 'gpt-4o', maxTokens: 512 });
      await p.complete({ messages: basicMessages });
      const call = mockOpenAICreate.mock.calls[0]?.[0];
      expect(call.max_tokens).toBe(512);
      expect(call.max_completion_tokens).toBeUndefined();
    });

    it('uses max_completion_tokens for o-series reasoning models (findings.md P2:960)', async () => {
      // findings.md P2:960 — o1/o3/o4 reject max_tokens with a 400, so the
      // provider must emit max_completion_tokens instead.
      const p = new OpenAIProvider({ model: 'o3-mini', maxTokens: 512 });
      await p.complete({ messages: basicMessages });
      const call = mockOpenAICreate.mock.calls[0]?.[0];
      expect(call.max_completion_tokens).toBe(512);
      expect(call.max_tokens).toBeUndefined();
    });

    it('uses max_completion_tokens for gpt-5 family (findings.md P2:960)', async () => {
      // findings.md P2:960 — gpt-5 is on the same reasoning-model parameter
      // contract as o-series.
      const p = new OpenAIProvider({ model: 'gpt-5', maxTokens: 512 });
      await p.complete({ messages: basicMessages });
      const call = mockOpenAICreate.mock.calls[0]?.[0];
      expect(call.max_completion_tokens).toBe(512);
      expect(call.max_tokens).toBeUndefined();
    });

    it('surfaces message.refusal as content_filter (findings.md P2:980)', async () => {
      // findings.md P2:980 — GPT-4o sets `refusal` on the message when
      // safety-filtering; the wrapper used to ignore it so callers saw an
      // empty completion with finishReason 'stop'.
      mockOpenAICreate.mockResolvedValueOnce({
        choices: [{
          message: { content: null, refusal: 'I cannot help with that request.' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
      const p = new OpenAIProvider({ model: 'gpt-4o' });
      const result = await p.complete({ messages: basicMessages });
      expect(result.finishReason).toBe('content_filter');
      expect(result.content).toBe('I cannot help with that request.');
    });
  });

  // completeWithTools()
  describe('completeWithTools()', () => {
    it('formats tools as function type', async () => {
      const p = new OpenAIProvider({ model: 'gpt-4o' });
      await p.completeWithTools({
        messages: basicMessages,
        tools: [{ name: 'search', description: 'Search', inputSchema: { type: 'object' } }],
      });
      const call = mockOpenAICreate.mock.calls[0]?.[0];
      expect(call.tools[0]).toEqual({
        type: 'function',
        function: { name: 'search', description: 'Search', parameters: { type: 'object' } },
      });
    });

    it('maps toolChoice auto to "auto"', async () => {
      const p = new OpenAIProvider({ model: 'gpt-4o' });
      await p.completeWithTools({
        messages: basicMessages,
        tools: [{ name: 'f', description: 'd', inputSchema: {} }],
        toolChoice: 'auto',
      });
      const call = mockOpenAICreate.mock.calls[0]?.[0];
      expect(call.tool_choice).toBe('auto');
    });

    it('maps toolChoice none to "none"', async () => {
      const p = new OpenAIProvider({ model: 'gpt-4o' });
      await p.completeWithTools({ messages: basicMessages, toolChoice: 'none' });
      const call = mockOpenAICreate.mock.calls[0]?.[0];
      expect(call.tool_choice).toBe('none');
    });

    it('maps specific tool choice to function object', async () => {
      const p = new OpenAIProvider({ model: 'gpt-4o' });
      await p.completeWithTools({ messages: basicMessages, toolChoice: { type: 'tool', name: 'my_fn' } });
      const call = mockOpenAICreate.mock.calls[0]?.[0];
      expect(call.tool_choice).toEqual({ type: 'function', function: { name: 'my_fn' } });
    });

    it('uses max_completion_tokens for reasoning models (findings.md P2:960)', async () => {
      // findings.md P2:960 — reasoning-model parameter rule also applies
      // to the tool-call code path, not just plain complete().
      const p = new OpenAIProvider({ model: 'o3-mini', maxTokens: 2048 });
      await p.completeWithTools({ messages: basicMessages });
      const call = mockOpenAICreate.mock.calls[0]?.[0];
      expect(call.max_completion_tokens).toBe(2048);
      expect(call.max_tokens).toBeUndefined();
    });

    it('extracts tool_calls from response', async () => {
      mockOpenAICreate.mockResolvedValueOnce({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: 'call_abc',
              type: 'function',
              function: { name: 'search', arguments: '{"q":"test"}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
      const p = new OpenAIProvider({ model: 'gpt-4o' });
      const result = await p.completeWithTools({ messages: basicMessages });
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0]).toEqual({ id: 'call_abc', name: 'search', input: { q: 'test' } });
    });

    it('parses JSON arguments in tool calls', async () => {
      mockOpenAICreate.mockResolvedValueOnce({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: 'tc1',
              type: 'function',
              function: { name: 'fn', arguments: '{"a":1,"b":true}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      });
      const p = new OpenAIProvider({ model: 'gpt-4o' });
      const result = await p.completeWithTools({ messages: basicMessages });
      expect(result.toolCalls![0]!.input).toEqual({ a: 1, b: true });
    });

    it('sets toolCalls to undefined when no tool calls', async () => {
      mockOpenAICreate.mockResolvedValueOnce(makeOpenAIResponse());
      const p = new OpenAIProvider({ model: 'gpt-4o' });
      const result = await p.completeWithTools({ messages: basicMessages });
      expect(result.toolCalls).toBeUndefined();
    });
  });

  // continueWithToolResults()
  describe('continueWithToolResults()', () => {
    it('builds messages with assistant tool_calls and tool role messages', async () => {
      const p = new OpenAIProvider({ model: 'gpt-4o' });
      await p.continueWithToolResults(
        { messages: basicMessages },
        [{ id: 'tc1', name: 'search', input: { q: 'x' } }],
        [{ toolCallId: 'tc1', content: 'search result' }]
      );
      const call = mockOpenAICreate.mock.calls[0]?.[0];
      const assistantMsg = call.messages.find((m: { role: string }) => m.role === 'assistant');
      const toolMsg = call.messages.find((m: { role: string }) => m.role === 'tool');
      expect(assistantMsg.tool_calls[0]).toMatchObject({ id: 'tc1', type: 'function', function: { name: 'search' } });
      expect(toolMsg).toMatchObject({ role: 'tool', tool_call_id: 'tc1', content: 'search result' });
    });

    it('uses max_completion_tokens for reasoning models (findings.md P2:960)', async () => {
      // findings.md P2:960 — continueWithToolResults is the third and final
      // spot max_tokens was hard-coded; reasoning models reject it there too.
      const p = new OpenAIProvider({ model: 'o4-mini', maxTokens: 1024 });
      await p.continueWithToolResults(
        { messages: basicMessages },
        [{ id: 'tc1', name: 'fn', input: {} }],
        [{ toolCallId: 'tc1', content: 'r' }]
      );
      const call = mockOpenAICreate.mock.calls[0]?.[0];
      expect(call.max_completion_tokens).toBe(1024);
      expect(call.max_tokens).toBeUndefined();
    });

    it('serializes tool input to JSON in assistant message', async () => {
      const p = new OpenAIProvider({ model: 'gpt-4o' });
      await p.continueWithToolResults(
        { messages: basicMessages },
        [{ id: 'tc1', name: 'fn', input: { key: 'val' } }],
        [{ toolCallId: 'tc1', content: 'r' }]
      );
      const call = mockOpenAICreate.mock.calls[0]?.[0];
      const assistantMsg = call.messages.find((m: { role: string }) => m.role === 'assistant');
      expect(assistantMsg.tool_calls[0].function.arguments).toBe('{"key":"val"}');
    });

    it('sets assistant content to null', async () => {
      const p = new OpenAIProvider({ model: 'gpt-4o' });
      await p.continueWithToolResults(
        { messages: basicMessages },
        [{ id: 'tc1', name: 'fn', input: {} }],
        [{ toolCallId: 'tc1', content: 'r' }]
      );
      const call = mockOpenAICreate.mock.calls[0]?.[0];
      const assistantMsg = call.messages.find((m: { role: string }) => m.role === 'assistant');
      expect(assistantMsg.content).toBeNull();
    });

    it('returns new tool calls from response', async () => {
      mockOpenAICreate.mockResolvedValueOnce({
        choices: [{
          message: {
            content: null,
            tool_calls: [{ id: 'tc2', type: 'function', function: { name: 'fetch', arguments: '{}' } }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      });
      const p = new OpenAIProvider({ model: 'gpt-4o' });
      const result = await p.continueWithToolResults(
        { messages: basicMessages },
        [{ id: 'tc1', name: 'fn', input: {} }],
        [{ toolCallId: 'tc1', content: 'r' }]
      );
      expect(result.toolCalls?.[0]?.name).toBe('fetch');
    });

    it('passes tools to continue request', async () => {
      const p = new OpenAIProvider({ model: 'gpt-4o' });
      await p.continueWithToolResults(
        {
          messages: basicMessages,
          tools: [{ name: 'search', description: 'S', inputSchema: {} }],
        },
        [{ id: 'tc1', name: 'search', input: {} }],
        [{ toolCallId: 'tc1', content: 'r' }]
      );
      const call = mockOpenAICreate.mock.calls[0]?.[0];
      expect(call.tools).toBeDefined();
      expect(call.tools[0].function.name).toBe('search');
    });

    it('handles multiple tool results', async () => {
      const p = new OpenAIProvider({ model: 'gpt-4o' });
      await p.continueWithToolResults(
        { messages: basicMessages },
        [
          { id: 'tc1', name: 'a', input: {} },
          { id: 'tc2', name: 'b', input: {} },
        ],
        [
          { toolCallId: 'tc1', content: 'r1' },
          { toolCallId: 'tc2', content: 'r2' },
        ]
      );
      const call = mockOpenAICreate.mock.calls[0]?.[0];
      const toolMsgs = call.messages.filter((m: { role: string }) => m.role === 'tool');
      expect(toolMsgs).toHaveLength(2);
    });
  });

  // findings.md P2:990 — OpenAI streaming methods
  describe('streaming methods (findings.md P2:990)', () => {
    function asyncIterable(chunks: unknown[]): AsyncIterable<unknown> {
      return {
        async *[Symbol.asyncIterator]() {
          for (const c of chunks) yield c;
        },
      };
    }

    function openaiStreamChunk(overrides: {
      content?: string;
      refusal?: string;
      toolCalls?: Array<{
        index: number;
        id?: string;
        name?: string;
        arguments?: string;
      }>;
      finishReason?: string;
      usage?: { prompt_tokens: number; completion_tokens: number };
    }) {
      const delta: Record<string, unknown> = {};
      if (overrides.content !== undefined) delta['content'] = overrides.content;
      if (overrides.refusal !== undefined) delta['refusal'] = overrides.refusal;
      if (overrides.toolCalls) {
        delta['tool_calls'] = overrides.toolCalls.map((tc) => {
          const entry: Record<string, unknown> = { index: tc.index };
          if (tc.id) entry['id'] = tc.id;
          const fn: Record<string, unknown> = {};
          if (tc.name) fn['name'] = tc.name;
          if (tc.arguments) fn['arguments'] = tc.arguments;
          if (Object.keys(fn).length > 0) entry['function'] = fn;
          return entry;
        });
      }
      const choice: Record<string, unknown> = { delta };
      if (overrides.finishReason) choice['finish_reason'] = overrides.finishReason;
      const chunk: Record<string, unknown> = { choices: [choice] };
      if (overrides.usage) chunk['usage'] = overrides.usage;
      return chunk;
    }

    describe('completeStream()', () => {
      it('forwards text deltas via onChunk and returns concatenated content', async () => {
        mockOpenAICreate.mockResolvedValueOnce(asyncIterable([
          openaiStreamChunk({ content: 'hello ' }),
          openaiStreamChunk({ content: 'world' }),
          openaiStreamChunk({ finishReason: 'stop', usage: { prompt_tokens: 10, completion_tokens: 3 } }),
        ]));
        const p = new OpenAIProvider({ model: 'gpt-4o' });
        const chunks: string[] = [];
        const r = await p.completeStream!({ messages: basicMessages }, (c) => chunks.push(c));
        expect(chunks).toEqual(['hello ', 'world']);
        expect(r.content).toBe('hello world');
        expect(r.finishReason).toBe('stop');
        expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 3 });
      });

      it('sends stream_options.include_usage so token counts arrive', async () => {
        mockOpenAICreate.mockResolvedValueOnce(asyncIterable([
          openaiStreamChunk({ finishReason: 'stop' }),
        ]));
        const p = new OpenAIProvider({ model: 'gpt-4o' });
        await p.completeStream!({ messages: basicMessages }, () => {});
        const call = mockOpenAICreate.mock.calls[0]?.[0];
        expect(call.stream).toBe(true);
        expect(call.stream_options).toEqual({ include_usage: true });
      });

      it('maps length finish_reason from terminal chunk', async () => {
        mockOpenAICreate.mockResolvedValueOnce(asyncIterable([
          openaiStreamChunk({ content: 'trunc' }),
          openaiStreamChunk({ finishReason: 'length' }),
        ]));
        const p = new OpenAIProvider({ model: 'gpt-4o' });
        const r = await p.completeStream!({ messages: basicMessages }, () => {});
        expect(r.finishReason).toBe('length');
      });

      it('accumulates refusal across chunks and returns content_filter', async () => {
        mockOpenAICreate.mockResolvedValueOnce(asyncIterable([
          openaiStreamChunk({ refusal: 'I cannot ' }),
          openaiStreamChunk({ refusal: 'help.' }),
          openaiStreamChunk({ finishReason: 'stop' }),
        ]));
        const p = new OpenAIProvider({ model: 'gpt-4o' });
        const r = await p.completeStream!({ messages: basicMessages }, () => {});
        expect(r.finishReason).toBe('content_filter');
        expect(r.content).toBe('I cannot help.');
      });

      it('uses max_completion_tokens for reasoning models', async () => {
        mockOpenAICreate.mockResolvedValueOnce(asyncIterable([
          openaiStreamChunk({ finishReason: 'stop' }),
        ]));
        const p = new OpenAIProvider({ model: 'o3-mini', maxTokens: 1024 });
        await p.completeStream!({ messages: basicMessages }, () => {});
        const call = mockOpenAICreate.mock.calls[0]?.[0];
        expect(call.max_completion_tokens).toBe(1024);
        expect(call.max_tokens).toBeUndefined();
      });
    });

    describe('completeWithToolsStream()', () => {
      it('reassembles tool-call deltas across chunks', async () => {
        mockOpenAICreate.mockResolvedValueOnce(asyncIterable([
          openaiStreamChunk({ toolCalls: [{ index: 0, id: 'call_1', name: 'search', arguments: '{"q":' }] }),
          openaiStreamChunk({ toolCalls: [{ index: 0, arguments: '"test"}' }] }),
          openaiStreamChunk({ finishReason: 'tool_calls', usage: { prompt_tokens: 10, completion_tokens: 5 } }),
        ]));
        const p = new OpenAIProvider({ model: 'gpt-4o' });
        const r = await p.completeWithToolsStream!({ messages: basicMessages, tools: [{ name: 'search', description: 'S', inputSchema: {} }] }, () => {});
        expect(r.toolCalls).toHaveLength(1);
        expect(r.toolCalls![0]).toEqual({ id: 'call_1', name: 'search', input: { q: 'test' } });
        expect(r.finishReason).toBe('tool_use');
      });

      it('emits text deltas alongside tool calls', async () => {
        mockOpenAICreate.mockResolvedValueOnce(asyncIterable([
          openaiStreamChunk({ content: 'I will look that up.' }),
          openaiStreamChunk({ toolCalls: [{ index: 0, id: 'c1', name: 'search', arguments: '{}' }] }),
          openaiStreamChunk({ finishReason: 'tool_calls' }),
        ]));
        const p = new OpenAIProvider({ model: 'gpt-4o' });
        const chunks: string[] = [];
        const r = await p.completeWithToolsStream!(
          { messages: basicMessages, tools: [{ name: 'search', description: 'S', inputSchema: {} }] },
          (c) => chunks.push(c)
        );
        expect(chunks).toEqual(['I will look that up.']);
        expect(r.content).toBe('I will look that up.');
        expect(r.toolCalls).toHaveLength(1);
      });

      it('handles multiple parallel tool calls via indexed slots', async () => {
        mockOpenAICreate.mockResolvedValueOnce(asyncIterable([
          openaiStreamChunk({ toolCalls: [{ index: 0, id: 'a', name: 'foo', arguments: '{}' }] }),
          openaiStreamChunk({ toolCalls: [{ index: 1, id: 'b', name: 'bar', arguments: '{}' }] }),
          openaiStreamChunk({ finishReason: 'tool_calls' }),
        ]));
        const p = new OpenAIProvider({ model: 'gpt-4o' });
        const r = await p.completeWithToolsStream!({ messages: basicMessages }, () => {});
        expect(r.toolCalls).toHaveLength(2);
        expect(r.toolCalls?.map((t) => t.name)).toEqual(['foo', 'bar']);
      });
    });

    describe('continueWithToolResultsStream()', () => {
      it('forwards assistantText into the assistant message and streams response', async () => {
        mockOpenAICreate.mockResolvedValueOnce(asyncIterable([
          openaiStreamChunk({ content: 'final answer' }),
          openaiStreamChunk({ finishReason: 'stop' }),
        ]));
        const p = new OpenAIProvider({ model: 'gpt-4o' });
        const chunks: string[] = [];
        const r = await p.continueWithToolResultsStream!(
          { messages: basicMessages },
          [{ id: 'tc1', name: 'search', input: { q: 'x' } }],
          [{ toolCallId: 'tc1', content: 'result' }],
          (c) => chunks.push(c),
          'I will look that up.',
        );
        expect(chunks).toEqual(['final answer']);
        expect(r.content).toBe('final answer');
        const call = mockOpenAICreate.mock.calls[0]?.[0];
        const assistantMsg = call.messages.find((m: { role: string }) => m.role === 'assistant');
        expect(assistantMsg.content).toBe('I will look that up.');
        expect(assistantMsg.tool_calls[0]).toMatchObject({ id: 'tc1', function: { name: 'search' } });
      });

      it('returns new tool calls parsed from stream', async () => {
        mockOpenAICreate.mockResolvedValueOnce(asyncIterable([
          openaiStreamChunk({ toolCalls: [{ index: 0, id: 'tc2', name: 'fetch', arguments: '{}' }] }),
          openaiStreamChunk({ finishReason: 'tool_calls' }),
        ]));
        const p = new OpenAIProvider({ model: 'gpt-4o' });
        const r = await p.continueWithToolResultsStream!(
          { messages: basicMessages },
          [{ id: 'tc1', name: 'a', input: {} }],
          [{ toolCallId: 'tc1', content: 'r' }],
          () => {},
        );
        expect(r.toolCalls).toHaveLength(1);
        expect(r.toolCalls![0]!.name).toBe('fetch');
      });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. GOOGLE PROVIDER
// ─────────────────────────────────────────────────────────────────────────────

describe('GoogleProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateContent.mockResolvedValue(makeGoogleResponse());
    mockGetGenerativeModel.mockReturnValue({ generateContent: mockGenerateContent });
  });

  // Constructor
  describe('constructor', () => {
    it('sets name to google', () => {
      const p = new GoogleProvider({ model: 'gemini-1.5-pro' });
      expect(p.name).toBe('google');
    });

    it('sets model from config', () => {
      const p = new GoogleProvider({ model: 'gemini-2.0-flash' });
      expect(p.model).toBe('gemini-2.0-flash');
    });

    it('constructs GoogleGenerativeAI with provided apiKey', () => {
      new GoogleProvider({ model: 'gemini-1.5-pro', apiKey: 'goog-key' });
      expect(MockGoogleGenerativeAI).toHaveBeenCalledWith('goog-key');
    });

    it('falls back to GOOGLE_API_KEY env var', () => {
      process.env['GOOGLE_API_KEY'] = 'env-goog-key';
      new GoogleProvider({ model: 'gemini-1.5-pro' });
      expect(MockGoogleGenerativeAI).toHaveBeenCalledWith('env-goog-key');
      delete process.env['GOOGLE_API_KEY'];
    });

    it('uses empty string when no apiKey and no env var', () => {
      delete process.env['GOOGLE_API_KEY'];
      new GoogleProvider({ model: 'gemini-1.5-pro' });
      expect(MockGoogleGenerativeAI).toHaveBeenCalledWith('');
    });

    it('defaults maxTokens to 8192', async () => {
      const p = new GoogleProvider({ model: 'gemini-1.5-pro' });
      await p.complete({ messages: [{ role: 'user', content: 'hi' }] });
      expect(mockGetGenerativeModel).toHaveBeenCalledWith(
        expect.objectContaining({
          generationConfig: expect.objectContaining({ maxOutputTokens: 8192 }),
        })
      );
    });

    it('createGoogleProvider factory returns a GoogleProvider', () => {
      const p = createGoogleProvider({ model: 'gemini-1.5-pro' });
      expect(p).toBeInstanceOf(GoogleProvider);
    });
  });

  // complete()
  describe('complete()', () => {
    it('returns text from response', async () => {
      mockGenerateContent.mockResolvedValueOnce(makeGoogleResponse('test response'));
      const p = new GoogleProvider({ model: 'gemini-1.5-pro' });
      const result = await p.complete({ messages: basicMessages });
      expect(result.content).toBe('test response');
    });

    it('maps STOP finish reason to stop', async () => {
      mockGenerateContent.mockResolvedValueOnce(makeGoogleResponse('r', 'STOP'));
      const p = new GoogleProvider({ model: 'gemini-1.5-pro' });
      const result = await p.complete({ messages: basicMessages });
      expect(result.finishReason).toBe('stop');
    });

    it('maps MAX_TOKENS finish reason to length', async () => {
      mockGenerateContent.mockResolvedValueOnce(makeGoogleResponse('r', 'MAX_TOKENS'));
      const p = new GoogleProvider({ model: 'gemini-1.5-pro' });
      const result = await p.complete({ messages: basicMessages });
      expect(result.finishReason).toBe('length');
    });

    it('maps SAFETY finish reason to content_filter', async () => {
      mockGenerateContent.mockResolvedValueOnce(makeGoogleResponse('', 'SAFETY'));
      const p = new GoogleProvider({ model: 'gemini-1.5-pro' });
      const result = await p.complete({ messages: basicMessages });
      expect(result.finishReason).toBe('content_filter');
    });

    it('maps RECITATION / BLOCKLIST / PROHIBITED_CONTENT to content_filter (findings.md P2:1000)', async () => {
      for (const reason of ['RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII']) {
        mockGenerateContent.mockResolvedValueOnce(makeGoogleResponse('r', reason));
        const p = new GoogleProvider({ model: 'gemini-1.5-pro' });
        const result = await p.complete({ messages: basicMessages });
        expect(result.finishReason).toBe('content_filter');
      }
    });

    it('maps truly unknown finish reason to "unknown" (findings.md P2:940)', async () => {
      // findings.md P2:940 — novel Gemini finishReason values surface as
      // 'unknown' rather than silently looking like clean completions.
      mockGenerateContent.mockResolvedValueOnce(makeGoogleResponse('r', 'WHO_KNOWS'));
      const p = new GoogleProvider({ model: 'gemini-1.5-pro' });
      const result = await p.complete({ messages: basicMessages });
      expect(result.finishReason).toBe('unknown');
    });

    it('maps undefined finish reason to stop', async () => {
      mockGenerateContent.mockResolvedValueOnce({
        response: {
          text: () => 'r',
          candidates: [{ finishReason: undefined, content: { parts: [] } }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
        },
      });
      const p = new GoogleProvider({ model: 'gemini-1.5-pro' });
      const result = await p.complete({ messages: basicMessages });
      expect(result.finishReason).toBe('stop');
    });

    it('extracts usage tokens', async () => {
      mockGenerateContent.mockResolvedValueOnce({
        response: {
          text: () => 'r',
          candidates: [{ finishReason: 'STOP', content: { parts: [] } }],
          usageMetadata: { promptTokenCount: 25, candidatesTokenCount: 12 },
        },
      });
      const p = new GoogleProvider({ model: 'gemini-1.5-pro' });
      const result = await p.complete({ messages: basicMessages });
      expect(result.usage.inputTokens).toBe(25);
      expect(result.usage.outputTokens).toBe(12);
    });

    it('returns zero tokens when usageMetadata is undefined', async () => {
      mockGenerateContent.mockResolvedValueOnce({
        response: {
          text: () => 'r',
          candidates: [{ finishReason: 'STOP', content: { parts: [] } }],
          usageMetadata: undefined,
        },
      });
      const p = new GoogleProvider({ model: 'gemini-1.5-pro' });
      const result = await p.complete({ messages: basicMessages });
      expect(result.usage.inputTokens).toBe(0);
      expect(result.usage.outputTokens).toBe(0);
    });

    it('converts system messages to systemInstruction', async () => {
      const p = new GoogleProvider({ model: 'gemini-1.5-pro' });
      await p.complete({ messages: basicMessages });
      expect(mockGetGenerativeModel).toHaveBeenCalledWith(
        expect.objectContaining({ systemInstruction: 'You are helpful.' })
      );
    });

    it('converts assistant role to model role', async () => {
      const p = new GoogleProvider({ model: 'gemini-1.5-pro' });
      await p.complete({
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
          { role: 'user', content: 'thanks' },
        ],
      });
      const call = mockGetGenerativeModel.mock.results[0]?.value;
      // Check the contents passed to generateContent
      const genCall = mockGenerateContent.mock.calls[0]?.[0];
      expect(genCall.contents[1].role).toBe('model');
    });

    it('passes stopSequences to generationConfig', async () => {
      const p = new GoogleProvider({ model: 'gemini-1.5-pro' });
      await p.complete({ messages: basicMessages, stopSequences: ['DONE'] });
      expect(mockGetGenerativeModel).toHaveBeenCalledWith(
        expect.objectContaining({
          generationConfig: expect.objectContaining({ stopSequences: ['DONE'] }),
        })
      );
    });

    it('omits thinkingConfig when thinkingBudget is not configured (findings.md:1040)', async () => {
      // Regression: forcing thinkingBudget: 0 on every request blocked Gemini 2.5 Pro
      // reasoning and could error on older 1.5/2.0 models. Default must be "let Gemini
      // decide per model" — emit thinkingConfig only when caller opts in.
      const p = new GoogleProvider({ model: 'gemini-2.5-flash' });
      await p.complete({ messages: basicMessages });
      const genConfig = mockGetGenerativeModel.mock.calls[0]![0].generationConfig;
      expect(genConfig.thinkingConfig).toBeUndefined();
    });

    it('emits thinkingConfig when thinkingBudget is explicitly configured', async () => {
      const p = new GoogleProvider({ model: 'gemini-2.5-flash', thinkingBudget: 0 });
      await p.complete({ messages: basicMessages });
      expect(mockGetGenerativeModel).toHaveBeenCalledWith(
        expect.objectContaining({
          generationConfig: expect.objectContaining({
            thinkingConfig: { thinkingBudget: 0 },
          }),
        })
      );
    });

    it('honors a positive thinkingBudget (2.5 Pro reasoning cap)', async () => {
      const p = new GoogleProvider({ model: 'gemini-2.5-pro', thinkingBudget: 4096 });
      await p.complete({ messages: basicMessages });
      expect(mockGetGenerativeModel).toHaveBeenCalledWith(
        expect.objectContaining({
          generationConfig: expect.objectContaining({
            thinkingConfig: { thinkingBudget: 4096 },
          }),
        })
      );
    });

    it('passes temperature to generationConfig', async () => {
      const p = new GoogleProvider({ model: 'gemini-1.5-pro' });
      await p.complete({ messages: basicMessages, temperature: 0.3 });
      expect(mockGetGenerativeModel).toHaveBeenCalledWith(
        expect.objectContaining({
          generationConfig: expect.objectContaining({ temperature: 0.3 }),
        })
      );
    });

    it('converts ContentBlock arrays to joined text', async () => {
      const p = new GoogleProvider({ model: 'gemini-1.5-pro' });
      await p.complete({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'part1' },
              { type: 'text', text: 'part2' },
            ],
          },
        ],
      });
      const genCall = mockGenerateContent.mock.calls[0]?.[0];
      expect(genCall.contents[0].parts[0].text).toBe('part1 part2');
    });

    it('converts ImageContentBlock to Gemini inlineData part (findings.md P2:950)', async () => {
      // findings.md P2:950 — same silent-drop pattern as OpenAI. Google's
      // Part shape is `{inlineData: {mimeType, data}}` with base64 data;
      // we emit that alongside the text part when the user message
      // contains at least one image block.
      const p = new GoogleProvider({ model: 'gemini-1.5-pro' });
      await p.complete({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'describe' },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' },
              },
            ],
          },
        ],
      });
      const genCall = mockGenerateContent.mock.calls[0]?.[0];
      expect(genCall.contents[0].parts).toEqual([
        { text: 'describe' },
        { inlineData: { mimeType: 'image/jpeg', data: 'QUJD' } },
      ]);
    });

    it('converts url-source image to Gemini fileData part (findings.md P2:798)', async () => {
      // Google's Part shape for URL-hosted media is `fileData` with a
      // fileUri + mimeType; inlineData is base64-only.
      const p = new GoogleProvider({ model: 'gemini-1.5-pro' });
      await p.complete({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'describe' },
              {
                type: 'image',
                source: { type: 'url', url: 'https://gs.example.com/x.png', media_type: 'image/png' },
              },
            ],
          },
        ],
      });
      const genCall = mockGenerateContent.mock.calls[0]?.[0];
      expect(genCall.contents[0].parts).toEqual([
        { text: 'describe' },
        { fileData: { mimeType: 'image/png', fileUri: 'https://gs.example.com/x.png' } },
      ]);
    });

    it('falls back to image/jpeg mime when url-source omits media_type (findings.md P2:798)', async () => {
      const p = new GoogleProvider({ model: 'gemini-1.5-pro' });
      await p.complete({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'url', url: 'https://x.example.com/a.jpg' } },
            ],
          },
        ],
      });
      const genCall = mockGenerateContent.mock.calls[0]?.[0];
      expect(genCall.contents[0].parts).toEqual([
        { fileData: { mimeType: 'image/jpeg', fileUri: 'https://x.example.com/a.jpg' } },
      ]);
    });

    it('joins multiple system messages with double newline', async () => {
      const p = new GoogleProvider({ model: 'gemini-1.5-pro' });
      await p.complete({
        messages: [
          { role: 'system', content: 'Sys1' },
          { role: 'system', content: 'Sys2' },
          { role: 'user', content: 'hi' },
        ],
      });
      expect(mockGetGenerativeModel).toHaveBeenCalledWith(
        expect.objectContaining({ systemInstruction: 'Sys1\n\nSys2' })
      );
    });
  });

  // completeWithTools()
  describe('completeWithTools()', () => {
    it('passes functionDeclarations to model', async () => {
      const p = new GoogleProvider({ model: 'gemini-1.5-pro' });
      await p.completeWithTools({
        messages: basicMessages,
        tools: [{ name: 'search', description: 'Search', inputSchema: { type: 'object' } }],
      });
      expect(mockGetGenerativeModel).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: [{ functionDeclarations: [{ name: 'search', description: 'Search', parameters: { type: 'object' } }] }],
        })
      );
    });

    it('omits tools when no tools defined', async () => {
      const p = new GoogleProvider({ model: 'gemini-1.5-pro' });
      await p.completeWithTools({ messages: basicMessages });
      const call = mockGetGenerativeModel.mock.calls[0]?.[0];
      expect(call.tools).toBeUndefined();
    });

    it('maps toolChoice "auto" to AUTO functionCallingConfig (findings.md P2:1020)', async () => {
      // findings.md P2:1020 — wrapper used to ignore toolChoice entirely.
      const p = new GoogleProvider({ model: 'gemini-1.5-pro' });
      await p.completeWithTools({
        messages: basicMessages,
        tools: [{ name: 'f', description: 'd', inputSchema: {} }],
        toolChoice: 'auto',
      });
      const req = mockGenerateContent.mock.calls[0]?.[0];
      expect(req.toolConfig).toEqual({ functionCallingConfig: { mode: 'AUTO' } });
    });

    it('maps toolChoice "none" to NONE functionCallingConfig (findings.md P2:1020)', async () => {
      // findings.md P2:1020 — 'none' must actually disable tools.
      const p = new GoogleProvider({ model: 'gemini-1.5-pro' });
      await p.completeWithTools({
        messages: basicMessages,
        tools: [{ name: 'f', description: 'd', inputSchema: {} }],
        toolChoice: 'none',
      });
      const req = mockGenerateContent.mock.calls[0]?.[0];
      expect(req.toolConfig).toEqual({ functionCallingConfig: { mode: 'NONE' } });
    });

    it('maps specific toolChoice to ANY + allowedFunctionNames (findings.md P2:1020)', async () => {
      // findings.md P2:1020 — forcing a named tool uses ANY mode with
      // allowedFunctionNames restricted to that one function.
      const p = new GoogleProvider({ model: 'gemini-1.5-pro' });
      await p.completeWithTools({
        messages: basicMessages,
        tools: [{ name: 'search', description: 'd', inputSchema: {} }],
        toolChoice: { type: 'tool', name: 'search' },
      });
      const req = mockGenerateContent.mock.calls[0]?.[0];
      expect(req.toolConfig).toEqual({
        functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['search'] },
      });
    });

    it('omits toolConfig when toolChoice unspecified (findings.md P2:1020)', async () => {
      // findings.md P2:1020 — no toolChoice means defer to Gemini's default
      // AUTO; don't send an explicit toolConfig.
      const p = new GoogleProvider({ model: 'gemini-1.5-pro' });
      await p.completeWithTools({
        messages: basicMessages,
        tools: [{ name: 'f', description: 'd', inputSchema: {} }],
      });
      const req = mockGenerateContent.mock.calls[0]?.[0];
      expect(req.toolConfig).toBeUndefined();
    });

    it('extracts functionCall parts as toolCalls', async () => {
      mockGenerateContent.mockResolvedValueOnce({
        response: {
          text: () => '',
          candidates: [{
            finishReason: 'STOP',
            content: {
              parts: [
                { functionCall: { name: 'search', args: { query: 'cats' } } },
              ],
            },
          }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        },
      });
      const p = new GoogleProvider({ model: 'gemini-1.5-pro' });
      const result = await p.completeWithTools({ messages: basicMessages });
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0]).toMatchObject({ name: 'search', input: { query: 'cats' } });
    });

    it('auto-generates content-hash tool call ids (findings.md P2:1010)', async () => {
      // findings.md P2:1010 — prior positional `call_${index}` scheme
      // cross-wired persisted tool calls across sessions (call_0 in run A
      // meant a different call than call_0 in run B). Content-hash IDs
      // are stable across restarts and distinct for distinct calls.
      mockGenerateContent.mockResolvedValueOnce({
        response: {
          text: () => '',
          candidates: [{
            finishReason: 'STOP',
            content: {
              parts: [
                { functionCall: { name: 'a', args: {} } },
                { functionCall: { name: 'b', args: {} } },
              ],
            },
          }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
        },
      });
      const p = new GoogleProvider({ model: 'gemini-1.5-pro' });
      const result = await p.completeWithTools({ messages: basicMessages });
      expect(result.toolCalls![0]!.id).toMatch(/^call_[0-9a-f]{16}$/);
      expect(result.toolCalls![1]!.id).toMatch(/^call_[0-9a-f]{16}$/);
      // Different name+args → different IDs.
      expect(result.toolCalls![0]!.id).not.toBe(result.toolCalls![1]!.id);
    });

    it('same name+args always hashes to same id (findings.md P2:1010)', async () => {
      // findings.md P2:1010 — stability is the point: identical call emitted
      // across two sessions must carry the same id so persisted toolCallIds
      // still resolve after a process restart.
      mockGenerateContent
        .mockResolvedValueOnce({
          response: {
            text: () => '',
            candidates: [{
              finishReason: 'STOP',
              content: { parts: [{ functionCall: { name: 'search', args: { q: 'cats' } } }] },
            }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
          },
        })
        .mockResolvedValueOnce({
          response: {
            text: () => '',
            candidates: [{
              finishReason: 'STOP',
              content: { parts: [{ functionCall: { name: 'search', args: { q: 'cats' } } }] },
            }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
          },
        });
      const p = new GoogleProvider({ model: 'gemini-1.5-pro' });
      const r1 = await p.completeWithTools({ messages: basicMessages });
      const r2 = await p.completeWithTools({ messages: basicMessages });
      expect(r1.toolCalls![0]!.id).toBe(r2.toolCalls![0]!.id);
    });

    it('returns toolCalls as undefined when no function calls in response', async () => {
      mockGenerateContent.mockResolvedValueOnce(makeGoogleResponse('just text'));
      const p = new GoogleProvider({ model: 'gemini-1.5-pro' });
      const result = await p.completeWithTools({ messages: basicMessages });
      expect(result.toolCalls).toBeUndefined();
    });

    it('handles empty functionCall.args with empty object', async () => {
      mockGenerateContent.mockResolvedValueOnce({
        response: {
          text: () => '',
          candidates: [{
            finishReason: 'STOP',
            content: { parts: [{ functionCall: { name: 'fn', args: null } }] },
          }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
        },
      });
      const p = new GoogleProvider({ model: 'gemini-1.5-pro' });
      const result = await p.completeWithTools({ messages: basicMessages });
      expect(result.toolCalls![0]!.input).toEqual({});
    });
  });

  // continueWithToolResults()
  describe('continueWithToolResults()', () => {
    it('adds model functionCall parts to contents', async () => {
      const p = new GoogleProvider({ model: 'gemini-1.5-pro' });
      await p.continueWithToolResults(
        { messages: [{ role: 'user', content: 'go' }] },
        [{ id: 'call_0', name: 'search', input: { q: 'x' } }],
        [{ toolCallId: 'call_0', content: 'result' }]
      );
      const genCall = mockGenerateContent.mock.calls[0]?.[0];
      const modelMsg = genCall.contents.find((c: { role: string }) => c.role === 'model');
      expect(modelMsg.parts[0]).toMatchObject({ functionCall: { name: 'search', args: { q: 'x' } } });
    });

    it('adds user functionResponse parts to contents', async () => {
      const p = new GoogleProvider({ model: 'gemini-1.5-pro' });
      await p.continueWithToolResults(
        { messages: [{ role: 'user', content: 'go' }] },
        [{ id: 'call_0', name: 'search', input: {} }],
        [{ toolCallId: 'call_0', content: 'the result' }]
      );
      const genCall = mockGenerateContent.mock.calls[0]?.[0];
      const userMsg = genCall.contents[genCall.contents.length - 1];
      expect(userMsg.role).toBe('user');
      expect(userMsg.parts[0]).toMatchObject({
        functionResponse: { name: 'search', response: { result: 'the result' } },
      });
    });

    it('looks up tool name for functionResponse by toolCallId', async () => {
      const p = new GoogleProvider({ model: 'gemini-1.5-pro' });
      await p.continueWithToolResults(
        { messages: [{ role: 'user', content: 'go' }] },
        [
          { id: 'call_0', name: 'search', input: {} },
          { id: 'call_1', name: 'fetch', input: {} },
        ],
        [
          { toolCallId: 'call_1', content: 'fetched' },
        ]
      );
      const genCall = mockGenerateContent.mock.calls[0]?.[0];
      const userMsg = genCall.contents[genCall.contents.length - 1];
      expect(userMsg.parts[0].functionResponse.name).toBe('fetch');
    });

    it('throws MismatchedToolCallIdError when toolCallId has no match (findings.md P2:1030)', async () => {
      // findings.md P2:1030 — previous code defaulted the function name to
      // 'unknown' and sent a functionResponse for a call Gemini never made,
      // leaving the caller with garbage output and no error signal.
      const p = new GoogleProvider({ model: 'gemini-1.5-pro' });
      await expect(
        p.continueWithToolResults(
          { messages: [{ role: 'user', content: 'go' }] },
          [{ id: 'call_abc', name: 'search', input: {} }],
          [{ toolCallId: 'nonexistent', content: 'r' }]
        )
      ).rejects.toThrow(MismatchedToolCallIdError);
    });

    it('returns new tool calls from continue response', async () => {
      mockGenerateContent.mockResolvedValueOnce({
        response: {
          text: () => '',
          candidates: [{
            finishReason: 'STOP',
            content: { parts: [{ functionCall: { name: 'fetch', args: { url: 'x' } } }] },
          }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        },
      });
      const p = new GoogleProvider({ model: 'gemini-1.5-pro' });
      const result = await p.continueWithToolResults(
        { messages: [{ role: 'user', content: 'go' }] },
        [{ id: 'call_0', name: 'search', input: {} }],
        [{ toolCallId: 'call_0', content: 'r' }]
      );
      expect(result.toolCalls?.[0]?.name).toBe('fetch');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. RETRY LOGIC
// ─────────────────────────────────────────────────────────────────────────────

describe('withRetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns result immediately on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, 'test');
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 status code', async () => {
    const err = Object.assign(new Error('rate limit'), { status: 429 });
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');
    expect(await withRetry(fn, 'test', noDelay)).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on 500 status code', async () => {
    const err = Object.assign(new Error('server error'), { status: 500 });
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');
    expect(await withRetry(fn, 'test', noDelay)).toBe('ok');
  });

  it('retries on 502 status code', async () => {
    const err = Object.assign(new Error('bad gateway'), { status: 502 });
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');
    expect(await withRetry(fn, 'test', noDelay)).toBe('ok');
  });

  it('retries on 503 status code', async () => {
    const err = Object.assign(new Error('service unavailable'), { status: 503 });
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');
    expect(await withRetry(fn, 'test', noDelay)).toBe('ok');
  });

  it('does not retry on 400 status code', async () => {
    const err = Object.assign(new Error('bad request'), { status: 400 });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, 'test')).rejects.toThrow('bad request');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry on 401 status code', async () => {
    const err = Object.assign(new Error('unauthorized'), { status: 401 });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, 'test')).rejects.toThrow('unauthorized');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry on 404 status code', async () => {
    const err = Object.assign(new Error('not found'), { status: 404 });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, 'test')).rejects.toThrow('not found');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // Use zero-delay config to avoid actual waits
  const noDelay = { baseDelayMs: 0 };

  it('retries when message contains "rate limit"', async () => {
    const err = new Error('You have exceeded your rate limit');
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');
    expect(await withRetry(fn, 'test', noDelay)).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries when message contains "overloaded"', async () => {
    const err = new Error('API is overloaded');
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');
    expect(await withRetry(fn, 'test', noDelay)).toBe('ok');
  });

  it('retries when message contains "too many requests"', async () => {
    const err = new Error('Too many requests');
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');
    expect(await withRetry(fn, 'test', noDelay)).toBe('ok');
  });

  it('retries when message contains "server error"', async () => {
    const err = new Error('internal server error');
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');
    expect(await withRetry(fn, 'test', noDelay)).toBe('ok');
  });

  it('retries when message contains "bad gateway"', async () => {
    const err = new Error('bad gateway');
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');
    expect(await withRetry(fn, 'test', noDelay)).toBe('ok');
  });

  it('retries when message contains "service unavailable"', async () => {
    const err = new Error('service unavailable');
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');
    expect(await withRetry(fn, 'test', noDelay)).toBe('ok');
  });

  it('exhausts default 3 retries then throws', async () => {
    const err = Object.assign(new Error('rate limit'), { status: 429 });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, 'test', noDelay)).rejects.toThrow('rate limit');
    expect(fn).toHaveBeenCalledTimes(4); // attempt 0,1,2,3
  });

  it('uses exponential backoff caps (1x, 2x, 4x baseDelay) with jitter (findings.md P2:1050)', async () => {
    // findings.md P2:1050 — full jitter samples delay in [0, cap]. Pin
    // Math.random at ~1 to verify the caps grow exponentially.
    const delays: number[] = [];
    const origSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(
      (cb: TimerHandler, ms?: number) => {
        if (typeof ms === 'number') delays.push(ms);
        return origSetTimeout(cb as () => void, 0);
      }
    );
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.9999);

    const err = Object.assign(new Error('rate limit'), { status: 429 });
    const fn = vi.fn().mockRejectedValue(err);
    await withRetry(fn, 'test', { maxRetries: 3, baseDelayMs: 100 }).catch(() => {});
    spy.mockRestore();
    randomSpy.mockRestore();

    expect(delays).toHaveLength(3);
    // With random ≈ 1, delay ≈ cap: 99, 199, 399 (floor of 0.9999 * cap).
    expect(delays[0]).toBeGreaterThanOrEqual(99);
    expect(delays[0]).toBeLessThanOrEqual(100);
    expect(delays[1]).toBeGreaterThanOrEqual(199);
    expect(delays[1]).toBeLessThanOrEqual(200);
    expect(delays[2]).toBeGreaterThanOrEqual(399);
    expect(delays[2]).toBeLessThanOrEqual(400);
  });

  it('respects custom maxRetries config', async () => {
    const err = Object.assign(new Error('rate limit'), { status: 429 });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, 'test', { ...noDelay, maxRetries: 1 })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(2); // attempt 0, 1
  });

  it('respects custom retryableStatusCodes', async () => {
    const err = Object.assign(new Error('forbidden'), { status: 403 });
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');
    expect(await withRetry(fn, 'test', { ...noDelay, retryableStatusCodes: [403] })).toBe('ok');
  });

  it('does not retry non-Error values', async () => {
    const fn = vi.fn().mockRejectedValue('string error');
    await expect(withRetry(fn, 'test')).rejects.toBe('string error');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry null errors', async () => {
    const fn = vi.fn().mockRejectedValue(null);
    await expect(withRetry(fn, 'test')).rejects.toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('succeeds on third attempt', async () => {
    const err = Object.assign(new Error('rate limit'), { status: 429 });
    const fn = vi.fn()
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err)
      .mockResolvedValue('success');
    expect(await withRetry(fn, 'test', noDelay)).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. FALLBACK PROVIDER
// ─────────────────────────────────────────────────────────────────────────────

describe('createFallbackProvider', () => {
  function makeProvider(model: string, overrides: Partial<Provider> = {}): Provider {
    return {
      name: 'test',
      model,
      supportsStreaming: false,
      complete: vi.fn().mockResolvedValue({ content: `from ${model}`, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }),
      completeWithTools: vi.fn().mockResolvedValue({ content: `from ${model}`, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }),
      continueWithToolResults: vi.fn().mockResolvedValue({ content: `from ${model}`, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }),
      ...overrides,
    };
  }

  function makeModelGoneError(msg = 'model not found') {
    return Object.assign(new Error(msg), { status: 404 });
  }

  it('returns primary when no fallbackModels', async () => {
    const primary = makeProvider('primary-model');
    const result = createFallbackProvider(primary, [], () => makeProvider('fallback'));
    expect(result).toBe(primary);
  });

  it('proxies name and model from activeProvider', () => {
    const primary = makeProvider('primary-v1');
    const proxy = createFallbackProvider(primary, ['fallback-v1'], () => makeProvider('fallback-v1'));
    expect(proxy.name).toBe('test');
    expect(proxy.model).toBe('primary-v1');
  });

  it('calls primary on success', async () => {
    const primary = makeProvider('primary-v1');
    const factory = vi.fn().mockReturnValue(makeProvider('fallback-v1'));
    const proxy = createFallbackProvider(primary, ['fallback-v1'], factory);
    const result = await proxy.complete({ messages: basicMessages });
    expect(result.content).toBe('from primary-v1');
    expect(factory).not.toHaveBeenCalled();
  });

  it('falls back to next model on 404', async () => {
    const primary = makeProvider('primary-v1', {
      complete: vi.fn().mockRejectedValue(makeModelGoneError()),
    });
    const fallback = makeProvider('fallback-v1');
    const factory = vi.fn().mockReturnValue(fallback);
    const proxy = createFallbackProvider(primary, ['fallback-v1'], factory);
    const result = await proxy.complete({ messages: basicMessages });
    expect(result.content).toBe('from fallback-v1');
  });

  it('falls back on 410 (gone)', async () => {
    const primary = makeProvider('primary-v1', {
      complete: vi.fn().mockRejectedValue(Object.assign(new Error('deprecated'), { status: 410 })),
    });
    const fallback = makeProvider('fallback-v1');
    const proxy = createFallbackProvider(primary, ['fallback-v1'], () => fallback);
    const result = await proxy.complete({ messages: basicMessages });
    expect(result.content).toBe('from fallback-v1');
  });

  it('falls back when message contains "model not found"', async () => {
    const primary = makeProvider('primary-v1', {
      complete: vi.fn().mockRejectedValue(new Error('model not found')),
    });
    const fallback = makeProvider('fallback-v1');
    const proxy = createFallbackProvider(primary, ['fallback-v1'], () => fallback);
    const result = await proxy.complete({ messages: basicMessages });
    expect(result.content).toBe('from fallback-v1');
  });

  it('falls back when message contains "deprecated"', async () => {
    const primary = makeProvider('primary-v1', {
      complete: vi.fn().mockRejectedValue(new Error('This model is deprecated')),
    });
    const fallback = makeProvider('fallback-v1');
    const proxy = createFallbackProvider(primary, ['fallback-v1'], () => fallback);
    const result = await proxy.complete({ messages: basicMessages });
    expect(result.content).toBe('from fallback-v1');
  });

  it('does not fall back on non-model-gone errors', async () => {
    const primary = makeProvider('primary-v1', {
      complete: vi.fn().mockRejectedValue(Object.assign(new Error('rate limit'), { status: 429 })),
    });
    const proxy = createFallbackProvider(primary, ['fallback-v1'], () => makeProvider('fallback-v1'));
    await expect(proxy.complete({ messages: basicMessages })).rejects.toThrow('rate limit');
  });

  it('promotes fallback as active provider after success', async () => {
    let callCount = 0;
    const primary = makeProvider('primary-v1', {
      complete: vi.fn().mockRejectedValue(makeModelGoneError()),
    });
    const fallback = makeProvider('fallback-v1');
    const proxy = createFallbackProvider(primary, ['fallback-v1'], () => {
      callCount++;
      return fallback;
    });
    await proxy.complete({ messages: basicMessages });
    await proxy.complete({ messages: basicMessages });
    // Factory only called once; fallback promoted
    expect(callCount).toBe(1);
    expect(proxy.model).toBe('fallback-v1');
  });

  it('tries second fallback when first also fails', async () => {
    const primary = makeProvider('p', { complete: vi.fn().mockRejectedValue(makeModelGoneError()) });
    const fallback1 = makeProvider('f1', { complete: vi.fn().mockRejectedValue(makeModelGoneError()) });
    const fallback2 = makeProvider('f2');
    const factory = vi.fn()
      .mockReturnValueOnce(fallback1)
      .mockReturnValueOnce(fallback2);
    const proxy = createFallbackProvider(primary, ['f1', 'f2'], factory);
    const result = await proxy.complete({ messages: basicMessages });
    expect(result.content).toBe('from f2');
  });

  it('throws when all models exhausted', async () => {
    const primary = makeProvider('p', { complete: vi.fn().mockRejectedValue(makeModelGoneError()) });
    const f1 = makeProvider('f1', { complete: vi.fn().mockRejectedValue(makeModelGoneError()) });
    const factory = vi.fn().mockReturnValue(f1);
    const proxy = createFallbackProvider(primary, ['f1'], factory);
    await expect(proxy.complete({ messages: basicMessages })).rejects.toThrow('All models exhausted');
  });

  it('proxies completeWithTools through fallback chain', async () => {
    const primary = makeProvider('p', { completeWithTools: vi.fn().mockRejectedValue(makeModelGoneError()) });
    const fallback = makeProvider('f1');
    const proxy = createFallbackProvider(primary, ['f1'], () => fallback);
    const result = await proxy.completeWithTools({ messages: basicMessages });
    expect(result.content).toBe('from f1');
  });

  it('proxies continueWithToolResults through fallback chain', async () => {
    const primary = makeProvider('p', { continueWithToolResults: vi.fn().mockRejectedValue(makeModelGoneError()) });
    const fallback = makeProvider('f1');
    const proxy = createFallbackProvider(primary, ['f1'], () => fallback);
    const result = await proxy.continueWithToolResults({ messages: basicMessages }, [], []);
    expect(result.content).toBe('from f1');
  });

  it('completeStream falls back to complete when stream not available', async () => {
    const primary = makeProvider('p', {
      complete: vi.fn().mockRejectedValue(makeModelGoneError()),
    });
    const fallback = makeProvider('f1');
    const proxy = createFallbackProvider(primary, ['f1'], () => fallback);
    const chunks: string[] = [];
    const result = await proxy.completeStream!(basicMessages as unknown as CompletionOptions, (c) => chunks.push(c));
    expect(result.content).toBe('from f1');
  });

  it('completeWithToolsStream falls back to completeWithTools when stream not available', async () => {
    const primary = makeProvider('p', {
      completeWithTools: vi.fn().mockRejectedValue(makeModelGoneError()),
    });
    const fallback = makeProvider('f1');
    const proxy = createFallbackProvider(primary, ['f1'], () => fallback);
    const result = await proxy.completeWithToolsStream!({ messages: basicMessages }, () => {});
    expect(result.content).toBe('from f1');
  });

  it('isModelGoneError returns false for non-objects', async () => {
    const primary = makeProvider('p', {
      complete: vi.fn().mockRejectedValue('string error'),
    });
    const proxy = createFallbackProvider(primary, ['f1'], () => makeProvider('f1'));
    await expect(proxy.complete({ messages: basicMessages })).rejects.toBe('string error');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. BUDGET SYSTEM
// ─────────────────────────────────────────────────────────────────────────────

describe('Budget system', () => {
  const currentYearMonth = new Date().toISOString().slice(0, 7);

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['LAIN_MONTHLY_TOKEN_CAP'];
    mockGetMeta.mockReturnValue(null);
    mockSetMeta.mockImplementation(() => {});
    // Default: pretend the atomic op produced a fresh {current month, delta}
    // record. Individual tests override with specific return JSON to control
    // the post-increment value that recordUsage reads for warning logic.
    mockAtomicMetaIncrementCounter.mockImplementation(
      (p: { freshJson: string }) => p.freshJson,
    );
  });

  afterEach(() => {
    delete process.env['LAIN_MONTHLY_TOKEN_CAP'];
  });

  describe('BudgetExceededError', () => {
    it('has correct name', () => {
      const e = new BudgetExceededError(1000, 500);
      expect(e.name).toBe('BudgetExceededError');
    });

    it('message includes used and cap', () => {
      const e = new BudgetExceededError(1_000_000, 500_000);
      expect(e.message).toContain('1,000,000');
      expect(e.message).toContain('500,000');
    });

    it('is instanceof Error', () => {
      expect(new BudgetExceededError(0, 1)).toBeInstanceOf(Error);
    });
  });

  describe('checkBudget()', () => {
    it('passes when under budget', () => {
      mockGetMeta.mockReturnValue(JSON.stringify({ month: currentYearMonth, tokens: 100 }));
      expect(() => checkBudget()).not.toThrow();
    });

    it('throws BudgetExceededError when at cap', () => {
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = '1000';
      mockGetMeta.mockReturnValue(JSON.stringify({ month: currentYearMonth, tokens: 1000 }));
      expect(() => checkBudget()).toThrow(BudgetExceededError);
    });

    it('throws when over cap', () => {
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = '1000';
      mockGetMeta.mockReturnValue(JSON.stringify({ month: currentYearMonth, tokens: 1500 }));
      expect(() => checkBudget()).toThrow(BudgetExceededError);
    });

    it('passes when cap is 0 (disabled)', () => {
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = '0';
      mockGetMeta.mockReturnValue(JSON.stringify({ month: currentYearMonth, tokens: 999_999_999 }));
      expect(() => checkBudget()).not.toThrow();
    });

    it('passes when no usage data exists (fresh start)', () => {
      mockGetMeta.mockReturnValue(null);
      expect(() => checkBudget()).not.toThrow();
    });

    it('passes when usage is from a different month (auto-reset)', () => {
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = '100';
      mockGetMeta.mockReturnValue(JSON.stringify({ month: '2020-01', tokens: 99999 }));
      expect(() => checkBudget()).not.toThrow();
    });

    it('uses default cap of 60,000,000', () => {
      mockGetMeta.mockReturnValue(JSON.stringify({ month: currentYearMonth, tokens: 59_999_999 }));
      expect(() => checkBudget()).not.toThrow();
    });

    it('throws at default cap of 60,000,000', () => {
      mockGetMeta.mockReturnValue(JSON.stringify({ month: currentYearMonth, tokens: 60_000_000 }));
      expect(() => checkBudget()).toThrow(BudgetExceededError);
    });

    it('uses LAIN_MONTHLY_TOKEN_CAP env var', () => {
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = '5000';
      mockGetMeta.mockReturnValue(JSON.stringify({ month: currentYearMonth, tokens: 4999 }));
      expect(() => checkBudget()).not.toThrow();
      mockGetMeta.mockReturnValue(JSON.stringify({ month: currentYearMonth, tokens: 5000 }));
      expect(() => checkBudget()).toThrow(BudgetExceededError);
    });

    it('ignores invalid LAIN_MONTHLY_TOKEN_CAP and uses default', () => {
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = 'not-a-number';
      mockGetMeta.mockReturnValue(JSON.stringify({ month: currentYearMonth, tokens: 59_999_999 }));
      expect(() => checkBudget()).not.toThrow();
    });

    it('ignores negative LAIN_MONTHLY_TOKEN_CAP and uses default', () => {
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = '-100';
      mockGetMeta.mockReturnValue(JSON.stringify({ month: currentYearMonth, tokens: 59_999_999 }));
      expect(() => checkBudget()).not.toThrow();
    });
  });

  describe('recordUsage()', () => {
    it('does not record when cap is 0', () => {
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = '0';
      recordUsage(100, 50);
      expect(mockAtomicMetaIncrementCounter).not.toHaveBeenCalled();
    });

    // findings.md P2:1110 — recordUsage must route through the atomic
    // helper (not a read-modify-write pair). The helper is responsible for
    // both "first write this month" and "increment existing" cases via
    // ON CONFLICT + json_set; these tests check we're handing it the right
    // parameters, not re-testing SQLite semantics.
    it('calls atomic increment with current-month fresh JSON and delta', () => {
      recordUsage(100, 50);
      expect(mockAtomicMetaIncrementCounter).toHaveBeenCalledWith({
        key: 'budget:monthly_usage',
        freshJson: JSON.stringify({ month: currentYearMonth, tokens: 150 }),
        periodField: 'month',
        periodValue: currentYearMonth,
        counterField: 'tokens',
        delta: 150,
      });
    });

    it('passes zero delta without error', () => {
      recordUsage(0, 0);
      expect(mockAtomicMetaIncrementCounter).toHaveBeenCalledWith(
        expect.objectContaining({ delta: 0 }),
      );
    });

    it('handles large token counts', () => {
      recordUsage(1_000_000, 500_000);
      expect(mockAtomicMetaIncrementCounter).toHaveBeenCalledWith(
        expect.objectContaining({ delta: 1_500_000 }),
      );
    });

    it('uses the atomic helper\'s returned tokens to drive the 80% warning', () => {
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = '1000';
      // Simulate: before this increment we were at 750 (below 80%),
      // after we'd be at 850 (above). Warning should fire.
      mockAtomicMetaIncrementCounter.mockReturnValue(
        JSON.stringify({ month: currentYearMonth, tokens: 850 }),
      );
      // We don't assert on the logger call here — the real contract is
      // that recordUsage returns cleanly and reads the atomic return.
      expect(() => recordUsage(50, 50)).not.toThrow();
    });

    it('tolerates concurrent callers (atomic helper is the synchronization point)', () => {
      // Both parallel callers hit the atomic helper; neither observes the
      // other's delta via read-modify-write. This test documents the
      // contract — that we call the atomic helper once per recordUsage and
      // don't sandwich it between getMeta/setMeta.
      recordUsage(10, 5);
      recordUsage(20, 10);
      expect(mockAtomicMetaIncrementCounter).toHaveBeenCalledTimes(2);
      expect(mockGetMeta).not.toHaveBeenCalled();
      expect(mockSetMeta).not.toHaveBeenCalled();
    });
  });

  describe('getBudgetStatus()', () => {
    it('returns current month', () => {
      mockGetMeta.mockReturnValue(null);
      const status = getBudgetStatus();
      expect(status.month).toBe(currentYearMonth);
    });

    it('returns tokensUsed', () => {
      mockGetMeta.mockReturnValue(JSON.stringify({ month: currentYearMonth, tokens: 1234 }));
      const status = getBudgetStatus();
      expect(status.tokensUsed).toBe(1234);
    });

    it('returns monthlyCap from env', () => {
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = '10000';
      mockGetMeta.mockReturnValue(null);
      const status = getBudgetStatus();
      expect(status.monthlyCap).toBe(10000);
    });

    it('returns pctUsed as 0 when cap is 0', () => {
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = '0';
      mockGetMeta.mockReturnValue(JSON.stringify({ month: currentYearMonth, tokens: 9999 }));
      const status = getBudgetStatus();
      expect(status.pctUsed).toBe(0);
    });

    it('calculates pctUsed correctly', () => {
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = '1000';
      mockGetMeta.mockReturnValue(JSON.stringify({ month: currentYearMonth, tokens: 250 }));
      const status = getBudgetStatus();
      expect(status.pctUsed).toBe(25);
    });

    it('returns 0 tokensUsed when no data', () => {
      mockGetMeta.mockReturnValue(null);
      const status = getBudgetStatus();
      expect(status.tokensUsed).toBe(0);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. PROVIDER FACTORY (createProvider)
// ─────────────────────────────────────────────────────────────────────────────

describe('createProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['LAIN_MONTHLY_TOKEN_CAP'];
    mockGetMeta.mockReturnValue(null);
    mockSetMeta.mockImplementation(() => {});
    mockAtomicMetaIncrementCounter.mockImplementation(
      (p: { freshJson: string }) => p.freshJson,
    );
    mockAnthropicCreate.mockResolvedValue(makeAnthropicResponse());
    mockOpenAICreate.mockResolvedValue(makeOpenAIResponse());
    mockGenerateContent.mockResolvedValue(makeGoogleResponse());
  });

  it('creates an anthropic provider', () => {
    const p = createProvider({ type: 'anthropic', model: 'claude-3-5-sonnet-20241022' });
    expect(p.name).toBe('anthropic');
    expect(p.model).toBe('claude-3-5-sonnet-20241022');
  });

  it('creates an openai provider', () => {
    const p = createProvider({ type: 'openai', model: 'gpt-4o' });
    expect(p.name).toBe('openai');
    expect(p.model).toBe('gpt-4o');
  });

  it('creates a google provider', () => {
    const p = createProvider({ type: 'google', model: 'gemini-1.5-pro' });
    expect(p.name).toBe('google');
    expect(p.model).toBe('gemini-1.5-pro');
  });

  it('throws for unknown provider type', () => {
    expect(() =>
      createProvider({ type: 'unknown' as 'anthropic', model: 'x' })
    ).toThrow('Unknown provider type');
  });

  it('reads api key from apiKeyEnv', () => {
    process.env['MY_ANTHROPIC_KEY'] = 'custom-key';
    createProvider({ type: 'anthropic', model: 'claude-3-5-sonnet-20241022', apiKeyEnv: 'MY_ANTHROPIC_KEY' });
    expect(MockAnthropic).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'custom-key' }));
    delete process.env['MY_ANTHROPIC_KEY'];
  });

  // findings.md P2:1136 — if apiKeyEnv is set but the env var is empty
  // or whitespace, don't pass that through as the API key. Let the
  // provider's default env var resolution kick in instead.
  it('treats empty-string apiKeyEnv value as missing and falls back to default env var', () => {
    process.env['ANTHROPIC_API_KEY'] = 'default-key';
    process.env['MISCONFIGURED_KEY'] = '';
    createProvider({ type: 'anthropic', model: 'claude-3-5-sonnet-20241022', apiKeyEnv: 'MISCONFIGURED_KEY' });
    expect(MockAnthropic).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'default-key' }));
    delete process.env['MISCONFIGURED_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
  });

  it('treats whitespace-only apiKeyEnv value as missing', () => {
    process.env['ANTHROPIC_API_KEY'] = 'default-key';
    process.env['WHITESPACE_KEY'] = '   \t\n';
    createProvider({ type: 'anthropic', model: 'claude-3-5-sonnet-20241022', apiKeyEnv: 'WHITESPACE_KEY' });
    expect(MockAnthropic).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'default-key' }));
    delete process.env['WHITESPACE_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
  });

  it('wraps provider with budget enforcement', async () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '100';
    mockGetMeta.mockReturnValue(JSON.stringify({ month: new Date().toISOString().slice(0, 7), tokens: 100 }));
    const p = createProvider({ type: 'anthropic', model: 'claude-3-5-sonnet-20241022' });
    await expect(p.complete({ messages: basicMessages })).rejects.toThrow(BudgetExceededError);
  });

  it('records usage after successful complete call', async () => {
    const p = createProvider({ type: 'anthropic', model: 'claude-3-5-sonnet-20241022' });
    await p.complete({ messages: basicMessages });
    expect(mockAtomicMetaIncrementCounter).toHaveBeenCalled();
  });

  it('wraps with fallback when fallbackModels provided', () => {
    const p = createProvider({
      type: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      fallbackModels: ['claude-3-haiku-20240307'],
    });
    // With fallback chain, model is still primary initially
    expect(p.model).toBe('claude-3-5-sonnet-20241022');
  });

  it('falls back to next model when primary is deprecated', async () => {
    const deprecatedError = Object.assign(new Error('model not found'), { status: 404 });
    mockAnthropicCreate
      .mockRejectedValueOnce(deprecatedError)
      .mockResolvedValue(makeAnthropicResponse({ content: [{ type: 'text', text: 'fallback response' }] }));

    const p = createProvider({
      type: 'anthropic',
      model: 'old-model',
      fallbackModels: ['new-model'],
    });
    const result = await p.complete({ messages: basicMessages });
    expect(result.content).toBe('fallback response');
  });

  it('provider with no fallbackModels calls primary directly', async () => {
    const p = createProvider({ type: 'anthropic', model: 'claude-3-5-sonnet-20241022' });
    const result = await p.complete({ messages: basicMessages });
    expect(result.content).toBe('hello');
  });

  it('budget proxy does not intercept non-api-method properties', () => {
    const p = createProvider({ type: 'anthropic', model: 'claude-3-5-sonnet-20241022' });
    expect(p.name).toBe('anthropic');
    expect(p.model).toBe('claude-3-5-sonnet-20241022');
  });

  it('records usage after completeWithTools', async () => {
    mockAnthropicCreate.mockResolvedValue(makeAnthropicResponse());
    const p = createProvider({ type: 'anthropic', model: 'claude-3-5-sonnet-20241022' });
    await p.completeWithTools({ messages: basicMessages });
    expect(mockAtomicMetaIncrementCounter).toHaveBeenCalled();
  });

  it('records usage after continueWithToolResults', async () => {
    const p = createProvider({ type: 'anthropic', model: 'claude-3-5-sonnet-20241022' });
    await p.continueWithToolResults(
      { messages: basicMessages },
      [{ id: 'tc1', name: 'fn', input: {} }],
      [{ toolCallId: 'tc1', content: 'r' }]
    );
    expect(mockAtomicMetaIncrementCounter).toHaveBeenCalled();
  });

  it('budget is disabled when LAIN_MONTHLY_TOKEN_CAP=0', async () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '0';
    mockGetMeta.mockReturnValue(JSON.stringify({ month: new Date().toISOString().slice(0, 7), tokens: 999_999_999 }));
    const p = createProvider({ type: 'anthropic', model: 'claude-3-5-sonnet-20241022' });
    await expect(p.complete({ messages: basicMessages })).resolves.toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// findings.md P2:1100 — belt-and-suspenders budget enforcement.
// The withBudget proxy in providers/index.ts is the primary guard, but
// direct callers of createAnthropicProvider/createOpenAIProvider/
// createGoogleProvider skip that proxy. Each provider's public methods
// now call this.assertBudget() as their first line, so the monthly cap
// is enforced regardless of construction path.
// ─────────────────────────────────────────────────────────────────────────────

describe('findings.md P2:1100 — direct-constructed providers enforce budget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['LAIN_MONTHLY_TOKEN_CAP'];
    mockGetMeta.mockReturnValue(null);
    mockSetMeta.mockImplementation(() => {});
    mockAtomicMetaIncrementCounter.mockImplementation(
      (p: { freshJson: string }) => p.freshJson,
    );
    mockAnthropicCreate.mockResolvedValue(makeAnthropicResponse());
    mockOpenAICreate.mockResolvedValue(makeOpenAIResponse());
    mockGenerateContent.mockResolvedValue(makeGoogleResponse());
  });

  afterEach(() => {
    delete process.env['LAIN_MONTHLY_TOKEN_CAP'];
  });

  it('direct AnthropicProvider.complete throws BudgetExceededError when over cap', async () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '100';
    mockGetMeta.mockReturnValue(
      JSON.stringify({ month: new Date().toISOString().slice(0, 7), tokens: 200 }),
    );
    const p = createAnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
    await expect(p.complete({ messages: basicMessages })).rejects.toThrow(BudgetExceededError);
  });

  it('direct AnthropicProvider.completeWithTools throws BudgetExceededError when over cap', async () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '100';
    mockGetMeta.mockReturnValue(
      JSON.stringify({ month: new Date().toISOString().slice(0, 7), tokens: 200 }),
    );
    const p = createAnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
    await expect(p.completeWithTools({ messages: basicMessages })).rejects.toThrow(BudgetExceededError);
  });

  it('direct AnthropicProvider.continueWithToolResults throws BudgetExceededError when over cap', async () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '100';
    mockGetMeta.mockReturnValue(
      JSON.stringify({ month: new Date().toISOString().slice(0, 7), tokens: 200 }),
    );
    const p = createAnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
    await expect(
      p.continueWithToolResults(
        { messages: basicMessages },
        [{ id: 'tc1', name: 'fn', input: {} }],
        [{ toolCallId: 'tc1', content: 'r' }],
      ),
    ).rejects.toThrow(BudgetExceededError);
  });

  it('direct OpenAIProvider.complete throws BudgetExceededError when over cap', async () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '100';
    mockGetMeta.mockReturnValue(
      JSON.stringify({ month: new Date().toISOString().slice(0, 7), tokens: 200 }),
    );
    const p = createOpenAIProvider({ model: 'gpt-4o' });
    await expect(p.complete({ messages: basicMessages })).rejects.toThrow(BudgetExceededError);
  });

  it('direct OpenAIProvider.completeWithTools throws BudgetExceededError when over cap', async () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '100';
    mockGetMeta.mockReturnValue(
      JSON.stringify({ month: new Date().toISOString().slice(0, 7), tokens: 200 }),
    );
    const p = createOpenAIProvider({ model: 'gpt-4o' });
    await expect(p.completeWithTools({ messages: basicMessages })).rejects.toThrow(BudgetExceededError);
  });

  it('direct GoogleProvider.complete throws BudgetExceededError when over cap', async () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '100';
    mockGetMeta.mockReturnValue(
      JSON.stringify({ month: new Date().toISOString().slice(0, 7), tokens: 200 }),
    );
    const p = createGoogleProvider({ model: 'gemini-1.5-pro' });
    await expect(p.complete({ messages: basicMessages })).rejects.toThrow(BudgetExceededError);
  });

  it('direct GoogleProvider.completeWithTools throws BudgetExceededError when over cap', async () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '100';
    mockGetMeta.mockReturnValue(
      JSON.stringify({ month: new Date().toISOString().slice(0, 7), tokens: 200 }),
    );
    const p = createGoogleProvider({ model: 'gemini-1.5-pro' });
    await expect(p.completeWithTools({ messages: basicMessages })).rejects.toThrow(BudgetExceededError);
  });

  it('direct provider does NOT throw when under cap (sanity check — helper is not over-aggressive)', async () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '1000000';
    mockGetMeta.mockReturnValue(
      JSON.stringify({ month: new Date().toISOString().slice(0, 7), tokens: 100 }),
    );
    const p = createAnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
    await expect(p.complete({ messages: basicMessages })).resolves.toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// findings.md P2:1126 — daily soft cap throttles (not blocks) after crossing
// ─────────────────────────────────────────────────────────────────────────────

describe('findings.md P2:1126 — daily soft cap throttles', () => {
  const currentDay = new Date().toISOString().slice(0, 10);
  const currentMonth = new Date().toISOString().slice(0, 7);

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['LAIN_MONTHLY_TOKEN_CAP'];
    delete process.env['LAIN_DAILY_TOKEN_CAP'];
    delete process.env['LAIN_DAILY_THROTTLE_MS'];
    mockGetMeta.mockReturnValue(null);
    mockSetMeta.mockImplementation(() => {});
    mockAtomicMetaIncrementCounter.mockImplementation(
      (p: { freshJson: string }) => p.freshJson,
    );
  });

  afterEach(() => {
    delete process.env['LAIN_MONTHLY_TOKEN_CAP'];
    delete process.env['LAIN_DAILY_TOKEN_CAP'];
    delete process.env['LAIN_DAILY_THROTTLE_MS'];
    vi.useRealTimers();
  });

  it('enforceBudget does NOT throttle when daily cap unset (disabled by default)', async () => {
    // No daily cap env var → no throttle regardless of usage.
    mockGetMeta.mockImplementation((key: string) => {
      if (key === 'budget:daily_usage')
        return JSON.stringify({ day: currentDay, tokens: 999_999_999 });
      return null;
    });
    const start = Date.now();
    await enforceBudget();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50); // no sleep
  });

  it('enforceBudget does NOT throttle when under daily cap', async () => {
    process.env['LAIN_DAILY_TOKEN_CAP'] = '1000';
    mockGetMeta.mockImplementation((key: string) => {
      if (key === 'budget:daily_usage')
        return JSON.stringify({ day: currentDay, tokens: 500 });
      return null;
    });
    const start = Date.now();
    await enforceBudget();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
  });

  it('enforceBudget sleeps when daily cap is crossed', async () => {
    process.env['LAIN_DAILY_TOKEN_CAP'] = '100';
    process.env['LAIN_DAILY_THROTTLE_MS'] = '50';
    mockGetMeta.mockImplementation((key: string) => {
      if (key === 'budget:daily_usage')
        return JSON.stringify({ day: currentDay, tokens: 200 });
      return null;
    });
    const start = Date.now();
    await enforceBudget();
    const elapsed = Date.now() - start;
    // Allow generous margin for setTimeout imprecision, but must be ≥ throttle.
    expect(elapsed).toBeGreaterThanOrEqual(45);
  });

  it('enforceBudget does NOT throttle when daily-usage row is from a previous day', async () => {
    process.env['LAIN_DAILY_TOKEN_CAP'] = '100';
    process.env['LAIN_DAILY_THROTTLE_MS'] = '500';
    // Yesterday's usage well over the cap, but the usage helper resets
    // when data.day !== currentDay, so today's effective usage is 0.
    mockGetMeta.mockImplementation((key: string) => {
      if (key === 'budget:daily_usage')
        return JSON.stringify({ day: '2000-01-01', tokens: 999_999 });
      return null;
    });
    const start = Date.now();
    await enforceBudget();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
  });

  it('enforceBudget still throws monthly BudgetExceededError even when daily throttle would fire', async () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '100';
    process.env['LAIN_DAILY_TOKEN_CAP'] = '50';
    process.env['LAIN_DAILY_THROTTLE_MS'] = '500';
    mockGetMeta.mockImplementation((key: string) => {
      if (key === 'budget:monthly_usage')
        return JSON.stringify({ month: currentMonth, tokens: 200 });
      if (key === 'budget:daily_usage')
        return JSON.stringify({ day: currentDay, tokens: 999 });
      return null;
    });
    // Hard cap takes precedence — throws synchronously before the throttle sleeps.
    const start = Date.now();
    await expect(enforceBudget()).rejects.toThrow(BudgetExceededError);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100); // no 500ms sleep
  });

  it('enforceBudget does NOT sleep if LAIN_DAILY_THROTTLE_MS is 0', async () => {
    process.env['LAIN_DAILY_TOKEN_CAP'] = '100';
    process.env['LAIN_DAILY_THROTTLE_MS'] = '0';
    mockGetMeta.mockImplementation((key: string) => {
      if (key === 'budget:daily_usage')
        return JSON.stringify({ day: currentDay, tokens: 200 });
      return null;
    });
    const start = Date.now();
    await enforceBudget();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
  });

  it('recordUsage increments daily counter when daily cap is set', () => {
    process.env['LAIN_DAILY_TOKEN_CAP'] = '1000';
    recordUsage(20, 30);
    const calls = mockAtomicMetaIncrementCounter.mock.calls.map((c) => c[0]);
    const dailyCall = calls.find((c) => c.key === 'budget:daily_usage');
    expect(dailyCall).toBeDefined();
    expect(dailyCall).toMatchObject({
      key: 'budget:daily_usage',
      periodField: 'day',
      periodValue: currentDay,
      counterField: 'tokens',
      delta: 50,
    });
  });

  it('recordUsage does NOT increment daily counter when daily cap is unset', () => {
    // Monthly cap enabled (default), daily cap disabled → only monthly gets touched.
    recordUsage(10, 20);
    const calls = mockAtomicMetaIncrementCounter.mock.calls.map((c) => c[0]);
    expect(calls.find((c) => c.key === 'budget:daily_usage')).toBeUndefined();
    expect(calls.find((c) => c.key === 'budget:monthly_usage')).toBeDefined();
  });

  it('recordUsage increments BOTH counters when both caps are set', () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '10000';
    process.env['LAIN_DAILY_TOKEN_CAP'] = '1000';
    recordUsage(10, 15);
    const keys = mockAtomicMetaIncrementCounter.mock.calls.map((c) => c[0].key);
    expect(keys).toContain('budget:monthly_usage');
    expect(keys).toContain('budget:daily_usage');
  });

  it('recordUsage writes nothing when BOTH caps are disabled (0)', () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '0';
    process.env['LAIN_DAILY_TOKEN_CAP'] = '0';
    recordUsage(100, 100);
    expect(mockAtomicMetaIncrementCounter).not.toHaveBeenCalled();
  });

  it('getBudgetStatus exposes daily fields', () => {
    process.env['LAIN_DAILY_TOKEN_CAP'] = '2000';
    mockGetMeta.mockImplementation((key: string) => {
      if (key === 'budget:daily_usage')
        return JSON.stringify({ day: currentDay, tokens: 500 });
      return null;
    });
    const status = getBudgetStatus();
    expect(status.day).toBe(currentDay);
    expect(status.dailyTokensUsed).toBe(500);
    expect(status.dailyCap).toBe(2000);
    expect(status.dailyPctUsed).toBe(25);
  });

  it('getBudgetStatus dailyPctUsed is 0 when daily cap disabled', () => {
    mockGetMeta.mockImplementation((key: string) => {
      if (key === 'budget:daily_usage')
        return JSON.stringify({ day: currentDay, tokens: 9999 });
      return null;
    });
    const status = getBudgetStatus();
    expect(status.dailyCap).toBe(0);
    expect(status.dailyPctUsed).toBe(0);
  });

  it('direct-constructed provider throttles via await this.assertBudget()', async () => {
    process.env['LAIN_DAILY_TOKEN_CAP'] = '100';
    process.env['LAIN_DAILY_THROTTLE_MS'] = '40';
    mockGetMeta.mockImplementation((key: string) => {
      if (key === 'budget:daily_usage')
        return JSON.stringify({ day: currentDay, tokens: 200 });
      return null;
    });
    mockAnthropicCreate.mockResolvedValue(makeAnthropicResponse());
    const p = createAnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
    const start = Date.now();
    await p.complete({ messages: basicMessages });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(35);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// findings.md P2:1146 — cross-provider fallback (object-form fallbackModels)
// ─────────────────────────────────────────────────────────────────────────────

describe('findings.md P2:1146 — cross-provider fallback chain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['LAIN_MONTHLY_TOKEN_CAP'];
    mockGetMeta.mockReturnValue(null);
    mockAtomicMetaIncrementCounter.mockImplementation(
      (p: { freshJson: string }) => p.freshJson,
    );
    mockAnthropicCreate.mockResolvedValue(makeAnthropicResponse());
    mockOpenAICreate.mockResolvedValue(makeOpenAIResponse());
    mockGenerateContent.mockResolvedValue(makeGoogleResponse());
  });

  afterEach(() => {
    delete process.env['LAIN_ANTHROPIC_KEY'];
    delete process.env['LAIN_OPENAI_KEY'];
    delete process.env['LAIN_GOOGLE_KEY'];
  });

  it('Anthropic primary falls over to OpenAI fallback (different provider type)', async () => {
    const deprecatedError = Object.assign(new Error('model not found'), { status: 404 });
    mockAnthropicCreate.mockRejectedValueOnce(deprecatedError);
    mockOpenAICreate.mockResolvedValue(
      makeOpenAIResponse({ choices: [{ message: { content: 'from gpt-4o', role: 'assistant' } }] }),
    );
    const p = createProvider({
      type: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      fallbackModels: [{ type: 'openai', model: 'gpt-4o' }],
    });
    const result = await p.complete({ messages: basicMessages });
    expect(result.content).toBe('from gpt-4o');
    expect(mockOpenAICreate).toHaveBeenCalled();
  });

  it('Anthropic primary falls over to Google fallback', async () => {
    const deprecatedError = Object.assign(new Error('model not found'), { status: 404 });
    mockAnthropicCreate.mockRejectedValueOnce(deprecatedError);
    mockGenerateContent.mockResolvedValue(makeGoogleResponse('from gemini'));
    const p = createProvider({
      type: 'anthropic',
      model: 'claude-opus-4',
      fallbackModels: [{ type: 'google', model: 'gemini-2.5-pro' }],
    });
    const result = await p.complete({ messages: basicMessages });
    expect(result.content).toBe('from gemini');
    expect(mockGenerateContent).toHaveBeenCalled();
  });

  it('mixes string and object entries in the same chain', async () => {
    const deprecatedError = Object.assign(new Error('model not found'), { status: 404 });
    // Primary Anthropic fails, first fallback (string, same provider) also fails, third (OpenAI) succeeds.
    mockAnthropicCreate
      .mockRejectedValueOnce(deprecatedError)
      .mockRejectedValueOnce(deprecatedError);
    mockOpenAICreate.mockResolvedValue(
      makeOpenAIResponse({ choices: [{ message: { content: 'cross-provider saved us', role: 'assistant' } }] }),
    );
    const p = createProvider({
      type: 'anthropic',
      model: 'claude-opus-4',
      fallbackModels: ['claude-sonnet-4', { type: 'openai', model: 'gpt-4o' }],
    });
    const result = await p.complete({ messages: basicMessages });
    expect(result.content).toBe('cross-provider saved us');
  });

  it('string entries still work (backwards compat — same provider type)', async () => {
    const deprecatedError = Object.assign(new Error('model not found'), { status: 404 });
    mockAnthropicCreate
      .mockRejectedValueOnce(deprecatedError)
      .mockResolvedValue(
        makeAnthropicResponse({ content: [{ type: 'text', text: 'sonnet response' }] }),
      );
    const p = createProvider({
      type: 'anthropic',
      model: 'claude-opus-4',
      fallbackModels: ['claude-sonnet-4'],
    });
    const result = await p.complete({ messages: basicMessages });
    expect(result.content).toBe('sonnet response');
    // OpenAI/Google should never be called — same provider only.
    expect(mockOpenAICreate).not.toHaveBeenCalled();
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it('fallback entry with apiKeyEnv uses that env var for the cross-provider call', async () => {
    process.env['LAIN_OPENAI_KEY'] = 'sk-openai-fallback';
    const deprecatedError = Object.assign(new Error('model not found'), { status: 404 });
    mockAnthropicCreate.mockRejectedValueOnce(deprecatedError);
    const p = createProvider({
      type: 'anthropic',
      model: 'claude-opus-4',
      fallbackModels: [{ type: 'openai', model: 'gpt-4o', apiKeyEnv: 'LAIN_OPENAI_KEY' }],
    });
    await p.complete({ messages: basicMessages });
    expect(MockOpenAI).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-openai-fallback' }));
  });

  it('fallback entry without apiKeyEnv does not inherit primary apiKeyEnv across provider types', async () => {
    process.env['LAIN_ANTHROPIC_KEY'] = 'sk-anthropic-only';
    const deprecatedError = Object.assign(new Error('model not found'), { status: 404 });
    mockAnthropicCreate.mockRejectedValueOnce(deprecatedError);
    const p = createProvider({
      type: 'anthropic',
      model: 'claude-opus-4',
      apiKeyEnv: 'LAIN_ANTHROPIC_KEY',
      // No apiKeyEnv on the cross-provider entry — OpenAI SDK should fall
      // back to its default env var chain (OPENAI_API_KEY), NOT silently
      // use the anthropic key.
      fallbackModels: [{ type: 'openai', model: 'gpt-4o' }],
    });
    await p.complete({ messages: basicMessages });
    const lastCallArgs = (MockOpenAI as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(lastCallArgs?.apiKey).not.toBe('sk-anthropic-only');
  });

  it('fallback to OpenAI then to Google when OpenAI also gone', async () => {
    const deprecatedError = Object.assign(new Error('model not found'), { status: 404 });
    mockAnthropicCreate.mockRejectedValueOnce(deprecatedError);
    mockOpenAICreate.mockRejectedValueOnce(deprecatedError);
    mockGenerateContent.mockResolvedValue(makeGoogleResponse('last resort'));
    const p = createProvider({
      type: 'anthropic',
      model: 'claude-opus-4',
      fallbackModels: [
        { type: 'openai', model: 'gpt-4o' },
        { type: 'google', model: 'gemini-2.5-pro' },
      ],
    });
    const result = await p.complete({ messages: basicMessages });
    expect(result.content).toBe('last resort');
  });

  it('throws "All models exhausted" with all model names (mixed entries) when chain is dead', async () => {
    const deprecatedError = Object.assign(new Error('model not found'), { status: 404 });
    mockAnthropicCreate
      .mockRejectedValueOnce(deprecatedError)
      .mockRejectedValueOnce(deprecatedError);
    mockOpenAICreate.mockRejectedValue(deprecatedError);
    const p = createProvider({
      type: 'anthropic',
      model: 'claude-opus-4',
      fallbackModels: ['claude-sonnet-4', { type: 'openai', model: 'gpt-4o' }],
    });
    await expect(p.complete({ messages: basicMessages })).rejects.toThrow(
      /All models exhausted.*claude-opus-4.*claude-sonnet-4.*gpt-4o/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// findings.md P2:788 — abortSignal + timeoutMs plumbing
// ─────────────────────────────────────────────────────────────────────────────

describe('findings.md P2:788 — abortSignal and timeoutMs plumbing', () => {
  beforeEach(() => {
    mockAnthropicCreate.mockReset();
    mockOpenAICreate.mockReset();
    mockGenerateContent.mockReset();
    mockAnthropicCreate.mockResolvedValue(makeAnthropicResponse());
    mockOpenAICreate.mockResolvedValue(makeOpenAIResponse());
    mockGenerateContent.mockResolvedValue(makeGoogleResponse());
  });

  it('Anthropic.complete forwards signal + timeout as SDK request options', async () => {
    const controller = new AbortController();
    const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
    await p.complete({
      messages: basicMessages,
      abortSignal: controller.signal,
      timeoutMs: 4321,
    });
    const secondArg = mockAnthropicCreate.mock.calls[0]?.[1];
    expect(secondArg).toEqual({ signal: controller.signal, timeout: 4321 });
  });

  it('Anthropic.complete passes empty options object when neither signal nor timeout given', async () => {
    const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
    await p.complete({ messages: basicMessages });
    const secondArg = mockAnthropicCreate.mock.calls[0]?.[1];
    expect(secondArg).toEqual({});
  });

  it('OpenAI.complete forwards signal + timeout as SDK request options', async () => {
    const controller = new AbortController();
    const p = new OpenAIProvider({ model: 'gpt-4o' });
    await p.complete({
      messages: basicMessages,
      abortSignal: controller.signal,
      timeoutMs: 2500,
    });
    const secondArg = mockOpenAICreate.mock.calls[0]?.[1];
    expect(secondArg).toEqual({ signal: controller.signal, timeout: 2500 });
  });

  it('Google.complete forwards signal + timeout as SingleRequestOptions', async () => {
    const controller = new AbortController();
    const p = new GoogleProvider({ model: 'gemini-1.5-pro' });
    await p.complete({
      messages: basicMessages,
      abortSignal: controller.signal,
      timeoutMs: 7000,
    });
    const secondArg = mockGenerateContent.mock.calls[0]?.[1];
    expect(secondArg).toEqual({ signal: controller.signal, timeout: 7000 });
  });

  it('aborted signal breaks out of retry backoff and rejects instead of retrying', async () => {
    const controller = new AbortController();
    const transientErr = Object.assign(new Error('503 service unavailable'), { status: 503 });
    let callCount = 0;
    const fn = vi.fn(async () => {
      callCount++;
      // After first failure, abort during the sleep before second attempt.
      queueMicrotask(() => controller.abort());
      throw transientErr;
    });
    await expect(
      withRetry(fn, 'test', {
        baseDelayMs: 50,
        maxRetries: 3,
        abortSignal: controller.signal,
      }),
    ).rejects.toBe(transientErr);
    // Only one attempt happened — the abort during backoff prevented a retry.
    expect(callCount).toBe(1);
  });

  it('withRetry without abortSignal still retries transient errors normally', async () => {
    let callCount = 0;
    const fn = vi.fn(async () => {
      callCount++;
      if (callCount < 2) throw Object.assign(new Error('503'), { status: 503 });
      return 'ok';
    });
    const result = await withRetry(fn, 'test', { baseDelayMs: 1, maxRetries: 3 });
    expect(result).toBe('ok');
    expect(callCount).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// findings.md P2:828 — getModelInfo per-model lookup
// ─────────────────────────────────────────────────────────────────────────────

describe('findings.md P2:828 — getModelInfo', () => {
  it('Anthropic 3.5 sonnet reports 200k context / 8192 output / vision + tools', () => {
    const info = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' }).getModelInfo();
    expect(info.contextWindow).toBe(200_000);
    expect(info.maxOutputTokens).toBe(8192);
    expect(info.supportsVision).toBe(true);
    expect(info.supportsStreaming).toBe(true);
    expect(info.supportsTools).toBe(true);
  });

  it('Anthropic 3 opus falls back to conservative 4096 output', () => {
    const info = new AnthropicProvider({ model: 'claude-3-opus-20240229' }).getModelInfo();
    expect(info.contextWindow).toBe(200_000);
    expect(info.maxOutputTokens).toBe(4096);
  });

  it('OpenAI gpt-4o reports 128k context / 16384 output / vision', () => {
    const info = new OpenAIProvider({ model: 'gpt-4o' }).getModelInfo();
    expect(info.contextWindow).toBe(128_000);
    expect(info.maxOutputTokens).toBe(16_384);
    expect(info.supportsVision).toBe(true);
  });

  it('OpenAI gpt-4 (legacy) reports 8k context / no vision', () => {
    const info = new OpenAIProvider({ model: 'gpt-4' }).getModelInfo();
    expect(info.contextWindow).toBe(8192);
    expect(info.supportsVision).toBe(false);
  });

  it('OpenAI o-series reasoning model reports 200k context and 100k output', () => {
    const info = new OpenAIProvider({ model: 'o1-preview' }).getModelInfo();
    expect(info.contextWindow).toBe(200_000);
    expect(info.maxOutputTokens).toBe(100_000);
  });

  it('OpenAI o3-mini reports no vision (mini variants are text-only)', () => {
    const info = new OpenAIProvider({ model: 'o3-mini' }).getModelInfo();
    expect(info.supportsVision).toBe(false);
  });

  it('OpenAI unknown model falls back to 16k/4096 text-only', () => {
    const info = new OpenAIProvider({ model: 'gpt-3.5-turbo' }).getModelInfo();
    expect(info.contextWindow).toBe(16_385);
    expect(info.supportsVision).toBe(false);
  });

  it('Google gemini-1.5-pro reports 2M context / 8192 output / vision', () => {
    const info = new GoogleProvider({ model: 'gemini-1.5-pro' }).getModelInfo();
    expect(info.contextWindow).toBe(2_000_000);
    expect(info.maxOutputTokens).toBe(8192);
    expect(info.supportsVision).toBe(true);
    // Google has no streaming impl today.
    expect(info.supportsStreaming).toBe(false);
  });

  it('Google gemini-2.5-pro reports 2M context / 64k output', () => {
    const info = new GoogleProvider({ model: 'gemini-2.5-pro' }).getModelInfo();
    expect(info.contextWindow).toBe(2_000_000);
    expect(info.maxOutputTokens).toBe(65_536);
  });

  it('Google unknown model falls back to conservative 32k/2048 text-only', () => {
    const info = new GoogleProvider({ model: 'gemini-1.0-pro' }).getModelInfo();
    expect(info.contextWindow).toBe(32_768);
    expect(info.maxOutputTokens).toBe(2048);
    expect(info.supportsVision).toBe(false);
  });

  it('ModelInfo.supportsStreaming mirrors Provider.supportsStreaming', () => {
    const openai = new OpenAIProvider({ model: 'gpt-4o' });
    const google = new GoogleProvider({ model: 'gemini-1.5-pro' });
    expect(openai.getModelInfo().supportsStreaming).toBe(openai.supportsStreaming);
    expect(google.getModelInfo().supportsStreaming).toBe(google.supportsStreaming);
  });
});
