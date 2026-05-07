# `src/security/index.ts`

Barrel. 23 lines, re-exports everything from `sanitizer.ts` and `ssrf.ts` along with the two result-type interfaces.

## Functions

None — pure re-exports.

## File-level notes

- **Re-exports 4 dead functions** (`analyzeRisk`, `wrapUserContent`, `escapeSpecialChars`, `isNaturalLanguage`) — already lifted in `security_sanitizer.md`.
- **Re-exports 3 other dead functions** (`sanitizeURL`, `isAllowedDomain`, `isBlockedDomain`) — already lifted in `security_ssrf.md`.
- **The barrel is the only import path that exposes the dead exports** — internal callers (`web/server.ts:48-49`, `agent/membrane.ts:8`, `agent/curiosity.ts:24`, `browser/browser.ts:7`) import directly from `./sanitizer.js` / `./ssrf.js` and bypass this file. So the barrel's purpose is purely external consumers… of which there are none, since this is a self-contained repo. **P3** — barrel is currently only referenced by itself (`security/index.ts` has no external importers per grep earlier).

## Verdict

No new findings. Bundled P2s already lifted from sanitizer and ssrf cover the dead-export observation.
