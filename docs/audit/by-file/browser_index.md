# `src/browser/index.ts`

Barrel. 18 lines, re-exports every `browser.ts` symbol along with the three interfaces.

## Functions

None — pure re-exports.

## File-level notes

- **Only importer is `src/index.ts:53`** (the top-level barrel). No internal `src/**` file imports from here. Covered by the "entire browser module is dead code" P2 already lifted in `browser_browser.md`.

## Verdict

No new findings.
