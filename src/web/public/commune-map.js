/* Commune Map - Live character activity dashboard */

(function () {
  'use strict';

  // ===== Building definitions (mirrors backend) =====
  const BUILDINGS = [
    { id: 'pub',             name: 'Pub',             emoji: '\ud83c\udf7a', row: 0, col: 0 },
    { id: 'station',         name: 'Station',         emoji: '\ud83d\ude89', row: 0, col: 1 },
    { id: 'abandoned-house', name: 'Abandoned House', emoji: '\ud83c\udfda\ufe0f', row: 0, col: 2 },
    { id: 'field',           name: 'Field',           emoji: '\ud83c\udf3e', row: 1, col: 0 },
    { id: 'windmill',        name: 'Windmill',        emoji: '\ud83c\udff5', row: 1, col: 1 },
    { id: 'locksmith',       name: 'Locksmith',       emoji: '\ud83d\udd10', row: 1, col: 2 },
    { id: 'mystery-tower',   name: 'Mystery Tower',   emoji: '\ud83d\uddfc', row: 2, col: 0 },
    { id: 'theater',         name: 'Theater',         emoji: '\ud83c\udfad', row: 2, col: 1 },
    { id: 'square',          name: 'Square',          emoji: '\u2b1c', row: 2, col: 2 },
  ];

  // ===== Character config =====
  const CHARACTERS = [
    {
      id: 'neo',
      name: 'Neo',
      color: '#60e0a0',
      x: 50,
      y: 20,
      ssePath: '/neo/api/events',
      activityPath: '/neo/api/activity',
      locationPath: '/neo/api/location',
      chatPath: '/neo/api/chat/stream',
    },
    {
      id: 'plato',
      name: 'Plato',
      color: '#e0c870',
      x: 25,
      y: 75,
      ssePath: '/plato/api/events',
      activityPath: '/plato/api/activity',
      locationPath: '/plato/api/location',
      chatPath: '/plato/api/chat/stream',
    },
    {
      id: 'joe',
      name: 'Joe',
      color: '#88b0d0',
      x: 75,
      y: 75,
      ssePath: '/joe/api/events',
      activityPath: '/joe/api/activity',
      locationPath: '/joe/api/location',
      chatPath: '/joe/api/chat/stream',
    },
  ];

  const TYPE_COLORS = {
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
  };

  // Default locations (fallback if API unreachable)
  const DEFAULT_LOCATIONS = {
    neo: 'station',
    plato: 'mystery-tower',
    joe: 'square',
  };

  // ===== State =====
  const API_KEY = new URLSearchParams(window.location.search).get('key') || '';
  let totalEvents = 0;
  let selectedCharId = null;
  let selectedRange = 604800000; // 7d
  const eventSources = new Map();
  const charEventCounts = {};
  const charLastType = {};
  const charLocations = {};
  const logEntries = [];
  const MAX_LOG = 100;
  const MAX_NOTIFICATIONS = 20;
  let notifCount = 0;
  let currentView = 'town';

  // Chat state
  let chatCharId = null;
  let chatAbortController = null;
  const chatSessions = {};
  const chatHistories = {};

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
    fetchAllLocations();
    connectAll();
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

      cell.addEventListener('click', () => {
        const resident = CHARACTERS.find((c) => charLocations[c.id] === building.id);
        if (resident) selectCharacter(resident.id);
      });

      townGrid.appendChild(cell);
    }
  }

  function fetchAllLocations() {
    for (const char of CHARACTERS) {
      charLocations[char.id] = DEFAULT_LOCATIONS[char.id] || 'square';
    }
    renderResidents();

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
          // Keep default location.
        });
    }
  }

  function renderResidents() {
    for (const building of BUILDINGS) {
      const container = document.getElementById('residents-' + building.id);
      if (container) container.innerHTML = '';
    }

    for (const char of CHARACTERS) {
      const buildingId = charLocations[char.id];
      if (!buildingId) continue;

      const container = document.getElementById('residents-' + buildingId);
      if (!container) continue;

      const dot = document.createElement('div');
      dot.className = 'resident-dot';
      dot.style.setProperty('--dot-color', char.color);
      dot.title = char.name;
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        openChat(char.id);
      });

      const name = document.createElement('div');
      name.className = 'resident-name';
      name.textContent = char.name;

      const wrapper = document.createElement('div');
      wrapper.className = 'resident-wrapper';
      wrapper.appendChild(dot);
      wrapper.appendChild(name);

      container.appendChild(wrapper);
    }
  }

  function animateMovement(char, fromId, toId) {
    const destCell = document.querySelector(`.building-cell[data-building="${toId}"]`);
    if (destCell) {
      destCell.classList.add('arrival');
      setTimeout(() => destCell.classList.remove('arrival'), 1500);
    }

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
        }
      });
    }
  }

  // ===== Create character nodes (network view) =====
  function createNodes() {
    for (const char of CHARACTERS) {
      charEventCounts[char.id] = 0;
      charLastType[char.id] = '';

      const node = document.createElement('div');
      node.className = 'char-node';
      node.dataset.id = char.id;
      node.style.left = char.x + '%';
      node.style.top = char.y + '%';
      node.style.setProperty('--node-color', char.color);

      node.innerHTML = `
        <div class="node-orb" id="orb-${char.id}"></div>
        <div class="node-name">${char.name}</div>
        <div class="node-info" id="info-${char.id}">...</div>
        <div class="node-event-count" id="count-${char.id}">0 events</div>
      `;

      node.addEventListener('click', () => selectCharacter(char.id));
      nodeMap.appendChild(node);
    }
  }

  // ===== Draw connection lines between nodes =====
  function drawConnections() {
    svgLines.innerHTML = '';
    const rect = nodeMap.getBoundingClientRect();

    const pairs = [
      ['neo', 'plato'],
      ['neo', 'joe'],
      ['plato', 'joe'],
    ];

    for (const [a, b] of pairs) {
      const ca = CHARACTERS.find((c) => c.id === a);
      const cb = CHARACTERS.find((c) => c.id === b);
      if (!ca || !cb) continue;

      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', (ca.x / 100) * rect.width);
      line.setAttribute('y1', (ca.y / 100) * rect.height);
      line.setAttribute('x2', (cb.x / 100) * rect.width);
      line.setAttribute('y2', (cb.y / 100) * rect.height);
      line.id = `line-${a}-${b}`;
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
    const url = char.ssePath + (API_KEY ? '?key=' + encodeURIComponent(API_KEY) : '');
    let retryDelay = 1000;

    function connect() {
      const es = new EventSource(url);
      eventSources.set(char.id, es);

      es.onopen = () => {
        retryDelay = 1000;
        if (onOpen) {
          onOpen();
          onOpen = null;
        }
      };

      es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data);
          handleEvent(char, event);
        } catch {
          // Ignore parse errors.
        }
      };

      es.onerror = () => {
        es.close();
        eventSources.delete(char.id);
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

    const countEl = document.getElementById('count-' + char.id);
    if (countEl) countEl.textContent = charEventCounts[char.id] + ' events';

    const infoEl = document.getElementById('info-' + char.id);
    if (infoEl) infoEl.textContent = event.type || '...';

    const orb = document.getElementById('orb-' + char.id);
    if (orb) {
      orb.classList.remove('pulse');
      void orb.offsetWidth;
      orb.classList.add('pulse');
    }

    flashLines(char.id);

    if (event.type === 'movement') {
      const key = event.sessionKey || '';
      const parts = key.split(':');
      if (parts.length >= 3) {
        const fromId = parts[1];
        const toId = parts[2];
        charLocations[char.id] = toId;
        animateMovement(char, fromId, toId);
        renderResidents();
      }
    }

    if (currentView === 'network') {
      createNotification(char, event);
    }

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

    const rect = nodeMap.getBoundingClientRect();
    const cx = (char.x / 100) * rect.width;
    const cy = (char.y / 100) * rect.height;
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
      (API_KEY ? '&key=' + encodeURIComponent(API_KEY) : '');

    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        panelBody.innerHTML = '<div class="panel-placeholder">failed to load (' + resp.status + ')</div>';
        return;
      }
      const entries = await resp.json();
      renderActivity(entries);
    } catch {
      panelBody.innerHTML = '<div class="panel-placeholder">connection error</div>';
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
    const value = String(str || '');
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

  function openChat(charId) {
    chatCharId = charId;
    const char = CHARACTERS.find((c) => c.id === charId);
    if (!char) return;

    selectCharacter(charId);

    chatModalTitle.textContent = char.name;
    chatModalTitle.style.color = char.color;
    chatModal.style.display = 'flex';

    const storedSession = localStorage.getItem('stranger-session-' + charId);
    if (storedSession) {
      chatSessions[charId] = storedSession;
    }

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
    const charId = chatCharId;
    const char = CHARACTERS.find((c) => c.id === charId);
    if (!char) return;

    if (!chatHistories[charId]) chatHistories[charId] = [];
    chatHistories[charId].push({ role: 'stranger', text });

    addChatMessage('stranger', text, char.color);

    const submitBtn = chatModalForm.querySelector('button');
    chatModalInput.disabled = true;
    submitBtn.disabled = true;

    const { el: bubble, msgText } = createStreamingBubble(char.color);
    let fullText = '';

    if (chatAbortController) chatAbortController.abort();
    chatAbortController = new AbortController();

    try {
      const priorSessionId = chatSessions[charId] || null;
      const payload = { message: text, stranger: true };
      if (priorSessionId) payload.sessionId = priorSessionId;

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
            } else if (event.type === 'error') {
              fullText += '\n[error: ' + (event.message || 'unknown') + ']';
              msgText.textContent = fullText;
            }
          } catch {
            // Ignore parse errors.
          }
        }
      }
    } catch (err) {
      const errorName = err && typeof err === 'object' && 'name' in err ? err.name : '';
      if (errorName !== 'AbortError') {
        fullText = fullText || '[connection error]';
        msgText.textContent = fullText;
      }
    }

    bubble.classList.remove('streaming');
    if (fullText && charId === chatCharId) {
      chatHistories[charId].push({ role: 'character', text: fullText });
    }
    chatModalInput.disabled = false;
    submitBtn.disabled = false;
    if (charId === chatCharId) chatModalInput.focus();
    chatAbortController = null;
  }

  // ===== Start =====
  init();
})();
