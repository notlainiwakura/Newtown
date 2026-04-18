(function () {
  const messages = document.getElementById('messages');
  const form = document.getElementById('chat-form');
  const input = document.getElementById('message-input');
  const residentName = document.getElementById('resident-name');
  const residentTagline = document.getElementById('resident-tagline');
  const residentLocation = document.getElementById('resident-location');
  const statusDot = document.getElementById('status-dot');
  const apiKey = document.querySelector('meta[name="lain-api-key"]')?.content || null;

  let sessionId = localStorage.getItem(`resident-session:${window.location.pathname}`) || null;
  let currentResident = 'Resident';

  function scrollToBottom() {
    messages.scrollTop = messages.scrollHeight;
  }

  function addMessage(type, speaker, content) {
    const article = document.createElement('article');
    article.className = `message ${type}`;
    article.innerHTML = `<h2>${speaker}</h2><p>${escapeHtml(content).replace(/\n/g, '<br>')}</p>`;
    messages.appendChild(article);
    scrollToBottom();
    return article;
  }

  function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value;
    return div.innerHTML;
  }

  function baseHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    return headers;
  }

  async function refreshMeta() {
    try {
      const [identityResp, locationResp] = await Promise.all([
        fetch('api/meta/identity'),
        fetch('api/location'),
      ]);

      if (identityResp.ok) {
        const identity = await identityResp.json();
        currentResident = identity.name || 'Resident';
        residentName.textContent = currentResident;
        residentTagline.textContent = `${currentResident} lives here. No internet. No distant oracle. Just town life, memory, and conversation.`;
      }

      if (locationResp.ok) {
        const location = await locationResp.json();
        statusDot.classList.add('online');
        residentLocation.textContent = `currently at ${location.buildingName || location.location}`;
      }
    } catch {
      residentLocation.textContent = 'currently unreachable';
    }
  }

  async function sendMessage(message) {
    const article = addMessage('resident', currentResident, '...');
    const paragraph = article.querySelector('p');

    try {
      const response = await fetch('api/chat/stream', {
        method: 'POST',
        headers: baseHeaders(),
        body: JSON.stringify({ message, sessionId }),
      });

      if (!response.ok || !response.body) {
        throw new Error('request failed');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = JSON.parse(line.slice(6));
          if (data.type === 'session' && data.sessionId) {
            sessionId = data.sessionId;
            localStorage.setItem(`resident-session:${window.location.pathname}`, sessionId);
          }
          if (data.type === 'chunk') {
            fullText += data.content;
            paragraph.innerHTML = escapeHtml(fullText).replace(/\n/g, '<br>');
            scrollToBottom();
          }
        }
      }
    } catch {
      paragraph.textContent = 'something slipped. try again.';
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = input.value.trim();
    if (!message) return;
    input.value = '';
    addMessage('user', 'Visitor', message);
    await sendMessage(message);
  });

  refreshMeta();
  input.focus();
})();
