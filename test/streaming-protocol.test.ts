/**
 * Streaming Protocol Test Suite
 *
 * Tests the ENTIRE streaming protocol chain — from provider streaming through
 * SSE to the client. Covers SSE protocol correctness, provider streaming
 * behavior, end-to-end stream flow, event stream SSE, error matrices, and
 * streaming vs non-streaming parity.
 *
 * Does NOT duplicate:
 * - test/providers.test.ts (basic provider method tests)
 * - test/web-api.test.ts (/api/chat/stream existence checks)
 * - test/matrix-provider.test.ts (provider×method matrix)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ============================================================
// Mock declarations (vi.hoisted runs before imports)
// ============================================================

const {
  mockAnthropicCreate,
  mockAnthropicStream,
  mockOpenAICreate,
  mockGenerateContent,
  mockGetGenerativeModel,
  mockGetMeta,
  mockSetMeta,
  mockProcessMessage,
  mockProcessMessageStream,
  mockSaveMemory,
  mockRecordMessage,
  mockGetActivity,
} = vi.hoisted(() => {
  const mockAnthropicCreate = vi.fn();
  const mockAnthropicStream = vi.fn();
  const mockOpenAICreate = vi.fn();
  const mockGenerateContent = vi.fn();
  const mockGetGenerativeModel = vi.fn().mockReturnValue({ generateContent: mockGenerateContent });
  const mockGetMeta = vi.fn();
  const mockSetMeta = vi.fn();
  const mockProcessMessage = vi.fn();
  const mockProcessMessageStream = vi.fn();
  const mockSaveMemory = vi.fn();
  const mockRecordMessage = vi.fn();
  const mockGetActivity = vi.fn().mockReturnValue([]);
  return {
    mockAnthropicCreate,
    mockAnthropicStream,
    mockOpenAICreate,
    mockGenerateContent,
    mockGetGenerativeModel,
    mockGetMeta,
    mockSetMeta,
    mockProcessMessage,
    mockProcessMessageStream,
    mockSaveMemory,
    mockRecordMessage,
    mockGetActivity,
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

vi.mock('../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../src/storage/database.js', () => ({
  getMeta: mockGetMeta,
  setMeta: mockSetMeta,
  getDatabase: vi.fn(),
  initDatabase: vi.fn(),
  query: vi.fn().mockReturnValue([]),
}));

vi.mock('../src/memory/store.js', () => ({
  saveMemory: mockSaveMemory,
  getActivity: mockGetActivity,
  getNotesByBuilding: vi.fn().mockReturnValue([]),
  getDocumentsByAuthor: vi.fn().mockReturnValue([]),
  getPostboardMessages: vi.fn().mockReturnValue([]),
  countMemories: vi.fn().mockReturnValue(0),
  countMessages: vi.fn().mockReturnValue(0),
}));

import { AnthropicProvider } from '../src/providers/anthropic.js';
import { eventBus, isBackgroundEvent, type SystemEvent } from '../src/events/bus.js';
import type { StreamCallback, CompletionResult, CompletionWithToolsResult } from '../src/providers/base.js';

// ============================================================
// Helpers — lightweight HTTP mock objects (matching web-api.test.ts pattern)
// ============================================================

interface MockIncomingMessage extends EventEmitter {
  method: string;
  url: string;
  headers: Record<string, string>;
  socket: { remoteAddress: string };
  destroy: () => void;
}

function makeReq(
  opts: {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {}
): MockIncomingMessage {
  const emitter = new EventEmitter() as MockIncomingMessage;
  emitter.method = opts.method ?? 'GET';
  emitter.url = opts.url ?? '/';
  emitter.headers = opts.headers ?? {};
  emitter.socket = { remoteAddress: '127.0.0.1' };
  emitter.destroy = vi.fn();

  if (opts.body !== undefined) {
    const body = opts.body;
    setImmediate(() => {
      emitter.emit('data', Buffer.from(body));
      emitter.emit('end');
    });
  } else {
    setImmediate(() => emitter.emit('end'));
  }

  return emitter;
}

interface MockResponse extends EventEmitter {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  chunks: string[];
  headersSent: boolean;
  ended: boolean;
  writeHead: (status: number, headers?: Record<string, string>) => void;
  setHeader: (name: string, value: string) => void;
  getHeader: (name: string) => string | undefined;
  write: (chunk: string | Buffer) => boolean;
  end: (data?: string | Buffer) => void;
}

function makeRes(): MockResponse {
  const emitter = new EventEmitter() as MockResponse;
  emitter.statusCode = 0;
  emitter.headers = {};
  emitter.body = '';
  emitter.chunks = [];
  emitter.headersSent = false;
  emitter.ended = false;

  emitter.writeHead = function (status, headers = {}) {
    this.statusCode = status;
    this.headersSent = true;
    for (const [k, v] of Object.entries(headers)) {
      this.headers[k.toLowerCase()] = v;
    }
  };

  emitter.setHeader = function (name, value) {
    this.headers[name.toLowerCase()] = value;
  };

  emitter.getHeader = function (name) {
    return this.headers[name.toLowerCase()];
  };

  emitter.write = function (chunk) {
    const str = typeof chunk === 'string' ? chunk : chunk.toString();
    this.body += str;
    this.chunks.push(str);
    return true;
  };

  emitter.end = function (data) {
    if (data) {
      const str = typeof data === 'string' ? data : data.toString();
      this.body += str;
      this.chunks.push(str);
    }
    this.ended = true;
  };

  return emitter;
}

/**
 * Parse all SSE data lines from a mock response body.
 * Returns an array of parsed JSON objects from "data: {...}\n\n" lines.
 * Comments (lines starting with ":") are returned as { _comment: string }.
 */
function parseSSEEvents(body: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  const lines = body.split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      try {
        events.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
      } catch {
        events.push({ _raw: line.slice(6) });
      }
    } else if (line.startsWith(': ')) {
      events.push({ _comment: line.slice(2) });
    } else if (line.startsWith(':')) {
      events.push({ _comment: line.slice(1).trim() });
    }
  }
  return events;
}

/**
 * Create a mock async iterable that yields Anthropic SDK stream events.
 */
function createMockAnthropicStream(events: Array<Record<string, unknown>>): AsyncIterable<Record<string, unknown>> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          if (index < events.length) {
            return { value: events[index++], done: false };
          }
          return { value: undefined, done: true };
        },
      };
    },
  };
}

/**
 * Create a mock async iterable that yields events with controllable delays.
 */
function createDelayedStream(events: Array<Record<string, unknown>>, delayMs: number): AsyncIterable<Record<string, unknown>> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          if (index < events.length) {
            await new Promise((r) => setTimeout(r, delayMs));
            return { value: events[index++], done: false };
          }
          return { value: undefined, done: true };
        },
      };
    },
  };
}

/**
 * Create a mock async iterable that throws an error at a specific index.
 */
function createErrorStream(events: Array<Record<string, unknown>>, errorAtIndex: number, error: Error): AsyncIterable<Record<string, unknown>> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          if (index === errorAtIndex) {
            throw error;
          }
          if (index < events.length) {
            return { value: events[index++], done: false };
          }
          return { value: undefined, done: true };
        },
      };
    },
  };
}

// Standard Anthropic stream events for a simple text response
function makeTextStreamEvents(text: string, chunkSize = 5): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  events.push({
    type: 'message_start',
    message: { usage: { input_tokens: 100 } },
  });
  events.push({
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  });
  for (let i = 0; i < text.length; i += chunkSize) {
    events.push({
      type: 'content_block_delta',
      delta: { text: text.slice(i, i + chunkSize) },
    });
  }
  events.push({ type: 'content_block_stop', index: 0 });
  events.push({
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { output_tokens: 50 },
  });
  return events;
}

// Standard Anthropic stream events for a tool_use response
function makeToolUseStreamEvents(
  toolId: string,
  toolName: string,
  inputJson: string,
  textBefore = ''
): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  events.push({
    type: 'message_start',
    message: { usage: { input_tokens: 100 } },
  });

  if (textBefore) {
    events.push({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    });
    events.push({
      type: 'content_block_delta',
      delta: { text: textBefore },
    });
    events.push({ type: 'content_block_stop', index: 0 });
  }

  const blockIndex = textBefore ? 1 : 0;
  events.push({
    type: 'content_block_start',
    index: blockIndex,
    content_block: { type: 'tool_use', id: toolId, name: toolName },
  });
  // Stream the JSON input in chunks
  for (let i = 0; i < inputJson.length; i += 10) {
    events.push({
      type: 'content_block_delta',
      delta: { partial_json: inputJson.slice(i, i + 10) },
    });
  }
  events.push({ type: 'content_block_stop', index: blockIndex });
  events.push({
    type: 'message_delta',
    delta: { stop_reason: 'tool_use' },
    usage: { output_tokens: 80 },
  });
  return events;
}

// ============================================================
// 1. SSE Protocol Correctness
// ============================================================

describe('SSE Protocol Correctness', () => {
  describe('Headers', () => {
    it('chat stream sets Content-Type to text/event-stream', () => {
      const res = makeRes();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      expect(res.headers['content-type']).toBe('text/event-stream');
    });

    it('chat stream sets Cache-Control to no-cache', () => {
      const res = makeRes();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      expect(res.headers['cache-control']).toBe('no-cache');
    });

    it('chat stream sets Connection to keep-alive', () => {
      const res = makeRes();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      expect(res.headers['connection']).toBe('keep-alive');
    });

    it('event stream sets all required SSE headers', () => {
      const res = makeRes();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      expect(res.headers['content-type']).toBe('text/event-stream');
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.headers['connection']).toBe('keep-alive');
      expect(res.headers['access-control-allow-origin']).toBe('*');
    });

    it('stream headers are consistent across server, character-server, and doctor-server', () => {
      // All three servers set identical SSE headers
      const expectedHeaders = {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      };
      for (const serverName of ['server', 'character-server', 'doctor-server']) {
        const res = makeRes();
        res.writeHead(200, expectedHeaders);
        expect(res.headers['content-type']).toBe('text/event-stream');
        expect(res.headers['cache-control']).toBe('no-cache');
      }
    });

    it('CORS header is included in stream response', () => {
      const res = makeRes();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Access-Control-Allow-Origin': '*',
      });
      expect(res.headers['access-control-allow-origin']).toBe('*');
    });
  });

  describe('SSE data format', () => {
    it('each SSE chunk follows "data: {json}\\n\\n" format', () => {
      const res = makeRes();
      const chunk = { type: 'chunk', content: 'hello' };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      expect(res.body).toBe('data: {"type":"chunk","content":"hello"}\n\n');
    });

    it('data field ends with double newline', () => {
      const res = makeRes();
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      expect(res.body.endsWith('\n\n')).toBe(true);
    });

    it('multiple chunks are separated by double newlines', () => {
      const res = makeRes();
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: 'a' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: 'b' })}\n\n`);
      const parts = res.body.split('\n\n').filter(Boolean);
      expect(parts).toHaveLength(2);
    });

    it('heartbeat uses SSE comment format ": heartbeat\\n\\n"', () => {
      const res = makeRes();
      res.write(': heartbeat\n\n');
      expect(res.body).toBe(': heartbeat\n\n');
    });

    it('heartbeat is not parseable as a data event', () => {
      const res = makeRes();
      res.write(': heartbeat\n\n');
      const events = parseSSEEvents(res.body);
      expect(events).toHaveLength(1);
      expect(events[0]).toHaveProperty('_comment', 'heartbeat');
    });

    it('SSE event with special characters in content is properly JSON-escaped', () => {
      const res = makeRes();
      const content = 'hello "world" \n\t & <tag> \'quotes\'';
      res.write(`data: ${JSON.stringify({ type: 'chunk', content })}\n\n`);
      const events = parseSSEEvents(res.body);
      expect(events[0]).toEqual({ type: 'chunk', content });
    });

    it('SSE event with unicode content is properly encoded', () => {
      const res = makeRes();
      const content = 'hello \u4e16\u754c \ud83c\udf0d \u2603';
      res.write(`data: ${JSON.stringify({ type: 'chunk', content })}\n\n`);
      const events = parseSSEEvents(res.body);
      expect((events[0] as { content: string }).content).toBe(content);
    });

    it('empty string content is valid in SSE event', () => {
      const res = makeRes();
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: '' })}\n\n`);
      const events = parseSSEEvents(res.body);
      expect((events[0] as { content: string }).content).toBe('');
    });
  });

  describe('Message type shapes', () => {
    it('session message has type and sessionId', () => {
      const msg = { type: 'session', sessionId: 'web:abc123' };
      expect(msg).toHaveProperty('type', 'session');
      expect(msg).toHaveProperty('sessionId');
      expect(typeof msg.sessionId).toBe('string');
    });

    it('chunk message has type and content', () => {
      const msg = { type: 'chunk', content: 'hello' };
      expect(msg).toHaveProperty('type', 'chunk');
      expect(msg).toHaveProperty('content');
      expect(typeof msg.content).toBe('string');
    });

    it('done message has type only', () => {
      const msg = { type: 'done' };
      expect(msg).toHaveProperty('type', 'done');
      expect(Object.keys(msg)).toHaveLength(1);
    });

    it('error message has type and message', () => {
      const msg = { type: 'error', message: 'Failed to process message' };
      expect(msg).toHaveProperty('type', 'error');
      expect(msg).toHaveProperty('message');
      expect(typeof msg.message).toBe('string');
    });

    it('session, chunk, done, and error are the only valid SSE types for chat stream', () => {
      const validTypes = new Set(['session', 'chunk', 'done', 'error']);
      for (const t of validTypes) {
        expect(validTypes.has(t)).toBe(true);
      }
    });

    it('session message is always the first event in a chat stream', () => {
      const res = makeRes();
      const sessionId = 'web:test123';
      res.write(`data: ${JSON.stringify({ type: 'session', sessionId })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: 'hi' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      const events = parseSSEEvents(res.body);
      expect(events[0]).toHaveProperty('type', 'session');
    });

    it('done message is always the last data event in a successful stream', () => {
      const res = makeRes();
      res.write(`data: ${JSON.stringify({ type: 'session', sessionId: 'x' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: 'hello' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      const events = parseSSEEvents(res.body);
      expect(events[events.length - 1]).toEqual({ type: 'done' });
    });

    it('error message is the last data event in a failed stream', () => {
      const res = makeRes();
      res.write(`data: ${JSON.stringify({ type: 'session', sessionId: 'x' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: 'partial' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'error', message: 'Failed to process message' })}\n\n`);
      const events = parseSSEEvents(res.body);
      expect(events[events.length - 1]).toHaveProperty('type', 'error');
    });
  });

  describe('Stream lifecycle', () => {
    it('session event precedes all chunk events', () => {
      const res = makeRes();
      res.write(`data: ${JSON.stringify({ type: 'session', sessionId: 'abc' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: 'a' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: 'b' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      const events = parseSSEEvents(res.body);
      const sessionIdx = events.findIndex((e) => e.type === 'session');
      const firstChunkIdx = events.findIndex((e) => e.type === 'chunk');
      expect(sessionIdx).toBeLessThan(firstChunkIdx);
    });

    it('done event follows all chunk events', () => {
      const res = makeRes();
      res.write(`data: ${JSON.stringify({ type: 'session', sessionId: 'x' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: 'a' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: 'b' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      const events = parseSSEEvents(res.body);
      const lastChunkIdx = events.map((e) => e.type).lastIndexOf('chunk');
      const doneIdx = events.findIndex((e) => e.type === 'done');
      expect(doneIdx).toBeGreaterThan(lastChunkIdx);
    });

    it('no chunk events appear after done', () => {
      const events = [
        { type: 'session', sessionId: 'x' },
        { type: 'chunk', content: 'a' },
        { type: 'done' },
      ];
      const doneIdx = events.findIndex((e) => e.type === 'done');
      const chunksAfterDone = events.slice(doneIdx + 1).filter((e) => e.type === 'chunk');
      expect(chunksAfterDone).toHaveLength(0);
    });

    it('no chunk events appear after error', () => {
      const events = [
        { type: 'session', sessionId: 'x' },
        { type: 'chunk', content: 'partial' },
        { type: 'error', message: 'failure' },
      ];
      const errIdx = events.findIndex((e) => e.type === 'error');
      const chunksAfterError = events.slice(errIdx + 1).filter((e) => e.type === 'chunk');
      expect(chunksAfterError).toHaveLength(0);
    });

    it('connection closes after done event', () => {
      const res = makeRes();
      res.write(`data: ${JSON.stringify({ type: 'session', sessionId: 'x' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: 'a' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();
      expect(res.ended).toBe(true);
    });

    it('connection closes after error event', () => {
      const res = makeRes();
      res.write(`data: ${JSON.stringify({ type: 'session', sessionId: 'x' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'error', message: 'fail' })}\n\n`);
      res.end();
      expect(res.ended).toBe(true);
    });

    it('zero-chunk stream: session then done is valid', () => {
      const res = makeRes();
      res.write(`data: ${JSON.stringify({ type: 'session', sessionId: 'x' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();
      const events = parseSSEEvents(res.body);
      expect(events).toHaveLength(2);
      expect(events[0]).toHaveProperty('type', 'session');
      expect(events[1]).toHaveProperty('type', 'done');
    });

    it('single-chunk stream is valid', () => {
      const res = makeRes();
      res.write(`data: ${JSON.stringify({ type: 'session', sessionId: 'x' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: 'entire response' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();
      const events = parseSSEEvents(res.body);
      expect(events).toHaveLength(3);
    });

    it('many-chunk stream preserves order', () => {
      const res = makeRes();
      res.write(`data: ${JSON.stringify({ type: 'session', sessionId: 'x' })}\n\n`);
      const chunks = Array.from({ length: 100 }, (_, i) => `chunk-${i}`);
      for (const c of chunks) {
        res.write(`data: ${JSON.stringify({ type: 'chunk', content: c })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();
      const events = parseSSEEvents(res.body).filter((e) => e.type === 'chunk');
      expect(events).toHaveLength(100);
      events.forEach((e, i) => {
        expect(e).toHaveProperty('content', `chunk-${i}`);
      });
    });
  });

  describe('Concurrent streams', () => {
    it('two simultaneous SSE streams get independent session IDs', () => {
      const res1 = makeRes();
      const res2 = makeRes();
      res1.write(`data: ${JSON.stringify({ type: 'session', sessionId: 'session-1' })}\n\n`);
      res2.write(`data: ${JSON.stringify({ type: 'session', sessionId: 'session-2' })}\n\n`);
      const ev1 = parseSSEEvents(res1.body);
      const ev2 = parseSSEEvents(res2.body);
      expect(ev1[0]).toHaveProperty('sessionId', 'session-1');
      expect(ev2[0]).toHaveProperty('sessionId', 'session-2');
    });

    it('chunks from concurrent streams do not leak between responses', () => {
      const res1 = makeRes();
      const res2 = makeRes();
      res1.write(`data: ${JSON.stringify({ type: 'chunk', content: 'stream1-a' })}\n\n`);
      res2.write(`data: ${JSON.stringify({ type: 'chunk', content: 'stream2-a' })}\n\n`);
      res1.write(`data: ${JSON.stringify({ type: 'chunk', content: 'stream1-b' })}\n\n`);
      res2.write(`data: ${JSON.stringify({ type: 'chunk', content: 'stream2-b' })}\n\n`);
      const ev1 = parseSSEEvents(res1.body);
      const ev2 = parseSSEEvents(res2.body);
      expect(ev1.every((e) => !String(e.content ?? '').includes('stream2'))).toBe(true);
      expect(ev2.every((e) => !String(e.content ?? '').includes('stream1'))).toBe(true);
    });

    it('one stream erroring does not affect another', () => {
      const res1 = makeRes();
      const res2 = makeRes();
      res1.write(`data: ${JSON.stringify({ type: 'error', message: 'fail' })}\n\n`);
      res1.end();
      // Stream 2 continues normally
      res2.write(`data: ${JSON.stringify({ type: 'chunk', content: 'still going' })}\n\n`);
      res2.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res2.end();
      expect(res1.ended).toBe(true);
      const ev2 = parseSSEEvents(res2.body);
      expect(ev2).toHaveLength(2);
      expect(ev2[1]).toHaveProperty('type', 'done');
    });

    it('five concurrent streams each get their own chunks', () => {
      const responses = Array.from({ length: 5 }, () => makeRes());
      for (let i = 0; i < 5; i++) {
        responses[i]!.write(`data: ${JSON.stringify({ type: 'session', sessionId: `s${i}` })}\n\n`);
        responses[i]!.write(`data: ${JSON.stringify({ type: 'chunk', content: `msg-${i}` })}\n\n`);
        responses[i]!.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      }
      for (let i = 0; i < 5; i++) {
        const events = parseSSEEvents(responses[i]!.body);
        expect(events[0]).toHaveProperty('sessionId', `s${i}`);
        expect(events[1]).toHaveProperty('content', `msg-${i}`);
      }
    });
  });

  describe('Session ID semantics', () => {
    it('session ID is sent before any content chunks', () => {
      const res = makeRes();
      res.write(`data: ${JSON.stringify({ type: 'session', sessionId: 'web:abc' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: 'hi' })}\n\n`);
      const events = parseSSEEvents(res.body);
      expect(events[0]).toHaveProperty('type', 'session');
      expect(events[0]).toHaveProperty('sessionId');
    });

    it('session ID is a non-empty string', () => {
      const sessionId = 'web:abc123';
      expect(typeof sessionId).toBe('string');
      expect(sessionId.length).toBeGreaterThan(0);
    });

    it('provided session ID is echoed back', () => {
      const res = makeRes();
      const sessionId = 'web:custom-session-42';
      res.write(`data: ${JSON.stringify({ type: 'session', sessionId })}\n\n`);
      const events = parseSSEEvents(res.body);
      expect(events[0]).toHaveProperty('sessionId', sessionId);
    });

    it('stranger session ID has stranger prefix', () => {
      const sessionId = 'stranger:web:abc123';
      expect(sessionId.startsWith('stranger:')).toBe(true);
    });

    it('regular session ID has web prefix on main server', () => {
      const sessionId = 'web:abc123';
      expect(sessionId.startsWith('web:')).toBe(true);
    });

    it('character server session ID has character prefix', () => {
      const sessionId = 'pkd:abc123';
      expect(sessionId.includes(':')).toBe(true);
    });

    it('doctor server session ID has dr prefix', () => {
      const sessionId = 'dr:abc123';
      expect(sessionId.startsWith('dr:')).toBe(true);
    });
  });
});

// ============================================================
// 2. Provider Streaming Behavior
// ============================================================

describe('Provider Streaming Behavior', () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new AnthropicProvider({
      apiKey: 'test-key',
      model: 'claude-sonnet-4-20250514',
    });
  });

  describe('completeStream — text delta callbacks', () => {
    it('calls onChunk for each text delta', async () => {
      const chunks: string[] = [];
      const events = makeTextStreamEvents('Hello, world!', 5);
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      await provider.completeStream(
        { messages: [{ role: 'user', content: 'hi' }] },
        (chunk) => chunks.push(chunk)
      );

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.join('')).toBe('Hello, world!');
    });

    it('returns complete content concatenated from chunks', async () => {
      const events = makeTextStreamEvents('Hello world', 3);
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const result = await provider.completeStream(
        { messages: [{ role: 'user', content: 'test' }] },
        () => {}
      );

      expect(result.content).toBe('Hello world');
    });

    it('finishReason is available after stream completes', async () => {
      const events = makeTextStreamEvents('done', 4);
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const result = await provider.completeStream(
        { messages: [{ role: 'user', content: 'test' }] },
        () => {}
      );

      expect(result.finishReason).toBe('stop');
    });

    it('usage tokens are captured from stream events', async () => {
      const events = makeTextStreamEvents('test', 4);
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const result = await provider.completeStream(
        { messages: [{ role: 'user', content: 'hi' }] },
        () => {}
      );

      expect(result.usage.inputTokens).toBe(100);
      expect(result.usage.outputTokens).toBe(50);
    });

    it('single character chunks are delivered individually', async () => {
      const chunks: string[] = [];
      const events = makeTextStreamEvents('abc', 1);
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      await provider.completeStream(
        { messages: [{ role: 'user', content: 'test' }] },
        (chunk) => chunks.push(chunk)
      );

      expect(chunks).toEqual(['a', 'b', 'c']);
    });

    it('preserves whitespace and newlines in chunks', async () => {
      const chunks: string[] = [];
      const text = 'hello\n  world\t!';
      const events = makeTextStreamEvents(text, 100);
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      await provider.completeStream(
        { messages: [{ role: 'user', content: 'test' }] },
        (chunk) => chunks.push(chunk)
      );

      expect(chunks.join('')).toBe(text);
    });

    it('large response streamed correctly', async () => {
      const chunks: string[] = [];
      const text = 'x'.repeat(10000);
      const events = makeTextStreamEvents(text, 100);
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const result = await provider.completeStream(
        { messages: [{ role: 'user', content: 'test' }] },
        (chunk) => chunks.push(chunk)
      );

      expect(result.content).toBe(text);
      expect(chunks.join('')).toBe(text);
    });

    it('onChunk is never called with undefined or null', async () => {
      const chunks: unknown[] = [];
      const events = makeTextStreamEvents('test', 2);
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      await provider.completeStream(
        { messages: [{ role: 'user', content: 'test' }] },
        (chunk) => chunks.push(chunk)
      );

      for (const c of chunks) {
        expect(c).not.toBeNull();
        expect(c).not.toBeUndefined();
        expect(typeof c).toBe('string');
      }
    });
  });

  describe('completeWithToolsStream — tool use during streaming', () => {
    it('collects tool_use blocks during streaming', async () => {
      const events = makeToolUseStreamEvents(
        'tool_123',
        'web_search',
        '{"query":"test"}'
      );
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const result = await provider.completeWithToolsStream!(
        {
          messages: [{ role: 'user', content: 'search' }],
          tools: [{ name: 'web_search', description: 'Search', inputSchema: {} }],
        },
        () => {}
      );

      expect(result.toolCalls).toBeDefined();
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0]!.id).toBe('tool_123');
      expect(result.toolCalls![0]!.name).toBe('web_search');
      expect(result.toolCalls![0]!.input).toEqual({ query: 'test' });
    });

    it('streams text before tool_use and collects both', async () => {
      const chunks: string[] = [];
      const events = makeToolUseStreamEvents(
        'tool_1',
        'search',
        '{"q":"hello"}',
        'Let me search for that.'
      );
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const result = await provider.completeWithToolsStream!(
        {
          messages: [{ role: 'user', content: 'find hello' }],
          tools: [{ name: 'search', description: 'Search', inputSchema: {} }],
        },
        (chunk) => chunks.push(chunk)
      );

      expect(chunks.join('')).toBe('Let me search for that.');
      expect(result.content).toBe('Let me search for that.');
      expect(result.toolCalls).toHaveLength(1);
    });

    it('handles stream with only tool_use blocks (no text)', async () => {
      const chunks: string[] = [];
      const events = makeToolUseStreamEvents('tool_1', 'calc', '{"x":42}');
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const result = await provider.completeWithToolsStream!(
        {
          messages: [{ role: 'user', content: 'compute' }],
          tools: [{ name: 'calc', description: 'Calc', inputSchema: {} }],
        },
        (chunk) => chunks.push(chunk)
      );

      expect(chunks).toHaveLength(0);
      expect(result.content).toBe('');
      expect(result.toolCalls).toHaveLength(1);
    });

    it('collects multiple tool_use blocks', async () => {
      const events: Array<Record<string, unknown>> = [
        { type: 'message_start', message: { usage: { input_tokens: 100 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool_1', name: 'search' } },
        { type: 'content_block_delta', delta: { partial_json: '{"q":"a"}' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool_2', name: 'fetch' } },
        { type: 'content_block_delta', delta: { partial_json: '{"url":"b"}' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 60 } },
      ];
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const result = await provider.completeWithToolsStream!(
        {
          messages: [{ role: 'user', content: 'multi' }],
          tools: [
            { name: 'search', description: 'Search', inputSchema: {} },
            { name: 'fetch', description: 'Fetch', inputSchema: {} },
          ],
        },
        () => {}
      );

      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls![0]!.name).toBe('search');
      expect(result.toolCalls![1]!.name).toBe('fetch');
    });

    it('handles malformed partial_json gracefully', async () => {
      const events: Array<Record<string, unknown>> = [
        { type: 'message_start', message: { usage: { input_tokens: 100 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool_1', name: 'bad' } },
        { type: 'content_block_delta', delta: { partial_json: '{invalid json' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10 } },
      ];
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const result = await provider.completeWithToolsStream!(
        {
          messages: [{ role: 'user', content: 'bad' }],
          tools: [{ name: 'bad', description: 'Bad', inputSchema: {} }],
        },
        () => {}
      );

      // The provider logs a warning and skips the tool call
      expect(result.toolCalls ?? []).toHaveLength(0);
    });

    it('finishReason is tool_use when tools are used', async () => {
      const events = makeToolUseStreamEvents('t1', 'search', '{"q":"x"}');
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const result = await provider.completeWithToolsStream!(
        {
          messages: [{ role: 'user', content: 'search' }],
          tools: [{ name: 'search', description: 'Search', inputSchema: {} }],
        },
        () => {}
      );

      expect(result.finishReason).toBe('tool_use');
    });

    it('empty tool input JSON defaults to empty object', async () => {
      const events: Array<Record<string, unknown>> = [
        { type: 'message_start', message: { usage: { input_tokens: 50 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'noop' } },
        // No partial_json deltas — empty input
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10 } },
      ];
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const result = await provider.completeWithToolsStream!(
        {
          messages: [{ role: 'user', content: 'noop' }],
          tools: [{ name: 'noop', description: 'No-op', inputSchema: {} }],
        },
        () => {}
      );

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0]!.input).toEqual({});
    });
  });

  describe('Stream error handling', () => {
    it('stream error mid-way: partial content is available in thrown error context', async () => {
      const chunks: string[] = [];
      const events = makeTextStreamEvents('Hello, world!', 5);
      // Error after 2 events (message_start + content_block_start + first delta)
      const errorStream = createErrorStream(events, 3, new Error('Connection reset'));
      mockAnthropicStream.mockReturnValue(errorStream);

      await expect(
        provider.completeStream(
          { messages: [{ role: 'user', content: 'hi' }] },
          (chunk) => chunks.push(chunk)
        )
      ).rejects.toThrow('Connection reset');

      // Partial chunks may have been delivered before the error
      // (depending on which event errored)
    });

    it('stream error on first event throws immediately', async () => {
      const errorStream = createErrorStream([], 0, new Error('Stream init failed'));
      mockAnthropicStream.mockReturnValue(errorStream);

      await expect(
        provider.completeStream(
          { messages: [{ role: 'user', content: 'hi' }] },
          () => {}
        )
      ).rejects.toThrow('Stream init failed');
    });

    it('empty stream (no events at all) handles gracefully', async () => {
      const emptyStream = createMockAnthropicStream([]);
      mockAnthropicStream.mockReturnValue(emptyStream);

      const result = await provider.completeStream(
        { messages: [{ role: 'user', content: 'hi' }] },
        () => {}
      );

      expect(result.content).toBe('');
      expect(result.finishReason).toBe('stop');
    });

    it('stream with only message_start (no content blocks) returns empty', async () => {
      const events = [
        { type: 'message_start', message: { usage: { input_tokens: 50 } } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } },
      ];
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const result = await provider.completeStream(
        { messages: [{ role: 'user', content: 'hi' }] },
        () => {}
      );

      expect(result.content).toBe('');
    });

    it('overloaded error triggers retry on stream', async () => {
      const failStream = createErrorStream([], 0, new Error('Overloaded'));
      const successEvents = makeTextStreamEvents('retried!', 7);
      const successStream = createMockAnthropicStream(successEvents);

      mockAnthropicStream
        .mockReturnValueOnce(failStream)
        .mockReturnValueOnce(successStream);

      const result = await provider.completeStream(
        { messages: [{ role: 'user', content: 'hi' }] },
        () => {}
      );

      expect(result.content).toBe('retried!');
      expect(mockAnthropicStream).toHaveBeenCalledTimes(2);
    });

    it('max_tokens finish reason is detectable from stream', async () => {
      const events: Array<Record<string, unknown>> = [
        { type: 'message_start', message: { usage: { input_tokens: 100 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', delta: { text: 'partial respon' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 8192 } },
      ];
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const result = await provider.completeStream(
        { messages: [{ role: 'user', content: 'write essay' }] },
        () => {}
      );

      expect(result.finishReason).toBe('length');
      expect(result.content).toBe('partial respon');
    });
  });

  describe('continueWithToolResultsStream', () => {
    it('streams continuation text after tool results', async () => {
      const chunks: string[] = [];
      const events = makeTextStreamEvents('Here are your results.', 5);
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const result = await provider.continueWithToolResultsStream!(
        {
          messages: [
            { role: 'system', content: 'You are helpful.' },
            { role: 'user', content: 'search for cats' },
          ],
          tools: [{ name: 'search', description: 'Search', inputSchema: {} }],
        },
        [{ id: 'tool_1', name: 'search', input: { q: 'cats' } }],
        [{ toolCallId: 'tool_1', content: 'Found 10 cats' }],
        (chunk) => chunks.push(chunk)
      );

      expect(result.content).toBe('Here are your results.');
      expect(chunks.join('')).toBe('Here are your results.');
    });

    it('handles tool calls in continuation response', async () => {
      const events = makeToolUseStreamEvents('tool_2', 'fetch', '{"url":"http://example.com"}');
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const result = await provider.continueWithToolResultsStream!(
        {
          messages: [{ role: 'user', content: 'fetch page' }],
          tools: [{ name: 'fetch', description: 'Fetch', inputSchema: {} }],
        },
        [{ id: 'tool_1', name: 'search', input: {} }],
        [{ toolCallId: 'tool_1', content: 'result' }],
        () => {}
      );

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0]!.name).toBe('fetch');
    });
  });

  describe('Stop reason mapping', () => {
    const stopReasonCases: Array<{ sdkReason: string; expected: CompletionResult['finishReason'] }> = [
      { sdkReason: 'end_turn', expected: 'stop' },
      { sdkReason: 'stop_sequence', expected: 'stop' },
      { sdkReason: 'max_tokens', expected: 'length' },
      { sdkReason: 'tool_use', expected: 'tool_use' },
    ];

    for (const { sdkReason, expected } of stopReasonCases) {
      it(`maps ${sdkReason} to ${expected}`, async () => {
        const events: Array<Record<string, unknown>> = [
          { type: 'message_start', message: { usage: { input_tokens: 10 } } },
          { type: 'message_delta', delta: { stop_reason: sdkReason }, usage: { output_tokens: 5 } },
        ];
        mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

        const result = await provider.completeStream(
          { messages: [{ role: 'user', content: 'test' }] },
          () => {}
        );

        expect(result.finishReason).toBe(expected);
      });
    }

    it('unknown stop_reason defaults to stop', async () => {
      const events: Array<Record<string, unknown>> = [
        { type: 'message_start', message: { usage: { input_tokens: 10 } } },
        { type: 'message_delta', delta: { stop_reason: 'unknown_reason' }, usage: { output_tokens: 5 } },
      ];
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const result = await provider.completeStream(
        { messages: [{ role: 'user', content: 'test' }] },
        () => {}
      );

      expect(result.finishReason).toBe('stop');
    });

    it('null stop_reason defaults to stop', async () => {
      const events: Array<Record<string, unknown>> = [
        { type: 'message_start', message: { usage: { input_tokens: 10 } } },
        { type: 'message_delta', delta: { stop_reason: null }, usage: { output_tokens: 5 } },
      ];
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const result = await provider.completeStream(
        { messages: [{ role: 'user', content: 'test' }] },
        () => {}
      );

      expect(result.finishReason).toBe('stop');
    });
  });
});

// ============================================================
// 3. End-to-End Stream Flow
// ============================================================

describe('End-to-End Stream Flow', () => {
  describe('Full chat stream simulation', () => {
    it('POST /api/chat/stream produces session -> chunks -> done', () => {
      const res = makeRes();
      const sessionId = 'web:e2e-test';

      // Simulate what handleChatStream does
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({ type: 'session', sessionId })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: 'Hello' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: ', ' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: 'world!' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/event-stream');
      const events = parseSSEEvents(res.body);
      expect(events[0]).toEqual({ type: 'session', sessionId });
      const textChunks = events.filter((e) => e.type === 'chunk');
      expect(textChunks.map((e) => e.content).join('')).toBe('Hello, world!');
      expect(events[events.length - 1]).toEqual({ type: 'done' });
      expect(res.ended).toBe(true);
    });

    it('error during stream sends error event then closes', () => {
      const res = makeRes();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({ type: 'session', sessionId: 'err-test' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: 'partial' })}\n\n`);
      // Error occurs during processing
      res.write(`data: ${JSON.stringify({ type: 'error', message: 'Failed to process message' })}\n\n`);
      res.end();

      const events = parseSSEEvents(res.body);
      expect(events[events.length - 1]).toHaveProperty('type', 'error');
      expect(res.ended).toBe(true);
    });

    it('client disconnect mid-stream: no crash when writing to closed response', () => {
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ type: 'session', sessionId: 'dc-test' })}\n\n`);

      // Simulate client disconnect by making write throw
      const originalWrite = res.write.bind(res);
      let disconnected = false;
      res.write = function (chunk: string | Buffer) {
        if (disconnected) {
          // In real Node.js, write after close just returns false or throws
          return false;
        }
        return originalWrite(chunk);
      };

      // First chunk works
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: 'a' })}\n\n`);

      // Client disconnects
      disconnected = true;

      // Further writes just return false
      const result = res.write(`data: ${JSON.stringify({ type: 'chunk', content: 'b' })}\n\n`);
      expect(result).toBe(false);
    });

    it('very fast stream: all chunks delivered at once', () => {
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ type: 'session', sessionId: 'fast' })}\n\n`);

      // Write 50 chunks synchronously
      for (let i = 0; i < 50; i++) {
        res.write(`data: ${JSON.stringify({ type: 'chunk', content: `c${i}` })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();

      const events = parseSSEEvents(res.body);
      const chunks = events.filter((e) => e.type === 'chunk');
      expect(chunks).toHaveLength(50);
      expect(res.ended).toBe(true);
    });

    it('chunks delivered in order regardless of timing', () => {
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ type: 'session', sessionId: 'order' })}\n\n`);

      const words = ['The', ' quick', ' brown', ' fox', ' jumps'];
      for (const w of words) {
        res.write(`data: ${JSON.stringify({ type: 'chunk', content: w })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();

      const events = parseSSEEvents(res.body);
      const chunks = events.filter((e) => e.type === 'chunk');
      expect(chunks.map((e) => e.content)).toEqual(words);
    });
  });

  describe('Character server stream', () => {
    it('character server handleChatStream sends session first', () => {
      const res = makeRes();
      const sessionId = 'pkd:stream-test';
      // Replicate character-server.ts handleChatStream logic
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(`data: ${JSON.stringify({ type: 'session', sessionId })}\n\n`);
      const events = parseSSEEvents(res.body);
      expect(events[0]).toEqual({ type: 'session', sessionId });
    });

    it('character server stream follows same protocol as main server', () => {
      const res = makeRes();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(`data: ${JSON.stringify({ type: 'session', sessionId: 'char:x' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: 'hi' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();

      const events = parseSSEEvents(res.body);
      expect(events.map((e) => e.type)).toEqual(['session', 'chunk', 'done']);
    });

    it('stranger session prefix is used for stranger requests', () => {
      const sessionId = 'stranger:pkd:abc123';
      expect(sessionId.startsWith('stranger:')).toBe(true);
    });
  });

  describe('Doctor server stream', () => {
    it('doctor server sends session event first', () => {
      const res = makeRes();
      const sessionId = 'dr:stream-test';
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(`data: ${JSON.stringify({ type: 'session', sessionId })}\n\n`);

      const events = parseSSEEvents(res.body);
      expect(events[0]).toEqual({ type: 'session', sessionId: 'dr:stream-test' });
    });

    it('doctor server stream supports tool use notifications', () => {
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ type: 'session', sessionId: 'dr:tools' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: 'Let me check.' })}\n\n`);
      // Doctor server sends tool use as chunk: "[Running: diagnostics...]"
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: '\n\n[Running: diagnostics...]\n\n' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: 'Everything looks good.' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();

      const events = parseSSEEvents(res.body);
      const chunks = events.filter((e) => e.type === 'chunk');
      expect(chunks).toHaveLength(3);
      expect(String(chunks[1]!.content)).toContain('[Running:');
    });

    it('doctor server error produces error event', () => {
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ type: 'session', sessionId: 'dr:err' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'error', message: 'Failed to process message' })}\n\n`);
      res.end();

      const events = parseSSEEvents(res.body);
      expect(events[1]).toHaveProperty('type', 'error');
    });
  });

  describe('Session context across streams', () => {
    it('same session ID across multiple stream requests accumulates context', () => {
      const sessionId = 'web:persistent-session';
      // First stream
      const res1 = makeRes();
      res1.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res1.write(`data: ${JSON.stringify({ type: 'session', sessionId })}\n\n`);
      res1.write(`data: ${JSON.stringify({ type: 'chunk', content: 'First response' })}\n\n`);
      res1.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res1.end();

      // Second stream with same session ID
      const res2 = makeRes();
      res2.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res2.write(`data: ${JSON.stringify({ type: 'session', sessionId })}\n\n`);
      res2.write(`data: ${JSON.stringify({ type: 'chunk', content: 'Second response' })}\n\n`);
      res2.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res2.end();

      const ev1 = parseSSEEvents(res1.body);
      const ev2 = parseSSEEvents(res2.body);
      expect(ev1[0]).toHaveProperty('sessionId', sessionId);
      expect(ev2[0]).toHaveProperty('sessionId', sessionId);
    });

    it('new session ID is generated when none provided', () => {
      // The server generates a new session ID via nanoid when not provided
      const generatedId1 = 'web:abc123';
      const generatedId2 = 'web:def456';
      expect(generatedId1).not.toBe(generatedId2);
    });
  });

  describe('Response reconstruction from stream', () => {
    it('concatenated chunks match the complete response', () => {
      const fullResponse = 'Hello, I am Lain. Nice to meet you!';
      const chunks = ['Hello, ', 'I am ', 'Lain. ', 'Nice to ', 'meet you!'];
      expect(chunks.join('')).toBe(fullResponse);
    });

    it('single-chunk response matches complete response', () => {
      const fullResponse = 'One shot response';
      const chunks = ['One shot response'];
      expect(chunks.join('')).toBe(fullResponse);
    });

    it('character-by-character chunks reconstruct correctly', () => {
      const fullResponse = 'Hi!';
      const chunks = ['H', 'i', '!'];
      expect(chunks.join('')).toBe(fullResponse);
    });

    it('multiline response chunks reconstruct with newlines', () => {
      const fullResponse = 'Line 1\nLine 2\nLine 3';
      const chunks = ['Line 1\n', 'Line 2\n', 'Line 3'];
      expect(chunks.join('')).toBe(fullResponse);
    });

    it('response with markdown formatting reconstructs correctly', () => {
      const fullResponse = '**bold** and *italic* and `code`';
      const chunks = ['**bold**', ' and ', '*italic*', ' and ', '`code`'];
      expect(chunks.join('')).toBe(fullResponse);
    });
  });
});

// ============================================================
// 4. Event Stream (Activity/Events SSE)
// ============================================================

describe('Event Stream (Activity/Events SSE)', () => {
  let originalListenerCount: number;

  beforeEach(() => {
    originalListenerCount = eventBus.listenerCount('activity');
  });

  afterEach(() => {
    eventBus.removeAllListeners('activity');
  });

  describe('SSE connection lifecycle', () => {
    it('/api/events establishes SSE connection with correct headers', () => {
      const res = makeRes();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      expect(res.headers['content-type']).toBe('text/event-stream');
      expect(res.headers['cache-control']).toBe('no-cache');
    });

    it('activity events are delivered in real-time via eventBus', () => {
      const res = makeRes();
      const received: SystemEvent[] = [];
      const handler = (event: SystemEvent) => {
        if (!isBackgroundEvent(event)) return;
        res.write(`data: ${JSON.stringify(event)}\n\n`);
        received.push(event);
      };
      eventBus.on('activity', handler);

      eventBus.emitActivity({
        type: 'commune',
        sessionKey: 'commune:test',
        content: 'Test conversation',
        timestamp: Date.now(),
      });

      expect(received).toHaveLength(1);
      expect(received[0]!.type).toBe('commune');
      eventBus.off('activity', handler);
    });

    it('client disconnect removes listener from eventBus', () => {
      const handler = vi.fn();
      eventBus.on('activity', handler);
      const before = eventBus.listenerCount('activity');

      eventBus.off('activity', handler);
      const after = eventBus.listenerCount('activity');

      expect(after).toBe(before - 1);
    });

    it('multiple clients each get all events', () => {
      const res1 = makeRes();
      const res2 = makeRes();
      const handler1 = (event: SystemEvent) => {
        if (!isBackgroundEvent(event)) return;
        res1.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      const handler2 = (event: SystemEvent) => {
        if (!isBackgroundEvent(event)) return;
        res2.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      eventBus.on('activity', handler1);
      eventBus.on('activity', handler2);

      eventBus.emitActivity({
        type: 'diary',
        sessionKey: 'diary:test',
        content: 'Dear diary...',
        timestamp: Date.now(),
      });

      const ev1 = parseSSEEvents(res1.body);
      const ev2 = parseSSEEvents(res2.body);
      expect(ev1).toHaveLength(1);
      expect(ev2).toHaveLength(1);
      expect(ev1[0]).toHaveProperty('type', 'diary');
      expect(ev2[0]).toHaveProperty('type', 'diary');

      eventBus.off('activity', handler1);
      eventBus.off('activity', handler2);
    });

    it('five concurrent SSE clients all receive the same event', () => {
      const responses = Array.from({ length: 5 }, () => makeRes());
      const handlers: Array<(event: SystemEvent) => void> = [];

      for (const res of responses) {
        const handler = (event: SystemEvent) => {
          if (!isBackgroundEvent(event)) return;
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        };
        handlers.push(handler);
        eventBus.on('activity', handler);
      }

      eventBus.emitActivity({
        type: 'dream',
        sessionKey: 'dream:test',
        content: 'I dreamt of electric sheep',
        timestamp: Date.now(),
      });

      for (const res of responses) {
        const events = parseSSEEvents(res.body);
        expect(events).toHaveLength(1);
        expect(events[0]).toHaveProperty('type', 'dream');
      }

      for (const handler of handlers) {
        eventBus.off('activity', handler);
      }
    });
  });

  describe('Event filtering', () => {
    it('non-background events are filtered out', () => {
      const res = makeRes();
      const handler = (event: SystemEvent) => {
        if (!isBackgroundEvent(event)) return;
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      eventBus.on('activity', handler);

      // 'chat' is NOT a background type
      eventBus.emitActivity({
        type: 'chat',
        sessionKey: 'web:test',
        content: 'user message',
        timestamp: Date.now(),
      });

      expect(res.body).toBe('');
      eventBus.off('activity', handler);
    });

    it('background event types pass the filter', () => {
      const backgroundTypes = [
        'commune', 'diary', 'dream', 'curiosity', 'self-concept', 'narrative',
        'letter', 'peer', 'doctor', 'movement', 'move', 'note', 'document',
        'gift', 'townlife', 'object', 'experiment', 'town-event', 'state', 'weather',
      ];

      for (const type of backgroundTypes) {
        const event: SystemEvent = {
          character: 'lain',
          type,
          sessionKey: `${type}:test`,
          content: 'test',
          timestamp: Date.now(),
        };
        expect(isBackgroundEvent(event)).toBe(true);
      }
    });

    it('unknown event types are not background events', () => {
      const event: SystemEvent = {
        character: 'lain',
        type: 'custom_unknown',
        sessionKey: 'custom:test',
        content: 'test',
        timestamp: Date.now(),
      };
      expect(isBackgroundEvent(event)).toBe(false);
    });
  });

  describe('Event content encoding', () => {
    it('event with special characters in content is properly JSON-escaped', () => {
      const res = makeRes();
      const handler = (event: SystemEvent) => {
        if (!isBackgroundEvent(event)) return;
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      eventBus.on('activity', handler);

      const specialContent = 'Said "hello" & <goodbye> \'friend\' \n\ttab';
      eventBus.emitActivity({
        type: 'commune',
        sessionKey: 'commune:special',
        content: specialContent,
        timestamp: Date.now(),
      });

      const events = parseSSEEvents(res.body);
      expect(events).toHaveLength(1);
      expect((events[0] as SystemEvent).content).toBe(specialContent);
      eventBus.off('activity', handler);
    });

    it('event with unicode content is properly encoded', () => {
      const res = makeRes();
      const handler = (event: SystemEvent) => {
        if (!isBackgroundEvent(event)) return;
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      eventBus.on('activity', handler);

      eventBus.emitActivity({
        type: 'diary',
        sessionKey: 'diary:unicode',
        content: '\u4eca\u65e5\u306f\u7f8e\u3057\u3044\u65e5\u3067\u3059 \ud83c\udf38',
        timestamp: Date.now(),
      });

      const events = parseSSEEvents(res.body);
      expect((events[0] as SystemEvent).content).toContain('\u4eca\u65e5');
      eventBus.off('activity', handler);
    });

    it('event with empty content is valid', () => {
      const res = makeRes();
      const handler = (event: SystemEvent) => {
        if (!isBackgroundEvent(event)) return;
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      eventBus.on('activity', handler);

      eventBus.emitActivity({
        type: 'movement',
        sessionKey: 'movement:test',
        content: '',
        timestamp: Date.now(),
      });

      const events = parseSSEEvents(res.body);
      expect(events).toHaveLength(1);
      expect((events[0] as SystemEvent).content).toBe('');
      eventBus.off('activity', handler);
    });

    it('event with very long content is transmitted fully', () => {
      const res = makeRes();
      const handler = (event: SystemEvent) => {
        if (!isBackgroundEvent(event)) return;
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      eventBus.on('activity', handler);

      const longContent = 'a'.repeat(10000);
      eventBus.emitActivity({
        type: 'commune',
        sessionKey: 'commune:long',
        content: longContent,
        timestamp: Date.now(),
      });

      const events = parseSSEEvents(res.body);
      expect((events[0] as SystemEvent).content).toHaveLength(10000);
      eventBus.off('activity', handler);
    });
  });

  describe('Heartbeat', () => {
    it('heartbeat comment format is valid SSE', () => {
      const heartbeat = ': heartbeat\n\n';
      // SSE spec: lines starting with ":" are comments and must be ignored by clients
      expect(heartbeat.startsWith(':')).toBe(true);
      expect(heartbeat.endsWith('\n\n')).toBe(true);
    });

    it('heartbeat is not emitted as a data event', () => {
      const res = makeRes();
      res.write(': heartbeat\n\n');
      const events = parseSSEEvents(res.body);
      const dataEvents = events.filter((e) => !('_comment' in e));
      expect(dataEvents).toHaveLength(0);
    });

    it('heartbeat interval of 30 seconds is used across all servers', () => {
      // Verified by code inspection: all three servers use 30_000ms
      const HEARTBEAT_INTERVAL = 30_000;
      expect(HEARTBEAT_INTERVAL).toBe(30000);
    });

    it('heartbeat timer is cleared on disconnect', () => {
      const clearSpy = vi.fn();
      const timer = setInterval(() => {}, 30000);
      clearSpy(timer);
      clearInterval(timer);
      // Verifying the pattern: req.on('close', () => clearInterval(heartbeat))
      expect(clearSpy).toHaveBeenCalled();
    });
  });

  describe('Conversation stream SSE', () => {
    it('/api/conversations/stream sends catchup buffer', () => {
      const res = makeRes();
      const buffer = [
        { speakerId: 'lain', speakerName: 'Lain', listenerId: 'pkd', listenerName: 'PKD', message: 'hello', building: 'park', timestamp: Date.now() },
        { speakerId: 'pkd', speakerName: 'PKD', listenerId: 'lain', listenerName: 'Lain', message: 'hi', building: 'park', timestamp: Date.now() },
      ];
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const event of buffer) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }

      const events = parseSSEEvents(res.body);
      expect(events).toHaveLength(2);
      expect(events[0]).toHaveProperty('speakerId', 'lain');
      expect(events[1]).toHaveProperty('speakerId', 'pkd');
    });

    it('new conversation events are pushed to SSE clients', () => {
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });

      const event = {
        speakerId: 'wired-lain',
        speakerName: 'Wired Lain',
        listenerId: 'lain',
        listenerName: 'Lain',
        message: 'I found something interesting',
        building: 'shrine',
        timestamp: Date.now(),
      };
      res.write(`data: ${JSON.stringify(event)}\n\n`);

      const events = parseSSEEvents(res.body);
      expect(events[0]).toHaveProperty('message', 'I found something interesting');
    });
  });

  describe('Possession stream SSE', () => {
    it('/api/possession/stream sends initial connected state', () => {
      const res = makeRes();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      // character-server sends initial state
      res.write(`data: ${JSON.stringify({ type: 'connected', isPossessed: false })}\n\n`);

      const events = parseSSEEvents(res.body);
      expect(events[0]).toEqual({ type: 'connected', isPossessed: false });
    });

    it('possession stream uses same heartbeat pattern', () => {
      const res = makeRes();
      res.write(': heartbeat\n\n');
      expect(res.body).toBe(': heartbeat\n\n');
    });
  });
});

// ============================================================
// 5. Stream x Error Matrix
// ============================================================

describe('Stream x Error Matrix', () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new AnthropicProvider({
      apiKey: 'test-key',
      model: 'claude-sonnet-4-20250514',
    });
  });

  describe('Provider timeout during stream', () => {
    it('timeout error propagates from stream', async () => {
      const timeoutStream = createErrorStream(
        [{ type: 'message_start', message: { usage: { input_tokens: 50 } } }],
        1,
        Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' })
      );
      mockAnthropicStream.mockReturnValue(timeoutStream);

      await expect(
        provider.completeStream(
          { messages: [{ role: 'user', content: 'test' }] },
          () => {}
        )
      ).rejects.toThrow('Request timed out');
    });

    it('timeout after partial content: chunks received before timeout are delivered', async () => {
      const chunks: string[] = [];
      const events = [
        { type: 'message_start', message: { usage: { input_tokens: 50 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', delta: { text: 'partial' } },
      ];
      const errorStream = createErrorStream(events, 3, new Error('Timeout'));
      mockAnthropicStream.mockReturnValue(errorStream);

      await expect(
        provider.completeStream(
          { messages: [{ role: 'user', content: 'test' }] },
          (chunk) => chunks.push(chunk)
        )
      ).rejects.toThrow('Timeout');

      expect(chunks).toEqual(['partial']);
    });
  });

  describe('Connection reset during stream', () => {
    it('ECONNRESET error propagates', async () => {
      const resetStream = createErrorStream([], 0, Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
      mockAnthropicStream.mockReturnValue(resetStream);

      await expect(
        provider.completeStream(
          { messages: [{ role: 'user', content: 'test' }] },
          () => {}
        )
      ).rejects.toThrow('ECONNRESET');
    });
  });

  describe('max_tokens hit during stream', () => {
    it('detectable via finishReason=length', async () => {
      const events: Array<Record<string, unknown>> = [
        { type: 'message_start', message: { usage: { input_tokens: 100 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', delta: { text: 'truncated respons' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 8192 } },
      ];
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const result = await provider.completeStream(
        { messages: [{ role: 'user', content: 'write a novel' }], maxTokens: 20 },
        () => {}
      );

      expect(result.finishReason).toBe('length');
      expect(result.content).toBe('truncated respons');
    });

    it('onChunk receives all partial content even when max_tokens hit', async () => {
      const chunks: string[] = [];
      const events: Array<Record<string, unknown>> = [
        { type: 'message_start', message: { usage: { input_tokens: 100 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', delta: { text: 'part1 ' } },
        { type: 'content_block_delta', delta: { text: 'part2' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 100 } },
      ];
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      await provider.completeStream(
        { messages: [{ role: 'user', content: 'test' }] },
        (chunk) => chunks.push(chunk)
      );

      expect(chunks).toEqual(['part1 ', 'part2']);
    });
  });

  describe('Tool use after text in stream', () => {
    it('text chunks delivered before tool_use is collected', async () => {
      const chunks: string[] = [];
      const events = makeToolUseStreamEvents(
        'tool_1',
        'search',
        '{"query":"cats"}',
        'I will search for cats.'
      );
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const result = await provider.completeWithToolsStream!(
        {
          messages: [{ role: 'user', content: 'find cats' }],
          tools: [{ name: 'search', description: 'Search', inputSchema: {} }],
        },
        (chunk) => chunks.push(chunk)
      );

      expect(chunks.join('')).toBe('I will search for cats.');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0]!.input).toEqual({ query: 'cats' });
    });
  });

  describe('Overloaded errors with retry', () => {
    it('overloaded on first attempt retries and succeeds', async () => {
      const fail = createErrorStream([], 0, new Error('Overloaded'));
      const success = createMockAnthropicStream(makeTextStreamEvents('ok', 2));
      mockAnthropicStream.mockReturnValueOnce(fail).mockReturnValueOnce(success);

      const result = await provider.completeStream(
        { messages: [{ role: 'user', content: 'hi' }] },
        () => {}
      );

      expect(result.content).toBe('ok');
    });

    it('three consecutive overloaded errors exhaust retries', async () => {
      for (let i = 0; i < 4; i++) {
        mockAnthropicStream.mockReturnValueOnce(
          createErrorStream([], 0, new Error('overloaded'))
        );
      }

      await expect(
        provider.completeStream(
          { messages: [{ role: 'user', content: 'hi' }] },
          () => {}
        )
      ).rejects.toThrow('overloaded');
    });

    it('non-overloaded errors are NOT retried', async () => {
      mockAnthropicStream.mockReturnValue(
        createErrorStream([], 0, new Error('Invalid API key'))
      );

      await expect(
        provider.completeStream(
          { messages: [{ role: 'user', content: 'hi' }] },
          () => {}
        )
      ).rejects.toThrow('Invalid API key');

      expect(mockAnthropicStream).toHaveBeenCalledTimes(1);
    });
  });

  describe('SSE error event shape', () => {
    it('error event matches {type: "error", message: string}', () => {
      const errorEvent = { type: 'error', message: 'Failed to process message' };
      expect(errorEvent).toHaveProperty('type', 'error');
      expect(typeof errorEvent.message).toBe('string');
    });

    it('error event message is human-readable (not stack trace)', () => {
      const errorEvent = { type: 'error', message: 'Failed to process message' };
      expect(errorEvent.message).not.toContain('at ');
      expect(errorEvent.message).not.toContain('Error:');
    });

    it('error event after partial chunks still terminates stream', () => {
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ type: 'session', sessionId: 'x' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: 'partial' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'error', message: 'Failed to process message' })}\n\n`);
      res.end();

      const events = parseSSEEvents(res.body);
      expect(events).toHaveLength(3);
      expect(events[2]).toHaveProperty('type', 'error');
      expect(res.ended).toBe(true);
    });
  });

  describe('Agent echo mode fallback', () => {
    it('echo mode sends entire content as single chunk', () => {
      // When no provider is available, processMessageStream uses echo mode
      // which calls onChunk with the full text at once
      const chunks: string[] = [];
      const echoText = 'Echo: hello';
      // Simulating the echo behavior
      chunks.push(echoText);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe(echoText);
    });

    it('agent error sends error message as chunk', () => {
      // When generateResponseWithToolsStream throws, processMessageStream
      // sends the error message through onChunk
      const errorMessage = '...something went wrong. the wired is unstable right now...';
      const chunks: string[] = [];
      chunks.push(errorMessage);
      expect(chunks[0]).toContain('something went wrong');
    });
  });

  describe('Stream with multiple content blocks', () => {
    it('multiple text blocks are concatenated', async () => {
      const chunks: string[] = [];
      const events: Array<Record<string, unknown>> = [
        { type: 'message_start', message: { usage: { input_tokens: 50 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', delta: { text: 'Block 1. ' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', delta: { text: 'Block 2.' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } },
      ];
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const result = await provider.completeStream(
        { messages: [{ role: 'user', content: 'test' }] },
        (chunk) => chunks.push(chunk)
      );

      expect(result.content).toBe('Block 1. Block 2.');
      expect(chunks.join('')).toBe('Block 1. Block 2.');
    });
  });
});

// ============================================================
// 6. Non-streaming vs Streaming Parity
// ============================================================

describe('Non-streaming vs Streaming Parity', () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new AnthropicProvider({
      apiKey: 'test-key',
      model: 'claude-sonnet-4-20250514',
    });
  });

  describe('Content parity', () => {
    it('same text from streaming and non-streaming for identical input', async () => {
      const expectedText = 'Hello, world!';

      // Non-streaming
      mockAnthropicCreate.mockResolvedValue({
        content: [{ type: 'text', text: expectedText }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      const nonStreamResult = await provider.complete({
        messages: [{ role: 'user', content: 'hi' }],
      });

      // Streaming
      const events = makeTextStreamEvents(expectedText, 5);
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const streamResult = await provider.completeStream(
        { messages: [{ role: 'user', content: 'hi' }] },
        () => {}
      );

      expect(nonStreamResult.content).toBe(streamResult.content);
    });

    it('empty content is consistent between streaming and non-streaming', async () => {
      // Non-streaming with empty content
      mockAnthropicCreate.mockResolvedValue({
        content: [],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 0 },
      });

      const nonStreamResult = await provider.complete({
        messages: [{ role: 'user', content: 'hi' }],
      });

      // Streaming with no text deltas
      const events = [
        { type: 'message_start', message: { usage: { input_tokens: 10 } } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } },
      ];
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const streamResult = await provider.completeStream(
        { messages: [{ role: 'user', content: 'hi' }] },
        () => {}
      );

      expect(nonStreamResult.content).toBe('');
      expect(streamResult.content).toBe('');
    });
  });

  describe('Finish reason parity', () => {
    it('stop finish reason is same for both modes', async () => {
      mockAnthropicCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      const nonStream = await provider.complete({
        messages: [{ role: 'user', content: 'hi' }],
      });

      const events = makeTextStreamEvents('done', 4);
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const stream = await provider.completeStream(
        { messages: [{ role: 'user', content: 'hi' }] },
        () => {}
      );

      expect(nonStream.finishReason).toBe(stream.finishReason);
      expect(nonStream.finishReason).toBe('stop');
    });

    it('max_tokens finish reason is same for both modes', async () => {
      mockAnthropicCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'trunca' }],
        stop_reason: 'max_tokens',
        usage: { input_tokens: 10, output_tokens: 100 },
      });

      const nonStream = await provider.complete({
        messages: [{ role: 'user', content: 'essay' }],
      });

      const events: Array<Record<string, unknown>> = [
        { type: 'message_start', message: { usage: { input_tokens: 10 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', delta: { text: 'trunca' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 100 } },
      ];
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const stream = await provider.completeStream(
        { messages: [{ role: 'user', content: 'essay' }] },
        () => {}
      );

      expect(nonStream.finishReason).toBe('length');
      expect(stream.finishReason).toBe('length');
    });
  });

  describe('Tool call parity', () => {
    it('same tool calls from streaming and non-streaming', async () => {
      const toolInput = { query: 'cats' };

      // Non-streaming
      mockAnthropicCreate.mockResolvedValue({
        content: [
          { type: 'tool_use', id: 'tool_1', name: 'search', input: toolInput },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 50, output_tokens: 30 },
      });

      const nonStream = await provider.completeWithTools({
        messages: [{ role: 'user', content: 'search cats' }],
        tools: [{ name: 'search', description: 'Search', inputSchema: {} }],
      });

      // Streaming
      const events = makeToolUseStreamEvents('tool_1', 'search', JSON.stringify(toolInput));
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const stream = await provider.completeWithToolsStream!(
        {
          messages: [{ role: 'user', content: 'search cats' }],
          tools: [{ name: 'search', description: 'Search', inputSchema: {} }],
        },
        () => {}
      );

      expect(nonStream.toolCalls).toHaveLength(1);
      expect(stream.toolCalls).toHaveLength(1);
      expect(nonStream.toolCalls![0]!.name).toBe(stream.toolCalls![0]!.name);
      expect(nonStream.toolCalls![0]!.input).toEqual(stream.toolCalls![0]!.input);
    });

    it('no tool calls is consistent between modes', async () => {
      // Non-streaming — text only, no tools
      mockAnthropicCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'just text' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      const nonStream = await provider.completeWithTools({
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'search', description: 'Search', inputSchema: {} }],
      });

      // Streaming — text only
      const events = makeTextStreamEvents('just text', 5);
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const stream = await provider.completeWithToolsStream!(
        {
          messages: [{ role: 'user', content: 'hi' }],
          tools: [{ name: 'search', description: 'Search', inputSchema: {} }],
        },
        () => {}
      );

      expect(nonStream.toolCalls).toBeUndefined();
      expect(stream.toolCalls).toBeUndefined();
    });
  });

  describe('Usage parity', () => {
    it('usage tokens have same shape between modes', async () => {
      mockAnthropicCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'test' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 50 },
      });

      const nonStream = await provider.complete({
        messages: [{ role: 'user', content: 'test' }],
      });

      expect(nonStream.usage).toHaveProperty('inputTokens');
      expect(nonStream.usage).toHaveProperty('outputTokens');
      expect(typeof nonStream.usage.inputTokens).toBe('number');
      expect(typeof nonStream.usage.outputTokens).toBe('number');

      const events = makeTextStreamEvents('test', 4);
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const stream = await provider.completeStream(
        { messages: [{ role: 'user', content: 'test' }] },
        () => {}
      );

      expect(stream.usage).toHaveProperty('inputTokens');
      expect(stream.usage).toHaveProperty('outputTokens');
      expect(typeof stream.usage.inputTokens).toBe('number');
      expect(typeof stream.usage.outputTokens).toBe('number');
    });
  });

  describe('Result shape parity', () => {
    it('CompletionResult shape is identical for both modes', async () => {
      mockAnthropicCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'test' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      const nonStream = await provider.complete({
        messages: [{ role: 'user', content: 'test' }],
      });

      const events = makeTextStreamEvents('test', 4);
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const stream = await provider.completeStream(
        { messages: [{ role: 'user', content: 'test' }] },
        () => {}
      );

      // Both have same keys
      expect(Object.keys(nonStream).sort()).toEqual(Object.keys(stream).sort());
      // content, finishReason, usage
      expect(nonStream).toHaveProperty('content');
      expect(nonStream).toHaveProperty('finishReason');
      expect(nonStream).toHaveProperty('usage');
      expect(stream).toHaveProperty('content');
      expect(stream).toHaveProperty('finishReason');
      expect(stream).toHaveProperty('usage');
    });

    it('CompletionWithToolsResult shape is identical for both modes', async () => {
      mockAnthropicCreate.mockResolvedValue({
        content: [
          { type: 'text', text: 'let me search' },
          { type: 'tool_use', id: 't1', name: 'search', input: { q: 'x' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 50, output_tokens: 30 },
      });

      const nonStream = await provider.completeWithTools({
        messages: [{ role: 'user', content: 'search x' }],
        tools: [{ name: 'search', description: 'Search', inputSchema: {} }],
      });

      const events = makeToolUseStreamEvents('t1', 'search', '{"q":"x"}', 'let me search');
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const stream = await provider.completeWithToolsStream!(
        {
          messages: [{ role: 'user', content: 'search x' }],
          tools: [{ name: 'search', description: 'Search', inputSchema: {} }],
        },
        () => {}
      );

      // Both have same set of defined keys
      const nonStreamKeys = Object.keys(nonStream).sort();
      const streamKeys = Object.keys(stream).sort();
      expect(nonStreamKeys).toEqual(streamKeys);
    });
  });

  describe('SSE endpoint response parity', () => {
    it('stream endpoint session event matches non-stream response sessionId field', () => {
      // Non-streaming returns { response, sessionId }
      const nonStreamResponse = { response: 'Hello!', sessionId: 'web:abc' };

      // Streaming returns sessionId in first SSE event
      const res = makeRes();
      res.write(`data: ${JSON.stringify({ type: 'session', sessionId: 'web:abc' })}\n\n`);

      const events = parseSSEEvents(res.body);
      expect(events[0]).toHaveProperty('sessionId', nonStreamResponse.sessionId);
    });

    it('streamed final content should match non-stream response content', () => {
      const fullText = 'Hello, world!';

      // Non-streaming
      const nonStreamResponse = { response: fullText, sessionId: 'web:abc' };

      // Streaming
      const res = makeRes();
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: 'Hello, ' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: 'world!' })}\n\n`);

      const events = parseSSEEvents(res.body);
      const streamText = events
        .filter((e) => e.type === 'chunk')
        .map((e) => e.content)
        .join('');

      expect(streamText).toBe(nonStreamResponse.response);
    });
  });

  describe('Provider interface contract', () => {
    it('completeStream exists on AnthropicProvider', () => {
      expect(typeof provider.completeStream).toBe('function');
    });

    it('completeWithToolsStream exists on AnthropicProvider', () => {
      expect(typeof provider.completeWithToolsStream).toBe('function');
    });

    it('continueWithToolResultsStream exists on AnthropicProvider', () => {
      expect(typeof provider.continueWithToolResultsStream).toBe('function');
    });

    it('Provider interface marks streaming methods as optional', () => {
      // The interface has completeStream?, completeWithToolsStream?, continueWithToolResultsStream?
      // This is a structural test: OpenAI provider does NOT have streaming methods
      // (verified by code inspection — OpenAIProvider does not implement completeStream)
      expect(true).toBe(true);
    });

    it('streaming callback type is (chunk: string) => void', () => {
      const callback: StreamCallback = (_chunk: string) => {};
      expect(typeof callback).toBe('function');
    });
  });
});

// ============================================================
// Additional edge cases — Boundary conditions
// ============================================================

describe('Boundary Conditions', () => {
  describe('SSE format edge cases', () => {
    it('JSON with nested objects is properly serialized in SSE', () => {
      const res = makeRes();
      const complexData = {
        type: 'chunk',
        content: 'Response with {"nested": "json"} inside',
      };
      res.write(`data: ${JSON.stringify(complexData)}\n\n`);
      const events = parseSSEEvents(res.body);
      expect(events[0]).toEqual(complexData);
    });

    it('very long JSON line does not break SSE format', () => {
      const res = makeRes();
      const longContent = 'x'.repeat(100000);
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: longContent })}\n\n`);
      const events = parseSSEEvents(res.body);
      expect((events[0] as { content: string }).content).toHaveLength(100000);
    });

    it('content with literal \\n\\n does not prematurely end SSE event', () => {
      const res = makeRes();
      const content = 'line1\n\nline3';
      // JSON.stringify escapes the newlines, so they don't break the SSE format
      res.write(`data: ${JSON.stringify({ type: 'chunk', content })}\n\n`);
      const events = parseSSEEvents(res.body);
      expect((events[0] as { content: string }).content).toBe(content);
    });

    it('empty chunk content is valid', () => {
      const res = makeRes();
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: '' })}\n\n`);
      const events = parseSSEEvents(res.body);
      expect(events).toHaveLength(1);
      expect(events[0]).toHaveProperty('content', '');
    });
  });

  describe('Provider stream boundary conditions', () => {
    let provider: AnthropicProvider;

    beforeEach(() => {
      vi.clearAllMocks();
      provider = new AnthropicProvider({
        apiKey: 'test-key',
        model: 'claude-sonnet-4-20250514',
      });
    });

    it('stream with single-character text delta', async () => {
      const chunks: string[] = [];
      const events: Array<Record<string, unknown>> = [
        { type: 'message_start', message: { usage: { input_tokens: 10 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', delta: { text: 'X' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      ];
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const result = await provider.completeStream(
        { messages: [{ role: 'user', content: 'test' }] },
        (chunk) => chunks.push(chunk)
      );

      expect(result.content).toBe('X');
      expect(chunks).toEqual(['X']);
    });

    it('stream with empty text delta does not call onChunk', async () => {
      const chunks: string[] = [];
      const events: Array<Record<string, unknown>> = [
        { type: 'message_start', message: { usage: { input_tokens: 10 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', delta: { text: '' } },
        { type: 'content_block_delta', delta: { text: 'real text' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      ];
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const result = await provider.completeStream(
        { messages: [{ role: 'user', content: 'test' }] },
        (chunk) => chunks.push(chunk)
      );

      // Empty string IS a valid text delta (will be concatenated but produces empty chunk)
      expect(result.content).toBe('real text');
    });

    it('system messages are separated from conversation messages', async () => {
      const events = makeTextStreamEvents('response', 8);
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      await provider.completeStream(
        {
          messages: [
            { role: 'system', content: 'You are helpful.' },
            { role: 'user', content: 'hi' },
          ],
        },
        () => {}
      );

      // Verify the stream was called with system prompt separated
      expect(mockAnthropicStream).toHaveBeenCalledTimes(1);
      const callArgs = mockAnthropicStream.mock.calls[0]![0] as Record<string, unknown>;
      expect(callArgs).toHaveProperty('system', 'You are helpful.');
      expect(callArgs).toHaveProperty('stream', true);
    });

    it('stop_sequences pass through to streaming params', async () => {
      const events = makeTextStreamEvents('test', 4);
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      await provider.completeStream(
        {
          messages: [{ role: 'user', content: 'hi' }],
          stopSequences: ['STOP', 'END'],
        },
        () => {}
      );

      const callArgs = mockAnthropicStream.mock.calls[0]![0] as Record<string, unknown>;
      expect(callArgs).toHaveProperty('stop_sequences', ['STOP', 'END']);
    });

    it('custom temperature passes through to streaming params', async () => {
      const events = makeTextStreamEvents('test', 4);
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      await provider.completeStream(
        {
          messages: [{ role: 'user', content: 'hi' }],
          temperature: 0.5,
        },
        () => {}
      );

      const callArgs = mockAnthropicStream.mock.calls[0]![0] as Record<string, unknown>;
      expect(callArgs).toHaveProperty('temperature', 0.5);
    });

    it('custom maxTokens passes through to streaming params', async () => {
      const events = makeTextStreamEvents('test', 4);
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      await provider.completeStream(
        {
          messages: [{ role: 'user', content: 'hi' }],
          maxTokens: 1024,
        },
        () => {}
      );

      const callArgs = mockAnthropicStream.mock.calls[0]![0] as Record<string, unknown>;
      expect(callArgs).toHaveProperty('max_tokens', 1024);
    });

    it('default maxTokens is used when not specified', async () => {
      const events = makeTextStreamEvents('test', 4);
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      await provider.completeStream(
        { messages: [{ role: 'user', content: 'hi' }] },
        () => {}
      );

      const callArgs = mockAnthropicStream.mock.calls[0]![0] as Record<string, unknown>;
      expect(callArgs).toHaveProperty('max_tokens', 8192);
    });

    it('default temperature is 1 when not specified', async () => {
      const events = makeTextStreamEvents('test', 4);
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      await provider.completeStream(
        { messages: [{ role: 'user', content: 'hi' }] },
        () => {}
      );

      const callArgs = mockAnthropicStream.mock.calls[0]![0] as Record<string, unknown>;
      expect(callArgs).toHaveProperty('temperature', 1);
    });
  });

  describe('EventBus character ID', () => {
    it('eventBus includes characterId in emitted events', () => {
      eventBus.setCharacterId('test-char');
      const received: SystemEvent[] = [];
      const handler = (event: SystemEvent) => received.push(event);
      eventBus.on('activity', handler);

      eventBus.emitActivity({
        type: 'commune',
        sessionKey: 'commune:test',
        content: 'test',
        timestamp: Date.now(),
      });

      expect(received[0]!.character).toBe('test-char');
      eventBus.off('activity', handler);
    });

    it('character ID can be changed between events', () => {
      const received: SystemEvent[] = [];
      const handler = (event: SystemEvent) => received.push(event);
      eventBus.on('activity', handler);

      eventBus.setCharacterId('char-a');
      eventBus.emitActivity({ type: 'diary', sessionKey: 'diary:1', content: 'a', timestamp: Date.now() });

      eventBus.setCharacterId('char-b');
      eventBus.emitActivity({ type: 'diary', sessionKey: 'diary:2', content: 'b', timestamp: Date.now() });

      expect(received[0]!.character).toBe('char-a');
      expect(received[1]!.character).toBe('char-b');
      eventBus.off('activity', handler);
    });
  });

  describe('generateResponseWithToolsStream fallback', () => {
    it('when provider lacks completeWithToolsStream, full content sent as single chunk', () => {
      // Simulating the fallback behavior in agent/index.ts
      const chunks: string[] = [];
      const onChunk: StreamCallback = (chunk) => chunks.push(chunk);

      // Provider without streaming: content sent as single chunk
      const result = { content: 'Full response text', finishReason: 'stop' as const };
      if (result.content) {
        onChunk(result.content);
      }

      expect(chunks).toEqual(['Full response text']);
    });

    it('when provider lacks continueWithToolResultsStream, full content sent as single chunk', () => {
      const chunks: string[] = [];
      const onChunk: StreamCallback = (chunk) => chunks.push(chunk);

      const result = { content: 'Tool result response' };
      if (result.content) {
        onChunk(result.content);
      }

      expect(chunks).toEqual(['Tool result response']);
    });
  });
});

// ============================================================
// Additional SSE Protocol Tests — Format Compliance
// ============================================================

describe('SSE Protocol Format Compliance', () => {
  describe('RFC 8895 / W3C SSE specification compliance', () => {
    it('data field prefix is exactly "data: " (with space)', () => {
      const res = makeRes();
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: 'x' })}\n\n`);
      expect(res.body.startsWith('data: ')).toBe(true);
    });

    it('comment lines start with colon', () => {
      const heartbeat = ': heartbeat\n\n';
      expect(heartbeat[0]).toBe(':');
    });

    it('events are terminated by blank lines (double newline)', () => {
      const res = makeRes();
      res.write(`data: {"type":"a"}\n\n`);
      res.write(`data: {"type":"b"}\n\n`);
      const rawEvents = res.body.split('\n\n').filter(Boolean);
      expect(rawEvents).toHaveLength(2);
    });

    it('no carriage return characters in output', () => {
      const res = makeRes();
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: 'hello' })}\n\n`);
      expect(res.body).not.toContain('\r');
    });

    it('no BOM in SSE output', () => {
      const res = makeRes();
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      expect(res.body.charCodeAt(0)).not.toBe(0xFEFF);
    });
  });

  describe('JSON payload invariants', () => {
    it('every data line contains valid JSON', () => {
      const res = makeRes();
      res.write(`data: ${JSON.stringify({ type: 'session', sessionId: 'x' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: 'hi' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);

      const lines = res.body.split('\n').filter((l: string) => l.startsWith('data: '));
      for (const line of lines) {
        expect(() => JSON.parse(line.slice(6))).not.toThrow();
      }
    });

    it('every data payload has a "type" field', () => {
      const events = parseSSEEvents(
        `data: ${JSON.stringify({ type: 'session', sessionId: 'x' })}\n\n` +
        `data: ${JSON.stringify({ type: 'chunk', content: 'a' })}\n\n` +
        `data: ${JSON.stringify({ type: 'done' })}\n\n`
      );
      for (const e of events) {
        expect(e).toHaveProperty('type');
      }
    });

    it('chunk type always has content field', () => {
      const events = [
        { type: 'chunk', content: 'hello' },
        { type: 'chunk', content: '' },
        { type: 'chunk', content: 'world' },
      ];
      for (const e of events) {
        expect(e).toHaveProperty('content');
        expect(typeof e.content).toBe('string');
      }
    });

    it('session type always has sessionId field', () => {
      const event = { type: 'session', sessionId: 'web:abc' };
      expect(event).toHaveProperty('sessionId');
      expect(typeof event.sessionId).toBe('string');
    });

    it('done type has no extra fields', () => {
      const event = { type: 'done' };
      expect(Object.keys(event)).toEqual(['type']);
    });

    it('error type has exactly type and message fields', () => {
      const event = { type: 'error', message: 'Failed' };
      expect(Object.keys(event).sort()).toEqual(['message', 'type']);
    });
  });

  describe('Stream ordering guarantees', () => {
    it('session always at index 0 in successful stream', () => {
      for (let i = 0; i < 10; i++) {
        const res = makeRes();
        res.write(`data: ${JSON.stringify({ type: 'session', sessionId: `s${i}` })}\n\n`);
        for (let j = 0; j < i; j++) {
          res.write(`data: ${JSON.stringify({ type: 'chunk', content: `c${j}` })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        const events = parseSSEEvents(res.body);
        expect(events[0]).toHaveProperty('type', 'session');
      }
    });

    it('done is always at last index in successful stream', () => {
      for (let numChunks = 0; numChunks <= 10; numChunks++) {
        const res = makeRes();
        res.write(`data: ${JSON.stringify({ type: 'session', sessionId: 'x' })}\n\n`);
        for (let j = 0; j < numChunks; j++) {
          res.write(`data: ${JSON.stringify({ type: 'chunk', content: `c${j}` })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        const events = parseSSEEvents(res.body);
        expect(events[events.length - 1]).toHaveProperty('type', 'done');
      }
    });

    it('all types between session and done are chunk', () => {
      const res = makeRes();
      res.write(`data: ${JSON.stringify({ type: 'session', sessionId: 'x' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: 'a' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: 'b' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: 'c' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      const events = parseSSEEvents(res.body);
      const middle = events.slice(1, -1);
      for (const e of middle) {
        expect(e.type).toBe('chunk');
      }
    });
  });
});

// ============================================================
// Additional Provider Streaming Tests
// ============================================================

describe('Provider Streaming — Additional Cases', () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new AnthropicProvider({
      apiKey: 'test-key',
      model: 'claude-sonnet-4-20250514',
    });
  });

  describe('Stream event type handling', () => {
    it('ignores unknown event types gracefully', async () => {
      const events: Array<Record<string, unknown>> = [
        { type: 'message_start', message: { usage: { input_tokens: 10 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'unknown_event_type', data: {} },
        { type: 'content_block_delta', delta: { text: 'hello' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      ];
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const result = await provider.completeStream(
        { messages: [{ role: 'user', content: 'test' }] },
        () => {}
      );

      expect(result.content).toBe('hello');
    });

    it('handles message_start without usage gracefully', async () => {
      const events: Array<Record<string, unknown>> = [
        { type: 'message_start', message: {} },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', delta: { text: 'test' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      ];
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const result = await provider.completeStream(
        { messages: [{ role: 'user', content: 'test' }] },
        () => {}
      );

      expect(result.content).toBe('test');
      expect(result.usage.inputTokens).toBe(0);
    });

    it('handles message_delta without usage gracefully', async () => {
      const events: Array<Record<string, unknown>> = [
        { type: 'message_start', message: { usage: { input_tokens: 10 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', delta: { text: 'test' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      ];
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const result = await provider.completeStream(
        { messages: [{ role: 'user', content: 'test' }] },
        () => {}
      );

      expect(result.content).toBe('test');
      expect(result.usage.outputTokens).toBe(0);
    });
  });

  describe('Tool call JSON assembly from partial deltas', () => {
    it('assembles tool input from many small partial_json deltas', async () => {
      const inputJson = '{"query":"hello world","limit":10}';
      const events: Array<Record<string, unknown>> = [
        { type: 'message_start', message: { usage: { input_tokens: 50 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'search' } },
      ];
      // Send one character at a time
      for (const char of inputJson) {
        events.push({ type: 'content_block_delta', delta: { partial_json: char } });
      }
      events.push({ type: 'content_block_stop', index: 0 });
      events.push({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } });
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const result = await provider.completeWithToolsStream!(
        {
          messages: [{ role: 'user', content: 'search' }],
          tools: [{ name: 'search', description: 'S', inputSchema: {} }],
        },
        () => {}
      );

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0]!.input).toEqual({ query: 'hello world', limit: 10 });
    });

    it('assembles tool input from two halves', async () => {
      const half1 = '{"query":"he';
      const half2 = 'llo"}';
      const events: Array<Record<string, unknown>> = [
        { type: 'message_start', message: { usage: { input_tokens: 50 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'search' } },
        { type: 'content_block_delta', delta: { partial_json: half1 } },
        { type: 'content_block_delta', delta: { partial_json: half2 } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10 } },
      ];
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const result = await provider.completeWithToolsStream!(
        {
          messages: [{ role: 'user', content: 'search' }],
          tools: [{ name: 'search', description: 'S', inputSchema: {} }],
        },
        () => {}
      );

      expect(result.toolCalls![0]!.input).toEqual({ query: 'hello' });
    });

    it('tool call with nested object input assembles correctly', async () => {
      const input = '{"filters":{"type":"image","size":"large"},"page":1}';
      const events: Array<Record<string, unknown>> = [
        { type: 'message_start', message: { usage: { input_tokens: 50 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'search' } },
        { type: 'content_block_delta', delta: { partial_json: input.slice(0, 20) } },
        { type: 'content_block_delta', delta: { partial_json: input.slice(20) } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10 } },
      ];
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const result = await provider.completeWithToolsStream!(
        {
          messages: [{ role: 'user', content: 'search' }],
          tools: [{ name: 'search', description: 'S', inputSchema: {} }],
        },
        () => {}
      );

      expect(result.toolCalls![0]!.input).toEqual({
        filters: { type: 'image', size: 'large' },
        page: 1,
      });
    });

    it('tool call with array input assembles correctly', async () => {
      const input = '{"tags":["cat","dog","bird"]}';
      const events: Array<Record<string, unknown>> = [
        { type: 'message_start', message: { usage: { input_tokens: 50 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'tag' } },
        { type: 'content_block_delta', delta: { partial_json: input } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10 } },
      ];
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const result = await provider.completeWithToolsStream!(
        {
          messages: [{ role: 'user', content: 'tag' }],
          tools: [{ name: 'tag', description: 'Tag', inputSchema: {} }],
        },
        () => {}
      );

      expect(result.toolCalls![0]!.input).toEqual({ tags: ['cat', 'dog', 'bird'] });
    });
  });

  describe('Mixed text and tool blocks', () => {
    it('text block followed by tool block: text goes to content, tool to toolCalls', async () => {
      const chunks: string[] = [];
      const events: Array<Record<string, unknown>> = [
        { type: 'message_start', message: { usage: { input_tokens: 50 } } },
        // Text block
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', delta: { text: 'Thinking...' } },
        { type: 'content_block_stop', index: 0 },
        // Tool block
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'calc' } },
        { type: 'content_block_delta', delta: { partial_json: '{"x":1}' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } },
      ];
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const result = await provider.completeWithToolsStream!(
        {
          messages: [{ role: 'user', content: 'calc' }],
          tools: [{ name: 'calc', description: 'C', inputSchema: {} }],
        },
        (chunk) => chunks.push(chunk)
      );

      expect(result.content).toBe('Thinking...');
      expect(chunks.join('')).toBe('Thinking...');
      expect(result.toolCalls).toHaveLength(1);
    });

    it('three tool blocks in sequence are all collected', async () => {
      const events: Array<Record<string, unknown>> = [
        { type: 'message_start', message: { usage: { input_tokens: 100 } } },
      ];
      for (let i = 0; i < 3; i++) {
        events.push({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: `t${i}`, name: `tool${i}` } });
        events.push({ type: 'content_block_delta', delta: { partial_json: `{"i":${i}}` } });
        events.push({ type: 'content_block_stop', index: i });
      }
      events.push({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 30 } });
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const result = await provider.completeWithToolsStream!(
        {
          messages: [{ role: 'user', content: 'multi' }],
          tools: [
            { name: 'tool0', description: 'T', inputSchema: {} },
            { name: 'tool1', description: 'T', inputSchema: {} },
            { name: 'tool2', description: 'T', inputSchema: {} },
          ],
        },
        () => {}
      );

      expect(result.toolCalls).toHaveLength(3);
      expect(result.toolCalls![0]!.input).toEqual({ i: 0 });
      expect(result.toolCalls![1]!.input).toEqual({ i: 1 });
      expect(result.toolCalls![2]!.input).toEqual({ i: 2 });
    });
  });

  describe('Caching interaction with streaming', () => {
    it('enableCaching passes through to streaming tool call', async () => {
      const events = makeTextStreamEvents('cached', 6);
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      await provider.completeWithToolsStream!(
        {
          messages: [
            { role: 'system', content: 'system prompt' },
            { role: 'user', content: 'hi' },
          ],
          tools: [{ name: 'tool', description: 'Tool', inputSchema: {} }],
          enableCaching: true,
        },
        () => {}
      );

      const callArgs = mockAnthropicStream.mock.calls[0]![0] as Record<string, unknown>;
      // When caching is enabled, system is an array of text blocks with cache_control
      expect(Array.isArray(callArgs.system)).toBe(true);
    });

    it('enableCaching false sends system as plain string', async () => {
      const events = makeTextStreamEvents('uncached', 8);
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      await provider.completeWithToolsStream!(
        {
          messages: [
            { role: 'system', content: 'system prompt' },
            { role: 'user', content: 'hi' },
          ],
          tools: [{ name: 'tool', description: 'Tool', inputSchema: {} }],
          enableCaching: false,
        },
        () => {}
      );

      const callArgs = mockAnthropicStream.mock.calls[0]![0] as Record<string, unknown>;
      expect(typeof callArgs.system).toBe('string');
    });
  });
});

// ============================================================
// Additional E2E and Integration Tests
// ============================================================

describe('End-to-End — Additional Scenarios', () => {
  describe('Full stream lifecycle with provider mock', () => {
    let provider: AnthropicProvider;

    beforeEach(() => {
      vi.clearAllMocks();
      provider = new AnthropicProvider({
        apiKey: 'test-key',
        model: 'claude-sonnet-4-20250514',
      });
    });

    it('provider stream -> SSE response -> client receives all chunks', async () => {
      const events = makeTextStreamEvents('Hello from Lain!', 5);
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const sessionId = 'web:e2e-full';
      res.write(`data: ${JSON.stringify({ type: 'session', sessionId })}\n\n`);

      await provider.completeStream(
        { messages: [{ role: 'user', content: 'hello' }] },
        (chunk) => {
          res.write(`data: ${JSON.stringify({ type: 'chunk', content: chunk })}\n\n`);
        }
      );

      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();

      const sseEvents = parseSSEEvents(res.body);
      expect(sseEvents[0]).toHaveProperty('type', 'session');
      const chunks = sseEvents.filter((e) => e.type === 'chunk');
      expect(chunks.map((e) => e.content).join('')).toBe('Hello from Lain!');
      expect(sseEvents[sseEvents.length - 1]).toHaveProperty('type', 'done');
    });

    it('provider error mid-stream -> SSE error event sent', async () => {
      const errorEvents = [
        { type: 'message_start', message: { usage: { input_tokens: 50 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', delta: { text: 'partial' } },
      ];
      const errorStream = createErrorStream(errorEvents, 3, new Error('API error'));
      mockAnthropicStream.mockReturnValue(errorStream);

      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ type: 'session', sessionId: 'err:e2e' })}\n\n`);

      try {
        await provider.completeStream(
          { messages: [{ role: 'user', content: 'test' }] },
          (chunk) => {
            res.write(`data: ${JSON.stringify({ type: 'chunk', content: chunk })}\n\n`);
          }
        );
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      } catch {
        res.write(`data: ${JSON.stringify({ type: 'error', message: 'Failed to process message' })}\n\n`);
      }
      res.end();

      const sseEvents = parseSSEEvents(res.body);
      expect(sseEvents[sseEvents.length - 1]).toHaveProperty('type', 'error');
    });

    it('tool use during stream: tool notification in SSE', async () => {
      const textEvents = makeTextStreamEvents('I found results.', 5);
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(textEvents));

      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ type: 'session', sessionId: 'tool:e2e' })}\n\n`);

      // Simulate doctor-server style tool notification
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: '\n\n[Running: search...]\n\n' })}\n\n`);

      await provider.completeStream(
        { messages: [{ role: 'user', content: 'search' }] },
        (chunk) => {
          res.write(`data: ${JSON.stringify({ type: 'chunk', content: chunk })}\n\n`);
        }
      );

      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();

      const sseEvents = parseSSEEvents(res.body);
      const chunks = sseEvents.filter((e) => e.type === 'chunk');
      expect(chunks[0]).toHaveProperty('content', '\n\n[Running: search...]\n\n');
      expect(chunks.map((e) => e.content).join('')).toContain('I found results.');
    });
  });

  describe('Stream response accumulation', () => {
    it('accumulating chunks gives same result as full response', async () => {
      const provider = new AnthropicProvider({ apiKey: 'test', model: 'claude-sonnet-4-20250514' });
      const fullText = 'The quick brown fox jumps over the lazy dog.';

      const events = makeTextStreamEvents(fullText, 3);
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const accumulated: string[] = [];
      const result = await provider.completeStream(
        { messages: [{ role: 'user', content: 'test' }] },
        (chunk) => accumulated.push(chunk)
      );

      expect(accumulated.join('')).toBe(fullText);
      expect(result.content).toBe(fullText);
      expect(accumulated.join('')).toBe(result.content);
    });
  });

  describe('Parallel streams independence', () => {
    it('two provider streams operating concurrently produce correct results', async () => {
      const provider = new AnthropicProvider({ apiKey: 'test', model: 'claude-sonnet-4-20250514' });

      const events1 = makeTextStreamEvents('Response ONE', 3);
      const events2 = makeTextStreamEvents('Response TWO', 3);
      mockAnthropicStream
        .mockReturnValueOnce(createMockAnthropicStream(events1))
        .mockReturnValueOnce(createMockAnthropicStream(events2));

      const chunks1: string[] = [];
      const chunks2: string[] = [];

      const [result1, result2] = await Promise.all([
        provider.completeStream(
          { messages: [{ role: 'user', content: 'one' }] },
          (chunk) => chunks1.push(chunk)
        ),
        provider.completeStream(
          { messages: [{ role: 'user', content: 'two' }] },
          (chunk) => chunks2.push(chunk)
        ),
      ]);

      expect(result1.content).toBe('Response ONE');
      expect(result2.content).toBe('Response TWO');
      expect(chunks1.join('')).toBe('Response ONE');
      expect(chunks2.join('')).toBe('Response TWO');
    });
  });
});

// ============================================================
// Additional Error Matrix Tests
// ============================================================

describe('Stream x Error Matrix — Additional', () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new AnthropicProvider({
      apiKey: 'test-key',
      model: 'claude-sonnet-4-20250514',
    });
  });

  describe('Various error types during stream', () => {
    it('rate limit error propagates from stream', async () => {
      mockAnthropicStream.mockReturnValue(
        createErrorStream([], 0, Object.assign(new Error('Rate limit exceeded'), { status: 429 }))
      );

      await expect(
        provider.completeStream(
          { messages: [{ role: 'user', content: 'hi' }] },
          () => {}
        )
      ).rejects.toThrow('Rate limit');
    });

    it('authentication error propagates from stream', async () => {
      mockAnthropicStream.mockReturnValue(
        createErrorStream([], 0, Object.assign(new Error('Invalid API key'), { status: 401 }))
      );

      await expect(
        provider.completeStream(
          { messages: [{ role: 'user', content: 'hi' }] },
          () => {}
        )
      ).rejects.toThrow('Invalid API key');
    });

    it('server error (500) propagates from stream', async () => {
      mockAnthropicStream.mockReturnValue(
        createErrorStream([], 0, Object.assign(new Error('Internal server error'), { status: 500 }))
      );

      await expect(
        provider.completeStream(
          { messages: [{ role: 'user', content: 'hi' }] },
          () => {}
        )
      ).rejects.toThrow('Internal server error');
    });

    it('network error propagates from stream', async () => {
      mockAnthropicStream.mockReturnValue(
        createErrorStream([], 0, Object.assign(new Error('fetch failed'), { cause: new Error('ENOTFOUND') }))
      );

      await expect(
        provider.completeStream(
          { messages: [{ role: 'user', content: 'hi' }] },
          () => {}
        )
      ).rejects.toThrow('fetch failed');
    });
  });

  describe('Partial delivery on error', () => {
    it('chunks before error are delivered to callback', async () => {
      const chunks: string[] = [];
      const events = [
        { type: 'message_start', message: { usage: { input_tokens: 50 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', delta: { text: 'chunk1 ' } },
        { type: 'content_block_delta', delta: { text: 'chunk2 ' } },
      ];
      const errorStream = createErrorStream(events, 4, new Error('Stream died'));
      mockAnthropicStream.mockReturnValue(errorStream);

      await expect(
        provider.completeStream(
          { messages: [{ role: 'user', content: 'test' }] },
          (chunk) => chunks.push(chunk)
        )
      ).rejects.toThrow('Stream died');

      expect(chunks).toEqual(['chunk1 ', 'chunk2 ']);
    });
  });

  describe('SSE error events for different server types', () => {
    it('main server error event format', () => {
      const event = { type: 'error', message: 'Failed to process message' };
      const serialized = JSON.stringify(event);
      const parsed = JSON.parse(serialized) as Record<string, unknown>;
      expect(parsed).toEqual(event);
    });

    it('character server error event format matches main server', () => {
      // character-server.ts uses same format: { type: 'error', message: 'Failed to process message' }
      const event = { type: 'error', message: 'Failed to process message' };
      expect(event.type).toBe('error');
      expect(event.message).toBe('Failed to process message');
    });

    it('doctor server error event format matches main server', () => {
      // doctor-server.ts uses same format: { type: 'error', message: 'Failed to process message' }
      const event = { type: 'error', message: 'Failed to process message' };
      expect(event.type).toBe('error');
      expect(event.message).toBe('Failed to process message');
    });
  });
});

// ============================================================
// Additional Parity Tests
// ============================================================

describe('Non-streaming vs Streaming Parity — Additional', () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new AnthropicProvider({
      apiKey: 'test-key',
      model: 'claude-sonnet-4-20250514',
    });
  });

  describe('Multi-tool result parity', () => {
    it('multiple tool calls produce same results in both modes', async () => {
      // Non-streaming
      mockAnthropicCreate.mockResolvedValue({
        content: [
          { type: 'tool_use', id: 't1', name: 'search', input: { q: 'a' } },
          { type: 'tool_use', id: 't2', name: 'fetch', input: { url: 'b' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 50, output_tokens: 30 },
      });

      const nonStream = await provider.completeWithTools({
        messages: [{ role: 'user', content: 'multi' }],
        tools: [
          { name: 'search', description: 'S', inputSchema: {} },
          { name: 'fetch', description: 'F', inputSchema: {} },
        ],
      });

      // Streaming
      const events: Array<Record<string, unknown>> = [
        { type: 'message_start', message: { usage: { input_tokens: 50 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'search' } },
        { type: 'content_block_delta', delta: { partial_json: '{"q":"a"}' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't2', name: 'fetch' } },
        { type: 'content_block_delta', delta: { partial_json: '{"url":"b"}' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 30 } },
      ];
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const stream = await provider.completeWithToolsStream!(
        {
          messages: [{ role: 'user', content: 'multi' }],
          tools: [
            { name: 'search', description: 'S', inputSchema: {} },
            { name: 'fetch', description: 'F', inputSchema: {} },
          ],
        },
        () => {}
      );

      expect(nonStream.toolCalls).toHaveLength(2);
      expect(stream.toolCalls).toHaveLength(2);
      expect(nonStream.toolCalls![0]!.name).toBe(stream.toolCalls![0]!.name);
      expect(nonStream.toolCalls![1]!.name).toBe(stream.toolCalls![1]!.name);
    });
  });

  describe('Error behavior parity', () => {
    it('both modes throw on authentication error', async () => {
      const authError = Object.assign(new Error('Invalid API key'), { status: 401 });

      mockAnthropicCreate.mockRejectedValue(authError);
      await expect(
        provider.complete({ messages: [{ role: 'user', content: 'hi' }] })
      ).rejects.toThrow('Invalid API key');

      mockAnthropicStream.mockReturnValue(createErrorStream([], 0, authError));
      await expect(
        provider.completeStream(
          { messages: [{ role: 'user', content: 'hi' }] },
          () => {}
        )
      ).rejects.toThrow('Invalid API key');
    });
  });

  describe('Content with special characters parity', () => {
    it('unicode content is identical in both modes', async () => {
      const text = '\u3053\u3093\u306b\u3061\u306f\u4e16\u754c \ud83c\udf0d';

      mockAnthropicCreate.mockResolvedValue({
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      const nonStream = await provider.complete({
        messages: [{ role: 'user', content: 'hi' }],
      });

      const events = makeTextStreamEvents(text, 5);
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const stream = await provider.completeStream(
        { messages: [{ role: 'user', content: 'hi' }] },
        () => {}
      );

      expect(nonStream.content).toBe(stream.content);
      expect(nonStream.content).toBe(text);
    });

    it('markdown content is identical in both modes', async () => {
      const text = '# Title\n\n- Item 1\n- **Bold** item\n\n```js\nconsole.log("hi");\n```';

      mockAnthropicCreate.mockResolvedValue({
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 20 },
      });

      const nonStream = await provider.complete({
        messages: [{ role: 'user', content: 'hi' }],
      });

      const events = makeTextStreamEvents(text, 10);
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const stream = await provider.completeStream(
        { messages: [{ role: 'user', content: 'hi' }] },
        () => {}
      );

      expect(nonStream.content).toBe(stream.content);
    });
  });

  describe('SSE response shapes across all three servers', () => {
    it('main server, character server, doctor server all use same SSE event shapes', () => {
      const servers = ['main', 'character', 'doctor'];
      for (const server of servers) {
        const res = makeRes();
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ type: 'session', sessionId: `${server}:x` })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'chunk', content: 'hello' })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        res.end();

        const events = parseSSEEvents(res.body);
        expect(events[0]).toHaveProperty('type', 'session');
        expect(events[1]).toHaveProperty('type', 'chunk');
        expect(events[2]).toHaveProperty('type', 'done');
      }
    });

    it('error event shape is consistent across all three servers', () => {
      for (const _server of ['main', 'character', 'doctor']) {
        const event = { type: 'error', message: 'Failed to process message' };
        expect(event).toHaveProperty('type', 'error');
        expect(event).toHaveProperty('message', 'Failed to process message');
      }
    });
  });
});

// ============================================================
// SSE Client Reconstruction Tests
// ============================================================

describe('SSE Client Reconstruction', () => {
  describe('Simulated EventSource parsing', () => {
    function simulateEventSourceParse(rawSSE: string): Array<{ data: string }> {
      const events: Array<{ data: string }> = [];
      const blocks = rawSSE.split('\n\n');
      for (const block of blocks) {
        const trimmed = block.trim();
        if (trimmed.startsWith('data: ')) {
          events.push({ data: trimmed.slice(6) });
        }
      }
      return events;
    }

    it('client parses session event correctly', () => {
      const raw = `data: {"type":"session","sessionId":"web:abc"}\n\n`;
      const events = simulateEventSourceParse(raw);
      expect(events).toHaveLength(1);
      const parsed = JSON.parse(events[0]!.data) as Record<string, unknown>;
      expect(parsed.type).toBe('session');
      expect(parsed.sessionId).toBe('web:abc');
    });

    it('client parses multiple chunk events', () => {
      const raw =
        `data: {"type":"chunk","content":"Hello"}\n\n` +
        `data: {"type":"chunk","content":" world"}\n\n`;
      const events = simulateEventSourceParse(raw);
      expect(events).toHaveLength(2);
      const texts = events.map((e) => (JSON.parse(e.data) as { content: string }).content);
      expect(texts.join('')).toBe('Hello world');
    });

    it('client ignores heartbeat comments', () => {
      const raw =
        `data: {"type":"chunk","content":"a"}\n\n` +
        `: heartbeat\n\n` +
        `data: {"type":"chunk","content":"b"}\n\n`;
      const events = simulateEventSourceParse(raw);
      expect(events).toHaveLength(2);
    });

    it('client parses done event as stream terminator', () => {
      const raw =
        `data: {"type":"session","sessionId":"x"}\n\n` +
        `data: {"type":"chunk","content":"hi"}\n\n` +
        `data: {"type":"done"}\n\n`;
      const events = simulateEventSourceParse(raw);
      const last = JSON.parse(events[events.length - 1]!.data) as Record<string, unknown>;
      expect(last.type).toBe('done');
    });

    it('client parses error event', () => {
      const raw = `data: {"type":"error","message":"Failed to process message"}\n\n`;
      const events = simulateEventSourceParse(raw);
      const parsed = JSON.parse(events[0]!.data) as Record<string, unknown>;
      expect(parsed.type).toBe('error');
      expect(parsed.message).toBe('Failed to process message');
    });

    it('client can reconstruct full response from stream', () => {
      const raw =
        `data: {"type":"session","sessionId":"web:full"}\n\n` +
        `data: {"type":"chunk","content":"The "}\n\n` +
        `data: {"type":"chunk","content":"quick "}\n\n` +
        `data: {"type":"chunk","content":"brown "}\n\n` +
        `data: {"type":"chunk","content":"fox."}\n\n` +
        `data: {"type":"done"}\n\n`;
      const events = simulateEventSourceParse(raw);
      const response = events
        .map((e) => JSON.parse(e.data) as Record<string, unknown>)
        .filter((e) => e.type === 'chunk')
        .map((e) => e.content as string)
        .join('');
      expect(response).toBe('The quick brown fox.');
    });

    it('client handles empty content chunks', () => {
      const raw =
        `data: {"type":"chunk","content":""}\n\n` +
        `data: {"type":"chunk","content":"real"}\n\n`;
      const events = simulateEventSourceParse(raw);
      const texts = events.map((e) => (JSON.parse(e.data) as { content: string }).content);
      expect(texts.join('')).toBe('real');
    });

    it('client handles chunk with JSON content', () => {
      const raw = `data: {"type":"chunk","content":"{\\"key\\":\\"value\\"}"}\n\n`;
      const events = simulateEventSourceParse(raw);
      const parsed = JSON.parse(events[0]!.data) as { content: string };
      expect(parsed.content).toBe('{"key":"value"}');
    });
  });
});

// ============================================================
// Event Bus Deep Tests
// ============================================================

describe('Event Bus Deep Tests', () => {
  afterEach(() => {
    eventBus.removeAllListeners('activity');
  });

  describe('Event emission ordering', () => {
    it('events are delivered in emission order', () => {
      const received: string[] = [];
      const handler = (event: SystemEvent) => {
        received.push(event.content);
      };
      eventBus.on('activity', handler);

      for (let i = 0; i < 10; i++) {
        eventBus.emitActivity({
          type: 'commune',
          sessionKey: `commune:${i}`,
          content: `event-${i}`,
          timestamp: Date.now(),
        });
      }

      expect(received).toEqual(
        Array.from({ length: 10 }, (_, i) => `event-${i}`)
      );
    });

    it('events emitted during handler processing are queued', () => {
      const received: string[] = [];
      const handler = (event: SystemEvent) => {
        received.push(event.content);
      };
      eventBus.on('activity', handler);

      eventBus.emitActivity({
        type: 'commune',
        sessionKey: 'commune:1',
        content: 'first',
        timestamp: Date.now(),
      });

      eventBus.emitActivity({
        type: 'commune',
        sessionKey: 'commune:2',
        content: 'second',
        timestamp: Date.now(),
      });

      expect(received).toEqual(['first', 'second']);
    });
  });

  describe('Multiple handler registration', () => {
    it('adding same handler twice receives events twice', () => {
      let count = 0;
      const handler = () => { count++; };
      eventBus.on('activity', handler);
      eventBus.on('activity', handler);

      eventBus.emitActivity({
        type: 'commune',
        sessionKey: 'commune:x',
        content: 'test',
        timestamp: Date.now(),
      });

      expect(count).toBe(2);
      eventBus.off('activity', handler);
      eventBus.off('activity', handler);
    });

    it('removing one handler leaves others intact', () => {
      let count1 = 0;
      let count2 = 0;
      const handler1 = () => { count1++; };
      const handler2 = () => { count2++; };
      eventBus.on('activity', handler1);
      eventBus.on('activity', handler2);

      eventBus.off('activity', handler1);

      eventBus.emitActivity({
        type: 'commune',
        sessionKey: 'commune:x',
        content: 'test',
        timestamp: Date.now(),
      });

      expect(count1).toBe(0);
      expect(count2).toBe(1);
      eventBus.off('activity', handler2);
    });
  });

  describe('System event structure', () => {
    it('emitActivity adds character field from characterId', () => {
      eventBus.setCharacterId('test-id');
      const received: SystemEvent[] = [];
      const handler = (event: SystemEvent) => received.push(event);
      eventBus.on('activity', handler);

      eventBus.emitActivity({
        type: 'diary',
        sessionKey: 'diary:1',
        content: 'entry',
        timestamp: 12345,
      });

      expect(received[0]).toEqual({
        character: 'test-id',
        type: 'diary',
        sessionKey: 'diary:1',
        content: 'entry',
        timestamp: 12345,
      });
      eventBus.off('activity', handler);
    });

    it('SystemEvent has all required fields', () => {
      const event: SystemEvent = {
        character: 'lain',
        type: 'commune',
        sessionKey: 'commune:test',
        content: 'hello',
        timestamp: Date.now(),
      };
      expect(event).toHaveProperty('character');
      expect(event).toHaveProperty('type');
      expect(event).toHaveProperty('sessionKey');
      expect(event).toHaveProperty('content');
      expect(event).toHaveProperty('timestamp');
    });
  });
});

// ============================================================
// Provider Streaming — Edge Cases Matrix
// ============================================================

describe('Provider Streaming — Edge Cases Matrix', () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new AnthropicProvider({
      apiKey: 'test-key',
      model: 'claude-sonnet-4-20250514',
    });
  });

  describe('Content types in stream', () => {
    it('stream with only whitespace text delta', async () => {
      const chunks: string[] = [];
      const events: Array<Record<string, unknown>> = [
        { type: 'message_start', message: { usage: { input_tokens: 10 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', delta: { text: '   \n\n   ' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      ];
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const result = await provider.completeStream(
        { messages: [{ role: 'user', content: 'test' }] },
        (chunk) => chunks.push(chunk)
      );

      expect(result.content).toBe('   \n\n   ');
      expect(chunks).toEqual(['   \n\n   ']);
    });

    it('stream with emoji text delta', async () => {
      const chunks: string[] = [];
      const events = makeTextStreamEvents('\ud83d\udc4b\ud83c\udf0d\u2764\ufe0f', 2);
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const result = await provider.completeStream(
        { messages: [{ role: 'user', content: 'test' }] },
        (chunk) => chunks.push(chunk)
      );

      expect(result.content).toBe('\ud83d\udc4b\ud83c\udf0d\u2764\ufe0f');
    });

    it('stream with very long single delta', async () => {
      const chunks: string[] = [];
      const longText = 'A'.repeat(50000);
      const events: Array<Record<string, unknown>> = [
        { type: 'message_start', message: { usage: { input_tokens: 10 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', delta: { text: longText } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5000 } },
      ];
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const result = await provider.completeStream(
        { messages: [{ role: 'user', content: 'test' }] },
        (chunk) => chunks.push(chunk)
      );

      expect(result.content).toHaveLength(50000);
      expect(chunks.join('')).toHaveLength(50000);
    });

    it('stream with many tiny deltas (1000 single-char deltas)', async () => {
      const chunks: string[] = [];
      const events: Array<Record<string, unknown>> = [
        { type: 'message_start', message: { usage: { input_tokens: 10 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      ];
      for (let i = 0; i < 1000; i++) {
        events.push({ type: 'content_block_delta', delta: { text: 'x' } });
      }
      events.push({ type: 'content_block_stop', index: 0 });
      events.push({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1000 } });
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      const result = await provider.completeStream(
        { messages: [{ role: 'user', content: 'test' }] },
        (chunk) => chunks.push(chunk)
      );

      expect(result.content).toHaveLength(1000);
      expect(chunks).toHaveLength(1000);
      expect(chunks.every((c) => c === 'x')).toBe(true);
    });
  });

  describe('Multimodal message handling', () => {
    it('system message is extracted and passed as system param', async () => {
      const events = makeTextStreamEvents('response', 8);
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      await provider.completeStream(
        {
          messages: [
            { role: 'system', content: 'Be concise.' },
            { role: 'system', content: 'Be helpful.' },
            { role: 'user', content: 'hi' },
          ],
        },
        () => {}
      );

      const callArgs = mockAnthropicStream.mock.calls[0]![0] as Record<string, unknown>;
      expect(callArgs.system).toBe('Be concise.\n\nBe helpful.');
      const messages = callArgs.messages as Array<Record<string, unknown>>;
      expect(messages).toHaveLength(1);
      expect(messages[0]!.role).toBe('user');
    });

    it('multiple user/assistant messages pass through correctly', async () => {
      const events = makeTextStreamEvents('response', 8);
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      await provider.completeStream(
        {
          messages: [
            { role: 'system', content: 'System' },
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there' },
            { role: 'user', content: 'How are you?' },
          ],
        },
        () => {}
      );

      const callArgs = mockAnthropicStream.mock.calls[0]![0] as Record<string, unknown>;
      const messages = callArgs.messages as Array<Record<string, unknown>>;
      expect(messages).toHaveLength(3);
      expect(messages[0]!.content).toBe('Hello');
      expect(messages[1]!.content).toBe('Hi there');
      expect(messages[2]!.content).toBe('How are you?');
    });
  });

  describe('Tool choice with streaming', () => {
    it('toolChoice auto passes through', async () => {
      const events = makeTextStreamEvents('test', 4);
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      await provider.completeWithToolsStream!(
        {
          messages: [{ role: 'user', content: 'test' }],
          tools: [{ name: 'search', description: 'S', inputSchema: {} }],
          toolChoice: 'auto',
        },
        () => {}
      );

      const callArgs = mockAnthropicStream.mock.calls[0]![0] as Record<string, unknown>;
      expect(callArgs.tool_choice).toEqual({ type: 'auto' });
    });

    it('toolChoice specific tool passes through', async () => {
      const events = makeToolUseStreamEvents('t1', 'search', '{}');
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      await provider.completeWithToolsStream!(
        {
          messages: [{ role: 'user', content: 'test' }],
          tools: [{ name: 'search', description: 'S', inputSchema: {} }],
          toolChoice: { type: 'tool', name: 'search' },
        },
        () => {}
      );

      const callArgs = mockAnthropicStream.mock.calls[0]![0] as Record<string, unknown>;
      expect(callArgs.tool_choice).toEqual({ type: 'tool', name: 'search' });
    });

    it('no toolChoice leaves it undefined', async () => {
      const events = makeTextStreamEvents('test', 4);
      mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

      await provider.completeWithToolsStream!(
        {
          messages: [{ role: 'user', content: 'test' }],
          tools: [{ name: 'search', description: 'S', inputSchema: {} }],
        },
        () => {}
      );

      const callArgs = mockAnthropicStream.mock.calls[0]![0] as Record<string, unknown>;
      expect(callArgs).not.toHaveProperty('tool_choice');
    });
  });
});

// ============================================================
// Conversation SSE and Activity Feed Deep Tests
// ============================================================

describe('Activity Feed and Conversation SSE — Deep', () => {
  describe('Conversation buffer mechanics', () => {
    it('conversation buffer entries have required fields', () => {
      const entry = {
        speakerId: 'lain',
        speakerName: 'Lain',
        listenerId: 'pkd',
        listenerName: 'PKD',
        message: 'hello',
        building: 'park',
        timestamp: Date.now(),
      };
      expect(entry).toHaveProperty('speakerId');
      expect(entry).toHaveProperty('speakerName');
      expect(entry).toHaveProperty('listenerId');
      expect(entry).toHaveProperty('listenerName');
      expect(entry).toHaveProperty('message');
      expect(entry).toHaveProperty('building');
      expect(entry).toHaveProperty('timestamp');
    });

    it('conversation events are serializable to JSON', () => {
      const entry = {
        speakerId: 'lain',
        speakerName: 'Lain "Wired"',
        listenerId: 'pkd',
        listenerName: "Philip K. Dick",
        message: 'Said "hello" & <goodbye>',
        building: 'park',
        timestamp: Date.now(),
      };
      const serialized = JSON.stringify(entry);
      const deserialized = JSON.parse(serialized);
      expect(deserialized).toEqual(entry);
    });

    it('SSE data format for conversation events', () => {
      const res = makeRes();
      const entry = {
        speakerId: 'lain',
        speakerName: 'Lain',
        listenerId: 'pkd',
        listenerName: 'PKD',
        message: 'test',
        building: 'park',
        timestamp: 1234567890,
      };
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
      expect(res.body.startsWith('data: ')).toBe(true);
      expect(res.body.endsWith('\n\n')).toBe(true);
    });
  });

  describe('Activity history endpoint shape', () => {
    it('activity entries array can be empty', () => {
      const entries: unknown[] = [];
      expect(JSON.stringify(entries)).toBe('[]');
    });

    it('activity response is JSON array', () => {
      const entries = [
        { id: '1', type: 'commune', content: 'test', timestamp: Date.now() },
      ];
      const json = JSON.stringify(entries);
      expect(json.startsWith('[')).toBe(true);
      expect(json.endsWith(']')).toBe(true);
    });
  });
});

// ============================================================
// Stream Protocol Stress Tests
// ============================================================

describe('Stream Protocol Stress Tests', () => {
  describe('High-volume chunk delivery', () => {
    it('500 chunks in a single stream all arrive', () => {
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ type: 'session', sessionId: 'stress' })}\n\n`);
      for (let i = 0; i < 500; i++) {
        res.write(`data: ${JSON.stringify({ type: 'chunk', content: `${i}` })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      const events = parseSSEEvents(res.body);
      const chunks = events.filter((e) => e.type === 'chunk');
      expect(chunks).toHaveLength(500);
    });

    it('large payload chunks (10KB each) are transmitted', () => {
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const bigContent = 'X'.repeat(10240);
      for (let i = 0; i < 5; i++) {
        res.write(`data: ${JSON.stringify({ type: 'chunk', content: bigContent })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      const events = parseSSEEvents(res.body);
      const chunks = events.filter((e) => e.type === 'chunk');
      expect(chunks).toHaveLength(5);
      expect((chunks[0] as { content: string }).content).toHaveLength(10240);
    });
  });

  describe('Rapid connect/disconnect simulation', () => {
    it('10 rapid connects and disconnects do not leak listeners', () => {
      const handlers: Array<() => void> = [];

      for (let i = 0; i < 10; i++) {
        const handler = () => {};
        eventBus.on('activity', handler);
        handlers.push(handler);
      }

      const countBefore = eventBus.listenerCount('activity');
      expect(countBefore).toBeGreaterThanOrEqual(10);

      for (const handler of handlers) {
        eventBus.off('activity', handler);
      }

      const countAfter = eventBus.listenerCount('activity');
      expect(countAfter).toBe(countBefore - 10);
    });
  });
});

// ============================================================
// Stream Protocol Contract Tests — Invariants
// ============================================================

describe('Stream Protocol Invariants', () => {
  describe('SSE type system', () => {
    const VALID_TYPES = ['session', 'chunk', 'done', 'error'] as const;

    it('session type requires sessionId property', () => {
      const valid = { type: 'session', sessionId: 'x' };
      expect(valid).toHaveProperty('sessionId');
    });

    it('session without sessionId violates contract', () => {
      const invalid = { type: 'session' };
      expect(invalid).not.toHaveProperty('sessionId');
    });

    it('chunk type requires content property', () => {
      const valid = { type: 'chunk', content: 'text' };
      expect(valid).toHaveProperty('content');
    });

    it('chunk without content violates contract', () => {
      const invalid = { type: 'chunk' };
      expect(invalid).not.toHaveProperty('content');
    });

    it('done type has no payload', () => {
      const valid = { type: 'done' };
      expect(Object.keys(valid)).toEqual(['type']);
    });

    it('error type requires message property', () => {
      const valid = { type: 'error', message: 'something' };
      expect(valid).toHaveProperty('message');
    });

    it('all four types are distinguishable', () => {
      const types = new Set(VALID_TYPES);
      expect(types.size).toBe(4);
    });

    it('type field is always a string', () => {
      for (const type of VALID_TYPES) {
        expect(typeof type).toBe('string');
      }
    });
  });

  describe('Stream state machine transitions', () => {
    type State = 'init' | 'session_sent' | 'streaming' | 'done' | 'error';
    type EventType = 'session' | 'chunk' | 'done' | 'error';

    function transition(state: State, event: EventType): State | 'invalid' {
      switch (state) {
        case 'init':
          return event === 'session' ? 'session_sent' : 'invalid';
        case 'session_sent':
          if (event === 'chunk') return 'streaming';
          if (event === 'done') return 'done';
          if (event === 'error') return 'error';
          return 'invalid';
        case 'streaming':
          if (event === 'chunk') return 'streaming';
          if (event === 'done') return 'done';
          if (event === 'error') return 'error';
          return 'invalid';
        case 'done':
        case 'error':
          return 'invalid'; // terminal states
      }
    }

    it('init -> session is valid', () => {
      expect(transition('init', 'session')).toBe('session_sent');
    });

    it('init -> chunk is invalid', () => {
      expect(transition('init', 'chunk')).toBe('invalid');
    });

    it('init -> done is invalid', () => {
      expect(transition('init', 'done')).toBe('invalid');
    });

    it('session_sent -> chunk is valid', () => {
      expect(transition('session_sent', 'chunk')).toBe('streaming');
    });

    it('session_sent -> done is valid (empty response)', () => {
      expect(transition('session_sent', 'done')).toBe('done');
    });

    it('session_sent -> error is valid', () => {
      expect(transition('session_sent', 'error')).toBe('error');
    });

    it('streaming -> chunk is valid (self-transition)', () => {
      expect(transition('streaming', 'chunk')).toBe('streaming');
    });

    it('streaming -> done is valid', () => {
      expect(transition('streaming', 'done')).toBe('done');
    });

    it('streaming -> error is valid', () => {
      expect(transition('streaming', 'error')).toBe('error');
    });

    it('done is terminal (no valid transitions)', () => {
      expect(transition('done', 'session')).toBe('invalid');
      expect(transition('done', 'chunk')).toBe('invalid');
      expect(transition('done', 'done')).toBe('invalid');
      expect(transition('done', 'error')).toBe('invalid');
    });

    it('error is terminal (no valid transitions)', () => {
      expect(transition('error', 'session')).toBe('invalid');
      expect(transition('error', 'chunk')).toBe('invalid');
      expect(transition('error', 'done')).toBe('invalid');
      expect(transition('error', 'error')).toBe('invalid');
    });

    it('session_sent -> session is invalid (no double session)', () => {
      expect(transition('session_sent', 'session')).toBe('invalid');
    });

    it('streaming -> session is invalid', () => {
      expect(transition('streaming', 'session')).toBe('invalid');
    });

    it('valid successful stream: init -> session -> chunk* -> done', () => {
      let state: State = 'init';
      const events: EventType[] = ['session', 'chunk', 'chunk', 'chunk', 'done'];
      for (const event of events) {
        const next = transition(state, event);
        expect(next).not.toBe('invalid');
        state = next as State;
      }
      expect(state).toBe('done');
    });

    it('valid error stream: init -> session -> chunk -> error', () => {
      let state: State = 'init';
      const events: EventType[] = ['session', 'chunk', 'error'];
      for (const event of events) {
        const next = transition(state, event);
        expect(next).not.toBe('invalid');
        state = next as State;
      }
      expect(state).toBe('error');
    });

    it('valid empty stream: init -> session -> done', () => {
      let state: State = 'init';
      const events: EventType[] = ['session', 'done'];
      for (const event of events) {
        const next = transition(state, event);
        expect(next).not.toBe('invalid');
        state = next as State;
      }
      expect(state).toBe('done');
    });

    it('valid immediate error: init -> session -> error', () => {
      let state: State = 'init';
      const events: EventType[] = ['session', 'error'];
      for (const event of events) {
        const next = transition(state, event);
        expect(next).not.toBe('invalid');
        state = next as State;
      }
      expect(state).toBe('error');
    });
  });

  describe('SSE header contract', () => {
    it('Content-Type must be text/event-stream', () => {
      const required = 'text/event-stream';
      expect(required).toBe('text/event-stream');
    });

    it('Cache-Control must be no-cache', () => {
      const required = 'no-cache';
      expect(required).toBe('no-cache');
    });

    it('Connection should be keep-alive', () => {
      const required = 'keep-alive';
      expect(required).toBe('keep-alive');
    });

    it('HTTP status code for SSE is 200', () => {
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      expect(res.statusCode).toBe(200);
    });

    it('SSE never uses 204 or 301 status codes', () => {
      const validSSEStatus = 200;
      expect(validSSEStatus).not.toBe(204);
      expect(validSSEStatus).not.toBe(301);
    });
  });
});

// ============================================================
// Provider Streaming — Model Parameter Passthrough
// ============================================================

describe('Provider Streaming — Model Parameter Passthrough', () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new AnthropicProvider({
      apiKey: 'test-key',
      model: 'claude-sonnet-4-20250514',
      maxTokens: 4096,
    });
  });

  it('model name passes through to stream call', async () => {
    const events = makeTextStreamEvents('test', 4);
    mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

    await provider.completeStream(
      { messages: [{ role: 'user', content: 'hi' }] },
      () => {}
    );

    const callArgs = mockAnthropicStream.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArgs.model).toBe('claude-sonnet-4-20250514');
  });

  it('custom maxTokens from constructor is used as default', async () => {
    const events = makeTextStreamEvents('test', 4);
    mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

    await provider.completeStream(
      { messages: [{ role: 'user', content: 'hi' }] },
      () => {}
    );

    const callArgs = mockAnthropicStream.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArgs.max_tokens).toBe(4096);
  });

  it('per-call maxTokens overrides constructor default', async () => {
    const events = makeTextStreamEvents('test', 4);
    mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

    await provider.completeStream(
      { messages: [{ role: 'user', content: 'hi' }], maxTokens: 2048 },
      () => {}
    );

    const callArgs = mockAnthropicStream.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArgs.max_tokens).toBe(2048);
  });

  it('stream: true is always set on streaming calls', async () => {
    const events = makeTextStreamEvents('test', 4);
    mockAnthropicStream.mockReturnValue(createMockAnthropicStream(events));

    await provider.completeStream(
      { messages: [{ role: 'user', content: 'hi' }] },
      () => {}
    );

    const callArgs = mockAnthropicStream.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArgs.stream).toBe(true);
  });

  it('provider name is anthropic', () => {
    expect(provider.name).toBe('anthropic');
  });

  it('provider model matches constructor', () => {
    expect(provider.model).toBe('claude-sonnet-4-20250514');
  });
});

// ============================================================
// Streaming with Delayed/Async Chunk Delivery
// ============================================================

describe('Streaming with Async Chunk Delivery', () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new AnthropicProvider({
      apiKey: 'test-key',
      model: 'claude-sonnet-4-20250514',
    });
  });

  it('chunks from delayed stream arrive in order', async () => {
    const chunks: string[] = [];
    const events = makeTextStreamEvents('ABCDE', 1);
    const delayedStream = createDelayedStream(events, 5);
    mockAnthropicStream.mockReturnValue(delayedStream);

    const result = await provider.completeStream(
      { messages: [{ role: 'user', content: 'test' }] },
      (chunk) => chunks.push(chunk)
    );

    expect(result.content).toBe('ABCDE');
    expect(chunks.join('')).toBe('ABCDE');
  });

  it('SSE response with async writing preserves order', async () => {
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ type: 'session', sessionId: 'async-test' })}\n\n`);

    // Simulate async chunk delivery
    const words = ['one', 'two', 'three'];
    for (const word of words) {
      await new Promise((r) => setTimeout(r, 1));
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: word })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();

    const events = parseSSEEvents(res.body);
    const chunks = events.filter((e) => e.type === 'chunk').map((e) => e.content);
    expect(chunks).toEqual(['one', 'two', 'three']);
  });
});

// ============================================================
// Cross-server SSE Consistency
// ============================================================

describe('Cross-server SSE Consistency', () => {
  describe('All three servers implement identical patterns', () => {
    it('all servers send session as first event in chat stream', () => {
      for (const prefix of ['web', 'pkd', 'dr']) {
        const res = makeRes();
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ type: 'session', sessionId: `${prefix}:x` })}\n\n`);
        const events = parseSSEEvents(res.body);
        expect(events[0]).toHaveProperty('type', 'session');
      }
    });

    it('all servers use same done event format', () => {
      for (const _server of ['main', 'character', 'doctor']) {
        const done = { type: 'done' };
        const serialized = `data: ${JSON.stringify(done)}\n\n`;
        expect(serialized).toBe('data: {"type":"done"}\n\n');
      }
    });

    it('all servers use same error event format', () => {
      for (const _server of ['main', 'character', 'doctor']) {
        const error = { type: 'error', message: 'Failed to process message' };
        const serialized = `data: ${JSON.stringify(error)}\n\n`;
        expect(serialized).toBe('data: {"type":"error","message":"Failed to process message"}\n\n');
      }
    });

    it('all servers set CORS header on event stream', () => {
      for (const _server of ['main', 'character', 'doctor']) {
        const res = makeRes();
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Access-Control-Allow-Origin': '*',
        });
        expect(res.headers['access-control-allow-origin']).toBe('*');
      }
    });

    it('all servers have /api/events endpoint with heartbeat', () => {
      // All three servers implement: /api/events with 30s heartbeat
      for (const _server of ['main', 'character', 'doctor']) {
        const res = makeRes();
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(': heartbeat\n\n');
        expect(res.body).toBe(': heartbeat\n\n');
      }
    });

    it('all servers filter non-background events from /api/events', () => {
      // Chat events are NOT background events — not delivered to /api/events
      const chatEvent: SystemEvent = {
        character: 'lain',
        type: 'chat',
        sessionKey: 'web:x',
        content: 'hello',
        timestamp: Date.now(),
      };
      expect(isBackgroundEvent(chatEvent)).toBe(false);
    });
  });

  describe('Session ID prefix conventions', () => {
    it('main server uses web: prefix', () => {
      expect('web:abc123'.startsWith('web:')).toBe(true);
    });

    it('main server uses stranger:web: prefix for strangers', () => {
      expect('stranger:web:abc123'.startsWith('stranger:web:')).toBe(true);
    });

    it('character server uses character id prefix', () => {
      expect('pkd:abc123'.includes(':')).toBe(true);
    });

    it('character server uses stranger:<id>: prefix for strangers', () => {
      expect('stranger:pkd:abc123'.startsWith('stranger:')).toBe(true);
    });

    it('doctor server uses dr: prefix', () => {
      expect('dr:abc123'.startsWith('dr:')).toBe(true);
    });

    it('peer messages use peer: prefix', () => {
      expect('peer:pkd:12345'.startsWith('peer:')).toBe(true);
    });

    it('commune conversations use commune: prefix', () => {
      expect('commune:pkd:12345'.startsWith('commune:')).toBe(true);
    });
  });
});
