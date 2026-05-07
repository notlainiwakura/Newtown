# Fixture System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add immovable furniture objects to Laintown buildings with custom procedural sprites and agent awareness.

**Architecture:** Fixtures are regular objects in the existing `objects` table, distinguished by `metadata.fixture = true`. Server-side guards prevent pickup/destroy. A new `fixtures.js` provides per-item procedural sprite renderers. Building context in the agent prompt includes fixtures.

**Tech Stack:** TypeScript (Node.js), Phaser 3 canvas API, SQLite, vitest

**Spec:** `docs/superpowers/specs/2026-04-09-fixture-system-design.md`

---

### Task 1: Server-side fixture guards

Protect fixtures from pickup, destroy, give, and drop at the API level in `server.ts`. This is the critical safety layer — even if tool-level guards fail, the API rejects mutation of fixtures.

**Files:**
- Modify: `src/web/server.ts:1415-1498`
- Modify: `src/objects/store.ts`
- Test: `test/regression.test.ts`

- [ ] **Step 1: Add `isFixture` helper to objects store**

In `src/objects/store.ts`, add after the `countByLocation` function (line 170):

```typescript
/** Check if an object is a fixture (immovable building furniture). */
export function isFixture(objectId: string): boolean {
  const obj = getObject(objectId);
  if (!obj) return false;
  return (obj.metadata as Record<string, unknown>)?.fixture === true;
}
```

- [ ] **Step 2: Add fixture guard to pickup endpoint**

In `src/web/server.ts`, in the `POST /api/objects/:id/pickup` handler (line 1418), after the interlink auth check and before the `pickupObject` call, add a fixture check:

```typescript
        const id = url.pathname.split('/')[3]!;
        // Block fixture pickup
        if (isFixture(id)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'This is a fixture and cannot be picked up' }));
          return;
        }
        const body = await collectBody(req);
```

Add `isFixture` to the import from `../objects/store.js` at the top of server.ts.

- [ ] **Step 3: Add fixture guard to destroy endpoint**

In `src/web/server.ts`, in the `DELETE /api/objects/:id` handler (line 1484), after the interlink auth check:

```typescript
        const id = url.pathname.slice('/api/objects/'.length);
        // Block fixture destruction
        if (isFixture(id)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'This is a fixture and cannot be destroyed' }));
          return;
        }
        const body = await collectBody(req);
```

- [ ] **Step 4: Add fixture guard to give endpoint**

In `src/web/server.ts`, in the `POST /api/objects/:id/give` handler (line 1462), after the interlink auth check:

```typescript
        const id = url.pathname.split('/')[3]!;
        // Block fixture transfer
        if (isFixture(id)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'This is a fixture and cannot be transferred' }));
          return;
        }
        const body = await collectBody(req);
```

- [ ] **Step 5: Write regression tests for fixture guards**

Add a new section to `test/regression.test.ts`:

```typescript
// ─────────────────────────────────────────────────────────
// N. FIXTURE IMMUTABILITY — Fixtures cannot be picked up, destroyed, or transferred
// ─────────────────────────────────────────────────────────
describe('Fixture Immutability', () => {
  it('isFixture returns true for fixture objects', async () => {
    // Setup: create a temp LAIN_HOME so we get a fresh DB
    const testDir = join(tmpdir(), 'lain-fixture-test-' + Date.now());
    await mkdir(testDir, { recursive: true });
    const origHome = process.env['LAIN_HOME'];
    process.env['LAIN_HOME'] = testDir;

    try {
      // Re-import to pick up new LAIN_HOME
      const { createObject, isFixture: isFixtureFn, getObject: getObjectFn } = await import('../src/objects/store.js');

      // Create a normal object
      const normal = createObject('rock', 'a plain rock', 'test', 'Tester', 'bar');
      expect(isFixtureFn(normal.id)).toBe(false);

      // Create a fixture
      const fixture = createObject('desk lamp', 'a lamp', 'admin', 'Administrator', 'lighthouse', { fixture: true, spriteId: 'lamp_desk' });
      expect(isFixtureFn(fixture.id)).toBe(true);

      // Non-existent returns false
      expect(isFixtureFn('nonexistent')).toBe(false);
    } finally {
      if (origHome) {
        process.env['LAIN_HOME'] = origHome;
      } else {
        delete process.env['LAIN_HOME'];
      }
      await rm(testDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run test/regression.test.ts`
Expected: All existing tests pass + new fixture test passes.

- [ ] **Step 7: Commit**

```bash
git add src/objects/store.ts src/web/server.ts test/regression.test.ts
git commit -m "feat(fixtures): add server-side guards preventing pickup/destroy/give of fixtures"
```

---

### Task 2: Tool-level fixture guards

Add fixture checks in character tools so agents get a clear error message when trying to interact with fixtures. This is defense-in-depth — the server guards (Task 1) are the real safety net.

**Files:**
- Modify: `src/agent/character-tools.ts:604-640,777-810`

- [ ] **Step 1: Add fixture check to pickup_object tool handler**

In `src/agent/character-tools.ts`, in the `pickup_object` handler (line 604), before the fetch call, add:

```typescript
    handler: async (input) => {
      const objectId = input.object_id as string;

      // Check if this is a fixture — fixtures can't be picked up
      try {
        const checkResp = await fetch(`${wiredLainUrl}/api/objects/${objectId}`, {
          signal: AbortSignal.timeout(5000),
        });
        if (checkResp.ok) {
          const obj = await checkResp.json() as { metadata?: Record<string, unknown> };
          if (obj.metadata?.fixture) {
            return 'This is part of the building — it can\'t be picked up.';
          }
        }
      } catch { /* fall through to pickup attempt */ }

      try {
        const resp = await fetch(`${wiredLainUrl}/api/objects/${objectId}/pickup`, {
```

- [ ] **Step 2: Add fixture check to destroy_object tool handler**

In `src/agent/character-tools.ts`, in the `destroy_object` handler (line 777), before the fetch call, add the same pattern:

```typescript
    handler: async (input) => {
      const objectId = input.object_id as string;
      const reason = (input.reason as string | undefined) ?? '';

      // Check if this is a fixture — fixtures can't be destroyed
      try {
        const checkResp = await fetch(`${wiredLainUrl}/api/objects/${objectId}`, {
          signal: AbortSignal.timeout(5000),
        });
        if (checkResp.ok) {
          const obj = await checkResp.json() as { metadata?: Record<string, unknown> };
          if (obj.metadata?.fixture) {
            return 'This is part of the building — it can\'t be removed.';
          }
        }
      } catch { /* fall through to destroy attempt */ }

      try {
        const resp = await fetch(`${wiredLainUrl}/api/objects/${objectId}`, {
```

- [ ] **Step 3: Commit**

```bash
git add src/agent/character-tools.ts
git commit -m "feat(fixtures): add tool-level guards with clear error messages for agents"
```

---

### Task 3: Fixture sprite registry

Create the procedural sprite system for fixtures. Each fixture type gets a canvas draw function, registered by `spriteId`.

**Files:**
- Create: `src/web/public/game/js/fixtures.js`

- [ ] **Step 1: Create fixtures.js with registry and lamp sprite**

Create `src/web/public/game/js/fixtures.js`:

```javascript
/**
 * LAINTOWN GAME — Fixture Sprites
 * Procedural canvas renderers for building fixtures (furniture, lights, etc).
 * Each entry maps a spriteId to a draw function.
 */

const FIXTURE_SIZE = 48;

const FIXTURE_SPRITES = {
  /**
   * Brushed steel desk lamp with warm glow.
   * Requested by John for the Lighthouse.
   */
  lamp_desk: (ctx, theme) => {
    const W = FIXTURE_SIZE;
    const H = FIXTURE_SIZE;
    const cx = W / 2;

    // Warm glow circle (behind everything)
    const glow = ctx.createRadialGradient(cx, 12, 2, cx, 12, 22);
    glow.addColorStop(0, 'rgba(255, 220, 140, 0.35)');
    glow.addColorStop(0.5, 'rgba(255, 200, 100, 0.12)');
    glow.addColorStop(1, 'rgba(255, 180, 80, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, 12, 22, 0, Math.PI * 2);
    ctx.fill();

    // Base plate — oval at bottom
    ctx.fillStyle = '#8a8a90';
    ctx.beginPath();
    ctx.ellipse(cx, H - 6, 10, 4, 0, 0, Math.PI * 2);
    ctx.fill();
    // Base highlight
    ctx.fillStyle = '#a0a0a8';
    ctx.beginPath();
    ctx.ellipse(cx, H - 7, 7, 2, 0, Math.PI, 0);
    ctx.fill();

    // Arm — angled steel rod from base to lamp head
    ctx.strokeStyle = '#9a9aa0';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(cx, H - 10);
    ctx.lineTo(cx - 2, H - 22);
    // Elbow joint
    ctx.lineTo(cx + 6, 16);
    ctx.stroke();

    // Joint dot
    ctx.fillStyle = '#7a7a82';
    ctx.beginPath();
    ctx.arc(cx - 2, H - 22, 2, 0, Math.PI * 2);
    ctx.fill();

    // Lamp head — conical shade
    ctx.fillStyle = '#a0a0a8';
    ctx.beginPath();
    ctx.moveTo(cx + 6, 14);
    ctx.lineTo(cx + 14, 8);
    ctx.lineTo(cx + 12, 18);
    ctx.closePath();
    ctx.fill();
    // Inner shade shadow
    ctx.fillStyle = '#888890';
    ctx.beginPath();
    ctx.moveTo(cx + 7, 15);
    ctx.lineTo(cx + 13, 10);
    ctx.lineTo(cx + 12, 17);
    ctx.closePath();
    ctx.fill();

    // Light beam — soft triangle downward from shade
    const beam = ctx.createLinearGradient(cx + 10, 18, cx + 10, 38);
    beam.addColorStop(0, 'rgba(255, 220, 140, 0.25)');
    beam.addColorStop(1, 'rgba(255, 220, 140, 0)');
    ctx.fillStyle = beam;
    ctx.beginPath();
    ctx.moveTo(cx + 8, 18);
    ctx.lineTo(cx + 2, 38);
    ctx.lineTo(cx + 18, 38);
    ctx.closePath();
    ctx.fill();
  },
};

/**
 * Render a fixture sprite onto a Phaser canvas texture.
 * Returns true if a renderer exists for the given spriteId.
 */
function renderFixtureSprite(scene, textureKey, spriteId) {
  const renderer = FIXTURE_SPRITES[spriteId];
  if (!renderer) return false;

  if (!scene.textures.exists(textureKey)) {
    const canvas = scene.textures.createCanvas(textureKey, FIXTURE_SIZE, FIXTURE_SIZE);
    const ctx = canvas.getContext();
    renderer(ctx, typeof GAME_THEME !== 'undefined' ? GAME_THEME : {});
    canvas.refresh();
  }
  return true;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/web/public/game/js/fixtures.js
git commit -m "feat(fixtures): add procedural sprite registry with desk lamp renderer"
```

---

### Task 4: ObjectManager fixture rendering

Update ObjectManager to use fixture sprites for fixture objects: custom sprite, fixed tile position, no float animation.

**Files:**
- Modify: `src/web/public/game/js/systems/ObjectManager.js:48-113`
- Modify: `src/web/public/game/index.html:151`

- [ ] **Step 1: Add fixtures.js script tag to game HTML**

In `src/web/public/game/index.html`, add the fixtures script after `sprites.js` and before the systems:

```html
  <script src="/game/js/sprites.js"></script>

  <!-- Fixture sprite renderers -->
  <script src="/game/js/fixtures.js"></script>

  <!-- Systems -->
  <script src="/game/js/systems/APIClient.js"></script>
```

- [ ] **Step 2: Update _createObjectSprite for fixtures**

Replace the `_createObjectSprite` method in `src/web/public/game/js/systems/ObjectManager.js` (lines 48-113):

```javascript
  // Create a sprite for a ground object
  _createObjectSprite(obj) {
    if (!obj.location || obj.ownerId) return; // only ground objects
    if (this.sprites[obj.id]) return; // already rendered

    const isFixture = obj.metadata?.fixture === true;
    const spriteId = obj.metadata?.spriteId;

    // Use fixed tile position for fixtures, random for regular objects
    let tile;
    if (isFixture && obj.metadata?.tileX != null && obj.metadata?.tileY != null) {
      tile = { x: obj.metadata.tileX, y: obj.metadata.tileY };
      this.occupiedTiles.add(tile.x + ',' + tile.y);
    } else {
      tile = this._pickTileInBuilding(obj.location);
    }

    const pos = tileToScreen(tile.x, tile.y);
    const key = 'obj_' + obj.id;

    // Try fixture sprite first, fall back to generic diamond
    let useFixtureSprite = false;
    if (isFixture && spriteId && typeof renderFixtureSprite === 'function') {
      useFixtureSprite = renderFixtureSprite(this.scene, key, spriteId);
    }

    if (!useFixtureSprite && !this.scene.textures.exists(key)) {
      // Generic diamond sprite (existing behavior)
      const canvas = this.scene.textures.createCanvas(key, 24, 24);
      const ctx = canvas.getContext();
      const hue = this._hashColor(obj.name);
      ctx.fillStyle = hue;
      ctx.beginPath();
      ctx.moveTo(12, 2);
      ctx.lineTo(22, 12);
      ctx.lineTo(12, 22);
      ctx.lineTo(2, 12);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#ffffff40';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(12, 12, 2, 0, Math.PI * 2);
      ctx.fill();
      canvas.refresh();
    }

    const sprite = this.scene.add.sprite(pos.x, pos.y + 8, key);
    sprite.setDepth(tile.x + tile.y + 0.3);
    sprite.setOrigin(0.5, 0.5);
    sprite.setScale(isFixture ? 1.8 : 1.5);

    // Make clickable — show object info on click
    sprite.setInteractive({ useHandCursor: true });
    sprite.on('pointerdown', () => {
      this._showObjectPopup(obj, pos);
    });

    // Subtle float animation for regular objects only — fixtures are static
    if (!isFixture) {
      this.scene.tweens.add({
        targets: sprite,
        y: pos.y + 4,
        duration: 1500 + Math.random() * 500,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
    }

    const label = this.scene.add.text(pos.x, pos.y + (isFixture ? 30 : 22), obj.name, {
      fontSize: '16px',
      fontFamily: 'monospace',
      color: GAME_THEME.objectLabel,
      align: 'center',
    });
    label.setOrigin(0.5, 0);
    label.setDepth(tile.x + tile.y + 0.4);

    this.sprites[obj.id] = { sprite, label, tileX: tile.x, tileY: tile.y };
  }
```

- [ ] **Step 3: Commit**

```bash
git add src/web/public/game/js/systems/ObjectManager.js src/web/public/game/index.html
git commit -m "feat(fixtures): render fixture sprites with fixed position and no float"
```

---

### Task 5: Fixture context injection for agents

Add fixtures to the building context in the agent system prompt, so inhabitants know what's in their building.

**Files:**
- Modify: `src/agent/town-life.ts:402-420`

- [ ] **Step 1: Separate fixtures from regular objects in context**

In `src/agent/town-life.ts`, replace the objects context block (lines 402-420):

```typescript
  // Fetch objects at current location and in inventory from Wired Lain registry
  let objectsContext = '';
  try {
    const wiredUrl = process.env['WIRED_LAIN_URL'] || 'http://localhost:3000';
    const [hereResp, invResp] = await Promise.all([
      fetch(`${wiredUrl}/api/objects?location=${encodeURIComponent(loc.building)}`, { signal: AbortSignal.timeout(5000) }).catch(() => null),
      fetch(`${wiredUrl}/api/objects?owner=${encodeURIComponent(config.characterId)}`, { signal: AbortSignal.timeout(5000) }).catch(() => null),
    ]);
    const hereObjects = hereResp?.ok ? await hereResp.json() as { id: string; name: string; description: string; creatorName: string; metadata?: Record<string, unknown> }[] : [];
    const invObjects = invResp?.ok ? await invResp.json() as { id: string; name: string; description: string; creatorName: string }[] : [];
    const parts: string[] = [];

    // Separate fixtures from loose objects
    const fixtures = hereObjects.filter((o) => o.metadata?.fixture === true);
    const looseObjects = hereObjects.filter((o) => !o.metadata?.fixture);

    if (fixtures.length > 0) {
      parts.push(`FIXTURES HERE:\n${fixtures.map((o) => `- "${o.name}" — ${o.description.slice(0, 120)}`).join('\n')}`);
    }
    if (looseObjects.length > 0) {
      parts.push(`OBJECTS HERE:\n${looseObjects.map((o) => `- [${o.id}] "${o.name}" by ${o.creatorName} — ${o.description.slice(0, 100)}`).join('\n')}`);
    }
    if (invObjects.length > 0) {
      parts.push(`YOUR INVENTORY:\n${invObjects.map((o) => `- [${o.id}] "${o.name}" — ${o.description.slice(0, 100)}`).join('\n')}`);
    }
    objectsContext = parts.join('\n\n');
  } catch { /* ignore — objects are optional context */ }
```

Note: fixtures don't show their `[id]` — agents shouldn't try to manipulate them by ID.

- [ ] **Step 2: Commit**

```bash
git add src/agent/town-life.ts
git commit -m "feat(fixtures): inject fixtures as building context in agent prompts"
```

---

### Task 6: Seed John's desk lamp and deploy

Create the first fixture in the production database and deploy all changes.

**Files:**
- No source changes — DB insert + deploy

- [ ] **Step 1: Build and run tests locally**

```bash
npm run build && npx vitest run test/regression.test.ts
```

Expected: Build succeeds, all tests pass.

- [ ] **Step 2: Commit any remaining changes and push**

```bash
git push origin main && git push wired main
```

- [ ] **Step 3: Deploy to droplet**

```bash
ssh root@198.211.116.5 "cd /opt/local-lain && git pull && npm run build && systemctl restart lain.target"
```

Wait for services to come back up, then verify:

```bash
ssh root@198.211.116.5 "cd /opt/local-lain && ./deploy/status.sh"
```

- [ ] **Step 4: Calculate fixture tile position**

The Lighthouse is at row 1, col 1. Building zone:
- `x = 8 + 1 * (12 + 4) = 24`
- `y = 5 + 1 * (10 + 4) = 19`
- Zone spans x: 24-35, y: 19-28
- Interior (avoid walls): x: 25-34, y: 20-27
- Desk lamp should be near the interior, off to one side: `tileX: 28, tileY: 22` (slightly right of center, mid-height)

- [ ] **Step 5: Seed the fixture in Wired Lain's database**

Wired Lain's DB is the canonical object registry:

```bash
ssh root@198.211.116.5 "sqlite3 /root/.lain-wired/lain.db \"INSERT INTO objects (id, name, description, creator_id, creator_name, owner_id, owner_name, location, created_at, updated_at, metadata) VALUES ('fixture_lamp_lh', 'desk lamp', 'A brushed steel task lamp with an adjustable arm, casting warm light over the desk. Requested by John.', 'admin', 'Administrator', NULL, NULL, 'lighthouse', $(date +%s000), $(date +%s000), '{\\\"fixture\\\":true,\\\"spriteId\\\":\\\"lamp_desk\\\",\\\"tileX\\\":28,\\\"tileY\\\":22}');\""
```

- [ ] **Step 6: Verify fixture appears in API**

```bash
ssh root@198.211.116.5 "curl -s http://localhost:3000/api/objects?location=lighthouse | python3 -m json.tool"
```

Expected: Response includes the desk lamp object with `fixture: true` in metadata.

- [ ] **Step 7: Verify fixture is protected**

```bash
ssh root@198.211.116.5 "curl -s -X POST http://localhost:3000/api/objects/fixture_lamp_lh/pickup -H 'Content-Type: application/json' -H 'Authorization: Bearer \$(grep LAIN_INTERLINK_TOKEN /opt/local-lain/.env | cut -d= -f2)' -d '{\"characterId\":\"john\",\"characterName\":\"John\"}'"
```

Expected: `{"error":"This is a fixture and cannot be picked up"}`

- [ ] **Step 8: Verify the game view**

Open the walk game in a browser and navigate to the Lighthouse. The desk lamp should render as a steel lamp sprite with warm glow, static (no floating), at the specified tile position.

- [ ] **Step 9: Commit deployment notes**

No code to commit — this was a DB seed + deploy step.
