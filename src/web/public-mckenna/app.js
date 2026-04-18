/**
 * TIMEWAVE // TERMINAL — Terence McKenna Interface
 */

const messagesContainer = document.getElementById('messages');
const chatForm = document.getElementById('chat-form');
const messageInput = document.getElementById('message-input');

let sessionId = localStorage.getItem('mckenna-session') || null;

function scrollToBottom() {
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatResponse(text) {
  return escapeHtml(text)
    .replace(/\n/g, '<br>')
    .replace(/\[Running: ([^\]]+)\]/g, '<span class="tool-output">[Running: $1]</span>');
}

function createMessage(type, content) {
  const div = document.createElement('div');
  div.className = `${type}-message`;

  if (type === 'system') {
    div.innerHTML = `
      <span class="timestamp">[TIMEWAVE]</span>
      <span class="text">${escapeHtml(content)}</span>
    `;
  } else if (type === 'user') {
    div.innerHTML = `
      <span class="sender">YOU</span>
      <span class="text">${escapeHtml(content)}</span>
    `;
  } else if (type === 'character') {
    div.innerHTML = `
      <span class="sender">TERENCE</span>
      <span class="text">${formatResponse(content)}</span>
    `;
  }

  return div;
}

function createStreamingMessage() {
  const div = document.createElement('div');
  div.className = 'character-message';
  div.innerHTML = `
    <span class="sender">TERENCE</span>
    <span class="text" id="streaming-text"></span>
  `;
  return div;
}

async function sendMessageStream(message, onChunk, onDone, onError) {
  try {
    const basePath = window.location.pathname.replace(/\/+$/, '');
    const response = await fetch(basePath + '/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, sessionId }),
    });

    if (!response.ok) throw new Error('Failed to send message');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) { onDone(); break; }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'session' && data.sessionId) {
              sessionId = data.sessionId;
              localStorage.setItem('mckenna-session', sessionId);
            } else if (data.type === 'chunk') {
              onChunk(data.content);
            } else if (data.type === 'done') {
              onDone();
            } else if (data.type === 'error') {
              onError(data.message);
            }
          } catch (e) {
            console.error('Failed to parse SSE:', e);
          }
        }
      }
    }
  } catch (error) {
    console.error('Error:', error);
    onError(error.message);
  }
}

chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const message = messageInput.value.trim();
  if (!message) return;
  messageInput.value = '';

  messagesContainer.appendChild(createMessage('user', message));
  scrollToBottom();

  const streamingMsg = createStreamingMessage();
  messagesContainer.appendChild(streamingMsg);
  const textSpan = streamingMsg.querySelector('#streaming-text');
  let fullText = '';
  scrollToBottom();

  await sendMessageStream(
    message,
    (chunk) => {
      fullText += chunk;
      textSpan.innerHTML = formatResponse(fullText);
      scrollToBottom();
    },
    () => { textSpan.removeAttribute('id'); },
    (_errorMsg) => {
      if (!fullText) {
        textSpan.innerHTML = formatResponse('The signal fades... try again.');
      }
    }
  );
});

messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    chatForm.dispatchEvent(new Event('submit'));
  }
});

messageInput.focus();
