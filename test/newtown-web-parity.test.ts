import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(process.cwd(), 'src', 'web');

function readWebFile(...parts: string[]) {
  return readFileSync(join(ROOT, ...parts), 'utf8');
}

describe('Newtown web parity', () => {
  it('uses Newtown branding on active admin surfaces', () => {
    expect(readWebFile('public', 'dreams.html')).toContain('NEWTOWN</title>');
    expect(readWebFile('public', 'postboard.html')).toContain('NEWTOWN</title>');
    expect(readWebFile('public', 'town-events.html')).toContain('NEWTOWN</title>');
  });

  it('routes skin loading through the Newtown resident pages', () => {
    const loader = readWebFile('skins', 'loader.js');
    const earlyLoad = readWebFile('skins', 'early-load.js');

    expect(loader).toContain("const charPaths = ['/neo', '/plato', '/joe'];");
    expect(earlyLoad).toContain("var charPaths = ['/neo', '/plato', '/joe'];");
    expect(loader).not.toMatch(/\/pkd|\/mckenna|\/john|\/hiru|\/local|\/doctor/);
    expect(earlyLoad).not.toMatch(/\/pkd|\/mckenna|\/john|\/hiru|\/local|\/doctor/);
  });

  it('keeps active map and game assets aligned to the Newtown cast and buildings', () => {
    const mapScript = readWebFile('public', 'commune-map.js');
    const sprites = readWebFile('public', 'game', 'js', 'sprites.js');
    const fixtures = readWebFile('public', 'game', 'js', 'fixtures.js');

    expect(mapScript).toContain("pub: '");
    expect(mapScript).toContain("'mystery-tower': '");
    expect(mapScript).not.toMatch(/library:|bar:|lighthouse:|market:|threshold:/);

    expect(sprites).toContain("'neo': {");
    expect(sprites).toContain("'plato': {");
    expect(sprites).toContain("'joe': {");
    expect(sprites).not.toMatch(/'lain'|'wired-lain'|'pkd'|'mckenna'|'john'|'hiru'|'dr-claude'/);

    expect(fixtures).toContain('Plato for the Mystery Tower');
    expect(fixtures).toContain('Neo for the Field');
    expect(fixtures).not.toMatch(/John for the Library|McKenna for the Field/);
  });

  it('keeps every shipped skin aligned to Newtown residents and buildings', () => {
    for (const skinId of ['default', 'gothic', 'hardcore', 'kawaii', 'terminal', 'vaporwave']) {
      const manifest = readWebFile('skins', skinId, 'manifest.json');
      const skinCss = readWebFile('skins', skinId, 'skin.css');
      const spriteConfig = readWebFile('skins', skinId, 'sprites.json');

      expect(manifest).toContain('"pub"');
      expect(manifest).toContain('"mystery-tower"');
      expect(manifest).not.toMatch(/"library"|"bar"|"lighthouse"|"school"|"market"|"threshold"/);

      expect(skinCss).toContain('--color-neo:');
      expect(skinCss).toContain('--color-plato:');
      expect(skinCss).toContain('--color-joe:');
      expect(skinCss).not.toMatch(/--color-wired-lain|--color-lain|--color-pkd|--color-mckenna|--color-john|--color-hiru|--color-dr-claude/);

      expect(spriteConfig).toContain('"neo"');
      expect(spriteConfig).toContain('"plato"');
      expect(spriteConfig).toContain('"joe"');
      expect(spriteConfig).not.toMatch(/"wired-lain"|"lain"|"pkd"|"mckenna"|"john"|"hiru"|"dr-claude"/);
    }
  });

  it('keeps resident health endpoints implemented for proxied dashboard checks', () => {
    const characterServer = readFileSync(join(process.cwd(), 'src', 'web', 'character-server.ts'), 'utf8');
    expect(characterServer).toContain("url.pathname === '/api/health'");
    expect(characterServer).toContain('characterId: config.id');
  });
});
