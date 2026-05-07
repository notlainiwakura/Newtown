# `src/memory/knowledge-graph.ts`

Temporal KG: `kg_triples` + `kg_entities`. 10 exported functions.

## Functions

### `addTriple(...)`, line 104

Inserts a triple with validity window.

**Gaps / bugs:**
- **No duplicate check.** Same `(subject, predicate, object)` inserted twice creates two rows with different IDs. `migration.ts:migrateAssociationsToKG` does its own pre-check via `queryTriples`, but live callers don't. **P2 — lift**: no de-dup on add.
- **No validation on subject/predicate/object strings.** Empty strings, whitespace-only, or `'null'` literal all accepted. Pollutes queries.
- `JSON.stringify(metadata ?? {})` safe, but reader `rowToTriple` does `JSON.parse(r.metadata)` with no try/catch — a corrupt row crashes the reader. **P3.**

### `getTriple(id)`, line 136

Fine.

### `invalidateTriple(id, endedAt?)`, line 145

UPDATE `ended`.

**Gaps / bugs:**
- **No check that the triple wasn't already ended.** Calling `invalidateTriple` twice silently overwrites the first `ended` timestamp with the second. Loses audit signal. **P3.**

### `queryTriples(q)`, line 154

Dynamic WHERE builder.

**Gaps / bugs:**
- **`LIMIT ${q.limit}` interpolated directly into SQL.** `q.limit` is typed `number | undefined`, so injection isn't possible via strict TS callers. But any `unknown`-typed caller (e.g. from router-level JSON body) could pass `"5; DROP TABLE..."`. At this code path it's type-safe, but the pattern is unsafe-looking. **P3 — lift gently**: prefer parameter binding over interpolation even for numbers.
- **`params` array shared across filters** — condition fragments and params must align. Fragile to edits (e.g. adding a condition without a param). No bug today. **P3.**
- **No index hint / analysis.** Should confirm `kg_triples` has indices on `(subject)`, `(predicate)`, `(object)`. Defer to schema audit. **P3** — check.

### `getEntityTimeline(entityName, limit?)`, line 191

`WHERE subject = ? OR object = ?`. Same `LIMIT ${limit}` interpolation concern.

**Gaps / bugs:**
- **`OR` query** can't use two separate indices without a UNION ALL. If there are indices on subject and object independently, SQLite may still choose a full scan. Verify with `EXPLAIN QUERY PLAN` against a populated DB. **P3.**

### `addEntity(name, entityType, firstSeen?, metadata?)`, line 206

`INSERT ... ON CONFLICT(name) DO UPDATE SET last_seen = ..., metadata = ...`.

**Gaps / bugs:**
- **`entity_type` not updated on conflict** — if a re-seen entity changes type (e.g. was "person", now "project"), the update keeps the old type. Silent staleness. Probably intentional (first-classification wins), but undocumented. **P3.**
- **`metadata` fully replaced on conflict, not merged.** A previously-stored metadata field is lost if the new call omits it. **P2 — lift**: `addEntity` upserts stomp prior metadata.
- **Same-timestamp stomp.** If called as `addEntity(name, type, firstSeen)` on a repeat, `last_seen` gets set to `firstSeen` not `now`. Looks wrong — `last_seen` should advance to now, not rewind to firstSeen. **P2 — lift**: `addEntity` can rewind `last_seen`.

### `getEntity(name)`, line 225

Fine.

### `updateEntityLastSeen(name, timestamp?)`, line 231

Fine.

### `listEntities(entityType?, limit?)`, line 239

Same LIMIT-interpolation pattern. OK given typed callers.

### `detectContradictions()`, line 263

Finds active triples with same (subject, predicate) but different object.

**Gaps / bugs:**
- **N² inner loop** — for subjects with many conflicts, output explodes. 5 conflicting objects → 10 pairs. Fine for small graphs, but no cap. **P3.**
- **N+1 query pattern** — one query to find conflict keys, then one query per conflict key. Could JOIN for a single roundtrip. **P3.**
- **No scoring / priority** — all contradictions returned equally. Callers have to sort/filter themselves. **P3.**
- **"Active" means `ended IS NULL`** — but `valid_from` could be in the future. A triple with `valid_from > now` and `ended IS NULL` is counted as a contradiction. Probably not intended — these are "scheduled" facts that haven't taken effect. **P2 — lift**: contradictions include not-yet-active triples.
- **Strength not considered.** Two triples with very different confidences (0.1 vs 0.9) get equal weight in the contradiction. Should surface the high-confidence one as "truth" and the low one as "noise". **P3.**

---

## File-level notes

- **No single path for "replace a fact".** The intended pattern is: `invalidateTriple(oldId)` + `addTriple(newValue)`. Callers might forget step 1, creating contradictions. A helper `replaceFact(subject, predicate, newObject)` would wrap the two steps atomically. **P3** — API gap.
- **`kg_triples.metadata` JSON is untyped + unvalidated** — same pattern as memory metadata elsewhere. **P3.**
- **Entity names are case-sensitive strings.** "Alex" and "alex" are different entities. No normalization. **P3**.
- **No delete operation** — entities and triples can only be invalidated (for triples) or left alone (for entities). Retention grows unbounded. **P3**.

## Verdict

**Lift to findings.md:**
- **P2**: `addTriple` has no duplicate check. Live callers can silently double-insert the same (subject, predicate, object) triple. Only the migration path pre-checks. Add a unique constraint or a helper that de-dups.
- **P2**: `addEntity` upsert stomps prior metadata and can rewind `last_seen` (when called with `firstSeen` on a repeat). Metadata should merge; `last_seen` should use `max(existing, new)`.
- **P2**: `detectContradictions` includes not-yet-active triples (valid_from in the future). Should filter to `valid_from <= now` as well as `ended IS NULL`.
