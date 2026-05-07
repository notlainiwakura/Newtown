# Walking Animation Design

## Overview

When characters move between buildings in the game view, they currently teleport (800ms straight-line tween). This feature replaces that with tile-by-tile walking along the map's walkable paths using A* pathfinding.

## Goals

- Characters visually walk along paths between buildings instead of teleporting
- Walking is slower than player movement, giving a contemplative pace
- If a character changes destination mid-walk, they pause briefly then reroute
- Purely visual — server-side location is already set; the walk is client-side animation

## Design Decisions

- **Walking speed**: ~200ms per tile (slower than player's 150ms)
- **Pathfinding**: A* on the existing collision map, 4-directional (no diagonal — looks better on isometric paths)
- **Interruption**: stop at current tile, 500ms pause, recalculate path to new destination
- **Fallback**: if no path is found (shouldn't happen but defensive), fall back to current direct tween

## Architecture

### New file: `src/web/public/game/js/pathfinding.js`

Pure A* pathfinding utility. Single exported function:

```
findPath(collisionMap, startX, startY, endX, endY) → [{x, y}, ...]
```

- Uses Manhattan distance heuristic
- 4-directional movement (up/down/left/right)
- Returns ordered array of tiles from start to end (inclusive)
- Returns empty array if no path exists
- Operates on the same collision map used by player movement and CharacterManager

### Modified: `src/web/public/game/js/systems/CharacterManager.js`

New per-sprite state fields:
- `walkPath` — array of tiles for current inter-building walk (null when idle)
- `walkIndex` — current position in walkPath
- `isWalkingBetweenBuildings` — flag to distinguish building walks from idle wander

Modified methods:
- `updateLocations(allLocations)` — when a building change is detected, instead of direct tween: call `findPath()` from current tile to a tile in the destination building, then call `_startBuildingWalk()`

New methods:
- `_startBuildingWalk(charId, path)` — stops idle wander/breathing, begins stepping through path tiles one at a time. Each step: tween sprite to next tile position over ~200ms with walk squash/bounce animation (reusing the existing wander animation style). Updates depth sorting each step.
- `_stepWalk(charId)` — advances one tile in the walk path. If path complete, calls `_finishBuildingWalk()`. If interrupted (new destination queued), calls `_interruptWalk()`.
- `_interruptWalk(charId)` — stops at current tile, 500ms delayed call, then recalculates path from current tile to new destination and resumes walking.
- `_finishBuildingWalk(charId)` — clears walk state, resumes idle breathing and wander scheduling in the new building.

### Modified: `src/web/public/game/index.html`

Add `<script src="/game/js/pathfinding.js"></script>` before the systems scripts (pathfinding is a utility used by CharacterManager).

## Walk Animation Details

Each tile step uses:
- **Movement tween**: 200ms, Sine.easeInOut, sprite moves to next tile's screen position
- **Walk squash**: brief scaleX 0.95 / scaleY 1.05 pulse (same as existing wander)
- **Step bounce**: small Y offset (-3px) during step
- **Label follows**: name label tracks sprite position during movement
- **Depth update**: recalculated each step for correct rendering order

Characters exit through the building doorway area, walk along path tiles, and enter the destination building — all following the collision map's walkable tiles.

## Interruption Flow

1. Character is walking from Library to Lighthouse (mid-path)
2. New poll reports character is now going to Bar
3. Current step tween completes (doesn't abort mid-tile)
4. Character stops at current tile for 500ms
5. New path calculated from current tile to Bar
6. Walking resumes along new path

## Edge Cases

- **No path found**: fall back to existing direct tween behavior (800ms)
- **Character already at destination**: no-op (same as current)
- **Multiple rapid location changes**: each new change interrupts the current walk; only the latest destination matters
- **Character off-screen**: walk still happens (camera doesn't follow NPCs, but if the player walks to the path they'll see the NPC mid-journey)
