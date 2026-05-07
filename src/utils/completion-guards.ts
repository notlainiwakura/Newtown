import type {
  CompletionOptions,
  CompletionResult,
  CompletionWithToolsOptions,
  CompletionWithToolsResult,
  Message,
  Provider,
  StreamCallback,
  ToolCall,
  ToolResult,
} from '../providers/base.js';
import type { getLogger } from './logger.js';

type Logger = ReturnType<typeof getLogger>;

const MAX_TRUNCATION_CONTINUATIONS = 2;
const MIN_CONTINUATION_TOKENS = 1024;
const TRUNCATION_RECOVERY_MARKER = Symbol.for('lain.truncationRecovery');

export class TruncatedCompletionError extends Error {
  constructor(
    readonly context: string,
    readonly contentLength: number,
    readonly outputTokens: number,
  ) {
    super(`LLM output was still truncated after continuation attempts: ${context}`);
    this.name = 'TruncatedCompletionError';
  }
}

export function isTruncatedCompletion(result: Pick<CompletionResult, 'finishReason'>): boolean {
  return result.finishReason === 'length';
}

export function getCompleteContentOrNull(
  result: Pick<CompletionResult, 'content' | 'finishReason' | 'usage'>,
  context: string,
  logger: Logger,
): string | null {
  if (!isTruncatedCompletion(result)) {
    return result.content;
  }

  logger.warn(
    {
      context,
      finishReason: result.finishReason,
      contentLength: result.content.length,
      outputTokens: result.usage.outputTokens,
    },
    'Discarding truncated LLM output instead of treating it as complete content',
  );
  return null;
}

function continuationPrompt(context: string): string {
  return [
    'Continue exactly where you stopped.',
    'Do not repeat text you already wrote.',
    'Complete the answer or structured fields fully.',
    `Continuation context: ${context}`,
  ].join(' ');
}

function continuationMaxTokens(provider: Provider, requested?: number): number {
  const modelMax = typeof provider.getModelInfo === 'function'
    ? provider.getModelInfo().maxOutputTokens
    : Math.max(requested ?? MIN_CONTINUATION_TOKENS, MIN_CONTINUATION_TOKENS);
  const desired = Math.max(requested ?? MIN_CONTINUATION_TOKENS, MIN_CONTINUATION_TOKENS);
  return Math.min(desired, modelMax);
}

function completionOptionsForContinuation(
  provider: Provider,
  options: CompletionOptions,
  messages: Message[],
): CompletionOptions {
  const continuation: CompletionOptions = {
    messages,
    maxTokens: continuationMaxTokens(provider, options.maxTokens),
  };
  if (options.temperature !== undefined) continuation.temperature = options.temperature;
  if (options.stopSequences !== undefined) continuation.stopSequences = options.stopSequences;
  if (options.enableCaching !== undefined) continuation.enableCaching = options.enableCaching;
  if (options.abortSignal !== undefined) continuation.abortSignal = options.abortSignal;
  if (options.timeoutMs !== undefined) continuation.timeoutMs = options.timeoutMs;
  return continuation;
}

async function completeContinuation(
  provider: Provider,
  options: CompletionOptions,
  onChunk?: StreamCallback,
): Promise<CompletionResult> {
  if (onChunk && provider.supportsStreaming && provider.completeStream) {
    return provider.completeStream(options, onChunk);
  }

  const result = await provider.complete(options);
  if (onChunk && result.content) {
    onChunk(result.content);
  }
  return result;
}

export async function recoverTruncatedCompletion<T extends CompletionResult>(params: {
  provider: Provider;
  result: T;
  messages: Message[];
  context: string;
  logger: Logger;
  onChunk?: StreamCallback;
  options: CompletionOptions;
}): Promise<T> {
  let current: T = params.result;
  let attempts = 0;

  while (isTruncatedCompletion(current) && attempts < MAX_TRUNCATION_CONTINUATIONS) {
    attempts++;
    params.logger.warn(
      {
        context: params.context,
        attempt: attempts,
        contentLength: current.content.length,
        outputTokens: current.usage.outputTokens,
      },
      'LLM output hit max_tokens; requesting continuation',
    );

    const continuationMessages: Message[] = [
      ...params.messages,
      { role: 'assistant', content: current.content },
      { role: 'user', content: continuationPrompt(params.context) },
    ];

    const continuation = await completeContinuation(
      params.provider,
      completionOptionsForContinuation(params.provider, params.options, continuationMessages),
      params.onChunk,
    );

    current = {
      ...current,
      content: current.content + continuation.content,
      finishReason: continuation.finishReason,
      usage: {
        inputTokens: current.usage.inputTokens + continuation.usage.inputTokens,
        outputTokens: current.usage.outputTokens + continuation.usage.outputTokens,
        cacheReadInputTokens:
          (current.usage.cacheReadInputTokens ?? 0) +
          (continuation.usage.cacheReadInputTokens ?? 0),
        cacheCreationInputTokens:
          (current.usage.cacheCreationInputTokens ?? 0) +
          (continuation.usage.cacheCreationInputTokens ?? 0),
      },
    };
  }

  if (isTruncatedCompletion(current)) {
    params.logger.error(
      {
        context: params.context,
        attempts,
        contentLength: current.content.length,
        outputTokens: current.usage.outputTokens,
      },
      'LLM output remained truncated after continuation attempts',
    );
    throw new TruncatedCompletionError(params.context, current.content.length, current.usage.outputTokens);
  }

  return current;
}

function stripToolOptions(options: CompletionWithToolsOptions): CompletionOptions {
  const stripped: CompletionOptions = {
    messages: options.messages,
  };
  if (options.maxTokens !== undefined) stripped.maxTokens = options.maxTokens;
  if (options.temperature !== undefined) stripped.temperature = options.temperature;
  if (options.stopSequences !== undefined) stripped.stopSequences = options.stopSequences;
  if (options.enableCaching !== undefined) stripped.enableCaching = options.enableCaching;
  if (options.abortSignal !== undefined) stripped.abortSignal = options.abortSignal;
  if (options.timeoutMs !== undefined) stripped.timeoutMs = options.timeoutMs;
  return stripped;
}

function messagesWithToolResults(
  options: CompletionWithToolsOptions,
  toolCalls: ToolCall[],
  toolResults: ToolResult[],
  assistantText: string | undefined,
  result: CompletionResult,
): Message[] {
  const toolUseSummary = toolCalls
    .map((toolCall, index) => {
      const toolResult = toolResults[index];
      return [
        `Tool: ${toolCall.name}`,
        `Input: ${JSON.stringify(toolCall.input)}`,
        `Result: ${toolResult?.content ?? '(missing result)'}`,
      ].join('\n');
    })
    .join('\n\n---\n\n');

  return [
    ...options.messages,
    { role: 'assistant', content: assistantText || '[used tools]' },
    { role: 'user', content: `Tool results:\n${toolUseSummary}` },
    { role: 'assistant', content: result.content },
  ];
}

function preserveMockMetadata<T extends (...args: never[]) => unknown>(wrapped: T, original: unknown): T {
  const maybeMock = original as Partial<T> & {
    _isMockFunction?: boolean;
    mock?: unknown;
  };

  if (!maybeMock._isMockFunction) {
    return wrapped;
  }

  Object.defineProperty(wrapped, '_isMockFunction', {
    value: true,
    configurable: true,
  });
  Object.defineProperty(wrapped, 'mock', {
    get: () => maybeMock.mock,
    configurable: true,
  });

  for (const key of [
    'mockClear',
    'mockReset',
    'mockRestore',
    'mockImplementation',
    'mockImplementationOnce',
    'mockResolvedValue',
    'mockResolvedValueOnce',
    'mockRejectedValue',
    'mockRejectedValueOnce',
    'mockReturnValue',
    'mockReturnValueOnce',
    'getMockName',
    'mockName',
  ]) {
    const value = (maybeMock as Record<string, unknown>)[key];
    if (typeof value === 'function') {
      Object.defineProperty(wrapped, key, {
        value: value.bind(original),
        configurable: true,
      });
    }
  }

  return wrapped;
}

export function withTruncationRecovery(provider: Provider, logger: Logger): Provider {
  const existing = provider as Provider & { [TRUNCATION_RECOVERY_MARKER]?: true };
  if (existing[TRUNCATION_RECOVERY_MARKER]) {
    return provider;
  }

  const recovered: Provider = {
    name: provider.name,
    model: provider.model,
    supportsStreaming: provider.supportsStreaming,
    getModelInfo: () => provider.getModelInfo(),

    async complete(options: CompletionOptions): Promise<CompletionResult> {
      const result = await provider.complete(options);
      return recoverTruncatedCompletion({
        provider,
        result,
        messages: options.messages,
        context: `${provider.name}:${provider.model}:complete`,
        logger,
        options,
      });
    },

    async completeStream(options: CompletionOptions, onChunk: StreamCallback): Promise<CompletionResult> {
      if (!provider.completeStream) {
        return this.complete(options);
      }

      const result = await provider.completeStream(options, onChunk);
      return recoverTruncatedCompletion({
        provider,
        result,
        messages: options.messages,
        context: `${provider.name}:${provider.model}:completeStream`,
        logger,
        onChunk,
        options,
      });
    },

    async completeWithTools(options: CompletionWithToolsOptions): Promise<CompletionWithToolsResult> {
      const result = await provider.completeWithTools(options);
      if (result.toolCalls && result.toolCalls.length > 0) {
        return result;
      }

      return recoverTruncatedCompletion({
        provider,
        result,
        messages: options.messages,
        context: `${provider.name}:${provider.model}:completeWithTools`,
        logger,
        options: stripToolOptions(options),
      });
    },

    async completeWithToolsStream(
      options: CompletionWithToolsOptions,
      onChunk: StreamCallback,
    ): Promise<CompletionWithToolsResult> {
      if (!provider.completeWithToolsStream) {
        return this.completeWithTools(options);
      }

      const result = await provider.completeWithToolsStream(options, onChunk);
      if (result.toolCalls && result.toolCalls.length > 0) {
        return result;
      }

      return recoverTruncatedCompletion({
        provider,
        result,
        messages: options.messages,
        context: `${provider.name}:${provider.model}:completeWithToolsStream`,
        logger,
        onChunk,
        options: stripToolOptions(options),
      });
    },

    async continueWithToolResults(
      options: CompletionWithToolsOptions,
      toolCalls: ToolCall[],
      toolResults: ToolResult[],
      assistantText?: string,
    ): Promise<CompletionWithToolsResult> {
      const result = await provider.continueWithToolResults(options, toolCalls, toolResults, assistantText);
      if (result.toolCalls && result.toolCalls.length > 0) {
        return result;
      }

      return recoverTruncatedCompletion({
        provider,
        result,
        messages: messagesWithToolResults(options, toolCalls, toolResults, assistantText, result),
        context: `${provider.name}:${provider.model}:continueWithToolResults`,
        logger,
        options: stripToolOptions(options),
      });
    },

    async continueWithToolResultsStream(
      options: CompletionWithToolsOptions,
      toolCalls: ToolCall[],
      toolResults: ToolResult[],
      onChunk: StreamCallback,
      assistantText?: string,
    ): Promise<CompletionWithToolsResult> {
      if (!provider.continueWithToolResultsStream) {
        const result = await this.continueWithToolResults(options, toolCalls, toolResults, assistantText);
        if (result.content) {
          onChunk(result.content);
        }
        return result;
      }

      const result = await provider.continueWithToolResultsStream(
        options,
        toolCalls,
        toolResults,
        onChunk,
        assistantText,
      );
      if (result.toolCalls && result.toolCalls.length > 0) {
        return result;
      }

      return recoverTruncatedCompletion({
        provider,
        result,
        messages: messagesWithToolResults(options, toolCalls, toolResults, assistantText, result),
        context: `${provider.name}:${provider.model}:continueWithToolResultsStream`,
        logger,
        onChunk,
        options: stripToolOptions(options),
      });
    },
  };

  preserveMockMetadata(recovered.complete as (...args: never[]) => unknown, provider.complete);
  preserveMockMetadata(recovered.completeWithTools as (...args: never[]) => unknown, provider.completeWithTools);
  preserveMockMetadata(recovered.continueWithToolResults as (...args: never[]) => unknown, provider.continueWithToolResults);
  if (recovered.completeStream && provider.completeStream) {
    preserveMockMetadata(recovered.completeStream as (...args: never[]) => unknown, provider.completeStream);
  }
  if (recovered.completeWithToolsStream && provider.completeWithToolsStream) {
    preserveMockMetadata(recovered.completeWithToolsStream as (...args: never[]) => unknown, provider.completeWithToolsStream);
  }
  if (recovered.continueWithToolResultsStream && provider.continueWithToolResultsStream) {
    preserveMockMetadata(
      recovered.continueWithToolResultsStream as (...args: never[]) => unknown,
      provider.continueWithToolResultsStream,
    );
  }

  Object.defineProperty(recovered, TRUNCATION_RECOVERY_MARKER, {
    value: true,
    configurable: false,
  });

  return recovered;
}
