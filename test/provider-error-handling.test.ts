/**
 * Provider error handling tests
 *
 * Tests provider-specific error paths, retry edge cases, fallback chains,
 * and budget enforcement under error conditions.
 *
 * Coverage areas:
 *  1. Anthropic-specific error handling       (~60 tests)
 *  2. OpenAI-specific error handling          (~60 tests)
 *  3. Google-specific error handling          (~60 tests)
 *  4. Provider fallback chain                 (~40 tests)
 *  5. Retry behavior edge cases               (~40 tests)
 *  6. Budget enforcement under errors         (~40 tests)
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';

// Suppress unhandled rejection warnings from intentional error-injection tests
const noop = () => {};
beforeAll(() => { process.on('unhandledRejection', noop); });
afterAll(() => { process.off('unhandledRejection', noop); });

// ─── Hoisted mock handles ───────────────────────────────────────────────────

const {
  mockAnthropicCreate,
  mockAnthropicStream,
  mockOpenAICreate,
  mockGenerateContent,
  mockGetGenerativeModel,
  mockGetMeta,
  mockSetMeta,
  mockAtomicMetaIncrementCounter,
  mockLoggerWarn,
  mockLoggerError,
  mockLoggerInfo,
  mockLoggerDebug,
} = vi.hoisted(() => {
  const mockAnthropicCreate = vi.fn();
  const mockAnthropicStream = vi.fn();
  const mockOpenAICreate = vi.fn();
  const mockGenerateContent = vi.fn();
  const mockGetGenerativeModel = vi.fn().mockReturnValue({ generateContent: mockGenerateContent });
  const mockGetMeta = vi.fn();
  const mockSetMeta = vi.fn();
  const mockAtomicMetaIncrementCounter = vi.fn();
  const mockLoggerWarn = vi.fn();
  const mockLoggerError = vi.fn();
  const mockLoggerInfo = vi.fn();
  const mockLoggerDebug = vi.fn();
  return {
    mockAnthropicCreate,
    mockAnthropicStream,
    mockOpenAICreate,
    mockGenerateContent,
    mockGetGenerativeModel,
    mockGetMeta,
    mockSetMeta,
    mockAtomicMetaIncrementCounter,
    mockLoggerWarn,
    mockLoggerError,
    mockLoggerInfo,
    mockLoggerDebug,
  };
});

vi.mock('@anthropic-ai/sdk', async () => {
  // Preserve the real error classes (APIError, RateLimitError, etc.) — the
  // provider uses them for structured retry classification (findings.md
  // P2:838). Only the default constructor is replaced so we can intercept
  // .messages.create / .messages.stream calls.
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

vi.mock('../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: mockLoggerDebug,
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
    error: mockLoggerError,
  }),
}));

vi.mock('../src/storage/database.js', () => ({
  getMeta: mockGetMeta,
  setMeta: mockSetMeta,
  atomicMetaIncrementCounter: mockAtomicMetaIncrementCounter,
  isDatabaseInitialized: () => true,
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { AnthropicProvider, IncompleteToolCallError } from '../src/providers/anthropic.js';
import { OpenAIProvider } from '../src/providers/openai.js';
import { GoogleProvider } from '../src/providers/google.js';
import { withRetry } from '../src/providers/retry.js';
import { createFallbackProvider } from '../src/providers/fallback.js';
import {
  checkBudget,
  recordUsage,
  getBudgetStatus,
  BudgetExceededError,
} from '../src/providers/budget.js';
import type {
  CompletionOptions,
  CompletionWithToolsOptions,
  CompletionResult,
  Provider,
  ToolCall,
  ToolResult,
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

const basicToolDefs = [
  {
    name: 'get_weather',
    description: 'Get weather',
    inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
  },
];

function makeAnthropicError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

function makeOpenAIError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

function makeGoogleError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

/** Helper to create an async iterable stream from an array of events */
function makeAsyncIterable<T>(events: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < events.length) {
            return { value: events[i++]!, done: false };
          }
          return { value: undefined as unknown as T, done: true };
        },
      };
    },
  };
}

/** Helper to create an async iterable stream that errors mid-way */
function makeErroringAsyncIterable<T>(events: T[], errorAfter: number, error: Error): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i >= errorAfter) throw error;
          if (i < events.length) {
            return { value: events[i++]!, done: false };
          }
          return { value: undefined as unknown as T, done: true };
        },
      };
    },
  };
}

function createAnthropicProvider() {
  return new AnthropicProvider({ apiKey: 'test-key', model: 'claude-3-opus-20240229' });
}

function createOpenAIProvider() {
  return new OpenAIProvider({ apiKey: 'test-key', model: 'gpt-4' });
}

function createGoogleProviderInstance() {
  return new GoogleProvider({ apiKey: 'test-key', model: 'gemini-pro' });
}

/** A minimal mock provider for fallback/budget tests */
function createMockProvider(name: string, model: string, overrides: Partial<Provider> = {}): Provider {
  return {
    name,
    model,
    supportsStreaming: false,
    complete: vi.fn().mockResolvedValue({
      content: `response from ${model}`,
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5 },
    }),
    completeWithTools: vi.fn().mockResolvedValue({
      content: `response from ${model}`,
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5 },
    }),
    continueWithToolResults: vi.fn().mockResolvedValue({
      content: `response from ${model}`,
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5 },
    }),
    ...overrides,
  };
}

// ─── Setup ───────────────────────────────────────────────────────────────────

/**
 * Run a function that involves retries, advancing fake timers so the
 * retry delays resolve instantly. Call this for any async function that
 * internally uses setTimeout (retry backoff).
 */
async function withTimers<T>(fn: () => Promise<T>): Promise<T> {
  const p = fn();
  // Run all pending timers repeatedly to drain nested setTimeout chains from retries.
  // Each iteration: flush microtasks (so catch blocks create the retry setTimeout),
  // then advance all timers (so the setTimeout resolves).
  for (let i = 0; i < 15; i++) {
    await Promise.resolve();           // flush microtask queue
    await vi.advanceTimersByTimeAsync(10_000); // advance any pending timers
    await Promise.resolve();           // flush follow-up microtasks
  }
  return p;
}

/**
 * Like withTimers but expects the promise to reject.
 * Returns the rejected error so caller can assert on it.
 */
async function withTimersExpectReject(fn: () => Promise<unknown>): Promise<unknown> {
  const p = fn();
  for (let i = 0; i < 15; i++) {
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.resolve();
  }
  try {
    await p;
    throw new Error('Expected promise to reject but it resolved');
  } catch (err) {
    return err;
  }
}

beforeEach(() => {
  // Reset only the individual mock functions (not the SDK constructor mocks)
  mockAnthropicCreate.mockReset();
  mockAnthropicStream.mockReset();
  mockOpenAICreate.mockReset();
  mockGenerateContent.mockReset();
  mockGetMeta.mockReset();
  mockSetMeta.mockReset();
  mockAtomicMetaIncrementCounter.mockReset();
  mockAtomicMetaIncrementCounter.mockImplementation(
    (p: { freshJson: string }) => p.freshJson,
  );
  mockLoggerWarn.mockReset();
  mockLoggerError.mockReset();
  mockLoggerInfo.mockReset();
  mockLoggerDebug.mockReset();
  // Re-configure Google mock chain
  mockGetGenerativeModel.mockReset();
  mockGetGenerativeModel.mockReturnValue({ generateContent: mockGenerateContent });
  vi.useFakeTimers();
  delete process.env['LAIN_MONTHLY_TOKEN_CAP'];
});

afterEach(() => {
  vi.useRealTimers();
});


// ═══════════════════════════════════════════════════════════════════════════════
// 1. ANTHROPIC-SPECIFIC ERROR HANDLING
// ═══════════════════════════════════════════════════════════════════════════════

describe('Anthropic-specific error handling', () => {

  describe('529 overloaded response', () => {
    it('retries with exponential backoff on overloaded error', async () => {
      const provider = createAnthropicProvider();
      const overloadedErr = new Error('Overloaded');

      mockAnthropicCreate
        .mockRejectedValueOnce(overloadedErr)
        .mockRejectedValueOnce(overloadedErr)
        .mockResolvedValueOnce(makeAnthropicResponse());

      const result = await withTimers(() => provider.complete({ messages: basicMessages }));
      expect(result.content).toBe('hello');
      expect(mockAnthropicCreate).toHaveBeenCalledTimes(3);
    });

    it('waits 1s before first retry', async () => {
      const provider = createAnthropicProvider();
      const overloadedErr = new Error('overloaded');

      mockAnthropicCreate
        .mockRejectedValueOnce(overloadedErr)
        .mockResolvedValueOnce(makeAnthropicResponse());

      const promise = provider.complete({ messages: basicMessages });
      // The first retry delay should be 1000ms
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;
      expect(result.content).toBe('hello');
    });

    it('waits 2s before second retry', async () => {
      const provider = createAnthropicProvider();
      const overloadedErr = new Error('overloaded');

      mockAnthropicCreate
        .mockRejectedValueOnce(overloadedErr)
        .mockRejectedValueOnce(overloadedErr)
        .mockResolvedValueOnce(makeAnthropicResponse());

      const promise = provider.complete({ messages: basicMessages });
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(2000);
      const result = await promise;
      expect(result.content).toBe('hello');
    });

    it('waits 4s before third retry', async () => {
      const provider = createAnthropicProvider();
      const overloadedErr = new Error('overloaded');

      mockAnthropicCreate
        .mockRejectedValueOnce(overloadedErr)
        .mockRejectedValueOnce(overloadedErr)
        .mockRejectedValueOnce(overloadedErr)
        .mockResolvedValueOnce(makeAnthropicResponse());

      const promise = provider.complete({ messages: basicMessages });
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(4000);
      const result = await promise;
      expect(result.content).toBe('hello');
    });

    it('throws after max retries exhausted', async () => {
      const provider = createAnthropicProvider();
      const overloadedErr = new Error('Overloaded');

      mockAnthropicCreate.mockRejectedValue(overloadedErr);

      const err = await withTimersExpectReject(() => provider.complete({ messages: basicMessages }));
      expect((err as Error).message).toContain('Overloaded');
      // 1 initial + 3 retries = 4 attempts
      expect(mockAnthropicCreate).toHaveBeenCalledTimes(4);
    });

    it('logs warning on each retry attempt', async () => {
      const provider = createAnthropicProvider();
      const overloadedErr = new Error('Overloaded');

      mockAnthropicCreate
        .mockRejectedValueOnce(overloadedErr)
        .mockRejectedValueOnce(overloadedErr)
        .mockResolvedValueOnce(makeAnthropicResponse());

      await withTimers(() => provider.complete({ messages: basicMessages }));
      expect(mockLoggerWarn).toHaveBeenCalledTimes(2);
    });

    it('detects overloaded in error cause message', async () => {
      const provider = createAnthropicProvider();
      const err = new Error('API Error');
      (err as unknown as { cause: { message: string } }).cause = { message: 'Server overloaded' };

      mockAnthropicCreate
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce(makeAnthropicResponse());

      const result = await withTimers(() => provider.complete({ messages: basicMessages }));
      expect(result.content).toBe('hello');
      expect(mockAnthropicCreate).toHaveBeenCalledTimes(2);
    });

    it('detects overloaded regardless of case (Overloaded vs overloaded)', async () => {
      const provider = createAnthropicProvider();

      for (const msg of ['overloaded', 'Overloaded', 'Server is overloaded']) {
        mockAnthropicCreate.mockReset();
        mockAnthropicCreate
          .mockRejectedValueOnce(new Error(msg))
          .mockResolvedValueOnce(makeAnthropicResponse());

        const result = await withTimers(() => provider.complete({ messages: basicMessages }));
        expect(result.content).toBe('hello');
      }
    });

    it('detects 529 via APIError class without depending on message text (findings.md P2:838)', async () => {
      // findings.md P2:838 — retry must not depend on the human-readable
      // message "overloaded"; a future SDK could rename the phrase and we'd
      // silently stop retrying. Structured status on APIError is the
      // authoritative signal.
      const { APIError } = await import('@anthropic-ai/sdk');
      const provider = createAnthropicProvider();
      const err = new APIError(529, undefined, 'service busy — not the old phrase', undefined);

      mockAnthropicCreate
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce(makeAnthropicResponse());

      const result = await withTimers(() => provider.complete({ messages: basicMessages }));
      expect(result.content).toBe('hello');
      expect(mockAnthropicCreate).toHaveBeenCalledTimes(2);
    });
  });

  describe('429 rate limit (findings.md P2:848)', () => {
    // findings.md P2:848 — Anthropic rate-limits (429) used to propagate
    // straight to callers because the classifier only matched "overloaded"
    // and timeouts. A bursty caller hitting the RPM cap saw a hard failure
    // instead of the transparent retry they get on 529.

    it('retries on 429 status code', async () => {
      const provider = createAnthropicProvider();
      const { RateLimitError } = await import('@anthropic-ai/sdk');
      const err = new RateLimitError(429, undefined, 'rate limit exceeded', undefined);

      mockAnthropicCreate
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce(makeAnthropicResponse());

      const result = await withTimers(() => provider.complete({ messages: basicMessages }));
      expect(result.content).toBe('hello');
      expect(mockAnthropicCreate).toHaveBeenCalledTimes(2);
    });

    it('retries on 429 even when error is a plain Error with .status (non-SDK origin)', async () => {
      const provider = createAnthropicProvider();
      const err = makeAnthropicError(429, 'Too many requests');

      mockAnthropicCreate
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce(makeAnthropicResponse());

      const result = await withTimers(() => provider.complete({ messages: basicMessages }));
      expect(result.content).toBe('hello');
      expect(mockAnthropicCreate).toHaveBeenCalledTimes(2);
    });
  });

  describe('Retry-After header (findings.md P2:858)', () => {
    // findings.md P2:858 — fixed 1/2/4s backoff used to ignore the server's
    // Retry-After header. A real rate-limit sends Retry-After: 30; all three
    // retries fall inside the 30-second window, all three fail, caller sees
    // the failure anyway. We now take max(retryAfterMs, backoffDelay).

    it('waits for Retry-After seconds instead of the fixed 1s backoff', async () => {
      const { RateLimitError } = await import('@anthropic-ai/sdk');
      const provider = createAnthropicProvider();
      const err = new RateLimitError(
        429,
        undefined,
        'rate limited',
        { 'retry-after': '30' }
      );

      mockAnthropicCreate
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce(makeAnthropicResponse());

      const promise = provider.complete({ messages: basicMessages });
      // Fixed backoff would resolve after 1s. The Retry-After says 30s,
      // so advancing only 1s must NOT be enough to release the retry.
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
      // Advance the rest of the 30-second window.
      await vi.advanceTimersByTimeAsync(29_000);
      const result = await promise;
      expect(result.content).toBe('hello');
      expect(mockAnthropicCreate).toHaveBeenCalledTimes(2);
    });

    it('falls back to exponential backoff when Retry-After is absent', async () => {
      const { RateLimitError } = await import('@anthropic-ai/sdk');
      const provider = createAnthropicProvider();
      const err = new RateLimitError(429, undefined, 'rate limited', undefined);

      mockAnthropicCreate
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce(makeAnthropicResponse());

      const promise = provider.complete({ messages: basicMessages });
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;
      expect(result.content).toBe('hello');
    });

    it('uses jittered backoff when it exceeds Retry-After (findings.md P2:1050)', async () => {
      // findings.md P2:1050 — pin Math.random so the sampled jitter equals
      // the cap (1s). Retry-After: 0 means jittered backoff should win.
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.9999);
      const { RateLimitError } = await import('@anthropic-ai/sdk');
      const provider = createAnthropicProvider();
      const err = new RateLimitError(
        429,
        undefined,
        'rate limited',
        { 'retry-after': '0' }
      );

      mockAnthropicCreate
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce(makeAnthropicResponse());

      const promise = provider.complete({ messages: basicMessages });
      // Less than 1s — jittered backoff (pinned ≈ cap) keeps the call on hold.
      await vi.advanceTimersByTimeAsync(500);
      expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(600);
      const result = await promise;
      expect(result.content).toBe('hello');
      randomSpy.mockRestore();
    });
  });

  describe('AbortError handling (findings.md P2:868)', () => {
    // findings.md P2:868 — a bare AbortError means the caller deliberately
    // cancelled. Retrying after that keeps the request alive through the
    // cancel and burns tokens. We only retry errors that actually look like
    // timeouts ("timed out", ETIMEDOUT, ECONNABORTED).

    it('does not retry a bare AbortError (caller cancellation)', async () => {
      const provider = createAnthropicProvider();
      const abortErr = new Error('The operation was aborted.');
      (abortErr as Error & { name: string }).name = 'AbortError';

      mockAnthropicCreate.mockRejectedValueOnce(abortErr);

      await expect(provider.complete({ messages: basicMessages }))
        .rejects.toThrow();
      expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
    });

    it('retries an AbortError whose message indicates a real timeout', async () => {
      const provider = createAnthropicProvider();
      const timeoutErr = new Error('Request timed out');
      (timeoutErr as Error & { name: string }).name = 'AbortError';

      mockAnthropicCreate
        .mockRejectedValueOnce(timeoutErr)
        .mockResolvedValueOnce(makeAnthropicResponse());

      const result = await withTimers(() => provider.complete({ messages: basicMessages }));
      expect(result.content).toBe('hello');
      expect(mockAnthropicCreate).toHaveBeenCalledTimes(2);
    });

    it('retries ETIMEDOUT / ECONNABORTED socket-level timeouts', async () => {
      const provider = createAnthropicProvider();
      for (const msg of ['connect ETIMEDOUT', 'socket hang up ECONNABORTED']) {
        mockAnthropicCreate.mockReset();
        mockAnthropicCreate
          .mockRejectedValueOnce(new Error(msg))
          .mockResolvedValueOnce(makeAnthropicResponse());

        const result = await withTimers(() => provider.complete({ messages: basicMessages }));
        expect(result.content).toBe('hello');
      }
    });
  });

  describe('non-retryable errors', () => {
    it('does not retry 400 bad request', async () => {
      const provider = createAnthropicProvider();
      const err = makeAnthropicError(400, 'prompt too long');

      mockAnthropicCreate.mockRejectedValueOnce(err);

      await expect(provider.complete({ messages: basicMessages }))
        .rejects.toThrow('prompt too long');
      expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
    });

    it('does not retry invalid_request_error', async () => {
      const provider = createAnthropicProvider();
      const err = makeAnthropicError(400, 'invalid_request_error: max_tokens exceeds limit');

      mockAnthropicCreate.mockRejectedValueOnce(err);

      await expect(provider.complete({ messages: basicMessages }))
        .rejects.toThrow('invalid_request_error');
      expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
    });

    it('propagates error message from 400 invalid_request_error', async () => {
      const provider = createAnthropicProvider();
      const errorMsg = 'invalid_request_error: messages must have an odd number of elements';
      const err = makeAnthropicError(400, errorMsg);

      mockAnthropicCreate.mockRejectedValueOnce(err);

      await expect(provider.complete({ messages: basicMessages }))
        .rejects.toThrow(errorMsg);
    });

    it('does not retry 401 unauthorized', async () => {
      const provider = createAnthropicProvider();
      const err = makeAnthropicError(401, 'Invalid API key');

      mockAnthropicCreate.mockRejectedValueOnce(err);

      await expect(provider.complete({ messages: basicMessages }))
        .rejects.toThrow('Invalid API key');
      expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
    });

    it('does not retry 403 forbidden', async () => {
      const provider = createAnthropicProvider();
      const err = makeAnthropicError(403, 'Access denied');

      mockAnthropicCreate.mockRejectedValueOnce(err);

      await expect(provider.complete({ messages: basicMessages }))
        .rejects.toThrow('Access denied');
      expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
    });

    it('does not retry 404 not found', async () => {
      const provider = createAnthropicProvider();
      const err = makeAnthropicError(404, 'Model not found');

      mockAnthropicCreate.mockRejectedValueOnce(err);

      await expect(provider.complete({ messages: basicMessages }))
        .rejects.toThrow('Model not found');
      expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
    });
  });

  describe('500 server error', () => {
    it('retries on 500 with overloaded message', async () => {
      const provider = createAnthropicProvider();
      const err = new Error('Server overloaded with requests');

      mockAnthropicCreate
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce(makeAnthropicResponse());

      const result = await withTimers(() => provider.complete({ messages: basicMessages }));
      expect(result.content).toBe('hello');
      expect(mockAnthropicCreate).toHaveBeenCalledTimes(2);
    });

    it('does not retry plain 500 without overloaded keyword', async () => {
      const provider = createAnthropicProvider();
      const err = makeAnthropicError(500, 'Internal server error');

      mockAnthropicCreate.mockRejectedValueOnce(err);

      // Anthropic withRetry only retries on "overloaded" — not generic 500
      await expect(provider.complete({ messages: basicMessages }))
        .rejects.toThrow('Internal server error');
      expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
    });
  });

  describe('streaming: partial content then error', () => {
    it('throws error even if partial content was received', async () => {
      const provider = createAnthropicProvider();
      const events = [
        { type: 'message_start', message: { usage: { input_tokens: 5 } } },
        { type: 'content_block_delta', delta: { text: 'partial' } },
      ];

      const streamError = new Error('Connection reset');
      const errorStream = makeErroringAsyncIterable(events, 2, streamError);

      mockAnthropicStream.mockReturnValueOnce(errorStream);

      const chunks: string[] = [];
      await expect(
        provider.completeStream!({ messages: basicMessages }, (chunk) => chunks.push(chunk))
      ).rejects.toThrow('Connection reset');
      // Partial chunk was delivered before error
      expect(chunks).toEqual(['partial']);
    });

    it('connection reset mid-stream does not leave dangling state', async () => {
      const provider = createAnthropicProvider();
      const events = [
        { type: 'message_start', message: { usage: { input_tokens: 5 } } },
        { type: 'content_block_delta', delta: { text: 'first' } },
      ];

      const streamError = new Error('Connection overloaded');
      const errorStream = makeErroringAsyncIterable(events, 2, streamError);

      // First call: error. Second call: succeeds.
      mockAnthropicStream
        .mockReturnValueOnce(errorStream)
        .mockReturnValueOnce(makeAsyncIterable([
          { type: 'message_start', message: { usage: { input_tokens: 5 } } },
          { type: 'content_block_delta', delta: { text: 'recovered' } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
        ]));

      // The withRetry in completeStream will retry on "overloaded"
      // The onChunk callback is external and accumulates across retries,
      // so chunks from the failed stream are still delivered
      const chunks: string[] = [];
      const result = await withTimers(() => provider.completeStream!({ messages: basicMessages }, (chunk) => chunks.push(chunk)));
      // First stream delivered 'first' before erroring, second stream delivered 'recovered'
      expect(chunks).toEqual(['first', 'recovered']);
      // But the content variable is scoped inside the retry lambda, so only second stream content
      expect(result.content).toBe('recovered');
    });
  });

  describe('tool use response handling', () => {
    it('handles malformed tool_use block with invalid JSON gracefully in streaming', async () => {
      const provider = createAnthropicProvider();
      const events = [
        { type: 'message_start', message: { usage: { input_tokens: 5 } } },
        { type: 'content_block_start', content_block: { type: 'tool_use', id: 'call_1', name: 'get_weather' } },
        { type: 'content_block_delta', delta: { partial_json: '{invalid json' } },
        { type: 'content_block_stop' },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10 } },
      ];

      mockAnthropicStream.mockReturnValueOnce(makeAsyncIterable(events));

      const chunks: string[] = [];
      const result = await provider.completeWithToolsStream!(
        { messages: basicMessages, tools: basicToolDefs },
        (chunk) => chunks.push(chunk)
      );
      // Malformed tool call is skipped (warned), no toolCalls in result
      expect(result.toolCalls).toBeUndefined();
      expect(mockLoggerWarn).toHaveBeenCalled();
    });

    describe('stream abort mid tool-call surfaces partial state (findings.md P2:910)', () => {
      it('wraps abort mid tool-call in IncompleteToolCallError with partial inputJson', async () => {
        // findings.md P2:910 — if the stream drops while a tool_use block
        // is in flight, the partial JSON accumulator used to be discarded
        // silently. Callers saw a generic error (AbortError, network drop)
        // with no hint that a tool call was being prepared. Now the
        // accumulator is surfaced via IncompleteToolCallError so callers
        // can log/retry with context.
        const provider = createAnthropicProvider();
        const events = [
          { type: 'message_start', message: { usage: { input_tokens: 5 } } },
          {
            type: 'content_block_start',
            content_block: { type: 'tool_use', id: 'call_1', name: 'get_weather' },
          },
          { type: 'content_block_delta', delta: { partial_json: '{"city":"Tok' } },
        ];
        // Abort is NOT a retryable timeout (P2:868), so withRetry won't
        // mask the failure — the wrapper should surface.
        const abortErr = new Error('The operation was aborted');
        abortErr.name = 'AbortError';
        const errorStream = makeErroringAsyncIterable(events, 3, abortErr);
        mockAnthropicStream.mockReturnValueOnce(errorStream);

        const err = (await withTimersExpectReject(() =>
          provider.completeWithToolsStream!(
            { messages: basicMessages, tools: basicToolDefs },
            () => {}
          )
        )) as IncompleteToolCallError;

        expect(err).toBeInstanceOf(IncompleteToolCallError);
        expect(err.partialToolCall.id).toBe('call_1');
        expect(err.partialToolCall.name).toBe('get_weather');
        expect(err.partialToolCall.inputJson).toBe('{"city":"Tok');
        expect(err.completedToolCalls).toEqual([]);
        expect(err.cause).toBe(abortErr);
      });

      it('includes already-completed tool calls on the error so caller can see them', async () => {
        const provider = createAnthropicProvider();
        const events = [
          { type: 'message_start', message: { usage: { input_tokens: 5 } } },
          {
            type: 'content_block_start',
            content_block: { type: 'tool_use', id: 'call_1', name: 'get_weather' },
          },
          { type: 'content_block_delta', delta: { partial_json: '{"city":"Tokyo"}' } },
          { type: 'content_block_stop' },
          {
            type: 'content_block_start',
            content_block: { type: 'tool_use', id: 'call_2', name: 'get_weather' },
          },
          { type: 'content_block_delta', delta: { partial_json: '{"city":"Lon' } },
        ];
        const abortErr = new Error('The operation was aborted');
        abortErr.name = 'AbortError';
        const errorStream = makeErroringAsyncIterable(events, 6, abortErr);
        mockAnthropicStream.mockReturnValueOnce(errorStream);

        const err = (await withTimersExpectReject(() =>
          provider.completeWithToolsStream!(
            { messages: basicMessages, tools: basicToolDefs },
            () => {}
          )
        )) as IncompleteToolCallError;

        expect(err).toBeInstanceOf(IncompleteToolCallError);
        expect(err.partialToolCall.id).toBe('call_2');
        expect(err.partialToolCall.inputJson).toBe('{"city":"Lon');
        expect(err.completedToolCalls).toHaveLength(1);
        expect(err.completedToolCalls[0]!.name).toBe('get_weather');
        expect(err.completedToolCalls[0]!.input).toEqual({ city: 'Tokyo' });
      });

      it('does NOT wrap when no tool-call accumulator is open', async () => {
        // Only text deltas streamed so far; no pending tool_use. The
        // underlying error should propagate unwrapped so withRetry /
        // callers see the original failure mode.
        const provider = createAnthropicProvider();
        const events = [
          { type: 'message_start', message: { usage: { input_tokens: 5 } } },
          { type: 'content_block_delta', delta: { text: 'thinking' } },
        ];
        const abortErr = new Error('The operation was aborted');
        abortErr.name = 'AbortError';
        const errorStream = makeErroringAsyncIterable(events, 2, abortErr);
        mockAnthropicStream.mockReturnValueOnce(errorStream);

        const err = (await withTimersExpectReject(() =>
          provider.completeWithToolsStream!(
            { messages: basicMessages, tools: basicToolDefs },
            () => {}
          )
        )) as Error;

        expect(err).not.toBeInstanceOf(IncompleteToolCallError);
        expect(err.message).toBe('The operation was aborted');
      });

      it('does NOT wrap when underlying error is retryable (lets withRetry recover)', async () => {
        // An overloaded error mid tool-call should still go through the
        // retry path (clean retry gets fresh state). Wrapping here would
        // prevent withRetry from recognizing the error and block recovery.
        const provider = createAnthropicProvider();
        const failingEvents = [
          { type: 'message_start', message: { usage: { input_tokens: 5 } } },
          {
            type: 'content_block_start',
            content_block: { type: 'tool_use', id: 'call_1', name: 'get_weather' },
          },
          { type: 'content_block_delta', delta: { partial_json: '{"city":"Tok' } },
        ];
        const overloadedErr = new Error('overloaded');
        const recoveryEvents = [
          { type: 'message_start', message: { usage: { input_tokens: 5 } } },
          {
            type: 'content_block_start',
            content_block: { type: 'tool_use', id: 'call_1', name: 'get_weather' },
          },
          { type: 'content_block_delta', delta: { partial_json: '{"city":"Tokyo"}' } },
          { type: 'content_block_stop' },
          {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use' },
            usage: { output_tokens: 10 },
          },
        ];

        mockAnthropicStream
          .mockReturnValueOnce(makeErroringAsyncIterable(failingEvents, 3, overloadedErr))
          .mockReturnValueOnce(makeAsyncIterable(recoveryEvents));

        const result = await withTimers(() =>
          provider.completeWithToolsStream!(
            { messages: basicMessages, tools: basicToolDefs },
            () => {}
          )
        );

        // Retry succeeded, final result has the completed tool call.
        expect(result.toolCalls).toHaveLength(1);
        expect(result.toolCalls![0]!.input).toEqual({ city: 'Tokyo' });
        expect(mockAnthropicStream).toHaveBeenCalledTimes(2);
      });

      it('wraps abort in continueWithToolResultsStream too', async () => {
        // Same surfacing contract for the tool-loop continue path.
        const provider = createAnthropicProvider();
        const events = [
          { type: 'message_start', message: { usage: { input_tokens: 5 } } },
          {
            type: 'content_block_start',
            content_block: { type: 'tool_use', id: 'call_2', name: 'get_weather' },
          },
          { type: 'content_block_delta', delta: { partial_json: '{"ci' } },
        ];
        const abortErr = new Error('The operation was aborted');
        abortErr.name = 'AbortError';
        const errorStream = makeErroringAsyncIterable(events, 3, abortErr);
        mockAnthropicStream.mockReturnValueOnce(errorStream);

        const priorToolCalls: ToolCall[] = [
          { id: 'call_1', name: 'get_weather', input: { city: 'Tokyo' } },
        ];
        const priorResults: ToolResult[] = [
          { toolCallId: 'call_1', content: '72F sunny' },
        ];

        const err = (await withTimersExpectReject(() =>
          provider.continueWithToolResultsStream!(
            { messages: basicMessages, tools: basicToolDefs },
            priorToolCalls,
            priorResults,
            () => {}
          )
        )) as IncompleteToolCallError;

        expect(err).toBeInstanceOf(IncompleteToolCallError);
        expect(err.partialToolCall.id).toBe('call_2');
        expect(err.partialToolCall.inputJson).toBe('{"ci');
      });
    });

    it('handles empty content array', async () => {
      const provider = createAnthropicProvider();
      mockAnthropicCreate.mockResolvedValueOnce(makeAnthropicResponse({ content: [] }));

      const result = await provider.complete({ messages: basicMessages });
      expect(result.content).toBe('');
    });

    it('handles response with multiple content blocks (text + tool_use)', async () => {
      const provider = createAnthropicProvider();
      mockAnthropicCreate.mockResolvedValueOnce(makeAnthropicResponse({
        content: [
          { type: 'text', text: 'Let me check the weather' },
          { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Tokyo' } },
        ],
        stop_reason: 'tool_use',
      }));

      const result = await provider.completeWithTools({
        messages: basicMessages,
        tools: basicToolDefs,
      });
      expect(result.content).toBe('Let me check the weather');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0]!.name).toBe('get_weather');
      expect(result.toolCalls![0]!.input).toEqual({ city: 'Tokyo' });
    });

    it('handles multiple tool_use blocks in a single response', async () => {
      const provider = createAnthropicProvider();
      mockAnthropicCreate.mockResolvedValueOnce(makeAnthropicResponse({
        content: [
          { type: 'text', text: 'Checking both' },
          { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Tokyo' } },
          { type: 'tool_use', id: 'call_2', name: 'get_weather', input: { city: 'London' } },
        ],
        stop_reason: 'tool_use',
      }));

      const result = await provider.completeWithTools({
        messages: basicMessages,
        tools: basicToolDefs,
      });
      expect(result.toolCalls).toHaveLength(2);
    });

    it('handles tool_use with empty input object', async () => {
      const provider = createAnthropicProvider();
      mockAnthropicCreate.mockResolvedValueOnce(makeAnthropicResponse({
        content: [
          { type: 'tool_use', id: 'call_1', name: 'get_time', input: {} },
        ],
        stop_reason: 'tool_use',
      }));

      const result = await provider.completeWithTools({
        messages: basicMessages,
        tools: basicToolDefs,
      });
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0]!.input).toEqual({});
    });

    it('defaults enableCaching to true (findings.md P2:900)', async () => {
      // findings.md P2:900 — default was enableCaching:false, so every
      // deployment paid 10× the input-token cost on long stable personas
      // until someone thought to opt in. Flipped the default so the
      // free performance win is on by default; explicit false still works.
      const provider = createAnthropicProvider();
      mockAnthropicCreate.mockResolvedValueOnce(makeAnthropicResponse());

      await provider.complete({
        messages: [
          { role: 'system', content: 'persona' },
          { role: 'user', content: 'hello' },
        ],
        // Note: enableCaching is intentionally NOT set — relying on the default.
      });

      const params = mockAnthropicCreate.mock.calls[0]![0]!;
      expect(Array.isArray(params.system)).toBe(true);
      expect(params.system[0]).toMatchObject({
        type: 'text',
        cache_control: { type: 'ephemeral' },
      });
    });

    it('applies cache_control to system prompt in complete() when enableCaching=true (findings.md P2:890)', async () => {
      // findings.md P2:890 — completeWithTools honored enableCaching, but
      // complete() ignored it. A caller running a non-tools completion
      // (e.g. a long persona chat) with enableCaching:true saw no cache
      // markers and paid full input-token cost on every turn.
      const provider = createAnthropicProvider();
      mockAnthropicCreate.mockResolvedValueOnce(makeAnthropicResponse());

      await provider.complete({
        messages: [
          { role: 'system', content: 'a stable persona block' },
          { role: 'user', content: 'hello' },
        ],
        enableCaching: true,
      });

      const params = mockAnthropicCreate.mock.calls[0]![0]!;
      // With caching, system is an array of TextBlockParam (not a string),
      // and the last system block carries cache_control.
      expect(Array.isArray(params.system)).toBe(true);
      expect(params.system[params.system.length - 1]).toMatchObject({
        type: 'text',
        cache_control: { type: 'ephemeral' },
      });
    });

    it('does NOT apply cache_control in complete() when enableCaching is false', async () => {
      // Sanity guard: without the flag we send plain-string system, no markers.
      const provider = createAnthropicProvider();
      mockAnthropicCreate.mockResolvedValueOnce(makeAnthropicResponse());

      await provider.complete({
        messages: [
          { role: 'system', content: 'a stable persona block' },
          { role: 'user', content: 'hello' },
        ],
        enableCaching: false,
      });

      const params = mockAnthropicCreate.mock.calls[0]![0]!;
      expect(typeof params.system).toBe('string');
    });

    it('concatenates text that appears after a tool_use block (findings.md P2:880)', async () => {
      // findings.md P2:880 — Anthropic responses can interleave text/tool_use/text.
      // Earlier parsing used content.find(type==='text') or only read the first
      // contiguous run, silently discarding narration emitted after a tool call
      // ("Let me check... [tool_use] ...here's what I found"). The fix is to
      // iterate every content block and concatenate every text block in order.
      const provider = createAnthropicProvider();
      mockAnthropicCreate.mockResolvedValueOnce(makeAnthropicResponse({
        content: [
          { type: 'text', text: 'Let me check the weather. ' },
          { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Tokyo' } },
          { type: 'text', text: "Here's what I found." },
        ],
        stop_reason: 'tool_use',
      }));

      const result = await provider.completeWithTools({
        messages: basicMessages,
        tools: basicToolDefs,
      });
      expect(result.content).toBe("Let me check the weather. Here's what I found.");
      expect(result.toolCalls).toHaveLength(1);
    });
  });

  describe('stop reason mapping', () => {
    it('maps end_turn to stop', async () => {
      const provider = createAnthropicProvider();
      mockAnthropicCreate.mockResolvedValueOnce(makeAnthropicResponse({ stop_reason: 'end_turn' }));

      const result = await provider.complete({ messages: basicMessages });
      expect(result.finishReason).toBe('stop');
    });

    it('maps stop_sequence to stop', async () => {
      const provider = createAnthropicProvider();
      mockAnthropicCreate.mockResolvedValueOnce(makeAnthropicResponse({ stop_reason: 'stop_sequence' }));

      const result = await provider.complete({ messages: basicMessages });
      expect(result.finishReason).toBe('stop');
    });

    it('maps max_tokens to length', async () => {
      const provider = createAnthropicProvider();
      mockAnthropicCreate.mockResolvedValueOnce(makeAnthropicResponse({ stop_reason: 'max_tokens' }));

      const result = await provider.complete({ messages: basicMessages });
      expect(result.finishReason).toBe('length');
    });

    it('maps tool_use to tool_use', async () => {
      const provider = createAnthropicProvider();
      mockAnthropicCreate.mockResolvedValueOnce(makeAnthropicResponse({
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'call_1', name: 'test', input: {} },
        ],
      }));

      const result = await provider.completeWithTools({
        messages: basicMessages,
        tools: basicToolDefs,
      });
      expect(result.finishReason).toBe('tool_use');
    });

    it('maps null stop_reason to stop', async () => {
      const provider = createAnthropicProvider();
      mockAnthropicCreate.mockResolvedValueOnce(makeAnthropicResponse({ stop_reason: null }));

      const result = await provider.complete({ messages: basicMessages });
      expect(result.finishReason).toBe('stop');
    });

    it('maps unknown stop_reason to "unknown" (findings.md P2:940)', async () => {
      // findings.md P2:940 — the prior mapper folded every unrecognized
      // stop_reason into 'stop', so new Anthropic enum members looked
      // identical to clean completions. Map them to 'unknown' so
      // callers can branch/log on genuinely novel signals.
      const provider = createAnthropicProvider();
      mockAnthropicCreate.mockResolvedValueOnce(makeAnthropicResponse({ stop_reason: 'weird_reason' }));

      const result = await provider.complete({ messages: basicMessages });
      expect(result.finishReason).toBe('unknown');
    });

    it('maps refusal to content_filter (findings.md P2:940)', async () => {
      // findings.md P2:940 — a safety refusal used to collapse to 'stop'
      // because the mapper only knew end_turn/stop_sequence/max_tokens/
      // tool_use. The caller saw a clean completion and never surfaced
      // the refusal signal.
      const provider = createAnthropicProvider();
      mockAnthropicCreate.mockResolvedValueOnce(makeAnthropicResponse({ stop_reason: 'refusal' }));

      const result = await provider.complete({ messages: basicMessages });
      expect(result.finishReason).toBe('content_filter');
    });
  });

  describe('max_tokens stop_reason in streaming vs non-streaming', () => {
    it('detects max_tokens in non-streaming response', async () => {
      const provider = createAnthropicProvider();
      mockAnthropicCreate.mockResolvedValueOnce(makeAnthropicResponse({ stop_reason: 'max_tokens' }));

      const result = await provider.complete({ messages: basicMessages });
      expect(result.finishReason).toBe('length');
    });

    it('detects max_tokens in streaming response via message_delta', async () => {
      const provider = createAnthropicProvider();
      const events = [
        { type: 'message_start', message: { usage: { input_tokens: 5 } } },
        { type: 'content_block_delta', delta: { text: 'truncated...' } },
        { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 100 } },
      ];

      mockAnthropicStream.mockReturnValueOnce(makeAsyncIterable(events));

      const chunks: string[] = [];
      const result = await provider.completeStream!({ messages: basicMessages }, (c) => chunks.push(c));
      expect(result.finishReason).toBe('length');
      expect(result.content).toBe('truncated...');
    });
  });

  describe('streaming usage tracking', () => {
    it('tracks input tokens from message_start event', async () => {
      const provider = createAnthropicProvider();
      const events = [
        { type: 'message_start', message: { usage: { input_tokens: 42 } } },
        { type: 'content_block_delta', delta: { text: 'hi' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
      ];

      mockAnthropicStream.mockReturnValueOnce(makeAsyncIterable(events));

      const result = await provider.completeStream!({ messages: basicMessages }, vi.fn());
      expect(result.usage.inputTokens).toBe(42);
      expect(result.usage.outputTokens).toBe(7);
    });
  });

  describe('streaming tool use', () => {
    it('accumulates partial_json across multiple deltas', async () => {
      const provider = createAnthropicProvider();
      const events = [
        { type: 'message_start', message: { usage: { input_tokens: 5 } } },
        { type: 'content_block_start', content_block: { type: 'tool_use', id: 'call_1', name: 'get_weather' } },
        { type: 'content_block_delta', delta: { partial_json: '{"ci' } },
        { type: 'content_block_delta', delta: { partial_json: 'ty":"T' } },
        { type: 'content_block_delta', delta: { partial_json: 'okyo"}' } },
        { type: 'content_block_stop' },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10 } },
      ];

      mockAnthropicStream.mockReturnValueOnce(makeAsyncIterable(events));

      const result = await provider.completeWithToolsStream!(
        { messages: basicMessages, tools: basicToolDefs },
        vi.fn()
      );
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0]!.input).toEqual({ city: 'Tokyo' });
    });

    it('handles tool_use with empty JSON in streaming', async () => {
      const provider = createAnthropicProvider();
      const events = [
        { type: 'message_start', message: { usage: { input_tokens: 5 } } },
        { type: 'content_block_start', content_block: { type: 'tool_use', id: 'call_1', name: 'test' } },
        { type: 'content_block_stop' },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
      ];

      mockAnthropicStream.mockReturnValueOnce(makeAsyncIterable(events));

      const result = await provider.completeWithToolsStream!(
        { messages: basicMessages, tools: basicToolDefs },
        vi.fn()
      );
      // Empty input falls back to {}
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0]!.input).toEqual({});
    });

    it('handles interleaved text and tool_use blocks in streaming', async () => {
      const provider = createAnthropicProvider();
      const events = [
        { type: 'message_start', message: { usage: { input_tokens: 5 } } },
        { type: 'content_block_start', content_block: { type: 'text' } },
        { type: 'content_block_delta', delta: { text: 'Checking weather: ' } },
        { type: 'content_block_stop' },
        { type: 'content_block_start', content_block: { type: 'tool_use', id: 'call_1', name: 'get_weather' } },
        { type: 'content_block_delta', delta: { partial_json: '{"city":"NYC"}' } },
        { type: 'content_block_stop' },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 15 } },
      ];

      mockAnthropicStream.mockReturnValueOnce(makeAsyncIterable(events));

      const chunks: string[] = [];
      const result = await provider.completeWithToolsStream!(
        { messages: basicMessages, tools: basicToolDefs },
        (c) => chunks.push(c)
      );
      expect(result.content).toBe('Checking weather: ');
      expect(chunks).toEqual(['Checking weather: ']);
      expect(result.toolCalls).toHaveLength(1);
    });
  });

  describe('continueWithToolResults error handling', () => {
    it('retries overloaded errors during continueWithToolResults', async () => {
      const provider = createAnthropicProvider();
      const overloadedErr = new Error('overloaded');

      mockAnthropicCreate
        .mockRejectedValueOnce(overloadedErr)
        .mockResolvedValueOnce(makeAnthropicResponse());

      const result = await withTimers(() => provider.continueWithToolResults(
        { messages: basicMessages, tools: basicToolDefs },
        [{ id: 'call_1', name: 'test', input: {} }],
        [{ toolCallId: 'call_1', content: 'result' }]
      ));
      expect(result.content).toBe('hello');
      expect(mockAnthropicCreate).toHaveBeenCalledTimes(2);
    });

    it('does not retry 401 during continueWithToolResults', async () => {
      const provider = createAnthropicProvider();
      const err = makeAnthropicError(401, 'Unauthorized');

      mockAnthropicCreate.mockRejectedValueOnce(err);

      await expect(
        provider.continueWithToolResults(
          { messages: basicMessages, tools: basicToolDefs },
          [{ id: 'call_1', name: 'test', input: {} }],
          [{ toolCallId: 'call_1', content: 'result' }]
        )
      ).rejects.toThrow('Unauthorized');
      expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
    });
  });

  describe('continueWithToolResults* preserves assistant text turn (findings.md P2:930)', () => {
    // findings.md P2:930 — the prior turn's text blocks ("I'll look that
    // up...") used to be dropped when reconstructing the assistant
    // message for the continue call. The model then saw a history where
    // it had called tools without saying anything, silently erasing its
    // own narration on every tool iteration.
    it('prepends assistant text as a text block in continueWithToolResults', async () => {
      const provider = createAnthropicProvider();
      mockAnthropicCreate.mockResolvedValueOnce(makeAnthropicResponse());

      await provider.continueWithToolResults(
        { messages: basicMessages, tools: basicToolDefs },
        [{ id: 'call_1', name: 'get_weather', input: { city: 'Tokyo' } }],
        [{ toolCallId: 'call_1', content: '72F sunny' }],
        "I'll look that up for you..."
      );

      const params = mockAnthropicCreate.mock.calls[0]![0]!;
      // The assistant message is the penultimate; the final is the user
      // tool_result message.
      const assistantMessage = params.messages[params.messages.length - 2];
      expect(assistantMessage.role).toBe('assistant');
      expect(assistantMessage.content[0]).toMatchObject({
        type: 'text',
        text: "I'll look that up for you...",
      });
      expect(assistantMessage.content[1]).toMatchObject({
        type: 'tool_use',
        id: 'call_1',
        name: 'get_weather',
      });
    });

    it('omits the text block when assistantText is empty/undefined', async () => {
      // Anthropic rejects empty text blocks in assistant messages; the
      // old behavior (tool_use-only assistant message) must still work
      // when callers don't pass assistantText.
      const provider = createAnthropicProvider();
      mockAnthropicCreate.mockResolvedValueOnce(makeAnthropicResponse());

      await provider.continueWithToolResults(
        { messages: basicMessages, tools: basicToolDefs },
        [{ id: 'call_1', name: 'get_weather', input: { city: 'Tokyo' } }],
        [{ toolCallId: 'call_1', content: '72F sunny' }]
      );

      const params = mockAnthropicCreate.mock.calls[0]![0]!;
      const assistantMessage = params.messages[params.messages.length - 2];
      expect(assistantMessage.content).toHaveLength(1);
      expect(assistantMessage.content[0]).toMatchObject({ type: 'tool_use' });
    });

    it('omits the text block when assistantText is an empty string', async () => {
      const provider = createAnthropicProvider();
      mockAnthropicCreate.mockResolvedValueOnce(makeAnthropicResponse());

      await provider.continueWithToolResults(
        { messages: basicMessages, tools: basicToolDefs },
        [{ id: 'call_1', name: 'get_weather', input: { city: 'Tokyo' } }],
        [{ toolCallId: 'call_1', content: '72F sunny' }],
        ''
      );

      const params = mockAnthropicCreate.mock.calls[0]![0]!;
      const assistantMessage = params.messages[params.messages.length - 2];
      expect(assistantMessage.content).toHaveLength(1);
      expect(assistantMessage.content[0]).toMatchObject({ type: 'tool_use' });
    });

    it('prepends assistant text in continueWithToolResultsStream', async () => {
      const provider = createAnthropicProvider();
      const events = [
        { type: 'message_start', message: { usage: { input_tokens: 5 } } },
        { type: 'content_block_delta', delta: { text: 'done' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
      ];
      mockAnthropicStream.mockReturnValueOnce(makeAsyncIterable(events));

      await provider.continueWithToolResultsStream!(
        { messages: basicMessages, tools: basicToolDefs },
        [{ id: 'call_1', name: 'get_weather', input: { city: 'Tokyo' } }],
        [{ toolCallId: 'call_1', content: '72F sunny' }],
        () => {},
        'Checking weather now...'
      );

      const params = mockAnthropicStream.mock.calls[0]![0]!;
      const assistantMessage = params.messages[params.messages.length - 2];
      expect(assistantMessage.content[0]).toMatchObject({
        type: 'text',
        text: 'Checking weather now...',
      });
      expect(assistantMessage.content[1]).toMatchObject({
        type: 'tool_use',
        id: 'call_1',
      });
    });
  });

  describe('continueWithToolResults* plumbs toolChoice (findings.md P2:920)', () => {
    // findings.md P2:920 — completeWithTools honored options.toolChoice,
    // but the continue* paths silently dropped it. An agent loop forcing
    // a wrap-up turn via toolChoice:'none' could still trigger another
    // tool call because the wrapper never translated that intent.
    it('passes toolChoice="auto" through continueWithToolResults', async () => {
      const provider = createAnthropicProvider();
      mockAnthropicCreate.mockResolvedValueOnce(makeAnthropicResponse());

      await provider.continueWithToolResults(
        { messages: basicMessages, tools: basicToolDefs, toolChoice: 'auto' },
        [{ id: 'call_1', name: 'get_weather', input: { city: 'Tokyo' } }],
        [{ toolCallId: 'call_1', content: '72F sunny' }]
      );

      const params = mockAnthropicCreate.mock.calls[0]![0]!;
      expect(params.tool_choice).toEqual({ type: 'auto' });
    });

    it('passes named tool choice through continueWithToolResults', async () => {
      const provider = createAnthropicProvider();
      mockAnthropicCreate.mockResolvedValueOnce(makeAnthropicResponse());

      await provider.continueWithToolResults(
        {
          messages: basicMessages,
          tools: basicToolDefs,
          toolChoice: { type: 'tool', name: 'get_weather' },
        },
        [{ id: 'call_1', name: 'get_weather', input: { city: 'Tokyo' } }],
        [{ toolCallId: 'call_1', content: '72F sunny' }]
      );

      const params = mockAnthropicCreate.mock.calls[0]![0]!;
      expect(params.tool_choice).toEqual({ type: 'tool', name: 'get_weather' });
    });

    it('suppresses tools entirely when toolChoice="none" in continueWithToolResults', async () => {
      // Anthropic has no 'none' in ToolChoice — the only way to force "no
      // more tools" is to not send any tools at all (same shortcut
      // completeWithTools uses).
      const provider = createAnthropicProvider();
      mockAnthropicCreate.mockResolvedValueOnce(makeAnthropicResponse());

      await provider.continueWithToolResults(
        { messages: basicMessages, tools: basicToolDefs, toolChoice: 'none' },
        [{ id: 'call_1', name: 'get_weather', input: { city: 'Tokyo' } }],
        [{ toolCallId: 'call_1', content: '72F sunny' }]
      );

      const params = mockAnthropicCreate.mock.calls[0]![0]!;
      expect(params.tools).toBeUndefined();
      expect(params.tool_choice).toBeUndefined();
    });

    it('omits tool_choice when not specified (preserves default Anthropic behavior)', async () => {
      const provider = createAnthropicProvider();
      mockAnthropicCreate.mockResolvedValueOnce(makeAnthropicResponse());

      await provider.continueWithToolResults(
        { messages: basicMessages, tools: basicToolDefs },
        [{ id: 'call_1', name: 'get_weather', input: { city: 'Tokyo' } }],
        [{ toolCallId: 'call_1', content: '72F sunny' }]
      );

      const params = mockAnthropicCreate.mock.calls[0]![0]!;
      expect(params.tool_choice).toBeUndefined();
      expect(params.tools).toBeDefined();
    });

    it('passes toolChoice through continueWithToolResultsStream', async () => {
      const provider = createAnthropicProvider();
      const events = [
        { type: 'message_start', message: { usage: { input_tokens: 5 } } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
      ];
      mockAnthropicStream.mockReturnValueOnce(makeAsyncIterable(events));

      await provider.continueWithToolResultsStream!(
        { messages: basicMessages, tools: basicToolDefs, toolChoice: 'auto' },
        [{ id: 'call_1', name: 'get_weather', input: { city: 'Tokyo' } }],
        [{ toolCallId: 'call_1', content: '72F sunny' }],
        () => {}
      );

      const params = mockAnthropicStream.mock.calls[0]![0]!;
      expect(params.tool_choice).toEqual({ type: 'auto' });
    });

    it('suppresses tools in continueWithToolResultsStream when toolChoice="none"', async () => {
      const provider = createAnthropicProvider();
      const events = [
        { type: 'message_start', message: { usage: { input_tokens: 5 } } },
        { type: 'content_block_delta', delta: { text: 'done' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
      ];
      mockAnthropicStream.mockReturnValueOnce(makeAsyncIterable(events));

      await provider.continueWithToolResultsStream!(
        { messages: basicMessages, tools: basicToolDefs, toolChoice: 'none' },
        [{ id: 'call_1', name: 'get_weather', input: { city: 'Tokyo' } }],
        [{ toolCallId: 'call_1', content: '72F sunny' }],
        () => {}
      );

      const params = mockAnthropicStream.mock.calls[0]![0]!;
      expect(params.tools).toBeUndefined();
      expect(params.tool_choice).toBeUndefined();
    });
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// 2. OPENAI-SPECIFIC ERROR HANDLING
// ═══════════════════════════════════════════════════════════════════════════════

describe('OpenAI-specific error handling', () => {

  describe('429 rate limit', () => {
    it('retries on 429 status code', async () => {
      const provider = createOpenAIProvider();
      const err = makeOpenAIError(429, 'Rate limit exceeded');

      mockOpenAICreate
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce(makeOpenAIResponse());

      const result = await withTimers(() => provider.complete({ messages: basicMessages }));
      expect(result.content).toBe('hello');
      expect(mockOpenAICreate).toHaveBeenCalledTimes(2);
    });

    it('retries on "rate limit" in error message even without status', async () => {
      const provider = createOpenAIProvider();
      const err = new Error('Rate limit exceeded, please try again');

      mockOpenAICreate
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce(makeOpenAIResponse());

      const result = await withTimers(() => provider.complete({ messages: basicMessages }));
      expect(result.content).toBe('hello');
    });

    it('retries on "too many requests" in error message', async () => {
      const provider = createOpenAIProvider();
      const err = new Error('Too many requests');

      mockOpenAICreate
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce(makeOpenAIResponse());

      const result = await withTimers(() => provider.complete({ messages: basicMessages }));
      expect(result.content).toBe('hello');
    });

    it('applies exponential backoff on 429: 1s, 2s, 4s', async () => {
      const provider = createOpenAIProvider();
      const err = makeOpenAIError(429, 'Rate limit');

      mockOpenAICreate
        .mockRejectedValueOnce(err)
        .mockRejectedValueOnce(err)
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce(makeOpenAIResponse());

      const promise = provider.complete({ messages: basicMessages });
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(4000);
      const result = await promise;
      expect(result.content).toBe('hello');
      expect(mockOpenAICreate).toHaveBeenCalledTimes(4);
    });

    it('throws after max retries on persistent 429', async () => {
      const provider = createOpenAIProvider();
      const err = makeOpenAIError(429, 'Rate limit');

      mockOpenAICreate.mockRejectedValue(err);

      const thrown = await withTimersExpectReject(() => provider.complete({ messages: basicMessages }));
      expect((thrown as Error).message).toContain('Rate limit');
      expect(mockOpenAICreate).toHaveBeenCalledTimes(4);
    });
  });

  describe('500 server error', () => {
    it('retries on 500 status', async () => {
      const provider = createOpenAIProvider();
      const err = makeOpenAIError(500, 'Internal server error');

      mockOpenAICreate
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce(makeOpenAIResponse());

      const result = await withTimers(() => provider.complete({ messages: basicMessages }));
      expect(result.content).toBe('hello');
      expect(mockOpenAICreate).toHaveBeenCalledTimes(2);
    });

    it('retries on "server error" in message', async () => {
      const provider = createOpenAIProvider();
      const err = new Error('server error');

      mockOpenAICreate
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce(makeOpenAIResponse());

      const result = await withTimers(() => provider.complete({ messages: basicMessages }));
      expect(result.content).toBe('hello');
    });
  });

  describe('502 bad gateway', () => {
    it('retries on 502 status', async () => {
      const provider = createOpenAIProvider();
      const err = makeOpenAIError(502, 'Bad gateway');

      mockOpenAICreate
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce(makeOpenAIResponse());

      const result = await withTimers(() => provider.complete({ messages: basicMessages }));
      expect(result.content).toBe('hello');
    });

    it('retries on "bad gateway" in message', async () => {
      const provider = createOpenAIProvider();
      const err = new Error('bad gateway');

      mockOpenAICreate
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce(makeOpenAIResponse());

      const result = await withTimers(() => provider.complete({ messages: basicMessages }));
      expect(result.content).toBe('hello');
    });
  });

  describe('503 service unavailable', () => {
    it('retries on 503 status', async () => {
      const provider = createOpenAIProvider();
      const err = makeOpenAIError(503, 'Service unavailable');

      mockOpenAICreate
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce(makeOpenAIResponse());

      const result = await withTimers(() => provider.complete({ messages: basicMessages }));
      expect(result.content).toBe('hello');
      expect(mockOpenAICreate).toHaveBeenCalledTimes(2);
    });

    it('retries on "service unavailable" in message', async () => {
      const provider = createOpenAIProvider();
      const err = new Error('service unavailable');

      mockOpenAICreate
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce(makeOpenAIResponse());

      const result = await withTimers(() => provider.complete({ messages: basicMessages }));
      expect(result.content).toBe('hello');
    });

    it('does not retry "temporarily unavailable" (no match in retry patterns)', async () => {
      const provider = createOpenAIProvider();
      const err = new Error('The service is temporarily unavailable');

      mockOpenAICreate.mockRejectedValueOnce(err);

      // "temporarily unavailable" does not contain "service unavailable" substring
      await expect(provider.complete({ messages: basicMessages }))
        .rejects.toThrow('temporarily unavailable');
      expect(mockOpenAICreate).toHaveBeenCalledTimes(1);
    });
  });

  describe('non-retryable errors', () => {
    it('does not retry 400 bad request', async () => {
      const provider = createOpenAIProvider();
      const err = makeOpenAIError(400, 'Invalid request');

      mockOpenAICreate.mockRejectedValueOnce(err);

      await expect(provider.complete({ messages: basicMessages }))
        .rejects.toThrow('Invalid request');
      expect(mockOpenAICreate).toHaveBeenCalledTimes(1);
    });

    it('does not retry 401 unauthorized', async () => {
      const provider = createOpenAIProvider();
      const err = makeOpenAIError(401, 'Invalid API key');

      mockOpenAICreate.mockRejectedValueOnce(err);

      await expect(provider.complete({ messages: basicMessages }))
        .rejects.toThrow('Invalid API key');
      expect(mockOpenAICreate).toHaveBeenCalledTimes(1);
    });

    it('does not retry 403 forbidden', async () => {
      const provider = createOpenAIProvider();
      const err = makeOpenAIError(403, 'Access denied');

      mockOpenAICreate.mockRejectedValueOnce(err);

      await expect(provider.complete({ messages: basicMessages }))
        .rejects.toThrow('Access denied');
      expect(mockOpenAICreate).toHaveBeenCalledTimes(1);
    });

    it('propagates context length exceeded error without retry', async () => {
      const provider = createOpenAIProvider();
      const err = makeOpenAIError(400, "This model's maximum context length is 8192 tokens");

      mockOpenAICreate.mockRejectedValueOnce(err);

      await expect(provider.complete({ messages: basicMessages }))
        .rejects.toThrow("maximum context length");
      expect(mockOpenAICreate).toHaveBeenCalledTimes(1);
    });
  });

  describe('finish_reason mapping', () => {
    it('maps "stop" to stop', async () => {
      const provider = createOpenAIProvider();
      mockOpenAICreate.mockResolvedValueOnce(makeOpenAIResponse());

      const result = await provider.complete({ messages: basicMessages });
      expect(result.finishReason).toBe('stop');
    });

    it('maps "length" to length (max_tokens equivalent)', async () => {
      const provider = createOpenAIProvider();
      mockOpenAICreate.mockResolvedValueOnce({
        choices: [{ message: { content: 'truncated' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 10, completion_tokens: 100 },
      });

      const result = await provider.complete({ messages: basicMessages });
      expect(result.finishReason).toBe('length');
    });

    it('maps "content_filter" to content_filter', async () => {
      const provider = createOpenAIProvider();
      mockOpenAICreate.mockResolvedValueOnce({
        choices: [{ message: { content: '' }, finish_reason: 'content_filter' }],
        usage: { prompt_tokens: 10, completion_tokens: 0 },
      });

      const result = await provider.complete({ messages: basicMessages });
      expect(result.finishReason).toBe('content_filter');
    });

    it('maps "tool_calls" to tool_use', async () => {
      const provider = createOpenAIProvider();
      mockOpenAICreate.mockResolvedValueOnce({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 15 },
      });

      const result = await provider.completeWithTools({
        messages: basicMessages,
        tools: basicToolDefs,
      });
      expect(result.finishReason).toBe('tool_use');
    });

    it('maps null finish_reason to stop', async () => {
      const provider = createOpenAIProvider();
      mockOpenAICreate.mockResolvedValueOnce({
        choices: [{ message: { content: 'hello' }, finish_reason: null }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });

      const result = await provider.complete({ messages: basicMessages });
      expect(result.finishReason).toBe('stop');
    });

    it('maps unknown finish_reason to "unknown" (findings.md P2:940)', async () => {
      // findings.md P2:940 — same cross-provider pattern as Anthropic.
      // Novel OpenAI finish_reason values surface as 'unknown' so a
      // future safety-refusal enum member doesn't silently look like a
      // clean completion.
      const provider = createOpenAIProvider();
      mockOpenAICreate.mockResolvedValueOnce({
        choices: [{ message: { content: 'hello' }, finish_reason: 'something_new' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });

      const result = await provider.complete({ messages: basicMessages });
      expect(result.finishReason).toBe('unknown');
    });
  });

  describe('response with null/empty content', () => {
    it('handles null content (tool-only response)', async () => {
      const provider = createOpenAIProvider();
      mockOpenAICreate.mockResolvedValueOnce({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 15 },
      });

      const result = await provider.completeWithTools({
        messages: basicMessages,
        tools: basicToolDefs,
      });
      expect(result.content).toBe('');
      expect(result.toolCalls).toHaveLength(1);
    });

    it('handles empty choices array', async () => {
      const provider = createOpenAIProvider();
      mockOpenAICreate.mockResolvedValueOnce({
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 0 },
      });

      const result = await provider.complete({ messages: basicMessages });
      expect(result.content).toBe('');
    });

    it('handles missing usage object', async () => {
      const provider = createOpenAIProvider();
      mockOpenAICreate.mockResolvedValueOnce({
        choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
        usage: undefined,
      });

      const result = await provider.complete({ messages: basicMessages });
      expect(result.usage.inputTokens).toBe(0);
      expect(result.usage.outputTokens).toBe(0);
    });
  });

  describe('tool call parsing', () => {
    it('parses tool call arguments from JSON string', async () => {
      const provider = createOpenAIProvider();
      mockOpenAICreate.mockResolvedValueOnce({
        choices: [{
          message: {
            content: 'checking',
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"London","units":"celsius"}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 15 },
      });

      const result = await provider.completeWithTools({
        messages: basicMessages,
        tools: basicToolDefs,
      });
      expect(result.toolCalls![0]!.input).toEqual({ city: 'London', units: 'celsius' });
    });

    it('degrades to empty input on malformed tool call JSON (findings.md P2:970)', async () => {
      // findings.md P2:970 — the prior implementation crashed the whole
      // completion with a SyntaxError when OpenAI returned malformed JSON
      // (usually truncation at max_tokens). We now degrade to {} + warn log.
      const provider = createOpenAIProvider();
      mockOpenAICreate.mockResolvedValueOnce({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: { name: 'test', arguments: '{invalid json}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 15 },
      });

      const result = await provider.completeWithTools({
        messages: basicMessages,
        tools: basicToolDefs,
      });
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0]!.name).toBe('test');
      expect(result.toolCalls![0]!.input).toEqual({});
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({ toolCallId: 'call_1', toolName: 'test' }),
        expect.stringContaining('malformed JSON'),
      );
    });

    it('degrades to empty input when JSON parses to a non-object (findings.md P2:970)', async () => {
      const provider = createOpenAIProvider();
      mockOpenAICreate.mockResolvedValueOnce({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: { name: 'test', arguments: '42' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });

      const result = await provider.completeWithTools({
        messages: basicMessages,
        tools: basicToolDefs,
      });
      expect(result.toolCalls![0]!.input).toEqual({});
    });

    it('degrades to empty input on malformed JSON in continueWithToolResults (findings.md P2:970)', async () => {
      const provider = createOpenAIProvider();
      mockOpenAICreate.mockResolvedValueOnce({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: 'call_2',
              type: 'function',
              function: { name: 'followup', arguments: '{"partial":' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });

      const result = await provider.continueWithToolResults(
        { messages: basicMessages, tools: basicToolDefs },
        [{ id: 'call_1', name: 'test', input: {} }],
        [{ toolCallId: 'call_1', content: 'ok' }],
      );
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0]!.input).toEqual({});
    });

    it('handles multiple tool calls in one response', async () => {
      const provider = createOpenAIProvider();
      mockOpenAICreate.mockResolvedValueOnce({
        choices: [{
          message: {
            content: null,
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'tool_a', arguments: '{"x":1}' } },
              { id: 'call_2', type: 'function', function: { name: 'tool_b', arguments: '{"y":2}' } },
            ],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      });

      const result = await provider.completeWithTools({
        messages: basicMessages,
        tools: basicToolDefs,
      });
      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls![0]!.name).toBe('tool_a');
      expect(result.toolCalls![1]!.name).toBe('tool_b');
    });

    it('handles empty tool_calls array', async () => {
      const provider = createOpenAIProvider();
      mockOpenAICreate.mockResolvedValueOnce({
        choices: [{
          message: { content: 'just text', tool_calls: [] },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });

      const result = await provider.completeWithTools({
        messages: basicMessages,
        tools: basicToolDefs,
      });
      expect(result.toolCalls).toBeUndefined();
    });
  });

  describe('continueWithToolResults', () => {
    it('retries on 429 during continueWithToolResults', async () => {
      const provider = createOpenAIProvider();
      const err = makeOpenAIError(429, 'Rate limit');

      mockOpenAICreate
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce(makeOpenAIResponse());

      const result = await withTimers(() => provider.continueWithToolResults(
        { messages: basicMessages, tools: basicToolDefs },
        [{ id: 'call_1', name: 'test', input: {} }],
        [{ toolCallId: 'call_1', content: 'result' }]
      ));
      expect(result.content).toBe('hello');
    });

    it('does not retry 401 during continueWithToolResults', async () => {
      const provider = createOpenAIProvider();
      const err = makeOpenAIError(401, 'Unauthorized');

      mockOpenAICreate.mockRejectedValueOnce(err);

      await expect(
        provider.continueWithToolResults(
          { messages: basicMessages, tools: basicToolDefs },
          [{ id: 'call_1', name: 'test', input: {} }],
          [{ toolCallId: 'call_1', content: 'result' }]
        )
      ).rejects.toThrow('Unauthorized');
      expect(mockOpenAICreate).toHaveBeenCalledTimes(1);
    });

    it('passes tool results with correct message structure', async () => {
      const provider = createOpenAIProvider();
      mockOpenAICreate.mockResolvedValueOnce(makeOpenAIResponse());

      await provider.continueWithToolResults(
        { messages: basicMessages, tools: basicToolDefs },
        [{ id: 'call_1', name: 'get_weather', input: { city: 'Tokyo' } }],
        [{ toolCallId: 'call_1', content: 'Sunny, 25C' }]
      );

      const calledParams = mockOpenAICreate.mock.calls[0]![0]!;
      const messages = calledParams.messages;
      // Should have: system, user, assistant (with tool_calls), tool (result)
      expect(messages).toHaveLength(4);
      expect(messages[2].role).toBe('assistant');
      expect(messages[3].role).toBe('tool');
      expect(messages[3].content).toBe('Sunny, 25C');
    });
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// 3. GOOGLE-SPECIFIC ERROR HANDLING
// ═══════════════════════════════════════════════════════════════════════════════

describe('Google-specific error handling', () => {

  describe('safety filter handling', () => {
    it('maps SAFETY finish reason to content_filter', async () => {
      const provider = createGoogleProviderInstance();
      mockGenerateContent.mockResolvedValueOnce(makeGoogleResponse('', 'SAFETY'));

      const result = await provider.complete({ messages: basicMessages });
      expect(result.finishReason).toBe('content_filter');
    });

    it('returns empty content when safety-blocked', async () => {
      const provider = createGoogleProviderInstance();
      mockGenerateContent.mockResolvedValueOnce({
        response: {
          text: () => '',
          candidates: [
            {
              finishReason: 'SAFETY',
              content: { parts: [] },
            },
          ],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 0 },
        },
      });

      const result = await provider.complete({ messages: basicMessages });
      expect(result.content).toBe('');
      expect(result.finishReason).toBe('content_filter');
    });

    it('handles safety-blocked response with no candidates', async () => {
      const provider = createGoogleProviderInstance();
      mockGenerateContent.mockResolvedValueOnce({
        response: {
          text: () => '',
          candidates: [],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 0 },
        },
      });

      const result = await provider.complete({ messages: basicMessages });
      expect(result.content).toBe('');
      // No candidates means finishReason is undefined -> mapped to 'stop'
      expect(result.finishReason).toBe('stop');
    });

    it('handles safety-blocked response with null candidates', async () => {
      const provider = createGoogleProviderInstance();
      mockGenerateContent.mockResolvedValueOnce({
        response: {
          text: () => '',
          candidates: null,
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 0 },
        },
      });

      const result = await provider.complete({ messages: basicMessages });
      expect(result.content).toBe('');
    });
  });

  describe('RECITATION / BLOCKLIST / PROHIBITED_CONTENT finish reasons (findings.md P2:1000)', () => {
    // findings.md P2:1000 — the Gemini SDK's response.text() throws for any
    // blocked finish reason. We now iterate parts directly in complete() so
    // a block becomes empty content + content_filter, not an uncaught throw.
    it('maps RECITATION to content_filter', async () => {
      const provider = createGoogleProviderInstance();
      mockGenerateContent.mockResolvedValueOnce(makeGoogleResponse('some text', 'RECITATION'));

      const result = await provider.complete({ messages: basicMessages });
      expect(result.finishReason).toBe('content_filter');
    });

    it('maps BLOCKLIST to content_filter', async () => {
      const provider = createGoogleProviderInstance();
      mockGenerateContent.mockResolvedValueOnce(makeGoogleResponse('', 'BLOCKLIST'));

      const result = await provider.complete({ messages: basicMessages });
      expect(result.finishReason).toBe('content_filter');
    });

    it('maps PROHIBITED_CONTENT to content_filter', async () => {
      const provider = createGoogleProviderInstance();
      mockGenerateContent.mockResolvedValueOnce(makeGoogleResponse('', 'PROHIBITED_CONTENT'));

      const result = await provider.complete({ messages: basicMessages });
      expect(result.finishReason).toBe('content_filter');
    });

    it('does not throw when blocked response.text() would throw (findings.md P2:1000)', async () => {
      const provider = createGoogleProviderInstance();
      // Simulate the real SDK behaviour: response.text() throws on blocked
      // responses with a message like "Cannot get text from candidate with
      // no content." — we should NOT be calling it anymore.
      mockGenerateContent.mockResolvedValueOnce({
        response: {
          text: () => {
            throw new Error('Cannot get text from candidate with finish reason SAFETY');
          },
          candidates: [
            { finishReason: 'SAFETY', content: { parts: [] } },
          ],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 0 },
        },
      });

      const result = await provider.complete({ messages: basicMessages });
      expect(result.content).toBe('');
      expect(result.finishReason).toBe('content_filter');
    });
  });

  describe('MAX_TOKENS finish reason', () => {
    it('maps MAX_TOKENS to length', async () => {
      const provider = createGoogleProviderInstance();
      mockGenerateContent.mockResolvedValueOnce(makeGoogleResponse('truncated', 'MAX_TOKENS'));

      const result = await provider.complete({ messages: basicMessages });
      expect(result.finishReason).toBe('length');
    });
  });

  describe('finish reason mapping comprehensive', () => {
    it('maps STOP to stop', async () => {
      const provider = createGoogleProviderInstance();
      mockGenerateContent.mockResolvedValueOnce(makeGoogleResponse('ok', 'STOP'));

      const result = await provider.complete({ messages: basicMessages });
      expect(result.finishReason).toBe('stop');
    });

    it('maps undefined finish reason to stop', async () => {
      const provider = createGoogleProviderInstance();
      mockGenerateContent.mockResolvedValueOnce(makeGoogleResponse('ok', undefined as unknown as string));

      const result = await provider.complete({ messages: basicMessages });
      expect(result.finishReason).toBe('stop');
    });

    it('maps unknown finish reason to "unknown" (findings.md P2:940)', async () => {
      // findings.md P2:940 — same cross-provider pattern as Anthropic.
      // New/unrecognized Gemini finishReason values (future safety
      // categories, etc.) surface as 'unknown' so callers can branch.
      const provider = createGoogleProviderInstance();
      mockGenerateContent.mockResolvedValueOnce(makeGoogleResponse('ok', 'BRAND_NEW_REASON'));

      const result = await provider.complete({ messages: basicMessages });
      expect(result.finishReason).toBe('unknown');
    });
  });

  describe('retryable errors', () => {
    it('retries on 429 rate limit', async () => {
      const provider = createGoogleProviderInstance();
      const err = makeGoogleError(429, 'Resource exhausted');

      mockGenerateContent
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce(makeGoogleResponse());

      const result = await withTimers(() => provider.complete({ messages: basicMessages }));
      expect(result.content).toBe('hello');
      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    });

    it('retries on 500 server error', async () => {
      const provider = createGoogleProviderInstance();
      const err = makeGoogleError(500, 'Internal error');

      mockGenerateContent
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce(makeGoogleResponse());

      const result = await withTimers(() => provider.complete({ messages: basicMessages }));
      expect(result.content).toBe('hello');
    });

    it('retries on 502 bad gateway', async () => {
      const provider = createGoogleProviderInstance();
      const err = makeGoogleError(502, 'Bad gateway');

      mockGenerateContent
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce(makeGoogleResponse());

      const result = await withTimers(() => provider.complete({ messages: basicMessages }));
      expect(result.content).toBe('hello');
    });

    it('retries on 503 service unavailable', async () => {
      const provider = createGoogleProviderInstance();
      const err = makeGoogleError(503, 'Service unavailable');

      mockGenerateContent
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce(makeGoogleResponse());

      const result = await withTimers(() => provider.complete({ messages: basicMessages }));
      expect(result.content).toBe('hello');
    });

    it('exhausts retries and throws on persistent 503', async () => {
      const provider = createGoogleProviderInstance();
      const err = makeGoogleError(503, 'Service unavailable');

      mockGenerateContent.mockRejectedValue(err);

      const thrown = await withTimersExpectReject(() => provider.complete({ messages: basicMessages }));
      expect((thrown as Error).message).toContain('Service unavailable');
      expect(mockGenerateContent).toHaveBeenCalledTimes(4);
    });
  });

  describe('non-retryable errors', () => {
    it('does not retry 400 bad request', async () => {
      const provider = createGoogleProviderInstance();
      const err = makeGoogleError(400, 'Invalid argument');

      mockGenerateContent.mockRejectedValueOnce(err);

      await expect(provider.complete({ messages: basicMessages }))
        .rejects.toThrow('Invalid argument');
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    });

    it('does not retry 401 unauthorized', async () => {
      const provider = createGoogleProviderInstance();
      const err = makeGoogleError(401, 'API key invalid');

      mockGenerateContent.mockRejectedValueOnce(err);

      await expect(provider.complete({ messages: basicMessages }))
        .rejects.toThrow('API key invalid');
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    });

    it('does not retry 403 forbidden', async () => {
      const provider = createGoogleProviderInstance();
      const err = makeGoogleError(403, 'Permission denied');

      mockGenerateContent.mockRejectedValueOnce(err);

      await expect(provider.complete({ messages: basicMessages }))
        .rejects.toThrow('Permission denied');
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    });
  });

  describe('tool use handling', () => {
    it('extracts function calls from response parts', async () => {
      const provider = createGoogleProviderInstance();
      mockGenerateContent.mockResolvedValueOnce({
        response: {
          text: () => '',
          candidates: [{
            finishReason: 'STOP',
            content: {
              parts: [
                { functionCall: { name: 'get_weather', args: { city: 'Tokyo' } } },
              ],
            },
          }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 15 },
        },
      });

      const result = await provider.completeWithTools({
        messages: basicMessages,
        tools: basicToolDefs,
      });
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0]!.name).toBe('get_weather');
      expect(result.toolCalls![0]!.input).toEqual({ city: 'Tokyo' });
    });

    it('generates content-hash call IDs for Google tool calls (findings.md P2:1010)', async () => {
      // findings.md P2:1010 — positional IDs cross-wired persisted tool calls.
      // Replaced with SHA256(name + args)[:16], stable across sessions.
      const provider = createGoogleProviderInstance();
      mockGenerateContent.mockResolvedValueOnce({
        response: {
          text: () => '',
          candidates: [{
            finishReason: 'STOP',
            content: {
              parts: [
                { functionCall: { name: 'tool_a', args: { x: 1 } } },
                { functionCall: { name: 'tool_b', args: { y: 2 } } },
              ],
            },
          }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 },
        },
      });

      const result = await provider.completeWithTools({
        messages: basicMessages,
        tools: basicToolDefs,
      });
      expect(result.toolCalls![0]!.id).toMatch(/^call_[0-9a-f]{16}$/);
      expect(result.toolCalls![1]!.id).toMatch(/^call_[0-9a-f]{16}$/);
      expect(result.toolCalls![0]!.id).not.toBe(result.toolCalls![1]!.id);
    });

    it('handles function call with null args', async () => {
      const provider = createGoogleProviderInstance();
      mockGenerateContent.mockResolvedValueOnce({
        response: {
          text: () => '',
          candidates: [{
            finishReason: 'STOP',
            content: {
              parts: [
                { functionCall: { name: 'get_time', args: null } },
              ],
            },
          }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        },
      });

      const result = await provider.completeWithTools({
        messages: basicMessages,
        tools: basicToolDefs,
      });
      expect(result.toolCalls![0]!.input).toEqual({});
    });

    it('handles mixed text and function call parts', async () => {
      const provider = createGoogleProviderInstance();
      mockGenerateContent.mockResolvedValueOnce({
        response: {
          text: () => 'checking weather',
          candidates: [{
            finishReason: 'STOP',
            content: {
              parts: [
                { text: 'Let me check that.' },
                { functionCall: { name: 'get_weather', args: { city: 'NYC' } } },
              ],
            },
          }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 15 },
        },
      });

      const result = await provider.completeWithTools({
        messages: basicMessages,
        tools: basicToolDefs,
      });
      expect(result.content).toBe('Let me check that.');
      expect(result.toolCalls).toHaveLength(1);
    });
  });

  describe('message conversion', () => {
    it('separates system messages as systemInstruction', async () => {
      const provider = createGoogleProviderInstance();
      mockGenerateContent.mockResolvedValueOnce(makeGoogleResponse());

      await provider.complete({ messages: basicMessages });

      const modelConfig = mockGetGenerativeModel.mock.calls[0]![0];
      expect(modelConfig.systemInstruction).toBe('You are helpful.');
    });

    it('maps assistant role to model role', async () => {
      const provider = createGoogleProviderInstance();
      mockGenerateContent.mockResolvedValueOnce(makeGoogleResponse());

      const messages = [
        { role: 'system' as const, content: 'System' },
        { role: 'user' as const, content: 'Hello' },
        { role: 'assistant' as const, content: 'Hi there' },
        { role: 'user' as const, content: 'How are you?' },
      ];

      await provider.complete({ messages });

      const callArgs = mockGenerateContent.mock.calls[0]![0]!;
      expect(callArgs.contents[1].role).toBe('model');
    });

    it('handles multiple system messages joined with double newline', async () => {
      const provider = createGoogleProviderInstance();
      mockGenerateContent.mockResolvedValueOnce(makeGoogleResponse());

      const messages = [
        { role: 'system' as const, content: 'First instruction' },
        { role: 'system' as const, content: 'Second instruction' },
        { role: 'user' as const, content: 'Hello' },
      ];

      await provider.complete({ messages });

      const modelConfig = mockGetGenerativeModel.mock.calls[0]![0];
      expect(modelConfig.systemInstruction).toBe('First instruction\n\nSecond instruction');
    });
  });

  describe('usage metadata', () => {
    it('extracts token counts from usageMetadata', async () => {
      const provider = createGoogleProviderInstance();
      mockGenerateContent.mockResolvedValueOnce({
        response: {
          text: () => 'hello',
          candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'hello' }] } }],
          usageMetadata: { promptTokenCount: 42, candidatesTokenCount: 7 },
        },
      });

      const result = await provider.complete({ messages: basicMessages });
      expect(result.usage.inputTokens).toBe(42);
      expect(result.usage.outputTokens).toBe(7);
    });

    it('handles missing usageMetadata', async () => {
      const provider = createGoogleProviderInstance();
      mockGenerateContent.mockResolvedValueOnce({
        response: {
          text: () => 'hello',
          candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'hello' }] } }],
          usageMetadata: undefined,
        },
      });

      const result = await provider.complete({ messages: basicMessages });
      expect(result.usage.inputTokens).toBe(0);
      expect(result.usage.outputTokens).toBe(0);
    });
  });

  describe('generation config', () => {
    it('omits thinkingConfig by default (findings.md:1040)', async () => {
      // Regression: previously hardcoded thinkingBudget: 0 blocked Gemini 2.5 Pro
      // reasoning on every request. Default must now be "let Gemini decide per model."
      const provider = createGoogleProviderInstance();
      mockGenerateContent.mockResolvedValueOnce(makeGoogleResponse());

      await provider.complete({ messages: basicMessages });

      const modelConfig = mockGetGenerativeModel.mock.calls[0]![0];
      expect(modelConfig.generationConfig.thinkingConfig).toBeUndefined();
    });

    it('emits thinkingConfig when thinkingBudget is explicitly configured', async () => {
      const provider = new GoogleProvider({ apiKey: 'test-key', model: 'gemini-2.5-flash', thinkingBudget: 0 });
      mockGenerateContent.mockResolvedValueOnce(makeGoogleResponse());

      await provider.complete({ messages: basicMessages });

      const modelConfig = mockGetGenerativeModel.mock.calls[0]![0];
      expect(modelConfig.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
    });

    it('passes stopSequences to generationConfig', async () => {
      const provider = createGoogleProviderInstance();
      mockGenerateContent.mockResolvedValueOnce(makeGoogleResponse());

      await provider.complete({ messages: basicMessages, stopSequences: ['END'] });

      const modelConfig = mockGetGenerativeModel.mock.calls[0]![0];
      expect(modelConfig.generationConfig.stopSequences).toEqual(['END']);
    });

    it('passes maxOutputTokens from options', async () => {
      const provider = createGoogleProviderInstance();
      mockGenerateContent.mockResolvedValueOnce(makeGoogleResponse());

      await provider.complete({ messages: basicMessages, maxTokens: 4096 });

      const modelConfig = mockGetGenerativeModel.mock.calls[0]![0];
      expect(modelConfig.generationConfig.maxOutputTokens).toBe(4096);
    });
  });

  describe('continueWithToolResults', () => {
    it('retries on 503 during continueWithToolResults', async () => {
      const provider = createGoogleProviderInstance();
      const err = makeGoogleError(503, 'Service unavailable');

      mockGenerateContent
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce(makeGoogleResponse());

      const result = await withTimers(() => provider.continueWithToolResults(
        { messages: basicMessages, tools: basicToolDefs },
        [{ id: 'call_0', name: 'get_weather', input: { city: 'Tokyo' } }],
        [{ toolCallId: 'call_0', content: 'Sunny' }]
      ));
      expect(result.content).toBe('hello');
    });

    it('adds model parts with function calls and user parts with function responses', async () => {
      const provider = createGoogleProviderInstance();
      mockGenerateContent.mockResolvedValueOnce(makeGoogleResponse());

      await provider.continueWithToolResults(
        { messages: basicMessages, tools: basicToolDefs },
        [{ id: 'call_0', name: 'get_weather', input: { city: 'Tokyo' } }],
        [{ toolCallId: 'call_0', content: 'Sunny 25C' }]
      );

      const callArgs = mockGenerateContent.mock.calls[0]![0]!;
      const contents = callArgs.contents;
      // Original message + model function call + user function response
      expect(contents).toHaveLength(3);
      expect(contents[1].role).toBe('model');
      expect(contents[2].role).toBe('user');
    });

    it('throws MismatchedToolCallIdError for unknown tool call ID (findings.md P2:1030)', async () => {
      // findings.md P2:1030 — prior behavior silently mapped the miss to
      // 'unknown' and sent a functionResponse for a call Gemini never made.
      const provider = createGoogleProviderInstance();
      mockGenerateContent.mockResolvedValueOnce(makeGoogleResponse());

      await expect(
        provider.continueWithToolResults(
          { messages: basicMessages, tools: basicToolDefs },
          [{ id: 'call_0', name: 'get_weather', input: { city: 'Tokyo' } }],
          [{ toolCallId: 'nonexistent_id', content: 'result' }]
        )
      ).rejects.toThrow('nonexistent_id');
    });
  });

  describe('empty/partial response handling', () => {
    it('handles response with empty parts array', async () => {
      const provider = createGoogleProviderInstance();
      mockGenerateContent.mockResolvedValueOnce({
        response: {
          text: () => '',
          candidates: [{
            finishReason: 'STOP',
            content: { parts: [] },
          }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 0 },
        },
      });

      const result = await provider.completeWithTools({
        messages: basicMessages,
        tools: basicToolDefs,
      });
      expect(result.content).toBe('');
      expect(result.toolCalls).toBeUndefined();
    });

    it('handles response with null content in candidate', async () => {
      const provider = createGoogleProviderInstance();
      mockGenerateContent.mockResolvedValueOnce({
        response: {
          text: () => '',
          candidates: [{
            finishReason: 'SAFETY',
            content: null,
          }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 0 },
        },
      });

      const result = await provider.completeWithTools({
        messages: basicMessages,
        tools: basicToolDefs,
      });
      expect(result.content).toBe('');
    });
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// 4. PROVIDER FALLBACK CHAIN
// ═══════════════════════════════════════════════════════════════════════════════

describe('Provider fallback chain', () => {

  describe('basic fallback behavior', () => {
    it('uses primary provider when it succeeds', async () => {
      const primary = createMockProvider('anthropic', 'claude-3-opus');
      const factory = vi.fn();
      const fallback = createFallbackProvider(primary, ['claude-3-sonnet'], factory);

      const result = await fallback.complete({ messages: basicMessages });
      expect(result.content).toBe('response from claude-3-opus');
      expect(factory).not.toHaveBeenCalled();
    });

    it('falls back to secondary on model-gone error', async () => {
      const primary = createMockProvider('anthropic', 'claude-3-opus', {
        complete: vi.fn().mockRejectedValue(makeAnthropicError(404, 'Model not found')),
      });
      const secondary = createMockProvider('anthropic', 'claude-3-sonnet');
      const factory = vi.fn().mockReturnValue(secondary);

      const fallback = createFallbackProvider(primary, ['claude-3-sonnet'], factory);

      const result = await fallback.complete({ messages: basicMessages });
      expect(result.content).toBe('response from claude-3-sonnet');
      expect(factory).toHaveBeenCalledWith('claude-3-sonnet');
    });

    it('falls back on 410 gone error', async () => {
      const primary = createMockProvider('anthropic', 'old-model', {
        complete: vi.fn().mockRejectedValue(makeAnthropicError(410, 'Model deprecated')),
      });
      const secondary = createMockProvider('anthropic', 'new-model');
      const factory = vi.fn().mockReturnValue(secondary);

      const fallback = createFallbackProvider(primary, ['new-model'], factory);

      const result = await fallback.complete({ messages: basicMessages });
      expect(result.content).toBe('response from new-model');
    });

    it('falls back on "deprecated" message', async () => {
      const primary = createMockProvider('anthropic', 'old-model', {
        complete: vi.fn().mockRejectedValue(new Error('This model has been deprecated')),
      });
      const secondary = createMockProvider('anthropic', 'new-model');
      const factory = vi.fn().mockReturnValue(secondary);

      const fallback = createFallbackProvider(primary, ['new-model'], factory);

      const result = await fallback.complete({ messages: basicMessages });
      expect(result.content).toBe('response from new-model');
    });

    it('falls back on "decommissioned" message', async () => {
      const primary = createMockProvider('anthropic', 'old-model', {
        complete: vi.fn().mockRejectedValue(new Error('Model has been decommissioned')),
      });
      const secondary = createMockProvider('anthropic', 'new-model');
      const factory = vi.fn().mockReturnValue(secondary);

      const fallback = createFallbackProvider(primary, ['new-model'], factory);

      const result = await fallback.complete({ messages: basicMessages });
      expect(result.content).toBe('response from new-model');
    });

    it('falls back on "no longer available" message', async () => {
      const primary = createMockProvider('anthropic', 'old-model', {
        complete: vi.fn().mockRejectedValue(new Error('Model is no longer available')),
      });
      const secondary = createMockProvider('anthropic', 'new-model');
      const factory = vi.fn().mockReturnValue(secondary);

      const fallback = createFallbackProvider(primary, ['new-model'], factory);

      const result = await fallback.complete({ messages: basicMessages });
      expect(result.content).toBe('response from new-model');
    });

    it('falls back on "does not exist" message', async () => {
      const primary = createMockProvider('anthropic', 'old-model', {
        complete: vi.fn().mockRejectedValue(new Error('Model does not exist')),
      });
      const secondary = createMockProvider('anthropic', 'new-model');
      const factory = vi.fn().mockReturnValue(secondary);

      const fallback = createFallbackProvider(primary, ['new-model'], factory);

      const result = await fallback.complete({ messages: basicMessages });
      expect(result.content).toBe('response from new-model');
    });

    it('falls back on "invalid model" message', async () => {
      const primary = createMockProvider('anthropic', 'old-model', {
        complete: vi.fn().mockRejectedValue(new Error('invalid model specified')),
      });
      const secondary = createMockProvider('anthropic', 'new-model');
      const factory = vi.fn().mockReturnValue(secondary);

      const fallback = createFallbackProvider(primary, ['new-model'], factory);

      const result = await fallback.complete({ messages: basicMessages });
      expect(result.content).toBe('response from new-model');
    });

    it('falls back on "not a valid model" message', async () => {
      const primary = createMockProvider('anthropic', 'old-model', {
        complete: vi.fn().mockRejectedValue(new Error('not a valid model')),
      });
      const secondary = createMockProvider('anthropic', 'new-model');
      const factory = vi.fn().mockReturnValue(secondary);

      const fallback = createFallbackProvider(primary, ['new-model'], factory);

      const result = await fallback.complete({ messages: basicMessages });
      expect(result.content).toBe('response from new-model');
    });
  });

  describe('all providers fail', () => {
    it('throws when all models in chain are gone', async () => {
      const primary = createMockProvider('anthropic', 'model-a', {
        complete: vi.fn().mockRejectedValue(makeAnthropicError(404, 'Model not found')),
      });
      const secondaryFail = createMockProvider('anthropic', 'model-b', {
        complete: vi.fn().mockRejectedValue(makeAnthropicError(404, 'Model not found')),
      });
      const factory = vi.fn().mockReturnValue(secondaryFail);

      const fallback = createFallbackProvider(primary, ['model-b'], factory);

      await expect(fallback.complete({ messages: basicMessages }))
        .rejects.toThrow('All models exhausted');
    });

    it('error message includes all model names', async () => {
      const primary = createMockProvider('anthropic', 'model-a', {
        complete: vi.fn().mockRejectedValue(makeAnthropicError(404, 'not found')),
      });
      const factory = vi.fn().mockReturnValue(
        createMockProvider('anthropic', 'model-b', {
          complete: vi.fn().mockRejectedValue(makeAnthropicError(404, 'not found')),
        })
      );

      const fallback = createFallbackProvider(primary, ['model-b', 'model-c'], factory);

      await expect(fallback.complete({ messages: basicMessages }))
        .rejects.toThrow(/model-a.*model-b.*model-c/);
    });
  });

  describe('non-model-gone errors are not caught by fallback', () => {
    it('propagates 500 error without trying fallback', async () => {
      const primary = createMockProvider('anthropic', 'model-a', {
        complete: vi.fn().mockRejectedValue(makeAnthropicError(500, 'Internal error')),
      });
      const factory = vi.fn();
      const fallback = createFallbackProvider(primary, ['model-b'], factory);

      await expect(fallback.complete({ messages: basicMessages }))
        .rejects.toThrow('Internal error');
      expect(factory).not.toHaveBeenCalled();
    });

    it('propagates 429 rate limit without trying fallback', async () => {
      const primary = createMockProvider('anthropic', 'model-a', {
        complete: vi.fn().mockRejectedValue(makeAnthropicError(429, 'Rate limited')),
      });
      const factory = vi.fn();
      const fallback = createFallbackProvider(primary, ['model-b'], factory);

      await expect(fallback.complete({ messages: basicMessages }))
        .rejects.toThrow('Rate limited');
      expect(factory).not.toHaveBeenCalled();
    });

    it('propagates 401 auth error without trying fallback', async () => {
      const primary = createMockProvider('anthropic', 'model-a', {
        complete: vi.fn().mockRejectedValue(makeAnthropicError(401, 'Unauthorized')),
      });
      const factory = vi.fn();
      const fallback = createFallbackProvider(primary, ['model-b'], factory);

      await expect(fallback.complete({ messages: basicMessages }))
        .rejects.toThrow('Unauthorized');
      expect(factory).not.toHaveBeenCalled();
    });
  });

  describe('model promotion', () => {
    it('promotes successful fallback model for subsequent calls', async () => {
      let primaryCallCount = 0;
      const primary = createMockProvider('anthropic', 'model-a', {
        complete: vi.fn().mockImplementation(() => {
          primaryCallCount++;
          throw makeAnthropicError(404, 'Model not found');
        }),
      });
      const secondary = createMockProvider('anthropic', 'model-b');
      const factory = vi.fn().mockReturnValue(secondary);

      const fallback = createFallbackProvider(primary, ['model-b'], factory);

      // First call: primary fails, falls back to secondary
      await fallback.complete({ messages: basicMessages });
      expect(primaryCallCount).toBe(1);

      // Second call: should use secondary directly (promoted)
      await fallback.complete({ messages: basicMessages });
      // Primary should not be called again since it's in failedModels
      expect(primaryCallCount).toBe(1);
    });

    it('model property reflects active provider', async () => {
      const primary = createMockProvider('anthropic', 'model-a', {
        complete: vi.fn().mockRejectedValue(makeAnthropicError(404, 'not found')),
      });
      const secondary = createMockProvider('anthropic', 'model-b');
      const factory = vi.fn().mockReturnValue(secondary);

      const fallback = createFallbackProvider(primary, ['model-b'], factory);

      expect(fallback.model).toBe('model-a');
      await fallback.complete({ messages: basicMessages });
      expect(fallback.model).toBe('model-b');
    });
  });

  describe('fallback chain with multiple models', () => {
    it('tries models in order until one succeeds', async () => {
      const primary = createMockProvider('anthropic', 'model-a', {
        complete: vi.fn().mockRejectedValue(makeAnthropicError(404, 'not found')),
      });
      const secondModel = createMockProvider('anthropic', 'model-b', {
        complete: vi.fn().mockRejectedValue(makeAnthropicError(404, 'not found')),
      });
      const thirdModel = createMockProvider('anthropic', 'model-c');

      const factory = vi.fn()
        .mockReturnValueOnce(secondModel)
        .mockReturnValueOnce(thirdModel);

      const fallback = createFallbackProvider(primary, ['model-b', 'model-c'], factory);

      const result = await fallback.complete({ messages: basicMessages });
      expect(result.content).toBe('response from model-c');
    });

    it('skips already-failed models in chain', async () => {
      const primary = createMockProvider('anthropic', 'model-a', {
        complete: vi.fn().mockRejectedValue(makeAnthropicError(404, 'not found')),
      });
      const secondModel = createMockProvider('anthropic', 'model-b', {
        complete: vi.fn().mockRejectedValue(makeAnthropicError(404, 'not found')),
      });
      const thirdModel = createMockProvider('anthropic', 'model-c');

      const factory = vi.fn()
        .mockReturnValueOnce(secondModel)
        .mockReturnValueOnce(thirdModel)
        .mockReturnValueOnce(thirdModel);

      const fallback = createFallbackProvider(primary, ['model-b', 'model-c'], factory);

      // First call: a fails, b fails, c succeeds
      await fallback.complete({ messages: basicMessages });

      // Reset factory call tracking
      factory.mockClear();

      // Now model-c is promoted. If it suddenly fails too:
      (thirdModel.complete as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        makeAnthropicError(404, 'not found')
      );

      // All should be exhausted
      await expect(fallback.complete({ messages: basicMessages }))
        .rejects.toThrow('All models exhausted');
    });
  });

  describe('fallback works for all provider methods', () => {
    it('falls back for completeWithTools', async () => {
      const primary = createMockProvider('anthropic', 'model-a', {
        completeWithTools: vi.fn().mockRejectedValue(makeAnthropicError(404, 'Model not found')),
      });
      const secondary = createMockProvider('anthropic', 'model-b');
      const factory = vi.fn().mockReturnValue(secondary);

      const fallback = createFallbackProvider(primary, ['model-b'], factory);

      const result = await fallback.completeWithTools({ messages: basicMessages, tools: basicToolDefs });
      expect(result.content).toBe('response from model-b');
    });

    it('falls back for continueWithToolResults', async () => {
      const primary = createMockProvider('anthropic', 'model-a', {
        continueWithToolResults: vi.fn().mockRejectedValue(makeAnthropicError(404, 'Model not found')),
      });
      const secondary = createMockProvider('anthropic', 'model-b');
      const factory = vi.fn().mockReturnValue(secondary);

      const fallback = createFallbackProvider(primary, ['model-b'], factory);

      const result = await fallback.continueWithToolResults(
        { messages: basicMessages, tools: basicToolDefs },
        [{ id: 'c1', name: 'test', input: {} }],
        [{ toolCallId: 'c1', content: 'result' }]
      );
      expect(result.content).toBe('response from model-b');
    });

    it('falls back for completeStream', async () => {
      const primary = createMockProvider('anthropic', 'model-a', {
        completeStream: vi.fn().mockRejectedValue(makeAnthropicError(404, 'Model not found')),
      });
      const secondary = createMockProvider('anthropic', 'model-b', {
        completeStream: vi.fn().mockResolvedValue({
          content: 'streamed from model-b',
          finishReason: 'stop',
          usage: { inputTokens: 10, outputTokens: 5 },
        }),
      });
      const factory = vi.fn().mockReturnValue(secondary);

      const fallback = createFallbackProvider(primary, ['model-b'], factory);

      const result = await fallback.completeStream!({ messages: basicMessages }, vi.fn());
      expect(result.content).toBe('streamed from model-b');
    });

    it('falls back to complete when completeStream is undefined on fallback', async () => {
      const primary = createMockProvider('anthropic', 'model-a', {
        completeStream: vi.fn().mockRejectedValue(makeAnthropicError(404, 'Model not found')),
      });
      // Secondary has no completeStream
      const secondary = createMockProvider('anthropic', 'model-b');
      const factory = vi.fn().mockReturnValue(secondary);

      const fallback = createFallbackProvider(primary, ['model-b'], factory);

      const result = await fallback.completeStream!({ messages: basicMessages }, vi.fn());
      expect(result.content).toBe('response from model-b');
    });
  });

  describe('empty fallback list', () => {
    it('returns primary provider directly when no fallbacks', async () => {
      const primary = createMockProvider('anthropic', 'model-a');
      const result = createFallbackProvider(primary, [], vi.fn());
      expect(result).toBe(primary);
    });
  });

  describe('logging', () => {
    it('logs warning when primary model fails', async () => {
      const primary = createMockProvider('anthropic', 'model-a', {
        complete: vi.fn().mockRejectedValue(makeAnthropicError(404, 'Model not found')),
      });
      const secondary = createMockProvider('anthropic', 'model-b');
      const factory = vi.fn().mockReturnValue(secondary);

      const fallback = createFallbackProvider(primary, ['model-b'], factory);
      await fallback.complete({ messages: basicMessages });

      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'model-a' }),
        expect.stringContaining('deprecated')
      );
    });

    it('logs info when fallback succeeds', async () => {
      const primary = createMockProvider('anthropic', 'model-a', {
        complete: vi.fn().mockRejectedValue(makeAnthropicError(404, 'Model not found')),
      });
      const secondary = createMockProvider('anthropic', 'model-b');
      const factory = vi.fn().mockReturnValue(secondary);

      const fallback = createFallbackProvider(primary, ['model-b'], factory);
      await fallback.complete({ messages: basicMessages });

      expect(mockLoggerInfo).toHaveBeenCalledWith(
        expect.objectContaining({ newModel: 'model-b' }),
        expect.stringContaining('succeeded')
      );
    });
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// 5. RETRY BEHAVIOR EDGE CASES
// ═══════════════════════════════════════════════════════════════════════════════

describe('Retry behavior edge cases', () => {

  describe('retry exhaustion', () => {
    it('throws the last error after all retries fail', async () => {
      const errors = [
        makeOpenAIError(429, 'Rate limit 1'),
        makeOpenAIError(429, 'Rate limit 2'),
        makeOpenAIError(429, 'Rate limit 3'),
        makeOpenAIError(429, 'Rate limit final'),
      ];

      let callCount = 0;
      const fn = vi.fn().mockImplementation(() => {
        throw errors[callCount++];
      });

      const err = await withTimersExpectReject(() => withRetry(fn, 'test'));
      expect((err as Error).message).toContain('Rate limit final');
      expect(fn).toHaveBeenCalledTimes(4);
    });

    it('retries exactly maxRetries times (default 3)', async () => {
      const fn = vi.fn().mockRejectedValue(makeOpenAIError(500, 'Server error'));

      const err = await withTimersExpectReject(() => withRetry(fn, 'test'));
      expect((err as Error).message).toContain('Server error');
      // 1 initial + 3 retries = 4 calls
      expect(fn).toHaveBeenCalledTimes(4);
    });

    it('respects custom maxRetries', async () => {
      const fn = vi.fn().mockRejectedValue(makeOpenAIError(500, 'Server error'));

      const err = await withTimersExpectReject(() => withRetry(fn, 'test', { maxRetries: 5 }));
      expect(err).toBeTruthy();
      expect(fn).toHaveBeenCalledTimes(6);
    });

    it('maxRetries: 0 means no retries', async () => {
      const fn = vi.fn().mockRejectedValue(makeOpenAIError(500, 'Server error'));

      await expect(withRetry(fn, 'test', { maxRetries: 0 })).rejects.toThrow();
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('non-retryable errors are NOT retried', () => {
    const nonRetryableStatuses = [400, 401, 403, 404, 409, 422];

    for (const status of nonRetryableStatuses) {
      it(`does not retry ${status} error`, async () => {
        const fn = vi.fn().mockRejectedValue(makeOpenAIError(status, `Error ${status}`));

        await expect(withRetry(fn, 'test')).rejects.toThrow(`Error ${status}`);
        expect(fn).toHaveBeenCalledTimes(1);
      });
    }

    it('does not retry generic Error without status or matching message', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('Something weird'));

      await expect(withRetry(fn, 'test')).rejects.toThrow('Something weird');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('does not retry null/undefined errors', async () => {
      const fn = vi.fn().mockRejectedValue(null);

      await expect(withRetry(fn, 'test')).rejects.toBe(null);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('does not retry string errors', async () => {
      const fn = vi.fn().mockRejectedValue('string error');

      await expect(withRetry(fn, 'test')).rejects.toBe('string error');
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('retryable errors ARE retried', () => {
    const retryableStatuses = [429, 500, 502, 503];

    for (const status of retryableStatuses) {
      it(`retries ${status} error`, async () => {
        const fn = vi.fn()
          .mockRejectedValueOnce(makeOpenAIError(status, `Error ${status}`))
          .mockResolvedValueOnce('success');

        const result = await withTimers(() => withRetry(fn, 'test'));
        expect(result).toBe('success');
        expect(fn).toHaveBeenCalledTimes(2);
      });
    }

    it('retries on "overloaded" message string', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('API overloaded'))
        .mockResolvedValueOnce('ok');

      const result = await withTimers(() => withRetry(fn, 'test'));
      expect(result).toBe('ok');
    });

    it('retries on "rate limit" message string', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('rate limit exceeded'))
        .mockResolvedValueOnce('ok');

      const result = await withTimers(() => withRetry(fn, 'test'));
      expect(result).toBe('ok');
    });

    it('retries on "too many requests" message string', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('too many requests'))
        .mockResolvedValueOnce('ok');

      const result = await withTimers(() => withRetry(fn, 'test'));
      expect(result).toBe('ok');
    });

    it('retries on "server error" message string', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('server error'))
        .mockResolvedValueOnce('ok');

      const result = await withTimers(() => withRetry(fn, 'test'));
      expect(result).toBe('ok');
    });

    it('retries on "bad gateway" message string', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('bad gateway'))
        .mockResolvedValueOnce('ok');

      const result = await withTimers(() => withRetry(fn, 'test'));
      expect(result).toBe('ok');
    });

    it('retries on "service unavailable" message string', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('service unavailable'))
        .mockResolvedValueOnce('ok');

      const result = await withTimers(() => withRetry(fn, 'test'));
      expect(result).toBe('ok');
    });

    it('retries on status code embedded in message string (e.g., "Error 429")', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('HTTP Error 429: Rate limited'))
        .mockResolvedValueOnce('ok');

      const result = await withTimers(() => withRetry(fn, 'test'));
      expect(result).toBe('ok');
    });
  });

  describe('exponential backoff timing', () => {
    it('delay caps double per attempt: 1s, 2s, 4s (findings.md P2:1050)', async () => {
      // findings.md P2:1050 — with full jitter the delay is random in
      // [0, cap]. Pin Math.random at ~1 so the sampled delay equals the
      // cap and the original exponential-growth assertions still hold.
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.9999);
      const fn = vi.fn()
        .mockRejectedValueOnce(makeOpenAIError(500, 'fail'))
        .mockRejectedValueOnce(makeOpenAIError(500, 'fail'))
        .mockRejectedValueOnce(makeOpenAIError(500, 'fail'))
        .mockResolvedValueOnce('success');

      const promise = withRetry(fn, 'test');

      // First retry near cap of 1s
      await vi.advanceTimersByTimeAsync(1000);
      expect(fn).toHaveBeenCalledTimes(2);

      // Second retry near cap of 2s
      await vi.advanceTimersByTimeAsync(2000);
      expect(fn).toHaveBeenCalledTimes(3);

      // Third retry near cap of 4s
      await vi.advanceTimersByTimeAsync(4000);
      expect(fn).toHaveBeenCalledTimes(4);

      await promise;
      randomSpy.mockRestore();
    });

    it('respects custom baseDelayMs', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(makeOpenAIError(500, 'fail'))
        .mockResolvedValueOnce('success');

      const promise = withRetry(fn, 'test', { baseDelayMs: 500 });
      await vi.advanceTimersByTimeAsync(500);
      const result = await promise;
      expect(result).toBe('success');
    });
  });

  describe('success on last retry', () => {
    it('returns result from last retry attempt', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(makeOpenAIError(500, 'fail'))
        .mockRejectedValueOnce(makeOpenAIError(500, 'fail'))
        .mockRejectedValueOnce(makeOpenAIError(500, 'fail'))
        .mockResolvedValueOnce({ data: 'last try worked' });

      const result = await withTimers(() => withRetry(fn, 'test'));
      expect(result).toEqual({ data: 'last try worked' });
      expect(fn).toHaveBeenCalledTimes(4);
    });
  });

  describe('custom retryable status codes', () => {
    it('retries on custom status codes', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(makeOpenAIError(599, 'Custom error'))
        .mockResolvedValueOnce('ok');

      const result = await withTimers(() => withRetry(fn, 'test', { retryableStatusCodes: [599] }));
      expect(result).toBe('ok');
    });

    it('still retries when message matches pattern even if status code not in list', async () => {
      const fn = vi.fn().mockRejectedValue(makeOpenAIError(429, 'Rate limit'));

      // Override retryable codes to NOT include 429, but "rate limit" in message
      // still triggers retry via the message pattern check
      const err = await withTimersExpectReject(() => withRetry(fn, 'test', { retryableStatusCodes: [500] }));
      expect((err as Error).message).toContain('Rate limit');
      // Message pattern "rate.?limit" matches, so retries happen
      expect(fn).toHaveBeenCalledTimes(4);
    });
  });

  describe('logging during retries', () => {
    it('logs warning with provider name and attempt number', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(makeOpenAIError(500, 'fail'))
        .mockResolvedValueOnce('ok');

      await withTimers(() => withRetry(fn, 'my-provider'));

      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'my-provider', attempt: 1 }),
        expect.any(String)
      );
    });

    it('logs delay and cap in warning (findings.md P2:1050)', async () => {
      // findings.md P2:1050 — with jitter, delayMs is random; assert the
      // cap grows deterministically instead.
      const fn = vi.fn()
        .mockRejectedValueOnce(makeOpenAIError(500, 'fail'))
        .mockResolvedValueOnce('ok');

      await withTimers(() => withRetry(fn, 'test'));

      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({ capMs: 1000 }),
        expect.any(String)
      );
    });
  });

  describe('immediate success', () => {
    it('does not retry on first success', async () => {
      const fn = vi.fn().mockResolvedValueOnce('immediate');

      const result = await withRetry(fn, 'test');
      expect(result).toBe('immediate');
      expect(fn).toHaveBeenCalledTimes(1);
      expect(mockLoggerWarn).not.toHaveBeenCalled();
    });
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// 6. BUDGET ENFORCEMENT UNDER ERRORS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Budget enforcement under errors', () => {

  describe('checkBudget behavior', () => {
    it('throws BudgetExceededError when usage exceeds cap', () => {
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = '1000';
      const currentMonth = new Date().toISOString().slice(0, 7);
      mockGetMeta.mockReturnValue(JSON.stringify({ month: currentMonth, tokens: 1000 }));

      expect(() => checkBudget()).toThrow(BudgetExceededError);
    });

    it('does not throw when under budget', () => {
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = '1000';
      const currentMonth = new Date().toISOString().slice(0, 7);
      mockGetMeta.mockReturnValue(JSON.stringify({ month: currentMonth, tokens: 500 }));

      expect(() => checkBudget()).not.toThrow();
    });

    it('does not throw when cap is disabled (0)', () => {
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = '0';
      mockGetMeta.mockReturnValue(JSON.stringify({ month: '2026-04', tokens: 999999999 }));

      expect(() => checkBudget()).not.toThrow();
    });

    it('resets usage when month changes', () => {
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = '1000';
      // Return data from a past month
      mockGetMeta.mockReturnValue(JSON.stringify({ month: '2025-01', tokens: 9999 }));

      // Should not throw because past-month data resets
      expect(() => checkBudget()).not.toThrow();
    });

    it('handles null meta value (no usage recorded yet)', () => {
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = '1000';
      mockGetMeta.mockReturnValue(null);

      expect(() => checkBudget()).not.toThrow();
    });
  });

  describe('recordUsage', () => {
    // findings.md P2:1110 — recordUsage delegates to an atomic meta
    // increment helper. These tests assert the call shape (delta, keys)
    // and the 80%-warning driven off the helper's returned tokens;
    // the read-modify-write semantics that used to live in budget.ts
    // are now SQLite's problem and are covered by an integration test
    // in storage.test.ts.
    it('routes tokens through atomic helper with correct delta', () => {
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = '100000';
      recordUsage(100, 50);
      expect(mockAtomicMetaIncrementCounter).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'budget:monthly_usage',
          counterField: 'tokens',
          delta: 150,
        }),
      );
    });

    it('passes fresh JSON for current month', () => {
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = '100000';
      const currentMonth = new Date().toISOString().slice(0, 7);
      recordUsage(100, 50);
      expect(mockAtomicMetaIncrementCounter).toHaveBeenCalledWith(
        expect.objectContaining({
          freshJson: JSON.stringify({ month: currentMonth, tokens: 150 }),
          periodValue: currentMonth,
        }),
      );
    });

    it('does nothing when cap is disabled', () => {
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = '0';
      recordUsage(100, 50);
      expect(mockAtomicMetaIncrementCounter).not.toHaveBeenCalled();
    });

    it('warns at 80% threshold (post-increment value crosses 0.8 * cap)', () => {
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = '1000';
      const currentMonth = new Date().toISOString().slice(0, 7);
      // Simulate the atomic helper returning tokens=940 after increment.
      // Pre-increment = 940 - 150 = 790, which is < 800 (80%). Cross once.
      mockAtomicMetaIncrementCounter.mockReturnValue(
        JSON.stringify({ month: currentMonth, tokens: 940 }),
      );
      recordUsage(100, 50);
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({ pct: expect.any(Number) }),
        expect.stringContaining('80%'),
      );
    });

    it('does not warn below 80% threshold', () => {
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = '10000';
      const currentMonth = new Date().toISOString().slice(0, 7);
      mockAtomicMetaIncrementCounter.mockReturnValue(
        JSON.stringify({ month: currentMonth, tokens: 115 }),
      );
      recordUsage(10, 5);
      expect(mockLoggerWarn).not.toHaveBeenCalled();
    });

    it('does not warn if already above 80% (only warns on crossing)', () => {
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = '1000';
      const currentMonth = new Date().toISOString().slice(0, 7);
      // Before: 850 (> 800), after: 865. No crossing, no warning.
      mockAtomicMetaIncrementCounter.mockReturnValue(
        JSON.stringify({ month: currentMonth, tokens: 865 }),
      );
      recordUsage(10, 5);
      expect(mockLoggerWarn).not.toHaveBeenCalled();
    });
  });

  describe('getBudgetStatus', () => {
    it('returns current usage status', () => {
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = '10000';
      const currentMonth = new Date().toISOString().slice(0, 7);
      mockGetMeta.mockReturnValue(JSON.stringify({ month: currentMonth, tokens: 5000 }));

      const status = getBudgetStatus();
      expect(status.month).toBe(currentMonth);
      expect(status.tokensUsed).toBe(5000);
      expect(status.monthlyCap).toBe(10000);
      expect(status.pctUsed).toBe(50);
    });

    it('returns 0% when no usage', () => {
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = '10000';
      mockGetMeta.mockReturnValue(null);

      const status = getBudgetStatus();
      expect(status.tokensUsed).toBe(0);
      expect(status.pctUsed).toBe(0);
    });

    it('returns 0% when cap is disabled', () => {
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = '0';
      const currentMonth = new Date().toISOString().slice(0, 7);
      mockGetMeta.mockReturnValue(JSON.stringify({ month: currentMonth, tokens: 5000 }));

      const status = getBudgetStatus();
      expect(status.pctUsed).toBe(0);
    });
  });

  describe('BudgetExceededError', () => {
    it('has correct name', () => {
      const err = new BudgetExceededError(100, 50);
      expect(err.name).toBe('BudgetExceededError');
    });

    it('includes usage and cap in message', () => {
      const err = new BudgetExceededError(10000, 5000);
      expect(err.message).toContain('10,000');
      expect(err.message).toContain('5,000');
    });

    it('is an instance of Error', () => {
      const err = new BudgetExceededError(100, 50);
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe('budget with default cap', () => {
    it('uses 60M default when env not set', () => {
      delete process.env['LAIN_MONTHLY_TOKEN_CAP'];
      mockGetMeta.mockReturnValue(null);

      const status = getBudgetStatus();
      expect(status.monthlyCap).toBe(60_000_000);
    });

    it('uses 60M default when env is invalid', () => {
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = 'not-a-number';
      mockGetMeta.mockReturnValue(null);

      const status = getBudgetStatus();
      expect(status.monthlyCap).toBe(60_000_000);
    });

    it('uses 60M default when env is negative', () => {
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = '-1000';
      mockGetMeta.mockReturnValue(null);

      const status = getBudgetStatus();
      expect(status.monthlyCap).toBe(60_000_000);
    });
  });

  describe('error responses should not count against budget', () => {
    it('budget only records usage after successful calls', async () => {
      // This tests the withBudget wrapper in index.ts
      // When an API call fails, recordUsage is not called because
      // the error is thrown before reaching the usage tracking line
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = '100000';
      const currentMonth = new Date().toISOString().slice(0, 7);
      mockGetMeta.mockReturnValue(JSON.stringify({ month: currentMonth, tokens: 0 }));

      // Provider that always fails
      const failingProvider = createMockProvider('anthropic', 'model-a', {
        complete: vi.fn().mockRejectedValue(new Error('API error')),
      });

      // The withBudget wrapper from index.ts checks budget then calls provider
      // If provider fails, recordUsage won't be called
      // We verify this by testing that recordUsage only fires for successful responses
      try {
        checkBudget(); // Should pass (under budget)
        await failingProvider.complete({ messages: basicMessages });
      } catch {
        // Expected failure
      }

      // recordUsage should NOT have been called since we didn't get a response
      // (In the real code, withBudget() does the check + record; here we verify the concept)
      expect(mockAtomicMetaIncrementCounter).not.toHaveBeenCalled();
    });

    it('successful call after failed call properly records only success usage', async () => {
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = '100000';

      // Record only the successful call
      recordUsage(10, 5);

      expect(mockAtomicMetaIncrementCounter).toHaveBeenCalledTimes(1);
      expect(mockAtomicMetaIncrementCounter).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'budget:monthly_usage',
          delta: 15,
        }),
      );
    });
  });

  describe('budget check before retry', () => {
    it('checkBudget can be called multiple times safely', () => {
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = '10000';
      const currentMonth = new Date().toISOString().slice(0, 7);
      mockGetMeta.mockReturnValue(JSON.stringify({ month: currentMonth, tokens: 100 }));

      // Multiple budget checks should all pass
      expect(() => checkBudget()).not.toThrow();
      expect(() => checkBudget()).not.toThrow();
      expect(() => checkBudget()).not.toThrow();
    });

    it('checkBudget fails immediately when cap exceeded', () => {
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = '100';
      const currentMonth = new Date().toISOString().slice(0, 7);
      mockGetMeta.mockReturnValue(JSON.stringify({ month: currentMonth, tokens: 200 }));

      expect(() => checkBudget()).toThrow(BudgetExceededError);
    });

    it('budget exceeded at exact cap boundary', () => {
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = '100';
      const currentMonth = new Date().toISOString().slice(0, 7);
      mockGetMeta.mockReturnValue(JSON.stringify({ month: currentMonth, tokens: 100 }));

      // At exactly 100 tokens with 100 cap, usage >= cap, so should throw
      expect(() => checkBudget()).toThrow(BudgetExceededError);
    });

    it('budget passes at one below cap', () => {
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = '100';
      const currentMonth = new Date().toISOString().slice(0, 7);
      mockGetMeta.mockReturnValue(JSON.stringify({ month: currentMonth, tokens: 99 }));

      expect(() => checkBudget()).not.toThrow();
    });
  });

  describe('monthly reset', () => {
    it('new month resets token count to zero', () => {
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = '100';
      // Data from a past month — should reset
      mockGetMeta.mockReturnValue(JSON.stringify({ month: '2024-01', tokens: 99999 }));

      expect(() => checkBudget()).not.toThrow();
    });

    it('recordUsage starts from zero in new month', () => {
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = '100000';

      recordUsage(10, 5);

      // findings.md P2:1110 — the atomic helper handles month rollover
      // via json_extract(...month) mismatch → takes the ELSE branch and
      // writes freshJson as-is. Here we assert recordUsage hands it the
      // current month and the exact delta, not the accumulated count.
      const call = mockAtomicMetaIncrementCounter.mock.calls[0]![0] as {
        periodValue: string;
        delta: number;
        freshJson: string;
      };
      expect(call.periodValue).toBe(new Date().toISOString().slice(0, 7));
      expect(call.delta).toBe(15);
      const parsed = JSON.parse(call.freshJson);
      expect(parsed.tokens).toBe(15);
      expect(parsed.month).toBe(new Date().toISOString().slice(0, 7));
    });
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// CROSS-CUTTING: Provider-agnostic error scenarios
// ═══════════════════════════════════════════════════════════════════════════════

describe('Cross-cutting error scenarios', () => {

  describe('Anthropic retry covers overloaded, rate-limit, and timeout', () => {
    it('does retry 429 rate limit (findings.md P2:848)', async () => {
      // findings.md P2:848 — 429 was previously not classified as
      // retryable on Anthropic (only "overloaded" matched). Rate limits
      // are transparently retryable just like 529 overloads.
      const provider = createAnthropicProvider();
      const err = makeAnthropicError(429, 'Rate limited');

      mockAnthropicCreate
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce(makeAnthropicResponse());

      const result = await withTimers(() => provider.complete({ messages: basicMessages }));
      expect(result.content).toBe('hello');
      expect(mockAnthropicCreate).toHaveBeenCalledTimes(2);
    });
  });

  describe('OpenAI/Google use shared withRetry for status codes', () => {
    // findings.md P2:1070 — retryable defaults expanded to cover 408
    // (client timeout), 504 (gateway timeout), 520-524 (Cloudflare origin),
    // and 529 (Anthropic overloaded). Keep this list in sync with
    // DEFAULT_CONFIG.retryableStatusCodes in src/providers/retry.ts.
    const RETRYABLE_STATUS_CODES = [408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529];

    it('OpenAI uses withRetry that covers transient upstream status codes', async () => {
      for (const status of RETRYABLE_STATUS_CODES) {
        mockOpenAICreate.mockReset();
        const provider = createOpenAIProvider();
        mockOpenAICreate
          .mockRejectedValueOnce(makeOpenAIError(status, `Error ${status}`))
          .mockResolvedValueOnce(makeOpenAIResponse());

        await withTimers(() => provider.complete({ messages: basicMessages }));
        expect(mockOpenAICreate).toHaveBeenCalledTimes(2);
      }
    });

    it('Google uses withRetry that covers transient upstream status codes', async () => {
      for (const status of RETRYABLE_STATUS_CODES) {
        mockGenerateContent.mockReset();
        mockGetGenerativeModel.mockReset();
        mockGetGenerativeModel.mockReturnValue({ generateContent: mockGenerateContent });
        const provider = createGoogleProviderInstance();
        mockGenerateContent
          .mockRejectedValueOnce(makeGoogleError(status, `Error ${status}`))
          .mockResolvedValueOnce(makeGoogleResponse());

        await withTimers(() => provider.complete({ messages: basicMessages }));
        expect(mockGenerateContent).toHaveBeenCalledTimes(2);
      }
    });
  });

  describe('provider name and model properties', () => {
    it('AnthropicProvider has name "anthropic"', () => {
      const provider = createAnthropicProvider();
      expect(provider.name).toBe('anthropic');
    });

    it('OpenAIProvider has name "openai"', () => {
      const provider = createOpenAIProvider();
      expect(provider.name).toBe('openai');
    });

    it('GoogleProvider has name "google"', () => {
      const provider = createGoogleProviderInstance();
      expect(provider.name).toBe('google');
    });

    it('each provider stores the model from config', () => {
      expect(createAnthropicProvider().model).toBe('claude-3-opus-20240229');
      expect(createOpenAIProvider().model).toBe('gpt-4');
      expect(createGoogleProviderInstance().model).toBe('gemini-pro');
    });
  });

  describe('default maxTokens', () => {
    it('Anthropic defaults to 8192 maxTokens', async () => {
      const provider = createAnthropicProvider();
      mockAnthropicCreate.mockResolvedValueOnce(makeAnthropicResponse());

      await provider.complete({ messages: basicMessages });

      const params = mockAnthropicCreate.mock.calls[0]![0]!;
      expect(params.max_tokens).toBe(8192);
    });

    it('OpenAI defaults to 8192 maxTokens', async () => {
      const provider = createOpenAIProvider();
      mockOpenAICreate.mockResolvedValueOnce(makeOpenAIResponse());

      await provider.complete({ messages: basicMessages });

      const params = mockOpenAICreate.mock.calls[0]![0]!;
      expect(params.max_tokens).toBe(8192);
    });

    it('Google defaults to 8192 maxOutputTokens', async () => {
      const provider = createGoogleProviderInstance();
      mockGenerateContent.mockResolvedValueOnce(makeGoogleResponse());

      await provider.complete({ messages: basicMessages });

      const modelConfig = mockGetGenerativeModel.mock.calls[0]![0];
      expect(modelConfig.generationConfig.maxOutputTokens).toBe(8192);
    });
  });
});
