---
file: src/agent/feed-health.ts
lines: 243
purpose: Weekly RSS feed health monitor (Wired Lain only). Checks each configured feed for HTTP reachability and parseable items; after 3 consecutive failures, swaps in a known-good replacement from a curated 15-feed backup pool; writes updated `workspace/novelty/sources.json`.
section: 8 (agent loops)
audit-date: 2026-04-19
---

# agent/feed-health.ts

## Function inventory (6)
- `getState()` — 64.
- `saveState(state)` — 70.
- `checkFeed(url)` — 77: fetch + item-count validation.
- `findReplacement(activeUrls, deadUrls)` — 104: shuffles + probes backup pool.
- `runHealthCheck(workspaceDir)` — 132: exported.
- `startFeedHealthLoop(opts)` — 205: exported.

## Findings

### 1. No Wired-Lain-only guard (P2 — bundle with bibliomancy, dream-seeder)

File header says "Runs weekly on Wired Lain" but `startFeedHealthLoop` has no identity check. If any other character boots this loop, they'd write to `workspace/novelty/sources.json` — competing writers on a shared file.

Per MEMORY.md deployment, characters run from different base paths but workspace is typically shared (`/opt/local-lain/workspace/`). Concurrent writes from multiple loops to the same sources.json are a real hazard.

### 2. No SSRF check on feed URLs or on replacement candidates (P2 — bundle)

Lines 79, 117. `fetch(url, ...)` directly. Same class of finding as dream-seeder #2. If sources.json is compromised, `checkFeed` happily probes attacker-chosen URLs. Additionally, `BACKUP_FEEDS` (lines 46-62) is a hardcoded list but is also reached via `checkFeed` → same code path.

### 3. `BACKUP_FEEDS` is hardcoded (P3)

Lines 46–62. 15 feeds baked into source. New domains require code changes. The swap algorithm only has these 15 options. If the attacker's injection is into the current `sources.json`, backup pool is safe; if the attack is into code (via a PR), the backup pool is already poisoned.

### 4. `writeFile(sourcesPath, ...)` is non-atomic (P2 — bundle with diary.ts)

Line 190. Same crash-during-write corruption risk. If the process crashes mid-write, sources.json is truncated/malformed. Next dream-seeder / curiosity / feed-health cycle fails to parse it and the whole feed system stops.

**Combined with finding #1**: two characters simultaneously running this loop = classic write-collision on sources.json.

### 5. Replacement logic has no persistence that a replacement is actually better than original (P3)

Lines 167–177. If the replacement also goes dead in 3 weeks, it gets replaced by another backup. No tracking of "this replacement is also in trouble". Pool-churn could rotate through all 15 backups and exhaust the pool if network is genuinely down vs individual feeds being dead.

**Observable symptom**: sustained network issue → every feed fails 3 weeks in a row → all get "replaced" → backup pool reduces by N each week → eventually empty.

### 6. XML parsing via regex for item count (P3)

Line 87:
```
const items = xml.match(/<(?:description|summary|content:encoded)>([\s\S]*?)<\/...>/gi) ?? [];
```

Regex HTML/XML parsing. Miscounts on nested CDATA, malformed XML, RSS vs Atom format differences. Threshold is only "≥ 2 items" so fuzziness probably doesn't matter, but it means the liveness signal is weak. A valid-but-slightly-unusual feed could be declared dead.

### 7. No jitter on `CHECK_INTERVAL_MS = 7 days` (P3)

Line 40. Weekly check at the same time relative to startup. Not a hot path.

### 8. `FAILURE_THRESHOLD = 3` across weeks means 3-week lag to detect a dead feed (P3)

Per-run: 3 cycles × 7 days = 21 days until replacement kicks in. Feeds die quietly for nearly a month before swap. Too slow for content-freshness goal.

### 9. `getState()` `JSON.parse(raw)` has no try/catch at line 67 (P3)

Line 67. If META_KEY is corrupt JSON, the throw propagates up to `runHealthCheck` caller which catches and logs. Functionally OK but noisy — subsequent calls would re-fail until meta is wiped.

### 10. `state.replaced` grows without cap (P3)

Lines 142, 171. Every replaced URL stays in the `replaced` dict forever. Useful as a deny-list but unbounded growth. Cosmetic.

## Non-issues / good choices
- Meta state persistence — survives restarts.
- Consecutive-failure threshold prevents flaky-network false-positives.
- Replacement is probed (`checkFeed`) BEFORE swap — no blind substitution.
- User-Agent header `'Laintown/1.0 RSS Health Monitor'` — polite crawler identification.
- Sources.json written only when replacements occurred (line 189).
- `startFeedHealthLoop` returns cleanup function.

## Findings to lift
- **P2 (bundle)**: No Wired-Lain-only guard — concurrent writers on sources.json.
- **P2 (bundle)**: No SSRF check on feed URLs.
- **P2 (bundle)**: Non-atomic `writeFile` of sources.json — partial-write corruption.
- **P3**: 3-week lag to replace dead feeds.
- **P3**: Regex XML parsing; liveness signal is fuzzy.
- **P3**: Replacement pool churn during sustained network outage exhausts backups.

## Verdict
Solid implementation for its narrow purpose. The concerns are all shared with the broader section patterns: identity guards, SSRF, atomic writes. This file is specifically interesting because it's the ONLY loop that writes to sources.json — which is then read by dream-seeder.ts, curiosity.ts, and possibly others. A corruption of sources.json radiates out to every content-ingestion loop.
