// Newtown navigation bar
(function () {
  var path = location.pathname;
  var links = [
    { label: 'CHAT', href: '/' },
    { label: 'MAP', href: '/commune-map.html' }
  ];

  function isActive(href) {
    return path === href;
  }

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
    'body{padding-top:32px!important}';
  document.head.appendChild(style);

  function insertNav() {
    if (document.getElementById('laintown-nav')) return;

    var nav = document.createElement('div');
    nav.id = 'laintown-nav';

    var title = document.createElement('a');
    title.className = 'ltn-title';
    title.href = '/';
    title.textContent = 'NEWTOWN';
    nav.appendChild(title);

    for (var i = 0; i < links.length; i++) {
      var a = document.createElement('a');
      a.href = links[i].href;
      a.textContent = links[i].label;
      if (isActive(links[i].href)) a.className = 'ltn-active';
      nav.appendChild(a);
    }

    document.body.insertBefore(nav, document.body.firstChild);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', insertNav);
  } else {
    insertNav();
  }
})();
