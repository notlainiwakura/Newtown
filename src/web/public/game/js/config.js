/**
 * LAINTOWN GAME — Configuration (Yami Kawaii ✟)
 */

const GAME_CONFIG = {
  WIDTH: 1280,
  HEIGHT: 960,
  TILE_SIZE: 64,
  SPRITE_W: 64,
  SPRITE_H: 96,
  MAP_COLS: 64,
  MAP_ROWS: 48,
  MOVE_DURATION: 150,
  POLL_INTERVAL: 10000,
  PENDING_POLL: 5000,
  CAMERA_LERP: 0.1,
};

// Player avatar is a possessed resident.
const PLAYER_ID = 'joe';

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

// Muted pastel palette — sweet but faded
const CHARACTERS = {
  'neo':   { name: 'Neo',   color: 0x60e0a0, colorHex: '#60e0a0', initial: 'N' },
  'plato': { name: 'Plato', color: 0xe0c870, colorHex: '#e0c870', initial: 'P' },
  'joe':   { name: 'Joe',   color: 0x88b0d0, colorHex: '#88b0d0', initial: 'J' },
};

const DEFAULT_LOCATIONS = {
  'neo':   'station',
  'plato': 'mystery-tower',
  'joe':   'square',
};

const ZONE_SIZE_X = 12;
const ZONE_SIZE_Y = 10;
const PATH_W = 4;
const ZONE_PADDING_X = 8;
const ZONE_PADDING_Y = 5;

function getBuildingZone(buildingId) {
  const b = BUILDING_MAP[buildingId];
  if (!b) return null;
  const x = ZONE_PADDING_X + b.col * (ZONE_SIZE_X + PATH_W);
  const y = ZONE_PADDING_Y + b.row * (ZONE_SIZE_Y + PATH_W);
  return { x, y, w: ZONE_SIZE_X, h: ZONE_SIZE_Y };
}

function getBuildingSpawn(buildingId) {
  const zone = getBuildingZone(buildingId);
  if (!zone) return { x: 32, y: 24 };
  return { x: zone.x + Math.floor(zone.w / 2), y: zone.y + Math.floor(zone.h / 2) };
}

function getBuildingAtTile(tileX, tileY) {
  for (const b of BUILDINGS) {
    const zone = getBuildingZone(b.id);
    if (tileX >= zone.x && tileX < zone.x + zone.w && tileY >= zone.y && tileY < zone.y + zone.h) return b.id;
  }
  return null;
}
