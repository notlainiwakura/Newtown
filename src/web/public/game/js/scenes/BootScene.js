/**
 * LAINTOWN GAME — Boot Scene (Yami Kawaii ✟)
 * Dark pastels, slightly eerie procedural world.
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

    this.cameras.main.setBackgroundColor('#1a1520');

    this.add.text(cx, cy, 'loading...', {
      fontSize: '24px',
      fontFamily: "'M PLUS Rounded 1c', sans-serif",
      color: '#685868',
    }).setOrigin(0.5);

    this._generateTileset();
    this._generateCharacterSprites();
    this._generateTilemap();
    this._generateUITextures();

    this.scene.start('WorldScene', this.authData);
  }

  _generateTileset() {
    const T = GAME_CONFIG.TILE_SIZE;

    // --- Grass (dark muted green, slightly desaturated) ---
    const grass = this.textures.createCanvas('tile_grass', T, T);
    const gCtx = grass.getContext();
    gCtx.fillStyle = '#2a3828';
    gCtx.fillRect(0, 0, T, T);
    for (let i = 0; i < 10; i++) {
      const px = Math.floor(Math.random() * (T - 10));
      const py = Math.floor(Math.random() * (T - 10));
      const shade = Math.random() > 0.5 ? '#283626' : '#2e3c2c';
      gCtx.fillStyle = shade;
      gCtx.fillRect(px, py, 6 + Math.floor(Math.random() * 8), 6 + Math.floor(Math.random() * 8));
    }
    // Grass blades
    gCtx.strokeStyle = '#384838';
    gCtx.lineWidth = 1;
    for (let i = 0; i < 16; i++) {
      const bx = Math.floor(Math.random() * T);
      const by = Math.floor(Math.random() * T);
      gCtx.beginPath();
      gCtx.moveTo(bx, by);
      gCtx.lineTo(bx + (Math.random() * 3 - 1.5), by - 2 - Math.random() * 4);
      gCtx.stroke();
    }
    // Tiny muted flowers — sparse, like forgotten things
    const flowerColors = ['#c87898', '#9878b8', '#78b898'];
    for (let i = 0; i < 2; i++) {
      gCtx.fillStyle = flowerColors[Math.floor(Math.random() * flowerColors.length)];
      gCtx.globalAlpha = 0.4;
      const fx = Math.floor(Math.random() * (T - 4));
      const fy = Math.floor(Math.random() * (T - 4));
      gCtx.beginPath();
      gCtx.arc(fx + 2, fy + 2, 1.5, 0, Math.PI * 2);
      gCtx.fill();
    }
    gCtx.globalAlpha = 1;
    grass.refresh();

    // --- Path (dusky mauve-grey) ---
    const path = this.textures.createCanvas('tile_path', T, T);
    const pCtx = path.getContext();
    pCtx.fillStyle = '#3a3038';
    pCtx.fillRect(0, 0, T, T);
    pCtx.fillStyle = '#382e36';
    pCtx.fillRect(6, 6, T - 12, T - 12);
    pCtx.fillStyle = '#3e343c';
    pCtx.fillRect(10, 10, T - 20, T - 20);
    // Pebbles
    pCtx.fillStyle = '#483e48';
    for (let i = 0; i < 8; i++) {
      const px = 8 + Math.floor(Math.random() * (T - 16));
      const py = 8 + Math.floor(Math.random() * (T - 16));
      pCtx.fillRect(px, py, 2, 2);
    }
    // Faint cracks
    pCtx.fillStyle = '#302830';
    for (let i = 0; i < 4; i++) {
      const px = 8 + Math.floor(Math.random() * (T - 16));
      const py = 8 + Math.floor(Math.random() * (T - 16));
      pCtx.fillRect(px, py, 1, 2 + Math.floor(Math.random() * 3));
    }
    path.refresh();

    // --- Floor (dark warm wood) ---
    const floor = this.textures.createCanvas('tile_floor', T, T);
    const fCtx = floor.getContext();
    fCtx.fillStyle = '#2e2630';
    fCtx.fillRect(0, 0, T, T);
    fCtx.strokeStyle = '#362e38';
    fCtx.lineWidth = 1;
    for (let g = 0; g <= T; g += 16) {
      fCtx.beginPath(); fCtx.moveTo(0, g); fCtx.lineTo(T, g); fCtx.stroke();
    }
    fCtx.fillStyle = '#322a34';
    for (let i = 0; i < 6; i++) {
      fCtx.fillRect(Math.floor(Math.random() * T), Math.floor(Math.random() * T), 3, 1);
    }
    floor.refresh();

    // --- Wall (muted rose brick) ---
    const wall = this.textures.createCanvas('tile_wall', T, T);
    const wCtx = wall.getContext();
    wCtx.fillStyle = '#4a3040';
    wCtx.fillRect(0, 0, T, T);
    const brickH = 16, brickW = 28, mortar = 2;
    wCtx.fillStyle = '#3e2838';
    for (let row = 0; row < T; row += brickH + mortar) {
      wCtx.fillRect(0, row, T, mortar);
    }
    for (let row = 0; row < Math.ceil(T / (brickH + mortar)); row++) {
      const yStart = row * (brickH + mortar) + mortar;
      const offset = (row % 2 === 0) ? 0 : Math.floor(brickW / 2);
      for (let x = offset; x < T; x += brickW + mortar) {
        wCtx.fillRect(x, yStart, mortar, brickH);
      }
    }
    for (let row = 0; row < Math.ceil(T / (brickH + mortar)); row++) {
      const yStart = row * (brickH + mortar) + mortar;
      const offset = (row % 2 === 0) ? 0 : Math.floor(brickW / 2);
      for (let x = offset; x < T; x += brickW + mortar) {
        const bx = x + mortar;
        const by = yStart;
        if (bx < T && by < T) {
          wCtx.fillStyle = Math.random() > 0.5 ? '#4e3448' : '#463042';
          const w = Math.min(brickW - mortar, T - bx);
          const h = Math.min(brickH, T - by);
          wCtx.fillRect(bx + 1, by + 1, Math.max(0, w - 2), Math.max(0, h - 2));
        }
      }
    }
    wCtx.fillStyle = '#543a50';
    wCtx.fillRect(0, 0, T, 2);
    wall.refresh();

    // --- Forest (deep, slightly eerie) ---
    const forest = this.textures.createCanvas('tile_forest', T, T);
    const foCtx = forest.getContext();
    foCtx.fillStyle = '#141e14';
    foCtx.fillRect(0, 0, T, T);
    foCtx.fillStyle = '#2a1c18';
    foCtx.fillRect(26, 48, 6, 16);
    foCtx.fillRect(38, 50, 5, 14);
    const canopyColors = ['#1a2a1a', '#1e301e', '#223422'];
    for (let i = 0; i < 3; i++) {
      foCtx.fillStyle = canopyColors[i];
      foCtx.beginPath();
      foCtx.ellipse(20 + i * 12 + (Math.random() * 8 - 4), 18 + i * 6, 16 + Math.random() * 6, 14 + Math.random() * 4, 0, 0, Math.PI * 2);
      foCtx.fill();
    }
    foCtx.fillStyle = '#162216';
    foCtx.beginPath(); foCtx.ellipse(46, 24, 14, 12, 0, 0, Math.PI * 2); foCtx.fill();
    foCtx.fillStyle = '#1c2e1c';
    foCtx.beginPath(); foCtx.ellipse(16, 28, 12, 10, 0, 0, Math.PI * 2); foCtx.fill();
    // Subtle glow spots in forest
    foCtx.fillStyle = 'rgba(200, 120, 152, 0.06)';
    foCtx.beginPath(); foCtx.arc(30, 30, 8, 0, Math.PI * 2); foCtx.fill();
    forest.refresh();

    // --- Water (deep twilight) ---
    const water = this.textures.createCanvas('tile_water', T, T);
    const waCtx = water.getContext();
    waCtx.fillStyle = '#181828';
    waCtx.fillRect(0, 0, T, T);
    waCtx.strokeStyle = '#202038';
    waCtx.lineWidth = 2;
    for (let wy = 8; wy < T; wy += 12) {
      waCtx.beginPath(); waCtx.moveTo(0, wy);
      for (let wx = 0; wx <= T; wx += 8) {
        waCtx.lineTo(wx, wy + Math.sin(wx * 0.3 + wy) * 3);
      }
      waCtx.stroke();
    }
    // Faint pink reflections
    waCtx.fillStyle = 'rgba(200, 120, 152, 0.08)';
    for (let i = 0; i < 3; i++) {
      waCtx.beginPath();
      waCtx.arc(Math.random() * T, Math.random() * T, 3 + Math.random() * 4, 0, Math.PI * 2);
      waCtx.fill();
    }
    water.refresh();
  }

  _generateCharacterSprites() {
    const W = GAME_CONFIG.SPRITE_W;  // 64
    const H = GAME_CONFIG.SPRITE_H;  // 96

    // Chibi proportions: big head, small body
    const HEAD_CX = W / 2;
    const HEAD_CY = 26;
    const HEAD_RX = 20;
    const HEAD_RY = 22;
    const BODY_TOP = 46;
    const BODY_BOT = H - 8;
    const SKIN = '#dcc8c0';
    const SKIN_SHADOW = '#c8b0a8';

    // Per-character visual config
    const charVisuals = {
      'lain': {
        hairColor: '#3a2040', hairLight: '#4a2850',
        outfit: '#484058', outfitAccent: '#5a5068',
        drawHair: (ctx) => {
          // Signature helmet bob
          ctx.fillStyle = '#3a2040';
          // Main dome
          ctx.beginPath();
          ctx.ellipse(HEAD_CX, HEAD_CY - 6, 22, 20, 0, Math.PI, 0);
          ctx.fill();
          // Side panels hanging down
          ctx.fillRect(9, HEAD_CY - 8, 10, 28);
          ctx.fillRect(45, HEAD_CY - 8, 10, 28);
          // Round the bottom of side panels
          ctx.beginPath(); ctx.arc(14, HEAD_CY + 18, 5, 0, Math.PI * 2); ctx.fill();
          ctx.beginPath(); ctx.arc(50, HEAD_CY + 18, 5, 0, Math.PI * 2); ctx.fill();
          // Bangs — thick fringe
          ctx.fillStyle = '#4a2850';
          ctx.beginPath();
          ctx.moveTo(12, HEAD_CY - 10);
          ctx.quadraticCurveTo(HEAD_CX, HEAD_CY - 4, 52, HEAD_CY - 10);
          ctx.lineTo(52, HEAD_CY - 2);
          ctx.quadraticCurveTo(HEAD_CX, HEAD_CY + 4, 12, HEAD_CY - 2);
          ctx.fill();
          // Hair clip — small X mark
          ctx.strokeStyle = '#c87898';
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(46, HEAD_CY); ctx.lineTo(50, HEAD_CY + 4); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(50, HEAD_CY); ctx.lineTo(46, HEAD_CY + 4); ctx.stroke();
        },
        drawOutfit: (ctx, mR, mG, mB) => {
          // School uniform — dark top with collar
          ctx.fillStyle = '#484058';
          ctx.fillRect(18, BODY_TOP + 2, 28, BODY_BOT - BODY_TOP - 6);
          // White collar V
          ctx.strokeStyle = '#d8d0d0';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(22, BODY_TOP + 2);
          ctx.lineTo(HEAD_CX, BODY_TOP + 14);
          ctx.lineTo(42, BODY_TOP + 2);
          ctx.stroke();
        },
      },
      'wired-lain': {
        hairColor: '#283858', hairLight: '#384868',
        outfit: '#304050', outfitAccent: '#405868',
        drawHair: (ctx) => {
          // Long flowing hair — ethereal
          ctx.fillStyle = '#283858';
          ctx.beginPath();
          ctx.ellipse(HEAD_CX, HEAD_CY - 8, 23, 18, 0, Math.PI, 0);
          ctx.fill();
          // Long flowing sides past body
          ctx.fillRect(6, HEAD_CY - 6, 8, 46);
          ctx.fillRect(50, HEAD_CY - 6, 8, 46);
          // Wispy tips at different lengths
          ctx.fillStyle = '#304060';
          ctx.beginPath(); ctx.arc(10, HEAD_CY + 38, 4, 0, Math.PI * 2); ctx.fill();
          ctx.beginPath(); ctx.arc(54, HEAD_CY + 40, 4, 0, Math.PI * 2); ctx.fill();
          // Extra wisps
          ctx.fillRect(4, HEAD_CY + 30, 4, 14);
          ctx.fillRect(56, HEAD_CY + 28, 4, 16);
          // Bangs — lighter, parted slightly
          ctx.fillStyle = '#384868';
          ctx.fillRect(14, HEAD_CY - 12, 15, 10);
          ctx.fillRect(33, HEAD_CY - 12, 17, 10);
          // Faint glow on hair tips
          ctx.fillStyle = 'rgba(104,152,200,0.15)';
          ctx.beginPath(); ctx.arc(10, HEAD_CY + 38, 6, 0, Math.PI * 2); ctx.fill();
          ctx.beginPath(); ctx.arc(54, HEAD_CY + 40, 6, 0, Math.PI * 2); ctx.fill();
        },
        drawOutfit: (ctx) => {
          // Flowing dark top
          ctx.fillStyle = '#304050';
          ctx.fillRect(18, BODY_TOP + 2, 28, BODY_BOT - BODY_TOP - 6);
          // Subtle circuit/wire pattern
          ctx.strokeStyle = 'rgba(104,152,200,0.2)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(24, BODY_TOP + 8);
          ctx.lineTo(24, BODY_TOP + 20);
          ctx.lineTo(32, BODY_TOP + 20);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(40, BODY_TOP + 12);
          ctx.lineTo(40, BODY_TOP + 24);
          ctx.stroke();
        },
      },
      'pkd': {
        hairColor: '#3a2838', hairLight: '#4a3848',
        skinOverride: '#d0b8b0',
        outfit: '#4a4040', outfitAccent: '#5a5050',
        drawHair: (ctx) => {
          // Thinning/receding — balding top with sides
          ctx.fillStyle = '#3a2838';
          ctx.fillRect(10, HEAD_CY - 10, 8, 16);
          ctx.fillRect(46, HEAD_CY - 10, 8, 16);
          // Thin top
          ctx.fillStyle = '#4a3848';
          ctx.fillRect(18, HEAD_CY - 16, 28, 5);
          // Messy wispy bits
          ctx.fillRect(14, HEAD_CY - 14, 4, 6);
          ctx.fillRect(44, HEAD_CY - 14, 4, 6);
          // Glasses
          ctx.strokeStyle = '#887878';
          ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.ellipse(24, HEAD_CY + 2, 6, 5, 0, 0, Math.PI * 2); ctx.stroke();
          ctx.beginPath(); ctx.ellipse(40, HEAD_CY + 2, 6, 5, 0, 0, Math.PI * 2); ctx.stroke();
          // Bridge
          ctx.beginPath(); ctx.moveTo(30, HEAD_CY + 1); ctx.lineTo(34, HEAD_CY + 1); ctx.stroke();
          // Stubble dots
          ctx.fillStyle = 'rgba(58,40,56,0.3)';
          for (let i = 0; i < 8; i++) {
            ctx.fillRect(24 + Math.random() * 16, HEAD_CY + 12 + Math.random() * 6, 1, 1);
          }
        },
        drawOutfit: (ctx) => {
          // Rumpled jacket
          ctx.fillStyle = '#4a4040';
          ctx.fillRect(18, BODY_TOP + 2, 28, BODY_BOT - BODY_TOP - 6);
          // Open jacket line
          ctx.strokeStyle = '#3a3030';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(HEAD_CX, BODY_TOP + 2);
          ctx.lineTo(HEAD_CX, BODY_BOT - 6);
          ctx.stroke();
          // Undershirt hint
          ctx.fillStyle = '#685858';
          ctx.fillRect(29, BODY_TOP + 4, 6, 12);
        },
      },
      'mckenna': {
        hairColor: '#2a3020', hairLight: '#3a4030',
        outfit: '#3a4838', outfitAccent: '#4a5848',
        drawHair: (ctx) => {
          // Big bushy curly hair + beard
          ctx.fillStyle = '#2a3020';
          // Main volume — huge!
          ctx.beginPath();
          ctx.ellipse(HEAD_CX, HEAD_CY - 10, 26, 20, 0, 0, Math.PI * 2);
          ctx.fill();
          // Extra volume sides
          ctx.beginPath(); ctx.arc(6, HEAD_CY - 2, 10, 0, Math.PI * 2); ctx.fill();
          ctx.beginPath(); ctx.arc(58, HEAD_CY - 2, 10, 0, Math.PI * 2); ctx.fill();
          // Curly texture blobs
          ctx.fillStyle = '#343828';
          for (let i = 0; i < 10; i++) {
            const cx = 10 + Math.random() * 44;
            const cy = HEAD_CY - 20 + Math.random() * 16;
            ctx.beginPath(); ctx.arc(cx, cy, 3 + Math.random() * 3, 0, Math.PI * 2); ctx.fill();
          }
          // Beard
          ctx.fillStyle = '#2a3020';
          ctx.beginPath();
          ctx.moveTo(20, HEAD_CY + 10);
          ctx.quadraticCurveTo(HEAD_CX, HEAD_CY + 24, 44, HEAD_CY + 10);
          ctx.fill();
          // Mustache
          ctx.fillStyle = '#343828';
          ctx.beginPath();
          ctx.ellipse(HEAD_CX, HEAD_CY + 10, 10, 4, 0, 0, Math.PI);
          ctx.fill();
        },
        drawOutfit: (ctx) => {
          // Earthy/hemp shirt
          ctx.fillStyle = '#3a4838';
          ctx.fillRect(18, BODY_TOP + 2, 28, BODY_BOT - BODY_TOP - 6);
          // Pattern — mushroom motif (tiny)
          ctx.fillStyle = 'rgba(120,184,152,0.2)';
          ctx.beginPath(); ctx.arc(28, BODY_TOP + 16, 3, Math.PI, 0); ctx.fill();
          ctx.fillRect(27, BODY_TOP + 16, 2, 4);
          ctx.beginPath(); ctx.arc(38, BODY_TOP + 24, 3, Math.PI, 0); ctx.fill();
          ctx.fillRect(37, BODY_TOP + 24, 2, 4);
        },
      },
      'john': {
        hairColor: '#3a2e20', hairLight: '#4a3e30',
        outfit: '#484048', outfitAccent: '#585058',
        drawHair: (ctx) => {
          // Short, clean, no-nonsense
          ctx.fillStyle = '#3a2e20';
          // Tight to head
          ctx.beginPath();
          ctx.ellipse(HEAD_CX, HEAD_CY - 10, 19, 14, 0, Math.PI, 0);
          ctx.fill();
          // Short sides
          ctx.fillRect(12, HEAD_CY - 8, 5, 10);
          ctx.fillRect(47, HEAD_CY - 8, 5, 10);
          // Simple fringe
          ctx.fillStyle = '#4a3e30';
          ctx.fillRect(16, HEAD_CY - 12, 32, 5);
        },
        drawOutfit: (ctx) => {
          // Plain t-shirt
          ctx.fillStyle = '#484048';
          ctx.fillRect(18, BODY_TOP + 2, 28, BODY_BOT - BODY_TOP - 6);
          // Crew neck
          ctx.strokeStyle = '#585058';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(HEAD_CX, BODY_TOP + 4, 8, 0, Math.PI);
          ctx.stroke();
        },
      },
      'dr-claude': {
        hairColor: '#302030', hairLight: '#402840',
        outfit: '#d8d0cc', outfitAccent: '#c8c0b8',
        drawHair: (ctx) => {
          // Neat, parted professional hair
          ctx.fillStyle = '#302030';
          ctx.beginPath();
          ctx.ellipse(HEAD_CX, HEAD_CY - 10, 20, 15, 0, Math.PI, 0);
          ctx.fill();
          ctx.fillRect(11, HEAD_CY - 8, 6, 14);
          ctx.fillRect(47, HEAD_CY - 8, 6, 14);
          // Part
          ctx.fillStyle = '#402840';
          ctx.fillRect(16, HEAD_CY - 14, 14, 7);
          ctx.fillRect(32, HEAD_CY - 14, 16, 7);
          ctx.fillStyle = SKIN_SHADOW;
          ctx.fillRect(30, HEAD_CY - 13, 2, 6);
        },
        drawOutfit: (ctx) => {
          // White lab coat
          ctx.fillStyle = '#d8d0cc';
          ctx.fillRect(16, BODY_TOP + 2, 32, BODY_BOT - BODY_TOP - 4);
          // Coat opening
          ctx.strokeStyle = '#b8b0a8';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(HEAD_CX, BODY_TOP + 2);
          ctx.lineTo(HEAD_CX, BODY_BOT - 4);
          ctx.stroke();
          // Lapels
          ctx.strokeStyle = '#c8c0b8';
          ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(HEAD_CX - 1, BODY_TOP + 2); ctx.lineTo(HEAD_CX - 6, BODY_TOP + 14); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(HEAD_CX + 1, BODY_TOP + 2); ctx.lineTo(HEAD_CX + 6, BODY_TOP + 14); ctx.stroke();
          // Undershirt — dark
          ctx.fillStyle = '#585060';
          ctx.fillRect(28, BODY_TOP + 4, 8, 10);
          // Pocket
          ctx.strokeStyle = '#c0b8b0';
          ctx.strokeRect(20, BODY_TOP + 10, 7, 6);
          // Stethoscope hint
          ctx.strokeStyle = 'rgba(200,120,152,0.4)';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(HEAD_CX, BODY_TOP + 24, 4, 0, Math.PI);
          ctx.stroke();
        },
      },
      'hiru': {
        hairColor: '#284030', hairLight: '#385040',
        outfit: '#3a4838', outfitAccent: '#4a5848',
        drawHair: (ctx) => {
          // Tousled messy hair — soft spikes, not sharp
          ctx.fillStyle = '#284030';
          // Base volume covering top of head
          ctx.beginPath();
          ctx.ellipse(HEAD_CX, HEAD_CY - 8, 22, 18, 0, Math.PI, 0);
          ctx.fill();
          // Fill sides
          ctx.fillRect(10, HEAD_CY - 10, 44, 8);
          // Soft tufts on top — individual rounded spikes
          ctx.fillStyle = '#284030';
          // Left tuft
          ctx.beginPath();
          ctx.moveTo(14, HEAD_CY - 10);
          ctx.quadraticCurveTo(10, HEAD_CY - 22, 20, HEAD_CY - 12);
          ctx.fill();
          // Center-left tuft
          ctx.beginPath();
          ctx.moveTo(22, HEAD_CY - 12);
          ctx.quadraticCurveTo(24, HEAD_CY - 26, 30, HEAD_CY - 12);
          ctx.fill();
          // Center tuft (tallest)
          ctx.beginPath();
          ctx.moveTo(28, HEAD_CY - 14);
          ctx.quadraticCurveTo(32, HEAD_CY - 30, 36, HEAD_CY - 14);
          ctx.fill();
          // Center-right tuft
          ctx.beginPath();
          ctx.moveTo(34, HEAD_CY - 12);
          ctx.quadraticCurveTo(38, HEAD_CY - 24, 42, HEAD_CY - 10);
          ctx.fill();
          // Right tuft
          ctx.beginPath();
          ctx.moveTo(42, HEAD_CY - 10);
          ctx.quadraticCurveTo(50, HEAD_CY - 20, 50, HEAD_CY - 8);
          ctx.fill();
          // Lighter highlight tufts
          ctx.fillStyle = '#385040';
          ctx.beginPath();
          ctx.moveTo(26, HEAD_CY - 14);
          ctx.quadraticCurveTo(30, HEAD_CY - 24, 34, HEAD_CY - 14);
          ctx.fill();
          ctx.beginPath();
          ctx.moveTo(16, HEAD_CY - 10);
          ctx.quadraticCurveTo(14, HEAD_CY - 18, 22, HEAD_CY - 10);
          ctx.fill();
          // Messy bangs over forehead
          ctx.fillStyle = '#284030';
          ctx.beginPath();
          ctx.moveTo(14, HEAD_CY - 8);
          ctx.quadraticCurveTo(20, HEAD_CY - 2, 28, HEAD_CY - 6);
          ctx.quadraticCurveTo(36, HEAD_CY - 2, 42, HEAD_CY - 6);
          ctx.quadraticCurveTo(48, HEAD_CY - 2, 50, HEAD_CY - 8);
          ctx.lineTo(50, HEAD_CY - 10);
          ctx.lineTo(14, HEAD_CY - 10);
          ctx.fill();
          // Side hair
          ctx.fillStyle = '#2a3828';
          ctx.fillRect(10, HEAD_CY - 6, 6, 14);
          ctx.fillRect(48, HEAD_CY - 6, 6, 14);
        },
        drawOutfit: (ctx) => {
          // Hoodie
          ctx.fillStyle = '#3a4838';
          ctx.fillRect(18, BODY_TOP + 2, 28, BODY_BOT - BODY_TOP - 6);
          // Hood drawstrings
          ctx.strokeStyle = '#4a5848';
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(28, BODY_TOP + 4); ctx.lineTo(26, BODY_TOP + 18); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(36, BODY_TOP + 4); ctx.lineTo(38, BODY_TOP + 18); ctx.stroke();
          // Pocket
          ctx.fillStyle = '#344438';
          ctx.fillRect(22, BODY_TOP + 22, 20, 10);
          ctx.strokeStyle = '#2a3828';
          ctx.strokeRect(22, BODY_TOP + 22, 20, 10);
        },
      },
    };

    for (const [charId, charData] of Object.entries(CHARACTERS)) {
      const vis = charVisuals[charId];
      if (!vis) continue;

      const canvas = this.textures.createCanvas('char_' + charId, W, H);
      const ctx = canvas.getContext();

      const r = (charData.color >> 16) & 0xff;
      const g = (charData.color >> 8) & 0xff;
      const b = charData.color & 0xff;

      // Shadow
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.beginPath();
      ctx.ellipse(HEAD_CX, H - 4, 16, 4, 0, 0, Math.PI * 2);
      ctx.fill();

      // === BODY ===
      const bodyW = 28;
      const bodyX = (W - bodyW) / 2;
      const bodyH = BODY_BOT - BODY_TOP;

      // Legs (drawn first, behind body)
      ctx.fillStyle = '#2a2030';
      ctx.fillRect(bodyX + 4, BODY_BOT - 10, 8, 12);
      ctx.fillRect(bodyX + bodyW - 12, BODY_BOT - 10, 8, 12);
      // Shoes
      ctx.fillStyle = '#3a2838';
      ctx.beginPath(); ctx.arc(bodyX + 8, BODY_BOT + 1, 5, 0, Math.PI); ctx.fill();
      ctx.beginPath(); ctx.arc(bodyX + bodyW - 8, BODY_BOT + 1, 5, 0, Math.PI); ctx.fill();

      // Main body shape
      const mR = Math.floor(r * 0.6);
      const mG = Math.floor(g * 0.6);
      const mB = Math.floor(b * 0.6);
      ctx.fillStyle = `rgb(${mR},${mG},${mB})`;
      ctx.beginPath();
      ctx.moveTo(bodyX, BODY_TOP + 6);
      ctx.quadraticCurveTo(bodyX, BODY_TOP, bodyX + 6, BODY_TOP);
      ctx.lineTo(bodyX + bodyW - 6, BODY_TOP);
      ctx.quadraticCurveTo(bodyX + bodyW, BODY_TOP, bodyX + bodyW, BODY_TOP + 6);
      ctx.lineTo(bodyX + bodyW, BODY_BOT - 6);
      ctx.quadraticCurveTo(bodyX + bodyW, BODY_BOT - 2, bodyX + bodyW - 4, BODY_BOT - 2);
      ctx.lineTo(bodyX + 4, BODY_BOT - 2);
      ctx.quadraticCurveTo(bodyX, BODY_BOT - 2, bodyX, BODY_BOT - 6);
      ctx.closePath();
      ctx.fill();

      // Arms
      const aR = Math.floor(r * 0.5);
      const aG = Math.floor(g * 0.5);
      const aB = Math.floor(b * 0.5);
      ctx.fillStyle = `rgb(${aR},${aG},${aB})`;
      // Left arm
      ctx.beginPath();
      ctx.moveTo(bodyX - 2, BODY_TOP + 4);
      ctx.quadraticCurveTo(bodyX - 8, BODY_TOP + 10, bodyX - 6, BODY_BOT - 14);
      ctx.quadraticCurveTo(bodyX - 4, BODY_BOT - 8, bodyX + 2, BODY_BOT - 12);
      ctx.fill();
      // Right arm
      ctx.beginPath();
      ctx.moveTo(bodyX + bodyW + 2, BODY_TOP + 4);
      ctx.quadraticCurveTo(bodyX + bodyW + 8, BODY_TOP + 10, bodyX + bodyW + 6, BODY_BOT - 14);
      ctx.quadraticCurveTo(bodyX + bodyW + 4, BODY_BOT - 8, bodyX + bodyW - 2, BODY_BOT - 12);
      ctx.fill();
      // Hands (skin colored circles)
      ctx.fillStyle = vis.skinOverride || SKIN_SHADOW;
      ctx.beginPath(); ctx.arc(bodyX - 5, BODY_BOT - 12, 3, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(bodyX + bodyW + 5, BODY_BOT - 12, 3, 0, Math.PI * 2); ctx.fill();

      // Outfit details (character-specific)
      vis.drawOutfit(ctx, mR, mG, mB);

      // === HEAD ===
      const skinColor = vis.skinOverride || SKIN;
      // Neck
      ctx.fillStyle = skinColor;
      ctx.fillRect(HEAD_CX - 5, HEAD_CY + 16, 10, 10);
      // Head shape
      ctx.fillStyle = skinColor;
      ctx.beginPath();
      ctx.ellipse(HEAD_CX, HEAD_CY, HEAD_RX, HEAD_RY, 0, 0, Math.PI * 2);
      ctx.fill();
      // Subtle shadow on side of face
      ctx.fillStyle = vis.skinOverride ? 'rgba(0,0,0,0.06)' : 'rgba(0,0,0,0.05)';
      ctx.beginPath();
      ctx.ellipse(HEAD_CX + 10, HEAD_CY + 4, 12, 18, 0.2, 0, Math.PI * 2);
      ctx.fill();
      // Ears
      ctx.fillStyle = skinColor;
      ctx.beginPath(); ctx.ellipse(HEAD_CX - HEAD_RX + 2, HEAD_CY + 2, 4, 6, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(HEAD_CX + HEAD_RX - 2, HEAD_CY + 2, 4, 6, 0, 0, Math.PI * 2); ctx.fill();

      // === HAIR (character-specific, drawn over head) ===
      vis.drawHair(ctx);

      // === FACE ===
      // Eyes — big, expressive, yami kawaii style
      const eyeY = HEAD_CY + 2;
      const leftEyeX = HEAD_CX - 8;
      const rightEyeX = HEAD_CX + 8;
      const eyeRX = 6, eyeRY = 7;

      for (const ex of [leftEyeX, rightEyeX]) {
        // White
        ctx.fillStyle = '#ece4e8';
        ctx.beginPath(); ctx.ellipse(ex, eyeY, eyeRX, eyeRY, 0, 0, Math.PI * 2); ctx.fill();

        // Upper eyelid shadow
        ctx.fillStyle = 'rgba(60,40,50,0.15)';
        ctx.beginPath(); ctx.ellipse(ex, eyeY - 3, eyeRX, 3, 0, Math.PI, 0); ctx.fill();

        // Iris
        ctx.fillStyle = charData.colorHex;
        const irisX = ex + (ex < HEAD_CX ? 1 : -1);
        ctx.beginPath(); ctx.ellipse(irisX, eyeY + 1, 4.5, 5.5, 0, 0, Math.PI * 2); ctx.fill();

        // Pupil
        ctx.fillStyle = '#1a1020';
        ctx.beginPath(); ctx.ellipse(irisX, eyeY + 2, 2.5, 3.5, 0, 0, Math.PI * 2); ctx.fill();

        // Main highlight
        ctx.fillStyle = '#ffffff';
        ctx.beginPath(); ctx.arc(ex - 2, eyeY - 2, 2, 0, Math.PI * 2); ctx.fill();

        // Secondary small highlight
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.beginPath(); ctx.arc(irisX + 2, eyeY + 3, 1, 0, Math.PI * 2); ctx.fill();

        // Pink reflection (yami kawaii touch)
        ctx.fillStyle = 'rgba(200,120,152,0.25)';
        ctx.beginPath(); ctx.arc(irisX + 1, eyeY + 4, 1.2, 0, Math.PI * 2); ctx.fill();

        // Subtle top lash line
        ctx.strokeStyle = 'rgba(40,20,30,0.5)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.ellipse(ex, eyeY, eyeRX + 0.5, eyeRY + 0.5, 0, Math.PI + 0.3, -0.3);
        ctx.stroke();
      }

      // Eyebrows — subtle, character-specific later
      ctx.strokeStyle = 'rgba(60,40,50,0.3)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(leftEyeX - 4, eyeY - 9); ctx.quadraticCurveTo(leftEyeX, eyeY - 11, leftEyeX + 5, eyeY - 9); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(rightEyeX - 5, eyeY - 9); ctx.quadraticCurveTo(rightEyeX, eyeY - 11, rightEyeX + 4, eyeY - 9); ctx.stroke();

      // Nose — tiny
      ctx.fillStyle = SKIN_SHADOW;
      ctx.beginPath(); ctx.arc(HEAD_CX, HEAD_CY + 8, 1.5, 0, Math.PI * 2); ctx.fill();

      // Mouth — small, slightly melancholy
      ctx.strokeStyle = '#b09090';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(HEAD_CX - 4, HEAD_CY + 13);
      ctx.quadraticCurveTo(HEAD_CX, HEAD_CY + 14, HEAD_CX + 4, HEAD_CY + 13);
      ctx.stroke();

      // Blush — subtle pink ovals
      ctx.fillStyle = 'rgba(200, 120, 140, 0.15)';
      ctx.beginPath(); ctx.ellipse(leftEyeX - 4, eyeY + 8, 5, 3, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(rightEyeX + 4, eyeY + 8, 5, 3, 0, 0, Math.PI * 2); ctx.fill();

      canvas.refresh();
    }
  }


  _generateTilemap() {
    const cols = GAME_CONFIG.MAP_COLS;
    const rows = GAME_CONFIG.MAP_ROWS;
    const GRASS = 0, PATH = 1, FLOOR = 2, WALL = 3, FOREST = 4, WATER = 5;

    const ground = Array.from({ length: rows }, () => Array(cols).fill(GRASS));
    const collision = Array.from({ length: rows }, () => Array(cols).fill(0));

    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (x < 3 || x >= cols - 3 || y < 2 || y >= rows - 2) {
          ground[y][x] = FOREST;
          collision[y][x] = 1;
        }
      }
    }

    const setTile = (x, y, type, solid) => {
      if (y >= 0 && y < rows && x >= 0 && x < cols) {
        ground[y][x] = type;
        collision[y][x] = solid ? 1 : 0;
      }
    };

    for (const b of BUILDINGS) {
      const zone = getBuildingZone(b.id);
      if (!zone) continue;
      for (let dy = 0; dy < zone.h; dy++)
        for (let dx = 0; dx < zone.w; dx++)
          setTile(zone.x + dx, zone.y + dy, FLOOR, false);
      for (let dx = 0; dx < zone.w; dx++) { setTile(zone.x + dx, zone.y, WALL, true); setTile(zone.x + dx, zone.y + zone.h - 1, WALL, true); }
      for (let dy = 0; dy < zone.h; dy++) { setTile(zone.x, zone.y + dy, WALL, true); setTile(zone.x + zone.w - 1, zone.y + dy, WALL, true); }
      const midX = zone.x + Math.floor(zone.w / 2) - 1;
      const midY = zone.y + Math.floor(zone.h / 2) - 1;
      setTile(midX, zone.y, FLOOR, false); setTile(midX + 1, zone.y, FLOOR, false);
      setTile(midX, zone.y + zone.h - 1, FLOOR, false); setTile(midX + 1, zone.y + zone.h - 1, FLOOR, false);
      setTile(zone.x, midY, FLOOR, false); setTile(zone.x, midY + 1, FLOOR, false);
      setTile(zone.x + zone.w - 1, midY, FLOOR, false); setTile(zone.x + zone.w - 1, midY + 1, FLOOR, false);
    }

    for (const b of BUILDINGS) {
      const zone = getBuildingZone(b.id);
      if (!zone) continue;
      if (b.col < 2) {
        const rightB = BUILDINGS.find((rb) => rb.row === b.row && rb.col === b.col + 1);
        if (rightB) {
          const rZone = getBuildingZone(rightB.id);
          const midY = zone.y + Math.floor(zone.h / 2) - 1;
          for (let x = zone.x + zone.w; x < rZone.x; x++) { setTile(x, midY, PATH, false); setTile(x, midY + 1, PATH, false); }
        }
      }
      if (b.row < 2) {
        const bottomB = BUILDINGS.find((bb) => bb.row === b.row + 1 && bb.col === b.col);
        if (bottomB) {
          const bZone = getBuildingZone(bottomB.id);
          const midX = zone.x + Math.floor(zone.w / 2) - 1;
          for (let y = zone.y + zone.h; y < bZone.y; y++) { setTile(midX, y, PATH, false); setTile(midX + 1, y, PATH, false); }
        }
      }
    }

    this.registry.set('mapGround', ground);
    this.registry.set('mapCollision', collision);
  }

  _generateUITextures() {
    const dbW = GAME_CONFIG.WIDTH - 64;
    const dbH = 256;
    const dialog = this.textures.createCanvas('textbox', dbW, dbH);
    const dCtx = dialog.getContext();

    dCtx.fillStyle = 'rgba(26, 21, 32, 0.95)';
    dCtx.beginPath(); dCtx.roundRect(0, 0, dbW, dbH, 12); dCtx.fill();

    dCtx.strokeStyle = 'rgba(200, 120, 152, 0.4)';
    dCtx.lineWidth = 2;
    dCtx.beginPath(); dCtx.roundRect(2, 2, dbW - 4, dbH - 4, 10); dCtx.stroke();

    dCtx.strokeStyle = 'rgba(200, 120, 152, 0.1)';
    dCtx.lineWidth = 1;
    dCtx.beginPath(); dCtx.roundRect(8, 8, dbW - 16, dbH - 16, 8); dCtx.stroke();

    dialog.refresh();

    const notif = this.textures.createCanvas('notif_icon', 32, 32);
    const nCtx = notif.getContext();
    nCtx.fillStyle = '#c87898';
    nCtx.beginPath(); nCtx.arc(16, 16, 12, 0, Math.PI * 2); nCtx.fill();
    nCtx.fillStyle = '#1a1520';
    nCtx.font = "bold 18px 'M PLUS Rounded 1c', sans-serif";
    nCtx.textAlign = 'center';
    nCtx.textBaseline = 'middle';
    nCtx.fillText('!', 16, 16);
    notif.refresh();
  }
}
