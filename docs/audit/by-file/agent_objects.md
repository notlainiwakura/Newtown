---
file: src/agent/objects.ts
lines: 299
purpose: Emergent symbolic language via object-meaning composition. Each character assigns personal meanings to objects; LLM generates meanings for compound arrangements; stable compositions (≥3 uses) surface in system prompt. All meanings stored per-character in meta table.
section: 8 (agent loops)
audit-date: 2026-04-19
---

# agent/objects.ts

## Function inventory (10)
- `loadMeanings(characterId)` / `saveMeanings(characterId, ...)` — 53, 62.
- `loadLexicon(characterId)` / `saveLexicon(characterId, ...)` — 66, 75.
- `compositionKey(objects)` — 84: sorted name join.
- `getObjectMeaning(characterId, objectId)` — 93: exported.
- `setObjectMeaning(characterId, objectId, meaning)` — 106: exported.
- `reflectOnObject(provider, characterId, characterName, object, selfConcept, contextHint)` — 131: exported.
- `composeObjects(provider, characterId, characterName, objects, selfConcept, context)` — 165: exported.
- `buildObjectContext(characterId, wiredLainUrl)` — 240: exported.
- `getStableLexicon(characterId)` — 289: exported.

## Findings

### 1. LLM-generated meanings flow into system prompt via `buildObjectContext` / `getStableLexicon` (P2 — bundle)

Lines 261, 296. Each object meaning and each stable composition text appears in the character's system prompt context block. The meanings were LLM-generated from `object.description` and `object.creatorName` (fetched from Wired Lain's `/api/objects`).

**Chain**: another character creates an object with adversarial name/description → object API returns to this character → `reflectOnObject` LLM call builds meaning from description → meaning stored → meaning re-injected into every future system prompt.

Injection persists in the meta table until overwritten. Length cap `MAX_CONTEXT_CHARS = 1500` (line 49) limits prompt bloat but doesn't limit storage — individual meanings are unbounded.

### 2. `buildObjectContext` fetches `${wiredLainUrl}/api/objects` without auth (P2 — bundle)

Line 249. No `Authorization: Bearer`. Matches awareness.ts and commune-loop phaseApproach pattern. `/api/objects` auth posture needs verification in server audit.

### 3. `object.description` flows verbatim into `reflectOnObject` prompt (P2)

Line 141. Description is author-supplied text. Unsanitized. Part of the standard injection propagation chain.

### 4. `compositionKey` uses sorted-name-join — collisions possible (P3)

Line 85: `objects.map((o) => o.name).sort().join(' + ')`. Two objects with identical names from different creators produce the same key. Two compositions `[A, B]` and `[B, A]` correctly collapse. But `[pebble (creator X), pebble (creator Y)]` is one key.

**Consequence**: the lexicon entry conflates different-origin objects with the same name. The LLM sees "you've composed 'pebble + stone' 3 times" when actually it's 3 different pebbles and 3 different stones. Possibly intentional for symbolic-language emergence; worth noting.

### 5. `saveLexicon` evicts by `lastUsed` after cap (P3)

Lines 77–80. `lexicon.length = MAX_LEXICON_ENTRIES` truncates. Sort by `lastUsed` desc first — keeps most recent. An attacker who gets a character to compose a flood of unique object pairs can evict pre-existing stable entries. Unlikely but theoretically possible.

### 6. `setObjectMeaning` history cap prevents unbounded growth (positive)

Line 114: `[existing.meaning, ...existing.history].slice(0, MAX_MEANING_HISTORY)`. Max 5 history entries. Good.

### 7. Per-character storage keys (positive, line 55, 63, 68, 81)

`objects:meanings:${characterId}` and `objects:lexicon:${characterId}` — namespaced by character. Nice pattern. Note: the character-ID IS in the key itself (vs being scoped by per-character DB). This means a single shared DB with multiple character IDs would work correctly. But the codebase uses per-character DBs anyway, so the character-ID prefix is redundant — and potentially dangerous if character IDs from different DBs ever leak cross-database.

Actually on closer look: getBasePath() → per-character DB → single `characters` file namespace. The characterId prefix is defense-in-depth or vestigial from an earlier shared-DB design. Either way, correct.

### 8. `reflectOnObject` / `composeObjects` have no rate limit (P3)

Each call is an LLM call. If a tool exposes `reflect_on_object` or `compose_objects` to the character's agentic loop (per commune-loop aftermath line 720), repeated invocations burn tokens. No dedup, no cooldown.

### 9. `eventBus.emitActivity` broadcasts full 200-char meaning (P2 — bundle)

Line 224. Composition meaning broadcasts into event bus. If listeners persist or display these, meaning content propagates further. Minor persistence surface.

### 10. `parts.push('You carry:\n' + lines.join('\n'))` — no cap on line count (P3)

Line 265. If character carries 100 objects, 100 lines get injected. Caught by `MAX_CONTEXT_CHARS` truncation at line 280 — so the excess is dropped. But the cut might split a meaning mid-sentence. Line 281 adds `'\n...'` to signal truncation — good.

### 11. `getStableLexicon` uses `e.meanings[0]` — most recent meaning only (positive)

Line 296. Shows the latest interpretation. Previous versions preserved in `e.meanings[1..4]` but hidden from prompt. Reasonable.

### 12. `fetch(...)` timeout 5s but no retry (P3)

Line 251. If `/api/objects` is slow, context is empty. Character acts as if they carry nothing. Minor.

## Non-issues / good choices
- `compositionKey` sort makes composition commutative — `[A,B]` and `[B,A]` collapse.
- History cap per meaning (5 entries) bounds storage growth.
- Lexicon cap (50 entries) with LRU-ish eviction.
- `MAX_CONTEXT_CHARS` cap prevents prompt bloat.
- Per-character storage namespace.
- Clean separation of storage helpers vs LLM-generating functions.
- `eventBus.emitActivity` gives observer visibility into symbolic-language formation.

## Findings to lift
- **P2 (bundle)**: Object meanings generated from injection-carrying description/name text, persist in meta, re-injected into every system prompt. Amplification chain.
- **P2 (bundle)**: `buildObjectContext` fetches `/api/objects` unauth'd.
- **P2**: `eventBus.emitActivity` broadcasts composition meanings to other listeners.
- **P3**: Composition-key name-collision across different-origin same-named objects.
- **P3**: Eviction-attack theoretically possible via flood of unique compositions.
- **P3**: No rate limit on reflection / composition LLM calls.

## Verdict
Nice, bounded, per-character symbolic-language layer. The security concerns are bundled — same injection-propagation chains that run through every LLM-input surface in the system. The character-ID namespacing in keys is a belt-and-suspenders pattern worth preserving.
