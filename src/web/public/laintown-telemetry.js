// Laintown telemetry console — unified real-time activity feed from all town inhabitants
(function () {
  'use strict';

  // ===== Character endpoints =====
  // findings.md P2:3176 — built dynamically from /api/characters so the
  // telemetry console survives generational succession, renames, and new
  // residents without a code edit. Paths follow the proxy scheme in
  // server.ts: the web character is served at `/`; every other character
  // is proxied at `/<charId>/`.
  var ENDPOINTS = [];
  function _hashColorHex(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    var hue = ((h % 360) + 360) % 360;
    var s = 0.6, l = 0.65;
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs((hue / 60) % 2 - 1));
    var m = l - c / 2;
    var r, g, b;
    if (hue < 60) { r = c; g = x; b = 0; }
    else if (hue < 120) { r = x; g = c; b = 0; }
    else if (hue < 180) { r = 0; g = c; b = x; }
    else if (hue < 240) { r = 0; g = x; b = c; }
    else if (hue < 300) { r = x; g = 0; b = c; }
    else { r = c; g = 0; b = x; }
    var toHex = function (v) { return Math.round((v + m) * 255).toString(16).padStart(2, '0'); };
    return '#' + toHex(r) + toHex(g) + toHex(b);
  }
  function loadEndpoints() {
    return fetch('/api/characters', { cache: 'no-store' })
      .then(function (resp) { return resp.ok ? resp.json() : { characters: [] }; })
      .then(function (data) {
        var list = (data && Array.isArray(data.characters)) ? data.characters : [];
        ENDPOINTS = list.map(function (c) {
          var basePath = c.web === true ? '' : '/' + c.id;
          return {
            id: c.id,
            name: c.name,
            color: _hashColorHex(c.id),
            path: basePath + '/api/activity',
          };
        });
      })
      .catch(function () { ENDPOINTS = []; });
  }

  var TYPE_COLORS = {
    diary: '#e0a020',
    dream: '#a040e0',
    commune: '#40d0e0',
    curiosity: '#40c060',
    chat: '#c0d0e0',
    memory: '#4080e0',
    letter: '#e060a0',
    narrative: '#e08030',
    'self-concept': '#8080e0',
    doctor: '#ff6060',
    peer: '#60c0c0',
    movement: '#e0d040',
    move: '#e0d040',
    note: '#c0a060',
    document: '#a0c0e0',
    gift: '#e080c0',
    research: '#60e0e0',
  };

  var TYPE_LABELS = {
    diary: 'DIARY',
    dream: 'DREAM',
    commune: 'COMMUNE',
    curiosity: 'CURIOSITY',
    chat: 'CHAT',
    memory: 'MEMORY',
    letter: 'LETTER',
    narrative: 'NARRATIVE',
    'self-concept': 'SELF',
    doctor: 'DOCTOR',
    peer: 'PEER',
    movement: 'MOVEMENT',
    move: 'MOVE',
    note: 'NOTE',
    document: 'DOC',
    gift: 'GIFT',
    research: 'RESEARCH',
  };

  // Auth is handled via HTTP-only session cookie — no API key needed

  // ===== State =====
  var events = []; // sorted chronologically (oldest first)
  var seenIds = new Set();
  var lastTimestamp = 0;
  var collapsed = true;
  var userScrolled = false;
  var pollTimer = null;
  var POLL_INTERVAL = 10000;
  var MAX_EVENTS = 500;
  var INITIAL_WINDOW = 24 * 60 * 60 * 1000; // 24 hours
  var COLLAPSED_HEIGHT = 24;
  var EXPANDED_HEIGHT = 200;
  var baseBodyPaddingBottom = null;

  // ===== Build DOM =====
  function build() {
    var container = document.createElement('div');
    container.id = 'laintown-telemetry';
    container.className = 'collapsed';

    var header = document.createElement('div');
    header.id = 'lt-header';
    header.innerHTML =
      '<span id="lt-label">TELEMETRY</span>' +
      '<span id="lt-count"></span>' +
      '<span id="lt-toggle">[+]</span>';

    var feed = document.createElement('div');
    feed.id = 'lt-feed';

    container.appendChild(header);
    container.appendChild(feed);
    document.body.appendChild(container);

    header.addEventListener('click', toggle);

    feed.addEventListener('scroll', function () {
      if (!collapsed) {
        var el = feed;
        var atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
        userScrolled = !atBottom;
      }
    });

    return { container: container, feed: feed };
  }

  function reservePageSpace() {
    if (!document.body) return;
    if (baseBodyPaddingBottom === null) {
      var computed = window.getComputedStyle(document.body).paddingBottom;
      baseBodyPaddingBottom = parseFloat(computed) || 0;
    }
    var telemetryHeight = collapsed ? COLLAPSED_HEIGHT : EXPANDED_HEIGHT;
    document.body.style.paddingBottom = (baseBodyPaddingBottom + telemetryHeight) + 'px';
    document.body.classList.toggle('ltn-telemetry-expanded', !collapsed);
    document.body.classList.toggle('ltn-telemetry-collapsed', collapsed);
  }

  function toggle() {
    collapsed = !collapsed;
    var container = document.getElementById('laintown-telemetry');
    var toggleEl = document.getElementById('lt-toggle');
    if (collapsed) {
      container.className = 'collapsed';
      toggleEl.textContent = '[+]';
    } else {
      container.className = 'expanded';
      toggleEl.textContent = '[-]';
      userScrolled = false;
      scrollToBottom();
    }
    reservePageSpace();
  }

  function scrollToBottom() {
    var feed = document.getElementById('lt-feed');
    if (feed) feed.scrollTop = feed.scrollHeight;
  }

  // ===== Event type parsing (mirrors commune-map.js parseType) =====
  function parseType(sessionKey) {
    if (!sessionKey) return 'unknown';
    var prefix = sessionKey.split(':')[0];
    var map = {
      commune: 'commune', diary: 'diary', dream: 'dream',
      curiosity: 'curiosity', 'self-concept': 'self-concept',
      selfconcept: 'self-concept', narrative: 'narrative',
      letter: 'letter', wired: 'letter', web: 'chat',
      peer: 'peer', telegram: 'chat', alien: 'dream',
      bibliomancy: 'curiosity', dr: 'doctor', doctor: 'doctor',
      proactive: 'chat', movement: 'movement',
      move: 'move', note: 'note', document: 'document', gift: 'gift',
      research: 'research',
    };
    return map[prefix] || prefix;
  }

  // ===== Parse commune target from sessionKey =====
  function parseCommuneTarget(sessionKey) {
    // commune:wired-lain:pkd:timestamp → target is pkd
    if (!sessionKey) return '';
    var parts = sessionKey.split(':');
    if (parts.length >= 3 && parts[0] === 'commune') return parts[2];
    if (parts.length >= 3 && parts[0] === 'peer') return parts[2];
    return '';
  }

  function charNameById(id) {
    for (var i = 0; i < ENDPOINTS.length; i++) {
      if (ENDPOINTS[i].id === id) return ENDPOINTS[i].name;
    }
    return id;
  }

  function charColorById(id) {
    for (var i = 0; i < ENDPOINTS.length; i++) {
      if (ENDPOINTS[i].id === id) return ENDPOINTS[i].color;
    }
    return '#778';
  }

  // ===== Render =====
  function renderEntry(entry) {
    var el = document.createElement('div');
    el.className = 'lt-entry';

    var d = new Date(entry.timestamp);
    var time = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    var type = parseType(entry.sessionKey);
    var typeColor = TYPE_COLORS[type] || '#6090c0';
    var typeLabel = TYPE_LABELS[type] || type.toUpperCase();
    var charColor = entry._charColor || '#778';
    var charName = entry._charName || 'unknown';

    var fullContent = entry.content || '';
    var shortContent = fullContent.replace(/\n/g, ' ').slice(0, 120);

    // For commune/peer events, show target
    var target = parseCommuneTarget(entry.sessionKey);
    var charDisplay = charName;
    if (target && (type === 'commune' || type === 'peer')) {
      charDisplay = charName + ' \u2192 ' + charNameById(target);
    }

    // findings.md P2:2869 — every enum-style field here (typeLabel,
    // typeColor, charColor, charDisplay) is either from a whitelist
    // lookup or flows from a hardcoded ENDPOINTS list, but the
    // string-concatenation build was still latently injection-prone
    // (especially as the roster moves to /api/characters per P2:2759).
    // Rebuild via DOM so every dynamic field goes through textContent
    // or an individual style property.
    var timeSpan = document.createElement('span');
    timeSpan.className = 'lt-time';
    timeSpan.textContent = time;
    var typeSpan = document.createElement('span');
    typeSpan.className = 'lt-type';
    typeSpan.style.color = typeColor;
    typeSpan.textContent = typeLabel;
    var charSpan = document.createElement('span');
    charSpan.className = 'lt-char';
    charSpan.style.color = charColor;
    charSpan.textContent = charDisplay;
    var contentSpan = document.createElement('span');
    contentSpan.className = 'lt-content';
    contentSpan.textContent = shortContent;
    el.appendChild(timeSpan);
    el.appendChild(typeSpan);
    el.appendChild(charSpan);
    el.appendChild(document.createTextNode(' '));
    el.appendChild(contentSpan);

    el.addEventListener('click', function () {
      var isExpanded = el.classList.toggle('lt-expanded');
      contentSpan.textContent = isExpanded ? fullContent : shortContent;
    });

    return el;
  }

  function renderAll() {
    var feed = document.getElementById('lt-feed');
    if (!feed) return;
    feed.innerHTML = '';
    if (events.length === 0) {
      feed.innerHTML = '<div class="lt-empty">listening for town activity...</div>';
      return;
    }
    for (var i = 0; i < events.length; i++) {
      feed.appendChild(renderEntry(events[i]));
    }
    if (!userScrolled) scrollToBottom();
    updateCount();
  }

  function appendNew(newEntries) {
    var feed = document.getElementById('lt-feed');
    if (!feed) return;
    // Remove empty message if present
    var empty = feed.querySelector('.lt-empty');
    if (empty) empty.remove();

    for (var i = 0; i < newEntries.length; i++) {
      feed.appendChild(renderEntry(newEntries[i]));
    }
    if (!userScrolled) scrollToBottom();
    updateCount();
  }

  function updateCount() {
    var countEl = document.getElementById('lt-count');
    if (countEl) countEl.textContent = events.length + ' events';
  }

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ===== Fetch =====
  function fetchAll(fromTs, isInitial) {
    var now = Date.now();
    var from = fromTs || (now - INITIAL_WINDOW);
    var promises = [];

    for (var i = 0; i < ENDPOINTS.length; i++) {
      promises.push(fetchEndpoint(ENDPOINTS[i], from, now));
    }

    Promise.all(promises).then(function (results) {
      var newEntries = [];
      for (var i = 0; i < results.length; i++) {
        var entries = results[i];
        for (var j = 0; j < entries.length; j++) {
          var entry = entries[j];
          // Dedupe by row id alone — same DB row from multiple endpoints shows once
          var key = entry.id;
          if (!seenIds.has(key)) {
            seenIds.add(key);
            newEntries.push(entry);
          }
        }
      }

      if (newEntries.length === 0) return;

      // Sort new entries chronologically
      newEntries.sort(function (a, b) { return a.timestamp - b.timestamp; });

      // Append to main list
      events = events.concat(newEntries);

      // Trim if too many
      if (events.length > MAX_EVENTS) {
        var removed = events.splice(0, events.length - MAX_EVENTS);
        for (var k = 0; k < removed.length; k++) {
          seenIds.delete(removed[k].id);
        }
      }

      // Track latest timestamp
      var latest = newEntries[newEntries.length - 1].timestamp;
      if (latest > lastTimestamp) lastTimestamp = latest;

      if (isInitial) {
        renderAll();
      } else {
        appendNew(newEntries);
      }
    });
  }

  function fetchEndpoint(endpoint, from, to) {
    var url = endpoint.path + '?from=' + from + '&to=' + to + '&_t=' + Date.now();
    return fetch(url, { cache: 'no-store' })
      .then(function (resp) {
        if (!resp.ok) return [];
        var ct = resp.headers.get('content-type') || '';
        if (!ct.includes('json')) return [];
        return resp.json();
      })
      .then(function (entries) {
        if (!Array.isArray(entries)) return [];
        // Tag each entry with character info
        for (var i = 0; i < entries.length; i++) {
          entries[i]._charId = endpoint.id;
          entries[i]._charName = endpoint.name;
          entries[i]._charColor = endpoint.color;
        }
        return entries;
      })
      .catch(function () { return []; });
  }

  // ===== Poll loop =====
  // findings.md P2:3200 — `pagehide` clears the interval when the tab is
  // closed or swapped into the bfcache, `pageshow` restarts it on
  // restore. `visibilitychange` pauses polling while hidden so background
  // tabs don't burn network. Together they prevent the "long-lived tab
  // polls forever, bfcache'd pages leak timers" pattern the finding
  // describes.
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      var from = lastTimestamp > 0 ? lastTimestamp - 1000 : Date.now() - INITIAL_WINDOW;
      fetchAll(from, false);
    }, POLL_INTERVAL);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // ===== Init =====
  function init() {
    build();
    reservePageSpace();
    loadEndpoints().then(function () {
      fetchAll(null, true);
      startPolling();
    });
    window.addEventListener('visibilitychange', function () {
      if (document.hidden) stopPolling();
      else if (ENDPOINTS.length > 0) startPolling();
    });
    window.addEventListener('pagehide', stopPolling);
    window.addEventListener('pageshow', function (ev) {
      if (ev.persisted && ENDPOINTS.length > 0) startPolling();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
