---
file: src/agent/internal-state.ts
lines: 546
purpose: 6-axis emotional state (energy, sociability, intellectual_arousal, emotional_weight, valence, primary_color). LLM-driven updates with heuristic fallback. 30-min decay loop applies weather effects. Evaluates movement desire after state changes. Stores state + history + preoccupations in meta.
section: 8 (agent loops)
audit-date: 2026-04-19
---

# agent/internal-state.ts

## Function inventory (16)
- `clampState(state)` — 46: exported.
- `getCurrentState()` — 58: exported.
- `saveState(state)` — 71: exported.
- `getStateHistory()` — 85: exported.
- `applyDecay(state)` — 95: exported.
- `describeLevel(value)` — 105.
- `getStateSummary()` — 113: exported.
- `getPreoccupations()` — 158: exported.
- `savePreoccupations(list)` — 169.
- `addPreoccupation(thread, origin)` — 173: exported.
- `resolvePreoccupation(id, resolution)` — 195: exported.
- `decayPreoccupations()` — 204: exported.
- `evaluateMovementDesire(...)` — 233: exported.
- `applyHeuristicNudges(state, event)` — 343.
- `updateState(event)` — 359: exported.
- `startStateDecayLoop()` — 498: exported.

## Findings

### 1. `DEFAULT_BUILDINGS` hardcoded 6-character roster (P2)

Lines 224-231. Manual map of `characterId → defaultBuilding`. Duplicates manifest data. Adding a new character requires editing this file; not doing so falls through to `DEFAULT_BUILDINGS[charId] || 'library'` — new character retreats to library regardless.

Should read from `characters.json` manifest (`getCharacterEntry(charId).defaultLocation`).

**Consequence**: per MEMORY.md commune platform vision (user-created towns), this hardcode blocks extensibility. Every new user-defined character silently defaults to library as "comfort place".

### 2. `process.env['LAIN_CHARACTER_ID'] || eventBus.characterId` cascade (P3)

Line 446. Two identity sources — env first, eventBus second. If both unset, `eventBus.characterId` is likely `'lain'` default. Another fail-open-to-Lain surface.

Line 261 uses only `eventBus.characterId` (no env fallback). Inconsistent.

### 3. LLM-driven state update: raw event summary in prompt (P2 — bundle)

Line 386: `EVENT: [${event.type}] ${event.summary}`. Summary is caller-supplied, often includes LLM-derived content (e.g., `state:commune:complete` summary might be a peer's conversation reflection). Injection carrier.

Injection flow: peer injection → commune reflection → StateEvent.summary → internal-state prompt → LLM emits preoccupation_thread or primary_color that encodes injection → preoccupation stored in meta → preoccupation surfaces in future prompts.

### 4. `preoccupation_thread` field length unchecked (P2 — bundle)

Line 415-416: `addPreoccupation(parsed['preoccupation_thread'], event.summary.slice(0, 100))`. Origin is sliced to 100 chars; **thread is not capped**. LLM can return arbitrarily long text, stored verbatim. Preoccupations re-inject into future update prompts (line 370) — persistent amplification surface.

### 5. `primary_color` free-form one-word string (P3)

Line 410-412: `typeof parsed['primary_color'] === 'string' && parsed['primary_color'].length > 0`. No word-count check despite prompt instruction "one word". LLM can emit sentence-length "color" text that then appears in `getStateSummary()` at line 143 — surfaces in system prompts.

### 6. `PEER_CONFIG` parsed fresh per call (positive, line 454)

Not module-load snapshotted. Contrast with letter.ts. Good.

But: per MEMORY.md, `PEER_CONFIG` MUST be in EnvironmentFile, not inline in Environment= (systemd strips JSON quotes). If misconfigured, `JSON.parse` at line 456 throws → caught by outer catch → silent no-peer-locations → movement desire computes without social-pull signal. Silent degradation.

### 7. Peer location fetch has no auth (P2 — bundle with awareness.ts)

Line 459: `fetch('${p.url}/api/location', {...})`. Same unauth'd cross-character endpoint used in awareness.ts. Bundle.

### 8. Movement cooldown 30min + decay interval 30min — potential oscillation (P3)

Lines 34, 450. Decay tick fires every 30 min, updateState triggers movement eval, movement cooldown is 30 min. Back-to-back updates can fire movements exactly at the cooldown boundary. Not a bug (character is supposed to move periodically) but worth noting.

### 9. `evaluateMovementDesire` — unresolved preoccupation substring match (P3)

Line 246: `preocc.origin.toLowerCase().includes(rel.peerId)`. Substring match on peerId. If peerId is short (e.g., `'pkd'`), spurious matches against unrelated origins containing "pkd" as substring. Brittle.

### 10. `BUILDING_MOODS` defined but `void`'d (P3)

Line 212-222, 332. Dead data. Comment says "reserved for future LLM context use". Either remove or wire up.

### 11. LLM JSON parse via regex `{[\s\S]*}` (P3)

Line 402. Greedy match. If LLM emits commentary before/after JSON or embeds example JSON snippets inside prose, the regex may capture wrong slice. Common anti-pattern. Works for well-behaved providers; fragile under adversarial prompts.

### 12. `HEURISTIC_NUDGES` skip unknown event types silently (P3)

Lines 343-346. If caller emits an event type not in the map, `return state` unchanged. No log. Can cause silent-no-op on typos.

### 13. Weather effect lookup inline to avoid circular deps (positive, lines 507-528)

Comment acknowledges design choice. Circular-dep break is correct. Duplicated WEATHER_EFFECTS table is a minor DRY concern but acceptable.

### 14. State history cap 10 (positive, line 33)

Bounded growth. Good.

### 15. `saveState` overwrites `updated_at` (line 73, correct)

Ensures timestamp reflects persistence time, not the caller's stale value. Good.

### 16. `decayPreoccupations` removes intensity < 0.1 (positive, line 208)

Natural forgetting. After ~12 ticks (6 hours) of no reinforcement, preoccupation fades. Nice.

### 17. `eventBus.emitActivity` broadcasts state summary after every update (P3)

Line 487-492. State shift broadcast includes `primary_color` (LLM-supplied free-form text) in `content`. If listeners persist this, indirect amplification. Same pattern as objects.ts #9.

### 18. No rate limit on `updateState` LLM calls (P3)

Each state event triggers an LLM call (if provider available). Burst-event scenarios (commune rounds, letter cascades) can fire multiple updates in quick succession. `getProvider('default', 'light')` uses the light model but still costs. No debounce / batching.

### 19. `applyDecay` sociability mean-reversion formula (positive, line 100)

`sociability - 0.02 * (sociability - 0.5)` — drifts toward 0.5 equilibrium. Nice touch.

### 20. Movement desire `confidence > 0.6` threshold (P3)

Line 476. Raw score is `intensity * weight + 0.3` at max = `1 * 0.4 + 0.3 = 0.7` for signal 1. Signal 4 (intellectual pull) max = `1 * 0.1 + 0.3 = 0.4` — CAN'T meet threshold even at peak. Signal 5 (emotional decompression) max = `1 * 0.15 + 0.3 = 0.45` — also can't. Only signals 1 (peer pull) and 2 (energy retreat, max `1 * 0.25 + 0.3 = 0.55`) and 3 (social pull, max `1 * 0.2 + 0.3 = 0.5`)...

Actually wait, recompute: `Math.min(1, best.score + 0.3)`. For signal 2 max: `(1-0) * 0.25 = 0.25`, then `0.25 + 0.3 = 0.55`, `Math.min(1, 0.55) = 0.55`. Threshold is 0.6. **Signal 2 cannot trigger movement on its own** regardless of energy state. Same for signals 3, 4, 5.

**Only signal 1 (peer-seeking) can trigger movement**. At `intensity=1, weight=0.4` → `0.4 + 0.3 = 0.7 > 0.6`. So the five-signal system is effectively a one-signal system. The other four are dead weight.

**This is a latent bug** — the comment "5 weighted signals" in CLAUDE.md claims more richness than the code delivers. Desire-driven movement only ever fires from peer pull.

### 21. `preoccupation_resolve_id` not validated as existing (P3)

Line 417-421. LLM returns an ID; `resolvePreoccupation` does `findIndex`; if no match, silently no-ops. Prompt injection could emit arbitrary IDs without effect, but a legitimate-but-stale ID could resolve a different preoccupation than intended.

## Non-issues / good choices
- Per-character meta scoping via per-character DB.
- Clamp at every save.
- History cap + preoccupation cap.
- Natural decay with weather modulation.
- Heuristic fallback when LLM unavailable or fails.
- Mean-reversion on sociability.
- Preoccupation intensity decay.
- Clean provider loading via dynamic import (avoids circular deps).

## Findings to lift
- **P2**: `DEFAULT_BUILDINGS` hardcodes 6-character roster — blocks multi-town platform vision.
- **P2 (bundle)**: StateEvent.summary is injection carrier into LLM state-update prompt.
- **P2 (bundle)**: `preoccupation_thread` length uncapped — persistent amplification.
- **P2 (bundle)**: `/api/location` peer fetch unauth'd.
- **P2**: Movement desire threshold 0.6 is unreachable by signals 2-5 — "5-signal system" is effectively 1-signal (peer pull).
- **P3**: Identity cascade `LAIN_CHARACTER_ID || eventBus.characterId` inconsistent (sometimes used, sometimes not).
- **P3**: `BUILDING_MOODS` dead data.
- **P3**: Preoccupation origin substring match against peerId — collision risk.

## Verdict
Rich state model with good decay and bounded storage. The hardcoded 6-character DEFAULT_BUILDINGS and the silent dead-signals in movement-desire threshold are the most novel concerns — both block the manifest-driven multi-town vision. Injection surface (StateEvent.summary, preoccupation_thread, primary_color) is bundled with section-wide patterns. Weather modulation and heuristic-fallback-on-LLM-failure are good engineering. The 5-signal-system-that-is-really-1-signal deserves a dedicated finding.
