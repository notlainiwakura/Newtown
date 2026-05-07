/**
 * Shared CORS helper for all three servers (main, character, doctor).
 *
 * findings.md P2:2366 — character-server and doctor-server hardcoded
 * `Access-Control-Allow-Origin: *` with no env override. Any origin
 * could issue requests against owner endpoints; SameSite=Strict on
 * the owner cookie mitigates the most common CSRF paths but only if
 * you remember that. A shared helper lets deployers lock origins via
 * `LAIN_CORS_ORIGIN` without touching code.
 *
 * Default is `null` → no CORS header emitted. Callers that need a
 * permissive default (e.g. the main server serving the public commune
 * map) can pass `'*'` as a fallback.
 */
import type { ServerResponse } from 'node:http';

export function getCorsOrigin(fallback: string | null = null): string | null {
  const env = process.env['LAIN_CORS_ORIGIN'];
  if (env && env.length > 0) return env;
  return fallback;
}

export function applyCorsHeaders(
  res: ServerResponse,
  opts: {
    methods?: string;
    headers?: string;
    fallback?: string | null;
  } = {}
): void {
  const origin = getCorsOrigin(opts.fallback ?? null);
  if (!origin) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', opts.methods ?? 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', opts.headers ?? 'Content-Type, Authorization');
}
