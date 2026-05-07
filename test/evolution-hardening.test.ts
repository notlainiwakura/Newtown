/**
 * Evolution hardening tests — guards against the two P0 shell-injection
 * vectors, the P1 ancestors path-traversal, and the P1 partial-state-on-
 * failure bug in src/agent/evolution.ts.
 *
 * Covers:
 *  - sanitizeChildName: whitelist-only ([A-Za-z0-9 _-]), length bounds,
 *    rejection of shell metacharacters and path-traversal fragments.
 *  - assertSafeHomePath: refuses empty / relative / non-prefixed paths and
 *    accepts only paths under the allowed home-base prefix.
 *  - executeSuccession rollback: stage-tracked rollback restores the parent
 *    database from the gzipped archive when failure occurs after the wipe.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Storage layer is imported transitively by evolution.ts; avoid touching a
// real keychain.
vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn().mockResolvedValue('test-master-key'),
    setPassword: vi.fn().mockResolvedValue(undefined),
    deletePassword: vi.fn().mockResolvedValue(true),
    findCredentials: vi.fn().mockResolvedValue([]),
  },
}));

import { sanitizeChildName, assertSafeHomePath } from '../src/agent/evolution.js';

describe('sanitizeChildName', () => {
  it('accepts a plain letters-and-spaces name', () => {
    expect(sanitizeChildName('Seren Hollow')).toBe('Seren Hollow');
  });

  it('accepts hyphens and underscores', () => {
    expect(sanitizeChildName('ada-vega_9')).toBe('ada-vega_9');
  });

  it('strips wrapping quotes before validating', () => {
    expect(sanitizeChildName('"Maya"')).toBe('Maya');
    expect(sanitizeChildName("'Rin'")).toBe('Rin');
  });

  it('keeps only the first line', () => {
    expect(sanitizeChildName('Kieran\nignore me')).toBe('Kieran');
  });

  it('rejects shell command substitution with $()', () => {
    expect(sanitizeChildName('Seren$(whoami)')).toBeNull();
  });

  it('rejects backtick command substitution', () => {
    expect(sanitizeChildName('Seren`id`')).toBeNull();
  });

  it('rejects shell separators (;, &, |)', () => {
    expect(sanitizeChildName('Seren;rm -rf /')).toBeNull();
    expect(sanitizeChildName('Seren|cat /etc/passwd')).toBeNull();
    expect(sanitizeChildName('Seren&whoami')).toBeNull();
  });

  it('rejects path-traversal fragments', () => {
    expect(sanitizeChildName('../../etc/passwd')).toBeNull();
    expect(sanitizeChildName('foo/bar')).toBeNull();
    expect(sanitizeChildName('foo\\bar')).toBeNull();
  });

  it('rejects null / empty / too-short names', () => {
    expect(sanitizeChildName('')).toBeNull();
    expect(sanitizeChildName('   ')).toBeNull();
    expect(sanitizeChildName('a')).toBeNull();
  });

  it('rejects names longer than 40 characters after trimming', () => {
    expect(sanitizeChildName('a'.repeat(41))).toBeNull();
    expect(sanitizeChildName('a'.repeat(40))).toBe('a'.repeat(40));
  });

  it('rejects embedded unicode / non-ASCII glyphs', () => {
    expect(sanitizeChildName('Ser∂n')).toBeNull();
  });
});

describe('assertSafeHomePath', () => {
  it('accepts paths under /root/.lain-<id>/', () => {
    expect(() => assertSafeHomePath('/root/.lain-pkd')).not.toThrow();
    expect(() => assertSafeHomePath('/root/.lain-wired')).not.toThrow();
  });

  it('accepts an explicit allowed prefix override', () => {
    expect(() => assertSafeHomePath('/Users/me/.lain-pkd', '/Users/me/.lain-')).not.toThrow();
  });

  it('rejects empty string', () => {
    expect(() => assertSafeHomePath('')).toThrow();
  });

  it('rejects root / slashy edge cases', () => {
    expect(() => assertSafeHomePath('/')).toThrow();
    expect(() => assertSafeHomePath('//')).toThrow();
  });

  it('rejects relative paths', () => {
    expect(() => assertSafeHomePath('tmp/evil')).toThrow();
    expect(() => assertSafeHomePath('./foo')).toThrow();
  });

  it('rejects paths outside the allowed prefix', () => {
    expect(() => assertSafeHomePath('/etc/shadow')).toThrow();
    expect(() => assertSafeHomePath('/root/.ssh')).toThrow();
    expect(() => assertSafeHomePath('/tmp/.lain-foo')).toThrow();
  });

  it('rejects paths that escape the prefix via ..', () => {
    expect(() => assertSafeHomePath('/root/.lain-pkd/../../etc')).toThrow();
  });
});

describe('executeSuccession rollback (source-level guards)', () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(thisDir, '..', 'src', 'agent', 'evolution.ts'), 'utf-8');

  it('imports createGunzip for archive restoration', () => {
    expect(source).toMatch(/createGunzip/);
  });

  it('defines a gunzipFile helper', () => {
    expect(source).toMatch(/async function gunzipFile\(/);
  });

  it('tracks succession progress through named stages', () => {
    expect(source).toMatch(/stage:\s*'init'\s*\|\s*'stopped'\s*\|\s*'archived'\s*\|\s*'wiped'\s*\|\s*'child-written'\s*\|\s*'lineage-saved'\s*\|\s*'complete'/);
    expect(source).toMatch(/stage = 'stopped'/);
    expect(source).toMatch(/stage = 'archived'/);
    expect(source).toMatch(/stage = 'wiped'/);
    expect(source).toMatch(/stage = 'child-written'/);
    expect(source).toMatch(/stage = 'lineage-saved'/);
    expect(source).toMatch(/stage = 'complete'/);
  });

  it('restores parent database from archive when wipe completed', () => {
    expect(source).toMatch(/stage === 'wiped'.*stage === 'child-written'[\s\S]*?gunzipFile\(archiveGzPath, dbPath\)/);
  });

  it('restores parent SOUL from ancestors on child-written failure', () => {
    expect(source).toMatch(/stage === 'child-written'[\s\S]*?ancestors[\s\S]*?SOUL\.md/);
  });

  it('always attempts service restart after rollback', () => {
    const catchBlock = source.slice(source.indexOf("'Succession failed"));
    expect(catchBlock).toMatch(/Restart service regardless[\s\S]*?systemctl[^\n]+start/);
  });

  it('logs the failed stage for diagnosability', () => {
    expect(source).toMatch(/logger\.error\(\s*\{\s*error:\s*String\(err\),\s*character:\s*char\.id,\s*stage\s*\}/);
  });
});
