/**
 * Per-peer subjective relationship system.
 *
 * Each character maintains relationships with peers they've had
 * commune conversations with. Stored in the meta key-value store
 * (key pattern: `relationship:{peerId}`), updated via LLM after
 * commune conversations, and injected into commune impulse context
 * so characters make relationship-aware decisions about who to talk to.
 */

import { getMeta, setMeta, query } from '../storage/database.js';
import { getLogger } from '../utils/logger.js';

export interface Relationship {
  peerId: string;
  peerName: string;
  affinity: number;              // 0=cold, 1=warm
  familiarity: number;           // 0=stranger, 1=deeply known. Only increases.
  intellectual_tension: number;  // 0=agreement, 1=productive friction
  emotional_resonance: number;   // 0=surface, 1=deep connection
  last_topic_thread: string;     // What you were last discussing
  unresolved: string | null;     // Dangling thread from last conversation
  last_interaction: number;      // Timestamp
  interaction_count: number;
}

const META_KEY_PREFIX = 'relationship:';

/**
 * Load a relationship from the meta store.
 */
export function getRelationship(peerId: string): Relationship | null {
  try {
    const raw = getMeta(`${META_KEY_PREFIX}${peerId}`);
    if (!raw) return null;
    return JSON.parse(raw) as Relationship;
  } catch {
    return null;
  }
}

/**
 * Persist a relationship to the meta store.
 * Familiarity MUST only increase — enforced here.
 */
export function saveRelationshipData(peerId: string, data: Relationship): void {
  const existing = getRelationship(peerId);
  if (existing) {
    data.familiarity = Math.max(existing.familiarity, data.familiarity);
  }
  setMeta(`${META_KEY_PREFIX}${peerId}`, JSON.stringify(data));
}

/**
 * Return all persisted relationships.
 */
export function getAllRelationships(): Relationship[] {
  try {
    const rows = query<{ key: string; value: string }>(
      `SELECT key, value FROM meta WHERE key LIKE 'relationship:%'`
    );
    const results: Relationship[] = [];
    for (const row of rows) {
      try {
        results.push(JSON.parse(row.value) as Relationship);
      } catch { /* skip malformed rows */ }
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * Produce a natural-language summary of a relationship for prompt injection.
 */
export function getRelationshipContext(peerId: string): string {
  const rel = getRelationship(peerId);
  if (!rel) return `No prior relationship with peer "${peerId}".`;

  const affinityLabel =
    rel.affinity >= 0.7 ? 'warm' :
    rel.affinity >= 0.4 ? 'neutral' :
    'cool';
  const familiarityLabel =
    rel.familiarity >= 0.7 ? 'deeply known' :
    rel.familiarity >= 0.4 ? 'somewhat familiar' :
    'still getting to know';

  let text = `Your relationship with ${rel.peerName}: ${affinityLabel} affinity, ${familiarityLabel} (${rel.interaction_count} conversations).`;
  if (rel.last_topic_thread) {
    text += ` Last topic: "${rel.last_topic_thread}".`;
  }
  if (rel.unresolved) {
    text += ` Unresolved: "${rel.unresolved}".`;
  }
  return text;
}

/**
 * LLM-powered update after a commune conversation.
 * Falls back to a simple heuristic bump if the LLM call fails.
 */
export async function updateRelationship(
  peerId: string,
  peerName: string,
  transcript: string,
  reflection: string
): Promise<Relationship> {
  const logger = getLogger();
  const existing = getRelationship(peerId) ?? makeDefaultRelationship(peerId, peerName);

  try {
    const { getProvider } = await import('./index.js');
    const provider = getProvider('default', 'light');
    if (!provider) throw new Error('no provider');

    const trimmedTranscript = transcript.length > 2000 ? transcript.slice(0, 2000) + '...' : transcript;
    const trimmedReflection = reflection.length > 500 ? reflection.slice(0, 500) + '...' : reflection;

    const prompt = `You are updating a relationship model after a conversation.

PREVIOUS RELATIONSHIP STATE:
- affinity: ${existing.affinity.toFixed(2)} (0=cold, 1=warm)
- familiarity: ${existing.familiarity.toFixed(2)} (0=stranger, 1=deeply known)
- intellectual_tension: ${existing.intellectual_tension.toFixed(2)} (0=agreement, 1=productive friction)
- emotional_resonance: ${existing.emotional_resonance.toFixed(2)} (0=surface, 1=deep connection)
- last_topic_thread: "${existing.last_topic_thread}"
- unresolved: ${existing.unresolved ? `"${existing.unresolved}"` : 'null'}

CONVERSATION TRANSCRIPT:
${trimmedTranscript}

REFLECTION:
${trimmedReflection}

Based on this conversation, return updated values as a JSON object with keys: affinity, familiarity, intellectual_tension, emotional_resonance, last_topic_thread, unresolved (string or null).
Adjust numeric values by small amounts (0.02-0.15). Keep them in [0, 1].

Respond with ONLY the JSON object.`;

    const result = await provider.complete({
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 400,
      temperature: 0.7,
    });

    const jsonMatch = result.content.match(/{[\s\S]*}/);
    if (!jsonMatch) throw new Error('no JSON in response');

    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

    // Validate and apply parsed fields
    const updated: Relationship = {
      peerId,
      peerName,
      affinity: clamp(toNumber(parsed['affinity'], existing.affinity)),
      familiarity: Math.max(existing.familiarity, clamp(toNumber(parsed['familiarity'], existing.familiarity))),
      intellectual_tension: clamp(toNumber(parsed['intellectual_tension'], existing.intellectual_tension)),
      emotional_resonance: clamp(toNumber(parsed['emotional_resonance'], existing.emotional_resonance)),
      last_topic_thread: typeof parsed['last_topic_thread'] === 'string' ? parsed['last_topic_thread'] : existing.last_topic_thread,
      unresolved: typeof parsed['unresolved'] === 'string' ? parsed['unresolved'] : (parsed['unresolved'] === null ? null : existing.unresolved),
      last_interaction: Date.now(),
      interaction_count: existing.interaction_count + 1,
    };

    saveRelationshipData(peerId, updated);
    logger.debug({ peerId, affinity: updated.affinity, familiarity: updated.familiarity }, 'Relationship updated via LLM');
    return updated;
  } catch (err) {
    // Heuristic fallback: just bump familiarity and count
    logger.debug({ peerId, error: String(err) }, 'Relationship LLM update failed, using heuristic');
    const fallback: Relationship = {
      ...existing,
      familiarity: Math.min(1, existing.familiarity + 0.05),
      last_interaction: Date.now(),
      interaction_count: existing.interaction_count + 1,
    };
    saveRelationshipData(peerId, fallback);
    return fallback;
  }
}

// --- Helpers ---

function makeDefaultRelationship(peerId: string, peerName: string): Relationship {
  return {
    peerId,
    peerName,
    affinity: 0.5,
    familiarity: 0,
    intellectual_tension: 0.5,
    emotional_resonance: 0.3,
    last_topic_thread: '',
    unresolved: null,
    last_interaction: 0,
    interaction_count: 0,
  };
}

function clamp(v: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, v));
}

function toNumber(val: unknown, fallback: number): number {
  if (typeof val === 'number' && !Number.isNaN(val)) return val;
  return fallback;
}
