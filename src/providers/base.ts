/**
 * Base provider interface for LLM integrations
 */

export type StreamCallback = (chunk: string) => void;

export interface TextContentBlock {
  type: 'text';
  text: string;
}

export interface ImageContentBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
    data: string;
  };
}

export type ContentBlock = TextContentBlock | ImageContentBlock;

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface CompletionOptions {
  messages: Message[];
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  /** Enable prompt caching for system prompt and tools (reduces cost by 90% on cache hits) */
  enableCaching?: boolean;
}

export interface CompletionResult {
  content: string;
  finishReason: 'stop' | 'length' | 'content_filter' | 'tool_use' | 'error';
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
}

export interface CompletionWithToolsOptions extends CompletionOptions {
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'none' | { type: 'tool'; name: string };
}

export interface CompletionWithToolsResult extends CompletionResult {
  toolCalls?: ToolCall[];
}

export interface Provider {
  readonly name: string;
  readonly model: string;

  /**
   * Generate a completion
   */
  complete(options: CompletionOptions): Promise<CompletionResult>;

  /**
   * Generate a completion with streaming
   */
  completeStream?(
    options: CompletionOptions,
    onChunk: StreamCallback
  ): Promise<CompletionResult>;

  /**
   * Generate a completion with tool use support
   */
  completeWithTools(options: CompletionWithToolsOptions): Promise<CompletionWithToolsResult>;

  /**
   * Generate a completion with tool use support and streaming
   */
  completeWithToolsStream?(
    options: CompletionWithToolsOptions,
    onChunk: StreamCallback
  ): Promise<CompletionWithToolsResult>;

  /**
   * Continue a conversation after tool results
   */
  continueWithToolResults(
    options: CompletionWithToolsOptions,
    toolCalls: ToolCall[],
    toolResults: ToolResult[]
  ): Promise<CompletionWithToolsResult>;

  /**
   * Continue a conversation after tool results with streaming
   */
  continueWithToolResultsStream?(
    options: CompletionWithToolsOptions,
    toolCalls: ToolCall[],
    toolResults: ToolResult[],
    onChunk: StreamCallback
  ): Promise<CompletionWithToolsResult>;
}

export abstract class BaseProvider implements Provider {
  abstract readonly name: string;
  abstract readonly model: string;

  abstract complete(options: CompletionOptions): Promise<CompletionResult>;
  abstract completeWithTools(options: CompletionWithToolsOptions): Promise<CompletionWithToolsResult>;
  abstract continueWithToolResults(
    options: CompletionWithToolsOptions,
    toolCalls: ToolCall[],
    toolResults: ToolResult[]
  ): Promise<CompletionWithToolsResult>;
}
