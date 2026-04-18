(async function initPicker() {
  console.log('[skin-picker] initPicker called, LaintownSkins:', !!window.LaintownSkins);
  // Wait for LaintownSkins to be available
  if (!window.LaintownSkins) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initPicker);
    } else {
      setTimeout(initPicker, 500);
    }
    return;
  }

  // Wait for skin init to complete before fetching available skins
  if (window.LaintownSkins._ready) {
    await window.LaintownSkins._ready;
  }

  console.log('[skin-picker] fetching available skins...');
  let skins;
  try {
    skins = await window.LaintownSkins.getAvailableSkins();
  } catch(e) {
    console.error('[skin-picker] getAvailableSkins failed:', e);
    return;
  }
  console.log('[skin-picker] found', skins.length, 'skins');
  if (skins.length <= 1) return;

  // Load picker CSS
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  // Use the same base path logic as loader.js
  const skinsBase = window.LaintownSkins._skinsBasePath ? window.LaintownSkins._skinsBasePath() : '/skins';
  link.href = `${skinsBase}/picker.css`;
  document.head.appendChild(link);

  // Create toggle button
  const toggle = document.createElement('button');
  toggle.className = 'skin-picker-toggle';
  toggle.textContent = '🎨';
  toggle.title = 'Change skin';
  toggle.setAttribute('aria-label', 'Change skin');

  // Create panel
  const panel = document.createElement('div');
  panel.className = 'skin-picker-panel';

  const heading = document.createElement('h3');
  heading.textContent = 'Skins';
  panel.appendChild(heading);

  for (const skin of skins) {
    const item = document.createElement('div');
    item.className = 'skin-picker-item';
    if (skin.id === window.LaintownSkins.getSkinId()) {
      item.classList.add('active');
    }
    item.dataset.skinId = skin.id;

    const swatch = document.createElement('div');
    swatch.className = 'skin-picker-swatch';
    for (const color of (skin.previewColors || ['#888', '#666', '#444'])) {
      const dot = document.createElement('div');
      dot.className = 'skin-picker-swatch-dot';
      dot.style.background = color;
      swatch.appendChild(dot);
    }

    const textWrap = document.createElement('div');
    const label = document.createElement('div');
    label.className = 'skin-picker-label';
    label.textContent = skin.name;
    const desc = document.createElement('div');
    desc.className = 'skin-picker-desc';
    desc.textContent = skin.description;
    textWrap.appendChild(label);
    textWrap.appendChild(desc);

    item.appendChild(swatch);
    item.appendChild(textWrap);

    item.addEventListener('click', async () => {
      await window.LaintownSkins.setSkin(skin.id);
      panel.querySelectorAll('.skin-picker-item').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
    });

    panel.appendChild(item);
  }

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    panel.classList.toggle('open');
  });

  document.addEventListener('click', (e) => {
    if (!panel.contains(e.target) && e.target !== toggle) {
      panel.classList.remove('open');
    }
  });

  document.body.appendChild(toggle);
  document.body.appendChild(panel);
})();
