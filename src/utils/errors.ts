/**
 * Custom error classes for Lain
 */

export class LainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'LainError';
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ConfigError extends LainError {
  constructor(message: string, cause?: Error) {
    super(message, 'CONFIG_ERROR', cause);
    this.name = 'ConfigError';
  }
}

export class ValidationError extends LainError {
  constructor(
    message: string,
    public readonly errors: string[],
    cause?: Error
  ) {
    super(message, 'VALIDATION_ERROR', cause);
    this.name = 'ValidationError';
  }
}

export class StorageError extends LainError {
  constructor(message: string, cause?: Error) {
    super(message, 'STORAGE_ERROR', cause);
    this.name = 'StorageError';
  }
}

export class KeychainError extends LainError {
  constructor(message: string, cause?: Error) {
    super(message, 'KEYCHAIN_ERROR', cause);
    this.name = 'KeychainError';
  }
}

export class GatewayError extends LainError {
  constructor(
    message: string,
    public readonly errorCode: number,
    cause?: Error
  ) {
    super(message, 'GATEWAY_ERROR', cause);
    this.name = 'GatewayError';
  }
}

export class AuthenticationError extends LainError {
  constructor(message: string, cause?: Error) {
    super(message, 'AUTH_ERROR', cause);
    this.name = 'AuthenticationError';
  }
}

export class RateLimitError extends LainError {
  constructor(
    message: string,
    public readonly retryAfter: number,
    cause?: Error
  ) {
    super(message, 'RATE_LIMIT_ERROR', cause);
    this.name = 'RateLimitError';
  }
}

export class AgentError extends LainError {
  constructor(message: string, cause?: Error) {
    super(message, 'AGENT_ERROR', cause);
    this.name = 'AgentError';
  }
}

/**
 * findings.md P2:511 — thrown when the LLM's extraction response
 * cannot be parsed (no JSON array found, or `JSON.parse` fails).
 * Callers can distinguish this from "extraction worked and found
 * nothing interesting" and decide whether to retry.
 */
export class ExtractionParseError extends LainError {
  constructor(
    message: string,
    public readonly rawResponse: string,
    cause?: Error
  ) {
    super(message, 'EXTRACTION_PARSE_ERROR', cause);
    this.name = 'ExtractionParseError';
  }
}
