/**
 * NEWTOWN GAME — Dialog System
 * Typewriter text rendering and SSE streaming for RPG text boxes.
 */

class DialogSystem {
  constructor(scene) {
    this.scene = scene;
    this.isOpen = false;
    this.isTyping = false;
    this.fullText = '';
    this.displayedText = '';
    this.charIndex = 0;
    this.typeTimer = null;
    this.typeSpeed = 30; // ms per character
    this.onComplete = null;

    // Streaming state
    this.isStreaming = false;
    this.streamBuffer = '';

    // Input state
    this.inputText = '';
    this.inputActive = false;
    this.inputCallback = null;
  }

  // Start typewriter effect for given text
  startTypewriter(text, onComplete) {
    this.fullText = text;
    this.displayedText = '';
    this.charIndex = 0;
    this.isTyping = true;
    this.onComplete = onComplete || null;

    if (this.typeTimer) {
      this.scene.time.removeEvent(this.typeTimer);
    }

    this.typeTimer = this.scene.time.addEvent({
      delay: this.typeSpeed,
      callback: this._typeNextChar,
      callbackScope: this,
      loop: true,
    });
  }

  _typeNextChar() {
    if (this.charIndex >= this.fullText.length) {
      this.isTyping = false;
      if (this.typeTimer) {
        this.typeTimer.remove();
        this.typeTimer = null;
      }
      if (this.onComplete) this.onComplete();
      return;
    }
    this.displayedText += this.fullText[this.charIndex];
    this.charIndex++;
  }

  // Skip to end of typewriter
  skipTypewriter() {
    if (!this.isTyping) return false;
    this.displayedText = this.fullText;
    this.charIndex = this.fullText.length;
    this.isTyping = false;
    if (this.typeTimer) {
      this.typeTimer.remove();
      this.typeTimer = null;
    }
    if (this.onComplete) this.onComplete();
    return true;
  }

  // Streaming: append chunk to displayed text (for SSE streaming responses)
  appendStreamChunk(chunk) {
    this.fullText += chunk;
    this.displayedText += chunk;
    this.charIndex = this.fullText.length;
  }

  // Start streaming mode
  startStreaming() {
    this.isStreaming = true;
    this.fullText = '';
    this.displayedText = '';
    this.charIndex = 0;
  }

  endStreaming() {
    this.isStreaming = false;
  }

  // Get the current display text (for rendering)
  getDisplayText() {
    return this.displayedText;
  }

  // Text input handling
  startInput(callback) {
    this.inputText = '';
    this.inputActive = true;
    this.inputCallback = callback;
  }

  handleKeyInput(event) {
    if (!this.inputActive) return false;

    if (event.key === 'Enter') {
      const text = this.inputText.trim();
      this.inputActive = false;
      if (text && this.inputCallback) {
        this.inputCallback(text);
      }
      return true;
    }

    if (event.key === 'Backspace') {
      this.inputText = this.inputText.slice(0, -1);
      return true;
    }

    if (event.key === 'Escape') {
      this.inputActive = false;
      this.inputText = '';
      return true; // let dialog scene handle close
    }

    // Only accept printable characters
    if (event.key.length === 1) {
      this.inputText += event.key;
      return true;
    }

    return false;
  }

  getInputText() {
    return this.inputText;
  }

  isInputActive() {
    return this.inputActive;
  }

  reset() {
    this.isTyping = false;
    this.isStreaming = false;
    this.fullText = '';
    this.displayedText = '';
    this.charIndex = 0;
    this.inputText = '';
    this.inputActive = false;
    if (this.typeTimer) {
      this.typeTimer.remove();
      this.typeTimer = null;
    }
  }
}
