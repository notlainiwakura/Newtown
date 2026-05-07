# `src/memory/migration.ts`

One-off backfill scripts. 3 functions. Triggered by `scripts/run-*-migration.ts`, NOT by `initDatabase`.

## Functions

### `migrateMemoriesToPalace()`, line 63

Backfills `wing_id` / `room_id` / `hall` on legacy memories created before the palace system. Also backfills vec0 index for any memory with an `embedding` BLOB but no vec0 row.

**Gaps / bugs:**
- **No transaction around the loop.** Each memory's UPDATE + wing/room increments + vec0 INSERT run as independent auto-commits. If the process dies mid-loop, some memories have `wing_id` set but `memory_embeddings` rows missing, or wing_counts incremented multiple times on retry. Re-run is "safe" only for the UPDATE (skipped via `wing_id IS NOT NULL`) — `incrementWingCount` and `incrementRoomCount` are NOT idempotent on retry. **P2 — lift.**
- **vec0 rowid collision risk.** `vecRowId = max + 1`, incremented in-loop. If another process is inserting into `memory_embeddings` concurrently (e.g. live character writing memories), the starting `max_rowid` stales and collisions occur. The `store.ts` live path uses random rowids (`Date.now() * 1000 + random`), so they'd likely not collide, but the space is shared. **P3.**
- **`maxRowResult[0]?.max_rowid ?? 0`** — first migration run picks 0, but vec0 rowids must be positive integers. `BigInt(1)` for first insert is fine since we pre-increment.
- **`SELECT ... FROM memories ORDER BY created_at ASC`** with no LIMIT. Pulls entire memory set into memory as JS objects before the loop. 15k memories × the buffer for embedding is ~20MB — bounded but not streamed. For a 100k-memory DB this could OOM. **P3.**
- **`logger.info(stats, 'Memory palace migration complete')`** — no signal to the caller whether `errors > 0`. Caller (the shell script) has no exit-code signal. **P3.**
- **Wing/room resolution depends on `resolveWingForMemory`** which reads metadata. The metadata-JSON-parse `catch {}` silently treats corrupt metadata as empty — same memory ends up in the "default" wing. May produce wing imbalance. **P3.**

### `migrateAssociationsToKG()`, line 203

Backfills `memory_associations` into `kg_triples`. For each assoc row, maps `association_type` → KG predicate, inserts a triple if one doesn't already exist.

**Gaps / bugs:**
- **No transaction around the loop** — same concern as palace migration.
- **`queryTriples` + `addTriple` is a get-then-insert race** — if the migration is run concurrently with another process adding triples, duplicates slip through the check. In practice, migrations run offline, but no lock enforces that. **P3.**
- **Unknown `association_type` falls through as the literal string.** A corrupted DB row with `association_type = 'garbage'` becomes a KG triple with predicate `'garbage'` — silently pollutes the KG. Should validate against the known set. **P3.**
- **`addTriple` provenance metadata** — records `migratedFrom: 'memory_associations'` and `originalType`. Good for debugging.

### `getMigrationStats()`, line 257

Counts total + migrated (`wing_id NOT NULL`) memories.

**Gaps / bugs:**
- Only tracks palace migration progress, not association→KG progress. **P3.**
- `row = rows[0] ?? { total: 0, migrated: 0 }` — COUNT(*) always returns one row, so the fallback is impossible. Fine. **No bug.**

---

## File-level notes

- **Dual migration systems noted in storage audit.** This file is the "one-off backfill" branch — invoked by `scripts/run-palace-migration.ts`. Schema version table (`meta`) doesn't track whether this backfill ran. An operator who deploys a new character onto a droplet without running the backfill script has a partially-migrated DB. **Covered by storage_database.md P2 already lifted.**
- **Re-run safety**: UPDATEs are idempotent via the `wing_id IS NOT NULL` skip, but wing/room counter increments would double-increment on a previously-partially-migrated DB (e.g. if process died after counter update but before UPDATE). The `skipped` branch doesn't increment counters, so the counter state is consistent IFF migration always completed. Risky invariant. **P3** — bundle into migration discussion.
- **No "version tag" on migrations.** If `migrateMemoriesToPalace` is changed in a future release (e.g. new logic for hall assignment), there's no way to tell a given DB which version of the migration ran. **P2** — bundle into storage dual-migration-system P2.

## Verdict

**Lift to findings.md:**
- **P2**: `migrateMemoriesToPalace` wraps per-memory work in per-statement auto-commits, not a transaction. Mid-run crash leaves DB in inconsistent state (UPDATEs partial, wing/room counters double-incremented on retry). Wrap each memory's mutations in `transaction(() => { ... })` so partial failures are atomic.
