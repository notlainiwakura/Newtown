/**
 * Fallback chain for web search: DDG HTML → DDG Lite → Wikipedia API.
 *
 * Production regression: the LLM-facing `web_search` tool at src/agent/tools.ts
 * used to hit only DDG HTML. DuckDuckGo challenges cloud/datacenter IPs with
 * HTTP 202 + anomaly.js, which is not `!response.ok`, so the parser ran on the
 * challenge page, matched nothing, and the tool returned `no results found`
 * indistinguishable from a real empty search. The droplet's Wired Lain has been
 * shipping that message for every search since going live.
 *
 * These tests pin `searchWeb()` in src/utils/web-search.ts:
 *   - HTML parser extracts title/url/snippet from a live-style DDG fixture
 *   - Lite parser extracts from the DDG Lite <tr> layout
 *   - Cascade: when DDG HTML returns a 202 challenge, we fall through to Lite
 *     (not return empty)
 *   - Cascade: when both DDG tiers fail, Wikipedia JSON is parsed and returned
 *   - No tier recovers → empty array (caller formats "no results")
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const DDG_HTML_FIXTURE = `
<html><body>
  <div class="result results_links results_links_deep web-result">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="https://example.com/a">Alpha Result</a>
    </h2>
    <a class="result__snippet" href="https://example.com/a">
      The <b>alpha</b> snippet &amp; some text.
    </a>
  </div>
  <div class="result results_links results_links_deep web-result">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="https://example.com/b">Beta Result</a>
    </h2>
    <a class="result__snippet" href="https://example.com/b">
      Beta text here.
    </a>
  </div>
</body></html>
`;

const DDG_HTML_ANOMALY_FIXTURE = `
<html><body>
  <form id="anomaly-form" action="/anomaly.js">
    <input type="hidden" name="t" value="..."/>
    <noscript>Please enable JavaScript...</noscript>
  </form>
</body></html>
`;

const DDG_LITE_FIXTURE = `
<html><body>
<table>
  <tr>
    <td>1.</td>
    <td><a class="result-link" href="https://example.org/lite-a">Lite Alpha</a></td>
    <td class="result-snippet">Snippet for lite alpha here.</td>
  </tr>
  <tr>
    <td>2.</td>
    <td><a class="result-link" href="https://example.org/lite-b">Lite Beta</a></td>
    <td class="result-snippet">Snippet for lite beta.</td>
  </tr>
</table>
</body></html>
`;

const WIKIPEDIA_FIXTURE = {
  query: {
    search: [
      { title: 'Test Subject', snippet: 'A <b>test</b> article body.' },
      { title: 'Second Match', snippet: 'Another one.' },
    ],
  },
};

function mockFetchSequence(responses: Array<() => Response>): void {
  let i = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      const factory = responses[i++];
      if (!factory) throw new Error('fetch called more times than expected');
      return Promise.resolve(factory());
    }),
  );
}

function htmlResp(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html' } });
}

function jsonResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('searchWeb — fallback chain (findings.md droplet regression)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('parseDdgHtml extracts title, url, and decoded snippet', async () => {
    const { parseDdgHtml } = await import('../src/utils/web-search.js');
    const hits = parseDdgHtml(DDG_HTML_FIXTURE);
    expect(hits.length).toBe(2);
    expect(hits[0]).toMatchObject({
      title: 'Alpha Result',
      url: 'https://example.com/a',
    });
    expect(hits[0]!.snippet).toContain('alpha snippet & some text');
    expect(hits[1]!.url).toBe('https://example.com/b');
  });

  it('parseDdgLite extracts from <tr> rows', async () => {
    const { parseDdgLite } = await import('../src/utils/web-search.js');
    const hits = parseDdgLite(DDG_LITE_FIXTURE);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[0]!.title).toBe('Lite Alpha');
    expect(hits[0]!.url).toBe('https://example.org/lite-a');
    expect(hits[0]!.snippet).toBe('Snippet for lite alpha here.');
  });

  it('DDG HTML 200 with real results → returns DDG HTML hits (no cascade)', async () => {
    mockFetchSequence([() => htmlResp(200, DDG_HTML_FIXTURE)]);
    const { searchWeb } = await import('../src/utils/web-search.js');
    const hits = await searchWeb('alpha');
    expect(hits.length).toBe(2);
    expect(hits[0]!.url).toBe('https://example.com/a');
  });

  it('DDG HTML 202 anti-bot challenge → cascades to DDG Lite', async () => {
    // This is the exact bug: 202 + anomaly.js HTML was treated as success,
    // parser returned [], and the tool silently reported "no results".
    mockFetchSequence([
      () => htmlResp(202, DDG_HTML_ANOMALY_FIXTURE),
      () => htmlResp(200, DDG_LITE_FIXTURE),
    ]);
    const { searchWeb } = await import('../src/utils/web-search.js');
    const hits = await searchWeb('anything');
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[0]!.url).toBe('https://example.org/lite-a');
  });

  it('both DDG tiers empty → cascades to Wikipedia API', async () => {
    mockFetchSequence([
      () => htmlResp(202, DDG_HTML_ANOMALY_FIXTURE),
      () => htmlResp(200, '<html>no results here</html>'),
      () => jsonResp(200, WIKIPEDIA_FIXTURE),
    ]);
    const { searchWeb } = await import('../src/utils/web-search.js');
    const hits = await searchWeb('test subject');
    expect(hits.length).toBe(2);
    expect(hits[0]!.title).toBe('Test Subject');
    expect(hits[0]!.url).toBe('https://en.wikipedia.org/wiki/Test_Subject');
    expect(hits[0]!.snippet).toBe('A test article body.');
  });

  it('DDG HTML network error → still cascades (does not throw)', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValueOnce(htmlResp(200, DDG_LITE_FIXTURE)),
    );
    const { searchWeb } = await import('../src/utils/web-search.js');
    const hits = await searchWeb('x');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.url).toBe('https://example.org/lite-a');
  });

  it('every tier fails → empty array (caller formats "no results")', async () => {
    mockFetchSequence([
      () => htmlResp(500, ''),
      () => htmlResp(500, ''),
      () => htmlResp(500, ''),
    ]);
    const { searchWeb } = await import('../src/utils/web-search.js');
    const hits = await searchWeb('unknowable');
    expect(hits).toEqual([]);
  });
});
