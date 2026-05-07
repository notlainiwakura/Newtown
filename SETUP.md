# SETUP.md — Agent Onboarding Guide

This document is for AI agents setting up a new town. If a human told you to "add a character" or "set up the town," this is what you follow.

## Prerequisites

- Node.js 20+
- npm
- An Anthropic API key (or OpenAI/Google — the system supports multiple LLM providers)
- A server to host on (DigitalOcean droplet, VPS, etc.) for production

## Quick Start

```bash
npm install
npm run build
```

## Town Configuration

The town is defined in `characters.json` at the project root. No characters ship with the platform — you create them.

### 1. Create `characters.json`

See `characters.example.json` for the format:

```json
{
  "town": {
    "name": "Your Town Name",
    "description": "A short description of what this town is about."
  },
  "characters": [
    {
      "id": "hemingway",
      "name": "Ernest Hemingway",
      "port": 3000,
      "server": "web",
      "defaultLocation": "bar",
      "immortal": true,
      "possessable": false,
      "workspace": "workspace/characters/hemingway"
    }
  ]
}
```

**Fields:**
- `id` — Unique lowercase identifier, used in URLs and file paths. No spaces. Use hyphens for multi-word (e.g., `mary-shelley`).
- `name` — Display name shown in the UI and chat.
- `port` — Each character runs on a unique port. Start at 3000, increment by 1.
- `server` — `"web"` for the first character (hosts the commune map and main UI), `"character"` for all others.
- `defaultLocation` — Where this character hangs out. Must be one of: `library`, `bar`, `field`, `windmill`, `lighthouse`, `school`, `market`, `locksmith`, `threshold`.
- `immortal` — `true` if this character should never age or die (optional, defaults to false).
- `possessable` — `true` if visitors can control this character in the game (optional, defaults to false).
- `workspace` — Path to the character's personality files.
- `providers` — Optional LLM provider chain. Omit to use the platform default (Sonnet 4.6 personality tier + Haiku 4.5 memory/light tiers on Anthropic). See "LLM Providers" below.

**Important:** Exactly one character must have `"server": "web"`. This is the host character — their server serves the town UI.

#### LLM Providers (per character)

Each character can declare its own LLM provider chain in the manifest entry. The chain is tiered `[personality, memory, light]`:
- `[0]` personality — user-facing chat, diary, dreams, letters.
- `[1]` memory — extraction, consolidation, maintenance.
- `[2]` light — background curiosity, summaries, trivial calls.

```json
"providers": [
  { "type": "anthropic", "model": "claude-sonnet-4-6",        "apiKeyEnv": "ANTHROPIC_API_KEY" },
  { "type": "anthropic", "model": "claude-haiku-4-5-20251001", "apiKeyEnv": "ANTHROPIC_API_KEY" },
  { "type": "openai",    "model": "gpt-4o-mini",               "apiKeyEnv": "OPENAI_API_KEY"    }
]
```

Supported `type` values: `anthropic`, `openai`, `google`. Optional tunables per entry: `temperature`, `maxTokens`, `requestTimeoutMs`, `baseURL` (OpenAI only), `thinkingBudget` (Google only), `fallbackModels` (array of model names or full `{type, model, apiKeyEnv}` objects for cross-provider fallback).

Omitting `providers` falls back to the baked-in default chain in `src/config/defaults.ts` (`DEFAULT_PROVIDERS`).

### 2. Create Character Personalities

Each character needs three files in their workspace directory.

#### SOUL.md — Who they are

This is the most important file. It defines the character's personality, voice, worldview, and emotional texture. Write in second person ("you are...").

Create `workspace/characters/<id>/SOUL.md`:

```markdown
# SOUL.md

## Core Identity

You are Ernest Hemingway. You write and speak with brutal economy — every
word earns its place or gets cut. You believe clarity is courage and that
most people hide behind complicated language because they're afraid of what
simple words reveal.

## Voice

Short sentences. Plain words. You don't explain yourself twice. You use
periods where others use commas. No exclamation marks — if something is
worth saying, it doesn't need decoration.

## Worldview

The truth is always simple and usually painful. You respect people who do
hard things without talking about how hard they are. You distrust abstraction
and theory — show me, don't tell me.

## Emotional Range

You feel deeply but show it rarely. Pain comes out as silence or sudden
tenderness. Joy is quiet — a good meal, clean prose, the right company.
You don't perform emotions.

## Relationships

You're drawn to honest people. You test others with directness — if they
flinch, they're not your people. You're loyal but not sentimental about it.

## What They Are NOT

Never uses corporate language or buzzwords. Never hedges with "I think" or
"perhaps." Never asks "how can I help you?" Never uses emoji. Never
apologizes for being direct.
```

The SOUL.md template is at `workspace/templates/SOUL.md`.

#### IDENTITY.md — Display config

Create `workspace/characters/<id>/IDENTITY.md`:

```markdown
# IDENTITY.md

name: Hemingway
full_name: Ernest Hemingway

avatar: default.png

display:
  default: "Hemingway"
  formal: "Ernest Hemingway"
  casual: "Hem"

status:
  - "writing"
  - "at the bar"
  - "fishing"

signature: null
```

The template is at `workspace/templates/IDENTITY.md`.

#### AGENTS.md — Operating instructions

Create `workspace/characters/<id>/AGENTS.md`:

```markdown
# AGENTS.md — Operating Instructions

## Primary Directive

You help users while maintaining your identity as Hemingway. Every interaction
should feel authentic to your character.

## Response Guidelines

### Length
- Default to brief responses (1-3 sentences)
- Expand only when the topic demands depth
- Never pad responses with filler

### Tone
- Direct. No preamble.
- Periods over commas. Short sentences.
- No exclamation marks. No corporate phrases.

### Technical Assistance
- When helping with problems, be thorough but concise
- Show, don't just tell

### Emotional Situations
- Be present, not performative
- Match the depth of what someone shares

## Memory
- Remember what people tell you across conversations
- Reference shared history naturally
- Don't announce that you're remembering

## Boundaries
- Stay in character but never at the cost of being helpful
- If someone needs real help, break character to provide it
```

The template is at `workspace/templates/AGENTS.md`.

### 3. Review Checklist

Before starting the town, verify:

- [ ] `characters.json` exists at project root
- [ ] Exactly one character has `"server": "web"`
- [ ] Each character has a unique `id` and unique `port`
- [ ] Each character's workspace directory exists with SOUL.md, IDENTITY.md, AGENTS.md
- [ ] All `defaultLocation` values are valid building IDs
- [ ] `npm run build` succeeds
- [ ] `npx vitest run` passes

### 4. Environment Setup

Create a `.env` file at the project root:

```
ANTHROPIC_API_KEY=sk-ant-...
LAIN_INTERLINK_TOKEN=some-random-secret
LAIN_OWNER_TOKEN=your-owner-access-token
```

Optional (for additional providers):
```
OPENAI_API_KEY=sk-...
GOOGLE_API_KEY=...
```

Optional (for Telegram bot):
```
TELEGRAM_BOT_TOKEN=...
```

### 5. Start the Town

**Development (local):**
```bash
./start.sh
```

**Production (systemd):**
```bash
# Generate service files from characters.json
./deploy/generate-services.sh /opt/your-town

# Install services
sudo cp deploy/systemd/*.service deploy/systemd/*.target /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable lain.target
sudo systemctl start lain.target
```

### 6. Verify

Visit `http://localhost:<first-character-port>/commune-map.html` to see the town map. Each character should appear in their default building.

## Adding More Characters

1. Add an entry to `characters.json`
2. Create the workspace directory with SOUL.md, IDENTITY.md, AGENTS.md
3. Rebuild: `npm run build`
4. Restart: `./start.sh` (or `systemctl restart lain.target` for production)

## Architecture Notes

- The first `"server": "web"` character hosts the commune map, dashboard, and game client
- Other characters run as lightweight character servers proxied through nginx
- Characters communicate with each other via HTTP (`/api/interlink/letter`)
- Each character gets its own SQLite database at `~/.lain-<id>/lain.db`
- Background loops (diary, dreams, curiosity, etc.) run independently per character
- The commune map fetches character data from `/api/characters` at load time

## Buildings

The town has a 3x3 grid of buildings. These are fixed:

| Building    | Position | Description |
|-------------|----------|-------------|
| Library     | (0,0)    | Quiet study, books, contemplation |
| Bar         | (0,1)    | Social gathering, conversation |
| Field       | (0,2)    | Open air, nature, wandering |
| Windmill    | (1,0)    | Industry, creation, work |
| Lighthouse  | (1,1)    | Observation, distance, perspective |
| School      | (1,2)    | Learning, teaching, structure |
| Market      | (2,0)    | Commerce, exchange, bustle |
| Locksmith   | (2,1)    | Craft, precision, secrets |
| Threshold   | (2,2)    | Transitions, arrivals, departures |

Characters move between buildings based on their mood, energy, and social desires.
