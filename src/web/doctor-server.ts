/**
 * Dr. Claude — Interactive Diagnostic Web Server
 *
 * Self-contained server with its own chat loop, tools, and persona.
 * Shares Lain's database for telemetry access but runs independently.
 */

import 'dotenv/config';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';
import { createProvider } from '../providers/index.js';
import { getActivity } from '../memory/store.js';
import { eventBus, isBackgroundEvent, type SystemEvent } from '../events/bus.js';
import { loadPersona } from '../agent/persona.js';
import { initDatabase } from '../storage/database.js';
import { getPaths } from '../config/index.js';
import { getDefaultConfig } from '../config/defaults.js';
import {
  getDoctorToolDefinitions,
  executeDoctorTools,
} from '../agent/doctor-tools.js';
import { isOwner } from './owner-auth.js';
import type {
  Provider,
  Message,
  CompletionWithToolsResult,
} from '../providers/base.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', '..', 'src', 'web', 'public-doctor');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const MAX_TOOL_ITERATIONS = 6;

// In-memory conversation history per session
const sessions = new Map<string, Message[]>();

interface ChatRequest {
  message: string;
  sessionId?: string;
}

// ============================================================
// Chat loop — Dr. Claude's own agent loop
// ============================================================

async function runDoctorChat(
  provider: Provider,
  systemPrompt: string,
  sessionId: string,
  userMessage: string,
  onChunk?: (chunk: string) => void
): Promise<string> {
  // Get or create conversation history
  let history = sessions.get(sessionId);
  if (!history) {
    history = [];
    sessions.set(sessionId, history);
  }

  // Add user message
  history.push({ role: 'user', content: userMessage });

  // Build messages with system prompt
  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    ...history,
  ];

  const tools = getDoctorToolDefinitions();

  // Initial completion
  let result: CompletionWithToolsResult;

  if (onChunk && provider.completeWithToolsStream) {
    result = await provider.completeWithToolsStream(
      { messages, tools, maxTokens: 4096, temperature: 0.5, enableCaching: true },
      onChunk
    );
  } else {
    result = await provider.completeWithTools({
      messages,
      tools,
      maxTokens: 4096,
      temperature: 0.5,
      enableCaching: true,
    });
    if (result.content && onChunk) {
      onChunk(result.content);
    }
  }

  // Tool loop
  let iterations = 0;
  while (result.toolCalls && result.toolCalls.length > 0 && iterations < MAX_TOOL_ITERATIONS) {
    iterations++;

    // Notify client about tool use
    if (onChunk) {
      const toolNames = result.toolCalls.map((tc) => tc.name).join(', ');
      onChunk(`\n\n[Running: ${toolNames}...]\n\n`);
    }

    const currentToolCalls = result.toolCalls;
    const toolResults = await executeDoctorTools(currentToolCalls);

    // Continue with tool results
    if (onChunk && provider.continueWithToolResultsStream) {
      result = await provider.continueWithToolResultsStream(
        { messages, tools, maxTokens: 4096, temperature: 0.5, enableCaching: true },
        currentToolCalls,
        toolResults,
        onChunk
      );
    } else {
      result = await provider.continueWithToolResults(
        { messages, tools, maxTokens: 4096, temperature: 0.5, enableCaching: true },
        currentToolCalls,
        toolResults
      );
      if (result.content && onChunk) {
        onChunk(result.content);
      }
    }

    // Accumulate this tool interaction into messages so the next iteration
    // has context of what was already done (prevents amnesia/looping)
    messages.push({
      role: 'assistant',
      content: currentToolCalls.map((tc) =>
        `[Used ${tc.name}: ${JSON.stringify(tc.input)}]`
      ).join('\n'),
    });
    messages.push({
      role: 'user',
      content: toolResults.map((tr) =>
        tr.content.length > 2000 ? tr.content.slice(0, 2000) + '\n[truncated]' : tr.content
      ).join('\n---\n'),
    });
  }

  // Handle incomplete response after tool loop
  if (iterations > 0 && (!result.content || result.content.trim() === '')) {
    const summaryMessages: Message[] = [
      ...messages,
      {
        role: 'user',
        content:
          'Based on all the tool results you gathered, please provide a complete summary now. Do not use any more tools.',
      },
    ];

    if (onChunk && provider.completeStream) {
      const summary = await provider.completeStream(
        { messages: summaryMessages, maxTokens: 2048, temperature: 0.5 },
        onChunk
      );
      result.content = summary.content;
    } else {
      const summary = await provider.complete({
        messages: summaryMessages,
        maxTokens: 2048,
        temperature: 0.5,
      });
      result.content = summary.content;
      if (onChunk) onChunk(result.content);
    }
  }

  // Add assistant response to history
  history.push({ role: 'assistant', content: result.content });

  // Trim history if too long (keep last 40 messages)
  if (history.length > 40) {
    const trimmed = history.slice(-40);
    sessions.set(sessionId, trimmed);
  }

  return result.content;
}

// ============================================================
// HTTP handlers
// ============================================================

async function handleChat(
  provider: Provider,
  systemPrompt: string,
  body: string
): Promise<{ response: string; sessionId: string }> {
  const request: ChatRequest = JSON.parse(body);
  const sessionId = request.sessionId || `dr:${nanoid(8)}`;

  const response = await runDoctorChat(
    provider,
    systemPrompt,
    sessionId,
    request.message
  );

  return { response, sessionId };
}

async function handleChatStream(
  provider: Provider,
  systemPrompt: string,
  body: string,
  res: ServerResponse
): Promise<void> {
  const request: ChatRequest = JSON.parse(body);
  const sessionId = request.sessionId || `dr:${nanoid(8)}`;

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  // Send session ID
  res.write(`data: ${JSON.stringify({ type: 'session', sessionId })}\n\n`);

  try {
    await runDoctorChat(provider, systemPrompt, sessionId, request.message, (chunk: string) => {
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: chunk })}\n\n`);
    });

    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  } catch (error) {
    console.error('Dr. Claude stream error:', error);
    res.write(
      `data: ${JSON.stringify({ type: 'error', message: 'Failed to process message' })}\n\n`
    );
    res.end();
  }
}

async function serveStatic(path: string): Promise<{ content: Buffer; type: string } | null> {
  try {
    const safePath = path.replace(/\.\./g, '').replace(/^\/+/, '');
    const filePath = join(PUBLIC_DIR, safePath || 'index.html');
    const content = await readFile(filePath);
    const ext = extname(filePath);
    const type = MIME_TYPES[ext] || 'application/octet-stream';
    return { content, type };
  } catch {
    return null;
  }
}

// ============================================================
// Server startup
// ============================================================

export async function startDoctorServer(port = 3002): Promise<void> {
  // Initialize database (shared with Lain)
  const paths = getPaths();
  const config = getDefaultConfig();

  console.log('Initializing database...');
  await initDatabase(paths.database, config.security.keyDerivation);

  // Create provider directly
  console.log('Creating provider...');
  const providerConfig = config.agents[0]?.providers[0];
  if (!providerConfig) {
    throw new Error('No provider configured');
  }
  const provider = createProvider(providerConfig);

  eventBus.setCharacterId('dr-claude');

  // Load Dr. Claude persona
  console.log('Loading Dr. Claude persona...');
  const doctorWorkspace = join(process.cwd(), 'workspace', 'doctor');
  const persona = await loadPersona({ workspacePath: doctorWorkspace });

  // Build system prompt (without Lain-specific communication guidelines)
  const systemPrompt = `${persona.soul}

---

## Operating Instructions

${persona.agents}

---

## Identity

${persona.identity}`;

  // Create server
  const server = createServer(async (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url || '/', `http://localhost:${port}`);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad Request');
      return;
    }

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Location (no auth — public for commune map; Dr. Claude is fixed at school)
    if (url.pathname === '/api/location' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        characterId: 'dr-claude',
        location: 'school',
        buildingName: 'School',
        row: 1,
        col: 2,
        timestamp: Date.now(),
      }));
      return;
    }

    // Identity (no auth)
    if (url.pathname === '/api/meta/identity' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'dr-claude', name: 'Dr. Claude' }));
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(entries));
      return;
    }

    // Streaming chat (SSE) — owner auth required
    if (url.pathname === '/api/chat/stream' && req.method === 'POST') {
      if (!isOwner(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', async () => {
        try {
          await handleChatStream(provider, systemPrompt, body, res);
        } catch (error) {
          console.error('Dr. Claude stream error:', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to process message' }));
        }
      });
      return;
    }

    // Non-streaming chat — owner auth required
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      if (!isOwner(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', async () => {
        try {
          const response = await handleChat(provider, systemPrompt, body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(response));
        } catch (error) {
          console.error('Dr. Claude chat error:', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to process message' }));
        }
      });
      return;
    }

    // Static files — owner auth required for HTML pages (chat UI)
    const file = await serveStatic(url.pathname);
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
      if (!isOwner(req)) {
        res.writeHead(302, { Location: '/commune-map.html' });
        res.end();
        return;
      }
      const index = await serveStatic('index.html');
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
  });

  server.listen(port, () => {
    console.log(`
+----------------------------------------------------------+
|                                                          |
|   DR. CLAUDE // DIAGNOSTIC TERMINAL                      |
|   Clinical AI Psychologist & Systems Engineer            |
|                                                          |
|   Running at: http://localhost:${port}                      |
|                                                          |
|   Tools: diagnostics, telemetry, file ops, shell         |
|   Patient: Lain Iwakura                                  |
|                                                          |
+----------------------------------------------------------+
`);

    const shutdown = () => {
      console.log('\nDr. Claude shutting down...');
      server.close();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}
