/**
 * Unix domain socket server for the gateway
 */

import { createServer, type Server, type Socket } from 'node:net';
import { unlink, chmod, writeFile, readFile, rm } from 'node:fs/promises';
import { nanoid } from 'nanoid';
import type { GatewayConfig } from '../types/config.js';
import type { GatewayMessage, GatewayResponse } from '../types/gateway.js';
import { GatewayErrorCodes } from '../types/gateway.js';
import { GatewayError } from '../utils/errors.js';
import { getLogger } from '../utils/logger.js';
import { handleMessage } from './router.js';
import {
  configureRateLimiter,
  canConnect,
  canRequest,
  registerConnection,
  unregisterConnection,
  getConnectionCount,
} from './rate-limiter.js';
import { deauthenticate, clearAuthentications, sweepIdleConnections, touchConnection } from './auth.js';

interface ServerState {
  server: Server | null;
  connections: Map<string, Socket>;
  config: GatewayConfig | null;
  startTime: number;
  requireAuth: boolean;
  maxMessageLength: number;
  // findings.md P2:2636 — janitor handle for the idle-connection sweep.
  idleSweepTimer: NodeJS.Timeout | null;
}

const state: ServerState = {
  server: null,
  connections: new Map(),
  config: null,
  startTime: 0,
  requireAuth: true,
  maxMessageLength: 100000,
  idleSweepTimer: null,
};

// findings.md P2:2636 — sweep every 5 minutes. Evicts any
// authenticated connection whose lastActivityAt is older than the
// default TTL (30 min). Cheap enough to always run.
const IDLE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Start the gateway server
 */
export async function startServer(
  config: GatewayConfig,
  options?: { requireAuth?: boolean; maxMessageLength?: number }
): Promise<void> {
  const logger = getLogger();

  if (state.server) {
    throw new GatewayError('Server already running', GatewayErrorCodes.INTERNAL_ERROR);
  }

  state.config = config;
  state.requireAuth = options?.requireAuth ?? true;
  state.maxMessageLength = options?.maxMessageLength ?? 100000;

  // Configure rate limiter
  configureRateLimiter(config.rateLimit);

  // Clean up existing socket file if it exists
  try {
    await unlink(config.socketPath);
  } catch {
    // Ignore if doesn't exist
  }

  // Create server
  state.server = createServer((socket) => {
    handleConnection(socket);
  });

  // Handle server errors
  state.server.on('error', (error) => {
    logger.error({ error }, 'Gateway server error');
  });

  // findings.md P2:2646 — `listen()` creates the socket file with the
  // current process umask, opening a race window where another process
  // on a shared-home multi-user host can connect() before the trailing
  // chmod tightens it. Lower the umask for the duration of listen() so
  // the socket is born with the correct permissions, then restore. The
  // post-listen chmod remains as defense-in-depth.
  const previousUmask = process.umask(0o777 & ~config.socketPermissions);
  try {
    await new Promise<void>((resolve, reject) => {
      state.server!.listen(config.socketPath, () => {
        resolve();
      });

      state.server!.once('error', reject);
    });
  } finally {
    process.umask(previousUmask);
  }

  // Belt-and-suspenders: tighten perms after listen in case a parent
  // directory or mount option loosened them.
  await chmod(config.socketPath, config.socketPermissions);

  // Write PID file
  await writeFile(config.pidFile, process.pid.toString());

  state.startTime = Date.now();

  // findings.md P2:2636 — start the idle-sweep janitor. unref() so
  // tests/CLI can exit cleanly without stopServer() hanging on it.
  state.idleSweepTimer = setInterval(() => {
    const evicted = sweepIdleConnections();
    if (evicted > 0) {
      logger.info({ evicted }, 'Swept idle gateway connections');
    }
  }, IDLE_SWEEP_INTERVAL_MS);
  if (typeof state.idleSweepTimer.unref === 'function') {
    state.idleSweepTimer.unref();
  }

  logger.info({ socketPath: config.socketPath }, 'Gateway server started');
}

/**
 * Stop the gateway server
 */
export async function stopServer(): Promise<void> {
  const logger = getLogger();

  if (!state.server) {
    return;
  }

  if (state.idleSweepTimer) {
    clearInterval(state.idleSweepTimer);
    state.idleSweepTimer = null;
  }

  for (const [connectionId, socket] of state.connections) {
    socket.destroy();
    unregisterConnection(connectionId);
    deauthenticate(connectionId);
  }
  state.connections.clear();
  clearAuthentications();

  // Close server
  await new Promise<void>((resolve) => {
    state.server!.close(() => {
      resolve();
    });
  });

  // Clean up socket file
  if (state.config) {
    try {
      await unlink(state.config.socketPath);
    } catch {
      // Ignore
    }

    // Clean up PID file
    try {
      await rm(state.config.pidFile);
    } catch {
      // Ignore
    }
  }

  state.server = null;
  state.config = null;
  logger.info('Gateway server stopped');
}

/**
 * Check if server is running
 */
export function isServerRunning(): boolean {
  return state.server !== null;
}

/**
 * Get server status
 */
export function getServerStatus(): {
  running: boolean;
  connections: number;
  uptime: number;
  socketPath?: string;
} {
  const result: {
    running: boolean;
    connections: number;
    uptime: number;
    socketPath?: string;
  } = {
    running: state.server !== null,
    connections: state.connections.size,
    uptime: state.server ? Date.now() - state.startTime : 0,
  };
  if (state.config?.socketPath) {
    result.socketPath = state.config.socketPath;
  }
  return result;
}

/**
 * Get PID from PID file
 */
export async function getServerPid(pidFile: string): Promise<number | null> {
  try {
    const content = await readFile(pidFile, 'utf-8');
    const pid = parseInt(content.trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/**
 * Check if a process is running
 */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Handle a new connection
 */
function handleConnection(socket: Socket): void {
  const logger = getLogger();
  const connectionId = nanoid(16);

  // Check rate limit for connections
  const connectResult = canConnect();
  if (!connectResult.allowed) {
    logger.warn(
      { retryAfter: connectResult.retryAfter },
      'Connection rejected: rate limit exceeded'
    );
    socket.end(
      JSON.stringify({
        id: 'system',
        error: {
          code: GatewayErrorCodes.RATE_LIMITED,
          message: 'Too many connections',
          data: { retryAfter: connectResult.retryAfter },
        },
      }) + '\n'
    );
    return;
  }

  logger.debug({ connectionId }, 'New connection');

  // Track connection
  state.connections.set(connectionId, socket);
  registerConnection(connectionId);

  let buffer = '';

  socket.on('data', (data) => {
    buffer += data.toString();

    // findings.md P2:2626 — the old check compared total-buffer-length
    // against `maxMessageLength`, so legitimate interleaved traffic
    // whose combined bytes crossed the boundary got dropped even though
    // no single message was oversized. Check per-line instead: any
    // completed line over the cap is rejected individually, and the
    // unterminated tail is bounded so a malicious client can't grow
    // the buffer forever by withholding newlines.
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    if (buffer.length > state.maxMessageLength) {
      sendResponse(socket, {
        id: 'system',
        error: {
          code: GatewayErrorCodes.MESSAGE_TOO_LARGE,
          message: 'Message too large',
        },
      });
      socket.destroy();
      return;
    }

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.length > state.maxMessageLength) {
        sendResponse(socket, {
          id: 'system',
          error: {
            code: GatewayErrorCodes.MESSAGE_TOO_LARGE,
            message: 'Message too large',
          },
        });
        continue;
      }
      processMessage(connectionId, socket, trimmed);
    }
  });

  socket.on('close', () => {
    logger.debug({ connectionId }, 'Connection closed');
    state.connections.delete(connectionId);
    unregisterConnection(connectionId);
    deauthenticate(connectionId);
  });

  socket.on('error', (error) => {
    logger.error({ connectionId, error }, 'Connection error');
    state.connections.delete(connectionId);
    unregisterConnection(connectionId);
    deauthenticate(connectionId);
  });
}

/**
 * Process an incoming message
 */
async function processMessage(
  connectionId: string,
  socket: Socket,
  data: string
): Promise<void> {
  const logger = getLogger();

  // Check rate limit for requests
  const requestResult = canRequest(connectionId);
  if (!requestResult.allowed) {
    sendResponse(socket, {
      id: 'system',
      error: {
        code: GatewayErrorCodes.RATE_LIMITED,
        message: 'Rate limit exceeded',
        data: { retryAfter: requestResult.retryAfter },
      },
    });
    return;
  }

  // Parse message
  let message: GatewayMessage;
  try {
    message = JSON.parse(data) as GatewayMessage;
  } catch {
    sendResponse(socket, {
      id: 'unknown',
      error: {
        code: GatewayErrorCodes.PARSE_ERROR,
        message: 'Invalid JSON',
      },
    });
    return;
  }

  logger.debug({ connectionId, method: message.method }, 'Processing message');

  // findings.md P2:2636 — bump lastActivityAt so legit active sessions
  // aren't swept out by the idle janitor.
  touchConnection(connectionId);

  const response = await handleMessage(connectionId, message, state.requireAuth);
  sendResponse(socket, response);
}

/**
 * Send a response to a socket
 */
function sendResponse(socket: Socket, response: GatewayResponse): void {
  if (!socket.destroyed) {
    socket.write(JSON.stringify(response) + '\n');
  }
}

/**
 * Broadcast a message to all connections
 */
export function broadcast(message: GatewayResponse): void {
  const data = JSON.stringify(message) + '\n';
  for (const socket of state.connections.values()) {
    if (!socket.destroyed) {
      socket.write(data);
    }
  }
}

/**
 * Get current connection count
 */
export { getConnectionCount };
