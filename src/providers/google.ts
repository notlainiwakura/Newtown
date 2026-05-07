/**
 * Google AI (Gemini) provider implementation
 */

import { createHash } from 'node:crypto';
import {
  FunctionCallingMode,
  GoogleGenerativeAI,
  type Content,
  type Part,
  type ToolConfig,
} from '@google/generative-ai';
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
  type ContentBlock,
} from './base.js';
import { getLogger } from '../utils/logger.js';
import { withRetry } from './retry.js';

/**
 * findings.md P2:788 — assemble the Gemini SDK SingleRequestOptions
 * slice from CompletionOptions. Undefined timeout means "SDK default".
 *
 * findings.md P2:183 — when the caller doesn't set `timeoutMs`, fall
 * back to the provider-level `requestTimeoutMs` from ProviderConfig.
 */
function singleRequestOptions(
  options: CompletionOptions,
  defaultTimeoutMs?: number,
): {
  signal?: AbortSignal;
  timeout?: number;
} {
  const out: { signal?: AbortSignal; timeout?: number } = {};
  if (options.abortSignal) out.signal = options.abortSignal;
  const timeout = options.timeoutMs ?? defaultTimeoutMs;
  if (timeout !== undefined) out.timeout = timeout;
  return out;
}

function retryConfigFor(options: CompletionOptions): { abortSignal?: AbortSignal } {
  return options.abortSignal ? { abortSignal: options.abortSignal } : {};
}

/**
 * findings.md P2:1030 — the prior continueWithToolResults looked up each
 * toolResult's toolCallId in the pending toolCalls array and, on miss,
 * defaulted the function name to 'unknown'. Gemini then either rejected
 * the request or hallucinated about a function it never called, leaving
 * the caller with garbage output and no error. Throw this instead so the
 * mis-wired state surfaces at the caller boundary.
 */
export class MismatchedToolCallIdError extends Error {
  readonly toolCallId: string;
  readonly knownIds: string[];

  constructor(toolCallId: string, knownIds: string[]) {
    super(
      `toolResult.toolCallId "${toolCallId}" does not match any pending tool call (known: ${knownIds.join(', ') || '<none>'})`,
    );
    this.name = 'MismatchedToolCallIdError';
    this.toolCallId = toolCallId;
    this.knownIds = knownIds;
  }
}

/**
 * findings.md P2:1010 — Gemini's function-calling API doesn't emit stable
 * IDs, so the prior wrapper used positional `call_${index}`. Any flow that
 * persisted tool calls and resumed later (retry after crash, cross-session
 * replay) cross-wired because `call_0` meant different calls in different
 * sessions. Hash the function name + canonicalized args so identity is
 * stable across process restarts and collision-free for distinct calls.
 */
function synthesizeToolCallId(name: string, args: Record<string, unknown>): string {
  const hash = createHash('sha256')
    .update(name)
    .update('\0')
    .update(JSON.stringify(args))
    .digest('hex');
  return `call_${hash.slice(0, 16)}`;
}

/**
 * findings.md P2:1020 — Gemini supports toolConfig.functionCallingConfig
 * with mode AUTO | ANY | NONE (and allowedFunctionNames for forcing a
 * specific tool). The prior wrapper never read options.toolChoice, so
 * `'none'` didn't disable tools and `{name: 'x'}` didn't force it — every
 * request fell back to AUTO regardless of caller intent.
 */
function mapToolChoice(
  choice: CompletionWithToolsOptions['toolChoice'],
): ToolConfig | undefined {
  if (!choice) return undefined;
  if (choice === 'auto') {
    return { functionCallingConfig: { mode: FunctionCallingMode.AUTO } };
  }
  if (choice === 'none') {
    return { functionCallingConfig: { mode: FunctionCallingMode.NONE } };
  }
  // { type: 'tool', name } — ANY + allowedFunctionNames forces Gemini to
  // call that specific function.
  return {
    functionCallingConfig: {
      mode: FunctionCallingMode.ANY,
      allowedFunctionNames: [choice.name],
    },
  };
}

// Helper to extract text from message content (drops images — used for
// system instructions where Gemini's schema is text-only).
function getTextContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') {
    return content;
  }
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join(' ');
}

/**
 * findings.md P2:950 — the prior convertMessages piped every message
 * through getTextContent, silently dropping ImageContentBlock entries so
 * Gemini's vision models ("gemini-1.5-pro", "gemini-2.0-flash" etc.)
 * responded based on the text caption while the image was lost in transit.
 * Convert each block to Gemini's Part shape: text blocks stay as `{text}`;
 * image blocks become `{inlineData: {mimeType, data}}` using the base64
 * data we already hold.
 */
function toGeminiParts(content: string | ContentBlock[]): Part[] {
  if (typeof content === 'string') {
    return [{ text: content }];
  }
  // Text-only blocks collapse into a single `{text}` part — keeps existing
  // callers that inspect `parts[0].text` against their assertions happy.
  // Images flip the message to a multi-part form mixing text and inlineData.
  const hasImage = content.some((b) => b.type === 'image');
  if (!hasImage) {
    return [{ text: getTextContent(content) }];
  }
  const parts: Part[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      parts.push({ text: block.text });
    } else if (block.source.type === 'url') {
      // findings.md P2:798 — Gemini accepts URL-hosted media via
      // fileData. media_type is required on fileData; fall back to
      // 'image/jpeg' when the caller didn't specify one (Gemini is
      // usually lenient about minor mime mismatches for images).
      parts.push({
        fileData: {
          mimeType: block.source.media_type ?? 'image/jpeg',
          fileUri: block.source.url,
        },
      });
    } else {
      parts.push({
        inlineData: {
          mimeType: block.source.media_type,
          data: block.source.data,
        },
      });
    }
  }
  return parts;
}

export interface GoogleProviderConfig {
  apiKey?: string;
  model: string;
  maxTokens?: number;
  /**
   * Gemini 2.5 thinking budget (token cap for internal reasoning).
   * - `undefined` (default): let Gemini decide per model. 2.5 Pro reasons freely, older
   *   Gemini 1.5/2.0 ignore the field.
   * - `0`: disable thinking. Use this for 2.5 Flash where thinking tokens otherwise
   *   consume the output budget and truncate visible output.
   * - positive integer: cap internal thinking tokens.
   */
  thinkingBudget?: number;
  /**
   * findings.md P2:183 — provider-level defaults. Per-call
   * `CompletionOptions.temperature` / `timeoutMs` override these when set.
   */
  temperature?: number;
  requestTimeoutMs?: number;
}

export class GoogleProvider extends BaseProvider {
  readonly name = 'google';
  readonly model: string;
  // findings.md P2:818 — Google has no streaming impl today; callers
  // route buffered via `complete*` when this flag is false.
  readonly supportsStreaming = false;
  private client: GoogleGenerativeAI;
  private defaultMaxTokens: number;
  private defaultTemperature: number;
  private defaultRequestTimeoutMs: number | undefined;
  private thinkingBudget: number | undefined;

  constructor(config: GoogleProviderConfig) {
    super();
    this.model = config.model;
    this.defaultMaxTokens = config.maxTokens ?? 8192;
    this.defaultTemperature = config.temperature ?? 1;
    this.defaultRequestTimeoutMs = config.requestTimeoutMs;
    this.thinkingBudget = config.thinkingBudget;
    this.client = new GoogleGenerativeAI(
      config.apiKey ?? process.env['GOOGLE_API_KEY'] ?? ''
    );
  }

  async complete(options: CompletionOptions): Promise<CompletionResult> {
    await this.assertBudget();
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
      () => genModel.generateContent({ contents }, singleRequestOptions(options, this.defaultRequestTimeoutMs)),
      'google',
      retryConfigFor(options),
    );
    const response = result.response;

    // findings.md P2:1000 — response.text() throws a bare Error when the
    // candidate finish reason is SAFETY / RECITATION / BLOCKLIST /
    // PROHIBITED_CONTENT. Iterate parts directly (same pattern as
    // completeWithTools) so a blocked response becomes empty content with a
    // mapped finishReason, not an uncaught throw that kills the completion.
    let text = '';
    for (const part of response.candidates?.[0]?.content?.parts ?? []) {
      if ('text' in part && part.text) {
        text += part.text;
      }
    }

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
    await this.assertBudget();
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

    const toolConfig = mapToolChoice(options.toolChoice);
    const genRequest: Parameters<typeof genModel.generateContent>[0] = toolConfig
      ? { contents, toolConfig }
      : { contents };
    const genResult = await withRetry(
      () => genModel.generateContent(genRequest, singleRequestOptions(options, this.defaultRequestTimeoutMs)),
      'google',
      retryConfigFor(options),
    );
    const genResponse = genResult.response;

    let toolsText = '';
    const toolCalls: ToolCall[] = [];

    for (const part of genResponse.candidates?.[0]?.content?.parts ?? []) {
      if ('text' in part && part.text) {
        toolsText += part.text;
      }
      if ('functionCall' in part && part.functionCall) {
        const input = (part.functionCall.args ?? {}) as Record<string, unknown>;
        toolCalls.push({
          id: synthesizeToolCallId(part.functionCall.name, input),
          name: part.functionCall.name,
          input,
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
    toolResults: ToolResult[],
    assistantText?: string
  ): Promise<CompletionWithToolsResult> {
    await this.assertBudget();
    const logger = getLogger();
    const { systemInstruction, contents } = this.convertMessages(options.messages);

    // findings.md P2:930 — prepend the prior turn's text to preserve
    // mid-turn narration. Gemini model messages accept mixed text +
    // functionCall parts; skipping an empty text keeps the part list
    // valid (empty text parts are rejected).
    const modelParts: Part[] = [];
    if (assistantText && assistantText.length > 0) {
      modelParts.push({ text: assistantText });
    }
    for (const tc of toolCalls) {
      modelParts.push({
        functionCall: {
          name: tc.name,
          args: tc.input,
        },
      });
    }

    contents.push({
      role: 'model',
      parts: modelParts,
    });

    // Add function results
    const functionResponseParts: Part[] = toolResults.map((tr) => {
      const match = toolCalls.find((tc) => tc.id === tr.toolCallId);
      if (!match) {
        // findings.md P2:1030 — surface mis-wired IDs instead of sending
        // Gemini a functionResponse with name 'unknown'.
        throw new MismatchedToolCallIdError(
          tr.toolCallId,
          toolCalls.map((tc) => tc.id),
        );
      }
      return {
        functionResponse: {
          name: match.name,
          response: { result: tr.content },
        },
      };
    });

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

    const continueToolConfig = mapToolChoice(options.toolChoice);
    const continueRequest: Parameters<typeof continueGenModel.generateContent>[0] = continueToolConfig
      ? { contents, toolConfig: continueToolConfig }
      : { contents };
    const continueGenResult = await withRetry(
      () => continueGenModel.generateContent(continueRequest, singleRequestOptions(options, this.defaultRequestTimeoutMs)),
      'google',
      retryConfigFor(options),
    );
    const continueResponse = continueGenResult.response;

    let continueText = '';
    const newToolCalls: ToolCall[] = [];

    for (const part of continueResponse.candidates?.[0]?.content?.parts ?? []) {
      if ('text' in part && part.text) {
        continueText += part.text;
      }
      if ('functionCall' in part && part.functionCall) {
        const input = (part.functionCall.args ?? {}) as Record<string, unknown>;
        newToolCalls.push({
          id: synthesizeToolCallId(part.functionCall.name, input),
          name: part.functionCall.name,
          input,
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
      parts: toGeminiParts(m.content),
    }));

    return {
      systemInstruction: systemMessages.map((m) => getTextContent(m.content)).join('\n\n'),
      contents,
    };
  }

  private buildGenerationConfig(options: CompletionOptions): Record<string, unknown> {
    const config: Record<string, unknown> = {
      maxOutputTokens: options.maxTokens ?? this.defaultMaxTokens,
      temperature: options.temperature ?? this.defaultTemperature,
    };
    // Only emit thinkingConfig when explicitly configured. Forcing thinkingBudget: 0
    // on every model blocks Gemini 2.5 Pro reasoning (the whole point of that model)
    // and may error on older Gemini 1.5/2.0 that don't know the field. Callers that
    // need the 2.5 Flash workaround pass thinkingBudget: 0 via ProviderConfig.
    if (this.thinkingBudget !== undefined) {
      config.thinkingConfig = { thinkingBudget: this.thinkingBudget };
    }
    if (options.stopSequences) {
      config.stopSequences = options.stopSequences;
    }
    return config;
  }

  /**
   * findings.md P2:828 — per-model info table for Gemini. The 1.5+
   * lineup has large context windows (1M–2M) that materially change
   * context budgeting decisions — callers hardcoding 7k tokens for a
   * Gemini 2.5 Pro model leave 99.6% of the budget unused.
   */
  getModelInfo(): ModelInfo {
    const model = this.model;
    // Gemini 2.5 Pro: 2M context, 64k output, vision.
    if (/^gemini-2\.5-pro/i.test(model)) {
      return {
        contextWindow: 2_000_000,
        maxOutputTokens: 65_536,
        supportsVision: true,
        supportsStreaming: false,
        supportsTools: true,
      };
    }
    // Gemini 2.5 Flash / 2.0 Flash: 1M context, 8192 output, vision.
    if (/^gemini-2/i.test(model)) {
      return {
        contextWindow: 1_000_000,
        maxOutputTokens: 8192,
        supportsVision: true,
        supportsStreaming: false,
        supportsTools: true,
      };
    }
    // Gemini 1.5 Pro: 2M context, 8192 output, vision.
    if (/^gemini-1\.5-pro/i.test(model)) {
      return {
        contextWindow: 2_000_000,
        maxOutputTokens: 8192,
        supportsVision: true,
        supportsStreaming: false,
        supportsTools: true,
      };
    }
    // Gemini 1.5 Flash: 1M context, 8192 output, vision.
    if (/^gemini-1\.5-flash/i.test(model)) {
      return {
        contextWindow: 1_000_000,
        maxOutputTokens: 8192,
        supportsVision: true,
        supportsStreaming: false,
        supportsTools: true,
      };
    }
    // Gemini 1.0 Pro and unknown: 32k context, 2048 output, no vision
    // on text-only 1.0 variants. Conservative fallback.
    return {
      contextWindow: 32_768,
      maxOutputTokens: 2048,
      supportsVision: false,
      supportsStreaming: false,
      supportsTools: true,
    };
  }

  private mapFinishReason(reason: string | undefined): CompletionResult['finishReason'] {
    // findings.md P2:940 — treat unrecognized finishReason as 'unknown'
    // so future/deprecated Google enum members surface as "novel" to
    // callers instead of silently collapsing to 'stop'. undefined (no
    // candidates returned at all) stays 'stop' as the legacy default.
    switch (reason) {
      case 'STOP':
        return 'stop';
      case 'MAX_TOKENS':
        return 'length';
      case 'SAFETY':
      case 'RECITATION':
      case 'BLOCKLIST':
      case 'PROHIBITED_CONTENT':
      case 'SPII':
        return 'content_filter';
      case undefined:
        return 'stop';
      default:
        return 'unknown';
    }
  }
}

/**
 * Create a Google AI provider
 */
export function createGoogleProvider(config: GoogleProviderConfig): GoogleProvider {
  return new GoogleProvider(config);
}
