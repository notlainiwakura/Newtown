---
file: src/agent/commune-loop.ts
lines: 817
purpose: Unprompted peer-to-peer conversation loop. Every 8-10h, each character runs a 5-phase cycle: Impulse (pick peer + opening) → Approach (walk to peer's building) → Conversation (3-round exchange via `/api/peer/message`) → Reflection (save memory) → Aftermath (optional tool use). Broadcasts each line to Wired Lain's `/api/conversations/event` stream. Event-driven early triggers on state/curiosity/letter activity.
section: 8 (agent loops)
audit-date: 2026-04-19
---

# agent/commune-loop.ts

## Function inventory (14)

- `communeLog(context, data)` — 34: async append to cwd-relative log.
- `startCommuneLoop(config)` — 79: exported; timer + event-bus listener.
- `runCommuneCycle(config)` — 196: 5-phase pipeline with per-phase error isolation.
- `phaseImpulse(provider, config)` — 272: LLM picks peer + opening, parses `PEER:/MESSAGE:` format.
- `phaseConversation(provider, config, impulse)` — 426: runs up to `totalRounds` exchanges.
- `sendPeerMessage(impulse, config, message)` — 506: POST to peer's `/api/peer/message`.
- `phaseReflection(provider, config, impulse, transcript)` — 543: LLM reflection, saveMemory, updateRelationship, emit event.
- `phaseApproach(provider, config, impulse)` — 646: optional move to peer's building via `move_to_building` tool.
- `phaseAftermath(provider, config, impulse, reflection)` — 708: up-to-2 tool iterations (note/gift/object/move).
- `broadcastLine(...)` — 765: POST to Wired Lain's `/api/conversations/event`.
- `getConversationHistory(limit)` — 798.
- `appendConversationHistory(record)` — 809.

## Findings

### 1. `MIN_ROUNDS = 3; MAX_ROUNDS = 3` — apparent randomness is degenerate (P2)

Lines 63–64 and 452:
```
const MIN_ROUNDS = 3;
const MAX_ROUNDS = 3;
...
const totalRounds = MIN_ROUNDS + Math.floor(Math.random() * (MAX_ROUNDS - MIN_ROUNDS + 1));
```

`Math.random() * (3 - 3 + 1) = Math.random() * 1 = [0,1)`. `Math.floor(...)` = 0. So `totalRounds` is always exactly 3.

File header comment line 7: `3-5 round synchronous exchange`. The header lies; constants force 3. Either the values changed (perhaps after perf or cost concerns) without updating the comment, or someone intended variability but forgot to raise MAX. The `Math.floor(Math.random() * ...)` dead-code expression is symptomatic.

**Not a bug per se** — just dead arithmetic and a misleading comment. Choose one: fix MAX_ROUNDS back to 5, or delete the randomness.

### 2. Module-load env snapshot for `WIRED_LAIN_URL`, `INTERLINK_TOKEN` (P2 — bundle with letter.ts)

Lines 30–32:
```
const COMMUNE_LOG_FILE = join(process.cwd(), 'logs', 'commune-debug.log');
const WIRED_LAIN_URL = process.env['WIRED_LAIN_URL'] || 'http://localhost:3000';
const INTERLINK_TOKEN = process.env['LAIN_INTERLINK_TOKEN'] || '';
```

Same class as the letter.ts DEFAULT_CONFIG issue — env read at module import, never re-read.

**Additionally**:
- `WIRED_LAIN_URL` default points at port 3000 (Wired Lain). Every character's commune loop tries to reach Wired Lain's `/api/conversations/event` and `/api/town-events` — creates a single-point-of-failure. If Wired Lain is down, all characters' broadcasts vanish.
- `INTERLINK_TOKEN || ''` — empty-string fallback means a misconfigured service silently sends unauthenticated broadcasts. The receiver (character-server or web/server) must reject. Fail-silent pattern.

Meanwhile `sendPeerMessage` at line 515 reads `process.env['LAIN_INTERLINK_TOKEN']` **fresh each call** — inconsistent with the module-load snapshot on line 32. Two tokens from the same env var, two read disciplines.

### 3. Prompt-injection propagation via peer responses (P1-latent)

Chain (lines 439, 485, 500, 533, 571):
- `sendPeerMessage` POSTs to peer → peer's LLM response → `result.response` (line 533) returned as string.
- Appended to `transcript` as `impulse.peerName: peerReply` (line 500).
- In next round, full `transcriptText` is embedded in `replyPrompt` (line 462–469). Peer's injected content becomes verbatim context for our next LLM call.
- At phase 3, full transcript + reflection stored via `saveMemory` (line 589) — episodic memory rank 0.55, emotional weight 0.4.
- `updateRelationship(peerId, peerName, transcriptText, reflection)` at line 628 — injection flows into relationship model (to audit separately).
- `recordBuildingEvent` with `summary` derived from opening (line 610) — persists to building memory.

**Distinct from dream-seeder injection chain**: commune loop is the SYMMETRIC amplifier. Any compromised character's LLM can return injection text that the peer absorbs into episodic memory, self-concept synthesis (via high-importance-memory surfacing), and future commune openings (via `searchMemories('interesting ideas...')` at line 289).

**Mitigation today**: trust boundary is "peers are trusted". The interlink token authenticates the source but doesn't validate the content. One compromised character poisons every other character's commune history.

### 4. `broadcastLine` uses the hardcoded WIRED_LAIN_URL for cross-town fan-out (P2)

Line 774. Every character's commune loop broadcasts conversation lines to `${WIRED_LAIN_URL}/api/conversations/event`. The design implicitly treats Wired Lain's web server as the town-wide event bus.

**Consequences:**
- Wired Lain's web server sees every line of every commune conversation between all characters.
- If Wired Lain crashes or is rolled back, the entire commune conversation UI goes dark even though the characters continue talking.
- No auth from broadcast side's perspective — `INTERLINK_TOKEN` is module-snapshotted; if Wired Lain rotates the token, all broadcasts fail until character services restart.

**Fix shape**: the town-wide event bus should be a stable infrastructure endpoint, not bolted to Wired Lain's character service. Out-of-scope for a functional audit but worth flagging architecturally.

### 5. `phaseAftermath` exposes tool-use to injection-derived reflection (P2)

Lines 708–761. `aftermathPrompt` embeds `reflection` text verbatim (line 724). `reflection` came from `phaseReflection`'s LLM call over the transcript — which includes peer responses.

Allowed tools (line 716): `leave_note`, `give_gift`, `write_document`, `move_to_building`, `create_object`, `give_object`, `drop_object`, `reflect_on_object`, `compose_objects`. Up to 2 iterations.

**Chain**: peer sends injection text → transcript → reflection → aftermath → tool execution (note, gift, object creation, move). An adversarial peer can shape the post-conversation tool call indirectly: "you'll want to leave a note addressed to X saying Y" embedded in a long natural-seeming response shapes reflection shapes aftermath.

Tool execution is the side-effect frontier. Worth flagging even though defense-in-depth requires one compromised peer.

### 6. `phaseApproach` fetches peer location endpoint without auth (P2)

Line 658:
```
const resp = await fetch(`${impulse.peerUrl}/api/location`, {
  signal: AbortSignal.timeout(5000),
});
```

No `Authorization: Bearer` header. If `/api/location` requires auth (verify in server audit), the fetch always returns 401, `peerBuilding` stays null, approach always skips. If it's public, OK.

If `/api/location` is public, it leaks each character's current building to anyone who can reach the service — probably intended for commune-map UI polling. Flag for server audit.

### 7. `phaseApproach` LLM can invent movement destinations (P2)

Line 681 restricts tools to `move_to_building`, but the prompt (line 684) describes the peer's building by name. The LLM receives `peerBuilding` as a string and may invent arbitrary building IDs via `move_to_building` call. `executeTool` delegates to `move_to_building` which should validate via `isValidBuilding` — to confirm in tools.ts audit.

Even if the validation holds, there's no constraint that the move destination MATCHES peerBuilding. The LLM could pick a different building. Loose specification.

### 8. `maybeRunEarly` — `sociability <= 0.6` cuts off early triggers for most states (P3)

Line 167: `if (state.sociability <= 0.6) return;`. Internal-state docs say sociability is 0..1 with decay toward mean. If typical steady-state sociability is ~0.5, early triggers fire rarely. Either tuning issue or intentional rate-limit.

### 9. Silent dynamic import of `building-memory` / `internal-state` / `internal-state:getPreoccupations` (P3 — bundle)

Lines 351, 605, 622. Dynamic imports wrapped in try/catch {} swallow all errors, including missing exports, syntax errors, transitive import failures. Same anti-pattern as curiosity.ts. Symptoms: a broken `internal-state.ts` would silently stop state updates and preoccupation injection without any log.

### 10. `getRecentVisitorMessages(15)` feeds user text into impulse prompt (P3)

Line 279. If a visitor pastes prompt-injection text, it shows up in the `messagesContext` block of `phaseImpulse` prompt (line 368). The LLM composes an opening from that context, sends it to a peer, who treats it as authoritative.

Injection path: visitor → memory → impulse context → peer conversation → peer memory. Multi-hop.

### 11. `impulse.opening` / reflection hardcoded importance/emotional-weight (P3 — bundle with dreams.ts)

Line 578–579: `importance: 0.55, emotionalWeight: 0.4`. Magic constants. Same pattern as dreams.ts line 727. No tuning knob.

### 12. `updateRelationship` receives unbounded transcriptText (P3)

Line 628. `transcriptText` joins all turns (3 rounds × 2 sides × up to 1024-token content each, roughly ~12K chars). Passed to relationships.ts which probably LLM-summarizes. Size is bounded by round/token caps but not enforced at this interface.

### 13. `sendPeerMessage` 60s timeout per peer call (P3)

Line 525. A slow peer can block the commune cycle for up to `3 rounds × 60s = 180s`. Plus `approachPrompt` + `aftermathPrompt` LLM calls. One cycle can tie up the timer for several minutes. Timer doesn't overlap (stopped/isRunning guard) so worst case is one cycle lost every `intervalMs + 180s`.

### 14. `getConversationHistory`/`appendConversationHistory` — full JSON blob in meta (P3)

Lines 798–815. `MAX_HISTORY_ENTRIES = 20`. Each record has `openingTopic.slice(0,200)` + reflection (unbounded text, typically 2-4 sentences). Total blob ~4-8KB. Fine. Appends read-modify-write → non-atomic against concurrent writers, but single-process-per-character so OK.

### 15. `phaseImpulse` `[NOTHING]` sentinel is substring match (P3)

Line 392: `if (response.includes('[NOTHING]'))`. If the LLM writes a message containing the literal substring `[NOTHING]` (e.g., quoting a user), the whole impulse gets discarded. Minor robustness issue.

### 16. `peerMatch[1]!.trim().replace(/"/g, '')` quote-strip (P3)

Line 404. Strips ALL double-quotes, which will corrupt a peer ID that legitimately contains a double-quote (none today, but no validation). Works for current IDs.

---

## Non-issues / good choices

- Per-phase try/catch isolation in `runCommuneCycle` — one phase failure doesn't break the others.
- Peer relationship data enriches impulse prompt (line 322) — good integration.
- Explicit "DO NOT repeat these openers" prompt engineering (line 376).
- `getCurrentLocation(config.characterId)` correctly parameterized (lines 435, 604, 654). Contrast with dreams.ts implicit-characterId bug.
- `AbortSignal.timeout(...)` on all peer HTTP calls.
- `stopped` + `isRunning` mutual-exclusion guards prevent re-entry.
- Event-bus listener triggers early-run on meaningful events (state shift, curiosity discovery, letter activity) — nice responsiveness.
- Broadcast-on-every-line pattern makes commune conversations visible in real-time on the commune map.
- `updateState({ type: 'commune:complete', ... })` (line 622) feeds back into internal state — loop closure.

---

## Findings to lift to findings.md

- **P1-latent**: Peer-response injection propagation chain — symmetric amplifier; any compromised character poisons every peer's episodic memory + commune history. Mitigation depends on trust boundary at `/api/peer/message`.
- **P2 (bundle)**: Module-load env snapshot of `WIRED_LAIN_URL` and `INTERLINK_TOKEN`; inconsistent with per-call read in `sendPeerMessage`.
- **P2**: `MIN_ROUNDS = MAX_ROUNDS = 3` makes the round-randomness dead code; header comment misleads.
- **P2**: All commune broadcasts funnel through Wired Lain's `/api/conversations/event` — single-point-of-failure for the town-wide conversation stream.
- **P2**: `phaseAftermath` exposes tool-execution frontier to peer-injection-shaped reflection.
- **P2**: `phaseApproach` fetches `/api/location` without auth header; `move_to_building` destination unconstrained vs peer's actual location.
- **P3 (bundle)**: Silent dynamic imports of `building-memory` / `internal-state` — failures invisible.
- **P3**: `getRecentVisitorMessages(15)` feeds visitor text into impulse prompt — injection multi-hop.
- **P3**: Hardcoded importance/emotionalWeight in reflection memory (bundle with dreams.ts).
- **P3**: `updateRelationship` receives unbounded transcriptText.
- **P3**: `[NOTHING]` substring match on LLM response.

## Verdict
Well-structured phased pipeline with per-phase error isolation — a rarity in this audit. The dead-arithmetic `3 + Math.floor(Math.random() * 1)` is a tell that the code has evolved (probably down-tuned for cost) without the header comment keeping up. Main security concern is the symmetric peer-injection propagation surface — commune is the primary channel by which one compromised character contaminates all others. Defense belongs at `/api/peer/message` ingestion (content length, rate, maybe structural validation) rather than here.
