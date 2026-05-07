import { getMeta, setMeta } from '../storage/database.js';
import { getLogger } from '../utils/logger.js';
import { eventBus } from '../events/bus.js';
import type { InternalState } from '../agent/internal-state.js';
import { getInterlinkHeaders } from '../security/interlink-auth.js';

export interface Weather {
  condition: 'clear' | 'overcast' | 'rain' | 'fog' | 'storm' | 'aurora';
  intensity: number;
  description: string;
  computed_at: number;
}

const META_KEY_WEATHER = 'weather:current';

export function getCurrentWeather(): Weather | null {
  try {
    const raw = getMeta(META_KEY_WEATHER);
    if (raw) {
      const parsed = JSON.parse(raw) as Weather;
      if (parsed.condition) return parsed;
    }
  } catch { /* fall through */ }
  return null;
}

function saveWeather(weather: Weather): void {
  setMeta(META_KEY_WEATHER, JSON.stringify(weather));
}

function computeCondition(avgState: {
  energy: number;
  sociability: number;
  intellectual_arousal: number;
  emotional_weight: number;
  valence: number;
}): { condition: Weather['condition']; intensity: number } {
  if (avgState.emotional_weight > 0.7 && avgState.intellectual_arousal > 0.6) {
    return { condition: 'storm', intensity: Math.min(1, (avgState.emotional_weight + avgState.intellectual_arousal) / 2) };
  }
  if (avgState.intellectual_arousal > 0.7 && avgState.valence > 0.7) {
    return { condition: 'aurora', intensity: Math.min(1, (avgState.intellectual_arousal + avgState.valence) / 2) };
  }
  if (avgState.emotional_weight > 0.6) {
    return { condition: 'rain', intensity: avgState.emotional_weight };
  }
  if (avgState.energy < 0.35) {
    return { condition: 'fog', intensity: 1 - avgState.energy };
  }
  if (avgState.valence > 0.6 && avgState.emotional_weight < 0.4) {
    return { condition: 'clear', intensity: avgState.valence };
  }
  return { condition: 'overcast', intensity: 0.5 };
}

export async function computeWeather(states: InternalState[]): Promise<Weather> {
  const logger = getLogger();

  if (states.length === 0) {
    return { condition: 'overcast', intensity: 0.5, description: 'quiet day in the town', computed_at: Date.now() };
  }

  const avg = {
    energy: states.reduce((s, st) => s + st.energy, 0) / states.length,
    sociability: states.reduce((s, st) => s + st.sociability, 0) / states.length,
    intellectual_arousal: states.reduce((s, st) => s + st.intellectual_arousal, 0) / states.length,
    emotional_weight: states.reduce((s, st) => s + st.emotional_weight, 0) / states.length,
    valence: states.reduce((s, st) => s + st.valence, 0) / states.length,
  };

  const { condition, intensity } = computeCondition(avg);

  let description = `${condition} weather over the town`;
  try {
    const { getProvider } = await import('../agent/index.js');
    const provider = getProvider('default', 'light');
    if (provider) {
      const result = await provider.complete({
        messages: [{
          role: 'user',
          content: `The collective mood of a small town's inhabitants is: average energy ${avg.energy.toFixed(2)}, emotional weight ${avg.emotional_weight.toFixed(2)}, intellectual arousal ${avg.intellectual_arousal.toFixed(2)}, valence ${avg.valence.toFixed(2)}. The weather condition is "${condition}" (intensity ${intensity.toFixed(2)}). Write a single poetic sentence describing this weather as if it reflects the town's inner state. No explanation, just the sentence.`,
        }],
        maxTokens: 150,
        temperature: 0.9,
      });
      const trimmed = result.content.trim();
      if (trimmed.length > 10) description = trimmed;
    }
  } catch (err) {
    logger.debug({ error: String(err) }, 'Weather description LLM failed, using default');
  }

  return { condition, intensity, description, computed_at: Date.now() };
}

/**
 * findings.md P2:1520 — weather effects are now scaled by intensity.
 *
 * `computeCondition` produces both `condition` and `intensity ∈ [0,1]`,
 * but `getWeatherEffect` used to return a static per-condition delta
 * map regardless of intensity — so a storm at 1.0 and a storm at 0.1
 * applied identical pressure on internal state. `intensity` defaults
 * to 1 for back-compatibility with callers/tests that don't care.
 */
export function getWeatherEffect(condition: string, intensity = 1): Partial<InternalState> {
  const base: Record<string, Partial<InternalState>> = {
    storm: { energy: -0.04, intellectual_arousal: 0.03 },
    rain: { emotional_weight: 0.03, sociability: -0.02 },
    fog: { energy: -0.03, valence: -0.01 },
    aurora: { energy: 0.04, valence: 0.04, sociability: 0.03 },
    clear: { energy: 0.02 },
    overcast: {},
  };
  const effect = base[condition];
  if (!effect) return {};
  const scale = Math.max(0, Math.min(1, intensity));
  const scaled: Partial<InternalState> = {};
  for (const [k, v] of Object.entries(effect) as Array<[keyof InternalState, number]>) {
    (scaled as Record<string, number>)[k] = v * scale;
  }
  return scaled;
}

/**
 * findings.md P2:1505 — Wired Lain is the town's shared-state authority.
 *
 * The weather loop only runs on WL (see startWeatherLoop below, wired up
 * in src/web/server.ts behind `isWired`). Other character processes
 * previously had two partial access paths: `internal-state.ts` read
 * `weather:current` from its own meta table (always null → no weather
 * effects on mortals), and `agent/index.ts` had an inline fallback that
 * fired a fresh GET to WL on every prompt build (uncached).
 *
 * The helpers below are the canonical client-side accessor:
 *   - `getTownWeather()` — async; fetches from WL with 60s fresh TTL and
 *     30min stale-grace during WL outages.
 *   - `peekCachedTownWeather()` — sync; returns last cached value. On WL
 *     itself, short-circuits to the local meta read.
 *   - `startTownWeatherRefreshLoop()` — non-WL processes start this at
 *     boot to warm the cache so synchronous consumers have data.
 */
const TOWN_WEATHER_CACHE_TTL_MS = 60_000;
const TOWN_WEATHER_STALE_GRACE_MS = 30 * 60_000;
const TOWN_WEATHER_REFRESH_INTERVAL_MS = 5 * 60_000;
const TOWN_WEATHER_FETCH_TIMEOUT_MS = 3000;

interface TownWeatherCache {
  weather: Weather | null;
  fetchedAt: number;
}
let townWeatherCache: TownWeatherCache | null = null;
let townWeatherCacheHits = 0;
let townWeatherCacheMisses = 0;
let townWeatherCacheStaleServes = 0;

function isWiredLain(): boolean {
  return process.env['LAIN_CHARACTER_ID'] === 'wired-lain';
}

export async function getTownWeather(): Promise<Weather | null> {
  if (isWiredLain()) {
    return getCurrentWeather();
  }
  const now = Date.now();
  if (townWeatherCache && now - townWeatherCache.fetchedAt < TOWN_WEATHER_CACHE_TTL_MS) {
    townWeatherCacheHits++;
    return townWeatherCache.weather;
  }
  townWeatherCacheMisses++;
  const wiredUrl = process.env['WIRED_LAIN_URL'] || 'http://localhost:3000';
  try {
    const resp = await fetch(`${wiredUrl}/api/weather`, {
      signal: AbortSignal.timeout(TOWN_WEATHER_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json() as Weather;
    townWeatherCache = { weather: data, fetchedAt: now };
    return data;
  } catch {
    if (
      townWeatherCache &&
      now - townWeatherCache.fetchedAt < TOWN_WEATHER_CACHE_TTL_MS + TOWN_WEATHER_STALE_GRACE_MS
    ) {
      townWeatherCacheStaleServes++;
      return townWeatherCache.weather;
    }
    return null;
  }
}

export function peekCachedTownWeather(): Weather | null {
  if (isWiredLain()) {
    return getCurrentWeather();
  }
  if (!townWeatherCache) return null;
  const age = Date.now() - townWeatherCache.fetchedAt;
  if (age > TOWN_WEATHER_CACHE_TTL_MS + TOWN_WEATHER_STALE_GRACE_MS) return null;
  return townWeatherCache.weather;
}

export function getTownWeatherHealth(): {
  cacheHits: number;
  cacheMisses: number;
  cacheStaleServes: number;
  cachedAt: number | null;
} {
  return {
    cacheHits: townWeatherCacheHits,
    cacheMisses: townWeatherCacheMisses,
    cacheStaleServes: townWeatherCacheStaleServes,
    cachedAt: townWeatherCache?.fetchedAt ?? null,
  };
}

/**
 * Periodically warm the town-weather cache so synchronous consumers
 * (internal-state.ts decay tick) have data on hand. WL short-circuits to
 * local meta and the timer is a no-op, but we still arm it for uniformity.
 */
export function startTownWeatherRefreshLoop(intervalMs = TOWN_WEATHER_REFRESH_INTERVAL_MS): () => void {
  const logger = getLogger();
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await getTownWeather();
    } catch (err) {
      logger.debug({ err }, 'town-weather refresh tick failed (non-critical)');
    }
  };
  void tick();
  const timer = setInterval(() => { void tick(); }, intervalMs);
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

interface PeerStateResponse {
  characterId: string;
  state: InternalState | null;
}

async function fetchAllPeerStates(): Promise<InternalState[]> {
  const headers = getInterlinkHeaders();
  const peerConfigRaw = process.env['PEER_CONFIG'];
  if (!peerConfigRaw || !headers) return [];

  const peers = JSON.parse(peerConfigRaw) as Array<{ id: string; url: string }>;
  const states: InternalState[] = [];

  try {
    const { getCurrentState } = await import('../agent/internal-state.js');
    states.push(getCurrentState());
  } catch { /* skip */ }

  await Promise.all(peers.map(async (peer) => {
    try {
      const resp = await fetch(`${peer.url}/api/internal-state`, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        const data = await resp.json() as PeerStateResponse;
        if (data.state) states.push(data.state);
      }
    } catch { /* peer unreachable */ }
  }));

  return states;
}

export function startWeatherLoop(): () => void {
  const logger = getLogger();
  const INTERVAL_MS = 4 * 60 * 60 * 1000;
  const MAX_JITTER_MS = 30 * 60 * 1000;

  logger.info('Starting weather computation loop (every 4h)');

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function getInitialDelay(): number {
    try {
      const lastRun = getMeta('weather:last_computed_at');
      if (lastRun) {
        const elapsed = Date.now() - parseInt(lastRun, 10);
        const remaining = INTERVAL_MS - elapsed;
        if (remaining > 0) return remaining;
        return Math.random() * 2 * 60 * 1000;
      }
    } catch { /* fall through */ }
    return 5 * 60 * 1000 + Math.random() * 5 * 60 * 1000;
  }

  function scheduleNext(delay?: number): void {
    if (stopped) return;
    const d = delay ?? INTERVAL_MS + Math.random() * MAX_JITTER_MS;

    timer = setTimeout(async () => {
      if (stopped) return;
      try {
        const states = await fetchAllPeerStates();
        const previous = getCurrentWeather();
        const weather = await computeWeather(states);
        saveWeather(weather);
        setMeta('weather:last_computed_at', Date.now().toString());

        if (previous?.condition !== weather.condition) {
          eventBus.emitActivity({
            type: 'weather',
            sessionKey: `weather:${weather.condition}`,
            content: `Weather changed to ${weather.condition}: ${weather.description}`,
            timestamp: Date.now(),
          });
        }

        logger.info({ condition: weather.condition, intensity: weather.intensity }, 'Weather computed');
      } catch (err) {
        logger.error({ error: String(err) }, 'Weather computation failed');
      }
      scheduleNext();
    }, d);
  }

  scheduleNext(getInitialDelay());

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    logger.info('Weather loop stopped');
  };
}
