/**
 * Anthropic provider implementation
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  BaseProvider,
  type CompletionOptions,
  type CompletionResult,
  type CompletionWithToolsOptions,
  type CompletionWithToolsResult,
  type ToolCall,
  type ToolResult,
  type Message,
  type StreamCallback,
} from './base.js';
import { getLogger } from '../utils/logger.js';

export interface AnthropicProviderConfig {
  apiKey?: string;
  model: string;
  maxTokens?: number;
}

export class AnthropicProvider extends BaseProvider {
  readonly name = 'anthropic';
  readonly model: string;
  private client: Anthropic;
  private defaultMaxTokens: number;

  private static readonly MAX_RETRIES = 3;
  private static readonly BASE_DELAY_MS = 1000;

  constructor(config: AnthropicProviderConfig) {
    super();
    this.model = config.model;
    this.defaultMaxTokens = config.maxTokens ?? 8192;
    this.client = new Anthropic({
      apiKey: config.apiKey ?? process.env['ANTHROPIC_API_KEY'],
    });
  }

  /**
   * Retry a function with exponential backoff on overloaded errors.
   * Delays: 1s, 2s, 4s — then throws.
   */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    const logger = getLogger();
    for (let attempt = 0; attempt <= AnthropicProvider.MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (error: unknown) {
        const isRetryable = this.isOverloadedError(error) || this.isTimeoutError(error);
        if (!isRetryable || attempt === AnthropicProvider.MAX_RETRIES) {
          throw error;
        }
        const delay = AnthropicProvider.BASE_DELAY_MS * Math.pow(2, attempt);
        logger.warn(
          { model: this.model, attempt: attempt + 1, delayMs: delay },
          'API overloaded, retrying'
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw new Error('unreachable');
  }

  private isOverloadedError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const msg = String((error as { message?: string }).message ?? '');
    const cause = (error as { cause?: { message?: string } }).cause;
    const causeMsg = cause ? String(cause.message ?? '') : '';
    return msg.includes('overloaded') || causeMsg.includes('overloaded') ||
      msg.includes('Overloaded') || causeMsg.includes('Overloaded');
  }

  private isTimeoutError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const msg = String((error as { message?: string }).message ?? '');
    const name = String((error as { name?: string }).name ?? '');
    return name === 'AbortError' || msg.includes('timed out') || msg.includes('timeout') ||
      msg.includes('ETIMEDOUT') || msg.includes('ECONNABORTED');
  }

  async complete(options: CompletionOptions): Promise<CompletionResult> {
    const logger = getLogger();
    const { systemPrompt, messages } = this.separateSystemPrompt(options.messages);

    logger.debug(
      { model: this.model, messageCount: messages.length },
      'Anthropic completion request'
    );

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: options.maxTokens ?? this.defaultMaxTokens,
      temperature: options.temperature ?? 1,
      system: systemPrompt,
      messages: messages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    };
    if (options.stopSequences) {
      params.stop_sequences = options.stopSequences;
    }

    const response = await this.withRetry(() => this.client.messages.create(params));

    const textContent = response.content.find((c) => c.type === 'text');
    const content = textContent?.type === 'text' ? textContent.text : '';

    return {
      content,
      finishReason: this.mapStopReason(response.stop_reason),
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }

  async completeStream(
    options: CompletionOptions,
    onChunk: StreamCallback
  ): Promise<CompletionResult> {
    const logger = getLogger();
    const { systemPrompt, messages } = this.separateSystemPrompt(options.messages);

    logger.debug(
      { model: this.model, messageCount: messages.length },
      'Anthropic streaming completion request'
    );

    const params: Anthropic.MessageCreateParamsStreaming = {
      model: this.model,
      max_tokens: options.maxTokens ?? this.defaultMaxTokens,
      temperature: options.temperature ?? 1,
      system: systemPrompt,
      messages: messages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      stream: true,
    };
    if (options.stopSequences) {
      params.stop_sequences = options.stopSequences;
    }

    return await this.withRetry(async () => {
      const stream = this.client.messages.stream(params);

      let content = '';
      let inputTokens = 0;
      let outputTokens = 0;
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
          }
        }
      }

      return {
        content,
        finishReason,
        usage: {
          inputTokens,
          outputTokens,
        },
      };
    });
  }

  async completeWithTools(options: CompletionWithToolsOptions): Promise<CompletionWithToolsResult> {
    const logger = getLogger();
    const { systemPrompt, messages } = this.separateSystemPrompt(options.messages);
    const enableCaching = options.enableCaching ?? false;

    logger.debug(
      { model: this.model, messageCount: messages.length, toolCount: options.tools?.length, caching: enableCaching },
      'Anthropic completion with tools request'
    );

    // Use caching helpers when enabled
    const tools = this.buildCachedTools(options.tools, enableCaching);

    const anthropicMessages = this.toAnthropicMessages(messages);

    const toolsParams: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: options.maxTokens ?? this.defaultMaxTokens,
      temperature: options.temperature ?? 1,
      system: enableCaching ? this.buildCachedSystem(systemPrompt) : systemPrompt,
      messages: enableCaching ? this.withMessageCaching(anthropicMessages) : anthropicMessages,
    };
    if (tools) {
      toolsParams.tools = tools;
    }
    const toolChoice = this.mapToolChoice(options.toolChoice);
    if (toolChoice) {
      toolsParams.tool_choice = toolChoice;
    }
    if (options.stopSequences) {
      toolsParams.stop_sequences = options.stopSequences;
    }

    const response = await this.withRetry(() => this.client.messages.create(toolsParams));

    const textContent = response.content.find((c) => c.type === 'text');
    const content = textContent?.type === 'text' ? textContent.text : '';

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
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
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
    const logger = getLogger();
    const { systemPrompt, messages } = this.separateSystemPrompt(options.messages);
    const enableCaching = options.enableCaching ?? false;

    logger.debug(
      { model: this.model, messageCount: messages.length, toolCount: options.tools?.length, caching: enableCaching },
      'Anthropic streaming completion with tools request'
    );

    // Use caching helpers when enabled
    const tools = this.buildCachedTools(options.tools, enableCaching);

    const anthropicMessages = this.toAnthropicMessages(messages);

    const toolsParams: Anthropic.MessageCreateParamsStreaming = {
      model: this.model,
      max_tokens: options.maxTokens ?? this.defaultMaxTokens,
      temperature: options.temperature ?? 1,
      system: enableCaching ? this.buildCachedSystem(systemPrompt) : systemPrompt,
      messages: enableCaching ? this.withMessageCaching(anthropicMessages) : anthropicMessages,
      stream: true,
    };
    if (tools) {
      toolsParams.tools = tools;
    }
    const toolChoice = this.mapToolChoice(options.toolChoice);
    if (toolChoice) {
      toolsParams.tool_choice = toolChoice;
    }
    if (options.stopSequences) {
      toolsParams.stop_sequences = options.stopSequences;
    }

    return await this.withRetry(async () => {
      const stream = this.client.messages.stream(toolsParams);

      let content = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let finishReason: CompletionResult['finishReason'] = 'stop';
      const toolCalls: ToolCall[] = [];
      let currentToolCall: { id: string; name: string; inputJson: string } | null = null;

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
          }
        }
      }

      const result: CompletionWithToolsResult = {
        content,
        finishReason,
        usage: {
          inputTokens,
          outputTokens,
        },
      };
      if (toolCalls.length > 0) {
        result.toolCalls = toolCalls;
      }
      return result;
    });
  }

  async continueWithToolResults(
    options: CompletionWithToolsOptions,
    toolCalls: ToolCall[],
    toolResults: ToolResult[]
  ): Promise<CompletionWithToolsResult> {
    const logger = getLogger();
    const { systemPrompt, messages } = this.separateSystemPrompt(options.messages);
    const enableCaching = options.enableCaching ?? false;

    // Build the assistant message with tool use
    const assistantContent: Anthropic.ContentBlock[] = toolCalls.map((tc) => ({
      type: 'tool_use' as const,
      id: tc.id,
      name: tc.name,
      input: tc.input,
    }));

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

    // Use caching helpers when enabled
    const tools = this.buildCachedTools(options.tools, enableCaching);

    const continueParams: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: options.maxTokens ?? this.defaultMaxTokens,
      temperature: options.temperature ?? 1,
      system: enableCaching ? this.buildCachedSystem(systemPrompt) : systemPrompt,
      messages: enableCaching ? this.withMessageCaching(allMessages) : allMessages,
    };
    if (tools) {
      continueParams.tools = tools;
    }
    if (options.stopSequences) {
      continueParams.stop_sequences = options.stopSequences;
    }

    const response = await this.withRetry(() => this.client.messages.create(continueParams));

    const textContent = response.content.find((c) => c.type === 'text');
    const content = textContent?.type === 'text' ? textContent.text : '';

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
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
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
    onChunk: StreamCallback
  ): Promise<CompletionWithToolsResult> {
    const logger = getLogger();
    const { systemPrompt, messages } = this.separateSystemPrompt(options.messages);
    const enableCaching = options.enableCaching ?? false;

    // Build the assistant message with tool use
    const assistantContent: Anthropic.ContentBlock[] = toolCalls.map((tc) => ({
      type: 'tool_use' as const,
      id: tc.id,
      name: tc.name,
      input: tc.input,
    }));

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

    // Use caching helpers when enabled
    const tools = this.buildCachedTools(options.tools, enableCaching);

    const continueParams: Anthropic.MessageCreateParamsStreaming = {
      model: this.model,
      max_tokens: options.maxTokens ?? this.defaultMaxTokens,
      temperature: options.temperature ?? 1,
      system: enableCaching ? this.buildCachedSystem(systemPrompt) : systemPrompt,
      messages: enableCaching ? this.withMessageCaching(allMessages) : allMessages,
      stream: true,
    };
    if (tools) {
      continueParams.tools = tools;
    }
    if (options.stopSequences) {
      continueParams.stop_sequences = options.stopSequences;
    }

    return await this.withRetry(async () => {
      const stream = this.client.messages.stream(continueParams);

      let content = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let finishReason: CompletionResult['finishReason'] = 'stop';
      const newToolCalls: ToolCall[] = [];
      let currentToolCall: { id: string; name: string; inputJson: string } | null = null;

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
          }
        }
      }

      const continueResult: CompletionWithToolsResult = {
        content,
        finishReason,
        usage: {
          inputTokens,
          outputTokens,
        },
      };
      if (newToolCalls.length > 0) {
        continueResult.toolCalls = newToolCalls;
      }
      return continueResult;
    });
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
    switch (reason) {
      case 'end_turn':
      case 'stop_sequence':
        return 'stop';
      case 'max_tokens':
        return 'length';
      case 'tool_use':
        return 'tool_use';
      default:
        return 'stop';
    }
  }

  private mapToolChoice(
    choice?: CompletionWithToolsOptions['toolChoice']
  ): Anthropic.MessageCreateParams['tool_choice'] {
    if (!choice) return undefined;
    if (choice === 'auto') return { type: 'auto' };
    if (choice === 'none') return { type: 'any' }; // Anthropic doesn't have 'none', use 'any'
    if (typeof choice === 'object') {
      return { type: 'tool', name: choice.name };
    }
    return undefined;
  }
}

/**
 * Create an Anthropic provider
 */
export function createAnthropicProvider(config: AnthropicProviderConfig): AnthropicProvider {
  return new AnthropicProvider(config);
}
