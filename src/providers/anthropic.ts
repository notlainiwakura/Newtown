/**
 * Anthropic provider implementation
 */

import Anthropic, { APIError } from '@anthropic-ai/sdk';
import {
  BaseProvider,
  type CompletionOptions,
  type CompletionResult,
  type CompletionWithToolsOptions,
  type CompletionWithToolsResult,
  type ModelInfo,
  type ToolCall,
  type ToolResult,
  type Message,
  type StreamCallback,
} from './base.js';
import { getLogger } from '../utils/logger.js';
import { withRetry as sharedWithRetry } from './retry.js';

export interface AnthropicProviderConfig {
  apiKey?: string;
  model: string;
  maxTokens?: number;
  /**
   * findings.md P2:183 — provider-level defaults. Per-call
   * `CompletionOptions.temperature` / `timeoutMs` override these when set.
   */
  temperature?: number;
  requestTimeoutMs?: number;
}

/**
 * Thrown when a tool-call streaming accumulator is still open at stream
 * termination. Carries the partial `input_json` buffer so callers can
 * retry deterministically with knowledge of what was being prepared.
 * findings.md P2:910.
 */
export class IncompleteToolCallError extends Error {
  readonly partialToolCall: { id: string; name: string; inputJson: string };
  readonly completedToolCalls: ToolCall[];
  readonly content: string;
  override readonly cause: unknown;

  constructor(
    partial: { id: string; name: string; inputJson: string },
    completed: ToolCall[],
    content: string,
    cause: unknown
  ) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause);
    super(
      `Stream terminated mid tool-call "${partial.name}" (${partial.inputJson.length} bytes buffered): ${causeMsg}`
    );
    this.name = 'IncompleteToolCallError';
    this.partialToolCall = partial;
    this.completedToolCalls = completed;
    this.content = content;
    this.cause = cause;
  }
}

export class AnthropicProvider extends BaseProvider {
  readonly name = 'anthropic';
  readonly model: string;
  readonly supportsStreaming = true;
  private client: Anthropic;
  private defaultMaxTokens: number;
  private defaultTemperature: number;
  private defaultRequestTimeoutMs: number | undefined;

  constructor(config: AnthropicProviderConfig) {
    super();
    this.model = config.model;
    this.defaultMaxTokens = config.maxTokens ?? 8192;
    this.defaultTemperature = config.temperature ?? 1;
    this.defaultRequestTimeoutMs = config.requestTimeoutMs;
    this.client = new Anthropic({
      apiKey: config.apiKey ?? process.env['ANTHROPIC_API_KEY'],
    });
  }

  /**
   * findings.md P2:1080 — the prior inline withRetry duplicated every
   * improvement to the shared retry.ts (backoff constants, Retry-After
   * parsing, jitter). Delegate to the shared helper; pass our custom
   * classifier so Anthropic-specific timeout/overload detection still
   * wins alongside the shared status-code list.
   *
   * findings.md P2:788 — when the caller supplied an abortSignal via
   * CompletionOptions we hand it to shared retry so it can short-circuit
   * the backoff sleep on cancellation and stop scheduling further
   * attempts.
   */
  private async withRetry<T>(fn: () => Promise<T>, abortSignal?: AbortSignal): Promise<T> {
    // Passing isRetryable replaces the shared default classifier entirely
    // so Anthropic's overloaded/rate-limit/timeout contract is the single
    // source of truth — a plain 500 without "overloaded" shouldn't retry.
    const retryConfig: Parameters<typeof sharedWithRetry>[2] = {
      isRetryable: (error) =>
        this.isOverloadedError(error) ||
        this.isRateLimitError(error) ||
        this.isTimeoutError(error),
    };
    if (abortSignal) {
      retryConfig.abortSignal = abortSignal;
    }
    return sharedWithRetry(fn, 'anthropic', retryConfig);
  }

  /**
   * findings.md P2:788 — assemble the SDK RequestOptions slice from
   * CompletionOptions. Both fields are optional; an empty object is
   * legal and means "use SDK defaults" (which include the client's
   * own timeout).
   *
   * findings.md P2:183 — when the caller doesn't set `timeoutMs`, fall
   * back to the provider-level `requestTimeoutMs` from ProviderConfig so
   * operators can cap Anthropic calls per-character without touching
   * every call site.
   */
  private requestOptions(options: CompletionOptions): {
    signal?: AbortSignal;
    timeout?: number;
  } {
    const out: { signal?: AbortSignal; timeout?: number } = {};
    if (options.abortSignal) out.signal = options.abortSignal;
    const timeout = options.timeoutMs ?? this.defaultRequestTimeoutMs;
    if (timeout !== undefined) out.timeout = timeout;
    return out;
  }

  private isRateLimitError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    // findings.md P2:848 — a bursty caller hitting Anthropic's RPM cap
    // used to see a hard 429 failure because the classifier only matched
    // "overloaded" and timeouts. Rate limits are transparently retryable
    // just like 529 overloads; treat them the same way (exponential
    // backoff handled by withRetry; Retry-After honoring is P2:858).
    if (error instanceof APIError && error.status === 429) return true;
    const status = (error as { status?: number }).status;
    return status === 429;
  }

  private isOverloadedError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    // findings.md P2:838 — prefer the SDK's structured error class over
    // message-text matching. Anthropic returns 529 for "Overloaded"; the
    // SDK exposes this on `APIError.status`. String matching on .message
    // was the original path, but message text is localization-sensitive
    // and can change without notice — future SDK could rename "overloaded"
    // to "service busy" and retry would fail silently. Keep the string
    // fallback for errors thrown outside the SDK (e.g. wrapped errors,
    // test doubles) or from intermediaries that rewrite the response.
    if (error instanceof APIError && error.status === 529) return true;
    const msg = String((error as { message?: string }).message ?? '');
    const cause = (error as { cause?: { message?: string } }).cause;
    const causeMsg = cause ? String(cause.message ?? '') : '';
    return msg.includes('overloaded') || causeMsg.includes('overloaded') ||
      msg.includes('Overloaded') || causeMsg.includes('Overloaded');
  }

  private isTimeoutError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const msg = String((error as { message?: string }).message ?? '');
    // findings.md P2:868 — a bare AbortError is the user (or a route handler)
    // deliberately cancelling. Retrying sends another request after they
    // asked us to stop, and tokens keep accumulating through the retry
    // window. Only treat errors as retryable timeouts when the message
    // actually indicates one: the Anthropic SDK's internal timeout surfaces
    // as `APIConnectionTimeoutError` with 'timed out' in the message, and
    // node's socket-level timeouts raise ETIMEDOUT / ECONNABORTED. A pure
    // AbortError from caller cancellation carries none of these markers.
    return msg.includes('timed out') ||
      msg.includes('timeout') ||
      msg.includes('ETIMEDOUT') ||
      msg.includes('ECONNABORTED');
  }

  /**
   * Concatenate every text block in a non-streaming response, preserving
   * block order. findings.md P2:880: a prior `content.find(type==='text')`
   * dropped all blocks past the first — which is silently wrong when
   * Anthropic returns text-tool-text, interleaved thinking+text, or
   * multi-segment reasoning output. Streaming paths already accumulate
   * correctly; this keeps non-streaming on the same contract.
   */
  private extractText(blocks: Anthropic.ContentBlock[]): string {
    let text = '';
    for (const block of blocks) {
      if (block.type === 'text') text += block.text;
    }
    return text;
  }

  /**
   * findings.md P2:808 — Anthropic surfaces cache_creation_input_tokens
   * and cache_read_input_tokens on the Usage object (nonzero only when
   * prompt caching is active). Propagate both so budget accounting can
   * price cache hits at the correct rate instead of treating them as
   * fresh input tokens. Only include the fields when the API populated
   * them so the wire shape stays clean on non-cached calls.
   *
   * The cast is load-bearing: SDK 0.32.1 types only expose these fields
   * on the beta/prompt-caching Usage shape, but the GA endpoint we use
   * returns them at runtime. Read through a minimal structural type
   * rather than `any` so the optional-number contract is preserved.
   */
  private mapUsage(usage: Anthropic.Usage): CompletionResult['usage'] {
    const extended = usage as Anthropic.Usage & {
      cache_creation_input_tokens?: number | null;
      cache_read_input_tokens?: number | null;
    };
    const result: CompletionResult['usage'] = {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
    };
    if (extended.cache_creation_input_tokens != null) {
      result.cacheCreationInputTokens = extended.cache_creation_input_tokens;
    }
    if (extended.cache_read_input_tokens != null) {
      result.cacheReadInputTokens = extended.cache_read_input_tokens;
    }
    return result;
  }

  /**
   * Structural accessor for cache tokens on a streaming message_start
   * usage payload — same rationale as `mapUsage` for the GA types lag.
   */
  private readCacheTokens(usage: Anthropic.Usage): {
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
  } {
    const extended = usage as Anthropic.Usage & {
      cache_creation_input_tokens?: number | null;
      cache_read_input_tokens?: number | null;
    };
    const out: { cacheCreationInputTokens?: number; cacheReadInputTokens?: number } = {};
    if (extended.cache_creation_input_tokens != null) {
      out.cacheCreationInputTokens = extended.cache_creation_input_tokens;
    }
    if (extended.cache_read_input_tokens != null) {
      out.cacheReadInputTokens = extended.cache_read_input_tokens;
    }
    return out;
  }

  async complete(options: CompletionOptions): Promise<CompletionResult> {
    await this.assertBudget();
    const logger = getLogger();
    const { systemPrompt, messages } = this.separateSystemPrompt(options.messages);
    // findings.md P2:890 — completeWithTools honored enableCaching but
    // complete() ignored it entirely. A caller setting enableCaching:true
    // on a non-tools completion (a pure persona chat, a summary pass) got
    // no cache markers and paid full input-token cost on every turn.
    // Thread the same buildCachedSystem / withMessageCaching through here.
    //
    // findings.md P2:900 — default is TRUE. Caching is effectively free
    // when enabled (just adds cache_control hints to existing blocks)
    // and saves ~90% on repeated input tokens for the stable-prompt
    // workloads we actually run. Callers that need to opt out (tiny
    // prompts, cache-breaking debugging) can still pass enableCaching:false.
    const enableCaching = options.enableCaching ?? true;

    logger.debug(
      { model: this.model, messageCount: messages.length, caching: enableCaching },
      'Anthropic completion request'
    );

    const anthropicMessages = this.toAnthropicMessages(messages);

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: options.maxTokens ?? this.defaultMaxTokens,
      temperature: options.temperature ?? this.defaultTemperature,
      system: enableCaching ? this.buildCachedSystem(systemPrompt) : systemPrompt,
      messages: enableCaching ? this.withMessageCaching(anthropicMessages) : anthropicMessages,
    };
    if (options.stopSequences) {
      params.stop_sequences = options.stopSequences;
    }

    const reqOpts = this.requestOptions(options);
    const response = await this.withRetry(
      () => this.client.messages.create(params, reqOpts),
      options.abortSignal,
    );

    const content = this.extractText(response.content);

    return {
      content,
      finishReason: this.mapStopReason(response.stop_reason),
      usage: this.mapUsage(response.usage),
    };
  }

  async completeStream(
    options: CompletionOptions,
    onChunk: StreamCallback
  ): Promise<CompletionResult> {
    await this.assertBudget();
    const logger = getLogger();
    const { systemPrompt, messages } = this.separateSystemPrompt(options.messages);
    // findings.md P2:890 — completeStream honors enableCaching for parity
    // with complete()/completeWithTools. Streaming callers (chat UIs) are
    // exactly the workloads that benefit most from prefix caching.
    const enableCaching = options.enableCaching ?? true;

    logger.debug(
      { model: this.model, messageCount: messages.length, caching: enableCaching },
      'Anthropic streaming completion request'
    );

    const anthropicMessages = this.toAnthropicMessages(messages);

    const params: Anthropic.MessageCreateParamsStreaming = {
      model: this.model,
      max_tokens: options.maxTokens ?? this.defaultMaxTokens,
      temperature: options.temperature ?? this.defaultTemperature,
      system: enableCaching ? this.buildCachedSystem(systemPrompt) : systemPrompt,
      messages: enableCaching ? this.withMessageCaching(anthropicMessages) : anthropicMessages,
      stream: true,
    };
    if (options.stopSequences) {
      params.stop_sequences = options.stopSequences;
    }

    const reqOpts = this.requestOptions(options);
    return await this.withRetry(async () => {
      const stream = this.client.messages.stream(params, reqOpts);

      let content = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheCreationInputTokens: number | undefined;
      let cacheReadInputTokens: number | undefined;
      let finishReason: CompletionResult['finishReason'] = 'stop';

      for await (const event of stream) {
        if (event.type === 'content_block_delta') {
          const delta = event.delta;
          if ('text' in delta) {
            content += delta.text;
            onChunk(delta.text);
          }
        } else if (event.type === 'message_delta') {
          if (event.usage) {
            outputTokens = event.usage.output_tokens;
          }
          if (event.delta?.stop_reason) {
            finishReason = this.mapStopReason(event.delta.stop_reason);
          }
        } else if (event.type === 'message_start') {
          if (event.message?.usage) {
            inputTokens = event.message.usage.input_tokens;
            // findings.md P2:808 — cache tokens are only reported on
            // message_start; capture them here so streaming callers get
            // the same Usage breakdown as non-streaming.
            const cached = this.readCacheTokens(event.message.usage);
            if (cached.cacheCreationInputTokens != null) {
              cacheCreationInputTokens = cached.cacheCreationInputTokens;
            }
            if (cached.cacheReadInputTokens != null) {
              cacheReadInputTokens = cached.cacheReadInputTokens;
            }
          }
        }
      }

      const usage: CompletionResult['usage'] = { inputTokens, outputTokens };
      if (cacheCreationInputTokens != null) usage.cacheCreationInputTokens = cacheCreationInputTokens;
      if (cacheReadInputTokens != null) usage.cacheReadInputTokens = cacheReadInputTokens;

      return {
        content,
        finishReason,
        usage,
      };
    }, options.abortSignal);
  }

  async completeWithTools(options: CompletionWithToolsOptions): Promise<CompletionWithToolsResult> {
    await this.assertBudget();
    const logger = getLogger();
    const { systemPrompt, messages } = this.separateSystemPrompt(options.messages);
    const enableCaching = options.enableCaching ?? true;

    logger.debug(
      { model: this.model, messageCount: messages.length, toolCount: options.tools?.length, caching: enableCaching },
      'Anthropic completion with tools request'
    );

    // toolChoice='none' means "do not use tools"; Anthropic has no 'none' variant,
    // so the only way to enforce it is to not send tools at all.
    const suppressTools = options.toolChoice === 'none';
    const tools = suppressTools ? undefined : this.buildCachedTools(options.tools, enableCaching);

    const anthropicMessages = this.toAnthropicMessages(messages);

    const toolsParams: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: options.maxTokens ?? this.defaultMaxTokens,
      temperature: options.temperature ?? this.defaultTemperature,
      system: enableCaching ? this.buildCachedSystem(systemPrompt) : systemPrompt,
      messages: enableCaching ? this.withMessageCaching(anthropicMessages) : anthropicMessages,
    };
    if (tools) {
      toolsParams.tools = tools;
    }
    if (!suppressTools) {
      const toolChoice = this.mapToolChoice(options.toolChoice);
      if (toolChoice) {
        toolsParams.tool_choice = toolChoice;
      }
    }
    if (options.stopSequences) {
      toolsParams.stop_sequences = options.stopSequences;
    }

    const reqOpts = this.requestOptions(options);
    const response = await this.withRetry(
      () => this.client.messages.create(toolsParams, reqOpts),
      options.abortSignal,
    );

    const content = this.extractText(response.content);

    const toolCalls: ToolCall[] = response.content
      .filter((c): c is Anthropic.ToolUseBlock => c.type === 'tool_use')
      .map((c) => ({
        id: c.id,
        name: c.name,
        input: c.input as Record<string, unknown>,
      }));

    const result: CompletionWithToolsResult = {
      content,
      finishReason: this.mapStopReason(response.stop_reason),
      usage: this.mapUsage(response.usage),
    };
    if (toolCalls.length > 0) {
      result.toolCalls = toolCalls;
    }
    return result;
  }

  async completeWithToolsStream(
    options: CompletionWithToolsOptions,
    onChunk: StreamCallback
  ): Promise<CompletionWithToolsResult> {
    await this.assertBudget();
    const logger = getLogger();
    const { systemPrompt, messages } = this.separateSystemPrompt(options.messages);
    const enableCaching = options.enableCaching ?? true;

    logger.debug(
      { model: this.model, messageCount: messages.length, toolCount: options.tools?.length, caching: enableCaching },
      'Anthropic streaming completion with tools request'
    );

    // toolChoice='none' means "do not use tools"; Anthropic has no 'none' variant,
    // so the only way to enforce it is to not send tools at all.
    const suppressTools = options.toolChoice === 'none';
    const tools = suppressTools ? undefined : this.buildCachedTools(options.tools, enableCaching);

    const anthropicMessages = this.toAnthropicMessages(messages);

    const toolsParams: Anthropic.MessageCreateParamsStreaming = {
      model: this.model,
      max_tokens: options.maxTokens ?? this.defaultMaxTokens,
      temperature: options.temperature ?? this.defaultTemperature,
      system: enableCaching ? this.buildCachedSystem(systemPrompt) : systemPrompt,
      messages: enableCaching ? this.withMessageCaching(anthropicMessages) : anthropicMessages,
      stream: true,
    };
    if (tools) {
      toolsParams.tools = tools;
    }
    if (!suppressTools) {
      const toolChoice = this.mapToolChoice(options.toolChoice);
      if (toolChoice) {
        toolsParams.tool_choice = toolChoice;
      }
    }
    if (options.stopSequences) {
      toolsParams.stop_sequences = options.stopSequences;
    }

    const reqOpts = this.requestOptions(options);
    return await this.withRetry(async () => {
      const stream = this.client.messages.stream(toolsParams, reqOpts);

      let content = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheCreationInputTokens: number | undefined;
      let cacheReadInputTokens: number | undefined;
      let finishReason: CompletionResult['finishReason'] = 'stop';
      const toolCalls: ToolCall[] = [];
      let currentToolCall: { id: string; name: string; inputJson: string } | null = null;

      try {
        for await (const event of stream) {
          if (event.type === 'content_block_start') {
            if (event.content_block.type === 'tool_use') {
              currentToolCall = {
                id: event.content_block.id,
                name: event.content_block.name,
                inputJson: '',
              };
            }
          } else if (event.type === 'content_block_delta') {
            const delta = event.delta;
            if ('text' in delta) {
              content += delta.text;
              onChunk(delta.text);
            } else if ('partial_json' in delta && currentToolCall) {
              currentToolCall.inputJson += delta.partial_json;
            }
          } else if (event.type === 'content_block_stop') {
            if (currentToolCall) {
              try {
                const input = JSON.parse(currentToolCall.inputJson || '{}');
                toolCalls.push({
                  id: currentToolCall.id,
                  name: currentToolCall.name,
                  input,
                });
              } catch {
                logger.warn({ toolCall: currentToolCall }, 'Failed to parse tool call input');
              }
              currentToolCall = null;
            }
          } else if (event.type === 'message_delta') {
            if (event.usage) {
              outputTokens = event.usage.output_tokens;
            }
            if (event.delta?.stop_reason) {
              finishReason = this.mapStopReason(event.delta.stop_reason);
            }
          } else if (event.type === 'message_start') {
            if (event.message?.usage) {
              inputTokens = event.message.usage.input_tokens;
              // findings.md P2:808 — see completeStream for rationale.
              const cached = this.readCacheTokens(event.message.usage);
              if (cached.cacheCreationInputTokens != null) {
                cacheCreationInputTokens = cached.cacheCreationInputTokens;
              }
              if (cached.cacheReadInputTokens != null) {
                cacheReadInputTokens = cached.cacheReadInputTokens;
              }
            }
          }
        }
      } catch (err) {
        // findings.md P2:910 — on stream termination mid tool-call the
        // accumulator used to be silently discarded; the caller saw a
        // generic error with no hint that a tool_use block was being
        // prepared. Surface the partial state via a structured error so
        // callers can log/retry with context. Only wrap when the error
        // is not something withRetry would have handled on its own — for
        // retryable classes (overload, rate-limit, timeout) we want the
        // raw error to reach withRetry so a clean retry can kick off.
        if (currentToolCall) {
          const retryable =
            this.isOverloadedError(err) ||
            this.isRateLimitError(err) ||
            this.isTimeoutError(err);
          if (!retryable) {
            throw new IncompleteToolCallError(currentToolCall, toolCalls, content, err);
          }
        }
        throw err;
      }

      const usage: CompletionResult['usage'] = { inputTokens, outputTokens };
      if (cacheCreationInputTokens != null) usage.cacheCreationInputTokens = cacheCreationInputTokens;
      if (cacheReadInputTokens != null) usage.cacheReadInputTokens = cacheReadInputTokens;

      const result: CompletionWithToolsResult = {
        content,
        finishReason,
        usage,
      };
      if (toolCalls.length > 0) {
        result.toolCalls = toolCalls;
      }
      return result;
    }, options.abortSignal);
  }

  async continueWithToolResults(
    options: CompletionWithToolsOptions,
    toolCalls: ToolCall[],
    toolResults: ToolResult[],
    assistantText?: string
  ): Promise<CompletionWithToolsResult> {
    await this.assertBudget();
    const logger = getLogger();
    const { systemPrompt, messages } = this.separateSystemPrompt(options.messages);
    const enableCaching = options.enableCaching ?? true;

    // findings.md P2:930 — the prior turn's text blocks (e.g. "I'll look
    // that up...") used to be dropped when reconstructing the assistant
    // message. The model then saw a history where it called tools
    // without saying anything, silently erasing its own narration on
    // every tool iteration. Include the text block first so Anthropic
    // sees the same sequence it emitted. Skip empty text to avoid
    // assistant-content-block validation errors.
    const assistantContent: Anthropic.ContentBlock[] = [];
    if (assistantText && assistantText.length > 0) {
      assistantContent.push({
        type: 'text' as const,
        text: assistantText,
        citations: null,
      } as Anthropic.TextBlock);
    }
    for (const tc of toolCalls) {
      assistantContent.push({
        type: 'tool_use' as const,
        id: tc.id,
        name: tc.name,
        input: tc.input,
      });
    }

    // Build user message with tool results
    const userContent: Anthropic.ToolResultBlockParam[] = toolResults.map((tr) => {
      const block: Anthropic.ToolResultBlockParam = {
        type: 'tool_result' as const,
        tool_use_id: tr.toolCallId,
        content: tr.content,
      };
      if (tr.isError !== undefined) {
        block.is_error = tr.isError;
      }
      return block;
    });

    const allMessages: Anthropic.MessageParam[] = [
      ...this.toAnthropicMessages(messages),
      { role: 'assistant' as const, content: assistantContent },
      { role: 'user' as const, content: userContent },
    ];

    logger.debug(
      { model: this.model, messageCount: allMessages.length, toolResultCount: toolResults.length, caching: enableCaching },
      'Anthropic continue with tool results'
    );

    // findings.md P2:920 — complete*() honored options.toolChoice via
    // mapToolChoice + the suppressTools shortcut for 'none', but the
    // continue* paths silently dropped it. In an agent loop this meant a
    // "force-final-answer" turn (toolChoice:'none') could still decide
    // to call more tools because the wrapper never told Anthropic to
    // stop. Mirror the complete*() logic here.
    const suppressTools = options.toolChoice === 'none';
    const tools = suppressTools ? undefined : this.buildCachedTools(options.tools, enableCaching);

    const continueParams: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: options.maxTokens ?? this.defaultMaxTokens,
      temperature: options.temperature ?? this.defaultTemperature,
      system: enableCaching ? this.buildCachedSystem(systemPrompt) : systemPrompt,
      messages: enableCaching ? this.withMessageCaching(allMessages) : allMessages,
    };
    if (tools) {
      continueParams.tools = tools;
    }
    if (!suppressTools) {
      const toolChoice = this.mapToolChoice(options.toolChoice);
      if (toolChoice) {
        continueParams.tool_choice = toolChoice;
      }
    }
    if (options.stopSequences) {
      continueParams.stop_sequences = options.stopSequences;
    }

    const reqOpts = this.requestOptions(options);
    const response = await this.withRetry(
      () => this.client.messages.create(continueParams, reqOpts),
      options.abortSignal,
    );

    const content = this.extractText(response.content);

    const newToolCalls: ToolCall[] = response.content
      .filter((c): c is Anthropic.ToolUseBlock => c.type === 'tool_use')
      .map((c) => ({
        id: c.id,
        name: c.name,
        input: c.input as Record<string, unknown>,
      }));

    const continueResult: CompletionWithToolsResult = {
      content,
      finishReason: this.mapStopReason(response.stop_reason),
      usage: this.mapUsage(response.usage),
    };
    if (newToolCalls.length > 0) {
      continueResult.toolCalls = newToolCalls;
    }
    return continueResult;
  }

  async continueWithToolResultsStream(
    options: CompletionWithToolsOptions,
    toolCalls: ToolCall[],
    toolResults: ToolResult[],
    onChunk: StreamCallback,
    assistantText?: string
  ): Promise<CompletionWithToolsResult> {
    await this.assertBudget();
    const logger = getLogger();
    const { systemPrompt, messages } = this.separateSystemPrompt(options.messages);
    const enableCaching = options.enableCaching ?? true;

    // findings.md P2:930 — preserve the prior turn's text blocks (see
    // non-streaming variant for context).
    const assistantContent: Anthropic.ContentBlock[] = [];
    if (assistantText && assistantText.length > 0) {
      assistantContent.push({
        type: 'text' as const,
        text: assistantText,
        citations: null,
      } as Anthropic.TextBlock);
    }
    for (const tc of toolCalls) {
      assistantContent.push({
        type: 'tool_use' as const,
        id: tc.id,
        name: tc.name,
        input: tc.input,
      });
    }

    // Build user message with tool results
    const userContent: Anthropic.ToolResultBlockParam[] = toolResults.map((tr) => {
      const block: Anthropic.ToolResultBlockParam = {
        type: 'tool_result' as const,
        tool_use_id: tr.toolCallId,
        content: tr.content,
      };
      if (tr.isError !== undefined) {
        block.is_error = tr.isError;
      }
      return block;
    });

    const allMessages: Anthropic.MessageParam[] = [
      ...this.toAnthropicMessages(messages),
      { role: 'assistant' as const, content: assistantContent },
      { role: 'user' as const, content: userContent },
    ];

    logger.debug(
      { model: this.model, messageCount: allMessages.length, toolResultCount: toolResults.length, caching: enableCaching },
      'Anthropic streaming continue with tool results'
    );

    // findings.md P2:920 — mirror the toolChoice plumbing from
    // completeWithToolsStream so the streaming continue path respects
    // the caller's intent (especially 'none' for forced wrap-up turns).
    const suppressTools = options.toolChoice === 'none';
    const tools = suppressTools ? undefined : this.buildCachedTools(options.tools, enableCaching);

    const continueParams: Anthropic.MessageCreateParamsStreaming = {
      model: this.model,
      max_tokens: options.maxTokens ?? this.defaultMaxTokens,
      temperature: options.temperature ?? this.defaultTemperature,
      system: enableCaching ? this.buildCachedSystem(systemPrompt) : systemPrompt,
      messages: enableCaching ? this.withMessageCaching(allMessages) : allMessages,
      stream: true,
    };
    if (tools) {
      continueParams.tools = tools;
    }
    if (!suppressTools) {
      const toolChoice = this.mapToolChoice(options.toolChoice);
      if (toolChoice) {
        continueParams.tool_choice = toolChoice;
      }
    }
    if (options.stopSequences) {
      continueParams.stop_sequences = options.stopSequences;
    }

    const reqOpts = this.requestOptions(options);
    return await this.withRetry(async () => {
      const stream = this.client.messages.stream(continueParams, reqOpts);

      let content = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheCreationInputTokens: number | undefined;
      let cacheReadInputTokens: number | undefined;
      let finishReason: CompletionResult['finishReason'] = 'stop';
      const newToolCalls: ToolCall[] = [];
      let currentToolCall: { id: string; name: string; inputJson: string } | null = null;

      try {
        for await (const event of stream) {
          if (event.type === 'content_block_start') {
            if (event.content_block.type === 'tool_use') {
              currentToolCall = {
                id: event.content_block.id,
                name: event.content_block.name,
                inputJson: '',
              };
            }
          } else if (event.type === 'content_block_delta') {
            const delta = event.delta;
            if ('text' in delta) {
              content += delta.text;
              onChunk(delta.text);
            } else if ('partial_json' in delta && currentToolCall) {
              currentToolCall.inputJson += delta.partial_json;
            }
          } else if (event.type === 'content_block_stop') {
            if (currentToolCall) {
              try {
                const input = JSON.parse(currentToolCall.inputJson || '{}');
                newToolCalls.push({
                  id: currentToolCall.id,
                  name: currentToolCall.name,
                  input,
                });
              } catch {
                logger.warn({ toolCall: currentToolCall }, 'Failed to parse tool call input');
              }
              currentToolCall = null;
            }
          } else if (event.type === 'message_delta') {
            if (event.usage) {
              outputTokens = event.usage.output_tokens;
            }
            if (event.delta?.stop_reason) {
              finishReason = this.mapStopReason(event.delta.stop_reason);
            }
          } else if (event.type === 'message_start') {
            if (event.message?.usage) {
              inputTokens = event.message.usage.input_tokens;
              // findings.md P2:808 — see completeStream for rationale.
              const cached = this.readCacheTokens(event.message.usage);
              if (cached.cacheCreationInputTokens != null) {
                cacheCreationInputTokens = cached.cacheCreationInputTokens;
              }
              if (cached.cacheReadInputTokens != null) {
                cacheReadInputTokens = cached.cacheReadInputTokens;
              }
            }
          }
        }
      } catch (err) {
        // findings.md P2:910 — same partial-tool-call surfacing as
        // completeWithToolsStream. The continue* path matters too since
        // a tool loop can cancel or drop mid nested tool_use.
        if (currentToolCall) {
          const retryable =
            this.isOverloadedError(err) ||
            this.isRateLimitError(err) ||
            this.isTimeoutError(err);
          if (!retryable) {
            throw new IncompleteToolCallError(currentToolCall, newToolCalls, content, err);
          }
        }
        throw err;
      }

      const usage: CompletionResult['usage'] = { inputTokens, outputTokens };
      if (cacheCreationInputTokens != null) usage.cacheCreationInputTokens = cacheCreationInputTokens;
      if (cacheReadInputTokens != null) usage.cacheReadInputTokens = cacheReadInputTokens;

      const continueResult: CompletionWithToolsResult = {
        content,
        finishReason,
        usage,
      };
      if (newToolCalls.length > 0) {
        continueResult.toolCalls = newToolCalls;
      }
      return continueResult;
    }, options.abortSignal);
  }

  private separateSystemPrompt(messages: Message[]): {
    systemPrompt: string;
    messages: Message[];
  } {
    const systemMessages = messages.filter((m) => m.role === 'system');
    const otherMessages = messages.filter((m) => m.role !== 'system');

    // Extract text from system messages (they should always be text)
    const systemPrompt = systemMessages
      .map((m) => typeof m.content === 'string' ? m.content : '')
      .join('\n\n');

    return {
      systemPrompt,
      messages: otherMessages,
    };
  }

  /**
   * Convert our message format to Anthropic's format
   * Handles both text-only and multimodal messages
   */
  private toAnthropicMessages(messages: Message[]): Anthropic.MessageParam[] {
    return messages.map((m) => {
      if (typeof m.content === 'string') {
        // Simple text message
        return {
          role: m.role as 'user' | 'assistant',
          content: m.content,
        };
      }

      // Multimodal message - convert content blocks
      const content: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = m.content.map((block) => {
        if (block.type === 'text') {
          return {
            type: 'text' as const,
            text: block.text,
          } as Anthropic.TextBlockParam;
        } else if (block.type === 'image') {
          // findings.md P2:798 — the base type now supports url sources
          // too. Anthropic's GA API accepts `{type:'url', url}` as an
          // image source; SDK 0.32.1 types only declare the base64
          // variant, so the url path casts through. Base64 path stays
          // unchanged.
          if (block.source.type === 'url') {
            return {
              type: 'image' as const,
              source: {
                type: 'url',
                url: block.source.url,
              },
            } as unknown as Anthropic.ImageBlockParam;
          }
          return {
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: block.source.media_type,
              data: block.source.data,
            },
          } as Anthropic.ImageBlockParam;
        }
        // Fallback for unknown types
        return {
          type: 'text' as const,
          text: `[${(block as { type: string }).type}]`,
        } as Anthropic.TextBlockParam;
      });

      return {
        role: m.role as 'user' | 'assistant',
        content,
      };
    });
  }

  /**
   * Build cached system prompt as array of text blocks
   * Caching reduces cost by 90% on cache hits
   */
  private buildCachedSystem(systemPrompt: string): Anthropic.TextBlockParam[] {
    if (!systemPrompt) return [];

    return [
      {
        type: 'text' as const,
        text: systemPrompt,
        cache_control: { type: 'ephemeral' },
      } as Anthropic.TextBlockParam,
    ];
  }

  /**
   * Build tools with cache control on the last tool
   * This caches all tool definitions together
   */
  private buildCachedTools(
    tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> | undefined,
    enableCaching: boolean
  ): Anthropic.Tool[] | undefined {
    if (!tools || tools.length === 0) return undefined;

    return tools.map((tool, index) => {
      const base: Anthropic.Tool = {
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema as Anthropic.Tool['input_schema'],
      };

      // Add cache_control to the last tool to cache all tools
      if (enableCaching && index === tools.length - 1) {
        return {
          ...base,
          cache_control: { type: 'ephemeral' },
        } as Anthropic.Tool;
      }

      return base;
    });
  }

  /**
   * Add cache breakpoints to conversation messages for multi-turn caching.
   * Adds cache_control to the last content block of the last user message,
   * so the conversation prefix gets cached and reused across turns.
   */
  private withMessageCaching(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
    if (messages.length < 2) return messages;

    // Find the last user message
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === 'user') {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx === -1) return messages;

    const result = [...messages];
    const original = result[lastUserIdx]!;

    if (typeof original.content === 'string') {
      result[lastUserIdx] = {
        role: original.role,
        content: [
          {
            type: 'text' as const,
            text: original.content,
            cache_control: { type: 'ephemeral' },
          } as Anthropic.TextBlockParam,
        ],
      };
    } else if (Array.isArray(original.content) && original.content.length > 0) {
      const blocks = [...original.content];
      const last = blocks[blocks.length - 1]!;
      // cache_control is supported on all content block types but not yet in all SDK type definitions
      blocks[blocks.length - 1] = { ...last, cache_control: { type: 'ephemeral' } } as unknown as typeof last;
      result[lastUserIdx] = { role: original.role, content: blocks };
    }

    return result;
  }

  private mapStopReason(
    reason: string | null
  ): CompletionResult['finishReason'] {
    // findings.md P2:940 — the prior mapper folded every unrecognized
    // stop_reason into 'stop', so a safety-blocked completion (refusal)
    // looked identical to a clean end_turn and the caller had no way to
    // branch. Map 'refusal' explicitly to 'content_filter' and surface
    // anything else as 'unknown' so new/future enum members don't silently
    // look like clean completions. null (mid-message anomaly) stays 'stop'
    // for back-compat with the prior default.
    switch (reason) {
      case 'end_turn':
      case 'stop_sequence':
        return 'stop';
      case 'max_tokens':
        return 'length';
      case 'tool_use':
        return 'tool_use';
      case 'refusal':
        return 'content_filter';
      case null:
        return 'stop';
      default:
        return 'unknown';
    }
  }

  private mapToolChoice(
    choice?: CompletionWithToolsOptions['toolChoice']
  ): Anthropic.MessageCreateParams['tool_choice'] {
    if (!choice) return undefined;
    if (choice === 'auto') return { type: 'auto' };
    // Anthropic's ToolChoice union has no 'none'. Callers asking for 'none'
    // get their tools suppressed at the call site (see completeWithTools);
    // here we return undefined so no tool_choice hint is sent.
    if (choice === 'none') return undefined;
    if (typeof choice === 'object') {
      return { type: 'tool', name: choice.name };
    }
    return undefined;
  }

  /**
   * findings.md P2:828 — per-model info table. Every Anthropic model we
   * catalogue supports vision + tools; streaming tracks the provider
   * flag. maxOutputTokens is the published API cap, not the default
   * (defaults are set by `defaultMaxTokens` in the constructor). Unknown
   * model IDs fall back to the Claude 3/3.5 family shape (200k context,
   * 4096 output) — the conservative floor across the lineup.
   */
  getModelInfo(): ModelInfo {
    const model = this.model;
    // Claude 3.5 / 4 family: 200k context, 8192 output.
    if (/^claude-(3-5|3\.5|sonnet-4|opus-4|haiku-4|4-)/i.test(model) || /claude-.*-(4|4-\d)-/i.test(model)) {
      return {
        contextWindow: 200_000,
        maxOutputTokens: 8192,
        supportsVision: true,
        supportsStreaming: true,
        supportsTools: true,
      };
    }
    // Claude 3 family (opus/sonnet/haiku) and unknown: 200k context,
    // 4096 output — conservative floor.
    return {
      contextWindow: 200_000,
      maxOutputTokens: 4096,
      supportsVision: true,
      supportsStreaming: true,
      supportsTools: true,
    };
  }
}

/**
 * Create an Anthropic provider
 */
export function createAnthropicProvider(config: AnthropicProviderConfig): AnthropicProvider {
  return new AnthropicProvider(config);
}
