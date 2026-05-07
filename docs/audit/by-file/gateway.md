---
file: src/gateway/{auth,rate-limiter,router,server,index}.ts
lines: 106 + 167 + 232 + 349 + 38 = 892
purpose: Unix-domain-socket JSON-RPC gateway. Single admin process accepts local-only connections, authenticates via shared token, rate-limits, routes to method handlers (ping/echo/status/setAgent/chat). `chat` routes to the agent `processMessage` pipeline.
section: 10 (gateway + channels)
audit-date: 2026-04-19
---

# gateway/ (consolidated)

Files: `auth.ts` (3 fns + cache stub), `rate-limiter.ts` (7 fns), `router.ts` (3 exports + 4 built-in method handlers + chat handler), `server.ts` (10 fns), `index.ts` (barrel, 0 findings).

## Function inventory
- `auth.ts`: `refreshTokenCache()`, `authenticate(id, token)`, `isAuthenticated(id)`, `getConnection(id)`, `setConnectionAgent(id, agentId)`, `deauthenticate(id)`, `getAuthenticatedConnections()`, `getAuthenticatedConnectionCount()`, `clearAuthentications()`
- `rate-limiter.ts`: `configureRateLimiter(cfg)`, `canConnect()`, `registerConnection(id)`, `unregisterConnection(id)`, `canRequest(id)`, `getRateLimitStatus(id)`, `resetRateLimiter()`, `getConnectionCount()`
- `router.ts`: `registerMethod(name, handler)`, `unregisterMethod(name)`, `handleMessage(id, msg, requireAuth)`, `handleAuth(id, msg)`, `createErrorResponse(id, code, msg, data?)`, `registerChatMethod()`, plus built-ins: `ping`, `echo`, `status`, `setAgent`
- `server.ts`: `startServer(cfg, opts?)`, `stopServer()`, `isServerRunning()`, `getServerStatus()`, `getServerPid(pidFile)`, `isProcessRunning(pid)`, `handleConnection(socket)`, `processMessage(id, socket, data)`, `sendResponse(socket, response)`, `broadcast(message)`

## Findings

### 1. `chat` handler hardcodes a single-tenant sessionKey — multi-client memory contamination (P2)

`router.ts:216`. Every call to the gateway's `chat` method runs:

```ts
sessionKey: 'cli:cli-user',
peerId: 'cli-user',
senderId: 'cli-user',
```

The `connection.agentId` set via `setAgent` is **never read** by the chat handler. Multiple clients that connect to the gateway over the Unix socket all pile into a single `cli:cli-user` session: their conversation memory, visitor-memory extraction, relationship-model updates, and token-budget attribution all collapse into one identity. Cross-user leakage through `processMessage`'s memory-enhanced system prompt is the actual impact — one user's chat becomes another user's context.

**Fix:** key `sessionKey` off `connection.agentId` (or a stable per-connection identity) and plumb it through. Today the gateway is effectively single-tenant by convention, with no code signal that it's single-tenant.

### 2. `setConnectionAgent` is a dead handshake (P2)

`router.ts:180`. Exposed as the `setAgent` method. Sets `connection.agentId` on the auth record. Nothing else in the gateway reads this field. The only other mention is `handleMessage` which never inspects `getConnection(id)`. Either wire it into the `chat` handler's sessionKey (see finding #1) or remove it.

### 3. `refreshTokenCache()` is a no-op placeholder (P3)

`auth.ts:15-18`. Reads `getAuthToken()` and discards the result — comment even says "placeholder for future optimization." Exported through the module barrel so it's part of the public API. If anyone imports it expecting actual cache refresh they get silent wrong behavior.

**Fix:** delete it, or implement actual caching with invalidation.

### 4. `canConnect` increments the global counter before checking auth — unauth'd connection attempts eat the budget (P2)

`rate-limiter.ts:42-60`, called from `server.ts:210`. Flow:
1. New TCP/Unix-socket connection arrives.
2. `canConnect()` runs first — increments `globalConnectionCount` even if the caller never sends a valid auth message.
3. Unauth'd spammer opens 60 connections per minute, sends nothing, and locks out legitimate connection attempts until the window rolls.

Compounded because the counter is global (not per-remote-credential) — can't lock out just the attacker.

**Fix:** either roll back the increment on auth failure / socket close, or key the rate limit on remote-identifier when available.

### 5. Request rate-limiter returns `retryAfter: 1` forever on missing registration (P2)

`rate-limiter.ts:88-91`. If `canRequest(connectionId)` is ever called for an ID that wasn't registered, the function returns `{allowed: false, retryAfter: 1}`. In the current flow `registerConnection` runs synchronously after `canConnect` in `handleConnection`, so this path is unreachable — but the handler fails silently rather than visibly. Any future refactor that runs message processing before connection registration sees innocent clients stuck in a 1-second retry loop with no operator signal.

**Fix:** return a distinct error (`CONNECTION_NOT_REGISTERED`) or log-once.

### 6. `maxMessageLength: 100000` is a buffer-accumulation cap, not a per-message cap (P2)

`server.ts:238-251`. `buffer += data.toString()` then checks `buffer.length > state.maxMessageLength`. Implications:
- Accumulating many small messages without a newline (malformed client) crosses the threshold and drops the connection — even if no individual message is large. Denial-of-self for a stuck parser.
- A single 100KB legit message that arrives in two chunks where chunk-1 is 99KB + chunk-2 is 5KB (before a newline) triggers the check.

The check fires on cumulative received bytes since the last `buffer = lines.pop()` reset. The per-message intent is clearer if the length is asserted AFTER `split('\n')` on each line.

**Fix:** per-line length check; document the buffer accumulation semantic if kept.

### 7. `authenticate` stores no identity or token fingerprint — no audit trail (P2)

`auth.ts:23-51`. `AuthenticatedConnection` holds `id`, `authenticatedAt`, and `rateLimit`. There's no identity information (who authenticated? with which token? from what source?). Multi-operator environments can't tell "operator Alice vs operator Bob." Rotating tokens gives no grandfathering path.

**Fix:** optional operator label in the token payload (keyed token scheme, not just a single shared token); record it on the auth record; log on authenticate.

### 8. No session TTL; `authenticatedConnections` Map only cleaned on close/error events (P2)

`auth.ts:10`. Socket close / error call `deauthenticate`. Process SIGKILL or OOM on the peer leaves no signal to the gateway — the entry sits until process restart. Running a monitor / health-checker that opens-and-drops connections indefinitely grows the Map without bound.

**Fix:** periodic sweep on `authenticatedAt + TTL < now`, or idle-time tracking via last-activity on the socket.

### 9. Rate-limit bypass via many connections (P2)

`rate-limiter.ts` is per-connectionId for request rate, global for connect rate. A single authenticated operator can open N connections and multiply their effective `requestsPerSecond` by N. If the gateway is trusted-local this is tolerable; if the Unix socket is ever exposed (permissive `socketPermissions`, shared-home multi-user host) it's a DoS primitive.

**Fix:** group per-auth-token or per-agentId request rate limits in addition to per-connection.

### 10. `broadcast` writes to every socket regardless of auth status (P2)

`server.ts:337-344`. Iterates `state.connections.values()` — includes unauthenticated sockets still in the pre-auth grace period. If any broadcast ever carries sensitive state (token-usage telemetry, error details), it leaks to pre-auth listeners.

**Fix:** iterate `getAuthenticatedConnections()` for sensitive broadcasts; keep the current helper as `broadcastAll` for auth-gated protocol messages.

### 11. `stopServer` doesn't drain in-flight requests (P3)

`server.ts:101`. `socket.destroy()` on every connection, then closes the server. Requests actively being processed (`processMessage` await chain) have their reply discarded. For the gateway's workload this is rarely a problem — but returns empty results rather than graceful "server shutting down" to any client with a pending chat request.

### 12. Socket file permissions set after listen (`chmod` after `listen`) — race window (P2)

`server.ts:81-89`. `listen()` creates the socket file with default umask (often `0666` or `0777` effective), then `chmod(config.socketPath, config.socketPermissions)` tightens it. A concurrent process can `connect()` to the socket during this window with inherited permissive mode.

**Fix:** set process umask before listen, or bind to a path inside a 0700 directory.

### 13. PID file is written unconditionally, never validated against a prior instance (P2)

`server.ts:92`. No check for stale PID files. On crashed prior run, the PID file is silently overwritten — but the "already running" check elsewhere would have falsely-succeeded against the stale PID (`isProcessRunning` returns true for any PID that happens to be assigned to another process now).

**Fix:** use `O_EXCL` creation, detect collision, validate PID belongs to us before overwriting.

## Non-issues / good choices
- `secureCompare` used for token comparison (constant-time).
- Rate limiter configuration separated from enforcement.
- Auth method always allowed — avoids the chicken-and-egg of needing auth to auth.
- Method registry is pluggable and testable via `registerMethod` / `unregisterMethod`.
- JSON-RPC-ish shape with `id` correlation is straightforward to test.
- `handleConnection` wires both `close` and `error` to the same cleanup path.

## Findings to lift
- **P2**: `chat` handler hardcodes single-tenant `cli:cli-user` sessionKey; `setAgent` is a dead handshake; cross-client memory contamination primitive in a multi-client context.
- **P2**: `canConnect` increments counter before auth — unauth'd DoS on connection budget.
- **P2**: `maxMessageLength` is a buffer-accumulation cap, not per-message.
- **P2**: No session TTL; no identity recording on auth.

## Verdict
Competent admin gateway over Unix socket. Single-process, single-tenant by design; the `cli:cli-user` hardcode and the unused `agentId` field both confirm the single-tenant assumption was never lifted. Code quality is consistent with the rest of the codebase — careful error paths, tests, constant-time comparison. The gaps are architectural (no multi-tenant model, no per-operator identity) rather than code bugs.
