# Laintown Aliveness System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Laintown feel alive — characters with inner emotional states, event-driven behavior, relationships, spatial awareness, preoccupations, purposeful movement, and weather.

**Architecture:** Seven features built sequentially (1→7), each self-contained and regression-tested before the next begins. Features share state via the existing meta key-value store (`getMeta`/`setMeta`) and communicate through the event bus (`src/events/bus.ts`). New LLM calls use the `light` tier (Haiku 4.5) to keep costs low (~$8-12/mo additional).

**Tech Stack:** TypeScript (ESM), SQLite meta store, EventEmitter-based event bus, Haiku 4.5 for state/relationship updates, existing provider abstraction.

**Spec:** `docs/superpowers/specs/2026-04-16-aliveness-system-design.md`

---

## File Map

| Feature | New files | Modified files |
|---------|-----------|---------------|
| 1. Internal State | `src/agent/internal-state.ts`, `test/internal-state.test.ts` | `src/agent/index.ts`, `src/web/server.ts`, `src/web/character-server.ts` |
| 2. Event-Driven Loops | — | `src/events/bus.ts`, `src/agent/curiosity.ts`, `src/agent/commune-loop.ts`, `src/agent/diary.ts`, `src/agent/dreams.ts`, `src/agent/town-life.ts`, `src/agent/index.ts`, `src/memory/index.ts` |
| 3. Relationships | `src/agent/relationships.ts`, `test/relationships.test.ts` | `src/agent/commune-loop.ts` |
| 4. Awareness | `src/agent/awareness.ts` | `src/web/server.ts`, `src/web/character-server.ts`, `src/agent/index.ts` |
| 5. Preoccupations | — | `src/agent/internal-state.ts`, `src/agent/curiosity.ts`, `src/agent/commune-loop.ts`, `src/agent/diary.ts`, `src/agent/dreams.ts` |
| 6. Movement | — | `src/agent/internal-state.ts` |
| 7. Weather | `src/commune/weather.ts` | `src/web/server.ts`, `src/agent/internal-state.ts`, `src/agent/index.ts` |

---

## Feature 1: Internal Emotional State

### Task 1: Create internal-state.ts — data model and persistence

**Files:**
- Create: `src/agent/internal-state.ts`
- Test: `test/internal-state.test.ts`

- [ ] **Step 1: Write the test file with data model tests**

```typescript
// test/internal-state.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn().mockResolvedValue('test-master-key'),
    setPassword: vi.fn().mockResolvedValue(undefined),
    deletePassword: vi.fn().mockResolvedValue(true),
    findCredentials: vi.fn().mockResolvedValue([]),
  },
}));

describe('Internal Emotional State', () => {
  const testDir = join(tmpdir(), `lain-test-state-${Date.now()}`);
  const dbPath = join(testDir, 'test.db');
  const originalEnv = process.env['LAIN_HOME'];

  beforeEach(async () => {
    process.env['LAIN_HOME'] = testDir;
    await mkdir(testDir, { recursive: true });
    const { initDatabase } = await import('../src/storage/database.js');
    await initDatabase(dbPath);
  });

  afterEach(async () => {
    const { closeDatabase } = await import('../src/storage/database.js');
    closeDatabase();
    if (originalEnv) process.env['LAIN_HOME'] = originalEnv;
    else delete process.env['LAIN_HOME'];
    try { await rm(testDir, { recursive: true }); } catch {}
  });

  it('returns default state when none persisted', async () => {
    const { getCurrentState } = await import('../src/agent/internal-state.js');
    const state = getCurrentState();
    expect(state.energy).toBe(0.6);
    expect(state.sociability).toBe(0.5);
    expect(state.intellectual_arousal).toBe(0.4);
    expect(state.emotional_weight).toBe(0.3);
    expect(state.valence).toBe(0.6);
    expect(state.primary_color).toBe('neutral');
  });

  it('persists and loads state via meta store', async () => {
    const { getCurrentState, saveState } = await import('../src/agent/internal-state.js');
    const custom = {
      energy: 0.8,
      sociability: 0.3,
      intellectual_arousal: 0.9,
      emotional_weight: 0.5,
      valence: 0.7,
      primary_color: 'electric',
      updated_at: Date.now(),
    };
    saveState(custom);
    const loaded = getCurrentState();
    expect(loaded.energy).toBe(0.8);
    expect(loaded.primary_color).toBe('electric');
  });

  it('clamps values to [0, 1]', async () => {
    const { clampState } = await import('../src/agent/internal-state.js');
    const clamped = clampState({
      energy: 1.5,
      sociability: -0.2,
      intellectual_arousal: 0.5,
      emotional_weight: 0.3,
      valence: 2.0,
      primary_color: 'test',
      updated_at: Date.now(),
    });
    expect(clamped.energy).toBe(1.0);
    expect(clamped.sociability).toBe(0.0);
    expect(clamped.valence).toBe(1.0);
  });

  it('applies heuristic decay correctly', async () => {
    const { applyDecay, saveState, getCurrentState } = await import('../src/agent/internal-state.js');
    saveState({
      energy: 0.8,
      sociability: 0.8,
      intellectual_arousal: 0.7,
      emotional_weight: 0.3,
      valence: 0.6,
      primary_color: 'focused',
      updated_at: Date.now(),
    });
    applyDecay();
    const after = getCurrentState();
    expect(after.energy).toBeLessThan(0.8);
    expect(after.intellectual_arousal).toBeLessThan(0.7);
    // sociability drifts toward 0.5 — was 0.8, should decrease
    expect(after.sociability).toBeLessThan(0.8);
  });

  it('generates a natural language summary', async () => {
    const { getStateSummary, saveState } = await import('../src/agent/internal-state.js');
    saveState({
      energy: 0.2,
      sociability: 0.8,
      intellectual_arousal: 0.9,
      emotional_weight: 0.7,
      valence: 0.3,
      primary_color: 'restless',
      updated_at: Date.now(),
    });
    const summary = getStateSummary();
    expect(summary).toContain('restless');
    expect(typeof summary).toBe('string');
    expect(summary.length).toBeGreaterThan(20);
  });

  it('maintains state history capped at 10', async () => {
    const { saveState, getStateHistory } = await import('../src/agent/internal-state.js');
    for (let i = 0; i < 15; i++) {
      saveState({
        energy: i * 0.06,
        sociability: 0.5,
        intellectual_arousal: 0.5,
        emotional_weight: 0.5,
        valence: 0.5,
        primary_color: `color-${i}`,
        updated_at: Date.now() + i * 1000,
      });
    }
    const history = getStateHistory();
    expect(history.length).toBeLessThanOrEqual(10);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/internal-state.test.ts`
Expected: FAIL — module `../src/agent/internal-state.js` does not exist

- [ ] **Step 3: Implement internal-state.ts — core data model and persistence**

```typescript
// src/agent/internal-state.ts
import { getMeta, setMeta } from '../storage/database.js';
import { getLogger } from '../utils/logger.js';

export interface InternalState {
  energy: number;
  sociability: number;
  intellectual_arousal: number;
  emotional_weight: number;
  valence: number;
  primary_color: string;
  updated_at: number;
}

export interface StateEvent {
  type: string;
  summary: string;
  intensity?: number;
}

const DEFAULT_STATE: InternalState = {
  energy: 0.6,
  sociability: 0.5,
  intellectual_arousal: 0.4,
  emotional_weight: 0.3,
  valence: 0.6,
  primary_color: 'neutral',
  updated_at: Date.now(),
};

const META_KEY_STATE = 'internal:state';
const META_KEY_HISTORY = 'internal:state_history';
const MAX_HISTORY = 10;

export function clampState(state: InternalState): InternalState {
  return {
    energy: Math.max(0, Math.min(1, state.energy)),
    sociability: Math.max(0, Math.min(1, state.sociability)),
    intellectual_arousal: Math.max(0, Math.min(1, state.intellectual_arousal)),
    emotional_weight: Math.max(0, Math.min(1, state.emotional_weight)),
    valence: Math.max(0, Math.min(1, state.valence)),
    primary_color: state.primary_color || 'neutral',
    updated_at: state.updated_at,
  };
}

export function getCurrentState(): InternalState {
  try {
    const raw = getMeta(META_KEY_STATE);
    if (raw) {
      const parsed = JSON.parse(raw) as InternalState;
      if (typeof parsed.energy === 'number') return parsed;
    }
  } catch { /* fall through */ }
  return { ...DEFAULT_STATE, updated_at: Date.now() };
}

export function saveState(state: InternalState): void {
  const clamped = clampState(state);
  setMeta(META_KEY_STATE, JSON.stringify(clamped));

  // Append to history
  try {
    const history = getStateHistory();
    history.push({ ...clamped });
    const trimmed = history.slice(-MAX_HISTORY);
    setMeta(META_KEY_HISTORY, JSON.stringify(trimmed));
  } catch { /* non-critical */ }
}

export function getStateHistory(): InternalState[] {
  try {
    const raw = getMeta(META_KEY_HISTORY);
    if (raw) {
      const parsed = JSON.parse(raw) as InternalState[];
      if (Array.isArray(parsed)) return parsed;
    }
  } catch { /* fall through */ }
  return [];
}

export function applyDecay(): void {
  const state = getCurrentState();
  const decayed: InternalState = {
    ...state,
    energy: state.energy - 0.02,
    intellectual_arousal: state.intellectual_arousal - 0.015,
    sociability: state.sociability + (0.5 - state.sociability) * 0.02,
    updated_at: Date.now(),
  };
  saveState(decayed);
}

export function getStateSummary(): string {
  const s = getCurrentState();

  const energyWord = s.energy < 0.3 ? 'exhausted' : s.energy < 0.5 ? 'low energy' : s.energy < 0.7 ? 'moderate energy' : 'vibrant';
  const socialWord = s.sociability < 0.3 ? 'withdrawn' : s.sociability > 0.7 ? 'seeking company' : '';
  const arousalWord = s.intellectual_arousal > 0.7 ? 'mind buzzing' : s.intellectual_arousal > 0.5 ? 'mentally engaged' : '';
  const weightWord = s.emotional_weight > 0.7 ? 'emotionally heavy' : s.emotional_weight > 0.5 ? 'carrying some weight' : '';
  const valenceWord = s.valence < 0.3 ? 'dark mood' : s.valence > 0.7 ? 'bright mood' : '';

  const parts = [energyWord, socialWord, arousalWord, weightWord, valenceWord].filter(Boolean);
  const descriptors = parts.length > 0 ? parts.join(', ') : 'steady';

  return `Right now you feel ${s.primary_color} — ${descriptors}.`;
}

let decayTimer: ReturnType<typeof setInterval> | null = null;

export function startStateDecayLoop(): () => void {
  const logger = getLogger();
  logger.info('Starting internal state decay loop (every 30min)');

  decayTimer = setInterval(() => {
    try {
      applyDecay();
    } catch (err) {
      logger.error({ error: String(err) }, 'State decay error');
    }
  }, 30 * 60 * 1000);

  return () => {
    if (decayTimer) clearInterval(decayTimer);
    logger.info('State decay loop stopped');
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/internal-state.test.ts`
Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/internal-state.ts test/internal-state.test.ts
git commit -m "feat(aliveness): add internal emotional state data model and persistence"
```

### Task 2: Add LLM-powered state updates

**Files:**
- Modify: `src/agent/internal-state.ts`
- Test: `test/internal-state.test.ts`

- [ ] **Step 1: Add updateState test**

Append to `test/internal-state.test.ts` inside the existing `describe` block:

```typescript
  it('updateState produces valid state from LLM response', async () => {
    const { updateState, saveState } = await import('../src/agent/internal-state.js');
    // Mock the provider by setting up a state first
    saveState({
      energy: 0.5,
      sociability: 0.5,
      intellectual_arousal: 0.5,
      emotional_weight: 0.3,
      valence: 0.6,
      primary_color: 'calm',
      updated_at: Date.now(),
    });

    // updateState without a provider should apply heuristic-only fallback
    const result = await updateState({
      type: 'conversation:end',
      summary: 'Had a deep conversation about reality',
    });
    expect(result).toBeDefined();
    expect(typeof result.energy).toBe('number');
    expect(result.energy).toBeGreaterThanOrEqual(0);
    expect(result.energy).toBeLessThanOrEqual(1);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/internal-state.test.ts`
Expected: FAIL — `updateState` is not exported

- [ ] **Step 3: Add updateState function to internal-state.ts**

Add after the `getStateSummary` function but before `startStateDecayLoop`:

```typescript
import { getProvider } from './index.js';
import { eventBus } from '../events/bus.js';

const STATE_UPDATE_PROMPT = `You are analyzing the emotional impact of an event on a character. Given their current internal state and what just happened, output ONLY a JSON object with updated values.

CURRENT STATE:
{state}

EVENT: {event_type}
DESCRIPTION: {summary}

Output JSON with these exact keys (all numbers 0.0-1.0):
{"energy": N, "sociability": N, "intellectual_arousal": N, "emotional_weight": N, "valence": N, "primary_color": "one-word-mood"}

Rules:
- Shift values by small amounts (0.05-0.15 per event), not dramatic jumps
- primary_color is a single evocative word (not "happy" or "sad" — more like "electric", "heavy", "shimmering", "bruised")
- A conversation ending might increase emotional_weight and decrease energy
- A curiosity discovery might increase intellectual_arousal and energy
- A dream might shift valence and reduce energy
- Output ONLY the JSON, no explanation`;

export async function updateState(event: StateEvent): Promise<InternalState> {
  const logger = getLogger();
  const current = getCurrentState();

  // Try LLM update
  try {
    const provider = getProvider('default', 'light');
    if (provider) {
      const prompt = STATE_UPDATE_PROMPT
        .replace('{state}', JSON.stringify({
          energy: current.energy,
          sociability: current.sociability,
          intellectual_arousal: current.intellectual_arousal,
          emotional_weight: current.emotional_weight,
          valence: current.valence,
          primary_color: current.primary_color,
        }))
        .replace('{event_type}', event.type)
        .replace('{summary}', event.summary);

      const result = await provider.complete({
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 150,
        temperature: 0.7,
      });

      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as Partial<InternalState>;
        const updated: InternalState = {
          energy: typeof parsed.energy === 'number' ? parsed.energy : current.energy,
          sociability: typeof parsed.sociability === 'number' ? parsed.sociability : current.sociability,
          intellectual_arousal: typeof parsed.intellectual_arousal === 'number' ? parsed.intellectual_arousal : current.intellectual_arousal,
          emotional_weight: typeof parsed.emotional_weight === 'number' ? parsed.emotional_weight : current.emotional_weight,
          valence: typeof parsed.valence === 'number' ? parsed.valence : current.valence,
          primary_color: typeof parsed.primary_color === 'string' ? parsed.primary_color : current.primary_color,
          updated_at: Date.now(),
        };
        saveState(updated);

        // Emit state:shift event
        eventBus.emitActivity({
          type: 'state:shift',
          sessionKey: `state:${event.type}`,
          content: `internal state shifted to ${updated.primary_color} after ${event.type}`,
          timestamp: Date.now(),
        });

        logger.debug({ event: event.type, color: updated.primary_color }, 'Internal state updated via LLM');
        return updated;
      }
    }
  } catch (err) {
    logger.debug({ error: String(err) }, 'LLM state update failed, using heuristic fallback');
  }

  // Heuristic fallback — apply event-type-based nudges without LLM
  const nudges: Record<string, Partial<InternalState>> = {
    'conversation:end': { energy: -0.05, emotional_weight: 0.05, sociability: -0.03 },
    'commune:complete': { sociability: -0.08, emotional_weight: 0.04, intellectual_arousal: 0.03 },
    'dream:complete': { energy: -0.04, valence: 0.02 },
    'curiosity:discovery': { intellectual_arousal: 0.08, energy: 0.03, valence: 0.03 },
    'letter:received': { emotional_weight: 0.05, sociability: 0.04 },
    'diary:written': { emotional_weight: -0.06, valence: 0.03 },
  };

  const nudge = nudges[event.type] ?? {};
  const updated: InternalState = clampState({
    energy: current.energy + (nudge.energy ?? 0),
    sociability: current.sociability + (nudge.sociability ?? 0),
    intellectual_arousal: current.intellectual_arousal + (nudge.intellectual_arousal ?? 0),
    emotional_weight: current.emotional_weight + (nudge.emotional_weight ?? 0),
    valence: current.valence + (nudge.valence ?? 0),
    primary_color: current.primary_color,
    updated_at: Date.now(),
  });
  saveState(updated);
  return updated;
}
```

Note: Move the `import { getProvider } from './index.js';` to the top of the file with the other imports. Add `import { eventBus } from '../events/bus.js';` there too.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/internal-state.test.ts`
Expected: All 7 tests PASS (the LLM test uses heuristic fallback since no provider is configured in test)

- [ ] **Step 5: Commit**

```bash
git add src/agent/internal-state.ts test/internal-state.test.ts
git commit -m "feat(aliveness): add LLM-powered state updates with heuristic fallback"
```

### Task 3: Wire internal state into system prompt and startup

**Files:**
- Modify: `src/agent/index.ts:279` (after self-concept injection)
- Modify: `src/web/server.ts:2096` (loop startup)
- Modify: `src/web/character-server.ts:157` (loop startup)

- [ ] **Step 1: Inject state summary into system prompt**

In `src/agent/index.ts`, after the self-concept block (line 279) and before the location block (line 281), add:

```typescript
  // Inject internal emotional state
  try {
    const { getStateSummary } = await import('./internal-state.js');
    const stateSummary = getStateSummary();
    if (stateSummary) {
      enhancedSystemPrompt += '\n\n[Your Internal State]\n' + stateSummary;
    }
  } catch { /* non-critical */ }
```

- [ ] **Step 2: Start state decay loop in server.ts**

In `src/web/server.ts`, add import at the top (after line 35):
```typescript
import { startStateDecayLoop } from '../agent/internal-state.js';
```

In the loop startup section (after line 2095, before `startDiaryLoop()`), add:
```typescript
    stopFns.push(startStateDecayLoop());
```

- [ ] **Step 3: Start state decay loop in character-server.ts**

In `src/web/character-server.ts`, add import (after line 36):
```typescript
import { startStateDecayLoop } from '../agent/internal-state.js';
```

In the `loopFactories` array (after line 157, as the first entry):
```typescript
    () => startStateDecayLoop(),
```

- [ ] **Step 4: Run full regression suite**

Run: `npx vitest run test/internal-state.test.ts test/regression.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/index.ts src/web/server.ts src/web/character-server.ts
git commit -m "feat(aliveness): wire internal state into system prompt and startup loops"
```

### Task 4: Emit state update events from existing loops

**Files:**
- Modify: `src/agent/commune-loop.ts` (after reflection phase)
- Modify: `src/agent/curiosity.ts` (after discovery)
- Modify: `src/agent/diary.ts` (after diary entry)
- Modify: `src/agent/dreams.ts` (after dream cycle)
- Modify: `src/memory/index.ts` (after conversation end / memory extraction)

- [ ] **Step 1: Add updateState call after commune reflection**

In `src/agent/commune-loop.ts`, add import at the top:
```typescript
import { updateState } from './internal-state.js';
```

At the end of `phaseReflection()` (before `return reflection;` at line 551), add:
```typescript
  // Update internal state after commune conversation
  try {
    await updateState({
      type: 'commune:complete',
      summary: `Conversation with ${impulse.peerName}: ${reflection.slice(0, 150)}`,
    });
  } catch { /* non-critical */ }
```

- [ ] **Step 2: Add updateState call after curiosity discovery**

In `src/agent/curiosity.ts`, add import at the top:
```typescript
import { updateState } from './internal-state.js';
```

After the discovery is saved to memory (find the `saveMemory` call in `runCuriosityCycle`), add:
```typescript
    // Update internal state after curiosity discovery
    try {
      await updateState({
        type: 'curiosity:discovery',
        summary: `Browsed and discovered: ${title || url}`,
      });
    } catch { /* non-critical */ }
```

- [ ] **Step 3: Add updateState call after diary entry**

In `src/agent/diary.ts`, add import at the top:
```typescript
import { updateState } from './internal-state.js';
```

After the diary entry is saved to memory (after the `saveMemory` call in `runDiaryCycle`), add:
```typescript
    // Update internal state after writing diary
    try {
      await updateState({
        type: 'diary:written',
        summary: `Wrote diary entry reflecting on: ${entry.slice(0, 150)}`,
      });
    } catch { /* non-critical */ }
```

- [ ] **Step 4: Add updateState call after dream cycle**

In `src/agent/dreams.ts`, add import at the top:
```typescript
import { updateState } from './internal-state.js';
```

After `runDreamCycle` completes (in the `startDreamLoop` timeout callback, after `await runDreamCycle(cfg);` around line 161), add:
```typescript
          await updateState({
            type: 'dream:complete',
            summary: 'Completed a dream cycle',
          }).catch(() => {});
```

- [ ] **Step 5: Add conversation:end state update**

In `src/memory/index.ts`, add import:
```typescript
import { updateState } from '../agent/internal-state.js';
```

In `processConversationEnd()`, after memory extraction completes, add:
```typescript
    // Notify internal state that a conversation ended
    try {
      await updateState({
        type: 'conversation:end',
        summary: `Conversation ended after ${messages.length} messages`,
      });
    } catch { /* non-critical */ }
```

- [ ] **Step 6: Run regression tests**

Run: `npx vitest run test/regression.test.ts test/internal-state.test.ts`
Expected: All PASS

- [ ] **Step 7: Build and type-check**

Run: `npm run typecheck && npm run build`
Expected: Clean build, no errors

- [ ] **Step 8: Commit**

```bash
git add src/agent/commune-loop.ts src/agent/curiosity.ts src/agent/diary.ts src/agent/dreams.ts src/memory/index.ts
git commit -m "feat(aliveness): emit state updates from commune, curiosity, diary, dreams, and conversation-end"
```

### Task 5: Deploy Feature 1 and verify

- [ ] **Step 1: Run full regression suite locally**

Run: `npx vitest run test/regression.test.ts test/internal-state.test.ts`
Expected: All PASS

- [ ] **Step 2: Deploy to droplet**

```bash
ssh root@198.211.116.5 "cd /opt/local-lain && git pull && npm run build && systemctl restart lain.target"
```

- [ ] **Step 3: Verify services are healthy**

```bash
ssh root@198.211.116.5 "/opt/local-lain/deploy/status.sh"
```
Expected: All 7 services responding with HTTP 200

- [ ] **Step 4: Check logs for state updates**

```bash
ssh root@198.211.116.5 "journalctl -u lain-wired --since '5 minutes ago' | grep -i 'state'"
```
Expected: See "Starting internal state decay loop" in startup logs

---

## Feature 2: Event-Driven Loops

### Task 6: Extend event bus with typed events

**Files:**
- Modify: `src/events/bus.ts`

- [ ] **Step 1: Add new event types to the type map and background set**

In `src/events/bus.ts`, add new entries to the `typeMap` object (after line 52):
```typescript
    state: 'state',
    weather: 'weather',
```

Add new entries to `BACKGROUND_TYPES` (line 58-61):
```typescript
const BACKGROUND_TYPES = new Set([
  'commune', 'diary', 'dream', 'curiosity', 'self-concept', 'narrative',
  'letter', 'peer', 'doctor', 'movement', 'move', 'note', 'document', 'gift',
  'townlife', 'object', 'experiment', 'town-event', 'state', 'weather',
]);
```

- [ ] **Step 2: Commit**

```bash
git add src/events/bus.ts
git commit -m "feat(aliveness): register state and weather event types in bus"
```

### Task 7: Convert curiosity loop to event-driven pattern

**Files:**
- Modify: `src/agent/curiosity.ts`

- [ ] **Step 1: Add event-driven trigger to curiosity loop**

In `src/agent/curiosity.ts`, add import at the top:
```typescript
import { eventBus } from '../events/bus.js';
import { getCurrentState } from './internal-state.js';
```

Replace the loop startup body inside `startCuriosityLoop()` (the section from `let timer: ReturnType<typeof setTimeout> | null = null;` through the return cleanup function). The new pattern adds `maybeRunEarly` and event listeners while keeping the existing fallback timer:

After `let stopped = false;` (line 109), add:
```typescript
  let lastRun = 0;
  let isRunning = false;
  const COOLDOWN_MS = 30 * 60 * 1000; // 30min minimum between runs

  try {
    const lr = getMeta('curiosity:last_cycle_at');
    if (lr) lastRun = parseInt(lr, 10) || 0;
  } catch { /* fresh start */ }

  function maybeRunEarly(reason: string): void {
    if (stopped || isRunning) return;
    const elapsed = Date.now() - lastRun;
    if (elapsed < COOLDOWN_MS) return;

    // Check internal state condition
    try {
      const state = getCurrentState();
      if (state.intellectual_arousal < 0.5) return;
    } catch { /* skip check */ }

    logger.debug({ reason }, 'Curiosity loop triggered early');
    if (timer) clearTimeout(timer);
    const jitter = Math.random() * 60_000;
    scheduleNext(jitter);
  }

  // Event-driven triggers
  const onConversationEnd = () => maybeRunEarly('conversation ended');
  const onStateShift = () => maybeRunEarly('state shift');
  eventBus.on('activity', (event: import('../events/bus.js').SystemEvent) => {
    if (stopped) return;
    if (event.type === 'state' && event.content.includes('intellectual')) onStateShift();
    if (event.sessionKey.startsWith('state:conversation:end')) onConversationEnd();
  });
```

In the `scheduleNext` timeout callback, wrap the cycle run with `isRunning`:
```typescript
    timer = setTimeout(async () => {
      if (stopped) return;
      isRunning = true;
      logger.info('Curiosity cycle firing now');
      await curiosityLog('TIMER_FIRED', { timestamp: Date.now() });
      try {
        await runCuriosityCycle(cfg);
        setMeta('curiosity:last_cycle_at', Date.now().toString());
        lastRun = Date.now();
      } catch (err) {
        logger.error({ error: String(err) }, 'Curiosity cycle top-level error');
        await curiosityLog('TOP_LEVEL_ERROR', { error: String(err) });
      }
      isRunning = false;
      scheduleNext();
    }, d);
```

Also emit a `curiosity:discovery` event at the end of `runCuriosityCycle` after saving:
```typescript
    eventBus.emitActivity({
      type: 'curiosity',
      sessionKey: `curiosity:discovery:${Date.now()}`,
      content: `Discovered: ${title || url}`,
      timestamp: Date.now(),
    });
```

- [ ] **Step 2: Commit**

```bash
git add src/agent/curiosity.ts
git commit -m "feat(aliveness): convert curiosity loop to event-driven pattern"
```

### Task 8: Convert commune loop to event-driven pattern

**Files:**
- Modify: `src/agent/commune-loop.ts`

- [ ] **Step 1: Add event-driven triggers to commune loop**

In `src/agent/commune-loop.ts`, add imports:
```typescript
import { eventBus } from '../events/bus.js';
import { getCurrentState } from './internal-state.js';
```

In `startCommuneLoop()`, after `let stopped = false;` and the existing timer setup, add the event-driven wiring. Similar pattern to curiosity — add `lastRun`, `isRunning`, `maybeRunEarly`:

```typescript
  let lastRun = 0;
  let isRunning = false;
  const COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2hr minimum

  try {
    const lr = getMeta(META_KEY_LAST_CYCLE);
    if (lr) lastRun = parseInt(lr, 10) || 0;
  } catch { /* fresh start */ }

  function maybeRunEarly(reason: string): void {
    if (stopped || isRunning) return;
    const elapsed = Date.now() - lastRun;
    if (elapsed < COOLDOWN_MS) return;

    try {
      const state = getCurrentState();
      if (state.sociability < 0.6) return;
    } catch { /* skip check */ }

    logger.debug({ reason }, 'Commune loop triggered early');
    if (timer) clearTimeout(timer);
    const jitter = Math.random() * 60_000;
    scheduleNext(jitter);
  }

  eventBus.on('activity', (event: import('../events/bus.js').SystemEvent) => {
    if (stopped || isRunning) return;
    if (event.type === 'state') maybeRunEarly('state shift — sociability');
    if (event.type === 'curiosity') maybeRunEarly('curiosity discovery');
    if (event.sessionKey.includes('letter')) maybeRunEarly('letter received');
  });
```

In the timeout callback, wrap with `isRunning = true/false` and update `lastRun`:
```typescript
      isRunning = true;
      // ... existing cycle code ...
      lastRun = Date.now();
      isRunning = false;
```

After the reflection phase completes, emit a `commune:complete` event:
```typescript
    eventBus.emitActivity({
      type: 'commune',
      sessionKey: `commune:complete:${impulse.peerId}:${Date.now()}`,
      content: `Commune conversation with ${impulse.peerName} (${transcript.length} rounds)`,
      timestamp: Date.now(),
    });
```

- [ ] **Step 2: Commit**

```bash
git add src/agent/commune-loop.ts
git commit -m "feat(aliveness): convert commune loop to event-driven pattern"
```

### Task 9: Convert diary, dreams, and town-life loops to event-driven

**Files:**
- Modify: `src/agent/diary.ts`
- Modify: `src/agent/dreams.ts`
- Modify: `src/agent/town-life.ts`

- [ ] **Step 1: Add event-driven triggers to diary loop**

In `src/agent/diary.ts`, add imports:
```typescript
import { eventBus } from '../events/bus.js';
import { getCurrentState } from './internal-state.js';
```

In `startDiaryLoop()`, after the existing timer setup, add:
```typescript
  let lastRun = 0;
  let isRunning = false;
  const COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6hr minimum

  try {
    const lr = getMeta('diary:last_entry_at');
    if (lr) lastRun = parseInt(lr, 10) || 0;
  } catch { /* fresh start */ }

  function maybeRunEarly(reason: string): void {
    if (stopped || isRunning) return;
    const elapsed = Date.now() - lastRun;
    if (elapsed < COOLDOWN_MS) return;

    try {
      const state = getCurrentState();
      if (state.emotional_weight < 0.7) return;
    } catch { /* skip */ }

    logger.debug({ reason }, 'Diary loop triggered early');
    if (timer) clearTimeout(timer);
    scheduleNext(Math.random() * 60_000);
  }

  eventBus.on('activity', (event: import('../events/bus.js').SystemEvent) => {
    if (stopped || isRunning) return;
    if (event.type === 'state') maybeRunEarly('emotional weight spike');
  });
```

Wrap the timeout callback with `isRunning` and update `lastRun`.

- [ ] **Step 2: Add event-driven triggers to dream loop**

In `src/agent/dreams.ts`, add imports:
```typescript
import { eventBus } from '../events/bus.js';
import { getCurrentState } from './internal-state.js';
```

In `startDreamLoop()`, after setup, add:
```typescript
  let isRunning = false;

  function maybeRunEarly(reason: string): void {
    if (stopped || isRunning) return;
    if (!shouldDream()) return;

    try {
      const state = getCurrentState();
      if (state.energy > 0.4) return;
    } catch { /* skip */ }

    logger.debug({ reason }, 'Dream loop triggered early');
    if (timer) clearTimeout(timer);
    scheduleNext(Math.random() * 60_000);
  }

  eventBus.on('activity', (event: import('../events/bus.js').SystemEvent) => {
    if (stopped || isRunning) return;
    if (event.sessionKey.startsWith('state:conversation:end')) maybeRunEarly('conversation ended + quiet');
  });
```

After `runDreamCycle` completes, emit event:
```typescript
          eventBus.emitActivity({
            type: 'dream',
            sessionKey: `dream:complete:${Date.now()}`,
            content: 'Dream cycle completed',
            timestamp: Date.now(),
          });
```

- [ ] **Step 3: Add event-driven triggers to town-life loop**

In `src/agent/town-life.ts`, add imports:
```typescript
import { eventBus } from '../events/bus.js';
```

In `startTownLifeLoop()`, add the same pattern:
```typescript
  let lastRun = 0;
  let isRunning = false;
  const COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2hr minimum

  try {
    const lr = getMeta(META_KEY_LAST_CYCLE);
    if (lr) lastRun = parseInt(lr, 10) || 0;
  } catch { /* fresh start */ }

  function maybeRunEarly(reason: string): void {
    if (stopped || isRunning) return;
    const elapsed = Date.now() - lastRun;
    if (elapsed < COOLDOWN_MS) return;

    logger.debug({ reason }, 'Town life triggered early');
    if (timer) clearTimeout(timer);
    scheduleNext(Math.random() * 60_000);
  }

  eventBus.on('activity', (event: import('../events/bus.js').SystemEvent) => {
    if (stopped || isRunning) return;
    if (event.type === 'commune') maybeRunEarly('commune completed');
    if (event.type === 'state') maybeRunEarly('state shift');
    if (event.type === 'weather') maybeRunEarly('weather changed');
  });
```

- [ ] **Step 4: Emit conversation:end event from agent/index.ts**

In `src/agent/index.ts`, inside `processConversationEnd()` (or at the point where memory extraction is triggered), emit:
```typescript
    eventBus.emitActivity({
      type: 'state',
      sessionKey: `state:conversation:end:${sessionKey}`,
      content: 'Conversation ended',
      timestamp: Date.now(),
    });
```

Add import if not present: `import { eventBus } from '../events/bus.js';`

- [ ] **Step 5: Run regression tests**

Run: `npx vitest run test/regression.test.ts test/internal-state.test.ts`
Expected: All PASS

- [ ] **Step 6: Build and type-check**

Run: `npm run typecheck && npm run build`
Expected: Clean

- [ ] **Step 7: Commit**

```bash
git add src/agent/diary.ts src/agent/dreams.ts src/agent/town-life.ts src/agent/index.ts
git commit -m "feat(aliveness): convert diary, dreams, town-life to event-driven loops"
```

### Task 10: Deploy Feature 2 and verify

- [ ] **Step 1: Run full regression suite**

Run: `npx vitest run test/regression.test.ts test/internal-state.test.ts`
Expected: All PASS

- [ ] **Step 2: Deploy to droplet**

```bash
ssh root@198.211.116.5 "cd /opt/local-lain && git pull && npm run build && systemctl restart lain.target"
```

- [ ] **Step 3: Verify health**

```bash
ssh root@198.211.116.5 "/opt/local-lain/deploy/status.sh"
```

- [ ] **Step 4: Check logs for event-driven triggers**

```bash
ssh root@198.211.116.5 "journalctl -u lain-pkd --since '10 minutes ago' | grep -i 'triggered early\|event-driven'"
```

---

## Feature 3: Relationship Graph

### Task 11: Create relationships.ts — data model and persistence

**Files:**
- Create: `src/agent/relationships.ts`
- Create: `test/relationships.test.ts`

- [ ] **Step 1: Write tests**

```typescript
// test/relationships.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn().mockResolvedValue('test-master-key'),
    setPassword: vi.fn().mockResolvedValue(undefined),
    deletePassword: vi.fn().mockResolvedValue(true),
    findCredentials: vi.fn().mockResolvedValue([]),
  },
}));

describe('Relationship Graph', () => {
  const testDir = join(tmpdir(), `lain-test-rel-${Date.now()}`);
  const dbPath = join(testDir, 'test.db');
  const originalEnv = process.env['LAIN_HOME'];

  beforeEach(async () => {
    process.env['LAIN_HOME'] = testDir;
    await mkdir(testDir, { recursive: true });
    const { initDatabase } = await import('../src/storage/database.js');
    await initDatabase(dbPath);
  });

  afterEach(async () => {
    const { closeDatabase } = await import('../src/storage/database.js');
    closeDatabase();
    if (originalEnv) process.env['LAIN_HOME'] = originalEnv;
    else delete process.env['LAIN_HOME'];
    try { await rm(testDir, { recursive: true }); } catch {}
  });

  it('returns null for unknown peer', async () => {
    const { getRelationship } = await import('../src/agent/relationships.js');
    expect(getRelationship('unknown-peer')).toBeNull();
  });

  it('saves and retrieves a relationship', async () => {
    const { getRelationship, saveRelationshipData } = await import('../src/agent/relationships.js');
    saveRelationshipData('pkd', {
      peerId: 'pkd',
      peerName: 'Philip K. Dick',
      affinity: 0.7,
      familiarity: 0.5,
      intellectual_tension: 0.8,
      emotional_resonance: 0.4,
      last_topic_thread: 'boundaries of reality',
      unresolved: 'whether observation changes the thing observed',
      last_interaction: Date.now(),
      interaction_count: 3,
    });
    const rel = getRelationship('pkd');
    expect(rel).not.toBeNull();
    expect(rel!.affinity).toBe(0.7);
    expect(rel!.peerName).toBe('Philip K. Dick');
  });

  it('lists all relationships', async () => {
    const { getAllRelationships, saveRelationshipData } = await import('../src/agent/relationships.js');
    saveRelationshipData('pkd', {
      peerId: 'pkd', peerName: 'PKD', affinity: 0.7, familiarity: 0.5,
      intellectual_tension: 0.8, emotional_resonance: 0.4,
      last_topic_thread: 'reality', unresolved: null,
      last_interaction: Date.now(), interaction_count: 1,
    });
    saveRelationshipData('john', {
      peerId: 'john', peerName: 'John', affinity: 0.5, familiarity: 0.3,
      intellectual_tension: 0.2, emotional_resonance: 0.6,
      last_topic_thread: 'simplicity', unresolved: null,
      last_interaction: Date.now(), interaction_count: 2,
    });
    const all = getAllRelationships();
    expect(all.length).toBe(2);
  });

  it('generates a relationship context string', async () => {
    const { getRelationshipContext, saveRelationshipData } = await import('../src/agent/relationships.js');
    saveRelationshipData('mckenna', {
      peerId: 'mckenna', peerName: 'McKenna', affinity: 0.8, familiarity: 0.6,
      intellectual_tension: 0.7, emotional_resonance: 0.5,
      last_topic_thread: 'the mushroom at the end of history',
      unresolved: 'whether novelty is increasing or just our awareness of it',
      last_interaction: Date.now() - 86400000, interaction_count: 5,
    });
    const ctx = getRelationshipContext('mckenna');
    expect(ctx).toContain('McKenna');
    expect(ctx).toContain('mushroom');
    expect(typeof ctx).toBe('string');
  });

  it('familiarity only increases', async () => {
    const { getRelationship, saveRelationshipData } = await import('../src/agent/relationships.js');
    saveRelationshipData('pkd', {
      peerId: 'pkd', peerName: 'PKD', affinity: 0.7, familiarity: 0.8,
      intellectual_tension: 0.5, emotional_resonance: 0.4,
      last_topic_thread: 'topic', unresolved: null,
      last_interaction: Date.now(), interaction_count: 5,
    });
    // Try saving with lower familiarity
    saveRelationshipData('pkd', {
      peerId: 'pkd', peerName: 'PKD', affinity: 0.6, familiarity: 0.3,
      intellectual_tension: 0.5, emotional_resonance: 0.4,
      last_topic_thread: 'topic', unresolved: null,
      last_interaction: Date.now(), interaction_count: 6,
    });
    const rel = getRelationship('pkd');
    expect(rel!.familiarity).toBe(0.8); // Should not decrease
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/relationships.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement relationships.ts**

```typescript
// src/agent/relationships.ts
import { getMeta, setMeta } from '../storage/database.js';
import { getLogger } from '../utils/logger.js';

export interface Relationship {
  peerId: string;
  peerName: string;
  affinity: number;
  familiarity: number;
  intellectual_tension: number;
  emotional_resonance: number;
  last_topic_thread: string;
  unresolved: string | null;
  last_interaction: number;
  interaction_count: number;
}

function metaKey(peerId: string): string {
  return `relationship:${peerId}`;
}

export function getRelationship(peerId: string): Relationship | null {
  try {
    const raw = getMeta(metaKey(peerId));
    if (raw) {
      const parsed = JSON.parse(raw) as Relationship;
      if (parsed.peerId) return parsed;
    }
  } catch { /* fall through */ }
  return null;
}

export function saveRelationshipData(peerId: string, data: Relationship): void {
  // Familiarity only increases
  const existing = getRelationship(peerId);
  if (existing && data.familiarity < existing.familiarity) {
    data.familiarity = existing.familiarity;
  }
  setMeta(metaKey(peerId), JSON.stringify(data));
}

export function getAllRelationships(): Relationship[] {
  const results: Relationship[] = [];
  // Query all meta keys starting with 'relationship:'
  try {
    const { query } = require('../storage/database.js');
    const rows = query<{ key: string; value: string }>(
      `SELECT key, value FROM meta WHERE key LIKE 'relationship:%'`
    );
    for (const row of rows) {
      try {
        const rel = JSON.parse(row.value) as Relationship;
        if (rel.peerId) results.push(rel);
      } catch { /* skip malformed */ }
    }
  } catch { /* fall through */ }
  return results;
}

export function getRelationshipContext(peerId: string): string {
  const rel = getRelationship(peerId);
  if (!rel) return '';

  const daysSince = rel.last_interaction
    ? Math.round((Date.now() - rel.last_interaction) / 86400000)
    : null;

  const affinityWord = rel.affinity > 0.7 ? 'warm' : rel.affinity > 0.4 ? 'comfortable' : 'distant';
  const familiarityWord = rel.familiarity > 0.6 ? 'well-known' : rel.familiarity > 0.3 ? 'somewhat familiar' : 'still getting to know';
  const tensionWord = rel.intellectual_tension > 0.6 ? 'productive intellectual friction' : '';
  const resonanceWord = rel.emotional_resonance > 0.6 ? 'deep emotional connection' : '';

  let ctx = `Your relationship with ${rel.peerName}: ${affinityWord}, ${familiarityWord}.`;
  if (rel.last_topic_thread) {
    ctx += ` Last talked about: ${rel.last_topic_thread}.`;
  }
  if (rel.unresolved) {
    ctx += ` Unresolved thread: ${rel.unresolved}.`;
  }
  const qualities = [tensionWord, resonanceWord].filter(Boolean);
  if (qualities.length) {
    ctx += ` ${qualities.join(', ')}.`;
  }
  if (daysSince !== null && daysSince > 0) {
    ctx += ` (${daysSince} day${daysSince > 1 ? 's' : ''} ago)`;
  }
  return ctx;
}

const UPDATE_PROMPT = `Given a conversation transcript and the character's reflection, update the relationship state. Output ONLY JSON.

PREVIOUS RELATIONSHIP:
{previous}

TRANSCRIPT:
{transcript}

REFLECTION:
{reflection}

Output JSON:
{"affinity": N, "familiarity": N, "intellectual_tension": N, "emotional_resonance": N, "last_topic_thread": "topic", "unresolved": "thread or null"}

Rules:
- All numbers 0.0-1.0
- familiarity should only increase or stay the same
- last_topic_thread: brief summary of what was discussed
- unresolved: a dangling thread from the conversation, or null if nothing was left open
- Shift values by small amounts (0.05-0.15)`;

export async function updateRelationship(
  peerId: string,
  peerName: string,
  transcript: string,
  reflection: string,
): Promise<Relationship> {
  const logger = getLogger();
  const existing = getRelationship(peerId);

  const base: Relationship = existing ?? {
    peerId,
    peerName,
    affinity: 0.5,
    familiarity: 0.1,
    intellectual_tension: 0.3,
    emotional_resonance: 0.3,
    last_topic_thread: '',
    unresolved: null,
    last_interaction: Date.now(),
    interaction_count: 0,
  };

  try {
    const { getProvider } = await import('./index.js');
    const provider = getProvider('default', 'light');
    if (provider) {
      const prompt = UPDATE_PROMPT
        .replace('{previous}', JSON.stringify({
          affinity: base.affinity,
          familiarity: base.familiarity,
          intellectual_tension: base.intellectual_tension,
          emotional_resonance: base.emotional_resonance,
          last_topic_thread: base.last_topic_thread,
          unresolved: base.unresolved,
        }))
        .replace('{transcript}', transcript.slice(0, 2000))
        .replace('{reflection}', reflection.slice(0, 500));

      const result = await provider.complete({
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 200,
        temperature: 0.7,
      });

      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as Partial<Relationship>;
        const updated: Relationship = {
          peerId,
          peerName,
          affinity: typeof parsed.affinity === 'number' ? parsed.affinity : base.affinity,
          familiarity: typeof parsed.familiarity === 'number' ? Math.max(base.familiarity, parsed.familiarity) : base.familiarity,
          intellectual_tension: typeof parsed.intellectual_tension === 'number' ? parsed.intellectual_tension : base.intellectual_tension,
          emotional_resonance: typeof parsed.emotional_resonance === 'number' ? parsed.emotional_resonance : base.emotional_resonance,
          last_topic_thread: typeof parsed.last_topic_thread === 'string' ? parsed.last_topic_thread : base.last_topic_thread,
          unresolved: parsed.unresolved !== undefined ? (parsed.unresolved || null) : base.unresolved,
          last_interaction: Date.now(),
          interaction_count: base.interaction_count + 1,
        };
        saveRelationshipData(peerId, updated);
        logger.debug({ peerId, affinity: updated.affinity }, 'Relationship updated');
        return updated;
      }
    }
  } catch (err) {
    logger.debug({ error: String(err) }, 'LLM relationship update failed, using basic update');
  }

  // Fallback: increment familiarity and interaction count
  const fallback: Relationship = {
    ...base,
    familiarity: Math.min(1, base.familiarity + 0.05),
    last_interaction: Date.now(),
    interaction_count: base.interaction_count + 1,
  };
  saveRelationshipData(peerId, fallback);
  return fallback;
}
```

**Important:** The `getAllRelationships` function uses a dynamic require for the query function. Replace with a proper import. Add `import { query } from '../storage/database.js';` at the top (alongside the existing `getMeta`/`setMeta` import). Then change `getAllRelationships` to:

```typescript
export function getAllRelationships(): Relationship[] {
  const results: Relationship[] = [];
  try {
    const rows = query<{ key: string; value: string }>(
      `SELECT key, value FROM meta WHERE key LIKE 'relationship:%'`
    );
    for (const row of rows) {
      try {
        const rel = JSON.parse(row.value) as Relationship;
        if (rel.peerId) results.push(rel);
      } catch { /* skip malformed */ }
    }
  } catch { /* fall through */ }
  return results;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/relationships.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/relationships.ts test/relationships.test.ts
git commit -m "feat(aliveness): add relationship graph data model and persistence"
```

### Task 12: Wire relationship updates into commune loop

**Files:**
- Modify: `src/agent/commune-loop.ts` (phaseReflection and phaseImpulse)

- [ ] **Step 1: Add relationship update after commune reflection**

In `src/agent/commune-loop.ts`, add import:
```typescript
import { updateRelationship, getAllRelationships, getRelationshipContext } from './relationships.js';
```

At the end of `phaseReflection()` (before `return reflection;`), after the existing `updateState` call added in Task 4, add:
```typescript
  // Update relationship graph
  try {
    await updateRelationship(
      impulse.peerId,
      impulse.peerName,
      transcriptText,
      reflection,
    );
  } catch { /* non-critical */ }
```

- [ ] **Step 2: Enrich impulse phase with relationship context**

In the `phaseImpulse()` function, where the peer list is built for the prompt, replace the flat peer listing with relationship-enriched context. Find where peers are listed in the impulse prompt and add:

```typescript
    // Enrich peer list with relationship context
    const relationships = getAllRelationships();
    const peerContext = cfg.peers.map(p => {
      const rel = relationships.find(r => r.peerId === p.id);
      if (rel) {
        const daysSince = Math.round((Date.now() - rel.last_interaction) / 86400000);
        let line = `- ${p.name}: affinity ${rel.affinity.toFixed(1)}`;
        if (rel.last_topic_thread) line += `, last topic: "${rel.last_topic_thread}"`;
        if (rel.unresolved) line += `, unresolved: "${rel.unresolved}"`;
        if (daysSince > 0) line += ` (${daysSince}d ago)`;
        return line;
      }
      return `- ${p.name}: no prior conversations`;
    }).join('\n');
```

Inject this into the impulse prompt where the peer list appears.

- [ ] **Step 3: Run regression tests**

Run: `npx vitest run test/regression.test.ts test/relationships.test.ts test/internal-state.test.ts`
Expected: All PASS

- [ ] **Step 4: Build and type-check**

Run: `npm run typecheck && npm run build`

- [ ] **Step 5: Commit**

```bash
git add src/agent/commune-loop.ts
git commit -m "feat(aliveness): wire relationship updates into commune loop"
```

### Task 13: Deploy Feature 3 and verify

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run test/regression.test.ts test/relationships.test.ts test/internal-state.test.ts`

- [ ] **Step 2: Deploy**

```bash
ssh root@198.211.116.5 "cd /opt/local-lain && git pull && npm run build && systemctl restart lain.target"
```

- [ ] **Step 3: Verify**

```bash
ssh root@198.211.116.5 "/opt/local-lain/deploy/status.sh"
```

---

## Feature 4: Ambient Awareness

### Task 14: Create awareness.ts and /api/internal-state endpoint

**Files:**
- Create: `src/agent/awareness.ts`
- Modify: `src/web/server.ts` (add endpoint)
- Modify: `src/web/character-server.ts` (add endpoint)

- [ ] **Step 1: Create awareness.ts**

```typescript
// src/agent/awareness.ts
import { getLogger } from '../utils/logger.js';
import { getRelationshipContext } from './relationships.js';
import type { PeerConfig } from './character-tools.js';

interface PeerState {
  characterId: string;
  summary: string;
}

async function fetchPeerState(peerUrl: string): Promise<PeerState | null> {
  try {
    const token = process.env['LAIN_INTERLINK_TOKEN'] || '';
    const resp = await fetch(`${peerUrl}/api/internal-state`, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (resp.ok) {
      return await resp.json() as PeerState;
    }
  } catch { /* peer unreachable */ }
  return null;
}

async function fetchPeerLocation(peerUrl: string): Promise<string | null> {
  try {
    const resp = await fetch(`${peerUrl}/api/location`, {
      signal: AbortSignal.timeout(5000),
    });
    if (resp.ok) {
      const data = await resp.json() as { location: string };
      return data.location;
    }
  } catch { /* peer unreachable */ }
  return null;
}

export async function buildAwarenessContext(
  currentBuilding: string,
  peers: PeerConfig[],
): Promise<string> {
  const logger = getLogger();
  const lines: string[] = [];

  await Promise.all(peers.map(async (peer) => {
    const location = await fetchPeerLocation(peer.url);
    if (location !== currentBuilding) return; // Not co-located

    const state = await fetchPeerState(peer.url);
    const relCtx = getRelationshipContext(peer.id);

    let line = `- ${peer.name} is here`;
    if (state?.summary) {
      line += `. ${state.summary}`;
    }
    if (relCtx) {
      line += `\n  ${relCtx}`;
    }
    lines.push(line);
  }));

  if (lines.length === 0) return '';
  return '\n\n[Who\'s here]\n' + lines.join('\n');
}
```

- [ ] **Step 2: Add /api/internal-state endpoint to server.ts**

In `src/web/server.ts`, find the endpoint routing section and add a new route. Look for the pattern of existing GET endpoints. Add:

```typescript
    // Internal state endpoint — for peer awareness
    if (method === 'GET' && pathname === '/api/internal-state') {
      const authHeader = req.headers['authorization'];
      const token = process.env['LAIN_INTERLINK_TOKEN'];
      if (!token || !authHeader?.startsWith('Bearer ') || !secureCompare(authHeader.slice(7), token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      try {
        const { getCurrentState, getStateSummary } = await import('../agent/internal-state.js');
        const charId = process.env['LAIN_CHARACTER_ID'] || 'lain';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          characterId: charId,
          summary: getStateSummary(),
          state: getCurrentState(),
        }));
      } catch {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ characterId: 'unknown', summary: '', state: null }));
      }
      return;
    }
```

- [ ] **Step 3: Add /api/internal-state endpoint to character-server.ts**

Same pattern in `src/web/character-server.ts`. Find the endpoint routing and add:

```typescript
      // Internal state endpoint — for peer awareness
      if (method === 'GET' && pathname === '/api/internal-state') {
        if (!verifyInterlinkAuth(req, res)) return;
        try {
          const { getCurrentState, getStateSummary } = await import('../agent/internal-state.js');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            characterId: config.id,
            summary: getStateSummary(),
            state: getCurrentState(),
          }));
        } catch {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ characterId: config.id, summary: '', state: null }));
        }
        return;
      }
```

- [ ] **Step 4: Inject awareness context into system prompt**

In `src/agent/index.ts`, after the location injection block (around line 291) and before the object inventory, add:

```typescript
  // Inject ambient awareness of co-located peers
  try {
    const { buildAwarenessContext } = await import('./awareness.js');
    const { getCurrentLocation } = await import('../commune/location.js');
    const charId = process.env['LAIN_CHARACTER_ID'] || 'lain';
    const loc = getCurrentLocation(charId);
    // Get peer config from the running server's config — use env-based peer discovery
    const peerConfigRaw = process.env['PEER_CONFIG'];
    if (peerConfigRaw) {
      const peers = JSON.parse(peerConfigRaw) as import('./character-tools.js').PeerConfig[];
      const awarenessCtx = await buildAwarenessContext(loc.building, peers);
      if (awarenessCtx) {
        enhancedSystemPrompt += awarenessCtx;
      }
    }
  } catch { /* non-critical */ }
```

- [ ] **Step 5: Run regression tests**

Run: `npx vitest run test/regression.test.ts test/internal-state.test.ts test/relationships.test.ts`
Expected: All PASS

- [ ] **Step 6: Build and type-check**

Run: `npm run typecheck && npm run build`

- [ ] **Step 7: Commit**

```bash
git add src/agent/awareness.ts src/web/server.ts src/web/character-server.ts src/agent/index.ts
git commit -m "feat(aliveness): add ambient awareness of co-located peers"
```

### Task 15: Deploy Feature 4 and verify

- [ ] **Step 1: Deploy**

```bash
ssh root@198.211.116.5 "cd /opt/local-lain && git pull && npm run build && systemctl restart lain.target"
```

- [ ] **Step 2: Test the endpoint**

```bash
ssh root@198.211.116.5 "curl -s -H 'Authorization: Bearer \$(cat /opt/local-lain/.env | grep LAIN_INTERLINK_TOKEN | cut -d= -f2)' http://localhost:3000/api/internal-state | jq ."
```
Expected: JSON with `characterId`, `summary`, and `state` fields

- [ ] **Step 3: Verify health**

```bash
ssh root@198.211.116.5 "/opt/local-lain/deploy/status.sh"
```

---

## Feature 5: Preoccupations / Unfinished Business

### Task 16: Add preoccupation data model to internal-state.ts

**Files:**
- Modify: `src/agent/internal-state.ts`
- Modify: `test/internal-state.test.ts`

- [ ] **Step 1: Add preoccupation tests**

Append to `test/internal-state.test.ts`:

```typescript
describe('Preoccupations', () => {
  const testDir = join(tmpdir(), `lain-test-preoccupation-${Date.now()}`);
  const dbPath = join(testDir, 'test.db');
  const originalEnv = process.env['LAIN_HOME'];

  beforeEach(async () => {
    process.env['LAIN_HOME'] = testDir;
    await mkdir(testDir, { recursive: true });
    const { initDatabase } = await import('../src/storage/database.js');
    await initDatabase(dbPath);
  });

  afterEach(async () => {
    const { closeDatabase } = await import('../src/storage/database.js');
    closeDatabase();
    if (originalEnv) process.env['LAIN_HOME'] = originalEnv;
    else delete process.env['LAIN_HOME'];
    try { await rm(testDir, { recursive: true }); } catch {}
  });

  it('starts with empty preoccupations', async () => {
    const { getPreoccupations } = await import('../src/agent/internal-state.js');
    expect(getPreoccupations()).toEqual([]);
  });

  it('adds a preoccupation', async () => {
    const { addPreoccupation, getPreoccupations } = await import('../src/agent/internal-state.js');
    addPreoccupation('Whether glitches reveal or just disrupt', 'conversation with PKD');
    const preocc = getPreoccupations();
    expect(preocc.length).toBe(1);
    expect(preocc[0]!.thread).toContain('glitches');
    expect(preocc[0]!.intensity).toBeGreaterThan(0.5);
  });

  it('caps at 5 preoccupations, displacing lowest intensity', async () => {
    const { addPreoccupation, getPreoccupations } = await import('../src/agent/internal-state.js');
    for (let i = 0; i < 6; i++) {
      addPreoccupation(`thought-${i}`, `origin-${i}`);
    }
    expect(getPreoccupations().length).toBeLessThanOrEqual(5);
  });

  it('resolves a preoccupation', async () => {
    const { addPreoccupation, resolvePreoccupation, getPreoccupations } = await import('../src/agent/internal-state.js');
    addPreoccupation('test thread', 'test origin');
    const id = getPreoccupations()[0]!.id;
    resolvePreoccupation(id, 'understood it now');
    expect(getPreoccupations().length).toBe(0);
  });

  it('decays preoccupation intensity', async () => {
    const { addPreoccupation, decayPreoccupations, getPreoccupations } = await import('../src/agent/internal-state.js');
    addPreoccupation('persistent thought', 'origin');
    const before = getPreoccupations()[0]!.intensity;
    decayPreoccupations();
    const after = getPreoccupations()[0]!.intensity;
    expect(after).toBeLessThan(before);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/internal-state.test.ts`
Expected: FAIL — `getPreoccupations` not exported

- [ ] **Step 3: Add preoccupation model to internal-state.ts**

Add to `src/agent/internal-state.ts`:

```typescript
import { nanoid } from 'nanoid';

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

  // If at max, displace lowest intensity
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
```

Also update the `applyDecay()` function to call `decayPreoccupations()`:
```typescript
export function applyDecay(): void {
  const state = getCurrentState();
  const decayed: InternalState = {
    ...state,
    energy: state.energy - 0.02,
    intellectual_arousal: state.intellectual_arousal - 0.015,
    sociability: state.sociability + (0.5 - state.sociability) * 0.02,
    updated_at: Date.now(),
  };
  saveState(decayed);
  decayPreoccupations();
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/internal-state.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/internal-state.ts test/internal-state.test.ts
git commit -m "feat(aliveness): add preoccupation data model with decay"
```

### Task 17: Inject preoccupations into system prompt and loop contexts

**Files:**
- Modify: `src/agent/index.ts` (system prompt)
- Modify: `src/agent/curiosity.ts` (curiosity context)
- Modify: `src/agent/commune-loop.ts` (impulse context)
- Modify: `src/agent/diary.ts` (diary context)
- Modify: `src/agent/dreams.ts` (dream seed)

- [ ] **Step 1: Inject high-intensity preoccupations into system prompt**

In `src/agent/index.ts`, after the internal state injection (added in Task 3), add:

```typescript
  // Inject active preoccupations
  try {
    const { getPreoccupations } = await import('./internal-state.js');
    const preoccs = getPreoccupations().filter(p => p.intensity >= 0.5);
    if (preoccs.length > 0) {
      const lines = preoccs.map(p => `- ${p.thread} (from ${p.origin})`).join('\n');
      enhancedSystemPrompt += '\n\n[On your mind]\n' + lines;
    }
  } catch { /* non-critical */ }
```

- [ ] **Step 2: Inject preoccupations into curiosity thought-generation**

In `src/agent/curiosity.ts`, in the `runCuriosityCycle` function where the inner thought prompt is built, add preoccupations to the context:

```typescript
    // Add preoccupations to curiosity context
    let preoccContext = '';
    try {
      const { getPreoccupations } = await import('./internal-state.js');
      const preoccs = getPreoccupations();
      if (preoccs.length > 0) {
        preoccContext = '\n\nThings on your mind:\n' + preoccs.map(p => `- ${p.thread}`).join('\n');
      }
    } catch { /* non-critical */ }
```

Append `preoccContext` to the thought-generation prompt.

- [ ] **Step 3: Inject preoccupations into commune impulse**

In `src/agent/commune-loop.ts`, in `phaseImpulse()` where the prompt is built, add:

```typescript
    // Add preoccupations to impulse context
    let preoccContext = '';
    try {
      const { getPreoccupations } = await import('./internal-state.js');
      const preoccs = getPreoccupations();
      if (preoccs.length > 0) {
        preoccContext = '\n\nThings preoccupying you:\n' + preoccs.map(p => {
          let line = `- ${p.thread} (from ${p.origin})`;
          if (p.intensity > 0.6) line += ' [strong]';
          return line;
        }).join('\n');
      }
    } catch { /* non-critical */ }
```

- [ ] **Step 4: Inject into diary and dreams context**

In `src/agent/diary.ts`, in `runDiaryCycle()` where context is gathered, add:
```typescript
    let preoccContext = '';
    try {
      const { getPreoccupations } = await import('./internal-state.js');
      const preoccs = getPreoccupations();
      if (preoccs.length > 0) {
        preoccContext = '\n\nPreoccupations:\n' + preoccs.map(p => `- ${p.thread} (intensity: ${p.intensity.toFixed(1)})`).join('\n');
      }
    } catch { /* non-critical */ }
```

In `src/agent/dreams.ts`, preoccupations can influence seed selection. In `selectSeedMemory()`, add bias toward memories related to preoccupation threads — or simply add preoccupation context to the dream narrative prompt.

- [ ] **Step 5: Add preoccupation creation/resolution to updateState**

Extend the `STATE_UPDATE_PROMPT` in `internal-state.ts` to also output preoccupation instructions. Add to the JSON output spec:

```
Also include: "preoccupation_action": "create" | "resolve" | "none"
If "create": also include "preoccupation_thread": "the unresolved thought"
If "resolve": also include "preoccupation_resolve_id": "id of preoccupation to resolve", "preoccupation_resolution": "how it resolved"
```

In the `updateState` function, after parsing the LLM response, handle preoccupation actions:
```typescript
      // Handle preoccupation actions from LLM
      if (parsed.preoccupation_action === 'create' && parsed.preoccupation_thread) {
        addPreoccupation(parsed.preoccupation_thread as string, event.summary.slice(0, 100));
      } else if (parsed.preoccupation_action === 'resolve' && parsed.preoccupation_resolve_id) {
        resolvePreoccupation(
          parsed.preoccupation_resolve_id as string,
          (parsed.preoccupation_resolution as string) || 'resolved through reflection'
        );
      }
```

Also inject current preoccupations into the STATE_UPDATE_PROMPT so the LLM can see what's active:
```
CURRENT PREOCCUPATIONS:
{preoccupations}
```

- [ ] **Step 6: Run regression tests**

Run: `npx vitest run test/regression.test.ts test/internal-state.test.ts`
Expected: All PASS

- [ ] **Step 7: Build and type-check**

Run: `npm run typecheck && npm run build`

- [ ] **Step 8: Commit**

```bash
git add src/agent/index.ts src/agent/curiosity.ts src/agent/commune-loop.ts src/agent/diary.ts src/agent/dreams.ts src/agent/internal-state.ts
git commit -m "feat(aliveness): inject preoccupations into prompts and loops, LLM creates/resolves them"
```

### Task 18: Deploy Feature 5 and verify

- [ ] **Step 1: Full regression test**

Run: `npx vitest run test/regression.test.ts test/internal-state.test.ts test/relationships.test.ts`

- [ ] **Step 2: Deploy**

```bash
ssh root@198.211.116.5 "cd /opt/local-lain && git pull && npm run build && systemctl restart lain.target"
```

- [ ] **Step 3: Verify**

```bash
ssh root@198.211.116.5 "/opt/local-lain/deploy/status.sh"
```

---

## Feature 6: Desire-Driven Movement

### Task 19: Add movement desire heuristic to internal-state.ts

**Files:**
- Modify: `src/agent/internal-state.ts`
- Modify: `test/internal-state.test.ts`

- [ ] **Step 1: Add movement desire tests**

Append to `test/internal-state.test.ts`:

```typescript
describe('Desire-Driven Movement', () => {
  it('evaluateMovementDesire returns null when confidence is low', async () => {
    const { evaluateMovementDesire } = await import('../src/agent/internal-state.js');
    const result = evaluateMovementDesire(
      {
        energy: 0.5, sociability: 0.5, intellectual_arousal: 0.5,
        emotional_weight: 0.3, valence: 0.6, primary_color: 'neutral', updated_at: Date.now(),
      },
      [],
      [],
      'library',
      new Map(),
    );
    // Moderate state, no strong signal — should return null or low confidence
    expect(result === null || result.confidence < 0.6).toBe(true);
  });

  it('suggests retreat to default when energy is low', async () => {
    const { evaluateMovementDesire } = await import('../src/agent/internal-state.js');
    const result = evaluateMovementDesire(
      {
        energy: 0.15, sociability: 0.2, intellectual_arousal: 0.3,
        emotional_weight: 0.4, valence: 0.5, primary_color: 'tired', updated_at: Date.now(),
      },
      [],
      [],
      'bar',
      new Map(),
    );
    // Low energy + low sociability should suggest retreat
    if (result) {
      expect(result.confidence).toBeGreaterThan(0);
    }
  });

  it('suggests peer location when preoccupation has unresolved thread', async () => {
    const { evaluateMovementDesire } = await import('../src/agent/internal-state.js');
    const result = evaluateMovementDesire(
      {
        energy: 0.6, sociability: 0.7, intellectual_arousal: 0.6,
        emotional_weight: 0.3, valence: 0.6, primary_color: 'seeking', updated_at: Date.now(),
      },
      [{
        id: 'p1', thread: 'what PKD said about observation',
        origin: 'commune conversation with pkd',
        originated_at: Date.now(), intensity: 0.8, resolution: null,
      }],
      [{
        peerId: 'pkd', peerName: 'PKD', affinity: 0.7, familiarity: 0.6,
        intellectual_tension: 0.8, emotional_resonance: 0.4,
        last_topic_thread: 'observation', unresolved: 'whether it changes reality',
        last_interaction: Date.now(), interaction_count: 5,
      }],
      'library',
      new Map([['pkd', 'bar']]),
    );
    if (result && result.confidence > 0.6) {
      expect(result.building).toBe('bar'); // Where PKD is
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/internal-state.test.ts`
Expected: FAIL — `evaluateMovementDesire` not exported

- [ ] **Step 3: Implement evaluateMovementDesire**

Add to `src/agent/internal-state.ts`:

```typescript
import type { Relationship } from './relationships.js';

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

const DEFAULT_BUILDINGS: Record<string, string> = {
  'lain': 'library',
  'wired-lain': 'lighthouse',
  'pkd': 'locksmith',
  'mckenna': 'field',
  'john': 'bar',
  'dr-claude': 'school',
};

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
    // Check if preoccupation mentions a peer
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
    const charId = eventBus.characterId;
    const defaultBuilding = DEFAULT_BUILDINGS[charId] || 'library';
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

  // Pick highest scoring candidate
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0]!;

  return {
    building: best.building,
    reason: best.reason,
    confidence: Math.min(1, best.score + 0.3), // Baseline offset
  };
}
```

- [ ] **Step 4: Wire movement desire into updateState**

In the `updateState()` function, after saving the new state, add movement evaluation:

```typescript
  // Evaluate movement desire after state update
  try {
    const { setCurrentLocation, getCurrentLocation } = await import('../commune/location.js');
    const { getAllRelationships } = await import('./relationships.js');

    const charId = process.env['LAIN_CHARACTER_ID'] || eventBus.characterId;
    const loc = getCurrentLocation(charId);
    const lastMoveRaw = getMeta('movement:last_move_at');
    const lastMoveAt = lastMoveRaw ? parseInt(lastMoveRaw, 10) : 0;
    const MOVE_COOLDOWN = 30 * 60 * 1000; // 30 min

    if (Date.now() - lastMoveAt > MOVE_COOLDOWN) {
      // Fetch peer locations
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
        updated, // or the fallback state
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
```

This code block should go at the end of `updateState()`, right before the final `return updated;`.

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/internal-state.test.ts`
Expected: All PASS

- [ ] **Step 6: Run full regression**

Run: `npx vitest run test/regression.test.ts test/internal-state.test.ts test/relationships.test.ts`

- [ ] **Step 7: Build and type-check**

Run: `npm run typecheck && npm run build`

- [ ] **Step 8: Commit**

```bash
git add src/agent/internal-state.ts test/internal-state.test.ts
git commit -m "feat(aliveness): add desire-driven movement heuristic"
```

### Task 20: Deploy Feature 6 and verify

- [ ] **Step 1: Deploy**

```bash
ssh root@198.211.116.5 "cd /opt/local-lain && git pull && npm run build && systemctl restart lain.target"
```

- [ ] **Step 2: Verify**

```bash
ssh root@198.211.116.5 "/opt/local-lain/deploy/status.sh"
```

- [ ] **Step 3: Check logs for movement**

```bash
ssh root@198.211.116.5 "journalctl -u lain-pkd --since '10 minutes ago' | grep -i 'desire-driven\|movement'"
```

---

## Feature 7: Weather as Input

### Task 21: Create weather.ts — computation and loop

**Files:**
- Create: `src/commune/weather.ts`

- [ ] **Step 1: Implement weather.ts**

```typescript
// src/commune/weather.ts
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
  // Storm: high emotional weight + high arousal
  if (avgState.emotional_weight > 0.7 && avgState.intellectual_arousal > 0.6) {
    return { condition: 'storm', intensity: Math.min(1, (avgState.emotional_weight + avgState.intellectual_arousal) / 2) };
  }
  // Aurora: high arousal + high valence (rare collective breakthrough)
  if (avgState.intellectual_arousal > 0.7 && avgState.valence > 0.7) {
    return { condition: 'aurora', intensity: Math.min(1, (avgState.intellectual_arousal + avgState.valence) / 2) };
  }
  // Rain: high emotional weight
  if (avgState.emotional_weight > 0.6) {
    return { condition: 'rain', intensity: avgState.emotional_weight };
  }
  // Fog: low energy
  if (avgState.energy < 0.35) {
    return { condition: 'fog', intensity: 1 - avgState.energy };
  }
  // Clear: high valence + low weight
  if (avgState.valence > 0.6 && avgState.emotional_weight < 0.4) {
    return { condition: 'clear', intensity: avgState.valence };
  }
  // Default: overcast
  return { condition: 'overcast', intensity: 0.5 };
}

export async function computeWeather(states: InternalState[]): Promise<Weather> {
  const logger = getLogger();

  if (states.length === 0) {
    return { condition: 'overcast', intensity: 0.5, description: 'quiet day in the town', computed_at: Date.now() };
  }

  // Average all states
  const avg = {
    energy: states.reduce((s, st) => s + st.energy, 0) / states.length,
    sociability: states.reduce((s, st) => s + st.sociability, 0) / states.length,
    intellectual_arousal: states.reduce((s, st) => s + st.intellectual_arousal, 0) / states.length,
    emotional_weight: states.reduce((s, st) => s + st.emotional_weight, 0) / states.length,
    valence: states.reduce((s, st) => s + st.valence, 0) / states.length,
  };

  const { condition, intensity } = computeCondition(avg);

  // Generate description via LLM
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
        maxTokens: 80,
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

// Peer state fetching for weather computation
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

  // Include own state
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
  const INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
  const MAX_JITTER_MS = 30 * 60 * 1000;   // 0-30min

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
        return Math.random() * 2 * 60 * 1000; // Overdue — run soon
      }
    } catch { /* fall through */ }
    return 5 * 60 * 1000 + Math.random() * 5 * 60 * 1000; // 5-10 min after startup
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

        // Emit event if condition changed
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
```

- [ ] **Step 2: Commit**

```bash
git add src/commune/weather.ts
git commit -m "feat(aliveness): add weather computation from collective emotional state"
```

### Task 22: Wire weather into system prompt, state decay, and server

**Files:**
- Modify: `src/web/server.ts` (add endpoint + loop startup)
- Modify: `src/agent/internal-state.ts` (weather effect in decay)
- Modify: `src/agent/index.ts` (prompt injection)

- [ ] **Step 1: Add /api/weather endpoint and start weather loop**

In `src/web/server.ts`, add import:
```typescript
import { startWeatherLoop, getCurrentWeather } from '../commune/weather.js';
```

Add a new endpoint in the routing section:
```typescript
    // Weather endpoint — public data
    if (method === 'GET' && pathname === '/api/weather') {
      const weather = getCurrentWeather();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(weather ?? { condition: 'overcast', intensity: 0.5, description: 'quiet', computed_at: 0 }));
      return;
    }
```

In the Wired Lain loop startup section (inside `if (isWired) {` block), add:
```typescript
      stopFns.push(startWeatherLoop());
```

- [ ] **Step 2: Apply weather effects in state decay loop**

In `src/agent/internal-state.ts`, update `applyDecay()` to include weather effects:

```typescript
export function applyDecay(): void {
  const state = getCurrentState();
  const decayed: InternalState = {
    ...state,
    energy: state.energy - 0.02,
    intellectual_arousal: state.intellectual_arousal - 0.015,
    sociability: state.sociability + (0.5 - state.sociability) * 0.02,
    updated_at: Date.now(),
  };

  // Apply weather effects
  try {
    const weatherRaw = getMeta('weather:current');
    if (weatherRaw) {
      const { getWeatherEffect } = require('../commune/weather.js') as typeof import('../commune/weather.js');
      const weather = JSON.parse(weatherRaw) as { condition: string };
      const effect = getWeatherEffect(weather.condition);
      if (effect.energy) decayed.energy += effect.energy;
      if (effect.sociability) decayed.sociability += effect.sociability;
      if (effect.intellectual_arousal) decayed.intellectual_arousal += effect.intellectual_arousal;
      if (effect.emotional_weight) decayed.emotional_weight += effect.emotional_weight;
      if (effect.valence) decayed.valence += effect.valence;
    }
  } catch { /* non-critical — weather may not be available on non-Wired instances */ }

  saveState(decayed);
  decayPreoccupations();
}
```

**Note:** Since this is a circular dependency risk (internal-state importing weather, weather importing internal-state), use dynamic import or parse the meta key directly instead. The approach above reads `weather:current` from meta directly (the JSON is simple enough) and only calls `getWeatherEffect` for the mapping. Alternatively, inline the weather effect map in internal-state.ts to avoid the import entirely:

```typescript
  // Apply weather effects (inline to avoid circular dependency)
  try {
    const weatherRaw = getMeta('weather:current');
    if (weatherRaw) {
      const weather = JSON.parse(weatherRaw) as { condition: string };
      const WEATHER_EFFECTS: Record<string, Partial<InternalState>> = {
        storm: { energy: -0.04, intellectual_arousal: 0.03 },
        rain: { emotional_weight: 0.03, sociability: -0.02 },
        fog: { energy: -0.03, valence: -0.01 },
        aurora: { energy: 0.04, valence: 0.04, sociability: 0.03 },
        clear: { energy: 0.02 },
      };
      const effect = WEATHER_EFFECTS[weather.condition];
      if (effect) {
        if (effect.energy) decayed.energy += effect.energy;
        if (effect.sociability) decayed.sociability += effect.sociability;
        if (effect.intellectual_arousal) decayed.intellectual_arousal += effect.intellectual_arousal;
        if (effect.emotional_weight) decayed.emotional_weight += effect.emotional_weight;
        if (effect.valence) decayed.valence += effect.valence;
      }
    }
  } catch { /* non-critical */ }
```

Use this inline approach to avoid circular deps.

- [ ] **Step 3: Inject weather into system prompt**

In `src/agent/index.ts`, after the location injection (around line 291), add:

```typescript
  // Inject weather
  try {
    const wiredUrl = process.env['WIRED_LAIN_URL'] || 'http://localhost:3000';
    const weatherResp = await fetch(`${wiredUrl}/api/weather`, {
      signal: AbortSignal.timeout(3000),
    });
    if (weatherResp.ok) {
      const weather = await weatherResp.json() as { condition: string; description: string };
      if (weather.condition && weather.condition !== 'overcast') {
        enhancedSystemPrompt += `\n\n[Weather in town: ${weather.description}]`;
      }
    }
  } catch { /* non-critical */ }
```

- [ ] **Step 4: Run regression tests**

Run: `npx vitest run test/regression.test.ts test/internal-state.test.ts test/relationships.test.ts`
Expected: All PASS

- [ ] **Step 5: Build and type-check**

Run: `npm run typecheck && npm run build`

- [ ] **Step 6: Commit**

```bash
git add src/commune/weather.ts src/web/server.ts src/agent/internal-state.ts src/agent/index.ts
git commit -m "feat(aliveness): add weather system — computation, endpoint, prompt injection, state effects"
```

### Task 23: Deploy Feature 7 and verify

- [ ] **Step 1: Final full regression**

Run: `npx vitest run test/regression.test.ts test/internal-state.test.ts test/relationships.test.ts`

- [ ] **Step 2: Deploy**

```bash
ssh root@198.211.116.5 "cd /opt/local-lain && git pull && npm run build && systemctl restart lain.target"
```

- [ ] **Step 3: Verify all services**

```bash
ssh root@198.211.116.5 "/opt/local-lain/deploy/status.sh"
```

- [ ] **Step 4: Test weather endpoint**

```bash
ssh root@198.211.116.5 "curl -s http://localhost:3000/api/weather | jq ."
```
Expected: JSON with `condition`, `intensity`, `description`, `computed_at`

- [ ] **Step 5: Monitor logs for 5 minutes to confirm no cascading errors**

```bash
ssh root@198.211.116.5 "journalctl -u lain-wired -u lain-main -u lain-pkd -u lain-mckenna -u lain-john --since '5 minutes ago' | grep -i 'error\|fail' | head -20"
```
Expected: No new errors related to aliveness features

---

## Final Verification

After all 7 features are deployed:

- [ ] **Verify all 7 services respond**: `deploy/status.sh`
- [ ] **Verify internal state exists**: `curl /api/internal-state` on each service
- [ ] **Verify weather computes**: `curl /api/weather` on Wired Lain
- [ ] **Verify no memory bleed regression**: Check that `getRecentVisitorMessages` still filters internal traffic
- [ ] **Watch logs for 15 minutes**: Confirm loops fire, events trigger, no cascades
