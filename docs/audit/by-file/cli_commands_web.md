# `src/cli/commands/web.ts`

Thin wrapper around `startWebServer`. 1 function.

## Functions

### `startWeb(port = 3000)`, line 11

**Purpose:** forward to `startWebServer(port)` with error catch + `process.exit(1)`.

**Fits the system?** Yes — pure adapter between the commander action and the real server entry point.

**Gaps / bugs:**
- `port: number = 3000` default is only used if the caller passes `undefined`. The commander layer parses with `parseInt` which can produce `NaN` (see `cli/index.ts` P3 note). If `NaN` comes in, `startWebServer(NaN)` will likely fail at bind time. Not *this* file's problem — already flagged in `cli/index.ts` notes.
- Swallows exception into a single-line `displayError`. The underlying error (port already in use, certificate missing, etc.) is stringified. Loses stack. **P3**.
- No check that `ANTHROPIC_API_KEY` / `LAIN_OWNER_TOKEN` / `LAIN_INTERLINK_TOKEN` are set before starting. The server will fail later with less-clear errors. Could echo a `displayWarning` here, but the responsibility arguably sits in `web/server.ts`. **P3**, deferred.

---

## File-level notes

- Nothing else in the file. Genuinely trivial.

## Verdict

**No findings to lift.** Real behavior lives in `web/server.ts` — all substantive audit will happen there.
