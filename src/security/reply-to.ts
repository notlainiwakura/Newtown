/**
 * Interlink `replyTo` URL allowlist.
 *
 * Why this exists: `handleResearchRequest` in `src/web/server.ts` takes a
 * `replyTo` URL from an interlink-authenticated caller and POSTs results
 * back to it. Without validation, any process that holds the shared
 * LAIN_INTERLINK_TOKEN can aim that POST at cloud-metadata endpoints
 * (169.254.169.254), internal services, or arbitrary localhost ports.
 *
 * `safeFetch` (src/security/ssrf.ts) blocks loopback addresses outright,
 * which would also block the legitimate use case of peer-to-peer localhost
 * delivery. Instead we pin the allowlist to loopback hosts on known
 * character-manifest ports — the only shape a legitimate replyTo takes.
 */

import { URL } from 'node:url';

const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost']);

/**
 * Return true iff `raw` is an `http://` URL whose hostname is a loopback
 * name (127.0.0.1 or localhost) and whose port is listed in `allowedPorts`.
 * Rejects credentialed URLs, non-http schemes, IPv6 loopback (deliberate —
 * peer URLs use v4), and anything that fails URL parsing.
 */
export function isAllowedReplyTo(raw: string, allowedPorts: readonly number[]): boolean {
  if (typeof raw !== 'string' || raw.length === 0) return false;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'http:') return false;
  if (parsed.username || parsed.password) return false;
  if (!ALLOWED_HOSTS.has(parsed.hostname)) return false;

  // URL.port is empty when the port equals the scheme default (80 for http).
  // That's not a legitimate character-server port for us; require an
  // explicit port that matches the manifest.
  const portStr = parsed.port;
  if (!portStr) return false;
  const port = Number.parseInt(portStr, 10);
  if (!Number.isFinite(port)) return false;
  return allowedPorts.includes(port);
}
