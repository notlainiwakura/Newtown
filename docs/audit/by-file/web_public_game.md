---
file: src/web/public/game/js/{config,sprites,pathfinding,fixtures}.js + systems/*.js + scenes/*.js
lines: 253 + 237 + 105 + 1564 + 222 + 589 + 160 + 246 + 148 + 508 + 222 + 508 + 410 = 5172
purpose: Phaser 3 isometric game client. Owner walks around the town, possesses characters, chats with them; spectators get a read-only view with canned replies. Organized as: game constants (config.js), sprite atlases (sprites.js), A* pathfinding, per-building fixture catalog (fixtures.js, 1564 lines of hardcoded interiors), 5 systems (APIClient, CharacterManager, DialogSystem, ObjectManager, PossessionManager), and 4 scenes (Boot, Title, World, Dialog).
section: 11 (frontend — game)
audit-date: 2026-04-19
---

# web/public/game/ (consolidated)

## Module shape
- **`config.js`** — `GAME_CONFIG` constants, `GAME_THEME` CSS-variable reader, `BUILDINGS` layout, `CHARACTERS` populated at boot from `/api/characters`, `DEFAULT_LOCATIONS`, `renderPixelSprites()` generator.
- **`sprites.js`** — hardcoded sprite-atlas frame definitions.
- **`pathfinding.js`** — `findPath(grid, from, to)` A* on tile grid.
- **`fixtures.js`** — 1564-line hardcoded per-building interior catalog.
- **`systems/APIClient.js`** — fetch wrapper; `connectStream` + `connectConversationStream` SSE handlers.
- **`systems/CharacterManager.js`** — NPC sprite lifecycle, location polling every ~6s, wander animation.
- **`systems/DialogSystem.js`** — chat-bubble floating UI.
- **`systems/ObjectManager.js`** — renders placed objects (from `/api/objects`).
- **`systems/PossessionManager.js`** — possession start/stop/move calls, pending-message buffer for incoming peer messages.
- **`scenes/BootScene.js`** — loads manifest, generates textures, transitions to TitleScene.
- **`scenes/TitleScene.js`** — splash + "press to enter."
- **`scenes/WorldScene.js`** — main scene; player movement, camera, zone check, speech bubbles.
- **`scenes/DialogScene.js`** — full-screen chat overlay with per-NPC history persistence.

## Findings

### 1. Fallback character id `Object.keys(CHARACTERS)[0]` — manifest ordering determines player sprite (P2)

`WorldScene.js:20, 29`. When `authData.characterId` is absent, the scene selects the first character from the manifest by object-key order as the player. JavaScript object key order for string keys is insertion order — which depends on how the server serializes `characters.json`. A reorder of `characters.json` (harmless in other contexts) changes who the "default" player sprite is. The sprite texture fallback on line 29 has the same issue. Compounded because there's no console warning when the fallback fires.

**Fix:** either require `authData.characterId` and hard-fail without it, or pick a stable fallback (e.g., manifest entry with `defaultPlayer: true`).

### 2. Chat history `_chatHistories` persists across scene shutdowns — unbounded growth (P2)

`DialogScene.js:7`. `_chatHistories` is a module-level constant object keyed by `<npcId>` (or similar). Each entry accumulates messages forever; no TTL, no per-character cap, no purge on scene shutdown. A long owner session that talks with many NPCs across many visits accumulates every message ever exchanged in memory. Also: the Dialog scene is relaunched each time a conversation opens, so the module-level state is the ONLY history store — but there's no eviction policy.

**Fix:** cap per-character at ~200 messages; evict sessions older than N minutes.

### 3. SSE streams in `APIClient.js` reconnect with fixed delay — no exponential backoff (P2)

`APIClient.js:145, 213-214`. Possession-stream and conversation-stream reconnects use fixed 5s / 10s delays. A failing server floods both endpoints with rapid reconnection. Non-game frontend already uses exponential backoff (`commune-map.js`) — inconsistent patterns across the same codebase.

**Fix:** exponential backoff capped at ~60s, same pattern used elsewhere.

### 4. Pathfinding has no iteration limit — potential runaway on pathological maps (P2)

`pathfinding.js:49-102`. A* while-loop runs until the goal is found or the open list empties. No `MAX_ITERATIONS` guard. On a maliciously-crafted or buggy fixtures.js output that produces an unreachable goal on a large grid (e.g., a hollow ring), the algorithm exhausts the open list exploring every reachable tile — measurable CPU spike during player movement.

**Fix:** add `if (++iterations > 5000) return [];` — pragmatic cap for a tiny town grid.

### 5. `PossessionManager._handleStreamEvent` trusts unvalidated SSE event shape (P2)

`PossessionManager.js:73-90`. `if (event.type === 'peer_message')` is the only check. No validation of `fromId`, `fromName`, `message` presence. Malformed event (from a compromised upstream, a code bug, or a version-drift between server and client) pushes `undefined` into `pendingMessages`, which downstream code reads without null-checks.

**Fix:** schema check before enqueue; log-once on malformed event.

### 6. `WorldScene._onConversationEvent` does not verify `event.speakerId` is a known character (P2)

`WorldScene.js:350-351` (CHARACTERS[pending.fromId] lookup). Fallback `{name: pending.fromName, colorHex: '#808080'}` uses untrusted-ish `fromName` from the SSE event. Phaser's `add.text()` does NOT render HTML (it draws to canvas), so this is not XSS — but it IS a display-spoofing vector: server-side interlink endpoints trust body-asserted `fromId` (Section 9 P1), so any interlink-token holder can cause a peer-message event with `fromId: 'admin'` and `fromName: '<urgent message>'` to render in the owner's game. Not code-execution, but social-engineering surface.

**Fix:** reject SSE events with unknown `speakerId`; at minimum mark them as "unknown sender" in the UI.

### 7. Possession move: client-side state updates before server confirmation (P2)

`WorldScene.js:283` + `PossessionManager.js:54-60`. On zone-change, `possessionManager.currentBuilding` is set immediately, then `_notifyMove` fires the POST with a `.catch(() => {})` silent-fail. Server rejection (auth expired, building blocked by a town event) leaves the client believing the move succeeded. Subsequent actions (look, talk) issued against the wrong location's endpoints will 404 silently. No toast, no visible indicator.

**Fix:** optimistic update with rollback on failure; visible "movement failed" indicator.

### 8. `checkZone` silent-fail on move POST + no operator signal (P2)

`WorldScene.js:283`. Tied to finding 7. `_notifyMove(...).catch(() => {})` swallows errors completely. Operator loses all visibility into server rejections.

**Fix:** at minimum `.catch(e => logger.warn(...))`; send to the game-side debug console.

### 9. Possession start is not awaited — race with immediate dialog open (P2)

`WorldScene.js:122-125`. `_initWorld()` is async but called from `create()` without `await`. If the user mashes the dialog-open key immediately after scene enter, `startPossession` may still be in-flight when the dialog dispatches a chat. Symptom: first chat turn fails with 401 or possession-not-found.

**Fix:** add `this.possessionReady = false` flag; gate dialog-open on `possessionReady`.

### 10. Speech bubbles outlive despawned characters (P2)

`WorldScene.js:407-422`. If `charManager.destroy()` removes a character mid-conversation (character server restarted, or they moved out of range), the speech bubble stays on-screen forever because the update loop silently skips orphaned bubbles rather than destroying them.

**Fix:** during `_updateSpeechBubbles`, destroy bubbles whose `charId` is no longer in `charManager.sprites`.

### 11. Object-refresh polling silently ignores errors (P2)

`ObjectManager.js:190-201`. `catch { /* ignore */ }` on fetch failure. Stale objects remain on screen indefinitely until next successful poll. No operator signal.

**Fix:** log, apply exponential backoff, show a "loading objects…" indicator on repeated failures.

### 12. `ObjectManager` uses `obj.id` as texture key with no dedup (P2)

`ObjectManager.js:65`. `textureKey = 'obj_' + obj.id`. Server-side objects should have unique IDs but the client doesn't enforce it — on duplicate IDs (bug or race condition in server), Phaser's texture cache collapses them and one object renders with the other's sprite.

**Fix:** Set-dedup before rendering; warn on collision.

### 13. `loadCharacterManifest` has no timeout — infinite splash on stuck API (P2)

`BootScene.js:26`. `await loadCharacterManifest()` with no `Promise.race` timeout. If `/api/characters` hangs (not responds 500, but never responds), the splash screen stays forever with no error banner.

**Fix:** `Promise.race([fetch, timeoutAfter(10s)])` → show retry UI on timeout.

### 14. Dead token-input code in `TitleScene.js` (P3)

`TitleScene.js:87-135`. Legacy token-input flow after an unconditional `return` earlier. ~50 lines of unreachable code. Delete.

### 15. `BootScene._regenerateTileTextures` never called (P3)

`BootScene.js:58-71`. Defined for runtime skin-swap support; skin change actually triggers `location.reload()` instead. Dead until skin-swap is implemented without reload — either wire it up or delete.

### 16. Title-scene cursor-blink timer not explicitly cleaned on scene shutdown (P3)

`TitleScene.js:113-119`. `time.addEvent({loop: true, ...})` — Phaser's scene shutdown should clean this automatically, but explicit removal is safer and the pattern is inconsistent with other timers in the codebase.

### 17. Chat / location / object fetches have no retry on transient 5xx (P2)

`CharacterManager.js:559` + `APIClient.js:159-165` silently return null / drop the poll. Chained effect: a momentary server glitch makes NPC positions freeze until next scheduled poll, chat requests silently fail without user feedback.

**Fix:** shared retry helper (1-2 retries with jitter) inside `APIClient.js`.

### 18. `DialogScene.js` hardcoded delays (800+1200ms reply staging) assume fast network (P3)

`DialogScene.js:313`. On slow networks the staged reply animations collide with actual responses and feel chaotic. Non-security, low-priority UX refinement.

### 19. `fixtures.js` hardcodes per-building interiors → drift vs manifest-driven approach (P2)

`fixtures.js` (1564 lines). Every building interior (library, studio, school, garden, ballroom, plaza, hall, theater, bar) has a hardcoded fixture list. If a new building is ever added via `characters.json` / `BUILDINGS`, the interior is empty until someone hand-writes a fixture set. Same "manifest should drive everything" concern as other sections but scoped to interior design, so impact is cosmetic.

### 20. `config.js` CSS-variable color read is unvalidated (P3)

`config.js:243-253` (`getCharacterColor`). Reads `--color-<charId>` from the stylesheet. If `charId` contains CSS-meaningful characters (already-flagged drift in other places: `"/../admin"`, etc.) the CSS selector math can behave unexpectedly. Low-impact because the manifest gates `charId`.

## Non-issues / good choices
- Character list driven from `/api/characters` via `BootScene` — the right approach (unlike `laintown-telemetry.js`).
- Phaser `add.text()` is canvas-rendered; LLM-authored dialogue in speech bubbles CANNOT be XSS-executed.
- `DialogSystem` uses Phaser text primitives, not DOM innerHTML — clean.
- SSE reconnect code in `APIClient.js` at least exists (even if fixed-interval).
- `PossessionManager` state machine is small and reasonable.
- `pathfinding.js` A* is textbook correct; the iteration cap is the only gap.
- No `eval`, no `new Function`, no `document.write` anywhere in the game codebase.
- No `postMessage` / cross-origin IPC — nothing to validate.

## Findings to lift
- **P2**: Character-manifest ordering determines default player (`Object.keys(CHARACTERS)[0]` fallback) — silent drift on manifest reorder.
- **P2**: Chat-history module-level store in `DialogScene.js` grows without bound.
- **P2**: SSE reconnects use fixed delays (no exponential backoff) — inconsistent with non-game frontend.
- **P2**: Pathfinding A* has no iteration cap.
- **P2**: SSE event handlers accept events without shape validation (`speakerId`/`fromId` in particular — amplifies Section 9 body-asserted-identity vulnerability into the game UI).
- **P2**: Possession-move and object-refresh silent-fail on API errors; no operator signal.
- **P2**: Possession start is not awaited before dialog-open is allowed.
- **P2**: `fixtures.js` hardcodes building interiors — cosmetic manifest drift.
- **P3**: Dead code in TitleScene + BootScene.

## Verdict
Phaser canvas-rendering eliminates the innerHTML-based XSS vectors that plague the non-game frontend — this is the game's biggest inherent security win. The correctness issues are all of the "silent-fail on network errors" family: every API helper either ignores failure or logs without user feedback. A player on a flaky connection has no way to know whether movement, chat, or object loading is actually happening. The character-manifest fallback via `Object.keys()[0]` and the `fixtures.js` hardcode are the same drift-on-succession pattern flagged throughout Sections 7–10. Dead-code in TitleScene (~50 lines) and BootScene (`_regenerateTileTextures`) should be excised.
