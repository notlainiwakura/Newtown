// Newtown Skin Loader
const SKIN_STORAGE_KEY = 'laintown-skin';
const SKIN_CHANGED_EVENT = 'skin-changed';
const DEFAULT_SKIN = 'default';

let currentSkinId = null;
let currentManifest = null;
let skinLinkEl = null;
let fontLinkEl = null;
let registry = null;

function skinsBasePath() {
  // Character pages (e.g., /neo/, /plato/) have their own server with a /skins/ route.
  // All other pages (including /game/, /newspaper.html, etc.) use the root /skins/.
  const charPaths = ['/neo', '/plato', '/joe'];
  const path = location.pathname;
  for (const cp of charPaths) {
    if (path.startsWith(cp + '/') || path === cp) {
      return cp + '/skins';
    }
  }
  return '/skins';
}

function detectSkin() {
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get('skin');
  if (fromUrl) return fromUrl;
  const fromStorage = localStorage.getItem(SKIN_STORAGE_KEY);
  if (fromStorage) return fromStorage;
  return DEFAULT_SKIN;
}

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

async function fetchManifest(skinId) {
  const res = await fetch(`${skinsBasePath()}/${skinId}/manifest.json`);
  if (!res.ok) throw new Error(`Skin "${skinId}" not found`);
  return res.json();
}

function applySkinCSS(skinId) {
  // Check if early-load.js already injected this skin's CSS
  const earlyLink = document.getElementById('laintown-skin-css-early');
  if (earlyLink) {
    const expectedHref = `${skinsBasePath()}/${skinId}/skin.css`;
    if (earlyLink.href.endsWith(`/${skinId}/skin.css`)) {
      // Early-load already has the right skin — adopt it
      earlyLink.id = 'laintown-skin-css';
      skinLinkEl = earlyLink;
      return;
    }
    // Wrong skin in early-load — remove it
    earlyLink.remove();
  }
  if (skinLinkEl) skinLinkEl.remove();
  skinLinkEl = document.createElement('link');
  skinLinkEl.rel = 'stylesheet';
  skinLinkEl.href = `${skinsBasePath()}/${skinId}/skin.css`;
  skinLinkEl.id = 'laintown-skin-css';
  document.head.appendChild(skinLinkEl);
}

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

function updateUrl(skinId) {
  const url = new URL(location.href);
  if (skinId === DEFAULT_SKIN) {
    url.searchParams.delete('skin');
  } else {
    url.searchParams.set('skin', skinId);
  }
  history.replaceState(null, '', url.toString());
}

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

function getSkinId() {
  return currentSkinId || DEFAULT_SKIN;
}

function getSkinManifest() {
  return currentManifest;
}

async function getAvailableSkins() {
  const reg = await getRegistry();
  const skins = [];
  for (const id of reg) {
    try {
      const manifest = await fetchManifest(id);
      skins.push(manifest);
    } catch { /* skip */ }
  }
  return skins;
}

function onSkinChange(callback) {
  const handler = (e) => callback(e.detail.skinId, e.detail.manifest);
  document.addEventListener(SKIN_CHANGED_EVENT, handler);
  return () => document.removeEventListener(SKIN_CHANGED_EVENT, handler);
}

async function getSpriteConfig() {
  const skinId = getSkinId();
  try {
    const res = await fetch(`${skinsBasePath()}/${skinId}/sprites.json`);
    if (res.ok) return res.json();
  } catch { /* fall through */ }
  if (skinId !== DEFAULT_SKIN) {
    try {
      const res = await fetch(`${skinsBasePath()}/default/sprites.json`);
      if (res.ok) return res.json();
    } catch { /* fall through */ }
  }
  return null;
}

let _readyResolve;
const _ready = new Promise((resolve) => { _readyResolve = resolve; });

async function initSkin() {
  try {
    const skinId = detectSkin();
    await setSkin(skinId);
  } catch (e) {
    console.warn('Skin init failed:', e);
  }
  _readyResolve();
}

window.LaintownSkins = {
  init: initSkin,
  _ready,
  _skinsBasePath: skinsBasePath,
  setSkin,
  getSkinId,
  getSkinManifest,
  getAvailableSkins,
  getSpriteConfig,
  onSkinChange,
  SKIN_CHANGED_EVENT,
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSkin);
} else {
  initSkin();
}
