/**
 * Agent pipeline tests — conversation, tools, context
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({ getLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('../src/memory/index.js', () => ({ recordMessage: vi.fn().mockResolvedValue(undefined), buildMemoryContext: vi.fn().mockResolvedValue(''), processConversationEnd: vi.fn().mockResolvedValue(undefined), shouldExtractMemories: vi.fn().mockReturnValue(false) }));
vi.mock('../src/memory/store.js', () => ({ saveMemory: vi.fn().mockResolvedValue({ id: 'm1' }), searchMemories: vi.fn().mockResolvedValue([]), getMemory: vi.fn().mockReturnValue(null), getAssociatedMemories: vi.fn().mockReturnValue([]), updateMemoryAccess: vi.fn(), getPostboardMessages: vi.fn().mockReturnValue([]) }));
vi.mock('../src/storage/sessions.js', () => ({ getOrCreateSession: vi.fn().mockReturnValue({ key: 'test-session', agentId: 'default', channel: 'web', tokenCount: 0 }), updateSession: vi.fn() }));
vi.mock('../src/agent/self-concept.js', () => ({ getSelfConcept: vi.fn().mockReturnValue(null) }));
vi.mock('../src/agent/internal-state.js', () => ({ getStateSummary: vi.fn().mockReturnValue(null), getPreoccupations: vi.fn().mockReturnValue([]) }));
vi.mock('../src/commune/location.js', () => ({ getCurrentLocation: vi.fn().mockReturnValue({ building: 'cafe' }) }));
vi.mock('../src/commune/buildings.js', () => ({ BUILDING_MAP: new Map([['cafe', { name: 'Cyberia Café', description: 'hazy' }]]) }));
vi.mock('../src/commune/weather.js', () => ({
  getCurrentWeather: vi.fn().mockReturnValue(null),
  getTownWeather: vi.fn().mockResolvedValue(null),
  peekCachedTownWeather: vi.fn().mockReturnValue(null),
  startTownWeatherRefreshLoop: vi.fn().mockReturnValue(() => {}),
}));
vi.mock('../src/agent/awareness.js', () => ({ buildAwarenessContext: vi.fn().mockResolvedValue(null) }));
vi.mock('../src/agent/objects.js', () => ({ buildObjectContext: vi.fn().mockResolvedValue(null) }));
vi.mock('../src/commune/building-memory.js', () => ({ buildBuildingResidueContext: vi.fn().mockResolvedValue(null) }));
vi.mock('../src/events/town-events.js', () => ({ getActiveTownEvents: vi.fn().mockReturnValue([]) }));
vi.mock('../src/events/bus.js', () => ({ eventBus: { emitActivity: vi.fn() } }));
vi.mock('../src/agent/letter.js', () => ({ runLetterCycle: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/agent/persona.js', () => ({ loadPersona: vi.fn().mockResolvedValue({ name: 'Lain', soul: 'I am Lain.', agents: '', identity: '' }), buildSystemPrompt: vi.fn().mockReturnValue('You are Lain.'), applyPersonaStyle: vi.fn().mockImplementation((t: string) => t) }));
vi.mock('../src/providers/index.js', () => ({ createProvider: vi.fn() }));
vi.mock('node:fs/promises', async () => { const a = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises'); return { ...a, appendFile: vi.fn().mockResolvedValue(undefined), mkdir: vi.fn().mockResolvedValue(undefined) }; });

import type { Provider, ToolCall } from '../src/providers/base.js';
import { getConversation, addUserMessage, addAssistantMessage, toProviderMessages, trimConversation, compressConversation, updateTokenCount, clearConversation, getActiveConversations, getTextContent } from '../src/agent/conversation.js';
import { registerTool, unregisterTool, getToolDefinitions, executeTool, executeTools, extractTextFromHtml } from '../src/agent/tools.js';
import { initAgent, processMessage, processMessageStream, getAgent, isAgentInitialized, getProvider, shutdownAgents } from '../src/agent/index.js';
import type { AgentConfig } from '../src/types/config.js';
import { createProvider as _createProvider } from '../src/providers/index.js';
import { recordMessage as _recordMessage, buildMemoryContext as _buildMemoryContext, processConversationEnd as _processConversationEnd, shouldExtractMemories as _shouldExtractMemories } from '../src/memory/index.js';
import { getSelfConcept as _getSelfConcept } from '../src/agent/self-concept.js';
import { getStateSummary as _getStateSummary, getPreoccupations as _getPreoccupations } from '../src/agent/internal-state.js';
import { getCurrentLocation as _getCurrentLocation } from '../src/commune/location.js';
import { getCurrentWeather as _getCurrentWeather, getTownWeather as _getTownWeather } from '../src/commune/weather.js';
import { buildAwarenessContext as _buildAwarenessContext } from '../src/agent/awareness.js';
import { applyPersonaStyle as _applyPersonaStyle } from '../src/agent/persona.js';

const mockCP = vi.mocked(_createProvider);
const mockRecordMsg = vi.mocked(_recordMessage);
const mockMemCtx = vi.mocked(_buildMemoryContext);
const mockProcEnd = vi.mocked(_processConversationEnd);
const mockShouldExtract = vi.mocked(_shouldExtractMemories);
const mockSelfConcept = vi.mocked(_getSelfConcept);
const mockStateSummary = vi.mocked(_getStateSummary);
const mockPreoccs = vi.mocked(_getPreoccupations);
const mockGetLoc = vi.mocked(_getCurrentLocation);
const mockWeather = vi.mocked(_getCurrentWeather);
const mockTownWeather = vi.mocked(_getTownWeather);
const mockAwareness = vi.mocked(_buildAwarenessContext);
const mockStyle = vi.mocked(_applyPersonaStyle);

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    name: 'mock', model: 'mock-model', supportsStreaming: false,
    getModelInfo: () => ({ contextWindow: 100000, maxOutputTokens: 4096, supportsVision: false, supportsStreaming: false, supportsTools: true }),
    complete: vi.fn().mockResolvedValue({ content: 'Summary.', finishReason: 'stop', usage: { inputTokens: 3, outputTokens: 3 } }),
    completeWithTools: vi.fn().mockResolvedValue({ content: 'Hello!', finishReason: 'stop', toolCalls: undefined, usage: { inputTokens: 10, outputTokens: 5 } }),
    continueWithToolResults: vi.fn().mockResolvedValue({ content: 'Done!', finishReason: 'stop', toolCalls: undefined, usage: { inputTokens: 5, outputTokens: 3 } }),
    ...overrides,
  };
}

function makeRequest(text = 'hello', extras: Record<string, unknown> = {}) {
  return { sessionKey: 'test-session', message: { id: 'msg-1', channel: 'web' as const, peerKind: 'user' as const, peerId: 'peer-1', senderId: 'user-1', senderName: 'Alice', content: { type: 'text' as const, text }, timestamp: Date.now(), ...extras } };
}

function makeTc(name: string, input: Record<string, unknown> = {}): ToolCall {
  return { id: `tc-${name}`, name, input };
}

const BASE_CFG: AgentConfig = { id: 'default', workspace: '/tmp/ws', providers: [{ type: 'anthropic', model: 'test', apiKey: 'k' }] };
const est = (t: string) => t.length;

// ═══════════════════════════════════════════════════════════════════
// 1. CONVERSATION MANAGEMENT
// ═══════════════════════════════════════════════════════════════════

describe('conversation management', () => {
  const SK = 'conv-sk';
  afterEach(() => clearConversation(SK));

  it('creates conversation', () => { const c = getConversation(SK, 'sys'); expect(c.sessionKey).toBe(SK); expect(c.messages).toHaveLength(0); });
  it('returns same object on second call', () => { expect(getConversation(SK, 's')).toBe(getConversation(SK, 's')); });
  it('preserves original systemPrompt', () => { getConversation(SK, 'orig'); expect(getConversation(SK, 'new').systemPrompt).toBe('orig'); });
  it('starts with tokenCount 0', () => { expect(getConversation(SK, 'sys').tokenCount).toBe(0); });
  it('adds user text message', () => { const c = getConversation(SK, 'sys'); addUserMessage(c, makeRequest('hi').message); expect(c.messages[0]?.role).toBe('user'); expect(c.messages[0]?.content).toBe('hi'); });
  it('adds assistant message', () => { const c = getConversation(SK, 'sys'); addAssistantMessage(c, 'reply'); expect(c.messages[0]?.role).toBe('assistant'); expect(c.messages[0]?.content).toBe('reply'); });
  it('maintains message ordering', () => { const c = getConversation(SK, 'sys'); addUserMessage(c, makeRequest('A').message); addAssistantMessage(c, 'B'); addUserMessage(c, makeRequest('C').message); expect(c.messages.map(m => m.content)).toEqual(['A', 'B', 'C']); });
  it('stores timestamp and senderId', () => { const c = getConversation(SK, 's'); const m = makeRequest('hi').message; addUserMessage(c, m); expect(c.messages[0]?.timestamp).toBe(m.timestamp); expect(c.messages[0]?.metadata?.senderId).toBe('user-1'); });
  it('image message becomes ContentBlock array', () => { const c = getConversation(SK, 's'); const m = { ...makeRequest().message, content: { type: 'image' as const, base64: 'x', mimeType: 'image/jpeg', caption: 'hi' } }; addUserMessage(c, m); expect(Array.isArray(c.messages[0]?.content)).toBe(true); });
  it('image caption used as text block', () => { const c = getConversation(SK, 's'); const m = { ...makeRequest().message, content: { type: 'image' as const, mimeType: 'image/png', caption: 'myCaption' } }; addUserMessage(c, m); const blks = c.messages[0]?.content as Array<{ type: string; text?: string }>; expect(blks.find(b => b.type === 'text')?.text).toBe('myCaption'); });
  it('image without caption uses default question', () => { const c = getConversation(SK, 's'); const m = { ...makeRequest().message, content: { type: 'image' as const, mimeType: 'image/jpeg' } }; addUserMessage(c, m); const blks = c.messages[0]?.content as Array<{ type: string; text?: string }>; expect(blks.find(b => b.type === 'text')?.text).toBe('What do you see in this image?'); });
  it('non-text/image becomes bracketed string', () => { const c = getConversation(SK, 's'); const m = { ...makeRequest().message, content: { type: 'audio' as const, mimeType: 'audio/ogg' } }; addUserMessage(c, m); expect(c.messages[0]?.content).toBe('[audio]'); });
  it('toProviderMessages starts with system', () => { const c = getConversation(SK, 'mySys'); expect(toProviderMessages(c)[0]?.role).toBe('system'); expect(toProviderMessages(c)[0]?.content).toBe('mySys'); });
  it('toProviderMessages includes messages', () => { const c = getConversation(SK, 's'); addUserMessage(c, makeRequest('Q').message); addAssistantMessage(c, 'A'); expect(toProviderMessages(c)).toHaveLength(3); });
  it('toProviderMessages with no messages returns only system', () => { const c = getConversation(SK, 's'); expect(toProviderMessages(c)).toHaveLength(1); });
  it('updateTokenCount accumulates', () => { const c = getConversation(SK, 's'); updateTokenCount(c, 100, 50); updateTokenCount(c, 200, 100); expect(c.tokenCount).toBe(450); });
  it('clearConversation true when present', () => { getConversation(SK, 's'); expect(clearConversation(SK)).toBe(true); });
  it('clearConversation false when absent', () => { expect(clearConversation('nope')).toBe(false); });
  it('getActiveConversations includes open sessions', () => { getConversation(SK, 's'); expect(getActiveConversations()).toContain(SK); });
  it('getTextContent returns string as-is', () => { expect(getTextContent('hello')).toBe('hello'); });
  it('getTextContent extracts from blocks', () => { expect(getTextContent([{ type: 'text' as const, text: 'world' }])).toBe('world'); });
  it('getTextContent skips image blocks', () => { const blks = [{ type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data: 'x' } }, { type: 'text' as const, text: 'cap' }]; expect(getTextContent(blks)).toBe('cap'); });
  it('distinct keys return distinct objects', () => { const a = getConversation('k1', 's'); const b = getConversation('k2', 's'); expect(a).not.toBe(b); clearConversation('k1'); clearConversation('k2'); });
});

// ─── trimConversation ─────────────────────────────────────────────

describe('trimConversation', () => {
  const SK = 'trim-sk';
  afterEach(() => clearConversation(SK));

  it('does not trim below 4 messages', () => { const c = getConversation(SK, 'sys'); for (let i = 0; i < 2; i++) { addUserMessage(c, makeRequest('u').message); addAssistantMessage(c, 'a'); } trimConversation(c, 1, est); expect(c.messages.length).toBeGreaterThanOrEqual(4); });
  it('trims oldest pair when over limit', () => { const c = getConversation(SK, 'x'); for (let i = 0; i < 5; i++) { addUserMessage(c, makeRequest('u'.repeat(100)).message); addAssistantMessage(c, 'a'.repeat(100)); } const before = c.messages.length; trimConversation(c, 10, est); expect(c.messages.length).toBeLessThan(before); });
  it('stops when within token limit', () => { const c = getConversation(SK, 's'); for (let i = 0; i < 2; i++) { addUserMessage(c, makeRequest('hi').message); addAssistantMessage(c, 'ok'); } trimConversation(c, 100000, est); expect(c.messages).toHaveLength(4); });
});

// ─── compressConversation ─────────────────────────────────────────

describe('compressConversation', () => {
  const SK = 'compress-sk';
  afterEach(() => clearConversation(SK));

  it('skips when under 80% budget', async () => { const p = makeProvider(); const c = getConversation(SK, 'sys'); addUserMessage(c, makeRequest('hi').message); addAssistantMessage(c, 'hey'); await compressConversation(c, 100000, est, p); expect(p.complete).not.toHaveBeenCalled(); });
  it('compresses when over 80% budget', async () => { const p = makeProvider({ complete: vi.fn().mockResolvedValue({ content: '• s', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }) }); const c = getConversation(SK, 'x'); for (let i = 0; i < 10; i++) { addUserMessage(c, makeRequest('x'.repeat(50)).message); addAssistantMessage(c, 'y'.repeat(50)); } await compressConversation(c, 100, est, p); expect(p.complete).toHaveBeenCalled(); });
  it('inserts summary as first assistant message', async () => { const p = makeProvider({ complete: vi.fn().mockResolvedValue({ content: '• bullet', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }) }); const c = getConversation(SK, 'x'); for (let i = 0; i < 8; i++) { addUserMessage(c, makeRequest('x'.repeat(100)).message); addAssistantMessage(c, 'y'.repeat(100)); } await compressConversation(c, 1000, est, p); expect(c.messages[0]?.role).toBe('assistant'); expect(c.messages[0]?.content).toContain('[Earlier in this conversation]'); });
  it('falls back to trim on provider error', async () => { const p = makeProvider({ complete: vi.fn().mockRejectedValue(new Error('fail')) }); const c = getConversation(SK, 'x'); for (let i = 0; i < 10; i++) { addUserMessage(c, makeRequest('x'.repeat(50)).message); addAssistantMessage(c, 'y'.repeat(50)); } const before = c.messages.length; await compressConversation(c, 10, est, p); expect(c.messages.length).toBeLessThanOrEqual(before); });
  it('skips when too few messages', async () => { const p = makeProvider(); const c = getConversation(SK, 'x'.repeat(1000)); addUserMessage(c, makeRequest('hi').message); addAssistantMessage(c, 'hey'); await compressConversation(c, 10, est, p); expect(p.complete).not.toHaveBeenCalled(); });
});

// ═══════════════════════════════════════════════════════════════════
// 2. TOOL REGISTRY & EXECUTION
// ═══════════════════════════════════════════════════════════════════

describe('tool registry', () => {
  const TN = '__test_tool__';
  afterEach(() => unregisterTool(TN));

  it('registers and lists tool', () => { registerTool({ definition: { name: TN, description: 'x', inputSchema: {} }, handler: async () => 'ok' }); expect(getToolDefinitions().some(d => d.name === TN)).toBe(true); });
  it('unregisters tool', () => { registerTool({ definition: { name: TN, description: 'x', inputSchema: {} }, handler: async () => 'ok' }); unregisterTool(TN); expect(getToolDefinitions().some(d => d.name === TN)).toBe(false); });
  it('unregisterTool returns false for unknown', () => { expect(unregisterTool('nope')).toBe(false); });
  it('includes builtin get_current_time', () => { expect(getToolDefinitions().some(d => d.name === 'get_current_time')).toBe(true); });
  it('includes builtin calculate', () => { expect(getToolDefinitions().some(d => d.name === 'calculate')).toBe(true); });
  it('includes builtin remember', () => { expect(getToolDefinitions().some(d => d.name === 'remember')).toBe(true); });
  it('includes builtin recall', () => { expect(getToolDefinitions().some(d => d.name === 'recall')).toBe(true); });
  it('includes builtin web_search', () => { expect(getToolDefinitions().some(d => d.name === 'web_search')).toBe(true); });
  it('includes builtin fetch_webpage', () => { expect(getToolDefinitions().some(d => d.name === 'fetch_webpage')).toBe(true); });
});

describe('executeTool', () => {
  const TN = '__exec_test__';
  afterEach(() => unregisterTool(TN));

  it('executes tool and returns content', async () => { registerTool({ definition: { name: TN, description: 'x', inputSchema: {} }, handler: async () => 'result' }); const r = await executeTool(makeTc(TN)); expect(r.content).toBe('result'); expect(r.isError).toBeUndefined(); });
  it('error for unknown tool', async () => { const r = await executeTool(makeTc('__nope__')); expect(r.isError).toBe(true); expect(r.content).toContain('Unknown tool'); });
  it('error when handler throws', async () => { registerTool({ definition: { name: TN, description: 'x', inputSchema: {} }, handler: async () => { throw new Error('boom'); } }); const r = await executeTool(makeTc(TN)); expect(r.isError).toBe(true); expect(r.content).not.toContain('boom'); expect(r.content).toMatch(/incident [0-9a-f]+/); });
  it('toolCallId matches input id', async () => { registerTool({ definition: { name: TN, description: 'x', inputSchema: {} }, handler: async () => 'ok' }); expect((await executeTool({ id: 'my-id', name: TN, input: {} })).toolCallId).toBe('my-id'); });
  it('passes input to handler', async () => { let got: Record<string, unknown> = {}; registerTool({ definition: { name: TN, description: 'x', inputSchema: {} }, handler: async (i) => { got = i; return 'ok'; } }); await executeTool({ id: 'x', name: TN, input: { k: 'v' } }); expect(got['k']).toBe('v'); });
});

describe('executeTools', () => {
  const A = '__et_a__'; const B = '__et_b__';
  afterEach(() => { unregisterTool(A); unregisterTool(B); });

  it('runs multiple tools in parallel', async () => { registerTool({ definition: { name: A, description: 'x', inputSchema: {} }, handler: async () => 'ra' }); registerTool({ definition: { name: B, description: 'x', inputSchema: {} }, handler: async () => 'rb' }); const r = await executeTools([makeTc(A), makeTc(B)]); expect(r.map(x => x.content)).toContain('ra'); expect(r.map(x => x.content)).toContain('rb'); });
  it('handles empty array', async () => { expect(await executeTools([])).toHaveLength(0); });
  it('errors alongside successes', async () => { registerTool({ definition: { name: A, description: 'x', inputSchema: {} }, handler: async () => 'ok' }); const r = await executeTools([makeTc(A), makeTc('__missing__')]); expect(r.find(x => x.content === 'ok')).toBeDefined(); expect(r.find(x => x.isError)).toBeDefined(); });
});

describe('calculate tool', () => {
  it('simple arithmetic', async () => { expect((await executeTool({ id: 'x', name: 'calculate', input: { expression: '2 + 2' } })).content).toContain('4'); });
  it('division', async () => { expect((await executeTool({ id: 'x', name: 'calculate', input: { expression: '10 / 4' } })).content).toContain('2.5'); });
  it('malformed expression does not throw', async () => { expect(typeof (await executeTool({ id: 'x', name: 'calculate', input: { expression: 'not math' } })).content).toBe('string'); });
});

describe('get_current_time tool', () => {
  it('returns time string', async () => { expect((await executeTool({ id: 'x', name: 'get_current_time', input: {} })).content).toMatch(/time/i); });
  it('handles invalid timezone', async () => { expect(typeof (await executeTool({ id: 'x', name: 'get_current_time', input: { timezone: 'Bad/Zone' } })).content).toBe('string'); });
});

describe('extractTextFromHtml', () => {
  it('strips script tags', () => { expect(extractTextFromHtml('<script>alert(1)</script>hi')).not.toContain('alert'); });
  it('strips style tags', () => { expect(extractTextFromHtml('<style>body{}</style>text')).not.toContain('body{}'); });
  it('extracts text', () => { expect(extractTextFromHtml('<p>Hello</p>')).toContain('Hello'); });
  it('decodes html entities', () => { expect(extractTextFromHtml('&amp;')).toContain('&'); });
  it('prefers main over nav', () => { expect(extractTextFromHtml('<nav>nav</nav><main>main</main>')).toContain('main'); });
  it('handles empty string', () => { expect(() => extractTextFromHtml('')).not.toThrow(); });
});

// ═══════════════════════════════════════════════════════════════════
// 3. AGENT INIT & STATE
// ═══════════════════════════════════════════════════════════════════

describe('agent init & state', () => {
  beforeEach(() => { shutdownAgents(); mockCP.mockReturnValue(makeProvider()); });
  afterEach(() => shutdownAgents());

  it('not initialized before init', () => { expect(isAgentInitialized('default')).toBe(false); });
  it('initialized after initAgent', async () => { await initAgent(BASE_CFG); expect(isAgentInitialized('default')).toBe(true); });
  it('getAgent undefined before init', () => { expect(getAgent('default')).toBeUndefined(); });
  it('getAgent defined after init', async () => { await initAgent(BASE_CFG); expect(getAgent('default')).toBeDefined(); });
  it('getProvider null for unknown agent', () => { expect(getProvider('unknown', 'personality')).toBeNull(); });
  it('getProvider defined after init', async () => { await initAgent(BASE_CFG); expect(getProvider('default', 'personality')).toBeDefined(); });
  it('getProvider falls back for missing tier', async () => { await initAgent(BASE_CFG); expect(getProvider('default', 'light')).not.toBeNull(); });
  it('shutdownAgents clears state', async () => { await initAgent(BASE_CFG); shutdownAgents(); expect(isAgentInitialized('default')).toBe(false); });
  // findings.md P2:1737 — no-silent-echo-mode. Used to swallow provider init
  // failure and silently boot into echo mode; now crashes loud so systemd
  // restarts and the failure is visible in unit logs.
  it('findings.md P2:1737 — initAgent throws when no providers init', async () => { mockCP.mockImplementationOnce(() => { throw new Error('no key'); }); await expect(initAgent(BASE_CFG)).rejects.toThrow(/no providers could be initialized/); });
  it('findings.md P2:1737 — error message names tier, type, model', async () => { mockCP.mockImplementationOnce(() => { throw new Error('no key'); }); await expect(initAgent(BASE_CFG)).rejects.toThrow(/personality:anthropic\/test/); });
  // findings.md P2:1727 — single-tenant invariant. A second init in
  // the same process used to silently add dead state.
  it('findings.md P2:1727 — initAgent throws on double-init', async () => {
    mockCP.mockReturnValue(makeProvider());
    await initAgent(BASE_CFG);
    await expect(initAgent({ ...BASE_CFG, id: 'other' })).rejects.toThrow(/single-tenant/);
    shutdownAgents();
    await expect(initAgent(BASE_CFG)).resolves.not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. processMessage()
// ═══════════════════════════════════════════════════════════════════

describe('processMessage — echo mode', () => {
  beforeEach(() => shutdownAgents());
  afterEach(() => shutdownAgents());

  it('returns sessionKey', async () => { expect((await processMessage(makeRequest('hello'))).sessionKey).toBe('test-session'); });
  it('returns at least one message', async () => { expect((await processMessage(makeRequest('hi'))).messages.length).toBeGreaterThanOrEqual(1); });
  it('greeting response for hello', async () => { const c = (await processMessage(makeRequest('hello'))).messages[0]?.content; if (c && 'text' in c) expect(c.text).toMatch(/hello/i); });
  // findings.md P2:1747 — generic echo copy. Used to say "i'm lain...lain iwakura"
  // which leaked identity on non-Lain characters. Must not claim any identity.
  it('self-intro for who-are-you is character-agnostic', async () => { const c = (await processMessage(makeRequest('who are you'))).messages[0]?.content; if (c && 'text' in c) { expect(c.text.toLowerCase()).not.toContain('lain'); expect(c.text.toLowerCase()).not.toContain('iwakura'); } });
  it('fallback echo for unknown', async () => { const c = (await processMessage(makeRequest('xyzzy'))).messages[0]?.content; if (c && 'text' in c) expect(c.text).toContain('xyzzy'); });
  it('echo for non-text content', async () => { const req = { ...makeRequest(), message: { ...makeRequest().message, content: { type: 'image' as const, mimeType: 'image/jpeg' } } }; const c = (await processMessage(req)).messages[0]?.content; if (c && 'text' in c) expect(typeof c.text).toBe('string'); });
  it('replyTo matches message id', async () => { expect((await processMessage(makeRequest('hi'))).messages[0]?.replyTo).toBe('msg-1'); });
});

describe('processMessage — with provider', () => {
  beforeEach(async () => { shutdownAgents(); clearConversation('test-session'); mockCP.mockReturnValue(makeProvider()); await initAgent(BASE_CFG); });
  afterEach(() => { shutdownAgents(); clearConversation('test-session'); });

  it('returns content from provider', async () => { const c = (await processMessage(makeRequest('hi'))).messages[0]?.content; if (c && 'text' in c) expect(c.text).toBe('Hello!'); });
  it('returns correct tokenUsage', async () => { const r = await processMessage(makeRequest('hi')); expect(r.tokenUsage?.total).toBe(15); });
  it('applyPersonaStyle called', async () => { await processMessage(makeRequest('hi')); expect(mockStyle).toHaveBeenCalledWith('Hello!'); });
  it('recordMessage called for user', async () => { await processMessage(makeRequest('hello')); expect(mockRecordMsg).toHaveBeenCalledWith('test-session', 'user', 'hello', expect.any(Object)); });
  it('recordMessage called for assistant', async () => { await processMessage(makeRequest('hi')); expect(mockRecordMsg).toHaveBeenCalledWith('test-session', 'assistant', expect.any(String)); });
  it('buildMemoryContext called with content', async () => { mockMemCtx.mockClear(); await processMessage(makeRequest('query')); expect(mockMemCtx).toHaveBeenCalledWith('query', 'test-session', expect.anything()); });
  it('provider called after memory context injected', async () => { mockMemCtx.mockResolvedValueOnce('## Mem'); await processMessage(makeRequest('hi')); expect(getProvider('default', 'personality')!.completeWithTools).toHaveBeenCalled(); });
  it('error returns error message', async () => { mockCP.mockReturnValue(makeProvider({ completeWithTools: vi.fn().mockRejectedValue(new Error('fail')) })); shutdownAgents(); await initAgent(BASE_CFG); const c = (await processMessage(makeRequest('hi'))).messages[0]?.content; if (c && 'text' in c) expect(c.text).toContain('went wrong'); });
  it('error has no tokenUsage', async () => { mockCP.mockReturnValue(makeProvider({ completeWithTools: vi.fn().mockRejectedValue(new Error('fail')) })); shutdownAgents(); await initAgent(BASE_CFG); expect((await processMessage(makeRequest('hi'))).tokenUsage).toBeUndefined(); });
  it('falls back to light provider on primary failure', async () => { const light = makeProvider(); const fail = makeProvider({ completeWithTools: vi.fn().mockRejectedValue(new Error('primary')) }); mockCP.mockReturnValueOnce(fail).mockReturnValueOnce(makeProvider()).mockReturnValueOnce(light); shutdownAgents(); await initAgent({ ...BASE_CFG, providers: [{ type: 'anthropic', model: 'p', apiKey: 'k1' }, { type: 'anthropic', model: 'm', apiKey: 'k2' }, { type: 'anthropic', model: 'l', apiKey: 'k3' }] }); await processMessage(makeRequest('hi')); expect(light.completeWithTools).toHaveBeenCalled(); });
  it('handles empty message', async () => { await expect(processMessage(makeRequest(''))).resolves.toBeDefined(); });
  it('handles very long message', async () => { await expect(processMessage(makeRequest('a'.repeat(50000)))).resolves.toBeDefined(); });
  it('handles whitespace-only message', async () => { await expect(processMessage(makeRequest('   '))).resolves.toBeDefined(); });
  it('handles unicode', async () => { await expect(processMessage(makeRequest('こんにちは 🌸'))).resolves.toBeDefined(); });
  it('message id is truthy', async () => { expect((await processMessage(makeRequest('hi'))).messages[0]?.id).toBeTruthy(); });
  it('channel matches request', async () => { expect((await processMessage(makeRequest('hi'))).messages[0]?.channel).toBe('web'); });
});

// ─── Tool loop ────────────────────────────────────────────────────

describe('processMessage — tool loop', () => {
  afterEach(() => { shutdownAgents(); clearConversation('test-session'); });

  it('tool loop executes once for single tool call', async () => {
    const ctwr = vi.fn().mockResolvedValue({ content: 'time!', finishReason: 'stop', toolCalls: undefined, usage: { inputTokens: 5, outputTokens: 3 } });
    mockCP.mockReturnValue(makeProvider({ completeWithTools: vi.fn().mockResolvedValue({ content: '', finishReason: 'stop', toolCalls: [makeTc('get_current_time')], usage: { inputTokens: 10, outputTokens: 5 } }), continueWithToolResults: ctwr }));
    shutdownAgents(); await initAgent(BASE_CFG);
    await processMessage(makeRequest('time?'));
    expect(ctwr).toHaveBeenCalledTimes(1);
  });

  it('requests summary when content empty after tool loop', async () => {
    const complete = vi.fn().mockResolvedValue({ content: 'Summary!', finishReason: 'stop', usage: { inputTokens: 2, outputTokens: 2 } });
    mockCP.mockReturnValue(makeProvider({ completeWithTools: vi.fn().mockResolvedValue({ content: '', finishReason: 'stop', toolCalls: [makeTc('get_current_time')], usage: { inputTokens: 5, outputTokens: 3 } }), continueWithToolResults: vi.fn().mockResolvedValue({ content: '', finishReason: 'stop', toolCalls: undefined, usage: { inputTokens: 2, outputTokens: 1 } }), complete }));
    shutdownAgents(); await initAgent(BASE_CFG);
    const resp = await processMessage(makeRequest('search'));
    expect(complete).toHaveBeenCalled();
    const c = resp.messages[0]?.content; if (c && 'text' in c) expect(c.text).toBe('Summary!');
  });

  it('stops tool loop at MAX_TOOL_ITERATIONS (8)', async () => {
    const tc = makeTc('get_current_time');
    const ctwr = vi.fn().mockResolvedValue({ content: '', finishReason: 'stop', toolCalls: [tc], usage: { inputTokens: 1, outputTokens: 1 } });
    mockCP.mockReturnValue(makeProvider({ completeWithTools: vi.fn().mockResolvedValue({ content: '', finishReason: 'stop', toolCalls: [tc], usage: { inputTokens: 1, outputTokens: 1 } }), continueWithToolResults: ctwr, complete: vi.fn().mockResolvedValue({ content: 'ok', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }) }));
    shutdownAgents(); await initAgent(BASE_CFG);
    await processMessage(makeRequest('loop'));
    expect(ctwr.mock.calls.length).toBeLessThanOrEqual(8);
  });

  it('appends image from tool results', async () => {
    const imgTool = '__img__';
    registerTool({ definition: { name: imgTool, description: 'i', inputSchema: {} }, handler: async () => '[IMAGE: cat](https://x.com/cat.jpg)' });
    mockCP.mockReturnValue(makeProvider({ completeWithTools: vi.fn().mockResolvedValue({ content: 'here', finishReason: 'stop', toolCalls: [makeTc(imgTool)], usage: { inputTokens: 5, outputTokens: 3 } }), continueWithToolResults: vi.fn().mockResolvedValue({ content: 'here', finishReason: 'stop', toolCalls: undefined, usage: { inputTokens: 3, outputTokens: 2 } }) }));
    shutdownAgents(); await initAgent(BASE_CFG);
    const resp = await processMessage(makeRequest('cat'));
    unregisterTool(imgTool);
    const c = resp.messages[0]?.content; if (c && 'text' in c) expect(c.text).toContain('[IMAGE:');
  });

  it('no tools = no continueWithToolResults', async () => {
    const ctwr = vi.fn();
    mockCP.mockReturnValue(makeProvider({ completeWithTools: vi.fn().mockResolvedValue({ content: 'direct', finishReason: 'stop', toolCalls: undefined, usage: { inputTokens: 5, outputTokens: 3 } }), continueWithToolResults: ctwr }));
    shutdownAgents(); await initAgent(BASE_CFG);
    await processMessage(makeRequest('simple'));
    expect(ctwr).not.toHaveBeenCalled();
  });

  it('length finishReason requests continuation instead of returning only partial content', async () => {
    const complete = vi.fn().mockResolvedValue({ content: ' finished.', finishReason: 'stop', usage: { inputTokens: 4, outputTokens: 2 } });
    mockCP.mockReturnValue(makeProvider({ completeWithTools: vi.fn().mockResolvedValue({ content: 'partial...', finishReason: 'length', toolCalls: undefined, usage: { inputTokens: 10, outputTokens: 8192 } }), complete }));
    shutdownAgents(); await initAgent(BASE_CFG);
    const c = (await processMessage(makeRequest('novel'))).messages[0]?.content;
    if (c && 'text' in c) expect(c.text).toBe('partial... finished.');
    expect(complete).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. processMessageStream()
// ═══════════════════════════════════════════════════════════════════

describe('processMessageStream — echo mode', () => {
  beforeEach(() => shutdownAgents());
  afterEach(() => shutdownAgents());

  it('onChunk called with echo text', async () => { const chunks: string[] = []; await processMessageStream(makeRequest('hello'), c => chunks.push(c)); expect(chunks.join('')).toMatch(/hello/i); });
  it('returns sessionKey', async () => { expect((await processMessageStream(makeRequest('hi'), () => {})).sessionKey).toBe('test-session'); });
});

describe('processMessageStream — with provider', () => {
  beforeEach(async () => { shutdownAgents(); clearConversation('test-session'); mockCP.mockReturnValue(makeProvider()); await initAgent(BASE_CFG); });
  afterEach(() => { shutdownAgents(); clearConversation('test-session'); });

  it('onChunk called with content', async () => { const chunks: string[] = []; await processMessageStream(makeRequest('hi'), c => chunks.push(c)); expect(chunks.join('')).toContain('Hello!'); });
  it('uses completeWithToolsStream when present (findings.md P2:818)', async () => { const sf = vi.fn().mockImplementation(async (_: unknown, cb: (c: string) => void) => { cb('stream'); return { content: 'stream', finishReason: 'stop', toolCalls: undefined, usage: { inputTokens: 3, outputTokens: 3 } }; }); mockCP.mockReturnValue(makeProvider({ supportsStreaming: true, completeWithToolsStream: sf })); shutdownAgents(); await initAgent(BASE_CFG); const chunks: string[] = []; await processMessageStream(makeRequest('hi'), c => chunks.push(c)); expect(sf).toHaveBeenCalled(); expect(chunks).toContain('stream'); });
  it('onChunk called with error on provider failure', async () => { mockCP.mockReturnValue(makeProvider({ completeWithTools: vi.fn().mockRejectedValue(new Error('fail')) })); shutdownAgents(); await initAgent(BASE_CFG); const chunks: string[] = []; await processMessageStream(makeRequest('hi'), c => chunks.push(c)); expect(chunks.join('')).toContain('went wrong'); });
  it('returns full AgentResponse', async () => { const r = await processMessageStream(makeRequest('hi'), () => {}); expect(r.messages).toHaveLength(1); expect(r.sessionKey).toBe('test-session'); });
  it('tokenUsage present on success', async () => { expect((await processMessageStream(makeRequest('hi'), () => {})).tokenUsage?.total).toBe(15); });
  it('falls back to continueWithToolResults if no stream variant', async () => { const ctwr = vi.fn().mockResolvedValue({ content: 'ok', finishReason: 'stop', toolCalls: undefined, usage: { inputTokens: 2, outputTokens: 2 } }); mockCP.mockReturnValue(makeProvider({ completeWithTools: vi.fn().mockResolvedValue({ content: '', finishReason: 'stop', toolCalls: [makeTc('get_current_time')], usage: { inputTokens: 5, outputTokens: 3 } }), continueWithToolResults: ctwr })); shutdownAgents(); await initAgent(BASE_CFG); await processMessageStream(makeRequest('hi'), () => {}); expect(ctwr).toHaveBeenCalled(); });
});

// ═══════════════════════════════════════════════════════════════════
// 6. CONTEXT BUILDING
// ═══════════════════════════════════════════════════════════════════

describe('context building', () => {
  beforeEach(async () => { shutdownAgents(); clearConversation('test-session'); mockCP.mockReturnValue(makeProvider()); await initAgent(BASE_CFG); });
  afterEach(() => { shutdownAgents(); clearConversation('test-session'); });

  function getSysPrompt() {
    const p = getProvider('default', 'personality')!;
    const calls = (p.completeWithTools as ReturnType<typeof vi.fn>).mock.calls;
    return calls[calls.length - 1]?.[0]?.messages?.find((m: { role: string }) => m.role === 'system')?.content ?? '';
  }

  it('getSelfConcept called', async () => { await processMessage(makeRequest('hi')); expect(mockSelfConcept).toHaveBeenCalled(); });
  it('self-concept injected when present', async () => { mockSelfConcept.mockReturnValueOnce('I have grown curious.'); await processMessage(makeRequest('hi')); expect(getSysPrompt()).toContain('I have grown curious.'); });
  it('getStateSummary called', async () => { await processMessage(makeRequest('hi')); expect(mockStateSummary).toHaveBeenCalled(); });
  it('state summary injected when present', async () => { mockStateSummary.mockReturnValueOnce('energy: 0.7'); await processMessage(makeRequest('hi')); expect(getSysPrompt()).toContain('energy: 0.7'); });
  it('getPreoccupations called', async () => { await processMessage(makeRequest('hi')); expect(mockPreoccs).toHaveBeenCalled(); });
  it('high-intensity preoccupation injected', async () => { mockPreoccs.mockReturnValueOnce([{ thread: 'consciousness', origin: 'diary', intensity: 0.8 }]); await processMessage(makeRequest('hi')); expect(getSysPrompt()).toContain('consciousness'); });
  it('low-intensity preoccupation not injected', async () => { mockPreoccs.mockReturnValueOnce([{ thread: 'faint whisper', origin: 'x', intensity: 0.3 }]); await processMessage(makeRequest('hi')); expect(getSysPrompt()).not.toContain('faint whisper'); });
  it('getCurrentLocation called', async () => { await processMessage(makeRequest('hi')); expect(mockGetLoc).toHaveBeenCalled(); });
  it('location injected when building found', async () => { mockGetLoc.mockReturnValueOnce({ building: 'cafe' }); await processMessage(makeRequest('hi')); expect(getSysPrompt()).toContain('Cyberia Café'); });
  it('non-overcast weather injected', async () => { mockTownWeather.mockResolvedValueOnce({ condition: 'rain', description: 'Grey drizzle.', intensity: 0.5, computed_at: Date.now() }); await processMessage(makeRequest('hi')); expect(getSysPrompt()).toContain('Grey drizzle.'); void mockWeather; });
  it('overcast weather not injected', async () => { mockTownWeather.mockResolvedValueOnce({ condition: 'overcast', description: 'Overcast skies.', intensity: 0.5, computed_at: Date.now() }); await processMessage(makeRequest('hi')); expect(getSysPrompt()).not.toContain('Overcast skies.'); });
  it('awareness injected when peer config present', async () => { mockAwareness.mockResolvedValueOnce('\n\n[Nearby: X]'); const orig = process.env['PEER_CONFIG']; process.env['PEER_CONFIG'] = JSON.stringify([{ id: 'wired-lain', url: 'http://localhost:3000' }]); await processMessage(makeRequest('hi')); expect(mockAwareness).toHaveBeenCalled(); process.env['PEER_CONFIG'] = orig; });
  it('buildMemoryContext failure handled gracefully', async () => { mockMemCtx.mockRejectedValueOnce(new Error('db')); await expect(processMessage(makeRequest('hi'))).resolves.toBeDefined(); });
  it('shouldExtractMemories triggers processConversationEnd', async () => { mockShouldExtract.mockReturnValueOnce(true); await processMessage(makeRequest('hi')); await new Promise(r => setTimeout(r, 50)); expect(mockProcEnd).toHaveBeenCalled(); });
});

// ═══════════════════════════════════════════════════════════════════
// 7. EDGE CASES
// ═══════════════════════════════════════════════════════════════════

describe('edge cases', () => {
  afterEach(() => { shutdownAgents(); clearConversation('test-session'); });

  it('concurrent processMessages all succeed', async () => { mockCP.mockReturnValue(makeProvider()); await initAgent(BASE_CFG); const results = await Promise.all([processMessage(makeRequest('a')), processMessage(makeRequest('b')), processMessage(makeRequest('c'))]); expect(results).toHaveLength(3); results.forEach(r => expect(r.sessionKey).toBeDefined()); shutdownAgents(); });
  it('response content never undefined', async () => { mockCP.mockReturnValue(makeProvider()); await initAgent(BASE_CFG); const c = (await processMessage(makeRequest('hi'))).messages[0]?.content; expect(c).toBeDefined(); if (c && 'text' in c) expect(typeof c.text).toBe('string'); shutdownAgents(); });
  it('response id always truthy', async () => { mockCP.mockReturnValue(makeProvider()); await initAgent(BASE_CFG); expect((await processMessage(makeRequest('hi'))).messages[0]?.id).toBeTruthy(); shutdownAgents(); });
  it('processMessage after shutdown uses echo', async () => { shutdownAgents(); const c = (await processMessage(makeRequest('hello'))).messages[0]?.content; if (c && 'text' in c) expect(typeof c.text).toBe('string'); });
});
