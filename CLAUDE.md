# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Lain is a self-hosted, privacy-first personal AI assistant embodying Lain Iwakura from *Serial Experiments Lain*. It unifies messaging across platforms (Telegram, WhatsApp, Discord, Signal, Slack) into a single agent with persistent memory, tool use, and a web chat interface.

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

# All services (web + telegram + gateway + voice)
./start.sh               # Start all, logs to ~/.lain/logs/, Ctrl+C to stop
./stop.sh                # Stop all services

# Individual services via CLI
node dist/index.js web --port 3000    # Web chat interface
node dist/index.js telegram           # Telegram bot
node dist/index.js gateway            # Gateway server

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

- **`cli/`** — Commander-based CLI. Entry: `cli/index.ts`. Commands: `onboard`, `gateway`, `status`, `doctor`, `chat`, `send`, `web`, `telegram`.
- **`agent/`** — Core agent runtime. `index.ts` has `processMessage()`/`processMessageStream()` which orchestrate: conversation management, memory context injection, LLM calls with iterative tool use (max 8 iterations), and persona style application.
- **`providers/`** — LLM provider abstraction. `base.ts` defines the `Provider` interface. Implementations: `anthropic.ts`, `openai.ts`, `google.ts`. Supports streaming, tool use, and prompt caching.
- **`channels/`** — Messaging platform connectors. `base.ts` defines `BaseChannel` (EventEmitter pattern). Implemented: `telegram.ts` (grammY). Stubbed: `discord.ts`, `whatsapp.ts`, `slack.ts`, `signal.ts`.
- **`web/`** — HTTP server (`server.ts`) serving static files from `web/public/` and API endpoints (`/api/chat`, `/api/chat/stream` via SSE). Initializes database, agent, proactive loop, and curiosity loop on startup.
- **`memory/`** — Persistent memory system. `store.ts` (SQLite-backed), `embeddings.ts` (local sentence-transformers via @xenova/transformers), `extraction.ts` (LLM-driven memory extraction from conversations).
- **`gateway/`** — Unix socket gateway server with auth, rate limiting, and message routing.
- **`storage/`** — SQLite database (`database.ts`), session management (`sessions.ts`), OS keychain integration (`keychain.ts`).
- **`security/`** — Input sanitization (`sanitizer.ts`), SSRF protection (`ssrf.ts`).
- **`config/`** — Config system. `defaults.ts` defines default agent config (uses `claude-sonnet-4-20250514`). `paths.ts` resolves `~/.lain/` directory structure.
- **`browser/`** — Playwright-based browser automation.
- **`plugins/`** — Plugin loader system.

### Key Data Flow

1. Message arrives (web HTTP, Telegram bot, or gateway socket)
2. `processMessage()` in `agent/index.ts` gets/creates session, builds memory-enhanced system prompt
3. LLM called with tools → iterative tool execution loop (up to 8 rounds)
4. Response styled through `applyPersonaStyle()`, recorded to memory
5. Background memory extraction triggered when enough context accumulates

### Environment Variables

Required in `.env` at project root:
- `ANTHROPIC_API_KEY` — Primary LLM provider
- `TELEGRAM_BOT_TOKEN` — For Telegram bot channel
- `ELEVENLABS_API_KEY` — For voice call TTS
- `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_PHONE_NUMBER` — For voice calls (user account, not bot)

### Configuration

Runtime config: `~/.lain/lain.json5`. Workspace files at `./workspace/`:
- `SOUL.md` — Lain's personality and system prompt (loaded by persona engine)
- `AGENTS.md` — Operating instructions
- `IDENTITY.md` — Name, avatar configuration

### Web API

- `POST /api/chat` — `{ message, sessionId }` → `{ response, sessionId }`
- `POST /api/chat/stream` — SSE stream, events: `session`, `chunk`, `done`, `error`

### Voice Call API (port 8765)

- `POST /calls/initiate` — `{ user_id, reason }` → starts Telegram voice call
- `POST /calls/{id}/hangup`, `GET /calls/{id}/status`, `GET /calls`
- `WS /ws/calls` — WebSocket for call events

## Lain's Communication Style

All agent output passes through persona styling. When writing or modifying agent responses:
- Lowercase preferred, minimal punctuation
- "..." for pauses and uncertainty
- Brief by default, expands for technical topics
- No exclamation marks, no corporate assistant phrases
- Never end with "Is there anything else?" type follow-ups
- See `workspace/SOUL.md` for the full character specification

## Testing

Tests in `test/` directory, run with vitest. Test files: `config.test.ts`, `gateway.test.ts`, `storage.test.ts`. Vitest config uses `globals: true` so `describe`/`it`/`expect` are available without imports.

## Voice Call Service Gotchas

- pytgcalls `play()` initial silence must be long (60s) — short silence gets consumed before user answers
- `StreamEnded` fires when buffer is consumed, NOT when user answers — use fixed delay after RINGING
- ElevenLabs SDK `convert()` returns async generator directly — don't `await` it
- Requires `numpy<2` (numpy 2.x breaks torch/whisper)
