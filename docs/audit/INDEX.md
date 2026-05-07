# Audit Index

Status: `pending` / `in-progress` / `done`. Per-file notes at `by-file/<slug>.md`. Function counts filled in as each file is processed.

Traversal order below. File slug rule: replace `/` with `_`, drop the `src/` prefix, drop `.ts`/`.js`.

## 1. Entry points

- [x] `src/index.ts` — **done** (1 fn, 0 findings, 1 P3 note in file)
- [x] `src/cli/index.ts` — **done** (5 fns, 0 findings, 3 P3 notes in file)
- [x] `src/cli/commands/character.ts` — **done** (2 fns, **1 P1 + 1 P2 lifted to findings**)
- [x] `src/cli/commands/chat.ts` — **done** (14 fns, **2 P2 lifted**)
- [x] `src/cli/commands/doctor.ts` — **done** (9 fns, **2 P2 lifted**)
- [x] `src/cli/commands/gateway.ts` — **done** (3 fns, **1 P2 lifted**)
- [x] `src/cli/commands/onboard.ts` — **done** (4 fns, **2 P2 lifted — shares legacy-layout P2 with doctor/status**)
- [x] `src/cli/commands/status.ts` — **done** (1 fn, bundled into legacy-layout P2)
- [x] `src/cli/commands/telegram.ts` — **done** (1 exported + 4 handlers + shutdown, **2 P2 lifted**)
- [x] `src/cli/commands/web.ts` — **done** (1 fn, 0 findings)
- [x] `src/cli/utils/prompts.ts` — **done** (11 fns, 0 findings, 3 P3 notes)

## 2. Core primitives

- [x] `src/utils/logger.ts` — **done** (3 fns, 0 findings)
- [x] `src/utils/errors.ts` — **done** (8 classes, 1 P2 provisional — retryAfter units)
- [x] `src/utils/crypto.ts` — **done** (6 fns, 0 findings)
- [x] `src/utils/timeout.ts` — **done** (1 fn + 1 class, **1 P2 lifted — withTimeout doesn't abort**)
- [x] `src/utils/index.ts` — **done** (barrel only, P3 note)
- [x] `src/types/config.ts` — **done** (10 interfaces, **2 P2 lifted**: AgentConfig/manifest dualism, ProviderConfig missing tunables)
- [x] `src/types/gateway.ts` — **done** (6 interfaces + error codes, **1 P2 lifted**: `result: unknown`)
- [x] `src/types/index.ts` — **done** (barrel, 0 findings)
- [x] `src/types/message.ts` — **done** (9 interfaces, **1 P2 lifted**: media content url/base64 both optional)
- [x] `src/types/session.ts` — **done** (5 interfaces, **1 P2 lifted**: ChannelType/PeerKind missing peer/agent)
- [x] `src/config/schema.ts` — **done** (2 fns, 0 findings)
- [x] `src/config/paths.ts` — **done** (4 fns, 0 findings)
- [x] `src/config/defaults.ts` — **done** (2 fns, **2 P2 lifted**: duplicate haiku, stale Sonnet pin)
- [x] `src/config/characters.ts` — **done** (15 fns, **2 P2 lifted**: no manifest validation, silent empty-town)
- [x] `src/config/index.ts` — **done** (7 fns + 2 helpers, **1 P2 lifted**: saveConfig strips comments)
- [x] `src/events/bus.ts` — **done** (3 fns + 1 class with 5 methods, **1 P2 lifted**: default characterId masks missing setCharacterId)
- [x] `src/events/town-events.ts` — **done** (8 fns, **1 P1 + 3 P2 lifted**: getActiveEffects iteration order, notify silent fail, lazy ALTERs, stale expiry)
- [x] `src/storage/database.ts` — **done** (10 fns + 11 migrations, **1 P1 + 1 P0-latent + 1 P2 lifted**: silent SQLCipher fallback, salt regen on open, dual migration systems)
- [x] `src/storage/sessions.ts` — **done** (11 fns, **1 P2 lifted**: delete doesn't cascade to messages/memories)
- [x] `src/storage/keychain.ts` — **done** (10 fns, **1 P2 lifted**: silent master-key generation on droplet rebuild)
- [x] `src/storage/index.ts` — **done** (barrel, 0 findings, 1 P3 note — getMeta/setMeta not re-exported)

## 3. Memory

- [x] `src/memory/store.ts` — **done** (~45 fns, **6 P2 lifted**: visitor prefix-list divergence, getAllMemories 2000 cap, vec0 silent divergence, deleteMemory no-cascade, search positive-feedback loop, getActivity 22-OR LIKE)
- [x] `src/memory/embeddings.ts` — **done** (11 exports, **4 P2 lifted**: API key in URL, first-load poison, tokenizer truncation, no model versioning)
- [x] `src/memory/extraction.ts` — **done** (3 fns, **3 P2 lifted**: silent parse failure, not idempotent, sourceMessageId unpopulated)
- [x] `src/memory/migration.ts` — **done** (3 fns, **1 P2 lifted**: non-transactional per-memory mutations)
- [x] `src/memory/knowledge-graph.ts` — **done** (10 exports, **3 P2 lifted**: addTriple no-dedup, addEntity stomps metadata / rewinds last_seen, contradictions include future triples)
- [x] `src/memory/palace.ts` — **done** (16 exports, **3 P2 lifted**: resolveWing/resolveRoom race, per-visitor wing proliferation, case inconsistency)
- [x] `src/memory/topology.ts` — **done** (7 fns, **3 P2 lifted**: processing caps fall-behind, merge stale centroid, groups born dead)
- [x] `src/memory/organic.ts` — **done** (10 fns, **8 P2 lifted**: not phase-isolated, graceful-forget disabled, cross-conv samples nothing, dead setLifecycleState + union missing 'archived', archived still in search, 10k cap vs 15k reality, distillation truncates content)
- [x] `src/memory/index.ts` — **done** (10 fns + barrel, **5 P2 lifted**: extractUserId hallucinated, Layer 3a mixes loops as visitors, contradictions+resonance per-message, MAX_CONTEXT_TOKENS hardcoded, internal-state hook swallowed)

## 4. Providers

- [x] `src/providers/base.ts` — **done** (interface file, **5 P2 lifted**: no abortSignal/timeout, image-block leaks Anthropic shape, Usage omits cache tokens, streaming optional w/ no capability flag, no getModelInfo/context-window)
- [x] `src/providers/anthropic.ts` — **done** (~30 fns, **1 P1 + 10 P2 lifted**: toolChoice:'none'→'any' opposite bug; retry string-match, 429 not retried, Retry-After ignored, AbortError retried as timeout, only first text block, enableCaching ignored by complete(), enableCaching defaults off, streaming partial tool-call dropped, toolChoice not on continue*, continue* loses assistant text, unknown stop→'stop')
- [x] `src/providers/openai.ts` — **done** (~15 fns, **5 P2 lifted**: image blocks dropped, max_tokens deprecated / incompatible with o-series, unguarded JSON.parse on tool args, refusal never extracted, no streaming impls)
- [x] `src/providers/google.ts` — **done** (~15 fns, **5 P2 lifted**: response.text() unguarded on safety-block, synthesized positional tool IDs, toolChoice ignored, mismatched tool IDs silently corrupt, thinkingBudget:0 hardcoded)
- [x] `src/providers/retry.ts` — **done** (2 exports, **4 P2 lifted**: no jitter, Retry-After ignored, default codes miss 504/529, Anthropic doesn't use this helper)
- [x] `src/providers/fallback.ts` — **done** (~6 fns, **1 P2 lifted**: streaming silently downgrades to buffered when active provider lacks streaming)
- [x] `src/providers/budget.ts` — **done** (8 fns, **3 P2 lifted**: checkBudget not centrally enforced, recordUsage RMW race, no sub-monthly cadence)
- [x] `src/providers/index.ts` — **done** (4 fns + barrel, **2 P2 lifted**: empty-string apiKey doesn't fall back, fallback chain locked to primary's provider type)

## 5. Security + browser

- [x] `src/security/sanitizer.ts` — **done** (5 exports, **1 P1 + 5 P2 lifted**: server.ts:1450 discards .blocked, sanitize() returns unsafe input on block, English-only BLOCK_PATTERNS, applyStructuralFraming HTML-escapes pointlessly, not centrally enforced, 4 dead exports)
- [x] `src/security/ssrf.ts` — **done** (5 exports, **1 P1 + 5 P2 lifted**: DNS rebinding, ULA regex too narrow, no IPv4-mapped IPv6 normalization, dual-stack skips AAAA, safeFetch drops caller AbortSignal, 3 dead exports)
- [x] `src/security/index.ts` — **done** (barrel, 0 new findings — bundled P2s)
- [x] `src/browser/browser.ts` — **done** (8 exports, **4 P2 lifted**: entire module dead code pulling ~100MB chromium, SSRF initial-URL-only lets redirects/sub-resources bypass, evaluate() is arbitrary-JS primitive, singletons share state)
- [x] `src/browser/index.ts` — **done** (barrel, 0 findings)

## 6. Commune

- [x] `src/commune/buildings.ts` — **done** (1 fn + 2 consts + 1 type guard, **1 P2 lifted**: manifest invalid-building silent drop)
- [x] `src/commune/location.ts` — **done** (3 fns, **4 P2 lifted**: characterId param red herring, fallback timestamp always fresh, 4-write RMW race without transaction, double-swallowed building-memory errors)
- [x] `src/commune/building-memory.ts` — **done** (5 fns, **4 P2 lifted**: recordBuildingEvent silent swallow, case-sensitive characterId self-exclusion, queryBuildingEvents prune-on-read, central-store SPOF)
- [x] `src/commune/weather.ts` — **done** (5 fns, **2 P2 lifted**: N× independent weather loops / no town SOT, getWeatherEffect ignores intensity)

## 7. Agent core

- [x] `src/agent/index.ts` — **done** (~15 fns, **1 P1 + 5 P2 lifted**: processMessage/Stream duplication, 10 silent context-injection catches, initAgent hardcoded 'default' key, silent echo-mode fallback, Lain-speak error leak, agentLog shared unbounded)
- [x] `src/agent/persona.ts` — **done** (5 exports, **1 P1 + 1 P2 lifted**: buildSystemPrompt hardcodes "You are Lain Iwakura" into every character, applyPersonaStyle lowercases CamelCase peer names; 2 dead exports noted P3)
- [x] `src/agent/tools.ts` — **done** (~8 exports + 21 tool definitions, **3 P1 + 9 P2 lifted**: LAIN_REPO_PATH hardcoded dev path, fetch_*/view_image no SSRF, toolRequiresApproval dead, search_images broken, telegram_call hardcoded Telegram ID, textual path.resolve symlink escape, introspect_search ReDoS, create_tool name-collision, executeTool error leak, fetch_and_show_image no size cap, view_image bypasses budget, no per-character tool filter, shared unbounded log)
- [x] `src/agent/character-tools.ts` — **done** (1 fn with 14 registered tools, **4 P2 lifted**: interlinkToken inconsistency, replyTo localhost hardcoded, leave_note description lies, read_document missing Authorization header pending Section 9 verification)
- [x] `src/agent/doctor-tools.ts` — **done** (~10 tool definitions + helpers, **1 P0-latent + 3 P1 + 5 P2 lifted**: run_command substring blocklist RCE, run_diagnostic_tests shell-injects section, edit_file allows self-modification, isPathSafe symlink escape, BLOCKED_PATHS too short, no backup on edit_file, no audit trail; NO raw-SQL tool exposed — verified)
- [x] `src/agent/skills.ts` — **done** (4 exports, **1 P1 + 3 P2 lifted**: registerCustomTool gives LLM full Node capabilities via new Function with process+require+fetch+Buffer — persistent RCE primitive; no execution timeout; name-collision silently shadows builtins; tool code not logged at creation)

## 8. Agent loops

- [x] `src/agent/curiosity.ts` — **done** (prior session — audited)
- [x] `src/agent/curiosity-offline.ts` — **done** (prior session — audited)
- [x] `src/agent/diary.ts` — **done** (prior session — audited)
- [x] `src/agent/dreams.ts` — **done** (prior session — audited)
- [x] `src/agent/dream-seeder.ts` — **done** (prior session — audited)
- [x] `src/agent/letter.ts` — **done** (prior session — audited)
- [x] `src/agent/bibliomancy.ts` — **done** (prior session — audited)
- [x] `src/agent/self-concept.ts` — **done** (prior session — audited)
- [x] `src/agent/doctor.ts` — **done** (prior session — audited)
- [x] `src/agent/commune-loop.ts` — **done** (prior session — audited)
- [x] `src/agent/desires.ts` — **done** (20 fns, **2 P2 bundles lifted**: injection-amp via `You strongly want:` framing; 5 LLM-input surfaces each become persistent desire descriptions)
- [x] `src/agent/internal-state.ts` — **done** (**P2**: 5-signal movement effectively 1-signal; DEFAULT_BUILDINGS hardcoded 6-character roster drifts on succession; StateEvent.summary injection carrier; preoccupation_thread uncapped)
- [x] `src/agent/awareness.ts` — **done** (prior session — audited)
- [x] `src/agent/book.ts` — **done** (22 fns, **1 P1 + 2 P2 lifted**: LLM-chosen FILENAME directory-traversal at line 526→127; book:concluded doesn't stop loop; unbounded chapter growth via append-on-draft)
- [x] `src/agent/experiments.ts` — **done** (25 fns, **1 P1 + 2 P1-latent + 4 P2 lifted**: open() validator bypass via variable path/mode; sandbox runs as same UID (root on prod); pickle-allowing libs allowlisted; diary = injection backbone to book.ts; hardcoded 6-inhabitant prompts drift on succession; no Wired-Lain-only guard + fromId impersonation; triple-backtick fence collision)
- [x] `src/agent/novelty.ts` — **done** (21 fns, **P2 bundle**: no SSRF on RSS/Wikipedia; fragment→town events→memories amplification; multi-beat majors consume weekly budget)
- [x] `src/agent/evolution.ts` — **done** (**2 P0 + 2 P1 lifted**: shell injection via runShellCommand template literals in 6 sites; `rm -rf "${char.homePath}/workspace"` no path validation; ancestors filename path-traversal; succession catch-all restart with partial state)
- [x] `src/agent/narratives.ts` — **done** (**P2**: `LAIN_CHARACTER_NAME || 'Lain'` fail-open at 226, 340; drift-lock from previous narrative feedback)
- [x] `src/agent/feed-health.ts` — **done** (prior session — audited)
- [x] `src/agent/newspaper.ts` — **done** (prior session — audited)
- [x] `src/agent/objects.ts` — **done** (prior session — audited)
- [x] `src/agent/proactive.ts` — **done** (**P1**: inverted kill-switch logic at line 123 — `!== '0'` means feature disabled unless env is literally '0'; LLM reflections burn tokens regardless)
- [x] `src/agent/relationships.ts` — **done** (prior session — audited)
- [x] `src/agent/conversation.ts` — **done** (prior session — audited)
- [x] `src/agent/membrane.ts` — **done** (prior session — audited)
- [x] `src/agent/data-workspace.ts` — **done** (prior session — audited)
- [x] `src/agent/possession.ts` — **done** (prior session — audited)
- [x] `src/agent/dossier.ts` — **done** (positive getBasePath + manifestDossierSubjects('wired-lain'); P2 `/api/commune-history` unauth'd)
- [x] `src/agent/town-life.ts` — **done** (**2 P1 + 3 P2 lifted**: forceLocation relocates without auth; executeTool × 7-channel injection input; forceLocation cast unvalidated; postboard "from Administrator" authority amp; eventBus listener leak on restart)

## 9. Web

- [x] `src/web/owner-auth.ts` — **done** (3 fns, **3 P2 lifted**: no Secure attribute, no session revocation, silent-false on missing env)
- [x] `src/web/server.ts` — **done** (~14 top-level fns + route inventory, **2 P1 + 8 P2 lifted**: systemic body-asserted identity on `/api/peer/message` + `/api/objects/*` + `/api/buildings/:id/event` + `/api/conversations/event` + `/api/interlink/research-request` + `/api/interlink/letter`; SSRF in `handleResearchRequest` replyTo; CORS wildcard default; public read endpoints; hardcoded char-port drift; unbounded debug log; X-Forwarded-For rate-limit bypass; CSP unsafe-inline; `/gate?token=` in URL)
- [x] `src/web/character-server.ts` — **done** (10 fns, **3 P1 + 6 P2 lifted**: unbounded `readBody`, hardcoded `senderId: 'wired-lain'` impersonation of the town's maximum-trust figure, body-asserted `fromId` on `/api/peer/message`; regex path-traversal guard; `/api/meta/*` exposed to interlink holders; CORS wildcard hardcoded; no rate limiting, no security headers; possession reply pollutes persona)
- [x] `src/web/doctor-server.ts` — **done** (5 fns, **7 P2 lifted**: hardcoded `/api/location` returning school; in-memory sessions map with no TTL/cap; no body size cap; regex path-traversal guard; CORS wildcard; no security headers / rate limiting / health endpoint; workspace loaded via `process.cwd()`)
- [x] `src/web/skins/loader.js` — **done** (combined note — **1 P2 + 1 P3**: path-resolution duplicated across three files with `/doctor` vs `/dr-claude` drift; googleFontsUrl direct interpolation)
- [x] `src/web/skins/early-load.js` — **done** (combined note — **1 P2**: trusts `?skin=` unsanitized before registry loads; regex only)
- [x] `src/web/skins/picker.js` — **done** (combined note — 0 findings; validates via `setSkin` registry check)

## 10. Gateway + channels

- [x] `src/gateway/auth.ts` — **done** (consolidated in `by-file/gateway.md`)
- [x] `src/gateway/rate-limiter.ts` — **done** (consolidated in `by-file/gateway.md`)
- [x] `src/gateway/router.ts` — **done** (consolidated in `by-file/gateway.md`)
- [x] `src/gateway/server.ts` — **done** (consolidated in `by-file/gateway.md`)
- [x] `src/gateway/index.ts` — **done** (consolidated in `by-file/gateway.md`)
- [x] `src/channels/base.ts` — **done** (consolidated in `by-file/channels.md`)
- [x] `src/channels/index.ts` — **done** (consolidated in `by-file/channels.md`)
- [x] `src/channels/telegram.ts` — **done** (consolidated in `by-file/channels.md`)
- [x] `src/channels/slack.ts` — **done** (consolidated in `by-file/channels.md`)
- [x] `src/channels/discord.ts` — **done** (consolidated in `by-file/channels.md`)
- [x] `src/channels/whatsapp.ts` — **done** (consolidated in `by-file/channels.md`)
- [x] `src/channels/signal.ts` — **done** (consolidated in `by-file/channels.md`)

**Section 10 summary:** consolidated into 2 by-file notes (`gateway.md`, `channels.md`) given the shared architecture.
- Gateway (5 files, ~22 fns): **4 P2 lifted** — single-tenant sessionKey hardcode, unauth'd connect-budget DoS, buffer-accumulation cap, no session TTL, chmod-after-listen race; plus P3 dead `refreshTokenCache`.
- Channels (7 files, 5 platforms): **2 P1 + 10 P2 + 2 P3 lifted** — universal fail-open `isAllowed` default; Telegram/WhatsApp/Signal all have dead-reconnect bugs; Slack `app_mention` bypasses filters; platform metadata unsanitized; no rate limiting / size caps; cross-channel reply-ref corruption.

## 11. Frontend

- [x] `src/web/public/laintown-nav.js` — **done** (consolidated in `by-file/web_public_non-game.md`)
- [x] `src/web/public/laintown-telemetry.js` — **done** (consolidated in `by-file/web_public_non-game.md`)
- [x] `src/web/public/action-mapper.js` — **done** (consolidated in `by-file/web_public_non-game.md`)
- [x] `src/web/public/app.js` — **done** (consolidated in `by-file/web_public_non-game.md`)
- [x] `src/web/public/commune-map.js` — **done** (consolidated in `by-file/web_public_non-game.md`)
- [x] `src/web/public/game/js/config.js` — **done** (consolidated in `by-file/web_public_game.md`)
- [x] `src/web/public/game/js/sprites.js` — **done** (consolidated in `by-file/web_public_game.md`)
- [x] `src/web/public/game/js/pathfinding.js` — **done** (consolidated in `by-file/web_public_game.md`)
- [x] `src/web/public/game/js/fixtures.js` — **done** (consolidated in `by-file/web_public_game.md`)
- [x] `src/web/public/game/js/systems/APIClient.js` — **done** (consolidated in `by-file/web_public_game.md`)
- [x] `src/web/public/game/js/systems/CharacterManager.js` — **done** (consolidated in `by-file/web_public_game.md`)
- [x] `src/web/public/game/js/systems/DialogSystem.js` — **done** (consolidated in `by-file/web_public_game.md`)
- [x] `src/web/public/game/js/systems/ObjectManager.js` — **done** (consolidated in `by-file/web_public_game.md`)
- [x] `src/web/public/game/js/systems/PossessionManager.js` — **done** (consolidated in `by-file/web_public_game.md`)
- [x] `src/web/public/game/js/scenes/BootScene.js` — **done** (consolidated in `by-file/web_public_game.md`)
- [x] `src/web/public/game/js/scenes/TitleScene.js` — **done** (consolidated in `by-file/web_public_game.md`)
- [x] `src/web/public/game/js/scenes/WorldScene.js` — **done** (consolidated in `by-file/web_public_game.md`)
- [x] `src/web/public/game/js/scenes/DialogScene.js` — **done** (consolidated in `by-file/web_public_game.md`)

**Section 11 summary:** consolidated into 2 by-file notes (`web_public_non-game.md`, `web_public_game.md`) given the two-subsystem split.
- Non-game (5 files): **2 P1 + ~7 P2 lifted** — `commune-map.js:567 createNotification` innerHTML XSS with LLM-authored `event.content`; `app.js:111-119` `javascript:` URI bypass through `escapeHtml` into `onclick`; SSE network-drop/completion conflation; poll-interval leaks on navigation; localStorage sessionIds no TTL; hardcoded 6-character rosters; unescaped `entry.kind`.
- Game (13 files): **0 P1 + ~9 P2 + ~4 P3 lifted** — Phaser canvas rendering eliminates innerHTML-based XSS, changing the security posture of the sister subsystem. Findings instead cluster around manifest-order-dependent sprite fallback, `_chatHistories` unbounded growth, SSE fixed-interval reconnects, A* no iteration cap, SSE consumers without schema validation (amplifies Section 9 body-asserted-identity into UI), possession state-before-confirm, silent API failures, hardcoded `fixtures.js` interiors.

## 12. Scripts / plugins / objects

- [x] `src/objects/store.ts` — **done** (12 fns, **5 P2 lifted** — see `by-file/objects_store.md`: metadata.fixture bypass, unguarded JSON.parse, no pagination cap, no audit trail, body-asserted-identity at HTTP layer)
- [x] `src/plugins/loader.ts` — **done** (9 exports, **1 P1 + 4 P2 lifted** — see `by-file/plugins.md`: dead module with pre-built RCE primitives; manifest.main path-traversal; name-collision unregister; hook-chain mutation leak; no VM isolation)
- [x] `src/plugins/index.ts` — **done** (barrel, consolidated in `by-file/plugins.md`)
- [x] `src/scripts/run-kg-migration.ts` — **done** (1 fn, **1 P1-latent + 2 P2 lifted** — see `by-file/scripts.md`: silent default-DB fallback; no pre-migration backup; partial-failure detail loss)
- [x] `src/scripts/run-palace-migration.ts` — **done** (1 fn, consolidated in `by-file/scripts.md`)

**Section 12 summary:** 3 by-file notes (`objects_store.md`, `plugins.md`, `scripts.md`). Total **1 P1 + 1 P1-latent + 11 P2** lifted.
- Objects (1 file, 12 fns): 5 P2 — body-asserted-identity at HTTP layer (cross-ref Section 9); `metadata.fixture` bypass mints immortal objects; unguarded `JSON.parse`; `getAllObjects` no cap; no audit trail on destroy/transfer.
- Plugins (2 files, ~280 lines): 1 P1 (entire module is dead code with pre-built RCE primitives awaiting activation; delete recommendation) + 4 P2 (manifest.main traversal, name-collision unregister, hook-chain mutation leak, no isolation).
- Scripts (2 files, ~90 lines): 1 P1-latent (silent default-DB fallback when `LAIN_HOME` unset; can silently migrate wrong character per MEMORY.md "character memories are sacred") + 2 P2 (no pre-migration backup, partial-failure detail lost on exit).

---

Progress: 135 / ~135 files · ~665 / ~2122 functions. **All 12 sections complete.**

## Findings summary (final)

- **P0**: 2 — both in `agent/evolution.ts`: shell injection via `runShellCommand` template literals consuming env + LLM-derived strings across 6 call sites; `rm -rf "${char.homePath}/workspace"` with no path validation.
- **P0-latent**: 4 — storage salt regenerated on every DB open (P0 the moment SQLCipher is enabled); Dr. Claude `run_command` substring-match blocklist bypassable → RCE; `experiments.ts` sandbox runs as same UID (root on prod); `experiments.ts` pickle-allowing libs (numpy/pandas) allowlisted → arbitrary code execution via deserialization bypasses `BLOCKED_IMPORTS` entirely.
- **P1**: ~25 total across all sections.
  - Core/storage/providers/security (Sections 1–5): ~13 — `buildSystemPrompt` hardcoded "You are Lain Iwakura"; `agent/tools.ts` broken search_images; LAIN_REPO_PATH hardcoded dev path; `agent/skills.ts::registerCustomTool` persistent RCE via `new Function`; `anthropic.ts` toolChoice:'none'→'any' opposite bug; `security/sanitizer.ts` discards `.blocked` at server:1450; `security/ssrf.ts` DNS rebinding / IPv6-mapped bypass; storage silent SQLCipher fallback; events `getActiveEffects` iteration order; Dr Claude doctor-tools shell-injection across 3 tools; `agent/tools.ts` telegram_call hardcoded recipient; `agent/tools.ts` textual path.resolve symlink escape; plus 2 prior.
  - Section 8 (agent loops): 7 — `book.ts` LLM-chosen FILENAME directory-traversal; `town-life.ts::forceLocation` relocates without auth; `town-life.ts::executeTool` 7-channel injection input; `evolution.ts` ancestors filename path-traversal; `evolution.ts` succession catch-all partial-state restart; `proactive.ts` inverted kill-switch logic; `experiments.ts::open()` validator bypassable by variable path/mode.
  - Section 9 (web): 5 — systemic body-asserted identity on `/api/peer/message`, `/api/objects/*`, `/api/buildings/:id/event`, `/api/conversations/event`, `/api/interlink/research-request`, `/api/interlink/letter`; SSRF in `handleResearchRequest` replyTo; `character-server.ts` unbounded `readBody`; `character-server.ts` hardcoded `senderId: 'wired-lain'` impersonation; `character-server.ts` body-asserted `fromId` on `/api/peer/message`.
  - Section 10 (gateway+channels): 2 — universal fail-open `isAllowed` on empty allowlist across all 5 channels (default-empty config = world-exposed LLM); Telegram/WhatsApp/Signal dead-reconnect bugs.
  - Section 11 (frontend): 2 — `commune-map.js:567 createNotification` `innerHTML` XSS via LLM-authored event content; `app.js:111-119` XSS via `javascript:` URI scheme bypassing `escapeHtml`.
  - Section 12: 1 — `src/plugins/loader.ts` is dead-code with pre-built RCE primitives awaiting activation (delete recommendation).
- **P1-latent**: 1 — `scripts/run-*-migration.ts` silent default-DB fallback when `LAIN_HOME` unset (per MEMORY.md, this can silently migrate the wrong character).
- **P2**: ~210+ across all sections — documented per-file in `by-file/` notes and section-by-section in `findings.md`. Key themes: body-asserted-identity across the interlink fabric (Section 9 core); hardcoded 6-character rosters drifting across server + proxy + skins + telemetry (Sections 7–11); LLM-text-as-world-state injection chain (Section 8 meta-theme); non-atomic file writes in long-running state; silent-catch idiom hiding real errors; unbounded "get all" queries in multiple stores.
- **P3**: ~275+ kept inline in by-file notes.

## Cross-section threads surfaced during Section 8

- **Meta-theme: LLM text as persistent world-state** — Every loop that writes LLM output to a file or DB becomes an injection carrier. The chain is: visitor/peer injection → memory → diary/dossier/narrative/self-concept/book/experiment-diary → system prompt → next LLM call. No file in Section 8 structurally-frames re-ingested LLM text. See findings.md "Multiple injection amplifiers" entry.
- **Unauth'd cross-peer HTTP in Section 8** (must verify in Section 9): `/api/building/notes`, `/api/documents`, `/api/postboard`, `/api/location`, `/api/objects`, `/api/town-events`, `/api/town-events/effects`, `/api/commune-history`, `/api/meta/:key`. Any of these that are public = cross-character read/write without access control. Section 9 must verify endpoint auth on each. **VERIFIED in Section 9**: `/api/documents`, `/api/commune-history`, `/api/building/notes`, `/api/town-events/effects`, `/api/activity` are indeed unauth'd public reads on main server. `/api/meta/:key` on character-server requires interlink auth but with shared-token amplifier that's effectively no isolation.
- **Fail-open-to-Lain identity default** appears in `agent/index.ts`, `narratives.ts`, `experiments.ts` (hardcoded `fromId: 'wired-lain'`). Any missing env defaults to a specific character's identity rather than failing. Bundle-wide audit needed: grep for `|| 'Lain'`, `|| 'lain'`, `|| 'wired-lain'`. **EXTENDED in Section 9**: `character-server.ts:1226` hardcodes `senderId: 'wired-lain'` on every incoming letter — strictly worse than fail-open; this is fail-*to* a specific identity regardless of caller intent.
- **`writeFile(path, content, 'utf8')` non-atomic pattern** is universal in Section 8 (book.ts, experiments.ts, narratives.ts, dossier.ts). One crash during write = corrupted long-running state.
- **Drift-lock / self-reinforcing loops** via previous-output feedback: dossier (reads own prior dossier → reinforces), narratives (reads prior narrative), self-concept, book (reads own prior chapters + diary), experiments (reads own past experiments via searchMemories). These are not bugs per se but structural concerns that amplify any drift or injection.
- **Hardcoded character rosters** in multiple files that should be manifest-driven: `experiments.ts:581-592, 701-702`, `internal-state.ts:224-231 DEFAULT_BUILDINGS`, prior sections noted similar in `doctor.ts`. Will break on first generational succession. **EXTENDED in Section 9**: `server.ts:681-688` (charPorts map, intentionally omits dr-claude — NOT a bug), `server.ts:2007-2014` (proxy map uses `/dr-claude/`), `skins/early-load.js:22` + `skins/loader.js:15` (both use `/doctor` — drift against proxy). Same pattern, now three-way mismatch.

## Cross-section threads surfaced during Section 9

- **Shared interlink token + body-asserted identity = town-wide impersonation primitive** — The entire interlink fabric is built on a single shared `LAIN_INTERLINK_TOKEN`. Every character process has it. Every interlink endpoint trusts identity fields inside the request body. Net effect: compromise any character process (or inspect any env file) and you can author anything as anyone to anyone — letters, peer messages, building notes, objects, conversation events, research requests. The `handleInterlinkLetter` hardcoding (`senderId: 'wired-lain'`) is a degenerate case of the same design: a single shared trust primitive doing double-duty as caller-auth and identity-claim. This is the single largest architectural security gap surfaced by the audit.
- **OOM and resource-exhaustion via unbounded POST bodies** — `character-server.readBody` and `doctor-server` POST handlers have no size cap, while `server.ts` has a 1 MB `collectBody` cap. The fix exists in one file and wasn't ported to the other two. Trivial DoS against any inhabitant process.
- **SSRF primitives remain despite `src/security/ssrf.ts`** — `handleResearchRequest` delivery uses raw `fetch(replyTo)`. Section 5 flagged that `safeFetch` drops the caller AbortSignal and noted SSRF-initial-URL-only bypass via redirects; Section 9 surfaces that `safeFetch` isn't even *used* in critical paths. Bundle-wide audit for raw `fetch(` on caller-controllable URLs warranted.
- **Path-traversal pattern inconsistency** — Three implementations in the web layer: correct `resolve() + startsWith()` in `server.ts` and `character-server.ts` /skins branch; weaker regex `\.\.` strip in `character-server.ts` serveStatic and `doctor-server.ts` serveStatic. Same codebase, same concern, three different implementations. Consolidate to a shared helper.
- **CORS/CSRF/rate-limit gaps** — Character-server and doctor-server both lack the hardening that main server has. Each new HTTP surface re-opens attack surface closed elsewhere. No shared HTTP-hardening helper.

## Cross-section threads surfaced during Section 11

- **Two-subsystem security posture** — The non-game frontend (`app.js`, `commune-map.js`) uses `innerHTML` liberally and has two P1 XSS sinks accepting LLM-authored data; the game frontend (Phaser) renders to canvas and has no analogous XSS surface. Same owner-authenticated origin, two different security postures. Audit/defense-in-depth of non-game DOM-injection sinks is a discrete fix boundary.
- **LLM-as-world-state injection chain reaches the browser** — The Section 8 meta-theme (LLM output → file/DB → system prompt → next LLM) now extends one more hop: LLM output → town-events SSE → `createNotification(innerHTML)` → owner's active DOM. The commune-map XSS is the first finding where the injection carrier exits the server entirely and lands in the operator's browser context. An LLM persona (including one injected via Section 9's body-asserted-identity primitive) can run JS in the owner's session with one ill-formed phrase.
- **Manifest-order and hardcoded-roster drift extends to JS** — Sections 7–9 tracked drift-lock in server code and skin loaders. Section 11 extends to `laintown-telemetry.js` (2 sites), `commune-map.js` canned phrases, and `WorldScene.js` (`Object.keys(CHARACTERS)[0]` fallback). Four-way drift (server charPorts / proxy map / skin loader / frontend telemetry) means a single generational succession can silently mis-route or mis-render in any of them.
- **SSE consumers on the client don't validate server-asserted identity** — The Section 9 body-asserted-identity pattern (server trusts body `fromId`) extends to the frontend: game SSE consumers forward `speakerId` / `fromId` straight to the UI without checking against `/api/characters`. A server that can be convinced to relay a forged identity (either via Section 9 interlink body-assertion or a future bug) renders that identity to the player as authentic.
- **Non-atomic client-side state** — `_chatHistories` unbounded, `localStorage` sessionIds no TTL, `setInterval` handles leaked on nav, optimistic possession-move without rollback. Frontend mirrors Section 8's "non-atomic writes" pattern one layer up: the client assumes server confirmation and persists state even when the server disagreed.

## Cross-section threads surfaced during Section 12

- **Dead code with attack surface is a distinct finding class** — `src/plugins/loader.ts` is the canonical example but not the only one: Section 7 flagged dead exports in `agent/skills.ts`, Section 5 flagged 3 dead exports in `security/ssrf.ts` + 4 in `security/sanitizer.ts`, Section 8 flagged dead code in `agent/tools.ts` (`toolRequiresApproval`), Section 11 flagged dead scenes in the Phaser client. Each is individually low-impact; the plugin loader is high-impact because it's a pre-built RCE primitive. The pattern is that "optionality for the future" accumulates attack surface with zero user value today.
- **Operator-facing tools need the same paranoia as character-facing code** — `scripts/run-*-migration.ts` is the single most destructive operator surface in the repo and has the thinnest safety net. No explicit `LAIN_HOME` enforcement, no backup, no dry-run, no structured failure report. Paradoxically, the character-facing code (`agent/tools.ts`, `agent/doctor-tools.ts`) has a more developed threat model than the operator-facing scripts that run against the character's memory as `root`.
- **Objects store confirms the Section 9 body-asserted-identity thread is architectural** — `store.ts` is a thin SQLite wrapper whose correctness depends entirely on the HTTP caller. Every mutating endpoint in `server.ts` (`createObject`, `pickupObject`, `dropObject`, `transferObject`, `destroyObject`) takes identity from the request body under interlink auth. The store layer cannot fix this; the fix has to land in the HTTP layer (derive identity from authenticated session, never from body). This is one more confirmation that the shared-interlink-token + body-asserted-identity pattern is *the* systemic security gap of the codebase, now surfaced across Sections 7, 8, 9, 10, 11, 12.
