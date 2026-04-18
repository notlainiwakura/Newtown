/**
 * LAINTOWN GAME — World Scene (Yami Kawaii ✟)
 */

class WorldScene extends Phaser.Scene {
  constructor() { super('WorldScene'); }
  init(data) { this.authData = data; }

  create() {
    const T = GAME_CONFIG.TILE_SIZE;
    this.cameras.main.setBackgroundColor('#1a1520');
    this._buildTilemap();

    const startBuilding = this.authData.location || DEFAULT_LOCATIONS[PLAYER_ID] || 'market';
    const spawn = getBuildingSpawn(startBuilding);
    this.playerTileX = spawn.x;
    this.playerTileY = spawn.y;

    this.player = this.add.sprite(this.playerTileX * T + T / 2, this.playerTileY * T + T / 2, 'char_' + PLAYER_ID);
    this.player.setDepth(10);
    this.player.setOrigin(0.5, 0.75);

    const playerData = CHARACTERS[PLAYER_ID] || { name: PLAYER_ID, colorHex: '#88b898' };
    this.playerLabel = this.add.text(this.player.x, this.player.y - GAME_CONFIG.SPRITE_H + 8, playerData.name || PLAYER_ID, {
      fontSize: '20px', fontFamily: "'M PLUS Rounded 1c', sans-serif", color: playerData.colorHex || '#88b898', align: 'center', fontStyle: 'bold'
    });
    this.playerLabel.setOrigin(0.5, 1);
    this.playerLabel.setDepth(11);

    this.cameras.main.startFollow(this.player, true, GAME_CONFIG.CAMERA_LERP, GAME_CONFIG.CAMERA_LERP);
    this.cameras.main.setBounds(0, 0, GAME_CONFIG.MAP_COLS * T, GAME_CONFIG.MAP_ROWS * T);

    this.charManager = new CharacterManager(this);
    this.possessionManager = new PossessionManager(this);
    this.possessionManager.currentBuilding = startBuilding;

    this.isMoving = false;
    this.moveQueue = [];

    this.cursors = this.input.keyboard.createCursorKeys();
    this.spaceKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
    this.escKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.ESC);
    this.tabKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.TAB);

    this._createBuildingLabels();

    this.interactPrompt = this.add.text(0, 0, '✟ SPACE', {
      fontSize: '20px', fontFamily: "'M PLUS Rounded 1c', sans-serif", color: '#c87898',
      backgroundColor: 'rgba(26,21,32,0.85)', padding: { x: 10, y: 6 },
    });
    this.interactPrompt.setOrigin(0.5, 1);
    this.interactPrompt.setDepth(20);
    this.interactPrompt.visible = false;

    this.pendingNotif = this.add.text(GAME_CONFIG.WIDTH - 32, 32, '', {
      fontSize: '20px', fontFamily: "'M PLUS Rounded 1c', sans-serif", color: '#c87898',
      backgroundColor: 'rgba(26,21,32,0.9)', padding: { x: 14, y: 10 },
    });
    this.pendingNotif.setOrigin(1, 0);
    this.pendingNotif.setDepth(50);
    this.pendingNotif.setScrollFactor(0);
    this.pendingNotif.visible = false;

    this.locationText = this.add.text(32, 32, '', {
      fontSize: '20px', fontFamily: "'M PLUS Rounded 1c', sans-serif", color: '#a888a8',
      backgroundColor: 'rgba(26,21,32,0.85)', padding: { x: 14, y: 10 },
    });
    this.locationText.setDepth(50);
    this.locationText.setScrollFactor(0);
    this._updateLocationHUD(startBuilding);

    this._initWorld();
    this.nearbyNPC = null;
    this.dialogOpen = false;
  }

  async _initWorld() {
    try { await this.possessionManager.startPossession(); } catch (err) { console.error('Possession start error:', err); }
    try { const data = await apiClient.look(); if (data && data.allLocations) this.charManager.updateLocations(data.allLocations); } catch {}
    this.charManager.createNPCs(PLAYER_ID);
    this.charManager.startPolling();
    this.possessionManager.startPendingPoll();
    this.possessionManager.connectStream();
    this.possessionManager.onPeerMessage = () => { this._showPendingNotification(); };
  }

  _buildTilemap() {
    const T = GAME_CONFIG.TILE_SIZE;
    const ground = this.registry.get('mapGround');
    const collision = this.registry.get('mapCollision');
    const tileTextures = ['tile_grass', 'tile_path', 'tile_floor', 'tile_wall', 'tile_forest', 'tile_water'];
    this.collisionMap = collision;
    this.groundTiles = this.add.group();
    for (let y = 0; y < ground.length; y++) {
      for (let x = 0; x < ground[0].length; x++) {
        const tile = this.add.image(x * T + T / 2, y * T + T / 2, tileTextures[ground[y][x]] || 'tile_grass');
        tile.setDepth(0);
        this.groundTiles.add(tile);
      }
    }
  }

  _createBuildingLabels() {
    for (const b of BUILDINGS) {
      const zone = getBuildingZone(b.id);
      if (!zone) continue;
      const T = GAME_CONFIG.TILE_SIZE;
      const label = this.add.text((zone.x + zone.w / 2) * T, zone.y * T - 8, b.name, {
        fontSize: '20px', fontFamily: "'M PLUS Rounded 1c', sans-serif", color: '#c87898', align: 'center', fontStyle: 'bold',
      });
      label.setOrigin(0.5, 1);
      label.setDepth(15);
      label.setAlpha(0.7);
    }
  }

  update() {
    if (this.dialogOpen) return;
    if (!this.isMoving) {
      let dx = 0, dy = 0;
      if (this.cursors.left.isDown) dx = -1;
      else if (this.cursors.right.isDown) dx = 1;
      else if (this.cursors.up.isDown) dy = -1;
      else if (this.cursors.down.isDown) dy = 1;
      if (dx !== 0 || dy !== 0) this._tryMove(dx, dy);
    }
    this._checkNearbyNPC();
    if (Phaser.Input.Keyboard.JustDown(this.spaceKey) && this.nearbyNPC) this._openDialog(this.nearbyNPC);
    if (Phaser.Input.Keyboard.JustDown(this.tabKey) && this.possessionManager.hasPending()) {
      const pending = this.possessionManager.getNextPending();
      if (pending) this._openPendingDialog(pending);
    }
  }

  _tryMove(dx, dy) {
    const newX = this.playerTileX + dx, newY = this.playerTileY + dy;
    if (newX < 0 || newX >= GAME_CONFIG.MAP_COLS || newY < 0 || newY >= GAME_CONFIG.MAP_ROWS) return;
    if (this.collisionMap[newY] && this.collisionMap[newY][newX]) return;
    this.isMoving = true;
    this.playerTileX = newX;
    this.playerTileY = newY;
    const T = GAME_CONFIG.TILE_SIZE;
    this.tweens.add({
      targets: this.player, x: newX * T + T / 2, y: newY * T + T / 2,
      duration: GAME_CONFIG.MOVE_DURATION, ease: 'Sine.easeInOut',
      onUpdate: () => { this.playerLabel.x = this.player.x; this.playerLabel.y = this.player.y - GAME_CONFIG.SPRITE_H + 8; },
      onComplete: () => { this.isMoving = false; const r = this.possessionManager.checkZone(this.playerTileX, this.playerTileY); if (r.changed) this._updateLocationHUD(r.to); },
    });
  }

  _checkNearbyNPC() {
    const npc = this.charManager.getNearestNPC(this.playerTileX, this.playerTileY, 2);
    if (npc !== this.nearbyNPC) {
      this.nearbyNPC = npc;
      if (npc) { const e = this.charManager.sprites[npc]; if (e) { this.interactPrompt.x = e.sprite.x; this.interactPrompt.y = e.sprite.y - GAME_CONFIG.SPRITE_H - 16; this.interactPrompt.visible = true; } }
      else this.interactPrompt.visible = false;
    }
    if (this.nearbyNPC) { const e = this.charManager.sprites[this.nearbyNPC]; if (e) { this.interactPrompt.x = e.sprite.x; this.interactPrompt.y = e.sprite.y - GAME_CONFIG.SPRITE_H - 16; } }
  }

  _openDialog(charId) {
    this.dialogOpen = true; this.interactPrompt.visible = false;
    this.scene.launch('DialogScene', { charId, charData: CHARACTERS[charId], mode: 'chat' });
    this.scene.pause();
  }

  _openPendingDialog(pending) {
    this.dialogOpen = true; this.pendingNotif.visible = false;
    this.scene.launch('DialogScene', { charId: pending.fromId, charData: CHARACTERS[pending.fromId] || { name: pending.fromName, colorHex: '#685868' }, mode: 'pending', pendingMessage: pending });
    this.scene.pause();
  }

  resumeFromDialog() { this.dialogOpen = false; this.scene.resume(); this._showPendingNotification(); }

  _updateLocationHUD(buildingId) { const b = BUILDING_MAP[buildingId]; if (b) this.locationText.setText('✟ ' + b.name); }

  _showPendingNotification() {
    if (this.possessionManager.hasPending()) { const c = this.possessionManager.pendingMessages.length; this.pendingNotif.setText('✟ TAB — ' + c + ' message' + (c > 1 ? 's' : '')); this.pendingNotif.visible = true; }
    else this.pendingNotif.visible = false;
  }

  shutdown() { this.charManager.destroy(); this.possessionManager.destroy(); }
}
