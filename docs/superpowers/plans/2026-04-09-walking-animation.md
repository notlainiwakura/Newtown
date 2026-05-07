# Walking Animation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace instant character teleportation between buildings with tile-by-tile walking along paths using A* pathfinding.

**Architecture:** A pure A* pathfinding utility finds walkable routes on the existing collision map. CharacterManager uses it to animate NPCs stepping tile-by-tile from their current position through building doors and along paths to their destination, with interruption support (pause + reroute on destination change).

**Tech Stack:** Phaser 3 (tweens), vanilla JS (A* algorithm), vitest (unit tests for pathfinding)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/web/public/game/js/pathfinding.js` | Create | A* pathfinding on collision map grid |
| `src/web/public/game/js/systems/CharacterManager.js` | Modify | Walking state machine, tile-by-tile animation |
| `src/web/public/game/index.html` | Modify | Add pathfinding.js script tag |
| `test/pathfinding.test.ts` | Create | Unit tests for A* pathfinding |

---

### Task 1: A* Pathfinding Utility

**Files:**
- Create: `test/pathfinding.test.ts`
- Create: `src/web/public/game/js/pathfinding.js`

- [ ] **Step 1: Write the failing tests**

Create `test/pathfinding.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

// The pathfinding module is a browser script using globals.
// We import and eval it to test the findPath function.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Load the script and eval to get findPath into scope
const scriptPath = join(import.meta.dirname, '..', 'src', 'web', 'public', 'game', 'js', 'pathfinding.js');

function loadFindPath(): (collision: number[][], sx: number, sy: number, ex: number, ey: number) => { x: number; y: number }[] {
  const code = readFileSync(scriptPath, 'utf-8');
  // Wrap in a function scope so `findPath` is returned
  const fn = new Function(code + '\nreturn findPath;');
  return fn() as ReturnType<typeof loadFindPath>;
}

describe('A* Pathfinding', () => {
  // Simple 5x5 grid: all walkable
  const openGrid = [
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
  ];

  it('finds a straight-line path on an open grid', () => {
    const findPath = loadFindPath();
    const path = findPath(openGrid, 0, 0, 4, 0);
    expect(path.length).toBeGreaterThan(0);
    expect(path[0]).toEqual({ x: 0, y: 0 });
    expect(path[path.length - 1]).toEqual({ x: 4, y: 0 });
    // Every step should be exactly 1 tile in one cardinal direction
    for (let i = 1; i < path.length; i++) {
      const dx = Math.abs(path[i].x - path[i - 1].x);
      const dy = Math.abs(path[i].y - path[i - 1].y);
      expect(dx + dy).toBe(1);
    }
  });

  it('navigates around a wall', () => {
    const findPath = loadFindPath();
    // Wall blocks column 2 except row 4
    const grid = [
      [0, 0, 1, 0, 0],
      [0, 0, 1, 0, 0],
      [0, 0, 1, 0, 0],
      [0, 0, 1, 0, 0],
      [0, 0, 0, 0, 0],
    ];
    const path = findPath(grid, 0, 0, 4, 0);
    expect(path.length).toBeGreaterThan(0);
    expect(path[0]).toEqual({ x: 0, y: 0 });
    expect(path[path.length - 1]).toEqual({ x: 4, y: 0 });
    // No tile in the path should be on a wall
    for (const tile of path) {
      expect(grid[tile.y][tile.x]).toBe(0);
    }
  });

  it('returns empty array when no path exists', () => {
    const findPath = loadFindPath();
    // Completely walled off
    const grid = [
      [0, 1, 0],
      [1, 1, 1],
      [0, 1, 0],
    ];
    const path = findPath(grid, 0, 0, 2, 2);
    expect(path).toEqual([]);
  });

  it('returns single-element path when start equals end', () => {
    const findPath = loadFindPath();
    const path = findPath(openGrid, 2, 2, 2, 2);
    expect(path).toEqual([{ x: 2, y: 2 }]);
  });

  it('only uses cardinal directions (no diagonals)', () => {
    const findPath = loadFindPath();
    const path = findPath(openGrid, 0, 0, 3, 3);
    expect(path.length).toBeGreaterThan(0);
    for (let i = 1; i < path.length; i++) {
      const dx = Math.abs(path[i].x - path[i - 1].x);
      const dy = Math.abs(path[i].y - path[i - 1].y);
      expect(dx + dy).toBe(1);
    }
    // Manhattan distance path: should be exactly 7 tiles (start + 6 steps)
    expect(path.length).toBe(7);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/pathfinding.test.ts`
Expected: FAIL — `pathfinding.js` doesn't exist yet

- [ ] **Step 3: Write the A* implementation**

Create `src/web/public/game/js/pathfinding.js`:

```javascript
/**
 * LAINTOWN GAME — A* Pathfinding
 * Finds tile-by-tile paths on the collision map grid.
 * Used by CharacterManager for inter-building walking animation.
 */

/**
 * Find a walkable path between two tile coordinates using A*.
 * @param {number[][]} collision - 2D collision map (0 = walkable, 1 = blocked)
 * @param {number} sx - Start tile X
 * @param {number} sy - Start tile Y
 * @param {number} ex - End tile X
 * @param {number} ey - End tile Y
 * @returns {{x: number, y: number}[]} Ordered array of tiles from start to end, or empty if no path
 */
function findPath(collision, sx, sy, ex, ey) {
  // Same tile — trivial
  if (sx === ex && sy === ey) return [{ x: sx, y: sy }];

  const rows = collision.length;
  const cols = collision[0].length;

  // Bounds check
  if (sx < 0 || sx >= cols || sy < 0 || sy >= rows) return [];
  if (ex < 0 || ex >= cols || ey < 0 || ey >= rows) return [];
  if (collision[sy][sx] || collision[ey][ex]) return [];

  // Cardinal directions only (no diagonals)
  const DIRS = [
    { dx: 1, dy: 0 },
    { dx: -1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: 0, dy: -1 },
  ];

  // Manhattan distance heuristic
  function heuristic(x, y) {
    return Math.abs(x - ex) + Math.abs(y - ey);
  }

  // Open set as a simple sorted array (adequate for our ~64x48 grid)
  const open = [];
  const gScore = {};
  const cameFrom = {};

  function key(x, y) { return x + ',' + y; }

  const startKey = key(sx, sy);
  gScore[startKey] = 0;
  open.push({ x: sx, y: sy, f: heuristic(sx, sy) });

  while (open.length > 0) {
    // Pop lowest f-score
    let bestIdx = 0;
    for (let i = 1; i < open.length; i++) {
      if (open[i].f < open[bestIdx].f) bestIdx = i;
    }
    const current = open.splice(bestIdx, 1)[0];

    // Reached goal
    if (current.x === ex && current.y === ey) {
      // Reconstruct path
      const path = [];
      let k = key(current.x, current.y);
      while (k) {
        const parts = k.split(',');
        path.push({ x: parseInt(parts[0], 10), y: parseInt(parts[1], 10) });
        k = cameFrom[k];
      }
      path.reverse();
      return path;
    }

    const ck = key(current.x, current.y);
    const currentG = gScore[ck];

    for (const dir of DIRS) {
      const nx = current.x + dir.dx;
      const ny = current.y + dir.dy;

      // Bounds
      if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
      // Blocked
      if (collision[ny][nx]) continue;

      const nk = key(nx, ny);
      const tentativeG = currentG + 1;

      if (gScore[nk] === undefined || tentativeG < gScore[nk]) {
        gScore[nk] = tentativeG;
        cameFrom[nk] = ck;
        const f = tentativeG + heuristic(nx, ny);

        // Check if already in open
        let found = false;
        for (let i = 0; i < open.length; i++) {
          if (open[i].x === nx && open[i].y === ny) {
            open[i].f = f;
            found = true;
            break;
          }
        }
        if (!found) {
          open.push({ x: nx, y: ny, f: f });
        }
      }
    }
  }

  // No path found
  return [];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/pathfinding.test.ts`
Expected: ALL PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/web/public/game/js/pathfinding.js test/pathfinding.test.ts
git commit -m "feat(game): add A* pathfinding utility for inter-building walking"
```

---

### Task 2: Add pathfinding.js to game HTML

**Files:**
- Modify: `src/web/public/game/index.html:147-149`

- [ ] **Step 1: Add the script tag**

In `src/web/public/game/index.html`, after the fixtures.js script tag (line 147) and before the systems scripts (line 149), add the pathfinding script:

Replace:
```html
  <!-- Fixture sprite renderers -->
  <script src="/game/js/fixtures.js"></script>

  <!-- Systems (no Phaser dependency in class definitions) -->
```

With:
```html
  <!-- Fixture sprite renderers -->
  <script src="/game/js/fixtures.js"></script>

  <!-- Pathfinding utility -->
  <script src="/game/js/pathfinding.js"></script>

  <!-- Systems (no Phaser dependency in class definitions) -->
```

- [ ] **Step 2: Verify the file loads**

Open browser dev tools on the game page and type `findPath` in console — should be a function, not undefined.

- [ ] **Step 3: Commit**

```bash
git add src/web/public/game/index.html
git commit -m "feat(game): load pathfinding.js in game HTML"
```

---

### Task 3: Walking State and Tile-by-Tile Animation in CharacterManager

This is the core task. We replace the direct tween in `updateLocations()` with a walking state machine that steps through A* paths one tile at a time.

**Files:**
- Modify: `src/web/public/game/js/systems/CharacterManager.js`

- [ ] **Step 1: Add walking state fields to sprite entries**

In the `_createSprite` method (line 150), add three new fields to the entry object:

Replace:
```javascript
    const entry = { sprite, label, tileX, tileY, idleTween: null, wanderTimer: null, isWandering: false };
```

With:
```javascript
    const entry = {
      sprite, label, tileX, tileY,
      idleTween: null, wanderTimer: null, isWandering: false,
      // Inter-building walking state
      walkPath: null,       // Array of {x,y} tiles (null when idle)
      walkIndex: 0,         // Current index in walkPath
      pendingBuilding: null, // Queued destination if interrupted
    };
```

- [ ] **Step 2: Add the `_startBuildingWalk` method**

Add this method after `_tryApproachPeer` (after line 284):

```javascript
  // Start a tile-by-tile walk along a path to another building
  _startBuildingWalk(charId, path) {
    const entry = this.sprites[charId];
    if (!entry) return;

    // Stop idle behaviors during walk
    if (entry.idleTween) {
      entry.idleTween.destroy();
      entry.idleTween = null;
    }
    if (entry.wanderTimer) {
      entry.wanderTimer.remove();
      entry.wanderTimer = null;
    }
    entry.isWandering = false;

    // Reset sprite scale (breathing may have left it slightly off)
    entry.sprite.setScale(1, 1);

    // Set walk state
    entry.walkPath = path;
    entry.walkIndex = 0;
    entry.pendingBuilding = null;

    // Start stepping
    this._stepWalk(charId);
  }

  // Advance one tile along the walk path
  _stepWalk(charId) {
    const entry = this.sprites[charId];
    if (!entry || !entry.walkPath) return;

    // Check for interruption (new destination queued)
    if (entry.pendingBuilding) {
      this._interruptWalk(charId);
      return;
    }

    entry.walkIndex++;

    // Walk complete?
    if (entry.walkIndex >= entry.walkPath.length) {
      this._finishBuildingWalk(charId);
      return;
    }

    const nextTile = entry.walkPath[entry.walkIndex];

    // Free old tile, claim new one
    this.occupiedTiles.delete(entry.tileX + ',' + entry.tileY);
    this.occupiedTiles.add(nextTile.x + ',' + nextTile.y);
    entry.tileX = nextTile.x;
    entry.tileY = nextTile.y;

    const target = tileToScreen(nextTile.x, nextTile.y);

    // Walk squash animation (same style as idle wander)
    this.scene.tweens.add({
      targets: entry.sprite,
      scaleX: 0.95,
      scaleY: 1.05,
      duration: 100,
      yoyo: true,
      ease: 'Sine.easeInOut',
    });

    // Step bounce
    this.scene.tweens.add({
      targets: entry.sprite,
      y: entry.sprite.y - 3,
      duration: 100,
      yoyo: true,
      ease: 'Quad.easeOut',
    });

    // Move to next tile
    this.scene.tweens.add({
      targets: entry.sprite,
      x: target.x,
      y: target.y,
      duration: 200,
      ease: 'Sine.easeInOut',
      onUpdate: () => {
        entry.label.x = entry.sprite.x;
        entry.label.y = entry.sprite.y - GAME_CONFIG.SPRITE_H + 8;
      },
      onComplete: () => {
        entry.sprite.setDepth(entry.tileX + entry.tileY + 0.5);
        entry.label.setDepth(entry.tileX + entry.tileY + 0.6);
        // Continue to next step
        this._stepWalk(charId);
      },
    });
  }

  // Handle interruption: pause, then reroute to new destination
  _interruptWalk(charId) {
    const entry = this.sprites[charId];
    if (!entry) return;

    // Free the destination tile that was reserved but never reached
    if (entry.walkPath && entry.walkPath.length > 0) {
      const oldDest = entry.walkPath[entry.walkPath.length - 1];
      this.occupiedTiles.delete(oldDest.x + ',' + oldDest.y);
    }

    const newBuilding = entry.pendingBuilding;
    entry.pendingBuilding = null;
    entry.walkPath = null;

    // Brief pause (500ms) — character "changes their mind"
    this.scene.time.delayedCall(500, () => {
      // Calculate new path from current tile to new building
      const destTile = this._pickTileInBuilding(newBuilding);
      const collision = this.scene.collisionMap;
      const path = findPath(collision, entry.tileX, entry.tileY, destTile.x, destTile.y);

      if (path.length > 1) {
        this._startBuildingWalk(charId, path);
      } else {
        // Fallback: direct tween if no path found
        this._fallbackTween(charId, destTile);
      }
    });
  }

  // Walk complete — resume idle behaviors in new building
  _finishBuildingWalk(charId) {
    const entry = this.sprites[charId];
    if (!entry) return;

    entry.walkPath = null;
    entry.walkIndex = 0;

    // Resume idle breathing and wander
    this._startBreathing(charId);
    this._scheduleWander(charId);
  }

  // Fallback direct tween when pathfinding fails
  _fallbackTween(charId, tile) {
    const entry = this.sprites[charId];
    if (!entry) return;

    this.occupiedTiles.delete(entry.tileX + ',' + entry.tileY);
    this.occupiedTiles.add(tile.x + ',' + tile.y);
    entry.tileX = tile.x;
    entry.tileY = tile.y;

    const target = tileToScreen(tile.x, tile.y);

    this.scene.tweens.add({
      targets: entry.sprite,
      x: target.x,
      y: target.y,
      duration: 800,
      ease: 'Sine.easeInOut',
      onUpdate: () => {
        entry.label.x = entry.sprite.x;
        entry.label.y = entry.sprite.y - GAME_CONFIG.SPRITE_H + 8;
      },
      onComplete: () => {
        entry.sprite.setDepth(entry.tileX + entry.tileY + 0.5);
        entry.label.setDepth(entry.tileX + entry.tileY + 0.6);
        this._startBreathing(charId);
        this._scheduleWander(charId);
      },
    });
  }
```

- [ ] **Step 3: Replace the `updateLocations` method to use walking**

Replace the entire `updateLocations` method (lines 287-343) with:

```javascript
  // Update locations from API data
  updateLocations(allLocations) {
    // Collect who moved
    const movers = [];
    for (const loc of allLocations) {
      const prev = this.locations[loc.id];
      this.locations[loc.id] = loc.building;
      if (prev !== loc.building && this.sprites[loc.id]) {
        movers.push(loc.id);
      }
    }

    if (movers.length === 0) return;

    for (const charId of movers) {
      const entry = this.sprites[charId];
      if (!entry) continue;

      const building = this.locations[charId];

      // If already walking, queue the new destination as interruption
      if (entry.walkPath) {
        entry.pendingBuilding = building;
        continue;
      }

      // Free old tile
      this.occupiedTiles.delete(entry.tileX + ',' + entry.tileY);

      // Stop wander timer during building transition
      if (entry.wanderTimer) {
        entry.wanderTimer.remove();
        entry.wanderTimer = null;
      }
      entry.isWandering = false;

      // Find path from current tile to a tile in the new building
      const destTile = this._pickTileInBuilding(building);
      const collision = this.scene.collisionMap;
      const path = findPath(collision, entry.tileX, entry.tileY, destTile.x, destTile.y);

      if (path.length > 1) {
        this._startBuildingWalk(charId, path);
      } else {
        // Fallback: direct tween if no walkable path
        this._fallbackTween(charId, destTile);
      }
    }
  }
```

- [ ] **Step 4: Update the `destroy` method to clean up walk state**

In the `destroy` method (line 411-421), the existing cleanup loop already destroys `idleTween` and `wanderTimer`. Add walk path cleanup by replacing:

```javascript
  destroy() {
    this.stopPolling();
    for (const entry of Object.values(this.sprites)) {
      if (entry.idleTween) entry.idleTween.destroy();
      if (entry.wanderTimer) entry.wanderTimer.remove();
      entry.sprite.destroy();
      entry.label.destroy();
    }
    this.sprites = {};
    this.occupiedTiles.clear();
  }
```

With:

```javascript
  destroy() {
    this.stopPolling();
    for (const entry of Object.values(this.sprites)) {
      if (entry.idleTween) entry.idleTween.destroy();
      if (entry.wanderTimer) entry.wanderTimer.remove();
      entry.walkPath = null;
      entry.sprite.destroy();
      entry.label.destroy();
    }
    this.sprites = {};
    this.occupiedTiles.clear();
  }
```

- [ ] **Step 5: Verify visually**

1. Open the game in browser
2. Wait for any character to move between buildings (or trigger a move by talking to one and suggesting they visit somewhere)
3. Observe: character should walk tile-by-tile along the path, not teleport

- [ ] **Step 6: Commit**

```bash
git add src/web/public/game/js/systems/CharacterManager.js
git commit -m "feat(game): tile-by-tile walking animation for inter-building movement"
```

---

### Task 4: Deploy to Production

**Files:**
- No file changes — deployment only

- [ ] **Step 1: Run tests locally**

```bash
npx vitest run test/pathfinding.test.ts test/regression.test.ts
```

Expected: ALL PASS

- [ ] **Step 2: Build the project**

```bash
npm run build
```

Expected: No TypeScript errors

- [ ] **Step 3: Deploy to droplet**

```bash
ssh root@198.211.116.5 "cd /opt/local-lain && git pull && npm run build && systemctl restart lain.target"
```

- [ ] **Step 4: Verify on production**

```bash
ssh root@198.211.116.5 "/opt/local-lain/deploy/status.sh"
```

Expected: All services healthy

- [ ] **Step 5: Commit deployment verification**

No code changes — deployment is confirmed working.
