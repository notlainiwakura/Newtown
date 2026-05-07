# `src/types/session.ts`

Session + channel types + `Credential` interface. 5 interfaces + 2 unions.

## Types

- `Session` — `{ key, agentId, channel, peerKind, peerId, createdAt, updatedAt, tokenCount, transcriptPath?, flags }`
- `ChannelType = 'telegram' | 'whatsapp' | 'discord' | 'signal' | 'slack' | 'cli' | 'web'`
- `PeerKind = 'user' | 'group' | 'channel'`
- `SessionFlags` — `{ summarized?, archived?, muted? }`
- `SessionCreateInput`, `SessionUpdateInput`
- `Credential` — `{ key, value: Buffer, createdAt }`

## Gaps / bugs

- **`ChannelType` does NOT include `'peer'` / `'interlink'` / `'character-server'`.** Inter-character conversations (Wired Lain ↔ PKD letters, commune-loop peer exchanges) must be recorded as sessions under one of the existing types (likely `'web'` or `'cli'`), losing semantic information. When the audit reaches `agent/commune-loop.ts` / `web/character-server.ts`, I should check what ChannelType is being used for these and whether it's polluting "web" sessions with peer traffic. **P2** — lift.
- **`PeerKind` does NOT include `'bot'` / `'agent'` / `'self'`.** When Wired Lain talks to Dr. Claude, both are agents — the `peerKind: 'user'` assumption doesn't fit. **P2** (bundled).
- **`Session.tokenCount` is a single scalar.** No separation of input vs output. For budget tracking or per-provider accounting, this is too coarse. Reconcile with `TokenUsage` from `message.ts`. **P3**.
- **`Session.flags.summarized`** — summarization flag. If the conversation is summarized, is the old content preserved? Unclear from the type. Defer to `storage/sessions.ts` audit.
- **`Credential.value: Buffer`** — raw bytes. Good. `key: string` — no constraint that it's a namespaced path (e.g. `auth:token`, `provider:anthropic:apikey`). Could be anything. Relies on convention in `storage/keychain.ts`. **P3**.

---

## File-level notes

- `SessionCreateInput` omits `tokenCount`, `flags`, etc. — creation-time-only fields. Clean.
- `SessionUpdateInput` allows partial `flags`. Correct.
- No `deletedAt` / soft-delete. Sessions are presumably hard-deleted. **P3** — audit storage later.

## Verdict

**Lift to findings.md:**
- P2: `ChannelType` and `PeerKind` don't represent inter-character / agent-to-agent traffic. Peer sessions either get mis-labelled or there's an undocumented convention. Audit storage/sessions.ts + commune-loop.ts to confirm impact.
