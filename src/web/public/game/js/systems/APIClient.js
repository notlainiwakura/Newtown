/**
 * NEWTOWN GAME — API Client
 * All backend API calls for possession, chat, location, etc.
 * Reuses patterns from commune-map.js and possess.js.
 */

class APIClient {
  constructor() {
    this.token = '';
    this.base = '/' + (typeof PLAYER_ID === 'string' ? PLAYER_ID : 'joe');
  }

  setToken(token) {
    this.token = token;
  }

  getToken() {
    return this.token;
  }

  async _fetch(path, options = {}) {
    const url = this.base + path;
    const resp = await fetch(url, {
      ...options,
      headers: {
        'Authorization': 'Bearer ' + this.token,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
    return resp;
  }

  // Check if token is valid by getting possession status
  async checkAuth() {
    const resp = await this._fetch('/api/possession/status');
    if (!resp.ok) return null;
    return await resp.json(); // { isPossessed, location }
  }

  // Start possession
  async possess() {
    const resp = await this._fetch('/api/possess', { method: 'POST' });
    if (!resp.ok) {
      const data = await resp.json();
      throw new Error(data.error || 'Possess failed');
    }
    return await resp.json(); // { ok, sessionId }
  }

  // End possession
  async unpossess() {
    const resp = await this._fetch('/api/unpossess', { method: 'POST' });
    if (!resp.ok) {
      const data = await resp.json();
      throw new Error(data.error || 'Unpossess failed');
    }
    return await resp.json();
  }

  // Move to a building
  async move(buildingId) {
    const resp = await this._fetch('/api/possession/move', {
      method: 'POST',
      body: JSON.stringify({ building: buildingId }),
    });
    if (!resp.ok) {
      const data = await resp.json();
      throw new Error(data.error || 'Move failed');
    }
    return await resp.json(); // { ok, building }
  }

  // Look around — get all character locations
  async look() {
    const resp = await this._fetch('/api/possession/look');
    if (!resp.ok) throw new Error('Look failed');
    return await resp.json(); // { building, buildingName, coLocated, allLocations }
  }

  // Talk to a co-located peer
  async say(peerId, message) {
    const resp = await this._fetch('/api/possession/say', {
      method: 'POST',
      body: JSON.stringify({ peerId, message }),
    });
    if (!resp.ok) {
      const data = await resp.json();
      throw new Error(data.error || 'Say failed');
    }
    return await resp.json(); // { response }
  }

  // Get pending peer messages
  async getPending() {
    const resp = await this._fetch('/api/possession/pending');
    if (!resp.ok) return [];
    return await resp.json(); // [{ fromId, fromName, message }]
  }

  // Reply to a pending message
  async reply(fromId, message) {
    const resp = await this._fetch('/api/possession/reply', {
      method: 'POST',
      body: JSON.stringify({ fromId, message }),
    });
    if (!resp.ok) {
      const data = await resp.json();
      throw new Error(data.error || 'Reply failed');
    }
    return await resp.json();
  }

  // Connect to possession SSE stream (fetch-based since we need auth header)
  async connectStream(onEvent) {
    const resp = await fetch(this.base + '/api/possession/stream', {
      headers: { 'Authorization': 'Bearer ' + this.token },
    });
    if (!resp.ok) throw new Error('Stream connect failed');

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const read = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const event = JSON.parse(line.slice(6));
              onEvent(event);
            } catch { /* ignore parse errors */ }
          }
        }
      } catch {
        // Reconnect after delay
        setTimeout(() => this.connectStream(onEvent), 5000);
      }
    };

    read();
    return reader;
  }

  // Get a specific character's location
  async getCharacterLocation(charId) {
    try {
      const resp = await fetch('/' + charId + '/api/location');
      if (!resp.ok) return null;
      const data = await resp.json();
      return data.location || null;
    } catch {
      return null;
    }
  }

  // Get objects at a location or all objects
  async getObjects(location) {
    const query = location ? `?location=${encodeURIComponent(location)}` : '';
    try {
      const resp = await fetch('/api/objects' + query);
      if (!resp.ok) return [];
      return await resp.json();
    } catch {
      return [];
    }
  }

  // Connect to live conversation SSE stream
  connectConversationStream(onEvent) {
    const url = '/api/conversations/stream';
    const connect = () => {
      fetch(url).then(resp => {
        if (!resp.ok) {
          setTimeout(connect, 10000);
          return;
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        const read = async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';
              for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                try {
                  const event = JSON.parse(line.slice(6));
                  onEvent(event);
                } catch { /* ignore */ }
              }
            }
          } catch { /* reconnect */ }
          setTimeout(connect, 5000);
        };
        read();
      }).catch(() => {
        setTimeout(connect, 10000);
      });
    };
    connect();
  }
}

// Singleton
const apiClient = new APIClient();
