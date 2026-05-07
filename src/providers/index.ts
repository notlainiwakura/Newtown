/**
 * Provider module exports
 */

export {
  BaseProvider,
  type Provider,
  type Message,
  type ContentBlock,
  type TextContentBlock,
  type ImageContentBlock,
  type CompletionOptions,
  type CompletionResult,
  type CompletionWithToolsOptions,
  type CompletionWithToolsResult,
  type ToolDefinition,
  type ToolCall,
  type ToolResult,
  type ModelInfo,
} from './base.js';

export {
  AnthropicProvider,
  createAnthropicProvider,
  type AnthropicProviderConfig,
} from './anthropic.js';

export {
  OpenAIProvider,
  createOpenAIProvider,
  type OpenAIProviderConfig,
} from './openai.js';

export {
  GoogleProvider,
  createGoogleProvider,
  type GoogleProviderConfig,
} from './google.js';

import type { Provider, CompletionResult, CompletionWithToolsResult } from './base.js';
import type { ProviderConfig, FallbackModelEntry, ProviderType } from '../types/config.js';
import { createAnthropicProvider } from './anthropic.js';
import { createOpenAIProvider } from './openai.js';
import { createGoogleProvider } from './google.js';
import { createFallbackProvider, type FallbackChainEntry } from './fallback.js';
import { enforceBudget, recordUsage } from './budget.js';
import { withTruncationRecovery } from '../utils/completion-guards.js';
import { getLogger } from '../utils/logger.js';

/**
 * Create a single-model provider (no fallback).
 *
 * findings.md P2:183 — `extra` carries the optional provider-level
 * tunables (temperature, maxTokens, requestTimeoutMs, baseURL,
 * thinkingBudget). Each sub-field is only applied when defined and to
 * the provider that actually honours it:
 *   - baseURL: OpenAI only (self-hosted / OpenAI-compatible proxy)
 *   - thinkingBudget: Google only
 *   - temperature / maxTokens / requestTimeoutMs: all three providers
 */
type ProviderExtras = Pick<
  ProviderConfig,
  'thinkingBudget' | 'baseURL' | 'temperature' | 'maxTokens' | 'requestTimeoutMs'
>;

function createSingleProvider(
  type: ProviderConfig['type'],
  model: string,
  apiKey: string | undefined,
  extra?: ProviderExtras,
): Provider {
  switch (type) {
    case 'anthropic': {
      const cfg: Parameters<typeof createAnthropicProvider>[0] = { model };
      if (apiKey) cfg.apiKey = apiKey;
      if (extra?.temperature !== undefined) cfg.temperature = extra.temperature;
      if (extra?.maxTokens !== undefined) cfg.maxTokens = extra.maxTokens;
      if (extra?.requestTimeoutMs !== undefined) cfg.requestTimeoutMs = extra.requestTimeoutMs;
      return createAnthropicProvider(cfg);
    }
    case 'openai': {
      const cfg: Parameters<typeof createOpenAIProvider>[0] = { model };
      if (apiKey) cfg.apiKey = apiKey;
      if (extra?.baseURL !== undefined) cfg.baseURL = extra.baseURL;
      if (extra?.temperature !== undefined) cfg.temperature = extra.temperature;
      if (extra?.maxTokens !== undefined) cfg.maxTokens = extra.maxTokens;
      if (extra?.requestTimeoutMs !== undefined) cfg.requestTimeoutMs = extra.requestTimeoutMs;
      return createOpenAIProvider(cfg);
    }
    case 'google': {
      const cfg: Parameters<typeof createGoogleProvider>[0] = { model };
      if (apiKey) cfg.apiKey = apiKey;
      if (extra?.thinkingBudget !== undefined) cfg.thinkingBudget = extra.thinkingBudget;
      if (extra?.temperature !== undefined) cfg.temperature = extra.temperature;
      if (extra?.maxTokens !== undefined) cfg.maxTokens = extra.maxTokens;
      if (extra?.requestTimeoutMs !== undefined) cfg.requestTimeoutMs = extra.requestTimeoutMs;
      return createGoogleProvider(cfg);
    }
    default:
      throw new Error(`Unknown provider type: ${type}`);
  }
}

function tunablesFromConfig(config: ProviderConfig): ProviderExtras {
  const out: ProviderExtras = {};
  if (config.thinkingBudget !== undefined) out.thinkingBudget = config.thinkingBudget;
  if (config.baseURL !== undefined) out.baseURL = config.baseURL;
  if (config.temperature !== undefined) out.temperature = config.temperature;
  if (config.maxTokens !== undefined) out.maxTokens = config.maxTokens;
  if (config.requestTimeoutMs !== undefined) out.requestTimeoutMs = config.requestTimeoutMs;
  return out;
}

/** Track usage on a completion result */
function trackUsage(result: CompletionResult | CompletionWithToolsResult): void {
  recordUsage(result.usage.inputTokens, result.usage.outputTokens);
}

/**
 * Wrap a provider with daily token budget enforcement.
 * Checks budget before each call, records usage after.
 */
function withBudget(provider: Provider): Provider {
  return new Proxy(provider, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;

      // Wrap methods that make API calls
      const apiMethods = new Set([
        'complete', 'completeStream',
        'completeWithTools', 'completeWithToolsStream',
        'continueWithToolResults', 'continueWithToolResultsStream',
      ]);

      if (!apiMethods.has(prop as string)) return value;

      return async function (this: Provider, ...args: unknown[]) {
        await enforceBudget();
        const result = await (value as (...a: unknown[]) => Promise<CompletionResult>).apply(target, args);
        if (result && typeof result === 'object' && 'usage' in result) {
          trackUsage(result as CompletionResult);
        }
        return result;
      };
    },
  });
}

function resolveApiKey(apiKeyEnv: string | undefined): string | undefined {
  // findings.md P2:1136 — if `apiKeyEnv` points at an unset or blank env
  // var, treat that as missing so each concrete provider's `??` chain
  // falls back to its default env var name. Otherwise an empty string
  // passes through as the API key and every call dies with an opaque 401.
  const raw = apiKeyEnv ? process.env[apiKeyEnv] : undefined;
  return raw?.trim() || undefined;
}

/**
 * findings.md P2:1146 — resolve a fallback entry into a concrete
 * Provider. Bare strings inherit the primary's type/apiKeyEnv/
 * thinkingBudget; object entries can override any of those to cross
 * provider boundaries (e.g. Anthropic primary → OpenAI fallback).
 *
 * findings.md P2:183 — the provider-level tunables (temperature,
 * maxTokens, requestTimeoutMs, baseURL) also inherit from the primary.
 * They're not overridable per-fallback-entry today (keeps the
 * FallbackModelEntry surface narrow); operators who need per-model
 * tunables can split into multiple ProviderConfig instances instead.
 */
function resolveFallbackEntry(
  entry: FallbackModelEntry,
  config: ProviderConfig,
): Provider {
  if (typeof entry === 'string') {
    const apiKey = resolveApiKey(config.apiKeyEnv);
    return createSingleProvider(config.type, entry, apiKey, tunablesFromConfig(config));
  }

  const type: ProviderType = entry.type ?? config.type;
  const apiKeyEnv = entry.apiKeyEnv ?? (type === config.type ? config.apiKeyEnv : undefined);
  const apiKey = resolveApiKey(apiKeyEnv);
  // Cross-provider fallback: don't leak the primary's tunables onto a
  // different provider (e.g. Anthropic baseURL has no meaning on
  // OpenAI). Same-provider fallback inherits.
  const extras: ProviderExtras =
    type === config.type ? tunablesFromConfig(config) : {};
  const thinkingBudget = entry.thinkingBudget ?? extras.thinkingBudget;
  if (thinkingBudget !== undefined) extras.thinkingBudget = thinkingBudget;
  return createSingleProvider(type, entry.model, apiKey, extras);
}

/**
 * Create a provider from configuration.
 * If fallbackModels are specified, wraps with automatic model fallback.
 * All providers are wrapped with daily token budget enforcement.
 */
export function createProvider(config: ProviderConfig): Provider {
  const apiKey = resolveApiKey(config.apiKeyEnv);
  const primary = createSingleProvider(
    config.type,
    config.model,
    apiKey,
    tunablesFromConfig(config),
  );

  let provider: Provider;
  if (config.fallbackModels && config.fallbackModels.length > 0) {
    const originals = config.fallbackModels;
    // Position-indexed chain entries so the factory can reach back to
    // the original config and pick up apiKeyEnv / thinkingBudget
    // overrides that don't roundtrip through FallbackChainEntry.
    const entries: FallbackChainEntry[] = originals.map((e): FallbackChainEntry => {
      if (typeof e === 'string') return e;
      return e.type !== undefined ? { type: e.type, model: e.model } : { model: e.model };
    });
    provider = createFallbackProvider(
      primary,
      entries,
      (entry) => {
        const idx = entries.indexOf(entry);
        const original = idx >= 0 && originals[idx] !== undefined ? originals[idx] : entry;
        return resolveFallbackEntry(original as FallbackModelEntry, config);
      },
    );
  } else {
    provider = primary;
  }

  return withTruncationRecovery(withBudget(provider), getLogger());
}
