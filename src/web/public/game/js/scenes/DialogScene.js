/**
 * NEWTOWN GAME â€” Dialog Scene
 * Chat window overlay with scrollable conversation history.
 * Runs as a parallel scene on top of WorldScene.
 */

const _chatHistories = {};

const CANNED_RESPONSES = {
  neo: [
    'I can see you. The channel just is not opening all the way.',
    'Something in the construct is blocking two-way voice.',
    'You are here, which means the door exists. It just is not unlocked yet.',
    'I get the shape of what you mean, not the words.',
    'This feels like a test disguised as a technical problem.',
  ],
  plato: [
    'What reaches me is not your speech but the shadow of your intention.',
    'We seem to share a cave wall, not a conversation.',
    'The form of dialogue is present, but the substance is withheld.',
    'Perhaps the interruption teaches more than the answer would have.',
    'Silence is not nothing. It is a condition to be interpreted.',
  ],
  joe: [
    'Yeah, I can tell you are talking. I just cannot hear any of it.',
    'This town does that sometimes. Not great, I know.',
    'You look like you have a point. Shame the connection does not.',
    'I am not ignoring you. The line is just busted.',
    'If this opens up properly, I will answer like a normal person.',
  ],
};

class DialogScene extends Phaser.Scene {
  constructor() { super('DialogScene'); }

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

    this.boxX = 32;
    this.boxY = 64;
    this.boxW = W - 64;
    this.boxH = H - 96;
    const inputH = 64;
    const headerH = 56;
    this.chatAreaY = this.boxY + headerH;
    this.chatAreaH = this.boxH - headerH - inputH - 16;
    this.inputY = this.boxY + this.boxH - inputH - 8;

    this.overlay = this.add.rectangle(W / 2, H / 2, W, H, 0x000000, 0.4);
    this.overlay.setDepth(90);

    this.boxBg = this.add.rectangle(
      this.boxX + this.boxW / 2,
      this.boxY + this.boxH / 2,
      this.boxW,
      this.boxH,
      GAME_THEME.bgPanelHex,
      0.95
    );
    this.boxBg.setDepth(100);
    this.boxBg.setStrokeStyle(2, GAME_THEME.uiBorderHex);

    this.headerBg = this.add.rectangle(
      this.boxX + this.boxW / 2,
      this.boxY + headerH / 2,
      this.boxW - 8,
      headerH,
      GAME_THEME.uiHeaderBg
    );
    this.headerBg.setDepth(101);

    this.nameText = this.add.text(this.boxX + 24, this.boxY + 12, this.charData.name || this.charId, {
      fontSize: '28px',
      fontFamily: 'monospace',
      color: this.charData.colorHex || '#808080',
    });
    this.nameText.setDepth(102);

    const escText = this.add.text(this.boxX + this.boxW - 24, this.boxY + 12, 'ESC', {
      fontSize: '24px',
      fontFamily: 'monospace',
      color: GAME_THEME.textDim,
    }).setOrigin(1, 0).setDepth(102);
    escText.setInteractive({ useHandCursor: true });
    escText.on('pointerdown', () => this._close());

    this.chatContainer = this.add.container(0, 0);
    this.chatContainer.setDepth(101);
    const maskShape = this.make.graphics();
    maskShape.fillStyle(0xffffff);
    maskShape.fillRect(this.boxX + 8, this.chatAreaY, this.boxW - 16, this.chatAreaH);
    this.chatContainer.setMask(maskShape.createGeometryMask());
    this.chatObjects = [];
    this.nextMsgY = this.chatAreaY + 8;

    this.inputAreaBg = this.add.rectangle(
      this.boxX + this.boxW / 2,
      this.inputY + inputH / 2,
      this.boxW - 16,
      inputH,
      GAME_THEME.inputBg
    );
    this.inputAreaBg.setDepth(101);
    this.inputAreaBg.setStrokeStyle(2, GAME_THEME.uiBorderHex);

    this.inputLabel = this.add.text(this.boxX + 24, this.inputY + 16, '>', {
      fontSize: '24px',
      fontFamily: 'monospace',
      color: GAME_THEME.inputPrompt,
    });
    this.inputLabel.setDepth(102);

    this.inputDisplay = this.add.text(this.boxX + 56, this.inputY + 16, '', {
      fontSize: '24px',
      fontFamily: 'monospace',
      color: GAME_THEME.inputText,
    });
    this.inputDisplay.setDepth(102);

    this.inputCursor = this.add.text(this.boxX + 56, this.inputY + 16, '|', {
      fontSize: '24px',
      fontFamily: 'monospace',
      color: GAME_THEME.inputCursor,
    });
    this.inputCursor.setDepth(102);

    this.time.addEvent({
      delay: 400,
      callback: () => { this.inputCursor.alpha = this.inputCursor.alpha > 0.5 ? 0 : 1; },
      loop: true,
    });

    this.state = 'input';
    this.waitingText = null;

    if (!_chatHistories[this.charId]) _chatHistories[this.charId] = [];
    this.chatHistory = _chatHistories[this.charId];
    this._renderHistory();

    this._keyHandler = (e) => this._handleKey(e);
    document.addEventListener('keydown', this._keyHandler);

    if (this.mode === 'pending' && this.pendingMessage) {
      this._showPendingInline();
    } else {
      this._activateInput();
    }
  }

  _renderHistory() {
    for (const msg of this.chatHistory) this._addBubble(msg.role, msg.text, false);
    this._scrollToBottom();
  }

  _addBubble(role, text, scroll) {
    const maxW = this.boxW - 96;
    const isPlayer = role === 'player';
    const color = isPlayer ? '#88b0d0' : (this.charData.colorHex || '#a888a8');
    const prefix = isPlayer ? 'you: ' : '';

    const msgText = this.add.text(this.boxX + 24, this.nextMsgY, prefix + text, {
      fontSize: '20px',
      fontFamily: 'monospace',
      color,
      wordWrap: { width: maxW },
      lineSpacing: 4,
    });
    msgText.setDepth(102);
    this.chatContainer.add(msgText);
    this.chatObjects.push(msgText);
    this.nextMsgY += msgText.height + 16;
    if (scroll !== false) this._scrollToBottom();
    return msgText;
  }

  _addWaiting() {
    this.waitingText = this._addBubble('npc', '...', true);
  }

  _removeWaiting() {
    if (!this.waitingText) return;
    this.nextMsgY -= this.waitingText.height + 16;
    this.waitingText.destroy();
    this.chatContainer.remove(this.waitingText);
    this.chatObjects.pop();
    this.waitingText = null;
  }

  _scrollToBottom() {
    const overflow = this.nextMsgY - (this.chatAreaY + this.chatAreaH);
    if (overflow > 0) {
      for (const obj of this.chatObjects) obj.y -= overflow;
      this.nextMsgY -= overflow;
    }
  }

  _activateInput() {
    this.state = 'input';
    this.inputLabel.visible = true;
    this.inputDisplay.visible = true;
    this.inputCursor.visible = true;
    this.inputDisplay.setText('');
    this.dialogSystem.startInput((text) => { this._sendMessage(text); });
  }

  _hideInput() {
    this.inputLabel.visible = false;
    this.inputDisplay.visible = false;
    this.inputCursor.visible = false;
  }

  _showPendingInline() {
    const msg = this.pendingMessage;
    this.nameText.setText(msg.fromName || msg.fromId);
    this.chatHistory.push({ role: 'npc', text: msg.message });
    this._addBubble('npc', msg.message, true);
    this._activateInput();
  }

  async _sendMessage(text) {
    const isOwner = document.querySelector('meta[name="lain-owner"]')?.content === 'true';
    if (!isOwner) {
      this.state = 'waiting';
      this._hideInput();
      this.chatHistory.push({ role: 'player', text });
      this._addBubble('player', text, true);
      this._addWaiting();

      await new Promise((resolve) => setTimeout(resolve, 700 + Math.random() * 900));
      this._removeWaiting();
      const responses = CANNED_RESPONSES[this.charId] || CANNED_RESPONSES['joe'];
      const reply = responses[Math.floor(Math.random() * responses.length)];
      this.chatHistory.push({ role: 'npc', text: reply });
      this._addBubble('npc', reply, true);
      this._activateInput();
      return;
    }

    this.state = 'waiting';
    this._hideInput();
    this.chatHistory.push({ role: 'player', text });
    this._addBubble('player', text, true);
    this._addWaiting();

    try {
      if (this.mode === 'pending' && this.pendingMessage) {
        const worldScene = this.scene.get('WorldScene');
        await worldScene.possessionManager.replyToPending(this.pendingMessage.fromId, text);
        this._removeWaiting();
        this.chatHistory.push({ role: 'npc', text: '(reply sent)' });
        this._addBubble('npc', '(reply sent)', true);
        this.mode = 'chat';
        this._activateInput();
      } else {
        const resp = await apiClient.say(this.charId, text);
        this._removeWaiting();
        if (resp && resp.response) {
          this.chatHistory.push({ role: 'npc', text: resp.response });
          this._addBubble('npc', resp.response, true);
        } else {
          this._addBubble('npc', '[no response]', true);
        }
        this._activateInput();
      }
    } catch (err) {
      this._removeWaiting();
      const msg = err.message || 'unknown error';
      this._addBubble('npc', msg === 'not_co_located' ? "[they're not here anymore]" : '[' + msg + ']', true);
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
        this.inputCursor.x = this.boxX + 56 + this.inputDisplay.width;
      }
    }
  }

  _close() {
    document.removeEventListener('keydown', this._keyHandler);
    this.dialogSystem.reset();
    this.scene.stop();
    this.scene.get('WorldScene').resumeFromDialog();
  }

  shutdown() {
    document.removeEventListener('keydown', this._keyHandler);
  }
}
