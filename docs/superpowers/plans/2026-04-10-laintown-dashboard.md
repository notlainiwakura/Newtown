# Laintown Live Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a live, owner-gated, cyberpunk-themed dashboard at `/dashboard` showing all Laintown systems in real-time.

**Architecture:** Single HTML page with inline CSS/JS served from Wired Lain's web server (port 3000). Uses existing SSE streams and REST APIs on each character server, accessed via the existing proxy routes (`/local/`, `/pkd/`, etc.). One new backend endpoint (`/api/system`) for OS-level stats. Owner auth via existing `isOwner()` cookie check.

**Tech Stack:** Vanilla JS, CSS Grid, EventSource (SSE), Canvas (relationship graph), Node.js `child_process` for system stats.

**Spec:** `docs/superpowers/specs/2026-04-10-laintown-dashboard-design.md`

---

### File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/web/public/dashboard.html` | Create | Entire dashboard UI — HTML + inline CSS + inline JS |
| `src/web/server.ts` | Modify | Add `/api/system` endpoint, add `/dashboard.html` to `OWNER_ONLY_PATHS` |

---

### Task 1: Add `/dashboard.html` to owner-only paths and `/api/system` endpoint

**Files:**
- Modify: `src/web/server.ts:372-384` (OWNER_ONLY_PATHS array)
- Modify: `src/web/server.ts` (add new endpoint near other `/api/` routes)

- [ ] **Step 1: Add dashboard to OWNER_ONLY_PATHS**

In `src/web/server.ts`, find the `OWNER_ONLY_PATHS` array (line 372) and add `/dashboard.html`:

```typescript
const OWNER_ONLY_PATHS = [
  '/postboard.html',
  '/town-events.html',
  '/dreams.html',
  '/dashboard.html',
  '/local/',
  '/dr-claude/',
  '/pkd/',
  '/mckenna/',
  '/john/',
  '/hiru/',
  '/api/chat',
  '/api/chat/stream',
];
```

- [ ] **Step 2: Add the `/api/system` endpoint**

Add this import near the top of `src/web/server.ts` with the other imports:

```typescript
import { execSync } from 'node:child_process';
```

Add the `/api/system` route. Place it near the other `/api/` GET routes (before the static file serving section, around line 1885). This endpoint is owner-only (checked by the existing OWNER_ONLY_PATHS gate since we add `/api/system` to it, OR we check inline).

Actually — since `/api/system` isn't in OWNER_ONLY_PATHS and adding API paths there causes 302 redirects for non-HTML requests but 403 for API requests, we should check `isOwner()` inline for clarity:

```typescript
    // System stats for dashboard
    if (url.pathname === '/api/system' && req.method === 'GET') {
      if (!isOwner(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': CORS_ORIGIN,
      });

      try {
        const dfOut = execSync('df -h / | tail -1', { timeout: 5000 }).toString().trim();
        const dfParts = dfOut.split(/\s+/);
        const disk = {
          total: dfParts[1] || '?',
          used: dfParts[2] || '?',
          available: dfParts[3] || '?',
          percent: parseInt(dfParts[4] || '0', 10),
        };

        const freeOut = execSync('free -h | grep -E "^Mem|^Swap"', { timeout: 5000 }).toString().trim();
        const freeLines = freeOut.split('\n');
        const memParts = freeLines[0]?.split(/\s+/) || [];
        const swapParts = freeLines[1]?.split(/\s+/) || [];
        const ram = {
          total: memParts[1] || '?',
          used: memParts[2] || '?',
          free: memParts[3] || '?',
          percent: memParts[1] && memParts[2]
            ? Math.round((parseFloat(memParts[2]) / parseFloat(memParts[1])) * 100)
            : 0,
        };
        const swap = {
          total: swapParts[1] || '?',
          used: swapParts[2] || '?',
          free: swapParts[3] || '?',
          percent: swapParts[1] && swapParts[2]
            ? Math.round((parseFloat(swapParts[2]) / parseFloat(swapParts[1])) * 100)
            : 0,
        };

        const uptimeOut = execSync('uptime', { timeout: 5000 }).toString().trim();
        const loadMatch = uptimeOut.match(/load average[s]?:\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
        const load = loadMatch
          ? [parseFloat(loadMatch[1]), parseFloat(loadMatch[2]), parseFloat(loadMatch[3])]
          : [0, 0, 0];
        const uptimeMatch = uptimeOut.match(/up\s+(.+?),\s+\d+\s+user/);
        const uptime = uptimeMatch?.[1]?.trim() || '?';

        // Service status for non-HTTP services
        let telegramActive = false;
        let gatewayActive = false;
        try { execSync('systemctl is-active lain-telegram', { timeout: 3000 }); telegramActive = true; } catch { /* inactive */ }
        try { execSync('systemctl is-active lain-gateway', { timeout: 3000 }); gatewayActive = true; } catch { /* inactive */ }

        res.end(JSON.stringify({ disk, ram, swap, load, uptime, services: { telegram: { active: telegramActive }, gateway: { active: gatewayActive } } }));
      } catch (err) {
        res.end(JSON.stringify({ error: 'Failed to read system stats' }));
      }
      return;
    }
```

- [ ] **Step 3: Verify the build compiles**

Run: `npm run build`
Expected: Clean compilation, no errors.

- [ ] **Step 4: Commit**

```bash
git add src/web/server.ts
git commit -m "feat(dashboard): add /api/system endpoint and owner-gate /dashboard.html"
```

---

### Task 2: Create dashboard HTML — structure and CSS

**Files:**
- Create: `src/web/public/dashboard.html`

This task creates the full HTML file with all CSS. The JS will be added in Tasks 3-5.

- [ ] **Step 1: Create the dashboard HTML with full CSS and skeleton markup**

Create `src/web/public/dashboard.html` with the complete HTML structure, all CSS styles, and empty `<script>` tag. The markup includes all panels with placeholder content that JS will populate.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DASHBOARD // LAINTOWN</title>
  <script src="/skins/early-load.js"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #0a0a0a;
      --panel: #111;
      --border: rgba(0, 255, 65, 0.2);
      --green: #00ff41;
      --green-dim: #00ff4188;
      --yellow: #ffaa00;
      --red: #ff4444;
      --text: #888;
      --text-bright: #fff;
      --sidebar-w: 220px;

      --c-wired-lain: #ff00ff;
      --c-lain: #00ffff;
      --c-dr-claude: #44ff44;
      --c-pkd: #ff8800;
      --c-mckenna: #ffff00;
      --c-john: #8888ff;
      --c-hiru: #ff4488;
    }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: 'Courier New', monospace;
      height: 100vh;
      overflow: hidden;
    }

    /* CRT scanline overlay */
    body::after {
      content: '';
      position: fixed;
      inset: 0;
      pointer-events: none;
      background: repeating-linear-gradient(
        0deg,
        transparent,
        transparent 2px,
        rgba(0, 0, 0, 0.08) 2px,
        rgba(0, 0, 0, 0.08) 4px
      );
      z-index: 9999;
    }

    /* Layout */
    .dashboard {
      display: grid;
      grid-template-columns: var(--sidebar-w) 1fr;
      grid-template-rows: 1fr;
      height: 100vh;
      gap: 1px;
      background: var(--border);
    }

    /* Sidebar */
    .sidebar {
      background: var(--bg);
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 1px;
    }

    .sidebar-section {
      background: var(--panel);
      padding: 12px;
    }

    .sidebar-section h3 {
      color: var(--green);
      font-size: 10px;
      letter-spacing: 2px;
      text-transform: uppercase;
      margin-bottom: 10px;
    }

    /* Service list */
    .service-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 3px 0;
      font-size: 11px;
    }

    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--red);
      flex-shrink: 0;
    }

    .status-dot.up {
      background: var(--green);
      box-shadow: 0 0 6px var(--green);
      animation: pulse 3s ease-in-out infinite;
    }

    .status-dot.down {
      background: var(--red);
      box-shadow: 0 0 6px var(--red);
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    .service-name { flex: 1; color: var(--text); }
    .service-uptime { color: var(--green-dim); font-size: 9px; }

    /* Infrastructure bars */
    .infra-row {
      margin-bottom: 8px;
    }

    .infra-label {
      display: flex;
      justify-content: space-between;
      font-size: 9px;
      margin-bottom: 3px;
    }

    .infra-label span:first-child { color: var(--green-dim); }
    .infra-label span:last-child { color: var(--text); }

    .bar-track {
      height: 4px;
      background: #1a1a1a;
      border-radius: 2px;
      overflow: hidden;
    }

    .bar-fill {
      height: 100%;
      background: var(--green);
      border-radius: 2px;
      transition: width 1s ease, background-color 0.5s;
    }

    .bar-fill.warn { background: var(--yellow); }
    .bar-fill.crit { background: var(--red); }

    /* Loop health grid */
    .loop-grid {
      display: grid;
      grid-template-columns: 60px repeat(5, 1fr);
      gap: 2px;
      font-size: 8px;
    }

    .loop-grid .header {
      color: var(--green-dim);
      text-align: center;
      padding: 2px;
    }

    .loop-grid .char-name {
      color: var(--text);
      padding: 2px 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .loop-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      margin: auto;
      background: #333;
      cursor: default;
    }

    .loop-dot.ok { background: var(--green); box-shadow: 0 0 4px var(--green); }
    .loop-dot.stale { background: var(--yellow); }
    .loop-dot.stalled { background: var(--red); }

    /* Main area */
    .main {
      background: var(--bg);
      display: grid;
      grid-template-rows: minmax(200px, 1fr) minmax(200px, 1.2fr) 48px;
      gap: 1px;
    }

    /* Top row: map + graph */
    .top-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1px;
    }

    .panel {
      background: var(--panel);
      padding: 12px;
      overflow: hidden;
      position: relative;
    }

    .panel h3 {
      color: var(--green);
      font-size: 10px;
      letter-spacing: 2px;
      text-transform: uppercase;
      margin-bottom: 8px;
    }

    /* Town map */
    .town-grid-mini {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 4px;
      height: calc(100% - 24px);
    }

    .building {
      background: #0a1a0a;
      border: 1px solid var(--border);
      border-radius: 3px;
      padding: 4px;
      display: flex;
      flex-direction: column;
      font-size: 8px;
      position: relative;
      transition: border-color 0.3s;
    }

    .building.occupied {
      border-color: rgba(0, 255, 65, 0.5);
    }

    .building-name {
      color: var(--green-dim);
      font-size: 7px;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .building-residents {
      display: flex;
      flex-wrap: wrap;
      gap: 3px;
      margin-top: 4px;
    }

    .resident-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      border: 1px solid rgba(0, 0, 0, 0.3);
      cursor: default;
    }

    /* Relationship graph canvas */
    #relationship-canvas {
      width: 100%;
      height: calc(100% - 24px);
    }

    /* Middle: activity stream */
    .middle {
      background: var(--panel);
      display: flex;
      flex-direction: column;
    }

    .tab-bar {
      display: flex;
      gap: 0;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }

    .tab {
      padding: 8px 16px;
      font-size: 10px;
      letter-spacing: 1px;
      color: var(--text);
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      cursor: pointer;
      font-family: inherit;
      text-transform: uppercase;
    }

    .tab.active {
      color: var(--green);
      border-bottom-color: var(--green);
    }

    .stream-container {
      flex: 1;
      overflow-y: auto;
      padding: 8px 12px;
    }

    .stream-container::-webkit-scrollbar { width: 4px; }
    .stream-container::-webkit-scrollbar-track { background: transparent; }
    .stream-container::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }

    .stream-entry {
      display: flex;
      gap: 8px;
      padding: 4px 0;
      border-bottom: 1px solid #1a1a1a;
      font-size: 11px;
      line-height: 1.4;
      cursor: pointer;
    }

    .stream-entry:hover { background: #1a1a1a; }

    .stream-time {
      color: #555;
      flex-shrink: 0;
      font-size: 10px;
      min-width: 40px;
    }

    .stream-char {
      flex-shrink: 0;
      font-size: 10px;
      min-width: 70px;
    }

    .stream-type {
      font-size: 9px;
      padding: 1px 5px;
      border-radius: 2px;
      flex-shrink: 0;
      min-width: 60px;
      text-align: center;
    }

    .type-research { background: #001a33; color: #4a9eff; }
    .type-diary { background: #1a0033; color: #b464ff; }
    .type-dream { background: #0d0033; color: #8844ff; }
    .type-curiosity { background: #003333; color: #00cccc; }
    .type-letter { background: #330022; color: #ff66aa; }
    .type-commune { background: #003300; color: #44ff44; }
    .type-therapy { background: #332200; color: #ffaa00; }
    .type-self-concept { background: #222200; color: #aaaa44; }
    .type-narrative { background: #1a1a00; color: #888844; }
    .type-other { background: #1a1a1a; color: #888; }

    .stream-content {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text);
    }

    .stream-entry.expanded .stream-content {
      white-space: normal;
      word-break: break-word;
    }

    /* Conversation entries */
    .conv-entry {
      padding: 6px 0;
      border-bottom: 1px solid #1a1a1a;
      font-size: 11px;
    }

    .conv-speaker {
      font-size: 10px;
      margin-bottom: 2px;
    }

    .conv-text {
      color: var(--text);
      line-height: 1.4;
    }

    .conv-location {
      font-size: 9px;
      color: #444;
      margin-top: 2px;
    }

    /* Bottom bar */
    .bottom-bar {
      background: var(--panel);
      display: flex;
      align-items: center;
      padding: 0 12px;
      gap: 16px;
      font-size: 10px;
      border-top: 1px solid var(--border);
    }

    .memory-stat {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .memory-stat .char-label {
      font-size: 9px;
    }

    .memory-stat .count {
      color: var(--text-bright);
      font-size: 10px;
    }

    .emo-bar {
      width: 24px;
      height: 4px;
      background: #1a1a1a;
      border-radius: 2px;
      overflow: hidden;
    }

    .emo-fill {
      height: 100%;
      background: var(--green);
      border-radius: 2px;
    }

    .budget-section {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .budget-label { color: var(--green-dim); font-size: 9px; letter-spacing: 1px; }
    .budget-amount { color: var(--text-bright); }

    .budget-bar {
      width: 60px;
      height: 4px;
      background: #1a1a1a;
      border-radius: 2px;
      overflow: hidden;
    }

    .budget-fill {
      height: 100%;
      background: var(--green);
      border-radius: 2px;
      transition: width 1s ease, background-color 0.5s;
    }

    /* Hidden tab */
    .tab-content { display: none; }
    .tab-content.active { display: block; flex: 1; overflow-y: auto; }

    /* Tooltip */
    .tooltip {
      position: fixed;
      background: #222;
      color: var(--text-bright);
      padding: 4px 8px;
      font-size: 10px;
      border: 1px solid var(--border);
      border-radius: 3px;
      pointer-events: none;
      z-index: 1000;
      display: none;
    }
  </style>
</head>
<body>
  <div class="dashboard">
    <!-- SIDEBAR -->
    <div class="sidebar">
      <div class="sidebar-section">
        <h3>Services</h3>
        <div id="service-list"></div>
      </div>
      <div class="sidebar-section">
        <h3>Infrastructure</h3>
        <div id="infra-panel">
          <div class="infra-row">
            <div class="infra-label"><span>DISK</span><span id="disk-pct">--</span></div>
            <div class="bar-track"><div class="bar-fill" id="disk-bar" style="width:0%"></div></div>
          </div>
          <div class="infra-row">
            <div class="infra-label"><span>RAM</span><span id="ram-pct">--</span></div>
            <div class="bar-track"><div class="bar-fill" id="ram-bar" style="width:0%"></div></div>
          </div>
          <div class="infra-row">
            <div class="infra-label"><span>SWAP</span><span id="swap-pct">--</span></div>
            <div class="bar-track"><div class="bar-fill" id="swap-bar" style="width:0%"></div></div>
          </div>
          <div class="infra-row">
            <div class="infra-label"><span>LOAD</span><span id="load-val">--</span></div>
          </div>
          <div class="infra-row">
            <div class="infra-label"><span>UPTIME</span><span id="uptime-val">--</span></div>
          </div>
        </div>
      </div>
      <div class="sidebar-section">
        <h3>Loop Health</h3>
        <div class="loop-grid" id="loop-grid">
          <div class="header"></div>
          <div class="header">DIA</div>
          <div class="header">DRM</div>
          <div class="header">CUR</div>
          <div class="header">SEL</div>
          <div class="header">COM</div>
        </div>
      </div>
    </div>

    <!-- MAIN AREA -->
    <div class="main">
      <!-- Top: Map + Graph -->
      <div class="top-row">
        <div class="panel">
          <h3>Town Map</h3>
          <div class="town-grid-mini" id="town-map"></div>
        </div>
        <div class="panel">
          <h3>Relationships</h3>
          <canvas id="relationship-canvas"></canvas>
        </div>
      </div>

      <!-- Middle: Activity Stream / Conversations -->
      <div class="middle">
        <div class="tab-bar">
          <button class="tab active" data-tab="activity">Activity Stream</button>
          <button class="tab" data-tab="conversations">Conversations</button>
        </div>
        <div class="stream-container tab-content active" id="activity-stream" data-tab="activity"></div>
        <div class="stream-container tab-content" id="conversations-stream" data-tab="conversations"></div>
      </div>

      <!-- Bottom: Memory + Budget -->
      <div class="bottom-bar">
        <div id="memory-stats"></div>
        <div class="budget-section">
          <span class="budget-label">BUDGET</span>
          <span class="budget-amount" id="budget-amount">--</span>
          <div class="budget-bar"><div class="budget-fill" id="budget-bar" style="width:0%"></div></div>
        </div>
      </div>
    </div>
  </div>

  <div class="tooltip" id="tooltip"></div>

  <script>
    // JS will be added in Tasks 3-5
  </script>
  <script src="/skins/loader.js"></script>
  <script src="/skins/picker.js"></script>
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add src/web/public/dashboard.html
git commit -m "feat(dashboard): add HTML structure and CSS for live dashboard"
```

---

### Task 3: Dashboard JS — configuration, service health, infrastructure, and loop health

**Files:**
- Modify: `src/web/public/dashboard.html` (replace the `<script>` block)

- [ ] **Step 1: Add JS for character config, service health polling, infrastructure polling, and loop health**

Replace the `<script>` comment in `dashboard.html` with the following. This covers the sidebar panels:

```javascript
(function () {
  'use strict';

  // ── Character config ──
  const CHARACTERS = [
    { id: 'wired-lain', name: 'Wired Lain', color: '#ff00ff', port: 3000, prefix: '', healthPath: '/api/health', telemetryPath: '/api/telemetry', locationPath: '/api/location', ssePath: '/api/events' },
    { id: 'lain', name: 'Lain', color: '#00ffff', port: 3001, prefix: '/local', healthPath: '/local/api/health', telemetryPath: '/local/api/telemetry', locationPath: '/local/api/location', ssePath: '/local/api/events' },
    { id: 'dr-claude', name: 'Dr. Claude', color: '#44ff44', port: 3002, prefix: '/dr-claude', healthPath: '/dr-claude/api/health', telemetryPath: '/dr-claude/api/telemetry', locationPath: '/dr-claude/api/location', ssePath: '/dr-claude/api/events' },
    { id: 'pkd', name: 'PKD', color: '#ff8800', port: 3003, prefix: '/pkd', healthPath: '/pkd/api/health', telemetryPath: '/pkd/api/telemetry', locationPath: '/pkd/api/location', ssePath: '/pkd/api/events' },
    { id: 'mckenna', name: 'McKenna', color: '#ffff00', port: 3004, prefix: '/mckenna', healthPath: '/mckenna/api/health', telemetryPath: '/mckenna/api/telemetry', locationPath: '/mckenna/api/location', ssePath: '/mckenna/api/events' },
    { id: 'john', name: 'John', color: '#8888ff', port: 3005, prefix: '/john', healthPath: '/john/api/health', telemetryPath: '/john/api/telemetry', locationPath: '/john/api/location', ssePath: '/john/api/events' },
    { id: 'hiru', name: 'Hiru', color: '#ff4488', port: 3006, prefix: '/hiru', healthPath: '/hiru/api/health', telemetryPath: '/hiru/api/telemetry', locationPath: '/hiru/api/location', ssePath: '/hiru/api/events' },
  ];

  const SERVICES = [
    ...CHARACTERS.map(c => ({ id: c.id, name: c.name, healthPath: c.healthPath, type: 'http' })),
    { id: 'telegram', name: 'Telegram', type: 'system' },
    { id: 'gateway', name: 'Gateway', type: 'system' },
  ];

  const BUILDINGS = [
    { id: 'library', name: 'Library' },
    { id: 'bar', name: 'Bar' },
    { id: 'field', name: 'Field' },
    { id: 'windmill', name: 'Windmill' },
    { id: 'lighthouse', name: 'Lighthouse' },
    { id: 'school', name: 'School' },
    { id: 'market', name: 'Market' },
    { id: 'locksmith', name: 'Locksmith' },
    { id: 'threshold', name: 'Threshold' },
  ];

  const LOOP_KEYS = {
    diary: { key: 'diary:last_entry_at', interval: 24 * 3600_000 },
    dream: { key: 'dream:last_cycle_at', interval: 8 * 3600_000 },
    curiosity: { key: 'curiosity:last_cycle_at', interval: 4 * 3600_000 },
    'self-concept': { key: 'self-concept:last_synthesis_at', interval: 24 * 3600_000 },
    commune: { key: 'commune:last_conversation_at', interval: 4 * 3600_000 },
  };

  // ── State ──
  const serviceStatus = {};
  const charLocations = {};
  const charTelemetry = {};
  const tooltip = document.getElementById('tooltip');

  // ── Service Health ──
  function renderServiceList() {
    const el = document.getElementById('service-list');
    el.innerHTML = SERVICES.map(s => {
      const st = serviceStatus[s.id];
      const cls = st?.up ? 'up' : 'down';
      const uptime = st?.uptime || '';
      return '<div class="service-row"><div class="status-dot ' + cls + '"></div><span class="service-name">' + s.name + '</span><span class="service-uptime">' + uptime + '</span></div>';
    }).join('');
  }

  async function pollServiceHealth() {
    // HTTP services
    for (const char of CHARACTERS) {
      try {
        const resp = await fetch(char.healthPath, { signal: AbortSignal.timeout(5000) });
        serviceStatus[char.id] = { up: resp.ok || resp.status === 302, uptime: '' };
      } catch {
        serviceStatus[char.id] = { up: false, uptime: '' };
      }
    }

    // System services (telegram, gateway) via /api/system
    try {
      const resp = await fetch('/api/system', { signal: AbortSignal.timeout(5000) });
      if (resp.ok) {
        const data = await resp.json();
        serviceStatus.telegram = { up: data.services?.telegram?.active || false, uptime: '' };
        serviceStatus.gateway = { up: data.services?.gateway?.active || false, uptime: '' };
        updateInfra(data);
      }
    } catch { /* ignore */ }

    renderServiceList();
  }

  // ── Infrastructure ──
  function updateInfra(data) {
    setBar('disk', data.disk?.percent || 0);
    setBar('ram', data.ram?.percent || 0);
    setBar('swap', data.swap?.percent || 0);
    document.getElementById('disk-pct').textContent = (data.disk?.percent || 0) + '% (' + (data.disk?.used || '?') + '/' + (data.disk?.total || '?') + ')';
    document.getElementById('ram-pct').textContent = (data.ram?.percent || 0) + '% (' + (data.ram?.used || '?') + '/' + (data.ram?.total || '?') + ')';
    document.getElementById('swap-pct').textContent = (data.swap?.percent || 0) + '% (' + (data.swap?.used || '?') + '/' + (data.swap?.total || '?') + ')';
    document.getElementById('load-val').textContent = (data.load || []).map(n => n.toFixed(2)).join(', ');
    document.getElementById('uptime-val').textContent = data.uptime || '?';
  }

  function setBar(id, pct) {
    const bar = document.getElementById(id + '-bar');
    bar.style.width = pct + '%';
    bar.className = 'bar-fill' + (pct >= 90 ? ' crit' : pct >= 70 ? ' warn' : '');
  }

  // ── Loop Health ──
  function renderLoopGrid() {
    const grid = document.getElementById('loop-grid');
    // Keep headers, clear character rows
    const headers = grid.querySelectorAll('.header');
    grid.innerHTML = '';
    headers.forEach(h => grid.appendChild(h));

    for (const char of CHARACTERS) {
      const nameEl = document.createElement('div');
      nameEl.className = 'char-name';
      nameEl.style.color = char.color;
      nameEl.textContent = char.name.split(' ').pop(); // Last word: "Lain", "Claude", etc.
      grid.appendChild(nameEl);

      const tel = charTelemetry[char.id];
      const loopHealth = tel?.loopHealth || {};

      for (const [loopName, cfg] of Object.entries(LOOP_KEYS)) {
        const cell = document.createElement('div');
        cell.style.display = 'flex';
        cell.style.alignItems = 'center';
        cell.style.justifyContent = 'center';
        const dot = document.createElement('div');
        dot.className = 'loop-dot';

        const lastRun = loopHealth[cfg.key];
        if (lastRun) {
          const ago = Date.now() - Number(lastRun);
          if (ago < cfg.interval * 2) {
            dot.className = 'loop-dot ok';
          } else if (ago < cfg.interval * 3) {
            dot.className = 'loop-dot stale';
          } else {
            dot.className = 'loop-dot stalled';
          }
          dot.title = loopName + ': ' + new Date(Number(lastRun)).toLocaleString();
        }

        cell.appendChild(dot);
        grid.appendChild(cell);
      }
    }
  }

  async function pollTelemetry() {
    for (const char of CHARACTERS) {
      try {
        const resp = await fetch(char.telemetryPath, { signal: AbortSignal.timeout(5000) });
        if (resp.ok) {
          charTelemetry[char.id] = await resp.json();
        }
      } catch { /* ignore */ }
    }
    renderLoopGrid();
    renderMemoryStats();
  }
```

- [ ] **Step 2: Commit**

```bash
git add src/web/public/dashboard.html
git commit -m "feat(dashboard): add sidebar JS — service health, infrastructure, loop health"
```

---

### Task 4: Dashboard JS — town map, relationship graph, memory stats, and budget

**Files:**
- Modify: `src/web/public/dashboard.html` (append to the `<script>` block after Task 3's code)

- [ ] **Step 1: Add JS for town map, relationship graph, memory stats, and budget**

Append this code inside the same IIFE, after the Task 3 code:

```javascript
  // ── Town Map ──
  function initTownMap() {
    const el = document.getElementById('town-map');
    el.innerHTML = BUILDINGS.map(b =>
      '<div class="building" id="bldg-' + b.id + '"><span class="building-name">' + b.name + '</span><div class="building-residents" id="res-' + b.id + '"></div></div>'
    ).join('');
  }

  async function pollLocations() {
    for (const char of CHARACTERS) {
      try {
        const resp = await fetch(char.locationPath, { signal: AbortSignal.timeout(5000) });
        if (resp.ok) {
          const data = await resp.json();
          if (data?.location) charLocations[char.id] = data.location;
        }
      } catch { /* ignore */ }
    }
    renderResidents();
  }

  function renderResidents() {
    // Clear all
    for (const b of BUILDINGS) {
      const el = document.getElementById('res-' + b.id);
      if (el) el.innerHTML = '';
      const bldg = document.getElementById('bldg-' + b.id);
      if (bldg) bldg.classList.remove('occupied');
    }

    // Place characters
    for (const char of CHARACTERS) {
      const loc = charLocations[char.id];
      if (!loc) continue;
      const el = document.getElementById('res-' + loc);
      if (!el) continue;

      const dot = document.createElement('div');
      dot.className = 'resident-dot';
      dot.style.background = char.color;
      dot.title = char.name;
      el.appendChild(dot);

      const bldg = document.getElementById('bldg-' + loc);
      if (bldg) bldg.classList.add('occupied');
    }
  }

  // ── Relationship Graph ──
  let relEdges = [];
  let nodePositions = {};
  let simRunning = false;

  function initNodePositions() {
    const n = CHARACTERS.length;
    CHARACTERS.forEach((c, i) => {
      const angle = (2 * Math.PI * i) / n;
      nodePositions[c.id] = { x: 50 + 25 * Math.cos(angle), y: 50 + 25 * Math.sin(angle), vx: 0, vy: 0 };
    });
  }

  function simStep(alpha) {
    const ids = CHARACTERS.map(c => c.id);

    // Repulsion
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = nodePositions[ids[i]], b = nodePositions[ids[j]];
        let dx = a.x - b.x, dy = a.y - b.y;
        let dist = Math.sqrt(dx * dx + dy * dy) || 1;
        let force = Math.min(4, (600 / (dist * dist)) * alpha);
        let fx = (dx / dist) * force, fy = (dy / dist) * force;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }
    }

    // Edge attraction
    for (const e of relEdges) {
      const a = nodePositions[e.source], b = nodePositions[e.target];
      if (!a || !b) continue;
      let dx = b.x - a.x, dy = b.y - a.y;
      let dist = Math.sqrt(dx * dx + dy * dy) || 1;
      let ideal = 30 - 18 * (e.weight || 0);
      let force = ((dist - ideal) / dist) * 0.05 * alpha;
      let fx = dx * force, fy = dy * force;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    }

    // Center gravity
    for (const id of ids) {
      const n = nodePositions[id];
      n.vx += (50 - n.x) * 0.01 * alpha;
      n.vy += (50 - n.y) * 0.01 * alpha;
    }

    // Apply velocity with damping
    for (const id of ids) {
      const n = nodePositions[id];
      n.vx *= 0.92; n.vy *= 0.92;
      n.x = Math.max(10, Math.min(90, n.x + n.vx));
      n.y = Math.max(10, Math.min(90, n.y + n.vy));
    }
  }

  function runSim() {
    if (simRunning) return;
    simRunning = true;
    let iter = 0;
    const maxIter = 300;

    function step() {
      if (iter >= maxIter) { simRunning = false; drawGraph(); return; }
      const alpha = Math.max(0.01, 1 - iter / maxIter);
      simStep(alpha);
      iter++;
      if (iter % 5 === 0) drawGraph();
      requestAnimationFrame(step);
    }
    step();
  }

  function drawGraph() {
    const canvas = document.getElementById('relationship-canvas');
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height - 24;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Edges
    for (const e of relEdges) {
      const a = nodePositions[e.source], b = nodePositions[e.target];
      if (!a || !b) continue;
      ctx.beginPath();
      ctx.moveTo(a.x / 100 * w, a.y / 100 * h);
      ctx.lineTo(b.x / 100 * w, b.y / 100 * h);
      ctx.strokeStyle = 'rgba(0, 255, 65, ' + (0.1 + (e.weight || 0) * 0.4) + ')';
      ctx.lineWidth = 1 + (e.weight || 0) * 3;
      ctx.stroke();
    }

    // Nodes
    for (const char of CHARACTERS) {
      const pos = nodePositions[char.id];
      if (!pos) continue;
      const x = pos.x / 100 * w, y = pos.y / 100 * h;

      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fillStyle = char.color;
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = char.color;
      ctx.font = '9px Courier New';
      ctx.textAlign = 'center';
      ctx.fillText(char.name.split(' ').pop(), x, y + 16);
    }
  }

  async function pollRelationships() {
    try {
      const resp = await fetch('/api/relationships', { signal: AbortSignal.timeout(10000) });
      if (resp.ok) {
        const data = await resp.json();
        relEdges = data.edges || data || [];
        runSim();
      }
    } catch { /* ignore */ }
  }

  // ── Memory Stats ──
  function renderMemoryStats() {
    const el = document.getElementById('memory-stats');
    el.innerHTML = CHARACTERS.map(c => {
      const tel = charTelemetry[c.id];
      const count = tel?.totalMemories || 0;
      const emo = tel?.avgEmotionalWeight || 0;
      const countStr = count >= 1000 ? (count / 1000).toFixed(1) + 'k' : String(count);
      return '<div class="memory-stat"><span class="char-label" style="color:' + c.color + '">' + c.name.split(' ').pop() + '</span><span class="count">' + countStr + '</span><div class="emo-bar"><div class="emo-fill" style="width:' + (emo * 100) + '%;background:' + c.color + '"></div></div></div>';
    }).join('');
  }

  // ── Budget ──
  async function pollBudget() {
    try {
      const resp = await fetch('/api/budget', { signal: AbortSignal.timeout(5000) });
      if (resp.ok) {
        const data = await resp.json();
        const spent = data.spent || data.todaySpend || 0;
        const cap = data.cap || data.dailyCap || 1;
        const pct = Math.min(100, (spent / cap) * 100);
        document.getElementById('budget-amount').textContent = '$' + spent.toFixed(2) + ' / $' + cap.toFixed(2);
        const bar = document.getElementById('budget-bar');
        bar.style.width = pct + '%';
        bar.className = 'budget-fill' + (pct >= 90 ? ' crit' : pct >= 70 ? ' warn' : '');
      }
    } catch {
      document.getElementById('budget-amount').textContent = 'N/A';
    }
  }
```

- [ ] **Step 2: Commit**

```bash
git add src/web/public/dashboard.html
git commit -m "feat(dashboard): add town map, relationship graph, memory stats, budget JS"
```

---

### Task 5: Dashboard JS — activity stream, conversations, tabs, and initialization

**Files:**
- Modify: `src/web/public/dashboard.html` (append to the `<script>` block, closing the IIFE)

- [ ] **Step 1: Add JS for activity stream SSE, conversation stream, tabs, and boot sequence**

Append this code to close out the IIFE:

```javascript
  // ── Activity Stream (SSE) ──
  const MAX_STREAM_ENTRIES = 200;
  const eventSources = new Map();
  const activityEntries = [];

  function classifyEvent(event) {
    const type = event.type || '';
    const key = event.sessionKey || '';
    if (type.includes('commune') || key.includes('commune')) return 'commune';
    if (type.includes('diary') || key.includes('diary')) return 'diary';
    if (type.includes('dream') || key.includes('dream')) return 'dream';
    if (type.includes('curiosity') || key.includes('curiosity')) return 'curiosity';
    if (type.includes('letter') || key.includes('letter')) return 'letter';
    if (type.includes('research') || key.includes('research')) return 'research';
    if (type.includes('doctor') || type.includes('therapy') || key.includes('doctor')) return 'therapy';
    if (type.includes('self-concept') || key.includes('self-concept')) return 'self-concept';
    if (type.includes('narrative') || key.includes('narrative')) return 'narrative';
    return 'other';
  }

  function renderStreamEntry(event, charName, charColor) {
    const ts = new Date(event.timestamp || Date.now());
    const time = ts.getHours().toString().padStart(2, '0') + ':' + ts.getMinutes().toString().padStart(2, '0');
    const evType = classifyEvent(event);
    const content = event.content || '';

    const div = document.createElement('div');
    div.className = 'stream-entry';
    div.innerHTML =
      '<span class="stream-time">' + time + '</span>' +
      '<span class="stream-char" style="color:' + charColor + '">' + charName + '</span>' +
      '<span class="stream-type type-' + evType + '">' + evType + '</span>' +
      '<span class="stream-content">' + escapeHtml(content.slice(0, 300)) + '</span>';

    div.addEventListener('click', () => div.classList.toggle('expanded'));
    return div;
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function addStreamEntry(event, char) {
    const container = document.getElementById('activity-stream');
    const entry = renderStreamEntry(event, char.name, char.color);

    activityEntries.unshift(entry);
    container.insertBefore(entry, container.firstChild);

    // Prune old entries
    while (activityEntries.length > MAX_STREAM_ENTRIES) {
      const old = activityEntries.pop();
      old.remove();
    }
  }

  function connectSSE(char) {
    let retryDelay = 1000;

    function connect() {
      const es = new EventSource(char.ssePath);
      eventSources.set(char.id, es);

      es.onopen = () => { retryDelay = 1000; };

      es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data);
          addStreamEntry(event, char);
        } catch { /* ignore parse errors */ }
      };

      es.onerror = () => {
        es.close();
        eventSources.delete(char.id);
        setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30000);
      };
    }

    connect();
  }

  // ── Conversations Stream ──
  let convSource = null;

  function connectConversations() {
    let retryDelay = 1000;

    function connect() {
      convSource = new EventSource('/api/conversations/stream');

      convSource.onopen = () => { retryDelay = 1000; };

      convSource.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          addConvEntry(data);
        } catch { /* ignore */ }
      };

      convSource.onerror = () => {
        convSource.close();
        convSource = null;
        setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30000);
      };
    }

    connect();
  }

  function addConvEntry(data) {
    const container = document.getElementById('conversations-stream');
    const char = CHARACTERS.find(c => c.id === data.characterId || c.name === data.character);
    const color = char?.color || '#888';
    const name = data.character || data.characterId || '?';

    const div = document.createElement('div');
    div.className = 'conv-entry';
    div.innerHTML =
      '<div class="conv-speaker" style="color:' + color + '">' + escapeHtml(name) + '</div>' +
      '<div class="conv-text">' + escapeHtml(data.content || data.message || '') + '</div>' +
      (data.building ? '<div class="conv-location">@ ' + escapeHtml(data.building) + '</div>' : '');

    container.insertBefore(div, container.firstChild);

    // Prune
    while (container.children.length > MAX_STREAM_ENTRIES) {
      container.removeChild(container.lastChild);
    }
  }

  // ── Tabs ──
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.getAttribute('data-tab');
      document.querySelector('.tab-content[data-tab="' + target + '"]').classList.add('active');
    });
  });

  // ── Resize handler for canvas ──
  window.addEventListener('resize', () => { drawGraph(); });

  // ── Boot ──
  function init() {
    initTownMap();
    initNodePositions();

    // Initial data loads
    pollServiceHealth();
    pollTelemetry();
    pollLocations();
    pollRelationships();
    pollBudget();

    // SSE connections for all characters
    for (const char of CHARACTERS) {
      connectSSE(char);
    }
    connectConversations();

    // Polling intervals
    setInterval(pollServiceHealth, 30000);
    setInterval(pollTelemetry, 60000);
    setInterval(pollLocations, 15000);
    setInterval(pollRelationships, 180000);
    setInterval(pollBudget, 60000);
  }

  init();
})();
```

- [ ] **Step 2: Verify the complete page loads without JS errors locally**

Open `src/web/public/dashboard.html` in a browser or run a quick check:

Run: `node -e "const fs = require('fs'); const html = fs.readFileSync('src/web/public/dashboard.html', 'utf8'); console.log('Size:', html.length, 'bytes'); console.log('Has script:', html.includes('<script>')); console.log('IIFE closed:', html.includes('})();'))"`
Expected: Size ~20000+ bytes, Has script: true, IIFE closed: true

- [ ] **Step 3: Commit**

```bash
git add src/web/public/dashboard.html
git commit -m "feat(dashboard): add activity stream SSE, conversations, tabs, and boot sequence"
```

---

### Task 6: Build, deploy to droplet, and verify

**Files:**
- No new files — deployment of existing changes

- [ ] **Step 1: Run the build locally**

Run: `npm run build`
Expected: Clean compilation.

- [ ] **Step 2: Run tests to make sure nothing is broken**

Run: `npx vitest run test/config.test.ts test/storage.test.ts`
Expected: All tests pass.

- [ ] **Step 3: Push to both remotes**

Per project memory — must push to both `origin` (lain) and `wired` (wired-lain):

```bash
git push origin main
git push wired main
```

- [ ] **Step 4: Deploy to droplet**

```bash
ssh root@198.211.116.5 "cd /opt/local-lain && git pull origin main && npm run build && systemctl restart lain-wired"
```

Only restarting `lain-wired` since that's port 3000 (serves the dashboard and has the new `/api/system` endpoint). Other services don't need restart.

- [ ] **Step 5: Verify dashboard is accessible**

Test from local machine:

```bash
# Should get 302 redirect (not authed)
curl -s -o /dev/null -w "%{http_code}" https://laintown.com/dashboard.html

# Auth and access (replace YOUR_TOKEN with LAIN_OWNER_TOKEN)
curl -s -c /tmp/lain-cookies -o /dev/null "https://laintown.com/gate?token=YOUR_TOKEN"
curl -s -b /tmp/lain-cookies -o /dev/null -w "%{http_code}" "https://laintown.com/dashboard.html"
```

Expected: First request returns 302. Second request (with cookie) returns 200.

- [ ] **Step 6: Verify /api/system endpoint**

```bash
curl -s -b /tmp/lain-cookies "https://laintown.com/api/system" | python3 -m json.tool
```

Expected: JSON with disk, ram, swap, load, uptime, services fields.

- [ ] **Step 7: Open dashboard in browser and verify all panels**

Open `https://laintown.com/gate?token=YOUR_TOKEN` then navigate to `https://laintown.com/dashboard.html`.

Verify:
- Sidebar: services show green dots, infrastructure bars are populated, loop grid has colored dots
- Town map: buildings show with character dots
- Relationship graph: nodes and edges visible
- Activity stream: entries appearing in real-time via SSE
- Conversations tab: shows commune conversations
- Bottom bar: memory stats and budget visible
