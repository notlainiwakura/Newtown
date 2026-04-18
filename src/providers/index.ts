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

import type { Provider } from './base.js';
import type { ProviderConfig } from '../types/config.js';
import { createAnthropicProvider } from './anthropic.js';
import { createOpenAIProvider } from './openai.js';
import { createGoogleProvider } from './google.js';

/**
 * Create a provider from configuration
 */
export function createProvider(config: ProviderConfig): Provider {
  const apiKey = config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined;

  switch (config.type) {
    case 'anthropic': {
      const anthropicConfig: Parameters<typeof createAnthropicProvider>[0] = { model: config.model };
      if (apiKey) anthropicConfig.apiKey = apiKey;
      return createAnthropicProvider(anthropicConfig);
    }
    case 'openai': {
      const openaiConfig: Parameters<typeof createOpenAIProvider>[0] = { model: config.model };
      if (apiKey) openaiConfig.apiKey = apiKey;
      if (config.baseURL) {
        openaiConfig.baseURL = config.baseURL;
      } else if (process.env['OPENAI_BASE_URL']) {
        openaiConfig.baseURL = process.env['OPENAI_BASE_URL'];
      }
      return createOpenAIProvider(openaiConfig);
    }
    case 'google': {
      const googleConfig: Parameters<typeof createGoogleProvider>[0] = { model: config.model };
      if (apiKey) googleConfig.apiKey = apiKey;
      return createGoogleProvider(googleConfig);
    }
    default:
      throw new Error(`Unknown provider type: ${config.type}`);
  }
}
