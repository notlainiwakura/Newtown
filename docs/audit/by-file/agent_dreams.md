---
file: src/agent/dreams.ts
lines: 770
purpose: Unconscious-processing loop — during quiet periods, picks a seed memory, does a random walk through memory via associations + embedding drift, optionally generates an LLM "dream fragment", creates new dream associations, subtly shifts emotional weights, rarely saves "residue" memory, and may wander the character to The Threshold building.
section: 8 (agent loops)
audit-date: 2026-04-19
---

# agent/dreams.ts

## Function inventory (17)

- `startDreamLoop(config?)` — 80: 30-min check interval + event-bus trigger on conversation end.
- `shouldDream()` — 126 (closure): quiet + interval + ≥10 embedded-memory gates.
- `getLastUserMessageTimestamp()` — 230: SQL single-row.
- `runDreamCycle(config)` — 239: 5-step pipeline.
- `updateDreamMeta()` — 285.
- `selectSeedMemory()` — 293: priority to alien seed, rotate remaining strategies.
- `trySeedStrategy(strategy)` — 311: per-strategy SQL.
- `randomWalk(seed, config)` — 405: up to 8 steps.
- `shuffleSample(arr, k)` — 425: reservoir sample.
- `takeStep(current, allMemories, visited)` — 436: coin-flip association vs embedding drift.
- `takeAssociationStep(current, visited)` — 451: weighted toward weaker associations.
- `takeEmbeddingStep(current, allMemories, visited)` — 477: similarity ∈ [0.15, 0.5], weighted toward distant.
- `weightedRandomPick(items, weights)` — 515.
- `generateDreamFragment(walkResult, config)` — 532: LLM-generated text + connection pairs.
- `parseDreamFragment(response)` — 591: extracts CONNECTIONS: pairs.
- `applyDreamEffects(walkResult, fragment, config)` — 618: new associations + emotional weight shifts.
- `getDreamPairs(walkResult, fragment)` — 676: LLM-suggested or skip-1 fallback.
- `saveDreamResidue(walkResult, fragment, _config)` — 695: compress → saveMemory → spawnDesireFromDream.
- `driftToThreshold(logger)` — 756: 25% chance to setCurrentLocation('threshold', ...).

---

## Findings

### 1. Repeated `getAllMemories()` across cycle — O(N) allocation storm (P2)

Call sites: 144, 322, 350, 361, 388, 466. `getAllMemories()` loads every memory row (with content, metadata, embedding blob) into memory. Per MEMORY.md, Lain has ~15K memories.

**In one cycle**:
- `shouldDream()`: filters embeddings → full load
- `selectSeedMemory()` → `trySeedStrategy` runs up to 5 strategies (alien, emotional, resonance, recent, random). Emotional/recent/random each fetch via SQL for an id then do `getAllMemories().find(...)` → another full load.
- `randomWalk()` at line 406: loads all memories again
- Every `takeAssociationStep` (up to 8 iterations) at line 466: another full load

**Rough count**: 8-12 full table loads per cycle, each materializing the full memory table. Memory-pressure + JIT warmup penalty.

**Gap:** should load once at cycle start and pass the memory array. The walk already passes `allMemories` to `takeStep` — association step bypasses that and re-fetches.

### 2. `shouldDream` uses `getAllMemories().filter(...).length < 10` instead of COUNT(*) (P2)

Line 144. Called on every check timer fire (30min). For each check, the whole memories table is pulled from SQLite, materialized as objects, filtered, then counted — all to check if there are ≥10 embedded memories. `SELECT COUNT(*) FROM memories WHERE embedding IS NOT NULL` would be O(1) indexed.

### 3. `setCurrentLocation('threshold', ...)` implicit eventBus.characterId (P2 — bundle with curiosity-offline #4)

Line 765. Same pattern: argless character identity, relies on eventBus.characterId. Fragile.

### 4. Default-to-Lain identity in dream fragment prompt (P2 — bundle)

Line 551: `process.env['LAIN_CHARACTER_NAME'] || 'Lain'`. Same fail-open pattern.

### 5. Raw memory content flows into LLM fragment prompt + injection persistence (P2 — bundle)

Lines 544–549: truncates memory content to 150 chars, sends directly to LLM. Then line 722 saves the LLM's dream-residue back as a memory. Classic injection persistence chain.

**Plus**: line 743 calls `spawnDesireFromDream(residueText)` — LLM-generated text fed into the desire system (to audit later). Injection surface propagates.

### 6. `alien dream seed` strategy is a targeted injection vector (P1-latent — needs auth review of /api/interlink/dream-seed)

Lines 360–379. Any memory with `sessionKey === 'alien:dream-seed'` AND `metadata.isAlienDreamSeed === true` (and not yet consumed) becomes a seed priority — *always* picked before other strategies (line 295).

**How these get planted:** dream-seeder.ts POSTs to `/api/interlink/dream-seed`. That endpoint must enforce `LAIN_INTERLINK_TOKEN` auth; if auth is weak/missing, anyone can plant attacker-chosen text that is *guaranteed* to surface in the next dream cycle, pass through `generateDreamFragment` LLM, become `dream:residue` memory, and spawn a desire.

**Mitigation today**: assume the interlink endpoint has bearer-token auth. Flag for Section 9 (web/server.ts) to verify the endpoint's auth and content validation. If the endpoint doesn't sanitize `content` length/type, a single poisoned seed can derail a character.

### 7. Emotional weight mutations — bounded but unaudited drift (P2)

Lines 657–664: for each walk step (up to 8), applies random `(±0.025)` shift to `emotional_weight`. Over many cycles this is effectively a random walk on each frequently-dreamed memory's emotional weight. Clamped to [0,1], so no overflow — but expected-value argument is weak: memory weight drifts toward mean over time, potentially flattening emotional landscape.

**Not a bug, but worth measuring.** Is this the intended "subtle shifts in what feels important" behavior? Probably yes — matches the design comment at top of file ("subtly shifting emotional weights").

### 8. SQL UPDATEs in loop without transaction (P3)

Lines 660–663. 8 individual UPDATEs per cycle. Each open/close/fsync in SQLite. Should wrap in a `BEGIN / COMMIT` transaction for atomicity + throughput.

### 9. `alien seed` metadata.consumed update overwrites ALL existing metadata (P3)

Line 374: `execute('UPDATE memories SET metadata = ? WHERE id = ?', [JSON.stringify({ ...pick.metadata, consumed: true, consumedAt: Date.now() }), pick.id])`. Actually — it spreads `pick.metadata` first, which is the JS object. BUT if any other process modifies the memory's metadata between `getAllMemories()` (line 361) and this UPDATE, those changes are overwritten (last-writer-wins). Given single-process-per-character isolation, probably OK, but fragile.

### 10. `takeEmbeddingStep` reservoir sample each call (P3)

Line 485: re-samples up to 500 memories per step (up to 8 steps per cycle). Should reuse the sampled pool across steps.

### 11. Dream residue saveMemory has hardcoded importance 0.3 and emotionalWeight 0.5 (P3)

Line 727. Magic constants. Should either parameterize via DreamConfig or derive from walk-step emotional weights.

### 12. Event-driven early trigger bypasses `shouldDream()` gating on interval/cycle (P3)

Line 199: `maybeRunEarly` path sets a 1-minute delay + doesn't check `shouldDream`. But scheduleNext at line 162 checks shouldDream inside the timer body — so the check does happen. OK in practice but the comment at line 201 ("no separate COOLDOWN_MS") is misleading; the interval check *inside* shouldDream still gates.

### 13. `driftToThreshold` only considers 'threshold' as destination (P3)

Line 765: `setCurrentLocation('threshold', ...)`. 'threshold' is hardcoded. If BUILDINGS is reorganized and there's no threshold building, `isValidBuilding` returns false and drift silently skips. Line 754 constant `THRESHOLD_DRIFT_PROBABILITY` also a magic number.

---

## Non-issues / good choices

- Quiet-threshold gate (30min silence) prevents dream-while-active interference.
- Alien-seed consumed flag prevents double-use of planted seeds.
- `shuffleSample` uses proper reservoir algorithm, not `Math.random` compare-sort.
- `weightedRandomPick` handles zero-weight edge case.
- Parameterized DreamConfig with explicit ranges for association strength.
- Connection pairs from LLM validated against walk-step indices (line 681).
- `parseDreamFragment` minimum text length gate (line 611: `< 10`).
- Walk skips already-visited memories — no cycles.
- Embedding-drift zone [0.15, 0.5] sensibly picks "related but not identical".
- Dream residue probability 0.2 keeps residue memories sparse.

---

## Findings to lift to findings.md

- **P1-latent**: `alien dream-seed` strategy is guaranteed-priority surface for injection; depends on `/api/interlink/dream-seed` auth+validation. Flag for Section 9 auth audit.
- **P2**: `getAllMemories()` called 8-12× per cycle — O(N) allocation storm. Should load once.
- **P2**: `shouldDream` uses `getAllMemories().filter(...).length` instead of `COUNT(*)`.
- **P2**: `setCurrentLocation('threshold', ...)` implicit eventBus.characterId (bundle).
- **P2**: Default-to-Lain identity in fragment prompt (bundle).
- **P2**: Prompt-injection persistence via dream-residue → spawnDesireFromDream chain (bundle).
- **P2**: Emotional weight drift bounded but unaudited — measure effect over time.
- **P3**: SQL UPDATEs in loop without BEGIN/COMMIT transaction.
- **P3**: `takeEmbeddingStep` re-samples 500 per step instead of once per walk.
- **P3**: Hardcoded importance/emotionalWeight in residue saveMemory.
- **P3**: `driftToThreshold` hardcodes 'threshold' + probability magic number.
- **P3**: Alien-seed metadata UPDATE last-writer-wins over pending modifications.

## Verdict
Thoughtful design — alien seeds, multi-strategy rotation, weighted-random walk with dream-zone similarity, LLM connection-pair suggestion, residue memories, post-dream drift to Threshold. Performance-wise the repeated `getAllMemories()` and `shouldDream` full-table loads are the biggest concerns on large memory corpora. Security-wise the alien-seed injection path is one endpoint-auth audit away from being the dominant surface.
