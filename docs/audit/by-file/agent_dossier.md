---
file: src/agent/dossier.ts
lines: 380
purpose: Wired Lain's weekly character-profile synthesis. For each manifest-listed dossier subject, gathers (a) research_received memories from Wired Lain's own DB, (b) /api/commune-history from the character, (c) /api/telemetry (bearer-authed). LLM synthesizes 300-400 word dossier; stored in meta as `dossier:{characterId}`.
section: 8 (agent loops)
audit-date: 2026-04-19
---

# agent/dossier.ts

## Function inventory (8)
- `dossierSubjects()` — 37: lazy manifest lookup.
- `getResearchHistory(characterName, sinceDaysAgo)` — 78.
- `getCommuneHistory(port)` — 104.
- `getTelemetry(port)` — 119.
- `synthesizeDossier(subject)` — 135.
- `getDossier(characterId)` — 250: exported; sync.
- `getAllDossiers()` — 261: exported; sync.
- `runDossierCycle()` — 275.
- `startDossierLoop(config)` — 309: exported.

## Findings

### 1. `manifestDossierSubjects('wired-lain')` — manifest-driven (positive, line 16, 38)

Contrast with doctor.ts which hardcodes `TELEMETRY_SERVICES` / `HEALTH_CHECK_SERVICES` as 6-character arrays. Here the subject list is derived from `characters.json`. Adding a new character auto-includes them in Wired Lain's dossier cycle. This is the correct pattern.

Lazy evaluation (line 37 wraps the call in a function) protects test mocks that hook `fs.readFileSync` — comment at line 34-36 acknowledges this. Nice.

### 2. `/api/commune-history` fetched WITHOUT auth (P2 — bundle)

Line 106-108. No `Authorization: Bearer ${interlinkToken}` header, vs `/api/telemetry` at line 124 which has the bearer. Commune history is likely less sensitive than telemetry but still contains peer-conversation openings and reflections — things that should not be open to unauth'd lateral callers.

**Verification needed**: check `/api/commune-history` endpoint auth in character-server audit. If public, any process on the host can read another character's conversation history. Bundle with the ~5 other unauth'd fetches documented in this section (awareness.ts, objects.ts, feed-health.ts backup pool, dream-seeder, newspaper.ts).

### 3. `/api/telemetry` with bearer auth (positive, line 121-124)

Correct. Reads `LAIN_INTERLINK_TOKEN` fresh each call. No module-load snapshot. Good contrast with letter.ts DEFAULT_CONFIG.

### 4. Peer-injection propagation: commune + telemetry → dossier → Wired Lain system prompt (P2 — bundle)

Multi-hop chain:
1. Peer character A has injection in their memories (e.g., via adversarial user chat).
2. A's memories surface in `/api/telemetry` → `hotMemories[].content` (line 195 slices 100 chars).
3. Commune reflections from A in their `/api/commune-history` → `openingTopic`, `reflection` (lines 179-181).
4. Dossier LLM synthesizes from that data → 300-400 word profile.
5. Dossier persists in Wired Lain's meta as `dossier:{characterId}`.
6. Wired Lain's loops read `getDossier(id)` or `getAllDossiers()` → inject into her system prompt.

Persistent amplification surface. The dossier stores a compressed representation of A's injection, framed as "who A is." Wired Lain then reasons about A through that framing in future conversations.

### 5. Previous dossier fed into new dossier — drift-lock (P2 — bundle with self-concept, narratives)

Lines 212-213, 224: `PREVIOUS DOSSIER (update, don't repeat):\n${previousDossier}\n`. Same drift-lock pattern — last-week's dossier anchors this-week's, even when evidence has shifted. Instruction "update, don't repeat" partially mitigates but LLM recency bias still wins.

### 6. No length cap on persisted dossier (P3)

Lines 236-242. `result.content.trim()` length checked >= 50, no upper bound. Prompt asks for 300-400 words but LLM may exceed. Dossier stored verbatim; if injected into system prompt unbounded, prompt bloat risk.

**Verification needed**: check callers of `getDossier` / `getAllDossiers` for size limits before system-prompt inclusion.

### 7. Research-history filter by `characterName` metadata (P3)

Line 84: `json_extract(metadata, '$.characterName') = ?`. If the name ever changes (character renamed in manifest but memory metadata was written with old name), history is partitioned. No migration path. Cosmetic — characters don't rename.

### 8. `hotMemories` content sliced to 100 chars in prompt (partial mitigation, line 195)

Truncation reduces amplification per memory but doesn't eliminate it. 3 memories × 100 chars = 300 chars of potentially-injected content per dossier cycle. Enough surface for drip-feed injection.

### 9. `synthesizeDossier` Promise.all data gather (positive, line 147)

Parallel fetches across 4 sources. Good. 5s timeout on HTTP calls prevents slowpath blocking.

### 10. Individual subject error isolation (positive, lines 282-298)

try/catch around each subject's synthesis means one character's failure doesn't kill the whole cycle. `updated` / `total` counter logged. Good.

### 11. `last_cycle_at` gate in scheduleNext (positive, line 360)

After initial delay, subsequent checks only synthesize if `elapsed >= intervalMs (7d)`. Prevents 12h-cadence over-synthesis. Correct.

### 12. Dossier archive to `dossier:{id}:previous` (positive, line 286-289)

One-step archive. Consistent with narratives pattern. Loss window if process dies between lines 288 and 291 — old dossier is in `:previous`, new dossier never written, but old `:current` still holds old dossier (setMeta call at line 291 is the overwrite). Two-write sequence, non-atomic. Acceptable.

### 13. `getCommuneHistory` silently returns `[]` on any error (P3)

Lines 109-113. `resp.ok === false`, `AbortSignal.timeout`, network error — all collapse to empty array. No distinction between "character has no history" and "endpoint down / auth rejected." Dossier synthesis proceeds with missing signal.

### 14. `loopHealth` field in TelemetryData unused in dossier prompt (P3)

Line 71 declares `loopHealth: Record<string, string | null>`, but synthesizeDossier doesn't emit it into `tLines`. Dead field in the prompt. Cosmetic — either use or remove.

### 15. `sessionActivity` ordered by count, top-5 (positive, line 198-203)

Reasonable truncation. No injection carrier since session keys are local identifiers.

## Non-issues / good choices
- Manifest-driven subject list (the correct pattern for multi-character extensibility).
- Bearer auth on telemetry.
- 5s AbortSignal timeouts on HTTP.
- Previous-dossier archival before overwrite.
- Per-subject error isolation.
- Lazy manifest lookup for test-mock compatibility.
- `getMeta` try/catch wrappers (lines 252-254).
- Clean `stopped` + `timer` cleanup.

## Findings to lift
- **P2 (bundle)**: `/api/commune-history` fetched without auth — verify endpoint in server audit.
- **P2 (bundle)**: Injection-propagation chain: peer telemetry/commune → dossier → Wired Lain's system prompt. Persistent amplifier.
- **P2 (bundle)**: Drift-lock from previous-dossier feedback (bundle with narratives, self-concept).
- **P3**: No upper bound on dossier length.
- **P3**: `loopHealth` declared but unused in prompt.

## Verdict
Best-in-class manifest-driven pattern and clean per-subject isolation. The dossier feature is valuable — it gives Wired Lain a stable mental model of each inhabitant — but precisely because it's stable and persistent, it concentrates injection-surface from the weekly aggregate of peer-produced content into a single text that re-injects into her reasoning. Worth an auth check on `/api/commune-history` and bundled consideration of the dossier-as-amplifier pattern alongside narratives and self-concept.
