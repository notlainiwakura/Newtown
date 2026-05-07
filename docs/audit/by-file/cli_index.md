# `src/cli/index.ts`

Commander setup. 5 functions: 4 anonymous arrow actions + `export async function run()`.

## Functions

### Anon arrow, line 33-39 — gateway command action

```ts
async (options) => {
  if (options.daemon) { await startDaemon(); } else { await startGateway(); }
}
```

**Purpose:** choose daemon vs foreground startup based on `-d` flag.
**Fits the system?** Yes — matches two-mode gateway pattern (foreground for dev, daemon for systemd).
**Gaps / bugs:** If `startDaemon()` forks and returns, `parseAsync` resolves and the parent exits (fine). If it blocks, process stays alive (also fine). No issue.
**Consequences:** None.

### Anon arrow, line 81-83 — web command action

```ts
async (options) => { await startWeb(parseInt(options.port, 10)); }
```

**Purpose:** launch web server on specified port.
**Gaps / bugs:** `parseInt(options.port, 10)` — if user passes `--port banana`, this becomes `NaN`. `startWeb(NaN)` will fail downstream. Commander's default is `'3000'` string so empty flag works, but explicit non-numeric input isn't guarded. Minor. **P3**.

### Anon arrow, line 89-91 — telegram command action

```ts
async () => { await startTelegram(); }
```

**Purpose:** launch Telegram bot.
**Gaps / bugs:** None. Wrapper because commander expects an action returning a promise.

### Anon arrow, line 98-100 — character command action

```ts
async (id, options) => { await startCharacterById(id, options.port ? parseInt(...) : undefined); }
```

**Purpose:** route `lain character <id>` to the character server loader.
**Fits the system?** Yes — this is the manifest-authoritative entry point (`startCharacterById` should read `characters.json` to find the character). The manifest's `systemdUnit` / `homeDir` fields are consumed further downstream — confirm when I audit `commands/character.ts`.
**Gaps / bugs:** No validation of `id` at this layer. If an unknown id is passed, error surfaces only after `startCharacterById` looks it up. Acceptable — deferring to the loader keeps CLI layer thin. Same `parseInt(options.port, 10)` NaN concern as above. **P3**.

### `run()`, line 104 — main entry point

```ts
export async function run(): Promise<void> { await program.parseAsync(process.argv); }
```

**Purpose:** kick off commander parsing against `process.argv`.
**Fits the system?** Yes — called from `src/index.ts`'s `isMain` branch.
**Gaps / bugs:** None. One-liner, correct.

---

## File-level notes

- Version is hardcoded `'0.1.0'` on line 20 instead of read from `package.json`. If versioning ever becomes meaningful (deploy tracking, bug reports), this will silently lie. **P3** — note, don't fix yet.
- No unknown-command handler. Commander's default behavior is to print help, which is fine.
- No `onExit` / signal handler here. Each command (`startWeb`, `startCharacterById`, etc.) registers its own — confirmed earlier (`grep 'SIGTERM'` found handlers in all long-running servers).

## Verdict

No findings worth lifting to `findings.md`. Three P3 notes captured in file. Moving on.
