# Laintown Live Dashboard — Design Spec

**Date:** 2026-04-10
**Status:** Approved

## Overview

A single-page, owner-gated, live dashboard served at `/dashboard` from Wired Lain's web server (port 3000). Cyberpunk/terminal aesthetic consistent with Serial Experiments Lain. Sidebar + panels layout. All data sourced from existing APIs via SSE and polling. No build step, no frameworks — vanilla JS/CSS like the rest of the frontend.

## Layout

### Fixed Left Sidebar (~220px)

Three stacked sections:

**1. Service Health**
- All 9 services listed: Wired Lain, Lain, Telegram, Gateway, Dr. Claude, PKD, McKenna, John, Hiru
- Each row: colored dot (green/red) + service name + uptime duration
- Dot pulses gently when healthy

**2. Infrastructure**
- Disk usage: progress bar + percentage
- RAM usage: progress bar + percentage
- Swap usage: progress bar + percentage
- Load average: numeric display
- Color coding: green < 70%, yellow 70-90%, red > 90%

**3. Loop Health**
- Grid of characters (rows) vs loop types (columns): diary, dream, curiosity, self-concept, commune
- Each cell: colored dot based on last run time
  - Green: ran within expected interval
  - Yellow: 2x expected interval (stale)
  - Red: 3x+ expected interval (stalled)
- Hover shows last run timestamp

### Main Area

**Top Row — Two Equal Panels:**

**Town Map (left)**
- 3x3 building grid: Library, Bar, Field, Windmill, Lighthouse, School, Market, Locksmith, Threshold
- Character dots inside buildings showing current locations
- Character colors match commune-map conventions
- Buildings dim/glow based on occupancy

**Relationship Graph (right)**
- Force-directed network graph
- Nodes = characters (colored, labeled)
- Edges = conversation weights (thickness proportional to interaction frequency)
- Canvas-rendered with simple force simulation (reuse pattern from commune-map network view)

**Middle — Full Width, Tabbed:**

Two tabs:

**Activity Stream tab (default)**
- Merged real-time feed from all character SSE streams
- Each entry: timestamp, character name (colored), event type badge, content preview
- Event type badges color-coded: research=blue, diary=purple, dream=indigo, curiosity=cyan, letter=pink, commune=green, therapy=yellow
- Click to expand full content
- Auto-scrolls, pause on hover
- Max 200 entries in DOM, oldest pruned

**Conversations tab**
- Live commune conversation eavesdrop via `/api/conversations/stream`
- Shows character name, message content, building location
- Grouped by conversation (visual separator between different exchanges)

**Bottom Bar — Full Width:**

**Memory Stats (left ~70%)**
- Per-character: name, total memory count, emotional weight as small bar
- Compact horizontal layout, one row

**Budget (right ~30%)**
- Daily token spend vs cap: `$0.42 / $1.00`
- Progress bar, color-coded (green/yellow/red)

## Data Sources & Update Strategy

| Panel | Endpoint | Method | Refresh Rate |
|-------|----------|--------|-------------|
| Service health | `/api/health` on ports 3000-3006 + `/api/system` for non-HTTP services (Telegram, Gateway) | Poll via proxy | 30s |
| Infrastructure | `GET /api/system` (new) | Poll | 30s |
| Loop health | `/api/telemetry` on ports 3000-3006 | Poll via proxy | 60s |
| Town map / locations | `/api/location` on ports 3000-3006 | Poll via proxy | 15s |
| Relationship graph | `GET /api/relationships` | Poll | 3 min |
| Activity stream | `/api/events` on ports 3000-3006 | SSE via proxy | Real-time |
| Conversations | `GET /api/conversations/stream` | SSE | Real-time |
| Memory stats | `/api/telemetry` on ports 3000-3006 | Poll via proxy | 60s |
| Budget | `GET /api/budget` | Poll | 60s |

## New Backend Work

### 1. `GET /api/system` endpoint

Returns OS-level stats. Owner-auth protected.

```json
{
  "disk": { "total": "48G", "used": "36G", "available": "12G", "percent": 76 },
  "ram": { "total": "1.9Gi", "used": "1.4Gi", "free": "429Mi", "percent": 74 },
  "swap": { "total": "4.0Gi", "used": "1.8Gi", "free": "2.2Gi", "percent": 45 },
  "load": [3.03, 2.79, 2.45],
  "uptime": "3 days, 10:25"
}
```

Also includes service status for non-HTTP services:

```json
{
  "services": {
    "telegram": { "active": true, "uptime": "17h" },
    "gateway": { "active": true, "uptime": "17h" }
  }
}
```

Implementation: `child_process.execSync` running `df -h /`, `free -h`, `uptime`, and `systemctl is-active` for Telegram/Gateway. Parse output into JSON. Cached for 10s to avoid hammering.

### 2. `GET /api/proxy/:port/*` proxy route

Proxies requests from the dashboard to character servers on other ports, so the dashboard only needs one origin. Owner-auth protected.

- Allowed ports: 3001-3006 (character servers only)
- Passes through query params
- For SSE endpoints, pipes the response stream
- Strips/rewrites Host header

### 3. `GET /dashboard` route

Serves `dashboard.html` behind `requireOwnerAuth` middleware. Same auth pattern as existing owner-only pages (index.html, dreams.html, postboard.html).

## Frontend

### Files

Single file: `src/web/public/dashboard.html` with inline `<style>` and `<script>`. No external dependencies. Matches the pattern of commune-map.html, dreams.html, etc.

### Visual Style

- Background: `#0a0a0a`
- Panel background: `#111` with `1px solid rgba(0, 255, 65, 0.2)` borders
- Header/label text: `#00ff41` (terminal green)
- Body text: `#888`
- Emphasis text: `#fff`
- Font: `'Courier New', monospace` throughout
- CRT scanline overlay: subtle CSS `repeating-linear-gradient` at low opacity
- Healthy indicators: soft green glow (`box-shadow: 0 0 6px #00ff41`)
- Warning indicators: yellow (`#ffaa00`)
- Error indicators: red (`#ff4444`)

### Character Colors

Consistent with commune-map:

| Character | Color |
|-----------|-------|
| Wired Lain | `#ff00ff` (magenta) |
| Lain | `#00ffff` (cyan) |
| Dr. Claude | `#44ff44` (green) |
| PKD | `#ff8800` (orange) |
| McKenna | `#ffff00` (yellow) |
| John | `#8888ff` (blue) |
| Hiru | `#ff4488` (pink) |

### SSE Connection Management

- One EventSource per character server (7 total), connected via proxy
- Exponential backoff on disconnect: 1s min, 30s max (same pattern as commune-map)
- 30s heartbeat expected; reconnect if missed
- Connection status indicators in sidebar (dot flickers on reconnect)

### DOM Management

- Activity stream: max 200 entries, prune oldest when exceeded
- All polling uses `AbortController` for cleanup
- Timers tracked for cleanup on page unload

## Auth

Uses existing owner cookie auth. Flow:
1. User visits `/gate?token=LAIN_OWNER_TOKEN` (existing endpoint)
2. Gets signed HTTP-only cookie
3. `/dashboard` checks cookie via `requireOwnerAuth` middleware
4. Proxy endpoints also require owner auth — cookie forwarded automatically (same origin)

## Scope Boundaries

**In scope:**
- All 9 panels described above
- Real-time updates via SSE + polling
- Owner-auth gating
- `/api/system` endpoint
- `/api/proxy/:port/*` proxy
- Single HTML file with inline CSS/JS

**Out of scope:**
- Historical data / time-series charts
- Alerting or notifications
- Mobile-responsive layout (desktop-only is fine)
- Persistent settings or preferences
- Any build tooling or framework
