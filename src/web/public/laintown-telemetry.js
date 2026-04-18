// Laintown telemetry console — unified real-time activity feed from all town inhabitants
(function () {
  'use strict';

  // ===== Character endpoints =====
  var ENDPOINTS = [
    { id: 'wired-lain', name: 'Wired Lain', color: '#4080ff', path: '/api/activity' },
    { id: 'lain', name: 'Lain', color: '#80c0ff', path: '/local/api/activity' },
    { id: 'pkd', name: 'PKD', color: '#c060ff', path: '/pkd/api/activity' },
    { id: 'mckenna', name: 'McKenna', color: '#40e080', path: '/mckenna/api/activity' },
    { id: 'john', name: 'John', color: '#ffb040', path: '/john/api/activity' },
    { id: 'hiru', name: 'Hiru', color: '#60d0a0', path: '/hiru/api/activity' },
  ];

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

  // ===== API key (from meta tag or URL ?key= param) =====
  var API_KEY = (function () {
    var meta = document.querySelector('meta[name="lain-api-key"]');
    if (meta && meta.content) return meta.content;
    return new URLSearchParams(window.location.search).get('key') || '';
  })();

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

  // ===== Inject styles =====
  var style = document.createElement('style');
  style.textContent =
    '#laintown-telemetry{position:fixed;bottom:0;left:0;right:0;z-index:99998;font-family:"Share Tech Mono",monospace;background:#08080d;border-top:1px solid #1a1a2e;transition:height .3s ease}' +
    '#laintown-telemetry.collapsed{height:24px}' +
    '#laintown-telemetry.expanded{height:200px}' +
    '#lt-header{height:24px;display:flex;align-items:center;padding:0 12px;cursor:pointer;user-select:none;background:#0a0a12;border-bottom:1px solid #111125}' +
    '#lt-header:hover{background:#0e0e18}' +
    '#lt-label{color:#4a9eff;font-size:10px;letter-spacing:2px;text-transform:uppercase}' +
    '#lt-count{color:#445;font-size:10px;margin-left:8px}' +
    '#lt-toggle{color:#445;font-size:10px;margin-left:auto}' +
    '#lt-feed{height:calc(100% - 24px);overflow-y:auto;overflow-x:hidden;padding:4px 0;scrollbar-width:thin;scrollbar-color:#1a1a2e #08080d}' +
    '#lt-feed::-webkit-scrollbar{width:6px}' +
    '#lt-feed::-webkit-scrollbar-track{background:#08080d}' +
    '#lt-feed::-webkit-scrollbar-thumb{background:#1a1a2e;border-radius:3px}' +
    '.lt-entry{padding:2px 12px;font-size:11px;line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#667;cursor:pointer}' +
    '.lt-entry:hover{background:#0c0c14;color:#889}' +
    '.lt-entry.lt-expanded{white-space:pre-wrap;word-break:break-word;overflow:visible;text-overflow:unset;padding:6px 12px;border-left:2px solid #1a1a2e;background:#0a0a12}' +
    '.lt-time{color:#445}' +
    '.lt-type{display:inline-block;width:72px;text-align:right;margin:0 8px}' +
    '.lt-char{display:inline-block;width:80px}' +
    '.lt-content{color:#778}' +
    '.lt-empty{color:#334;font-size:11px;padding:12px;text-align:center}';
  document.head.appendChild(style);

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

    var prefix =
      '<span class="lt-time">' + time + '</span>' +
      '<span class="lt-type" style="color:' + typeColor + '">' + typeLabel + '</span>' +
      '<span class="lt-char" style="color:' + charColor + '">' + escapeHtml(charDisplay) + '</span> ';

    el.innerHTML = prefix + '<span class="lt-content">' + escapeHtml(shortContent) + '</span>';

    el.addEventListener('click', function () {
      var isExpanded = el.classList.toggle('lt-expanded');
      var contentSpan = el.querySelector('.lt-content');
      if (contentSpan) {
        contentSpan.innerHTML = escapeHtml(isExpanded ? fullContent : shortContent);
      }
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
    var url = endpoint.path + '?from=' + from + '&to=' + to + '&_t=' + Date.now() +
      (API_KEY ? '&key=' + encodeURIComponent(API_KEY) : '');
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
  function startPolling() {
    pollTimer = setInterval(function () {
      // Fetch events since last known timestamp (with 1s overlap for safety)
      var from = lastTimestamp > 0 ? lastTimestamp - 1000 : Date.now() - INITIAL_WINDOW;
      fetchAll(from, false);
    }, POLL_INTERVAL);
  }

  // ===== Init =====
  function init() {
    build();
    fetchAll(null, true);
    startPolling();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
