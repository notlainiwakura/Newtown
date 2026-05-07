# `src/cli/commands/gateway.ts`

Gateway lifecycle: foreground start, daemon start, stop. 3 functions exported.

## Functions

### `startGateway()`, line 27

**Purpose:** foreground start. Loads config, inits DB + agents, registers the chat method, starts the socket server, installs SIGTERM/SIGINT handlers.

**Fits the system?** Yes — this is the `systemd ExecStart` entry point (the `-d`/daemon path is for ad-hoc local use). CLAUDE.md's "systemd services" model expects this foreground variant.

**Gaps / bugs:**
- If `initAgent(agentConfig)` throws for *any* agent, subsequent agents never init AND the server never binds. The process exits 1 through the outer catch. Fine, but there's no "degraded mode" where the gateway comes up with a partial agent roster. For a town of 6 characters where one has a workspace parse error, all 6 go down. Worth a **P3** note about graceful per-agent fallback.
- `logger.info('Gateway running, press Ctrl+C to stop')` — misleading for daemon mode (no TTY to Ctrl+C). Minor. **P3**.
- `shutdown()` closes the DB after `shutdownAgents()`. If an agent's cleanup writes to the DB post-close, errors are swallowed by the outer catch. Likely fine since agents are sync-shutdown, but worth confirming when `agent/index.ts` is audited.
- Error on line 86 uses `\${error}` interpolation. If `error.stack` matters (native crash), it's lost. **P3**.

### `startDaemon()`, line 94

**Purpose:** spawn a detached child running `node <argv[1]> gateway`, then verify it bound within ~1 second.

**Gaps / bugs:**
- **P2** — the 1-second `setTimeout` before `getServerPid` is a race. On a cold box (first DB init, keychain prompt, slow file I/O), the child may not have written `pidFile` yet. `displayError('Failed to start daemon')` then falsely fires while the child is still booting. The user sees "Failed" but the daemon is actually up seconds later. Should be a poll-with-backoff loop (200ms × N, up to 10s) checking both pidfile existence and process liveness.
- `spawn(process.execPath, [process.argv[1]!, 'gateway'], ...)` — assumes `argv[1]` is a readable script path. In compiled binaries (pkg / bun build), `argv[1]` may not match. Not a concern if always run via `node dist/index.js`.
- `stdio: 'ignore'` — daemon's stderr/stdout are discarded. If the daemon crashes during startup (before binding), the parent reports "Failed" but the actual error is gone. **P3**.
- `LAIN_DAEMON: '1'` is set in child env but I haven't seen any code read it. **Defer** — grep during `gateway/server.ts` audit.

### `stopGateway()`, line 134

**Purpose:** read PID, SIGTERM, wait up to 5s (10 × 500ms), SIGKILL if still alive.

**Gaps / bugs:**
- If `isProcessRunning(pid)` returns false initially (line 144), the function just returns after warning "Gateway process not found, cleaning up..." but never actually cleans up the stale PID file. Comment says "cleaning up..." but the code doesn't unlink. **P3** — minor, next `startGateway` ignores stale pidfiles anyway via the PID check. Misleading log.
- 5-second SIGTERM window is short for a gateway with many agents — if graceful shutdown needs to flush per-agent state (letters, memories), 5s may not be enough. Worth **P3** note pending agent-shutdown audit.
- `process.kill(pid, 'SIGKILL')` could fail if permissions drop between SIGTERM and SIGKILL. Unlikely locally.

---

## File-level notes

- No explicit `try { closeDatabase() }` around shutdown path error handling — if `stopServer` throws, DB stays open until process exit. Fine for CLI (process dies anyway) but a daemon-manager restart could leak an open DB handle on next boot. **P3**.
- `config.security.keyDerivation` is passed to `initDatabase` here but NOT to `doctor`'s equivalent call. Ties to the P3 flagged in doctor.md. Confirm signature during `storage/database.ts` audit.

## Verdict

**Lift to findings.md:**
- P2: `startDaemon` uses a 1-second sleep then single pidfile check. Race on cold boot → false-negative failure report.

P3 notes kept in file.
