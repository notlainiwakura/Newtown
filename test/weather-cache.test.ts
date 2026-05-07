/**
 * findings.md P2:1505 — town-weather client cache.
 *
 * Non-WL characters consume weather via getTownWeather/peekCachedTownWeather
 * backed by a TTL cache + stale-grace window. WL itself short-circuits
 * to getCurrentWeather() so it's reading its own authoritative meta.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

async function freshModule(): Promise<typeof import('../src/commune/weather.js')> {
  vi.resetModules();
  return await import('../src/commune/weather.js');
}

describe('town-weather client cache (findings.md P2:1505)', () => {
  let prevCharId: string | undefined;
  let prevUrl: string | undefined;

  beforeEach(() => {
    prevCharId = process.env['LAIN_CHARACTER_ID'];
    prevUrl = process.env['WIRED_LAIN_URL'];
    process.env['LAIN_CHARACTER_ID'] = 'pkd';
    process.env['WIRED_LAIN_URL'] = 'http://test-wl.invalid';
  });

  afterEach(() => {
    if (prevCharId === undefined) delete process.env['LAIN_CHARACTER_ID'];
    else process.env['LAIN_CHARACTER_ID'] = prevCharId;
    if (prevUrl === undefined) delete process.env['WIRED_LAIN_URL'];
    else process.env['WIRED_LAIN_URL'] = prevUrl;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const wxResponse = (cond: string): Response => new Response(
    JSON.stringify({
      condition: cond, intensity: 0.7,
      description: `${cond} sky`, computed_at: Date.now(),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

  it('fetches from WL on cache miss and returns the weather', async () => {
    const fetchMock = vi.fn(async () => wxResponse('storm'));
    vi.stubGlobal('fetch', fetchMock);
    const mod = await freshModule();
    const w = await mod.getTownWeather();
    expect(w?.condition).toBe('storm');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toContain('/api/weather');
  });

  it('hits cache on a second call within fresh TTL', async () => {
    const fetchMock = vi.fn(async () => wxResponse('clear'));
    vi.stubGlobal('fetch', fetchMock);
    const mod = await freshModule();
    await mod.getTownWeather();
    await mod.getTownWeather();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mod.getTownWeatherHealth().cacheHits).toBeGreaterThanOrEqual(1);
  });

  it('serves stale cache when WL is unreachable within grace window', async () => {
    vi.useFakeTimers();
    let fail = false;
    const fetchMock = vi.fn(async () => {
      if (fail) throw new Error('ECONNREFUSED');
      return wxResponse('aurora');
    });
    vi.stubGlobal('fetch', fetchMock);
    const mod = await freshModule();
    const first = await mod.getTownWeather();
    expect(first?.condition).toBe('aurora');

    // Advance past fresh TTL (60s) but inside stale grace (30min total).
    vi.advanceTimersByTime(5 * 60_000);
    fail = true;
    const stale = await mod.getTownWeather();
    expect(stale?.condition).toBe('aurora');
    expect(mod.getTownWeatherHealth().cacheStaleServes).toBeGreaterThanOrEqual(1);
  });

  it('gives up after stale-grace expiry', async () => {
    vi.useFakeTimers();
    let fail = false;
    const fetchMock = vi.fn(async () => {
      if (fail) throw new Error('ECONNREFUSED');
      return wxResponse('fog');
    });
    vi.stubGlobal('fetch', fetchMock);
    const mod = await freshModule();
    await mod.getTownWeather();

    // Advance far past fresh TTL + stale grace.
    vi.advanceTimersByTime(2 * 60 * 60 * 1000);
    fail = true;
    const gone = await mod.getTownWeather();
    expect(gone).toBeNull();
  });

  it('peekCachedTownWeather returns last cached value without fetching', async () => {
    const fetchMock = vi.fn(async () => wxResponse('rain'));
    vi.stubGlobal('fetch', fetchMock);
    const mod = await freshModule();
    expect(mod.peekCachedTownWeather()).toBeNull(); // cold
    await mod.getTownWeather();
    const peeked = mod.peekCachedTownWeather();
    expect(peeked?.condition).toBe('rain');
    expect(fetchMock).toHaveBeenCalledTimes(1); // peek didn't fetch
  });

  it('short-circuits to getCurrentWeather() when running as wired-lain', async () => {
    process.env['LAIN_CHARACTER_ID'] = 'wired-lain';
    const fetchMock = vi.fn(async () => wxResponse('storm'));
    vi.stubGlobal('fetch', fetchMock);
    const mod = await freshModule();
    // getCurrentWeather reads from local meta; with no setup it returns null.
    // The critical behavior is that we DID NOT issue a cross-process fetch.
    await mod.getTownWeather();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('startTownWeatherRefreshLoop warms the cache on first tick', async () => {
    const fetchMock = vi.fn(async () => wxResponse('clear'));
    vi.stubGlobal('fetch', fetchMock);
    const mod = await freshModule();
    const stop = mod.startTownWeatherRefreshLoop();
    try {
      await vi.waitFor(() => expect(mod.peekCachedTownWeather()?.condition).toBe('clear'));
      expect(fetchMock).toHaveBeenCalled();
    } finally {
      stop();
    }
  });
});
