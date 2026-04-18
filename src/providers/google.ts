/**
 * Google AI (Gemini) provider implementation
 */

import { GoogleGenerativeAI, type Content, type Part } from '@google/generative-ai';
import {
  BaseProvider,
  type CompletionOptions,
  type CompletionResult,
  type CompletionWithToolsOptions,
  type CompletionWithToolsResult,
  type ToolCall,
  type ToolResult,
  type Message,
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

export interface GoogleProviderConfig {
  apiKey?: string;
  model: string;
  maxTokens?: number;
}

export class GoogleProvider extends BaseProvider {
  readonly name = 'google';
  readonly model: string;
  private client: GoogleGenerativeAI;
  private defaultMaxTokens: number;

  constructor(config: GoogleProviderConfig) {
    super();
    this.model = config.model;
    this.defaultMaxTokens = config.maxTokens ?? 8192;
    this.client = new GoogleGenerativeAI(
      config.apiKey ?? process.env['GOOGLE_API_KEY'] ?? ''
    );
  }

  async complete(options: CompletionOptions): Promise<CompletionResult> {
    const logger = getLogger();
    const { systemInstruction, contents } = this.convertMessages(options.messages);

    logger.debug(
      { model: this.model, messageCount: contents.length },
      'Google AI completion request'
    );

    const genModel = this.client.getGenerativeModel({
      model: this.model,
      systemInstruction,
      generationConfig: this.buildGenerationConfig(options),
    });

    const result = await withRetry(
      () => genModel.generateContent({ contents }),
      'google'
    );
    const response = result.response;
    const text = response.text();

    return {
      content: text,
      finishReason: this.mapFinishReason(response.candidates?.[0]?.finishReason),
      usage: {
        inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
  }

  async completeWithTools(options: CompletionWithToolsOptions): Promise<CompletionWithToolsResult> {
    const logger = getLogger();
    const { systemInstruction, contents } = this.convertMessages(options.messages);

    logger.debug(
      { model: this.model, messageCount: contents.length, toolCount: options.tools?.length },
      'Google AI completion with tools request'
    );

    const tools = options.tools?.length
      ? [
          {
            functionDeclarations: options.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            })),
          },
        ]
      : undefined;

    const genModelParams: Record<string, unknown> = {
      model: this.model,
      systemInstruction,
      generationConfig: this.buildGenerationConfig(options),
    };
    if (tools) {
      genModelParams.tools = tools;
    }
    const genModel = this.client.getGenerativeModel(genModelParams as unknown as Parameters<typeof this.client.getGenerativeModel>[0]);

    const genResult = await withRetry(
      () => genModel.generateContent({ contents }),
      'google'
    );
    const genResponse = genResult.response;

    let toolsText = '';
    const toolCalls: ToolCall[] = [];

    for (const part of genResponse.candidates?.[0]?.content?.parts ?? []) {
      if ('text' in part && part.text) {
        toolsText += part.text;
      }
      if ('functionCall' in part && part.functionCall) {
        toolCalls.push({
          id: `call_${toolCalls.length}`,
          name: part.functionCall.name,
          input: (part.functionCall.args ?? {}) as Record<string, unknown>,
        });
      }
    }

    const toolsResult: CompletionWithToolsResult = {
      content: toolsText,
      finishReason: this.mapFinishReason(genResponse.candidates?.[0]?.finishReason),
      usage: {
        inputTokens: genResponse.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: genResponse.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
    if (toolCalls.length > 0) {
      toolsResult.toolCalls = toolCalls;
    }
    return toolsResult;
  }

  async continueWithToolResults(
    options: CompletionWithToolsOptions,
    toolCalls: ToolCall[],
    toolResults: ToolResult[]
  ): Promise<CompletionWithToolsResult> {
    const logger = getLogger();
    const { systemInstruction, contents } = this.convertMessages(options.messages);

    // Add the model's function call response
    const modelParts: Part[] = toolCalls.map((tc) => ({
      functionCall: {
        name: tc.name,
        args: tc.input,
      },
    }));

    contents.push({
      role: 'model',
      parts: modelParts,
    });

    // Add function results
    const functionResponseParts: Part[] = toolResults.map((tr) => ({
      functionResponse: {
        name: toolCalls.find((tc) => tc.id === tr.toolCallId)?.name ?? 'unknown',
        response: { result: tr.content },
      },
    }));

    contents.push({
      role: 'user',
      parts: functionResponseParts,
    });

    logger.debug(
      { model: this.model, messageCount: contents.length, toolResultCount: toolResults.length },
      'Google AI continue with tool results'
    );

    const tools = options.tools?.length
      ? [
          {
            functionDeclarations: options.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            })),
          },
        ]
      : undefined;

    const continueGenModelParams: Record<string, unknown> = {
      model: this.model,
      systemInstruction,
      generationConfig: this.buildGenerationConfig(options),
    };
    if (tools) {
      continueGenModelParams.tools = tools;
    }
    const continueGenModel = this.client.getGenerativeModel(continueGenModelParams as unknown as Parameters<typeof this.client.getGenerativeModel>[0]);

    const continueGenResult = await withRetry(
      () => continueGenModel.generateContent({ contents }),
      'google'
    );
    const continueResponse = continueGenResult.response;

    let continueText = '';
    const newToolCalls: ToolCall[] = [];

    for (const part of continueResponse.candidates?.[0]?.content?.parts ?? []) {
      if ('text' in part && part.text) {
        continueText += part.text;
      }
      if ('functionCall' in part && part.functionCall) {
        newToolCalls.push({
          id: `call_${newToolCalls.length}`,
          name: part.functionCall.name,
          input: (part.functionCall.args ?? {}) as Record<string, unknown>,
        });
      }
    }

    const continueResult: CompletionWithToolsResult = {
      content: continueText,
      finishReason: this.mapFinishReason(continueResponse.candidates?.[0]?.finishReason),
      usage: {
        inputTokens: continueResponse.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: continueResponse.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
    if (newToolCalls.length > 0) {
      continueResult.toolCalls = newToolCalls;
    }
    return continueResult;
  }

  private convertMessages(messages: Message[]): {
    systemInstruction: string;
    contents: Content[];
  } {
    const systemMessages = messages.filter((m) => m.role === 'system');
    const otherMessages = messages.filter((m) => m.role !== 'system');

    const contents: Content[] = otherMessages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: getTextContent(m.content) }],
    }));

    return {
      systemInstruction: systemMessages.map((m) => getTextContent(m.content)).join('\n\n'),
      contents,
    };
  }

  private buildGenerationConfig(options: CompletionOptions): Record<string, unknown> {
    const config: Record<string, unknown> = {
      maxOutputTokens: options.maxTokens ?? this.defaultMaxTokens,
      temperature: options.temperature ?? 1,
      // Disable Gemini 2.5 Flash thinking — thinking tokens count toward maxOutputTokens,
      // causing nearly all the budget to be consumed internally, leaving only scraps for
      // visible output (e.g. "Ah, John," instead of a full message).
      thinkingConfig: { thinkingBudget: 0 },
    };
    if (options.stopSequences) {
      config.stopSequences = options.stopSequences;
    }
    return config;
  }

  private mapFinishReason(reason: string | undefined): CompletionResult['finishReason'] {
    switch (reason) {
      case 'STOP':
        return 'stop';
      case 'MAX_TOKENS':
        return 'length';
      case 'SAFETY':
        return 'content_filter';
      default:
        return 'stop';
    }
  }
}

/**
 * Create a Google AI provider
 */
export function createGoogleProvider(config: GoogleProviderConfig): GoogleProvider {
  return new GoogleProvider(config);
}
