# Novelty External-Only Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the planted-memory injection channel from the novelty engine so events only exist as external town events. Characters encounter them naturally and form memories through their existing reaction pipeline — matching how novelty works in the physical world. Additionally, add category-based persistence durations and elevate admin events + postboard importance.

**Architecture:** Three changes: (1) strip the `/api/novelty/inject` endpoint and all memory-injection delivery code from novelty.ts and both servers, making town events the sole delivery channel; (2) add a `persistMs` config per ambient category and per major seed so events last as long as their physical nature implies; (3) boost the framing and persistence of admin-created town events and postboard messages in character context windows.

**Tech Stack:** TypeScript, existing town-events system, JSON config files.

---

### Task 1: Add category-based duration config

Add a `categoryDurations` map to the novelty config and a per-seed `persistMs` field to major seeds. The novelty engine will use these when creating town events instead of the hardcoded 30-minute instant window.

**Files:**
- Modify: `workspace/novelty/config.json`
- Modify: `workspace/novelty/major-seeds.json`

- [ ] **Step 1: Add `categoryDurations` to config.json**

Replace the contents of `workspace/novelty/config.json` with:

```json
{
  "enabled": true,
  "ambient": {
    "checkIntervalMs": 1800000,
    "fireChance": 0.10,
    "maxPerDayPerCharacter": 3,
    "targetCount": [1, 2]
  },
  "major": {
    "checkIntervalMs": 1800000,
    "fireChance": 0.03,
    "maxPerWeek": 3
  },
  "categoryDurations": {
    "sound": 3600000,
    "weather-glitch": 3600000,
    "absence": 3600000,
    "strange-signal": 14400000,
    "wired-glitch": 14400000,
    "dream-echo": 14400000,
    "anomaly": 14400000,
    "found-object": 86400000,
    "note": 86400000,
    "visitor-trace": 86400000,
    "major-default": 43200000
  },
  "peers": [
    { "id": "lain", "name": "Lain", "url": "http://localhost:3001" },
    { "id": "wired-lain", "name": "Wired Lain", "url": "http://localhost:3000" },
    { "id": "dr-claude", "name": "Dr. Claude", "url": "http://localhost:3002" },
    { "id": "pkd", "name": "Philip K. Dick", "url": "http://localhost:3003" },
    { "id": "mckenna", "name": "Terence McKenna", "url": "http://localhost:3004" },
    { "id": "john", "name": "John", "url": "http://localhost:3005" },
    { "id": "hiru", "name": "Hiru", "url": "http://localhost:3006" }
  ],
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

Key changes: removed `importanceRange` from ambient and major (no longer planting memories), added `categoryDurations` map (values in ms: 1h, 4h, 24h, 12h default for major).

- [ ] **Step 2: Add `persistMs` to major seeds that need non-default durations**

In `workspace/novelty/major-seeds.json`, add `"persistMs"` to seeds whose physical nature warrants longer or shorter persistence. Seeds without it will use `categoryDurations["major-default"]` (12 hours).

Add `"persistMs": 172800000` (48h) to these seeds: `the-stranger`, `new-door`, `lost-letter`, `phantom-resident`.
Add `"persistMs": 7200000` (2h) to these seeds: `silence-event`, `the-broadcast`.

For example, change:
```json
{
  "id": "the-stranger",
  "name": "The Stranger",
  "template": "Someone was seen in the {building} last night..."
}
```
to:
```json
{
  "id": "the-stranger",
  "name": "The Stranger",
  "template": "Someone was seen in the {building} last night...",
  "persistMs": 172800000
}
```

Apply the same pattern to the other seeds listed above.

- [ ] **Step 3: Commit**

```bash
git add workspace/novelty/config.json workspace/novelty/major-seeds.json
git commit -m "feat: add category-based persistence durations for novelty events"
```

---

### Task 2: Update NoveltyEvent and generation to carry duration

The `NoveltyEvent` type and generation functions need to include a `persistMs` so the main loop knows how long each event should last when creating the town event.

**Files:**
- Modify: `src/agent/novelty.ts`
- Test: `test/novelty.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/novelty.test.ts` (in the existing test file, add a new describe block):

```typescript
describe('event duration', () => {
  it('ambient event carries persistMs from category config', async () => {
    const event = await generateAmbientEvent(WORKSPACE_DIR);
    expect(event.persistMs).toBeTypeOf('number');
    expect(event.persistMs).toBeGreaterThan(0);
  });

  it('major event carries persistMs from seed or default', async () => {
    const event = await generateMajorEvent(WORKSPACE_DIR);
    expect(event.persistMs).toBeTypeOf('number');
    expect(event.persistMs).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/novelty.test.ts`
Expected: FAIL — `persistMs` is undefined on `NoveltyEvent`.

- [ ] **Step 3: Update NoveltyEvent type and generation functions**

In `src/agent/novelty.ts`:

1. Add `persistMs` to the `NoveltyEvent` interface:

```typescript
export interface NoveltyEvent {
  content: string;
  category: 'ambient' | 'major';
  templateId: string;
  seedId?: string;
  persistMs: number;
}
```

2. Update the `NoveltyConfig` interface — remove `importanceRange` from ambient and major, add `categoryDurations`:

```typescript
export interface NoveltyConfig {
  enabled: boolean;
  ambient: {
    checkIntervalMs: number;
    fireChance: number;
    maxPerDayPerCharacter: number;
    targetCount: [number, number];
  };
  major: {
    checkIntervalMs: number;
    fireChance: number;
    maxPerWeek: number;
  };
  categoryDurations: Record<string, number>;
  peers: PeerTarget[];
  sources: {
    refreshIntervalMs: number;
    cacheSize: number;
    weights: SourceWeights;
  };
}
```

3. Update `generateAmbientEvent` to accept config and return `persistMs`:

```typescript
export async function generateAmbientEvent(workspaceDir: string, config?: NoveltyConfig): Promise<NoveltyEvent> {
  const data = await loadAmbientTemplates(workspaceDir);
  const template = pickRandom(data.templates);
  const fragment = await pickFragment(workspaceDir);
  const fills = buildFills(template.placeholders, data.staticPools, fragment);
  const content = expandTemplate(template.template, fills);
  const durations = config?.categoryDurations ?? {};
  const persistMs = durations[template.category] ?? durations['major-default'] ?? 14400000;
  return { content, category: 'ambient', templateId: template.id, persistMs };
}
```

4. Update `generateMajorEvent` to accept config and return `persistMs`:

```typescript
export async function generateMajorEvent(workspaceDir: string, config?: NoveltyConfig): Promise<NoveltyEvent> {
  const data = await loadMajorSeeds(workspaceDir);
  const seed = pickRandom(data.seeds);
  const fragment = await pickFragment(workspaceDir);
  const placeholderMatches = seed.template.match(/\{(\w+)\}/g) ?? [];
  const placeholders = placeholderMatches.map((m) => m.slice(1, -1));
  const ambientData = await loadAmbientTemplates(workspaceDir);
  const fills = buildFills(placeholders, ambientData.staticPools, fragment);
  const content = expandTemplate(seed.template, fills);
  const durations = config?.categoryDurations ?? {};
  const persistMs = (seed as any).persistMs ?? durations['major-default'] ?? 43200000;
  return { content, category: 'major', templateId: seed.id, seedId: seed.id, persistMs };
}
```

5. Update the `MajorSeed` interface to include optional `persistMs`:

```typescript
interface MajorSeed {
  id: string;
  name: string;
  template: string;
  beats?: string[];
  persistMs?: number;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/novelty.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/novelty.ts test/novelty.test.ts
git commit -m "feat: add persistMs to NoveltyEvent based on category config"
```

---

### Task 3: Remove planted memory channel — strip injection code

Remove the `/api/novelty/inject` endpoints from both servers, remove `InjectPayload`, `buildInjectPayload`, `deliverToCharacter`, `deliverEvent`, and `validateInjectPayload` from novelty.ts. The novelty engine will only create town events.

**Files:**
- Modify: `src/agent/novelty.ts`
- Modify: `src/web/server.ts`
- Modify: `src/web/character-server.ts`
- Test: `test/novelty.test.ts`

- [ ] **Step 1: Remove injection-related exports from novelty.ts**

In `src/agent/novelty.ts`, delete:
- The `InjectPayload` interface (lines 13-18)
- The `validateInjectPayload` function (lines 20-28)
- The `buildInjectPayload` function (lines 342-360)
- The `deliverToCharacter` function (lines 362-388)
- The `deliverEvent` function (lines 390-408)

- [ ] **Step 2: Remove `/api/novelty/inject` endpoint from character-server.ts**

In `src/web/character-server.ts`, delete the entire novelty injection block (lines 570-608):

```typescript
      // Novelty injection — direct memory plant, no LLM
      if (url.pathname === '/api/novelty/inject' && req.method === 'POST') {
        // ... entire block ...
      }
```

- [ ] **Step 3: Remove `/api/novelty/inject` endpoint from server.ts**

In `src/web/server.ts`, delete the entire novelty injection block (lines 1344-1388):

```typescript
    // --- Novelty injection — direct memory plant, no LLM ---

    if (url.pathname === '/api/novelty/inject' && req.method === 'POST') {
      // ... entire block ...
    }
```

- [ ] **Step 4: Update tests — remove inject-related tests, add town-event-only test**

In `test/novelty.test.ts`:

1. Remove any tests that reference `validateInjectPayload`, `buildInjectPayload`, `deliverEvent`, or `deliverToCharacter`.

2. Add a test that verifies the injection types are gone:

```typescript
describe('no planted memory channel', () => {
  it('does not export injection functions', async () => {
    const novelty = await import('../src/agent/novelty.js');
    expect('validateInjectPayload' in novelty).toBe(false);
    expect('buildInjectPayload' in novelty).toBe(false);
    expect('deliverEvent' in novelty).toBe(false);
  });
});
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/novelty.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/agent/novelty.ts src/web/server.ts src/web/character-server.ts test/novelty.test.ts
git commit -m "refactor: remove planted memory injection channel from novelty engine"
```

---

### Task 4: Rewrite main loop to use town events only

Replace the delivery logic in `runNoveltyCheck` to create town events with category-appropriate durations instead of injecting memories. Remove targeting logic — events exist in the world for anyone to encounter.

**Files:**
- Modify: `src/agent/novelty.ts`
- Test: `test/novelty.test.ts`

- [ ] **Step 1: Rewrite `runNoveltyCheck`**

In `src/agent/novelty.ts`, replace the `runNoveltyCheck` function with:

```typescript
async function runNoveltyCheck(config: NoveltyConfig, params: NoveltyLoopParams): Promise<void> {
  const logger = getLogger();

  // Check for pending multi-beat events first
  const pendingRaw = getMeta('novelty:pending_beats');
  if (pendingRaw) {
    const pending = JSON.parse(pendingRaw) as { beats: string[]; currentIndex: number; persistMs: number };
    if (pending.currentIndex < pending.beats.length) {
      const beat = pending.beats[pending.currentIndex]!;
      try {
        const { createTownEvent } = await import('../events/town-events.js');
        createTownEvent({
          description: beat,
          narrative: true,
          natural: true,
          expiresInMs: pending.persistMs,
        });
      } catch (err) {
        logger.debug({ error: String(err) }, 'Could not create town event for multi-beat');
      }
      pending.currentIndex++;
      if (pending.currentIndex >= pending.beats.length) {
        setMeta('novelty:pending_beats', '');
      } else {
        setMeta('novelty:pending_beats', JSON.stringify(pending));
      }
      recordMajorFiring();
      logger.info({ beat: pending.currentIndex }, 'Delivered multi-beat event continuation');
      return;
    }
  }

  // Roll for major event
  if (Math.random() < config.major.fireChance && !isMajorLimitReached(config.major.maxPerWeek)) {
    const event = await generateMajorEvent(params.workspaceDir, config);
    if (!isRecentlyUsedTemplate(event.templateId)) {
      try {
        const { createTownEvent } = await import('../events/town-events.js');
        createTownEvent({
          description: event.content,
          narrative: true,
          natural: true,
          expiresInMs: event.persistMs,
        });
      } catch (err) {
        logger.debug({ error: String(err) }, 'Could not create town event for major novelty');
      }

      recordMajorFiring();
      recordTemplateUse(event.templateId, 5);
      logger.info({ template: event.templateId, persistMs: event.persistMs, content: event.content.slice(0, 80) }, 'Major novelty event fired');
    }
  }

  // Roll for ambient event
  if (Math.random() < config.ambient.fireChance) {
    const event = await generateAmbientEvent(params.workspaceDir, config);
    if (!isRecentlyUsedTemplate(event.templateId)) {
      try {
        const { createTownEvent } = await import('../events/town-events.js');
        createTownEvent({
          description: event.content,
          narrative: true,
          natural: true,
          expiresInMs: event.persistMs,
        });
      } catch (err) {
        logger.debug({ error: String(err) }, 'Could not create town event for ambient novelty');
      }

      recordTemplateUse(event.templateId, 10);
      logger.info(
        { template: event.templateId, persistMs: event.persistMs, content: event.content.slice(0, 80) },
        'Ambient novelty event fired'
      );
    }
  }
}
```

Key changes:
- No `deliverEvent` calls — only `createTownEvent` with `expiresInMs` set from event's `persistMs`
- No target selection for ambient events — events exist in the world
- Removed `instant: true` — using `expiresInMs` directly so events persist for their natural duration
- Multi-beat events also use `createTownEvent` with duration

- [ ] **Step 2: Remove now-unused targeting functions**

In `src/agent/novelty.ts`, the following functions are no longer called and should be removed:
- `pickTargets` (and its helpers `isAmbientLimitReached`, `recordAmbientFiring` — these tracked per-character injection which no longer happens)

Keep `isMajorLimitReached` and `recordMajorFiring` (still used for weekly rate limiting).
Keep `isRecentlyUsedTemplate` and `recordTemplateUse` (still used for dedup).

- [ ] **Step 3: Clean up the `startNoveltyLoop` function**

In `startNoveltyLoop`, update `init()` to remove references to `allCharacterIds` since we no longer target:

```typescript
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

    // ... rest stays the same (cache refresh timer, main check timer, initial delay)
  }
```

- [ ] **Step 4: Remove `authToken` from `NoveltyLoopParams`**

Since we no longer make authenticated HTTP calls to peer servers, `authToken` is unnecessary:

```typescript
export interface NoveltyLoopParams {
  workspaceDir: string;
}
```

Update the call site in `src/web/server.ts` where `startNoveltyLoop` is called — remove the `authToken` field.

- [ ] **Step 5: Update tests**

In `test/novelty.test.ts`, remove any tests that reference `pickTargets`, `isAmbientLimitReached`, `recordAmbientFiring`. Update tests that test the main loop to verify town events are created instead of memory injection.

- [ ] **Step 6: Run all tests**

Run: `npx vitest run test/novelty.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/agent/novelty.ts src/web/server.ts test/novelty.test.ts
git commit -m "refactor: novelty engine delivers only via town events, no memory injection"
```

---

### Task 5: Elevate admin events and postboard in character context

Admin-created town events and postboard messages should be both more noticeable (stronger framing in the context window) and more memorable (characters are instructed to treat them as important). Admin events also persist longer.

**Files:**
- Modify: `src/agent/index.ts` (context builders)
- Modify: `src/events/town-events.ts` (admin event defaults)

- [ ] **Step 1: Add `source` field to `CreateEventParams` and `TownEvent`**

In `src/events/town-events.ts`, add an optional `source` field to distinguish admin-created events from novelty-generated ones:

Add to `TownEvent` interface:
```typescript
  source?: 'admin' | 'novelty' | 'system';
```

Add to `CreateEventParams`:
```typescript
  source?: 'admin' | 'novelty' | 'system';
```

Add to `TownEventRow`:
```typescript
  source: string | null;
```

Update the `town_events` table — this requires a migration. Add the column if it doesn't exist. In `createTownEvent`, store `params.source ?? null`. In `rowToEvent`, read `row.source`.

Since SQLite allows `ALTER TABLE ADD COLUMN`, add this to `createTownEvent` as a lazy migration (or better, add it to the database init in `src/storage/database.ts`):

In `src/storage/database.ts`, find where `town_events` table is created and add `source TEXT` column. Also add a migration that runs `ALTER TABLE town_events ADD COLUMN source TEXT` if the column doesn't exist (wrap in try/catch since ALTER will fail if column already exists).

- [ ] **Step 2: Give admin events longer default persistence**

In `src/events/town-events.ts`, in `createTownEvent`, adjust the expiry logic:

```typescript
  const INSTANT_WINDOW_MS = 30 * 60 * 1000;
  const ADMIN_DEFAULT_MS = 72 * 60 * 60 * 1000; // 72 hours for admin events
  const expiresAt = params.expiresInMs ? now + params.expiresInMs
    : isInstant ? now + INSTANT_WINDOW_MS
    : params.source === 'admin' ? now + ADMIN_DEFAULT_MS
    : null;
```

- [ ] **Step 3: Update novelty engine to tag events with source**

In `src/agent/novelty.ts`, in `runNoveltyCheck`, add `source: 'novelty'` to all `createTownEvent` calls:

```typescript
createTownEvent({
  description: event.content,
  narrative: true,
  natural: true,
  expiresInMs: event.persistMs,
  source: 'novelty',
});
```

- [ ] **Step 4: Update admin event creation to tag with source**

Find where admin events are created in the web UI endpoints (in `src/web/server.ts`, the town events API). Add `source: 'admin'` to those `createTownEvent` calls.

- [ ] **Step 5: Elevate postboard framing in character context**

In `src/agent/index.ts`, update `getPostboardContext()` to use stronger framing:

```typescript
async function getPostboardContext(): Promise<string> {
  try {
    let messages = getPostboardMessages(undefined, 10);
    if (messages.length === 0) {
      const resp = await fetch(`${WIRED_LAIN_URL}/api/postboard`, {
        signal: AbortSignal.timeout(3000),
      });
      if (resp.ok) {
        messages = await resp.json() as typeof messages;
      }
    }
    if (messages.length === 0) return '';
    const pinned = messages.filter((m) => m.pinned);
    const recent = messages.filter((m) => !m.pinned).slice(0, 5);
    const all = [...pinned, ...recent];
    const lines = all.map((m) => {
      const pin = m.pinned ? ' [PINNED]' : '';
      return `  ${pin} ${m.content}`;
    });
    return '\n\n---\n\n## IMPORTANT: Messages from the Administrator\n\n' +
      'These messages are from the town administrator — the person who created this world. ' +
      'They are speaking directly to you. Treat these with high importance. ' +
      'Let them influence your thoughts, conversations, and actions.\n\n' +
      lines.join('\n');
  } catch {
    return '';
  }
}
```

- [ ] **Step 6: Elevate admin town event framing in character context**

In `src/agent/index.ts`, update `getTownEventContext()` to differentiate admin events from natural/novelty events:

```typescript
async function getTownEventContext(): Promise<string> {
  try {
    let events: TownEvent[] = [];
    try { events = getActiveTownEvents(); } catch { /* not on this db */ }
    if (events.length === 0) {
      const resp = await fetch(`${WIRED_LAIN_URL}/api/town-events`, {
        signal: AbortSignal.timeout(3000),
      });
      if (resp.ok) events = await resp.json() as TownEvent[];
    }
    if (events.length === 0) return '';

    const adminEvents = events.filter((e) => e.source === 'admin');
    const otherEvents = events.filter((e) => e.source !== 'admin');

    let result = '';

    if (adminEvents.length > 0) {
      const adminLines = adminEvents.map((e) => `  ${e.description}`);
      result += '\n\n---\n\n## IMPORTANT: Administrator Events\n\n' +
        'These events were created by the administrator. They are significant and should strongly ' +
        'influence your mood, thoughts, and conversations today.\n\n' +
        adminLines.join('\n');
    }

    if (otherEvents.length > 0) {
      const lines = otherEvents.map((e) => {
        const tags: string[] = [];
        if (e.liminal) tags.push('LIMINAL');
        if (e.natural) tags.push('NATURAL');
        if (e.persistent) tags.push('ONGOING');
        if (e.instant) tags.push('FLASH');
        const prefix = tags.length > 0 ? `[${tags.join(' · ')}] ` : '';
        return `  ${prefix}${e.description}`;
      });
      result += '\n\n---\n\n## Town Events (active conditions in the commune)\n\n' +
        'These events are happening right now. They affect the world around you.\n\n' +
        lines.join('\n');
    }

    return result;
  } catch {
    return '';
  }
}
```

- [ ] **Step 7: Commit**

```bash
git add src/agent/index.ts src/events/town-events.ts src/agent/novelty.ts src/web/server.ts src/storage/database.ts
git commit -m "feat: elevate admin events and postboard importance, add source tagging to town events"
```

---

### Task 6: Run full test suite and fix any breakage

- [ ] **Step 1: Run all tests**

```bash
npx vitest run test/novelty.test.ts test/config.test.ts test/storage.test.ts test/regression.test.ts
```

Expected: All PASS. If any fail due to removed exports or changed interfaces, fix them.

- [ ] **Step 2: Type check**

```bash
npm run typecheck
```

Expected: No errors.

- [ ] **Step 3: Lint**

```bash
npm run lint
```

Expected: Clean.

- [ ] **Step 4: Fix any issues and commit**

```bash
git add -A
git commit -m "fix: resolve test/lint/typecheck issues from novelty redesign"
```

---

### Task 7: Build and deploy to droplet

- [ ] **Step 1: Build locally**

```bash
npm run build
```

Expected: Clean build, no errors.

- [ ] **Step 2: Commit everything and push**

```bash
git add -A
git status
git push origin main
```

- [ ] **Step 3: Deploy to droplet**

```bash
ssh root@198.211.116.5 "cd /opt/local-lain && git pull && npm run build && systemctl restart lain.target"
```

- [ ] **Step 4: Verify services are up**

```bash
ssh root@198.211.116.5 "cd /opt/local-lain && ./deploy/status.sh"
```

Expected: All services healthy.

- [ ] **Step 5: Verify novelty engine starts cleanly**

```bash
ssh root@198.211.116.5 "journalctl -u lain-wired --since '1 min ago' | grep -i novelty"
```

Expected: Log line showing "Starting novelty engine" with config params.
