---
file: src/agent/newspaper.ts
lines: 222
purpose: Daily newspaper reading loop. Each character (except the day's editor) checks `{newspaperBaseUrl}/newspapers/index.json` every 24h, fetches the latest non-self-edited edition, LLM-generates a 2-3 sentence reaction, and saves as an `episode` memory.
section: 8 (agent loops)
audit-date: 2026-04-19
---

# agent/newspaper.ts

## Function inventory (3 + timer fn)
- `startNewspaperLoop(config)` — 42: exported.
- `checkAndReadNewspaper(config)` — 104.
- `readNewspaper(newspaper, config)` — 162.

## Findings

### 1. Newspaper fetch has no auth, no timeout, no SSRF (P2)

Line 111 and 148:
```
const resp = await fetch(`${config.newspaperBaseUrl}/newspapers/index.json`);
const resp = await fetch(`${config.newspaperBaseUrl}/newspapers/${latest.date}.json`);
```

No `AbortSignal.timeout(...)`, no headers. If `config.newspaperBaseUrl` is misconfigured to point at an attacker host, both fetches proceed with no bound. Worse: `latest.date` is injected into a URL path without validation — a malicious `index.json` can set `date: "../../etc/passwd"` or similar. Same-origin server-side URL construction means file-traversal within the newspaperBaseUrl server depends on that server's URL handling (the risk is at the serving side, but the client enables it).

**Path-injection chain**: index.json controls `latest.date` → URL `/newspapers/${latest.date}.json` → server path. If server serves from filesystem, a crafted date can read adjacent files (depends on server implementation in web/server.ts).

### 2. No SSRF check on `newspaperBaseUrl` (P2 — bundle)

Same as dream-seeder: any env-configured URL should funnel through `checkSSRF`. Bundle.

### 3. `newspaper.content` truncated to 2000 chars then sent to LLM prompt (P2)

Line 173–175. Newspaper content is user-facing LLM-generated text (from the daily editor character). Injection-derived content in newspaper.content → LLM prompt → reaction → saveMemory → future context.

Since each character's newspaper is produced BY another character (the editor rotates), this is another bidirectional peer-injection propagation surface. The editor's newspaper reaches every other character and becomes episodic memory.

**Chain**: editor-character-injection → newspaper → every other character's memory → their future LLM calls.

### 4. `latest.date <= lastReadDate` lexical comparison (P3)

Line 130. Works if dates are always ISO `YYYY-MM-DD` lexically equivalent to chronological. Fragile: if editor introduces a different format (`2026/04/19`, `04-19-2026`), comparison breaks silently.

### 5. Editor-skip updates `last_read_date` (positive, line 141)

Prevents re-checking the same date after editor-skip. Good.

### 6. `newspapers/index.json` is an array assumed `latest = index[0]` (P3)

Line 128. Assumes sort order; no sort/validation. If server serves unsorted or reverse-order, latest isn't picked. Fragile coupling between producer and consumer.

### 7. Reaction length < 10 → skip save (P3)

Line 193. Bumps `last_read_date` anyway. Side-effect: character "read" the paper but has no memory of it. Silent failure.

### 8. Hardcoded `importance: 0.4, emotionalWeight: 0.3` (P3 — bundle with commune/dreams)

Line 205–206. Magic constants.

### 9. `intervalMs` from config with default 24h, but no jitter (P3)

Line 44. Every character checks at the same cadence from startup. If all start simultaneously, they all check at the same moment — concurrent fetch spike. Small scale OK.

### 10. `getInitialDelay` tries same-day skip, fallback 0-5min jitter (P3)

Line 60–73. Works. "Already read today's paper" check uses `toISOString().slice(0,10)` (UTC date). Consistent with editor's date format? Needs cross-check with newspaper-producer code.

## Non-issues / good choices
- Editor self-skip (line 136) prevents the editor from reading their own paper — nice.
- `episode` memory type with timestamp metadata — queryable.
- Graceful degradation on fetch failures — logs debug, schedules next.
- Separate `checkAndReadNewspaper` / `readNewspaper` — clear separation.

## Findings to lift
- **P2**: `newspaperBaseUrl` fetches have no SSRF check and no timeout; `latest.date` injected into URL path without validation.
- **P2**: Newspaper content is a peer-injection propagation surface (editor → all readers → all memories).
- **P3**: Lexical date comparison assumes ISO `YYYY-MM-DD` format — fragile producer/consumer coupling.
- **P3**: Silent no-memory path when reaction is too short but `last_read_date` still bumps.
- **P3**: Hardcoded importance/emotionalWeight (bundle).

## Verdict
Simple fetch-and-react loop. Main concerns are consistent with the section-wide pattern: unauthenticated cross-service HTTP, no SSRF, injection-propagation via LLM-produced content. The `latest.date` path-injection is the most novel concern in this file — worth double-checking when auditing the server's newspaper-serving endpoint.
