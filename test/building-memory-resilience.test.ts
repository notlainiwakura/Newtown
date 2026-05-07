/**
 * findings.md P2:1500 — building-memory write-behind queue + read cache.
 *
 * These tests cover the outage-resilience behavior added for the
 * WL-as-authority architectural commitment: writes buffer into a bounded
 * FIFO, drain async, retry on WL outage; reads cache per (building, hours)
 * with a fresh TTL and longer stale-grace TTL used only when WL is
 * unreachable.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const TOKEN = 'test-master-token';

async function freshModule(): Promise<typeof import('../src/commune/building-memory.js')> {
  vi.resetModules();
  return await import('../src/commune/building-memory.js');
}

describe('building-memory resilience (findings.md P2:1500)', () => {
  let prevToken: string | undefined;
  let prevCharId: string | undefined;
  let prevUrl: string | undefined;

  beforeEach(() => {
    prevToken = process.env['LAIN_INTERLINK_TOKEN'];
    prevCharId = process.env['LAIN_CHARACTER_ID'];
    prevUrl = process.env['WIRED_LAIN_URL'];
    process.env['LAIN_INTERLINK_TOKEN'] = TOKEN;
    process.env['LAIN_CHARACTER_ID'] = 'test-char';
    process.env['WIRED_LAIN_URL'] = 'http://test-wl.invalid';
  });

  afterEach(() => {
    if (prevToken === undefined) delete process.env['LAIN_INTERLINK_TOKEN'];
    else process.env['LAIN_INTERLINK_TOKEN'] = prevToken;
    if (prevCharId === undefined) delete process.env['LAIN_CHARACTER_ID'];
    else process.env['LAIN_CHARACTER_ID'] = prevCharId;
    if (prevUrl === undefined) delete process.env['WIRED_LAIN_URL'];
    else process.env['WIRED_LAIN_URL'] = prevUrl;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('recordBuildingEvent returns before the POST completes (enqueue-and-return)', async () => {
    // Fetch that never resolves — if recordBuildingEvent awaited the POST,
    // the call would hang until the AbortSignal timeout.
    const neverResolves = new Promise<Response>(() => { /* pending forever */ });
    vi.stubGlobal('fetch', vi.fn(() => neverResolves));

    const mod = await freshModule();
    const started = Date.now();
    await mod.recordBuildingEvent({
      building: 'library', event_type: 'arrival',
      summary: 'test', emotional_tone: 0, actors: ['other-char'],
    });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(100);
    expect(mod.getBuildingMemoryHealth().queueDepth).toBe(1);
  });

  it('drains queued events in FIFO order on successful POST', async () => {
    const posted: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
      if (init?.body) posted.push(JSON.parse(init.body).summary);
      return new Response(null, { status: 204 });
    }));

    const mod = await freshModule();
    for (const n of ['first', 'second', 'third']) {
      await mod.recordBuildingEvent({
        building: 'library', event_type: 'arrival',
        summary: n, emotional_tone: 0, actors: ['other'],
      });
    }
    await vi.waitFor(() => expect(mod.getBuildingMemoryHealth().queueDepth).toBe(0));
    expect(posted).toEqual(['first', 'second', 'third']);
    expect(mod.getBuildingMemoryHealth().totalSuccesses).toBe(3);
  });

  it('drops the oldest event when the queue is at capacity', async () => {
    const neverResolves = new Promise<Response>(() => {});
    vi.stubGlobal('fetch', vi.fn(() => neverResolves));

    const mod = await freshModule();
    for (let i = 0; i < 510; i++) {
      await mod.recordBuildingEvent({
        building: 'library', event_type: 'arrival',
        summary: `e${i}`, emotional_tone: 0, actors: ['other'],
      });
    }
    const h = mod.getBuildingMemoryHealth();
    expect(h.queueDepth).toBe(500);
    expect(h.queueDropped).toBe(10);
  });

  it('pauses drain and retries via timer when WL returns errors', async () => {
    vi.useFakeTimers();
    let fail = true;
    const fetchMock = vi.fn(async () => {
      if (fail) return new Response('err', { status: 503 });
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const mod = await freshModule();
    await mod.recordBuildingEvent({
      building: 'library', event_type: 'arrival',
      summary: 'retried', emotional_tone: 0, actors: ['other'],
    });

    // Let the initial drain run and fail. Yield microtasks.
    await vi.waitFor(() => expect(mod.getBuildingMemoryHealth().totalFailures).toBeGreaterThanOrEqual(1));
    expect(mod.getBuildingMemoryHealth().queueDepth).toBe(1);

    // WL comes back. Advance the retry timer — drain should pick up.
    fail = false;
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(mod.getBuildingMemoryHealth().queueDepth).toBe(0));
    expect(mod.getBuildingMemoryHealth().totalSuccesses).toBe(1);
  });

  it('serves fresh cache without a second network call', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify([{
        id: 'x', building: 'library', event_type: 'arrival',
        summary: 'cached', emotional_tone: 0, actors: ['peer'],
        created_at: Date.now(),
      }]), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const mod = await freshModule();
    // buildBuildingResidueContext is the public surface that reads residue.
    // Call it twice back-to-back — second should hit cache.
    await mod.buildBuildingResidueContext('reader-char');
    await mod.buildBuildingResidueContext('reader-char');
    // One GET to WL (then the cached hit on the second call).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const h = mod.getBuildingMemoryHealth();
    expect(h.cacheHits).toBeGreaterThanOrEqual(1);
    expect(h.cacheMisses).toBeGreaterThanOrEqual(1);
  });

  it('serves stale cache when WL is unreachable within grace window', async () => {
    vi.useFakeTimers();
    let fail = false;
    const fetchMock = vi.fn(async () => {
      if (fail) throw new Error('ECONNREFUSED');
      return new Response(JSON.stringify([{
        id: 'x', building: 'library', event_type: 'arrival',
        summary: 'atmospheric', emotional_tone: 0, actors: ['peer'],
        created_at: Date.now(),
      }]), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const mod = await freshModule();
    const firstCtx = await mod.buildBuildingResidueContext('reader-char');
    expect(firstCtx).toContain('atmospheric');

    // Advance past fresh TTL (60s) so the next call re-fetches.
    vi.advanceTimersByTime(120_000);
    fail = true;

    const staleCtx = await mod.buildBuildingResidueContext('reader-char');
    expect(staleCtx).toContain('atmospheric');
    expect(mod.getBuildingMemoryHealth().cacheStaleServes).toBeGreaterThanOrEqual(1);
  });

  it('gives up on cache after stale-grace window expires', async () => {
    vi.useFakeTimers();
    let fail = false;
    const fetchMock = vi.fn(async () => {
      if (fail) throw new Error('ECONNREFUSED');
      return new Response(JSON.stringify([{
        id: 'x', building: 'library', event_type: 'arrival',
        summary: 'atmospheric', emotional_tone: 0, actors: ['peer'],
        created_at: Date.now(),
      }]), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const mod = await freshModule();
    await mod.buildBuildingResidueContext('reader-char');

    // Advance past fresh TTL + stale grace (60s + 30min).
    vi.advanceTimersByTime(2 * 60 * 60 * 1000);
    fail = true;

    const ctx = await mod.buildBuildingResidueContext('reader-char');
    // With cache expired and WL unreachable, context is empty.
    expect(ctx).toBe('');
  });

  it('exposes queue + cache metrics via getBuildingMemoryHealth', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    const mod = await freshModule();
    const h = mod.getBuildingMemoryHealth();
    expect(h).toHaveProperty('queueDepth');
    expect(h).toHaveProperty('queueDropped');
    expect(h).toHaveProperty('cacheHits');
    expect(h).toHaveProperty('cacheMisses');
    expect(h).toHaveProperty('cacheStaleServes');
    expect(h).toHaveProperty('failureStreak');
    expect(h).toHaveProperty('totalFailures');
    expect(h).toHaveProperty('totalSuccesses');
  });
});
