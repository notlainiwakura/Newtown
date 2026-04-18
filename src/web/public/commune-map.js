(function () {
  const townGrid = document.getElementById('town-grid');
  const panelBody = document.getElementById('panel-body');
  const statusDot = document.querySelector('.status-dot');
  const connectionStatus = document.getElementById('connection-status');

  function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value;
    return div.innerHTML;
  }

  function renderPanel(residents) {
    panelBody.innerHTML = '';

    residents.forEach((resident) => {
      const entry = document.createElement('div');
      entry.className = 'activity-entry expanded';
      entry.innerHTML = `
        <div class="entry-header">
          <span class="entry-type">resident</span>
          <span class="entry-kind">${escapeHtml(resident.name)}</span>
        </div>
        <div class="entry-content">
          ${resident.online ? `currently at ${escapeHtml(resident.buildingName || resident.location || 'unknown')}` : 'offline'}

          ${escapeHtml(resident.path)}
        </div>
      `;
      panelBody.appendChild(entry);
    });
  }

  function renderTown(buildings, residents) {
    townGrid.innerHTML = '';

    buildings.forEach((building) => {
      const occupants = residents.filter((resident) => resident.location === building.id && resident.online);
      const cell = document.createElement('div');
      cell.className = 'building-cell';
      cell.innerHTML = `
        <div class="building-icon">${building.emoji}</div>
        <div class="building-name">${escapeHtml(building.name)}</div>
        <div class="building-residents">
          ${occupants.length > 0
            ? occupants.map((resident) => `
              <a class="resident-wrapper" href="${resident.path}/">
                <div class="resident-dot"></div>
                <div class="resident-name">${escapeHtml(resident.name)}</div>
              </a>
            `).join('')
            : '<div class="panel-placeholder">quiet</div>'}
        </div>
      `;

      cell.addEventListener('click', () => {
        panelBody.innerHTML = `
          <div class="activity-entry expanded">
            <div class="entry-header">
              <span class="entry-type">building</span>
              <span class="entry-kind">${escapeHtml(building.id)}</span>
            </div>
            <div class="entry-content">
              ${escapeHtml(building.description)}

              ${occupants.length > 0
                ? `Residents here: ${occupants.map((resident) => resident.name).join(', ')}`
                : 'No residents here right now.'}
            </div>
          </div>
        `;
      });

      townGrid.appendChild(cell);
    });
  }

  async function refresh() {
    try {
      const [buildingsResp, residentsResp] = await Promise.all([
        fetch('/api/town/buildings'),
        fetch('/api/town/residents'),
      ]);

      if (!buildingsResp.ok || !residentsResp.ok) {
        throw new Error('town unavailable');
      }

      const buildings = await buildingsResp.json();
      const residents = await residentsResp.json();

      renderTown(buildings, residents);
      renderPanel(residents);
      statusDot.classList.add('connected');
      connectionStatus.textContent = 'resident links online';
    } catch {
      statusDot.classList.remove('connected');
      connectionStatus.textContent = 'town offline';
      panelBody.innerHTML = '<div class="panel-placeholder">could not reach the local resident services</div>';
    }
  }

  refresh();
  setInterval(refresh, 10000);
})();
