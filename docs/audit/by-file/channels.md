---
file: src/channels/{base,index,telegram,whatsapp,discord,slack,signal}.ts
lines: 84 + 44 + 345 + 251 + 247 + 255 + 462 = 1688
purpose: Messaging-platform connectors. Each Channel implements `connect/disconnect/send` + emits incoming messages to the agent. Supported platforms: Telegram (grammY), WhatsApp (Baileys), Discord (discord.js), Slack (Bolt/socketMode), Signal (signal-cli JSON-RPC). Base class centralizes event wiring and the optional `allowedUsers`/`allowedGroups`/`allowedChannels` allowlist.
section: 10 (gateway + channels)
audit-date: 2026-04-19
---

# channels/ (consolidated)

## Module shape
- `base.ts` — `Channel` interface, `BaseChannel` abstract class with event routing and allowlist semantics. `emitMessage/emitError/emitConnect/emitDisconnect` helpers.
- `index.ts` — barrel + `createChannel(config)` factory, switches on `config.type`.
- `telegram.ts` — `TelegramChannel` with reconnect (exponential backoff up to 15 attempts, 5-min max delay). Chunk-splits on `splitTelegramMessage` at 4096-char boundary.
- `whatsapp.ts` — `WhatsAppChannel` using Baileys with multi-file auth state, QR-code login.
- `discord.ts` — `DiscordChannel` using discord.js v14 with gateway intents.
- `slack.ts` — `SlackChannel` using Bolt socketMode.
- `signal.ts` — `SignalChannel` using signal-cli JSON-RPC over Unix socket; implements its own pending-request correlation with 30-second timeout.

## Findings

### 1. `isAllowed` fails OPEN when no allowlist is configured — every channel, universally (P1)

Locations: `telegram.ts:215-217`, `whatsapp.ts:164-166`, `discord.ts:158-164`, `slack.ts:164-166`, `signal.ts:361-363`.

All five channels share the same "if no restrictions, allow all" early-return. That means:

- Default-empty `allowedUsers` / `allowedGroups` / `allowedChannels` arrays on every deployment = **world-accessible LLM bot**.
- Any platform user who sends a message gets access to the character's `processMessage` pipeline: memory, relationship model, LLM tokens, budget.
- Memory-extraction pipeline records every stranger as a visitor (with the injection-amplifier pipeline flagged in Sections 7–8) — strangers' crafted messages become persistent character memories.
- Token-budget burn from spam is cost-exploit #1 for any character process with a generous monthly cap.

The docs imply allowlists are optional; the code treats them as optional; operators running a real production bot without setting allowlists are in for a surprise the first time their bot handle gets posted publicly. There's no warn-log, no fail-closed mode, no "public mode" flag to acknowledge the choice.

**Fix direction:** require an explicit `public: true` toggle in each channel config; otherwise fail-closed when allowlists are empty. At minimum log-once on connect with a loud warning.

### 2. `TelegramChannel.connect()` does NOT `await bot.start()` — race between connect-complete and ready-state (P1)

`telegram.ts:89-98`. grammY's `bot.start({onStart: ...})` returns a Promise that resolves only when polling stops. The code calls it without `await`, so `connect()` resolves immediately after `bot.start()` is called (before polling actually begins). Consumers that await `connect()` and then call `send()` may race against Telegram's internal bot-readiness — symptom: first send after connect hangs or throws "bot not initialized."

**Fix:** use grammY's `init()` + manual startup pattern, or convert `connect()` to resolve inside the `onStart` callback.

### 3. `WhatsAppChannel` dead-reconnect loop after first close (P1)

`whatsapp.ts:78-83`:

```ts
} else {
  logger.warn(...)
  setTimeout(() => this.connect(), 5000);
}
```

Does NOT clear `this.socket` before the reconnect call. Inside `connect()` the first line is `if (this.socket) { logger.warn('already connected'); return; }`. So the reconnect timer fires → `connect()` early-returns → no reconnect happens. The channel is dead until process restart.

Also: unlike Telegram and Signal, there's no attempt counter / exponential backoff — just a fixed 5-second retry that would loop forever if the fix were applied.

**Fix:** `this.socket = null; await this.disconnect(); await this.connect();` pattern, plus attempt counter + backoff parity with Telegram.

### 4. `SignalChannel.handleDisconnect` reconnect condition guarantees no reconnect (P1)

`signal.ts:178-201`. Execution order inside the function:

1. `this.socket = null;`
2. `this.emitDisconnect();` — sets `this._connected = false` via `BaseChannel.emitDisconnect`.
3. Reject & clear pending requests.
4. Reconnect check: `if (this.reconnectAttempts < this.maxReconnectAttempts && this._connected) { ... }`

Step 4 checks `this._connected` which was just set `false` in step 2. **Reconnect branch is unreachable.** Same class of dead-reconnect as WhatsApp, different root cause.

Additionally `disconnect()` sets `this.maxReconnectAttempts = 0` (line 301) — this is an instance field, not a transient flag, so if the channel is later re-used via another `connect()` call, reconnects stay dead because the kill-switch was never restored. Should be a separate `_shuttingDown` boolean.

**Fix:** track `_shuttingDown` separately; check that + attempt-count before the `this._connected` field is flipped. Reset `_shuttingDown` at start of `connect()`.

### 5. `emitMessage` swallows handler errors silently after routing to `onError` (P2)

`base.ts:65-69`. `handlers.onMessage?.(message).catch((error) => { handlers.onError?.(error || ...); })`. If the agent handler throws (LLM timeout, memory-write failure, DB corruption), the incoming message is routed to error logging and then dropped. No retry, no dead-letter queue, no user-facing error reply. For a user on Telegram whose message hit a transient bug, the experience is silent non-response.

**Fix:** on handler failure, send a platform-appropriate "sorry, I'm having trouble right now" reply to the original peer; maintain a short-lived retry queue for transient errors.

### 6. `emitConnect` / `emitDisconnect` set `_connected` independently of ground truth (P2)

`base.ts:75-83`. Each subclass manually calls `emitConnect()` / `emitDisconnect()` at times the subclass believes correspond to ready-state. Concrete mismatches:

- WhatsApp calls `emitConnect()` on `connection === 'open'` — accurate, but `disconnect()` (not connection-update-driven) sets `this.socket = null` then calls `emitDisconnect()`, which is fine, but no symmetric "logged out but not yet cleaned" path.
- Telegram calls `emitConnect()` inside `onStart` — but because of finding #2 above, this may fire *after* `connect()` has already returned.
- Signal calls `emitConnect()` on socket 'connect' event — before any signal-cli handshake has occurred; the socket is open but the JSON-RPC subscriber isn't confirmed to be receiving messages.

Net: `channel.connected === true` is not reliable in the moment the framework uses it. `send()` on these channels does its own "socket null?" check, which rescues most cases.

### 7. Telegram `parseInt(replyTo, 10)` — no NaN guard (P2)

`telegram.ts:161, 178, 190, 199`. `options.reply_to_message_id = parseInt(message.replyTo, 10)`. If `replyTo` was set from a different channel's id format (Signal uses `"${ts}:${author}"`, Discord uses snowflake strings that parse to valid ints truncated), Telegram sends the wrong reply ref or a NaN → API error. Cross-channel routing is brittle.

**Fix:** guard NaN; only set `reply_to_message_id` if the parse is sound AND the source channel was 'telegram'.

### 8. Discord own-message detection races against client-ready (P2)

`discord.ts:69`. `if (msg.author.id === this.client?.user?.id) return;`. During the reconnect window when `this.client` exists but `this.client.user` is not yet populated, this comparison always fails — bot's own echoed messages pass through to `emitMessage`. Amplified by `respondToBots` flag: if `respondToBots` is enabled (default false), a self-echo can loop.

**Fix:** require `this.client.user` ready; also check `msg.webhookId` for own webhook sends.

### 9. Slack `app_mention` handler bypasses bot-id filter (P2)

`slack.ts:81-86`. The main `message` handler drops `if (msg.bot_id)` but the `app_mention` handler (which fires on @-mentions in public channels) has no such check. Another bot @-mentioning the Lain bot will still emit an IncomingMessage, bypassing both `respondToBots`-style controls and the allowlist check (note: `this.emitMessage(incoming);` line 84 skips `this.isAllowed`).

**Fix:** apply the same `bot_id` filter + `isAllowed` gate inside `app_mention`.

### 10. Signal `sendRequest` 30-second timeout hardcoded (P2)

`signal.ts:271`. No per-send override. Signal-cli on a slow/overloaded daemon fails spuriously. Configurable timeout (falling back to 30s) is the right answer.

### 11. Discord `fetch` on every send — double API calls (P2)

`discord.ts:112`. `await this.client.channels.fetch(message.peerId);` per send. discord.js has an internal channel cache but this call bypasses it. Every outgoing message doubles the API spend.

**Fix:** prefer `this.client.channels.cache.get(peerId) ?? await this.client.channels.fetch(peerId, {cache: true})`.

### 12. No incoming-message size / attachment size limits on any channel (P2)

None of the channels enforce a maximum body size on incoming messages before they hit `processMessage`. A Telegram user posting a 10000-char caption, a WhatsApp document with a huge filename, a Discord message with many attachments — each becomes an `IncomingMessage.content` that flows into memory extraction + LLM context. Token-budget and DB-row-size risks.

**Fix:** per-channel inbound size caps; truncate or reject with a polite error reply.

### 13. Platform-provided metadata flows into `IncomingMessage.metadata` unsanitized (P2)

All channels include `username`, `senderName`, `pushName`, `sourceName`, `messageId`, `guildName`, etc. in `message.metadata`. These are operator-controlled strings on hostile platforms. If any downstream code (memory extraction, diary, dossier) interpolates metadata into a prompt or file, the attacker gets prompt-injection via a displayName. Cross-refs the Section 7–8 meta-theme: "LLM text as persistent world-state."

**Fix:** either filter to structured primitives only in `metadata`, or structural-frame whenever metadata is re-injected into a prompt.

### 14. WhatsApp reconnect has no attempt counter / max — infinite 5s retry on persistent failure (P2)

`whatsapp.ts:82`. Compare with Telegram's `MAX_RECONNECT_ATTEMPTS = 15` + exponential backoff (line 105-115). If finding #3 is fixed, WhatsApp will reconnect forever at 5-second intervals on a persistently-failing auth state, burning OP and log volume. Telegram's pattern is the right template.

### 15. WhatsApp/Slack/Signal: no own-self identity check before `emitMessage` (P2)

Unlike Discord and Telegram, WhatsApp's `emitMessage` path only skips `msg.key.fromMe` (line 93) — but WhatsApp multi-device pushes own-sent-from-another-device messages as non-`fromMe` depending on configuration. Slack filters on `bot_id` (line 72) but not on "is this our user ID." Signal doesn't filter own-sent messages at all — in group chats this means Signal peer sees the bot's own message as an incoming peer message.

**Fix:** each channel needs an own-sent filter. Signal specifically: compare `envelope.sourceNumber` to `this.config.account`.

### 16. Discord `message.files: [source]` passes data-URL through unchanged (P3)

`discord.ts:132`. If source is `data:image/png;base64,...`, discord.js doesn't accept it as a file reference. Fails silently (no file sent, no caption). Telegram and WhatsApp handle the data-URL case explicitly; Discord doesn't.

**Fix:** decode data-URLs to Buffer like WhatsApp does.

### 17. `createChannel` factory throws on unknown channel type but the error includes the untrusted `config.type` (P3)

`index.ts:42`. `Unknown channel type: ${(config as ChannelConfig).type}` — harmless but "don't interpolate untrusted input into error messages" is worth noting given Section 5's string-matching retry logic elsewhere.

### 18. `index.ts` has no runtime shape validation of `AnyChannelConfig` (P2)

The TypeScript union covers the five platforms, but the factory only dispatches on `config.type`. Missing per-platform required fields (`token`, `socketPath`, etc.) are not validated — they throw deep inside the channel constructor or on first `connect()` call. An operator with a typo'd `.env` gets a confusing "token undefined" error, not "missing required config: TELEGRAM_BOT_TOKEN."

**Fix:** per-type shape check inside `createChannel` with named-field error messages.

### 19. No rate limiting at the channel layer (P2)

All rate limiting lives on `src/gateway/rate-limiter.ts` (Unix-socket only) or the main web server's per-IP limiter. Messaging channels have zero rate limiting. A single Telegram chat bursting 100 messages in 5 seconds hits the LLM 100 times. The character's monthly budget gets burnt in one burst.

**Fix:** per-senderId sliding-window rate limit in `BaseChannel` (pre-emit) using the same pattern as the gateway.

### 20. `Telegram.splitTelegramMessage` boundary math: `TELEGRAM_MAX_LENGTH * 0.3` fallback floor (P3)

`telegram.ts:312, 319`. Requires split point > 30% into the message, else hard-cut. For a 4100-character message with no natural break points in the first 1230 chars, it hard-cuts at 4096 mid-sentence. Most real prose has paragraph breaks more frequently, so in practice it's fine, but the 30% heuristic has no rationale comment.

## Non-issues / good choices
- `base.ts` abstract class keeps the interface minimal and uniform across platforms.
- Every channel has an opt-in allowlist (fail-open default is the concern, not the mechanism).
- Telegram reconnect uses exponential backoff with a max-attempts cap — the reference implementation.
- Signal reconnect attempts cleanup of pending requests (rejects them) to avoid leaked promises — correct even if the reconnect itself is dead.
- `emitMessage` routes errors rather than letting them propagate and crash the handler.
- No raw platform secrets logged at any tracked level.

## Findings to lift
- **P1**: `isAllowed` fail-open on empty allowlist — universal across 5 channels; world-exposes every unconfigured deployment's LLM + budget + memory.
- **P1**: `TelegramChannel.connect()` doesn't await bot startup — race window between connect-complete and ready-state.
- **P1**: `WhatsAppChannel` dead-reconnect loop (no `this.socket = null` before retry).
- **P1**: `SignalChannel` dead-reconnect condition (checks `_connected` after it was just flipped false).
- **P2**: Slack `app_mention` handler bypasses bot-filter and allowlist.
- **P2**: No incoming-message or attachment size limits on any channel.
- **P2**: Platform-provided metadata (username / senderName / pushName) flows into memory unsanitized — injection-amp.
- **P2**: No per-channel rate limiting — single sender can saturate a character's budget.
- **P2**: Signal `disconnect()` mutates `maxReconnectAttempts = 0` — channel reuse has dead reconnect permanently.
- **P2**: Various own-message / bot-filter gaps (Discord race, Slack app_mention, Signal group self-echo, WhatsApp multi-device).

## Verdict
Five channel connectors sharing a common base. The base class + allowlist pattern is clean. The platform-specific code is reasonable but every single channel has at least one reconnect / readiness bug, and the shared `isAllowed` fail-open is a deployment footgun of the highest practical impact. The channel layer is also the boundary where platform-controlled identities (usernames, push names) enter the agent, and there's no structural sanitization / framing for any of them — feeds directly into the Section 7–8 "LLM text as persistent world-state" thread. Cross-channel metadata formats (replyTo especially) are not interchange-safe: Telegram parses an int, Signal uses ts:author, Discord uses snowflakes — any downstream code that moves replyTo between channels corrupts.
