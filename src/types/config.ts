/**
 * Lain configuration types
 */

export interface LainConfig {
  version: string;
  gateway: GatewayConfig;
  security: SecurityConfig;
  agents: AgentConfig[];
  logging: LoggingConfig;
}

export interface GatewayConfig {
  socketPath: string;
  socketPermissions: number;
  pidFile: string;
  rateLimit: RateLimitConfig;
}

export interface RateLimitConfig {
  connectionsPerMinute: number;
  requestsPerSecond: number;
  burstSize: number;
}

export interface SecurityConfig {
  requireAuth: boolean;
  tokenLength: number;
  inputSanitization: boolean;
  maxMessageLength: number;
  keyDerivation: KeyDerivationConfig;
}

export interface KeyDerivationConfig {
  algorithm: 'argon2id';
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}

export interface AgentConfig {
  id: string;
  name: string;
  enabled: boolean;
  workspace: string;
  providers: ProviderConfig[];
}

export interface ProviderConfig {
  type: 'anthropic' | 'openai' | 'google';
  model: string;
  apiKeyEnv?: string;
  baseURL?: string;
  /** Fallback models to try if the primary model is deprecated/removed */
  fallbackModels?: string[];
}

export interface LoggingConfig {
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  prettyPrint: boolean;
  file?: string;
}

export interface ConfigPaths {
  base: string;
  config: string;
  socket: string;
  pidFile: string;
  database: string;
  workspace: string;
  agents: string;
  extensions: string;
  credentials: string;
}
