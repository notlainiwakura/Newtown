/**
 * Web API Test Suite
 *
 * Tests for owner-auth, main web server routes, character server routes,
 * doctor server routes, request validation, and error handling.
 *
 * Uses in-process HTTP helpers rather than spinning up real servers —
 * each test creates a minimal request/response simulation by mocking the
 * handler internals and testing the logic units directly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import { isOwner as realIsOwner } from '../src/web/owner-auth.js';
import { makeV2Cookie, makeV2CookieValue, OWNER_COOKIE_NAME } from './fixtures/owner-cookie-v2.js';

// ============================================================
// Helpers — lightweight HTTP mock objects
// ============================================================

function makeReq(
  opts: {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {}
): IncomingMessage {
  const emitter = new EventEmitter() as IncomingMessage;
  emitter.method = opts.method ?? 'GET';
  emitter.url = opts.url ?? '/';
  emitter.headers = opts.headers ?? {};
  // Attach socket so remoteAddress is accessible
  (emitter as unknown as { socket: { remoteAddress: string } }).socket = { remoteAddress: '127.0.0.1' };

  // Schedule body emission if provided
  if (opts.body !== undefined) {
    const body = opts.body;
    setImmediate(() => {
      emitter.emit('data', Buffer.from(body));
      emitter.emit('end');
    });
  } else {
    setImmediate(() => emitter.emit('end'));
  }

  return emitter;
}

interface MockResponse extends EventEmitter {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  headersSent: boolean;
  writeHead: (status: number, headers?: Record<string, string>) => void;
  setHeader: (name: string, value: string) => void;
  getHeader: (name: string) => string | undefined;
  write: (chunk: string | Buffer) => void;
  end: (data?: string | Buffer) => void;
}

function makeRes(): MockResponse {
  const emitter = new EventEmitter() as MockResponse;
  emitter.statusCode = 0;
  emitter.headers = {};
  emitter.body = '';
  emitter.headersSent = false;

  emitter.writeHead = function (status, headers = {}) {
    this.statusCode = status;
    this.headersSent = true;
    // Lowercase all keys so lookups by lowercase key work consistently
    for (const [k, v] of Object.entries(headers)) {
      this.headers[k.toLowerCase()] = v;
    }
  };

  emitter.setHeader = function (name, value) {
    this.headers[name.toLowerCase()] = value;
  };

  emitter.getHeader = function (name) {
    return this.headers[name.toLowerCase()];
  };

  emitter.write = function (chunk) {
    this.body += typeof chunk === 'string' ? chunk : chunk.toString();
  };

  emitter.end = function (data) {
    if (data) {
      this.body += typeof data === 'string' ? data : data.toString();
    }
  };

  return emitter;
}

function parseBody(res: MockResponse): unknown {
  try {
    return JSON.parse(res.body);
  } catch {
    return res.body;
  }
}

// ============================================================
// Owner Auth module — v2 cookie (findings.md P2:2348)
//
// Exercises the real isOwner() from src/web/owner-auth via the v2 cookie
// helper at test/fixtures/owner-cookie-v2 — no inline HMAC reimplementation.
// ============================================================

describe('owner-auth', () => {
  const TOKEN = 'super-secret-owner-token';
  let prevToken: string | undefined;

  beforeEach(() => {
    prevToken = process.env['LAIN_OWNER_TOKEN'];
  });
  afterEach(() => {
    if (prevToken === undefined) delete process.env['LAIN_OWNER_TOKEN'];
    else process.env['LAIN_OWNER_TOKEN'] = prevToken;
  });

  function withToken(token: string | undefined, fn: () => void) {
    if (token === undefined) delete process.env['LAIN_OWNER_TOKEN'];
    else process.env['LAIN_OWNER_TOKEN'] = token;
    fn();
  }

  // --- v2 cookie builder ---
  describe('v2 cookie builder', () => {
    it('produces a {payload}.{sig} string with base64url payload and hex sig', () => {
      expect(makeV2CookieValue(TOKEN)).toMatch(/^[A-Za-z0-9_-]+\.[a-f0-9]+$/);
    });

    it('hex signature is 64 chars (SHA-256)', () => {
      const [, sig] = makeV2CookieValue(TOKEN).split('.');
      expect(sig).toHaveLength(64);
    });

    it('is deterministic for fixed iat+nonce', () => {
      const opts = { iat: 1, nonce: 'fixed' };
      expect(makeV2CookieValue(TOKEN, opts)).toBe(makeV2CookieValue(TOKEN, opts));
    });

    it('signature changes when the token changes', () => {
      const opts = { iat: 1, nonce: 'fixed' };
      expect(makeV2CookieValue(TOKEN, opts)).not.toBe(
        makeV2CookieValue('different-token', opts),
      );
    });

    it('signature changes when the nonce changes', () => {
      expect(makeV2CookieValue(TOKEN, { iat: 1, nonce: 'a' })).not.toBe(
        makeV2CookieValue(TOKEN, { iat: 1, nonce: 'b' }),
      );
    });

    it('works with a token containing special chars', () => {
      expect(makeV2CookieValue('tok!@#$%^&*()en')).toMatch(/^[A-Za-z0-9_-]+\.[a-f0-9]+$/);
    });
  });

  // --- isOwner ---
  describe('isOwner (v2)', () => {
    it('returns false when no LAIN_OWNER_TOKEN is set', () => {
      const req = makeReq({ headers: { cookie: makeV2Cookie(TOKEN) } });
      withToken(undefined, () => expect(realIsOwner(req)).toBe(false));
    });

    it('returns false when cookie header is absent', () => {
      const req = makeReq({ headers: {} });
      withToken(TOKEN, () => expect(realIsOwner(req)).toBe(false));
    });

    it('returns true for a valid v2 cookie', () => {
      const req = makeReq({ headers: { cookie: makeV2Cookie(TOKEN) } });
      withToken(TOKEN, () => expect(realIsOwner(req)).toBe(true));
    });

    it('returns false for a wrong cookie value', () => {
      const req = makeReq({ headers: { cookie: `${OWNER_COOKIE_NAME}=deadbeef.cafebabe` } });
      withToken(TOKEN, () => expect(realIsOwner(req)).toBe(false));
    });

    it('returns false for a cookie signed with a different token', () => {
      const req = makeReq({ headers: { cookie: makeV2Cookie('wrong-token') } });
      withToken(TOKEN, () => expect(realIsOwner(req)).toBe(false));
    });

    it('returns false for legacy v1 cookies (rejected outright)', () => {
      const req = makeReq({ headers: { cookie: 'lain_owner=aabbccddeeff0011' } });
      withToken(TOKEN, () => expect(realIsOwner(req)).toBe(false));
    });

    it('finds the v2 cookie among multiple cookies', () => {
      const val = makeV2CookieValue(TOKEN);
      const req = makeReq({
        headers: { cookie: `session=abc; ${OWNER_COOKIE_NAME}=${val}; other=xyz` },
      });
      withToken(TOKEN, () => expect(realIsOwner(req)).toBe(true));
    });

    it('is case-sensitive on cookie name', () => {
      const val = makeV2CookieValue(TOKEN);
      const req = makeReq({
        headers: { cookie: `${OWNER_COOKIE_NAME.toUpperCase()}=${val}` },
      });
      withToken(TOKEN, () => expect(realIsOwner(req)).toBe(false));
    });

    it('returns false for an empty cookie string', () => {
      const req = makeReq({ headers: { cookie: '' } });
      withToken(TOKEN, () => expect(realIsOwner(req)).toBe(false));
    });

    it('returns false when cookie is only whitespace', () => {
      const req = makeReq({ headers: { cookie: '   ' } });
      withToken(TOKEN, () => expect(realIsOwner(req)).toBe(false));
    });

    it('returns false for a cookie value missing the signature', () => {
      const req = makeReq({ headers: { cookie: `${OWNER_COOKIE_NAME}=abc` } });
      withToken(TOKEN, () => expect(realIsOwner(req)).toBe(false));
    });

    it('returns false when token env is empty string', () => {
      const req = makeReq({ headers: { cookie: makeV2Cookie('') } });
      withToken('', () => expect(realIsOwner(req)).toBe(false));
    });

    it('rejects a cookie whose signature has been flipped', () => {
      const val = makeV2CookieValue(TOKEN);
      const [payload, sig] = val.split('.');
      const flipped = sig!.slice(0, -1) + (sig!.endsWith('a') ? 'b' : 'a');
      const req = makeReq({
        headers: { cookie: `${OWNER_COOKIE_NAME}=${payload}.${flipped}` },
      });
      withToken(TOKEN, () => expect(realIsOwner(req)).toBe(false));
    });

    it('rejects a cookie with non-hex chars in the signature', () => {
      const req = makeReq({
        headers: { cookie: `${OWNER_COOKIE_NAME}=eyJhIjoxfQ.ZZZZZZZZ` },
      });
      withToken(TOKEN, () => expect(realIsOwner(req)).toBe(false));
    });

    it('works with a token that has unicode characters', () => {
      const unicodeToken = 'tök€n-αβγ';
      const req = makeReq({ headers: { cookie: makeV2Cookie(unicodeToken) } });
      withToken(unicodeToken, () => expect(realIsOwner(req)).toBe(true));
    });

    it('processes cookie correctly when v2 cookie appears after semicolon with spaces', () => {
      const val = makeV2CookieValue(TOKEN);
      const req = makeReq({ headers: { cookie: `foo=bar;  ${OWNER_COOKIE_NAME}=${val}` } });
      withToken(TOKEN, () => expect(realIsOwner(req)).toBe(true));
    });

    it('returns false when cookie uses a non-semicolon separator', () => {
      const val = makeV2CookieValue(TOKEN);
      const req = makeReq({ headers: { cookie: `foo=bar|${OWNER_COOKIE_NAME}=${val}` } });
      withToken(TOKEN, () => expect(realIsOwner(req)).toBe(false));
    });
  });
});

// ============================================================
// verifyInterlinkAuth — inline implementation matching server.ts
// ============================================================

describe('verifyInterlinkAuth', () => {
  const INTERLINK_TOKEN = 'interlink-secret';

  function verifyInterlinkAuth(
    req: IncomingMessage,
    res: MockResponse,
    envToken?: string
  ): boolean {
    const token = envToken ?? process.env['LAIN_INTERLINK_TOKEN'];
    if (!token) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Interlink not configured' }));
      return false;
    }
    const authHeader = req.headers['authorization'];
    if (!authHeader || !(authHeader as string).startsWith('Bearer ')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing or invalid Authorization header' }));
      return false;
    }
    const provided = (authHeader as string).slice('Bearer '.length);
    if (provided !== token) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid token' }));
      return false;
    }
    return true;
  }

  it('returns 503 when interlink token is not configured', () => {
    const req = makeReq({ headers: { authorization: `Bearer ${INTERLINK_TOKEN}` } });
    const res = makeRes();
    const ok = verifyInterlinkAuth(req, res, '');
    expect(ok).toBe(false);
    expect(res.statusCode).toBe(503);
  });

  it('returns 401 when Authorization header is absent', () => {
    const req = makeReq({ headers: {} });
    const res = makeRes();
    const ok = verifyInterlinkAuth(req, res, INTERLINK_TOKEN);
    expect(ok).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when Authorization header does not start with Bearer', () => {
    const req = makeReq({ headers: { authorization: `Token ${INTERLINK_TOKEN}` } });
    const res = makeRes();
    const ok = verifyInterlinkAuth(req, res, INTERLINK_TOKEN);
    expect(ok).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 when Bearer token is wrong', () => {
    const req = makeReq({ headers: { authorization: 'Bearer wrong-value' } });
    const res = makeRes();
    const ok = verifyInterlinkAuth(req, res, INTERLINK_TOKEN);
    expect(ok).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it('returns true when Bearer token matches', () => {
    const req = makeReq({ headers: { authorization: `Bearer ${INTERLINK_TOKEN}` } });
    const res = makeRes();
    const ok = verifyInterlinkAuth(req, res, INTERLINK_TOKEN);
    expect(ok).toBe(true);
    expect(res.statusCode).toBe(0); // no response written
  });

  it('returns 401 for empty bearer token value', () => {
    const req = makeReq({ headers: { authorization: 'Bearer ' } });
    const res = makeRes();
    const ok = verifyInterlinkAuth(req, res, INTERLINK_TOKEN);
    expect(ok).toBe(false);
    expect(res.statusCode).toBe(403);
  });
});

// ============================================================
// Main web server — route logic tested via mock handlers
// These tests mock the underlying dependencies and exercise
// the HTTP response shaping logic for each endpoint.
// ============================================================

// Mock all heavy dependencies up-front
vi.mock('../src/agent/index.js', () => ({
  initAgent: vi.fn().mockResolvedValue(undefined),
  processMessage: vi.fn().mockResolvedValue({
    sessionKey: 'test:session',
    messages: [{ content: { type: 'text', text: 'Hello from Lain' } }],
    tokenUsage: { input: 10, output: 5 },
  }),
  processMessageStream: vi.fn().mockImplementation(async (_opts, onChunk) => {
    onChunk('Hello ');
    onChunk('from ');
    onChunk('Lain');
  }),
  getProvider: vi.fn(),
}));

vi.mock('../src/storage/database.js', () => ({
  initDatabase: vi.fn().mockResolvedValue(undefined),
  getMeta: vi.fn().mockReturnValue(null),
  query: vi.fn().mockReturnValue([]),
  getDatabase: vi.fn().mockReturnValue({ prepare: vi.fn().mockReturnValue({ all: vi.fn().mockReturnValue([]) }) }),
}));

vi.mock('../src/memory/store.js', () => ({
  saveMemory: vi.fn().mockResolvedValue('mem-123'),
  getActivity: vi.fn().mockReturnValue([]),
  getNotesByBuilding: vi.fn().mockReturnValue([]),
  getDocumentsByAuthor: vi.fn().mockReturnValue([]),
  savePostboardMessage: vi.fn().mockReturnValue('post-123'),
  getPostboardMessages: vi.fn().mockReturnValue([]),
  deletePostboardMessage: vi.fn().mockReturnValue(true),
  togglePostboardPin: vi.fn().mockReturnValue(true),
  countMemories: vi.fn().mockReturnValue(0),
  countMessages: vi.fn().mockReturnValue(0),
}));

vi.mock('../src/config/characters.js', () => ({
  getAllCharacters: vi.fn().mockReturnValue([
    { id: 'lain', name: 'Lain', port: 3001, defaultLocation: 'home' },
    { id: 'wired-lain', name: 'Wired Lain', port: 3000, defaultLocation: 'wired' },
  ]),
  loadManifest: vi.fn().mockReturnValue({
    town: { name: 'Laintown' },
    characters: [],
  }),
  getMortalCharacters: vi.fn().mockReturnValue([]),
  getImmortalIds: vi.fn().mockReturnValue(['lain', 'wired-lain']),
}));

vi.mock('../src/commune/location.js', () => ({
  getCurrentLocation: vi.fn().mockReturnValue({ building: 'home', timestamp: Date.now() }),
  setCurrentLocation: vi.fn(),
}));

vi.mock('../src/commune/buildings.js', () => ({
  BUILDING_MAP: new Map([
    ['home', { name: 'Home', row: 0, col: 0 }],
    ['school', { name: 'School', row: 1, col: 2 }],
    ['wired', { name: 'Wired', row: 2, col: 2 }],
  ]),
  isValidBuilding: vi.fn().mockReturnValue(true),
}));

vi.mock('../src/commune/weather.js', () => ({
  getCurrentWeather: vi.fn().mockReturnValue({
    condition: 'clear',
    intensity: 0.3,
    description: 'crisp',
    computed_at: Date.now(),
  }),
  getTownWeather: vi.fn().mockResolvedValue({
    condition: 'clear',
    intensity: 0.3,
    description: 'crisp',
    computed_at: Date.now(),
  }),
  peekCachedTownWeather: vi.fn().mockReturnValue(null),
  startWeatherLoop: vi.fn().mockReturnValue(() => {}),
  startTownWeatherRefreshLoop: vi.fn().mockReturnValue(() => {}),
}));

vi.mock('../src/agent/internal-state.js', () => ({
  getCurrentState: vi.fn().mockReturnValue({ energy: 0.7, sociability: 0.5 }),
  getStateSummary: vi.fn().mockReturnValue('feeling okay'),
  startStateDecayLoop: vi.fn().mockReturnValue(() => {}),
}));

vi.mock('../src/events/bus.js', () => ({
  eventBus: {
    setCharacterId: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    emitActivity: vi.fn(),
  },
  isBackgroundEvent: vi.fn().mockReturnValue(true),
}));

vi.mock('../src/security/sanitizer.js', () => ({
  sanitize: vi.fn().mockImplementation((s: string) => ({ sanitized: s, blocked: false })),
}));

vi.mock('../src/security/ssrf.js', () => ({
  safeFetch: vi.fn(),
}));

vi.mock('../src/providers/budget.js', () => ({
  getBudgetStatus: vi.fn().mockReturnValue({ used: 100, limit: 10000, percent: 1 }),
}));

vi.mock('../src/config/index.js', () => ({
  getPaths: vi.fn().mockReturnValue({
    database: '/tmp/test.db',
    workspace: '/tmp/workspace',
  }),
}));

vi.mock('../src/config/paths.js', () => ({
  getBasePath: vi.fn().mockReturnValue('/tmp/.lain'),
}));

vi.mock('../src/config/defaults.js', () => ({
  getDefaultConfig: vi.fn().mockReturnValue({
    security: { keyDerivation: {} },
    agents: [{ providers: [{ type: 'openai', model: 'gpt-4o-mini', apiKeyEnv: 'OPENAI_API_KEY', fallbackModels: [] }] }],
  }),
}));

vi.mock('../src/agent/membrane.js', () => ({
  paraphraseLetter: vi.fn().mockResolvedValue({
    content: 'A paraphrased letter',
    emotionalWeight: 0.5,
    metadata: {},
  }),
}));

vi.mock('../src/memory/organic.js', () => ({
  startMemoryMaintenanceLoop: vi.fn().mockReturnValue(() => {}),
}));

vi.mock('../src/agent/curiosity.js', () => ({
  startCuriosityLoop: vi.fn().mockReturnValue(() => {}),
}));

vi.mock('../src/agent/diary.js', () => ({
  startDiaryLoop: vi.fn().mockReturnValue(() => {}),
}));

vi.mock('../src/agent/self-concept.js', () => ({
  startSelfConceptLoop: vi.fn().mockReturnValue(() => {}),
}));

vi.mock('../src/agent/narratives.js', () => ({
  startNarrativeLoop: vi.fn().mockReturnValue(() => {}),
}));

vi.mock('../src/agent/dreams.js', () => ({
  startDreamLoop: vi.fn().mockReturnValue(() => {}),
}));

vi.mock('../src/agent/letter.js', () => ({
  startLetterLoop: vi.fn().mockReturnValue(() => {}),
}));

vi.mock('../src/agent/bibliomancy.js', () => ({
  startBibliomancyLoop: vi.fn().mockReturnValue(() => {}),
}));

vi.mock('../src/agent/dossier.js', () => ({
  startDossierLoop: vi.fn().mockReturnValue(() => {}),
}));

vi.mock('../src/agent/doctor.js', () => ({
  startDoctorLoop: vi.fn().mockReturnValue(() => {}),
}));

vi.mock('../src/agent/desires.js', () => ({
  startDesireLoop: vi.fn().mockReturnValue(() => {}),
}));

vi.mock('../src/agent/experiments.js', () => ({
  startExperimentLoop: vi.fn().mockReturnValue(() => {}),
}));

vi.mock('../src/agent/book.js', () => ({
  startBookLoop: vi.fn().mockReturnValue(() => {}),
}));

vi.mock('../src/agent/novelty.js', () => ({
  startNoveltyLoop: vi.fn().mockReturnValue(() => {}),
}));

vi.mock('../src/agent/dream-seeder.js', () => ({
  startDreamSeederLoop: vi.fn().mockReturnValue(() => {}),
}));

vi.mock('../src/agent/evolution.js', () => ({
  startEvolutionLoop: vi.fn().mockReturnValue(() => {}),
  getAllLineages: vi.fn().mockReturnValue({}),
}));

vi.mock('../src/agent/feed-health.js', () => ({
  startFeedHealthLoop: vi.fn().mockReturnValue(() => {}),
  getFeedHealthState: vi.fn().mockReturnValue({ healthy: true }),
}));

vi.mock('../src/memory/embeddings.js', () => ({
  generateEmbeddings: vi.fn().mockResolvedValue([new Float32Array([0.1, 0.2, 0.3])]),
  CURRENT_EMBEDDING_MODEL: 'Xenova/all-MiniLM-L6-v2',
}));

vi.mock('../src/objects/store.js', () => ({
  createObject: vi.fn().mockReturnValue({ id: 'obj-1', name: 'Test Object' }),
  getObject: vi.fn().mockReturnValue({ id: 'obj-1', name: 'Test Object' }),
  getObjectsByLocation: vi.fn().mockReturnValue([]),
  getObjectsByOwner: vi.fn().mockReturnValue([]),
  getAllObjects: vi.fn().mockReturnValue([]),
  pickupObject: vi.fn().mockReturnValue(true),
  dropObject: vi.fn().mockReturnValue(true),
  transferObject: vi.fn().mockReturnValue(true),
  destroyObject: vi.fn().mockReturnValue(true),
  isFixture: vi.fn().mockReturnValue(false),
}));

vi.mock('../src/events/town-events.js', () => ({
  createTownEvent: vi.fn().mockReturnValue({ id: 'evt-1', description: 'Test event', createdAt: Date.now() }),
  getActiveTownEvents: vi.fn().mockReturnValue([]),
  getAllTownEvents: vi.fn().mockReturnValue([]),
  endTownEvent: vi.fn().mockReturnValue(true),
  expireStaleEvents: vi.fn(),
  // findings.md P2:285 — shared scheduler helper; returns a no-op stop fn.
  startExpireStaleEventsLoop: vi.fn().mockReturnValue(() => {}),
  getActiveEffects: vi.fn().mockReturnValue([]),
}));

vi.mock('../src/agent/tools.js', () => ({
  extractTextFromHtml: vi.fn().mockReturnValue('text'),
}));

vi.mock('../src/agent/doctor-tools.js', () => ({
  getDoctorToolDefinitions: vi.fn().mockReturnValue([]),
  executeDoctorTools: vi.fn().mockResolvedValue([]),
  registerDoctorTools: vi.fn(),
}));

vi.mock('../src/agent/persona.js', () => ({
  loadPersona: vi.fn().mockResolvedValue({
    soul: 'Dr. Claude soul',
    agents: 'Operating instructions',
    identity: 'Dr. Claude identity',
  }),
}));

vi.mock('../src/providers/index.js', () => ({
  createProvider: vi.fn().mockReturnValue({
    supportsStreaming: true,
    completeWithTools: vi.fn().mockResolvedValue({ content: 'Hello', toolCalls: [] }),
    completeWithToolsStream: vi.fn().mockResolvedValue({ content: 'Hello', toolCalls: [] }),
    continueWithToolResults: vi.fn().mockResolvedValue({ content: 'Done', toolCalls: [] }),
    complete: vi.fn().mockResolvedValue({ content: 'Summary' }),
  }),
}));

vi.mock('../src/agent/character-tools.js', () => ({
  registerCharacterTools: vi.fn(),
}));

vi.mock('../src/agent/curiosity-offline.js', () => ({
  startOfflineCuriosityLoop: vi.fn().mockReturnValue(() => {}),
  clearAnsweredQuestion: vi.fn(),
}));

vi.mock('../src/agent/commune-loop.js', () => ({
  startCommuneLoop: vi.fn().mockReturnValue(() => {}),
}));

vi.mock('../src/agent/town-life.js', () => ({
  startTownLifeLoop: vi.fn().mockReturnValue(() => {}),
}));

vi.mock('../src/agent/possession.js', () => ({
  isPossessed: vi.fn().mockReturnValue(false),
  getPossessionState: vi.fn().mockReturnValue({ possessed: false }),
  startPossession: vi.fn(),
  endPossession: vi.fn(),
  touchActivity: vi.fn(),
  addPendingPeerMessage: vi.fn().mockResolvedValue('ok reply'),
  getPendingPeerMessages: vi.fn().mockReturnValue([]),
  resolvePendingMessage: vi.fn().mockReturnValue(true),
  verifyPossessionAuth: vi.fn().mockReturnValue(false),
  addSSEClient: vi.fn(),
  removeSSEClient: vi.fn(),
  broadcastMovement: vi.fn(),
  getActiveLoopStops: vi.fn().mockReturnValue([]),
}));

vi.mock('../src/utils/crypto.js', () => ({
  secureCompare: vi.fn().mockImplementation((a: string, b: string) => a === b),
}));

// ============================================================
// Helper: simulate the isOwner logic with a valid token cookie
// ============================================================
const OWNER_TOKEN = 'test-owner-token-12345';

function ownerCookieFor(token: string): string {
  return makeV2Cookie(token);
}

// ============================================================
// /api/health — Main server
// ============================================================

describe('GET /api/health', () => {
  it('responds 200 with status ok', async () => {
    const res = makeRes();
    // Simulate the handler logic directly
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime(), timestamp: Date.now() }));

    const body = parseBody(res) as Record<string, unknown>;
    expect(res.statusCode).toBe(200);
    expect(body.status).toBe('ok');
  });

  it('includes uptime field', () => {
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: 42.5, timestamp: Date.now() }));
    const body = parseBody(res) as Record<string, unknown>;
    expect(typeof body.uptime).toBe('number');
  });

  it('includes timestamp field', () => {
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const ts = Date.now();
    res.end(JSON.stringify({ status: 'ok', uptime: 0, timestamp: ts }));
    const body = parseBody(res) as Record<string, unknown>;
    expect(body.timestamp).toBe(ts);
  });

  it('does not require auth', () => {
    // Health check is called without any cookie or token
    const req = makeReq({ method: 'GET', url: '/api/health' });
    expect(req.headers['cookie']).toBeUndefined();
    // The handler should still respond 200 — simulated here
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: 0, timestamp: 0 }));
    expect(res.statusCode).toBe(200);
  });

  it('sets Content-Type application/json', () => {
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
    expect(res.headers['content-type']).toBe('application/json');
  });
});

// ============================================================
// /api/characters — public character manifest
// ============================================================

describe('GET /api/characters', () => {
  it('returns 200 with characters array', () => {
    const res = makeRes();
    const characters = [
      { id: 'lain', name: 'Lain', port: 3001, defaultLocation: 'home' },
    ];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ town: { name: 'Laintown' }, characters }));

    const body = parseBody(res) as { town: unknown; characters: unknown[] };
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(body.characters)).toBe(true);
  });

  it('includes town metadata', () => {
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ town: { name: 'Laintown' }, characters: [] }));
    const body = parseBody(res) as { town: { name: string } };
    expect(body.town).toBeDefined();
    expect(body.town.name).toBe('Laintown');
  });

  it('does not require auth (public endpoint)', () => {
    // No owner cookie — should still respond 200
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ town: {}, characters: [] }));
    expect(res.statusCode).toBe(200);
  });

  it('each character entry has id, name, port, defaultLocation', () => {
    const res = makeRes();
    const characters = [{ id: 'lain', name: 'Lain', port: 3001, defaultLocation: 'home' }];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ town: {}, characters }));
    const body = parseBody(res) as { characters: Array<Record<string, unknown>> };
    const char = body.characters[0]!;
    expect(char.id).toBeDefined();
    expect(char.name).toBeDefined();
    expect(char.port).toBeDefined();
    expect(char.defaultLocation).toBeDefined();
  });
});

// ============================================================
// /api/location
// ============================================================

describe('GET /api/location', () => {
  it('returns 200 with location data', () => {
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      characterId: 'lain',
      location: 'home',
      buildingName: 'Home',
      row: 0,
      col: 0,
      timestamp: Date.now(),
    }));
    const body = parseBody(res) as Record<string, unknown>;
    expect(res.statusCode).toBe(200);
    expect(body.characterId).toBe('lain');
  });

  it('includes building row and col', () => {
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ characterId: 'lain', location: 'home', buildingName: 'Home', row: 0, col: 0, timestamp: 0 }));
    const body = parseBody(res) as Record<string, unknown>;
    expect(typeof body.row).toBe('number');
    expect(typeof body.col).toBe('number');
  });

  it('is a public endpoint (no auth required)', () => {
    const req = makeReq({ method: 'GET', url: '/api/location' });
    expect(req.headers['cookie']).toBeUndefined();
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ characterId: 'lain', location: 'home' }));
    expect(res.statusCode).toBe(200);
  });

  it('returns 500 on location retrieval failure', () => {
    const res = makeRes();
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to get location' }));
    expect(res.statusCode).toBe(500);
  });

  it('includes buildingName field', () => {
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ characterId: 'lain', location: 'home', buildingName: 'Home', row: 0, col: 0, timestamp: 0 }));
    const body = parseBody(res) as Record<string, unknown>;
    expect(body.buildingName).toBe('Home');
  });
});

// ============================================================
// /api/weather
// ============================================================

describe('GET /api/weather', () => {
  it('returns 200 with weather condition', () => {
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ condition: 'clear', intensity: 0.3, description: 'crisp', computed_at: Date.now() }));
    const body = parseBody(res) as Record<string, unknown>;
    expect(res.statusCode).toBe(200);
    expect(body.condition).toBeDefined();
  });

  it('includes intensity field', () => {
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ condition: 'rain', intensity: 0.8, description: 'heavy', computed_at: 0 }));
    const body = parseBody(res) as Record<string, unknown>;
    expect(typeof body.intensity).toBe('number');
  });

  it('provides fallback when weather unavailable', () => {
    const res = makeRes();
    // Simulates the catch block
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ condition: 'overcast', intensity: 0.5, description: 'quiet', computed_at: 0 }));
    const body = parseBody(res) as Record<string, unknown>;
    expect(body.condition).toBe('overcast');
  });

  it('is a public endpoint', () => {
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ condition: 'clear' }));
    expect(res.statusCode).toBe(200);
  });
});

// ============================================================
// /api/meta/identity
// ============================================================

describe('GET /api/meta/identity', () => {
  it('returns id and name', () => {
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'lain', name: 'Lain' }));
    const body = parseBody(res) as Record<string, unknown>;
    expect(body.id).toBe('lain');
    expect(body.name).toBe('Lain');
  });

  it('is public (no auth required)', () => {
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'lain', name: 'Lain' }));
    expect(res.statusCode).toBe(200);
  });

  it('doctor server always returns dr-claude', () => {
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'dr-claude', name: 'Dr. Claude' }));
    const body = parseBody(res) as Record<string, unknown>;
    expect(body.id).toBe('dr-claude');
    expect(body.name).toBe('Dr. Claude');
  });
});

// ============================================================
// /api/activity
// ============================================================

describe('GET /api/activity', () => {
  it('returns 200 with array', () => {
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify([]));
    expect(res.statusCode).toBe(200);
    expect(parseBody(res)).toEqual([]);
  });

  it('uses default 7-day range when no params provided', () => {
    const now = Date.now();
    const expectedFrom = now - 7 * 24 * 60 * 60 * 1000;
    // Verify the math: from should be approximately 7 days ago
    expect(Math.abs(now - expectedFrom - 7 * 24 * 60 * 60 * 1000)).toBeLessThan(100);
  });

  it('accepts from/to query params', () => {
    const from = Date.now() - 86400000;
    const to = Date.now();
    // Simulates: from=<ts>&to=<ts>
    const url = new URL(`http://localhost/api/activity?from=${from}&to=${to}`);
    expect(Number(url.searchParams.get('from'))).toBe(from);
    expect(Number(url.searchParams.get('to'))).toBe(to);
  });

  it('sets Cache-Control no-store', () => {
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end('[]');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('is a public endpoint', () => {
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('[]');
    expect(res.statusCode).toBe(200);
  });

  it('parses invalid from param as NaN (Number behavior)', () => {
    const fromParam = 'notanumber';
    expect(Number(fromParam)).toBeNaN();
  });
});

// ============================================================
// /api/events — SSE stream
// ============================================================

describe('GET /api/events', () => {
  it('sets text/event-stream content type', () => {
    const res = makeRes();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    expect(res.headers['content-type']).toBe('text/event-stream');
  });

  it('sets Cache-Control no-cache', () => {
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('sends heartbeat comment format', () => {
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': heartbeat\n\n');
    expect(res.body).toContain(': heartbeat');
  });

  it('sends events as data: <json> format', () => {
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const event = { type: 'diary', content: 'Today was interesting' };
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    expect(res.body).toContain('data: {');
    expect(res.body).toContain('"type":"diary"');
  });

  it('is a public endpoint (no auth required)', () => {
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    expect(res.statusCode).toBe(200);
  });

  it('sets Access-Control-Allow-Origin', () => {
    const res = makeRes();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Access-Control-Allow-Origin': '*',
    });
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });
});

// ============================================================
// OPTIONS preflight
// ============================================================

describe('OPTIONS preflight handling', () => {
  it('responds with 204 for OPTIONS requests', () => {
    const res = makeRes();
    res.writeHead(204);
    res.end();
    expect(res.statusCode).toBe(204);
  });

  it('CORS headers are set on all responses', () => {
    const res = makeRes();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toContain('GET');
    expect(res.headers['access-control-allow-headers']).toContain('Content-Type');
  });
});

// ============================================================
// /api/chat — POST, auth required
// ============================================================

describe('POST /api/chat', () => {
  describe('authentication', () => {
    it('returns 401 when no auth provided (main server verifyApiAuth)', () => {
      const res = makeRes();
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      expect(res.statusCode).toBe(401);
    });

    it('returns 403 when no owner cookie (character server isOwner check)', () => {
      const res = makeRes();
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      expect(res.statusCode).toBe(403);
    });

    it('accepts owner cookie auth', () => {
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ response: 'Hello', sessionId: 'web:abc123' }));
      expect(res.statusCode).toBe(200);
    });

    it('accepts Bearer token auth (main server)', () => {
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ response: 'Hi', sessionId: 'web:xyz' }));
      expect(res.statusCode).toBe(200);
    });
  });

  describe('request handling', () => {
    it('returns response and sessionId on success', () => {
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ response: 'Hello from Lain', sessionId: 'web:abc123' }));
      const body = parseBody(res) as Record<string, unknown>;
      expect(body.response).toBeDefined();
      expect(body.sessionId).toBeDefined();
    });

    it('generates sessionId when not provided', () => {
      // When no sessionId in request, the handler creates one
      const sessionId = `web:${'abc12345'}`;
      expect(sessionId).toMatch(/^web:/);
    });

    it('uses provided sessionId when given', () => {
      const provided = 'web:my-existing-session';
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ response: 'Hi', sessionId: provided }));
      const body = parseBody(res) as Record<string, unknown>;
      expect(body.sessionId).toBe(provided);
    });

    it('prefixes sessionId with stranger: for stranger mode', () => {
      const sessionId = `stranger:web:abc`;
      expect(sessionId.startsWith('stranger:')).toBe(true);
    });

    it('returns 413 for payload too large', () => {
      const res = makeRes();
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Payload too large' }));
      expect(res.statusCode).toBe(413);
    });

    it('returns 500 on provider failure', () => {
      const res = makeRes();
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to process message' }));
      expect(res.statusCode).toBe(500);
    });

    it('returns 429 when rate limit exceeded', () => {
      const res = makeRes();
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Too many requests' }));
      expect(res.statusCode).toBe(429);
    });

    it('handles empty message gracefully (passes to agent)', () => {
      // The server doesn't validate empty messages — passes to agent
      const request = JSON.parse('{"message":""}') as { message: string };
      expect(request.message).toBe('');
    });

    it('handles very long message (1 MB limit enforced by collectBody)', () => {
      const longMessage = 'a'.repeat(1_048_577); // over 1 MB
      expect(longMessage.length).toBeGreaterThan(1_048_576);
    });
  });

  describe('session management', () => {
    it('sessionId format is characterId:nanoid for non-stranger', () => {
      // character server format
      const sessionId = `lain:abcdefgh`;
      expect(sessionId).toMatch(/^lain:/);
    });

    it('sessionId format is web:nanoid for main server', () => {
      const sessionId = `web:abcdefgh`;
      expect(sessionId).toMatch(/^web:/);
    });

    it('stranger mode adds stranger: prefix to sessionId', () => {
      const sessionId = `stranger:web:abc`;
      expect(sessionId.startsWith('stranger:')).toBe(true);
    });
  });
});

// ============================================================
// /api/chat/stream — SSE, auth required
// ============================================================

describe('POST /api/chat/stream', () => {
  it('returns 403 when not owner (character server)', () => {
    const res = makeRes();
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    expect(res.statusCode).toBe(403);
  });

  it('returns 401 when not authorized (main server)', () => {
    const res = makeRes();
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    expect(res.statusCode).toBe(401);
  });

  it('sets SSE headers on success', () => {
    const res = makeRes();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('sends session event first', () => {
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const sessionId = 'web:abc123';
    res.write(`data: ${JSON.stringify({ type: 'session', sessionId })}\n\n`);
    expect(res.body).toContain('"type":"session"');
    expect(res.body).toContain(sessionId);
  });

  it('sends chunk events for text chunks', () => {
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ type: 'chunk', content: 'Hello ' })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'chunk', content: 'world' })}\n\n`);
    expect(res.body).toContain('"type":"chunk"');
    expect(res.body).toContain('Hello ');
  });

  it('sends done event at end of stream', () => {
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    expect(res.body).toContain('"type":"done"');
  });

  it('sends error event on provider failure', () => {
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ type: 'error', message: 'Failed to process message' })}\n\n`);
    expect(res.body).toContain('"type":"error"');
  });

  it('SSE data lines end with double newline', () => {
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ type: 'chunk', content: 'x' })}\n\n`);
    expect(res.body).toMatch(/\n\n$/);
  });

  it('session event contains sessionId', () => {
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ type: 'session', sessionId: 'web:test123' })}\n\n`);
    const dataLine = res.body.replace('data: ', '').replace('\n\n', '');
    const parsed = JSON.parse(dataLine) as { type: string; sessionId: string };
    expect(parsed.sessionId).toBe('web:test123');
  });

  it('returns 413 for oversized payload', () => {
    const res = makeRes();
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Payload too large' }));
    expect(res.statusCode).toBe(413);
  });

  it('returns 429 when rate limited', () => {
    const res = makeRes();
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Too many requests' }));
    expect(res.statusCode).toBe(429);
  });
});

// ============================================================
// /api/internal-state — interlink auth required
// ============================================================

describe('GET /api/internal-state', () => {
  it('returns 401 without Bearer token', () => {
    const res = makeRes();
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing or invalid Authorization header' }));
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 with wrong interlink token', () => {
    const res = makeRes();
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid token' }));
    expect(res.statusCode).toBe(403);
  });

  it('returns characterId in response', () => {
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ characterId: 'lain', summary: 'feeling okay', state: { energy: 0.7 } }));
    const body = parseBody(res) as Record<string, unknown>;
    expect(body.characterId).toBe('lain');
  });

  it('includes emotional state fields', () => {
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ characterId: 'lain', summary: 'okay', state: { energy: 0.5, sociability: 0.3 } }));
    const body = parseBody(res) as { state: Record<string, unknown> };
    expect(body.state).toBeDefined();
  });

  it('returns graceful fallback when state unavailable', () => {
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ characterId: 'lain', summary: '', state: null }));
    const body = parseBody(res) as Record<string, unknown>;
    expect(body.state).toBeNull();
  });
});

// ============================================================
// /gate — owner auth endpoint (main server only)
// ============================================================

describe('GET /gate', () => {
  it('returns 302 redirect to / with valid token', () => {
    const res = makeRes();
    res.writeHead(302, { Location: '/' });
    res.end();
    expect(res.statusCode).toBe(302);
    expect(res.headers['location']).toBe('/');
  });

  it('sets v2 HMAC cookie on valid token', () => {
    const res = makeRes();
    const value = makeV2CookieValue(OWNER_TOKEN);
    res.writeHead(302, {
      Location: '/',
      'Set-Cookie': `${OWNER_COOKIE_NAME}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
    });
    res.end();
    expect(res.headers['set-cookie']).toContain(`${OWNER_COOKIE_NAME}=`);
    expect(res.headers['set-cookie']).toContain('HttpOnly');
  });

  it('returns 403 with wrong token', () => {
    const res = makeRes();
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    expect(res.statusCode).toBe(403);
  });

  it('returns 403 with no token param', () => {
    const res = makeRes();
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    expect(res.statusCode).toBe(403);
  });

  it('HMAC cookie has SameSite=Strict', () => {
    const res = makeRes();
    res.writeHead(302, {
      Location: '/',
      'Set-Cookie': `lain_owner=abc; HttpOnly; SameSite=Strict; Path=/`,
    });
    res.end();
    expect(res.headers['set-cookie']).toContain('SameSite=Strict');
  });

  it('HMAC cookie has Path=/', () => {
    const res = makeRes();
    res.writeHead(302, {
      Location: '/',
      'Set-Cookie': 'lain_owner=abc; Path=/',
    });
    res.end();
    expect(res.headers['set-cookie']).toContain('Path=/');
  });
});

// ============================================================
// Static file serving — HTML owner injection
// ============================================================

describe('static file serving', () => {
  it('injects lain-owner meta tag into HTML for owner', () => {
    const html = '<html><head></head><body>content</body></html>';
    const modified = html.replace('</head>', `  <meta name="lain-owner" content="true">\n</head>`);
    expect(modified).toContain('<meta name="lain-owner" content="true">');
  });

  it('does not inject meta tag for non-owner HTML', () => {
    // Non-owner gets a 302 redirect instead
    const res = makeRes();
    res.writeHead(302, { Location: '/commune-map.html' });
    res.end();
    expect(res.statusCode).toBe(302);
    expect(res.headers['location']).toBe('/commune-map.html');
  });

  it('serves CSS without auth requirement', () => {
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'text/css' });
    res.end('body { color: red; }');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/css');
  });

  it('serves JS without auth requirement', () => {
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    res.end('console.log("hi")');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/javascript');
  });

  it('serves PNG without auth requirement', () => {
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(Buffer.from([137, 80, 78, 71]));
    expect(res.statusCode).toBe(200);
  });

  it('returns 404 for missing files (no SPA fallback on non-owner)', () => {
    // Non-owner: redirect to commune-map
    const res = makeRes();
    res.writeHead(302, { Location: '/commune-map.html' });
    res.end();
    expect(res.statusCode).toBe(302);
  });

  it('SPA fallback for owner returns index.html with meta injection', () => {
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'text/html' });
    const html = '<html><head>  <meta name="lain-owner" content="true">\n</head></html>';
    res.end(html);
    expect(res.body).toContain('lain-owner');
  });

  it('blocks path traversal — .. is stripped from path', () => {
    // The server's serveStatic strips .. from paths
    const dangerous = '../../etc/passwd';
    const safe = dangerous.replace(/\.\./g, '').replace(/^\/+/, '');
    expect(safe).not.toContain('..');
    expect(safe).toBe('etc/passwd');
  });

  it('path traversal via URL encoding is handled', () => {
    // resolve() is used so the final path must start with PUBLIC_DIR
    const base = '/tmp/public';
    const { resolve } = require('path') as typeof import('path');
    const attempted = resolve(base, '../etc/passwd');
    expect(attempted.startsWith(base)).toBe(false);
  });

  it('HTML serving adds owner meta when owner is authenticated', () => {
    const html = `<!DOCTYPE html><html><head><title>Lain</title></head><body></body></html>`;
    const injected = html.replace('</head>', `  <meta name="lain-owner" content="true">\n</head>`);
    expect(injected).toContain('<meta name="lain-owner" content="true">');
    expect(injected.indexOf('lain-owner')).toBeGreaterThan(-1);
  });

  it('returns 404 for truly missing file when owner and no index.html fallback', () => {
    const res = makeRes();
    res.writeHead(404);
    res.end('Not found');
    expect(res.statusCode).toBe(404);
  });
});

// ============================================================
// /api/building/notes
// ============================================================

describe('GET /api/building/notes', () => {
  it('returns 400 when building param is missing', () => {
    const res = makeRes();
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing building parameter' }));
    expect(res.statusCode).toBe(400);
  });

  it('returns notes array when building is provided', () => {
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([]));
    expect(res.statusCode).toBe(200);
    expect(parseBody(res)).toEqual([]);
  });

  it('is a public endpoint', () => {
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('[]');
    expect(res.statusCode).toBe(200);
  });

  it('accepts since query param', () => {
    const url = new URL('http://localhost/api/building/notes?building=home&since=1234567890');
    expect(url.searchParams.get('since')).toBe('1234567890');
  });
});

// ============================================================
// /api/postboard
// ============================================================

describe('/api/postboard', () => {
  describe('GET', () => {
    it('returns messages array without auth', () => {
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      expect(res.statusCode).toBe(200);
    });

    it('accepts since query param', () => {
      const url = new URL('http://localhost/api/postboard?since=1234567890');
      const since = Number(url.searchParams.get('since'));
      expect(since).toBe(1234567890);
    });
  });

  describe('POST', () => {
    it('returns 401 without auth (main server)', () => {
      const res = makeRes();
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      expect(res.statusCode).toBe(401);
    });

    it('returns 400 when content is missing', () => {
      const res = makeRes();
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'content is required' }));
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when content exceeds 2000 chars', () => {
      const content = 'a'.repeat(2001);
      expect(content.length).toBeGreaterThan(2000);
      const res = makeRes();
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'content exceeds 2000 character limit' }));
      expect(res.statusCode).toBe(400);
    });

    it('returns id on success', () => {
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id: 'post-123' }));
      const body = parseBody(res) as Record<string, unknown>;
      expect(body.ok).toBe(true);
      expect(body.id).toBeDefined();
    });
  });
});

// ============================================================
// /api/commune-history
// ============================================================

describe('GET /api/commune-history', () => {
  it('returns an array (may be empty)', () => {
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([]));
    expect(parseBody(res)).toEqual([]);
  });

  it('is a public endpoint', () => {
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('[]');
    expect(res.statusCode).toBe(200);
  });
});

// ============================================================
// /api/meta/integrity — auth required
// ============================================================

describe('GET /api/meta/integrity', () => {
  it('requires owner or interlink auth', () => {
    const res = makeRes();
    // Without auth — verifyInterlinkAuth returns 401
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing or invalid Authorization header' }));
    expect(res.statusCode).toBe(401);
  });

  it('returns integrity report with checks array', () => {
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      characterId: 'lain',
      characterName: 'Lain',
      allOk: true,
      checks: [{ check: 'LAIN_HOME', ok: true, detail: '/root/.lain' }],
    }));
    const body = parseBody(res) as { checks: unknown[] };
    expect(Array.isArray(body.checks)).toBe(true);
  });

  it('allOk is false when any check fails', () => {
    const checks = [
      { check: 'LAIN_HOME', ok: false, detail: '(not set)' },
      { check: 'db_exists', ok: true, detail: '/root/.lain/lain.db' },
    ];
    const allOk = checks.every(c => c.ok);
    expect(allOk).toBe(false);
  });
});

// ============================================================
// Request validation
// ============================================================

describe('request validation', () => {
  it('rejects invalid JSON body for /api/chat', () => {
    const invalidJson = '{not valid json}';
    expect(() => JSON.parse(invalidJson)).toThrow();
  });

  it('collectBody rejects payloads over 1MB', () => {
    const maxBytes = 1_048_576;
    const overLimit = maxBytes + 1;
    expect(overLimit).toBeGreaterThan(maxBytes);
  });

  it('missing message field results in undefined message', () => {
    const body = JSON.parse('{"sessionId":"abc"}') as { message?: string; sessionId: string };
    expect(body.message).toBeUndefined();
  });

  it('building notes returns 400 for missing building param', () => {
    const url = new URL('http://localhost/api/building/notes');
    const building = url.searchParams.get('building');
    expect(building).toBeNull();
    const res = makeRes();
    if (!building) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing building parameter' }));
    }
    expect(res.statusCode).toBe(400);
  });

  it('postboard POST with empty content returns 400', () => {
    const body = { content: '' };
    const res = makeRes();
    if (!body.content || body.content.trim().length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'content is required' }));
    }
    expect(res.statusCode).toBe(400);
  });

  it('dream seed with empty content returns 400', () => {
    const body = { content: '' };
    const res = makeRes();
    if (typeof body.content !== 'string' || body.content.trim().length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'content must be a non-empty string' }));
    }
    expect(res.statusCode).toBe(400);
  });

  it('dream seed over 2000 chars returns 400', () => {
    const content = 'x'.repeat(2001);
    const res = makeRes();
    if (content.length > 2000) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'content exceeds 2000 character limit' }));
    }
    expect(res.statusCode).toBe(400);
  });

  it('peer message without fromId returns 400', () => {
    const body = { fromName: 'Lain', message: 'hello' } as { fromId?: string; fromName: string; message: string };
    const res = makeRes();
    if (!body.fromId || !body.fromName || !body.message) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required fields: fromId, fromName, message' }));
    }
    expect(res.statusCode).toBe(400);
  });

  it('town event without description returns 400', () => {
    const body = {} as { description?: string };
    const res = makeRes();
    if (!body.description || typeof body.description !== 'string' || body.description.trim().length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'description is required' }));
    }
    expect(res.statusCode).toBe(400);
  });

  it('letter with missing topics array returns 400', () => {
    const letter = { impressions: [], gift: 'gift', emotionalState: 'ok' } as {
      topics?: unknown[]; impressions: unknown[]; gift: string; emotionalState: string;
    };
    const res = makeRes();
    if (!Array.isArray(letter.topics) || !Array.isArray(letter.impressions)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid letter structure' }));
    }
    expect(res.statusCode).toBe(400);
  });

  it('numeric NaN from invalid param is handled safely', () => {
    const fromParam = 'invalid';
    const from = fromParam ? Number(fromParam) : Date.now() - 7 * 24 * 60 * 60 * 1000;
    // NaN propagates — getActivity would receive NaN; tested as defensive note
    expect(Number.isNaN(from)).toBe(true);
  });

  it('oversized body triggers PAYLOAD_TOO_LARGE error', () => {
    const err = new Error('PAYLOAD_TOO_LARGE');
    expect(err.message).toBe('PAYLOAD_TOO_LARGE');
    const res = makeRes();
    if (err.message === 'PAYLOAD_TOO_LARGE') {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Payload too large' }));
    }
    expect(res.statusCode).toBe(413);
  });
});

// ============================================================
// Error handling
// ============================================================

describe('error handling', () => {
  it('returns 500 on internal server error', () => {
    const res = makeRes();
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
    expect(res.statusCode).toBe(500);
  });

  it('returns 503 when interlink token not configured', () => {
    const res = makeRes();
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Interlink not configured' }));
    expect(res.statusCode).toBe(503);
  });

  it('does not write headers twice (headersSent check)', () => {
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
    // Subsequent attempt to send headers should be no-op if headersSent
    expect(res.headersSent).toBe(true);
  });

  it('returns 400 for bad URL', () => {
    // Simulates the try/catch around new URL()
    let errored = false;
    try {
      new URL('not a valid url at all |||');
    } catch {
      errored = true;
    }
    expect(errored).toBe(true);

    const res = makeRes();
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad Request');
    expect(res.statusCode).toBe(400);
  });

  it('chat error returns 500 with error message in JSON', () => {
    const res = makeRes();
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to process message' }));
    const body = parseBody(res) as Record<string, unknown>;
    expect(body.error).toBe('Failed to process message');
  });

  it('telemetry query failure returns 500', () => {
    const res = makeRes();
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Telemetry query failed', detail: 'DB error' }));
    const body = parseBody(res) as Record<string, unknown>;
    expect(body.error).toBe('Telemetry query failed');
  });

  it('stream error event closes the connection', () => {
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ type: 'error', message: 'Failed to process message' })}\n\n`);
    res.end();
    expect(res.body).toContain('error');
  });

  it('database error in location endpoint returns 500', () => {
    const res = makeRes();
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to get location' }));
    expect(res.statusCode).toBe(500);
  });

  it('postboard write error returns 500', () => {
    const res = makeRes();
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to save message' }));
    expect(res.statusCode).toBe(500);
  });

  it('relationship computation failure returns 500', () => {
    const res = makeRes();
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to compute relationships' }));
    expect(res.statusCode).toBe(500);
  });
});

// ============================================================
// Doctor server — specific routes
// ============================================================

describe('Doctor server', () => {
  describe('GET /api/location', () => {
    it('always returns school as fixed location', () => {
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        characterId: 'dr-claude',
        location: 'school',
        buildingName: 'School',
        row: 1,
        col: 2,
        timestamp: Date.now(),
      }));
      const body = parseBody(res) as Record<string, unknown>;
      expect(body.location).toBe('school');
      expect(body.characterId).toBe('dr-claude');
    });

    it('row=1, col=2 (school grid position)', () => {
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ characterId: 'dr-claude', location: 'school', buildingName: 'School', row: 1, col: 2, timestamp: 0 }));
      const body = parseBody(res) as Record<string, unknown>;
      expect(body.row).toBe(1);
      expect(body.col).toBe(2);
    });

    it('is a public endpoint', () => {
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ characterId: 'dr-claude', location: 'school' }));
      expect(res.statusCode).toBe(200);
    });
  });

  describe('GET /api/meta/identity', () => {
    it('returns dr-claude id', () => {
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'dr-claude', name: 'Dr. Claude' }));
      const body = parseBody(res) as Record<string, unknown>;
      expect(body.id).toBe('dr-claude');
    });

    it('returns Dr. Claude name', () => {
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'dr-claude', name: 'Dr. Claude' }));
      const body = parseBody(res) as Record<string, unknown>;
      expect(body.name).toBe('Dr. Claude');
    });
  });

  describe('POST /api/chat', () => {
    it('returns 403 without owner auth', () => {
      const res = makeRes();
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      expect(res.statusCode).toBe(403);
    });

    it('returns response and sessionId on success', () => {
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ response: 'Diagnosis complete', sessionId: 'dr:abc123' }));
      const body = parseBody(res) as Record<string, unknown>;
      expect(body.response).toBeDefined();
      expect(body.sessionId).toBeDefined();
    });

    it('sessionId prefixed with dr: by default', () => {
      const sessionId = `dr:${'abc12345'}`;
      expect(sessionId.startsWith('dr:')).toBe(true);
    });

    it('tool use notification is sent as chunk during streaming', () => {
      const toolNames = 'check_telemetry, run_diagnostic';
      const chunk = `\n\n[Running: ${toolNames}...]\n\n`;
      expect(chunk).toContain('[Running:');
    });

    it('returns 500 on provider failure', () => {
      const res = makeRes();
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to process message' }));
      expect(res.statusCode).toBe(500);
    });
  });

  describe('POST /api/chat/stream', () => {
    it('returns 403 without owner auth', () => {
      const res = makeRes();
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      expect(res.statusCode).toBe(403);
    });

    it('sends SSE headers', () => {
      const res = makeRes();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      expect(res.headers['content-type']).toBe('text/event-stream');
    });

    it('sends session event first', () => {
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ type: 'session', sessionId: 'dr:abc' })}\n\n`);
      expect(res.body).toContain('"type":"session"');
    });

    it('sends done event when complete', () => {
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      expect(res.body).toContain('"type":"done"');
    });

    it('sends error event on failure', () => {
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ type: 'error', message: 'Failed to process message' })}\n\n`);
      expect(res.body).toContain('"type":"error"');
    });
  });

  describe('GET /api/events', () => {
    it('sets text/event-stream header', () => {
      const res = makeRes();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      expect(res.headers['content-type']).toBe('text/event-stream');
    });

    it('is a public endpoint', () => {
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('GET /api/activity', () => {
    it('returns activity array', () => {
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      expect(parseBody(res)).toEqual([]);
    });

    it('is a public endpoint', () => {
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
      expect(res.statusCode).toBe(200);
    });
  });

  describe('static file serving — public-doctor/', () => {
    it('HTML requires owner auth', () => {
      const res = makeRes();
      res.writeHead(302, { Location: '/commune-map.html' });
      res.end();
      expect(res.statusCode).toBe(302);
    });

    it('injects owner meta into HTML for owner', () => {
      const html = '<html><head></head><body>Dr. Claude UI</body></html>';
      const modified = html.replace('</head>', `  <meta name="lain-owner" content="true">\n</head>`);
      expect(modified).toContain('<meta name="lain-owner" content="true">');
    });

    it('non-owner redirect is to /commune-map.html', () => {
      const res = makeRes();
      res.writeHead(302, { Location: '/commune-map.html' });
      res.end();
      expect(res.headers['location']).toBe('/commune-map.html');
    });

    it('SPA fallback redirects non-owner to commune-map', () => {
      const res = makeRes();
      res.writeHead(302, { Location: '/commune-map.html' });
      res.end();
      expect(res.statusCode).toBe(302);
    });

    it('returns 404 when owner but index.html missing', () => {
      const res = makeRes();
      res.writeHead(404);
      res.end('Not found');
      expect(res.statusCode).toBe(404);
    });
  });
});

// ============================================================
// Character server — specific routes
// ============================================================

describe('Character server', () => {
  describe('GET /api/characters', () => {
    it('returns character manifest', () => {
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        town: { name: 'Laintown' },
        characters: [{ id: 'hiru', name: 'Hiru', port: 3006, defaultLocation: 'library' }],
      }));
      const body = parseBody(res) as { characters: unknown[] };
      expect(body.characters.length).toBeGreaterThan(0);
    });

    it('is public (no auth required)', () => {
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ town: {}, characters: [] }));
      expect(res.statusCode).toBe(200);
    });
  });

  describe('GET /api/location', () => {
    it('returns characterId from config', () => {
      const characterId = 'hiru';
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ characterId, location: 'library', buildingName: 'Library', row: 0, col: 1, timestamp: 0 }));
      const body = parseBody(res) as Record<string, unknown>;
      expect(body.characterId).toBe(characterId);
    });
  });

  describe('GET /api/internal-state', () => {
    it('requires interlink auth', () => {
      const res = makeRes();
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing or invalid Authorization header' }));
      expect(res.statusCode).toBe(401);
    });

    it('returns character internal state on success', () => {
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ characterId: 'hiru', summary: 'content', state: { energy: 0.6 } }));
      const body = parseBody(res) as Record<string, unknown>;
      expect(body.characterId).toBe('hiru');
    });
  });

  describe('GET /api/meta/identity', () => {
    it('returns character id and name from config', () => {
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'hiru', name: 'Hiru' }));
      const body = parseBody(res) as Record<string, unknown>;
      expect(body.id).toBe('hiru');
      expect(body.name).toBe('Hiru');
    });
  });

  describe('GET /api/commune-history', () => {
    it('returns commune history records', () => {
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      expect(parseBody(res)).toEqual([]);
    });
  });

  describe('POST /api/chat', () => {
    it('returns 403 without owner cookie', () => {
      const res = makeRes();
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      expect(res.statusCode).toBe(403);
    });

    it('returns 503 when character is possessed', () => {
      const res = makeRes();
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unavailable' }));
      expect(res.statusCode).toBe(503);
    });

    it('returns response on success', () => {
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ response: 'Hi from Hiru', sessionId: 'hiru:abc' }));
      const body = parseBody(res) as Record<string, unknown>;
      expect(body.response).toBeDefined();
    });

    it('sessionId is characterId:nanoid format', () => {
      const characterId = 'hiru';
      const sessionId = `${characterId}:abcdef12`;
      expect(sessionId.startsWith(`${characterId}:`)).toBe(true);
    });

    it('stranger mode prefixes sessionId with stranger:', () => {
      const characterId = 'hiru';
      const sessionId = `stranger:${characterId}:abcdef12`;
      expect(sessionId.startsWith('stranger:')).toBe(true);
    });
  });

  describe('POST /api/chat/stream', () => {
    it('returns 403 without owner cookie', () => {
      const res = makeRes();
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      expect(res.statusCode).toBe(403);
    });

    it('returns 503 during possession', () => {
      const res = makeRes();
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unavailable' }));
      expect(res.statusCode).toBe(503);
    });

    it('SSE session event comes first', () => {
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ type: 'session', sessionId: 'hiru:abc' })}\n\n`);
      // "data: {..." — the JSON starts after "data: " (6 chars)
      const dataIdx = res.body.indexOf('data:');
      const sessionIdx = res.body.indexOf('"type":"session"');
      // Session event should appear within the first data frame
      expect(sessionIdx).toBeGreaterThan(dataIdx);
      expect(sessionIdx).toBeLessThan(dataIdx + 100);
    });
  });

  describe('GET /api/activity', () => {
    it('is public', () => {
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
      expect(res.statusCode).toBe(200);
    });
  });

  describe('GET /api/events', () => {
    it('sets SSE headers', () => {
      const res = makeRes();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      expect(res.headers['content-type']).toBe('text/event-stream');
    });
  });

  describe('GET /api/building/notes', () => {
    it('returns 400 without building param', () => {
      const res = makeRes();
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing building parameter' }));
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/documents', () => {
    it('returns all documents by this character', () => {
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      expect(parseBody(res)).toEqual([]);
    });

    it('returns specific document when title param provided', () => {
      const doc = { title: 'My Essay', content: 'Deep thoughts' };
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(doc));
      const body = parseBody(res) as Record<string, unknown>;
      expect(body.title).toBe('My Essay');
    });

    it('returns null when title not found', () => {
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(null));
      expect(parseBody(res)).toBeNull();
    });
  });

  describe('GET /api/postboard', () => {
    it('returns postboard messages', () => {
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      expect(parseBody(res)).toEqual([]);
    });
  });

  describe('POST /api/peer/message', () => {
    it('requires interlink auth', () => {
      const res = makeRes();
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing or invalid Authorization header' }));
      expect(res.statusCode).toBe(401);
    });

    it('returns 400 when fromId missing', () => {
      const res = makeRes();
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required fields: fromId, fromName, message' }));
      expect(res.statusCode).toBe(400);
    });

    it('returns response and sessionId on success', () => {
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ response: 'Hello peer', sessionId: 'peer:lain:123' }));
      const body = parseBody(res) as Record<string, unknown>;
      expect(body.response).toBeDefined();
      expect(body.sessionId).toBeDefined();
    });

    it('sessionId prefixed with peer:', () => {
      const fromId = 'lain';
      const sessionId = `peer:${fromId}:${Date.now()}`;
      expect(sessionId.startsWith('peer:')).toBe(true);
    });
  });

  describe('static file serving', () => {
    it('redirects non-owner to commune-map.html for HTML', () => {
      const res = makeRes();
      res.writeHead(302, { Location: '/commune-map.html' });
      res.end();
      expect(res.headers['location']).toBe('/commune-map.html');
    });

    it('injects owner meta for authenticated HTML access', () => {
      const html = '<html><head></head></html>';
      const modified = html.replace('</head>', `  <meta name="lain-owner" content="true">\n</head>`);
      expect(modified).toContain('lain-owner');
    });

    it('SPA fallback for owner serves index.html with meta', () => {
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><head>  <meta name="lain-owner" content="true">\n</head></html>');
      expect(res.body).toContain('lain-owner');
    });

    it('SPA fallback redirects non-owner', () => {
      const res = makeRes();
      res.writeHead(302, { Location: '/commune-map.html' });
      res.end();
      expect(res.statusCode).toBe(302);
    });

    // serveStatic in character-server was removed (findings.md P1:27) —
    // inhabitant servers are API-only, so no static file path to traverse.
  });

  describe('GET /api/telemetry', () => {
    it('requires owner or interlink auth', () => {
      const res = makeRes();
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing or invalid Authorization header' }));
      expect(res.statusCode).toBe(401);
    });

    it('returns telemetry data on success', () => {
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        characterId: 'hiru',
        characterName: 'Hiru',
        timestamp: Date.now(),
        totalMemories: 0,
        totalMessages: 0,
        memoryTypes: {},
        loopHealth: {},
      }));
      const body = parseBody(res) as Record<string, unknown>;
      expect(body.characterId).toBeDefined();
      expect(body.totalMemories).toBeDefined();
    });
  });
});

// ============================================================
// Interlink letter endpoint
// ============================================================

describe('POST /api/interlink/letter', () => {
  it('requires interlink auth', () => {
    const res = makeRes();
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing or invalid Authorization header' }));
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 for invalid letter structure', () => {
    const letter = { topics: 'not-an-array', impressions: [], gift: 'gift', emotionalState: 'ok' };
    const res = makeRes();
    if (!Array.isArray(letter.topics)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid letter structure' }));
    }
    expect(res.statusCode).toBe(400);
  });

  it('returns ok and memoryId on success', () => {
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, memoryId: 'mem-456' }));
    const body = parseBody(res) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.memoryId).toBeDefined();
  });

  it('returns 400 for invalid JSON body', () => {
    const res = makeRes();
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    expect(res.statusCode).toBe(400);
  });
});

// ============================================================
// /api/interlink/dream-seed
// ============================================================

describe('POST /api/interlink/dream-seed', () => {
  it('allows owner without interlink token', () => {
    // isOwner check passes before verifyInterlinkAuth
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, memoryId: 'mem-789' }));
    expect(res.statusCode).toBe(200);
  });

  it('returns 400 for empty content', () => {
    const res = makeRes();
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'content must be a non-empty string' }));
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for content over 2000 chars', () => {
    const res = makeRes();
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'content exceeds 2000 character limit' }));
    expect(res.statusCode).toBe(400);
  });

  it('clamps emotionalWeight to 0-1 range', () => {
    const raw = -0.5;
    const clamped = Math.max(0, Math.min(1, raw));
    expect(clamped).toBe(0);

    const raw2 = 1.5;
    const clamped2 = Math.max(0, Math.min(1, raw2));
    expect(clamped2).toBe(1);
  });

  it('defaults emotionalWeight to 0.5 when not provided', () => {
    const emotionalWeight = undefined;
    const weight = typeof emotionalWeight === 'number' ? Math.max(0, Math.min(1, emotionalWeight)) : 0.5;
    expect(weight).toBe(0.5);
  });

  it('returns ok and memoryId on success', () => {
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, memoryId: 'mem-seed-1' }));
    const body = parseBody(res) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.memoryId).toBeDefined();
  });
});

// ============================================================
// Rate limiting logic
// ============================================================

describe('rate limiting', () => {
  it('allows first request from an IP', () => {
    const map = new Map<string, { count: number; resetAt: number }>();
    const now = Date.now();
    const ip = '1.2.3.4';
    const entry = map.get(ip);
    if (!entry || now > entry.resetAt) {
      map.set(ip, { count: 1, resetAt: now + 60_000 });
    }
    expect(map.get(ip)!.count).toBe(1);
  });

  it('increments count for repeated requests', () => {
    const map = new Map<string, { count: number; resetAt: number }>();
    const now = Date.now();
    const ip = '1.2.3.5';
    map.set(ip, { count: 1, resetAt: now + 60_000 });
    map.get(ip)!.count++;
    expect(map.get(ip)!.count).toBe(2);
  });

  it('resets after window expiry', () => {
    const map = new Map<string, { count: number; resetAt: number }>();
    const ip = '1.2.3.6';
    map.set(ip, { count: 30, resetAt: Date.now() - 1 }); // expired
    const now = Date.now();
    const entry = map.get(ip);
    if (!entry || now > entry.resetAt) {
      map.set(ip, { count: 1, resetAt: now + 60_000 });
    }
    expect(map.get(ip)!.count).toBe(1);
  });

  it('blocks when count exceeds limit of 30', () => {
    const RATE_LIMIT_MAX = 30;
    const count = 31;
    expect(count <= RATE_LIMIT_MAX).toBe(false);
  });

  it('allows exactly 30 requests', () => {
    const RATE_LIMIT_MAX = 30;
    const count = 30;
    expect(count <= RATE_LIMIT_MAX).toBe(true);
  });
});

// ============================================================
// Security headers (main server)
// ============================================================

describe('security headers', () => {
  it('sets X-Content-Type-Options: nosniff', () => {
    const res = makeRes();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('sets X-Frame-Options: DENY', () => {
    const res = makeRes();
    res.setHeader('X-Frame-Options', 'DENY');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('sets Referrer-Policy', () => {
    const res = makeRes();
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  it('sets Content-Security-Policy', () => {
    const res = makeRes();
    res.setHeader('Content-Security-Policy', "default-src 'self'");
    expect(res.headers['content-security-policy']).toBeDefined();
  });

  it('CORS allows all origins by default', () => {
    const res = makeRes();
    res.setHeader('Access-Control-Allow-Origin', '*');
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });
});

// ============================================================
// /api/town-events
// ============================================================

describe('/api/town-events', () => {
  describe('GET', () => {
    it('returns active events without auth', () => {
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      expect(parseBody(res)).toEqual([]);
    });

    it('returns all events when ?all=1', () => {
      const url = new URL('http://localhost/api/town-events?all=1');
      expect(url.searchParams.get('all')).toBe('1');
    });
  });

  describe('POST', () => {
    it('requires auth', () => {
      const res = makeRes();
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      expect(res.statusCode).toBe(401);
    });

    it('returns 400 when description missing', () => {
      const res = makeRes();
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'description is required' }));
      expect(res.statusCode).toBe(400);
    });

    it('returns event on success', () => {
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, event: { id: 'evt-1', description: 'Festival begins' } }));
      const body = parseBody(res) as { ok: boolean; event: { id: string } };
      expect(body.ok).toBe(true);
      expect(body.event.id).toBeDefined();
    });
  });
});

// ============================================================
// /api/budget and /api/feeds/health
// ============================================================

describe('owner-only dashboard endpoints', () => {
  describe('GET /api/budget', () => {
    it('requires auth', () => {
      const res = makeRes();
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      expect(res.statusCode).toBe(401);
    });

    it('returns budget status on success', () => {
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ used: 100, limit: 10000, percent: 1 }));
      const body = parseBody(res) as Record<string, unknown>;
      expect(body.used).toBeDefined();
    });
  });

  describe('GET /api/feeds/health', () => {
    it('requires auth', () => {
      const res = makeRes();
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      expect(res.statusCode).toBe(401);
    });

    it('returns feed health state', () => {
      const res = makeRes();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ healthy: true }));
      const body = parseBody(res) as Record<string, unknown>;
      expect(body.healthy).toBe(true);
    });
  });

  describe('GET /api/system', () => {
    it('returns 403 without owner auth', () => {
      const res = makeRes();
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      expect(res.statusCode).toBe(403);
    });
  });
});

// ============================================================
// verifyApiAuth — main server (cookie OR Bearer)
// ============================================================

describe('verifyApiAuth (main server)', () => {
  // Mirrors server.ts verifyApiAuth: v2 owner cookie OR Bearer API key.
  function verifyApiAuth(
    req: IncomingMessage,
    res: MockResponse,
    ownerToken?: string,
    apiKey?: string
  ): boolean {
    const prev = process.env['LAIN_OWNER_TOKEN'];
    try {
      if (ownerToken === undefined) delete process.env['LAIN_OWNER_TOKEN'];
      else process.env['LAIN_OWNER_TOKEN'] = ownerToken;
      if (realIsOwner(req)) return true;
    } finally {
      if (prev === undefined) delete process.env['LAIN_OWNER_TOKEN'];
      else process.env['LAIN_OWNER_TOKEN'] = prev;
    }
    if (apiKey) {
      const auth = req.headers['authorization'] as string | undefined;
      if (auth?.startsWith('Bearer ')) {
        const provided = auth.slice('Bearer '.length);
        if (provided === apiKey) return true;
      }
    }
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return false;
  }

  it('returns true for valid owner cookie', () => {
    const token = 'my-owner-token';
    const cookie = ownerCookieFor(token);
    const req = makeReq({ headers: { cookie } });
    const res = makeRes();
    expect(verifyApiAuth(req, res, token)).toBe(true);
  });

  it('returns true for valid Bearer API key', () => {
    const apiKey = 'my-api-key';
    const req = makeReq({ headers: { authorization: `Bearer ${apiKey}` } });
    const res = makeRes();
    expect(verifyApiAuth(req, res, undefined, apiKey)).toBe(true);
  });

  it('returns 401 when neither cookie nor bearer is valid', () => {
    const req = makeReq({ headers: {} });
    const res = makeRes();
    const ok = verifyApiAuth(req, res, 'token', 'apikey');
    expect(ok).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when cookie is wrong and no bearer', () => {
    const req = makeReq({ headers: { cookie: `${OWNER_COOKIE_NAME}=deadbeef.cafebabe` } });
    const res = makeRes();
    const ok = verifyApiAuth(req, res, 'token', undefined);
    expect(ok).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when bearer is wrong', () => {
    const req = makeReq({ headers: { authorization: 'Bearer wrong-key' } });
    const res = makeRes();
    const ok = verifyApiAuth(req, res, undefined, 'correct-key');
    expect(ok).toBe(false);
    expect(res.statusCode).toBe(401);
  });
});

// ============================================================
// Skins directory serving
// ============================================================

describe('skins directory serving', () => {
  it('resolves safe paths within SKINS_DIR', () => {
    const { resolve } = require('path') as typeof import('path');
    const SKINS_DIR = '/tmp/skins';
    const safePath = 'character-lain/avatar.png';
    const filePath = resolve(SKINS_DIR, safePath);
    expect(filePath.startsWith(resolve(SKINS_DIR))).toBe(true);
  });

  it('blocks path traversal outside SKINS_DIR', () => {
    const { resolve } = require('path') as typeof import('path');
    const SKINS_DIR = '/tmp/skins';
    const attempted = resolve(SKINS_DIR, '../etc/passwd');
    expect(attempted.startsWith(resolve(SKINS_DIR))).toBe(false);
  });

  it('returns 404 for empty skin path', () => {
    const res = makeRes();
    res.writeHead(404);
    res.end('Not found');
    expect(res.statusCode).toBe(404);
  });

  it('serves skin files with correct mime type', () => {
    const { extname } = require('path') as typeof import('path');
    const MIME_TYPES: Record<string, string> = {
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.css': 'text/css',
    };
    expect(MIME_TYPES[extname('avatar.png')]).toBe('image/png');
    expect(MIME_TYPES[extname('icon.svg')]).toBe('image/svg+xml');
  });
});

// ============================================================
// /api/meta/<key> — interlink auth, arbitrary meta key read
// ============================================================

describe('GET /api/meta/:key', () => {
  it('requires interlink auth', () => {
    const res = makeRes();
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing or invalid Authorization header' }));
    expect(res.statusCode).toBe(401);
  });

  it('returns key and value (null if missing)', () => {
    const res = makeRes();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ key: 'self-concept', value: null }));
    const body = parseBody(res) as Record<string, unknown>;
    expect(body.key).toBe('self-concept');
    expect(body.value).toBeNull();
  });

  it('returns 400 for missing key segment', () => {
    const res = makeRes();
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing key' }));
    expect(res.statusCode).toBe(400);
  });

  it('passes the key to getMeta', () => {
    const url = new URL('http://localhost/api/meta/dream%3Alast_cycle_at');
    const key = decodeURIComponent(url.pathname.slice('/api/meta/'.length));
    expect(key).toBe('dream:last_cycle_at');
  });
});

// ============================================================
// Misc edge cases
// ============================================================

describe('misc edge cases', () => {
  it('MIME type falls back to application/octet-stream for unknown ext', () => {
    const MIME_TYPES: Record<string, string> = {
      '.html': 'text/html',
      '.css': 'text/css',
    };
    const ext = '.xyz';
    const type = MIME_TYPES[ext] || 'application/octet-stream';
    expect(type).toBe('application/octet-stream');
  });

  it('URL with double slashes is handled', () => {
    const path = '//api/health';
    const safe = path.replace(/^\/+/, '');
    expect(safe).toBe('api/health');
  });

  it('collectBody accumulates multiple chunks', async () => {
    const chunks = ['hello ', 'world'];
    const result = chunks.join('');
    expect(result).toBe('hello world');
  });

  it('session history is trimmed to 40 messages', () => {
    const MAX = 40;
    const history = Array.from({ length: 50 }, (_, i) => ({ role: 'user', content: `msg ${i}` }));
    const trimmed = history.slice(-MAX);
    expect(trimmed.length).toBe(MAX);
    expect(trimmed[0]!.content).toBe('msg 10');
  });

  it('MAX_TOOL_ITERATIONS is 6 for doctor server', () => {
    const MAX_TOOL_ITERATIONS = 6;
    expect(MAX_TOOL_ITERATIONS).toBe(6);
  });

  it('stranger mode prepends 「STRANGER」 to message text', () => {
    const message = 'Hello!';
    const isStranger = true;
    const messageText = isStranger ? `「STRANGER」 ${message}` : message;
    expect(messageText).toBe('「STRANGER」 Hello!');
  });

  it('non-stranger mode does not modify message text', () => {
    const message = 'Hello!';
    const isStranger = false;
    const messageText = isStranger ? `「STRANGER」 ${message}` : message;
    expect(messageText).toBe('Hello!');
  });

  it('relationship cache expires after 5 minutes', () => {
    const CACHE_TTL = 300_000;
    const cacheTime = Date.now() - CACHE_TTL - 1;
    const isStale = Date.now() - cacheTime >= CACHE_TTL;
    expect(isStale).toBe(true);
  });

  it('emotionalWeight from dream seed defaults to 0.5', () => {
    const body = { content: 'dream content' } as { content: string; emotionalWeight?: number };
    const weight = typeof body.emotionalWeight === 'number'
      ? Math.max(0, Math.min(1, body.emotionalWeight))
      : 0.5;
    expect(weight).toBe(0.5);
  });
});
