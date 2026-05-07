# Skin System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a global visual theming system to Laintown with 6 skins (default, vaporwave, kawaii, gothic, hardcore, terminal) that restyle every visual surface — CSS, sprites, icons, newspaper, game view, all character pages.

**Architecture:** CSS custom property overrides loaded dynamically via `<link>` tags. Each skin is a directory under `src/web/skins/` containing `manifest.json`, `skin.css`, and `sprites.json`. A runtime loader reads skin preference from URL `?skin=` param or localStorage, injects the skin CSS after base styles, and fires a `skin-changed` event for JS components that need to react (commune map icons, game sprites). A small picker widget appears on every page.

**Tech Stack:** Vanilla CSS custom properties, vanilla JS (no build step for skin files — served as static assets), JSON configs for sprites and manifests.

**Spec:** `docs/superpowers/specs/2026-04-02-skin-system-design.md`

---

## File Structure Overview

**New files to create:**
- `src/web/skins/registry.json` — List of all available skins
- `src/web/skins/loader.js` — Runtime skin loading/switching
- `src/web/skins/picker.js` — Skin picker widget
- `src/web/skins/picker.css` — Picker styles (skin-agnostic)
- `src/web/skins/default/manifest.json` — Default skin metadata
- `src/web/skins/default/skin.css` — Default skin (current colors extracted)
- `src/web/skins/default/sprites.json` — Default sprite colors
- `src/web/skins/vaporwave/manifest.json`, `skin.css`, `sprites.json`
- `src/web/skins/kawaii/manifest.json`, `skin.css`, `sprites.json`
- `src/web/skins/gothic/manifest.json`, `skin.css`, `sprites.json`
- `src/web/skins/hardcore/manifest.json`, `skin.css`, `sprites.json`
- `src/web/skins/terminal/manifest.json`, `skin.css`, `sprites.json`

**Files to modify:**
- `src/web/public/styles.css` — Rename accent vars to skin-agnostic names, extract remaining hardcoded colors
- `src/web/public/commune-map.css` — Same
- `src/web/public/commune-map.js` — Read colors from CSS variables and skin manifest instead of hardcoded JS objects
- `src/web/public/game/js/config.js` — Read character colors from skin system
- `src/web/public/game/js/sprites.js` — Accept sprite config overrides from skin
- `src/web/public/game/js/scenes/WorldScene.js` — Read UI colors from CSS variables
- `src/web/public/newspaper.html` — Migrate inline colors to CSS variables
- `src/web/public/commune-newspaper.html` — Same
- `src/web/public/index.html` — Add skin loader script
- `src/web/server.ts` — Serve `/skins/` static directory
- `src/web/character-server.ts` — Same

---

## Task 1: Serve the skins directory as static files

Both `server.ts` and `character-server.ts` need to serve files from `src/web/skins/`. This must come first so subsequent tasks can test by loading skin files in the browser.

**Files:**
- Modify: `src/web/server.ts`
- Modify: `src/web/character-server.ts`

- [ ] **Step 1: Read server.ts to find static serving logic**

Read `src/web/server.ts` and identify where `PUBLIC_DIR` is defined and how `serveStatic` routes work. Find the exact lines where URL paths are matched to filesystem paths.

- [ ] **Step 2: Add skins directory constant and route in server.ts**

Add a `SKINS_DIR` constant pointing to `src/web/skins/` and add a route that serves `/skins/*` from that directory. Place it before the catch-all static route.

```typescript
const SKINS_DIR = join(__dirname, '..', '..', 'src', 'web', 'skins');
```

In the request handler, add before the existing static file serving:

```typescript
if (url.pathname.startsWith('/skins/')) {
  const skinPath = url.pathname.slice('/skins/'.length);
  return serveStatic(SKINS_DIR, skinPath);
}
```

- [ ] **Step 3: Read character-server.ts to find static serving logic**

Read `src/web/character-server.ts` and identify the equivalent static serving code.

- [ ] **Step 4: Add skins route in character-server.ts**

Same pattern — add `SKINS_DIR` and a `/skins/*` route before the catch-all. The path resolution is relative to the character-server.ts file, so adjust accordingly:

```typescript
const SKINS_DIR = join(__dirname, '..', '..', 'src', 'web', 'skins');
```

Route:
```typescript
if (url.pathname.startsWith('/skins/') || url.pathname.match(/^\/[^/]+\/skins\//)) {
  const skinPath = url.pathname.replace(/^\/[^/]*\/skins\//, '').replace(/^skins\//, '');
  return serveStatic(SKINS_DIR, skinPath);
}
```

- [ ] **Step 5: Add .json MIME type if missing**

Check both files' MIME type maps. If `.json` → `application/json` is not already present, add it.

- [ ] **Step 6: Create a test manifest to verify serving works**

Create `src/web/skins/default/manifest.json`:

```json
{
  "id": "default",
  "name": "Wired Protocol",
  "description": "Dark navy, blue/cyan glows, tech-noir atmosphere",
  "fonts": {
    "heading": "Orbitron",
    "body": "Share Tech Mono",
    "mono": "Share Tech Mono"
  },
  "buildingIcons": {
    "library": "📚",
    "bar": "🍺",
    "field": "🌾",
    "windmill": "🏗",
    "lighthouse": "🗼",
    "school": "🏫",
    "market": "🏪",
    "locksmith": "🔐",
    "threshold": "🚪"
  },
  "googleFontsUrl": "https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700&family=Share+Tech+Mono&display=swap",
  "previewColors": ["#4080ff", "#80c0ff", "#40e0ff"]
}
```

- [ ] **Step 7: Build and verify**

```bash
npm run build
```

Verify no TypeScript errors.

- [ ] **Step 8: Commit**

```bash
git add src/web/server.ts src/web/character-server.ts src/web/skins/default/manifest.json
git commit -m "feat(skins): serve /skins/ static directory from both servers"
```

---

## Task 2: Extract and normalize CSS custom properties in styles.css

The base stylesheet needs all visual values expressed as CSS custom properties with skin-agnostic names. Currently some use color-specific names (`--accent-blue`) and many colors are hardcoded.

**Files:**
- Modify: `src/web/public/styles.css`

- [ ] **Step 1: Read styles.css fully**

Read the complete `src/web/public/styles.css` to identify all `:root` variables and every hardcoded color value.

- [ ] **Step 2: Rename color-specific variables to skin-agnostic names**

In `:root` (lines 6-22), rename:
- `--accent-blue` → `--accent-primary`
- `--accent-light` → `--accent-secondary`
- `--accent-cyan` → `--accent-tertiary`
- `--glow-blue` → `--glow-primary`

Then find-and-replace all usages of the old names throughout the file:
- `var(--accent-blue)` → `var(--accent-primary)`
- `var(--accent-light)` → `var(--accent-secondary)`
- `var(--accent-cyan)` → `var(--accent-tertiary)`
- `var(--glow-blue)` → `var(--glow-primary)`

- [ ] **Step 3: Add new skinnable variables to :root**

Add these new variables after the existing ones:

```css
/* Borders & shapes */
--border-radius: 4px;
--border-radius-lg: 8px;
--border-style: solid;
--border-width: 1px;

/* Effects */
--scanline-opacity: 0.02;
--particle-color: rgba(64, 128, 255, 0.3);
--particle-opacity: 0.6;

/* Messages */
--msg-user-bg: rgba(40, 80, 140, 0.6);
--msg-user-border: rgba(100, 160, 255, 0.3);
--msg-assistant-bg: rgba(64, 128, 255, 0.15);
--msg-assistant-border: rgba(64, 200, 255, 0.3);
--msg-assistant-glow: 0 0 20px rgba(64, 200, 255, 0.1);

/* Status */
--status-online: #40ff80;
--status-error: #ff6060;
--error-text: #ff8080;
--error-bg: rgba(255, 80, 80, 0.1);
--error-border: rgba(255, 80, 80, 0.3);
```

- [ ] **Step 4: Replace hardcoded colors with the new variables**

Go through the file and replace hardcoded color values with their variable equivalents:
- `#40ff80` (green status) → `var(--status-online)`
- `#ff8080`, `#ff6060` (error colors) → `var(--error-text)`, `var(--status-error)`
- Error backgrounds → `var(--error-bg)`, `var(--error-border)`
- Message backgrounds → `var(--msg-user-bg)`, `var(--msg-assistant-bg)`, etc.
- Scanline `rgba(64, 128, 255, 0.02)` → use `var(--scanline-opacity)` in the rgba
- Grid pattern colors → derive from `var(--accent-primary)` with opacity
- Border radius values → `var(--border-radius)` or `var(--border-radius-lg)`

- [ ] **Step 5: Verify the page looks identical**

Build and load the page in a browser. The page should look exactly the same — we only extracted values, not changed them.

- [ ] **Step 6: Commit**

```bash
git add src/web/public/styles.css
git commit -m "refactor(css): normalize custom properties to skin-agnostic names in styles.css"
```

---

## Task 3: Extract and normalize CSS custom properties in commune-map.css

Same treatment for the commune map stylesheet.

**Files:**
- Modify: `src/web/public/commune-map.css`

- [ ] **Step 1: Read commune-map.css fully**

Read the complete file to identify all `:root` variables and hardcoded colors.

- [ ] **Step 2: Ensure variable names are consistent with styles.css**

The commune-map.css has its own `:root` block. Make sure variable names match what we defined in styles.css (e.g., use `--accent-primary` not `--accent-blue`). Add any missing variables that styles.css defines (border-radius, scanline-opacity, etc.).

- [ ] **Step 3: Extract hardcoded colors to variables**

Replace inline hex/rgba colors with CSS variable references where they represent skinnable values:
- Grid pattern colors
- Semi-transparent overlays
- Border colors that aren't using variables
- Node orb gradient colors

- [ ] **Step 4: Verify commune map looks identical**

Build and check the commune map page in a browser.

- [ ] **Step 5: Commit**

```bash
git add src/web/public/commune-map.css
git commit -m "refactor(css): normalize custom properties in commune-map.css"
```

---

## Task 4: Migrate newspaper inline styles to CSS variables

Both newspaper pages use extensive inline `<style>` blocks with hardcoded colors. Migrate these to use the same CSS variable system.

**Files:**
- Modify: `src/web/public/newspaper.html`
- Modify: `src/web/public/commune-newspaper.html`

- [ ] **Step 1: Read both newspaper files**

Read `newspaper.html` and `commune-newspaper.html` completely.

- [ ] **Step 2: Add CSS variable definitions to newspaper.html**

In the `<style>` block, add a `:root` section at the top that imports the same variable names used in styles.css. Set values to match the current hardcoded colors:

```css
:root {
  --bg-deep: #05050a;
  --bg-primary: #0a0a14;
  --text-primary: #a0b0c0;
  --text-secondary: #6a8aaf;
  --text-dim: #445;
  --accent-primary: #4a9eff;
  --border-glow: #1a2a3a;
  --font-system: 'Orbitron';
  --font-mono: 'Share Tech Mono';
  /* Character colors */
  --color-wired-lain: #4080ff;
  --color-lain: #80c0ff;
  --color-pkd: #c060ff;
  --color-mckenna: #40e080;
  --color-john: #ffb040;
  --color-dr-claude: #ff6060;
  /* Newspaper-specific */
  --newspaper-bg: #05050a;
  --newspaper-text: #8a9ab0;
  --newspaper-heading: #4a9eff;
  --newspaper-quote-border: #2a3a4e;
}
```

Then replace all inline hex colors with `var(--variable-name)` references.

- [ ] **Step 3: Do the same for commune-newspaper.html**

Same approach — add `:root` variables and replace hardcoded colors. Also replace the hardcoded `TYPE_COLORS` JavaScript object to read from CSS variables.

- [ ] **Step 4: Verify both newspapers look identical**

Build and check both pages.

- [ ] **Step 5: Commit**

```bash
git add src/web/public/newspaper.html src/web/public/commune-newspaper.html
git commit -m "refactor(newspaper): migrate inline colors to CSS custom properties"
```

---

## Task 5: Create the skin loader (loader.js)

The core runtime module that handles skin detection, loading, switching, and event broadcasting.

**Files:**
- Create: `src/web/skins/loader.js`
- Create: `src/web/skins/registry.json`

- [ ] **Step 1: Create registry.json**

```json
[
  "default",
  "vaporwave",
  "kawaii",
  "gothic",
  "hardcore",
  "terminal"
]
```

- [ ] **Step 2: Create loader.js**

```javascript
// Laintown Skin Loader
// Manages skin detection, loading, switching, and event broadcasting.

const SKIN_STORAGE_KEY = 'laintown-skin';
const SKIN_CHANGED_EVENT = 'skin-changed';
const DEFAULT_SKIN = 'default';

let currentSkinId = null;
let currentManifest = null;
let skinLinkEl = null;
let fontLinkEl = null;
let registry = null;

// Resolve the base path to /skins/ accounting for character sub-paths
function skinsBasePath() {
  // Character pages live at /pkd/, /mckenna/, etc.
  // Skin files are always served from /skins/ at the root or /charId/skins/
  const base = location.pathname.replace(/\/[^/]*$/, '');
  return `${base}/skins`.replace(/\/\/+/g, '/');
}

// Get skin ID from URL param, localStorage, or default
function detectSkin() {
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get('skin');
  if (fromUrl) return fromUrl;
  const fromStorage = localStorage.getItem(SKIN_STORAGE_KEY);
  if (fromStorage) return fromStorage;
  return DEFAULT_SKIN;
}

// Fetch the skin registry
async function getRegistry() {
  if (registry) return registry;
  try {
    const res = await fetch(`${skinsBasePath()}/registry.json`);
    registry = await res.json();
  } catch {
    registry = [DEFAULT_SKIN];
  }
  return registry;
}

// Fetch a skin's manifest
async function fetchManifest(skinId) {
  const res = await fetch(`${skinsBasePath()}/${skinId}/manifest.json`);
  if (!res.ok) throw new Error(`Skin "${skinId}" not found`);
  return res.json();
}

// Inject or replace the skin CSS link
function applySkinCSS(skinId) {
  if (skinLinkEl) skinLinkEl.remove();
  skinLinkEl = document.createElement('link');
  skinLinkEl.rel = 'stylesheet';
  skinLinkEl.href = `${skinsBasePath()}/${skinId}/skin.css`;
  skinLinkEl.id = 'laintown-skin-css';
  document.head.appendChild(skinLinkEl);
}

// Inject or replace the Google Fonts link
function applyFonts(manifest) {
  if (fontLinkEl) fontLinkEl.remove();
  if (manifest.googleFontsUrl) {
    fontLinkEl = document.createElement('link');
    fontLinkEl.rel = 'stylesheet';
    fontLinkEl.href = manifest.googleFontsUrl;
    fontLinkEl.id = 'laintown-skin-fonts';
    document.head.appendChild(fontLinkEl);
  }
}

// Update URL ?skin= param without reload
function updateUrl(skinId) {
  const url = new URL(location.href);
  if (skinId === DEFAULT_SKIN) {
    url.searchParams.delete('skin');
  } else {
    url.searchParams.set('skin', skinId);
  }
  history.replaceState(null, '', url.toString());
}

// Set skin and fire event
async function setSkin(skinId) {
  const reg = await getRegistry();
  if (!reg.includes(skinId)) {
    console.warn(`Skin "${skinId}" not in registry, falling back to default`);
    skinId = DEFAULT_SKIN;
  }

  const manifest = await fetchManifest(skinId);
  currentSkinId = skinId;
  currentManifest = manifest;

  applySkinCSS(skinId);
  applyFonts(manifest);
  localStorage.setItem(SKIN_STORAGE_KEY, skinId);
  updateUrl(skinId);
  document.documentElement.dataset.skin = skinId;

  document.dispatchEvent(new CustomEvent(SKIN_CHANGED_EVENT, {
    detail: { skinId, manifest }
  }));
}

// Get current skin ID
function getSkinId() {
  return currentSkinId || DEFAULT_SKIN;
}

// Get current manifest
function getSkinManifest() {
  return currentManifest;
}

// Get all available skins with their manifests (for picker)
async function getAvailableSkins() {
  const reg = await getRegistry();
  const skins = [];
  for (const id of reg) {
    try {
      const manifest = await fetchManifest(id);
      skins.push(manifest);
    } catch {
      // Skip skins that fail to load
    }
  }
  return skins;
}

// Listen for skin changes
function onSkinChange(callback) {
  const handler = (e) => callback(e.detail.skinId, e.detail.manifest);
  document.addEventListener(SKIN_CHANGED_EVENT, handler);
  return () => document.removeEventListener(SKIN_CHANGED_EVENT, handler);
}

// Fetch sprite config for current skin
async function getSpriteConfig() {
  const skinId = getSkinId();
  try {
    const res = await fetch(`${skinsBasePath()}/${skinId}/sprites.json`);
    if (res.ok) return res.json();
  } catch { /* fall through */ }
  // Fallback to default
  if (skinId !== DEFAULT_SKIN) {
    try {
      const res = await fetch(`${skinsBasePath()}/default/sprites.json`);
      if (res.ok) return res.json();
    } catch { /* fall through */ }
  }
  return null;
}

// Initialize on load
async function initSkin() {
  const skinId = detectSkin();
  await setSkin(skinId);
}

// Export for use by other scripts
window.LaintownSkins = {
  init: initSkin,
  setSkin,
  getSkinId,
  getSkinManifest,
  getAvailableSkins,
  getSpriteConfig,
  onSkinChange,
  SKIN_CHANGED_EVENT,
};

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSkin);
} else {
  initSkin();
}
```

- [ ] **Step 3: Commit**

```bash
git add src/web/skins/loader.js src/web/skins/registry.json
git commit -m "feat(skins): add skin loader with detection, switching, and event system"
```

---

## Task 6: Create the default skin CSS

Extract all current visual values into the default skin's `skin.css`. This becomes the canonical reference for all skinnable properties.

**Files:**
- Create: `src/web/skins/default/skin.css`
- Create: `src/web/skins/default/sprites.json`

- [ ] **Step 1: Read styles.css and commune-map.css for current variable values**

After Task 2 and 3 are complete, read both files to get the final `:root` variable values.

- [ ] **Step 2: Create default/skin.css**

This file sets every skinnable CSS property to its current default value. It should be loaded after the base stylesheets and effectively be a no-op for the default skin (values match what's already in the base CSS). Other skins will override these.

```css
/* Default Skin: Wired Protocol */
/* This is the canonical list of all skinnable properties. */
/* Other skins override these values. */

:root {
  /* Backgrounds */
  --bg-deep: #0a0a1a;
  --bg-primary: #0d1525;
  --bg-panel: rgba(20, 40, 80, 0.6);
  --bg-window: rgba(30, 60, 120, 0.4);

  /* Text */
  --text-primary: #c0d8ff;
  --text-secondary: #6090c0;
  --text-dim: #405880;

  /* Accents */
  --accent-primary: #4080ff;
  --accent-secondary: #80c0ff;
  --accent-tertiary: #40e0ff;

  /* Borders & Glow */
  --border-glow: rgba(100, 160, 255, 0.5);
  --glow-primary: 0 0 20px rgba(64, 128, 255, 0.4), 0 0 40px rgba(64, 128, 255, 0.2);
  --hologram: linear-gradient(135deg, rgba(64, 128, 255, 0.1), rgba(128, 192, 255, 0.05), rgba(64, 200, 255, 0.1));

  /* Fonts */
  --font-heading: 'Orbitron', sans-serif;
  --font-body: 'Share Tech Mono', monospace;
  --font-mono: 'Share Tech Mono', monospace;

  /* Shapes */
  --border-radius: 4px;
  --border-radius-lg: 8px;
  --border-style: solid;
  --border-width: 1px;

  /* Effects */
  --scanline-opacity: 0.02;
  --particle-color: rgba(64, 128, 255, 0.3);
  --particle-opacity: 0.6;

  /* Messages */
  --msg-user-bg: rgba(40, 80, 140, 0.6);
  --msg-user-border: rgba(100, 160, 255, 0.3);
  --msg-assistant-bg: rgba(64, 128, 255, 0.15);
  --msg-assistant-border: rgba(64, 200, 255, 0.3);
  --msg-assistant-glow: 0 0 20px rgba(64, 200, 255, 0.1);

  /* Status */
  --status-online: #40ff80;
  --status-error: #ff6060;
  --error-text: #ff8080;
  --error-bg: rgba(255, 80, 80, 0.1);
  --error-border: rgba(255, 80, 80, 0.3);

  /* Character colors */
  --color-wired-lain: #4080ff;
  --color-lain: #80c0ff;
  --color-dr-claude: #ff6060;
  --color-pkd: #c060ff;
  --color-mckenna: #40e080;
  --color-john: #ffb040;
  --color-hiru: #60d0a0;

  /* Event type colors */
  --type-diary: #e0a020;
  --type-dream: #a040e0;
  --type-commune: #40d0e0;
  --type-curiosity: #40c060;
  --type-chat: #c0d0e0;
  --type-memory: #4080e0;
  --type-letter: #e060a0;
  --type-narrative: #e08030;
  --type-self-concept: #8080e0;
  --type-doctor: #ff6060;
  --type-peer: #60c0c0;
  --type-movement: #e0d040;

  /* Newspaper */
  --newspaper-bg: #05050a;
  --newspaper-text: #8a9ab0;
  --newspaper-heading: #4a9eff;
  --newspaper-quote-border: #2a3a4e;
}
```

- [ ] **Step 3: Create default/sprites.json**

Extract current character sprite colors from `sprites.js` (lines 22-358 of the current file):

```json
{
  "skinTone": "#dcc8c0",
  "skinShadow": "#c8b0a8",
  "legColor": "#2a2030",
  "shoeColor": "#3a2838",
  "eyeWhite": "#ece4e8",
  "pupil": "#1a1020",
  "mouth": "#b09090",
  "characters": {
    "lain": {
      "hairColor": "#3a2040",
      "hairLight": "#4a3050",
      "outfitColor": "#484058",
      "outfitAccent": "#585068",
      "accentColor": "#e080a0",
      "glowColor": "#80c0ff",
      "glowOpacity": 0.0,
      "headScale": 1.0,
      "eyeStyle": "default"
    },
    "wired-lain": {
      "hairColor": "#283858",
      "hairLight": "#384868",
      "outfitColor": "#304050",
      "outfitAccent": "#405060",
      "accentColor": "#4080ff",
      "glowColor": "#4080ff",
      "glowOpacity": 0.15,
      "headScale": 1.0,
      "eyeStyle": "default"
    },
    "pkd": {
      "hairColor": "#3a2838",
      "hairLight": "#4a3848",
      "outfitColor": "#4a4040",
      "outfitAccent": "#5a5050",
      "skinTone": "#d0b8b0",
      "skinShadow": "#c0a8a0",
      "accentColor": "#c060ff",
      "glowColor": "#c060ff",
      "glowOpacity": 0.0,
      "headScale": 1.0,
      "eyeStyle": "default"
    },
    "mckenna": {
      "hairColor": "#2a3020",
      "hairLight": "#3a4030",
      "outfitColor": "#3a4838",
      "outfitAccent": "#4a5848",
      "accentColor": "#40e080",
      "glowColor": "#40e080",
      "glowOpacity": 0.0,
      "headScale": 1.0,
      "eyeStyle": "default"
    },
    "john": {
      "hairColor": "#3a2e20",
      "hairLight": "#4a3e30",
      "outfitColor": "#484048",
      "outfitAccent": "#585058",
      "accentColor": "#ffb040",
      "glowColor": "#ffb040",
      "glowOpacity": 0.0,
      "headScale": 1.0,
      "eyeStyle": "default"
    },
    "dr-claude": {
      "hairColor": "#302030",
      "hairLight": "#403040",
      "outfitColor": "#d8d0cc",
      "outfitAccent": "#e8e0dc",
      "accentColor": "#ff6060",
      "glowColor": "#ff6060",
      "glowOpacity": 0.0,
      "headScale": 1.0,
      "eyeStyle": "default"
    },
    "hiru": {
      "hairColor": "#284030",
      "hairLight": "#385040",
      "outfitColor": "#3a4838",
      "outfitAccent": "#4a5848",
      "accentColor": "#60d0a0",
      "glowColor": "#60d0a0",
      "glowOpacity": 0.0,
      "headScale": 1.0,
      "eyeStyle": "default"
    }
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add src/web/skins/default/
git commit -m "feat(skins): create default skin with canonical CSS properties and sprite config"
```

---

## Task 7: Create the skin picker widget

A small UI that appears on every page for switching skins.

**Files:**
- Create: `src/web/skins/picker.js`
- Create: `src/web/skins/picker.css`

- [ ] **Step 1: Create picker.css**

Uses hardcoded neutral colors so it's readable in any skin:

```css
/* Skin picker — uses fixed colors to remain visible in all skins */
.skin-picker-toggle {
  position: fixed;
  bottom: 16px;
  left: 16px;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: rgba(40, 40, 50, 0.8);
  border: 1px solid rgba(120, 120, 140, 0.4);
  cursor: pointer;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  transition: transform 0.2s, box-shadow 0.2s;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}

.skin-picker-toggle:hover {
  transform: scale(1.1);
  box-shadow: 0 0 12px rgba(120, 120, 140, 0.4);
}

.skin-picker-panel {
  position: fixed;
  bottom: 60px;
  left: 16px;
  width: 220px;
  max-height: 400px;
  overflow-y: auto;
  background: rgba(20, 20, 28, 0.95);
  border: 1px solid rgba(120, 120, 140, 0.3);
  border-radius: 8px;
  z-index: 9999;
  display: none;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.5);
}

.skin-picker-panel.open {
  display: flex;
}

.skin-picker-panel h3 {
  font-family: system-ui, sans-serif;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: rgba(180, 180, 200, 0.6);
  margin: 4px 8px 4px;
}

.skin-picker-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s;
  border: 1px solid transparent;
}

.skin-picker-item:hover {
  background: rgba(120, 120, 140, 0.15);
}

.skin-picker-item.active {
  background: rgba(120, 120, 140, 0.2);
  border-color: rgba(120, 120, 140, 0.3);
}

.skin-picker-swatch {
  display: flex;
  gap: 3px;
  flex-shrink: 0;
}

.skin-picker-swatch-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.skin-picker-label {
  font-family: system-ui, sans-serif;
  font-size: 13px;
  color: rgba(200, 200, 220, 0.9);
}

.skin-picker-desc {
  font-family: system-ui, sans-serif;
  font-size: 10px;
  color: rgba(140, 140, 160, 0.7);
  margin-top: 1px;
}
```

- [ ] **Step 2: Create picker.js**

```javascript
// Skin Picker Widget
// Injects a small palette icon that expands into a skin selector.

(async function initPicker() {
  // Wait for skin loader to be available
  if (!window.LaintownSkins) {
    document.addEventListener('DOMContentLoaded', initPicker);
    return;
  }

  const skins = await window.LaintownSkins.getAvailableSkins();
  if (skins.length <= 1) return; // No point showing picker with one skin

  // Load picker CSS
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `${location.pathname.replace(/\/[^/]*$/, '')}/skins/picker.css`.replace(/\/\/+/g, '/');
  document.head.appendChild(link);

  // Create toggle button
  const toggle = document.createElement('button');
  toggle.className = 'skin-picker-toggle';
  toggle.textContent = '🎨';
  toggle.title = 'Change skin';
  toggle.setAttribute('aria-label', 'Change skin');

  // Create panel
  const panel = document.createElement('div');
  panel.className = 'skin-picker-panel';

  const heading = document.createElement('h3');
  heading.textContent = 'Skins';
  panel.appendChild(heading);

  // Populate skin items
  for (const skin of skins) {
    const item = document.createElement('div');
    item.className = 'skin-picker-item';
    if (skin.id === window.LaintownSkins.getSkinId()) {
      item.classList.add('active');
    }
    item.dataset.skinId = skin.id;

    // Color swatch
    const swatch = document.createElement('div');
    swatch.className = 'skin-picker-swatch';
    for (const color of (skin.previewColors || ['#888', '#666', '#444'])) {
      const dot = document.createElement('div');
      dot.className = 'skin-picker-swatch-dot';
      dot.style.background = color;
      swatch.appendChild(dot);
    }

    // Label and description
    const textWrap = document.createElement('div');
    const label = document.createElement('div');
    label.className = 'skin-picker-label';
    label.textContent = skin.name;
    const desc = document.createElement('div');
    desc.className = 'skin-picker-desc';
    desc.textContent = skin.description;
    textWrap.appendChild(label);
    textWrap.appendChild(desc);

    item.appendChild(swatch);
    item.appendChild(textWrap);

    item.addEventListener('click', async () => {
      await window.LaintownSkins.setSkin(skin.id);
      // Update active state
      panel.querySelectorAll('.skin-picker-item').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
    });

    panel.appendChild(item);
  }

  // Toggle panel
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    panel.classList.toggle('open');
  });

  // Close on outside click
  document.addEventListener('click', (e) => {
    if (!panel.contains(e.target) && e.target !== toggle) {
      panel.classList.remove('open');
    }
  });

  document.body.appendChild(toggle);
  document.body.appendChild(panel);
})();
```

- [ ] **Step 3: Commit**

```bash
git add src/web/skins/picker.js src/web/skins/picker.css
git commit -m "feat(skins): add skin picker widget"
```

---

## Task 8: Wire skin loader and picker into all pages

Add the skin loader and picker scripts to every HTML page.

**Files:**
- Modify: `src/web/public/index.html`
- Modify: `src/web/public/commune-map.html` (or wherever the commune map HTML lives)
- Modify: `src/web/public/newspaper.html`
- Modify: `src/web/public/commune-newspaper.html`
- Modify: `src/web/public/game/index.html`
- Modify: Per-character `index.html` files in `public-pkd/`, `public-mckenna/`, etc.

- [ ] **Step 1: Identify all HTML entry points**

Read directory listings to find all `index.html` files and standalone HTML pages that users visit.

```bash
find src/web -name '*.html' -type f
```

- [ ] **Step 2: Add loader and picker scripts to each HTML file**

Before the closing `</body>` tag in each file, add:

```html
<script src="/skins/loader.js"></script>
<script src="/skins/picker.js"></script>
```

For character pages that serve from sub-paths (like `/pkd/`), use relative paths that resolve correctly:

```html
<script src="skins/loader.js"></script>
<script src="skins/picker.js"></script>
```

The loader's `skinsBasePath()` function handles the path resolution automatically.

- [ ] **Step 3: Verify loader runs on page load**

Build, open each page, and confirm:
- The skin picker icon appears in bottom-left
- Console shows no errors
- Opening the picker shows "Wired Protocol" as the only available skin (others haven't been created yet)

- [ ] **Step 4: Commit**

```bash
git add src/web/public/ src/web/public-*/
git commit -m "feat(skins): wire loader and picker into all HTML pages"
```

---

## Task 9: Integrate skin system with commune-map.js

The commune map has hardcoded character colors and building icons in JavaScript. Make it read from the skin system.

**Files:**
- Modify: `src/web/public/commune-map.js`

- [ ] **Step 1: Read commune-map.js**

Read the full file, focusing on the `CHARACTERS` array (lines 20-27), `TYPE_COLORS` object (lines 29-46), and building definitions (lines 7-17).

- [ ] **Step 2: Replace hardcoded character colors with CSS variable reads**

Change the `CHARACTERS` array to read colors from CSS custom properties:

```javascript
function getCSSVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function getCharacterColors() {
  return [
    { id: 'wired-lain', name: 'Wired Lain', color: getCSSVar('--color-wired-lain') || '#4080ff' },
    { id: 'lain',       name: 'Lain',       color: getCSSVar('--color-lain') || '#80c0ff' },
    { id: 'pkd',        name: 'PKD',        color: getCSSVar('--color-pkd') || '#c060ff' },
    { id: 'mckenna',    name: 'McKenna',    color: getCSSVar('--color-mckenna') || '#40e080' },
    { id: 'john',       name: 'John',       color: getCSSVar('--color-john') || '#ffb040' },
    { id: 'hiru',       name: 'Hiru',       color: getCSSVar('--color-hiru') || '#60d0a0' },
  ];
}
```

Call `getCharacterColors()` at init and on `skin-changed` events.

- [ ] **Step 3: Replace hardcoded TYPE_COLORS with CSS variable reads**

```javascript
function getTypeColors() {
  return {
    diary: getCSSVar('--type-diary') || '#e0a020',
    dream: getCSSVar('--type-dream') || '#a040e0',
    // ... all types
  };
}
```

- [ ] **Step 4: Make building icons read from skin manifest**

Replace the hardcoded building emoji map to read from the active skin manifest:

```javascript
function getBuildingIcons() {
  const manifest = window.LaintownSkins?.getSkinManifest();
  if (manifest?.buildingIcons) return manifest.buildingIcons;
  // Fallback
  return {
    library: '📚', bar: '🍺', field: '🌾', windmill: '🏗',
    lighthouse: '🗼', school: '🏫', market: '🏪', locksmith: '🔐', threshold: '🚪'
  };
}
```

Use this wherever building icons are rendered.

- [ ] **Step 5: Add skin-changed listener to re-render**

```javascript
document.addEventListener('skin-changed', () => {
  // Re-read colors and icons, then re-render
  CHARACTERS = getCharacterColors();
  TYPE_COLORS = getTypeColors();
  renderTownGrid(); // or whatever the main render function is called
});
```

- [ ] **Step 6: Verify commune map works with default skin**

Build and check the commune map. Should look identical.

- [ ] **Step 7: Commit**

```bash
git add src/web/public/commune-map.js
git commit -m "feat(skins): commune map reads colors and icons from skin system"
```

---

## Task 10: Integrate skin system with game sprites

Make the game view's sprite renderer accept color overrides from the active skin's `sprites.json`.

**Files:**
- Modify: `src/web/public/game/js/sprites.js`
- Modify: `src/web/public/game/js/config.js`

- [ ] **Step 1: Read sprites.js and config.js fully**

Read both files to understand the current sprite drawing pipeline.

- [ ] **Step 2: Add skin config overlay to sprites.js**

Add a mechanism for the skin system to inject color overrides. At the top of sprites.js, add:

```javascript
let skinSpriteConfig = null;

// Called by skin loader to update sprite colors
window.setSpritesSkinConfig = function(config) {
  skinSpriteConfig = config;
};

// Get a character's skin-overridden property
function getSkinProp(charId, prop, fallback) {
  if (skinSpriteConfig?.characters?.[charId]?.[prop] !== undefined) {
    return skinSpriteConfig.characters[charId][prop];
  }
  if (skinSpriteConfig?.[prop] !== undefined) {
    return skinSpriteConfig[prop];
  }
  return fallback;
}
```

- [ ] **Step 3: Use getSkinProp in the sprite drawing functions**

In the sprite drawing code, replace direct color references with `getSkinProp` calls:

```javascript
// Before:
const SKIN = '#dcc8c0';
// After:
function getSkinTone(charId) {
  return getSkinProp(charId, 'skinTone', '#dcc8c0');
}
```

Apply this pattern to:
- `SKIN` and `SKIN_SHADOW` constants
- `charData.hairColor`, `charData.outfit` in each character's config
- Face colors (eye white, pupil, mouth, blush)
- Leg and shoe colors

- [ ] **Step 4: Add skin config for character colors in config.js**

Add a `getCharacterColor` function that reads from CSS variables:

```javascript
function getCharacterColor(charId) {
  const style = getComputedStyle(document.documentElement);
  const hex = style.getPropertyValue(`--color-${charId}`).trim();
  if (hex) {
    return {
      color: parseInt(hex.replace('#', ''), 16),
      colorHex: hex
    };
  }
  return CHARACTERS[charId]; // fallback
}
```

- [ ] **Step 5: Wire skin-changed event to sprite refresh**

In the game's initialization code, listen for skin changes:

```javascript
document.addEventListener('skin-changed', async () => {
  const config = await window.LaintownSkins?.getSpriteConfig();
  if (config) window.setSpritesSkinConfig(config);
  // Redraw all sprites
  // (the exact mechanism depends on how the Phaser scene handles updates)
});
```

- [ ] **Step 6: Commit**

```bash
git add src/web/public/game/js/sprites.js src/web/public/game/js/config.js
git commit -m "feat(skins): game sprites accept color overrides from skin config"
```

---

## Task 11: Create the Vaporwave skin

**Files:**
- Create: `src/web/skins/vaporwave/manifest.json`
- Create: `src/web/skins/vaporwave/skin.css`
- Create: `src/web/skins/vaporwave/sprites.json`

- [ ] **Step 1: Create manifest.json**

```json
{
  "id": "vaporwave",
  "name": "Aesthetic",
  "description": "Magenta/cyan retrofuturism, 80s digital nostalgia",
  "fonts": {
    "heading": "Audiowide",
    "body": "VT323",
    "mono": "VT323"
  },
  "buildingIcons": {
    "library": "📼",
    "bar": "🍸",
    "field": "🌴",
    "windmill": "💿",
    "lighthouse": "📡",
    "school": "💾",
    "market": "🏬",
    "locksmith": "🔮",
    "threshold": "🌀"
  },
  "googleFontsUrl": "https://fonts.googleapis.com/css2?family=Audiowide&family=VT323&display=swap",
  "previewColors": ["#ff40ff", "#40ffff", "#ff8040"]
}
```

- [ ] **Step 2: Create skin.css**

```css
/* Vaporwave Skin: Aesthetic */

:root {
  --bg-deep: #0a0020;
  --bg-primary: #100030;
  --bg-panel: rgba(40, 0, 60, 0.6);
  --bg-window: rgba(60, 0, 80, 0.4);

  --text-primary: #e0c0ff;
  --text-secondary: #a060c0;
  --text-dim: #604080;

  --accent-primary: #ff40ff;
  --accent-secondary: #40ffff;
  --accent-tertiary: #ff8040;

  --border-glow: rgba(255, 64, 255, 0.5);
  --glow-primary: 0 0 20px rgba(255, 64, 255, 0.4), 0 0 40px rgba(64, 255, 255, 0.2);
  --hologram: linear-gradient(135deg, rgba(255, 64, 255, 0.1), rgba(64, 255, 255, 0.05), rgba(255, 128, 64, 0.1));

  --font-heading: 'Audiowide', sans-serif;
  --font-body: 'VT323', monospace;
  --font-mono: 'VT323', monospace;

  --border-radius: 4px;
  --border-radius-lg: 8px;
  --scanline-opacity: 0.04;
  --particle-color: rgba(255, 64, 255, 0.3);

  --msg-user-bg: rgba(80, 0, 120, 0.6);
  --msg-user-border: rgba(255, 64, 255, 0.3);
  --msg-assistant-bg: rgba(255, 64, 255, 0.12);
  --msg-assistant-border: rgba(64, 255, 255, 0.3);
  --msg-assistant-glow: 0 0 20px rgba(64, 255, 255, 0.1);

  --status-online: #40ffb0;
  --status-error: #ff4060;
  --error-text: #ff80a0;
  --error-bg: rgba(255, 64, 96, 0.1);
  --error-border: rgba(255, 64, 96, 0.3);

  /* Character colors — distinct within vaporwave palette */
  --color-wired-lain: #ff40ff;
  --color-lain: #c080ff;
  --color-dr-claude: #ff4060;
  --color-pkd: #8040ff;
  --color-mckenna: #40ffb0;
  --color-john: #ff8040;
  --color-hiru: #40ffff;

  /* Event types — shifted to vaporwave palette */
  --type-diary: #ffb040;
  --type-dream: #c040ff;
  --type-commune: #40ffff;
  --type-curiosity: #40ff80;
  --type-chat: #e0c0ff;
  --type-memory: #8060ff;
  --type-letter: #ff40a0;
  --type-narrative: #ff6040;
  --type-self-concept: #a080ff;
  --type-doctor: #ff4060;
  --type-peer: #40c0ff;
  --type-movement: #ffc040;

  --newspaper-bg: #08001a;
  --newspaper-text: #b0a0c0;
  --newspaper-heading: #ff40ff;
  --newspaper-quote-border: #4a2060;
}
```

- [ ] **Step 3: Create sprites.json**

```json
{
  "skinTone": "#e0c8d0",
  "skinShadow": "#d0b0c0",
  "legColor": "#200030",
  "shoeColor": "#300040",
  "eyeWhite": "#f0e0f0",
  "pupil": "#200020",
  "mouth": "#c080a0",
  "characters": {
    "wired-lain": {
      "hairColor": "#301050",
      "hairLight": "#402060",
      "outfitColor": "#400060",
      "outfitAccent": "#500070",
      "accentColor": "#ff40ff",
      "glowColor": "#ff40ff",
      "glowOpacity": 0.2
    },
    "lain": {
      "hairColor": "#281040",
      "hairLight": "#382050",
      "outfitColor": "#380050",
      "outfitAccent": "#480060",
      "accentColor": "#c080ff",
      "glowColor": "#c080ff",
      "glowOpacity": 0.1
    },
    "pkd": {
      "hairColor": "#201040",
      "hairLight": "#302050",
      "outfitColor": "#301050",
      "outfitAccent": "#402060",
      "accentColor": "#8040ff",
      "glowColor": "#8040ff",
      "glowOpacity": 0.1
    },
    "mckenna": {
      "hairColor": "#103020",
      "hairLight": "#204030",
      "outfitColor": "#104030",
      "outfitAccent": "#205040",
      "accentColor": "#40ffb0",
      "glowColor": "#40ffb0",
      "glowOpacity": 0.1
    },
    "john": {
      "hairColor": "#302010",
      "hairLight": "#403020",
      "outfitColor": "#402010",
      "outfitAccent": "#503020",
      "accentColor": "#ff8040",
      "glowColor": "#ff8040",
      "glowOpacity": 0.1
    },
    "dr-claude": {
      "hairColor": "#200020",
      "hairLight": "#300030",
      "outfitColor": "#d0c0d0",
      "outfitAccent": "#e0d0e0",
      "accentColor": "#ff4060",
      "glowColor": "#ff4060",
      "glowOpacity": 0.1
    },
    "hiru": {
      "hairColor": "#103038",
      "hairLight": "#204048",
      "outfitColor": "#104040",
      "outfitAccent": "#205050",
      "accentColor": "#40ffff",
      "glowColor": "#40ffff",
      "glowOpacity": 0.15
    }
  }
}
```

- [ ] **Step 4: Verify vaporwave skin loads correctly**

Build, open the site, open the skin picker, switch to Vaporwave. Verify:
- Colors change across the chat page
- Commune map updates character colors and building icons
- Fonts change (Audiowide headers, VT323 body)
- Switching back to default restores original look

- [ ] **Step 5: Commit**

```bash
git add src/web/skins/vaporwave/
git commit -m "feat(skins): add Vaporwave skin — Aesthetic"
```

---

## Task 12: Create the Kawaii skin

**Files:**
- Create: `src/web/skins/kawaii/manifest.json`
- Create: `src/web/skins/kawaii/skin.css`
- Create: `src/web/skins/kawaii/sprites.json`

- [ ] **Step 1: Create manifest.json**

```json
{
  "id": "kawaii",
  "name": "Soft & Cute",
  "description": "Pastel pinks, lavenders, and gentle glows",
  "fonts": {
    "heading": "Quicksand",
    "body": "Nunito",
    "mono": "Fira Code"
  },
  "buildingIcons": {
    "library": "📖",
    "bar": "🧋",
    "field": "🌸",
    "windmill": "🎀",
    "lighthouse": "⭐",
    "school": "🎒",
    "market": "🍰",
    "locksmith": "🔑",
    "threshold": "🌈"
  },
  "googleFontsUrl": "https://fonts.googleapis.com/css2?family=Quicksand:wght@400;700&family=Nunito:wght@400;600&family=Fira+Code&display=swap",
  "previewColors": ["#ffb0d0", "#b0d0ff", "#d0b0ff"]
}
```

- [ ] **Step 2: Create skin.css**

```css
/* Kawaii Skin: Soft & Cute */

:root {
  --bg-deep: #1a1020;
  --bg-primary: #201428;
  --bg-panel: rgba(60, 30, 50, 0.5);
  --bg-window: rgba(80, 40, 70, 0.35);

  --text-primary: #f0d8e8;
  --text-secondary: #c090b0;
  --text-dim: #806878;

  --accent-primary: #ff80b0;
  --accent-secondary: #80b0ff;
  --accent-tertiary: #c080ff;

  --border-glow: rgba(255, 128, 176, 0.4);
  --glow-primary: 0 0 20px rgba(255, 128, 176, 0.3), 0 0 40px rgba(128, 176, 255, 0.15);
  --hologram: linear-gradient(135deg, rgba(255, 176, 208, 0.08), rgba(176, 208, 255, 0.05), rgba(208, 176, 255, 0.08));

  --font-heading: 'Quicksand', sans-serif;
  --font-body: 'Nunito', sans-serif;
  --font-mono: 'Fira Code', monospace;

  --border-radius: 12px;
  --border-radius-lg: 16px;
  --scanline-opacity: 0;
  --particle-color: rgba(255, 176, 208, 0.3);

  --msg-user-bg: rgba(80, 50, 70, 0.5);
  --msg-user-border: rgba(255, 128, 176, 0.25);
  --msg-assistant-bg: rgba(255, 128, 176, 0.08);
  --msg-assistant-border: rgba(128, 176, 255, 0.25);
  --msg-assistant-glow: 0 0 16px rgba(128, 176, 255, 0.08);

  --status-online: #80ff80;
  --status-error: #ff8080;
  --error-text: #ffa0a0;
  --error-bg: rgba(255, 128, 128, 0.08);
  --error-border: rgba(255, 128, 128, 0.2);

  --color-wired-lain: #80b0ff;
  --color-lain: #ffb0d0;
  --color-dr-claude: #ff8080;
  --color-pkd: #d0a0ff;
  --color-mckenna: #80e0a0;
  --color-john: #ffd080;
  --color-hiru: #80e0d0;

  --type-diary: #ffc060;
  --type-dream: #c080ff;
  --type-commune: #80e0ff;
  --type-curiosity: #80e080;
  --type-chat: #e0d0f0;
  --type-memory: #80a0ff;
  --type-letter: #ff80b0;
  --type-narrative: #ffa060;
  --type-self-concept: #b0a0ff;
  --type-doctor: #ff8080;
  --type-peer: #80d0d0;
  --type-movement: #f0e060;

  --newspaper-bg: #140a18;
  --newspaper-text: #c0b0c8;
  --newspaper-heading: #ff80b0;
  --newspaper-quote-border: #4a3048;
}
```

- [ ] **Step 3: Create sprites.json**

```json
{
  "skinTone": "#f0d8d0",
  "skinShadow": "#e0c8c0",
  "legColor": "#382838",
  "shoeColor": "#483848",
  "eyeWhite": "#fff0f8",
  "pupil": "#201828",
  "mouth": "#e0a0b0",
  "characters": {
    "wired-lain": {
      "hairColor": "#304060",
      "hairLight": "#405070",
      "outfitColor": "#405068",
      "outfitAccent": "#506078",
      "accentColor": "#80b0ff",
      "glowColor": "#80b0ff",
      "glowOpacity": 0.15,
      "headScale": 1.15,
      "eyeStyle": "wide"
    },
    "lain": {
      "hairColor": "#503050",
      "hairLight": "#604060",
      "outfitColor": "#604060",
      "outfitAccent": "#705070",
      "accentColor": "#ffb0d0",
      "glowColor": "#ffb0d0",
      "glowOpacity": 0.1,
      "headScale": 1.15,
      "eyeStyle": "wide"
    },
    "pkd": {
      "hairColor": "#403050",
      "hairLight": "#504060",
      "outfitColor": "#504060",
      "outfitAccent": "#605070",
      "accentColor": "#d0a0ff",
      "glowColor": "#d0a0ff",
      "glowOpacity": 0.1,
      "headScale": 1.1,
      "eyeStyle": "wide"
    },
    "mckenna": {
      "hairColor": "#2a3828",
      "hairLight": "#3a4838",
      "outfitColor": "#3a5040",
      "outfitAccent": "#4a6050",
      "accentColor": "#80e0a0",
      "glowColor": "#80e0a0",
      "glowOpacity": 0.1,
      "headScale": 1.1,
      "eyeStyle": "wide"
    },
    "john": {
      "hairColor": "#403828",
      "hairLight": "#504838",
      "outfitColor": "#504840",
      "outfitAccent": "#605850",
      "accentColor": "#ffd080",
      "glowColor": "#ffd080",
      "glowOpacity": 0.1,
      "headScale": 1.1,
      "eyeStyle": "wide"
    },
    "dr-claude": {
      "hairColor": "#382838",
      "hairLight": "#483848",
      "outfitColor": "#e0d8e0",
      "outfitAccent": "#f0e8f0",
      "accentColor": "#ff8080",
      "glowColor": "#ff8080",
      "glowOpacity": 0.1,
      "headScale": 1.1,
      "eyeStyle": "wide"
    },
    "hiru": {
      "hairColor": "#284838",
      "hairLight": "#385848",
      "outfitColor": "#385848",
      "outfitAccent": "#486858",
      "accentColor": "#80e0d0",
      "glowColor": "#80e0d0",
      "glowOpacity": 0.1,
      "headScale": 1.15,
      "eyeStyle": "wide"
    }
  }
}
```

- [ ] **Step 4: Verify and commit**

```bash
git add src/web/skins/kawaii/
git commit -m "feat(skins): add Kawaii skin — Soft & Cute"
```

---

## Task 13: Create the Gothic skin

**Files:**
- Create: `src/web/skins/gothic/manifest.json`
- Create: `src/web/skins/gothic/skin.css`
- Create: `src/web/skins/gothic/sprites.json`

- [ ] **Step 1: Create manifest.json**

```json
{
  "id": "gothic",
  "name": "Dark Cathedral",
  "description": "Victorian darkness meets digital occult",
  "fonts": {
    "heading": "Cinzel",
    "body": "Crimson Text",
    "mono": "Fira Code"
  },
  "buildingIcons": {
    "library": "🏚",
    "bar": "🍷",
    "field": "⚰",
    "windmill": "🦇",
    "lighthouse": "🕯",
    "school": "📜",
    "market": "🗝",
    "locksmith": "⛓",
    "threshold": "🚪"
  },
  "googleFontsUrl": "https://fonts.googleapis.com/css2?family=Cinzel:wght@400;700&family=Crimson+Text:ital,wght@0,400;0,600;1,400&family=Fira+Code&display=swap",
  "previewColors": ["#8b0020", "#600080", "#c0c0c0"]
}
```

- [ ] **Step 2: Create skin.css**

```css
/* Gothic Skin: Dark Cathedral */

:root {
  --bg-deep: #06000a;
  --bg-primary: #0a0010;
  --bg-panel: rgba(30, 0, 20, 0.6);
  --bg-window: rgba(50, 0, 30, 0.4);

  --text-primary: #d0c0c8;
  --text-secondary: #907080;
  --text-dim: #584050;

  --accent-primary: #a02040;
  --accent-secondary: #c0c0c0;
  --accent-tertiary: #800060;

  --border-glow: rgba(160, 32, 64, 0.5);
  --glow-primary: 0 0 20px rgba(160, 32, 64, 0.3), 0 0 40px rgba(128, 0, 96, 0.15);
  --hologram: linear-gradient(135deg, rgba(160, 32, 64, 0.08), rgba(128, 0, 96, 0.04), rgba(192, 192, 192, 0.06));

  --font-heading: 'Cinzel', serif;
  --font-body: 'Crimson Text', serif;
  --font-mono: 'Fira Code', monospace;

  --border-radius: 0px;
  --border-radius-lg: 2px;
  --scanline-opacity: 0.01;
  --particle-color: rgba(160, 32, 64, 0.2);

  --msg-user-bg: rgba(60, 0, 30, 0.6);
  --msg-user-border: rgba(160, 32, 64, 0.3);
  --msg-assistant-bg: rgba(160, 32, 64, 0.08);
  --msg-assistant-border: rgba(128, 0, 96, 0.3);
  --msg-assistant-glow: 0 0 20px rgba(128, 0, 96, 0.08);

  --status-online: #60a060;
  --status-error: #c03030;
  --error-text: #e06060;
  --error-bg: rgba(192, 48, 48, 0.1);
  --error-border: rgba(192, 48, 48, 0.3);

  --color-wired-lain: #8040a0;
  --color-lain: #a06080;
  --color-dr-claude: #c03030;
  --color-pkd: #a02040;
  --color-mckenna: #408040;
  --color-john: #c0a060;
  --color-hiru: #508080;

  --type-diary: #c0a040;
  --type-dream: #8040a0;
  --type-commune: #508080;
  --type-curiosity: #408040;
  --type-chat: #c0b0b8;
  --type-memory: #6060a0;
  --type-letter: #a04060;
  --type-narrative: #c07030;
  --type-self-concept: #7060a0;
  --type-doctor: #c03030;
  --type-peer: #508080;
  --type-movement: #c0a040;

  --newspaper-bg: #04000a;
  --newspaper-text: #908088;
  --newspaper-heading: #a02040;
  --newspaper-quote-border: #3a1020;
}
```

- [ ] **Step 3: Create sprites.json**

```json
{
  "skinTone": "#d8c0b8",
  "skinShadow": "#c0a8a0",
  "legColor": "#100010",
  "shoeColor": "#1a001a",
  "eyeWhite": "#e0d8d8",
  "pupil": "#0a000a",
  "mouth": "#905060",
  "characters": {
    "wired-lain": {
      "hairColor": "#0a0018",
      "hairLight": "#1a0028",
      "outfitColor": "#100020",
      "outfitAccent": "#200030",
      "accentColor": "#8040a0",
      "glowColor": "#600040",
      "glowOpacity": 0.2,
      "eyeStyle": "narrow"
    },
    "lain": {
      "hairColor": "#0a0010",
      "hairLight": "#1a0020",
      "outfitColor": "#180010",
      "outfitAccent": "#280020",
      "accentColor": "#a06080",
      "glowColor": "#400020",
      "glowOpacity": 0.1,
      "eyeStyle": "narrow"
    },
    "pkd": {
      "hairColor": "#180008",
      "hairLight": "#280018",
      "outfitColor": "#200010",
      "outfitAccent": "#300020",
      "skinTone": "#d0b0a8",
      "skinShadow": "#b89890",
      "accentColor": "#a02040",
      "glowColor": "#600010",
      "glowOpacity": 0.1,
      "eyeStyle": "narrow"
    },
    "mckenna": {
      "hairColor": "#081008",
      "hairLight": "#182018",
      "outfitColor": "#0a1a0a",
      "outfitAccent": "#1a2a1a",
      "accentColor": "#408040",
      "glowColor": "#204020",
      "glowOpacity": 0.1,
      "eyeStyle": "narrow"
    },
    "john": {
      "hairColor": "#181008",
      "hairLight": "#282018",
      "outfitColor": "#201810",
      "outfitAccent": "#302820",
      "accentColor": "#c0a060",
      "glowColor": "#604020",
      "glowOpacity": 0.1,
      "eyeStyle": "narrow"
    },
    "dr-claude": {
      "hairColor": "#100010",
      "hairLight": "#200020",
      "outfitColor": "#c0b0b0",
      "outfitAccent": "#d0c0c0",
      "accentColor": "#c03030",
      "glowColor": "#600010",
      "glowOpacity": 0.1,
      "eyeStyle": "narrow"
    },
    "hiru": {
      "hairColor": "#081810",
      "hairLight": "#182820",
      "outfitColor": "#0a2018",
      "outfitAccent": "#1a3028",
      "accentColor": "#508080",
      "glowColor": "#204040",
      "glowOpacity": 0.1,
      "eyeStyle": "narrow"
    }
  }
}
```

- [ ] **Step 4: Verify and commit**

```bash
git add src/web/skins/gothic/
git commit -m "feat(skins): add Gothic skin — Dark Cathedral"
```

---

## Task 14: Create the Hardcore skin

**Files:**
- Create: `src/web/skins/hardcore/manifest.json`
- Create: `src/web/skins/hardcore/skin.css`
- Create: `src/web/skins/hardcore/sprites.json`

- [ ] **Step 1: Create manifest.json**

```json
{
  "id": "hardcore",
  "name": "Brutalist",
  "description": "Black, red, white. No gradients, no mercy.",
  "fonts": {
    "heading": "Space Mono",
    "body": "Space Mono",
    "mono": "Space Mono"
  },
  "buildingIcons": {
    "library": "▣",
    "bar": "▤",
    "field": "▥",
    "windmill": "▦",
    "lighthouse": "▧",
    "school": "▨",
    "market": "▩",
    "locksmith": "▪",
    "threshold": "▫"
  },
  "googleFontsUrl": "https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&display=swap",
  "previewColors": ["#ff0040", "#ffffff", "#000000"]
}
```

- [ ] **Step 2: Create skin.css**

```css
/* Hardcore Skin: Brutalist */

:root {
  --bg-deep: #000000;
  --bg-primary: #000000;
  --bg-panel: rgba(20, 0, 0, 0.8);
  --bg-window: rgba(30, 0, 0, 0.6);

  --text-primary: #ffffff;
  --text-secondary: #ff0040;
  --text-dim: #600020;

  --accent-primary: #ff0040;
  --accent-secondary: #ffffff;
  --accent-tertiary: #ff0040;

  --border-glow: rgba(255, 0, 64, 0.6);
  --glow-primary: none;
  --hologram: none;

  --font-heading: 'Space Mono', monospace;
  --font-body: 'Space Mono', monospace;
  --font-mono: 'Space Mono', monospace;

  --border-radius: 0px;
  --border-radius-lg: 0px;
  --scanline-opacity: 0;
  --particle-color: rgba(255, 0, 64, 0.2);

  --msg-user-bg: rgba(40, 0, 10, 0.8);
  --msg-user-border: #ff0040;
  --msg-assistant-bg: rgba(255, 0, 64, 0.05);
  --msg-assistant-border: #ff0040;
  --msg-assistant-glow: none;

  --status-online: #00ff40;
  --status-error: #ff0040;
  --error-text: #ff0040;
  --error-bg: rgba(255, 0, 64, 0.1);
  --error-border: #ff0040;

  --color-wired-lain: #ff0040;
  --color-lain: #ffffff;
  --color-dr-claude: #ff0040;
  --color-pkd: #ff0040;
  --color-mckenna: #00ff40;
  --color-john: #ffffff;
  --color-hiru: #ff0040;

  --type-diary: #ffffff;
  --type-dream: #ff0040;
  --type-commune: #ffffff;
  --type-curiosity: #00ff40;
  --type-chat: #ffffff;
  --type-memory: #ff0040;
  --type-letter: #ff0040;
  --type-narrative: #ffffff;
  --type-self-concept: #ff0040;
  --type-doctor: #ff0040;
  --type-peer: #ffffff;
  --type-movement: #ffffff;

  --newspaper-bg: #000000;
  --newspaper-text: #ffffff;
  --newspaper-heading: #ff0040;
  --newspaper-quote-border: #ff0040;
}
```

- [ ] **Step 3: Create sprites.json**

```json
{
  "skinTone": "#e0d0c8",
  "skinShadow": "#c0b0a8",
  "legColor": "#000000",
  "shoeColor": "#1a0008",
  "eyeWhite": "#ffffff",
  "pupil": "#000000",
  "mouth": "#c04060",
  "characters": {
    "wired-lain": {
      "hairColor": "#000000",
      "hairLight": "#1a0010",
      "outfitColor": "#1a0008",
      "outfitAccent": "#300010",
      "accentColor": "#ff0040",
      "glowColor": "#ff0040",
      "glowOpacity": 0.3
    },
    "lain": {
      "hairColor": "#0a0000",
      "hairLight": "#1a0008",
      "outfitColor": "#ffffff",
      "outfitAccent": "#e0e0e0",
      "accentColor": "#ff0040",
      "glowColor": "#ffffff",
      "glowOpacity": 0.1
    },
    "pkd": {
      "hairColor": "#0a0000",
      "hairLight": "#1a0008",
      "outfitColor": "#200008",
      "outfitAccent": "#300010",
      "accentColor": "#ff0040",
      "glowColor": "#ff0040",
      "glowOpacity": 0.1
    },
    "mckenna": {
      "hairColor": "#000a00",
      "hairLight": "#001a00",
      "outfitColor": "#001a08",
      "outfitAccent": "#002a10",
      "accentColor": "#00ff40",
      "glowColor": "#00ff40",
      "glowOpacity": 0.1
    },
    "john": {
      "hairColor": "#0a0a0a",
      "hairLight": "#1a1a1a",
      "outfitColor": "#e0e0e0",
      "outfitAccent": "#ffffff",
      "accentColor": "#ffffff",
      "glowColor": "#ffffff",
      "glowOpacity": 0.1
    },
    "dr-claude": {
      "hairColor": "#000000",
      "hairLight": "#1a0008",
      "outfitColor": "#ffffff",
      "outfitAccent": "#e0e0e0",
      "accentColor": "#ff0040",
      "glowColor": "#ff0040",
      "glowOpacity": 0.1
    },
    "hiru": {
      "hairColor": "#0a0000",
      "hairLight": "#1a0008",
      "outfitColor": "#1a0008",
      "outfitAccent": "#300010",
      "accentColor": "#ff0040",
      "glowColor": "#ff0040",
      "glowOpacity": 0.2
    }
  }
}
```

- [ ] **Step 4: Verify and commit**

```bash
git add src/web/skins/hardcore/
git commit -m "feat(skins): add Hardcore skin — Brutalist"
```

---

## Task 15: Create the Terminal skin

**Files:**
- Create: `src/web/skins/terminal/manifest.json`
- Create: `src/web/skins/terminal/skin.css`
- Create: `src/web/skins/terminal/sprites.json`

- [ ] **Step 1: Create manifest.json**

```json
{
  "id": "terminal",
  "name": "Phosphor Green",
  "description": "CRT green-on-black, scanlines, retro terminal",
  "fonts": {
    "heading": "VT323",
    "body": "VT323",
    "mono": "VT323"
  },
  "buildingIcons": {
    "library": "[LIB]",
    "bar": "[BAR]",
    "field": "[FLD]",
    "windmill": "[WND]",
    "lighthouse": "[LHT]",
    "school": "[SCH]",
    "market": "[MKT]",
    "locksmith": "[LCK]",
    "threshold": "[THR]"
  },
  "googleFontsUrl": "https://fonts.googleapis.com/css2?family=VT323&display=swap",
  "previewColors": ["#00cc44", "#00ff55", "#008833"]
}
```

- [ ] **Step 2: Create skin.css**

```css
/* Terminal Skin: Phosphor Green */

:root {
  --bg-deep: #000800;
  --bg-primary: #001000;
  --bg-panel: rgba(0, 20, 0, 0.7);
  --bg-window: rgba(0, 30, 0, 0.5);

  --text-primary: #00cc44;
  --text-secondary: #009933;
  --text-dim: #005520;

  --accent-primary: #00ff55;
  --accent-secondary: #00cc44;
  --accent-tertiary: #00ff55;

  --border-glow: rgba(0, 204, 68, 0.5);
  --glow-primary: 0 0 10px rgba(0, 204, 68, 0.4), 0 0 20px rgba(0, 204, 68, 0.15);
  --hologram: none;

  --font-heading: 'VT323', monospace;
  --font-body: 'VT323', monospace;
  --font-mono: 'VT323', monospace;

  --border-radius: 0px;
  --border-radius-lg: 0px;
  --scanline-opacity: 0.08;
  --particle-color: rgba(0, 204, 68, 0.15);

  --msg-user-bg: rgba(0, 30, 10, 0.6);
  --msg-user-border: rgba(0, 204, 68, 0.3);
  --msg-assistant-bg: rgba(0, 204, 68, 0.05);
  --msg-assistant-border: rgba(0, 255, 85, 0.3);
  --msg-assistant-glow: 0 0 10px rgba(0, 204, 68, 0.08);

  --status-online: #00ff55;
  --status-error: #ff4040;
  --error-text: #ff4040;
  --error-bg: rgba(255, 64, 64, 0.08);
  --error-border: rgba(255, 64, 64, 0.3);

  --color-wired-lain: #00ff55;
  --color-lain: #00cc44;
  --color-dr-claude: #ff4040;
  --color-pkd: #40ff80;
  --color-mckenna: #80ff40;
  --color-john: #ffcc40;
  --color-hiru: #40ffc0;

  --type-diary: #cccc00;
  --type-dream: #00cc80;
  --type-commune: #00cccc;
  --type-curiosity: #00cc44;
  --type-chat: #88cc88;
  --type-memory: #4488cc;
  --type-letter: #cc4488;
  --type-narrative: #cc8844;
  --type-self-concept: #8888cc;
  --type-doctor: #ff4040;
  --type-peer: #44cccc;
  --type-movement: #cccc44;

  --newspaper-bg: #000800;
  --newspaper-text: #00aa44;
  --newspaper-heading: #00ff55;
  --newspaper-quote-border: #005520;
}
```

- [ ] **Step 3: Create sprites.json**

```json
{
  "skinTone": "#90c890",
  "skinShadow": "#70a870",
  "legColor": "#002000",
  "shoeColor": "#003000",
  "eyeWhite": "#b0e0b0",
  "pupil": "#002000",
  "mouth": "#60a060",
  "characters": {
    "wired-lain": {
      "hairColor": "#003010",
      "hairLight": "#004020",
      "outfitColor": "#002818",
      "outfitAccent": "#003828",
      "accentColor": "#00ff55",
      "glowColor": "#00ff55",
      "glowOpacity": 0.25
    },
    "lain": {
      "hairColor": "#002808",
      "hairLight": "#003818",
      "outfitColor": "#002010",
      "outfitAccent": "#003020",
      "accentColor": "#00cc44",
      "glowColor": "#00cc44",
      "glowOpacity": 0.15
    },
    "pkd": {
      "hairColor": "#002818",
      "hairLight": "#003828",
      "outfitColor": "#002010",
      "outfitAccent": "#003020",
      "accentColor": "#40ff80",
      "glowColor": "#40ff80",
      "glowOpacity": 0.1
    },
    "mckenna": {
      "hairColor": "#003008",
      "hairLight": "#004018",
      "outfitColor": "#002810",
      "outfitAccent": "#003820",
      "accentColor": "#80ff40",
      "glowColor": "#80ff40",
      "glowOpacity": 0.1
    },
    "john": {
      "hairColor": "#282800",
      "hairLight": "#383800",
      "outfitColor": "#303000",
      "outfitAccent": "#404000",
      "accentColor": "#ffcc40",
      "glowColor": "#ffcc40",
      "glowOpacity": 0.1
    },
    "dr-claude": {
      "hairColor": "#280000",
      "hairLight": "#380000",
      "outfitColor": "#90c890",
      "outfitAccent": "#a0d8a0",
      "accentColor": "#ff4040",
      "glowColor": "#ff4040",
      "glowOpacity": 0.1
    },
    "hiru": {
      "hairColor": "#003020",
      "hairLight": "#004030",
      "outfitColor": "#002828",
      "outfitAccent": "#003838",
      "accentColor": "#40ffc0",
      "glowColor": "#40ffc0",
      "glowOpacity": 0.15
    }
  }
}
```

- [ ] **Step 4: Verify and commit**

```bash
git add src/web/skins/terminal/
git commit -m "feat(skins): add Terminal skin — Phosphor Green"
```

---

## Task 16: Update per-character pages to use skin system

The per-character pages (`/pkd/`, `/mckenna/`, etc.) currently have their own standalone `styles.css` with hardcoded color themes. These need to participate in the skin system — when a global skin is active, the character's colors come from the skin, not from the per-character CSS.

**Files:**
- Modify: `src/web/public-pkd/index.html` (and other character index.html files)
- Modify: `src/web/public-pkd/styles.css` (and other character styles.css files)

- [ ] **Step 1: List all per-character public directories**

```bash
ls -d src/web/public-*/
```

- [ ] **Step 2: For each character's styles.css, ensure variables use the same names**

Each character's `:root` block must use the same variable names as the base system. Rename any character-specific variable names:
- `--accent-amber` → `--accent-primary`
- `--accent-orange` → `--accent-tertiary`
- `--glow-amber` → `--glow-primary`

This ensures that when a skin's CSS is loaded after the character CSS, it correctly overrides all values.

- [ ] **Step 3: Add skin loader and picker scripts to each character's index.html**

Add to each character's `index.html` before `</body>`:

```html
<script src="skins/loader.js"></script>
<script src="skins/picker.js"></script>
```

- [ ] **Step 4: Test that switching skins on a character page works**

Navigate to e.g. `/pkd/`, open the skin picker, switch to Vaporwave. The page should adopt the vaporwave palette, overriding PKD's amber theme.

- [ ] **Step 5: Commit**

```bash
git add src/web/public-*/
git commit -m "feat(skins): integrate per-character pages with global skin system"
```

---

## Task 17: End-to-end verification and polish

**Files:** All skin-related files

- [ ] **Step 1: Test every skin on the main chat page**

Open the Wired Lain chat (`/`), cycle through all 6 skins via the picker. Verify each skin changes:
- Background colors
- Text colors
- Accent/glow colors
- Fonts
- Border radii
- Message bubble styling

- [ ] **Step 2: Test every skin on the commune map**

Open the commune map. Cycle through skins. Verify:
- Building icons change per skin
- Character colors update
- Event type colors update
- Activity panel styling updates

- [ ] **Step 3: Test every skin on newspapers**

Open both newspaper pages. Cycle through skins. Verify styling changes.

- [ ] **Step 4: Test every skin on the game view**

Open the game. Cycle through skins. Verify sprite colors update.

- [ ] **Step 5: Test URL sharing**

Open `/?skin=gothic` in a fresh incognito window. Verify:
- Gothic skin loads immediately
- localStorage is set
- Removing `?skin=` and refreshing still uses gothic (from localStorage)

- [ ] **Step 6: Test skin persistence across character pages**

Set skin to Kawaii on the main page, then navigate to `/pkd/`. Verify Kawaii skin persists.

- [ ] **Step 7: Fix any visual issues found during testing**

Address any inconsistencies, missing variable usage, or styling breaks.

- [ ] **Step 8: Final commit**

```bash
git add -A
git commit -m "feat(skins): end-to-end verification and polish"
```

---

## Task 18: Deploy to production

**Files:** None (deployment commands only)

- [ ] **Step 1: Run tests**

```bash
npm run build && npx vitest run test/config.test.ts test/storage.test.ts test/regression.test.ts
```

- [ ] **Step 2: Push to main and deploy**

```bash
git push origin claude/cool-kilby
```

Then SSH to droplet and deploy:

```bash
ssh root@198.211.116.5 "cd /opt/local-lain && git pull && npm run build && systemctl restart lain.target"
```

- [ ] **Step 3: Verify on production**

Open `https://laintown.com/?skin=vaporwave` and verify the skin system works in production.

- [ ] **Step 4: Verify all services are healthy**

```bash
ssh root@198.211.116.5 "cd /opt/local-lain && ./deploy/status.sh"
```
