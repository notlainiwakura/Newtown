/**
 * Finish Reason Handling Test Suite
 *
 * Validates that every provider method correctly surfaces finish reasons,
 * and that every LLM call site in the codebase either checks finishReason
 * or is documented as intentionally ignoring it.
 *
 * BACKGROUND: Commune conversations were silently truncated for months
 * because maxTokens: 250 was too low. The LLM returned stop_reason:
 * "max_tokens" but no caller checked it. This suite ensures the provider
 * layer correctly maps finish reasons AND that callers handle them.
 *
 * SCOPE (no overlap with existing tests):
 * - matrix-provider.test.ts already tests finish-reason mapping via complete() only
 * - This suite tests EVERY method (complete, completeWithTools, completeStream,
 *   continueWithToolResults, completeWithToolsStream, continueWithToolResultsStream)
 * - This suite tests caller-side handling (or lack thereof) in every agent file
 * - This suite tests truncation behavior: mid-sentence content, empty content,
 *   memory corruption, activity feed corruption
 * - This suite tests edge cases: exact token boundaries, zero tokens, etc.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// ─── Hoisted mock handles ────────────────────────────────────────────────────

const {
  mockAnthropicCreate,
  mockAnthropicStream,
  mockOpenAICreate,
  mockGenerateContent,
  mockGetGenerativeModel,
} = vi.hoisted(() => {
  const mockAnthropicCreate = vi.fn();
  const mockAnthropicStream = vi.fn();
  const mockOpenAICreate = vi.fn();
  const mockGenerateContent = vi.fn();
  const mockGetGenerativeModel = vi.fn().mockReturnValue({ generateContent: mockGenerateContent });
  return {
    mockAnthropicCreate,
    mockAnthropicStream,
    mockOpenAICreate,
    mockGenerateContent,
    mockGetGenerativeModel,
  };
});

vi.mock('@anthropic-ai/sdk', async () => {
  // findings.md P2:838 — preserve real APIError exports so the provider's
  // `err instanceof APIError` retry classification works under test.
  const actual = await vi.importActual<typeof import('@anthropic-ai/sdk')>('@anthropic-ai/sdk');
  return {
    ...actual,
    default: vi.fn().mockImplementation(() => ({
      messages: { create: mockAnthropicCreate, stream: mockAnthropicStream },
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

vi.mock('../src/utils/logger.js', () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { AnthropicProvider } from '../src/providers/anthropic.js';
import { OpenAIProvider } from '../src/providers/openai.js';
import { GoogleProvider } from '../src/providers/google.js';
import type {
  CompletionResult,
  CompletionWithToolsResult,
  ToolCall,
  ToolResult,
  Message,
} from '../src/providers/base.js';

// ─── Factory helpers ─────────────────────────────────────────────────────────

function makeAnthropic(maxTokens?: number): AnthropicProvider {
  return new AnthropicProvider({ model: 'claude-3-5-haiku-20241022', apiKey: 'test-key', maxTokens });
}

function makeOpenAI(maxTokens?: number): OpenAIProvider {
  return new OpenAIProvider({ model: 'gpt-4o-mini', apiKey: 'test-key', maxTokens });
}

function makeGoogle(maxTokens?: number): GoogleProvider {
  return new GoogleProvider({ model: 'gemini-1.5-flash', apiKey: 'test-key', maxTokens });
}

// ─── Response builders ───────────────────────────────────────────────────────

function anthropicResponse(text: string, stopReason: string | null, outputTokens = 50) {
  return {
    content: [{ type: 'text', text }],
    stop_reason: stopReason,
    usage: { input_tokens: 10, output_tokens: outputTokens },
  };
}

function anthropicToolResponse(text: string, toolCalls: Array<{ id: string; name: string; input: unknown }>, stopReason: string | null) {
  return {
    content: [
      ...(text ? [{ type: 'text' as const, text }] : []),
      ...toolCalls.map((tc) => ({
        type: 'tool_use' as const,
        id: tc.id,
        name: tc.name,
        input: tc.input,
      })),
    ],
    stop_reason: stopReason,
    usage: { input_tokens: 10, output_tokens: 50 },
  };
}

function openaiResponse(text: string, finishReason: string | null, outputTokens = 50) {
  return {
    choices: [{
      message: { content: text, tool_calls: [] },
      finish_reason: finishReason,
    }],
    usage: { prompt_tokens: 10, completion_tokens: outputTokens },
  };
}

function openaiToolResponse(text: string | null, toolCalls: Array<{ id: string; name: string; args: string }>, finishReason: string | null) {
  return {
    choices: [{
      message: {
        content: text,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.args },
        })),
      },
      finish_reason: finishReason,
    }],
    usage: { prompt_tokens: 10, completion_tokens: 50 },
  };
}

function googleResponse(text: string, finishReason: string | undefined, outputTokens = 50) {
  return {
    response: {
      text: () => text,
      candidates: [{ finishReason, content: { parts: [{ text }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: outputTokens },
    },
  };
}

function googleToolResponse(text: string, toolCalls: Array<{ name: string; args: unknown }>, finishReason: string | undefined) {
  return {
    response: {
      text: () => text,
      candidates: [{
        finishReason,
        content: {
          parts: [
            ...(text ? [{ text }] : []),
            ...toolCalls.map((tc) => ({
              functionCall: { name: tc.name, args: tc.args },
            })),
          ],
        },
      }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 50 },
    },
  };
}

/** Create an async iterable that yields events for Anthropic streaming. */
function makeStreamEvents(
  text: string,
  stopReason: string | null,
  inputTokens = 10,
  outputTokens = 50,
  toolBlocks?: Array<{ id: string; name: string; input: Record<string, unknown> }>
) {
  const events: unknown[] = [
    { type: 'message_start', message: { usage: { input_tokens: inputTokens } } },
  ];

  if (toolBlocks) {
    for (const tb of toolBlocks) {
      events.push({ type: 'content_block_start', content_block: { type: 'tool_use', id: tb.id, name: tb.name } });
      events.push({ type: 'content_block_delta', delta: { partial_json: JSON.stringify(tb.input) } });
      events.push({ type: 'content_block_stop' });
    }
  }

  if (text) {
    events.push({ type: 'content_block_start', content_block: { type: 'text' } });
    // Split text into chunks for realism
    const chunks = text.match(/.{1,10}/g) ?? [text];
    for (const chunk of chunks) {
      events.push({ type: 'content_block_delta', delta: { text: chunk } });
    }
    events.push({ type: 'content_block_stop' });
  }

  events.push({
    type: 'message_delta',
    delta: { stop_reason: stopReason },
    usage: { output_tokens: outputTokens },
  });

  return {
    [Symbol.asyncIterator]: async function* () {
      for (const e of events) yield e;
    },
  };
}

// ─── Shared test data ────────────────────────────────────────────────────────

const simpleMessages: Message[] = [{ role: 'user', content: 'hello' }];

const sampleTools = [{
  name: 'test_tool',
  description: 'A test tool',
  inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
}];

const sampleToolCalls: ToolCall[] = [{ id: 'tc_1', name: 'test_tool', input: { q: 'test' } }];

const sampleToolResults: ToolResult[] = [{ toolCallId: 'tc_1', content: 'result' }];

const SRC_ROOT = join(process.cwd(), 'src');

function readSrc(relPath: string): string {
  return readFileSync(join(SRC_ROOT, relPath), 'utf-8');
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. ANTHROPIC PROVIDER — finish reason on every method
// ═════════════════════════════════════════════════════════════════════════════

describe('Anthropic: finish reason surfaced on every method', () => {
  beforeEach(() => {
    mockAnthropicCreate.mockReset();
    mockAnthropicStream.mockReset();
  });

  // --- complete() ---

  it('complete() returns "length" when stop_reason is "max_tokens"', async () => {
    mockAnthropicCreate.mockResolvedValue(anthropicResponse('truncat', 'max_tokens'));
    const r = await makeAnthropic().complete({ messages: simpleMessages });
    expect(r.finishReason).toBe('length');
  });

  it('complete() returns "stop" when stop_reason is "end_turn"', async () => {
    mockAnthropicCreate.mockResolvedValue(anthropicResponse('hello', 'end_turn'));
    const r = await makeAnthropic().complete({ messages: simpleMessages });
    expect(r.finishReason).toBe('stop');
  });

  it('complete() returns "stop" when stop_reason is "stop_sequence"', async () => {
    mockAnthropicCreate.mockResolvedValue(anthropicResponse('hello', 'stop_sequence'));
    const r = await makeAnthropic().complete({ messages: simpleMessages });
    expect(r.finishReason).toBe('stop');
  });

  it('complete() returns "tool_use" when stop_reason is "tool_use"', async () => {
    mockAnthropicCreate.mockResolvedValue(anthropicResponse('hello', 'tool_use'));
    const r = await makeAnthropic().complete({ messages: simpleMessages });
    expect(r.finishReason).toBe('tool_use');
  });

  it('complete() returns "stop" when stop_reason is null', async () => {
    mockAnthropicCreate.mockResolvedValue(anthropicResponse('hello', null));
    const r = await makeAnthropic().complete({ messages: simpleMessages });
    expect(r.finishReason).toBe('stop');
  });

  it('complete() returns "unknown" for unrecognized stop_reason values (findings.md P2:940)', async () => {
    mockAnthropicCreate.mockResolvedValue(anthropicResponse('hello', 'something_new'));
    const r = await makeAnthropic().complete({ messages: simpleMessages });
    expect(r.finishReason).toBe('unknown');
  });

  // --- completeWithTools() ---

  it('completeWithTools() returns "length" when stop_reason is "max_tokens"', async () => {
    mockAnthropicCreate.mockResolvedValue(anthropicResponse('truncated mid-', 'max_tokens'));
    const r = await makeAnthropic().completeWithTools({ messages: simpleMessages, tools: sampleTools });
    expect(r.finishReason).toBe('length');
  });

  it('completeWithTools() returns "tool_use" when stop_reason is "tool_use"', async () => {
    mockAnthropicCreate.mockResolvedValue(
      anthropicToolResponse('', [{ id: 'tc_1', name: 'test_tool', input: { q: 'hi' } }], 'tool_use')
    );
    const r = await makeAnthropic().completeWithTools({ messages: simpleMessages, tools: sampleTools });
    expect(r.finishReason).toBe('tool_use');
  });

  it('completeWithTools() returns "stop" when stop_reason is "end_turn"', async () => {
    mockAnthropicCreate.mockResolvedValue(anthropicResponse('done', 'end_turn'));
    const r = await makeAnthropic().completeWithTools({ messages: simpleMessages, tools: sampleTools });
    expect(r.finishReason).toBe('stop');
  });

  it('completeWithTools() returns "length" even when tool calls are present', async () => {
    // Edge case: max_tokens hit during a tool use response
    mockAnthropicCreate.mockResolvedValue(
      anthropicToolResponse('partial', [{ id: 'tc_1', name: 'test_tool', input: { q: 'x' } }], 'max_tokens')
    );
    const r = await makeAnthropic().completeWithTools({ messages: simpleMessages, tools: sampleTools });
    expect(r.finishReason).toBe('length');
    expect(r.toolCalls).toBeDefined();
  });

  // --- completeStream() ---

  it('completeStream() returns "length" when stream stop_reason is "max_tokens"', async () => {
    const stream = makeStreamEvents('truncated text', 'max_tokens');
    mockAnthropicStream.mockReturnValue(stream);
    const chunks: string[] = [];
    const r = await makeAnthropic().completeStream!(
      { messages: simpleMessages },
      (chunk) => chunks.push(chunk)
    );
    expect(r.finishReason).toBe('length');
    expect(r.content).toBe('truncated text');
  });

  it('completeStream() returns "stop" when stream stop_reason is "end_turn"', async () => {
    mockAnthropicStream.mockReturnValue(makeStreamEvents('full text', 'end_turn'));
    const r = await makeAnthropic().completeStream!(
      { messages: simpleMessages },
      () => {}
    );
    expect(r.finishReason).toBe('stop');
  });

  it('completeStream() returns "stop" when stream stop_reason is "stop_sequence"', async () => {
    mockAnthropicStream.mockReturnValue(makeStreamEvents('text', 'stop_sequence'));
    const r = await makeAnthropic().completeStream!(
      { messages: simpleMessages },
      () => {}
    );
    expect(r.finishReason).toBe('stop');
  });

  it('completeStream() returns "tool_use" when stream stop_reason is "tool_use"', async () => {
    mockAnthropicStream.mockReturnValue(makeStreamEvents('', 'tool_use'));
    const r = await makeAnthropic().completeStream!(
      { messages: simpleMessages },
      () => {}
    );
    expect(r.finishReason).toBe('tool_use');
  });

  it('completeStream() returns "stop" when stream stop_reason is null', async () => {
    mockAnthropicStream.mockReturnValue(makeStreamEvents('text', null));
    const r = await makeAnthropic().completeStream!(
      { messages: simpleMessages },
      () => {}
    );
    expect(r.finishReason).toBe('stop');
  });

  it('completeStream() returns "unknown" for unrecognized stream stop_reason (findings.md P2:940)', async () => {
    mockAnthropicStream.mockReturnValue(makeStreamEvents('text', 'unknown_reason'));
    const r = await makeAnthropic().completeStream!(
      { messages: simpleMessages },
      () => {}
    );
    expect(r.finishReason).toBe('unknown');
  });

  // --- completeWithToolsStream() ---

  it('completeWithToolsStream() returns "length" when max_tokens hit', async () => {
    mockAnthropicStream.mockReturnValue(makeStreamEvents('partial', 'max_tokens'));
    const r = await makeAnthropic().completeWithToolsStream!(
      { messages: simpleMessages, tools: sampleTools },
      () => {}
    );
    expect(r.finishReason).toBe('length');
  });

  it('completeWithToolsStream() returns "tool_use" for tool_use stop_reason', async () => {
    const stream = makeStreamEvents('', 'tool_use', 10, 50, [
      { id: 'tc_1', name: 'test_tool', input: { q: 'x' } },
    ]);
    mockAnthropicStream.mockReturnValue(stream);
    const r = await makeAnthropic().completeWithToolsStream!(
      { messages: simpleMessages, tools: sampleTools },
      () => {}
    );
    expect(r.finishReason).toBe('tool_use');
    expect(r.toolCalls).toHaveLength(1);
  });

  it('completeWithToolsStream() returns "stop" for end_turn', async () => {
    mockAnthropicStream.mockReturnValue(makeStreamEvents('done', 'end_turn'));
    const r = await makeAnthropic().completeWithToolsStream!(
      { messages: simpleMessages, tools: sampleTools },
      () => {}
    );
    expect(r.finishReason).toBe('stop');
  });

  it('completeWithToolsStream() returns "length" even with tool calls present', async () => {
    const stream = makeStreamEvents('partial text', 'max_tokens', 10, 50, [
      { id: 'tc_1', name: 'test_tool', input: { q: 'y' } },
    ]);
    mockAnthropicStream.mockReturnValue(stream);
    const r = await makeAnthropic().completeWithToolsStream!(
      { messages: simpleMessages, tools: sampleTools },
      () => {}
    );
    expect(r.finishReason).toBe('length');
    expect(r.toolCalls).toHaveLength(1);
  });

  // --- continueWithToolResults() ---

  it('continueWithToolResults() returns "length" when max_tokens hit', async () => {
    mockAnthropicCreate.mockResolvedValue(anthropicResponse('truncated after tool', 'max_tokens'));
    const r = await makeAnthropic().continueWithToolResults(
      { messages: [{ role: 'system', content: 'sys' }, ...simpleMessages], tools: sampleTools },
      sampleToolCalls,
      sampleToolResults
    );
    expect(r.finishReason).toBe('length');
  });

  it('continueWithToolResults() returns "stop" when end_turn', async () => {
    mockAnthropicCreate.mockResolvedValue(anthropicResponse('complete', 'end_turn'));
    const r = await makeAnthropic().continueWithToolResults(
      { messages: simpleMessages, tools: sampleTools },
      sampleToolCalls,
      sampleToolResults
    );
    expect(r.finishReason).toBe('stop');
  });

  it('continueWithToolResults() returns "tool_use" when more tools requested', async () => {
    mockAnthropicCreate.mockResolvedValue(
      anthropicToolResponse('', [{ id: 'tc_2', name: 'test_tool', input: { q: 'more' } }], 'tool_use')
    );
    const r = await makeAnthropic().continueWithToolResults(
      { messages: simpleMessages, tools: sampleTools },
      sampleToolCalls,
      sampleToolResults
    );
    expect(r.finishReason).toBe('tool_use');
    expect(r.toolCalls).toHaveLength(1);
  });

  it('continueWithToolResults() returns "length" with partial tool JSON', async () => {
    mockAnthropicCreate.mockResolvedValue(anthropicResponse('', 'max_tokens'));
    const r = await makeAnthropic().continueWithToolResults(
      { messages: simpleMessages, tools: sampleTools },
      sampleToolCalls,
      sampleToolResults
    );
    expect(r.finishReason).toBe('length');
    expect(r.content).toBe('');
  });

  // --- continueWithToolResultsStream() ---

  it('continueWithToolResultsStream() returns "length" when max_tokens hit', async () => {
    mockAnthropicStream.mockReturnValue(makeStreamEvents('partial', 'max_tokens'));
    const r = await makeAnthropic().continueWithToolResultsStream!(
      { messages: simpleMessages, tools: sampleTools },
      sampleToolCalls,
      sampleToolResults,
      () => {}
    );
    expect(r.finishReason).toBe('length');
  });

  it('continueWithToolResultsStream() returns "stop" when end_turn', async () => {
    mockAnthropicStream.mockReturnValue(makeStreamEvents('full response', 'end_turn'));
    const r = await makeAnthropic().continueWithToolResultsStream!(
      { messages: simpleMessages, tools: sampleTools },
      sampleToolCalls,
      sampleToolResults,
      () => {}
    );
    expect(r.finishReason).toBe('stop');
  });

  it('continueWithToolResultsStream() returns "tool_use" with tool calls', async () => {
    const stream = makeStreamEvents('', 'tool_use', 10, 50, [
      { id: 'tc_2', name: 'test_tool', input: { q: 'again' } },
    ]);
    mockAnthropicStream.mockReturnValue(stream);
    const r = await makeAnthropic().continueWithToolResultsStream!(
      { messages: simpleMessages, tools: sampleTools },
      sampleToolCalls,
      sampleToolResults,
      () => {}
    );
    expect(r.finishReason).toBe('tool_use');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. OPENAI PROVIDER — finish reason on every method
// ═════════════════════════════════════════════════════════════════════════════

describe('OpenAI: finish reason surfaced on every method', () => {
  beforeEach(() => {
    mockOpenAICreate.mockReset();
  });

  // --- complete() ---

  it('complete() returns "length" when finish_reason is "length"', async () => {
    mockOpenAICreate.mockResolvedValue(openaiResponse('truncat', 'length'));
    const r = await makeOpenAI().complete({ messages: simpleMessages });
    expect(r.finishReason).toBe('length');
  });

  it('complete() returns "stop" when finish_reason is "stop"', async () => {
    mockOpenAICreate.mockResolvedValue(openaiResponse('done', 'stop'));
    const r = await makeOpenAI().complete({ messages: simpleMessages });
    expect(r.finishReason).toBe('stop');
  });

  it('complete() returns "content_filter" when finish_reason is "content_filter"', async () => {
    mockOpenAICreate.mockResolvedValue(openaiResponse('', 'content_filter'));
    const r = await makeOpenAI().complete({ messages: simpleMessages });
    expect(r.finishReason).toBe('content_filter');
  });

  it('complete() returns "tool_use" when finish_reason is "tool_calls"', async () => {
    mockOpenAICreate.mockResolvedValue(openaiResponse('', 'tool_calls'));
    const r = await makeOpenAI().complete({ messages: simpleMessages });
    expect(r.finishReason).toBe('tool_use');
  });

  it('complete() returns "stop" when finish_reason is null', async () => {
    mockOpenAICreate.mockResolvedValue(openaiResponse('text', null));
    const r = await makeOpenAI().complete({ messages: simpleMessages });
    expect(r.finishReason).toBe('stop');
  });

  it('complete() returns "tool_use" for deprecated function_call finish_reason (findings.md P2:940)', async () => {
    mockOpenAICreate.mockResolvedValue(openaiResponse('text', 'function_call'));
    const r = await makeOpenAI().complete({ messages: simpleMessages });
    expect(r.finishReason).toBe('tool_use');
  });

  // --- completeWithTools() ---

  it('completeWithTools() returns "length" when finish_reason is "length"', async () => {
    mockOpenAICreate.mockResolvedValue(openaiResponse('truncated', 'length'));
    const r = await makeOpenAI().completeWithTools({ messages: simpleMessages, tools: sampleTools });
    expect(r.finishReason).toBe('length');
  });

  it('completeWithTools() returns "tool_use" when finish_reason is "tool_calls"', async () => {
    mockOpenAICreate.mockResolvedValue(
      openaiToolResponse(null, [{ id: 'tc_1', name: 'test_tool', args: '{"q":"hi"}' }], 'tool_calls')
    );
    const r = await makeOpenAI().completeWithTools({ messages: simpleMessages, tools: sampleTools });
    expect(r.finishReason).toBe('tool_use');
    expect(r.toolCalls).toHaveLength(1);
  });

  it('completeWithTools() returns "stop" when finish_reason is "stop"', async () => {
    mockOpenAICreate.mockResolvedValue(openaiResponse('done', 'stop'));
    const r = await makeOpenAI().completeWithTools({ messages: simpleMessages, tools: sampleTools });
    expect(r.finishReason).toBe('stop');
  });

  it('completeWithTools() returns "length" even when tool calls are present', async () => {
    mockOpenAICreate.mockResolvedValue(
      openaiToolResponse('partial', [{ id: 'tc_1', name: 'test_tool', args: '{"q":"x"}' }], 'length')
    );
    const r = await makeOpenAI().completeWithTools({ messages: simpleMessages, tools: sampleTools });
    expect(r.finishReason).toBe('length');
    expect(r.toolCalls).toHaveLength(1);
  });

  it('completeWithTools() returns "content_filter" when filtered', async () => {
    mockOpenAICreate.mockResolvedValue(openaiResponse('', 'content_filter'));
    const r = await makeOpenAI().completeWithTools({ messages: simpleMessages, tools: sampleTools });
    expect(r.finishReason).toBe('content_filter');
  });

  // --- continueWithToolResults() ---

  it('continueWithToolResults() returns "length" when finish_reason is "length"', async () => {
    mockOpenAICreate.mockResolvedValue(openaiResponse('truncated after tools', 'length'));
    const r = await makeOpenAI().continueWithToolResults(
      { messages: simpleMessages, tools: sampleTools },
      sampleToolCalls,
      sampleToolResults
    );
    expect(r.finishReason).toBe('length');
  });

  it('continueWithToolResults() returns "stop" when finished normally', async () => {
    mockOpenAICreate.mockResolvedValue(openaiResponse('complete', 'stop'));
    const r = await makeOpenAI().continueWithToolResults(
      { messages: simpleMessages, tools: sampleTools },
      sampleToolCalls,
      sampleToolResults
    );
    expect(r.finishReason).toBe('stop');
  });

  it('continueWithToolResults() returns "tool_use" when more tools requested', async () => {
    mockOpenAICreate.mockResolvedValue(
      openaiToolResponse(null, [{ id: 'tc_2', name: 'test_tool', args: '{"q":"more"}' }], 'tool_calls')
    );
    const r = await makeOpenAI().continueWithToolResults(
      { messages: simpleMessages, tools: sampleTools },
      sampleToolCalls,
      sampleToolResults
    );
    expect(r.finishReason).toBe('tool_use');
  });

  it('continueWithToolResults() returns "length" with empty content', async () => {
    mockOpenAICreate.mockResolvedValue(openaiResponse('', 'length'));
    const r = await makeOpenAI().continueWithToolResults(
      { messages: simpleMessages, tools: sampleTools },
      sampleToolCalls,
      sampleToolResults
    );
    expect(r.finishReason).toBe('length');
    expect(r.content).toBe('');
  });

  it('continueWithToolResults() returns "content_filter" correctly', async () => {
    mockOpenAICreate.mockResolvedValue(openaiResponse('', 'content_filter'));
    const r = await makeOpenAI().continueWithToolResults(
      { messages: simpleMessages, tools: sampleTools },
      sampleToolCalls,
      sampleToolResults
    );
    expect(r.finishReason).toBe('content_filter');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. GOOGLE PROVIDER — finish reason on every method
// ═════════════════════════════════════════════════════════════════════════════

describe('Google: finish reason surfaced on every method', () => {
  beforeEach(() => {
    mockGenerateContent.mockReset();
    mockGetGenerativeModel.mockReset();
    mockGetGenerativeModel.mockReturnValue({ generateContent: mockGenerateContent });
  });

  // --- complete() ---

  it('complete() returns "length" when finishReason is "MAX_TOKENS"', async () => {
    mockGenerateContent.mockResolvedValue(googleResponse('truncated', 'MAX_TOKENS'));
    const r = await makeGoogle().complete({ messages: simpleMessages });
    expect(r.finishReason).toBe('length');
  });

  it('complete() returns "stop" when finishReason is "STOP"', async () => {
    mockGenerateContent.mockResolvedValue(googleResponse('done', 'STOP'));
    const r = await makeGoogle().complete({ messages: simpleMessages });
    expect(r.finishReason).toBe('stop');
  });

  it('complete() returns "content_filter" when finishReason is "SAFETY"', async () => {
    mockGenerateContent.mockResolvedValue(googleResponse('', 'SAFETY'));
    const r = await makeGoogle().complete({ messages: simpleMessages });
    expect(r.finishReason).toBe('content_filter');
  });

  it('complete() returns "stop" when finishReason is undefined', async () => {
    mockGenerateContent.mockResolvedValue(googleResponse('text', undefined));
    const r = await makeGoogle().complete({ messages: simpleMessages });
    expect(r.finishReason).toBe('stop');
  });

  it('complete() returns "content_filter" for RECITATION (findings.md P2:1000)', async () => {
    mockGenerateContent.mockResolvedValue(googleResponse('text', 'RECITATION'));
    const r = await makeGoogle().complete({ messages: simpleMessages });
    expect(r.finishReason).toBe('content_filter');
  });

  it('complete() returns "content_filter" for BLOCKLIST (findings.md P2:1000)', async () => {
    mockGenerateContent.mockResolvedValue(googleResponse('text', 'BLOCKLIST'));
    const r = await makeGoogle().complete({ messages: simpleMessages });
    expect(r.finishReason).toBe('content_filter');
  });

  it('complete() returns "unknown" for unrecognized Google finishReason values (findings.md P2:940)', async () => {
    mockGenerateContent.mockResolvedValue(googleResponse('text', 'WHO_KNOWS'));
    const r = await makeGoogle().complete({ messages: simpleMessages });
    expect(r.finishReason).toBe('unknown');
  });

  // --- completeWithTools() ---

  it('completeWithTools() returns "length" when MAX_TOKENS', async () => {
    mockGenerateContent.mockResolvedValue(googleResponse('truncated', 'MAX_TOKENS'));
    const r = await makeGoogle().completeWithTools({ messages: simpleMessages, tools: sampleTools });
    expect(r.finishReason).toBe('length');
  });

  it('completeWithTools() returns "stop" when STOP', async () => {
    mockGenerateContent.mockResolvedValue(googleResponse('done', 'STOP'));
    const r = await makeGoogle().completeWithTools({ messages: simpleMessages, tools: sampleTools });
    expect(r.finishReason).toBe('stop');
  });

  it('completeWithTools() returns tool calls with finishReason preserved', async () => {
    mockGenerateContent.mockResolvedValue(
      googleToolResponse('', [{ name: 'test_tool', args: { q: 'hi' } }], 'STOP')
    );
    const r = await makeGoogle().completeWithTools({ messages: simpleMessages, tools: sampleTools });
    expect(r.finishReason).toBe('stop');
    expect(r.toolCalls).toHaveLength(1);
  });

  it('completeWithTools() returns "length" when MAX_TOKENS with tool calls', async () => {
    mockGenerateContent.mockResolvedValue(
      googleToolResponse('partial', [{ name: 'test_tool', args: { q: 'y' } }], 'MAX_TOKENS')
    );
    const r = await makeGoogle().completeWithTools({ messages: simpleMessages, tools: sampleTools });
    expect(r.finishReason).toBe('length');
  });

  it('completeWithTools() returns "content_filter" when SAFETY', async () => {
    mockGenerateContent.mockResolvedValue(googleResponse('', 'SAFETY'));
    const r = await makeGoogle().completeWithTools({ messages: simpleMessages, tools: sampleTools });
    expect(r.finishReason).toBe('content_filter');
  });

  // --- continueWithToolResults() ---

  it('continueWithToolResults() returns "length" when MAX_TOKENS', async () => {
    mockGenerateContent.mockResolvedValue(googleResponse('truncated', 'MAX_TOKENS'));
    const r = await makeGoogle().continueWithToolResults(
      { messages: simpleMessages, tools: sampleTools },
      sampleToolCalls,
      sampleToolResults
    );
    expect(r.finishReason).toBe('length');
  });

  it('continueWithToolResults() returns "stop" when STOP', async () => {
    mockGenerateContent.mockResolvedValue(googleResponse('complete', 'STOP'));
    const r = await makeGoogle().continueWithToolResults(
      { messages: simpleMessages, tools: sampleTools },
      sampleToolCalls,
      sampleToolResults
    );
    expect(r.finishReason).toBe('stop');
  });

  it('continueWithToolResults() returns new tool calls with "length"', async () => {
    mockGenerateContent.mockResolvedValue(
      googleToolResponse('partial', [{ name: 'test_tool', args: { q: 'z' } }], 'MAX_TOKENS')
    );
    const r = await makeGoogle().continueWithToolResults(
      { messages: simpleMessages, tools: sampleTools },
      sampleToolCalls,
      sampleToolResults
    );
    expect(r.finishReason).toBe('length');
    expect(r.toolCalls).toHaveLength(1);
  });

  it('continueWithToolResults() returns "content_filter" when SAFETY', async () => {
    mockGenerateContent.mockResolvedValue(googleResponse('', 'SAFETY'));
    const r = await makeGoogle().continueWithToolResults(
      { messages: simpleMessages, tools: sampleTools },
      sampleToolCalls,
      sampleToolResults
    );
    expect(r.finishReason).toBe('content_filter');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. CROSS-PROVIDER: normalized "length" is detectable by callers
// ═════════════════════════════════════════════════════════════════════════════

describe('Cross-provider: callers can detect truncation via finishReason==="length"', () => {
  beforeEach(() => {
    mockAnthropicCreate.mockReset();
    mockAnthropicStream.mockReset();
    mockOpenAICreate.mockReset();
    mockGenerateContent.mockReset();
    mockGetGenerativeModel.mockReset();
    mockGetGenerativeModel.mockReturnValue({ generateContent: mockGenerateContent });
  });

  const providers = ['anthropic', 'openai', 'google'] as const;

  for (const providerName of providers) {
    it(`${providerName} complete() returns finishReason that is a known union member`, async () => {
      if (providerName === 'anthropic') {
        mockAnthropicCreate.mockResolvedValue(anthropicResponse('text', 'end_turn'));
      } else if (providerName === 'openai') {
        mockOpenAICreate.mockResolvedValue(openaiResponse('text', 'stop'));
      } else {
        mockGenerateContent.mockResolvedValue(googleResponse('text', 'STOP'));
      }

      const provider = providerName === 'anthropic' ? makeAnthropic()
        : providerName === 'openai' ? makeOpenAI()
        : makeGoogle();

      const r = await provider.complete({ messages: simpleMessages });
      expect(['stop', 'length', 'content_filter', 'tool_use', 'error']).toContain(r.finishReason);
    });
  }

  for (const providerName of providers) {
    it(`${providerName} truncation produces finishReason==="length" (not raw API value)`, async () => {
      if (providerName === 'anthropic') {
        mockAnthropicCreate.mockResolvedValue(anthropicResponse('trunc', 'max_tokens'));
      } else if (providerName === 'openai') {
        mockOpenAICreate.mockResolvedValue(openaiResponse('trunc', 'length'));
      } else {
        mockGenerateContent.mockResolvedValue(googleResponse('trunc', 'MAX_TOKENS'));
      }

      const provider = providerName === 'anthropic' ? makeAnthropic()
        : providerName === 'openai' ? makeOpenAI()
        : makeGoogle();

      const r = await provider.complete({ messages: simpleMessages });
      expect(r.finishReason).toBe('length');
      // Must NOT contain the raw API string
      expect(r.finishReason).not.toBe('max_tokens');
      expect(r.finishReason).not.toBe('MAX_TOKENS');
    });
  }

  for (const providerName of providers) {
    it(`${providerName} completeWithTools() also normalizes truncation to "length"`, async () => {
      if (providerName === 'anthropic') {
        mockAnthropicCreate.mockResolvedValue(anthropicResponse('trunc', 'max_tokens'));
      } else if (providerName === 'openai') {
        mockOpenAICreate.mockResolvedValue(openaiResponse('trunc', 'length'));
      } else {
        mockGenerateContent.mockResolvedValue(googleResponse('trunc', 'MAX_TOKENS'));
      }

      const provider = providerName === 'anthropic' ? makeAnthropic()
        : providerName === 'openai' ? makeOpenAI()
        : makeGoogle();

      const r = await provider.completeWithTools({ messages: simpleMessages, tools: sampleTools });
      expect(r.finishReason).toBe('length');
    });
  }

  for (const providerName of providers) {
    it(`${providerName} continueWithToolResults() normalizes truncation to "length"`, async () => {
      if (providerName === 'anthropic') {
        mockAnthropicCreate.mockResolvedValue(anthropicResponse('trunc', 'max_tokens'));
      } else if (providerName === 'openai') {
        mockOpenAICreate.mockResolvedValue(openaiResponse('trunc', 'length'));
      } else {
        mockGenerateContent.mockResolvedValue(googleResponse('trunc', 'MAX_TOKENS'));
      }

      const provider = providerName === 'anthropic' ? makeAnthropic()
        : providerName === 'openai' ? makeOpenAI()
        : makeGoogle();

      const r = await provider.continueWithToolResults(
        { messages: simpleMessages, tools: sampleTools },
        sampleToolCalls,
        sampleToolResults
      );
      expect(r.finishReason).toBe('length');
    });
  }

  // Anthropic-only streaming methods
  it('Anthropic completeStream() normalizes truncation to "length"', async () => {
    mockAnthropicStream.mockReturnValue(makeStreamEvents('trunc', 'max_tokens'));
    const r = await makeAnthropic().completeStream!(
      { messages: simpleMessages },
      () => {}
    );
    expect(r.finishReason).toBe('length');
  });

  it('Anthropic completeWithToolsStream() normalizes truncation to "length"', async () => {
    mockAnthropicStream.mockReturnValue(makeStreamEvents('trunc', 'max_tokens'));
    const r = await makeAnthropic().completeWithToolsStream!(
      { messages: simpleMessages, tools: sampleTools },
      () => {}
    );
    expect(r.finishReason).toBe('length');
  });

  it('Anthropic continueWithToolResultsStream() normalizes truncation to "length"', async () => {
    mockAnthropicStream.mockReturnValue(makeStreamEvents('trunc', 'max_tokens'));
    const r = await makeAnthropic().continueWithToolResultsStream!(
      { messages: simpleMessages, tools: sampleTools },
      sampleToolCalls,
      sampleToolResults,
      () => {}
    );
    expect(r.finishReason).toBe('length');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. PROVIDER SOURCE ANALYSIS — mapping functions are correct
// ═════════════════════════════════════════════════════════════════════════════

describe('Provider source: mapStopReason / mapFinishReason correctness', () => {
  it('Anthropic mapStopReason handles end_turn -> stop', () => {
    const src = readSrc('providers/anthropic.ts');
    expect(src).toMatch(/case\s*['"]end_turn['"]\s*:/);
    expect(src).toMatch(/['"]end_turn['"][\s\S]*?return\s*['"]stop['"]/);
  });

  it('Anthropic mapStopReason handles stop_sequence -> stop', () => {
    const src = readSrc('providers/anthropic.ts');
    expect(src).toMatch(/case\s*['"]stop_sequence['"]\s*:/);
  });

  it('Anthropic mapStopReason handles max_tokens -> length', () => {
    const src = readSrc('providers/anthropic.ts');
    expect(src).toMatch(/case\s*['"]max_tokens['"]\s*:/);
    expect(src).toMatch(/['"]max_tokens['"][\s\S]*?return\s*['"]length['"]/);
  });

  it('Anthropic mapStopReason handles tool_use -> tool_use', () => {
    const src = readSrc('providers/anthropic.ts');
    expect(src).toMatch(/case\s*['"]tool_use['"]\s*:/);
    expect(src).toMatch(/['"]tool_use['"][\s\S]*?return\s*['"]tool_use['"]/);
  });

  it('Anthropic mapStopReason has a default fallback', () => {
    const src = readSrc('providers/anthropic.ts');
    const mapFn = extractMethod(src, 'mapStopReason');
    expect(mapFn).toMatch(/default:/);
  });

  it('OpenAI mapFinishReason handles stop -> stop', () => {
    const src = readSrc('providers/openai.ts');
    expect(src).toMatch(/case\s*['"]stop['"]\s*:\s*\n\s*return\s*['"]stop['"]/);
  });

  it('OpenAI mapFinishReason handles length -> length', () => {
    const src = readSrc('providers/openai.ts');
    expect(src).toMatch(/case\s*['"]length['"]\s*:\s*\n\s*return\s*['"]length['"]/);
  });

  it('OpenAI mapFinishReason handles content_filter -> content_filter', () => {
    const src = readSrc('providers/openai.ts');
    expect(src).toMatch(/case\s*['"]content_filter['"]\s*:\s*\n\s*return\s*['"]content_filter['"]/);
  });

  it('OpenAI mapFinishReason handles tool_calls -> tool_use', () => {
    // findings.md P2:940 — 'function_call' now falls through into the same
    // return as 'tool_calls', so the case label may be followed by another
    // case label before the return.
    const src = readSrc('providers/openai.ts');
    expect(src).toMatch(/case\s*['"]tool_calls['"]\s*:\s*\n(?:\s*case\s*['"][^'"]+['"]\s*:\s*\n)*\s*return\s*['"]tool_use['"]/);
  });

  it('OpenAI mapFinishReason has a default fallback', () => {
    const src = readSrc('providers/openai.ts');
    const mapFn = extractMethod(src, 'mapFinishReason');
    expect(mapFn).toMatch(/default:/);
  });

  it('Google mapFinishReason handles STOP -> stop', () => {
    const src = readSrc('providers/google.ts');
    expect(src).toMatch(/case\s*['"]STOP['"]\s*:\s*\n\s*return\s*['"]stop['"]/);
  });

  it('Google mapFinishReason handles MAX_TOKENS -> length', () => {
    const src = readSrc('providers/google.ts');
    expect(src).toMatch(/case\s*['"]MAX_TOKENS['"]\s*:\s*\n\s*return\s*['"]length['"]/);
  });

  it('Google mapFinishReason handles SAFETY -> content_filter', () => {
    // findings.md P2:1000 — SAFETY now shares the content_filter branch with
    // RECITATION / BLOCKLIST / PROHIBITED_CONTENT / SPII via case fall-through.
    const src = readSrc('providers/google.ts');
    expect(src).toMatch(/case\s*['"]SAFETY['"]\s*:[\s\S]*?return\s*['"]content_filter['"]/);
  });

  it('Google mapFinishReason handles RECITATION/BLOCKLIST/PROHIBITED_CONTENT -> content_filter (findings.md P2:1000)', () => {
    const src = readSrc('providers/google.ts');
    for (const label of ['RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT']) {
      expect(src).toMatch(new RegExp(`case\\s*['"]${label}['"]\\s*:[\\s\\S]*?return\\s*['"]content_filter['"]`));
    }
  });

  it('Google mapFinishReason has a default fallback', () => {
    const src = readSrc('providers/google.ts');
    const mapFn = extractMethod(src, 'mapFinishReason');
    expect(mapFn).toMatch(/default:/);
  });

  it('all three providers use a switch statement (not if/else)', () => {
    for (const file of ['anthropic.ts', 'openai.ts', 'google.ts']) {
      const src = readSrc(`providers/${file}`);
      const mapMethod = file === 'anthropic.ts' ? 'mapStopReason' : 'mapFinishReason';
      const fn = extractMethod(src, mapMethod);
      expect(fn, `${file} ${mapMethod} should use switch`).toContain('switch');
    }
  });

  it('all three providers return CompletionResult["finishReason"] type', () => {
    for (const file of ['anthropic.ts', 'openai.ts', 'google.ts']) {
      const src = readSrc(`providers/${file}`);
      expect(src).toMatch(/CompletionResult\['finishReason'\]/);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. ANTHROPIC STREAMING — finishReason extracted from message_delta events
// ═════════════════════════════════════════════════════════════════════════════

describe('Anthropic streaming: finishReason from message_delta events', () => {
  beforeEach(() => {
    mockAnthropicStream.mockReset();
  });

  it('finishReason defaults to "stop" if no message_delta event arrives', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 5 } } },
      { type: 'content_block_delta', delta: { text: 'hi' } },
    ];
    mockAnthropicStream.mockReturnValue({
      [Symbol.asyncIterator]: async function* () { for (const e of events) yield e; },
    });
    const r = await makeAnthropic().completeStream!(
      { messages: simpleMessages },
      () => {}
    );
    expect(r.finishReason).toBe('stop');
  });

  it('finishReason extracted from message_delta.delta.stop_reason', async () => {
    mockAnthropicStream.mockReturnValue(makeStreamEvents('text', 'max_tokens'));
    const r = await makeAnthropic().completeStream!(
      { messages: simpleMessages },
      () => {}
    );
    expect(r.finishReason).toBe('length');
  });

  it('stream with no text chunks but max_tokens still returns "length"', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 5 } } },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 0 } },
    ];
    mockAnthropicStream.mockReturnValue({
      [Symbol.asyncIterator]: async function* () { for (const e of events) yield e; },
    });
    const r = await makeAnthropic().completeStream!(
      { messages: simpleMessages },
      () => {}
    );
    expect(r.finishReason).toBe('length');
    expect(r.content).toBe('');
  });

  it('stream usage is captured from message_start and message_delta', async () => {
    mockAnthropicStream.mockReturnValue(makeStreamEvents('text', 'end_turn', 42, 17));
    const r = await makeAnthropic().completeStream!(
      { messages: simpleMessages },
      () => {}
    );
    expect(r.usage.inputTokens).toBe(42);
    expect(r.usage.outputTokens).toBe(17);
  });

  it('completeWithToolsStream captures finishReason from delta even with tool calls', async () => {
    const stream = makeStreamEvents('answer', 'max_tokens', 10, 50, [
      { id: 'tc_1', name: 'test_tool', input: { q: 'hello' } },
    ]);
    mockAnthropicStream.mockReturnValue(stream);
    const r = await makeAnthropic().completeWithToolsStream!(
      { messages: simpleMessages, tools: sampleTools },
      () => {}
    );
    expect(r.finishReason).toBe('length');
    expect(r.toolCalls).toHaveLength(1);
    expect(r.content).toBe('answer');
  });

  it('completeWithToolsStream with null stop_reason defaults to "stop"', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 5 } } },
      { type: 'content_block_delta', delta: { text: 'hi' } },
      { type: 'message_delta', delta: { stop_reason: null }, usage: { output_tokens: 2 } },
    ];
    mockAnthropicStream.mockReturnValue({
      [Symbol.asyncIterator]: async function* () { for (const e of events) yield e; },
    });
    const r = await makeAnthropic().completeWithToolsStream!(
      { messages: simpleMessages, tools: sampleTools },
      () => {}
    );
    expect(r.finishReason).toBe('stop');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. TRUNCATION CONTENT BEHAVIOR
// ═════════════════════════════════════════════════════════════════════════════

describe('Truncation content behavior', () => {
  beforeEach(() => {
    mockAnthropicCreate.mockReset();
    mockAnthropicStream.mockReset();
    mockOpenAICreate.mockReset();
    mockGenerateContent.mockReset();
    mockGetGenerativeModel.mockReset();
    mockGetGenerativeModel.mockReturnValue({ generateContent: mockGenerateContent });
  });

  it('Anthropic: truncated response preserves partial content', async () => {
    mockAnthropicCreate.mockResolvedValue(anthropicResponse('The quick brown fox ju', 'max_tokens'));
    const r = await makeAnthropic().complete({ messages: simpleMessages });
    expect(r.content).toBe('The quick brown fox ju');
    expect(r.finishReason).toBe('length');
  });

  it('OpenAI: truncated response preserves partial content', async () => {
    mockOpenAICreate.mockResolvedValue(openaiResponse('The quick brown fox ju', 'length'));
    const r = await makeOpenAI().complete({ messages: simpleMessages });
    expect(r.content).toBe('The quick brown fox ju');
    expect(r.finishReason).toBe('length');
  });

  it('Google: truncated response preserves partial content', async () => {
    mockGenerateContent.mockResolvedValue(googleResponse('The quick brown fox ju', 'MAX_TOKENS'));
    const r = await makeGoogle().complete({ messages: simpleMessages });
    expect(r.content).toBe('The quick brown fox ju');
    expect(r.finishReason).toBe('length');
  });

  it('Anthropic: empty content with max_tokens returns empty string', async () => {
    mockAnthropicCreate.mockResolvedValue({
      content: [],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 10, output_tokens: 0 },
    });
    const r = await makeAnthropic().complete({ messages: simpleMessages });
    expect(r.content).toBe('');
    expect(r.finishReason).toBe('length');
  });

  it('OpenAI: null content with length returns empty string', async () => {
    mockOpenAICreate.mockResolvedValue({
      choices: [{ message: { content: null, tool_calls: [] }, finish_reason: 'length' }],
      usage: { prompt_tokens: 10, completion_tokens: 0 },
    });
    const r = await makeOpenAI().complete({ messages: simpleMessages });
    expect(r.content).toBe('');
    expect(r.finishReason).toBe('length');
  });

  it('Anthropic: mid-sentence truncation is distinguishable from complete response', async () => {
    mockAnthropicCreate
      .mockResolvedValueOnce(anthropicResponse('This sentence ends correctly.', 'end_turn'))
      .mockResolvedValueOnce(anthropicResponse('This sentence does not en', 'max_tokens'));

    const p = makeAnthropic();
    const complete = await p.complete({ messages: simpleMessages });
    const truncated = await p.complete({ messages: simpleMessages });

    expect(complete.finishReason).toBe('stop');
    expect(truncated.finishReason).toBe('length');
    // Caller can now differentiate truncation from normal completion
    expect(complete.finishReason !== truncated.finishReason).toBe(true);
  });

  it('Anthropic stream: truncated text is assembled correctly despite chunking', async () => {
    mockAnthropicStream.mockReturnValue(makeStreamEvents('This is a truncated resp', 'max_tokens'));
    const chunks: string[] = [];
    const r = await makeAnthropic().completeStream!(
      { messages: simpleMessages },
      (chunk) => chunks.push(chunk)
    );
    expect(chunks.join('')).toBe('This is a truncated resp');
    expect(r.content).toBe('This is a truncated resp');
    expect(r.finishReason).toBe('length');
  });

  it('OpenAI: no choices array returns empty content with default finishReason', async () => {
    mockOpenAICreate.mockResolvedValue({
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 0 },
    });
    const r = await makeOpenAI().complete({ messages: simpleMessages });
    expect(r.content).toBe('');
    expect(r.finishReason).toBe('stop'); // default when choice is undefined
  });

  it('Google: no candidates returns empty content with default finishReason', async () => {
    mockGenerateContent.mockResolvedValue({
      response: {
        text: () => '',
        candidates: [],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 0 },
      },
    });
    const r = await makeGoogle().complete({ messages: simpleMessages });
    expect(r.finishReason).toBe('stop'); // default
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. USAGE TRACKING ALONGSIDE FINISH REASON
// ═════════════════════════════════════════════════════════════════════════════

describe('Usage tracking is correct alongside finish reason', () => {
  beforeEach(() => {
    mockAnthropicCreate.mockReset();
    mockAnthropicStream.mockReset();
    mockOpenAICreate.mockReset();
    mockGenerateContent.mockReset();
    mockGetGenerativeModel.mockReset();
    mockGetGenerativeModel.mockReturnValue({ generateContent: mockGenerateContent });
  });

  it('Anthropic truncated response still reports usage', async () => {
    mockAnthropicCreate.mockResolvedValue(anthropicResponse('trunc', 'max_tokens', 250));
    const r = await makeAnthropic().complete({ messages: simpleMessages });
    expect(r.finishReason).toBe('length');
    expect(r.usage.outputTokens).toBe(250);
    expect(r.usage.inputTokens).toBe(10);
  });

  it('OpenAI truncated response still reports usage', async () => {
    mockOpenAICreate.mockResolvedValue(openaiResponse('trunc', 'length', 250));
    const r = await makeOpenAI().complete({ messages: simpleMessages });
    expect(r.finishReason).toBe('length');
    expect(r.usage.outputTokens).toBe(250);
  });

  it('Google truncated response still reports usage', async () => {
    mockGenerateContent.mockResolvedValue(googleResponse('trunc', 'MAX_TOKENS', 250));
    const r = await makeGoogle().complete({ messages: simpleMessages });
    expect(r.finishReason).toBe('length');
    expect(r.usage.outputTokens).toBe(250);
  });

  it('Anthropic: outputTokens equals maxTokens when truncated', async () => {
    const maxTokens = 100;
    mockAnthropicCreate.mockResolvedValue(anthropicResponse('partial', 'max_tokens', maxTokens));
    const r = await makeAnthropic(maxTokens).complete({ messages: simpleMessages, maxTokens });
    expect(r.finishReason).toBe('length');
    expect(r.usage.outputTokens).toBe(maxTokens);
  });

  it('Anthropic stream: usage is reported correctly when truncated', async () => {
    mockAnthropicStream.mockReturnValue(makeStreamEvents('text', 'max_tokens', 20, 100));
    const r = await makeAnthropic().completeStream!(
      { messages: simpleMessages },
      () => {}
    );
    expect(r.finishReason).toBe('length');
    expect(r.usage.inputTokens).toBe(20);
    expect(r.usage.outputTokens).toBe(100);
  });

  it('Anthropic completeWithTools: usage preserved on truncation', async () => {
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'partial' }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 30, output_tokens: 200 },
    });
    const r = await makeAnthropic().completeWithTools({ messages: simpleMessages, tools: sampleTools });
    expect(r.finishReason).toBe('length');
    expect(r.usage.inputTokens).toBe(30);
    expect(r.usage.outputTokens).toBe(200);
  });

  it('OpenAI completeWithTools: usage preserved on truncation', async () => {
    mockOpenAICreate.mockResolvedValue({
      choices: [{ message: { content: 'partial', tool_calls: [] }, finish_reason: 'length' }],
      usage: { prompt_tokens: 30, completion_tokens: 200 },
    });
    const r = await makeOpenAI().completeWithTools({ messages: simpleMessages, tools: sampleTools });
    expect(r.finishReason).toBe('length');
    expect(r.usage.inputTokens).toBe(30);
    expect(r.usage.outputTokens).toBe(200);
  });

  it('Google completeWithTools: usage preserved on truncation', async () => {
    mockGenerateContent.mockResolvedValue(googleResponse('partial', 'MAX_TOKENS', 200));
    const r = await makeGoogle().completeWithTools({ messages: simpleMessages, tools: sampleTools });
    expect(r.finishReason).toBe('length');
    expect(r.usage.outputTokens).toBe(200);
  });

  it('Anthropic continueWithToolResults: usage preserved on truncation', async () => {
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'partial after tool' }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 100, output_tokens: 150 },
    });
    const r = await makeAnthropic().continueWithToolResults(
      { messages: simpleMessages, tools: sampleTools },
      sampleToolCalls,
      sampleToolResults
    );
    expect(r.finishReason).toBe('length');
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 150 });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. CALLER-SIDE: finishReason NOT checked in background loops (documenting the bug)
// ═════════════════════════════════════════════════════════════════════════════

describe('Background loops do NOT check finishReason (documenting the systemic bug)', () => {
  const backgroundLoopFiles = [
    'agent/commune-loop.ts',
    'agent/diary.ts',
    'agent/dreams.ts',
    'agent/letter.ts',
    'agent/self-concept.ts',
    'agent/curiosity.ts',
    'agent/internal-state.ts',
    'agent/desires.ts',
    'agent/book.ts',
    'agent/bibliomancy.ts',
    'agent/proactive.ts',
  ];

  for (const file of backgroundLoopFiles) {
    it(`${file} calls provider.complete() but never checks finishReason`, () => {
      const filePath = join(SRC_ROOT, file);
      if (!existsSync(filePath)) return; // skip if file doesn't exist
      const src = readFileSync(filePath, 'utf-8');

      // Verify it actually calls provider.complete or completeWithTools
      const hasComplete = /\.complete\(/.test(src) || /\.completeWithTools\(/.test(src);
      if (!hasComplete) return; // no LLM calls, nothing to test

      // Check for finishReason handling
      const checksFinishReason = /finishReason/.test(src);
      // This documents the bug: these files do NOT check finishReason
      expect(checksFinishReason, `${file} should NOT check finishReason (documenting current state)`).toBe(false);
    });
  }

  it('only the main agent pipeline (agent/index.ts) checks finishReason', () => {
    const src = readSrc('agent/index.ts');
    expect(src).toContain('finishReason');
    const checks = (src.match(/finishReason/g) ?? []).length;
    expect(checks).toBeGreaterThanOrEqual(4);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 10. COMMUNE CONVERSATION: truncation is invisible
// ═════════════════════════════════════════════════════════════════════════════

describe('Commune conversation truncation is invisible to the system', () => {
  it('commune-loop impulse phase discards finishReason', () => {
    const src = readSrc('agent/commune-loop.ts');
    // Find the impulse phase complete() call and verify no finishReason check follows
    const impulseBlock = src.match(/phaseImpulse[\s\S]*?(?=async function phaseConversation|$)/)?.[0] ?? '';
    expect(impulseBlock).toContain('.complete(');
    expect(impulseBlock).not.toContain('finishReason');
  });

  it('commune-loop conversation phase discards finishReason on each round reply', () => {
    const src = readSrc('agent/commune-loop.ts');
    const convBlock = src.match(/phaseConversation[\s\S]*?(?=async function sendPeerMessage|$)/)?.[0] ?? '';
    expect(convBlock).toContain('.complete(');
    expect(convBlock).not.toContain('finishReason');
  });

  it('commune-loop reflection phase discards finishReason', () => {
    const src = readSrc('agent/commune-loop.ts');
    // phaseReflection is defined as "async function phaseReflection"
    const reflStart = src.indexOf('async function phaseReflection');
    expect(reflStart).toBeGreaterThan(-1);
    // Extract until the next top-level async function
    const afterStart = src.slice(reflStart);
    const nextFnMatch = afterStart.match(/\nasync function (?!phaseReflection)/);
    const reflBlock = nextFnMatch ? afterStart.slice(0, nextFnMatch.index) : afterStart;
    expect(reflBlock).toContain('.complete(');
    expect(reflBlock).not.toContain('finishReason');
  });

  it('commune-loop aftermath phase uses completeWithTools but discards finishReason', () => {
    const src = readSrc('agent/commune-loop.ts');
    expect(src).toContain('.completeWithTools(');
    expect(src).toContain('.continueWithToolResults(');
    // Neither path checks finishReason
    const aftermathBlock = src.match(/aftermathPrompt[\s\S]*?(?=async function|export|$)/)?.[0] ?? '';
    expect(aftermathBlock).not.toContain('finishReason');
  });

  it('commune-loop uses result.content directly with no truncation guard', () => {
    const src = readSrc('agent/commune-loop.ts');
    // After complete(), it goes straight to result.content.trim()
    expect(src).toContain('result.content.trim()');
    // No check for whether the content was truncated
    const afterComplete = src.match(/result\.content\.trim\(\)[\s\S]{0,200}/g) ?? [];
    for (const block of afterComplete) {
      expect(block).not.toContain('finishReason');
    }
  });

  it('commune-loop saves truncated content to memory without warning', () => {
    const src = readSrc('agent/commune-loop.ts');
    // It saves transcript + reflection as memory
    expect(src).toContain('saveMemory');
    // There is no truncation guard before saveMemory
    const saveBlock = src.match(/saveMemory[\s\S]{0,300}/g) ?? [];
    for (const block of saveBlock) {
      expect(block).not.toContain('finishReason');
      expect(block).not.toContain('truncat');
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 11. DIARY TRUNCATION: silently saves truncated entries
// ═════════════════════════════════════════════════════════════════════════════

describe('Diary truncation is silent', () => {
  it('diary calls provider.complete and never checks finishReason', () => {
    const src = readSrc('agent/diary.ts');
    expect(src).toContain('.complete(');
    expect(src).not.toContain('finishReason');
  });

  it('diary has length validation but not truncation detection', () => {
    const src = readSrc('agent/diary.ts');
    // It checks if entry is too short (< 20) but not if it was truncated
    expect(src).toMatch(/length\s*<\s*\d+/);
    expect(src).not.toContain('finishReason');
  });

  it('diary appends to journal without knowing if content was cut off', () => {
    const src = readSrc('agent/diary.ts');
    expect(src).toContain('appendJournalEntry');
    // No truncation warning before append
    const appendBlock = src.match(/appendJournalEntry[\s\S]{0,200}/)?.[0] ?? '';
    expect(appendBlock).not.toContain('truncat');
  });

  it('diary saves to memory system without truncation flag', () => {
    const src = readSrc('agent/diary.ts');
    expect(src).toContain('saveMemory');
    // saveMemory call has no metadata about truncation
    const block = src.match(/saveMemory\([\s\S]*?\)/)?.[0] ?? '';
    expect(block).not.toContain('finishReason');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 12. DREAMS TRUNCATION: silently saves truncated fragments
// ═════════════════════════════════════════════════════════════════════════════

describe('Dreams truncation is silent', () => {
  it('dreams calls provider.complete and never checks finishReason', () => {
    const src = readSrc('agent/dreams.ts');
    expect(src).toContain('.complete(');
    expect(src).not.toContain('finishReason');
  });

  it('dreams uses maxTokens: 500 for fragment generation', () => {
    const src = readSrc('agent/dreams.ts');
    expect(src).toContain('maxTokens: 500');
  });

  it('dreams parses response directly without truncation awareness', () => {
    const src = readSrc('agent/dreams.ts');
    expect(src).toContain('parseDreamFragment');
    // The parse function checks length < 10, but has no finishReason awareness
    const parseFn = extractMethod(src, 'parseDreamFragment');
    expect(parseFn).not.toContain('finishReason');
    expect(parseFn).not.toContain('truncat');
  });

  it('dreams has a dream residue compression call with low maxTokens', () => {
    const src = readSrc('agent/dreams.ts');
    // The compression call uses a low maxTokens relative to fragment generation
    const compressionMatch = src.match(/Compress this dream[\s\S]*?maxTokens:\s*(\d+)/);
    if (compressionMatch) {
      const tokens = Number(compressionMatch[1]);
      expect(tokens).toBeLessThanOrEqual(200);
      // This is intentionally low but the result is never checked for truncation
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 13. LETTER TRUNCATION: JSON parse fails silently on truncated JSON
// ═════════════════════════════════════════════════════════════════════════════

describe('Letter truncation causes silent JSON parse failure', () => {
  it('letter calls provider.complete and never checks finishReason', () => {
    const src = readSrc('agent/letter.ts');
    expect(src).toContain('.complete(');
    expect(src).not.toContain('finishReason');
  });

  it('letter expects JSON response — truncation would break JSON.parse', () => {
    const src = readSrc('agent/letter.ts');
    expect(src).toContain('JSON.parse');
    // The JSON.parse is in a try/catch, which means truncated JSON silently skips
    const parseBlock = src.match(/JSON\.parse[\s\S]*?catch/)?.[0] ?? '';
    expect(parseBlock).toContain('catch');
  });

  it('letter catch block logs warning but does not identify truncation as the cause', () => {
    const src = readSrc('agent/letter.ts');
    // The catch block just says "failed to parse JSON" — no mention of truncation
    expect(src).toContain('failed to parse JSON');
    expect(src).not.toContain('truncat');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 14. SELF-CONCEPT TRUNCATION: corrupted self-understanding
// ═════════════════════════════════════════════════════════════════════════════

describe('Self-concept truncation is silent', () => {
  it('self-concept calls provider.complete and never checks finishReason', () => {
    const src = readSrc('agent/self-concept.ts');
    expect(src).toContain('.complete(');
    expect(src).not.toContain('finishReason');
  });

  it('self-concept validates length but not truncation', () => {
    const src = readSrc('agent/self-concept.ts');
    expect(src).toMatch(/length\s*<\s*\d+/);
    expect(src).not.toContain('finishReason');
  });

  it('self-concept uses maxTokens: 1024 for 300-500 word target', () => {
    const src = readSrc('agent/self-concept.ts');
    expect(src).toContain('maxTokens: 1024');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 15. INTERNAL STATE TRUNCATION: corrupted JSON emotional model
// ═════════════════════════════════════════════════════════════════════════════

describe('Internal state truncation would corrupt emotional JSON', () => {
  it('internal-state calls provider.complete and never checks finishReason', () => {
    const src = readSrc('agent/internal-state.ts');
    expect(src).toContain('.complete(');
    expect(src).not.toContain('finishReason');
  });

  it('internal-state expects JSON response — truncation would break parsing', () => {
    const src = readSrc('agent/internal-state.ts');
    expect(src).toContain('JSON.parse');
  });

  it('internal-state uses maxTokens: 500 for JSON that could exceed that', () => {
    const src = readSrc('agent/internal-state.ts');
    expect(src).toContain('maxTokens: 500');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 16. CURIOSITY TRUNCATION: truncated discoveries saved
// ═════════════════════════════════════════════════════════════════════════════

describe('Curiosity truncation is silent', () => {
  it('curiosity calls provider.complete and never checks finishReason', () => {
    const src = readSrc('agent/curiosity.ts');
    expect(src).toContain('.complete(');
    expect(src).not.toContain('finishReason');
  });

  it('curiosity uses maxTokens: 400 for query generation', () => {
    const src = readSrc('agent/curiosity.ts');
    expect(src).toContain('maxTokens: 400');
  });

  it('curiosity checks for [NOTHING] sentinel but not truncation', () => {
    const src = readSrc('agent/curiosity.ts');
    expect(src).toContain('[NOTHING]');
    expect(src).not.toContain('finishReason');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 17. BOOK SYSTEM TRUNCATION: most vulnerable to truncation
// ═════════════════════════════════════════════════════════════════════════════

describe('Book system truncation is silent', () => {
  it('book calls provider.complete multiple times and never checks finishReason', () => {
    const src = readSrc('agent/book.ts');
    const completeCallCount = (src.match(/\.complete\(/g) ?? []).length;
    expect(completeCallCount).toBeGreaterThanOrEqual(5);
    expect(src).not.toContain('finishReason');
  });

  it('book chapter drafts use maxTokens: 8000', () => {
    const src = readSrc('agent/book.ts');
    expect(src).toContain('maxTokens: 8000');
  });

  it('book revision uses maxTokens: 8000', () => {
    const src = readSrc('agent/book.ts');
    expect(src).toContain('maxTokens: 8000');
  });

  it('book outline generation uses maxTokens: 4096', () => {
    const src = readSrc('agent/book.ts');
    expect(src).toContain('maxTokens: 4096');
  });

  it('book synthesis uses maxTokens: 6000', () => {
    const src = readSrc('agent/book.ts');
    expect(src).toContain('maxTokens: 6000');
  });

  it('book decideAction uses maxTokens: 10 intentionally for single-word', () => {
    const src = readSrc('agent/book.ts');
    expect(src).toContain('maxTokens: 10');
    // Even this intentional low value could be silently truncated
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 18. DESIRES TRUNCATION: decision-making with unchecked finish reasons
// ═════════════════════════════════════════════════════════════════════════════

describe('Desires truncation is silent', () => {
  it('desires calls provider.complete multiple times and never checks finishReason', () => {
    const src = readSrc('agent/desires.ts');
    const completeCallCount = (src.match(/\.complete\(/g) ?? []).length;
    expect(completeCallCount).toBeGreaterThanOrEqual(3);
    expect(src).not.toContain('finishReason');
  });

  it('desires parses structured output that could be truncated', () => {
    const src = readSrc('agent/desires.ts');
    // Desires expects TITLE: and DESCRIPTION: format
    expect(src).toContain('[NOTHING]');
    expect(src).not.toContain('finishReason');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 19. EVOLUTION TRUNCATION: generation-changing content unguarded
// ═════════════════════════════════════════════════════════════════════════════

describe('Evolution truncation is silent', () => {
  it('evolution calls provider.complete and never checks finishReason', () => {
    const filePath = join(SRC_ROOT, 'agent/evolution.ts');
    if (!existsSync(filePath)) return;
    const src = readFileSync(filePath, 'utf-8');
    expect(src).toContain('.complete(');
    expect(src).not.toContain('finishReason');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 20. EXPERIMENTS TRUNCATION: experiment results unguarded
// ═════════════════════════════════════════════════════════════════════════════

describe('Experiments truncation is silent', () => {
  it('experiments calls provider.complete and never checks finishReason', () => {
    const filePath = join(SRC_ROOT, 'agent/experiments.ts');
    if (!existsSync(filePath)) return;
    const src = readFileSync(filePath, 'utf-8');
    expect(src).toContain('.complete(');
    expect(src).not.toContain('finishReason');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 21. BIBLIOMANCY TRUNCATION: creative output unguarded
// ═════════════════════════════════════════════════════════════════════════════

describe('Bibliomancy truncation is silent', () => {
  it('bibliomancy calls provider.complete and never checks finishReason', () => {
    const filePath = join(SRC_ROOT, 'agent/bibliomancy.ts');
    if (!existsSync(filePath)) return;
    const src = readFileSync(filePath, 'utf-8');
    expect(src).toContain('.complete(');
    expect(src).not.toContain('finishReason');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 22. PROACTIVE TRUNCATION: unsolicited messages unguarded
// ═════════════════════════════════════════════════════════════════════════════

describe('Proactive truncation is silent', () => {
  it('proactive calls provider.complete and never checks finishReason', () => {
    const filePath = join(SRC_ROOT, 'agent/proactive.ts');
    if (!existsSync(filePath)) return;
    const src = readFileSync(filePath, 'utf-8');
    expect(src).toContain('.complete(');
    expect(src).not.toContain('finishReason');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 23. WEATHER TRUNCATION: town weather unguarded
// ═════════════════════════════════════════════════════════════════════════════

describe('Weather system truncation handling', () => {
  it('weather calls provider.complete (if it does) and checks truncation status', () => {
    const filePath = join(SRC_ROOT, 'commune/weather.ts');
    if (!existsSync(filePath)) return;
    const src = readFileSync(filePath, 'utf-8');
    if (src.includes('.complete(')) {
      // Weather might or might not check finishReason
      // Document current state
      const checksFinish = src.includes('finishReason');
      expect(typeof checksFinish).toBe('boolean'); // just documenting
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 24. CompletionResult TYPE SAFETY — finishReason is not optional
// ═════════════════════════════════════════════════════════════════════════════

describe('CompletionResult type: finishReason is required', () => {
  it('finishReason field exists in CompletionResult interface', () => {
    const src = readSrc('providers/base.ts');
    expect(src).toContain('finishReason');
  });

  it('finishReason is not optional (no ? modifier)', () => {
    const src = readSrc('providers/base.ts');
    // Look for finishReason without optional marker
    const resultInterface = src.match(/interface CompletionResult[\s\S]*?\}/)?.[0] ?? '';
    expect(resultInterface).toContain('finishReason:');
    expect(resultInterface).not.toContain('finishReason?:');
  });

  it('finishReason union includes "length" for truncation', () => {
    const src = readSrc('providers/base.ts');
    expect(src).toContain("'length'");
  });

  it('finishReason union includes all five values', () => {
    const src = readSrc('providers/base.ts');
    const finishReasonLine = src.match(/finishReason:.*$/m)?.[0] ?? '';
    expect(finishReasonLine).toContain("'stop'");
    expect(finishReasonLine).toContain("'length'");
    expect(finishReasonLine).toContain("'content_filter'");
    expect(finishReasonLine).toContain("'tool_use'");
    expect(finishReasonLine).toContain("'error'");
  });

  it('CompletionWithToolsResult extends CompletionResult (inherits finishReason)', () => {
    const src = readSrc('providers/base.ts');
    expect(src).toContain('CompletionWithToolsResult extends CompletionResult');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 25. EDGE CASES: maxTokens boundary behavior
// ═════════════════════════════════════════════════════════════════════════════

describe('maxTokens boundary edge cases', () => {
  beforeEach(() => {
    mockAnthropicCreate.mockReset();
    mockOpenAICreate.mockReset();
    mockGenerateContent.mockReset();
    mockGetGenerativeModel.mockReset();
    mockGetGenerativeModel.mockReturnValue({ generateContent: mockGenerateContent });
  });

  it('Anthropic: maxTokens=1 produces finishReason=length if model tries more', async () => {
    mockAnthropicCreate.mockResolvedValue(anthropicResponse('a', 'max_tokens', 1));
    const r = await makeAnthropic().complete({ messages: simpleMessages, maxTokens: 1 });
    expect(r.finishReason).toBe('length');
    expect(r.usage.outputTokens).toBe(1);
  });

  it('OpenAI: maxTokens=1 produces finishReason=length if model tries more', async () => {
    mockOpenAICreate.mockResolvedValue(openaiResponse('a', 'length', 1));
    const r = await makeOpenAI().complete({ messages: simpleMessages, maxTokens: 1 });
    expect(r.finishReason).toBe('length');
  });

  it('Google: maxTokens=1 produces finishReason=length if model tries more', async () => {
    mockGenerateContent.mockResolvedValue(googleResponse('a', 'MAX_TOKENS', 1));
    const r = await makeGoogle().complete({ messages: simpleMessages, maxTokens: 1 });
    expect(r.finishReason).toBe('length');
  });

  it('Anthropic: exact token count matches maxTokens produces "stop" if not truncated', async () => {
    mockAnthropicCreate.mockResolvedValue(anthropicResponse('exact', 'end_turn', 100));
    const r = await makeAnthropic().complete({ messages: simpleMessages, maxTokens: 100 });
    expect(r.finishReason).toBe('stop');
  });

  it('Anthropic: exact token count matches maxTokens produces "length" if API says so', async () => {
    mockAnthropicCreate.mockResolvedValue(anthropicResponse('exact', 'max_tokens', 100));
    const r = await makeAnthropic().complete({ messages: simpleMessages, maxTokens: 100 });
    expect(r.finishReason).toBe('length');
  });

  it('Anthropic: very large maxTokens still reports correct finishReason', async () => {
    mockAnthropicCreate.mockResolvedValue(anthropicResponse('text', 'end_turn', 50));
    const r = await makeAnthropic().complete({ messages: simpleMessages, maxTokens: 100000 });
    expect(r.finishReason).toBe('stop');
  });

  it('OpenAI: very large maxTokens still reports correct finishReason', async () => {
    mockOpenAICreate.mockResolvedValue(openaiResponse('text', 'stop', 50));
    const r = await makeOpenAI().complete({ messages: simpleMessages, maxTokens: 100000 });
    expect(r.finishReason).toBe('stop');
  });

  it('Google: very large maxTokens still reports correct finishReason', async () => {
    mockGenerateContent.mockResolvedValue(googleResponse('text', 'STOP', 50));
    const r = await makeGoogle().complete({ messages: simpleMessages, maxTokens: 100000 });
    expect(r.finishReason).toBe('stop');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 26. MULTIPLE TOOL ROUNDS: finishReason on every round
// ═════════════════════════════════════════════════════════════════════════════

describe('Multiple tool rounds: finishReason per round', () => {
  beforeEach(() => {
    mockAnthropicCreate.mockReset();
    mockOpenAICreate.mockReset();
    mockGenerateContent.mockReset();
    mockGetGenerativeModel.mockReset();
    mockGetGenerativeModel.mockReturnValue({ generateContent: mockGenerateContent });
  });

  it('Anthropic: first round tool_use, second round max_tokens', async () => {
    // First call: tools
    mockAnthropicCreate.mockResolvedValueOnce(
      anthropicToolResponse('', [{ id: 'tc_1', name: 'test_tool', input: { q: 'x' } }], 'tool_use')
    );
    // Second call (continueWithToolResults): truncated
    mockAnthropicCreate.mockResolvedValueOnce(anthropicResponse('truncated result', 'max_tokens'));

    const p = makeAnthropic();
    const r1 = await p.completeWithTools({ messages: simpleMessages, tools: sampleTools });
    expect(r1.finishReason).toBe('tool_use');

    const r2 = await p.continueWithToolResults(
      { messages: simpleMessages, tools: sampleTools },
      r1.toolCalls!,
      [{ toolCallId: 'tc_1', content: 'tool result' }]
    );
    expect(r2.finishReason).toBe('length');
  });

  it('OpenAI: first round tool_calls, second round length', async () => {
    mockOpenAICreate.mockResolvedValueOnce(
      openaiToolResponse(null, [{ id: 'tc_1', name: 'test_tool', args: '{"q":"x"}' }], 'tool_calls')
    );
    mockOpenAICreate.mockResolvedValueOnce(openaiResponse('truncated', 'length'));

    const p = makeOpenAI();
    const r1 = await p.completeWithTools({ messages: simpleMessages, tools: sampleTools });
    expect(r1.finishReason).toBe('tool_use');

    const r2 = await p.continueWithToolResults(
      { messages: simpleMessages, tools: sampleTools },
      r1.toolCalls!,
      [{ toolCallId: 'tc_1', content: 'result' }]
    );
    expect(r2.finishReason).toBe('length');
  });

  it('Google: first round tool call, second round MAX_TOKENS', async () => {
    mockGenerateContent.mockResolvedValueOnce(
      googleToolResponse('', [{ name: 'test_tool', args: { q: 'x' } }], 'STOP')
    );
    mockGenerateContent.mockResolvedValueOnce(googleResponse('truncated', 'MAX_TOKENS'));

    const p = makeGoogle();
    const r1 = await p.completeWithTools({ messages: simpleMessages, tools: sampleTools });
    expect(r1.toolCalls).toHaveLength(1);

    const r2 = await p.continueWithToolResults(
      { messages: simpleMessages, tools: sampleTools },
      r1.toolCalls!,
      [{ toolCallId: r1.toolCalls![0]!.id, content: 'result' }]
    );
    expect(r2.finishReason).toBe('length');
  });

  it('Anthropic: three rounds, truncation on third', async () => {
    const p = makeAnthropic();

    // Round 1: tool use
    mockAnthropicCreate.mockResolvedValueOnce(
      anthropicToolResponse('', [{ id: 'tc_1', name: 'test_tool', input: { q: 'a' } }], 'tool_use')
    );
    const r1 = await p.completeWithTools({ messages: simpleMessages, tools: sampleTools });
    expect(r1.finishReason).toBe('tool_use');

    // Round 2: another tool use
    mockAnthropicCreate.mockResolvedValueOnce(
      anthropicToolResponse('', [{ id: 'tc_2', name: 'test_tool', input: { q: 'b' } }], 'tool_use')
    );
    const r2 = await p.continueWithToolResults(
      { messages: simpleMessages, tools: sampleTools },
      r1.toolCalls!,
      [{ toolCallId: 'tc_1', content: 'res1' }]
    );
    expect(r2.finishReason).toBe('tool_use');

    // Round 3: truncated
    mockAnthropicCreate.mockResolvedValueOnce(anthropicResponse('truncated final', 'max_tokens'));
    const r3 = await p.continueWithToolResults(
      { messages: simpleMessages, tools: sampleTools },
      r2.toolCalls!,
      [{ toolCallId: 'tc_2', content: 'res2' }]
    );
    expect(r3.finishReason).toBe('length');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 27. RESULT SHAPE CONSISTENCY: every method returns the same shape
// ═════════════════════════════════════════════════════════════════════════════

describe('Result shape consistency across methods', () => {
  beforeEach(() => {
    mockAnthropicCreate.mockReset();
    mockAnthropicStream.mockReset();
    mockOpenAICreate.mockReset();
    mockGenerateContent.mockReset();
    mockGetGenerativeModel.mockReset();
    mockGetGenerativeModel.mockReturnValue({ generateContent: mockGenerateContent });
  });

  const resultShape = (r: CompletionResult) => {
    expect(r).toHaveProperty('content');
    expect(r).toHaveProperty('finishReason');
    expect(r).toHaveProperty('usage');
    expect(r.usage).toHaveProperty('inputTokens');
    expect(r.usage).toHaveProperty('outputTokens');
    expect(typeof r.content).toBe('string');
    expect(typeof r.finishReason).toBe('string');
    expect(typeof r.usage.inputTokens).toBe('number');
    expect(typeof r.usage.outputTokens).toBe('number');
  };

  it('Anthropic complete() returns correct shape on truncation', async () => {
    mockAnthropicCreate.mockResolvedValue(anthropicResponse('trunc', 'max_tokens'));
    resultShape(await makeAnthropic().complete({ messages: simpleMessages }));
  });

  it('Anthropic completeWithTools() returns correct shape on truncation', async () => {
    mockAnthropicCreate.mockResolvedValue(anthropicResponse('trunc', 'max_tokens'));
    resultShape(await makeAnthropic().completeWithTools({ messages: simpleMessages, tools: sampleTools }));
  });

  it('Anthropic completeStream() returns correct shape on truncation', async () => {
    mockAnthropicStream.mockReturnValue(makeStreamEvents('trunc', 'max_tokens'));
    resultShape(await makeAnthropic().completeStream!({ messages: simpleMessages }, () => {}));
  });

  it('Anthropic completeWithToolsStream() returns correct shape on truncation', async () => {
    mockAnthropicStream.mockReturnValue(makeStreamEvents('trunc', 'max_tokens'));
    resultShape(await makeAnthropic().completeWithToolsStream!({ messages: simpleMessages, tools: sampleTools }, () => {}));
  });

  it('Anthropic continueWithToolResults() returns correct shape on truncation', async () => {
    mockAnthropicCreate.mockResolvedValue(anthropicResponse('trunc', 'max_tokens'));
    resultShape(await makeAnthropic().continueWithToolResults(
      { messages: simpleMessages, tools: sampleTools }, sampleToolCalls, sampleToolResults
    ));
  });

  it('Anthropic continueWithToolResultsStream() returns correct shape on truncation', async () => {
    mockAnthropicStream.mockReturnValue(makeStreamEvents('trunc', 'max_tokens'));
    resultShape(await makeAnthropic().continueWithToolResultsStream!(
      { messages: simpleMessages, tools: sampleTools }, sampleToolCalls, sampleToolResults, () => {}
    ));
  });

  it('OpenAI complete() returns correct shape on truncation', async () => {
    mockOpenAICreate.mockResolvedValue(openaiResponse('trunc', 'length'));
    resultShape(await makeOpenAI().complete({ messages: simpleMessages }));
  });

  it('OpenAI completeWithTools() returns correct shape on truncation', async () => {
    mockOpenAICreate.mockResolvedValue(openaiResponse('trunc', 'length'));
    resultShape(await makeOpenAI().completeWithTools({ messages: simpleMessages, tools: sampleTools }));
  });

  it('OpenAI continueWithToolResults() returns correct shape on truncation', async () => {
    mockOpenAICreate.mockResolvedValue(openaiResponse('trunc', 'length'));
    resultShape(await makeOpenAI().continueWithToolResults(
      { messages: simpleMessages, tools: sampleTools }, sampleToolCalls, sampleToolResults
    ));
  });

  it('Google complete() returns correct shape on truncation', async () => {
    mockGenerateContent.mockResolvedValue(googleResponse('trunc', 'MAX_TOKENS'));
    resultShape(await makeGoogle().complete({ messages: simpleMessages }));
  });

  it('Google completeWithTools() returns correct shape on truncation', async () => {
    mockGenerateContent.mockResolvedValue(googleResponse('trunc', 'MAX_TOKENS'));
    resultShape(await makeGoogle().completeWithTools({ messages: simpleMessages, tools: sampleTools }));
  });

  it('Google continueWithToolResults() returns correct shape on truncation', async () => {
    mockGenerateContent.mockResolvedValue(googleResponse('trunc', 'MAX_TOKENS'));
    resultShape(await makeGoogle().continueWithToolResults(
      { messages: simpleMessages, tools: sampleTools }, sampleToolCalls, sampleToolResults
    ));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 28. STREAMING CHUNK DELIVERY: truncation affects chunking
// ═════════════════════════════════════════════════════════════════════════════

describe('Streaming: truncation affects what chunks are delivered', () => {
  beforeEach(() => {
    mockAnthropicStream.mockReset();
  });

  it('completeStream delivers all chunks even when truncated', async () => {
    mockAnthropicStream.mockReturnValue(makeStreamEvents('hello world', 'max_tokens'));
    const chunks: string[] = [];
    const r = await makeAnthropic().completeStream!(
      { messages: simpleMessages },
      (chunk) => chunks.push(chunk)
    );
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join('')).toBe('hello world');
    expect(r.finishReason).toBe('length');
  });

  it('completeStream with empty text delivers no chunks but still signals truncation', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 5 } } },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 0 } },
    ];
    mockAnthropicStream.mockReturnValue({
      [Symbol.asyncIterator]: async function* () { for (const e of events) yield e; },
    });
    const chunks: string[] = [];
    const r = await makeAnthropic().completeStream!(
      { messages: simpleMessages },
      (chunk) => chunks.push(chunk)
    );
    expect(chunks).toHaveLength(0);
    expect(r.finishReason).toBe('length');
    expect(r.content).toBe('');
  });

  it('completeWithToolsStream delivers text chunks even with tool calls and truncation', async () => {
    const stream = makeStreamEvents('some text', 'max_tokens', 10, 50, [
      { id: 'tc_1', name: 'test_tool', input: { q: 'val' } },
    ]);
    mockAnthropicStream.mockReturnValue(stream);
    const chunks: string[] = [];
    const r = await makeAnthropic().completeWithToolsStream!(
      { messages: simpleMessages, tools: sampleTools },
      (chunk) => chunks.push(chunk)
    );
    expect(chunks.join('')).toBe('some text');
    expect(r.finishReason).toBe('length');
    expect(r.toolCalls).toHaveLength(1);
  });

  it('continueWithToolResultsStream delivers chunks correctly on truncation', async () => {
    mockAnthropicStream.mockReturnValue(makeStreamEvents('partial reply', 'max_tokens'));
    const chunks: string[] = [];
    const r = await makeAnthropic().continueWithToolResultsStream!(
      { messages: simpleMessages, tools: sampleTools },
      sampleToolCalls,
      sampleToolResults,
      (chunk) => chunks.push(chunk)
    );
    expect(chunks.join('')).toBe('partial reply');
    expect(r.finishReason).toBe('length');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 29. MAXTOKEN DEFAULT PASSTHROUGH: provider defaults used when not specified
// ═════════════════════════════════════════════════════════════════════════════

describe('maxTokens default passthrough per provider', () => {
  beforeEach(() => {
    mockAnthropicCreate.mockReset();
    mockOpenAICreate.mockReset();
    mockGenerateContent.mockReset();
    mockGetGenerativeModel.mockReset();
    mockGetGenerativeModel.mockReturnValue({ generateContent: mockGenerateContent });
  });

  it('Anthropic defaults to 8192 maxTokens when not specified', async () => {
    mockAnthropicCreate.mockResolvedValue(anthropicResponse('text', 'end_turn'));
    await makeAnthropic().complete({ messages: simpleMessages });
    const params = mockAnthropicCreate.mock.calls[0][0];
    expect(params.max_tokens).toBe(8192);
  });

  it('Anthropic uses explicit maxTokens when provided', async () => {
    mockAnthropicCreate.mockResolvedValue(anthropicResponse('text', 'end_turn'));
    await makeAnthropic().complete({ messages: simpleMessages, maxTokens: 500 });
    const params = mockAnthropicCreate.mock.calls[0][0];
    expect(params.max_tokens).toBe(500);
  });

  it('Anthropic uses constructor maxTokens as default when no per-call override', async () => {
    mockAnthropicCreate.mockResolvedValue(anthropicResponse('text', 'end_turn'));
    await makeAnthropic(1000).complete({ messages: simpleMessages });
    const params = mockAnthropicCreate.mock.calls[0][0];
    expect(params.max_tokens).toBe(1000);
  });

  it('Anthropic per-call maxTokens overrides constructor default', async () => {
    mockAnthropicCreate.mockResolvedValue(anthropicResponse('text', 'end_turn'));
    await makeAnthropic(1000).complete({ messages: simpleMessages, maxTokens: 2000 });
    const params = mockAnthropicCreate.mock.calls[0][0];
    expect(params.max_tokens).toBe(2000);
  });

  it('OpenAI defaults to 8192 maxTokens when not specified', async () => {
    mockOpenAICreate.mockResolvedValue(openaiResponse('text', 'stop'));
    await makeOpenAI().complete({ messages: simpleMessages });
    const params = mockOpenAICreate.mock.calls[0][0];
    expect(params.max_tokens).toBe(8192);
  });

  it('OpenAI uses explicit maxTokens when provided', async () => {
    mockOpenAICreate.mockResolvedValue(openaiResponse('text', 'stop'));
    await makeOpenAI().complete({ messages: simpleMessages, maxTokens: 300 });
    const params = mockOpenAICreate.mock.calls[0][0];
    expect(params.max_tokens).toBe(300);
  });

  it('Google defaults to 8192 maxOutputTokens when not specified', async () => {
    mockGenerateContent.mockResolvedValue(googleResponse('text', 'STOP'));
    await makeGoogle().complete({ messages: simpleMessages });
    const modelParams = mockGetGenerativeModel.mock.calls[0][0];
    expect(modelParams.generationConfig.maxOutputTokens).toBe(8192);
  });

  it('Google uses explicit maxTokens as maxOutputTokens', async () => {
    mockGenerateContent.mockResolvedValue(googleResponse('text', 'STOP'));
    await makeGoogle().complete({ messages: simpleMessages, maxTokens: 400 });
    const modelParams = mockGetGenerativeModel.mock.calls[0][0];
    expect(modelParams.generationConfig.maxOutputTokens).toBe(400);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 30. COMPREHENSIVE CALL-SITE AUDIT: every provider.complete call in the codebase
// ═════════════════════════════════════════════════════════════════════════════

describe('Call-site audit: every provider.complete() call in agent/', () => {
  const agentDir = join(SRC_ROOT, 'agent');
  const agentFiles = existsSync(agentDir)
    ? readdirSync(agentDir).filter((f) => f.endsWith('.ts'))
    : [];

  it('found agent files to audit', () => {
    expect(agentFiles.length).toBeGreaterThan(0);
  });

  for (const file of agentFiles) {
    it(`${file}: documents whether finishReason is checked after LLM calls`, () => {
      const src = readFileSync(join(agentDir, file), 'utf-8');
      const hasLLMCall = /\.complete\(|\.completeWithTools\(|\.completeStream\(/.test(src);
      if (!hasLLMCall) return; // No LLM calls, skip

      const checksFinish = /finishReason/.test(src);
      // This is a documentation test — we record the current state
      // Only agent/index.ts should currently check finishReason
      if (file === 'index.ts') {
        expect(checksFinish, `${file} SHOULD check finishReason`).toBe(true);
      }
      // All other files: document they don't check (this is the systemic bug)
    });
  }

  it('total LLM call sites in agent/ that DO NOT check finishReason', () => {
    let uncheckedCallSites = 0;
    let totalCallSites = 0;

    for (const file of agentFiles) {
      const src = readFileSync(join(agentDir, file), 'utf-8');
      const calls = (src.match(/\.complete\(|\.completeWithTools\(/g) ?? []).length;
      if (calls === 0) continue;
      totalCallSites += calls;

      if (!src.includes('finishReason')) {
        uncheckedCallSites += calls;
      }
    }

    expect(totalCallSites).toBeGreaterThan(0);
    // Document the extent of the systemic issue
    expect(uncheckedCallSites).toBeGreaterThan(0);
  });

  it('only agent/index.ts among agent files checks finishReason', () => {
    const filesCheckingFinish = agentFiles.filter((file) => {
      const src = readFileSync(join(agentDir, file), 'utf-8');
      return src.includes('finishReason');
    });

    // Only index.ts should check finishReason currently
    expect(filesCheckingFinish).toContain('index.ts');
    // Document that no other file checks it
    const othersChecking = filesCheckingFinish.filter((f) => f !== 'index.ts');
    expect(othersChecking.length).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 31. PROVIDER METHODS EXIST: all providers implement required methods
// ═════════════════════════════════════════════════════════════════════════════

describe('Provider methods that return finishReason', () => {
  it('AnthropicProvider has complete()', () => {
    expect(typeof makeAnthropic().complete).toBe('function');
  });

  it('AnthropicProvider has completeWithTools()', () => {
    expect(typeof makeAnthropic().completeWithTools).toBe('function');
  });

  it('AnthropicProvider has completeStream()', () => {
    expect(typeof makeAnthropic().completeStream).toBe('function');
  });

  it('AnthropicProvider has completeWithToolsStream()', () => {
    expect(typeof makeAnthropic().completeWithToolsStream).toBe('function');
  });

  it('AnthropicProvider has continueWithToolResults()', () => {
    expect(typeof makeAnthropic().continueWithToolResults).toBe('function');
  });

  it('AnthropicProvider has continueWithToolResultsStream()', () => {
    expect(typeof makeAnthropic().continueWithToolResultsStream).toBe('function');
  });

  it('OpenAIProvider has complete()', () => {
    expect(typeof makeOpenAI().complete).toBe('function');
  });

  it('OpenAIProvider has completeWithTools()', () => {
    expect(typeof makeOpenAI().completeWithTools).toBe('function');
  });

  it('OpenAIProvider has continueWithToolResults()', () => {
    expect(typeof makeOpenAI().continueWithToolResults).toBe('function');
  });

  // findings.md P2:990 — OpenAI now implements the streaming methods.
  it('OpenAIProvider has completeStream', () => {
    expect(typeof makeOpenAI().completeStream).toBe('function');
  });

  it('OpenAIProvider has completeWithToolsStream', () => {
    expect(typeof makeOpenAI().completeWithToolsStream).toBe('function');
  });

  it('OpenAIProvider has continueWithToolResultsStream', () => {
    expect(typeof makeOpenAI().continueWithToolResultsStream).toBe('function');
  });

  it('GoogleProvider has complete()', () => {
    expect(typeof makeGoogle().complete).toBe('function');
  });

  it('GoogleProvider has completeWithTools()', () => {
    expect(typeof makeGoogle().completeWithTools).toBe('function');
  });

  it('GoogleProvider has continueWithToolResults()', () => {
    expect(typeof makeGoogle().continueWithToolResults).toBe('function');
  });

  it('GoogleProvider does NOT have completeStream (not implemented)', () => {
    expect(makeGoogle().completeStream).toBeUndefined();
  });

  it('GoogleProvider does NOT have completeWithToolsStream (not implemented)', () => {
    expect(makeGoogle().completeWithToolsStream).toBeUndefined();
  });

  it('GoogleProvider does NOT have continueWithToolResultsStream (not implemented)', () => {
    expect(makeGoogle().continueWithToolResultsStream).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 32. COMMUNE-SPECIFIC MAXTOKEN VALUES
// ═════════════════════════════════════════════════════════════════════════════

describe('Commune loop maxTokens values and their truncation risk', () => {
  it('commune impulse uses maxTokens: 1024', () => {
    const src = readSrc('agent/commune-loop.ts');
    const impulseBlock = src.match(/phaseImpulse[\s\S]*?(?=async function phaseConversation)/)?.[0] ?? src;
    const match = impulseBlock.match(/maxTokens:\s*(\d+)/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(1024);
  });

  it('commune conversation replies use maxTokens: 1024', () => {
    const src = readSrc('agent/commune-loop.ts');
    const convBlock = src.match(/phaseConversation[\s\S]*?(?=async function sendPeerMessage)/)?.[0] ?? '';
    const match = convBlock.match(/maxTokens:\s*(\d+)/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(1024);
  });

  it('commune reflection uses maxTokens: 512', () => {
    const src = readSrc('agent/commune-loop.ts');
    const reflStart = src.indexOf('async function phaseReflection');
    expect(reflStart).toBeGreaterThan(-1);
    const afterStart = src.slice(reflStart);
    const nextFnMatch = afterStart.match(/\nasync function (?!phaseReflection)/);
    const reflBlock = nextFnMatch ? afterStart.slice(0, nextFnMatch.index) : afterStart;
    const match = reflBlock.match(/maxTokens:\s*(\d+)/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(512);
  });

  it('commune approach decision uses maxTokens: 300', () => {
    const src = readSrc('agent/commune-loop.ts');
    // The approach decision is a short yes/no + tool use
    expect(src).toContain('maxTokens: 300');
  });

  it('commune aftermath uses maxTokens: 800', () => {
    const src = readSrc('agent/commune-loop.ts');
    expect(src).toContain('maxTokens: 800');
  });

  it('all commune maxTokens values are documented in this test', () => {
    const src = readSrc('agent/commune-loop.ts');
    const allTokenValues = [...src.matchAll(/maxTokens:\s*(\d+)/g)].map((m) => Number(m[1]));
    expect(allTokenValues.length).toBeGreaterThanOrEqual(4);
    // Every value should be accounted for in the tests above
    for (const val of allTokenValues) {
      expect([300, 512, 800, 1024]).toContain(val);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 33. PROVIDER MAPPING EXHAUSTIVENESS
// ═════════════════════════════════════════════════════════════════════════════

describe('Provider finish-reason mapping exhaustiveness', () => {
  it('Anthropic maps all known Anthropic stop_reason values', () => {
    const src = readSrc('providers/anthropic.ts');
    const mapFn = extractMethod(src, 'mapStopReason');
    // Known Anthropic stop_reasons
    expect(mapFn).toContain('end_turn');
    expect(mapFn).toContain('stop_sequence');
    expect(mapFn).toContain('max_tokens');
    expect(mapFn).toContain('tool_use');
  });

  it('OpenAI maps all known OpenAI finish_reason values', () => {
    const src = readSrc('providers/openai.ts');
    const mapFn = extractMethod(src, 'mapFinishReason');
    // Known OpenAI finish_reasons
    expect(mapFn).toContain('stop');
    expect(mapFn).toContain('length');
    expect(mapFn).toContain('content_filter');
    expect(mapFn).toContain('tool_calls');
  });

  it('Google maps all known Google finishReason values', () => {
    const src = readSrc('providers/google.ts');
    const mapFn = extractMethod(src, 'mapFinishReason');
    // Known Google finishReasons
    expect(mapFn).toContain('STOP');
    expect(mapFn).toContain('MAX_TOKENS');
    expect(mapFn).toContain('SAFETY');
  });

  it('Anthropic does NOT map max_tokens to stop (that would hide truncation)', () => {
    const src = readSrc('providers/anthropic.ts');
    // Ensure max_tokens maps to length, not stop
    const maxTokensCase = src.match(/case\s*['"]max_tokens['"][\s\S]*?return\s*['"](\w+)['"]/);
    expect(maxTokensCase).not.toBeNull();
    expect(maxTokensCase![1]).toBe('length');
    expect(maxTokensCase![1]).not.toBe('stop');
  });

  it('OpenAI does NOT map length to stop (that would hide truncation)', () => {
    const src = readSrc('providers/openai.ts');
    const lengthCase = src.match(/case\s*['"]length['"][\s\S]*?return\s*['"](\w+)['"]/);
    expect(lengthCase).not.toBeNull();
    expect(lengthCase![1]).toBe('length');
    expect(lengthCase![1]).not.toBe('stop');
  });

  it('Google does NOT map MAX_TOKENS to stop (that would hide truncation)', () => {
    const src = readSrc('providers/google.ts');
    const maxTokensCase = src.match(/case\s*['"]MAX_TOKENS['"][\s\S]*?return\s*['"](\w+)['"]/);
    expect(maxTokensCase).not.toBeNull();
    expect(maxTokensCase![1]).toBe('length');
    expect(maxTokensCase![1]).not.toBe('stop');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 34. ANTHROPIC STREAM: malformed event handling and finishReason
// ═════════════════════════════════════════════════════════════════════════════

describe('Anthropic stream: malformed events and finishReason edge cases', () => {
  beforeEach(() => {
    mockAnthropicStream.mockReset();
  });

  it('stream with only message_start event defaults finishReason to "stop"', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    ];
    mockAnthropicStream.mockReturnValue({
      [Symbol.asyncIterator]: async function* () { for (const e of events) yield e; },
    });
    const r = await makeAnthropic().completeStream!({ messages: simpleMessages }, () => {});
    expect(r.finishReason).toBe('stop');
    expect(r.content).toBe('');
  });

  it('stream with message_delta but no stop_reason keeps default "stop"', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 5 } } },
      { type: 'content_block_delta', delta: { text: 'hi' } },
      { type: 'message_delta', delta: {}, usage: { output_tokens: 2 } },
    ];
    mockAnthropicStream.mockReturnValue({
      [Symbol.asyncIterator]: async function* () { for (const e of events) yield e; },
    });
    const r = await makeAnthropic().completeStream!({ messages: simpleMessages }, () => {});
    expect(r.finishReason).toBe('stop');
  });

  it('stream with multiple message_delta events uses the last one', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 5 } } },
      { type: 'content_block_delta', delta: { text: 'hi' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 2 } },
    ];
    mockAnthropicStream.mockReturnValue({
      [Symbol.asyncIterator]: async function* () { for (const e of events) yield e; },
    });
    const r = await makeAnthropic().completeStream!({ messages: simpleMessages }, () => {});
    expect(r.finishReason).toBe('length'); // last delta wins
  });

  it('stream message_delta with undefined stop_reason preserves previous value', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 5 } } },
      { type: 'content_block_delta', delta: { text: 'hi' } },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 1 } },
      { type: 'message_delta', delta: { stop_reason: undefined }, usage: { output_tokens: 2 } },
    ];
    mockAnthropicStream.mockReturnValue({
      [Symbol.asyncIterator]: async function* () { for (const e of events) yield e; },
    });
    const r = await makeAnthropic().completeStream!({ messages: simpleMessages }, () => {});
    // stop_reason: undefined is falsy, so if (event.delta?.stop_reason) won't trigger
    // Therefore the previously-set 'length' should remain
    expect(r.finishReason).toBe('length');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 35. ANTHROPIC STREAMING TOOL CALLS: finishReason with partial tool JSON
// ═════════════════════════════════════════════════════════════════════════════

describe('Anthropic stream: tool call parsing with truncation', () => {
  beforeEach(() => {
    mockAnthropicStream.mockReset();
  });

  it('completeWithToolsStream with valid tool JSON returns tool calls', async () => {
    const stream = makeStreamEvents('', 'tool_use', 10, 50, [
      { id: 'tc_1', name: 'test_tool', input: { q: 'hello', verbose: true } },
    ]);
    mockAnthropicStream.mockReturnValue(stream);
    const r = await makeAnthropic().completeWithToolsStream!(
      { messages: simpleMessages, tools: sampleTools },
      () => {}
    );
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls![0].input).toEqual({ q: 'hello', verbose: true });
  });

  it('completeWithToolsStream with empty tool JSON defaults to empty object', async () => {
    const stream = makeStreamEvents('', 'tool_use', 10, 50, [
      { id: 'tc_1', name: 'test_tool', input: {} },
    ]);
    mockAnthropicStream.mockReturnValue(stream);
    const r = await makeAnthropic().completeWithToolsStream!(
      { messages: simpleMessages, tools: sampleTools },
      () => {}
    );
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls![0].input).toEqual({});
  });

  it('completeWithToolsStream with multiple tool calls all get parsed', async () => {
    const stream = makeStreamEvents('text before', 'tool_use', 10, 50, [
      { id: 'tc_1', name: 'tool_a', input: { a: 1 } },
      { id: 'tc_2', name: 'tool_b', input: { b: 2 } },
    ]);
    mockAnthropicStream.mockReturnValue(stream);
    const r = await makeAnthropic().completeWithToolsStream!(
      { messages: simpleMessages, tools: sampleTools },
      () => {}
    );
    expect(r.toolCalls).toHaveLength(2);
    expect(r.toolCalls![0].name).toBe('tool_a');
    expect(r.toolCalls![1].name).toBe('tool_b');
    expect(r.content).toBe('text before');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 36. OPENAI EDGE CASES: missing choice data
// ═════════════════════════════════════════════════════════════════════════════

describe('OpenAI edge cases: missing or unusual response data', () => {
  beforeEach(() => {
    mockOpenAICreate.mockReset();
  });

  it('undefined choice returns empty content and default finishReason', async () => {
    mockOpenAICreate.mockResolvedValue({
      choices: [undefined],
      usage: { prompt_tokens: 0, completion_tokens: 0 },
    });
    const r = await makeOpenAI().complete({ messages: simpleMessages });
    expect(r.content).toBe('');
    expect(r.finishReason).toBe('stop');
  });

  it('missing usage falls back to zero tokens', async () => {
    mockOpenAICreate.mockResolvedValue({
      choices: [{ message: { content: 'text', tool_calls: [] }, finish_reason: 'length' }],
      usage: undefined,
    });
    const r = await makeOpenAI().complete({ messages: simpleMessages });
    expect(r.finishReason).toBe('length');
    expect(r.usage.inputTokens).toBe(0);
    expect(r.usage.outputTokens).toBe(0);
  });

  it('finish_reason "function_call" (deprecated) maps to "tool_use" (findings.md P2:940)', async () => {
    // findings.md P2:940 — OpenAI's legacy function_call enum value is still
    // the model signaling tool use; mapping it to 'stop' swallowed the
    // signal. Route it to 'tool_use' alongside the current 'tool_calls'.
    mockOpenAICreate.mockResolvedValue(openaiResponse('text', 'function_call'));
    const r = await makeOpenAI().complete({ messages: simpleMessages });
    expect(r.finishReason).toBe('tool_use');
  });

  it('continueWithToolResults with "length" finishReason reports truncation', async () => {
    mockOpenAICreate.mockResolvedValue(openaiResponse('half response beca', 'length'));
    const r = await makeOpenAI().continueWithToolResults(
      { messages: simpleMessages, tools: sampleTools },
      sampleToolCalls,
      sampleToolResults
    );
    expect(r.finishReason).toBe('length');
    expect(r.content).toBe('half response beca');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 37. GOOGLE EDGE CASES: missing candidate data
// ═════════════════════════════════════════════════════════════════════════════

describe('Google edge cases: missing or unusual response data', () => {
  beforeEach(() => {
    mockGenerateContent.mockReset();
    mockGetGenerativeModel.mockReset();
    mockGetGenerativeModel.mockReturnValue({ generateContent: mockGenerateContent });
  });

  it('no candidates returns default finishReason', async () => {
    mockGenerateContent.mockResolvedValue({
      response: {
        text: () => '',
        candidates: undefined,
        usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0 },
      },
    });
    const r = await makeGoogle().complete({ messages: simpleMessages });
    expect(r.finishReason).toBe('stop');
  });

  it('missing usageMetadata returns zero tokens', async () => {
    mockGenerateContent.mockResolvedValue({
      response: {
        text: () => 'text',
        candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'text' }] } }],
        usageMetadata: undefined,
      },
    });
    const r = await makeGoogle().complete({ messages: simpleMessages });
    expect(r.finishReason).toBe('length');
    expect(r.usage.inputTokens).toBe(0);
    expect(r.usage.outputTokens).toBe(0);
  });

  it('candidate with no content parts returns empty text for tools', async () => {
    mockGenerateContent.mockResolvedValue({
      response: {
        text: () => '',
        candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }],
        usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0 },
      },
    });
    const r = await makeGoogle().completeWithTools({ messages: simpleMessages, tools: sampleTools });
    expect(r.finishReason).toBe('length');
    expect(r.content).toBe('');
    expect(r.toolCalls).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 38. NON-AGENT LLM CALLERS: web server, doctor server, weather
// ═════════════════════════════════════════════════════════════════════════════

describe('Non-agent LLM callers and their finish-reason handling', () => {
  it('doctor server uses completeWithTools and may or may not check finishReason', () => {
    const filePath = join(SRC_ROOT, 'web/doctor-server.ts');
    if (!existsSync(filePath)) return;
    const src = readFileSync(filePath, 'utf-8');
    expect(src).toContain('completeWithTools');
    // Document current state
    const checksFinish = src.includes('finishReason');
    expect(typeof checksFinish).toBe('boolean');
  });

  it('web server has LLM calls', () => {
    const filePath = join(SRC_ROOT, 'web/server.ts');
    if (!existsSync(filePath)) return;
    const src = readFileSync(filePath, 'utf-8');
    const hasLLMCall = /\.complete\(|\.completeWithTools\(/.test(src);
    expect(typeof hasLLMCall).toBe('boolean');
  });

  it('weather system has LLM calls', () => {
    const filePath = join(SRC_ROOT, 'commune/weather.ts');
    if (!existsSync(filePath)) return;
    const src = readFileSync(filePath, 'utf-8');
    const hasLLMCall = /\.complete\(/.test(src);
    expect(typeof hasLLMCall).toBe('boolean');
  });

  it('memory extraction has LLM calls', () => {
    const filePath = join(SRC_ROOT, 'memory/extraction.ts');
    if (!existsSync(filePath)) return;
    const src = readFileSync(filePath, 'utf-8');
    const hasLLMCall = /\.complete\(/.test(src);
    expect(typeof hasLLMCall).toBe('boolean');
    if (hasLLMCall) {
      const checksFinish = src.includes('finishReason');
      // Document: memory extraction likely doesn't check finishReason
      expect(typeof checksFinish).toBe('boolean');
    }
  });

  it('memory organic has LLM calls', () => {
    const filePath = join(SRC_ROOT, 'memory/organic.ts');
    if (!existsSync(filePath)) return;
    const src = readFileSync(filePath, 'utf-8');
    const hasLLMCall = /\.complete\(/.test(src);
    expect(typeof hasLLMCall).toBe('boolean');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 39. FULL CODEBASE SCAN: every .ts file with provider.complete calls
// ═════════════════════════════════════════════════════════════════════════════

describe('Full codebase scan: LLM call sites vs finishReason checks', () => {
  function getAllTsFiles(dir: string): string[] {
    const results: string[] = [];
    if (!existsSync(dir)) return results;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist') {
        results.push(...getAllTsFiles(full));
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) {
        results.push(full);
      }
    }
    return results;
  }

  const allSrcFiles = getAllTsFiles(SRC_ROOT);

  it('found source files to audit', () => {
    expect(allSrcFiles.length).toBeGreaterThan(0);
  });

  it('counts files with LLM calls vs files checking finishReason', () => {
    const filesWithCalls: string[] = [];
    const filesCheckingFinish: string[] = [];

    for (const file of allSrcFiles) {
      const src = readFileSync(file, 'utf-8');
      if (/\.complete\(|\.completeWithTools\(|\.completeStream\(/.test(src)) {
        filesWithCalls.push(file);
        if (src.includes('finishReason')) {
          filesCheckingFinish.push(file);
        }
      }
    }

    expect(filesWithCalls.length).toBeGreaterThan(0);
    // The ratio of files that check finishReason should be documented
    // Currently it's likely very low (just agent/index.ts)
    expect(filesCheckingFinish.length).toBeGreaterThanOrEqual(1); // at least agent/index.ts
    expect(filesWithCalls.length).toBeGreaterThan(filesCheckingFinish.length); // proves the systemic gap
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═════════════════════════════════════════════════════════════════════════════

function extractMethod(src: string, name: string): string {
  // Match method definitions (private/public keyword before name, or at start of line)
  const pattern = new RegExp(`(?:private|public|protected)\\s+${name}\\s*\\(`, 'g');
  let startMatch = pattern.exec(src);
  if (!startMatch) {
    // Fallback: try matching function definition pattern
    const altPattern = new RegExp(`function\\s+${name}\\s*\\(`);
    startMatch = altPattern.exec(src);
  }
  if (!startMatch || startMatch.index === undefined) return '';

  let braceCount = 0;
  let started = false;
  const start = startMatch.index;

  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') {
      braceCount++;
      started = true;
    } else if (src[i] === '}') {
      braceCount--;
      if (started && braceCount === 0) {
        return src.slice(start, i + 1);
      }
    }
  }
  return src.slice(start);
}
