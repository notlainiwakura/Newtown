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
  ModelInfo,
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

/**
 * findings.md P2:1090 — when the active provider lacks a streaming
 * impl we used to just call the buffered method and return the result,
 * never firing the caller's `onChunk`. UIs that show a typing indicator
 * until the first chunk arrived would spin forever. Synthesize one
 * chunk from the buffered content so callers always get SOMETHING
 * through their callback — still not real streaming, but the UI
 * contract is preserved.
 */
async function synthesizeStream<T extends CompletionResult>(
  bufferedPromise: Promise<T>,
  onChunk: StreamCallback,
): Promise<T> {
  const result = await bufferedPromise;
  if (result.content) onChunk(result.content);
  return result;
}

/**
 * findings.md P2:1146 — fallback entries can either be a bare model name
 * (inherits the primary's provider type) or an object carrying its own
 * `type` so the chain can cross providers (Anthropic primary → OpenAI
 * fallback). The factory is invoked with the entry, not a bare string,
 * so it can branch on the right concrete provider constructor.
 */
export type FallbackChainEntry = string | { type?: string; model: string };
export type ProviderFactory = (entry: FallbackChainEntry) => Provider;

function entryModel(entry: FallbackChainEntry): string {
  return typeof entry === 'string' ? entry : entry.model;
}

/**
 * Creates a provider that tries models in order until one works.
 * Once a fallback model succeeds, it becomes the active model for
 * subsequent calls (avoids re-discovering the failure every time).
 */
export function createFallbackProvider(
  primaryProvider: Provider,
  fallbackModels: FallbackChainEntry[],
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
    for (const entry of fallbackModels) {
      const model = entryModel(entry);
      if (failedModels.has(model)) continue;
      try {
        const fallback = factory(entry);
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
      `All models exhausted in fallback chain: [${primaryProvider.model}, ${fallbackModels.map(entryModel).join(', ')}]`,
    );
  }

  // Build the proxy provider
  const proxy: Provider = {
    get name() { return activeProvider.name; },
    get model() { return activeProvider.model; },
    // findings.md P2:818 — the proxy always exposes stream methods
    // (synthesizing when the delegate lacks them), so the flag is
    // always true from the caller's perspective.
    supportsStreaming: true,

    complete(options: CompletionOptions): Promise<CompletionResult> {
      return withFallback((p) => p.complete(options), 'complete');
    },

    completeStream(
      options: CompletionOptions,
      onChunk: StreamCallback,
    ): Promise<CompletionResult> {
      return withFallback(
        (p) => p.completeStream
          ? p.completeStream(options, onChunk)
          : synthesizeStream(p.complete(options), onChunk),
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
          : synthesizeStream(p.completeWithTools(options), onChunk),
        'completeWithToolsStream',
      );
    },

    continueWithToolResults(
      options: CompletionWithToolsOptions,
      toolCalls: ToolCall[],
      toolResults: ToolResult[],
      assistantText?: string,
    ): Promise<CompletionWithToolsResult> {
      return withFallback(
        (p) => p.continueWithToolResults(options, toolCalls, toolResults, assistantText),
        'continueWithToolResults',
      );
    },

    continueWithToolResultsStream(
      options: CompletionWithToolsOptions,
      toolCalls: ToolCall[],
      toolResults: ToolResult[],
      onChunk: StreamCallback,
      assistantText?: string,
    ): Promise<CompletionWithToolsResult> {
      return withFallback(
        (p) => p.continueWithToolResultsStream
          ? p.continueWithToolResultsStream(options, toolCalls, toolResults, onChunk, assistantText)
          : synthesizeStream(
              p.continueWithToolResults(options, toolCalls, toolResults, assistantText),
              onChunk,
            ),
        'continueWithToolResultsStream',
      );
    },

    // findings.md P2:828 — delegate to whichever provider is currently
    // active. After a fallback promotion the model context shifts (e.g.
    // primary gpt-4 → fallback gpt-4o), so always route through
    // activeProvider rather than snapshotting at construction time.
    getModelInfo(): ModelInfo {
      return activeProvider.getModelInfo();
    },
  };

  return proxy;
}
