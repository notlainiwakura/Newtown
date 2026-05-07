# `src/memory/topology.ts`

Lifecycle progression, coherence group formation/merge/prune, causal link inference. 7 functions.

## Functions

### `runTopologyMaintenance()`, line 35

Orchestrator. Calls the 5 phases in order.

**Gaps / bugs:**
- **All-or-nothing error handling.** Single try/catch around all 5 phases. A transient error in phase 2 (coherence formation) skips phases 3-5 entirely. Better per-phase error isolation so lifecycle advancement keeps working even if, e.g., group merging has a bug. **P3.**
- **No locking.** If two character processes somehow shared a DB (shouldn't happen per CLAUDE.md), concurrent topology maintenance would stomp each other. Per-character isolation protects us here.
- **No progress/cancellation signal.** Dream loop, diary loop, etc. run concurrently and can step on topology. **P3**.

### `advanceLifecycles()`, line 62

Age + access heuristic transitions across 5 states.

**Gaps / bugs:**
- **Hard limit of 500 per state per call.** A DB with >500 seeds accumulated between runs only advances 500. If the cadence is one pass/day and ingest rate exceeds 500/day, we fall behind monotonically. **P2 — lift**: topology fall-behind.
- **`mature → complete` requires `importance < 0.3 AND accessCount > 10 AND age > 30d`**. The AND logic means a memory with importance 0.9 and 100 accesses stays `mature` forever. Probably intended (important memories should never rot), but `accessCount > 10` as a gate to `complete` looks inverted — shouldn't high-access mean "mature/kept", not "complete/about to compost"? Reading again: `complete` feels like "done processing" not "about to die". But the next transition is `complete → composting → deleted`. So high access + low importance + age is treated as "this is now a well-exercised but unimportant memory, let it fade". Works but the naming is confusing. **P3** — document.
- **Composting deletes memories.** `deleteMemory` in store.ts doesn't cascade to associations or vec0 (covered by already-lifted P2). Every topology run silently grows the orphan-association count. **No new finding.**
- **`lifecycleChangedAt ?? createdAt`** fallback — if a memory was `complete` before the lifecycle_changed_at column existed, uses creation time. OK during migration window.
- **Loops over `getMemoriesByLifecycle` with 500-row cap.** Result set not randomized, so the SAME 500 seeds are processed every call. If the first 500 don't advance, the same 500 get re-checked next pass while newer seeds past the cap are never seen. Should randomize or advance by `id` cursor. **P2** — bundled with the limit finding.

### `formCoherenceGroups(maxMemories=200)`, line 127

Greedy assignment: unassigned memories → existing groups via centroid similarity (>0.65), else create new group if ≥2 associations.

**Gaps / bugs:**
- **`getAllCoherenceGroups(50)`** — only checks against first 50 groups. A memory that truly belongs in group #51 gets force-created as a new group (if it has 2+ assoc) or dropped (if fewer). **P2 — lift**: coherence formation sees only first 50 groups.
- **`getUnassignedMemories(['mature', 'growing'], 200)`** — 200 cap. Same fall-behind concern. **P2** — bundled.
- **Centroid recomputation batched at end, but fresh adds during loop don't see updated centroids.** Memory M1 joins group G; M2 compared to OLD centroid of G, not the one reflecting M1's contribution. Minor for large groups, noticeable for small. **P3.**
- **New groups created without a name.** `createCoherenceGroup(null, memory.embedding!)`. Every auto-formed group is nameless. Human-readable labeling deferred, presumably. **P3.**
- **Creates groups from a single memory seed** — the "2+ associations" gate is checked BEFORE creating, but the group starts with only the seed memory. `memberCount=1` after creation. Technically valid but fragile to the next `pruneIncoherentMembers` cycle which deletes groups `< 2 members`. So: newly-formed single-seed groups get deleted on the very next pass unless other memories join. Design tension. **P2 — lift**: coherence groups often born dead.

### `mergeOverlappingGroups()`, line 178

Merge pairs with centroid similarity >0.85.

**Gaps / bugs:**
- **Nested O(N²) loop over 100 groups** = 5000 pairs. OK for 100, quadratic if raised.
- **In-memory merge tracking via `deletedIds` Set** works correctly.
- **Centroid of merged group updated, but the local `a.signature` is refetched via `.find(...)`.** `getAllCoherenceGroups(1)` returns just 1 row — likely NOT including `a`. That `find` call almost always returns `undefined`, so `a.signature` never updates during the loop. Subsequent comparisons use the stale signature. **P2 — lift**: merge loop uses stale centroid after first merge, subsequent merges biased by outdated signature.
- **No transaction across merge.** `addToCoherenceGroup` + `deleteCoherenceGroup` are sequential auto-commits. Crash mid-merge leaves members in both groups. **P3.**

### `pruneIncoherentMembers()`, line 221

Remove members with < 0.4 similarity to centroid. Dissolve groups with < 2 members.

**Gaps / bugs:**
- **Prune-then-dissolve decision** reads `getGroupMembers` twice per group — one for iteration, one post-prune count. Second call reflects the prunes. OK.
- **Dissolved groups' members become unassigned again.** Next `formCoherenceGroups` call re-evaluates them. OK cycle, but can produce oscillation (join group → pruned out → orphaned → rejoined...). **P3.**

### `inferCausalLinks()`, line 256

Pairwise temporal ordering within coherence groups. Infers prerequisite / reinforcement / tension. Capped at 5 groups per cycle, 15 members per group.

**Gaps / bugs:**
- **Existing-link check is O(N²) in assoc count.** For memory `a`, pulls up to 50 associations and scans them for `b`'s id. For each pair. `getAssociations(a.id, 50)` inside the inner loop — re-queried on every j iteration. Should be pre-loaded per i. **P3.**
- **Tension link strength hardcoded 0.3** regardless of how dissimilar (could be 0.29 or 0.01). **P3.**
- **`prerequisite` range (0.6, 0.75]** and `reinforcement` (>0.75) never overlap; `tension` is (-∞, 0.3). Memories with sim ∈ [0.3, 0.6] get no causal link inferred. That's a lot of memory space. **P3** — design choice.
- **`addCausalLink` calls `addAssociation` internally**, which does `INSERT OR REPLACE`. So repeat inference overwrites with whatever causal type is inferred THIS time. Non-deterministic across runs if the memory set grows. **P3.**

### `recomputeGroupCentroid(groupId)`, line 329

Fetches members, computes centroid, updates signature.

**Gaps / bugs:**
- **N round-trips (one `getMemory` per member).** For a 50-member group, 50 selects. Could batch. **P3.**
- **`embeddings.length === 0` → return early.** But `updateGroupSignature` isn't called, so the group keeps its stale signature even though member count may have changed. If all members deleted (unlikely), `member_count` in DB stays at old value. **P3.**

### `autoAssignToGroups(memoryId)`, line 350

Called after extraction to place a new memory.

**Gaps / bugs:**
- **Only assigns to FIRST matching group.** If memory belongs in multiple groups, only one gets it. **P3.**
- **`getAllCoherenceGroups(50)`** — same 50-group cap as `formCoherenceGroups`. Same finding.

---

## File-level notes

- **Tuning constants scattered**: 0.65 (group match), 0.85 (merge), 0.4 (prune), 0.6/0.75 (causal), ONE_DAY/7/30/14 (lifecycle). Should consolidate. **P3**.
- **No "dry run" or metrics dump.** Operators can't see what topology maintenance is about to do without running it. **P3.**
- **Callers not obvious.** `runTopologyMaintenance` is called from... somewhere. Need to confirm cadence during agent-loops audit (`src/memory/organic.ts` probably orchestrates).

## Verdict

**Lift to findings.md:**
- **P2**: Topology processing caps (500 per lifecycle state, 200 unassigned, 50 groups) cause monotonic fall-behind on active characters. Ingest rate > processing rate → oldest lifecycle state grows without bound. Either paginate with a cursor or raise the caps + randomize ordering.
- **P2**: `mergeOverlappingGroups` uses stale centroid after the first merge. The refetch via `getAllCoherenceGroups(1).find(...)` almost always returns undefined because the query fetches a DIFFERENT single group, not `a`. Subsequent merges compare against outdated signature.
- **P2**: Coherence groups often born dead — `formCoherenceGroups` creates groups with a single seed member, then `pruneIncoherentMembers` on the next cycle deletes all groups with <2 members. Newly-formed groups get dissolved before they can accrue members. Delay prune until groups have a grace period, OR change formation to seed with 2+ memories.
