---
file: src/agent/letter.ts
lines: 411
purpose: Daily letter loop — composes a structured letter (topics, impressions, gift, emotionalState) from the last interval's diary/curiosity/dream/notable-memory context, delivers to `LAIN_INTERLINK_TARGET` URL, saves to memory. Bidirectional between Lain and Wired Lain.
section: 8 (agent loops)
audit-date: 2026-04-19
---

# agent/letter.ts

## Function inventory (7)
- `loadJournalSince(sinceMs)` — 56.
- `getMemoriesSince(sessionKey, sinceMs, limit)` — 72.
- `getNotableMemoriesSince(sinceMs, limit)` — 85.
- `getDelayUntilTargetHour(targetHour)` — 98.
- `startLetterLoop(config?)` — 114.
- `runLetterCycle(cfg)` — 200: exported; called by timer + externally.
- (inline orchestration).

## Findings

### 1. `DEFAULT_CONFIG` snapshots env vars at module load — the root cause of the historical "Wired Lain sends letters to herself" bug (P1)

Lines 45–46:
```
targetUrl: process.env['LAIN_INTERLINK_TARGET'] ?? null,
authToken: process.env['LAIN_INTERLINK_TOKEN'] ?? null,
```

**Per MEMORY.md**: `.env` must NOT set LAIN_INTERLINK_TARGET "it overrides per-service values — caused Wired Lain to send letters to herself for months".

**This file is the exact mechanism.** Module load reads `.env` (if Node's dotenv loads it, which it does on import), snapshots into DEFAULT_CONFIG. If `.env` globally sets LAIN_INTERLINK_TARGET, both Lain and Wired Lain read the same value — whichever character's service started second writes to the first's URL, or both write to the same URL depending on ordering.

**Fix would be**: read env at cycle time, not module load. OR assert LAIN_INTERLINK_TARGET comes from the per-service EnvironmentFile, never the shared `.env`.

**Still latent today**: the runtime guard in MEMORY.md is "never put it in .env" — operational. The code still snapshots at module load. If anyone puts it in `.env` again, the bug recurs silently.

### 2. No guard that target URL is not self (P1)

Line 371: `fetch(cfg.targetUrl!, ...)`. No check that targetUrl does not point to the current service. Bundle with #1 — combined effect is what caused the months-long incident.

**Proposal for findings.md**: Letter loop must assert `new URL(cfg.targetUrl).host !== ownHostPort` at startup; refuse to run otherwise.

### 3. Character identity still defaults to Lain (P2 — bundle)

Line 298: `characterId = process.env['LAIN_CHARACTER_ID'] || 'lain'`. If unset, letter is composed with Lain's voice. Identity branch at 299–305 selects prompt based on characterId — if env is missing, Wired Lain would send a letter framed as "the grounded Lain" to its target.

### 4. Dr. Claude block mechanism is single-character-scoped (P2)

Lines 208-212: checks `getMeta('letter:blocked')`. Meta table is per-character DB (`~/.lain-<id>/lain.db`). Dr. Claude's process uses its own DB — so `getMeta('letter:blocked')` in Lain's process reads Lain's DB, not Dr. Claude's.

**How does Dr. Claude set it?** Must either (a) write directly to another character's DB (boundary violation), (b) POST to an HTTP endpoint that the character's own process handles, or (c) use some shared mechanism. Need to verify in doctor.ts/doctor-server.ts audit. Flag as pending.

### 5. No SSRF check on target URL (P2)

Line 371: `fetch(cfg.targetUrl!, ...)`. If env is compromised (post-RCE), letter content (including diary fragments, discoveries, dream residues, notable memories) can be exfiltrated via a crafted targetUrl. Defense-in-depth since requires prior compromise.

### 6. Letter bundles injection-carrying content across characters (P2 — bundle)

Diary (line 315), curiosity discoveries (318), dream residues (321), notable memories (324) — all potentially injection-derived — get LLM-digested into the letter JSON, delivered to the sister character, who may surface it through their own memory system.

### 7. `JSON.parse` on LLM output with no schema enforcement beyond 4-field shape (P3)

Lines 353–366. Validates `topics`, `impressions`, `gift`, `emotionalState` are array/array/string/string. Doesn't validate element types or length. A malicious LLM response with huge strings could produce a 50MB letter (bounded only by `maxTokens: 1024` which is small).

### 8. No retry on delivery failure (P3)

Lines 371–391. Delivery failure logs + throws; `scheduleNext` is in a try/catch at line 177 so next cycle fires after full interval. Missed letters silently skip.

### 9. `targetHour` uses server local time (P3 — bundle with diary.ts).

### 10. `cfg.maxJitterMs` interpreted as ±maxJitterMs (not 0-maxJitterMs) at line 164 (P3)

Unusual — the comment implies 30-min jitter but the expression `(Math.random() - 0.5) * 2 * cfg.maxJitterMs` gives `±maxJitterMs`, so effective jitter is 60 min (±30 min). Unlike curiosity.ts which uses `Math.random() * maxJitter` (0 to max). Inconsistent.

## Findings to lift
- **P1**: `DEFAULT_CONFIG` reads LAIN_INTERLINK_TARGET at module load — root cause mechanism of the "Wired Lain sends letters to herself" incident per MEMORY.md. Read per cycle or assert service-specific origin.
- **P1**: No self-target guard — letter loop should refuse to post to its own URL.
- **P2**: Identity defaults to Lain if LAIN_CHARACTER_ID unset (bundle).
- **P2**: Dr. Claude block via single-character meta table — cross-character block impossible without going through HTTP (verify in doctor.ts).
- **P2**: No SSRF check on target URL.
- **P2**: Letter carries injection-derived content from multiple sources.
- **P3**: LLM output has minimal schema validation.
- **P3**: No retry on delivery failure.
- **P3**: `maxJitterMs` interpretation differs from other loops.

## Verdict
This file is the locus of a historically real production incident per MEMORY.md. The module-load env snapshot at lines 45-46 is the actual mechanism. Runtime mitigation (operational rule "don't put LAIN_INTERLINK_TARGET in .env") is fragile — code-level fix (read per cycle + self-target assertion) should be P1.
