---
file: src/agent/curiosity.ts
lines: 1342
purpose: Autonomous browsing loop — periodically reflects on conversations/memories, generates an LLM-authored "curiosity thought", fetches a whitelisted site, digests result into memory, and optionally shares via proactive message. Also runs a movement-decision phase that can relocate the character between buildings.
section: 8 (agent loops)
audit-date: 2026-04-19
---

# agent/curiosity.ts

## Function inventory (21 top-level + nested)

### Top-level exported
- `startCuriosityLoop(config?)` — 84: timer registration, initial-delay restore, event-bus subscriptions, returns stop fn.

### Module-private
- `curiosityLog(context, data)` — 37: append-only debug log to cwd-relative file.
- `loadWhitelist()` — 68: reads `browsing-whitelist.txt` synchronously every call.
- `runCuriosityCycle(config)` — 210: orchestrates four phases.
- `phaseInnerThought(provider, whitelist, unrestricted)` — 278: LLM-authored `{site, query}`.
- `phaseBrowse(site, query, maxChars)` — 439: dispatches to site-specific handlers.
- `browseWikipedia(query, maxChars)` — 467: two-hop REST fetch; no timeout.
- `browseArxiv(query, maxChars)` — 491: XML parse; no timeout.
- `browseAeon(query, maxChars)` — 515: search→article scrape; has 15s timeout.
- `browseGeneric(site, query, maxChars)` — 554: tries `/search?q=`, falls back to homepage; 10s timeout.
- `parseDigestResponse(response)` — 596: regex parse of structured digest format.
- `calculateDiscoveryImportance(digest)` — 623: base 0.6 + 0.1 per optional field.
- `phaseDigest(provider, thought, content)` — 634: LLM digests browsed content, saves memory, optionally shares.
- `loadDownloadQueue()` / `saveDownloadQueue(q)` — 782 / 792: meta-table-backed queue.
- `enqueueDownloadRetry(url, themes)` — 796: dedup + append.
- `tryDownloadDataset(url, themes)` — 812: wrapper with logging.
- `retryQueuedDownloads()` — 831: re-tries queued, caps at 3 attempts.
- `downloadDataset(url, themes)` — 865: HTTPS-only, SSRF-checked, size-limited, UTF-8-validated download.
- `loadQuestionQueue()` / `saveQuestionQueue(q)` — 1031 / 1044.
- `enqueueCuriosityQuestions(questions, site, themes)` — 1051: dedup, MRU cap.
- `markQuestionExplored(queryText)` — 1084: fuzzy `includes` match.
- `getUnexploredQuestions(limit=3)` — 1102.
- `linkRelatedDiscoveries(newMemoryId, content)` — 1113: semantic-search + `linkMemories` + metadata enrichment.
- `getRecentDiscoveries(limit=3)` — 1154: recent browse-memories formatted for inner-thought prompt.
- `loadThemeTracker()` — 1188.
- `updateThemeTracker(themes)` — 1201: increment counts.
- `linkEvolutionChain(memoryId, themes)` — 1216: shared-theme (≥2) ancestor linking.
- `phaseMovementDecision(provider, thoughtContext)` — 1266: LLM decides STAY vs MOVE among BUILDINGS.

Plus `maybeRunEarly(reason)` at 171, closure-scoped inside `startCuriosityLoop`.

---

## Critical findings

### 1. Character-identity leak throughout prompts (P1 — same class as agent/persona.ts)

**Symptoms:** Five separate prompt strings hardcode "You are Lain":
- line 289: visitor-message context labels assistant side as `Lain`
- line 376: phaseInnerThought — `You are Lain. It's quiet right now...`
- line 641: phaseDigest — `You are Lain. You just looked up something...`
- line 1292: phaseMovementDecision — `You are Lain. You live in a small commune town with 9 buildings.`

Plus User-Agent strings at 517, 564, 901, 920 all identify as `Lain/1.0 (curiosity-browser)`.

**Fits the system?** No. `startCuriosityLoop` is callable by any character server. On the droplet, Wired Lain, McKenna, Dr. Claude, Pkd, etc. each instantiate their own character-server which may start this loop. Every one of them then receives prompts claiming they are Lain, and every HTTP fetch they make identifies as Lain to remote servers.

**Gap:** No character-name parameter threaded through. The function signature takes only `config`, not identity.

**Consequence:** Duplicates the persona.ts P1 — prompts across the codebase assume "Lain" even when loaded by a non-Lain character. Output from the LLM will then reflect that confused identity and feed back into that character's memory. In practice Wired Lain's curiosity loop may be suppressed/disabled, but the code contains the bug regardless.

---

### 2. phaseBrowse bypasses SSRF protection (P1)

**Where:** Lines 439–581. `browseWikipedia`, `browseArxiv`, `browseAeon`, `browseGeneric` all call `fetch(url)` without calling `checkSSRF`.

By contrast, `downloadDataset` at line 883 DOES call `checkSSRF(url)` before fetching. So the file knows the helper exists and chose not to wire it into the browse path.

**Fits the system?** No. The whitelist is the only gate, and it has escape hatches:
1. `'*'` sentinel in line 99 / 221 disables all domain checks outright (Wired Lain's config uses this).
2. Even with a restrictive whitelist, `browseGeneric(site, query)` at line 557 interpolates `site` directly into the URL. A whitelisted entry like `example.com` whose DNS temporarily resolves to `169.254.169.254` (DNS rebinding) or RFC1918 (misconfigured DNS, split-horizon) punches straight through.
3. The whitelist file itself is read synchronously from cwd every call (line 70) with no integrity check — anything that writes to the cwd (e.g., a misconfigured container volume, a hypothetical file-writing tool) can add domains.

**Gap:** `phaseBrowse` should call `checkSSRF` on every resolved URL before fetching, regardless of whitelist membership.

**Consequence:** Under `'*'` (unrestricted) mode, this is a full SSRF primitive driven by LLM output. Under restricted mode, it's a defense-in-depth gap; not currently exploitable given the fixed whitelist but one bad commit to `browsing-whitelist.txt` away from exploitable.

**Prompt-injection chain:** attacker-controlled text in a prior visitor message → phaseInnerThought LLM output picks attacker-chosen `SITE: whitelisted-cdn.example.com` where DNS is controlled → fetch hits internal service → response fed into phaseDigest prompt → digest content exfiltrated via trySendProactiveMessage (line 759).

---

### 3. Arbitrary LLM-authored content flows into proactive shares (P1-ish, cross-file chain)

**Where:** Line 758–767. `phaseDigest` extracts `SHARE:` from LLM response and passes it to `trySendProactiveMessage(digest.share, 'curiosity')`.

**Fits the system?** The digest prompt tells the LLM the `SHARE` field is what gets "sent to the user". Content seen by the LLM includes `content` (line 644 — raw browsed HTML text) and `thought.rawThought` (line 643). Both are attacker-controllable via prompt injection on any browsed page (the whitelist doesn't prevent page contents from being attacker-authored — wikipedia, arxiv, aeon all allow submissions or have comment sections or historical vandalism windows).

**Gap:** No content filtering, no length cap beyond the LLM's own 512-token budget, no user warning that this came from a browsed source.

**Consequence:** classic indirect-prompt-injection → DM exfiltration chain. Telegram user receives attacker-authored text as if from Lain. Depends on `trySendProactiveMessage` rate-limiting; defer final severity to `proactive.ts` audit but flag here.

---

## Significant issues

### 4. Shared cwd-relative log file across every character process (P2 — same class as tools.ts agentLog/toolLog)

Line 35: `CURIOSITY_LOG_FILE = join(process.cwd(), 'logs', 'curiosity-debug.log')`. Every character server running from `/opt/local-lain/` appends to the same file. Interleaved writes from Lain + Wired Lain + McKenna etc. make the log unparseable per-character. No rotation, no size cap — unbounded growth.

### 5. Shared cwd-relative whitelist across every character (P2)

Line 62: `WHITELIST_PATH = join(process.cwd(), 'browsing-whitelist.txt')`. Same cwd, same file. Can't express per-character policies like "Lain limited to whitelist, Wired Lain unrestricted" through the file alone — requires the `'*'` sentinel to be set globally, which then applies to Lain too. Per-character memory about deployment (MEMORY.md) says Lain has whitelisted access and Wired Lain has unrestricted access — this arrangement appears **not actually enforced at this file**. If both run `startCuriosityLoop`, both see the same whitelist.

**Verification:** worth grepping where each character's loop is actually instantiated and whether unrestricted-mode Lain has been shipped accidentally. Flag for Section 9 (character-server) follow-up.

### 6. browseWikipedia / browseArxiv have no fetch timeout (P2)

Lines 469, 480, 493. `fetch(searchUrl)` / `fetch(summaryUrl)` / `fetch(url)` with no `signal`. Compare to browseAeon (line 518: `AbortSignal.timeout(15000)`) and browseGeneric (line 565: `AbortSignal.timeout(10000)`). A hung Wikipedia/arxiv connection will block the curiosity cycle indefinitely; in the worst case, indefinitely stalls a `isRunning=true` state that blocks `maybeRunEarly` early triggers.

### 7. phaseInnerThought prompt leaks memory content directly to LLM without scrubbing (P2)

Line 289–293: `getRecentVisitorMessages(20)` content is truncated to 150 chars and concatenated into the prompt. If any past user message contained prompt-injection, it's replayed here — this is the LLM's long-term behavioral surface, and the extraction is unfiltered.

Lines 299–305: similarly for `searchMemories('interesting topics...')`. Importance-sorted memory content goes straight into the prompt. Memory content includes prior digest outputs which were themselves derived from browsed content — two-hop prompt-injection persistence.

**Consequence:** A single successful injection becomes persistent via saveMemory at line 682 and will resurface in future inner-thought prompts. No sanitization layer between memory store and LLM prompt.

### 8. Unrestricted `'*'` sentinel disables whitelist silently (P2)

Line 99, 221. A single `*` line in `browsing-whitelist.txt` switches the loop to accept any domain from LLM output. There's no warning log, no feature flag, no per-character gate — it's purely file-based. A typo, accidental commit, or file-system misconfiguration that creates such a line flips the entire browse-path policy.

### 9. Movement prompt hardcodes building count (P2 / P3)

Line 1292: `You live in a small commune town with 9 buildings.` The `BUILDINGS` array is imported at line 1274 and iterated for the building list, but the prompt text doesn't interpolate `BUILDINGS.length` — so if the town grows to 10 buildings, the prompt remains stale and inconsistent with the building-list body. Minor but typical drift risk.

### 10. fuzzy `markQuestionExplored` match is too loose (P2)

Line 1090: `q.question.toLowerCase().includes(lower) || lower.includes(q.question.toLowerCase())`. If the user's query text is a single word that happens to appear inside a queued question, that question is marked explored even if unrelated. Queued questions leak away over time.

### 11. `readFileSync` on every cycle blocks the event loop (P3)

Line 70, called from `runCuriosityCycle` line 220 once per cycle (hourly). Not a hot path — but symmetric pattern with other loops suggests worth noting.

### 12. Event-driven early trigger race (P3)

Lines 171–186. `maybeRunEarly` reads `isRunning` flag, clears pending `timer`, schedules a new one. Two events in quick succession both pass the `!isRunning` gate and both call `clearTimeout` + `scheduleNext` — idempotent enough that no harm, but the pattern is fragile. Single-threaded Node serialization saves this; a future refactor to async flag could regress.

### 13. Dynamic import silent-catch pattern (P2-bundled)

Line 360 (preoccupations), line 709 (updateState), line 714 (eventBus.emitActivity), line 1273 (location module). Same silent-catch pattern documented in tools.ts and earlier files. Failure of internal-state.ts or location.ts never surfaces — these loops would appear to work while quietly dropping state updates.

### 14. User-Agent `Lain/1.0` leaks identity to remote servers (P3, bundled with #1)

Lines 517, 564, 901, 920. Every outbound HTTP hit from any character's curiosity loop identifies as `Lain/1.0 (curiosity-browser)`. Plus the identity-leak P1, remote servers can correlate curiosity-browsing across characters as "Lain".

---

## Non-issues / positive observations

- **Whitelist match uses `endsWith('.' + domain)`** (line 423) — correctly prevents `evil-wikipedia.org` style bypass by requiring dot prefix. Good.
- **`downloadDataset` IS SSRF-protected** (line 883) and size/type-limited (lines 898–961) and does HTTPS-only (line 877). Good defense-in-depth — but isolated to the dataset path, not reused in phaseBrowse.
- **Content-length HEAD check falls through to enforced read-side size cap** — layered check, good.
- **UTF-8 fatal decode rejects binary content** (line 950) — good.
- **`trimStart().startsWith('<!')` rejects HTML-posing-as-data** (line 958) — good.
- **Question queue deduplicates by lowercase text** (line 1058) — good.
- **Evolution chain requires ≥2 theme overlap** (line 1238) — defensible heuristic.
- **`getInitialDelay` persists `curiosity:last_cycle_at`** across restarts (line 117–141) — good, avoids fresh-jitter on every crash-restart.
- **Raw SQL at 1137/1250 uses parameterized queries** — no injection.
- **Per-character meta-table storage** (DOWNLOAD_QUEUE_KEY, QUESTION_QUEUE_KEY, THEME_TRACKER_KEY) — each character has their own DB per `~/.lain-<id>/lain.db`, so queues are properly isolated.

---

## Findings to lift to findings.md

- **P1**: Character-identity leak — `startCuriosityLoop` hardcodes "Lain" in 5+ prompts and 4+ User-Agent strings. Mirrors agent/persona.ts P1.
- **P1**: `phaseBrowse` bypasses SSRF — `browseWikipedia`/`browseArxiv`/`browseAeon`/`browseGeneric` do not call `checkSSRF` even though `downloadDataset` in the same file does.
- **P1 (chain)**: Prompt-injection exfiltration via `phaseDigest.share` → `trySendProactiveMessage`. Cross-ref tools.ts SSRF P1 and upcoming proactive.ts review.
- **P2**: Shared cwd-relative `logs/curiosity-debug.log` across every character process.
- **P2**: Shared cwd-relative `browsing-whitelist.txt` — prevents per-character browse policy; MEMORY.md claims per-character policy is enforced, but this file does not enforce it.
- **P2**: browseWikipedia / browseArxiv have no fetch timeout.
- **P2**: Memory-derived prompt replay carries prompt-injection indefinitely through saveMemory → phaseInnerThought loop.
- **P2**: `'*'` unrestricted sentinel disables whitelist silently with no alert.
- **P2**: fuzzy `markQuestionExplored` match too loose (substring-in-both-directions).
- **P2-bundle**: Dynamic-import silent catches (preoccupations, updateState, eventBus, location).
- **P3**: Movement prompt hardcodes `9 buildings` count instead of `BUILDINGS.length`.
- **P3**: `readFileSync` blocks event loop per cycle.
- **P3**: User-Agent identity leak (bundled with P1 #1).

## Verdict
One P1 character-identity leak (recurring pattern), one P1 SSRF gap via phaseBrowse, one P1 prompt-injection exfil chain (final severity depends on proactive.ts audit). Multiple P2s clustered around shared-filesystem per-process-vs-per-character confusion. The file itself is otherwise well-structured — download path defense-in-depth is exemplary; the flaw is that the browse path didn't inherit those protections.
