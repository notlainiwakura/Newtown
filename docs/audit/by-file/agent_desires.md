---
file: src/agent/desires.ts
lines: 825
purpose: Persistent drives (social/intellectual/emotional/creative) with intensity, decay, and type-specific action execution. Spawned from dreams, conversations, loneliness, visitor exchanges. Injected into system prompts. Strong desires (≥0.7) trigger actions: social→peer message, intellectual→research request, creative→document, emotional→note. Decay every 2h, loneliness check every 3h, action check every 3h.
section: 8 (agent loops)
audit-date: 2026-04-19
---

# agent/desires.ts

## Function inventory (20)
- `ensureDesireTable()` — 18: exported.
- `rowToDesire(row)` — 75.
- `generateId()` — 96.
- `createDesire(params)` — 100: exported.
- `getActiveDesires(limit)` — 128: exported.
- `getDesiresByType(type)` — 136: exported.
- `getDesireForPeer(peerId)` — 144: exported.
- `resolveDesire(id, resolution)` — 152: exported.
- `boostDesire(id, amount)` — 159: exported.
- `decayDesires()` — 170: exported.
- `getDesireContext()` — 198: exported.
- `spawnDesireFromDream(dreamResidue)` — 218: exported.
- `spawnDesireFromConversation(peerName, transcript)` — 255: exported.
- `checkLoneliness(lastInteractionAge)` — 298: exported.
- `spawnDesireFromVisitor(visitorMessage, characterResponse)` — 339: exported.
- `checkDesireResolution(eventDescription)` — 378: exported.
- `startDesireLoop(config)` — 448: exported.
- `checkDesireDrivenActions(config)` — 520.
- `executeDesireSocialAction(config, peer, desire)` — 584.
- `executeDesireIntellectualAction(config, desire)` — 650.
- `executeDesireCreativeAction(config, desire)` — 688.
- `executeDesireEmotionalAction(config, desire)` — 741.
- `parseDesireResponse(response, source, sourceDetail, logger)` — 788.

## Findings

### 1. Peer transcripts flow verbatim into desire-spawning LLM (P2 — bundle)

Line 273: `transcript.slice(0, 600)` — transcript is peer-produced (from commune-loop), injection-bearing. LLM then emits DESCRIPTION which is stored in DB and re-injected into system prompt via `getDesireContext()`.

**Chain**: peer injection → transcript → desire description → system prompt → amplified.

### 2. `targetPeer` from LLM output used to route peer messages (P2)

Line 807-808. Target is free-form text from LLM. `executeDesireSocialAction` at line 546-547 matches against peer `.id` or `.name`:
```typescript
const peer = config.peers.find(p =>
  p.id === desire.targetPeer || p.name.toLowerCase() === desire.targetPeer?.toLowerCase()
);
```

If LLM returns `'NONE'` but not uppercase, it'd match if a peer is literally named "None". Edge case. More concerning: LLM can direct any desire at any peer, allowing character's internal reasoning to redirect outbound traffic wherever.

Not a security bug per se — peer is validated against `config.peers` — but the fire-path-on-desire mechanism means any injection of DESCRIPTION that suggests a peer by name causes reach-out to that peer.

### 3. `visitorMessage` + `characterResponse` go into LLM as-is (P2 — bundle)

Line 354-355. Raw visitor message (user input). This is the entrance for ordinary adversarial users — anything the visitor typed becomes seed for desire spawning, which persists in DB.

**Chain**: visitor injection → desire description → system prompt → future LLM calls.

Reduced by random 0.3 gate (line 345) but not eliminated. Standard injection surface.

### 4. `sessionKey` uses sanitized title — path separator safe (positive, line 722)

Line 722: `title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)`. Strips everything except `[a-z0-9]`. Good. Unlike evolution.ts #4.

### 5. `executeDesireIntellectualAction` hits `/api/interlink/research-request` on Wired Lain (P2)

Line 661. Bearer-authed (line 665). Good.

But `replyTo: \`http://localhost:${process.env['PORT'] || '3003'}\`` at line 672 — constructs a callback URL from env. If PORT is attacker-influenced (unlikely in practice), Wired Lain is instructed to reply to a crafted host/port. Since Wired Lain runs on the same host and `localhost` is hardcoded, this is contained. Minor.

### 6. `executeDesireCreativeAction` regex split on `---\n` (P3)

Line 714. If LLM emits non-standard formatting (no `---` separator or different newline), title/content parse fails and no document is written. Fails quietly. Fine.

### 7. Table `desires` created via ensureDesireTable (positive)

Lines 18-37. Indexed on `resolved_at` IS NULL and `type`. Reasonable query performance.

### 8. `decayDesires` applies hours-based decay (positive, line 177)

Uses `hoursSinceUpdate` — so if decay timer misses ticks, accumulated decay applies next run. Good time-consistency.

### 9. Resolved-desires never GC'd (P3)

Resolved rows stay in table forever. No cleanup. Over years, `desires` table grows unboundedly. Low-volume table, probably not an issue.

### 10. `boostDesire` is exported but never called in this file (P3)

Line 159. Exported for external callers. Grep callers to confirm use. Potentially dead.

### 11. `executeDesireSocialAction` saves full peer response into memory (P2 — bundle)

Line 630: `content: \`[Desire-driven reach-out to ${peer.name}] Sent: ${message}\nResponse: ${data.response}\``. Peer's response is raw text, stored. Injection carrier. Standard chain.

### 12. Rate limit: 1 action per 2 hours (positive, line 532)

Via `META_KEY_LAST_DESIRE_ACTION`. Prevents action spam.

### 13. `checkDesireResolution` LLM grades own desires (P3)

Lines 378-436. Same character's LLM decides what resolves its own desires based on event. Circular — but "same character" means it's supposed to. LLM-based introspection, not adversarial surface.

### 14. `spawnDesireFromVisitor` 0.3 probabilistic gate (positive, line 345)

Cuts injection amplification rate.

### 15. Regex-based parsing of desire response (P3)

Line 797-800. If LLM emits TYPE but not DESCRIPTION (or vice versa), parsing fails at line 802. Conservative. Doesn't handle free-form "I want to..." prose — only the strict TYPE/DESCRIPTION/INTENSITY/TARGET format.

### 16. `INTENSITY` parse uses `parseFloat` with no clamp (P3)

Line 813. `createDesire` does clamp at line 111, but `parseFloat('1.5')` → 1.5 → clamped to 1. If LLM returns something like `0.85 (high)`, parseFloat takes `0.85`. Generally safe.

### 17. `stopped` variable declared AFTER its use (P3 — latent bug)

Line 493 uses `stopped`, but `let stopped = false` is declared at line 502 — BELOW the setTimeout callback. The setTimeout callback at line 492 captures `stopped` via closure. In JS/TS this works due to hoisting (`let` is block-scoped and temporal-dead-zone applies, but the callback only runs after startDesireLoop returns, by which time `stopped` is initialized).

BUT: if the timer fires between line 499 and line 502... no, that's impossible; `setTimeout` doesn't fire synchronously. So this works. Just ugly code: declare `stopped` at top of function.

### 18. `startDesireLoop` can be called without config (P3)

Line 448. If config is undefined, decay + loneliness run but action execution is skipped. Allows a "passive" mode. Intentional.

### 19. Desire descriptions shown in system prompt as "You strongly want: ..." (P2 — bundle)

Line 205. Direct instruction-style framing. If injection controls DESCRIPTION, the character's LLM is instructed in first-person voice about what it "wants" — strong prompt-injection amplifier.

### 20. `data.response` from peer message has no length validation (P3)

Line 624, 630. Peer response is stored verbatim. If peer injects a 100KB response, it's persisted. No bound. Minor.

## Non-issues / good choices
- Clean SQL schema with appropriate indices.
- Type-specific action dispatch (social/intellectual/creative/emotional).
- Rate limit via meta key.
- Sanitized title for sessionKey (directory-traversal safe).
- Bearer auth on research request.
- Probabilistic visitor gate.
- Decay rate configurable per desire.
- Intensity clamped at creation.
- Loneliness threshold 6h + 2-desire cap.

## Findings to lift
- **P2 (bundle)**: Multiple injection entry points — dream residue, commune transcripts, visitor messages, peer responses — flow into desire descriptions, then into system prompt.
- **P2 (bundle)**: "You strongly want: ..." framing in system prompt is an instruction-style amplifier.
- **P3**: `boostDesire` exported; verify usage.
- **P3**: Resolved desires never GC'd.
- **P3**: `stopped` let-hoisting is fragile (works via closure semantics but declarations should precede use).

## Verdict
Well-structured persistent-drive system with type-specific action handlers. Decay + resolution + rate-limits give it good shape. Concerns are entirely about the five LLM-input surfaces (dream, conversation, loneliness prompt, visitor, peer response) each becoming persistent prompt-injected content via the desire mechanism. Worst case is a single crafted visitor message creates a persistent prompt directive ("you strongly want: ...") that outlives the visitor interaction and shapes the character's reasoning for days or weeks.
