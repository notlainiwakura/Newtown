/**
 * Web server for Lain chat interface
 * A Serial Experiments Lain themed web UI
 */

import 'dotenv/config';
import { exec } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
const execAsync = promisify(exec);
import { createServer, request as httpRequest } from 'node:http';
import type { ServerResponse, IncomingMessage as NodeIncomingMessage } from 'node:http';
import { appendFile, mkdir, rename } from 'node:fs/promises';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';
import { initAgent, processMessage, processMessageStream, unregisterTool } from '../agent/index.js';
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
import { startEvolutionLoop, getAllLineages } from '../agent/evolution.js';
import { getMortalCharacters, getHealthCheckTargets, getAllCharacters, requireCharacterName, getWebCharacter, getAgentConfigFor } from '../config/characters.js';
import { startFeedHealthLoop, getFeedHealthState } from '../agent/feed-health.js';
import { startWeatherLoop, startTownWeatherRefreshLoop } from '../commune/weather.js';
import { startBuildingMemoryPruneLoop } from '../commune/building-memory.js';
import { getBudgetStatus } from '../providers/budget.js';
import { paraphraseLetter, type WiredLetter } from '../agent/membrane.js';
import { getProvider } from '../agent/index.js';
import { extractTextFromHtml } from '../agent/tools.js';
import { generateEmbeddings } from '../memory/embeddings.js';
import { saveMemory, getActivity, getNotesByBuilding, getDocumentsByAuthor, savePostboardMessage, getPostboardMessages, deletePostboardMessage, togglePostboardPin, countMemories, countMessages } from '../memory/store.js';
import { createObject, getObject, getObjectsByLocation, getObjectsByOwner, getAllObjects, pickupObject, dropObject, transferObject, destroyObject, isFixture, expireStaleObjects, startObjectExpiryLoop } from '../objects/store.js';
import { eventBus, isBackgroundEvent, type SystemEvent } from '../events/bus.js';
import { createTownEvent, getActiveTownEvents, getAllTownEvents, endTownEvent, startExpireStaleEventsLoop, getActiveEffects, type CreateEventParams } from '../events/town-events.js';
import { sanitize } from '../security/sanitizer.js';
import { safeFetch } from '../security/ssrf.js';
import { isAllowedReplyTo } from '../security/reply-to.js';
import {
  verifyInterlinkRequest,
  assertBodyIdentity,
  getInterlinkHeaders,
} from '../security/interlink-auth.js';
import { secureCompare } from '../utils/crypto.js';
import { isOwner, issueOwnerCookie, clearOwnerCookie, getOwnerNonce } from './owner-auth.js';
import {
  revokeNonce,
  revokeAllNonces,
  revokeNonceOnAuthority,
  revokeAllOnAuthority,
} from './owner-nonce-store.js';
import { getCorsOrigin } from './cors.js';
import { buildHtmlCsp } from './csp-hashes.js';
import { initDatabase, getMeta, query, getDatabase } from '../storage/database.js';
import { getPaths } from '../config/index.js';
import { getBasePath } from '../config/paths.js';
import { getDefaultConfig } from '../config/defaults.js';
import { isResearchEnabled } from '../config/features.js';
import type { IncomingMessage, TextContent, ImageContent } from '../types/message.js';
import { purgeLocalOnlyResearchArtifacts } from '../memory/local-only.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', '..', 'src', 'web', 'public');
const SKINS_DIR = join(__dirname, '..', '..', 'src', 'web', 'skins');
const NEWSPAPERS_DIR = getNewspaperDataDir();
const REMOTE_RESEARCH_TOOLS = [
  'web_search',
  'fetch_webpage',
  'show_image',
  'search_images',
  'fetch_and_show_image',
  'view_image',
];

// findings.md P2:2880 — CSP used to list `'unsafe-inline'` under script-src
// and style-src, defeating XSS protection. Inline blocks in public/ are
// static on disk, so we hash them once at boot and emit each digest as a
// `'sha256-...'` source. No per-request overhead; no page rewriting.
const HTML_CSP = buildHtmlCsp(PUBLIC_DIR);
const LOG_DIR = join(__dirname, '..', '..', 'logs');
const LOG_FILE = join(LOG_DIR, 'lain-debug.log');

// findings.md P2:2444 — debug log used to grow without bound and append raw
// chat bodies verbatim (PII, owner-visible content, etc.). Cap file size
// with single-slot rotation, and redact any long string fields (message
// bodies, response text, stack traces) to a short preview + length hint.
const LOG_MAX_BYTES = 8 * 1024 * 1024; // 8 MB, then rotate
const LOG_FIELD_PREVIEW_BYTES = 200;

function redactLongStrings(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.length <= LOG_FIELD_PREVIEW_BYTES) return value;
    return `${value.slice(0, LOG_FIELD_PREVIEW_BYTES)}…[+${value.length - LOG_FIELD_PREVIEW_BYTES} chars]`;
  }
  if (Array.isArray(value)) return value.map(redactLongStrings);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactLongStrings(v);
    return out;
  }
  return value;
}

async function rotateLogIfLarge(): Promise<void> {
  try {
    const s = await stat(LOG_FILE);
    if (s.size > LOG_MAX_BYTES) {
      await rename(LOG_FILE, `${LOG_FILE}.1`); // overwrites any prior .1
    }
  } catch { /* file doesn't exist yet, or rotate raced — ignore */ }
}

// Debug logging to file
async function debugLog(context: string, data: unknown): Promise<void> {
  try {
    await mkdir(LOG_DIR, { recursive: true });
    await rotateLogIfLarge();
    const redacted = redactLongStrings(data);
    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] [${context}] ${JSON.stringify(redacted, null, 2)}\n${'='.repeat(80)}\n`;
    await appendFile(LOG_FILE, entry);
    console.log(`[DEBUG] [${context}]`, typeof redacted === 'string' ? redacted : JSON.stringify(redacted).substring(0, 200));
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
// isOwner() / issueOwnerCookie() / clearOwnerCookie() imported from ./owner-auth.js

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

// findings.md P2:2446 — getClientIp lives in ./client-ip.ts so
// character-server / doctor-server (P2:2494) can use the same XFF
// trust rule without circular-importing from server.ts. Re-export
// here for back-compat with `test/client-ip-trust.test.ts` which
// imports the helper from '../src/web/server.js'.
export { getClientIp } from './client-ip.js';
import { getClientIp } from './client-ip.js';

// --- CORS origin ---

// findings.md P2:2366 — route through the shared helper so CORS config
// lives in one place across all three servers. Main server keeps the
// permissive `'*'` fallback because the public commune map is designed
// to be embeddable; character/doctor servers default to no header.
const CORS_ORIGIN = getCorsOrigin('*') ?? '*';

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

// findings.md P2:2388 — character routes and ports used to be hardcoded in
// three places (here, the CHARACTER_PORTS proxy map below, and the two
// skin loaders under src/web/skins/). A rename like doctor → dr-claude
// would miss one spot and break skin injection. Derive from the manifest
// instead so a single rename stays consistent.
const STATIC_OWNER_ONLY_PATHS = [
  '/postboard.html',
  '/town-events.html',
  '/dreams.html',
  '/dashboard.html',
  '/api/chat',
  '/api/chat/stream',
];

function getCharacterRoutePrefixes(): string[] {
  return getAllCharacters().map(c => `/${c.id}/`);
}

const OWNER_ONLY_PATHS = [...STATIC_OWNER_ONLY_PATHS];

/**
 * Verify per-character interlink auth (findings.md P1:2289).
 *
 * On success returns the authenticated character id (from `X-Interlink-From`,
 * whose derived bearer token was verified). On failure writes the error
 * response and returns null — callers should `if (!fromId) return;`.
 *
 * Callers MUST treat the returned `fromId` as the source of truth for
 * identity and reject any body-asserted identity field that disagrees via
 * `assertBodyIdentity`.
 */
function verifyInterlinkAuth(
  req: import('node:http').IncomingMessage,
  res: ServerResponse
): string | null {
  const result = verifyInterlinkRequest(req);
  if (!result.ok) {
    res.writeHead(result.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: result.error }));
    return null;
  }
  return result.fromId;
}

function rejectBodyIdentityMismatch(res: ServerResponse, reason: string): void {
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Body identity mismatch', detail: reason }));
}

// --- Navigation bar injection ---

const NAV_LINKS_PUBLIC: Array<{ label: string; href: string }> = [
  { label: 'MAP', href: '/commune-map.html' },
  { label: 'WALK', href: '/game/' },
  { label: 'NEWS', href: '/commune-newspaper.html' },
  { label: 'PAPER', href: '/newspaper.html' },
];

function getOwnerNavLinks(): Array<{ label: string; href: string }> {
  const characterLinks = getAllCharacters()
    .filter((character) => character.server !== 'web')
    .map((character) => ({
      label: character.name.toUpperCase(),
      href: `/${character.id}/`,
    }));

  return [
    { label: 'POST', href: '/postboard.html' },
    { label: 'EVENTS', href: '/town-events.html' },
    { label: 'DREAMS', href: '/dreams.html' },
    { label: 'DASH', href: '/dashboard.html' },
    ...characterLinks,
  ];
}

function generateNavBar(pathname: string, ownerMode = false): string {
  const exitLink = { label: 'EXIT', href: 'https://shraii.com' };
  const NAV_LINKS = ownerMode ? [...NAV_LINKS_PUBLIC, ...getOwnerNavLinks(), exitLink] : [...NAV_LINKS_PUBLIC, exitLink];
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
  }).join(' ');

  return `<div id="laintown-nav"${isGamePage ? ' class="ltn-game"' : ''}><span class="ltn-title">NEWTOWN</span> ${links}</div>`;
}

function addClassToBodyTag(bodyTag: string, className: string): string {
  const classAttr = bodyTag.match(/\sclass=(["'])(.*?)\1/i);
  if (!classAttr || classAttr.index === undefined) {
    return bodyTag.replace(/>$/, ` class="${className}">`);
  }

  const quote = classAttr[1] ?? '"';
  const current = classAttr[2] ?? '';
  const classes = new Set(current.split(/\s+/).filter(Boolean));
  classes.add(className);
  const nextAttr = ` class=${quote}${Array.from(classes).join(' ')}${quote}`;
  return bodyTag.slice(0, classAttr.index) + nextAttr + bodyTag.slice(classAttr.index + classAttr[0].length);
}

function injectNavAssets(html: string): string {
  if (!html.includes('/laintown-nav.css')) {
    html = html.replace('</head>', '  <link rel="stylesheet" href="/laintown-nav.css">\n</head>');
  }
  if (!html.includes('/laintown-nav.js')) {
    html = html.replace('</head>', '  <script src="/laintown-nav.js" defer></script>\n</head>');
  }
  return html;
}

function injectNavBar(html: string, pathname: string, ownerMode = false): string {
  const nav = generateNavBar(pathname, ownerMode);
  // findings.md P2:2388 — inject the authoritative character-route list BEFORE
  // early-load.js runs so the synchronous skin-path resolver reads from a
  // manifest-derived source rather than the historical hardcoded array.
  const charPaths = JSON.stringify(getCharacterRoutePrefixes().map(p => p.replace(/\/$/, '')));
  if (!html.includes('name="laintown-char-paths"')) {
    html = html.replace(
      '</head>',
      `  <meta name="laintown-char-paths" content='${charPaths}'>\n</head>`
    );
  }
  // Inject telemetry script before </head> (skip on dashboard — it has its own stats)
  if (!pathname.includes('dashboard')) {
    if (!html.includes('/laintown-telemetry.css')) {
      html = html.replace('</head>', '  <link rel="stylesheet" href="/laintown-telemetry.css">\n</head>');
    }
    html = html.replace('</head>', '<script src="/laintown-telemetry.js" defer></script></head>');
  }
  // Strip any existing nav bar (from character server's own injection)
  html = html.replace(/<style>[^<]*#laintown-nav[\s\S]*?<\/style>/g, '');
  html = html.replace(/<div id="laintown-nav">[\s\S]*?<\/div>\s*<script>\(function\(\)\{var k=[\s\S]*?<\/script>/g, '');
  html = html.replace(/<div id="laintown-nav"[\s\S]*?<\/div>\s*/g, '');
  html = injectNavAssets(html);

  // Inject after the opening <body...> tag
  const bodyMatch = html.match(/<body[^>]*>/i);
  if (bodyMatch) {
    const isGamePage = pathname === '/game/' || pathname === '/game/index.html';
    const bodyTag = bodyMatch[0];
    const idx = html.indexOf(bodyTag);
    const classedBody = addClassToBodyTag(bodyTag, isGamePage ? 'ltn-game-nav' : 'ltn-has-nav');
    return html.slice(0, idx) + classedBody + nav + html.slice(idx + bodyTag.length);
  }
  return html;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

async function getDiskStats(): Promise<{ total: string; used: string; available: string; percent: number }> {
  if (process.platform === 'win32') {
    const drive = (process.cwd().slice(0, 2) || 'C:').replace(/'/g, "''");
    const { stdout } = await execAsync(
      `powershell -NoProfile -Command "(Get-CimInstance Win32_LogicalDisk -Filter \\\"DeviceID='${drive}'\\\" | Select-Object Size,FreeSpace | ConvertTo-Json -Compress)"`,
      { timeout: 5000 }
    );
    const parsed = JSON.parse(stdout.trim()) as { Size?: number; FreeSpace?: number };
    const totalBytes = Number(parsed.Size || 0);
    const freeBytes = Number(parsed.FreeSpace || 0);
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    return {
      total: String(totalBytes),
      used: String(usedBytes),
      available: String(freeBytes),
      percent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0,
    };
  }

  const { stdout } = await execAsync('df -k . | tail -1', { timeout: 5000 });
  const parts = stdout.trim().split(/\s+/);
  const totalKb = Number(parts[1] || 0);
  const usedKb = Number(parts[2] || 0);
  const availKb = Number(parts[3] || 0);
  return {
    total: String(totalKb * 1024),
    used: String(usedKb * 1024),
    available: String(availKb * 1024),
    percent: Number.parseInt(parts[4] || '0', 10) || 0,
  };
}

export async function startWebServer(port = 3000): Promise<void> {
  // Initialize database and agent
  const paths = getPaths();
  const config = getDefaultConfig();

  console.log('Initializing database...');
  await initDatabase(paths.database, config.security.keyDerivation);
  purgeLocalOnlyResearchArtifacts();

  // Set character identity for event bus
  const characterId = process.env['LAIN_CHARACTER_ID'] || 'newtown';
  eventBus.setCharacterId(characterId);

  // findings.md P2:171 — web server initializes the single `server: 'web'`
  // character from characters.json, picking up its `providers[]` if declared
  // and falling back to DEFAULT_PROVIDERS otherwise.
  console.log('Initializing agent...');
  const webChar = getWebCharacter();
  if (!webChar) {
    throw new Error(
      'No characters.json entry with server:"web" — web server has no character to serve.',
    );
  }
  await initAgent(getAgentConfigFor(webChar.id));
  if (!isResearchEnabled()) {
    for (const toolName of REMOTE_RESEARCH_TOOLS) {
      unregisterTool(toolName);
    }
    console.log('[Newtown] Local-only mode active: remote research tools disabled');
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
    res.setHeader('Content-Security-Policy', HTML_CSP);

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

    // Character manifest (no auth — public for commune map / game client)
    if (url.pathname === '/api/characters' && req.method === 'GET') {
      const { getAllCharacters, loadManifest } = await import('../config/characters.js');
      const manifest = loadManifest();
      const characters = getAllCharacters().map(c => ({
        id: c.id,
        name: c.name,
        port: c.port,
        defaultLocation: c.defaultLocation,
        possessable: c.possessable === true ? true : undefined,
        // findings.md P2:3216 — expose the web/host character so the game
        // client can resolve an explicit fallback instead of guessing via
        // Object.keys(CHARACTERS)[0], which depends on manifest order.
        web: c.server === 'web' ? true : undefined,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ town: manifest.town, characters }));
      return;
    }

    // Owner gate — authenticate via secret token, get HMAC-signed session cookie.
    //
    // findings.md P2:2466 — tokens in URL query strings leak via browser history,
    // nginx access logs, proxy logs, and the Referer header. Prefer POST /gate
    // with the token in the request body; keep GET /gate for backward-compat with
    // existing bookmarks but add Cache-Control: no-store and Referrer-Policy:
    // no-referrer so downstream requests and the disk cache don't amplify the
    // leak window.
    if (url.pathname === '/gate' && req.method === 'POST') {
      const ownerToken = process.env['LAIN_OWNER_TOKEN'];
      let provided: string | undefined;
      try {
        const raw = await collectBody(req, 4096);
        const ct = (req.headers['content-type'] ?? '').toString().toLowerCase();
        if (ct.includes('application/json')) {
          const parsed = JSON.parse(raw) as { token?: unknown };
          if (typeof parsed.token === 'string') provided = parsed.token;
        } else if (ct.includes('application/x-www-form-urlencoded')) {
          const params = new URLSearchParams(raw);
          provided = params.get('token') ?? undefined;
        } else {
          // Treat raw body as token if no content-type specified (curl convenience).
          provided = raw.trim() || undefined;
        }
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        res.end('Bad Request');
        return;
      }
      const headers = {
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      };
      if (ownerToken && provided && secureCompare(provided, ownerToken)) {
        issueOwnerCookie(res, ownerToken, req);
        res.writeHead(302, { ...headers, 'Location': '/' });
        res.end();
      } else {
        res.writeHead(403, { ...headers, 'Content-Type': 'text/plain' });
        res.end('Forbidden');
      }
      return;
    }

    if (url.pathname === '/gate' && req.method === 'GET') {
      const ownerToken = process.env['LAIN_OWNER_TOKEN'];
      const provided = url.searchParams.get('token');
      const headers = {
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      };
      if (ownerToken && provided && secureCompare(provided, ownerToken)) {
        issueOwnerCookie(res, ownerToken, req);
        res.writeHead(302, { ...headers, 'Location': '/' });
        res.end();
      } else {
        res.writeHead(403, { ...headers, 'Content-Type': 'text/plain' });
        res.end('Forbidden');
      }
      return;
    }

    // findings.md P2:2348 — owner logout (revoke THIS device's nonce + clear cookie).
    // Works on any character server; WL revokes locally, mortals proxy through
    // the interlink endpoint. Cookie clearing is always local (cookies are
    // domain-scoped so this is the only server that can drop its own).
    if (url.pathname === '/owner/logout' && req.method === 'POST') {
      if (!isOwner(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not authenticated' }));
        return;
      }
      const nonce = getOwnerNonce(req);
      if (nonce) {
        try {
          await revokeNonceOnAuthority(nonce);
        } catch (err) {
          // WL unreachable — still clear the local cookie so the user is
          // logged out from this browser. The nonce will remain revocable
          // as soon as WL is back; legitimate sessions see no impact.
          console.error('owner logout: authority revoke failed (cookie still cleared):', err);
        }
      }
      clearOwnerCookie(res, req);
      res.writeHead(204);
      res.end();
      return;
    }

    // findings.md P2:2348 — "log me out of every device." Revokes every
    // non-revoked nonce on the authority, clears this device's cookie too.
    if (url.pathname === '/owner/logout-all' && req.method === 'POST') {
      if (!isOwner(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not authenticated' }));
        return;
      }
      let count = 0;
      try {
        count = await revokeAllOnAuthority();
      } catch (err) {
        console.error('owner logout-all: authority revoke-all failed:', err);
        clearOwnerCookie(res, req);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Authority unreachable; local cookie cleared' }));
        return;
      }
      clearOwnerCookie(res, req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ revoked: count }));
      return;
    }

    // Block non-owners from restricted pages
    if (!isOwner(req)) {
      const isOwnerOnly = OWNER_ONLY_PATHS.some(p => url.pathname === p || url.pathname.startsWith(p));
      const isRootChat = (url.pathname === '/' || url.pathname === '/index.html') && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/skins/');
      if (isOwnerOnly || isRootChat) {
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
        const charId = process.env['LAIN_CHARACTER_ID'] || 'lain';
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
        const charId = process.env['LAIN_CHARACTER_ID'] || 'lain';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ characterId: charId, summary: getStateSummary(), state: getCurrentState() }));
      } catch {
        const charId = process.env['LAIN_CHARACTER_ID'] || 'lain';
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
      const charId = process.env['LAIN_CHARACTER_ID'] || 'lain';
      // findings.md P2:2271 — fail-closed; identity endpoint must never
      // silently return "Lain" for a mis-configured non-Lain character.
      const charName = requireCharacterName();
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
        const charPorts: Record<string, number> = Object.fromEntries(
          getAllCharacters().map((character) => [character.id, character.port])
        );
        const charIds = Object.keys(charPorts);

        // Fetch conversation histories from all characters
        interface ConvRecord { peerId: string; timestamp: number; rounds: number }
        const allRecords: Array<{ fromId: string; record: ConvRecord }> = [];

        const fetches = charIds.map(async (charId) => {
          try {
            let records: ConvRecord[];
            if (charId === (process.env['LAIN_CHARACTER_ID'] || webChar.id)) {
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
      const charId = process.env['LAIN_CHARACTER_ID'] || 'lain';
      // findings.md P2:2271 — fail-closed; integrity report must never
      // silently claim the character is "Lain" when the env is unset.
      const charName = requireCharacterName();
      const basePath = getBasePath();
      const dbPath = join(basePath, 'lain.db');
      const journalPath = join(basePath, '.private_journal', 'thoughts.json');
      const selfConceptPath = join(basePath, '.private_journal', 'self-concept.md');
      const lainHome = process.env['LAIN_HOME'] || '(not set — using default)';

      const checks: Array<{ check: string; ok: boolean; detail: string }> = [];

      // 1. LAIN_HOME is set (every character except default Lain should have this)
      checks.push({
        check: 'LAIN_HOME',
        ok: !!process.env['LAIN_HOME'] || charId === 'lain',
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
      const charId = process.env['LAIN_CHARACTER_ID'] || 'lain';
      // findings.md P2:2271 — fail-closed; telemetry must not lie about
      // whose data it's reporting.
      const charName = requireCharacterName();
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
            content: m.content,
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
        chatPrefixes: ['web', 'newtown'],
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(entries));
      return;
    }

    // findings.md P2:2376 — building notes and documents leak introspective
    // LLM-generated content. Previously "public for character discovery"; now
    // gated by interlink auth so only authenticated peer processes — not the
    // open web — can enumerate them. Owners also allowed.
    if (url.pathname === '/api/building/notes' && req.method === 'GET') {
      if (!isOwner(req)) { if (!verifyInterlinkAuth(req, res)) return; }
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

    if (url.pathname === '/api/documents' && req.method === 'GET') {
      if (!isOwner(req)) { if (!verifyInterlinkAuth(req, res)) return; }
      const characterId = process.env['LAIN_CHARACTER_ID'] || 'lain';
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

    // GET /api/town-events — read active events. Requires owner or interlink
    // auth: the effects endpoint below can drive forceLocation, which a
    // character consumer applies to its own movement, so we don't want the
    // feed to be world-readable or world-pollutable-looking-authoritative.
    if (url.pathname === '/api/town-events' && req.method === 'GET') {
      if (!isOwner(req) && !verifyInterlinkAuth(req, res)) return;
      const all = url.searchParams.get('all') === '1';
      const events = all ? getAllTownEvents(50) : getActiveTownEvents();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(events));
      return;
    }

    // GET /api/town-events/effects — merged mechanical effects (forceLocation,
    // weather, etc). Drives character behaviour on the consumer side, so the
    // same auth bar as the events list applies.
    if (url.pathname === '/api/town-events/effects' && req.method === 'GET') {
      if (!isOwner(req) && !verifyInterlinkAuth(req, res)) return;
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

    // Character definitions for dream aggregation — from the manifest
    const DREAM_PEERS = getHealthCheckTargets();

    function fetchPeerJson<T>(port: number, path: string): Promise<T | null> {
      const headers = getInterlinkHeaders();
      if (!headers) return Promise.resolve(null);
      return new Promise((resolve) => {
        const req = httpRequest(
          { hostname: '127.0.0.1', port, path, method: 'GET', headers, timeout: 5000 },
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
          // Wired Lain queries its own DB directly
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

      const characters = getMortalCharacters().map(char => {
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
      const fromId = verifyInterlinkAuth(req, res);
      if (!fromId) return;
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
        const speakerCheck = assertBodyIdentity(fromId, event.speakerId);
        if (!speakerCheck.ok) {
          rejectBodyIdentityMismatch(res, speakerCheck.reason);
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
      // building events are low-stakes shared memory; no identity field in
      // the body to bind to. Any authenticated character may post events for
      // any building they claim to be in.
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
      expireStaleObjects();
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
      expireStaleObjects();
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
      const fromId = verifyInterlinkAuth(req, res);
      if (!fromId) return;
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
        const creatorCheck = assertBodyIdentity(fromId, creatorId);
        if (!creatorCheck.ok) {
          rejectBodyIdentityMismatch(res, creatorCheck.reason);
          return;
        }
        // findings.md P2:1188 — sanitize() now clears .sanitized to '' on
        // block paths, but we still must check .blocked and refuse with a
        // 400 rather than silently storing empty strings as the object's
        // name/description.
        const nameCheck = sanitize(name);
        const descCheck = sanitize(description);
        if (nameCheck.blocked || descCheck.blocked) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'Object name or description blocked by input sanitizer',
            reason: nameCheck.reason ?? descCheck.reason,
          }));
          return;
        }
        const obj = createObject(
          nameCheck.sanitized.slice(0, 100),
          descCheck.sanitized.slice(0, 500),
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
      const fromId = verifyInterlinkAuth(req, res);
      if (!fromId) return;
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
        const charCheck = assertBodyIdentity(fromId, characterId);
        if (!charCheck.ok) {
          rejectBodyIdentityMismatch(res, charCheck.reason);
          return;
        }
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
      const fromId = verifyInterlinkAuth(req, res);
      if (!fromId) return;
      try {
        const id = url.pathname.split('/')[3]!;
        const body = await collectBody(req);
        const { characterId, location } = JSON.parse(body) as { characterId: string; location: string };
        const charCheck = assertBodyIdentity(fromId, characterId);
        if (!charCheck.ok) {
          rejectBodyIdentityMismatch(res, charCheck.reason);
          return;
        }
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
      const authFromId = verifyInterlinkAuth(req, res);
      if (!authFromId) return;
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
        const fromCheck = assertBodyIdentity(authFromId, fromId);
        if (!fromCheck.ok) {
          rejectBodyIdentityMismatch(res, fromCheck.reason);
          return;
        }
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
      const fromId = verifyInterlinkAuth(req, res);
      if (!fromId) return;
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
        const charCheck = assertBodyIdentity(fromId, characterId);
        if (!charCheck.ok) {
          rejectBodyIdentityMismatch(res, charCheck.reason);
          return;
        }
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
      const clientIp = getClientIp(req);
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
      const clientIp = getClientIp(req);
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
      const authFromId = verifyInterlinkAuth(req, res);
      if (!authFromId) return;
      try {
        const body = await collectBody(req);
        const { fromId, fromName, message, possessed } = JSON.parse(body) as {
          fromId: string;
          fromName: string;
          message: string;
          timestamp?: number;
          possessed?: boolean;
        };

        if (!fromId || !fromName || !message) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing required fields: fromId, fromName, message' }));
          return;
        }
        const fromCheck = assertBodyIdentity(authFromId, fromId);
        if (!fromCheck.ok) {
          rejectBodyIdentityMismatch(res, fromCheck.reason);
          return;
        }

        const sessionId = `peer:${fromId}:${Date.now()}`;
        // findings.md P2:2942 — owner typing via /api/possession/say on a
        // possessable character advertises `possessed: true`. Prefix the
        // content so downstream context is unambiguous and tag metadata
        // so store.ts persists the flag (src/memory/store.ts:148).
        const contentText = possessed
          ? `(possession: owner-authored) ${message}`
          : message;
        const incomingMsg: IncomingMessage = {
          id: nanoid(16),
          // findings.md P2:215 — direct inter-character traffic over the
          // interlink is a distinct channel from web-user chat.
          channel: 'peer',
          peerKind: 'user',
          peerId: sessionId,
          senderId: fromName,
          content: { type: 'text', text: contentText } satisfies TextContent,
          timestamp: Date.now(),
          ...(possessed ? { metadata: { peerPossessed: true } } : {}),
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

    // findings.md P2:2348 — owner-nonce authority endpoints. Only served by
    // Wired Lain (other servers don't own the table); interlink auth gates
    // cross-server access the same way interlink letters/research-requests
    // are gated. Routes:
    //   GET    /api/interlink/owner-nonce/:nonce  -> { revoked: boolean } | 404
    //   DELETE /api/interlink/owner-nonce/:nonce  -> 204 (revoke single)
    //   DELETE /api/interlink/owner-nonces        -> { count } (revoke all)
    if (url.pathname.startsWith('/api/interlink/owner-nonce')) {
      if (process.env['LAIN_CHARACTER_ID'] !== 'wired-lain') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'owner-nonce authority is on Wired Lain only' }));
        return;
      }
      if (!verifyInterlinkAuth(req, res)) return;

      if (url.pathname === '/api/interlink/owner-nonces' && req.method === 'DELETE') {
        const count = revokeAllNonces();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ count }));
        return;
      }

      // Per-nonce: /api/interlink/owner-nonce/<urlencoded-nonce>
      const prefix = '/api/interlink/owner-nonce/';
      if (url.pathname.startsWith(prefix)) {
        const nonce = decodeURIComponent(url.pathname.slice(prefix.length));
        if (!nonce) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing nonce' }));
          return;
        }
        if (req.method === 'GET') {
          // localIsRevoked returns true for unknown (treat-as-revoked), but
          // callers want to distinguish unknown (forged or purged) from
          // known-revoked. We probe the DB directly for an authoritative
          // yes/no/404.
          const db = getDatabase();
          const row = db.prepare('SELECT revoked_at FROM owner_nonces WHERE nonce = ?').get(nonce) as
            | { revoked_at: number | null }
            | undefined;
          if (!row) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'unknown nonce' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ revoked: row.revoked_at !== null }));
          return;
        }
        if (req.method === 'DELETE') {
          revokeNonce(nonce);
          res.writeHead(204);
          res.end();
          return;
        }
      }

      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    if (url.pathname === '/api/interlink/letter' && req.method === 'POST') {
      try {
        const senderId = verifyInterlinkAuth(req, res);
        if (!senderId) return;
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

        // Attribute the letter to the authenticated sender. The manifest
        // supplies the display name; fall back to the id if unregistered
        // (shouldn't happen in practice, but we don't want to crash here).
        const { getCharacterEntry } = await import('../config/characters.js');
        const senderEntry = getCharacterEntry(senderId);
        const sisterName = senderEntry?.name ?? senderId;
        const sisterId = senderId;
        const sessionPrefix = `${senderId}:letter`;

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
          // findings.md P2:215 — letter-as-chat delivery is peer-origin,
          // not user-origin; labelling it `'peer'` keeps analytics clean.
          channel: 'peer',
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
      if (!isResearchEnabled()) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      // Only Wired Lain handles research requests
      if (characterId !== 'wired-lain') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      try {
        const authFromId = verifyInterlinkAuth(req, res);
        if (!authFromId) return;
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
        const requesterCheck = assertBodyIdentity(authFromId, characterId);
        if (!requesterCheck.ok) {
          rejectBodyIdentityMismatch(res, requesterCheck.reason);
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
        const disk = await getDiskStats();
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = Math.max(0, totalMem - freeMem);
        const ram = {
          total: String(totalMem),
          used: String(usedMem),
          free: String(freeMem),
          percent: totalMem > 0 ? Math.round((usedMem / totalMem) * 100) : 0,
        };
        const swap = {
          total: '0',
          used: '0',
          free: '0',
          percent: 0,
        };
        if (process.platform !== 'win32') {
          try {
            const freeResult = await execAsync('free -b | grep -E "^Swap"', { timeout: 5000 });
            const swapParts = freeResult.stdout.trim().split(/\s+/);
            const swapTotal = Number(swapParts[1] || 0);
            const swapUsed = Number(swapParts[2] || 0);
            const swapFree = Number(swapParts[3] || 0);
            swap.total = String(swapTotal);
            swap.used = String(swapUsed);
            swap.free = String(swapFree);
            swap.percent = swapTotal > 0 ? Math.round((swapUsed / swapTotal) * 100) : 0;
          } catch {
            // Swap is optional; keep zeroed values.
          }
        }
        const load = os.loadavg().map(v => Number(v.toFixed(2)));
        const uptime = formatUptime(os.uptime());

        // Service status for non-HTTP services
        let telegramActive = false;
        let gatewayActive = false;
        if (process.platform !== 'win32') {
          try { await execAsync('systemctl is-active lain-telegram', { timeout: 3000 }); telegramActive = true; } catch { /* inactive */ }
          try { await execAsync('systemctl is-active lain-gateway', { timeout: 3000 }); gatewayActive = true; } catch { /* inactive */ }
        }

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
    // findings.md P2:2388 — derive from manifest so a rename only needs to land in
    // characters.json.
    const CHARACTER_PORTS: Record<string, number> = Object.fromEntries(
      getAllCharacters().map(c => [`/${c.id}/`, c.port])
    );
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

  // findings.md P2:285 — shared scheduler so every town_events writer
  // (web + character servers) runs the same expiry cadence.
  startExpireStaleEventsLoop();

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
    const stopFns: Array<() => void> = [];

    // Both sisters get these loops
    stopFns.push(startStateDecayLoop());
    stopFns.push(startDiaryLoop());
    stopFns.push(startSelfConceptLoop());
    stopFns.push(startNarrativeLoop());
    stopFns.push(startMemoryMaintenanceLoop());
    // findings.md P2:1473 — schedule a periodic prune of expired
    // building_events instead of running a DELETE on every residue
    // read. Harmless on character DBs where the table stays empty;
    // does real work on Wired Lain where events accumulate.
    stopFns.push(startBuildingMemoryPruneLoop(getDatabase()));
    stopFns.push(startDreamLoop());
    if (characterId === 'newtown') {
      stopFns.push(startNewspaperPublishingLoop(
        getDefaultNewtownNewspaperConfig(NEWSPAPERS_DIR)
      ));
    }
    stopFns.push(startLetterLoop());
    stopFns.push(startDoctorLoop());
    stopFns.push(startDesireLoop());

      if (isResearchEnabled()) {
        stopFns.push(startCuriosityLoop());
      }

    if (isWired) {
      // Wired Lain owns the canonical object registry; prune loose ground
      // objects on a cadence so WALK does not accumulate forever.
      stopFns.push(startObjectExpiryLoop());

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
    } else {
      // findings.md P2:1505 — non-WL characters warm a local cache of
      // WL's /api/weather so internal-state.ts and agent prompts can
      // consume the town's authoritative weather.
      stopFns.push(startTownWeatherRefreshLoop());

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
// Delegates to src/utils/web-search.ts (DDG HTML → DDG Lite → Wikipedia).

async function webSearch(question: string): Promise<string> {
  const { searchWeb } = await import('../utils/web-search.js');
  const results = await searchWeb(question);
  if (results.length === 0) return `No search results found for "${question}"`;
  return results.map((r) => `${r.title}\n${r.snippet}\n${r.url}`).join('\n\n');
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
  const headers = getInterlinkHeaders();
  if (!headers) {
    console.error('[Research] Cannot deliver response: interlink not configured');
    return;
  }

  // Include senderId so the recipient attributes the letter correctly.
  // It must match the authenticated X-Interlink-From (this process's
  // LAIN_CHARACTER_ID) — the recipient rejects mismatches.
  const senderId = process.env['LAIN_CHARACTER_ID']!;
  const letter: WiredLetter & { senderId?: string } = {
    topics: [question],
    impressions: [responseContent],
    gift: researchContent,
    emotionalState: 'curious',
    senderId,
  };

  // SSRF guard: `replyTo` comes from an interlink-authenticated caller, so
  // treat it as attacker-controllable. Only allow http://loopback on a known
  // character-manifest port — the only legitimate shape of a peer URL in
  // this deployment.
  const allowedPorts = getAllCharacters().map(c => c.port);
  if (!isAllowedReplyTo(replyTo, allowedPorts)) {
    console.error(`[Research] Refusing delivery to disallowed replyTo: ${replyTo}`);
    return;
  }

  try {
    const deliveryResponse = await fetch(`${replyTo}/api/interlink/letter`, {
      method: 'POST',
      headers,
      body: JSON.stringify(letter),
      signal: AbortSignal.timeout(15000),
    });

    if (deliveryResponse.ok) {
      console.log(`[Research] Response delivered to ${characterName} at ${replyTo}`);
      // Record: delivered
      await saveMemory({
        sessionKey: `research:delivered:${requestId}`,
        userId: null,
        content: `sent research findings to ${characterName} about "${question}": ${responseContent}`,
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
