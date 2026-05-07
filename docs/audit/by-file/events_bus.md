# `src/events/bus.ts`

Activity event bus. 1 singleton EventEmitter subclass + 2 free functions. 5 methods total on the class.

## Functions

### `parseEventType(sessionKey)`, line 21

**Purpose:** map a session-key prefix (e.g. `commune:pkd:1234`) to an event type for UI grouping.

**Gaps / bugs:**
- `typeMap` is a literal — any new background loop that introduces a new session-key prefix will fall through to `prefix` unchanged (e.g. `membrane` would become type `'membrane'`). Usually fine since the type is just a string, but breaks `isBackgroundEvent` matching (see below).
- `'web'` maps to `'chat'` and `'telegram'` also maps to `'chat'`. Users viewing activity can't distinguish channels. Probably intentional grouping. **P3**.
- `'dr'` + `'doctor'` both map to `'doctor'` — consistent.
- **`'alien'` maps to `'dream'`** — suggests alien contact is classified as dreaming. Curious, not a bug.
- **Prefix split on `:`** — brittle if any session key ever uses a different delimiter (e.g. `/`). Current callers all use `:`. No issue.

### `isBackgroundEvent(event)`, line 67

**Purpose:** classify events as autonomous-background vs user-driven for filtering in the activity feed.

**Gaps / bugs:**
- **`BACKGROUND_TYPES` is a duplicate concept** — the set must be kept in sync with `parseEventType`'s typeMap manually. If someone adds `membrane` to the typeMap (as a new background loop), they must also add `'membrane'` to `BACKGROUND_TYPES`. No compile-time guard. **P3**.
- `'chat'` is NOT in background types — correct (user chats are foreground).
- `'gift'` IS background — letters between characters. Correct.
- `'curiosity'` includes `bibliomancy` prefix (both map to `'curiosity'`), both backgrounded. Consistent.

### `ActivityBus` (class, line 71)

- `setMaxListeners(50)` — fine for 6 characters × multiple background loops.
- `_characterId = 'lain'` initial value. **P3** — if a character-server forgets to call `setCharacterId`, all events go out as `'lain'`, polluting the other characters' activity feeds. A missing `setCharacterId` call is exactly the kind of silent bug that's been flagged in MEMORY ("Character integrity is sacred"). Should throw or log loudly if `emitActivity` is called before `setCharacterId`.
- `emitActivity` mutates input via spread, adds `character`. Fine.
- `get characterId()` — accessible by consumers who want to know which character this process is.

---

## File-level notes

- Module-level singleton `eventBus`. Each character server has its own singleton (one per process). Events are NOT shared across processes — the commune map must fetch per-character activity over HTTP. Correct.
- Two separate but coupled data structures (`typeMap`, `BACKGROUND_TYPES`) — would be cleaner as a single `Record<prefix, { type, background }>`. **P3**.

## Verdict

**Lift to findings.md:**
- P2: `ActivityBus._characterId` defaults to `'lain'`. If a character server forgets to call `setCharacterId`, its events leak out labelled as Lain — a silent character-integrity bug matching the MEMORY-flagged failure class. Fix: either initialize to `null` and assert in `emitActivity`, or make `setCharacterId` a required constructor arg.
