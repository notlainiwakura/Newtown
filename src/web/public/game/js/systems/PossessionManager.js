/**
 * LAINTOWN GAME — Possession Manager
 * State machine, building zone detection, SSE stream.
 */

class PossessionManager {
  constructor(scene) {
    this.scene = scene;
    this.isPossessed = false;
    this.currentBuilding = 'market';
    this.streamReader = null;
    this.pendingMessages = [];
    this.pendingPollTimer = null;
    this.onPeerMessage = null; // callback for incoming peer messages
    this.onMovement = null;    // callback for movement events
  }

  async startPossession() {
    try {
      const data = await apiClient.possess();
      this.isPossessed = true;
      return data;
    } catch (err) {
      // Might already be possessed — check status
      const status = await apiClient.checkAuth();
      if (status && status.isPossessed) {
        this.isPossessed = true;
        this.currentBuilding = status.location || 'market';
        return { ok: true, alreadyPossessed: true };
      }
      throw err;
    }
  }

  async endPossession() {
    try {
      await apiClient.unpossess();
    } catch { /* ignore */ }
    this.isPossessed = false;
  }

  // Check current building based on player tile position
  checkZone(tileX, tileY) {
    const building = getBuildingAtTile(tileX, tileY);
    if (building && building !== this.currentBuilding) {
      const prev = this.currentBuilding;
      this.currentBuilding = building;
      this._notifyMove(building);
      return { changed: true, from: prev, to: building };
    }
    return { changed: false };
  }

  async _notifyMove(buildingId) {
    try {
      await apiClient.move(buildingId);
    } catch {
      // ignore move errors
    }
  }

  // Connect to SSE stream for real-time events
  async connectStream() {
    try {
      this.streamReader = await apiClient.connectStream((event) => {
        this._handleStreamEvent(event);
      });
    } catch {
      // Will auto-reconnect inside APIClient
    }
  }

  _handleStreamEvent(event) {
    if (event.type === 'peer_message') {
      this.pendingMessages.push({
        fromId: event.fromId,
        fromName: event.fromName,
        message: event.message,
      });
      if (this.onPeerMessage) {
        this.onPeerMessage(event);
      }
    } else if (event.type === 'movement') {
      if (this.onMovement) {
        this.onMovement(event);
      }
    } else if (event.type === 'possession_ended') {
      this.isPossessed = false;
    }
  }

  // Poll for pending messages
  startPendingPoll() {
    this.pendingPollTimer = this.scene.time.addEvent({
      delay: GAME_CONFIG.PENDING_POLL,
      callback: this._pollPending,
      callbackScope: this,
      loop: true,
    });
  }

  async _pollPending() {
    if (!this.isPossessed) return;
    try {
      const pending = await apiClient.getPending();
      if (pending && pending.length > 0) {
        this.pendingMessages = pending;
        // Notify scene of new pending messages
        if (this.onPeerMessage) {
          for (const msg of pending) {
            this.onPeerMessage(msg);
          }
        }
      }
    } catch { /* ignore */ }
  }

  async replyToPending(fromId, message) {
    try {
      await apiClient.reply(fromId, message);
      this.pendingMessages = this.pendingMessages.filter((m) => m.fromId !== fromId);
    } catch (err) {
      console.error('Reply error:', err);
    }
  }

  hasPending() {
    return this.pendingMessages.length > 0;
  }

  getNextPending() {
    return this.pendingMessages[0] || null;
  }

  stopPolling() {
    if (this.pendingPollTimer) {
      this.pendingPollTimer.remove();
      this.pendingPollTimer = null;
    }
  }

  destroy() {
    this.stopPolling();
    if (this.streamReader) {
      try { this.streamReader.cancel(); } catch { /* */ }
    }
  }
}
