// Laintown navigation bar — injected into all pages (including proxied character servers)
(function () {
  var path = location.pathname;
  var links = [
    { label: 'MAP', href: '/commune-map.html' },
    { label: 'NETWORK', href: '/commune-map.html#network' },
    { label: 'WALK', href: '/game/' },
    { label: 'NEWS', href: '/commune-newspaper.html' },
    { label: 'NEO', href: '/neo/' },
    { label: 'PLATO', href: '/plato/' },
    { label: 'JOE', href: '/joe/' }
  ];

  var isGame = path === '/game/' || path === '/game/index.html';

  function isActive(href) {
    if (href === '/commune-map.html#network') return false;
    if (href === '/commune-map.html') return path === '/commune-map.html';
    return path.indexOf(href) === 0;
  }

  // Inject font + styles into <head> immediately (no need to wait for body)
  var font = document.createElement('link');
  font.rel = 'stylesheet';
  font.href = 'https://fonts.googleapis.com/css2?family=Share+Tech+Mono&display=swap';
  document.head.appendChild(font);

  var style = document.createElement('style');
  style.textContent =
    '#laintown-nav{position:fixed;top:0;left:0;right:0;height:32px;background:#0a0a0f;border-bottom:1px solid #1a1a2e;display:flex;align-items:center;z-index:99999;font-family:"Share Tech Mono",monospace;padding:0 12px;gap:0}' +
    '#laintown-nav .ltn-title{color:#4a9eff;font-size:11px;letter-spacing:2px;text-transform:uppercase;margin-right:16px;text-decoration:none}' +
    '#laintown-nav a{color:#556;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;text-decoration:none;padding:0 10px;line-height:32px;transition:color .2s}' +
    '#laintown-nav a:hover{color:#8ab4f8}' +
    '#laintown-nav a.ltn-active{color:#4a9eff}' +
    (isGame
      ? 'body{padding-top:0!important}#laintown-nav{background:rgba(10,10,15,0.6);border-bottom-color:rgba(26,26,46,0.4)}'
      : 'body{padding-top:32px!important}');
  document.head.appendChild(style);

  // Build and insert nav once body exists
  function insertNav() {
    if (document.getElementById('laintown-nav')) return; // Already injected by server.ts

    var nav = document.createElement('div');
    nav.id = 'laintown-nav';
    var title = document.createElement('a');
    title.className = 'ltn-title';
    title.href = '/';
    title.textContent = 'LAINTOWN';
    nav.appendChild(title);

    var key = new URLSearchParams(location.search).get('key');

    for (var i = 0; i < links.length; i++) {
      var a = document.createElement('a');
      var href = links[i].href;
      if (key) {
        var hi = href.indexOf('#');
        var base = hi > -1 ? href.slice(0, hi) : href;
        var frag = hi > -1 ? href.slice(hi) : '';
        href = base + '?key=' + encodeURIComponent(key) + frag;
      }
      a.href = href;
      a.textContent = links[i].label;
      if (isActive(links[i].href)) a.className = 'ltn-active';
      nav.appendChild(a);
    }

    if (key) title.href = '/?key=' + encodeURIComponent(key);

    document.body.insertBefore(nav, document.body.firstChild);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', insertNav);
  } else {
    insertNav();
  }
})();
