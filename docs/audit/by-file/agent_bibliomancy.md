---
file: src/agent/bibliomancy.ts
lines: 304
purpose: Wired-Lain-only divination loop — every 8h scans `workspace/offerings/` for PDF/TXT/MD files, extracts a random passage, LLM-distorts it into a dream fragment, posts as dream-seed to Lain (via `LAIN_INTERLINK_TARGET` derived URL).
section: 8 (agent loops)
audit-date: 2026-04-19
---

# agent/bibliomancy.ts

## Function inventory (6)
- `startBibliomancyLoop(config?)` — 41.
- `runBibliomancyCycle(cfg)` — 122.
- `extractFromPdf(filePath)` — 215: pdf-parse dynamic import.
- `extractFromText(filePath)` — 230: paragraph split + random pick.
- `extractWindow(text, minLen, maxLen)` — 249: sentence-boundary slice.
- `dreamDistort(passage)` — 272: LLM call.

## Findings

### 1. `offeringsDir = join(process.cwd(), 'workspace', 'offerings')` is cwd-relative (P2 — bundle)

Line 31. Same shared-filesystem pattern. Each character running from `/opt/local-lain/` reads from the same `workspace/offerings/` regardless of character identity. Intended for Wired Lain only, but no identity guard.

### 2. No Wired-Lain-only identity check (P2)

File header comment says "for Wired Lain". No `characterId === 'wired-lain'` check. If another character has `LAIN_INTERLINK_TARGET` set, they would start this loop and post dream seeds under Wired Lain's name to Lain's inbox. Bundle with dream-seeder.ts identical issue.

### 3. Same `DEFAULT_CONFIG` env-snapshot-at-module-load bug as letter.ts (P1 — bundle)

Lines 32–33. Same pattern; same historical incident. Letter + bibliomancy + any other loop that reads `LAIN_INTERLINK_TARGET` at module load shares the fault.

### 4. PDF content flows to LLM prompt unsanitized (P2)

Line 284: `THE FRAGMENT:\n${passage}`. PDFs in `workspace/offerings/` are user-supplied ("offerings dropped into"). A crafted PDF with prompt-injection text → dreamDistort LLM → dream-seed content → Lain's dream memory.

**Not a new surface** (user is the operator, can drop whatever they like) but worth noting the chain: a PDF dropped in offerings becomes persistent character memory via dream residue.

### 5. No PDF size limit before parse (P2)

Line 217: `readFileSync(filePath)` then pdf-parse. A multi-GB PDF (accidentally or maliciously placed) will OOM the Wired Lain process.

### 6. `baseUrl.replace(/\/api\/interlink\/.*$/, '')` is fragile URL rewriting (P2)

Line 179. If `LAIN_INTERLINK_TARGET` is `http://localhost:3001/api/interlink/letter`, strips to `http://localhost:3001`. If target is something non-standard like `http://localhost:3001/api/other/thing`, the strip doesn't match, leaving `baseUrl` as the full path, then `new URL('/api/interlink/dream-seed', baseUrl)` produces unexpected URL.

**Example failure**: if target is `http://localhost:3001/foo/bar`, resolved URL becomes `http://localhost:3001/api/interlink/dream-seed` (URL resolve replaces path). Actually OK for absolute-path resolution. But fragile dependency on target URL shape.

### 7. No SSRF check on target URL (P2 — bundle).

Line 184. Env-configured.

### 8. `readdirSync` on cwd-relative directory — sync I/O at cycle time (P3)

Line 131. Bounded by directory size, not a hot path. Cosmetic.

### 9. `Math.random()` for bibliomantic "divination" (P3, intentional)

Lines 142, 226, 239, 252. Not cryptographic; not intended to be. Consistent with dream-loop randomness use.

### 10. Extracted passage ≥ 20 chars gate but no max (P3)

Line 159. Short-gate only. LLM input may include page-boundary artifacts (headers/footers) but that's arguably part of the divination aesthetic.

## Findings to lift
- **P1 (bundle)**: DEFAULT_CONFIG env-snapshot at module load (same as letter.ts).
- **P2**: Cwd-relative `workspace/offerings/` (bundle).
- **P2**: No Wired-Lain-only guard (bundle with dream-seeder).
- **P2**: No PDF size limit before parse — OOM risk.
- **P2**: Fragile `baseUrl.replace` URL rewriting — breaks on non-standard target paths.
- **P2**: No SSRF check on derived URL (bundle).
- **P2**: PDF-to-LLM prompt injection persistence chain (operator-sourced, but worth noting).

## Verdict
Small, focused loop. Primary concerns are the same env-snapshot bug as letter.ts and the lack of identity assertion. PDF size handling is the only novel P2 in this file. Low attack surface given operator-sourced offerings.
