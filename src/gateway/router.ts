/**
 * Gateway message router
 */

import type { GatewayMessage, GatewayResponse, GatewayErrorPayload } from '../types/gateway.js';
import { GatewayErrorCodes } from '../types/gateway.js';
import { getLogger } from '../utils/logger.js';
import { isAuthenticated, authenticate, setConnectionAgent } from './auth.js';
import { processMessage as processAgentMessage } from '../agent/index.js';
import type { IncomingMessage, TextContent } from '../types/message.js';
import { nanoid } from 'nanoid';

type MethodHandler = (
  connectionId: string,
  params?: Record<string, unknown>
) => Promise<unknown> | unknown;

const methods = new Map<string, MethodHandler>();

/**
 * Register a method handler
 */
export function registerMethod(name: string, handler: MethodHandler): void {
  methods.set(name, handler);
}

/**
 * Unregister a method handler
 */
export function unregisterMethod(name: string): boolean {
  return methods.delete(name);
}

/**
 * Route and handle a gateway message
 */
export async function handleMessage(
  connectionId: string,
  message: GatewayMessage,
  requireAuth: boolean
): Promise<GatewayResponse> {
  const logger = getLogger();

  // Validate message format
  if (!message.id || typeof message.id !== 'string') {
    return createErrorResponse(
      message.id ?? 'unknown',
      GatewayErrorCodes.INVALID_REQUEST,
      'Missing or invalid message id'
    );
  }

  if (!message.method || typeof message.method !== 'string') {
    return createErrorResponse(
      message.id,
      GatewayErrorCodes.INVALID_REQUEST,
      'Missing or invalid method'
    );
  }

  // Handle authentication method specially (always allowed)
  if (message.method === 'auth') {
    return await handleAuth(connectionId, message);
  }

  // Check authentication for other methods
  if (requireAuth && !isAuthenticated(connectionId)) {
    return createErrorResponse(
      message.id,
      GatewayErrorCodes.UNAUTHORIZED,
      'Authentication required'
    );
  }

  // Find method handler
  const handler = methods.get(message.method);
  if (!handler) {
    return createErrorResponse(
      message.id,
      GatewayErrorCodes.METHOD_NOT_FOUND,
      `Unknown method: ${message.method}`
    );
  }

  // Execute handler
  try {
    const result = await handler(connectionId, message.params);
    return {
      id: message.id,
      result,
    };
  } catch (error) {
    logger.error({ error, method: message.method }, 'Method execution error');

    if (error instanceof Error) {
      return createErrorResponse(
        message.id,
        GatewayErrorCodes.INTERNAL_ERROR,
        error.message
      );
    }

    return createErrorResponse(
      message.id,
      GatewayErrorCodes.INTERNAL_ERROR,
      'Unknown error'
    );
  }
}

/**
 * Handle authentication
 */
async function handleAuth(
  connectionId: string,
  message: GatewayMessage
): Promise<GatewayResponse> {
  const token = message.params?.['token'];

  if (!token || typeof token !== 'string') {
    return createErrorResponse(
      message.id,
      GatewayErrorCodes.INVALID_PARAMS,
      'Missing or invalid token parameter'
    );
  }

  try {
    const connection = await authenticate(connectionId, token);
    return {
      id: message.id,
      result: {
        authenticated: true,
        connectionId: connection.id,
      },
    };
  } catch (error) {
    return createErrorResponse(
      message.id,
      GatewayErrorCodes.UNAUTHORIZED,
      error instanceof Error ? error.message : 'Authentication failed'
    );
  }
}

/**
 * Create an error response
 */
function createErrorResponse(
  id: string,
  code: number,
  message: string,
  data?: unknown
): GatewayResponse {
  const error: GatewayErrorPayload = { code, message };
  if (data !== undefined) {
    error.data = data;
  }
  return { id, error };
}

// Register built-in methods

registerMethod('ping', () => {
  return { pong: true, timestamp: Date.now() };
});

registerMethod('echo', (_connectionId, params) => {
  return { echo: params };
});

registerMethod('status', () => {
  return {
    status: 'running',
    timestamp: Date.now(),
    uptime: process.uptime(),
  };
});

registerMethod('setAgent', (connectionId, params) => {
  const agentId = params?.['agentId'];
  if (!agentId || typeof agentId !== 'string') {
    throw new Error('Missing or invalid agentId parameter');
  }

  if (setConnectionAgent(connectionId, agentId)) {
    return { success: true, agentId };
  }

  throw new Error('Connection not found');
});

/**
 * Register the chat method that routes to the agent
 */
export function registerChatMethod(): void {
  registerMethod('chat', async (_connectionId, params) => {
    const message = params?.['message'];
    if (!message || typeof message !== 'string') {
      throw new Error('Missing or invalid message parameter');
    }

    // Create an incoming message from the CLI chat
    const incomingMessage: IncomingMessage = {
      id: nanoid(16),
      channel: 'cli',
      peerKind: 'user',
      peerId: 'cli-user',
      senderId: 'cli-user',
      content: { type: 'text', text: message } satisfies TextContent,
      timestamp: Date.now(),
    };

    // Process through agent
    const response = await processAgentMessage({
      sessionKey: 'cli:cli-user',
      message: incomingMessage,
    });

    // Extract text response
    const textResponse = response.messages
      .filter((m) => m.content.type === 'text')
      .map((m) => (m.content as TextContent).text)
      .join('\n');

    return {
      response: textResponse,
      sessionKey: response.sessionKey,
      tokenUsage: response.tokenUsage,
    };
  });
}
