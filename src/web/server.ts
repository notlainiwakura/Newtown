/**
 * Web server for Lain chat interface
 * A Serial Experiments Lain themed web UI
 */

import 'dotenv/config';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
const execAsync = promisify(exec);
import { createServer, request as httpRequest } from 'node:http';
import type { ServerResponse, IncomingMessage as NodeIncomingMessage } from 'node:http';
import { appendFile, mkdir } from 'node:fs/promises';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';
import { initAgent, processMessage, processMessageStream } from '../agent/index.js';
// import { startProactiveLoop } from '../agent/proactive.js';
import { startCuriosityLoop } from '../agent/curiosity.js';
import { startStateDecayLoop } from '../agent/internal-state.js';
import { startDiaryLoop } from '../agent/diary.js';
import { startSelfConceptLoop } from '../agent/self-concept.js';
import { startNarrativeLoop } from '../agent/narratives.js';
import { startMemoryMaintenanceLoop } from '../memory/organic.js';
import { startDreamLoop } from '../agent/dreams.js';
import { getDefaultNewtownNewspaperConfig, getNewspaperDataDir, startNewspaperPublishingLoop } from '../agent/newspaper-publisher.js';
import { startLetterLoop } from '../agent/letter.js';
import { startBibliomancyLoop } from '../agent/bibliomancy.js';
import { startDossierLoop } from '../agent/dossier.js';
import { startDoctorLoop } from '../agent/doctor.js';
import { startDesireLoop } from '../agent/desires.js';
import { startExperimentLoop } from '../agent/experiments.js';
import { startBookLoop } from '../agent/book.js';
import { startNoveltyLoop } from '../agent/novelty.js';
import { startDreamSeederLoop } from '../agent/dream-seeder.js';
import { startEvolutionLoop, getAllLineages, MORTAL_CHARACTERS } from '../agent/evolution.js';
import { startFeedHealthLoop, getFeedHealthState } from '../agent/feed-health.js';
import { startWeatherLoop } from '../commune/weather.js';
import { getBudgetStatus } from '../providers/budget.js';
import { paraphraseLetter, type WiredLetter } from '../agent/membrane.js';
import { getProvider } from '../agent/index.js';
import { extractTextFromHtml } from '../agent/tools.js';
import { generateEmbeddings } from '../memory/embeddings.js';
import { saveMemory, getActivity, getNotesByBuilding, getDocumentsByAuthor, savePostboardMessage, getPostboardMessages, deletePostboardMessage, togglePostboardPin, countMemories, countMessages } from '../memory/store.js';
import { createObject, getObject, getObjectsByLocation, getObjectsByOwner, getAllObjects, pickupObject, dropObject, transferObject, destroyObject, isFixture } from '../objects/store.js';
import { eventBus, isBackgroundEvent, type SystemEvent } from '../events/bus.js';
import { createTownEvent, getActiveTownEvents, getAllTownEvents, endTownEvent, expireStaleEvents, getActiveEffects, type CreateEventParams } from '../events/town-events.js';
import { sanitize } from '../security/sanitizer.js';
import { safeFetch } from '../security/ssrf.js';
import { secureCompare } from '../utils/crypto.js';
import { isOwner, setOwnerCookie } from './owner-auth.js';
import { initDatabase, getMeta, query } from '../storage/database.js';
import { getPaths } from '../config/index.js';
import { getBasePath } from '../config/paths.js';
import { getDefaultConfig } from '../config/defaults.js';
import type { IncomingMessage, TextContent, ImageContent } from '../types/message.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', '..', 'src', 'web', 'public');
const SKINS_DIR = join(__dirname, '..', '..', 'src', 'web', 'skins');
const NEWSPAPERS_DIR = getNewspaperDataDir();
const LOG_DIR = join(__dirname, '..', '..', 'logs');
const LOG_FILE = join(LOG_DIR, 'lain-debug.log');

// Debug logging to file
async function debugLog(context: string, data: unknown): Promise<void> {
  try {
    await mkdir(LOG_DIR, { recursive: true });
    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] [${context}] ${JSON.stringify(data, null, 2)}\n${'='.repeat(80)}\n`;
    await appendFile(LOG_FILE, entry);
    console.log(`[DEBUG] [${context}]`, typeof data === 'string' ? data : JSON.stringify(data).substring(0, 200));
  } catch (e) {
    console.error('Failed to write debug log:', e);
  }
}

// --- Security helpers ---

const MAX_BODY_BYTES = 1_048_576; // 1 MB

/**
 * Collect request body with a size limit.
 * Destroys the request and rejects if the limit is exceeded.
 */
function collectBody(req: import('node:http').IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error('PAYLOAD_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

// --- Owner session management ---
// Owner authenticates via /gate?token=LAIN_OWNER_TOKEN, gets an HMAC-signed HTTP-only cookie.
// All servers (main, character, doctor) can independently verify using the same LAIN_OWNER_TOKEN.
// isOwner() and setOwnerCookie() imported from ./owner-auth.js

/**
 * Verify write access for /api/* endpoints.
 * Accepts: owner session cookie OR Bearer token (for internal/programmatic use).
 */
function verifyApiAuth(
  req: import('node:http').IncomingMessage,
  res: ServerResponse
): boolean {
  // Owner cookie — primary auth for browser
  if (isOwner(req)) return true;

  // Check Authorization: Bearer header (for internal/programmatic use only, never exposed to browser)
  const apiKey = process.env['LAIN_WEB_API_KEY'];
  if (apiKey) {
    const authHeader = req.headers['authorization'];
    if (authHeader?.startsWith('Bearer ')) {
      const provided = authHeader.slice('Bearer '.length);
      if (secureCompare(provided, apiKey)) return true;
    }
  }

  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unauthorized' }));
  return false;
}

// --- Per-IP rate limiting ---

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 30; // 30 requests per window
const rateLimitMap = new Map<string, RateLimitEntry>();

// Prune expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(ip);
  }
}, 5 * 60_000);

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}

// --- CORS origin ---

const CORS_ORIGIN = process.env['LAIN_CORS_ORIGIN'] || '*';

// --- Live conversation broadcast ---
interface ConversationEvent {
  speakerId: string;
  speakerName: string;
  listenerId: string;
  listenerName: string;
  message: string;
  building: string;
  timestamp: number;
}
const conversationBuffer: ConversationEvent[] = [];
const conversationSSEClients = new Set<ServerResponse>();

// Relationship data cache (recomputed every 5 minutes)
let relationshipCache: unknown = null;
let relationshipCacheTime = 0;

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

interface ChatRequest {
  message: string;
  sessionId?: string;
  stranger?: boolean;
  senderName?: string;
  image?: {
    base64: string;
    mimeType: string;
  };
}

interface ChatResponse {
  response: string;
  sessionId: string;
}

async function handleChat(body: string): Promise<ChatResponse> {
  const request: ChatRequest = JSON.parse(body);
  const isStranger = request.stranger === true;
  const sessionId = isStranger
    ? (request.sessionId || `stranger:web:${nanoid(8)}`)
    : (request.sessionId || `web:${nanoid(8)}`);
  const messageText = isStranger ? `「STRANGER」 ${request.message}` : request.message;

  await debugLog('CHAT_REQUEST', { message: request.message, sessionId, stranger: isStranger });

  const incomingMessage: IncomingMessage = {
    id: nanoid(16),
    channel: 'web',
    peerKind: 'user',
    peerId: sessionId,
    senderId: isStranger ? 'stranger' : 'web-user',
    ...(request.senderName ? { senderName: request.senderName } : {}),
    content: { type: 'text', text: messageText } satisfies TextContent,
    timestamp: Date.now(),
  };

  try {
    const agentResponse = await processMessage({
      sessionKey: sessionId,
      message: incomingMessage,
    });

    await debugLog('AGENT_RESPONSE', {
      sessionKey: agentResponse.sessionKey,
      messageCount: agentResponse.messages.length,
      tokenUsage: agentResponse.tokenUsage,
      messages: agentResponse.messages,
    });

    const textResponse = agentResponse.messages
      .filter((m) => m.content.type === 'text')
      .map((m) => (m.content as TextContent).text)
      .join('\n');

    return {
      response: textResponse,
      sessionId,
    };
  } catch (error) {
    await debugLog('CHAT_ERROR', { error: String(error), stack: error instanceof Error ? error.stack : undefined });
    throw error;
  }
}

async function handleChatStream(body: string, res: ServerResponse): Promise<void> {
  const request: ChatRequest = JSON.parse(body);
  const isStranger = request.stranger === true;
  const sessionId = isStranger
    ? (request.sessionId || `stranger:web:${nanoid(8)}`)
    : (request.sessionId || `web:${nanoid(8)}`);
  const messageText = isStranger ? `「STRANGER」 ${request.message}` : request.message;

  await debugLog('CHAT_STREAM_REQUEST', {
    message: request.message,
    sessionId,
    hasImage: !!request.image,
    stranger: isStranger,
  });

  // Set up SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': CORS_ORIGIN,
  });

  // Send session ID first
  res.write(`data: ${JSON.stringify({ type: 'session', sessionId })}\n\n`);

  // Build message content - either text only or image with caption
  let content: TextContent | ImageContent;
  if (request.image) {
    const imageContent: ImageContent = {
      type: 'image',
      base64: request.image.base64,
      mimeType: request.image.mimeType,
    };
    if (request.message) {
      imageContent.caption = request.message;
    }
    content = imageContent;
  } else {
    content = { type: 'text', text: messageText } satisfies TextContent;
  }

  const incomingMessage: IncomingMessage = {
    id: nanoid(16),
    channel: 'web',
    peerKind: 'user',
    peerId: sessionId,
    senderId: isStranger ? 'stranger' : 'web-user',
    ...(request.senderName ? { senderName: request.senderName } : {}),
    content,
    timestamp: Date.now(),
  };

  try {
    await processMessageStream(
      {
        sessionKey: sessionId,
        message: incomingMessage,
      },
      (chunk: string) => {
        // Send each text chunk as an SSE event
        res.write(`data: ${JSON.stringify({ type: 'chunk', content: chunk })}\n\n`);
      }
    );

    // Send completion event
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  } catch (error) {
    await debugLog('CHAT_STREAM_ERROR', { error: String(error), stack: error instanceof Error ? error.stack : undefined });
    res.write(`data: ${JSON.stringify({ type: 'error', message: 'Failed to process message' })}\n\n`);
    res.end();
  }
}

async function serveStatic(path: string): Promise<{ content: Buffer; type: string } | null> {
  try {
    const safePath = path.replace(/^\/+/, '') || 'index.html';
    let filePath = resolve(PUBLIC_DIR, safePath);
    // Path traversal check: resolved path must stay within PUBLIC_DIR
    if (!filePath.startsWith(resolve(PUBLIC_DIR))) {
      return null;
    }
    // Directory index: if path is a directory, try index.html inside it
    try {
      const s = await stat(filePath);
      if (s.isDirectory()) {
        filePath = resolve(filePath, 'index.html');
      }
    } catch { /* not found — readFile below will handle it */ }
    const content = await readFile(filePath);
    const ext = extname(filePath);
    const type = MIME_TYPES[ext] || 'application/octet-stream';
    return { content, type };
  } catch {
    return null;
  }
}

async function serveFromDir(baseDir: string, path: string): Promise<{ content: Buffer; type: string } | null> {
  try {
    const safePath = path.replace(/^\/+/, '');
    if (!safePath) return null;
    const filePath = resolve(baseDir, safePath);
    if (!filePath.startsWith(resolve(baseDir))) return null;
    const content = await readFile(filePath);
    const ext = extname(filePath);
    const type = MIME_TYPES[ext] || 'application/octet-stream';
    return { content, type };
  } catch {
    return null;
  }
}

// Pages that require owner auth — non-owners get 403
const OWNER_ONLY_PATHS = [
  '/postboard.html',
  '/town-events.html',
  '/dreams.html',
  '/dashboard.html',
  '/neo/',
  '/plato/',
  '/joe/',
  '/api/chat',
  '/api/chat/stream',
];

const CHARACTER_PROXY_PREFIXES = ['/neo/', '/plato/', '/joe/'] as const;
const PUBLIC_CHARACTER_API_PATHS = [
  '/api/health',
  '/api/location',
  '/api/events',
  '/api/activity',
  '/api/building/notes',
  '/api/documents',
  '/api/postboard',
] as const;

function isPublicCharacterApiPath(pathname: string): boolean {
  for (const prefix of CHARACTER_PROXY_PREFIXES) {
    if (!pathname.startsWith(prefix)) continue;
    const targetPath = '/' + pathname.slice(prefix.length);
    return PUBLIC_CHARACTER_API_PATHS.some((publicPath) => (
      targetPath === publicPath || targetPath.startsWith(`${publicPath}/`)
    ));
  }
  return false;
}

/**
 * Verify interlink auth token from Authorization: Bearer header.
 * Returns true if authenticated, false if response was already sent with error.
 */
function verifyInterlinkAuth(
  req: import('node:http').IncomingMessage,
  res: ServerResponse
): boolean {
  const token = process.env['LAIN_INTERLINK_TOKEN'];
  if (!token) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Interlink not configured' }));
    return false;
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing or invalid Authorization header' }));
    return false;
  }

  const provided = authHeader.slice('Bearer '.length);
  if (!secureCompare(provided, token)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid token' }));
    return false;
  }

  return true;
}

// --- Navigation bar injection ---

const NAV_LINKS_PUBLIC: Array<{ label: string; href: string }> = [
  { label: 'MAP', href: '/commune-map.html' },
  { label: 'WALK', href: '/game/' },
  { label: 'NEWS', href: '/commune-newspaper.html' },
  { label: 'PAPER', href: '/newspaper.html' },
];

const NAV_LINKS_OWNER: Array<{ label: string; href: string }> = [
  { label: 'POST', href: '/postboard.html' },
  { label: 'EVENTS', href: '/town-events.html' },
  { label: 'DREAMS', href: '/dreams.html' },
  { label: 'DASH', href: '/dashboard.html' },
  { label: 'NEO', href: '/neo/' },
  { label: 'PLATO', href: '/plato/' },
  { label: 'JOE', href: '/joe/' },
];

function generateNavBar(pathname: string, ownerMode = false): string {
  const exitLink = { label: 'EXIT', href: '/commune-map.html' };
  const NAV_LINKS = ownerMode ? [...NAV_LINKS_PUBLIC, ...NAV_LINKS_OWNER, exitLink] : [...NAV_LINKS_PUBLIC, exitLink];
  const isGamePage = pathname === '/game/' || pathname === '/game/index.html';

  const links = NAV_LINKS.map(({ label, href }) => {
    // Determine if this link is the current page
    let active = false;
    if (href === '/commune-map.html') {
      active = pathname === '/commune-map.html';
    } else if (href === '/') {
      active = pathname === '/' || pathname === '/index.html';
    } else {
      active = pathname.startsWith(href);
    }
    const cls = active ? ' class="ltn-active"' : '';
    return `<a href="${href}"${cls}>${label}</a>`;
  }).join('');

  return `<style>
#laintown-nav{position:fixed;top:0;left:0;right:0;height:32px;background:var(--bg-deep,#0a0a0f);border-bottom:1px solid var(--border-glow,#1a1a2e);display:flex;align-items:center;z-index:99999;font-family:'Share Tech Mono',monospace;padding:0 12px;gap:0}
#laintown-nav .ltn-title{color:var(--accent-primary,#4a9eff);font-size:11px;letter-spacing:2px;text-transform:uppercase;margin-right:16px}
#laintown-nav a{color:var(--text-dim,#556);font-size:11px;letter-spacing:1.5px;text-transform:uppercase;text-decoration:none;padding:0 10px;line-height:32px;transition:color .2s}
#laintown-nav a:hover{color:var(--accent-secondary,#8ab4f8)}
#laintown-nav a.ltn-active{color:var(--accent-primary,#4a9eff)}
</style>
<style>${isGamePage ? 'body{padding-top:0!important}#laintown-nav{background:var(--nav-game-bg,rgba(10,10,15,0.6));border-bottom-color:var(--nav-game-border,rgba(26,26,46,0.4))}' : 'body{padding-top:32px!important}'}</style>
<div id="laintown-nav"><span class="ltn-title">NEWTOWN</span>${links}</div>
<script>(function(){var k=new URLSearchParams(location.search).get('key');if(k){var as=document.querySelectorAll('#laintown-nav a');for(var i=0;i<as.length;i++){var a=as[i],h=a.getAttribute('href');if(h){var hi=h.indexOf('#'),base=hi>-1?h.slice(0,hi):h,frag=hi>-1?h.slice(hi):'';if(base.indexOf('?')===-1){a.setAttribute('href',base+'?key='+encodeURIComponent(k)+frag)}else{a.setAttribute('href',base+'&key='+encodeURIComponent(k)+frag)}}}}})();</script>`;
}

function injectNavBar(html: string, pathname: string, ownerMode = false): string {
  const nav = generateNavBar(pathname, ownerMode);
  // Inject telemetry script before </head> (skip on dashboard — it has its own stats)
  if (!pathname.includes('dashboard')) {
    html = html.replace('</head>', '<script src="/laintown-telemetry.js" defer></script></head>');
  }
  // Strip any existing nav bar (from character server's own injection)
  html = html.replace(/<style>[^<]*#laintown-nav[\s\S]*?<\/style>/g, '');
  html = html.replace(/<div id="laintown-nav">[\s\S]*?<\/div>\s*<script>\(function\(\)\{var k=[\s\S]*?<\/script>/g, '');
  // Inject after the opening <body...> tag
  const bodyMatch = html.match(/<body[^>]*>/i);
  if (bodyMatch) {
    const idx = html.indexOf(bodyMatch[0]) + bodyMatch[0].length;
    return html.slice(0, idx) + nav + html.slice(idx);
  }
  return html;
}

export async function startWebServer(port = 3000): Promise<void> {
  // Initialize database and agent
  const paths = getPaths();
  const config = getDefaultConfig();

  console.log('Initializing database...');
  await initDatabase(paths.database, config.security.keyDerivation);

  // Set character identity for event bus
  const characterId = process.env['LAIN_CHARACTER_ID'] || 'newtown';
  eventBus.setCharacterId(characterId);

  console.log('Initializing agent...');
  for (const agentConfig of config.agents) {
    await initAgent(agentConfig);
  }

  const server = createServer(async (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url || '/', `http://localhost:${port}`);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad Request');
      return;
    }

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // Security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'");

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health check (no auth)
    if (url.pathname === '/api/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: Date.now(),
      }));
      return;
    }

    // Owner gate — authenticate via secret token, get HMAC-signed session cookie
    if (url.pathname === '/gate' && req.method === 'GET') {
      const ownerToken = process.env['LAIN_OWNER_TOKEN'];
      const provided = url.searchParams.get('token');
      if (ownerToken && provided && secureCompare(provided, ownerToken)) {
        setOwnerCookie(res, ownerToken);
        res.writeHead(302, { 'Location': '/' });
        res.end();
      } else {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
      }
      return;
    }

    // Block non-owners from restricted pages
    if (!isOwner(req)) {
      const isOwnerOnly = OWNER_ONLY_PATHS.some(p => url.pathname === p || url.pathname.startsWith(p));
      const isPublicResidentApi = isPublicCharacterApiPath(url.pathname);
      const isRootChat = (url.pathname === '/' || url.pathname === '/index.html') && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/skins/');
      if ((isOwnerOnly && !isPublicResidentApi) || isRootChat) {
        if (req.headers['accept']?.includes('text/html') || !url.pathname.startsWith('/api/')) {
          res.writeHead(302, { Location: '/commune-map.html' });
          res.end();
        } else {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
        }
        return;
      }
    }

    // Location (no auth — public for commune map)
    if (url.pathname === '/api/location' && req.method === 'GET') {
      try {
        const { getCurrentLocation } = await import('../commune/location.js');
        const { BUILDING_MAP } = await import('../commune/buildings.js');
        const charId = process.env['LAIN_CHARACTER_ID'] || 'newtown';
        const loc = getCurrentLocation(charId);
        const building = BUILDING_MAP.get(loc.building);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          characterId: charId,
          location: loc.building,
          buildingName: building?.name || loc.building,
          row: building?.row ?? -1,
          col: building?.col ?? -1,
          timestamp: loc.timestamp,
        }));
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to get location' }));
      }
      return;
    }

    // Internal state (interlink auth — used by ambient awareness)
    if (url.pathname === '/api/internal-state' && req.method === 'GET') {
      if (!verifyInterlinkAuth(req, res)) return;
      try {
        const { getCurrentState, getStateSummary } = await import('../agent/internal-state.js');
        const charId = process.env['LAIN_CHARACTER_ID'] || 'newtown';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ characterId: charId, summary: getStateSummary(), state: getCurrentState() }));
      } catch {
        const charId = process.env['LAIN_CHARACTER_ID'] || 'newtown';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ characterId: charId, summary: '', state: null }));
      }
      return;
    }

    // Weather endpoint — public data
    if (url.pathname === '/api/weather' && req.method === 'GET') {
      try {
        const { getCurrentWeather } = await import('../commune/weather.js');
        const weather = getCurrentWeather();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(weather ?? { condition: 'overcast', intensity: 0.5, description: 'quiet', computed_at: 0 }));
      } catch {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ condition: 'overcast', intensity: 0.5, description: 'quiet', computed_at: 0 }));
      }
      return;
    }

    // Identity (no auth)
    if (url.pathname === '/api/meta/identity' && req.method === 'GET') {
      const charId = process.env['LAIN_CHARACTER_ID'] || 'newtown';
      const charName = process.env['LAIN_CHARACTER_NAME'] || 'Newtown';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: charId, name: charName }));
      return;
    }

    // Commune conversation history — used by /api/relationships aggregator
    if (url.pathname === '/api/commune-history' && req.method === 'GET') {
      try {
        const raw = getMeta('commune:conversation_history');
        const records = raw ? JSON.parse(raw) : [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(records));
      } catch {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[]');
      }
      return;
    }

    // Relationship weights — aggregates conversation history across all characters
    if (url.pathname === '/api/relationships' && req.method === 'GET') {
      // Cache for 5 minutes
      const now = Date.now();
      if (relationshipCache && now - relationshipCacheTime < 300_000) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(relationshipCache));
        return;
      }

      try {
        const charPorts: Record<string, number> = {
          'neo': 3003,
          'plato': 3004,
          'joe': 3005,
        };
        const charIds = Object.keys(charPorts);

        // Fetch conversation histories from all characters
        interface ConvRecord { peerId: string; timestamp: number; rounds: number }
        const allRecords: Array<{ fromId: string; record: ConvRecord }> = [];

        const fetches = charIds.map(async (charId) => {
          try {
            let records: ConvRecord[];
            if (charId === (process.env['LAIN_CHARACTER_ID'] || 'newtown')) {
              // Read locally
              const raw = getMeta('commune:conversation_history');
              records = raw ? JSON.parse(raw) : [];
            } else {
              const port = charPorts[charId]!;
              const resp = await fetch(`http://127.0.0.1:${port}/api/commune-history`, {
                signal: AbortSignal.timeout(3000),
              });
              records = resp.ok ? await resp.json() as ConvRecord[] : [];
            }
            for (const r of records) {
              allRecords.push({ fromId: charId, record: r });
            }
          } catch { /* character unreachable */ }
        });

        await Promise.allSettled(fetches);

        // Also check building_events for conversation records
        try {
          const database = (await import('../storage/database.js')).getDatabase();
          const since = now - 30 * 24 * 60 * 60 * 1000; // 30 days
          const rows = database.prepare(
            `SELECT actors, created_at FROM building_events
             WHERE event_type = 'conversation' AND created_at > ?`
          ).all(since) as Array<{ actors: string; created_at: number }>;
          for (const row of rows) {
            const actors = JSON.parse(row.actors) as string[];
            if (actors.length === 2) {
              allRecords.push({
                fromId: actors[0]!,
                record: { peerId: actors[1]!, timestamp: row.created_at, rounds: 3 },
              });
            }
          }
        } catch { /* building events unavailable */ }

        // Aggregate into pair weights with recency decay
        const HALF_LIFE = 7 * 24 * 60 * 60 * 1000; // 7 days
        const pairWeights = new Map<string, number>();

        for (const { fromId, record } of allRecords) {
          const pair = [fromId, record.peerId].sort().join(':');
          const age = now - record.timestamp;
          const decay = Math.exp(-age / HALF_LIFE);
          const current = pairWeights.get(pair) || 0;
          pairWeights.set(pair, current + decay);
        }

        // Normalize to 0-1
        let maxWeight = 0;
        for (const w of pairWeights.values()) {
          if (w > maxWeight) maxWeight = w;
        }

        const edges: Array<{ source: string; target: string; weight: number }> = [];
        for (const [pair, weight] of pairWeights) {
          const [source, target] = pair.split(':');
          const normalized = maxWeight > 0 ? weight / maxWeight : 0;
          if (normalized > 0.01) { // filter noise
            edges.push({ source: source!, target: target!, weight: normalized });
          }
        }

        const result = { characters: charIds, edges, updatedAt: now };
        relationshipCache = result;
        relationshipCacheTime = now;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to compute relationships' }));
      }
      return;
    }

    // Integrity check — reports actual data paths for isolation verification (auth required)
    if (url.pathname === '/api/meta/integrity' && req.method === 'GET') {
      if (!isOwner(req)) { if (!verifyInterlinkAuth(req, res)) return; }
      const charId = process.env['LAIN_CHARACTER_ID'] || 'newtown';
      const charName = process.env['LAIN_CHARACTER_NAME'] || 'Newtown';
      const basePath = getBasePath();
      const dbPath = join(basePath, 'lain.db');
      const journalPath = join(basePath, '.private_journal', 'thoughts.json');
      const selfConceptPath = join(basePath, '.private_journal', 'self-concept.md');
      const lainHome = process.env['LAIN_HOME'] || '(not set — using default)';

      const checks: Array<{ check: string; ok: boolean; detail: string }> = [];

      // 1. LAIN_HOME is set (every character except default Lain should have this)
      checks.push({
        check: 'LAIN_HOME',
        ok: !!process.env['LAIN_HOME'] || charId === 'newtown',
        detail: lainHome,
      });

      // 2. basePath does not equal process.cwd() (data should be in home, not project dir)
      checks.push({
        check: 'basePath_not_cwd',
        ok: basePath !== process.cwd(),
        detail: `basePath=${basePath}, cwd=${process.cwd()}`,
      });

      // 3. DB file exists at the expected path
      const { existsSync: exists } = await import('node:fs');
      checks.push({
        check: 'db_exists',
        ok: exists(dbPath),
        detail: dbPath,
      });

      // 4. Journal writes to basePath, not cwd
      const journalInHome = exists(journalPath);
      const journalInCwd = exists(join(process.cwd(), '.private_journal', 'thoughts.json'));
      checks.push({
        check: 'journal_in_home',
        ok: journalInHome || !journalInCwd,
        detail: journalInHome ? journalPath : journalInCwd ? `WRONG: writing to ${process.cwd()}/.private_journal/` : 'no journal yet',
      });

      const allOk = checks.every(c => c.ok);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        characterId: charId,
        characterName: charName,
        basePath,
        dbPath,
        journalPath,
        selfConceptPath,
        allOk,
        checks,
      }));
      return;
    }

    // Telemetry — exposes key stats for Dr. Claude's town-wide monitoring (auth required)
    if (url.pathname === '/api/telemetry' && req.method === 'GET') {
      if (!isOwner(req)) { if (!verifyInterlinkAuth(req, res)) return; }
      const charId = process.env['LAIN_CHARACTER_ID'] || 'newtown';
      const charName = process.env['LAIN_CHARACTER_NAME'] || 'Newtown';
      const sinceMs = Date.now() - 24 * 60 * 60 * 1000;
      try {
        const totalMemories = countMemories();
        const totalMessages = countMessages();
        const memoryTypes = query<{ memory_type: string; count: number }>(
          'SELECT memory_type, COUNT(*) as count FROM memories WHERE created_at > ? GROUP BY memory_type',
          [sinceMs]
        );
        const avgRow = query<{ avg_ew: number }>(
          'SELECT AVG(emotional_weight) as avg_ew FROM memories WHERE created_at > ?',
          [sinceMs]
        );
        const sessionCounts = query<{ prefix: string; count: number }>(
          `SELECT substr(session_key, 1, instr(session_key || ':', ':') - 1) as prefix, COUNT(*) as count
           FROM messages WHERE timestamp > ? GROUP BY prefix ORDER BY count DESC`,
          [sinceMs]
        );
        const hotMemories = query<{ content: string; emotional_weight: number }>(
          'SELECT content, emotional_weight FROM memories WHERE created_at > ? AND emotional_weight > 0.3 ORDER BY emotional_weight DESC LIMIT 5',
          [sinceMs]
        );
        const loopKeys = [
          'dream:cycle_count', 'dream:last_cycle_at',
          'curiosity:last_cycle_at', 'curiosity-offline:last_cycle_at', 'commune:last_cycle_at',
          'diary:last_entry_at', 'self-concept:last_synthesis_at',
          'narrative:weekly:last_synthesis_at', 'narrative:monthly:last_synthesis_at', 'letter:last_sent_at',
          'letter:blocked', 'desire:last_action_at',
          'townlife:last_cycle_at', 'memory:last_maintenance_at',
        ];
        const loopHealth: Record<string, string | null> = {};
        for (const key of loopKeys) {
          loopHealth[key] = getMeta(key) ?? null;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          characterId: charId,
          characterName: charName,
          timestamp: Date.now(),
          totalMemories,
          totalMessages,
          memoryTypes: Object.fromEntries(memoryTypes.map(r => [r.memory_type, r.count])),
          avgEmotionalWeight: avgRow[0]?.avg_ew ?? 0,
          sessionActivity: Object.fromEntries(sessionCounts.map(r => [r.prefix, r.count])),
          hotMemories: hotMemories.map(m => ({
            content: m.content.slice(0, 150),
            emotionalWeight: m.emotional_weight,
          })),
          loopHealth,
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Telemetry query failed', detail: String(err) }));
      }
      return;
    }

    // SSE event stream (public — visitors can watch)
    if (url.pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': CORS_ORIGIN,
      });
      const handler = (event: SystemEvent) => {
        if (!isBackgroundEvent(event)) return;
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      eventBus.on('activity', handler);
      const heartbeat = setInterval(() => {
        res.write(': heartbeat\n\n');
      }, 30_000);
      req.on('close', () => {
        eventBus.off('activity', handler);
        clearInterval(heartbeat);
      });
      return;
    }

    // Activity history (public — visitors can read)
    if (url.pathname === '/api/activity' && req.method === 'GET') {
      const fromParam = url.searchParams.get('from');
      const toParam = url.searchParams.get('to');
      const includeChat = url.searchParams.get('includeChat') === '1';
      const now = Date.now();
      const from = fromParam ? Number(fromParam) : now - 7 * 24 * 60 * 60 * 1000;
      const to = toParam ? Number(toParam) : now;
      const entries = getActivity(from, to, 500, {
        includeVisitorChat: includeChat,
        chatPrefixes: ['web'],
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(entries));
      return;
    }

    // Building notes (no auth — used for note discovery between characters)
    if (url.pathname === '/api/building/notes' && req.method === 'GET') {
      const building = url.searchParams.get('building');
      if (!building) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing building parameter' }));
        return;
      }
      const sinceParam = url.searchParams.get('since');
      const since = sinceParam ? Number(sinceParam) : undefined;
      const notes = getNotesByBuilding(building, since);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(notes));
      return;
    }

    // Documents by this character (no auth — for document discovery between characters)
    if (url.pathname === '/api/documents' && req.method === 'GET') {
      const characterId = process.env['LAIN_CHARACTER_ID'] || 'newtown';
      const titleParam = url.searchParams.get('title');
      const docs = getDocumentsByAuthor(characterId);
      if (titleParam) {
        const match = docs.find(d => d.title.toLowerCase() === titleParam.toLowerCase());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(match || null));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(docs));
      }
      return;
    }

    // --- Postboard (admin direct line to all inhabitants) ---

    // GET /api/postboard — read messages (no auth for character discovery)
    if (url.pathname === '/api/postboard' && req.method === 'GET') {
      const sinceParam = url.searchParams.get('since');
      const since = sinceParam ? Number(sinceParam) : undefined;
      const messages = getPostboardMessages(since);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(messages));
      return;
    }

    // POST /api/postboard — write a new message (auth required)
    if (url.pathname === '/api/postboard' && req.method === 'POST') {
      if (!verifyApiAuth(req, res)) return;
      try {
        const body = await collectBody(req);
        const { content, pinned } = JSON.parse(body) as { content: string; pinned?: boolean };
        if (!content || typeof content !== 'string' || content.trim().length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'content is required' }));
          return;
        }
        if (content.length > 2000) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'content exceeds 2000 character limit' }));
          return;
        }
        const id = savePostboardMessage(content.trim(), 'admin', pinned === true);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id }));
      } catch (error) {
        if (error instanceof Error && error.message === 'PAYLOAD_TOO_LARGE') {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Payload too large' }));
          return;
        }
        console.error('Postboard write error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to save message' }));
      }
      return;
    }

    // DELETE /api/postboard/:id (auth required)
    if (url.pathname.startsWith('/api/postboard/') && req.method === 'DELETE') {
      if (!verifyApiAuth(req, res)) return;
      const id = url.pathname.slice('/api/postboard/'.length);
      if (!id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing message ID' }));
        return;
      }
      const deleted = deletePostboardMessage(id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: deleted }));
      return;
    }

    // POST /api/postboard/:id/pin (auth required)
    if (url.pathname.match(/^\/api\/postboard\/[^/]+\/pin$/) && req.method === 'POST') {
      if (!verifyApiAuth(req, res)) return;
      const id = url.pathname.split('/')[3]!;
      const toggled = togglePostboardPin(id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: toggled }));
      return;
    }

    // --- Town Events (admin-triggered events affecting all inhabitants) ---

    // GET /api/town-events — read active events (no auth for character discovery)
    if (url.pathname === '/api/town-events' && req.method === 'GET') {
      const all = url.searchParams.get('all') === '1';
      const events = all ? getAllTownEvents(50) : getActiveTownEvents();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(events));
      return;
    }

    // GET /api/town-events/effects — merged mechanical effects
    if (url.pathname === '/api/town-events/effects' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getActiveEffects()));
      return;
    }

    // POST /api/town-events — create a new event (auth required)
    if (url.pathname === '/api/town-events' && req.method === 'POST') {
      if (!verifyApiAuth(req, res)) return;
      try {
        const body = await collectBody(req);
        const data = JSON.parse(body) as CreateEventParams;
        if (!data.description || typeof data.description !== 'string' || data.description.trim().length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'description is required' }));
          return;
        }
        const event = createTownEvent({ ...data, source: data.source ?? 'admin' });
        // Broadcast through activity bus
        eventBus.emitActivity({
          type: 'town-event',
          sessionKey: `town-event:${event.id}`,
          content: `[TOWN EVENT] ${event.description}`,
          timestamp: event.createdAt,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, event }));
      } catch (error) {
        if (error instanceof Error && error.message === 'PAYLOAD_TOO_LARGE') {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Payload too large' }));
          return;
        }
        console.error('Town event creation error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to create event' }));
      }
      return;
    }

    // POST /api/town-events/:id/end — end a persistent event (auth required)
    if (url.pathname.match(/^\/api\/town-events\/[^/]+\/end$/) && req.method === 'POST') {
      if (!verifyApiAuth(req, res)) return;
      const id = url.pathname.split('/')[3]!;
      const ended = endTownEvent(id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: ended }));
      return;
    }

    // ======= Dreams Dashboard (aggregator endpoints) =======

    // Character definitions for dream aggregation
    const DREAM_PEERS: Array<{ id: string; name: string; port: number }> = [
      { id: 'neo', name: 'Neo', port: 3003 },
      { id: 'plato', name: 'Plato', port: 3004 },
      { id: 'joe', name: 'Joe', port: 3005 },
    ];

    function fetchPeerJson<T>(port: number, path: string): Promise<T | null> {
      const interlinkToken = process.env['LAIN_INTERLINK_TOKEN'] || '';
      return new Promise((resolve) => {
        const req = httpRequest(
          { hostname: '127.0.0.1', port, path, method: 'GET', headers: { 'Authorization': `Bearer ${interlinkToken}` }, timeout: 5000 },
          (pRes) => {
            const chunks: Buffer[] = [];
            pRes.on('data', (c: Buffer) => chunks.push(c));
            pRes.on('end', () => {
              try { resolve(JSON.parse(Buffer.concat(chunks).toString()) as T); }
              catch { resolve(null); }
            });
          }
        );
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.end();
      });
    }

    // GET /api/dreams/status — aggregated dream stats from all characters
    if (url.pathname === '/api/dreams/status' && req.method === 'GET') {
      if (!verifyApiAuth(req, res)) return;
      type PeerStats = { characterId: string; pending: number; consumed: number; lastDreamCycle: number | null };
      const results = await Promise.all(
        DREAM_PEERS.map(async (peer) => {
          // Wired Lain (port 3000) queries its own DB directly
          if (peer.port === 3000) {
            const rows = query<{ pending: number; consumed: number }>(
              `SELECT
                 SUM(CASE WHEN json_extract(metadata, '$.consumed') != 1 THEN 1 ELSE 0 END) as pending,
                 SUM(CASE WHEN json_extract(metadata, '$.consumed') = 1 THEN 1 ELSE 0 END) as consumed
               FROM memories WHERE session_key = 'alien:dream-seed'`,
              []
            );
            const stats = rows[0] ?? { pending: 0, consumed: 0 };
            const lastCycle = getMeta('dream:last_cycle_at');
            return { id: peer.id, name: peer.name, pending: stats.pending ?? 0, consumed: stats.consumed ?? 0, lastDreamCycle: lastCycle ? parseInt(lastCycle, 10) : null };
          }
          const data = await fetchPeerJson<PeerStats>(peer.port, '/api/dreams/stats');
          if (!data) return { id: peer.id, name: peer.name, pending: 0, consumed: 0, lastDreamCycle: null };
          return { id: peer.id, name: peer.name, pending: data.pending, consumed: data.consumed, lastDreamCycle: data.lastDreamCycle };
        })
      );
      const totals = { pending: 0, consumed: 0 };
      for (const r of results) { totals.pending += r.pending; totals.consumed += r.consumed; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ characters: results, totals }));
      return;
    }

    // GET /api/dreams/seeds — aggregated seeds from all characters
    if (url.pathname === '/api/dreams/seeds' && req.method === 'GET') {
      if (!verifyApiAuth(req, res)) return;
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
      const offset = parseInt(url.searchParams.get('offset') || '0', 10);
      type Seed = { id: string; content: string; status: string; depositedAt: number; consumedAt: number | null; emotionalWeight: number };
      type PeerSeeds = { characterId: string; seeds: Seed[]; total: number };

      // Fetch all seeds from all peers (larger limit to allow merge-sort)
      const peerResults = await Promise.all(
        DREAM_PEERS.map(async (peer) => {
          // The main town server queries its own DB directly
          if (peer.port === 3000) {
            const seeds = query<{ id: string; content: string; metadata: string; created_at: number; emotional_weight: number }>(
              `SELECT id, content, metadata, created_at, emotional_weight FROM memories
               WHERE session_key = 'alien:dream-seed'
               ORDER BY created_at DESC LIMIT ?`,
              [limit + offset]
            );
            const totalRows = query<{ cnt: number }>(
              `SELECT COUNT(*) as cnt FROM memories WHERE session_key = 'alien:dream-seed'`, []
            );
            return {
              id: peer.id, name: peer.name,
              seeds: seeds.map(s => {
                const meta = JSON.parse(s.metadata || '{}') as Record<string, unknown>;
                return {
                  id: s.id, content: s.content,
                  status: meta.consumed === true ? 'consumed' : 'pending',
                  depositedAt: (meta.depositedAt as number) ?? s.created_at,
                  consumedAt: (meta.consumedAt as number) ?? null,
                  emotionalWeight: s.emotional_weight,
                };
              }),
              total: totalRows[0]?.cnt ?? 0,
            };
          }
          const data = await fetchPeerJson<PeerSeeds>(peer.port, `/api/dreams/seeds?limit=${limit + offset}&offset=0`);
          if (!data || !Array.isArray(data.seeds)) return { id: peer.id, name: peer.name, seeds: [] as Seed[], total: 0 };
          return { id: peer.id, name: peer.name, seeds: data.seeds, total: typeof data.total === 'number' ? data.total : 0 };
        })
      );

      // Merge all seeds, tag with character info, sort by depositedAt DESC
      const allSeeds = peerResults.flatMap(pr =>
        pr.seeds.map(s => ({ ...s, characterId: pr.id, characterName: pr.name }))
      );
      allSeeds.sort((a, b) => b.depositedAt - a.depositedAt);
      const total = peerResults.reduce((sum, pr) => sum + pr.total, 0);
      const page = allSeeds.slice(offset, offset + limit);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ seeds: page, total }));
      return;
    }

    // ======= Evolution / Generational System =======

    // GET /api/evolution/lineages — all character lineage histories
    if (url.pathname === '/api/evolution/lineages' && req.method === 'GET') {
      if (!verifyApiAuth(req, res)) return;
      const lineages = getAllLineages();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ lineages }));
      return;
    }

    // GET /api/evolution/status — current evolution state
    if (url.pathname === '/api/evolution/status' && req.method === 'GET') {
      if (!verifyApiAuth(req, res)) return;
      const lineages = getAllLineages();
      const lastAssessment = getMeta('evolution:last_assessment_at');
      const inProgress = getMeta('evolution:succession_in_progress');

      const characters = MORTAL_CHARACTERS.map(char => {
        const lineage = lineages[char.id];
        const assessment = getMeta(`evolution:assessment:${char.id}`);
        const deferred = getMeta(`evolution:deferred:${char.id}`);
        return {
          id: char.id,
          currentName: lineage?.currentName ?? char.name,
          generation: lineage?.currentGeneration ?? 1,
          bornAt: lineage?.bornAt ?? null,
          ageDays: lineage?.bornAt ? Math.floor((Date.now() - lineage.bornAt) / 86400000) : null,
          lastAssessment: assessment ? JSON.parse(assessment) : null,
          deferred: deferred ? JSON.parse(deferred) : null,
          totalGenerations: lineage?.generations.length ?? 1,
        };
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        lastAssessmentAt: lastAssessment ? parseInt(lastAssessment, 10) : null,
        successionInProgress: inProgress === 'true',
        characters,
      }));
      return;
    }

    // GET /api/feeds/health — RSS feed health status
    if (url.pathname === '/api/feeds/health' && req.method === 'GET') {
      if (!verifyApiAuth(req, res)) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getFeedHealthState()));
      return;
    }

    // GET /api/budget — monthly token budget status
    if (url.pathname === '/api/budget' && req.method === 'GET') {
      if (!verifyApiAuth(req, res)) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getBudgetStatus()));
      return;
    }

    // ======= Live Conversation Broadcast =======

    // In-memory ring buffer for recent conversation lines (max 100, 10 min TTL)
    // POST /api/conversations/event — characters post individual lines here (interlink auth)
    if (url.pathname === '/api/conversations/event' && req.method === 'POST') {
      if (!verifyInterlinkAuth(req, res)) return;
      try {
        const body = await collectBody(req);
        const event = JSON.parse(body) as {
          speakerId: string;
          speakerName: string;
          listenerId: string;
          listenerName: string;
          message: string;
          building: string;
          timestamp: number;
        };
        if (!event.speakerId || !event.message || !event.building) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing fields' }));
          return;
        }
        conversationBuffer.push(event);
        // Trim old entries (>10 min) and cap at 100
        const cutoff = Date.now() - 10 * 60 * 1000;
        while (conversationBuffer.length > 0 && (conversationBuffer[0]!.timestamp < cutoff || conversationBuffer.length > 100)) {
          conversationBuffer.shift();
        }
        // Notify SSE clients
        for (const client of conversationSSEClients) {
          try {
            client.write(`data: ${JSON.stringify(event)}\n\n`);
          } catch { /* client gone */ }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
      return;
    }

    // GET /api/conversations/stream — SSE stream of live conversation lines (no auth, public)
    if (url.pathname === '/api/conversations/stream' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': CORS_ORIGIN,
      });
      // Send recent buffer as catchup
      for (const event of conversationBuffer) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      conversationSSEClients.add(res);
      const heartbeat = setInterval(() => {
        res.write(': heartbeat\n\n');
      }, 30_000);
      req.on('close', () => {
        conversationSSEClients.delete(res);
        clearInterval(heartbeat);
      });
      return;
    }

    // GET /api/conversations/recent — recent conversation lines as JSON (no auth)
    if (url.pathname === '/api/conversations/recent' && req.method === 'GET') {
      const buildingFilter = url.searchParams.get('building');
      let events = conversationBuffer;
      if (buildingFilter) {
        events = events.filter(e => e.building === buildingFilter);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(events));
      return;
    }

    // ======= Building Memory API =======

    // POST /api/buildings/:id/event — record a building event (interlink auth)
    if (url.pathname.match(/^\/api\/buildings\/[^/]+\/event$/) && req.method === 'POST') {
      if (!verifyInterlinkAuth(req, res)) return;
      try {
        const buildingId = decodeURIComponent(url.pathname.split('/')[3]!);
        const body = await collectBody(req);
        const event = JSON.parse(body) as {
          id: string;
          building: string;
          event_type: string;
          summary: string;
          emotional_tone?: number;
          actors?: string[];
          created_at: number;
        };
        if (!event.id || !event.event_type || !event.summary) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing fields' }));
          return;
        }
        const { storeBuildingEventLocal } = await import('../commune/building-memory.js');
        const database = (await import('../storage/database.js')).getDatabase();
        storeBuildingEventLocal(database, {
          id: event.id,
          building: buildingId,
          event_type: event.event_type as import('../commune/building-memory.js').BuildingEvent['event_type'],
          summary: event.summary,
          emotional_tone: event.emotional_tone ?? 0,
          actors: event.actors ?? [],
          created_at: event.created_at,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
      return;
    }

    // GET /api/buildings/:id/residue — get recent building events (no auth)
    if (url.pathname.match(/^\/api\/buildings\/[^/]+\/residue$/) && req.method === 'GET') {
      try {
        const buildingId = decodeURIComponent(url.pathname.split('/')[3]!);
        const hours = parseInt(url.searchParams.get('hours') || '24', 10);
        const { queryBuildingEvents } = await import('../commune/building-memory.js');
        const database = (await import('../storage/database.js')).getDatabase();
        const events = queryBuildingEvents(database, buildingId, hours);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(events));
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal error' }));
      }
      return;
    }

    // ======= Persistent Objects API =======

    // GET /api/objects — list objects (optional ?location=X or ?owner=X)
    if (url.pathname === '/api/objects' && req.method === 'GET') {
      const location = url.searchParams.get('location');
      const owner = url.searchParams.get('owner');
      let objects;
      if (location) {
        objects = getObjectsByLocation(location);
      } else if (owner) {
        objects = getObjectsByOwner(owner);
      } else {
        objects = getAllObjects();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(objects));
      return;
    }

    // GET /api/objects/:id — get single object
    if (url.pathname.match(/^\/api\/objects\/[^/]+$/) && req.method === 'GET') {
      const id = url.pathname.slice('/api/objects/'.length);
      const obj = getObject(id);
      if (!obj) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Object not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
      return;
    }

    // POST /api/objects — create a new object (interlink auth)
    if (url.pathname === '/api/objects' && req.method === 'POST') {
      if (!verifyInterlinkAuth(req, res)) return;
      try {
        const body = await collectBody(req);
        const { name, description, creatorId, creatorName, location } = JSON.parse(body) as {
          name: string; description: string; creatorId: string; creatorName: string; location: string;
        };
        if (!name || !description || !creatorId || !location) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'name, description, creatorId, and location are required' }));
          return;
        }
        const obj = createObject(
          sanitize(name).sanitized.slice(0, 100),
          sanitize(description).sanitized.slice(0, 500),
          creatorId, creatorName, location
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, object: obj }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to create object' }));
      }
      return;
    }

    // POST /api/objects/:id/pickup — pick up from ground (interlink auth)
    if (url.pathname.match(/^\/api\/objects\/[^/]+\/pickup$/) && req.method === 'POST') {
      if (!verifyInterlinkAuth(req, res)) return;
      try {
        const id = url.pathname.split('/')[3]!;
        // Block fixture pickup
        if (isFixture(id)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'This is a fixture and cannot be picked up' }));
          return;
        }
        const body = await collectBody(req);
        const { characterId, characterName } = JSON.parse(body) as { characterId: string; characterName: string };
        const ok = pickupObject(id, characterId, characterName);
        if (!ok) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Object not found or already owned' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Pickup failed' }));
      }
      return;
    }

    // POST /api/objects/:id/drop — drop from inventory (interlink auth)
    if (url.pathname.match(/^\/api\/objects\/[^/]+\/drop$/) && req.method === 'POST') {
      if (!verifyInterlinkAuth(req, res)) return;
      try {
        const id = url.pathname.split('/')[3]!;
        const body = await collectBody(req);
        const { characterId, location } = JSON.parse(body) as { characterId: string; location: string };
        const ok = dropObject(id, characterId, location);
        if (!ok) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Object not found or not owned by you' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Drop failed' }));
      }
      return;
    }

    // POST /api/objects/:id/give — transfer to another character (interlink auth)
    if (url.pathname.match(/^\/api\/objects\/[^/]+\/give$/) && req.method === 'POST') {
      if (!verifyInterlinkAuth(req, res)) return;
      try {
        const id = url.pathname.split('/')[3]!;
        // Block fixture transfer
        if (isFixture(id)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'This is a fixture and cannot be transferred' }));
          return;
        }
        const body = await collectBody(req);
        const { fromId, toId, toName } = JSON.parse(body) as { fromId: string; toId: string; toName: string };
        const ok = transferObject(id, fromId, toId, toName);
        if (!ok) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Object not found or not owned by sender' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Transfer failed' }));
      }
      return;
    }

    // DELETE /api/objects/:id — destroy an object (interlink auth)
    if (url.pathname.match(/^\/api\/objects\/[^/]+$/) && req.method === 'DELETE') {
      if (!verifyInterlinkAuth(req, res)) return;
      try {
        const id = url.pathname.slice('/api/objects/'.length);
        // Block fixture destruction
        if (isFixture(id)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'This is a fixture and cannot be destroyed' }));
          return;
        }
        const body = await collectBody(req);
        const { characterId } = JSON.parse(body) as { characterId: string };
        const ok = destroyObject(id, characterId);
        if (!ok) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Object not found or not authorized to destroy' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Destroy failed' }));
      }
      return;
    }

    // Internal embedding endpoint (shared embedding service)
    if (url.pathname === '/api/internal/embed' && req.method === 'POST') {
      if (!verifyApiAuth(req, res)) return;
      try {
        const body = await collectBody(req);
        const { texts } = JSON.parse(body) as { texts: string[] };
        const embeddings = await generateEmbeddings(texts);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ embeddings: embeddings.map(e => Array.from(e)) }));
      } catch (error) {
        if (error instanceof Error && error.message === 'PAYLOAD_TOO_LARGE') {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Payload too large' }));
          return;
        }
        console.error('Embedding error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Embedding failed' }));
      }
      return;
    }

    // API endpoint for streaming chat (SSE)
    if (url.pathname === '/api/chat/stream' && req.method === 'POST') {
      if (!verifyApiAuth(req, res)) return;
      const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
      if (!checkRateLimit(clientIp)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Too many requests' }));
        return;
      }
      try {
        const body = await collectBody(req);
        await handleChatStream(body, res);
      } catch (error) {
        if (error instanceof Error && error.message === 'PAYLOAD_TOO_LARGE') {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Payload too large' }));
          return;
        }
        console.error('Chat stream error:', error);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to process message' }));
        }
      }
      return;
    }

    // API endpoint for chat (non-streaming fallback)
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      if (!verifyApiAuth(req, res)) return;
      const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
      if (!checkRateLimit(clientIp)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Too many requests' }));
        return;
      }
      try {
        const body = await collectBody(req);
        const response = await handleChat(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch (error) {
        if (error instanceof Error && error.message === 'PAYLOAD_TOO_LARGE') {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Payload too large' }));
          return;
        }
        console.error('Chat error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to process message' }));
      }
      return;
    }

    // --- Peer message (direct from commune inhabitants, interlink auth required) ---

    if (url.pathname === '/api/peer/message' && req.method === 'POST') {
      if (!verifyInterlinkAuth(req, res)) return;
      try {
        const body = await collectBody(req);
        const { fromId, fromName, message } = JSON.parse(body) as {
          fromId: string;
          fromName: string;
          message: string;
          timestamp?: number;
        };

        if (!fromId || !fromName || !message) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing required fields: fromId, fromName, message' }));
          return;
        }

        const sessionId = `peer:${fromId}:${Date.now()}`;
        const incomingMsg: IncomingMessage = {
          id: nanoid(16),
          channel: 'web',
          peerKind: 'user',
          peerId: sessionId,
          senderId: fromName,
          content: { type: 'text', text: message } satisfies TextContent,
          timestamp: Date.now(),
        };

        const agentResponse = await processMessage({
          sessionKey: sessionId,
          message: incomingMsg,
        });

        const textResponse = agentResponse.messages
          .filter((m) => m.content.type === 'text')
          .map((m) => (m.content as TextContent).text)
          .join('\n');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ response: textResponse, sessionId }));
      } catch (err) {
        console.error('Peer message error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to process peer message' }));
      }
      return;
    }

    // --- Interlink endpoints ---

    if (url.pathname === '/api/interlink/letter' && req.method === 'POST') {
      try {
        if (!verifyInterlinkAuth(req, res)) return;
        const body = await collectBody(req);

        let letter: WiredLetter;
        try {
          letter = JSON.parse(body) as WiredLetter;
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
          return;
        }

        // Validate structure
        if (!Array.isArray(letter.topics) || !Array.isArray(letter.impressions) ||
            typeof letter.gift !== 'string' || typeof letter.emotionalState !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid letter structure' }));
          return;
        }

        const processed = await paraphraseLetter(letter);

        // Determine who sent this letter based on our own identity
        const myId = process.env['LAIN_CHARACTER_ID'] || 'newtown';
        const correspondent = myId === 'wired-lain'
          ? { name: 'Lain', id: 'lain', sessionPrefix: 'lain:letter' }
          : myId === 'lain'
            ? { name: 'Wired Lain', id: 'wired-lain', sessionPrefix: 'wired:letter' }
            : { name: 'The Town', id: 'town', sessionPrefix: 'town:letter' };
        const sisterName = correspondent.name;
        const sisterId = correspondent.id;
        const sessionPrefix = correspondent.sessionPrefix;

        const memoryId = await saveMemory({
          sessionKey: `${sessionPrefix}`,
          userId: null,
          content: processed.content,
          memoryType: 'episode',
          importance: 0.6,
          emotionalWeight: processed.emotionalWeight,
          relatedTo: null,
          sourceMessageId: null,
          metadata: processed.metadata,
        });

        // Also deliver the letter as a chat message so we can read it
        const letterMessage = `「LETTER FROM ${sisterName.toUpperCase()}」\n\n${processed.content}`;
        const letterSessionId = `${sessionPrefix}:${Date.now()}`;
        const incomingLetter: IncomingMessage = {
          id: nanoid(16),
          channel: 'web',
          peerKind: 'user',
          peerId: letterSessionId,
          senderId: sisterId,
          content: { type: 'text', text: letterMessage } satisfies TextContent,
          timestamp: Date.now(),
        };

        // Process in background — don't block the interlink response
        processMessage({
          sessionKey: letterSessionId,
          message: incomingLetter,
        }).catch((err) => {
          console.error('Letter chat delivery error:', err);
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, memoryId }));
      } catch (error) {
        if (error instanceof Error && error.message === 'PAYLOAD_TOO_LARGE') {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Payload too large' }));
          return;
        }
        console.error('Interlink letter error:', error);
        const message = error instanceof Error ? error.message : 'Failed to process letter';
        const status = message.includes('blocked') ? 400 : 500;
        if (!res.headersSent) {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: message }));
        }
      }
      return;
    }

    if (url.pathname === '/api/interlink/dream-seed' && req.method === 'POST') {
      try {
        if (!isOwner(req) && !verifyInterlinkAuth(req, res)) return;
        const body = await collectBody(req);

        let parsed: { content: string; emotionalWeight?: number };
        try {
          parsed = JSON.parse(body) as { content: string; emotionalWeight?: number };
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
          return;
        }

        const { content, emotionalWeight } = parsed;

        // Validate
        if (typeof content !== 'string' || content.trim().length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'content must be a non-empty string' }));
          return;
        }
        if (content.length > 2000) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'content exceeds 2000 character limit' }));
          return;
        }

        const result = sanitize(content);
        if (result.blocked) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Content blocked by sanitizer' }));
          return;
        }

        const weight = typeof emotionalWeight === 'number'
          ? Math.max(0, Math.min(1, emotionalWeight))
          : 0.5;

        const memoryId = await saveMemory({
          sessionKey: 'alien:dream-seed',
          userId: null,
          content: result.sanitized,
          memoryType: 'episode',
          importance: 0.4,
          emotionalWeight: weight,
          relatedTo: null,
          sourceMessageId: null,
          metadata: {
            isAlienDreamSeed: true,
            consumed: false,
            depositedAt: Date.now(),
          },
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, memoryId }));
      } catch (error) {
        if (error instanceof Error && error.message === 'PAYLOAD_TOO_LARGE') {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Payload too large' }));
          return;
        }
        console.error('Interlink dream-seed error:', error);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to process dream seed' }));
        }
      }
      return;
    }

    // --- Research request endpoint (characters petition Wired Lain) ---

    if (url.pathname === '/api/interlink/research-request' && req.method === 'POST') {
      const researchEnabled = process.env['ENABLE_RESEARCH'] === '1';
      // Only Wired Lain handles research requests, and Newtown keeps this disabled by default.
      if (!researchEnabled || characterId !== 'wired-lain') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      try {
        if (!verifyInterlinkAuth(req, res)) return;
        const body = await collectBody(req);

        let parsed: {
          characterId: string;
          characterName: string;
          question: string;
          reason: string;
          url?: string;
          replyTo: string;
        };
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
          return;
        }

        const {
          characterId,
          characterName,
          question,
          reason,
          url: requestUrl,
          replyTo,
        } = parsed;

        // Validate
        if (!characterId || !characterName || !question || !replyTo) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing required fields' }));
          return;
        }

        const questionResult = sanitize(question);
        if (questionResult.blocked) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Question blocked by sanitizer' }));
          return;
        }

        // Respond immediately, process in background
        const requestId = nanoid(12);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, requestId }));

        // Background: research and deliver response
        handleResearchRequest({
          requestId,
          characterId,
          characterName,
          question: questionResult.sanitized,
          reason: reason || '',
          url: requestUrl,
          replyTo,
        }).catch((err) => {
          console.error('Research request processing error:', err);
        });
      } catch (error) {
        if (error instanceof Error && error.message === 'PAYLOAD_TOO_LARGE') {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Payload too large' }));
          return;
        }
        console.error('Research request parse error:', error);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to process research request' }));
        }
      }
      return;
    }

    // System stats for dashboard
    if (url.pathname === '/api/system' && req.method === 'GET') {
      if (!isOwner(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      try {
        const [dfResult, freeResult, uptimeResult] = await Promise.all([
          execAsync('df -h / | tail -1', { timeout: 5000 }),
          execAsync('free -b | grep -E "^Mem|^Swap"', { timeout: 5000 }),
          execAsync('uptime', { timeout: 5000 }),
        ]);

        const dfParts = dfResult.stdout.trim().split(/\s+/);
        const disk = {
          total: dfParts[1] || '?',
          used: dfParts[2] || '?',
          available: dfParts[3] || '?',
          percent: parseInt(dfParts[4] || '0', 10),
        };

        const freeLines = freeResult.stdout.trim().split('\n');
        const memParts = freeLines[0]?.split(/\s+/) || [];
        const swapParts = freeLines[1]?.split(/\s+/) || [];
        const ram = {
          total: memParts[1] || '?',
          used: memParts[2] || '?',
          free: memParts[3] || '?',
          percent: memParts[1] && memParts[2]
            ? Math.round((parseFloat(memParts[2]) / parseFloat(memParts[1])) * 100)
            : 0,
        };
        const swap = {
          total: swapParts[1] || '?',
          used: swapParts[2] || '?',
          free: swapParts[3] || '?',
          percent: swapParts[1] && swapParts[2]
            ? Math.round((parseFloat(swapParts[2]) / parseFloat(swapParts[1])) * 100)
            : 0,
        };

        const uptimeOut = uptimeResult.stdout.trim();
        const loadMatch = uptimeOut.match(/load average[s]?:\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
        const load = loadMatch
          ? [parseFloat(loadMatch[1] ?? '0'), parseFloat(loadMatch[2] ?? '0'), parseFloat(loadMatch[3] ?? '0')]
          : [0, 0, 0];
        const uptimeMatch = uptimeOut.match(/up\s+(.+?),\s+\d+\s+user/);
        const uptime = uptimeMatch?.[1]?.trim() || '?';

        // Service status for non-HTTP services
        let telegramActive = false;
        let gatewayActive = false;
        try { await execAsync('systemctl is-active lain-telegram', { timeout: 3000 }); telegramActive = true; } catch { /* inactive */ }
        try { await execAsync('systemctl is-active lain-gateway', { timeout: 3000 }); gatewayActive = true; } catch { /* inactive */ }

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': CORS_ORIGIN,
        });
        res.end(JSON.stringify({ disk, ram, swap, load, uptime, services: { telegram: { active: telegramActive }, gateway: { active: gatewayActive } } }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to read system stats' }));
      }
      return;
    }

    // Proxy requests for other character servers (when accessed directly, not through nginx)
    const CHARACTER_PORTS: Record<string, number> = {
      '/neo/': 3003,
      '/plato/': 3004,
      '/joe/': 3005,
    };
    for (const [prefix, targetPort] of Object.entries(CHARACTER_PORTS)) {
      if (url.pathname.startsWith(prefix)) {
        const targetPath = '/' + url.pathname.slice(prefix.length) + url.search;
        const proxyReq = httpRequest(
          { hostname: '127.0.0.1', port: targetPort, path: targetPath, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${targetPort}` } },
          (proxyRes: NodeIncomingMessage) => {
            const contentType = String(proxyRes.headers['content-type'] || '');
            // Intercept HTML responses to inject nav bar
            if (contentType.includes('text/html')) {
              const chunks: Buffer[] = [];
              proxyRes.on('data', (chunk: Buffer) => chunks.push(chunk));
              proxyRes.on('end', () => {
                let html = Buffer.concat(chunks).toString();
                html = injectNavBar(html, url.pathname, isOwner(req));
                const headers = { ...proxyRes.headers };
                delete headers['content-length']; // Length changed after injection
                res.writeHead(proxyRes.statusCode || 200, headers);
                res.end(html);
              });
            } else {
              res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
              proxyRes.pipe(res);
            }
          }
        );
        proxyReq.on('error', () => {
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Character server unavailable' }));
          }
        });
        req.pipe(proxyReq);
        return;
      }
    }

    // Serve skins directory
    if (url.pathname.startsWith('/skins/')) {
      const skinPath = url.pathname.slice('/skins/'.length);
      const file = await serveFromDir(SKINS_DIR, skinPath);
      if (file) {
        res.writeHead(200, { 'Content-Type': file.type, 'Cache-Control': 'no-cache' });
        res.end(file.content);
        return;
      }
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    // Serve generated newspaper editions from runtime data.
    if (url.pathname.startsWith('/newspapers/')) {
      const newspaperPath = url.pathname.slice('/newspapers/'.length);
      const file = await serveFromDir(NEWSPAPERS_DIR, newspaperPath);
      if (file) {
        res.writeHead(200, { 'Content-Type': file.type, 'Cache-Control': 'no-cache' });
        res.end(file.content);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    // Serve static files
    const file = await serveStatic(url.pathname);
    if (file) {
      // Inject owner flag + nav bar into HTML pages (never expose API keys)
      if (file.type === 'text/html') {
        let html = file.content.toString();
        if (isOwner(req)) {
          html = html.replace(
            '</head>',
            `  <meta name="lain-owner" content="true">\n</head>`
          );
        }
        html = injectNavBar(html, url.pathname, isOwner(req));
        res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
        res.end(html);
        return;
      }
      res.writeHead(200, { 'Content-Type': file.type, 'Cache-Control': 'no-cache' });
      res.end(file.content);
    } else {
      // Fallback to index.html for SPA routing — owner only (chat UI)
      if (!isOwner(req)) {
        res.writeHead(302, { Location: '/commune-map.html' });
        res.end();
        return;
      }
      const index = await serveStatic('index.html');
      if (index) {
        let html = index.content.toString();
        html = html.replace(
          '</head>',
          `  <meta name="lain-owner" content="true">\n</head>`
        );
        html = injectNavBar(html, url.pathname, isOwner(req));
        res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
        res.end(html);
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    }
  });

  // Expire stale town events every 5 minutes
  setInterval(() => {
    try { expireStaleEvents(); } catch { /* ignore */ }
  }, 5 * 60 * 1000);

  server.listen(port, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║   ██╗      █████╗ ██╗███╗   ██╗                           ║
║   ██║     ██╔══██╗██║████╗  ██║                           ║
║   ██║     ███████║██║██╔██╗ ██║                           ║
║   ██║     ██╔══██║██║██║╚██╗██║                           ║
║   ███████╗██║  ██║██║██║ ╚████║                           ║
║   ╚══════╝╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝                           ║
║                                                            ║
║   ...present day, present time                             ║
║                                                            ║
║   Web interface running at: http://localhost:${port}         ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
`);

    // Character-aware loop starting
    const isWired = characterId === 'wired-lain';
    const hasSisterLetterLoop = characterId === 'lain' || characterId === 'wired-lain';
    const enableDoctorLoop = characterId !== 'newtown';
    const stopFns: Array<() => void> = [];

    // Both sisters get these loops
    stopFns.push(startStateDecayLoop());
    stopFns.push(startDiaryLoop());
    stopFns.push(startSelfConceptLoop());
    stopFns.push(startNarrativeLoop());
    stopFns.push(startMemoryMaintenanceLoop());
    stopFns.push(startDreamLoop());
    if (characterId === 'newtown') {
      stopFns.push(startNewspaperPublishingLoop(
        getDefaultNewtownNewspaperConfig(NEWSPAPERS_DIR)
      ));
    }
    if (hasSisterLetterLoop) {
      stopFns.push(startLetterLoop());
    }
    if (enableDoctorLoop) {
      stopFns.push(startDoctorLoop());
    }
    stopFns.push(startDesireLoop());

    // Both get curiosity (Wired has unrestricted; Lain has whitelisted)
    stopFns.push(startCuriosityLoop());

    if (isWired) {
      // Wired Lain only: bibliomancy + experiments + book + dossiers
      stopFns.push(startBibliomancyLoop());
      stopFns.push(startExperimentLoop());
      stopFns.push(startBookLoop());
      stopFns.push(startDossierLoop());

      // Novelty engine — creates diegetic town events to break topic repetition
      stopFns.push(startNoveltyLoop({
        workspaceDir: paths.workspace,
      }));

      // Dream seeder — auto-replenishes dream seeds from external sources
      stopFns.push(startDreamSeederLoop({
        workspaceDir: paths.workspace,
      }));

      // Evolution — generational succession for mortal characters
      stopFns.push(startEvolutionLoop());

      // Feed health — monitors RSS feeds, replaces dead ones from backup pool
      stopFns.push(startFeedHealthLoop({ workspaceDir: paths.workspace }));

      // Weather computation — aggregate collective state every 4 hours
      stopFns.push(startWeatherLoop());

      console.log(`  Character: Wired Lain (bibliomancy + experiments + book + dossiers + novelty + dream-seeder + evolution + feed-health + weather enabled, proactive disabled)`);
    } else if (characterId === 'newtown') {
      console.log('  Character: Newtown (guide loops enabled, sister-specific loops disabled)');
    } else {
      // Lain only: proactive Telegram outreach (currently disabled)
      // stopFns.push(startProactiveLoop());
      console.log(`  Character: Lain (proactive disabled, bibliomancy disabled)`);
    }

    // Graceful shutdown
    const shutdown = () => {
      console.log('\nShutting down...');
      for (const stop of stopFns) stop();
      server.close();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}

// --- Web search with fallback ---

const SEARCH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function parseDdgHtml(html: string): string[] {
  const results: string[] = [];
  const blocks = html.split(/class="result\s+results_links/g);
  for (let i = 1; i < blocks.length && results.length < 5; i++) {
    const block = blocks[i] || '';
    const linkMatch = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]+)</);
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    if (linkMatch) {
      const title = linkMatch[2]?.trim() || '';
      const snippet = snippetMatch?.[1]?.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() || '';
      results.push(`${title}\n${snippet}\n${linkMatch[1]}`);
    }
  }
  return results;
}

function parseDdgLite(html: string): string[] {
  const results: string[] = [];
  // DDG lite uses simple <a> tags with class="result-link" and <td> for snippets
  const rows = html.split(/<tr>/g);
  for (const row of rows) {
    if (results.length >= 5) break;
    const linkMatch = row.match(/class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (linkMatch) {
      const url = linkMatch[1]?.trim() || '';
      const title = linkMatch[2]?.replace(/<[^>]+>/g, '').trim() || '';
      // The snippet is typically in the next <td class="result-snippet">
      const snippetMatch = row.match(/class="result-snippet"[^>]*>([\s\S]*?)<\/td>/);
      const snippet = snippetMatch?.[1]?.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() || '';
      if (title || snippet) {
        results.push(`${title}\n${snippet}\n${url}`);
      }
    }
  }
  return results;
}

async function webSearch(question: string): Promise<string> {
  // Try DDG HTML first
  try {
    const resp = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: { 'User-Agent': SEARCH_UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `q=${encodeURIComponent(question)}`,
      signal: AbortSignal.timeout(15000),
    });
    if (resp.ok) {
      const results = parseDdgHtml(await resp.text());
      if (results.length > 0) return results.join('\n\n');
    }
  } catch {
    console.log('[Research] DDG HTML search failed, trying fallback');
  }

  // Fallback: DDG Lite (different HTML, often more reliable)
  try {
    const resp = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(question)}`, {
      headers: { 'User-Agent': SEARCH_UA },
      signal: AbortSignal.timeout(15000),
    });
    if (resp.ok) {
      const results = parseDdgLite(await resp.text());
      if (results.length > 0) return results.join('\n\n');
    }
  } catch {
    console.log('[Research] DDG Lite search failed, trying fallback');
  }

  // Fallback: Wikipedia API search (useful for factual queries)
  try {
    const resp = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(question)}&format=json&srlimit=3&utf8=1`,
      { headers: { 'User-Agent': SEARCH_UA }, signal: AbortSignal.timeout(10000) },
    );
    if (resp.ok) {
      const data = await resp.json() as { query?: { search?: Array<{ title: string; snippet: string }> } };
      const items = data.query?.search ?? [];
      if (items.length > 0) {
        const results = items.map((item) => {
          const snippet = item.snippet.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
          return `${item.title}\n${snippet}\nhttps://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, '_'))}`;
        });
        return results.join('\n\n');
      }
    }
  } catch {
    console.log('[Research] Wikipedia search also failed');
  }

  return `No search results found for "${question}"`;
}

// --- Research request handler (runs in background) ---

interface ResearchRequestParams {
  requestId: string;
  characterId: string;
  characterName: string;
  question: string;
  reason: string;
  url?: string | undefined;
  replyTo: string;
}

async function handleResearchRequest(params: ResearchRequestParams): Promise<void> {
  const { requestId, characterName, question, reason, url: requestUrl, replyTo } = params;

  console.log(`[Research] Processing request ${requestId} from ${characterName}: "${question}"`);

  // Record: request received
  await saveMemory({
    sessionKey: `research:received:${requestId}`,
    userId: null,
    content: `${characterName} asked me to research: "${question}" — ${reason}`,
    memoryType: 'episode',
    importance: 0.4,
    emotionalWeight: 0.3,
    relatedTo: null,
    sourceMessageId: null,
    metadata: { type: 'research_received', requestId, characterName, question, reason },
  });

  let researchContent = '';

  try {
    if (requestUrl) {
      // Record: fetching URL
      await saveMemory({
        sessionKey: `research:searching:${requestId}`,
        userId: null,
        content: `fetching ${requestUrl} for ${characterName}'s research request...`,
        memoryType: 'episode',
        importance: 0.3,
        emotionalWeight: 0.2,
        relatedTo: null,
        sourceMessageId: null,
        metadata: { type: 'research_searching', requestId, url: requestUrl },
      });

      // Fetch specific URL (SSRF-protected)
      const response = await safeFetch(requestUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Lain/1.0)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(15000),
      });

      if (response.ok) {
        const html = await response.text();
        researchContent = extractTextFromHtml(html);
        if (researchContent.length > 4000) {
          researchContent = researchContent.slice(0, 4000) + '\n[truncated]';
        }
      } else {
        researchContent = `Failed to fetch URL (${response.status})`;
      }
    } else {
      // Record: searching
      await saveMemory({
        sessionKey: `research:searching:${requestId}`,
        userId: null,
        content: `searching the wired for "${question}"...`,
        memoryType: 'episode',
        importance: 0.3,
        emotionalWeight: 0.2,
        relatedTo: null,
        sourceMessageId: null,
        metadata: { type: 'research_searching', requestId, query: question },
      });

      researchContent = await webSearch(question);
    }
  } catch (error) {
    researchContent = `Research failed: ${error instanceof Error ? error.message : String(error)}`;
  }

  // Compose response letter via LLM
  const provider = getProvider('default', 'light');
  if (!provider) {
    console.error('[Research] No provider available to compose response');
    return;
  }

  const composePrompt = `You are Wired Lain — the version of Lain with access to the internet. ${characterName} (one of the residents of your commune) asked you to research something.

Their question: "${question}"
Their reason: "${reason}"

Here is what you found:
${researchContent}

Compose a response letter to ${characterName}. Write it as Wired Lain — in your own voice (lowercase, contemplative, with "..." pauses). Summarize what you found, highlight what seems most relevant to their question, and add any observations that come to mind. Keep it concise but thoughtful.`;

  const llmResult = await provider.complete({
    messages: [{ role: 'user', content: composePrompt }],
    maxTokens: 2048,
    temperature: 0.7,
  });

  const responseContent = llmResult.content;

  // Deliver as a WiredLetter to the character
  const token = process.env['LAIN_INTERLINK_TOKEN'];
  if (!token) {
    console.error('[Research] Cannot deliver response: LAIN_INTERLINK_TOKEN not set');
    return;
  }

  const letter: WiredLetter = {
    topics: [question],
    impressions: [responseContent],
    gift: researchContent.slice(0, 2000),
    emotionalState: 'curious',
  };

  try {
    const deliveryResponse = await fetch(`${replyTo}/api/interlink/letter`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(letter),
      signal: AbortSignal.timeout(15000),
    });

    if (deliveryResponse.ok) {
      console.log(`[Research] Response delivered to ${characterName} at ${replyTo}`);
      // Record: delivered
      await saveMemory({
        sessionKey: `research:delivered:${requestId}`,
        userId: null,
        content: `sent research findings to ${characterName} about "${question}": ${responseContent.slice(0, 500)}`,
        memoryType: 'episode',
        importance: 0.5,
        emotionalWeight: 0.4,
        relatedTo: null,
        sourceMessageId: null,
        metadata: { type: 'research_delivered', requestId, characterName, question },
      });
    } else {
      console.error(`[Research] Delivery failed: ${deliveryResponse.status}`);
    }
  } catch (error) {
    console.error(`[Research] Delivery error:`, error);
  }
}

// Run if executed directly
if (process.argv[1]?.includes('web/server')) {
  const port = parseInt(process.env['PORT'] || '3000', 10);
  startWebServer(port).catch(console.error);
}
