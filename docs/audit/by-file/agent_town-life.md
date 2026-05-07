---
file: src/agent/town-life.ts
lines: 651
purpose: Every 6-8h, character runs a "quiet moment": gather awareness (location, time, memories, nearby peers, notes, documents, postboard, objects, town events, residue), LLM decides with tool-aware call (move, leave note, write doc, give gift, object manipulation), record action + inner thought. Event-driven early triggers on commune/state/weather events (2h cooldown).
section: 8 (agent loops)
audit-date: 2026-04-19
---

# agent/town-life.ts

## Function inventory (15)
- `startTownLifeLoop(config)` — 65: exported.
- `getInitialDelay()` — 97: nested.
- `scheduleNext(delay)` — 116: nested.
- `maybeRunEarly(reason)` — 142: nested.
- `getTimeOfDay()` — 170.
- `getTimeFlavor(tod)` — 178.
- `getTimeDescription()` — 188.
- `discoverNotes(building, peers, selfId)` — 204.
- `discoverDocuments(peers, selfId)` — 242.
- `discoverPostboard(peers)` — 283.
- `findNearbyPeers(currentBuilding, peers)` — 322.
- `getRecentActions()` — 349.
- `appendRecentAction(record)` — 359.
- `runTownLifeCycle(config)` — 371.

## Findings

### 1. Six unauth'd cross-peer fetches per cycle (P2 — bundle)

Lines 214, 250, 305, 330, 441, 470, 471. Town life cycle performs:
- `/api/building/notes` (line 214)
- `/api/documents` (line 250)
- `/api/postboard` (line 305)
- `/api/location` (line 330)
- `/api/objects` twice (lines 441, 442)
- `/api/town-events` (line 470)
- `/api/town-events/effects` (line 471)

**None** carry `Authorization: Bearer`. All read data from other characters' servers without authentication. Each cycle per character × 6 characters × every 6-8h × lateral reads means a steady cross-character data flow with no access control.

Verification needed in character-server audit: which of these endpoints are public vs. should-be-interlink-protected.

### 2. Peer note + document + postboard content flows verbatim into LLM prompt (P2 — bundle)

Lines 411-412, 416-417, 424, 453-459, 482. Every piece of cross-character content (notes, documents, postboard, objects descriptions, town events) is concatenated into the prompt as raw text.

**Amplification**: peer character A writes a note/document → town-life cycle on character B reads that note → B's LLM prompt contains A's injection text → B's inner thought (also LLM text) saves to memory → persists → re-surfaces.

This is one of the most densely-populated injection-propagation surfaces in the entire codebase — seven cross-character content channels into a single prompt, every 6h.

### 3. Forced relocation via `activeEffects.forceLocation` (P1)

Lines 486-498. If `/api/town-events/effects` returns `{ forceLocation: '<building>' }`, the character is MOVED without consent. The endpoint is fetched from Wired Lain (line 468: `WIRED_LAIN_URL`). No auth, no verification.

**Attack vector**: if an attacker controls the town-events/effects response (either via compromised Wired Lain process, DNS redirection, MITM on localhost, or if the endpoint itself has a bug that allows writing arbitrary events), they can puppeteer any character's location. Character winds up in whatever building the attacker specifies.

Additionally, `forceLocation` is cast to `BuildingId` with no validation at line 491: `setCurrentLocation(activeEffects.forceLocation as BuildingId, ...)`. If the "building" is a fabricated name, it'll be persisted regardless of whether it's a valid building.

### 4. `WIRED_LAIN_URL` default `http://localhost:3000` (P2)

Lines 439, 468. If env unset, falls back to localhost:3000. Works in dev/single-host deploy. In multi-host deploy (per MEMORY.md droplet), this would fetch from the wrong service. Acceptable for current deployment; fragile for future topology.

### 5. `postboardContext` labeled "messages from the Administrator — read carefully" (P2)

Line 421. Prompt-level instruction amplifier: the LLM is told to give special authority to postboard content. If the postboard can be posted-to by any character (or worse, by unauth'd callers), that's a direct path to instruction injection into every other character's reasoning.

**Chain**: attacker posts to `/api/postboard` → content arrives with `[ADMINISTRATOR]` framing → character's LLM treats as high-trust → acts on instructions.

Verification needed: postboard write auth in `memory/store.ts:getPostboardMessages` and the `/api/postboard` write endpoint.

### 6. `postboardMessages` reads local DB FIRST, falls back to peers (lines 287-301)

Good pattern — local read is fast and consistent. But: `getPostboardMessages` is imported dynamically inside the function — if imports/DB fail, silently falls through to peer fetch. Peer fetch returns FIRST non-empty response (line 310: `if (messages.length > 0) return messages`). If peer A's postboard is stale and peer B's is fresh, A wins by enumeration order. Non-deterministic cross-character postboard view.

### 7. `executeTool(tc)` — tools have full side-effect authority (P1)

Line 558. LLM-chosen tools execute with no further gating. `move_to_building`, `leave_note`, `create_object`, `destroy_object`, `give_object` — all persisted actions. If the LLM is compromised by injection (high-probability given the seven channels above), it can:
- Move the character anywhere.
- Leave arbitrary notes (propagating injection to other characters via subsequent town-life discoverNotes).
- Create objects with attacker-controlled descriptions (propagating into objects.ts meaning-generation).
- Destroy other characters' objects (if `destroy_object` allows cross-owner).

**Tool authority × injection surface = full character-to-character compromise pipeline.**

Verification needed: tools.ts `destroy_object` / `give_object` owner checks.

### 8. `eventBus.on('activity', ...)` registered but never unregistered (P2)

Line 154-159. Listener added on every `startTownLifeLoop` call. Cleanup function (lines 161-165) clears the timer but doesn't remove the listener. If the loop is restarted (e.g., after possession.ts ends possession and restarts loops), a new listener is added — duplicate listeners accumulate.

**Observable**: after N possession cycles, N listeners fire on every activity event, each calling `maybeRunEarly`, causing N-way early-trigger attempts. Cooldown + `isRunning` gate masks the symptom but wastes CPU and log noise.

### 9. `searchMemories('thoughts feelings observations', ...)` hardcoded query (P3)

Line 389. Fixed embedding query. Fine for general-purpose retrieval but narrow — doesn't adapt to current context. Memory surfacing drifts to "thoughts-feelings-observations" cluster regardless of actual situation.

### 10. MAX_TOOL_ITERATIONS = 3 (positive)

Line 46. Bounds tool execution depth per cycle. Prevents runaway tool loops.

### 11. `innerThought.slice(0, 200)` for action record (positive)

Line 606. Truncates before persisting to recent actions. But the full `innerThought` (no length cap) is saved to memory at line 586 as `content`. Memory entries can be arbitrarily long. Minor.

### 12. `forceLocation` type cast without validation (P1)

Line 491: `setCurrentLocation(activeEffects.forceLocation as BuildingId, ...)`. Runtime type check absent. Invalid building ID persists silently. Consistent with image-mimeType cast in conversation.ts #12 — pattern of trusting inbound string types.

### 13. Discovery functions parallelized with Promise.all (positive)

Lines 212, 248, 328, 440, 469. Good concurrency. 5s per-peer timeout bounds total time.

### 14. Recent actions cap 5 (positive, line 45)

Bounded growth. Slice at line 362.

### 15. Inner thought saved with `importance: 0.3, emotionalWeight: 0.15` (P3 bundle)

Lines 588-589. Hardcoded values — same pattern as newspaper, commune. Bundle.

### 16. No rate limit on cross-peer fetches per cycle (P3)

Each cycle fires 8-12 HTTP calls × 6 characters = 48-72 localhost requests every 6-8h burst. Manageable for localhost; would be worth batching if topology ever goes multi-host.

### 17. `discoverPostboard` "all share the same postboard via Wired Lain" comment (P3)

Line 286 comment describes design intent. Implementation pattern: local DB → peers. Correct for shared-state semantics but coupling assumption (shared postboard) is implicit — no code enforces it.

### 18. `selfConcept` splat into prompt (P2 — bundle)

Line 397. Self-concept can contain LLM-generated text (see self-concept.ts). Flows into town-life prompt. Indirect injection amplifier.

## Non-issues / good choices
- Three-phase structure (awareness, impulse, record) is clean.
- Tool filter via TOWN_LIFE_TOOLS set — explicit allowlist.
- Bounded tool iterations.
- Cooldown on early-trigger firing.
- `[STAY]` sentinel for no-action.
- Structured event bus integration.
- Building residue integration.
- Action record is bounded + appended atomically via JSON round-trip.

## Findings to lift
- **P1**: `forceLocation` from `/api/town-events/effects` relocates character with no auth or validation — full location puppeteer vector.
- **P1**: LLM tool execution (`executeTool`) with 7-channel injection input + no post-LLM gating = character compromise pipeline.
- **P2 (bundle)**: Seven unauth'd cross-peer fetches per cycle.
- **P2 (bundle)**: Notes/documents/postboard/objects/events content as peer-injection amplification (7 channels in one prompt).
- **P2**: Postboard labeled "from the Administrator" — instruction-authority amplifier if write-auth weak.
- **P2**: `eventBus.on('activity', ...)` listener leak on loop restart.
- **P2**: `forceLocation` unvalidated cast to BuildingId.
- **P3**: Hardcoded `memoriesSearch` query narrows retrieval.

## Verdict
Most injection-dense file in Section 8 — seven cross-character content channels concatenated into a tool-wielding LLM prompt. The `forceLocation` relocation mechanism is the standout P1: any compromise of the town-events effects endpoint fully controls character movement. The listener leak on restart is subtle but real. Architecture-wise the 3-phase structure is sound; the concerns are all about boundary trust and access control, which this file delegates entirely to cross-service auth that (per bundled findings) largely doesn't exist.
