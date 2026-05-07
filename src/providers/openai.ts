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
  type ModelInfo,
  type ToolCall,
  type ToolResult,
  type ContentBlock,
  type Message,
  type StreamCallback,
} from './base.js';
import { getLogger } from '../utils/logger.js';
import { withRetry } from './retry.js';

/**
 * findings.md P2:788 — assemble the OpenAI SDK RequestOptions slice
 * from CompletionOptions. Empty object means "use SDK defaults".
 *
 * findings.md P2:183 — when the caller doesn't set `timeoutMs`, fall
 * back to the provider-level `requestTimeoutMs` from ProviderConfig so
 * operators can cap OpenAI calls per-character without touching every
 * call site.
 */
function requestOptions(
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

// Helper to extract text from message content (drops images — used for
// system/assistant/tool roles where OpenAI's schema doesn't accept images).
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
 * findings.md P2:950 — the prior wrapper piped every role through
 * getTextContent, which silently dropped ImageContentBlock entries. GPT-4o
 * and later support vision via `image_url` message parts, but our provider
 * returned completions based solely on the text caption while pretending to
 * see the image. This helper converts user-role messages into OpenAI's
 * multipart content array (text + image_url parts); non-user roles stay
 * on the text-only path since OpenAI's schema rejects images there.
 */
function toOpenAIUserContent(
  content: string | ContentBlock[],
): string | OpenAI.ChatCompletionContentPart[] {
  if (typeof content === 'string') {
    return content;
  }
  // Text-only blocks are joined into a single string — the OpenAI SDK
  // accepts either shape, and the string shape keeps callers that inspect
  // `messages[i].content` against existing assertions happy. Images flip
  // the message to the multipart form.
  const hasImage = content.some((b) => b.type === 'image');
  if (!hasImage) {
    return getTextContent(content);
  }
  const parts: OpenAI.ChatCompletionContentPart[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text });
    } else {
      // findings.md P2:798 — ImageContentBlock.source is a
      // discriminated union of base64 and url. OpenAI's image_url.url
      // field accepts either a real https:// URL or a data:... base64
      // URI, so both variants map to the same shape.
      const url =
        block.source.type === 'url'
          ? block.source.url
          : `data:${block.source.media_type};base64,${block.source.data}`;
      parts.push({
        type: 'image_url',
        image_url: { url },
      });
    }
  }
  return parts;
}

function toOpenAIMessage(m: Message): OpenAI.ChatCompletionMessageParam {
  if (m.role === 'user') {
    return { role: 'user', content: toOpenAIUserContent(m.content) };
  }
  if (m.role === 'system') {
    return { role: 'system', content: getTextContent(m.content) };
  }
  return { role: 'assistant', content: getTextContent(m.content) };
}

/**
 * Parse a tool call's JSON arguments. findings.md P2:970 — the prior
 * `JSON.parse(...)` was unguarded, so a single malformed-JSON tool call
 * (most commonly caused by truncation at max_tokens) crashed the whole
 * completion with a generic SyntaxError. We now degrade to empty input
 * and log the raw arguments so the caller can see what the model emitted.
 */
function parseToolArguments(
  rawArgs: string,
  toolCallId: string,
  toolName: string,
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawArgs) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch (err) {
    getLogger().warn(
      { toolCallId, toolName, rawArgs, error: err instanceof Error ? err.message : String(err) },
      'OpenAI returned malformed JSON for tool call arguments — degrading to {}',
    );
    return {};
  }
}

export interface OpenAIProviderConfig {
  apiKey?: string;
  model: string;
  maxTokens?: number;
  baseURL?: string;
  /**
   * findings.md P2:183 — provider-level defaults. Per-call
   * `CompletionOptions.temperature` / `timeoutMs` override these when set.
   */
  temperature?: number;
  requestTimeoutMs?: number;
}

/**
 * findings.md P2:960 — OpenAI deprecated `max_tokens` for Chat Completions
 * in 2024. For reasoning models (o1 / o3 / o4 / gpt-5 family) the old
 * parameter is REJECTED with a 400 saying to use `max_completion_tokens`.
 * Detect reasoning models by name and pick the right parameter; legacy
 * GPT-4 family keeps `max_tokens` so existing callers don't silently
 * change behavior.
 */
function isReasoningModel(model: string): boolean {
  return /^(o\d|gpt-5)/i.test(model);
}

function applyMaxTokens(
  params: Record<string, unknown>,
  model: string,
  maxTokens: number,
): void {
  if (isReasoningModel(model)) {
    params['max_completion_tokens'] = maxTokens;
  } else {
    params['max_tokens'] = maxTokens;
  }
}

export class OpenAIProvider extends BaseProvider {
  readonly name = 'openai';
  readonly model: string;
  readonly supportsStreaming = true;
  private client: OpenAI;
  private defaultMaxTokens: number;
  private defaultTemperature: number;
  private defaultRequestTimeoutMs: number | undefined;

  constructor(config: OpenAIProviderConfig) {
    super();
    this.model = config.model;
    this.defaultMaxTokens = config.maxTokens ?? 8192;
    this.defaultTemperature = config.temperature ?? 1;
    this.defaultRequestTimeoutMs = config.requestTimeoutMs;
    this.client = new OpenAI({
      apiKey: config.apiKey ?? process.env['OPENAI_API_KEY'],
      baseURL: config.baseURL,
    });
  }

  async complete(options: CompletionOptions): Promise<CompletionResult> {
    await this.assertBudget();
    const logger = getLogger();

    logger.debug(
      { model: this.model, messageCount: options.messages.length },
      'OpenAI completion request'
    );

    const params: OpenAI.ChatCompletionCreateParamsNonStreaming = {
      model: this.model,
      temperature: options.temperature ?? this.defaultTemperature,
      messages: options.messages.map(toOpenAIMessage),
    };
    applyMaxTokens(params as unknown as Record<string, unknown>, this.model, options.maxTokens ?? this.defaultMaxTokens);
    if (options.stopSequences) {
      params.stop = options.stopSequences;
    }
    const response = await withRetry(
      () => this.client.chat.completions.create(params, requestOptions(options, this.defaultRequestTimeoutMs)),
      'openai',
      retryConfigFor(options),
    );

    const choice = response.choices[0];
    // findings.md P2:980 — GPT-4o models emit a `refusal` string when the
    // safety filter blocks a response. The prior wrapper never read it, so
    // callers saw empty content + finishReason 'stop' with no signal that
    // the model refused. Surface the refusal text as content and map the
    // finish reason to 'content_filter' so upstream handles it the same
    // way as an Anthropic refusal stop_reason.
    const refusal = choice?.message?.refusal ?? null;
    const content = refusal ?? choice?.message?.content ?? '';

    return {
      content,
      finishReason: refusal ? 'content_filter' : this.mapFinishReason(choice?.finish_reason),
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
    };
  }

  /**
   * findings.md P2:990 — OpenAI previously had no streaming methods, so
   * callers opting into streaming got a silent downgrade to buffered
   * complete() via the fallback proxy. Implement the SDK's native
   * `stream: true` path so progressive-chat UIs get real deltas.
   */
  async completeStream(
    options: CompletionOptions,
    onChunk: StreamCallback,
  ): Promise<CompletionResult> {
    await this.assertBudget();
    const logger = getLogger();

    logger.debug(
      { model: this.model, messageCount: options.messages.length },
      'OpenAI streaming completion request'
    );

    const params: OpenAI.ChatCompletionCreateParamsStreaming = {
      model: this.model,
      temperature: options.temperature ?? this.defaultTemperature,
      messages: options.messages.map(toOpenAIMessage),
      stream: true,
      // stream_options.include_usage is required to get token counts on
      // the terminal chunk; without it usage is always {0, 0}.
      stream_options: { include_usage: true },
    };
    applyMaxTokens(params as unknown as Record<string, unknown>, this.model, options.maxTokens ?? this.defaultMaxTokens);
    if (options.stopSequences) {
      params.stop = options.stopSequences;
    }

    return withRetry(async () => {
      const stream = await this.client.chat.completions.create(params, requestOptions(options, this.defaultRequestTimeoutMs));

      let content = '';
      let refusal: string | null = null;
      let finishReason: CompletionResult['finishReason'] = 'stop';
      let inputTokens = 0;
      let outputTokens = 0;

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        const delta = choice?.delta;
        if (delta?.content) {
          content += delta.content;
          onChunk(delta.content);
        }
        if (delta?.refusal) {
          refusal = (refusal ?? '') + delta.refusal;
        }
        if (choice?.finish_reason) {
          finishReason = this.mapFinishReason(choice.finish_reason);
        }
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens;
          outputTokens = chunk.usage.completion_tokens;
        }
      }

      return {
        content: refusal ?? content,
        finishReason: refusal ? 'content_filter' : finishReason,
        usage: { inputTokens, outputTokens },
      };
    }, 'openai', retryConfigFor(options));
  }

  async completeWithTools(options: CompletionWithToolsOptions): Promise<CompletionWithToolsResult> {
    await this.assertBudget();
    const logger = getLogger();

    logger.debug(
      { model: this.model, messageCount: options.messages.length, toolCount: options.tools?.length },
      'OpenAI completion with tools request'
    );

    const toolsParams: OpenAI.ChatCompletionCreateParamsNonStreaming = {
      model: this.model,
      temperature: options.temperature ?? this.defaultTemperature,
      messages: options.messages.map(toOpenAIMessage),
    };
    applyMaxTokens(toolsParams as unknown as Record<string, unknown>, this.model, options.maxTokens ?? this.defaultMaxTokens);

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
      () => this.client.chat.completions.create(toolsParams, requestOptions(options, this.defaultRequestTimeoutMs)),
      'openai',
      retryConfigFor(options),
    );

    const choice = toolsResponse.choices[0];
    // findings.md P2:980 — mirror the refusal handling from complete();
    // safety filtering can happen on tool-call paths too.
    const refusal = choice?.message?.refusal ?? null;
    const content = refusal ?? choice?.message?.content ?? '';

    const toolCalls: ToolCall[] = (choice?.message?.tool_calls ?? []).map((tc: OpenAI.ChatCompletionMessageToolCall) => ({
      id: tc.id,
      name: tc.function.name,
      input: parseToolArguments(tc.function.arguments, tc.id, tc.function.name),
    }));

    const result: CompletionWithToolsResult = {
      content,
      finishReason: refusal ? 'content_filter' : this.mapFinishReason(choice?.finish_reason),
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

  /**
   * findings.md P2:990 — streaming tool-call path. OpenAI chunks tool
   * calls indexed by position with partial `id`, `name`, and
   * `arguments` fields that have to be reassembled across chunks.
   */
  async completeWithToolsStream(
    options: CompletionWithToolsOptions,
    onChunk: StreamCallback,
  ): Promise<CompletionWithToolsResult> {
    await this.assertBudget();
    const logger = getLogger();

    logger.debug(
      { model: this.model, messageCount: options.messages.length, toolCount: options.tools?.length },
      'OpenAI streaming completion with tools request'
    );

    const toolsParams: OpenAI.ChatCompletionCreateParamsStreaming = {
      model: this.model,
      temperature: options.temperature ?? this.defaultTemperature,
      messages: options.messages.map(toOpenAIMessage),
      stream: true,
      stream_options: { include_usage: true },
    };
    applyMaxTokens(toolsParams as unknown as Record<string, unknown>, this.model, options.maxTokens ?? this.defaultMaxTokens);

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

    return withRetry(async () => {
      const stream = await this.client.chat.completions.create(toolsParams, requestOptions(options, this.defaultRequestTimeoutMs));

      let content = '';
      let refusal: string | null = null;
      let finishReason: CompletionResult['finishReason'] = 'stop';
      let inputTokens = 0;
      let outputTokens = 0;
      // Tool-call deltas arrive indexed; accumulate id/name/args per slot.
      const toolAccum = new Map<number, { id: string; name: string; args: string }>();

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        const delta = choice?.delta;
        if (delta?.content) {
          content += delta.content;
          onChunk(delta.content);
        }
        if (delta?.refusal) {
          refusal = (refusal ?? '') + delta.refusal;
        }
        for (const tc of delta?.tool_calls ?? []) {
          const slot = toolAccum.get(tc.index) ?? { id: '', name: '', args: '' };
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name = tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
          toolAccum.set(tc.index, slot);
        }
        if (choice?.finish_reason) {
          finishReason = this.mapFinishReason(choice.finish_reason);
        }
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens;
          outputTokens = chunk.usage.completion_tokens;
        }
      }

      const toolCalls: ToolCall[] = [...toolAccum.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, slot]) => ({
          id: slot.id,
          name: slot.name,
          input: parseToolArguments(slot.args, slot.id, slot.name),
        }));

      const result: CompletionWithToolsResult = {
        content: refusal ?? content,
        finishReason: refusal ? 'content_filter' : finishReason,
        usage: { inputTokens, outputTokens },
      };
      if (toolCalls.length > 0) {
        result.toolCalls = toolCalls;
      }
      return result;
    }, 'openai', retryConfigFor(options));
  }

  async continueWithToolResults(
    options: CompletionWithToolsOptions,
    toolCalls: ToolCall[],
    toolResults: ToolResult[],
    assistantText?: string
  ): Promise<CompletionWithToolsResult> {
    await this.assertBudget();
    const logger = getLogger();

    // findings.md P2:930 — preserve mid-turn assistant narration. OpenAI's
    // ChatCompletionAssistantMessageParam accepts a string `content`
    // alongside `tool_calls`; passing null silently drops the text the
    // model emitted before the tool_call sequence.
    const assistantMessage: OpenAI.ChatCompletionAssistantMessageParam = {
      role: 'assistant' as const,
      content: assistantText && assistantText.length > 0 ? assistantText : null,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.input),
        },
      })),
    };

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      ...options.messages.map(toOpenAIMessage),
      assistantMessage,
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
      temperature: options.temperature ?? this.defaultTemperature,
      messages,
    };
    applyMaxTokens(continueParams as unknown as Record<string, unknown>, this.model, options.maxTokens ?? this.defaultMaxTokens);

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
      () => this.client.chat.completions.create(continueParams, requestOptions(options, this.defaultRequestTimeoutMs)),
      'openai',
      retryConfigFor(options),
    );

    const continueChoice = continueResponse.choices[0];
    // findings.md P2:980 — refusal can land on continuation turns too
    // (model decides mid-chain to refuse).
    const continueRefusal = continueChoice?.message?.refusal ?? null;
    const continueContent = continueRefusal ?? continueChoice?.message?.content ?? '';

    const newToolCalls: ToolCall[] = (continueChoice?.message?.tool_calls ?? []).map((tc: OpenAI.ChatCompletionMessageToolCall) => ({
      id: tc.id,
      name: tc.function.name,
      input: parseToolArguments(tc.function.arguments, tc.id, tc.function.name),
    }));

    const continueResult: CompletionWithToolsResult = {
      content: continueContent,
      finishReason: continueRefusal ? 'content_filter' : this.mapFinishReason(continueChoice?.finish_reason),
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

  /**
   * findings.md P2:990 — streaming continuation after tool results.
   * Builds the same assistant+tool-result message shape as
   * continueWithToolResults but runs the stream loop from
   * completeWithToolsStream so deltas (text and any new tool calls)
   * are forwarded to the caller.
   */
  async continueWithToolResultsStream(
    options: CompletionWithToolsOptions,
    toolCalls: ToolCall[],
    toolResults: ToolResult[],
    onChunk: StreamCallback,
    assistantText?: string,
  ): Promise<CompletionWithToolsResult> {
    await this.assertBudget();
    const logger = getLogger();

    const assistantMessage: OpenAI.ChatCompletionAssistantMessageParam = {
      role: 'assistant' as const,
      content: assistantText && assistantText.length > 0 ? assistantText : null,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.input),
        },
      })),
    };

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      ...options.messages.map(toOpenAIMessage),
      assistantMessage,
      ...toolResults.map((tr) => ({
        role: 'tool' as const,
        tool_call_id: tr.toolCallId,
        content: tr.content,
      })),
    ];

    logger.debug(
      { model: this.model, messageCount: messages.length, toolResultCount: toolResults.length },
      'OpenAI streaming continue with tool results'
    );

    const continueParams: OpenAI.ChatCompletionCreateParamsStreaming = {
      model: this.model,
      temperature: options.temperature ?? this.defaultTemperature,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    applyMaxTokens(continueParams as unknown as Record<string, unknown>, this.model, options.maxTokens ?? this.defaultMaxTokens);

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

    return withRetry(async () => {
      const stream = await this.client.chat.completions.create(continueParams, requestOptions(options, this.defaultRequestTimeoutMs));

      let content = '';
      let refusal: string | null = null;
      let finishReason: CompletionResult['finishReason'] = 'stop';
      let inputTokens = 0;
      let outputTokens = 0;
      const toolAccum = new Map<number, { id: string; name: string; args: string }>();

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        const delta = choice?.delta;
        if (delta?.content) {
          content += delta.content;
          onChunk(delta.content);
        }
        if (delta?.refusal) {
          refusal = (refusal ?? '') + delta.refusal;
        }
        for (const tc of delta?.tool_calls ?? []) {
          const slot = toolAccum.get(tc.index) ?? { id: '', name: '', args: '' };
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name = tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
          toolAccum.set(tc.index, slot);
        }
        if (choice?.finish_reason) {
          finishReason = this.mapFinishReason(choice.finish_reason);
        }
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens;
          outputTokens = chunk.usage.completion_tokens;
        }
      }

      const newToolCalls: ToolCall[] = [...toolAccum.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, slot]) => ({
          id: slot.id,
          name: slot.name,
          input: parseToolArguments(slot.args, slot.id, slot.name),
        }));

      const result: CompletionWithToolsResult = {
        content: refusal ?? content,
        finishReason: refusal ? 'content_filter' : finishReason,
        usage: { inputTokens, outputTokens },
      };
      if (newToolCalls.length > 0) {
        result.toolCalls = newToolCalls;
      }
      return result;
    }, 'openai', retryConfigFor(options));
  }

  private mapFinishReason(
    reason: string | null | undefined
  ): CompletionResult['finishReason'] {
    // findings.md P2:940 — treat unrecognized finish_reason as 'unknown'
    // instead of silently collapsing it to 'stop'. null/undefined still
    // fall through to 'stop' because the API contract says the field is
    // populated on terminal responses; a missing value is more "no
    // signal returned" than "novel reason we don't understand".
    switch (reason) {
      case 'stop':
        return 'stop';
      case 'length':
        return 'length';
      case 'content_filter':
        return 'content_filter';
      case 'tool_calls':
      case 'function_call':
        return 'tool_use';
      case null:
      case undefined:
        return 'stop';
      default:
        return 'unknown';
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

  /**
   * findings.md P2:828 — per-model info table. Reasoning-model families
   * (o1/o3/o4/gpt-5) have large contexts and use max_completion_tokens
   * internally, but the surfaced `maxOutputTokens` is still the output
   * cap callers should size completions against. Vision support tracks
   * the documented capability per family.
   */
  getModelInfo(): ModelInfo {
    const model = this.model;
    // gpt-5 family: 400k input / 128k output, vision.
    if (/^gpt-5/i.test(model)) {
      return {
        contextWindow: 400_000,
        maxOutputTokens: 128_000,
        supportsVision: true,
        supportsStreaming: true,
        supportsTools: true,
      };
    }
    // o-series reasoning models: 200k context, 100k output, no vision
    // on o1-mini / o3-mini.
    if (/^o\d/i.test(model)) {
      const hasVision = /^o1(?!-mini)|^o3(?!-mini)|^o4/i.test(model);
      return {
        contextWindow: 200_000,
        maxOutputTokens: 100_000,
        supportsVision: hasVision,
        supportsStreaming: true,
        supportsTools: true,
      };
    }
    // gpt-4o family: 128k context, 16384 output, vision.
    if (/^gpt-4o/i.test(model)) {
      return {
        contextWindow: 128_000,
        maxOutputTokens: 16_384,
        supportsVision: true,
        supportsStreaming: true,
        supportsTools: true,
      };
    }
    // gpt-4-turbo: 128k context, 4096 output, vision.
    if (/^gpt-4-turbo/i.test(model) || /^gpt-4-\d{4}-preview/i.test(model) || /^gpt-4-vision/i.test(model)) {
      return {
        contextWindow: 128_000,
        maxOutputTokens: 4096,
        supportsVision: true,
        supportsStreaming: true,
        supportsTools: true,
      };
    }
    // gpt-4 (legacy): 8k context, 4096 output, no vision.
    if (/^gpt-4/i.test(model)) {
      return {
        contextWindow: 8192,
        maxOutputTokens: 4096,
        supportsVision: false,
        supportsStreaming: true,
        supportsTools: true,
      };
    }
    // gpt-3.5-turbo and unknown: 16k context, 4096 output, no vision.
    return {
      contextWindow: 16_385,
      maxOutputTokens: 4096,
      supportsVision: false,
      supportsStreaming: true,
      supportsTools: true,
    };
  }
}

/**
 * Create an OpenAI provider
 */
export function createOpenAIProvider(config: OpenAIProviderConfig): OpenAIProvider {
  return new OpenAIProvider(config);
}
