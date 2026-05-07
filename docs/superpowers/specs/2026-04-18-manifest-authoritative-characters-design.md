# Manifest-Authoritative Characters — Design

**Date:** 2026-04-18
**Status:** Design approved; awaiting implementation plan

## Problem

`CLAUDE.md` claims:

> All code reads from this manifest. No character IDs are hardcoded.

Both sentences are false. Eight modules in `src/` maintain their own hardcoded character arrays instead of reading from `characters.json` via `src/config/characters.ts`. Adding a character to the manifest does not cause everything to work — silent degradation is the failure mode.

The hardcoded arrays have also drifted: three of them were not updated when Hiru joined the town, so Hiru is currently missing from experiment-DB snapshots, experiment share-peers, and town-event notifications.

## Goals

1. Make the manifest the single source of truth for character enumeration, so the `CLAUDE.md` claim becomes true.
2. Fix the drift bugs introduced by forgotten array updates (Hiru missing; Dr. Claude's exclusions scattered across six arrays instead of expressed once).
3. Keep the example manifest (`characters.example.json`) clean and readable for new town builders.
4. Backward-compatible rollout — code and manifest can be deployed in either order without breaking.

## Non-Goals

- Refactoring the two big web servers (`server.ts` / `character-server.ts`) — out of scope; tracked as Priority 2.
- Splitting `server.ts` by route group — out of scope; Priority 3.
- Replacing frontend character lists in HTML files (`dreams.html`, `commune-newspaper.html`) — those are client concerns and are addressed separately.
- Replacing prose/persona references (e.g., "You are Wired Lain…" in prompts). Those are legitimate character-identity text, not hardcoded lists.

## Design

### Schema extension

Add three optional fields to `CharacterManifestEntry` in `src/config/characters.ts`:

```ts
interface CharacterManifestEntry {
  id: string;
  name: string;
  port: number;
  server: 'web' | 'character';
  defaultLocation: string;
  immortal?: boolean;
  possessable?: boolean;
  workspace: string;
  // New fields — all optional, with conventional defaults:
  role?: 'inhabitant' | 'oracle';  // default: 'inhabitant'
  systemdUnit?: string;            // default: `lain-${id}`
  homeDir?: string;                // default: `/root/.lain-${id}`
}
```

The new fields are **optional** so `characters.example.json` stays minimal. Only the production `characters.json` on the droplet needs the three overrides:

- `lain`: `homeDir: "/root/.lain"`, `systemdUnit: "lain-main"`
- `wired-lain`: `systemdUnit: "lain-wired"`
- `dr-claude`: `role: "oracle"`

### New accessors (in `src/config/characters.ts`)

```ts
// Role-filtering
export function getInhabitants(): CharacterManifestEntry[];
export function getOracles(): CharacterManifestEntry[];

// Purpose-specific helpers
export function getHealthCheckTargets(): CharacterManifestEntry[];  // everyone
export function getDossierSubjects(writerId: string): CharacterManifestEntry[];  // all except writer
export function getDreamSeedTargets(): CharacterManifestEntry[];    // everyone
export function getCharacterDatabases(): Array<{ id: string; homeDir: string }>; // everyone + resolved homeDir

// Field resolvers (convention + override)
export function getSystemdUnit(id: string): string;
export function getHomeDir(id: string): string;
```

All helpers are one-liners over `getAllCharacters()`. The point is that filtering logic lives in one file instead of being scattered across eight.

### Call-site replacements

| File:line | Current hardcoded array | Replacement |
|---|---|---|
| `src/agent/doctor.ts:607` | `TELEMETRY_SERVICES` | `getInhabitants()` |
| `src/agent/doctor.ts:690` | `HEALTH_CHECK_SERVICES` | `getHealthCheckTargets()` mapped through `getSystemdUnit(c.id)` |
| `src/agent/experiments.ts:1098` | `TOWN_DBS` | `getCharacterDatabases()` |
| `src/agent/experiments.ts:1393` | `SHARE_PEERS` | `getInhabitants().filter(c => c.id !== 'wired-lain')` |
| `src/web/server.ts:1099` | `DREAM_PEERS` | `getHealthCheckTargets()` |
| `src/events/town-events.ts:151` | `INHABITANT_PORTS` | `getInhabitants()` |
| `src/agent/dream-seeder.ts:38` | `peers` default | `getHealthCheckTargets()` |
| `src/agent/dossier.ts:30` | `DOSSIER_SUBJECTS` | `getDossierSubjects('wired-lain')` |

### Behavioral changes (intentional drift fixes)

This refactor changes behavior in three places, fixing pre-existing drift bugs:

1. **Hiru included in experiment-DB snapshots.** `experiments.ts:1098` currently omits Hiru's home directory. After refactor, Wired Lain's experiments can access Hiru's database. Effect: experiments can reason about Hiru's data.
2. **Hiru receives experiment share messages and town-event notifications.** `experiments.ts:1393` and `town-events.ts:151` currently omit Hiru. Effect: Hiru gets notified when town events occur and receives experiment results like other inhabitants.
3. **Dr. Claude's exclusions centralized.** Currently Dr. Claude is excluded from telemetry (`doctor.ts:607`), experiment share-peers (`experiments.ts:1393`), and town-event notifications (`town-events.ts:151`) via omission. After refactor, Dr. Claude carries `role: 'oracle'` in the manifest and all oracle-excluding call sites use `getInhabitants()`. No behavior change for Dr. Claude — just explicit rather than implicit.

## Testing

- **Unit tests in `test/config.test.ts`** — extend with tests for each new accessor using an in-memory mock manifest. ~20 assertions covering:
  - Default role is `'inhabitant'` when unspecified
  - `getInhabitants()` excludes entries with `role: 'oracle'`
  - `getSystemdUnit()` returns override when set, falls back to `lain-${id}`
  - `getHomeDir()` returns override when set, falls back to `/root/.lain-${id}`
  - `getDossierSubjects(id)` excludes the writer
- **Snapshot-style test** — one test using a committed fixture that mirrors the production manifest shape (stored at `test/fixtures/manifest-production.json`). Locks in the output of each purpose-specific helper so future manifest edits can't silently change filter results.
- **No new integration tests.** 5 of 8 call sites are behavior-preserving (pure refactor). The 3 drift-fixing sites are exercised by existing regression tests that hit the relevant loops.

## Deployment

Risk: the production droplet runs the code; the manifest lives alongside it. A deploy that expects manifest fields before they exist would break on startup.

Mitigation: **all new fields are optional with documented fallbacks**, so code and manifest can be deployed in either order.

Deploy sequence on the droplet:

1. `git pull` on `/opt/local-lain` — code changes arrive. Behavior is unchanged at this point because `characters.json` has no overrides and defaults match the old hardcoded values (with the three drift fixes).
2. Build: `npm run build`.
3. Edit `characters.json` on the droplet to add the three overrides:
   - `lain.homeDir = "/root/.lain"`, `lain.systemdUnit = "lain-main"`
   - `wired-lain.systemdUnit = "lain-wired"`
   - `dr-claude.role = "oracle"`
4. Restart services: `systemctl restart lain.target`.
5. Verify: `./deploy/status.sh` — all services healthy. Spot-check `/api/telemetry` and dream-seeder logs.

Rollback: `git revert` the code change; the manifest overrides stay harmless (they're optional extra fields).

## Out of scope follow-ups

Noted for future work, not to be addressed here:

- Frontend HTML character lists (`dreams.html`, `commune-newspaper.html`) — separate concern; client-side build step likely needed.
- `start.sh` env-var override of `LAIN_HOME` — flagged in earlier review; should be fixed so runtime identity can't be ambiguous, but not part of this refactor.
- Shared core between `server.ts` and `character-server.ts` — Priority 2.
- Splitting `server.ts` god file — Priority 3.
