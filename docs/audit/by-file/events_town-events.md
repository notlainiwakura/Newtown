# `src/events/town-events.ts`

Admin-triggered or system-triggered town-wide events (narrative + mechanical effects). 7 exported functions + 1 internal helper + 1 internal notify.

## Functions

### `rowToEvent(row)`, line 54

**Purpose:** SQLite row → domain object. Converts int flags to booleans, parses `effects` JSON.

**Gaps / bugs:**
- `try { effects = JSON.parse(row.effects); } catch {}` — malformed effects silently become `{}`. A corrupt row shows as "no effects" instead of signalling. **P3**.
- `(row.source as TownEvent['source']) ?? null` — zero runtime validation. A row with `source: 'random-string'` passes through unchallenged.

### `createTownEvent(params)`, line 88

**Purpose:** insert a new town event, compute expiration, notify all inhabitants.

**Gaps / bugs:**
- **Lazy migration** — every call does `ALTER TABLE town_events ADD COLUMN source TEXT` inside a try/catch. Runs once per call even when column exists. SQLite is fast enough that this isn't painful, but it's an anti-pattern. Migrations should run once at startup. **P2**.
  - Same `ALTER TABLE` block is duplicated in `getActiveTownEvents` (line 193). Every list request does the migration attempt too. Worse.
- `INSTANT_WINDOW_MS = 30 * 60 * 1000` — instant events last 30 min. Hard-coded. **P3**.
- `ADMIN_DEFAULT_MS = 72 * 60 * 60 * 1000` — admin events default to 72h. Hard-coded. **P3**.
- Caller passes `params.expiresInMs?` — no upper bound. An admin passing `Number.MAX_SAFE_INTEGER` would create a basically-eternal event. **P3**.
- `notifyInhabitants` is called synchronously but fires async fetches fire-and-forget. No way for caller to know if notification succeeded. **P3**.

### `notifyInhabitants(event)`, line 157

**Purpose:** POST the event text to `/api/peer/message` on each inhabitant's port.

**Gaps / bugs:**
- **Hard-coded `http://localhost:${port}`** — same limitation as `getPeersFor`. Single-host assumption. **P3**.
- Fire-and-forget fetches with `AbortSignal.timeout(10000)`. **Good** — uses abort (unlike `withTimeout`). But no retry — if a character is restarting, they miss the event entirely.
- **Interlink token read from env at call time**: `process.env['LAIN_INTERLINK_TOKEN'] || ''`. If the env var is missing, an empty Bearer token is sent, causing 401 at each peer. The fetch catches and logs at DEBUG level — silent failure in production logs. **P2**.
- `logger.debug(...).catch(...)` pattern: `debug` only logs if level is `debug` or lower. In prod at INFO, these failures are invisible. Should be `warn` on failure. **P2**.

### `getActiveTownEvents()`, line 188

**Purpose:** list currently-active events (status='active' and not yet expired).

**Gaps / bugs:**
- Duplicate lazy migration — as above. **P2**.
- `expires_at IS NULL OR expires_at > ?` — so NULL `expires_at` means "active forever". Correct for `persistent` events.
- Does NOT update `status` for events whose `expires_at` has passed. They're filtered from the result but still `status='active'` in the DB. Use `expireStaleEvents()` to batch-transition. If `expireStaleEvents()` isn't called regularly, the table grows with stale "active" rows. Need to confirm a background loop calls it. **P2** — defer until we audit the event-runner.

### `getAllTownEvents(limit=50)`, line 205

**Purpose:** history view.

**Gaps / bugs:** `limit = 50` default. Fine. No pagination. For a long-lived town, history > 50 needs explicit `limit` bump. **P3**.

### `endTownEvent(id)`, line 213

**Purpose:** manually end an active event. Returns true if it was active, false if already ended / not found.

**Gaps / bugs:**
- Does NOT notify inhabitants that the event ended. A "building blocked" mechanical event that's ended leaves characters still thinking the building is blocked until their next `getActiveEffects` poll. Fine for eventual-consistency use cases; a problem if the frontend shows "event ongoing". **P3**.

### `expireStaleEvents()`, line 221

**Purpose:** batch-mark expired events as ended.

**Gaps / bugs:**
- No `ended_at` different from `expires_at` — uses `now` as ended_at. Slightly incorrect semantically (should be the expiration time). Minor. **P3**.
- Returns row count. Callers can use this for telemetry.

### `getActiveEffects()`, line 235

**Purpose:** merge all active *mechanical* events into a single `EventEffects` bag.

**Gaps / bugs:**
- `blockedBuildings` unioned — good.
- `forceLocation` — "last event wins" (last in DESC-created order → oldest? let me check). `getActiveTownEvents` returns `ORDER BY created_at DESC`. Iterating and letting last-write-wins means the *oldest* active event wins, because iteration runs newest → oldest. Semantic bug: operators adding a new `forceLocation` event expect it to override; it doesn't. **P1** — lift. Classic iteration-order bug.
- Same issue for `weather`. **P1** (bundled).

---

## File-level notes

- `TownEventRow` uses `natural_event` column name with `natural` field — slight inconsistency (one is a reserved-word workaround). Fine.
- No trigger / event emission on event creation — just the fire-and-forget HTTP fan-out. Consumers inside the same process (activity dashboard of the creating character) wouldn't see the event unless they poll. **P3**.

## Verdict

**Lift to findings.md:**
- P1: `getActiveEffects()` last-write-wins iterates DESC order, so OLDEST active event wins on `forceLocation` and `weather`. Operators expect the newest event to take effect. Fix: iterate ASC for the merge, or explicitly pick `max(created_at)`.
- P2: `notifyInhabitants` logs failures at DEBUG (invisible in prod). Missing interlink token silently 401s. Fix: log at WARN with details, and assert the token is set at module load.
- P2: Lazy `ALTER TABLE` migrations run on every call site (`createTownEvent`, `getActiveTownEvents`). Should run once at startup via a real migration path.
- P2: `expireStaleEvents` must be called regularly or the active-event table grows stale. Confirm a background loop calls it during later audit.
