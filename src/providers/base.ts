/**
 * Base provider interface for LLM integrations
 */

import { enforceBudget } from './budget.js';

export type StreamCallback = (chunk: string) => void;

export interface TextContentBlock {
  type: 'text';
  text: string;
}

/**
 * findings.md P2:798 — the original shape was Anthropic's native
 * `{ type: 'base64', media_type, data }`. OpenAI and Google both accept
 * (and prefer) URL-based image inputs — smaller payloads, cacheable on
 * the provider side — so forcing every call through base64 meant bigger
 * uploads and re-encoding for images that were already web-hosted.
 * Widen to a discriminated union so callers can pass either shape and
 * each provider translates to its native wire form.
 */
export type ImageSource =
  | {
      type: 'base64';
      media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
      data: string;
    }
  | {
      type: 'url';
      url: string;
      /** Optional hint — some providers (Google) need a MIME type even for URLs. */
      media_type?: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
    };

export interface ImageContentBlock {
  type: 'image';
  source: ImageSource;
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
  /**
   * findings.md P2:788 — caller-driven cancellation. When the signal
   * aborts, the in-flight HTTP request is cancelled and no further
   * retries are attempted, so Ctrl-C on a long stream stops both the
   * network call and any billing tail. Providers pass this straight
   * through to their SDK's request options.
   */
  abortSignal?: AbortSignal;
  /**
   * findings.md P2:788 — per-call timeout in milliseconds. On expiry
   * the provider aborts the request like a caller-driven cancel, but
   * the retry layer still classifies the error as a timeout and may
   * retry (matching the SDK's own internal timeout semantics).
   */
  timeoutMs?: number;
}

export interface CompletionResult {
  content: string;
  /**
   * Why generation stopped. `'unknown'` covers provider stop_reason values
   * not explicitly mapped (including future/deprecated enum members) so
   * callers can branch / log rather than seeing them silently collapse to
   * `'stop'`. findings.md P2:940.
   */
  finishReason: 'stop' | 'length' | 'content_filter' | 'tool_use' | 'error' | 'unknown';
  usage: {
    inputTokens: number;
    outputTokens: number;
    /**
     * findings.md P2:808 — cache-read tokens are billed at ~10% the rate
     * of fresh input tokens, cache-writes at ~125%. The prior shape
     * folded everything into inputTokens, so the budget layer
     * over-counted cache hits. Expose the breakdown so callers that
     * care (budget accounting, usage dashboards) can weight accordingly.
     * Optional because non-Anthropic providers don't surface these
     * fields today — callers should treat undefined as "not reported"
     * and fall back to inputTokens.
     */
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
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

/**
 * findings.md P2:828 — provider-neutral descriptor for the active
 * model. Callers that want to size context dynamically (memory layer's
 * hardcoded 7000-token budget being the canonical offender) can now
 * ask the provider "how much room do I have?" instead of guessing.
 *
 * Fields:
 * - `contextWindow` — total tokens across input and output that the
 *   model accepts in one request. Use this as the upper bound when
 *   budgeting prompt + completion size.
 * - `maxOutputTokens` — the provider's cap on a single completion,
 *   separate from the context window (OpenAI, Anthropic, and Google
 *   all enforce this independently).
 * - `supportsVision` — image content blocks can be sent.
 * - `supportsStreaming` — streaming methods are implemented. Mirrors
 *   the Provider.supportsStreaming flag so a caller holding just a
 *   ModelInfo (e.g. after serializing) doesn't need the live instance.
 * - `supportsTools` — function/tool calling is available. All current
 *   providers support it on every listed model, but leave the flag in
 *   place so future text-only endpoints can opt out cleanly.
 */
export interface ModelInfo {
  contextWindow: number;
  maxOutputTokens: number;
  supportsVision: boolean;
  supportsStreaming: boolean;
  supportsTools: boolean;
}

export interface Provider {
  readonly name: string;
  readonly model: string;

  /**
   * findings.md P2:818 — capability flag so callers can branch on a
   * single boolean instead of re-deriving support from method
   * presence. A provider that sets this `true` must implement all
   * three streaming methods (`completeStream`,
   * `completeWithToolsStream`, `continueWithToolResultsStream`);
   * callers may assume they are callable when the flag is true.
   */
  readonly supportsStreaming: boolean;

  /**
   * findings.md P2:828 — return the active model's context window,
   * output cap, and capability flags. Callers should prefer this over
   * hardcoded constants so budgets adapt when the configured model
   * changes. Unknown models fall back to conservative family defaults
   * (never an over-estimate) so code sized against the return value
   * won't overrun on a model we haven't catalogued yet.
   */
  getModelInfo(): ModelInfo;

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
   * Continue a conversation after tool results.
   *
   * `assistantText` is the text the model emitted alongside the tool
   * calls in the prior turn (e.g. "I'll look that up..."). Passing it
   * through lets the provider reconstruct the assistant message with
   * both text and tool_use blocks preserved; omitting it drops the
   * mid-turn narration from the history. findings.md P2:930.
   */
  continueWithToolResults(
    options: CompletionWithToolsOptions,
    toolCalls: ToolCall[],
    toolResults: ToolResult[],
    assistantText?: string
  ): Promise<CompletionWithToolsResult>;

  /**
   * Continue a conversation after tool results with streaming.
   * See `continueWithToolResults` for notes on `assistantText`.
   */
  continueWithToolResultsStream?(
    options: CompletionWithToolsOptions,
    toolCalls: ToolCall[],
    toolResults: ToolResult[],
    onChunk: StreamCallback,
    assistantText?: string
  ): Promise<CompletionWithToolsResult>;
}

export abstract class BaseProvider implements Provider {
  abstract readonly name: string;
  abstract readonly model: string;
  abstract readonly supportsStreaming: boolean;

  abstract complete(options: CompletionOptions): Promise<CompletionResult>;
  abstract completeWithTools(options: CompletionWithToolsOptions): Promise<CompletionWithToolsResult>;
  abstract continueWithToolResults(
    options: CompletionWithToolsOptions,
    toolCalls: ToolCall[],
    toolResults: ToolResult[],
    assistantText?: string
  ): Promise<CompletionWithToolsResult>;
  abstract getModelInfo(): ModelInfo;

  /**
   * findings.md P2:1100 — belt-and-suspenders budget enforcement.
   *
   * The primary line of defense is the `withBudget()` proxy in
   * `providers/index.ts`, which every instance returned by `createProvider()`
   * is wrapped in. But direct callers of `createAnthropicProvider` /
   * `createOpenAIProvider` / `createGoogleProvider` (scripts, tests, a
   * new agent loop that bypasses the factory) skip that proxy. Future
   * methods added to a concrete provider that aren't in `withBudget`'s
   * apiMethods Set also bypass.
   *
   * Concrete provider methods await this as their FIRST LINE so the
   * monthly hard cap and daily soft-cap throttle (findings.md P2:1126)
   * are enforced regardless of construction path. Double-checking
   * through the proxy is harmless — the monthly check is a cheap read
   * and throttle only sleeps when daily cap has been crossed.
   */
  protected async assertBudget(): Promise<void> {
    await enforceBudget();
  }
}
