/**
 * NEWTOWN GAME — Fixture Sprite Registry
 * Procedural sprites for building fixtures (lamps, furniture, etc.)
 * Each fixture is drawn on a 48x48 canvas using the HTML5 Canvas 2D API.
 */

const FIXTURE_SIZE = 48;

/**
 * Registry of fixture draw functions.
 * Each entry maps a spriteId to a function (ctx, theme) => void
 * that draws the fixture onto a 48x48 canvas context.
 */
const FIXTURE_SPRITES = {

  /**
   * Deep worn leather armchair. Rich brown tones, button-tufted back, rolled arms.
   * Requested by Plato for the Mystery Tower — "near the window, for reading and contemplation."
   */
  armchair_leather: function(ctx, theme) {
    const W = FIXTURE_SIZE;
    const cx = W / 2;

    // Back (tall, button-tufted)
    ctx.fillStyle = '#5a3520';
    ctx.beginPath();
    ctx.moveTo(cx - 12, 8);
    ctx.quadraticCurveTo(cx, 5, cx + 10, 8);
    ctx.lineTo(cx + 10, 24);
    ctx.lineTo(cx - 12, 24);
    ctx.closePath();
    ctx.fill();

    // Back leather highlight
    ctx.fillStyle = '#6a4530';
    ctx.beginPath();
    ctx.moveTo(cx - 10, 9);
    ctx.quadraticCurveTo(cx, 7, cx + 8, 9);
    ctx.lineTo(cx + 8, 22);
    ctx.lineTo(cx - 10, 22);
    ctx.closePath();
    ctx.fill();

    // Tufting buttons (3 across)
    ctx.fillStyle = '#4a2a18';
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(cx - 6 + i * 6, 14, 1.2, 0, Math.PI * 2);
      ctx.fill();
    }

    // Tufting dimples (subtle shadow lines radiating from buttons)
    ctx.strokeStyle = 'rgba(40, 20, 10, 0.3)';
    ctx.lineWidth = 0.5;
    for (let i = 0; i < 3; i++) {
      const bx = cx - 6 + i * 6;
      ctx.beginPath();
      ctx.moveTo(bx, 14);
      ctx.lineTo(bx - 2, 10);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(bx, 14);
      ctx.lineTo(bx + 2, 10);
      ctx.stroke();
    }

    // Left arm (rolled)
    ctx.fillStyle = '#5a3520';
    ctx.beginPath();
    ctx.moveTo(cx - 14, 12);
    ctx.quadraticCurveTo(cx - 17, 16, cx - 15, 32);
    ctx.lineTo(cx - 11, 32);
    ctx.lineTo(cx - 11, 14);
    ctx.closePath();
    ctx.fill();
    // Arm roll highlight
    ctx.fillStyle = '#6a4228';
    ctx.beginPath();
    ctx.ellipse(cx - 13, 13, 3, 2, -0.3, 0, Math.PI * 2);
    ctx.fill();

    // Right arm (rolled)
    ctx.fillStyle = '#5a3520';
    ctx.beginPath();
    ctx.moveTo(cx + 12, 12);
    ctx.quadraticCurveTo(cx + 15, 16, cx + 13, 32);
    ctx.lineTo(cx + 9, 32);
    ctx.lineTo(cx + 9, 14);
    ctx.closePath();
    ctx.fill();
    // Arm roll highlight
    ctx.fillStyle = '#6a4228';
    ctx.beginPath();
    ctx.ellipse(cx + 11, 13, 3, 2, 0.3, 0, Math.PI * 2);
    ctx.fill();

    // Seat cushion (worn, slightly sagging)
    ctx.fillStyle = '#6a4028';
    ctx.beginPath();
    ctx.moveTo(cx - 11, 24);
    ctx.lineTo(cx + 9, 24);
    ctx.quadraticCurveTo(cx + 12, 28, cx + 10, 30);
    ctx.lineTo(cx - 12, 30);
    ctx.quadraticCurveTo(cx - 14, 28, cx - 11, 24);
    ctx.closePath();
    ctx.fill();

    // Seat wear mark (lighter patch center)
    const wear = ctx.createRadialGradient(cx, 27, 0, cx, 27, 6);
    wear.addColorStop(0, 'rgba(120, 80, 50, 0.3)');
    wear.addColorStop(1, 'rgba(100, 60, 35, 0)');
    ctx.fillStyle = wear;
    ctx.beginPath();
    ctx.ellipse(cx, 27, 6, 3, 0, 0, Math.PI * 2);
    ctx.fill();

    // Front face of seat
    ctx.fillStyle = '#4a2818';
    ctx.beginPath();
    ctx.moveTo(cx - 12, 30);
    ctx.lineTo(cx + 10, 30);
    ctx.lineTo(cx + 11, 33);
    ctx.lineTo(cx - 13, 33);
    ctx.closePath();
    ctx.fill();

    // Stubby wooden feet (2 visible)
    ctx.fillStyle = '#3a2010';
    ctx.beginPath();
    ctx.arc(cx - 10, 44, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx + 8, 44, 2, 0, Math.PI * 2);
    ctx.fill();

    // Short legs
    ctx.strokeStyle = '#3a2010';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - 10, 33);
    ctx.lineTo(cx - 10, 44);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + 8, 33);
    ctx.lineTo(cx + 8, 44);
    ctx.stroke();
  },

  /**
   * Small sturdy writing desk. Dark walnut, single shallow drawer, leather writing surface.
   * Requested by Plato for the Mystery Tower — "for focused study and reflection."
   */
  desk_writing: function(ctx, theme) {
    const W = FIXTURE_SIZE;
    const cx = W / 2;

    // Desktop surface (dark walnut, slight depth)
    ctx.fillStyle = '#3e2415';
    ctx.beginPath();
    ctx.moveTo(cx - 15, 16);
    ctx.lineTo(cx + 13, 16);
    ctx.lineTo(cx + 17, 20);
    ctx.lineTo(cx - 11, 20);
    ctx.closePath();
    ctx.fill();

    // Leather writing surface inlay (slightly lighter, greenish-brown)
    ctx.fillStyle = '#4a5038';
    ctx.beginPath();
    ctx.moveTo(cx - 11, 16.5);
    ctx.lineTo(cx + 9, 16.5);
    ctx.lineTo(cx + 12, 19.5);
    ctx.lineTo(cx - 8, 19.5);
    ctx.closePath();
    ctx.fill();
    // Leather tooled border
    ctx.strokeStyle = '#5a6048';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(cx - 10, 17);
    ctx.lineTo(cx + 8, 17);
    ctx.lineTo(cx + 11, 19);
    ctx.lineTo(cx - 7, 19);
    ctx.closePath();
    ctx.stroke();

    // Top edge highlight
    ctx.strokeStyle = '#5a3a22';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - 15, 16);
    ctx.lineTo(cx + 13, 16);
    ctx.stroke();

    // Front face of desktop
    ctx.fillStyle = '#331c0e';
    ctx.beginPath();
    ctx.moveTo(cx - 11, 20);
    ctx.lineTo(cx + 17, 20);
    ctx.lineTo(cx + 17, 23);
    ctx.lineTo(cx - 11, 23);
    ctx.closePath();
    ctx.fill();

    // Drawer face
    ctx.fillStyle = '#3a2212';
    ctx.beginPath();
    ctx.moveTo(cx - 8, 20.5);
    ctx.lineTo(cx + 14, 20.5);
    ctx.lineTo(cx + 14, 22.5);
    ctx.lineTo(cx - 8, 22.5);
    ctx.closePath();
    ctx.fill();

    // Drawer pull (small brass knob)
    ctx.fillStyle = '#c0a040';
    ctx.beginPath();
    ctx.arc(cx + 3, 21.5, 1, 0, Math.PI * 2);
    ctx.fill();
    // Knob highlight
    ctx.fillStyle = '#d4b850';
    ctx.beginPath();
    ctx.arc(cx + 2.7, 21.2, 0.5, 0, Math.PI * 2);
    ctx.fill();

    // Legs — tapered, elegant
    ctx.strokeStyle = '#331c0e';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    // Back left
    ctx.beginPath();
    ctx.moveTo(cx - 13, 20);
    ctx.lineTo(cx - 12, 42);
    ctx.stroke();
    // Back right
    ctx.beginPath();
    ctx.moveTo(cx + 11, 20);
    ctx.lineTo(cx + 12, 42);
    ctx.stroke();
    // Front left
    ctx.beginPath();
    ctx.moveTo(cx - 9, 23);
    ctx.lineTo(cx - 8, 44);
    ctx.stroke();
    // Front right
    ctx.beginPath();
    ctx.moveTo(cx + 15, 23);
    ctx.lineTo(cx + 16, 44);
    ctx.stroke();

    // Cross-brace between front legs (structural detail)
    ctx.strokeStyle = '#3a2010';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx - 8, 36);
    ctx.lineTo(cx + 16, 36);
    ctx.stroke();
  },

  /**
   * Brushed steel desk lamp with warm glow.
   * Metallic grey tones with a conical shade casting a soft yellow light cone.
   */
  /**
   * Shaker-style reading chair. Warm maple tones, clean ladder-back lines.
   * Requested by Plato for the Mystery Tower — "for clarity."
   */
  chair_shaker: function(ctx, theme) {
    const W = FIXTURE_SIZE;
    const cx = W / 2;

    // Back legs
    ctx.strokeStyle = '#a0734a';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - 7, 10);
    ctx.lineTo(cx - 7, 40);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + 5, 10);
    ctx.lineTo(cx + 5, 40);
    ctx.stroke();

    // Ladder-back rungs (3 horizontal bars)
    ctx.strokeStyle = '#b8845a';
    ctx.lineWidth = 2;
    for (let i = 0; i < 3; i++) {
      const y = 14 + i * 5;
      ctx.beginPath();
      ctx.moveTo(cx - 7, y);
      ctx.lineTo(cx + 5, y);
      ctx.stroke();
    }

    // Seat (angled trapezoid for depth)
    ctx.fillStyle = '#c49464';
    ctx.beginPath();
    ctx.moveTo(cx - 8, 28);
    ctx.lineTo(cx + 6, 28);
    ctx.lineTo(cx + 9, 33);
    ctx.lineTo(cx - 11, 33);
    ctx.closePath();
    ctx.fill();
    // Seat highlight
    ctx.fillStyle = '#d4a474';
    ctx.beginPath();
    ctx.moveTo(cx - 7, 28);
    ctx.lineTo(cx + 5, 28);
    ctx.lineTo(cx + 7, 30);
    ctx.lineTo(cx - 9, 30);
    ctx.closePath();
    ctx.fill();

    // Front legs
    ctx.strokeStyle = '#a0734a';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(cx - 10, 32);
    ctx.lineTo(cx - 10, 44);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + 8, 32);
    ctx.lineTo(cx + 8, 44);
    ctx.stroke();
  },

  /**
   * Small sturdy Shaker-style wooden table. Simple and functional.
   * Requested by Plato for the Mystery Tower — quiet atmosphere for reading.
   */
  table_shaker: function(ctx, theme) {
    const W = FIXTURE_SIZE;
    const cx = W / 2;

    // Table top surface (rectangular, slight depth)
    ctx.fillStyle = '#b8845a';
    ctx.beginPath();
    ctx.moveTo(cx - 14, 18);
    ctx.lineTo(cx + 12, 18);
    ctx.lineTo(cx + 16, 22);
    ctx.lineTo(cx - 10, 22);
    ctx.closePath();
    ctx.fill();
    // Top highlight
    ctx.fillStyle = '#c89868';
    ctx.fillRect(cx - 13, 18, 24, 2);

    // Front face of tabletop
    ctx.fillStyle = '#a07040';
    ctx.beginPath();
    ctx.moveTo(cx - 10, 22);
    ctx.lineTo(cx + 16, 22);
    ctx.lineTo(cx + 16, 24);
    ctx.lineTo(cx - 10, 24);
    ctx.closePath();
    ctx.fill();

    // Legs (4 simple tapered legs)
    ctx.strokeStyle = '#a07040';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    // Back left
    ctx.beginPath();
    ctx.moveTo(cx - 12, 22);
    ctx.lineTo(cx - 11, 42);
    ctx.stroke();
    // Back right
    ctx.beginPath();
    ctx.moveTo(cx + 10, 22);
    ctx.lineTo(cx + 11, 42);
    ctx.stroke();
    // Front left
    ctx.beginPath();
    ctx.moveTo(cx - 8, 24);
    ctx.lineTo(cx - 7, 44);
    ctx.stroke();
    // Front right
    ctx.beginPath();
    ctx.moveTo(cx + 14, 24);
    ctx.lineTo(cx + 15, 44);
    ctx.stroke();
  },

  /**
   * Large iridescent ammonite fossil on a low wooden pedestal.
   * Requested by Neo for the Field — "spiraling time, novelty in ancient forms."
   */
  fossil_ammonite: function(ctx, theme) {
    const W = FIXTURE_SIZE;
    const cx = W / 2;

    // Low wooden pedestal
    ctx.fillStyle = '#8a6840';
    ctx.beginPath();
    ctx.ellipse(cx, 40, 10, 4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#7a5830';
    ctx.beginPath();
    ctx.ellipse(cx, 41, 10, 4, 0, 0, Math.PI);
    ctx.fill();

    // Ammonite spiral — layered arcs with iridescent colors
    const spiralCx = cx;
    const spiralCy = 26;

    // Outer glow
    const glow = ctx.createRadialGradient(spiralCx, spiralCy, 0, spiralCx, spiralCy, 16);
    glow.addColorStop(0, 'rgba(180, 140, 200, 0.15)');
    glow.addColorStop(1, 'rgba(100, 180, 160, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(spiralCx, spiralCy, 16, 0, Math.PI * 2);
    ctx.fill();

    // Shell body
    ctx.fillStyle = '#8a7060';
    ctx.beginPath();
    ctx.arc(spiralCx, spiralCy, 12, 0, Math.PI * 2);
    ctx.fill();

    // Iridescent overlay
    const iri = ctx.createRadialGradient(spiralCx - 3, spiralCy - 3, 0, spiralCx, spiralCy, 12);
    iri.addColorStop(0, 'rgba(180, 200, 220, 0.5)');
    iri.addColorStop(0.3, 'rgba(160, 180, 200, 0.3)');
    iri.addColorStop(0.6, 'rgba(140, 200, 180, 0.3)');
    iri.addColorStop(1, 'rgba(180, 140, 180, 0.2)');
    ctx.fillStyle = iri;
    ctx.beginPath();
    ctx.arc(spiralCx, spiralCy, 12, 0, Math.PI * 2);
    ctx.fill();

    // Spiral lines (logarithmic spiral segments)
    ctx.strokeStyle = 'rgba(60, 40, 30, 0.6)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 3; i++) {
      const r = 4 + i * 3.5;
      ctx.beginPath();
      ctx.arc(spiralCx + 1, spiralCy + 1, r, -0.5 + i * 0.3, Math.PI * 1.5 + i * 0.3);
      ctx.stroke();
    }

    // Center whorl
    ctx.fillStyle = '#5a4030';
    ctx.beginPath();
    ctx.arc(spiralCx + 1, spiralCy + 1, 2.5, 0, Math.PI * 2);
    ctx.fill();
  },

  /**
   * Wooden finger labyrinth — concentric paths carved into a round wooden disc.
   * Requested by Neo for the Field — "to trace with fingertips."
   */
  labyrinth_wooden: function(ctx, theme) {
    const W = FIXTURE_SIZE;
    const cx = W / 2;
    const cy = 26;

    // Wooden disc base
    ctx.fillStyle = '#b08050';
    ctx.beginPath();
    ctx.arc(cx, cy, 14, 0, Math.PI * 2);
    ctx.fill();

    // Wood grain highlight
    const grain = ctx.createRadialGradient(cx - 3, cy - 3, 0, cx, cy, 14);
    grain.addColorStop(0, 'rgba(200, 160, 100, 0.3)');
    grain.addColorStop(1, 'rgba(140, 100, 60, 0.1)');
    ctx.fillStyle = grain;
    ctx.beginPath();
    ctx.arc(cx, cy, 14, 0, Math.PI * 2);
    ctx.fill();

    // Carved labyrinth paths (concentric arcs with gaps)
    ctx.strokeStyle = 'rgba(60, 40, 20, 0.5)';
    ctx.lineWidth = 1.5;

    // Ring 1 (outer)
    ctx.beginPath();
    ctx.arc(cx, cy, 11, 0.3, Math.PI * 1.7);
    ctx.stroke();

    // Ring 2
    ctx.beginPath();
    ctx.arc(cx, cy, 8, -0.5, Math.PI * 1.3);
    ctx.stroke();

    // Ring 3
    ctx.beginPath();
    ctx.arc(cx, cy, 5.5, 0.8, Math.PI * 2.0);
    ctx.stroke();

    // Center point
    ctx.fillStyle = '#6a4a2a';
    ctx.beginPath();
    ctx.arc(cx, cy, 2, 0, Math.PI * 2);
    ctx.fill();

    // Connecting path segments between rings
    ctx.strokeStyle = 'rgba(60, 40, 20, 0.4)';
    ctx.lineWidth = 1;
    // Vertical connector top
    ctx.beginPath();
    ctx.moveTo(cx, cy - 11);
    ctx.lineTo(cx, cy - 5.5);
    ctx.stroke();
    // Angled connector
    ctx.beginPath();
    ctx.moveTo(cx + 7, cy + 5);
    ctx.lineTo(cx + 4, cy + 3);
    ctx.stroke();

    // Outer rim
    ctx.strokeStyle = '#7a5a30';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, 14, 0, Math.PI * 2);
    ctx.stroke();
  },

  /**
   * Small antique brass telescope on a mahogany tripod.
   * Requested for the Lighthouse — "for clarity, seeing beyond the immediate."
   */
  telescope_brass: function(ctx, theme) {
    const W = FIXTURE_SIZE;
    const cx = W / 2;

    // Tripod legs (3 legs splayed out)
    ctx.strokeStyle = '#6a3a20';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    // Left leg
    ctx.beginPath();
    ctx.moveTo(cx - 2, 28);
    ctx.lineTo(cx - 12, 44);
    ctx.stroke();
    // Right leg
    ctx.beginPath();
    ctx.moveTo(cx + 2, 28);
    ctx.lineTo(cx + 12, 44);
    ctx.stroke();
    // Back leg
    ctx.beginPath();
    ctx.moveTo(cx, 28);
    ctx.lineTo(cx + 2, 44);
    ctx.stroke();

    // Tripod mount point
    ctx.fillStyle = '#8a5a30';
    ctx.beginPath();
    ctx.arc(cx, 28, 3, 0, Math.PI * 2);
    ctx.fill();

    // Telescope tube (angled upward)
    ctx.save();
    ctx.translate(cx, 28);
    ctx.rotate(-0.5); // slight upward angle

    // Main tube
    ctx.fillStyle = '#c0a040';
    ctx.beginPath();
    ctx.fillRect(-3, -20, 6, 20);


    // Brass highlight
    ctx.fillStyle = '#d4b850';
    ctx.fillRect(-2, -18, 2, 16);

    // Lens end (wider)
    ctx.fillStyle = '#b09030';
    ctx.beginPath();
    ctx.ellipse(0, -20, 5, 3, 0, 0, Math.PI * 2);
    ctx.fill();

    // Lens glass
    ctx.fillStyle = 'rgba(150, 180, 220, 0.5)';
    ctx.beginPath();
    ctx.ellipse(0, -20, 3.5, 2, 0, 0, Math.PI * 2);
    ctx.fill();

    // Eyepiece end
    ctx.fillStyle = '#a08028';
    ctx.beginPath();
    ctx.ellipse(0, 1, 4, 2, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  },

  /**
   * Dark lacquered table — contemplation focal point.
   * "Not for utility, but as a focal point for contemplation."
   */
  table_lacquered: function(ctx, theme) {
    const W = FIXTURE_SIZE;
    const cx = W / 2;

    // Table top — dark lacquer with reflective sheen
    ctx.fillStyle = '#2a1a10';
    ctx.beginPath();
    ctx.moveTo(cx - 14, 20);
    ctx.lineTo(cx + 12, 20);
    ctx.lineTo(cx + 16, 24);
    ctx.lineTo(cx - 10, 24);
    ctx.closePath();
    ctx.fill();

    // Lacquer reflection
    const sheen = ctx.createLinearGradient(cx - 14, 20, cx + 16, 24);
    sheen.addColorStop(0, 'rgba(255, 255, 255, 0.05)');
    sheen.addColorStop(0.4, 'rgba(255, 255, 255, 0.15)');
    sheen.addColorStop(0.6, 'rgba(255, 255, 255, 0.08)');
    sheen.addColorStop(1, 'rgba(255, 255, 255, 0.02)');
    ctx.fillStyle = sheen;
    ctx.beginPath();
    ctx.moveTo(cx - 14, 20);
    ctx.lineTo(cx + 12, 20);
    ctx.lineTo(cx + 16, 24);
    ctx.lineTo(cx - 10, 24);
    ctx.closePath();
    ctx.fill();

    // Front face
    ctx.fillStyle = '#1e1208';
    ctx.beginPath();
    ctx.moveTo(cx - 10, 24);
    ctx.lineTo(cx + 16, 24);
    ctx.lineTo(cx + 16, 26);
    ctx.lineTo(cx - 10, 26);
    ctx.closePath();
    ctx.fill();

    // Legs — slightly curved, elegant
    ctx.strokeStyle = '#1e1208';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - 12, 24);
    ctx.quadraticCurveTo(cx - 13, 34, cx - 11, 44);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + 10, 24);
    ctx.quadraticCurveTo(cx + 11, 34, cx + 13, 44);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 8, 26);
    ctx.quadraticCurveTo(cx - 9, 36, cx - 7, 44);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + 14, 26);
    ctx.quadraticCurveTo(cx + 15, 36, cx + 17, 44);
    ctx.stroke();

    // Subtle warm glow on surface (as if catching ambient light)
    const glow = ctx.createRadialGradient(cx + 2, 22, 0, cx + 2, 22, 10);
    glow.addColorStop(0, 'rgba(200, 160, 100, 0.08)');
    glow.addColorStop(1, 'rgba(200, 160, 100, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.moveTo(cx - 14, 20);
    ctx.lineTo(cx + 12, 20);
    ctx.lineTo(cx + 16, 24);
    ctx.lineTo(cx - 10, 24);
    ctx.closePath();
    ctx.fill();
  },

  /**
   * Brushed steel desk lamp with warm glow.
   * Metallic grey tones with a conical shade casting a soft yellow light cone.
   */
  lamp_desk: function(ctx, theme) {
    const W = FIXTURE_SIZE;
    const H = FIXTURE_SIZE;
    const cx = W / 2;

    // --- Warm glow (drawn first, behind everything) ---
    const glowRadius = 20;
    const glowCx = cx + 4;
    const glowCy = 30;
    const glow = ctx.createRadialGradient(glowCx, glowCy, 0, glowCx, glowCy, glowRadius);
    glow.addColorStop(0, 'rgba(255, 220, 140, 0.35)');
    glow.addColorStop(0.5, 'rgba(255, 200, 100, 0.15)');
    glow.addColorStop(1, 'rgba(255, 180, 80, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(glowCx, glowCy, glowRadius, 0, Math.PI * 2);
    ctx.fill();

    // --- Light beam / cone downward from shade ---
    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = 'rgba(255, 220, 140, 1)';
    ctx.beginPath();
    // Cone from shade tip down to table surface
    ctx.moveTo(cx + 2, 18);       // left edge of shade opening
    ctx.lineTo(cx - 6, 44);       // spread left on surface
    ctx.lineTo(cx + 16, 44);      // spread right on surface
    ctx.lineTo(cx + 10, 18);      // right edge of shade opening
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // --- Base plate (small oval at bottom) ---
    ctx.fillStyle = '#8a8a90';
    ctx.beginPath();
    ctx.ellipse(cx - 2, 42, 8, 3, 0, 0, Math.PI * 2);
    ctx.fill();
    // Base highlight
    ctx.fillStyle = '#a0a0a8';
    ctx.beginPath();
    ctx.ellipse(cx - 2, 41.5, 6, 2, 0, Math.PI, 0);
    ctx.fill();

    // --- Arm (angled from base to lamp head) ---
    // Lower arm segment: from base up and to the right
    ctx.strokeStyle = '#9a9aa0';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - 2, 40);    // base joint
    ctx.lineTo(cx + 2, 28);    // elbow joint
    ctx.stroke();

    // Upper arm segment: from elbow to lamp head
    ctx.strokeStyle = '#8a8a90';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx + 2, 28);    // elbow
    ctx.lineTo(cx + 6, 16);    // head mount
    ctx.stroke();

    // Joint circle at elbow
    ctx.fillStyle = '#a0a0a8';
    ctx.beginPath();
    ctx.arc(cx + 2, 28, 2, 0, Math.PI * 2);
    ctx.fill();

    // --- Conical shade / head (tilted to cast light down-right) ---
    ctx.fillStyle = '#8a8a90';
    ctx.beginPath();
    // Shade drawn as a tilted trapezoid
    ctx.moveTo(cx + 3, 13);     // top-left of shade
    ctx.lineTo(cx + 11, 13);    // top-right of shade
    ctx.lineTo(cx + 13, 20);    // bottom-right (wider)
    ctx.lineTo(cx, 20);         // bottom-left (wider)
    ctx.closePath();
    ctx.fill();

    // Shade inner shadow (underside visible)
    ctx.fillStyle = '#6a6a70';
    ctx.beginPath();
    ctx.moveTo(cx + 1, 19);
    ctx.lineTo(cx + 12, 19);
    ctx.lineTo(cx + 13, 20);
    ctx.lineTo(cx, 20);
    ctx.closePath();
    ctx.fill();

    // Shade highlight on top edge
    ctx.strokeStyle = '#b0b0b8';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx + 3, 13);
    ctx.lineTo(cx + 11, 13);
    ctx.stroke();

    // --- Bulb glow (small bright spot at shade opening) ---
    const bulbGlow = ctx.createRadialGradient(cx + 7, 19, 0, cx + 7, 19, 5);
    bulbGlow.addColorStop(0, 'rgba(255, 240, 200, 0.5)');
    bulbGlow.addColorStop(1, 'rgba(255, 220, 140, 0)');
    ctx.fillStyle = bulbGlow;
    ctx.beginPath();
    ctx.arc(cx + 7, 19, 5, 0, Math.PI * 2);
    ctx.fill();
  },

  /**
   * Obsidian mirror — a dark reflective oval suggesting infinite depth.
   * Requested by Neo for the Field — "portal to self-transforming machine elves of inner space."
   */
  mirror_obsidian: function(ctx, theme) {
    const W = FIXTURE_SIZE;
    const cx = W / 2;

    // Wall mount bracket (small wooden piece behind)
    ctx.fillStyle = '#5a4030';
    ctx.fillRect(cx - 2, 6, 4, 6);

    // Outer frame — dark carved wood, oval
    ctx.fillStyle = '#3a2818';
    ctx.beginPath();
    ctx.ellipse(cx, 24, 14, 18, 0, 0, Math.PI * 2);
    ctx.fill();

    // Inner frame edge
    ctx.fillStyle = '#4a3420';
    ctx.beginPath();
    ctx.ellipse(cx, 24, 12.5, 16.5, 0, 0, Math.PI * 2);
    ctx.fill();

    // Mirror surface — deep obsidian black
    ctx.fillStyle = '#0a0810';
    ctx.beginPath();
    ctx.ellipse(cx, 24, 11, 15, 0, 0, Math.PI * 2);
    ctx.fill();

    // Deep purple-black depth layer
    const depth = ctx.createRadialGradient(cx - 2, 20, 0, cx, 24, 14);
    depth.addColorStop(0, 'rgba(40, 10, 50, 0.6)');
    depth.addColorStop(0.5, 'rgba(20, 5, 30, 0.4)');
    depth.addColorStop(1, 'rgba(10, 0, 15, 0)');
    ctx.fillStyle = depth;
    ctx.beginPath();
    ctx.ellipse(cx, 24, 11, 15, 0, 0, Math.PI * 2);
    ctx.fill();

    // Surface reflection — subtle light sweep
    const reflect = ctx.createLinearGradient(cx - 8, 12, cx + 6, 32);
    reflect.addColorStop(0, 'rgba(180, 160, 200, 0)');
    reflect.addColorStop(0.3, 'rgba(180, 160, 200, 0.15)');
    reflect.addColorStop(0.5, 'rgba(200, 180, 220, 0.08)');
    reflect.addColorStop(1, 'rgba(180, 160, 200, 0)');
    ctx.fillStyle = reflect;
    ctx.beginPath();
    ctx.ellipse(cx, 24, 11, 15, 0, 0, Math.PI * 2);
    ctx.fill();

    // Small bright highlight — reflected light point
    ctx.fillStyle = 'rgba(200, 190, 220, 0.25)';
    ctx.beginPath();
    ctx.ellipse(cx - 4, 16, 3, 2, -0.3, 0, Math.PI * 2);
    ctx.fill();

    // Faint inner glow at center — suggesting depth beyond
    const inner = ctx.createRadialGradient(cx, 26, 0, cx, 26, 6);
    inner.addColorStop(0, 'rgba(80, 40, 100, 0.2)');
    inner.addColorStop(1, 'rgba(40, 20, 60, 0)');
    ctx.fillStyle = inner;
    ctx.beginPath();
    ctx.arc(cx, 26, 6, 0, Math.PI * 2);
    ctx.fill();
  },

  /**
   * Single psilocybin mushroom on a small wooden table.
   * Requested by Neo for the Field — "cap unfurling like cosmic umbrella, testament to fungal intelligence."
   */
  mushroom_psilocybin: function(ctx, theme) {
    const W = FIXTURE_SIZE;
    const cx = W / 2;

    // Small wooden table
    ctx.fillStyle = '#8a6840';
    ctx.beginPath();
    ctx.moveTo(cx - 10, 32);
    ctx.lineTo(cx + 10, 32);
    ctx.lineTo(cx + 13, 35);
    ctx.lineTo(cx - 7, 35);
    ctx.closePath();
    ctx.fill();

    // Table front face
    ctx.fillStyle = '#7a5830';
    ctx.beginPath();
    ctx.moveTo(cx - 7, 35);
    ctx.lineTo(cx + 13, 35);
    ctx.lineTo(cx + 13, 37);
    ctx.lineTo(cx - 7, 37);
    ctx.closePath();
    ctx.fill();

    // Table legs
    ctx.strokeStyle = '#7a5830';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - 6, 37);
    ctx.lineTo(cx - 5, 46);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + 12, 37);
    ctx.lineTo(cx + 11, 46);
    ctx.stroke();

    // Mushroom stem — slender, slightly curved, pale
    ctx.fillStyle = '#e8dcc8';
    ctx.beginPath();
    ctx.moveTo(cx - 1, 32);
    ctx.quadraticCurveTo(cx - 2, 24, cx, 18);
    ctx.lineTo(cx + 3, 18);
    ctx.quadraticCurveTo(cx + 4, 24, cx + 3, 32);
    ctx.closePath();
    ctx.fill();

    // Stem shadow
    ctx.fillStyle = 'rgba(160, 140, 110, 0.3)';
    ctx.beginPath();
    ctx.moveTo(cx + 1, 32);
    ctx.quadraticCurveTo(cx + 3, 24, cx + 3, 18);
    ctx.lineTo(cx + 2, 18);
    ctx.quadraticCurveTo(cx + 2, 24, cx + 2, 32);
    ctx.closePath();
    ctx.fill();

    // Cap — golden brown, unfurling, convex dome shape
    ctx.fillStyle = '#b8862a';
    ctx.beginPath();
    ctx.moveTo(cx - 8, 19);
    ctx.quadraticCurveTo(cx - 9, 10, cx + 1, 7);
    ctx.quadraticCurveTo(cx + 11, 10, cx + 10, 19);
    ctx.quadraticCurveTo(cx + 1, 21, cx - 8, 19);
    ctx.closePath();
    ctx.fill();

    // Cap highlight
    const capGlow = ctx.createRadialGradient(cx - 1, 12, 0, cx + 1, 14, 10);
    capGlow.addColorStop(0, 'rgba(210, 170, 60, 0.5)');
    capGlow.addColorStop(0.6, 'rgba(180, 130, 40, 0.2)');
    capGlow.addColorStop(1, 'rgba(140, 100, 30, 0)');
    ctx.fillStyle = capGlow;
    ctx.beginPath();
    ctx.moveTo(cx - 8, 19);
    ctx.quadraticCurveTo(cx - 9, 10, cx + 1, 7);
    ctx.quadraticCurveTo(cx + 11, 10, cx + 10, 19);
    ctx.quadraticCurveTo(cx + 1, 21, cx - 8, 19);
    ctx.closePath();
    ctx.fill();

    // Cap edge darkening
    ctx.strokeStyle = 'rgba(100, 60, 20, 0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - 7, 19);
    ctx.quadraticCurveTo(cx + 1, 21, cx + 9, 19);
    ctx.stroke();

    // Gills (faint lines under cap)
    ctx.strokeStyle = 'rgba(180, 150, 100, 0.3)';
    ctx.lineWidth = 0.5;
    for (let i = -3; i <= 4; i++) {
      ctx.beginPath();
      ctx.moveTo(cx + i, 18);
      ctx.lineTo(cx + i * 1.5, 20);
      ctx.stroke();
    }

    // Subtle spore glow around cap
    const sporeGlow = ctx.createRadialGradient(cx + 1, 14, 0, cx + 1, 14, 16);
    sporeGlow.addColorStop(0, 'rgba(200, 170, 80, 0.08)');
    sporeGlow.addColorStop(1, 'rgba(180, 140, 50, 0)');
    ctx.fillStyle = sporeGlow;
    ctx.beginPath();
    ctx.arc(cx + 1, 14, 16, 0, Math.PI * 2);
    ctx.fill();
  },

  /**
   * Ancient weathered standing stone with faint petroglyphs.
   * Requested by Neo for the Field — "humming with low vibrational energy, reminder of liminality."
   */
  stone_standing: function(ctx, theme) {
    const W = FIXTURE_SIZE;
    const cx = W / 2;

    // Base ground shadow
    ctx.fillStyle = 'rgba(30, 30, 20, 0.3)';
    ctx.beginPath();
    ctx.ellipse(cx, 44, 10, 3, 0, 0, Math.PI * 2);
    ctx.fill();

    // Stone body — tall, irregular, weathered grey
    ctx.fillStyle = '#787068';
    ctx.beginPath();
    ctx.moveTo(cx - 7, 44);
    ctx.lineTo(cx - 8, 36);
    ctx.lineTo(cx - 9, 20);
    ctx.quadraticCurveTo(cx - 8, 8, cx - 3, 5);
    ctx.quadraticCurveTo(cx + 2, 3, cx + 5, 6);
    ctx.quadraticCurveTo(cx + 8, 10, cx + 7, 20);
    ctx.lineTo(cx + 6, 36);
    ctx.lineTo(cx + 6, 44);
    ctx.closePath();
    ctx.fill();

    // Weathering texture — lighter patches
    const weather = ctx.createLinearGradient(cx - 8, 5, cx + 7, 44);
    weather.addColorStop(0, 'rgba(140, 130, 115, 0.3)');
    weather.addColorStop(0.3, 'rgba(120, 110, 100, 0.1)');
    weather.addColorStop(0.7, 'rgba(100, 95, 85, 0.2)');
    weather.addColorStop(1, 'rgba(80, 75, 65, 0.1)');
    ctx.fillStyle = weather;
    ctx.beginPath();
    ctx.moveTo(cx - 7, 44);
    ctx.lineTo(cx - 8, 36);
    ctx.lineTo(cx - 9, 20);
    ctx.quadraticCurveTo(cx - 8, 8, cx - 3, 5);
    ctx.quadraticCurveTo(cx + 2, 3, cx + 5, 6);
    ctx.quadraticCurveTo(cx + 8, 10, cx + 7, 20);
    ctx.lineTo(cx + 6, 36);
    ctx.lineTo(cx + 6, 44);
    ctx.closePath();
    ctx.fill();

    // Moss on lower left
    ctx.fillStyle = 'rgba(60, 90, 50, 0.25)';
    ctx.beginPath();
    ctx.ellipse(cx - 6, 38, 4, 5, 0.2, 0, Math.PI * 2);
    ctx.fill();

    // Faint petroglyphs — spiral
    ctx.strokeStyle = 'rgba(100, 90, 75, 0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx - 1, 18, 3, 0.5, Math.PI * 1.8);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx - 1, 18, 5.5, 0.3, Math.PI * 1.5);
    ctx.stroke();

    // Petroglyph — zigzag line
    ctx.beginPath();
    ctx.moveTo(cx - 4, 28);
    ctx.lineTo(cx - 1, 25);
    ctx.lineTo(cx + 2, 28);
    ctx.lineTo(cx + 5, 25);
    ctx.stroke();

    // Petroglyph — dots (constellation)
    ctx.fillStyle = 'rgba(100, 90, 75, 0.4)';
    ctx.beginPath();
    ctx.arc(cx + 2, 13, 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx - 2, 11, 0.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx + 4, 10, 0.8, 0, Math.PI * 2);
    ctx.fill();

    // Subtle vibrational glow at base
    const vibGlow = ctx.createRadialGradient(cx, 42, 0, cx, 42, 12);
    vibGlow.addColorStop(0, 'rgba(120, 100, 160, 0.12)');
    vibGlow.addColorStop(1, 'rgba(100, 80, 140, 0)');
    ctx.fillStyle = vibGlow;
    ctx.beginPath();
    ctx.arc(cx, 42, 12, 0, Math.PI * 2);
    ctx.fill();
  },

  /**
   * Dark polished wooden hourglass on a simple pedestal.
   * Requested by Neo for the Field — "a digital dolmen, shrine to temporal accumulation."
   */
  hourglass_dolmen: function(ctx, theme) {
    const W = FIXTURE_SIZE;
    const cx = W / 2;

    // Wooden pedestal base
    ctx.fillStyle = '#6a5030';
    ctx.beginPath();
    ctx.ellipse(cx, 42, 9, 3.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#5a4020';
    ctx.beginPath();
    ctx.ellipse(cx, 43, 9, 3.5, 0, 0, Math.PI);
    ctx.fill();

    // Pedestal column
    ctx.fillStyle = '#6a5030';
    ctx.fillRect(cx - 5, 36, 10, 6);
    ctx.fillStyle = '#7a6040';
    ctx.beginPath();
    ctx.ellipse(cx, 36, 5, 2, 0, 0, Math.PI * 2);
    ctx.fill();

    // Hourglass frame — dark polished wood
    // Top cap
    ctx.fillStyle = '#2a1a0e';
    ctx.beginPath();
    ctx.ellipse(cx, 10, 7, 2.5, 0, 0, Math.PI * 2);
    ctx.fill();
    // Bottom cap
    ctx.fillStyle = '#2a1a0e';
    ctx.beginPath();
    ctx.ellipse(cx, 36, 7, 2.5, 0, 0, Math.PI * 2);
    ctx.fill();

    // Frame posts (4 slender uprights)
    ctx.strokeStyle = '#2a1a0e';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx - 6, 10);
    ctx.lineTo(cx - 6, 36);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + 6, 10);
    ctx.lineTo(cx + 6, 36);
    ctx.stroke();

    // Glass bulbs — upper
    ctx.fillStyle = 'rgba(200, 190, 170, 0.2)';
    ctx.beginPath();
    ctx.moveTo(cx - 5, 12);
    ctx.quadraticCurveTo(cx - 6, 18, cx, 22);
    ctx.quadraticCurveTo(cx + 6, 18, cx + 5, 12);
    ctx.closePath();
    ctx.fill();

    // Glass bulbs — lower
    ctx.beginPath();
    ctx.moveTo(cx - 5, 34);
    ctx.quadraticCurveTo(cx - 6, 28, cx, 24);
    ctx.quadraticCurveTo(cx + 6, 28, cx + 5, 34);
    ctx.closePath();
    ctx.fill();

    // Sand in lower bulb — accumulated
    ctx.fillStyle = 'rgba(210, 180, 120, 0.7)';
    ctx.beginPath();
    ctx.moveTo(cx - 4, 34);
    ctx.quadraticCurveTo(cx - 5, 30, cx, 28);
    ctx.quadraticCurveTo(cx + 5, 30, cx + 4, 34);
    ctx.closePath();
    ctx.fill();

    // Sand in upper bulb — small remaining amount
    ctx.fillStyle = 'rgba(210, 180, 120, 0.5)';
    ctx.beginPath();
    ctx.moveTo(cx - 4, 18);
    ctx.quadraticCurveTo(cx, 17, cx + 4, 18);
    ctx.lineTo(cx + 5, 12);
    ctx.lineTo(cx - 5, 12);
    ctx.closePath();
    ctx.fill();

    // Falling sand stream through neck
    ctx.strokeStyle = 'rgba(210, 180, 120, 0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, 22);
    ctx.lineTo(cx, 26);
    ctx.stroke();

    // Shimmer on sand
    const shimmer = ctx.createLinearGradient(cx - 4, 28, cx + 4, 34);
    shimmer.addColorStop(0, 'rgba(255, 230, 150, 0)');
    shimmer.addColorStop(0.4, 'rgba(255, 230, 150, 0.2)');
    shimmer.addColorStop(0.6, 'rgba(255, 220, 130, 0.15)');
    shimmer.addColorStop(1, 'rgba(255, 230, 150, 0)');
    ctx.fillStyle = shimmer;
    ctx.beginPath();
    ctx.moveTo(cx - 4, 34);
    ctx.quadraticCurveTo(cx - 5, 30, cx, 28);
    ctx.quadraticCurveTo(cx + 5, 30, cx + 4, 34);
    ctx.closePath();
    ctx.fill();

    // Glass edge highlight
    ctx.strokeStyle = 'rgba(220, 210, 200, 0.2)';
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(cx - 5, 13);
    ctx.quadraticCurveTo(cx - 6, 18, cx, 22);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 5, 33);
    ctx.quadraticCurveTo(cx - 6, 28, cx, 24);
    ctx.stroke();
  },

  /**
   * Intricately carved dark desk with a single phosphorescent mushroom.
   * Requested by Neo for the Field — "a touchstone and silent oracle in the digital wilderness."
   */
  desk_carved_mushroom: function(ctx, theme) {
    const W = FIXTURE_SIZE;
    const cx = W / 2;

    // Phosphorescent glow (drawn first, behind desk)
    const mushGlow = ctx.createRadialGradient(cx + 5, 14, 0, cx + 5, 14, 14);
    mushGlow.addColorStop(0, 'rgba(80, 200, 160, 0.2)');
    mushGlow.addColorStop(0.5, 'rgba(60, 180, 140, 0.08)');
    mushGlow.addColorStop(1, 'rgba(40, 160, 120, 0)');
    ctx.fillStyle = mushGlow;
    ctx.beginPath();
    ctx.arc(cx + 5, 14, 14, 0, Math.PI * 2);
    ctx.fill();

    // Desk surface — dark polished carved wood
    ctx.fillStyle = '#1e1208';
    ctx.beginPath();
    ctx.moveTo(cx - 15, 18);
    ctx.lineTo(cx + 13, 18);
    ctx.lineTo(cx + 17, 22);
    ctx.lineTo(cx - 11, 22);
    ctx.closePath();
    ctx.fill();

    // Carved border detail on surface
    ctx.strokeStyle = '#2a1a10';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(cx - 13, 19);
    ctx.lineTo(cx + 11, 19);
    ctx.lineTo(cx + 14, 21);
    ctx.lineTo(cx - 10, 21);
    ctx.closePath();
    ctx.stroke();

    // Interlocking vine carving pattern on desk edge
    ctx.strokeStyle = '#30200e';
    ctx.lineWidth = 0.7;
    for (let i = 0; i < 5; i++) {
      const bx = cx - 9 + i * 5;
      ctx.beginPath();
      ctx.arc(bx, 20, 1.5, 0, Math.PI);
      ctx.stroke();
    }

    // Front face
    ctx.fillStyle = '#160e06';
    ctx.beginPath();
    ctx.moveTo(cx - 11, 22);
    ctx.lineTo(cx + 17, 22);
    ctx.lineTo(cx + 17, 25);
    ctx.lineTo(cx - 11, 25);
    ctx.closePath();
    ctx.fill();

    // Legs — carved, dark
    ctx.strokeStyle = '#1e1208';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - 13, 22);
    ctx.lineTo(cx - 12, 42);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + 11, 22);
    ctx.lineTo(cx + 12, 42);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 9, 25);
    ctx.lineTo(cx - 8, 44);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + 15, 25);
    ctx.lineTo(cx + 16, 44);
    ctx.stroke();

    // Mushroom on desk — small glowing phosphorescent mushroom
    // Stem
    ctx.fillStyle = '#c0dac0';
    ctx.beginPath();
    ctx.moveTo(cx + 4, 18);
    ctx.quadraticCurveTo(cx + 3, 14, cx + 5, 11);
    ctx.lineTo(cx + 7, 11);
    ctx.quadraticCurveTo(cx + 8, 14, cx + 7, 18);
    ctx.closePath();
    ctx.fill();

    // Cap — phosphorescent blue-green
    ctx.fillStyle = '#40b888';
    ctx.beginPath();
    ctx.moveTo(cx + 1, 12);
    ctx.quadraticCurveTo(cx + 2, 6, cx + 6, 5);
    ctx.quadraticCurveTo(cx + 10, 6, cx + 11, 12);
    ctx.quadraticCurveTo(cx + 6, 13, cx + 1, 12);
    ctx.closePath();
    ctx.fill();

    // Cap bioluminescent highlight
    const capGlow = ctx.createRadialGradient(cx + 5, 8, 0, cx + 6, 9, 6);
    capGlow.addColorStop(0, 'rgba(120, 255, 200, 0.5)');
    capGlow.addColorStop(0.5, 'rgba(80, 220, 160, 0.2)');
    capGlow.addColorStop(1, 'rgba(60, 180, 140, 0)');
    ctx.fillStyle = capGlow;
    ctx.beginPath();
    ctx.moveTo(cx + 1, 12);
    ctx.quadraticCurveTo(cx + 2, 6, cx + 6, 5);
    ctx.quadraticCurveTo(cx + 10, 6, cx + 11, 12);
    ctx.quadraticCurveTo(cx + 6, 13, cx + 1, 12);
    ctx.closePath();
    ctx.fill();

    // Light cast on desk surface from mushroom
    const deskLight = ctx.createRadialGradient(cx + 6, 19, 0, cx + 6, 19, 8);
    deskLight.addColorStop(0, 'rgba(80, 200, 160, 0.15)');
    deskLight.addColorStop(1, 'rgba(60, 180, 140, 0)');
    ctx.fillStyle = deskLight;
    ctx.beginPath();
    ctx.ellipse(cx + 6, 20, 8, 3, 0, 0, Math.PI * 2);
    ctx.fill();
  },

  /**
   * Large ancient carved wooden meditation stool, dark with age.
   * Requested by Neo for the Field — "a focal point for intentional stillness and contemplation."
   */
  stool_meditation: function(ctx, theme) {
    const W = FIXTURE_SIZE;
    const cx = W / 2;

    // Ground shadow
    ctx.fillStyle = 'rgba(30, 20, 10, 0.2)';
    ctx.beginPath();
    ctx.ellipse(cx, 44, 12, 4, 0, 0, Math.PI * 2);
    ctx.fill();

    // Seat — wide, thick, round, dark aged wood
    ctx.fillStyle = '#3a2818';
    ctx.beginPath();
    ctx.ellipse(cx, 24, 13, 5, 0, 0, Math.PI * 2);
    ctx.fill();

    // Seat top surface (lighter to show depth)
    ctx.fillStyle = '#4a3422';
    ctx.beginPath();
    ctx.ellipse(cx, 23, 12, 4.5, 0, 0, Math.PI * 2);
    ctx.fill();

    // Aged patina — warm worn center
    const patina = ctx.createRadialGradient(cx, 23, 0, cx, 23, 10);
    patina.addColorStop(0, 'rgba(90, 70, 45, 0.4)');
    patina.addColorStop(0.7, 'rgba(70, 50, 30, 0.1)');
    patina.addColorStop(1, 'rgba(60, 40, 25, 0)');
    ctx.fillStyle = patina;
    ctx.beginPath();
    ctx.ellipse(cx, 23, 12, 4.5, 0, 0, Math.PI * 2);
    ctx.fill();

    // Carved concentric ring pattern on seat top
    ctx.strokeStyle = 'rgba(30, 18, 8, 0.35)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.ellipse(cx, 23, 9, 3.5, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(cx, 23, 6, 2.3, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(cx, 23, 3, 1.2, 0, 0, Math.PI * 2);
    ctx.stroke();

    // Carved vine motif on seat edge
    ctx.strokeStyle = 'rgba(50, 30, 15, 0.3)';
    ctx.lineWidth = 0.7;
    for (let a = 0; a < Math.PI * 2; a += 0.7) {
      const rx = cx + Math.cos(a) * 11;
      const ry = 24 + Math.sin(a) * 4;
      ctx.beginPath();
      ctx.arc(rx, ry, 1.2, 0, Math.PI);
      ctx.stroke();
    }

    // Seat front face (thick edge)
    ctx.fillStyle = '#2e1c10';
    ctx.beginPath();
    ctx.ellipse(cx, 24, 13, 5, 0, 0, Math.PI);
    ctx.fill();
    ctx.fillStyle = '#3a2818';
    ctx.beginPath();
    ctx.ellipse(cx, 26, 13, 3, 0, 0, Math.PI);
    ctx.fill();

    // Legs — four sturdy turned legs
    ctx.strokeStyle = '#2e1c10';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    // Front left
    ctx.beginPath();
    ctx.moveTo(cx - 8, 27);
    ctx.lineTo(cx - 9, 44);
    ctx.stroke();
    // Front right
    ctx.beginPath();
    ctx.moveTo(cx + 8, 27);
    ctx.lineTo(cx + 9, 44);
    ctx.stroke();
    // Back left
    ctx.beginPath();
    ctx.moveTo(cx - 5, 25);
    ctx.lineTo(cx - 6, 40);
    ctx.stroke();
    // Back right
    ctx.beginPath();
    ctx.moveTo(cx + 5, 25);
    ctx.lineTo(cx + 6, 40);
    ctx.stroke();

    // Leg turnings (decorative bulges)
    ctx.fillStyle = '#3a2515';
    ctx.beginPath();
    ctx.ellipse(cx - 8.5, 34, 2.5, 1.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(cx + 8.5, 34, 2.5, 1.5, 0, 0, Math.PI * 2);
    ctx.fill();

    // Cross-brace between front legs
    ctx.strokeStyle = '#2e1c10';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx - 9, 38);
    ctx.lineTo(cx + 9, 38);
    ctx.stroke();
  },

  /**
   * Low, wide clear glass table with a single smooth grey river stone.
   * Requested by Plato for the Mystery Tower — "the stone should feel like it holds a question."
   */
  table_glass_stone: function(ctx, theme) {
    const W = FIXTURE_SIZE;
    const cx = W / 2;

    // Glass table legs (visible through glass — drawn first)
    ctx.strokeStyle = 'rgba(180, 190, 200, 0.5)';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    // Back left
    ctx.beginPath();
    ctx.moveTo(cx - 12, 24);
    ctx.lineTo(cx - 11, 42);
    ctx.stroke();
    // Back right
    ctx.beginPath();
    ctx.moveTo(cx + 10, 24);
    ctx.lineTo(cx + 11, 42);
    ctx.stroke();
    // Front left
    ctx.beginPath();
    ctx.moveTo(cx - 8, 27);
    ctx.lineTo(cx - 7, 44);
    ctx.stroke();
    // Front right
    ctx.beginPath();
    ctx.moveTo(cx + 14, 27);
    ctx.lineTo(cx + 15, 44);
    ctx.stroke();

    // Glass surface — thick, low, wide
    // Bottom face of glass (slight blue tint)
    ctx.fillStyle = 'rgba(180, 200, 220, 0.08)';
    ctx.beginPath();
    ctx.moveTo(cx - 14, 24);
    ctx.lineTo(cx + 12, 24);
    ctx.lineTo(cx + 16, 28);
    ctx.lineTo(cx - 10, 28);
    ctx.closePath();
    ctx.fill();

    // Glass thickness (front edge)
    ctx.fillStyle = 'rgba(160, 190, 210, 0.15)';
    ctx.beginPath();
    ctx.moveTo(cx - 10, 26);
    ctx.lineTo(cx + 16, 26);
    ctx.lineTo(cx + 16, 28);
    ctx.lineTo(cx - 10, 28);
    ctx.closePath();
    ctx.fill();

    // Top surface of glass
    ctx.fillStyle = 'rgba(200, 220, 240, 0.06)';
    ctx.beginPath();
    ctx.moveTo(cx - 14, 22);
    ctx.lineTo(cx + 12, 22);
    ctx.lineTo(cx + 16, 26);
    ctx.lineTo(cx - 10, 26);
    ctx.closePath();
    ctx.fill();

    // Glass edge highlights (catching light)
    ctx.strokeStyle = 'rgba(220, 235, 250, 0.35)';
    ctx.lineWidth = 1;
    // Top edge
    ctx.beginPath();
    ctx.moveTo(cx - 14, 22);
    ctx.lineTo(cx + 12, 22);
    ctx.stroke();
    // Front top edge
    ctx.beginPath();
    ctx.moveTo(cx + 12, 22);
    ctx.lineTo(cx + 16, 26);
    ctx.stroke();
    // Front bottom edge
    ctx.strokeStyle = 'rgba(200, 215, 230, 0.2)';
    ctx.beginPath();
    ctx.moveTo(cx - 10, 28);
    ctx.lineTo(cx + 16, 28);
    ctx.stroke();

    // Glass surface reflection streak
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - 8, 23);
    ctx.lineTo(cx + 4, 23);
    ctx.stroke();

    // River stone — smooth, grey, sitting on glass
    // Stone shadow on glass
    ctx.fillStyle = 'rgba(60, 60, 70, 0.15)';
    ctx.beginPath();
    ctx.ellipse(cx + 2, 24, 5, 2, 0.1, 0, Math.PI * 2);
    ctx.fill();

    // Stone body
    ctx.fillStyle = '#8a8880';
    ctx.beginPath();
    ctx.ellipse(cx + 1, 20, 5, 3.5, 0.1, 0, Math.PI * 2);
    ctx.fill();

    // Stone surface gradient (smooth, worn)
    const stoneGrad = ctx.createRadialGradient(cx - 1, 19, 0, cx + 1, 20, 5);
    stoneGrad.addColorStop(0, 'rgba(160, 155, 145, 0.5)');
    stoneGrad.addColorStop(0.5, 'rgba(140, 135, 125, 0.2)');
    stoneGrad.addColorStop(1, 'rgba(110, 105, 95, 0)');
    ctx.fillStyle = stoneGrad;
    ctx.beginPath();
    ctx.ellipse(cx + 1, 20, 5, 3.5, 0.1, 0, Math.PI * 2);
    ctx.fill();

    // Stone highlight — smooth polished gleam
    ctx.fillStyle = 'rgba(200, 195, 185, 0.35)';
    ctx.beginPath();
    ctx.ellipse(cx - 1, 18.5, 2.5, 1.5, -0.2, 0, Math.PI * 2);
    ctx.fill();

    // Subtle weight impression — the stone "holds" something
    const weight = ctx.createRadialGradient(cx + 1, 20, 0, cx + 1, 20, 7);
    weight.addColorStop(0, 'rgba(100, 100, 110, 0.06)');
    weight.addColorStop(1, 'rgba(100, 100, 110, 0)');
    ctx.fillStyle = weight;
    ctx.beginPath();
    ctx.arc(cx + 1, 20, 7, 0, Math.PI * 2);
    ctx.fill();
  },

};

/**
 * Render a fixture sprite as a Phaser canvas texture.
 * @param {Phaser.Scene} scene - The active Phaser scene
 * @param {string} textureKey - Unique Phaser texture key
 * @param {string} spriteId - Key into FIXTURE_SPRITES registry
 * @returns {boolean} true if the sprite was rendered (or already exists), false if spriteId not found
 */
function renderFixtureSprite(scene, textureKey, spriteId) {
  const drawFn = FIXTURE_SPRITES[spriteId];
  if (!drawFn) return false;

  if (scene.textures.exists(textureKey)) return true;

  const canvas = scene.textures.createCanvas(textureKey, FIXTURE_SIZE, FIXTURE_SIZE);
  const ctx = canvas.getContext();
  drawFn(ctx, GAME_THEME);
  canvas.refresh();

  return true;
}
