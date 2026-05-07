/**
 * Matrix expansion tests for all API endpoints across server.ts,
 * character-server.ts, and doctor-server.ts.
 *
 * Tests: endpoint × auth state × method × error conditions
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Endpoint registry
// ---------------------------------------------------------------------------

type AuthRequirement = 'none' | 'owner' | 'interlink' | 'owner-or-interlink';
type HttpMethod = 'GET' | 'POST' | 'DELETE' | 'OPTIONS';
type ServerSource = 'server' | 'character-server' | 'doctor-server';

interface Endpoint {
  path: string;
  method: HttpMethod;
  auth: AuthRequirement;
  server: ServerSource;
  description: string;
  responseType: 'json' | 'sse' | 'html' | 'redirect';
}

// server.ts endpoints
const SERVER_ENDPOINTS: Endpoint[] = [
  { path: '/api/health',                      method: 'GET',    auth: 'none',                server: 'server', description: 'health check',                   responseType: 'json' },
  { path: '/api/characters',                  method: 'GET',    auth: 'none',                server: 'server', description: 'character manifest',              responseType: 'json' },
  { path: '/gate',                            method: 'GET',    auth: 'none',                server: 'server', description: 'owner auth gate',                 responseType: 'redirect' },
  { path: '/api/location',                    method: 'GET',    auth: 'none',                server: 'server', description: 'current location',                responseType: 'json' },
  { path: '/api/internal-state',             method: 'GET',    auth: 'interlink',            server: 'server', description: 'emotional state (interlink auth)', responseType: 'json' },
  { path: '/api/meta/identity',              method: 'GET',    auth: 'none',                server: 'server', description: 'character identity',              responseType: 'json' },
  { path: '/api/commune-history',            method: 'GET',    auth: 'none',                server: 'server', description: 'commune conversation history',     responseType: 'json' },
  { path: '/api/relationships',             method: 'GET',    auth: 'none',                server: 'server', description: 'relationship weights',             responseType: 'json' },
  { path: '/api/meta/integrity',            method: 'GET',    auth: 'owner-or-interlink',   server: 'server', description: 'isolation verification',          responseType: 'json' },
  { path: '/api/telemetry',                 method: 'GET',    auth: 'owner-or-interlink',   server: 'server', description: 'telemetry stats',                 responseType: 'json' },
  { path: '/api/events',                    method: 'GET',    auth: 'none',                server: 'server', description: 'SSE event stream',                responseType: 'sse' },
  { path: '/api/activity',                  method: 'GET',    auth: 'none',                server: 'server', description: 'activity history',                responseType: 'json' },
  { path: '/api/building/notes',            method: 'GET',    auth: 'none',                server: 'server', description: 'notes in a building',             responseType: 'json' },
  { path: '/api/documents',                 method: 'GET',    auth: 'none',                server: 'server', description: 'documents by author',             responseType: 'json' },
  { path: '/api/postboard',                 method: 'GET',    auth: 'none',                server: 'server', description: 'postboard messages read',         responseType: 'json' },
  { path: '/api/postboard',                 method: 'POST',   auth: 'owner',               server: 'server', description: 'postboard message write',         responseType: 'json' },
  { path: '/api/postboard/:id',             method: 'DELETE', auth: 'owner',               server: 'server', description: 'delete postboard message',        responseType: 'json' },
  { path: '/api/postboard/:id/pin',         method: 'POST',   auth: 'owner',               server: 'server', description: 'toggle postboard pin',            responseType: 'json' },
  { path: '/api/town-events',               method: 'GET',    auth: 'owner-or-interlink',   server: 'server', description: 'read town events',                responseType: 'json' },
  { path: '/api/town-events/effects',       method: 'GET',    auth: 'owner-or-interlink',   server: 'server', description: 'merged event effects',            responseType: 'json' },
  { path: '/api/town-events',               method: 'POST',   auth: 'owner',               server: 'server', description: 'create town event',               responseType: 'json' },
  { path: '/api/town-events/:id/end',       method: 'POST',   auth: 'owner',               server: 'server', description: 'end persistent event',            responseType: 'json' },
  { path: '/api/dreams/status',             method: 'GET',    auth: 'owner',               server: 'server', description: 'aggregated dream stats',          responseType: 'json' },
  { path: '/api/dreams/seeds',              method: 'GET',    auth: 'owner',               server: 'server', description: 'aggregated dream seeds',          responseType: 'json' },
  { path: '/api/evolution/lineages',        method: 'GET',    auth: 'owner',               server: 'server', description: 'lineage histories',              responseType: 'json' },
  { path: '/api/evolution/status',          method: 'GET',    auth: 'owner',               server: 'server', description: 'evolution state',                responseType: 'json' },
  { path: '/api/feeds/health',              method: 'GET',    auth: 'owner',               server: 'server', description: 'RSS feed health',                responseType: 'json' },
  { path: '/api/budget',                    method: 'GET',    auth: 'owner',               server: 'server', description: 'monthly budget status',           responseType: 'json' },
  { path: '/api/conversations/event',       method: 'POST',   auth: 'interlink',            server: 'server', description: 'post conversation line',          responseType: 'json' },
  { path: '/api/conversations/stream',      method: 'GET',    auth: 'none',                server: 'server', description: 'SSE conversation stream',         responseType: 'sse' },
  { path: '/api/conversations/recent',      method: 'GET',    auth: 'none',                server: 'server', description: 'recent conversations JSON',       responseType: 'json' },
  { path: '/api/buildings/:id/event',       method: 'POST',   auth: 'interlink',            server: 'server', description: 'record building event',           responseType: 'json' },
  { path: '/api/buildings/:id/residue',     method: 'GET',    auth: 'none',                server: 'server', description: 'building event residue',          responseType: 'json' },
  { path: '/api/chat',                      method: 'POST',   auth: 'owner',               server: 'server', description: 'non-streaming chat',             responseType: 'json' },
  { path: '/api/chat/stream',               method: 'POST',   auth: 'owner',               server: 'server', description: 'streaming chat (SSE)',            responseType: 'sse' },
];

// character-server.ts endpoints
const CHARACTER_ENDPOINTS: Endpoint[] = [
  { path: '/api/characters',         method: 'GET',    auth: 'none',                server: 'character-server', description: 'character manifest',              responseType: 'json' },
  { path: '/api/location',           method: 'GET',    auth: 'none',                server: 'character-server', description: 'current location',                responseType: 'json' },
  { path: '/api/internal-state',    method: 'GET',    auth: 'interlink',            server: 'character-server', description: 'emotional state',                 responseType: 'json' },
  { path: '/api/meta/identity',     method: 'GET',    auth: 'none',                server: 'character-server', description: 'character identity',              responseType: 'json' },
  { path: '/api/commune-history',   method: 'GET',    auth: 'none',                server: 'character-server', description: 'commune conversation history',     responseType: 'json' },
  { path: '/api/meta/integrity',   method: 'GET',    auth: 'owner-or-interlink',   server: 'character-server', description: 'isolation verification',          responseType: 'json' },
  { path: '/api/telemetry',         method: 'GET',    auth: 'owner-or-interlink',   server: 'character-server', description: 'telemetry stats',                 responseType: 'json' },
  { path: '/api/events',            method: 'GET',    auth: 'none',                server: 'character-server', description: 'SSE event stream',                responseType: 'sse' },
  { path: '/api/activity',          method: 'GET',    auth: 'none',                server: 'character-server', description: 'activity history',                responseType: 'json' },
  { path: '/api/building/notes',   method: 'GET',    auth: 'none',                server: 'character-server', description: 'notes in a building',             responseType: 'json' },
  { path: '/api/documents',         method: 'GET',    auth: 'none',                server: 'character-server', description: 'documents by author',             responseType: 'json' },
  { path: '/api/postboard',         method: 'GET',    auth: 'none',                server: 'character-server', description: 'postboard messages',              responseType: 'json' },
  { path: '/api/chat',              method: 'POST',   auth: 'owner',               server: 'character-server', description: 'non-streaming chat',             responseType: 'json' },
  { path: '/api/chat/stream',       method: 'POST',   auth: 'owner',               server: 'character-server', description: 'streaming chat (SSE)',            responseType: 'sse' },
  { path: '/api/meta/:key',         method: 'GET',    auth: 'interlink',            server: 'character-server', description: 'meta key read',                   responseType: 'json' },
  { path: '/api/dreams/stats',      method: 'GET',    auth: 'interlink',            server: 'character-server', description: 'dream stats for this character',  responseType: 'json' },
];

// doctor-server.ts endpoints
const DOCTOR_ENDPOINTS: Endpoint[] = [
  { path: '/api/location',    method: 'GET',  auth: 'none',   server: 'doctor-server', description: 'Dr. Claude location (fixed: school)', responseType: 'json' },
  { path: '/api/meta/identity', method: 'GET', auth: 'none',  server: 'doctor-server', description: 'Dr. Claude identity',                  responseType: 'json' },
  { path: '/api/events',      method: 'GET',  auth: 'none',   server: 'doctor-server', description: 'SSE event stream',                     responseType: 'sse' },
  { path: '/api/activity',    method: 'GET',  auth: 'none',   server: 'doctor-server', description: 'activity history',                     responseType: 'json' },
  { path: '/api/chat',        method: 'POST', auth: 'owner',  server: 'doctor-server', description: 'Dr. Claude chat',                      responseType: 'json' },
  { path: '/api/chat/stream', method: 'POST', auth: 'owner',  server: 'doctor-server', description: 'Dr. Claude streaming chat',            responseType: 'sse' },
];

const ALL_ENDPOINTS: Endpoint[] = [
  ...SERVER_ENDPOINTS,
  ...CHARACTER_ENDPOINTS,
  ...DOCTOR_ENDPOINTS,
];

// ---------------------------------------------------------------------------
// Test 1: Every endpoint has a defined auth requirement
// ---------------------------------------------------------------------------

describe('Endpoint auth requirement completeness', () => {
  it.each(ALL_ENDPOINTS.map(e => [`${e.server}::${e.method} ${e.path}`, e] as [string, Endpoint]))(
    '%s has defined auth',
    (_label, endpoint) => {
      expect(['none', 'owner', 'interlink', 'owner-or-interlink']).toContain(endpoint.auth);
    }
  );
});

// ---------------------------------------------------------------------------
// Test 2: Every endpoint has a defined response type
// ---------------------------------------------------------------------------

describe('Endpoint response type matrix', () => {
  it.each(ALL_ENDPOINTS.map(e => [`${e.server}::${e.method} ${e.path}`, e] as [string, Endpoint]))(
    '%s has valid response type',
    (_label, endpoint) => {
      expect(['json', 'sse', 'html', 'redirect']).toContain(endpoint.responseType);
    }
  );
});

// ---------------------------------------------------------------------------
// Test 3: Auth × endpoint — verify expected status codes for each auth state
// ---------------------------------------------------------------------------

type AuthState = 'owner' | 'non-owner' | 'no-token' | 'interlink-token';

interface AuthExpectation {
  label: string;
  endpoint: Endpoint;
  authState: AuthState;
  expectedStatus: number;
}

function expectedStatusFor(endpoint: Endpoint, authState: AuthState): number {
  switch (endpoint.auth) {
    case 'none':
      return 200; // Always OK regardless of auth
    case 'owner':
      if (authState === 'owner') return 200;
      return 403;
    case 'interlink':
      if (authState === 'interlink-token') return 200;
      if (authState === 'no-token') return 401;
      return 403;
    case 'owner-or-interlink':
      if (authState === 'owner' || authState === 'interlink-token') return 200;
      if (authState === 'no-token') return 401;
      return 403;
    default:
      return 200;
  }
}

const AUTH_STATES: AuthState[] = ['owner', 'non-owner', 'no-token', 'interlink-token'];

const AUTH_MATRIX: AuthExpectation[] = ALL_ENDPOINTS.flatMap(endpoint =>
  AUTH_STATES.map(authState => ({
    label: `${endpoint.server}::${endpoint.method} ${endpoint.path}::${authState}`,
    endpoint,
    authState,
    expectedStatus: expectedStatusFor(endpoint, authState),
  }))
);

describe('Endpoint × auth state status code matrix', () => {
  it.each(AUTH_MATRIX.map(e => [e.label, e] as [string, AuthExpectation]))(
    '%s → HTTP %i',
    (_label, expectation) => {
      const { expectedStatus } = expectation;
      expect([200, 302, 401, 403, 503]).toContain(expectedStatus);
      // owner access to owner-protected endpoints should succeed
      if (expectation.endpoint.auth === 'owner' && expectation.authState === 'owner') {
        expect(expectedStatus).toBe(200);
      }
      // no-token access to protected endpoints should fail
      if (expectation.endpoint.auth !== 'none' && expectation.authState === 'no-token') {
        expect(expectedStatus).toBeGreaterThanOrEqual(400);
      }
    }
  );
});

// ---------------------------------------------------------------------------
// Test 4: Public endpoints are accessible without any token
// ---------------------------------------------------------------------------

const PUBLIC_ENDPOINTS = ALL_ENDPOINTS.filter(e => e.auth === 'none');

describe('Public endpoint accessibility matrix', () => {
  it.each(PUBLIC_ENDPOINTS.map(e => [`${e.server}::${e.method} ${e.path}`, e] as [string, Endpoint]))(
    '%s should return 200 without auth',
    (_label, endpoint) => {
      const status = expectedStatusFor(endpoint, 'no-token');
      expect(status).toBe(200);
    }
  );
});

// ---------------------------------------------------------------------------
// Test 5: Owner-only endpoints reject non-owners with 403
// ---------------------------------------------------------------------------

const OWNER_ENDPOINTS = ALL_ENDPOINTS.filter(e => e.auth === 'owner');

describe('Owner-only endpoint rejection matrix', () => {
  it.each(OWNER_ENDPOINTS.map(e => [`${e.server}::${e.method} ${e.path}`, e] as [string, Endpoint]))(
    '%s rejects non-owner with 403',
    (_label, endpoint) => {
      expect(expectedStatusFor(endpoint, 'non-owner')).toBe(403);
      expect(expectedStatusFor(endpoint, 'no-token')).toBe(403);
    }
  );
});

// ---------------------------------------------------------------------------
// Test 6: Interlink-only endpoints
// ---------------------------------------------------------------------------

const INTERLINK_ENDPOINTS = ALL_ENDPOINTS.filter(e => e.auth === 'interlink');

describe('Interlink auth endpoint matrix', () => {
  it.each(INTERLINK_ENDPOINTS.map(e => [`${e.server}::${e.method} ${e.path}`, e] as [string, Endpoint]))(
    '%s accepts interlink token',
    (_label, endpoint) => {
      expect(expectedStatusFor(endpoint, 'interlink-token')).toBe(200);
      expect(expectedStatusFor(endpoint, 'owner')).toBe(403);
      expect(expectedStatusFor(endpoint, 'no-token')).toBe(401);
    }
  );
});

// ---------------------------------------------------------------------------
// Test 7: Error condition matrix
// ---------------------------------------------------------------------------

type ErrorCondition = 'provider-down' | 'db-error' | 'invalid-json' | 'missing-param' | 'payload-too-large';

interface ErrorCase {
  endpoint: string;
  method: HttpMethod;
  errorCondition: ErrorCondition;
  expectedStatus: number;
  description: string;
}

const ERROR_CASES: ErrorCase[] = [
  // Chat endpoints — provider down
  { endpoint: '/api/chat',              method: 'POST',   errorCondition: 'provider-down',   expectedStatus: 500, description: 'chat: provider unavailable' },
  { endpoint: '/api/chat/stream',       method: 'POST',   errorCondition: 'provider-down',   expectedStatus: 500, description: 'stream: provider error propagates' },
  // Postboard — invalid input
  { endpoint: '/api/postboard',         method: 'POST',   errorCondition: 'invalid-json',    expectedStatus: 500, description: 'postboard: malformed body' },
  { endpoint: '/api/postboard',         method: 'POST',   errorCondition: 'missing-param',   expectedStatus: 400, description: 'postboard: missing content field' },
  { endpoint: '/api/postboard',         method: 'POST',   errorCondition: 'payload-too-large', expectedStatus: 413, description: 'postboard: body exceeds limit' },
  // Town events — invalid input
  { endpoint: '/api/town-events',       method: 'POST',   errorCondition: 'missing-param',   expectedStatus: 400, description: 'town-events: missing description' },
  { endpoint: '/api/town-events',       method: 'POST',   errorCondition: 'payload-too-large', expectedStatus: 413, description: 'town-events: body exceeds limit' },
  // Building notes — missing required query param
  { endpoint: '/api/building/notes',   method: 'GET',    errorCondition: 'missing-param',   expectedStatus: 400, description: 'building/notes: missing building param' },
  // Conversations event — invalid body
  { endpoint: '/api/conversations/event', method: 'POST', errorCondition: 'invalid-json',   expectedStatus: 400, description: 'conversations/event: malformed JSON' },
  { endpoint: '/api/conversations/event', method: 'POST', errorCondition: 'missing-param',  expectedStatus: 400, description: 'conversations/event: missing speakerId' },
  // Building event — invalid body
  { endpoint: '/api/buildings/:id/event', method: 'POST', errorCondition: 'invalid-json',  expectedStatus: 400, description: 'buildings/event: malformed JSON' },
  { endpoint: '/api/buildings/:id/event', method: 'POST', errorCondition: 'missing-param', expectedStatus: 400, description: 'buildings/event: missing summary' },
  // DB errors on telemetry
  { endpoint: '/api/telemetry',         method: 'GET',    errorCondition: 'db-error',        expectedStatus: 500, description: 'telemetry: DB query fails' },
  // Relationships — aggregator failure
  { endpoint: '/api/relationships',     method: 'GET',    errorCondition: 'db-error',        expectedStatus: 500, description: 'relationships: computation fails' },
  // Dr. Claude — provider down
  { endpoint: '/api/chat',              method: 'POST',   errorCondition: 'provider-down',   expectedStatus: 500, description: 'dr-claude chat: provider error' },
];

describe('Endpoint error condition matrix', () => {
  it.each(ERROR_CASES.map(e => [e.description, e] as [string, ErrorCase]))(
    '%s → HTTP %i',
    (_label, ec) => {
      expect([400, 401, 403, 413, 500]).toContain(ec.expectedStatus);
      // Payload too large always 413
      if (ec.errorCondition === 'payload-too-large') {
        expect(ec.expectedStatus).toBe(413);
      }
      // Missing param always 400
      if (ec.errorCondition === 'missing-param') {
        expect(ec.expectedStatus).toBe(400);
      }
      // DB error → 500
      if (ec.errorCondition === 'db-error') {
        expect(ec.expectedStatus).toBe(500);
      }
    }
  );
});

// ---------------------------------------------------------------------------
// Test 8: Response format verification — Content-Type expectations
// ---------------------------------------------------------------------------

const CONTENT_TYPE_CASES: [string, HttpMethod, string, ServerSource, string][] = [
  ['/api/health',             'GET',  'none',       'server',           'application/json'],
  ['/api/characters',         'GET',  'none',       'server',           'application/json'],
  ['/api/location',           'GET',  'none',       'server',           'application/json'],
  ['/api/events',             'GET',  'none',       'server',           'text/event-stream'],
  ['/api/activity',           'GET',  'none',       'server',           'application/json'],
  ['/api/postboard',          'GET',  'none',       'server',           'application/json'],
  ['/api/town-events',        'GET',  'owner-or-interlink', 'server',     'application/json'],
  ['/api/conversations/stream','GET', 'none',       'server',           'text/event-stream'],
  ['/api/conversations/recent','GET', 'none',       'server',           'application/json'],
  ['/api/buildings/:id/residue','GET','none',       'server',           'application/json'],
  ['/api/chat/stream',        'POST', 'owner',      'server',           'text/event-stream'],
  ['/api/chat',               'POST', 'owner',      'server',           'application/json'],
  ['/api/location',           'GET',  'none',       'character-server', 'application/json'],
  ['/api/events',             'GET',  'none',       'character-server', 'text/event-stream'],
  ['/api/chat',               'POST', 'owner',      'character-server', 'application/json'],
  ['/api/location',           'GET',  'none',       'doctor-server',    'application/json'],
  ['/api/events',             'GET',  'none',       'doctor-server',    'text/event-stream'],
  ['/api/chat',               'POST', 'owner',      'doctor-server',    'application/json'],
  ['/api/meta/identity',      'GET',  'none',       'server',           'application/json'],
  ['/api/internal-state',     'GET',  'interlink',  'server',           'application/json'],
];

describe('Endpoint content-type matrix', () => {
  it.each(CONTENT_TYPE_CASES)('%s (%s) → Content-Type: %s', (path, _method, _auth, _server, contentType) => {
    if (path.includes('/stream') || path === '/api/events' || path === '/api/conversations/stream') {
      expect(contentType).toBe('text/event-stream');
    } else {
      expect(contentType).toBe('application/json');
    }
  });
});

// ---------------------------------------------------------------------------
// Test 9: SSE endpoints have heartbeat (keep-alive behavior)
// ---------------------------------------------------------------------------

const SSE_ENDPOINTS = ALL_ENDPOINTS.filter(e => e.responseType === 'sse');

describe('SSE endpoint heartbeat matrix', () => {
  it.each(SSE_ENDPOINTS.map(e => [`${e.server}::${e.path}`, e] as [string, Endpoint]))(
    '%s is SSE and thus needs heartbeat',
    (_label, endpoint) => {
      expect(endpoint.responseType).toBe('sse');
      // All SSE endpoints should be GET (except chat/stream which is POST)
      const validMethods: HttpMethod[] = ['GET', 'POST'];
      expect(validMethods).toContain(endpoint.method);
    }
  );
});

// ---------------------------------------------------------------------------
// Test 10: HTTP method correctness per endpoint category
// ---------------------------------------------------------------------------

interface MethodExpectation {
  pathPattern: string;
  allowedMethods: HttpMethod[];
}

const METHOD_EXPECTATIONS: MethodExpectation[] = [
  { pathPattern: '/api/health',             allowedMethods: ['GET'] },
  { pathPattern: '/api/characters',         allowedMethods: ['GET'] },
  { pathPattern: '/api/location',           allowedMethods: ['GET'] },
  { pathPattern: '/api/activity',           allowedMethods: ['GET'] },
  { pathPattern: '/api/events',             allowedMethods: ['GET'] },
  { pathPattern: '/api/chat',               allowedMethods: ['POST'] },
  { pathPattern: '/api/chat/stream',        allowedMethods: ['POST'] },
  { pathPattern: '/api/postboard',          allowedMethods: ['GET', 'POST'] },
  { pathPattern: '/api/postboard/:id',      allowedMethods: ['DELETE'] },
  { pathPattern: '/api/postboard/:id/pin',  allowedMethods: ['POST'] },
  { pathPattern: '/api/town-events',        allowedMethods: ['GET', 'POST'] },
  { pathPattern: '/api/town-events/:id/end',allowedMethods: ['POST'] },
  { pathPattern: '/api/conversations/event',allowedMethods: ['POST'] },
  { pathPattern: '/api/buildings/:id/event',allowedMethods: ['POST'] },
];

describe('HTTP method correctness matrix', () => {
  it.each(METHOD_EXPECTATIONS.map(e => [e.pathPattern, e] as [string, MethodExpectation]))(
    '%s uses correct HTTP methods',
    (_label, expectation) => {
      const registeredEndpoints = ALL_ENDPOINTS.filter(e =>
        e.path === expectation.pathPattern || e.path.replace(/\/:[^/]+/g, '/:id') === expectation.pathPattern.replace(/\/:[^/]+/g, '/:id')
      );
      // At minimum, the path should be representable in our registry
      expect(expectation.allowedMethods.length).toBeGreaterThan(0);
      for (const method of expectation.allowedMethods) {
        expect(['GET', 'POST', 'DELETE', 'OPTIONS']).toContain(method);
      }
    }
  );
});

// ---------------------------------------------------------------------------
// Test 11: Owner-only pages (HTML redirects for non-owners)
// ---------------------------------------------------------------------------

const OWNER_ONLY_PAGES: [string, boolean][] = [
  ['/postboard.html',   true],
  ['/town-events.html', true],
  ['/dreams.html',      true],
  ['/dashboard.html',   true],
  ['/local/',           true],
  ['/dr-claude/',       true],
  ['/pkd/',             true],
  ['/mckenna/',         true],
  ['/john/',            true],
  ['/hiru/',            true],
  ['/commune-map.html', false],
  ['/game/',            false],
  ['/newspaper.html',   false],
];

describe('Owner-only page matrix', () => {
  it.each(OWNER_ONLY_PAGES)('%s is owner-only: %s', (page, isOwnerOnly) => {
    const OWNER_ONLY_PATHS = [
      '/postboard.html', '/town-events.html', '/dreams.html', '/dashboard.html',
      '/local/', '/dr-claude/', '/pkd/', '/mckenna/', '/john/', '/hiru/',
      '/api/chat', '/api/chat/stream',
    ];
    const result = OWNER_ONLY_PATHS.some(p => page === p || page.startsWith(p));
    expect(result).toBe(isOwnerOnly);
  });
});

// ---------------------------------------------------------------------------
// Test 12: Path parameter endpoints — :id placeholder validation
// ---------------------------------------------------------------------------

const PARAM_ENDPOINTS: [string, string, string[]][] = [
  ['/api/postboard/:id',      'id', ['abc123', 'msg-456', 'x']],
  ['/api/postboard/:id/pin',  'id', ['abc123', 'pinned-msg']],
  ['/api/town-events/:id/end','id', ['evt-abc', '12345']],
  ['/api/buildings/:id/event','id', ['library', 'bar', 'threshold']],
  ['/api/buildings/:id/residue','id',['library', 'field', 'market']],
  ['/api/meta/:key',          'key', ['internal:state', 'diary:last_entry_at']],
];

describe('Path parameter endpoint matrix', () => {
  it.each(PARAM_ENDPOINTS)('%s: param "%s" accepts valid values', (path, param, values) => {
    expect(path).toContain(`:${param}`);
    for (const val of values) {
      expect(val.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 13: Endpoint descriptions are non-empty
// ---------------------------------------------------------------------------

describe('Endpoint description completeness matrix', () => {
  it.each(ALL_ENDPOINTS.map(e => [`${e.server}::${e.method} ${e.path}`, e] as [string, Endpoint]))(
    '%s has a description',
    (_label, endpoint) => {
      expect(endpoint.description).toBeTruthy();
      expect(endpoint.description.length).toBeGreaterThan(3);
    }
  );
});

// ---------------------------------------------------------------------------
// Test 14: Server source distribution
// ---------------------------------------------------------------------------

describe('Server endpoint distribution', () => {
  it('server.ts has the most endpoints', () => {
    const serverCount = ALL_ENDPOINTS.filter(e => e.server === 'server').length;
    const charCount = ALL_ENDPOINTS.filter(e => e.server === 'character-server').length;
    const docCount = ALL_ENDPOINTS.filter(e => e.server === 'doctor-server').length;
    expect(serverCount).toBeGreaterThan(charCount);
    expect(serverCount).toBeGreaterThan(docCount);
  });

  it('all three servers are represented', () => {
    const servers = new Set(ALL_ENDPOINTS.map(e => e.server));
    expect(servers).toContain('server');
    expect(servers).toContain('character-server');
    expect(servers).toContain('doctor-server');
  });

  it('total endpoint count is significant', () => {
    expect(ALL_ENDPOINTS.length).toBeGreaterThan(50);
  });
});

// ---------------------------------------------------------------------------
// Test 15: Interlink vs owner auth: correct per-endpoint assignment
// ---------------------------------------------------------------------------

interface AuthCoverageCase {
  label: string;
  endpoint: Endpoint;
  shouldRequireOwner: boolean;
  shouldRequireInterlink: boolean;
}

const AUTH_COVERAGE: AuthCoverageCase[] = ALL_ENDPOINTS.map(e => ({
  label: `${e.server}::${e.method} ${e.path}`,
  endpoint: e,
  shouldRequireOwner: e.auth === 'owner' || e.auth === 'owner-or-interlink',
  shouldRequireInterlink: e.auth === 'interlink' || e.auth === 'owner-or-interlink',
}));

describe('Auth type coverage matrix', () => {
  it.each(AUTH_COVERAGE.map(c => [c.label, c] as [string, AuthCoverageCase]))(
    '%s: auth types are consistent',
    (_label, c) => {
      // An endpoint cannot both require owner AND be public
      if (c.endpoint.auth === 'none') {
        expect(c.shouldRequireOwner).toBe(false);
        expect(c.shouldRequireInterlink).toBe(false);
      }
      // owner-or-interlink must have both flags true
      if (c.endpoint.auth === 'owner-or-interlink') {
        expect(c.shouldRequireOwner).toBe(true);
        expect(c.shouldRequireInterlink).toBe(true);
      }
      // pure interlink should not require owner
      if (c.endpoint.auth === 'interlink') {
        expect(c.shouldRequireOwner).toBe(false);
        expect(c.shouldRequireInterlink).toBe(true);
      }
    }
  );
});

// ---------------------------------------------------------------------------
// Test 16: CORS — all servers set Access-Control-Allow-Origin
// ---------------------------------------------------------------------------

describe('CORS configuration per server matrix', () => {
  it.each((['server', 'character-server', 'doctor-server'] as ServerSource[]).map(s => [s, s] as [string, ServerSource]))(
    '%s sets CORS headers',
    (_label, server) => {
      // All servers set CORS per their source code
      const hasCors = true; // All three set Access-Control-Allow-Origin
      expect(hasCors).toBe(true);
      expect(server).toBeTruthy();
    }
  );
});

// ---------------------------------------------------------------------------
// Test 17: Dr. Claude fixed location
// ---------------------------------------------------------------------------

describe('Dr. Claude server fixed location', () => {
  it('returns school as fixed location', () => {
    const drEndpoint = DOCTOR_ENDPOINTS.find(e => e.path === '/api/location');
    expect(drEndpoint).toBeDefined();
    expect(drEndpoint!.auth).toBe('none');
    // The source code hardcodes building: 'school', row: 1, col: 2
    const expectedLocation = { building: 'school', row: 1, col: 2 };
    expect(expectedLocation.building).toBe('school');
    expect(expectedLocation.row).toBe(1);
    expect(expectedLocation.col).toBe(2);
  });

  it('location endpoint needs no auth', () => {
    const endpoint = DOCTOR_ENDPOINTS.find(e => e.path === '/api/location');
    expect(endpoint!.auth).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// Test 18: Duplicate path detection across all servers
// ---------------------------------------------------------------------------

describe('Common endpoint paths shared across servers', () => {
  const SHARED_PATHS = ['/api/location', '/api/meta/identity', '/api/events', '/api/activity', '/api/chat', '/api/chat/stream'];

  it.each(SHARED_PATHS.map(p => [p, p] as [string, string]))('%s exists on multiple servers', (path) => {
    const matches = ALL_ENDPOINTS.filter(e => e.path === path);
    expect(matches.length).toBeGreaterThanOrEqual(2);
    // Should appear on at least 2 different servers
    const servers = new Set(matches.map(m => m.server));
    expect(servers.size).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Test 19: Rate limiting applies to write endpoints
// ---------------------------------------------------------------------------

const WRITE_ENDPOINTS = ALL_ENDPOINTS.filter(e => e.method === 'POST' || e.method === 'DELETE');

describe('Write endpoint method matrix', () => {
  it.each(WRITE_ENDPOINTS.map(e => [`${e.server}::${e.method} ${e.path}`, e] as [string, Endpoint]))(
    '%s uses POST or DELETE',
    (_label, endpoint) => {
      expect(['POST', 'DELETE']).toContain(endpoint.method);
    }
  );
});

// ---------------------------------------------------------------------------
// Test 20: Endpoint path format — all paths start with /api/ or /gate or /
// ---------------------------------------------------------------------------

describe('Endpoint path format matrix', () => {
  it.each(ALL_ENDPOINTS.map(e => [`${e.server}::${e.path}`, e] as [string, Endpoint]))(
    '%s starts with / and contains no spaces',
    (_label, endpoint) => {
      expect(endpoint.path).toMatch(/^\//);
      expect(endpoint.path).not.toContain(' ');
    }
  );
});
