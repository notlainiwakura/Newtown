# `src/cli/commands/telegram.ts`

Starts the Telegram channel with a single default agent. 1 exported function + 4 inline event handlers (onMessage, onError, onConnect, onDisconnect) + shutdown closure.

## Functions

### `startTelegram()`, line 15

**Purpose:** boot Telegram integration: verify env, init DB, init all agents from defaults, wire a `TelegramChannel` with handlers, keep process alive.

**Fits the system?** Partially. Uses `getDefaultConfig()` agents rather than the manifest-aware multi-char setup — `agentId: 'default'` on line 50. In the multi-char town, only one character (main Lain per CLAUDE.md) should own Telegram, and she's not "default"; she has an id like `lain` with her own `LAIN_HOME`. So this entry point works only for the legacy single-character case OR when `LAIN_HOME` is correctly set to the main Lain install (which `start.sh` / systemd does).

**Gaps / bugs:**
- **P2** — `agentId: 'default'` hard-coded. If the default config's agent id differs (e.g. `'lain'`, `'wired-lain'`) the channel would attempt to dispatch to an agent that doesn't exist. Safer to read the agent id from config (e.g. `config.agents[0]?.id`) or from a `LAIN_TELEGRAM_AGENT_ID` env var.
- **P2** — `allowedUsers: [allowedChatId]`. `allowedChatId` is a *chat id* (maybe a user id, maybe a group). The comment says "user id" but Telegram chat id ≠ user id for groups. If the user supplies their personal user id but then DMs the bot from a group they own, messages from the group are rejected. Narrow but confusable env-var naming. At minimum needs a comment, at most needs separate `TELEGRAM_USER_ID` + `TELEGRAM_CHAT_IDS` vars.
- **P3** — `onMessage` error path sends `"...something went wrong. try again."` verbatim regardless of whether it's a provider-timeout, a workspace-parse error, or a DB failure. No correlation id. If a user reports "bot keeps saying try again," there's no breadcrumb. Add `logger.error({ errorId: nanoid(6) }, ...)` and include `errorId` in the user-facing text.
- **P3** — `await new Promise(() => {})` forever-hang at line 162. Works, but a cleaner pattern is `await new Promise<void>((_, reject) => process.on('SIGTERM', reject))` so the test harness (if any) can interrupt cleanly. Minor.

### Anon arrow `onMessage`, line 61

**Purpose:** dispatch an incoming Telegram message through `processMessageStream`, accumulate the streamed response, send as one Telegram message.

**Gaps / bugs:**
- **P2** — collects the *entire* streamed response into `fullResponse` then sends once. Defeats the streaming point: long responses (multi-paragraph reflections) now only appear after the full generation. For Telegram specifically, this is defensible since the bot API doesn't do SSE, BUT the original choice of `processMessageStream` over `processMessage` is wasted. Consider batched edits or `editMessageText` progressive updates. Non-critical.
- **P3** — `if (fullResponse.trim())` — empty responses silently don't send. User sees nothing, no error. Some characters (Lain) are famously taciturn; a legit "silence is the answer" response is indistinguishable from a failure here.
- Session key is generated once per chat with `nanoid(8)` on first message and cached in `sessions` map. That map lives only in this process. If the bot restarts, the session starts fresh — correct if sessions are ephemeral, but means multi-turn context re-inits on every deploy. Defer to `storage/sessions.ts` audit to confirm expected session lifetime.

### Anon arrows `onError`, `onConnect`, `onDisconnect` (lines 121, 125, 143)

Routine logging, plus the ASCII art banner. No issues.

### Inline `shutdown` closure, line 152

**Purpose:** disconnect channel + `process.exit(0)` on SIGINT/SIGTERM.

**Gaps / bugs:** Does not `closeDatabase()`. Open SQLite handles on exit can leave WAL files unchecked. Usually fine, SQLite self-recovers, but worth a **P3**.

---

## File-level notes

- The `import 'dotenv/config'` at top means this command reads `.env` at import time. CLAUDE.md warns `.env` must NOT set `LAIN_HOME` — if anyone puts `LAIN_HOME` in `.env` to make local dev work, starting the Telegram bot would override per-service `LAIN_HOME` and pollute another character's DB. Noted.
- No retry / backoff on `channel.connect()` — if Telegram is temporarily unreachable, bot dies at startup. Defer to `channels/telegram.ts` audit to see if the channel handles this internally.

## Verdict

**Lift to findings.md:**
- P2: Telegram agent id is hard-coded to `'default'`; will break if the default-config agent has a different id.
- P2: Telegram "streaming" buffers the whole response client-side before sending. Defeats streaming UX.

P3 notes kept in file.
