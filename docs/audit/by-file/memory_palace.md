# `src/memory/palace.ts`

Wing + Room CRUD, hall assignment, wing resolution. 16 exported functions + 2 row mappers.

## Functions

### Wing CRUD — `createWing`, `getWing`, `getWingByName`, `listWings`, `resolveWing`, `incrementWingCount`, `decrementWingCount`, lines 78-128

Trivial CRUD. `resolveWing` is get-or-create by name.

**Gaps / bugs:**
- **`resolveWing` race**: `getWingByName` → `createWing` is two statements without transaction. Two concurrent `saveMemory` calls with same-named new wing both see "not found", both INSERT, both get different IDs for the same name. `palace_wings.name` needs a UNIQUE constraint, or `resolveWing` needs `transaction(...)`. **P2 — lift**: wing creation race.
- **No UNIQUE on `palace_wings.name`** — verify migrations. The race above relies on this. If UNIQUE exists, the second INSERT throws → `createWing` throws → `saveMemory` throws. Either way bad. **P2 — same**.
- **`resolveWing` ignores `description` if wing exists.** A wing created with no description stays that way. Probably intentional (first-write wins), but should be documented. **P3.**
- **`decrementWingCount` with `MAX(0, ...)`** guards against negative counts. But the count can drift if memory deletion ever happens without decrement. No reconciliation path. **P3.**

### Room CRUD — `createRoom`, `getRoom`, `getRoomByName`, `listRooms`, `resolveRoom`, `incrementRoomCount`, `decrementRoomCount`, lines 133-188

Same pattern. `resolveRoom` has same race issue — get-then-insert. **P2** — bundled with wing race.

**Gaps / bugs:**
- **No FK check** that `wingId` exists when creating a room. `createRoom('bogus-wing', ...)` succeeds if `palace_rooms.wing_id` has no FK constraint. Verify schema. **P3.**

### `assignHall(memoryType, sessionKey)`, line 206

Maps (type, key) → one of 5 halls.

**Gaps / bugs:**
- **Disagrees with `resolveWingForMemory` on which prefixes count as "internal reflection".** `assignHall` lists: `curiosity`, `dreams`, `dream`, `diary`, `letter`, `self-concept`, `selfconcept`, `bibliomancy`. `resolveWingForMemory` lists: `diary`, `dreams`, `dream`, `self-concept`, `selfconcept`, `bibliomancy` (no `letter` — letters go to the target's wing — and no `curiosity` — it has its own wing). That's intentional but fragile: adding a new background loop means editing both. Ties to the store.ts "session taxonomy" P2.
- **`letter:*` → `reflections`** hall. But `letter:wired-lain` is outgoing correspondence TO another inhabitant. Arguably this belongs in `encounters`. Design decision, not a bug. **P3.**
- **Default for unknown `memoryType`** is `encounters`. If future types are added (e.g. `'insight'`) they silently default. **P3.**

### `resolveWingForMemory(sessionKey, userId, _metadata)`, line 243

Derives wing name. `_metadata` prefix suggests unused parameter.

**Gaps / bugs:**
- **`_metadata` parameter is never read.** The comment in `migration.ts` suggests metadata could influence wing. Dead arg. Caller in `store.ts` still passes `memory.metadata || {}`. Either use it or drop it. **P3.**
- **`target = sessionKey.slice('letter:'.length).trim() || 'unknown'`** — if `sessionKey === 'letter:'` (empty target), falls back to `'unknown'`. That's a distinct wing. OK.
- **Commune/peer parsing**: `colonIdx = sessionKey.indexOf(':')` — but what about `commune:foo:bar`? Takes `slice(1)` gives `foo:bar`. The whole tail becomes the target. `sessionKey.split(':')[1] ?? 'unknown'` would be cleaner, but not a bug.
- **`visitor-${userId}` wing per visitor.** For a public character with many one-off visitors, each gets their own wing. Wings table grows unbounded. In practice Lain has O(10) repeat visitors — ok. For Wired Lain serving as research intermediary, each random user ID could blow up. **P2 — lift**: visitor wing proliferation.
- **Matches are case-insensitive via `key.toLowerCase()`** but the session key stored in the DB retains original case. `resolveWing(target)` then uses the raw `target` string (e.g. for letter target), which is case-sensitive at the DB layer. Casing drift between `letter:Wired-Lain` and `letter:wired-lain` produces two different wings. **P2 — lift**: case inconsistency between lookup and storage.

---

## File-level notes

- **Hall list is a hardcoded string-literal union**, not derived from a single source of truth shared with the schema. If a new hall is added, three places need to change (type, assignHall logic, any consumer). **P3.**
- **No way to reassign a memory's wing after creation.** If wings merge (e.g. "pkd" and "Pkd"), the memories point to the old wing IDs until a migration script fixes them. **P3.**
- **memory_count counters are eventually consistent.** If wing/room counters drift (e.g. due to a bug in decrement path), there's no reconcile routine. Could add `recountWing(id)` that queries `memories` directly. **P3.**

## Verdict

**Lift to findings.md:**
- **P2**: `resolveWing` / `resolveRoom` race — get-then-insert without transaction, and `palace_wings.name` likely missing UNIQUE (verify). Two concurrent memory saves with a new wing name produce duplicate wings. Wrap in `transaction(...)` + add UNIQUE constraint.
- **P2**: Per-visitor wing proliferation — `visitor-${userId}` creates a wing per user. For a public character, `palace_wings` grows unbounded. Consider a single `visitors` wing with per-visitor rooms instead.
- **P2**: Case inconsistency between lookup (`key.toLowerCase()`) and stored wing names (raw slice from sessionKey). `letter:Wired-Lain` and `letter:wired-lain` resolve to different wings.
