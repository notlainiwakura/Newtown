/**
 * LAINTOWN GAME — Character Manager
 * NPC sprites, position polling, movement tweens.
 * Characters in the same building get spread across different walkable tiles.
 * Idle behaviors: breathing, wandering within buildings, approaching co-located peers.
 */

class CharacterManager {
  constructor(scene) {
    this.scene = scene;
    this.sprites = {}; // charId -> { sprite, label, tileX, tileY, idleTween, wanderTimer }
    this.locations = {}; // charId -> buildingId
    this.pollTimer = null;
    this.occupiedTiles = new Set(); // "x,y" strings
  }

  // Pick a random walkable, unoccupied tile inside a building zone
  _pickTileInBuilding(buildingId) {
    const zone = getBuildingZone(buildingId);
    if (!zone) return getBuildingSpawn(buildingId);

    const collisionMap = this.scene.collisionMap;
    const candidates = [];

    // Interior tiles (skip walls: 1 tile inset from each edge)
    for (let dy = 2; dy < zone.h - 1; dy++) {
      for (let dx = 1; dx < zone.w - 1; dx++) {
        const tx = zone.x + dx;
        const ty = zone.y + dy;
        if (
          collisionMap[ty] && !collisionMap[ty][tx] &&
          !this.occupiedTiles.has(tx + ',' + ty)
        ) {
          candidates.push({ x: tx, y: ty });
        }
      }
    }

    if (candidates.length === 0) {
      // Fallback to center
      return getBuildingSpawn(buildingId);
    }

    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    this.occupiedTiles.add(pick.x + ',' + pick.y);
    return pick;
  }

  // Pick a walkable neighbor tile (for idle wander)
  _pickAdjacentTile(fromX, fromY, buildingId) {
    const zone = getBuildingZone(buildingId);
    if (!zone) return null;

    const collisionMap = this.scene.collisionMap;
    const dirs = [
      { dx: 1, dy: 0 }, { dx: -1, dy: 0 },
      { dx: 0, dy: 1 }, { dx: 0, dy: -1 },
      { dx: 1, dy: 1 }, { dx: -1, dy: -1 },
      { dx: 1, dy: -1 }, { dx: -1, dy: 1 },
    ];

    // Shuffle directions
    for (let i = dirs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [dirs[i], dirs[j]] = [dirs[j], dirs[i]];
    }

    for (const d of dirs) {
      const nx = fromX + d.dx;
      const ny = fromY + d.dy;
      // Must be inside building zone (not walls)
      if (nx < zone.x + 1 || nx >= zone.x + zone.w - 1) continue;
      if (ny < zone.y + 2 || ny >= zone.y + zone.h - 1) continue;
      if (collisionMap[ny] && collisionMap[ny][nx]) continue;
      if (this.occupiedTiles.has(nx + ',' + ny)) continue;
      return { x: nx, y: ny };
    }
    return null;
  }

  // Find a tile near a target character (for approaching)
  _pickTileNear(targetX, targetY, buildingId) {
    const zone = getBuildingZone(buildingId);
    if (!zone) return null;

    const collisionMap = this.scene.collisionMap;
    const candidates = [];

    // Check tiles within 1-2 distance of target
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = targetX + dx;
        const ny = targetY + dy;
        if (nx < zone.x + 1 || nx >= zone.x + zone.w - 1) continue;
        if (ny < zone.y + 2 || ny >= zone.y + zone.h - 1) continue;
        if (collisionMap[ny] && collisionMap[ny][nx]) continue;
        if (this.occupiedTiles.has(nx + ',' + ny)) continue;
        const dist = Math.abs(dx) + Math.abs(dy);
        candidates.push({ x: nx, y: ny, dist });
      }
    }

    if (candidates.length === 0) return null;
    // Prefer closer tiles
    candidates.sort((a, b) => a.dist - b.dist);
    // Pick from closest 3
    const pick = candidates[Math.floor(Math.random() * Math.min(3, candidates.length))];
    return { x: pick.x, y: pick.y };
  }

  // Create NPC sprites at their initial positions
  createNPCs(excludeId) {
    // Group characters by building first so we can spread them
    const byBuilding = {};
    for (const [charId, charData] of Object.entries(CHARACTERS)) {
      if (charId === excludeId) continue;
      const building = this.locations[charId] || DEFAULT_LOCATIONS[charId] || 'square';
      this.locations[charId] = building;
      if (!byBuilding[building]) byBuilding[building] = [];
      byBuilding[building].push(charId);
    }

    for (const [building, charIds] of Object.entries(byBuilding)) {
      for (const charId of charIds) {
        const tile = this._pickTileInBuilding(building);
        this._createSprite(charId, tile.x, tile.y);
      }
    }
  }

  _createSprite(charId, tileX, tileY) {
    const charData = CHARACTERS[charId];
    const pos = tileToScreen(tileX, tileY);

    const sprite = this.scene.add.sprite(pos.x, pos.y, 'char_' + charId);
    sprite.setDepth(tileX + tileY + 0.5);
    sprite.setOrigin(0.5, 0.75);
    sprite.charId = charId;

    const label = this.scene.add.text(pos.x, pos.y - GAME_CONFIG.SPRITE_H + 8, charData.name, {
      fontSize: '24px',
      fontFamily: 'monospace',
      color: charData.colorHex,
      align: 'center',
    });
    label.setOrigin(0.5, 1);
    label.setDepth(tileX + tileY + 0.6);

    const entry = {
      sprite, label, tileX, tileY,
      idleTween: null, wanderTimer: null, isWandering: false,
      // Inter-building walking state
      walkPath: null,       // Array of {x,y} tiles (null when idle)
      walkIndex: 0,         // Current index in walkPath
      pendingBuilding: null, // Queued destination if interrupted
    };
    this.sprites[charId] = entry;

    // Start idle behaviors
    this._startBreathing(charId);
    this._scheduleWander(charId);
  }

  // --- Idle animation: subtle breathing (scale pulse + gentle Y bob) ---
  _startBreathing(charId) {
    const entry = this.sprites[charId];
    if (!entry) return;

    // Breathing: gentle scale pulse
    const offset = Math.random() * 2000; // desynchronize characters
    entry.idleTween = this.scene.tweens.add({
      targets: entry.sprite,
      scaleX: { from: 1.0, to: 1.02 },
      scaleY: { from: 1.0, to: 0.98 },
      duration: 2500 + Math.random() * 500,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
      delay: offset,
    });
  }

  // --- Idle wander: periodically walk to a nearby tile within the building ---
  _scheduleWander(charId) {
    const entry = this.sprites[charId];
    if (!entry) return;

    // Random interval: 6-18 seconds
    const delay = 6000 + Math.random() * 12000;
    entry.wanderTimer = this.scene.time.delayedCall(delay, () => {
      this._doWander(charId);
    });
  }

  _doWander(charId) {
    const entry = this.sprites[charId];
    if (!entry || entry.isWandering || entry.walkPath) {
      this._scheduleWander(charId);
      return;
    }

    const building = this.locations[charId];

    // 30% chance to approach a co-located character instead of random wander
    let targetTile = null;
    if (Math.random() < 0.3) {
      targetTile = this._tryApproachPeer(charId, building);
    }

    // Otherwise pick an adjacent tile
    if (!targetTile) {
      targetTile = this._pickAdjacentTile(entry.tileX, entry.tileY, building);
    }

    if (!targetTile) {
      this._scheduleWander(charId);
      return;
    }

    // Free old tile, claim new one
    this.occupiedTiles.delete(entry.tileX + ',' + entry.tileY);
    this.occupiedTiles.add(targetTile.x + ',' + targetTile.y);

    entry.isWandering = true;
    const oldTileX = entry.tileX;
    const oldTileY = entry.tileY;
    entry.tileX = targetTile.x;
    entry.tileY = targetTile.y;

    const target = tileToScreen(targetTile.x, targetTile.y);

    // Walking squash: slightly compress horizontally, stretch vertically
    const walkSquash = this.scene.tweens.add({
      targets: entry.sprite,
      scaleX: 0.95,
      scaleY: 1.05,
      duration: 150,
      yoyo: true,
      repeat: 0,
      ease: 'Sine.easeInOut',
    });

    // Subtle step bounce (Y offset)
    const stepBounce = this.scene.tweens.add({
      targets: entry.sprite,
      y: entry.sprite.y - 4,
      duration: 200,
      yoyo: true,
      repeat: 0,
      ease: 'Quad.easeOut',
    });

    // Move to target
    this.scene.tweens.add({
      targets: entry.sprite,
      x: target.x,
      y: target.y,
      duration: 600 + Math.random() * 200,
      ease: 'Sine.easeInOut',
      onUpdate: () => {
        entry.label.x = entry.sprite.x;
        entry.label.y = entry.sprite.y - GAME_CONFIG.SPRITE_H + 8;
      },
      onComplete: () => {
        entry.sprite.setDepth(entry.tileX + entry.tileY + 0.5);
        entry.label.setDepth(entry.tileX + entry.tileY + 0.6);
        entry.isWandering = false;
        this._scheduleWander(charId);
      },
    });
  }

  // Try to walk toward a co-located character
  _tryApproachPeer(charId, building) {
    const peers = [];
    for (const [otherId, otherBuilding] of Object.entries(this.locations)) {
      if (otherId === charId) continue;
      if (otherBuilding !== building) continue;
      if (!this.sprites[otherId]) continue;
      peers.push(otherId);
    }

    if (peers.length === 0) return null;

    // Pick a random peer
    const peerId = peers[Math.floor(Math.random() * peers.length)];
    const peer = this.sprites[peerId];

    return this._pickTileNear(peer.tileX, peer.tileY, building);
  }

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

      // Stop breathing during transition
      if (entry.idleTween) {
        entry.idleTween.destroy();
        entry.idleTween = null;
      }

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

  // Get characters at a specific building
  getCharactersAt(buildingId) {
    const result = [];
    for (const [charId, building] of Object.entries(this.locations)) {
      if (building === buildingId && this.sprites[charId]) {
        result.push(charId);
      }
    }
    return result;
  }

  // Get the nearest NPC to a tile position (within interaction range)
  getNearestNPC(tileX, tileY, maxDistance) {
    maxDistance = maxDistance || 2;
    let nearest = null;
    let nearestDist = Infinity;

    for (const [charId, entry] of Object.entries(this.sprites)) {
      const dist = Math.abs(entry.tileX - tileX) + Math.abs(entry.tileY - tileY);

      if (dist <= maxDistance && dist < nearestDist) {
        nearest = charId;
        nearestDist = dist;
      }
    }

    return nearest;
  }

  // Start polling for location updates
  startPolling() {
    this._polling = false;
    this.pollTimer = this.scene.time.addEvent({
      delay: GAME_CONFIG.POLL_INTERVAL,
      callback: this._pollLocations,
      callbackScope: this,
      loop: true,
    });
  }

  async _pollLocations() {
    if (this._polling) return;
    this._polling = true;
    try {
      const data = await apiClient.look();
      if (data && data.allLocations) {
        this.updateLocations(data.allLocations);
      }
    } catch {
      // ignore polling errors
    } finally {
      this._polling = false;
    }
  }

  stopPolling() {
    if (this.pollTimer) {
      this.pollTimer.remove();
      this.pollTimer = null;
    }
  }

  getLocation(charId) {
    return this.locations[charId] || DEFAULT_LOCATIONS[charId] || null;
  }

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
}
