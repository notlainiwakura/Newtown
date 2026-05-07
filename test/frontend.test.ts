/**
 * Frontend JS structural tests
 * Validates the structure and conventions of vanilla JS files in src/web/public/
 * by reading them with readFileSync and testing for expected patterns.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn().mockResolvedValue('test-master-key'),
    setPassword: vi.fn().mockResolvedValue(undefined),
    deletePassword: vi.fn().mockResolvedValue(true),
    findCredentials: vi.fn().mockResolvedValue([]),
  },
}));

const PUBLIC_DIR = join(process.cwd(), 'src/web/public');

function readPublicFile(relativePath: string): string {
  return readFileSync(join(PUBLIC_DIR, relativePath), 'utf-8');
}

// ============================================================================
// Config (game/js/config.js)
// ============================================================================

describe('Game Config (config.js)', () => {
  const src = readPublicFile('game/js/config.js');

  describe('GAME_CONFIG properties', () => {
    it('should define GAME_CONFIG object', () => {
      expect(src).toContain('const GAME_CONFIG');
    });

    it('should have WIDTH property', () => {
      expect(src).toMatch(/WIDTH:\s*\d+/);
    });

    it('should have HEIGHT property', () => {
      expect(src).toMatch(/HEIGHT:\s*\d+/);
    });

    it('should have TILE_SIZE property', () => {
      expect(src).toMatch(/TILE_SIZE:\s*\d+/);
    });

    it('should have MAP_COLS property', () => {
      expect(src).toMatch(/MAP_COLS:\s*\d+/);
    });

    it('should have MAP_ROWS property', () => {
      expect(src).toMatch(/MAP_ROWS:\s*\d+/);
    });
  });

  describe('GAME_CONFIG values are reasonable', () => {
    function extractNumber(key: string): number {
      const match = src.match(new RegExp(`${key}:\\s*(\\d+)`));
      return match ? parseInt(match[1]!, 10) : 0;
    }

    it('WIDTH should be greater than 0', () => {
      expect(extractNumber('WIDTH')).toBeGreaterThan(0);
    });

    it('HEIGHT should be greater than 0', () => {
      expect(extractNumber('HEIGHT')).toBeGreaterThan(0);
    });

    it('TILE_SIZE should be greater than 0', () => {
      expect(extractNumber('TILE_SIZE')).toBeGreaterThan(0);
    });

    it('MAP_COLS should be greater than 0', () => {
      expect(extractNumber('MAP_COLS')).toBeGreaterThan(0);
    });

    it('MAP_ROWS should be greater than 0', () => {
      expect(extractNumber('MAP_ROWS')).toBeGreaterThan(0);
    });
  });

  describe('BUILDINGS array', () => {
    it('should have exactly 9 building entries', () => {
      // Count the building IDs in the BUILDINGS array
      const buildingIds = src.match(/id:\s*'[a-z]+'/g);
      // The file defines BUILDINGS and BUILDING_META may re-use the ids.
      // The BUILDINGS const specifically has 9 entries.
      expect(buildingIds).not.toBeNull();
      // The BUILDINGS array (first occurrence) has 9 entries
      const buildingsBlock = src.match(/const BUILDINGS\s*=\s*\[([\s\S]*?)\];/);
      expect(buildingsBlock).not.toBeNull();
      const entries = buildingsBlock![1]!.match(/\{[^}]+\}/g);
      expect(entries).toHaveLength(9);
    });

    it('each building entry should have id property', () => {
      const buildingsBlock = src.match(/const BUILDINGS\s*=\s*\[([\s\S]*?)\];/);
      expect(buildingsBlock).not.toBeNull();
      const entries = buildingsBlock![1]!.match(/\{[^}]+\}/g) || [];
      for (const entry of entries) {
        expect(entry).toMatch(/id:\s*'/);
      }
    });

    it('each building entry should have name property', () => {
      const buildingsBlock = src.match(/const BUILDINGS\s*=\s*\[([\s\S]*?)\];/);
      expect(buildingsBlock).not.toBeNull();
      const entries = buildingsBlock![1]!.match(/\{[^}]+\}/g) || [];
      for (const entry of entries) {
        expect(entry).toMatch(/name:\s*'/);
      }
    });
  });

  describe('functions', () => {
    it('should define loadCharacterManifest function', () => {
      expect(src).toMatch(/async function loadCharacterManifest\s*\(/);
    });

    it('should define _hashColorHex function', () => {
      expect(src).toMatch(/function _hashColorHex\s*\(/);
    });

    it('should define getBuildingZone function', () => {
      expect(src).toMatch(/function getBuildingZone\s*\(/);
    });

    it('should define tileToScreen function', () => {
      expect(src).toMatch(/function tileToScreen\s*\(/);
    });
  });

  describe('isometric constants', () => {
    it('should define ISO_TILE_W', () => {
      expect(src).toMatch(/ISO_TILE_W:\s*\d+/);
    });

    it('should define ISO_TILE_H', () => {
      expect(src).toMatch(/ISO_TILE_H:\s*\d+/);
    });
  });
});

// ============================================================================
// Sprites (game/js/sprites.js)
// ============================================================================

describe('Sprites (sprites.js)', () => {
  const src = readPublicFile('game/js/sprites.js');

  it('should define defaultVisual object', () => {
    expect(src).toContain('const defaultVisual');
  });

  it('defaultVisual should be a generic character appearance', () => {
    // defaultVisual should contain hairColor and outfit-related properties
    expect(src).toMatch(/defaultVisual\s*=\s*\{[\s\S]*?hairColor/);
  });

  it('charVisuals should be defined as empty object', () => {
    // Platform ships without character-specific visuals
    expect(src).toMatch(/const charVisuals\s*=\s*\{\s*\}/);
  });

  it('should define renderPixelSprites function', () => {
    expect(src).toMatch(/function renderPixelSprites\s*\(/);
  });

  it('sprite dimensions should use W=64', () => {
    expect(src).toMatch(/const W\s*=\s*GAME_CONFIG\.SPRITE_W/);
    // From config.js, SPRITE_W is 64
  });

  it('sprite dimensions should use H=96', () => {
    expect(src).toMatch(/const H\s*=\s*GAME_CONFIG\.SPRITE_H/);
    // From config.js, SPRITE_H is 96
  });

  it('should not have hardcoded character names in charVisuals', () => {
    // charVisuals should be empty
    const match = src.match(/const charVisuals\s*=\s*(\{[^}]*\})/);
    expect(match).not.toBeNull();
    expect(match![1]!.trim()).toBe('{}');
  });

  it('should define getSkinProp function with cascading fallback', () => {
    expect(src).toMatch(/function getSkinProp\s*\(/);
    // Should check character-specific, then global, then fallback
    expect(src).toMatch(/skinSpriteConfig\?\.\s*characters\?\.\[charId\]/);
    expect(src).toMatch(/skinSpriteConfig\?\.\[prop\]/);
    expect(src).toContain('return fallback');
  });
});

// ============================================================================
// APIClient (game/js/systems/APIClient.js)
// ============================================================================

describe('APIClient (APIClient.js)', () => {
  const src = readPublicFile('game/js/systems/APIClient.js');

  it('should define APIClient class', () => {
    expect(src).toMatch(/class APIClient\s*\{/);
  });

  describe('API methods existence', () => {
    it('should have checkAuth method', () => {
      expect(src).toMatch(/async checkAuth\s*\(/);
    });

    it('should have possess method', () => {
      expect(src).toMatch(/async possess\s*\(/);
    });

    it('should have unpossess method', () => {
      expect(src).toMatch(/async unpossess\s*\(/);
    });

    it('should have move method', () => {
      expect(src).toMatch(/async move\s*\(/);
    });

    it('should have look method', () => {
      expect(src).toMatch(/async look\s*\(/);
    });

    it('should have say method', () => {
      expect(src).toMatch(/async say\s*\(/);
    });

    it('should have getPending method', () => {
      expect(src).toMatch(/async getPending\s*\(/);
    });

    it('should have reply method', () => {
      expect(src).toMatch(/async reply\s*\(/);
    });
  });

  it('should define connectStream method', () => {
    expect(src).toMatch(/async connectStream\s*\(/);
  });

  it('should define connectConversationStream method', () => {
    expect(src).toMatch(/connectConversationStream\s*\(/);
  });

  it('getCharacterLocation should use dynamic prefix (not hardcoded)', () => {
    // The method should compute prefix based on CHARACTERS, not use a hardcoded path
    expect(src).toMatch(/async getCharacterLocation\s*\(charId\)/);
    expect(src).toMatch(/const prefix\s*=\s*isHost\s*\?\s*''\s*:\s*'\/'\s*\+\s*charId/);
  });

  it('should set Authorization header with Bearer token', () => {
    expect(src).toMatch(/'Authorization':\s*'Bearer\s*'\s*\+\s*this\.token/);
  });

  it('should set Content-Type to application/json', () => {
    expect(src).toMatch(/'Content-Type':\s*'application\/json'/);
  });

  it('should have stream reconnect on error (setTimeout pattern)', () => {
    // connectStream should use setTimeout for reconnection
    expect(src).toMatch(/setTimeout\(\s*\(\)\s*=>\s*this\.connectStream/);
  });

  it('should not contain hardcoded character IDs', () => {
    // No specific character IDs like 'lain', 'wired-lain', 'pkd' etc.
    expect(src).not.toMatch(/['"]lain['"]/);
    expect(src).not.toMatch(/['"]wired-lain['"]/);
    expect(src).not.toMatch(/['"]pkd['"]/);
    expect(src).not.toMatch(/['"]mckenna['"]/);
  });

  it('should not contain hardcoded paths to character servers', () => {
    expect(src).not.toMatch(/localhost:\d{4}/);
  });
});

// ============================================================================
// Scenes
// ============================================================================

describe('TitleScene (TitleScene.js)', () => {
  const src = readPublicFile('game/js/scenes/TitleScene.js');

  it('should define TitleScene class', () => {
    expect(src).toMatch(/class TitleScene\s+extends\s+Phaser\.Scene/);
  });

  it('should support spectator mode', () => {
    expect(src).toContain('spectator mode');
    expect(src).toContain('spectatorMode');
  });

  it('should detect non-owner for spectator mode', () => {
    expect(src).toMatch(/const isOwner\s*=\s*document\.querySelector.*lain-owner/);
    expect(src).toMatch(/if\s*\(\s*!isOwner\s*\)/);
  });

  it('owner mode should auto-enter (no token prompt)', () => {
    // Owner path should start BootScene directly (via delayedCall)
    expect(src).toContain("this.scene.start('BootScene'");
    expect(src).toContain('entering the wired');
  });
});

describe('DialogScene (DialogScene.js)', () => {
  const src = readPublicFile('game/js/scenes/DialogScene.js');

  it('should define DialogScene class', () => {
    expect(src).toMatch(/class DialogScene\s+extends\s+Phaser\.Scene/);
  });

  it('CANNED_RESPONSES._default should exist', () => {
    expect(src).toMatch(/const CANNED_RESPONSES\s*=\s*\{/);
    expect(src).toMatch(/'_default'\s*:\s*\[/);
  });

  it('CANNED_RESPONSES._default should have generic responses (not character-specific)', () => {
    // Extract the _default responses block
    const defaultBlock = src.match(/'_default'\s*:\s*\[([\s\S]*?)\]/);
    expect(defaultBlock).not.toBeNull();
    const responses = defaultBlock![1]!;
    // Should contain generic phrases
    expect(responses).toContain('connection');
  });

  it('should not have character-specific canned response keys', () => {
    // CANNED_RESPONSES should only have _default, no specific character IDs
    const cannedBlock = src.match(/const CANNED_RESPONSES\s*=\s*\{([\s\S]*?)\};/);
    expect(cannedBlock).not.toBeNull();
    const keys = cannedBlock![1]!.match(/['"][a-z-]+['"]\s*:/g) || [];
    // All keys should be '_default' only
    for (const key of keys) {
      expect(key).toMatch(/'_default'\s*:/);
    }
  });

  it('should use fallback to _default for unknown characters', () => {
    expect(src).toMatch(/CANNED_RESPONSES\[this\.charId\]\s*\|\|\s*CANNED_RESPONSES\['_default'\]/);
  });
});

describe('WorldScene (WorldScene.js)', () => {
  const src = readPublicFile('game/js/scenes/WorldScene.js');

  it('should define WorldScene class', () => {
    expect(src).toMatch(/class WorldScene\s+extends\s+Phaser\.Scene/);
  });

  it('player character should be dynamic (from authData or manifest, not hardcoded)', () => {
    // findings.md P2:3216 — explicit precedence chain: authData.characterId,
    // then the configured possessable character, then WEB_CHARACTER_ID
    // (driven by /api/characters), then null which triggers _renderFatalError.
    // No silent first-in-manifest fallback.
    expect(src).toMatch(
      /const playerCharId\s*=\s*this\.authData\.characterId\s*\n?\s*\|\|\s*\(this\.authData\.spectatorMode\s*\?\s*null\s*:\s*POSSESSABLE_CHARACTER_ID\)\s*\n?\s*\|\|\s*WEB_CHARACTER_ID\s*\n?\s*\|\|\s*null/,
    );
    expect(src).toContain('_renderFatalError');
  });

  it('should not hardcode any character ID for player', () => {
    // The playerCharId assignment spans multiple lines — match across
    // newlines to capture the full precedence chain.
    const playerLine = src.match(/const playerCharId\s*=[\s\S]*?;/);
    expect(playerLine).not.toBeNull();
    expect(playerLine![0]).not.toContain("'lain'");
    expect(playerLine![0]).not.toContain("'wired-lain'");
  });
});

describe('BootScene (BootScene.js)', () => {
  const src = readPublicFile('game/js/scenes/BootScene.js');

  it('should define BootScene class', () => {
    expect(src).toMatch(/class BootScene\s+extends\s+Phaser\.Scene/);
  });

  it('should call loadCharacterManifest', () => {
    expect(src).toContain('loadCharacterManifest()');
  });

  it('should transition to WorldScene after loading', () => {
    expect(src).toContain("this.scene.start('WorldScene'");
  });

  it('should generate character sprites', () => {
    expect(src).toContain('renderPixelSprites');
  });
});

// ============================================================================
// Commune Map (commune-map.js)
// ============================================================================

describe('Commune Map (commune-map.js)', () => {
  const src = readPublicFile('commune-map.js');

  it('should define loadCharactersFromManifest function', () => {
    expect(src).toMatch(/async function loadCharactersFromManifest\s*\(/);
  });

  it('should define hashColor function', () => {
    expect(src).toMatch(/function hashColor\s*\(/);
  });

  it('should define buildCharacterEntry function', () => {
    expect(src).toMatch(/function buildCharacterEntry\s*\(/);
  });

  it('DEFAULT_LOCATIONS should start empty (populated dynamically)', () => {
    // It is declared as an empty object and only populated from manifest data
    expect(src).toMatch(/let DEFAULT_LOCATIONS\s*=\s*\{\s*\}/);
  });

  it('should not contain hardcoded character IDs in CHARACTERS initialization', () => {
    // CHARACTERS should start as an empty array
    expect(src).toMatch(/let CHARACTERS\s*=\s*\[\s*\]/);
  });

  it('should populate DEFAULT_LOCATIONS from API response', () => {
    // Inside loadCharactersFromManifest it fills DEFAULT_LOCATIONS from data.characters
    expect(src).toMatch(/DEFAULT_LOCATIONS\[c\.id\]\s*=\s*c\.defaultLocation/);
  });

  it('should define BUILDING_META with 9 entries', () => {
    const metaBlock = src.match(/const BUILDING_META\s*=\s*\[([\s\S]*?)\];/);
    expect(metaBlock).not.toBeNull();
    const entries = metaBlock![1]!.match(/\{[^}]+\}/g);
    expect(entries).toHaveLength(9);
  });

  it('each building in BUILDING_META should have id and name', () => {
    const metaBlock = src.match(/const BUILDING_META\s*=\s*\[([\s\S]*?)\];/);
    expect(metaBlock).not.toBeNull();
    const entries = metaBlock![1]!.match(/\{[^}]+\}/g) || [];
    for (const entry of entries) {
      expect(entry).toMatch(/id:\s*'/);
      expect(entry).toMatch(/name:\s*'/);
    }
  });

  it('getBuildings should add emoji from getBuildingIcons', () => {
    expect(src).toMatch(/function getBuildings\s*\(\)/);
    expect(src).toMatch(/emoji:\s*icons\[b\.id\]/);
  });

  describe('XSS hardening (P1 findings.md)', () => {
    it('createNotification must not interpolate event.content into innerHTML', () => {
      const fnBody = src.match(/function createNotification\s*\([\s\S]*?\n  \}/);
      expect(fnBody).not.toBeNull();
      // innerHTML assignment with template literal including snippet/event.content is the old bug
      expect(fnBody![0]).not.toMatch(/innerHTML\s*=\s*`[^`]*\$\{snippet\}/);
      expect(fnBody![0]).not.toMatch(/innerHTML\s*=\s*`[^`]*\$\{event\.type\}/);
      // New path should build DOM nodes and use textContent
      expect(fnBody![0]).toMatch(/textContent\s*=\s*char\.name/);
      expect(fnBody![0]).toMatch(/textContent\s*=\s*event\.type/);
    });

    it('addLogEntry must not interpolate event.type/char.id into innerHTML', () => {
      const fnBody = src.match(/function addLogEntry\s*\([\s\S]*?\n  \}/);
      expect(fnBody).not.toBeNull();
      expect(fnBody![0]).not.toMatch(/innerHTML\s*=[\s\S]*?\$\{event\.type\}[\s\S]*?<\/span>/);
      expect(fnBody![0]).not.toMatch(/innerHTML\s*=[\s\S]*?\$\{char\.id\}[\s\S]*?<\/span>/);
      expect(fnBody![0]).toMatch(/textContent\s*=\s*char\.id/);
      expect(fnBody![0]).toMatch(/textContent\s*=\s*event\.type/);
    });
  });
});

// ============================================================================
// App (app.js)
// ============================================================================

describe('App (app.js) — XSS hardening (P1 findings.md)', () => {
  const src = readPublicFile('app.js');

  it('defines isSafeImageUrl allowlist helper', () => {
    expect(src).toMatch(/function isSafeImageUrl\s*\(/);
    expect(src).toMatch(/u\.protocol\s*===\s*'http:'/);
    expect(src).toMatch(/u\.protocol\s*===\s*'https:'/);
  });

  it('defines escapeAttr that escapes quotes', () => {
    expect(src).toMatch(/function escapeAttr\s*\(/);
    expect(src).toMatch(/\.replace\(\/"\/g,\s*'&quot;'\)/);
    expect(src).toMatch(/\.replace\(\/'\/g,\s*'&#39;'\)/);
  });

  it('formatLainResponse gates img rendering on isSafeImageUrl', () => {
    const fnBody = src.match(/function formatLainResponse\s*\([\s\S]*?\n\}/);
    expect(fnBody).not.toBeNull();
    expect(fnBody![0]).toMatch(/if \(!isSafeImageUrl\(img\.url\)\)/);
    expect(fnBody![0]).toMatch(/image omitted: unsafe url/);
  });

  it('image onclick uses data-url indirection, not direct URL interpolation', () => {
    const fnBody = src.match(/function formatLainResponse\s*\([\s\S]*?\n\}/);
    expect(fnBody).not.toBeNull();
    // Old bug: onclick="window.open('${escapeHtml(img.url)}', '_blank')"
    expect(fnBody![0]).not.toMatch(/onclick="window\.open\('\$\{escapeHtml\(img\.url\)\}/);
    expect(fnBody![0]).toMatch(/onclick="window\.open\(this\.dataset\.url/);
  });
});

// ============================================================================
// Dashboard (dashboard.html)
// ============================================================================

describe('Dashboard (dashboard.html)', () => {
  const src = readPublicFile('dashboard.html');

  it('should define loadDashboardCharacters function', () => {
    expect(src).toMatch(/async function loadDashboardCharacters\s*\(/);
  });

  it('should define _dashHashColor function', () => {
    expect(src).toMatch(/function _dashHashColor\s*\(/);
  });

  it('should not contain hardcoded character arrays', () => {
    // CHARACTERS should be initialized as empty and populated from API
    expect(src).toMatch(/let CHARACTERS\s*=\s*\[\s*\]/);
    // No static character array definitions with names
    expect(src).not.toMatch(/CHARACTERS\s*=\s*\[\s*\{.*?id:\s*['"]lain['"]/);
  });

  it('should define polling interval for health checks', () => {
    // setInterval for pollServiceHealth
    expect(src).toMatch(/setInterval\(pollServiceHealth/);
  });

  it('should define polling interval for locations', () => {
    // setInterval for pollLocations
    expect(src).toMatch(/setInterval\(pollLocations/);
  });

  it('should define polling interval for loop health', () => {
    // setInterval that includes pollLoopHealth
    expect(src).toMatch(/setInterval\(function\s*\(\)\s*\{[\s\S]*?pollLoopHealth/);
  });

  it('loadDashboardCharacters should populate DEFAULT_LOCATIONS dynamically', () => {
    expect(src).toMatch(/DEFAULT_LOCATIONS\s*=\s*\{\s*\}/);
    expect(src).toMatch(/DEFAULT_LOCATIONS\[c\.id\]\s*=\s*c\.defaultLocation/);
  });

  it('should fetch characters from /api/characters', () => {
    expect(src).toMatch(/fetch\s*\(\s*'\/api\/characters'\s*\)/);
  });

  it('should not hardcode character IDs in service health', () => {
    // initServiceList should iterate CHARACTERS, not use hardcoded IDs
    expect(src).toMatch(/const services\s*=\s*CHARACTERS\.map/);
  });
});

// ============================================================================
// Fixtures (game/js/fixtures.js)
// ============================================================================

describe('Fixtures (fixtures.js)', () => {
  const src = readPublicFile('game/js/fixtures.js');

  it('should define FIXTURE_SIZE constant', () => {
    expect(src).toMatch(/const FIXTURE_SIZE\s*=\s*48/);
  });

  it('should define FIXTURE_SPRITES registry object', () => {
    expect(src).toMatch(/const FIXTURE_SPRITES\s*=\s*\{/);
  });

  it('should define renderFixtureSprite function', () => {
    expect(src).toMatch(/function renderFixtureSprite\s*\(/);
  });

  it('should contain multiple fixture sprites', () => {
    // Count named fixtures (keys in FIXTURE_SPRITES)
    const fixtureKeys = src.match(/^\s+[a-z_]+:\s*function\s*\(/gm);
    expect(fixtureKeys).not.toBeNull();
    expect(fixtureKeys!.length).toBeGreaterThanOrEqual(5);
  });
});
