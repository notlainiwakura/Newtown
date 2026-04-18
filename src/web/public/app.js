/**
 * Newtown web interface
 */

const messagesContainer = document.getElementById('messages');
const chatForm = document.getElementById('chat-form');
const messageInput = document.getElementById('message-input');
const imageInput = document.getElementById('image-input');
const imageBtn = document.getElementById('image-btn');
const imagePreview = document.getElementById('image-preview');
const previewImg = document.getElementById('preview-img');
const removeImageBtn = document.getElementById('remove-image');

let sessionId = localStorage.getItem('newtown-session') || null;
let pendingImage = null;
const apiKey = document.querySelector('meta[name="lain-api-key"]')?.content || null;
const basePath = window.location.pathname.replace(/\/+$/, '');

function scrollToBottom() {
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function createMessage(type, content) {
  const div = document.createElement('div');
  div.className = `${type}-message`;

  if (type === 'system') {
    div.innerHTML = `
      <span class="timestamp">[SYSTEM]</span>
      <span class="text">${escapeHtml(content)}</span>
    `;
  } else if (type === 'user') {
    div.innerHTML = `
      <span class="sender">VISITOR</span>
      <span class="text">${escapeHtml(content)}</span>
    `;
  } else if (type === 'lain') {
    div.innerHTML = `
      <span class="sender">TOWN</span>
      <span class="text">${formatResponse(content)}</span>
    `;
  } else if (type === 'error') {
    div.innerHTML = `<span class="text">${escapeHtml(content)}</span>`;
  }

  return div;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatResponse(text) {
  const imagePattern = /\[IMAGE:\s*([^\]]*)\]\(([^)]+)\)/g;
  const images = [];
  let imageIndex = 0;

  let processed = text.replace(imagePattern, (_match, desc, url) => {
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

function processImageFile(file) {
  if (!file || !file.type.startsWith('image/')) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    const dataUrl = e.target.result;
    const base64 = dataUrl.split(',')[1];
    pendingImage = { base64, mimeType: file.type };
    previewImg.src = dataUrl;
    imagePreview.style.display = 'flex';
  };
  reader.readAsDataURL(file);
}

function clearPendingImage() {
  pendingImage = null;
  previewImg.src = '';
  imagePreview.style.display = 'none';
  imageInput.value = '';
}

imageBtn.addEventListener('click', () => imageInput.click());
imageInput.addEventListener('change', (e) => processImageFile(e.target.files[0]));
removeImageBtn.addEventListener('click', clearPendingImage);

document.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;

  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      processImageFile(item.getAsFile());
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
  if (!dragOverlay) return;
  dragOverlay.remove();
  dragOverlay = null;
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
    <span class="sender">TOWN</span>
    <span class="text" id="streaming-text"></span>
  `;
  return div;
}

async function sendMessageStream(message, image, onChunk, onDone, onError) {
  try {
    const payload = { message, sessionId };
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
        if (!line.startsWith('data: ')) continue;

        try {
          const data = JSON.parse(line.slice(6));
          if (data.type === 'session' && data.sessionId) {
            sessionId = data.sessionId;
            localStorage.setItem('newtown-session', sessionId);
          } else if (data.type === 'chunk') {
            onChunk(data.content);
          } else if (data.type === 'done') {
            onDone();
          } else if (data.type === 'error') {
            onError(data.message);
          }
        } catch (error) {
          console.error('Failed to parse SSE data:', error);
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
      textSpan.innerHTML = formatResponse(fullText);
      scrollToBottom();
    },
    () => {
      textSpan.removeAttribute('id');
    },
    () => {
      if (!fullText) {
        textSpan.innerHTML = formatResponse('...the square goes quiet for a moment. try again.');
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
