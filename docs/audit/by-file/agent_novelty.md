---
file: src/agent/novelty.ts
lines: 476
purpose: Zero-LLM-cost novelty engine. Pulls RSS + Wikipedia + static fragments from `workspaceDir/novelty/*.json`, expands templates (ambient + major seeds), and fires as town events via `createTownEvent`. Rate-limited per-week (major) and recency-deduped (both). Refreshes fragment cache on timer.
section: 8 (agent loops)
audit-date: 2026-04-19
---

# agent/novelty.ts

## Function inventory (21)
- `expandTemplate(template, fills)` — 17: exported.
- `pickRandom<T>(pool)` — 21: exported.
- `pickRandomBuilding()` — 25: exported.
- `pickRandomTime()` — 30: exported.
- `loadStaticFragments(workspaceDir)` — 53: exported.
- `loadSourcesConfig(workspaceDir)` — 60.
- `truncateToSentence(text, maxLength)` — 66: exported.
- `stripHtml(html)` — 78.
- `fetchRssFragment(sources)` — 82.
- `fetchWikipediaFragment(sources)` — 101.
- `pickFragment(workspaceDir, weights)` — 114: exported.
- `refreshFragmentCache(workspaceDir, cacheSize)` — 135: exported.
- `loadAmbientTemplates(workspaceDir)` — 190.
- `loadMajorSeeds(workspaceDir)` — 196.
- `buildFills(placeholders, staticPools, fragment)` — 202.
- `generateAmbientEvent(workspaceDir, config)` — 222: exported.
- `generateMajorEvent(workspaceDir, config)` — 233: exported.
- `getWeekKey()` — 249.
- `isMajorLimitReached(maxPerWeek)` — 256: exported.
- `recordMajorFiring()` — 263: exported.
- `isRecentlyUsedTemplate(templateId)` — 271.
- `recordTemplateUse(templateId, maxRecent)` — 278.
- `loadNoveltyConfig(workspaceDir)` — 316: exported.
- `startNoveltyLoop(params)` — 328: exported.
- `runNoveltyCheck(config, params)` — 396.

## Findings

### 1. No SSRF check on RSS feeds or Wikipedia endpoint (P2 — bundle)

Lines 86, 104. Both `fetch()` calls hit URLs read from `sources.json` without SSRF validation. Same class of finding as feed-health.ts, dream-seeder, newspaper.ts. If `sources.json` is tampered (see feed-health.ts #4: non-atomic writes + concurrent writers), these loops probe attacker-chosen URLs.

Has AbortSignal.timeout(10000) — good.

### 2. Fragment content flows into town events (P2 — bundle)

Line 407-412: fragment text becomes town-event `description`, marked `narrative: true, natural: true`. Characters encounter town events through their memory/commune pipeline — so attacker-controlled RSS content can land in character memories as "ambient novelty".

Amplification chain: RSS item → `fetchRssFragment` → `pickFragment` → `buildFills.fragment` → template expansion → `createTownEvent` → all characters' event consumption → their memories.

### 3. `stripHtml` regex — incomplete sanitization (P3)

Line 79: `html.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ')`. Strips tags and HTML entities. Does not handle:
- Unclosed tags like `<script` (no closing `>`).
- JavaScript URLs in attribute values that weren't stripped.
- Nested `<![CDATA[...]]>` which the regex would partially consume.

Since output is plain text going into LLM prompts (not rendered HTML), injection is prompt-level not XSS — still problematic. But the regex is a best-effort mitigation, not rigorous. For trust-limited sources, this is inadequate.

### 4. `refreshFragmentCache` has no cap on iteration (P3)

Line 138: `for (let i = 0; i < cacheSize; i++)`. If `cacheSize` is huge (config misconfig), makes N network fetches per refresh. No rate limit between fetches. Could hammer Wikipedia API.

Mitigation: `refreshIntervalMs` in config determines cadence; if it's hourly+, `cacheSize` of 50 is survivable. But no enforced maximum.

### 5. `loadSourcesConfig` reads every `pickFragment` call (P3)

Line 121 inside `pickFragment`. Re-reads sources.json from disk every single call. If novelty fires frequently, that's O(calls) disk reads. Minor — file is small and OS caches — but wasteful.

`loadAmbientTemplates` / `loadMajorSeeds` similar (lines 223, 234).

### 6. Template placeholder extraction via regex (P3)

Line 237-238: `seed.template.match(/\{(\w+)\}/g)?.map(m => m.slice(1, -1))`. If template contains `{` literal (e.g., "{not-a-placeholder}") that matches `\{(\w+)\}`, it'd be treated as placeholder. Template authors have to avoid curly-brace literals.

### 7. `recordMajorFiring` called for multi-beat continuations (P2)

Line 423. Each beat of a multi-beat major event increments weekly major count. If a 5-beat event fires, it consumes 5 of `maxPerWeek` slots. Not necessarily wrong (beats ARE major deliveries) but the intent might be "one major event = one count" rather than "one delivery = one count". Worth checking expectation.

**Observable**: a multi-beat seed can quickly exhaust weekly major budget.

### 8. `pending_beats` meta key — single pending event at a time (P3)

Lines 400-427. Only one multi-beat sequence can be pending at any moment. If a second major event wants to multi-beat while one is pending, it either has to wait or gets dropped. Not a bug — intentional serial delivery — but worth flagging.

### 9. `isRecentlyUsedTemplate` recency list (positive)

Lines 271-284. Prevents immediate-repeat of the same template. Separate caps for ambient (10) and major (5). Good anti-repetition.

### 10. `getWeekKey` custom week calculation (P3)

Line 249-254. Hand-rolled ISO-ish week. Correct-enough, but edge cases around year boundaries (week 52 → week 1 near Dec 31) are ambiguous. Year + week key is close to ISO-week but may drift by one day some years. Cosmetic — novelty count resets incorrectly by a day or two per year.

### 11. `categoryDurations['major-default']` vs `durations[template.category]` (P3)

Lines 228-229, 242-243. Ambient uses `durations[template.category] ?? durations['major-default']` — the fallback uses the MAJOR default for ambient. That's likely a bug-by-naming: the fallback key name suggests majors but ambient inherits it. Effect: ambient events with unknown categories get 12h persistence (major default), not 4h (the hardcoded `14400000` = 4h fallback).

Actually re-reading: `durations[template.category] ?? durations['major-default'] ?? 14400000`. Third fallback is 4h (14400000ms). So if neither category nor major-default is set, ambient defaults to 4h. Middle fallback only triggers if category is missing AND major-default IS set. Cosmetic but confusing.

### 12. `cacheLastRefreshed` exported but never read elsewhere (P3)

Line 40. Dead export — not used within the module, likely for tests. Consistent with codebase. OK.

### 13. Rate-limit / recency keys use global `novelty:*` meta (P3)

Lines 257, 264, 272, 279, 400, 419. Per-character DB scoping via getBasePath is implicit. Each character has its own novelty counts. For "town events" (shared-state feature), this is an interesting choice: each character decides independently whether to fire, and fires into their own event stream. Cross-character coordination would require shared state.

**Implication**: if 6 characters all run novelty loop, the town sees up to 6× as many novelty events as a single-character run. Whether that's intended depends on whether `createTownEvent` broadcasts or is per-process.

### 14. `init()` unawaited (P3)

Line 384. `init().catch(...)` pattern — fire-and-forget. If init takes long, `startNoveltyLoop` returns before timers are set. Caller's cleanup function would clear null timers — safe — but first novelty check might be delayed unexpectedly.

### 15. Initial check at 5min fixed delay (line 374, P3)

No jitter. If 6 characters all start simultaneously, all fire initial check at T+5min concurrently. Minor.

### 16. `buildFills` silently drops unknown placeholders (P3)

Line 202-220. If template has `{foo}` but `staticPools['foo']` doesn't exist and it's not 'fragment' / 'building' / 'time', the key isn't set in `fills`. `expandTemplate` at line 18 keeps the raw `{foo}` literal in output. Town event description contains `{foo}` — cosmetic bug that surfaces as noise in character reactions.

## Non-issues / good choices
- Workspace-driven templates & fragments — editable without code changes.
- Caching + refresh — bounded cost.
- Anti-repetition recency list.
- Weekly major cap.
- Clean timer cleanup.
- AbortSignal.timeout on all external fetches.
- `narrative: true` marker on town events — downstream can distinguish novelty.
- Graceful fallback to static fragments when external sources unavailable.

## Findings to lift
- **P2 (bundle)**: No SSRF on RSS/Wikipedia fetches.
- **P2 (bundle)**: Fragment content → town events → character memories (amplification chain).
- **P2**: Multi-beat majors each increment weekly major count — potential budget exhaustion.
- **P3**: `stripHtml` regex sanitization incomplete for adversarial XML.
- **P3**: `major-default` duration fallback key-naming ambiguous.
- **P3**: Unknown placeholders surface as raw `{foo}` in town events.
- **P3**: `loadSourcesConfig` re-reads per call.

## Verdict
Zero-LLM-cost design is the right call for breaking conversation loops. The main concerns are the usual section-wide bundles (SSRF, injection-propagation from external feeds) and one novel one: multi-beat majors consuming weekly budget faster than expected. The static/RSS/Wikipedia blend with fallback-to-static is defensible against upstream outages. Would benefit from an SSRF pass on the fetch sites.
