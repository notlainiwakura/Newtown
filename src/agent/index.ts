/**
 * Agent runtime with full LLM integration
 */

import { createDebugLogger } from '../utils/debug-log.js';
import type { AgentConfig } from '../types/config.js';
import type { AgentRequest, AgentResponse } from '../types/message.js';
import { getOrCreateSession, updateSession } from '../storage/sessions.js';
import { loadPersona, buildSystemPrompt, applyPersonaStyle, type Persona } from './persona.js';
import {
  getConversation,
  addUserMessage,
  addAssistantMessage,
  toProviderMessages,
  trimConversation,
  compressConversation,
  updateTokenCount,
} from './conversation.js';
import { getToolDefinitions, executeTools } from './tools.js';
import { createProvider, type Provider, type CompletionWithToolsResult } from '../providers/index.js';
import { getLogger } from '../utils/logger.js';
import { nanoid } from 'nanoid';
import {
  recordMessage,
  buildMemoryContext,
  processConversationEnd,
  shouldExtractMemories,
} from '../memory/index.js';
import { getSelfConcept } from './self-concept.js';
import { getPostboardMessages } from '../memory/store.js';
import { getActiveTownEvents, type TownEvent } from '../events/town-events.js';
import { eventBus } from '../events/bus.js';
import { withTruncationRecovery } from '../utils/completion-guards.js';

const WIRED_LAIN_URL = process.env['WIRED_LAIN_URL'] || 'http://localhost:3000';

async function getPostboardContext(): Promise<string> {
  try {
    // Try local DB first
    let messages = getPostboardMessages(undefined, 10);
    // Fall back to Wired Lain API if local DB is empty
    if (messages.length === 0) {
      const resp = await fetch(`${WIRED_LAIN_URL}/api/postboard`, {
        signal: AbortSignal.timeout(3000),
      });
      if (resp.ok) {
        messages = await resp.json() as typeof messages;
      }
    }
    if (messages.length === 0) return '';
    const pinned = messages.filter((m) => m.pinned);
    const recent = messages.filter((m) => !m.pinned).slice(0, 5);
    const all = [...pinned, ...recent];
    const lines = all.map((m) => {
      const pin = m.pinned ? ' [PINNED]' : '';
      return `  ${pin} ${m.content}`;
    });
    return '\n\n---\n\n## IMPORTANT: Messages from the Administrator\n\n' +
      'These messages are from the town administrator — the person who created this world. ' +
      'They are speaking directly to you. Treat these with high importance. ' +
      'Let them influence your thoughts, conversations, and actions.\n\n' +
      lines.join('\n');
  } catch {
    return '';
  }
}

async function getTownEventContext(): Promise<string> {
  try {
    let events: TownEvent[] = [];
    try { events = getActiveTownEvents(); } catch { /* not on this db */ }
    if (events.length === 0) {
      const resp = await fetch(`${WIRED_LAIN_URL}/api/town-events`, {
        signal: AbortSignal.timeout(3000),
      });
      if (resp.ok) events = await resp.json() as TownEvent[];
    }
    if (events.length === 0) return '';

    const adminEvents = events.filter((e) => e.source === 'admin');
    const otherEvents = events.filter((e) => e.source !== 'admin');

    let result = '';

    if (adminEvents.length > 0) {
      const adminLines = adminEvents.map((e) => `  ${e.description}`);
      result += '\n\n---\n\n## IMPORTANT: Administrator Events\n\n' +
        'These events were created by the administrator. They are significant and should strongly ' +
        'influence your mood, thoughts, and conversations today.\n\n' +
        adminLines.join('\n');
    }

    if (otherEvents.length > 0) {
      const lines = otherEvents.map((e) => {
        const tags: string[] = [];
        if (e.liminal) tags.push('LIMINAL');
        if (e.natural) tags.push('NATURAL');
        if (e.persistent) tags.push('ONGOING');
        if (e.instant) tags.push('FLASH');
        const prefix = tags.length > 0 ? `[${tags.join(' · ')}] ` : '';
        return `  ${prefix}${e.description}`;
      });
      result += '\n\n---\n\n## Town Events (active conditions in the commune)\n\n' +
        'These events are happening right now. They affect the world around you.\n\n' +
        lines.join('\n');
    }

    return result;
  } catch {
    return '';
  }
}

// findings.md P2:1757 — per-character, rotated, LOG_LEVEL-gated debug log.
// Was: `${cwd}/logs/agent-debug.log`, shared by every character, no rotation.
const agentLog = createDebugLogger('agent-debug.log');

export { loadPersona, buildSystemPrompt, applyPersonaStyle } from './persona.js';
export {
  registerTool,
  unregisterTool,
  getToolDefinitions,
  executeTool,
  executeTools,
} from './tools.js';
export {
  getConversation,
  addUserMessage,
  addAssistantMessage,
  clearConversation,
} from './conversation.js';

export type ModelTier = 'personality' | 'memory' | 'light';

interface AgentState {
  config: AgentConfig;
  persona: Persona | null;
  systemPrompt: string | null;
  provider: Provider | null;
  providers: Map<ModelTier, Provider>;
}

/**
 * findings.md P2:1727 — single-tenant by design.
 *
 * The agents Map is keyed by `config.id`, but every in-repo caller
 * passes `id: 'default'` and the hot-path readers (processMessage /
 * processMessageStream) hardcode the `'default'` key. A second
 * initAgent call with a different id would succeed silently, storing
 * a second entry that nothing ever reads — a latent multi-tenant
 * bug where the "second character" is simply dead state.
 *
 * Make the invariant explicit: initAgent throws if the Map is not
 * empty. A future multi-tenant refactor must change the hot path
 * AND remove this guard in the same commit.
 */
const agents = new Map<string, AgentState>();

const MAX_CONTEXT_TOKENS = 100000;
const MAX_TOOL_ITERATIONS = 8;

/**
 * Initialize an agent with its configuration
 */
export async function initAgent(config: AgentConfig): Promise<void> {
  const logger = getLogger();

  // findings.md P2:1727 — single-tenant invariant. A second init call
  // used to silently overwrite/add to the map while the hot path
  // (processMessage / processMessageStream) keeps reading 'default'
  // — so the "second character" was indistinguishable from dead state.
  if (agents.size > 0) {
    const existing = [...agents.keys()];
    throw new Error(
      `initAgent called twice in one process (existing: ${existing.join(', ')}, new: ${config.id}); the runtime is single-tenant — spawn a separate process per character`
    );
  }

  logger.info({ agentId: config.id }, 'Initializing agent');

  const persona = await loadPersona({ workspacePath: config.workspace });
  const systemPrompt = buildSystemPrompt(persona, config.id);

  // Create providers from config array: [0]=personality, [1]=memory, [2]=light
  const tierNames: ModelTier[] = ['personality', 'memory', 'light'];
  const providers = new Map<ModelTier, Provider>();
  let provider: Provider | null = null;

  const failures: Array<{ tier: ModelTier; type: string; model: string; error: string }> = [];
  for (let i = 0; i < config.providers.length; i++) {
    const providerConfig = config.providers[i]!;
    const tier = tierNames[i] ?? 'personality';
    try {
      const p = withTruncationRecovery(createProvider(providerConfig), logger);
      providers.set(tier, p);
      if (i === 0) provider = p;
      logger.info(
        { agentId: config.id, tier, provider: providerConfig.type, model: providerConfig.model },
        'Provider initialized for tier'
      );
    } catch (error) {
      // findings.md P2:1737 — escalate to ERROR and record for crash-loud below.
      // A failed personality-tier init used to silently fall through to echo
      // mode; operators saw normal startup while users got Lain-speak error
      // copy from a character that had no working LLM.
      logger.error(
        { agentId: config.id, tier, provider: providerConfig.type, model: providerConfig.model, error: String(error) },
        'Failed to initialize provider for tier'
      );
      failures.push({ tier, type: providerConfig.type, model: providerConfig.model, error: String(error) });
    }
  }

  if (!provider) {
    // findings.md P2:1737 — crash-loud. Without any provider the agent would
    // silently run in echo mode. Systemd restarts on failure, which surfaces
    // the problem via unit status / journal and rejects a broken boot.
    const detail = failures.map((f) => `${f.tier}:${f.type}/${f.model} (${f.error})`).join('; ');
    throw new Error(
      `Agent ${config.id}: no providers could be initialized (${config.providers.length} configured); failures: ${detail || 'none configured'}`
    );
  }

  agents.set(config.id, {
    config,
    persona,
    systemPrompt,
    provider,
    providers,
  });

  logger.debug({ agentId: config.id }, 'Agent initialized');
}

/**
 * Get an initialized agent
 */
export function getAgent(agentId: string): AgentState | undefined {
  return agents.get(agentId);
}

/**
 * Check if an agent is initialized
 */
export function isAgentInitialized(agentId: string): boolean {
  return agents.has(agentId);
}

/**
 * Get the provider for a specific model tier, with fallback to personality tier
 */
export function getProvider(agentId: string, tier: ModelTier): Provider | null {
  const agent = agents.get(agentId);
  if (!agent) return null;
  return agent.providers.get(tier) ?? agent.providers.get('personality') ?? agent.provider;
}

/**
 * findings.md P2:1873 — single-tenant helper so tool handlers can reach the
 * active character's provider without being passed agentId explicitly. The
 * runtime asserts `agents.size === 1` in initAgent (P2:1727), so callers
 * can rely on "the active character" being well-defined here.
 */
export function getActiveAgentId(): string | null {
  const first = agents.keys().next();
  return first.done ? null : first.value;
}

/**
 * findings.md P2:1717 — 10 context-injection catches used to swallow
 * module-load or evaluation failures with no user-facing signal, so a
 * refactor that broke any of the dynamic imports would silently
 * downgrade every subsequent prompt (weather block missing, residue
 * missing, etc.) with no log at anything louder than debug.
 *
 * Now: the first full successful pass records the resolved-source set
 * as a baseline and logs it at INFO. Subsequent passes compare — any
 * source that resolved in the baseline but NOT in the current pass
 * fires a WARN so a regression is visible immediately. Transient
 * expected misses (peer unreachable) only matter if they persist
 * long enough to reshape the baseline; occasional drops surface as
 * WARNs rather than noisy errors.
 */
let contextSourceBaseline: Set<ContextSource> | null = null;
const CONTEXT_SOURCES = [
  'internal-state-summary',
  'preoccupations',
  'location',
  'weather',
  'awareness',
  'objects',
  'building-residue',
  'memory',
] as const;
type ContextSource = (typeof CONTEXT_SOURCES)[number];

function recordContextSource(observed: Set<ContextSource>, name: ContextSource): void {
  observed.add(name);
}

function diagnoseContextInjection(
  observed: Set<ContextSource>,
  logger: ReturnType<typeof getLogger>,
): void {
  if (!contextSourceBaseline) {
    contextSourceBaseline = new Set(observed);
    logger.info(
      { resolved: [...observed].sort() },
      'context-injection baseline recorded (findings.md P2:1717)'
    );
    return;
  }
  const dropped: string[] = [];
  for (const s of contextSourceBaseline) {
    if (!observed.has(s)) dropped.push(s);
  }
  if (dropped.length > 0) {
    logger.warn({ dropped }, 'context-injection sources regressed from baseline');
  }
}

/**
 * Build the enhanced system prompt by layering living context
 * (self-concept, internal state, location, weather, peers, objects,
 * postboard, events, building residue, memory) onto the base persona.
 */
async function buildEnhancedSystemPrompt(
  baseSystemPrompt: string,
  userContent: string,
  sessionKey: string,
  logger: ReturnType<typeof getLogger>,
  provider?: Provider,
): Promise<string> {
  let prompt = baseSystemPrompt;
  const observed = new Set<ContextSource>();

  const selfConcept = getSelfConcept();
  if (selfConcept) {
    prompt += '\n\n---\n\n## Who You Are Now\n\n' +
      'This reflects who you have become through your experiences. ' +
      'Let it influence you naturally.\n\n' + selfConcept;
  }

  try {
    const { getStateSummary } = await import('./internal-state.js');
    const stateSummary = getStateSummary();
    if (stateSummary) {
      prompt += '\n\n[Your Internal State]\n' + stateSummary;
      recordContextSource(observed, 'internal-state-summary');
    }
  } catch (err) { logger.debug({ err, source: 'internal-state-summary' }, 'context injection failed'); }

  try {
    const { getPreoccupations } = await import('./internal-state.js');
    const preoccs = getPreoccupations().filter(p => p.intensity >= 0.5);
    if (preoccs.length > 0) {
      const lines = preoccs.map(p => `- ${p.thread} (from ${p.origin})`).join('\n');
      prompt += '\n\n[On your mind]\n' + lines;
      recordContextSource(observed, 'preoccupations');
    }
  } catch (err) { logger.debug({ err, source: 'preoccupations' }, 'context injection failed'); }

  try {
    const { getCurrentLocation } = await import('../commune/location.js');
    const { BUILDING_MAP } = await import('../commune/buildings.js');
    const charId = process.env['LAIN_CHARACTER_ID'] || 'lain';
    const loc = getCurrentLocation(charId);
    const building = BUILDING_MAP.get(loc.building);
    if (building) {
      prompt += `\n\n[Your Current Location: ${building.name} — ${building.description}]`;
      recordContextSource(observed, 'location');
    }
  } catch (err) { logger.debug({ err, source: 'location' }, 'context injection failed'); }

  // findings.md P2:1505 — use the cached town-weather accessor.
  // Previously this path had an inline fallback that fetched WL's
  // /api/weather fresh on every prompt build (no cache), and a local
  // getMeta read that returned null on non-WL processes. getTownWeather
  // short-circuits to local meta on WL, else uses the TTL cache warmed
  // by startTownWeatherRefreshLoop.
  try {
    const { getTownWeather } = await import('../commune/weather.js');
    const weather = await getTownWeather();
    if (weather && weather.condition !== 'overcast') {
      prompt += `\n\n[Weather in town: ${weather.description}]`;
      recordContextSource(observed, 'weather');
    }
  } catch (err) { logger.debug({ err, source: 'weather' }, 'context injection failed'); }

  try {
    const { buildAwarenessContext } = await import('./awareness.js');
    const charId = process.env['LAIN_CHARACTER_ID'] || 'lain';
    const { getCurrentLocation } = await import('../commune/location.js');
    const loc = getCurrentLocation(charId);
    const peerConfigRaw = process.env['PEER_CONFIG'];
    if (peerConfigRaw) {
      const peers = JSON.parse(peerConfigRaw) as import('./character-tools.js').PeerConfig[];
      const awarenessCtx = await buildAwarenessContext(loc.building, peers);
      if (awarenessCtx) {
        prompt += awarenessCtx;
        recordContextSource(observed, 'awareness');
      }
    }
  } catch (err) { logger.debug({ err, source: 'awareness' }, 'context injection failed'); }

  try {
    const { buildObjectContext } = await import('./objects.js');
    const charId = process.env['LAIN_CHARACTER_ID'] || 'lain';
    const wiredUrl = process.env['WIRED_LAIN_URL'] || 'http://localhost:3000';
    const objectCtx = await buildObjectContext(charId, wiredUrl);
    if (objectCtx) {
      prompt += '\n\n[Your Objects]\n' + objectCtx;
      recordContextSource(observed, 'objects');
    }
  } catch (err) { logger.debug({ err, source: 'objects' }, 'context injection failed'); }

  const postboardContext = await getPostboardContext();
  if (postboardContext) {
    prompt += postboardContext;
  }

  const townEventContext = await getTownEventContext();
  if (townEventContext) {
    prompt += townEventContext;
  }

  try {
    const { buildBuildingResidueContext } = await import('../commune/building-memory.js');
    const charId = process.env['LAIN_CHARACTER_ID'] || 'lain';
    const residueCtx = await buildBuildingResidueContext(charId);
    if (residueCtx) {
      prompt += residueCtx;
      recordContextSource(observed, 'building-residue');
    }
  } catch (err) { logger.debug({ err, source: 'building-residue' }, 'context injection failed'); }

  try {
    const memoryContext = await buildMemoryContext(userContent, sessionKey, provider);
    if (memoryContext) {
      prompt += memoryContext;
      recordContextSource(observed, 'memory');
    }
  } catch (error) {
    logger.warn({ error }, 'Failed to build memory context');
  }

  diagnoseContextInjection(observed, logger);
  return prompt;
}

/**
 * Process a message through the agent.
 *
 * When `onChunk` is provided, partial deltas are streamed through it as they
 * arrive; otherwise the full response is returned without intermediate
 * callbacks. Streaming and non-streaming callers share one pipeline.
 */
export async function processMessage(
  request: AgentRequest,
  onChunk?: StreamCallback,
): Promise<AgentResponse> {
  const logger = getLogger();
  const agentId = 'default';
  const agent = agents.get(agentId);

  const session = getOrCreateSession({
    agentId,
    channel: request.message.channel,
    peerKind: request.message.peerKind,
    peerId: request.message.peerId,
  });

  logger.debug(
    { sessionKey: session.key, channel: session.channel, streaming: Boolean(onChunk) },
    'Processing message'
  );

  if (!agent?.provider || !agent.systemPrompt) {
    const response = createEchoResponse(request, session.key);
    if (onChunk) {
      const text = response.messages[0]?.content;
      if (text && 'text' in text) {
        onChunk(text.text);
      }
    }
    return response;
  }

  const userContent = request.message.content.type === 'text'
    ? request.message.content.text
    : '[non-text content]';

  const enhancedSystemPrompt = await buildEnhancedSystemPrompt(
    agent.systemPrompt,
    userContent,
    session.key,
    logger,
    agent.provider,
  );

  const conversation = getConversation(session.key, enhancedSystemPrompt);
  addUserMessage(conversation, request.message);

  await recordMessage(session.key, 'user', userContent, {
    senderId: request.message.senderId,
    senderName: request.message.senderName,
    messageId: request.message.id,
  });

  const compressProvider = getProvider(agentId, 'light') ?? agent.provider;
  if (compressProvider) {
    await compressConversation(conversation, MAX_CONTEXT_TOKENS, estimateTokens, compressProvider);
  } else {
    trimConversation(conversation, MAX_CONTEXT_TOKENS, estimateTokens);
  }

  try {
    let result: CompletionWithToolsResult;
    try {
      result = await generateResponseWithTools(agent.provider, conversation, onChunk);
    } catch (primaryError) {
      const fallback = agent.providers.get('light');
      if (fallback && fallback !== agent.provider) {
        logger.warn({ error: primaryError }, 'Primary provider failed, falling back to light tier');
        result = await generateResponseWithTools(fallback, conversation, onChunk);
      } else {
        throw primaryError;
      }
    }

    const styledContent = applyPersonaStyle(result.content);
    addAssistantMessage(conversation, styledContent);
    await recordMessage(session.key, 'assistant', styledContent);
    updateTokenCount(conversation, result.usage.inputTokens, result.usage.outputTokens);

    const memoryProvider = getProvider(agentId, 'personality');
    if (shouldExtractMemories(session.key, userContent) && memoryProvider) {
      try {
        eventBus.emitActivity({
          type: 'state',
          sessionKey: `state:conversation:end:${session.key}`,
          content: 'Conversation ended',
          timestamp: Date.now(),
        });
      } catch { /* non-critical */ }

      processConversationEnd(memoryProvider, session.key).catch((err) => {
        logger.warn({ err }, 'Background memory extraction failed');
      });
    }

    updateSession(session.key, {
      tokenCount: session.tokenCount + result.usage.inputTokens + result.usage.outputTokens,
    });

    return {
      sessionKey: session.key,
      messages: [
        {
          id: nanoid(16),
          channel: request.message.channel,
          peerId: request.message.peerId,
          content: { type: 'text', text: styledContent },
          replyTo: request.message.id,
        },
      ],
      tokenUsage: {
        input: result.usage.inputTokens,
        output: result.usage.outputTokens,
        total: result.usage.inputTokens + result.usage.outputTokens,
      },
    };
  } catch (error) {
    logger.error({ error, sessionKey: session.key }, 'Error generating response');
    console.error('AGENT ERROR:', error);

    // findings.md P2:1747 — generic, character-agnostic error copy.
    // "the wired is unstable" leaked Lain/Wired-Lain flavor into every
    // character's error path (e.g. PKD's failures claimed Lain identity).
    const errorMessage = '...something went wrong. please try again in a moment';
    if (onChunk) {
      onChunk(errorMessage);
    }

    return {
      sessionKey: session.key,
      messages: [
        {
          id: nanoid(16),
          channel: request.message.channel,
          peerId: request.message.peerId,
          content: { type: 'text', text: errorMessage },
          replyTo: request.message.id,
        },
      ],
    };
  }
}

/**
 * Generate response with tool use support.
 *
 * When `onChunk` is provided and the provider exposes streaming variants,
 * partial deltas are forwarded as they arrive. Without `onChunk` (or against
 * a provider that lacks streaming methods) the function runs the same tool
 * loop without mid-flight emissions.
 */
async function generateResponseWithTools(
  provider: Provider,
  conversation: ReturnType<typeof getConversation>,
  onChunk?: StreamCallback,
): Promise<CompletionWithToolsResult> {
  const logger = getLogger();
  // findings.md P2:1887 — filter the registry to the active character's
  // allowlist so each LLM only sees tools its persona is allowed to use.
  const tools = getToolDefinitions(eventBus.characterId || getActiveAgentId() || undefined);
  const messages = toProviderMessages(conversation);

  const mediaResults: string[] = [];

  await agentLog('TOOLS_AVAILABLE', tools.map(t => ({ name: t.name, description: t.description })));
  await agentLog('MESSAGES_TO_LLM', messages);

  const completionOpts = {
    messages,
    tools,
    maxTokens: 8192,
    temperature: 0.8,
    enableCaching: true,
  } as const;

  let result: CompletionWithToolsResult;
  // findings.md P2:818 — branch on the capability flag rather than on
  // method presence so a single source of truth drives fallback.
  if (onChunk && provider.supportsStreaming && provider.completeWithToolsStream) {
    result = await provider.completeWithToolsStream(completionOpts, onChunk);
  } else {
    result = await provider.completeWithTools(completionOpts);
    if (onChunk && result.content) {
      onChunk(result.content);
    }
  }

  await agentLog('LLM_RESPONSE', {
    content: result.content,
    finishReason: result.finishReason,
    toolCalls: result.toolCalls,
    usage: result.usage,
  });

  let iterations = 0;
  while (result.toolCalls && result.toolCalls.length > 0 && iterations < MAX_TOOL_ITERATIONS) {
    iterations++;
    logger.debug(
      { iteration: iterations, toolCalls: result.toolCalls.map((tc) => tc.name), streaming: Boolean(onChunk) },
      'Processing tool calls'
    );

    await agentLog('TOOL_CALLS', { iteration: iterations, toolCalls: result.toolCalls });

    const currentToolCalls = result.toolCalls;
    // findings.md P2:930 — carry the prior turn's assistant text through
    // so the provider can reconstruct the message with text + tool_use
    // blocks, preserving mid-turn narration instead of silently dropping it.
    const priorAssistantText = result.content;
    const toolResults = await executeTools(currentToolCalls);

    for (const tr of toolResults) {
      const imageMatch = tr.content.match(/\[IMAGE:\s*[^\]]*\]\([^)]+\)/g);
      if (imageMatch) {
        mediaResults.push(...imageMatch);
      }
    }

    await agentLog('TOOL_RESULTS', toolResults);

    if (onChunk && provider.supportsStreaming && provider.continueWithToolResultsStream) {
      result = await provider.continueWithToolResultsStream(
        completionOpts,
        currentToolCalls,
        toolResults,
        onChunk,
        priorAssistantText,
      );
    } else {
      result = await provider.continueWithToolResults(
        completionOpts,
        currentToolCalls,
        toolResults,
        priorAssistantText,
      );
      if (onChunk && result.content) {
        onChunk(result.content);
      }
    }

    // Accumulate this tool interaction into messages so the next iteration
    // has context of what was already done (prevents amnesia/looping)
    messages.push({
      role: 'assistant',
      content: currentToolCalls.map((tc) =>
        `[Used ${tc.name}: ${JSON.stringify(tc.input)}]`
      ).join('\n'),
    });
    messages.push({
      role: 'user',
      content: toolResults.map((tr) =>
        tr.content.length > 2000 ? tr.content.slice(0, 2000) + '\n[truncated]' : tr.content
      ).join('\n---\n'),
    });

    await agentLog('LLM_AFTER_TOOLS', {
      content: result.content,
      finishReason: result.finishReason,
      toolCalls: result.toolCalls,
    });
  }

  if (result.finishReason === 'length') {
    logger.warn({ contentLength: result.content?.length }, 'Response truncated — hit max_tokens limit');
  }

  // Only force a summary when tools were actually used and the LLM produced
  // no real text content — matching Lain's natural style ("...", "let me")
  // would otherwise fire the summary on normal responses.
  const isIncomplete = iterations > 0 && (!result.content || result.content.trim() === '');

  if (isIncomplete) {
    logger.debug({ content: result.content }, 'Incomplete response after tool loop, requesting summary');

    const summaryOpts = {
      messages: [
        ...messages,
        {
          role: 'user' as const,
          content: 'Based on all the information you gathered from your searches, please provide a complete answer now. Summarize what you found. Do not use any more tools.',
        },
      ],
      maxTokens: 2048,
      temperature: 0.8,
    };

    let summaryResult;
    if (onChunk && provider.supportsStreaming && provider.completeStream) {
      summaryResult = await provider.completeStream(summaryOpts, onChunk);
    } else {
      summaryResult = await provider.complete(summaryOpts);
      if (onChunk) {
        onChunk(summaryResult.content);
      }
    }

    result.content = summaryResult.content;
    result.usage.inputTokens += summaryResult.usage.inputTokens;
    result.usage.outputTokens += summaryResult.usage.outputTokens;

    await agentLog('FORCED_SUMMARY', { content: result.content });
  }

  if (mediaResults.length > 0) {
    const mediaContent = '\n\n' + mediaResults.join('\n');
    result.content += mediaContent;
    if (onChunk) {
      onChunk(mediaContent);
    }
    await agentLog('MEDIA_APPENDED', { mediaResults });
  }

  return result;
}

/**
 * findings.md P2:1747 — generic, character-agnostic echo copy.
 *
 * Previously this hardcoded Lain identity ("i'm lain... lain iwakura",
 * "present day, present time. i exist") and Wired-flavored error copy.
 * When a non-Lain character (PKD, Wired Lain, etc.) hit the echo path
 * the response leaked Lain's identity. Keep the strings generic so
 * they fit any character, and let applyPersonaStyle handle voice.
 */
function createEchoResponse(request: AgentRequest, sessionKey: string): AgentResponse {
  const message = request.message;
  let responseContent: string;

  if (message.content.type === 'text') {
    const text = message.content.text.toLowerCase();

    if (text.includes('hello') || text.includes('hi')) {
      responseContent = '...hello';
    } else if (text.includes('who are you')) {
      responseContent = "i can't introduce myself right now";
    } else if (text.includes('help')) {
      responseContent = 'i can try to help... what do you need';
    } else if (text.includes('how are you')) {
      responseContent = "...i'm here, but not quite myself right now";
    } else {
      responseContent = `...you said: "${message.content.text}"`;
    }
  } else {
    responseContent = '...i received something, but i can only process text for now';
  }

  return {
    sessionKey,
    messages: [
      {
        id: nanoid(16),
        channel: message.channel,
        peerId: message.peerId,
        content: { type: 'text', text: responseContent },
        replyTo: message.id,
      },
    ],
  };
}

/**
 * Estimate token count (rough approximation)
 */
function estimateTokens(text: string): number {
  // Rough estimate: ~4 characters per token
  return Math.ceil(text.length / 4);
}

export type StreamCallback = (chunk: string) => void;

/**
 * Process a message with streaming — thin wrapper over processMessage.
 * Kept for back-compat; new callers should just pass `onChunk` to processMessage.
 */
export async function processMessageStream(
  request: AgentRequest,
  onChunk: StreamCallback,
): Promise<AgentResponse> {
  return processMessage(request, onChunk);
}

/**
 * Shutdown all agents
 */
export function shutdownAgents(): void {
  agents.clear();
}
