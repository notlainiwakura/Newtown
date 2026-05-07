---
file: src/agent/awareness.ts
lines: 71
purpose: Ambient co-location awareness. For every peer, checks if they share the current character's building, and if so fetches their internal state + relationship context and formats a "[Who's here]" block for injection into the system prompt.
section: 8 (agent loops)
audit-date: 2026-04-19
---

# agent/awareness.ts

## Function inventory (1)
- `buildAwarenessContext(currentBuilding, peers)` — 16: exported.

## Findings

### 1. `/api/location` fetched without auth header — location leak (P2 — bundle with commune-loop phaseApproach)

Line 27:
```
const locResp = await fetch(`${peer.url}/api/location`, {
  signal: AbortSignal.timeout(5000),
});
```

No `Authorization: Bearer`. If that endpoint requires auth, awareness silently degrades to empty (peer location always null). If it's public, every character's location is reachable unauthenticated. Bundle with commune-loop.ts finding #6 — same issue.

### 2. `Promise.all` fans out to all peers concurrently with 5s each (P3)

Line 24. For 6 peers, that's 6 concurrent requests to `/api/location`. If N grows, this is O(N) fan-out per system-prompt build. Reasonable for current N; note for scaling.

### 3. No retry / no cache (P3)

Every system-prompt build re-fetches all peer locations. No TTL cache. For chatty conversations that rebuild the prompt per turn, this is a per-turn fan-out. Should be cached for ~30-60s.

### 4. `stateSummary` text flows verbatim into system prompt (P2 — bundle)

Lines 42–45:
```
const stateData = await stateResp.json() as { summary?: string };
stateSummary = stateData.summary || '';
```

`stateData.summary` comes from peer's `/api/internal-state`, which is LLM-derived text (per internal-state.ts audit pending). A compromised peer's summary flows into the current character's system prompt. Standard peer-injection propagation chain — same shape as commune-loop finding #3.

### 5. Returns early if `!locResp.ok` (line 30) but doesn't distinguish 401 from other errors (P3)

If auth is needed but token is missing, all peers silently "not co-located". No log. Hard to diagnose without log level debug.

## Non-issues / good choices
- Bearer token on state fetch (line 39) — correct.
- `AbortSignal.timeout(5000)` on both requests.
- Swallows individual peer failures without breaking other peers — good.
- Returns empty string when nothing to report — clean integration with prompt builder.
- No fs/state mutation — pure read.

## Findings to lift
- **P2 (bundle)**: `/api/location` unauth'd fetch (bundle with commune-loop phaseApproach).
- **P2 (bundle)**: Peer `stateData.summary` flows verbatim into local system prompt — injection propagation.
- **P3**: No per-call cache; rebuilds fan-out every system-prompt construction.

## Verdict
Tiny, clean file. Only meaningful concerns are bundled with other files — the injection-via-peer-summary chain and the unauth'd location endpoint. Worth caching the location fan-out if prompt builds become frequent.
