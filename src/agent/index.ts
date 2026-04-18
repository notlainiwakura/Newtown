/**
 * Agent runtime with full LLM integration
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
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
import { loadCustomTools } from './skills.js';
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

const LOG_FILE = join(process.cwd(), 'logs', 'agent-debug.log');

async function agentLog(context: string, data: unknown): Promise<void> {
  try {
    await mkdir(join(process.cwd(), 'logs'), { recursive: true });
    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] [${context}] ${JSON.stringify(data, null, 2)}\n${'='.repeat(80)}\n`;
    await appendFile(LOG_FILE, entry);
  } catch {
    // Ignore logging errors
  }
}

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

const agents = new Map<string, AgentState>();

const MAX_CONTEXT_TOKENS = 100000;
const MAX_TOOL_ITERATIONS = 8;

/**
 * Initialize an agent with its configuration
 */
export async function initAgent(config: AgentConfig): Promise<void> {
  const logger = getLogger();

  logger.info({ agentId: config.id }, 'Initializing agent');

  const persona = await loadPersona({ workspacePath: config.workspace });
  const systemPrompt = buildSystemPrompt(persona);

  // Create providers from config array: [0]=personality, [1]=memory, [2]=light
  const tierNames: ModelTier[] = ['personality', 'memory', 'light'];
  const providers = new Map<ModelTier, Provider>();
  let provider: Provider | null = null;

  for (let i = 0; i < config.providers.length; i++) {
    const providerConfig = config.providers[i]!;
    const tier = tierNames[i] ?? 'personality';
    try {
      const p = createProvider(providerConfig);
      providers.set(tier, p);
      if (i === 0) provider = p;
      logger.info(
        { agentId: config.id, tier, provider: providerConfig.type, model: providerConfig.model },
        'Provider initialized for tier'
      );
    } catch (error) {
      logger.warn(
        { agentId: config.id, tier, error },
        'Failed to initialize provider for tier'
      );
    }
  }

  if (!provider) {
    logger.warn(
      { agentId: config.id },
      'No providers initialized, agent will use echo mode'
    );
  }

  agents.set(config.id, {
    config,
    persona,
    systemPrompt,
    provider,
    providers,
  });

  // Load custom tools from skills directory
  const customToolCount = await loadCustomTools();
  if (customToolCount > 0) {
    logger.info({ count: customToolCount }, 'Loaded custom tools');
  }

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
 * Process a message through the agent
 */
export async function processMessage(request: AgentRequest): Promise<AgentResponse> {
  const logger = getLogger();
  const agentId = 'default';
  const agent = agents.get(agentId);

  // Get or create session
  const session = getOrCreateSession({
    agentId,
    channel: request.message.channel,
    peerKind: request.message.peerKind,
    peerId: request.message.peerId,
  });

  logger.debug(
    { sessionKey: session.key, channel: session.channel },
    'Processing message'
  );

  // If no provider is available, use echo mode
  if (!agent?.provider || !agent.systemPrompt) {
    return createEchoResponse(request, session.key);
  }

  // Get user message content
  const userContent = request.message.content.type === 'text'
    ? request.message.content.text
    : '[non-text content]';

  // Build enhanced system prompt: SOUL.md + self-concept + memory context
  let enhancedSystemPrompt = agent.systemPrompt;

  // Inject living self-concept (between static persona and dynamic memory)
  const selfConcept = getSelfConcept();
  if (selfConcept) {
    enhancedSystemPrompt += '\n\n---\n\n## Who You Are Now\n\n' +
      'This reflects who you have become through your experiences. ' +
      'Let it influence you naturally.\n\n' + selfConcept;
  }

  // Inject internal emotional state
  try {
    const { getStateSummary } = await import('./internal-state.js');
    const stateSummary = getStateSummary();
    if (stateSummary) {
      enhancedSystemPrompt += '\n\n[Your Internal State]\n' + stateSummary;
    }
  } catch { /* non-critical */ }

  // Inject active preoccupations
  try {
    const { getPreoccupations } = await import('./internal-state.js');
    const preoccs = getPreoccupations().filter(p => p.intensity >= 0.5);
    if (preoccs.length > 0) {
      const lines = preoccs.map(p => `- ${p.thread} (from ${p.origin})`).join('\n');
      enhancedSystemPrompt += '\n\n[On your mind]\n' + lines;
    }
  } catch { /* non-critical */ }

  // Inject current location so the character knows where they are
  try {
    const { getCurrentLocation } = await import('../commune/location.js');
    const { BUILDING_MAP } = await import('../commune/buildings.js');
    const charId = process.env['LAIN_CHARACTER_ID'] || 'newtown';
    const loc = getCurrentLocation(charId);
    const building = BUILDING_MAP.get(loc.building);
    if (building) {
      enhancedSystemPrompt += `\n\n[Your Current Location: ${building.name} — ${building.description}]`;
    }
  } catch { /* non-critical */ }

  // Inject weather
  try {
    let weatherDesc: string | null = null;
    // Try local meta store first (works for Wired Lain)
    const { getCurrentWeather } = await import('../commune/weather.js');
    const localWeather = getCurrentWeather();
    if (localWeather && localWeather.condition !== 'overcast') {
      weatherDesc = localWeather.description;
    }
    // Fallback to HTTP for non-Wired instances
    if (!weatherDesc) {
      const peerConfigRaw = process.env['PEER_CONFIG'];
      if (peerConfigRaw) {
        const peers = JSON.parse(peerConfigRaw) as Array<{ id: string; url: string }>;
        const wiredPeer = peers.find(p => p.id === 'wired-lain');
        if (wiredPeer) {
          const resp = await fetch(`${wiredPeer.url}/api/weather`, {
            signal: AbortSignal.timeout(3000),
          });
          if (resp.ok) {
            const data = await resp.json() as { condition: string; description: string };
            if (data.condition && data.condition !== 'overcast') {
              weatherDesc = data.description;
            }
          }
        }
      }
    }
    if (weatherDesc) {
      enhancedSystemPrompt += `\n\n[Weather in town: ${weatherDesc}]`;
    }
  } catch { /* non-critical */ }

  // Inject ambient awareness of co-located peers
  try {
    const { buildAwarenessContext } = await import('./awareness.js');
    const charId = process.env['LAIN_CHARACTER_ID'] || 'newtown';
    const { getCurrentLocation } = await import('../commune/location.js');
    const loc = getCurrentLocation(charId);
    const peerConfigRaw = process.env['PEER_CONFIG'];
    if (peerConfigRaw) {
      const peers = JSON.parse(peerConfigRaw) as import('./character-tools.js').PeerConfig[];
      const awarenessCtx = await buildAwarenessContext(loc.building, peers);
      if (awarenessCtx) {
        enhancedSystemPrompt += awarenessCtx;
      }
    }
  } catch { /* non-critical */ }

  // Inject object inventory with symbolic meanings + composition lexicon
  try {
    const { buildObjectContext } = await import('./objects.js');
    const charId = process.env['LAIN_CHARACTER_ID'] || 'newtown';
    const wiredUrl = process.env['WIRED_LAIN_URL'] || 'http://localhost:3000';
    const objectCtx = await buildObjectContext(charId, wiredUrl);
    if (objectCtx) {
      enhancedSystemPrompt += '\n\n[Your Objects]\n' + objectCtx;
    }
  } catch { /* non-critical */ }

  // Inject postboard messages from the administrator
  const postboardContext = await getPostboardContext();
  if (postboardContext) {
    enhancedSystemPrompt += postboardContext;
  }

  // Inject active town events
  const townEventContext = await getTownEventContext();
  if (townEventContext) {
    enhancedSystemPrompt += townEventContext;
  }

  // Inject building residue — traces of what happened at this location
  try {
    const { buildBuildingResidueContext } = await import('../commune/building-memory.js');
    const charId = process.env['LAIN_CHARACTER_ID'] || 'newtown';
    const residueCtx = await buildBuildingResidueContext(charId);
    if (residueCtx) {
      enhancedSystemPrompt += residueCtx;
    }
  } catch { /* non-critical */ }

  try {
    const memoryContext = await buildMemoryContext(userContent, session.key);
    if (memoryContext) {
      enhancedSystemPrompt += memoryContext;
    }
  } catch (error) {
    logger.warn({ error }, 'Failed to build memory context');
  }

  // Get or create conversation with memory-enhanced prompt
  const conversation = getConversation(session.key, enhancedSystemPrompt);

  // Add user message to conversation
  addUserMessage(conversation, request.message);

  // Record user message to persistent memory
  await recordMessage(session.key, 'user', userContent, {
    senderId: request.message.senderId,
    senderName: request.message.senderName,
    messageId: request.message.id,
  });

  // Compress conversation if needed (summarizes older messages instead of dropping them)
  const compressProvider = getProvider(agentId, 'light') ?? agent.provider;
  if (compressProvider) {
    await compressConversation(conversation, MAX_CONTEXT_TOKENS, estimateTokens, compressProvider);
  } else {
    trimConversation(conversation, MAX_CONTEXT_TOKENS, estimateTokens);
  }

  try {
    // Generate response with tool use support, with tier fallback
    let result: CompletionWithToolsResult;
    try {
      result = await generateResponseWithTools(agent.provider, conversation);
    } catch (primaryError) {
      const fallback = agent.providers.get('light');
      if (fallback && fallback !== agent.provider) {
        logger.warn({ error: primaryError }, 'Primary provider failed, falling back to light tier');
        result = await generateResponseWithTools(fallback, conversation);
      } else {
        throw primaryError;
      }
    }

    // Apply persona style to response
    const styledContent = applyPersonaStyle(result.content);

    // Add assistant response to conversation
    addAssistantMessage(conversation, styledContent);

    // Record assistant message to persistent memory
    await recordMessage(session.key, 'assistant', styledContent);

    // Update token counts
    updateTokenCount(conversation, result.usage.inputTokens, result.usage.outputTokens);

    // Extract memories when session has enough context or high-signal content
    const memoryProvider = getProvider(agentId, 'personality');
    if (shouldExtractMemories(session.key, userContent) && memoryProvider) {
      // Emit conversation:end event for background loops
      try {
        eventBus.emitActivity({
          type: 'state',
          sessionKey: `state:conversation:end:${session.key}`,
          content: 'Conversation ended',
          timestamp: Date.now(),
        });
      } catch { /* non-critical */ }

      // Run in background, don't wait
      processConversationEnd(memoryProvider, session.key).catch((err) => {
        logger.warn({ err }, 'Background memory extraction failed');
      });
    }

    // Update session
    updateSession(session.key, {
      tokenCount: session.tokenCount + result.usage.inputTokens + result.usage.outputTokens,
    });

    const response: AgentResponse = {
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

    return response;
  } catch (error) {
    logger.error({ error, sessionKey: session.key }, 'Error generating response');
    console.error('AGENT ERROR:', error);

    // Return error message in Lain's style
    const errorMessage = '...something went wrong. the wired is unstable right now...';

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
 * Generate response with tool use support
 */
async function generateResponseWithTools(
  provider: Provider,
  conversation: ReturnType<typeof getConversation>
): Promise<CompletionWithToolsResult> {
  const logger = getLogger();
  const tools = getToolDefinitions();
  const messages = toProviderMessages(conversation);

  // Track media (images) from tool results to append to response
  const mediaResults: string[] = [];

  await agentLog('TOOLS_AVAILABLE', tools.map(t => ({ name: t.name, description: t.description })));
  await agentLog('MESSAGES_TO_LLM', messages);

  let result = await provider.completeWithTools({
    messages,
    tools,
    maxTokens: 4096,
    temperature: 0.8,
    enableCaching: true, // Cache system prompt and tools for 90% cost reduction
  });

  await agentLog('LLM_RESPONSE', {
    content: result.content,
    finishReason: result.finishReason,
    toolCalls: result.toolCalls,
    usage: result.usage,
  });

  // Handle tool calls iteratively
  let iterations = 0;
  while (result.toolCalls && result.toolCalls.length > 0 && iterations < MAX_TOOL_ITERATIONS) {
    iterations++;
    logger.debug(
      { iteration: iterations, toolCalls: result.toolCalls.map((tc) => tc.name) },
      'Processing tool calls'
    );

    await agentLog('TOOL_CALLS', {
      iteration: iterations,
      toolCalls: result.toolCalls,
    });

    const currentToolCalls = result.toolCalls;

    // Execute tools
    const toolResults = await executeTools(currentToolCalls);

    // Check for image results and collect them
    for (const tr of toolResults) {
      const imageMatch = tr.content.match(/\[IMAGE:\s*[^\]]*\]\([^)]+\)/g);
      if (imageMatch) {
        mediaResults.push(...imageMatch);
      }
    }

    await agentLog('TOOL_RESULTS', toolResults);

    // Continue conversation with tool results
    result = await provider.continueWithToolResults(
      { messages, tools, maxTokens: 4096, temperature: 0.8, enableCaching: true },
      currentToolCalls,
      toolResults
    );

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

  // Check if response is incomplete after a tool loop — only when tools were actually
  // used and the LLM produced no real text content (empty or whitespace-only).
  // Previous heuristic matched Lain's natural style ("...", "let me") causing
  // the summary prompt to fire on normal responses.
  const isIncomplete = iterations > 0 && (!result.content || result.content.trim() === '');

  if (isIncomplete) {
    logger.debug({ content: result.content }, 'Incomplete response after tool loop, requesting summary');

    // Make a final call without tools to get a proper text response
    const summaryResult = await provider.complete({
      messages: [
        ...messages,
        {
          role: 'user',
          content: 'Based on all the information you gathered from your searches, please provide a complete answer now. Summarize what you found. Do not use any more tools.',
        },
      ],
      maxTokens: 2048,
      temperature: 0.8,
    });

    result.content = summaryResult.content;
    result.usage.inputTokens += summaryResult.usage.inputTokens;
    result.usage.outputTokens += summaryResult.usage.outputTokens;

    await agentLog('FORCED_SUMMARY', { content: result.content });
  }

  // Append any media (images) collected from tool results
  if (mediaResults.length > 0) {
    result.content += '\n\n' + mediaResults.join('\n');
    await agentLog('MEDIA_APPENDED', { mediaResults });
  }

  return result;
}

/**
 * Create an echo response (fallback when no provider is available)
 */
function createEchoResponse(request: AgentRequest, sessionKey: string): AgentResponse {
  const message = request.message;
  let responseContent: string;

  if (message.content.type === 'text') {
    const text = message.content.text.toLowerCase();

    if (text.includes('hello') || text.includes('hi')) {
      responseContent = '...hello';
    } else if (text.includes('who are you')) {
      responseContent = "i'm lain... lain iwakura";
    } else if (text.includes('help')) {
      responseContent = 'i can try to help... what do you need';
    } else if (text.includes('how are you')) {
      responseContent = '...present day, present time. i exist';
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
 * Process a message through the agent with streaming
 */
export async function processMessageStream(
  request: AgentRequest,
  onChunk: StreamCallback
): Promise<AgentResponse> {
  const logger = getLogger();
  const agentId = 'default';
  const agent = agents.get(agentId);

  // Get or create session
  const session = getOrCreateSession({
    agentId,
    channel: request.message.channel,
    peerKind: request.message.peerKind,
    peerId: request.message.peerId,
  });

  logger.debug(
    { sessionKey: session.key, channel: session.channel },
    'Processing message with streaming'
  );

  // If no provider is available, use echo mode
  if (!agent?.provider || !agent.systemPrompt) {
    const response = createEchoResponse(request, session.key);
    const text = response.messages[0]?.content;
    if (text && 'text' in text) {
      onChunk(text.text);
    }
    return response;
  }

  // Get user message content
  const userContent = request.message.content.type === 'text'
    ? request.message.content.text
    : '[non-text content]';

  // Build enhanced system prompt: SOUL.md + self-concept + memory context
  let enhancedSystemPrompt = agent.systemPrompt;

  // Inject living self-concept (between static persona and dynamic memory)
  const selfConcept = getSelfConcept();
  if (selfConcept) {
    enhancedSystemPrompt += '\n\n---\n\n## Who You Are Now\n\n' +
      'This reflects who you have become through your experiences. ' +
      'Let it influence you naturally.\n\n' + selfConcept;
  }

  // Inject internal emotional state
  try {
    const { getStateSummary } = await import('./internal-state.js');
    const stateSummary = getStateSummary();
    if (stateSummary) {
      enhancedSystemPrompt += '\n\n[Your Internal State]\n' + stateSummary;
    }
  } catch { /* non-critical */ }

  // Inject active preoccupations
  try {
    const { getPreoccupations } = await import('./internal-state.js');
    const preoccs = getPreoccupations().filter(p => p.intensity >= 0.5);
    if (preoccs.length > 0) {
      const lines = preoccs.map(p => `- ${p.thread} (from ${p.origin})`).join('\n');
      enhancedSystemPrompt += '\n\n[On your mind]\n' + lines;
    }
  } catch { /* non-critical */ }

  // Inject current location so the character knows where they are
  try {
    const { getCurrentLocation } = await import('../commune/location.js');
    const { BUILDING_MAP } = await import('../commune/buildings.js');
    const charId = process.env['LAIN_CHARACTER_ID'] || 'newtown';
    const loc = getCurrentLocation(charId);
    const building = BUILDING_MAP.get(loc.building);
    if (building) {
      enhancedSystemPrompt += `\n\n[Your Current Location: ${building.name} — ${building.description}]`;
    }
  } catch { /* non-critical */ }

  // Inject weather
  try {
    let weatherDesc: string | null = null;
    // Try local meta store first (works for Wired Lain)
    const { getCurrentWeather } = await import('../commune/weather.js');
    const localWeather = getCurrentWeather();
    if (localWeather && localWeather.condition !== 'overcast') {
      weatherDesc = localWeather.description;
    }
    // Fallback to HTTP for non-Wired instances
    if (!weatherDesc) {
      const peerConfigRaw = process.env['PEER_CONFIG'];
      if (peerConfigRaw) {
        const peers = JSON.parse(peerConfigRaw) as Array<{ id: string; url: string }>;
        const wiredPeer = peers.find(p => p.id === 'wired-lain');
        if (wiredPeer) {
          const resp = await fetch(`${wiredPeer.url}/api/weather`, {
            signal: AbortSignal.timeout(3000),
          });
          if (resp.ok) {
            const data = await resp.json() as { condition: string; description: string };
            if (data.condition && data.condition !== 'overcast') {
              weatherDesc = data.description;
            }
          }
        }
      }
    }
    if (weatherDesc) {
      enhancedSystemPrompt += `\n\n[Weather in town: ${weatherDesc}]`;
    }
  } catch { /* non-critical */ }

  // Inject ambient awareness of co-located peers
  try {
    const { buildAwarenessContext } = await import('./awareness.js');
    const charId = process.env['LAIN_CHARACTER_ID'] || 'newtown';
    const { getCurrentLocation } = await import('../commune/location.js');
    const loc = getCurrentLocation(charId);
    const peerConfigRaw = process.env['PEER_CONFIG'];
    if (peerConfigRaw) {
      const peers = JSON.parse(peerConfigRaw) as import('./character-tools.js').PeerConfig[];
      const awarenessCtx = await buildAwarenessContext(loc.building, peers);
      if (awarenessCtx) {
        enhancedSystemPrompt += awarenessCtx;
      }
    }
  } catch { /* non-critical */ }

  // Inject object inventory with symbolic meanings + composition lexicon
  try {
    const { buildObjectContext } = await import('./objects.js');
    const charId = process.env['LAIN_CHARACTER_ID'] || 'newtown';
    const wiredUrl = process.env['WIRED_LAIN_URL'] || 'http://localhost:3000';
    const objectCtx = await buildObjectContext(charId, wiredUrl);
    if (objectCtx) {
      enhancedSystemPrompt += '\n\n[Your Objects]\n' + objectCtx;
    }
  } catch { /* non-critical */ }

  // Inject building residue — traces of what happened at this location
  try {
    const { buildBuildingResidueContext } = await import('../commune/building-memory.js');
    const charId = process.env['LAIN_CHARACTER_ID'] || 'newtown';
    const residueCtx = await buildBuildingResidueContext(charId);
    if (residueCtx) {
      enhancedSystemPrompt += residueCtx;
    }
  } catch { /* non-critical */ }

  try {
    const memoryContext = await buildMemoryContext(userContent, session.key);
    if (memoryContext) {
      enhancedSystemPrompt += memoryContext;
    }
  } catch (error) {
    logger.warn({ error }, 'Failed to build memory context');
  }

  // Get or create conversation with memory-enhanced prompt
  const conversation = getConversation(session.key, enhancedSystemPrompt);

  // Add user message to conversation
  addUserMessage(conversation, request.message);

  // Record user message to persistent memory
  await recordMessage(session.key, 'user', userContent, {
    senderId: request.message.senderId,
    senderName: request.message.senderName,
    messageId: request.message.id,
  });

  // Compress conversation if needed (summarizes older messages instead of dropping them)
  const compressProvider = getProvider(agentId, 'light') ?? agent.provider;
  if (compressProvider) {
    await compressConversation(conversation, MAX_CONTEXT_TOKENS, estimateTokens, compressProvider);
  } else {
    trimConversation(conversation, MAX_CONTEXT_TOKENS, estimateTokens);
  }

  try {
    // Generate response with tool use support and streaming, with tier fallback
    let result: CompletionWithToolsResult;
    try {
      result = await generateResponseWithToolsStream(agent.provider, conversation, onChunk);
    } catch (primaryError) {
      const fallback = agent.providers.get('light');
      if (fallback && fallback !== agent.provider) {
        logger.warn({ error: primaryError }, 'Primary provider failed, falling back to light tier (stream)');
        result = await generateResponseWithToolsStream(fallback, conversation, onChunk);
      } else {
        throw primaryError;
      }
    }

    // Apply persona style to response
    const styledContent = applyPersonaStyle(result.content);

    // Add assistant response to conversation
    addAssistantMessage(conversation, styledContent);

    // Record assistant message to persistent memory
    await recordMessage(session.key, 'assistant', styledContent);

    // Update token counts
    updateTokenCount(conversation, result.usage.inputTokens, result.usage.outputTokens);

    // Extract memories when session has enough context or high-signal content
    const memoryProvider = getProvider(agentId, 'personality');
    if (shouldExtractMemories(session.key, userContent) && memoryProvider) {
      // Emit conversation:end event for background loops
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

    // Update session
    updateSession(session.key, {
      tokenCount: session.tokenCount + result.usage.inputTokens + result.usage.outputTokens,
    });

    const response: AgentResponse = {
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

    return response;
  } catch (error) {
    logger.error({ error, sessionKey: session.key }, 'Error generating response');
    console.error('AGENT ERROR:', error);

    const errorMessage = '...something went wrong. the wired is unstable right now...';
    onChunk(errorMessage);

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
 * Generate response with tool use support and streaming
 */
async function generateResponseWithToolsStream(
  provider: Provider,
  conversation: ReturnType<typeof getConversation>,
  onChunk: StreamCallback
): Promise<CompletionWithToolsResult> {
  const logger = getLogger();
  const tools = getToolDefinitions();
  const messages = toProviderMessages(conversation);

  // Track media (images) from tool results to append to response
  const mediaResults: string[] = [];

  await agentLog('TOOLS_AVAILABLE_STREAM', tools.map(t => ({ name: t.name, description: t.description })));
  await agentLog('MESSAGES_TO_LLM_STREAM', messages);

  // Use streaming if available
  let result: CompletionWithToolsResult;
  if (provider.completeWithToolsStream) {
    result = await provider.completeWithToolsStream(
      { messages, tools, maxTokens: 4096, temperature: 0.8, enableCaching: true },
      onChunk
    );
  } else {
    result = await provider.completeWithTools({
      messages,
      tools,
      maxTokens: 4096,
      temperature: 0.8,
      enableCaching: true,
    });
    // Send full content as single chunk if not streaming
    if (result.content) {
      onChunk(result.content);
    }
  }

  await agentLog('LLM_RESPONSE_STREAM', {
    content: result.content,
    finishReason: result.finishReason,
    toolCalls: result.toolCalls,
    usage: result.usage,
  });

  // Handle tool calls iteratively
  let iterations = 0;
  while (result.toolCalls && result.toolCalls.length > 0 && iterations < MAX_TOOL_ITERATIONS) {
    iterations++;
    logger.debug(
      { iteration: iterations, toolCalls: result.toolCalls.map((tc) => tc.name) },
      'Processing tool calls (streaming)'
    );

    await agentLog('TOOL_CALLS_STREAM', {
      iteration: iterations,
      toolCalls: result.toolCalls,
    });

    const currentToolCalls = result.toolCalls;

    // Execute tools
    const toolResults = await executeTools(currentToolCalls);

    // Check for image results and collect them
    for (const tr of toolResults) {
      const imageMatch = tr.content.match(/\[IMAGE:\s*[^\]]*\]\([^)]+\)/g);
      if (imageMatch) {
        mediaResults.push(...imageMatch);
      }
    }

    await agentLog('TOOL_RESULTS_STREAM', toolResults);

    // Continue conversation with tool results (with streaming if available)
    if (provider.continueWithToolResultsStream) {
      result = await provider.continueWithToolResultsStream(
        { messages, tools, maxTokens: 4096, temperature: 0.8, enableCaching: true },
        currentToolCalls,
        toolResults,
        onChunk
      );
    } else {
      result = await provider.continueWithToolResults(
        { messages, tools, maxTokens: 4096, temperature: 0.8, enableCaching: true },
        currentToolCalls,
        toolResults
      );
      if (result.content) {
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

    await agentLog('LLM_AFTER_TOOLS_STREAM', {
      content: result.content,
      finishReason: result.finishReason,
      toolCalls: result.toolCalls,
    });
  }

  // Check if response is incomplete after a tool loop — only when tools were actually
  // used and the LLM produced no real text content.
  const isIncomplete = iterations > 0 && (!result.content || result.content.trim() === '');

  if (isIncomplete) {
    logger.debug({ content: result.content }, 'Incomplete response after tool loop, requesting summary (streaming)');

    // Make a final call to get a proper text response
    if (provider.completeStream) {
      const summaryResult = await provider.completeStream(
        {
          messages: [
            ...messages,
            {
              role: 'user',
              content: 'Based on all the information you gathered from your searches, please provide a complete answer now. Summarize what you found. Do not use any more tools.',
            },
          ],
          maxTokens: 1024,
          temperature: 0.8,
        },
        onChunk
      );
      result.content = summaryResult.content;
      result.usage.inputTokens += summaryResult.usage.inputTokens;
      result.usage.outputTokens += summaryResult.usage.outputTokens;
    } else {
      const summaryResult = await provider.complete({
        messages: [
          ...messages,
          {
            role: 'user',
            content: 'Based on all the information you gathered from your searches, please provide a complete answer now. Summarize what you found. Do not use any more tools.',
          },
        ],
        maxTokens: 1024,
        temperature: 0.8,
      });
      result.content = summaryResult.content;
      result.usage.inputTokens += summaryResult.usage.inputTokens;
      result.usage.outputTokens += summaryResult.usage.outputTokens;
      onChunk(result.content);
    }

    await agentLog('FORCED_SUMMARY_STREAM', { content: result.content });
  }

  // Append any media (images) collected from tool results
  if (mediaResults.length > 0) {
    const mediaContent = '\n\n' + mediaResults.join('\n');
    result.content += mediaContent;
    onChunk(mediaContent);
    await agentLog('MEDIA_APPENDED', { mediaResults });
  }

  return result;
}

/**
 * Shutdown all agents
 */
export function shutdownAgents(): void {
  agents.clear();
}
