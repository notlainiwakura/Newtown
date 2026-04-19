/**
 * NEWTOWN GAME — Title Scene
 * Auth screen + title. Handles token input and possession start.
 */

class TitleScene extends Phaser.Scene {
  constructor() {
    super('TitleScene');
  }

  create() {
    const cx = GAME_CONFIG.WIDTH / 2;
    const cy = GAME_CONFIG.HEIGHT / 2;
    const isOwner = document.querySelector('meta[name="lain-owner"]')?.content === 'true';
    window._mobileState = 'title';

    // Title
    this.add.text(cx, 160, 'NEWTOWN', {
      fontSize: '72px',
      fontFamily: 'monospace',
      color: GAME_THEME.accentSecondary,
      align: 'center',
    }).setOrigin(0.5);

    this.add.text(cx, 260, 'a place in the town', {
      fontSize: '28px',
      fontFamily: 'monospace',
      color: GAME_THEME.uiBorder,
      align: 'center',
    }).setOrigin(0.5);

    // Spectator mode — no token prompt, enter directly as observer
    if (!isOwner) {
      this.add.text(cx, cy, 'spectator mode', {
        fontSize: '28px',
        fontFamily: 'monospace',
        color: '#60a0a0',
        align: 'center',
      }).setOrigin(0.5);

      this.add.text(cx, cy + 60, 'you may observe the town, but cannot possess its inhabitants.', {
        fontSize: '18px',
        fontFamily: 'monospace',
        color: '#405060',
        align: 'center',
        wordWrap: { width: 600 },
      }).setOrigin(0.5);

      this.add.text(cx, GAME_CONFIG.HEIGHT - 120, 'ENTER to observe', {
        fontSize: '24px',
        fontFamily: 'monospace',
        color: '#405060',
        align: 'center',
      }).setOrigin(0.5);

      this._keyHandler = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          document.removeEventListener('keydown', this._keyHandler);
          this.scene.start('BootScene', {
            isPossessed: false,
            location: DEFAULT_LOCATIONS[PLAYER_ID] || 'square',
            spectatorMode: true,
          });
        }
      };
      document.addEventListener('keydown', this._keyHandler);
      return;
    }

    // Owner — skip token prompt, enter directly as possessor
    this.add.text(cx, cy, 'entering the wired...', {
      fontSize: '28px',
      fontFamily: 'monospace',
      color: GAME_THEME.statusOnline || '#40ff90',
      align: 'center',
    }).setOrigin(0.5);

    this.time.delayedCall(500, () => {
      this.scene.start('BootScene', {
        isPossessed: true,
        location: DEFAULT_LOCATIONS[PLAYER_ID] || 'square',
      });
    });
    return;

    // Token prompt (legacy — kept for reference)
    this.add.text(cx, cy - 80, 'possession token:', {
      fontSize: '28px',
      fontFamily: 'monospace',
      color: GAME_THEME.inputPrompt,
      align: 'center',
    }).setOrigin(0.5);

    // Input box background
    this.inputBg = this.add.rectangle(cx, cy + 20, 720, 64, GAME_THEME.inputBg);
    this.inputBg.setStrokeStyle(2, GAME_THEME.uiBorderHex);

    // Input text display
    this.inputDisplay = this.add.text(cx - 340, cy + 4, '', {
      fontSize: '28px',
      fontFamily: 'monospace',
      color: GAME_THEME.inputText,
    });

    // Cursor blink
    this.cursor = this.add.text(cx - 340, cy + 4, '_', {
      fontSize: '28px',
      fontFamily: 'monospace',
      color: GAME_THEME.inputCursor,
    });

    this.time.addEvent({
      delay: 500,
      callback: () => {
        this.cursor.visible = !this.cursor.visible;
      },
      loop: true,
    });

    // Status text
    this.statusText = this.add.text(cx, cy + 120, '', {
      fontSize: '24px',
      fontFamily: 'monospace',
      color: GAME_THEME.statusError,
      align: 'center',
    }).setOrigin(0.5);

    // Instructions
    this.add.text(cx, GAME_CONFIG.HEIGHT - 120, 'ENTER to connect', {
      fontSize: '24px',
      fontFamily: 'monospace',
      color: GAME_THEME.textDim,
      align: 'center',
    }).setOrigin(0.5);

    // Input state
    this.tokenText = '';

    // Check for stored token
    const stored = localStorage.getItem('possess-token');
    if (stored) {
      this.tokenText = stored;
      this._updateDisplay();
      this._tryAuth();
    }

    // Keyboard input — use DOM event for text input
    this._keyHandler = (e) => this._handleKey(e);
    document.addEventListener('keydown', this._keyHandler);
  }

  _handleKey(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      this._tryAuth();
      return;
    }

    if (e.key === 'Backspace') {
      e.preventDefault();
      this.tokenText = this.tokenText.slice(0, -1);
      this._updateDisplay();
      return;
    }

    // Printable char
    if (e.key.length === 1 && this.tokenText.length < 64) {
      e.preventDefault();
      this.tokenText += e.key;
      this._updateDisplay();
    }
  }

  _updateDisplay() {
    // Show masked token
    const masked = '*'.repeat(this.tokenText.length);
    this.inputDisplay.setText(masked);
    const cx = GAME_CONFIG.WIDTH / 2;
    this.cursor.x = cx - 340 + this.inputDisplay.width;
  }

  async _tryAuth() {
    const token = this.tokenText.trim();
    if (!token) {
      this.statusText.setText('enter a token');
      return;
    }

    this.statusText.setText('connecting...');
    this.statusText.setColor(GAME_THEME.inputPrompt);

    apiClient.setToken(token);

    try {
      const status = await apiClient.checkAuth();
      if (status) {
        localStorage.setItem('possess-token', token);
        this.statusText.setText('entering the wired...');
        this.statusText.setColor(GAME_THEME.statusOnline);

        // Pass auth info to next scene
        document.removeEventListener('keydown', this._keyHandler);
        this.scene.start('BootScene', {
          isPossessed: status.isPossessed,
          location: status.location || DEFAULT_LOCATIONS[PLAYER_ID] || 'square',
        });
      } else {
        this.statusText.setText('invalid token');
        this.statusText.setColor(GAME_THEME.statusError);
      }
    } catch {
      this.statusText.setText('connection failed');
      this.statusText.setColor(GAME_THEME.statusError);
    }
  }

  shutdown() {
    document.removeEventListener('keydown', this._keyHandler);
  }
}
