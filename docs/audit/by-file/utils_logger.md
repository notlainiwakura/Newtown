# `src/utils/logger.ts`

Module-scoped pino logger singleton. 3 functions.

## Functions

### `createLogger(config)`, line 10

**Purpose:** build a pino logger with `pretty` or `file` target based on config, assign to the module-scoped `loggerInstance`.

**Fits the system?** Yes. Called by long-running commands (`gateway.ts`, telegram/web via chain). `targets` array allows simultaneous console + file logging.

**Gaps / bugs:**
- If `prettyPrint` is false, stdout uses `pino/file` with `destination: 1` — correct for systemd/journald capture. Good.
- `if (config.file)` adds a secondary file target. No rotation config. A misbehaving character loop producing MB/s of logs would fill the disk silently. **P3** — rotation is out-of-scope for the logger itself but should be flagged in a separate "log hygiene" concern.
- Overwrites `loggerInstance` on every call — if someone calls `createLogger` twice (e.g. two cooperating subsystems in the same process), prior holders keep the stale reference if they cached it. Practical impact: near-zero, since `createLogger` is called once per process. **P3**.

### `getLogger()`, line 46

**Purpose:** return `loggerInstance` or lazily create a default pretty logger.

**Gaps / bugs:**
- Default fallback uses `pino-pretty` unconditionally. In a production systemd context where no one has called `createLogger` yet (e.g. early import-time code), logs come out pretty-printed instead of JSON. Ugly in journald but not a bug. **P3**.

### `setLogger(logger)`, line 64

**Purpose:** replace the singleton. Useful for tests / subsystems that want a scoped logger.

**Gaps / bugs:** No callers outside tests (grep expected — defer). If unused in prod code, keep it; harmless.

---

## File-level notes

- No `child()` helper exposed. Consumers who want `{ agentId }`-scoped loggers have to call `getLogger().child({...})` themselves. Works, but inconsistent across the codebase. **P3**.
- No log-level mutation helper (`setLevel`) for runtime debug toggling. Nice-to-have.

## Verdict

No findings to lift. P3 notes kept in file.
