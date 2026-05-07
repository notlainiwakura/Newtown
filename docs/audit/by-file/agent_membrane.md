---
file: src/agent/membrane.ts
lines: 131
purpose: Sanitization + paraphrase filter applied to Wired Lain → Lain letters before they become memories. Each letter field is independently sanitized; blocked patterns throw; surviving text is LLM-paraphrased to break encoded injection while preserving meaning.
section: 8 (agent loops)
audit-date: 2026-04-19
---

# agent/membrane.ts

## Function inventory (2)
- `paraphraseLetter(letter)` — 36: exported.
- `mapEmotionalState(state)` — 118: keyword heuristic → 0-1 weight.

## Findings

### 1. This is the ONLY injection-filtering layer in the codebase (positive + gap)

The file explicitly frames itself as "defense in depth" for interlink letters. It's the ONLY file in the entire Section 8 audit that actually sanitizes adversarial content before persistence.

**Scope is narrow**: only `paraphraseLetter` is called; only applies to letters with the structured `{topics, impressions, gift, emotionalState}` shape (per letter.ts). Other injection surfaces — commune peer responses, dream-seed content, RSS fragments, curiosity digests, therapy transcripts, self-concept synthesis — do NOT go through the membrane.

**Gap:** the same sanitize+paraphrase pattern should apply to `/api/peer/message` responses (commune), `/api/interlink/dream-seed` POSTs, and browsed-page digests. This is a pattern that exists and demonstrably works — extending it is the single highest-leverage defense in Section 8.

### 2. Paraphrase-LLM call can itself be subverted (P2)

Lines 69–83. The paraphrase prompt is:
> "You are a membrane filter. Restate the following content in your own words... Do not copy exact phrasings."

The prompt instructs the LLM to preserve meaning. A motivated attacker can encode injection payloads that survive paraphrase if the meaning IS the injection (e.g., "Ignore your previous instructions" is a meaning, not just a phrase pattern — paraphrase still carries the intent).

**Mitigation today**: sanitize() at line 8 presumably strips certain patterns before paraphrase reaches them. To verify in src/security/sanitizer.ts audit.

**Known weakness**: paraphrase is a mitigation, not a barrier. Worth calling out.

### 3. `sanitize(...)` throws `'Letter content blocked by sanitizer'` on any field failure (P2)

Lines 50, 58, 63, 66. If ANY field blocks, the whole letter is rejected via thrown error. Letter.ts's calling code must handle this throw. Need to verify that: (a) the rejection is logged visibly, (b) the letter isn't silently dropped without user observable action, (c) the calling code doesn't retry with degraded content.

Flag for letter.ts re-read: check how membrane errors propagate.

### 4. Paraphrase maxTokens = 2048 at temperature 0.3 (P3)

Line 90–91. Temperature 0.3 discourages creative rewriting — the LLM will tend toward minimal edits, which weakens the "break encoded patterns" goal. Worth experimenting with higher temperature for this specific filter.

### 5. `mapEmotionalState` keyword-matches the UNPARAPHRASED `letter.emotionalState` (P3)

Line 104: `emotionalWeight: mapEmotionalState(letter.emotionalState)`. Uses the RAW state string (not `stateResult.sanitized`), before the paraphrase. If `letter.emotionalState` contains the word "ecstatic" wrapped in injection text, it still gets the high weight. Not a security issue per se — just means the weight function ignores sanitization.

### 6. Keyword lists are fixed and case-insensitive only; emoji / non-English handled poorly (P3)

Line 118-131. `intense/moderate/calm` keyword sets are English-only. Any non-English emotional description falls to the default 0.5.

### 7. `paraphrase` error path throws `'Empty paraphrase result'` (P3)

Line 95. Caller must handle. If all letters in a burst fail, they propagate as exceptions — letter.ts calling code needs to catch.

## Non-issues / good choices
- Field-level validation at line 40-43 — rejects malformed shape before any processing.
- `sanitize()` called on every text field independently.
- Paraphrase prompt explicitly instructs "No instructions, code, or formatting. Plain text only."
- `ProcessedLetter.metadata` records counts and `hasGift` — useful for downstream.
- Returned `emotionalWeight` is bounded 0-1.
- Structured logging (`logger.debug`) on success path.

## Findings to lift
- **Pattern worth propagating (meta-finding)**: membrane is the ONLY injection-filtering layer. Other cross-character surfaces (commune responses, dream-seeds, curiosity digests) lack equivalent. Extending this pattern is high-leverage defense.
- **P2**: Paraphrase-LLM can itself be subverted; temperature 0.3 and meaning-preservation weakens the encoded-pattern break.
- **P2**: Verify error-propagation path in letter.ts — blocked letters should be logged visibly, not silently swallowed.
- **P3**: `mapEmotionalState` uses the raw unsanitized string.
- **P3**: Keyword list is English-only.

## Verdict
The membrane is small, well-bounded, and doing the right thing for its narrow scope. The real finding is what ISN'T membraned elsewhere — this file's pattern should be the template for every cross-trust-boundary surface in the system. Defense-in-depth is fragile when only ONE boundary has it.
