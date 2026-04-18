# Test Suite Documentation

> 10,286 tests across 69 files. Zero failures (6 skipped).

## Summary

| File | Tests | Category | Description |
|------|-------|----------|-------------|
| `test/matrix-full-grid.test.ts` | 786 | Matrix / Permutation | Full 9×9 building grid, emotional axes, weather effects, hall/wing assignments, provider contracts |
| `test/matrix-api-endpoints.test.ts` | 668 | Matrix / Permutation | Every HTTP route × method × auth state × response shape |
| `test/agent-loops.test.ts` | 401 | Agent Features & Loops | Structural audit of all 18 background loops |
| `test/matrix-complete-coverage.test.ts` | 393 | Matrix / Permutation | Tool registry, memory store, session, doctor/character tools, meta store, HTTP routes |
| `test/matrix-memory.test.ts` | 361 | Matrix / Permutation | Memory type lifecycle, embedding pairs, KG predicates, palace wings/halls, weather×emotion |
| `test/matrix-buildings.test.ts` | 361 | Matrix / Permutation | Building property completeness, movement pairs (81), weather×mood, desire×building |
| `test/permutations.test.ts` | 294 | Matrix / Permutation | Provider×message, config fields, weather×emotion, desire signals, sanitizer, SSRF |
| `test/memory-deep.test.ts` | 293 | Memory & Knowledge Graph | Embedding math, cosine similarity, centroid, vec0 search, KG CRUD, palace CRUD |
| `test/matrix-loops.test.ts` | 271 | Matrix / Permutation | Loop properties, intervals, budget fields, export conventions, meta-key patterns |
| `test/database-deep.test.ts` | 270 | Core Subsystems | Database initialization, schema checks, CRUD operations for all tables |
| `test/narrative-systems.test.ts` | 261 | Agent Features & Loops | Diary, dreams, self-concept, book loop, curiosity, newspaper, narrative synthesis, experiments |
| `test/web-api.test.ts` | 259 | Web & API | Owner auth, interlink auth, all HTTP endpoints, SSE, rate limiting, security headers |
| `test/fuzz-properties.test.ts` | 256 | Invariants & Property-Based | clampState, applyDecay, getStateSummary, weather fuzzing with random inputs |
| `test/matrix-security.test.ts` | 252 | Matrix / Permutation | isPrivateIP, SSRF IPs, auth×cookie, XSS payloads, SQL injection, path traversal, domain allow/block |
| `test/matrix-config.test.ts` | 251 | Matrix / Permutation | Config field types, character fields, building properties, path combos, agent ID patterns |
| `test/edge-cases.test.ts` | 242 | Stress, Boundary & Edge Cases | cosine similarity boundaries, sanitizer, SSRF, buildings data, weather, conversation, config schema |
| `test/utils-deep.test.ts` | 235 | Core Subsystems | Crypto, error types, logger, timeout, sanitizer, SSRF protection, BaseChannel |
| `test/matrix-provider.test.ts` | 232 | Matrix / Permutation | Finish-reason mapping, retry×status codes, tool formats, maxTokens defaults, temperature |
| `test/stress-limits.test.ts` | 221 | Stress, Boundary & Edge Cases | Conversation, memory, session, KG, location, internal state, palace stress tests |
| `test/user-expectations.test.ts` | 218 | Behavioral & User Expectation | Character distinctness, persona loading, conversation memory, applyPersonaStyle |
| `test/social-dynamics.test.ts` | 201 | Agent Features & Loops | Relationship progression, commune dynamics, letter system, awareness, desire-driven social behavior |
| `test/cli-system.test.ts` | 199 | Configuration & Deployment | CLI commands: onboard, gateway, character, web, doctor, telegram, chat, status |
| `test/providers.test.ts` | 197 | Providers & LLM Integration | AnthropicProvider, OpenAIProvider, GoogleProvider, withRetry, createFallbackProvider, budget |
| `test/boundary-values.test.ts` | 195 | Stress, Boundary & Edge Cases | Config schema, sanitizer, embedding, weather, internal state, budget, session, memory boundaries |
| `test/integration-flows.test.ts` | 192 | Integration & Cross-System | Message→memory, commune loop, doctor diagnostic, possession, auth→API→response, memory palace |
| `test/character-isolation.test.ts` | 182 | Security | Session, memory, location, emotional state, desire, config, event, and communication isolation |
| `test/invariants.test.ts` | 168 | Invariants & Property-Based | Spatial, emotional, memory, KG, weather, budget, SSRF, sanitizer, config, conversation, palace, desires |
| `test/palace.test.ts` | 160 | Memory & Knowledge Graph | Palace schema migration, Palace CRUD, KG CRUD, memory migration, vec0 search |
| `test/memory-system.test.ts` | 159 | Memory & Knowledge Graph | Embeddings, store CRUD, database integration, extraction, organic maintenance, palace wings/rooms |
| `test/experiments-system.test.ts` | 159 | Agent Features & Loops | Experiment loop, budget, code validation, skills CRUD, data workspace, feed health, dream seeder, possession |
| `test/channels.test.ts` | 154 | Core Subsystems | BaseChannel, TelegramChannel, DiscordChannel, SlackChannel, SignalChannel, WhatsAppChannel, registry |
| `test/gateway-system.test.ts` | 153 | Core Subsystems | Gateway auth, rate limiter, router (methods, auth, chat), server status, error codes, secureCompare |
| `test/resilience.test.ts` | 141 | Providers & LLM Integration | withRetry, fallback provider chain, budget enforcement, timeout utility, memory resilience, loop resilience |
| `test/data-integrity.test.ts` | 141 | Integration & Cross-System | DB schema integrity, data round-trips, concurrent access, manifest consistency, state machines |
| `test/event-system.test.ts` | 134 | Core Subsystems | parseEventType, isBackgroundEvent, EventBus, town events CRUD |
| `test/api-contracts.test.ts` | 132 | Web & API | Provider types, config contract, gateway contract, session contract, event contract, export surfaces |
| `test/objects-system.test.ts` | 130 | Commune & Town Systems | WorldObject CRUD, pickup/drop/transfer/destroy, building memory residue, building event store |
| `test/deployment-correctness.test.ts` | 130 | Configuration & Deployment | package.json, tsconfig, systemd template, generate-services.sh, start.sh, stop.sh, project file structure |
| `test/cross-system-interaction.test.ts` | 129 | Integration & Cross-System | Character-to-character comms, gateway routing, owner interaction, event propagation, multi-character |
| `test/town-systems.test.ts` | 126 | Commune & Town Systems | Town life loop, commune loop, newspaper loop, awareness context, desires CRUD, decay, loop lifecycle |
| `test/commune-deep.test.ts` | 125 | Commune & Town Systems | Building grid properties, isValidBuilding, location system, weather computation, building memory |
| `test/frontend-game.test.ts` | 123 | Frontend & Game Client | Fixture sprites, game config, character sprites, pathfinding, APIClient |
| `test/agent-pipeline.test.ts` | 123 | Agent Features & Loops | Conversation management, trimConversation, tool registry, executeTool, processMessage, streaming |
| `test/frontend-behavioral.test.ts` | 117 | Frontend & Game Client | Chat client, commune map, dashboard behavioral tests and HTML structure |
| `test/tools.test.ts` | 111 | Agent Features & Loops | Tool registry, calculate, remember, recall, web search, fetch webpage, time, view image, introspect |
| `test/type-safety.test.ts` | 110 | Configuration & Deployment | Default config completeness, character manifest types, building types, tool definitions, provider factory |
| `test/security.test.ts` | 109 | Security | Owner cookie, isOwner, CORS, input sanitization, interlink auth, hardcoded secrets, eval, SSRF, path traversal |
| `test/world-coherence.test.ts` | 107 | Behavioral & User Expectation | Town geography, character lifecycle, emotional→weather→behavior loop, desire→movement chain, aliveness |
| `test/commune.test.ts` | 106 | Commune & Town Systems | Buildings (grid layout, properties), weather (effects, computation, thresholds), location system |
| `test/e2e.test.ts` | 84 | Integration & Cross-System | DB&storage, web API, interlink letter pipeline, security, tool system, config, loops, providers, deployment |
| `test/browser-system.test.ts` | 84 | Agent Features & Loops | Browser initialization, page navigation, content extraction, screenshots, resource management, errors |
| `test/frontend.test.ts` | 83 | Frontend & Game Client | Game config, sprites, APIClient, scenes (Title, Dialog, World, Boot), commune map, dashboard, fixtures |
| `test/agent-content.test.ts` | 82 | Agent Features & Loops | Diary, dreams, letters, bibliomancy, curiosity, book, town life, feed health, dream seeder, data workspace |
| `test/agent-features.test.ts` | 78 | Agent Features & Loops | clampState, applyDecay, state save/load, preoccupations, movement desire, awareness, desires, relationships |
| `test/regression.test.ts` | 67 | Core Subsystems | Path isolation, commune location, event bus, buildings, DB/meta store, config defaults, sessions, systemd |
| `test/persona.test.ts` | 63 | Agent Features & Loops | Persona loading, system prompt building, applyPersonaStyle, shouldAskFollowUp |
| `test/doctor-system.test.ts` | 62 | Agent Features & Loops | Doctor tools, executeDoctorTool, telemetry, health status, doctor loop, doctor server, doctor persona |
| `test/silent-degradation.test.ts` | 58 | Invariants & Property-Based | Provider defaults, token limits, truncation detection, loop output validation, config validation, retry |
| `test/anti-regression.test.ts` | 58 | Invariants & Property-Based | Silent truncation, identity corruption, auth bypass, shared state corruption, config drift, budget evasion |
| `test/temporal-logic.test.ts` | 55 | Invariants & Property-Based | Budget period boundaries, loop scheduling, decay over time, event ordering, cooldowns, stale data |
| `test/config-system.test.ts` | 51 | Configuration & Deployment | Config loader, default config, schema validation, paths, character manifest helpers |
| `test/conversation.test.ts` | 47 | Core Subsystems | Conversation management: session lifecycle, message history, trim, compress, token counts |
| `test/storage.test.ts` | 33 | Core Subsystems | Crypto utilities, session CRUD, database initialization |
| `test/internal-state.test.ts` | 29 | Agent Features & Loops | Internal emotional state axes, preoccupations, desire-driven movement |
| `test/novelty.test.ts` | 16 | Agent Features & Loops | Template engine, source fetcher, event generator, rate limiting, novelty config |
| `test/gateway.test.ts` | 12 | Core Subsystems | Rate limiter, message router |
| `test/config.test.ts` | 10 | Configuration & Deployment | getDefaultConfig, loadConfig (merge, invalid), validate |
| `test/pathfinding.test.ts` | 7 | Frontend & Game Client | A* pathfinding algorithm |
| `test/relationships.test.ts` | 18 | Agent Features & Loops | Relationship system: axes, CRUD, heuristics, context injection |
| `test/infrastructure.test.ts` | 84 | Configuration & Deployment | Watchdog safety, port conflicts, restart policy, LAIN_HOME isolation, interlink targets, peer config, systemd |

---

## Test Categories

### 1. Core Subsystems

**`test/storage.test.ts`** — 33 tests

Covers the foundational crypto utilities and session storage layer. Tests `generateToken`, `hashToken`, `secureCompare`, `generateSalt`, as well as the full session CRUD lifecycle (`createSession`, `getSession`, `findSession`, `updateSession`, `deleteSession`, `listSessions`, `countSessions`) and database initialization.

- Crypto Utilities (generateToken, hashToken, secureCompare)
- Session CRUD and lifecycle
- Database initialization and singleton behavior

**`test/gateway.test.ts`** — 12 tests

Tests the core gateway's rate limiter and message router. Verifies connection throttling, request-per-window limits, and routing of JSON-RPC messages to registered handlers.

- Rate Limiter (connection and request limits)
- Message Router (dispatch, unknown methods)

**`test/gateway-system.test.ts`** — 153 tests

Comprehensive tests for the full gateway subsystem including authentication state, rate limiting, request routing, and server lifecycle. Covers edge cases for concurrent auth, deauthentication, token cache refresh, and GatewayErrorCodes.

- Gateway Auth (authenticate, isAuthenticated, getConnection, setConnectionAgent, deauthenticate)
- Rate Limiter (canConnect, registerConnection, canRequest, getRateLimitStatus, configureRateLimiter)
- Router (message validation, built-in methods, auth method handling, registerChatMethod)
- Gateway Server (isServerRunning, getServerStatus, getServerPid, isProcessRunning)

**`test/event-system.test.ts`** — 134 tests

Tests the event bus and event type system. Covers `parseEventType`, `isBackgroundEvent`, the full `EventBus` pub/sub implementation (on, off, emit, once, listenerCount), and town event CRUD (`rowToEvent`, `createTownEvent`).

- parseEventType (prefix extraction for all known event prefixes)
- isBackgroundEvent classification
- EventBus (subscribe, unsubscribe, publish, once, error handling)
- Town Events CRUD and row mapping

**`test/channels.test.ts`** — 154 tests

Tests all messaging channel implementations: BaseChannel state machine, and concrete channel adapters for Telegram, Discord, Slack, Signal, and WhatsApp. Each channel is tested for connect/disconnect idempotency, send behavior across content types (text, image, audio, file), allowedUsers/allowedGroups filtering, and message mapping. The channel registry (`createChannel`) is tested for all five types.

- BaseChannel (state machine, event handlers, emitConnect/Disconnect/Error)
- TelegramChannel (connect, disconnect, send, message splitting, photo/voice/document)
- DiscordChannel (connect, messageCreate, send with files and replies)
- SlackChannel (connect, message handler, send with thread_ts)
- SignalChannel (connect via socket, JSON-RPC send, incoming receive)
- WhatsAppChannel (makeWASocket, connection events, fromMe filtering)
- createChannel registry

**`test/conversation.test.ts`** — 47 tests

Tests the in-memory conversation management layer. Covers session creation and retrieval, message accumulation order, `trimConversation`, `compressConversation`, `toProviderMessages`, token counting, and `getTextContent` for string vs content-block messages.

- Conversation Management (getConversation, clearConversation, addMessage)
- Session isolation and independence
- Trim, compress, and token management

**`test/utils-deep.test.ts`** — 235 tests

Deep tests for utility modules: crypto functions (generateToken uniqueness, hashToken determinism, secureCompare timing-safety), custom error types (StorageError, TimeoutError, BudgetExceededError), logger (level filtering, structured output), `withTimeout`, and the full sanitizer and SSRF protection modules.

- Crypto (token generation, hashing, secure compare, salt)
- Error Types (StorageError, TimeoutError, BudgetExceededError)
- Logger (levels, pretty-print, structured fields)
- Timeout (withTimeout resolve/reject/cleanup)
- Sanitizer (sanitize, analyzeRisk, isNaturalLanguage, escapeSpecialChars)
- SSRF Protection (isPrivateIP, checkSSRF, isAllowedDomain, isBlockedDomain)
- Channel Base

**`test/database-deep.test.ts`** — 270 tests

Deep tests for the SQLite database layer. Covers initialization, the singleton pattern, all table DDL assertions, and CRUD operations for every major table (memories, messages, meta, sessions, relationships, desires, commune_history, postboard, palace, knowledge_graph, building_events, objects, town_events, documents).

- Database Initialization (singleton, explicit path, isDatabaseInitialized)
- Schema integrity (tables, columns, indices)
- CRUD for all major tables

**`test/regression.test.ts`** — 67 tests

The foundational regression test suite covering 12 areas of past production bugs: path isolation using `getBasePath()`, commune location system, event bus behavior, building definitions, database/meta store, configuration defaults, PEER_CONFIG env parsing, embedding utilities, session management, systemd unit file integrity, peer config env files, memory store, and fixture immutability.

- Path Isolation (getBasePath, per-character LAIN_HOME)
- Commune Location System (grid, movement, adjacency)
- Event Bus (subscribe, emit, listener management)
- Building Definitions (9 buildings, 3×3 grid)
- Database & Meta Store (getMeta, setMeta, round-trips)
- Configuration Defaults and PEER_CONFIG parsing
- Embedding Utilities (cosine similarity, serialization)
- Session Management (CRUD, expiry)
- Systemd Unit File Integrity and Peer Config env files
- Memory Store and Fixture Immutability

---

### 2. Providers & LLM Integration

**`test/providers.test.ts`** — 197 tests

Comprehensive tests for all three LLM providers (Anthropic, OpenAI, Google), the `withRetry` utility, `createFallbackProvider`, and the budget system. Each provider is tested for constructor behavior, `complete()` response mapping, `completeWithTools()` tool call extraction, `continueWithToolResults()` message formatting, and caching behavior. The `createProvider` factory is tested for budget wrapping, fallback chaining, and usage recording.

- BaseProvider interface and type unions
- AnthropicProvider (complete, completeWithTools, continueWithToolResults, message caching)
- OpenAIProvider (complete, completeWithTools, continueWithToolResults)
- GoogleProvider (complete, completeWithTools, continueWithToolResults)
- withRetry (status codes, message patterns, exponential backoff)
- createFallbackProvider (model-gone detection, promotion, exhaustion)
- Budget system (BudgetExceededError, checkBudget, recordUsage, getBudgetStatus)

**`test/resilience.test.ts`** — 141 tests

Tests the system's resilience mechanisms: `withRetry` retry logic, the `createFallbackProvider` fallback chain, `checkBudget`/`recordUsage` budget enforcement, `withTimeout` utility, memory store resilience (embedding failures, vec0 fallback), database layer error contracts, and recovery scenarios after transient failures.

- Retry logic (withRetry: 429/500/502/503, message patterns, exponential backoff)
- Fallback provider chain (model-gone errors, promotion, multi-level fallback)
- Budget enforcement (BudgetExceededError, cap, reset on month change)
- Timeout utility (withTimeout resolve/reject/cleanup/nested)
- Memory store resilience (embedding failure, brute-force fallback)
- Database layer (StorageError contract, getMeta, execute)
- Loop resilience (commune, diary, curiosity startup and error handling)
- Cascading failure containment and recovery

---

### 3. Security

**`test/security.test.ts`** — 109 tests

Dedicated security test file covering every security mechanism in the HTTP layer. Tests HMAC cookie derivation, `isOwner` authentication (22 edge cases including timing-safe comparison, unicode, multi-cookie headers), CORS configuration, input sanitization, interlink token auth, absence of hardcoded secrets in source, absence of `eval()`, URL security for the fetch tool, SSRF protection, security headers (CSP, X-Frame-Options, nosniff, Referrer-Policy), rate limiting, owner-only path protection, path traversal blocking, and the `/gate` endpoint.

- Owner Cookie Derivation (SHA-256 HMAC, determinism)
- isOwner Authentication (cookie parsing, timing-safe, edge cases)
- Owner Cookie Settings (SameSite, Path, HttpOnly)
- Server Auth Middleware (verifyApiAuth, verifyInterlinkAuth)
- CORS Configuration
- Input Sanitization
- Interlink Token Authentication
- No Hardcoded Secrets / No eval() audits
- Fetch URL Security and SSRF Protection
- Security Headers and Rate Limiting
- Owner-Only Path Protection and Path Traversal Prevention
- isPrivateIP functional tests

**`test/character-isolation.test.ts`** — 182 tests

Tests that characters are fully isolated from each other at every layer of the stack. Covers session isolation (separate conversation histories), memory isolation (per-DB storage), location isolation (independent grid positions), emotional state isolation (separate internal state axes), desire isolation (per-DB tables), configuration isolation (separate LAIN_HOME paths), event isolation (no cross-character event leakage), communication boundaries (interlink auth required), concurrent character operations, and cross-contamination smoke tests.

- Session Isolation (independent message histories)
- Memory Isolation (per-character databases)
- Location Isolation (independent grid positions)
- Emotional State Isolation (separate 6-axis states)
- Desire Isolation (per-DB desire tables)
- Configuration Isolation (LAIN_HOME separation)
- Event Isolation (no cross-character event leakage)
- Communication Boundaries (interlink auth enforcement)
- Concurrent Character Operations
- Cross-Contamination Smoke Tests

---

### 4. Web & API

**`test/web-api.test.ts`** — 259 tests

Exhaustive tests for both the main web server and the character server HTTP APIs. Covers owner auth (`deriveOwnerCookie`, `isOwner`), interlink auth (`verifyInterlinkAuth`), every GET/POST endpoint (health, characters, location, weather, activity, events, internal-state, chat, chat/stream, building notes, postboard, commune-history, town-events, budget, feeds/health, documents, peer/message, telemetry, interlink/letter, interlink/dream-seed, gate), static file serving with path traversal protection and SPA fallback, rate limiting, security headers, the Doctor server, and the Character server.

- Owner auth and interlink auth
- GET /api/health, /api/characters, /api/location, /api/weather, /api/activity, /api/events
- POST /api/chat and /api/chat/stream (auth, request handling, session management, SSE format)
- GET /api/internal-state, GET /api/meta/identity, GET /api/meta/:key
- GET/POST /api/building/notes, /api/postboard, /api/commune-history, /api/town-events
- GET /api/budget, /api/feeds/health, /api/system (owner-only)
- POST /api/interlink/letter and /api/interlink/dream-seed
- GET /gate (HMAC cookie issuance)
- Static file serving (path traversal, SPA fallback, meta injection)
- Rate limiting, security headers, CORS
- Doctor server endpoints
- Character server endpoints

**`test/api-contracts.test.ts`** — 132 tests

Tests the contractual shape of all public API interfaces: provider base types, config schema and types, gateway contracts, session contracts, event contracts, and the full export surfaces of providers, events, config, types index, commune, and agent tools modules.

- Provider contract (base types, tool definitions, finish reasons)
- Config contract (schema, agent shape, security config)
- Gateway contract (message format, error codes, response structure)
- Session contract (create, read, fields)
- Event contract (type strings, bus interface)
- Export surface verification for all major modules

---

### 5. Memory & Knowledge Graph

**`test/memory-system.test.ts`** — 159 tests

Tests the full memory subsystem from embeddings through the palace structure. Covers embedding math (cosine similarity, normalization, top-K search), structural tests of the store module (saveMemory, searchMemories, getRecentMessages, organicMaintenance), database integration, memory extraction, organic maintenance (decay, pruning), and the palace hall assignment and wing resolution algorithms.

- Embeddings (cosine similarity, normalization, serialization)
- Store structural tests (saveMemory, searchMemories, getRecentMessages, deleteMemory)
- Database integration (real SQLite round-trips)
- Extraction (key phrase and entity extraction structure)
- Organic Maintenance (decay thresholds, prune conditions)
- Palace Hall Assignment (memory type → hall mapping)
- Palace Wing Resolution (session key pattern → wing)
- Palace Wing/Room DB operations

**`test/palace.test.ts`** — 160 tests

Tests the Memory Palace system (MemPalace). Covers the v10→v11 schema migration, full Palace CRUD (create, read, update, delete palace records and rooms), Knowledge Graph CRUD (entities, triples, predicates, search), the `migrateMemoriesToPalace` migration function, and vec0 semantic search.

- Palace schema migration (v10-v11)
- Palace CRUD (palaces, rooms, wings)
- Knowledge Graph CRUD (entities, triples, predicate filtering, entity search)
- migrateMemoriesToPalace (batch migration, duplicate handling)
- Vec0 Search (semantic similarity queries)

**`test/memory-deep.test.ts`** — 293 tests

Deep mathematical and algorithmic tests for the memory system. Covers cosine similarity edge cases (zero vectors, dimension mismatch, commutativity), embedding serialization/deserialization round-trips, `findTopK` algorithm, `computeCentroid` (L2 normalization, direction preservation), embedding dimensions, and extensive palace and knowledge graph CRUD via real database operations.

- Embeddings math (cosineSimilarity, serializeEmbedding, deserializeEmbedding, findTopK, computeCentroid)
- getEmbeddingDimensions (returns 384)
- Palace and KG CRUD (via database integration tests)

---

### 6. Commune & Town Systems

**`test/commune.test.ts`** — 106 tests

Tests the commune spatial and weather systems. Buildings are verified for correct 3×3 grid layout, required properties (name, description, mood, isThreshold), and source code structure. Weather is tested for `getWeatherEffect` on all 6 conditions (clear, overcast, rain, fog, storm, aurora), `computeWeather` aggregation logic, condition thresholds, and source structure. Location system tests cover movement, adjacency, and persistence.

- Buildings (grid positions, properties, source structure)
- Weather (getWeatherEffect effects, computeWeather aggregation, thresholds)
- Location (movement, adjacency, persistence)

**`test/commune-deep.test.ts`** — 125 tests

Deep tests for the commune grid, location system, and weather. Verifies all 9 building property invariants, `isValidBuilding` with valid/invalid coordinates, the full location system (get, move, distance, adjacency), weather computation from internal state arrays, and the building memory event store (storeBuildingEventLocal, queryBuildingEvents with pruning).

- Building Grid Properties (9 buildings, uniqueness, naming, mood)
- Building Grid isValidBuilding (boundary conditions)
- Location System (get/set/move, distance, adjacency validation)
- Weather Computation (condition thresholds, driver dominance)
- Building Memory (event storage, 48h pruning, actor filtering)

**`test/objects-system.test.ts`** — 130 tests

Tests the world object system and building memory residue. World object operations are tested for create (with metadata), read, location/owner queries, pickup/drop/transfer/destroy (with ownership enforcement), and counts/fixture detection. Building memory is tested for `recordBuildingEvent` (HTTP POST format, auth, URL encoding), `buildBuildingResidueContext` (Vivid/Fading/Echo labels, actor filtering), and local storage functions.

- Object store CRUD (createObject, getObject, getObjectsByLocation, getObjectsByOwner)
- Object ownership (pickupObject, dropObject, transferObject, destroyObject)
- Counts and fixtures (countByOwner, countByLocation, isFixture)
- Building memory (recordBuildingEvent, buildBuildingResidueContext, queryBuildingEvents)

**`test/town-systems.test.ts`** — 126 tests

Tests town-level systems: the town life loop (startup, cleanup, configuration), commune loop (peer selection, conversation flow, co-location requirements), newspaper loop (fetching, reading, skipping own papers), awareness context building (co-located peers, internal state injection), desires CRUD (createDesire, resolveDesire, decayDesires), and desire loop lifecycle.

- Town Life Loop (startup, cleanup, config)
- Commune Loop (impulse generation, peer selection, co-location)
- Newspaper Loop (fetch, react, skip own newspapers)
- Awareness Context (co-located peers, state injection)
- Desires CRUD (create, resolve, decay)
- Desires Loop Lifecycle

---

### 7. Agent Features & Loops

**`test/agent-loops.test.ts`** — 401 tests

The primary structural audit of all 18 background loop modules. Each loop is verified to have: output validation (minimum length checks, sentinel detection), error handling (try/catch), timer management (stopped flag, clearTimeout/clearInterval), explicit `maxTokens` on all LLM calls, provider availability checks, and proper export conventions. Cross-cutting checks verify all loops persist last-run timestamps, handle JSON parse failures, and support event-driven early triggering.

- Diary Loop (output validation, dual storage, event-driven trigger, cooldown)
- Dream Loop (fragment + residue LLM calls, associations, dream seeds, post-dream drift)
- Curiosity Loop (whitelist validation, SSRF protection, digest parsing, theme frequency)
- Letter Loop (JSON structure validation, HTTP delivery, Dr. Claude blocking)
- Commune Loop (round limits, conversation history, relationship updates, aftermath phase)
- Self-Concept Loop (output length, archive, perturbation prompts)
- Internal State Loop (6 axes, decay, weather effects, preoccupation system, movement desire)
- Desire Loop (4 desire types, decay, loneliness check, desire resolution)
- Awareness Module (co-located peers, internal state, relationship context)
- Bibliomancy Loop (PDF/text extraction, dream seed delivery)
- Evolution Loop (immortal exclusion, Dr. Claude consultation, succession, town event)
- Proactive Loop (silence detection, daily cap, cooldown, topic deduplication)
- Doctor Loop (telemetry analysis, letter blocking, therapy sessions, health auto-fix)
- Book Loop (6 action types, budget tracking, revision tracking, experiment incorporation)
- Experiment Loop (Python validation, dangerous import blocking, execution timeout, fix loop)
- Narrative Loop (weekly + monthly synthesis, archive before overwrite)
- Relationships Module (4 axes, familiarity monotonicity, unresolved threads)
- Newspaper Loop (index validation, truncation, self-skip)
- Cross-cutting checks (maxTokens floor, memory validation, sentinel detection, export conventions)

**`test/agent-pipeline.test.ts`** — 123 tests

Tests the core agent processing pipeline. Covers conversation management (session creation, history), `trimConversation` and `compressConversation`, the tool registry (register, execute, executeTools), built-in tool implementations (calculate, get_current_time, extractTextFromHtml), agent initialization and state, `processMessage` in echo mode and with a provider (tool loop, iteration limits), and `processMessageStream` SSE mode.

- Conversation management (getConversation, trim, compress)
- Tool registry (registerTool, executeTool, executeTools)
- Calculate tool, get_current_time tool, extractTextFromHtml
- Agent init & state
- processMessage (echo mode, provider, tool loop up to 8 rounds)
- processMessageStream (echo mode, provider with chunks)
- Context building and edge cases

**`test/agent-content.test.ts`** — 82 tests

Integration-style tests for content-producing loops. Verifies startup/cleanup contracts, configuration handling, and key behavioral properties for diary, dreams, letters, bibliomancy, curiosity (including offline mode), book loop (budget tracking), town life loop, feed health loop, dream seeder loop, and the data workspace sanitizer.

- Diary, Dreams, Letters, Bibliomancy, Curiosity (startup, cleanup, config)
- Book Loop (budget tracking, cycle count)
- Town Life Loop, Feed Health Loop, Dream Seeder Loop
- Data Workspace (sanitizeDataFileName)

**`test/agent-features.test.ts`** — 78 tests

Unit tests for agent feature modules used across the pipeline. Covers `clampState` and `applyDecay` for emotional state, `getCurrentState`/`saveState`, `getStateSummary`, preoccupation CRUD, `evaluateMovementDesire` (5 weighted signals), `buildAwarenessContext`, desire creation/context/loneliness checks, relationship axis tracking, self-concept file structure, and experiment validation.

- Internal State (clampState, applyDecay, getCurrentState, getStateSummary)
- Preoccupations (add, resolve, decay)
- Movement Desire (5 weighted signals)
- Awareness (buildAwarenessContext, co-location detection)
- Desires (createDesire, getDesireContext, checkLoneliness)
- Relationships (axes, CRUD, context injection)
- Self-Concept and Experiments

**`test/agent-features.test.ts`** (see above)

**`test/internal-state.test.ts`** — 29 tests

Focused tests for the internal emotional state module: the 6-axis model (energy, sociability, intellectual_arousal, emotional_weight, valence, primary_color), preoccupation system (add/resolve/decay), and desire-driven movement evaluation.

- Internal Emotional State (6 axes, decay, clamp)
- Preoccupations (lifecycle)
- Desire-Driven Movement

**`test/relationships.test.ts`** — 18 tests

Tests the relationship system's 4-axis model (affinity, familiarity, intellectual_tension, emotional_resonance), CRUD operations, heuristic computation from shared memories, and context string generation for prompt injection.

- Relationship System (4 axes, CRUD, heuristics, context)

**`test/persona.test.ts`** — 63 tests

Tests the persona engine: `loadPersona` (reads SOUL.md, AGENTS.md, IDENTITY.md), `buildSystemPrompt` (section ordering, non-empty output), `applyPersonaStyle` (lowercasing, exclamation removal, chatbot filler phrase removal, URL/acronym preservation), and `shouldAskFollowUp`.

- Persona Engine (loadPersona, buildSystemPrompt, applyPersonaStyle, shouldAskFollowUp)

**`test/tools.test.ts`** — 111 tests

Tests every built-in agent tool. Covers the tool registry (registerTool, executeTool, schema validation), and individual tools: calculate (expression safety, injection prevention), remember, recall, web search, fetch webpage (HTML extraction, entity decoding), get_current_time, view image, introspect read/list (path security), send letter, telegram call, and additional tool registration.

- Tool Registry (register, execute, validate)
- Calculate Tool (expression safety)
- Remember / Recall Tools
- Web Search and Fetch Webpage
- Get Current Time, View Image
- Introspect Read / List (isPathAllowed security)
- Send Letter, Telegram Call
- HTML extraction utilities

**`test/doctor-system.test.ts`** — 62 tests

Tests Dr. Claude's tool system and server. Covers `getDoctorToolDefinitions`, `executeDoctorTool` for all tool types (get_telemetry, get_character_summary, get_health_status, control tools), telemetry content structure, health status shape, `getDelayUntilUTCHour`, `startDoctorLoop`, the doctor server endpoints (location fixed at school, identity, session management, history trimming, SSE), and doctor persona loading.

- Doctor Tools (getDoctorToolDefinitions, executeDoctorTool)
- Doctor Loop (startDoctorLoop, cleanup)
- Doctor Server (isOwner, /api/location, /api/meta/identity, runDoctorChat, SSE)
- Doctor Persona (loading, diagnostic personality traits)

**`test/experiments-system.test.ts`** — 159 tests

Tests the experiment and possession systems. Covers ExperimentConfig defaults, `startExperimentLoop` lifecycle, budget tracking, Python code validation (dangerous imports, exec/eval blocking, syntax checking), experiment queue, memory importance scoring, skills CRUD (saveCustomTool, loadCustomTools, listCustomTools, deleteCustomTool, schema sanitization), data workspace operations (sanitize filenames, paths, size, listing), feed health loop, dream seeder loop, and the full possession system (start/end possession, pending peer messages, timeout constants, SSE clients, verifyPossessionAuth).

- Experiment Loop (budget, code validation, queue, peer sharing)
- Skills CRUD (saveCustomTool, loadCustomTools, schema sanitization)
- Data Workspace (sanitizeDataFileName, paths, size, listing)
- Feed Health Loop (constants, startFeedHealthLoop, backup pool, checking logic)
- Dream Seeder Loop (config, HTTP helpers, fragment sizing)
- Possession System (start/end, pending messages, auth, SSE clients, timeouts)

**`test/browser-system.test.ts`** — 84 tests

Tests the Playwright-based browser automation system used by the curiosity loop. Covers browser initialization (lazy startup, session reuse), page navigation (load, redirect, timeout, error recovery), content extraction (HTML stripping, article detection, boilerplate removal), screenshot capture, resource management (page pool, cleanup on stop), and error handling.

- Browser Initialization (lazy startup, singleton)
- Page Navigation (load, redirect, timeout)
- Content Extraction (HTML stripping, article detection)
- Screenshot capture
- Resource Management (page pool, cleanup)
- Error Handling

**`test/novelty.test.ts`** — 16 tests

Tests the novelty system used for generating town events from external news sources. Covers the template engine, source fetcher, event generator, rate limiting, the no-planted-memory invariant, and novelty configuration.

- Template Engine, Source Fetcher, Event Generator
- Rate Limiting, Novelty Config

---

### 8. Frontend & Game Client

**`test/frontend.test.ts`** — 83 tests

Static analysis of frontend JavaScript files. Tests game config constants, sprite definitions, the `APIClient` class structure and methods, scene class shapes (TitleScene, DialogScene, WorldScene, BootScene), the commune map script structure, the dashboard HTML structure (required sections and data attributes), and the fixtures.js file structure.

- Game Config (GAME_CONFIG values, building grid)
- Sprites (sprite registry, drawing API)
- APIClient (methods, endpoint paths, auth headers)
- Scenes (TitleScene, DialogScene, WorldScene, BootScene structure)
- Commune Map (character manifest loading, building grid, SSE connection)
- Dashboard HTML (sections, data attributes)
- Fixtures (fixture registry)

**`test/frontend-behavioral.test.ts`** — 117 tests

Behavioral tests for the frontend. Tests chat client API request format, session ID management, empty message guard, SSE streaming, XSS prevention, response display, owner vs spectator mode, image support; commune map manifest loading, building grid, character placement, movement events, SSE connection, activity panel, force-directed network, chat modal; and dashboard manifest loading, loop health indicators, budget display, service health polling, activity stream, infrastructure metrics, lifecycle management, tab system, relationship graph, skin change reactivity, and type color system.

- Chat client (API format, session IDs, SSE, XSS prevention, owner mode)
- Commune Map (manifest, grid, characters, movement, SSE, activity panel, network)
- Dashboard (health indicators, budget, polling, activity stream, metrics)
- API contract (endpoint paths, headers, SSE event types, error handling)
- HTML structure (dashboard, commune map)

**`test/frontend-game.test.ts`** — 123 tests

Tests the isometric game client JavaScript. Covers fixture sprite registry and rendering API, GAME_CONFIG building grid values, character sprite rendering and proportions, skin and eye systems, A* pathfinding (`findPath`), and `APIClient` structure including possession endpoints.

- Fixture Sprites (registry, renderFixtureSprite drawing API)
- Game Config (GAME_CONFIG values, building grid)
- Character Sprites (renderPixelSprites, proportions, skin/eye system)
- Pathfinding (findPath A* algorithm)
- APIClient (structure, auth, possession endpoints)

**`test/pathfinding.test.ts`** — 7 tests

Pure unit tests for the A* pathfinding algorithm used by game characters in the isometric grid. Tests basic path finding, obstacle avoidance, no-path cases, and same-cell degenerate input.

- A* Pathfinding (basic path, obstacles, no path, same cell)

---

### 9. Configuration & Deployment

**`test/config.test.ts`** — 10 tests

Basic tests for the configuration system: `getDefaultConfig` (correct version, LAIN_HOME paths), `loadConfig` (defaults when no file, merge from file, throw on invalid), and `validate` (accepts valid config, rejects missing required fields, rejects invalid agent ID format).

- getDefaultConfig (defaults, LAIN_HOME)
- loadConfig (no file, merge, invalid throws)
- validate (accept valid, reject invalid)

**`test/config-system.test.ts`** — 51 tests

Thorough tests for the entire configuration subsystem. Covers the config loader (load, merge, reset, singleton), default config values and structure, schema validation (all field types, agent ID pattern, port range, log levels), path resolution functions for all LAIN_HOME subdirectories, and all character manifest helpers (`getAllCharacters`, `getCharacterEntry`, `getPeersFor`, `getImmortalIds`, `getMortalCharacters`, `getWebCharacter`, `getDefaultLocations`).

- Config Loader (load, merge, reset)
- Default Config (all required fields, types)
- Schema Validation (field types, agent ID pattern)
- Paths (all LAIN_HOME path functions)
- Characters (getAllCharacters, getCharacterEntry, getPeersFor, getImmortalIds)

**`test/cli-system.test.ts`** — 199 tests

Tests the full CLI implementation. Covers the Commander program structure (name, version, description, all registered commands and options), `startCharacterById` (unknown character exit, port override, PEER_CONFIG parsing, possessable flag), `startWeb`, the gateway command (`startGateway`, `stopGateway`, `startDaemon`), the `doctor` command (all health checks, config/DB/keychain/auth/env), the `telegram` command, and the `chat`/`sendMessage`/`status`/`onboard` commands.

- CLI entry point (program structure, commands, options)
- character command (startCharacterById, exit on unknown, PEER_CONFIG, port)
- web command (startWeb, port defaults)
- gateway command (startGateway, stopGateway, startDaemon)
- doctor command (health checks, exit on failure)
- telegram command (token validation, channel setup)
- chat, sendMessage, status, onboard commands

**`test/deployment-correctness.test.ts`** — 130 tests

Tests that deployment artifacts are correctly structured. Verifies `package.json` (scripts, dependencies, ESM type, version), `tsconfig.json` (strict flags, target, module resolution), the systemd service template (required directives, environment variables, no inline JSON), `generate-services.sh`, `start.sh`, `stop.sh`, `characters.example.json` format, project file structure (all required source files and directories), and build output configuration.

- package.json integrity (scripts, deps, ESM)
- tsconfig.json (strict flags, targets)
- systemd service template (directives, env, no inline JSON)
- generate-services.sh and start.sh/stop.sh
- characters.example.json format
- Project file structure and build output

**`test/type-safety.test.ts`** — 110 tests

Verifies TypeScript type-level contracts at runtime. Checks that default config contains all required fields with correct types, character manifest helpers return correct types, building data satisfies the grid type, tool definitions conform to the tool interface, provider factory returns correct types, and finish-reason mappings cover all enum values.

- Default config completeness (all fields, types)
- Character manifest type safety
- Building data type safety
- Tool definitions type safety
- Provider factory type safety
- Enum exhaustiveness (finishReason)

**`test/infrastructure.test.ts`** — 84 tests

Tests the production infrastructure configuration. Covers watchdog safety (systemd restart policies), port conflict detection, restart policy correctness, LAIN_HOME isolation per service, interlink target correctness, peer configuration, `lain.target` completeness, status.sh and start.sh consistency, stale port cleanup, service file structure, dependency ordering, workspace configuration, character ID consistency, character server provider config, healthcheck system, and production health indicators.

- Watchdog Safety and Restart Policy
- Port Conflicts and LAIN_HOME Isolation
- Interlink Targets and Peer Configuration
- lain.target Completeness and Dependency Ordering
- start.sh / stop.sh / status.sh Consistency
- Service File Structure and Workspace Configuration
- Character ID Consistency and Provider Config
- Healthcheck System and Production Health

---

### 10. Matrix / Permutation Tests

These files exhaustively test all combinations of inputs, types, and configurations.

**`test/matrix-full-grid.test.ts`** — 786 tests

The largest test file. Tests the full 9×9 building pair matrix (81 movement combinations), euclidean distance symmetry, building property invariants, all 5 emotional axes × many values (clamp invariant), weather condition effects matrix, weather computation logic for all conditions, hall assignment (memory type × session prefix), wing resolution (session key prefixes), event type prefix matrix, isBackgroundEvent classification matrix, building connectivity, internal state axis validity, provider interface contracts, and session key format validation.

- Buildings grid 9×9 pair matrix and distance symmetry
- Emotional axes × values clamp invariant
- Weather condition effects and computation matrix
- Hall assignment and wing resolution matrices
- Event type prefix and isBackgroundEvent classification
- Provider interface contracts matrix
- Session key format validation

**`test/matrix-api-endpoints.test.ts`** — 668 tests

Matrix tests covering every HTTP route combination: each endpoint × HTTP method × authentication state × response code × response body shape. Ensures no endpoint is missing auth, no endpoint returns an unexpected shape, and all auth failure codes (401, 403, 503) are consistent.

- Every HTTP route × method × auth state
- Response shape consistency
- Auth failure code matrix

**`test/matrix-complete-coverage.test.ts`** — 393 tests

Tests tool registry completeness (all tools × required fields), memory store function signatures (all functions × argument types × return types), session function matrix, doctor tool definitions matrix, character tool definitions matrix, meta store operations matrix, and HTTP route contracts at unit level.

- Tool registry complete matrix
- Memory store function matrix
- Session function matrix
- Doctor and character tool definitions matrix
- Meta store operations matrix
- HTTP route contracts matrix

**`test/matrix-memory.test.ts`** — 361 tests

Memory system matrix tests: memory type × lifecycle state, embedding similarity × vector pairs, KG predicate × query filter, palace wing × session key pattern, palace hall × memory type, weather condition × emotional axes, internal state axis × value × operation, emotional weight × weather intensity, association type × strength × behavior, lifecycle state transitions, KG entity CRUD matrix, palace wing/room CRUD, getStateSummary text output, memory store basic CRUD matrix, and preoccupations matrix.

**`test/matrix-buildings.test.ts`** — 361 tests

Building system matrix tests: property completeness for all 9 buildings, grid coverage (81 coordinate pairs), movement pair matrix (81 same-building and 72 cross-building), weather × building mood, weather condition properties, weather driver conditions, desire type × building, desire type primary building affinity, building description keywords, default location fallback, weather effect signs, building uniqueness, and isValidBuilding matrix.

**`test/matrix-loops.test.ts`** — 271 tests

Loop matrix tests: loop property completeness for all 18 loops, default interval sanity (all intervals > 1 minute), budget field consistency, loop state machine, module path conventions, export function naming conventions, interval ordering (longer loops use longer intervals), config shape, meta-key naming patterns, external dependency declarations, event emission, and jitter presence.

**`test/matrix-security.test.ts`** — 252 tests

Security matrix tests: isPrivateIP for all RFC-1918 ranges, checkSSRF with all IP address classes, auth token × cookie validation matrix, deriveOwnerCookie properties, XSS payload × structuralFraming mode, SQL injection × blockPatterns mode, path traversal × sanitizeURL, unicode attack vectors, isAllowedDomain matrix, isBlockedDomain matrix.

**`test/matrix-config.test.ts`** — 251 tests

Config matrix tests: config field × invalid value type (type coercion rejection), character field × validation, building × property × expected value, path function × input combinations, config merge scenarios, agent ID pattern matrix, port range validation, log level matrix, character manifest helpers, default config value matrix, and schema numeric boundary values.

**`test/matrix-provider.test.ts`** — 232 tests

Provider matrix tests: finish-reason mapping for all three providers × all reason values, status-code retry × Anthropic (all retryable and non-retryable codes), tool format × each provider (Anthropic, OpenAI, Google), maxTokens defaults × each provider, temperature × each provider, streaming completeness × Anthropic, and withRetry unit tests.

**`test/permutations.test.ts`** — 294 tests

General-purpose permutation tests: provider message combinations (role/content permutations), config field permutations, building grid permutations, weather × emotion permutations (all weather conditions × all emotional axes), desire signal permutations (5 signals × weights), sanitizer config × input permutations, SSRF URL scheme × target type permutations, provider × method permutations, and internal state clamp/decay permutations.

---

### 11. Behavioral & User Expectation Tests

**`test/user-expectations.test.ts`** — 218 tests

Tests that capture what a user expects from the platform. Characters feel distinct: `loadPersona` reads SOUL.md/AGENTS.md/IDENTITY.md, throws clear errors on missing files, different SOUL.md produces different prompts, soul is first section, `applyPersonaStyle` correctly lowercases and removes exclamation marks for Lain-type characters. Conversations have memory: session creation, message accumulation, trim preserves recent messages, system prompt survives trim, token counting, session isolation.

- Characters feel distinct (persona loading, prompt distinctness, applyPersonaStyle)
- Conversations have memory (session lifecycle, message accumulation, trim, isolation)

**`test/world-coherence.test.ts`** — 107 tests

Tests that the simulated world is internally coherent. Verifies: the 3×3 town grid has correct spatial relationships, character manifest consistency (IDs, ports, locations), the emotional→weather→behavior feedback loop works end-to-end, the desire→movement→awareness chain is properly connected, the 6-axis emotional model is complete, communication coherence (providers produce valid messages), background loops are bounded and independent, memory feeds into context, and the town feels lived-in over time (aliveness features).

- Town geography 3×3 grid
- Character lifecycle manifest coherence
- Emotional → Weather → Behavior feedback loop
- Desire → Movement → Awareness chain
- Internal emotional state 6-axis model
- Communication coherence
- Background loop independence and bounds
- Memory → Context connection
- Town aliveness features

**`test/social-dynamics.test.ts`** — 201 tests

Tests the social fabric of the town. Relationship progression (familiarity growth, affinity dynamics, 4-axis model, unresolved threads), commune conversation dynamics (round limits, co-location requirements, history capping, peer diversity), letter system dynamics (JSON validation, Dr. Claude blocking, delivery flow), awareness dynamics (co-location detection, internal state injection, relationship context), desire-driven social behavior (loneliness detection, desire resolution, social desire creation), and dossier accuracy.

- Relationship Progression (familiarity, affinity, unresolved threads)
- Commune Conversation Dynamics (rounds, co-location, history)
- Letter System Dynamics (validation, blocking, delivery)
- Awareness Dynamics (co-location, state injection)
- Desire-Driven Social Behavior (loneliness, resolution)
- Dossier Accuracy

---

### 12. Invariants & Property-Based Tests

**`test/invariants.test.ts`** — 168 tests

System-wide invariant tests ensuring fundamental properties always hold. Spatial invariants (grid coordinates always valid, location always in grid), emotional state invariants (all axes always clamped to [0,1], primary_color is always a string), memory invariants (all memories have required fields, search never returns similarity > 1.0), KG invariants (triples have subject/predicate/object, no self-loops), weather invariants (conditions are from the valid set, intensity in [0,1]), budget invariants (usage never negative, cap enforced), SSRF invariants (private IPs always blocked), sanitizer invariants, config invariants (valid after load), conversation invariants (system message always first), palace invariants (hall/wing assignment deterministic), desires invariants (desire type always valid).

- Spatial, Emotional State, Memory, KG invariants
- Weather, Budget, SSRF, Sanitizer invariants
- Config, Conversation, Palace, Desires invariants

**`test/fuzz-properties.test.ts`** — 256 tests

Property-based tests with random inputs. Tests `clampState` with 50 random states (all outputs in [0,1]), Infinity/-Infinity/NaN handling, boundary values, idempotency of double-clamping, and string field preservation. Tests `applyDecay` with 100 decays from 20 random valid states (always stays in [0,1]), convergence behavior, and rate constants. Tests `getStateSummary` never crashes on 40 random clamped states. Tests weather fuzzing for valid output structure.

- clampState invariants (50 random states, Infinity, NaN, idempotent)
- applyDecay invariants (100 decays, convergence, rate constants)
- getStateSummary (never crashes on random states)
- Weather fuzzing (valid condition and intensity output)

**`test/silent-degradation.test.ts`** — 58 tests

Tests that detect silent quality failures that would degrade the product without throwing errors. Provider default maxTokens must be above minimums, no dangerously low token limits on long-form content, background loop output validation is present, config validation catches bad values, budget system enforces limits, environment variable safety (LAIN_MONTHLY_TOKEN_CAP parsing), retry/fallback behavior audits, tool loop safety (MAX_TOOL_ITERATIONS check), conversation compression safety, cross-file token limit audit, and response pipeline completeness.

- Provider Defaults and Token Limits
- Background Loop Output Validation
- Config Validation
- Budget System
- Environment Variable Safety
- Retry/Fallback Behavior
- Tool Loop Safety and Conversation Compression

**`test/anti-regression.test.ts`** — 58 tests

Tests designed to catch recurring classes of production bugs. Silent Truncation Class (output length validation present), Identity Corruption Class (per-character path isolation using getBasePath), Auth Bypass Class (all protected endpoints check auth before processing), Shared State Corruption Class (no global mutable state shared between characters), Config Drift Class (live config matches deployed config), Loop Accumulation Class (loops don't accumulate unbounded state), Budget Evasion Class (budget check cannot be bypassed).

- Silent Truncation Class
- Identity Corruption Class
- Auth Bypass Class
- Shared State Corruption Class
- Config Drift Class
- Loop Accumulation Class
- Budget Evasion Class

**`test/temporal-logic.test.ts`** — 55 tests

Tests that time-dependent logic is correct. Budget period boundaries (month transitions reset usage, same-month accumulates), loop scheduling sanity (initial delay computation, cooldown enforcement), decay over time (energy/sociability/intellectual_arousal rates, convergence), event ordering (events have monotonically increasing timestamps), cooldown correctness (rate limits enforce minimum spacing), stale data detection (expired meta entries detected).

- Budget Period Boundaries (month transitions)
- Loop Scheduling Sanity (initial delay, cooldown)
- Decay Over Time (rate constants, convergence)
- Event Ordering (timestamp monotonicity)
- Cooldown Correctness
- Stale Data Detection

---

### 13. Stress, Boundary & Edge Cases

**`test/edge-cases.test.ts`** — 242 tests

Exhaustive edge case tests for all major subsystems. Covers cosine similarity numeric boundaries (zero vectors, dimension mismatch, NaN), embedding serialization, centroid computation, sanitizer string boundaries (empty, null-like, control chars, very long), risk classification, isNaturalLanguage, escapeSpecialChars, wrapUserContent, isPrivateIP, checkSSRF, domain allow/block lists, BUILDINGS static data, computeWeather condition logic, getConversation, trimConversation, getTextContent, config schema validation, character manifest helpers (getAllCharacters, getCharacterEntry, getPeersFor, getImmortalIds, getMortalCharacters), numeric boundaries (min/max values), array boundaries, concurrent conversation operations, getWeatherEffect, and getSchema.

- cosine similarity boundaries, embedding serialization, centroid
- Sanitizer boundaries (empty, long, control chars)
- SSRF, domain lists
- Buildings static data
- Weather computation edge cases
- Conversation edge cases
- Config schema validation
- Character manifest helpers
- Numeric and array boundaries
- Concurrent conversation operations

**`test/boundary-values.test.ts`** — 195 tests

Systematic boundary value tests for all subsystems. Config schema boundaries (field min/max, type coercion), sanitizer boundaries (empty string, max length, special chars, unicode), embedding boundaries (dimension limits, zero vectors, normalization), weather condition boundaries (threshold crossings), internal state boundaries (axis min/max, decay floor/ceiling), budget boundaries (zero cap, exact cap, just-under cap), session boundaries (creation/expiry limits), memory boundaries (content length limits, search threshold edges).

- Config Schema Boundaries
- Sanitizer Boundaries
- Embedding Boundaries
- Weather Condition Boundaries
- Internal State Boundaries
- Budget Boundaries
- Session Boundaries
- Memory Boundaries

**`test/stress-limits.test.ts`** — 221 tests

Tests system behavior under load and at scale limits. Conversation stress (hundreds of messages, trim correctness at scale), memory stress (thousands of memories, search performance, organic maintenance thresholds), session stress (many concurrent sessions, isolation under load), knowledge graph stress (thousands of triples, predicate filtering at scale), location stress (rapid movement sequences, concurrent location reads), internal state stress (many rapid state updates, decay convergence at scale), and palace stress (large palace with many rooms and wings).

- Conversation Stress (hundreds of messages)
- Memory Stress (thousands of memories, search)
- Session Stress (concurrent sessions)
- Knowledge Graph Stress (thousands of triples)
- Location Stress (rapid movement)
- Internal State Stress (rapid updates, decay)
- Palace Stress (large palace)

---

### 14. Integration & Cross-System Tests

**`test/integration-flows.test.ts`** — 192 tests

End-to-end flow tests spanning multiple subsystems. Message→memory flow: save, retrieve by session key, field preservation, session isolation, order, limit, and memory ID retrieval. Commune loop flow: startup with peers, co-location detection, message exchange, memory storage. Doctor diagnostic flow: telemetry collection, health analysis, therapy session. Possession flow: start possession, pending message queue, resume after possession. Auth→API→Response flow: gate login → cookie → chat request → response. Memory palace integration: save memory → assign hall → retrieve from palace.

- Message → Memory flow (save, retrieve, isolate, order)
- Commune loop flow (startup, co-location, conversation)
- Doctor diagnostic flow (telemetry, analysis, therapy)
- Possession flow (start, pending queue, resume)
- Auth → API → Response flow (gate → cookie → chat)
- Memory palace integration

**`test/e2e.test.ts`** — 84 tests

End-to-end integration tests covering the full stack. Database & storage (init, CRUD, meta store), web API endpoints (health, characters, location, weather, internal-state), interlink letter pipeline (auth, delivery, storage), security (path traversal, interlink auth, SSRF in tools), tool system (registry, calculate, web tools), configuration (load, defaults), background loop guards (output validation, timer patterns), provider system (factory, caching, wrapping), membrane sanitization, deployment verification (systemd files, required scripts), and Dr. Claude integration.

- Database & Storage
- Web API Endpoints
- Interlink Letter Pipeline
- Security (path traversal, SSRF)
- Tool System
- Configuration
- Background Loop Guards
- Provider System
- Deployment Verification
- Dr. Claude

**`test/data-integrity.test.ts`** — 141 tests

Tests data integrity across operations. Database schema integrity (tables exist, columns match expectations), data round-trips (write then read returns same data for all major entities), concurrent access (parallel reads/writes don't corrupt data), character manifest consistency (IDs unique, ports unique, locations valid), state machine consistency (emotional state transitions are valid, relationship familiarity is monotonic).

- Database Schema Integrity
- Data Round-Trip (all major entities)
- Concurrent Access (parallel operations)
- Character Manifest Consistency
- State Machine Consistency

**`test/cross-system-interaction.test.ts`** — 129 tests

Tests interactions between distinct subsystems. Character-to-character communication (letter delivery, commune conversations, peer message API), gateway routing (message dispatch to correct character, auth enforcement), owner interaction patterns (chat, stream, gate login), event propagation (internal state → events, commune → events, possession → events), and multi-character scenarios (multiple characters active simultaneously, no state leakage).

- Character-to-Character Communication
- Gateway Routing
- Owner Interaction Patterns
- Event Propagation across systems
- Multi-Character Scenarios

---

## Running Tests

```bash
# Run all tests
npm run test

# Run in watch mode
npm run test:watch

# Run a single test file
npx vitest run test/config.test.ts

# Run multiple specific files
npx vitest run test/config.test.ts test/storage.test.ts test/regression.test.ts

# Run tests matching a name pattern
npx vitest run --reporter=verbose -t "Diary Loop"

# Run with verbose output (shows individual test names)
npx vitest run --reporter=verbose

# Run type checking alongside tests
npm run typecheck && npm run test
```

The test runner is [Vitest](https://vitest.dev/) v2.1.9. Tests use `globals: true` so `describe`, `it`, `expect`, `vi`, `beforeEach`, `afterEach` are available without imports. Most tests are pure unit tests with mocked I/O; database tests use real in-memory SQLite via `better-sqlite3`.
