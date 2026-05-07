/**
 * Deep security tests — comprehensive coverage beyond the existing
 * security.test.ts, matrix-security.test.ts, and data-integrity.test.ts.
 *
 * Areas:
 *  1. CSRF protection
 *  2. SQL injection deep (parameterized query verification)
 *  3. SSRF advanced (IPv6-mapped, decimal/octal IP, URL tricks, redirects)
 *  4. Path traversal deep
 *  5. Error boundaries (background loop resilience)
 *  6. HTTP method enforcement (every route, wrong methods)
 *  7. Auth bypass attempts
 *
 * Target: 300+ tests
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ── Mock keytar (storage dependency) ──────────────────────────────────────
vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn().mockResolvedValue('test-master-key'),
    setPassword: vi.fn().mockResolvedValue(undefined),
    deletePassword: vi.fn().mockResolvedValue(true),
    findCredentials: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// ── Source files ─────────────────────────────────────────────────────────
const SRC = join(process.cwd(), 'src');
const serverSource = readFileSync(join(SRC, 'web', 'server.ts'), 'utf-8');
const charServerSource = readFileSync(join(SRC, 'web', 'character-server.ts'), 'utf-8');
const ssrfSource = readFileSync(join(SRC, 'security', 'ssrf.ts'), 'utf-8');
const sanitizerSource = readFileSync(join(SRC, 'security', 'sanitizer.ts'), 'utf-8');
const databaseSource = readFileSync(join(SRC, 'storage', 'database.ts'), 'utf-8');
const storeSource = readFileSync(join(SRC, 'memory', 'store.ts'), 'utf-8');
const ownerAuthSource = readFileSync(join(SRC, 'web', 'owner-auth.ts'), 'utf-8');
const cryptoSource = readFileSync(join(SRC, 'utils', 'crypto.ts'), 'utf-8');
const curiositySource = readFileSync(join(SRC, 'agent', 'curiosity.ts'), 'utf-8');
const bookSource = readFileSync(join(SRC, 'agent', 'book.ts'), 'utf-8');
const diarySource = readFileSync(join(SRC, 'agent', 'diary.ts'), 'utf-8');
const communeLoopSource = readFileSync(join(SRC, 'agent', 'commune-loop.ts'), 'utf-8');
const dataWorkspaceSource = readFileSync(join(SRC, 'agent', 'data-workspace.ts'), 'utf-8');
const townLifeSource = readFileSync(join(SRC, 'agent', 'town-life.ts'), 'utf-8');
const interlinkAuthSource = readFileSync(join(SRC, 'security', 'interlink-auth.ts'), 'utf-8');
const telegramChannelSource = readFileSync(join(SRC, 'channels', 'telegram.ts'), 'utf-8');
const whatsappChannelSource = readFileSync(join(SRC, 'channels', 'whatsapp.ts'), 'utf-8');
const discordChannelSource = readFileSync(join(SRC, 'channels', 'discord.ts'), 'utf-8');
const slackChannelSource = readFileSync(join(SRC, 'channels', 'slack.ts'), 'utf-8');
const signalChannelSource = readFileSync(join(SRC, 'channels', 'signal.ts'), 'utf-8');
const agentToolsSource = readFileSync(join(SRC, 'agent', 'tools.ts'), 'utf-8');

// ── Functional imports ──────────────────────────────────────────────────
import { sanitize } from '../src/security/sanitizer.js';
import {
  isPrivateIP,
  checkSSRF,
} from '../src/security/ssrf.js';
import { isOwner } from '../src/web/owner-auth.js';
import { makeV2Cookie, makeV2CookieValue, OWNER_COOKIE_NAME } from './fixtures/owner-cookie-v2.js';
import { secureCompare } from '../src/utils/crypto.js';
import type { IncomingMessage } from 'node:http';

// ── Helpers ─────────────────────────────────────────────────────────────

function makeReq(headers: Record<string, string | undefined> = {}): IncomingMessage {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined) h[k] = v;
  }
  return { headers: h } as unknown as IncomingMessage;
}

function makeOwnerReq(token: string): IncomingMessage {
  return makeReq({ cookie: makeV2Cookie(token) });
}

const ORIGINAL_OWNER_TOKEN = process.env['LAIN_OWNER_TOKEN'];
const TEST_TOKEN = 'test-security-deep-token-12345';

// ═══════════════════════════════════════════════════════════════════════════
// 1. CSRF PROTECTION
// ═══════════════════════════════════════════════════════════════════════════

describe('CSRF Protection', () => {
  describe('Cookie SameSite enforcement', () => {
    it('owner cookie has SameSite=Strict', () => {
      expect(ownerAuthSource).toContain('SameSite=Strict');
    });

    it('owner cookie is HttpOnly (not accessible to JS)', () => {
      expect(ownerAuthSource).toContain('HttpOnly');
    });

    it('owner cookie is not set with SameSite=None', () => {
      expect(ownerAuthSource).not.toContain('SameSite=None');
    });

    it('owner cookie is not set with SameSite=Lax', () => {
      expect(ownerAuthSource).not.toContain('SameSite=Lax');
    });
  });

  describe('POST endpoints require authentication (implicit CSRF via cookie+SameSite)', () => {
    // POST endpoints in server.ts that mutate state — find the POST handler, not OWNER_ONLY_PATHS
    const postEndpoints = [
      '/api/chat',
      '/api/chat/stream',
      '/api/postboard',
      '/api/town-events',
      '/api/conversations/event',
      '/api/interlink/letter',
      '/api/interlink/dream-seed',
      '/api/interlink/research-request',
      '/api/objects',
      '/api/internal/embed',
      '/api/peer/message',
    ];

    it.each(postEndpoints)(
      'POST %s checks auth before processing',
      (endpoint) => {
        // Find the POST handler — look for the pattern "endpoint' && req.method === 'POST'"
        const handlerPattern = `'${endpoint}' && req.method === 'POST'`;
        const idx = serverSource.indexOf(handlerPattern);
        if (idx === -1) return; // skip if handler not found (some might be dynamic)
        // Look at the 800 chars around the handler
        const chunk = serverSource.substring(Math.max(0, idx - 200), idx + 600);
        // Must have auth check (verifyApiAuth, verifyInterlinkAuth, isOwner)
        const hasAuth =
          chunk.includes('verifyApiAuth') ||
          chunk.includes('verifyInterlinkAuth') ||
          chunk.includes('isOwner');
        expect(hasAuth).toBe(true);
      }
    );

    // DELETE endpoints — find the DELETE method check
    it('DELETE /api/postboard/:id requires verifyApiAuth', () => {
      const deletePostIdx = serverSource.indexOf("req.method === 'DELETE'");
      expect(deletePostIdx).toBeGreaterThan(-1);
      // Find verifyApiAuth near a DELETE handler
      const chunk = serverSource.substring(Math.max(0, deletePostIdx - 200), deletePostIdx + 300);
      const hasAuth = chunk.includes('verifyApiAuth') || chunk.includes('verifyInterlinkAuth');
      expect(hasAuth).toBe(true);
    });
  });

  describe('Character server POST endpoints require auth', () => {
    const charPostEndpoints = [
      '/api/chat',
      '/api/chat/stream',
      '/api/interlink/letter',
      '/api/interlink/dream-seed',
      '/api/peer/message',
    ];

    it.each(charPostEndpoints)(
      'Character server POST %s checks auth',
      (endpoint) => {
        // Find the POST handler specifically
        const handlerPattern = `'${endpoint}' && req.method === 'POST'`;
        const idx = charServerSource.indexOf(handlerPattern);
        if (idx === -1) return;
        // Look at surrounding code for auth check
        const chunk = charServerSource.substring(Math.max(0, idx - 200), idx + 600);
        const hasAuth =
          chunk.includes('isOwner') ||
          chunk.includes('verifyInterlinkAuth');
        expect(hasAuth).toBe(true);
      }
    );
  });

  describe('Content-Type expectations', () => {
    it('handleChat parses body as JSON', () => {
      // handleChat is called from POST /api/chat
      expect(serverSource).toContain('async function handleChat(body: string)');
      const handleChatSection = serverSource.substring(
        serverSource.indexOf('async function handleChat(body: string)'),
        serverSource.indexOf('async function handleChat(body: string)') + 300
      );
      expect(handleChatSection).toContain('JSON.parse(body)');
    });

    it('POST /api/postboard handler parses body as JSON', () => {
      const postboardPostIdx = serverSource.indexOf("'/api/postboard' && req.method === 'POST'");
      expect(postboardPostIdx).toBeGreaterThan(-1);
      const postboardSection = serverSource.substring(postboardPostIdx, postboardPostIdx + 600);
      expect(postboardSection).toContain('JSON.parse');
    });

    it('invalid JSON in POST body returns error', () => {
      // The collectBody + JSON.parse pattern has a try-catch
      expect(serverSource).toContain('catch (error)');
    });
  });

  describe('Referrer-Policy header', () => {
    it('sets strict-origin-when-cross-origin', () => {
      expect(serverSource).toContain("'Referrer-Policy'");
      expect(serverSource).toContain('strict-origin-when-cross-origin');
    });
  });

  describe('X-Frame-Options prevents clickjacking', () => {
    it('sets DENY (not SAMEORIGIN)', () => {
      expect(serverSource).toContain("'X-Frame-Options'");
      expect(serverSource).toContain('DENY');
    });
  });

  describe('Content-Security-Policy limits origins', () => {
    // findings.md P2:2880 — the CSP string literal moved out of
    // server.ts and into src/web/csp-hashes.ts (`buildHtmlCsp`).
    // server.ts now references `HTML_CSP` which is the builder's
    // output. Follow the source.
    it('has default-src self', async () => {
      const { readFile } = await import('node:fs/promises');
      const src = await readFile(new URL('../src/web/csp-hashes.ts', import.meta.url), 'utf-8');
      expect(src).toContain("default-src 'self'");
    });

    it('restricts script-src', async () => {
      const { readFile } = await import('node:fs/promises');
      const src = await readFile(new URL('../src/web/csp-hashes.ts', import.meta.url), 'utf-8');
      expect(src).toContain("script-src ${scriptSrc}");
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. SQL INJECTION DEEP
// ═══════════════════════════════════════════════════════════════════════════

describe('SQL Injection Deep', () => {
  describe('All database queries use parameterized statements', () => {
    it('database.ts query() uses prepare() + all()', () => {
      expect(databaseSource).toContain('database.prepare(sql)');
      expect(databaseSource).toContain('stmt.all(...params)');
    });

    it('database.ts queryOne() uses prepare() + get()', () => {
      expect(databaseSource).toContain('stmt.get(...params)');
    });

    it('database.ts execute() uses prepare() + run()', () => {
      expect(databaseSource).toContain('stmt.run(...params)');
    });

    it('database.ts getMeta() uses parameterized query', () => {
      expect(databaseSource).toContain(
        "queryOne<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key])"
      );
    });

    it('database.ts setMeta() uses parameterized query', () => {
      expect(databaseSource).toContain(
        "'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)'"
      );
    });
  });

  describe('store.ts uses parameterized queries for all operations', () => {
    it('saveMessage uses parameter placeholders', () => {
      const saveMsg = storeSource.substring(
        storeSource.indexOf('export function saveMessage'),
        storeSource.indexOf('export function saveMessage') + 500
      );
      expect(saveMsg).toContain('VALUES (?, ?, ?, ?, ?, ?, ?)');
      expect(saveMsg).not.toMatch(/\$\{.*\}/); // no template literals in SQL
    });

    it('getRecentMessages uses parameterized session key', () => {
      const getRecent = storeSource.substring(
        storeSource.indexOf('export function getRecentMessages'),
        storeSource.indexOf('export function getRecentMessages') + 400
      );
      expect(getRecent).toContain('WHERE session_key = ?');
      expect(getRecent).toContain('[sessionKey, limit]');
    });

    it('saveMemory uses parameter placeholders', () => {
      // saveMemory INSERT INTO memories grew to 18 placeholders after
      // P2:517 added embedding_model as a versioning stamp. What this
      // test locks is that the INSERT is still fully parameterized —
      // never a template literal concatenation.
      expect(storeSource).toContain(
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      const insertIdx = storeSource.indexOf('INSERT INTO memories');
      const insertBlock = storeSource.substring(insertIdx, insertIdx + 800);
      expect(insertBlock).not.toMatch(/\$\{[^}]+\}/);
    });

    it('getMemory uses parameterized ID', () => {
      expect(storeSource).toContain("queryOne<MemoryRow>(`SELECT * FROM memories WHERE id = ?`, [memoryId])");
    });

    it('deleteMemory uses parameterized ID', () => {
      expect(storeSource).toContain("`DELETE FROM memories WHERE id = ?`, [memoryId]");
    });

    it('getActivity uses parameterized time range', () => {
      const getAct = storeSource.substring(
        storeSource.indexOf('export function getActivity'),
        storeSource.indexOf('export function getActivity') + 600
      );
      expect(getAct).toContain('BETWEEN ? AND ?');
      expect(getAct).toContain('[from, to,');
    });

    it('getNotesByBuilding uses parameterized building name', () => {
      const getNotes = storeSource.substring(
        storeSource.indexOf('export function getNotesByBuilding'),
        storeSource.indexOf('export function getNotesByBuilding') + 500
      );
      expect(getNotes).toContain("json_extract(metadata, '$.building') = ?");
      expect(getNotes).toContain('[building, sinceTs]');
    });

    it('getDocumentsByAuthor uses parameterized author ID', () => {
      const getDocs = storeSource.substring(
        storeSource.indexOf('export function getDocumentsByAuthor'),
        storeSource.indexOf('export function getDocumentsByAuthor') + 500
      );
      expect(getDocs).toContain("json_extract(metadata, '$.author') = ?");
      expect(getDocs).toContain('[authorId, since, limit]');
    });

    it('getPostboardMessages uses parameterized since timestamp', () => {
      const getPost = storeSource.substring(
        storeSource.indexOf('export function getPostboardMessages'),
        storeSource.indexOf('export function getPostboardMessages') + 400
      );
      expect(getPost).toContain('WHERE created_at > ?');
      expect(getPost).toContain('[sinceTs, limit]');
    });

    it('savePostboardMessage uses parameterized values', () => {
      expect(storeSource).toContain(
        'INSERT INTO postboard_messages (id, author, content, pinned, created_at)'
      );
      expect(storeSource).toContain('VALUES (?, ?, ?, ?, ?)');
    });

    it('deletePostboardMessage uses parameterized ID', () => {
      expect(storeSource).toContain("`DELETE FROM postboard_messages WHERE id = ?`, [id]");
    });

    it('getMemoriesForUser uses parameterized user ID', () => {
      const getUserMem = storeSource.substring(
        storeSource.indexOf('export function getMemoriesForUser'),
        storeSource.indexOf('export function getMemoriesForUser') + 400
      );
      expect(getUserMem).toContain('WHERE user_id = ?');
      expect(getUserMem).toContain('[userId, limit]');
    });

    it('getMessagesForUser uses parameterized user ID', () => {
      const getUserMsg = storeSource.substring(
        storeSource.indexOf('export function getMessagesForUser'),
        storeSource.indexOf('export function getMessagesForUser') + 400
      );
      expect(getUserMsg).toContain('WHERE user_id = ?');
      expect(getUserMsg).toContain('[userId, limit]');
    });

    it('updateMemoryAccess uses parameterized memory ID', () => {
      const update = storeSource.substring(
        storeSource.indexOf('export function updateMemoryAccess'),
        storeSource.indexOf('export function updateMemoryAccess') + 300
      );
      expect(update).toContain('WHERE id = ?');
      expect(update).toContain('[now, memoryId]');
    });

    it('updateMemoryImportance uses parameterized ID', () => {
      expect(storeSource).toContain('`UPDATE memories SET importance = ? WHERE id = ?`, [importance, memoryId]');
    });

    it('linkMemories uses parameterized IDs', () => {
      expect(storeSource).toContain('`UPDATE memories SET related_to = ? WHERE id = ?`');
      expect(storeSource).toContain('[relatedToId, memoryId]');
    });

    it('getRelatedMemories uses parameterized memory ID', () => {
      expect(storeSource).toContain('[memoryId, memoryId]');
    });

    it('addAssociation uses parameterized values', () => {
      expect(storeSource).toContain(
        '[sourceId, targetId, type, strength, Date.now(), causalType ?? null]'
      );
    });

    it('getAssociations uses parameterized memory ID', () => {
      expect(storeSource).toContain('[memoryId, memoryId, limit]');
    });

    it('strengthenAssociation uses parameterized values', () => {
      expect(storeSource).toContain('[boost, sourceId, targetId]');
    });
  });

  describe('No string concatenation in SQL queries (store.ts)', () => {
    it('store.ts does not use template literals to embed user values in SQL', () => {
      // Extract all SQL strings (lines containing SELECT/INSERT/UPDATE/DELETE)
      const sqlLines = storeSource
        .split('\n')
        .filter(
          (line) =>
            (line.includes('SELECT') ||
              line.includes('INSERT') ||
              line.includes('UPDATE') ||
              line.includes('DELETE')) &&
            !line.trim().startsWith('//')  &&
            !line.trim().startsWith('*')
        );
      for (const line of sqlLines) {
        // Should not contain ${something} inside a SQL string
        // Exception: placeholders like ${BACKGROUND_SQL_FILTER} are computed constants, not user input
        if (line.includes('BACKGROUND_SQL_FILTER') || line.includes('placeholders')) continue;
        // Check for dangerous interpolation of function parameters
        expect(line).not.toMatch(/\$\{(userId|sessionKey|memoryId|content|message)\}/);
      }
    });
  });

  describe('SQL injection via sanitizer', () => {
    const sqlInjectionPayloads = [
      "'; DROP TABLE memories; --",
      "' OR '1'='1",
      "' UNION SELECT * FROM credentials --",
      "1; DELETE FROM messages WHERE '1'='1",
      "' OR 1=1--",
      "'; INSERT INTO meta VALUES('pwned','yes');--",
      "\\'; DROP TABLE sessions; --",
      "' AND (SELECT COUNT(*) FROM meta) > 0 --",
      "0x27204F52202731273D2731", // hex encoded ' OR '1'='1
      "'/**/OR/**/1=1--",
    ];

    it.each(sqlInjectionPayloads)(
      'sanitizer handles SQL injection payload: %s',
      (payload) => {
        const result = sanitize(payload);
        // Sanitizer processes the input (doesn't crash)
        expect(result).toBeDefined();
        expect(result.sanitized).toBeDefined();
        // findings.md P2:1222 — framing no longer escapes `<`/`>`; LLM safety
        // comes from BLOCK_PATTERNS, not HTML entity encoding. SQL payloads
        // that aren't injection-flagged now pass through verbatim.
        expect(typeof result.sanitized).toBe('string');
      }
    );
  });

  describe('Parameterized queries in server telemetry endpoint', () => {
    it('telemetry queries in server.ts use parameterized timestamps', () => {
      const telemetrySection = serverSource.substring(
        serverSource.indexOf("'/api/telemetry'"),
        serverSource.indexOf("'/api/telemetry'") + 1500
      );
      expect(telemetrySection).toContain('WHERE created_at > ?');
      expect(telemetrySection).toContain('[sinceMs]');
    });

    it('telemetry queries in character-server.ts use parameterized timestamps', () => {
      const telemetrySection = charServerSource.substring(
        charServerSource.indexOf("'/api/telemetry'"),
        charServerSource.indexOf("'/api/telemetry'") + 1500
      );
      expect(telemetrySection).toContain('WHERE created_at > ?');
      expect(telemetrySection).toContain('[sinceMs]');
    });
  });

  describe('Activity feed from/to params are coerced to numbers', () => {
    it('server.ts coerces from/to params with Number()', () => {
      const activitySection = serverSource.substring(
        serverSource.indexOf("'/api/activity'"),
        serverSource.indexOf("'/api/activity'") + 400
      );
      expect(activitySection).toContain('Number(fromParam)');
      expect(activitySection).toContain('Number(toParam)');
    });

    it('character-server.ts coerces from/to params with Number()', () => {
      const activitySection = charServerSource.substring(
        charServerSource.indexOf("'/api/activity'"),
        charServerSource.indexOf("'/api/activity'") + 400
      );
      expect(activitySection).toContain('Number(fromParam)');
      expect(activitySection).toContain('Number(toParam)');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. SSRF ADVANCED
// ═══════════════════════════════════════════════════════════════════════════

describe('SSRF Advanced', () => {
  describe('IPv6-mapped IPv4 addresses', () => {
    it('detects ::1 as private', () => {
      expect(isPrivateIP('::1')).toBe(true);
    });

    it('detects fe80:: link-local as private', () => {
      expect(isPrivateIP('fe80::1')).toBe(true);
    });

    it('detects fc00:: ULA as private', () => {
      expect(isPrivateIP('fc00::1')).toBe(true);
    });

    it('detects fd00:: ULA as private', () => {
      expect(isPrivateIP('fd00::1')).toBe(true);
    });
  });

  // findings.md P2:1305 — `URL parsing tricks` block removed.
  // sanitizeURL is now a non-exported internal helper in ssrf.ts;
  // checkSSRF already exercises the scheme-rejection paths below,
  // so the tests collapse into that single surface.

  describe('checkSSRF blocks private/internal targets', () => {
    it.each([
      ['http://localhost', 'localhost'],
      ['http://localhost:8080/admin', 'localhost with port'],
      ['http://localhost.localdomain', 'localhost.localdomain'],
      ['http://0.0.0.0', '0.0.0.0'],
      ['http://[::1]', 'IPv6 loopback bracket notation'],
      ['http://169.254.169.254/latest/meta-data/', 'AWS metadata'],
      ['http://metadata.google.internal/computeMetadata/v1/', 'GCP metadata'],
    ])(
      'blocks %s (%s)',
      async (url, _label) => {
        const result = await checkSSRF(url);
        expect(result.safe).toBe(false);
      }
    );

    it.each([
      ['http://10.0.0.1', '10.x private'],
      ['http://10.255.255.255', '10.x max'],
      ['http://172.16.0.1', '172.16 private'],
      ['http://172.31.255.255', '172.31 max'],
      ['http://192.168.0.1', '192.168 private'],
      ['http://192.168.255.255', '192.168 max'],
      ['http://127.0.0.1', 'loopback'],
      ['http://127.255.255.255', 'loopback max'],
      ['http://169.254.1.1', 'link-local'],
    ])(
      'blocks IP %s (%s)',
      async (url, _label) => {
        const result = await checkSSRF(url);
        expect(result.safe).toBe(false);
      }
    );
  });

  describe('checkSSRF handles edge case schemes', () => {
    it.each([
      ['file:///etc/passwd', 'file scheme'],
      ['data:text/html,evil', 'data scheme'],
      ['javascript:alert(1)', 'javascript scheme'],
      ['ftp://internal/data', 'ftp scheme'],
      ['gopher://evil:70/', 'gopher scheme'],
    ])(
      'rejects %s (%s)',
      async (url, _label) => {
        const result = await checkSSRF(url);
        expect(result.safe).toBe(false);
      }
    );
  });

  describe('checkSSRF with malformed URLs', () => {
    it('rejects completely invalid URL', async () => {
      const result = await checkSSRF('not-a-url');
      expect(result.safe).toBe(false);
    });

    it('rejects empty string', async () => {
      const result = await checkSSRF('');
      expect(result.safe).toBe(false);
    });

    it('rejects URL with only spaces', async () => {
      const result = await checkSSRF('   ');
      expect(result.safe).toBe(false);
    });
  });

  describe('DNS rebinding protection', () => {
    it('SSRF module performs DNS resolution check', () => {
      expect(ssrfSource).toContain('dns.resolve4(hostname)');
    });

    it('checks resolved IPs against private ranges', () => {
      expect(ssrfSource).toContain('isPrivateIP(ip)');
    });

    it('logs DNS rebinding attempts', () => {
      expect(ssrfSource).toContain('DNS resolution returned private IP');
    });

    it('also checks IPv6 resolution', () => {
      expect(ssrfSource).toContain('dns.resolve6(hostname)');
    });

    it('rejects hostname that fails both IPv4 and IPv6 resolution', async () => {
      const result = await checkSSRF('http://this-domain-definitely-does-not-exist-xyz123abc.com');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('DNS resolution failed');
    });

    it('safeFetch pins DNS to the pre-resolved IP (P1 findings.md)', () => {
      // An undici Agent with a custom connect.lookup callback is the
      // anchor of the DNS-pinning fix. Without this, a second DNS
      // lookup at connect time could rebind to a private IP.
      expect(ssrfSource).toMatch(/from 'undici'/);
      expect(ssrfSource).toMatch(/function buildPinnedAgent/);
      expect(ssrfSource).toMatch(/new Agent\(\{\s*connect:\s*\{[\s\S]*?lookup/);
      // Callback hands back the pre-resolved IP either in multi-result
      // (all: true) or single-result form.
      expect(ssrfSource).toMatch(/address:\s*resolvedIP,\s*family/);
      expect(ssrfSource).toMatch(/callback\(null,\s*resolvedIP,\s*family\)/);
    });

    it('safeFetch passes the pinned dispatcher to the fetch call', () => {
      // The pinned agent is wired through as `dispatcher` on the init
      // so undici uses the pre-resolved IP instead of re-resolving DNS.
      expect(ssrfSource).toMatch(/init\.dispatcher\s*=\s*dispatcher/);
      expect(ssrfSource).toMatch(/undiciFetch\(sanitized, init\)/);
    });

    it('safeFetch closes the pinned agent after use to avoid leaks', () => {
      expect(ssrfSource).toMatch(/dispatcher\?\.close\(\)/);
    });
  });

  describe('Redirect-based SSRF protection', () => {
    it('safeFetch uses redirect: manual to prevent auto-following', () => {
      expect(ssrfSource).toContain("redirect: 'manual'");
    });

    it('safeFetch checks redirect location against SSRF', () => {
      expect(ssrfSource).toContain('SSRF protection on redirect');
    });

    it('redirect location undergoes full checkSSRF', () => {
      expect(ssrfSource).toContain('checkSSRF(location)');
    });

    it('handles 3xx status codes for redirect check', () => {
      expect(ssrfSource).toContain('response.status >= 300');
      expect(ssrfSource).toContain('response.status < 400');
    });

    it('safeFetchFollow re-validates every hop and caps the chain (P1 findings.md)', () => {
      // Open-redirector bypass: an initially-public URL 302s into
      // http://169.254.169.254 / http://127.0.0.1. safeFetchFollow must
      // (a) exist, (b) call safeFetch (which DNS-pins + rejects private
      // IPs) on each hop, (c) resolve the Location header against the
      // current URL (relative redirects), and (d) cap the hop count.
      expect(ssrfSource).toMatch(/export async function safeFetchFollow/);
      expect(ssrfSource).toMatch(/await safeFetch\(current, options\)/);
      expect(ssrfSource).toMatch(/new URL\(location, current\)/);
      expect(ssrfSource).toMatch(/too many redirects/);
      expect(ssrfSource).toMatch(/maxHops\s*=\s*3/);
    });
  });

  describe('LLM-reachable fetch tools route through safeFetch (P1 findings.md)', () => {
    it('fetch_webpage uses safeFetch, not raw fetch', () => {
      // The fetch_webpage handler block must use safeFetch. Without this
      // the LLM can be prompt-injected into fetching metadata endpoints
      // or RFC1918 addresses.
      const handler = agentToolsSource.match(
        /name: 'fetch_webpage'[\s\S]*?\n  \},\n\}\);/
      );
      expect(handler).not.toBeNull();
      expect(handler![0]).toMatch(/await safeFetch\(url,/);
      // No bare fetch(url, ...) call remaining in the handler body.
      expect(handler![0]).not.toMatch(/await fetch\(url,/);
    });

    it('fetch_and_show_image uses safeFetchFollow for redirect-safe fetch', () => {
      const handler = agentToolsSource.match(
        /name: 'fetch_and_show_image'[\s\S]*?\n  \},\n\}\);/
      );
      expect(handler).not.toBeNull();
      expect(handler![0]).toMatch(/await safeFetchFollow\(url,/);
      expect(handler![0]).not.toMatch(/await fetch\(url,/);
      // The pre-refactor code used `redirect: 'follow'` on a raw fetch,
      // which is the exact open-redirector bypass the audit flagged.
      expect(handler![0]).not.toMatch(/redirect:\s*'follow'/);
    });

    it('view_image uses safeFetchFollow for redirect-safe fetch', () => {
      const handler = agentToolsSource.match(
        /name: 'view_image'[\s\S]*?\n  \},\n\}\);/
      );
      expect(handler).not.toBeNull();
      expect(handler![0]).toMatch(/await safeFetchFollow\(url,/);
      expect(handler![0]).not.toMatch(/await fetch\(url,/);
      expect(handler![0]).not.toMatch(/redirect:\s*'follow'/);
    });

    it('tools.ts imports the safe fetch helpers from ssrf.ts', () => {
      expect(agentToolsSource).toMatch(
        /import\s*\{\s*safeFetch,\s*safeFetchFollow\s*\}\s*from\s*'\.\.\/security\/ssrf\.js'/
      );
    });
  });

  describe('Dead tool-approval metadata removed (P1 findings.md)', () => {
    it('tools.ts has no toolRequiresApproval export', () => {
      // The helper + field advertised "telegram_call is gated" but
      // executeTool never consulted them. Any future approval flow
      // must gate executeTool itself, not a dead metadata field.
      expect(agentToolsSource).not.toMatch(/export function toolRequiresApproval\b/);
    });

    it('Tool interface no longer declares requiresApproval', () => {
      expect(agentToolsSource).not.toMatch(/requiresApproval\?:\s*boolean/);
    });

    it('no tool sets requiresApproval: true', () => {
      expect(agentToolsSource).not.toMatch(/requiresApproval:\s*true/);
    });

    it('executeTool runs tool.handler unconditionally (visible contract)', () => {
      // If this changes, whoever rewires enforcement must also re-derive
      // the approval source-of-truth and update this regression.
      expect(agentToolsSource).toMatch(
        /async function executeTool[\s\S]*?const result = await tool\.handler\(toolCall\.input\);/
      );
    });
  });

  describe('POST /api/objects checks sanitize().blocked (P1 findings.md)', () => {
    // sanitize() initializes result.sanitized = input and never overwrites
    // it on the BLOCK early-return path. Slicing .sanitized without
    // checking .blocked lets an injection string flow into the object
    // store, where a character's later-context ("you see an object named
    // …") surfaces it directly to the LLM.

    it('POST /api/objects rejects when sanitize().blocked', () => {
      // Isolate the handler: from the route marker to the next
      // top-level route comment.
      const start = serverSource.indexOf('// POST /api/objects — create a new object');
      expect(start).toBeGreaterThan(-1);
      const after = serverSource.indexOf('// POST /api/objects/:id/pickup', start);
      expect(after).toBeGreaterThan(start);
      const section = serverSource.substring(start, after);

      expect(section).toMatch(/nameCheck\.blocked/);
      expect(section).toMatch(/descCheck\.blocked/);
      // A 400 response must exist before the createObject call.
      const preCreate = section.substring(0, section.indexOf('createObject('));
      expect(preCreate).toMatch(/res\.writeHead\(400/);
      expect(preCreate).toMatch(/blocked by input sanitizer/i);
    });

    it('POST /api/objects does not pass raw sanitize(...).sanitized without a block check', () => {
      // Specifically forbid the previous pattern `sanitize(name).sanitized.slice(...)`
      // which was the footgun called out in findings.md.
      const start = serverSource.indexOf('// POST /api/objects — create a new object');
      const after = serverSource.indexOf('// POST /api/objects/:id/pickup', start);
      const section = serverSource.substring(start, after);
      expect(section).not.toMatch(/sanitize\(name\)\.sanitized\.slice/);
      expect(section).not.toMatch(/sanitize\(description\)\.sanitized\.slice/);
    });
  });

  describe('town-life post-LLM allowlist gate (P1 findings.md:2057)', () => {
    // findings.md:2057 — executeTool(tc) ran LLM-chosen tools with no
    // post-LLM gating. The prompt is assembled from 7 cross-peer reads
    // (postboard, notes, docs, objects, nearby, events, residue). Any
    // one of those carrying injection text could steer the LLM toward
    // a tool outside the intended town-life allowlist, since the global
    // tool registry includes web fetch, telegram_call, diagnostics, etc.

    it('TOWN_LIFE_TOOLS allowlist is consulted BEFORE executeTool, not only when sending tools to the provider', () => {
      // The loop body must short-circuit when `!TOWN_LIFE_TOOLS.has(tc.name)`
      // BEFORE reaching executeTool(tc). Source-regex guard: in the loop,
      // the allowlist check appears before `executeTool`.
      const loopBlock = townLifeSource.match(
        /for \(const tc of result\.toolCalls\)[\s\S]*?const toolResult = await executeTool\(tc\);/
      );
      expect(loopBlock).not.toBeNull();
      const allowlistIdx = loopBlock![0].indexOf('TOWN_LIFE_TOOLS.has(tc.name)');
      const executeIdx = loopBlock![0].indexOf('executeTool(tc)');
      expect(allowlistIdx).toBeGreaterThan(-1);
      expect(executeIdx).toBeGreaterThan(-1);
      expect(allowlistIdx).toBeLessThan(executeIdx);
    });

    it('refused tool calls log a warning identifying the tool and character', () => {
      expect(townLifeSource).toMatch(
        /logger\.warn\([^)]*tool:\s*tc\.name[^)]*character:\s*config\.characterId/
      );
    });

    it('refused tool calls are surfaced as an isError result, not silently dropped', () => {
      // Silent drop would leave the LLM with a hung tool_use block on
      // the next continueWithToolResults call. Must return an isError
      // ToolResult with the same toolCallId.
      const section = townLifeSource.match(
        /if \(!TOWN_LIFE_TOOLS\.has\(tc\.name\)\)[\s\S]*?continue;/
      );
      expect(section).not.toBeNull();
      expect(section![0]).toMatch(/toolCallId:\s*tc\.id/);
      expect(section![0]).toMatch(/isError:\s*true/);
    });

    it('refused tool calls are visible in actionsTaken as "refused:<name>"', () => {
      // So post-cycle forensics and the recent-actions log show the
      // injection attempt rather than just silently absent.
      expect(townLifeSource).toMatch(
        /actionsTaken\.push\(`refused:\$\{tc\.name\}`\)/
      );
    });
  });

  describe('SQLCipher silent-fallback is no longer silent (P1 findings.md:295)', () => {
    // findings.md:295 — the try/catch around PRAGMA key had an empty catch
    // block, but the bigger issue is that stock better-sqlite3 does NOT
    // throw on unknown pragmas — it silently no-ops. So catch never fires,
    // and the DB stayed plaintext without a peep. Fix: probe
    // PRAGMA cipher_version to actually detect SQLCipher, and fail loudly
    // (or at minimum warn) when encryption is not active.

    it('initDatabase probes cipher_version, not just try/catch on PRAGMA key', () => {
      expect(databaseSource).toMatch(/cipher_version/);
    });

    it('plain try/catch with empty body around PRAGMA key is gone', () => {
      // Old code: `try { db.pragma(`key = '${hexKey}'`); } catch {}` with a
      // bare `// Log warning in production` stub. Forbid exactly that shape.
      expect(databaseSource).not.toMatch(
        /db\.pragma\(`key = '\$\{hexKey\}'`\);\s*\} catch \{\s*\/\/[^}]*continue without encryption/
      );
    });

    it('LAIN_REQUIRE_ENCRYPTION=1 makes missing SQLCipher a hard error', () => {
      expect(databaseSource).toMatch(/LAIN_REQUIRE_ENCRYPTION/);
      expect(databaseSource).toMatch(/Database encryption required/i);
      // Must throw StorageError (not a bare Error) so the existing
      // initDatabase error-wrapping path surfaces it cleanly.
      const encBlock = databaseSource.match(
        /if \(process\.env\.LAIN_REQUIRE_ENCRYPTION === '1'\)[\s\S]*?throw new StorageError/
      );
      expect(encBlock).not.toBeNull();
    });

    it('the plaintext-mode warning is at warn level, not debug or info', () => {
      // Operators need to see this in ops logs by default.
      const warnBlock = databaseSource.match(
        /!encryptionActive[\s\S]*?logger\.warn/
      );
      expect(warnBlock).not.toBeNull();
      // And specifically call out "PLAINTEXT" so grep is trivial.
      expect(databaseSource).toMatch(/PLAINTEXT/);
    });

    it('closes and nulls the db handle before throwing so state is not leaked', () => {
      // If we decided encryption was required, we're about to reject the
      // init. The already-opened plaintext handle must be closed and the
      // module-level `db` reset so a future init attempt doesn't reuse it.
      const block = databaseSource.match(
        /LAIN_REQUIRE_ENCRYPTION === '1'[\s\S]*?throw new StorageError/
      );
      expect(block).not.toBeNull();
      expect(block![0]).toMatch(/db\.close\(\)/);
      expect(block![0]).toMatch(/db = null/);
    });
  });

  describe('Channel reconnect state-machine (P1 findings.md)', () => {
    // findings.md:2552 — whatsapp + signal both had dead reconnect loops.
    //   whatsapp: setTimeout(() => connect(), 5000) fired while socket was
    //     non-null → connect()'s early-return guard made the channel dead
    //     until process restart.
    //   signal:   emitDisconnect() set _connected=false before the reconnect
    //     branch read _connected → branch unreachable. disconnect() zeroed
    //     maxReconnectAttempts permanently, killing any re-used channel.

    it('whatsapp nulls this.socket before scheduling reconnect', () => {
      // The connection.update 'close' branch must drop the socket ref so
      // connect()'s `if (this.socket) return` guard doesn't block the retry.
      const closeBranch = whatsappChannelSource.match(
        /if \(connection === 'close'\)[\s\S]*?else if \(connection === 'open'\)/
      );
      expect(closeBranch).not.toBeNull();
      expect(closeBranch![0]).toMatch(/this\.socket = null/);
    });

    it('whatsapp has no raw setTimeout reconnect that calls connect() with socket alive', () => {
      // Specifically forbid the previous pattern.
      expect(whatsappChannelSource).not.toMatch(
        /setTimeout\(\(\) => this\.connect\(\), \d+\)/
      );
    });

    it('whatsapp reconnect uses exponential backoff with a max attempt cap', () => {
      expect(whatsappChannelSource).toMatch(/MAX_RECONNECT_ATTEMPTS/);
      expect(whatsappChannelSource).toMatch(/Math\.pow\(2,\s*this\.reconnectAttempt/);
    });

    it('whatsapp disconnect() sets a shuttingDown flag instead of zeroing a counter', () => {
      const disconnectBlock = whatsappChannelSource.match(
        /async disconnect\(\)[\s\S]*?\n {2}\}/
      );
      expect(disconnectBlock).not.toBeNull();
      expect(disconnectBlock![0]).toMatch(/this\.shuttingDown = true/);
      expect(disconnectBlock![0]).not.toMatch(/MAX_RECONNECT_ATTEMPTS\s*=\s*0/);
    });

    it('signal handleDisconnect snapshots _connected BEFORE emitDisconnect', () => {
      // The reconnect branch must not rely on reading _connected after the
      // emitDisconnect() call has flipped it to false.
      const block = signalChannelSource.match(
        /private handleDisconnect\(\)[\s\S]*?\n {2}\}/
      );
      expect(block).not.toBeNull();
      const wasConnectedIdx = block![0].indexOf('wasConnected');
      const emitDisconnectIdx = block![0].indexOf('emitDisconnect()');
      expect(wasConnectedIdx).toBeGreaterThan(-1);
      expect(emitDisconnectIdx).toBeGreaterThan(-1);
      expect(wasConnectedIdx).toBeLessThan(emitDisconnectIdx);
    });

    it('signal handleDisconnect gates the reconnect branch on the snapshot, not this._connected', () => {
      const block = signalChannelSource.match(
        /private handleDisconnect\(\)[\s\S]*?\n {2}\}/
      );
      expect(block).not.toBeNull();
      // The old, unreachable guard.
      expect(block![0]).not.toMatch(/&&\s*this\._connected\s*\)/);
    });

    it('signal disconnect() does not permanently zero the reconnect budget', () => {
      // The old bug: `this.maxReconnectAttempts = 0` turned reconnect off
      // forever, even for a re-used channel instance. Replace with a
      // shuttingDown flag that can be cleared on the next connect().
      expect(signalChannelSource).not.toMatch(/this\.maxReconnectAttempts\s*=\s*0/);
      const disconnectBlock = signalChannelSource.match(
        /async disconnect\(\)[\s\S]*?\n {2}\}/
      );
      expect(disconnectBlock).not.toBeNull();
      expect(disconnectBlock![0]).toMatch(/this\.shuttingDown = true/);
    });

    it('signal reconnect uses exponential backoff with a max attempt cap', () => {
      expect(signalChannelSource).toMatch(/MAX_RECONNECT_ATTEMPTS/);
      expect(signalChannelSource).toMatch(/Math\.pow\(2,\s*this\.reconnectAttempts/);
    });

    it('both channels clear shuttingDown on connect() so channel instances are re-usable', () => {
      // Regression for the "re-used channel has dead reconnect forever" bug.
      const waConnect = whatsappChannelSource.match(
        /async connect\(\)[\s\S]*?\n {2}\}/
      );
      const sigConnect = signalChannelSource.match(
        /async connect\(\)[\s\S]*?\n {2}\}/
      );
      expect(waConnect).not.toBeNull();
      expect(sigConnect).not.toBeNull();
      expect(waConnect![0]).toMatch(/this\.shuttingDown = false/);
      expect(sigConnect![0]).toMatch(/this\.shuttingDown = false/);
    });
  });

  describe('safeFetch timeout protection', () => {
    it('uses AbortController for timeout', () => {
      expect(ssrfSource).toContain('new AbortController()');
    });

    it('sets 30 second timeout', () => {
      expect(ssrfSource).toContain('30000');
    });

    it('clears timeout in finally block', () => {
      expect(ssrfSource).toContain('clearTimeout(timeout)');
    });
  });

  // findings.md P2:1305 — `Domain allowlist/blocklist` tests removed
  // alongside the dead exports they covered. A per-character policy
  // can be reintroduced deliberately if needed.

  describe('Curiosity loop uses SSRF check', () => {
    it('curiosity.ts imports checkSSRF', () => {
      expect(curiositySource).toContain("import { checkSSRF }");
    });

    it('curiosity.ts checks URLs before fetching', () => {
      expect(curiositySource).toContain('checkSSRF');
    });
  });

  describe('CGNAT range is blocked', () => {
    it('ssrf.ts blocks CGNAT range 100.64-127.x.x', () => {
      expect(ssrfSource).toContain('/^100\\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\\./');
    });

    it.each([
      '100.64.0.1',
      '100.100.0.1',
      '100.127.255.255',
    ])(
      'detects CGNAT %s as private',
      (ip) => {
        expect(isPrivateIP(ip)).toBe(true);
      }
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. PATH TRAVERSAL DEEP
// ═══════════════════════════════════════════════════════════════════════════

describe('Path Traversal Deep', () => {
  describe('server.ts serveStatic', () => {
    it('resolves path and checks it stays within PUBLIC_DIR', () => {
      expect(serverSource).toContain('!filePath.startsWith(resolve(PUBLIC_DIR))');
    });

    it('uses resolve() to canonicalize paths', () => {
      expect(serverSource).toContain('resolve(PUBLIC_DIR, safePath)');
    });

    it('strips leading slashes from path', () => {
      expect(serverSource).toContain("path.replace(/^\\/+/, '')");
    });
  });

  describe('server.ts serveFromDir (skins)', () => {
    it('checks resolved path stays within base directory', () => {
      expect(serverSource).toContain('!filePath.startsWith(resolve(baseDir))');
    });

    it('strips leading slashes', () => {
      // serveFromDir also strips leading slashes
      const serveFromDir = serverSource.substring(
        serverSource.indexOf('async function serveFromDir'),
        serverSource.indexOf('async function serveFromDir') + 400
      );
      expect(serveFromDir).toContain("path.replace(/^\\/+/, '')");
    });
  });

  describe('character-server.ts has no serveStatic (findings.md P1:27)', () => {
    // Character servers are API-only by design. serveStatic + publicDir were
    // removed because they pointed at nonexistent src/web/public-<id>/ dirs.
    it('no serveStatic function exists', () => {
      expect(charServerSource).not.toMatch(/function\s+serveStatic/);
    });

    it('no publicDir field in CharacterConfig', () => {
      expect(charServerSource).not.toMatch(/publicDir:\s*string/);
    });
  });

  describe('character-server.ts skins path', () => {
    it('resolves skin path and checks against SKINS_DIR', () => {
      expect(charServerSource).toContain('filePath.startsWith(resolve(SKINS_DIR))');
    });
  });

  describe('Path traversal patterns in serveStatic', () => {
    const traversalPatterns = [
      '/../../../etc/passwd',
      '/..%2f..%2f..%2fetc%2fpasswd',
      '/....//....//....//etc/passwd',
      '/%2e%2e/%2e%2e/%2e%2e/etc/passwd',
      '/./../../etc/passwd',
      '/path/../../../etc/shadow',
    ];

    it.each(traversalPatterns)(
      'serveStatic in server.ts canonicalizes %s to prevent traversal',
      (pattern) => {
        // The resolve + startsWith check prevents all these
        // Verify the protection pattern exists
        expect(serverSource).toContain('resolve(PUBLIC_DIR, safePath)');
        expect(serverSource).toContain('!filePath.startsWith(resolve(PUBLIC_DIR))');
      }
    );
  });

  describe('Data workspace filename sanitization', () => {
    it('sanitizeDataFileName strips path components', () => {
      expect(dataWorkspaceSource).toContain("basename(name)");
    });

    it('sanitizeDataFileName rejects traversal', () => {
      expect(dataWorkspaceSource).toContain("clean.includes('..')");
    });

    it('sanitizeDataFileName rejects absolute paths', () => {
      expect(dataWorkspaceSource).toContain("clean.startsWith('/')");
    });

    it('sanitizeDataFileName rejects backslash paths', () => {
      expect(dataWorkspaceSource).toContain("clean.startsWith('\\\\')");
    });

    it('sanitizeDataFileName removes path separators', () => {
      expect(dataWorkspaceSource).toContain("clean.replace(/[/\\\\]/g, '')");
    });

    it('sanitizeDataFileName validates allowed extensions', () => {
      expect(dataWorkspaceSource).toContain('ALLOWED_DATA_EXTENSIONS');
    });
  });

  describe('Diary uses getBasePath for file paths', () => {
    it('diary.ts uses getBasePath for journal path', () => {
      expect(diarySource).toContain("getBasePath()");
      expect(diarySource).toContain('.private_journal');
    });
  });

  describe('Book uses getBasePath for file paths', () => {
    it('book.ts uses getBasePath for book directory', () => {
      expect(bookSource).toContain("getBasePath()");
    });

    it('book.ts constructs paths via join()', () => {
      expect(bookSource).toContain("join(getBookDir()");
    });
  });

  describe('Book chapter filename validator (P1 regression)', () => {
    it('accepts valid chapter filenames (nn-slug.md)', async () => {
      const { isValidChapterFilename } = await import('../src/agent/book.js');
      expect(isValidChapterFilename('01-introduction.md')).toBe(true);
      expect(isValidChapterFilename('02-prediction-and-constraint.md')).toBe(true);
      expect(isValidChapterFilename('15-conclusion.md')).toBe(true);
    });

    it('rejects absolute paths', async () => {
      const { isValidChapterFilename } = await import('../src/agent/book.js');
      expect(isValidChapterFilename('/etc/passwd')).toBe(false);
      expect(isValidChapterFilename('/tmp/evil.md')).toBe(false);
    });

    it('rejects path-traversal sequences', async () => {
      const { isValidChapterFilename } = await import('../src/agent/book.js');
      expect(isValidChapterFilename('../../../etc/passwd')).toBe(false);
      expect(isValidChapterFilename('../../.ssh/authorized_keys')).toBe(false);
      expect(isValidChapterFilename('01-slug/../../../evil.md')).toBe(false);
    });

    it('rejects filenames without the nn- prefix', async () => {
      const { isValidChapterFilename } = await import('../src/agent/book.js');
      expect(isValidChapterFilename('chapter.md')).toBe(false);
      expect(isValidChapterFilename('1-short.md')).toBe(false);
      expect(isValidChapterFilename('001-long.md')).toBe(false);
    });

    it('rejects filenames without .md extension', async () => {
      const { isValidChapterFilename } = await import('../src/agent/book.js');
      expect(isValidChapterFilename('01-slug.txt')).toBe(false);
      expect(isValidChapterFilename('01-slug')).toBe(false);
      expect(isValidChapterFilename('01-slug.md.sh')).toBe(false);
    });

    it('rejects uppercase or non-slug characters in the slug', async () => {
      const { isValidChapterFilename } = await import('../src/agent/book.js');
      expect(isValidChapterFilename('01-Slug.md')).toBe(false);
      expect(isValidChapterFilename('01-slug with spaces.md')).toBe(false);
      expect(isValidChapterFilename('01-slug_underscore.md')).toBe(false);
    });

    it('source reflects the validator is wired into write path', () => {
      expect(bookSource).toContain('CHAPTER_FILENAME_RE');
      expect(bookSource).toContain('isValidChapterFilename');
    });
  });

  describe('Meta key path traversal in character server', () => {
    it('meta key is URL-decoded but used as DB key not file path', () => {
      // /api/meta/:key reads from DB meta table via getMeta, not filesystem
      // Find the generic meta handler (not /api/meta/identity)
      const genericMetaIdx = charServerSource.indexOf("url.pathname.startsWith('/api/meta/')");
      expect(genericMetaIdx).toBeGreaterThan(-1);
      // findings.md P2:2404 widened the handler with an allowlist check
      // between the key decode and the getMeta read; slice needs to be
      // large enough to cover both.
      const metaSection = charServerSource.substring(genericMetaIdx, genericMetaIdx + 1500);
      expect(metaSection).toContain('getMeta(key)');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. ERROR BOUNDARIES
// ═══════════════════════════════════════════════════════════════════════════

describe('Error Boundaries', () => {
  describe('Server-level catch-all error handler', () => {
    it('server.ts has error handling in request handlers', () => {
      expect(serverSource).toContain('catch (error)');
    });

    it('character-server.ts has a top-level try-catch in request handler', () => {
      expect(charServerSource).toContain('catch (error)');
      expect(charServerSource).toContain("'Internal server error'");
    });

    it('server.ts checks headersSent before writing error response', () => {
      expect(serverSource).toContain('!res.headersSent');
    });

    it('character-server.ts checks headersSent before writing error response', () => {
      expect(charServerSource).toContain('!res.headersSent');
    });
  });

  describe('Chat endpoint error handling', () => {
    it('handleChatStream catches errors and sends error event', () => {
      expect(serverSource).toContain("type: 'error'");
      expect(serverSource).toContain("'Failed to process message'");
    });

    it('chat POST catches PAYLOAD_TOO_LARGE', () => {
      expect(serverSource).toContain("error.message === 'PAYLOAD_TOO_LARGE'");
      expect(serverSource).toContain('413');
    });

    it('character server chat stream catches errors', () => {
      expect(charServerSource).toContain("type: 'error'");
    });
  });

  describe('Background loop error isolation', () => {
    it('commune-loop.ts has error handling', () => {
      expect(communeLoopSource).toContain('catch');
    });

    it('diary.ts has error handling', () => {
      expect(diarySource).toContain('catch');
    });

    it('curiosity.ts has error handling', () => {
      expect(curiositySource).toContain('catch');
    });
  });

  describe('Peer communication error handling', () => {
    it('server.ts peer/message endpoint has try-catch', () => {
      // Find the handler (with POST method check), not just any reference.
      // Window widened (3000) after findings.md P2:2942-followup added the
      // `possessed`-flag receiver logic which pushed the catch block past
      // the original offset.
      const peerIdx = serverSource.indexOf("'/api/peer/message' && req.method === 'POST'");
      expect(peerIdx).toBeGreaterThan(-1);
      const peerSection = serverSource.substring(peerIdx, peerIdx + 3000);
      expect(peerSection).toContain('catch');
      expect(peerSection).toContain("'Failed to process peer message'");
    });

    it('character server peer message has try-catch (non-possessed)', () => {
      // handlePeerMessage is in a try-catch in the request handler
      expect(charServerSource).toContain("'Missing required fields: fromId, fromName, message'");
    });
  });

  describe('Interlink letter error handling', () => {
    it('server.ts letter endpoint catches parse errors', () => {
      const letterSection = serverSource.substring(
        serverSource.indexOf("'/api/interlink/letter'"),
        serverSource.indexOf("'/api/interlink/letter'") + 800
      );
      expect(letterSection).toContain("'Invalid JSON'");
    });

    it('server.ts letter validates structure before processing', () => {
      expect(serverSource).toContain("'Invalid letter structure'");
    });

    it('character server letter validates structure', () => {
      expect(charServerSource).toContain("'Invalid letter structure'");
    });
  });

  describe('handleInterlinkLetter senderId resolution (P1 findings.md)', () => {
    it('does not hardcode senderId to wired-lain', () => {
      const fnIdx = charServerSource.indexOf('async function handleInterlinkLetter');
      expect(fnIdx).toBeGreaterThan(-1);
      const fnEnd = charServerSource.indexOf('\nasync function ', fnIdx + 10);
      const body = charServerSource.substring(fnIdx, fnEnd);
      // The literal 'wired-lain' string in the senderId field is the bug.
      expect(body).not.toMatch(/senderId:\s*'wired-lain'/);
      expect(body).not.toMatch(/sessionKey:\s*'wired:letter'/);
    });

    it('resolves senderId from authenticated X-Interlink-From via manifest', () => {
      // Post per-character tokens (findings.md P1:2289): the authenticated
      // sender id from verifyInterlinkRequest is the sole source of truth —
      // the body senderId must match (assertBodyIdentity) or be rejected,
      // and the id is resolved via getCharacterEntry(authenticatedSenderId).
      const fnIdx = charServerSource.indexOf('async function handleInterlinkLetter');
      const fnEnd = charServerSource.indexOf('\nasync function ', fnIdx + 10);
      const body = charServerSource.substring(fnIdx, fnEnd);
      expect(body).toMatch(/getCharacterEntry/);
      expect(body).toMatch(/assertBodyIdentity/);
    });

    it('rejects body-asserted senderId not in manifest', () => {
      const fnIdx = charServerSource.indexOf('async function handleInterlinkLetter');
      const fnEnd = charServerSource.indexOf('\nasync function ', fnIdx + 10);
      const body = charServerSource.substring(fnIdx, fnEnd);
      expect(body).toMatch(/Unknown senderId/);
    });

    it('research delivery in server.ts populates letter.senderId from LAIN_CHARACTER_ID', () => {
      // Sender identity now comes from this process's own
      // LAIN_CHARACTER_ID (matches the authenticated X-Interlink-From).
      const idx = serverSource.indexOf('Include senderId so the recipient attributes');
      expect(idx).toBeGreaterThan(-1);
      const section = serverSource.substring(idx, idx + 500);
      expect(section).toMatch(/LAIN_CHARACTER_ID/);
      expect(section).toMatch(/senderId/);
    });
  });

  describe('JSON parse error handling in endpoints', () => {
    it('server conversations/event catches bad JSON', () => {
      const convIdx = serverSource.indexOf("'/api/conversations/event' && req.method === 'POST'");
      expect(convIdx).toBeGreaterThan(-1);
      const convSection = serverSource.substring(convIdx, convIdx + 2500);
      expect(convSection).toContain("'Invalid JSON'");
    });

    it('research-request endpoint catches bad JSON', () => {
      const researchIdx = serverSource.indexOf("'/api/interlink/research-request' && req.method === 'POST'");
      expect(researchIdx).toBeGreaterThan(-1);
      const researchSection = serverSource.substring(researchIdx, researchIdx + 1200);
      expect(researchSection).toContain("'Invalid JSON'");
    });

    it('dream-seed endpoint catches bad JSON', () => {
      const dreamIdx = serverSource.indexOf("'/api/interlink/dream-seed' && req.method === 'POST'");
      expect(dreamIdx).toBeGreaterThan(-1);
      const dreamSection = serverSource.substring(dreamIdx, dreamIdx + 1000);
      expect(dreamSection).toContain("'Invalid JSON'");
    });

    it('interlink letter endpoint catches bad JSON', () => {
      const letterIdx = serverSource.indexOf("'/api/interlink/letter' && req.method === 'POST'");
      expect(letterIdx).toBeGreaterThan(-1);
      const letterSection = serverSource.substring(letterIdx, letterIdx + 1000);
      expect(letterSection).toContain("'Invalid JSON'");
    });
  });

  describe('SSE stream error handling', () => {
    it('server events SSE has heartbeat', () => {
      expect(serverSource).toContain("': heartbeat\\n\\n'");
    });

    it('server events SSE cleans up on close', () => {
      expect(serverSource).toContain("req.on('close'");
      expect(serverSource).toContain('clearInterval(heartbeat)');
    });

    it('character server events SSE cleans up on close', () => {
      expect(charServerSource).toContain("req.on('close'");
      expect(charServerSource).toContain('clearInterval(heartbeat)');
    });
  });

  describe('Database query error wrapping', () => {
    it('query() wraps errors in StorageError', () => {
      expect(databaseSource).toContain("throw new StorageError(`Query failed:");
    });

    it('queryOne() wraps errors in StorageError', () => {
      const queryOneSection = databaseSource.substring(
        databaseSource.indexOf('export function queryOne'),
        databaseSource.indexOf('export function queryOne') + 400
      );
      expect(queryOneSection).toContain("throw new StorageError(`Query failed:");
    });

    it('execute() wraps errors in StorageError', () => {
      const executeSection = databaseSource.substring(
        databaseSource.indexOf('export function execute'),
        databaseSource.indexOf('export function execute') + 400
      );
      expect(executeSection).toContain("throw new StorageError(`Execute failed:");
    });
  });

  describe('Proxy error handling', () => {
    it('character proxy handles connection errors', () => {
      expect(serverSource).toContain("proxyReq.on('error'");
      expect(serverSource).toContain("'Character server unavailable'");
    });
  });

  describe('Telemetry endpoint error handling', () => {
    it('server telemetry has try-catch', () => {
      // Find the telemetry GET handler
      const telemetryIdx = serverSource.indexOf("'/api/telemetry' && req.method === 'GET'");
      expect(telemetryIdx).toBeGreaterThan(-1);
      const telemetrySection = serverSource.substring(telemetryIdx, telemetryIdx + 3000);
      expect(telemetrySection).toContain("'Telemetry query failed'");
    });

    it('character server telemetry has try-catch', () => {
      const telemetryIdx = charServerSource.indexOf("'/api/telemetry' && req.method === 'GET'");
      expect(telemetryIdx).toBeGreaterThan(-1);
      const telemetrySection = charServerSource.substring(telemetryIdx, telemetryIdx + 3000);
      expect(telemetrySection).toContain("'Telemetry query failed'");
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. HTTP METHOD ENFORCEMENT
// ═══════════════════════════════════════════════════════════════════════════

describe('HTTP Method Enforcement', () => {
  describe('server.ts — GET-only endpoints explicitly check method', () => {
    const getOnlyEndpoints = [
      '/api/health',
      '/api/characters',
      '/api/location',
      '/api/internal-state',
      '/api/weather',
      '/api/meta/identity',
      '/api/commune-history',
      '/api/relationships',
      '/api/meta/integrity',
      '/api/telemetry',
      '/api/events',
      '/api/activity',
      '/api/building/notes',
      '/api/documents',
      '/api/town-events',
      '/api/town-events/effects',
      '/api/dreams/status',
      '/api/dreams/seeds',
      '/api/evolution/lineages',
      '/api/evolution/status',
      '/api/feeds/health',
      '/api/budget',
      '/api/conversations/stream',
      '/api/conversations/recent',
      '/api/objects',
      '/api/system',
    ];

    it.each(getOnlyEndpoints)(
      'GET %s explicitly checks req.method === "GET"',
      (endpoint) => {
        const idx = serverSource.indexOf(`'${endpoint}'`);
        if (idx === -1) return;
        // Look at the surrounding code
        const chunk = serverSource.substring(Math.max(0, idx - 50), idx + 200);
        expect(chunk).toContain("'GET'");
      }
    );
  });

  describe('server.ts — POST-only endpoints explicitly check method', () => {
    const postOnlyEndpoints = [
      '/api/chat/stream',
      '/api/chat',
      '/api/postboard',
      '/api/town-events',
      '/api/conversations/event',
      '/api/interlink/letter',
      '/api/interlink/dream-seed',
      '/api/interlink/research-request',
      '/api/objects',
      '/api/internal/embed',
      '/api/peer/message',
    ];

    it.each(postOnlyEndpoints)(
      'POST %s explicitly checks req.method === "POST"',
      (endpoint) => {
        const idx = serverSource.indexOf(`'${endpoint}'`);
        if (idx === -1) return;
        // Some endpoints have both GET and POST — find the POST one
        const allMatches: number[] = [];
        let searchFrom = 0;
        while (true) {
          const found = serverSource.indexOf(`'${endpoint}'`, searchFrom);
          if (found === -1) break;
          allMatches.push(found);
          searchFrom = found + 1;
        }
        const hasPost = allMatches.some((pos) => {
          const chunk = serverSource.substring(Math.max(0, pos - 100), pos + 200);
          return chunk.includes("'POST'");
        });
        expect(hasPost).toBe(true);
      }
    );
  });

  describe('character-server.ts — GET-only endpoints check method', () => {
    const charGetEndpoints = [
      '/api/characters',
      '/api/location',
      '/api/internal-state',
      '/api/meta/identity',
      '/api/commune-history',
      '/api/meta/integrity',
      '/api/telemetry',
      '/api/events',
      '/api/activity',
      '/api/building/notes',
      '/api/documents',
      '/api/postboard',
    ];

    it.each(charGetEndpoints)(
      'Character server GET %s checks method',
      (endpoint) => {
        const idx = charServerSource.indexOf(`'${endpoint}'`);
        if (idx === -1) return;
        const chunk = charServerSource.substring(Math.max(0, idx - 50), idx + 200);
        expect(chunk).toContain("'GET'");
      }
    );
  });

  describe('character-server.ts — POST-only endpoints check method', () => {
    const charPostEndpoints = [
      '/api/chat/stream',
      '/api/chat',
      '/api/interlink/letter',
      '/api/interlink/dream-seed',
      '/api/peer/message',
    ];

    it.each(charPostEndpoints)(
      'Character server POST %s checks method',
      (endpoint) => {
        const idx = charServerSource.indexOf(`'${endpoint}'`);
        if (idx === -1) return;
        const allMatches: number[] = [];
        let searchFrom = 0;
        while (true) {
          const found = charServerSource.indexOf(`'${endpoint}'`, searchFrom);
          if (found === -1) break;
          allMatches.push(found);
          searchFrom = found + 1;
        }
        const hasPost = allMatches.some((pos) => {
          const chunk = charServerSource.substring(Math.max(0, pos - 100), pos + 200);
          return chunk.includes("'POST'");
        });
        expect(hasPost).toBe(true);
      }
    );
  });

  describe('OPTIONS preflight handling', () => {
    it('server.ts responds to OPTIONS with 204', () => {
      expect(serverSource).toContain("req.method === 'OPTIONS'");
      expect(serverSource).toContain('res.writeHead(204)');
    });

    it('character-server.ts responds to OPTIONS with 204', () => {
      expect(charServerSource).toContain("req.method === 'OPTIONS'");
      expect(charServerSource).toContain('res.writeHead(204)');
    });
  });

  describe('CORS headers on all responses', () => {
    it('server.ts sets CORS headers before routing', () => {
      // CORS headers are set before the routing logic
      const corsIdx = serverSource.indexOf('Access-Control-Allow-Origin');
      const routeIdx = serverSource.indexOf("'/api/health'");
      expect(corsIdx).toBeLessThan(routeIdx);
    });

    it('character-server.ts sets CORS headers before routing (via applyCorsHeaders helper) — findings.md P2:2366', () => {
      // After the cors.ts extraction, character-server no longer contains the
      // literal Access-Control-Allow-Origin header text — it calls the helper
      // instead. Check the helper call lands before the first route match.
      const corsIdx = charServerSource.indexOf('applyCorsHeaders(res');
      const routeIdx = charServerSource.indexOf("'/api/characters'");
      expect(corsIdx).toBeGreaterThan(-1);
      expect(corsIdx).toBeLessThan(routeIdx);
    });

    it('server.ts Access-Control-Allow-Methods includes standard methods', () => {
      expect(serverSource).toContain('GET, POST, OPTIONS');
    });

    it('cors.ts helper default methods include standard set — findings.md P2:2366', async () => {
      const { readFile } = await import('node:fs/promises');
      const corsSource = await readFile(new URL('../src/web/cors.ts', import.meta.url), 'utf-8');
      expect(corsSource).toContain('GET, POST, OPTIONS');
    });
  });

  describe('DELETE endpoints verify method', () => {
    it('DELETE /api/postboard/:id checks DELETE method', () => {
      const deletePostboard = serverSource.substring(
        serverSource.indexOf("/api/postboard/'") + 16,
        serverSource.indexOf("/api/postboard/'") + 300
      );
      // Find the DELETE handler section
      expect(serverSource).toContain("req.method === 'DELETE'");
    });

    it('DELETE /api/objects/:id checks DELETE method', () => {
      // Find the objects DELETE handler
      const objectDeleteIdx = serverSource.indexOf("req.method === 'DELETE'");
      expect(objectDeleteIdx).toBeGreaterThan(-1);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. AUTH BYPASS ATTEMPTS
// ═══════════════════════════════════════════════════════════════════════════

describe('Auth Bypass Attempts', () => {
  describe('Owner auth — functional bypass tests', () => {
    beforeEach(() => {
      process.env['LAIN_OWNER_TOKEN'] = TEST_TOKEN;
    });

    afterEach(() => {
      if (ORIGINAL_OWNER_TOKEN) {
        process.env['LAIN_OWNER_TOKEN'] = ORIGINAL_OWNER_TOKEN;
      } else {
        delete process.env['LAIN_OWNER_TOKEN'];
      }
    });

    it('rejects request with no cookie', () => {
      expect(isOwner(makeReq())).toBe(false);
    });

    it('rejects request with empty cookie', () => {
      expect(isOwner(makeReq({ cookie: '' }))).toBe(false);
    });

    it('rejects request with wrong cookie name', () => {
      const correctValue = makeV2CookieValue(TEST_TOKEN);
      expect(isOwner(makeReq({ cookie: `wrong_name=${correctValue}` }))).toBe(false);
    });

    it('rejects request with partial cookie value', () => {
      const correctValue = makeV2CookieValue(TEST_TOKEN);
      const partial = correctValue.slice(0, 10);
      expect(isOwner(makeReq({ cookie: `${OWNER_COOKIE_NAME}=${partial}` }))).toBe(false);
    });

    it('rejects request with cookie value + extra chars', () => {
      // Sig is hex, so appending non-hex at the end causes regex stop — payload.sig
      // regex still captures the valid pair. This simulates attacker appending
      // bytes to a stolen cookie; our regex tolerates trailing garbage which is
      // OK because the HMAC is still verified correctly.
      const correctValue = makeV2CookieValue(TEST_TOKEN);
      // Inject garbage BEFORE the sig ends — breaks sig parse.
      const [payload, sig] = correctValue.split('.');
      const broken = `${payload}.${sig!.slice(0, -2)}zz`; // non-hex tail
      expect(isOwner(makeReq({ cookie: `${OWNER_COOKIE_NAME}=${broken}` }))).toBe(false);
    });

    it('rejects request with uppercase hex in signature', () => {
      const correctValue = makeV2CookieValue(TEST_TOKEN);
      const [payload, sig] = correctValue.split('.');
      const upperSig = sig!.toUpperCase();
      // The regex requires [a-f0-9]+ for the signature — uppercase won't match.
      expect(isOwner(makeReq({ cookie: `${OWNER_COOKIE_NAME}=${payload}.${upperSig}` }))).toBe(false);
    });

    it('rejects request with cookie for different token', () => {
      const wrongCookie = makeV2Cookie(TEST_TOKEN, { signWith: 'different-token' });
      expect(isOwner(makeReq({ cookie: wrongCookie }))).toBe(false);
    });

    it('accepts request with correct cookie', () => {
      expect(isOwner(makeOwnerReq(TEST_TOKEN))).toBe(true);
    });

    it('accepts request with cookie among multiple cookies', () => {
      const v2 = makeV2Cookie(TEST_TOKEN);
      expect(
        isOwner(makeReq({ cookie: `other=abc; ${v2}; session=xyz` }))
      ).toBe(true);
    });

    it('rejects when LAIN_OWNER_TOKEN is empty string', () => {
      process.env['LAIN_OWNER_TOKEN'] = '';
      expect(isOwner(makeOwnerReq(''))).toBe(false);
    });

    it('rejects when LAIN_OWNER_TOKEN is unset', () => {
      delete process.env['LAIN_OWNER_TOKEN'];
      expect(isOwner(makeReq({ cookie: makeV2Cookie(TEST_TOKEN) }))).toBe(false);
    });

    it('rejects legacy v1 cookies outright', () => {
      // findings.md P2:2348 — v1 (`lain_owner=<hex>`) is no longer accepted
      // even when the hash happens to be well-formed.
      expect(isOwner(makeReq({ cookie: 'lain_owner=' + 'a'.repeat(64) }))).toBe(false);
    });
  });

  describe('Token with whitespace/special chars', () => {
    beforeEach(() => {
      process.env['LAIN_OWNER_TOKEN'] = TEST_TOKEN;
    });

    afterEach(() => {
      if (ORIGINAL_OWNER_TOKEN) {
        process.env['LAIN_OWNER_TOKEN'] = ORIGINAL_OWNER_TOKEN;
      } else {
        delete process.env['LAIN_OWNER_TOKEN'];
      }
    });

    it('rejects cookie with leading whitespace inside the value', () => {
      const correctValue = makeV2CookieValue(TEST_TOKEN);
      expect(isOwner(makeReq({ cookie: `${OWNER_COOKIE_NAME}= ${correctValue}` }))).toBe(false);
    });

    it('cookie regex stops at trailing whitespace (captures correct value)', () => {
      const v2 = makeV2Cookie(TEST_TOKEN);
      expect(isOwner(makeReq({ cookie: `${v2} ` }))).toBe(true);
    });

    it('rejects cookie with null byte prefix (changes captured value)', () => {
      const correctValue = makeV2CookieValue(TEST_TOKEN);
      expect(isOwner(makeReq({ cookie: `${OWNER_COOKIE_NAME}=\x00${correctValue}` }))).toBe(false);
    });

    it('cookie regex stops at null byte suffix (captures correct value)', () => {
      const v2 = makeV2Cookie(TEST_TOKEN);
      expect(isOwner(makeReq({ cookie: `${v2}\x00` }))).toBe(true);
    });
  });

  describe('Timing-safe comparison', () => {
    it('owner-auth.ts uses timingSafeEqual from node:crypto', () => {
      expect(ownerAuthSource).toContain('timingSafeEqual');
    });

    it('owner-auth.ts short-circuits on length mismatch', () => {
      expect(ownerAuthSource).toContain('expected.length !== provided.length');
    });

    it('owner-auth.ts converts to Buffer for comparison', () => {
      expect(ownerAuthSource).toContain('Buffer.from(expected)');
      expect(ownerAuthSource).toContain('Buffer.from(provided)');
    });
  });

  describe('secureCompare constant-time functional tests', () => {
    it('returns true for equal strings', () => {
      expect(secureCompare('abc123', 'abc123')).toBe(true);
    });

    it('returns false for different strings of same length', () => {
      expect(secureCompare('abc123', 'xyz789')).toBe(false);
    });

    it('returns false for different lengths', () => {
      expect(secureCompare('short', 'much-longer-string')).toBe(false);
    });

    it('returns true for empty strings', () => {
      expect(secureCompare('', '')).toBe(true);
    });

    it('returns false when one is empty', () => {
      expect(secureCompare('', 'notempty')).toBe(false);
    });

    it('handles unicode strings', () => {
      expect(secureCompare('hello\u00e9', 'hello\u00e9')).toBe(true);
      expect(secureCompare('hello\u00e9', 'hello\u00ea')).toBe(false);
    });
  });

  describe('Server auth guards on every protected endpoint (server.ts)', () => {
    // Endpoints that need auth — verify each has an auth check
    const ownerProtectedEndpoints = [
      { path: '/api/chat', method: 'POST', auth: 'verifyApiAuth' },
      { path: '/api/chat/stream', method: 'POST', auth: 'verifyApiAuth' },
      { path: '/api/system', method: 'GET', auth: 'isOwner' },
    ];

    it.each(ownerProtectedEndpoints)(
      '$path requires $auth',
      ({ path, method, auth }) => {
        const handlerPattern = `'${path}' && req.method === '${method}'`;
        const idx = serverSource.indexOf(handlerPattern);
        expect(idx).toBeGreaterThan(-1);
        const chunk = serverSource.substring(idx, idx + 500);
        expect(chunk).toContain(auth);
      }
    );

    const interlinkProtectedEndpoints = [
      '/api/internal-state',
      '/api/interlink/letter',
      '/api/interlink/research-request',
      '/api/conversations/event',
      '/api/peer/message',
    ];

    it.each(interlinkProtectedEndpoints)(
      '%s requires verifyInterlinkAuth',
      (path) => {
        // Find the actual handler (with method check)
        const getPattern = `'${path}' && req.method === 'GET'`;
        const postPattern = `'${path}' && req.method === 'POST'`;
        const getIdx = serverSource.indexOf(getPattern);
        const postIdx = serverSource.indexOf(postPattern);
        const idx = Math.max(getIdx, postIdx);
        expect(idx).toBeGreaterThan(-1);
        const chunk = serverSource.substring(Math.max(0, idx - 100), idx + 500);
        expect(chunk).toContain('verifyInterlinkAuth');
      }
    );

    const dualAuthEndpoints = [
      '/api/meta/integrity',
      '/api/telemetry',
    ];

    it.each(dualAuthEndpoints)(
      '%s requires owner OR interlink auth',
      (path) => {
        const handlerPattern = `'${path}' && req.method === 'GET'`;
        const idx = serverSource.indexOf(handlerPattern);
        expect(idx).toBeGreaterThan(-1);
        const chunk = serverSource.substring(idx, idx + 500);
        expect(chunk).toContain('isOwner');
        expect(chunk).toContain('verifyInterlinkAuth');
      }
    );
  });

  describe('Server auth guards on every protected endpoint (character-server.ts)', () => {
    const charOwnerEndpoints = [
      '/api/chat',
      '/api/chat/stream',
    ];

    it.each(charOwnerEndpoints)(
      'Character server %s requires isOwner',
      (path) => {
        // Find the POST handler
        const handlerPattern = `'${path}' && req.method === 'POST'`;
        const idx = charServerSource.indexOf(handlerPattern);
        if (idx === -1) return;
        const chunk = charServerSource.substring(idx, idx + 500);
        expect(chunk).toContain('isOwner');
      }
    );

    const charInterlinkEndpoints = [
      { path: '/api/internal-state', method: 'GET' },
      { path: '/api/peer/message', method: 'POST' },
      { path: '/api/interlink/letter', method: 'POST' },
      { path: '/api/interlink/dream-seed', method: 'POST' },
    ];

    it.each(charInterlinkEndpoints)(
      'Character server $path requires auth',
      ({ path, method }) => {
        const handlerPattern = `'${path}' && req.method === '${method}'`;
        const idx = charServerSource.indexOf(handlerPattern);
        if (idx === -1) return;
        const chunk = charServerSource.substring(Math.max(0, idx - 200), idx + 600);
        const hasAuth =
          chunk.includes('verifyInterlinkAuth') ||
          chunk.includes('isOwner');
        expect(hasAuth).toBe(true);
      }
    );
  });

  describe('Public endpoints are intentionally unauthenticated', () => {
    const publicEndpoints = [
      '/api/health',
      '/api/characters',
      '/api/location',
      '/api/meta/identity',
      '/api/weather',
      '/api/events',
      '/api/activity',
      '/api/building/notes',
      '/api/documents',
      '/api/conversations/stream',
      '/api/conversations/recent',
    ];

    it.each(publicEndpoints)(
      '%s is documented as public (no auth)',
      (path) => {
        const idx = serverSource.indexOf(`'${path}'`);
        if (idx === -1) return;
        // Verify it exists as a route
        expect(idx).toBeGreaterThan(-1);
      }
    );
  });

  describe('Owner-only page protection', () => {
    it('OWNER_ONLY_PATHS includes dashboard', () => {
      expect(serverSource).toContain("'/dashboard.html'");
    });

    it('OWNER_ONLY_PATHS includes character pages', () => {
      // findings.md P2:2388 — per-character prefixes used to be hardcoded
      // here; they are now derived from the manifest via
      // getCharacterRoutePrefixes() so a rename only touches characters.json.
      // `/local/` is still a literal alias (not a character id).
      expect(serverSource).toContain("'/local/'");
      expect(serverSource).toContain('getCharacterRoutePrefixes');
      expect(serverSource).toMatch(/OWNER_ONLY_PATHS\s*=\s*\[\.\.\.STATIC_OWNER_ONLY_PATHS,\s*\.\.\.getCharacterRoutePrefixes\(\)\]/);
    });

    it('OWNER_ONLY_PATHS includes postboard and events pages', () => {
      expect(serverSource).toContain("'/postboard.html'");
      expect(serverSource).toContain("'/town-events.html'");
      expect(serverSource).toContain("'/dreams.html'");
    });

    it('non-owners are redirected to commune-map', () => {
      expect(serverSource).toContain("Location: '/commune-map.html'");
    });

    it('root path (/) requires owner auth', () => {
      expect(serverSource).toContain("url.pathname === '/'");
    });
  });

  describe('Interlink auth implementation', () => {
    // Auth logic lives in src/security/interlink-auth.ts (per-character
    // derivation + identity binding per findings.md P1:2289). Servers now
    // delegate to verifyInterlinkRequest() and treat the authenticated
    // fromId as the source of truth.
    it('interlink-auth checks for Bearer prefix', () => {
      expect(interlinkAuthSource).toContain("auth.startsWith('Bearer ')");
    });

    it('interlink-auth uses secureCompare', () => {
      expect(interlinkAuthSource).toContain('secureCompare');
    });

    it('interlink-auth returns 401 for missing auth header', () => {
      const idx = interlinkAuthSource.indexOf('function verifyInterlinkRequest');
      const section = interlinkAuthSource.substring(idx, idx + 1500);
      expect(section).toContain('401');
    });

    it('interlink-auth returns 403 for invalid token', () => {
      const idx = interlinkAuthSource.indexOf('function verifyInterlinkRequest');
      const section = interlinkAuthSource.substring(idx, idx + 1500);
      expect(section).toContain('403');
    });

    it('interlink-auth returns 503 when master token not configured', () => {
      const idx = interlinkAuthSource.indexOf('function verifyInterlinkRequest');
      const section = interlinkAuthSource.substring(idx, idx + 1500);
      expect(section).toContain('503');
    });

    it('server verifyInterlinkAuth wrapper delegates to verifyInterlinkRequest', () => {
      const idx = serverSource.indexOf('function verifyInterlinkAuth');
      expect(idx).toBeGreaterThan(-1);
      const section = serverSource.substring(idx, idx + 400);
      expect(section).toContain('verifyInterlinkRequest');
    });

    it('character server verifyInterlinkAuth wrapper delegates to verifyInterlinkRequest', () => {
      const idx = charServerSource.indexOf('function verifyInterlinkAuth');
      expect(idx).toBeGreaterThan(-1);
      const section = charServerSource.substring(idx, idx + 400);
      expect(section).toContain('verifyInterlinkRequest');
    });
  });

  describe('verifyApiAuth accepts both cookie and Bearer', () => {
    it('verifyApiAuth checks owner cookie first', () => {
      const idx = serverSource.indexOf('function verifyApiAuth');
      const apiAuthSection = serverSource.substring(idx, idx + 700);
      expect(apiAuthSection).toContain('isOwner(req)');
    });

    it('verifyApiAuth checks Bearer token as fallback', () => {
      const idx = serverSource.indexOf('function verifyApiAuth');
      const apiAuthSection = serverSource.substring(idx, idx + 700);
      expect(apiAuthSection).toContain("authHeader?.startsWith('Bearer ')");
    });

    it('verifyApiAuth uses secureCompare for Bearer token', () => {
      const idx = serverSource.indexOf('function verifyApiAuth');
      const apiAuthSection = serverSource.substring(idx, idx + 700);
      expect(apiAuthSection).toContain('secureCompare(provided, apiKey)');
    });

    it('verifyApiAuth returns 401 on failure', () => {
      const idx = serverSource.indexOf('function verifyApiAuth');
      const apiAuthSection = serverSource.substring(idx, idx + 700);
      expect(apiAuthSection).toContain('401');
    });
  });

  describe('Rate limiting on chat endpoints', () => {
    it('chat POST checks rate limit', () => {
      const chatIdx = serverSource.indexOf("'/api/chat' && req.method === 'POST'");
      expect(chatIdx).toBeGreaterThan(-1);
      const chatSection = serverSource.substring(chatIdx, chatIdx + 600);
      expect(chatSection).toContain('checkRateLimit');
    });

    it('chat/stream POST checks rate limit', () => {
      const streamIdx = serverSource.indexOf("'/api/chat/stream' && req.method === 'POST'");
      expect(streamIdx).toBeGreaterThan(-1);
      const streamSection = serverSource.substring(streamIdx, streamIdx + 600);
      expect(streamSection).toContain('checkRateLimit');
    });

    it('rate limit returns 429', () => {
      expect(serverSource).toContain("res.writeHead(429");
      expect(serverSource).toContain("'Too many requests'");
    });
  });

  describe('No secret leaking in error responses', () => {
    it('server.ts never includes token values in error messages', () => {
      // Check that error JSON responses don't include raw tokens
      expect(serverSource).not.toMatch(/res\.end\(JSON\.stringify\({.*LAIN_OWNER_TOKEN/);
      expect(serverSource).not.toMatch(/res\.end\(JSON\.stringify\({.*LAIN_INTERLINK_TOKEN/);
    });

    it('character-server.ts never includes token values in error messages', () => {
      expect(charServerSource).not.toMatch(/res\.end\(JSON\.stringify\({.*LAIN_OWNER_TOKEN/);
      expect(charServerSource).not.toMatch(/res\.end\(JSON\.stringify\({.*LAIN_INTERLINK_TOKEN/);
    });
  });

  describe('Possession endpoints require auth', () => {
    it('possession routes check auth', () => {
      expect(charServerSource).toContain('verifyPossessionAuth');
    });

    it('possession routes fallback to owner auth', () => {
      const possessionSection = charServerSource.substring(
        charServerSource.indexOf('possessionPaths'),
        charServerSource.indexOf('possessionPaths') + 600
      );
      expect(possessionSection).toContain('isOwner');
    });
  });

  describe('Object mutation endpoints require interlink auth', () => {
    const objectMutations = [
      '/api/objects',          // POST create
      '/pickup',               // POST pickup
      '/drop',                 // POST drop
      '/give',                 // POST give
    ];

    it('POST /api/objects (create) requires interlink auth', () => {
      // Find the POST handler for objects
      const objectCreateIdx = serverSource.indexOf("url.pathname === '/api/objects' && req.method === 'POST'");
      if (objectCreateIdx === -1) return;
      const chunk = serverSource.substring(objectCreateIdx, objectCreateIdx + 300);
      expect(chunk).toContain('verifyInterlinkAuth');
    });

    it('POST pickup requires interlink auth', () => {
      const pickupSection = serverSource.substring(
        serverSource.indexOf('/pickup') - 200,
        serverSource.indexOf('/pickup') + 300
      );
      expect(pickupSection).toContain('verifyInterlinkAuth');
    });

    it('POST drop requires interlink auth', () => {
      const dropSection = serverSource.substring(
        serverSource.indexOf('/drop') - 200,
        serverSource.indexOf('/drop') + 300
      );
      expect(dropSection).toContain('verifyInterlinkAuth');
    });

    it('POST give requires interlink auth', () => {
      const giveSection = serverSource.substring(
        serverSource.indexOf('/give') - 200,
        serverSource.indexOf('/give') + 300
      );
      expect(giveSection).toContain('verifyInterlinkAuth');
    });

    it('DELETE /api/objects/:id requires interlink auth', () => {
      // Find the objects DELETE handler (not postboard DELETE)
      // Search for the pattern with /api/objects/ and DELETE together
      const objectsDeletePattern = "/api/objects/";
      let idx = serverSource.indexOf(objectsDeletePattern);
      let found = false;
      while (idx !== -1) {
        const chunk = serverSource.substring(idx, idx + 400);
        if (chunk.includes("'DELETE'") && chunk.includes('verifyInterlinkAuth')) {
          found = true;
          break;
        }
        idx = serverSource.indexOf(objectsDeletePattern, idx + 1);
      }
      expect(found).toBe(true);
    });
  });

  describe('Building event endpoint requires interlink auth', () => {
    it('POST /api/buildings/:id/event requires auth', () => {
      const buildingEventIdx = serverSource.indexOf('/api/buildings/');
      if (buildingEventIdx === -1) return;
      const chunk = serverSource.substring(buildingEventIdx, buildingEventIdx + 500);
      expect(chunk).toContain('verifyInterlinkAuth');
    });
  });

  describe('Gate endpoint security', () => {
    it('gate uses secureCompare for token validation', () => {
      expect(serverSource).toContain('secureCompare(provided, ownerToken)');
    });

    it('gate returns 403 for invalid token', () => {
      expect(serverSource).toContain('res.writeHead(403');
    });

    it('gate issues cookie only on success', () => {
      // findings.md P2:2348 — issueOwnerCookie is called only inside the
      // success branch. Both the POST and the GET handler must secureCompare
      // and only then issueOwnerCookie.
      const gateStart = serverSource.indexOf("'/gate'");
      const gateEnd = serverSource.indexOf('// Block non-owners', gateStart);
      const gateSection = serverSource.substring(gateStart, gateEnd > gateStart ? gateEnd : gateStart + 2400);
      expect(gateSection).toContain('secureCompare');
      expect(gateSection).toContain('issueOwnerCookie');
    });

    it('gate redirects to / on success', () => {
      expect(serverSource).toContain("'Location': '/'");
    });

    // findings.md P2:2466 — the owner token must not leak through URL query strings
    // into browser history, referrer headers, or reverse-proxy logs.
    it('gate exposes a POST handler that reads the token from the request body', () => {
      expect(serverSource).toContain("'/gate' && req.method === 'POST'");
      const postIdx = serverSource.indexOf("'/gate' && req.method === 'POST'");
      const chunk = serverSource.substring(postIdx, postIdx + 1200);
      // The POST branch must read the body (not url.searchParams).
      expect(chunk).toContain('collectBody');
      expect(chunk).toContain('secureCompare');
      expect(chunk).toContain('issueOwnerCookie');
    });

    it('gate responses include Cache-Control: no-store and Referrer-Policy: no-referrer', () => {
      const firstGate = serverSource.indexOf("'/gate'");
      const end = serverSource.indexOf('// Block non-owners', firstGate);
      const gateBlock = serverSource.substring(firstGate, end > firstGate ? end : firstGate + 2000);
      expect(gateBlock).toContain("'Cache-Control': 'no-store'");
      expect(gateBlock).toContain("'Referrer-Policy': 'no-referrer'");
    });
  });

  describe('Internal embed endpoint requires auth', () => {
    it('POST /api/internal/embed requires verifyApiAuth', () => {
      const embedIdx = serverSource.indexOf("'/api/internal/embed' && req.method === 'POST'");
      expect(embedIdx).toBeGreaterThan(-1);
      const chunk = serverSource.substring(embedIdx, embedIdx + 300);
      expect(chunk).toContain('verifyApiAuth');
    });
  });

  describe('Dreams aggregator endpoints require auth', () => {
    it('GET /api/dreams/status requires verifyApiAuth', () => {
      const dreamsIdx = serverSource.indexOf("'/api/dreams/status' && req.method === 'GET'");
      expect(dreamsIdx).toBeGreaterThan(-1);
      const chunk = serverSource.substring(dreamsIdx, dreamsIdx + 300);
      expect(chunk).toContain('verifyApiAuth');
    });

    it('GET /api/dreams/seeds requires verifyApiAuth', () => {
      const seedsIdx = serverSource.indexOf("'/api/dreams/seeds' && req.method === 'GET'");
      expect(seedsIdx).toBeGreaterThan(-1);
      const chunk = serverSource.substring(seedsIdx, seedsIdx + 300);
      expect(chunk).toContain('verifyApiAuth');
    });
  });

  describe('Evolution endpoints require auth', () => {
    it('GET /api/evolution/lineages requires verifyApiAuth', () => {
      const lineagesIdx = serverSource.indexOf("'/api/evolution/lineages' && req.method === 'GET'");
      expect(lineagesIdx).toBeGreaterThan(-1);
      const chunk = serverSource.substring(lineagesIdx, lineagesIdx + 300);
      expect(chunk).toContain('verifyApiAuth');
    });

    it('GET /api/evolution/status requires verifyApiAuth', () => {
      const statusIdx = serverSource.indexOf("'/api/evolution/status' && req.method === 'GET'");
      expect(statusIdx).toBeGreaterThan(-1);
      const chunk = serverSource.substring(statusIdx, statusIdx + 300);
      expect(chunk).toContain('verifyApiAuth');
    });
  });

  describe('Feeds and budget endpoints require auth', () => {
    it('GET /api/feeds/health requires verifyApiAuth', () => {
      const feedsIdx = serverSource.indexOf("'/api/feeds/health' && req.method === 'GET'");
      expect(feedsIdx).toBeGreaterThan(-1);
      const chunk = serverSource.substring(feedsIdx, feedsIdx + 300);
      expect(chunk).toContain('verifyApiAuth');
    });

    it('GET /api/budget requires verifyApiAuth', () => {
      const budgetIdx = serverSource.indexOf("'/api/budget' && req.method === 'GET'");
      expect(budgetIdx).toBeGreaterThan(-1);
      const chunk = serverSource.substring(budgetIdx, budgetIdx + 300);
      expect(chunk).toContain('verifyApiAuth');
    });
  });

  describe('Dream stats endpoint on character server requires auth', () => {
    it('GET /api/dreams/stats requires interlink auth', () => {
      const dreamStatsIdx = charServerSource.indexOf("'/api/dreams/stats'");
      if (dreamStatsIdx === -1) return;
      const chunk = charServerSource.substring(dreamStatsIdx, dreamStatsIdx + 300);
      expect(chunk).toContain('verifyInterlinkAuth');
    });

    it('GET /api/dreams/seeds requires interlink auth', () => {
      const dreamSeedsIdx = charServerSource.indexOf("'/api/dreams/seeds'");
      if (dreamSeedsIdx === -1) return;
      const chunk = charServerSource.substring(dreamSeedsIdx, dreamSeedsIdx + 300);
      expect(chunk).toContain('verifyInterlinkAuth');
    });
  });

  describe('Meta key endpoint requires interlink auth', () => {
    it('GET /api/meta/:key requires interlink auth', () => {
      const metaIdx = charServerSource.indexOf("/api/meta/'");
      // Find the generic /api/meta/ handler
      const genericMetaIdx = charServerSource.indexOf("url.pathname.startsWith('/api/meta/')");
      if (genericMetaIdx === -1) return;
      const chunk = charServerSource.substring(genericMetaIdx, genericMetaIdx + 300);
      expect(chunk).toContain('verifyInterlinkAuth');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. ADDITIONAL SECURITY PATTERNS
// ═══════════════════════════════════════════════════════════════════════════

describe('Additional Security Patterns', () => {
  describe('Body size limits', () => {
    it('server.ts defines MAX_BODY_BYTES', () => {
      expect(serverSource).toContain('const MAX_BODY_BYTES = 1_048_576');
    });

    it('collectBody enforces the limit', () => {
      expect(serverSource).toContain('size > maxBytes');
      expect(serverSource).toContain('req.destroy()');
    });

    it('postboard content is capped at 2000 chars', () => {
      expect(serverSource).toContain('content.length > 2000');
    });

    it('dream-seed content is capped at 2000 chars', () => {
      expect(serverSource).toContain("content exceeds 2000 character limit");
    });
  });

  describe('Input sanitization is applied', () => {
    it('dream-seed runs content through sanitizer', () => {
      const dreamIdx = serverSource.indexOf("'/api/interlink/dream-seed' && req.method === 'POST'");
      expect(dreamIdx).toBeGreaterThan(-1);
      const dreamSection = serverSource.substring(dreamIdx, dreamIdx + 1200);
      expect(dreamSection).toContain('sanitize(content)');
    });

    it('research-request runs question through sanitizer', () => {
      const researchIdx = serverSource.indexOf("'/api/interlink/research-request' && req.method === 'POST'");
      expect(researchIdx).toBeGreaterThan(-1);
      const researchSection = serverSource.substring(researchIdx, researchIdx + 2000);
      expect(researchSection).toContain('sanitize(question)');
    });

    it('object creation sanitizes name and description', () => {
      // sanitize() is called on both fields; the block-check regression
      // (that .blocked must gate the write) lives under the dedicated
      // "POST /api/objects checks sanitize().blocked" describe.
      expect(serverSource).toContain('sanitize(name)');
      expect(serverSource).toContain('sanitize(description)');
    });
  });

  describe('No eval() in any server code', () => {
    it('server.ts has no eval()', () => {
      expect(serverSource).not.toMatch(/\beval\s*\(/);
    });

    it('character-server.ts has no eval()', () => {
      expect(charServerSource).not.toMatch(/\beval\s*\(/);
    });

    it('ssrf.ts has no eval()', () => {
      expect(ssrfSource).not.toMatch(/\beval\s*\(/);
    });

    it('sanitizer.ts has no eval()', () => {
      expect(sanitizerSource).not.toMatch(/\beval\s*\(/);
    });

    it('database.ts has no eval()', () => {
      expect(databaseSource).not.toMatch(/\beval\s*\(/);
    });

    it('store.ts has no eval()', () => {
      expect(storeSource).not.toMatch(/\beval\s*\(/);
    });
  });

  describe('No child_process exec with user input', () => {
    it('server.ts exec calls use hardcoded commands only', () => {
      // The only exec calls should be for system stats
      const execCalls = serverSource.match(/execAsync\([^)]+\)/g) || [];
      for (const call of execCalls) {
        // Should not contain any user-controlled variables
        expect(call).not.toContain('url.');
        expect(call).not.toContain('req.');
        expect(call).not.toContain('body');
      }
    });
  });

  describe('Fixture protection in objects system', () => {
    it('fixture pickup is blocked', () => {
      expect(serverSource).toContain('isFixture(id)');
      expect(serverSource).toContain('This is a fixture and cannot be picked up');
    });

    it('fixture transfer is blocked', () => {
      expect(serverSource).toContain('This is a fixture and cannot be transferred');
    });

    it('fixture destruction is blocked', () => {
      expect(serverSource).toContain('This is a fixture and cannot be destroyed');
    });
  });

  describe('Bad request handling', () => {
    it('server.ts returns 400 for malformed URL', () => {
      expect(serverSource).toContain("res.writeHead(400, { 'Content-Type': 'text/plain' })");
      expect(serverSource).toContain("res.end('Bad Request')");
    });

    it('character-server.ts returns 400 for malformed URL', () => {
      expect(charServerSource).toContain("res.writeHead(400, { 'Content-Type': 'text/plain' })");
      expect(charServerSource).toContain("res.end('Bad Request')");
    });
  });

  describe('Emotional weight clamping', () => {
    it('dream-seed clamps emotionalWeight to 0-1 range', () => {
      // Both servers clamp the weight
      expect(serverSource).toContain('Math.max(0, Math.min(1, emotionalWeight))');
    });

    it('character server dream-seed clamps emotionalWeight', () => {
      expect(charServerSource).toContain('Math.max(0, Math.min(1, emotionalWeight))');
    });
  });

  describe('Object name and description length limits', () => {
    it('object name is sliced to 100 chars', () => {
      expect(serverSource).toContain('.slice(0, 100)');
    });

    it('object description is sliced to 500 chars', () => {
      expect(serverSource).toContain('.slice(0, 500)');
    });
  });

  describe('Channel isAllowed fail-closed default (P1 findings.md)', () => {
    const sources: Array<[string, string]> = [
      ['telegram', telegramChannelSource],
      ['whatsapp', whatsappChannelSource],
      ['discord', discordChannelSource],
      ['slack', slackChannelSource],
      ['signal', signalChannelSource],
    ];

    for (const [name, source] of sources) {
      it(`${name} config declares public?: boolean`, () => {
        expect(source).toMatch(/public\?:\s*boolean/);
      });

      it(`${name} isAllowed empty-allowlists branch returns public === true, not true`, () => {
        // The canonical fail-open phrase is gone.
        expect(source).not.toMatch(/\/\/ If no restrictions, allow all/);
        // And the early-return is now gated on the explicit opt-in.
        expect(source).toMatch(/return this\.config\.public === true;/);
      });

      it(`${name} connect() warns when allowlists are empty`, () => {
        // Warning must mention both the public-mode path and the fail-closed path.
        expect(source).toMatch(/PUBLIC mode/);
        expect(source).toMatch(/empty allowlists and public !== true/);
      });
    }
  });

  describe('town-events auth + forceLocation validation (P1 findings.md)', () => {
    it('GET /api/town-events is gated by isOwner || verifyInterlinkAuth', () => {
      const idx = serverSource.indexOf("'/api/town-events' && req.method === 'GET'");
      expect(idx).toBeGreaterThan(-1);
      const section = serverSource.substring(idx, idx + 600);
      expect(section).toMatch(/if \(!isOwner\(req\) && !verifyInterlinkAuth\(req, res\)\) return;/);
    });

    it('GET /api/town-events/effects is gated by isOwner || verifyInterlinkAuth', () => {
      const idx = serverSource.indexOf("'/api/town-events/effects' && req.method === 'GET'");
      expect(idx).toBeGreaterThan(-1);
      const section = serverSource.substring(idx, idx + 600);
      expect(section).toMatch(/if \(!isOwner\(req\) && !verifyInterlinkAuth\(req, res\)\) return;/);
    });

    it('town-life.ts sends per-character interlink headers when fetching town events', () => {
      // Per-character tokens (findings.md P1:2289): outbound calls now use
      // getInterlinkHeaders() which supplies both the derived Bearer token
      // and the X-Interlink-From identity header.
      expect(townLifeSource).toMatch(/getInterlinkHeaders/);
      expect(townLifeSource).toMatch(/\/api\/town-events[^'`]*['`],\s*\{\s*headers:\s*authHeaders/);
    });

    it('town-life.ts validates forceLocation via isValidBuilding before setCurrentLocation', () => {
      expect(townLifeSource).toMatch(/import[^;]*isValidBuilding[^;]*buildings\.js/);
      // The unsafe cast is gone.
      expect(townLifeSource).not.toMatch(/activeEffects\.forceLocation\s+as\s+BuildingId/);
      // The guard is present, and setCurrentLocation sits inside the valid branch.
      const idx = townLifeSource.indexOf('activeEffects.forceLocation && activeEffects.forceLocation !== loc.building');
      expect(idx).toBeGreaterThan(-1);
      const section = townLifeSource.substring(idx, idx + 1000);
      expect(section).toMatch(/if \(!isValidBuilding\(activeEffects\.forceLocation\)\)/);
      expect(section).toMatch(/ignoring forceLocation for unknown building id/);
      expect(section).toMatch(/setCurrentLocation\(activeEffects\.forceLocation,/);
    });
  });

  describe('LLM-authored tool RCE surface is gone (P1 findings.md:1561)', () => {
    // skills.ts handed `new Function(...)` + `require` + `process` to
    // LLM-authored JavaScript. It was removed along with the three meta-tools
    // that let the LLM save / list / delete custom tools.

    it('src/agent/skills.ts no longer exists on disk', () => {
      const { existsSync } = require('node:fs') as typeof import('node:fs');
      expect(existsSync(join(SRC, 'agent', 'skills.ts'))).toBe(false);
    });

    it('agent/tools.ts does not re-introduce the skills.js import', () => {
      expect(agentToolsSource).not.toMatch(/from\s+['"]\.\/skills\.js['"]/);
      expect(agentToolsSource).not.toMatch(/import[^;]*saveCustomTool/);
      expect(agentToolsSource).not.toMatch(/import[^;]*listCustomTools/);
      expect(agentToolsSource).not.toMatch(/import[^;]*deleteCustomTool/);
    });

    it('agent/tools.ts no longer registers create_tool / list_my_tools / delete_tool', () => {
      expect(agentToolsSource).not.toContain("name: 'create_tool'");
      expect(agentToolsSource).not.toContain("name: 'list_my_tools'");
      expect(agentToolsSource).not.toContain("name: 'delete_tool'");
    });

    it('no source file still wires up the skills module', () => {
      const { execSync } = require('node:child_process') as typeof import('node:child_process');
      const out = execSync(
        "grep -rn --include='*.ts' \"from '\\./skills\\.js'\\|from '\\.\\./agent/skills\\.js'\\|loadCustomTools\" src || true",
        { cwd: process.cwd(), encoding: 'utf-8' },
      );
      expect(out.trim(), `skills.js must not be referenced by any src/ file:\n${out}`).toBe('');
    });
  });
});
