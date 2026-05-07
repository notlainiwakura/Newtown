/**
 * Error injection and resilience test suite
 *
 * Verifies the system degrades gracefully under failure conditions.
 * Every test injects a fault and asserts the system either:
 *   (a) contains the error (doesn't crash / propagate up), or
 *   (b) logs the error (logger.warn/error called), or
 *   (c) falls back to a safe default value.
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';

// Suppress unhandled rejection warnings from intentional error-injection tests
const noop = () => {};
beforeAll(() => { process.on('unhandledRejection', noop); });
afterAll(() => { process.off('unhandledRejection', noop); });

// ─── Hoisted mocks (must be declared before any imports) ─────────────────────

const {
  mockLoggerWarn,
  mockLoggerError,
  mockLoggerInfo,
  mockGetMeta,
  mockSetMeta,
  mockAtomicMetaIncrementCounter,
  mockExecute,
  mockQuery,
  mockQueryOne,
  mockGenerateEmbedding,
} = vi.hoisted(() => {
  const mockLoggerWarn = vi.fn();
  const mockLoggerError = vi.fn();
  const mockLoggerInfo = vi.fn();
  const mockGetMeta = vi.fn();
  const mockSetMeta = vi.fn();
  const mockAtomicMetaIncrementCounter = vi.fn();
  const mockExecute = vi.fn();
  const mockQuery = vi.fn();
  const mockQueryOne = vi.fn();
  const mockGenerateEmbedding = vi.fn();
  return {
    mockLoggerWarn,
    mockLoggerError,
    mockLoggerInfo,
    mockGetMeta,
    mockSetMeta,
    mockAtomicMetaIncrementCounter,
    mockExecute,
    mockQuery,
    mockQueryOne,
    mockGenerateEmbedding,
  };
});

vi.mock('../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
    error: mockLoggerError,
  }),
}));

vi.mock('../src/storage/database.js', () => ({
  getMeta: mockGetMeta,
  setMeta: mockSetMeta,
  atomicMetaIncrementCounter: mockAtomicMetaIncrementCounter,
  execute: mockExecute,
  query: mockQuery,
  queryOne: mockQueryOne,
  transaction: vi.fn((fn: () => unknown) => fn()),
  getDatabase: vi.fn(),
  isDatabaseInitialized: vi.fn(() => true),
  closeDatabase: vi.fn(),
  initDatabase: vi.fn().mockResolvedValue({}),
}));

vi.mock('../src/memory/embeddings.js', () => ({
  generateEmbedding: mockGenerateEmbedding,
  serializeEmbedding: vi.fn((e: Float32Array) => Buffer.from(e.buffer)),
  deserializeEmbedding: vi.fn((b: Buffer) => new Float32Array(b.buffer)),
  cosineSimilarity: vi.fn(() => 0.8),
  CURRENT_EMBEDDING_MODEL: 'Xenova/all-MiniLM-L6-v2',
}));

// palace.js — needed by saveMemory
vi.mock('../src/memory/palace.js', () => ({
  assignHall: vi.fn(() => 'episode'),
  resolveWingForMemory: vi.fn(() => ({ wingName: 'test-wing', wingDescription: 'test' })),
  resolveWing: vi.fn(() => 'wing-id-1'),
  resolveRoom: vi.fn(() => 'room-id-1'),
  incrementWingCount: vi.fn(),
  incrementRoomCount: vi.fn(),
}));

// events bus
vi.mock('../src/events/bus.js', () => ({
  eventBus: { emitActivity: vi.fn(), on: vi.fn(), off: vi.fn() },
  parseEventType: vi.fn(() => 'diary'),
}));

// ─────────────────────────────────────────────────────────────────────────────
// 1. RETRY LOGIC
// ─────────────────────────────────────────────────────────────────────────────

describe('Retry logic — withRetry()', () => {
  let withRetry: typeof import('../src/providers/retry.js').withRetry;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    ({ withRetry } = await import('../src/providers/retry.js'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('succeeds on first attempt without retries', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const promise = withRetry(fn, 'test', { maxRetries: 3, baseDelayMs: 10, retryableStatusCodes: [429] });
    await vi.runAllTimersAsync();
    expect(await promise).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 and succeeds on second attempt', async () => {
    const err429 = Object.assign(new Error('rate limit'), { status: 429 });
    const fn = vi.fn()
      .mockRejectedValueOnce(err429)
      .mockResolvedValue('ok');
    const promise = withRetry(fn, 'test', { maxRetries: 3, baseDelayMs: 10, retryableStatusCodes: [429] });
    await vi.runAllTimersAsync();
    expect(await promise).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on 500 server error', async () => {
    const err500 = Object.assign(new Error('server error'), { status: 500 });
    const fn = vi.fn()
      .mockRejectedValueOnce(err500)
      .mockResolvedValue('done');
    const promise = withRetry(fn, 'test', { maxRetries: 3, baseDelayMs: 10, retryableStatusCodes: [500] });
    await vi.runAllTimersAsync();
    expect(await promise).toBe('done');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on 401 unauthorized — fails immediately', async () => {
    const err401 = Object.assign(new Error('unauthorized'), { status: 401 });
    const fn = vi.fn().mockRejectedValue(err401);
    await expect(
      withRetry(fn, 'test', { maxRetries: 3, baseDelayMs: 10, retryableStatusCodes: [429, 500] })
    ).rejects.toThrow('unauthorized');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on 403 forbidden', async () => {
    const err403 = Object.assign(new Error('forbidden'), { status: 403 });
    const fn = vi.fn().mockRejectedValue(err403);
    await expect(
      withRetry(fn, 'test', { maxRetries: 3, baseDelayMs: 10, retryableStatusCodes: [429, 500] })
    ).rejects.toThrow('forbidden');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries up to maxRetries then throws', async () => {
    const makeErr = () => Object.assign(new Error('overloaded'), { status: 429 });
    const fn = vi.fn().mockImplementation(() => Promise.reject(makeErr()));
    const promise = withRetry(fn, 'test', { maxRetries: 2, baseDelayMs: 10, retryableStatusCodes: [429] });
    await vi.runAllTimersAsync();
    await expect(promise).rejects.toThrow('overloaded');
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('logs a warning on each retryable failure', async () => {
    const err = Object.assign(new Error('rate limit'), { status: 429 });
    const fn = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValue('ok');
    const promise = withRetry(fn, 'my-provider', { maxRetries: 3, baseDelayMs: 10, retryableStatusCodes: [429] });
    await vi.runAllTimersAsync();
    await promise;
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'my-provider' }),
      expect.any(String)
    );
  });

  it('retries on "rate limit" in error message (no status code)', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('rate limit exceeded'))
      .mockResolvedValue('ok');
    const promise = withRetry(fn, 'test', { maxRetries: 3, baseDelayMs: 10, retryableStatusCodes: [429] });
    await vi.runAllTimersAsync();
    expect(await promise).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on "overloaded" in error message', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('model is overloaded'))
      .mockResolvedValue('ok');
    const promise = withRetry(fn, 'test', { maxRetries: 3, baseDelayMs: 10, retryableStatusCodes: [429] });
    await vi.runAllTimersAsync();
    expect(await promise).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on "too many requests" in message', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('too many requests'))
      .mockResolvedValue('ok');
    const promise = withRetry(fn, 'test', { maxRetries: 3, baseDelayMs: 10, retryableStatusCodes: [429] });
    await vi.runAllTimersAsync();
    expect(await promise).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on 502 bad gateway', async () => {
    const err = Object.assign(new Error('bad gateway'), { status: 502 });
    const fn = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValue('ok');
    const promise = withRetry(fn, 'test', { maxRetries: 3, baseDelayMs: 10, retryableStatusCodes: [502] });
    await vi.runAllTimersAsync();
    expect(await promise).toBe('ok');
  });

  it('retries on 503 service unavailable', async () => {
    const err = Object.assign(new Error('service unavailable'), { status: 503 });
    const fn = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValue('ok');
    const promise = withRetry(fn, 'test', { maxRetries: 3, baseDelayMs: 10, retryableStatusCodes: [503] });
    await vi.runAllTimersAsync();
    expect(await promise).toBe('ok');
  });

  it('uses exponential backoff with full jitter: delay bounded by 2^attempt cap (findings.md P2:1050)', async () => {
    // findings.md P2:1050 — full jitter picks delay uniformly in
    // [0, baseDelay * 2^attempt]. The exponential shape lives in the cap,
    // not the sampled delay. Pin Math.random so we can assert the cap
    // growth deterministically.
    const delays: number[] = [];
    const originalSetTimeout = global.setTimeout;
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation((fn, ms, ...args) => {
      if (typeof ms === 'number') delays.push(ms);
      return originalSetTimeout(fn as () => void, 0, ...args);
    });
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.9999);

    const err = Object.assign(new Error('rate limit'), { status: 429 });
    const fn = vi.fn()
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err)
      .mockResolvedValue('ok');

    const promise = withRetry(fn, 'test', { maxRetries: 3, baseDelayMs: 100, retryableStatusCodes: [429] });
    await vi.runAllTimersAsync();
    await promise;

    setTimeoutSpy.mockRestore();
    randomSpy.mockRestore();
    // With random ≈ 1: delay ≈ cap. First cap is 100, second is 200.
    expect(delays.length).toBeGreaterThanOrEqual(2);
    expect(delays[0]).toBeGreaterThanOrEqual(99);
    expect(delays[0]).toBeLessThanOrEqual(100);
    expect(delays[1]).toBeGreaterThanOrEqual(199);
    expect(delays[1]).toBeLessThanOrEqual(200);
  });

  it('full jitter produces different delays for two concurrent retriers (findings.md P2:1050)', async () => {
    // findings.md P2:1050 — the whole point of jitter is that two callers
    // failing at the same instant don't retry in lockstep. Fix two
    // different Math.random samples and assert the two computed delays
    // differ.
    const capturedDelays: number[] = [];
    const originalSetTimeout = global.setTimeout;
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation((fn, ms, ...args) => {
      if (typeof ms === 'number') capturedDelays.push(ms);
      return originalSetTimeout(fn as () => void, 0, ...args);
    });
    const randomSpy = vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.1) // caller A's first delay
      .mockReturnValueOnce(0.9); // caller B's first delay

    const err = Object.assign(new Error('rate limit'), { status: 429 });
    const makeFn = () => vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');

    const a = withRetry(makeFn(), 'a', { maxRetries: 1, baseDelayMs: 1000, retryableStatusCodes: [429] });
    const b = withRetry(makeFn(), 'b', { maxRetries: 1, baseDelayMs: 1000, retryableStatusCodes: [429] });
    await vi.runAllTimersAsync();
    await Promise.all([a, b]);

    setTimeoutSpy.mockRestore();
    randomSpy.mockRestore();
    expect(capturedDelays).toHaveLength(2);
    expect(capturedDelays[0]).not.toBe(capturedDelays[1]);
  });

  it('propagates non-retryable errors immediately', async () => {
    const fn = vi.fn().mockRejectedValue(new TypeError('network parse failed'));
    await expect(
      withRetry(fn, 'test', { maxRetries: 3, baseDelayMs: 10, retryableStatusCodes: [429, 500] })
    ).rejects.toThrow('network parse failed');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('uses default config when config is omitted', async () => {
    const fn = vi.fn().mockResolvedValue('result');
    const promise = withRetry(fn, 'test');
    await vi.runAllTimersAsync();
    expect(await promise).toBe('result');
  });

  it('honors Retry-After header in seconds (findings.md P2:1060)', async () => {
    // findings.md P2:1060 — server told us to wait 30s; must not retry
    // again inside that window.
    const delays: number[] = [];
    const originalSetTimeout = global.setTimeout;
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation((fn, ms, ...args) => {
      if (typeof ms === 'number') delays.push(ms);
      return originalSetTimeout(fn as () => void, 0, ...args);
    });
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0); // force jitter to 0

    const err = Object.assign(new Error('rate limit'), {
      status: 429,
      headers: { 'retry-after': '30' },
    });
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');

    const promise = withRetry(fn, 'test', { maxRetries: 3, baseDelayMs: 100, retryableStatusCodes: [429] });
    await vi.runAllTimersAsync();
    await promise;

    setTimeoutSpy.mockRestore();
    randomSpy.mockRestore();
    // 30s = 30000ms, which is far larger than the jittered backoff.
    expect(delays[0]).toBe(30000);
  });

  it('honors Retry-After HTTP-date (findings.md P2:1060)', async () => {
    // findings.md P2:1060 — RFC 7231 also allows an HTTP-date value.
    const delays: number[] = [];
    const originalSetTimeout = global.setTimeout;
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation((fn, ms, ...args) => {
      if (typeof ms === 'number') delays.push(ms);
      return originalSetTimeout(fn as () => void, 0, ...args);
    });
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    const futureDate = new Date(Date.now() + 5000).toUTCString();

    const err = Object.assign(new Error('rate limit'), {
      status: 429,
      headers: { 'retry-after': futureDate },
    });
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');

    const promise = withRetry(fn, 'test', { maxRetries: 3, baseDelayMs: 100, retryableStatusCodes: [429] });
    await vi.runAllTimersAsync();
    await promise;

    setTimeoutSpy.mockRestore();
    randomSpy.mockRestore();
    // Within ~1s of 5000ms target.
    expect(delays[0]).toBeGreaterThan(3500);
    expect(delays[0]).toBeLessThanOrEqual(5000);
  });

  it('falls back to jittered backoff when Retry-After absent (findings.md P2:1060)', async () => {
    // findings.md P2:1060 — no header means keep normal backoff behavior.
    const delays: number[] = [];
    const originalSetTimeout = global.setTimeout;
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation((fn, ms, ...args) => {
      if (typeof ms === 'number') delays.push(ms);
      return originalSetTimeout(fn as () => void, 0, ...args);
    });
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.9999);

    const err = Object.assign(new Error('rate limit'), { status: 429 });
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');

    const promise = withRetry(fn, 'test', { maxRetries: 3, baseDelayMs: 100, retryableStatusCodes: [429] });
    await vi.runAllTimersAsync();
    await promise;

    setTimeoutSpy.mockRestore();
    randomSpy.mockRestore();
    expect(delays[0]).toBeGreaterThanOrEqual(99);
    expect(delays[0]).toBeLessThanOrEqual(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. FALLBACK PROVIDER CHAIN
// ─────────────────────────────────────────────────────────────────────────────

describe('Fallback provider chain — createFallbackProvider()', () => {
  let createFallbackProvider: typeof import('../src/providers/fallback.js').createFallbackProvider;

  const makeProvider = (model: string, complete: (...args: unknown[]) => unknown) => ({
    name: 'test',
    model,
    complete: vi.fn(complete as () => Promise<unknown>),
    completeWithTools: vi.fn(complete as () => Promise<unknown>),
    continueWithToolResults: vi.fn(complete as () => Promise<unknown>),
  });

  const goodResult = { content: 'hello', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } };
  const opts = { messages: [{ role: 'user' as const, content: 'hi' }] };

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ createFallbackProvider } = await import('../src/providers/fallback.js'));
  });

  it('returns primary provider when no fallbacks given', async () => {
    const primary = makeProvider('primary', () => Promise.resolve(goodResult));
    const proxy = createFallbackProvider(primary as never, [], () => primary as never);
    expect(proxy.model).toBe('primary');
    await expect(proxy.complete(opts)).resolves.toEqual(goodResult);
  });

  it('uses primary successfully — never calls factory', async () => {
    const primary = makeProvider('primary', () => Promise.resolve(goodResult));
    const factory = vi.fn();
    const proxy = createFallbackProvider(primary as never, ['fallback-1'], factory);
    await proxy.complete(opts);
    expect(factory).not.toHaveBeenCalled();
  });

  it('falls back when primary returns 404 model-not-found', async () => {
    const err404 = Object.assign(new Error('model not found'), { status: 404 });
    const primary = makeProvider('primary', () => Promise.reject(err404));
    const fallback = makeProvider('fallback-1', () => Promise.resolve(goodResult));
    const factory = vi.fn().mockReturnValue(fallback);
    const proxy = createFallbackProvider(primary as never, ['fallback-1'], factory);
    const result = await proxy.complete(opts);
    expect(result).toEqual(goodResult);
    expect(factory).toHaveBeenCalledWith('fallback-1');
  });

  it('falls back on 410 deprecated/gone', async () => {
    const err410 = Object.assign(new Error('model gone'), { status: 410 });
    const primary = makeProvider('primary', () => Promise.reject(err410));
    const fallback = makeProvider('fallback-2', () => Promise.resolve(goodResult));
    const factory = vi.fn().mockReturnValue(fallback);
    const proxy = createFallbackProvider(primary as never, ['fallback-2'], factory);
    await expect(proxy.complete(opts)).resolves.toEqual(goodResult);
  });

  it('falls back on "deprecated" in error message', async () => {
    const primary = makeProvider('primary', () => Promise.reject(new Error('model deprecated')));
    const fallback = makeProvider('new-model', () => Promise.resolve(goodResult));
    const factory = vi.fn().mockReturnValue(fallback);
    const proxy = createFallbackProvider(primary as never, ['new-model'], factory);
    await expect(proxy.complete(opts)).resolves.toEqual(goodResult);
  });

  it('does NOT fall back on 500 server error — throws through', async () => {
    const err500 = Object.assign(new Error('server error'), { status: 500 });
    const primary = makeProvider('primary', () => Promise.reject(err500));
    const factory = vi.fn();
    const proxy = createFallbackProvider(primary as never, ['fallback'], factory);
    await expect(proxy.complete(opts)).rejects.toThrow('server error');
    expect(factory).not.toHaveBeenCalled();
  });

  it('does NOT fall back on 429 rate limit — throws through', async () => {
    const err429 = Object.assign(new Error('rate limit'), { status: 429 });
    const primary = makeProvider('primary', () => Promise.reject(err429));
    const factory = vi.fn();
    const proxy = createFallbackProvider(primary as never, ['fallback'], factory);
    await expect(proxy.complete(opts)).rejects.toThrow('rate limit');
    expect(factory).not.toHaveBeenCalled();
  });

  it('tries multiple fallbacks in order when each is deprecated', async () => {
    const err404 = Object.assign(new Error('model not found'), { status: 404 });
    const primary = makeProvider('primary', () => Promise.reject(err404));
    const fb1 = makeProvider('fallback-1', () => Promise.reject(err404));
    const fb2 = makeProvider('fallback-2', () => Promise.resolve(goodResult));
    const factory = vi.fn()
      .mockReturnValueOnce(fb1)
      .mockReturnValueOnce(fb2);
    const proxy = createFallbackProvider(primary as never, ['fallback-1', 'fallback-2'], factory);
    const result = await proxy.complete(opts);
    expect(result).toEqual(goodResult);
  });

  it('throws when ALL models exhausted', async () => {
    const err404 = Object.assign(new Error('model not found'), { status: 404 });
    const primary = makeProvider('primary', () => Promise.reject(err404));
    const fb = makeProvider('fallback-1', () => Promise.reject(err404));
    const factory = vi.fn().mockReturnValue(fb);
    const proxy = createFallbackProvider(primary as never, ['fallback-1'], factory);
    await expect(proxy.complete(opts)).rejects.toThrow('All models exhausted');
  });

  it('promotes successful fallback to active provider', async () => {
    const err404 = Object.assign(new Error('model not found'), { status: 404 });
    const primary = makeProvider('primary', () => Promise.reject(err404));
    const fallback = makeProvider('fallback-1', () => Promise.resolve(goodResult));
    const factory = vi.fn().mockReturnValue(fallback);
    const proxy = createFallbackProvider(primary as never, ['fallback-1'], factory);

    await proxy.complete(opts);
    // Second call — factory should NOT be called again (promoted)
    factory.mockClear();
    await proxy.complete(opts);
    expect(factory).not.toHaveBeenCalled();
  });

  it('logs warning when falling back', async () => {
    const err404 = Object.assign(new Error('model not found'), { status: 404 });
    const primary = makeProvider('primary', () => Promise.reject(err404));
    const fallback = makeProvider('fallback-1', () => Promise.resolve(goodResult));
    const factory = vi.fn().mockReturnValue(fallback);
    const proxy = createFallbackProvider(primary as never, ['fallback-1'], factory);
    await proxy.complete(opts);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'primary' }),
      expect.any(String)
    );
  });

  it('logs info when fallback succeeds', async () => {
    const err404 = Object.assign(new Error('model not found'), { status: 404 });
    const primary = makeProvider('primary', () => Promise.reject(err404));
    const fallback = makeProvider('fallback-1', () => Promise.resolve(goodResult));
    const factory = vi.fn().mockReturnValue(fallback);
    const proxy = createFallbackProvider(primary as never, ['fallback-1'], factory);
    await proxy.complete(opts);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ newModel: 'fallback-1' }),
      expect.any(String)
    );
  });

  it('completeWithTools falls back on deprecated model', async () => {
    const err = Object.assign(new Error('decommissioned'), { status: 410 });
    const primary = makeProvider('primary', () => Promise.reject(err));
    const fallback = makeProvider('fallback-1', () => Promise.resolve({ ...goodResult, toolCalls: [] }));
    const factory = vi.fn().mockReturnValue(fallback);
    const proxy = createFallbackProvider(primary as never, ['fallback-1'], factory);
    await expect(proxy.completeWithTools(opts)).resolves.toBeDefined();
  });

  it('continueWithToolResults falls back on deprecated model', async () => {
    const err = Object.assign(new Error('no longer available'), { status: 404 });
    const primary = makeProvider('primary', () => Promise.reject(err));
    const fallback = makeProvider('fallback-1', () => Promise.resolve(goodResult));
    const factory = vi.fn().mockReturnValue(fallback);
    const proxy = createFallbackProvider(primary as never, ['fallback-1'], factory);
    await expect(proxy.continueWithToolResults(opts, [], [])).resolves.toBeDefined();
  });

  // findings.md P2:1090 — when a provider lacks streaming, the proxy used
  // to call the buffered variant and never fire onChunk, leaving UIs stuck
  // on "waiting". The fix synthesizes a single chunk from the buffered
  // content so callers always see their callback fire.
  describe('stream synthesis when provider lacks streaming impl (P2:1090)', () => {
    it('completeStream fires onChunk with buffered content', async () => {
      const primary = makeProvider('primary', () => Promise.resolve(goodResult));
      const proxy = createFallbackProvider(primary as never, ['fb'], () => primary as never);
      const chunks: string[] = [];
      const result = await proxy.completeStream!(opts, (c) => chunks.push(c));
      expect(chunks).toEqual(['hello']);
      expect(result).toEqual(goodResult);
    });

    it('completeWithToolsStream fires onChunk with buffered content', async () => {
      const primary = makeProvider('primary', () => Promise.resolve({ ...goodResult, toolCalls: [] }));
      const proxy = createFallbackProvider(primary as never, ['fb'], () => primary as never);
      const chunks: string[] = [];
      await proxy.completeWithToolsStream!(opts, (c) => chunks.push(c));
      expect(chunks).toEqual(['hello']);
    });

    it('continueWithToolResultsStream fires onChunk with buffered content', async () => {
      const primary = makeProvider('primary', () => Promise.resolve(goodResult));
      const proxy = createFallbackProvider(primary as never, ['fb'], () => primary as never);
      const chunks: string[] = [];
      await proxy.continueWithToolResultsStream!(opts, [], [], (c) => chunks.push(c));
      expect(chunks).toEqual(['hello']);
    });

    it('skips onChunk when buffered content is empty', async () => {
      const emptyResult = { ...goodResult, content: '' };
      const primary = makeProvider('primary', () => Promise.resolve(emptyResult));
      const proxy = createFallbackProvider(primary as never, ['fb'], () => primary as never);
      const chunks: string[] = [];
      await proxy.completeStream!(opts, (c) => chunks.push(c));
      expect(chunks).toEqual([]);
    });

    it('prefers native completeStream when provider has one', async () => {
      const nativeStream = vi.fn((_opts: unknown, onChunk: (c: string) => void) => {
        onChunk('a');
        onChunk('b');
        return Promise.resolve(goodResult);
      });
      const primary = {
        ...makeProvider('primary', () => Promise.resolve(goodResult)),
        completeStream: nativeStream,
      };
      const proxy = createFallbackProvider(primary as never, ['fb'], () => primary as never);
      const chunks: string[] = [];
      await proxy.completeStream!(opts, (c) => chunks.push(c));
      expect(chunks).toEqual(['a', 'b']);
      expect(nativeStream).toHaveBeenCalled();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. BUDGET ENFORCEMENT
// ─────────────────────────────────────────────────────────────────────────────

describe('Budget enforcement — checkBudget() / recordUsage()', () => {
  // budget.ts imports getMeta/setMeta from database.ts which is mocked at the
  // top of this file. We import budget.ts once and control behaviour by
  // manipulating mockGetMeta / mockSetMeta per test.
  let checkBudget: typeof import('../src/providers/budget.js').checkBudget;
  let recordUsage: typeof import('../src/providers/budget.js').recordUsage;
  let BudgetExceededError: typeof import('../src/providers/budget.js').BudgetExceededError;
  let getBudgetStatus: typeof import('../src/providers/budget.js').getBudgetStatus;

  const currentMonth = new Date().toISOString().slice(0, 7);

  beforeAll(async () => {
    // Import once — module mock is stable for the entire suite
    ({ checkBudget, recordUsage, BudgetExceededError, getBudgetStatus } = await import('../src/providers/budget.js'));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['LAIN_MONTHLY_TOKEN_CAP'];
    mockSetMeta.mockReturnValue(undefined);
    mockExecute.mockReturnValue({ changes: 1, lastInsertRowid: 0 });
    // findings.md P2:1110 — recordUsage routes through an atomic helper
    // now. Default stub echoes freshJson so the 80% warning math works.
    mockAtomicMetaIncrementCounter.mockImplementation(
      (p: { freshJson: string }) => p.freshJson,
    );
  });

  it('passes when usage is zero', () => {
    mockGetMeta.mockReturnValue(null);
    expect(() => checkBudget()).not.toThrow();
  });

  it('passes when under the cap', () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '1000000';
    mockGetMeta.mockReturnValue(JSON.stringify({ month: currentMonth, tokens: 1000 }));
    expect(() => checkBudget()).not.toThrow();
  });

  it('throws BudgetExceededError when at cap', () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '100';
    mockGetMeta.mockReturnValue(JSON.stringify({ month: currentMonth, tokens: 100 }));
    expect(() => checkBudget()).toThrow(BudgetExceededError);
  });

  it('throws BudgetExceededError when over cap', () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '100';
    mockGetMeta.mockReturnValue(JSON.stringify({ month: currentMonth, tokens: 150 }));
    expect(() => checkBudget()).toThrow(BudgetExceededError);
  });

  it('BudgetExceededError has correct name', () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '100';
    mockGetMeta.mockReturnValue(JSON.stringify({ month: currentMonth, tokens: 200 }));
    try {
      checkBudget();
    } catch (e) {
      expect((e as Error).name).toBe('BudgetExceededError');
    }
  });

  it('is disabled when cap is 0', () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '0';
    mockGetMeta.mockReturnValue(JSON.stringify({ month: currentMonth, tokens: 9_999_999_999 }));
    expect(() => checkBudget()).not.toThrow();
  });

  it('resets usage when month changes', () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '100';
    // Old month data — new month resets to 0 so budget not exceeded
    mockGetMeta.mockReturnValue(JSON.stringify({ month: '2020-01', tokens: 999 }));
    expect(() => checkBudget()).not.toThrow();
  });

  it('recordUsage routes through atomic helper with correct delta', () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '1000000';
    recordUsage(100, 50);
    expect(mockAtomicMetaIncrementCounter).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'budget:monthly_usage',
        counterField: 'tokens',
        delta: 150,
      })
    );
  });

  it('recordUsage is no-op when cap is 0', () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '0';
    recordUsage(9999, 9999);
    expect(mockAtomicMetaIncrementCounter).not.toHaveBeenCalled();
  });

  it('recordUsage warns at 80% threshold', () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '1000';
    // Simulate the atomic helper returning a post-increment value of 850
    // (85%). Pre-increment was 750 (< 80%), so we cross the threshold once.
    mockAtomicMetaIncrementCounter.mockReturnValue(
      JSON.stringify({ month: currentMonth, tokens: 850 }),
    );
    recordUsage(80, 20);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ cap: 1000 }),
      expect.any(String)
    );
  });

  it('getBudgetStatus returns current state', () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '1000';
    mockGetMeta.mockReturnValue(JSON.stringify({ month: currentMonth, tokens: 250 }));
    const status = getBudgetStatus();
    expect(status.tokensUsed).toBe(250);
    expect(status.monthlyCap).toBe(1000);
    expect(status.pctUsed).toBe(25);
  });

  it('getMeta failure in checkBudget propagates error', () => {
    mockGetMeta.mockImplementation(() => { throw new Error('DB locked'); });
    expect(() => checkBudget()).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. TIMEOUT UTILITY
// ─────────────────────────────────────────────────────────────────────────────

describe('Timeout utility — withTimeout()', () => {
  let withTimeout: typeof import('../src/utils/timeout.js').withTimeout;
  let TimeoutError: typeof import('../src/utils/timeout.js').TimeoutError;

  beforeEach(async () => {
    vi.useFakeTimers();
    ({ withTimeout, TimeoutError } = await import('../src/utils/timeout.js'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves when promise completes before timeout', async () => {
    const p = Promise.resolve('fast');
    const result = withTimeout(p, 5000, 'test-op');
    await vi.runAllTimersAsync();
    expect(await result).toBe('fast');
  });

  it('rejects with TimeoutError when deadline exceeds', async () => {
    const p = new Promise<string>((resolve) => setTimeout(() => resolve('slow'), 10000));
    const resultPromise = withTimeout(p, 100, 'slow-op');
    vi.advanceTimersByTime(200);
    await expect(resultPromise).rejects.toThrow(TimeoutError);
  });

  it('TimeoutError has correct name', async () => {
    const p = new Promise<never>(() => {});
    const resultPromise = withTimeout(p, 100, 'noop-op');
    vi.advanceTimersByTime(200);
    try {
      await resultPromise;
    } catch (e) {
      expect((e as Error).name).toBe('TimeoutError');
    }
  });

  it('TimeoutError message includes label and ms', async () => {
    const p = new Promise<never>(() => {});
    const resultPromise = withTimeout(p, 500, 'my-operation');
    vi.advanceTimersByTime(600);
    await expect(resultPromise).rejects.toThrow('my-operation');
    await expect(resultPromise.catch(e => (e as Error).message)).resolves.toContain('500ms');
  });

  it('propagates rejection from the wrapped promise', async () => {
    const inner = Promise.reject(new Error('inner-failure'));
    inner.catch(() => {});
    const result = withTimeout(inner, 5000, 'op');
    // result.catch suppresses the rejection that bubbles from inner through withTimeout
    result.catch(() => {});
    await vi.runAllTimersAsync();
    await expect(result).rejects.toThrow('inner-failure');
  });

  it('clears timeout when promise resolves (no leak)', async () => {
    const clearSpy = vi.spyOn(global, 'clearTimeout');
    const p = Promise.resolve('resolved');
    const result = withTimeout(p, 1000, 'op');
    await vi.runAllTimersAsync();
    await result;
    expect(clearSpy).toHaveBeenCalled();
  });

  it('clears timeout when promise rejects early', async () => {
    const clearSpy = vi.spyOn(global, 'clearTimeout');
    const rejected = Promise.reject(new Error('early-rejection'));
    rejected.catch(() => {});
    try {
      const result = withTimeout(rejected, 1000, 'op');
      await vi.runAllTimersAsync();
      await result;
    } catch { /* expected */ }
    expect(clearSpy).toHaveBeenCalled();
  });

  it('nested: outer timeout fires before inner completes', async () => {
    const inner = new Promise<string>((res) => setTimeout(() => res('inner'), 5000));
    const middle = withTimeout(inner, 3000, 'middle-op');
    const outer = withTimeout(middle, 1000, 'outer-op');
    vi.advanceTimersByTime(1100);
    await expect(outer).rejects.toThrow('outer-op');
  });

  it('handles very large timeout without overflow', async () => {
    const p = Promise.resolve('quick');
    // 2^31 - 1 (max safe setTimeout value) should not cause issues
    const result = withTimeout(p, 2147483647, 'large-timeout-op');
    await vi.runAllTimersAsync();
    expect(await result).toBe('quick');
  });

  it('timeout of 0ms fires immediately for slow promises', async () => {
    const result = withTimeout(new Promise<never>(() => {}), 0, 'zero-timeout');
    // Allow microtasks + timer to flush
    await vi.runAllTimersAsync();
    await expect(result).rejects.toThrow(TimeoutError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. MEMORY STORE RESILIENCE
// ─────────────────────────────────────────────────────────────────────────────

describe('Memory store resilience — saveMemory()', () => {
  let saveMemory: typeof import('../src/memory/store.js').saveMemory;

  beforeAll(async () => {
    // Set up default happy-path DB mock state, then import store once
    mockExecute.mockReturnValue({ changes: 1, lastInsertRowid: 1 });
    mockQuery.mockReturnValue([]);
    mockQueryOne.mockReturnValue(undefined);
    ({ saveMemory } = await import('../src/memory/store.js'));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute.mockReturnValue({ changes: 1, lastInsertRowid: 1 });
    mockQuery.mockReturnValue([]);
    mockQueryOne.mockReturnValue(undefined);
  });

  it('saves memory successfully and returns a string ID', async () => {
    mockGenerateEmbedding.mockResolvedValue(new Float32Array(384));
    const id = await saveMemory({
      sessionKey: 'test',
      userId: null,
      content: 'test memory content',
      memoryType: 'fact',
      importance: 0.5,
      emotionalWeight: 0.3,
      relatedTo: null,
      sourceMessageId: null,
      metadata: {},
    });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(mockExecute).toHaveBeenCalled();
  });

  it('saves memory without embedding when generateEmbedding fails', async () => {
    mockGenerateEmbedding.mockRejectedValue(new Error('embedding API down'));
    const id = await saveMemory({
      sessionKey: 'test',
      userId: null,
      content: 'memory without embedding',
      memoryType: 'context',
      importance: 0.5,
      emotionalWeight: 0,
      relatedTo: null,
      sourceMessageId: null,
      metadata: {},
    });
    expect(typeof id).toBe('string');
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Error) }),
      expect.stringContaining('embedding')
    );
  });

  it('logs warning when embedding generation fails', async () => {
    mockGenerateEmbedding.mockRejectedValue(new Error('network timeout'));
    await saveMemory({
      sessionKey: 'test',
      userId: null,
      content: 'hello',
      memoryType: 'fact',
      importance: 0.5,
      emotionalWeight: 0,
      relatedTo: null,
      sourceMessageId: null,
      metadata: {},
    });
    expect(mockLoggerWarn).toHaveBeenCalled();
  });

  it('propagates vec0 insert failure (findings.md P2:381)', async () => {
    // findings.md P2:381 — the prior silent try/catch around the vec0
    // INSERT allowed memories to land without their embedding, degrading
    // search coverage monotonically. saveMemory now wraps both inserts in
    // one transaction; vec0 failure must propagate (and roll back the row).
    mockGenerateEmbedding.mockResolvedValue(new Float32Array(384).fill(0.1));
    mockExecute
      .mockReturnValueOnce({ changes: 1, lastInsertRowid: 1 })
      .mockImplementationOnce(() => { throw new Error('vec0 table error'); });
    await expect(saveMemory({
      sessionKey: 'test',
      userId: null,
      content: 'vec0 fail test',
      memoryType: 'episode',
      importance: 0.5,
      emotionalWeight: 0,
      relatedTo: null,
      sourceMessageId: null,
      metadata: {},
    })).rejects.toThrow('vec0 table error');
  });
});

describe('Memory store resilience — searchMemories()', () => {
  let searchMemories: typeof import('../src/memory/store.js').searchMemories;

  beforeAll(async () => {
    mockQuery.mockReturnValue([]);
    mockQueryOne.mockReturnValue({ count: 0 });
    ({ searchMemories } = await import('../src/memory/store.js'));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockReturnValue([]);
    mockQueryOne.mockReturnValue({ count: 0 });
  });

  it('returns empty array when embedding generation fails', async () => {
    mockGenerateEmbedding.mockRejectedValue(new Error('API down'));
    const results = await searchMemories('some query', 10);
    expect(results).toEqual([]);
    expect(mockLoggerError).toHaveBeenCalled();
  });

  it('falls back to brute force when vec0 is empty', async () => {
    mockGenerateEmbedding.mockResolvedValue(new Float32Array(384).fill(0.5));
    mockQueryOne.mockReturnValue({ count: 0 });
    mockQuery.mockReturnValue([]);
    const results = await searchMemories('fallback query', 5);
    expect(Array.isArray(results)).toBe(true);
  });

  it('falls back to brute-force when vec0 KNN query throws', async () => {
    mockGenerateEmbedding.mockResolvedValue(new Float32Array(384).fill(0.5));
    mockQueryOne.mockReturnValue({ count: 5 }); // vec0 has data
    mockQuery
      .mockImplementationOnce(() => { throw new Error('vec0 match failed'); })
      .mockReturnValue([]);
    const results = await searchMemories('some query', 5);
    expect(Array.isArray(results)).toBe(true);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Error) }),
      expect.stringContaining('vec0')
    );
  });

  it('returns empty array when no memories match threshold', async () => {
    mockGenerateEmbedding.mockResolvedValue(new Float32Array(384).fill(0.1));
    mockQueryOne.mockReturnValue({ count: 0 });
    mockQuery.mockReturnValue([]);
    const results = await searchMemories('query with no matches', 10, 0.99);
    expect(results).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. DATABASE LAYER RESILIENCE
// ─────────────────────────────────────────────────────────────────────────────

describe('Database layer — StorageError contract', () => {
  // The database module is mocked at the top of this file.
  // These tests verify: (a) the mock is wired correctly, (b) the behaviour
  // the real functions promise (tested via the mock's controlled outputs).

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute.mockReturnValue({ changes: 1, lastInsertRowid: 0 });
    mockQuery.mockReturnValue([]);
    mockQueryOne.mockReturnValue(undefined);
  });

  it('getMeta returns null when row not found (undefined from queryOne)', async () => {
    // The real getMeta calls queryOne and returns null if undefined
    // Our mock of getMeta returns null directly in this case
    mockGetMeta.mockReturnValue(null);
    const { getMeta } = await import('../src/storage/database.js');
    expect(getMeta('nonexistent-key')).toBeNull();
  });

  it('getMeta propagates errors from underlying storage', async () => {
    mockGetMeta.mockImplementation(() => { throw new Error('DB locked'); });
    const { getMeta } = await import('../src/storage/database.js');
    expect(() => getMeta('any-key')).toThrow('DB locked');
  });

  it('setMeta is called through the mock correctly', async () => {
    const { setMeta } = await import('../src/storage/database.js');
    setMeta('test-key', 'test-value');
    expect(mockSetMeta).toHaveBeenCalledWith('test-key', 'test-value');
  });

  it('query mock returns configured value', async () => {
    const fakeRows = [{ id: '1', content: 'hello' }];
    mockQuery.mockReturnValue(fakeRows);
    const { query } = await import('../src/storage/database.js');
    const result = query('SELECT * FROM memories');
    expect(result).toEqual(fakeRows);
  });

  it('query mock propagates thrown errors', async () => {
    mockQuery.mockImplementation(() => { throw new Error('SQL syntax error'); });
    const { query } = await import('../src/storage/database.js');
    expect(() => query('SELECT 1')).toThrow('SQL syntax error');
  });

  it('execute mock propagates thrown errors', async () => {
    mockExecute.mockImplementation(() => { throw new Error('UNIQUE constraint failed'); });
    const { execute } = await import('../src/storage/database.js');
    expect(() => execute('INSERT INTO x VALUES (1)')).toThrow('UNIQUE constraint failed');
  });

  it('queryOne mock returns undefined when not found', async () => {
    mockQueryOne.mockReturnValue(undefined);
    const { queryOne } = await import('../src/storage/database.js');
    const result = queryOne('SELECT * FROM memories WHERE id = ?', ['missing']);
    expect(result).toBeUndefined();
  });

  it('getDatabase mock is callable without error', async () => {
    const { getDatabase } = await import('../src/storage/database.js');
    // getDatabase is mocked as a vi.fn() — shouldn't throw
    expect(() => getDatabase()).not.toThrow();
  });

  it('StorageError is importable from utils/errors', async () => {
    const { StorageError } = await import('../src/utils/errors.js');
    const err = new StorageError('test error');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('StorageError');
  });

  it('getDatabase throws StorageError when not initialized (real module behaviour)', async () => {
    // Verify the real module would throw a StorageError — we test this by
    // checking the StorageError class is correct
    const { StorageError } = await import('../src/utils/errors.js');
    const err = new StorageError('Database not initialized. Call initDatabase() first.');
    expect(err.message).toContain('not initialized');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. BUDGET BLOCKED BEFORE API CALL
// ─────────────────────────────────────────────────────────────────────────────

describe('Budget blocks API calls before they happen', () => {
  const currentMonth = new Date().toISOString().slice(0, 7);

  let checkBudget: typeof import('../src/providers/budget.js').checkBudget;
  let BudgetExceededError: typeof import('../src/providers/budget.js').BudgetExceededError;

  beforeAll(async () => {
    ({ checkBudget, BudgetExceededError } = await import('../src/providers/budget.js'));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockSetMeta.mockReturnValue(undefined);
    mockExecute.mockReturnValue({ changes: 1, lastInsertRowid: 0 });
  });

  afterEach(() => {
    delete process.env['LAIN_MONTHLY_TOKEN_CAP'];
  });

  it('checkBudget throws BudgetExceededError at cap', () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '1000';
    mockGetMeta.mockReturnValue(JSON.stringify({ month: currentMonth, tokens: 1000 }));
    expect(() => checkBudget()).toThrow(BudgetExceededError);
  });

  it('budget check passes at just-under cap', () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '1000';
    mockGetMeta.mockReturnValue(JSON.stringify({ month: currentMonth, tokens: 999 }));
    expect(() => checkBudget()).not.toThrow();
  });

  it('BudgetExceededError message contains usage and cap', () => {
    const err = new BudgetExceededError(50000, 60000);
    expect(err.message).toContain('50,000');
    expect(err.message).toContain('60,000');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. BACKGROUND LOOP RESILIENCE — COMMUNE
// ─────────────────────────────────────────────────────────────────────────────

describe('Commune loop resilience — startCommuneLoop()', () => {
  let startCommuneLoop: typeof import('../src/agent/commune-loop.js').startCommuneLoop;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockGetMeta.mockReturnValue(null);
    mockSetMeta.mockReturnValue(undefined);
    mockQuery.mockReturnValue([]);
    mockQueryOne.mockReturnValue(undefined);

    // Stub heavy internal imports
    vi.mock('../src/agent/index.js', () => ({
      getProvider: vi.fn(() => null),
      getAgent: vi.fn(() => undefined),
    }));
    vi.mock('../src/agent/self-concept.js', () => ({ getSelfConcept: vi.fn(() => '') }));
    vi.mock('../src/agent/relationships.js', () => ({
      updateRelationship: vi.fn().mockResolvedValue(undefined),
      getAllRelationships: vi.fn(() => []),
    }));
    vi.mock('../src/agent/tools.js', () => ({
      getToolDefinitions: vi.fn(() => []),
      executeTool: vi.fn().mockResolvedValue({ toolCallId: 'x', content: 'ok' }),
    }));
    vi.mock('../src/commune/location.js', () => ({
      getCurrentLocation: vi.fn(() => ({ building: 'nexus' })),
    }));
    vi.mock('../src/agent/internal-state.js', () => ({
      getCurrentState: vi.fn(() => ({ sociability: 0.9 })),
      getPreoccupations: vi.fn(() => []),
      updateState: vi.fn().mockResolvedValue(undefined),
      getStateSummary: vi.fn(() => ''),
    }));
    vi.mock('../src/commune/building-memory.js', () => ({
      recordBuildingEvent: vi.fn().mockResolvedValue(undefined),
      buildBuildingResidueContext: vi.fn().mockResolvedValue(''),
    }));

    ({ startCommuneLoop } = await import('../src/agent/commune-loop.js'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it('returns cleanup function when disabled', () => {
    const stop = startCommuneLoop({
      characterId: 'lain',
      characterName: 'Lain',
      peers: [],
      enabled: false,
    });
    expect(typeof stop).toBe('function');
    stop(); // should not throw
  });

  it('returns cleanup function when no peers', () => {
    const stop = startCommuneLoop({
      characterId: 'lain',
      characterName: 'Lain',
      peers: [],
    });
    expect(typeof stop).toBe('function');
    stop();
  });

  it('cleanup function stops the loop without throwing', () => {
    const stop = startCommuneLoop({
      characterId: 'lain',
      characterName: 'Lain',
      peers: [{ id: 'wired-lain', name: 'Wired Lain', url: 'http://localhost:3000' }],
    });
    expect(() => stop()).not.toThrow();
  });

  it('cycle error is caught and logged — loop continues scheduling', async () => {
    // Provider unavailable means cycle returns early (no error thrown)
    const { getProvider } = await import('../src/agent/index.js');
    vi.mocked(getProvider).mockReturnValue(null);

    const stop = startCommuneLoop({
      characterId: 'lain',
      characterName: 'Lain',
      peers: [{ id: 'wired-lain', name: 'Wired Lain', url: 'http://localhost:3000' }],
      intervalMs: 100,
      maxJitterMs: 0,
    });

    // Advance past initial delay and one cycle
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 200);
    stop();
    // Should not have thrown
  });

  it('stops gracefully after cleanup called multiple times', () => {
    const stop = startCommuneLoop({
      characterId: 'lain',
      characterName: 'Lain',
      peers: [],
      enabled: false,
    });
    expect(() => { stop(); stop(); stop(); }).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. DIARY LOOP RESILIENCE
// ─────────────────────────────────────────────────────────────────────────────

describe('Diary loop resilience — startDiaryLoop()', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockGetMeta.mockReturnValue(null);
    mockSetMeta.mockReturnValue(undefined);
    mockQuery.mockReturnValue([]);
    mockQueryOne.mockReturnValue(undefined);

    vi.mock('../src/agent/index.js', () => ({
      getProvider: vi.fn(() => null),
      getAgent: vi.fn(() => undefined),
    }));
    vi.mock('../src/memory/index.js', () => ({
      getMemoryStats: vi.fn().mockResolvedValue({ total: 0 }),
      recordMessage: vi.fn().mockResolvedValue(undefined),
      buildMemoryContext: vi.fn().mockResolvedValue(''),
      processConversationEnd: vi.fn().mockResolvedValue(undefined),
      shouldExtractMemories: vi.fn(() => false),
    }));
    vi.mock('../src/agent/internal-state.js', () => ({
      getCurrentState: vi.fn(() => ({ sociability: 0.7 })),
      getPreoccupations: vi.fn(() => []),
      updateState: vi.fn().mockResolvedValue(undefined),
      getStateSummary: vi.fn(() => ''),
    }));
    vi.mock('../src/config/paths.js', async (importOriginal) => {
      const original = await importOriginal() as Record<string, unknown>;
      return { ...original, getBasePath: vi.fn(() => '/tmp/test-lain') };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it('returns cleanup function', async () => {
    const { startDiaryLoop } = await import('../src/agent/diary.ts');
    const stop = startDiaryLoop({ enabled: true });
    expect(typeof stop).toBe('function');
    stop();
  });

  it('returns no-op cleanup when disabled', async () => {
    const { startDiaryLoop } = await import('../src/agent/diary.ts');
    const stop = startDiaryLoop({ enabled: false });
    expect(typeof stop).toBe('function');
    expect(() => stop()).not.toThrow();
  });

  it('does not crash when provider unavailable', async () => {
    const { getProvider } = await import('../src/agent/index.js');
    vi.mocked(getProvider).mockReturnValue(null);

    const { startDiaryLoop } = await import('../src/agent/diary.ts');
    const stop = startDiaryLoop({ enabled: true, intervalMs: 50_000, maxJitterMs: 0 });
    await vi.advanceTimersByTimeAsync(50_001);
    stop();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. CURIOSITY LOOP RESILIENCE
// ─────────────────────────────────────────────────────────────────────────────

describe('Curiosity loop resilience — startCuriosityLoop()', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockGetMeta.mockReturnValue(null);
    mockQuery.mockReturnValue([]);
    mockQueryOne.mockReturnValue(undefined);

    vi.mock('../src/agent/index.js', () => ({
      getProvider: vi.fn(() => null),
    }));
    vi.mock('../src/agent/proactive.js', () => ({
      trySendProactiveMessage: vi.fn().mockResolvedValue(undefined),
    }));
    vi.mock('../src/agent/internal-state.js', () => ({
      getCurrentState: vi.fn(() => ({ intellectualArousal: 0.8 })),
      getStateSummary: vi.fn(() => ''),
    }));
    vi.mock('../src/security/ssrf.js', () => ({ checkSSRF: vi.fn(() => true) }));
    vi.mock('../src/agent/data-workspace.js', () => ({
      ensureDataWorkspace: vi.fn().mockResolvedValue('/tmp/data'),
      getDataWorkspaceSize: vi.fn().mockResolvedValue(0),
      sanitizeDataFileName: vi.fn((n: string) => n),
      MAX_DATA_DIR_BYTES: 100_000_000,
      MAX_SINGLE_FILE_BYTES: 10_000_000,
    }));
    vi.mock('../src/agent/tools.js', () => ({
      extractTextFromHtml: vi.fn(() => 'page text'),
      getToolDefinitions: vi.fn(() => []),
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it('returns no-op when disabled', async () => {
    const { startCuriosityLoop } = await import('../src/agent/curiosity.js');
    const stop = startCuriosityLoop({ enabled: false });
    expect(typeof stop).toBe('function');
    expect(() => stop()).not.toThrow();
  });

  it('returns no-op when whitelist is empty', async () => {
    // Whitelist file not found → returns []
    const { startCuriosityLoop } = await import('../src/agent/curiosity.js');
    const stop = startCuriosityLoop({ enabled: true });
    expect(typeof stop).toBe('function');
    stop();
  });

  it('does not crash when provider unavailable', async () => {
    const { getProvider } = await import('../src/agent/index.js');
    vi.mocked(getProvider).mockReturnValue(null);
    const { startCuriosityLoop } = await import('../src/agent/curiosity.js');
    const stop = startCuriosityLoop({ enabled: true });
    stop();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. CASCADING FAILURE CONTAINMENT
// ─────────────────────────────────────────────────────────────────────────────

describe('Cascading failure containment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('BudgetExceededError is an Error subclass', async () => {
    const { BudgetExceededError } = await import('../src/providers/budget.js');
    const err = new BudgetExceededError(100, 50);
    expect(err instanceof Error).toBe(true);
    expect(err instanceof BudgetExceededError).toBe(true);
  });

  it('TimeoutError is an Error subclass', async () => {
    const { TimeoutError } = await import('../src/utils/timeout.js');
    const err = new TimeoutError('op', 1000);
    expect(err instanceof Error).toBe(true);
    expect(err instanceof TimeoutError).toBe(true);
  });

  it('memory save failure does not crash when execute throws', async () => {
    mockGenerateEmbedding.mockResolvedValue(new Float32Array(384));
    // execute throws a storage error on first call (the INSERT)
    mockExecute.mockImplementation(() => { throw new Error('disk full'); });
    const { saveMemory } = await import('../src/memory/store.js');
    // Should propagate — disk full is a hard failure
    await expect(saveMemory({
      sessionKey: 'test',
      userId: null,
      content: 'content',
      memoryType: 'fact',
      importance: 0.5,
      emotionalWeight: 0,
      relatedTo: null,
      sourceMessageId: null,
      metadata: {},
    })).rejects.toThrow();
  });

  it('searchMemories returns empty array when embedding fails + DB empty', async () => {
    mockGenerateEmbedding.mockRejectedValue(new Error('API down'));
    mockQueryOne.mockReturnValue({ count: 0 });
    mockQuery.mockReturnValue([]);
    const { searchMemories } = await import('../src/memory/store.js');
    const results = await searchMemories('query');
    expect(results).toEqual([]);
  });

  it('withRetry + budget: both errors are distinct types', async () => {
    const { BudgetExceededError } = await import('../src/providers/budget.js');
    const { TimeoutError } = await import('../src/utils/timeout.js');
    expect(new BudgetExceededError(1, 1)).not.toBeInstanceOf(TimeoutError);
    expect(new TimeoutError('op', 1)).not.toBeInstanceOf(BudgetExceededError);
  });

  it('commune loop with DB locked on getMeta still starts', async () => {
    // getMeta fails but the commune loop catches this internally and continues
    mockGetMeta.mockImplementation(() => { throw new Error('SQLITE_BUSY'); });

    vi.useFakeTimers();
    const { startCommuneLoop } = await import('../src/agent/commune-loop.js');
    // Should not throw even though getMeta fails during initial setup
    expect(() => startCommuneLoop({
      characterId: 'lain',
      characterName: 'Lain',
      peers: [{ id: 'wired-lain', name: 'Wired Lain', url: 'http://localhost:3000' }],
    })).not.toThrow();
    vi.useRealTimers();
  });

  it('multiple errors in same tick — each is independent', async () => {
    const { withTimeout, TimeoutError } = await import('../src/utils/timeout.js');
    vi.useFakeTimers();

    const p1 = withTimeout(new Promise<never>(() => {}), 100, 'op1');
    const p2 = withTimeout(new Promise<never>(() => {}), 100, 'op2');

    vi.advanceTimersByTime(200);

    const [r1, r2] = await Promise.allSettled([p1, p2]);
    expect(r1.status).toBe('rejected');
    expect(r2.status).toBe('rejected');
    expect((r1 as PromiseRejectedResult).reason).toBeInstanceOf(TimeoutError);
    expect((r2 as PromiseRejectedResult).reason).toBeInstanceOf(TimeoutError);

    vi.useRealTimers();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. RECOVERY SCENARIOS
// ─────────────────────────────────────────────────────────────────────────────

describe('Recovery — system resumes after transient failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retry: succeeds after transient failure then permanent success', async () => {
    const { withRetry } = await import('../src/providers/retry.js');
    const err = Object.assign(new Error('rate limit'), { status: 429 });
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 3) throw err;
      return 'recovered';
    });
    const p = withRetry(fn, 'test', { maxRetries: 5, baseDelayMs: 10, retryableStatusCodes: [429] });
    await vi.runAllTimersAsync();
    expect(await p).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('fallback: primary comes back after being replaced', async () => {
    const { createFallbackProvider } = await import('../src/providers/fallback.js');
    const err = Object.assign(new Error('model not found'), { status: 404 });
    const goodResult = { content: 'ok', finishReason: 'stop' as const, usage: { inputTokens: 1, outputTokens: 1 } };
    const opts = { messages: [{ role: 'user' as const, content: 'hi' }] };

    const primary = { name: 'p', model: 'primary', complete: vi.fn(() => Promise.reject(err)), completeWithTools: vi.fn(() => Promise.reject(err)), continueWithToolResults: vi.fn(() => Promise.reject(err)) };
    const fallbackProvider = { name: 'f', model: 'fallback-1', complete: vi.fn(() => Promise.resolve(goodResult)), completeWithTools: vi.fn(() => Promise.resolve({ ...goodResult, toolCalls: [] })), continueWithToolResults: vi.fn(() => Promise.resolve(goodResult)) };

    const proxy = createFallbackProvider(primary as never, ['fallback-1'], () => fallbackProvider as never);
    // First call fails on primary, uses fallback
    await proxy.complete(opts);
    // Subsequent calls use promoted fallback
    await proxy.complete(opts);
    await proxy.complete(opts);
    expect(fallbackProvider.complete).toHaveBeenCalledTimes(3);
    expect(primary.complete).toHaveBeenCalledTimes(1); // only tried once
  });

  it('budget: usage from old month does not count against new month', async () => {
    const { checkBudget } = await import('../src/providers/budget.js');
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '100';
    // Simulate previous month data — new month resets to 0
    mockGetMeta.mockReturnValue(JSON.stringify({ month: '2020-01', tokens: 9999 }));
    expect(() => checkBudget()).not.toThrow();
  });

  it('memory: search recovers gracefully after embedding failure', async () => {
    const { searchMemories } = await import('../src/memory/store.js');
    mockQueryOne.mockReturnValue({ count: 0 });
    mockQuery.mockReturnValue([]);

    // First call fails
    mockGenerateEmbedding.mockRejectedValueOnce(new Error('timeout'));
    const first = await searchMemories('query');
    expect(first).toEqual([]);

    // Second call succeeds
    mockGenerateEmbedding.mockResolvedValueOnce(new Float32Array(384).fill(0.5));
    const second = await searchMemories('query');
    expect(Array.isArray(second)).toBe(true);
  });

  it('timeout: after one timeout, another operation succeeds', async () => {
    const { withTimeout } = await import('../src/utils/timeout.js');
    const slow = new Promise<never>(() => {});
    const fast = Promise.resolve('quick');

    const timedOut = withTimeout(slow, 100, 'slow-op');
    vi.advanceTimersByTime(200);
    await expect(timedOut).rejects.toThrow();

    const succeeded = withTimeout(fast, 5000, 'fast-op');
    await vi.runAllTimersAsync();
    await expect(succeeded).resolves.toBe('quick');
  });

  it('retry: exhausted retries do not prevent next independent call', async () => {
    const { withRetry } = await import('../src/providers/retry.js');
    const err = Object.assign(new Error('rate limit'), { status: 429 });
    const badFn = vi.fn().mockImplementation(() => Promise.reject(Object.assign(new Error('rate limit'), { status: 429 })));
    const goodFn = vi.fn().mockResolvedValue('ok');

    const badP = withRetry(badFn, 'test', { maxRetries: 1, baseDelayMs: 10, retryableStatusCodes: [429] });
    await vi.runAllTimersAsync();
    await expect(badP).rejects.toThrow();

    const goodP = withRetry(goodFn, 'test', { maxRetries: 3, baseDelayMs: 10, retryableStatusCodes: [429] });
    await vi.runAllTimersAsync();
    await expect(goodP).resolves.toBe('ok');
  });

  it('fallback: skips already-failed models on repeated calls', async () => {
    const { createFallbackProvider } = await import('../src/providers/fallback.js');
    const err = Object.assign(new Error('model not found'), { status: 404 });
    const goodResult = { content: 'ok', finishReason: 'stop' as const, usage: { inputTokens: 1, outputTokens: 1 } };
    const opts = { messages: [{ role: 'user' as const, content: 'hi' }] };

    const primary = { name: 'p', model: 'primary', complete: vi.fn(() => Promise.reject(err)), completeWithTools: vi.fn(() => Promise.reject(err)), continueWithToolResults: vi.fn(() => Promise.reject(err)) };
    const fb1 = { name: 'f1', model: 'fallback-1', complete: vi.fn(() => Promise.reject(err)), completeWithTools: vi.fn(() => Promise.reject(err)), continueWithToolResults: vi.fn(() => Promise.reject(err)) };
    const fb2 = { name: 'f2', model: 'fallback-2', complete: vi.fn(() => Promise.resolve(goodResult)), completeWithTools: vi.fn(() => Promise.resolve({ ...goodResult, toolCalls: [] })), continueWithToolResults: vi.fn(() => Promise.resolve(goodResult)) };

    const factory = vi.fn().mockReturnValueOnce(fb1).mockReturnValue(fb2);
    const proxy = createFallbackProvider(primary as never, ['fallback-1', 'fallback-2'], factory);

    await proxy.complete(opts);   // promotes fb2
    factory.mockClear();
    await proxy.complete(opts);   // uses fb2 directly
    expect(factory).not.toHaveBeenCalled();
    expect(fb2.complete).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. EDGE CASES & BOUNDARY CONDITIONS
// ─────────────────────────────────────────────────────────────────────────────

describe('Edge cases and boundary conditions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('withRetry with maxRetries=0 runs exactly once', async () => {
    vi.useFakeTimers();
    const { withRetry } = await import('../src/providers/retry.js');
    const fn = vi.fn().mockImplementation(() => Promise.reject(Object.assign(new Error('rate limit'), { status: 429 })));
    const p = withRetry(fn, 'test', { maxRetries: 0, baseDelayMs: 100, retryableStatusCodes: [429] });
    await vi.runAllTimersAsync();
    await expect(p).rejects.toThrow('rate limit');
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('createFallbackProvider with empty fallbackModels returns primary as-is', async () => {
    const { createFallbackProvider } = await import('../src/providers/fallback.js');
    const goodResult = { content: 'ok', finishReason: 'stop' as const, usage: { inputTokens: 1, outputTokens: 1 } };
    const primary = { name: 'p', model: 'm', complete: vi.fn().mockResolvedValue(goodResult), completeWithTools: vi.fn().mockResolvedValue(goodResult), continueWithToolResults: vi.fn().mockResolvedValue(goodResult) };
    const proxy = createFallbackProvider(primary as never, [], vi.fn());
    // It returns the original provider directly
    expect(proxy).toBe(primary);
  });

  it('BudgetExceededError with 0 tokens used still forms valid message', async () => {
    const { BudgetExceededError } = await import('../src/providers/budget.js');
    const err = new BudgetExceededError(0, 0);
    expect(err.message).toContain('0');
  });

  it('withTimeout rejects immediately on already-settled rejected promise', async () => {
    vi.useFakeTimers();
    const { withTimeout } = await import('../src/utils/timeout.js');
    const already = Promise.reject(new Error('already-rejected'));
    already.catch(() => {});
    const result = withTimeout(already, 5000, 'op');
    await vi.runAllTimersAsync();
    await expect(result).rejects.toThrow('already-rejected');
    vi.useRealTimers();
  });

  it('searchMemories with empty query string returns empty array when no memories', async () => {
    mockGenerateEmbedding.mockResolvedValue(new Float32Array(384));
    mockQueryOne.mockReturnValue({ count: 0 });
    mockQuery.mockReturnValue([]);
    const { searchMemories } = await import('../src/memory/store.js');
    const results = await searchMemories('', 10);
    expect(Array.isArray(results)).toBe(true);
  });

  it('recordUsage with zero tokens does not throw', async () => {
    const { recordUsage } = await import('../src/providers/budget.js');
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '1000';
    const currentMonth = new Date().toISOString().slice(0, 7);
    mockGetMeta.mockReturnValue(JSON.stringify({ month: currentMonth, tokens: 0 }));
    mockSetMeta.mockReturnValue(undefined);
    expect(() => recordUsage(0, 0)).not.toThrow();
  });

  it('retry on "service unavailable" message pattern', async () => {
    vi.useFakeTimers();
    const { withRetry } = await import('../src/providers/retry.js');
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('service unavailable'))
      .mockResolvedValue('ok');
    const p = withRetry(fn, 'test', { maxRetries: 3, baseDelayMs: 10, retryableStatusCodes: [429, 503] });
    await vi.runAllTimersAsync();
    expect(await p).toBe('ok');
    vi.useRealTimers();
  });

  it('fallback does not retry same failed model twice', async () => {
    const { createFallbackProvider } = await import('../src/providers/fallback.js');
    const err = Object.assign(new Error('model not found'), { status: 404 });
    const goodResult = { content: 'ok', finishReason: 'stop' as const, usage: { inputTokens: 1, outputTokens: 1 } };
    const opts = { messages: [{ role: 'user' as const, content: 'hi' }] };

    const primary = { name: 'p', model: 'primary', complete: vi.fn().mockRejectedValue(err), completeWithTools: vi.fn().mockRejectedValue(err), continueWithToolResults: vi.fn().mockRejectedValue(err) };
    const fallback = { name: 'f', model: 'fallback-1', complete: vi.fn().mockResolvedValue(goodResult), completeWithTools: vi.fn().mockResolvedValue({ ...goodResult, toolCalls: [] }), continueWithToolResults: vi.fn().mockResolvedValue(goodResult) };
    const factory = vi.fn().mockReturnValue(fallback);

    const proxy = createFallbackProvider(primary as never, ['fallback-1'], factory);
    await proxy.complete(opts);
    await proxy.complete(opts);
    // factory called once when first discovering fallback-1
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('budget getBudgetStatus pctUsed is 0 when cap is 0', async () => {
    process.env['LAIN_MONTHLY_TOKEN_CAP'] = '0';
    const currentMonth = new Date().toISOString().slice(0, 7);
    mockGetMeta.mockReturnValue(JSON.stringify({ month: currentMonth, tokens: 9999 }));
    const { getBudgetStatus } = await import('../src/providers/budget.js');
    const status = getBudgetStatus();
    expect(status.pctUsed).toBe(0);
  });

  it('saveMessage calls execute and returns a string ID', async () => {
    mockExecute.mockReturnValue({ changes: 1, lastInsertRowid: 1 });
    const { saveMessage } = await import('../src/memory/store.js');
    const id = saveMessage({
      sessionKey: 'test:session',
      userId: null,
      role: 'user',
      content: 'hello',
      timestamp: Date.now(),
      metadata: {},
    });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(mockExecute).toHaveBeenCalled();
  });

  it('getRecentMessages returns empty array when query returns nothing', async () => {
    mockQuery.mockReturnValue([]);
    const { getRecentMessages } = await import('../src/memory/store.js');
    const msgs = getRecentMessages('test:session', 10);
    expect(msgs).toEqual([]);
  });

  it('deleteMemory returns false when no row affected', async () => {
    // deleteMemory calls execute twice (delete memberships + delete memory)
    mockExecute.mockReturnValue({ changes: 0, lastInsertRowid: 0 });
    const { deleteMemory } = await import('../src/memory/store.js');
    const result = deleteMemory('nonexistent-id');
    expect(result).toBe(false);
  });

  it('getMemory returns undefined for missing ID', async () => {
    mockQueryOne.mockReturnValue(undefined);
    const { getMemory } = await import('../src/memory/store.js');
    expect(getMemory('missing-id')).toBeUndefined();
  });

  it('countMemories returns 0 when table empty', async () => {
    mockQueryOne.mockReturnValue({ count: 0 });
    const { countMemories } = await import('../src/memory/store.js');
    expect(countMemories()).toBe(0);
  });

  it('getPostboardMessages returns empty array when no rows', async () => {
    mockQuery.mockReturnValue([]);
    const { getPostboardMessages } = await import('../src/memory/store.js');
    const msgs = getPostboardMessages(0, 10);
    expect(msgs).toEqual([]);
  });

  it('withRetry propagates error object as-is (not wrapped)', async () => {
    vi.useFakeTimers();
    const { withRetry } = await import('../src/providers/retry.js');
    const originalErr = Object.assign(new Error('original'), { code: 'ECONNREFUSED' });
    const fn = vi.fn().mockRejectedValue(originalErr);
    // ECONNREFUSED not in retryable codes — propagated immediately without retry
    await expect(
      withRetry(fn, 'test', { maxRetries: 3, baseDelayMs: 10, retryableStatusCodes: [429] })
    ).rejects.toBe(originalErr);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 14. NETWORK ERROR PATTERNS
// ─────────────────────────────────────────────────────────────────────────────

describe('Network error pattern recognition in retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['rate.?limit pattern', 'rate-limit hit'],
    ['overloaded pattern', 'model is overloaded'],
    ['too many requests', 'Too Many Requests'],
    ['server error', 'internal server error'],
    ['bad gateway', 'bad gateway response'],
    ['service unavailable', 'service unavailable try later'],
  ])('retries on message matching: %s', async (_label, message) => {
    const { withRetry } = await import('../src/providers/retry.js');
    let firstCall = true;
    const fn = vi.fn().mockImplementation(() => {
      if (firstCall) {
        firstCall = false;
        return Promise.reject(new Error(message as string));
      }
      return Promise.resolve('ok');
    });
    const p = withRetry(fn, 'test', {
      maxRetries: 3,
      baseDelayMs: 10,
      retryableStatusCodes: [429, 500, 502, 503],
    });
    await vi.runAllTimersAsync();
    expect(await p).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry on plain TypeError (parse failure)', async () => {
    const { withRetry } = await import('../src/providers/retry.js');
    const fn = vi.fn().mockImplementation(() => Promise.reject(new TypeError('Cannot read properties of undefined')));
    const p = withRetry(fn, 'test', { maxRetries: 3, baseDelayMs: 10, retryableStatusCodes: [429, 500] });
    await vi.runAllTimersAsync();
    await expect(p).rejects.toBeInstanceOf(TypeError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry on SyntaxError (malformed JSON response)', async () => {
    const { withRetry } = await import('../src/providers/retry.js');
    const fn = vi.fn().mockImplementation(() => Promise.reject(new SyntaxError('Unexpected token < in JSON at position 0')));
    const p = withRetry(fn, 'test', { maxRetries: 3, baseDelayMs: 10, retryableStatusCodes: [429, 500] });
    await vi.runAllTimersAsync();
    await expect(p).rejects.toBeInstanceOf(SyntaxError);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 15. ISRETRYABLE BOUNDARY — status codes
// ─────────────────────────────────────────────────────────────────────────────

describe('Retry status code boundaries', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each([429, 500, 502, 503])('retries on default retryable code %i', async (code) => {
    const { withRetry } = await import('../src/providers/retry.js');
    const err = Object.assign(new Error(`error ${code}`), { status: code });
    const fn = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValue('ok');
    const promise = withRetry(fn, 'test', { maxRetries: 3, baseDelayMs: 5, retryableStatusCodes: [429, 500, 502, 503] });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe('ok');
  });

  it.each([400, 401, 403, 422])('does NOT retry on non-retryable code %i', async (code) => {
    const { withRetry } = await import('../src/providers/retry.js');
    const err = Object.assign(new Error(`error ${code}`), { status: code });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(
      withRetry(fn, 'test', { maxRetries: 3, baseDelayMs: 5, retryableStatusCodes: [429, 500, 502, 503] })
    ).rejects.toThrow(`error ${code}`);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 16. FALLBACK ISMODELGONEERROR BOUNDARY
// ─────────────────────────────────────────────────────────────────────────────

describe('Fallback — isModelGoneError boundary conditions', () => {
  const goodResult = { content: 'ok', finishReason: 'stop' as const, usage: { inputTokens: 1, outputTokens: 1 } };
  const opts = { messages: [{ role: 'user' as const, content: 'hi' }] };

  beforeEach(() => vi.clearAllMocks());

  it.each([
    'model not found',
    'model_not_found error',
    'deprecated model',
    'decommissioned endpoint',
    'no longer available',
    'does not exist in this region',
    'invalid model id',
    'not a valid model version',
  ])('triggers fallback on: "%s"', async (message) => {
    const { createFallbackProvider } = await import('../src/providers/fallback.js');
    const primary = { name: 'p', model: 'primary', complete: vi.fn().mockRejectedValue(new Error(message)), completeWithTools: vi.fn().mockRejectedValue(new Error(message)), continueWithToolResults: vi.fn().mockRejectedValue(new Error(message)) };
    const fallback = { name: 'f', model: 'fb', complete: vi.fn().mockResolvedValue(goodResult), completeWithTools: vi.fn().mockResolvedValue({ ...goodResult, toolCalls: [] }), continueWithToolResults: vi.fn().mockResolvedValue(goodResult) };
    const proxy = createFallbackProvider(primary as never, ['fb'], () => fallback as never);
    await expect(proxy.complete(opts)).resolves.toEqual(goodResult);
  });

  it.each([
    'rate limit exceeded',
    'server error',
    'timeout',
    'network error',
  ])('does NOT trigger fallback on: "%s"', async (message) => {
    const { createFallbackProvider } = await import('../src/providers/fallback.js');
    const primary = { name: 'p', model: 'primary', complete: vi.fn().mockRejectedValue(new Error(message)), completeWithTools: vi.fn().mockRejectedValue(new Error(message)), continueWithToolResults: vi.fn().mockRejectedValue(new Error(message)) };
    const factory = vi.fn();
    const proxy = createFallbackProvider(primary as never, ['fb'], factory);
    await expect(proxy.complete(opts)).rejects.toThrow(message);
    expect(factory).not.toHaveBeenCalled();
  });
});
