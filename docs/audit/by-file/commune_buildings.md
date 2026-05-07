# `src/commune/buildings.ts`

Commune grid definition. 55 lines, 1 interface + 1 const array + 1 derived Map + 1 function + 1 type guard + 1 module-level constant.

## Exports

### `BUILDINGS`, line 17

9 entries, 3×3 grid. Readonly.

**Gaps / bugs:**
- **9 buildings hardcoded** — no per-town configurability. If the "reusable platform for user-created AI towns" vision plays out (see CLAUDE.md + memory), every town gets the same nine buildings. Extending requires editing TypeScript + recompiling. Acceptable for Laintown-as-deployment, blocker for platform-ization. **P3** (architectural, out of scope for bug-finding).
- **`🏗` used as Windmill emoji** — that's a construction/crane emoji, no canonical windmill codepoint exists. Cosmetic only. **P3.**

### `BUILDING_MAP`, line 35

Derived Map for O(1) lookup. Built at module import. OK.

### `getDefaultLocationsFromManifest()`, line 40

Loads manifest locations, filters invalid ones via `isValidBuilding`.

**Gaps / bugs:**
- **Silent drop of invalid building IDs.** Line 44: `if (isValidBuilding(building)) valid[id] = building`. Operator typos `'libary'` or `'lightouse'` in `characters.json` → no error logged, no entry populated. The character falls back to whatever default the location layer applies (likely `library`). Silent misconfig is the failure mode users complain about days later. **P2 — lift**: manifest location typos silently drop; `getDefaultLocationsFromManifest` filters invalid building IDs without logging. Fix: warn via logger when a character's manifest location isn't in `BUILDING_MAP`.

### `DEFAULT_LOCATIONS`, line 49

Computed ONCE at module import via `getDefaultLocationsFromManifest()`.

**Gaps / bugs:**
- **Stale on manifest edits without process restart.** For the production droplet (systemd-managed, `systemctl restart` reloads everything) this is a non-issue. For `npm run dev` tsx-watch, and for any hot-reload path, the constant is frozen at first load. Edit `characters.json`, the file-watcher restarts the agent loops with the new SOUL.md — but `DEFAULT_LOCATIONS` stays pointing at the pre-edit data because it's a module-scope const, and ESM doesn't re-evaluate the module without a full reload. **P3** — low impact in practice.

### `isValidBuilding(id: string): id is BuildingId`, line 52

Type guard. Trivial, correct.

## File-level notes

- **Description strings feed LLM movement prompts.** Per the file-header comment. If a description phrase ("loose talk" at Bar, "unresolved questions" at Threshold) doesn't match the character's actual experience once arrived, the LLM learns to distrust its own movement heuristics. No bug, just a design coupling worth noting: descriptions are effectively part of the "public interface" the LLM treats as ground truth.
- **No adjacency / pathfinding defined here.** That lives in `location.ts`. Separation OK.
- **Grid coordinates (row, col) don't include Z/floors.** The Threshold's "liminal space" description hints at non-Euclidean geometry that the implementation doesn't honor. Purely literary, no bug.

## Verdict

**Lift to findings.md:**
- **P2**: `getDefaultLocationsFromManifest()` silently drops invalid building IDs from the manifest without logging. Operator typos in `characters.json` locations produce a missing default-location entry, which propagates as "character spawned at the wrong building" with no warning. Log a WARN for each dropped entry at module init.
