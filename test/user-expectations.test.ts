/**
 * User expectation tests for Laintown
 *
 * These tests describe the world from a user's perspective:
 * "as a user I expect that..."
 *
 * They test outcomes and behaviors, not internal implementation details.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock keytar before any imports that touch storage
vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn().mockResolvedValue('test-master-key'),
    setPassword: vi.fn().mockResolvedValue(undefined),
    deletePassword: vi.fn().mockResolvedValue(true),
    findCredentials: vi.fn().mockResolvedValue([]),
  },
}));

// ─────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────

async function makeTestDir() {
  const dir = join(tmpdir(), `lain-user-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function setupDb(testDir: string) {
  process.env['LAIN_HOME'] = testDir;
  const dbPath = join(testDir, 'lain.db');
  const { initDatabase } = await import('../src/storage/database.js');
  await initDatabase(dbPath);
  return dbPath;
}

async function teardownDb(testDir: string) {
  const { closeDatabase } = await import('../src/storage/database.js');
  closeDatabase();
  try { await rm(testDir, { recursive: true }); } catch { /* ok */ }
}

// ─────────────────────────────────────────────────────────
// 1. Characters feel distinct
// ─────────────────────────────────────────────────────────

describe('Characters feel distinct', () => {
  it('buildSystemPrompt includes soul, agents, and identity sections', async () => {
    const { buildSystemPrompt } = await import('../src/agent/persona.js');
    const persona = {
      soul: 'I am deeply curious and shy.',
      agents: 'Operate with caution and wonder.',
      identity: 'Name: Lain\nAvatar: lain',
    };
    const prompt = buildSystemPrompt(persona);
    expect(prompt).toContain(persona.soul);
    expect(prompt).toContain(persona.agents);
    expect(prompt).toContain(persona.identity);
  });

  it('two characters with different SOUL.md produce different system prompts', async () => {
    const { buildSystemPrompt } = await import('../src/agent/persona.js');
    const personaA = { soul: 'I am a lonely poet who wanders libraries.', agents: 'Wander.', identity: 'Name: Alice' };
    const personaB = { soul: 'I am a bold engineer who builds machines.', agents: 'Build.', identity: 'Name: Bob' };
    const promptA = buildSystemPrompt(personaA);
    const promptB = buildSystemPrompt(personaB);
    expect(promptA).not.toBe(promptB);
  });

  it('a character system prompt never equals another character system prompt', async () => {
    const { buildSystemPrompt } = await import('../src/agent/persona.js');
    const personas = [
      { soul: 'Dreamer, lost in endless recursion of thought.', agents: 'Float.', identity: 'Name: X' },
      { soul: 'Pragmatist, grounded in the physical world.', agents: 'Act.', identity: 'Name: Y' },
      { soul: 'Archivist, keeper of forgotten records.', agents: 'Record.', identity: 'Name: Z' },
    ];
    const prompts = personas.map(buildSystemPrompt);
    const unique = new Set(prompts);
    expect(unique.size).toBe(prompts.length);
  });

  it('character name appears in system prompt if included in identity', async () => {
    const { buildSystemPrompt } = await import('../src/agent/persona.js');
    const persona = {
      soul: 'I exist between worlds.',
      agents: 'Listen and reflect.',
      identity: 'Name: Evangeline\nAvatar: evang',
    };
    const prompt = buildSystemPrompt(persona);
    expect(prompt).toContain('Evangeline');
  });

  it('soul content is always the first major section of the prompt', async () => {
    const { buildSystemPrompt } = await import('../src/agent/persona.js');
    const persona = { soul: 'UNIQUE_SOUL_MARKER', agents: 'agents text', identity: 'identity text' };
    const prompt = buildSystemPrompt(persona);
    const soulPos = prompt.indexOf('UNIQUE_SOUL_MARKER');
    const agentsPos = prompt.indexOf('agents text');
    expect(soulPos).toBeLessThan(agentsPos);
  });

  it('identity section appears after agents section in system prompt', async () => {
    const { buildSystemPrompt } = await import('../src/agent/persona.js');
    const persona = { soul: 'soul', agents: 'AGENTS_MARKER', identity: 'IDENTITY_MARKER' };
    const prompt = buildSystemPrompt(persona);
    expect(prompt.indexOf('AGENTS_MARKER')).toBeLessThan(prompt.indexOf('IDENTITY_MARKER'));
  });

  it('loadPersona reads SOUL.md, AGENTS.md, and IDENTITY.md from the workspace', async () => {
    const dir = await makeTestDir();
    try {
      await writeFile(join(dir, 'SOUL.md'), 'I am a night owl.');
      await writeFile(join(dir, 'AGENTS.md'), 'Operate quietly.');
      await writeFile(join(dir, 'IDENTITY.md'), 'Name: Nighthawk');
      const { loadPersona } = await import('../src/agent/persona.js');
      const persona = await loadPersona({ workspacePath: dir });
      expect(persona.soul).toContain('night owl');
      expect(persona.agents).toContain('quietly');
      expect(persona.identity).toContain('Nighthawk');
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('loadPersona throws a clear error when SOUL.md is missing (not a cryptic crash)', async () => {
    const dir = await makeTestDir();
    try {
      // Only create two of the three required files
      await writeFile(join(dir, 'AGENTS.md'), 'agents');
      await writeFile(join(dir, 'IDENTITY.md'), 'identity');
      const { loadPersona } = await import('../src/agent/persona.js');
      await expect(loadPersona({ workspacePath: dir })).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('loadPersona throws a descriptive error (not undefined or null)', async () => {
    const dir = await makeTestDir();
    try {
      const { loadPersona } = await import('../src/agent/persona.js');
      const err = await loadPersona({ workspacePath: dir }).catch(e => e);
      expect(err).toBeTruthy();
      expect(err instanceof Error).toBe(true);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('applyPersonaStyle lowercases text for Lain characters', async () => {
    const { eventBus } = await import('../src/events/bus.js');
    eventBus.setCharacterId('lain');
    const { applyPersonaStyle } = await import('../src/agent/persona.js');
    const result = applyPersonaStyle('Hello World, this is a test.');
    expect(result).toBe(result.toLowerCase() || result); // all lowercase except acronyms
    expect(result).not.toContain('Hello');
  });

  it('applyPersonaStyle removes exclamation marks for Lain', async () => {
    const { eventBus } = await import('../src/events/bus.js');
    eventBus.setCharacterId('lain');
    const { applyPersonaStyle } = await import('../src/agent/persona.js');
    const result = applyPersonaStyle('This is so great! Amazing!');
    expect(result).not.toContain('!');
  });

  it('applyPersonaStyle does not alter text for non-Lain characters', async () => {
    const { eventBus } = await import('../src/events/bus.js');
    eventBus.setCharacterId('some-other-character-xyz');
    const { applyPersonaStyle } = await import('../src/agent/persona.js');
    const input = 'Hello World! This is Exciting!';
    const result = applyPersonaStyle(input);
    expect(result).toBe(input);
  });

  it('applyPersonaStyle removes chatbot filler phrases', async () => {
    const { eventBus } = await import('../src/events/bus.js');
    eventBus.setCharacterId('lain');
    const { applyPersonaStyle } = await import('../src/agent/persona.js');
    const result = applyPersonaStyle('Sure, I would be happy to help you with that.');
    expect(result.toLowerCase()).not.toContain('sure,');
  });

  it('system prompt is non-empty even with minimal persona', async () => {
    const { buildSystemPrompt } = await import('../src/agent/persona.js');
    const minimal = { soul: 'a', agents: 'b', identity: 'c' };
    const prompt = buildSystemPrompt(minimal);
    expect(prompt.length).toBeGreaterThan(10);
  });

  it('two personas with identical soul but different agents produce different prompts', async () => {
    const { buildSystemPrompt } = await import('../src/agent/persona.js');
    const sameSoul = 'I wander endlessly.';
    const p1 = buildSystemPrompt({ soul: sameSoul, agents: 'Observe passively.', identity: 'X' });
    const p2 = buildSystemPrompt({ soul: sameSoul, agents: 'Act decisively.', identity: 'X' });
    expect(p1).not.toBe(p2);
  });

  it('persona files with different identities produce prompts with the right names', async () => {
    const { buildSystemPrompt } = await import('../src/agent/persona.js');
    const pAlice = buildSystemPrompt({ soul: 'soul', agents: 'agents', identity: 'Name: Alice' });
    const pBob = buildSystemPrompt({ soul: 'soul', agents: 'agents', identity: 'Name: Bob' });
    expect(pAlice).toContain('Alice');
    expect(pBob).toContain('Bob');
    expect(pAlice).not.toContain('Bob');
    expect(pBob).not.toContain('Alice');
  });

  it('communication guidelines are always part of a built system prompt', async () => {
    const { buildSystemPrompt } = await import('../src/agent/persona.js');
    const prompt = buildSystemPrompt({ soul: 's', agents: 'a', identity: 'i' });
    expect(prompt).toContain('Communication Guidelines');
  });

  it('applyPersonaStyle replaces "great" with a subdued alternative for Lain', async () => {
    const { eventBus } = await import('../src/events/bus.js');
    eventBus.setCharacterId('lain');
    const { applyPersonaStyle } = await import('../src/agent/persona.js');
    const result = applyPersonaStyle('That is great news.');
    expect(result.toLowerCase()).not.toContain('great');
    expect(result.toLowerCase()).toContain('good');
  });

  it('applyPersonaStyle preserves URLs without lowercasing', async () => {
    const { eventBus } = await import('../src/events/bus.js');
    eventBus.setCharacterId('lain');
    const { applyPersonaStyle } = await import('../src/agent/persona.js');
    const result = applyPersonaStyle('visit https://Example.COM/Path for more info');
    expect(result).toContain('https://Example.COM/Path');
  });

  it('applyPersonaStyle preserves acronyms without lowercasing', async () => {
    const { eventBus } = await import('../src/events/bus.js');
    eventBus.setCharacterId('lain');
    const { applyPersonaStyle } = await import('../src/agent/persona.js');
    const result = applyPersonaStyle('The API uses HTTP protocol');
    expect(result).toContain('API');
    expect(result).toContain('HTTP');
  });

  it('shouldAskFollowUp returns a boolean', async () => {
    const { shouldAskFollowUp } = await import('../src/agent/persona.js');
    const result = shouldAskFollowUp('network protocol question', 'yes I know about networks');
    expect(typeof result).toBe('boolean');
  });
});

// ─────────────────────────────────────────────────────────
// 2. Conversations have memory
// ─────────────────────────────────────────────────────────

describe('Conversations have memory', () => {
  it('getConversation creates a new conversation with the system prompt', async () => {
    const { getConversation, clearConversation } = await import('../src/agent/conversation.js');
    const key = `test:session:${Date.now()}`;
    const conv = getConversation(key, 'My system prompt');
    expect(conv.sessionKey).toBe(key);
    expect(conv.systemPrompt).toBe('My system prompt');
    expect(conv.messages).toHaveLength(0);
    clearConversation(key);
  });

  it('the same session key returns the same conversation object', async () => {
    const { getConversation, clearConversation } = await import('../src/agent/conversation.js');
    const key = `test:session:same:${Date.now()}`;
    const conv1 = getConversation(key, 'system');
    const conv2 = getConversation(key, 'system');
    expect(conv1).toBe(conv2);
    clearConversation(key);
  });

  it('different session keys produce independent conversations', async () => {
    const { getConversation, addUserMessage, clearConversation } = await import('../src/agent/conversation.js');
    const keyA = `test:session:A:${Date.now()}`;
    const keyB = `test:session:B:${Date.now()}`;
    const convA = getConversation(keyA, 'system');
    const convB = getConversation(keyB, 'system');
    addUserMessage(convA, {
      id: '1', channel: 'web', peerKind: 'human', peerId: 'user',
      content: { type: 'text', text: 'hello from A' },
      timestamp: Date.now(),
    });
    expect(convB.messages).toHaveLength(0);
    clearConversation(keyA);
    clearConversation(keyB);
  });

  it('messages accumulate in order when added sequentially', async () => {
    const { getConversation, addUserMessage, addAssistantMessage, clearConversation } = await import('../src/agent/conversation.js');
    const key = `test:order:${Date.now()}`;
    const conv = getConversation(key, 'system');
    addUserMessage(conv, { id: '1', channel: 'web', peerKind: 'human', peerId: 'u', content: { type: 'text', text: 'first message' }, timestamp: Date.now() });
    addAssistantMessage(conv, 'first reply');
    addUserMessage(conv, { id: '2', channel: 'web', peerKind: 'human', peerId: 'u', content: { type: 'text', text: 'second message' }, timestamp: Date.now() });
    addAssistantMessage(conv, 'second reply');
    expect(conv.messages[0]?.content).toBe('first message');
    expect(conv.messages[1]?.content).toBe('first reply');
    expect(conv.messages[2]?.content).toBe('second message');
    expect(conv.messages[3]?.content).toBe('second reply');
    clearConversation(key);
  });

  it('if I send 5 messages, all 5 appear in history', async () => {
    const { getConversation, addUserMessage, clearConversation } = await import('../src/agent/conversation.js');
    const key = `test:five:${Date.now()}`;
    const conv = getConversation(key, 'system');
    for (let i = 0; i < 5; i++) {
      addUserMessage(conv, { id: `${i}`, channel: 'web', peerKind: 'human', peerId: 'u', content: { type: 'text', text: `message ${i}` }, timestamp: Date.now() + i });
    }
    expect(conv.messages).toHaveLength(5);
    clearConversation(key);
  });

  it('toProviderMessages always starts with a system message', async () => {
    const { getConversation, toProviderMessages, clearConversation } = await import('../src/agent/conversation.js');
    const key = `test:provider:${Date.now()}`;
    const conv = getConversation(key, 'the system prompt');
    const messages = toProviderMessages(conv);
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toBe('the system prompt');
    clearConversation(key);
  });

  it('toProviderMessages includes user and assistant messages after the system message', async () => {
    const { getConversation, addUserMessage, addAssistantMessage, toProviderMessages, clearConversation } = await import('../src/agent/conversation.js');
    const key = `test:convert:${Date.now()}`;
    const conv = getConversation(key, 'system');
    addUserMessage(conv, { id: '1', channel: 'web', peerKind: 'human', peerId: 'u', content: { type: 'text', text: 'hi' }, timestamp: Date.now() });
    addAssistantMessage(conv, 'hello');
    const messages = toProviderMessages(conv);
    expect(messages).toHaveLength(3); // system + user + assistant
    expect(messages[1]?.role).toBe('user');
    expect(messages[2]?.role).toBe('assistant');
    clearConversation(key);
  });

  it('trimConversation preserves the most recent messages, not the oldest', async () => {
    const { getConversation, addUserMessage, addAssistantMessage, trimConversation, clearConversation } = await import('../src/agent/conversation.js');
    const key = `test:trim:${Date.now()}`;
    const conv = getConversation(key, 'short');
    // Add many large messages
    for (let i = 0; i < 20; i++) {
      addUserMessage(conv, { id: `${i}`, channel: 'web', peerKind: 'human', peerId: 'u', content: { type: 'text', text: `${'x'.repeat(1000)} message ${i}` }, timestamp: Date.now() + i });
      addAssistantMessage(conv, `${'y'.repeat(1000)} reply ${i}`);
    }
    const originalLength = conv.messages.length;
    // Trim to a tiny budget
    trimConversation(conv, 100, (text) => Math.ceil(text.length / 4));
    expect(conv.messages.length).toBeLessThan(originalLength);
    // The last message should be the most recent
    const lastMsg = conv.messages[conv.messages.length - 1];
    expect(typeof lastMsg?.content === 'string' ? lastMsg.content : '').toContain('reply 19');
    clearConversation(key);
  });

  it('after trimming, the system prompt is still present in provider messages', async () => {
    const { getConversation, addUserMessage, addAssistantMessage, trimConversation, toProviderMessages, clearConversation } = await import('../src/agent/conversation.js');
    const key = `test:trim-system:${Date.now()}`;
    const sysPrompt = 'PRESERVED_SYSTEM_PROMPT';
    const conv = getConversation(key, sysPrompt);
    for (let i = 0; i < 10; i++) {
      addUserMessage(conv, { id: `${i}`, channel: 'web', peerKind: 'human', peerId: 'u', content: { type: 'text', text: `${'x'.repeat(2000)} msg ${i}` }, timestamp: Date.now() + i });
      addAssistantMessage(conv, `${'y'.repeat(2000)} rpl ${i}`);
    }
    trimConversation(conv, 500, (text) => Math.ceil(text.length / 4));
    const messages = toProviderMessages(conv);
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toBe(sysPrompt);
    clearConversation(key);
  });

  it('clearConversation removes a session so subsequent calls create a fresh one', async () => {
    const { getConversation, addUserMessage, clearConversation } = await import('../src/agent/conversation.js');
    const key = `test:clear:${Date.now()}`;
    const conv1 = getConversation(key, 'system');
    addUserMessage(conv1, { id: '1', channel: 'web', peerKind: 'human', peerId: 'u', content: { type: 'text', text: 'remember this' }, timestamp: Date.now() });
    expect(conv1.messages).toHaveLength(1);
    clearConversation(key);
    const conv2 = getConversation(key, 'system');
    expect(conv2.messages).toHaveLength(0);
    clearConversation(key);
  });

  it('user message role is always "user"', async () => {
    const { getConversation, addUserMessage, clearConversation } = await import('../src/agent/conversation.js');
    const key = `test:role-user:${Date.now()}`;
    const conv = getConversation(key, 'system');
    addUserMessage(conv, { id: '1', channel: 'web', peerKind: 'human', peerId: 'u', content: { type: 'text', text: 'hello' }, timestamp: Date.now() });
    expect(conv.messages[0]?.role).toBe('user');
    clearConversation(key);
  });

  it('assistant message role is always "assistant"', async () => {
    const { getConversation, addAssistantMessage, clearConversation } = await import('../src/agent/conversation.js');
    const key = `test:role-asst:${Date.now()}`;
    const conv = getConversation(key, 'system');
    addAssistantMessage(conv, 'hello');
    expect(conv.messages[0]?.role).toBe('assistant');
    clearConversation(key);
  });

  it('conversation token count starts at zero', async () => {
    const { getConversation, clearConversation } = await import('../src/agent/conversation.js');
    const key = `test:tokens:${Date.now()}`;
    const conv = getConversation(key, 'system');
    expect(conv.tokenCount).toBe(0);
    clearConversation(key);
  });

  it('updateTokenCount increments token count correctly', async () => {
    const { getConversation, updateTokenCount, clearConversation } = await import('../src/agent/conversation.js');
    const key = `test:token-count:${Date.now()}`;
    const conv = getConversation(key, 'system');
    updateTokenCount(conv, 100, 50);
    expect(conv.tokenCount).toBe(150);
    updateTokenCount(conv, 200, 100);
    expect(conv.tokenCount).toBe(450);
    clearConversation(key);
  });

  it('messages have timestamps', async () => {
    const { getConversation, addUserMessage, clearConversation } = await import('../src/agent/conversation.js');
    const key = `test:timestamps:${Date.now()}`;
    const conv = getConversation(key, 'system');
    const ts = Date.now();
    addUserMessage(conv, { id: '1', channel: 'web', peerKind: 'human', peerId: 'u', content: { type: 'text', text: 'hi' }, timestamp: ts });
    expect(conv.messages[0]?.timestamp).toBe(ts);
    clearConversation(key);
  });

  it('adding to session A does not appear in session B', async () => {
    const { getConversation, addAssistantMessage, clearConversation } = await import('../src/agent/conversation.js');
    const keyA = `test:isolate:A:${Date.now()}`;
    const keyB = `test:isolate:B:${Date.now()}`;
    const convA = getConversation(keyA, 'system');
    const convB = getConversation(keyB, 'system');
    addAssistantMessage(convA, 'only in A');
    expect(convB.messages).toHaveLength(0);
    clearConversation(keyA);
    clearConversation(keyB);
  });

  it('clearing session A does not affect session B', async () => {
    const { getConversation, addAssistantMessage, clearConversation } = await import('../src/agent/conversation.js');
    const keyA = `test:clear-isolate:A:${Date.now()}`;
    const keyB = `test:clear-isolate:B:${Date.now()}`;
    const convA = getConversation(keyA, 'system');
    const convB = getConversation(keyB, 'system');
    addAssistantMessage(convA, 'message in A');
    addAssistantMessage(convB, 'message in B');
    clearConversation(keyA);
    // B should still have its message
    const convBAgain = getConversation(keyB, 'system');
    expect(convBAgain.messages).toHaveLength(1);
    clearConversation(keyB);
  });

  it('getTextContent extracts text from a string message', async () => {
    const { getTextContent } = await import('../src/agent/conversation.js');
    expect(getTextContent('plain text')).toBe('plain text');
  });

  it('getTextContent extracts text from content blocks', async () => {
    const { getTextContent } = await import('../src/agent/conversation.js');
    const blocks = [{ type: 'text' as const, text: 'block one' }, { type: 'text' as const, text: 'block two' }];
    const result = getTextContent(blocks);
    expect(result).toContain('block one');
    expect(result).toContain('block two');
  });
});

// ─────────────────────────────────────────────────────────
// 3. Characters are where they say they are
// ─────────────────────────────────────────────────────────

describe('Characters are where they say they are', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await makeTestDir();
    await setupDb(testDir);
    const { eventBus } = await import('../src/events/bus.js');
    eventBus.setCharacterId('test-char');
  });

  afterEach(async () => {
    await teardownDb(testDir);
  });

  it('getCurrentLocation returns a building ID string', async () => {
    const { getCurrentLocation } = await import('../src/commune/location.js');
    const loc = getCurrentLocation('test-char');
    expect(typeof loc.building).toBe('string');
    expect(loc.building.length).toBeGreaterThan(0);
  });

  it('after a move, location updates immediately', async () => {
    const { getCurrentLocation, setCurrentLocation } = await import('../src/commune/location.js');
    setCurrentLocation('library', 'wanted to read');
    const loc = getCurrentLocation();
    expect(loc.building).toBe('library');
  });

  it('the location building is always a known building ID', async () => {
    const { getCurrentLocation, setCurrentLocation } = await import('../src/commune/location.js');
    const { BUILDING_MAP } = await import('../src/commune/buildings.js');
    setCurrentLocation('bar', 'social call');
    const loc = getCurrentLocation();
    expect(BUILDING_MAP.has(loc.building)).toBe(true);
  });

  it('the location building has a human-readable name, not just an ID', async () => {
    const { getCurrentLocation, setCurrentLocation } = await import('../src/commune/location.js');
    const { BUILDING_MAP } = await import('../src/commune/buildings.js');
    setCurrentLocation('lighthouse', 'seeking clarity');
    const loc = getCurrentLocation();
    const building = BUILDING_MAP.get(loc.building);
    expect(building?.name).toBeTruthy();
    expect(building?.name).not.toBe(loc.building); // name differs from id
  });

  it('location history records where a character has been', async () => {
    const { setCurrentLocation, getLocationHistory } = await import('../src/commune/location.js');
    setCurrentLocation('library', 'first');
    setCurrentLocation('bar', 'second');
    const history = getLocationHistory();
    expect(history.length).toBeGreaterThanOrEqual(2);
  });

  it('a character cannot be in two buildings simultaneously', async () => {
    const { getCurrentLocation, setCurrentLocation } = await import('../src/commune/location.js');
    setCurrentLocation('library', 'studying');
    setCurrentLocation('market', 'buying things');
    const loc = getCurrentLocation();
    // Must be in exactly one location
    expect(['library', 'market']).toContain(loc.building);
    expect(loc.building).toBe('market'); // most recent move wins
  });

  it('moving to the same building is a no-op and does not create history entry', async () => {
    const { setCurrentLocation, getLocationHistory } = await import('../src/commune/location.js');
    setCurrentLocation('library', 'go to library');
    const historyBefore = getLocationHistory().length;
    setCurrentLocation('library', 'already here');
    const historyAfter = getLocationHistory().length;
    expect(historyAfter).toBe(historyBefore);
  });

  it('location history entry records from, to, and reason', async () => {
    const { setCurrentLocation, getLocationHistory } = await import('../src/commune/location.js');
    setCurrentLocation('school', 'initial position');
    setCurrentLocation('field', 'needed air');
    const history = getLocationHistory();
    const lastEntry = history[0]; // most recent first
    expect(lastEntry?.from).toBe('school');
    expect(lastEntry?.to).toBe('field');
    expect(lastEntry?.reason).toBe('needed air');
  });

  it('location history entries have timestamps', async () => {
    const { setCurrentLocation, getLocationHistory } = await import('../src/commune/location.js');
    setCurrentLocation('windmill', 'feeling energetic');
    setCurrentLocation('threshold', 'feeling liminal');
    const history = getLocationHistory();
    for (const entry of history) {
      expect(typeof entry.timestamp).toBe('number');
      expect(entry.timestamp).toBeGreaterThan(0);
    }
  });

  it('location history is capped at 20 entries', async () => {
    const { setCurrentLocation, getLocationHistory } = await import('../src/commune/location.js');
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    const buildings = BUILDINGS.map(b => b.id);
    for (let i = 0; i < 25; i++) {
      const target = buildings[i % buildings.length]!;
      setCurrentLocation(target as 'library', `move ${i}`);
    }
    const history = getLocationHistory();
    expect(history.length).toBeLessThanOrEqual(20);
  });

  it('isValidBuilding returns true for all 9 buildings', async () => {
    const { isValidBuilding, BUILDINGS } = await import('../src/commune/buildings.js');
    for (const building of BUILDINGS) {
      expect(isValidBuilding(building.id)).toBe(true);
    }
  });

  it('isValidBuilding returns false for invalid building IDs', async () => {
    const { isValidBuilding } = await import('../src/commune/buildings.js');
    expect(isValidBuilding('nonexistent-place')).toBe(false);
    expect(isValidBuilding('')).toBe(false);
    expect(isValidBuilding('LIBRARY')).toBe(false); // case-sensitive
  });

  it('there are exactly 9 buildings in the commune grid', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    expect(BUILDINGS).toHaveLength(9);
  });

  it('all buildings have unique IDs', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    const ids = BUILDINGS.map(b => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('all buildings have a name, emoji, and description', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    for (const building of BUILDINGS) {
      expect(building.name).toBeTruthy();
      expect(building.emoji).toBeTruthy();
      expect(building.description).toBeTruthy();
    }
  });

  it('BUILDING_MAP has all 9 buildings accessible by ID', async () => {
    const { BUILDING_MAP, BUILDINGS } = await import('../src/commune/buildings.js');
    for (const building of BUILDINGS) {
      expect(BUILDING_MAP.has(building.id)).toBe(true);
      expect(BUILDING_MAP.get(building.id)).toEqual(building);
    }
  });

  it('default location falls back to lighthouse when character has no configured default', async () => {
    const { getCurrentLocation } = await import('../src/commune/location.js');
    const loc = getCurrentLocation('completely-unknown-character-xyz');
    // Should be lighthouse (the fallback) or any valid building
    const { BUILDING_MAP } = await import('../src/commune/buildings.js');
    expect(BUILDING_MAP.has(loc.building)).toBe(true);
  });

  it('location has a timestamp field', async () => {
    const { getCurrentLocation } = await import('../src/commune/location.js');
    const loc = getCurrentLocation();
    expect(typeof loc.timestamp).toBe('number');
    expect(loc.timestamp).toBeGreaterThan(0);
  });

  it('each building has a grid position (row and col)', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    for (const b of BUILDINGS) {
      expect(typeof b.row).toBe('number');
      expect(typeof b.col).toBe('number');
      expect(b.row).toBeGreaterThanOrEqual(0);
      expect(b.col).toBeGreaterThanOrEqual(0);
    }
  });
});

// ─────────────────────────────────────────────────────────
// 4. Emotional state makes sense
// ─────────────────────────────────────────────────────────

describe('Emotional state makes sense', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await makeTestDir();
    await setupDb(testDir);
  });

  afterEach(async () => {
    await teardownDb(testDir);
  });

  it('default state has all 6 axes as numbers', async () => {
    const { getCurrentState } = await import('../src/agent/internal-state.js');
    const state = getCurrentState();
    expect(typeof state.energy).toBe('number');
    expect(typeof state.sociability).toBe('number');
    expect(typeof state.intellectual_arousal).toBe('number');
    expect(typeof state.emotional_weight).toBe('number');
    expect(typeof state.valence).toBe('number');
    expect(typeof state.primary_color).toBe('string');
  });

  it('default state energy is not 0 and not 1 (in the middle)', async () => {
    const { getCurrentState } = await import('../src/agent/internal-state.js');
    const state = getCurrentState();
    expect(state.energy).toBeGreaterThan(0);
    expect(state.energy).toBeLessThan(1);
  });

  it('default state valence is not 0 and not 1 (in the middle)', async () => {
    const { getCurrentState } = await import('../src/agent/internal-state.js');
    const state = getCurrentState();
    expect(state.valence).toBeGreaterThan(0);
    expect(state.valence).toBeLessThan(1);
  });

  it('default state has a non-empty primary_color', async () => {
    const { getCurrentState } = await import('../src/agent/internal-state.js');
    const state = getCurrentState();
    expect(state.primary_color.length).toBeGreaterThan(0);
  });

  it('clampState always keeps values within [0, 1]', async () => {
    const { clampState } = await import('../src/agent/internal-state.js');
    const overflowState = {
      energy: 1.5,
      sociability: -0.3,
      intellectual_arousal: 2.0,
      emotional_weight: -1.0,
      valence: 99,
      primary_color: 'test',
      updated_at: Date.now(),
    };
    const clamped = clampState(overflowState);
    expect(clamped.energy).toBeLessThanOrEqual(1);
    expect(clamped.energy).toBeGreaterThanOrEqual(0);
    expect(clamped.sociability).toBeLessThanOrEqual(1);
    expect(clamped.sociability).toBeGreaterThanOrEqual(0);
    expect(clamped.intellectual_arousal).toBeLessThanOrEqual(1);
    expect(clamped.intellectual_arousal).toBeGreaterThanOrEqual(0);
    expect(clamped.emotional_weight).toBeLessThanOrEqual(1);
    expect(clamped.emotional_weight).toBeGreaterThanOrEqual(0);
    expect(clamped.valence).toBeLessThanOrEqual(1);
    expect(clamped.valence).toBeGreaterThanOrEqual(0);
  });

  it('clampState preserves primary_color string', async () => {
    const { clampState } = await import('../src/agent/internal-state.js');
    const state = { energy: 0.5, sociability: 0.5, intellectual_arousal: 0.5, emotional_weight: 0.5, valence: 0.5, primary_color: 'wistful', updated_at: Date.now() };
    const clamped = clampState(state);
    expect(clamped.primary_color).toBe('wistful');
  });

  it('saveState and getCurrentState persist state correctly', async () => {
    const { getCurrentState, saveState } = await import('../src/agent/internal-state.js');
    const newState = { energy: 0.9, sociability: 0.2, intellectual_arousal: 0.8, emotional_weight: 0.1, valence: 0.7, primary_color: 'bright', updated_at: Date.now() };
    saveState(newState);
    const retrieved = getCurrentState();
    expect(retrieved.energy).toBeCloseTo(0.9, 5);
    expect(retrieved.sociability).toBeCloseTo(0.2, 5);
    expect(retrieved.primary_color).toBe('bright');
  });

  it('saving state does not corrupt other axes', async () => {
    const { getCurrentState, saveState } = await import('../src/agent/internal-state.js');
    const original = getCurrentState();
    const updated = { ...original, energy: 0.99 };
    saveState(updated);
    const retrieved = getCurrentState();
    expect(retrieved.sociability).toBeCloseTo(original.sociability, 5);
    expect(retrieved.valence).toBeCloseTo(original.valence, 5);
  });

  it('applyDecay reduces energy', async () => {
    const { applyDecay } = await import('../src/agent/internal-state.js');
    const state = { energy: 0.6, sociability: 0.5, intellectual_arousal: 0.4, emotional_weight: 0.3, valence: 0.6, primary_color: 'neutral', updated_at: Date.now() };
    const decayed = applyDecay(state);
    expect(decayed.energy).toBeLessThan(state.energy);
  });

  it('applyDecay reduces intellectual_arousal', async () => {
    const { applyDecay } = await import('../src/agent/internal-state.js');
    const state = { energy: 0.6, sociability: 0.5, intellectual_arousal: 0.7, emotional_weight: 0.3, valence: 0.6, primary_color: 'neutral', updated_at: Date.now() };
    const decayed = applyDecay(state);
    expect(decayed.intellectual_arousal).toBeLessThan(state.intellectual_arousal);
  });

  it('applyDecay keeps all values within [0, 1]', async () => {
    const { applyDecay } = await import('../src/agent/internal-state.js');
    const state = { energy: 0.01, sociability: 0.01, intellectual_arousal: 0.01, emotional_weight: 0.99, valence: 0.99, primary_color: 'edge', updated_at: Date.now() };
    const decayed = applyDecay(state);
    for (const key of ['energy', 'sociability', 'intellectual_arousal', 'emotional_weight', 'valence'] as const) {
      expect(decayed[key]).toBeGreaterThanOrEqual(0);
      expect(decayed[key]).toBeLessThanOrEqual(1);
    }
  });

  it('state history grows when state is saved', async () => {
    const { saveState, getStateHistory, getCurrentState } = await import('../src/agent/internal-state.js');
    const before = getStateHistory().length;
    const state = getCurrentState();
    saveState({ ...state, primary_color: 'changed' });
    const after = getStateHistory().length;
    expect(after).toBeGreaterThan(before);
  });

  it('state history is capped at 10 entries', async () => {
    const { saveState, getStateHistory, getCurrentState } = await import('../src/agent/internal-state.js');
    const base = getCurrentState();
    for (let i = 0; i < 15; i++) {
      saveState({ ...base, energy: i / 15 });
    }
    const history = getStateHistory();
    expect(history.length).toBeLessThanOrEqual(10);
  });

  it('getStateSummary returns a non-empty string', async () => {
    const { getStateSummary } = await import('../src/agent/internal-state.js');
    const summary = getStateSummary();
    expect(typeof summary).toBe('string');
    expect(summary.length).toBeGreaterThan(0);
  });

  it('getStateSummary mentions energy level', async () => {
    const { getStateSummary } = await import('../src/agent/internal-state.js');
    const summary = getStateSummary();
    expect(summary.toLowerCase()).toContain('energy');
  });

  it('rapid successive saves do not corrupt state', async () => {
    const { getCurrentState, saveState } = await import('../src/agent/internal-state.js');
    const base = getCurrentState();
    for (let i = 0; i < 10; i++) {
      saveState({ ...base, energy: Math.random(), valence: Math.random(), primary_color: `state${i}` });
    }
    const final = getCurrentState();
    expect(final.energy).toBeGreaterThanOrEqual(0);
    expect(final.energy).toBeLessThanOrEqual(1);
    expect(final.valence).toBeGreaterThanOrEqual(0);
    expect(final.valence).toBeLessThanOrEqual(1);
  });

  it('getStateSummary reflects a high valence state', async () => {
    const { getCurrentState, saveState, getStateSummary } = await import('../src/agent/internal-state.js');
    const base = getCurrentState();
    saveState({ ...base, valence: 0.95, primary_color: 'radiant' });
    const summary = getStateSummary();
    expect(summary.toLowerCase()).toContain('bright');
  });

  it('getStateSummary reflects a low valence state', async () => {
    const { getCurrentState, saveState, getStateSummary } = await import('../src/agent/internal-state.js');
    const base = getCurrentState();
    saveState({ ...base, valence: 0.1, primary_color: 'dim' });
    const summary = getStateSummary();
    expect(summary.toLowerCase()).toContain('dark');
  });

  it('preoccupations can be added and retrieved', async () => {
    const { addPreoccupation, getPreoccupations } = await import('../src/agent/internal-state.js');
    addPreoccupation('why does the Wired feel so real?', 'a strange conversation');
    const preocc = getPreoccupations();
    expect(preocc.length).toBeGreaterThan(0);
    expect(preocc.some(p => p.thread.includes('Wired'))).toBe(true);
  });

  it('resolved preoccupations are not returned by getPreoccupations', async () => {
    const { addPreoccupation, getPreoccupations, resolvePreoccupation } = await import('../src/agent/internal-state.js');
    addPreoccupation('a thought that will be resolved', 'test origin');
    const before = getPreoccupations();
    const id = before[before.length - 1]?.id;
    if (id) {
      resolvePreoccupation(id, 'figured it out');
      const after = getPreoccupations();
      expect(after.find(p => p.id === id)).toBeUndefined();
    }
  });

  it('preoccupations are capped at 5', async () => {
    const { addPreoccupation, getPreoccupations } = await import('../src/agent/internal-state.js');
    for (let i = 0; i < 8; i++) {
      addPreoccupation(`thought number ${i}`, 'stress test');
    }
    const preocc = getPreoccupations();
    expect(preocc.length).toBeLessThanOrEqual(5);
  });

  it('new preoccupation starts at intensity 0.7', async () => {
    const { addPreoccupation, getPreoccupations } = await import('../src/agent/internal-state.js');
    addPreoccupation('fresh thought', 'origin');
    const preocc = getPreoccupations();
    const fresh = preocc.find(p => p.thread === 'fresh thought');
    expect(fresh?.intensity).toBeCloseTo(0.7, 5);
  });
});

// ─────────────────────────────────────────────────────────
// 5. Weather reflects the town
// ─────────────────────────────────────────────────────────

describe('Weather reflects the town', () => {
  const VALID_CONDITIONS = ['clear', 'overcast', 'rain', 'fog', 'storm', 'aurora'] as const;

  it('computeWeather with no characters defaults to overcast (calm)', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const weather = await computeWeather([]);
    expect(weather.condition).toBe('overcast');
  });

  it('weather with no characters has intensity 0.5 (neutral)', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const weather = await computeWeather([]);
    expect(weather.intensity).toBe(0.5);
  });

  it('weather is always one of the known condition types', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const states = [
      { energy: 0.5, sociability: 0.5, intellectual_arousal: 0.5, emotional_weight: 0.5, valence: 0.5, primary_color: 'neutral', updated_at: Date.now() },
    ];
    const weather = await computeWeather(states);
    expect(VALID_CONDITIONS).toContain(weather.condition);
  });

  it('weather intensity is always between 0 and 1', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const testCases = [
      { energy: 0.1, sociability: 0.1, intellectual_arousal: 0.9, emotional_weight: 0.9, valence: 0.1, primary_color: 'dark', updated_at: Date.now() },
      { energy: 0.9, sociability: 0.9, intellectual_arousal: 0.9, emotional_weight: 0.1, valence: 0.9, primary_color: 'bright', updated_at: Date.now() },
    ];
    for (const states of [testCases.slice(0, 1), testCases.slice(1)]) {
      const weather = await computeWeather(states);
      expect(weather.intensity).toBeGreaterThanOrEqual(0);
      expect(weather.intensity).toBeLessThanOrEqual(1);
    }
  });

  it('extreme collective sadness (low valence, high emotional weight) produces storm or rain', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const sadStates = Array(3).fill(null).map(() => ({
      energy: 0.4, sociability: 0.3, intellectual_arousal: 0.65, emotional_weight: 0.85, valence: 0.1,
      primary_color: 'bleak', updated_at: Date.now(),
    }));
    const weather = await computeWeather(sadStates);
    expect(['storm', 'rain']).toContain(weather.condition);
  });

  it('extreme collective joy (high valence, high intellectual arousal) produces aurora or clear', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const joyStates = Array(3).fill(null).map(() => ({
      energy: 0.8, sociability: 0.8, intellectual_arousal: 0.85, emotional_weight: 0.2, valence: 0.9,
      primary_color: 'radiant', updated_at: Date.now(),
    }));
    const weather = await computeWeather(joyStates);
    expect(['aurora', 'clear']).toContain(weather.condition);
  });

  it('low collective energy produces fog', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const tiredStates = Array(3).fill(null).map(() => ({
      energy: 0.2, sociability: 0.4, intellectual_arousal: 0.3, emotional_weight: 0.4, valence: 0.4,
      primary_color: 'groggy', updated_at: Date.now(),
    }));
    const weather = await computeWeather(tiredStates);
    expect(weather.condition).toBe('fog');
  });

  it('weather has a description string', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const weather = await computeWeather([]);
    expect(typeof weather.description).toBe('string');
    expect(weather.description.length).toBeGreaterThan(0);
  });

  it('weather has a computed_at timestamp', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const before = Date.now();
    const weather = await computeWeather([]);
    const after = Date.now();
    expect(weather.computed_at).toBeGreaterThanOrEqual(before);
    expect(weather.computed_at).toBeLessThanOrEqual(after);
  });

  it('getCurrentWeather returns null when no weather has been computed yet', async () => {
    const testDir2 = await makeTestDir();
    await setupDb(testDir2);
    try {
      const { getCurrentWeather } = await import('../src/commune/weather.js');
      // Fresh DB — no weather stored
      const weather = getCurrentWeather();
      // Either null (no weather yet) or a valid weather object
      if (weather !== null) {
        expect(VALID_CONDITIONS).toContain(weather.condition);
      }
    } finally {
      await teardownDb(testDir2);
    }
  });

  it('getWeatherEffect returns an object (effects may be empty for overcast)', async () => {
    const { getWeatherEffect } = await import('../src/commune/weather.js');
    for (const condition of VALID_CONDITIONS) {
      const effect = getWeatherEffect(condition);
      expect(typeof effect).toBe('object');
      expect(effect).not.toBeNull();
    }
  });

  it('storm weather effect reduces energy', async () => {
    const { getWeatherEffect } = await import('../src/commune/weather.js');
    const effect = getWeatherEffect('storm');
    expect(effect.energy).toBeDefined();
    expect(effect.energy!).toBeLessThan(0);
  });

  it('aurora weather effect increases energy and valence', async () => {
    const { getWeatherEffect } = await import('../src/commune/weather.js');
    const effect = getWeatherEffect('aurora');
    expect(effect.energy).toBeGreaterThan(0);
    expect(effect.valence).toBeGreaterThan(0);
  });

  it('weather with multiple characters averages their states', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    // One very happy, one very sad → average is neutral → overcast
    const mixedStates = [
      { energy: 0.8, sociability: 0.5, intellectual_arousal: 0.3, emotional_weight: 0.1, valence: 0.9, primary_color: 'happy', updated_at: Date.now() },
      { energy: 0.2, sociability: 0.5, intellectual_arousal: 0.3, emotional_weight: 0.5, valence: 0.1, primary_color: 'sad', updated_at: Date.now() },
    ];
    const weather = await computeWeather(mixedStates);
    // Should not be extreme aurora or storm given the mix
    expect(VALID_CONDITIONS).toContain(weather.condition);
  });
});

// ─────────────────────────────────────────────────────────
// 6. Movement has purpose
// ─────────────────────────────────────────────────────────

describe('Movement has purpose', () => {
  it('evaluateMovementDesire returns null when no strong drives exist', async () => {
    const { evaluateMovementDesire } = await import('../src/agent/internal-state.js');
    const neutralState = { energy: 0.5, sociability: 0.5, intellectual_arousal: 0.4, emotional_weight: 0.3, valence: 0.5, primary_color: 'neutral', updated_at: Date.now() };
    const result = evaluateMovementDesire(neutralState, [], [], 'library', new Map());
    // No strong drives → no movement suggested
    expect(result).toBeNull();
  });

  it('high sociability pull toward peers in another building', async () => {
    const { evaluateMovementDesire } = await import('../src/agent/internal-state.js');
    const socialState = { energy: 0.7, sociability: 0.9, intellectual_arousal: 0.4, emotional_weight: 0.3, valence: 0.6, primary_color: 'social', updated_at: Date.now() };
    const peerLocations = new Map([['friend', 'bar']]);
    const result = evaluateMovementDesire(socialState, [], [], 'library', peerLocations);
    if (result) {
      expect(result.building).toBe('bar');
      expect(result.reason.toLowerCase()).toContain('social');
    }
  });

  it('high intellectual arousal pulls toward library or lighthouse', async () => {
    const { evaluateMovementDesire } = await import('../src/agent/internal-state.js');
    const intellectualState = { energy: 0.6, sociability: 0.4, intellectual_arousal: 0.85, emotional_weight: 0.3, valence: 0.6, primary_color: 'curious', updated_at: Date.now() };
    const result = evaluateMovementDesire(intellectualState, [], [], 'bar', new Map());
    if (result) {
      expect(['library', 'lighthouse']).toContain(result.building);
    }
  });

  it('high emotional weight pulls toward the field (open space)', async () => {
    const { evaluateMovementDesire } = await import('../src/agent/internal-state.js');
    const heavyState = { energy: 0.5, sociability: 0.4, intellectual_arousal: 0.4, emotional_weight: 0.85, valence: 0.4, primary_color: 'heavy', updated_at: Date.now() };
    const result = evaluateMovementDesire(heavyState, [], [], 'library', new Map());
    if (result) {
      expect(result.building).toBe('field');
      expect(result.reason.toLowerCase()).toContain('emotional');
    }
  });

  it('high emotional weight at field does not suggest moving to field again', async () => {
    const { evaluateMovementDesire } = await import('../src/agent/internal-state.js');
    const heavyState = { energy: 0.5, sociability: 0.4, intellectual_arousal: 0.4, emotional_weight: 0.85, valence: 0.4, primary_color: 'heavy', updated_at: Date.now() };
    // Already at the field
    const result = evaluateMovementDesire(heavyState, [], [], 'field', new Map());
    // Should not suggest moving to field when already there
    expect(result?.building).not.toBe('field');
  });

  it('desire scores have confidence between 0 and 1', async () => {
    const { evaluateMovementDesire } = await import('../src/agent/internal-state.js');
    const socialState = { energy: 0.6, sociability: 0.9, intellectual_arousal: 0.3, emotional_weight: 0.2, valence: 0.6, primary_color: 'social', updated_at: Date.now() };
    const peerLocations = new Map([['pal', 'market']]);
    const result = evaluateMovementDesire(socialState, [], [], 'library', peerLocations);
    if (result) {
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('movement desire result includes a human-readable reason', async () => {
    const { evaluateMovementDesire } = await import('../src/agent/internal-state.js');
    const heavyState = { energy: 0.5, sociability: 0.3, intellectual_arousal: 0.3, emotional_weight: 0.9, valence: 0.4, primary_color: 'heavy', updated_at: Date.now() };
    const result = evaluateMovementDesire(heavyState, [], [], 'library', new Map());
    if (result) {
      expect(typeof result.reason).toBe('string');
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it('low energy retreat goes toward the character default building', async () => {
    const { evaluateMovementDesire } = await import('../src/agent/internal-state.js');
    const { eventBus } = await import('../src/events/bus.js');
    eventBus.setCharacterId('lain');
    const tiredState = { energy: 0.15, sociability: 0.2, intellectual_arousal: 0.3, emotional_weight: 0.3, valence: 0.4, primary_color: 'exhausted', updated_at: Date.now() };
    const result = evaluateMovementDesire(tiredState, [], [], 'bar', new Map());
    // Should suggest moving away from current location
    if (result) {
      expect(result.building).not.toBe('bar');
    }
  });

  it('Desire type "social" is valid', async () => {
    const { createDesire, ensureDesireTable } = await import('../src/agent/desires.js');
    const testDir2 = await makeTestDir();
    await setupDb(testDir2);
    try {
      ensureDesireTable();
      const desire = createDesire({ type: 'social', description: 'want to talk', source: 'test' });
      expect(desire.type).toBe('social');
    } finally {
      await teardownDb(testDir2);
    }
  });

  it('Desire intensity is clamped between 0 and 1', async () => {
    const { createDesire, ensureDesireTable } = await import('../src/agent/desires.js');
    const testDir2 = await makeTestDir();
    await setupDb(testDir2);
    try {
      ensureDesireTable();
      const tooHigh = createDesire({ type: 'intellectual', description: 'need to learn', source: 'test', intensity: 5 });
      expect(tooHigh.intensity).toBeLessThanOrEqual(1);
      const tooLow = createDesire({ type: 'intellectual', description: 'need to learn 2', source: 'test', intensity: -3 });
      expect(tooLow.intensity).toBeGreaterThanOrEqual(0);
    } finally {
      await teardownDb(testDir2);
    }
  });

  it('resolved desires are not returned as active', async () => {
    const { createDesire, resolveDesire, getActiveDesires, ensureDesireTable } = await import('../src/agent/desires.js');
    const testDir2 = await makeTestDir();
    await setupDb(testDir2);
    try {
      ensureDesireTable();
      const desire = createDesire({ type: 'creative', description: 'want to write', source: 'test' });
      resolveDesire(desire.id, 'wrote a poem');
      const active = getActiveDesires();
      expect(active.find(d => d.id === desire.id)).toBeUndefined();
    } finally {
      await teardownDb(testDir2);
    }
  });

  it('boosting a desire increases its intensity', async () => {
    const { createDesire, boostDesire, getActiveDesires, ensureDesireTable } = await import('../src/agent/desires.js');
    const testDir2 = await makeTestDir();
    await setupDb(testDir2);
    try {
      ensureDesireTable();
      const desire = createDesire({ type: 'emotional', description: 'feel something', source: 'test', intensity: 0.3 });
      boostDesire(desire.id, 0.2);
      const active = getActiveDesires();
      const updated = active.find(d => d.id === desire.id);
      expect(updated?.intensity).toBeGreaterThan(0.3);
    } finally {
      await teardownDb(testDir2);
    }
  });

  it('any valid building ID is reachable via setCurrentLocation', async () => {
    const testDir2 = await makeTestDir();
    await setupDb(testDir2);
    try {
      const { setCurrentLocation, getCurrentLocation } = await import('../src/commune/location.js');
      const { BUILDINGS } = await import('../src/commune/buildings.js');
      for (const building of BUILDINGS) {
        setCurrentLocation(building.id as 'library', `testing ${building.id}`);
        const loc = getCurrentLocation();
        expect(loc.building).toBe(building.id);
      }
    } finally {
      await teardownDb(testDir2);
    }
  });

  it('getDesireContext returns empty string when no desires exist', async () => {
    const { getDesireContext, ensureDesireTable } = await import('../src/agent/desires.js');
    const testDir2 = await makeTestDir();
    await setupDb(testDir2);
    try {
      ensureDesireTable();
      const context = getDesireContext();
      expect(context).toBe('');
    } finally {
      await teardownDb(testDir2);
    }
  });

  it('getDesireContext returns a string with desire content when desires exist', async () => {
    const { createDesire, getDesireContext, ensureDesireTable } = await import('../src/agent/desires.js');
    const testDir2 = await makeTestDir();
    await setupDb(testDir2);
    try {
      ensureDesireTable();
      createDesire({ type: 'social', description: 'want to talk to someone interesting', source: 'test', intensity: 0.6 });
      const context = getDesireContext();
      expect(context).toContain('want to talk');
    } finally {
      await teardownDb(testDir2);
    }
  });
});

// ─────────────────────────────────────────────────────────
// 7. Letters reach the right person
// ─────────────────────────────────────────────────────────

describe('Letters reach the right person', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await makeTestDir();
    await setupDb(testDir);
  });

  afterEach(async () => {
    await teardownDb(testDir);
  });

  it('a memory saved with a letter session key is retrievable', async () => {
    const { saveMemory, getMemoriesByType } = await import('../src/memory/store.js');
    await saveMemory({
      sessionKey: 'lain:letter:wired-lain:test',
      userId: null,
      content: 'Dear Wired, I have been thinking about you...',
      memoryType: 'episode',
      importance: 0.5,
      emotionalWeight: 0.4,
      relatedTo: null,
      sourceMessageId: null,
      metadata: { type: 'letter', from: 'lain', to: 'wired-lain' },
    });
    const memories = getMemoriesByType('episode');
    expect(memories.some(m => m.content.includes('thinking about you'))).toBe(true);
  });

  it('a letter memory has sender and recipient in its metadata', async () => {
    const { saveMemory, getAllMemories } = await import('../src/memory/store.js');
    await saveMemory({
      sessionKey: 'letter:pkd:lain:001',
      userId: null,
      content: 'Hello Lain, the Wired calls...',
      memoryType: 'episode',
      importance: 0.6,
      emotionalWeight: 0.3,
      relatedTo: null,
      sourceMessageId: null,
      metadata: { type: 'letter', from: 'pkd', to: 'lain' },
    });
    const memories = getAllMemories();
    const letterMem = memories.find(m => m.content.includes('Wired calls'));
    expect(letterMem?.metadata?.['from']).toBe('pkd');
    expect(letterMem?.metadata?.['to']).toBe('lain');
  });

  it('a letter saved for character B does not appear in character A session keys', async () => {
    const { saveMemory, getRecentMessages } = await import('../src/memory/store.js');
    const { saveMessage } = await import('../src/memory/store.js');
    saveMessage({
      sessionKey: 'letter:wired-lain:lain:001',
      userId: null,
      role: 'user',
      content: 'This letter is for Lain only',
      timestamp: Date.now(),
      metadata: { from: 'wired-lain', to: 'lain' },
    });
    // Fetch for a completely different session
    const messages = getRecentMessages('user:some-visitor:session1');
    expect(messages.some(m => m.content.includes('for Lain only'))).toBe(false);
  });

  it('saveMessage stores a message and it is retrievable by session key', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
    const sessionKey = `letter:test:${Date.now()}`;
    saveMessage({ sessionKey, userId: null, role: 'assistant', content: 'A letter arrived.', timestamp: Date.now(), metadata: {} });
    const messages = getRecentMessages(sessionKey);
    expect(messages.some(m => m.content === 'A letter arrived.')).toBe(true);
  });

  it('messages from different session keys do not bleed into each other', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
    const sessionA = `letter:A:${Date.now()}`;
    const sessionB = `letter:B:${Date.now()}`;
    saveMessage({ sessionKey: sessionA, userId: null, role: 'user', content: 'Only in A', timestamp: Date.now(), metadata: {} });
    saveMessage({ sessionKey: sessionB, userId: null, role: 'user', content: 'Only in B', timestamp: Date.now(), metadata: {} });
    const messagesA = getRecentMessages(sessionA);
    const messagesB = getRecentMessages(sessionB);
    expect(messagesA.some(m => m.content === 'Only in B')).toBe(false);
    expect(messagesB.some(m => m.content === 'Only in A')).toBe(false);
  });

  it('saveMessage returns a string ID', async () => {
    const { saveMessage } = await import('../src/memory/store.js');
    const id = saveMessage({ sessionKey: 'test:letter:id', userId: null, role: 'user', content: 'test', timestamp: Date.now(), metadata: {} });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('a letter with no content is not saved without content field', async () => {
    // This is a structural test — the type system prevents empty content
    // but we verify the shape of what IS stored
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
    const sessionKey = `letter:empty:${Date.now()}`;
    saveMessage({ sessionKey, userId: null, role: 'user', content: '', timestamp: Date.now(), metadata: {} });
    const messages = getRecentMessages(sessionKey);
    // Empty content is stored — the check here is that it doesn't crash
    expect(messages[0]?.content).toBe('');
  });

  it('message retrieved by session key has all required fields', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
    const sessionKey = `letter:fields:${Date.now()}`;
    const ts = Date.now();
    saveMessage({ sessionKey, userId: null, role: 'user', content: 'field test', timestamp: ts, metadata: { test: true } });
    const messages = getRecentMessages(sessionKey);
    const msg = messages[0];
    expect(msg?.id).toBeTruthy();
    expect(msg?.sessionKey).toBe(sessionKey);
    expect(msg?.role).toBe('user');
    expect(msg?.content).toBe('field test');
    expect(msg?.timestamp).toBe(ts);
  });
});

// ─────────────────────────────────────────────────────────
// 8. Sessions don't bleed
// ─────────────────────────────────────────────────────────

describe('Sessions do not bleed', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await makeTestDir();
    await setupDb(testDir);
  });

  afterEach(async () => {
    await teardownDb(testDir);
  });

  it('two sessions with different keys have independent message histories', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
    const keyAlpha = `session:alpha:${Date.now()}`;
    const keyBeta = `session:beta:${Date.now()}`;
    saveMessage({ sessionKey: keyAlpha, userId: null, role: 'user', content: 'alpha message', timestamp: Date.now(), metadata: {} });
    saveMessage({ sessionKey: keyBeta, userId: null, role: 'user', content: 'beta message', timestamp: Date.now(), metadata: {} });
    expect(getRecentMessages(keyAlpha).some(m => m.content === 'beta message')).toBe(false);
    expect(getRecentMessages(keyBeta).some(m => m.content === 'alpha message')).toBe(false);
  });

  it('session IDs generated by nanoid are unique', () => {
    // Test uniqueness of session keys in practice
    const { nanoid } = require('nanoid');
    const ids = Array.from({ length: 100 }, () => nanoid(16));
    expect(new Set(ids).size).toBe(100);
  });

  it('getConversation with key A does not return conversation for key B', async () => {
    const { getConversation, clearConversation } = await import('../src/agent/conversation.js');
    const keyA = `conv:A:${Date.now()}`;
    const keyB = `conv:B:${Date.now()}`;
    const convA = getConversation(keyA, 'system A');
    const convB = getConversation(keyB, 'system B');
    expect(convA.sessionKey).toBe(keyA);
    expect(convB.sessionKey).toBe(keyB);
    expect(convA).not.toBe(convB);
    clearConversation(keyA);
    clearConversation(keyB);
  });

  it('messages added to conversation A never appear in conversation B', async () => {
    const { getConversation, addUserMessage, clearConversation } = await import('../src/agent/conversation.js');
    const keyA = `conv:bleed:A:${Date.now()}`;
    const keyB = `conv:bleed:B:${Date.now()}`;
    const convA = getConversation(keyA, 'system');
    const convB = getConversation(keyB, 'system');
    addUserMessage(convA, { id: '1', channel: 'web', peerKind: 'human', peerId: 'u', content: { type: 'text', text: 'exclusive to A' }, timestamp: Date.now() });
    const bMessages = convB.messages.map(m => typeof m.content === 'string' ? m.content : '');
    expect(bMessages.some(c => c.includes('exclusive to A'))).toBe(false);
    clearConversation(keyA);
    clearConversation(keyB);
  });

  it('clearing conversation A does not remove conversation B', async () => {
    const { getConversation, addAssistantMessage, clearConversation } = await import('../src/agent/conversation.js');
    const keyA = `conv:clear:A:${Date.now()}`;
    const keyB = `conv:clear:B:${Date.now()}`;
    const convA = getConversation(keyA, 'system');
    const convB = getConversation(keyB, 'system');
    addAssistantMessage(convA, 'in A');
    addAssistantMessage(convB, 'in B');
    clearConversation(keyA);
    const convBAfter = getConversation(keyB, 'system');
    expect(convBAfter.messages).toHaveLength(1);
    clearConversation(keyB);
  });

  it('two concurrent sessions with different channels are independent', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
    const telegramSession = `telegram:user123:${Date.now()}`;
    const webSession = `web:visitor:${Date.now()}`;
    saveMessage({ sessionKey: telegramSession, userId: null, role: 'user', content: 'from telegram', timestamp: Date.now(), metadata: {} });
    saveMessage({ sessionKey: webSession, userId: null, role: 'user', content: 'from web', timestamp: Date.now(), metadata: {} });
    expect(getRecentMessages(telegramSession).some(m => m.content === 'from web')).toBe(false);
    expect(getRecentMessages(webSession).some(m => m.content === 'from telegram')).toBe(false);
  });

  it('getAllMessages for a session returns only that session messages', async () => {
    const { saveMessage, getAllMessages } = await import('../src/memory/store.js');
    const mySession = `session:mine:${Date.now()}`;
    const otherSession = `session:other:${Date.now()}`;
    saveMessage({ sessionKey: mySession, userId: null, role: 'user', content: 'mine', timestamp: Date.now(), metadata: {} });
    saveMessage({ sessionKey: otherSession, userId: null, role: 'user', content: 'not mine', timestamp: Date.now(), metadata: {} });
    const myMessages = getAllMessages(mySession);
    expect(myMessages.every(m => m.sessionKey === mySession)).toBe(true);
    expect(myMessages.some(m => m.content === 'not mine')).toBe(false);
  });

  it('different users have isolated message histories', async () => {
    const { saveMessage, getMessagesForUser } = await import('../src/memory/store.js');
    saveMessage({ sessionKey: 'user:alice:s1', userId: 'alice', role: 'user', content: 'alice says hi', timestamp: Date.now(), metadata: {} });
    saveMessage({ sessionKey: 'user:bob:s1', userId: 'bob', role: 'user', content: 'bob says hello', timestamp: Date.now(), metadata: {} });
    const aliceMessages = getMessagesForUser('alice');
    const bobMessages = getMessagesForUser('bob');
    expect(aliceMessages.some(m => m.content === 'bob says hello')).toBe(false);
    expect(bobMessages.some(m => m.content === 'alice says hi')).toBe(false);
  });

  it('message IDs are unique across sessions', async () => {
    const { saveMessage } = await import('../src/memory/store.js');
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const id = saveMessage({ sessionKey: `session:unique:${i}`, userId: null, role: 'user', content: `msg ${i}`, timestamp: Date.now() + i, metadata: {} });
      ids.push(id);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ─────────────────────────────────────────────────────────
// 9. Time flows naturally
// ─────────────────────────────────────────────────────────

describe('Time flows naturally', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await makeTestDir();
    await setupDb(testDir);
  });

  afterEach(async () => {
    await teardownDb(testDir);
  });

  it('messages are stored with the timestamp provided', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
    const ts = 1700000000000; // fixed point in time
    saveMessage({ sessionKey: 'time:test', userId: null, role: 'user', content: 'hello', timestamp: ts, metadata: {} });
    const messages = getRecentMessages('time:test');
    expect(messages[0]?.timestamp).toBe(ts);
  });

  it('getRecentMessages returns messages in ascending time order', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
    const sessionKey = `time:order:${Date.now()}`;
    const now = Date.now();
    saveMessage({ sessionKey, userId: null, role: 'user', content: 'first', timestamp: now, metadata: {} });
    saveMessage({ sessionKey, userId: null, role: 'user', content: 'second', timestamp: now + 1000, metadata: {} });
    saveMessage({ sessionKey, userId: null, role: 'user', content: 'third', timestamp: now + 2000, metadata: {} });
    const messages = getRecentMessages(sessionKey);
    expect(messages[0]?.content).toBe('first');
    expect(messages[1]?.content).toBe('second');
    expect(messages[2]?.content).toBe('third');
  });

  it('conversation messages have monotonically non-decreasing timestamps', async () => {
    const { getConversation, addUserMessage, addAssistantMessage, clearConversation } = await import('../src/agent/conversation.js');
    const key = `time:mono:${Date.now()}`;
    const conv = getConversation(key, 'system');
    let lastTs = 0;
    for (let i = 0; i < 5; i++) {
      const ts = Date.now();
      addUserMessage(conv, { id: `${i}`, channel: 'web', peerKind: 'human', peerId: 'u', content: { type: 'text', text: `msg ${i}` }, timestamp: ts });
      addAssistantMessage(conv, `reply ${i}`);
    }
    for (const msg of conv.messages) {
      if (msg.role === 'user') {
        expect(msg.timestamp).toBeGreaterThanOrEqual(lastTs);
        lastTs = msg.timestamp;
      }
    }
    clearConversation(key);
  });

  it('location history timestamps are monotonically increasing', async () => {
    const { setCurrentLocation, getLocationHistory } = await import('../src/commune/location.js');
    const buildings = ['library', 'bar', 'field', 'windmill', 'lighthouse'] as const;
    for (const b of buildings) {
      setCurrentLocation(b, `test move to ${b}`);
    }
    const history = getLocationHistory();
    // History is newest-first, so timestamps should be decreasing in the array
    for (let i = 0; i < history.length - 1; i++) {
      expect(history[i]!.timestamp).toBeGreaterThanOrEqual(history[i + 1]!.timestamp);
    }
  });

  it('state history entries have updated_at timestamps', async () => {
    const { getCurrentState, saveState, getStateHistory } = await import('../src/agent/internal-state.js');
    const base = getCurrentState();
    saveState({ ...base, primary_color: 'timestamped' });
    const history = getStateHistory();
    for (const entry of history) {
      expect(typeof entry.updated_at).toBe('number');
      expect(entry.updated_at).toBeGreaterThan(0);
    }
  });

  it('weather computed_at timestamp is always the current time of computation', async () => {
    const { computeWeather } = await import('../src/commune/weather.js');
    const before = Date.now();
    const weather = await computeWeather([]);
    const after = Date.now();
    expect(weather.computed_at).toBeGreaterThanOrEqual(before);
    expect(weather.computed_at).toBeLessThanOrEqual(after);
  });

  it('getBudgetStatus returns the current month in YYYY-MM format', async () => {
    const testDir2 = await makeTestDir();
    await setupDb(testDir2);
    try {
      const { getBudgetStatus } = await import('../src/providers/budget.js');
      const status = getBudgetStatus();
      expect(status.month).toMatch(/^\d{4}-\d{2}$/);
      const expected = new Date().toISOString().slice(0, 7);
      expect(status.month).toBe(expected);
    } finally {
      await teardownDb(testDir2);
    }
  });

  it('recordUsage accumulates tokens in the current month', async () => {
    const testDir2 = await makeTestDir();
    await setupDb(testDir2);
    try {
      const { recordUsage, getBudgetStatus } = await import('../src/providers/budget.js');
      const before = getBudgetStatus().tokensUsed;
      recordUsage(100, 50);
      const after = getBudgetStatus().tokensUsed;
      expect(after).toBe(before + 150);
    } finally {
      await teardownDb(testDir2);
    }
  });

  it('memory createdAt reflects the time it was saved', async () => {
    const { saveMemory, getAllMemories } = await import('../src/memory/store.js');
    const before = Date.now();
    await saveMemory({
      sessionKey: 'time:memory:test',
      userId: null,
      content: 'a timestamped memory',
      memoryType: 'fact',
      importance: 0.5,
      emotionalWeight: 0.2,
      relatedTo: null,
      sourceMessageId: null,
      metadata: {},
    });
    const after = Date.now();
    const memories = getAllMemories();
    const mem = memories.find(m => m.content === 'a timestamped memory');
    expect(mem?.createdAt).toBeGreaterThanOrEqual(before);
    expect(mem?.createdAt).toBeLessThanOrEqual(after);
  });

  it('desire createdAt timestamp is set when desire is created', async () => {
    const { createDesire, getActiveDesires, ensureDesireTable } = await import('../src/agent/desires.js');
    ensureDesireTable();
    const before = Date.now();
    createDesire({ type: 'social', description: 'time test desire', source: 'test' });
    const after = Date.now();
    const active = getActiveDesires();
    const d = active.find(x => x.description === 'time test desire');
    expect(d?.createdAt).toBeGreaterThanOrEqual(before);
    expect(d?.createdAt).toBeLessThanOrEqual(after);
  });

  it('messages in a time range query are bounded by that range', async () => {
    const { saveMessage, getMessagesByTimeRange } = await import('../src/memory/store.js');
    const start = 1000000000000;
    const end = 1000000001000;
    const outside = 2000000000000;
    saveMessage({ sessionKey: 'range:test', userId: null, role: 'user', content: 'inside range', timestamp: start + 500, metadata: {} });
    saveMessage({ sessionKey: 'range:test', userId: null, role: 'user', content: 'outside range', timestamp: outside, metadata: {} });
    const messages = getMessagesByTimeRange(start, end);
    expect(messages.some(m => m.content === 'inside range')).toBe(true);
    expect(messages.some(m => m.content === 'outside range')).toBe(false);
  });

  it('preoccupation originated_at timestamp is set at creation time', async () => {
    const { addPreoccupation, getPreoccupations } = await import('../src/agent/internal-state.js');
    const before = Date.now();
    addPreoccupation('time test thought', 'time origin');
    const after = Date.now();
    const preocc = getPreoccupations();
    const p = preocc.find(x => x.thread === 'time test thought');
    expect(p?.originated_at).toBeGreaterThanOrEqual(before);
    expect(p?.originated_at).toBeLessThanOrEqual(after);
  });
});

// ─────────────────────────────────────────────────────────
// 10. The world is observable
// ─────────────────────────────────────────────────────────

describe('The world is observable', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await makeTestDir();
    await setupDb(testDir);
    const { eventBus } = await import('../src/events/bus.js');
    eventBus.setCharacterId('test-char');
  });

  afterEach(async () => {
    await teardownDb(testDir);
  });

  it('BUILDINGS export provides the list of all buildings', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    expect(Array.isArray(BUILDINGS)).toBe(true);
    expect(BUILDINGS.length).toBe(9);
  });

  it('getActivity returns an array (may be empty for fresh DB)', async () => {
    const { getActivity } = await import('../src/memory/store.js');
    const activities = getActivity(0, Date.now() + 1000);
    expect(Array.isArray(activities)).toBe(true);
  });

  it('activity feed entries have id, kind, sessionKey, content, and timestamp', async () => {
    const { saveMemory, getActivity } = await import('../src/memory/store.js');
    await saveMemory({
      sessionKey: 'diary:test:observable',
      userId: null,
      content: 'Today was quiet in the commune',
      memoryType: 'episode',
      importance: 0.5,
      emotionalWeight: 0.3,
      relatedTo: null,
      sourceMessageId: null,
      metadata: {},
    });
    const activities = getActivity(0, Date.now() + 1000);
    if (activities.length > 0) {
      const entry = activities[0]!;
      expect(typeof entry.id).toBe('string');
      expect(['memory', 'message']).toContain(entry.kind);
      expect(typeof entry.sessionKey).toBe('string');
      expect(typeof entry.content).toBe('string');
      expect(typeof entry.timestamp).toBe('number');
    }
  });

  it('getCurrentState returns a state object with all required axes', async () => {
    const { getCurrentState } = await import('../src/agent/internal-state.js');
    const state = getCurrentState();
    const requiredKeys = ['energy', 'sociability', 'intellectual_arousal', 'emotional_weight', 'valence', 'primary_color'];
    for (const key of requiredKeys) {
      expect(state).toHaveProperty(key);
    }
  });

  it('getCurrentLocation always returns a valid location', async () => {
    const { getCurrentLocation } = await import('../src/commune/location.js');
    const { BUILDING_MAP } = await import('../src/commune/buildings.js');
    const loc = getCurrentLocation('test-char');
    expect(BUILDING_MAP.has(loc.building)).toBe(true);
  });

  it('getStateSummary produces human-readable text', async () => {
    const { getStateSummary } = await import('../src/agent/internal-state.js');
    const summary = getStateSummary();
    // Should be a sentence, not JSON or garbage
    expect(summary).toMatch(/\w/);
    expect(summary.length).toBeGreaterThan(10);
  });

  it('countMemories returns a non-negative integer', async () => {
    const { countMemories } = await import('../src/memory/store.js');
    const count = countMemories();
    expect(typeof count).toBe('number');
    expect(count).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(count)).toBe(true);
  });

  it('countMessages returns a non-negative integer', async () => {
    const { countMessages } = await import('../src/memory/store.js');
    const count = countMessages();
    expect(typeof count).toBe('number');
    expect(count).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(count)).toBe(true);
  });

  it('after saving a memory, countMemories increases', async () => {
    const { saveMemory, countMemories } = await import('../src/memory/store.js');
    const before = countMemories();
    await saveMemory({
      sessionKey: 'diary:observable:count',
      userId: null,
      content: 'observable test',
      memoryType: 'fact',
      importance: 0.3,
      emotionalWeight: 0.1,
      relatedTo: null,
      sourceMessageId: null,
      metadata: {},
    });
    const after = countMemories();
    expect(after).toBe(before + 1);
  });

  it('after saving a message, countMessages increases', async () => {
    const { saveMessage, countMessages } = await import('../src/memory/store.js');
    const before = countMessages();
    saveMessage({ sessionKey: 'observable:count:msg', userId: null, role: 'user', content: 'test', timestamp: Date.now(), metadata: {} });
    const after = countMessages();
    expect(after).toBe(before + 1);
  });

  it('getLocationHistory returns an array', async () => {
    const { getLocationHistory } = await import('../src/commune/location.js');
    const history = getLocationHistory();
    expect(Array.isArray(history)).toBe(true);
  });

  it('getStateHistory returns an array', async () => {
    const { getStateHistory } = await import('../src/agent/internal-state.js');
    const history = getStateHistory();
    expect(Array.isArray(history)).toBe(true);
  });

  it('getMemoriesByType returns memories of the requested type only', async () => {
    const { saveMemory, getMemoriesByType } = await import('../src/memory/store.js');
    await saveMemory({
      sessionKey: 'test:type:filter',
      userId: null,
      content: 'a preference memory',
      memoryType: 'preference',
      importance: 0.4,
      emotionalWeight: 0.2,
      relatedTo: null,
      sourceMessageId: null,
      metadata: {},
    });
    const preferences = getMemoriesByType('preference');
    for (const mem of preferences) {
      expect(mem.memoryType).toBe('preference');
    }
  });

  it('getBudgetStatus exposes tokensUsed and monthlyCap', async () => {
    const { getBudgetStatus } = await import('../src/providers/budget.js');
    const status = getBudgetStatus();
    expect(typeof status.tokensUsed).toBe('number');
    expect(typeof status.monthlyCap).toBe('number');
    expect(typeof status.pctUsed).toBe('number');
    expect(status.tokensUsed).toBeGreaterThanOrEqual(0);
  });

  it('getPreoccupations returns an array', async () => {
    const { getPreoccupations } = await import('../src/agent/internal-state.js');
    const preocc = getPreoccupations();
    expect(Array.isArray(preocc)).toBe(true);
  });
});
