# `src/types/gateway.ts`

Gateway Unix-socket wire types + JSON-RPC-style error code constants. 6 interfaces + 1 const object.

## Interfaces

- `GatewayMessage` — `{ id, method, params? }`
- `GatewayResponse` — `{ id, result?, error? }` (XOR at semantic level, not enforced by type)
- `GatewayErrorPayload` — `{ code: number, message: string, data? }`
- `AuthenticatedConnection` — `{ id, authenticatedAt, agentId?, rateLimit }`
- `ConnectionRateLimit` — `{ requestCount, windowStart, blocked, blockedUntil? }`
- `GatewayStatus` — `{ running, pid?, uptime?, connections, socketPath }`

## Const

```ts
GatewayErrorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  UNAUTHORIZED: -32000,
  RATE_LIMITED: -32001,
  MESSAGE_TOO_LARGE: -32002,
  AGENT_NOT_FOUND: -32003,
} as const
```

## Gaps / bugs

- **`GatewayResponse.result` is `unknown`.** Every caller must runtime-check shape. This is what let `chat.ts` do `'authenticated' in response.result` — a whole class of bugs the type system could prevent if `result` were a discriminated union per-method. **P2** — lift, ties directly to the already-lifted `chat.ts` auth finding.
- **No request/response correlation at the type level.** `id` strings match request → response but nothing forces the correlation in code. Gateway router could (and should) tie `id` to a per-method response schema. **P2** (same finding).
- **`ConnectionRateLimit.blocked` as boolean is redundant** when you have `blockedUntil?`. Can be derived. **P3**.
- **No `TIMEOUT` error code.** If a gateway method times out (future feature), it falls into `INTERNAL_ERROR` and loses semantics. **P3**.
- **`GatewayMessage.params?` as `Record<string, unknown>`** is schemaless. Gateway audit needs to verify params validation happens per-method at the router. Defer.

---

## File-level notes

- JSON-RPC compliance: code ranges are correct (`-32000..-32099` for server errors). Custom codes are valid.
- `AuthenticatedConnection.agentId?` is optional — a connected-but-not-chat socket is valid (e.g. status query). Good.

## Verdict

**Lift to findings.md:**
- P2: `GatewayResponse.result` is `unknown`. No per-method type correlation. Enables whole-class bugs (already seen in `chat.ts` auth check). Fix: per-method discriminated union + router-level schema validation.
