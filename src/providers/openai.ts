/**
 * OpenAI provider implementation
 */

import OpenAI from 'openai';
import {
  BaseProvider,
  type CompletionOptions,
  type CompletionResult,
  type CompletionWithToolsOptions,
  type CompletionWithToolsResult,
  type ToolCall,
  type ToolResult,
  type ContentBlock,
} from './base.js';
import { getLogger } from '../utils/logger.js';
import { withRetry } from './retry.js';

// Helper to extract text from message content
function getTextContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') {
    return content;
  }
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join(' ');
}

export interface OpenAIProviderConfig {
  apiKey?: string;
  model: string;
  maxTokens?: number;
  baseURL?: string;
}

export class OpenAIProvider extends BaseProvider {
  readonly name = 'openai';
  readonly model: string;
  private client: OpenAI;
  private defaultMaxTokens: number;

  constructor(config: OpenAIProviderConfig) {
    super();
    this.model = config.model;
    this.defaultMaxTokens = config.maxTokens ?? 8192;
    this.client = new OpenAI({
      apiKey: config.apiKey ?? process.env['OPENAI_API_KEY'],
      baseURL: config.baseURL,
    });
  }

  async complete(options: CompletionOptions): Promise<CompletionResult> {
    const logger = getLogger();

    logger.debug(
      { model: this.model, messageCount: options.messages.length },
      'OpenAI completion request'
    );

    const params: OpenAI.ChatCompletionCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: options.maxTokens ?? this.defaultMaxTokens,
      temperature: options.temperature ?? 1,
      messages: options.messages.map((m) => ({
        role: m.role,
        content: getTextContent(m.content),
      })),
    };
    if (options.stopSequences) {
      params.stop = options.stopSequences;
    }
    const response = await withRetry(
      () => this.client.chat.completions.create(params),
      'openai'
    );

    const choice = response.choices[0];
    const content = choice?.message?.content ?? '';

    return {
      content,
      finishReason: this.mapFinishReason(choice?.finish_reason),
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
    };
  }

  async completeWithTools(options: CompletionWithToolsOptions): Promise<CompletionWithToolsResult> {
    const logger = getLogger();

    logger.debug(
      { model: this.model, messageCount: options.messages.length, toolCount: options.tools?.length },
      'OpenAI completion with tools request'
    );

    const toolsParams: OpenAI.ChatCompletionCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: options.maxTokens ?? this.defaultMaxTokens,
      temperature: options.temperature ?? 1,
      messages: options.messages.map((m) => ({
        role: m.role,
        content: getTextContent(m.content),
      })),
    };

    if (options.tools?.length) {
      toolsParams.tools = options.tools.map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
    }
    const toolChoice = this.mapToolChoice(options.toolChoice);
    if (toolChoice) {
      toolsParams.tool_choice = toolChoice;
    }
    if (options.stopSequences) {
      toolsParams.stop = options.stopSequences;
    }

    const toolsResponse = await withRetry(
      () => this.client.chat.completions.create(toolsParams),
      'openai'
    );

    const choice = toolsResponse.choices[0];
    const content = choice?.message?.content ?? '';

    const toolCalls: ToolCall[] = (choice?.message?.tool_calls ?? []).map((tc: OpenAI.ChatCompletionMessageToolCall) => ({
      id: tc.id,
      name: tc.function.name,
      input: JSON.parse(tc.function.arguments) as Record<string, unknown>,
    }));

    const result: CompletionWithToolsResult = {
      content,
      finishReason: this.mapFinishReason(choice?.finish_reason),
      usage: {
        inputTokens: toolsResponse.usage?.prompt_tokens ?? 0,
        outputTokens: toolsResponse.usage?.completion_tokens ?? 0,
      },
    };
    if (toolCalls.length > 0) {
      result.toolCalls = toolCalls;
    }
    return result;
  }

  async continueWithToolResults(
    options: CompletionWithToolsOptions,
    toolCalls: ToolCall[],
    toolResults: ToolResult[]
  ): Promise<CompletionWithToolsResult> {
    const logger = getLogger();

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      ...options.messages.map((m) => ({
        role: m.role as 'system' | 'user' | 'assistant',
        content: getTextContent(m.content),
      })),
      {
        role: 'assistant' as const,
        content: null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.input),
          },
        })),
      },
      ...toolResults.map((tr) => ({
        role: 'tool' as const,
        tool_call_id: tr.toolCallId,
        content: tr.content,
      })),
    ];

    logger.debug(
      { model: this.model, messageCount: messages.length, toolResultCount: toolResults.length },
      'OpenAI continue with tool results'
    );

    const continueParams: OpenAI.ChatCompletionCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: options.maxTokens ?? this.defaultMaxTokens,
      temperature: options.temperature ?? 1,
      messages,
    };

    if (options.tools?.length) {
      continueParams.tools = options.tools.map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
    }
    if (options.stopSequences) {
      continueParams.stop = options.stopSequences;
    }

    const continueResponse = await withRetry(
      () => this.client.chat.completions.create(continueParams),
      'openai'
    );

    const continueChoice = continueResponse.choices[0];
    const continueContent = continueChoice?.message?.content ?? '';

    const newToolCalls: ToolCall[] = (continueChoice?.message?.tool_calls ?? []).map((tc: OpenAI.ChatCompletionMessageToolCall) => ({
      id: tc.id,
      name: tc.function.name,
      input: JSON.parse(tc.function.arguments) as Record<string, unknown>,
    }));

    const continueResult: CompletionWithToolsResult = {
      content: continueContent,
      finishReason: this.mapFinishReason(continueChoice?.finish_reason),
      usage: {
        inputTokens: continueResponse.usage?.prompt_tokens ?? 0,
        outputTokens: continueResponse.usage?.completion_tokens ?? 0,
      },
    };
    if (newToolCalls.length > 0) {
      continueResult.toolCalls = newToolCalls;
    }
    return continueResult;
  }

  private mapFinishReason(
    reason: string | null | undefined
  ): CompletionResult['finishReason'] {
    switch (reason) {
      case 'stop':
        return 'stop';
      case 'length':
        return 'length';
      case 'content_filter':
        return 'content_filter';
      case 'tool_calls':
        return 'tool_use';
      default:
        return 'stop';
    }
  }

  private mapToolChoice(
    choice?: CompletionWithToolsOptions['toolChoice']
  ): OpenAI.ChatCompletionToolChoiceOption | undefined {
    if (!choice) return undefined;
    if (choice === 'auto') return 'auto';
    if (choice === 'none') return 'none';
    if (typeof choice === 'object') {
      return { type: 'function', function: { name: choice.name } };
    }
    return undefined;
  }
}

/**
 * Create an OpenAI provider
 */
export function createOpenAIProvider(config: OpenAIProviderConfig): OpenAIProvider {
  return new OpenAIProvider(config);
}
