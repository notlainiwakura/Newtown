import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const serverSource = readFileSync(join(process.cwd(), 'src', 'web', 'server.ts'), 'utf-8');

describe('public resident API proxy guard', () => {
  it('keeps public resident API paths explicitly allowlisted', () => {
    expect(serverSource).toContain('const PUBLIC_CHARACTER_API_PATHS = [');
    expect(serverSource).toContain("'/api/activity'");
    expect(serverSource).toContain("'/api/events'");
    expect(serverSource).toContain("'/api/location'");
    expect(serverSource).toContain("'/api/health'");
  });

  it('checks resident API allowlist before redirecting non-owners', () => {
    expect(serverSource).toContain('function isPublicCharacterApiPath(pathname: string)');
    expect(serverSource).toContain('const isPublicResidentApi = isPublicCharacterApiPath(url.pathname);');
    expect(serverSource).toContain('if ((isOwnerOnly && !isPublicResidentApi) || isRootChat) {');
  });
});
