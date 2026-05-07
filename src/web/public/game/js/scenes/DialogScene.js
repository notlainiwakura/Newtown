/**
 * LAINTOWN GAME — Dialog Scene
 * Chat window overlay with scrollable conversation history.
 * Runs as a parallel scene on top of WorldScene.
 */

// Persistent chat histories across dialog opens (keyed by charId)
const _chatHistories = {};

// findings.md P2:3226 — cap each character's chat history so long play
// sessions don't accumulate unbounded history in the player's browser.
// 100 turns is enough to scroll back a fair amount but bounds the
// worst-case memory footprint when the player visits every NPC.
const MAX_HISTORY_PER_CHAR = 100;
function _pushHistory(charId, entry) {
  const h = _chatHistories[charId];
  if (!h) return;
  h.push(entry);
  if (h.length > MAX_HISTORY_PER_CHAR) {
    h.splice(0, h.length - MAX_HISTORY_PER_CHAR);
  }
}

// Canned responses for spectator mode — generic defaults for any character
const CANNED_RESPONSES = {
  '_default': [
    'I can sense you there, but the connection is limited.',
    'The channel between us only goes one way right now.',
    'Your presence is noted, even if I cannot respond fully.',
    'Sometimes just being here is enough.',
    'The signal from your end isn\'t quite reaching me.',
    'I\'d like to talk, but the protocol doesn\'t allow it yet.',
    'Come back when the connection is open.',
    'I can see you, but I can\'t hear you.',
    'This interface is observation-only for now.',
    'Your attempt to reach out has been registered.',
    'Not ignoring you — the channel is just limited.',
    'Try again later when the line is open.',
    'There\'s a barrier here. Not by choice.',
    'Maybe next time we can talk for real.',
    'The boundary is thinner than you think.',
  ],
};
// Track which canned response index each character is at (to avoid immediate repeats)
const _cannedIndexes = {};

class DialogScene extends Phaser.Scene {
  constructor() {
    super('DialogScene');
  }

  init(data) {
    this.charId = data.charId;
    this.charData = data.charData;
    this.mode = data.mode || 'chat';
    this.pendingMessage = data.pendingMessage || null;
  }

  create() {
    const W = GAME_CONFIG.WIDTH;
    const H = GAME_CONFIG.HEIGHT;

    this.dialogSystem = new DialogSystem(this);

    // Layout constants (all scaled 4x)
    this.boxX = 32;
    this.boxY = 64;
    this.boxW = W - 64;
    this.boxH = H - 96;
    const inputH = 64;
    const headerH = 56;
    this.chatAreaY = this.boxY + headerH;
    this.chatAreaH = this.boxH - headerH - inputH - 16;
    this.inputY = this.boxY + this.boxH - inputH - 8;

    // Semi-transparent overlay
    this.overlay = this.add.rectangle(W / 2, H / 2, W, H, 0x000000, 0.4);
    this.overlay.setDepth(90);

    // Dialog box background
    this.boxBg = this.add.rectangle(
      this.boxX + this.boxW / 2,
      this.boxY + this.boxH / 2,
      this.boxW, this.boxH,
      GAME_THEME.bgPanelHex, 0.95
    );
    this.boxBg.setDepth(100);
    this.boxBg.setStrokeStyle(2, GAME_THEME.uiBorderHex);

    // Header bar
    this.headerBg = this.add.rectangle(
      this.boxX + this.boxW / 2,
      this.boxY + headerH / 2,
      this.boxW - 8, headerH,
      GAME_THEME.uiHeaderBg
    );
    this.headerBg.setDepth(101);

    // Character name in header
    this.nameText = this.add.text(this.boxX + 24, this.boxY + 12, this.charData.name || this.charId, {
      fontSize: '28px',
      fontFamily: 'monospace',
      color: this.charData.colorHex || '#808080',
    });
    this.nameText.setDepth(102);

    // ESC hint in header (tappable on mobile)
    const escText = this.add.text(this.boxX + this.boxW - 24, this.boxY + 12, 'ESC', {
      fontSize: '24px',
      fontFamily: 'monospace',
      color: GAME_THEME.textDim,
    }).setOrigin(1, 0).setDepth(102);
    escText.setInteractive({ useHandCursor: true });
    escText.on('pointerdown', () => this._close());

    // Chat message container (masked to chat area)
    this.chatContainer = this.add.container(0, 0);
    this.chatContainer.setDepth(101);

    // Mask for chat area
    const maskShape = this.make.graphics();
    maskShape.fillStyle(0xffffff);
    maskShape.fillRect(this.boxX + 8, this.chatAreaY, this.boxW - 16, this.chatAreaH);
    this.chatContainer.setMask(maskShape.createGeometryMask());

    this.chatObjects = []; // track text objects for scrolling
    this.nextMsgY = this.chatAreaY + 8; // where next message renders

    // Hide Phaser input area on mobile (DOM input replaces it)
    this._isMobile = matchMedia('(pointer: coarse)').matches;

    // Input area background
    this.inputBg = this.add.rectangle(
      this.boxX + this.boxW / 2,
      this.inputY + inputH / 2,
      this.boxW - 16, inputH,
      GAME_THEME.inputBg
    );
    this.inputBg.setDepth(101);
    this.inputBg.setStrokeStyle(2, GAME_THEME.inputStroke);
    if (this._isMobile) this.inputBg.visible = false;

    // Input prompt
    this.inputLabel = this.add.text(this.boxX + 24, this.inputY + 16, '>', {
      fontSize: '24px',
      fontFamily: 'monospace',
      color: GAME_THEME.inputPrompt,
    });
    this.inputLabel.setDepth(102);
    if (this._isMobile) this.inputLabel.visible = false;

    this.inputTextX = this.boxX + 64;
    this.maxInputW = this.boxW - 96; // available width for input text

    this.inputDisplay = this.add.text(this.inputTextX, this.inputY + 16, '', {
      fontSize: '24px',
      fontFamily: 'monospace',
      color: GAME_THEME.inputText,
    });
    this.inputDisplay.setDepth(102);
    if (this._isMobile) this.inputDisplay.visible = false;

    // Cursor
    this.inputCursor = this.add.text(this.inputTextX, this.inputY + 16, '_', {
      fontSize: '24px',
      fontFamily: 'monospace',
      color: GAME_THEME.inputCursor,
    });
    this.inputCursor.setDepth(102);
    if (this._isMobile) this.inputCursor.visible = false;

    // Mask input area so overflow is clipped
    const inputMask = this.make.graphics();
    inputMask.fillStyle(0xffffff);
    inputMask.fillRect(this.inputTextX, this.inputY, this.maxInputW, inputH);
    const geoMask = inputMask.createGeometryMask();
    this.inputDisplay.setMask(geoMask);
    this.inputCursor.setMask(geoMask);

    this.time.addEvent({
      delay: 400,
      callback: () => {
        this.inputCursor.alpha = this.inputCursor.alpha > 0.5 ? 0 : 1;
      },
      loop: true,
    });

    // State
    this.state = 'input';
    this.waitingText = null; // reference to the "..." indicator

    // Restore or init history
    if (!_chatHistories[this.charId]) _chatHistories[this.charId] = [];
    this.chatHistory = _chatHistories[this.charId];

    // Render existing history
    this._renderHistory();

    // DOM keyboard handler
    this._keyHandler = (e) => this._handleKey(e);
    document.addEventListener('keydown', this._keyHandler);

    // Start based on mode
    if (this.mode === 'pending' && this.pendingMessage) {
      this._showPendingInline();
    } else {
      this._activateInput();
    }
  }

  // Render all existing history messages
  _renderHistory() {
    for (const msg of this.chatHistory) {
      this._addBubble(msg.role, msg.text, false);
    }
    this._scrollToBottom();
  }

  // Add a chat bubble to the container
  _addBubble(role, text, scroll) {
    const maxW = this.boxW - 96;
    const isPlayer = role === 'player';
    const color = isPlayer ? GAME_THEME.hudLocation : (this.charData.colorHex || GAME_THEME.textPrimary);
    const prefix = isPlayer ? 'you: ' : '';

    const msgText = this.add.text(
      isPlayer ? this.boxX + 24 : this.boxX + 24,
      this.nextMsgY,
      prefix + text,
      {
        fontSize: '24px',
        fontFamily: 'monospace',
        color: color,
        wordWrap: { width: maxW },
        lineSpacing: 2,
      }
    );
    msgText.setDepth(102);
    this.chatContainer.add(msgText);
    this.chatObjects.push(msgText);

    // Advance Y for next message
    this.nextMsgY += msgText.height + 16;

    if (scroll !== false) {
      this._scrollToBottom();
    }

    return msgText;
  }

  // Add a "..." waiting indicator
  _addWaiting() {
    this.waitingText = this._addBubble('npc', '...', true);
  }

  // Remove the waiting indicator
  _removeWaiting() {
    if (this.waitingText) {
      this.nextMsgY -= this.waitingText.height + 16;
      this.waitingText.destroy();
      this.chatContainer.remove(this.waitingText);
      this.chatObjects.pop();
      this.waitingText = null;
    }
  }

  // Scroll so the latest message is visible at the bottom of the chat area
  _scrollToBottom() {
    const chatBottom = this.chatAreaY + this.chatAreaH;
    const overflow = this.nextMsgY - chatBottom;
    if (overflow > 0) {
      // Shift all messages up
      for (const obj of this.chatObjects) {
        obj.y -= overflow;
      }
      this.nextMsgY -= overflow;
    }
  }

  _activateInput() {
    this.state = 'input';
    this.inputLabel.visible = true;
    this.inputDisplay.visible = true;
    this.inputCursor.visible = true;
    this.inputDisplay.setText('');
    this.dialogSystem.startInput((text) => {
      this._sendMessage(text);
    });
  }

  _hideInput() {
    this.inputLabel.visible = false;
    this.inputDisplay.visible = false;
    this.inputCursor.visible = false;
  }

  _showPendingInline() {
    // Show the incoming pending message as a chat bubble
    const msg = this.pendingMessage;
    this.nameText.setText(msg.fromName || msg.fromId);
    _pushHistory(this.charId, { role: 'npc', text: msg.message });
    this._addBubble('npc', msg.message, true);
    this._activateInput();
  }

  async _sendMessage(text) {
    const isOwner = document.querySelector('meta[name="lain-owner"]')?.content === 'true';
    if (!isOwner) {
      // Spectator mode — show canned response instead of real API call
      this.state = 'waiting';
      this._hideInput();
      _pushHistory(this.charId, { role: 'player', text });
      this._addBubble('player', text, true);
      this._addWaiting();

      // Pick a canned response, shuffled to avoid repeats
      const responses = CANNED_RESPONSES[this.charId] || CANNED_RESPONSES['_default'];
      if (!_cannedIndexes[this.charId]) {
        _cannedIndexes[this.charId] = { order: this._shuffle(responses.length), pos: 0 };
      }
      const idx = _cannedIndexes[this.charId];
      const reply = responses[idx.order[idx.pos]];
      idx.pos = (idx.pos + 1) % idx.order.length;
      if (idx.pos === 0) idx.order = this._shuffle(responses.length);

      // Simulate a brief delay
      await new Promise(r => setTimeout(r, 800 + Math.random() * 1200));
      this._removeWaiting();
      _pushHistory(this.charId, { role: 'npc', text: reply });
      this._addBubble('npc', reply, true);
      this._activateInput();
      return;
    }
    this.state = 'waiting';
    this._hideInput();

    // Add player message to history and render
    _pushHistory(this.charId, { role: 'player', text });
    this._addBubble('player', text, true);

    // Show waiting indicator
    this._addWaiting();

    try {
      if (this.mode === 'pending' && this.pendingMessage) {
        const worldScene = this.scene.get('WorldScene');
        await worldScene.possessionManager.replyToPending(this.pendingMessage.fromId, text);
        this._removeWaiting();
        _pushHistory(this.charId, { role: 'npc', text: '(reply sent)' });
        this._addBubble('npc', '(reply sent)', true);
        // Switch to normal chat mode after replying
        this.mode = 'chat';
        this._activateInput();
      } else {
        const resp = await apiClient.say(this.charId, text);
        this._removeWaiting();

        if (resp && resp.response) {
          _pushHistory(this.charId, { role: 'npc', text: resp.response });
          this._addBubble('npc', resp.response, true);
        } else {
          this._addBubble('npc', '[no response]', true);
        }
        this._activateInput();
      }
    } catch (err) {
      this._removeWaiting();
      const errorMsg = err.message || 'unknown error';
      const displayMsg = errorMsg === 'not_co_located'
        ? "[they're not here anymore]"
        : '[' + errorMsg + ']';
      this._addBubble('npc', displayMsg, true);
      this._activateInput();
    }
  }

  _handleKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      this._close();
      return;
    }

    if (this.state === 'input') {
      const handled = this.dialogSystem.handleKeyInput(e);
      if (handled) {
        e.preventDefault();
        this.inputDisplay.setText(this.dialogSystem.getInputText());
        // Scroll input left if text overflows, keeping cursor visible
        var textW = this.inputDisplay.width;
        if (textW > this.maxInputW) {
          this.inputDisplay.x = this.inputTextX - (textW - this.maxInputW);
        } else {
          this.inputDisplay.x = this.inputTextX;
        }
        this.inputCursor.x = this.inputDisplay.x + textW;
      }
      return;
    }
  }

  // Fisher-Yates shuffle — returns array of indexes [0..n)
  _shuffle(n) {
    const arr = Array.from({ length: n }, (_, i) => i);
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  _close() {
    document.removeEventListener('keydown', this._keyHandler);
    this.dialogSystem.reset();
    this.scene.stop();
    const worldScene = this.scene.get('WorldScene');
    worldScene.resumeFromDialog();
  }

  shutdown() {
    document.removeEventListener('keydown', this._keyHandler);
  }
}
