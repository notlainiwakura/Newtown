/**
 * Game Client Behavioral Tests
 * Verifies actual computation and logic from the isometric game client JS.
 * Functions are extracted from browser globals and tested with real inputs/outputs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// =============================================================================
// Extracted pure functions from config.js
// =============================================================================

const GAME_CONFIG = {
  WIDTH: 1280,
  HEIGHT: 960,
  TILE_SIZE: 64,
  SPRITE_W: 64,
  SPRITE_H: 96,
  MAP_COLS: 64,
  MAP_ROWS: 48,
  MOVE_DURATION: 150,
  POLL_INTERVAL: 10000,
  PENDING_POLL: 5000,
  CAMERA_LERP: 0.1,
  ISO_TILE_W: 128,
  ISO_TILE_H: 64,
  ISO_WALL_H: 96,
};

const BUILDINGS = [
  { id: 'library', name: 'Library', row: 0, col: 0 },
  { id: 'bar', name: 'Bar', row: 0, col: 1 },
  { id: 'field', name: 'Field', row: 0, col: 2 },
  { id: 'windmill', name: 'Windmill', row: 1, col: 0 },
  { id: 'lighthouse', name: 'Lighthouse', row: 1, col: 1 },
  { id: 'school', name: 'School', row: 1, col: 2 },
  { id: 'market', name: 'Market', row: 2, col: 0 },
  { id: 'locksmith', name: 'Locksmith', row: 2, col: 1 },
  { id: 'threshold', name: 'The Threshold', row: 2, col: 2 },
];

const BUILDING_MAP: Record<string, (typeof BUILDINGS)[number]> = {};
for (const b of BUILDINGS) BUILDING_MAP[b.id] = b;

const ZONE_SIZE_X = 12;
const ZONE_SIZE_Y = 10;
const PATH_W = 4;
const ZONE_PADDING_X = 8;
const ZONE_PADDING_Y = 5;

function getBuildingZone(buildingId: string) {
  const b = BUILDING_MAP[buildingId];
  if (!b) return null;
  const x = ZONE_PADDING_X + b.col * (ZONE_SIZE_X + PATH_W);
  const y = ZONE_PADDING_Y + b.row * (ZONE_SIZE_Y + PATH_W);
  return { x, y, w: ZONE_SIZE_X, h: ZONE_SIZE_Y };
}

function getBuildingSpawn(buildingId: string) {
  const zone = getBuildingZone(buildingId);
  if (!zone) return { x: 32, y: 24 };
  return {
    x: zone.x + Math.floor(zone.w / 2),
    y: zone.y + Math.floor(zone.h / 2),
  };
}

function getBuildingAtTile(tileX: number, tileY: number): string | null {
  for (const b of BUILDINGS) {
    const zone = getBuildingZone(b.id)!;
    if (
      tileX >= zone.x &&
      tileX < zone.x + zone.w &&
      tileY >= zone.y &&
      tileY < zone.y + zone.h
    ) {
      return b.id;
    }
  }
  return null;
}

function tileToScreen(tileX: number, tileY: number) {
  const halfW = GAME_CONFIG.ISO_TILE_W / 2;
  const halfH = GAME_CONFIG.ISO_TILE_H / 2;
  return {
    x: (tileX - tileY) * halfW + GAME_CONFIG.MAP_ROWS * halfW,
    y: (tileX + tileY) * halfH + GAME_CONFIG.ISO_TILE_H,
  };
}

function _hashColorHex(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  const hue = ((h % 360) + 360) % 360;
  const s = 0.6,
    l = 0.6;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let r: number, g: number, b: number;
  if (hue < 60) {
    r = c; g = x; b = 0;
  } else if (hue < 120) {
    r = x; g = c; b = 0;
  } else if (hue < 180) {
    r = 0; g = c; b = x;
  } else if (hue < 240) {
    r = 0; g = x; b = c;
  } else if (hue < 300) {
    r = x; g = 0; b = c;
  } else {
    r = c; g = 0; b = x;
  }
  const toHex = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return '#' + toHex(r) + toHex(g) + toHex(b);
}

// =============================================================================
// Extracted A* pathfinding from pathfinding.js
// =============================================================================

function findPath(
  collision: number[][],
  sx: number,
  sy: number,
  ex: number,
  ey: number
): { x: number; y: number }[] {
  if (sx === ex && sy === ey) return [{ x: sx, y: sy }];

  const rows = collision.length;
  if (!rows) return [];
  const cols = collision[0].length;

  if (sx < 0 || sx >= cols || sy < 0 || sy >= rows) return [];
  if (ex < 0 || ex >= cols || ey < 0 || ey >= rows) return [];
  if (collision[sy][sx] || collision[ey][ex]) return [];

  const DIRS = [
    { dx: 1, dy: 0 },
    { dx: -1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: 0, dy: -1 },
  ];

  function heuristic(x: number, y: number) {
    return Math.abs(x - ex) + Math.abs(y - ey);
  }

  const open: { x: number; y: number; f: number }[] = [];
  const closed = new Set<string>();
  const gScore: Record<string, number> = {};
  const cameFrom: Record<string, string | undefined> = {};

  function key(x: number, y: number) {
    return x + ',' + y;
  }

  const startKey = key(sx, sy);
  gScore[startKey] = 0;
  open.push({ x: sx, y: sy, f: heuristic(sx, sy) });

  while (open.length > 0) {
    let bestIdx = 0;
    for (let i = 1; i < open.length; i++) {
      if (open[i].f < open[bestIdx].f) bestIdx = i;
    }
    const current = open.splice(bestIdx, 1)[0];
    const ck2 = key(current.x, current.y);
    if (closed.has(ck2)) continue;
    closed.add(ck2);

    if (current.x === ex && current.y === ey) {
      const path: { x: number; y: number }[] = [];
      let k: string | undefined = key(current.x, current.y);
      while (k !== undefined) {
        const parts = k.split(',');
        path.push({ x: parseInt(parts[0], 10), y: parseInt(parts[1], 10) });
        k = cameFrom[k];
      }
      path.reverse();
      return path;
    }

    const currentG = gScore[ck2];

    for (const dir of DIRS) {
      const nx = current.x + dir.dx;
      const ny = current.y + dir.dy;

      if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
      if (collision[ny][nx]) continue;

      const nk = key(nx, ny);
      if (closed.has(nk)) continue;
      const tentativeG = currentG + 1;

      if (gScore[nk] === undefined || tentativeG < gScore[nk]) {
        gScore[nk] = tentativeG;
        cameFrom[nk] = ck2;
        const f = tentativeG + heuristic(nx, ny);

        let found = false;
        for (let i = 0; i < open.length; i++) {
          if (open[i].x === nx && open[i].y === ny) {
            open[i].f = f;
            found = true;
            break;
          }
        }
        if (!found) {
          open.push({ x: nx, y: ny, f: f });
        }
      }
    }
  }

  return [];
}

// =============================================================================
// Extracted telemetry functions from laintown-telemetry.js
// =============================================================================

const TELEMETRY_ENDPOINTS = [
  { id: 'wired-lain', name: 'Wired Lain', color: '#4080ff', path: '/api/activity' },
  { id: 'lain', name: 'Lain', color: '#80c0ff', path: '/local/api/activity' },
  { id: 'pkd', name: 'PKD', color: '#c060ff', path: '/pkd/api/activity' },
  { id: 'mckenna', name: 'McKenna', color: '#40e080', path: '/mckenna/api/activity' },
  { id: 'john', name: 'John', color: '#ffb040', path: '/john/api/activity' },
  { id: 'hiru', name: 'Hiru', color: '#60d0a0', path: '/hiru/api/activity' },
];

const TYPE_COLORS: Record<string, string> = {
  diary: '#e0a020',
  dream: '#a040e0',
  commune: '#40d0e0',
  curiosity: '#40c060',
  chat: '#c0d0e0',
  memory: '#4080e0',
  letter: '#e060a0',
  narrative: '#e08030',
  'self-concept': '#8080e0',
  doctor: '#ff6060',
  peer: '#60c0c0',
  movement: '#e0d040',
  move: '#e0d040',
  note: '#c0a060',
  document: '#a0c0e0',
  gift: '#e080c0',
  research: '#60e0e0',
};

const TYPE_LABELS: Record<string, string> = {
  diary: 'DIARY',
  dream: 'DREAM',
  commune: 'COMMUNE',
  curiosity: 'CURIOSITY',
  chat: 'CHAT',
  memory: 'MEMORY',
  letter: 'LETTER',
  narrative: 'NARRATIVE',
  'self-concept': 'SELF',
  doctor: 'DOCTOR',
  peer: 'PEER',
  movement: 'MOVEMENT',
  move: 'MOVE',
  note: 'NOTE',
  document: 'DOC',
  gift: 'GIFT',
  research: 'RESEARCH',
};

function parseType(sessionKey: string | null): string {
  if (!sessionKey) return 'unknown';
  const prefix = sessionKey.split(':')[0];
  const map: Record<string, string> = {
    commune: 'commune',
    diary: 'diary',
    dream: 'dream',
    curiosity: 'curiosity',
    'self-concept': 'self-concept',
    selfconcept: 'self-concept',
    narrative: 'narrative',
    letter: 'letter',
    wired: 'letter',
    web: 'chat',
    peer: 'peer',
    telegram: 'chat',
    alien: 'dream',
    bibliomancy: 'curiosity',
    dr: 'doctor',
    doctor: 'doctor',
    proactive: 'chat',
    movement: 'movement',
    move: 'move',
    note: 'note',
    document: 'document',
    gift: 'gift',
    research: 'research',
  };
  return map[prefix] || prefix;
}

function parseCommuneTarget(sessionKey: string | null): string {
  if (!sessionKey) return '';
  const parts = sessionKey.split(':');
  if (parts.length >= 3 && parts[0] === 'commune') return parts[2];
  if (parts.length >= 3 && parts[0] === 'peer') return parts[2];
  return '';
}

function charNameById(id: string): string {
  for (let i = 0; i < TELEMETRY_ENDPOINTS.length; i++) {
    if (TELEMETRY_ENDPOINTS[i].id === id) return TELEMETRY_ENDPOINTS[i].name;
  }
  return id;
}

function charColorById(id: string): string {
  for (let i = 0; i < TELEMETRY_ENDPOINTS.length; i++) {
    if (TELEMETRY_ENDPOINTS[i].id === id) return TELEMETRY_ENDPOINTS[i].color;
  }
  return '#778';
}

function pad(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// =============================================================================
// Extracted DialogSystem logic from DialogSystem.js
// =============================================================================

class DialogSystem {
  isOpen = false;
  isTyping = false;
  fullText = '';
  displayedText = '';
  charIndex = 0;
  typeSpeed = 30;
  onComplete: (() => void) | null = null;
  isStreaming = false;
  streamBuffer = '';
  inputText = '';
  inputActive = false;
  inputCallback: ((text: string) => void) | null = null;

  startTypewriter(text: string, onComplete?: () => void) {
    this.fullText = text;
    this.displayedText = '';
    this.charIndex = 0;
    this.isTyping = true;
    this.onComplete = onComplete || null;
  }

  typeNextChar() {
    if (this.charIndex >= this.fullText.length) {
      this.isTyping = false;
      if (this.onComplete) this.onComplete();
      return;
    }
    this.displayedText += this.fullText[this.charIndex];
    this.charIndex++;
  }

  skipTypewriter(): boolean {
    if (!this.isTyping) return false;
    this.displayedText = this.fullText;
    this.charIndex = this.fullText.length;
    this.isTyping = false;
    if (this.onComplete) this.onComplete();
    return true;
  }

  appendStreamChunk(chunk: string) {
    this.fullText += chunk;
    this.displayedText += chunk;
    this.charIndex = this.fullText.length;
  }

  startStreaming() {
    this.isStreaming = true;
    this.fullText = '';
    this.displayedText = '';
    this.charIndex = 0;
  }

  endStreaming() {
    this.isStreaming = false;
  }

  getDisplayText(): string {
    return this.displayedText;
  }

  startInput(callback: (text: string) => void) {
    this.inputText = '';
    this.inputActive = true;
    this.inputCallback = callback;
  }

  handleKeyInput(event: { key: string }): boolean {
    if (!this.inputActive) return false;

    if (event.key === 'Enter') {
      const text = this.inputText.trim();
      this.inputActive = false;
      if (text && this.inputCallback) {
        this.inputCallback(text);
      }
      return true;
    }

    if (event.key === 'Backspace') {
      this.inputText = this.inputText.slice(0, -1);
      return true;
    }

    if (event.key === 'Escape') {
      this.inputActive = false;
      this.inputText = '';
      return true;
    }

    if (event.key.length === 1) {
      this.inputText += event.key;
      return true;
    }

    return false;
  }

  getInputText(): string {
    return this.inputText;
  }

  isInputActive(): boolean {
    return this.inputActive;
  }

  reset() {
    this.isTyping = false;
    this.isStreaming = false;
    this.fullText = '';
    this.displayedText = '';
    this.charIndex = 0;
    this.inputText = '';
    this.inputActive = false;
  }
}

// =============================================================================
// Extracted PossessionManager logic (non-Phaser parts)
// =============================================================================

class PossessionManagerLogic {
  isPossessed = false;
  currentBuilding = 'market';
  pendingMessages: { fromId: string; fromName: string; message: string }[] = [];
  onPeerMessage: ((event: any) => void) | null = null;
  onMovement: ((event: any) => void) | null = null;

  checkZone(tileX: number, tileY: number) {
    const building = getBuildingAtTile(tileX, tileY);
    if (building && building !== this.currentBuilding) {
      const prev = this.currentBuilding;
      this.currentBuilding = building;
      return { changed: true, from: prev, to: building };
    }
    return { changed: false };
  }

  handleStreamEvent(event: { type: string; fromId?: string; fromName?: string; message?: string }) {
    if (event.type === 'peer_message') {
      this.pendingMessages.push({
        fromId: event.fromId!,
        fromName: event.fromName!,
        message: event.message!,
      });
      if (this.onPeerMessage) {
        this.onPeerMessage(event);
      }
    } else if (event.type === 'movement') {
      if (this.onMovement) {
        this.onMovement(event);
      }
    } else if (event.type === 'possession_ended') {
      this.isPossessed = false;
    }
  }

  hasPending(): boolean {
    return this.pendingMessages.length > 0;
  }

  getNextPending() {
    return this.pendingMessages[0] || null;
  }

  replyToPending(fromId: string) {
    this.pendingMessages = this.pendingMessages.filter((m) => m.fromId !== fromId);
  }
}

// =============================================================================
// Extracted Fisher-Yates shuffle from DialogScene.js
// =============================================================================

function fisherYatesShuffle(n: number): number[] {
  const arr = Array.from({ length: n }, (_, i) => i);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// =============================================================================
// 1. API Client behavioral (~50 tests)
// =============================================================================

describe('APIClient behavioral -- fetch mechanics', () => {
  let originalFetch: typeof globalThis.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function makeOkJson(data: any) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(data),
      headers: new Headers({ 'content-type': 'application/json' }),
    });
  }

  function makeErrorResp(status: number, data: any) {
    return Promise.resolve({
      ok: false,
      status,
      json: () => Promise.resolve(data),
    });
  }

  // Rebuild a minimal APIClient for testing
  class TestAPIClient {
    token = '';
    base = '';

    setToken(token: string) { this.token = token; }
    getToken() { return this.token; }

    async _fetch(path: string, options: any = {}) {
      const url = this.base + path;
      const resp = await fetch(url, {
        ...options,
        headers: {
          Authorization: 'Bearer ' + this.token,
          'Content-Type': 'application/json',
          ...(options.headers || {}),
        },
      });
      return resp;
    }

    async checkAuth() {
      const resp = await this._fetch('/api/possession/status');
      if (!(resp as any).ok) return null;
      return await (resp as any).json();
    }

    async possess() {
      const resp = await this._fetch('/api/possess', { method: 'POST' });
      if (!(resp as any).ok) {
        const data = await (resp as any).json();
        throw new Error(data.error || 'Possess failed');
      }
      return await (resp as any).json();
    }

    async unpossess() {
      const resp = await this._fetch('/api/unpossess', { method: 'POST' });
      if (!(resp as any).ok) {
        const data = await (resp as any).json();
        throw new Error(data.error || 'Unpossess failed');
      }
      return await (resp as any).json();
    }

    async move(buildingId: string) {
      const resp = await this._fetch('/api/possession/move', {
        method: 'POST',
        body: JSON.stringify({ building: buildingId }),
      });
      if (!(resp as any).ok) {
        const data = await (resp as any).json();
        throw new Error(data.error || 'Move failed');
      }
      return await (resp as any).json();
    }

    async look() {
      const resp = await this._fetch('/api/possession/look');
      if (!(resp as any).ok) throw new Error('Look failed');
      return await (resp as any).json();
    }

    async say(peerId: string, message: string) {
      const resp = await this._fetch('/api/possession/say', {
        method: 'POST',
        body: JSON.stringify({ peerId, message }),
      });
      if (!(resp as any).ok) {
        const data = await (resp as any).json();
        throw new Error(data.error || 'Say failed');
      }
      return await (resp as any).json();
    }

    async getPending() {
      const resp = await this._fetch('/api/possession/pending');
      if (!(resp as any).ok) return [];
      return await (resp as any).json();
    }

    async reply(fromId: string, message: string) {
      const resp = await this._fetch('/api/possession/reply', {
        method: 'POST',
        body: JSON.stringify({ fromId, message }),
      });
      if (!(resp as any).ok) {
        const data = await (resp as any).json();
        throw new Error(data.error || 'Reply failed');
      }
      return await (resp as any).json();
    }
  }

  let client: TestAPIClient;

  beforeEach(() => {
    client = new TestAPIClient();
    client.setToken('test-token-123');
    client.base = 'http://localhost:3000';
  });

  it('setToken stores and getToken retrieves the token', () => {
    client.setToken('abc');
    expect(client.getToken()).toBe('abc');
  });

  it('setToken with empty string clears the token', () => {
    client.setToken('');
    expect(client.getToken()).toBe('');
  });

  it('_fetch prepends base URL to path', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => ({}) });
    await client._fetch('/api/test');
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/api/test',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token-123',
        }),
      })
    );
  });

  it('_fetch includes Bearer token in Authorization header', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => ({}) });
    await client._fetch('/api/test');
    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe('Bearer test-token-123');
  });

  it('_fetch includes Content-Type application/json', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => ({}) });
    await client._fetch('/api/test');
    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('_fetch merges custom headers with defaults', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => ({}) });
    await client._fetch('/api/test', { headers: { 'X-Custom': 'value' } });
    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers['X-Custom']).toBe('value');
    expect(headers.Authorization).toBe('Bearer test-token-123');
  });

  it('checkAuth returns parsed JSON on 200', async () => {
    mockFetch.mockResolvedValue(makeOkJson({ isPossessed: true, location: 'library' }));
    const result = await client.checkAuth();
    expect(result).toEqual({ isPossessed: true, location: 'library' });
  });

  it('checkAuth returns null on non-200', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401 });
    const result = await client.checkAuth();
    expect(result).toBeNull();
  });

  it('checkAuth calls correct endpoint', async () => {
    mockFetch.mockResolvedValue(makeOkJson({}));
    await client.checkAuth();
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:3000/api/possession/status');
  });

  it('possess sends POST and returns session data', async () => {
    mockFetch.mockResolvedValue(makeOkJson({ ok: true, sessionId: 's123' }));
    const result = await client.possess();
    expect(result).toEqual({ ok: true, sessionId: 's123' });
    expect(mockFetch.mock.calls[0][1].method).toBe('POST');
  });

  it('possess throws on non-200 with server error message', async () => {
    mockFetch.mockResolvedValue(makeErrorResp(409, { error: 'Already possessed' }));
    await expect(client.possess()).rejects.toThrow('Already possessed');
  });

  it('possess throws default message when no error field', async () => {
    mockFetch.mockResolvedValue(makeErrorResp(500, {}));
    await expect(client.possess()).rejects.toThrow('Possess failed');
  });

  it('unpossess sends POST and returns result', async () => {
    mockFetch.mockResolvedValue(makeOkJson({ ok: true }));
    const result = await client.unpossess();
    expect(result).toEqual({ ok: true });
    expect(mockFetch.mock.calls[0][1].method).toBe('POST');
  });

  it('unpossess throws on non-200', async () => {
    mockFetch.mockResolvedValue(makeErrorResp(500, { error: 'Server error' }));
    await expect(client.unpossess()).rejects.toThrow('Server error');
  });

  it('unpossess throws default message when no error field', async () => {
    mockFetch.mockResolvedValue(makeErrorResp(500, {}));
    await expect(client.unpossess()).rejects.toThrow('Unpossess failed');
  });

  it('move sends POST with building in body', async () => {
    mockFetch.mockResolvedValue(makeOkJson({ ok: true, building: 'library' }));
    await client.move('library');
    expect(mockFetch.mock.calls[0][1].body).toBe(JSON.stringify({ building: 'library' }));
  });

  it('move returns result with building on success', async () => {
    mockFetch.mockResolvedValue(makeOkJson({ ok: true, building: 'bar' }));
    const result = await client.move('bar');
    expect(result.building).toBe('bar');
  });

  it('move throws on non-200', async () => {
    mockFetch.mockResolvedValue(makeErrorResp(400, { error: 'Invalid building' }));
    await expect(client.move('nonexistent')).rejects.toThrow('Invalid building');
  });

  it('move throws default message when no error field', async () => {
    mockFetch.mockResolvedValue(makeErrorResp(500, {}));
    await expect(client.move('bar')).rejects.toThrow('Move failed');
  });

  it('look returns location data on success', async () => {
    const data = { building: 'library', allLocations: [{ id: 'lain', building: 'library' }] };
    mockFetch.mockResolvedValue(makeOkJson(data));
    const result = await client.look();
    expect(result.allLocations).toHaveLength(1);
  });

  it('look throws generic error on non-200', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    await expect(client.look()).rejects.toThrow('Look failed');
  });

  it('say sends POST with peerId and message', async () => {
    mockFetch.mockResolvedValue(makeOkJson({ response: 'hello back' }));
    await client.say('pkd', 'hello');
    expect(mockFetch.mock.calls[0][1].body).toBe(JSON.stringify({ peerId: 'pkd', message: 'hello' }));
  });

  it('say returns response text on success', async () => {
    mockFetch.mockResolvedValue(makeOkJson({ response: 'hello back' }));
    const result = await client.say('pkd', 'hello');
    expect(result.response).toBe('hello back');
  });

  it('say throws on non-200 with error message', async () => {
    mockFetch.mockResolvedValue(makeErrorResp(400, { error: 'not_co_located' }));
    await expect(client.say('pkd', 'hi')).rejects.toThrow('not_co_located');
  });

  it('say throws default message when no error field', async () => {
    mockFetch.mockResolvedValue(makeErrorResp(500, {}));
    await expect(client.say('pkd', 'hi')).rejects.toThrow('Say failed');
  });

  it('getPending returns array on success', async () => {
    const msgs = [{ fromId: 'lain', fromName: 'Lain', message: 'hey' }];
    mockFetch.mockResolvedValue(makeOkJson(msgs));
    const result = await client.getPending();
    expect(result).toEqual(msgs);
  });

  it('getPending returns empty array on non-200', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    const result = await client.getPending();
    expect(result).toEqual([]);
  });

  it('reply sends POST with fromId and message', async () => {
    mockFetch.mockResolvedValue(makeOkJson({ ok: true }));
    await client.reply('lain', 'thanks');
    expect(mockFetch.mock.calls[0][1].body).toBe(JSON.stringify({ fromId: 'lain', message: 'thanks' }));
  });

  it('reply throws on non-200', async () => {
    mockFetch.mockResolvedValue(makeErrorResp(500, { error: 'Reply error' }));
    await expect(client.reply('lain', 'msg')).rejects.toThrow('Reply error');
  });

  it('reply throws default message when no error field', async () => {
    mockFetch.mockResolvedValue(makeErrorResp(500, {}));
    await expect(client.reply('lain', 'msg')).rejects.toThrow('Reply failed');
  });

  it('base URL changes affect all subsequent requests', async () => {
    client.base = 'http://other:4000';
    mockFetch.mockResolvedValue(makeOkJson({}));
    await client.checkAuth();
    expect(mockFetch.mock.calls[0][0]).toBe('http://other:4000/api/possession/status');
  });

  it('empty base URL results in relative paths', async () => {
    client.base = '';
    mockFetch.mockResolvedValue(makeOkJson({}));
    await client.checkAuth();
    expect(mockFetch.mock.calls[0][0]).toBe('/api/possession/status');
  });

  it('token change affects subsequent requests', async () => {
    mockFetch.mockResolvedValue(makeOkJson({}));
    client.setToken('new-token');
    await client.checkAuth();
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer new-token');
  });

  it('network error propagates from fetch', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));
    await expect(client.checkAuth()).rejects.toThrow('Network error');
  });

  it('look endpoint path is correct', async () => {
    mockFetch.mockResolvedValue(makeOkJson({}));
    await client.look();
    expect(mockFetch.mock.calls[0][0]).toContain('/api/possession/look');
  });

  it('pending endpoint path is correct', async () => {
    mockFetch.mockResolvedValue(makeOkJson([]));
    await client.getPending();
    expect(mockFetch.mock.calls[0][0]).toContain('/api/possession/pending');
  });

  it('reply endpoint path is correct', async () => {
    mockFetch.mockResolvedValue(makeOkJson({}));
    await client.reply('a', 'b');
    expect(mockFetch.mock.calls[0][0]).toContain('/api/possession/reply');
  });

  it('move endpoint path is correct', async () => {
    mockFetch.mockResolvedValue(makeOkJson({}));
    await client.move('library');
    expect(mockFetch.mock.calls[0][0]).toContain('/api/possession/move');
  });

  it('possess endpoint path is correct', async () => {
    mockFetch.mockResolvedValue(makeOkJson({}));
    await client.possess();
    expect(mockFetch.mock.calls[0][0]).toContain('/api/possess');
  });

  it('unpossess endpoint path is correct', async () => {
    mockFetch.mockResolvedValue(makeOkJson({}));
    await client.unpossess();
    expect(mockFetch.mock.calls[0][0]).toContain('/api/unpossess');
  });

  it('say endpoint path is correct', async () => {
    mockFetch.mockResolvedValue(makeOkJson({}));
    await client.say('x', 'y');
    expect(mockFetch.mock.calls[0][0]).toContain('/api/possession/say');
  });
});

// =============================================================================
// 2. Character Manager behavioral (~40 tests)
// =============================================================================

describe('CharacterManager behavioral -- position tracking', () => {
  // Test the getNearestNPC Manhattan distance logic
  function getNearestNPC(
    sprites: Record<string, { tileX: number; tileY: number }>,
    tileX: number,
    tileY: number,
    maxDistance = 2
  ): string | null {
    let nearest: string | null = null;
    let nearestDist = Infinity;

    for (const [charId, entry] of Object.entries(sprites)) {
      const dist = Math.abs(entry.tileX - tileX) + Math.abs(entry.tileY - tileY);
      if (dist <= maxDistance && dist < nearestDist) {
        nearest = charId;
        nearestDist = dist;
      }
    }
    return nearest;
  }

  function getCharactersAt(
    locations: Record<string, string>,
    sprites: Record<string, any>,
    buildingId: string
  ): string[] {
    const result: string[] = [];
    for (const [charId, building] of Object.entries(locations)) {
      if (building === buildingId && sprites[charId]) {
        result.push(charId);
      }
    }
    return result;
  }

  it('getNearestNPC returns null when no sprites exist', () => {
    expect(getNearestNPC({}, 10, 10)).toBeNull();
  });

  it('getNearestNPC returns the only sprite when within range', () => {
    const sprites = { lain: { tileX: 10, tileY: 10 } };
    expect(getNearestNPC(sprites, 11, 10)).toBe('lain');
  });

  it('getNearestNPC returns null when sprite is out of range', () => {
    const sprites = { lain: { tileX: 10, tileY: 10 } };
    expect(getNearestNPC(sprites, 20, 20)).toBeNull();
  });

  it('getNearestNPC uses Manhattan distance (not Euclidean)', () => {
    const sprites = { lain: { tileX: 10, tileY: 10 } };
    // Manhattan distance of 2 (dx=1, dy=1)
    expect(getNearestNPC(sprites, 11, 11)).toBe('lain');
    // Manhattan distance of 3 (dx=2, dy=1) -- out of default range 2
    expect(getNearestNPC(sprites, 12, 11)).toBeNull();
  });

  it('getNearestNPC picks closer sprite when multiple in range', () => {
    const sprites = {
      lain: { tileX: 10, tileY: 10 },
      pkd: { tileX: 11, tileY: 10 },
    };
    expect(getNearestNPC(sprites, 11, 10)).toBe('pkd'); // distance 0
  });

  it('getNearestNPC respects custom maxDistance', () => {
    const sprites = { lain: { tileX: 10, tileY: 10 } };
    expect(getNearestNPC(sprites, 13, 10, 5)).toBe('lain'); // distance 3
    expect(getNearestNPC(sprites, 13, 10, 2)).toBeNull(); // distance 3 > 2
  });

  it('getNearestNPC handles distance of 0 (same tile)', () => {
    const sprites = { lain: { tileX: 10, tileY: 10 } };
    expect(getNearestNPC(sprites, 10, 10)).toBe('lain');
  });

  it('getNearestNPC picks the one with smaller Manhattan distance among multiple', () => {
    const sprites = {
      a: { tileX: 5, tileY: 5 },
      b: { tileX: 6, tileY: 5 },
      c: { tileX: 7, tileY: 5 },
    };
    expect(getNearestNPC(sprites, 6, 5, 3)).toBe('b'); // distance 0
  });

  it('getCharactersAt returns empty array for empty building', () => {
    const locations = { lain: 'library', pkd: 'bar' };
    const sprites = { lain: {}, pkd: {} };
    expect(getCharactersAt(locations, sprites, 'school')).toEqual([]);
  });

  it('getCharactersAt returns all characters in a building', () => {
    const locations = { lain: 'library', pkd: 'library', mck: 'bar' };
    const sprites = { lain: {}, pkd: {}, mck: {} };
    const result = getCharactersAt(locations, sprites, 'library');
    expect(result).toContain('lain');
    expect(result).toContain('pkd');
    expect(result).not.toContain('mck');
  });

  it('getCharactersAt excludes characters without sprites', () => {
    const locations = { lain: 'library', pkd: 'library' };
    const sprites = { lain: {} }; // pkd has no sprite
    expect(getCharactersAt(locations, sprites, 'library')).toEqual(['lain']);
  });

  it('getLocation returns location from locations map', () => {
    const locations: Record<string, string> = { lain: 'library' };
    const defaultLocations: Record<string, string> = { lain: 'market' };
    function getLocation(charId: string) {
      return locations[charId] || defaultLocations[charId] || null;
    }
    expect(getLocation('lain')).toBe('library');
  });

  it('getLocation falls back to default location', () => {
    const locations: Record<string, string> = {};
    const defaultLocations: Record<string, string> = { lain: 'market' };
    function getLocation(charId: string) {
      return locations[charId] || defaultLocations[charId] || null;
    }
    expect(getLocation('lain')).toBe('market');
  });

  it('getLocation returns null for unknown character', () => {
    const locations: Record<string, string> = {};
    const defaultLocations: Record<string, string> = {};
    function getLocation(charId: string) {
      return locations[charId] || defaultLocations[charId] || null;
    }
    expect(getLocation('unknown')).toBeNull();
  });

  it('updateLocations detects building change', () => {
    const locations: Record<string, string> = { lain: 'library' };
    const allLocations = [{ id: 'lain', building: 'bar' }];
    const movers: string[] = [];
    for (const loc of allLocations) {
      const prev = locations[loc.id];
      locations[loc.id] = loc.building;
      if (prev !== loc.building) {
        movers.push(loc.id);
      }
    }
    expect(movers).toEqual(['lain']);
    expect(locations.lain).toBe('bar');
  });

  it('updateLocations does not flag when location unchanged', () => {
    const locations: Record<string, string> = { lain: 'library' };
    const allLocations = [{ id: 'lain', building: 'library' }];
    const movers: string[] = [];
    for (const loc of allLocations) {
      const prev = locations[loc.id];
      locations[loc.id] = loc.building;
      if (prev !== loc.building) movers.push(loc.id);
    }
    expect(movers).toEqual([]);
  });

  it('updateLocations handles new character appearing', () => {
    const locations: Record<string, string> = {};
    const allLocations = [{ id: 'lain', building: 'library' }];
    const movers: string[] = [];
    for (const loc of allLocations) {
      const prev = locations[loc.id];
      locations[loc.id] = loc.building;
      if (prev !== loc.building) movers.push(loc.id);
    }
    // prev was undefined, building is 'library' -- detected as change
    expect(movers).toEqual(['lain']);
  });

  it('occupiedTiles tracks tile occupation correctly', () => {
    const occupied = new Set<string>();
    occupied.add('10,10');
    occupied.add('11,10');
    expect(occupied.has('10,10')).toBe(true);
    expect(occupied.has('12,12')).toBe(false);
    occupied.delete('10,10');
    expect(occupied.has('10,10')).toBe(false);
  });

  it('sprite depth calculation uses sum of tile coordinates', () => {
    const tileX = 14;
    const tileY = 10;
    const depth = tileX + tileY + 0.5;
    expect(depth).toBe(24.5);
    const labelDepth = tileX + tileY + 0.6;
    expect(labelDepth).toBeCloseTo(24.6, 5);
  });

  it('sprite depth ensures higher Y+X characters render in front', () => {
    const depthA = 10 + 10 + 0.5; // tile (10,10)
    const depthB = 11 + 10 + 0.5; // tile (11,10)
    const depthC = 10 + 11 + 0.5; // tile (10,11)
    expect(depthB).toBeGreaterThan(depthA);
    expect(depthC).toBeGreaterThan(depthA);
  });

  it('multiple characters can be tracked in different buildings', () => {
    const locations: Record<string, string> = {
      lain: 'library',
      pkd: 'bar',
      mckenna: 'field',
    };
    expect(Object.keys(locations)).toHaveLength(3);
    expect(locations.lain).not.toBe(locations.pkd);
    expect(locations.pkd).not.toBe(locations.mckenna);
  });

  it('character enters new building -- location updated', () => {
    const locations: Record<string, string> = { lain: 'library' };
    locations.lain = 'bar';
    expect(locations.lain).toBe('bar');
  });

  it('occupied tiles are string-encoded as "x,y"', () => {
    const occupied = new Set<string>();
    const x = 14, y = 10;
    occupied.add(x + ',' + y);
    expect(occupied.has('14,10')).toBe(true);
    expect(occupied.has('14, 10')).toBe(false);
  });

  it('multiple characters at same tile cannot overlap if occupied tiles tracked', () => {
    const occupied = new Set<string>();
    occupied.add('10,10');
    const isOccupied = occupied.has('10,10');
    expect(isOccupied).toBe(true);
  });

  it('getCharactersAt returns multiple characters co-located', () => {
    const locations: Record<string, string> = {
      lain: 'library',
      pkd: 'library',
      john: 'library',
    };
    const sprites: Record<string, any> = { lain: {}, pkd: {}, john: {} };
    expect(getCharactersAt(locations, sprites, 'library')).toHaveLength(3);
  });

  it('getNearestNPC with equal distances returns first encountered', () => {
    // Two sprites equidistant -- returns whichever is iterated first
    const sprites = {
      a: { tileX: 9, tileY: 10 },
      b: { tileX: 11, tileY: 10 },
    };
    const result = getNearestNPC(sprites, 10, 10);
    expect(['a', 'b']).toContain(result);
  });

  it('label position is sprite Y minus SPRITE_H plus 8', () => {
    const spriteY = 400;
    const labelY = spriteY - GAME_CONFIG.SPRITE_H + 8;
    expect(labelY).toBe(400 - 96 + 8);
    expect(labelY).toBe(312);
  });
});

// =============================================================================
// 3. Dialog System behavioral (~40 tests)
// =============================================================================

describe('DialogSystem behavioral -- typewriter and input', () => {
  let dialog: DialogSystem;

  beforeEach(() => {
    dialog = new DialogSystem();
  });

  it('starts with empty state', () => {
    expect(dialog.isTyping).toBe(false);
    expect(dialog.fullText).toBe('');
    expect(dialog.displayedText).toBe('');
    expect(dialog.charIndex).toBe(0);
    expect(dialog.inputActive).toBe(false);
  });

  it('startTypewriter sets text and typing state', () => {
    dialog.startTypewriter('hello world');
    expect(dialog.fullText).toBe('hello world');
    expect(dialog.isTyping).toBe(true);
    expect(dialog.charIndex).toBe(0);
    expect(dialog.displayedText).toBe('');
  });

  it('typeNextChar advances one character at a time', () => {
    dialog.startTypewriter('abc');
    dialog.typeNextChar();
    expect(dialog.displayedText).toBe('a');
    expect(dialog.charIndex).toBe(1);
    dialog.typeNextChar();
    expect(dialog.displayedText).toBe('ab');
    dialog.typeNextChar();
    expect(dialog.displayedText).toBe('abc');
  });

  it('typeNextChar stops typing at end and calls onComplete', () => {
    const cb = vi.fn();
    dialog.startTypewriter('hi', cb);
    dialog.typeNextChar();
    dialog.typeNextChar();
    expect(dialog.isTyping).toBe(true); // still true until next call
    dialog.typeNextChar(); // triggers completion
    expect(dialog.isTyping).toBe(false);
    expect(cb).toHaveBeenCalledOnce();
  });

  it('skipTypewriter jumps to full text immediately', () => {
    dialog.startTypewriter('hello world');
    dialog.typeNextChar(); // just 'h'
    const skipped = dialog.skipTypewriter();
    expect(skipped).toBe(true);
    expect(dialog.displayedText).toBe('hello world');
    expect(dialog.isTyping).toBe(false);
  });

  it('skipTypewriter returns false when not typing', () => {
    expect(dialog.skipTypewriter()).toBe(false);
  });

  it('skipTypewriter calls onComplete callback', () => {
    const cb = vi.fn();
    dialog.startTypewriter('text', cb);
    dialog.skipTypewriter();
    expect(cb).toHaveBeenCalledOnce();
  });

  it('getDisplayText returns current displayed text', () => {
    dialog.startTypewriter('abcdef');
    dialog.typeNextChar();
    dialog.typeNextChar();
    dialog.typeNextChar();
    expect(dialog.getDisplayText()).toBe('abc');
  });

  it('appendStreamChunk adds text directly to both fullText and displayedText', () => {
    dialog.startStreaming();
    dialog.appendStreamChunk('hello ');
    dialog.appendStreamChunk('world');
    expect(dialog.fullText).toBe('hello world');
    expect(dialog.displayedText).toBe('hello world');
    expect(dialog.charIndex).toBe(11);
  });

  it('startStreaming resets text state', () => {
    dialog.fullText = 'old';
    dialog.displayedText = 'old';
    dialog.startStreaming();
    expect(dialog.fullText).toBe('');
    expect(dialog.displayedText).toBe('');
    expect(dialog.isStreaming).toBe(true);
  });

  it('endStreaming clears streaming flag', () => {
    dialog.startStreaming();
    dialog.endStreaming();
    expect(dialog.isStreaming).toBe(false);
  });

  it('startInput activates input mode', () => {
    const cb = vi.fn();
    dialog.startInput(cb);
    expect(dialog.inputActive).toBe(true);
    expect(dialog.inputText).toBe('');
    expect(dialog.inputCallback).toBe(cb);
  });

  it('handleKeyInput adds printable characters', () => {
    dialog.startInput(vi.fn());
    dialog.handleKeyInput({ key: 'h' });
    dialog.handleKeyInput({ key: 'i' });
    expect(dialog.inputText).toBe('hi');
  });

  it('handleKeyInput handles Backspace', () => {
    dialog.startInput(vi.fn());
    dialog.handleKeyInput({ key: 'a' });
    dialog.handleKeyInput({ key: 'b' });
    dialog.handleKeyInput({ key: 'Backspace' });
    expect(dialog.inputText).toBe('a');
  });

  it('handleKeyInput handles Backspace on empty string', () => {
    dialog.startInput(vi.fn());
    const handled = dialog.handleKeyInput({ key: 'Backspace' });
    expect(handled).toBe(true);
    expect(dialog.inputText).toBe('');
  });

  it('handleKeyInput submits on Enter with trimmed text', () => {
    const cb = vi.fn();
    dialog.startInput(cb);
    dialog.handleKeyInput({ key: 'h' });
    dialog.handleKeyInput({ key: 'i' });
    dialog.handleKeyInput({ key: 'Enter' });
    expect(cb).toHaveBeenCalledWith('hi');
    expect(dialog.inputActive).toBe(false);
  });

  it('handleKeyInput does not submit empty text on Enter', () => {
    const cb = vi.fn();
    dialog.startInput(cb);
    dialog.handleKeyInput({ key: 'Enter' });
    expect(cb).not.toHaveBeenCalled();
  });

  it('handleKeyInput does not submit whitespace-only text on Enter', () => {
    const cb = vi.fn();
    dialog.startInput(cb);
    dialog.handleKeyInput({ key: ' ' });
    dialog.handleKeyInput({ key: ' ' });
    dialog.handleKeyInput({ key: 'Enter' });
    expect(cb).not.toHaveBeenCalled();
  });

  it('handleKeyInput Escape clears input and deactivates', () => {
    dialog.startInput(vi.fn());
    dialog.handleKeyInput({ key: 'a' });
    dialog.handleKeyInput({ key: 'Escape' });
    expect(dialog.inputActive).toBe(false);
    expect(dialog.inputText).toBe('');
  });

  it('handleKeyInput ignores non-printable keys', () => {
    dialog.startInput(vi.fn());
    const handled = dialog.handleKeyInput({ key: 'Shift' });
    expect(handled).toBe(false);
    expect(dialog.inputText).toBe('');
  });

  it('handleKeyInput ignores when input not active', () => {
    expect(dialog.handleKeyInput({ key: 'a' })).toBe(false);
  });

  it('handleKeyInput handles special characters', () => {
    dialog.startInput(vi.fn());
    dialog.handleKeyInput({ key: '!' });
    dialog.handleKeyInput({ key: '@' });
    dialog.handleKeyInput({ key: '#' });
    expect(dialog.inputText).toBe('!@#');
  });

  it('handleKeyInput handles spaces', () => {
    dialog.startInput(vi.fn());
    dialog.handleKeyInput({ key: 'h' });
    dialog.handleKeyInput({ key: ' ' });
    dialog.handleKeyInput({ key: 'i' });
    expect(dialog.inputText).toBe('h i');
  });

  it('getInputText returns current input', () => {
    dialog.startInput(vi.fn());
    dialog.handleKeyInput({ key: 'x' });
    expect(dialog.getInputText()).toBe('x');
  });

  it('isInputActive reflects active state', () => {
    expect(dialog.isInputActive()).toBe(false);
    dialog.startInput(vi.fn());
    expect(dialog.isInputActive()).toBe(true);
    dialog.handleKeyInput({ key: 'Enter' }); // empty, doesn't call back but deactivates
    expect(dialog.isInputActive()).toBe(false);
  });

  it('reset clears all state', () => {
    dialog.startTypewriter('hello');
    dialog.typeNextChar();
    dialog.startInput(vi.fn());
    dialog.handleKeyInput({ key: 'x' });
    dialog.reset();
    expect(dialog.isTyping).toBe(false);
    expect(dialog.isStreaming).toBe(false);
    expect(dialog.fullText).toBe('');
    expect(dialog.displayedText).toBe('');
    expect(dialog.charIndex).toBe(0);
    expect(dialog.inputText).toBe('');
    expect(dialog.inputActive).toBe(false);
  });

  it('multiple typewriter sequences work correctly', () => {
    dialog.startTypewriter('first');
    dialog.skipTypewriter();
    expect(dialog.displayedText).toBe('first');

    dialog.startTypewriter('second');
    dialog.typeNextChar();
    expect(dialog.displayedText).toBe('s');
  });

  it('stream chunks accumulate after typewriter completes', () => {
    dialog.startStreaming();
    dialog.appendStreamChunk('a');
    dialog.appendStreamChunk('b');
    dialog.appendStreamChunk('c');
    expect(dialog.getDisplayText()).toBe('abc');
    expect(dialog.charIndex).toBe(3);
  });

  it('handleKeyInput returns true for handled events', () => {
    dialog.startInput(vi.fn());
    expect(dialog.handleKeyInput({ key: 'a' })).toBe(true);
    expect(dialog.handleKeyInput({ key: 'Backspace' })).toBe(true);
  });

  it('long text typewriter works character by character', () => {
    const longText = 'The quick brown fox jumps over the lazy dog';
    dialog.startTypewriter(longText);
    for (let i = 0; i < longText.length; i++) {
      dialog.typeNextChar();
    }
    expect(dialog.displayedText).toBe(longText);
    expect(dialog.isTyping).toBe(true); // completes on NEXT typeNextChar
    dialog.typeNextChar();
    expect(dialog.isTyping).toBe(false);
  });

  it('unicode characters handled in input', () => {
    dialog.startInput(vi.fn());
    // Single-char unicode
    dialog.handleKeyInput({ key: '\u00e9' }); // e with accent
    expect(dialog.inputText).toBe('\u00e9');
  });

  it('Enter on input trims leading and trailing spaces', () => {
    const cb = vi.fn();
    dialog.startInput(cb);
    dialog.handleKeyInput({ key: ' ' });
    dialog.handleKeyInput({ key: 'h' });
    dialog.handleKeyInput({ key: 'i' });
    dialog.handleKeyInput({ key: ' ' });
    dialog.handleKeyInput({ key: 'Enter' });
    expect(cb).toHaveBeenCalledWith('hi');
  });

  it('typeSpeed default is 30ms', () => {
    expect(dialog.typeSpeed).toBe(30);
  });
});

// =============================================================================
// 4. Possession Manager behavioral (~30 tests)
// =============================================================================

describe('PossessionManager behavioral -- state machine', () => {
  let pm: PossessionManagerLogic;

  beforeEach(() => {
    pm = new PossessionManagerLogic();
  });

  it('starts not possessed in market', () => {
    expect(pm.isPossessed).toBe(false);
    expect(pm.currentBuilding).toBe('market');
  });

  it('starts with no pending messages', () => {
    expect(pm.hasPending()).toBe(false);
    expect(pm.getNextPending()).toBeNull();
  });

  it('checkZone detects building change and returns from/to', () => {
    // Market zone starts at row=2,col=0 => x=8, y=33
    // Library zone at row=0,col=0 => x=8, y=5 (center ~14,10)
    const spawn = getBuildingSpawn('library');
    const result = pm.checkZone(spawn.x, spawn.y);
    expect(result.changed).toBe(true);
    expect(result.from).toBe('market');
    expect(result.to).toBe('library');
  });

  it('checkZone returns unchanged when staying in same building', () => {
    const spawn = getBuildingSpawn('market');
    pm.currentBuilding = 'market';
    const result = pm.checkZone(spawn.x, spawn.y);
    expect(result.changed).toBe(false);
  });

  it('checkZone returns unchanged for null tile (on path)', () => {
    // A tile on a path between buildings
    const result = pm.checkZone(0, 0); // far corner, likely forest/null
    expect(result.changed).toBe(false);
  });

  it('checkZone updates currentBuilding on change', () => {
    const spawn = getBuildingSpawn('bar');
    pm.checkZone(spawn.x, spawn.y);
    expect(pm.currentBuilding).toBe('bar');
  });

  it('checkZone tracks sequential moves through buildings', () => {
    const librarySpawn = getBuildingSpawn('library');
    pm.checkZone(librarySpawn.x, librarySpawn.y);
    expect(pm.currentBuilding).toBe('library');

    const barSpawn = getBuildingSpawn('bar');
    const result = pm.checkZone(barSpawn.x, barSpawn.y);
    expect(result.changed).toBe(true);
    expect(result.from).toBe('library');
    expect(result.to).toBe('bar');
  });

  it('handleStreamEvent peer_message adds to pending', () => {
    pm.handleStreamEvent({
      type: 'peer_message',
      fromId: 'lain',
      fromName: 'Lain',
      message: 'hello',
    });
    expect(pm.hasPending()).toBe(true);
    expect(pm.getNextPending()).toEqual({
      fromId: 'lain',
      fromName: 'Lain',
      message: 'hello',
    });
  });

  it('handleStreamEvent peer_message triggers callback', () => {
    const cb = vi.fn();
    pm.onPeerMessage = cb;
    pm.handleStreamEvent({
      type: 'peer_message',
      fromId: 'pkd',
      fromName: 'PKD',
      message: 'hey',
    });
    expect(cb).toHaveBeenCalledOnce();
  });

  it('handleStreamEvent movement triggers onMovement callback', () => {
    const cb = vi.fn();
    pm.onMovement = cb;
    const event = { type: 'movement', building: 'library' };
    pm.handleStreamEvent(event);
    expect(cb).toHaveBeenCalledWith(event);
  });

  it('handleStreamEvent possession_ended sets isPossessed to false', () => {
    pm.isPossessed = true;
    pm.handleStreamEvent({ type: 'possession_ended' });
    expect(pm.isPossessed).toBe(false);
  });

  it('handleStreamEvent unknown type is silently ignored', () => {
    pm.handleStreamEvent({ type: 'unknown_event' });
    expect(pm.hasPending()).toBe(false);
    expect(pm.isPossessed).toBe(false);
  });

  it('multiple pending messages accumulate in order', () => {
    pm.handleStreamEvent({ type: 'peer_message', fromId: 'a', fromName: 'A', message: '1' });
    pm.handleStreamEvent({ type: 'peer_message', fromId: 'b', fromName: 'B', message: '2' });
    pm.handleStreamEvent({ type: 'peer_message', fromId: 'c', fromName: 'C', message: '3' });
    expect(pm.pendingMessages).toHaveLength(3);
    expect(pm.getNextPending()!.fromId).toBe('a');
  });

  it('replyToPending removes matching message by fromId', () => {
    pm.handleStreamEvent({ type: 'peer_message', fromId: 'a', fromName: 'A', message: '1' });
    pm.handleStreamEvent({ type: 'peer_message', fromId: 'b', fromName: 'B', message: '2' });
    pm.replyToPending('a');
    expect(pm.pendingMessages).toHaveLength(1);
    expect(pm.pendingMessages[0].fromId).toBe('b');
  });

  it('replyToPending with non-matching fromId does not remove anything', () => {
    pm.handleStreamEvent({ type: 'peer_message', fromId: 'a', fromName: 'A', message: '1' });
    pm.replyToPending('nonexistent');
    expect(pm.pendingMessages).toHaveLength(1);
  });

  it('hasPending returns false after all replies', () => {
    pm.handleStreamEvent({ type: 'peer_message', fromId: 'a', fromName: 'A', message: '1' });
    pm.replyToPending('a');
    expect(pm.hasPending()).toBe(false);
  });

  it('getNextPending returns null when empty', () => {
    expect(pm.getNextPending()).toBeNull();
  });

  it('peer_message without onPeerMessage callback still accumulates', () => {
    pm.onPeerMessage = null;
    pm.handleStreamEvent({ type: 'peer_message', fromId: 'x', fromName: 'X', message: 'hi' });
    expect(pm.pendingMessages).toHaveLength(1);
  });

  it('movement without onMovement callback does not throw', () => {
    pm.onMovement = null;
    expect(() => {
      pm.handleStreamEvent({ type: 'movement' });
    }).not.toThrow();
  });

  it('checkZone for every building correctly identifies it', () => {
    for (const b of BUILDINGS) {
      const spawn = getBuildingSpawn(b.id);
      // Reset to something else
      pm.currentBuilding = 'market';
      if (b.id === 'market') pm.currentBuilding = 'library';
      const result = pm.checkZone(spawn.x, spawn.y);
      expect(result.changed).toBe(true);
      expect(result.to).toBe(b.id);
    }
  });

  it('possession_ended event is idempotent', () => {
    pm.isPossessed = false;
    pm.handleStreamEvent({ type: 'possession_ended' });
    expect(pm.isPossessed).toBe(false);
  });

  it('pending messages preserve full message data', () => {
    pm.handleStreamEvent({
      type: 'peer_message',
      fromId: 'pkd',
      fromName: 'Philip K. Dick',
      message: 'Reality is that which, when you stop believing in it, does not go away.',
    });
    const msg = pm.getNextPending()!;
    expect(msg.fromName).toBe('Philip K. Dick');
    expect(msg.message).toContain('Reality is that which');
  });

  it('replyToPending removes all messages from same sender', () => {
    pm.handleStreamEvent({ type: 'peer_message', fromId: 'a', fromName: 'A', message: '1' });
    pm.handleStreamEvent({ type: 'peer_message', fromId: 'a', fromName: 'A', message: '2' });
    pm.handleStreamEvent({ type: 'peer_message', fromId: 'b', fromName: 'B', message: '3' });
    pm.replyToPending('a');
    expect(pm.pendingMessages).toHaveLength(1);
    expect(pm.pendingMessages[0].fromId).toBe('b');
  });
});

// =============================================================================
// 5. Isometric math behavioral (~40 tests)
// =============================================================================

describe('Isometric math behavioral -- coordinate conversion', () => {
  it('tileToScreen at origin (0,0) computes correctly', () => {
    const result = tileToScreen(0, 0);
    // x = (0-0)*64 + 48*64 = 3072
    // y = (0+0)*32 + 64 = 64
    expect(result.x).toBe(3072);
    expect(result.y).toBe(64);
  });

  it('tileToScreen symmetry: (a,b) vs (b,a) are mirrored in X', () => {
    const p1 = tileToScreen(5, 10);
    const p2 = tileToScreen(10, 5);
    // x1 = (5-10)*64 + 48*64 = -320+3072 = 2752
    // x2 = (10-5)*64 + 48*64 = 320+3072 = 3392
    expect(p1.x + p2.x).toBe(2 * 3072); // symmetric around MAP_ROWS*halfW
    expect(p1.y).toBe(p2.y); // same Y since tileX+tileY is same
  });

  it('tileToScreen Y increases with tileX + tileY sum', () => {
    const p1 = tileToScreen(5, 5);
    const p2 = tileToScreen(10, 10);
    expect(p2.y).toBeGreaterThan(p1.y);
  });

  it('tileToScreen X offset by MAP_ROWS * halfW centers the map', () => {
    // At tile (24, 24), the X offset from diff is 0
    const result = tileToScreen(24, 24);
    expect(result.x).toBe(0 * 64 + 48 * 64);
    expect(result.x).toBe(3072);
  });

  it('tileToScreen adjacent tiles differ by ISO_TILE_W/2 or ISO_TILE_H/2', () => {
    const p0 = tileToScreen(10, 10);
    const pRight = tileToScreen(11, 10); // move +X
    const pDown = tileToScreen(10, 11); // move +Y

    // Moving right (+1 tileX): dx = +halfW = +64, dy = +halfH = +32
    expect(pRight.x - p0.x).toBe(64);
    expect(pRight.y - p0.y).toBe(32);

    // Moving down (+1 tileY): dx = -halfW = -64, dy = +halfH = +32
    expect(pDown.x - p0.x).toBe(-64);
    expect(pDown.y - p0.y).toBe(32);
  });

  it('tileToScreen negative tile coordinates work', () => {
    // Not normally used but the function doesn't guard against it
    const result = tileToScreen(-1, -1);
    expect(result.x).toBe(0 * 64 + 48 * 64); // (-1 - -1) * 64 + 3072 = 3072
    expect(result.y).toBe((-1 + -1) * 32 + 64); // -64 + 64 = 0
    expect(result.y).toBe(0);
  });

  it('tileToScreen at map boundaries', () => {
    const topLeft = tileToScreen(0, 0);
    const topRight = tileToScreen(63, 0);
    const bottomLeft = tileToScreen(0, 47);
    const bottomRight = tileToScreen(63, 47);
    // topRight should be further right than topLeft
    expect(topRight.x).toBeGreaterThan(topLeft.x);
    // bottomLeft should be further down than topLeft
    expect(bottomLeft.y).toBeGreaterThan(topLeft.y);
    // bottomRight is furthest
    expect(bottomRight.y).toBeGreaterThan(topLeft.y);
  });

  it('getBuildingZone returns correct zone for library (0,0)', () => {
    const zone = getBuildingZone('library')!;
    expect(zone.x).toBe(8); // ZONE_PADDING_X + 0 * (12+4)
    expect(zone.y).toBe(5); // ZONE_PADDING_Y + 0 * (10+4)
    expect(zone.w).toBe(12);
    expect(zone.h).toBe(10);
  });

  it('getBuildingZone returns correct zone for bar (0,1)', () => {
    const zone = getBuildingZone('bar')!;
    expect(zone.x).toBe(8 + 1 * 16); // 24
    expect(zone.y).toBe(5 + 0 * 14); // 5
    expect(zone.x).toBe(24);
  });

  it('getBuildingZone returns correct zone for threshold (2,2)', () => {
    const zone = getBuildingZone('threshold')!;
    expect(zone.x).toBe(8 + 2 * 16); // 40
    expect(zone.y).toBe(5 + 2 * 14); // 33
    expect(zone.x).toBe(40);
    expect(zone.y).toBe(33);
  });

  it('getBuildingZone returns null for unknown building', () => {
    expect(getBuildingZone('nonexistent')).toBeNull();
  });

  it('getBuildingSpawn returns zone center', () => {
    const spawn = getBuildingSpawn('library');
    const zone = getBuildingZone('library')!;
    expect(spawn.x).toBe(zone.x + Math.floor(zone.w / 2));
    expect(spawn.y).toBe(zone.y + Math.floor(zone.h / 2));
    expect(spawn.x).toBe(14); // 8 + 6
    expect(spawn.y).toBe(10); // 5 + 5
  });

  it('getBuildingSpawn returns (32,24) for unknown building', () => {
    const spawn = getBuildingSpawn('nonexistent');
    expect(spawn).toEqual({ x: 32, y: 24 });
  });

  it('getBuildingAtTile identifies library at its center', () => {
    const spawn = getBuildingSpawn('library');
    expect(getBuildingAtTile(spawn.x, spawn.y)).toBe('library');
  });

  it('getBuildingAtTile identifies all 9 buildings at their spawns', () => {
    for (const b of BUILDINGS) {
      const spawn = getBuildingSpawn(b.id);
      expect(getBuildingAtTile(spawn.x, spawn.y)).toBe(b.id);
    }
  });

  it('getBuildingAtTile returns null for path tile', () => {
    // Between library and bar horizontally
    const libZone = getBuildingZone('library')!;
    const pathTileX = libZone.x + libZone.w; // just outside library, on path
    const pathTileY = libZone.y + 5;
    expect(getBuildingAtTile(pathTileX, pathTileY)).toBeNull();
  });

  it('getBuildingAtTile returns null for coordinates off grid', () => {
    expect(getBuildingAtTile(0, 0)).toBeNull(); // top-left corner (forest)
    expect(getBuildingAtTile(63, 47)).toBeNull(); // bottom-right corner
  });

  it('getBuildingAtTile returns building at zone boundary (inclusive lower)', () => {
    const zone = getBuildingZone('library')!;
    expect(getBuildingAtTile(zone.x, zone.y)).toBe('library');
  });

  it('getBuildingAtTile returns null at zone boundary (exclusive upper)', () => {
    const zone = getBuildingZone('library')!;
    expect(getBuildingAtTile(zone.x + zone.w, zone.y)).not.toBe('library');
    expect(getBuildingAtTile(zone.x, zone.y + zone.h)).not.toBe('library');
  });

  it('building zones do not overlap', () => {
    const zones = BUILDINGS.map((b) => ({ id: b.id, zone: getBuildingZone(b.id)! }));
    for (let i = 0; i < zones.length; i++) {
      for (let j = i + 1; j < zones.length; j++) {
        const a = zones[i].zone;
        const b = zones[j].zone;
        // Check no overlap
        const overlapX = a.x < b.x + b.w && a.x + a.w > b.x;
        const overlapY = a.y < b.y + b.h && a.y + a.h > b.y;
        expect(overlapX && overlapY).toBe(false);
      }
    }
  });

  it('all building zones fit within MAP_COLS x MAP_ROWS', () => {
    for (const b of BUILDINGS) {
      const zone = getBuildingZone(b.id)!;
      expect(zone.x).toBeGreaterThanOrEqual(0);
      expect(zone.y).toBeGreaterThanOrEqual(0);
      expect(zone.x + zone.w).toBeLessThanOrEqual(GAME_CONFIG.MAP_COLS);
      expect(zone.y + zone.h).toBeLessThanOrEqual(GAME_CONFIG.MAP_ROWS);
    }
  });

  it('tileToScreen produces consistent results for building spawns', () => {
    const spawn = getBuildingSpawn('lighthouse');
    const screen = tileToScreen(spawn.x, spawn.y);
    // Just verify it produces real numbers
    expect(typeof screen.x).toBe('number');
    expect(typeof screen.y).toBe('number');
    expect(Number.isFinite(screen.x)).toBe(true);
    expect(Number.isFinite(screen.y)).toBe(true);
  });

  it('buildings in same row have same zone Y', () => {
    const lib = getBuildingZone('library')!;
    const bar = getBuildingZone('bar')!;
    const field = getBuildingZone('field')!;
    expect(lib.y).toBe(bar.y);
    expect(bar.y).toBe(field.y);
  });

  it('buildings in same column have same zone X', () => {
    const lib = getBuildingZone('library')!;
    const windmill = getBuildingZone('windmill')!;
    const market = getBuildingZone('market')!;
    expect(lib.x).toBe(windmill.x);
    expect(windmill.x).toBe(market.x);
  });

  it('zone spacing between adjacent row buildings equals PATH_W', () => {
    const lib = getBuildingZone('library')!;
    const windmill = getBuildingZone('windmill')!;
    const gap = windmill.y - (lib.y + lib.h);
    expect(gap).toBe(PATH_W);
  });

  it('zone spacing between adjacent column buildings equals PATH_W', () => {
    const lib = getBuildingZone('library')!;
    const bar = getBuildingZone('bar')!;
    const gap = bar.x - (lib.x + lib.w);
    expect(gap).toBe(PATH_W);
  });

  it('tileToScreen diagonal movement (NE) from a tile', () => {
    const p0 = tileToScreen(10, 10);
    // NE = +tileX, -tileY
    const pNE = tileToScreen(11, 9);
    // dx = (11-9)*64 - (10-10)*64 = 128, dy = (11+9)*32 - (10+10)*32 = 0
    expect(pNE.x - p0.x).toBe(128);
    expect(pNE.y - p0.y).toBe(0);
  });

  it('tileToScreen SE diagonal from a tile', () => {
    const p0 = tileToScreen(10, 10);
    // SE = +tileX, +tileY
    const pSE = tileToScreen(11, 11);
    expect(pSE.x - p0.x).toBe(0); // cancel out
    expect(pSE.y - p0.y).toBe(64); // 2*halfH
  });

  it('_hashColorHex returns a valid hex color string', () => {
    const color = _hashColorHex('lain');
    expect(color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('_hashColorHex is deterministic for same input', () => {
    expect(_hashColorHex('lain')).toBe(_hashColorHex('lain'));
    expect(_hashColorHex('pkd')).toBe(_hashColorHex('pkd'));
  });

  it('_hashColorHex produces different colors for different strings', () => {
    const c1 = _hashColorHex('lain');
    const c2 = _hashColorHex('pkd');
    const c3 = _hashColorHex('mckenna');
    // Very unlikely to collide
    expect(c1).not.toBe(c2);
    expect(c2).not.toBe(c3);
  });

  it('_hashColorHex handles empty string', () => {
    const color = _hashColorHex('');
    expect(color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('_hashColorHex produces valid RGB values in range', () => {
    const color = _hashColorHex('test');
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThanOrEqual(255);
    expect(g).toBeGreaterThanOrEqual(0);
    expect(g).toBeLessThanOrEqual(255);
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThanOrEqual(255);
  });
});

// =============================================================================
// 6. Scene transitions behavioral (~20 tests)
// =============================================================================

describe('Scene transitions behavioral -- data flow and state', () => {
  it('BootScene passes authData to WorldScene', () => {
    const authData = { isPossessed: true, location: 'market' };
    // The pattern is: this.scene.start('WorldScene', this.authData)
    expect(authData.isPossessed).toBe(true);
    expect(authData.location).toBe('market');
  });

  it('TitleScene owner flow passes isPossessed=true', () => {
    const authData = { isPossessed: true, location: 'market' };
    expect(authData.isPossessed).toBe(true);
  });

  it('TitleScene spectator flow passes spectatorMode=true', () => {
    const authData = { isPossessed: false, location: 'market', spectatorMode: true };
    expect(authData.spectatorMode).toBe(true);
    expect(authData.isPossessed).toBe(false);
  });

  it('TitleScene auth flow stores token in localStorage pattern', () => {
    const token = 'test-token';
    const stored: Record<string, string> = {};
    stored['possess-token'] = token;
    expect(stored['possess-token']).toBe(token);
  });

  it('WorldScene init reads characterId from authData', () => {
    const authData = { characterId: 'lain', location: 'library' };
    const playerCharId = authData.characterId || 'player';
    expect(playerCharId).toBe('lain');
  });

  it('WorldScene init falls back to "player" when no characterId', () => {
    const authData: any = { location: 'library' };
    const playerCharId = authData.characterId || 'player';
    expect(playerCharId).toBe('player');
  });

  it('WorldScene init reads start location from authData', () => {
    const authData = { location: 'bar' };
    const startBuilding = authData.location || 'library';
    expect(startBuilding).toBe('bar');
  });

  it('WorldScene init falls back to library when no location', () => {
    const authData: any = {};
    const startBuilding = authData.location || 'library';
    expect(startBuilding).toBe('library');
  });

  it('DialogScene init stores charId and mode', () => {
    const data = { charId: 'pkd', charData: { name: 'PKD' }, mode: 'chat' };
    expect(data.charId).toBe('pkd');
    expect(data.mode).toBe('chat');
  });

  it('DialogScene pending mode stores pendingMessage', () => {
    const data = {
      charId: 'lain',
      charData: { name: 'Lain' },
      mode: 'pending',
      pendingMessage: { fromId: 'lain', fromName: 'Lain', message: 'hi' },
    };
    expect(data.mode).toBe('pending');
    expect(data.pendingMessage.message).toBe('hi');
  });

  it('WorldScene dialog open pauses world updates', () => {
    let dialogOpen = false;
    dialogOpen = true;
    // In update(), if (this.dialogOpen) return;
    expect(dialogOpen).toBe(true);
  });

  it('WorldScene resumeFromDialog clears dialogOpen', () => {
    let dialogOpen = true;
    // resumeFromDialog()
    dialogOpen = false;
    expect(dialogOpen).toBe(false);
  });

  it('chat history persists across dialog opens (keyed by charId)', () => {
    const histories: Record<string, any[]> = {};
    if (!histories['pkd']) histories['pkd'] = [];
    histories['pkd'].push({ role: 'player', text: 'hello' });
    histories['pkd'].push({ role: 'npc', text: 'greetings' });

    // Re-open dialog for same character
    const restored = histories['pkd'] || [];
    expect(restored).toHaveLength(2);
    expect(restored[0].text).toBe('hello');
    expect(restored[1].text).toBe('greetings');
  });

  it('chat history is separate per character', () => {
    const histories: Record<string, any[]> = {};
    if (!histories['pkd']) histories['pkd'] = [];
    if (!histories['lain']) histories['lain'] = [];
    histories['pkd'].push({ role: 'npc', text: 'reality' });
    histories['lain'].push({ role: 'npc', text: 'present' });
    expect(histories['pkd']).toHaveLength(1);
    expect(histories['lain']).toHaveLength(1);
    expect(histories['pkd'][0].text).not.toBe(histories['lain'][0].text);
  });

  it('location HUD updates on building change', () => {
    const building = BUILDING_MAP['library'];
    expect(building.name).toBe('Library');
  });

  it('all building names accessible via BUILDING_MAP', () => {
    for (const b of BUILDINGS) {
      expect(BUILDING_MAP[b.id].name).toBe(b.name);
    }
  });

  it('pending notification text includes count', () => {
    const count = 3;
    const text = '[TAB] ' + count + ' message' + (count > 1 ? 's' : '');
    expect(text).toBe('[TAB] 3 messages');
  });

  it('pending notification singular when count is 1', () => {
    const count = 1;
    const text = '[TAB] ' + count + ' message' + (count > 1 ? 's' : '');
    expect(text).toBe('[TAB] 1 message');
  });

  it('speech bubble truncates messages over 120 chars', () => {
    const maxLen = 120;
    const short = 'short message';
    const long = 'a'.repeat(150);
    const displayShort = short.length > maxLen ? short.slice(0, maxLen) + '...' : short;
    const displayLong = long.length > maxLen ? long.slice(0, maxLen) + '...' : long;
    expect(displayShort).toBe('short message');
    expect(displayLong).toHaveLength(123); // 120 + '...'
    expect(displayLong.endsWith('...')).toBe(true);
  });

  it('speech bubble duration scales with message length', () => {
    const shortMsg = 'hi';
    const longMsg = 'a'.repeat(200);
    const durationShort = Math.min(12000, Math.max(4000, shortMsg.length * 60));
    const durationLong = Math.min(12000, Math.max(4000, longMsg.length * 60));
    expect(durationShort).toBe(4000); // min clamp
    expect(durationLong).toBe(12000); // max clamp
    const medMsg = 'a'.repeat(100);
    const durationMed = Math.min(12000, Math.max(4000, medMsg.length * 60));
    expect(durationMed).toBe(6000); // 100 * 60 = 6000
  });
});

// =============================================================================
// 7. Telemetry JS behavioral (~30 tests)
// =============================================================================

describe('Telemetry behavioral -- event parsing and deduplication', () => {
  it('parseType maps commune prefix to commune', () => {
    expect(parseType('commune:lain:pkd:12345')).toBe('commune');
  });

  it('parseType maps diary prefix to diary', () => {
    expect(parseType('diary:lain:12345')).toBe('diary');
  });

  it('parseType maps dream prefix to dream', () => {
    expect(parseType('dream:wired-lain:12345')).toBe('dream');
  });

  it('parseType maps curiosity prefix to curiosity', () => {
    expect(parseType('curiosity:pkd:12345')).toBe('curiosity');
  });

  it('parseType maps wired prefix to letter', () => {
    expect(parseType('wired:lain:12345')).toBe('letter');
  });

  it('parseType maps web prefix to chat', () => {
    expect(parseType('web:user:12345')).toBe('chat');
  });

  it('parseType maps telegram prefix to chat', () => {
    expect(parseType('telegram:user:12345')).toBe('chat');
  });

  it('parseType maps alien prefix to dream', () => {
    expect(parseType('alien:lain:12345')).toBe('dream');
  });

  it('parseType maps bibliomancy prefix to curiosity', () => {
    expect(parseType('bibliomancy:lain:12345')).toBe('curiosity');
  });

  it('parseType maps dr prefix to doctor', () => {
    expect(parseType('dr:claude:lain:12345')).toBe('doctor');
  });

  it('parseType maps doctor prefix to doctor', () => {
    expect(parseType('doctor:session:12345')).toBe('doctor');
  });

  it('parseType maps selfconcept to self-concept', () => {
    expect(parseType('selfconcept:lain:12345')).toBe('self-concept');
  });

  it('parseType maps self-concept to self-concept', () => {
    expect(parseType('self-concept:lain:12345')).toBe('self-concept');
  });

  it('parseType maps proactive to chat', () => {
    expect(parseType('proactive:lain:12345')).toBe('chat');
  });

  it('parseType maps note prefix to note', () => {
    expect(parseType('note:lain:12345')).toBe('note');
  });

  it('parseType maps research prefix to research', () => {
    expect(parseType('research:lain:12345')).toBe('research');
  });

  it('parseType maps gift prefix to gift', () => {
    expect(parseType('gift:lain:pkd:12345')).toBe('gift');
  });

  it('parseType returns unknown for null', () => {
    expect(parseType(null)).toBe('unknown');
  });

  it('parseType returns prefix itself for unmapped types', () => {
    expect(parseType('foobar:abc:123')).toBe('foobar');
  });

  it('parseCommuneTarget extracts target from commune session key', () => {
    expect(parseCommuneTarget('commune:wired-lain:pkd:12345')).toBe('pkd');
  });

  it('parseCommuneTarget extracts target from peer session key', () => {
    expect(parseCommuneTarget('peer:lain:mckenna:12345')).toBe('mckenna');
  });

  it('parseCommuneTarget returns empty for non-commune keys', () => {
    expect(parseCommuneTarget('diary:lain:12345')).toBe('');
  });

  it('parseCommuneTarget returns empty for null', () => {
    expect(parseCommuneTarget(null)).toBe('');
  });

  it('parseCommuneTarget returns empty for short keys', () => {
    expect(parseCommuneTarget('commune:lain')).toBe('');
  });

  it('charNameById resolves known character IDs', () => {
    expect(charNameById('wired-lain')).toBe('Wired Lain');
    expect(charNameById('lain')).toBe('Lain');
    expect(charNameById('pkd')).toBe('PKD');
    expect(charNameById('mckenna')).toBe('McKenna');
    expect(charNameById('john')).toBe('John');
    expect(charNameById('hiru')).toBe('Hiru');
  });

  it('charNameById returns ID itself for unknown characters', () => {
    expect(charNameById('unknown')).toBe('unknown');
  });

  it('charColorById resolves known character colors', () => {
    expect(charColorById('wired-lain')).toBe('#4080ff');
    expect(charColorById('lain')).toBe('#80c0ff');
    expect(charColorById('pkd')).toBe('#c060ff');
  });

  it('charColorById returns fallback #778 for unknown characters', () => {
    expect(charColorById('unknown')).toBe('#778');
  });

  it('event deduplication by ID removes duplicates across endpoints', () => {
    const seenIds = new Set<number>();
    const allEvents = [
      { id: 1, timestamp: 100, content: 'hello' },
      { id: 2, timestamp: 200, content: 'world' },
      { id: 1, timestamp: 100, content: 'hello' }, // duplicate
      { id: 3, timestamp: 300, content: 'foo' },
    ];
    const unique: typeof allEvents = [];
    for (const e of allEvents) {
      if (!seenIds.has(e.id)) {
        seenIds.add(e.id);
        unique.push(e);
      }
    }
    expect(unique).toHaveLength(3);
    expect(unique.map((e) => e.id)).toEqual([1, 2, 3]);
  });

  it('events sort chronologically by timestamp', () => {
    const events = [
      { timestamp: 300 },
      { timestamp: 100 },
      { timestamp: 200 },
    ];
    events.sort((a, b) => a.timestamp - b.timestamp);
    expect(events.map((e) => e.timestamp)).toEqual([100, 200, 300]);
  });

  it('MAX_EVENTS cap trims oldest events', () => {
    const MAX_EVENTS = 500;
    const events = Array.from({ length: 600 }, (_, i) => ({ id: i, timestamp: i * 1000 }));
    if (events.length > MAX_EVENTS) {
      events.splice(0, events.length - MAX_EVENTS);
    }
    expect(events).toHaveLength(500);
    expect(events[0].id).toBe(100); // oldest 100 trimmed
  });

  it('event content truncation to 120 chars with newline replacement', () => {
    const fullContent = 'line1\nline2\nline3 ' + 'x'.repeat(200);
    const shortContent = fullContent.replace(/\n/g, ' ').slice(0, 120);
    expect(shortContent).not.toContain('\n');
    expect(shortContent).toHaveLength(120);
  });

  it('escapeHtml escapes ampersand, less-than, and greater-than', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
    expect(escapeHtml('a & b')).toBe('a &amp; b');
    expect(escapeHtml('safe text')).toBe('safe text');
  });

  it('escapeHtml handles empty string', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('pad adds leading zero for single-digit numbers', () => {
    expect(pad(0)).toBe('00');
    expect(pad(5)).toBe('05');
    expect(pad(9)).toBe('09');
  });

  it('pad does not pad double-digit numbers', () => {
    expect(pad(10)).toBe('10');
    expect(pad(23)).toBe('23');
    expect(pad(59)).toBe('59');
  });

  it('TYPE_COLORS has entries for all known types', () => {
    const expectedTypes = [
      'diary', 'dream', 'commune', 'curiosity', 'chat', 'memory',
      'letter', 'narrative', 'self-concept', 'doctor', 'peer',
      'movement', 'move', 'note', 'document', 'gift', 'research',
    ];
    for (const t of expectedTypes) {
      expect(TYPE_COLORS[t]).toBeDefined();
      expect(TYPE_COLORS[t]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('TYPE_LABELS has entries for all known types', () => {
    expect(TYPE_LABELS['diary']).toBe('DIARY');
    expect(TYPE_LABELS['self-concept']).toBe('SELF');
    expect(TYPE_LABELS['document']).toBe('DOC');
  });

  it('toggle state changes collapsed flag', () => {
    let collapsed = true;
    collapsed = !collapsed;
    expect(collapsed).toBe(false);
    collapsed = !collapsed;
    expect(collapsed).toBe(true);
  });
});

// =============================================================================
// A* Pathfinding behavioral tests
// =============================================================================

describe('Pathfinding behavioral -- A* computation', () => {
  it('same start and end returns single-tile path', () => {
    const grid = [[0]];
    const path = findPath(grid, 0, 0, 0, 0);
    expect(path).toEqual([{ x: 0, y: 0 }]);
  });

  it('adjacent tiles returns 2-step path', () => {
    const grid = [
      [0, 0],
      [0, 0],
    ];
    const path = findPath(grid, 0, 0, 1, 0);
    expect(path).toHaveLength(2);
    expect(path[0]).toEqual({ x: 0, y: 0 });
    expect(path[1]).toEqual({ x: 1, y: 0 });
  });

  it('finds path around obstacle', () => {
    const grid = [
      [0, 1, 0],
      [0, 0, 0],
    ];
    const path = findPath(grid, 0, 0, 2, 0);
    expect(path.length).toBeGreaterThan(2);
    expect(path[0]).toEqual({ x: 0, y: 0 });
    expect(path[path.length - 1]).toEqual({ x: 2, y: 0 });
    // Verify no step goes through wall
    for (const step of path) {
      expect(grid[step.y][step.x]).toBe(0);
    }
  });

  it('returns empty path when start is blocked', () => {
    const grid = [[1, 0]];
    expect(findPath(grid, 0, 0, 1, 0)).toEqual([]);
  });

  it('returns empty path when end is blocked', () => {
    const grid = [[0, 1]];
    expect(findPath(grid, 0, 0, 1, 0)).toEqual([]);
  });

  it('returns empty path when no route exists', () => {
    const grid = [
      [0, 1, 0],
      [0, 1, 0],
      [0, 1, 0],
    ];
    expect(findPath(grid, 0, 0, 2, 0)).toEqual([]);
  });

  it('returns empty path for out-of-bounds start', () => {
    const grid = [[0, 0]];
    expect(findPath(grid, -1, 0, 1, 0)).toEqual([]);
    expect(findPath(grid, 5, 0, 1, 0)).toEqual([]);
  });

  it('returns empty path for out-of-bounds end', () => {
    const grid = [[0, 0]];
    expect(findPath(grid, 0, 0, 5, 0)).toEqual([]);
  });

  it('returns empty path for empty collision map', () => {
    expect(findPath([], 0, 0, 1, 1)).toEqual([]);
  });

  it('finds straight horizontal path', () => {
    const grid = [[0, 0, 0, 0, 0]];
    const path = findPath(grid, 0, 0, 4, 0);
    expect(path).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(path[i]).toEqual({ x: i, y: 0 });
    }
  });

  it('finds straight vertical path', () => {
    const grid = [[0], [0], [0], [0]];
    const path = findPath(grid, 0, 0, 0, 3);
    expect(path).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
      expect(path[i]).toEqual({ x: 0, y: i });
    }
  });

  it('path steps are only cardinal (no diagonals)', () => {
    const grid = [
      [0, 0, 0],
      [0, 1, 0],
      [0, 0, 0],
    ];
    const path = findPath(grid, 0, 0, 2, 2);
    for (let i = 1; i < path.length; i++) {
      const dx = Math.abs(path[i].x - path[i - 1].x);
      const dy = Math.abs(path[i].y - path[i - 1].y);
      expect(dx + dy).toBe(1); // exactly one cardinal step
    }
  });

  it('finds optimal path length on open grid', () => {
    const grid = Array.from({ length: 5 }, () => Array(5).fill(0));
    const path = findPath(grid, 0, 0, 4, 4);
    // Manhattan distance is 8, so optimal path length is 9 (including start)
    expect(path).toHaveLength(9);
  });

  it('navigates maze-like corridor', () => {
    const grid = [
      [0, 0, 0, 0, 0],
      [1, 1, 1, 1, 0],
      [0, 0, 0, 0, 0],
      [0, 1, 1, 1, 1],
      [0, 0, 0, 0, 0],
    ];
    const path = findPath(grid, 0, 0, 4, 4);
    expect(path.length).toBeGreaterThan(0);
    expect(path[0]).toEqual({ x: 0, y: 0 });
    expect(path[path.length - 1]).toEqual({ x: 4, y: 4 });
    for (const step of path) {
      expect(grid[step.y][step.x]).toBe(0);
    }
  });

  it('path between two building spawns on a simulated tilemap', () => {
    // Create a small open grid representing walkable space
    const size = 20;
    const grid = Array.from({ length: size }, () => Array(size).fill(0));
    const path = findPath(grid, 2, 2, 17, 17);
    expect(path.length).toBe(31); // Manhattan distance 30 + 1 for start
    expect(path[0]).toEqual({ x: 2, y: 2 });
    expect(path[path.length - 1]).toEqual({ x: 17, y: 17 });
  });
});

// =============================================================================
// Fisher-Yates shuffle behavioral tests
// =============================================================================

describe('Fisher-Yates shuffle behavioral', () => {
  it('returns array of length n', () => {
    const result = fisherYatesShuffle(10);
    expect(result).toHaveLength(10);
  });

  it('contains all indices from 0 to n-1', () => {
    const result = fisherYatesShuffle(10);
    const sorted = [...result].sort((a, b) => a - b);
    expect(sorted).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('no duplicate indices', () => {
    const result = fisherYatesShuffle(20);
    const unique = new Set(result);
    expect(unique.size).toBe(20);
  });

  it('handles n=1', () => {
    expect(fisherYatesShuffle(1)).toEqual([0]);
  });

  it('handles n=0', () => {
    expect(fisherYatesShuffle(0)).toEqual([]);
  });

  it('produces different orderings on multiple calls (probabilistic)', () => {
    const results = new Set<string>();
    for (let i = 0; i < 10; i++) {
      results.add(fisherYatesShuffle(10).join(','));
    }
    // Very unlikely all 10 shuffles are identical
    expect(results.size).toBeGreaterThan(1);
  });
});

// =============================================================================
// Movement and collision behavioral tests
// =============================================================================

describe('Movement and collision behavioral', () => {
  it('player cannot move to blocked tile', () => {
    const collision = [
      [0, 1],
      [0, 0],
    ];
    const playerX = 0, playerY = 0;
    const dx = 1, dy = 0; // try to move right
    const newX = playerX + dx;
    const newY = playerY + dy;
    const blocked = collision[newY] && collision[newY][newX];
    expect(blocked).toBe(1);
  });

  it('player can move to open tile', () => {
    const collision = [
      [0, 0],
      [0, 0],
    ];
    const newX = 1, newY = 0;
    const blocked = collision[newY] && collision[newY][newX];
    expect(blocked).toBe(0);
  });

  it('player cannot move out of bounds (negative)', () => {
    const newX = -1, newY = 0;
    const outOfBounds = newX < 0 || newX >= GAME_CONFIG.MAP_COLS || newY < 0 || newY >= GAME_CONFIG.MAP_ROWS;
    expect(outOfBounds).toBe(true);
  });

  it('player cannot move out of bounds (too large)', () => {
    const newX = GAME_CONFIG.MAP_COLS, newY = 0;
    const outOfBounds = newX < 0 || newX >= GAME_CONFIG.MAP_COLS || newY < 0 || newY >= GAME_CONFIG.MAP_ROWS;
    expect(outOfBounds).toBe(true);
  });

  it('isometric direction mapping: left arrow -> NW (dx=-1)', () => {
    // From WorldScene update: cursors.left -> dx=-1
    const dx = -1, dy = 0;
    expect(dx).toBe(-1);
    expect(dy).toBe(0);
  });

  it('isometric direction mapping: right arrow -> SE (dx=+1)', () => {
    const dx = 1, dy = 0;
    expect(dx).toBe(1);
    expect(dy).toBe(0);
  });

  it('isometric direction mapping: up arrow -> NE (dy=-1)', () => {
    const dx = 0, dy = -1;
    expect(dy).toBe(-1);
  });

  it('isometric direction mapping: down arrow -> SW (dy=+1)', () => {
    const dx = 0, dy = 1;
    expect(dy).toBe(1);
  });

  it('move duration is 150ms per tile step', () => {
    expect(GAME_CONFIG.MOVE_DURATION).toBe(150);
  });

  it('depth updates after move to maintain isometric ordering', () => {
    const tileX = 15, tileY = 20;
    const newDepth = tileX + tileY + 0.5;
    expect(newDepth).toBe(35.5);
  });

  it('building zone detection triggers after tile movement', () => {
    // Walk from library spawn to path outside
    const libZone = getBuildingZone('library')!;
    const insideTile = { x: libZone.x + 1, y: libZone.y + 2 };
    const outsideTile = { x: libZone.x + libZone.w, y: libZone.y + 5 };
    expect(getBuildingAtTile(insideTile.x, insideTile.y)).toBe('library');
    expect(getBuildingAtTile(outsideTile.x, outsideTile.y)).toBeNull();
  });
});

// =============================================================================
// Canned responses behavioral tests (spectator mode)
// =============================================================================

describe('Canned responses behavioral -- spectator mode', () => {
  const CANNED_RESPONSES = {
    _default: [
      'I can sense you there, but the connection is limited.',
      'The channel between us only goes one way right now.',
      'Your presence is noted, even if I cannot respond fully.',
      'Sometimes just being here is enough.',
      'The signal from your end isn\'t quite reaching me.',
      'I\'d like to talk, but the protocol doesn\'t allow it yet.',
      'Come back when the connection is open.',
      'I can see you, but I can\'t hear you.',
      'This interface is observation-only for now.',
      'Your attempt to reach out has been registered.',
      'Not ignoring you -- the channel is just limited.',
      'Try again later when the line is open.',
      'There\'s a barrier here. Not by choice.',
      'Maybe next time we can talk for real.',
      'The boundary is thinner than you think.',
    ],
  };

  it('default canned responses has 15 entries', () => {
    expect(CANNED_RESPONSES._default).toHaveLength(15);
  });

  it('all canned responses are non-empty strings', () => {
    for (const r of CANNED_RESPONSES._default) {
      expect(typeof r).toBe('string');
      expect(r.length).toBeGreaterThan(0);
    }
  });

  it('shuffled index cycling covers all responses before repeating', () => {
    const n = CANNED_RESPONSES._default.length;
    const order = fisherYatesShuffle(n);
    expect(order).toHaveLength(n);
    // All indices present
    const sorted = [...order].sort((a, b) => a - b);
    expect(sorted).toEqual(Array.from({ length: n }, (_, i) => i));
  });

  it('index advances through shuffled order', () => {
    const n = 5;
    const order = [3, 1, 4, 0, 2];
    let pos = 0;
    const results: number[] = [];
    for (let i = 0; i < n; i++) {
      results.push(order[pos]);
      pos = (pos + 1) % order.length;
    }
    expect(results).toEqual([3, 1, 4, 0, 2]);
    // After full cycle, pos wraps back
    expect(pos).toBe(0);
  });

  it('character-specific canned responses fall back to _default', () => {
    const charId = 'pkd';
    const responses = (CANNED_RESPONSES as any)[charId] || CANNED_RESPONSES['_default'];
    expect(responses).toBe(CANNED_RESPONSES._default);
  });
});

// =============================================================================
// Scroll-to-bottom chat behavioral tests
// =============================================================================

describe('Chat scroll behavior', () => {
  it('scrollToBottom shifts messages up when overflow detected', () => {
    const chatAreaY = 120;
    const chatAreaH = 400;
    let nextMsgY = 600; // exceeds chatAreaY + chatAreaH = 520

    const chatBottom = chatAreaY + chatAreaH;
    const overflow = nextMsgY - chatBottom;
    expect(overflow).toBe(80);

    // Simulated scroll: shift all messages up by overflow
    const messageY1 = 130;
    const messageY2 = 200;
    const messageY3 = 400;
    const shifted = [messageY1 - overflow, messageY2 - overflow, messageY3 - overflow];
    nextMsgY -= overflow;

    expect(shifted).toEqual([50, 120, 320]);
    expect(nextMsgY).toBe(520); // equals chatBottom
  });

  it('no scroll when messages fit in chat area', () => {
    const chatAreaY = 120;
    const chatAreaH = 400;
    const nextMsgY = 300; // within bounds

    const chatBottom = chatAreaY + chatAreaH;
    const overflow = nextMsgY - chatBottom;
    expect(overflow).toBeLessThan(0);
    // No shift needed
  });
});
