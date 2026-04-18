/**
 * Object composition system — emergent symbolic language.
 *
 * Inhabitants assign personal symbolic meanings to objects they carry,
 * and compose objects together to create compound meanings. Over time,
 * repeated compositions stabilize into a shared vocabulary.
 *
 * All meaning storage is per-character in the meta table. No predefined
 * grammar — the LLM generates all meanings freely.
 */

import { getMeta, setMeta } from '../storage/database.js';
import { getLogger } from '../utils/logger.js';
import { eventBus } from '../events/bus.js';
import type { Provider } from '../providers/base.js';

// ── Types ────────────────────────────────────────────────────

interface ObjectMeaningEntry {
  meaning: string;
  history: string[];      // previous meanings, max 5, newest first
  lastReflected: number;
}

interface ObjectMeanings {
  [objectId: string]: ObjectMeaningEntry;
}

interface LexiconEntry {
  pattern: string;        // sorted object names joined with " + "
  meanings: string[];     // last 5 generated meanings, newest first
  useCount: number;
  lastUsed: number;
  sharedWith: string[];   // character IDs told about this composition
}

export interface ObjectInfo {
  id: string;
  name: string;
  description: string;
  creatorName: string;
}

// ── Constants ────────────────────────────────────────────────

const MAX_MEANING_HISTORY = 5;
const MAX_LEXICON_ENTRIES = 50;
const STABLE_THRESHOLD = 3;         // useCount needed for "stable" status
const MAX_CONTEXT_CHARS = 1500;     // rough cap for prompt injection

// ── Meta helpers ─────────────────────────────────────────────

function loadMeanings(characterId: string): ObjectMeanings {
  try {
    const raw = getMeta(`objects:meanings:${characterId}`);
    return raw ? JSON.parse(raw) as ObjectMeanings : {};
  } catch {
    return {};
  }
}

function saveMeanings(characterId: string, meanings: ObjectMeanings): void {
  setMeta(`objects:meanings:${characterId}`, JSON.stringify(meanings));
}

function loadLexicon(characterId: string): LexiconEntry[] {
  try {
    const raw = getMeta(`objects:lexicon:${characterId}`);
    return raw ? JSON.parse(raw) as LexiconEntry[] : [];
  } catch {
    return [];
  }
}

function saveLexicon(characterId: string, lexicon: LexiconEntry[]): void {
  // Evict oldest entries if over cap
  if (lexicon.length > MAX_LEXICON_ENTRIES) {
    lexicon.sort((a, b) => b.lastUsed - a.lastUsed);
    lexicon.length = MAX_LEXICON_ENTRIES;
  }
  setMeta(`objects:lexicon:${characterId}`, JSON.stringify(lexicon));
}

function compositionKey(objects: Array<{ name: string }>): string {
  return objects.map((o) => o.name).sort().join(' + ');
}

// ── Exported functions ───────────────────────────────────────

/**
 * Get the symbolic meaning a character has assigned to an object.
 */
export function getObjectMeaning(
  characterId: string,
  objectId: string
): { meaning: string; history: string[] } | null {
  const meanings = loadMeanings(characterId);
  const entry = meanings[objectId];
  if (!entry) return null;
  return { meaning: entry.meaning, history: entry.history };
}

/**
 * Assign or update the symbolic meaning of an object.
 */
export function setObjectMeaning(
  characterId: string,
  objectId: string,
  meaning: string
): void {
  const meanings = loadMeanings(characterId);
  const existing = meanings[objectId];

  const history = existing
    ? [existing.meaning, ...existing.history].slice(0, MAX_MEANING_HISTORY)
    : [];

  meanings[objectId] = {
    meaning,
    history,
    lastReflected: Date.now(),
  };

  saveMeanings(characterId, meanings);
}

/**
 * LLM-powered reflection on an object. Generates a new symbolic meaning
 * and stores it via setObjectMeaning.
 */
export async function reflectOnObject(
  provider: Provider,
  characterId: string,
  characterName: string,
  object: ObjectInfo,
  selfConcept: string | null,
  contextHint?: string
): Promise<string> {
  const existing = getObjectMeaning(characterId, object.id);

  const prompt = `You are ${characterName}. You are holding "${object.name}" — ${object.description}. Created by ${object.creatorName}.

${existing ? `You once saw this as: "${existing.meaning}"` : ''}
${existing && existing.history.length > 0 ? `Earlier interpretations: ${existing.history.join('; ')}` : ''}
${selfConcept ? `Who you are now: ${selfConcept}` : ''}
${contextHint ? `What prompted this reflection: ${contextHint}` : ''}

What does this object mean to you right now? Not what it is — what it means. One or two sentences. Write as yourself.`;

  const result = await provider.complete({
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 300,
    temperature: 0.9,
  });

  const meaning = result.content.trim();
  setObjectMeaning(characterId, object.id, meaning);
  return meaning;
}

/**
 * Compose 2+ objects together. LLM generates a compound meaning.
 * Records the composition in the character's lexicon.
 */
export async function composeObjects(
  provider: Provider,
  characterId: string,
  characterName: string,
  objects: ObjectInfo[],
  selfConcept: string | null,
  context?: string
): Promise<string> {
  const logger = getLogger();
  const key = compositionKey(objects);

  // Check for existing lexicon entry
  const lexicon = loadLexicon(characterId);
  const existing = lexicon.find((e) => e.pattern === key);

  const objectLines = objects.map((o) => {
    const meaning = getObjectMeaning(characterId, o.id);
    return `- "${o.name}": ${o.description}${meaning ? ` (to you it means: "${meaning.meaning}")` : ''}`;
  }).join('\n');

  const prompt = `You are ${characterName}. You have placed these objects together:

${objectLines}

${existing ? `You have composed these before. Last time it meant: "${existing.meanings[0]}"` : ''}
${selfConcept ? `Who you are now: ${selfConcept}` : ''}
${context ? `This moment: ${context}` : ''}

What meaning emerges from this arrangement? Not a list of the objects — the meaning of placing them together. One to three sentences. Write as yourself.`;

  const result = await provider.complete({
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 400,
    temperature: 0.9,
  });

  const meaning = result.content.trim();

  // Update lexicon
  if (existing) {
    existing.meanings = [meaning, ...existing.meanings].slice(0, MAX_MEANING_HISTORY);
    existing.useCount += 1;
    existing.lastUsed = Date.now();
  } else {
    lexicon.push({
      pattern: key,
      meanings: [meaning],
      useCount: 1,
      lastUsed: Date.now(),
      sharedWith: [],
    });
  }
  saveLexicon(characterId, lexicon);

  // Emit activity event
  const objectNames = objects.map((o) => `"${o.name}"`).join(' + ');
  eventBus.emitActivity({
    type: 'object',
    sessionKey: `composition:${characterId}:${Date.now()}`,
    content: `composed ${objectNames}: "${meaning.slice(0, 200)}"`,
    timestamp: Date.now(),
  });

  logger.debug(
    { characterId, pattern: key, useCount: existing?.useCount ?? 1 },
    'Object composition recorded'
  );

  return meaning;
}

/**
 * Build a context string describing the character's inventory with
 * symbolic meanings + stable lexicon entries. For prompt injection.
 */
export async function buildObjectContext(
  characterId: string,
  wiredLainUrl: string
): Promise<string> {
  const logger = getLogger();
  let parts: string[] = [];

  // Fetch inventory from Wired Lain API
  try {
    const resp = await fetch(
      `${wiredLainUrl}/api/objects?owner=${encodeURIComponent(characterId)}`,
      { signal: AbortSignal.timeout(5000) }
    );

    if (resp.ok) {
      const objects = await resp.json() as Array<{ id: string; name: string; description: string }>;

      if (objects.length > 0) {
        const lines = objects.map((obj) => {
          const meaning = getObjectMeaning(characterId, obj.id);
          if (meaning) {
            return `- ${obj.name}: ${meaning.meaning}`;
          }
          return `- ${obj.name}: ${obj.description.slice(0, 80)}`;
        });
        parts.push('You carry:\n' + lines.join('\n'));
      }
    }
  } catch {
    logger.debug('Could not fetch object inventory for context');
  }

  // Add stable lexicon entries
  const lexiconCtx = getStableLexicon(characterId);
  if (lexiconCtx) {
    parts.push(lexiconCtx);
  }

  const result = parts.join('\n\n');
  // Rough token cap
  if (result.length > MAX_CONTEXT_CHARS) {
    return result.slice(0, MAX_CONTEXT_CHARS) + '\n...';
  }
  return result;
}

/**
 * Get stable lexicon entries (useCount >= STABLE_THRESHOLD) formatted for prompt injection.
 */
export function getStableLexicon(characterId: string): string {
  const lexicon = loadLexicon(characterId);
  const stable = lexicon.filter((e) => e.useCount >= STABLE_THRESHOLD);

  if (stable.length === 0) return '';

  const lines = stable.map((e) =>
    `- ${e.pattern} (composed ${e.useCount} times) — "${e.meanings[0]}"`
  );
  return 'Compositions you have made and their meanings:\n' + lines.join('\n');
}
