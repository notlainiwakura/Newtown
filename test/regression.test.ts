/**
 * Regression test suite for Laintown
 *
 * Organized by functional area. Each section targets bugs
 * that have actually occurred in production.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock keytar before any imports that touch storage
vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn().mockResolvedValue('test-master-key'),
    setPassword: vi.fn().mockResolvedValue(undefined),
    deletePassword: vi.fn().mockResolvedValue(true),
    findCredentials: vi.fn().mockResolvedValue([]),
  },
}));

// ─────────────────────────────────────────────────────────
// 1. PATH ISOLATION — Characters must use separate databases
// ─────────────────────────────────────────────────────────
describe('Path Isolation', () => {
  const originalEnv = process.env['LAIN_HOME'];

  afterEach(() => {
    if (originalEnv) {
      process.env['LAIN_HOME'] = originalEnv;
    } else {
      delete process.env['LAIN_HOME'];
    }
  });

  it('LAIN_HOME controls database path', async () => {
    const { getPaths } = await import('../src/config/paths.js');

    process.env['LAIN_HOME'] = '/root/.lain-pkd';
    const pkdPaths = getPaths();
    expect(pkdPaths.database).toBe('/root/.lain-pkd/lain.db');

    process.env['LAIN_HOME'] = '/root/.lain-wired';
    const wiredPaths = getPaths();
    expect(wiredPaths.database).toBe('/root/.lain-wired/lain.db');

    expect(pkdPaths.database).not.toBe(wiredPaths.database);
  });

  it('defaults to ~/.lain when LAIN_HOME is unset', async () => {
    const { getPaths, getBasePath } = await import('../src/config/paths.js');
    const { homedir } = await import('node:os');

    delete process.env['LAIN_HOME'];
    expect(getBasePath()).toBe(join(homedir(), '.lain'));
  });

  it('each character gets a distinct base path', () => {
    const characters = ['lain', 'wired-lain', 'pkd', 'mckenna', 'john', 'hiru'];
    const homes = characters.map(c => c === 'lain' ? '/root/.lain' : `/root/.lain-${c}`);

    // All homes must be unique
    expect(new Set(homes).size).toBe(homes.length);
  });
});


// ─────────────────────────────────────────────────────────
// 2. COMMUNE LOCATION SYSTEM
// ─────────────────────────────────────────────────────────
describe('Commune Location System', () => {
  const testDir = join(tmpdir(), `lain-test-location-${Date.now()}`);
  const dbPath = join(testDir, 'test.db');
  const originalEnv = process.env['LAIN_HOME'];

  beforeEach(async () => {
    process.env['LAIN_HOME'] = testDir;
    await mkdir(testDir, { recursive: true });
    const { initDatabase } = await import('../src/storage/database.js');
    await initDatabase(dbPath);
  });

  afterEach(async () => {
    const { closeDatabase } = await import('../src/storage/database.js');
    closeDatabase();
    if (originalEnv) {
      process.env['LAIN_HOME'] = originalEnv;
    } else {
      delete process.env['LAIN_HOME'];
    }
    try { await rm(testDir, { recursive: true }); } catch {}
  });

  it('returns default location when no location is persisted', async () => {
    const { getCurrentLocation } = await import('../src/commune/location.js');
    const { eventBus } = await import('../src/events/bus.js');

    eventBus.setCharacterId('pkd');
    const loc = getCurrentLocation();
    expect(loc.building).toBe('locksmith'); // PKD default
  });

  it('persists and retrieves location', async () => {
    const { getCurrentLocation, setCurrentLocation } = await import('../src/commune/location.js');
    const { eventBus } = await import('../src/events/bus.js');

    eventBus.setCharacterId('pkd');
    setCurrentLocation('library', 'going to read');
    const loc = getCurrentLocation();
    expect(loc.building).toBe('library');
  });

  it('no-ops when moving to same location', async () => {
    const { getCurrentLocation, setCurrentLocation, getLocationHistory } = await import('../src/commune/location.js');
    const { eventBus } = await import('../src/events/bus.js');

    eventBus.setCharacterId('pkd');
    setCurrentLocation('library', 'going to read');
    setCurrentLocation('library', 'still here'); // should no-op
    const history = getLocationHistory();
    expect(history).toHaveLength(1); // only one move recorded
  });

  it('caps history at 20 entries', async () => {
    const { setCurrentLocation, getLocationHistory } = await import('../src/commune/location.js');
    const { eventBus } = await import('../src/events/bus.js');
    const { BUILDINGS } = await import('../src/commune/buildings.js');

    eventBus.setCharacterId('john');
    const buildings = BUILDINGS.map(b => b.id);

    // Move back and forth 25 times
    for (let i = 0; i < 25; i++) {
      const target = buildings[i % buildings.length]!;
      setCurrentLocation(target as any, `move ${i}`);
    }

    const history = getLocationHistory();
    expect(history.length).toBeLessThanOrEqual(20);
  });

  it('emits movement activity event', async () => {
    const { setCurrentLocation } = await import('../src/commune/location.js');
    const { eventBus } = await import('../src/events/bus.js');

    eventBus.setCharacterId('john');
    const events: any[] = [];
    eventBus.on('activity', (e: any) => events.push(e));

    setCurrentLocation('library', 'need books');

    expect(events.length).toBeGreaterThanOrEqual(1);
    const moveEvent = events.find(e => e.type === 'movement');
    expect(moveEvent).toBeDefined();
    expect(moveEvent.content).toContain('Library');

    eventBus.removeAllListeners('activity');
  });

  it('rejects invalid building IDs', async () => {
    const { isValidBuilding } = await import('../src/commune/buildings.js');

    expect(isValidBuilding('library')).toBe(true);
    expect(isValidBuilding('locksmith')).toBe(true);
    expect(isValidBuilding('nonexistent')).toBe(false);
    expect(isValidBuilding('')).toBe(false);
  });

  it('all default locations are valid buildings', async () => {
    const { DEFAULT_LOCATIONS, isValidBuilding } = await import('../src/commune/buildings.js');

    for (const [charId, building] of Object.entries(DEFAULT_LOCATIONS)) {
      expect(isValidBuilding(building), `${charId} default '${building}' is invalid`).toBe(true);
    }
  });
});


// ─────────────────────────────────────────────────────────
// 3. EVENT BUS
// ─────────────────────────────────────────────────────────
describe('Event Bus', () => {
  it('parseEventType extracts correct types', async () => {
    const { parseEventType } = await import('../src/events/bus.js');

    expect(parseEventType('commune:pkd:1234')).toBe('commune');
    expect(parseEventType('diary:2024')).toBe('diary');
    expect(parseEventType('dream:alien:5')).toBe('dream');
    expect(parseEventType('web:session123')).toBe('chat');
    expect(parseEventType('telegram:user1')).toBe('chat');
    expect(parseEventType('movement:lib:bar')).toBe('movement');
    expect(parseEventType('letter:wired')).toBe('letter');
    expect(parseEventType('wired:something')).toBe('letter');
    expect(parseEventType(null)).toBe('unknown');
    expect(parseEventType('')).toBe('unknown');
  });

  it('isBackgroundEvent correctly classifies events', async () => {
    const { isBackgroundEvent } = await import('../src/events/bus.js');

    const makeEvent = (type: string) => ({
      character: 'test',
      type,
      sessionKey: 'test',
      content: 'test',
      timestamp: Date.now(),
    });

    // Background events
    expect(isBackgroundEvent(makeEvent('commune'))).toBe(true);
    expect(isBackgroundEvent(makeEvent('diary'))).toBe(true);
    expect(isBackgroundEvent(makeEvent('dream'))).toBe(true);
    expect(isBackgroundEvent(makeEvent('movement'))).toBe(true);
    expect(isBackgroundEvent(makeEvent('letter'))).toBe(true);
    expect(isBackgroundEvent(makeEvent('curiosity'))).toBe(true);

    // Non-background events
    expect(isBackgroundEvent(makeEvent('chat'))).toBe(false);
    expect(isBackgroundEvent(makeEvent('unknown'))).toBe(false);
  });

  it('emitActivity attaches character ID', async () => {
    const { eventBus } = await import('../src/events/bus.js');

    eventBus.setCharacterId('pkd');

    const received: any[] = [];
    eventBus.on('activity', (e: any) => received.push(e));

    eventBus.emitActivity({
      type: 'test',
      sessionKey: 'test:1',
      content: 'hello',
      timestamp: Date.now(),
    });

    expect(received).toHaveLength(1);
    expect(received[0].character).toBe('pkd');

    eventBus.removeAllListeners('activity');
  });
});


// ─────────────────────────────────────────────────────────
// 4. BUILDING DEFINITIONS
// ─────────────────────────────────────────────────────────
describe('Building Definitions', () => {
  it('has exactly 9 buildings in a 3x3 grid', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    expect(BUILDINGS).toHaveLength(9);
  });

  it('all buildings have unique IDs', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    const ids = BUILDINGS.map(b => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('grid covers rows 0-2 and cols 0-2', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    const positions = new Set(BUILDINGS.map(b => `${b.row},${b.col}`));
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        expect(positions.has(`${r},${c}`), `missing position (${r},${c})`).toBe(true);
      }
    }
  });

  it('BUILDING_MAP contains all buildings', async () => {
    const { BUILDINGS, BUILDING_MAP } = await import('../src/commune/buildings.js');
    for (const b of BUILDINGS) {
      expect(BUILDING_MAP.get(b.id)).toBeDefined();
      expect(BUILDING_MAP.get(b.id)!.name).toBe(b.name);
    }
  });

  it('every character has a default location', async () => {
    const { DEFAULT_LOCATIONS } = await import('../src/commune/buildings.js');
    const expectedCharacters = ['wired-lain', 'lain', 'dr-claude', 'pkd', 'mckenna', 'john', 'hiru'];
    for (const c of expectedCharacters) {
      expect(DEFAULT_LOCATIONS[c], `missing default for ${c}`).toBeDefined();
    }
  });
});


// ─────────────────────────────────────────────────────────
// 5. DATABASE & META STORE
// ─────────────────────────────────────────────────────────
describe('Database & Meta Store', () => {
  const testDir = join(tmpdir(), `lain-test-db-${Date.now()}`);
  const dbPath = join(testDir, 'test.db');
  const originalEnv = process.env['LAIN_HOME'];

  beforeEach(async () => {
    process.env['LAIN_HOME'] = testDir;
    await mkdir(testDir, { recursive: true });
    const { initDatabase } = await import('../src/storage/database.js');
    await initDatabase(dbPath);
  });

  afterEach(async () => {
    const { closeDatabase } = await import('../src/storage/database.js');
    closeDatabase();
    if (originalEnv) {
      process.env['LAIN_HOME'] = originalEnv;
    } else {
      delete process.env['LAIN_HOME'];
    }
    try { await rm(testDir, { recursive: true }); } catch {}
  });

  it('getMeta returns null for missing key', async () => {
    const { getMeta } = await import('../src/storage/database.js');
    expect(getMeta('nonexistent:key')).toBeNull();
  });

  it('setMeta and getMeta round-trip', async () => {
    const { getMeta, setMeta } = await import('../src/storage/database.js');

    setMeta('test:key', 'test-value');
    expect(getMeta('test:key')).toBe('test-value');
  });

  it('setMeta overwrites existing values', async () => {
    const { getMeta, setMeta } = await import('../src/storage/database.js');

    setMeta('test:key', 'first');
    setMeta('test:key', 'second');
    expect(getMeta('test:key')).toBe('second');
  });

  it('meta stores JSON strings correctly', async () => {
    const { getMeta, setMeta } = await import('../src/storage/database.js');

    const data = { building: 'library', timestamp: 12345 };
    setMeta('town:current_location', JSON.stringify(data));

    const raw = getMeta('town:current_location');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.building).toBe('library');
    expect(parsed.timestamp).toBe(12345);
  });

  it('stores and retrieves messages', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');

    saveMessage({
      sessionKey: 'web:session1',
      userId: 'user1',
      role: 'user',
      content: 'hello',
      timestamp: Date.now(),
      metadata: {},
    });

    saveMessage({
      sessionKey: 'web:session1',
      userId: null,
      role: 'assistant',
      content: 'hi there',
      timestamp: Date.now() + 1,
      metadata: {},
    });

    const messages = getRecentMessages('web:session1');
    expect(messages).toHaveLength(2);
    expect(messages[0]!.content).toBe('hello');
    expect(messages[1]!.content).toBe('hi there');
  });

  it('messages are isolated by session key', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');

    saveMessage({
      sessionKey: 'web:session1',
      userId: null,
      role: 'user',
      content: 'session 1 message',
      timestamp: Date.now(),
      metadata: {},
    });

    saveMessage({
      sessionKey: 'web:session2',
      userId: null,
      role: 'user',
      content: 'session 2 message',
      timestamp: Date.now(),
      metadata: {},
    });

    const s1 = getRecentMessages('web:session1');
    const s2 = getRecentMessages('web:session2');
    expect(s1).toHaveLength(1);
    expect(s2).toHaveLength(1);
    expect(s1[0]!.content).toBe('session 1 message');
    expect(s2[0]!.content).toBe('session 2 message');
  });

  it('isDatabaseInitialized returns true after init', async () => {
    const { isDatabaseInitialized } = await import('../src/storage/database.js');
    expect(isDatabaseInitialized()).toBe(true);
  });
});


// ─────────────────────────────────────────────────────────
// 6. CONFIGURATION
// ─────────────────────────────────────────────────────────
describe('Configuration Defaults', () => {
  it('default config has correct provider models', async () => {
    const { getDefaultConfig } = await import('../src/config/index.js');
    const config = getDefaultConfig();
    const agent = config.agents[0]!;

    // Must have at least one provider
    expect(agent.providers.length).toBeGreaterThanOrEqual(1);

    // Primary provider should be anthropic
    const primary = agent.providers[0]!;
    expect(primary.type).toBe('anthropic');
  });

  it('security defaults are sane', async () => {
    const { getDefaultConfig } = await import('../src/config/index.js');
    const config = getDefaultConfig();

    expect(config.security.maxMessageLength).toBeGreaterThan(0);
    expect(config.security.maxMessageLength).toBeLessThanOrEqual(100000);
  });
});


// ─────────────────────────────────────────────────────────
// 7. PEER CONFIG PARSING
//    Regression: systemd stripped JSON quotes from Environment=
// ─────────────────────────────────────────────────────────
describe('PEER_CONFIG Environment Parsing', () => {
  it('valid JSON PEER_CONFIG is parseable', () => {
    const raw = '[{"id":"mckenna","name":"Terence McKenna","url":"http://localhost:3004"},{"id":"john","name":"John","url":"http://localhost:3005"}]';
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBe('mckenna');
    expect(parsed[0].url).toBe('http://localhost:3004');
  });

  it('mangled JSON (no quotes) fails to parse', () => {
    // This is what systemd Environment= produces — must fail, not silently succeed
    const mangled = '[{id:mckenna,name:Terence McKenna,url:http://localhost:3004}]';
    expect(() => JSON.parse(mangled)).toThrow();
  });

  it('EnvironmentFile preserves JSON quotes', () => {
    // Simulate reading from an env file (systemd EnvironmentFile= preserves quotes)
    const envLine = 'PEER_CONFIG=[{"id":"mckenna","name":"Terence McKenna","url":"http://localhost:3004"}]';
    const value = envLine.split('=').slice(1).join('=');
    const parsed = JSON.parse(value);
    expect(parsed[0].id).toBe('mckenna');
  });
});


// ─────────────────────────────────────────────────────────
// 8. EMBEDDING UTILITIES (pure math, no model loading)
// ─────────────────────────────────────────────────────────
describe('Embedding Utilities', () => {
  it('cosineSimilarity returns 1.0 for identical vectors', async () => {
    const { cosineSimilarity } = await import('../src/memory/embeddings.js');
    const v = new Float32Array([1, 2, 3, 4]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  it('cosineSimilarity returns 0 for orthogonal vectors', async () => {
    const { cosineSimilarity } = await import('../src/memory/embeddings.js');
    const a = new Float32Array([1, 0, 0, 0]);
    const b = new Float32Array([0, 1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  it('cosineSimilarity returns -1 for opposite vectors', async () => {
    const { cosineSimilarity } = await import('../src/memory/embeddings.js');
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([-1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  it('serializeEmbedding and deserializeEmbedding round-trip', async () => {
    const { serializeEmbedding, deserializeEmbedding } = await import('../src/memory/embeddings.js');
    const original = new Float32Array([0.1, 0.2, 0.3, -0.5]);
    const buffer = serializeEmbedding(original);
    const restored = deserializeEmbedding(buffer);

    expect(restored).toHaveLength(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i]!, 5);
    }
  });
});


// ─────────────────────────────────────────────────────────
// 9. SESSION MANAGEMENT
// ─────────────────────────────────────────────────────────
describe('Session Management', () => {
  const testDir = join(tmpdir(), `lain-test-sessions-${Date.now()}`);
  const dbPath = join(testDir, 'test.db');
  const originalEnv = process.env['LAIN_HOME'];

  beforeEach(async () => {
    process.env['LAIN_HOME'] = testDir;
    await mkdir(testDir, { recursive: true });
    const { initDatabase } = await import('../src/storage/database.js');
    await initDatabase(dbPath);
  });

  afterEach(async () => {
    const { closeDatabase } = await import('../src/storage/database.js');
    closeDatabase();
    if (originalEnv) {
      process.env['LAIN_HOME'] = originalEnv;
    } else {
      delete process.env['LAIN_HOME'];
    }
    try { await rm(testDir, { recursive: true }); } catch {}
  });

  it('getOrCreateSession returns existing session for same peer', async () => {
    const { createSession, findSession } = await import('../src/storage/sessions.js');

    const s1 = createSession({
      agentId: 'default',
      channel: 'web',
      peerKind: 'user',
      peerId: 'visitor-1',
    });

    const found = findSession('default', 'web', 'visitor-1');
    expect(found).toBeDefined();
    expect(found!.key).toBe(s1.key);
  });

  it('different channels create different sessions', async () => {
    const { createSession } = await import('../src/storage/sessions.js');

    const web = createSession({
      agentId: 'default',
      channel: 'web',
      peerKind: 'user',
      peerId: 'user-1',
    });

    const tg = createSession({
      agentId: 'default',
      channel: 'telegram',
      peerKind: 'user',
      peerId: 'user-1',
    });

    expect(web.key).not.toBe(tg.key);
  });

  it('session flags default to empty', async () => {
    const { createSession } = await import('../src/storage/sessions.js');

    const session = createSession({
      agentId: 'default',
      channel: 'web',
      peerKind: 'user',
      peerId: 'user-1',
    });

    expect(session.flags).toEqual({});
  });
});


// ─────────────────────────────────────────────────────────
// 10. SYSTEMD UNIT FILE INTEGRITY
//     Regression: wrong LAIN_HOME, missing PEER_CONFIG, etc.
// ─────────────────────────────────────────────────────────
describe('Systemd Unit File Integrity', () => {
  const { readFileSync, readdirSync } = require('node:fs');
  const path = require('node:path');
  const unitDir = path.join(__dirname, '..', 'deploy', 'systemd');

  // Exclude oneshot services (healthcheck, backup) — they don't need PartOf/Restart
  const oneshotServices = ['lain-healthcheck.service', 'lain-backup.service'];
  const serviceFiles = readdirSync(unitDir)
    .filter((f: string) => f.endsWith('.service') && !oneshotServices.includes(f))
    .map((f: string) => ({
      name: f,
      content: readFileSync(path.join(unitDir, f), 'utf-8'),
    }));

  it('all service files have PartOf=lain.target', () => {
    for (const { name, content } of serviceFiles) {
      expect(content, `${name} missing PartOf`).toContain('PartOf=lain.target');
    }
  });

  it('all service files use /opt/local-lain as WorkingDirectory (voice uses /opt/wired-lain)', () => {
    for (const { name, content } of serviceFiles) {
      if (name === 'lain-voice.service') {
        // Voice venv only exists in /opt/wired-lain
        expect(content, `${name} wrong WorkingDirectory`).toMatch(/WorkingDirectory=\/opt\/wired-lain/);
      } else {
        expect(content, `${name} wrong WorkingDirectory`).toMatch(/WorkingDirectory=\/opt\/local-lain/);
      }
    }
  });

  it('character services have correct LAIN_HOME', () => {
    const expectedHomes: Record<string, string> = {
      'lain-wired.service': '/root/.lain-wired',
      'lain-main.service': '/root/.lain',
      'lain-pkd.service': '/root/.lain-pkd',
      'lain-mckenna.service': '/root/.lain-mckenna',
      'lain-john.service': '/root/.lain-john',
      'lain-hiru.service': '/root/.lain-hiru',
      'lain-telegram.service': '/root/.lain',
    };

    for (const [file, home] of Object.entries(expectedHomes)) {
      const unit = serviceFiles.find((f: any) => f.name === file);
      expect(unit, `${file} not found`).toBeDefined();
      expect(unit!.content, `${file} wrong LAIN_HOME`).toContain(`LAIN_HOME=${home}`);
    }
  });

  it('no service file contains inline PEER_CONFIG (must use EnvironmentFile)', () => {
    for (const { name, content } of serviceFiles) {
      expect(content, `${name} has inline PEER_CONFIG — systemd will mangle the JSON`)
        .not.toMatch(/^Environment=PEER_CONFIG=/m);
    }
  });

  it('character services that need peers reference an env file', () => {
    const needsPeers = ['lain-pkd.service', 'lain-mckenna.service', 'lain-john.service', 'lain-hiru.service'];
    for (const file of needsPeers) {
      const unit = serviceFiles.find((f: any) => f.name === file);
      expect(unit, `${file} not found`).toBeDefined();
      expect(unit!.content, `${file} missing peer env file`)
        .toMatch(/EnvironmentFile=.*deploy\/env\//);
    }
  });

  it('lain.target includes all services', () => {
    const target = readFileSync(path.join(unitDir, 'lain.target'), 'utf-8');
    const expectedServices = [
      'lain-wired', 'lain-main', 'lain-telegram', 'lain-gateway',
      'lain-voice', 'lain-dr-claude', 'lain-pkd', 'lain-mckenna',
      'lain-john', 'lain-hiru',
    ];
    for (const svc of expectedServices) {
      expect(target, `lain.target missing ${svc}`).toContain(`${svc}.service`);
    }
  });

  it('Wired Lain and Lain are separate services on different ports', () => {
    const wired = serviceFiles.find((f: any) => f.name === 'lain-wired.service');
    const main = serviceFiles.find((f: any) => f.name === 'lain-main.service');

    expect(wired).toBeDefined();
    expect(main).toBeDefined();
    expect(wired!.content).toContain('--port 3000');
    expect(main!.content).toContain('--port 3001');
    expect(wired!.content).toContain('LAIN_HOME=/root/.lain-wired');
    expect(main!.content).toContain('LAIN_HOME=/root/.lain');
  });
});


// ─────────────────────────────────────────────────────────
// 11. PEER CONFIG ENV FILES
// ─────────────────────────────────────────────────────────
describe('Peer Config Env Files', () => {
  const { readFileSync, readdirSync } = require('node:fs');
  const path = require('node:path');
  const envDir = path.join(__dirname, '..', 'deploy', 'env');

  const envFiles = readdirSync(envDir)
    .filter((f: string) => f.endsWith('.env'))
    .map((f: string) => ({
      name: f,
      content: readFileSync(path.join(envDir, f), 'utf-8'),
    }));

  it('all env files contain valid JSON in PEER_CONFIG', () => {
    for (const { name, content } of envFiles) {
      const match = content.match(/PEER_CONFIG=(.*)/);
      expect(match, `${name} missing PEER_CONFIG`).not.toBeNull();

      const json = match![1]!;
      let parsed: any;
      expect(() => { parsed = JSON.parse(json); }, `${name} has invalid JSON`).not.toThrow();
      expect(Array.isArray(parsed), `${name} PEER_CONFIG is not an array`).toBe(true);

      // Each peer must have id, name, url
      for (const peer of parsed) {
        expect(peer.id, `${name} peer missing id`).toBeDefined();
        expect(peer.name, `${name} peer missing name`).toBeDefined();
        expect(peer.url, `${name} peer missing url`).toBeDefined();
        expect(peer.url, `${name} peer url is not localhost`).toMatch(/^http:\/\/localhost:\d+$/);
      }
    }
  });

  it('no character lists itself as a peer', () => {
    const charMap: Record<string, string> = {
      'lain-pkd.env': 'pkd',
      'lain-mckenna.env': 'mckenna',
      'lain-john.env': 'john',
      'lain-hiru.env': 'hiru',
    };

    for (const { name, content } of envFiles) {
      const selfId = charMap[name];
      if (!selfId) continue;

      const match = content.match(/PEER_CONFIG=(.*)/);
      const peers = JSON.parse(match![1]!);
      const selfPeer = peers.find((p: any) => p.id === selfId);
      expect(selfPeer, `${name} lists itself as peer`).toBeUndefined();
    }
  });

  it('all character peers include wired-lain for postboard discovery', () => {
    // Postboard messages live in Wired Lain's DB. Characters discover them
    // via GET /api/postboard on a peer. Without wired-lain in PEER_CONFIG,
    // characters never see admin postboard messages.
    for (const { name, content } of envFiles) {
      const match = content.match(/PEER_CONFIG=(.*)/);
      const peers = JSON.parse(match![1]!);
      const hasWired = peers.some((p: any) => p.id === 'wired-lain');
      expect(hasWired, `${name} missing wired-lain peer — postboard will be invisible`).toBe(true);
    }
  });

  it('peer URLs use correct ports', () => {
    const portMap: Record<string, number> = {
      'wired-lain': 3000,
      'lain': 3001,
      'dr-claude': 3002,
      'pkd': 3003,
      'mckenna': 3004,
      'john': 3005,
      'hiru': 3006,
    };

    for (const { name, content } of envFiles) {
      const match = content.match(/PEER_CONFIG=(.*)/);
      const peers = JSON.parse(match![1]!);
      for (const peer of peers) {
        const expectedPort = portMap[peer.id];
        if (expectedPort) {
          expect(peer.url, `${name}: ${peer.id} wrong port`).toBe(`http://localhost:${expectedPort}`);
        }
      }
    }
  });
});


// ─────────────────────────────────────────────────────────
// 12. MEMORY STORE OPERATIONS
// ─────────────────────────────────────────────────────────
describe('Memory Store', () => {
  const testDir = join(tmpdir(), `lain-test-memory-${Date.now()}`);
  const dbPath = join(testDir, 'test.db');
  const originalEnv = process.env['LAIN_HOME'];

  // Mock embedding generation to avoid loading the model
  vi.mock('../src/memory/embeddings.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/memory/embeddings.js')>();
    return {
      ...actual,
      generateEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
      generateEmbeddings: vi.fn().mockResolvedValue([new Float32Array(384).fill(0.1)]),
    };
  });

  beforeEach(async () => {
    process.env['LAIN_HOME'] = testDir;
    await mkdir(testDir, { recursive: true });
    const { initDatabase } = await import('../src/storage/database.js');
    await initDatabase(dbPath);
  });

  afterEach(async () => {
    const { closeDatabase } = await import('../src/storage/database.js');
    closeDatabase();
    if (originalEnv) {
      process.env['LAIN_HOME'] = originalEnv;
    } else {
      delete process.env['LAIN_HOME'];
    }
    try { await rm(testDir, { recursive: true }); } catch {}
  });

  it('saveMemory and getMemory round-trip', async () => {
    const { saveMemory, getMemory } = await import('../src/memory/store.js');

    const id = await saveMemory({
      sessionKey: 'test:1',
      userId: null,
      content: 'PKD talked about ontological inertia',
      memoryType: 'episode',
      importance: 0.7,
      emotionalWeight: 0.3,
      relatedTo: null,
      sourceMessageId: null,
      metadata: {},
    });

    const mem = getMemory(id);
    expect(mem).toBeDefined();
    expect(mem!.content).toBe('PKD talked about ontological inertia');
    expect(mem!.memoryType).toBe('episode');
    expect(mem!.importance).toBeCloseTo(0.7);
    expect(mem!.lifecycleState).toBe('seed');
  });

  it('getMemoriesByType filters correctly', async () => {
    const { saveMemory, getMemoriesByType } = await import('../src/memory/store.js');

    await saveMemory({
      sessionKey: 'test:1', userId: null,
      content: 'a fact', memoryType: 'fact',
      importance: 0.5, emotionalWeight: 0,
      relatedTo: null, sourceMessageId: null, metadata: {},
    });

    await saveMemory({
      sessionKey: 'test:1', userId: null,
      content: 'an episode', memoryType: 'episode',
      importance: 0.5, emotionalWeight: 0,
      relatedTo: null, sourceMessageId: null, metadata: {},
    });

    const facts = getMemoriesByType('fact');
    const episodes = getMemoriesByType('episode');
    expect(facts.every(m => m.memoryType === 'fact')).toBe(true);
    expect(episodes.every(m => m.memoryType === 'episode')).toBe(true);
  });

  it('getAllRecentMessages respects limit', async () => {
    const { saveMessage, getAllRecentMessages } = await import('../src/memory/store.js');

    for (let i = 0; i < 10; i++) {
      saveMessage({
        sessionKey: `web:s${i}`, userId: null, role: 'user',
        content: `msg ${i}`, timestamp: Date.now() + i, metadata: {},
      });
    }

    const recent = getAllRecentMessages(5);
    expect(recent).toHaveLength(5);
  });
});

// ─────────────────────────────────────────────────────────
// 13. FIXTURE IMMUTABILITY — Fixtures cannot be picked up, destroyed, or transferred
// ─────────────────────────────────────────────────────────
describe('Fixture Immutability', () => {
  it('isFixture returns true for fixture objects', async () => {
    const testDir = join(tmpdir(), 'lain-fixture-test-' + Date.now());
    await mkdir(testDir, { recursive: true });
    const origHome = process.env['LAIN_HOME'];
    process.env['LAIN_HOME'] = testDir;

    try {
      const { initDatabase, closeDatabase } = await import('../src/storage/database.js');
      const dbPath = join(testDir, 'lain.db');
      await initDatabase(dbPath);

      try {
        const { createObject, isFixture: isFixtureFn } = await import('../src/objects/store.js');

        // Create a normal object
        const normal = createObject('rock', 'a plain rock', 'test', 'Tester', 'bar');
        expect(isFixtureFn(normal.id)).toBe(false);

        // Create a fixture
        const fixture = createObject('desk lamp', 'a lamp', 'admin', 'Administrator', 'lighthouse', { fixture: true, spriteId: 'lamp_desk' });
        expect(isFixtureFn(fixture.id)).toBe(true);

        // Non-existent returns false
        expect(isFixtureFn('nonexistent')).toBe(false);
      } finally {
        closeDatabase();
      }
    } finally {
      if (origHome) {
        process.env['LAIN_HOME'] = origHome;
      } else {
        delete process.env['LAIN_HOME'];
      }
      await rm(testDir, { recursive: true, force: true });
    }
  });
});
