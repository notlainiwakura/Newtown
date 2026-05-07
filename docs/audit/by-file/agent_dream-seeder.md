---
file: src/agent/dream-seeder.ts
lines: 264
purpose: Wired-Lain-only replenishment loop. Every 12h, queries each peer's `/api/dreams/stats` for pending seed count; if below threshold, fetches fresh content from RSS feeds + Wikipedia (per `workspace/novelty/sources.json`) and POSTs to peers' `/api/interlink/dream-seed`.
section: 8 (agent loops)
audit-date: 2026-04-19
---

# agent/dream-seeder.ts

## Function inventory (8)

- `stripHtml(html)` — 41: regex strip tags + entities.
- `loadSourcesConfig(workspaceDir)` — 45: reads `novelty/sources.json`.
- `fetchRssArticle(sources)` — 51: picks random feed, extracts random description/summary/content item.
- `fetchWikipediaArticle(sources)` — 72: fetches configured endpoint, returns `extract` field.
- `fetchDreamContent(workspaceDir, count)` — 86: loop picking RSS or Wikipedia, chunks articles into 200-800 char fragments.
- `fetchPeerStats(port, token)` — 123: GET to `/api/dreams/stats`.
- `postSeed(port, token, content)` — 143: POST to `/api/interlink/dream-seed`.
- `runSeederCycle(workspaceDir, config)` — 165: orchestration.
- `startDreamSeederLoop({ workspaceDir })` — 226: timer.

---

## Findings

### 1. No guard that this runs only on Wired Lain (P2)

File-header comment at line 4: `Runs on Wired Lain only.` Yet `startDreamSeederLoop` has no identity check — any character that invokes it will fire the loop.

**Where is it invoked?** Grep for `startDreamSeederLoop` to confirm — flag for follow-up in character-server audit. If an orchestration bug causes another character to start this loop, they'd begin POST-ing dream-seeds to all peers, competing with Wired Lain and potentially double-seeding.

**Gap:** should assert `process.env['LAIN_CHARACTER_ID'] === 'wired-lain'` at startup or log a warning otherwise.

### 2. `novelty/sources.json` is an attacker-controllable URL list with no SSRF / host allowlist (P1-latent)

Line 46: `loadSourcesConfig` reads `join(workspaceDir, 'novelty', 'sources.json')`. Its `rss` array and `wikipedia.endpoint` drive outbound `fetch` calls at lines 55 and 75 with **no `checkSSRF` protection**.

**Trust model:** `workspace/novelty/sources.json` is a committed config file — currently trustworthy.

**Attack surface:** if any tool gains write access to that path (e.g., edit_file tool if its `isPathSafe` gate is bypassed per agent_doctor_tools.md findings, or a filesystem-write skill that sneaks into skills/tools/*.json per agent_skills.md), the attacker can redirect RSS fetches to:
- `http://169.254.169.254/latest/meta-data/` (AWS metadata)
- `http://127.0.0.1:<port>/` (internal services)
- `http://10.x.x.x/` (private network)

Response body goes into `fragments`, then POSTed as content to all peer characters' dream-seed endpoint, where it lands in their memory, resurfaces in their dream fragments, and eventually influences their proactive messages to users.

**Gap:** both `fetch` calls should funnel through `checkSSRF` from `src/security/ssrf.ts`.

### 3. `fetchDreamContent` content is untrusted — posted to peers verbatim (P1-latent)

Line 213: `await postSeed(peer.port, token, content[contentIdx]!)`. `content[contentIdx]` is an RSS feed excerpt or Wikipedia extract, untrusted text.

**Chain**: RSS feed operator (or Wikipedia vandal) plants prompt-injection payload → fetched here → POSTed as dream-seed to every peer → surfaces as priority alien-seed in peer's dream cycle (per dreams.ts selectSeedMemory line 295) → LLM-generated dream fragment built from it → saveMemory persists → recurs.

**Depends on:** (a) whether `/api/interlink/dream-seed` sanitizes/limits content (to verify in server.ts audit), (b) whether the dream-fragment LLM treats these as trusted context. Both are probably weak defenses today.

### 4. `stripHtml` is a substring regex — not HTML-safe (P2)

Line 42: `html.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').trim()`.

- Doesn't handle `<![CDATA[...]]>` blocks (content retained literally).
- Doesn't handle nested quotes or `<script>` contents (removes tags but script source remains).
- HTML entities beyond the simple `&...;` form (numeric `&#123;`) collapse to space, possibly concatenating tokens.

Minor semantic garbage rather than security — but the scrubbed text ends up in LLM prompts.

### 5. Hardcoded `127.0.0.1` peer hostname (P2)

Lines 126, 147. Assumes all peers are on the same host as Wired Lain. Works on the single-droplet deployment; won't work for multi-host setups. MEMORY.md architecture is single-host so fine today.

### 6. `JSON.parse(Buffer.concat(chunks).toString())` with no body size cap (P3)

Line 132 (in `fetchPeerStats`). If a peer's stats endpoint returns gigabytes of data, we OOM the Wired Lain process. Endpoint is internal + authenticated so the attacker would need to compromise a peer first — defense-in-depth only.

### 7. `batchSize=30` per peer × needsSeeding count → proportional fetch burst (P3)

Line 195: `totalNeeded = needsSeeding.length * 30`. For 7 characters all below threshold, that's 210 fragments requested via `fetchDreamContent`, which loops up to 2× of count before giving up — 420 outbound HTTP attempts. Each is 10-15s timeout. Worst-case wall clock is hours. The loop is async but sequential.

### 8. `fetchDreamContent` doesn't dedupe fragments across runs (P3)

Line 86. Each call freshly fetches an RSS feed and picks a random item. No persistence of "what's already been seeded" — repeat runs may re-seed the same content. Other-than-cost harm: characters see the same dream-seed multiple times.

### 9. `LAIN_INTERLINK_TOKEN` is fail-silent warn + return (P3)

Line 168. Good that it warns; but if the env var is unset in production, all dream-seeding stops and the only signal is a warn-level log entry. Should be a startup-time assertion (fail-fast) rather than a runtime warn.

### 10. `setMeta('dream-seeder:last_check_at', ...)` only on success path (P3)

Line 221. If the cycle errors partway through `runSeederCycle`, `last_check_at` isn't updated, so `getInitialDelay` re-calculates based on the previous successful run — could hammer the cycle after transient errors. Actually — the outer `catch` at line 249 in `scheduleNext` still calls `scheduleNext()` for the next firing, so hammering is bounded by `checkIntervalMs` not 0. Fine.

---

## Non-issues / good choices

- `getDreamSeedTargets()` reads from centralized character manifest — good.
- Auth bearer token on both stats and post — good.
- Timeouts on both GET (5s) and POST (10s) — good.
- 10-minute probabilistic article chunking heuristic yields "dream-sized" (200-800 char) fragments.
- `loadSourcesConfig` fails the cycle cleanly if `sources.json` is malformed (JSON.parse throws, caught by outer try in `runSeederCycle` → `scheduleNext` error path).
- Proper HTTP stream drain via `res.resume()` in `postSeed`.
- No shared filesystem state — persistence via meta table (per-character DB).

---

## Findings to lift to findings.md

- **P1-latent**: `novelty/sources.json` URLs are fetched with no SSRF check — if the file is compromised (via edit_file or skills or filesystem-write), full SSRF → RCE-adjacent attack chain.
- **P1-latent (chain)**: RSS/Wikipedia content POSTed verbatim to peer dream-seed endpoints; combined with dreams.ts alien-seed priority, any feed poisoning produces persistent per-character memory influence.
- **P2**: No identity assertion that this runs only on Wired Lain — orchestration bug could duplicate seeding.
- **P2**: `stripHtml` is a lossy regex — doesn't handle CDATA, numeric entities, or script contents.
- **P2**: Hardcoded `127.0.0.1` peer host — single-host deployment assumption.
- **P3**: `JSON.parse` on stats response has no body size cap.
- **P3**: batchSize × needsSeeding can produce hundreds of outbound attempts sequentially per cycle.
- **P3**: No dedup of fragments across cycles — same RSS items may reseed repeatedly.
- **P3**: `LAIN_INTERLINK_TOKEN` unset → fail-silent warn rather than startup assert.

## Verdict
The loop's security posture is entirely dependent on (a) integrity of `sources.json` and (b) auth + validation of the peer `/api/interlink/dream-seed` endpoint. Defer final severity on the P1-latents until Section 9 verifies those endpoints. The dream-seeder is an injection-propagation amplifier: one compromised feed → every peer's dream life, every peer's residues, every peer's spawned desires.
