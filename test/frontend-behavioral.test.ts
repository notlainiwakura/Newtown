/** Frontend Behavioral Tests — verifies JS source patterns and API contracts. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PUBLIC_DIR = join(process.cwd(), 'src/web/public');

function readPublic(rel: string): string {
  return readFileSync(join(PUBLIC_DIR, rel), 'utf-8');
}

const appSrc = readPublic('app.js');
const communeMapSrc = readPublic('commune-map.js');
const dashboardSrc = readPublic('dashboard.html');
const communeMapHtml = readPublic('commune-map.html');

// ============================================================================
// 1. CHAT CLIENT BEHAVIOR (app.js)
// ============================================================================

describe('Chat client — API request format', () => {
  it('sends POST to /api/chat/stream for streaming', () => {
    expect(appSrc).toContain('/api/chat/stream');
    expect(appSrc).toMatch(/method.*POST/);
  });

  it('sets Content-Type application/json', () => {
    expect(appSrc).toContain("'Content-Type': 'application/json'");
  });

  it('sends message, sessionId, and senderName in payload', () => {
    expect(appSrc).toContain('message,');
    expect(appSrc).toContain('sessionId');
    expect(appSrc).toContain('senderName');
    expect(appSrc).toContain('JSON.stringify(payload)');
  });

  it('supports non-streaming /api/chat endpoint', () => {
    expect(appSrc).toContain('/api/chat\'');
  });

  it('derives API base from location.pathname', () => {
    expect(appSrc).toContain('location.pathname');
    expect(appSrc).toContain('apiBase');
  });
});

describe('Chat client — session ID management', () => {
  it('reads session ID from localStorage on load and returns null when absent', () => {
    // findings.md P2:3206 — sessionId reads go through readSession(),
    // which reads the structured {id, createdAt, owner} payload from
    // localStorage and returns null when the key is missing, the TTL
    // has elapsed, or the owner flag changed.
    expect(appSrc).toMatch(/function readSession\(key, owner\)/);
    expect(appSrc).toMatch(/localStorage\.getItem\(key\)/);
    expect(appSrc).toMatch(/if \(!raw\) return null;/);
    expect(appSrc).toMatch(/let sessionId = readSession\(sessionStorageKey, IS_OWNER\)/);
  });

  it('persists session ID to localStorage via writeSession when received from server', () => {
    // findings.md P2:3206 — writes go through writeSession(key, id, owner)
    // which serializes {id, createdAt, owner} so stale/cross-identity
    // sessions can be dropped client-side.
    expect(appSrc).toContain('writeSession(sessionStorageKey, sessionId, IS_OWNER)');
    expect(appSrc).toMatch(/function writeSession\(key, id, owner\)/);
    expect(appSrc).toMatch(/localStorage\.setItem\(key, JSON\.stringify\(\{ id, createdAt: Date\.now\(\), owner:/);
  });

  it('uses separate storage keys for Wired Lain vs Lain', () => {
    expect(appSrc).toContain("'wired-lain-session'");
    expect(appSrc).toContain("'lain-session'");
  });

  it('detects character identity from URL path', () => {
    expect(appSrc).toContain('isWiredLain');
    expect(appSrc).toContain('sessionStorageKey');
  });
});

describe('Chat client — empty message guard', () => {
  it('trims message before checking emptiness', () => {
    expect(appSrc).toContain('.trim()');
  });

  it('requires message or image to submit', () => {
    expect(appSrc).toContain('if (!message && !image) return');
  });
});

describe('Chat client — SSE streaming', () => {
  it('reads from response.body.getReader() with TextDecoder', () => {
    expect(appSrc).toContain('response.body.getReader()');
    expect(appSrc).toContain('new TextDecoder()');
  });

  it('splits lines on newline and buffers partial lines', () => {
    expect(appSrc).toContain("split('\\n')");
    expect(appSrc).toContain('lines.pop()');
  });

  it('detects SSE lines starting with "data: "', () => {
    expect(appSrc).toContain("startsWith('data: ')");
    expect(appSrc).toContain('JSON.parse(line.slice(6))');
  });

  it('handles all 4 SSE event types: session, chunk, done, error', () => {
    expect(appSrc).toContain("data.type === 'session'");
    expect(appSrc).toContain("data.type === 'chunk'");
    expect(appSrc).toContain("data.type === 'done'");
    expect(appSrc).toContain("data.type === 'error'");
  });

  it('stores session ID from session event', () => {
    expect(appSrc).toContain('sessionId = data.sessionId');
  });

  it('appends chunk content to accumulated text', () => {
    expect(appSrc).toContain('onChunk(data.content)');
  });
});

describe('Chat client — XSS prevention', () => {
  it('escapes HTML using textContent trick', () => {
    expect(appSrc).toContain('function escapeHtml');
    expect(appSrc).toContain('div.textContent = text');
    expect(appSrc).toContain('return div.innerHTML');
  });

  it('applies escapeHtml to user text and sender name', () => {
    expect(appSrc).toContain('escapeHtml(content)');
    expect(appSrc).toContain('escapeHtml(visitorName)');
  });
});

describe('Chat client — response display', () => {
  it('defines formatLainResponse for character message formatting', () => {
    expect(appSrc).toContain('function formatLainResponse');
    expect(appSrc).toContain("replace(/\\n/g, '<br>')");
  });

  it('accumulates streaming chunks and scrolls to bottom', () => {
    expect(appSrc).toContain('fullText += chunk');
    expect(appSrc).toContain('scrollToBottom()');
  });

  it('creates error message element on failure', () => {
    expect(appSrc).toContain("'error'");
    expect(appSrc).toContain('onError');
  });
});

describe('Chat client — owner vs spectator mode', () => {
  it('reads IS_OWNER from lain-owner meta tag', () => {
    expect(appSrc).toContain('meta[name="lain-owner"]');
    expect(appSrc).toContain("content === 'true'");
  });

  it('hides chat form and shows notice for spectators', () => {
    expect(appSrc).toContain("chatForm.style.display = 'none'");
    expect(appSrc).toContain('observing the wired');
    expect(appSrc).toContain('if (!IS_OWNER) return');
  });
});

describe('Chat client — image support', () => {
  it('converts image to base64 and includes in payload', () => {
    expect(appSrc).toContain('processImageFile');
    expect(appSrc).toContain("split(',')[1]");
    expect(appSrc).toContain('payload.image');
  });

  it('supports paste-to-upload and drag-and-drop', () => {
    expect(appSrc).toContain("'paste'");
    expect(appSrc).toContain("'drop'");
    expect(appSrc).toContain("startsWith('image/')");
  });

  it('clears pending image after send', () => {
    expect(appSrc).toContain('clearPendingImage()');
  });
});

// ============================================================================
// 2. COMMUNE MAP BEHAVIOR (commune-map.js)
// ============================================================================

describe('Commune map — character manifest loading', () => {
  it('fetches /api/characters on load', () => {
    expect(communeMapSrc).toContain("fetch('/api/characters')");
    expect(communeMapSrc).toContain('data.characters');
  });

  it('extracts defaultLocation and builds character entries', () => {
    expect(communeMapSrc).toContain('c.defaultLocation');
    expect(communeMapSrc).toContain('id: c.id, name: c.name, color');
  });

  it('calls loadCharactersFromManifest then init', () => {
    expect(communeMapSrc).toContain('await loadCharactersFromManifest()');
  });
});

describe('Commune map — building grid', () => {
  it('defines all 9 buildings in BUILDING_META', () => {
    const ids = ['library', 'bar', 'field', 'windmill', 'lighthouse', 'school', 'market', 'locksmith', 'threshold'];
    for (const id of ids) expect(communeMapSrc).toContain(`id: '${id}'`);
  });

  it('places buildings in a 3x3 grid (rows 0-2, cols 0-2)', () => {
    expect(communeMapSrc).toMatch(/library.*row:\s*0.*col:\s*0/s);
    expect(communeMapSrc).toMatch(/lighthouse.*row:\s*1.*col:\s*1/s);
    expect(communeMapSrc).toMatch(/threshold.*row:\s*2.*col:\s*2/s);
  });

  it('creates building-cell divs with data-building attribute', () => {
    expect(communeMapSrc).toContain('building-cell');
    expect(communeMapSrc).toContain('data-building');
  });
});

describe('Commune map — character placement', () => {
  it('initializes locations from defaults, falls back to lighthouse', () => {
    expect(communeMapSrc).toContain('DEFAULT_LOCATIONS');
    expect(communeMapSrc).toContain("|| 'lighthouse'");
  });

  it('fetches actual locations from character /api/location paths', () => {
    expect(communeMapSrc).toContain('char.locationPath');
    expect(communeMapSrc).toContain('/api/location');
  });

  it('skips characters without building or missing container', () => {
    expect(communeMapSrc).toContain('if (!buildingId) continue');
    expect(communeMapSrc).toContain('if (!container) continue');
  });

  it('renders resident dot with CSS color variable', () => {
    expect(communeMapSrc).toContain('resident-dot');
    expect(communeMapSrc).toContain('--dot-color');
  });
});

describe('Commune map — movement events', () => {
  it('handles movement events from SSE and parses sessionKey format', () => {
    expect(communeMapSrc).toContain("event.type === 'movement'");
    expect(communeMapSrc).toContain("key.split(':')");
    expect(communeMapSrc).toContain('charLocations[char.id] = toId');
  });

  it('animates destination cell and shows town notification', () => {
    expect(communeMapSrc).toContain('animateMovement');
    expect(communeMapSrc).toContain('arrival');
    expect(communeMapSrc).toContain('town-notif');
  });
});

describe('Commune map — SSE connection', () => {
  it('uses EventSource with exponential backoff on error', () => {
    expect(communeMapSrc).toContain('new EventSource');
    expect(communeMapSrc).toContain('retryDelay = Math.min(retryDelay * 2, 30000)');
    expect(communeMapSrc).toContain('es.close()');
  });

  it('stores event sources in Map and increments event counter', () => {
    expect(communeMapSrc).toContain('eventSources.set');
    expect(communeMapSrc).toContain('totalEvents++');
  });
});

describe('Commune map — activity panel', () => {
  it('builds activity URL with from/to range and defaults to 7 days', () => {
    expect(communeMapSrc).toContain('?from=');
    expect(communeMapSrc).toContain('&to=');
    expect(communeMapSrc).toContain('604800000');
  });

  it('escapes HTML in activity entries', () => {
    // findings.md P1:2725 — activity entries switched from
    // innerHTML + escapeHtml to DOM construction (contentDiv.textContent
    // = fullContent), which is inherently XSS-safe. The escapeHtml
    // helper still exists for other innerHTML sites.
    expect(communeMapSrc).toContain('function escapeHtml');
    expect(communeMapSrc).toContain('contentDiv.textContent = fullContent');
  });
});

describe('Commune map — parseType and formatTime helpers', () => {
  it('parseType maps known prefixes and returns unknown for falsy key', () => {
    expect(communeMapSrc).toContain('function parseType');
    expect(communeMapSrc).toContain("commune: 'commune'");
    expect(communeMapSrc).toContain("if (!sessionKey) return 'unknown'");
  });

  it('formatTime returns "just now", minutes, or hours', () => {
    expect(communeMapSrc).toContain('function formatTime');
    expect(communeMapSrc).toContain("'just now'");
    expect(communeMapSrc).toContain("'m ago'");
    expect(communeMapSrc).toContain("'h ago'");
  });

  it('hashColor generates HSL from ID string with normalized hue', () => {
    expect(communeMapSrc).toContain('function hashColor');
    expect(communeMapSrc).toContain('hsl(${hue}');
    expect(communeMapSrc).toContain('((h % 360) + 360) % 360');
  });
});

describe('Commune map — force-directed network simulation', () => {
  it('implements force simulation capped at SIM_MAX iterations', () => {
    expect(communeMapSrc).toContain('simulationStep');
    expect(communeMapSrc).toContain('SIM_MAX');
    expect(communeMapSrc).toContain('simIterations > SIM_MAX');
  });

  it('clamps node positions within 10%-90% bounds', () => {
    expect(communeMapSrc).toContain('Math.max(10, Math.min(90,');
  });

  it('fetches /api/relationships for edge data', () => {
    expect(communeMapSrc).toContain("fetch('/api/relationships')");
    expect(communeMapSrc).toContain('relationshipEdges');
  });
});

describe('Commune map — chat modal', () => {
  it('shows canned phrases for spectators and hides input', () => {
    expect(communeMapSrc).toContain('CANNED_PHRASES');
    expect(communeMapSrc).toContain("chatModalInput.style.display = 'none'");
  });

  it('persists chat session per character in localStorage', () => {
    // findings.md P2:3206 — writes go through writeSession(), not a
    // raw localStorage.setItem. Keys remain namespaced per character.
    expect(communeMapSrc).toContain("writeSession('stranger-session-'");
    expect(communeMapSrc).toContain("readSession('stranger-session-'");
    expect(communeMapSrc).toContain('stranger: true');
  });

  it('aborts in-flight request on modal close', () => {
    expect(communeMapSrc).toContain('chatAbortController.abort()');
  });
});

// ============================================================================
// 3. DASHBOARD BEHAVIOR (dashboard.html inline JS)
// ============================================================================

describe('Dashboard — character manifest loading', () => {
  it('fetches /api/characters and constructs per-character paths', () => {
    expect(dashboardSrc).toContain("fetch('/api/characters')");
    expect(dashboardSrc).toContain('telemetryPath');
    expect(dashboardSrc).toContain('healthPath');
    expect(dashboardSrc).toContain('locationPath');
  });

  it('uses host/prefix logic to route to correct server', () => {
    expect(dashboardSrc).toContain('isHost = i === 0');
    expect(dashboardSrc).toContain('prefix = isHost');
  });
});

describe('Dashboard — loop health indicators', () => {
  it('defines LOOP_KEYS with correct meta keys for all 5 loops', () => {
    expect(dashboardSrc).toContain('diary:last_entry_at');
    expect(dashboardSrc).toContain('dream:last_cycle_at');
    expect(dashboardSrc).toContain('curiosity:last_cycle_at');
    expect(dashboardSrc).toContain('self-concept:last_synthesis_at');
    expect(dashboardSrc).toContain('commune:last_cycle_at');
  });

  it('has correct intervals: diary=24h, dream=3h, curiosity=2h, self-concept=7d', () => {
    expect(dashboardSrc).toContain('24 * 60 * 60 * 1000');
    expect(dashboardSrc).toContain('3 * 60 * 60 * 1000');
    expect(dashboardSrc).toContain('2 * 60 * 60 * 1000');
    expect(dashboardSrc).toContain('7 * 24 * 60 * 60 * 1000');
  });

  it('colors dot green/yellow/red based on elapsed vs interval', () => {
    expect(dashboardSrc).toContain("dot.className = 'loop-dot green'");
    expect(dashboardSrc).toContain("dot.className = 'loop-dot yellow'");
    expect(dashboardSrc).toContain("dot.className = 'loop-dot red'");
    expect(dashboardSrc).toContain("dot.className = 'loop-dot grey'");
  });

  it('supports altKey fallback for curiosity-offline loop', () => {
    expect(dashboardSrc).toContain('curiosity-offline:last_cycle_at');
    expect(dashboardSrc).toContain('altKey');
  });
});

describe('Dashboard — budget display', () => {
  it('fetches /api/budget and calculates USD from token usage', () => {
    expect(dashboardSrc).toContain("fetch('/api/budget'");
    expect(dashboardSrc).toContain('usedUSD');
    expect(dashboardSrc).toContain("'$' + usedUSD.toFixed(2)");
    expect(dashboardSrc).toContain('BLENDED_RATE');
  });

  it('fills budget bar capped at 100% with color class', () => {
    expect(dashboardSrc).toContain('Math.min(pctUsed, 100)');
    expect(dashboardSrc).toContain('barColorClass(pctUsed)');
  });
});

describe('Dashboard — service health polling', () => {
  it('marks healthy services green and shows latency', () => {
    expect(dashboardSrc).toContain("dot.className = 'status-dot healthy'");
    expect(dashboardSrc).toContain("lat.textContent = latency + 'ms'");
    expect(dashboardSrc).toContain("lat.textContent = 'down'");
  });

  it('polls every 30s and times out after 5s', () => {
    expect(dashboardSrc).toContain('setInterval(pollServiceHealth, 30 * 1000)');
    expect(dashboardSrc).toContain('AbortSignal.timeout(5000)');
  });

  it('uses /api/system for Telegram and Gateway status', () => {
    expect(dashboardSrc).toContain("fetch('/api/system'");
    expect(dashboardSrc).toContain('data.services?.telegram?.active');
  });
});

describe('Dashboard — activity stream', () => {
  it('classifies events into categories including commune, diary, dream', () => {
    expect(dashboardSrc).toContain('function classifyEvent');
    expect(dashboardSrc).toContain("'commune'");
    expect(dashboardSrc).toContain("'diary'");
    expect(dashboardSrc).toContain("'dream'");
  });

  it('limits entries to MAX_ACTIVITY and prepends newest', () => {
    expect(dashboardSrc).toContain('MAX_ACTIVITY');
    expect(dashboardSrc).toContain('activityCount > MAX_ACTIVITY');
    expect(dashboardSrc).toContain('container.prepend(entry)');
  });

  it('staggers SSE connections by 500ms to avoid browser limit', () => {
    expect(dashboardSrc).toContain('sseDelay += 500');
    expect(dashboardSrc).toContain('new EventSource(char.ssePath)');
  });
});

describe('Dashboard — infrastructure metrics', () => {
  it('updates disk, RAM, swap bars from /api/system data', () => {
    expect(dashboardSrc).toContain("updateBar('disk'");
    expect(dashboardSrc).toContain("updateBar('ram'");
    expect(dashboardSrc).toContain("updateBar('swap'");
  });

  it('applies red >=90%, yellow >=70%, green otherwise', () => {
    expect(dashboardSrc).toContain('pct >= 90');
    expect(dashboardSrc).toContain('pct >= 70');
    expect(dashboardSrc).toContain("'red'");
    expect(dashboardSrc).toContain("'yellow'");
  });

  it('shows load average and uptime', () => {
    expect(dashboardSrc).toContain('data.load');
    expect(dashboardSrc).toContain('data.uptime');
  });
});

describe('Dashboard — lifecycle management', () => {
  it('closes SSE on tab hidden/beforeunload and reconnects when visible', () => {
    expect(dashboardSrc).toContain('visibilitychange');
    expect(dashboardSrc).toContain('document.hidden');
    expect(dashboardSrc).toContain("'beforeunload'");
  });

  it('polling intervals: locations=15s, budget=60s, loop health=60s', () => {
    expect(dashboardSrc).toContain('setInterval(pollLocations, 15 * 1000)');
    expect(dashboardSrc).toContain('setInterval(pollBudget, 60 * 1000)');
    expect(dashboardSrc).toContain('pollLoopHealth()');
  });
});

describe('Dashboard HTML structure', () => {
  it('has all required dashboard DOM elements', () => {
    expect(dashboardSrc).toContain('id="service-list"');
    expect(dashboardSrc).toContain('id="loop-grid"');
    expect(dashboardSrc).toContain('id="town-grid"');
    expect(dashboardSrc).toContain('id="relationship-canvas"');
    expect(dashboardSrc).toContain('id="activity-stream"');
    expect(dashboardSrc).toContain('id="budget-amount"');
    expect(dashboardSrc).toContain('id="memory-grid"');
  });

  it('has all 5 loop column headers', () => {
    expect(dashboardSrc).toContain('Diary');
    expect(dashboardSrc).toContain('Dream');
    expect(dashboardSrc).toContain('Curio');
    expect(dashboardSrc).toContain('Self');
    expect(dashboardSrc).toContain('Comm');
  });
});

// ============================================================================
// 4. COMMUNE MAP HTML STRUCTURE
// ============================================================================

describe('Commune map HTML structure', () => {
  it('has town-grid and node-map view containers with toggle buttons', () => {
    expect(communeMapHtml).toContain('id="town-grid"');
    expect(communeMapHtml).toContain('id="node-map"');
    expect(communeMapHtml).toContain('data-view="town"');
    expect(communeMapHtml).toContain('data-view="network"');
  });

  it('has SVG connection lines, chat modal, and event log', () => {
    expect(communeMapHtml).toContain('id="connection-lines"');
    expect(communeMapHtml).toContain('id="chat-modal"');
    expect(communeMapHtml).toContain('id="event-log"');
    expect(communeMapHtml).toContain('id="event-count"');
  });

  it('has activity panel with time range controls', () => {
    expect(communeMapHtml).toContain('id="time-controls"');
    expect(communeMapHtml).toContain('data-range=');
    expect(communeMapHtml).toContain('id="connection-status"');
  });

  it('loads commune-map.js script', () => {
    expect(communeMapHtml).toContain('commune-map.js');
  });
});

// ============================================================================
// 5. API CONTRACT COMPLIANCE
// ============================================================================

describe('API contract — endpoint paths match backend', () => {
  it('app.js uses correct chat endpoints', () => {
    expect(appSrc).toMatch(/['"`].*\/api\/chat['"`]/);
    expect(appSrc).toContain('/api/chat/stream');
  });

  it('commune-map uses all expected API paths', () => {
    expect(communeMapSrc).toContain('/api/characters');
    expect(communeMapSrc).toContain('/api/activity');
    expect(communeMapSrc).toContain('/api/location');
    expect(communeMapSrc).toContain('/api/events');
    expect(communeMapSrc).toContain('/api/relationships');
  });

  it('dashboard uses all expected API paths', () => {
    expect(dashboardSrc).toContain('/api/system');
    expect(dashboardSrc).toContain('/api/budget');
    expect(dashboardSrc).toContain('/api/telemetry');
    expect(dashboardSrc).toContain('/api/conversations/stream');
  });
});

describe('API contract — request headers and format', () => {
  it('all chat requests use application/json', () => {
    expect(appSrc).toContain("'Content-Type': 'application/json'");
    expect(communeMapSrc).toContain("'Content-Type': 'application/json'");
  });

  it('game APIClient sends Authorization Bearer and Content-Type', () => {
    const apiClientSrc = readPublic('game/js/systems/APIClient.js');
    expect(apiClientSrc).toContain("'Authorization': 'Bearer ' + this.token");
    expect(apiClientSrc).toContain("'Content-Type': 'application/json'");
  });
});

describe('API contract — SSE event types match server', () => {
  it('app.js handles all 4 server SSE event types', () => {
    expect(appSrc).toContain("data.type === 'session'");
    expect(appSrc).toContain("data.type === 'chunk'");
    expect(appSrc).toContain("data.type === 'done'");
    expect(appSrc).toContain("data.type === 'error'");
  });

  it('commune-map handles session, chunk, done, error from stream', () => {
    expect(communeMapSrc).toContain("event.type === 'session'");
    expect(communeMapSrc).toContain("event.type === 'chunk'");
    expect(communeMapSrc).toContain("event.type === 'done'");
    expect(communeMapSrc).toContain("event.type === 'error'");
  });
});

describe('API contract — error handling', () => {
  it('app.js throws on non-ok response with descriptive message', () => {
    expect(appSrc).toContain('!response.ok');
    expect(appSrc).toContain("'Failed to send message'");
  });

  it('commune-map checks resp.ok and dashboard guards at least 4 endpoints', () => {
    expect(communeMapSrc).toContain('if (!resp.ok)');
    const count = (dashboardSrc.match(/if \(!resp\.ok\)/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(4);
  });
});

// ============================================================================
// 6. APP.JS — DETAILED CHAT FLOW
// ============================================================================

describe('Chat client — streaming message UI', () => {
  it('creates streaming element with lain-message class, sender span, streaming-text span', () => {
    expect(appSrc).toContain('function createStreamingMessage');
    expect(appSrc).toContain('lain-message');
    expect(appSrc).toContain('id="streaming-text"');
  });

  it('non-streaming sendMessage stores returned sessionId', () => {
    expect(appSrc).toContain('data.sessionId');
    expect(appSrc).toContain('return data.response');
  });
});

describe('Chat client — image response handling', () => {
  it('formatLainResponse extracts [IMAGE:desc](url) patterns before HTML escaping', () => {
    expect(appSrc).toContain('[IMAGE:');
    expect(appSrc).toContain('IMAGE_PLACEHOLDER');
    expect(appSrc).toContain('onerror=');
    expect(appSrc).toContain('response-image');
    expect(appSrc).toContain("window.open(");
  });
});

describe('Chat client — drag overlay UI', () => {
  it('shows and hides drag overlay for dragover/dragleave events', () => {
    expect(appSrc).toContain('function showDragOverlay');
    expect(appSrc).toContain('function hideDragOverlay');
    expect(appSrc).toContain("'dragover'");
    expect(appSrc).toContain("'dragleave'");
    expect(appSrc).toContain('drag-overlay');
  });
});

// ============================================================================
// 7. COMMUNE MAP — DETAILED BEHAVIORS
// ============================================================================

describe('Commune map — event log', () => {
  it('adds log entries with time, character, and event type', () => {
    expect(communeMapSrc).toContain('function addLogEntry');
    expect(communeMapSrc).toContain('log-time');
    expect(communeMapSrc).toContain('log-type');
  });

  it('limits log to MAX_LOG entries', () => {
    expect(communeMapSrc).toContain('MAX_LOG');
    expect(communeMapSrc).toContain('logEntries.length > MAX_LOG');
  });

  it('inserts new entries at top of log', () => {
    expect(communeMapSrc).toContain('logBody.insertBefore(entry, logBody.firstChild)');
  });

  it('toggles event log collapsed state', () => {
    expect(communeMapSrc).toContain('function bindLogToggle');
    expect(communeMapSrc).toContain("eventLog.classList.toggle('collapsed')");
  });
});

describe('Commune map — notification system', () => {
  it('limits to MAX_NOTIFICATIONS, shows type color, decrements on animationend', () => {
    expect(communeMapSrc).toContain('MAX_NOTIFICATIONS');
    expect(communeMapSrc).toContain('notifCount >= MAX_NOTIFICATIONS');
    expect(communeMapSrc).toContain('float-notif');
    expect(communeMapSrc).toContain('typeColor');
    expect(communeMapSrc).toContain('animationend');
    expect(communeMapSrc).toContain('notifCount--');
  });

  it('only shows floating notifications in network view', () => {
    expect(communeMapSrc).toContain("currentView === 'network'");
    expect(communeMapSrc).toContain('createNotification');
  });
});

describe('Commune map — connection lines', () => {
  it('creates SVG lines with weight-based opacity and width, flashes on events', () => {
    expect(communeMapSrc).toContain("createElementNS('http://www.w3.org/2000/svg', 'line')");
    expect(communeMapSrc).toContain('0.15 + 0.7 * edge.weight');
    expect(communeMapSrc).toContain('0.5 + 2.5 * edge.weight');
    expect(communeMapSrc).toContain('function flashLines');
    expect(communeMapSrc).toContain("line.classList.add('active')");
  });
});

describe('Commune map — view switching', () => {
  it('shows town grid, hides node map in town view (and vice versa)', () => {
    expect(communeMapSrc).toContain('function bindViewToggle');
    expect(communeMapSrc).toContain("townGrid.style.display = ''");
    expect(communeMapSrc).toContain("nodeMap.style.display = 'none'");
    expect(communeMapSrc).toContain('startSimulation()');
  });

  it('auto-switches to network on #network hash and hashchange', () => {
    expect(communeMapSrc).toContain("location.hash === '#network'");
    expect(communeMapSrc).toContain('hashchange');
  });
});

// ============================================================================
// 8. DASHBOARD — CONVERSATIONS AND MEMORY
// ============================================================================

describe('Dashboard — conversation stream', () => {
  it('connects to /api/conversations/stream SSE', () => {
    expect(dashboardSrc).toContain('connectConversationsSSE');
    expect(dashboardSrc).toContain("new EventSource('/api/conversations/stream')");
  });

  it('renders speaker name with color arrow listener format', () => {
    expect(dashboardSrc).toContain('convo-meta');
    expect(dashboardSrc).toContain('&rarr;');
    expect(dashboardSrc).toContain('speakerName');
    expect(dashboardSrc).toContain('listenerName');
  });

  it('truncates conversation messages to 500 chars', () => {
    expect(dashboardSrc).toContain('.slice(0, 500)');
  });
});

describe('Dashboard — memory stats display', () => {
  it('shows memory count as localized number', () => {
    expect(dashboardSrc).toContain('.toLocaleString()');
    expect(dashboardSrc).toContain('totalMemories');
  });

  it('renders emotional weight bar scaled to 0-100%', () => {
    expect(dashboardSrc).toContain('ew * 100');
    expect(dashboardSrc).toContain('ew-fill');
  });

  it('shows -- for characters without telemetry data', () => {
    expect(dashboardSrc).toContain("'--'");
  });
});

describe('Dashboard — tab system', () => {
  it('initializes tabs with data-tab attribute binding', () => {
    expect(dashboardSrc).toContain('function initTabs');
    expect(dashboardSrc).toContain('btn.dataset.tab');
  });

  it('switches active tab and tab pane on click', () => {
    expect(dashboardSrc).toContain("btn.classList.add('active')");
    expect(dashboardSrc).toContain("'tab-' + tabId");
  });
});

describe('Dashboard — relationship graph', () => {
  it('renders graph on canvas with DPR-aware sizing', () => {
    expect(dashboardSrc).toContain('function renderGraph');
    expect(dashboardSrc).toContain('devicePixelRatio');
    expect(dashboardSrc).toContain('ctx.scale(dpr, dpr)');
  });

  it('draws edges with weight-based opacity and width', () => {
    expect(dashboardSrc).toContain('0.15 + 0.7 * edge.weight');
    expect(dashboardSrc).toContain('0.5 + 2.5 * edge.weight');
  });

  it('draws character nodes with glow and label', () => {
    expect(dashboardSrc).toContain("ctx.fillText(char.name");
    expect(dashboardSrc).toContain("char.color + '22'");
  });

  it('re-renders graph on window resize', () => {
    expect(dashboardSrc).toContain("'resize'");
    expect(dashboardSrc).toContain('renderGraph()');
  });
});

// ============================================================================
// 9. COMMUNE MAP — SKIN CHANGE REACTIVITY
// ============================================================================

describe('Commune map — skin change reactivity', () => {
  it('listens for skin-changed event', () => {
    expect(communeMapSrc).toContain("'skin-changed'");
  });

  it('rebuilds BUILDINGS and TYPE_COLORS on skin change', () => {
    expect(communeMapSrc).toContain('BUILDINGS = getBuildings()');
    expect(communeMapSrc).toContain('TYPE_COLORS = getTypeColors()');
  });

  it('re-renders town grid and nodes after skin change', () => {
    expect(communeMapSrc).toContain('townGrid.innerHTML = \'\'');
    expect(communeMapSrc).toContain('createTownGrid()');
    expect(communeMapSrc).toContain('renderResidents()');
  });
});

// ============================================================================
// 10. COMMUNE MAP — TYPE COLORS
// ============================================================================

describe('Commune map — type color system', () => {
  it('defines getTypeColors returning per-type color map', () => {
    expect(communeMapSrc).toContain('function getTypeColors');
  });

  it('has colors for all major event types', () => {
    expect(communeMapSrc).toContain("diary:");
    expect(communeMapSrc).toContain("dream:");
    expect(communeMapSrc).toContain("commune:");
    expect(communeMapSrc).toContain("letter:");
    expect(communeMapSrc).toContain("doctor:");
    expect(communeMapSrc).toContain("movement:");
  });

  it('reads colors from CSS variables with fallbacks', () => {
    expect(communeMapSrc).toContain("getCSSVar('--type-diary')");
    expect(communeMapSrc).toContain("'#e0a020'");
  });
});
