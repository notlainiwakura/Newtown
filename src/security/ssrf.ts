/**
 * SSRF (Server-Side Request Forgery) protection
 */

import { URL } from 'node:url';
import { isIP } from 'node:net';
import dns from 'node:dns/promises';
import { Agent, fetch as undiciFetch } from 'undici';
import { getLogger } from '../utils/logger.js';

export interface SSRFCheckResult {
  safe: boolean;
  reason?: string;
  resolvedIP?: string;
}

// Private IP ranges that should be blocked
const PRIVATE_IP_RANGES = [
  // IPv4 private ranges
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^192\.168\./,
  // IPv4 loopback
  /^127\./,
  // IPv4 link-local
  /^169\.254\./,
  // IPv4 CGNAT
  /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./,
  // IPv6 private/loopback (simplified patterns)
  /^::1$/,
  /^fe80:/i,
  // findings.md P2:1260 — the ULA range is fc00::/7 (any first byte
  // starting with fc or fd), not just the literal fc00:/fd00: prefixes.
  // `fcab:cd::1`, `fd12:3456::1`, `fcff::1` are all ULA and the old
  // regex let them through. Match any two hex chars after fc/fd.
  /^(fc|fd)[0-9a-f]{2}:/i,
];

// Blocked hostnames
const BLOCKED_HOSTNAMES = [
  'localhost',
  'localhost.localdomain',
  '0.0.0.0',
  '[::1]',
  'metadata.google.internal', // GCP metadata
  '169.254.169.254', // AWS/Azure/GCP metadata
  'metadata.google.internal',
];

// Blocked URL schemes
const BLOCKED_SCHEMES = [
  'file:',
  'ftp:',
  'gopher:',
  'data:',
  'javascript:',
];

// Allowed schemes
const ALLOWED_SCHEMES = ['http:', 'https:'];

/**
 * Check if a URL is safe from SSRF attacks
 */
export async function checkSSRF(url: string): Promise<SSRFCheckResult> {
  const logger = getLogger();

  try {
    const parsed = new URL(url);

    // Check scheme
    if (BLOCKED_SCHEMES.includes(parsed.protocol)) {
      return {
        safe: false,
        reason: `Blocked URL scheme: ${parsed.protocol}`,
      };
    }

    if (!ALLOWED_SCHEMES.includes(parsed.protocol)) {
      return {
        safe: false,
        reason: `Unsupported URL scheme: ${parsed.protocol}`,
      };
    }

    // Check for blocked hostnames
    const hostname = parsed.hostname.toLowerCase();
    if (BLOCKED_HOSTNAMES.includes(hostname)) {
      return {
        safe: false,
        reason: `Blocked hostname: ${hostname}`,
      };
    }

    // Check if hostname is an IP address
    if (isIP(hostname)) {
      if (isPrivateIP(hostname)) {
        return {
          safe: false,
          reason: `Private IP address not allowed: ${hostname}`,
        };
      }
      const ipResult: SSRFCheckResult = { safe: true };
      ipResult.resolvedIP = hostname;
      return ipResult;
    }

    // findings.md P2:1285 — resolve BOTH A and AAAA up front and inspect
    // every returned address. Previously we short-circuited after A
    // success, so a hostname with a public A record AND a private AAAA
    // (link-local fe80::, ULA, or IPv4-mapped private) passed the check;
    // Node's dual-stack / Happy Eyeballs could then prefer the IPv6
    // target at fetch time and reach the private host. Running both
    // queries in parallel and failing on any private address closes
    // that gap.
    const timeoutMs = 5000;
    const withTimeout = <T>(p: Promise<T>): Promise<T> => Promise.race([
      p,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('DNS timeout')), timeoutMs)),
    ]);

    const [a4, a6] = await Promise.allSettled([
      withTimeout(dns.resolve4(hostname)),
      withTimeout(dns.resolve6(hostname)),
    ]);

    const ipv4 = a4.status === 'fulfilled' ? a4.value : [];
    const ipv6 = a6.status === 'fulfilled' ? a6.value : [];

    if (ipv4.length === 0 && ipv6.length === 0) {
      return {
        safe: false,
        reason: `DNS resolution failed for: ${hostname}`,
      };
    }

    for (const ip of [...ipv4, ...ipv6]) {
      if (isPrivateIP(ip)) {
        logger.warn(
          { hostname, ip },
          'DNS resolution returned private IP (potential DNS rebinding)'
        );
        const privateResult: SSRFCheckResult = {
          safe: false,
          reason: `Hostname resolves to private IP: ${ip}`,
        };
        privateResult.resolvedIP = ip;
        return privateResult;
      }
    }

    const successResult: SSRFCheckResult = { safe: true };
    const first = ipv4[0] ?? ipv6[0];
    if (first) successResult.resolvedIP = first;
    return successResult;
  } catch (error) {
    return {
      safe: false,
      reason: `Invalid URL: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Check if an IP address is private/internal
 */
export function isPrivateIP(ip: string): boolean {
  // findings.md P2:1275 — `::ffff:127.0.0.1` is IPv4 loopback wearing an
  // IPv6 costume. Node's `isIP` says family=6 for it, and none of our
  // IPv4 regex patterns anchor-match a string starting with `::ffff:`,
  // so an attacker who supplies `::ffff:169.254.169.254` (AWS metadata),
  // `::ffff:10.0.0.1`, etc. bypasses PRIVATE_IP_RANGES. Strip the IPv4-
  // mapped prefix first and re-check the embedded dotted-quad against
  // the IPv4 patterns. Also covers the deprecated `::` (IPv4-compatible)
  // form used by some older tooling.
  const mapped = ip.match(/^::(ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (mapped && mapped[2]) {
    const ipv4 = mapped[2];
    for (const pattern of PRIVATE_IP_RANGES) {
      if (pattern.test(ipv4)) return true;
    }
    // Also block 0.0.0.0 and the IPv4-mapped metadata/loopback explicitly
    // in case a future pattern edit misses a range.
    if (ipv4 === '0.0.0.0' || ipv4.startsWith('127.')) return true;
  }

  for (const pattern of PRIVATE_IP_RANGES) {
    if (pattern.test(ip)) {
      return true;
    }
  }
  return false;
}

/**
 * Sanitize a URL for safe external access.
 *
 * findings.md P2:1305 — de-exported. The only caller is safeFetch below;
 * no production code outside this file consumed it. Kept as an
 * internal helper so we can still strip credentials and reject non-
 * http(s) schemes before handing the URL to undici.
 */
function sanitizeURL(url: string): string | null {
  try {
    const parsed = new URL(url);

    // Only allow http/https
    if (!ALLOWED_SCHEMES.includes(parsed.protocol)) {
      return null;
    }

    // Remove credentials
    parsed.username = '';
    parsed.password = '';

    // Normalize hostname
    parsed.hostname = parsed.hostname.toLowerCase();

    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Build an undici Agent that pins DNS resolution to a specific pre-
 * resolved IP. This defeats DNS-rebinding attacks where the attacker
 * returns a public IP on checkSSRF's lookup and a private IP on the
 * subsequent fetch lookup — with a pinned lookup, both lookups return
 * the same pre-validated IP. TLS SNI and the HTTP Host header continue
 * to use the original hostname so cert validation and vhost routing
 * work normally.
 */
function buildPinnedAgent(resolvedIP: string): Agent {
  const family = isIP(resolvedIP) === 6 ? 6 : 4;
  // Node's Socket.connect may call lookup with `all: true`, in which
  // case the callback expects an array of {address, family}. Handle
  // both shapes so the agent works regardless of which call form
  // undici's connect layer uses.
  const lookup = (
    _hostname: string,
    opts: { all?: boolean } | ((err: Error | null, ...rest: unknown[]) => void),
    maybeCallback?: (err: Error | null, ...rest: unknown[]) => void,
  ): void => {
    const callback = (typeof opts === 'function' ? opts : maybeCallback) as (
      err: Error | null,
      ...rest: unknown[]
    ) => void;
    const wantAll = typeof opts === 'object' && opts !== null && opts.all === true;
    if (wantAll) {
      callback(null, [{ address: resolvedIP, family }]);
    } else {
      callback(null, resolvedIP, family);
    }
  };
  return new Agent({
    connect: {
      // Cast: undici's connect.lookup type isn't cleanly re-exported; the
      // callback shape above is correct for Node's socket.connect contract.
      lookup: lookup as never,
    },
  });
}

/**
 * Create a safe fetch wrapper with SSRF protection
 */
export async function safeFetch(
  url: string,
  options?: RequestInit
): Promise<Response> {
  const logger = getLogger();

  // Check URL safety
  const check = await checkSSRF(url);

  if (!check.safe) {
    logger.warn({ url, reason: check.reason }, 'SSRF check failed');
    throw new Error(`SSRF protection: ${check.reason}`);
  }

  // Sanitize URL
  const sanitized = sanitizeURL(url);
  if (!sanitized) {
    throw new Error('SSRF protection: Invalid URL');
  }

  logger.debug({ url: sanitized, resolvedIP: check.resolvedIP }, 'Safe fetch');

  // Perform fetch with timeout
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  // findings.md P2:1295 — before this fix, safeFetch's init object spread
  // `options` first and then set `signal: controller.signal`, which
  // silently overwrote any caller-supplied AbortSignal. Callers like
  // src/web/server.ts that pass `AbortSignal.timeout(15000)` expecting a
  // 15s limit got the internal 30s limit instead, and lost the ability
  // to externally cancel. Merge both signals via AbortSignal.any so the
  // combined signal aborts on whichever fires first (caller timeout,
  // caller cancel, or internal 30s guard). Fall back to controller.signal
  // alone on runtimes that lack AbortSignal.any.
  const callerSignal = (options as RequestInit | undefined)?.signal ?? null;
  const signal: AbortSignal =
    callerSignal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([controller.signal, callerSignal])
      : controller.signal;

  // DNS-pin the connection to the pre-resolved IP so a second DNS lookup
  // at connection time cannot rebind to a private address.
  const dispatcher = check.resolvedIP ? buildPinnedAgent(check.resolvedIP) : undefined;

  try {
    // undici's fetch accepts a superset of RequestInit (adds `dispatcher`).
    // The two type-streams (`@types/node`'s undici vs. the installed
    // `undici` package) don't unify cleanly under exactOptionalPropertyTypes,
    // so we build the init object and hand it to undiciFetch via its own
    // type without fighting the global RequestInit type.
    const init: Parameters<typeof undiciFetch>[1] = {
      ...(options as Parameters<typeof undiciFetch>[1]),
      signal,
      redirect: 'manual', // Don't follow redirects automatically (check each one)
    };
    if (dispatcher) {
      init.dispatcher = dispatcher;
    }
    const response = await undiciFetch(sanitized, init);

    // Check redirect location for SSRF
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location) {
        const redirectCheck = await checkSSRF(location);
        if (!redirectCheck.safe) {
          throw new Error(`SSRF protection on redirect: ${redirectCheck.reason}`);
        }
      }
    }

    // undici's Response is structurally compatible with the global
    // Response type; cast through unknown to satisfy the declared
    // return type without forcing every caller through undici's types.
    return response as unknown as Response;
  } finally {
    clearTimeout(timeout);
    dispatcher?.close().catch(() => {});
  }
}

/**
 * Fetch with SSRF protection AND bounded redirect following. Each hop
 * re-validates through checkSSRF + DNS pinning, so an initial public URL
 * cannot redirect to an internal target, and the total number of hops is
 * capped to avoid redirect loops / open-redirector abuse.
 */
export async function safeFetchFollow(
  url: string,
  options?: RequestInit,
  maxHops = 3
): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= maxHops; hop++) {
    const response = await safeFetch(current, options);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return response;
      if (hop === maxHops) {
        throw new Error(`SSRF protection: too many redirects (> ${maxHops})`);
      }
      // Resolve relative redirects against the current URL so validation
      // runs on the absolute target, not the raw header value.
      current = new URL(location, current).toString();
      continue;
    }
    return response;
  }
  throw new Error(`SSRF protection: too many redirects (> ${maxHops})`);
}

// findings.md P2:1305 — removed `isAllowedDomain` and `isBlockedDomain`.
// The intended use was a per-character URL policy (allow/blocklist)
// but no code path wired them in; they sat as reachable-from-tests-
// only dead code. SSRF protection lives in checkSSRF; a future
// domain policy should be added deliberately, not kept as a stub.
