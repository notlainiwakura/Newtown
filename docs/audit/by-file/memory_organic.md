# `src/memory/organic.ts`

Organic memory maintenance loop. The ORCHESTRATOR for forgetting, pattern detection, distillation, landmark protection, era summaries, memory cap enforcement, topology maintenance, and KG maintenance. 10 functions.

## Functions

### `startMemoryMaintenanceLoop(config?)`, line 48

Timer loop with `getMeta('memory:last_maintenance_at')` persistence. Interval 24h, check cadence 6h.

**Gaps / bugs:**
- **Two timers not aligned**: `cfg.intervalMs = 24h` is the intended spacing, but `CHECK_INTERVAL_MS = 6h` is how often we wake up and check if it's time. Sub-hour drift doesn't matter. OK.
- **`getMeta` → `parseInt` without radix**: `parseInt(lastRun, 10)` — good, explicit radix.
- **No way to force immediate run** via operator signal. **P3**.
- **Returned cleanup function is fine.** clearTimeout after setting `stopped = true`. Correct pattern.

### `runMemoryMaintenance()`, line 132

Calls 9 subroutines sequentially. Not inside try/catch per-subroutine — if `gracefulForgetting()` throws, the rest don't run.

**Gaps / bugs:**
- **All-or-nothing error handling.** If any phase throws, subsequent phases are skipped. A bug in `gracefulForgetting` could silently block KG sync, era summaries, topology for weeks. Only the outer try/catch in `scheduleNext` logs "Memory maintenance top-level error". **P2 — lift**: maintenance phases not isolated.
- **Order matters and is fragile.** E.g. `protectLandmarkMemories` must run before `enforceMemoryCap` (which would otherwise prune landmark candidates). The order is correct today but relies on implicit knowledge. **P3.**

### `gracefulForgetting()`, line 173

Phase 1: transition mature memories to composting if old + low importance + low emotion + rarely accessed + no associations. Phase 2: hard-delete composting memories older than 14 days.

**Gaps / bugs:**
- **`getAllMemories()` at start — capped at 2000 rows per store.ts P2.** 87% of a 15k-memory corpus doesn't see graceful forgetting. **P2** — covered by getAllMemories cap.
- **`getAssociations(memory.id, 1)` — if ANY association exists, memory is not composted.** So a memory linked by ANY prior run of `consolidateMemories`/`detectCrossConversationPatterns` is permanent. In practice, most memories get associations → composting is a near-empty set. **P2 — lift**: graceful forgetting is effectively disabled because association existence blocks it.
- **`memoryType === 'fact' || 'preference'` exempt**. Reasonable.
- **Phase 2 hard-deletes via `deleteMemory`** — covered by orphan association + vec0 cleanup P2.

### `detectCrossConversationPatterns()`, line 239

Cross-session pairwise similarity, creates `cross_topic` associations.

**Gaps / bugs:**
- **Samples only first 10 sessions × first 10 sessions × first 5 memories each × first 5 memories each = 2500 comparisons max.** In a populated DB with 500 sessions, this misses 98%+ of cross-session patterns. **P2 — lift**: cross-conversation detection samples near nothing on active characters.
- **Sort-order bias**: `sessionKeys = [...bySession.keys()]` — Map iteration order is insertion order, which is whatever `getAllMemories()` returned. Same sessions sampled every time. **P2** — bundled.
- **O(N²) on sampled window** — 2500 cosine-sim calls per cycle. Cheap.

### `evolveImportance()`, line 302

Boost importance by 0.05 for memories with accessCount >= 5.

**Gaps / bugs:**
- **Cap at 1.0, no decay.** Memories only go up. Combined with the `updateMemoryAccess` call in searchMemories, a background-loop-retrieved memory can be boosted indefinitely. Positive-feedback loop again. **P2** — bundled with store.ts updateMemoryAccess P2.
- **`getAllMemories()` cap of 2000.** Same invisible-13k issue.

### `decayAssociationStrength()`, line 330

Reduce association strength by 0.1 for assocs whose endpoints haven't been accessed in 60d.

**Gaps / bugs:**
- **No LIMIT clause.** If the DB has a million associations (unlikely today but possible over time), this updates all of them in one loop. **P3.**
- **Strength floors at 0.1.** No "forget" threshold — associations linger forever at strength=0.1. Could be argued either way. **P3.**
- **Individual `execute(UPDATE...)` per row.** N round trips. Should batch or use a WHERE-clause update. **P3.**

### `distillMemoryClusters()`, line 376

BFS on association graph → connected components → clusters of 5+ undistilled members → LLM synthesizes narrative.

**Gaps / bugs:**
- **`getProvider('default', 'light')`** — `'default'` is the agent id, `'light'` is provider index 2. Ties to the duplicate-haiku P2 in defaults.ts: [1] and [2] are identical Haiku, so the "light" provider is the same as the "memory" provider. No cost savings. **P3** — covered.
- **BFS on an in-memory adjacency list.** For a large DB, this could be memory-heavy. Acceptable for MEMORY_CAP=10k. OK.
- **"Undistilled" check**: `!mem.metadata?.distilledInto && !mem.metadata?.isDistillation`. But `getMemory(id)` may return a memory NOT in the adjacency list at all (if its associations got decayed off). Then it might be re-distilled repeatedly. Minor. **P3.**
- **3 clusters per cycle cap** — over 24h cadence, a character with 30 eligible clusters takes 10 days to distill all of them. Manageable.
- **Content truncated to 200 chars for prompt input**. Distillation sees a memory-snippet view, not full memories. Summary quality suffers for long memories. **P2 — lift**: distillation loses nuance on long memories.
- **Hardcoded `'distillation:cluster'` sessionKey** — all distillations share one session, collide in `resolveWingForMemory` (falls through to generic `encounters`). **P3.**
- **Each source memory's `metadata.distilledInto` overwrites on re-distillation.** If memory M is distilled into S1, then cluster reforms and M is distilled again into S2, M.distilledInto becomes S2 and S1 loses its source link. Not a hard bug (S1 still exists as memory) but a back-reference weakness. **P3.**
- **Batched UPDATE metadata + individual `addAssociation`** — not transactional. Partial failure leaves split state.

### `protectLandmarkMemories()`, line 525

Mark high-importance, high-emotion, or fact/preference memories as landmarks.

**Gaps / bugs:**
- **Criteria check `session_key IN ('self-concept:synthesis', 'first:conversation')`** — hard-coded magic session keys. Over time more "landmark" sessions emerge (first letter, first dream, etc.) but this list isn't updated. **P3.**
- **Eager update: 200 per cycle.** On first run, a character with lots of mature memories finds many candidates. After a few cycles, caught up. OK.
- **`meta.isLandmark` never unset.** If a memory's importance drops via other paths, it remains a landmark forever. No de-landmark process. **P3.**

### `generateEraSummaries()`, line 567

Per-month summaries for memories older than 60 days.

**Gaps / bugs:**
- **Two different state transitions for archive**: `setLifecycleState(id, 'archived' as 'composting')` and then a direct SQL `UPDATE lifecycle_state = 'archived'`. The first call is cast to a type it isn't (`as 'composting'`). The comment admits "archived handled same as composting for lifecycle" but the cast is just a lie — `setLifecycleState` sets `lifecycle_state = 'composting'`, then the next line OVERWRITES with `'archived'`. **So `setLifecycleState` call is a no-op followed by a correct update.** Either delete the first call or add `archived` to the `LifecycleState` union. **P2 — lift**: dead `setLifecycleState('archived' as ...)` call + union type missing `'archived'`.
- **Consequence**: `LifecycleState = 'seed' | 'growing' | 'mature' | 'complete' | 'composting'` — no `'archived'`. Callers reading `memory.lifecycleState === 'archived'` can't compile-check. `rowToMemory` casts blindly: `(row.lifecycle_state as LifecycleState) ?? 'mature'` — an archived row becomes `'archived'` at runtime, typed as LifecycleState but not actually in the union. **P2** — bundled.
- **`LAIN_CHARACTER_NAME` fallback to `'Character'`** — a per-character deployment must set this env var, else every era summary is signed "Character". Each systemd unit file sets it per MEMORY, but nothing enforces presence at module load. **P3.**
- **Up to 2 eras per cycle. 30 memories per era sampled.** On first run for a year-old character, 12 months of eras → 6 cycles × 24h = 6 days to catch up. Slow but OK.
- **Era summary archival** doesn't cleanup vec0 entries for archived memories. Search still finds them via embedding → returns them → `lifecycleState === 'composting'` filter skips only composting, not archived. **P2 — lift**: archived memories still returned by semantic search.

### `maintainKnowledgeGraph()`, line 682

Sync recent associations → KG, extract entities, detect contradictions.

**Gaps / bugs:**
- **`ASSOC_TO_PREDICATE` duplicated from `migration.ts`.** Two sources of truth. **P3.**
- **Falls through to `row.association_type` for unknown types** — same silent-pollution risk as migration.ts. **P3.**
- **`addEntity(name, entityType, row.created_at)`** — passes `created_at` as `firstSeen`. For a re-seen entity, this RESETS `last_seen` to the creation time of the NEW memory... wait, actually addEntity's ON CONFLICT sets `last_seen = excluded.last_seen` which is the new `firstSeen` (row.created_at). If row.created_at < existing last_seen, this rewinds. Ties to the addEntity P2 already lifted.
- **Contradiction logging is informational only** — nothing auto-resolves. Operator-only signal. **P3.**
- **`syncSince = parseInt(lastKGSync, 10) ?? 0`** — parseInt of `null` is `NaN`. The `?? 0` check only catches undefined, not NaN. So if `getMeta` returns something unparseable, `syncSince` becomes NaN → `WHERE created_at > NaN` returns 0 rows. First-time init returns `null` which is falsy → `lastKGSync ? ... : 0` = 0. OK path. **P3.**

### `enforceMemoryCap()`, line 776

Hard cap of 10,000 memories. Prune oldest/least important when exceeded.

**Gaps / bugs:**
- **`MEMORY_CAP = 10_000`** — but per MEMORY, Lain/Wired already have ~15k memories. **Either the cap was raised after the characters ballooned past it, or this isn't running.** If running, it would prune ~5k per cycle until caught up. Reality check required. **P2 — lift**: memory cap disconnect from production reality.
- **Prune order**: `ORDER BY importance ASC, access_count ASC, created_at ASC`. Lowest-importance first, tiebreak lowest access, tiebreak oldest. Reasonable.
- **`lifecycle_state != 'archived'`** exempt — good, archived rows are retained.
- **No dry-run / confirmation** — on a 15k-memory DB, first run deletes 5000 memories instantly. **P2** — bundled.
- **`deleteMemory` per row** — 5000 round trips. Transaction would help. **P3.**

---

## File-level notes

- **This file orchestrates the bulk of memory lifecycle.** Any bug here affects every character's experience over time.
- **Many tuning constants**: 90d / 14d / 60d / 0.3 / 0.1 / 5 / 0.7 / 0.65 / 0.85. Scattered. Consolidate. **P3.**
- **Interleaves 4 distinct concerns**: lifecycle, pattern detection, KG, cap enforcement. Could benefit from separation, but the 24h cadence pattern works. **P3.**

## Verdict

**Lift to findings.md:**
- **P2**: `runMemoryMaintenance` is not per-phase error-isolated — a single phase exception skips the remaining 8 phases. A bug in `gracefulForgetting` silently blocks KG sync, distillation, era summaries, topology, and cap enforcement for weeks until the bug is found.
- **P2**: Graceful forgetting is effectively disabled — the `getAssociations(memory.id, 1).length > 0 → continue` check excludes any memory with ANY association. Since `consolidateMemories` and `detectCrossConversationPatterns` create associations aggressively, nearly every mature memory has at least one association, so graceful forgetting finds almost nothing to compost.
- **P2**: Cross-conversation pattern detection samples almost nothing on active characters — caps at 10 sessions × 10 sessions × 5 memories × 5 memories = 2500 comparisons per run. For characters with hundreds of sessions, misses 98%+ of patterns. Same 10 sessions sampled every cycle due to insertion-order iteration.
- **P2**: Dead/incorrect `setLifecycleState('archived' as 'composting')` call immediately followed by a corrective raw UPDATE. Plus `LifecycleState` union is missing `'archived'`. Code works by accident. Fix: add `'archived'` to the union and make the call correct.
- **P2**: Archived memories still returned by semantic search — `searchMemories` only filters `lifecycleState === 'composting'`. Era-summary-archived memories still surface in every retrieval, competing with their own summary.
- **P2**: Memory cap of 10,000 disconnected from production — Lain/Wired run with ~15k memories (per MEMORY). Either the loop isn't running or the cap is silently ignored. Confirm during ops audit.
- **P2**: Distillation loses nuance on long memories — content truncated to 200 chars before LLM synthesis. The distilled summary misses detail that exists in the full memory text.
