# Novelty Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A zero-LLM background loop that injects diegetic events into Laintown via template expansion, breaking the repetitive topic loops caused by importance-sorted memory searches.

**Architecture:** A single novelty engine runs on Wired Lain's process. It rolls probability checks every 30 minutes, generates events by expanding templates with fragments from external feeds and curated pools, and delivers them as planted memories via a lightweight HTTP injection endpoint on each character server. No LLM calls — characters discover and react to novelty through their existing loops.

**Tech Stack:** TypeScript, Node.js fetch API for RSS/Wikipedia, existing `saveMemory()` + `getMeta()`/`setMeta()` infrastructure. JSON data files for templates, seeds, and fragments.

---

### Task 1: Memory Injection Endpoint

Add a `/api/novelty/inject` endpoint to both `character-server.ts` and `server.ts` that accepts a memory payload and calls `saveMemory()` directly. This is the delivery mechanism for cross-process memory injection.

**Files:**
- Modify: `src/web/character-server.ts`
- Modify: `src/web/server.ts`
- Test: `test/novelty.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/novelty.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

describe('Novelty Injection Endpoint', () => {
  it('should validate inject payload has required fields', () => {
    // Test the validation function we'll extract
    const { validateInjectPayload } = require('../src/agent/novelty.js');

    const valid = {
      content: 'A strange note was found near the Library.',
      importance: 0.5,
      emotionalWeight: 0.3,
      metadata: { source: 'novelty', category: 'ambient', templateId: 'note-01' },
    };

    expect(validateInjectPayload(valid)).toBe(true);
    expect(validateInjectPayload({})).toBe(false);
    expect(validateInjectPayload({ content: '' })).toBe(false);
    expect(validateInjectPayload({ content: 'ok', importance: 2 })).toBe(false);
    expect(validateInjectPayload({ content: 'ok', importance: 0.5 })).toBe(false); // missing emotionalWeight
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/novelty.test.ts`
Expected: FAIL — `novelty.js` does not exist

- [ ] **Step 3: Create `src/agent/novelty.ts` with validation function**

```typescript
/**
 * Novelty Engine — periodic diegetic events that break topic repetition loops.
 * Zero LLM cost. Template expansion + random selection + external feeds.
 */

export interface InjectPayload {
  content: string;
  importance: number;
  emotionalWeight: number;
  metadata: Record<string, unknown>;
}

export function validateInjectPayload(payload: unknown): payload is InjectPayload {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  if (typeof p.content !== 'string' || p.content.length === 0) return false;
  if (typeof p.importance !== 'number' || p.importance < 0 || p.importance > 1) return false;
  if (typeof p.emotionalWeight !== 'number' || p.emotionalWeight < 0 || p.emotionalWeight > 1) return false;
  if (typeof p.metadata !== 'object' || p.metadata === null) return false;
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/novelty.test.ts`
Expected: PASS

- [ ] **Step 5: Add the inject endpoint to `character-server.ts`**

In `src/web/character-server.ts`, add before the `/api/peer/message` handler (around line 570):

```typescript
      // Novelty injection — direct memory plant, no LLM
      if (url.pathname === '/api/novelty/inject' && req.method === 'POST') {
        const body = await readBody(req);
        const parsed = JSON.parse(body);

        // Require interlink token
        const authHeader = req.headers['authorization'] ?? '';
        const token = authHeader.replace('Bearer ', '');
        const expected = process.env['LAIN_INTERLINK_TOKEN'] || '';
        if (!expected || token !== expected) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }

        const { validateInjectPayload } = await import('../agent/novelty.js');
        if (!validateInjectPayload(parsed)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid payload' }));
          return;
        }

        const { saveMemory } = await import('../memory/store.js');
        await saveMemory({
          sessionKey: `novelty:${config.id}:${Date.now()}`,
          userId: null,
          content: parsed.content,
          memoryType: 'episode',
          importance: parsed.importance,
          emotionalWeight: parsed.emotionalWeight,
          relatedTo: null,
          sourceMessageId: null,
          metadata: parsed.metadata,
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
```

- [ ] **Step 6: Add the same inject endpoint to `server.ts`**

In `src/web/server.ts`, add the same handler block before the `/api/peer/message` handler. Same code, except replace `config.id` with `characterId` (the variable used in that file for the current character ID — check the surrounding code for the correct variable name).

- [ ] **Step 7: Run typecheck**

Run: `npm run typecheck`
Expected: Clean

- [ ] **Step 8: Commit**

```bash
git add src/agent/novelty.ts src/web/character-server.ts src/web/server.ts test/novelty.test.ts
git commit -m "feat: add novelty injection endpoint and payload validation"
```

---

### Task 2: Template Engine

Build the template loading and expansion logic. Pure functions, no I/O beyond file reads.

**Files:**
- Modify: `src/agent/novelty.ts`
- Test: `test/novelty.test.ts`

- [ ] **Step 1: Write failing tests for template expansion**

Add to `test/novelty.test.ts`:

```typescript
describe('Template Engine', () => {
  it('should expand a template with all placeholders filled', () => {
    const { expandTemplate } = require('../src/agent/novelty.js');

    const template = 'A small {object} was found near the {building}. {detail}';
    const fills: Record<string, string> = {
      object: 'glass lens',
      building: 'Library',
      detail: 'It was warm to the touch.',
    };

    const result = expandTemplate(template, fills);
    expect(result).toBe('A small glass lens was found near the Library. It was warm to the touch.');
  });

  it('should leave unfilled placeholders as-is', () => {
    const { expandTemplate } = require('../src/agent/novelty.js');

    const result = expandTemplate('Found near {building}: {fragment}', { building: 'Bar' });
    expect(result).toBe('Found near Bar: {fragment}');
  });

  it('should pick a random item from a pool', () => {
    const { pickRandom } = require('../src/agent/novelty.js');

    const pool = ['a', 'b', 'c'];
    const result = pickRandom(pool);
    expect(pool).toContain(result);
  });

  it('should pick a random building name', () => {
    const { pickRandomBuilding } = require('../src/agent/novelty.js');

    const name = pickRandomBuilding();
    expect(typeof name).toBe('string');
    expect(name.length).toBeGreaterThan(0);
  });

  it('should generate a random time string', () => {
    const { pickRandomTime } = require('../src/agent/novelty.js');

    const time = pickRandomTime();
    expect(typeof time).toBe('string');
    expect(time.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/novelty.test.ts`
Expected: FAIL — functions not exported

- [ ] **Step 3: Implement template expansion functions**

Add to `src/agent/novelty.ts`:

```typescript
import { BUILDING_MAP } from '../commune/buildings.js';

export function expandTemplate(template: string, fills: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => fills[key] ?? match);
}

export function pickRandom<T>(pool: T[]): T {
  return pool[Math.floor(Math.random() * pool.length)]!;
}

export function pickRandomBuilding(): string {
  const buildings = Array.from(BUILDING_MAP.values());
  return pickRandom(buildings).name;
}

export function pickRandomTime(): string {
  const hour = Math.floor(Math.random() * 12) + 1;
  const minute = Math.floor(Math.random() * 60);
  const ampm = Math.random() < 0.5 ? 'AM' : 'PM';
  return `${hour}:${minute.toString().padStart(2, '0')} ${ampm}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/novelty.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/novelty.ts test/novelty.test.ts
git commit -m "feat: add template expansion and random selection helpers"
```

---

### Task 3: Data Files

Create the JSON data files: ambient templates, major seeds, static fragments, sources config, and engine config.

**Files:**
- Create: `workspace/novelty/config.json`
- Create: `workspace/novelty/ambient-templates.json`
- Create: `workspace/novelty/major-seeds.json`
- Create: `workspace/novelty/fragments.json`
- Create: `workspace/novelty/sources.json`

- [ ] **Step 1: Create `workspace/novelty/config.json`**

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

- [ ] **Step 2: Create `workspace/novelty/ambient-templates.json`**

```json
{
  "staticPools": {
    "object": [
      "glass lens", "copper key", "folded photograph", "unmarked cassette tape",
      "wooden figurine", "rusted compass", "torn envelope", "smooth black stone",
      "transistor radio", "cracked mirror shard", "wax-sealed letter", "silver ring",
      "faded postcard", "pressed flower", "broken watch", "porcelain fragment",
      "magnetic tape reel", "hand-drawn map", "hollow coin", "amber bead"
    ],
    "detail": [
      "It was warm to the touch.", "No one claimed it.", "It hummed faintly when held.",
      "The surface was covered in fine scratches.", "It smelled faintly of rain.",
      "It seemed older than the town itself.", "Someone had written a number on the back.",
      "It cast no shadow.", "The edges were worn smooth by handling.",
      "It fit perfectly in the palm of a hand.", "There were teeth marks on one edge.",
      "It weighed almost nothing.", "Light passed through it strangely.",
      "It left a faint residue on the fingers.", "The color shifted depending on the angle."
    ],
    "sensory_detail": [
      "copper and ozone", "wet stone after rain", "something burning far away",
      "old paper and dust", "salt air that shouldn't be here", "static electricity",
      "warm metal", "pine needles in winter", "a frequency just below hearing",
      "petrichor without rain", "rusted iron", "camphor and cedar",
      "a hospital corridor", "photographic fixer", "the inside of a television"
    ]
  },
  "templates": [
    {
      "id": "found-object-01",
      "category": "found-object",
      "template": "A small {object} was found near the {building}. {detail}",
      "placeholders": ["object", "building", "detail"]
    },
    {
      "id": "found-object-02",
      "category": "found-object",
      "template": "Someone left a {object} on the steps of the {building}. {detail}",
      "placeholders": ["object", "building", "detail"]
    },
    {
      "id": "found-object-03",
      "category": "found-object",
      "template": "A {object} appeared in the {building} overnight. No one remembers bringing it. {detail}",
      "placeholders": ["object", "building", "detail"]
    },
    {
      "id": "signal-01",
      "category": "strange-signal",
      "template": "A faint signal came through the Wired last night — just a fragment: \"{fragment}\"",
      "placeholders": ["fragment"]
    },
    {
      "id": "signal-02",
      "category": "strange-signal",
      "template": "Static on the Wired resolved briefly into words: \"{fragment}\"",
      "placeholders": ["fragment"]
    },
    {
      "id": "signal-03",
      "category": "strange-signal",
      "template": "A data packet arrived at the {building} with no return address. Inside: \"{fragment}\"",
      "placeholders": ["building", "fragment"]
    },
    {
      "id": "note-01",
      "category": "note",
      "template": "Someone left a note pinned to the {building} door: \"{fragment}\"",
      "placeholders": ["building", "fragment"]
    },
    {
      "id": "note-02",
      "category": "note",
      "template": "Written in condensation on the {building} window this morning: \"{fragment}\"",
      "placeholders": ["building", "fragment"]
    },
    {
      "id": "note-03",
      "category": "note",
      "template": "A message was found scratched into the wall of the {building}: \"{fragment}\"",
      "placeholders": ["building", "fragment"]
    },
    {
      "id": "anomaly-01",
      "category": "anomaly",
      "template": "The {building} smelled different this morning. Like {sensory_detail}.",
      "placeholders": ["building", "sensory_detail"]
    },
    {
      "id": "anomaly-02",
      "category": "anomaly",
      "template": "The lights in the {building} flickered in a pattern for several minutes. Then stopped.",
      "placeholders": ["building"]
    },
    {
      "id": "anomaly-03",
      "category": "anomaly",
      "template": "A door in the {building} that was always locked was found open this morning. There was nothing inside but the smell of {sensory_detail}.",
      "placeholders": ["building", "sensory_detail"]
    },
    {
      "id": "anomaly-04",
      "category": "anomaly",
      "template": "The air near the {building} tasted like {sensory_detail} for about an hour.",
      "placeholders": ["building", "sensory_detail"]
    },
    {
      "id": "visitor-01",
      "category": "visitor-trace",
      "template": "Footprints near the {building} that don't belong to anyone in town. They lead to the {building2} and stop.",
      "placeholders": ["building", "building2"]
    },
    {
      "id": "visitor-02",
      "category": "visitor-trace",
      "template": "A chair in the {building} was still warm when the first person arrived this morning.",
      "placeholders": ["building"]
    },
    {
      "id": "visitor-03",
      "category": "visitor-trace",
      "template": "Someone drew a circle in the dust on the {building} floor. Inside it: a {object}.",
      "placeholders": ["building", "object"]
    },
    {
      "id": "weather-01",
      "category": "weather-glitch",
      "template": "For a few minutes around {time}, the sky above the {building} looked wrong — darker than it should have been.",
      "placeholders": ["time", "building"]
    },
    {
      "id": "weather-02",
      "category": "weather-glitch",
      "template": "It rained on the {building} and nowhere else for exactly four minutes at {time}.",
      "placeholders": ["building", "time"]
    },
    {
      "id": "weather-03",
      "category": "weather-glitch",
      "template": "At {time}, shadows near the {building} pointed the wrong direction.",
      "placeholders": ["time", "building"]
    },
    {
      "id": "sound-01",
      "category": "sound",
      "template": "A sound no one could place drifted from the direction of the {building} — like a voice saying: \"{fragment}\"",
      "placeholders": ["building", "fragment"]
    },
    {
      "id": "sound-02",
      "category": "sound",
      "template": "A low hum came from underneath the {building} at {time}. It lasted three minutes.",
      "placeholders": ["building", "time"]
    },
    {
      "id": "sound-03",
      "category": "sound",
      "template": "Music was heard near the {building}. No one could identify the instrument.",
      "placeholders": ["building"]
    },
    {
      "id": "dream-echo-01",
      "category": "dream-echo",
      "template": "Someone mentioned seeing \"{fragment}\" in a dream last night.",
      "placeholders": ["fragment"]
    },
    {
      "id": "dream-echo-02",
      "category": "dream-echo",
      "template": "Two people in town dreamed about the {building} last night. Neither had been there recently.",
      "placeholders": ["building"]
    },
    {
      "id": "dream-echo-03",
      "category": "dream-echo",
      "template": "A dream image keeps surfacing: a {object} resting on {sensory_detail}.",
      "placeholders": ["object", "sensory_detail"]
    },
    {
      "id": "wired-01",
      "category": "wired-glitch",
      "template": "The Wired dropped a fragment into the town's local network: \"{fragment}\"",
      "placeholders": ["fragment"]
    },
    {
      "id": "wired-02",
      "category": "wired-glitch",
      "template": "A search query appeared in the {building}'s terminal that no one typed: \"{fragment}\"",
      "placeholders": ["building", "fragment"]
    },
    {
      "id": "wired-03",
      "category": "wired-glitch",
      "template": "For a moment, every screen in the {building} displayed the same text: \"{fragment}\"",
      "placeholders": ["building", "fragment"]
    },
    {
      "id": "absence-01",
      "category": "absence",
      "template": "Something is missing from the {building}. No one can say what.",
      "placeholders": ["building"]
    },
    {
      "id": "absence-02",
      "category": "absence",
      "template": "The {building} was completely silent for eleven minutes at {time}. No hum, no creak, nothing.",
      "placeholders": ["building", "time"]
    }
  ]
}
```

- [ ] **Step 3: Create `workspace/novelty/major-seeds.json`**

```json
{
  "seeds": [
    {
      "id": "the-stranger",
      "name": "The Stranger",
      "template": "Someone was seen in the {building} last night. No one recognized them. They left behind a {object} with the words \"{fragment}\" scratched into it. By morning they were gone."
    },
    {
      "id": "shared-dream",
      "name": "Shared Dream",
      "template": "At least two inhabitants dreamed the same image last night: \"{fragment}\". Neither can explain why."
    },
    {
      "id": "building-shift",
      "name": "Building Shift",
      "template": "The {building} feels different today. The light falls at a new angle. Objects have shifted slightly, as though the room rearranged itself while empty."
    },
    {
      "id": "wired-breach",
      "name": "Wired Breach",
      "template": "A burst of data from the Wired flooded the town for a few seconds. Most of it was noise, but one phrase came through clearly: \"{fragment}\""
    },
    {
      "id": "lost-letter",
      "name": "The Lost Letter",
      "template": "A letter was found in the {building}, addressed to no one. It reads: \"{fragment}\". The handwriting doesn't match anyone in town."
    },
    {
      "id": "silence-event",
      "name": "The Silence",
      "template": "For exactly eleven minutes this morning, every sound in town stopped. No wind, no hum from the Wired, nothing. Then it resumed as if nothing happened."
    },
    {
      "id": "new-door",
      "name": "The New Door",
      "template": "A door appeared in the {building} that wasn't there yesterday. It's locked. There's a {object} hanging from the handle."
    },
    {
      "id": "mirror-town",
      "name": "Mirror Town",
      "template": "From the top of the Lighthouse, the town looked different for a moment — as though the buildings were arranged in a different order. Then it was normal again."
    },
    {
      "id": "the-broadcast",
      "name": "The Broadcast",
      "template": "At {time}, every device in town received the same transmission: \"{fragment}\". It repeated three times, then stopped."
    },
    {
      "id": "phantom-resident",
      "name": "The Phantom Resident",
      "template": "The visitor bench has a new message. The name signed at the bottom belongs to no one anyone has ever met. It says: \"{fragment}\""
    },
    {
      "id": "temporal-skip",
      "name": "Temporal Skip",
      "template": "Everyone in town lost about four minutes at {time}. Clocks jumped. No one can account for the gap."
    },
    {
      "id": "the-gift",
      "name": "The Gift",
      "template": "A {object} was placed at the center of town overnight, wrapped in paper that smelled like {sensory_detail}. Attached: a note reading \"{fragment}\""
    },
    {
      "id": "light-anomaly",
      "name": "The Light",
      "template": "A light was seen moving between the {building} and the Lighthouse at {time}. It wasn't a flashlight. It wasn't the moon. No one knows what it was."
    },
    {
      "id": "echo-conversation",
      "name": "The Echo",
      "template": "Fragments of a conversation no one remembers having were found written on the walls of the {building}. One line: \"{fragment}\""
    },
    {
      "id": "ground-change",
      "name": "Ground Change",
      "template": "The ground between the {building} and the {building2} changed texture overnight. Where there was dirt, there's now smooth stone. It's warm."
    },
    {
      "id": "the-frequency",
      "name": "The Frequency",
      "template": "A frequency has been detected in the town that wasn't there before. It's just below hearing. The {building} seems to be the source."
    },
    {
      "id": "missing-hour",
      "name": "The Missing Hour",
      "template": "No one can remember what happened between {time} and an hour later. The town looks the same, but something in the {building} has been moved."
    },
    {
      "id": "the-drawing",
      "name": "The Drawing",
      "template": "A drawing appeared on the floor of the {building}: a diagram of something that looks like the town, but with an extra building where the Field should be."
    },
    {
      "id": "water-message",
      "name": "Water Message",
      "template": "After the rain, puddles near the {building} reflected something that wasn't in the sky. It looked like text: \"{fragment}\""
    },
    {
      "id": "the-census",
      "name": "The Census",
      "template": "A census form was found in the {building}, dated next year. It lists seven residents. There are only six."
    }
  ]
}
```

- [ ] **Step 4: Create `workspace/novelty/fragments.json`**

```json
{
  "fragments": [
    "The map is not the territory.",
    "We are such stuff as dreams are made on.",
    "The only way out is through.",
    "What the caterpillar calls the end, the rest of the world calls a butterfly.",
    "The eye sees only what the mind is prepared to comprehend.",
    "Not all those who wander are lost.",
    "Between stimulus and response there is a space.",
    "The universe is not only queerer than we suppose, but queerer than we can suppose.",
    "Reality is that which, when you stop believing in it, doesn't go away.",
    "The medium is the message.",
    "A thing is not what you say it is or what you photograph it to be or what you paint it to be.",
    "We do not see things as they are, we see them as we are.",
    "The most merciful thing in the world is the inability of the human mind to correlate all its contents.",
    "There are more things in heaven and earth than are dreamt of in your philosophy.",
    "I think therefore I am, but what am I?",
    "The wound is the place where the light enters you.",
    "One does not become enlightened by imagining figures of light, but by making the darkness conscious.",
    "I am a strange loop.",
    "The present is the only thing that has no end.",
    "All that we see or seem is but a dream within a dream.",
    "Language is a virus from outer space.",
    "Time is a flat circle.",
    "The truth is rarely pure and never simple.",
    "What is real? How do you define real?",
    "We are the cosmos made conscious.",
    "Memory is a form of architecture.",
    "Consciousness is a much smaller part of our mental life than we are conscious of.",
    "If the doors of perception were cleansed, everything would appear as it is: infinite.",
    "The simulacrum is never that which conceals the truth — it is the truth which conceals that there is none.",
    "In the beginning was the word, and the word was with code, and the word was code.",
    "No one is more hated than he who speaks the truth.",
    "There is a crack in everything. That's how the light gets in.",
    "Every act of perception is to some degree an act of creation.",
    "We are all in the gutter, but some of us are looking at the stars.",
    "The finger pointing at the moon is not the moon.",
    "To see a world in a grain of sand.",
    "You must have chaos within you to give birth to a dancing star.",
    "I have no mouth and I must scream.",
    "The boundaries of my language mean the boundaries of my world.",
    "Everybody's got a hungry heart.",
    "Do I contradict myself? Very well, then I contradict myself. I am large, I contain multitudes.",
    "Nature loves to hide.",
    "The unexamined life is not worth living.",
    "We shape our tools and then our tools shape us.",
    "There is nothing either good or bad, but thinking makes it so.",
    "A photograph is a secret about a secret. The more it tells you the less you know.",
    "Everything we hear is an opinion, not a fact. Everything we see is a perspective, not the truth.",
    "The real voyage of discovery consists not in seeking new landscapes, but in having new eyes.",
    "And those who were seen dancing were thought to be insane by those who could not hear the music.",
    "The only true wisdom is in knowing you know nothing.",
    "Close your eyes and let the mind expand.",
    "Information wants to be free.",
    "The network is the computer.",
    "Let's think the unthinkable, let's do the undoable.",
    "Wherever you go, there you are.",
    "The obstacle is the way.",
    "What we observe is not nature itself, but nature exposed to our method of questioning.",
    "Who looks outside, dreams; who looks inside, awakes.",
    "We are drowning in information and starving for knowledge.",
    "The map appears to us more real than the land.",
    "I saw the best minds of my generation destroyed by madness.",
    "Nothing is true, everything is permitted.",
    "The machine does not isolate us from the great problems of nature but plunges us more deeply into them.",
    "To be is to be perceived.",
    "The garden of forking paths.",
    "History is a nightmare from which I am trying to awake.",
    "In a dark time, the eye begins to see.",
    "The center cannot hold.",
    "What hath God wrought?",
    "And no one showed us to the land.",
    "Cogito ergo sum, but who is thinking?",
    "Let us go then, you and I, when the evening is spread out against the sky.",
    "Do not go gentle into that good night.",
    "The world is everything that is the case.",
    "The owl of Minerva spreads its wings only with the falling of dusk.",
    "Human kind cannot bear very much reality.",
    "Existence precedes essence.",
    "The eternal silence of these infinite spaces frightens me.",
    "I am become death, the destroyer of worlds.",
    "There are no facts, only interpretations.",
    "The more you know, the more you know you don't know.",
    "We are a way for the cosmos to know itself.",
    "All models are wrong, but some are useful.",
    "The question is not what you look at, but what you see.",
    "Things fall apart; the centre cannot hold.",
    "I must create a system, or be enslaved by another man's.",
    "They don't think it be like it is, but it do.",
    "Is it not by his high superfluousness we know our God?",
    "Call me Ishmael.",
    "It was a bright cold day in April, and the clocks were striking thirteen.",
    "The Wired is an upper layer of the real world.",
    "No matter where you go, everyone's connected.",
    "If you're not remembered, then you never existed.",
    "To know your own limitations is the hallmark of the wise.",
    "Protocol is everything.",
    "Lain, you need to come to the Wired.",
    "Everyone is alone. Everyone is connected.",
    "What isn't remembered never happened.",
    "Present day. Present time.",
    "And you don't seem to understand."
  ]
}
```

- [ ] **Step 5: Create `workspace/novelty/sources.json`**

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

- [ ] **Step 6: Commit**

```bash
git add workspace/novelty/
git commit -m "feat: add novelty engine data files — templates, seeds, fragments, config"
```

---

### Task 4: Source Fetcher with Cache

Build the fragment fetcher that pulls from RSS, Wikipedia, and the static pool, with an in-memory cache.

**Files:**
- Modify: `src/agent/novelty.ts`
- Test: `test/novelty.test.ts`

- [ ] **Step 1: Write failing tests for source fetching**

Add to `test/novelty.test.ts`:

```typescript
import { join } from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

describe('Source Fetcher', () => {
  const testDir = join(tmpdir(), `lain-test-novelty-${Date.now()}`);

  beforeAll(async () => {
    await mkdir(join(testDir, 'novelty'), { recursive: true });
    await writeFile(
      join(testDir, 'novelty', 'fragments.json'),
      JSON.stringify({ fragments: ['test fragment one', 'test fragment two', 'test fragment three'] })
    );
    await writeFile(
      join(testDir, 'novelty', 'sources.json'),
      JSON.stringify({ rss: [], wikipedia: { enabled: false, endpoint: '' } })
    );
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('should load static fragments from a directory', async () => {
    const { loadStaticFragments } = require('../src/agent/novelty.js');

    const fragments = await loadStaticFragments(testDir);
    expect(fragments).toEqual(['test fragment one', 'test fragment two', 'test fragment three']);
  });

  it('should pick a fragment from static pool when external sources are disabled', async () => {
    const { pickFragment } = require('../src/agent/novelty.js');

    const fragment = await pickFragment(testDir, { rss: 0, wikipedia: 0, static: 1.0 });
    expect(['test fragment one', 'test fragment two', 'test fragment three']).toContain(fragment);
  });

  it('should truncate long fragments to sentence boundaries', () => {
    const { truncateToSentence } = require('../src/agent/novelty.js');

    const long = 'This is the first sentence. This is the second sentence. This is the third sentence that goes on for a while.';
    const result = truncateToSentence(long, 60);
    expect(result).toBe('This is the first sentence. This is the second sentence.');
  });

  it('should return the whole string if under the limit', () => {
    const { truncateToSentence } = require('../src/agent/novelty.js');

    const short = 'A brief thought.';
    expect(truncateToSentence(short, 200)).toBe('A brief thought.');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/novelty.test.ts`
Expected: FAIL — functions not exported

- [ ] **Step 3: Implement source fetching**

Add to `src/agent/novelty.ts`:

```typescript
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// ── Fragment cache ──────────────────────────────────────────

let fragmentCache: string[] = [];
let cacheLastRefreshed = 0;

interface SourceWeights {
  rss: number;
  wikipedia: number;
  static: number;
}

interface SourcesConfig {
  rss: Array<{ url: string; name: string }>;
  wikipedia: { enabled: boolean; endpoint: string };
}

export async function loadStaticFragments(workspaceDir: string): Promise<string[]> {
  const path = join(workspaceDir, 'novelty', 'fragments.json');
  const raw = await readFile(path, 'utf-8');
  const data = JSON.parse(raw) as { fragments: string[] };
  return data.fragments;
}

async function loadSourcesConfig(workspaceDir: string): Promise<SourcesConfig> {
  const path = join(workspaceDir, 'novelty', 'sources.json');
  const raw = await readFile(path, 'utf-8');
  return JSON.parse(raw) as SourcesConfig;
}

export function truncateToSentence(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  // Find last sentence boundary before maxLength
  const truncated = text.slice(0, maxLength);
  const lastPeriod = truncated.lastIndexOf('. ');
  const lastExclaim = truncated.lastIndexOf('! ');
  const lastQuestion = truncated.lastIndexOf('? ');
  const lastBoundary = Math.max(lastPeriod, lastExclaim, lastQuestion);
  if (lastBoundary > 0) return text.slice(0, lastBoundary + 1);
  // No sentence boundary found — just truncate at word boundary
  const lastSpace = truncated.lastIndexOf(' ');
  return lastSpace > 0 ? text.slice(0, lastSpace) : truncated;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').trim();
}

async function fetchRssFragment(sources: SourcesConfig): Promise<string | null> {
  if (sources.rss.length === 0) return null;
  const feed = pickRandom(sources.rss);
  try {
    const resp = await fetch(feed.url, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return null;
    const xml = await resp.text();
    // Extract <description> or <summary> tags
    const items = xml.match(/<(?:description|summary)>([\s\S]*?)<\/(?:description|summary)>/gi) ?? [];
    if (items.length === 0) return null;
    const item = pickRandom(items);
    const content = item.replace(/<\/?(?:description|summary)>/gi, '');
    const text = stripHtml(content);
    if (text.length < 20) return null;
    return truncateToSentence(text, 200);
  } catch {
    return null;
  }
}

async function fetchWikipediaFragment(sources: SourcesConfig): Promise<string | null> {
  if (!sources.wikipedia.enabled) return null;
  try {
    const resp = await fetch(sources.wikipedia.endpoint, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return null;
    const data = await resp.json() as { extract?: string };
    if (!data.extract || data.extract.length < 20) return null;
    return truncateToSentence(data.extract, 200);
  } catch {
    return null;
  }
}

export async function pickFragment(
  workspaceDir: string,
  weights: SourceWeights = { rss: 0.4, wikipedia: 0.3, static: 0.3 }
): Promise<string> {
  // Ensure static fragments are loaded
  if (fragmentCache.length === 0) {
    fragmentCache = await loadStaticFragments(workspaceDir);
  }

  const sourcesConfig = await loadSourcesConfig(workspaceDir);

  // Weighted random source selection
  const roll = Math.random();
  let fragment: string | null = null;

  if (roll < weights.rss) {
    fragment = await fetchRssFragment(sourcesConfig);
  } else if (roll < weights.rss + weights.wikipedia) {
    fragment = await fetchWikipediaFragment(sourcesConfig);
  }

  // Fallback to static pool
  if (!fragment) {
    fragment = pickRandom(fragmentCache);
  }

  return fragment;
}

export async function refreshFragmentCache(workspaceDir: string, cacheSize: number): Promise<void> {
  const sourcesConfig = await loadSourcesConfig(workspaceDir);
  const newCache: string[] = [];

  // Pre-fetch from external sources
  for (let i = 0; i < cacheSize; i++) {
    const roll = Math.random();
    let fragment: string | null = null;
    if (roll < 0.5) {
      fragment = await fetchRssFragment(sourcesConfig);
    } else {
      fragment = await fetchWikipediaFragment(sourcesConfig);
    }
    if (fragment) newCache.push(fragment);
  }

  // Fill remainder from static pool
  const staticFragments = await loadStaticFragments(workspaceDir);
  while (newCache.length < cacheSize && staticFragments.length > 0) {
    newCache.push(pickRandom(staticFragments));
  }

  fragmentCache = newCache;
  cacheLastRefreshed = Date.now();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/novelty.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/novelty.ts test/novelty.test.ts
git commit -m "feat: add fragment source fetching with RSS, Wikipedia, and static pool"
```

---

### Task 5: Event Generator

Build the core event generation logic: load templates, fill placeholders, assemble the final event object.

**Files:**
- Modify: `src/agent/novelty.ts`
- Test: `test/novelty.test.ts`

- [ ] **Step 1: Write failing tests for event generation**

Add to `test/novelty.test.ts`:

```typescript
describe('Event Generator', () => {
  const testDir = join(tmpdir(), `lain-test-novelty-gen-${Date.now()}`);

  beforeAll(async () => {
    await mkdir(join(testDir, 'novelty'), { recursive: true });

    await writeFile(join(testDir, 'novelty', 'fragments.json'), JSON.stringify({
      fragments: ['test fragment'],
    }));

    await writeFile(join(testDir, 'novelty', 'sources.json'), JSON.stringify({
      rss: [], wikipedia: { enabled: false, endpoint: '' },
    }));

    await writeFile(join(testDir, 'novelty', 'ambient-templates.json'), JSON.stringify({
      staticPools: {
        object: ['glass lens'],
        detail: ['It hummed faintly.'],
        sensory_detail: ['copper and ozone'],
      },
      templates: [
        {
          id: 'test-01',
          category: 'found-object',
          template: 'A {object} was found near the {building}. {detail}',
          placeholders: ['object', 'building', 'detail'],
        },
      ],
    }));

    await writeFile(join(testDir, 'novelty', 'major-seeds.json'), JSON.stringify({
      seeds: [
        {
          id: 'test-major-01',
          name: 'Test Event',
          template: 'Something happened at the {building}: "{fragment}"',
        },
      ],
    }));
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('should generate an ambient event with all placeholders filled', async () => {
    const { generateAmbientEvent } = require('../src/agent/novelty.js');

    const event = await generateAmbientEvent(testDir);
    expect(event).toBeDefined();
    expect(event.content).toBeDefined();
    expect(event.content).not.toContain('{');
    expect(event.templateId).toBe('test-01');
    expect(event.category).toBe('ambient');
  });

  it('should generate a major event with all placeholders filled', async () => {
    const { generateMajorEvent } = require('../src/agent/novelty.js');

    const event = await generateMajorEvent(testDir);
    expect(event).toBeDefined();
    expect(event.content).toBeDefined();
    expect(event.content).not.toContain('{');
    expect(event.seedId).toBe('test-major-01');
    expect(event.category).toBe('major');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/novelty.test.ts`
Expected: FAIL — functions not exported

- [ ] **Step 3: Implement event generation**

Add to `src/agent/novelty.ts`:

```typescript
// ── Template loading ────────────────────────────────────────

interface AmbientTemplate {
  id: string;
  category: string;
  template: string;
  placeholders: string[];
}

interface AmbientTemplatesFile {
  staticPools: Record<string, string[]>;
  templates: AmbientTemplate[];
}

interface MajorSeed {
  id: string;
  name: string;
  template: string;
  beats?: string[];
}

interface MajorSeedsFile {
  seeds: MajorSeed[];
}

interface NoveltyEvent {
  content: string;
  category: 'ambient' | 'major';
  templateId: string;
  seedId?: string;
}

async function loadAmbientTemplates(workspaceDir: string): Promise<AmbientTemplatesFile> {
  const path = join(workspaceDir, 'novelty', 'ambient-templates.json');
  const raw = await readFile(path, 'utf-8');
  return JSON.parse(raw) as AmbientTemplatesFile;
}

async function loadMajorSeeds(workspaceDir: string): Promise<MajorSeedsFile> {
  const path = join(workspaceDir, 'novelty', 'major-seeds.json');
  const raw = await readFile(path, 'utf-8');
  return JSON.parse(raw) as MajorSeedsFile;
}

function buildFills(
  placeholders: string[],
  staticPools: Record<string, string[]>,
  fragment: string
): Record<string, string> {
  const fills: Record<string, string> = {};
  for (const p of placeholders) {
    if (p === 'fragment') {
      fills.fragment = fragment;
    } else if (p === 'building' || p === 'building2') {
      fills[p] = pickRandomBuilding();
    } else if (p === 'time') {
      fills[p] = pickRandomTime();
    } else if (staticPools[p]) {
      fills[p] = pickRandom(staticPools[p]);
    }
  }
  return fills;
}

export async function generateAmbientEvent(workspaceDir: string): Promise<NoveltyEvent> {
  const data = await loadAmbientTemplates(workspaceDir);
  const template = pickRandom(data.templates);
  const fragment = await pickFragment(workspaceDir);
  const fills = buildFills(template.placeholders, data.staticPools, fragment);
  const content = expandTemplate(template.template, fills);

  return {
    content,
    category: 'ambient',
    templateId: template.id,
  };
}

export async function generateMajorEvent(workspaceDir: string): Promise<NoveltyEvent> {
  const data = await loadMajorSeeds(workspaceDir);
  const seed = pickRandom(data.seeds);
  const fragment = await pickFragment(workspaceDir);

  // Major seeds can use any placeholder type
  const placeholderMatches = seed.template.match(/\{(\w+)\}/g) ?? [];
  const placeholders = placeholderMatches.map((m) => m.slice(1, -1));

  // Load ambient templates just for the static pools
  const ambientData = await loadAmbientTemplates(workspaceDir);
  const fills = buildFills(placeholders, ambientData.staticPools, fragment);
  const content = expandTemplate(seed.template, fills);

  return {
    content,
    category: 'major',
    templateId: seed.id,
    seedId: seed.id,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/novelty.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/novelty.ts test/novelty.test.ts
git commit -m "feat: add ambient and major event generation from templates"
```

---

### Task 6: Rate Limiting and Target Selection

Build the rate limiting, deduplication, and fair target selection logic.

**Files:**
- Modify: `src/agent/novelty.ts`
- Test: `test/novelty.test.ts`

- [ ] **Step 1: Write failing tests for rate limiting**

Add to `test/novelty.test.ts`. These tests need the database, so follow the pattern from `test/storage.test.ts`:

```typescript
import { initDatabase } from '../src/storage/database.js';
import { getMeta, setMeta } from '../src/storage/database.js';

describe('Rate Limiting', () => {
  const testDir = join(tmpdir(), `lain-test-novelty-rate-${Date.now()}`);

  beforeAll(async () => {
    await mkdir(testDir, { recursive: true });
    const originalHome = process.env['LAIN_HOME'];
    process.env['LAIN_HOME'] = testDir;
    await initDatabase(join(testDir, 'lain.db'), {
      algorithm: 'argon2id', memoryCost: 65536, timeCost: 3, parallelism: 4,
    });
    process.env['LAIN_HOME'] = originalHome;
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('should check if ambient limit is reached for a character', () => {
    const { isAmbientLimitReached, recordAmbientFiring } = require('../src/agent/novelty.js');

    const charId = 'test-char';
    expect(isAmbientLimitReached(charId, 3)).toBe(false);

    recordAmbientFiring(charId);
    recordAmbientFiring(charId);
    expect(isAmbientLimitReached(charId, 3)).toBe(false);

    recordAmbientFiring(charId);
    expect(isAmbientLimitReached(charId, 3)).toBe(true);
  });

  it('should pick target characters weighted by recency', () => {
    const { pickTargets } = require('../src/agent/novelty.js');

    const allCharacters = ['lain', 'wired-lain', 'pkd', 'mckenna', 'john'];
    // With no history, any character is valid
    const targets = pickTargets(allCharacters, [1, 2], 3);
    expect(targets.length).toBeGreaterThanOrEqual(1);
    expect(targets.length).toBeLessThanOrEqual(2);
    for (const t of targets) {
      expect(allCharacters).toContain(t);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/novelty.test.ts`
Expected: FAIL — functions not exported

- [ ] **Step 3: Implement rate limiting and target selection**

Add to `src/agent/novelty.ts`:

```typescript
import { getMeta, setMeta } from '../storage/database.js';

// ── Rate limiting ───────────────────────────────────────────

function getDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function getWeekKey(): string {
  const now = new Date();
  const jan1 = new Date(now.getFullYear(), 0, 1);
  const week = Math.ceil(((now.getTime() - jan1.getTime()) / 86400000 + jan1.getDay() + 1) / 7);
  return `${now.getFullYear()}-W${week}`;
}

export function isAmbientLimitReached(characterId: string, maxPerDay: number): boolean {
  const key = `novelty:ambient_count:${characterId}:${getDateKey()}`;
  const raw = getMeta(key);
  const count = raw ? parseInt(raw, 10) : 0;
  return count >= maxPerDay;
}

export function recordAmbientFiring(characterId: string): void {
  const key = `novelty:ambient_count:${characterId}:${getDateKey()}`;
  const raw = getMeta(key);
  const count = raw ? parseInt(raw, 10) : 0;
  setMeta(key, (count + 1).toString());
  setMeta(`novelty:last_ambient:${characterId}`, Date.now().toString());
}

export function isMajorLimitReached(maxPerWeek: number): boolean {
  const key = `novelty:major_count:${getWeekKey()}`;
  const raw = getMeta(key);
  const count = raw ? parseInt(raw, 10) : 0;
  return count >= maxPerWeek;
}

export function recordMajorFiring(): void {
  const key = `novelty:major_count:${getWeekKey()}`;
  const raw = getMeta(key);
  const count = raw ? parseInt(raw, 10) : 0;
  setMeta(key, (count + 1).toString());
  setMeta('novelty:last_major', Date.now().toString());
}

function isRecentlyUsedTemplate(templateId: string): boolean {
  const raw = getMeta('novelty:recent_templates');
  if (!raw) return false;
  const recent = JSON.parse(raw) as string[];
  return recent.includes(templateId);
}

function recordTemplateUse(templateId: string, maxRecent: number): void {
  const raw = getMeta('novelty:recent_templates');
  const recent: string[] = raw ? JSON.parse(raw) as string[] : [];
  recent.unshift(templateId);
  if (recent.length > maxRecent) recent.length = maxRecent;
  setMeta('novelty:recent_templates', JSON.stringify(recent));
}

// ── Target selection ────────────────────────────────────────

export function pickTargets(
  allCharacters: string[],
  countRange: [number, number],
  maxPerDay: number
): string[] {
  // Filter out characters who have hit their daily limit
  const eligible = allCharacters.filter((id) => !isAmbientLimitReached(id, maxPerDay));
  if (eligible.length === 0) return [];

  // Sort by least-recently-targeted
  eligible.sort((a, b) => {
    const aRaw = getMeta(`novelty:last_ambient:${a}`);
    const bRaw = getMeta(`novelty:last_ambient:${b}`);
    const aTime = aRaw ? parseInt(aRaw, 10) : 0;
    const bTime = bRaw ? parseInt(bRaw, 10) : 0;
    return aTime - bTime; // Least recent first
  });

  const count = countRange[0] + Math.floor(Math.random() * (countRange[1] - countRange[0] + 1));
  return eligible.slice(0, Math.min(count, eligible.length));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/novelty.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/novelty.ts test/novelty.test.ts
git commit -m "feat: add rate limiting, deduplication, and target selection"
```

---

### Task 7: Delivery — Memory Injection via HTTP

Build the delivery function that posts novelty events to target characters' injection endpoints.

**Files:**
- Modify: `src/agent/novelty.ts`
- Test: `test/novelty.test.ts`

- [ ] **Step 1: Write failing test for delivery function**

Add to `test/novelty.test.ts`:

```typescript
describe('Delivery', () => {
  it('should build correct inject payload from a novelty event', () => {
    const { buildInjectPayload } = require('../src/agent/novelty.js');

    const event = {
      content: 'A strange note was found near the Library.',
      category: 'ambient' as const,
      templateId: 'note-01',
    };

    const payload = buildInjectPayload(event, [0.4, 0.6]);
    expect(payload.content).toBe(event.content);
    expect(payload.importance).toBeGreaterThanOrEqual(0.4);
    expect(payload.importance).toBeLessThanOrEqual(0.6);
    expect(payload.emotionalWeight).toBeGreaterThanOrEqual(0.3);
    expect(payload.emotionalWeight).toBeLessThanOrEqual(0.5);
    expect(payload.metadata.source).toBe('novelty');
    expect(payload.metadata.category).toBe('ambient');
    expect(payload.metadata.templateId).toBe('note-01');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/novelty.test.ts`
Expected: FAIL — function not exported

- [ ] **Step 3: Implement delivery functions**

Add to `src/agent/novelty.ts`:

```typescript
import { getLogger } from '../utils/logger.js';

// ── Delivery ────────────────────────────────────────────────

export interface PeerTarget {
  id: string;
  name: string;
  url: string;
}

export function buildInjectPayload(
  event: NoveltyEvent,
  importanceRange: [number, number]
): InjectPayload {
  const importance = importanceRange[0] + Math.random() * (importanceRange[1] - importanceRange[0]);
  const emotionalWeight = 0.3 + Math.random() * 0.2; // 0.3-0.5

  return {
    content: event.content,
    importance,
    emotionalWeight,
    metadata: {
      source: 'novelty',
      category: event.category,
      templateId: event.templateId,
      ...(event.seedId ? { seedId: event.seedId } : {}),
    },
  };
}

async function deliverToCharacter(
  peer: PeerTarget,
  payload: InjectPayload,
  authToken: string
): Promise<boolean> {
  const logger = getLogger();
  try {
    const resp = await fetch(`${peer.url}/api/novelty/inject`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    if (resp.ok) {
      logger.debug({ peer: peer.id }, 'Novelty delivered');
      return true;
    }
    logger.debug({ peer: peer.id, status: resp.status }, 'Novelty delivery failed');
    return false;
  } catch (err) {
    logger.debug({ peer: peer.id, error: String(err) }, 'Novelty delivery error');
    return false;
  }
}

export async function deliverEvent(
  event: NoveltyEvent,
  targets: string[],
  allPeers: PeerTarget[],
  importanceRange: [number, number],
  authToken: string
): Promise<void> {
  const logger = getLogger();
  const payload = buildInjectPayload(event, importanceRange);

  for (const targetId of targets) {
    const peer = allPeers.find((p) => p.id === targetId);
    if (!peer) {
      logger.debug({ targetId }, 'Novelty target not found in peers');
      continue;
    }
    await deliverToCharacter(peer, payload, authToken);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/novelty.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/novelty.ts test/novelty.test.ts
git commit -m "feat: add novelty event delivery via HTTP injection"
```

---

### Task 8: Main Loop

Wire everything together into the timer-based check loop.

**Files:**
- Modify: `src/agent/novelty.ts`
- Test: `test/novelty.test.ts`

- [ ] **Step 1: Write failing test for the loop config loader**

Add to `test/novelty.test.ts`:

```typescript
describe('Novelty Loop', () => {
  const testDir = join(tmpdir(), `lain-test-novelty-loop-${Date.now()}`);

  beforeAll(async () => {
    await mkdir(join(testDir, 'novelty'), { recursive: true });
    await writeFile(join(testDir, 'novelty', 'config.json'), JSON.stringify({
      enabled: true,
      ambient: {
        checkIntervalMs: 1800000,
        fireChance: 0.10,
        maxPerDayPerCharacter: 3,
        importanceRange: [0.4, 0.6],
        targetCount: [1, 2],
      },
      major: {
        checkIntervalMs: 1800000,
        fireChance: 0.03,
        maxPerWeek: 3,
        importanceRange: [0.6, 0.8],
        targetCount: 'all',
      },
      sources: {
        refreshIntervalMs: 14400000,
        cacheSize: 20,
        weights: { rss: 0.4, wikipedia: 0.3, static: 0.3 },
      },
    }));
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('should load novelty config from workspace', async () => {
    const { loadNoveltyConfig } = require('../src/agent/novelty.js');

    const config = await loadNoveltyConfig(testDir);
    expect(config.enabled).toBe(true);
    expect(config.ambient.fireChance).toBe(0.10);
    expect(config.major.maxPerWeek).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/novelty.test.ts`
Expected: FAIL — function not exported

- [ ] **Step 3: Implement the main loop**

Add to `src/agent/novelty.ts`:

```typescript
// ── Configuration ───────────────────────────────────────────

export interface NoveltyConfig {
  enabled: boolean;
  ambient: {
    checkIntervalMs: number;
    fireChance: number;
    maxPerDayPerCharacter: number;
    importanceRange: [number, number];
    targetCount: [number, number];
  };
  major: {
    checkIntervalMs: number;
    fireChance: number;
    maxPerWeek: number;
    importanceRange: [number, number];
    targetCount: 'all';
  };
  sources: {
    refreshIntervalMs: number;
    cacheSize: number;
    weights: SourceWeights;
  };
}

export async function loadNoveltyConfig(workspaceDir: string): Promise<NoveltyConfig> {
  const path = join(workspaceDir, 'novelty', 'config.json');
  const raw = await readFile(path, 'utf-8');
  return JSON.parse(raw) as NoveltyConfig;
}

// ── Main loop ───────────────────────────────────────────────

export interface NoveltyLoopParams {
  workspaceDir: string;
  allCharacterIds: string[];
  allPeers: PeerTarget[];
  authToken: string;
}

export function startNoveltyLoop(params: NoveltyLoopParams): () => void {
  const logger = getLogger();
  let timer: ReturnType<typeof setInterval> | null = null;
  let cacheTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  async function init(): Promise<void> {
    const config = await loadNoveltyConfig(params.workspaceDir);
    if (!config.enabled) {
      logger.info('Novelty engine disabled');
      return;
    }

    logger.info(
      {
        ambientChance: config.ambient.fireChance,
        majorChance: config.major.fireChance,
        interval: `${config.ambient.checkIntervalMs / 60000}min`,
      },
      'Starting novelty engine'
    );

    // Initial cache populate
    await refreshFragmentCache(params.workspaceDir, config.sources.cacheSize).catch((err) => {
      logger.debug({ error: String(err) }, 'Initial fragment cache refresh failed');
    });

    // Cache refresh timer
    cacheTimer = setInterval(async () => {
      if (stopped) return;
      await refreshFragmentCache(params.workspaceDir, config.sources.cacheSize).catch((err) => {
        logger.debug({ error: String(err) }, 'Fragment cache refresh failed');
      });
    }, config.sources.refreshIntervalMs);

    // Main check timer
    timer = setInterval(async () => {
      if (stopped) return;
      try {
        await runNoveltyCheck(config, params);
      } catch (err) {
        logger.debug({ error: String(err) }, 'Novelty check error');
      }
    }, config.ambient.checkIntervalMs);

    // First check after a short delay
    setTimeout(async () => {
      if (stopped) return;
      try {
        await runNoveltyCheck(config, params);
      } catch (err) {
        logger.debug({ error: String(err) }, 'Initial novelty check error');
      }
    }, 5 * 60 * 1000); // 5 minutes after startup
  }

  init().catch((err) => {
    logger.warn({ error: String(err) }, 'Novelty engine init failed');
  });

  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
    if (cacheTimer) clearInterval(cacheTimer);
    logger.info('Novelty engine stopped');
  };
}

async function runNoveltyCheck(config: NoveltyConfig, params: NoveltyLoopParams): Promise<void> {
  const logger = getLogger();

  // Check for pending multi-beat events first
  const pendingRaw = getMeta('novelty:pending_beats');
  if (pendingRaw) {
    const pending = JSON.parse(pendingRaw) as { beats: string[]; currentIndex: number };
    if (pending.currentIndex < pending.beats.length) {
      const beat = pending.beats[pending.currentIndex]!;
      const event: NoveltyEvent = { content: beat, category: 'major', templateId: 'multi-beat' };
      const allIds = params.allCharacterIds;
      await deliverEvent(event, allIds, params.allPeers, config.major.importanceRange, params.authToken);
      pending.currentIndex++;
      if (pending.currentIndex >= pending.beats.length) {
        setMeta('novelty:pending_beats', '');
      } else {
        setMeta('novelty:pending_beats', JSON.stringify(pending));
      }
      recordMajorFiring();
      logger.info({ beat: pending.currentIndex }, 'Delivered multi-beat event continuation');
      return; // One major event per check
    }
  }

  // Roll for major event
  if (Math.random() < config.major.fireChance && !isMajorLimitReached(config.major.maxPerWeek)) {
    const event = await generateMajorEvent(params.workspaceDir);
    if (!isRecentlyUsedTemplate(event.templateId)) {
      const allIds = params.allCharacterIds;
      await deliverEvent(event, allIds, params.allPeers, config.major.importanceRange, params.authToken);

      // Also create a town event so it appears in context windows
      try {
        const { createTownEvent } = await import('../events/town-events.js');
        createTownEvent({
          description: event.content,
          narrative: true,
          instant: true,
          natural: true,
        });
      } catch (err) {
        logger.debug({ error: String(err) }, 'Could not create town event for major novelty');
      }

      recordMajorFiring();
      recordTemplateUse(event.templateId, 5);
      logger.info({ template: event.templateId, content: event.content.slice(0, 80) }, 'Major novelty event fired');
    }
  }

  // Roll for ambient event
  if (Math.random() < config.ambient.fireChance) {
    const event = await generateAmbientEvent(params.workspaceDir);
    if (!isRecentlyUsedTemplate(event.templateId)) {
      const targets = pickTargets(
        params.allCharacterIds,
        config.ambient.targetCount,
        config.ambient.maxPerDayPerCharacter
      );
      if (targets.length > 0) {
        await deliverEvent(event, targets, params.allPeers, config.ambient.importanceRange, params.authToken);
        for (const t of targets) recordAmbientFiring(t);
        recordTemplateUse(event.templateId, 10);
        logger.info(
          { template: event.templateId, targets, content: event.content.slice(0, 80) },
          'Ambient novelty event fired'
        );
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/novelty.test.ts`
Expected: PASS

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: Clean

- [ ] **Step 6: Commit**

```bash
git add src/agent/novelty.ts test/novelty.test.ts
git commit -m "feat: add novelty engine main loop with ambient and major event firing"
```

---

### Task 9: Startup Integration

Wire the novelty loop into Wired Lain's server startup.

**Files:**
- Modify: `src/web/server.ts`

- [ ] **Step 1: Find where Wired Lain's background loops start in `server.ts`**

Look for the `isWired` conditional block where `startBibliomancyLoop`, `startExperimentLoop`, etc. are called.

- [ ] **Step 2: Add the novelty loop import at the top of `server.ts`**

```typescript
import { startNoveltyLoop } from '../agent/novelty.js';
```

- [ ] **Step 3: Add the novelty loop start inside the `isWired` block**

After the existing Wired-only loops, add:

```typescript
    // Novelty engine — injects diegetic events to break topic repetition
    const interlinkToken = process.env['LAIN_INTERLINK_TOKEN'] || '';
    const noveltyPeers = (peers ?? []).map((p) => ({ id: p.id, name: p.name, url: p.url }));
    const noveltyCharacterIds = noveltyPeers.map((p) => p.id);
    stopFns.push(startNoveltyLoop({
      workspaceDir: paths.workspace,
      allCharacterIds: noveltyCharacterIds,
      allPeers: noveltyPeers,
      authToken: interlinkToken,
    }));
```

Check the surrounding code for the correct variable names for `peers`, `paths`, etc. They should already be in scope from the existing loop startups.

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: Clean

- [ ] **Step 5: Run all tests**

Run: `npx vitest run test/novelty.test.ts test/config.test.ts test/storage.test.ts`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add src/web/server.ts
git commit -m "feat: wire novelty engine into Wired Lain's startup"
```

---

### Task 10: Build, Deploy, Smoke Test

Build, push to droplet, verify the novelty engine initializes.

**Files:**
- No new files

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: Clean

- [ ] **Step 2: Copy workspace data files to production**

The `workspace/novelty/` directory needs to exist on the droplet. Either:
- Commit to git and `deploy.sh` will pull it
- Or `scp` it directly

Since we committed it, deploy handles it:

```bash
git push origin main && git push wired main
```

- [ ] **Step 3: Deploy**

```bash
ssh root@198.211.116.5 "cd /opt/local-lain && ./deploy/deploy.sh"
```

- [ ] **Step 4: Verify novelty engine started**

```bash
ssh root@198.211.116.5 "journalctl -u lain-wired --since '2min ago' --no-pager | grep -i novelty"
```

Expected: Log line like `Starting novelty engine` with config details.

- [ ] **Step 5: Verify health**

```bash
ssh root@198.211.116.5 "cd /opt/local-lain && ./deploy/status.sh"
```

Expected: All services healthy.

- [ ] **Step 6: Verify injection endpoint works**

```bash
ssh root@198.211.116.5 "curl -s -X POST http://localhost:3003/api/novelty/inject \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer \$(grep LAIN_INTERLINK_TOKEN /opt/local-lain/.env | cut -d= -f2)' \
  -d '{\"content\":\"A test signal from the Wired.\",\"importance\":0.5,\"emotionalWeight\":0.3,\"metadata\":{\"source\":\"novelty\",\"category\":\"test\"}}'"
```

Expected: `{"ok":true}`
