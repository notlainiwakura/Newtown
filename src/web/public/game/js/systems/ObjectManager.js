/**
 * NEWTOWN GAME — Object Manager
 * Renders persistent world objects on the isometric map.
 * Polls the /api/objects endpoint for ground objects.
 */

class ObjectManager {
  constructor(scene) {
    this.scene = scene;
    this.sprites = {}; // objectId -> { sprite, label, tileX, tileY }
    this.objects = [];  // raw API data
    this.pollTimer = null;
    this.occupiedTiles = new Set(); // avoid stacking
  }

  // Pick a tile inside a building zone for an object
  _pickTileInBuilding(buildingId) {
    const zone = getBuildingZone(buildingId);
    if (!zone) return { x: 32, y: 24 };

    const collisionMap = this.scene.collisionMap;
    const candidates = [];

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
      const spawn = getBuildingSpawn(buildingId);
      return spawn;
    }

    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    this.occupiedTiles.add(pick.x + ',' + pick.y);
    return pick;
  }

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

  // Show a floating info popup when an object is clicked
  _showObjectPopup(obj, pos) {
    // Remove existing popup if any
    if (this._popup) {
      this._popup.destroy();
      this._popup = null;
    }

    const text = obj.name + (obj.description ? '\n' + obj.description : '');
    const info = this.scene.add.text(pos.x, pos.y - 30, text, {
      fontSize: '18px',
      fontFamily: 'monospace',
      color: '#d0d0e0',
      backgroundColor: 'rgba(10,12,20,0.9)',
      padding: { x: 12, y: 8 },
      align: 'center',
      wordWrap: { width: 300 },
    });
    info.setOrigin(0.5, 1);
    info.setDepth(9999);
    this._popup = info;

    // Fade out after 4 seconds
    this.scene.tweens.add({
      targets: info,
      alpha: 0,
      delay: 4000,
      duration: 500,
      onComplete: () => {
        info.destroy();
        if (this._popup === info) this._popup = null;
      },
    });
  }

  // Generate a color from object name
  _hashColor(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) {
      h = name.charCodeAt(i) + ((h << 5) - h);
    }
    const hue = Math.abs(h) % 360;
    return `hsl(${hue}, 50%, 55%)`;
  }

  // Remove sprites for objects no longer on the ground
  _removeStaleSprites(currentIds) {
    const idSet = new Set(currentIds);
    for (const [id, entry] of Object.entries(this.sprites)) {
      if (!idSet.has(id)) {
        this.occupiedTiles.delete(entry.tileX + ',' + entry.tileY);
        entry.sprite.destroy();
        entry.label.destroy();
        delete this.sprites[id];
      }
    }
  }

  // Refresh objects from API
  async refresh() {
    try {
      const objects = await apiClient.getObjects(); // all ground objects
      // Filter to ground objects only (no owner)
      this.objects = objects.filter(o => !o.ownerId);
      const currentIds = this.objects.map(o => o.id);
      this._removeStaleSprites(currentIds);
      for (const obj of this.objects) {
        this._createObjectSprite(obj);
      }
    } catch { /* ignore */ }
  }

  // Start polling
  startPolling(intervalMs) {
    this.refresh();
    this.pollTimer = this.scene.time.addEvent({
      delay: intervalMs || 20000,
      callback: () => this.refresh(),
      loop: true,
    });
  }

  // Get nearest ground object to a tile
  getNearestObject(tileX, tileY, maxDist) {
    maxDist = maxDist || 2;
    let nearest = null;
    let nearestDist = Infinity;

    for (const [id, entry] of Object.entries(this.sprites)) {
      const dist = Math.abs(entry.tileX - tileX) + Math.abs(entry.tileY - tileY);
      if (dist <= maxDist && dist < nearestDist) {
        nearest = id;
        nearestDist = dist;
      }
    }
    return nearest;
  }

  // Get object data by ID
  getObjectData(id) {
    return this.objects.find(o => o.id === id) || null;
  }

  destroy() {
    if (this.pollTimer) {
      this.pollTimer.remove();
      this.pollTimer = null;
    }
    for (const entry of Object.values(this.sprites)) {
      entry.sprite.destroy();
      entry.label.destroy();
    }
    this.sprites = {};
    this.occupiedTiles.clear();
  }
}
