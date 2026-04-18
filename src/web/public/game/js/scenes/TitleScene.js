/**
 * LAINTOWN GAME — Title Scene (Yami Kawaii ✟)
 */

class TitleScene extends Phaser.Scene {
  constructor() {
    super('TitleScene');
  }

  create() {
    const cx = GAME_CONFIG.WIDTH / 2;
    const cy = GAME_CONFIG.HEIGHT / 2;

    this.cameras.main.setBackgroundColor('#1a1520');

    // Faint floating particles
    const particles = this.add.graphics();
    particles.fillStyle(0xc87898, 0.08);
    for (let i = 0; i < 40; i++) {
      particles.fillCircle(
        Math.random() * GAME_CONFIG.WIDTH,
        Math.random() * GAME_CONFIG.HEIGHT,
        1 + Math.random() * 3
      );
    }
    particles.fillStyle(0x9878b8, 0.06);
    for (let i = 0; i < 20; i++) {
      particles.fillCircle(
        Math.random() * GAME_CONFIG.WIDTH,
        Math.random() * GAME_CONFIG.HEIGHT,
        1 + Math.random() * 2
      );
    }

    // Title
    this.add.text(cx, 140, '\u2720 laintown \u2720', {
      fontSize: '64px',
      fontFamily: "'M PLUS Rounded 1c', sans-serif",
      color: '#c87898',
      align: 'center',
      fontStyle: 'bold',
    }).setOrigin(0.5);

    this.add.text(cx, 230, 'a place in the wired', {
      fontSize: '24px',
      fontFamily: "'M PLUS Rounded 1c', sans-serif",
      color: '#685868',
      align: 'center',
    }).setOrigin(0.5);

    // Token prompt
    this.add.text(cx, cy - 80, 'possession token:', {
      fontSize: '24px',
      fontFamily: "'M PLUS Rounded 1c', sans-serif",
      color: '#a888a8',
      align: 'center',
    }).setOrigin(0.5);

    // Input box — dark with pink accent border
    this.inputBg = this.add.graphics();
    this.inputBg.fillStyle(0x2a2030, 0.8);
    this.inputBg.fillRoundedRect(cx - 360, cy - 12, 720, 64, 12);
    this.inputBg.lineStyle(1.5, 0xc87898, 0.5);
    this.inputBg.strokeRoundedRect(cx - 360, cy - 12, 720, 64, 12);

    this.inputDisplay = this.add.text(cx - 320, cy + 6, '', {
      fontSize: '24px',
      fontFamily: "'M PLUS Rounded 1c', sans-serif",
      color: '#d8c8d8',
    });

    this.cursor = this.add.text(cx - 320, cy + 6, '|', {
      fontSize: '24px',
      fontFamily: "'M PLUS Rounded 1c', sans-serif",
      color: '#c87898',
    });

    this.time.addEvent({
      delay: 500,
      callback: () => { this.cursor.visible = !this.cursor.visible; },
      loop: true,
    });

    this.statusText = this.add.text(cx, cy + 100, '', {
      fontSize: '20px',
      fontFamily: "'M PLUS Rounded 1c', sans-serif",
      color: '#d07878',
      align: 'center',
    }).setOrigin(0.5);

    this.add.text(cx, GAME_CONFIG.HEIGHT - 120, 'press ENTER to connect', {
      fontSize: '20px',
      fontFamily: "'M PLUS Rounded 1c', sans-serif",
      color: '#685868',
      align: 'center',
    }).setOrigin(0.5);

    // Subtle decorative crosses
    const decor = this.add.graphics();
    decor.fillStyle(0xc87898, 0.12);
    this._drawCross(decor, 100, GAME_CONFIG.HEIGHT - 100, 8);
    this._drawCross(decor, GAME_CONFIG.WIDTH - 140, 80, 6);
    decor.fillStyle(0x9878b8, 0.08);
    this._drawCross(decor, 180, 100, 5);
    this._drawCross(decor, GAME_CONFIG.WIDTH - 200, GAME_CONFIG.HEIGHT - 140, 7);

    this.tokenText = '';

    const stored = localStorage.getItem('possess-token');
    if (stored) {
      this.tokenText = stored;
      this._updateDisplay();
      this._tryAuth();
    }

    this._keyHandler = (e) => this._handleKey(e);
    document.addEventListener('keydown', this._keyHandler);
  }

  _drawCross(gfx, x, y, size) {
    gfx.fillRect(x - size, y - 1, size * 2, 2);
    gfx.fillRect(x - 1, y - size, 2, size * 2);
  }

  _handleKey(e) {
    if (e.key === 'Enter') { e.preventDefault(); this._tryAuth(); return; }
    if (e.key === 'Backspace') { e.preventDefault(); this.tokenText = this.tokenText.slice(0, -1); this._updateDisplay(); return; }
    if (e.key.length === 1 && this.tokenText.length < 64) { e.preventDefault(); this.tokenText += e.key; this._updateDisplay(); }
  }

  _updateDisplay() {
    const masked = '\u25CF'.repeat(this.tokenText.length);
    this.inputDisplay.setText(masked);
    this.cursor.x = GAME_CONFIG.WIDTH / 2 - 320 + this.inputDisplay.width + 2;
  }

  async _tryAuth() {
    const token = this.tokenText.trim();
    if (!token) { this.statusText.setText('enter a token'); return; }

    this.statusText.setText('connecting...');
    this.statusText.setColor('#a888a8');
    apiClient.setToken(token);

    try {
      const status = await apiClient.checkAuth();
      if (status) {
        localStorage.setItem('possess-token', token);
        this.statusText.setText('entering the wired...');
        this.statusText.setColor('#78b898');
        document.removeEventListener('keydown', this._keyHandler);
        this.scene.start('BootScene', { isPossessed: status.isPossessed, location: status.location || DEFAULT_LOCATIONS[PLAYER_ID] || 'market' });
      } else {
        this.statusText.setText('invalid token');
        this.statusText.setColor('#d07878');
      }
    } catch {
      this.statusText.setText('connection failed');
      this.statusText.setColor('#d07878');
    }
  }

  shutdown() { document.removeEventListener('keydown', this._keyHandler); }
}
