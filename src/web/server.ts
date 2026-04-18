import 'dotenv/config';
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, RequestOptions, ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';
import { initAgent, processMessage, processMessageStream } from '../agent/index.js';
import { getActivity } from '../memory/store.js';
import { BUILDINGS } from '../commune/buildings.js';
import { secureCompare } from '../utils/crypto.js';
import { initDatabase } from '../storage/database.js';
import { getPaths } from '../config/index.js';
import { getDefaultConfig } from '../config/defaults.js';
import type { ImageContent, TextContent } from '../types/message.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', '..', 'src', 'web', 'public');
const CORS_ORIGIN = process.env['LAIN_CORS_ORIGIN'] || '*';
const MAX_BODY_BYTES = 1_048_576;

const RESIDENTS = [
  { id: 'neo', name: 'Neo', path: '/neo', port: 3003 },
  { id: 'plato', name: 'Plato', path: '/plato', port: 3004 },
  { id: 'joe', name: 'Joe', path: '/joe', port: 3005 },
] as const;

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
  image?: {
    base64: string;
    mimeType: string;
  };
}

function collectBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
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

function verifyApiAuth(req: IncomingMessage, res: ServerResponse): boolean {
  const apiKey = process.env['LAIN_WEB_API_KEY'];
  if (!apiKey) return true;

  const authHeader = req.headers['authorization'];
  if (authHeader?.startsWith('Bearer ')) {
    const provided = authHeader.slice('Bearer '.length);
    if (secureCompare(provided, apiKey)) return true;
  }

  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const keyParam = url.searchParams.get('key');
    if (keyParam && secureCompare(keyParam, apiKey)) return true;
  } catch {
    // Ignore URL parse failure.
  }

  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unauthorized' }));
  return false;
}

function buildIncomingMessage(request: ChatRequest, sessionId: string) {
  const content: TextContent | ImageContent = request.image
    ? {
        type: 'image',
        base64: request.image.base64,
        mimeType: request.image.mimeType,
        ...(request.message ? { caption: request.message } : {}),
      }
    : { type: 'text', text: request.message } satisfies TextContent;

  return {
    id: nanoid(16),
    channel: 'web' as const,
    peerKind: 'user' as const,
    peerId: sessionId,
    senderId: 'web-user',
    content,
    timestamp: Date.now(),
  };
}

async function handleChat(body: string) {
  const request = JSON.parse(body) as ChatRequest;
  const sessionId = request.sessionId || `web:${nanoid(8)}`;
  const incomingMessage = buildIncomingMessage(request, sessionId);

  const agentResponse = await processMessage({
    sessionKey: sessionId,
    message: incomingMessage,
  });

  const textResponse = agentResponse.messages
    .filter((message) => message.content.type === 'text')
    .map((message) => (message.content as TextContent).text)
    .join('\n');

  return {
    response: textResponse,
    sessionId,
  };
}

async function handleChatStream(body: string, res: ServerResponse): Promise<void> {
  const request = JSON.parse(body) as ChatRequest;
  const sessionId = request.sessionId || `web:${nanoid(8)}`;
  const incomingMessage = buildIncomingMessage(request, sessionId);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': CORS_ORIGIN,
  });

  res.write(`data: ${JSON.stringify({ type: 'session', sessionId })}\n\n`);

  await processMessageStream(
    { sessionKey: sessionId, message: incomingMessage },
    (chunk: string) => {
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: chunk })}\n\n`);
    }
  );

  res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
  res.end();
}

async function serveStatic(pathname: string): Promise<{ content: Buffer; type: string } | null> {
  try {
    const safePath = pathname.replace(/^\/+/, '') || 'index.html';
    let filePath = resolve(PUBLIC_DIR, safePath);
    if (!filePath.startsWith(resolve(PUBLIC_DIR))) return null;

    try {
      const fileStat = await stat(filePath);
      if (fileStat.isDirectory()) {
        filePath = resolve(filePath, 'index.html');
      }
    } catch {
      // Ignore missing stat.
    }

    const content = await readFile(filePath);
    return {
      content,
      type: MIME_TYPES[extname(filePath)] || 'application/octet-stream',
    };
  } catch {
    return null;
  }
}

async function fetchResidentState(resident: typeof RESIDENTS[number]) {
  try {
    const response = await fetch(`http://127.0.0.1:${resident.port}/api/location`, {
      signal: AbortSignal.timeout(1500),
    });

    if (!response.ok) {
      return { ...resident, online: false, location: null };
    }

    const data = await response.json() as { location: string; buildingName?: string };
    return {
      ...resident,
      online: true,
      location: data.location,
      buildingName: data.buildingName || data.location,
    };
  } catch {
    return { ...resident, online: false, location: null };
  }
}

async function proxyResidentRequest(
  req: IncomingMessage,
  res: ServerResponse,
  resident: typeof RESIDENTS[number],
  remainderPath: string,
  publicPathname: string
): Promise<void> {
  const targetPath = remainderPath || '/';
  const targetUrl = new URL(`http://127.0.0.1:${resident.port}${targetPath}`);

  const options: RequestOptions = {
    hostname: '127.0.0.1',
    port: resident.port,
    path: `${targetUrl.pathname}${targetUrl.search}`,
    method: req.method,
    headers: {
      ...req.headers,
      host: `127.0.0.1:${resident.port}`,
    },
  };

  await new Promise<void>((resolvePromise) => {
    const proxy = httpRequest(options, (proxyRes) => {
      const contentType = String(proxyRes.headers['content-type'] || '');
      if (contentType.includes('text/html')) {
        const chunks: Buffer[] = [];
        proxyRes.on('data', (chunk: Buffer) => chunks.push(chunk));
        proxyRes.on('end', () => {
          let html = Buffer.concat(chunks).toString();
          html = injectNavBar(html, publicPathname);
          const headers = { ...proxyRes.headers };
          delete headers['content-length'];
          res.writeHead(proxyRes.statusCode || 200, headers);
          res.end(html);
          resolvePromise();
        });
        return;
      }

      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
      proxyRes.on('end', () => resolvePromise());
    });

    proxy.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `${resident.name} is unavailable` }));
      }
      resolvePromise();
    });

    req.pipe(proxy);
  });
}

const NAV_LINKS: Array<{ label: string; href: string }> = [
  { label: 'MAP', href: '/commune-map.html' },
  { label: 'NETWORK', href: '/commune-map.html#network' },
  { label: 'WALK', href: '/game/' },
  { label: 'NEWS', href: '/commune-newspaper.html' },
  { label: 'NEO', href: '/neo/' },
  { label: 'PLATO', href: '/plato/' },
  { label: 'JOE', href: '/joe/' },
];

function injectHeadTags(html: string): string {
  const injected: string[] = [];
  const apiKey = process.env['LAIN_WEB_API_KEY'];

  if (apiKey && !html.includes('meta name="lain-api-key"')) {
    injected.push(`  <meta name="lain-api-key" content="${apiKey}">`);
  }
  if (!html.includes('/laintown-telemetry.js')) {
    injected.push('  <script src="/laintown-telemetry.js" defer></script>');
  }

  if (injected.length === 0) return html;
  return html.replace('</head>', `${injected.join('\n')}\n</head>`);
}

function generateNavBar(pathname: string): string {
  const isGamePage = pathname === '/game/' || pathname === '/game/index.html';

  const links = NAV_LINKS.map(({ label, href }) => {
    let active = false;
    if (href === '/commune-map.html#network') {
      active = false;
    } else if (href === '/commune-map.html') {
      active = pathname === '/commune-map.html';
    } else {
      active = pathname.startsWith(href);
    }

    return `<a href="${href}"${active ? ' class="ltn-active"' : ''}>${label}</a>`;
  }).join('');

  return `<style>
#laintown-nav{position:fixed;top:0;left:0;right:0;height:32px;background:#0a0a0f;border-bottom:1px solid #1a1a2e;display:flex;align-items:center;z-index:99999;font-family:'Share Tech Mono',monospace;padding:0 12px;gap:0}
#laintown-nav .ltn-title{color:#4a9eff;font-size:11px;letter-spacing:2px;text-transform:uppercase;margin-right:16px;text-decoration:none}
#laintown-nav a{color:#556;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;text-decoration:none;padding:0 10px;line-height:32px;transition:color .2s}
#laintown-nav a:hover{color:#8ab4f8}
#laintown-nav a.ltn-active{color:#4a9eff}
</style>
<style>${isGamePage ? 'body{padding-top:0!important}#laintown-nav{background:rgba(10,10,15,0.6);border-bottom-color:rgba(26,26,46,0.4)}' : 'body{padding-top:32px!important}'}</style>
<div id="laintown-nav"><a class="ltn-title" href="/">NEWTOWN</a>${links}</div>
<script>(function(){var k=new URLSearchParams(location.search).get('key');if(k){var as=document.querySelectorAll('#laintown-nav a');for(var i=0;i<as.length;i++){var a=as[i],h=a.getAttribute('href');if(h){var hi=h.indexOf('#'),base=hi>-1?h.slice(0,hi):h,frag=hi>-1?h.slice(hi):'';if(base.indexOf('?')===-1){a.setAttribute('href',base+'?key='+encodeURIComponent(k)+frag)}else{a.setAttribute('href',base+'&key='+encodeURIComponent(k)+frag)}}}}})();</script>`;
}

function injectNavBar(html: string, pathname: string): string {
  html = injectHeadTags(html);

  const nav = generateNavBar(pathname);
  const bodyMatch = html.match(/<body[^>]*>/i);
  if (!bodyMatch) return html;

  const idx = html.indexOf(bodyMatch[0]) + bodyMatch[0].length;
  return html.slice(0, idx) + nav + html.slice(idx);
}

export async function startWebServer(port = 3000): Promise<void> {
  const paths = getPaths();
  const config = getDefaultConfig();

  console.log('Initializing database...');
  await initDatabase(paths.database, config.security.keyDerivation);

  console.log('Initializing guide agent...');
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

    res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'"
    );

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const resident = RESIDENTS.find(({ path }) => url.pathname === path || url.pathname.startsWith(`${path}/`));
    if (resident) {
      const remainderPath = url.pathname.slice(resident.path.length) || '/';
      await proxyResidentRequest(req, res, resident, `${remainderPath}${url.search}`, url.pathname);
      return;
    }

    if ((url.pathname === '/dashboard' || url.pathname === '/dashboard/') && req.method === 'GET') {
      res.writeHead(302, { Location: '/game/' });
      res.end();
      return;
    }

    if (url.pathname === '/api/meta/identity' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'newtown', name: 'Newtown' }));
      return;
    }

    if (url.pathname === '/api/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        mode: 'newtown',
        uptime: process.uptime(),
        timestamp: Date.now(),
      }));
      return;
    }

    if (url.pathname === '/api/town/buildings' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(BUILDINGS));
      return;
    }

    if (url.pathname === '/api/town/residents' && req.method === 'GET') {
      const residents = await Promise.all(RESIDENTS.map(fetchResidentState));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(residents));
      return;
    }

    if (url.pathname === '/api/activity' && req.method === 'GET') {
      if (!verifyApiAuth(req, res)) return;
      const now = Date.now();
      const from = Number(url.searchParams.get('from') || now - 7 * 24 * 60 * 60 * 1000);
      const to = Number(url.searchParams.get('to') || now);
      const entries = getActivity(from, to);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(entries));
      return;
    }

    if (url.pathname === '/api/chat' && req.method === 'POST') {
      if (!verifyApiAuth(req, res)) return;
      try {
        const body = await collectBody(req);
        const response = await handleChat(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch (error) {
        const statusCode = error instanceof Error && error.message === 'PAYLOAD_TOO_LARGE' ? 413 : 500;
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: statusCode === 413 ? 'Payload too large' : 'Failed to process message' }));
      }
      return;
    }

    if (url.pathname === '/api/chat/stream' && req.method === 'POST') {
      if (!verifyApiAuth(req, res)) return;
      try {
        const body = await collectBody(req);
        await handleChatStream(body, res);
      } catch (error) {
        const statusCode = error instanceof Error && error.message === 'PAYLOAD_TOO_LARGE' ? 413 : 500;
        if (!res.headersSent) {
          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: statusCode === 413 ? 'Payload too large' : 'Failed to process message' }));
        }
      }
      return;
    }

    const file = await serveStatic(url.pathname);
    if (file) {
      if (file.type === 'text/html') {
        const html = injectNavBar(file.content.toString(), url.pathname);
        res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
        res.end(html);
        return;
      }

      res.writeHead(200, { 'Content-Type': file.type, 'Cache-Control': 'no-cache' });
      res.end(file.content);
      return;
    }

    const index = await serveStatic('index.html');
    if (!index) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const html = injectNavBar(index.content.toString(), url.pathname);
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
    res.end(html);
  });

  server.listen(port, () => {
    console.log(`Newtown is running at http://localhost:${port}`);
  });

  const shutdown = () => {
    console.log('\nShutting down...');
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1]?.includes('web/server')) {
  const port = parseInt(process.env['PORT'] || '3000', 10);
  startWebServer(port).catch(console.error);
}
