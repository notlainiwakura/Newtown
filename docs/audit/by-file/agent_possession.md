---
file: src/agent/possession.ts
lines: 261
purpose: Single-player possession state machine. Stops all background loops when a player takes control; restarts them on release. Queues peer messages as pending (60s auto-timeout); idle-releases after 5 min. Uses POSSESSION_TOKEN env var for auth.
section: 8 (agent loops)
audit-date: 2026-04-19
---

# agent/possession.ts

## Function inventory (13)
- `isPossessed()` — 48: exported.
- `touchActivity()` — 56: exported.
- `startIdleTimer()` / `stopIdleTimer()` — 60, 71.
- `getPossessionState()` — 78: exported.
- `startPossession(sessionId, stops, restarters)` — 90: exported.
- `endPossession()` — 116: exported.
- `addPendingPeerMessage(fromId, fromName, message)` — 151: exported; returns Promise.
- `getPendingPeerMessages()` — 188: exported.
- `resolvePendingMessage(fromId, response)` — 201: exported.
- `removePendingMessage(fromId)` — 212.
- `verifyPossessionAuth(authHeader)` — 222: exported; uses secureCompare.
- `addSSEClient` / `removeSSEClient` / `broadcastSSE` / `broadcastMovement` — 233-253.
- `getActiveLoopStops()` — 259: exported.

## Findings

### 1. Module-level mutable `state` is a process-wide singleton (P2)

Lines 32-42. Single `state` object governs possession for the entire process. Comment at line 4 confirms single-player only, no persistence. This is correct design for single-player — but fragile if a future change introduces multi-player:
- `pendingPeerMessages` is a flat array keyed only by `fromId`; multi-possession would race on `resolvePendingMessage` (line 202 `findIndex`).
- `sseClients` is a single Set; fine for broadcast but no scoping.

Not a bug today. Flag for future-proofing.

### 2. `startPossession` — if already possessed, silently ignores new request (P2)

Line 95: `if (state.isPossessed) return;`. No auth check BEFORE this gate — so a caller with wrong token won't even be rejected, they'll just get a silent no-op. Only the calling HTTP handler (in character-server probably) needs to enforce auth — to verify in that audit.

If caller forgot to check `verifyPossessionAuth`, a malicious actor could attempt `startPossession` and get no feedback. Not a new auth hole but worth flagging to the caller.

### 3. Pending message resolve keyed by `fromId` only — duplicate senders collide (P2)

Line 202: `findIndex((p) => p.fromId === fromId)`. If peer A sends two messages in quick succession while possessed, both land in the queue. Player replies — `resolvePendingMessage('A', response)` resolves the FIRST one. Player replies again — resolves the second. Works if player sees them serially, but `getPendingPeerMessages` (line 188) returns both simultaneously with no unique handle. Player UI has to assume order.

Fragile. A unique message ID per queue entry would be cleaner. In practice peer messages are 3-round commune conversations, so races are unlikely.

### 4. `PENDING_TIMEOUT_MS = 60_000` auto-responds with "..." (P3)

Line 44. If player is possessed but takes > 60s to reply, the peer gets "...". The LLM on the peer side treats "..." as a legitimate response — commune-loop's `sendPeerMessage` returns it (line 533), appends to transcript, feeds to reflection, etc. Possessed-Lain's "..." shapes the peer's subsequent conversation.

Acceptable design choice but worth observing — the silence has semantic weight in peer memory.

### 5. `endPossession` restarts loops via `loopRestarters` closures (P2)

Lines 127-132. Each restarter returns a new stop function. The restarters must themselves be pure — if a restarter has captured state that changed during possession, restart might fail.

**Specifically**: if possession was long enough that some time-based state is stale (e.g., `last_run_at` meta values), the restarted loops may fire immediately on startup, producing a burst of catch-up cycles. Might DoS the provider.

### 6. Idle timer interval is 30s, threshold is 5 min — up to 30s lag on release (P3)

Lines 44-46, 68. After 5 min of no activity, next check fires up to 30s later, so real idle timeout is 5m0s-5m30s. Fine.

### 7. `POSSESSION_TOKEN` env var is snapshotted by caller in tests but read fresh in `verifyPossessionAuth` (positive)

Line 223: `process.env['POSSESSION_TOKEN']`. Read each call — not module-load snapshot. Contrast with letter.ts DEFAULT_CONFIG.

### 8. `secureCompare` on token (positive)

Line 228. Constant-time comparison — defends against timing oracles. Good.

### 9. `broadcastSSE` silently evicts failed clients (positive, line 246)

Good housekeeping.

### 10. `clearInterval` on `setInterval`-typed idleTimer (line 73) + `clearTimeout` on `setTimeout`-typed timeoutHandle (line 121, 206) — correct (positive)

Node accepts both calls interchangeably but the typed split prevents confusion.

### 11. `state.playerSessionId` never validated against resume attempts (P3)

`startPossession` doesn't check if the new sessionId matches or differs from a previous one; it just fails silent on already-possessed. If the player's session cookie rotates, they can't "resume" possession — they'd have to wait for idle timeout first.

### 12. Console.log used for critical state transitions (P3)

Lines 65, 110, 144. Using `console.log` directly rather than the project's `getLogger()` — inconsistent with rest of agent/. Logs don't flow through the structured logger or level filters.

## Non-issues / good choices
- Clean state-machine semantics with explicit start/end transitions.
- Idle timer prevents stuck possession.
- Pending-message auto-timeout prevents peer hangs.
- SSE broadcast for real-time UI updates.
- `secureCompare` for token comparison.
- Promise-based pending-message API is ergonomic.
- Explicit `loopRestarters` contract prevents ad-hoc restart logic elsewhere.

## Findings to lift
- **P2**: Duplicate-sender pending message races (fromId collision).
- **P2**: Restart-burst risk after long possession (loops fire catch-up cycles).
- **P2**: Module-level singleton `state` — fragile if multi-player ever introduced.
- **P3**: Console.log instead of getLogger.
- **P3**: 60s auto-"..." shapes peer conversation with semantic silence.

## Verdict
Tight, purpose-built state machine. Main concerns are fragility of assumptions (single-player, unique fromId per pending) and the restart-burst risk. Security posture is solid — secureCompare, fresh env reads, explicit auth gate. The file does what it says.
