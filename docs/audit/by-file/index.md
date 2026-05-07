# `src/index.ts`

Scope: root entry point + public re-exports. 1 arrow function (the `.catch` handler on line 72). Everything else is `export *` statements.

## Functions

### Anon arrow, line 72-75 — `run().catch((error) => { ... })`

**Purpose:** terminal error handler for the CLI. Logs whatever crashed and exits non-zero so systemd / shell callers see the failure.

**Fits the system?** Yes. This is the outermost `.catch()` — anything that propagates up from any CLI command ends here. `console.error` writes to stderr (captured by systemd journal). `process.exit(1)` is the right call for a CLI that has already failed fatally.

**Gaps / bugs:**
- No graceful shutdown. If a background agent loop crashes (unhandled promise rejection elsewhere in the process), that doesn't end up here — it lands on `process.on('unhandledRejection')` which isn't wired in this file. Each `web` / `character` / `telegram` server registers its own `SIGINT/SIGTERM` handlers (verified — see `web/server.ts:2190`, `character-server.ts:810`, `doctor-server.ts:496`, `cli/commands/gateway.ts:80`, `cli/commands/telegram.ts:158`). So the absence here is fine — subsystems own their own shutdown.
- The `isMain` check uses suffix string-match: `process.argv[1]?.endsWith('lain.js') || ...`. If someone symlinks the binary under a different name (`/usr/local/bin/lain-custom`), none of the suffixes match and `run()` is never called — the process just exits silently. Edge case (nobody's asked to do this), not a production bug. **P3**.

**Unexpected consequences:** None.

---

## File-level notes

The explicit import-list from `./agent/index.js` (rather than `export *`) exists because `agent/` also exports a `GatewayError` that collides with `utils/`. Comment on line 19 flags this. Not a bug — intentional.

No functions declared in this file other than the anonymous error handler, so the per-function budget here is 1.

## Verdict

No findings worth lifting into `findings.md`. One P3 note on `isMain` fragility stays here.
