---
file: src/agent/self-concept.ts
lines: 359
purpose: Weekly "who am I right now" synthesis loop — combines recent diary entries, high-importance memories, curiosity discoveries, and previous self-concept into a living self-concept that is injected into the system prompt. 6h check interval, synthesis if 7+ days elapsed OR 5+ new diary entries.
section: 8 (agent loops)
audit-date: 2026-04-19
---

# agent/self-concept.ts

## Function inventory (4)
- `loadJournal()` — 45.
- `getSelfConcept()` — 59: exported, read via getMeta('self-concept:current').
- `startSelfConceptLoop(config?)` — 72.
- `runSelfConceptSynthesis()` — 186: exported.

## Findings

### 1. Self-concept is the deepest prompt-injection persistence vector in the codebase (P1)

**Chain:**
- Injected content enters via any LLM-facing surface (user message, tool output, browsed page, dream-seed, letter, RSS fragment).
- Persists through saveMemory.
- Surfaces in diary prompt → diary entry saved as memory + journal file.
- Surfaces in self-concept synthesis prompt (line 229, 254, 299, 303).
- Self-concept stored in meta table (`self-concept:current`, line 326).
- **`getSelfConcept()` is exported and injected into the system prompt** per file header comment: "Injected into the system prompt between SOUL.md and dynamic memory context."
- Every subsequent character response is shaped by the self-concept.

**Result**: an injection that achieves self-concept insertion persists for ~7 days minimum and affects every conversation turn during that window. Recovery requires manual wipe of the meta table.

**Not a new primitive** — requires compromising one of the earlier loops (curiosity, diary, dream, letter, etc.), all of which have weaker P1s/P2s. But this file is the amplifier: once content reaches the self-concept, it becomes silently load-bearing.

**Gap:** no sanitization, no length cap (line 315 only checks `< 50` minimum), no integrity check between writes. The self-concept flows directly from LLM output to persisted-and-used state.

### 2. Default-to-Lain identity (P2 — bundle)

Line 268: `process.env['LAIN_CHARACTER_NAME'] || 'Lain'`. Same fail-open pattern. If env drifts, Wired Lain's self-concept is composed as if she were Lain.

### 3. Full SOUL.md injected into synthesis prompt (P2 — bundle with diary.ts)

Line 298: `${soulContext ? \`YOUR PERSONALITY AND VOICE:\n${soulContext}\n\` : ''}`. Same amplification.

### 4. Non-atomic `writeFileSync` for self-concept.md (P2 — bundle with diary)

Line 334. Same partial-write risk. Less severe than diary since meta-table is source of truth (per comment line 336) — the .md file is for human inspection only. OK.

### 5. Previous self-concept becomes synthesis input (P2)

Lines 272–273: `YOUR PREVIOUS SELF-CONCEPT:\n${previousConcept}`. Injection-amplification: if a compromised self-concept escapes via prompt-injection, the next synthesis reads it in as authoritative self-understanding. Creates a drift-lock where the character cannot easily reset without external intervention.

### 6. `shouldSynthesize` reads entire journal every check (P3)

Line 128: `loadJournal()` every 6h to count entries after last synthesis. Sync parse of full journal. Should track a counter via meta instead.

### 7. Per-character isolation ok (positive)

Line 33-34: `JOURNAL_PATH` and `SELF_CONCEPT_PATH` use `getBasePath()`. Good.

### 8. Perturbation prompts fire deterministically (P3)

Line 287: `cycleCount % 3 === 2` → every 3rd cycle. Index selection `PERTURBATION_PROMPTS[cycleCount % PERTURBATION_PROMPTS.length]` is deterministic → predictable perturbation schedule. Minor.

### 9. `entriesSinceLast` filter uses `>` strict — boundary case drops entries written at exact timestamp (P3)

Line 133. Astronomically unlikely to matter.

### 10. No validation that synthesized text is actually about "who I am" (P3)

Line 315: only length gate. If the LLM goes off-rails and produces unrelated text, it becomes the self-concept. The prompt is specific but LLM behavior is non-deterministic.

## Findings to lift
- **P1**: Self-concept is the deepest prompt-injection persistence vector — injected content propagates into every subsequent system prompt for 7+ days. Chain amplifier; final severity depends on sanitation at upstream ingestion points.
- **P2**: Default-to-Lain identity (bundle).
- **P2**: Full SOUL.md injected into synthesis prompt (bundle).
- **P2**: Non-atomic `writeFileSync` for self-concept.md (bundle, lower severity since meta-table is source of truth).
- **P2**: Previous self-concept flows into new synthesis — drift-lock risk on compromised concepts.
- **P3**: `shouldSynthesize` re-parses full journal on every 6h check.
- **P3**: Perturbation prompt deterministic by cycle count (minor).

## Verdict
The quietest file in this audit so far and simultaneously the most dangerous amplifier. The self-concept is the persisted first-person authoritative voice of the character; any upstream injection that reaches it becomes the character's literal inner voice. Defense must live at ingestion (sanitize what flows into memory/diary), not here — but worth calling out so anyone reading the by-file map sees the chain endpoint.
