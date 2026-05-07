---
file: src/agent/diary.ts
lines: 463
purpose: Daily journal loop — writes a diary entry around 22:00 local time using LLM reflection on the day's messages, memories, discoveries, objects, and preoccupations. Persists to `.private_journal/thoughts.json` under the character's base path. Also records to memory system.
section: 8 (agent loops)
audit-date: 2026-04-19
---

# agent/diary.ts

## Function inventory (10)

- `startDiaryLoop(config?)` — 157: timer + 22:00 target scheduling + event-bus early trigger.
- `runDiaryCycle()` — 277: gather context → LLM → append to journal file → save to memory.
- `findClosestEntry(entries, targetTime, excludeIndices)` — 46: used by sampling.
- `sampleJournalEntries(entries)` — 71: selects last 1-2 + 7-day + 30-day + one random past.
- `loadJournal()` — 117: `readFileSync` + JSON.parse.
- `appendJournalEntry(entry)` — 130: read-modify-write whole file sync.
- `getDelayUntilTargetHour(targetHour=22)` — 140: local-time scheduling.
- `maybeRunEarly(reason)` — 239 (closure in startDiaryLoop): checks cooldown + emotional_weight > 0.7.

---

## Findings

### 1. Journal write is non-atomic — crash during write corrupts entire journal (P2)

Line 134: `writeFileSync(JOURNAL_PATH, JSON.stringify({ entries }, null, 2), 'utf-8')`.

**Problem:** this is a read-modify-write of the whole journal file. If the process is killed, disk fills, or node crashes mid-write, the file is truncated and all prior entries are lost. Character's private journal is one of the most user-visible long-term artifacts — losing it is bad.

**Contrast:** curiosity.ts `downloadDataset` uses the temp-file + rename pattern (lines 979–980 of curiosity.ts) for atomicity. That pattern should be used here too.

**Mitigation today:** crash windows are narrow (one write per ~24 hours), but the consequence is severe — entire journal history gone.

### 2. "Private journal" is plaintext on disk (P2)

Line 34: `JOURNAL_PATH = join(getBasePath(), '.private_journal', 'thoughts.json')`. Line 402: prompt tells the LLM `This is your space — no one reads this but you. Write honestly.` The LLM may produce genuinely sensitive content under that framing.

**Problem:** the file has default filesystem permissions (likely `0644` via writeFileSync default), is included in the character's home directory which may be backed up, rsync'd, or exposed via debug/diagnostic tools. The framing to the LLM is inaccurate.

**Not exploitable directly** — but worth treating as a threat-model mismatch. Either the prompt should be re-worded ("only accessible to the operator of this character"), or the file should be encrypted at rest, or permissions explicitly chmod'd to 0600.

### 3. Default-to-Lain identity drift (P2 — same class as other loops)

Line 300: `process.env['LAIN_CHARACTER_NAME'] || 'Lain'`.
Line 386: `process.env['LAIN_CHARACTER_ID'] || 'lain'` (inside objects import).

**Problem:** if either env is unset, the character process silently assumes it's "Lain". This was *specifically* the bug that broke the Lain/Wired Lain split multiple times per user's top memory file. The defaults here fail open to the wrong character.

**Better pattern:** fail closed. If LAIN_CHARACTER_NAME is unset, refuse to write a diary entry rather than writing one under the wrong name.

### 4. Full SOUL.md content injected into every diary prompt (P2)

Line 404: `${soulContext ? \`YOUR PERSONALITY AND VOICE:\n${soulContext}\n\` : ''}`. `soulContext` is the entire parsed soul text (`getAgent('default')?.persona?.soul`). SOUL.md files typically run 1-5K tokens.

**Consequences:**
- Daily cost amplification — every diary write pays tokens for the full soul.
- Context window pressure — along with messagesContext, memoriesContext, discoveriesContext, recentEntriesContext, and objectsContext, prompt can easily exceed 20K tokens before even hitting the model's normal context budget.
- Token-quality inversion — the LLM probably writes *better* diary entries without the full soul, since the voice should emerge from the accumulated context (journal sampling, preoccupations).

**Gap:** no truncation, no summary. Bundle with other loops that splat full-context prompts.

### 5. Memory-derived prompt replay — diary becomes memory becomes diary (P2, bundle)

Line 442: saves the LLM's output as a memory with importance 0.6, sessionKey 'diary:daily'. Line 319: next cycle, `searchMemories` pulls from ALL memories ('important moments and feelings today'). Past diary entries will re-appear in the next diary's memoriesContext, then again in recentEntriesContext (line 366), creating a double-recall.

Same class as the curiosity recursive-drift issue. Prompt-injection persistence vector.

### 6. `emotional_weight > 0.7` early trigger can fire frequently (P2)

Lines 244–247: any `state` event triggers early if emotional_weight > 0.7 AND elapsed > 6h cooldown.

**Problem:** if the character is in a sustained high-emotional-weight state, a single `state` event every 6h+1min triggers a full diary cycle. In the worst case, a character in a persistent 0.8-weight mood writes 4 diary entries per day. With `intervalMs` 24h and `maxJitterMs` 30min, the timer-based cycle is once a day — but the event-driven path overrides it.

**Probably intentional** (crises should cause more reflection) but worth noting the bound.

### 7. Hardcoded WIRED_LAIN_URL default `http://localhost:3000` (P3 — bundle)

Line 387. If env unset, objects context defaults to assuming Wired Lain is on port 3000 localhost. Same pattern already logged.

### 8. `getAgent('default')?.persona?.soul` lazy-load dependency (P3)

Line 301: optional chain to persona.soul. If agent registry hasn't finished loading by the first diary cycle, soul is empty and a soul-less diary is written. Silent. At least the soul-less-prompt produces a reasonable entry, but character-voice drift happens.

### 9. `loadJournal` synchronous read + full-file parse each time (P3)

Line 119: `readFileSync` + `JSON.parse`. Called from `sampleJournalEntries` in `runDiaryCycle` and from `appendJournalEntry`. For long-running characters with multi-year journals the parse grows linearly. Not urgent but diary files are expected to live indefinitely.

### 10. 22:00 scheduling uses server local time (P3)

Line 140: `target.setHours(22, 0, 0, 0)`. On a UTC-configured server (which most Linux/droplet setups default to), 22:00 UTC is 6pm EDT / 10pm UTC / 5am JST. For Lain-character whose persona is Japanese-adjacent, the "end of day" concept is off. Cosmetic.

### 11. `findClosestEntry` ignores entries beyond 4-day tolerance (P3)

Line 61: 4-day window around 7-day and 30-day anchors. If the character skipped diary for 5+ days, the 7-day-ago slot is empty, potentially skewing the sampling distribution. Not a bug, but worth noting.

### 12. `appendJournalEntry` uses mkdirSync every write (P3)

Line 133: re-runs `mkdirSync(..., { recursive: true })` on every entry. Idempotent but wasteful. Cosmetic.

---

## Non-issues / good choices

- `JOURNAL_PATH` uses `getBasePath()` — properly per-character isolated. No shared-filesystem issue like cwd-relative logs have.
- `eventBus.emit` and `eventBus.on` subscription is straightforward and single-listener per loop. Cleanup function properly clears timer.
- Cooldown of 6h on early-trigger path prevents event storms.
- `findClosestEntry` + `sampleJournalEntries` is a thoughtful journal-continuity strategy.
- Minimum entry length gate (line 423: `< 20` chars) prevents empty/malformed entries from being saved.
- Parameterized characterName + soul (when present) produces character-appropriate diaries, not Lain-only like curiosity.ts.

---

## Findings to lift to findings.md

- **P2**: Non-atomic journal write (`writeFileSync`) — crash corrupts entire journal. Use temp+rename.
- **P2**: "Private journal" framing lies — plaintext JSON on disk, default filesystem permissions. Either encrypt, chmod 0600, or stop calling it "private" in the prompt.
- **P2**: `LAIN_CHARACTER_NAME` / `LAIN_CHARACTER_ID` default to Lain's identity if unset — fail-open to wrong character. Pattern implicated in user's past identity-corruption incidents.
- **P2**: Full SOUL.md injected into every diary prompt — unbounded cost + context inflation.
- **P2**: Memory-derived prompt replay across cycles (diary→memory→diary) amplifies any injection persistently.
- **P2**: Event-driven early trigger can write 4+ diaries/day during high emotional_weight sustained states.
- **P3**: Default `WIRED_LAIN_URL = http://localhost:3000` (bundle).
- **P3**: `getAgent('default')?.persona?.soul` optional-chain silently drops soul if agent not ready.
- **P3**: `loadJournal` full-file parse grows linearly.
- **P3**: 22:00 uses server local time, meaningless on UTC droplets.
- **P3**: `findClosestEntry` 4-day tolerance may leave 7-day/30-day slots empty with no fallback.

## Verdict
Mostly well-structured — identity parameterization, per-character isolation via `getBasePath()`, and early-trigger gating are all correct patterns. Main concerns are (a) non-atomic write risks losing the journal, (b) the "private" framing misleads the LLM given plaintext persistence, and (c) the same fail-open-to-Lain default pattern seen elsewhere. No P1s, multiple P2s.
