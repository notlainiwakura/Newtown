import { getMeta, setMeta } from '../storage/database.js';
import { getLogger } from '../utils/logger.js';
import { eventBus } from '../events/bus.js';
import type { InternalState } from '../agent/internal-state.js';

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

export function getWeatherEffect(condition: string): Partial<InternalState> {
  const effects: Record<string, Partial<InternalState>> = {
    storm: { energy: -0.04, intellectual_arousal: 0.03 },
    rain: { emotional_weight: 0.03, sociability: -0.02 },
    fog: { energy: -0.03, valence: -0.01 },
    aurora: { energy: 0.04, valence: 0.04, sociability: 0.03 },
    clear: { energy: 0.02 },
    overcast: {},
  };
  return effects[condition] ?? {};
}

interface PeerStateResponse {
  characterId: string;
  state: InternalState | null;
}

async function fetchAllPeerStates(): Promise<InternalState[]> {
  const token = process.env['LAIN_INTERLINK_TOKEN'] || '';
  const peerConfigRaw = process.env['PEER_CONFIG'];
  if (!peerConfigRaw) return [];

  const peers = JSON.parse(peerConfigRaw) as Array<{ id: string; url: string }>;
  const states: InternalState[] = [];

  try {
    const { getCurrentState } = await import('../agent/internal-state.js');
    states.push(getCurrentState());
  } catch { /* skip */ }

  await Promise.all(peers.map(async (peer) => {
    try {
      const resp = await fetch(`${peer.url}/api/internal-state`, {
        headers: { 'Authorization': `Bearer ${token}` },
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
