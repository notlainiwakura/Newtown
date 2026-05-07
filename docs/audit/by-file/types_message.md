# `src/types/message.ts`

Message / content / request-response types. 9 interfaces + 1 union.

## Interfaces / Types

- `IncomingMessage` — `{ id, channel, peerKind, peerId, senderId, senderName?, content, replyTo?, timestamp, metadata? }`
- `OutgoingMessage` — `{ id, channel, peerId, content, replyTo?, metadata? }`
- `MessageContent = TextContent | ImageContent | FileContent | AudioContent`
- `TextContent`, `ImageContent`, `FileContent`, `AudioContent`
- `AgentRequest` — `{ sessionKey, message }`
- `AgentResponse` — `{ sessionKey, messages, tokenUsage? }`
- `TokenUsage` — `{ input, output, total }`

## Gaps / bugs

- **`IncomingMessage.timestamp: number`** but `OutgoingMessage` has no timestamp. Asymmetric. For audit trails, every message (in and out) should be timestamped. Probably assumed to be added at persistence time — defer to `storage/sessions.ts` to confirm. **P3**.
- **`ImageContent.url?` vs `ImageContent.base64?`** — both optional, `mimeType` required. Nothing forces "one of url OR base64". A consumer could receive an `ImageContent` with neither and no warning at compile time. Should be a discriminated sub-union. Same for `FileContent`, `AudioContent`. **P2**.
- **No `ToolUseContent` / `ToolResultContent`** — the agent layer (Anthropic + OpenAI tool calls) has its own bookkeeping but doesn't surface through the `MessageContent` union. Means tool calls aren't first-class in the channel abstraction. Defer until `agent/tools.ts` audit to see if this matters for cross-channel tool display. **P3**.
- **`TokenUsage.total`** is a redundant field; should be derived. Slight footgun if a caller fills `input: 100, output: 200, total: 50`. Minor. **P3**.
- **`senderName?` is optional** but `senderId` is required. For Telegram, `senderId` = chat ID. Persistence / display code has to handle "no name available" gracefully. Consistent with Telegram reality. No issue.

---

## File-level notes

- No `Reaction` type despite most chat platforms supporting reactions. Out of scope, not a bug.
- `AgentRequest.sessionKey: string` — a stringly-typed opaque key. No type-level guard that it's been generated properly. Defer to `storage/sessions.ts`.

## Verdict

**Lift to findings.md:**
- P2: `ImageContent` / `FileContent` / `AudioContent` — `url?` and `base64?` both optional. Compile-time allows "neither set", runtime must guard. Fix: narrow to discriminated sub-union.
