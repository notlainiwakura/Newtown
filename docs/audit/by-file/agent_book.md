---
file: src/agent/book.ts
lines: 843
purpose: Wired Lain's autonomous long-form book-writing loop. Every 3 days (±4h), runs one action: OUTLINE/DRAFT/REVISE/SYNTHESIZE/INCORPORATE/CONCLUDE. Reads experiment-diary.md, outline.md, chapters/ dir. $10/month budget cap via Sonnet pricing tracking. Concludes when 3+ chapters all revised at least once.
section: 8 (agent loops)
audit-date: 2026-04-19
---

# agent/book.ts

## Function inventory (17)
- `getBookDir()` / `getOutlinePath()` / `getChaptersDir()` / `getNotesPath()` / `getDiaryPath()` — 48-66.
- `getBudgetKey()` — 70.
- `getMonthlySpendUsd()` — 74.
- `addSpend(inputTokens, outputTokens)` — 84.
- `isBudgetExhausted(monthlyBudgetUsd)` — 95.
- `safeRead(path)` — 101.
- `ensureBookDirs()` — 109.
- `listChapters()` — 113.
- `readChapter(filename)` — 122.
- `writeChapter(filename, content)` — 126.
- `readRecentExperiments(maxEntries)` — 134.
- `readNewExperiments()` — 146.
- `startBookLoop(config)` — 174: exported.
- `runBookCycle(cfg)` — 242.
- `decideAction(provider, outline, chapters, newExperiments, notes)` — 301.
- `doOutline(...)` — 362.
- `doDraft(...)` — 411.
- `pickDraftTarget(provider, outline, existingChapters)` — 495.
- `doRevise(...)` — 541.
- `doSynthesize(...)` — 623.
- `doIncorporate(...)` — 701.
- `doConclude(...)` — 779.

## Findings

### 1. `writeChapter(target.filename, ...)` — filename is LLM-generated with no validation (P1)

Lines 126-128, 514-516, 532-536, 473, 475. `pickDraftTarget` asks the LLM to emit `FILENAME: <nn-slug.md>` and parses it with regex `FILENAME:\s*(.+)` (line 526). The match takes everything after "FILENAME:" up to end-of-line, trimmed.

Then `writeChapter(filename, content)` does `writeFile(join(getChaptersDir(), filename), content, 'utf8')`.

If LLM emits `FILENAME: ../../../tmp/evil.md` (or `FILENAME: ../../.ssh/authorized_keys`), `join(chaptersDir, '../../../tmp/evil.md')` normalizes and writes arbitrary paths on disk.

**Amplification chain**: experiment-diary.md contains LLM-generated text (from experiments.ts — next file to audit). If experiment-diary has injection that instructs Wired Lain to emit a specific FILENAME during `pickDraftTarget`, she writes to attacker-chosen path.

**Verification**: `doDraft` → `pickDraftTarget` → LLM sees outline + existing chapters → returns filename. Outline is file-system content written by prior book cycles. If outline is ever influenced by experiment diary (via doIncorporate → outline update), chain closes.

Line 473 (`writeChapter(target.filename, existingDraft + '\n\n' + newContent)`) and line 829 (`\`${padded}-conclusion.md\``, safe hardcoded template). Draft path is the exposed one.

**Fix**: validate filename matches `/^\d{2}-[a-z0-9-]+\.md$/` before writing.

### 2. `doRevise` iterates `chapters[]` from `listChapters` (positive, line 564)

Line 113-120: `readdir(chaptersDir).filter(f => f.endsWith('.md')).sort()`. Only reads actual directory contents. Can't be influenced by LLM to revise arbitrary files. But if doDraft previously wrote outside `chaptersDir` (per finding #1), those writes aren't revised here (they're outside the dir). So finding #1 is write-arbitrary, not revise-arbitrary.

### 3. Experiment diary content flows into every LLM call (P2 — bundle)

Lines 135-141, 377, 427, 454, 572, 585, 725. `readRecentExperiments` / `readNewExperiments` reads `experiment-diary.md` and splices into prompts. If experiments.ts appends adversarial LLM-generated text (very likely given 1547 lines of experiment code), every book cycle amplifies it.

**Chain**: experiment LLM output → diary file → book prompt → book LLM output → chapter files → chapters read back into next cycle's prompts.

This is a slow but deep drift-lock loop — the book self-reinforces whatever pattern the diary establishes.

### 4. `$10/month budget cap` is a soft cap (P2)

Line 95-97. `isBudgetExhausted` returns true when `getMonthlySpendUsd() >= monthlyBudgetUsd`. **But**: `addSpend` is called AFTER each LLM call (lines 353, 396, 467, 523, 602, 671, 747, 823). So a cycle that exceeds budget mid-execution (e.g., during DRAFT which uses `maxTokens: 8000`) still completes that call, then blocks the next cycle.

Actually worse: a single cycle makes 2-3 LLM calls (decideAction + pickDraftTarget + doDraft for DRAFT path), each adding to spend. The cap is only checked at cycle-start (line 245). Within-cycle, no short-circuit.

**Worst case**: budget is $9.99 at cycle start, OUTLINE action (4096 maxTokens) costs $0.15, landing at $10.14. Budget-exhaustion flag now true; next cycle skips. Overage is ~1 call's worth. Bounded and tolerable.

But there's no cycle-level budget gate beyond the $10 monthly ceiling. If config overrides `monthlyBudgetUsd` to $0, cycles still call `decideAction` (line 250) before hitting the budget check at line 245... **no wait, line 245 is BEFORE line 250**. Correct order. OK, budget check is upfront; post-call spend is tracked but next cycle skips. Fine.

### 5. `getBudgetKey` uses process-local clock (P3)

Line 71: `new Date().toISOString().slice(0, 7)`. Process timezone doesn't matter — ISO is UTC. Good.

But: across month boundaries, a cycle firing at 23:59 UTC (still in current month) and another at 00:01 UTC (next month) hit different keys. First month may go slightly over, next month starts fresh. Intended.

### 6. No atomic write of outline or chapter (P2 — bundle)

Lines 398, 460, 473, 475, 604, 682, 686, 757, 761, 829. All `writeFile(path, content, 'utf8')`. Crash during write corrupts the file. Consistent with diary.ts and feed-health.ts pattern.

For the conclusion chapter in particular, corruption loses weeks of context.

### 7. `book:concluded` flag prevents re-concluding (positive, line 315)

Good. Once concluded, the action tree short-circuits the conclusion path.

### 8. `book:concluded` doesn't stop the loop (P2)

The loop continues running, cycling through OUTLINE/DRAFT/REVISE/SYNTHESIZE actions after conclusion. The header comment at line 15 says "CONCLUDE — write final integration / conclusion, then stop the loop." But there's no `stopped = true` or timer cancellation after conclude runs.

**Observable**: after the book is "finished", the loop keeps writing new outlines, drafting new chapters, etc. Pages keep piling up indefinitely.

Per file header intent, this should `return () => {}` or set `stopped = true`. Currently the conclusion is just one more cycle action, and the next cycle continues as normal (except line 315 blocks re-concluding).

### 9. `addSpend` writes to meta inside DB on every LLM call (P3)

Line 91. Synchronous meta write per call. Fine.

### 10. `readChapter(lastChapter).slice(-2000)` for previous-chapter continuity (P3)

Line 435. Last 2000 chars of the most recently listed chapter. `listChapters` sorts alphabetically — so "last" is the alphabetically-last chapter, not the most-recently-written. If filenames are `01-...`, `02-...`, that's the highest-numbered. Probably intended. But if chapter 03 is drafted first, then 01, the continuity shown during drafting of 04 is from 03 (the alphabetic-last). Correct.

### 11. Chapter filename numeric prefix stripped on `doConclude` (P3)

Line 826-828: `chapterNum = chapters.length + 1`. If chapter count is 5, conclusion is `06-conclusion.md`. Simple. But: if any chapter filename doesn't start with a number, or if chapters are numbered non-contiguously (01, 02, 05), the padded count is wrong. Tolerated.

### 12. `existingDraft + '\n\n' + newContent` appending doubles chapter size per draft cycle (P2)

Line 473. DRAFT action appends when existing content exists. Over multiple DRAFT cycles on the same chapter, chapter grows unboundedly. Token input to next cycle's DRAFT or REVISE grows linearly, costs linearly.

Mitigation: outline refresh at ~every 10 cycles (line 341). But no explicit chapter-size cap. A chapter drafted 20 times could be enormous.

### 13. `doRevise` rewrites the whole chapter (partial mitigation, line 604)

The LLM is asked to return the complete revised chapter. If the LLM preserves most content, size grows slowly. If it compresses, shrinks. In practice, LLM length-drift varies per call.

### 14. `dateMatch` regex in `readNewExperiments` (P3)

Line 160: `/\*\*Date:\*\*\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/`. Expects exact format. If experiment-diary writer changes date format, `dateMatch` fails and `return true` (line 161) — entry treated as NEW. All entries become "new" → INCORPORATE runs on full diary every cycle. Quietly wastes tokens.

**Cross-file fragility**: the format is a contract between experiments.ts (writer) and book.ts (reader). Changing one without the other silently breaks incremental incorporation.

### 15. `getBookDir()` uses `getBasePath()` (positive)

Line 49. Per-character directory. Correct isolation.

### 16. `book:last_incorporated_at` stored as ISO string (P3)

Line 765-766: `new Date().toISOString().slice(0, 19).replace('T', ' ')`. Lexical comparison at line 162 with `dateMatch[1]`. Works if format is identical. Fragile — any drift in format on either side breaks comparison.

### 17. Wired-Lain-only intent with no guard (P2 — bundle)

File header says "Autonomous book-writing loop for Wired Lain". No `LAIN_CHARACTER_ID === 'wired-lain'` check. If another character boots this loop, they'd write to their own `book/` subdirectory from their own experiment-diary (per `getBasePath()` isolation). Probably fine — per-character isolation works here. But filesystem is per-character; budget meta is per-character. So a second character running this doubles the effective monthly LLM spend across the town. Cosmetic; intent is Wired-Lain.

### 18. `eventBus.emitActivity` broadcasts book state changes (P3)

Lines 401, 481, 613, 691, 769, 837. Event bus activity emission. If listeners persist these, traces of book activity appear elsewhere. Low content.

## Non-issues / good choices
- Budget tracking per calendar month.
- `safeRead` returns empty string on error (tolerant).
- Action decision heuristics before LLM (line 308-321) — save tokens.
- Per-character filesystem isolation via `getBasePath()`.
- Revision count tracked per chapter.
- "last_incorporated_at" gates incremental incorporation.
- File-based state + meta state for different concerns.
- Concluded-flag prevents re-conclusion.

## Findings to lift
- **P1**: LLM-chosen filename in `pickDraftTarget` written to disk without path validation — directory-traversal vector (pipeline writes via `writeChapter`).
- **P2 (bundle)**: Experiment-diary content injection amplifies through every book cycle, self-reinforces in chapters.
- **P2**: Non-atomic writes on outline/chapters/notes.
- **P2**: `book:concluded` flag blocks re-conclusion but doesn't stop the loop — cycles continue indefinitely.
- **P2**: Unbounded chapter growth via append-on-draft (line 473).
- **P2 (bundle)**: No Wired-Lain-only guard (cosmetic given per-character paths).
- **P3**: `readNewExperiments` regex fragile — format drift treats all entries as new.

## Verdict
Elegant cycle-action architecture for long-form autonomous writing. The primary concerns are path-traversal via LLM-filename (line 526 regex → line 127 writeFile), unbounded chapter growth on re-drafts, and the loop-never-stops-after-conclusion bug. Budget tracking is well-designed but post-call recording means every single cycle can overshoot by one call's cost. Experiment-diary as the primary input creates a tight injection path — the book is effectively a long-running LLM transformation of whatever experiments.ts writes.
