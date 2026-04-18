/**
 * LAINTOWN GAME — Dialog Scene (Yami Kawaii ✟)
 */

const _chatHistories = {};

class DialogScene extends Phaser.Scene {
  constructor() { super('DialogScene'); }

  init(data) {
    this.charId = data.charId;
    this.charData = data.charData;
    this.mode = data.mode || 'chat';
    this.pendingMessage = data.pendingMessage || null;
  }

  create() {
    const W = GAME_CONFIG.WIDTH, H = GAME_CONFIG.HEIGHT;
    this.dialogSystem = new DialogSystem(this);

    this.boxX = 32; this.boxY = 64;
    this.boxW = W - 64; this.boxH = H - 96;
    const inputH = 64, headerH = 56;
    this.chatAreaY = this.boxY + headerH;
    this.chatAreaH = this.boxH - headerH - inputH - 16;
    this.inputY = this.boxY + this.boxH - inputH - 8;

    // Overlay
    this.overlay = this.add.rectangle(W / 2, H / 2, W, H, 0x000000, 0.35);
    this.overlay.setDepth(90);

    // Dialog box
    this.boxBg = this.add.graphics();
    this.boxBg.setDepth(100);
    this.boxBg.fillStyle(0x1a1520, 0.97);
    this.boxBg.fillRoundedRect(this.boxX, this.boxY, this.boxW, this.boxH, 12);
    this.boxBg.lineStyle(2, 0xc87898, 0.45);
    this.boxBg.strokeRoundedRect(this.boxX, this.boxY, this.boxW, this.boxH, 12);

    // Header
    this.headerBg = this.add.graphics();
    this.headerBg.setDepth(101);
    this.headerBg.fillStyle(0x2a2030, 0.9);
    this.headerBg.fillRoundedRect(this.boxX + 4, this.boxY + 4, this.boxW - 8, headerH, { tl: 10, tr: 10, bl: 0, br: 0 });

    this.nameText = this.add.text(this.boxX + 24, this.boxY + 14, '✟ ' + (this.charData.name || this.charId), {
      fontSize: '24px', fontFamily: "'M PLUS Rounded 1c', sans-serif",
      color: this.charData.colorHex || '#685868', fontStyle: 'bold',
    });
    this.nameText.setDepth(102);

    this.add.text(this.boxX + this.boxW - 24, this.boxY + 16, 'ESC', {
      fontSize: '18px', fontFamily: "'M PLUS Rounded 1c', sans-serif", color: '#685868',
    }).setOrigin(1, 0).setDepth(102);

    // Chat container
    this.chatContainer = this.add.container(0, 0);
    this.chatContainer.setDepth(101);
    const maskShape = this.make.graphics();
    maskShape.fillStyle(0xffffff);
    maskShape.fillRect(this.boxX + 8, this.chatAreaY, this.boxW - 16, this.chatAreaH);
    this.chatContainer.setMask(maskShape.createGeometryMask());
    this.chatObjects = [];
    this.nextMsgY = this.chatAreaY + 8;

    // Input area
    this.inputAreaBg = this.add.graphics();
    this.inputAreaBg.setDepth(101);
    this.inputAreaBg.fillStyle(0x2a2030, 0.6);
    this.inputAreaBg.fillRoundedRect(this.boxX + 8, this.inputY, this.boxW - 16, inputH, 10);
    this.inputAreaBg.lineStyle(1, 0xc87898, 0.2);
    this.inputAreaBg.strokeRoundedRect(this.boxX + 8, this.inputY, this.boxW - 16, inputH, 10);

    this.inputLabel = this.add.text(this.boxX + 24, this.inputY + 18, '✟', {
      fontSize: '22px', fontFamily: "'M PLUS Rounded 1c', sans-serif", color: '#c87898',
    });
    this.inputLabel.setDepth(102);

    this.inputDisplay = this.add.text(this.boxX + 56, this.inputY + 18, '', {
      fontSize: '22px', fontFamily: "'M PLUS Rounded 1c', sans-serif", color: '#d8c8d8',
    });
    this.inputDisplay.setDepth(102);

    this.inputCursor = this.add.text(this.boxX + 56, this.inputY + 18, '|', {
      fontSize: '22px', fontFamily: "'M PLUS Rounded 1c', sans-serif", color: '#c87898',
    });
    this.inputCursor.setDepth(102);

    this.time.addEvent({ delay: 400, callback: () => { this.inputCursor.alpha = this.inputCursor.alpha > 0.5 ? 0 : 1; }, loop: true });

    this.state = 'input';
    this.waitingText = null;

    if (!_chatHistories[this.charId]) _chatHistories[this.charId] = [];
    this.chatHistory = _chatHistories[this.charId];
    this._renderHistory();

    this._keyHandler = (e) => this._handleKey(e);
    document.addEventListener('keydown', this._keyHandler);

    if (this.mode === 'pending' && this.pendingMessage) this._showPendingInline();
    else this._activateInput();
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
      fontSize: '20px', fontFamily: "'M PLUS Rounded 1c', sans-serif",
      color, wordWrap: { width: maxW }, lineSpacing: 4,
    });
    msgText.setDepth(102);
    this.chatContainer.add(msgText);
    this.chatObjects.push(msgText);
    this.nextMsgY += msgText.height + 16;
    if (scroll !== false) this._scrollToBottom();
    return msgText;
  }

  _addWaiting() { this.waitingText = this._addBubble('npc', '...', true); }

  _removeWaiting() {
    if (this.waitingText) {
      this.nextMsgY -= this.waitingText.height + 16;
      this.waitingText.destroy();
      this.chatContainer.remove(this.waitingText);
      this.chatObjects.pop();
      this.waitingText = null;
    }
  }

  _scrollToBottom() {
    const overflow = this.nextMsgY - (this.chatAreaY + this.chatAreaH);
    if (overflow > 0) { for (const obj of this.chatObjects) obj.y -= overflow; this.nextMsgY -= overflow; }
  }

  _activateInput() {
    this.state = 'input';
    this.inputLabel.visible = true; this.inputDisplay.visible = true; this.inputCursor.visible = true;
    this.inputDisplay.setText('');
    this.dialogSystem.startInput((text) => { this._sendMessage(text); });
  }

  _hideInput() { this.inputLabel.visible = false; this.inputDisplay.visible = false; this.inputCursor.visible = false; }

  _showPendingInline() {
    const msg = this.pendingMessage;
    this.nameText.setText('✟ ' + (msg.fromName || msg.fromId));
    this.chatHistory.push({ role: 'npc', text: msg.message });
    this._addBubble('npc', msg.message, true);
    this._activateInput();
  }

  async _sendMessage(text) {
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
        if (resp && resp.response) { this.chatHistory.push({ role: 'npc', text: resp.response }); this._addBubble('npc', resp.response, true); }
        else this._addBubble('npc', '[no response]', true);
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
    if (e.key === 'Escape') { e.preventDefault(); this._close(); return; }
    if (this.state === 'input') {
      const handled = this.dialogSystem.handleKeyInput(e);
      if (handled) { e.preventDefault(); this.inputDisplay.setText(this.dialogSystem.getInputText()); this.inputCursor.x = this.boxX + 56 + this.inputDisplay.width; }
    }
  }

  _close() {
    document.removeEventListener('keydown', this._keyHandler);
    this.dialogSystem.reset();
    this.scene.stop();
    this.scene.get('WorldScene').resumeFromDialog();
  }

  shutdown() { document.removeEventListener('keydown', this._keyHandler); }
}
