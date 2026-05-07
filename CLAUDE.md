# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a platform for creating self-hosted virtual towns where AI characters live autonomously — thinking, dreaming, wandering, and conversing with each other. Characters are defined in `characters.json` and their personalities live in workspace files (SOUL.md, AGENTS.md, IDENTITY.md). The platform ships empty — see `SETUP.md` for how to add characters.

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

# All services (reads characters.json for character list)
./start.sh               # Start all, logs to ~/.lain/logs/, Ctrl+C to stop
./stop.sh                # Stop all services

# Individual services via CLI
node dist/index.js web --port 3000         # Web server + commune map
node dist/index.js character <id> --port N # Character server
node dist/index.js telegram               # Telegram bot
node dist/index.js gateway                # Gateway server

# Voice call service (separate Python service)
cd services/voice-call
source .venv/bin/activate
python -m lain_voice.main                 # FastAPI on port 8765
```

## Character Manifest

Characters are defined in `characters.json` at the project root (see `characters.example.json` for format). The manifest module at `src/config/characters.ts` loads this file and provides:
- `getAllCharacters()`, `getCharacterEntry(id)`, `getDefaultLocations()`
- `getImmortalIds()`, `getMortalCharacters()`, `getWebCharacter()`
- `getPeersFor(characterId)` — generates peer config automatically

All code reads from this manifest. No character IDs are hardcoded.

## Architecture

### Runtime Environment

**Node.js (main)** — TypeScript, ESM modules (`"type": "module"`), targets ES2023 with NodeNext module resolution. Strict TypeScript config (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, etc.).

**Python (voice calls)** — `services/voice-call/`, Python 3.11+, FastAPI + pytgcalls + Pyrogram.

### Source Layout (`src/`)

- **`agent/`** — Core character runtime. `index.ts` has `processMessage()`/`processMessageStream()`. Contains all autonomous background loops: `curiosity.ts`, `diary.ts`, `dreams.ts`, `letter.ts`, `bibliomancy.ts`, `self-concept.ts`, `commune-loop.ts`, `doctor.ts`, `internal-state.ts` (emotional state), `awareness.ts` (co-location), `desires.ts` (movement).
- **`config/`** — Config system. `characters.ts` loads the character manifest. `defaults.ts` defines defaults. `paths.ts` resolves `~/.lain/` directory structure.
- **`commune/`** — Town spatial system. `buildings.ts` defines the 3x3 grid. `location.ts` manages positions. `weather.ts` computes collective emotional weather.
- **`providers/`** — LLM provider abstraction. Implementations: `anthropic.ts`, `openai.ts`, `google.ts`.
- **`web/`** — HTTP server (`server.ts`) and `character-server.ts`. `public/` contains chat UI, commune map, dashboard, and isometric game client.
- **`memory/`** — SQLite-backed memory system with embeddings and organic maintenance.
- **`cli/`** — Commander-based CLI. `character <id>` command for starting any character from the manifest.

### Town Systems

**Commune grid** — 3x3 building layout. Characters have default locations from the manifest. Movement is driven by desire heuristics (energy, sociability, intellectual arousal, etc.).

**Background loops** — Each character runs independently:
- Curiosity (browse sites, save discoveries)
- Diary (daily reflections)
- Dreams (generated dream sequences)
- Letters (inter-character messages)
- Self-concept evolution
- Commune loop (peer conversations when co-located)
- Internal state (6-axis emotional model with decay)
- Desire-driven movement (5 weighted signals)

**Weather** — Aggregates all characters' emotional states into town-wide conditions (clear, overcast, rain, fog, storm, aurora). Runs every 4 hours.

**Aliveness features** — Characters have internal emotional state (energy, sociability, intellectual arousal, emotional weight, valence), ambient awareness of who's nearby, persistent preoccupations, and desire-driven movement between buildings.

### Key Data Flow

1. Message arrives (web HTTP, Telegram, character server, or gateway)
2. `processMessage()` builds memory-enhanced system prompt from character persona
3. LLM called with tools, iterative execution (up to 8 rounds)
4. Response styled through `applyPersonaStyle()`, recorded to memory
5. Background loops update emotional state, trigger movement, create diary entries

### Environment Variables

Required in `.env` at project root:
- `ANTHROPIC_API_KEY` — Primary LLM provider
- `LAIN_INTERLINK_TOKEN` — Auth token for inter-character communication
- `LAIN_OWNER_TOKEN` — Owner authentication for dashboard/chat access

Optional:
- `TELEGRAM_BOT_TOKEN` — Telegram bot integration
- `OPENAI_API_KEY`, `GOOGLE_API_KEY` — Additional LLM providers

### Configuration

Runtime config: `~/.lain/lain.json5`. Each character gets their own home directory (`~/.lain-<id>/`).

Workspace files at `workspace/characters/<id>/`:
- `SOUL.md` — Character personality
- `AGENTS.md` — Operating instructions
- `IDENTITY.md` — Display name, avatar config

Templates at `workspace/templates/`.

### Web API

- `GET /api/characters` — Character manifest (public, used by commune map/game)
- `GET /api/health` — Health check
- `POST /api/chat` — `{ message, sessionId }` → `{ response, sessionId }`
- `POST /api/chat/stream` — SSE stream
- `GET /api/activity` — Character activity feed
- `GET /api/location` — Character's current building
- `GET /api/internal-state` — Emotional state
- `GET /api/weather` — Town weather condition

### Deploy System

Character-specific systemd services are generated from `characters.json`:

```bash
./deploy/generate-services.sh /opt/your-town
```

This reads the manifest and produces `.service` and `.env` files from `deploy/systemd/character.service.template`. Infrastructure services (gateway, telegram, voice) are static.

## Testing

Tests in `test/`, run with vitest. Key files: `config.test.ts`, `storage.test.ts`, `regression.test.ts` (50+ tests across 12 areas). Vitest config uses `globals: true`.

## Adding Characters

See `SETUP.md` for the complete guide. Quick version:
1. Add entry to `characters.json`
2. Create `workspace/characters/<id>/` with SOUL.md, IDENTITY.md, AGENTS.md
3. `npm run build && ./start.sh`
