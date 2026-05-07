# Laintown Skin System Design

## Overview

A global visual theming system that lets users switch the entire look and feel of Laintown. Skins control every visual surface: CSS colors/fonts/effects, character sprites, building icons, commune map, newspaper, game view, and all character pages. Each skin provides per-character color palettes so inhabitants remain visually distinct within any theme.

## Skins

Six skins ship in the initial set:

| ID | Name | Vibe |
|----|------|------|
| `default` | Wired Protocol | Current look — dark navy, blue/cyan glows, Orbitron + Share Tech Mono, tech-noir |
| `vaporwave` | Aesthetic | Magenta/cyan/sunset gradients, chrome, Japanese motifs, 80s retrofuturism |
| `kawaii` | Soft & Cute | Pastel pinks/lavenders/blues, rounded corners, gentle glows, playful typography |
| `gothic` | Dark Cathedral | Deep blacks, crimsons, purples, silver. Serif fonts, sharp corners, ornamental borders |
| `hardcore` | Brutalist | Black + red/white only. No gradients, no radii, monospace everything, harsh contrast |
| `terminal` | Phosphor Green | CRT green-on-black, heavy scanlines, phosphor glow, pure monospace, retro terminal |

## File Structure

```
src/web/skins/
  index.js                 # Skin registry — exports list of available skins
  loader.js                # Runtime skin loading/switching logic
  picker.js                # Skin picker UI widget
  picker.css               # Skin picker styles (minimal, skin-agnostic)
  default/
    skin.css               # CSS custom properties (canonical list of all skinnable vars)
    sprites.json             # Character sprite configs (colors, proportions, draw callbacks)
    manifest.json          # Metadata: id, name, description, fonts, building icons
  vaporwave/
    skin.css
    sprites.json
    manifest.json
  kawaii/
    skin.css
    sprites.json
    manifest.json
  gothic/
    skin.css
    sprites.json
    manifest.json
  hardcore/
    skin.css
    sprites.json
    manifest.json
  terminal/
    skin.css
    sprites.json
    manifest.json
```

## Skin Definition Files

### manifest.json

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
  "googleFontsUrl": "https://fonts.googleapis.com/css2?family=Cinzel&family=Crimson+Text&family=Fira+Code&display=swap",
  "previewColors": ["#8b0020", "#600080", "#c0c0c0"]
}
```

`previewColors` is used by the skin picker to show a small color swatch for each skin.

### skin.css

Overrides `:root` CSS custom properties. The default skin's CSS is the canonical reference for all skinnable properties. Other skins override what they need; anything unset falls back to default.

The full variable surface includes:

**Colors:**
- `--bg-deep`, `--bg-primary`, `--bg-panel`, `--bg-window` — background layers
- `--text-primary`, `--text-secondary`, `--text-dim` — text hierarchy
- `--accent-blue`, `--accent-light`, `--accent-cyan` — accent colors (renamed to `--accent-primary`, `--accent-secondary`, `--accent-tertiary` for skin-agnostic naming)
- `--border-glow` — border accent color
- `--glow-primary` — box-shadow glow definition
- `--hologram` — gradient overlay

**Per-character colors** (used in commune map, activity feeds, etc.):
- `--color-wired-lain`, `--color-lain`, `--color-dr-claude`, `--color-pkd`, `--color-mckenna`, `--color-john`, `--color-hiru`

**Event type colors:**
- `--type-diary`, `--type-dream`, `--type-commune`, `--type-curiosity`, `--type-chat`, `--type-memory`, `--type-letter`, `--type-narrative`, `--type-self-concept`, `--type-doctor`, `--type-peer`, `--type-movement`

**Fonts:**
- `--font-heading`, `--font-body`, `--font-mono`

**Borders & shapes:**
- `--border-radius` — global border radius (0 for hardcore, 12px for kawaii)
- `--border-style` — solid, dashed, double, etc.
- `--border-width` — default border thickness

**Effects:**
- `--scanline-opacity` — scanline overlay intensity (0 to disable, 0.1 default, 0.3 for terminal)
- `--particle-color` — floating particle color
- `--particle-opacity` — particle visibility
- `--animation-speed` — global animation speed multiplier

**Messages:**
- `--msg-user-bg`, `--msg-user-border` — user message styling
- `--msg-assistant-bg`, `--msg-assistant-border`, `--msg-assistant-glow` — assistant message styling

**Newspaper:**
- `--newspaper-bg`, `--newspaper-text`, `--newspaper-heading`, `--newspaper-accent`, `--newspaper-quote-border`

### sprites.jsonon

A JSON file (not a JS module — fetched at runtime via `fetch()` so it works in the Phaser game context without ESM). Each character entry can override:

- `hairColor`, `hairShadow` — hair palette
- `outfitColor`, `outfitShadow` — outfit palette
- `skinTone`, `skinShadow` — skin palette
- `accentColor` — character-specific accent (clips, accessories)
- `glowColor`, `glowOpacity` — character aura/glow
- `headScale` — head size multiplier (1.0 default, 1.3 for kawaii)
- `eyeStyle` — eye drawing variant ('default', 'dot', 'wide', 'narrow')

Fallback: any property not defined falls back to the default skin's sprite config for that character.

```json
// Example: gothic/sprites.json
{
  'wired-lain': {
    hairColor: '#1a0020',
    outfitColor: '#200010',
    accentColor: '#8b0020',
    glowColor: '#600040',
    eyeStyle: 'narrow'
  },
  'lain': {
    hairColor: '#0a0010',
    outfitColor: '#180008',
    accentColor: '#a00030',
    glowColor: '#400020',
    eyeStyle: 'narrow'
  },
  // ... other characters
}
```

## Runtime Skin Loading

### Initialization (on every page load)

1. Read skin preference: `URL ?skin= param` > `localStorage 'laintown-skin'` > `'default'`
2. Fetch `/skins/<id>/manifest.json`
3. If manifest specifies `googleFontsUrl`, inject a `<link>` to load fonts
4. Inject `/skins/<id>/skin.css` as a `<link rel="stylesheet">` after the base stylesheets (so skin vars override defaults)
5. Set `document.documentElement.dataset.skin = id` for any CSS selectors that need it
6. Store choice in `localStorage.setItem('laintown-skin', id)`
7. Update URL to include `?skin=<id>` via `history.replaceState` (no reload)
8. Emit a `skin-changed` custom event on `document` for components that need to react

### Switching (no page reload)

1. Remove old skin CSS `<link>` and font `<link>`
2. Load new manifest, fonts, and CSS
3. Update localStorage, URL, dataset attribute
4. Fire `skin-changed` event
5. Listeners:
   - Commune map: re-render building icons from new manifest
   - Game view: reload sprite config, redraw all characters
   - Newspaper: CSS variables auto-apply, no action needed
   - Chat: CSS variables auto-apply, no action needed

### loader.js API

```javascript
// Get current skin id
getSkinId() → string

// Switch skin (async — loads manifest + CSS + fonts)
setSkin(skinId: string) → Promise<void>

// Get manifest for a skin
getSkinManifest(skinId: string) → Promise<Manifest>

// Get list of all available skins
getAvailableSkins() → Array<{id, name, description, previewColors}>

// Listen for skin changes
onSkinChange(callback: (skinId: string) => void) → () => void  // returns unsubscribe
```

## Skin Picker Widget

A small, unobtrusive widget on every page:

- **Collapsed state:** Small palette icon (🎨) in the bottom-left corner, semi-transparent, shows on hover
- **Expanded state:** A floating panel showing all available skins as small cards — each with the skin name and a 3-color swatch from `previewColors`
- **Click a skin:** Switches immediately, picker stays open so you can browse
- **Click outside or the palette icon:** Collapses

The picker is injected by `loader.js` so it's automatically present on every page that loads the skin system. Its own styles are in `picker.css` and use hardcoded neutral colors (not skin variables) so it remains readable in any skin.

## Integration Points

### Base Stylesheets (styles.css, commune-map.css, etc.)

- Rename color-specific variable names to skin-agnostic names where needed (e.g., `--accent-blue` → `--accent-primary`)
- Ensure all hardcoded colors are extracted to CSS custom properties
- The default skin's `skin.css` sets all properties to their current values, so nothing changes visually until a skin is switched

### Per-Character Pages (/pkd/, /mckenna/, etc.)

- Each character's `styles.css` currently sets its own `:root` variables
- These get restructured: the character-specific colors come from the active skin's `--color-<character>` variables, not from per-character CSS files
- The per-character CSS files remain but only handle layout/structural differences, not colors

### Commune Map (commune-map.js)

- Building icons: read from skin manifest instead of hardcoded emoji
- Character colors: already use CSS variables, will auto-update
- Listen to `skin-changed` event to re-render building icons

### Game View (game/js/sprites.json)

- Import sprite config from active skin
- On `skin-changed`, reload config and redraw all visible sprites
- Default sprite drawing functions remain as fallbacks

### Newspaper (newspaper.html, commune-newspaper.html)

- **Prerequisite:** Migrate hardcoded inline color styles to CSS custom properties (newspaper currently has many inline `color:`, `background:`, `border:` styles that bypass CSS variables)
- Once migrated, newspaper-specific variables in skin.css handle the rest

### Game View (game/index.html)

- The game runs in the same page context (not an iframe), so it shares the skin's localStorage and can listen for `skin-changed` events
- On skin change: fetch new `sprites.json`, update the sprite config cache, and call a redraw on all visible character sprites
- The Phaser canvas background and UI overlays (dialogue boxes, labels) also read from CSS variables via `getComputedStyle` at render time

### Server-Side

- Serve `/skins/` directory as static files
- No other server changes needed — skin switching is entirely client-side

## URL Behavior

- `?skin=gothic` — loads gothic skin, saves to localStorage
- No `?skin` param — uses localStorage, defaults to `default`
- Sharing a URL with `?skin=` gives the recipient that skin for their session
- The `?skin` param is preserved across navigation within the site

## Adding New Skins (Workflow)

To add a new skin:

1. Describe the vibe (e.g., "solarpunk — green/gold, organic, bioluminescent, hopeful")
2. Create `src/web/skins/<id>/manifest.json` with name, fonts, building icons, preview colors
3. Create `src/web/skins/<id>/skin.css` overriding the CSS custom properties
4. Create `src/web/skins/<id>/sprites.json` with character color palettes
5. Add the skin id to the registry in `src/web/skins/index.js`
6. Deploy

The entire process is: describe vibe → generate 3 files → register → deploy. No structural changes, no base CSS modifications, no duplication.
