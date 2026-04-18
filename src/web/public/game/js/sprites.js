/**
 * LAINTOWN GAME — Chibi Character Sprites (Yami Kawaii)
 * Detailed procedural chibi sprites with skin, hair, outfits, and expressive eyes.
 * Each character has unique hair style, outfit, and accessories.
 */

let skinSpriteConfig = null;

// Called externally to update sprite colors from skin
window.setSpritesSkinConfig = function(config) {
  skinSpriteConfig = config;
};

// Get a skin-overridden property for a character
function getSkinProp(charId, prop, fallback) {
  if (skinSpriteConfig?.characters?.[charId]?.[prop] !== undefined) {
    return skinSpriteConfig.characters[charId][prop];
  }
  if (skinSpriteConfig?.[prop] !== undefined) {
    return skinSpriteConfig[prop];
  }
  return fallback;
}

function getSkinTone(charId) {
  return getSkinProp(charId, 'skinTone', '#dcc8c0');
}

function getSkinShadow(charId) {
  return getSkinProp(charId, 'skinShadow', '#c8b0a8');
}

function renderPixelSprites(scene) {
  const W = GAME_CONFIG.SPRITE_W;  // 64
  const H = GAME_CONFIG.SPRITE_H;  // 96

  // Chibi proportions: big head, small body
  const HEAD_CX = W / 2;
  const HEAD_CY = 26;
  const HEAD_RX = 20;
  const HEAD_RY = 22;
  const BODY_TOP = 46;
  const BODY_BOT = H - 8;

  // Per-character visual config
  const charVisuals = {
    'lain': {
      hairColor: '#3a2040', hairLight: '#4a2850',
      outfit: '#484058', outfitAccent: '#5a5068',
      drawHair: (ctx, charId) => {
        // Signature helmet bob
        ctx.fillStyle = getSkinProp(charId, 'hairColor', '#3a2040');
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
        ctx.fillStyle = getSkinProp(charId, 'hairLight', '#4a2850');
        ctx.beginPath();
        ctx.moveTo(12, HEAD_CY - 10);
        ctx.quadraticCurveTo(HEAD_CX, HEAD_CY - 4, 52, HEAD_CY - 10);
        ctx.lineTo(52, HEAD_CY - 2);
        ctx.quadraticCurveTo(HEAD_CX, HEAD_CY + 4, 12, HEAD_CY - 2);
        ctx.fill();
        // Hair clip — small X mark
        ctx.strokeStyle = getSkinProp(charId, 'accentColor', '#c87898');
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(46, HEAD_CY); ctx.lineTo(50, HEAD_CY + 4); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(50, HEAD_CY); ctx.lineTo(46, HEAD_CY + 4); ctx.stroke();
      },
      drawOutfit: (ctx, mR, mG, mB, charId) => {
        // School uniform — dark top with collar
        ctx.fillStyle = getSkinProp(charId, 'outfitColor', '#484058');
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
      drawHair: (ctx, charId) => {
        // Long flowing hair — ethereal
        ctx.fillStyle = getSkinProp(charId, 'hairColor', '#283858');
        ctx.beginPath();
        ctx.ellipse(HEAD_CX, HEAD_CY - 8, 23, 18, 0, Math.PI, 0);
        ctx.fill();
        // Long flowing sides past body
        ctx.fillRect(6, HEAD_CY - 6, 8, 46);
        ctx.fillRect(50, HEAD_CY - 6, 8, 46);
        // Wispy tips at different lengths
        ctx.fillStyle = getSkinProp(charId, 'outfitColor', '#304060');
        ctx.beginPath(); ctx.arc(10, HEAD_CY + 38, 4, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(54, HEAD_CY + 40, 4, 0, Math.PI * 2); ctx.fill();
        // Extra wisps
        ctx.fillRect(4, HEAD_CY + 30, 4, 14);
        ctx.fillRect(56, HEAD_CY + 28, 4, 16);
        // Bangs — lighter, parted slightly
        ctx.fillStyle = getSkinProp(charId, 'hairLight', '#384868');
        ctx.fillRect(14, HEAD_CY - 12, 15, 10);
        ctx.fillRect(33, HEAD_CY - 12, 17, 10);
        // Faint glow on hair tips
        ctx.fillStyle = 'rgba(104,152,200,0.15)';
        ctx.beginPath(); ctx.arc(10, HEAD_CY + 38, 6, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(54, HEAD_CY + 40, 6, 0, Math.PI * 2); ctx.fill();
      },
      drawOutfit: (ctx, mR, mG, mB, charId) => {
        // Flowing dark top
        ctx.fillStyle = getSkinProp(charId, 'outfitColor', '#304050');
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
      outfit: '#4a4040', outfitAccent: '#5a5050',
      drawHair: (ctx, charId) => {
        // Thinning/receding — balding top with sides
        ctx.fillStyle = getSkinProp(charId, 'hairColor', '#3a2838');
        ctx.fillRect(10, HEAD_CY - 10, 8, 16);
        ctx.fillRect(46, HEAD_CY - 10, 8, 16);
        // Thin top
        ctx.fillStyle = getSkinProp(charId, 'hairLight', '#4a3848');
        ctx.fillRect(18, HEAD_CY - 16, 28, 5);
        // Messy wispy bits
        ctx.fillRect(14, HEAD_CY - 14, 4, 6);
        ctx.fillRect(44, HEAD_CY - 14, 4, 6);
        // Glasses
        ctx.strokeStyle = getSkinProp(charId, 'accentColor', '#887878');
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
      drawOutfit: (ctx, mR, mG, mB, charId) => {
        // Rumpled jacket
        ctx.fillStyle = getSkinProp(charId, 'outfitColor', '#4a4040');
        ctx.fillRect(18, BODY_TOP + 2, 28, BODY_BOT - BODY_TOP - 6);
        // Open jacket line
        ctx.strokeStyle = '#3a3030';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(HEAD_CX, BODY_TOP + 2);
        ctx.lineTo(HEAD_CX, BODY_BOT - 6);
        ctx.stroke();
        // Undershirt hint
        ctx.fillStyle = getSkinProp(charId, 'accentColor', '#685858');
        ctx.fillRect(29, BODY_TOP + 4, 6, 12);
      },
    },
    'mckenna': {
      hairColor: '#2a3020', hairLight: '#3a4030',
      outfit: '#3a4838', outfitAccent: '#4a5848',
      drawHair: (ctx, charId) => {
        // Big bushy curly hair + beard
        ctx.fillStyle = getSkinProp(charId, 'hairColor', '#2a3020');
        // Main volume — huge!
        ctx.beginPath();
        ctx.ellipse(HEAD_CX, HEAD_CY - 10, 26, 20, 0, 0, Math.PI * 2);
        ctx.fill();
        // Extra volume sides
        ctx.beginPath(); ctx.arc(6, HEAD_CY - 2, 10, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(58, HEAD_CY - 2, 10, 0, Math.PI * 2); ctx.fill();
        // Curly texture blobs
        ctx.fillStyle = getSkinProp(charId, 'hairLight', '#343828');
        for (let i = 0; i < 10; i++) {
          const cx = 10 + Math.random() * 44;
          const cy = HEAD_CY - 20 + Math.random() * 16;
          ctx.beginPath(); ctx.arc(cx, cy, 3 + Math.random() * 3, 0, Math.PI * 2); ctx.fill();
        }
        // Beard
        ctx.fillStyle = getSkinProp(charId, 'hairColor', '#2a3020');
        ctx.beginPath();
        ctx.moveTo(20, HEAD_CY + 10);
        ctx.quadraticCurveTo(HEAD_CX, HEAD_CY + 24, 44, HEAD_CY + 10);
        ctx.fill();
        // Mustache
        ctx.fillStyle = getSkinProp(charId, 'hairLight', '#343828');
        ctx.beginPath();
        ctx.ellipse(HEAD_CX, HEAD_CY + 10, 10, 4, 0, 0, Math.PI);
        ctx.fill();
      },
      drawOutfit: (ctx, mR, mG, mB, charId) => {
        // Earthy/hemp shirt
        ctx.fillStyle = getSkinProp(charId, 'outfitColor', '#3a4838');
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
      drawHair: (ctx, charId) => {
        // Short, clean, no-nonsense
        ctx.fillStyle = getSkinProp(charId, 'hairColor', '#3a2e20');
        // Tight to head
        ctx.beginPath();
        ctx.ellipse(HEAD_CX, HEAD_CY - 10, 19, 14, 0, Math.PI, 0);
        ctx.fill();
        // Short sides
        ctx.fillRect(12, HEAD_CY - 8, 5, 10);
        ctx.fillRect(47, HEAD_CY - 8, 5, 10);
        // Simple fringe
        ctx.fillStyle = getSkinProp(charId, 'hairLight', '#4a3e30');
        ctx.fillRect(16, HEAD_CY - 12, 32, 5);
      },
      drawOutfit: (ctx, mR, mG, mB, charId) => {
        // Plain t-shirt
        ctx.fillStyle = getSkinProp(charId, 'outfitColor', '#484048');
        ctx.fillRect(18, BODY_TOP + 2, 28, BODY_BOT - BODY_TOP - 6);
        // Crew neck
        ctx.strokeStyle = getSkinProp(charId, 'accentColor', '#585058');
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(HEAD_CX, BODY_TOP + 4, 8, 0, Math.PI);
        ctx.stroke();
      },
    },
    'dr-claude': {
      hairColor: '#302030', hairLight: '#402840',
      outfit: '#d8d0cc', outfitAccent: '#c8c0b8',
      drawHair: (ctx, charId) => {
        // Neat, parted professional hair
        ctx.fillStyle = getSkinProp(charId, 'hairColor', '#302030');
        ctx.beginPath();
        ctx.ellipse(HEAD_CX, HEAD_CY - 10, 20, 15, 0, Math.PI, 0);
        ctx.fill();
        ctx.fillRect(11, HEAD_CY - 8, 6, 14);
        ctx.fillRect(47, HEAD_CY - 8, 6, 14);
        // Part
        ctx.fillStyle = getSkinProp(charId, 'hairLight', '#402840');
        ctx.fillRect(16, HEAD_CY - 14, 14, 7);
        ctx.fillRect(32, HEAD_CY - 14, 16, 7);
        ctx.fillStyle = getSkinShadow(charId);
        ctx.fillRect(30, HEAD_CY - 13, 2, 6);
      },
      drawOutfit: (ctx, mR, mG, mB, charId) => {
        // White lab coat
        ctx.fillStyle = getSkinProp(charId, 'outfitColor', '#d8d0cc');
        ctx.fillRect(16, BODY_TOP + 2, 32, BODY_BOT - BODY_TOP - 4);
        // Coat opening
        ctx.strokeStyle = '#b8b0a8';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(HEAD_CX, BODY_TOP + 2);
        ctx.lineTo(HEAD_CX, BODY_BOT - 4);
        ctx.stroke();
        // Lapels
        ctx.strokeStyle = getSkinProp(charId, 'accentColor', '#c8c0b8');
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
      drawHair: (ctx, charId) => {
        // Tousled messy hair — soft spikes, not sharp
        ctx.fillStyle = getSkinProp(charId, 'hairColor', '#284030');
        // Base volume covering top of head
        ctx.beginPath();
        ctx.ellipse(HEAD_CX, HEAD_CY - 8, 22, 18, 0, Math.PI, 0);
        ctx.fill();
        // Fill sides
        ctx.fillRect(10, HEAD_CY - 10, 44, 8);
        // Soft tufts on top — individual rounded spikes
        ctx.fillStyle = getSkinProp(charId, 'hairColor', '#284030');
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
        ctx.fillStyle = getSkinProp(charId, 'hairLight', '#385040');
        ctx.beginPath();
        ctx.moveTo(26, HEAD_CY - 14);
        ctx.quadraticCurveTo(30, HEAD_CY - 24, 34, HEAD_CY - 14);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(16, HEAD_CY - 10);
        ctx.quadraticCurveTo(14, HEAD_CY - 18, 22, HEAD_CY - 10);
        ctx.fill();
        // Messy bangs over forehead
        ctx.fillStyle = getSkinProp(charId, 'hairColor', '#284030');
        ctx.beginPath();
        ctx.moveTo(14, HEAD_CY - 8);
        ctx.quadraticCurveTo(20, HEAD_CY - 2, 28, HEAD_CY - 6);
        ctx.quadraticCurveTo(36, HEAD_CY - 2, 42, HEAD_CY - 6);
        ctx.quadraticCurveTo(48, HEAD_CY - 2, 50, HEAD_CY - 8);
        ctx.lineTo(50, HEAD_CY - 10);
        ctx.lineTo(14, HEAD_CY - 10);
        ctx.fill();
        // Side hair
        ctx.fillStyle = getSkinProp(charId, 'hairColor', '#2a3828');
        ctx.fillRect(10, HEAD_CY - 6, 6, 14);
        ctx.fillRect(48, HEAD_CY - 6, 6, 14);
      },
      drawOutfit: (ctx, mR, mG, mB, charId) => {
        // Hoodie
        ctx.fillStyle = getSkinProp(charId, 'outfitColor', '#3a4838');
        ctx.fillRect(18, BODY_TOP + 2, 28, BODY_BOT - BODY_TOP - 6);
        // Hood drawstrings
        ctx.strokeStyle = getSkinProp(charId, 'accentColor', '#4a5848');
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
    'neo': {
      hairColor: '#1b1f26', hairLight: '#2c313b',
      outfit: '#151920', outfitAccent: '#2f6e58',
      drawHair: (ctx, charId) => {
        ctx.fillStyle = getSkinProp(charId, 'hairColor', '#1b1f26');
        ctx.beginPath();
        ctx.ellipse(HEAD_CX, HEAD_CY - 10, 20, 15, 0, Math.PI, 0);
        ctx.fill();
        ctx.fillRect(12, HEAD_CY - 8, 6, 12);
        ctx.fillRect(46, HEAD_CY - 8, 6, 12);
        ctx.fillStyle = getSkinProp(charId, 'hairLight', '#2c313b');
        ctx.fillRect(17, HEAD_CY - 12, 20, 4);
        ctx.beginPath();
        ctx.moveTo(36, HEAD_CY - 12);
        ctx.lineTo(46, HEAD_CY - 8);
        ctx.lineTo(34, HEAD_CY - 4);
        ctx.fill();
      },
      drawOutfit: (ctx, mR, mG, mB, charId) => {
        ctx.fillStyle = getSkinProp(charId, 'outfitColor', '#151920');
        ctx.fillRect(16, BODY_TOP + 1, 32, BODY_BOT - BODY_TOP - 4);
        ctx.strokeStyle = getSkinProp(charId, 'accentColor', '#2f6e58');
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(HEAD_CX, BODY_TOP + 2);
        ctx.lineTo(HEAD_CX, BODY_BOT - 6);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(HEAD_CX - 2, BODY_TOP + 3);
        ctx.lineTo(HEAD_CX - 7, BODY_TOP + 16);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(HEAD_CX + 2, BODY_TOP + 3);
        ctx.lineTo(HEAD_CX + 7, BODY_TOP + 16);
        ctx.stroke();
        ctx.fillStyle = '#0f1318';
        ctx.fillRect(27, BODY_TOP + 5, 10, 10);
      },
    },
    'plato': {
      hairColor: '#d6d0c0', hairLight: '#ece6d6',
      outfit: '#f1ead8', outfitAccent: '#c4a85a',
      drawHair: (ctx, charId) => {
        ctx.fillStyle = getSkinProp(charId, 'hairLight', '#ece6d6');
        ctx.beginPath();
        ctx.ellipse(HEAD_CX, HEAD_CY - 10, 18, 10, 0, Math.PI, 0);
        ctx.fill();
        ctx.fillRect(12, HEAD_CY - 8, 5, 10);
        ctx.fillRect(47, HEAD_CY - 8, 5, 10);
        ctx.fillStyle = getSkinProp(charId, 'hairColor', '#d6d0c0');
        ctx.beginPath();
        ctx.moveTo(20, HEAD_CY + 10);
        ctx.quadraticCurveTo(HEAD_CX, HEAD_CY + 25, 44, HEAD_CY + 10);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(HEAD_CX, HEAD_CY + 9, 9, 3.5, 0, 0, Math.PI);
        ctx.fill();
      },
      drawOutfit: (ctx, mR, mG, mB, charId) => {
        ctx.fillStyle = getSkinProp(charId, 'outfitColor', '#f1ead8');
        ctx.beginPath();
        ctx.moveTo(16, BODY_TOP + 2);
        ctx.lineTo(48, BODY_TOP + 2);
        ctx.lineTo(44, BODY_BOT - 2);
        ctx.lineTo(20, BODY_BOT - 2);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = getSkinProp(charId, 'accentColor', '#c4a85a');
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(23, BODY_TOP + 5);
        ctx.lineTo(23, BODY_BOT - 4);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(41, BODY_TOP + 5);
        ctx.lineTo(41, BODY_BOT - 4);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(HEAD_CX, BODY_TOP + 2);
        ctx.lineTo(HEAD_CX, BODY_BOT - 4);
        ctx.stroke();
      },
    },
    'joe': {
      hairColor: '#4a3326', hairLight: '#6b4b38',
      outfit: '#53606b', outfitAccent: '#6f8290',
      drawHair: (ctx, charId) => {
        ctx.fillStyle = getSkinProp(charId, 'hairColor', '#4a3326');
        ctx.beginPath();
        ctx.ellipse(HEAD_CX, HEAD_CY - 9, 19, 13, 0, Math.PI, 0);
        ctx.fill();
        ctx.fillRect(12, HEAD_CY - 7, 5, 9);
        ctx.fillRect(47, HEAD_CY - 7, 5, 9);
        ctx.fillStyle = getSkinProp(charId, 'hairLight', '#6b4b38');
        ctx.fillRect(18, HEAD_CY - 11, 28, 4);
      },
      drawOutfit: (ctx, mR, mG, mB, charId) => {
        ctx.fillStyle = getSkinProp(charId, 'outfitColor', '#53606b');
        ctx.fillRect(18, BODY_TOP + 2, 28, BODY_BOT - BODY_TOP - 6);
        ctx.strokeStyle = getSkinProp(charId, 'accentColor', '#6f8290');
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(HEAD_CX, BODY_TOP + 4, 8, 0, Math.PI);
        ctx.stroke();
        ctx.fillStyle = '#46505a';
        ctx.fillRect(24, BODY_TOP + 18, 16, 10);
      },
    },
  };

  for (const [charId, charData] of Object.entries(CHARACTERS)) {
    const vis = charVisuals[charId];
    if (!vis) continue;

    const canvas = scene.textures.createCanvas('char_' + charId, W, H);
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
    ctx.fillStyle = getSkinShadow(charId);
    ctx.beginPath(); ctx.arc(bodyX - 5, BODY_BOT - 12, 3, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(bodyX + bodyW + 5, BODY_BOT - 12, 3, 0, Math.PI * 2); ctx.fill();

    // Outfit details (character-specific)
    vis.drawOutfit(ctx, mR, mG, mB, charId);

    // === HEAD ===
    const skinColor = getSkinTone(charId);
    // Neck
    ctx.fillStyle = skinColor;
    ctx.fillRect(HEAD_CX - 5, HEAD_CY + 16, 10, 10);
    // Head shape
    ctx.fillStyle = skinColor;
    ctx.beginPath();
    ctx.ellipse(HEAD_CX, HEAD_CY, HEAD_RX, HEAD_RY, 0, 0, Math.PI * 2);
    ctx.fill();
    // Subtle shadow on side of face
    ctx.fillStyle = 'rgba(0,0,0,0.05)';
    ctx.beginPath();
    ctx.ellipse(HEAD_CX + 10, HEAD_CY + 4, 12, 18, 0.2, 0, Math.PI * 2);
    ctx.fill();
    // Ears
    ctx.fillStyle = skinColor;
    ctx.beginPath(); ctx.ellipse(HEAD_CX - HEAD_RX + 2, HEAD_CY + 2, 4, 6, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(HEAD_CX + HEAD_RX - 2, HEAD_CY + 2, 4, 6, 0, 0, Math.PI * 2); ctx.fill();

    // === HAIR (character-specific, drawn over head) ===
    vis.drawHair(ctx, charId);

    // === FACE ===
    // Eyes — big, expressive, yami kawaii style
    const eyeY = HEAD_CY + 2;
    const leftEyeX = HEAD_CX - 8;
    const rightEyeX = HEAD_CX + 8;
    const eyeRX = 6, eyeRY = 7;

    for (const ex of [leftEyeX, rightEyeX]) {
      // White
      ctx.fillStyle = getSkinProp(charId, 'eyeWhite', '#ece4e8');
      ctx.beginPath(); ctx.ellipse(ex, eyeY, eyeRX, eyeRY, 0, 0, Math.PI * 2); ctx.fill();

      // Upper eyelid shadow
      ctx.fillStyle = 'rgba(60,40,50,0.15)';
      ctx.beginPath(); ctx.ellipse(ex, eyeY - 3, eyeRX, 3, 0, Math.PI, 0); ctx.fill();

      // Iris
      ctx.fillStyle = charData.colorHex;
      const irisX = ex + (ex < HEAD_CX ? 1 : -1);
      ctx.beginPath(); ctx.ellipse(irisX, eyeY + 1, 4.5, 5.5, 0, 0, Math.PI * 2); ctx.fill();

      // Pupil
      ctx.fillStyle = getSkinProp(charId, 'pupil', '#1a1020');
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

    // Eyebrows — subtle
    ctx.strokeStyle = 'rgba(60,40,50,0.3)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(leftEyeX - 4, eyeY - 9); ctx.quadraticCurveTo(leftEyeX, eyeY - 11, leftEyeX + 5, eyeY - 9); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(rightEyeX - 5, eyeY - 9); ctx.quadraticCurveTo(rightEyeX, eyeY - 11, rightEyeX + 4, eyeY - 9); ctx.stroke();

    // Nose — tiny
    ctx.fillStyle = getSkinShadow(charId);
    ctx.beginPath(); ctx.arc(HEAD_CX, HEAD_CY + 8, 1.5, 0, Math.PI * 2); ctx.fill();

    // Mouth — small, slightly melancholy
    ctx.strokeStyle = getSkinProp(charId, 'mouth', '#b09090');
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
