/**
 * LAINTOWN GAME — Boot Scene
 * Generate procedural sprites and tilemap.
 * Isometric: flat tiles 128x64 diamonds, wall/forest blocks 128x96.
 */

class BootScene extends Phaser.Scene {
  constructor() {
    super('BootScene');
  }

  init(data) {
    this.authData = data;
  }

  create() {
    const cx = GAME_CONFIG.WIDTH / 2;
    const cy = GAME_CONFIG.HEIGHT / 2;

    this.add.text(cx, cy, 'loading...', {
      fontSize: '28px',
      fontFamily: 'monospace',
      color: GAME_THEME.uiBorder,
    }).setOrigin(0.5);

    this._generateTileset();
    this._generateCharacterSprites();
    this._generateTilemap();
    this._generateUITextures();

    // Load initial skin config if available
    if (window.LaintownSkins?.getSpriteConfig) {
      window.LaintownSkins.getSpriteConfig().then((config) => {
        if (config) window.setSpritesSkinConfig(config);
      }).catch(() => {});
    }

    // On skin change, reload the page. Phaser's WebGL pipeline can't safely
    // swap textures at runtime. We use a flag to skip the initial skin-changed
    // event that fires when loader.js initializes on page load.
    let skinInitDone = false;
    document.addEventListener('skin-changed', (e) => {
      if (skinInitDone) {
        // Ensure skin is saved before reload (setSkin may not have finished)
        const newSkin = e.detail?.skinId;
        if (newSkin) localStorage.setItem('laintown-skin', newSkin);
        location.reload();
      }
      skinInitDone = true;
    });

    this.scene.start('WorldScene', this.authData);
  }

  // Regenerate tile textures after a skin change (called by gameThemeChanged)
  _regenerateTileTextures(gameRef) {
    const tileKeys = ['tile_grass', 'tile_path', 'tile_floor', 'tile_wall', 'tile_forest', 'tile_water'];
    for (const key of tileKeys) {
      if (gameRef.textures.exists(key)) {
        gameRef.textures.remove(key);
      }
    }
    this._generateTileset();
    // Notify WorldScene to rebuild the tilemap visuals
    const worldScene = gameRef.scene.getScene('WorldScene');
    if (worldScene && worldScene._rebuildTileTextures) {
      worldScene._rebuildTileTextures();
    }
  }

  // Regenerate UI textures after a skin change
  _regenerateUITextures(gameRef) {
    if (gameRef.textures.exists('textbox')) gameRef.textures.remove('textbox');
    if (gameRef.textures.exists('notif_icon')) gameRef.textures.remove('notif_icon');
    this._generateUITextures();
  }

  _generateTileset() {
    const W = GAME_CONFIG.ISO_TILE_W;   // 128
    const H = GAME_CONFIG.ISO_TILE_H;   // 64
    const WH = GAME_CONFIG.ISO_WALL_H;  // 96
    const halfW = W / 2;  // 64
    const halfH = H / 2;  // 32
    const wallDrop = WH - H; // 32

    // Helper: diamond path for flat tiles
    const flatDiamond = (ctx) => {
      ctx.beginPath();
      ctx.moveTo(halfW, 0);
      ctx.lineTo(W, halfH);
      ctx.lineTo(halfW, H);
      ctx.lineTo(0, halfH);
      ctx.closePath();
    };

    // --- Grass (flat diamond 128x64) ---
    const grass = this.textures.createCanvas('tile_grass', W, H);
    const gCtx = grass.getContext();
    flatDiamond(gCtx);
    gCtx.fillStyle = GAME_THEME.grassMain;
    gCtx.fill();
    gCtx.save();
    flatDiamond(gCtx);
    gCtx.clip();
    for (let i = 0; i < 10; i++) {
      gCtx.fillStyle = Math.random() > 0.5 ? GAME_THEME.grassLight : GAME_THEME.grassDark;
      gCtx.fillRect(
        Math.floor(Math.random() * W),
        Math.floor(Math.random() * H),
        8 + Math.floor(Math.random() * 10),
        4 + Math.floor(Math.random() * 6)
      );
    }
    gCtx.strokeStyle = GAME_THEME.grassOutline;
    gCtx.lineWidth = 1;
    for (let i = 0; i < 24; i++) {
      const bx = Math.floor(Math.random() * W);
      const by = Math.floor(Math.random() * H);
      gCtx.beginPath();
      gCtx.moveTo(bx, by);
      gCtx.lineTo(bx + (Math.random() * 4 - 2), by - 3 - Math.random() * 3);
      gCtx.stroke();
    }
    gCtx.strokeStyle = GAME_THEME.grassOutline;
    for (let i = 0; i < 12; i++) {
      const bx = Math.floor(Math.random() * W);
      const by = Math.floor(Math.random() * H);
      gCtx.beginPath();
      gCtx.moveTo(bx, by);
      gCtx.lineTo(bx + (Math.random() * 3 - 1.5), by - 2 - Math.random() * 3);
      gCtx.stroke();
    }
    gCtx.restore();
    grass.refresh();

    // --- Path (flat diamond) ---
    const path = this.textures.createCanvas('tile_path', W, H);
    const pCtx = path.getContext();
    flatDiamond(pCtx);
    pCtx.fillStyle = GAME_THEME.pathMain;
    pCtx.fill();
    pCtx.save();
    flatDiamond(pCtx);
    pCtx.clip();
    pCtx.fillStyle = GAME_THEME.pathLight;
    pCtx.beginPath();
    pCtx.moveTo(halfW, 8);
    pCtx.lineTo(W - 16, halfH);
    pCtx.lineTo(halfW, H - 8);
    pCtx.lineTo(16, halfH);
    pCtx.closePath();
    pCtx.fill();
    pCtx.fillStyle = GAME_THEME.pathLight;
    for (let i = 0; i < 15; i++) {
      const s = 1 + Math.floor(Math.random() * 3);
      pCtx.fillRect(
        16 + Math.floor(Math.random() * (W - 32)),
        8 + Math.floor(Math.random() * (H - 16)),
        s, s
      );
    }
    pCtx.fillStyle = GAME_THEME.pathMain;
    for (let i = 0; i < 6; i++) {
      pCtx.fillRect(
        16 + Math.floor(Math.random() * (W - 32)),
        8 + Math.floor(Math.random() * (H - 16)),
        1, 2 + Math.floor(Math.random() * 3)
      );
    }
    pCtx.restore();
    path.refresh();

    // --- Floor (flat diamond) ---
    const floor = this.textures.createCanvas('tile_floor', W, H);
    const fCtx = floor.getContext();
    flatDiamond(fCtx);
    fCtx.fillStyle = GAME_THEME.floorMain;
    fCtx.fill();
    fCtx.save();
    flatDiamond(fCtx);
    fCtx.clip();
    fCtx.strokeStyle = GAME_THEME.floorGrid;
    fCtx.lineWidth = 1;
    // Isometric grid: lines parallel to NE edges (slope +0.5)
    const linesA = [[48,8,112,40], [32,16,96,48], [16,24,80,56]];
    for (const [x1,y1,x2,y2] of linesA) {
      fCtx.beginPath(); fCtx.moveTo(x1, y1); fCtx.lineTo(x2, y2); fCtx.stroke();
    }
    // Lines parallel to NW edges (slope -0.5)
    const linesB = [[80,8,16,40], [96,16,32,48], [112,24,48,56]];
    for (const [x1,y1,x2,y2] of linesB) {
      fCtx.beginPath(); fCtx.moveTo(x1, y1); fCtx.lineTo(x2, y2); fCtx.stroke();
    }
    fCtx.fillStyle = GAME_THEME.floorGrid;
    for (let i = 0; i < 10; i++) {
      fCtx.fillRect(Math.floor(Math.random() * W), Math.floor(Math.random() * H), 2, 1);
    }
    fCtx.restore();
    floor.refresh();

    // --- Wall (3D block 128x96) ---
    const wall = this.textures.createCanvas('tile_wall', W, WH);
    const wCtx = wall.getContext();
    // Top face
    wCtx.beginPath();
    wCtx.moveTo(halfW, 0);
    wCtx.lineTo(W, halfH);
    wCtx.lineTo(halfW, H);
    wCtx.lineTo(0, halfH);
    wCtx.closePath();
    wCtx.fillStyle = GAME_THEME.wallTop;
    wCtx.fill();
    // Top highlight
    wCtx.strokeStyle = GAME_THEME.wallHighlight;
    wCtx.lineWidth = 1;
    wCtx.beginPath();
    wCtx.moveTo(0, halfH);
    wCtx.lineTo(halfW, 0);
    wCtx.lineTo(W, halfH);
    wCtx.stroke();
    // Left face
    wCtx.beginPath();
    wCtx.moveTo(0, halfH);
    wCtx.lineTo(halfW, H);
    wCtx.lineTo(halfW, H + wallDrop);
    wCtx.lineTo(0, halfH + wallDrop);
    wCtx.closePath();
    wCtx.fillStyle = GAME_THEME.wallSide;
    wCtx.fill();
    wCtx.strokeStyle = GAME_THEME.wallDark;
    wCtx.lineWidth = 1;
    for (let d = 10; d < wallDrop; d += 10) {
      wCtx.beginPath();
      wCtx.moveTo(0, halfH + d);
      wCtx.lineTo(halfW, H + d);
      wCtx.stroke();
    }
    // Right face
    wCtx.beginPath();
    wCtx.moveTo(halfW, H);
    wCtx.lineTo(W, halfH);
    wCtx.lineTo(W, halfH + wallDrop);
    wCtx.lineTo(halfW, H + wallDrop);
    wCtx.closePath();
    wCtx.fillStyle = GAME_THEME.wallDark;
    wCtx.fill();
    wCtx.strokeStyle = GAME_THEME.wallDark;
    wCtx.lineWidth = 1;
    for (let d = 10; d < wallDrop; d += 10) {
      wCtx.beginPath();
      wCtx.moveTo(halfW, H + d);
      wCtx.lineTo(W, halfH + d);
      wCtx.stroke();
    }
    // Bottom edge
    wCtx.strokeStyle = GAME_THEME.wallDark;
    wCtx.lineWidth = 1;
    wCtx.beginPath();
    wCtx.moveTo(0, halfH + wallDrop);
    wCtx.lineTo(halfW, H + wallDrop);
    wCtx.lineTo(W, halfH + wallDrop);
    wCtx.stroke();
    wall.refresh();

    // --- Forest (3D block 128x96) ---
    const forest = this.textures.createCanvas('tile_forest', W, WH);
    const foCtx = forest.getContext();
    // Top canopy face
    foCtx.beginPath();
    foCtx.moveTo(halfW, 0);
    foCtx.lineTo(W, halfH);
    foCtx.lineTo(halfW, H);
    foCtx.lineTo(0, halfH);
    foCtx.closePath();
    foCtx.fillStyle = GAME_THEME.forestCanopy;
    foCtx.fill();
    foCtx.save();
    foCtx.beginPath();
    foCtx.moveTo(halfW, 0);
    foCtx.lineTo(W, halfH);
    foCtx.lineTo(halfW, H);
    foCtx.lineTo(0, halfH);
    foCtx.closePath();
    foCtx.clip();
    const canopyColors = [GAME_THEME.grassLight, GAME_THEME.grassMain, GAME_THEME.grassDark, GAME_THEME.forestCanopy];
    for (let i = 0; i < 5; i++) {
      foCtx.fillStyle = canopyColors[i % canopyColors.length];
      foCtx.beginPath();
      foCtx.ellipse(
        20 + Math.random() * (W - 40),
        8 + Math.random() * (H - 16),
        14 + Math.random() * 12,
        8 + Math.random() * 8,
        0, 0, Math.PI * 2
      );
      foCtx.fill();
    }
    foCtx.restore();
    // Left face
    foCtx.beginPath();
    foCtx.moveTo(0, halfH);
    foCtx.lineTo(halfW, H);
    foCtx.lineTo(halfW, H + wallDrop);
    foCtx.lineTo(0, halfH + wallDrop);
    foCtx.closePath();
    foCtx.fillStyle = GAME_THEME.forestCanopy;
    foCtx.fill();
    // Right face
    foCtx.beginPath();
    foCtx.moveTo(halfW, H);
    foCtx.lineTo(W, halfH);
    foCtx.lineTo(W, halfH + wallDrop);
    foCtx.lineTo(halfW, H + wallDrop);
    foCtx.closePath();
    foCtx.fillStyle = GAME_THEME.forestCanopy;
    foCtx.fill();
    forest.refresh();

    // --- Water (flat diamond) ---
    const water = this.textures.createCanvas('tile_water', W, H);
    const waCtx = water.getContext();
    flatDiamond(waCtx);
    waCtx.fillStyle = GAME_THEME.waterMain;
    waCtx.fill();
    waCtx.save();
    flatDiamond(waCtx);
    waCtx.clip();
    waCtx.strokeStyle = GAME_THEME.waterDetail;
    waCtx.lineWidth = 2;
    for (let wy = 6; wy < H; wy += 10) {
      waCtx.beginPath();
      waCtx.moveTo(0, wy);
      for (let wx = 0; wx <= W; wx += 6) {
        waCtx.lineTo(wx, wy + Math.sin(wx * 0.2 + wy) * 2);
      }
      waCtx.stroke();
    }
    waCtx.strokeStyle = GAME_THEME.waterDetail;
    waCtx.lineWidth = 1;
    for (let i = 0; i < 6; i++) {
      const sx = Math.floor(Math.random() * (W - 20));
      const sy = Math.floor(Math.random() * H);
      waCtx.beginPath();
      waCtx.moveTo(sx, sy);
      waCtx.lineTo(sx + 8 + Math.random() * 10, sy + Math.random() * 2 - 1);
      waCtx.stroke();
    }
    waCtx.restore();
    water.refresh();
  }

  _generateCharacterSprites() {
    renderPixelSprites(this);
  }

  _generateTilemap() {
    const cols = GAME_CONFIG.MAP_COLS;
    const rows = GAME_CONFIG.MAP_ROWS;

    // Tile types: 0=grass, 1=path, 2=floor, 3=wall, 4=forest, 5=water
    const GRASS = 0, PATH = 1, FLOOR = 2, WALL = 3, FOREST = 4, WATER = 5;

    // Initialize with grass
    const ground = Array.from({ length: rows }, () => Array(cols).fill(GRASS));
    const collision = Array.from({ length: rows }, () => Array(cols).fill(0));

    // Draw forest borders (3 tiles thick)
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (x < 3 || x >= cols - 3 || y < 2 || y >= rows - 2) {
          ground[y][x] = FOREST;
          collision[y][x] = 1;
        }
      }
    }

    // Helper: set tile if in bounds
    const setTile = (x, y, type, solid) => {
      if (y >= 0 && y < rows && x >= 0 && x < cols) {
        ground[y][x] = type;
        collision[y][x] = solid ? 1 : 0;
      }
    };

    // Place buildings
    for (const b of BUILDINGS) {
      const zone = getBuildingZone(b.id);
      if (!zone) continue;

      // Fill entire zone with floor first
      for (let dy = 0; dy < zone.h; dy++) {
        for (let dx = 0; dx < zone.w; dx++) {
          setTile(zone.x + dx, zone.y + dy, FLOOR, false);
        }
      }

      // Top wall (1 tile thick)
      for (let dx = 0; dx < zone.w; dx++) {
        setTile(zone.x + dx, zone.y, WALL, true);
      }
      // Bottom wall
      for (let dx = 0; dx < zone.w; dx++) {
        setTile(zone.x + dx, zone.y + zone.h - 1, WALL, true);
      }
      // Left wall
      for (let dy = 0; dy < zone.h; dy++) {
        setTile(zone.x, zone.y + dy, WALL, true);
      }
      // Right wall
      for (let dy = 0; dy < zone.h; dy++) {
        setTile(zone.x + zone.w - 1, zone.y + dy, WALL, true);
      }

      // Door openings — center of each wall, 2 tiles wide/tall
      const midX = zone.x + Math.floor(zone.w / 2) - 1;
      const midY = zone.y + Math.floor(zone.h / 2) - 1;

      // Top door
      setTile(midX, zone.y, FLOOR, false);
      setTile(midX + 1, zone.y, FLOOR, false);
      // Bottom door
      setTile(midX, zone.y + zone.h - 1, FLOOR, false);
      setTile(midX + 1, zone.y + zone.h - 1, FLOOR, false);
      // Left door
      setTile(zone.x, midY, FLOOR, false);
      setTile(zone.x, midY + 1, FLOOR, false);
      // Right door
      setTile(zone.x + zone.w - 1, midY, FLOOR, false);
      setTile(zone.x + zone.w - 1, midY + 1, FLOOR, false);
    }

    // Draw paths between buildings (vertical and horizontal)
    for (const b of BUILDINGS) {
      const zone = getBuildingZone(b.id);
      if (!zone) continue;

      // Horizontal path to the right neighbor
      if (b.col < 2) {
        const rightB = BUILDINGS.find((rb) => rb.row === b.row && rb.col === b.col + 1);
        if (rightB) {
          const rZone = getBuildingZone(rightB.id);
          const midY = zone.y + Math.floor(zone.h / 2) - 1;
          for (let x = zone.x + zone.w; x < rZone.x; x++) {
            setTile(x, midY, PATH, false);
            setTile(x, midY + 1, PATH, false);
          }
        }
      }

      // Vertical path to the bottom neighbor
      if (b.row < 2) {
        const bottomB = BUILDINGS.find((bb) => bb.row === b.row + 1 && bb.col === b.col);
        if (bottomB) {
          const bZone = getBuildingZone(bottomB.id);
          const midX = zone.x + Math.floor(zone.w / 2) - 1;
          for (let y = zone.y + zone.h; y < bZone.y; y++) {
            setTile(midX, y, PATH, false);
            setTile(midX + 1, y, PATH, false);
          }
        }
      }
    }

    // Store in registry for WorldScene
    this.registry.set('mapGround', ground);
    this.registry.set('mapCollision', collision);
  }

  _generateUITextures() {
    // Dialog box background
    const dbW = GAME_CONFIG.WIDTH - 64;
    const dbH = 256;
    const dialog = this.textures.createCanvas('textbox', dbW, dbH);
    const dCtx = dialog.getContext();

    // Dark translucent background
    dCtx.fillStyle = GAME_THEME.hudOverlayBg;
    dCtx.fillRect(0, 0, dbW, dbH);

    // Outer border
    dCtx.strokeStyle = GAME_THEME.uiBorder;
    dCtx.lineWidth = 4;
    dCtx.strokeRect(2, 2, dbW - 4, dbH - 4);

    // Inner border
    dCtx.strokeStyle = GAME_THEME.uiBorderDim;
    dCtx.lineWidth = 2;
    dCtx.strokeRect(8, 8, dbW - 16, dbH - 16);

    dialog.refresh();

    // Notification indicator
    const notif = this.textures.createCanvas('notif_icon', 32, 32);
    const nCtx = notif.getContext();
    nCtx.fillStyle = GAME_THEME.hudNotif;
    nCtx.beginPath();
    nCtx.arc(16, 16, 12, 0, Math.PI * 2);
    nCtx.fill();
    nCtx.fillStyle = '#000';
    nCtx.font = '20px monospace';
    nCtx.textAlign = 'center';
    nCtx.textBaseline = 'middle';
    nCtx.fillText('!', 16, 16);
    notif.refresh();
  }
}
