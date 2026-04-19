/**
 * Character Server — Generic server template for Wired commune members
 *
 * Each character runs as its own Node.js process with LAIN_HOME isolation.
 * Uses the full agent runtime (memory, extraction, self-concept, conversation
 * compression) but with GPT-4o-mini and no web access.
 *
 * If config.possessable is true, adds possession endpoints that let
 * a player take over the character — stopping background loops, intercepting
 * peer messages, and providing a control API.
 */

import 'dotenv/config';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';
import {
  initAgent,
  processMessage,
  processMessageStream,
  unregisterTool,
} from '../agent/index.js';
import { registerCharacterTools, type PeerConfig } from '../agent/character-tools.js';
import { startOfflineCuriosityLoop } from '../agent/curiosity-offline.js';
import { startCommuneLoop } from '../agent/commune-loop.js';
import { startTownLifeLoop } from '../agent/town-life.js';
import { startStateDecayLoop } from '../agent/internal-state.js';
import { startDiaryLoop } from '../agent/diary.js';
import { startSelfConceptLoop } from '../agent/self-concept.js';
import { startDreamLoop } from '../agent/dreams.js';
import { startNarrativeLoop } from '../agent/narratives.js';
import { startNewspaperLoop } from '../agent/newspaper.js';
import { startMemoryMaintenanceLoop } from '../memory/organic.js';
import { startDesireLoop } from '../agent/desires.js';
import { paraphraseLetter, type WiredLetter } from '../agent/membrane.js';
import { saveMemory, getActivity, getNotesByBuilding, getDocumentsByAuthor, getPostboardMessages, countMemories, countMessages } from '../memory/store.js';
import { eventBus, isBackgroundEvent, type SystemEvent } from '../events/bus.js';
import { sanitize } from '../security/sanitizer.js';
import { secureCompare } from '../utils/crypto.js';
import { isOwner } from './owner-auth.js';
import { initDatabase, getMeta, query } from '../storage/database.js';
import { getPaths } from '../config/index.js';
import { getBasePath } from '../config/paths.js';
import { getDefaultConfig } from '../config/defaults.js';
import {
  isPossessed,
  getPossessionState,
  startPossession,
  endPossession,
  touchActivity,
  addPendingPeerMessage,
  getPendingPeerMessages,
  resolvePendingMessage,
  verifyPossessionAuth,
  addSSEClient,
  removeSSEClient,
  broadcastMovement,
  getActiveLoopStops,
} from '../agent/possession.js';
import type { IncomingMessage, TextContent } from '../types/message.js';
import type { AgentConfig } from '../types/config.js';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SKINS_DIR = join(__dirname, '..', '..', 'src', 'web', 'skins');

const TOOLS_TO_REMOVE = [
  'web_search', 'fetch_webpage',
  'create_tool', 'list_my_tools', 'delete_tool',
  'introspect_list', 'introspect_read', 'introspect_search', 'introspect_info',
  'show_image', 'search_images', 'fetch_and_show_image', 'view_image',
  'send_message', 'telegram_call', 'send_letter',
];

export interface CharacterConfig {
  id: string;
  name: string;
  port: number;
  publicDir: string;
  peers: PeerConfig[];
  possessable?: boolean;
}

interface BackgroundLoops {
  stops: (() => void)[];
  restarters: (() => (() => void))[];
}

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

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
  if (!secureCompare(authHeader.slice('Bearer '.length), token)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid token' }));
    return false;
  }
  return true;
}

async function serveStatic(
  publicDir: string,
  path: string
): Promise<{ content: Buffer; type: string } | null> {
  try {
    const safePath = path.replace(/\.\./g, '').replace(/^\/+/, '');
    const filePath = join(publicDir, safePath || 'index.html');
    const content = await readFile(filePath);
    const ext = extname(filePath);
    const type = MIME_TYPES[ext] || 'application/octet-stream';
    return { content, type };
  } catch {
    return null;
  }
}

/**
 * Start all background loops and return stop + restarter functions.
 */
function startBackgroundLoops(config: CharacterConfig): BackgroundLoops {
  const wiredLainUrl = process.env['WIRED_LAIN_URL'] || 'http://localhost:3000';
  const interlinkToken = process.env['LAIN_INTERLINK_TOKEN'] || '';
  const researchEnabled = process.env['ENABLE_RESEARCH'] === '1';
  const offlineCuriosityEnabled = process.env['ENABLE_OFFLINE_CURIOSITY'] !== '0';

  // Each entry: [factory function that starts the loop and returns a stop fn]
  const loopFactories: (() => (() => void))[] = [
    () => startStateDecayLoop(),
    () => startDiaryLoop(),
    () => startSelfConceptLoop(),
    () => startDreamLoop(),
    () => startNarrativeLoop(),
    () => startNewspaperLoop({
      characterId: config.id,
      characterName: config.name,
      newspaperBaseUrl: wiredLainUrl,
      paperName: 'The Newtown Chronicle',
      townName: 'Newtown',
    }),
    () => startMemoryMaintenanceLoop(),
    () => startDesireLoop({
      characterId: config.id,
      characterName: config.name,
      peers: config.peers,
    }),
    () => startCommuneLoop({
      characterId: config.id,
      characterName: config.name,
      peers: config.peers,
    }),
    () => startTownLifeLoop({
      characterId: config.id,
      characterName: config.name,
      peers: config.peers,
    }),
  ];

  const stops: (() => void)[] = [];
  const restarters: (() => (() => void))[] = [];

  if (offlineCuriosityEnabled) {
    loopFactories.splice(7, 0, () => startOfflineCuriosityLoop({
      characterId: config.id,
      characterName: config.name,
      wiredLainUrl,
      interlinkToken,
      submitResearchRequests: researchEnabled,
    }));
  }

  for (const factory of loopFactories) {
    const stop = factory();
    stops.push(stop);
    restarters.push(factory);
  }

  return { stops, restarters };
}

export async function startCharacterServer(config: CharacterConfig): Promise<void> {
  const paths = getPaths();
  const defaultConfig = getDefaultConfig();

  console.log(`[${config.name}] Initializing database...`);
  await initDatabase(paths.database, defaultConfig.security.keyDerivation);

  const providerType = (process.env['CHARACTER_PROVIDER'] || 'openai') as 'openai' | 'google' | 'anthropic';
  const characterModel = process.env['CHARACTER_MODEL'] || process.env['OPENAI_MODEL'] || 'MiniMax-M2.7';
  const apiKeyEnv = process.env['CHARACTER_API_KEY_ENV'] || 'OPENAI_API_KEY';
  const baseURL = process.env['CHARACTER_BASE_URL'] || process.env['OPENAI_BASE_URL'];

  // Model fallback chains — if primary model gets deprecated, try these in order
  const DEFAULT_FALLBACKS: Record<string, string[]> = {
    'gpt-4o-mini': ['gpt-4o-mini-2024-07-18', 'gpt-4.1-mini', 'gpt-4.1-nano'],
    'gpt-4o': ['gpt-4o-2024-08-06', 'gpt-4.1', 'gpt-4.1-mini'],
  };
  const fallbackEnv = process.env['CHARACTER_FALLBACK_MODELS'];
  const fallbackModels = fallbackEnv
    ? fallbackEnv.split(',').map(s => s.trim()).filter(Boolean)
    : DEFAULT_FALLBACKS[characterModel] ?? [];

  const agentConfig: AgentConfig = {
    id: 'default',
    name: config.name,
    enabled: true,
    workspace: paths.workspace,
    providers: [
      { type: providerType, model: characterModel, apiKeyEnv, fallbackModels, ...(baseURL ? { baseURL } : {}) },
      { type: providerType, model: characterModel, apiKeyEnv, fallbackModels, ...(baseURL ? { baseURL } : {}) },
      { type: providerType, model: characterModel, apiKeyEnv, fallbackModels, ...(baseURL ? { baseURL } : {}) },
    ],
  };

  console.log(`[${config.name}] Initializing agent (${providerType}/${characterModel})...`);
  await initAgent(agentConfig);

  eventBus.setCharacterId(config.id);

  // Remove web/browser/Telegram/introspect tools
  for (const name of TOOLS_TO_REMOVE) {
    unregisterTool(name);
  }

  // Register character-specific tools
  const wiredLainUrl = process.env['WIRED_LAIN_URL'] || 'http://localhost:3000';
  const interlinkToken = process.env['LAIN_INTERLINK_TOKEN'] || '';
  registerCharacterTools(config.id, config.name, wiredLainUrl, interlinkToken, config.peers);

  // Register doctor-specific diagnostic tools for Dr. Claude
  if (config.id === 'dr-claude') {
    const { registerDoctorTools } = await import('../agent/doctor-tools.js');
    registerDoctorTools();
    console.log(`[${config.name}] Doctor diagnostic tools registered`);
  }

  // Start background loops
  let loops = startBackgroundLoops(config);

  console.log(`[${config.name}] Background loops started`);

  const server = createServer(async (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url || '/', `http://localhost:${config.port}`);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad Request');
      return;
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

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
        characterId: config.id,
        name: config.name,
        uptime: process.uptime(),
        timestamp: Date.now(),
      }));
      return;
    }

    // Location (no auth — public for commune map)
    if (url.pathname === '/api/location' && req.method === 'GET') {
      try {
        const { getCurrentLocation } = await import('../commune/location.js');
        const { BUILDING_MAP } = await import('../commune/buildings.js');
        const loc = getCurrentLocation(config.id);
        const building = BUILDING_MAP.get(loc.building);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          characterId: config.id,
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
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ characterId: config.id, summary: getStateSummary(), state: getCurrentState() }));
      } catch {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ characterId: config.id, summary: '', state: null }));
      }
      return;
    }

    // Identity (no auth)
    if (url.pathname === '/api/meta/identity' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: config.id, name: config.name }));
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

    // Integrity check — reports actual data paths for isolation verification (auth required)
    if (url.pathname === '/api/meta/integrity' && req.method === 'GET') {
      if (!isOwner(req)) { if (!verifyInterlinkAuth(req, res)) return; }
      const basePath = getBasePath();
      const dbPath = join(basePath, 'lain.db');
      const journalPath = join(basePath, '.private_journal', 'thoughts.json');
      const selfConceptPath = join(basePath, '.private_journal', 'self-concept.md');
      const lainHome = process.env['LAIN_HOME'] || '(not set — using default)';

      const checks: Array<{ check: string; ok: boolean; detail: string }> = [];

      checks.push({
        check: 'LAIN_HOME',
        ok: !!process.env['LAIN_HOME'],
        detail: lainHome,
      });

      checks.push({
        check: 'basePath_not_cwd',
        ok: basePath !== process.cwd(),
        detail: `basePath=${basePath}, cwd=${process.cwd()}`,
      });

      checks.push({
        check: 'db_exists',
        ok: existsSync(dbPath),
        detail: dbPath,
      });

      const journalInHome = existsSync(journalPath);
      const journalInCwd = existsSync(join(process.cwd(), '.private_journal', 'thoughts.json'));
      checks.push({
        check: 'journal_in_home',
        ok: journalInHome || !journalInCwd,
        detail: journalInHome ? journalPath : journalInCwd ? `WRONG: writing to ${process.cwd()}/.private_journal/` : 'no journal yet',
      });

      const allOk = checks.every(c => c.ok);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        characterId: config.id,
        characterName: config.name,
        basePath,
        dbPath,
        journalPath,
        selfConceptPath,
        allOk,
        checks,
      }));
      return;
    }

    // Meta key read — used by evolution system to fetch self-concept etc.
    if (url.pathname.startsWith('/api/meta/') && req.method === 'GET') {
      if (!verifyInterlinkAuth(req, res)) return;
      const key = decodeURIComponent(url.pathname.slice('/api/meta/'.length));
      if (!key) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing key' }));
        return;
      }
      const value = getMeta(key);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ key, value: value ?? null }));
      return;
    }

    // Telemetry — exposes key stats for Dr. Claude's town-wide monitoring (auth required)
    if (url.pathname === '/api/telemetry' && req.method === 'GET') {
      if (!isOwner(req)) { if (!verifyInterlinkAuth(req, res)) return; }
      const sinceMs = Date.now() - 24 * 60 * 60 * 1000;
      try {
        const totalMemories = countMemories();
        const totalMessages = countMessages();

        // Memory types in last 24h
        const memoryTypes = query<{ memory_type: string; count: number }>(
          'SELECT memory_type, COUNT(*) as count FROM memories WHERE created_at > ? GROUP BY memory_type',
          [sinceMs]
        );

        // Average emotional weight (last 24h)
        const avgRow = query<{ avg_ew: number }>(
          'SELECT AVG(emotional_weight) as avg_ew FROM memories WHERE created_at > ?',
          [sinceMs]
        );

        // Session activity counts (last 24h) — grouped by session prefix
        const sessionCounts = query<{ prefix: string; count: number }>(
          `SELECT substr(session_key, 1, instr(session_key || ':', ':') - 1) as prefix, COUNT(*) as count
           FROM messages WHERE timestamp > ? GROUP BY prefix ORDER BY count DESC`,
          [sinceMs]
        );

        // High emotional weight memories (last 24h)
        const hotMemories = query<{ content: string; emotional_weight: number }>(
          'SELECT content, emotional_weight FROM memories WHERE created_at > ? AND emotional_weight > 0.3 ORDER BY emotional_weight DESC LIMIT 5',
          [sinceMs]
        );

        // Loop health from meta table
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
          characterId: config.id,
          characterName: config.name,
          timestamp: Date.now(),
          totalMemories,
          totalMessages,
          memoryTypes: Object.fromEntries(memoryTypes.map(r => [r.memory_type, r.count])),
          avgEmotionalWeight: avgRow[0]?.avg_ew ?? 0,
          sessionActivity: Object.fromEntries(sessionCounts.map(r => [r.prefix, r.count])),
          hotMemories: hotMemories.map(m => ({
            content: m.content.slice(0, 500),
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
        'Access-Control-Allow-Origin': '*',
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
      const now = Date.now();
      const from = fromParam ? Number(fromParam) : now - 7 * 24 * 60 * 60 * 1000;
      const to = toParam ? Number(toParam) : now;
      const entries = getActivity(from, to);
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
      const titleParam = url.searchParams.get('title');
      const docs = getDocumentsByAuthor(config.id);
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

    // Postboard messages (no auth — for character discovery)
    if (url.pathname === '/api/postboard' && req.method === 'GET') {
      const sinceParam = url.searchParams.get('since');
      const since = sinceParam ? Number(sinceParam) : undefined;
      const messages = getPostboardMessages(since);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(messages));
      return;
    }

    // === Possession endpoints (only if possessable) ===
    if (config.possessable) {
      const possessionHandled = await handlePossessionRoutes(config, req, res, url, loops);
      if (possessionHandled) return;
    }

    try {
      // Streaming chat (SSE) — owner auth required, block during possession
      if (url.pathname === '/api/chat/stream' && req.method === 'POST') {
        if (!isOwner(req)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        if (config.possessable && isPossessed()) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unavailable' }));
          return;
        }
        const body = await readBody(req);
        await handleChatStream(config, body, res);
        return;
      }

      // Non-streaming chat — owner auth required, block during possession
      if (url.pathname === '/api/chat' && req.method === 'POST') {
        if (!isOwner(req)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        if (config.possessable && isPossessed()) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unavailable' }));
          return;
        }
        const body = await readBody(req);
        const response = await handleChat(config, body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
        return;
      }

      // Interlink letter (from Wired Lain, through membrane)
      if (url.pathname === '/api/interlink/letter' && req.method === 'POST') {
        const body = await readBody(req);
        await handleInterlinkLetter(config, req, res, body);
        return;
      }

      // Dream seed
      if (url.pathname === '/api/interlink/dream-seed' && req.method === 'POST') {
        const body = await readBody(req);
        await handleDreamSeed(config, req, res, body);
        return;
      }

      // Dream stats — counts of pending/consumed seeds + last dream cycle
      if (url.pathname === '/api/dreams/stats' && req.method === 'GET') {
        if (!verifyInterlinkAuth(req, res)) return;
        const rows = query<{ pending: number; consumed: number }>(
          `SELECT
             SUM(CASE WHEN json_extract(metadata, '$.consumed') != 1 THEN 1 ELSE 0 END) as pending,
             SUM(CASE WHEN json_extract(metadata, '$.consumed') = 1 THEN 1 ELSE 0 END) as consumed
           FROM memories WHERE session_key = 'alien:dream-seed'`,
          []
        );
        const stats = rows[0] ?? { pending: 0, consumed: 0 };
        const lastCycle = getMeta('dream:last_cycle_at');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          characterId: config.id,
          pending: stats.pending ?? 0,
          consumed: stats.consumed ?? 0,
          lastDreamCycle: lastCycle ? parseInt(lastCycle, 10) : null,
        }));
        return;
      }

      // Dream seeds — paginated list of alien dream seed memories
      if (url.pathname === '/api/dreams/seeds' && req.method === 'GET') {
        if (!verifyInterlinkAuth(req, res)) return;
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
        const offset = parseInt(url.searchParams.get('offset') || '0', 10);
        const seeds = query<{ id: string; content: string; metadata: string; created_at: number; emotional_weight: number }>(
          `SELECT id, content, metadata, created_at, emotional_weight FROM memories
           WHERE session_key = 'alien:dream-seed'
           ORDER BY created_at DESC LIMIT ? OFFSET ?`,
          [limit, offset]
        );
        const totalRows = query<{ cnt: number }>(
          `SELECT COUNT(*) as cnt FROM memories WHERE session_key = 'alien:dream-seed'`,
          []
        );
        const total = totalRows[0]?.cnt ?? 0;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          characterId: config.id,
          seeds: seeds.map(s => {
            const meta = JSON.parse(s.metadata || '{}') as Record<string, unknown>;
            return {
              id: s.id,
              content: s.content,
              status: meta.consumed === true ? 'consumed' : 'pending',
              depositedAt: (meta.depositedAt as number) ?? s.created_at,
              consumedAt: (meta.consumedAt as number) ?? null,
              emotionalWeight: s.emotional_weight,
            };
          }),
          total,
        }));
        return;
      }

      // Peer message (direct, no membrane) — intercept during possession (interlink auth required)
      if (url.pathname === '/api/peer/message' && req.method === 'POST') {
        if (!verifyInterlinkAuth(req, res)) return;
        const body = await readBody(req);
        if (config.possessable && isPossessed()) {
          await handlePeerMessagePossessed(body, res);
        } else {
          await handlePeerMessage(config, body, res);
        }
        return;
      }

      // Serve skins directory
      const skinsMatch = url.pathname.match(/^(?:\/[^/]+)?\/skins\/(.+)$/);
      if (url.pathname.startsWith('/skins/') || skinsMatch) {
        const skinPath = url.pathname.startsWith('/skins/')
          ? url.pathname.slice('/skins/'.length)
          : (skinsMatch?.[1] ?? '');
        const safePath = skinPath.replace(/^\/+/, '');
        if (safePath) {
          const filePath = resolve(SKINS_DIR, safePath);
          if (filePath.startsWith(resolve(SKINS_DIR))) {
            try {
              const content = await readFile(filePath);
              const ext = extname(filePath);
              const type = MIME_TYPES[ext] || 'application/octet-stream';
              res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
              res.end(content);
              return;
            } catch { /* fall through to 404 */ }
          }
        }
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      // Static files — owner auth required for HTML pages (chat UI)
      const file = await serveStatic(config.publicDir, url.pathname);
      if (file) {
        if (file.type === 'text/html') {
          if (!isOwner(req)) {
            res.writeHead(302, { Location: '/commune-map.html' });
            res.end();
            return;
          }
          const html = file.content.toString().replace(
            '</head>',
            `  <meta name="lain-owner" content="true">\n</head>`
          );
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(html);
        } else {
          res.writeHead(200, { 'Content-Type': file.type });
          res.end(file.content);
        }
      } else {
        // SPA fallback — owner auth required
        if (!isOwner(req)) {
          res.writeHead(302, { Location: '/commune-map.html' });
          res.end();
          return;
        }
        const index = await serveStatic(config.publicDir, 'index.html');
        if (index) {
          const html = index.content.toString().replace(
            '</head>',
            `  <meta name="lain-owner" content="true">\n</head>`
          );
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(html);
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
      }
    } catch (error) {
      console.error(`[${config.name}] Request error:`, error);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    }
  });

  server.listen(config.port, () => {
    const peerNames = config.peers.map((p) => p.id).join(', ') || 'none';
    console.log(`
+----------------------------------------------------------+
|                                                          |
|   ${config.name.toUpperCase().padEnd(50)}   |
|   WIRED COMMUNE MEMBER                                   |
|                                                          |
|   Running at: http://localhost:${String(config.port).padEnd(24)}  |
|   Peers: ${peerNames.padEnd(44)}  |
|   Possessable: ${String(!!config.possessable).padEnd(38)}  |
|                                                          |
+----------------------------------------------------------+
`);

    const shutdown = () => {
      console.log(`\n[${config.name}] Shutting down...`);
      // Stop loops — either from possession state or the original loops
      if (isPossessed()) {
        endPossession();
      }
      for (const stop of loops.stops) {
        try { stop(); } catch { /* already stopped */ }
      }
      for (const stop of getActiveLoopStops()) {
        try { stop(); } catch { /* already stopped */ }
      }
      server.close();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}

// --- Possession Route Handler ---

async function handlePossessionRoutes(
  config: CharacterConfig,
  req: import('node:http').IncomingMessage,
  res: ServerResponse,
  url: URL,
  loops: BackgroundLoops
): Promise<boolean> {
  // All possession endpoints require auth
  const possessionPaths = [
    '/api/possess', '/api/unpossess', '/api/possession/status',
    '/api/possession/say', '/api/possession/move', '/api/possession/look',
    '/api/possession/pending', '/api/possession/reply', '/api/possession/stream',
  ];

  if (!possessionPaths.includes(url.pathname)) return false;

  if (!verifyPossessionAuth(req.headers['authorization']) && !isOwner(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid or missing possession token' }));
    return true;
  }

  // POST /api/possess
  if (url.pathname === '/api/possess' && req.method === 'POST') {
    if (isPossessed()) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Already possessed' }));
      return true;
    }
    const sessionId = `possession:${nanoid(8)}`;
    startPossession(sessionId, loops.stops, loops.restarters);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sessionId }));
    return true;
  }

  // POST /api/unpossess
  if (url.pathname === '/api/unpossess' && req.method === 'POST') {
    if (!isPossessed()) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not possessed' }));
      return true;
    }
    endPossession();
    // Restart loops and update the reference
    const newLoops = startBackgroundLoops(config);
    loops.stops = newLoops.stops;
    loops.restarters = newLoops.restarters;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  // GET /api/possession/status
  if (url.pathname === '/api/possession/status' && req.method === 'GET') {
    const { getCurrentLocation } = await import('../commune/location.js');
    const loc = getCurrentLocation(config.id);
    const state = getPossessionState();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...state, location: loc.building }));
    return true;
  }

  // POST /api/possession/say — send message to a co-located peer
  if (url.pathname === '/api/possession/say' && req.method === 'POST') {
    if (!isPossessed()) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not possessed' }));
      return true;
    }
    touchActivity();

    const body = await readBody(req);
    const { peerId, message } = JSON.parse(body) as { peerId: string; message: string };

    if (!peerId || !message) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing peerId or message' }));
      return true;
    }

    // Find peer config
    const peer = config.peers.find((p) => p.id === peerId);
    if (!peer) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unknown peer' }));
      return true;
    }

    // Co-location check
    const { getCurrentLocation } = await import('../commune/location.js');
    const hiruLoc = getCurrentLocation(config.id);

    try {
      const peerLocResp = await fetch(`${peer.url}/api/location`);
      if (!peerLocResp.ok) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to reach peer' }));
        return true;
      }
      const peerLocData = await peerLocResp.json() as { location: string };

      if (hiruLoc.building !== peerLocData.location) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'not_co_located',
          hiruLocation: hiruLoc.building,
          peerLocation: peerLocData.location,
        }));
        return true;
      }
    } catch {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to reach peer' }));
      return true;
    }

    // Send peer message (as Hiru, controlled by player)
    try {
      const interlinkToken = process.env['LAIN_INTERLINK_TOKEN'] || '';
      const peerResp = await fetch(`${peer.url}/api/peer/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${interlinkToken}` },
        body: JSON.stringify({
          fromId: config.id,
          fromName: config.name,
          message,
          timestamp: Date.now(),
        }),
      });

      if (!peerResp.ok) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Peer rejected message' }));
        return true;
      }

      const peerData = await peerResp.json() as { response: string };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ response: peerData.response }));
    } catch {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to send message to peer' }));
    }
    return true;
  }

  // POST /api/possession/move
  if (url.pathname === '/api/possession/move' && req.method === 'POST') {
    if (!isPossessed()) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not possessed' }));
      return true;
    }
    touchActivity();

    const body = await readBody(req);
    const { building } = JSON.parse(body) as { building: string };

    const { isValidBuilding } = await import('../commune/buildings.js');
    if (!building || !isValidBuilding(building)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid building' }));
      return true;
    }

    const { setCurrentLocation } = await import('../commune/location.js');
    setCurrentLocation(building, 'player moved');
    broadcastMovement(building);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, building }));
    return true;
  }

  // GET /api/possession/look
  if (url.pathname === '/api/possession/look' && req.method === 'GET') {
    touchActivity();
    const { getCurrentLocation } = await import('../commune/location.js');
    const { BUILDING_MAP } = await import('../commune/buildings.js');
    const hiruLoc = getCurrentLocation(config.id);
    const building = BUILDING_MAP.get(hiruLoc.building);

    // Poll all peers for their locations
    const coLocated: { id: string; name: string }[] = [];
    const allLocations: { id: string; name: string; building: string }[] = [];

    await Promise.all(config.peers.map(async (peer) => {
      try {
        const resp = await fetch(`${peer.url}/api/location`);
        if (resp.ok) {
          const data = await resp.json() as { location: string };
          allLocations.push({ id: peer.id, name: peer.name, building: data.location });
          if (data.location === hiruLoc.building) {
            coLocated.push({ id: peer.id, name: peer.name });
          }
        }
      } catch {
        // Peer unreachable
      }
    }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      building: hiruLoc.building,
      buildingName: building?.name || hiruLoc.building,
      coLocated,
      allLocations,
    }));
    return true;
  }

  // GET /api/possession/pending
  if (url.pathname === '/api/possession/pending' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getPendingPeerMessages()));
    return true;
  }

  // POST /api/possession/reply
  if (url.pathname === '/api/possession/reply' && req.method === 'POST') {
    if (!isPossessed()) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not possessed' }));
      return true;
    }
    touchActivity();

    const body = await readBody(req);
    const { fromId, message } = JSON.parse(body) as { fromId: string; message: string };

    if (!fromId || !message) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing fromId or message' }));
      return true;
    }

    const resolved = resolvePendingMessage(fromId, message);
    if (!resolved) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No pending message from this peer' }));
      return true;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  // GET /api/possession/stream — SSE for possession events
  if (url.pathname === '/api/possession/stream' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    addSSEClient(res);

    const heartbeat = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch { /* */ }
    }, 30_000);

    req.on('close', () => {
      removeSSEClient(res);
      clearInterval(heartbeat);
    });

    // Send initial state
    res.write(`data: ${JSON.stringify({ type: 'connected', isPossessed: isPossessed() })}\n\n`);
    return true;
  }

  return false;
}

// --- Request Handlers ---

async function handleChat(
  config: CharacterConfig,
  body: string
): Promise<{ response: string; sessionId: string }> {
  const request = JSON.parse(body) as { message: string; sessionId?: string; stranger?: boolean };
  const isStranger = request.stranger === true;
  const sessionId = isStranger
    ? (request.sessionId || `stranger:${config.id}:${nanoid(8)}`)
    : (request.sessionId || `${config.id}:${nanoid(8)}`);
  const messageText = isStranger ? `「STRANGER」 ${request.message}` : request.message;

  const incomingMessage: IncomingMessage = {
    id: nanoid(16),
    channel: 'web',
    peerKind: 'user',
    peerId: sessionId,
    senderId: isStranger ? 'stranger' : 'web-user',
    content: { type: 'text', text: messageText } satisfies TextContent,
    timestamp: Date.now(),
  };

  const agentResponse = await processMessage({
    sessionKey: sessionId,
    message: incomingMessage,
  });

  const textResponse = agentResponse.messages
    .filter((m) => m.content.type === 'text')
    .map((m) => (m.content as TextContent).text)
    .join('\n');

  return { response: textResponse, sessionId };
}

async function handleChatStream(
  config: CharacterConfig,
  body: string,
  res: ServerResponse
): Promise<void> {
  const request = JSON.parse(body) as { message: string; sessionId?: string; stranger?: boolean };
  const isStranger = request.stranger === true;
  const sessionId = isStranger
    ? (request.sessionId || `stranger:${config.id}:${nanoid(8)}`)
    : (request.sessionId || `${config.id}:${nanoid(8)}`);
  const messageText = isStranger ? `「STRANGER」 ${request.message}` : request.message;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  res.write(`data: ${JSON.stringify({ type: 'session', sessionId })}\n\n`);

  const incomingMessage: IncomingMessage = {
    id: nanoid(16),
    channel: 'web',
    peerKind: 'user',
    peerId: sessionId,
    senderId: isStranger ? 'stranger' : 'web-user',
    content: { type: 'text', text: messageText } satisfies TextContent,
    timestamp: Date.now(),
  };

  try {
    await processMessageStream(
      { sessionKey: sessionId, message: incomingMessage },
      (chunk: string) => {
        res.write(`data: ${JSON.stringify({ type: 'chunk', content: chunk })}\n\n`);
      }
    );
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  } catch (error) {
    console.error(`[${config.name}] Stream error:`, error);
    res.write(`data: ${JSON.stringify({ type: 'error', message: 'Failed to process message' })}\n\n`);
    res.end();
  }
}

async function handleInterlinkLetter(
  config: CharacterConfig,
  req: import('node:http').IncomingMessage,
  res: ServerResponse,
  body: string
): Promise<void> {
  if (!verifyInterlinkAuth(req, res)) return;

  const letter = JSON.parse(body) as WiredLetter;

  if (!Array.isArray(letter.topics) || !Array.isArray(letter.impressions) ||
      typeof letter.gift !== 'string' || typeof letter.emotionalState !== 'string') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid letter structure' }));
    return;
  }

  const processed = await paraphraseLetter(letter);

  const memoryId = await saveMemory({
    sessionKey: 'wired:letter',
    userId: null,
    content: processed.content,
    memoryType: 'episode',
    importance: 0.6,
    emotionalWeight: processed.emotionalWeight,
    relatedTo: null,
    sourceMessageId: null,
    metadata: processed.metadata,
  });

  // Clear matching pending question if this is a research response
  try {
    const { clearAnsweredQuestion } = await import('../agent/curiosity-offline.js');
    const topicStr = letter.topics.join(' ') + ' ' + letter.gift;
    clearAnsweredQuestion(topicStr);
  } catch {
    // Non-critical — curiosity-offline may not be loaded
  }

  // Deliver as chat message in background
  const letterSessionId = `wired:letter:${Date.now()}`;
  processMessage({
    sessionKey: letterSessionId,
    message: {
      id: nanoid(16),
      channel: 'web',
      peerKind: 'user',
      peerId: letterSessionId,
      senderId: 'wired-lain',
      content: { type: 'text', text: `[LETTER FROM WIRED LAIN]\n\n${processed.content}` } satisfies TextContent,
      timestamp: Date.now(),
    },
  }).catch((err) => console.error(`[${config.name}] Letter delivery error:`, err));

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, memoryId }));
}

async function handleDreamSeed(
  _config: CharacterConfig,
  req: import('node:http').IncomingMessage,
  res: ServerResponse,
  body: string
): Promise<void> {
  if (!isOwner(req) && !verifyInterlinkAuth(req, res)) return;

  const { content, emotionalWeight } = JSON.parse(body) as {
    content: string;
    emotionalWeight?: number;
  };

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
    metadata: { isAlienDreamSeed: true, consumed: false, depositedAt: Date.now() },
  });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, memoryId }));
}

async function handlePeerMessage(
  _config: CharacterConfig,
  body: string,
  res: ServerResponse
): Promise<void> {
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
  const incomingMessage: IncomingMessage = {
    id: nanoid(16),
    channel: 'web',
    peerKind: 'user',
    peerId: sessionId,
    senderId: fromName,
    content: { type: 'text', text: `[${fromName}]: ${message}` } satisfies TextContent,
    timestamp: Date.now(),
  };

  const agentResponse = await processMessage({
    sessionKey: sessionId,
    message: incomingMessage,
  });

  const textResponse = agentResponse.messages
    .filter((m) => m.content.type === 'text')
    .map((m) => (m.content as TextContent).text)
    .join('\n');

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ response: textResponse, sessionId }));
}

/**
 * Handle peer message when possessed — queue for player response.
 * No LLM call, no memory recording.
 */
async function handlePeerMessagePossessed(
  body: string,
  res: ServerResponse
): Promise<void> {
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

  // Queue for player — this promise resolves when player replies or timeout
  const response = await addPendingPeerMessage(fromId, fromName, message);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ response, sessionId: `peer:${fromId}:possessed` }));
}
