// Newtown navigation bar — injected into all pages (including proxied character servers)
(function () {
  var path = location.pathname;
  var publicLinks = [
    { label: 'MAP', href: '/commune-map.html' },
    { label: 'WALK', href: '/game/' },
    { label: 'NEWS', href: '/commune-newspaper.html' },
    { label: 'PAPER', href: '/newspaper.html' }
  ];
  var ownerLinks = [
    { label: 'POST', href: '/postboard.html' },
    { label: 'EVENTS', href: '/town-events.html' },
    { label: 'DREAMS', href: '/dreams.html' },
    { label: 'DASH', href: '/dashboard.html' },
    { label: 'NEO', href: '/neo/' },
    { label: 'PLATO', href: '/plato/' },
    { label: 'JOE', href: '/joe/' },
    { label: 'CAGE', href: '/cage/' }
  ];
  var exitLink = { label: 'EXIT', href: 'https://shraii.com' };

  var isGame = path === '/game/' || path === '/game/index.html';
  var isOwner = !!document.querySelector('meta[name="lain-owner"][content="true"]');
  var links = isOwner ? publicLinks.concat(ownerLinks, [exitLink]) : publicLinks.concat([exitLink]);

  function ensureStylesheet() {
    if (document.querySelector('link[href="/laintown-nav.css"]')) return;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/laintown-nav.css';
    document.head.appendChild(link);
  }

  function applyBodyClass() {
    document.body.classList.remove('ltn-has-nav', 'ltn-game-nav');
    document.body.classList.add(isGame ? 'ltn-game-nav' : 'ltn-has-nav');
  }

  function isActive(href) {
    if (href === '/commune-map.html') return path === '/commune-map.html';
    if (href === '/') return path === '/' || path === '/index.html';
    return path.indexOf(href) === 0;
  }

  function syncActiveState(nav) {
    var anchors = nav.querySelectorAll('a');
    for (var i = 0; i < anchors.length; i++) {
      var anchor = anchors[i];
      if (anchor.classList.contains('ltn-title')) continue;
      anchor.classList.remove('ltn-active');

      var href = anchor.getAttribute('href');
      if (!href) continue;
      var target;
      try {
        target = new URL(href, location.origin);
      } catch {
        continue;
      }
      if (target.origin === location.origin && isActive(target.pathname)) {
        anchor.classList.add('ltn-active');
      }
    }
  }

  function propagateKey(nav) {
    var key = new URLSearchParams(location.search).get('key');
    if (!key || nav.dataset.ltnKeyPropagated === 'true') return;

    var anchors = nav.querySelectorAll('a');
    for (var i = 0; i < anchors.length; i++) {
      var anchor = anchors[i];
      var href = anchor.getAttribute('href');
      if (!href) continue;
      var target;
      try {
        target = new URL(href, location.origin);
      } catch {
        continue;
      }
      if (target.origin !== location.origin) continue;
      target.searchParams.set('key', key);
      anchor.setAttribute('href', target.pathname + target.search + target.hash);
    }
    nav.dataset.ltnKeyPropagated = 'true';
  }

  ensureStylesheet();

  // Build and insert nav once body exists
  function insertNav() {
    applyBodyClass();

    var existing = document.getElementById('laintown-nav');
    if (existing) {
      if (isGame) existing.classList.add('ltn-game');
      syncActiveState(existing);
      propagateKey(existing);
      return; // Already injected by server.ts
    }

    var nav = document.createElement('div');
    nav.id = 'laintown-nav';
    if (isGame) nav.className = 'ltn-game';
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
    propagateKey(nav);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', insertNav);
  } else {
    insertNav();
  }
})();
