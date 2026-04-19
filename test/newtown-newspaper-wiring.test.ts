import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Newtown newspaper wiring', () => {
  it('serves runtime newspaper files from the main web server', () => {
    const source = readFileSync('C:\\Users\\akaik\\Documents\\newtown\\Newtown\\src\\web\\server.ts', 'utf8');

    expect(source).toContain("url.pathname.startsWith('/newspapers/')");
    expect(source).toContain('serveFromDir(NEWSPAPERS_DIR, newspaperPath)');
    expect(source).toContain('startNewspaperPublishingLoop(');
  });

  it('starts resident newspaper reader loops against the Newtown paper', () => {
    const source = readFileSync('C:\\Users\\akaik\\Documents\\newtown\\Newtown\\src\\web\\character-server.ts', 'utf8');

    expect(source).toContain('startNewspaperLoop({');
    expect(source).toContain("paperName: 'The Newtown Chronicle'");
    expect(source).toContain("townName: 'Newtown'");
  });
});
