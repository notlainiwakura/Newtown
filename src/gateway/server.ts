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
import { deauthenticate, clearAuthentications } from './auth.js';

interface ServerState {
  server: Server | null;
  connections: Map<string, Socket>;
  config: GatewayConfig | null;
  startTime: number;
  requireAuth: boolean;
  maxMessageLength: number;
}

const state: ServerState = {
  server: null,
  connections: new Map(),
  config: null,
  startTime: 0,
  requireAuth: true,
  maxMessageLength: 100000,
};

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

  // Start listening
  await new Promise<void>((resolve, reject) => {
    state.server!.listen(config.socketPath, () => {
      resolve();
    });

    state.server!.once('error', reject);
  });

  // Set socket permissions
  await chmod(config.socketPath, config.socketPermissions);

  // Write PID file
  await writeFile(config.pidFile, process.pid.toString());

  state.startTime = Date.now();
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

  // Close all connections
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

    // Check message size limit
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

    // Process complete messages (newline delimited)
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.trim()) {
        processMessage(connectionId, socket, line.trim());
      }
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

  // Handle message
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
