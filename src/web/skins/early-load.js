// Skin early-load: blocks rendering until skin CSS is injected.
// Must be placed in <head> AFTER base stylesheet, BEFORE </head>.
// This prevents the flash of default theme on non-default skins.
(function() {
  function getInjectedCharPaths() {
    var meta = document.querySelector('meta[name="laintown-char-paths"]');
    if (meta && meta.content) {
      try {
        var parsed = JSON.parse(meta.content);
        if (Array.isArray(parsed) && parsed.length) return parsed;
      } catch {}
    }
    if (window.LAINTOWN_CHAR_PATHS && window.LAINTOWN_CHAR_PATHS.length) {
      return window.LAINTOWN_CHAR_PATHS;
    }
    return [];
  }

  // Immediately set a dark background to prevent white flash during page load.
  // This runs before any stylesheet, so the user never sees white.
  var bgColors = {
    'default':   '#0a0a1a',
    'gothic':    '#06000a',
    'kawaii':    '#1a1020',
    'vaporwave': '#0a0020',
    'hardcore':  '#000000',
    'terminal':  '#000800'
  };
  var rawSkinId = new URLSearchParams(location.search).get('skin')
    || localStorage.getItem('laintown-skin')
    || 'default';
  // findings.md P2:2484 — early-load runs before the skins registry is
  // fetched, so it cannot validate against the authoritative list. Without
  // a strict allowlist regex, a value like `..%2fevil` or `../../foo`
  // would flow straight into the <link href> path below. Server-side
  // `/skins/*` is path-traversal-safe (resolve + startsWith), so this is
  // a defense-in-depth front-end guard: refuse anything that doesn't
  // match `^[a-z][a-z0-9-]*$`, fall back to the default skin. Mid-load
  // switches (loader.js:setSkin) *do* validate against the registry.
  var skinId = /^[a-z][a-z0-9-]*$/.test(rawSkinId) ? rawSkinId : 'default';
  var bg = bgColors[skinId] || '#0a0a1a';
  document.documentElement.style.background = bg;

  if (skinId === 'default') return;
  // findings.md P2:2388 — read the authoritative list injected by the main
  // server (server.ts:injectNavBar) instead of hardcoding character routes
  // that drift every time a character is renamed. Direct-access to a
  // character server skips injection; for that case we stay on `/skins`
  // since the URL itself won't carry a character prefix.
  var charPaths = getInjectedCharPaths();
  var path = '/skins';
  for (var i = 0; i < charPaths.length; i++) {
    if (location.pathname.indexOf(charPaths[i] + '/') === 0 || location.pathname === charPaths[i]) {
      path = charPaths[i] + '/skins';
      break;
    }
  }
  var link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = path + '/' + skinId + '/skin.css';
  link.id = 'laintown-skin-css-early';
  document.head.appendChild(link);
  document.documentElement.dataset.skin = skinId;
})();
