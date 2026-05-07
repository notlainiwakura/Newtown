/**
 * Lain configuration types
 */

export interface LainConfig {
  version: string;
  gateway: GatewayConfig;
  security: SecurityConfig;
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

/**
 * findings.md P2:171 — `AgentConfig` is no longer embedded in `LainConfig`.
 * It remains as the argument type for `initAgent`, but the shape is now
 * assembled from a character's `CharacterManifestEntry` via
 * `src/config/characters.ts::getAgentConfigFor`. Providers live in the
 * manifest entry; `lain.json5` no longer has an `agents[]` block.
 */
export interface AgentConfig {
  id: string;
  name: string;
  enabled: boolean;
  workspace: string;
  providers: ProviderConfig[];
}

export type ProviderType = 'anthropic' | 'openai' | 'google';

/**
 * A single entry in the fallback chain.
 *
 * - `string` form (backwards-compat): just a model name. Inherits the
 *   primary's `type`, `apiKeyEnv`, and `thinkingBudget`. Useful for
 *   intra-provider fallback (e.g. `claude-opus-4-1` → `claude-sonnet-4-0`).
 * - Object form (findings.md P2:1146): per-entry `type` override lets the
 *   chain cross providers (e.g. Anthropic primary → OpenAI fallback when
 *   Anthropic is down). Other fields inherit from the primary unless
 *   explicitly set.
 */
export type FallbackModelEntry =
  | string
  | {
      type?: ProviderType;
      model: string;
      apiKeyEnv?: string;
      thinkingBudget?: number;
    };

export interface ProviderConfig {
  type: ProviderType;
  model: string;
  apiKeyEnv?: string;
  /** Fallback models to try if the primary model is deprecated/removed */
  fallbackModels?: FallbackModelEntry[];
  /**
   * Google-only: Gemini 2.5 thinking budget. `undefined` lets Gemini decide per model.
   * Set `0` for 2.5 Flash where thinking tokens otherwise consume the visible-output
   * budget. No effect on Anthropic/OpenAI.
   */
  thinkingBudget?: number;
  /**
   * findings.md P2:183 — optional per-character tunables. All are
   * defaults for calls that don't set `CompletionOptions.{temperature,
   * maxTokens, timeoutMs}` explicitly. Leaving any of them unset preserves
   * the previous hardcoded behaviour (temperature 1, maxTokens 8192, SDK-default
   * timeout). `baseURL` is OpenAI-only (used for self-hosted or
   * OpenAI-compatible proxy endpoints); Anthropic/Google ignore it.
   */
  baseURL?: string;
  temperature?: number;
  maxTokens?: number;
  requestTimeoutMs?: number;
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
