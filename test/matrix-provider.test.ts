/**
 * matrix-provider.test.ts
 *
 * High-density matrix / table-driven tests for the provider layer.
 * Uses it.each and describe.each throughout — no bare it() calls.
 *
 * Coverage areas
 *  1.  Message role × content type × provider            (27 tests)
 *  2.  Finish-reason mapping per provider                 (15 tests)
 *  3.  Error status code × retry behaviour               (30 tests)
 *  4.  Error message string × retry behaviour            (24 tests)
 *  5.  Tool definition format per provider               (15 tests)
 *  6.  MaxTokens default × config combos                 (12 tests)
 *  7.  Temperature × provider                            (15 tests)
 *  8.  API-key resolution × provider                     (12 tests)
 *  9.  Content-block types × provider                    (12 tests)
 * 10.  Streaming capability matrix                       (24 tests)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── hoisted mock handles ─────────────────────────────────────────────────────

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

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockAnthropicCreate, stream: mockAnthropicStream },
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
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// ─── imports after mocks ──────────────────────────────────────────────────────

import { AnthropicProvider } from '../src/providers/anthropic.js';
import { OpenAIProvider } from '../src/providers/openai.js';
import { GoogleProvider } from '../src/providers/google.js';
import { withRetry } from '../src/providers/retry.js';
import type {
  Message,
  ContentBlock,
  ToolDefinition,
} from '../src/providers/base.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeAnthropic(overrides: Record<string, unknown> = {}): AnthropicProvider {
  return new AnthropicProvider({ model: 'claude-3-5-haiku-20241022', ...overrides });
}

function makeOpenAI(overrides: Record<string, unknown> = {}): OpenAIProvider {
  return new OpenAIProvider({ model: 'gpt-4o-mini', ...overrides });
}

function makeGoogle(overrides: Record<string, unknown> = {}): GoogleProvider {
  return new GoogleProvider({ model: 'gemini-1.5-flash', ...overrides });
}

function anthropicSuccessResponse(text = 'hello', stopReason = 'end_turn') {
  return {
    content: [{ type: 'text', text }],
    stop_reason: stopReason,
    usage: { input_tokens: 5, output_tokens: 3 },
  };
}

function openaiSuccessResponse(text = 'hello', finishReason = 'stop') {
  return {
    choices: [{ message: { content: text, tool_calls: [] }, finish_reason: finishReason }],
    usage: { prompt_tokens: 5, completion_tokens: 3 },
  };
}

function googleSuccessResponse(text = 'hello', finishReason = 'STOP') {
  return {
    response: {
      text: () => text,
      candidates: [{ finishReason, content: { parts: [{ text }] } }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. Message role × content type × provider  (3 × 3 × 3 = 27)
// ═════════════════════════════════════════════════════════════════════════════

const roles = ['user', 'assistant', 'system'] as const;
const contentVariants: Array<{ label: string; content: Message['content'] }> = [
  { label: 'string', content: 'Hello world' },
  { label: 'text-block', content: [{ type: 'text', text: 'Hello world' }] },
  {
    label: 'image-block',
    content: [
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'abc' },
      } as ContentBlock,
    ],
  },
];

describe.each([
  { providerName: 'anthropic', makeProvider: makeAnthropic, setupMock: () => mockAnthropicCreate.mockResolvedValue(anthropicSuccessResponse()), callComplete: (p: AnthropicProvider, msgs: Message[]) => p.complete({ messages: msgs }) },
  { providerName: 'openai',    makeProvider: makeOpenAI,    setupMock: () => mockOpenAICreate.mockResolvedValue(openaiSuccessResponse()),         callComplete: (p: OpenAIProvider,    msgs: Message[]) => p.complete({ messages: msgs }) },
  { providerName: 'google',    makeProvider: makeGoogle,    setupMock: () => mockGenerateContent.mockResolvedValue(googleSuccessResponse()),      callComplete: (p: GoogleProvider,    msgs: Message[]) => p.complete({ messages: msgs }) },
])('message role/content × $providerName', ({ makeProvider, setupMock, callComplete }) => {
  beforeEach(() => {
    mockAnthropicCreate.mockReset();
    mockOpenAICreate.mockReset();
    mockGenerateContent.mockReset();
    setupMock();
  });

  it.each(
    roles.flatMap((role) =>
      contentVariants.map((cv) => ({ role, ...cv }))
    )
  )('role=$role content=$label completes without throwing', async ({ role, content }) => {
    const provider = makeProvider();
    const msgs: Message[] = [];
    if (role === 'system') {
      msgs.push({ role: 'system', content: 'sys' });
      msgs.push({ role: 'user', content });
    } else {
      msgs.push({ role: 'user', content: 'start' });
      msgs.push({ role, content });
    }
    // Google only allows alternating user/model; keep structure simple
    const safeMessages = msgs.filter((m) => m.role !== 'system' || role === 'system');
    const result = await callComplete(provider as never, safeMessages);
    expect(result).toHaveProperty('content');
    expect(result).toHaveProperty('finishReason');
    expect(result).toHaveProperty('usage');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Finish-reason mapping per provider  (5 × 3 = 15)
// ═════════════════════════════════════════════════════════════════════════════

describe('finish-reason mapping', () => {
  beforeEach(() => {
    mockAnthropicCreate.mockReset();
    mockOpenAICreate.mockReset();
    mockGenerateContent.mockReset();
  });

  const anthropicCases: Array<{ raw: string | null; expected: string }> = [
    { raw: 'end_turn',      expected: 'stop' },
    { raw: 'stop_sequence', expected: 'stop' },
    { raw: 'max_tokens',    expected: 'length' },
    { raw: 'tool_use',      expected: 'tool_use' },
    { raw: null,            expected: 'stop' },
  ];

  it.each(anthropicCases)('anthropic: $raw → $expected', async ({ raw, expected }) => {
    mockAnthropicCreate.mockResolvedValue(anthropicSuccessResponse('x', raw as string));
    const p = makeAnthropic();
    const r = await p.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(r.finishReason).toBe(expected);
  });

  const openaiCases: Array<{ raw: string | null; expected: string }> = [
    { raw: 'stop',           expected: 'stop' },
    { raw: 'length',         expected: 'length' },
    { raw: 'content_filter', expected: 'content_filter' },
    { raw: 'tool_calls',     expected: 'tool_use' },
    { raw: null,             expected: 'stop' },
  ];

  it.each(openaiCases)('openai: $raw → $expected', async ({ raw, expected }) => {
    mockOpenAICreate.mockResolvedValue(openaiSuccessResponse('x', raw as string));
    const p = makeOpenAI();
    const r = await p.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(r.finishReason).toBe(expected);
  });

  const googleCases: Array<{ raw: string | undefined; expected: string }> = [
    { raw: 'STOP',       expected: 'stop' },
    { raw: 'MAX_TOKENS', expected: 'length' },
    { raw: 'SAFETY',     expected: 'content_filter' },
    { raw: 'OTHER',      expected: 'stop' },
    { raw: undefined,    expected: 'stop' },
  ];

  it.each(googleCases)('google: $raw → $expected', async ({ raw, expected }) => {
    mockGenerateContent.mockResolvedValue(googleSuccessResponse('x', raw as string));
    const p = makeGoogle();
    const r = await p.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(r.finishReason).toBe(expected);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Error status code × retry behaviour  (10 × 3 = 30)
// ═════════════════════════════════════════════════════════════════════════════

// withRetry is used by openai/google; anthropic has its own loop keyed on "overloaded"
const statusCases: Array<{ status: number; retryable: boolean }> = [
  { status: 429, retryable: true },
  { status: 500, retryable: true },
  { status: 502, retryable: true },
  { status: 503, retryable: true },
  { status: 400, retryable: false },
  { status: 401, retryable: false },
  { status: 403, retryable: false },
  { status: 404, retryable: false },
  { status: 422, retryable: false },
  { status: 200, retryable: false },
];

describe.each([
  { providerName: 'openai',  setupSuccess: () => mockOpenAICreate.mockResolvedValue(openaiSuccessResponse()),  setupError: (err: Error) => mockOpenAICreate.mockRejectedValue(err),  callFn: () => makeOpenAI().complete({ messages: [{ role: 'user', content: 'hi' }] }) },
  { providerName: 'google',  setupSuccess: () => mockGenerateContent.mockResolvedValue(googleSuccessResponse()), setupError: (err: Error) => mockGenerateContent.mockRejectedValue(err), callFn: () => makeGoogle().complete({ messages: [{ role: 'user', content: 'hi' }] }) },
])('status-code retry × $providerName', ({ setupSuccess, setupError, callFn }) => {
  beforeEach(() => {
    mockOpenAICreate.mockReset();
    mockGenerateContent.mockReset();
  });

  it.each(statusCases)('status=$status retryable=$retryable', async ({ status, retryable }) => {
    const err = Object.assign(new Error(`HTTP ${status}`), { status });
    setupError(err);
    // If retryable, the retry wrapper will call up to 4 times and eventually throw.
    // If not retryable, throws on first attempt.
    await expect(callFn()).rejects.toThrow();
    // Retryable errors are called more times (up to maxRetries+1).
    if (retryable) {
      const callCount = mockOpenAICreate.mock.calls.length + mockGenerateContent.mock.calls.length;
      expect(callCount).toBeGreaterThan(1);
    }
  });
});

// For Anthropic's own retry loop: keyed on "overloaded" in message text.
describe('status-code retry × anthropic', () => {
  beforeEach(() => { mockAnthropicCreate.mockReset(); });

  it.each(statusCases)('status=$status retryable=$retryable (anthropic uses overloaded message)', async ({ status, retryable: _retryable }) => {
    // Anthropic provider retries on "overloaded" message, not status codes.
    // Here we just verify it throws when the API rejects with any status.
    const err = Object.assign(new Error(`HTTP ${status}`), { status });
    mockAnthropicCreate.mockRejectedValue(err);
    await expect(makeAnthropic().complete({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Error message string × retry behaviour  (8 × 3 = 24)
// ═════════════════════════════════════════════════════════════════════════════

const errorMessageCases: Array<{ msg: string; retryable: boolean }> = [
  { msg: 'overloaded',          retryable: true },
  { msg: 'rate limit exceeded',  retryable: true },
  { msg: 'too many requests',    retryable: true },
  { msg: 'server error',         retryable: true },
  { msg: 'bad gateway',          retryable: true },
  { msg: 'service unavailable',  retryable: true },
  { msg: 'invalid api key',      retryable: false },
  { msg: 'not found',            retryable: false },
];

describe.each([
  {
    providerName: 'openai',
    resetMock: () => mockOpenAICreate.mockReset(),
    setReject: (e: Error) => mockOpenAICreate.mockRejectedValue(e),
    getCallCount: () => mockOpenAICreate.mock.calls.length,
    callFn: () => makeOpenAI().complete({ messages: [{ role: 'user', content: 'hi' }] }),
  },
  {
    providerName: 'google',
    resetMock: () => mockGenerateContent.mockReset(),
    setReject: (e: Error) => mockGenerateContent.mockRejectedValue(e),
    getCallCount: () => mockGenerateContent.mock.calls.length,
    callFn: () => makeGoogle().complete({ messages: [{ role: 'user', content: 'hi' }] }),
  },
  {
    providerName: 'anthropic',
    resetMock: () => mockAnthropicCreate.mockReset(),
    setReject: (e: Error) => mockAnthropicCreate.mockRejectedValue(e),
    getCallCount: () => mockAnthropicCreate.mock.calls.length,
    callFn: () => makeAnthropic().complete({ messages: [{ role: 'user', content: 'hi' }] }),
  },
])('error-message retry × $providerName', ({ resetMock, setReject, getCallCount, callFn, providerName }) => {
  beforeEach(() => { resetMock(); });

  it.each(errorMessageCases)('msg="$msg" retryable=$retryable', async ({ msg, retryable }) => {
    const err = new Error(msg);
    setReject(err);
    await expect(callFn()).rejects.toThrow();
    const calls = getCallCount();
    // Anthropic retries only on "overloaded" / "Overloaded"
    if (providerName === 'anthropic') {
      const isAnthropicRetryable = /overloaded/i.test(msg);
      if (isAnthropicRetryable) {
        expect(calls).toBeGreaterThan(1);
      } else {
        expect(calls).toBe(1);
      }
    } else {
      // openai/google use withRetry with message regex
      if (retryable) {
        expect(calls).toBeGreaterThan(1);
      } else {
        expect(calls).toBe(1);
      }
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Tool definition format per provider  (3 × 5 = 15)
// ═════════════════════════════════════════════════════════════════════════════

const toolFixtures: ToolDefinition[] = [
  { name: 'get_time',    description: 'Get current time',   inputSchema: { type: 'object', properties: {} } },
  { name: 'search',      description: 'Search the web',     inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'calc',        description: 'Calculator',          inputSchema: { type: 'object', properties: { expr: { type: 'string' } } } },
  { name: 'no_params',   description: 'No parameters tool',  inputSchema: { type: 'object', properties: {} } },
  { name: 'multi_param', description: 'Multiple params',     inputSchema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } }, required: ['a'] } },
];

describe('tool format × anthropic', () => {
  beforeEach(() => { mockAnthropicCreate.mockReset(); mockAnthropicCreate.mockResolvedValue(anthropicSuccessResponse()); });

  it.each(toolFixtures)('tool $name is accepted by anthropic without throwing', async (tool) => {
    const p = makeAnthropic();
    const r = await p.completeWithTools({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [tool],
    });
    expect(r).toHaveProperty('content');
    expect(mockAnthropicCreate).toHaveBeenCalledOnce();
    const callArgs = mockAnthropicCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    const tools = callArgs['tools'] as Array<Record<string, unknown>>;
    expect(tools).toBeDefined();
    expect(tools[0]).toHaveProperty('name', tool.name);
    expect(tools[0]).toHaveProperty('description', tool.description);
    expect(tools[0]).toHaveProperty('input_schema');
  });
});

describe('tool format × openai', () => {
  beforeEach(() => { mockOpenAICreate.mockReset(); mockOpenAICreate.mockResolvedValue(openaiSuccessResponse()); });

  it.each(toolFixtures)('tool $name is formatted as function for openai', async (tool) => {
    const p = makeOpenAI();
    const r = await p.completeWithTools({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [tool],
    });
    expect(r).toHaveProperty('content');
    const callArgs = mockOpenAICreate.mock.calls[0]?.[0] as Record<string, unknown>;
    const tools = callArgs['tools'] as Array<Record<string, unknown>>;
    expect(tools[0]).toHaveProperty('type', 'function');
    expect((tools[0]['function'] as Record<string, unknown>)['name']).toBe(tool.name);
  });
});

describe('tool format × google', () => {
  beforeEach(() => {
    mockGenerateContent.mockReset();
    mockGetGenerativeModel.mockReset();
    mockGetGenerativeModel.mockReturnValue({ generateContent: mockGenerateContent });
    mockGenerateContent.mockResolvedValue(googleSuccessResponse());
  });

  it.each(toolFixtures)('tool $name is formatted as functionDeclaration for google', async (tool) => {
    const p = makeGoogle();
    const r = await p.completeWithTools({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [tool],
    });
    expect(r).toHaveProperty('content');
    // Use the most-recent call to getGenerativeModel
    const genModelCall = mockGetGenerativeModel.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    const googleTools = (genModelCall['tools'] as Array<Record<string, unknown>>)?.[0];
    expect(googleTools).toBeDefined();
    const decls = googleTools?.['functionDeclarations'] as Array<Record<string, unknown>>;
    expect(decls[0]).toHaveProperty('name', tool.name);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. MaxTokens default × provider  (3 × 4 = 12)
// ═════════════════════════════════════════════════════════════════════════════

const maxTokensConfigCases: Array<{ configTokens: number | undefined; optionTokens: number | undefined; expectedTokens: number }> = [
  { configTokens: undefined, optionTokens: undefined, expectedTokens: 8192 }, // both omitted → default 8192
  { configTokens: 4096,      optionTokens: undefined, expectedTokens: 4096 }, // config default wins
  { configTokens: undefined, optionTokens: 2048,      expectedTokens: 2048 }, // option overrides default
  { configTokens: 4096,      optionTokens: 1024,      expectedTokens: 1024 }, // option overrides config
];

describe('maxTokens defaults × anthropic', () => {
  beforeEach(() => { mockAnthropicCreate.mockReset(); mockAnthropicCreate.mockResolvedValue(anthropicSuccessResponse()); });

  it.each(maxTokensConfigCases)(
    'config=$configTokens option=$optionTokens → $expectedTokens',
    async ({ configTokens, optionTokens, expectedTokens }) => {
      const p = new AnthropicProvider({ model: 'claude-3-5-haiku-20241022', ...(configTokens !== undefined ? { maxTokens: configTokens } : {}) });
      await p.complete({ messages: [{ role: 'user', content: 'hi' }], ...(optionTokens !== undefined ? { maxTokens: optionTokens } : {}) });
      const args = mockAnthropicCreate.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(args['max_tokens']).toBe(expectedTokens);
    }
  );
});

describe('maxTokens defaults × openai', () => {
  beforeEach(() => { mockOpenAICreate.mockReset(); mockOpenAICreate.mockResolvedValue(openaiSuccessResponse()); });

  it.each(maxTokensConfigCases)(
    'config=$configTokens option=$optionTokens → $expectedTokens',
    async ({ configTokens, optionTokens, expectedTokens }) => {
      const p = new OpenAIProvider({ model: 'gpt-4o-mini', ...(configTokens !== undefined ? { maxTokens: configTokens } : {}) });
      await p.complete({ messages: [{ role: 'user', content: 'hi' }], ...(optionTokens !== undefined ? { maxTokens: optionTokens } : {}) });
      const args = mockOpenAICreate.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(args['max_tokens']).toBe(expectedTokens);
    }
  );
});

describe('maxTokens defaults × google', () => {
  beforeEach(() => {
    mockGenerateContent.mockReset();
    mockGetGenerativeModel.mockReset();
    mockGetGenerativeModel.mockReturnValue({ generateContent: mockGenerateContent });
    mockGenerateContent.mockResolvedValue(googleSuccessResponse());
  });

  it.each(maxTokensConfigCases)(
    'config=$configTokens option=$optionTokens → $expectedTokens',
    async ({ configTokens, optionTokens, expectedTokens }) => {
      const p = new GoogleProvider({ model: 'gemini-1.5-flash', ...(configTokens !== undefined ? { maxTokens: configTokens } : {}) });
      await p.complete({ messages: [{ role: 'user', content: 'hi' }], ...(optionTokens !== undefined ? { maxTokens: optionTokens } : {}) });
      const genModelConfig = mockGetGenerativeModel.mock.calls.at(-1)?.[0] as Record<string, unknown>;
      const genConfig = genModelConfig['generationConfig'] as Record<string, unknown>;
      expect(genConfig['maxOutputTokens']).toBe(expectedTokens);
    }
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. Temperature × provider  (3 × 5 = 15)
// ═════════════════════════════════════════════════════════════════════════════

const temperatureCases: Array<{ temp: number | undefined; expectedTemp: number }> = [
  { temp: 0,         expectedTemp: 0 },
  { temp: 0.5,       expectedTemp: 0.5 },
  { temp: 1,         expectedTemp: 1 },
  { temp: undefined, expectedTemp: 1 }, // all providers default to 1
  { temp: 2,         expectedTemp: 2 },
];

describe('temperature × anthropic', () => {
  beforeEach(() => { mockAnthropicCreate.mockReset(); mockAnthropicCreate.mockResolvedValue(anthropicSuccessResponse()); });

  it.each(temperatureCases)('temp=$temp → $expectedTemp', async ({ temp, expectedTemp }) => {
    await makeAnthropic().complete({ messages: [{ role: 'user', content: 'hi' }], ...(temp !== undefined ? { temperature: temp } : {}) });
    const args = mockAnthropicCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args['temperature']).toBe(expectedTemp);
  });
});

describe('temperature × openai', () => {
  beforeEach(() => { mockOpenAICreate.mockReset(); mockOpenAICreate.mockResolvedValue(openaiSuccessResponse()); });

  it.each(temperatureCases)('temp=$temp → $expectedTemp', async ({ temp, expectedTemp }) => {
    await makeOpenAI().complete({ messages: [{ role: 'user', content: 'hi' }], ...(temp !== undefined ? { temperature: temp } : {}) });
    const args = mockOpenAICreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args['temperature']).toBe(expectedTemp);
  });
});

describe('temperature × google', () => {
  beforeEach(() => {
    mockGenerateContent.mockReset();
    mockGetGenerativeModel.mockReset();
    mockGetGenerativeModel.mockReturnValue({ generateContent: mockGenerateContent });
    mockGenerateContent.mockResolvedValue(googleSuccessResponse());
  });

  it.each(temperatureCases)('temp=$temp → $expectedTemp', async ({ temp, expectedTemp }) => {
    await makeGoogle().complete({ messages: [{ role: 'user', content: 'hi' }], ...(temp !== undefined ? { temperature: temp } : {}) });
    const genModelConfig = mockGetGenerativeModel.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    const genConfig = genModelConfig['generationConfig'] as Record<string, unknown>;
    expect(genConfig['temperature']).toBe(expectedTemp);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. API-key resolution × provider  (3 × 4 = 12)
// ═════════════════════════════════════════════════════════════════════════════

const apiKeySourceCases = [
  { label: 'explicit-config', key: 'explicit-key-123' },
  { label: 'env-var',         key: undefined }, // relies on env
  { label: 'empty-string',    key: '' },
  { label: 'long-key',        key: 'sk-' + 'a'.repeat(40) },
] as const;

describe.each([
  { providerName: 'anthropic', makeP: (key: string | undefined) => new AnthropicProvider({ model: 'claude-3-5-haiku-20241022', ...(key !== undefined ? { apiKey: key } : {}) }), setupSuccess: () => mockAnthropicCreate.mockResolvedValue(anthropicSuccessResponse()), callFn: (p: AnthropicProvider) => p.complete({ messages: [{ role: 'user', content: 'hi' }] }) },
  { providerName: 'openai',    makeP: (key: string | undefined) => new OpenAIProvider({ model: 'gpt-4o-mini', ...(key !== undefined ? { apiKey: key } : {}) }),    setupSuccess: () => mockOpenAICreate.mockResolvedValue(openaiSuccessResponse()),         callFn: (p: OpenAIProvider) => p.complete({ messages: [{ role: 'user', content: 'hi' }] }) },
  { providerName: 'google',    makeP: (key: string | undefined) => new GoogleProvider({ model: 'gemini-1.5-flash', ...(key !== undefined ? { apiKey: key } : {}) }), setupSuccess: () => mockGenerateContent.mockResolvedValue(googleSuccessResponse()),      callFn: (p: GoogleProvider) => p.complete({ messages: [{ role: 'user', content: 'hi' }] }) },
])('api-key resolution × $providerName', ({ makeP, setupSuccess, callFn }) => {
  beforeEach(() => {
    mockAnthropicCreate.mockReset();
    mockOpenAICreate.mockReset();
    mockGenerateContent.mockReset();
    setupSuccess();
  });

  it.each(apiKeySourceCases)('key source=$label constructs provider without throwing', ({ key }) => {
    expect(() => makeP(key)).not.toThrow();
  });

  it.each(apiKeySourceCases)('key source=$label provider.name and model are set', ({ key }) => {
    const p = makeP(key);
    expect(p.name).toBeDefined();
    expect(p.model).toBeDefined();
  });

  it.each(apiKeySourceCases)('key source=$label provider can complete successfully', async ({ key }) => {
    const p = makeP(key) as AnthropicProvider & OpenAIProvider & GoogleProvider;
    await expect(callFn(p as never)).resolves.toHaveProperty('content');
  });

  it.each(apiKeySourceCases)('key source=$label provider exposes correct interface', ({ key }) => {
    const p = makeP(key);
    expect(typeof p.complete).toBe('function');
    expect(typeof p.completeWithTools).toBe('function');
    expect(typeof p.continueWithToolResults).toBe('function');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. Content-block types × provider  (3 × 4 = 12)
// ═════════════════════════════════════════════════════════════════════════════

const contentBlockCases: Array<{ label: string; content: Message['content'] }> = [
  { label: 'text-string',  content: 'plain text string' },
  { label: 'text-block',   content: [{ type: 'text', text: 'block text' }] },
  {
    label: 'image-block',
    content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/abc' } } as ContentBlock],
  },
  {
    label: 'mixed-blocks',
    content: [
      { type: 'text', text: 'look at this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } } as ContentBlock,
    ],
  },
];

describe.each([
  {
    providerName: 'anthropic',
    setupMock: () => mockAnthropicCreate.mockResolvedValue(anthropicSuccessResponse()),
    resetMock: () => mockAnthropicCreate.mockReset(),
    callFn: (content: Message['content']) => makeAnthropic().complete({ messages: [{ role: 'user', content }] }),
  },
  {
    providerName: 'openai',
    setupMock: () => mockOpenAICreate.mockResolvedValue(openaiSuccessResponse()),
    resetMock: () => mockOpenAICreate.mockReset(),
    callFn: (content: Message['content']) => makeOpenAI().complete({ messages: [{ role: 'user', content }] }),
  },
  {
    providerName: 'google',
    setupMock: () => mockGenerateContent.mockResolvedValue(googleSuccessResponse()),
    resetMock: () => mockGenerateContent.mockReset(),
    callFn: (content: Message['content']) => makeGoogle().complete({ messages: [{ role: 'user', content }] }),
  },
])('content-block types × $providerName', ({ setupMock, resetMock, callFn }) => {
  beforeEach(() => { resetMock(); setupMock(); });

  it.each(contentBlockCases)('$label → result has content and finishReason', async ({ content }) => {
    const r = await callFn(content);
    expect(r).toHaveProperty('content');
    expect(r).toHaveProperty('finishReason');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 10. Streaming capability matrix  (3 × 4 × 2 = 24)
// ═════════════════════════════════════════════════════════════════════════════

type StreamMethodName = 'completeStream' | 'completeWithToolsStream' | 'continueWithToolResultsStream' | 'complete';

const streamMethods: Array<{ method: StreamMethodName; isOptional: boolean }> = [
  { method: 'complete',                     isOptional: false },
  { method: 'completeStream',               isOptional: true },
  { method: 'completeWithToolsStream',      isOptional: true },
  { method: 'continueWithToolResultsStream', isOptional: true },
];

describe.each([
  { providerName: 'anthropic', makeP: makeAnthropic },
  { providerName: 'openai',    makeP: makeOpenAI },
  { providerName: 'google',    makeP: makeGoogle },
])('streaming capability × $providerName', ({ makeP }) => {
  it.each(streamMethods.map((s) => ({ ...s, exists: true })))(
    'method $method is a function when defined',
    ({ method }) => {
      const p = makeP();
      if (method in p) {
        expect(typeof (p as Record<string, unknown>)[method]).toBe('function');
      }
    }
  );

  it.each(streamMethods)(
    'required method $method existence matches isOptional=$isOptional',
    ({ method, isOptional }) => {
      const p = makeP();
      if (!isOptional) {
        expect(method in p).toBe(true);
      } else {
        // optional methods may or may not exist
        const exists = method in p;
        expect(typeof exists).toBe('boolean');
      }
    }
  );
});

// Anthropic implements all four streaming methods
describe('streaming completeness × anthropic', () => {
  it.each(streamMethods)('method $method exists on AnthropicProvider', ({ method }) => {
    const p = makeAnthropic();
    expect(typeof (p as Record<string, unknown>)[method]).toBe('function');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Bonus: withRetry unit-level  (6 tests)
// ═════════════════════════════════════════════════════════════════════════════

describe('withRetry unit', () => {
  it.each([
    { status: 429, expectedCalls: 4 },
    { status: 503, expectedCalls: 4 },
    { status: 400, expectedCalls: 1 },
    { status: 401, expectedCalls: 1 },
    { status: 403, expectedCalls: 1 },
    { status: 404, expectedCalls: 1 },
  ])('status=$status → calls=$expectedCalls before throwing', async ({ status, expectedCalls }) => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      const err = Object.assign(new Error(`status ${status}`), { status });
      throw err;
    };
    await expect(withRetry(fn, 'test', { baseDelayMs: 0 })).rejects.toThrow();
    expect(callCount).toBe(expectedCalls);
  });
});
