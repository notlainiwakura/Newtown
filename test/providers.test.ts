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
} = vi.hoisted(() => {
  const mockAnthropicCreate = vi.fn();
  const mockAnthropicStream = vi.fn();
  const mockOpenAICreate = vi.fn();
  const mockGenerateContent = vi.fn();
  const mockGetGenerativeModel = vi.fn().mockReturnValue({ generateContent: mockGenerateContent });
  const mockGetMeta = vi.fn();
  const mockSetMeta = vi.fn();
  return {
    mockAnthropicCreate,
    mockAnthropicStream,
    mockOpenAICreate,
    mockGenerateContent,
    mockGetGenerativeModel,
    mockGetMeta,
    mockSetMeta,
  };
});

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: mockAnthropicCreate,
      stream: mockAnthropicStream,
    },
  })),
}));

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: mockOpenAICreate } },
  })),
}));

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: vi.fn().mockImplementation(() => ({
    getGenerativeModel: mockGetGenerativeModel,
  })),
}));

// Mock logger
vi.mock('../src/utils/logger.js', () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// Mock storage for budget tests
vi.mock('../src/storage/database.js', () => ({
  getMeta: mockGetMeta,
  setMeta: mockSetMeta,
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
import { GoogleProvider, createGoogleProvider } from '../src/providers/google.js';
import { BaseProvider } from '../src/providers/base.js';
import { withRetry } from '../src/providers/retry.js';
import { createFallbackProvider } from '../src/providers/fallback.js';
import {
  checkBudget,
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

describe('BaseProvider', () => {
  it('is abstract in TypeScript — subclass must implement required methods', () => {
    // At runtime JS does not throw for abstract classes; we verify via subclass contract
    class Concrete extends BaseProvider {
      readonly name = 'x';
      readonly model = 'x';
      async complete() { return { content: '', finishReason: 'stop' as const, usage: { inputTokens: 0, outputTokens: 0 } }; }
      async completeWithTools() { return { content: '', finishReason: 'stop' as const, usage: { inputTokens: 0, outputTokens: 0 } }; }
      async continueWithToolResults() { return { content: '', finishReason: 'stop' as const, usage: { inputTokens: 0, outputTokens: 0 } }; }
    }
    expect(new Concrete()).toBeInstanceOf(BaseProvider);
  });

  it('concrete subclass must implement name, model, complete, completeWithTools, continueWithToolResults', () => {
    class Minimal extends BaseProvider {
      readonly name = 'test';
      readonly model = 'test-model';
      async complete() {
        return { content: '', finishReason: 'stop' as const, usage: { inputTokens: 0, outputTokens: 0 } };
      }
      async completeWithTools() {
        return { content: '', finishReason: 'stop' as const, usage: { inputTokens: 0, outputTokens: 0 } };
      }
      async continueWithToolResults() {
        return { content: '', finishReason: 'stop' as const, usage: { inputTokens: 0, outputTokens: 0 } };
      }
    }
    const p = new Minimal();
    expect(p.name).toBe('test');
    expect(p.model).toBe('test-model');
  });

  it('optional streaming methods need not be defined', () => {
    class Minimal extends BaseProvider {
      readonly name = 'x';
      readonly model = 'x';
      async complete() { return { content: '', finishReason: 'stop' as const, usage: { inputTokens: 0, outputTokens: 0 } }; }
      async completeWithTools() { return { content: '', finishReason: 'stop' as const, usage: { inputTokens: 0, outputTokens: 0 } }; }
      async continueWithToolResults() { return { content: '', finishReason: 'stop' as const, usage: { inputTokens: 0, outputTokens: 0 } }; }
    }
    const p = new Minimal();
    expect(p.completeStream).toBeUndefined();
    expect(p.completeWithToolsStream).toBeUndefined();
    expect(p.continueWithToolResultsStream).toBeUndefined();
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
          expect.objectContaining({ max_tokens: 8192 })
        );
      });
    });

    it('uses provided maxTokens', () => {
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022', maxTokens: 1024 });
      mockAnthropicCreate.mockResolvedValueOnce(makeAnthropicResponse());
      return p.complete({ messages: [{ role: 'user', content: 'hi' }] }).then(() => {
        expect(mockAnthropicCreate).toHaveBeenCalledWith(
          expect.objectContaining({ max_tokens: 1024 })
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
    it('returns text from first text content block', async () => {
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

    it('separates system prompt into Anthropic system field', async () => {
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      await p.complete({ messages: basicMessages });
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
      });
      const call = mockAnthropicCreate.mock.calls[0]?.[0];
      expect(call.system).toBe('Part 1\n\nPart 2');
    });

    it('passes temperature option', async () => {
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      await p.complete({ messages: basicMessages, temperature: 0.5 });
      expect(mockAnthropicCreate).toHaveBeenCalledWith(
        expect.objectContaining({ temperature: 0.5 })
      );
    });

    it('defaults temperature to 1', async () => {
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      await p.complete({ messages: basicMessages });
      expect(mockAnthropicCreate).toHaveBeenCalledWith(
        expect.objectContaining({ temperature: 1 })
      );
    });

    it('passes stopSequences as stop_sequences', async () => {
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      await p.complete({ messages: basicMessages, stopSequences: ['END', 'STOP'] });
      expect(mockAnthropicCreate).toHaveBeenCalledWith(
        expect.objectContaining({ stop_sequences: ['END', 'STOP'] })
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
        expect.objectContaining({ max_tokens: 2048 })
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

    it('maps toolChoice none to { type: any } (Anthropic quirk)', async () => {
      const p = new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' });
      await p.completeWithTools({ messages: basicMessages, toolChoice: 'none' });
      const call = mockAnthropicCreate.mock.calls[0]?.[0];
      expect(call.tool_choice).toEqual({ type: 'any' });
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
        expect.objectContaining({ max_tokens: 8192 })
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

    it('maps unknown finish_reason to stop', async () => {
      mockOpenAICreate.mockResolvedValueOnce(makeOpenAIResponse({ choices: [{ message: { content: 'hi' }, finish_reason: 'unknown_reason' }] }));
      const p = new OpenAIProvider({ model: 'gpt-4o' });
      const result = await p.complete({ messages: basicMessages });
      expect(result.finishReason).toBe('stop');
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

    it('passes stop sequences', async () => {
      const p = new OpenAIProvider({ model: 'gpt-4o' });
      await p.complete({ messages: basicMessages, stopSequences: ['END'] });
      expect(mockOpenAICreate).toHaveBeenCalledWith(
        expect.objectContaining({ stop: ['END'] })
      );
    });

    it('includes system messages directly in messages array', async () => {
      const p = new OpenAIProvider({ model: 'gpt-4o' });
      await p.complete({ messages: basicMessages });
      const call = mockOpenAICreate.mock.calls[0]?.[0];
      expect(call.messages[0].role).toBe('system');
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

    it('maps unknown finish reason to stop', async () => {
      mockGenerateContent.mockResolvedValueOnce(makeGoogleResponse('r', 'RECITATION'));
      const p = new GoogleProvider({ model: 'gemini-1.5-pro' });
      const result = await p.complete({ messages: basicMessages });
      expect(result.finishReason).toBe('stop');
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

    it('always sets thinkingBudget to 0', async () => {
      const p = new GoogleProvider({ model: 'gemini-2.5-flash' });
      await p.complete({ messages: basicMessages });
      expect(mockGetGenerativeModel).toHaveBeenCalledWith(
        expect.objectContaining({
          generationConfig: expect.objectContaining({
            thinkingConfig: { thinkingBudget: 0 },
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

    it('auto-generates tool call ids as call_0, call_1', async () => {
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
      expect(result.toolCalls![0]!.id).toBe('call_0');
      expect(result.toolCalls![1]!.id).toBe('call_1');
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

    it('returns unknown as tool name when id not found', async () => {
      const p = new GoogleProvider({ model: 'gemini-1.5-pro' });
      await p.continueWithToolResults(
        { messages: [{ role: 'user', content: 'go' }] },
        [],
        [{ toolCallId: 'nonexistent', content: 'r' }]
      );
      const genCall = mockGenerateContent.mock.calls[0]?.[0];
      const userMsg = genCall.contents[genCall.contents.length - 1];
      expect(userMsg.parts[0].functionResponse.name).toBe('unknown');
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

  it('uses exponential backoff delays (1x, 2x, 4x baseDelay)', async () => {
    const delays: number[] = [];
    const origSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(
      (cb: TimerHandler, ms?: number) => {
        if (typeof ms === 'number') delays.push(ms);
        return origSetTimeout(cb as () => void, 0);
      }
    );

    const err = Object.assign(new Error('rate limit'), { status: 429 });
    const fn = vi.fn().mockRejectedValue(err);
    await withRetry(fn, 'test', { maxRetries: 3, baseDelayMs: 100 }).catch(() => {});
    spy.mockRestore();

    expect(delays).toEqual([100, 200, 400]);
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
      expect(mockSetMeta).not.toHaveBeenCalled();
    });

    it('increments existing token count', () => {
      mockGetMeta.mockReturnValue(JSON.stringify({ month: currentYearMonth, tokens: 500 }));
      recordUsage(100, 50);
      expect(mockSetMeta).toHaveBeenCalledWith(
        'budget:monthly_usage',
        JSON.stringify({ month: currentYearMonth, tokens: 650 })
      );
    });

    it('creates fresh usage record when none exists', () => {
      mockGetMeta.mockReturnValue(null);
      recordUsage(10, 5);
      expect(mockSetMeta).toHaveBeenCalledWith(
        'budget:monthly_usage',
        JSON.stringify({ month: currentYearMonth, tokens: 15 })
      );
    });

    it('resets usage when month changes', () => {
      mockGetMeta.mockReturnValue(JSON.stringify({ month: '2020-01', tokens: 99999 }));
      recordUsage(10, 5);
      expect(mockSetMeta).toHaveBeenCalledWith(
        'budget:monthly_usage',
        JSON.stringify({ month: currentYearMonth, tokens: 15 })
      );
    });

    it('records zero tokens without error', () => {
      mockGetMeta.mockReturnValue(JSON.stringify({ month: currentYearMonth, tokens: 100 }));
      recordUsage(0, 0);
      expect(mockSetMeta).toHaveBeenCalledWith(
        'budget:monthly_usage',
        JSON.stringify({ month: currentYearMonth, tokens: 100 })
      );
    });

    it('handles large token counts', () => {
      mockGetMeta.mockReturnValue(JSON.stringify({ month: currentYearMonth, tokens: 0 }));
      recordUsage(1_000_000, 500_000);
      expect(mockSetMeta).toHaveBeenCalledWith(
        'budget:monthly_usage',
        JSON.stringify({ month: currentYearMonth, tokens: 1_500_000 })
      );
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

  it('wraps provider with budget enforcement', async () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '100';
    mockGetMeta.mockReturnValue(JSON.stringify({ month: new Date().toISOString().slice(0, 7), tokens: 100 }));
    const p = createProvider({ type: 'anthropic', model: 'claude-3-5-sonnet-20241022' });
    await expect(p.complete({ messages: basicMessages })).rejects.toThrow(BudgetExceededError);
  });

  it('records usage after successful complete call', async () => {
    const p = createProvider({ type: 'anthropic', model: 'claude-3-5-sonnet-20241022' });
    await p.complete({ messages: basicMessages });
    expect(mockSetMeta).toHaveBeenCalled();
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
    expect(mockSetMeta).toHaveBeenCalled();
  });

  it('records usage after continueWithToolResults', async () => {
    const p = createProvider({ type: 'anthropic', model: 'claude-3-5-sonnet-20241022' });
    await p.continueWithToolResults(
      { messages: basicMessages },
      [{ id: 'tc1', name: 'fn', input: {} }],
      [{ toolCallId: 'tc1', content: 'r' }]
    );
    expect(mockSetMeta).toHaveBeenCalled();
  });

  it('budget is disabled when LAIN_MONTHLY_TOKEN_CAP=0', async () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '0';
    mockGetMeta.mockReturnValue(JSON.stringify({ month: new Date().toISOString().slice(0, 7), tokens: 999_999_999 }));
    const p = createProvider({ type: 'anthropic', model: 'claude-3-5-sonnet-20241022' });
    await expect(p.complete({ messages: basicMessages })).resolves.toBeDefined();
  });
});
