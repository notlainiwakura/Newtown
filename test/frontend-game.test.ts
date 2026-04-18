/** Frontend Game Tests — isometric game client source analysis. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const GAME_DIR = join(process.cwd(), 'src/web/public/game/js');

function readGame(rel: string): string {
  return readFileSync(join(GAME_DIR, rel), 'utf-8');
}

const fixturesSrc = readGame('fixtures.js');
const configSrc = readGame('config.js');
const spritesSrc = readGame('sprites.js');
const pathfindingSrc = readGame('pathfinding.js');
const apiClientSrc = readGame('systems/APIClient.js');
const charManagerSrc = readGame('systems/CharacterManager.js');

function extractFixtureSpriteKeys(src: string): string[] {
  const keys: string[] = [];
  const re = /^\s{2}(\w+):\s*function\s*\(/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) keys.push(m[1]);
  return keys;
}

const fixtureKeys = extractFixtureSpriteKeys(fixturesSrc);

describe('Fixture sprites — registry and constants', () => {
  it('defines FIXTURE_SPRITES and FIXTURE_SIZE = 48', () => {
    expect(fixturesSrc).toContain('const FIXTURE_SPRITES =');
    expect(fixturesSrc).toContain('const FIXTURE_SIZE = 48');
  });
  it('has at least 15 fixture sprites', () => {
    expect(fixtureKeys.length).toBeGreaterThanOrEqual(15);
  });
  it('contains all expected fixture keys', () => {
    const expected = [
      'armchair_leather', 'desk_writing', 'chair_shaker', 'table_shaker',
      'fossil_ammonite', 'labyrinth_wooden', 'telescope_brass', 'table_lacquered',
      'lamp_desk', 'mirror_obsidian', 'mushroom_psilocybin', 'stone_standing',
      'hourglass_dolmen', 'desk_carved_mushroom', 'stool_meditation', 'table_glass_stone',
    ];
    for (const key of expected) expect(fixtureKeys).toContain(key);
  });
  it('every fixture is a function(ctx, theme)', () => {
    const re = /:\s*function\s*\(ctx,\s*theme\)/g;
    const matches = fixturesSrc.match(re) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(fixtureKeys.length);
  });
  it('all fixtures use FIXTURE_SIZE for canvas dimensions', () => {
    const count = (fixturesSrc.match(/FIXTURE_SIZE/g) ?? []).length;
    expect(count).toBeGreaterThan(fixtureKeys.length);
  });
});
describe('Fixture sprites — drawing API and renderFixtureSprite', () => {
  it('fill/stroke, 20+ beginPath calls, 30+ hex colors, rgba, gradients', () => {
    expect(fixturesSrc).toContain('ctx.fill()');
    expect(fixturesSrc).toContain('ctx.stroke()');
    expect((fixturesSrc.match(/ctx\.beginPath\(\)/g) ?? []).length).toBeGreaterThan(20);
    expect((fixturesSrc.match(/#[0-9a-fA-F]{3,8}/g) ?? []).length).toBeGreaterThan(30);
    expect(fixturesSrc).toContain('rgba(');
    expect(fixturesSrc).toContain('createRadialGradient');
    expect(fixturesSrc).toContain('createLinearGradient');
  });
  it('arc, ellipse, quadraticCurveTo, moveTo, lineTo, closePath all used', () => {
    expect(fixturesSrc).toContain('ctx.arc(');
    expect(fixturesSrc).toContain('ctx.ellipse(');
    expect(fixturesSrc).toContain('ctx.quadraticCurveTo(');
    expect(fixturesSrc).toContain('ctx.moveTo(');
    expect(fixturesSrc).toContain('ctx.closePath()');
    expect(fixturesSrc).toContain('ctx.lineTo(');
  });
  it('renderFixtureSprite: signature, false on missing, creates canvas, refreshes, passes GAME_THEME', () => {
    expect(fixturesSrc).toContain('function renderFixtureSprite(scene, textureKey, spriteId)');
    expect(fixturesSrc).toContain('if (!drawFn) return false');
    expect(fixturesSrc).toContain('scene.textures.exists(textureKey)');
    expect(fixturesSrc).toContain('scene.textures.createCanvas(textureKey, FIXTURE_SIZE, FIXTURE_SIZE)');
    expect(fixturesSrc).toContain('canvas.refresh()');
    expect(fixturesSrc).toContain('drawFn(ctx, GAME_THEME)');
  });
});

describe('Game config — GAME_CONFIG values and building grid', () => {
  it('has display dims, tile sizes, map dims, iso dims, timing constants', () => {
    expect(configSrc).toContain('WIDTH: 1280');
    expect(configSrc).toContain('HEIGHT: 960');
    expect(configSrc).toContain('TILE_SIZE: 64');
    expect(configSrc).toContain('SPRITE_W: 64');
    expect(configSrc).toContain('SPRITE_H: 96');
    expect(configSrc).toContain('MAP_COLS: 64');
    expect(configSrc).toContain('MAP_ROWS: 48');
    expect(configSrc).toContain('ISO_TILE_W: 128');
    expect(configSrc).toContain('ISO_TILE_H: 64');
    expect(configSrc).toContain('MOVE_DURATION:');
    expect(configSrc).toContain('POLL_INTERVAL:');
  });
  it('has all 9 buildings with correct 3x3 row/col positions and BUILDING_MAP', () => {
    const ids = ['library', 'bar', 'field', 'windmill', 'lighthouse', 'school', 'market', 'locksmith', 'threshold'];
    for (const id of ids) expect(configSrc).toContain(`id: '${id}'`);
    expect(configSrc).toMatch(/library.*row:\s*0.*col:\s*0/s);
    expect(configSrc).toMatch(/bar.*row:\s*0.*col:\s*1/s);
    expect(configSrc).toMatch(/field.*row:\s*0.*col:\s*2/s);
    expect(configSrc).toMatch(/threshold.*row:\s*2.*col:\s*2/s);
    expect(configSrc).toContain('const BUILDING_MAP = {}');
    expect(configSrc).toContain('BUILDING_MAP[b.id] = b');
  });
  it('tileToScreen: (tileX-tileY)*halfW, (tileX+tileY)*halfH, MAP_ROWS offset', () => {
    expect(configSrc).toContain('function tileToScreen');
    expect(configSrc).toContain('(tileX - tileY) * halfW');
    expect(configSrc).toContain('GAME_CONFIG.MAP_ROWS * halfW');
    expect(configSrc).toContain('(tileX + tileY) * halfH');
  });
  it('zones: ZONE_SIZE_X=12, ZONE_SIZE_Y=10, PATH_W=4; getBuildingSpawn has (32,24) fallback', () => {
    expect(configSrc).toContain('function getBuildingZone');
    expect(configSrc).toContain('if (!b) return null');
    expect(configSrc).toContain('const ZONE_SIZE_X = 12');
    expect(configSrc).toContain('const ZONE_SIZE_Y = 10');
    expect(configSrc).toContain('const PATH_W = 4');
    expect(configSrc).toContain('function getBuildingSpawn');
    expect(configSrc).toContain('{ x: 32, y: 24 }');
    expect(configSrc).toContain('function getBuildingAtTile');
  });
  it('loadCharacterManifest fetches /api/characters; hashColorHex uses HSL->RGB', () => {
    expect(configSrc).toContain('async function loadCharacterManifest');
    expect(configSrc).toContain("fetch('/api/characters')");
    expect(configSrc).toContain('DEFAULT_LOCATIONS[c.id] = c.defaultLocation');
    expect(configSrc).toContain("c.name.charAt(0).toUpperCase()");
    expect(configSrc).toContain('function _hashColorHex');
    expect(configSrc).toContain('const c = (1 - Math.abs(2 * l - 1)) * s');
    expect(configSrc).toContain('((h % 360) + 360) % 360');
    expect(configSrc).toContain("return '#' + toHex(r) + toHex(g) + toHex(b)");
  });
});

describe('Character sprites — renderPixelSprites and proportions', () => {
  it('iterates CHARACTERS, creates char_{id} canvas with SPRITE_W/H', () => {
    expect(spritesSrc).toContain('function renderPixelSprites');
    expect(spritesSrc).toContain('Object.entries(CHARACTERS)');
    expect(spritesSrc).toContain("scene.textures.createCanvas('char_' + charId");
    expect(spritesSrc).toContain('canvas.refresh()');
    expect(spritesSrc).toContain('GAME_CONFIG.SPRITE_W');
    expect(spritesSrc).toContain('GAME_CONFIG.SPRITE_H');
  });
  it('HEAD_CY=26, HEAD_RX=20; BODY_TOP/BOT constants defined', () => {
    expect(spritesSrc).toContain('HEAD_CY = 26');
    expect(spritesSrc).toContain('HEAD_RX = 20');
    expect(spritesSrc).toContain('HEAD_CX');
    expect(spritesSrc).toContain('BODY_TOP');
    expect(spritesSrc).toContain('BODY_BOT');
  });
  it('draw order: shadow < legs < body; head < hair < face', () => {
    const si = spritesSrc.indexOf('Shadow'), li = spritesSrc.indexOf('Legs'), bi = spritesSrc.indexOf('Main body shape');
    expect(si).toBeLessThan(li);
    expect(li).toBeLessThan(bi);
    const hi = spritesSrc.indexOf('=== HEAD ==='), ri = spritesSrc.indexOf('=== HAIR'), fi = spritesSrc.indexOf('=== FACE ===');
    expect(hi).toBeGreaterThan(0);
    expect(ri).toBeGreaterThan(hi);
    expect(fi).toBeGreaterThan(ri);
  });
  it('extracts RGB bits for body shading; colorHex for iris', () => {
    expect(spritesSrc).toContain('(charData.color >> 16) & 0xff');
    expect(spritesSrc).toContain('(charData.color >> 8) & 0xff');
    expect(spritesSrc).toContain('charData.color & 0xff');
    expect(spritesSrc).toContain('Math.floor(r * 0.6)');
    expect(spritesSrc).toContain('ctx.fillStyle = charData.colorHex');
  });
});
describe('Character sprites — skin and eye system', () => {
  it('getSkinTone/Shadow/Prop with default #dcc8c0; per-char CSS overrides; window export', () => {
    expect(spritesSrc).toContain('function getSkinTone');
    expect(spritesSrc).toContain('function getSkinShadow');
    expect(spritesSrc).toContain('function getSkinProp');
    expect(spritesSrc).toContain("'#dcc8c0'");
    expect(spritesSrc).toContain('skinSpriteConfig?.characters?.[charId]?.[prop]');
    expect(spritesSrc).toContain('window.setSpritesSkinConfig = function(config)');
  });
  it('eyes: left+right pair with eyeWhite, iris colorHex, pupil, white highlight', () => {
    expect(spritesSrc).toContain('[leftEyeX, rightEyeX]');
    expect(spritesSrc).toContain("'eyeWhite'");
    expect(spritesSrc).toContain("'pupil'");
    expect(spritesSrc).toContain("'#ffffff'");
  });
});

describe('Pathfinding — findPath algorithm', () => {
  it('has correct signature and handles same-start-end case', () => {
    expect(pathfindingSrc).toContain('function findPath(collision, sx, sy, ex, ey)');
    expect(pathfindingSrc).toContain('if (sx === ex && sy === ey) return [{ x: sx, y: sy }]');
  });
  it('returns empty array for out-of-bounds, blocked, or empty map', () => {
    expect(pathfindingSrc).toContain('if (!rows) return []');
    expect(pathfindingSrc).toContain('if (sx < 0 || sx >= cols || sy < 0 || sy >= rows) return []');
    expect(pathfindingSrc).toContain('if (collision[sy][sx] || collision[ey][ex]) return []');
  });
  it('uses A* with open list, closed set, gScore, cameFrom', () => {
    expect(pathfindingSrc).toContain('const open = []');
    expect(pathfindingSrc).toContain('const closed = new Set()');
    expect(pathfindingSrc).toContain('const gScore = {}');
    expect(pathfindingSrc).toContain('const cameFrom = {}');
  });
  it('uses Manhattan distance heuristic', () => {
    expect(pathfindingSrc).toContain('Math.abs(x - ex) + Math.abs(y - ey)');
  });
  it('explores only 4 cardinal directions (no diagonals)', () => {
    expect(pathfindingSrc).toContain("{ dx: 1, dy: 0 }");
    expect(pathfindingSrc).toContain("{ dx: -1, dy: 0 }");
    expect(pathfindingSrc).toContain("{ dx: 0, dy: 1 }");
    expect(pathfindingSrc).toContain("{ dx: 0, dy: -1 }");
    expect(pathfindingSrc).not.toContain("{ dx: 1, dy: 1 }");
  });
  it('reconstructs path by reversing cameFrom chain', () => {
    expect(pathfindingSrc).toContain('path.reverse()');
  });
  it('encodes coordinates as "x,y" string keys', () => {
    expect(pathfindingSrc).toContain("function key(x, y) { return x + ',' + y; }");
  });
});

describe('APIClient — structure, auth, and possession endpoints', () => {
  it('class with empty defaults, singleton, Bearer auth, Content-Type, base URL prepend', () => {
    expect(apiClientSrc).toContain('class APIClient');
    expect(apiClientSrc).toContain("this.token = ''");
    expect(apiClientSrc).toContain("this.base = ''");
    expect(apiClientSrc).toContain('const apiClient = new APIClient()');
    expect(apiClientSrc).toContain("'Authorization': 'Bearer ' + this.token");
    expect(apiClientSrc).toContain("'Content-Type': 'application/json'");
    expect(apiClientSrc).toContain('const url = this.base + path');
  });
  it('checkAuth/possess/unpossess endpoints', () => {
    expect(apiClientSrc).toContain("async checkAuth()");
    expect(apiClientSrc).toContain("'/api/possession/status'");
    expect(apiClientSrc).toContain('async possess()');
    expect(apiClientSrc).toContain("'/api/possess'");
    expect(apiClientSrc).toContain('async unpossess()');
  });
  it('move/look/say/getPending/reply methods', () => {
    expect(apiClientSrc).toContain('async move(buildingId)');
    expect(apiClientSrc).toContain("JSON.stringify({ building: buildingId })");
    expect(apiClientSrc).toContain('async look()');
    expect(apiClientSrc).toContain('async say(peerId, message)');
    expect(apiClientSrc).toContain('async getPending()');
    expect(apiClientSrc).toContain('async reply(fromId, message)');
  });
});
describe('APIClient — SSE stream connection', () => {
  it('connectStream uses auth header and parses data: SSE lines', () => {
    expect(apiClientSrc).toContain('async connectStream(onEvent)');
    expect(apiClientSrc).toContain("'/api/possession/stream'");
    expect(apiClientSrc).toContain("startsWith('data: ')");
    expect(apiClientSrc).toContain('onEvent(event)');
  });
  it('reconnects after 5s on stream error', () => {
    expect(apiClientSrc).toContain('setTimeout(() => this.connectStream(onEvent), 5000)');
  });
  it('connectConversationStream connects to /api/conversations/stream with 10s retry', () => {
    expect(apiClientSrc).toContain('connectConversationStream(onEvent)');
    expect(apiClientSrc).toContain("'/api/conversations/stream'");
    expect(apiClientSrc).toContain('setTimeout(connect, 10000)');
  });
});
describe('APIClient — location and object queries', () => {
  it('getCharacterLocation determines host prefix and returns null on failure', () => {
    expect(apiClientSrc).toContain('async getCharacterLocation(charId)');
    expect(apiClientSrc).toContain('isHost = ids.length > 0 && ids[0] === charId');
    expect(apiClientSrc).toContain('return null');
  });
  it('getObjects queries /api/objects with optional location filter', () => {
    expect(apiClientSrc).toContain('async getObjects(location)');
    expect(apiClientSrc).toContain("'/api/objects'");
  });
});

describe('CharacterManager — construction and NPC creation', () => {
  it('initializes sprites, locations, occupiedTiles; createNPCs excludes possessed char', () => {
    expect(charManagerSrc).toContain('this.sprites = {}');
    expect(charManagerSrc).toContain('this.locations = {}');
    expect(charManagerSrc).toContain('this.occupiedTiles = new Set()');
    expect(charManagerSrc).toContain('createNPCs(excludeId)');
    expect(charManagerSrc).toContain('if (charId === excludeId) continue');
  });
  it('groups by building and tracks occupied tiles to prevent overlap', () => {
    expect(charManagerSrc).toContain('byBuilding');
    expect(charManagerSrc).toContain("this.occupiedTiles.has(tx + ',' + ty)");
  });
});
describe('CharacterManager — sprite depth and origin', () => {
  it('uses tileX+tileY depth for z-ordering, (0.5,0.75) origin, charId on sprite', () => {
    expect(charManagerSrc).toContain('sprite.setDepth(tileX + tileY + 0.5)');
    expect(charManagerSrc).toContain('label.setDepth(tileX + tileY + 0.6)');
    expect(charManagerSrc).toContain('sprite.setOrigin(0.5, 0.75)');
    expect(charManagerSrc).toContain('sprite.charId = charId');
  });
});
describe('CharacterManager — idle animations', () => {
  it('breathing tween: scale pulse, random desync delay, repeat:-1; wander 6-18s', () => {
    expect(charManagerSrc).toContain('_startBreathing');
    expect(charManagerSrc).toContain('scaleX: { from: 1.0, to: 1.02 }');
    expect(charManagerSrc).toContain('scaleY: { from: 1.0, to: 0.98 }');
    expect(charManagerSrc).toContain('Math.random() * 2000');
    expect(charManagerSrc).toContain('repeat: -1');
    expect(charManagerSrc).toContain('6000 + Math.random() * 12000');
    expect(charManagerSrc).toContain('Math.random() < 0.3');
    expect(charManagerSrc).toContain('_tryApproachPeer');
  });
});
describe('CharacterManager — building transitions', () => {
  it('updateLocations detects movers, pathfinds, queues pending, stops idle tween+wander', () => {
    expect(charManagerSrc).toContain('updateLocations(allLocations)');
    expect(charManagerSrc).toContain('prev !== loc.building');
    expect(charManagerSrc).toContain('findPath(collision,');
    expect(charManagerSrc).toContain('_fallbackTween');
    expect(charManagerSrc).toContain('entry.pendingBuilding = building');
    expect(charManagerSrc).toContain('entry.idleTween.destroy()');
    expect(charManagerSrc).toContain('entry.wanderTimer.remove()');
  });
});
describe('CharacterManager — query methods and polling', () => {
  it('getCharactersAt, getNearestNPC with Manhattan distance, getLocation', () => {
    expect(charManagerSrc).toContain('getCharactersAt(buildingId)');
    expect(charManagerSrc).toContain('getNearestNPC(tileX, tileY, maxDistance)');
    expect(charManagerSrc).toContain('Math.abs(entry.tileX - tileX) + Math.abs(entry.tileY - tileY)');
    expect(charManagerSrc).toContain('getLocation(charId)');
  });
  it('polls via apiClient.look() with concurrent guard and POLL_INTERVAL', () => {
    expect(charManagerSrc).toContain('apiClient.look()');
    expect(charManagerSrc).toContain('this._polling = true');
    expect(charManagerSrc).toContain('GAME_CONFIG.POLL_INTERVAL');
  });
});
describe('CharacterManager — destroy / cleanup', () => {
  it('destroy stops polling, destroys all sprites and labels, clears tiles', () => {
    expect(charManagerSrc).toContain('destroy()');
    expect(charManagerSrc).toContain('this.stopPolling()');
    expect(charManagerSrc).toContain('entry.sprite.destroy()');
    expect(charManagerSrc).toContain('entry.label.destroy()');
    expect(charManagerSrc).toContain('this.occupiedTiles.clear()');
  });
});

describe('Game theme — CSS variable system and colors', () => {
  it('builds GAME_THEME from CSS vars, rebuilds on skin-changed, provides hex converter', () => {
    expect(configSrc).toContain('function buildGameTheme()');
    expect(configSrc).toContain('var GAME_THEME = buildGameTheme()');
    expect(configSrc).toContain('function getCSSColor');
    expect(configSrc).toContain('getComputedStyle(document.documentElement)');
    expect(configSrc).toContain("'skin-changed'");
    expect(configSrc).toContain('GAME_THEME = buildGameTheme()');
    expect(configSrc).toContain('function getCSSColorHex');
  });
  it('has background/text/accent, tile, speech/HUD color keys', () => {
    expect(configSrc).toContain('bgDeep:');
    expect(configSrc).toContain('textPrimary:');
    expect(configSrc).toContain('accentPrimary:');
    expect(configSrc).toContain('grassMain:');
    expect(configSrc).toContain('pathMain:');
    expect(configSrc).toContain('wallTop:');
    expect(configSrc).toContain('speechText:');
    expect(configSrc).toContain('hudNotif:');
  });
});

describe('Pathfinding — boundary conditions', () => {
  it('skips OOB/blocked/closed neighbors; updates gScore on cheaper path; reconstructs path', () => {
    expect(pathfindingSrc).toContain('if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue');
    expect(pathfindingSrc).toContain('if (collision[ny][nx]) continue');
    expect(pathfindingSrc).toContain('if (closed.has(nk)) continue');
    expect(pathfindingSrc).toContain('tentativeG < gScore[nk]');
    expect(pathfindingSrc).toContain("open[i].f = f");
    expect(pathfindingSrc).toContain('while (k !== undefined)');
    expect(pathfindingSrc).toContain('parts[0]');
  });
});

describe('CharacterManager — walk path management', () => {
  it('_startBuildingWalk sets walkPath/walkIndex=0; _stepWalk advances and finishes', () => {
    expect(charManagerSrc).toContain('_startBuildingWalk(charId, path)');
    expect(charManagerSrc).toContain('entry.walkPath = path');
    expect(charManagerSrc).toContain('entry.walkIndex = 0');
    expect(charManagerSrc).toContain('entry.walkIndex++');
    expect(charManagerSrc).toContain('entry.walkIndex >= entry.walkPath.length');
    expect(charManagerSrc).toContain('_finishBuildingWalk');
  });
  it('_interruptWalk frees old dest tile; _finishBuildingWalk resumes idle+wander; squash anim', () => {
    expect(charManagerSrc).toContain('_interruptWalk');
    expect(charManagerSrc).toContain("oldDest = entry.walkPath[entry.walkPath.length - 1]");
    expect(charManagerSrc).toContain('entry.pendingBuilding = null');
    expect(charManagerSrc).toContain('entry.walkPath = null');
    expect(charManagerSrc).toContain('_startBreathing(charId)');
    expect(charManagerSrc).toContain('_scheduleWander(charId)');
    expect(charManagerSrc).toContain('scaleX: 0.95');
    expect(charManagerSrc).toContain('scaleY: 1.05');
  });
});
describe('CharacterManager — tile picking helpers', () => {
  it('_pickTileInBuilding uses 1-tile inset, falls back to spawn; adjacent shuffles; near sorts by dist', () => {
    expect(charManagerSrc).toContain('dx = 1; dx < zone.w - 1');
    expect(charManagerSrc).toContain('dy = 2; dy < zone.h - 1');
    expect(charManagerSrc).toContain('getBuildingSpawn(buildingId)');
    expect(charManagerSrc).toContain('dirs.length - 1; i > 0; i--');
    expect(charManagerSrc).toContain('dy = -2; dy <= 2');
    expect(charManagerSrc).toContain('candidates.sort((a, b) => a.dist - b.dist)');
  });
});

describe('Fixture sprites — Library fixtures', () => {
  it('armchair_leather has tufting, desk_writing has brass pull, table_glass_stone has stone', () => {
    expect(fixturesSrc.slice(fixturesSrc.indexOf('armchair_leather'), fixturesSrc.indexOf('armchair_leather') + 600)).toContain('button');
    expect(fixturesSrc).toContain('Drawer pull');
    expect(fixturesSrc).toContain("'#c0a040'");
    expect(fixturesSrc).toContain('River stone');
    expect(fixturesSrc).toContain('Glass surface');
  });
});
describe('Fixture sprites — Field fixtures', () => {
  it('fossil has spiral+iridescence, mushroom has cap+spore, stone has petroglyphs+glow', () => {
    expect(fixturesSrc).toContain('Spiral lines');
    expect(fixturesSrc).toContain('iridescent');
    expect(fixturesSrc).toContain('spore');
    expect(fixturesSrc).toContain('Cap');
    expect(fixturesSrc).toContain('petroglyph');
    expect(fixturesSrc).toContain('vibGlow');
    expect(fixturesSrc).toContain('sand stream');
    expect(fixturesSrc).toContain('bioluminescent');
  });
});
describe('Fixture sprites — Lighthouse fixtures', () => {
  it('telescope has tripod+lens, lamp has glow+beam+elbow, mirror has obsidian+reflection', () => {
    expect(fixturesSrc).toContain('Tripod legs');
    expect(fixturesSrc).toContain('Lens glass');
    expect(fixturesSrc).toContain('Warm glow');
    expect(fixturesSrc).toContain('Light beam');
    expect(fixturesSrc).toContain('elbow');
    expect(fixturesSrc).toContain('obsidian');
    expect(fixturesSrc).toContain('reflect');
  });
});

describe('Game config — zone layout math and color API', () => {
  it('uses ZONE_PADDING_X=8/Y=5, zone strides by (ZONE_SIZE+PATH_W), w/h match constants', () => {
    expect(configSrc).toContain('ZONE_PADDING_X = 8');
    expect(configSrc).toContain('ZONE_PADDING_Y = 5');
    expect(configSrc).toContain('b.col * (ZONE_SIZE_X + PATH_W)');
    expect(configSrc).toContain('b.row * (ZONE_SIZE_Y + PATH_W)');
    expect(configSrc).toContain('w: ZONE_SIZE_X');
    expect(configSrc).toContain('h: ZONE_SIZE_Y');
  });
  it('getCharacterColor reads --color-{charId} CSS var and converts to Phaser int', () => {
    expect(configSrc).toContain('function getCharacterColor');
    expect(configSrc).toContain('`--color-${charId}`');
    expect(configSrc).toContain("parseInt(hex.replace('#', ''), 16)");
  });
});

describe('CharacterManager — wander behavior', () => {
  it('skips if wandering/mid-walk; frees+claims tiles; bounce anim; label follows sprite', () => {
    expect(charManagerSrc).toContain('entry.isWandering || entry.walkPath');
    expect(charManagerSrc).toContain("occupiedTiles.delete(entry.tileX + ',' + entry.tileY)");
    expect(charManagerSrc).toContain("occupiedTiles.add(targetTile.x + ',' + targetTile.y)");
    expect(charManagerSrc).toContain('y: entry.sprite.y - 4');
    expect(charManagerSrc).toContain('stepBounce');
    expect(charManagerSrc).toContain('entry.label.x = entry.sprite.x');
    expect(charManagerSrc).toContain('entry.label.y = entry.sprite.y -');
  });
});

describe('APIClient — SSE stream buffer management', () => {
  it('buffers partial lines across reads; loops until done', () => {
    expect(apiClientSrc).toContain("buffer += decoder.decode(value, { stream: true })");
    expect(apiClientSrc).toContain("const lines = buffer.split('\\n')");
    expect(apiClientSrc).toContain("buffer = lines.pop() || ''");
    expect(apiClientSrc).toContain('while (true)');
    expect(apiClientSrc).toContain('if (done) break');
  });
});

describe('Fixture sprites — stool, labyrinth, shaker details', () => {
  it('stool has rings+vine, labyrinth has 3 rings+center, chair has rungs, table has tapered legs', () => {
    expect(fixturesSrc).toContain('concentric ring');
    expect(fixturesSrc).toContain('vine motif');
    expect(fixturesSrc).toContain('Ring 1 (outer)');
    expect(fixturesSrc).toContain('Ring 2');
    expect(fixturesSrc).toContain('Center point');
    expect(fixturesSrc).toContain('Ladder-back rungs');
    expect(fixturesSrc).toContain('4 simple tapered legs');
  });
});

describe('Character sprites — body detail', () => {
  it('draws legs/shoes/arms/hands/neck/ears/brows/nose/melancholy mouth/blush', () => {
    expect(spritesSrc).toContain('#2a2030');
    expect(spritesSrc).toContain('#3a2838');
    expect(spritesSrc).toContain('Left arm');
    expect(spritesSrc).toContain('Right arm');
    expect(spritesSrc).toContain('Hands');
    expect(spritesSrc).toContain('Neck');
    expect(spritesSrc).toContain('Ears');
    expect(spritesSrc).toContain('Eyebrows');
    expect(spritesSrc).toContain('Nose');
    expect(spritesSrc).toContain('melancholy');
    expect(spritesSrc).toContain('Blush');
    expect(spritesSrc).toContain('rgba(200, 120, 140, 0.15)');
  });
});

describe('APIClient — possession error handling', () => {
  it('possess/unpossess/move throw server error; look throws generic; getPending returns []', () => {
    expect(apiClientSrc).toContain("data.error || 'Possess failed'");
    expect(apiClientSrc).toContain("data.error || 'Unpossess failed'");
    expect(apiClientSrc).toContain("data.error || 'Move failed'");
    expect(apiClientSrc).toContain("throw new Error('Look failed')");
    expect(apiClientSrc).toContain('if (!resp.ok) return []');
  });
});

describe('Pathfinding — open list management', () => {
  it('starts at g=0; picks lowest-f; updates in-place; reads map dims', () => {
    expect(pathfindingSrc).toContain('gScore[startKey] = 0');
    expect(pathfindingSrc).toContain('open.push({ x: sx, y: sy, f: heuristic(sx, sy) })');
    expect(pathfindingSrc).toContain('let bestIdx = 0');
    expect(pathfindingSrc).toContain('open[i].f < open[bestIdx].f');
    expect(pathfindingSrc).toContain('open.splice(bestIdx, 1)');
    expect(pathfindingSrc).toContain("open[i].x === nx && open[i].y === ny");
    expect(pathfindingSrc).toContain('const rows = collision.length');
    expect(pathfindingSrc).toContain('const cols = collision[0].length');
  });
});

describe('Fixture sprites — canvas state and transforms', () => {
  it('save/restore count matches (ctx state isolation)', () => {
    const saves = (fixturesSrc.match(/ctx\.save\(\)/g) ?? []).length;
    const restores = (fixturesSrc.match(/ctx\.restore\(\)/g) ?? []).length;
    expect(saves).toBe(restores);
    expect(saves).toBeGreaterThanOrEqual(2);
  });
  it('uses ctx.translate for centering and ctx.rotate for angled elements', () => {
    expect(fixturesSrc).toContain('ctx.translate(');
    expect(fixturesSrc).toContain('ctx.rotate(');
  });
  it('table_lacquered has lacquer sheen; armchair has tufted button and arm', () => {
    expect(fixturesSrc).toContain('lacquer');
    const armSrc = fixturesSrc.slice(fixturesSrc.indexOf('armchair_leather'), fixturesSrc.indexOf('armchair_leather') + 1200);
    expect(armSrc).toContain('button');
    expect(armSrc).toContain('arm');
  });
});

describe('Game config — map dimension usage', () => {
  it('MAP_COLS and MAP_ROWS referenced in isometric formula', () => {
    expect(configSrc).toContain('MAP_COLS: 64');
    expect(configSrc).toContain('MAP_ROWS: 48');
    expect(configSrc).toContain('GAME_CONFIG.MAP_ROWS * halfW');
  });
  it('getBuildingAtTile uses zone bounds check with x/y/w/h', () => {
    expect(configSrc).toContain('getBuildingAtTile');
    expect(configSrc).toContain('zone.x');
    expect(configSrc).toContain('zone.y');
  });
  it('BUILDINGS is exported at module level for map/game use', () => {
    expect(configSrc).toContain('const BUILDINGS = [');
  });
});

describe('CharacterManager — peer approach', () => {
  it('_tryApproachPeer defined and uses _pickAdjacentTile', () => {
    expect(charManagerSrc).toContain('_tryApproachPeer');
    expect(charManagerSrc).toContain('_pickAdjacentTile');
  });
  it('filters same-building characters for peer selection', () => {
    expect(charManagerSrc).toContain('otherBuilding !== building');
  });
});
describe('CharacterManager — polling timer', () => {
  it('uses Phaser time.addEvent at POLL_INTERVAL with loop:true', () => {
    expect(charManagerSrc).toContain('this.scene.time.addEvent');
    expect(charManagerSrc).toContain('GAME_CONFIG.POLL_INTERVAL');
    expect(charManagerSrc).toContain('loop: true');
  });
  it('stopPolling removes Phaser timer and nulls pollTimer', () => {
    expect(charManagerSrc).toContain('stopPolling');
    expect(charManagerSrc).toContain('this.pollTimer.remove()');
    expect(charManagerSrc).toContain('this.pollTimer = null');
  });
});

describe('Character sprites — hair rendering', () => {
  it('getSkinProp includes hairColor; hairLight used for highlight', () => {
    expect(spritesSrc).toContain("getSkinProp(charId, 'hairColor'");
    expect(spritesSrc).toContain('hairLight');
    expect(spritesSrc).toContain('=== HAIR');
  });
  it('default hairColor and hairLight defined in fallback config', () => {
    expect(spritesSrc).toContain("hairColor: '#3a3030'");
    expect(spritesSrc).toContain("hairLight: '#4a4040'");
  });
});
describe('Character sprites — label and color data', () => {
  it('reads charData.color for body shading and charData.colorHex for iris', () => {
    expect(spritesSrc).toContain('charData.color');
    expect(spritesSrc).toContain('charData.colorHex');
  });
  it('creates canvas named char_{charId} for each character', () => {
    expect(spritesSrc).toContain("'char_' + charId");
  });
});

describe('CharacterManager — scene integration', () => {
  it('constructor takes scene parameter and accesses scene.collisionMap', () => {
    expect(charManagerSrc).toContain('constructor(scene)');
    expect(charManagerSrc).toContain('this.scene = scene');
    expect(charManagerSrc).toContain('this.scene.collisionMap');
  });
  it('NPC sprite created with scene.add.sprite using char_ texture key', () => {
    expect(charManagerSrc).toContain("scene.add.sprite");
    expect(charManagerSrc).toContain("'char_' + charId");
  });
  it('NPC label created with scene.add.text showing charData.name', () => {
    expect(charManagerSrc).toContain('scene.add.text');
    expect(charManagerSrc).toContain('charData.name');
    expect(charManagerSrc).toContain('GAME_CONFIG.SPRITE_H + 8');
  });
  it('label positioned relative to sprite Y minus SPRITE_H during movement', () => {
    expect(charManagerSrc).toContain('entry.label.y = entry.sprite.y - GAME_CONFIG.SPRITE_H + 8');
  });
});
describe('CharacterManager — fallback tween', () => {
  it('_fallbackTween uses tileToScreen for pixel target', () => {
    expect(charManagerSrc).toContain('_fallbackTween(charId, tile)');
    expect(charManagerSrc).toContain('tileToScreen(tile.x, tile.y)');
  });
  it('_fallbackTween updates tileX/tileY and sets depth on completion', () => {
    expect(charManagerSrc).toContain('entry.tileX = tile.x');
    expect(charManagerSrc).toContain('entry.tileY = tile.y');
    expect(charManagerSrc).toContain('entry.tileX + entry.tileY + 0.5');
  });
});

describe('APIClient — token and base URL management', () => {
  it('setToken and getToken manage auth token', () => {
    expect(apiClientSrc).toContain('setToken(token)');
    expect(apiClientSrc).toContain('this.token = token');
    expect(apiClientSrc).toContain('getToken()');
    expect(apiClientSrc).toContain('return this.token');
  });
  it('getCharacterLocation builds prefix from first character in manifest', () => {
    expect(apiClientSrc).toContain('const prefix = isHost');
    expect(apiClientSrc).toContain("'/api/location'");
  });
});

describe('Game config — game constants completeness', () => {
  it('has MOVE_DURATION and POLL_INTERVAL for animation/polling', () => {
    expect(configSrc).toContain('MOVE_DURATION:');
    expect(configSrc).toContain('POLL_INTERVAL:');
  });
  it('GAME_CONFIG is declared as const at module level', () => {
    expect(configSrc).toContain('const GAME_CONFIG = {');
  });
  it('BUILDINGS array and BUILDING_MAP lookup both exported', () => {
    expect(configSrc).toContain('const BUILDINGS = [');
    expect(configSrc).toContain('const BUILDING_MAP = {}');
  });
});

describe('Pathfinding — path reconstruction', () => {
  it('pops from closed node chain to build forward path', () => {
    expect(pathfindingSrc).toContain('path.push');
    expect(pathfindingSrc).toContain('path.reverse()');
    expect(pathfindingSrc).toContain('return path');
  });
  it('returns empty path when open list exhausted (no route)', () => {
    expect(pathfindingSrc).toContain('while (open.length > 0)');
    expect(pathfindingSrc).toContain('return []');
  });
  it('closes current node before exploring neighbors', () => {
    expect(pathfindingSrc).toContain('closed.add(ck2)');
  });
  it('heuristic computes Manhattan distance to end tile', () => {
    expect(pathfindingSrc).toContain('function heuristic');
    expect(pathfindingSrc).toContain('Math.abs(x - ex) + Math.abs(y - ey)');
  });
  it('key function encodes coordinates as x,y string', () => {
    expect(pathfindingSrc).toContain("x + ',' + y");
  });
});
describe('Fixture sprites — registry counts', () => {
  it('has exactly 16 keys; first=armchair_leather, last=table_glass_stone', () => {
    expect(fixtureKeys.length).toBe(16);
    expect(fixtureKeys[0]).toBe('armchair_leather');
    expect(fixtureKeys[fixtureKeys.length - 1]).toBe('table_glass_stone');
    expect((fixturesSrc.match(/FIXTURE_SIZE/g) ?? []).length).toBeGreaterThan(16);
  });
});
describe('Game config — coordinate helpers', () => {
  it('getCSSColor/getCharacterColor/_hashColorHex/tileToScreen/getBuildingZone defined', () => {
    expect(configSrc).toContain('function getCSSColor');
    expect(configSrc).toContain('getPropertyValue(');
    expect(configSrc).toContain('function getCharacterColor');
    expect(configSrc).toContain('function _hashColorHex');
    expect(configSrc).toContain('GAME_CONFIG.ISO_TILE_W');
    expect(configSrc).toContain('GAME_CONFIG.ISO_TILE_H');
    expect(configSrc).toContain('w: ZONE_SIZE_X');
    expect(configSrc).toContain('h: ZONE_SIZE_Y');
  });
});
describe('Character sprites — additional rendering details', () => {
  it('getSkinShadow defined; skinSpriteConfig optional chain; eyes symmetric; hair props', () => {
    expect(spritesSrc).toContain('renderPixelSprites');
    expect(spritesSrc).toContain('function getSkinShadow');
    expect(spritesSrc).toContain('skinSpriteConfig?.characters?.[charId]?.[prop]');
    expect(spritesSrc).toContain('leftEyeX');
    expect(spritesSrc).toContain('rightEyeX');
    expect(spritesSrc).toContain("getSkinProp(charId, 'hairColor'");
    expect(spritesSrc).toContain('hairLight');
  });
});
describe('CharacterManager — NPC lifecycle', () => {
  it('inits locations/occupiedTiles; DEFAULT_LOCATIONS fallback; destroy all; polling guard', () => {
    expect(charManagerSrc).toContain('this.locations = {}');
    expect(charManagerSrc).toContain('this.occupiedTiles = new Set()');
    expect(charManagerSrc).toContain('DEFAULT_LOCATIONS[charId]');
    expect(charManagerSrc).toContain('Object.values(this.sprites)');
    expect(charManagerSrc).toContain('entry.sprite.destroy()');
    expect(charManagerSrc).toContain('entry.label.destroy()');
    expect(charManagerSrc).toContain('if (this._polling) return');
    expect(charManagerSrc).toContain('this._polling = true');
  });
  it('getCharactersAt and getNearestNPC Manhattan distance query', () => {
    expect(charManagerSrc).toContain('getCharactersAt(buildingId)');
    expect(charManagerSrc).toContain('getNearestNPC(tileX, tileY, maxDistance)');
    expect(charManagerSrc).toContain('Math.abs(entry.tileX - tileX) + Math.abs(entry.tileY - tileY)');
  });
});
// Additional targeted tests
describe('Fixture sprites — drawing primitives', () => {
  it('uses ctx.strokeStyle for outline color', () => { expect(fixturesSrc).toContain('ctx.strokeStyle'); });
  it('uses ctx.lineWidth for stroke thickness', () => { expect(fixturesSrc).toContain('ctx.lineWidth'); });
  it('uses ctx.fillStyle before fill calls', () => { expect(fixturesSrc).toContain('ctx.fillStyle'); });
  it('uses GAME_THEME colors in fixtures', () => { expect(fixturesSrc).toContain('GAME_THEME'); });
  it('renderFixtureSprite returns true on success, false on unknown spriteId', () => { expect(fixturesSrc).toContain('return true'); expect(fixturesSrc).toContain('return false'); });
});
describe('Pathfinding — algorithm invariants', () => {
  it('gScore[nk] undefined check prevents revisiting better paths', () => { expect(pathfindingSrc).toContain('gScore[nk] === undefined'); });
  it('heuristic called for new open nodes', () => { expect(pathfindingSrc).toContain('heuristic(nx, ny)'); });
  it('f = tentativeG + heuristic for priority ordering', () => { expect(pathfindingSrc).toContain('const f = tentativeG + heuristic(nx, ny)'); });
  it('tentativeG = currentG + 1 (unit cost)', () => { expect(pathfindingSrc).toContain('const tentativeG = currentG + 1'); });
  it('path built from end backwards through cameFrom', () => { expect(pathfindingSrc).toContain('cameFrom[k]'); });
});
describe('APIClient — additional endpoint details', () => {
  it('say encodes peerId and message in request body', () => { expect(apiClientSrc).toContain("JSON.stringify({ peerId, message })"); });
  it('reply encodes fromId and message in request body', () => { expect(apiClientSrc).toContain("JSON.stringify({ fromId, message })"); });
  it('look returns allLocations in response', () => { expect(apiClientSrc).toContain('allLocations'); });
  it('getPending response shape has fromId and fromName', () => { expect(apiClientSrc).toContain('fromId'); });
  it('getObjects builds query string with encodeURIComponent', () => { expect(apiClientSrc).toContain("encodeURIComponent(location)"); });
});
describe('Game config — building properties', () => {
  it('each building has a name string property', () => { expect(configSrc).toContain("name: '"); });
  it('buildings define entrance points or zones with x/y properties', () => { expect(configSrc).toContain('zone.x'); });
  it('getBuildingSpawn computes zone center with Math.floor', () => { expect(configSrc).toContain('Math.floor(zone.w / 2)'); });
  it('ZONE_PADDING constants define map border offset', () => { expect(configSrc).toContain('ZONE_PADDING_X'); });
  it('_hashColorHex padStart ensures two-hex-digit format', () => { expect(configSrc).toContain(".padStart(2, '0')"); });
});
describe('Character sprites — shadow and body detail', () => {
  it('draws elliptical shadow below character feet', () => { expect(spritesSrc).toContain('Shadow'); expect(spritesSrc).toContain('ctx.ellipse('); });
  it('blush uses low-opacity rgba for subtle effect', () => { expect(spritesSrc).toContain('rgba(200, 120, 140, 0.15)'); });
  it('shirt/body uses character primary color', () => { expect(spritesSrc).toContain('Main body shape'); });
  it('face section clearly delineated with === FACE === comment', () => { expect(spritesSrc).toContain('=== FACE ==='); });
});
describe('CharacterManager — sprite appearance', () => {
  it('sprite origin set to (0.5, 0.75) for foot-based positioning', () => { expect(charManagerSrc).toContain('sprite.setOrigin(0.5, 0.75)'); });
  it('sprite depth uses tileX+tileY for isometric z-ordering', () => { expect(charManagerSrc).toContain('sprite.setDepth(tileX + tileY'); });
  it('label depth offset above sprite by 0.1', () => { expect(charManagerSrc).toContain('tileX + tileY + 0.6'); });
  it('charId stored on sprite object for hit testing', () => { expect(charManagerSrc).toContain('sprite.charId = charId'); });
  it('setScale(1,1) resets scale after breathing tween', () => { expect(charManagerSrc).toContain('entry.sprite.setScale(1, 1)'); });
});
