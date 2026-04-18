/**
 * LAINTOWN GAME — Configuration & Constants
 */

// Game theme colors — read from CSS custom properties (set by skin system)
// Falls back to the current default colors if no skin or variable is missing.
function getCSSColor(name, fallback) {
  const val = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return val || fallback;
}

function getCSSColorHex(name, fallback) {
  const hex = getCSSColor(name, fallback);
  return parseInt(hex.replace('#', ''), 16);
}

function buildGameTheme() {
  return {
    // Backgrounds
    bgDeep: getCSSColor('--bg-deep', '#0a0a1a'),
    bgDeepHex: getCSSColorHex('--bg-deep', '#0a0a1a'),
    bgPanel: getCSSColor('--game-panel-bg', '#0a0c14'),
    bgPanelHex: getCSSColorHex('--game-panel-bg', '#0a0c14'),

    // Text
    textPrimary: getCSSColor('--text-primary', '#c0d8ff'),
    textSecondary: getCSSColor('--text-secondary', '#6090c0'),
    textDim: getCSSColor('--text-dim', '#405880'),

    // Accents
    accentPrimary: getCSSColor('--accent-primary', '#4080ff'),
    accentSecondary: getCSSColor('--accent-secondary', '#80c0ff'),
    accentTertiary: getCSSColor('--accent-tertiary', '#40e0ff'),

    // UI borders
    uiBorder: getCSSColor('--game-ui-border', '#406080'),
    uiBorderHex: getCSSColorHex('--game-ui-border', '#406080'),
    uiBorderDim: getCSSColor('--game-ui-border-dim', '#203040'),
    uiBorderDimHex: getCSSColorHex('--game-ui-border-dim', '#203040'),
    uiHeaderBg: getCSSColorHex('--game-ui-header', '#182030'),

    // Input
    inputBg: getCSSColorHex('--game-input-bg', '#1a2030'),
    inputStroke: getCSSColorHex('--game-input-stroke', '#2a3040'),
    inputText: getCSSColor('--game-input-text', '#c0e0e0'),
    inputPrompt: getCSSColor('--game-input-prompt', '#60a0a0'),
    inputCursor: getCSSColor('--game-input-cursor', '#80c0ff'),

    // HUD
    hudLocation: getCSSColor('--game-hud-location', '#60a0a0'),
    hudPrompt: getCSSColor('--game-hud-prompt', '#80c0ff'),
    hudNotif: getCSSColor('--game-hud-notif', '#ffb040'),
    hudOverlayBg: getCSSColor('--game-hud-overlay', 'rgba(10,12,20,0.8)'),

    // Speech bubbles
    speechText: getCSSColor('--game-speech-text', '#e0e0f0'),
    speechBg: getCSSColor('--game-speech-bg', 'rgba(15,15,30,0.9)'),
    speechTail: getCSSColorHex('--game-speech-tail', '#0f0f1e'),

    // Building labels
    buildingLabel: getCSSColor('--game-building-label', '#607080'),

    // Tiles - environment colors
    grassMain: getCSSColor('--game-grass', '#1a2a1a'),
    grassLight: getCSSColor('--game-grass-light', '#1c2c1c'),
    grassDark: getCSSColor('--game-grass-dark', '#182818'),
    grassOutline: getCSSColor('--game-grass-outline', '#2a3a2a'),

    pathMain: getCSSColor('--game-path', '#2a2520'),
    pathLight: getCSSColor('--game-path-light', '#352f28'),

    floorMain: getCSSColor('--game-floor', '#20202a'),
    floorGrid: getCSSColor('--game-floor-grid', '#282838'),

    wallTop: getCSSColor('--game-wall-top', '#303040'),
    wallHighlight: getCSSColor('--game-wall-highlight', '#3c3c50'),
    wallSide: getCSSColor('--game-wall-side', '#252535'),
    wallDark: getCSSColor('--game-wall-dark', '#1e1e2e'),

    forestCanopy: getCSSColor('--game-forest', '#0a150a'),
    waterMain: getCSSColor('--game-water', '#0a0a20'),
    waterDetail: getCSSColor('--game-water-detail', '#101030'),

    // Status
    statusOnline: getCSSColor('--status-online', '#40e080'),
    statusError: getCSSColor('--status-error', '#ff6060'),

    // Object labels
    objectLabel: getCSSColor('--game-object-label', '#a0a0b0'),
  };
}

// Initialize theme
var GAME_THEME = buildGameTheme();

// Listen for skin changes — just rebuild the theme object.
// The game page reloads on skin switch (see BootScene), so this only
// matters if the page somehow stays alive across a skin change.
document.addEventListener('skin-changed', function() {
  GAME_THEME = buildGameTheme();
});

const GAME_CONFIG = {
  // Display
  WIDTH: 1280,
  HEIGHT: 960,
  TILE_SIZE: 64,
  SPRITE_W: 64,
  SPRITE_H: 96,

  // Map dimensions in tiles
  MAP_COLS: 64,
  MAP_ROWS: 48,

  // Movement
  MOVE_DURATION: 150, // ms per tile step
  POLL_INTERVAL: 10000, // location polling interval
  PENDING_POLL: 5000, // pending messages poll

  // Camera
  CAMERA_LERP: 0.1,

  // Isometric tile dimensions
  ISO_TILE_W: 128,
  ISO_TILE_H: 64,
  ISO_WALL_H: 96,
};

const PLAYER_ID = 'joe';

// Building definitions — mirrors backend commune/buildings.ts
const BUILDINGS = [
  { id: 'pub',             name: 'Pub',             row: 0, col: 0 },
  { id: 'station',         name: 'Station',         row: 0, col: 1 },
  { id: 'abandoned-house', name: 'Abandoned House', row: 0, col: 2 },
  { id: 'field',           name: 'Field',           row: 1, col: 0 },
  { id: 'windmill',        name: 'Windmill',        row: 1, col: 1 },
  { id: 'locksmith',       name: 'Locksmith',       row: 1, col: 2 },
  { id: 'mystery-tower',   name: 'Mystery Tower',   row: 2, col: 0 },
  { id: 'theater',         name: 'Theater',         row: 2, col: 1 },
  { id: 'square',          name: 'Square',          row: 2, col: 2 },
];

const BUILDING_MAP = {};
for (const b of BUILDINGS) BUILDING_MAP[b.id] = b;

// Character data
const CHARACTERS = {
  'neo':   { name: 'Neo',   color: 0x60e0a0, colorHex: '#60e0a0', initial: 'N' },
  'plato': { name: 'Plato', color: 0xe0c870, colorHex: '#e0c870', initial: 'P' },
  'joe':   { name: 'Joe',   color: 0x88b0d0, colorHex: '#88b0d0', initial: 'J' },
};

// Default locations
const DEFAULT_LOCATIONS = {
  'neo':   'station',
  'plato': 'mystery-tower',
  'joe':   'square',
};

// Building zones in tile coordinates — each building occupies a cluster on the tilemap.
// Grid layout: 3x3 buildings, each cluster ~12x10 tiles, with 3-tile paths between.
// Total: 3 clusters * (12 + 3) - 3 = 42 tiles wide → padded to 64
// Building cluster origin (top-left corner in tile coords)
const ZONE_SIZE_X = 12; // tiles wide per building
const ZONE_SIZE_Y = 10; // tiles tall per building
const PATH_W = 4;       // path width between buildings
const ZONE_PADDING_X = 8; // left margin
const ZONE_PADDING_Y = 5; // top margin

function getBuildingZone(buildingId) {
  const b = BUILDING_MAP[buildingId];
  if (!b) return null;
  const x = ZONE_PADDING_X + b.col * (ZONE_SIZE_X + PATH_W);
  const y = ZONE_PADDING_Y + b.row * (ZONE_SIZE_Y + PATH_W);
  return { x, y, w: ZONE_SIZE_X, h: ZONE_SIZE_Y };
}

// Get the spawn point (center) for a building
function getBuildingSpawn(buildingId) {
  const zone = getBuildingZone(buildingId);
  if (!zone) return { x: 32, y: 24 };
  return {
    x: zone.x + Math.floor(zone.w / 2),
    y: zone.y + Math.floor(zone.h / 2),
  };
}

// Determine which building a tile coordinate is in (or null if on a path)
function getBuildingAtTile(tileX, tileY) {
  for (const b of BUILDINGS) {
    const zone = getBuildingZone(b.id);
    if (
      tileX >= zone.x && tileX < zone.x + zone.w &&
      tileY >= zone.y && tileY < zone.y + zone.h
    ) {
      return b.id;
    }
  }
  return null;
}

// Convert tile coordinates to isometric screen coordinates
function tileToScreen(tileX, tileY) {
  const halfW = GAME_CONFIG.ISO_TILE_W / 2;
  const halfH = GAME_CONFIG.ISO_TILE_H / 2;
  return {
    x: (tileX - tileY) * halfW + GAME_CONFIG.MAP_ROWS * halfW,
    y: (tileX + tileY) * halfH + GAME_CONFIG.ISO_TILE_H,
  };
}

// Get character color, preferring CSS variable overrides from the active skin
function getCharacterColor(charId) {
  const style = getComputedStyle(document.documentElement);
  const hex = style.getPropertyValue(`--color-${charId}`).trim();
  if (hex) {
    return {
      color: parseInt(hex.replace('#', ''), 16),
      colorHex: hex,
    };
  }
  return CHARACTERS[charId];
}
