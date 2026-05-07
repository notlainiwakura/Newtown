---
file: src/agent/narratives.ts
lines: 386
purpose: Weekly + monthly narrative synthesis. Every 6h, checks meta timestamps; after 7d/30d, synthesizes 2-4 sentence first-person arcs from diary entries, important memories, and previous narratives. Stores in meta (narrative:weekly:current/previous, narrative:monthly:current/previous) and as `summary` memories.
section: 8 (agent loops)
audit-date: 2026-04-19
---

# agent/narratives.ts

## Function inventory (6)
- `loadJournal()` — 38.
- `getWeeklyNarrative()` — 51: exported; sync getMeta.
- `getMonthlyNarrative()` — 62: exported; sync getMeta.
- `startNarrativeLoop(config)` — 75: exported; 6h cadence checker.
- `runWeeklySynthesis()` — 176: exported.
- `runMonthlySynthesis()` — 278: exported.

## Findings

### 1. `JOURNAL_PATH` via `getBasePath()` (positive, line 30)

Correct per-character isolation. Contrasts with doctor.ts hardcoding `LAIN_CHARACTER_ID === 'dr-claude'` path logic. Each character synthesizes from their own journal — no cross-character leakage.

### 2. `LAIN_CHARACTER_NAME || 'Lain'` fail-open identity default (P2 — bundle)

Lines 226, 340. If env is unset/stripped (e.g., systemd unit missing it, or start.sh not setting it), every character writes narratives claiming to be "Lain". This is the same fail-open-to-Lain pattern found across the codebase.

**Chain**: env unset → character synthesizes as "Lain" → stores narrative in own meta → narrative surfaces to own context (via `getWeeklyNarrative()`) → LLM sees "You are Lain, writing…" even though the DB is, say, Wired Lain's.

Identity corruption is a silent failure class. Per MEMORY.md: character integrity is sacred.

### 3. Full SOUL.md splatted into prompt (P2 — bundle)

Lines 227, 341: `const soulContext = getAgent('default')?.persona?.soul || '';`. Entire SOUL.md content injected into synthesis prompt. If SOUL.md is ever LLM-generated or user-editable (e.g., self-concept evolution writes back into persona), adversarial content flows here.

Current state: SOUL.md is file-system-only and read at agent init — not LLM-mutated. Low risk today. But flag: the pathway to a compromised SOUL.md is short (evolution.ts rewrites it? curiosity saves to it?) and the narrative prompt amplifies it.

### 4. Previous narrative fed into new synthesis — drift-lock risk (P2 — bundle with self-concept.ts)

Lines 234, 348. `previousNarrative` included in prompt. Classic drift-lock: last-week's summary biases this-week's summary, which biases next-week's. Over time the narrative converges to a stable-but-possibly-false attractor state. If one synthesis drifts off-course, subsequent syntheses anchor to that drift.

**Mitigation today**: diary entries and memories are also included, providing fresh signal. But prompt structure puts narrative near the end — recency bias in LLM favors the drift-locked text.

### 5. Diary entries and memories truncated mid-sentence (P3)

Lines 207, 217, 298, 330. `.slice(0, 300) + '...'`, `.slice(0, 200) + '...'`, `.slice(0, 150) + '...'`. Hard character cuts. Not wrong, but narrative quality depends on coherent input chunks.

### 6. `searchMemories` catch-silence then filter by `createdAt` (P3)

Lines 202-212, 325-335. If embedding search fails (DB issue, provider down), narrative runs with diary-only context. Silent degradation — logs nothing. Consistent with project pattern but worth noting for observability.

### 7. Monthly synthesis pulls current+previous weekly narratives (positive, line 305-313)

Good hierarchical structure: weekly → monthly. Makes monthly arc more coherent.

### 8. `CHECK_INTERVAL_MS = 6h` fires both weekly + monthly checks same timer (positive, line 28)

Single timer, two threshold checks. No jitter on the 6h cadence itself — all characters with this loop will check at the same offsets from their startup time. Not a concern (LLM call per character is infrequent) but uniform.

### 9. `getInitialDelay` uses `Math.min(weeklyElapsed, monthlyElapsed)` to compute first delay (P3)

Line 106. Computes whichever is closer-to-due, waits remainder. If weekly is at 6d23h and monthly at 29d23h, delay is based on monthly elapsed (closer to check window). Works but subtle.

### 10. `result.content.trim().length < 20` rejects short narratives but doesn't retry (P3)

Lines 244-247, 358-361. Narrative skipped if too short; `last_synthesis_at` NOT updated. Next 6h check will try again. Healthy retry pattern, but a persistent failure (LLM always returning short text for this prompt shape) would hammer the provider every 6h without backoff.

### 11. `setMeta('narrative:weekly:previous', ...)` then immediately overwrites `current` (positive, line 250-255)

Archives before overwriting. Good atomic-ish pattern — no losing of previous narrative.

Note: two-write sequence is not atomic. If process crashes between line 251 and 255, `previous` holds the old narrative but `current` still holds the old narrative (no new synthesis committed). Next synthesis will try again. Acceptable.

### 12. `getAgent('default')` — default agent assumption (P3)

Line 227, 341. Assumes `'default'` agent exists. If multi-agent per character ever introduced, this hardcodes the wrong agent. Consistent with codebase pattern.

## Non-issues / good choices
- Per-character isolation via `getBasePath()`.
- Hierarchical synthesis (weekly feeds monthly).
- Previous narrative archival before overwrite.
- Diary + memory + previous narrative as multi-signal input.
- `enabled: false` config shortcircuit.
- Clean `stopped` + `timer` cleanup pattern.
- Importance 0.6 (weekly) / 0.7 (monthly) with emotionalWeight 0.3 — reasonable.

## Findings to lift
- **P2 (bundle)**: `LAIN_CHARACTER_NAME || 'Lain'` fail-open identity default.
- **P2 (bundle)**: Drift-lock via previous narrative feedback loop.
- **P2 (bundle)**: Full SOUL.md splat into prompt — amplifier if persona is ever LLM-mutated.
- **P3**: `searchMemories` silent degradation.
- **P3**: No backoff on repeated too-short results.

## Verdict
Clean, focused synthesis loop. Uses `getBasePath()` correctly and has good archival semantics. Main concerns bundle with the codebase-wide patterns: fail-open identity defaults and drift-lock from self-feedback. The narrative storage is per-character and isolated; the risks are in prompt construction and identity resolution, not data layout.
