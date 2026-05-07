---
file: src/agent/conversation.ts
lines: 321
purpose: In-memory conversation state per sessionKey. Builds provider message arrays, trims/compresses history when over token budget, saves compression summaries as memories. Supports text + image (base64) content blocks.
section: 8 (agent loops)
audit-date: 2026-04-19
---

# agent/conversation.ts

## Function inventory (10)
- `getConversation(sessionKey, systemPrompt)` — 30: exported; Map cache.
- `addUserMessage(conversation, message)` — 49: exported; handles text/image.
- `addAssistantMessage(conversation, content)` — 100: exported.
- `toProviderMessages(conversation)` — 114: exported.
- `getTextContent(content)` — 132: exported.
- `trimConversation(conversation, maxTokens, estimateTokens)` — 146: exported.
- `compressConversation(conversation, maxTokens, estimateTokensFn, provider)` — 178: exported.
- `updateTokenCount(conversation, input, output)` — 301: exported.
- `clearConversation(sessionKey)` — 312: exported.
- `getActiveConversations()` — 319: exported.

## Findings

### 1. Module-level `Map` holds all active conversations — unbounded memory growth (P2)

Line 25: `const conversations = new Map<string, Conversation>();`. Never cleared except via `clearConversation(sessionKey)`. No TTL, no LRU eviction. If sessionKeys are ephemeral (e.g., per-request or per-visitor UUIDs), the map grows unboundedly over process lifetime.

`trimConversation` and `compressConversation` trim within a conversation — they don't remove stale conversations.

**Observable symptom**: over days/weeks of uptime, memory footprint grows linearly with unique sessionKeys ever seen. Process eventually OOMs.

**Fix**: add LRU eviction or TTL cleanup. Cheap to bolt on.

### 2. `trimConversation` assumes paired user/assistant messages (P2)

Line 170: `conversation.messages.splice(0, 2)`. Removes the first two messages, assumed to be one user + one assistant exchange. If an assistant-only or user-only sequence exists (e.g., two tool-call rounds, or an orphaned user message), this splice creates a malformed history (e.g., leading assistant message with no preceding user).

In practice most providers reject conversations that don't start with user. This trim strategy can produce such malformed states.

### 3. `compressConversation` skips if ≤ keepCount (P3)

Line 202: `if (conversation.messages.length <= keepCount) return;`. With `keepCount = 6`, compression doesn't run until 7+ messages. `trimConversation` might still kick in before compression does, if token budget is tight. Boundary case: 5-message conversation that exceeds budget will trim but never compress.

### 4. Image tokens hardcoded as 1000 (P3)

Lines 162, 192, 289. `hasImage ? 1000 : 0`. Rough estimate. Real image token usage varies by provider, image size, detail level. For budget planning, 1000 is a reasonable conservative estimate. Worth noting — if underestimated, budget overruns.

### 5. Existing summary detection via prefix match (P3)

Line 215: `text.startsWith('[Earlier in this conversation]')`. Fragile. If the LLM compression ever re-formats the summary, this detection breaks and the loop may double-compress or skip existing summaries.

Summaries are stored as assistant messages (line 250). Semantically an "assistant" role but it's really machinery. Mixed into the conversation stream because providers don't have a "system note" mid-conversation. Functionally OK but conceptually muddled.

### 6. `saveMemory` call doesn't await (P3)

Line 263: `saveMemory({...}).catch((err) => ...)`. Fire-and-forget. If the DB is slow or failing, errors surface async and after the function returns. Compression proceeds to modify `conversation.messages` regardless. The saved memory is not synchronized with the in-memory state.

If `saveMemory` fails silently, the summary lives only in the Map. If the process restarts, the summary is gone from memory but never persisted. Acceptable tradeoff (memory recovery on restart is a diary/memory concern, not conversation) but worth noting.

### 7. `compressConversation` catches error and falls back to trim (positive, line 276)

Good resilience. But the fallback `trimConversation` at line 279 early-returns without the safety-net check at line 284 — so if trim itself doesn't sufficiently reduce, post-trim state is unchecked. Subtle.

### 8. `getTextContent` filters for text blocks, joins with space (P3)

Line 140: `.map((block) => block.text).join(' ')`. If an assistant message has no text blocks (e.g., pure tool-use), returns empty string. Tools use is invisible to downstream memory and compression. Probably fine — tool calls aren't user-surface content.

### 9. `updateTokenCount` never called by this file — must be called externally (P3)

Line 301. Exported but not invoked in this file. Caller's responsibility. If caller forgets, `conversation.tokenCount` stays 0 — no visible consequence since trim/compress re-estimate via callback.

### 10. `getActiveConversations` returns keys as array — potential leak (P3)

Line 319. `Array.from(conversations.keys())`. For diagnostic / admin API use. If sessionKeys are user-derived, they may contain PII. Flag for caller — audit what exposes this.

### 11. Per-message `timestamp: message.timestamp` (user) vs `Date.now()` (assistant) (P3)

Lines 88, 108. User messages preserve their incoming timestamp; assistant messages use current time. Not wrong but asymmetric. If message delivery is delayed, user message time can be earlier than assistant time, which is chronologically correct. Sorting by timestamp should work.

### 12. Image `mimeType` casted without validation (P2)

Line 63: `const mimeType = message.content.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';`. Raw cast. If the upstream `message.content.mimeType` is malformed or outside the enumerated set (e.g., `'image/bmp'` or a fabricated string), the cast is silent.

Anthropic provider will reject unknown types. Other providers may accept. The validation responsibility is pushed to the provider.

**Gap**: should validate at this boundary before casting.

## Non-issues / good choices
- Explicit compression prompt at line 229-236 with temperature 0.3 — deterministic summaries.
- Recent-message preservation (`keepCount = 6`) — good balance.
- Archives compressed content as `summary` memory type with importance 0.6 — discoverable later.
- Image content-block build is structurally correct (per Anthropic API shape).
- `trimConversation` always preserves `minMessages = 4` — prevents empty conversation.
- Clear separation of trim vs compress strategies.

## Findings to lift
- **P2**: Unbounded `conversations` Map growth — no TTL / LRU.
- **P2**: `trimConversation` pair-splice can produce malformed message sequences if not strictly user/assistant alternating.
- **P2**: Image `mimeType` unvalidated cast.
- **P3**: Summary detection via hardcoded prefix match — fragile.
- **P3**: `saveMemory` fire-and-forget.
- **P3**: Compression skipped for short over-budget conversations.

## Verdict
Sensible trim+compress strategy with reasonable fallbacks. The unbounded-Map is the only meaningful leak; everything else is pattern fragility. Worth an LRU pass and a mimeType validator — both are cheap hardening.
