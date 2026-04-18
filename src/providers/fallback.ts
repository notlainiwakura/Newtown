/**
 * Fallback Provider — wraps a provider with model fallback chain.
 *
 * When the primary model returns a "not found" / "deprecated" / "decommissioned"
 * error, automatically retries with the next model in the fallback list.
 * Transparent to callers — behaves exactly like a normal Provider.
 */

import { getLogger } from '../utils/logger.js';
import type {
  Provider,
  CompletionOptions,
  CompletionResult,
  CompletionWithToolsOptions,
  CompletionWithToolsResult,
  ToolCall,
  ToolResult,
  StreamCallback,
} from './base.js';

/**
 * Error patterns that indicate a model is gone (not a transient failure).
 * These are the errors that trigger fallback to the next model.
 */
function isModelGoneError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const status = (error as { status?: number }).status;
  // 404 = model not found, 410 = gone/deprecated
  if (status === 404 || status === 410) return true;

  const msg = String((error as { message?: string }).message ?? '').toLowerCase();
  return (
    msg.includes('model not found') ||
    msg.includes('model_not_found') ||
    msg.includes('deprecated') ||
    msg.includes('decommissioned') ||
    msg.includes('no longer available') ||
    msg.includes('does not exist') ||
    msg.includes('invalid model') ||
    msg.includes('not a valid model')
  );
}

export type ProviderFactory = (model: string) => Provider;

/**
 * Creates a provider that tries models in order until one works.
 * Once a fallback model succeeds, it becomes the active model for
 * subsequent calls (avoids re-discovering the failure every time).
 */
export function createFallbackProvider(
  primaryProvider: Provider,
  fallbackModels: string[],
  factory: ProviderFactory,
): Provider {
  if (fallbackModels.length === 0) return primaryProvider;

  const logger = getLogger();
  let activeProvider = primaryProvider;
  let failedModels = new Set<string>();

  async function withFallback<T>(
    fn: (provider: Provider) => Promise<T>,
    methodName: string,
  ): Promise<T> {
    // Try active provider first
    if (!failedModels.has(activeProvider.model)) {
      try {
        return await fn(activeProvider);
      } catch (error) {
        if (!isModelGoneError(error)) throw error;
        logger.warn(
          { model: activeProvider.model, method: methodName },
          'Model appears deprecated, trying fallback chain',
        );
        failedModels.add(activeProvider.model);
      }
    }

    // Try fallback models in order
    for (const model of fallbackModels) {
      if (failedModels.has(model)) continue;
      try {
        const fallback = factory(model);
        const result = await fn(fallback);
        // Success — promote this model
        logger.info(
          { failedModel: activeProvider.model, newModel: model, method: methodName },
          'Fallback model succeeded, promoting',
        );
        activeProvider = fallback;
        return result;
      } catch (error) {
        if (!isModelGoneError(error)) throw error;
        logger.warn({ model, method: methodName }, 'Fallback model also gone');
        failedModels.add(model);
      }
    }

    // All models exhausted
    throw new Error(
      `All models exhausted in fallback chain: [${primaryProvider.model}, ${fallbackModels.join(', ')}]`,
    );
  }

  // Build the proxy provider
  const proxy: Provider = {
    get name() { return activeProvider.name; },
    get model() { return activeProvider.model; },

    complete(options: CompletionOptions): Promise<CompletionResult> {
      return withFallback((p) => p.complete(options), 'complete');
    },

    completeStream(
      options: CompletionOptions,
      onChunk: StreamCallback,
    ): Promise<CompletionResult> {
      return withFallback(
        (p) => p.completeStream ? p.completeStream(options, onChunk) : p.complete(options),
        'completeStream',
      );
    },

    completeWithTools(options: CompletionWithToolsOptions): Promise<CompletionWithToolsResult> {
      return withFallback((p) => p.completeWithTools(options), 'completeWithTools');
    },

    completeWithToolsStream(
      options: CompletionWithToolsOptions,
      onChunk: StreamCallback,
    ): Promise<CompletionWithToolsResult> {
      return withFallback(
        (p) => p.completeWithToolsStream
          ? p.completeWithToolsStream(options, onChunk)
          : p.completeWithTools(options),
        'completeWithToolsStream',
      );
    },

    continueWithToolResults(
      options: CompletionWithToolsOptions,
      toolCalls: ToolCall[],
      toolResults: ToolResult[],
    ): Promise<CompletionWithToolsResult> {
      return withFallback(
        (p) => p.continueWithToolResults(options, toolCalls, toolResults),
        'continueWithToolResults',
      );
    },

    continueWithToolResultsStream(
      options: CompletionWithToolsOptions,
      toolCalls: ToolCall[],
      toolResults: ToolResult[],
      onChunk: StreamCallback,
    ): Promise<CompletionWithToolsResult> {
      return withFallback(
        (p) => p.continueWithToolResultsStream
          ? p.continueWithToolResultsStream(options, toolCalls, toolResults, onChunk)
          : p.continueWithToolResults(options, toolCalls, toolResults),
        'continueWithToolResultsStream',
      );
    },
  };

  return proxy;
}
