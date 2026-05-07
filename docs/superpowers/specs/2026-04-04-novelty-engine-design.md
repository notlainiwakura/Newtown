# Novelty Engine — Design Spec

## Problem

Laintown characters fall into repetitive topic loops. The root cause is structural: background loops (curiosity, commune, diary, proactive) search memories sorted by importance. Once a topic is marked important, it surfaces everywhere, generates more conversation about itself, and creates more important memories — a self-reinforcing fixation cycle.

Dreams and bibliomancy provide some randomness, but their output feeds back into the same importance-sorted memory pool without enough force to break the cycle.

## Solution

A zero-LLM novelty engine that periodically generates diegetic events and injects them into the town as both town events (immediate visibility) and planted memories (structural disruption of the importance-sorting feedback loop).

## Design Principles

- **Diegetic**: Events feel like they happen within the town's world. No fourth wall breaking.
- **Zero token cost**: The engine generates events through template expansion and random selection, never LLM calls. Characters react through their existing loops in their own voice.
- **Structurally disruptive**: Novelty enters the memory pool at competitive importance levels, breaking the feedback loop where the same high-importance topics dominate every search.
- **Tonally consistent**: Events match the Serial Experiments Lain aesthetic — quiet strangeness, ambient unease, cryptic signals, things that make you question what's real.

## Architecture

### Two-Layer System

**Layer 1 — Novelty Engine** (`src/agent/novelty.ts`): A lightweight background loop that generates structured event objects. No LLM calls. Runs on a 30-minute check interval with probability-based firing.

**Layer 2 — Injection**: Events are delivered through two channels:
1. Town event (existing `eventBus` system) for immediate character context visibility.
2. Planted memory (`saveMemory()`) to persist in the memory pool and compete with repetitive high-importance memories.

### Event Tiers

**Ambient events** (2-3x/day, targeting 1-2 characters):
Small diegetic occurrences — a note found, a strange signal, an object out of place. Background texture that gives characters something slightly new to notice.

**Major events** (2-3x/week, targeting all characters):
Larger disruptions — a stranger's trace, a shared dream, a building anomaly. Memorable enough to shift conversation topics and break fixation loops.

### Single Process

The novelty loop runs on Wired Lain's server process only. She is the Wired-connected character, making her the thematically appropriate host.

**Cross-process delivery**: Each character runs in its own process with its own SQLite database. The engine can write directly to Wired Lain's memory store, but for all other characters it delivers via HTTP to their peer APIs (the same mechanism used by commune conversations and letters). Specifically:
- Town events are broadcast to all peers via their `/api/event` endpoint (or equivalent — follows the same pattern as existing town event notification).
- Planted memories are delivered via a `POST` to each target character's API with the memory payload. The receiving character's process calls `saveMemory()` locally.

## Event Generation Pipeline

Each check cycle (every 30 minutes):

1. **Roll dice**: Check `fireChance` for ambient and major independently.
2. **Pick source**: For ambient, select a fragment source (RSS 40%, Wikipedia 30%, static pool 30%). For major, draw from the curated seed bank.
3. **Pick template**: Random selection from the appropriate template bank, weighted to avoid recently used templates.
4. **Pick target(s)**: For ambient, 1-2 characters weighted toward whoever hasn't received novelty recently. For major, all characters.
5. **Pick location**: Random building from the 3x3 grid.
6. **Expand template**: Fill placeholders (`{fragment}`, `{building}`, `{object}`, `{time}`, `{detail}`, `{sensory_detail}`) from the source content, building map, and static word banks.
7. **Deliver**: Emit town event + save planted memory for each target character.

## Templates

### Ambient Templates (`workspace/novelty/ambient-templates.json`)

~30-50 short templates organized by category. Each template has:
- `id`: Unique identifier.
- `category`: One of the categories below.
- `template`: String with `{placeholder}` tokens.
- `importanceRange`: `[min, max]` for the planted memory.
- `placeholders`: List of placeholder names the template requires.

Categories:
- **found-object**: `"A small {object} was found near the {building}. {detail}"`
- **strange-signal**: `"A faint signal came through the Wired last night — just a fragment: '{fragment}'"`
- **note**: `"Someone left a note pinned to the {building} door: '{fragment}'"`
- **anomaly**: `"The {building} smelled different this morning. Like {sensory_detail}."`
- **visitor-trace**: `"Footprints near the {building} that don't belong to anyone in town. They lead to the {building2} and stop."`
- **weather-glitch**: `"For a few minutes around {time}, the sky above the {building} looked wrong — {detail}."`
- **sound**: `"A sound no one could place drifted from the direction of the {building}. {fragment}"`
- **dream-echo**: `"Several people in town mentioned seeing {detail} in their dreams last night."`

### Major Seeds (`workspace/novelty/major-seeds.json`)

~20-30 curated seeds for bigger events. Each seed has:
- `id`: Unique identifier.
- `name`: Human-readable name.
- `template`: Longer narrative string with placeholders.
- `beats`: Optional array of follow-up template strings. When a multi-beat event fires, beat 1 is delivered immediately. Remaining beats are queued in a meta key (`novelty:pending_beats`) and delivered on subsequent major event checks instead of rolling a new seed. One beat per check cycle, so a 3-beat event unfolds over 3 major firings.

Examples:
- **the-stranger**: `"Someone was seen in the {building} last night. No one recognized them. They left behind a {object} with the words '{fragment}' scratched into it. By morning they were gone."`
- **shared-dream**: `"At least two inhabitants dreamed the same image last night: {detail}. Neither can explain why."`
- **building-shift**: `"The {building} feels different today. The light falls at a new angle. Objects have shifted slightly, as though the room rearranged itself while empty."`
- **wired-breach**: `"A burst of data from the Wired flooded the town for a few seconds. Most of it was noise, but one phrase came through clearly: '{fragment}'."`
- **lost-letter**: `"A letter was found in the {building}, addressed to no one. It reads: '{fragment}'. The handwriting doesn't match anyone in town."`
- **silence-event**: `"For exactly eleven minutes this morning, every sound in town stopped. No wind, no hum from the Wired, nothing. Then it resumed as if nothing happened."`

### Placeholder Sources

- `{fragment}`: Filled from external sources (RSS, Wikipedia, static pool).
- `{building}`, `{building2}`: Random pick from the 9-building grid (`BUILDING_MAP`).
- `{object}`: Random pick from a static object pool (e.g., "glass lens", "copper key", "folded photograph", "unmarked cassette tape").
- `{time}`: Random time string (e.g., "3:42 AM", "just before dawn").
- `{detail}`: Random pick from a static detail pool (evocative visual/conceptual fragments).
- `{sensory_detail}`: Random pick from a static sensory pool (e.g., "copper and ozone", "wet stone", "something burning far away").

Static pools for `{object}`, `{detail}`, and `{sensory_detail}` are defined inline in the template JSON files.

## External Sources

### Source Configuration (`workspace/novelty/sources.json`)

```json
{
  "rss": [
    { "url": "https://aeon.co/feed.rss", "name": "Aeon" },
    { "url": "https://feeds.feedburner.com/brainpickings/rss", "name": "The Marginalian" }
  ],
  "wikipedia": {
    "enabled": true,
    "endpoint": "https://en.wikipedia.org/api/rest_v1/page/random/summary"
  }
}
```

### Static Fragment Pool (`workspace/novelty/fragments.json`)

~100+ hand-curated evocative phrases, quotes, koans, lines from literature. Acts as fallback when external feeds fail and as a guaranteed-quality source. Can be grown over time.

### Source Selection

When a template needs a `{fragment}`:
- 40% chance: RSS feed (random feed, random entry, extract one sentence)
- 30% chance: Wikipedia random article (first sentence of a random section)
- 30% chance: Static fragment pool

If an external fetch fails, falls back to static pool silently.

### Caching

An in-memory cache of ~20 pre-fetched fragments, refreshed every 4 hours as a background task. Event generation reads from cache, never blocks on HTTP. On startup, the cache is populated before the first novelty check fires.

### Fragment Processing

Fragments from external sources are:
1. Stripped of HTML tags.
2. Truncated to the nearest sentence boundary at ~100-200 characters.
3. Used as-is (no mangling). The template framing (note, signal, transmission) contextualizes the fragment.

## Delivery

### Channel 1 — Town Event

Uses the existing `eventBus` / town events system. The event is emitted as a narrative, instant event with a 30-minute window. Characters pick it up through their existing context-gathering in commune, curiosity, town life, and other loops.

### Channel 2 — Planted Memory

Saved via `saveMemory()` with:
- `sessionKey`: `novelty:{characterId}:{timestamp}`
- `memoryType`: `'episode'`
- `importance`: Ambient 0.4-0.6 (randomized within range), Major 0.6-0.8
- `emotionalWeight`: 0.3-0.5
- `metadata`: `{ source: 'novelty', category: 'ambient' | 'major', templateId: '<id>' }`
- `relatedTo`: `null`
- `userId`: `null`
- `sourceMessageId`: `null`

### Why Both Channels

The town event gives immediate visibility — the character notices the event on their next loop cycle. The planted memory provides long-term disruption — it enters the memory pool and competes with repetitive high-importance memories in future searches. Even if the character doesn't react to the town event, the memory persists and can surface days later in a commune impulse or diary reflection.

## Rate Limiting & Deduplication

- **Ambient**: Max 3 per day per character. Tracked via meta key `novelty:ambient_count:{characterId}:{date}`.
- **Major**: Max 3 per week. Tracked via meta key `novelty:major_count:{week}`.
- **Target fairness**: Characters who received novelty most recently are deprioritized. Tracked via `novelty:last_ambient:{characterId}`.
- **Template deduplication**: Recently used template IDs are tracked (last 10 ambient, last 5 major) to avoid repetition. Tracked via meta key `novelty:recent_templates`.
- **Novelty memory count check**: Before firing, query memories with `metadata.source = 'novelty'` from last 24 hours for the target character. Skip if 3+ exist.

## Configuration (`workspace/novelty/config.json`)

```json
{
  "enabled": true,
  "ambient": {
    "checkIntervalMs": 1800000,
    "fireChance": 0.10,
    "maxPerDayPerCharacter": 3,
    "importanceRange": [0.4, 0.6],
    "targetCount": [1, 2]
  },
  "major": {
    "checkIntervalMs": 1800000,
    "fireChance": 0.03,
    "maxPerWeek": 3,
    "importanceRange": [0.6, 0.8],
    "targetCount": "all"
  },
  "sources": {
    "refreshIntervalMs": 14400000,
    "cacheSize": 20,
    "weights": {
      "rss": 0.4,
      "wikipedia": 0.3,
      "static": 0.3
    }
  }
}
```

All values tunable without code changes.

## File Layout

```
src/agent/novelty.ts                      — engine loop, event generation, delivery
workspace/novelty/config.json             — frequency, probability, limits
workspace/novelty/ambient-templates.json  — ~30-50 ambient event templates
workspace/novelty/major-seeds.json        — ~20-30 major event seeds
workspace/novelty/fragments.json          — ~100+ static fragment pool
workspace/novelty/sources.json            — RSS feed URLs, Wikipedia config
```

## Startup Integration

The novelty loop starts in Wired Lain's web server process (`src/web/server.ts`), after other background loops are initialized. It needs:
- Access to the building map (for `{building}` placeholders).
- Access to `saveMemory()` (for planted memories).
- Access to `eventBus` (for town events).
- The list of all character IDs and their peer URLs (for targeting).
- Access to `getMeta()`/`setMeta()` (for rate limiting state).

It does NOT need:
- Any LLM provider.
- Any character-specific context or persona.

## Cost

Zero LLM tokens. The engine is pure template expansion + random selection + HTTP fetches for external content. Characters react to novelty events through their existing loops (which already have their own token budgets).

## Success Criteria

- Characters discuss new topics that didn't originate from user conversations or their own prior fixations.
- Commune conversations show more variety in opening topics over a 1-2 week period.
- Diary entries reference events and fragments that came from the novelty engine.
- No increase in LLM token spend.
