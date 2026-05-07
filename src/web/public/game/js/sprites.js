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

  // Default visual config — used for all characters without custom overrides
  const defaultVisual = {
    hairColor: '#3a3030', hairLight: '#4a4040',
    outfit: '#404048', outfitAccent: '#505058',
    drawHair: (ctx, charId) => {
      ctx.fillStyle = getSkinProp(charId, 'hairColor', '#3a3030');
      ctx.beginPath();
      ctx.ellipse(HEAD_CX, HEAD_CY - 10, 20, 15, 0, Math.PI, 0);
      ctx.fill();
      ctx.fillRect(11, HEAD_CY - 8, 6, 12);
      ctx.fillRect(47, HEAD_CY - 8, 6, 12);
      ctx.fillStyle = getSkinProp(charId, 'hairLight', '#4a4040');
      ctx.fillRect(16, HEAD_CY - 14, 32, 6);
    },
    drawOutfit: (ctx, mR, mG, mB, charId) => {
      ctx.fillStyle = getSkinProp(charId, 'outfitColor', '#404048');
      ctx.fillRect(18, BODY_TOP + 2, 28, BODY_BOT - BODY_TOP - 6);
      ctx.strokeStyle = getSkinProp(charId, 'accentColor', '#505058');
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(HEAD_CX, BODY_TOP + 4, 8, 0, Math.PI);
      ctx.stroke();
    },
  };

  // Per-character visual config (custom overrides — populated by skin system or instance config)
  const charVisuals = {};

  for (const [charId, charData] of Object.entries(CHARACTERS)) {
    const vis = charVisuals[charId] || defaultVisual;

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
