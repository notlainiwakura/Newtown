/**
 * X-Forwarded-For trust helper shared across all HTTP servers.
 *
 * findings.md P2:2446 — `X-Forwarded-For` is attacker-controlled unless the
 * direct peer is a proxy we actually put there. Without an allowlist, any
 * direct client can rotate the rate-limit key by spoofing the header.
 *
 * Trust rules:
 *   - If `req.socket.remoteAddress` is loopback (127.0.0.1, ::1) OR appears in
 *     `LAIN_TRUSTED_PROXIES` (comma-separated), read the first XFF entry.
 *   - Otherwise, use `remoteAddress` directly and ignore XFF entirely.
 *
 * Extracted from src/web/server.ts so that character-server and doctor-server
 * (see findings.md P2:2494) can apply the same trust rule without a
 * cross-module import from server.ts.
 */

import type { IncomingMessage } from 'node:http';

function parseTrustedProxies(): Set<string> {
  const raw = process.env['LAIN_TRUSTED_PROXIES'];
  const base = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
  if (!raw) return base;
  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    base.add(entry);
  }
  return base;
}

export function getClientIp(req: IncomingMessage): string {
  const remote = req.socket.remoteAddress ?? 'unknown';
  const trusted = parseTrustedProxies();
  if (trusted.has(remote)) {
    const xff = req.headers['x-forwarded-for'];
    const header = Array.isArray(xff) ? xff[0] : xff;
    const first = header?.split(',')[0]?.trim();
    if (first) return first;
  }
  return remote;
}
