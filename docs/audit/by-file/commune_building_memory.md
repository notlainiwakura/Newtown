# `src/commune/building-memory.ts`

Spatial residue system. 201 lines, 5 exports (`recordBuildingEvent`, `buildBuildingResidueContext`, `storeBuildingEventLocal`, `queryBuildingEvents`, and the type `BuildingEvent`).

**Architecture note:** events are stored CENTRALLY on Wired Lain's DB. Other characters POST cross-process to `${WIRED_LAIN_URL}/api/buildings/…` to write, and GET to read. Wired Lain's server exposes both endpoints and uses `storeBuildingEventLocal` / `queryBuildingEvents` internally. This is the only module in the audit so far that deliberately crosses the per-character DB boundary.

## Functions

### `recordBuildingEvent(event)`, line 34

Fire-and-forget POST to Wired Lain's API with `Authorization: Bearer ${INTERLINK_TOKEN}`.

**Gaps / bugs:**
- **Silent-swallow catch.** Lines 49-51: `catch { /* non-critical */ }`. Every failure mode looks identical to success:
  - Wired Lain down → silent.
  - WIRED_LAIN_URL misconfigured (wrong port, typo) → silent.
  - INTERLINK_TOKEN missing / wrong → 401, silent.
  - 5s timeout exceeded → silent.
  - Parse/network errors → silent.
  
  Over any of these failure modes, building memory degrades completely with zero telemetry. This is the downstream half of the double-swallow pattern in `location.ts:setCurrentLocation` — even from this module's own perspective, the caller gets no signal that writes are failing. **P2 — lift**: `recordBuildingEvent` silently discards every failure; missing INTERLINK_TOKEN, wrong WIRED_LAIN_URL, Wired Lain being down, or 5s timeouts all produce the same success-looking outcome. Building memory can be broken for weeks before anyone notices. Add a per-process failure-streak counter that emits WARN on the 3rd consecutive failure.
- **`INTERLINK_TOKEN` defaults to `''`** (line 18). Empty-string Bearer passes to the server which rejects with 401; silent catch swallows. A deployment that forgets to set `LAIN_INTERLINK_TOKEN` has building memory completely off, looking identical to properly-configured. Same pattern as the providers/index.ts empty-string-apiKey P2. **P2** — bundled with above.
- **`WIRED_LAIN_URL` defaults to `http://localhost:3000`** (line 17). In the systemd deployment this matches Wired Lain's port, but the coupling is implicit — renaming Wired Lain's port (which has happened; memory references `start.sh` port assignments) silently breaks building memory across every other character. Could read from the characters manifest's webCharacter URL. **P3.**
- **No retry.** Transient 5xx loses the event. **P3.**
- **`AbortSignal.timeout(5000)` hardcoded.** **P3.**
- **`id: nanoid(16)`** — low collision risk; Wired Lain's `INSERT OR IGNORE` handles collisions anyway. OK.
- **No SSRF check.** Correct — `WIRED_LAIN_URL` is operator config, not user input.

### `getBuildingResidue(building, hours)`, line 68 (private)

GET from Wired Lain's API.

**Gaps / bugs:**
- **Same silent-swallow as recordBuildingEvent.** **P2** — bundled.
- **Response cast to `RawBuildingEvent[]` without validation.** If the API returns malformed JSON (e.g. `actors` as string not array), downstream `e.actors.includes(characterId)` throws. **P3.**
- **`hours` parameter passes through unbounded.** `hours = 999999` is accepted. **P3** — caller-side concern but note it.

### `buildBuildingResidueContext(characterId)`, line 87

Main read-path consumer of residue. Categorizes by freshness (vivid <1h, fading <6h, echoes <24h), caps to 3/2/1 lines, builds a prompt string.

**Gaps / bugs:**
- **Case-sensitive self-exclusion** (line 109). `e.actors.includes(characterId)` filters out events where this character is an actor. If one code path records the actor as `'PKD'` and another reads with `'pkd'`, the filter misses — the character senses their own arrival/departure traces. In a system where `eventBus.characterId` comes from env vars and manifest entries, case drift is plausible. **P2 — lift**: characterId comparison is case-sensitive in `buildBuildingResidueContext`; case mismatches across recording code paths cause characters to sense their own residue.
- **Token budget comment says "~300-500 tokens max"** but actual cap is 6 lines (3+2+1). Each `summary` is unbounded — a long summary pushes the context well past the stated budget. **P3.**
- **Empty string on error** — caller can't distinguish "no residue" from "query failed." **P3.**
- **Error logged at debug level only** (line 135). Given the feature's purpose (make town feel alive) and how fragile the cross-process path is, WARN would be more appropriate. **P3.**
- **Time categorization is hard-coded to 1h / 6h / 24h.** No per-building override. **P3.**
- **Returns the building NAME via `BUILDING_MAP.get(loc.building)?.name`** in the prose; if the lookup fails (invalid building, race with renamed building), returns empty string (line 93). OK.

### `storeBuildingEventLocal(db, event)`, line 143

Wired Lain's server-side write path. `INSERT OR IGNORE`.

**Gaps / bugs:**
- **No validation that `event.building` is a valid BUILDING_MAP id.** A buggy writer posting events to `'libary'` (typo) persists the typo forever. No FK constraint. **P3.**
- **Actors serialized as JSON string.** OK for SQLite.
- **No size limit on `summary`.** A runaway client could post 10 MB summaries. **P3.**
- **Idempotency via `INSERT OR IGNORE` on id.** Fine.

### `queryBuildingEvents(db, building, hours)`, line 164

Wired Lain's server-side read path.

**Gaps / bugs:**
- **Prune-on-read.** Line 173: `DELETE FROM building_events WHERE created_at < pruneThreshold` runs on EVERY query. For the residue-context call-pattern (every character on every agent-loop tick possibly calls this), prune-on-read:
  - Adds a write to every read.
  - Blocks concurrent readers under SQLite's write lock.
  - Incompatible with read-replica scenarios.
  - Wastes CPU re-running the same DELETE on repeat queries seconds apart when nothing has expired.
  
  Compare to `memory/organic.ts` where prune is a scheduled maintenance task. **P2 — lift**: `queryBuildingEvents` runs a DELETE on every call (prune-on-read); should be a scheduled maintenance task, not coupled to the query path.
- **Prune threshold 48h hardcoded.** No config. **P3.**
- **LIMIT 20 hardcoded.** Caller can't override. `buildBuildingResidueContext` only uses 6 of those 20 anyway — wasted serialization. **P3.**
- **`WHERE building = ? AND created_at > ?` ORDER BY created_at DESC LIMIT 20.** Needs an index on `(building, created_at)` to be efficient. Worth checking the migration. **P3** — bundled with generic "no index audit" concern.
- **`JSON.parse(r.actors)` without catch** (line 197). A corrupt row crashes the whole query. **P3.**
- **`event_type` cast to the typed union** without runtime check. Unknown event_type leaks through as an invalid value, consumer may crash. **P3.**

## File-level notes

- **Single point of failure.** Wired Lain down = no spatial residue recorded OR readable anywhere in the town. No offline buffering, no fallback-local-cache. If Wired Lain takes a 6-hour outage, every character's "atmosphere" context disappears until WL returns. **P2 — lift**: central-store architecture is a single point of failure — no local buffering, no degraded-mode read (return empty vs. return cached). When Wired Lain is down, spatial residue across the entire town ceases for the outage duration.
- **Env resolved at module load** (lines 17-18). Changes to `WIRED_LAIN_URL` / `LAIN_INTERLINK_TOKEN` require restart. **P3.**
- **No rate-limiting.** A character in a movement-frenzy can spam Wired Lain. **P3** — bundled with broader "no rate limits anywhere" pattern.
- **No tests visible.** **P3.**
- **`BuildingEvent.event_type` union includes `'conversation' | 'arrival' | 'departure' | 'note_left' | 'object_placed' | 'object_taken' | 'quiet_moment'`.** The `storeBuildingEventLocal` takes `event_type: string` on reads; a writer using a new type that isn't in the union works, consumers with stale code may mishandle. **P3.**

## Verdict

**Lift to findings.md:**
- **P2**: `recordBuildingEvent` silently swallows every failure mode (missing INTERLINK_TOKEN → 401, wrong WIRED_LAIN_URL → connection error, WL down → timeout). Building memory can be broken indefinitely without any signal. Add a per-process failure-streak counter that emits WARN on sustained failures.
- **P2**: `buildBuildingResidueContext` characterId self-exclusion (`e.actors.includes(characterId)`) is case-sensitive. If any code path records an actor with different casing than the reader queries with, the character senses their own residue as if it came from someone else. Normalize case at both ends.
- **P2**: `queryBuildingEvents` performs `DELETE FROM building_events WHERE created_at < ?` on every query call (prune-on-read). Adds write-path overhead to every residue read, blocks concurrent readers under SQLite's write lock, and is incompatible with read-only scenarios. Move prune to a scheduled maintenance task.
- **P2**: Central-store architecture (all events on Wired Lain) is a single point of failure. When Wired Lain is down or unreachable, every character's spatial residue reads/writes fail for the outage duration with no local buffering or degraded-mode path. Either add a write-behind queue (buffer events locally, flush when WL recovers) or document the dependency clearly so operators know WL's availability gates the "town feels alive" feature.
