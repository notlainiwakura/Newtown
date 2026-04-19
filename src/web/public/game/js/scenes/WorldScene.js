/**
 * NEWTOWN GAME — World Scene
 * Isometric ¾ view: diamond tiles, depth-sorted rendering.
 */

class WorldScene extends Phaser.Scene {
  constructor() {
    super('WorldScene');
  }

  init(data) {
    this.authData = data;
  }

  create() {
    // Build tilemap from generated data
    this._buildTilemap();

    // Player
    const startBuilding = this.authData.location || DEFAULT_LOCATIONS[PLAYER_ID] || 'square';
    const spawn = getBuildingSpawn(startBuilding);
    this.playerTileX = spawn.x;
    this.playerTileY = spawn.y;

    const spawnPos = tileToScreen(this.playerTileX, this.playerTileY);
    this.player = this.add.sprite(spawnPos.x, spawnPos.y, 'char_' + PLAYER_ID);
    this.player.setDepth(this.playerTileX + this.playerTileY + 0.5);
    this.player.setOrigin(0.5, 0.75);

    // Player name label
    this.playerLabel = this.add.text(
      this.player.x,
      this.player.y - GAME_CONFIG.SPRITE_H + 8,
      (CHARACTERS[PLAYER_ID]?.name || PLAYER_ID),
      { fontSize: '24px', fontFamily: 'monospace', color: GAME_THEME.accentTertiary, align: 'center' }
    );
    this.playerLabel.setOrigin(0.5, 1);
    this.playerLabel.setDepth(this.playerTileX + this.playerTileY + 0.6);

    // Camera (isometric map bounds)
    const isoHalfW = GAME_CONFIG.ISO_TILE_W / 2;
    const isoHalfH = GAME_CONFIG.ISO_TILE_H / 2;
    const mapW = (GAME_CONFIG.MAP_COLS + GAME_CONFIG.MAP_ROWS) * isoHalfW;
    const mapH = (GAME_CONFIG.MAP_COLS + GAME_CONFIG.MAP_ROWS) * isoHalfH + GAME_CONFIG.ISO_WALL_H;
    this.cameras.main.startFollow(this.player, true, GAME_CONFIG.CAMERA_LERP, GAME_CONFIG.CAMERA_LERP);
    this.cameras.main.setBounds(0, 0, mapW, mapH);

    // Systems
    this.charManager = new CharacterManager(this);
    this.possessionManager = new PossessionManager(this);
    this.possessionManager.currentBuilding = startBuilding;
    this.objectManager = new ObjectManager(this);

    // Movement state
    this.isMoving = false;
    this.moveQueue = [];

    // Cursors — isometric remapping: up=NW, down=SE, left=SW, right=NE
    this.cursors = this.input.keyboard.createCursorKeys();
    this.spaceKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
    this.escKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.ESC);
    this.tabKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.TAB);
    this.examineKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.E);

    // Building name labels
    this._createBuildingLabels();

    // Interaction prompt (hidden by default)
    this.interactPrompt = this.add.text(0, 0, '[SPACE]', {
      fontSize: '24px',
      fontFamily: 'monospace',
      color: GAME_THEME.hudPrompt,
      backgroundColor: GAME_THEME.hudOverlayBg,
      padding: { x: 8, y: 4 },
    });
    this.interactPrompt.setOrigin(0.5, 1);
    this.interactPrompt.setDepth(9998);
    this.interactPrompt.visible = false;

    // Pending message notification
    this.pendingNotif = this.add.text(GAME_CONFIG.WIDTH - 32, 32, '', {
      fontSize: '24px',
      fontFamily: 'monospace',
      color: GAME_THEME.hudNotif,
      backgroundColor: GAME_THEME.hudOverlayBg,
      padding: { x: 12, y: 8 },
    });
    this.pendingNotif.setOrigin(1, 0);
    this.pendingNotif.setDepth(50);
    this.pendingNotif.setScrollFactor(0);
    this.pendingNotif.visible = false;

    // Location indicator (top-left HUD)
    this.locationText = this.add.text(32, 32, '', {
      fontSize: '24px',
      fontFamily: 'monospace',
      color: GAME_THEME.hudLocation,
      backgroundColor: GAME_THEME.hudOverlayBg,
      padding: { x: 12, y: 8 },
    });
    this.locationText.setDepth(50);
    this.locationText.setScrollFactor(0);
    this._updateLocationHUD(startBuilding);

    // Start possession + load world
    this._initWorld();

    // Nearby NPC tracking
    this.nearbyNPC = null;

    // Dialog scene reference
    this.dialogOpen = false;
    window._mobileState = 'world';

    // Speech bubbles: charId -> { container, text, timer }
    this.speechBubbles = {};
  }

  async _initWorld() {
    // Start possession if not already possessed
    try {
      await this.possessionManager.startPossession();
    } catch (err) {
      console.error('Possession start error:', err);
    }

    // Load initial character positions
    try {
      const data = await apiClient.look();
      if (data && data.allLocations) {
        this.charManager.updateLocations(data.allLocations);
      }
    } catch { /* ignore */ }

    // Create NPC sprites
    this.charManager.createNPCs(PLAYER_ID);

    // Start polling
    this.charManager.startPolling();
    this.possessionManager.startPendingPoll();
    this.possessionManager.connectStream();
    this.objectManager.startPolling(20000);

    // Listen for peer messages
    this.possessionManager.onPeerMessage = (event) => {
      this._showPendingNotification();
    };

    // Connect to live conversation stream
    apiClient.connectConversationStream((event) => {
      this._onConversationEvent(event);
    });
  }

  _buildTilemap() {
    const ground = this.registry.get('mapGround');
    const collision = this.registry.get('mapCollision');
    const rows = ground.length;
    const cols = ground[0].length;

    const tileTextures = ['tile_grass', 'tile_path', 'tile_floor', 'tile_wall', 'tile_forest', 'tile_water'];
    const tallTypes = { 3: true, 4: true }; // wall and forest are 3D blocks

    this.collisionMap = collision;
    this.groundTiles = this.add.group();

    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const tileType = ground[y][x];
        const tex = tileTextures[tileType] || 'tile_grass';
        const pos = tileToScreen(x, y);
        const tile = this.add.image(pos.x, pos.y, tex);

        if (tallTypes[tileType]) {
          tile.setOrigin(0.5, 32 / GAME_CONFIG.ISO_WALL_H);
        } else {
          tile.setOrigin(0.5, 0.5);
        }

        tile.setDepth(x + y);
        this.groundTiles.add(tile);
      }
    }
  }

  _createBuildingLabels() {
    for (const b of BUILDINGS) {
      const zone = getBuildingZone(b.id);
      if (!zone) continue;

      const centerPos = tileToScreen(zone.x + zone.w / 2, zone.y + zone.h / 2);

      const label = this.add.text(centerPos.x, centerPos.y - GAME_CONFIG.ISO_WALL_H, b.name, {
        fontSize: '24px',
        fontFamily: 'monospace',
        color: GAME_THEME.buildingLabel,
        align: 'center',
      });
      label.setOrigin(0.5, 1);
      label.setDepth(9999);
    }
  }

  update() {
    if (this.dialogOpen) return;

    // Movement — isometric remapping
    if (!this.isMoving) {
      let dx = 0, dy = 0;

      if (this.cursors.left.isDown) dx = -1;      // NW
      else if (this.cursors.right.isDown) dx = 1;  // SE
      else if (this.cursors.up.isDown) dy = -1;    // NE
      else if (this.cursors.down.isDown) dy = 1;   // SW

      if (dx !== 0 || dy !== 0) {
        this._tryMove(dx, dy);
      }
    }

    // Update speech bubble positions to follow wandering characters
    this._updateSpeechBubbles();

    // Interaction check
    this._checkNearbyNPC();

    // Space to interact — NPCs first, then objects
    if (Phaser.Input.Keyboard.JustDown(this.spaceKey)) {
      if (this.nearbyNPC) {
        this._openDialog(this.nearbyNPC);
      } else {
        const objId = this.objectManager.getNearestObject(this.playerTileX, this.playerTileY, 2);
        if (objId) {
          const objData = this.objectManager.getObjectData(objId);
          if (objData) {
            this._showObjectInfo(objData);
          }
        }
      }
    }

    // Tab to handle pending messages
    if (Phaser.Input.Keyboard.JustDown(this.tabKey)) {
      if (this.possessionManager.hasPending()) {
        const pending = this.possessionManager.getNextPending();
        if (pending) {
          this._openPendingDialog(pending);
        }
      }
    }
  }

  _tryMove(dx, dy) {
    const newX = this.playerTileX + dx;
    const newY = this.playerTileY + dy;

    if (newX < 0 || newX >= GAME_CONFIG.MAP_COLS || newY < 0 || newY >= GAME_CONFIG.MAP_ROWS) return;
    if (this.collisionMap[newY] && this.collisionMap[newY][newX]) return;

    this.isMoving = true;
    this.playerTileX = newX;
    this.playerTileY = newY;

    const target = tileToScreen(newX, newY);

    this.tweens.add({
      targets: this.player,
      x: target.x,
      y: target.y,
      duration: GAME_CONFIG.MOVE_DURATION,
      ease: 'Linear',
      onUpdate: () => {
        this.playerLabel.x = this.player.x;
        this.playerLabel.y = this.player.y - GAME_CONFIG.SPRITE_H + 8;
      },
      onComplete: () => {
        this.isMoving = false;
        this.player.setDepth(this.playerTileX + this.playerTileY + 0.5);
        this.playerLabel.setDepth(this.playerTileX + this.playerTileY + 0.6);
        const result = this.possessionManager.checkZone(this.playerTileX, this.playerTileY);
        if (result.changed) {
          this._updateLocationHUD(result.to);
        }
      },
    });
  }

  _checkNearbyNPC() {
    const npc = this.charManager.getNearestNPC(this.playerTileX, this.playerTileY, 2);

    if (npc !== this.nearbyNPC) {
      this.nearbyNPC = npc;

      if (npc) {
        const entry = this.charManager.sprites[npc];
        if (entry) {
          this.interactPrompt.setText('[SPACE]');
          this.interactPrompt.x = entry.sprite.x;
          this.interactPrompt.y = entry.sprite.y - GAME_CONFIG.SPRITE_H - 16;
          this.interactPrompt.visible = true;
        }
      } else {
        // Check for nearby objects when no NPC
        const objId = this.objectManager.getNearestObject(this.playerTileX, this.playerTileY, 2);
        if (objId) {
          const entry = this.objectManager.sprites[objId];
          if (entry) {
            this.interactPrompt.setText('[SPACE]');
            this.interactPrompt.x = entry.sprite.x;
            this.interactPrompt.y = entry.sprite.y - 24;
            this.interactPrompt.visible = true;
          }
        } else {
          this.interactPrompt.visible = false;
        }
      }
    }

    // Update prompt position if NPC is moving
    if (this.nearbyNPC) {
      const entry = this.charManager.sprites[this.nearbyNPC];
      if (entry) {
        this.interactPrompt.x = entry.sprite.x;
        this.interactPrompt.y = entry.sprite.y - GAME_CONFIG.SPRITE_H - 16;
      }
    }
  }

  _openDialog(charId) {
    this.dialogOpen = true;
    window._mobileState = 'dialog';
    this.interactPrompt.visible = false;
    this.scene.launch('DialogScene', {
      charId: charId,
      charData: CHARACTERS[charId],
      mode: 'chat',
    });
    this.scene.pause();
  }

  _openPendingDialog(pending) {
    this.dialogOpen = true;
    window._mobileState = 'dialog';
    this.pendingNotif.visible = false;
    this.scene.launch('DialogScene', {
      charId: pending.fromId,
      charData: CHARACTERS[pending.fromId] || { name: pending.fromName, colorHex: '#808080' },
      mode: 'pending',
      pendingMessage: pending,
    });
    this.scene.pause();
  }

  resumeFromDialog() {
    this.dialogOpen = false;
    window._mobileState = 'world';
    this.scene.resume();
    this._showPendingNotification();
  }

  _updateLocationHUD(buildingId) {
    const b = BUILDING_MAP[buildingId];
    if (b) {
      this.locationText.setText(b.name);
    }
  }

  _showPendingNotification() {
    if (this.possessionManager.hasPending()) {
      const count = this.possessionManager.pendingMessages.length;
      this.pendingNotif.setText('[TAB] ' + count + ' message' + (count > 1 ? 's' : ''));
      this.pendingNotif.visible = true;
    } else {
      this.pendingNotif.visible = false;
    }
  }

  _showObjectInfo(objData) {
    // Temporary floating text showing object name + description
    const pos = tileToScreen(this.playerTileX, this.playerTileY);
    const text = objData.name + '\n' + (objData.description || '');
    const info = this.add.text(pos.x, pos.y - 80, text, {
      fontSize: '18px',
      fontFamily: 'monospace',
      color: GAME_THEME.speechText,
      backgroundColor: GAME_THEME.speechBg,
      padding: { x: 12, y: 8 },
      align: 'center',
      wordWrap: { width: 300 },
    });
    info.setOrigin(0.5, 1);
    info.setDepth(9999);

    // Fade out after 3 seconds
    this.tweens.add({
      targets: info,
      alpha: 0,
      delay: 3000,
      duration: 500,
      onComplete: () => info.destroy(),
    });
  }

  _updateSpeechBubbles() {
    for (const [charId, bubble] of Object.entries(this.speechBubbles)) {
      const entry = this.charManager.sprites[charId];
      if (!entry) continue;
      const x = entry.sprite.x;
      const y = entry.sprite.y - GAME_CONFIG.SPRITE_H - 20;
      bubble.text.x = x;
      bubble.text.y = y;
      // Reposition tail
      if (bubble.bg) {
        bubble.bg.clear();
        bubble.bg.fillStyle(GAME_THEME.speechTail, 0.9);
        bubble.bg.fillTriangle(x - 6, y + 2, x + 6, y + 2, x, y + 10);
      }
    }
  }

  _onConversationEvent(event) {
    // Only show if the speaker is in the same building as the player
    const playerBuilding = this.possessionManager.currentBuilding;
    if (event.building !== playerBuilding) return;

    // Show speech bubble above the speaking character
    const charId = event.speakerId;
    const entry = this.charManager.sprites[charId];
    if (!entry) return;

    this._showSpeechBubble(charId, event.message, entry);
  }

  _showSpeechBubble(charId, message, charEntry) {
    // Remove existing bubble for this character
    if (this.speechBubbles[charId]) {
      const old = this.speechBubbles[charId];
      if (old.timer) old.timer.remove();
      if (old.bg) old.bg.destroy();
      old.text.destroy();
      delete this.speechBubbles[charId];
    }

    // Truncate long messages
    const maxLen = 120;
    const display = message.length > maxLen ? message.slice(0, maxLen) + '...' : message;

    const x = charEntry.sprite.x;
    const y = charEntry.sprite.y - GAME_CONFIG.SPRITE_H - 20;

    // Speech text
    const text = this.add.text(x, y, display, {
      fontSize: '14px',
      fontFamily: 'monospace',
      color: GAME_THEME.speechText,
      backgroundColor: GAME_THEME.speechBg,
      padding: { x: 10, y: 6 },
      wordWrap: { width: 240 },
      align: 'left',
    });
    text.setOrigin(0.5, 1);
    text.setDepth(9990);

    // Small tail triangle (cosmetic — just a tiny indicator)
    const tailX = x;
    const tailY = y + 2;
    const bg = this.add.graphics();
    bg.fillStyle(GAME_THEME.speechTail, 0.9);
    bg.fillTriangle(tailX - 6, tailY, tailX + 6, tailY, tailX, tailY + 8);
    bg.setDepth(9989);

    // Auto-dismiss: ~60ms per character, min 4s, max 12s
    const duration = Math.min(12000, Math.max(4000, display.length * 60));

    const timer = this.time.delayedCall(duration, () => {
      this.tweens.add({
        targets: [text, bg],
        alpha: 0,
        duration: 500,
        onComplete: () => {
          text.destroy();
          bg.destroy();
          delete this.speechBubbles[charId];
        },
      });
    });

    // Track position updates
    this.speechBubbles[charId] = { text, bg, timer, charId };
  }

  shutdown() {
    this.charManager.destroy();
    this.possessionManager.destroy();
    this.objectManager.destroy();
    // Clean up speech bubbles
    for (const bubble of Object.values(this.speechBubbles)) {
      if (bubble.timer) bubble.timer.remove();
      if (bubble.bg) bubble.bg.destroy();
      bubble.text.destroy();
    }
    this.speechBubbles = {};
  }
}
