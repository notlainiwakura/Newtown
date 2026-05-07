# `src/cli/commands/chat.ts`

Interactive + one-shot chat through the gateway socket. 14 functions (2 exported, rest anon arrows / inner helpers).

## Functions

### `chat()` — interactive REPL

**Purpose:** open a Unix socket to the gateway, auth with a stored token, then loop prompting user input and streaming responses.

**Fits the system?** Yes — this is the local-only CLI chat mode. Uses `getPaths().socket` + keychain token. Aligned with the gateway's `auth` / `chat` / `status` methods.

**Gaps / bugs:**
- **P2** — auth-response detection uses `'authenticated' in response.result`. Key *presence*, not value. If gateway ever returns `{authenticated: false}` on failed auth, `authenticated = true` is set regardless and the user proceeds into a broken session. Should be `response.result.authenticated === true`.
- No socket timeout. A hung gateway will leave the CLI blocked on `rl.question`. `process.stdin` read still works (user can hit Ctrl+C), but no "connection stalled" feedback.
- `/clear` is missing from the help list / command handler; if the gateway supports clearing conversation, there's no CLI path to it.

### Anon arrows (event handlers, lines 50, 60, 77, 82)

All routine socket lifecycle handlers. No issues individually. `socket.on('close')` calls `process.exit(0)` — fine for a terminal CLI.

### `handleResponse(response)`, line 92

**Purpose:** demux gateway responses — auth, chat, echo, generic.

**Gaps / bugs:**
- Same auth-check weakness noted above (line 104).
- The three-way type-narrowing via `'key' in obj` is brittle. A future gateway method that adds an unrelated `response` field would fall into the chat-response branch. **P3**.

### `promptUser()`, line 131 — inner recursive prompter

**Purpose:** loop: read a line, dispatch commands or send to gateway.

**Gaps / bugs:**
- `/status` is sent but no response-routing logic distinguishes status responses. They fall into the generic `JSON.stringify(response.result)` branch in `handleResponse`. Works but ugly. **P3**.

### Anon arrow `rl.question('you: ', (input) => ...)`, line 132

Fine. Routes input to dispatch.

### Anon arrow `rl.on('close', ...)`, line 177

Fine.

### `sendMessage(message)` — one-shot send

**Purpose:** non-interactive send via the same gateway socket.

**Gaps / bugs:**
- **P2** — no timeout AND no `socket.on('close')` handler. If the gateway closes the socket before responding (e.g. crash mid-auth), neither `resolve` nor `reject` fires and the returned Promise hangs forever. The parent CLI process just sits idle.
- `catch {}` on the JSON.parse line (259) silently swallows malformed responses instead of rejecting. An ongoing malformed stream could leave the Promise hung indefinitely.
- Auth check here uses `!authenticated` toggle without even looking at the result shape — any response that isn't an error is assumed to be the auth success. Slightly less strict than the `chat()` path. **P3**.

### Anon arrows in `sendMessage` (lines 207, 216, 265)

Routine. `socket.on('error', reject)` at 265 is good — at least dead-socket errors surface. But close-without-error still hangs.

---

## File-level notes

- Two separate socket lifecycles (`chat` and `sendMessage`) duplicate auth handshake logic. Could be factored into a shared helper but it's small enough to leave — the two flows genuinely diverge after auth. **P3**.
- No logging to a file — all output is `console.log` / `displayX`. Appropriate for a user-facing CLI.

## Verdict

**Lift to findings.md:**
- P2: auth-response key-presence check accepts `{authenticated: false}` as success.
- P2: `sendMessage` has no timeout and no socket-close handler — hangs indefinitely on a dead gateway.
