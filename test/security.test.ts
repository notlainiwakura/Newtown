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

const ownerAuthSource = readFileSync(OWNER_AUTH_PATH, 'utf-8');
const serverSource = readFileSync(SERVER_PATH, 'utf-8');
const charServerSource = readFileSync(CHAR_SERVER_PATH, 'utf-8');
const toolsSource = readFileSync(TOOLS_PATH, 'utf-8');
const ssrfSource = readFileSync(SSRF_PATH, 'utf-8');
const sanitizerSource = readFileSync(SANITIZER_PATH, 'utf-8');
const cryptoSource = readFileSync(CRYPTO_PATH, 'utf-8');

// ─────────────────────────────────────────────────────────
// 1. OWNER COOKIE DERIVATION — HMAC-SHA256 based
// ─────────────────────────────────────────────────────────
describe('Owner Cookie Derivation', () => {
  it('uses HMAC-SHA256 for cookie derivation', () => {
    expect(ownerAuthSource).toContain("createHmac('sha256'");
  });

  it('uses hmac function from node:crypto', () => {
    expect(ownerAuthSource).toContain('createHmac');
  });

  it('uses a fixed message for HMAC input', () => {
    expect(ownerAuthSource).toContain("const HMAC_MESSAGE = 'lain-owner-v1'");
  });

  it('digests as hex string', () => {
    expect(ownerAuthSource).toContain(".digest('hex')");
  });

  it('exports deriveOwnerCookie function', () => {
    expect(ownerAuthSource).toContain('export function deriveOwnerCookie(ownerToken: string): string');
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

  it('returns false when owner token is not set', () => {
    expect(ownerAuthSource).toContain('if (!ownerToken) return false');
  });

  it('returns false when no cookie is present', () => {
    expect(ownerAuthSource).toContain('if (!cookie) return false');
  });

  it('short-circuits on length mismatch before comparison', () => {
    expect(ownerAuthSource).toContain('if (expected.length !== provided.length) return false');
  });

  it('uses correct cookie regex pattern', () => {
    expect(ownerAuthSource).toContain('/(?:^|;\\s*)lain_owner=([a-f0-9]+)/');
  });
});

// ─────────────────────────────────────────────────────────
// 3. OWNER COOKIE SETTINGS — HttpOnly, SameSite
// ─────────────────────────────────────────────────────────
describe('Owner Cookie Settings', () => {
  it('cookie name is lain_owner', () => {
    expect(ownerAuthSource).toContain("const COOKIE_NAME = 'lain_owner'");
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

  it('exports setOwnerCookie function', () => {
    expect(ownerAuthSource).toContain('export function setOwnerCookie');
  });
});

// ─────────────────────────────────────────────────────────
// 4. FUNCTIONAL — deriveOwnerCookie and isOwner
// ─────────────────────────────────────────────────────────
describe('Owner Auth Functional', () => {
  let deriveOwnerCookie: (token: string) => string;
  let isOwner: (req: import('node:http').IncomingMessage) => boolean;

  const originalToken = process.env['LAIN_OWNER_TOKEN'];

  beforeEach(async () => {
    const mod = await import('../src/web/owner-auth.js');
    deriveOwnerCookie = mod.deriveOwnerCookie;
    isOwner = mod.isOwner;
  });

  afterEach(() => {
    if (originalToken) {
      process.env['LAIN_OWNER_TOKEN'] = originalToken;
    } else {
      delete process.env['LAIN_OWNER_TOKEN'];
    }
  });

  it('deriveOwnerCookie returns consistent hex string', () => {
    const cookie1 = deriveOwnerCookie('test-token');
    const cookie2 = deriveOwnerCookie('test-token');
    expect(cookie1).toBe(cookie2);
    expect(cookie1).toMatch(/^[a-f0-9]+$/);
  });

  it('different tokens produce different cookies', () => {
    const cookie1 = deriveOwnerCookie('token-a');
    const cookie2 = deriveOwnerCookie('token-b');
    expect(cookie1).not.toBe(cookie2);
  });

  it('isOwner returns false when LAIN_OWNER_TOKEN is not set', () => {
    delete process.env['LAIN_OWNER_TOKEN'];
    const fakeReq = { headers: { cookie: 'lain_owner=abc123' } } as unknown as import('node:http').IncomingMessage;
    expect(isOwner(fakeReq)).toBe(false);
  });

  it('isOwner returns false when no cookie header', () => {
    process.env['LAIN_OWNER_TOKEN'] = 'test-token';
    const fakeReq = { headers: {} } as unknown as import('node:http').IncomingMessage;
    expect(isOwner(fakeReq)).toBe(false);
  });

  it('isOwner returns false for wrong cookie value', () => {
    process.env['LAIN_OWNER_TOKEN'] = 'test-token';
    const fakeReq = { headers: { cookie: 'lain_owner=wrongvalue' } } as unknown as import('node:http').IncomingMessage;
    expect(isOwner(fakeReq)).toBe(false);
  });

  it('isOwner returns true for correct cookie value', () => {
    process.env['LAIN_OWNER_TOKEN'] = 'test-token';
    const correctCookie = deriveOwnerCookie('test-token');
    const fakeReq = { headers: { cookie: `lain_owner=${correctCookie}` } } as unknown as import('node:http').IncomingMessage;
    expect(isOwner(fakeReq)).toBe(true);
  });

  it('isOwner handles cookie among multiple cookies', () => {
    process.env['LAIN_OWNER_TOKEN'] = 'test-token';
    const correctCookie = deriveOwnerCookie('test-token');
    const fakeReq = { headers: { cookie: `other=abc; lain_owner=${correctCookie}; another=xyz` } } as unknown as import('node:http').IncomingMessage;
    expect(isOwner(fakeReq)).toBe(true);
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
    expect(serverSource).toContain("LAIN_CORS_ORIGIN");
  });

  it('CORS defaults to wildcard when not configured', () => {
    expect(serverSource).toContain("process.env['LAIN_CORS_ORIGIN'] || '*'");
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
  it('server requires LAIN_INTERLINK_TOKEN for peer communication', () => {
    expect(serverSource).toContain("LAIN_INTERLINK_TOKEN");
  });

  it('character server verifies interlink auth on protected endpoints', () => {
    expect(charServerSource).toContain('verifyInterlinkAuth');
  });

  it('interlink auth checks for Bearer token in Authorization header', () => {
    expect(charServerSource).toContain("authHeader.startsWith('Bearer ')");
  });

  it('interlink auth returns 401 for missing header', () => {
    expect(charServerSource).toContain("'Missing or invalid Authorization header'");
  });

  it('interlink auth returns 403 for invalid token', () => {
    expect(charServerSource).toContain("'Invalid token'");
  });

  it('interlink auth returns 503 when not configured', () => {
    expect(charServerSource).toContain("'Interlink not configured'");
  });

  it('interlink auth uses secureCompare (not ===)', () => {
    expect(charServerSource).toContain('secureCompare(');
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
  it('validates protocol is http or https', () => {
    expect(toolsSource).toContain("!['http:', 'https:'].includes(parsedUrl.protocol)");
  });

  it('returns error message for blocked protocols', () => {
    expect(toolsSource).toContain('error: only http and https URLs are supported');
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

  it('character-server.ts strips .. from paths', () => {
    expect(charServerSource).toContain("path.replace(/\\.\\./g, '')");
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

  it('gate sets owner cookie on success', () => {
    expect(serverSource).toContain('setOwnerCookie(res, ownerToken)');
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
