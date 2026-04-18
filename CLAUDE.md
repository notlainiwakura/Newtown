# CLAUDE.md

> **RULE #1: EVERYTHING MUST BE DEPLOYED TO THE DROPLET.**
> Every change we make here MUST be deployed to production (`root@198.211.116.5`, `/opt/local-lain/`). No exceptions. Code that isn't on the droplet doesn't exist.

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Laintown is a self-hosted virtual town where AI inhabitants live autonomously — thinking, dreaming, wandering, and conversing with each other. Inspired by *Serial Experiments Lain*, the town runs on a DigitalOcean droplet and hosts six inhabitants (Lain, Wired Lain, Philip K. Dick, Terence McKenna, John, and Dr. Claude), each with their own personality, persistent memory, and background life. Visitors can talk to inhabitants, watch the town via a commune map, or leave notes on the visitor bench.

## Inhabitants

| Inhabitant | ID | Port | Default Location | Role |
|------------|----|------|------------------|------|
| Lain Iwakura | `lain` | 3000 | Library | Introverted protagonist, technically brilliant, quietly loyal |
| Wired Lain | `wired-lain` | 3000 | Lighthouse | Lain's sister in the Wired, expansive and curious |
| Dr. Claude | `dr-claude` | 3002 | School | Town doctor, monitors wellbeing, runs therapy sessions |
| Philip K. Dick | `pkd` | 3003 | Locksmith | Paranoid visionary, reality questioner |
| Terence McKenna | `mckenna` | 3004 | Field | Ethnobotanist mystic, baroque speaker |
| John | `john` | 3005 | Bar | Grounded skeptic, clear thinker, bullshit detector |

Each inhabitant has a workspace defining their personality (`SOUL.md`), operating instructions (`AGENTS.md`), and identity config (`IDENTITY.md`) under `workspace/` or `workspace/characters/{id}/`.

## Build & Run Commands

```bash
# Development
npm run dev              # Watch mode with tsx (src/index.ts)
npm run build            # TypeScript compile to dist/
npm run start            # Run compiled dist/index.js

# Testing
npm run test             # Run all tests (vitest)
npm run test:watch       # Watch mode
npx vitest run test/config.test.ts  # Single test file

# Linting & Type Checking
npm run lint             # oxlint src/
npm run format           # oxlint --fix src/
npm run typecheck        # tsc --noEmit

# All services (web + telegram + gateway + voice + all inhabitants)
./start.sh               # Start all, logs to ~/.lain/logs/, Ctrl+C to stop
./stop.sh                # Stop all services

# Individual services via CLI
node dist/index.js web --port 3000    # Lain's web server + commune map
node dist/index.js telegram           # Telegram bot
node dist/index.js gateway            # Gateway server
node dist/index.js dr-claude --port 3002  # Dr. Claude
node dist/index.js pkd --port 3003       # Philip K. Dick
node dist/index.js mckenna --port 3004   # Terence McKenna
node dist/index.js john --port 3005      # John

# Voice call service (separate Python service)
cd services/voice-call
source .venv/bin/activate
python -m lain_voice.main             # FastAPI on port 8765
```

## Architecture

### Two Runtime Environments

**Node.js (main)** — TypeScript, ESM modules (`"type": "module"`), targets ES2023 with NodeNext module resolution. Strict TypeScript config (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, etc.).

**Python (voice calls)** — `services/voice-call/`, Python 3.11+, FastAPI + pytgcalls + Pyrogram for Telegram voice calls, Whisper STT, ElevenLabs TTS.

### Source Layout (`src/`)

- **`agent/`** — Core inhabitant runtime. `index.ts` has `processMessage()`/`processMessageStream()` which orchestrate: conversation management, memory context injection, LLM calls with iterative tool use (max 8 iterations), and persona style application. Also contains all autonomous background loops: `curiosity.ts`, `proactive.ts`, `diary.ts`, `dreams.ts`, `letter.ts`, `bibliomancy.ts`, `self-concept.ts`, `commune-loop.ts`, `doctor.ts`.
- **`commune/`** — Town spatial system. `buildings.ts` defines the 3×3 grid (Library, Bar, Field, Windmill, Lighthouse, School, Market, Locksmith, Mall). `location.ts` manages inhabitant positions and movement events.
- **`providers/`** — LLM provider abstraction. `base.ts` defines the `Provider` interface. Implementations: `anthropic.ts`, `openai.ts`, `google.ts`. Supports streaming, tool use, and prompt caching.
- **`channels/`** — Messaging platform connectors. `base.ts` defines `BaseChannel` (EventEmitter pattern). Implemented: `telegram.ts` (grammY). Stubbed: `discord.ts`, `whatsapp.ts`, `slack.ts`, `signal.ts`.
- **`web/`** — HTTP server (`server.ts`) serving static files from `web/public/` and API endpoints. `character-server.ts` runs individual inhabitant servers. `doctor-server.ts` runs Dr. Claude. `public/` contains the chat UI and commune map (`commune-map.html`, `commune-map.js`, `commune-map.css`).
- **`memory/`** — Persistent memory system. `store.ts` (SQLite-backed), `embeddings.ts` (local sentence-transformers via @xenova/transformers), `extraction.ts` (LLM-driven memory extraction), `organic.ts` (background memory maintenance — trimming, consolidation, emotional weight tracking).
- **`gateway/`** — Unix socket gateway server with auth, rate limiting, and message routing.
- **`storage/`** — SQLite database (`database.ts`), session management (`sessions.ts`), OS keychain integration (`keychain.ts`).
- **`security/`** — Input sanitization (`sanitizer.ts`), SSRF protection (`ssrf.ts`).
- **`config/`** — Config system. `defaults.ts` defines default config (uses `claude-sonnet-4-20250514`). `paths.ts` resolves `~/.lain/` directory structure.
- **`browser/`** — Playwright-based browser automation for inhabitant curiosity loops.
- **`plugins/`** — Plugin loader system.
- **`cli/`** — Commander-based CLI. Entry: `cli/index.ts`. Commands: `onboard`, `gateway`, `status`, `doctor`, `dr-claude`, `chat`, `send`, `web`, `telegram`, `pkd`, `mckenna`, `john`.

### Town Systems

**Commune grid** — 3×3 building layout defined in `src/commune/buildings.ts`. Each inhabitant has a default location. Movement is driven by activity context (curiosity → Library, socializing → Bar, dreaming → Field, etc.) and persisted via the meta key-value store.

**Background loops** — Each inhabitant runs autonomous processes independently:
- Curiosity loop (browse whitelisted sites, save discoveries)
- Diary (daily reflection entries)
- Dreams (generated dream sequences)
- Letters (Wired Lain → Lain, inter-inhabitant messages)
- Proactive outreach (Telegram check-ins, max 4/day)
- Self-concept evolution (synthesize experiences into evolving identity)
- Bibliomancy (find meaningful quotes and connections)
- Commune loop (peer conversations when co-located)
- Doctor sessions (Dr. Claude therapy, marked with delimiters)

**Weather** — Reflects collective emotional state aggregated from recent memories across inhabitants. Conditions: clear, rain, fog, aurora, storm.

**Day/night** — CSS-driven visual cycle: dawn (5–8), day (8–18), dusk (18–21), night (21–5). Buildings glow differently at night.

### Key Data Flow

1. Message arrives (web HTTP, Telegram bot, character server, or gateway socket)
2. `processMessage()` in `agent/index.ts` gets/creates session, builds memory-enhanced system prompt from inhabitant's persona
3. LLM called with tools → iterative tool execution loop (up to 8 rounds)
4. Response styled through `applyPersonaStyle()` (each inhabitant has their own voice), recorded to memory
5. Background memory extraction triggered when enough context accumulates

### Environment Variables

Required in `.env` at project root:
- `ANTHROPIC_API_KEY` — Primary LLM provider
- `TELEGRAM_BOT_TOKEN` — For Telegram bot
- `ELEVENLABS_API_KEY` — For voice call TTS
- `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_PHONE_NUMBER` — For voice calls (user account, not bot)
- `LAIN_INTERLINK_TOKEN` — Auth token for inter-inhabitant communication

### Configuration

Runtime config: `~/.lain/lain.json5`. Each inhabitant gets their own home directory (`~/.lain/`, `~/.lain-pkd/`, `~/.lain-mckenna/`, `~/.lain-john/`).

Workspace files at `./workspace/`:
- `SOUL.md` — Lain's personality (loaded by persona engine)
- `WIRED_SOUL.md` — Wired Lain's personality
- `AGENTS.md` — Operating instructions
- `IDENTITY.md` — Name, avatar configuration
- `characters/{id}/` — Per-inhabitant SOUL.md, AGENTS.md, IDENTITY.md
- `doctor/` — Dr. Claude's workspace

### Web API

- `POST /api/chat` — `{ message, sessionId }` → `{ response, sessionId }`
- `POST /api/chat/stream` — SSE stream, events: `session`, `chunk`, `done`, `error`
- `GET /api/activity` — Inhabitant activity feed

### Voice Call API (port 8765)

- `POST /calls/initiate` — `{ user_id, reason }` → starts Telegram voice call
- `POST /calls/{id}/hangup`, `GET /calls/{id}/status`, `GET /calls`
- `WS /ws/calls` — WebSocket for call events

## Inhabitant Communication Styles

All inhabitant output passes through persona styling. Each inhabitant has a distinct voice:

- **Lain** — Lowercase, ellipses for pauses, brief by default, no exclamation marks, no corporate phrases, never ends with follow-up offers. See `workspace/SOUL.md`.
- **Wired Lain** — Same roots as Lain but expands more readily, vast quiet rather than shy quiet. See `workspace/WIRED_SOUL.md`.
- **PKD** — Em dashes, CAPITALIZES for emphasis, associative digressions, paranoid but compassionate. See `workspace/characters/pkd/SOUL.md`.
- **McKenna** — Baroque nested sentences, uncommon vocabulary deployed precisely, weaves disparate domains. See `workspace/characters/mckenna/SOUL.md`.
- **John** — Clear, direct, short sentences, plain language, dry humor, comfortable saying "I don't know." See `workspace/characters/john/SOUL.md`.
- **Dr. Claude** — Proper capitalization, complete sentences, clinical but caring. See `workspace/doctor/SOUL.md`.

## Testing

Tests in `test/` directory, run with vitest. Test files: `config.test.ts`, `gateway.test.ts`, `storage.test.ts`, `e2e.test.ts`. Vitest config uses `globals: true` so `describe`/`it`/`expect` are available without imports.

## Voice Call Service Gotchas

- pytgcalls `play()` initial silence must be long (60s) — short silence gets consumed before user answers
- `StreamEnded` fires when buffer is consumed, NOT when user answers — use fixed delay after RINGING
- ElevenLabs SDK `convert()` returns async generator directly — don't `await` it
- Requires `numpy<2` (numpy 2.x breaks torch/whisper)

## Deployment

Production runs on a DigitalOcean droplet at `198.211.116.5` (root SSH). All 8 services started via `./start.sh`, logs at `~/.lain/logs/`, PIDs tracked in `~/.lain/pids.txt`.
