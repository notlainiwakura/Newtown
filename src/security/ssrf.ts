/**
 * SSRF (Server-Side Request Forgery) protection
 */

import { URL } from 'node:url';
import { isIP } from 'node:net';
import dns from 'node:dns/promises';
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
  /^fc00:/i,
  /^fd00:/i,
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

    // Resolve hostname and check IP
    try {
      const addresses = await Promise.race([
        dns.resolve4(hostname),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('DNS timeout')), 5000)),
      ]);

      for (const ip of addresses) {
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
      if (addresses[0]) {
        successResult.resolvedIP = addresses[0];
      }
      return successResult;
    } catch {
      // Try IPv6
      try {
        const addresses6 = await Promise.race([
          dns.resolve6(hostname),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('DNS timeout')), 5000)),
        ]);

        for (const ip of addresses6) {
          if (isPrivateIP(ip)) {
            const ipv6PrivateResult: SSRFCheckResult = {
              safe: false,
              reason: `Hostname resolves to private IPv6: ${ip}`,
            };
            ipv6PrivateResult.resolvedIP = ip;
            return ipv6PrivateResult;
          }
        }

        const ipv6Result: SSRFCheckResult = { safe: true };
        if (addresses6[0]) {
          ipv6Result.resolvedIP = addresses6[0];
        }
        return ipv6Result;
      } catch {
        return {
          safe: false,
          reason: `DNS resolution failed for: ${hostname}`,
        };
      }
    }
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
  for (const pattern of PRIVATE_IP_RANGES) {
    if (pattern.test(ip)) {
      return true;
    }
  }
  return false;
}

/**
 * Sanitize a URL for safe external access
 */
export function sanitizeURL(url: string): string | null {
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

  try {
    const response = await fetch(sanitized, {
      ...options,
      signal: controller.signal,
      redirect: 'manual', // Don't follow redirects automatically (check each one)
    });

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

    return response;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Validate allowed domains for external requests
 */
export function isAllowedDomain(
  url: string,
  allowedDomains: string[]
): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();

    return allowedDomains.some((domain) => {
      const d = domain.toLowerCase();
      // Exact match or subdomain match
      return hostname === d || hostname.endsWith(`.${d}`);
    });
  } catch {
    return false;
  }
}

/**
 * Block list check for known malicious domains
 */
export function isBlockedDomain(url: string, blocklist: string[]): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();

    return blocklist.some((domain) => {
      const d = domain.toLowerCase();
      return hostname === d || hostname.endsWith(`.${d}`);
    });
  } catch {
    return true; // Block invalid URLs
  }
}
