
  (function () {
    'use strict';

    function getCSSVar(name) {
      return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    }

    var CHARS = [
      { id: 'neo',        name: 'Neo',         colorVar: '--color-neo',        path: '/neo/api/activity' },
      { id: 'plato',      name: 'Plato',       colorVar: '--color-plato',      path: '/plato/api/activity' },
      { id: 'joe',        name: 'Joe',         colorVar: '--color-joe',        path: '/joe/api/activity' },
      { id: 'cage',       name: 'Nicolas Cage', colorVar: '--color-cage',       path: '/cage/api/activity' },
    ];

    var TYPE_COLOR_VARS = {
      diary: '--type-diary', dream: '--type-dream', commune: '--type-commune',
      curiosity: '--type-curiosity', chat: '--type-chat', memory: '--type-memory',
      letter: '--type-letter', narrative: '--type-narrative', 'self-concept': '--type-self-concept',
      doctor: '--type-doctor', peer: '--type-peer', movement: '--type-movement',
      research: '--type-research', note: '--type-note', document: '--type-document', gift: '--type-gift',
    };

    var TYPE_LABELS = {
      diary: 'DIARY', dream: 'DREAM', commune: 'COMMUNE', curiosity: 'CURIOSITY',
      chat: 'CHAT', memory: 'MEMORY', letter: 'LETTER', narrative: 'NARRATIVE',
      'self-concept': 'SELF', doctor: 'DOCTOR', peer: 'PEER', movement: 'MOVEMENT',
      research: 'RESEARCH', note: 'NOTE', document: 'DOC', gift: 'GIFT',
    };

    var allEntries = [];
    var activeFilter = 'all';
    var WINDOW = 7 * 24 * 60 * 60 * 1000; // 7 days

    function parseType(sessionKey) {
      if (!sessionKey) return 'unknown';
      var prefix = sessionKey.split(':')[0];
      if (prefix === 'stranger') return 'chat';
      if (CHARS.some(function (char) { return char.id === prefix; })) return 'chat';
      var map = {
        commune: 'commune', diary: 'diary', dream: 'dream',
        curiosity: 'curiosity', 'self-concept': 'self-concept',
        selfconcept: 'self-concept', narrative: 'narrative',
        letter: 'letter', wired: 'letter', web: 'chat',
        peer: 'peer', telegram: 'chat', bibliomancy: 'curiosity',
        dr: 'doctor', doctor: 'doctor', proactive: 'chat',
        movement: 'movement', move: 'movement', note: 'note',
        document: 'document', gift: 'gift', research: 'research',
      };
      return map[prefix] || prefix;
    }

    function relativeTime(ts) {
      var diff = Date.now() - ts;
      var m = Math.floor(diff / 60000);
      var h = Math.floor(diff / 3600000);
      var d = Math.floor(diff / 86400000);
      if (m < 1) return 'just now';
      if (m < 60) return m + 'm ago';
      if (h < 24) return h + 'h ago';
      return d + 'd ago';
    }

    function fetchAll() {
      var now = Date.now();
      var from = now - WINDOW;
      var seen = new Set();
      var pending = CHARS.length;
      var collected = [];

      CHARS.forEach(function (char) {
        var url = char.path + '?from=' + from + '&to=' + now + '&includeChat=1&_t=' + now;

        fetch(url, { cache: 'no-store' })
          .then(function (r) { return r.ok ? r.json() : []; })
          .then(function (entries) {
            if (!Array.isArray(entries)) return;
            entries.forEach(function (e) {
              if (!seen.has(e.id)) {
                seen.add(e.id);
                e._charId = char.id;
                e._charName = char.name;
                e._charColor = getCSSVar(char.colorVar) || char.colorVar;
                collected.push(e);
              }
            });
          })
          .catch(function () {})
          .finally(function () {
            pending--;
            if (pending === 0) {
              collected.sort(function (a, b) { return b.timestamp - a.timestamp; });
              allEntries = collected;
              render();
              var el = document.getElementById('edition-line');
              if (el) el.textContent = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
              var sl = document.getElementById('status-line');
              if (sl) sl.textContent = allEntries.length + ' entries';
            }
          });
      });
    }

    function render() {
      var feed = document.getElementById('feed');
      var filtered = activeFilter === 'all'
        ? allEntries
        : allEntries.filter(function (e) { return parseType(e.sessionKey) === activeFilter; });

      if (filtered.length === 0) {
        feed.innerHTML = '<div class="empty">NO SIGNAL</div>';
        return;
      }

      feed.innerHTML = '';
      filtered.forEach(function (entry) {
        var type = parseType(entry.sessionKey);
        var typeColorVar = TYPE_COLOR_VARS[type];
        var typeColor = typeColorVar ? (getCSSVar(typeColorVar) || getCSSVar('--type-default')) : getCSSVar('--type-default');
        var typeLabel = TYPE_LABELS[type] || type.toUpperCase();
        var content = (entry.content || '').trim();

        var el = document.createElement('div');
        el.className = 'entry';
        el.innerHTML =
          '<div class="entry-header">' +
            '<span class="entry-type" style="color:' + typeColor + ';border-color:' + typeColor + '">' + typeLabel + '</span>' +
            '<span class="entry-char" style="color:' + entry._charColor + '">' + entry._charName + '</span>' +
            '<span class="entry-time">' + relativeTime(entry.timestamp) + '</span>' +
          '</div>' +
          '<div class="entry-body">' + escHtml(content) + '</div>';

        el.addEventListener('click', function () {
          el.classList.toggle('expanded');
        });

        feed.appendChild(el);
      });
    }

    function escHtml(s) {
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    // Filter controls
    document.querySelectorAll('.filter-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('.filter-btn').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        activeFilter = btn.dataset.filter;
        render();
      });
    });

    fetchAll();
    setInterval(fetchAll, 60000);
  })();
  
