# `src/commune/weather.ts`

Town-wide weather derived from collective internal state. 202 lines, 5 exports (`getCurrentWeather`, `computeWeather`, `getWeatherEffect`, `startWeatherLoop`, plus the `Weather` type).

**Critical architectural observation up front** (referenced throughout): unlike `building-memory.ts` which centralizes on Wired Lain, this module runs **independently in every character's process**. Every process has its own `startWeatherLoop`, its own `weather:current` meta record, its own computation on its own 4-hour cadence with its own LLM-generated description. More on that in file-level notes.

## Functions

### `getCurrentWeather()`, line 15

Reads `weather:current` meta, parses, returns `Weather | null`.

**Gaps / bugs:**
- **No runtime validation that `condition` is one of the 6 union members.** A corrupt/stale row with `condition: 'xyz'` passes through since the check is `if (parsed.condition)` — any truthy string. Downstream `getWeatherEffect('xyz')` returns empty effects. Minor but surfaces as "weather has no effect" with no log. **P3.**
- **Silent parse failure.** Same pattern as everywhere. **P3.**

### `saveWeather(weather)`, line 26 (private)

Trivial. OK.

### `computeCondition(avgState)`, line 30 (private)

Rule-based mapping from 5-axis average state → `{ condition, intensity }`.

**Gaps / bugs:**
- **Order-dependent matching.** An agent state with `intellectual_arousal = 0.7`, `emotional_weight = 0.75`, `valence = 0.8` hits `storm` first (via weight + arousal) even though valence 0.8 is decidedly positive. A storm conveys negative connotation; the branch ordering makes "intense positive reflection with some emotional pressure" → `storm`. Design choice, not a bug. **P3.**
- **Magic thresholds** (0.7, 0.6, 0.35, 0.4) — not tunable. For mortal characters with a different baseline, thresholds may not fit. **P3.**
- **Default `overcast` at intensity 0.5.** OK fallback. **P3.**

### `computeWeather(states)`, line 55

Averages state across peers, computes condition, prompts an LLM for a poetic one-sentence description.

**Gaps / bugs:**
- **Equal-weighted average.** A 1-day-old mortal contributes as much to the town's mood as a long-lived immortal. Design choice — could weigh by age-in-town or "presence." **P3.**
- **LLM call inside the critical path.** `provider.complete` with `maxTokens: 150`, `temperature: 0.9`. If the provider is slow/down, computation still returns a weather (falls back to default string via the try/catch at line 88). OK — graceful degradation here.
- **No budget awareness on the description call.** Covered by the cross-cutting `checkBudget not centrally enforced` P2 from Section 4. **P3.**
- **`if (trimmed.length > 10)` threshold.** An LLM replying `"storm."` (6 chars, still valid) gets rejected; default string is used. Arbitrary; 10 seems safe-ish but meaningless. **P3.**
- **Dynamic import of `agent/index.js`** (line 74) — cycle-break. **P3.**
- **`getProvider('default', 'light')`** — uses the 'light' preset. If the preset isn't configured, `getProvider` may return undefined and the `if (provider)` guard skips the LLM call. Silent, but graceful. **P3.**
- **No language specification in the prompt.** If a future operator ever tweaks model defaults to a non-English-preferring model, the description language may drift. **P3.**

### `getWeatherEffect(condition)`, line 95

Static effect map per condition.

**Gaps / bugs:**
- **Effects are absolute numbers, NOT scaled by intensity.** Storm at intensity 1.0 produces the same `energy: -0.04` as storm at intensity 0.1. The `intensity` field is computed but never consumed in this function. A dramatic storm and a mild storm are identical in their state impact. **P2 — lift**: `getWeatherEffect` ignores `intensity` — weather effects are flat per condition regardless of how intense the computed weather is. Multiply each axis by intensity so strong weather produces stronger drift.
- **No effect for `overcast`** (empty object). Intentional — overcast is "baseline mood, no push." OK.
- **Character can't have weather preferences.** A character who "hates storms" has the same storm effects applied as a character who "loves storms." No per-character modifier. **P3.**

### `fetchAllPeerStates()`, line 112 (private)

Parses PEER_CONFIG env, fetches each peer's `/api/internal-state` endpoint.

**Gaps / bugs:**
- **`JSON.parse(peerConfigRaw)` without try/catch.** A malformed PEER_CONFIG throws sync; the wrapping setTimeout callback in `startWeatherLoop` catches at line 187. The weather loop keeps rescheduling but every tick logs an error with the same parse failure. Noisy but non-fatal. **P3.**
- **Silent catch per peer fetch** (line 135). Peer down → state excluded from the average. The weather skews toward whichever peers answered. If only Wired Lain answers while everyone else is offline, "town weather" is just WL's mood. Feature-as-bug. **P3.**
- **`token = process.env['LAIN_INTERLINK_TOKEN'] || ''`** — empty-string token passes to Authorization header; every peer rejects with 401, fetch catches silently, state absent from average. Same pattern as `building-memory.ts`'s empty-string trap. **P3** — bundled.
- **Includes `getCurrentState()` first** — the process's own state is always in the average. Good.
- **5s timeout per peer, concurrent via Promise.all.** OK.
- **No caching between runs.** 4h cadence is slow enough that caching is overkill. **P3.**

### `startWeatherLoop()`, line 141

Main entrypoint. Schedules `computeWeather → saveWeather → emit activity` on a 4h cadence with up-to-30min jitter. Resumes from `weather:last_computed_at`.

**Gaps / bugs:**
- **Runs independently in EVERY character process.** The headline concern. With 7 characters (Lain, Wired Lain, PKD, McKenna, John, Dr-Claude, Hiru), the loop runs 7 times. Each:
  - Fetches every OTHER character's state (concurrently, but each process makes its own calls).
  - Runs the rule engine.
  - Calls a `provider.complete` for the poetic description (7× LLM cost per 4h period).
  - Writes to its OWN `weather:current` in its OWN DB.
  - Emits to its OWN event bus on condition change.
  
  So there's no single "town weather" — seven processes each hold their own slightly-different view, computed at different times within their jitter windows. API calls to `/api/weather` on each character server return THAT character's local record, not the town's. If a UI displays weather from the Lain web server, that's Lain's view of weather, NOT Wired Lain's or PKD's.
  
  **P2 — lift**: every character process runs its own independent weather loop computing the same town-wide weather, producing N× duplicated computation, N× LLM description calls, and N per-process-divergent weather records with no single source of truth. Designate one process (e.g. Wired Lain, consistent with building-memory centralization) to compute + publish; make other processes fetch weather from that authority.
- **Weather description generated per process, all independently.** Seven different poetic sentences for the "same" weather. Aesthetic incoherence if anyone ever surfaces them side-by-side. **P3** — bundled.
- **`getInitialDelay` cross-restart resume.** Good — prevents double-compute on restart.
- **`eventBus.emitActivity` fires ONLY on condition CHANGE** (line 177). Intensity changes are invisible to consumers. Storm 0.3 → Storm 0.9 emits nothing; a character tracking weather drama via the activity feed misses the escalation. **P3.**
- **`parseInt(lastRun, 10)` no NaN check.** A garbage string → NaN → the `if (remaining > 0)` branch is false → falls through to the default 5-10min delay. Robust-ish. **P3.**
- **`scheduleNext` recursion via `setTimeout`** — OK for long intervals.
- **Stop semantics.** `stopped = true` plus `clearTimeout` is correct. If `computeWeather` is mid-await when stop is called, the timer is cleared but the async work inside the current tick continues to completion (then `if (stopped) return` at line 169 prevents rescheduling). OK.
- **Initial delay `5 * 60 * 1000 + Math.random() * 5 * 60 * 1000`** (first-ever run, no saved state) — 5-10 min. Stable startup; nothing wrong. **P3.**
- **No separate "boot weather" or "stale weather" path.** If a process runs for 5 min then shuts down, the cached weather record is stale forever on next boot until the 4h cadence runs again. OK — `computeWeather` uses current states each tick so eventual consistency works. **P3.**

## File-level notes

- **`InternalState` type imported via `import type`** — breaks runtime cycle with `internal-state.ts`. Good.
- **No per-character weather override.** A character who's deep indoors (library, locksmith) arguably shouldn't experience storm effects the same as a character in the field. Weather is one-size-fits-all. Design decision. **P3.**
- **No weather persistence for forecasting.** Only `weather:current`; no history of past weather conditions. Characters can't reference "yesterday's storm" in memory because there IS no record. **P3.**
- **No tests visible.** **P3.**
- **Observability**: condition-change events go to the bus at info level. Intensity drift, compute failure, peer-fetch failures all log at error/debug but no counters. **P3.**

## Verdict

**Lift to findings.md:**
- **P2**: Every character process runs its own independent weather loop computing the same town-wide weather. 7 characters = 7× duplicated state-fetching + 7× LLM description calls every 4h + 7 per-process-divergent weather records with no single "town weather" source of truth. API consumers hit whichever character's server they landed on and see that server's local snapshot. Designate one authoritative process (same pattern as `building-memory.ts` centralizing on Wired Lain) and have others read from it.
- **P2**: `getWeatherEffect` ignores `intensity`. Storm at 1.0 produces the same state delta as storm at 0.1. The intensity signal is computed and stored but never consumed when applying weather effects. Multiply per-axis effects by intensity so the magnitude of weather is reflected in its psychological impact.
