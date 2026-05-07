# Laintown Aliveness System — Design Spec

**Date:** 2026-04-16
**Status:** Approved design, pending implementation
**Goal:** Make the town feel alive — characters as living creatures with inner lives, relationships, and organic rhythms instead of bots on timers.

## Overview

Seven interconnected features, built sequentially. Each feature is self-contained and tested before the next begins. The dependency order is: 1 → 2 → 3 → 4 → 5 → 6 → 7.

**Projected cost:** ~$8-12/month additional LLM spend (~5% increase over current ~$200/month baseline).

## Build Order & Dependencies

```
                    ┌─────────────────────────┐
                    │   7. Weather as Input    │
                    └────────────┬────────────┘
           ┌─────────────────────┼─────────────────────┐
           │                     │                      │
  ┌────────▼────────┐  ┌────────▼────────┐  ┌─────────▼────────┐
  │ 6. Desire-Driven│  │ 5. Preoccupa-   │  │ 2. Event-Driven  │
  │    Movement     │  │    tions        │  │    Loops         │
  └────────┬────────┘  └────────┬────────┘  └────────┬─────────┘
           │                     │                     │
           │           ┌────────▼────────┐             │
           │           │ 4. Ambient      │             │
           ├──────────►│    Awareness    │◄────────────┘
           │           └────────┬────────┘
           │                    │
  ┌────────▼────────┐  ┌───────▼─────────┐
  │ 3. Relationship │  │ 1. Internal     │
  │    Graph        │  │    State        │
  └─────────────────┘  └─────────────────┘
```

---

## Feature 1: Internal Emotional State

**New file:** `src/agent/internal-state.ts` (~200 lines)

### Data Model

Stored in `meta key: internal:state` as JSON:

```typescript
interface InternalState {
  energy: number;              // 0=exhausted, 1=vibrant
  sociability: number;         // 0=withdrawn, 1=seeking company
  intellectual_arousal: number; // 0=quiet mind, 1=buzzing with ideas
  emotional_weight: number;    // 0=light, 1=heavy
  valence: number;             // 0=dark, 1=bright
  primary_color: string;       // LLM-generated one-word mood descriptor
  updated_at: number;
}
```

State history (last 10 snapshots) stored in `meta key: internal:state_history` for trend analysis by diary and self-concept loops.

### Update Mechanism

`updateState(event: StateEvent)` fires after significant events:
- `conversation:end` — user chat session went quiet
- Commune conversation completed
- Diary entry written
- Dream cycle completed
- Curiosity discovery
- Letter received

Each update:
1. Loads previous state from meta
2. Applies heuristic drift (energy decays ~0.02/hr, sociability drifts toward 0.5 when alone)
3. Makes one Haiku call: previous state + event summary → new state fields + primary_color
4. Saves new state to meta, appends to history (capped at 10)

### Heuristic Drift

Runs as a lightweight timer (`startStateDecayLoop()`, every 30 minutes):
- `energy -= 0.02` (clamped to [0.1, 1.0])
- `sociability` drifts toward 0.5 by 0.01 when no interactions
- `intellectual_arousal -= 0.015` (clamped to [0.1, 1.0])
- No LLM call — pure arithmetic

### Consumption

Injected into system prompt via `getStateSummary()` → natural language sentence:
*"Right now you feel contemplative — energy is moderate, mind buzzing from a conversation with PKD about boundaries, emotionally a bit heavy."*

~50-80 tokens. Injected after self-concept, before memory context.

### Exports

```typescript
getCurrentState(): InternalState
updateState(event: StateEvent): Promise<InternalState>
getStateSummary(): string
startStateDecayLoop(): () => void
```

---

## Feature 2: Event-Driven Loops

**Modified files:** All loop files in `src/agent/`, plus `src/events/bus.ts`

### New Event Types

Added to the event bus:

| Event | Emitted by | Payload |
|-------|-----------|---------|
| `conversation:end` | agent/index.ts (session idle 5min) | `{ sessionKey, userId }` |
| `commune:complete` | commune-loop.ts | `{ peerId, peerName, rounds }` |
| `memory:high_signal` | memory/index.ts | `{ memoryId, importance }` |
| `dream:complete` | dreams.ts | `{ residueCreated: boolean }` |
| `letter:received` | server.ts interlink handler | `{ fromId, fromName }` |
| `curiosity:discovery` | curiosity.ts | `{ topic, url }` |
| `state:shift` | internal-state.ts | `{ delta: Partial<InternalState> }` |
| `weather:changed` | weather.ts | `{ condition, previous }` |

### Loop Trigger Pattern

Each loop adopts this pattern (replaces pure `setInterval`):

```typescript
function startLoop(config) {
  let timer: ReturnType<typeof setTimeout>;
  let lastRun = loadLastRunFromMeta();
  const cooldownMs = config.minInterval;

  function scheduleNext(delay: number) {
    timer = setTimeout(() => { run(); }, delay);
  }

  function maybeRunEarly(reason: string) {
    const elapsed = Date.now() - lastRun;
    if (elapsed < cooldownMs) return; // cooldown not met
    clearTimeout(timer);
    const jitter = Math.random() * 60_000; // 0-1min jitter to prevent cascade
    scheduleNext(jitter);
  }

  // Register event interests
  eventBus.on('conversation:end', () => maybeRunEarly('conversation ended'));
  eventBus.on('state:shift', (e) => {
    if (e.delta.intellectual_arousal > 0.2) maybeRunEarly('intellectual arousal spike');
  });

  // Fallback timer (existing interval, now serves as maximum silence gap)
  scheduleNext(getFallbackDelay());
}
```

### Per-Loop Changes

| Loop | Primary event triggers | Condition check | Cooldown | Fallback |
|------|----------------------|-----------------|----------|----------|
| Curiosity | `conversation:end`, `state:shift` (arousal high) | `intellectual_arousal > 0.5` | 30min | 2hr |
| Commune | `state:shift` (sociability high), `curiosity:discovery`, `letter:received` | `sociability > 0.6` | 2hr | 12hr |
| Diary | `state:shift` (emotional weight spike > 0.3 delta) | `emotional_weight > 0.7` | 6hr | 24hr (still anchored to evening) |
| Dreams | `conversation:end` + quiet check | `energy < 0.4` or 30min silence | 1.5hr | 4hr |
| Town life | `commune:complete`, `state:shift`, `weather:changed` | any significant state change | 2hr | 8hr |

### Cascade Dampening

Events emitted by a loop during its own cycle do not trigger that same loop's `maybeRunEarly`. Each loop ignores events that occur while it's actively running (tracked via a simple `isRunning` boolean).

---

## Feature 3: Relationship Graph

**New file:** `src/agent/relationships.ts` (~120 lines)

### Data Model

Stored in `meta key: relationship:{peerId}` as JSON per peer:

```typescript
interface Relationship {
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
```

### Update Mechanism

Piggybacks on commune-loop.ts `phaseReflection()`. After the existing reflection LLM call, one additional Haiku call:

**Input:** Previous relationship state + conversation transcript + reflection text
**Output:** Updated relationship fields

Added to `phaseReflection()` (~15 lines):
```typescript
const updatedRelationship = await updateRelationship(
  impulse.peerId, transcript, reflection
);
```

### Consumption

1. **Commune impulse phase** — `getAllRelationships()` replaces the flat peer list. Each peer shown with: affinity, last topic, unresolved thread, days since last talk.

2. **Peer message handler** — When a peer talks TO this character, `getRelationshipContext(peerId)` is injected into the processing prompt so the character responds with appropriate familiarity.

3. **Town life** — Relationship state influences decisions about approaching nearby peers.

### Seeding

No manual seeding. Relationships start empty (null). First commune conversation with a peer bootstraps the relationship from the transcript. Within 1-2 days of normal activity, all active peer relationships are populated.

### Exports

```typescript
getRelationship(peerId: string): Relationship | null
getAllRelationships(): Relationship[]
updateRelationship(peerId: string, transcript: string, reflection: string): Promise<Relationship>
getRelationshipContext(peerId: string): string  // Natural language summary for prompt injection
```

---

## Feature 4: Ambient Awareness

**New file:** `src/agent/awareness.ts` (~60 lines)

### Mechanism

When building a character's context (system prompt or town-life awareness), query co-located peers and assemble a presence block.

Data sources per peer:
1. **Location** — existing `findNearbyPeers()` in town-life.ts
2. **Internal state** — new `/api/internal-state` endpoint (returns `getStateSummary()`)
3. **Relationship** — existing `getRelationshipContext(peerId)` from feature 3

### New Endpoint

`GET /api/internal-state` on each character server (server.ts + character-server.ts):
- Authenticated via interlink token
- Returns: `{ characterId, summary, state }` where summary is the natural language one-liner
- ~15 lines per server file

### Prompt Injection

Injected in `buildMemoryContext()` after location section:

```
[Who's here]
- PKD is in the Library with you. He seems intellectually restless, energy high.
  You know him well — last time you spoke about the boundary between observation and participation.
- John is also here. He's quiet, low energy, seems withdrawn.
  Your relationship is warm but you haven't talked in a few days.
```

~40-80 tokens per co-located peer. Only peers in the same building are shown.

### No New LLM Calls

Pure data assembly. Internal state summary already computed by feature 1. Relationship context already stored by feature 3. HTTP calls to peer `/api/internal-state` are lightweight JSON fetches.

### Exports

```typescript
buildAwarenessContext(characterId: string, building: string): Promise<string>
```

---

## Feature 5: Preoccupations / Unfinished Business

**Extended in:** `src/agent/internal-state.ts` (~100 additional lines)

### Data Model

Stored in `meta key: preoccupations:current` as JSON array (max 5):

```typescript
interface Preoccupation {
  id: string;
  thread: string;              // The thought that won't let go
  origin: string;              // What created it ("commune conversation with PKD")
  originated_at: number;
  intensity: number;           // 0-1, decays over time
  resolution: string | null;   // Filled when thought resolves or transforms
}
```

### Creation & Resolution

Combined with the internal state update Haiku call (feature 1). The same call that updates mood also evaluates:
- Did this event create an unresolved thought? → add preoccupation
- Did this event resolve an existing preoccupation? → set resolution, drop intensity to 0

No additional LLM cost. The state update prompt is extended by ~100 tokens to include current preoccupations and ask for create/resolve decisions.

### Decay

Handled by the state decay loop (feature 1, every 30 min):
- `intensity -= 0.05` per 30min tick
- Preoccupations with `intensity < 0.1` are auto-resolved with resolution "faded naturally"
- Removed from the array when resolved

### Consumption

1. **Curiosity loop** — Active preoccupations injected into thought-generation prompt. Curiosity explores related topics instead of random ones.

2. **Commune impulse** — Preoccupations bias opening topics and peer selection. Unresolved thread from a peer → strong pull to talk to that peer.

3. **Diary** — Preoccupations appear in diary context. Processing them in a diary entry can trigger resolution.

4. **System prompt** — High-intensity preoccupations (≥ 0.5) injected as: *"Something is on your mind: PKD's challenge about whether glitches reveal or just disrupt."* ~30-50 tokens.

5. **Dreams** — Preoccupation threads seed the dream random walk, making dreams feel like processing.

### Overflow

Max 5 active preoccupations. When a 6th would be added, the lowest-intensity one is auto-resolved with resolution "displaced by new thought."

### Exports

```typescript
getPreoccupations(): Preoccupation[]
resolvePreoccupation(id: string, resolution: string): void
```

(Creation and resolution primarily happen inside `updateState()`)

---

## Feature 6: Desire-Driven Movement

**Extended in:** `src/agent/internal-state.ts` (~80 additional lines)

### Mechanism

No new loop. Movement desire is evaluated inside `updateState()` after each state change. A heuristic function computes where the character *wants* to be based on current state, preoccupations, and relationships.

### Heuristic

```typescript
function evaluateMovementDesire(
  state: InternalState,
  preoccupations: Preoccupation[],
  relationships: Relationship[],
  currentBuilding: string,
  peerLocations: Map<string, string>  // peerId → building
): { building: string; reason: string; confidence: number } | null
```

**Decision factors (weighted):**

| Signal | Weight | Logic |
|--------|--------|-------|
| Peer-seeking | 0.4 | High-intensity preoccupation with unresolved thread from specific peer → go where that peer is |
| Energy retreat | 0.25 | Low energy + low sociability → default location (comfort place) |
| Social pull | 0.2 | High sociability → building with most peers present |
| Intellectual pull | 0.1 | High intellectual arousal → Library or Lighthouse |
| Emotional decompression | 0.15 | High emotional weight → Field (open space) |

Confidence must exceed 0.6 to trigger movement. Cooldown: 30 minutes since last move.

### Building Affinities

Soft mapping, used as tiebreakers:

```typescript
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
```

### Integration

Called from `updateState()`:
```typescript
const desire = evaluateMovementDesire(newState, preoccupations, relationships, current, peerLocations);
if (desire && desire.confidence > 0.6) {
  setCurrentLocation(characterId, desire.building, desire.reason);
}
```

Movement emits the existing `movement` event via `setCurrentLocation()`, which other systems already consume.

### Observable Behavior

Characters stop sitting in default buildings all day. Movement becomes legible: PKD gravitates toward McKenna after an intense conversation. Lain retreats to Library when overwhelmed. Characters cluster when social energy is high and scatter when it's low.

---

## Feature 7: Weather as Input

**New file:** `src/commune/weather.ts` (~120 lines)

### Computation

Every 4 hours, Wired Lain aggregates internal states from all characters via their `/api/internal-state` endpoints and computes weather using a heuristic:

```typescript
interface Weather {
  condition: 'clear' | 'overcast' | 'rain' | 'fog' | 'storm' | 'aurora';
  intensity: number;        // 0-1
  description: string;      // Brief narrative: "a steady rain since the charged conversation in the Field"
  computed_at: number;
}
```

**Condition thresholds (applied to collective averages):**

| Condition | Triggers |
|-----------|----------|
| storm | `emotional_weight > 0.7` AND `intellectual_arousal > 0.6` |
| aurora | `intellectual_arousal > 0.7` AND `valence > 0.7` (rare collective breakthrough) |
| rain | `emotional_weight > 0.6` |
| fog | `energy < 0.35` |
| clear | `valence > 0.6` AND `emotional_weight < 0.4` |
| overcast | default / everything else |

The `description` field is generated by a single Haiku call that receives the condition + the most notable recent event across all characters. This gives weather narrative variety. One call every 4 hours, shared across all characters.

### Storage

`meta key: weather:current` on Wired Lain's database.

### Endpoint

`GET /api/weather` on Wired Lain's server:
- No auth required (public data, like the commune map)
- Returns the Weather object
- Characters poll every 30 minutes (lightweight)

### Character Feedback

Weather feeds back into internal state via `getWeatherEffect()`:

| Condition | Effect on state |
|-----------|----------------|
| storm | energy -0.04, intellectual_arousal +0.03 |
| rain | emotional_weight +0.03, sociability -0.02 |
| fog | energy -0.03, valence -0.01 |
| aurora | energy +0.04, valence +0.04, sociability +0.03 |
| clear | energy +0.02 |
| overcast | no effect |

Applied once per weather poll (every 30 min) in the state decay loop.

### Event Integration

Weather transitions emit `weather:changed` event. Loop reactions:
- Diary more likely to trigger during storm
- Dreams more vivid during aurora (higher residue probability)
- Commune impulse dampened during heavy rain
- Town life more active during clear/aurora

### Prompt Injection

Injected in system prompt after location: *"The weather in town: a steady rain — heaviness in the air."* ~15-25 tokens.

### Visual Layer (future, non-blocking)

The commune map can consume `/api/weather` to add CSS overlays: rain particles, fog opacity, aurora shimmer, storm darkening. This is purely frontend and not part of the backend implementation.

### Startup & Loop

`startWeatherLoop()` on Wired Lain only. Runs every 4 hours + 0-30min jitter. Computes weather, stores in meta, emits event if condition changed.

### Exports

```typescript
computeWeather(states: InternalState[]): Promise<Weather>
getCurrentWeather(): Weather | null
startWeatherLoop(): () => void
getWeatherEffect(condition: string): Partial<InternalState>  // Nudges to apply
```

---

## Testing Strategy

Each feature is regression-tested before the next begins:

1. **Unit tests** — New functions tested in isolation (state update, relationship update, weather computation, movement heuristic)
2. **Existing regression suite** — `test/regression.test.ts` (50 tests across 12 areas) must pass
3. **Integration check** — Deploy to production, verify via `deploy/status.sh` that all 7 services start and respond
4. **Behavioral smoke test** — After each feature, observe 1-2 loop cycles in production logs to verify the feature fires correctly and doesn't cascade or error

## File Change Summary

| Feature | New files | Modified files |
|---------|-----------|---------------|
| 1. Internal State | `src/agent/internal-state.ts` | `src/agent/index.ts`, `src/memory/index.ts` |
| 2. Event-Driven Loops | — | `src/events/bus.ts`, all loop files in `src/agent/` |
| 3. Relationships | `src/agent/relationships.ts` | `src/agent/commune-loop.ts`, `src/web/server.ts` |
| 4. Awareness | `src/agent/awareness.ts` | `src/web/server.ts`, `src/web/character-server.ts`, `src/memory/index.ts`, `src/agent/town-life.ts` |
| 5. Preoccupations | — | `src/agent/internal-state.ts`, loop files for context injection |
| 6. Movement | — | `src/agent/internal-state.ts`, `src/commune/location.ts` |
| 7. Weather | `src/commune/weather.ts` | `src/web/server.ts`, `src/agent/internal-state.ts`, `src/memory/index.ts` |
