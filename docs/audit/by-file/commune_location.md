# `src/commune/location.ts`

Per-character location state. 114 lines, 3 exports (`getCurrentLocation`, `setCurrentLocation`, `getLocationHistory`). Backed by `meta` key-value store with keys `town:current_location` and `town:location_history`.

Critical context: this module assumes ONE character per process (per-character-DB model — CLAUDE.md + MEMORY.md "Lain and Wired Lain are two separate people"). The meta keys are NOT namespaced by characterId because each character's DB is their own world.

## Functions

### `getCurrentLocation(characterId?)`, line 29

Reads `town:current_location` meta; falls back to `DEFAULT_LOCATIONS[charId]` then `'lighthouse'`.

**Gaps / bugs:**
- **The `characterId` parameter is a red herring.** The meta lookup at line 33 is keyed on `'town:current_location'` alone — no character scoping, because each process has its own DB. `characterId` only affects the *default-fallback* at line 44 (`DEFAULT_LOCATIONS[charId]`). So `getCurrentLocation('pkd')` called from Wired Lain's process returns Wired Lain's current location (if persisted) OR pkd's default (if not persisted). That's semantically confused: caller asked for pkd, got Wired Lain's state with pkd's default mixed in. **P2 — lift**: `getCurrentLocation(characterId)` parameter affects only the fallback default, not the actual meta lookup (which is always process-scoped). The API invites incorrect cross-character queries that silently return this-process data.
- **Fallback record uses `timestamp: Date.now()`.** Every call to `getCurrentLocation` on a character with no persisted location returns a NEW record with a fresh timestamp. Consumers reading `.timestamp` as "how long have they been here" see ever-incrementing nonsense. **P2 — lift**: fallback `LocationRecord` returns `timestamp: Date.now()` on every call; callers computing duration-at-building from `timestamp` get meaningless values for first-run characters.
- **Silent JSON.parse catch** (line 40). Corrupt meta → fall to default with no log. Operator debugging "why did the character suddenly reset to lighthouse" has no breadcrumb. **P3.**
- **BUILDING_MAP.has validation** at line 36 is correct — a stale meta row pointing to a deleted building falls through to default instead of propagating the bad ID. Good.
- **`'lighthouse'` hardcoded as the ultimate fallback** (line 44). No config. Works because lighthouse is the "solitude/seeking" building — a reasonable default identity. **P3.**

### `setCurrentLocation(building, reason)`, line 52

Updates current_location, prepends to location_history, emits `movement` activity, dynamically imports building-memory to record `departure` + `arrival` events.

**Gaps / bugs:**
- **Multi-write without transaction.** Three separate meta/DB operations: `setMeta('town:current_location', ...)`, `setMeta('town:location_history', ...)`, two `recordBuildingEvent` calls. A crash (or interrupted event-loop task) mid-sequence leaves partial state: current_location updated but history missing an entry, or history has the move but building-memory doesn't. No rollback. **P2 — lift**: `setCurrentLocation` performs 4 DB writes without a transaction; crash mid-call or concurrent call produces inconsistent state (location updated without history, or vice versa).
- **Race on history read-modify-write.** Lines 66-69: `getLocationHistory` → unshift → setMeta. Two concurrent moves:
  - A reads old history, unshifts "from=X to=library"
  - B reads old history (BEFORE A's write), unshifts "from=X to=bar"
  - A writes; B writes (overwrites A)
  - Final history: one entry (B's). A's move vanishes.
  
  Same read-modify-write pattern as `recordUsage` in budget.ts (lifted P2 in Section 4). For a character with background loops that trigger movement (desires.ts, town-life.ts), real. **P2** — bundled with the multi-write P2 above.
- **Race on current_location read.** Line 53 reads `getCurrentLocation` to compute `from`. Same TOCTOU: A and B both read `from = lighthouse`, A writes `library`, B writes `bar`. Final location is bar, history shows TWO moves both starting from lighthouse — logically impossible. **P2** — bundled.
- **Building-memory errors double-swallowed.** Line 84-99:
  ```ts
  import('./building-memory.js').then(({ recordBuildingEvent }) => {
    recordBuildingEvent(...).catch(() => {});   // swallow 1
    recordBuildingEvent(...).catch(() => {});   // swallow 1
  }).catch(() => {});                            // swallow 2
  ```
  Every spatial-residue write is silently tolerated. If building-memory's DB is corrupt, wedged, or disabled, every movement still "succeeds" from the bus POV but nothing accumulates spatially. The town loses its "buildings remember who was there" feature with no signal. **P2 — lift**: `setCurrentLocation` double-swallows building-memory errors (`.catch(() => {})` on each `recordBuildingEvent` plus an outer `.catch(() => {})` on the dynamic import). Spatial-residue writes can fail indefinitely with zero telemetry.
- **Dynamic import per-movement.** `import('./building-memory.js')` (line 84). Likely a cycle-break (building-memory may import from storage/location-adjacent modules). Node caches the module after first import so subsequent calls are fast, but the first movement per process waits for the import. Worth noting the cycle. **P3.**
- **`eventBus.characterId || 'unknown'`** (line 83) — if bus characterId isn't set, records events with actor `'unknown'`. Already noted in bus.ts findings. **P3** — bundled.
- **`from === building`** early return (line 57) — correct, suppresses no-op events. But the check comes BEFORE the no-op check for "already moving" — if desires.ts fires two "move to library" calls in quick succession, both pass the `from !== library` check concurrently and both go through the write path. Doesn't change correctness (both write library) but double-emits the movement event. **P3.**
- **`getLocationHistory(MAX_HISTORY)` called then `.slice(0, MAX_HISTORY)`** again at line 68 — the getLocationHistory call already slices to `limit = MAX_HISTORY`, and unshift adds one → length MAX_HISTORY + 1 → slice back to MAX_HISTORY. Works but redundant. **P3.**

### `getLocationHistory(limit = 20)`, line 105

Reads meta, parses, returns up to `limit`.

**Gaps / bugs:**
- **Silent parse failure returns empty array** (line 111). Operator can't distinguish "no moves yet" from "data corrupted." **P3.**
- **No validation of entry shape.** `JSON.parse(raw) as LocationHistoryEntry[]` — if the persisted data is malformed (partial write from the RMW race above), entries may be missing fields. Consumers accessing `.from` / `.to` on a bad entry get undefined. **P3.**
- **No lower-bound clamp on `limit`.** `limit = -1` returns empty via slice semantics. Probably intentional. **P3.**

## File-level notes

- **`MAX_HISTORY = 20` hardcoded.** No per-character or per-town override. For a high-activity town (many moves per hour, long-running characters), 20 entries = hours of history at best. A slower debug/post-hoc review over days would need deeper history. **P3.**
- **No observability on location changes.** Event bus gets an `activity` emission but no metric/counter. "How often does Wired Lain actually move?" requires log-grep. **P3.**
- **No test coverage visible.** **P3.**
- **`LocationRecord` and `LocationHistoryEntry` interfaces are module-private.** If any consumer wants to type a record fetched from the event bus they have to redeclare. **P3.**

## Verdict

**Lift to findings.md:**
- **P2**: `getCurrentLocation(characterId)` parameter is a red herring — it only affects the fallback default, not the actual meta lookup (which is always process-scoped by virtue of per-character DBs). Callers passing a different characterId get this-process's location with the target character's default. Rename / remove the parameter; make cross-character location queries a separate HTTP API call to the other character's server.
- **P2**: Fallback `LocationRecord` stamps `timestamp: Date.now()` on every call; callers computing duration-at-building from `timestamp` get ever-incrementing nonsense for characters without a persisted location yet. Fix: return `timestamp: 0` or expose a discriminated union `{ persisted: true; record } | { persisted: false; defaultBuilding }`.
- **P2**: `setCurrentLocation` performs 4 dependent writes (current_location, location_history, two building-memory events) without a transaction. Concurrent moves race on history read-modify-write and on current_location read — one move can vanish from history or be recorded with an impossible `from` building. A crash mid-sequence leaves partial state. Wrap in a SQLite transaction and serialize the RMW on history.
- **P2**: Building-memory `recordBuildingEvent` calls inside `setCurrentLocation` are double-swallowed (`.catch(() => {})` on each call + outer `.catch(() => {})` on the dynamic import). Spatial-residue writes can fail invisibly. Log WARN on each failure.
