/**
 * CSP inline-block hash computation (findings.md P2:2880).
 *
 * Main server's Content-Security-Policy previously listed `'unsafe-inline'`
 * under `script-src` and `style-src`, which defeats CSP's XSS protection.
 * The inline blocks that forced `'unsafe-inline'` are all static on disk
 * (see P2:2880 inventory), so per-request nonces are unnecessary
 * overhead. Instead: at server boot, walk `src/web/public/`, extract every
 * inline `<script>`/`<style>` body, compute SHA-256 base64, and emit each
 * digest as a `'sha256-...'` source in the CSP. Zero runtime cost per
 * request — the hash set is frozen at module load.
 *
 * Scope notes:
 *  - Only inline blocks are hashed. `<script src="...">` and
 *    `<link rel="stylesheet">` resolve via `'self'` and need no hash.
 *  - Inline `style=""` attributes (19 of them across `public/`) are
 *    handled by a separate `style-src-attr 'unsafe-inline'` directive.
 *    CSP 3 treats attribute styles distinctly from inline `<style>`
 *    bodies, so we can tighten the latter while keeping the former.
 *  - Missing directory is fine — returns empty sets so tests and
 *    local dev without `public/` don't explode.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

export interface InlineHashes {
  scripts: string[];
  styles: string[];
}

// Inline script: either `<script>` or `<script type="...">`, no `src=`
// attribute. A `<script src="...">` has the `src=` token between
// `<script` and `>` so the non-greedy attr segment below never matches it.
const INLINE_SCRIPT_RE = /<script(?:\s+type="[^"]*")?>([\s\S]*?)<\/script>/g;

// Inline style: any `<style>` (no `src` attribute exists in HTML).
const INLINE_STYLE_RE = /<style[^>]*>([\s\S]*?)<\/style>/g;

function sha256Token(body: string): string {
  // Browsers hash inline blocks after HTML newline normalization.
  // Without this, Windows CRLF files produce CSP hashes that don't match
  // the LF-normalized text the browser actually sees, so inline <style>
  // and <script> blocks are incorrectly blocked.
  const normalized = body.replace(/\r\n?/g, '\n');
  return `'sha256-${createHash('sha256').update(normalized, 'utf8').digest('base64')}'`;
}

function walkHtml(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkHtml(full, out);
      continue;
    }
    if (extname(full).toLowerCase() === '.html') {
      out.push(full);
    }
  }
}

export function computeInlineHashes(publicDir: string): InlineHashes {
  const scriptSet = new Set<string>();
  const styleSet = new Set<string>();
  const htmlFiles: string[] = [];
  walkHtml(publicDir, htmlFiles);

  for (const file of htmlFiles) {
    let html: string;
    try {
      html = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const match of html.matchAll(INLINE_SCRIPT_RE)) {
      const body = match[1];
      if (body === undefined || body.length === 0) continue;
      scriptSet.add(sha256Token(body));
    }
    for (const match of html.matchAll(INLINE_STYLE_RE)) {
      const body = match[1];
      if (body === undefined || body.length === 0) continue;
      styleSet.add(sha256Token(body));
    }
  }

  return {
    scripts: Array.from(scriptSet).sort(),
    styles: Array.from(styleSet).sort(),
  };
}

/**
 * Build the CSP header string for a server that serves static HTML from
 * `publicDir`. Drops `'unsafe-inline'` from both `script-src` and
 * `style-src`; inline bodies are authorized by precomputed SHA-256
 * hashes. `style-src-attr 'unsafe-inline'` keeps inline `style=""`
 * attributes working (existing pages use them extensively; hashing
 * every attribute value would need `'unsafe-hashes'` + a hash per
 * value, which is a much bigger migration).
 */
export function buildHtmlCsp(publicDir: string): string {
  const { scripts, styles } = computeInlineHashes(publicDir);
  const scriptSrc = ["'self'", ...scripts].join(' ');
  const styleSrc = ["'self'", 'https://fonts.googleapis.com', ...styles].join(' ');
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    `style-src ${styleSrc}`,
    "style-src-attr 'unsafe-inline'",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}
