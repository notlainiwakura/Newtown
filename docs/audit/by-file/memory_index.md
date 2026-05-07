# `src/memory/index.ts`

Memory system facade. Barrel exports + high-level operations (`recordMessage`, `getRelevantContext`, `processConversationEnd`, `buildMemoryContext`). 10 functions + barrel.

## Functions

### `extractUserId(sessionKey, metadata?)`, line 66

Pulls userId from metadata first, then session-key colon-split.

**Gaps / bugs:**
- **`parts[1]` is taken blindly.** For `sessionKey = 'diary:2026-04-19'`, the userId becomes `'2026-04-19'`. For `commune:pkd`, userId becomes `'pkd'`. Every internal background-loop session has a bogus userId. Consequence: `getMessagesForUser(userId)` inside `buildMemoryContext` may match against fabricated user ids; `searchMemories(..., userId)` may return memories scoped to a date-string user. **P2 — lift**: userId hallucinated from background session keys.
- **Session-key taxonomy not checked.** Should recognize known prefixes (diary, dreams, commune, peer, letter, etc.) and return null for those. **P2** — bundled.

### `recordMessage(sessionKey, role, content, metadata?)`, line 87

Thin wrapper. Fine.

### `getRelevantContext(queryText, sessionKey, maxMemories=8, options?)`, line 110

Returns formatted string with memories.

**Gaps / bugs:**
- **`minSimilarity = 0.15`** — very low threshold. Almost anything matches. Paired with the 8-memory limit, this floods the prompt with weakly-related memories. Intentional "wide net" but risky for relevance. **P3.**
- **Silent failure returns `''`.** On error, empty context. Callers can't tell whether "no relevant memories" or "search failed". **P3.**

### `getRelevantMemoriesWithIds(queryText, sessionKey, maxMemories=6)`, line 161

Same as above, plus returns memory IDs.

**Gaps / bugs:**
- Duplicated logic with `getRelevantContext`. Both format the same way. Should extract a shared helper. **P3.**

### `shouldExtractMemories(sessionKey, latestMessage)`, line 234

Trigger heuristics. Aggressive: every 6 messages, or every 2 on high-signal.

**Gaps / bugs:**
- **`state.messagesSinceExtraction++`** happens on EVERY call, whether or not extraction fires. A caller that calls `shouldExtractMemories` twice per user turn (to preview and then actually extract) double-counts. Confusing API — should be a pure predicate + separate `incrementMessageCount`. **P3.**
- **`HIGH_SIGNAL_PATTERNS` only matches English + informal register.** A user typing in another language, or using different phrasing ("Je suis...", "I've been..."), misses. **P3.**
- **No backoff** if previous extraction returned 0 memories. Re-extracts on the same stretch of messages, paying LLM costs for nothing.

### `resetExtractionState(sessionKey)`, line 256

Updates state + LRU evicts oldest if >500 sessions cached.

**Gaps / bugs:**
- **LRU scan is O(N) on every reset.** Fine at N=500, but worth noting.
- **`EXTRACTION_STATE_MAX_SIZE = 500`** — a busy character with many concurrent sessions (visitor turnover) drops old state. A visitor who returns after a pause gets re-counted from scratch. Minor. **P3.**

### `processConversationEnd(provider, sessionKey, messagesSinceExtraction?)`, line 283

End-of-conversation pipeline: extract, auto-assign, reset state, summarize, consolidate, emit internal-state event.

**Gaps / bugs:**
- **`activeExtractions` guard is in-process only.** Two character-server processes running concurrently for the same character would both extract. In practice one process per character, but not enforced. **P3.**
- **Consolidation gate: `stats.memories % 10 === 0`** — only runs when total memory count is a multiple of 10. Race-prone: concurrent saves can skip the exact count. Cosmetic but fragile. **P3.**
- **Internal-state update lazy-imports `../agent/internal-state.js`** and `catch { /* non-critical */ }`. If the import fails (missing module, cyclic import), the error is silently swallowed and internal state never updates. **P2 — lift**: internal-state hook silently swallowed.
- **`getRecentMessages(sessionKey, fetchCount)` returns chronological order from store.ts**. Good.
- **No guard that `messagesSinceExtraction` is not larger than actual message count.** If caller passes 100 for a 5-message session, fetches 100 but only 5 exist. No bug, just wasted query.

### `getMemoryStats()`, line 353

Trivial. Two counts.

### `refreshWingNameCache()`, line 368

Reloads all wings into local map.

**Gaps / bugs:**
- **Rebuilt on EVERY `buildMemoryContext` call.** `listWings()` hits the DB. For 100 memory-context builds/day × N wings, not expensive, but the cache is useless if re-built each time. Rename to `loadWingNames()` or cache with TTL. **P3.**
- `catch {}` on fail — leaves cache empty. Subsequent reads return `'general'` as default.

### `buildMemoryContext(userMessage, sessionKey)`, line 389

THE big one. 4 layers + 1 contradiction section. Token-budgeted assembly.

**Gaps / bugs:**
- **`MAX_CONTEXT_TOKENS = 7000`** — hardcoded. Independent of provider's actual context window. A Haiku run with a 200k window wastes the headroom; a future smaller model overflows. **P2 — lift**: context budget not provider-aware.
- **Token estimation via `text.length / 4`** — rough. Real tokens for emoji, Unicode, etc. can diverge 2x. Under-counting can overflow the budget; over-counting wastes room. **P3.**
- **`getMemoriesByType('fact')` returns ALL facts (no LIMIT per store.ts audit).** Then sorted in JS. For a character with hundreds of facts, this loads all, sorts all, and takes top 6. Wasteful. **P3.**
- **Layer 1 wing grouping** — calls `wingNameCache.get(m.wingId)`, which was freshly rebuilt. For memories created since the last call but before the rebuild, this works. Fine.
- **Layer 3a "current conversation"** — uses `getMessagesForUser(userId, 12)`. But `extractUserId` may have hallucinated a bogus userId (e.g. `'2026-04-19'` for a diary session). The query returns empty → user sees "no active conversation". **Context-degradation consequence of the extractUserId P2.**
- **Layer 3a "other visitors"** — uses `getRecentVisitorMessages(20)` which has the diverging-prefix P2 flagged in store.md — returns diary/dream/curiosity messages as visitors. The context block says "A visitor (via diary) said: ...". **P2 — lift**: ambient context mixes autonomous loops with real visitors.
- **Layer 3b association lookup** — `getGroupsForMemory(id)` in a loop. N+1 query pattern. For 6 memories, 6 extra queries. **P3.**
- **Layer 3c "browsing discoveries"**: double-query — once with topic, once with a fallback hardcoded query `'interesting topics and discoveries'`. Two embedding generations, two KNN calls. Should consolidate. **P3.**
- **Layer 4 resonance** — `getResonanceMemory` has its own strategy rotation but here always tries once per context build. Could be expensive if every message builds a fresh context (which is what happens). Each user turn → one getResonance call → `ORDER BY RANDOM()` scan. **P2 — lift**: `ORDER BY RANDOM()` in resonance fires every context build, full-scan on `memories` table.
- **Contradictions block** — `detectContradictions()` is O(N²) worst case (per knowledge-graph.md). Runs on every context build. For a populated DB with many active triples, this is noticeable. **P2 — lift**: contradiction detection runs per-message, not cached.
- **Error handling catches at each layer** — but ALL errors are logged at `debug` level except layer 3a's "Failed to get recent messages" at `warn`. Operators won't see silent layer failures in prod. **P3.**

### `getTypeLabel(type)`, line 712

Switch-case label. Fine.

---

## File-level notes

- **Token-budget bookkeeping is manually threaded** — easy to miss a branch. A bit procedural. Could be refactored into a `BudgetAccumulator` helper. **P3.**
- **`buildMemoryContext` is the character's self-understanding** — every user turn builds it fresh. Latency-critical. Should profile.
- **`getRelevantContext` and `buildMemoryContext` both exist.** Unclear which is canonical. `getRelevantContext` simpler, returns just memories formatted; `buildMemoryContext` is the full context builder with 4 layers. Callers could use either. **P3** — consolidate or document the split.

## Verdict

**Lift to findings.md:**
- **P2**: `extractUserId` hallucinates a user id from background-loop session keys (`diary:2026-04-19` → userId=`'2026-04-19'`, `commune:pkd` → userId=`'pkd'`). Every downstream call that scopes to this bogus userId (memory search, getMessagesForUser) returns nothing or the wrong set. Fix: recognize known background-loop prefixes and return null for those, or namespace user IDs.
- **P2**: `buildMemoryContext` Layer 3a pulls "other visitors" via `getRecentVisitorMessages` which (per store.ts P2) includes autonomous-loop messages. The context block labels them "A visitor (via diary) said: ..." — confusing the LLM about who it's talking to.
- **P2**: `buildMemoryContext` runs `detectContradictions()` + `getResonanceMemory()` on EVERY message. Both are table-scan-class operations. On large DBs, each user turn triggers two full scans. Cache both with a short TTL (5-15 min).
- **P2**: `MAX_CONTEXT_TOKENS = 7000` is hardcoded — independent of the actual provider's context window. Bigger-context models waste headroom; smaller-context models overflow. Read from `ProviderConfig` (ties to the tunables P2 already lifted).
- **P2**: `processConversationEnd` internal-state hook is lazy-imported + `catch { /* non-critical */ }` — a failing import silently blocks internal-state updates for the entire run. Ties to character-integrity concerns.
