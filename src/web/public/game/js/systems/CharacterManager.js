/**
 * LAINTOWN GAME — Character Manager
 * NPC sprites, position polling, movement tweens.
 * Characters in the same building get spread across different walkable tiles.
 */

class CharacterManager {
  constructor(scene) {
    this.scene = scene;
    this.sprites = {}; // charId -> { sprite, label, tileX, tileY }
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
    const T = GAME_CONFIG.TILE_SIZE;
    const px = tileX * T + T / 2;
    const py = tileY * T + T / 2;

    const sprite = this.scene.add.sprite(px, py, 'char_' + charId);
    sprite.setDepth(5);
    sprite.setOrigin(0.5, 0.75);
    sprite.charId = charId;

    const label = this.scene.add.text(px, py - GAME_CONFIG.SPRITE_H + 8, charData.name, {
      fontSize: '24px',
      fontFamily: 'monospace',
      color: charData.colorHex,
      align: 'center',
    });
    label.setOrigin(0.5, 1);
    label.setDepth(6);

    this.sprites[charId] = { sprite, label, tileX, tileY };
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

    // Free old tiles for movers
    for (const charId of movers) {
      const entry = this.sprites[charId];
      if (entry) {
        this.occupiedTiles.delete(entry.tileX + ',' + entry.tileY);
      }
    }

    // Assign new tiles and tween
    for (const charId of movers) {
      const building = this.locations[charId];
      const tile = this._pickTileInBuilding(building);
      const entry = this.sprites[charId];

      entry.tileX = tile.x;
      entry.tileY = tile.y;

      const T = GAME_CONFIG.TILE_SIZE;
      const targetX = tile.x * T + T / 2;
      const targetY = tile.y * T + T / 2;

      this.scene.tweens.add({
        targets: entry.sprite,
        x: targetX,
        y: targetY,
        duration: 800,
        ease: 'Sine.easeInOut',
        onUpdate: () => {
          entry.label.x = entry.sprite.x;
          entry.label.y = entry.sprite.y - GAME_CONFIG.SPRITE_H + 8;
        },
      });
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
      entry.sprite.destroy();
      entry.label.destroy();
    }
    this.sprites = {};
    this.occupiedTiles.clear();
  }
}
