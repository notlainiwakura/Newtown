# Dreams Dashboard — Design Spec

## Problem

Dream seeding currently requires SSH access and a shell script (`scripts/dream-seed.sh`). There's no visibility into what seeds exist, which have been consumed, or when dream cycles last fired. The admin needs a web UI for uploading seed material and monitoring dream activity across all characters.

## Solution

A new `/dreams.html` admin page with three sections: upload, summary stats, and seed feed. Accessible via a DREAMS tab in the nav bar. First page to use the skins CSS variable system, establishing the pattern for future page migrations.

## Page Structure

### Section 1: Upload

A compose area at the top with two input modes:

**File upload**: Drag-and-drop zone + file picker button. Accepts `.txt` and `.rtf` files. On file selection:
1. Read file content client-side (strip RTF formatting if `.rtf`)
2. Split into fragments of 400-1900 characters at sentence boundaries (same logic as `scripts/dream-seed.sh`)
3. Show fragment preview: count of fragments, first/last fragment preview (truncated to ~100 chars)
4. Character target selector: checkboxes for each character, "ALL" toggle checked by default
5. "SEED" button to send

**Text paste**: A textarea as alternative to file upload. Same split-and-preview flow on input.

**Sending flow**: On submit, POST each fragment sequentially to each target character's `/api/interlink/dream-seed` endpoint via the Wired Lain proxy. Show a progress bar (e.g., "Seeding 12/47 fragments to PKD..."). On completion, show success count and any failures.

**Endpoint routing**: Each character has a different port. The page sends fragments via the character proxy paths:
- Wired Lain: `POST /api/interlink/dream-seed`
- Lain: `POST /local/api/interlink/dream-seed`
- PKD: `POST /pkd/api/interlink/dream-seed`
- McKenna: `POST /mckenna/api/interlink/dream-seed`
- John: `POST /john/api/interlink/dream-seed`
- Dr. Claude: `POST /dr-claude/api/interlink/dream-seed`
- Hiru: `POST /hiru/api/interlink/dream-seed`

Auth: `Authorization: Bearer <key>` header, where key comes from the `?key=` URL param or the `<meta name="lain-api-key">` tag.

### Section 2: Summary Stats

A row of character cards, one per character. Each card shows:
- Character name
- Pending seeds count (unconsumed `isAlienDreamSeed` memories)
- Consumed seeds count
- Last dream cycle timestamp (from meta key `dreams:lastCycleAt`)

Plus a "TOTAL" card aggregating all characters.

Auto-refreshes every 30 seconds.

**Data source**: New `GET /api/dreams/status` endpoint on Wired Lain's server. This endpoint queries each peer character's dream status via HTTP and aggregates the results. Each character server exposes a new `GET /api/dreams/stats` endpoint that queries its local DB.

### Section 3: Seed Feed

A scrollable, chronologically sorted (newest first) list of all dream seeds across all characters. Each entry shows:
- Character name (color-coded tag)
- Status badge: PENDING (amber) or CONSUMED (green)
- Content preview (first ~120 characters, truncated with ellipsis)
- Timestamp (deposited at / consumed at)
- Expandable: click to reveal full content

**Data source**: New `GET /api/dreams/seeds` endpoint on Wired Lain's server. Queries each peer for their seeds and merges them chronologically. Each character server exposes `GET /api/dreams/seeds` returning its local alien dream seeds.

Paginated: loads 50 at a time, "load more" button at bottom.

## New API Endpoints

### On each character server (`character-server.ts` + `server.ts`)

**`GET /api/dreams/stats`** — Returns dream status for this character.

Requires interlink auth.

Response:
```json
{
  "characterId": "pkd",
  "pending": 5,
  "consumed": 12,
  "lastDreamCycle": 1743868800000
}
```

Implementation: Count memories where `session_key = 'alien:dream-seed'` and `metadata` contains `isAlienDreamSeed: true`. Split by `consumed` status. Read `dreams:lastCycleAt` from meta store.

**`GET /api/dreams/seeds?limit=50&offset=0`** — Returns dream seed memories for this character.

Requires interlink auth.

Response:
```json
{
  "characterId": "pkd",
  "seeds": [
    {
      "id": "abc123",
      "content": "The memory of water...",
      "status": "pending",
      "depositedAt": 1743868800000,
      "consumedAt": null,
      "emotionalWeight": 0.5
    }
  ],
  "total": 17
}
```

### On Wired Lain's server (`server.ts`)

**`GET /api/dreams/status`** — Aggregates stats from all peers.

Requires API auth (same as town events).

Response:
```json
{
  "characters": [
    { "id": "lain", "name": "Lain", "pending": 3, "consumed": 8, "lastDreamCycle": 1743868800000 },
    { "id": "pkd", "name": "PKD", "pending": 5, "consumed": 12, "lastDreamCycle": 1743865200000 }
  ],
  "totals": { "pending": 20, "consumed": 45 }
}
```

Implementation: Reads peer list from config. For each peer, fetches `GET {peer.url}/api/dreams/stats` with interlink auth. Merges results.

**`GET /api/dreams/seeds?limit=50&offset=0`** — Aggregates seeds from all peers.

Requires API auth.

Response:
```json
{
  "seeds": [
    {
      "id": "abc123",
      "characterId": "pkd",
      "characterName": "Philip K. Dick",
      "content": "The memory of water...",
      "status": "pending",
      "depositedAt": 1743868800000,
      "consumedAt": null,
      "emotionalWeight": 0.5
    }
  ],
  "total": 65
}
```

Implementation: Fetches seeds from all peers, merges, sorts by `depositedAt` DESC, applies limit/offset.

## Skins Integration

The page uses CSS custom properties from the skin system instead of hardcoded colors:

```html
<head>
  <script src="/skins/early-load.js"></script>
  <!-- ... -->
  <script src="/skins/loader.js" defer></script>
</head>
```

All styles reference CSS variables:
- `background: var(--bg-deep)` instead of `#05050a`
- `color: var(--text-primary)` instead of `#a0b0c0`
- `border-color: var(--border-glow)` instead of `#1a2a3a`
- `color: var(--accent-primary)` instead of `#4a9eff`

Fallback values are included for when no skin is loaded: `var(--bg-deep, #0a0a1a)`.

## Nav Bar

Add DREAMS tab between EVENTS and LAIN in both:
- `src/web/server.ts` (NAV_LINKS array, line ~402)
- `src/web/public/laintown-nav.js` (links array, line ~4)

```javascript
{ label: 'DREAMS', href: '/dreams.html' }
```

## Fragment Splitting (Client-Side)

Port the splitting logic from `scripts/dream-seed.sh` to JavaScript:

1. Strip RTF formatting if file is `.rtf` (remove `{\rtf1...}` control words, keep text)
2. Split on double newlines into paragraphs
3. Accumulate paragraphs into chunks of 400-1900 characters
4. If a single paragraph exceeds 1900 chars, split at sentence boundaries (`. `, `! `, `? `)
5. Trim whitespace from each fragment
6. Discard empty fragments

## File Layout

```
src/web/public/dreams.html    — the page (HTML + inline CSS + inline JS)
```

No new TypeScript files — the API endpoints are added to the existing `server.ts` and `character-server.ts`. The page is pure static HTML with inline JavaScript, same as all other admin pages.

## Auth

Same pattern as town-events.html:
- Page reads API key from `?key=` URL param or `<meta name="lain-api-key">` tag
- Sends as `Authorization: Bearer <key>` header on all API calls
- Per-character dream-seed calls also use this key (the proxy forwards the auth header)

## Style

Dark monospace aesthetic consistent with the rest of Laintown. Header with "DREAMS" title and subtitle "subconscious seeding interface". Upload area has a dashed border that glows on dragover. Character cards have subtle borders that pulse when a dream cycle is recent (< 1 hour). Seed feed entries use left-border color coding per character.
