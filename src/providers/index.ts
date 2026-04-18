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
import type { ProviderConfig } from '../types/config.js';
import { createAnthropicProvider } from './anthropic.js';
import { createOpenAIProvider } from './openai.js';
import { createGoogleProvider } from './google.js';
import { createFallbackProvider } from './fallback.js';
import { checkBudget, recordUsage } from './budget.js';

/**
 * Create a single-model provider (no fallback).
 */
function createSingleProvider(type: ProviderConfig['type'], model: string, apiKey: string | undefined): Provider {
  switch (type) {
    case 'anthropic': {
      const cfg: Parameters<typeof createAnthropicProvider>[0] = { model };
      if (apiKey) cfg.apiKey = apiKey;
      return createAnthropicProvider(cfg);
    }
    case 'openai': {
      const cfg: Parameters<typeof createOpenAIProvider>[0] = { model };
      if (apiKey) cfg.apiKey = apiKey;
      return createOpenAIProvider(cfg);
    }
    case 'google': {
      const cfg: Parameters<typeof createGoogleProvider>[0] = { model };
      if (apiKey) cfg.apiKey = apiKey;
      return createGoogleProvider(cfg);
    }
    default:
      throw new Error(`Unknown provider type: ${type}`);
  }
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
        checkBudget();
        const result = await (value as (...a: unknown[]) => Promise<CompletionResult>).apply(target, args);
        if (result && typeof result === 'object' && 'usage' in result) {
          trackUsage(result as CompletionResult);
        }
        return result;
      };
    },
  });
}

/**
 * Create a provider from configuration.
 * If fallbackModels are specified, wraps with automatic model fallback.
 * All providers are wrapped with daily token budget enforcement.
 */
export function createProvider(config: ProviderConfig): Provider {
  const apiKey = config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined;
  const primary = createSingleProvider(config.type, config.model, apiKey);

  let provider: Provider;
  if (config.fallbackModels && config.fallbackModels.length > 0) {
    provider = createFallbackProvider(
      primary,
      config.fallbackModels,
      (model) => createSingleProvider(config.type, model, apiKey),
    );
  } else {
    provider = primary;
  }

  return withBudget(provider);
}
