/**
 * Lain Web Interface
 * Connect to the Wired
 */

const messagesContainer = document.getElementById('messages');
const chatForm = document.getElementById('chat-form');
const messageInput = document.getElementById('message-input');
const imageInput = document.getElementById('image-input');
const imageBtn = document.getElementById('image-btn');
const imagePreview = document.getElementById('image-preview');
const previewImg = document.getElementById('preview-img');
const removeImageBtn = document.getElementById('remove-image');

const basePath = window.location.pathname.replace(/\/+$/, '');
const sessionStorageKey = `lain-session:${basePath || 'root'}`;
let sessionId = localStorage.getItem(sessionStorageKey) || null;
let pendingImage = null; // { base64: string, mimeType: string }
const apiKey = document.querySelector('meta[name="lain-api-key"]')?.content || null;
let identity = { id: basePath.replace(/^\/+/, '') || 'newtown', name: 'Newtown' };

function getIdentityLabel() {
  return (identity.name || 'Newtown').toUpperCase();
}

function updateIdentityLabels() {
  document.querySelectorAll('[data-identity-label]').forEach((el) => {
    el.textContent = getIdentityLabel();
  });
}

async function loadIdentity() {
  try {
    const response = await fetch((basePath || '') + '/api/meta/identity');
    if (response.ok) {
      identity = await response.json();
    }
  } catch {
    // Keep fallback identity.
  }

  updateIdentityLabels();
}

// Scroll to bottom of messages
function scrollToBottom() {
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// Create message element
function createMessage(type, content, _sender = null) {
  const div = document.createElement('div');
  div.className = `${type}-message`;

  if (type === 'system') {
    div.innerHTML = `
      <span class="timestamp">[SYSTEM]</span>
      <span class="text">${escapeHtml(content)}</span>
    `;
  } else if (type === 'user') {
    div.innerHTML = `
      <span class="sender">SHRAII</span>
      <span class="text">${escapeHtml(content)}</span>
    `;
  } else if (type === 'lain') {
    div.innerHTML = `
      <span class="sender">${escapeHtml(getIdentityLabel())}</span>
      <span class="text">${formatLainResponse(content)}</span>
    `;
  } else if (type === 'error') {
    div.innerHTML = `
      <span class="text">${escapeHtml(content)}</span>
    `;
  }

  return div;
}

// Create typing indicator
// eslint-disable-next-line no-unused-vars -- used by future streaming UI
function createTypingIndicator() {
  const div = document.createElement('div');
  div.className = 'typing-indicator';
  div.id = 'typing';
  div.innerHTML = '<span></span><span></span><span></span>';
  return div;
}

// Remove typing indicator
// eslint-disable-next-line no-unused-vars -- used by future streaming UI
function removeTypingIndicator() {
  const typing = document.getElementById('typing');
  if (typing) {
    typing.remove();
  }
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Format response (preserve line breaks, handle special formatting)
function formatLainResponse(text) {
  const imagePattern = /\[IMAGE:\s*([^\]]*)\]\(([^)]+)\)/g;
  const images = [];
  let imageIndex = 0;

  let processed = text.replace(imagePattern, (match, desc, url) => {
    images.push({ desc: desc.trim(), url: url.trim() });
    return `__IMAGE_PLACEHOLDER_${imageIndex++}__`;
  });

  processed = escapeHtml(processed)
    .replace(/\n/g, '<br>')
    .replace(/\.{3}/g, '<span class="ellipsis">...</span>');

  images.forEach((img, i) => {
    const imgHtml = `<div class="response-image-container">
      <img src="${escapeHtml(img.url)}" alt="${escapeHtml(img.desc)}" class="response-image"
           onerror="this.onerror=null; this.src=''; this.alt='failed to load image'; this.classList.add('image-error');"
           onclick="window.open('${escapeHtml(img.url)}', '_blank')"/>
      <div class="image-caption">${escapeHtml(img.desc)}</div>
    </div>`;
    processed = processed.replace(`__IMAGE_PLACEHOLDER_${i}__`, imgHtml);
  });

  return processed;
}

// Process an image file
function processImageFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    const dataUrl = e.target.result;
    const base64 = dataUrl.split(',')[1];
    const mimeType = file.type;

    pendingImage = { base64, mimeType };
    previewImg.src = dataUrl;
    imagePreview.style.display = 'flex';
  };
  reader.readAsDataURL(file);
}

// Clear pending image
function clearPendingImage() {
  pendingImage = null;
  previewImg.src = '';
  imagePreview.style.display = 'none';
  imageInput.value = '';
}

imageBtn.addEventListener('click', () => {
  imageInput.click();
});

imageInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  processImageFile(file);
});

removeImageBtn.addEventListener('click', clearPendingImage);

document.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;

  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const file = item.getAsFile();
      processImageFile(file);
      break;
    }
  }
});

let dragOverlay = null;

function showDragOverlay() {
  if (dragOverlay) return;
  dragOverlay = document.createElement('div');
  dragOverlay.className = 'drag-overlay';
  dragOverlay.innerHTML = '<div class="drag-overlay-text">drop image to upload</div>';
  document.body.appendChild(dragOverlay);
}

function hideDragOverlay() {
  if (dragOverlay) {
    dragOverlay.remove();
    dragOverlay = null;
  }
}

document.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (e.dataTransfer?.types?.includes('Files')) {
    showDragOverlay();
  }
});

document.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) {
    hideDragOverlay();
  }
});

document.addEventListener('drop', (e) => {
  e.preventDefault();
  hideDragOverlay();

  const file = e.dataTransfer?.files?.[0];
  if (file && file.type.startsWith('image/')) {
    processImageFile(file);
  }
});

function createStreamingMessage() {
  const div = document.createElement('div');
  div.className = 'lain-message';
  div.innerHTML = `
    <span class="sender">${escapeHtml(getIdentityLabel())}</span>
    <span class="text" id="streaming-text"></span>
  `;
  return div;
}

async function sendMessageStream(message, image, onChunk, onDone, onError) {
  try {
    const payload = {
      message,
      sessionId,
    };

    if (image) {
      payload.image = {
        base64: image.base64,
        mimeType: image.mimeType,
      };
    }

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const response = await fetch(basePath + '/api/chat/stream', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error('Failed to send message');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        onDone();
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));

            if (data.type === 'session' && data.sessionId) {
              sessionId = data.sessionId;
              localStorage.setItem(sessionStorageKey, sessionId);
            } else if (data.type === 'chunk') {
              onChunk(data.content);
            } else if (data.type === 'done') {
              onDone();
            } else if (data.type === 'error') {
              onError(data.message);
            }
          } catch (e) {
            console.error('Failed to parse SSE data:', e);
          }
        }
      }
    }
  } catch (error) {
    console.error('Error:', error);
    onError(error.message);
  }
}

// Fallback: Send message to server (non-streaming)
// eslint-disable-next-line no-unused-vars -- fallback for non-streaming mode
async function sendMessage(message) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const response = await fetch(basePath + '/api/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        message,
        sessionId,
      }),
    });

    if (!response.ok) {
      throw new Error('Failed to send message');
    }

    const data = await response.json();

    if (data.sessionId) {
      sessionId = data.sessionId;
      localStorage.setItem(sessionStorageKey, sessionId);
    }

    return data.response;
  } catch (error) {
    console.error('Error:', error);
    throw error;
  }
}

chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const message = messageInput.value.trim();
  const image = pendingImage;

  if (!message && !image) return;

  messageInput.value = '';
  const sentImage = image;
  clearPendingImage();

  const userMsg = createMessage('user', message || '(image)');
  if (sentImage) {
    const img = document.createElement('img');
    img.src = `data:${sentImage.mimeType};base64,${sentImage.base64}`;
    img.className = 'message-image';
    const textSpan = userMsg.querySelector('.text');
    userMsg.insertBefore(img, textSpan);
  }
  messagesContainer.appendChild(userMsg);
  scrollToBottom();

  const streamingMsg = createStreamingMessage();
  messagesContainer.appendChild(streamingMsg);
  const textSpan = streamingMsg.querySelector('#streaming-text');
  let fullText = '';

  scrollToBottom();

  await sendMessageStream(
    message,
    sentImage,
    (chunk) => {
      fullText += chunk;
      textSpan.innerHTML = formatLainResponse(fullText);
      scrollToBottom();
    },
    () => {
      textSpan.removeAttribute('id');
    },
    () => {
      if (!fullText) {
        textSpan.innerHTML = formatLainResponse('...connection to the town failed. try again.');
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
void loadIdentity();

function addGlitchEffect() {
  const logo = document.querySelector('.logo-title');
  if (logo && Math.random() > 0.95) {
    logo.style.transform = `translateX(${(Math.random() - 0.5) * 4}px)`;
    logo.style.textShadow = `${(Math.random() - 0.5) * 3}px 0 #ff0040, ${(Math.random() - 0.5) * 3}px 0 #40e0ff`;
    setTimeout(() => {
      logo.style.transform = 'translateX(0)';
      logo.style.textShadow = '0 0 10px rgba(128, 192, 255, 0.5)';
    }, 50);
  }
}

setInterval(addGlitchEffect, 100);

const ambientMessages = [
  'signal strength: optimal',
  'layer 07 stable',
  'wired connection active',
  'protocol_7 engaged',
  'memory sync complete',
];

function addAmbientMessage() {
  if (Math.random() > 0.7) {
    const msg = ambientMessages[Math.floor(Math.random() * ambientMessages.length)];
    const statusText = document.querySelector('.status-text');
    if (!statusText) return;
    statusText.textContent = msg.toUpperCase();
    setTimeout(() => {
      statusText.textContent = 'LAYER 07';
    }, 3000);
  }
}

setInterval(addAmbientMessage, 10000);

console.log(`
%c
  +-------------------------------------------+
  |           COPLAND OS ENTERPRISE           |
  |     TACHIBANA GENERAL LABORATORIES        |
  +-------------------------------------------+
  |                                           |
  |   no matter where you go,                 |
  |   everyone's connected.                   |
  |                                           |
  |   PROTOCOL 7 // LAYER 07                  |
  |                                           |
  +-------------------------------------------+
`, 'color: #4080ff; font-family: monospace;');
