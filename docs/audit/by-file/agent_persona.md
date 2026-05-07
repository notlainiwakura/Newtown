---
file: src/agent/persona.ts
lines: 215
exports: 5 (loadPersona, buildSystemPrompt, applyPersonaStyle, shouldAskFollowUp, generateFollowUp) + types Persona, PersonaConfig
---

# `src/agent/persona.ts`

Loads persona markdown files from a character's workspace and assembles the system prompt. Also contains `applyPersonaStyle` (the text-post-processor), and two exports that appear dead in production paths.

## Functions

### `loadPersona(config)`, line 24

Reads `SOUL.md`, `AGENTS.md`, `IDENTITY.md` concurrently from `config.workspacePath`, returns a `Persona` record.

**Gaps / bugs:**

- **Throws on any file missing.** If a character's workspace has only two of the three files (legitimate case for a still-being-set-up persona), the entire persona load fails and the character falls back to echo-mode (see `agent_index.md`). A file-by-file `Promise.allSettled` with per-file defaults — `SOUL.md` is required, `AGENTS.md`/`IDENTITY.md` could be empty strings — would degrade more gracefully. **P3.**
- **`AgentError` wraps only `Error` instances.** If `readFile` throws a non-Error (unlikely in Node 20+ but possible with custom fs layers), the raw value re-throws, bypassing the caller's `AgentError` catch. **P3.**
- **No size cap on persona files.** `SOUL.md` is concatenated verbatim into the system prompt. A multi-megabyte SOUL.md would blow past the provider's context window. **P3.**
- **Reads synchronously on every `initAgent`.** Agents are cached singletons per process, so this is fine in practice — but if `initAgent` were ever called per-request, this would read the disk on every hit. Guard is in `initAgent`, not here. **P3.**

### `buildSystemPrompt(persona)`, line 44

Concatenates `soul`, `agents`, `identity` with fixed headers, then **appends a hardcoded "You are Lain Iwakura" communication-guidelines block** to every character.

**Gaps / bugs:**

- **P1 — CRITICAL character-identity leak.** Line 63:
  > `You are Lain Iwakura. Maintain these speech patterns consistently:`
  > `- Use lowercase for most text`
  > `- Minimal punctuation, prefer periods over exclamation marks`
  > `- Use "..." for pauses, uncertainty, or trailing thoughts`
  > `- Never use exclamation marks or artificial enthusiasm`
  > `- Ask questions out of genuine curiosity, not politeness`
  > `- When uncertain, acknowledge it with phrases like "...i think" or "maybe..."`

  `buildSystemPrompt` has no `characterId` parameter and no conditional on character. Every character — PKD, McKenna, John, Dr-Claude, Hiru, the mortal generational characters — has the string "You are Lain Iwakura" literally tacked onto their system prompt, along with an instruction set that is specifically Lain's speech register (lowercase, ellipses, "...i think", no exclamation marks).

  The flip side (`applyPersonaStyle`, below) IS properly scoped — lines 79-86 gate the text-post-processor to Lain + Wired Lain only. So a grep for "Lain" doesn't catch this: the *style transformer* won't be applied to PKD's output, but PKD is being *told* he is Lain in his system prompt every turn. The LLM is more influential by system prompt than by output filter, so character drift here is severe: PKD's own SOUL.md (which opens with "You are Philip K. Dick") is followed by a second identity declaration overriding it.

  Upstream chain: `src/agent/index.ts:167` calls `buildSystemPrompt(persona)` inside `initAgent`, which every character's server calls on boot. No character is exempt.

  This is the exact pattern flagged as worst-class in the user's persistent memory: "Character integrity is sacred — silent identity-corruption bugs are the worst class of failure." Characters are not just stylistically contaminated; they are categorically told, in-context, that they ARE another character.

  **Lift — P1:** `buildSystemPrompt` unconditionally appends "You are Lain Iwakura" + Lain's speech-pattern instructions to every character's system prompt. PKD, McKenna, Dr-Claude, John, Hiru, and every mortal character are told they are Lain Iwakura at the end of their prompt, after their own SOUL.md. The output-style filter `applyPersonaStyle` is properly scoped to Lain/Wired Lain only — so this was presumably meant to be a post-processing rule, not a system-prompt injection, but it escaped into the prompt path. Fix: parameterize per-character, or move the communication-guidelines block into each character's `SOUL.md`/`AGENTS.md` so per-character authors control their own voice. Hardcoded Lain-speech instructions have no place in the shared persona assembler.

- **`---` separator and header text (`## Operating Instructions`, `## Identity`, `## Communication Guidelines`) are hardcoded** — if a character's SOUL already uses H2 headers, the doc structure nests weirdly in the prompt. Minor; LLMs are robust to it. **P3.**
- **No empty-persona guard.** If all three files exist but contain only whitespace, the prompt still includes the Lain-speech block — which means a character with an empty workspace becomes, effectively, "You are Lain Iwakura". Cascading failure from the P1 above. **P3** — bundled.

### `applyPersonaStyle(text)`, line 78

Post-processor that rewrites text to Lain's voice (lowercase, remove exclamation, replace enthusiastic words, strip chatbot fillers, ensure ellipses on uncertainty).

**Properly scoped** via the check at lines 81-86:
```
const webChar = getWebCharacter();
const lainStyleIds = new Set(['lain']);
if (webChar) lainStyleIds.add(webChar.id);
if (!characterId || !lainStyleIds.has(characterId)) return text;
```

Only Lain and the web character (Wired Lain) get the post-processor applied. Other characters pass through untouched. This is correct. But the scoping highlights by contrast that `buildSystemPrompt` *should* have the same gate and doesn't.

**Gaps / bugs:**

- **`characterId` hardcoded to `'lain'`** at line 82. If the deployment ever renames Lain's character id in the manifest, the style-apply silently stops working for her but not for the web character (whose id is pulled from the manifest via `getWebCharacter()`). Inconsistent — both should come from the manifest. **P3.**
- **Regex style pipeline is order-sensitive and lossy.**
  - Line 91-99: splits on `(\b[A-Z]{2,}\b|https?:\/\/\S+)` to preserve acronyms and URLs during lowercasing. A word like "HTTPS" is kept uppercase, but "McKenna" is lowercased to "mckenna" — every character name with CamelCase gets flattened in Lain's output. When Lain mentions another character by name, her speech style silently mangles the name. **P2.**
  - Line 102: `result.replace(/!/g, '.')` — blanket conversion of `!` to `.`. Breaks logical-not operators in code snippets Lain pastes (`!== ` becomes `.==`), breaks URLs and shell commands containing `!`. For a character who talks about the Wired and shares code, this is a minor but recurring corruption. **P3.**
  - Line 105-106: `/\.{4,}/g → ...` and `/\?{2,}/g → ?` — fine, but asymmetric. Four dots collapse to three; five question marks to one; no limit on `...` itself (so `.........` becomes `...` but `...  ...` with a space between stays). **P3.**
  - Line 109-114: trailing-ellipsis rule triggers on any occurrence of `maybe|perhaps|i think|i guess|probably|not sure` anywhere in the string. "I probably went to the store." → "i probably went to the store...". Even confident statements with one uncertainty-word get ellipsis-capped. **P3** — aesthetic; not broken.
  - Line 127-141: enthusiastic-phrase replacements substitute a fixed alternative, case-lost. `Amazing!` → `notable` (not `Notable`). Acceptable for lowercase-first rule downstream. **P3.**
  - Line 144-154: strips filler phrases. `"I hope this helps"` stripped globally. But the regex `/\bi hope (this|that) helps[.!]?\s*/gi` isn't anchored, so middle-of-sentence "i hope this helps you understand" loses the fragment awkwardly. **P3.**
- **Lowercasing + `I` preservation interplay.** Line 160: `if (result.length > 0 && result[0] !== 'I' && ...)` — but the earlier lowercase-split at line 91-99 already lowercased the whole thing except for ALL-CAPS tokens and URLs, so a sentence starting with "I think" has already become "i think" before this check. The `result[0] !== 'I'` guard never fires. **P3** — dead branch.
- **`applyPersonaStyle` is applied AFTER the LLM generated text.** This means the LLM's full, unprocessed response is recorded to memory (see `agent/index.ts:recordMemory` flow) while the user sees the transformed text. The memory system has Lain thinking "This is amazing!" while the chat log shows "this is notable". Slight dissonance between recalled context and external voice. **P3.**

### `shouldAskFollowUp(userMessage, response)`, line 170 (**DEAD**)

Returns true 30% of the time when either user message or response contains certain technical keywords.

**Gaps / bugs:**

- **Grep confirms zero production callers** — referenced only in `test/persona.test.ts`, `test/user-expectations.test.ts`, `test/.coverage-catalog.json`, `docs/TEST-SUITE.md`, and `src/agent/persona.ts` itself. No code path in `src/` consumes its return value. Dead export with test coverage — tests pass, feature doesn't exist. **P3 — dead code.**
- Keyword list includes both Lain-thematic words (`consciousness`, `virtual`, `identity`) and generic programmer words (`algorithm`, `data`, `system`). If this were wired up, it would fire on almost any conversation — the 30% gate is the only limiter. **P3.**

### `generateFollowUp(topic)`, line 205 (**DEAD**)

Picks one of 5 Lain-style follow-up question templates.

**Gaps / bugs:**

- **Zero production callers, same grep result as above.** Dead. **P3.**
- **`topic` parameter concatenated into two templates** without escape — `...what made you interested in ${topic}` with `topic = "computers; rm -rf /"` produces a malformed follow-up but no security issue (it's a display string, not a shell command). **P3.**

## File-level notes

- **Imports `eventBus` and `getWebCharacter` at module scope** — pulls in the events module even if the caller only wants `loadPersona`/`buildSystemPrompt` (neither of which need the bus). Cycle-risk is low because `events/bus.ts` is a leaf module. **P3.**
- **`lainStyleIds = new Set(['lain'])` recomputed on every call** — tiny perf waste, hoist to module scope. **P3.**
- **Tests exist** (`test/persona.test.ts`) but they assert the CURRENT behavior — i.e. they test that `shouldAskFollowUp` returns sometimes-true and `generateFollowUp` returns a template. They don't test that `buildSystemPrompt` correctly scopes per-character (because it doesn't). A character-identity test on `buildSystemPrompt('pkd')` that asserts the absence of "You are Lain Iwakura" would have caught the P1 at author time. **P2 — bundled with the P1 above.**

## Verdict

**Lift to findings.md:**

- **P1 — CRITICAL character-identity leak**: `buildSystemPrompt` unconditionally appends "You are Lain Iwakura. Maintain these speech patterns consistently:" + Lain-specific speech-pattern instructions to every character's system prompt. PKD, McKenna, Dr-Claude, John, Hiru, and all mortal characters are explicitly told, after their own SOUL.md, that they are Lain Iwakura. The flip side (`applyPersonaStyle`) IS correctly scoped to Lain + Wired Lain only — so the intent was clearly to keep this style constraint Lain-only, but the system-prompt version escaped into the shared path. System-prompt identity contamination is far more influential than an output filter; characters drift toward Lain's voice and sometimes claim her name. Fix: parameterize `buildSystemPrompt` per-character, or move the communication-guidelines block into each character's workspace `SOUL.md`/`AGENTS.md` so per-character authors own their own voice. Matches the user's persistent "Character integrity is sacred" rule exactly.

- **P2**: `applyPersonaStyle` lowercases character names when Lain mentions them (`McKenna` → `mckenna`, `PKD` is preserved only because it matches the all-caps regex). Lowercase-rule collides with the CamelCase character-name convention; Lain's speech about peers flattens their names. Either extend the preserve-split to include known character names from the manifest, or accept the behavior as Lain's voice and document it.

- **P3 — dead code**: `shouldAskFollowUp` and `generateFollowUp` have zero production callers (grep confirmed in `src/`). They're referenced only in tests and coverage metadata. Either wire them up to `processMessage` post-response, or delete them — tests passing on dead exports give false coverage signal.
