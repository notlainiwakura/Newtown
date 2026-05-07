/**
 * Behavioural tests for src/memory/embeddings.ts
 *
 * Covers:
 *  - findings.md P2:467 — remote embedding calls must send the API
 *    key via `Authorization: Bearer` (not a URL query parameter).
 *  - findings.md P2:477 — a rejected first-load of the local
 *    embedding pipeline must not poison the module singleton; the
 *    next call has to be able to retry.
 *
 * EMBEDDING_SERVICE_URL and LAIN_WEB_API_KEY are read at import time,
 * so each test uses `vi.resetModules()` + a dynamic import to get a
 * fresh module bound to the env it cares about.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ORIG_URL = process.env['EMBEDDING_SERVICE_URL'];
const ORIG_KEY = process.env['LAIN_WEB_API_KEY'];
const ORIG_FETCH = globalThis.fetch;

function restoreEnv() {
  if (ORIG_URL === undefined) delete process.env['EMBEDDING_SERVICE_URL'];
  else process.env['EMBEDDING_SERVICE_URL'] = ORIG_URL;
  if (ORIG_KEY === undefined) delete process.env['LAIN_WEB_API_KEY'];
  else process.env['LAIN_WEB_API_KEY'] = ORIG_KEY;
}

describe('findings.md P2:467 — embedding service uses Authorization: Bearer, never URL query', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    globalThis.fetch = ORIG_FETCH;
    restoreEnv();
    vi.resetModules();
  });

  it('single-text remote call sends Bearer header and no ?key= in URL', async () => {
    process.env['EMBEDDING_SERVICE_URL'] = 'https://example.test/embed';
    process.env['LAIN_WEB_API_KEY'] = 'secret-token-xyz';

    let capturedUrl: string | URL | Request | undefined;
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    const mod = await import('../src/memory/embeddings.js');
    const out = await mod.generateEmbedding('hello world');

    expect(out).toBeInstanceOf(Float32Array);
    expect(typeof capturedUrl === 'string' ? capturedUrl : String(capturedUrl)).toBe(
      'https://example.test/embed'
    );
    // No query parameter key leakage.
    expect(String(capturedUrl)).not.toMatch(/[?&]key=/);
    const headers = (capturedInit?.headers ?? {}) as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer secret-token-xyz');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('batch remote call sends Bearer header and no ?key= in URL', async () => {
    process.env['EMBEDDING_SERVICE_URL'] = 'https://example.test/embed';
    process.env['LAIN_WEB_API_KEY'] = 'batch-secret';

    let capturedUrl: string | URL | Request | undefined;
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(
        JSON.stringify({ embeddings: [[0.1], [0.2]] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof globalThis.fetch;

    const mod = await import('../src/memory/embeddings.js');
    const out = await mod.generateEmbeddings(['a', 'b']);
    expect(out).toHaveLength(2);
    expect(String(capturedUrl)).not.toMatch(/[?&]key=/);
    const headers = (capturedInit?.headers ?? {}) as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer batch-secret');
  });

  it('omits Authorization header when LAIN_WEB_API_KEY is empty', async () => {
    process.env['EMBEDDING_SERVICE_URL'] = 'https://example.test/embed';
    delete process.env['LAIN_WEB_API_KEY'];

    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedInit = init;
      return new Response(JSON.stringify({ embeddings: [[0]] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    const mod = await import('../src/memory/embeddings.js');
    await mod.generateEmbedding('x');
    const headers = (capturedInit?.headers ?? {}) as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
    // Content-Type is still set.
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('static source check: no `?key=` URL-suffix on fetch calls', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(
      new URL('../src/memory/embeddings.ts', import.meta.url),
      'utf-8'
    );
    // Guard against regression: the previous implementation appended
    // `?key=${EMBEDDING_SERVICE_KEY}` to the URL. Fail if any such
    // construction reappears.
    expect(src).not.toMatch(/[?&]key=\$\{/);
    expect(src).toMatch(/Authorization.*Bearer/);
  });
});

describe('findings.md P2:505 — embedding inputs longer than MiniLM budget emit a warn log', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    globalThis.fetch = ORIG_FETCH;
    restoreEnv();
    vi.resetModules();
    vi.doUnmock('../src/utils/logger.js');
  });

  function installLoggerSpy() {
    const warn = vi.fn();
    vi.doMock('../src/utils/logger.js', () => ({
      getLogger: () => ({
        warn,
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      }),
    }));
    return warn;
  }

  it('exports EMBEDDING_CHAR_BUDGET and isLikelyTruncated with coherent semantics', async () => {
    const mod = await import('../src/memory/embeddings.js');
    expect(mod.EMBEDDING_CHAR_BUDGET).toBeGreaterThan(0);
    expect(mod.isLikelyTruncated('x')).toBe(false);
    expect(mod.isLikelyTruncated('x'.repeat(mod.EMBEDDING_CHAR_BUDGET))).toBe(false);
    expect(mod.isLikelyTruncated('x'.repeat(mod.EMBEDDING_CHAR_BUDGET + 1))).toBe(true);
  });

  it('remote single-text: long input triggers a warn log with length + budget', async () => {
    process.env['EMBEDDING_SERVICE_URL'] = 'https://example.test/embed';
    process.env['LAIN_WEB_API_KEY'] = 'k';
    const warn = installLoggerSpy();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ embeddings: [[0.1]] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof globalThis.fetch;

    const mod = await import('../src/memory/embeddings.js');
    const longText = 'a'.repeat(mod.EMBEDDING_CHAR_BUDGET + 500);
    await mod.generateEmbedding(longText);

    expect(warn).toHaveBeenCalledTimes(1);
    const [logFields] = warn.mock.calls[0]!;
    expect(logFields).toMatchObject({
      charLength: longText.length,
      budget: mod.EMBEDDING_CHAR_BUDGET,
    });
    expect(String(logFields.context)).toContain('remote');
  });

  it('remote batch: warns once per oversize text, not for short ones', async () => {
    process.env['EMBEDDING_SERVICE_URL'] = 'https://example.test/embed';
    process.env['LAIN_WEB_API_KEY'] = 'k';
    const warn = installLoggerSpy();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ embeddings: [[0], [0], [0]] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof globalThis.fetch;

    const mod = await import('../src/memory/embeddings.js');
    const short = 'ok';
    const long = 'a'.repeat(mod.EMBEDDING_CHAR_BUDGET + 1);
    await mod.generateEmbeddings([short, long, long]);

    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('short input does not trigger a warn log', async () => {
    process.env['EMBEDDING_SERVICE_URL'] = 'https://example.test/embed';
    process.env['LAIN_WEB_API_KEY'] = 'k';
    const warn = installLoggerSpy();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ embeddings: [[0]] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof globalThis.fetch;

    const mod = await import('../src/memory/embeddings.js');
    await mod.generateEmbedding('hello world');
    expect(warn).not.toHaveBeenCalled();
  });

  it('local single-text path also warns when input exceeds budget', async () => {
    delete process.env['EMBEDDING_SERVICE_URL'];
    const warn = installLoggerSpy();
    vi.doMock('@xenova/transformers', () => ({
      pipeline: vi.fn(async () => async (_text: string, _opts: unknown) => ({
        data: new Float32Array([0.1, 0.2]),
      })),
    }));

    const mod = await import('../src/memory/embeddings.js');
    const longText = 'a'.repeat(mod.EMBEDDING_CHAR_BUDGET + 50);
    await mod.generateEmbedding(longText);
    expect(warn).toHaveBeenCalledTimes(1);
    const [logFields] = warn.mock.calls[0]!;
    expect(String(logFields.context)).toContain('local');
  });
});

describe('findings.md P2:477 — embedding pipeline self-heals after a rejected load', () => {
  beforeEach(() => {
    vi.resetModules();
    // Remote mode short-circuits the local pipeline code path, so we
    // must ensure it's off for these tests.
    delete process.env['EMBEDDING_SERVICE_URL'];
  });
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('@xenova/transformers');
    restoreEnv();
  });

  it('first pipeline() rejection clears loadPromise; next call retries and succeeds', async () => {
    let calls = 0;
    const fakePipe = Object.assign(
      async (_text: string, _opts: unknown) => ({ data: new Float32Array([0.5, 0.5]) }),
      {}
    );
    vi.doMock('@xenova/transformers', () => ({
      pipeline: vi.fn(async () => {
        calls++;
        if (calls === 1) throw new Error('CDN glitch: model download failed');
        return fakePipe;
      }),
    }));

    const mod = await import('../src/memory/embeddings.js');

    // First call must reject.
    await expect(mod.generateEmbedding('hello')).rejects.toThrow(/CDN glitch/);
    // After rejection, the module must not consider the pipeline
    // loaded, nor should it be stuck in the "loading" state.
    expect(mod.isEmbeddingModelLoaded()).toBe(false);
    expect(mod.isEmbeddingModelLoading()).toBe(false);

    // Second call should retry and succeed.
    const out = await mod.generateEmbedding('hello');
    expect(out).toBeInstanceOf(Float32Array);
    expect(calls).toBe(2);
    expect(mod.isEmbeddingModelLoaded()).toBe(true);
  });

  it('successful load is cached; pipeline() is only invoked once across many calls', async () => {
    const fakePipe = async (_text: string, _opts: unknown) => ({
      data: new Float32Array([1, 2, 3]),
    });
    const pipelineMock = vi.fn(async () => fakePipe);
    vi.doMock('@xenova/transformers', () => ({ pipeline: pipelineMock }));

    const mod = await import('../src/memory/embeddings.js');
    await mod.generateEmbedding('a');
    await mod.generateEmbedding('b');
    await mod.generateEmbedding('c');
    expect(pipelineMock).toHaveBeenCalledTimes(1);
    expect(mod.isEmbeddingModelLoaded()).toBe(true);
  });
});
