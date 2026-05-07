
  (function() {
    'use strict';

    // ===== Character Configuration =====
    const CHARACTERS = [
      { id: 'neo', name: 'Neo', color: '#60e0a0', prefix: '/neo', ssePath: '/neo/api/events', telemetryPath: '/neo/api/telemetry', locationPath: '/neo/api/location', healthPath: '/neo/api/health' },
      { id: 'plato', name: 'Plato', color: '#e0c870', prefix: '/plato', ssePath: '/plato/api/events', telemetryPath: '/plato/api/telemetry', locationPath: '/plato/api/location', healthPath: '/plato/api/health' },
      { id: 'joe', name: 'Joe', color: '#88b0d0', prefix: '/joe', ssePath: '/joe/api/events', telemetryPath: '/joe/api/telemetry', locationPath: '/joe/api/location', healthPath: '/joe/api/health' },
      { id: 'cage', name: 'Nicolas Cage', color: '#ff9f43', prefix: '/cage', ssePath: '/cage/api/events', telemetryPath: '/cage/api/telemetry', locationPath: '/cage/api/location', healthPath: '/cage/api/health' },
    ];

    const BUILDINGS = [
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

    const DEFAULT_LOCATIONS = {
      'neo': 'station',
      'plato': 'mystery-tower',
      'joe': 'square',
      'cage': 'theater',
    };

    const LOOP_KEYS = {
      diary:         { key: 'diary:last_entry_at',            interval: 24 * 60 * 60 * 1000 },
      dream:         { key: 'dream:last_cycle_at',            interval: 3 * 60 * 60 * 1000 },
      curiosity:     { key: 'curiosity:last_cycle_at',        altKey: 'curiosity-offline:last_cycle_at', interval: 2 * 60 * 60 * 1000 },
      'self-concept': { key: 'self-concept:last_synthesis_at', interval: 7 * 24 * 60 * 60 * 1000 },
      commune:       { key: 'commune:last_cycle_at',           interval: 10 * 60 * 60 * 1000 },
    };

    const LOOP_NAMES = ['diary', 'dream', 'curiosity', 'self-concept', 'commune'];

    // ===== State =====
    const charLocations = {};
    const charTelemetry = {};
    const serviceHealth = {};
    const eventSources = new Map();
    const MAX_ACTIVITY = 200;
    let activityCount = 0;
    let convoCount = 0;

    // Force-directed graph state
    const nodePositions = {};
    let relationshipEdges = [];
    let simRunning = false;
    let simIterations = 0;
    const SIM_MAX = 300;

    // ===== Utilities =====
    function escapeHtml(str) {
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    function formatTime(ts) {
      const d = ts ? new Date(ts) : new Date();
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function barColorClass(pct) {
      if (pct >= 90) return 'red';
      if (pct >= 70) return 'yellow';
      return 'green';
    }

    function classifyEvent(event) {
      const type = event.type || '';
      const key = event.sessionKey || '';
      if (type.includes('commune') || key.includes('commune')) return 'commune';
      if (type.includes('diary') || key.includes('diary')) return 'diary';
      if (type.includes('dream') || key.includes('dream')) return 'dream';
      if (type.includes('curiosity') || key.includes('curiosity')) return 'curiosity';
      if (type.includes('letter') || key.includes('letter')) return 'letter';
      if (type.includes('research') || key.includes('research')) return 'research';
      if (type.includes('doctor') || type.includes('therapy') || key.includes('doctor')) return 'therapy';
      if (type.includes('self-concept') || key.includes('self-concept')) return 'self-concept';
      if (type.includes('narrative') || key.includes('narrative')) return 'narrative';
      return 'other';
    }

    function getCharById(id) {
      return CHARACTERS.find(c => c.id === id);
    }

    // ===== Service Health =====
    function initServiceList() {
      const container = document.getElementById('service-list');
      // 7 character services + Telegram + Gateway
      const services = CHARACTERS.map(c => ({ id: c.id, name: c.name }));
      services.push({ id: 'telegram', name: 'Telegram' });
      services.push({ id: 'gateway', name: 'Gateway' });

      for (const svc of services) {
        const row = document.createElement('div');
        row.className = 'service-row';
        row.innerHTML =
          '<div class="status-dot" id="svc-dot-' + svc.id + '"></div>' +
          '<span class="service-name">' + escapeHtml(svc.name) + '</span>' +
          '<span class="service-latency" id="svc-lat-' + svc.id + '"></span>';
        container.appendChild(row);
      }
    }

    async function pollServiceHealth() {
      // Character health endpoints — fetch all in parallel
      await Promise.allSettled(CHARACTERS.map(async function(char) {
        const start = Date.now();
        try {
          const resp = await fetch(char.healthPath, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
          const latency = Date.now() - start;
          const dot = document.getElementById('svc-dot-' + char.id);
          const lat = document.getElementById('svc-lat-' + char.id);
          if (resp.ok || resp.status === 302 || resp.type === 'opaqueredirect') {
            dot.className = 'status-dot healthy';
            lat.textContent = latency + 'ms';
            serviceHealth[char.id] = true;
          } else {
            dot.className = 'status-dot';
            lat.textContent = 'err';
            serviceHealth[char.id] = false;
          }
        } catch {
          const dot = document.getElementById('svc-dot-' + char.id);
          const lat = document.getElementById('svc-lat-' + char.id);
          if (dot) dot.className = 'status-dot';
          if (lat) lat.textContent = 'down';
          serviceHealth[char.id] = false;
        }
      }));

      // Telegram + Gateway from /api/system
      try {
        const resp = await fetch('/api/system', { signal: AbortSignal.timeout(5000) });
        if (resp.ok) {
          const data = await resp.json();
          updateInfrastructure(data);

          const tgDot = document.getElementById('svc-dot-telegram');
          const gwDot = document.getElementById('svc-dot-gateway');
          const tgLat = document.getElementById('svc-lat-telegram');
          const gwLat = document.getElementById('svc-lat-gateway');

          if (data.services?.telegram?.active) {
            tgDot.className = 'status-dot healthy';
            tgLat.textContent = '';
          } else {
            tgDot.className = 'status-dot';
            tgLat.textContent = 'down';
          }

          if (data.services?.gateway?.active) {
            gwDot.className = 'status-dot healthy';
            gwLat.textContent = '';
          } else {
            gwDot.className = 'status-dot';
            gwLat.textContent = 'down';
          }
        }
      } catch {
        // /api/system unavailable
      }
    }

    // ===== Infrastructure =====
    function updateInfrastructure(data) {
      if (!data) return;

      function updateBar(id, pct) {
        const fill = document.getElementById(id + '-fill');
        const label = document.getElementById(id + '-pct');
        if (fill) {
          fill.style.width = pct + '%';
          fill.className = 'infra-fill ' + barColorClass(pct);
        }
        if (label) label.textContent = pct + '%';
      }

      if (data.disk) updateBar('disk', data.disk.percent);
      if (data.ram) updateBar('ram', data.ram.percent);
      if (data.swap) updateBar('swap', data.swap.percent);

      const loadEl = document.getElementById('load-text');
      if (loadEl && data.load) {
        loadEl.textContent = data.load.map(v => v.toFixed(2)).join(', ');
      }

      const uptimeEl = document.getElementById('uptime-text');
      if (uptimeEl && data.uptime) {
        uptimeEl.textContent = data.uptime;
      }
    }

    // ===== Loop Health =====
    function initLoopGrid() {
      const grid = document.getElementById('loop-grid');
      for (const char of CHARACTERS) {
        const label = document.createElement('div');
        label.className = 'loop-char';
        label.textContent = char.name.split(' ').pop(); // short name
        label.style.color = char.color;
        grid.appendChild(label);

        for (const loopName of LOOP_NAMES) {
          const cell = document.createElement('div');
          cell.style.display = 'flex';
          cell.style.alignItems = 'center';
          cell.style.justifyContent = 'center';
          const dot = document.createElement('div');
          dot.className = 'loop-dot';
          dot.id = 'loop-' + char.id + '-' + loopName;
          dot.title = char.name + ' / ' + loopName;
          cell.appendChild(dot);
          grid.appendChild(cell);
        }
      }
    }

    async function pollLoopHealth() {
      await Promise.allSettled(CHARACTERS.map(async function(char) {
        try {
          const resp = await fetch(char.telemetryPath, { signal: AbortSignal.timeout(5000) });
          if (!resp.ok) return;
          const data = await resp.json();
          charTelemetry[char.id] = data;

          const loopHealth = data.loopHealth || {};
          const now = Date.now();

          for (const loopName of LOOP_NAMES) {
            const dot = document.getElementById('loop-' + char.id + '-' + loopName);
            if (!dot) continue;

            const spec = LOOP_KEYS[loopName];
            const lastStr = loopHealth[spec.key] || (spec.altKey ? loopHealth[spec.altKey] : null);
            if (!lastStr) {
              dot.className = 'loop-dot';
              continue;
            }

            const lastTs = Number(lastStr);
            if (isNaN(lastTs)) {
              dot.className = 'loop-dot';
              continue;
            }

            const elapsed = now - lastTs;
            if (elapsed <= spec.interval) {
              dot.className = 'loop-dot green';
            } else if (elapsed <= spec.interval * 2) {
              dot.className = 'loop-dot yellow';
            } else {
              dot.className = 'loop-dot red';
            }
          }
        } catch {
          // Character telemetry unavailable
        }
      }));
    }

    // ===== Town Map =====
    function initTownMap() {
      const grid = document.getElementById('town-grid');
      for (const b of BUILDINGS) {
        const cell = document.createElement('div');
        cell.className = 'building-cell';
        cell.dataset.building = b.id;
        cell.innerHTML =
          '<div class="building-name">' + escapeHtml(b.name) + '</div>' +
          '<div class="building-residents" id="bld-' + b.id + '"></div>';
        grid.appendChild(cell);
      }

      // Initialize with defaults
      for (const char of CHARACTERS) {
        charLocations[char.id] = DEFAULT_LOCATIONS[char.id] || 'square';
      }
      renderResidents();
    }

    function renderResidents() {
      for (const b of BUILDINGS) {
        const container = document.getElementById('bld-' + b.id);
        if (container) container.innerHTML = '';
      }

      for (const char of CHARACTERS) {
        const buildingId = charLocations[char.id];
        if (!buildingId) continue;
        const container = document.getElementById('bld-' + buildingId);
        if (!container) continue;

        const wrapper = document.createElement('div');
        wrapper.className = 'resident-wrapper';

        const dot = document.createElement('div');
        dot.className = 'resident-dot';
        dot.style.setProperty('--dot-color', char.color);
        dot.title = char.name;

        const name = document.createElement('div');
        name.className = 'resident-name';
        name.textContent = char.name;

        wrapper.appendChild(dot);
        wrapper.appendChild(name);
        container.appendChild(wrapper);
      }
    }

    async function pollLocations() {
      await Promise.allSettled(CHARACTERS.map(async function(char) {
        try {
          const resp = await fetch(char.locationPath, { signal: AbortSignal.timeout(5000) });
          if (!resp.ok) return;
          const data = await resp.json();
          if (data && data.location) {
            charLocations[char.id] = data.location;
          }
        } catch {
          // keep existing
        }
      }));
      renderResidents();
    }

    // ===== Relationship Graph (force-directed, canvas) =====
    function initGraph() {
      const n = CHARACTERS.length;
      CHARACTERS.forEach(function(c, i) {
        const angle = (2 * Math.PI * i) / n;
        nodePositions[c.id] = { x: 50 + 25 * Math.cos(angle), y: 50 + 25 * Math.sin(angle), vx: 0, vy: 0 };
      });
    }

    function startSimulation() {
      simIterations = 0;
      for (const id in nodePositions) {
        nodePositions[id].vx = 0;
        nodePositions[id].vy = 0;
      }
      if (!simRunning) {
        simRunning = true;
        requestAnimationFrame(simulationStep);
      }
    }

    function simulationStep() {
      if (!simRunning || simIterations > SIM_MAX) {
        simRunning = false;
        renderGraph();
        return;
      }
      simIterations++;
      const alpha = Math.max(0.01, 1 - simIterations / SIM_MAX);

      // Repulsion between all pairs
      for (let i = 0; i < CHARACTERS.length; i++) {
        for (let j = i + 1; j < CHARACTERS.length; j++) {
          const a = nodePositions[CHARACTERS[i].id];
          const b = nodePositions[CHARACTERS[j].id];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 0.1;
          const force = Math.min((600 / (dist * dist)) * alpha, 4);
          a.vx += (dx / dist) * force;
          a.vy += (dy / dist) * force;
          b.vx -= (dx / dist) * force;
          b.vy -= (dy / dist) * force;
        }
      }

      // Edge attraction
      for (const edge of relationshipEdges) {
        const ea = nodePositions[edge.source];
        const eb = nodePositions[edge.target];
        if (!ea || !eb) continue;
        const edx = eb.x - ea.x;
        const edy = eb.y - ea.y;
        const edist = Math.sqrt(edx * edx + edy * edy) || 0.1;
        const ideal = Math.max(10, 30 - 18 * edge.weight);
        const eforce = ((edist - ideal) / edist) * 0.05 * alpha;
        ea.vx += edx * eforce;
        ea.vy += edy * eforce;
        eb.vx -= edx * eforce;
        eb.vy -= edy * eforce;
      }

      // Center gravity
      for (const c of CHARACTERS) {
        const p = nodePositions[c.id];
        p.vx += (50 - p.x) * 0.01 * alpha;
        p.vy += (50 - p.y) * 0.01 * alpha;
      }

      // Apply velocity, damp, clamp
      for (const c of CHARACTERS) {
        const p = nodePositions[c.id];
        p.vx *= 0.92;
        p.vy *= 0.92;
        p.x += p.vx;
        p.y += p.vy;
        p.x = Math.max(10, Math.min(90, p.x));
        p.y = Math.max(10, Math.min(90, p.y));
      }

      renderGraph();
      requestAnimationFrame(simulationStep);
    }

    function renderGraph() {
      const canvas = document.getElementById('relationship-canvas');
      if (!canvas) return;
      const container = canvas.parentElement;
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;

      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      canvas.style.width = rect.width + 'px';
      canvas.style.height = rect.height + 'px';

      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, rect.width, rect.height);

      const w = rect.width;
      const h = rect.height;

      // Draw edges
      for (const edge of relationshipEdges) {
        const pa = nodePositions[edge.source];
        const pb = nodePositions[edge.target];
        if (!pa || !pb) continue;

        const x1 = (pa.x / 100) * w;
        const y1 = (pa.y / 100) * h;
        const x2 = (pb.x / 100) * w;
        const y2 = (pb.y / 100) * h;

        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = 'rgba(0, 255, 65, ' + (0.15 + 0.7 * edge.weight) + ')';
        ctx.lineWidth = 0.5 + 2.5 * edge.weight;
        ctx.stroke();
      }

      // Draw nodes
      for (const char of CHARACTERS) {
        const p = nodePositions[char.id];
        if (!p) continue;

        const x = (p.x / 100) * w;
        const y = (p.y / 100) * h;

        // Glow
        ctx.beginPath();
        ctx.arc(x, y, 12, 0, 2 * Math.PI);
        ctx.fillStyle = char.color + '22';
        ctx.fill();

        // Circle
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, 2 * Math.PI);
        ctx.fillStyle = char.color;
        ctx.fill();

        // Label
        ctx.fillStyle = '#888';
        ctx.font = '9px Courier New';
        ctx.textAlign = 'center';
        ctx.fillText(char.name, x, y + 16);
      }
    }

    async function fetchRelationships() {
      try {
        const resp = await fetch('/api/relationships', { signal: AbortSignal.timeout(10000) });
        if (!resp.ok) return;
        const data = await resp.json();
        relationshipEdges = data.edges || [];
        startSimulation();
      } catch {
        // ignore
      }
    }

    // ===== Activity Stream (SSE) =====
    function connectActivitySSE(char) {
      let retryDelay = 1000;

      function connect() {
        const es = new EventSource(char.ssePath);
        eventSources.set('activity-' + char.id, es);

        es.onopen = function() {
          retryDelay = 1000;
        };

        es.onmessage = function(e) {
          try {
            const event = JSON.parse(e.data);
            addActivityEntry(char, event);
          } catch {
            // ignore parse errors
          }
        };

        es.onerror = function() {
          es.close();
          eventSources.delete('activity-' + char.id);
          setTimeout(connect, retryDelay);
          retryDelay = Math.min(retryDelay * 2, 30000);
        };
      }

      connect();
    }

    function addActivityEntry(char, event) {
      const container = document.getElementById('activity-stream');
      const emptyEl = document.getElementById('activity-empty');
      if (emptyEl) emptyEl.style.display = 'none';

      const category = classifyEvent(event);
      const entry = document.createElement('div');
      entry.className = 'activity-entry';

      const time = document.createElement('span');
      time.className = 'activity-time';
      time.textContent = formatTime(event.timestamp);

      const charLabel = document.createElement('span');
      charLabel.className = 'activity-char';
      charLabel.style.color = char.color;
      charLabel.textContent = char.name;

      const badge = document.createElement('span');
      badge.className = 'activity-badge badge-' + category;
      badge.textContent = category;

      const text = document.createElement('span');
      text.className = 'activity-text';
      const summary = event.summary || event.type || event.message || '';
      text.textContent = summary.slice(0, 200);

      entry.appendChild(time);
      entry.appendChild(charLabel);
      entry.appendChild(badge);
      entry.appendChild(text);

      container.prepend(entry);
      activityCount++;

      // Prune oldest
      while (activityCount > MAX_ACTIVITY && container.lastChild) {
        container.removeChild(container.lastChild);
        activityCount--;
      }

      // Handle location updates from events
      if (event.type === 'move' || event.type === 'movement') {
        if (event.to) {
          charLocations[char.id] = event.to;
          renderResidents();
        }
      }
    }

    // ===== Conversations SSE =====
    function connectConversationsSSE() {
      let retryDelay = 1000;

      function connect() {
        const es = new EventSource('/api/conversations/stream');
        eventSources.set('conversations', es);

        es.onopen = function() {
          retryDelay = 1000;
        };

        es.onmessage = function(e) {
          try {
            const event = JSON.parse(e.data);
            addConversationEntry(event);
          } catch {
            // ignore parse errors
          }
        };

        es.onerror = function() {
          es.close();
          eventSources.delete('conversations');
          setTimeout(connect, retryDelay);
          retryDelay = Math.min(retryDelay * 2, 30000);
        };
      }

      connect();
    }

    function addConversationEntry(event) {
      const container = document.getElementById('conversation-stream');
      const emptyEl = document.getElementById('convo-empty');
      if (emptyEl) emptyEl.style.display = 'none';

      const entry = document.createElement('div');
      entry.className = 'convo-entry';

      const speaker = getCharById(event.speakerId);
      const speakerColor = speaker ? speaker.color : '#888';

      const meta = document.createElement('div');
      meta.className = 'convo-meta';
      meta.innerHTML =
        '<span style="color:' + escapeHtml(speakerColor) + '">' + escapeHtml(event.speakerName || event.speakerId || '?') + '</span>' +
        ' &rarr; ' +
        escapeHtml(event.listenerName || event.listenerId || '?') +
        ' &middot; ' + escapeHtml(event.building || '') +
        ' &middot; ' + formatTime(event.timestamp);

      const text = document.createElement('div');
      text.className = 'convo-text';
      text.textContent = (event.message || '').slice(0, 500);

      entry.appendChild(meta);
      entry.appendChild(text);

      container.prepend(entry);
      convoCount++;

      // Prune
      while (convoCount > MAX_ACTIVITY && container.lastChild) {
        container.removeChild(container.lastChild);
        convoCount--;
      }
    }

    // ===== Tabs =====
    function initTabs() {
      const buttons = document.querySelectorAll('.tab-btn');
      for (const btn of buttons) {
        btn.addEventListener('click', function() {
          buttons.forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          const tabId = btn.dataset.tab;
          document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
          document.getElementById('tab-' + tabId).classList.add('active');
        });
      }
    }

    // ===== Memory Stats =====
    function updateMemoryStats() {
      const grid = document.getElementById('memory-grid');
      grid.innerHTML = '';

      for (const char of CHARACTERS) {
        const tel = charTelemetry[char.id];
        const card = document.createElement('div');
        card.className = 'memory-card';

        const name = document.createElement('div');
        name.className = 'memory-char-name';
        name.style.color = char.color;
        name.textContent = char.name;

        const count = document.createElement('div');
        count.className = 'memory-count';
        count.textContent = tel ? (tel.totalMemories || 0).toLocaleString() : '--';

        const label = document.createElement('div');
        label.className = 'memory-label';
        label.textContent = 'memories';

        const ew = tel ? (tel.avgEmotionalWeight || 0) : 0;
        const ewBar = document.createElement('div');
        ewBar.className = 'ew-bar';
        const ewFill = document.createElement('div');
        ewFill.className = 'ew-fill';
        ewFill.style.width = (ew * 100) + '%';
        ewFill.title = 'Avg emotional weight: ' + ew.toFixed(2);
        ewBar.appendChild(ewFill);

        const ewLabel = document.createElement('div');
        ewLabel.className = 'memory-label';
        ewLabel.textContent = 'ew: ' + ew.toFixed(2);

        card.appendChild(name);
        card.appendChild(count);
        card.appendChild(label);
        card.appendChild(ewBar);
        card.appendChild(ewLabel);
        grid.appendChild(card);
      }
    }

    // ===== Budget =====
    async function pollBudget() {
      try {
        const resp = await fetch('/api/budget', { signal: AbortSignal.timeout(5000) });
        if (!resp.ok) return;
        const data = await resp.json();

        const amountEl = document.getElementById('budget-amount');
        const capEl = document.getElementById('budget-cap');
        const fillEl = document.getElementById('budget-fill');
        const dateEl = document.getElementById('budget-date');

        const tokensUsed = data.tokensUsed || 0;
        const dailyCap = data.dailyCap || 1;
        const pctUsed = data.pctUsed || 0;

        amountEl.textContent = (tokensUsed / 1000000).toFixed(2) + 'M';
        capEl.textContent = '/ ' + (dailyCap / 1000000).toFixed(1) + 'M tokens';
        fillEl.style.width = Math.min(pctUsed, 100) + '%';
        fillEl.className = 'budget-fill infra-fill ' + barColorClass(pctUsed);
        dateEl.textContent = data.date || '--';
      } catch {
        // budget unavailable
      }
    }

    // ===== Initialization =====
    function init() {
      initServiceList();
      initLoopGrid();
      initTownMap();
      initGraph();
      initTabs();

      // Initial data fetch (fire-and-forget, don't block rendering)
      pollServiceHealth();
      pollLocations();
      pollLoopHealth();
      fetchRelationships();
      pollBudget();

      // SSE connections — stagger to avoid exhausting browser connection limit
      var sseDelay = 0;
      for (var i = 0; i < CHARACTERS.length; i++) {
        (function(char, delay) {
          setTimeout(function() { connectActivitySSE(char); }, delay);
        })(CHARACTERS[i], sseDelay);
        sseDelay += 500;
      }
      setTimeout(function() { connectConversationsSSE(); }, sseDelay);

      // Polling intervals
      setInterval(pollServiceHealth, 30 * 1000);
      setInterval(pollLocations, 15 * 1000);
      setInterval(function() {
        pollLoopHealth();
        updateMemoryStats();
      }, 60 * 1000);
      setInterval(fetchRelationships, 3 * 60 * 1000);
      setInterval(pollBudget, 60 * 1000);

      // Initial memory stats after first telemetry poll
      setTimeout(updateMemoryStats, 2000);

      // Re-render graph on resize
      window.addEventListener('resize', function() {
        renderGraph();
      });

      // Close SSE when tab is hidden, reconnect when visible
      // Prevents exhausting browser's 6-connection-per-origin limit
      document.addEventListener('visibilitychange', function() {
        if (document.hidden) {
          // Close all SSE connections to free browser connection slots
          for (var entry of eventSources) {
            entry[1].close();
          }
          eventSources.clear();
        } else {
          // Reconnect SSE when tab becomes visible again
          var delay = 0;
          for (var i = 0; i < CHARACTERS.length; i++) {
            (function(char, d) {
              setTimeout(function() { connectActivitySSE(char); }, d);
            })(CHARACTERS[i], delay);
            delay += 500;
          }
          setTimeout(function() { connectConversationsSSE(); }, delay);
          // Refresh data immediately
          pollServiceHealth();
          pollLocations();
          pollLoopHealth();
        }
      });

      // Also close on page unload
      window.addEventListener('beforeunload', function() {
        for (var entry of eventSources) {
          entry[1].close();
        }
      });
    }

    // Run when DOM is ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  })();
  
