/* Commune Map — Live character activity dashboard */

(function () {
  'use strict';

  // ===== Skin helpers =====
  function getCSSVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function getCharacterColors() {
    return [
      { id: 'neo',   name: 'Neo',   color: getCSSVar('--color-neo')   || '#60e0a0', ssePath: '/neo/api/events', activityPath: '/neo/api/activity', locationPath: '/neo/api/location', chatPath: '/neo/api/chat/stream' },
      { id: 'plato', name: 'Plato', color: getCSSVar('--color-plato') || '#e0c870', ssePath: '/plato/api/events', activityPath: '/plato/api/activity', locationPath: '/plato/api/location', chatPath: '/plato/api/chat/stream' },
      { id: 'joe',   name: 'Joe',   color: getCSSVar('--color-joe')   || '#88b0d0', ssePath: '/joe/api/events', activityPath: '/joe/api/activity', locationPath: '/joe/api/location', chatPath: '/joe/api/chat/stream' },
      { id: 'cage',  name: 'Nicolas Cage', color: getCSSVar('--color-cage') || '#ff9f43', ssePath: '/cage/api/events', activityPath: '/cage/api/activity', locationPath: '/cage/api/location', chatPath: '/cage/api/chat/stream' },
    ];
  }

  function getTypeColors() {
    return {
      diary:          getCSSVar('--type-diary')         || '#e0a020',
      dream:          getCSSVar('--type-dream')         || '#a040e0',
      commune:        getCSSVar('--type-commune')       || '#40d0e0',
      curiosity:      getCSSVar('--type-curiosity')     || '#40c060',
      chat:           getCSSVar('--type-chat')          || '#c0d0e0',
      memory:         getCSSVar('--type-memory')        || '#4080e0',
      letter:         getCSSVar('--type-letter')        || '#e060a0',
      narrative:      getCSSVar('--type-narrative')     || '#e08030',
      'self-concept': getCSSVar('--type-self-concept')  || '#8080e0',
      doctor:         getCSSVar('--type-doctor')        || '#ff6060',
      peer:           getCSSVar('--type-peer')          || '#60c0c0',
      movement:       getCSSVar('--type-movement')      || '#e0d040',
      move:           getCSSVar('--type-movement')      || '#e0d040',
      note:           getCSSVar('--type-chat')          || '#c0a060',
      document:       getCSSVar('--type-chat')          || '#a0c0e0',
      gift:           getCSSVar('--type-letter')        || '#e080c0',
    };
  }

  function getBuildingIcons() {
    const manifest = window.LaintownSkins?.getSkinManifest();
    if (manifest?.buildingIcons) return manifest.buildingIcons;
    return {
      pub: '🍺',
      station: '🚉',
      'abandoned-house': '🏚',
      field: '🌾',
      windmill: '🌬',
      locksmith: '🔐',
      'mystery-tower': '🗼',
      theater: '🎭',
      square: '⬜',
    };
  }

  // ===== Building definitions (mirrors backend) =====
  const BUILDING_META = [
    { id: 'pub',             name: 'Pub',             row: 0, col: 0 },
    { id: 'station',         name: 'Station',         row: 0, col: 1 },
    { id: 'abandoned-house', name: 'Abandoned House', row: 0, col: 2 },
    { id: 'field',           name: 'Field',           row: 1, col: 0 },
    { id: 'windmill',        name: 'Windmill',        row: 1, col: 1 },
    { id: 'locksmith',       name: 'Locksmith',       row: 1, col: 2 },
    { id: 'mystery-tower',   name: 'Mystery Tower',   row: 2, col: 0 },
    { id: 'theater',         name: 'Theater',         row: 2, col: 1 },
    { id: 'square',          name: 'Square',          row: 2, col: 2 },
  ];

  function getBuildings() {
    const icons = {
      ...getBuildingIcons(),
      pub: '🍺',
      station: '🚉',
      'abandoned-house': '🏚',
      field: '🌾',
      windmill: '🌬',
      locksmith: '🔐',
      'mystery-tower': '🗼',
      theater: '🎭',
      square: '⬜',
    };
    return BUILDING_META.map((b) => ({ ...b, emoji: icons[b.id] || '' }));
  }

  // Mutable references — refreshed on skin change
  let BUILDINGS = getBuildings();
  let CHARACTERS = getCharacterColors();
  let TYPE_COLORS = getTypeColors();

  // Default locations (fallback if API unreachable)
  const DEFAULT_LOCATIONS = {
    neo: 'station',
    plato: 'mystery-tower',
    joe: 'square',
    cage: 'theater',
  };

  // ===== State =====
  const IS_OWNER = document.querySelector('meta[name="lain-owner"]')?.content === 'true';
  let totalEvents = 0;
  let selectedCharId = null;
  let selectedRange = 604800000; // 7d
  const eventSources = new Map();
  const charEventCounts = {};
  const charLastType = {};
  const charLocations = {}; // charId -> buildingId
  const logEntries = [];
  const MAX_LOG = 100;
  const MAX_NOTIFICATIONS = 20;
  let notifCount = 0;
  let currentView = 'town'; // 'town' or 'network'

  // Force-directed layout state
  const nodePositions = {}; // charId -> {x, y, vx, vy}
  let relationshipEdges = []; // [{source, target, weight}]
  let simRunning = false;
  let simIterations = 0;
  const SIM_MAX = 300;

  function initPositions() {
    var n = CHARACTERS.length;
    CHARACTERS.forEach(function (c, i) {
      var angle = (2 * Math.PI * i) / n;
      nodePositions[c.id] = { x: 50 + 25 * Math.cos(angle), y: 50 + 25 * Math.sin(angle), vx: 0, vy: 0 };
    });
  }
  initPositions();

  function startSimulation() {
    simIterations = 0;
    for (var id in nodePositions) { nodePositions[id].vx = 0; nodePositions[id].vy = 0; }
    if (!simRunning) { simRunning = true; requestAnimationFrame(simulationStep); }
  }

  function simulationStep() {
    if (!simRunning || simIterations > SIM_MAX) { simRunning = false; return; }
    simIterations++;
    var alpha = Math.max(0.01, 1 - simIterations / SIM_MAX);

    // Repulsion between all pairs
    for (var i = 0; i < CHARACTERS.length; i++) {
      for (var j = i + 1; j < CHARACTERS.length; j++) {
        var a = nodePositions[CHARACTERS[i].id], b = nodePositions[CHARACTERS[j].id];
        var dx = a.x - b.x, dy = a.y - b.y;
        var dist = Math.sqrt(dx * dx + dy * dy) || 0.1;
        var force = Math.min((600 / (dist * dist)) * alpha, 4);
        a.vx += (dx / dist) * force; a.vy += (dy / dist) * force;
        b.vx -= (dx / dist) * force; b.vy -= (dy / dist) * force;
      }
    }

    // Attraction along edges
    for (var e = 0; e < relationshipEdges.length; e++) {
      var edge = relationshipEdges[e];
      var ea = nodePositions[edge.source], eb = nodePositions[edge.target];
      if (!ea || !eb) continue;
      var edx = eb.x - ea.x, edy = eb.y - ea.y;
      var edist = Math.sqrt(edx * edx + edy * edy) || 0.1;
      var ideal = 30 - 18 * edge.weight; // weight=1 -> close (12%), weight=0 -> far (30%)
      ideal = Math.max(10, ideal);
      var eforce = (edist - ideal) * 0.04 * edge.weight * alpha;
      ea.vx += (edx / edist) * eforce; ea.vy += (edy / edist) * eforce;
      eb.vx -= (edx / edist) * eforce; eb.vy -= (edy / edist) * eforce;
    }

    // Center gravity
    for (var ci = 0; ci < CHARACTERS.length; ci++) {
      var p = nodePositions[CHARACTERS[ci].id];
      p.vx += (50 - p.x) * 0.008 * alpha;
      p.vy += (50 - p.y) * 0.008 * alpha;
    }

    // Apply velocity, damp, clamp
    for (var ui = 0; ui < CHARACTERS.length; ui++) {
      var np = nodePositions[CHARACTERS[ui].id];
      np.vx *= 0.92; np.vy *= 0.92;
      np.x += np.vx; np.y += np.vy;
      np.x = Math.max(10, Math.min(90, np.x));
      np.y = Math.max(10, Math.min(90, np.y));
    }

    updateNodePositions();
    drawConnections();
    requestAnimationFrame(simulationStep);
  }

  function updateNodePositions() {
    for (var i = 0; i < CHARACTERS.length; i++) {
      var c = CHARACTERS[i], p = nodePositions[c.id];
      var node = document.querySelector('.char-node[data-id="' + c.id + '"]');
      if (node) { node.style.left = p.x + '%'; node.style.top = p.y + '%'; }
    }
  }

  async function fetchRelationships() {
    try {
      var resp = await fetch('/api/relationships');
      if (!resp.ok) return;
      var data = await resp.json();
      relationshipEdges = data.edges || [];
      startSimulation();
    } catch { /* ignore */ }
  }

  // Chat state
  let chatCharId = null;
  let chatAbortController = null;
  const chatSessions = {}; // charId -> sessionId (persisted to localStorage)
  const chatHistories = {}; // charId -> [{role, text}] (ephemeral)

  // ===== DOM refs =====
  const townGrid = document.getElementById('town-grid');
  const nodeMap = document.getElementById('node-map');
  const svgLines = document.getElementById('connection-lines');
  const notifContainer = document.getElementById('notifications');
  const panelTitle = document.getElementById('panel-title');
  const panelBody = document.getElementById('panel-body');
  const timeControls = document.getElementById('time-controls');
  const logBody = document.getElementById('log-body');
  const eventCountEl = document.getElementById('event-count');
  const statusEl = document.getElementById('connection-status');
  const statusDot = document.querySelector('.status-dot');
  const logToggle = document.getElementById('log-toggle');
  const eventLog = document.getElementById('event-log');
  const chatModal = document.getElementById('chat-modal');
  const chatModalTitle = document.getElementById('chat-modal-title');
  const chatModalMessages = document.getElementById('chat-modal-messages');
  const chatModalForm = document.getElementById('chat-modal-form');
  const chatModalInput = document.getElementById('chat-modal-input');
  const chatModalClose = document.getElementById('chat-modal-close');

  // ===== Init =====
  function init() {
    createTownGrid();
    createNodes();
    drawConnections();
    bindTimeControls();
    bindLogToggle();
    bindViewToggle();
    bindChat();
    // Skip SSE connections — they consume all 6 HTTP/1.1 slots per host,
    // blocking activity fetches. Activity loads on-demand instead.
    fetchAllLocations();
    fetchRelationships();
    setInterval(fetchRelationships, 3 * 60 * 1000);
    window.addEventListener('resize', drawConnections);
    updateConnectionStatus(0);
  }

  // ===== Town Grid =====
  function createTownGrid() {
    for (const building of BUILDINGS) {
      const cell = document.createElement('div');
      cell.className = 'building-cell';
      cell.dataset.building = building.id;
      cell.innerHTML =
        `<div class="building-icon">${building.emoji}</div>` +
        `<div class="building-name">${building.name}</div>` +
        `<div class="building-residents" id="residents-${building.id}"></div>`;

      // Click building background → select first resident for activity panel
      cell.addEventListener('click', () => {
        const resident = CHARACTERS.find((c) => charLocations[c.id] === building.id);
        if (resident) selectCharacter(resident.id);
      });

      townGrid.appendChild(cell);
    }
  }

  function fetchAllLocations() {
    // Initialize with defaults
    for (const char of CHARACTERS) {
      charLocations[char.id] = DEFAULT_LOCATIONS[char.id] || 'square';
    }
    renderResidents();

    // Fetch actual locations from each character's server
    for (const char of CHARACTERS) {
      fetch(char.locationPath)
        .then((resp) => {
          if (!resp.ok) throw new Error(resp.status);
          return resp.json();
        })
        .then((data) => {
          if (data && data.location) {
            charLocations[char.id] = data.location;
            renderResidents();
          }
        })
        .catch(() => {
          // Keep default location
        });
    }
  }

  function renderResidents() {
    // Clear all resident containers
    for (const building of BUILDINGS) {
      const container = document.getElementById('residents-' + building.id);
      if (container) container.innerHTML = '';
    }

    // Place characters in their buildings
    for (const char of CHARACTERS) {
      const buildingId = charLocations[char.id];
      if (!buildingId) continue;

      const container = document.getElementById('residents-' + buildingId);
      if (!container) continue;

      const dot = document.createElement('div');
      dot.className = 'resident-dot';
      dot.style.setProperty('--dot-color', char.color);
      dot.title = char.name;

      const name = document.createElement('div');
      name.className = 'resident-name';
      name.textContent = char.name;

      const wrapper = document.createElement('div');
      wrapper.className = 'resident-wrapper';
      wrapper.title = char.name;
      wrapper.addEventListener('click', (e) => {
        e.stopPropagation();
        openChat(char.id);
      });
      wrapper.appendChild(dot);
      wrapper.appendChild(name);

      container.appendChild(wrapper);
    }
  }

  function animateMovement(char, fromId, toId) {
    // Flash the destination cell
    const destCell = document.querySelector(`.building-cell[data-building="${toId}"]`);
    if (destCell) {
      destCell.classList.add('arrival');
      setTimeout(() => destCell.classList.remove('arrival'), 1500);
    }

    // Create a town-level notification if in town view
    if (currentView === 'town') {
      const fromBuilding = BUILDINGS.find((b) => b.id === fromId);
      const toBuilding = BUILDINGS.find((b) => b.id === toId);
      if (fromBuilding && toBuilding) {
        const el = document.createElement('div');
        el.className = 'town-notif';
        el.innerHTML = `<span style="color:${char.color}">${char.name}</span> moved to ${toBuilding.name}`;
        townGrid.appendChild(el);
        el.addEventListener('animationend', () => el.remove());
      }
    }
  }

  // ===== View Toggle =====
  function bindViewToggle() {
    const buttons = document.querySelectorAll('.view-btn');
    for (const btn of buttons) {
      btn.addEventListener('click', () => {
        buttons.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        currentView = btn.dataset.view;

        if (currentView === 'town') {
          townGrid.style.display = '';
          nodeMap.style.display = 'none';
        } else {
          townGrid.style.display = 'none';
          nodeMap.style.display = '';
          drawConnections();
          if (relationshipEdges.length > 0) startSimulation();
        }
      });
    }

    // Auto-switch to network view if #network hash is present
    function checkHash() {
      if (location.hash === '#network') {
        const netBtn = document.querySelector('.view-btn[data-view="network"]');
        if (netBtn) netBtn.click();
      }
    }
    checkHash();
    window.addEventListener('hashchange', checkHash);
  }

  // ===== Create character nodes (network view) =====
  function createNodes() {
    for (const char of CHARACTERS) {
      charEventCounts[char.id] = 0;
      charLastType[char.id] = '';

      const node = document.createElement('div');
      node.className = 'char-node';
      node.dataset.id = char.id;
      const pos = nodePositions[char.id];
      node.style.left = pos.x + '%';
      node.style.top = pos.y + '%';
      node.style.setProperty('--node-color', char.color);

      node.innerHTML = `
        <div class="node-orb" id="orb-${char.id}"></div>
        <div class="node-name">${char.name}</div>
        <div class="node-info" id="info-${char.id}">...</div>
      `;

      node.addEventListener('click', () => selectCharacter(char.id));
      nodeMap.appendChild(node);
    }
  }

  // ===== Draw connection lines between nodes =====
  function drawConnections() {
    svgLines.innerHTML = '';
    var rect = nodeMap.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    for (var i = 0; i < relationshipEdges.length; i++) {
      var edge = relationshipEdges[i];
      var pa = nodePositions[edge.source], pb = nodePositions[edge.target];
      if (!pa || !pb) continue;

      var line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', (pa.x / 100) * rect.width);
      line.setAttribute('y1', (pa.y / 100) * rect.height);
      line.setAttribute('x2', (pb.x / 100) * rect.width);
      line.setAttribute('y2', (pb.y / 100) * rect.height);
      line.id = 'line-' + edge.source + '-' + edge.target;
      line.style.opacity = 0.15 + 0.7 * edge.weight;
      line.style.strokeWidth = (0.5 + 2.5 * edge.weight) + 'px';
      svgLines.appendChild(line);
    }
  }

  // ===== SSE connections =====
  function connectAll() {
    let connectedCount = 0;

    for (const char of CHARACTERS) {
      connectSSE(char, () => {
        connectedCount++;
        updateConnectionStatus(connectedCount);
      });
    }
  }

  function connectSSE(char, onOpen) {
    const url = char.ssePath;
    let retryDelay = 1000;

    function connect() {
      const es = new EventSource(url);
      eventSources.set(char.id, es);

      es.onopen = () => {
        retryDelay = 1000;
        if (onOpen) {
          onOpen();
          onOpen = null; // only call once
        }
      };

      es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data);
          handleEvent(char, event);
        } catch {
          // ignore parse errors
        }
      };

      es.onerror = () => {
        es.close();
        eventSources.delete(char.id);
        // Exponential backoff
        setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30000);
      };
    }

    connect();
  }

  function updateConnectionStatus(count) {
    if (count === 0) {
      statusEl.textContent = 'polling mode';
      statusDot.classList.add('connected');
    } else {
      statusEl.textContent = count + '/' + CHARACTERS.length + ' connected';
      if (count === CHARACTERS.length) {
        statusDot.classList.add('connected');
      }
    }
  }

  // ===== Handle incoming event =====
  function handleEvent(char, event) {
    totalEvents++;
    eventCountEl.textContent = totalEvents;
    charEventCounts[char.id] = (charEventCounts[char.id] || 0) + 1;
    charLastType[char.id] = event.type || '';

    // Update node UI
    const infoEl = document.getElementById('info-' + char.id);
    if (infoEl) infoEl.textContent = event.type || '...';

    // Pulse orb
    const orb = document.getElementById('orb-' + char.id);
    if (orb) {
      orb.classList.remove('pulse');
      void orb.offsetWidth; // reflow
      orb.classList.add('pulse');
    }

    // Flash connection lines involving this character
    flashLines(char.id);

    // Handle movement events
    if (event.type === 'movement') {
      const key = event.sessionKey || '';
      const parts = key.split(':');
      // sessionKey format: movement:<from>:<to>
      if (parts.length >= 3) {
        const fromId = parts[1];
        const toId = parts[2];
        charLocations[char.id] = toId;
        animateMovement(char, fromId, toId);
        renderResidents();
      }
    }

    // Floating notification (only in network view)
    if (currentView === 'network') {
      createNotification(char, event);
    }

    // Log entry
    addLogEntry(char, event);
  }

  // ===== Flash connection lines =====
  function flashLines(charId) {
    const lines = svgLines.querySelectorAll('line');
    for (const line of lines) {
      if (line.id.includes(charId)) {
        line.classList.add('active');
        setTimeout(() => line.classList.remove('active'), 1500);
      }
    }
  }

  // ===== Floating notifications =====
  function createNotification(char, event) {
    if (notifCount >= MAX_NOTIFICATIONS) return;

    const el = document.createElement('div');
    el.className = 'float-notif';

    const snippet = (event.content || '').slice(0, 60);
    const typeColor = TYPE_COLORS[event.type] || '#6090c0';
    el.innerHTML = `<span style="color:${char.color}">${char.name}</span> <span style="color:${typeColor}">${event.type}</span>: ${snippet}`;

    // Position near the character node
    const rect = nodeMap.getBoundingClientRect();
    const pos = nodePositions[char.id] || { x: 50, y: 50 };
    const cx = (pos.x / 100) * rect.width;
    const cy = (pos.y / 100) * rect.height;
    // Offset randomly so they don't stack
    const ox = (Math.random() - 0.5) * 120;
    const oy = -30 + Math.random() * -20;
    el.style.left = Math.max(10, Math.min(rect.width - 200, cx + ox)) + 'px';
    el.style.top = Math.max(20, cy + oy) + 'px';

    notifContainer.appendChild(el);
    notifCount++;

    el.addEventListener('animationend', () => {
      el.remove();
      notifCount--;
    });
  }

  // ===== Event log =====
  function addLogEntry(char, event) {
    const now = new Date(event.timestamp || Date.now());
    const time = now.toTimeString().slice(0, 5);
    const typeColor = TYPE_COLORS[event.type] || '#6090c0';
    const snippet = (event.content || '').slice(0, 80);

    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.innerHTML =
      `<span class="log-time">${time}</span> ` +
      `<span class="log-char" style="color:${char.color}">${char.id}</span> | ` +
      `<span class="log-type" style="color:${typeColor}">${event.type}</span> | ` +
      snippet;

    logBody.insertBefore(entry, logBody.firstChild);

    logEntries.unshift(entry);
    if (logEntries.length > MAX_LOG) {
      const old = logEntries.pop();
      if (old && old.parentNode) old.remove();
    }
  }

  function bindLogToggle() {
    logToggle.addEventListener('click', () => {
      eventLog.classList.toggle('collapsed');
    });
  }

  // ===== Activity panel =====
  function selectCharacter(charId) {
    selectedCharId = charId;
    const char = CHARACTERS.find((c) => c.id === charId);
    if (!char) return;

    // Update node selection UI
    document.querySelectorAll('.char-node').forEach((n) => n.classList.remove('selected'));
    const node = document.querySelector(`.char-node[data-id="${charId}"]`);
    if (node) node.classList.add('selected');

    panelTitle.textContent = char.name;
    panelTitle.style.color = char.color;
    timeControls.style.display = 'flex';

    loadActivity(char);
  }

  async function loadActivity(char) {
    panelBody.innerHTML = '<div class="loading">loading...</div>';

    const now = Date.now();
    const from = now - selectedRange;
    const url = char.activityPath + '?from=' + from + '&to=' + now +
      '&_t=' + now;

    try {
      const resp = await fetch(url, { cache: 'no-store' });
      if (!resp.ok) {
        panelBody.innerHTML = '<div class="panel-placeholder">failed to load (' + resp.status + ')</div>';
        return;
      }
      const ct = resp.headers.get('content-type') || '';
      if (!ct.includes('json')) {
        panelBody.innerHTML = '<div class="panel-placeholder">wrong response type: ' + escapeHtml(ct) + '</div>';
        return;
      }
      const entries = await resp.json();
      renderActivity(entries);
    } catch (err) {
      console.error('Activity load error for ' + char.id + ':', err);
      panelBody.innerHTML = '<div class="panel-placeholder">error: ' + escapeHtml(String(err && err.message || err)) + '</div>';
    }
  }

  function renderActivity(entries) {
    if (!entries || entries.length === 0) {
      panelBody.innerHTML = '<div class="panel-placeholder">no activity in this period</div>';
      return;
    }

    panelBody.innerHTML = '';

    for (const entry of entries) {
      const el = document.createElement('div');
      el.className = 'activity-entry';

      const sessionKey = entry.sessionKey || '';
      const type = parseType(sessionKey);
      const typeColor = TYPE_COLORS[type] || '#6090c0';
      el.style.setProperty('--entry-color', typeColor);

      const time = formatTime(entry.timestamp);
      const fullContent = entry.content || '';

      el.innerHTML =
        `<div class="entry-header">` +
        `<span class="entry-type" style="color:${typeColor}">${type}</span>` +
        `<span class="entry-kind">${entry.kind}</span>` +
        `<span class="entry-time">${time}</span>` +
        `</div>` +
        `<div class="entry-content">${escapeHtml(fullContent)}</div>`;

      if (fullContent.length > 150) {
        el.style.cursor = 'pointer';
        el.addEventListener('click', () => {
          el.classList.toggle('expanded');
        });
      }

      panelBody.appendChild(el);
    }
  }

  function parseType(sessionKey) {
    if (!sessionKey) return 'unknown';
    const prefix = sessionKey.split(':')[0];
    const map = {
      commune: 'commune', diary: 'diary', dream: 'dream',
      curiosity: 'curiosity', 'self-concept': 'self-concept',
      selfconcept: 'self-concept', narrative: 'narrative',
      letter: 'letter', wired: 'letter', web: 'chat',
      peer: 'peer', telegram: 'chat', alien: 'dream',
      bibliomancy: 'curiosity', dr: 'doctor', doctor: 'doctor',
      proactive: 'chat', movement: 'movement',
      move: 'move', note: 'note', document: 'document', gift: 'gift',
    };
    return map[prefix] || prefix;
  }

  function formatTime(ts) {
    const d = new Date(ts);
    const now = new Date();
    const diff = now - d;

    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';

    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
      ' ' + d.toTimeString().slice(0, 5);
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ===== Time controls =====
  function bindTimeControls() {
    const buttons = timeControls.querySelectorAll('.time-btn');
    for (const btn of buttons) {
      btn.addEventListener('click', () => {
        buttons.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        selectedRange = parseInt(btn.dataset.range, 10);
        if (selectedCharId) {
          const char = CHARACTERS.find((c) => c.id === selectedCharId);
          if (char) loadActivity(char);
        }
      });
    }
  }

  // ===== Chat modal =====
  function bindChat() {
    chatModalClose.addEventListener('click', closeChat);
    chatModalForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = chatModalInput.value.trim();
      if (!text) return;
      chatModalInput.value = '';
      sendStrangerMessage(text);
    });
  }

  // Canned phrases for spectator mode — each character has their own voice
  const CANNED_PHRASES = {
    neo: [
      '...someone is watching. all right. keep watching.',
      'if this place is a system, it still leaves traces. you can learn a lot by standing still.',
      'read-only, huh. maybe that keeps things honest.',
      'the station changes people. they just don\'t notice it while it\'s happening.',
    ],
    plato: [
      'an observer is already part of the arrangement, whether he speaks or not.',
      'you are seeing appearances. that is not nothing, but it is not the whole of it either.',
      'the square makes more sense when watched from a little distance.',
      'even silence can be a kind of dialogue.',
    ],
    joe: [
      'if you\'re just looking around, that\'s probably the smartest way to start.',
      'can\'t hear you from here, but honestly that may save us both some trouble.',
      'it\'s a normal town. mostly. depending on how much you listen to the others.',
      'read-only works for me. less pressure.',
    ],
    cage: [
      'the room is quiet, but quiet is never empty. it is waiting for a choice.',
      'i can feel the theater breathing from here. that may be architecture, or it may be destiny wearing a coat.',
      'observe closely. sometimes the smallest gesture is where the whole scene turns.',
      'read-only is a kind of vow. you witness, and the witnessing changes the air.',
    ],
  };

  function getRandomCannedPhrase(charId) {
    const phrases = CANNED_PHRASES[charId] || ['...'];
    return phrases[Math.floor(Math.random() * phrases.length)];
  }

  function openChat(charId) {
    chatCharId = charId;
    const char = CHARACTERS.find((c) => c.id === charId);
    if (!char) return;

    // Also select character in activity panel
    selectCharacter(charId);

    chatModalTitle.textContent = char.name;
    chatModalTitle.style.color = char.color;
    chatModal.style.display = 'flex';

    // Spectator mode — show canned phrase, hide input
    if (!IS_OWNER) {
      chatModalMessages.innerHTML = '';
      chatModalInput.style.display = 'none';
      const submitBtn = chatModalForm.querySelector('button[type="submit"]');
      if (submitBtn) submitBtn.style.display = 'none';
      addChatMessage('character', getRandomCannedPhrase(charId), char.color);
      return;
    }

    // Restore session from localStorage
    const storedSession = localStorage.getItem('stranger-session-' + charId);
    if (storedSession) {
      chatSessions[charId] = storedSession;
    }

    // Render existing in-memory history
    chatModalMessages.innerHTML = '';
    const history = chatHistories[charId];
    if (history && history.length > 0) {
      for (const msg of history) {
        addChatMessage(msg.role, msg.text, char.color);
      }
    }

    chatModalInput.focus();
  }

  function closeChat() {
    chatModal.style.display = 'none';
    chatCharId = null;
    if (chatAbortController) {
      chatAbortController.abort();
      chatAbortController = null;
    }
  }

  function addChatMessage(role, text, charColor) {
    const el = document.createElement('div');
    if (role === 'stranger') {
      el.className = 'chat-msg stranger';
      el.textContent = text;
    } else {
      el.className = 'chat-msg character';
      el.style.setProperty('--char-color', charColor);
      const char = CHARACTERS.find((c) => c.id === chatCharId);
      const label = document.createElement('div');
      label.className = 'char-label';
      label.textContent = char ? char.name : 'character';
      const msgText = document.createElement('div');
      msgText.className = 'msg-text';
      msgText.textContent = text;
      el.appendChild(label);
      el.appendChild(msgText);
    }
    chatModalMessages.appendChild(el);
    chatModalMessages.scrollTop = chatModalMessages.scrollHeight;
    return el;
  }

  function createStreamingBubble(charColor) {
    const el = document.createElement('div');
    el.className = 'chat-msg character streaming';
    el.style.setProperty('--char-color', charColor);
    const char = CHARACTERS.find((c) => c.id === chatCharId);
    const label = document.createElement('div');
    label.className = 'char-label';
    label.textContent = char ? char.name : 'character';
    const msgText = document.createElement('div');
    msgText.className = 'msg-text';
    msgText.textContent = '';
    el.appendChild(label);
    el.appendChild(msgText);
    chatModalMessages.appendChild(el);
    chatModalMessages.scrollTop = chatModalMessages.scrollHeight;
    return { el, msgText };
  }

  async function sendStrangerMessage(text) {
    if (!IS_OWNER) return; // Spectator mode — no sending
    const charId = chatCharId;
    const char = CHARACTERS.find((c) => c.id === charId);
    if (!char) return;

    // Init history
    if (!chatHistories[charId]) chatHistories[charId] = [];
    chatHistories[charId].push({ role: 'stranger', text });

    // Render user message
    addChatMessage('stranger', text, char.color);

    // Disable input while streaming
    const submitBtn = chatModalForm.querySelector('button');
    chatModalInput.disabled = true;
    submitBtn.disabled = true;

    // Create streaming bubble
    const { el: bubble, msgText } = createStreamingBubble(char.color);
    let fullText = '';

    // Abort previous if any
    if (chatAbortController) chatAbortController.abort();
    chatAbortController = new AbortController();

    try {
      const sessionId = chatSessions[charId] || null;
      const payload = { message: text, stranger: true };
      if (sessionId) payload.sessionId = sessionId;

      const resp = await fetch(char.chatPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: chatAbortController.signal,
      });

      if (!resp.ok) {
        throw new Error('HTTP ' + resp.status);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.slice(6);
          try {
            const event = JSON.parse(jsonStr);
            if (event.type === 'session') {
              chatSessions[charId] = event.sessionId;
              localStorage.setItem('stranger-session-' + charId, event.sessionId);
            } else if (event.type === 'chunk') {
              fullText += event.content;
              msgText.textContent = fullText;
              chatModalMessages.scrollTop = chatModalMessages.scrollHeight;
            } else if (event.type === 'done') {
              // streaming complete
            } else if (event.type === 'error') {
              fullText += '\n[error: ' + (event.message || 'unknown') + ']';
              msgText.textContent = fullText;
            }
          } catch {
            // ignore parse errors
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        fullText = fullText || '[connection error]';
        msgText.textContent = fullText;
      }
    }

    // Finalize
    bubble.classList.remove('streaming');
    if (fullText && charId === chatCharId) {
      chatHistories[charId].push({ role: 'character', text: fullText });
    }
    chatModalInput.disabled = false;
    submitBtn.disabled = false;
    if (charId === chatCharId) chatModalInput.focus();
    chatAbortController = null;
  }

  // ===== Skin change listener =====
  document.addEventListener('skin-changed', () => {
    // Re-read all skin-driven values
    BUILDINGS = getBuildings();
    CHARACTERS = getCharacterColors();
    TYPE_COLORS = getTypeColors();

    // Re-render town grid and network nodes with updated colors/icons
    if (townGrid) {
      townGrid.innerHTML = '';
      createTownGrid();
      renderResidents();
    }

    if (nodeMap) {
      // Remove existing nodes (keep the SVG overlay)
      nodeMap.querySelectorAll('.char-node').forEach((n) => n.remove());
      createNodes();
      drawConnections();
    }

    // Update any currently-selected character's panel title color
    if (selectedCharId) {
      const char = CHARACTERS.find((c) => c.id === selectedCharId);
      if (char) {
        panelTitle.style.color = char.color;
      }
    }
  });

  // ===== Start =====
  init();
})();
