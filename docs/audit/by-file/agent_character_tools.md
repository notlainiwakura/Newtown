---
file: src/agent/character-tools.ts
lines: 986
exports: 1 (registerCharacterTools) + PeerConfig type
---

# `src/agent/character-tools.ts`

Commune-specific tool pack. `registerCharacterTools(characterId, characterName, wiredLainUrl, interlinkToken, peers)` installs 14 tools: research_request, send_peer_message, move_to_building, leave_note, write_document, read_document, give_gift, create_object, examine_objects, pickup_object, drop_object, give_object, destroy_object, reflect_on_object, compose_objects.

**Architectural observation:** the function signature accepts `interlinkToken` as a parameter but SOME tools use the parameter while OTHERS re-read from `process.env['LAIN_INTERLINK_TOKEN']` at call time — see inconsistency note below.

## Cross-cutting

### `interlinkToken` handling inconsistency

| Tool | Source of interlink token |
|---|---|
| `research_request` (line 75) | **param** `interlinkToken` ✓ |
| `send_peer_message` (line 139) | `process.env['LAIN_INTERLINK_TOKEN'] \|\| ''` ✗ |
| `give_gift` (line 434) | `process.env['LAIN_INTERLINK_TOKEN'] \|\| ''` ✗ |
| `create_object` (line 502) | **param** `interlinkToken` ✓ |
| `pickup_object` (line 627) | **param** `interlinkToken` ✓ |
| `drop_object` (line 680) | **param** `interlinkToken` ✓ |
| `give_object` (line 729) | `process.env['LAIN_INTERLINK_TOKEN'] \|\| ''` ✗ |
| `destroy_object` (line 815) | **param** `interlinkToken` ✓ |

Three tools (`send_peer_message`, `give_gift`, `give_object`) ignore the parameter and re-read env directly. Caller passing a non-default token is partially effective — object-related calls use the override, peer-messaging calls do not. If a future test harness or deployment passes a custom token via `registerCharacterTools(..., 'custom-token', ...)`, three tools bypass it.

**Empty-string fallback** (`|| ''`): if `LAIN_INTERLINK_TOKEN` is missing, the three inconsistent tools still construct `'Authorization: Bearer '` with an empty token. The peer server rejects with 401 → the tool returns a soft failure message. Same pattern as `building-memory.ts` and `providers/index.ts`. **P2 — lift**: `send_peer_message`, `give_gift`, `give_object` re-read `LAIN_INTERLINK_TOKEN` from env at call time (falling back to empty string) instead of using the `interlinkToken` parameter passed to `registerCharacterTools`. This creates (a) inconsistency — some tools honor the registration-time token, others don't; (b) a silent-401 failure mode when env is unset, since empty Bearer tokens pass syntactically. Fix by using the parameter consistently and raising on empty at registration time.

### `wiredLainUrl` default and coupling

All object tools POST/GET to `${wiredLainUrl}/api/objects/...`. `move_to_building` also reads `${process.env['WIRED_LAIN_URL'] || 'http://localhost:3000'}/api/town-events/effects` at line 205 — bypassing the parameter and re-reading env. Another inconsistency. **P3** — bundled with above.

### `replyTo` hardcoded to localhost

Line 83 in `research_request`:
```
replyTo: `http://localhost:${process.env['PORT'] || '3003'}`
```

The reply is Wired Lain posting back to THIS character's server. Assumes Wired Lain and this character are on the same host (`localhost`). Works on the current droplet (all services on one machine), breaks the instant any character is moved to a separate host. **P2 — lift**: `research_request.replyTo` hardcodes `http://localhost:${PORT}` as the return address for Wired Lain's response. Breaks on multi-host deployments where characters run on separate machines. Construct from a per-character `CHARACTER_PUBLIC_URL` env var with manifest-aware default.

Additionally, `PORT` env var is optional — if unset, falls back to 3003, which is McKenna's port on the current deployment. Any character without a PORT env will silently claim McKenna's endpoint, and Wired Lain will send the reply to McKenna. **P2 — bundled lift.**

## Tool-by-tool notes

### `research_request`, line 37–103

- Fire-and-respond via Wired Lain's `/api/interlink/research-request`. 30s timeout.
- **Sanitization absent**: `question`, `reason`, `url` all pass through to Wired Lain, who will eventually pass them into her own LLM + `fetch_webpage`. An attacker-authored `question` with prompt-injection payload lands in Wired Lain's LLM context, potentially with her elevated-permission tool set. **P2 — lift (cross-cutting)**: `research_request` forwards LLM-authored `question`/`reason`/`url` to Wired Lain with no sanitization. The payload hits Wired Lain's LLM, which has unrestricted `fetch_webpage` — full SSRF surface via proxy. Bundled with the general "no sanitizer on inter-character content" cross-cutting concern already in findings.
- **`url` optional param unbounded**: can be any string. If Wired Lain doesn't validate, this is an SSRF proxy. See her server audit. **P2** — bundled.
- **Silent error message**: `Could not reach Wired Lain: ${error.message}` — leaks raw fetch error (potentially including full URL + network topology) to the LLM. **P3.**
- **30s timeout is double `view_image`'s** — reasonable for research. **P3.**

### `send_peer_message`, line 106–164

- 60s timeout. Synchronous request-response between peers. OK.
- **Inconsistent token** (see above).
- **`peer_id` validated against `peers` list** at line 132 — good, no arbitrary URL injection.
- **Message content unsanitized**: any LLM-authored string goes directly to another character's `/api/peer/message` endpoint. Receiving character's LLM processes the message as user input. Classic inter-character prompt-injection vector. **P2** — bundled with cross-cutting sanitizer concern.
- **401/other failures**: `${peer.name} didn't respond (${response.status})` — soft message, doesn't distinguish auth from network. **P3.**

### `move_to_building`, line 168–234

- Validates `building` against `isValidBuilding`. Good.
- **Re-reads `WIRED_LAIN_URL` from env** at line 205 (town-events check), bypassing parameter. **P3** — bundled.
- **Town-events fetch failure is silent and fallthroughs to movement** (line 214: `catch { /* continue */ }`). A blocked building stays movable if WL is down; intentional per comment ("don't block movement if event check fails"). OK.
- **`setCurrentLocation(building, reason)` is called WITHOUT `characterId`** — relies on `eventBus.characterId` default. Same red-herring pattern documented in `commune_location.md`. **P2** — bundled.
- **Memory importance hardcoded to 0.3.** Movement decisions are memorized but with minimal weight — OK design. **P3.**
- **Success message says "You walk to the..."** — second-person, breaks character immersion. All these handler messages use "you" — which is fine since they return to the LLM, not the user. The LLM then narrates them in character. **P3.**

### `leave_note`, line 237–288

- **P2 — DESCRIPTION LIES**: The tool description (line 240) reads:
  > "Leave a written note at your current location (or a specified building). Other commune members may discover it during their wanderings."

  Implementation at line 273 saves a memory record in THIS character's LOCAL memory store (`saveMemory` is per-character DB). **No other character can see it.** There is no shared "notes" table, no cross-character query, no write to Wired Lain. A note "left at the library" for Dr-Claude to find… stays in Lain's own database forever, invisible to Dr-Claude.

  The LLM reads the description, leaves a note expecting peers to discover it, and is silently deceived. This propagates into character behavior — e.g. PKD leaves a manifesto at the library assuming Ada will read it, and is wrong forever.

  **Lift — P2**: `leave_note` tool description claims "other commune members may discover it" but implementation only stores the note in the local character's memory DB — no peer can ever read it. Either (a) route through Wired Lain's persistent-object or building-event store so it's actually cross-character queryable, or (b) rewrite the description to match the behavior ("save a note to your own memory about a location").

- `sanitizedTitle` logic doesn't apply here since `leave_note` doesn't take title. **P3.**
- `metadata.author: characterId` is stored — if the note ever WERE routed through a shared store, this would preserve authorship. Design intent present, implementation incomplete. **P2** — bundled.

### `write_document`, line 291–333

- Sanitizes title for `sessionKey` — good.
- **Stored locally only**, just like `leave_note`. But description says *both* "write a document" AND (via `read_document`, below) "read a document written by another commune member." The write path stores locally; the read path queries peers via HTTP. `read_document` at line 336 hits `${peer.url}/api/documents` — so the endpoint must exist on each character server.
- Cross-checking with web server audit (Section 9 — not yet done) — need to verify `/api/documents` endpoint exists on each character. If it does, each peer returns THAT peer's local memory-filtered documents. **P3** — flagged for verification during Section 9.
- **Memory importance 0.5, emotionalWeight 0.2.** OK. **P3.**

### `read_document`, line 336–393

- 10s timeout (lower than most). OK.
- **Truncates content preview to 100 chars** (line 387). Full document fetched but only 100 chars shown in list mode. If the LLM wants full text, it must query again with `title`. Wasteful double-fetch pattern. **P3.**
- **No auth header on fetch** (line 368)! `read_document` fetches peer documents WITHOUT `Authorization: Bearer`. Either the peer's `/api/documents` endpoint is public (privacy leak — any unauthenticated HTTP client can read any character's documents) or the endpoint rejects everything and read_document is quietly broken. Need to verify in Section 9. **P2 — lift candidate pending verification**: `read_document` omits the Authorization header while peer-communication tools require it; either the `/api/documents` endpoint is public (privacy bug) or read_document is silently broken. Verify during Section 9.

### `give_gift`, line 396–472

- Reuses `/api/peer/message` — gift is delivered as a marked message (`[GIFT: ...] ...`). OK design.
- **Re-reads env token** (see P2 above). **Bundled.**
- Saves local memory record. OK.
- **Memory importance 0.5, emotionalWeight 0.4.** OK, matches the emotional significance.
- **No per-recipient rate limit**: LLM could spam gifts. **P3.**

### Object tools: `create_object`, `examine_objects`, `pickup_object`, `drop_object`, `give_object`, `destroy_object`, lines 477–843

- All mediated through Wired Lain's `/api/objects` — central object registry. Same central-store architecture as `building-memory.ts`.
- **Same single-point-of-failure**: if Wired Lain is down, ALL object tools fail. Error messages say "Could not reach the object registry" — honest signal at least, unlike building-memory's silent-swallow. **P2** — bundled with building-memory central-store SPOF.
- **No per-character inventory cap.** An LLM can `create_object` in a loop, polluting the registry with thousands of objects. Throttling would be at the Wired Lain server side. **P3.**
- **Fixture check repeated twice**: `pickup_object` line 610 and `destroy_object` line 797 both fetch the full object record to check `metadata.fixture`. Pattern is fine; could be factored into a helper. **P3.**
- **`give_object` best-effort notification**: line 758 `.catch(() => {})` — the notification fetch is intentionally silent if the peer is offline. Object transfer already succeeded in the registry at that point. OK. **P3.**
- **`reflect_on_object`/`compose_objects`**: require a memory-preset provider (`getProvider('default', 'memory')`). If provider absent, returns "Cannot reflect right now." Graceful. **P3.**
- **`reflect_on_object` ownership check**: re-queries `?owner=characterId` to get inventory, then finds the object by ID. If the object was given away between turns, LLM sees the old reference but the ownership query returns without it → "You don't seem to be carrying an object with ID X" — correct race handling. **P3.**
- **`compose_objects` requires ≥2 objects** (line 933). OK. **P3.**
- **Object destroy**: DELETE `${wiredLainUrl}/api/objects/${objectId}` with `body: JSON.stringify({ characterId })` — note that DELETE requests carrying a body are permissible but some middleware strips them. Need to verify Wired Lain's endpoint accepts this. **P3** — flagged for Section 9.

## File-level notes

- **986-line function.** `registerCharacterTools` is a giant IIFE-shaped registration block. Refactor each tool into its own file (`research_request.ts`, `object_tools.ts`). **P3** — cosmetic.
- **Called from** `src/web/character-server.ts:249` (per grep during tools audit). Only registered when `config.id !== 'lain'` (Lain stays on the Lain-specific toolset). Good scoping. **P3.**
- **Every `fetch` has a timeout.** Good consistency across tools — no infinite-hang surfaces.
- **Memory importance values vary (0.3–0.5).** Acts as a de facto activity-ranking heuristic. No central table of values; inconsistencies possible if another module sets similar memories to 0.7. **P3.**
- **No observability**: handler failures log at `logger.error`/`logger.warn`/`logger.info` but there's no central counter for per-tool failure rates. A gradually-broken peer server (3xx redirect storm, slow responses) appears as sporadic "didn't respond" messages with no aggregation. **P3** — bundled with broader observability.
- **Cycle import**: line 12 imports `getProvider` from `./index.js` (the agent module); `index.ts` does NOT import from `character-tools.ts` (it's registered later), so the cycle is avoided by call ordering. OK. **P3.**

## Verdict

**Lift to findings.md:**

- **P2**: `send_peer_message`, `give_gift`, `give_object` ignore the `interlinkToken` parameter passed to `registerCharacterTools` and re-read `process.env['LAIN_INTERLINK_TOKEN'] || ''` at call time. Creates inconsistency (some tools honor override, others don't) and silent-401 failures when the env var is unset (empty Bearer tokens pass syntactically). Standardize on the registration-time parameter.

- **P2**: `research_request.replyTo` hardcodes `http://localhost:${PORT||3003}` as Wired Lain's return address. Breaks on multi-host deployments; the `3003` default collides with a specific character's port (McKenna's) so any character missing the `PORT` env claims McKenna's endpoint and Wired Lain replies to the wrong character. Construct from a per-character `CHARACTER_PUBLIC_URL` or manifest lookup.

- **P2**: `leave_note` tool description lies to the LLM. The description states "other commune members may discover it during their wanderings," but the implementation only saves a `saveMemory` record in the local character's DB — no peer can ever see it. Either route through Wired Lain's object/building-event store or rewrite the description to match behavior.

- **P2 (pending verification in Section 9)**: `read_document` fetches `${peer.url}/api/documents` without the `Authorization: Bearer` header, while every other peer-to-peer tool requires it. Either the endpoint is publicly readable (unauthenticated access to any character's documents — privacy leak) or the call is silently broken.
