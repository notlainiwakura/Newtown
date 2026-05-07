/**
 * Gateway message router
 */

import type { GatewayMessage, GatewayResponse, GatewayErrorPayload } from '../types/gateway.js';
import { GatewayErrorCodes } from '../types/gateway.js';
import { getLogger } from '../utils/logger.js';
import { isAuthenticated, authenticate, setConnectionAgent, getConnection } from './auth.js';
import { processMessage as processAgentMessage } from '../agent/index.js';
import type { IncomingMessage, TextContent } from '../types/message.js';
import { nanoid } from 'nanoid';
import type { z } from 'zod';
import {
  GatewayResultSchemas,
  type GatewayMethodName,
  type GatewayResultFor,
} from './schemas.js';

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
 * findings.md P2:195 — register a handler whose output is validated against
 * the zod schema for that method before it leaves the router. If the handler
 * returns the wrong shape (missing field, wrong type, accidental `{ ok:
 * false }` sentinel, ...) `schema.parse()` throws and the connection gets an
 * `INTERNAL_ERROR` response instead of silently-malformed data. Accepts
 * either a custom schema (for extension methods) or one of the built-in
 * method names so the schema is looked up in `GatewayResultSchemas`.
 */
export function registerTypedMethod<M extends GatewayMethodName>(
  name: M,
  handler: (
    connectionId: string,
    params?: Record<string, unknown>,
  ) => Promise<GatewayResultFor<M>> | GatewayResultFor<M>,
): void;
export function registerTypedMethod<T>(
  name: string,
  schema: z.ZodType<T>,
  handler: (
    connectionId: string,
    params?: Record<string, unknown>,
  ) => Promise<T> | T,
): void;
export function registerTypedMethod(
  name: string,
  schemaOrHandler: unknown,
  maybeHandler?: unknown,
): void {
  const logger = getLogger();
  const schema =
    typeof schemaOrHandler === 'function'
      ? (GatewayResultSchemas[name as GatewayMethodName] as z.ZodTypeAny | undefined)
      : (schemaOrHandler as z.ZodTypeAny);
  const handler =
    typeof schemaOrHandler === 'function'
      ? (schemaOrHandler as MethodHandler)
      : (maybeHandler as MethodHandler);
  if (!schema) {
    throw new Error(
      `registerTypedMethod('${name}'): no schema provided and no built-in schema for method.`,
    );
  }
  methods.set(name, async (connectionId, params) => {
    const result = await handler(connectionId, params);
    const parsed = schema.safeParse(result);
    if (!parsed.success) {
      logger.error(
        { method: name, issues: parsed.error.issues },
        'Gateway handler returned malformed result — failing loudly instead of shipping it',
      );
      throw new Error(
        `Handler for '${name}' produced a result that does not match its schema.`,
      );
    }
    return parsed.data;
  });
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
    // findings.md P2:195 — validate the auth response against the same
    // schema clients use to parse it. A drift here (e.g. returning
    // `{ authenticated: false }` on a future refactor) would previously
    // have slipped through and collided with the P2:46 class of bug.
    return {
      id: message.id,
      result: GatewayResultSchemas.auth.parse({
        authenticated: true,
        connectionId: connection.id,
      }),
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

// Register built-in methods — each is validated against its zod schema in
// `GatewayResultSchemas` (see findings.md P2:195). A handler that drifts
// from its schema (e.g. a refactor that returns `{ pong: false }`) throws
// at send time instead of shipping malformed data.

registerTypedMethod('ping', () => {
  return { pong: true, timestamp: Date.now() };
});

registerTypedMethod('echo', (_connectionId, params) => {
  return { echo: params };
});

registerTypedMethod('status', () => {
  return {
    status: 'running',
    timestamp: Date.now(),
    uptime: process.uptime(),
  };
});

registerTypedMethod('setAgent', (connectionId, params) => {
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
  registerTypedMethod('chat', async (connectionId, params) => {
    const message = params?.['message'];
    if (!message || typeof message !== 'string') {
      throw new Error('Missing or invalid message parameter');
    }

    // findings.md P2:2596 / P2:2666 — the `chat` handler used to pin
    // sessionKey to 'cli:cli-user' for every caller, collapsing distinct
    // clients into one LLM session (memory extraction, relationship
    // models, token attribution all merged). `setAgent` existed as a
    // dead handshake. Read the per-connection agentId here and fall
    // back to connectionId so callers are distinguishable even when
    // they never call `setAgent`.
    const connection = getConnection(connectionId);
    const agentId = connection?.agentId ?? connectionId;
    const peerId = `cli:${agentId}`;

    const incomingMessage: IncomingMessage = {
      id: nanoid(16),
      channel: 'cli',
      peerKind: 'user',
      peerId,
      senderId: peerId,
      content: { type: 'text', text: message } satisfies TextContent,
      timestamp: Date.now(),
    };

    const response = await processAgentMessage({
      sessionKey: peerId,
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
