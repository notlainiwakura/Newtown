# `src/objects/store.ts`

Persistent world-object store for the Laintown simulation. Objects exist either on the ground at a building location (`location` set, `owner_id` null) or in a character's inventory (`owner_id` set, `location` null). Wired Lain's DB is the canonical registry; every other character reaches this store only through HTTP endpoints on the main web server (see `server.ts` audit). The HTTP wrapper is where the bodies of findings actually land — this file is a thin SQLite CRUD layer.

## Function inventory (~12 exports)

- `rowToObject(row)` — row shape → `WorldObject` mapping; unguarded `JSON.parse(row.metadata || '{}')`
- `createObject(name, description, creatorId, creatorName, location, metadata?)` — insert new ground-object
- `getObject(id)` — fetch single
- `getObjectsByLocation(buildingId)` — all un-owned at a building
- `getObjectsByOwner(ownerId)` — inventory query
- `getAllObjects()` — dashboard query; no cap
- `pickupObject(objectId, ownerId, ownerName)` — atomic UPDATE-if-unowned
- `dropObject(objectId, characterId, location)` — atomic UPDATE-if-owned-by-character
- `transferObject(objectId, fromId, toId, toName)` — atomic UPDATE-if-owned-by-sender
- `destroyObject(objectId, characterId)` — DELETE-if-owner-or-unowned-creator
- `countByOwner(ownerId)`, `countByLocation(location)`
- `isFixture(objectId)` — checks `metadata.fixture === true`

## Findings

### P2 — Body-asserted identity on all mutating endpoints (confirmed in Section 9)

Every mutating store call (`createObject`, `pickupObject`, `dropObject`, `transferObject`, `destroyObject`) receives caller identity as string parameters. At the HTTP layer (`server.ts:1449, 1476, 1498, 1526, 1554`) these identities come from the request body under interlink auth. Combined with the shared `LAIN_INTERLINK_TOKEN` (one token, every character process has it), any compromised character process can:

- Create objects as any `creatorId` ("gift from Wired Lain")
- Drop objects into any character's inventory via forged `ownerId` in a subsequent `pickupObject` (or transfer via `transferObject` with forged `fromId`)
- Destroy objects owned by any character by asserting `characterId` as the owner

This is the same systemic finding lifted from Section 9. Listed here because `store.ts` is the functional endpoint; the fix needs server-side identity derivation (derive from authenticated session, never from body), not a store-layer change.

### P2 — `isFixture` metadata check can be bypassed at `createObject`

`createObject(…, metadata?)` accepts a free-form metadata object and persists it verbatim via `JSON.stringify`. `isFixture` later reads `metadata.fixture === true`. Server-side, `/api/objects/create` (server.ts:1449) doesn't pass `metadata` from the request body, so the public endpoint can't mint a fixture. But any internal caller that does pass `metadata.fixture = true` creates an un-destructible, un-movable object (pickup/give/delete all block on `isFixture`). No server-side allowlist exists for who may mint fixtures. If a future feature extends the HTTP API to accept metadata (or a tool like `agent/tools.ts`'s object-creation tool passes it through), an LLM can mint an immortal object that pollutes a building forever.

**Fix:** either strip `metadata.fixture` at store-layer unless an explicit `isSystem` flag is passed, or move fixture-ness to a separate column with a distinct admin-only insert path.

### P2 — `rowToObject` `JSON.parse` unguarded against corrupt metadata

`rowToObject` line 50: `JSON.parse(row.metadata || '{}')`. The `|| '{}'` handles null/empty, but a non-empty corrupt string throws. Every query function (`getObject`, `getObjectsByLocation`, `getObjectsByOwner`, `getAllObjects`) will 500 on any corrupted row. One bad write poisons every subsequent read of that row and — for `getAllObjects` — every dashboard load until the row is manually repaired.

**Fix:** try/catch around parse, fall back to `{}` and log once per row.

### P2 — `getAllObjects` has no cap or pagination

Line 102-105: `SELECT * FROM objects ORDER BY updated_at DESC`. No `LIMIT`. If the world accumulates thousands of objects (plausible over months of simulation — notes, letters-as-objects, memory tokens), a single dashboard load pulls the whole table and JSON-stringifies it. Memory regression mirrors `memory/store.ts::getAllMemories` (Section 3, P2).

**Fix:** add pagination params; cap default response at e.g. 500 with a `nextCursor`.

### P2 — No audit trail on destroy / transfer

`destroyObject` hard-deletes; `transferObject` overwrites. No append-only ledger of "object X moved from A to B on T". The town simulation treats objects as meaningful narrative artifacts, but their history is destroyed the moment they change hands. If a character later asks "what happened to the ring I gave Hiru?" there's no answer.

**Fix:** append-only `object_events` table on every state change (create, pickup, drop, transfer, destroy).

### P2 — Creator-destroy-unowned fallback creates abandonment vulnerability

`destroyObject` (line 147): `DELETE … WHERE id = ? AND (owner_id = ? OR (owner_id IS NULL AND creator_id = ?))`. If a character drops an object and then the creator walks by, the creator can destroy it. In narrative terms this enables a "gift-giver destroys gift after you drop it" silent move — the recipient picked it up, dropped it to deal with something, and lost it forever. Behavior is consistent but possibly not what the design intended.

**Fix:** design decision — clarify who owns an abandoned object (last-owner-retains-rights vs. creator-reclaim).

### P3 — `creatorId` on the create path is trusted identity, not derived

Line 1449 at `server.ts`: `createObject(sanitize(name).sanitized.slice(0, 100), …, creatorId, creatorName, location)`. The creator fields come from the body with no derivation from authenticated identity. Same pattern as the P2 above; tracked there, noted here so the inventory is complete.

### P3 — `nanoid(16)` is ID size

16-char nanoid = ~95 bits of entropy. Sufficient; not a finding, just noting for completeness.

## Verdict

Store layer is clean and minimally-surfaced. All material findings are either (a) HTTP-layer body-asserted-identity (already lifted in Section 9 as the core interlink-fabric gap) or (b) the metadata.fixture-bypass and corrupt-JSON concerns that are store-local. The store is a thin wrapper whose correctness depends entirely on the caller — which is precisely what the Section 9 findings attack.

**Severity summary:** 0 P0, 0 P0-latent, 0 P1, **5 P2 lifted** to `findings.md`, 2 P3 noted here.
