---
file: src/agent/curiosity-offline.ts
lines: 538
purpose: Offline counterpart to curiosity.ts for characters without web access — instead of browsing, composes research requests and POSTs them to Wired Lain's `/api/interlink/research-request` endpoint. Saves question as pending, dedups, ages out.
section: 8 (agent loops)
audit-date: 2026-04-19
---

# agent/curiosity-offline.ts

## Function inventory (15)

- `startOfflineCuriosityLoop(config)` — 52: timer-only loop (no event-driven early trigger, unlike curiosity.ts).
- `runOfflineCuriosityCycle(config)` — 126: three-phase pipeline.
- `phaseInnerThought(provider, characterName)` — 178: LLM emits `{question, reason}`.
- `phaseSubmitRequest(config, thought)` — 275: saveMemory + enqueue + POST to Wired Lain.
- `phaseMovementDecision(provider, config, thoughtContext)` — 462: STAY/MOVE decision.
- `curiosityLog(context, data)` — 21.
- `getRawPendingQuestions()` / `getPendingQuestions(limit)` — 345 / 360.
- `ageOutPendingQuestions()` — 366: TTL 24h.
- `clearAnsweredQuestion(topic)` — 381: exported; loose-match clear on research-response arrival.
- `enqueuePendingQuestion(question)` — 397.
- `isDuplicateQuestion(question)` — 412: word-overlap ≥0.6 against pending list.
- `isDuplicateInList(question, list)` — 417.
- `extractKeywords(text)` — 427: stopword-filter, lowercase, length > 2.
- `wordOverlap(a, b)` — 446: intersection / min(|a|, |b|).

---

## Overall stance compared to curiosity.ts

**Good:** Identity is properly parameterized via `characterName`/`characterId` through the config (lines 220, 317, 489). This file avoids the character-identity-leak P1 that curiosity.ts has.

**Weaker:** Dedup uses word-overlap ≥0.6 against a stopword-filtered bag of tokens; misses paraphrases but catches near-duplicates. Reasonable tradeoff.

---

## Findings

### 1. replyTo URL hardcodes localhost + PORT fallback collides with McKenna (P2)

Line 319: `replyTo: \`http://localhost:${port}\`` where `port = process.env['PORT'] || '3003'`.

**Problem (same as character-tools.ts):** When `PORT` env is unset, the replyTo defaults to `http://localhost:3003`. On the droplet, 3003 is McKenna's port per the deployment. A character running this loop without PORT set asks Wired Lain to reply to McKenna.

**Systemd unit files should set PORT for each character**; but there's no assertion in this file, and `'3003'` string being hardcoded here is a second copy of the magic number (already noted in character-tools.ts audit).

**Gap:** Should fail-closed if PORT is unset, or take the port from the config struct that already threads through characterId/etc.

### 2. Shared cwd-relative debug log file (P2 — bundled pattern)

Line 19: `CURIOSITY_LOG_FILE = join(process.cwd(), 'logs', 'curiosity-offline-debug.log')`. Same shared-filesystem pattern as curiosity.ts / tools.ts. Partially mitigated by logging `character: config.characterId` per entry, but the file itself interleaves across characters with no rotation or cap.

### 3. Memory-derived prompt replay persists injection (P2, same as curiosity.ts)

Lines 184–191 (visitor messages) and 197–206 (searchMemories). Any prompt-injection from past conversations flows directly into the inner-thought prompt; subsequent `saveMemory` at line 282 persists the derived question into memory, where it resurfaces on the next cycle.

### 4. `setCurrentLocation(targetId, reason)` implicitly relies on eventBus.characterId (P2)

Line 533: call is argless-character — no `characterId` passed. Internally `setCurrentLocation` at `src/commune/location.ts:52` reads `eventBus.characterId` for event emission and `getCurrentLocation()` inside uses `eventBus.characterId` via the same implicit-default. Confirmed by reading location.ts.

**Works today** because each character process sets `eventBus.characterId` at init.

**Risk:** if any caller forgets to initialize `eventBus.characterId`, location writes attribute to `'unknown'` actor (location.ts:83), persist to the correct DB (since DB is per-character), but event-bus payload identifies as "unknown". This is fragile and hard-to-diagnose: a character's movement would seem correct from their own DB but would emit events with the wrong actor label. Flag as an architectural fragility — move to explicit characterId threading.

**Contrast:** line 473 correctly passes `config.characterId` to `getCurrentLocation` — but that only affects the default-fallback branch (DEFAULT_LOCATIONS lookup), not the actual persisted read. So the characterId argument is almost always cosmetic, which is itself confusing.

### 5. `clearAnsweredQuestion` is loose — over-clears (P2)

Line 381–395: filters pending-questions where wordOverlap < 0.5 with the answered topic. Any research response that shares 50% of its topic keywords with a pending question clears that question even if unrelated. Conservative — errs on the side of forgetting questions.

**Chain risk:** Because `getPendingQuestions(5)` feeds the inner-thought prompt at line 214 ("do NOT repeat"), over-clearing loses the "avoid" context and the character can re-ask a question Wired Lain already answered. Not a correctness bug, just drift.

### 6. `isDuplicateQuestion` stopword list is English-only and hand-curated (P3)

Lines 428–437. Character names, domain-specific jargon (consciousness, hyperreal, derridean, etc.) are not in stopwords but also not discriminating tokens — they survive and drive overlap, which is actually the right behavior. But stopwords like "does" appear twice (lines 429 and 437 — `'does'` is listed in both the modal-verb group and again explicitly). Bug: duplicate, harmless.

### 7. Migration-path sets aged-questions to 23h old (P3)

Lines 351–353: string[] → PendingQuestion[] migration synthesizes `submittedAt: Date.now() - QUESTION_TTL_MS + 60*60*1000`, i.e. 23 hours ago. `ageOutPendingQuestions` (line 366) will drop these after 1 more hour. Minor but intentional — clears legacy-format stale data quickly.

### 8. Movement prompt hardcodes "9 buildings" (P3, bundled with curiosity.ts #9)

Line 489: `You live in a small commune town with 9 buildings.` Same drift risk as in curiosity.ts — should use `BUILDINGS.length`.

### 9. No event-driven early trigger (P3, design gap)

Unlike curiosity.ts which listens on eventBus for conversation-end and intellectual-arousal spikes, this loop is timer-only (line 97). A character like McKenna might have a conversation that spikes their curiosity and still wait 2-3h for the next cycle. Asymmetry between online/offline path.

### 10. Dynamic-import silent catches (P2-bundled)

Lines 470–471 (location + buildings), 535–537 (top-level catch). Same pattern as other agent-loop files.

---

## Non-issues / good choices

- `interlinkToken` **is** used via config (line 312) — does NOT repeat the `process.env['LAIN_INTERLINK_TOKEN']` dance found in character-tools.ts.
- `characterName` / `characterId` threaded through prompts correctly — no Lain-identity leak here.
- Dedup via word-overlap (stopword-filtered) better than curiosity.ts's loose `includes` substring match.
- Pending-questions TTL of 24h (line 338) prevents permanent blocklist of long-settled topics.
- Migration path from old string[] format handled (line 351).
- Per-character DB isolates pending-question queue properly.
- `AbortSignal.timeout(30000)` on the outbound research-request POST — good, no hung connections.

---

## Findings to lift to findings.md

- **P2**: `replyTo` URL hardcodes `http://localhost:${PORT||3003}` — PORT-unset defaults to McKenna's port. Third instance of this pattern (also in character-tools.ts research_request, also in … count for bundle).
- **P2**: `setCurrentLocation` called without characterId — implicit `eventBus.characterId` dependency. Fragile; fix by threading characterId explicitly through location API.
- **P2**: `clearAnsweredQuestion` over-clears pending questions on 50% keyword overlap.
- **P2**: Shared cwd-relative `logs/curiosity-offline-debug.log` — same P2 as other loops (bundle).
- **P2**: Memory-derived prompt replay carries prompt-injection across cycles — same as curiosity.ts (bundle).
- **P2**: Dynamic-import silent catches on location/buildings/internal-state (bundle).
- **P3**: Duplicate `'does'` in stopword list (harmless).
- **P3**: No event-driven early-trigger — online/offline asymmetry.
- **P3**: Movement prompt hardcodes "9 buildings" (bundle with curiosity.ts).

## Verdict
Cleaner file than curiosity.ts — identity is parameterized correctly, network calls have timeouts, tokens come from config not env. The remaining issues cluster around (a) localhost+PORT-default drift, (b) eventBus-implicit-characterId fragility in location calls, and (c) bundled patterns shared with curiosity.ts. No new P1s introduced.
