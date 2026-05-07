# Function-by-Function Audit

Every function in `src/` analyzed one at a time. For each function:

1. **Purpose** — what does it do, in plain words
2. **Fits the system?** — does the behavior match the project's invariants (per-character paths, manifest-authoritative characters, Lain/Wired-Lain split, etc.)
3. **Gaps / bugs** — anything missing, wrong, or silently degrading
4. **Unexpected consequences** — side effects that surprise the caller

Findings that are real bugs or design concerns are lifted out of the per-file note into `findings.md` with severity. Cosmetic notes stay in the per-file note.

## Layout

- `README.md` — this file
- `INDEX.md` — every file in `src/` with status (`pending` / `in-progress` / `done`) and function count
- `findings.md` — running list of bugs / concerns / design questions, with severity
- `by-file/<path-slug>.md` — one analysis note per source file, in traversal order

## Traversal order

Processed by rough dependency layer, so that when I analyze a function, the things it calls have already been noted.

1. Entry points — `index.ts`, `cli/*`
2. Core primitives — `utils/*`, `config/*`, `events/*`, `storage/*`
3. Memory — `memory/*`
4. Providers — `providers/*`
5. Security — `security/*`, `browser/*`
6. Commune — `commune/*`
7. Agent core — `agent/index.ts`, `agent/persona.ts`, `agent/tools.ts`, `agent/character-tools.ts`, `agent/doctor-tools.ts`
8. Agent loops — `agent/{curiosity, diary, dreams, letter, bibliomancy, self-concept, doctor, commune-loop, desires, internal-state, awareness, book, experiments, novelty, dream-seeder, evolution, narratives, feed-health, newspaper, objects, proactive, relationships, conversation, membrane, data-workspace, internal-state, curiosity-offline, possession, skills, dossier, town-life, persona}.ts`
9. Web — `web/{server, character-server, doctor-server, owner-auth, skins/*}.ts`
10. Gateway + channels — `gateway/*`, `channels/*`
11. Frontend — `web/public/**/*.js` and HTML-embedded scripts
12. Scripts / plugins / objects — `scripts/*`, `plugins/*`, `objects/*`

## Session handoff

Each session ends with:
- update `INDEX.md` (mark files done)
- append new findings to `findings.md`
- commit `docs/audit/` changes

Next session reads `INDEX.md` first, finds the next `pending` file, continues.
