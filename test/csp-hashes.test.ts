/**
 * findings.md P2:2880 — CSP SHA-256 inline-block hashing.
 *
 * The main server used to emit `script-src 'self' 'unsafe-inline'` because
 * several HTML files under `src/web/public/` carried large inline
 * `<script>`/`<style>` blocks. `computeInlineHashes` scans a directory,
 * extracts each inline body, and returns SHA-256 digests formatted as CSP
 * source tokens (`'sha256-<base64>'`). `buildHtmlCsp` assembles the full
 * CSP header string with the hashes and a `style-src-attr 'unsafe-inline'`
 * escape hatch for inline `style=""` attributes.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { computeInlineHashes, buildHtmlCsp } from '../src/web/csp-hashes.js';

function sha256Token(body: string): string {
  return `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`;
}

let fixtureDir: string;

beforeAll(() => {
  fixtureDir = join(tmpdir(), `csp-hashes-test-${Date.now()}`);
  mkdirSync(fixtureDir, { recursive: true });
  mkdirSync(join(fixtureDir, 'nested'), { recursive: true });

  // A plain HTML file with one inline script + one inline style.
  writeFileSync(
    join(fixtureDir, 'a.html'),
    `<!DOCTYPE html><html><head>
<style>body { color: red; }</style>
<script src="/app.js"></script>
</head><body>
<script>console.log('hello');</script>
</body></html>`,
    'utf8'
  );

  // Second file sharing the SAME inline style — hashes should dedupe.
  writeFileSync(
    join(fixtureDir, 'b.html'),
    `<html><head><style>body { color: red; }</style></head><body></body></html>`,
    'utf8'
  );

  // Nested file with type="module" inline script.
  writeFileSync(
    join(fixtureDir, 'nested', 'c.html'),
    `<script type="module">import('./x.js');</script>`,
    'utf8'
  );

  // Non-HTML file — must be ignored.
  writeFileSync(join(fixtureDir, 'ignored.txt'), `<script>not html</script>`, 'utf8');
});

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe('computeInlineHashes (findings.md P2:2880)', () => {
  it('hashes inline <script> bodies, skips <script src>', () => {
    const { scripts } = computeInlineHashes(fixtureDir);
    expect(scripts).toContain(sha256Token(`console.log('hello');`));
    expect(scripts).toContain(sha256Token(`import('./x.js');`));
    // The external `<script src="/app.js">` must NOT contribute a hash —
    // its body is empty and empty bodies are skipped, but also the SRC
    // attribute would confuse naive matchers.
    for (const token of scripts) {
      expect(token).toMatch(/^'sha256-[A-Za-z0-9+/=]+'$/);
    }
  });

  it('hashes inline <style> bodies', () => {
    const { styles } = computeInlineHashes(fixtureDir);
    expect(styles).toContain(sha256Token(`body { color: red; }`));
  });

  it('dedupes identical inline bodies across files', () => {
    // `a.html` and `b.html` both have the same `<style>body { color: red; }</style>`.
    // The returned list must have exactly one entry for that body.
    const { styles } = computeInlineHashes(fixtureDir);
    const matches = styles.filter((t) => t === sha256Token(`body { color: red; }`));
    expect(matches).toHaveLength(1);
  });

  it('recurses into subdirectories', () => {
    const { scripts } = computeInlineHashes(fixtureDir);
    // `nested/c.html` carries the module-script body; if the walk were
    // shallow it would be missing.
    expect(scripts).toContain(sha256Token(`import('./x.js');`));
  });

  it('ignores non-HTML files even if they contain <script>', () => {
    // `ignored.txt` has `<script>not html</script>` but must not be hashed.
    const { scripts } = computeInlineHashes(fixtureDir);
    for (const token of scripts) {
      expect(token).not.toBe(sha256Token('not html'));
    }
  });

  it('returns empty sets for a missing directory', () => {
    const { scripts, styles } = computeInlineHashes('/nonexistent/path/for/test');
    expect(scripts).toEqual([]);
    expect(styles).toEqual([]);
  });

  it('returns sorted arrays (stable header output)', () => {
    const { scripts, styles } = computeInlineHashes(fixtureDir);
    expect([...scripts].sort()).toEqual(scripts);
    expect([...styles].sort()).toEqual(styles);
  });
});

describe('buildHtmlCsp (findings.md P2:2880)', () => {
  it('emits no unsafe-inline for script-src or style-src', () => {
    const csp = buildHtmlCsp(fixtureDir);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp).not.toMatch(/style-src\s[^;]*'unsafe-inline'/);
  });

  it('includes precomputed hashes in script-src and style-src', () => {
    const csp = buildHtmlCsp(fixtureDir);
    expect(csp).toContain(sha256Token(`console.log('hello');`));
    expect(csp).toContain(sha256Token(`body { color: red; }`));
  });

  it("keeps style-src-attr 'unsafe-inline' for inline style=\"\" attributes", () => {
    const csp = buildHtmlCsp(fixtureDir);
    expect(csp).toContain("style-src-attr 'unsafe-inline'");
  });

  it("enforces frame-ancestors 'none' and locks base-uri / form-action", () => {
    const csp = buildHtmlCsp(fixtureDir);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
  });

  it('uses default-src self as the baseline', () => {
    const csp = buildHtmlCsp(fixtureDir);
    expect(csp).toMatch(/^default-src 'self'/);
  });

  it('allows google fonts origin in style-src (existing skin pattern)', () => {
    const csp = buildHtmlCsp(fixtureDir);
    expect(csp).toContain('https://fonts.googleapis.com');
    expect(csp).toContain('https://fonts.gstatic.com');
  });
});
