/**
 * HIRU // POSSESS — Player possession interface
 */

(function () {
  'use strict';

  // ===== Config =====
  const BUILDINGS = [
    { id: 'library',    name: 'Library',    emoji: '\u{1F4DA}', row: 0, col: 0 },
    { id: 'bar',        name: 'Bar',        emoji: '\u{1F37A}', row: 0, col: 1 },
    { id: 'field',      name: 'Field',      emoji: '\u{1F33E}', row: 0, col: 2 },
    { id: 'windmill',   name: 'Windmill',   emoji: '\u{1F3D7}', row: 1, col: 0 },
    { id: 'lighthouse', name: 'Lighthouse', emoji: '\u{1F5FC}', row: 1, col: 1 },
    { id: 'school',     name: 'School',     emoji: '\u{1F3EB}', row: 1, col: 2 },
    { id: 'market',     name: 'Market',     emoji: '\u{1F3EA}', row: 2, col: 0 },
    { id: 'locksmith',  name: 'Locksmith',  emoji: '\u{1F510}', row: 2, col: 1 },
    { id: 'threshold',  name: 'The Threshold', emoji: '\u{1F6AA}', row: 2, col: 2 },
  ];

  const PEER_COLORS = {
    'pkd': '#c060ff',
    'mckenna': '#40e080',
    'john': '#ffb040',
    'wired-lain': '#4080ff',
    'lain': '#80c0ff',
    'dr-claude': '#ff6060',
  };

  // ===== Base path (detect /hiru/ prefix from nginx) =====
  const BASE = window.location.pathname.replace(/\/[^/]*$/, '');  // e.g. "/hiru" or ""

  // ===== State =====
  let token = localStorage.getItem('possess-token') || '';
  let possessed = false;
  let currentBuilding = 'market';
  let coLocated = [];
  let allLocations = [];
  let chatTarget = null;
  let chatHistories = {}; // peerId -> [{role, text}]
  let eventSource = null;
  let locationPollTimer = null;

  // ===== DOM =====
  const authOverlay = document.getElementById('auth-overlay');
  const authForm = document.getElementById('auth-form');
  const authToken = document.getElementById('auth-token');
  const authError = document.getElementById('auth-error');
  const statusBadge = document.getElementById('status-badge');
  const btnPossess = document.getElementById('btn-possess');
  const btnRelease = document.getElementById('btn-release');
  const townGrid = document.getElementById('town-grid');
  const whosHereList = document.getElementById('whos-here-list');
  const chatHeader = document.getElementById('chat-header');
  const chatMessages = document.getElementById('chat-messages');
  const chatForm = document.getElementById('chat-form');
  const chatInput = document.getElementById('chat-input');
  const chatSend = document.getElementById('chat-send');
  const incomingList = document.getElementById('incoming-list');

  // ===== Auth =====
  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    token = authToken.value.trim();
    if (!token) return;

    authError.textContent = '';
    try {
      const resp = await apiFetch('/api/possession/status');
      if (resp.ok) {
        localStorage.setItem('possess-token', token);
        authOverlay.classList.add('hidden');
        const data = await resp.json();
        possessed = data.isPossessed;
        currentBuilding = data.location || 'market';
        onConnected();
      } else {
        authError.textContent = 'Invalid token';
        token = '';
      }
    } catch {
      authError.textContent = 'Connection failed';
      token = '';
    }
  });

  // Auto-login if token stored
  if (token) {
    apiFetch('/api/possession/status').then(async (resp) => {
      if (resp.ok) {
        authOverlay.classList.add('hidden');
        const data = await resp.json();
        possessed = data.isPossessed;
        currentBuilding = data.location || 'market';
        onConnected();
      } else {
        token = '';
        localStorage.removeItem('possess-token');
      }
    }).catch(() => {
      // Show auth screen
    });
  }

  function onConnected() {
    updateStatus();
    buildGrid();
    connectSSE();
    startLocationPolling();
    if (possessed) {
      fetchLook();
    }
  }

  // ===== API helpers =====
  function apiFetch(path, options) {
    return fetch(BASE + path, {
      ...options,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        ...(options && options.headers),
      },
    });
  }

  // ===== Possess / Release =====
  btnPossess.addEventListener('click', async () => {
    try {
      const resp = await apiFetch('/api/possess', { method: 'POST' });
      if (resp.ok) {
        possessed = true;
        updateStatus();
        fetchLook();
      } else {
        const data = await resp.json();
        console.error('Possess failed:', data.error);
      }
    } catch (err) {
      console.error('Possess error:', err);
    }
  });

  btnRelease.addEventListener('click', async () => {
    try {
      const resp = await apiFetch('/api/unpossess', { method: 'POST' });
      if (resp.ok) {
        possessed = false;
        chatTarget = null;
        coLocated = [];
        updateStatus();
        renderWhosHere();
        renderChatHeader();
        chatMessages.innerHTML = '';
      }
    } catch (err) {
      console.error('Release error:', err);
    }
  });

  function updateStatus() {
    if (possessed) {
      statusBadge.textContent = 'possessed';
      statusBadge.className = 'status-badge possessed';
      btnPossess.style.display = 'none';
      btnRelease.style.display = '';
      chatInput.disabled = false;
      chatSend.disabled = false;
    } else {
      statusBadge.textContent = 'connected';
      statusBadge.className = 'status-badge connected';
      btnPossess.style.display = '';
      btnRelease.style.display = 'none';
      chatInput.disabled = true;
      chatSend.disabled = true;
    }
    renderGrid();
  }

  // ===== Town Grid =====
  function buildGrid() {
    townGrid.innerHTML = '';
    for (const b of BUILDINGS) {
      const cell = document.createElement('div');
      cell.className = 'grid-cell';
      cell.dataset.building = b.id;
      cell.innerHTML =
        '<div class="cell-emoji">' + b.emoji + '</div>' +
        '<div class="cell-name">' + b.name + '</div>' +
        '<div class="cell-dots" id="dots-' + b.id + '"></div>';

      cell.addEventListener('click', () => moveToBuilding(b.id));
      townGrid.appendChild(cell);
    }
    renderGrid();
  }

  function renderGrid() {
    const cells = townGrid.querySelectorAll('.grid-cell');
    for (const cell of cells) {
      const bid = cell.dataset.building;
      cell.classList.toggle('current', bid === currentBuilding);
      cell.classList.toggle('disabled', !possessed);

      // Render character dots
      const dotsEl = document.getElementById('dots-' + bid);
      if (dotsEl) {
        dotsEl.innerHTML = '';
        // Hiru
        if (bid === currentBuilding) {
          const dot = document.createElement('div');
          dot.className = 'cell-dot';
          dot.style.background = '#60d0a0';
          dot.title = 'Hiru (you)';
          dotsEl.appendChild(dot);
        }
        // Other characters
        for (const loc of allLocations) {
          if (loc.building === bid) {
            const dot = document.createElement('div');
            dot.className = 'cell-dot';
            dot.style.background = PEER_COLORS[loc.id] || '#888';
            dot.title = loc.name;
            dotsEl.appendChild(dot);
          }
        }
      }
    }
  }

  async function moveToBuilding(buildingId) {
    if (!possessed || buildingId === currentBuilding) return;

    try {
      const resp = await apiFetch('/api/possession/move', {
        method: 'POST',
        body: JSON.stringify({ building: buildingId }),
      });
      if (resp.ok) {
        currentBuilding = buildingId;
        chatTarget = null;
        renderChatHeader();
        chatMessages.innerHTML = '';
        fetchLook();
      }
    } catch (err) {
      console.error('Move error:', err);
    }
  }

  // ===== Look / Who's here =====
  async function fetchLook() {
    try {
      const resp = await apiFetch('/api/possession/look');
      if (resp.ok) {
        const data = await resp.json();
        currentBuilding = data.building;
        coLocated = data.coLocated || [];
        allLocations = data.allLocations || [];
        renderWhosHere();
        renderGrid();
      }
    } catch (err) {
      console.error('Look error:', err);
    }
  }

  function renderWhosHere() {
    whosHereList.innerHTML = '';
    if (!possessed || coLocated.length === 0) {
      whosHereList.innerHTML = '<div class="empty-hint">' +
        (possessed ? 'nobody else here' : 'possess to see') + '</div>';
      return;
    }

    for (const peer of coLocated) {
      const item = document.createElement('div');
      item.className = 'peer-item' + (chatTarget === peer.id ? ' active' : '');
      item.innerHTML =
        '<div class="peer-dot" style="background:' + (PEER_COLORS[peer.id] || '#888') + '"></div>' +
        '<div class="peer-name">' + escapeHtml(peer.name) + '</div>';
      item.addEventListener('click', () => selectChatTarget(peer.id, peer.name));
      whosHereList.appendChild(item);
    }
  }

  // ===== Chat =====
  function selectChatTarget(peerId, peerName) {
    chatTarget = peerId;
    renderWhosHere();
    renderChatHeader(peerName);
    renderChatMessages();
    chatInput.focus();
  }

  function renderChatHeader(name) {
    const el = chatHeader.querySelector('.chat-target');
    if (name) {
      el.textContent = 'Talking to ' + name;
      el.className = 'chat-target active';
    } else if (chatTarget) {
      el.textContent = 'Talking to ' + chatTarget;
      el.className = 'chat-target active';
    } else {
      el.textContent = 'Select an inhabitant to talk';
      el.className = 'chat-target';
    }
  }

  function renderChatMessages() {
    chatMessages.innerHTML = '';
    const history = chatHistories[chatTarget] || [];
    for (const msg of history) {
      appendChatBubble(msg.role, msg.text, msg.sender);
    }
  }

  function appendChatBubble(role, text, sender) {
    const div = document.createElement('div');
    div.className = 'msg ' + (role === 'outgoing' ? 'outgoing' : 'incoming');
    if (sender) {
      div.innerHTML = '<div class="msg-sender">' + escapeHtml(sender) + '</div>' +
        '<div class="msg-text">' + escapeHtml(text) + '</div>';
    } else {
      div.innerHTML = '<div class="msg-text">' + escapeHtml(text) + '</div>';
    }
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return div;
  }

  chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text || !chatTarget || !possessed) return;
    chatInput.value = '';

    // Add to history
    if (!chatHistories[chatTarget]) chatHistories[chatTarget] = [];
    chatHistories[chatTarget].push({ role: 'outgoing', text });
    appendChatBubble('outgoing', text);

    // Loading indicator
    const loadingDiv = document.createElement('div');
    loadingDiv.className = 'msg incoming loading';
    loadingDiv.innerHTML = '<div class="msg-text"></div>';
    chatMessages.appendChild(loadingDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    chatInput.disabled = true;
    chatSend.disabled = true;

    try {
      const resp = await apiFetch('/api/possession/say', {
        method: 'POST',
        body: JSON.stringify({ peerId: chatTarget, message: text }),
      });

      loadingDiv.remove();

      if (resp.ok) {
        const data = await resp.json();
        const peerName = coLocated.find(p => p.id === chatTarget)?.name || chatTarget;
        chatHistories[chatTarget].push({ role: 'incoming', text: data.response, sender: peerName });
        appendChatBubble('incoming', data.response, peerName);
      } else {
        const data = await resp.json();
        if (data.error === 'not_co_located') {
          chatHistories[chatTarget].push({ role: 'incoming', text: '[Not in the same building]', sender: 'system' });
          appendChatBubble('incoming', '[Not in the same building]', 'system');
          // Refresh look since locations changed
          fetchLook();
        } else {
          chatHistories[chatTarget].push({ role: 'incoming', text: '[Error: ' + (data.error || 'unknown') + ']', sender: 'system' });
          appendChatBubble('incoming', '[Error: ' + (data.error || 'unknown') + ']', 'system');
        }
      }
    } catch {
      loadingDiv.remove();
      chatHistories[chatTarget].push({ role: 'incoming', text: '[Connection error]', sender: 'system' });
      appendChatBubble('incoming', '[Connection error]', 'system');
    }

    chatInput.disabled = false;
    chatSend.disabled = false;
    chatInput.focus();
  });

  // ===== Incoming messages (from SSE) =====
  function renderIncoming(pending) {
    incomingList.innerHTML = '';
    if (!pending || pending.length === 0) {
      incomingList.innerHTML = '<div class="empty-hint">no pending messages</div>';
      return;
    }

    for (const msg of pending) {
      const item = document.createElement('div');
      item.className = 'incoming-item';
      item.dataset.fromId = msg.fromId;

      item.innerHTML =
        '<div class="incoming-from">' + escapeHtml(msg.fromName) + '</div>' +
        '<div class="incoming-text">' + escapeHtml(msg.message) + '</div>' +
        '<div class="incoming-actions">' +
        '  <button class="btn-reply">Reply</button>' +
        '  <button class="btn-ignore">Ignore</button>' +
        '</div>';

      const replyBtn = item.querySelector('.btn-reply');
      const ignoreBtn = item.querySelector('.btn-ignore');

      replyBtn.addEventListener('click', () => {
        showReplyInput(item, msg.fromId);
      });

      ignoreBtn.addEventListener('click', () => {
        item.remove();
        // Let timeout handle it (responds "...")
      });

      incomingList.appendChild(item);
    }
  }

  function addIncomingMessage(fromId, fromName, message) {
    // Remove empty hint
    const hint = incomingList.querySelector('.empty-hint');
    if (hint) hint.remove();

    const item = document.createElement('div');
    item.className = 'incoming-item';
    item.dataset.fromId = fromId;

    item.innerHTML =
      '<div class="incoming-from">' + escapeHtml(fromName) + '</div>' +
      '<div class="incoming-text">' + escapeHtml(message) + '</div>' +
      '<div class="incoming-actions">' +
      '  <button class="btn-reply">Reply</button>' +
      '  <button class="btn-ignore">Ignore</button>' +
      '</div>';

    const replyBtn = item.querySelector('.btn-reply');
    const ignoreBtn = item.querySelector('.btn-ignore');

    replyBtn.addEventListener('click', () => {
      showReplyInput(item, fromId);
    });

    ignoreBtn.addEventListener('click', () => {
      item.remove();
      checkIncomingEmpty();
    });

    incomingList.appendChild(item);
  }

  function showReplyInput(item, fromId) {
    // Check if reply form already shown
    if (item.querySelector('.reply-form')) return;

    const actions = item.querySelector('.incoming-actions');
    actions.style.display = 'none';

    const form = document.createElement('form');
    form.className = 'reply-form';
    form.innerHTML =
      '<input class="reply-input" placeholder="reply..." autofocus />' +
      '<button type="submit" class="btn-reply">Send</button>';

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = form.querySelector('.reply-input');
      const text = input.value.trim();
      if (!text) return;

      try {
        await apiFetch('/api/possession/reply', {
          method: 'POST',
          body: JSON.stringify({ fromId, message: text }),
        });
        item.remove();
        checkIncomingEmpty();
      } catch (err) {
        console.error('Reply error:', err);
      }
    });

    item.appendChild(form);
    form.querySelector('.reply-input').focus();
  }

  function checkIncomingEmpty() {
    if (incomingList.children.length === 0) {
      incomingList.innerHTML = '<div class="empty-hint">no pending messages</div>';
    }
  }

  // ===== SSE =====
  function connectSSE() {
    if (eventSource) {
      eventSource.close();
    }

    eventSource = new EventSource(BASE + '/api/possession/stream?token=' + encodeURIComponent(token));

    // EventSource doesn't support custom headers, so we pass token as query param
    // But our server uses Authorization header. Let's use fetch-based SSE instead.
    eventSource.close();
    eventSource = null;

    // Use fetch-based SSE
    startSSE();
  }

  async function startSSE() {
    try {
      const resp = await fetch(BASE + '/api/possession/stream', {
        headers: { 'Authorization': 'Bearer ' + token },
      });

      if (!resp.ok) return;

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
          try {
            const event = JSON.parse(line.slice(6));
            handleSSEEvent(event);
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // Reconnect after delay
      setTimeout(startSSE, 5000);
    }
  }

  function handleSSEEvent(event) {
    if (event.type === 'peer_message') {
      addIncomingMessage(event.fromId, event.fromName, event.message);
    } else if (event.type === 'movement') {
      fetchLook();
    } else if (event.type === 'possession_ended') {
      possessed = false;
      updateStatus();
    }
  }

  // ===== Location polling =====
  function startLocationPolling() {
    if (locationPollTimer) clearInterval(locationPollTimer);
    locationPollTimer = setInterval(() => {
      if (possessed) {
        fetchLook();
      }
    }, 10000);
  }

  // ===== Pending messages polling =====
  setInterval(async () => {
    if (!possessed || !token) return;
    try {
      const resp = await apiFetch('/api/possession/pending');
      if (resp.ok) {
        const pending = await resp.json();
        renderIncoming(pending);
      }
    } catch {
      // ignore
    }
  }, 5000);

  // ===== Util =====
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
})();
