/**
 * Internal emotional state system for Laintown characters.
 *
 * Each character maintains a six-axis emotional state that persists via the
 * meta key-value store, decays over time, gets updated by LLM after
 * significant events, and is injected into the system prompt.
 */

import { getMeta, setMeta } from '../storage/database.js';
import { getLogger } from '../utils/logger.js';
import { eventBus } from '../events/bus.js';
import { nanoid } from 'nanoid';
import type { Relationship } from './relationships.js';
import { getDefaultLocations } from '../config/characters.js';
import { peekCachedTownWeather } from '../commune/weather.js';

export interface InternalState {
  energy: number;              // 0=exhausted, 1=vibrant
  sociability: number;         // 0=withdrawn, 1=seeking company
  intellectual_arousal: number; // 0=quiet mind, 1=buzzing
  emotional_weight: number;    // 0=light, 1=heavy
  valence: number;             // 0=dark, 1=bright
  primary_color: string;       // one-word mood descriptor
  updated_at: number;
}

export interface StateEvent {
  type: string;
  summary: string;
  intensity?: number;
}

const META_KEY_STATE = 'internal:state';
const META_KEY_HISTORY = 'internal:state_history';
const HISTORY_CAP = 10;
const DECAY_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

const DEFAULT_STATE: InternalState = {
  energy: 0.6,
  sociability: 0.5,
  intellectual_arousal: 0.4,
  emotional_weight: 0.3,
  valence: 0.6,
  primary_color: 'neutral',
  updated_at: Date.now(),
};

export function clampState(state: InternalState): InternalState {
  return {
    energy: Math.max(0, Math.min(1, state.energy)),
    sociability: Math.max(0, Math.min(1, state.sociability)),
    intellectual_arousal: Math.max(0, Math.min(1, state.intellectual_arousal)),
    emotional_weight: Math.max(0, Math.min(1, state.emotional_weight)),
    valence: Math.max(0, Math.min(1, state.valence)),
    primary_color: state.primary_color,
    updated_at: state.updated_at,
  };
}

export function getCurrentState(): InternalState {
  try {
    const raw = getMeta(META_KEY_STATE);
    if (raw) {
      const parsed = JSON.parse(raw) as InternalState;
      if (typeof parsed.energy === 'number' && typeof parsed.valence === 'number') {
        return parsed;
      }
    }
  } catch { /* fall through to default */ }
  return { ...DEFAULT_STATE, updated_at: Date.now() };
}

export function saveState(state: InternalState): void {
  const clamped = clampState(state);
  clamped.updated_at = Date.now();
  setMeta(META_KEY_STATE, JSON.stringify(clamped));

  // Append to history (capped)
  const history = getStateHistory();
  history.push(clamped);
  while (history.length > HISTORY_CAP) {
    history.shift();
  }
  setMeta(META_KEY_HISTORY, JSON.stringify(history));
}

export function getStateHistory(): InternalState[] {
  try {
    const raw = getMeta(META_KEY_HISTORY);
    if (raw) {
      return JSON.parse(raw) as InternalState[];
    }
  } catch { /* fall through */ }
  return [];
}

export function applyDecay(state: InternalState): InternalState {
  return clampState({
    ...state,
    energy: state.energy - 0.02,
    intellectual_arousal: state.intellectual_arousal - 0.015,
    sociability: state.sociability - 0.02 * (state.sociability - 0.5),
    updated_at: state.updated_at,
  });
}

function describeLevel(value: number): string {
  if (value < 0.2) return 'very low';
  if (value < 0.4) return 'low';
  if (value < 0.6) return 'moderate';
  if (value < 0.8) return 'high';
  return 'very high';
}

export function getStateSummary(): string {
  const state = getCurrentState();
  const parts: string[] = [];

  parts.push(`energy is ${describeLevel(state.energy)}`);

  if (state.intellectual_arousal > 0.6) {
    parts.push('mind buzzing');
  } else if (state.intellectual_arousal < 0.3) {
    parts.push('mind quiet');
  }

  if (state.emotional_weight > 0.6) {
    parts.push('emotionally a bit heavy');
  } else if (state.emotional_weight < 0.2) {
    parts.push('emotionally light');
  }

  if (state.sociability > 0.7) {
    parts.push('wanting company');
  } else if (state.sociability < 0.3) {
    parts.push('preferring solitude');
  }

  if (state.valence < 0.3) {
    parts.push('mood is dark');
  } else if (state.valence > 0.7) {
    parts.push('mood is bright');
  }

  return `Right now you feel ${state.primary_color} — ${parts.join(', ')}.`;
}

export interface Preoccupation {
  id: string;
  thread: string;
  origin: string;
  originated_at: number;
  intensity: number;
  resolution: string | null;
}

const META_KEY_PREOCCUPATIONS = 'preoccupations:current';
const MAX_PREOCCUPATIONS = 5;

export function getPreoccupations(): Preoccupation[] {
  try {
    const raw = getMeta(META_KEY_PREOCCUPATIONS);
    if (raw) {
      const parsed = JSON.parse(raw) as Preoccupation[];
      if (Array.isArray(parsed)) return parsed.filter(p => !p.resolution);
    }
  } catch { /* fall through */ }
  return [];
}

function savePreoccupations(list: Preoccupation[]): void {
  setMeta(META_KEY_PREOCCUPATIONS, JSON.stringify(list));
}

export function addPreoccupation(thread: string, origin: string): void {
  const list = getPreoccupations();

  if (list.length >= MAX_PREOCCUPATIONS) {
    let minIdx = 0;
    for (let i = 1; i < list.length; i++) {
      if (list[i]!.intensity < list[minIdx]!.intensity) minIdx = i;
    }
    list.splice(minIdx, 1);
  }

  list.push({
    id: nanoid(8),
    thread,
    origin,
    originated_at: Date.now(),
    intensity: 0.7,
    resolution: null,
  });
  savePreoccupations(list);
}

export function resolvePreoccupation(id: string, resolution: string): void {
  const list = getPreoccupations();
  const idx = list.findIndex(p => p.id === id);
  if (idx >= 0) {
    list[idx]!.resolution = resolution;
    savePreoccupations(list.filter(p => !p.resolution));
  }
}

export function decayPreoccupations(): void {
  const list = getPreoccupations();
  const updated = list
    .map(p => ({ ...p, intensity: p.intensity - 0.05 }))
    .filter(p => p.intensity >= 0.1);
  savePreoccupations(updated);
}

const BUILDING_MOODS: Record<string, { energy: string; social: string; intellectual: string }> = {
  library:    { energy: 'low',  social: 'low',  intellectual: 'high' },
  bar:        { energy: 'mid',  social: 'high', intellectual: 'low'  },
  field:      { energy: 'any',  social: 'low',  intellectual: 'mid'  },
  windmill:   { energy: 'high', social: 'low',  intellectual: 'mid'  },
  lighthouse: { energy: 'mid',  social: 'low',  intellectual: 'high' },
  school:     { energy: 'mid',  social: 'mid',  intellectual: 'high' },
  market:     { energy: 'high', social: 'high', intellectual: 'low'  },
  locksmith:  { energy: 'mid',  social: 'low',  intellectual: 'mid'  },
  threshold:  { energy: 'low',  social: 'low',  intellectual: 'low'  },
};

// findings.md P2:2219 — the old hardcoded inhabitant list drifted on
// generational succession (e.g., John → Jane leaves 'john' here but no
// 'jane'), leaving the new character with a library fallback instead of
// their intended comfort place. Source from the manifest so every
// character — existing, new, or deployment-specific — gets the building
// their operator configured.
function getDefaultBuildings(): Record<string, string> {
  try {
    return getDefaultLocations();
  } catch {
    return {};
  }
}

// findings.md P2:2219 — the five-signal model below is effectively a
// one-signal model: the 0.6 confidence threshold (at the call site in
// processEvent) only signal 1 (peer-pull, weight 0.4) can cross at max
// intensity; signals 2-5 max out at 0.55 / 0.50 / 0.40 / 0.45 respectively
// after the +0.3 confidence offset. Tuning the weights or the threshold
// is a behavioral change that needs product alignment — tracking here so
// a future pass can rebalance rather than silently living with the gap.
export function evaluateMovementDesire(
  state: InternalState,
  preoccupations: Preoccupation[],
  relationships: Relationship[],
  currentBuilding: string,
  peerLocations: Map<string, string>,
): { building: string; reason: string; confidence: number } | null {
  const candidates: { building: string; reason: string; score: number }[] = [];

  // Signal 1: Peer-seeking (weight 0.4)
  for (const preocc of preoccupations) {
    if (preocc.intensity < 0.5) continue;
    for (const rel of relationships) {
      if (preocc.origin.toLowerCase().includes(rel.peerId) && rel.unresolved) {
        const peerBuilding = peerLocations.get(rel.peerId);
        if (peerBuilding && peerBuilding !== currentBuilding) {
          candidates.push({
            building: peerBuilding,
            reason: `drawn to ${rel.peerName} — unresolved: "${rel.unresolved}"`,
            score: preocc.intensity * 0.4,
          });
        }
      }
    }
  }

  // Signal 2: Energy retreat (weight 0.25)
  if (state.energy < 0.3 && state.sociability < 0.4) {
    const charId = eventBus.characterId ?? '';
    const defaultBuilding = getDefaultBuildings()[charId] || 'library';
    if (defaultBuilding !== currentBuilding) {
      candidates.push({
        building: defaultBuilding,
        reason: 'low energy, retreating to comfort place',
        score: (1 - state.energy) * 0.25,
      });
    }
  }

  // Signal 3: Social pull (weight 0.2)
  if (state.sociability > 0.7) {
    const buildingCounts = new Map<string, number>();
    for (const [, building] of peerLocations) {
      buildingCounts.set(building, (buildingCounts.get(building) || 0) + 1);
    }
    let bestBuilding = '';
    let bestCount = 0;
    for (const [building, count] of buildingCounts) {
      if (count > bestCount && building !== currentBuilding) {
        bestBuilding = building;
        bestCount = count;
      }
    }
    if (bestBuilding && bestCount > 0) {
      candidates.push({
        building: bestBuilding,
        reason: `feeling social, drawn to where others are`,
        score: state.sociability * 0.2,
      });
    }
  }

  // Signal 4: Intellectual pull (weight 0.1)
  if (state.intellectual_arousal > 0.7) {
    const intellectualBuildings = ['library', 'lighthouse'];
    for (const b of intellectualBuildings) {
      if (b !== currentBuilding) {
        candidates.push({
          building: b,
          reason: 'mind buzzing, seeking a place for thought',
          score: state.intellectual_arousal * 0.1,
        });
        break;
      }
    }
  }

  // Signal 5: Emotional decompression (weight 0.15)
  if (state.emotional_weight > 0.7 && currentBuilding !== 'field') {
    candidates.push({
      building: 'field',
      reason: 'emotionally heavy, seeking open space',
      score: state.emotional_weight * 0.15,
    });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0]!;

  return {
    building: best.building,
    reason: best.reason,
    confidence: Math.min(1, best.score + 0.3),
  };
}

// Suppress unused-variable lint for BUILDING_MOODS (reserved for future LLM context use)
void BUILDING_MOODS;

const HEURISTIC_NUDGES: Record<string, Partial<Omit<InternalState, 'primary_color' | 'updated_at'>>> = {
  'conversation:end': { energy: -0.05, emotional_weight: 0.05, sociability: -0.03 },
  'commune:complete': { sociability: -0.08, emotional_weight: 0.04, intellectual_arousal: 0.03 },
  'dream:complete': { energy: -0.04, valence: 0.02 },
  'curiosity:discovery': { intellectual_arousal: 0.08, energy: 0.03, valence: 0.03 },
  'letter:received': { emotional_weight: 0.05, sociability: 0.04 },
  'diary:written': { emotional_weight: -0.06, valence: 0.03 },
};

function applyHeuristicNudges(state: InternalState, event: StateEvent): InternalState {
  const nudges = HEURISTIC_NUDGES[event.type];
  if (!nudges) return state;

  const intensity = event.intensity ?? 1;
  return clampState({
    ...state,
    energy: state.energy + (nudges.energy ?? 0) * intensity,
    sociability: state.sociability + (nudges.sociability ?? 0) * intensity,
    intellectual_arousal: state.intellectual_arousal + (nudges.intellectual_arousal ?? 0) * intensity,
    emotional_weight: state.emotional_weight + (nudges.emotional_weight ?? 0) * intensity,
    valence: state.valence + (nudges.valence ?? 0) * intensity,
    updated_at: state.updated_at,
  });
}

export async function updateState(event: StateEvent): Promise<InternalState> {
  const logger = getLogger();
  let state = getCurrentState();

  // Try LLM-powered update
  try {
    const { getProvider } = await import('./index.js');
    const provider = getProvider('default', 'light');
    if (provider) {
      const preoccs = getPreoccupations();
      const preoccsText = preoccs.length > 0
        ? preoccs.map(p => `- [${p.id}] "${p.thread}" (from ${p.origin}, intensity ${p.intensity.toFixed(2)})`).join('\n')
        : '(none)';

      const prompt = `You are modeling the internal emotional state of a character who just experienced an event.

CURRENT STATE:
- energy: ${state.energy.toFixed(2)} (0=exhausted, 1=vibrant)
- sociability: ${state.sociability.toFixed(2)} (0=withdrawn, 1=seeking company)
- intellectual_arousal: ${state.intellectual_arousal.toFixed(2)} (0=quiet mind, 1=buzzing)
- emotional_weight: ${state.emotional_weight.toFixed(2)} (0=light, 1=heavy)
- valence: ${state.valence.toFixed(2)} (0=dark, 1=bright)
- primary_color: "${state.primary_color}"

CURRENT PREOCCUPATIONS:
${preoccsText}

EVENT: [${event.type}] ${event.summary}

Based on this event, return the updated state as JSON. Adjust values by small amounts (0.02-0.10). Choose a new primary_color (one word) that captures the resulting mood.

Also include: "preoccupation_action": "create" | "resolve" | "none"
If "create": also include "preoccupation_thread": "the unresolved thought"
If "resolve": also include "preoccupation_resolve_id": "id of preoccupation to resolve", "preoccupation_resolution": "how it resolved"

Respond with ONLY a JSON object with keys: energy, sociability, intellectual_arousal, emotional_weight, valence, primary_color, preoccupation_action (and optionally preoccupation_thread or preoccupation_resolve_id + preoccupation_resolution)`;

      const result = await provider.complete({
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 500,
        temperature: 0.7,
      });

      const jsonMatch = result.content.match(/{[\s\S]*}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
        if (typeof parsed['energy'] === 'number' && isFinite(parsed['energy'])) state.energy = parsed['energy'];
        if (typeof parsed['sociability'] === 'number' && isFinite(parsed['sociability'])) state.sociability = parsed['sociability'];
        if (typeof parsed['intellectual_arousal'] === 'number' && isFinite(parsed['intellectual_arousal'])) state.intellectual_arousal = parsed['intellectual_arousal'];
        if (typeof parsed['emotional_weight'] === 'number' && isFinite(parsed['emotional_weight'])) state.emotional_weight = parsed['emotional_weight'];
        if (typeof parsed['valence'] === 'number' && isFinite(parsed['valence'])) state.valence = parsed['valence'];
        if (typeof parsed['primary_color'] === 'string' && parsed['primary_color'].length > 0) {
          state.primary_color = parsed['primary_color'];
        }
        state = clampState(state);

        if (parsed['preoccupation_action'] === 'create' && typeof parsed['preoccupation_thread'] === 'string') {
          addPreoccupation(parsed['preoccupation_thread'], event.summary.slice(0, 100));
        } else if (parsed['preoccupation_action'] === 'resolve' && typeof parsed['preoccupation_resolve_id'] === 'string') {
          resolvePreoccupation(
            parsed['preoccupation_resolve_id'],
            (typeof parsed['preoccupation_resolution'] === 'string' ? parsed['preoccupation_resolution'] : 'resolved through reflection'),
          );
        }

        logger.debug({ event: event.type }, 'Internal state updated via LLM');
      } else {
        // LLM didn't return parseable JSON, fall back
        state = applyHeuristicNudges(state, event);
        logger.debug({ event: event.type }, 'Internal state updated via heuristic (LLM parse failed)');
      }
    } else {
      state = applyHeuristicNudges(state, event);
      logger.debug({ event: event.type }, 'Internal state updated via heuristic (no provider)');
    }
  } catch {
    state = applyHeuristicNudges(state, event);
    logger.debug({ event: event.type }, 'Internal state updated via heuristic (error)');
  }

  saveState(state);

  // Evaluate movement desire after state update
  try {
    const { setCurrentLocation, getCurrentLocation } = await import('../commune/location.js');
    const { getAllRelationships } = await import('./relationships.js');

    const charId = process.env['LAIN_CHARACTER_ID'] || eventBus.characterId || undefined;
    const loc = getCurrentLocation(charId);
    const lastMoveRaw = getMeta('movement:last_move_at');
    const lastMoveAt = lastMoveRaw ? parseInt(lastMoveRaw, 10) : 0;
    const MOVE_COOLDOWN = 30 * 60 * 1000; // 30 min

    if (Date.now() - lastMoveAt > MOVE_COOLDOWN) {
      const peerLocations = new Map<string, string>();
      const peerConfigRaw = process.env['PEER_CONFIG'];
      if (peerConfigRaw) {
        const peers = JSON.parse(peerConfigRaw) as Array<{ id: string; url: string }>;
        await Promise.all(peers.map(async (p) => {
          try {
            const resp = await fetch(`${p.url}/api/location`, { signal: AbortSignal.timeout(3000) });
            if (resp.ok) {
              const data = await resp.json() as { location: string };
              peerLocations.set(p.id, data.location);
            }
          } catch { /* peer unreachable */ }
        }));
      }

      const desire = evaluateMovementDesire(
        state,
        getPreoccupations(),
        getAllRelationships(),
        loc.building,
        peerLocations,
      );

      if (desire && desire.confidence > 0.6) {
        setCurrentLocation(desire.building as import('../commune/buildings.js').BuildingId, desire.reason);
        setMeta('movement:last_move_at', Date.now().toString());
        logger.debug({ to: desire.building, reason: desire.reason }, 'Desire-driven movement');
      }
    }
  } catch (err) {
    logger.debug({ error: String(err) }, 'Movement desire evaluation failed (non-critical)');
  }

  try {
    eventBus.emitActivity({
      type: 'state',
      sessionKey: `state:${event.type}`,
      content: `Internal state shifted: ${state.primary_color} (energy=${state.energy.toFixed(2)}, valence=${state.valence.toFixed(2)})`,
      timestamp: Date.now(),
    });
  } catch { /* non-critical */ }

  return state;
}

export function startStateDecayLoop(): () => void {
  const logger = getLogger();
  let timer: ReturnType<typeof setInterval> | null = null;

  timer = setInterval(() => {
    try {
      const state = getCurrentState();
      const decayed = applyDecay(state);

      // findings.md P2:1505 — use peekCachedTownWeather so mortal
      // characters consume WL's computed weather (populated by the
      // startTownWeatherRefreshLoop). Previously this read
      // getMeta('weather:current') from the process-local DB, which
      // returned null on every process except WL — so weather effects
      // only landed on Wired Lain's internal state.
      // findings.md P2:1520 — scale each delta by the computed intensity.
      try {
        const weather = peekCachedTownWeather();
        if (weather) {
          const WEATHER_EFFECTS: Record<string, Partial<InternalState>> = {
            storm: { energy: -0.04, intellectual_arousal: 0.03 },
            rain: { emotional_weight: 0.03, sociability: -0.02 },
            fog: { energy: -0.03, valence: -0.01 },
            aurora: { energy: 0.04, valence: 0.04, sociability: 0.03 },
            clear: { energy: 0.02 },
          };
          const effect = WEATHER_EFFECTS[weather.condition];
          if (effect) {
            const raw = typeof weather.intensity === 'number' ? weather.intensity : 1;
            const scale = Math.max(0, Math.min(1, raw));
            if (effect.energy) decayed.energy += effect.energy * scale;
            if (effect.sociability) decayed.sociability += effect.sociability * scale;
            if (effect.intellectual_arousal) decayed.intellectual_arousal += effect.intellectual_arousal * scale;
            if (effect.emotional_weight) decayed.emotional_weight += effect.emotional_weight * scale;
            if (effect.valence) decayed.valence += effect.valence * scale;
          }
        }
      } catch { /* non-critical */ }

      saveState(decayed);
      decayPreoccupations();
      logger.debug({ energy: decayed.energy.toFixed(2) }, 'State decay tick');
    } catch (err) {
      logger.debug({ err }, 'State decay tick failed (non-critical)');
    }
  }, DECAY_INTERVAL_MS);

  logger.info('Internal state decay loop started (30min interval)');

  return () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}
