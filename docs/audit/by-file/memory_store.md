# `src/memory/store.ts`

The memory-layer workhorse. 1265 lines, ~45 exported functions. Covers: message persistence, memory CRUD + embedding search, associations, coherence groups, lifecycle, resonance, activity feed, postboard, building notes, character documents.

## Functions

### `saveMessage(message)`, line 126

Trivial INSERT + `eventBus.emitActivity`. Fine.

**Gaps / bugs:**
- `content.slice(0, 200) + '...'` — byte/char split may break UTF-8 surrogates for emoji-heavy users. Unlikely issue in practice. **P3**.

### `getRecentMessages(sessionKey, limit=50)`, line 156

Paginated session log. `DESC LIMIT`, then `.reverse()` in JS. OK pattern.

### `getAllMessages(sessionKey)`, line 171

No LIMIT. Could OOM on very long sessions. **P3** — latent.

### `getMessagesByTimeRange(startTime, endTime, limit=100)`, line 185

Fine.

### `getAllRecentMessages(limit=50)`, line 204

Cross-session. Fine.

### `getRecentVisitorMessages(limit=50)`, line 220

Filters out peer/letter/commune/proactive/doctor/town sessions to produce "visitor only" messages.

**Gaps / bugs:**
- **Diverging prefix list.** The inline filter lists 8 prefixes (`peer:`, `:letter:`, `wired:letter`, `lain:letter`, `commune:`, `proactive:`, `doctor:`, `town:`). The `BACKGROUND_PREFIXES` array at line 824 has 22 prefixes including diary, dream, curiosity, self-concept, narrative, bibliomancy, alien, therapy, movement, note, document, gift, research, townlife, object. Consequence: `getRecentVisitorMessages` returns diary, dream, curiosity etc. rows AS visitor traffic. The "visitor" tab in a dashboard would be polluted with autonomous-loop messages. **P2 — lift.**
- The `:letter:` substring pattern matches anywhere, unlike `prefix:` anchors elsewhere. Inconsistent.

### `saveMemory(memory)`, line 242

Generates embedding, imports palace module dynamically, assigns hall/wing/room, INSERTs memory, INSERTs vec0 index row, emits activity.

**Gaps / bugs:**
- **Silent vec0 index divergence.** The vec0 INSERT is wrapped in `try { ... } catch {}` with only the comment "vec0 insert failure is non-critical". If the insert fails (rowid collision, extension unloaded, corrupt state), the memory is saved to `memories` BUT NOT to `memory_embeddings`. Future `searchMemories` hits the vec0 path (because `vecCount > 0`) and never sees the orphan memory. Over time, embedding-search coverage silently degrades. **P2 — lift.**
- **Rowid generation is stochastic.** `BigInt(Date.now() * 1000 + Math.floor(Math.random() * 1000))` — two inserts in the same millisecond have a 1/1000 collision chance per pair. Low but non-zero. No retry. **P3.**
- **Palace placement is mandatory.** `assignHall`/`resolveWing`/`resolveRoom` called for every memory. If palace schema is not yet migrated on an old DB, every `saveMemory` throws. The surrounding audit already flagged dual migration systems (storage P2). **P3** — defer to palace migration audit.
- `await import('./palace.js')` inside each call — first call is lazy, subsequent cached. Negligible, but couples `store` ↔ `palace` at runtime. If palace.ts has its own module-level side effects that fail, saveMemory fails. **P3.**
- The `emitActivity({ sessionKey: memory.sessionKey ?? 'unknown', ... })` — a memory with no session (e.g. imported/backfilled) emits an event with a literal `'unknown'` session key, which downstream `parseEventType('unknown')` turns into… whatever the default is. **P3.**

### `getAllMemories()`, line 318

`LIMIT 2000`.

**Gaps / bugs:**
- **Hard ceiling of 2000 rows.** Per MEMORY, Lain/Wired have ~15k memories each in production. This helper returns only the top-2000 by importance. Every consumer who assumes "all memories" — brute-force search fallback, consolidation, activity backfill — silently misses 87% of the corpus. **P2 — lift.**

### `getMemoriesByType(memoryType)`, line 326

No LIMIT. For a populated DB this returns thousands. **P3**.

### `calculateEffectiveImportance(memory)`, line 338

Internal scoring: baseImportance + accessBoost (cap 0.4) + recencyBoost (72h window, cap 0.15). Clean.

**Gaps / bugs:**
- Caps at 1.0 — but if base is already 0.9, access+recency contributions get truncated. Harmless.
- `recencyBoost` uses wall clock — memories not accessed while the process was down still decay. OK.

### `searchMemories(queryText, ...)`, line 360

Core semantic search. vec0 KNN path OR brute-force fallback.

**Gaps / bugs:**
- **Brute-force fallback is silently truncated.** When `vecCount === 0` (pre-vec0 era, or empty index), `getAllMemories()` returns top-2000 by importance. Low-importance but recent memories are invisible to search. **P2** — bundled with `getAllMemories` cap above.
- **vec0 path doesn't account for memories NOT in vec0.** If some memories are in `memories` but not `memory_embeddings` (see vec0 insert failure above), they're invisible to search. **P2** — bundled with vec0 divergence.
- **Per-result `getMemory(id)` is O(K) round trips.** For `k = limit * 5 = 50`, that's 50 separate prepared-statement `.get()` calls. Should batch via `WHERE id IN (...)`. **P3.**
- **`updateMemoryAccess` called on EVERY retrieval**, including background loops (curiosity, dreams). Each access boosts the memory's effectiveImportance for future searches. Positive feedback loop: frequently-retrieved memories keep rising even if autonomous-loop retrieval isn't "real" engagement. **P2** — lift (behavioral, not crashing).
- `effectiveScore` weights: 0.35 sim + 0.35 importance + 0.30 emotional. Magic numbers. Document them. **P3.**
- `memory.metadata?.distilledInto` → -0.3 penalty. Good (avoids surfacing memories that have been superseded).

### `getMemoriesForUser(userId, limit=50)`, line 484

Fine. Note: `user_id IS NULL` is included — cross-user shared memories.

### `getMessagesForUser(userId, limit=50)`, line 498

Fine.

### `linkMemories(memoryId, relatedToId)`, line 512

Single-field `related_to`. Last-write-wins — if memory A is linked to B, then later to C, the A→B link is lost. Old-school, but matches the schema. **P3**.

### `getRelatedMemories(memoryId)`, line 522

Bidirectional: "related_to me" OR "I'm related to its related_to". Subtle. OK.

### `consolidateMemories(userId?)`, line 535

O(N²) pairwise cosine over top-200. Link if >0.85.

**Gaps / bugs:**
- **200-memory ceiling means recent memories don't consolidate.** Top-200 by importance skews to old/marked-important. **P3.**
- **`!m.relatedTo` filter means memories that are already linked once never link again.** If A→B is set, and then C appears that's also similar to A, A can't link to C because A.related_to is already B. Single-link-chain limitation. **P3.**
- No delete/clean of stale links.

### `updateMemoryAccess(memoryId)`, line 574

INSERT-access + `reinforceGroups`. Fine.

### `updateMemoryImportance(memoryId, importance)`, line 589

Trivial. No bounds check (importance should be in `[0, 1]`). **P3.**

### `deleteMemory(memoryId)`, line 596

Transaction: delete from `coherence_memberships`, then `memories`.

**Gaps / bugs:**
- **Does NOT delete from `memory_associations`.** Orphan rows with source_id or target_id pointing to a deleted memory. `getAssociations` returns them; `getMemory(orphan_id)` returns undefined, so `getAssociatedMemories` quietly skips — but associations table grows unbounded. **P2 — lift (bundled with storage cascade P2).**
- **Does NOT delete from `memory_embeddings` (vec0).** Future searches return the deleted memory_id, then `getMemory(id) === undefined` skips it — wasted KNN slots. **P2 — bundled.**
- Does NOT emit any event. Observers don't know a memory was deleted.

### `getMemory(memoryId)`, line 607

Trivial `queryOne`. Fine.

### `getEntityMemories(limit=8)`, line 615

`json_extract(metadata, '$.isEntity') = 1`. No functional index. Full scan. **P3** — index opportunity.

### `countMemories()`, line 629 / `countMessages()`, line 637

Fine.

### `getLastUserMessageTimestamp()`, line 645

Uses `role = 'user'`. Background loops use role='assistant' for generated content AND role='user' for simulated prompts. Will pick up background-loop "user" turns as real user engagement. **P3** — verify during agent audit.

### `addAssociation(sourceId, targetId, type, strength, causalType?)`, line 657

`INSERT OR REPLACE`. Good (idempotent).

### `getAssociations(memoryId, limit=20)`, line 674

Fine.

### `strengthenAssociation(sourceId, targetId, boost=0.1)`, line 688

`MIN(1.0, strength + ?)`. Good (capped).

### `getAssociatedMemories(memoryIds, limit=2)`, line 702

Graph-traversal helper. Two-hop: from input IDs → connected IDs, sort by strength, return memories. One-hop only. OK.

**Gaps / bugs:**
- Does one `getMemory(id)` per sorted ID — individual round trips. Minor. **P3.**

### `getResonanceMemory(userId?)`, line 749

Rotated strategy (emotional / anniversary / random). Does not update `last_accessed` — intentional, keeps memories "forgotten".

**Gaps / bugs:**
- Strategy rotated by `hour-of-epoch % 3`. For a character process that restarts within the hour, the same strategy keeps firing. Not a bug, just predictable. **P3.**
- Anniversary strategy computes `new Date(r.created_at).getDay()` in the JS process's local time. On a server where TZ is UTC but the operator thinks in their own TZ, "same day of week" may be shifted by 24 hours. **P3.**

### `getActivity(from, to, limit=500)`, line 839

Unified memory + message activity feed, filtered to background-loop sessions.

**Gaps / bugs:**
- **22 `LIKE prefix:%` clauses OR'd together, against `session_key` with no covering index on `session_key + created_at`.** On a 15k-memory DB, this is a full scan. Feed latency is a known complaint area. **P2 — lift.**
- Both queries applied independently, merged in JS, then sorted. OK.

### `safeParseJson(raw)`, line 886

Defensive. Good.

### `rowToMemory(row)`, line 895

Covers lifecycle/palace fallbacks.

**Gaps / bugs:**
- `(row.lifecycle_state as LifecycleState) ?? 'mature'` — a corrupted `lifecycle_state` value (e.g. `'bogus'`) is cast without validation. Downstream code branching on lifecycle state may hit undefined paths. **P3.**

### `rowToAssociation(row)`, line 922

Fine. Drops `causal_type` — see `getCausalLinks` below which accesses it differently.

### `rowToMessage(row)`, line 932

Fine.

### `rowToCoherenceGroup(row)`, line 944

Fine.

### `createCoherenceGroup`, `getCoherenceGroup`, `getAllCoherenceGroups`, `updateGroupSignature`, `deleteCoherenceGroup`, `addToCoherenceGroup`, `removeFromCoherenceGroup`, `getGroupsForMemory`, `getGroupMembers`, lines 958-1035

CRUD for coherence groups. `deleteCoherenceGroup` correctly cascades to memberships. `addToCoherenceGroup` / `removeFromCoherenceGroup` recompute `member_count` via subquery — correct but each access is 2 round trips inside one transaction.

**Gaps / bugs:**
- **`deleteCoherenceGroup` does not clean up the vec0 signature row.** (Groups have a signature Float32Array but it's stored in-row, not in vec0, so no cleanup needed.) OK.
- **No helper to find groups a memory should JOIN**, only explicit `addToCoherenceGroup`. The formation logic lives in `topology.ts`. OK.

### `setLifecycleState(memoryId, state)`, line 1039

Fine.

### `getMemoriesByLifecycle(state, limit=200)`, line 1046

200 cap. For `composting` enum (pruning candidates) this may be too small. **P3.**

### `addCausalLink`, `getCausalLinks`, lines 1056-1079

Thin wrappers over `addAssociation` + `memory_associations` with `causal_type` filter. OK.

### `computeStructuralRole(memoryId)`, line 1083

Heuristic returning 'foundational' | 'bridge' | 'ephemeral'. Threshold magic numbers (5+ assocs = foundational, 2+ groups = foundational). Document. **P3.**

### `reinforceGroups(memoryId, now)`, line 1108

Internal — updates `last_reinforced_at` on every group containing the memory.

### `getNotesByBuilding(building, since?)`, line 1124

`json_extract(metadata, '$.building') = ?`. Full scan, as above. **P3.**

### `getDocumentsByAuthor(authorId?, limit=20)`, line 1154

Same pattern. Full scan on `json_extract(metadata, '$.author')`. **P3.**

- Content-stripping regex: `row.content.replace(/^\[Document: "[^"]*"\]\n\n/, '')`. Assumes the header is always present. Documents saved without the header keep whatever prefix. **P3.**

### `savePostboardMessage`, `getPostboardMessages`, `deletePostboardMessage`, `togglePostboardPin`, lines 1216-1249

Clean CRUD. `togglePostboardPin` uses `CASE WHEN`, good.

### `getUnassignedMemories(lifecycleStates, limit=200)`, line 1253

For topology formation. Finds memories with embeddings but no coherence group.

**Gaps / bugs:**
- 200 cap may be too low on a large corpus. **P3.**
- `NOT IN (SELECT memory_id FROM coherence_memberships)` — can be slow without index on `coherence_memberships.memory_id`. Need to check migrations. **P3** — verify index.

---

## File-level notes

- **Dual list of background-session prefixes** (inline filter in `getRecentVisitorMessages` + `BACKGROUND_PREFIXES` constant) that disagree. Single source of truth would eliminate a real bug. Already lifted above.
- **Hard 2000-row cap on `getAllMemories`** masks most of the corpus from any consumer that calls it. Already lifted.
- **No orphan cleanup.** Deleting a memory leaves rows in `memory_associations` and `memory_embeddings`. Ties to the session-cascade P2 already lifted (a family of related FK-cascade gaps). Adding to lift.
- **vec0 silent insert failure** creates two-way index divergence. Search misses memories that failed to index AND (upon delete) keeps returning IDs that no longer exist. Already lifted.
- **Magic tuning constants scattered throughout** (0.85 similarity threshold for consolidation, 0.35/0.35/0.30 score weights, 0.3 distilled penalty, 5/2 structural role thresholds, 72h recency window, 3-day resonance cutoff). Would benefit from a `src/memory/tuning.ts` constants file so they can be reviewed together. **P3.**
- **`metadata: Record<string, unknown>`** — no runtime validation. Every reader has to `as string | undefined`-cast fields. Ties to the JSON metadata risk noted in `types/message.md`. **P3.**
- **`session_key` filtering by string-prefix convention** is brittle. Adding a new background session kind requires editing at least 3 lists (BACKGROUND_PREFIXES, `getRecentVisitorMessages` filter, and probably other places). **P2** — bundle into "session taxonomy" cleanup discussion, don't lift as separate finding.

## Verdict

**Lift to findings.md:**
- **P2**: `getRecentVisitorMessages` diverging prefix list — returns autonomous-loop messages as "visitor" traffic. Single source of truth needed.
- **P2**: `getAllMemories` hard-capped at 2000 rows — 87% of a 15k-memory character corpus is invisible to brute-force search, consolidation, and anything else that calls this.
- **P2**: Silent vec0 index divergence — `saveMemory` catches vec0 insert failures silently, `deleteMemory` never removes vec0 rows. Search coverage degrades over time + returns stale IDs.
- **P2**: `deleteMemory` does not cascade to `memory_associations` — orphan association rows accumulate forever. Bundle with storage cascade P2 already lifted.
- **P2**: `searchMemories` bumps `updateMemoryAccess` for every retrieval including autonomous-loop calls, creating a positive-feedback loop in the scoring function.
- **P2**: `getActivity` uses 22 OR'd `LIKE prefix:%` clauses against `session_key` with no covering index. Feed latency risk on populated DBs.
