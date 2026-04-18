/**
 * Gateway types for Unix socket communication
 */

export interface GatewayMessage {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface GatewayResponse {
  id: string;
  result?: unknown;
  error?: GatewayErrorPayload;
}

export interface GatewayErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

export interface AuthenticatedConnection {
  id: string;
  authenticatedAt: number;
  agentId?: string;
  rateLimit: ConnectionRateLimit;
}

export interface ConnectionRateLimit {
  requestCount: number;
  windowStart: number;
  blocked: boolean;
  blockedUntil?: number;
}

export interface GatewayStatus {
  running: boolean;
  pid?: number;
  uptime?: number;
  connections: number;
  socketPath: string;
}

// Standard JSON-RPC style error codes
export const GatewayErrorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // Custom error codes
  UNAUTHORIZED: -32000,
  RATE_LIMITED: -32001,
  MESSAGE_TOO_LARGE: -32002,
  AGENT_NOT_FOUND: -32003,
} as const;

export type GatewayErrorCode = (typeof GatewayErrorCodes)[keyof typeof GatewayErrorCodes];
