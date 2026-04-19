// Skin early-load: blocks rendering until skin CSS is injected.
// Must be placed in <head> AFTER base stylesheet, BEFORE </head>.
// This prevents the flash of default theme on non-default skins.
(function() {
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
  var skinId = new URLSearchParams(location.search).get('skin')
    || localStorage.getItem('laintown-skin')
    || 'default';
  var bg = bgColors[skinId] || '#0a0a1a';
  document.documentElement.style.background = bg;

  if (skinId === 'default') return;
  var charPaths = ['/neo', '/plato', '/joe'];
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
