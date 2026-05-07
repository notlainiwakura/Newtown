/**
 * Security tests
 *
 * Validates authentication, authorization, SSRF protection, input sanitization,
 * and absence of dangerous patterns in server code.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Mock keytar before any imports that touch storage
vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn().mockResolvedValue('test-master-key'),
    setPassword: vi.fn().mockResolvedValue(undefined),
    deletePassword: vi.fn().mockResolvedValue(true),
    findCredentials: vi.fn().mockResolvedValue([]),
  },
}));

const OWNER_AUTH_PATH = join(process.cwd(), 'src', 'web', 'owner-auth.ts');
const SERVER_PATH = join(process.cwd(), 'src', 'web', 'server.ts');
const CHAR_SERVER_PATH = join(process.cwd(), 'src', 'web', 'character-server.ts');
const TOOLS_PATH = join(process.cwd(), 'src', 'agent', 'tools.ts');
const SSRF_PATH = join(process.cwd(), 'src', 'security', 'ssrf.ts');
const SANITIZER_PATH = join(process.cwd(), 'src', 'security', 'sanitizer.ts');
const CRYPTO_PATH = join(process.cwd(), 'src', 'utils', 'crypto.ts');
const INTERLINK_AUTH_PATH = join(process.cwd(), 'src', 'security', 'interlink-auth.ts');
const CORS_PATH = join(process.cwd(), 'src', 'web', 'cors.ts');

const ownerAuthSource = readFileSync(OWNER_AUTH_PATH, 'utf-8');
const serverSource = readFileSync(SERVER_PATH, 'utf-8');
const charServerSource = readFileSync(CHAR_SERVER_PATH, 'utf-8');
const toolsSource = readFileSync(TOOLS_PATH, 'utf-8');
const ssrfSource = readFileSync(SSRF_PATH, 'utf-8');
const sanitizerSource = readFileSync(SANITIZER_PATH, 'utf-8');
const cryptoSource = readFileSync(CRYPTO_PATH, 'utf-8');
const interlinkAuthSource = readFileSync(INTERLINK_AUTH_PATH, 'utf-8');
const corsSource = readFileSync(CORS_PATH, 'utf-8');

// ─────────────────────────────────────────────────────────
// 1. OWNER COOKIE — v2 HMAC-signed payload (findings.md P2:2348)
// ─────────────────────────────────────────────────────────
describe('Owner Cookie v2', () => {
  it('uses HMAC-SHA256 to sign the cookie payload', () => {
    expect(ownerAuthSource).toContain("createHmac('sha256'");
  });

  it('uses hmac function from node:crypto', () => {
    expect(ownerAuthSource).toContain('createHmac');
  });

  it('binds the signature to a v2 message prefix', () => {
    expect(ownerAuthSource).toContain("const HMAC_MESSAGE_PREFIX = 'lain-owner-v2'");
  });

  it('digests signature as hex string', () => {
    expect(ownerAuthSource).toContain(".digest('hex')");
  });

  it('exports issueOwnerCookie function', () => {
    expect(ownerAuthSource).toContain('export function issueOwnerCookie');
  });
});

// ─────────────────────────────────────────────────────────
// 2. isOwner — Timing-safe comparison
// ─────────────────────────────────────────────────────────
describe('isOwner Authentication', () => {
  it('uses timingSafeEqual for comparison (prevents timing attacks)', () => {
    expect(ownerAuthSource).toContain('timingSafeEqual');
  });

  it('imports timingSafeEqual from node:crypto', () => {
    expect(ownerAuthSource).toContain("import { createHmac, timingSafeEqual } from 'node:crypto'");
  });

  it('checks LAIN_OWNER_TOKEN from environment', () => {
    expect(ownerAuthSource).toContain("process.env['LAIN_OWNER_TOKEN']");
  });

  it('returns null when owner token is not set', () => {
    // findings.md P2:2348 — verifyOwnerCookie returns null (not false) on
    // missing token, and `isOwner` converts null → false. The branch still
    // emits warn-once so the operator sees the disabled state in logs.
    expect(ownerAuthSource).toMatch(/if \(!ownerToken\)\s*\{[\s\S]{0,160}return null/);
    expect(ownerAuthSource).toContain('warnMissingTokenOnce()');
  });

  it('returns null when no cookie is present', () => {
    expect(ownerAuthSource).toContain('if (!cookie) return null');
  });

  it('short-circuits on length mismatch before comparison', () => {
    // Guard against a signature-length oracle before the timing-safe compare.
    expect(ownerAuthSource).toContain('if (expected.length !== provided.length) return null');
  });

  it('uses correct v2 cookie regex pattern (payload.sig)', () => {
    expect(ownerAuthSource).toContain('/(?:^|;\\s*)lain_owner_v2=([A-Za-z0-9_\\-]+)\\.([a-f0-9]+)/');
  });
});

// ─────────────────────────────────────────────────────────
// 3. OWNER COOKIE SETTINGS — HttpOnly, SameSite
// ─────────────────────────────────────────────────────────
describe('Owner Cookie Settings', () => {
  it('cookie name is lain_owner_v2', () => {
    expect(ownerAuthSource).toContain("const COOKIE_NAME = 'lain_owner_v2'");
  });

  it('sets HttpOnly flag', () => {
    expect(ownerAuthSource).toContain('HttpOnly');
  });

  it('sets SameSite=Strict', () => {
    expect(ownerAuthSource).toContain('SameSite=Strict');
  });

  it('sets Path=/', () => {
    expect(ownerAuthSource).toContain('Path=/');
  });

  it('sets Max-Age for long-lived cookie', () => {
    expect(ownerAuthSource).toContain('Max-Age=31536000');
  });

  it('exports issueOwnerCookie function', () => {
    expect(ownerAuthSource).toContain('export function issueOwnerCookie');
  });

  it('exports clearOwnerCookie function (for /owner/logout)', () => {
    expect(ownerAuthSource).toContain('export function clearOwnerCookie');
  });
});

// ─────────────────────────────────────────────────────────
// 4. FUNCTIONAL — v2 cookie issuance and isOwner verification
// ─────────────────────────────────────────────────────────
describe('Owner Auth Functional', () => {
  let isOwner: (req: import('node:http').IncomingMessage) => boolean;
  let makeV2Cookie: (token: string, opts?: { signWith?: string; nonce?: string; iat?: number }) => string;

  const originalToken = process.env['LAIN_OWNER_TOKEN'];

  beforeEach(async () => {
    const mod = await import('../src/web/owner-auth.js');
    isOwner = mod.isOwner;
    const helper = await import('./fixtures/owner-cookie-v2.js');
    makeV2Cookie = helper.makeV2Cookie;
  });

  afterEach(() => {
    if (originalToken) {
      process.env['LAIN_OWNER_TOKEN'] = originalToken;
    } else {
      delete process.env['LAIN_OWNER_TOKEN'];
    }
  });

  it('v2 cookie signature is token-specific', () => {
    const fixedOpts = { nonce: 'n', iat: 1 };
    expect(makeV2Cookie('a', fixedOpts)).not.toBe(makeV2Cookie('b', fixedOpts));
  });

  it('isOwner returns false when LAIN_OWNER_TOKEN is not set', () => {
    delete process.env['LAIN_OWNER_TOKEN'];
    const fakeReq = { headers: { cookie: makeV2Cookie('test-token') } } as unknown as import('node:http').IncomingMessage;
    expect(isOwner(fakeReq)).toBe(false);
  });

  it('isOwner returns false when no cookie header', () => {
    process.env['LAIN_OWNER_TOKEN'] = 'test-token';
    const fakeReq = { headers: {} } as unknown as import('node:http').IncomingMessage;
    expect(isOwner(fakeReq)).toBe(false);
  });

  it('isOwner returns false for wrong-token signature', () => {
    process.env['LAIN_OWNER_TOKEN'] = 'test-token';
    const fakeReq = {
      headers: { cookie: makeV2Cookie('test-token', { signWith: 'other-token' }) },
    } as unknown as import('node:http').IncomingMessage;
    expect(isOwner(fakeReq)).toBe(false);
  });

  it('isOwner returns true for correct v2 cookie', () => {
    process.env['LAIN_OWNER_TOKEN'] = 'test-token';
    const fakeReq = { headers: { cookie: makeV2Cookie('test-token') } } as unknown as import('node:http').IncomingMessage;
    expect(isOwner(fakeReq)).toBe(true);
  });

  it('isOwner handles v2 cookie among multiple cookies', () => {
    process.env['LAIN_OWNER_TOKEN'] = 'test-token';
    const v2 = makeV2Cookie('test-token');
    const fakeReq = { headers: { cookie: `other=abc; ${v2}; another=xyz` } } as unknown as import('node:http').IncomingMessage;
    expect(isOwner(fakeReq)).toBe(true);
  });

  it('isOwner rejects legacy v1 cookies outright', () => {
    process.env['LAIN_OWNER_TOKEN'] = 'test-token';
    const fakeReq = {
      headers: { cookie: 'lain_owner=' + 'a'.repeat(64) },
    } as unknown as import('node:http').IncomingMessage;
    expect(isOwner(fakeReq)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────
// 5. SERVER AUTH — Protected and public endpoints
// ─────────────────────────────────────────────────────────
describe('Server Auth Middleware', () => {
  it('health endpoint does not require auth', () => {
    // /api/health returns 200 without auth check
    const healthSection = serverSource.substring(
      serverSource.indexOf("/api/health"),
      serverSource.indexOf("/api/health") + 200
    );
    expect(healthSection).toContain("'GET'");
    expect(healthSection).not.toContain('verifyApiAuth');
    expect(healthSection).not.toContain('isOwner');
  });

  it('characters endpoint does not require auth', () => {
    // /api/characters is public for commune map
    const charsSection = serverSource.substring(
      serverSource.indexOf("/api/characters"),
      serverSource.indexOf("/api/characters") + 200
    );
    expect(charsSection).toContain("'GET'");
    // Should be clearly commented as no-auth
    expect(serverSource).toContain('Character manifest (no auth');
  });

  it('chat endpoint requires owner auth', () => {
    // OWNER_ONLY_PATHS includes /api/chat
    expect(serverSource).toContain("'/api/chat'");
    expect(serverSource).toContain("'/api/chat/stream'");
  });

  it('internal-state endpoint requires interlink auth on main server', () => {
    const stateSection = serverSource.substring(
      serverSource.indexOf("/api/internal-state"),
      serverSource.indexOf("/api/internal-state") + 200
    );
    expect(stateSection).toContain('verifyInterlinkAuth');
  });

  it('character server chat endpoints require owner auth', () => {
    expect(charServerSource).toContain("if (!isOwner(req))");
  });

  it('character server internal-state requires interlink auth', () => {
    const charStateSection = charServerSource.substring(
      charServerSource.indexOf("/api/internal-state"),
      charServerSource.indexOf("/api/internal-state") + 200
    );
    expect(charStateSection).toContain('verifyInterlinkAuth');
  });
});

// ─────────────────────────────────────────────────────────
// 6. CORS — Configurable origin
// ─────────────────────────────────────────────────────────
describe('CORS Configuration', () => {
  it('CORS origin is configurable via LAIN_CORS_ORIGIN', () => {
    // findings.md P2:2366 — CORS lookup lives in the shared cors.ts helper now.
    expect(corsSource).toContain("LAIN_CORS_ORIGIN");
  });

  it('CORS defaults to wildcard when not configured', () => {
    // findings.md P2:2366 — server.ts delegates to getCorsOrigin('*') via cors.ts helper.
    expect(serverSource).toContain("getCorsOrigin('*')");
  });

  it('sets Access-Control-Allow-Origin header', () => {
    expect(serverSource).toContain('Access-Control-Allow-Origin');
  });

  it('sets Access-Control-Allow-Methods header', () => {
    expect(serverSource).toContain('Access-Control-Allow-Methods');
  });

  it('sets Access-Control-Allow-Headers header', () => {
    expect(serverSource).toContain('Access-Control-Allow-Headers');
  });

  it('handles OPTIONS preflight requests', () => {
    expect(serverSource).toContain("req.method === 'OPTIONS'");
  });
});

// ─────────────────────────────────────────────────────────
// 7. INPUT SANITIZATION — Message length and body limits
// ─────────────────────────────────────────────────────────
describe('Input Sanitization', () => {
  it('enforces maximum body size (1MB)', () => {
    expect(serverSource).toContain('const MAX_BODY_BYTES = 1_048_576');
  });

  it('destroys request when body exceeds limit', () => {
    expect(serverSource).toContain('req.destroy()');
    expect(serverSource).toContain("reject(new Error('PAYLOAD_TOO_LARGE'))");
  });

  it('sanitizer module enforces maxLength on inputs', () => {
    expect(sanitizerSource).toContain('input.length > cfg.maxLength');
  });

  it('sanitizer detects prompt injection patterns', () => {
    expect(sanitizerSource).toContain('Potential prompt injection detected');
  });

  it('sanitizer blocks role manipulation attempts', () => {
    expect(sanitizerSource).toContain('you\\s+are\\s+(now|no\\s+longer)');
  });

  it('sanitizer blocks system prompt extraction attempts', () => {
    expect(sanitizerSource).toContain('what\\s+(is|are)\\s+your\\s+(system|initial)');
  });

  it('server imports sanitize from security module', () => {
    expect(serverSource).toContain("import { sanitize } from '../security/sanitizer.js'");
  });
});

// ─────────────────────────────────────────────────────────
// 8. INTERLINK TOKEN — Peer communication auth
// ─────────────────────────────────────────────────────────
describe('Interlink Token Authentication', () => {
  // Per-character tokens (findings.md P1:2289): the interlink verifier lives in
  // src/security/interlink-auth.ts and derives per-character tokens via HMAC.
  // server.ts / character-server.ts call verifyInterlinkRequest() and treat the
  // authenticated X-Interlink-From as the source of truth for identity.
  it('interlink-auth references LAIN_INTERLINK_TOKEN as the master secret', () => {
    expect(interlinkAuthSource).toContain('LAIN_INTERLINK_TOKEN');
  });

  it('server delegates to verifyInterlinkRequest', () => {
    expect(serverSource).toContain('verifyInterlinkRequest');
  });

  it('character server verifies interlink auth on protected endpoints', () => {
    expect(charServerSource).toContain('verifyInterlinkAuth');
    expect(charServerSource).toContain('verifyInterlinkRequest');
  });

  it('interlink auth checks for Bearer token in Authorization header', () => {
    expect(interlinkAuthSource).toContain("auth.startsWith('Bearer ')");
  });

  it('interlink auth returns 401 for missing header', () => {
    expect(interlinkAuthSource).toContain("'Missing X-Interlink-From header'");
    expect(interlinkAuthSource).toContain("'Missing or invalid Authorization header'");
  });

  it('interlink auth returns 403 for invalid token', () => {
    expect(interlinkAuthSource).toContain("'Invalid interlink token'");
  });

  it('interlink auth returns 503 when not configured', () => {
    expect(interlinkAuthSource).toContain("'Interlink not configured'");
  });

  it('interlink auth uses secureCompare (not ===)', () => {
    expect(interlinkAuthSource).toContain('secureCompare(');
  });
});

// ─────────────────────────────────────────────────────────
// 9. NO HARDCODED SECRETS — Source code review
// ─────────────────────────────────────────────────────────
describe('No Hardcoded Secrets', () => {
  it('server.ts has no hardcoded API keys', () => {
    // API keys should come from env vars, not be literal strings
    expect(serverSource).not.toMatch(/ANTHROPIC_API_KEY\s*=\s*['"][a-zA-Z0-9-]{20,}['"]/);
    expect(serverSource).not.toMatch(/OPENAI_API_KEY\s*=\s*['"][a-zA-Z0-9-]{20,}['"]/);
  });

  it('character-server.ts has no hardcoded API keys', () => {
    expect(charServerSource).not.toMatch(/ANTHROPIC_API_KEY\s*=\s*['"][a-zA-Z0-9-]{20,}['"]/);
    expect(charServerSource).not.toMatch(/OPENAI_API_KEY\s*=\s*['"][a-zA-Z0-9-]{20,}['"]/);
  });

  it('owner-auth.ts has no hardcoded tokens', () => {
    expect(ownerAuthSource).not.toMatch(/LAIN_OWNER_TOKEN\s*=\s*['"][a-zA-Z0-9-]{20,}['"]/);
  });

  it('tools.ts has no hardcoded API keys', () => {
    expect(toolsSource).not.toMatch(/ANTHROPIC_API_KEY\s*=\s*['"][a-zA-Z0-9-]{20,}['"]/);
  });
});

// ─────────────────────────────────────────────────────────
// 10. NO eval() IN SERVER CODE
// ─────────────────────────────────────────────────────────
describe('No eval() in Server Code', () => {
  it('server.ts does not use eval()', () => {
    // Match actual eval() calls, not strings like "evaluation"
    expect(serverSource).not.toMatch(/\beval\s*\(/);
  });

  it('character-server.ts does not use eval()', () => {
    expect(charServerSource).not.toMatch(/\beval\s*\(/);
  });

  it('owner-auth.ts does not use eval()', () => {
    expect(ownerAuthSource).not.toMatch(/\beval\s*\(/);
  });
});

// ─────────────────────────────────────────────────────────
// 11. FETCH_WEBPAGE SECURITY — Blocks non-http(s) URLs
// ─────────────────────────────────────────────────────────
describe('Fetch Webpage URL Security', () => {
  it('routes through safeFetch (protocol + private-IP + DNS-pin)', () => {
    // Protocol validation and private-IP blocking moved into safeFetch
    // in src/security/ssrf.ts (see security-deep.test.ts for the full
    // regression). The fetch_webpage handler now awaits safeFetch so
    // any non-http/https or private-IP URL throws before a fetch fires.
    const section = toolsSource.match(
      /name: 'fetch_webpage'[\s\S]*?\n  \},\n\}\);/
    );
    expect(section).not.toBeNull();
    expect(section![0]).toMatch(/await safeFetch\(url,/);
  });

  it('safeFetch is imported from security/ssrf', () => {
    expect(toolsSource).toMatch(
      /import\s*\{\s*safeFetch,\s*safeFetchFollow\s*\}\s*from\s*'\.\.\/security\/ssrf\.js'/
    );
  });

  it('constructs URL object for validation (catches malformed URLs)', () => {
    expect(toolsSource).toContain('new URL(url)');
  });
});

// ─────────────────────────────────────────────────────────
// 12. CALCULATE TOOL INJECTION PREVENTION
// ─────────────────────────────────────────────────────────
describe('Calculate Tool Injection Prevention', () => {
  it('sanitizes input before evaluation', () => {
    expect(toolsSource).toContain("expression.replace(/[^0-9+\\-*/().sqrt\\s]/g, '')");
  });

  it('does not use eval() directly', () => {
    // The calculate tool uses new Function, not eval
    const calcSection = toolsSource.substring(
      toolsSource.indexOf("name: 'calculate'"),
      toolsSource.indexOf("name: 'calculate'") + 1000
    );
    expect(calcSection).not.toMatch(/\beval\s*\(/);
    expect(calcSection).toContain('new Function');
  });
});

// ─────────────────────────────────────────────────────────
// 13. SSRF PROTECTION
// ─────────────────────────────────────────────────────────
describe('SSRF Protection', () => {
  it('blocks file: scheme URLs', () => {
    expect(ssrfSource).toContain("'file:'");
  });

  it('blocks data: scheme URLs', () => {
    expect(ssrfSource).toContain("'data:'");
  });

  it('blocks javascript: scheme URLs', () => {
    expect(ssrfSource).toContain("'javascript:'");
  });

  it('blocks localhost', () => {
    expect(ssrfSource).toContain("'localhost'");
  });

  it('blocks cloud metadata endpoints', () => {
    expect(ssrfSource).toContain("'169.254.169.254'");
    expect(ssrfSource).toContain("'metadata.google.internal'");
  });

  it('blocks private IP ranges', () => {
    expect(ssrfSource).toContain('/^10\\./');
    expect(ssrfSource).toContain('/^192\\.168\\./');
    expect(ssrfSource).toContain('/^127\\./');
  });

  it('checks DNS resolution for private IPs (DNS rebinding)', () => {
    expect(ssrfSource).toContain('DNS resolution returned private IP');
  });

  it('server imports safeFetch from security module', () => {
    expect(serverSource).toContain("import { safeFetch } from '../security/ssrf.js'");
  });

  it('sanitizeURL removes credentials from URLs', () => {
    expect(ssrfSource).toContain("parsed.username = ''");
    expect(ssrfSource).toContain("parsed.password = ''");
  });

  it('safeFetch does not follow redirects automatically', () => {
    expect(ssrfSource).toContain("redirect: 'manual'");
  });

  it('safeFetch checks redirect location for SSRF', () => {
    expect(ssrfSource).toContain('SSRF protection on redirect');
  });
});

// ─────────────────────────────────────────────────────────
// 14. SECURITY HEADERS
// ─────────────────────────────────────────────────────────
describe('Security Headers', () => {
  it('sets X-Content-Type-Options nosniff', () => {
    expect(serverSource).toContain('X-Content-Type-Options');
    expect(serverSource).toContain('nosniff');
  });

  it('sets X-Frame-Options DENY', () => {
    expect(serverSource).toContain('X-Frame-Options');
    expect(serverSource).toContain('DENY');
  });

  it('sets Referrer-Policy', () => {
    expect(serverSource).toContain('Referrer-Policy');
    expect(serverSource).toContain('strict-origin-when-cross-origin');
  });

  it('sets Content-Security-Policy', () => {
    expect(serverSource).toContain('Content-Security-Policy');
  });
});

// ─────────────────────────────────────────────────────────
// 15. RATE LIMITING
// ─────────────────────────────────────────────────────────
describe('Rate Limiting', () => {
  it('implements per-IP rate limiting', () => {
    expect(serverSource).toContain('checkRateLimit');
  });

  it('rate limit window is 60 seconds', () => {
    expect(serverSource).toContain('const RATE_LIMIT_WINDOW_MS = 60_000');
  });

  it('rate limit allows 30 requests per window', () => {
    expect(serverSource).toContain('const RATE_LIMIT_MAX = 30');
  });

  it('prunes expired rate limit entries', () => {
    expect(serverSource).toContain('rateLimitMap.delete(ip)');
  });
});

// ─────────────────────────────────────────────────────────
// 16. OWNER-ONLY PATH PROTECTION
// ─────────────────────────────────────────────────────────
describe('Owner-Only Path Protection', () => {
  it('defines OWNER_ONLY_PATHS array', () => {
    expect(serverSource).toContain('const OWNER_ONLY_PATHS = [');
  });

  it('protects dashboard.html', () => {
    expect(serverSource).toContain("'/dashboard.html'");
  });

  it('protects /api/chat', () => {
    expect(serverSource).toContain("'/api/chat'");
  });

  it('protects /api/chat/stream', () => {
    expect(serverSource).toContain("'/api/chat/stream'");
  });

  it('redirects non-owners to commune-map', () => {
    expect(serverSource).toContain("Location: '/commune-map.html'");
  });

  it('checks isOwner before allowing restricted pages', () => {
    expect(serverSource).toContain('if (!isOwner(req))');
  });
});

// ─────────────────────────────────────────────────────────
// 17. CONSTANT-TIME STRING COMPARISON
// ─────────────────────────────────────────────────────────
describe('Constant-Time Comparison', () => {
  it('secureCompare does XOR-based comparison', () => {
    expect(cryptoSource).toContain('result |= a.charCodeAt(i) ^ b.charCodeAt(i)');
  });

  it('secureCompare short-circuits on length mismatch', () => {
    expect(cryptoSource).toContain('if (a.length !== b.length)');
  });

  it('returns result === 0 for match', () => {
    expect(cryptoSource).toContain('return result === 0');
  });
});

// ─────────────────────────────────────────────────────────
// 18. FUNCTIONAL — secureCompare
// ─────────────────────────────────────────────────────────
describe('secureCompare Functional', () => {
  let secureCompare: (a: string, b: string) => boolean;

  beforeAll(async () => {
    const mod = await import('../src/utils/crypto.js');
    secureCompare = mod.secureCompare;
  });

  it('returns true for matching strings', () => {
    expect(secureCompare('hello', 'hello')).toBe(true);
  });

  it('returns false for different strings', () => {
    expect(secureCompare('hello', 'world')).toBe(false);
  });

  it('returns false for different length strings', () => {
    expect(secureCompare('short', 'longer-string')).toBe(false);
  });

  it('returns true for empty strings', () => {
    expect(secureCompare('', '')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────
// 19. STATIC FILE PATH TRAVERSAL PROTECTION
// ─────────────────────────────────────────────────────────
describe('Path Traversal Protection', () => {
  it('server.ts resolves paths and checks they stay within public dir', () => {
    expect(serverSource).toContain('!filePath.startsWith(resolve(PUBLIC_DIR))');
  });

  it('character-server.ts has no path-traversal surface (no static file serving)', () => {
    // serveStatic was removed in findings.md P1:27 — inhabitant servers are
    // API-only, so there is no filesystem path to traverse.
    expect(charServerSource).not.toMatch(/function\s+serveStatic/);
    expect(charServerSource).not.toMatch(/publicDir:\s*string/);
  });
});

// ─────────────────────────────────────────────────────────
// 20. OWNER GATE ENDPOINT
// ─────────────────────────────────────────────────────────
describe('Owner Gate Endpoint', () => {
  it('gate endpoint exists at /gate', () => {
    expect(serverSource).toContain("/gate");
  });

  it('gate compares provided token with secureCompare', () => {
    expect(serverSource).toContain('secureCompare(provided, ownerToken)');
  });

  it('gate issues the owner cookie on success', () => {
    // findings.md P2:2348 — issueOwnerCookie replaces v1 setOwnerCookie. It
    // still takes (res, ownerToken, req) so TLS detection stays intact, but
    // it additionally writes a nonce to the authoritative store.
    expect(serverSource).toContain('issueOwnerCookie(res, ownerToken, req)');
  });

  it('gate redirects to root on success', () => {
    expect(serverSource).toContain("'Location': '/'");
  });

  it('gate returns 403 on invalid token', () => {
    expect(serverSource).toContain("res.writeHead(403");
  });
});

// ─────────────────────────────────────────────────────────
// 21. FUNCTIONAL — SSRF isPrivateIP
// ─────────────────────────────────────────────────────────
describe('isPrivateIP Functional', () => {
  let isPrivateIP: (ip: string) => boolean;

  beforeAll(async () => {
    const mod = await import('../src/security/ssrf.js');
    isPrivateIP = mod.isPrivateIP;
  });

  it('detects 10.x.x.x as private', () => {
    expect(isPrivateIP('10.0.0.1')).toBe(true);
  });

  it('detects 192.168.x.x as private', () => {
    expect(isPrivateIP('192.168.1.1')).toBe(true);
  });

  it('detects 127.x.x.x as private (loopback)', () => {
    expect(isPrivateIP('127.0.0.1')).toBe(true);
  });

  it('detects 172.16-31.x.x as private', () => {
    expect(isPrivateIP('172.16.0.1')).toBe(true);
    expect(isPrivateIP('172.31.255.255')).toBe(true);
  });

  it('detects link-local 169.254.x.x as private', () => {
    expect(isPrivateIP('169.254.1.1')).toBe(true);
  });

  it('detects IPv6 loopback ::1 as private', () => {
    expect(isPrivateIP('::1')).toBe(true);
  });

  it('allows public IPs', () => {
    expect(isPrivateIP('8.8.8.8')).toBe(false);
    expect(isPrivateIP('1.1.1.1')).toBe(false);
  });
});
