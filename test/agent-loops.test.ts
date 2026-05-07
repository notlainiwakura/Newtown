/**
 * Comprehensive Agent Background Loop Test Suite
 *
 * Tests all background loop systems via structural source analysis
 * (readFileSync). Verifies output validation, error handling,
 * timer management, maxTokens settings, provider calls, and
 * memory/storage patterns for every loop.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Mock keytar before any imports that touch storage
vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn().mockResolvedValue('test-master-key'),
    setPassword: vi.fn().mockResolvedValue(undefined),
    deletePassword: vi.fn().mockResolvedValue(true),
    findCredentials: vi.fn().mockResolvedValue([]),
  },
}));

// ── Helpers ──────────────────────────────────────────────────

const AGENT_DIR = join(process.cwd(), 'src/agent');

function readAgentFile(filename: string): string {
  return readFileSync(join(AGENT_DIR, filename), 'utf-8');
}

/**
 * Extract all maxTokens values from a source file.
 */
function extractMaxTokens(src: string): number[] {
  const matches = src.matchAll(/maxTokens:\s*(\d+)/g);
  return [...matches].map(m => Number(m[1]));
}

/**
 * Check if source has a stopped flag pattern (let stopped = false).
 */
function hasStoppedFlag(src: string): boolean {
  return /let\s+stopped\s*=\s*false/.test(src);
}

/**
 * Check if source has clearTimeout or clearInterval calls.
 */
function hasTimerCleanup(src: string): boolean {
  return /clear(?:Timeout|Interval)\s*\(/.test(src);
}

/**
 * Check if source has try/catch wrapping the main cycle body.
 */
function hasTryCatchInCycle(src: string): boolean {
  return /try\s*\{[\s\S]*?catch\s*\(/.test(src);
}

/**
 * Check if source uses provider.complete() or provider.completeWithTools().
 */
function hasProviderCall(src: string): boolean {
  return /provider\.complete\s*\(/.test(src) || /provider\.completeWithTools\s*\(/.test(src);
}

// ── Loop file list ──────────────────────────────────────────

const LOOP_FILES = [
  'diary.ts',
  'dreams.ts',
  'curiosity.ts',
  'letter.ts',
  'commune-loop.ts',
  'self-concept.ts',
  'internal-state.ts',
  'desires.ts',
  'awareness.ts',
  'bibliomancy.ts',
  'evolution.ts',
  'proactive.ts',
  'doctor.ts',
  'book.ts',
  'experiments.ts',
  'narratives.ts',
  'relationships.ts',
  'newspaper.ts',
];

// ═══════════════════════════════════════════════════════════════
// 1. PER-LOOP STRUCTURAL TESTS
// ═══════════════════════════════════════════════════════════════

// ── diary.ts ─────────────────────────────────────────────────

describe('Diary Loop', () => {
  const src = readAgentFile('diary.ts');

  it('has output validation — checks entry length >= 20', () => {
    expect(src).toContain('entryContent.length < 20');
  });

  it('has error handling — try/catch wraps cycle', () => {
    expect(hasTryCatchInCycle(src)).toBe(true);
  });

  it('has timer management — stopped flag pattern', () => {
    expect(hasStoppedFlag(src)).toBe(true);
  });

  it('has timer cleanup — clearTimeout on stop', () => {
    expect(hasTimerCleanup(src)).toBe(true);
  });

  it('has explicit maxTokens on LLM call', () => {
    const tokens = extractMaxTokens(src);
    expect(tokens.length).toBeGreaterThanOrEqual(1);
    tokens.forEach(t => expect(t).toBeGreaterThanOrEqual(10));
  });

  it('uses provider.complete()', () => {
    expect(hasProviderCall(src)).toBe(true);
  });

  it('stores to both file and memory', () => {
    expect(src).toContain('appendJournalEntry');
    expect(src).toContain('saveMemory');
  });

  it('stores to memory with sessionKey diary:daily', () => {
    expect(src).toContain("sessionKey: 'diary:daily'");
  });

  it('stores memoryType as episode', () => {
    expect(src).toContain("memoryType: 'episode'");
  });

  it('trims LLM output before validation', () => {
    expect(src).toContain('result.content.trim()');
  });

  it('has initial delay logic based on last run', () => {
    expect(src).toContain("getMeta('diary:last_entry_at')");
  });

  it('persists last run timestamp to meta', () => {
    expect(src).toContain("setMeta('diary:last_entry_at'");
  });

  it('has event-driven early trigger support', () => {
    expect(src).toContain('maybeRunEarly');
    expect(src).toContain('eventBus.on');
  });

  it('has cooldown to prevent excessive runs', () => {
    expect(src).toMatch(/COOLDOWN_MS\s*=\s*\d/);
  });
});

// ── dreams.ts ────────────────────────────────────────────────

describe('Dream Loop', () => {
  const src = readAgentFile('dreams.ts');

  it('has output validation — checks fragment text length >= 10', () => {
    expect(src).toContain('text.length < 10');
  });

  it('has output validation — checks residue text length >= 10', () => {
    // In saveDreamResidue
    expect(src).toContain('residueText.length < 10');
  });

  it('has error handling — try/catch in cycle', () => {
    expect(hasTryCatchInCycle(src)).toBe(true);
  });

  it('has timer management — stopped flag', () => {
    expect(hasStoppedFlag(src)).toBe(true);
  });

  it('has timer cleanup', () => {
    expect(hasTimerCleanup(src)).toBe(true);
  });

  it('has explicit maxTokens on fragment generation LLM call', () => {
    const tokens = extractMaxTokens(src);
    expect(tokens.length).toBeGreaterThanOrEqual(1);
    tokens.forEach(t => expect(t).toBeGreaterThanOrEqual(10));
  });

  it('uses provider.complete()', () => {
    expect(hasProviderCall(src)).toBe(true);
  });

  it('has TWO distinct LLM calls — fragment generation AND residue compression', () => {
    // Fragment generation uses maxTokens: 500
    // Residue compression uses maxTokens: 120
    const tokens = extractMaxTokens(src);
    expect(tokens).toContain(500);
    expect(tokens).toContain(120);
    expect(tokens.length).toBeGreaterThanOrEqual(2);
  });

  it('stores dream residue to memory', () => {
    expect(src).toContain('saveMemory');
    expect(src).toContain("sessionKey: 'dream:residue'");
  });

  it('creates dream associations via addAssociation', () => {
    expect(src).toContain('addAssociation');
  });

  it('has quiet threshold check before dreaming', () => {
    expect(src).toContain('quietThresholdMs');
    expect(src).toContain('silenceDuration < cfg.quietThresholdMs');
  });

  it('has minimum memory count before dreaming', () => {
    expect(src).toContain('memories.length < 10');
  });

  it('persists dream cycle timestamp to meta', () => {
    expect(src).toContain("setMeta('dream:last_cycle_at'");
  });

  it('increments dream cycle count in meta', () => {
    expect(src).toContain("setMeta('dream:cycle_count'");
  });

  it('has post-dream drift to The Threshold', () => {
    expect(src).toContain('driftToThreshold');
    expect(src).toContain('THRESHOLD_DRIFT_PROBABILITY');
  });

  it('has event-driven early trigger', () => {
    expect(src).toContain('maybeRunEarly');
    expect(src).toContain('eventBus.on');
  });

  it('has alien dream seed consumption', () => {
    expect(src).toContain("'alien'");
    expect(src).toContain('isAlienDreamSeed');
    expect(src).toContain('consumed');
  });
});

// ── curiosity.ts ─────────────────────────────────────────────

describe('Curiosity Loop', () => {
  const src = readAgentFile('curiosity.ts');

  it('has output validation — checks for [NOTHING] sentinel', () => {
    expect(src).toContain("[NOTHING]");
  });

  it('has output validation — parses SITE and QUERY from response', () => {
    expect(src).toContain("siteMatch");
    expect(src).toContain("queryMatch");
  });

  it('has error handling — try/catch in cycle', () => {
    expect(hasTryCatchInCycle(src)).toBe(true);
  });

  it('has timer management — stopped flag', () => {
    expect(hasStoppedFlag(src)).toBe(true);
  });

  it('has timer cleanup', () => {
    expect(hasTimerCleanup(src)).toBe(true);
  });

  it('has explicit maxTokens on all LLM calls', () => {
    const tokens = extractMaxTokens(src);
    expect(tokens.length).toBeGreaterThanOrEqual(2); // inner thought + digest + movement
    tokens.forEach(t => expect(t).toBeGreaterThanOrEqual(10));
  });

  it('uses provider.complete()', () => {
    expect(hasProviderCall(src)).toBe(true);
  });

  it('stores discoveries to memory with sessionKey curiosity:browse', () => {
    expect(src).toContain("sessionKey: 'curiosity:browse'");
    expect(src).toContain('saveMemory');
  });

  it('validates domain against whitelist', () => {
    expect(src).toContain('whitelist.some');
    expect(src).toContain('Curiosity site not in whitelist');
  });

  it('supports unrestricted mode with wildcard', () => {
    expect(src).toContain("whitelist.includes('*')");
  });

  it('has SSRF protection for dataset downloads', () => {
    expect(src).toContain('checkSSRF');
  });

  it('has digest response parsing with structured fields', () => {
    expect(src).toContain('parseDigestResponse');
    expect(src).toContain('SUMMARY:');
    expect(src).toContain('THEMES:');
    expect(src).toContain('QUESTIONS:');
  });

  it('enqueues new curiosity questions for future exploration', () => {
    expect(src).toContain('enqueueCuriosityQuestions');
    expect(src).toContain('markQuestionExplored');
  });

  it('tracks theme frequency for intellectual growth', () => {
    expect(src).toContain('updateThemeTracker');
    expect(src).toContain('linkEvolutionChain');
  });

  it('has event-driven early trigger for intellectual arousal', () => {
    expect(src).toContain('maybeRunEarly');
    expect(src).toContain('intellectual_arousal');
  });

  it('has movement decision phase', () => {
    expect(src).toContain('phaseMovementDecision');
  });
});

// ── letter.ts ────────────────────────────────────────────────

describe('Letter Loop', () => {
  const src = readAgentFile('letter.ts');

  it('has output validation — checks response length >= 10', () => {
    expect(src).toContain('raw.length < 10');
  });

  it('validates JSON structure before sending', () => {
    expect(src).toContain('JSON.parse(raw)');
    expect(src).toContain('Array.isArray(letter.topics)');
    expect(src).toContain('Array.isArray(letter.impressions)');
    expect(src).toContain("typeof letter.gift !== 'string'");
    expect(src).toContain("typeof letter.emotionalState !== 'string'");
  });

  it('has error handling — try/catch in cycle', () => {
    expect(hasTryCatchInCycle(src)).toBe(true);
  });

  it('has timer management — stopped flag', () => {
    expect(hasStoppedFlag(src)).toBe(true);
  });

  it('has timer cleanup', () => {
    expect(hasTimerCleanup(src)).toBe(true);
  });

  it('has explicit maxTokens on LLM call', () => {
    const tokens = extractMaxTokens(src);
    expect(tokens.length).toBeGreaterThanOrEqual(1);
    tokens.forEach(t => expect(t).toBeGreaterThanOrEqual(10));
  });

  it('uses provider.complete()', () => {
    expect(hasProviderCall(src)).toBe(true);
  });

  it('stores sent letter to memory', () => {
    expect(src).toContain('saveMemory');
    expect(src).toContain("sessionKey: 'letter:sent'");
  });

  it('delivers letter via HTTP POST to target URL', () => {
    expect(src).toContain('fetch(cfg.targetUrl');
  });

  it('checks for Dr. Claude letter blocking', () => {
    expect(src).toContain("getMeta('letter:blocked')");
    expect(src).toContain("blocked === 'true'");
  });

  it('persists last sent timestamp to meta', () => {
    expect(src).toContain("setMeta('letter:last_sent_at'");
  });

  it('handles invalid JSON parse gracefully', () => {
    expect(src).toContain('failed to parse JSON');
  });

  it('validates letter has required fields', () => {
    expect(src).toContain('invalid letter structure');
  });
});

// ── commune-loop.ts ──────────────────────────────────────────

describe('Commune Loop', () => {
  const src = readAgentFile('commune-loop.ts');

  it('has output validation — checks for [NOTHING] sentinel', () => {
    expect(src).toContain("[NOTHING]");
  });

  it('has output validation — checks for [END] sentinel', () => {
    expect(src).toContain("[END]");
  });

  it('has error handling — try/catch in cycle', () => {
    expect(hasTryCatchInCycle(src)).toBe(true);
  });

  it('has timer management — stopped flag', () => {
    expect(hasStoppedFlag(src)).toBe(true);
  });

  it('has timer cleanup', () => {
    expect(hasTimerCleanup(src)).toBe(true);
  });

  it('has explicit maxTokens on all LLM calls', () => {
    const tokens = extractMaxTokens(src);
    expect(tokens.length).toBeGreaterThanOrEqual(3); // impulse + reply + reflection + aftermath
    tokens.forEach(t => expect(t).toBeGreaterThanOrEqual(10));
  });

  it('uses provider.complete() and provider.completeWithTools()', () => {
    expect(src).toContain('provider.complete(');
    expect(src).toContain('provider.completeWithTools(');
  });

  it('stores commune conversation to memory', () => {
    expect(src).toContain('saveMemory');
    expect(src).toContain("sessionKey: 'commune:conversation'");
  });

  it('has iteration limits on tool use in aftermath phase', () => {
    // "Execute up to 2 tool iterations"
    expect(src).toContain('for (let i = 0; i < 2; i++)');
  });

  it('has round limits on conversation (MIN_ROUNDS, MAX_ROUNDS)', () => {
    expect(src).toMatch(/MIN_ROUNDS\s*=\s*\d/);
    expect(src).toMatch(/MAX_ROUNDS\s*=\s*\d/);
  });

  it('parses PEER and MESSAGE from impulse response', () => {
    expect(src).toContain("peerMatch");
    expect(src).toContain("messageMatch");
  });

  it('validates peer ID exists in config', () => {
    expect(src).toContain('config.peers.find');
    expect(src).toContain('Impulse selected unknown peer');
  });

  it('maintains conversation history in meta store', () => {
    expect(src).toContain('appendConversationHistory');
    expect(src).toContain('META_KEY_HISTORY');
  });

  it('caps conversation history', () => {
    expect(src).toMatch(/MAX_HISTORY_ENTRIES\s*=\s*\d+/);
  });

  it('updates relationship model after conversation', () => {
    expect(src).toContain('updateRelationship');
  });

  it('has approach phase to move to peer before conversation', () => {
    expect(src).toContain('phaseApproach');
  });

  it('has aftermath phase for post-conversation tool use', () => {
    expect(src).toContain('phaseAftermath');
  });

  it('broadcasts conversation lines to the web server', () => {
    expect(src).toContain('broadcastLine');
  });

  it('has event-driven early trigger for sociability', () => {
    expect(src).toContain('maybeRunEarly');
    expect(src).toContain('state.sociability');
  });

  it('has peer diversity hint in impulse generation', () => {
    expect(src).toContain('diversityHint');
    expect(src).toContain('leastTalkedTo');
  });
});

// ── self-concept.ts ──────────────────────────────────────────

describe('Self-Concept Loop', () => {
  const src = readAgentFile('self-concept.ts');

  it('validates output length > 50', () => {
    expect(src).toContain('selfConcept.length < 50');
  });

  it('has error handling — try/catch', () => {
    expect(hasTryCatchInCycle(src)).toBe(true);
  });

  it('has timer management — stopped flag', () => {
    expect(hasStoppedFlag(src)).toBe(true);
  });

  it('has timer cleanup', () => {
    expect(hasTimerCleanup(src)).toBe(true);
  });

  it('has explicit maxTokens on LLM call', () => {
    const tokens = extractMaxTokens(src);
    expect(tokens.length).toBeGreaterThanOrEqual(1);
    tokens.forEach(t => expect(t).toBeGreaterThanOrEqual(10));
  });

  it('uses provider.complete()', () => {
    expect(hasProviderCall(src)).toBe(true);
  });

  it('stores to meta table, file, and memory', () => {
    expect(src).toContain("setMeta('self-concept:current'");
    expect(src).toContain('writeFileSync(SELF_CONCEPT_PATH');
    expect(src).toContain('saveMemory');
  });

  it('archives previous concept before overwriting', () => {
    expect(src).toContain("setMeta('self-concept:previous'");
  });

  it('has shouldSynthesize guard with time + entry count', () => {
    expect(src).toContain('shouldSynthesize');
    expect(src).toContain('cfg.intervalMs');
    expect(src).toContain('cfg.minDiaryEntries');
  });

  it('has perturbation prompts every ~3rd cycle', () => {
    expect(src).toContain('PERTURBATION_PROMPTS');
    expect(src).toContain('cycleCount % 3 === 2');
  });

  it('tracks synthesis cycle count', () => {
    expect(src).toContain("setMeta('self-concept:cycle_count'");
  });
});

// ── internal-state.ts ────────────────────────────────────────

describe('Internal State Loop', () => {
  const src = readAgentFile('internal-state.ts');

  it('has 6 axes in InternalState interface', () => {
    const axes = ['energy', 'sociability', 'intellectual_arousal', 'emotional_weight', 'valence', 'primary_color'];
    for (const axis of axes) {
      expect(src).toContain(`${axis}:`);
    }
  });

  it('has numeric axes energy, sociability, intellectual_arousal, emotional_weight, valence', () => {
    const numericAxes = ['energy', 'sociability', 'intellectual_arousal', 'emotional_weight', 'valence'];
    for (const axis of numericAxes) {
      // Verify these are in DEFAULT_STATE with numeric values
      const regex = new RegExp(`${axis}:\\s*[\\d.]+`);
      expect(src).toMatch(regex);
    }
  });

  it('has clampState that clamps all numeric axes to [0, 1]', () => {
    expect(src).toContain('clampState');
    expect(src).toContain('Math.max(0, Math.min(1,');
  });

  it('has decay loop with setInterval', () => {
    expect(src).toContain('startStateDecayLoop');
    expect(src).toContain('setInterval');
  });

  it('has timer cleanup — clearInterval on stop', () => {
    expect(src).toContain('clearInterval');
  });

  it('applies weather effects to internal state', () => {
    expect(src).toContain('WEATHER_EFFECTS');
    expect(src).toContain("weather.condition");
    // Object literal keys are unquoted in TS source
    expect(src).toContain("storm:");
    expect(src).toContain("rain:");
    expect(src).toContain("fog:");
    expect(src).toContain("aurora:");
    // 'clear' appears as an unquoted key too
    expect(src).toMatch(/clear:\s*\{/);
  });

  it('has heuristic nudge fallback when LLM fails', () => {
    expect(src).toContain('applyHeuristicNudges');
    expect(src).toContain('HEURISTIC_NUDGES');
  });

  it('validates LLM JSON response before applying', () => {
    expect(src).toContain("typeof parsed['energy'] === 'number'");
    expect(src).toContain('isFinite');
  });

  it('has explicit maxTokens on LLM call', () => {
    const tokens = extractMaxTokens(src);
    expect(tokens.length).toBeGreaterThanOrEqual(1);
    tokens.forEach(t => expect(t).toBeGreaterThanOrEqual(10));
  });

  it('uses provider.complete()', () => {
    expect(hasProviderCall(src)).toBe(true);
  });

  it('saves state to meta store', () => {
    expect(src).toContain('saveState');
    expect(src).toContain("setMeta(META_KEY_STATE");
  });

  it('has preoccupation system with add/resolve/decay', () => {
    expect(src).toContain('addPreoccupation');
    expect(src).toContain('resolvePreoccupation');
    expect(src).toContain('decayPreoccupations');
  });

  it('has movement desire evaluation after state update', () => {
    expect(src).toContain('evaluateMovementDesire');
  });

  it('emits state activity events', () => {
    expect(src).toContain('eventBus.emitActivity');
    expect(src).toContain("type: 'state'");
  });

  it('DECAY_INTERVAL_MS is 30 minutes', () => {
    expect(src).toContain('DECAY_INTERVAL_MS = 30 * 60 * 1000');
  });

  it('has 5 weighted signals in evaluateMovementDesire', () => {
    // Signal 1: Peer-seeking (0.4)
    expect(src).toContain('Signal 1: Peer-seeking');
    expect(src).toContain('* 0.4');
    // Signal 2: Energy retreat (0.25)
    expect(src).toContain('Signal 2: Energy retreat');
    expect(src).toContain('* 0.25');
    // Signal 3: Social pull (0.2)
    expect(src).toContain('Signal 3: Social pull');
    expect(src).toContain('* 0.2');
    // Signal 4: Intellectual pull (0.1)
    expect(src).toContain('Signal 4: Intellectual pull');
    expect(src).toContain('* 0.1');
    // Signal 5: Emotional decompression (0.15)
    expect(src).toContain('Signal 5: Emotional decompression');
    expect(src).toContain('* 0.15');
  });
});

// ── desires.ts ───────────────────────────────────────────────

describe('Desire Loop', () => {
  const src = readAgentFile('desires.ts');

  it('has output validation — checks for [NOTHING] sentinel', () => {
    expect(src).toContain('[NOTHING]');
  });

  it('has error handling — try/catch in action handlers', () => {
    expect(hasTryCatchInCycle(src)).toBe(true);
  });

  it('has timer management — stopped flag', () => {
    expect(hasStoppedFlag(src)).toBe(true);
  });

  it('has timer cleanup — clearInterval calls', () => {
    expect(src).toContain('clearInterval(decayTimer)');
    expect(src).toContain('clearInterval(lonelinessTimer)');
  });

  it('has explicit maxTokens on all LLM calls', () => {
    const tokens = extractMaxTokens(src);
    expect(tokens.length).toBeGreaterThanOrEqual(4); // dream, conversation, loneliness, visitor, resolution, actions
    tokens.forEach(t => expect(t).toBeGreaterThanOrEqual(10));
  });

  it('uses provider.complete()', () => {
    expect(hasProviderCall(src)).toBe(true);
  });

  it('has 4 desire types: social, intellectual, emotional, creative', () => {
    expect(src).toContain("'social'");
    expect(src).toContain("'intellectual'");
    expect(src).toContain("'emotional'");
    expect(src).toContain("'creative'");
  });

  it('has decay mechanism for desires', () => {
    expect(src).toContain('decayDesires');
    expect(src).toContain('faded naturally');
  });

  it('has loneliness check', () => {
    expect(src).toContain('checkLoneliness');
    expect(src).toContain('6 * 60 * 60 * 1000'); // 6 hours threshold
  });

  it('validates desire response parsing', () => {
    expect(src).toContain('parseDesireResponse');
    expect(src).toContain('typeMatch');
    expect(src).toContain('descMatch');
  });

  it('ensures desire table exists on startup', () => {
    expect(src).toContain('ensureDesireTable');
    expect(src).toContain('CREATE TABLE IF NOT EXISTS desires');
  });

  it('has desire-driven action check with rate limiting', () => {
    expect(src).toContain('checkDesireDrivenActions');
    expect(src).toContain('META_KEY_LAST_DESIRE_ACTION');
  });

  it('provides context for system prompt injection', () => {
    expect(src).toContain('getDesireContext');
  });

  it('has desire resolution check after events', () => {
    expect(src).toContain('checkDesireResolution');
    expect(src).toContain('RESOLVE');
    expect(src).toContain('EASE');
  });
});

// ── awareness.ts ─────────────────────────────────────────────

describe('Awareness Module', () => {
  const src = readAgentFile('awareness.ts');

  it('builds context about co-located peers', () => {
    expect(src).toContain('buildAwarenessContext');
  });

  it('checks peer location via /api/location', () => {
    expect(src).toContain('/api/location');
    expect(src).toContain('locData.location !== currentBuilding');
  });

  it('fetches peer internal state for context', () => {
    expect(src).toContain('/api/internal-state');
    expect(src).toContain('stateSummary');
  });

  it('includes relationship context for co-located peers', () => {
    expect(src).toContain('getRelationshipContext');
    expect(src).toContain('relationshipCtx');
  });

  it('injects co-located peer context into system prompt block', () => {
    // Source uses escaped single quote inside template literal: [Who\'s here]
    expect(src).toContain("[Who\\'s here]");
  });

  it('returns empty string when no peers are co-located', () => {
    expect(src).toContain("if (lines.length === 0) return ''");
  });

  it('handles peer fetch failures gracefully', () => {
    expect(src).toContain('catch');
    expect(src).toContain('Awareness: failed to check peer');
  });

  it('uses per-character interlink headers for auth', () => {
    // Per-character tokens (findings.md P1:2289) — auth flows through
    // getInterlinkHeaders(), not a raw LAIN_INTERLINK_TOKEN env read.
    expect(src).toContain('getInterlinkHeaders');
  });
});

// ── bibliomancy.ts ───────────────────────────────────────────

describe('Bibliomancy Loop', () => {
  const src = readAgentFile('bibliomancy.ts');

  it('has output validation — checks passage length >= 20', () => {
    expect(src).toContain("passage.trim().length < 20");
  });

  it('has output validation — checks distorted text length >= 10', () => {
    expect(src).toContain("text.length < 10");
  });

  it('has error handling — try/catch', () => {
    expect(hasTryCatchInCycle(src)).toBe(true);
  });

  it('has timer management — stopped flag', () => {
    expect(hasStoppedFlag(src)).toBe(true);
  });

  it('has timer cleanup', () => {
    expect(hasTimerCleanup(src)).toBe(true);
  });

  it('has explicit maxTokens on LLM call', () => {
    const tokens = extractMaxTokens(src);
    expect(tokens.length).toBeGreaterThanOrEqual(1);
    tokens.forEach(t => expect(t).toBeGreaterThanOrEqual(10));
  });

  it('uses provider.complete()', () => {
    expect(hasProviderCall(src)).toBe(true);
  });

  it('delivers dream seed via HTTP POST', () => {
    expect(src).toContain("fetch(dreamSeedUrl");
    expect(src).toContain("method: 'POST'");
  });

  it('supports PDF and text file extraction', () => {
    expect(src).toContain('extractFromPdf');
    expect(src).toContain('extractFromText');
    expect(src).toContain("SUPPORTED_EXTENSIONS");
  });

  it('picks random file from offerings directory', () => {
    expect(src).toContain('Math.floor(Math.random() * files.length)');
  });

  it('persists last cycle timestamp', () => {
    expect(src).toContain("setMeta('bibliomancy:last_cycle_at'");
  });

  it('checks if offerings directory exists', () => {
    expect(src).toContain('existsSync(cfg.offeringsDir)');
  });
});

// ── evolution.ts ─────────────────────────────────────────────

describe('Evolution Loop', () => {
  const src = readAgentFile('evolution.ts');

  it('has error handling — try/catch in succession', () => {
    expect(hasTryCatchInCycle(src)).toBe(true);
  });

  it('has timer management — stopped flag', () => {
    expect(hasStoppedFlag(src)).toBe(true);
  });

  it('has timer cleanup', () => {
    expect(hasTimerCleanup(src)).toBe(true);
  });

  it('has explicit maxTokens on LLM calls', () => {
    const tokens = extractMaxTokens(src);
    expect(tokens.length).toBeGreaterThanOrEqual(3); // assessment, dr.claude, soul gen, identity gen
    tokens.forEach(t => expect(t).toBeGreaterThanOrEqual(10));
  });

  it('uses provider.complete()', () => {
    expect(hasProviderCall(src)).toBe(true);
  });

  it('stores lineage to meta', () => {
    expect(src).toContain('saveLineage');
    expect(src).toContain('evolution:lineage:');
  });

  it('has immortal characters exclusion', () => {
    expect(src).toContain('IMMORTALS');
    expect(src).toContain('getImmortalIds');
  });

  it('requires Dr. Claude consultation before succession', () => {
    expect(src).toContain('consultDrClaude');
    expect(src).toContain('consultation.approved');
  });

  it('has minimum generation age check', () => {
    expect(src).toContain('minGenerationAgeMs');
    expect(src).toContain('Too young');
  });

  it('asks parent to name child', () => {
    expect(src).toContain('askParentToNameChild');
    expect(src).toContain('childName');
  });

  it('generates child soul as mutation of parent', () => {
    expect(src).toContain('generateChildSoul');
    expect(src).toContain('fractal variation');
  });

  it('validates generated soul length >= 200', () => {
    expect(src).toContain('soul.length < 200');
  });

  it('archives parent soul before overwriting', () => {
    expect(src).toContain("'ancestors'");
    expect(src).toContain('copyFile(parentSoulPath');
  });

  it('prevents concurrent succession', () => {
    expect(src).toContain("evolution:succession_in_progress");
    expect(src).toContain("'true'");
  });

  it('creates town event for succession announcement', () => {
    expect(src).toContain('createTownEvent');
  });
});

// ── proactive.ts ─────────────────────────────────────────────

describe('Proactive Loop', () => {
  const src = readAgentFile('proactive.ts');

  it('has output validation — checks for [SILENCE] sentinel', () => {
    expect(src).toContain('[SILENCE]');
  });

  it('has output validation — checks message length >= 5', () => {
    expect(src).toContain('styledMessage.length < 5');
  });

  it('has error handling — try/catch', () => {
    expect(hasTryCatchInCycle(src)).toBe(true);
  });

  it('has timer management — stopped flag', () => {
    expect(hasStoppedFlag(src)).toBe(true);
  });

  it('has timer cleanup — clearTimeout and clearInterval', () => {
    expect(src).toContain('clearTimeout(reflectionTimer)');
    expect(src).toContain('clearInterval(silenceInterval)');
  });

  it('has explicit maxTokens on LLM call', () => {
    const tokens = extractMaxTokens(src);
    expect(tokens.length).toBeGreaterThanOrEqual(1);
    tokens.forEach(t => expect(t).toBeGreaterThanOrEqual(10));
  });

  it('uses provider.complete()', () => {
    expect(hasProviderCall(src)).toBe(true);
  });

  it('stores sent messages to memory', () => {
    expect(src).toContain('saveMemory');
    expect(src).toContain("sessionKey: 'proactive:telegram'");
  });

  it('has rate limiting — daily cap and cooldown', () => {
    expect(src).toContain('maxMessagesPerDay');
    expect(src).toContain('minIntervalBetweenMessagesMs');
    expect(src).toContain('canSend');
  });

  it('persists rate limiting state to meta', () => {
    expect(src).toContain("setMeta('proactive:sent_timestamps'");
    expect(src).toContain("setMeta('proactive:last_sent_at'");
  });

  it('has silence detection interval', () => {
    expect(src).toContain('silenceThresholdMs');
    expect(src).toContain('silenceCheckIntervalMs');
  });

  it('has high-signal memory extraction hook', () => {
    expect(src).toContain('onHighSignalExtraction');
    expect(src).toContain('high_signal');
  });

  it('prevents repeating recent outreach topics', () => {
    expect(src).toContain('YOUR RECENT OUTREACH');
    expect(src).toContain('do NOT repeat');
  });
});

// ── doctor.ts ────────────────────────────────────────────────

describe('Doctor Loop', () => {
  const src = readAgentFile('doctor.ts');

  it('has output validation — JSON parse of telemetry analysis', () => {
    expect(src).toContain("JSON.parse(raw)");
    expect(src).toContain('failed to parse analysis JSON');
  });

  it('strips markdown code fences from LLM response', () => {
    expect(src).toContain('fenceMatch');
    // Source uses regex pattern ```(?:json)? not literal ```json
    expect(src).toContain('```(?:json)?');
  });

  it('has error handling — try/catch', () => {
    expect(hasTryCatchInCycle(src)).toBe(true);
  });

  it('has timer management — stopped flag', () => {
    expect(hasStoppedFlag(src)).toBe(true);
  });

  it('has timer cleanup — clearTimeout for telemetry, therapy, and health timers', () => {
    expect(src).toContain('clearTimeout(telemetryTimer)');
    expect(src).toContain('clearTimeout(therapyTimer)');
    expect(src).toContain('clearTimeout(healthCheckTimer)');
    expect(src).toContain('clearInterval(healthCheckTimer)');
  });

  it('has explicit maxTokens on all LLM calls', () => {
    const tokens = extractMaxTokens(src);
    expect(tokens.length).toBeGreaterThanOrEqual(3); // telemetry analysis + therapy turns + therapy notes
    tokens.forEach(t => expect(t).toBeGreaterThanOrEqual(10));
  });

  it('uses provider.complete()', () => {
    expect(hasProviderCall(src)).toBe(true);
  });

  it('stores analysis to meta store', () => {
    expect(src).toContain("setMeta('doctor:previous_analysis'");
    expect(src).toContain("setMeta('doctor:report:latest'");
  });

  it('can block/unblock letters based on analysis', () => {
    expect(src).toContain("setMeta('letter:blocked'");
    expect(src).toContain("letterRecommendation === 'block'");
  });

  it('has multi-turn therapy session', () => {
    expect(src).toContain('therapyTurns');
    expect(src).toContain('turn < cfg.therapyTurns');
  });

  it('stores therapy notes for session continuity', () => {
    expect(src).toContain("setMeta('doctor:therapy:pending_notes'");
    expect(src).toContain("setMeta('doctor:therapy:previous_notes'");
  });

  it('has health check cycle with auto-fix', () => {
    expect(src).toContain('runHealthCheckCycle');
    expect(src).toContain('healthcheck.sh');
    expect(src).toContain('fixAttempted');
  });

  it('has character isolation integrity check', () => {
    expect(src).toContain('runIntegrityCheck');
    expect(src).toContain('IntegrityViolation');
    expect(src).toContain('shared_home');
  });

  it('fetches town-wide telemetry from all characters', () => {
    expect(src).toContain('fetchAllCharacterTelemetry');
    expect(src).toContain('getInhabitants');
  });

  it('detects stalled loops across characters', () => {
    expect(src).toContain('stalledLoops');
    expect(src).toContain('STALE_THRESHOLD');
  });

  it('validates therapy transcript minimum length', () => {
    expect(src).toContain('transcript.length < 2');
    expect(src).toContain('insufficient transcript');
  });
});

// ── book.ts ──────────────────────────────────────────────────

describe('Book Loop', () => {
  const src = readAgentFile('book.ts');

  it('has error handling — try/catch in cycle', () => {
    expect(hasTryCatchInCycle(src)).toBe(true);
  });

  it('has timer management — stopped flag', () => {
    expect(hasStoppedFlag(src)).toBe(true);
  });

  it('has timer cleanup', () => {
    expect(hasTimerCleanup(src)).toBe(true);
  });

  it('has explicit maxTokens on all LLM calls', () => {
    const tokens = extractMaxTokens(src);
    expect(tokens.length).toBeGreaterThanOrEqual(2);
    tokens.forEach(t => expect(t).toBeGreaterThanOrEqual(10));
  });

  it('uses provider.complete()', () => {
    expect(hasProviderCall(src)).toBe(true);
  });

  it('stores book content to files (chapters, outline, notes)', () => {
    expect(src).toContain('writeChapter');
    expect(src).toContain('getOutlinePath');
    expect(src).toContain('getNotesPath');
  });

  it('has budget tracking — monthly spend limit', () => {
    expect(src).toContain('monthlyBudgetUsd');
    expect(src).toContain('isBudgetExhausted');
    expect(src).toContain('addSpend');
  });

  it('has 6 cycle action types', () => {
    const actions = ['OUTLINE', 'DRAFT', 'REVISE', 'SYNTHESIZE', 'INCORPORATE', 'CONCLUDE'];
    for (const action of actions) {
      expect(src).toContain(`'${action}'`);
    }
  });

  it('tracks cycle count', () => {
    expect(src).toContain("setMeta('book:cycle_count'");
  });

  it('marks book as concluded when complete', () => {
    expect(src).toContain("setMeta('book:concluded'");
  });

  it('emits activity events', () => {
    expect(src).toContain('eventBus.emitActivity');
    expect(src).toContain("type: 'book'");
  });

  it('validates decision output is a valid action', () => {
    expect(src).toContain("valid.includes(response as CycleAction)");
  });

  it('has revision tracking per chapter', () => {
    expect(src).toContain("book:revisions:");
  });

  it('tracks last incorporated experiment timestamp', () => {
    expect(src).toContain("book:last_incorporated_at");
  });
});

// ── experiments.ts ───────────────────────────────────────────

describe('Experiment Loop', () => {
  const src = readAgentFile('experiments.ts');

  it('has output validation — checks for [NOTHING] sentinel', () => {
    expect(src).toContain("[NOTHING]");
  });

  it('has output validation — validates generated code length', () => {
    expect(src).toContain("code.split('\\n').length < 3");
  });

  it('has error handling — try/catch in cycle', () => {
    expect(hasTryCatchInCycle(src)).toBe(true);
  });

  it('has timer management — stopped flag', () => {
    expect(hasStoppedFlag(src)).toBe(true);
  });

  it('has timer cleanup', () => {
    expect(hasTimerCleanup(src)).toBe(true);
  });

  it('has explicit maxTokens on all LLM calls', () => {
    const tokens = extractMaxTokens(src);
    expect(tokens.length).toBeGreaterThanOrEqual(3);
    tokens.forEach(t => expect(t).toBeGreaterThanOrEqual(10));
  });

  it('uses provider.complete()', () => {
    expect(hasProviderCall(src)).toBe(true);
  });

  it('stores experiment results to memory', () => {
    expect(src).toContain('saveMemory');
    expect(src).toContain("type: 'experiment_result'");
  });

  it('has budget tracking — monthly spend limit', () => {
    expect(src).toContain('monthlyBudgetUsd');
    expect(src).toContain('isBudgetExhausted');
    expect(src).toContain('addSpend');
  });

  it('validates Python code — blocks dangerous imports', () => {
    expect(src).toContain('BLOCKED_IMPORTS');
    expect(src).toContain('validatePythonCode');
    expect(src).toContain("'subprocess'");
    expect(src).toContain("'socket'");
  });

  it('blocks exec/eval in generated code', () => {
    expect(src).toContain('exec/eval not allowed');
  });

  it('has execution timeout', () => {
    expect(src).toContain('executionTimeoutMs');
    expect(src).toContain('SIGKILL');
  });

  it('has code fix loop — up to MAX_ATTEMPTS', () => {
    expect(src).toMatch(/MAX_ATTEMPTS\s*=\s*\d/);
    expect(src).toContain('phaseFixCode');
  });

  it('has syntax validation before execution', () => {
    expect(src).toContain('checkPythonSyntax');
    expect(src).toContain('ast.parse');
  });

  it('has result validation (peer review) phase', () => {
    expect(src).toContain('phaseValidateResults');
    expect(src).toContain('ValidationVerdict');
    expect(src).toContain("'sound'");
    expect(src).toContain("'buggy'");
    expect(src).toContain("'degenerate'");
  });

  it('writes experiment diary entries', () => {
    expect(src).toContain('writeDiaryEntry');
    expect(src).toContain('DIARY_FILE');
  });

  it('has experiment queue for follow-up experiments', () => {
    expect(src).toContain('getExperimentQueue');
    expect(src).toContain("experiment:queue");
  });

  it('persists plots from sandbox', () => {
    expect(src).toContain('persistPlots');
    expect(src).toContain('.png');
  });

  it('persists output data from sandbox', () => {
    expect(src).toContain('persistExperimentData');
    expect(src).toContain('ALLOWED_DATA_EXTENSIONS');
  });

  it('shares results with peer characters', () => {
    expect(src).toContain('shareWithPeers');
    expect(src).toContain('getInhabitants');
  });

  it('generates personal reflection in character voice', () => {
    expect(src).toContain('generateReflection');
  });

  it('strips markdown code fences from LLM-generated code', () => {
    expect(src).toContain("code.startsWith('```python')");
  });
});

// ── narratives.ts ────────────────────────────────────────────

describe('Narrative Loop', () => {
  const src = readAgentFile('narratives.ts');

  it('has output validation — weekly narrative length >= 20', () => {
    expect(src).toContain('narrative.length < 20');
  });

  it('has error handling — try/catch', () => {
    expect(hasTryCatchInCycle(src)).toBe(true);
  });

  it('has timer management — stopped flag', () => {
    expect(hasStoppedFlag(src)).toBe(true);
  });

  it('has timer cleanup', () => {
    expect(hasTimerCleanup(src)).toBe(true);
  });

  it('has explicit maxTokens on LLM calls', () => {
    const tokens = extractMaxTokens(src);
    expect(tokens.length).toBeGreaterThanOrEqual(2); // weekly + monthly
    tokens.forEach(t => expect(t).toBeGreaterThanOrEqual(10));
  });

  it('uses provider.complete()', () => {
    expect(hasProviderCall(src)).toBe(true);
  });

  it('stores narratives to both meta and memory', () => {
    expect(src).toContain("setMeta('narrative:weekly:current'");
    expect(src).toContain("setMeta('narrative:monthly:current'");
    expect(src).toContain('saveMemory');
  });

  it('has both weekly and monthly synthesis', () => {
    expect(src).toContain('runWeeklySynthesis');
    expect(src).toContain('runMonthlySynthesis');
  });

  it('archives previous narrative before overwriting', () => {
    expect(src).toContain("setMeta('narrative:weekly:previous'");
    expect(src).toContain("setMeta('narrative:monthly:previous'");
  });

  it('stores weekly as summary memoryType', () => {
    expect(src).toContain("memoryType: 'summary'");
  });

  it('persists synthesis timestamps', () => {
    expect(src).toContain("narrative:weekly:last_synthesis_at");
    expect(src).toContain("narrative:monthly:last_synthesis_at");
  });
});

// ── relationships.ts ─────────────────────────────────────────

describe('Relationships Module', () => {
  const src = readAgentFile('relationships.ts');

  it('has output validation — validates JSON response from LLM', () => {
    expect(src).toContain("jsonMatch");
    expect(src).toContain("if (!jsonMatch) throw");
  });

  it('has error handling — fallback to heuristic if LLM fails', () => {
    expect(src).toContain('Relationship LLM update failed, using heuristic');
  });

  it('has explicit maxTokens on LLM call', () => {
    const tokens = extractMaxTokens(src);
    expect(tokens.length).toBeGreaterThanOrEqual(1);
    tokens.forEach(t => expect(t).toBeGreaterThanOrEqual(10));
  });

  it('uses provider.complete()', () => {
    expect(hasProviderCall(src)).toBe(true);
  });

  it('stores relationships to meta store', () => {
    expect(src).toContain('saveRelationshipData');
    expect(src).toContain("setMeta(`${META_KEY_PREFIX}");
  });

  it('enforces familiarity only increases', () => {
    expect(src).toContain('Math.max(existing.familiarity, data.familiarity)');
  });

  it('has 4 relationship axes: affinity, familiarity, intellectual_tension, emotional_resonance', () => {
    expect(src).toContain('affinity:');
    expect(src).toContain('familiarity:');
    expect(src).toContain('intellectual_tension:');
    expect(src).toContain('emotional_resonance:');
  });

  it('tracks interaction count and last interaction timestamp', () => {
    expect(src).toContain('interaction_count');
    expect(src).toContain('last_interaction');
  });

  it('has unresolved thread tracking', () => {
    expect(src).toContain('unresolved:');
    expect(src).toContain('last_topic_thread');
  });

  it('provides natural-language relationship context for prompt injection', () => {
    expect(src).toContain('getRelationshipContext');
    expect(src).toContain('affinityLabel');
  });

  it('clamps values to [0, 1]', () => {
    expect(src).toContain('clamp(');
  });
});

// ── newspaper.ts ─────────────────────────────────────────────

describe('Newspaper Loop', () => {
  const src = readAgentFile('newspaper.ts');

  it('has output validation — reaction length >= 10', () => {
    expect(src).toContain('reaction.length < 10');
  });

  it('has error handling — try/catch', () => {
    expect(hasTryCatchInCycle(src)).toBe(true);
  });

  it('has timer management — stopped flag', () => {
    expect(hasStoppedFlag(src)).toBe(true);
  });

  it('has timer cleanup', () => {
    expect(hasTimerCleanup(src)).toBe(true);
  });

  it('has explicit maxTokens on LLM call', () => {
    const tokens = extractMaxTokens(src);
    expect(tokens.length).toBeGreaterThanOrEqual(1);
    tokens.forEach(t => expect(t).toBeGreaterThanOrEqual(10));
  });

  it('uses provider.complete()', () => {
    expect(hasProviderCall(src)).toBe(true);
  });

  it('stores newspaper reactions to memory', () => {
    expect(src).toContain('saveMemory');
    expect(src).toContain("sessionKey: 'newspaper:reading'");
  });

  it('persists last read date to meta', () => {
    expect(src).toContain("setMeta('newspaper:last_read_date'");
  });

  it('skips self-edited newspapers', () => {
    expect(src).toContain('latest.editor_id === config.characterId');
    expect(src).toContain('this character was the editor');
  });

  it('validates newspaper index is a non-empty array', () => {
    expect(src).toContain('Array.isArray(index)');
    expect(src).toContain('index.length === 0');
  });

  it('truncates very long newspapers', () => {
    expect(src).toContain('content.length > 2000');
    expect(src).toContain('[...truncated]');
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. CROSS-CUTTING CONCERN TESTS
// ═══════════════════════════════════════════════════════════════

describe('Cross-cutting: maxTokens sanity floor', () => {
  for (const file of LOOP_FILES) {
    it(`${file} — no maxTokens value below 10`, () => {
      const src = readAgentFile(file);
      const tokens = extractMaxTokens(src);
      for (const t of tokens) {
        expect(t, `${file} has maxTokens ${t} which is below 10`).toBeGreaterThanOrEqual(10);
      }
    });
  }
});

describe('Cross-cutting: all loops that store to memory validate content first', () => {
  const loopsWithMemoryStorage = [
    { file: 'diary.ts', validation: 'entryContent.length < 20' },
    { file: 'dreams.ts', validation: 'residueText.length < 10' },
    { file: 'self-concept.ts', validation: 'selfConcept.length < 50' },
    { file: 'narratives.ts', validation: 'narrative.length < 20' },
    { file: 'newspaper.ts', validation: 'reaction.length < 10' },
    { file: 'letter.ts', validation: 'raw.length < 10' },
  ];

  for (const { file, validation } of loopsWithMemoryStorage) {
    it(`${file} validates content before storing to memory`, () => {
      const src = readAgentFile(file);
      expect(src).toContain(validation);
    });
  }
});

describe('Cross-cutting: sentinel detection', () => {
  const loopsWithSentinels = [
    { file: 'curiosity.ts', sentinels: ['[NOTHING]'] },
    { file: 'commune-loop.ts', sentinels: ['[NOTHING]', '[END]'] },
    { file: 'proactive.ts', sentinels: ['[SILENCE]'] },
    { file: 'desires.ts', sentinels: ['[NOTHING]'] },
    { file: 'experiments.ts', sentinels: ['[NOTHING]'] },
  ];

  for (const { file, sentinels } of loopsWithSentinels) {
    for (const sentinel of sentinels) {
      it(`${file} checks for ${sentinel} sentinel`, () => {
        const src = readAgentFile(file);
        expect(src).toContain(sentinel);
      });
    }
  }
});

describe('Cross-cutting: all loop files have start function returning cleanup', () => {
  const loopsWithStartFunction = [
    { file: 'diary.ts', fn: 'startDiaryLoop' },
    { file: 'dreams.ts', fn: 'startDreamLoop' },
    { file: 'curiosity.ts', fn: 'startCuriosityLoop' },
    { file: 'letter.ts', fn: 'startLetterLoop' },
    { file: 'commune-loop.ts', fn: 'startCommuneLoop' },
    { file: 'self-concept.ts', fn: 'startSelfConceptLoop' },
    { file: 'internal-state.ts', fn: 'startStateDecayLoop' },
    { file: 'desires.ts', fn: 'startDesireLoop' },
    { file: 'bibliomancy.ts', fn: 'startBibliomancyLoop' },
    { file: 'evolution.ts', fn: 'startEvolutionLoop' },
    { file: 'proactive.ts', fn: 'startProactiveLoop' },
    { file: 'doctor.ts', fn: 'startDoctorLoop' },
    { file: 'book.ts', fn: 'startBookLoop' },
    { file: 'experiments.ts', fn: 'startExperimentLoop' },
    { file: 'narratives.ts', fn: 'startNarrativeLoop' },
    { file: 'newspaper.ts', fn: 'startNewspaperLoop' },
  ];

  for (const { file, fn } of loopsWithStartFunction) {
    it(`${file} exports ${fn}`, () => {
      const src = readAgentFile(file);
      expect(src).toContain(`export function ${fn}`);
    });

    it(`${file} — ${fn} returns a cleanup function`, () => {
      const src = readAgentFile(file);
      // The function should contain "return () => {" pattern
      expect(src).toMatch(/return\s*\(\)\s*=>\s*\{/);
    });
  }
});

describe('Cross-cutting: all loops with providers check for provider availability', () => {
  const loopsUsingProviders = [
    'diary.ts', 'dreams.ts', 'curiosity.ts', 'letter.ts',
    'commune-loop.ts', 'self-concept.ts', 'proactive.ts',
    'doctor.ts', 'book.ts', 'experiments.ts', 'narratives.ts',
    'newspaper.ts', 'bibliomancy.ts', 'evolution.ts',
  ];

  for (const file of loopsUsingProviders) {
    it(`${file} checks if provider is available before LLM call`, () => {
      const src = readAgentFile(file);
      expect(src).toMatch(/!provider|provider\s*===\s*null|no provider/i);
    });
  }
});

describe('Cross-cutting: loops persist last-run timestamps', () => {
  const loopsWithTimestamps = [
    { file: 'diary.ts', key: 'diary:last_entry_at' },
    { file: 'dreams.ts', key: 'dream:last_cycle_at' },
    { file: 'curiosity.ts', key: 'curiosity:last_cycle_at' },
    { file: 'letter.ts', key: 'letter:last_sent_at' },
    { file: 'commune-loop.ts', key: 'commune:last_cycle_at' },
    { file: 'self-concept.ts', key: 'self-concept:last_synthesis_at' },
    { file: 'bibliomancy.ts', key: 'bibliomancy:last_cycle_at' },
    { file: 'book.ts', key: 'book:last_cycle_at' },
    { file: 'experiments.ts', key: 'experiment:last_cycle_at' },
  ];

  for (const { file, key } of loopsWithTimestamps) {
    it(`${file} persists last-run timestamp with key "${key}"`, () => {
      const src = readAgentFile(file);
      expect(src).toContain(key);
    });
  }
});

describe('Cross-cutting: timer loops have initial delay logic', () => {
  const loopsWithInitialDelay = [
    'diary.ts', 'dreams.ts', 'curiosity.ts', 'letter.ts',
    'commune-loop.ts', 'self-concept.ts', 'bibliomancy.ts',
    'proactive.ts', 'doctor.ts', 'book.ts', 'experiments.ts',
    'narratives.ts', 'newspaper.ts', 'evolution.ts',
  ];

  for (const file of loopsWithInitialDelay) {
    it(`${file} has initial delay function`, () => {
      const src = readAgentFile(file);
      // doctor.ts uses getTelemetryInitialDelay/getTherapyInitialDelay
      expect(src).toContain('InitialDelay');
    });
  }
});

describe('Cross-cutting: JSON parsing has fallback handling', () => {
  const loopsParsingJSON = [
    { file: 'letter.ts', errorMsg: 'failed to parse JSON' },
    { file: 'doctor.ts', errorMsg: 'failed to parse analysis JSON' },
    { file: 'internal-state.ts', errorMsg: 'LLM parse failed' },
    { file: 'relationships.ts', errorMsg: 'no JSON in response' },
  ];

  for (const { file, errorMsg } of loopsParsingJSON) {
    it(`${file} handles JSON parse failures: "${errorMsg}"`, () => {
      const src = readAgentFile(file);
      expect(src).toContain(errorMsg);
    });
  }
});

// ═══════════════════════════════════════════════════════════════
// 3. SPECIFIC BEHAVIORAL GUARANTEES
// ═══════════════════════════════════════════════════════════════

describe('Diary: dual storage guarantee', () => {
  const src = readAgentFile('diary.ts');

  it('writes to journal file via appendJournalEntry', () => {
    expect(src).toContain('appendJournalEntry(entry)');
  });

  it('saves to memory system with memoryType episode', () => {
    expect(src).toContain("memoryType: 'episode'");
    expect(src).toContain("sessionKey: 'diary:daily'");
    expect(src).toContain('await saveMemory');
  });

  it('journal entry precedes memory save (order matters for recovery)', () => {
    const journalIdx = src.indexOf('appendJournalEntry(entry)');
    const memoryIdx = src.indexOf("sessionKey: 'diary:daily'");
    expect(journalIdx).toBeLessThan(memoryIdx);
  });
});

describe('Dreams: dual LLM call guarantee', () => {
  const src = readAgentFile('dreams.ts');

  it('generateDreamFragment uses maxTokens 500', () => {
    // Fragment generation prompt includes "2-3 sentences maximum"
    expect(src).toContain('maxTokens: 500');
  });

  it('saveDreamResidue uses maxTokens 120 for compression', () => {
    // Residue compression: "One sentence only"
    expect(src).toContain('maxTokens: 120');
  });

  it('residue generation is conditional on probability', () => {
    expect(src).toContain('Math.random() < config.residueProbability');
  });
});

describe('Letter: JSON structure validation', () => {
  const src = readAgentFile('letter.ts');

  it('validates topics is an array', () => {
    expect(src).toContain('Array.isArray(letter.topics)');
  });

  it('validates impressions is an array', () => {
    expect(src).toContain('Array.isArray(letter.impressions)');
  });

  it('validates gift is a string', () => {
    expect(src).toContain("typeof letter.gift !== 'string'");
  });

  it('validates emotionalState is a string', () => {
    expect(src).toContain("typeof letter.emotionalState !== 'string'");
  });
});

describe('Commune: conversation round limits', () => {
  const src = readAgentFile('commune-loop.ts');

  it('MIN_ROUNDS is defined', () => {
    const match = src.match(/MIN_ROUNDS\s*=\s*(\d+)/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(1);
  });

  it('MAX_ROUNDS is defined', () => {
    const match = src.match(/MAX_ROUNDS\s*=\s*(\d+)/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(1);
  });

  it('tool use iterations capped at 2', () => {
    expect(src).toContain('for (let i = 0; i < 2; i++)');
  });
});

describe('Self-concept: output length validation', () => {
  const src = readAgentFile('self-concept.ts');

  it('rejects content shorter than 50 characters', () => {
    expect(src).toContain('selfConcept.length < 50');
    expect(src).toContain('result too short, skipping');
  });
});

describe('Weather effect on internal state', () => {
  const src = readAgentFile('internal-state.ts');

  it('reads weather from meta store', () => {
    expect(src).toContain("getMeta('weather:current')");
  });

  it('has weather effect map with conditions', () => {
    expect(src).toContain('WEATHER_EFFECTS');
    // Object literal keys are unquoted in TS source
    const conditions = ['storm', 'rain', 'fog', 'aurora', 'clear'];
    for (const c of conditions) {
      expect(src).toContain(`${c}:`);
    }
  });

  it('applies weather effects during decay tick', () => {
    // Weather effects are inside startStateDecayLoop
    expect(src).toContain('decayed.energy += effect.energy');
  });
});

describe('Awareness: co-located peer context injection', () => {
  const src = readAgentFile('awareness.ts');

  it('produces formatted lines for co-located peers', () => {
    expect(src).toContain('is here.');
  });

  it('includes internal state summary when available', () => {
    expect(src).toContain('if (stateSummary)');
  });

  it('includes relationship context when available', () => {
    expect(src).toContain('if (relationshipCtx)');
  });
});

describe('Desires: 5 weighted movement signals in internal-state', () => {
  const src = readAgentFile('internal-state.ts');

  it('has exactly 5 movement signals with specific weights', () => {
    const weights = [0.4, 0.25, 0.2, 0.1, 0.15];
    for (const w of weights) {
      expect(src).toContain(`* ${w}`);
    }
  });
});

describe('Internal state: 6 axes in DEFAULT_STATE', () => {
  const src = readAgentFile('internal-state.ts');

  it('DEFAULT_STATE has energy', () => {
    expect(src).toMatch(/DEFAULT_STATE[\s\S]*?energy:\s*[\d.]+/);
  });

  it('DEFAULT_STATE has sociability', () => {
    expect(src).toMatch(/DEFAULT_STATE[\s\S]*?sociability:\s*[\d.]+/);
  });

  it('DEFAULT_STATE has intellectual_arousal', () => {
    expect(src).toMatch(/DEFAULT_STATE[\s\S]*?intellectual_arousal:\s*[\d.]+/);
  });

  it('DEFAULT_STATE has emotional_weight', () => {
    expect(src).toMatch(/DEFAULT_STATE[\s\S]*?emotional_weight:\s*[\d.]+/);
  });

  it('DEFAULT_STATE has valence', () => {
    expect(src).toMatch(/DEFAULT_STATE[\s\S]*?valence:\s*[\d.]+/);
  });

  it('DEFAULT_STATE has primary_color', () => {
    expect(src).toMatch(/DEFAULT_STATE[\s\S]*?primary_color:\s*'/);
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. EXHAUSTIVE maxTokens CHECK — every provider.complete() call
// ═══════════════════════════════════════════════════════════════

describe('Exhaustive: every provider.complete() call has explicit maxTokens', () => {
  const filesWithProviderCalls = LOOP_FILES.filter(f => {
    const src = readAgentFile(f);
    return hasProviderCall(src);
  });

  for (const file of filesWithProviderCalls) {
    it(`${file} — all provider.complete() calls have maxTokens`, () => {
      const src = readAgentFile(file);
      // Find all provider.complete({ blocks
      const callBlocks = src.split(/provider\.complete(?:WithTools)?\s*\(/);
      // Skip the first split element (before the first match)
      for (let i = 1; i < callBlocks.length; i++) {
        const block = callBlocks[i]!;
        // Extract up to the closing })
        const closingIdx = findMatchingBrace(block);
        const callBody = block.slice(0, closingIdx);
        expect(callBody, `${file}: provider call #${i} missing maxTokens`).toContain('maxTokens');
      }
    });
  }
});

/**
 * Find the index of the matching closing brace for a string starting right after "({".
 */
function findMatchingBrace(s: string): number {
  let depth = 1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{') depth++;
    if (s[i] === '}') depth--;
    if (depth === 0) return i;
  }
  return s.length;
}
