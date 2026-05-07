---
file: src/agent/relationships.ts
lines: 208
purpose: Per-peer subjective relationship model (affinity/familiarity/intellectual_tension/emotional_resonance/last_topic_thread/unresolved). Stored in meta `relationship:{peerId}` keys. LLM-updated after each commune conversation; heuristic fallback on LLM failure. Used by commune-loop impulse and awareness context.
section: 8 (agent loops)
audit-date: 2026-04-19
---

# agent/relationships.ts

## Function inventory (7)
- `getRelationship(peerId)` — 32: exported.
- `saveRelationshipData(peerId, data)` — 46: exported; enforces familiarity monotonicity.
- `getAllRelationships()` — 57: exported; SQL LIKE scan.
- `getRelationshipContext(peerId)` — 77: exported; prompt-ready string.
- `updateRelationship(peerId, peerName, transcript, reflection)` — 104: exported; LLM + fallback.
- `makeDefaultRelationship(peerId, peerName)` — 186.
- `clamp(v, min, max)` / `toNumber(val, fallback)` — 201, 205.

## Findings

### 1. `transcript` flows verbatim into LLM prompt (P2 — bundle)

Line 132: `${trimmedTranscript}`. The transcript was built from peer responses in commune-loop. Injection content that survived into the transcript gets re-contextualized in this prompt. LLM may be persuaded to shift `affinity`, `unresolved`, or `last_topic_thread` based on adversarial content.

**Consequence**: a compromised peer can shape the LOCAL character's relationship perception. Affinity drift toward the attacker's peerId → more future conversations → more injection opportunities. Self-amplifying feedback.

### 2. `last_topic_thread` and `unresolved` are LLM-generated strings stored verbatim (P2)

Lines 161–162. Strings flow from LLM output → meta store → injected into future commune impulse prompts (via `getRelationshipContext` at commune-loop line 329-330).

Injection persistence: attacker shapes `unresolved` string → appears in every future commune impulse prompt → sustained influence across multiple sessions. Similar to self-concept persistence but at smaller scope.

### 3. `jsonMatch = result.content.match(/{[\s\S]*}/)` — greedy, matches anywhere (P3)

Line 148. If the LLM prefixes its response with any JSON-looking text (e.g., "Here's a snippet: {...}") the regex match starts from there. `[\s\S]*` is greedy so it matches to the last `}` in the output. If the LLM echoes the prompt (which has nested braces in the field list), match may include prompt fragments.

In practice the LLM's output is bounded by `maxTokens: 400` (line 144) and there's only one JSON object expected. Still fragile.

### 4. LLM update failures fall back to incrementing familiarity only (P3)

Lines 170–181. On ANY error (parse fail, no provider, network error, malformed JSON), the fallback just bumps familiarity by 0.05 and increments count. Other fields stay static. Over many failed cycles, relationships look frozen in affinity/tension/resonance even as conversations continue.

Observable symptom: if the default relationship (affinity 0.5, tension 0.5) sticks because updates fail silently, characters never develop warmth or friction with peers. The fallback is silent (`logger.debug`, line 172).

### 5. `getAllRelationships` does SQL `LIKE 'relationship:%'` scan (P3)

Line 60. Full index scan on the meta table. For a character with many peers this is fine; for a meta table with many keys this is linear. Current scale OK.

### 6. `parsed['unresolved'] === null` null-check via triple-equals on `unknown` (P3)

Line 162. `parsed['unresolved']` is typed `unknown`. If LLM returns JSON with `"unresolved": null`, JSON.parse produces JS `null`, `parsed['unresolved'] === null` is true → sets `unresolved: null`. OK. If LLM returns `"unresolved": "none"`, it's a string → sets to `"none"`. Edge case: `"unresolved": false` → neither branch matches, falls to `existing.unresolved`. Probably fine.

### 7. Familiarity monotonicity enforced but re-enforced again in save (positive)

Line 49 AND line 158. Double-enforced. Slightly redundant, but the LLM call output and the save gate both clamp it. Belt and suspenders.

### 8. `interaction_count` always increments (P3)

Line 164 and 178 both increment. No cap. Over many years of running this becomes large; the field is only used for display in `getRelationshipContext` (line 90). Cosmetic.

### 9. `affinity / intellectual_tension / emotional_resonance` have no monotonicity or bounds on drift (P3)

Lines 157, 159, 160. Each just clamps to [0, 1]. The prompt says "Adjust by 0.02-0.15" but LLM can violate. If LLM sets affinity to 0.0 in one step, it's clamped but the relationship instantly resets.

**Gap**: should clamp the DELTA, not just the value. Currently a single weird LLM response can overwrite 10 cycles of carefully-built affinity.

### 10. No peer identity validation in `saveRelationshipData` (P3)

Line 46. `peerId` is used as meta key. If called with a bogus peerId (e.g., an attacker-crafted string containing a colon or path-like separators), the key `relationship:${peerId}` can collide with other meta keys. Needs server-side audit to confirm how peerId is sourced.

## Non-issues / good choices
- `familiarity` monotonicity is the right instinct — relationships deepen, don't reset.
- `makeDefaultRelationship` provides sensible starting values.
- Heuristic fallback ensures update isn't lost on transient LLM failure.
- Trimmed transcript (2000 chars) + reflection (500 chars) — bounded prompt size.
- `clamp` helper applied consistently.
- `getAllRelationships` swallows individual malformed-row errors.

## Findings to lift
- **P2 (bundle)**: Transcript → LLM update → `unresolved`/`last_topic_thread` persist → future commune impulse prompts. Peer-injection amplifier via relationship model.
- **P3**: Heuristic fallback is silent and only bumps familiarity — other fields freeze under failure.
- **P3**: No delta-clamping on affinity/tension/resonance — one weird LLM output can wipe accumulated state.
- **P3**: `jsonMatch` regex greedy; fragile if LLM prefixes output.

## Verdict
Straightforward storage + LLM-update layer. The missing delta-clamp (#9) is the meaningful functional concern — relationships should drift, not spike. The injection-via-unresolved-thread persistence (#2) is significant but bounded by the string being visible in impulse prompts the LLM can evaluate rather than trusted as code.
