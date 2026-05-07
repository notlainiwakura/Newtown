/**
 * Shared security-header helper.
 *
 * findings.md P2:2512 — character-server and doctor-server used to emit
 * zero security headers. Main server set X-Frame-Options, CSP, nosniff,
 * and a referrer policy inline. If any iframe ever pointed at a
 * character-server endpoint, clickjacking was wide open.
 *
 * Centralize the header set so all three servers emit an identical
 * baseline. The `csp` option exists because character-server serves
 * API-only responses and can start stricter than the HTML-serving
 * doctor-server.
 *
 * findings.md P2:2880 — `HTML_PAGE_CSP` used to carry `'unsafe-inline'`
 * on script-src and style-src. Doctor-server's `public-doctor/` is
 * hashed through the same `buildHtmlCsp` path the main server uses
 * (empty hash set is fine on installs without a doctor public dir).
 */

import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { buildHtmlCsp } from './csp-hashes.js';

// Strict default CSP for API-only responses (character-server).
// `default-src 'none'` blocks everything; frame-ancestors 'none' defeats
// clickjacking even without X-Frame-Options (modern browsers respect both).
export const API_ONLY_CSP =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DOCTOR_PUBLIC_DIR = join(__dirname, '..', '..', 'src', 'web', 'public-doctor');

// Doctor-server HTML CSP — hashes inline blocks in public-doctor/ (if any)
// and emits them as `'sha256-...'` sources so `'unsafe-inline'` can be
// dropped. `frame-ancestors 'none'` keeps clickjacking closed.
export const HTML_PAGE_CSP = buildHtmlCsp(DOCTOR_PUBLIC_DIR);

export interface SecurityHeaderOptions {
  csp?: string;
}

export function applySecurityHeaders(
  res: ServerResponse,
  opts: SecurityHeaderOptions = {}
): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (opts.csp !== undefined) {
    res.setHeader('Content-Security-Policy', opts.csp);
  }
}
