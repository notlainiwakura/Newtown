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

const BUILDINGS = [
  { id: 'library',    name: 'Library',    row: 0, col: 0 },
  { id: 'bar',        name: 'Bar',        row: 0, col: 1 },
  { id: 'field',      name: 'Field',      row: 0, col: 2 },
  { id: 'windmill',   name: 'Windmill',   row: 1, col: 0 },
  { id: 'lighthouse', name: 'Lighthouse', row: 1, col: 1 },
  { id: 'school',     name: 'School',     row: 1, col: 2 },
  { id: 'market',     name: 'Market',     row: 2, col: 0 },
  { id: 'locksmith',  name: 'Locksmith',  row: 2, col: 1 },
  { id: 'mall',       name: 'Mall',       row: 2, col: 2 },
];

const BUILDING_MAP = {};
for (const b of BUILDINGS) BUILDING_MAP[b.id] = b;

// Muted pastel palette — sweet but faded
const CHARACTERS = {
  'lain':       { name: 'Lain',        color: 0x88b0d0, colorHex: '#88b0d0', initial: 'L'  },
  'wired-lain': { name: 'Wired Lain',  color: 0x6898c8, colorHex: '#6898c8', initial: 'W'  },
  'pkd':        { name: 'PKD',         color: 0xa878c8, colorHex: '#a878c8', initial: 'P'  },
  'mckenna':    { name: 'McKenna',     color: 0x78b898, colorHex: '#78b898', initial: 'M'  },
  'john':       { name: 'John',        color: 0xd0a868, colorHex: '#d0a868', initial: 'J'  },
  'dr-claude':  { name: 'Dr. Claude',  color: 0xd07878, colorHex: '#d07878', initial: 'D'  },
  'hiru':       { name: 'Hiru',        color: 0x88b898, colorHex: '#88b898', initial: 'H'  },
};

const DEFAULT_LOCATIONS = {
  'wired-lain': 'lighthouse',
  'lain':       'library',
  'dr-claude':  'school',
  'pkd':        'locksmith',
  'mckenna':    'field',
  'john':       'bar',
  'hiru':       'market',
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
