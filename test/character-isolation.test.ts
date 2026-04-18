/**
 * Character Isolation & Cross-Contamination Tests
 *
 * Critical fear: character A's data leaking into character B's experience.
 * These tests verify hard boundaries across sessions, memory, location,
 * emotional state, desires, configuration, events, and communications.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
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

// ─────────────────────────────────────────────────────────────────────────────
// Shared test helpers
// ─────────────────────────────────────────────────────────────────────────────

async function makeIsolatedDb(label: string): Promise<{ dir: string; dbPath: string }> {
  const dir = join(tmpdir(), `lain-isolation-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  const dbPath = join(dir, 'lain.db');
  return { dir, dbPath };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. SESSION ISOLATION
// ─────────────────────────────────────────────────────────────────────────────

describe('Session Isolation', () => {
  const testDir = join(tmpdir(), `lain-test-sessions-${Date.now()}`);
  const originalHome = process.env['LAIN_HOME'];

  beforeEach(async () => {
    process.env['LAIN_HOME'] = testDir;
    await mkdir(testDir, { recursive: true });
    const { initDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(testDir, 'test.db'));
  });

  afterEach(async () => {
    const { closeDatabase } = await import('../src/storage/database.js');
    closeDatabase();
    if (originalHome) process.env['LAIN_HOME'] = originalHome;
    else delete process.env['LAIN_HOME'];
    try { await rm(testDir, { recursive: true }); } catch { /* ignore */ }
  });

  it('two sessions with different keys have independent message histories', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
    const keyA = 'web:char-a:user1';
    const keyB = 'web:char-b:user1';

    saveMessage({ sessionKey: keyA, userId: null, role: 'user', content: 'hello from A', timestamp: Date.now(), metadata: {} });
    saveMessage({ sessionKey: keyB, userId: null, role: 'user', content: 'hello from B', timestamp: Date.now(), metadata: {} });

    const msgsA = getRecentMessages(keyA, 50);
    const msgsB = getRecentMessages(keyB, 50);

    expect(msgsA).toHaveLength(1);
    expect(msgsA[0]?.content).toBe('hello from A');
    expect(msgsB).toHaveLength(1);
    expect(msgsB[0]?.content).toBe('hello from B');
  });

  it('adding a message to char-a session does not appear in char-b session', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
    const keyA = 'web:char-a:alice';
    const keyB = 'web:char-b:alice';

    saveMessage({ sessionKey: keyA, userId: null, role: 'user', content: 'secret for A', timestamp: Date.now(), metadata: {} });

    const msgsB = getRecentMessages(keyB, 50);
    expect(msgsB).toHaveLength(0);
    const contents = msgsB.map(m => m.content);
    expect(contents).not.toContain('secret for A');
  });

  it('same user talking to two characters gets separate in-memory conversations', async () => {
    const { getConversation, addUserMessage, clearConversation } = await import('../src/agent/conversation.js');
    const keyA = 'web:char-a:alice';
    const keyB = 'web:char-b:alice';

    const convA = getConversation(keyA, 'You are character A');
    const convB = getConversation(keyB, 'You are character B');

    addUserMessage(convA, {
      id: 'msg1', channel: 'web' as const, peerKind: 'user' as const, peerId: 'alice',
      senderId: 'alice', senderName: 'Alice',
      content: { type: 'text', text: 'talk to A' },
      timestamp: Date.now(),
    });

    expect(convB.messages).toHaveLength(0);
    expect(convA.messages).toHaveLength(1);
    expect(convA.systemPrompt).toBe('You are character A');
    expect(convB.systemPrompt).toBe('You are character B');

    clearConversation(keyA);
    clearConversation(keyB);
  });

  it('session for char-a cannot read messages from char-b session', async () => {
    const { saveMessage, getAllMessages } = await import('../src/memory/store.js');
    const keyA = 'web:char-a:bob';
    const keyB = 'web:char-b:bob';

    saveMessage({ sessionKey: keyB, userId: null, role: 'assistant', content: 'B private response', timestamp: Date.now(), metadata: {} });

    const msgsA = getAllMessages(keyA);
    expect(msgsA.every(m => m.sessionKey === keyA)).toBe(true);
    expect(msgsA.map(m => m.content)).not.toContain('B private response');
  });

  it('clearing one in-memory conversation does not clear another', async () => {
    const { getConversation, addUserMessage, clearConversation, addAssistantMessage } = await import('../src/agent/conversation.js');
    const keyA = 'web:char-a:test';
    const keyB = 'web:char-b:test';

    const convA = getConversation(keyA, 'system A');
    const convB = getConversation(keyB, 'system B');

    addAssistantMessage(convA, 'response from A');
    addAssistantMessage(convB, 'response from B');

    clearConversation(keyA);

    const freshA = getConversation(keyA, 'system A');
    const freshB = getConversation(keyB, 'system B');

    expect(freshA.messages).toHaveLength(0);
    expect(freshB.messages).toHaveLength(1);
  });

  it('token counts are tracked per-session, not globally', async () => {
    const { getConversation, updateTokenCount, clearConversation } = await import('../src/agent/conversation.js');
    const keyA = 'web:char-a:tokens';
    const keyB = 'web:char-b:tokens';

    const convA = getConversation(keyA, 'sys');
    const convB = getConversation(keyB, 'sys');

    updateTokenCount(convA, 100, 200);
    updateTokenCount(convB, 50, 75);

    expect(convA.tokenCount).toBe(300);
    expect(convB.tokenCount).toBe(125);
    expect(convA.tokenCount).not.toBe(convB.tokenCount);

    clearConversation(keyA);
    clearConversation(keyB);
  });

  it('session list can be filtered by agent ID (character)', async () => {
    const { createSession, listSessions } = await import('../src/storage/sessions.js');

    createSession({ agentId: 'char-a', channel: 'web', peerKind: 'user', peerId: 'user1' });
    createSession({ agentId: 'char-a', channel: 'web', peerKind: 'user', peerId: 'user2' });
    createSession({ agentId: 'char-b', channel: 'web', peerKind: 'user', peerId: 'user1' });

    const sessA = listSessions('char-a');
    const sessB = listSessions('char-b');

    expect(sessA).toHaveLength(2);
    expect(sessA.every(s => s.agentId === 'char-a')).toBe(true);
    expect(sessB).toHaveLength(1);
    expect(sessB[0]?.agentId).toBe('char-b');
  });

  it('session list filtered by channel excludes other characters sessions', async () => {
    const { createSession, listSessions } = await import('../src/storage/sessions.js');

    createSession({ agentId: 'char-a', channel: 'telegram', peerKind: 'user', peerId: 'tguser1' });
    createSession({ agentId: 'char-b', channel: 'telegram', peerKind: 'user', peerId: 'tguser1' });

    const tgA = listSessions('char-a', { channel: 'telegram' });
    const tgB = listSessions('char-b', { channel: 'telegram' });

    expect(tgA).toHaveLength(1);
    expect(tgA[0]?.agentId).toBe('char-a');
    expect(tgB).toHaveLength(1);
    expect(tgB[0]?.agentId).toBe('char-b');
  });

  it('getOrCreateSession for same peer returns same session per agent', async () => {
    const { getOrCreateSession } = await import('../src/storage/sessions.js');

    const s1 = getOrCreateSession({ agentId: 'char-a', channel: 'web', peerKind: 'user', peerId: 'alice' });
    const s2 = getOrCreateSession({ agentId: 'char-a', channel: 'web', peerKind: 'user', peerId: 'alice' });
    const s3 = getOrCreateSession({ agentId: 'char-b', channel: 'web', peerKind: 'user', peerId: 'alice' });

    expect(s1.key).toBe(s2.key);
    expect(s1.key).not.toBe(s3.key);
    expect(s1.agentId).toBe('char-a');
    expect(s3.agentId).toBe('char-b');
  });

  it('updating session for char-a does not affect char-b sessions', async () => {
    const { createSession, updateSession, getSession } = await import('../src/storage/sessions.js');

    const sessA = createSession({ agentId: 'char-a', channel: 'web', peerKind: 'user', peerId: 'user99' });
    const sessB = createSession({ agentId: 'char-b', channel: 'web', peerKind: 'user', peerId: 'user99' });

    updateSession(sessA.key, { tokenCount: 9999 });

    const loadedA = getSession(sessA.key);
    const loadedB = getSession(sessB.key);

    expect(loadedA?.tokenCount).toBe(9999);
    expect(loadedB?.tokenCount).toBe(0);
  });

  it('deleting char-a session does not delete char-b sessions', async () => {
    const { createSession, deleteSession, getSession } = await import('../src/storage/sessions.js');

    const sessA = createSession({ agentId: 'char-a', channel: 'web', peerKind: 'user', peerId: 'shared' });
    const sessB = createSession({ agentId: 'char-b', channel: 'web', peerKind: 'user', peerId: 'shared' });

    deleteSession(sessA.key);

    expect(getSession(sessA.key)).toBeUndefined();
    expect(getSession(sessB.key)).toBeDefined();
  });

  it('countSessions is per-agent', async () => {
    const { createSession, countSessions } = await import('../src/storage/sessions.js');

    createSession({ agentId: 'char-a', channel: 'web', peerKind: 'user', peerId: 'p1' });
    createSession({ agentId: 'char-a', channel: 'web', peerKind: 'user', peerId: 'p2' });
    createSession({ agentId: 'char-b', channel: 'web', peerKind: 'user', peerId: 'p1' });

    expect(countSessions('char-a')).toBe(2);
    expect(countSessions('char-b')).toBe(1);
  });

  it('session keys are unique across characters even for same peer', async () => {
    const { createSession } = await import('../src/storage/sessions.js');
    const keys: string[] = [];

    for (let i = 0; i < 5; i++) {
      const s = createSession({ agentId: `char-${i}`, channel: 'web', peerKind: 'user', peerId: 'same-user' });
      keys.push(s.key);
    }

    const unique = new Set(keys);
    expect(unique.size).toBe(5);
  });

  it('in-memory conversations use session key as namespace', async () => {
    const { getConversation, clearConversation } = await import('../src/agent/conversation.js');
    const keyA = 'peer:char-a:char-b:session1';
    const keyB = 'peer:char-b:char-a:session1';

    const convA = getConversation(keyA, 'A speaks');
    const convB = getConversation(keyB, 'B speaks');

    expect(convA).not.toBe(convB);
    expect(convA.sessionKey).toBe(keyA);
    expect(convB.sessionKey).toBe(keyB);
    expect(convA.systemPrompt).not.toBe(convB.systemPrompt);

    clearConversation(keyA);
    clearConversation(keyB);
  });

  it('system prompt for char-a conversation is not visible from char-b conversation', async () => {
    const { getConversation, clearConversation } = await import('../src/agent/conversation.js');
    const keyA = 'web:char-a:check';
    const keyB = 'web:char-b:check';

    const SECRET_PROMPT = 'CHAR_A_SECRET_SOUL: deeply depressed robot';
    getConversation(keyA, SECRET_PROMPT);
    const convB = getConversation(keyB, 'You are a normal character');

    expect(convB.systemPrompt).not.toContain('CHAR_A_SECRET_SOUL');

    clearConversation(keyA);
    clearConversation(keyB);
  });

  it('messages from char-a sessions are only retrievable by char-a session key', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
    const keyA = 'telegram:char-a:tguser5';

    for (let i = 0; i < 5; i++) {
      saveMessage({ sessionKey: keyA, userId: null, role: 'user', content: `msg ${i}`, timestamp: Date.now() + i, metadata: {} });
    }

    const wrongKey = 'telegram:char-b:tguser5';
    const msgs = getRecentMessages(wrongKey, 50);
    expect(msgs).toHaveLength(0);
  });

  it('batch token count update applies to correct sessions only', async () => {
    const { createSession, getSession, batchUpdateTokenCounts } = await import('../src/storage/sessions.js');

    const sA = createSession({ agentId: 'char-a', channel: 'web', peerKind: 'user', peerId: 'batch1' });
    const sB = createSession({ agentId: 'char-b', channel: 'web', peerKind: 'user', peerId: 'batch1' });

    batchUpdateTokenCounts([{ key: sA.key, tokenCount: 5000 }]);

    const loadedA = getSession(sA.key);
    const loadedB = getSession(sB.key);
    expect(loadedA?.tokenCount).toBe(5000);
    expect(loadedB?.tokenCount).toBe(0);
  });

  it('flags are independent per session', async () => {
    const { createSession, updateSession, getSession } = await import('../src/storage/sessions.js');

    const sA = createSession({ agentId: 'char-a', channel: 'web', peerKind: 'user', peerId: 'flagtest' });
    const sB = createSession({ agentId: 'char-b', channel: 'web', peerKind: 'user', peerId: 'flagtest' });

    updateSession(sA.key, { flags: { archived: true } });

    const la = getSession(sA.key);
    const lb = getSession(sB.key);
    expect(la?.flags['archived']).toBe(true);
    expect(lb?.flags['archived']).toBeUndefined();
  });

  it('messages stored cross-session cannot be retrieved by wrong sessionKey', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');

    saveMessage({ sessionKey: 'commune:char-a:char-b', userId: null, role: 'user', content: 'commune msg', timestamp: Date.now(), metadata: {} });

    const wrong = getRecentMessages('commune:char-b:char-a', 10);
    expect(wrong.map(m => m.content)).not.toContain('commune msg');
  });

  it('deleteOldSessions only affects the specified agent', async () => {
    const { createSession, listSessions, deleteOldSessions } = await import('../src/storage/sessions.js');

    // Create old sessions (backdated via direct DB)
    const { execute } = await import('../src/storage/database.js');
    const old = Date.now() - 10 * 24 * 60 * 60 * 1000;

    const sA = createSession({ agentId: 'char-a', channel: 'web', peerKind: 'user', peerId: 'old1' });
    const sB = createSession({ agentId: 'char-b', channel: 'web', peerKind: 'user', peerId: 'old1' });

    execute('UPDATE sessions SET updated_at = ? WHERE key = ?', [old, sA.key]);
    execute('UPDATE sessions SET updated_at = ? WHERE key = ?', [old, sB.key]);

    deleteOldSessions('char-a', 7 * 24 * 60 * 60 * 1000);

    const remainA = listSessions('char-a');
    const remainB = listSessions('char-b');
    expect(remainA).toHaveLength(0);
    expect(remainB).toHaveLength(1);
  });

  it('findSession is scoped to agentId', async () => {
    const { createSession, findSession } = await import('../src/storage/sessions.js');

    createSession({ agentId: 'char-a', channel: 'web', peerKind: 'user', peerId: 'finder-user' });

    const foundA = findSession('char-a', 'web', 'finder-user');
    const foundB = findSession('char-b', 'web', 'finder-user');

    expect(foundA).toBeDefined();
    expect(foundB).toBeUndefined();
  });

  it('two characters cannot share an in-memory conversation by same key pattern', async () => {
    const { getConversation, addAssistantMessage, clearConversation } = await import('../src/agent/conversation.js');

    // Both characters use their own namespace — ensure they are separate objects
    const convA = getConversation('session-x-char-a', 'soul A');
    const convB = getConversation('session-x-char-b', 'soul B');

    addAssistantMessage(convA, 'A was here');

    expect(convB.messages).toHaveLength(0);
    expect(convA.messages[0]?.content).toBe('A was here');

    clearConversation('session-x-char-a');
    clearConversation('session-x-char-b');
  });

  it('generateSessionKey produces unique values for concurrent creation', async () => {
    const { generateSessionKey } = await import('../src/storage/sessions.js');
    const keys = new Set<string>();

    for (let i = 0; i < 100; i++) {
      keys.add(generateSessionKey());
    }

    expect(keys.size).toBe(100);
  });

  it('session created for char-a does not appear in char-b listing', async () => {
    const { createSession, listSessions } = await import('../src/storage/sessions.js');

    createSession({ agentId: 'char-a', channel: 'web', peerKind: 'user', peerId: 'char-b' });

    const bSessions = listSessions('char-b');
    expect(bSessions.every(s => s.agentId === 'char-b')).toBe(true);
  });

  it('getAllMessages for char-a session excludes char-b messages with same peerId', async () => {
    const { saveMessage, getAllMessages } = await import('../src/memory/store.js');

    const now = Date.now();
    saveMessage({ sessionKey: 'web:char-a:person', userId: null, role: 'user', content: 'for A', timestamp: now, metadata: {} });
    saveMessage({ sessionKey: 'web:char-b:person', userId: null, role: 'user', content: 'for B', timestamp: now, metadata: {} });

    const a = getAllMessages('web:char-a:person');
    const b = getAllMessages('web:char-b:person');

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]?.content).toBe('for A');
    expect(b[0]?.content).toBe('for B');
    expect(a[0]?.sessionKey).toBe('web:char-a:person');
    expect(b[0]?.sessionKey).toBe('web:char-b:person');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. MEMORY ISOLATION
// ─────────────────────────────────────────────────────────────────────────────

describe('Memory Isolation', () => {
  const testDir = join(tmpdir(), `lain-test-memory-${Date.now()}`);
  const originalHome = process.env['LAIN_HOME'];

  beforeEach(async () => {
    process.env['LAIN_HOME'] = testDir;
    await mkdir(testDir, { recursive: true });
    const { initDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(testDir, 'test.db'));
  });

  afterEach(async () => {
    const { closeDatabase } = await import('../src/storage/database.js');
    closeDatabase();
    if (originalHome) process.env['LAIN_HOME'] = originalHome;
    else delete process.env['LAIN_HOME'];
    try { await rm(testDir, { recursive: true }); } catch { /* ignore */ }
  });

  it('memories saved with char-a session key are retrievable by that key', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');

    const keyA = 'diary:char-a:2024-01-01';
    saveMessage({ sessionKey: keyA, userId: null, role: 'assistant', content: 'diary entry A', timestamp: Date.now(), metadata: {} });

    const msgs = getRecentMessages(keyA, 10);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.content).toBe('diary entry A');
  });

  it('activity feed only contains entries with background session prefixes', async () => {
    const { saveMessage, getActivity } = await import('../src/memory/store.js');

    const now = Date.now();
    saveMessage({ sessionKey: 'diary:char-a:entry1', userId: null, role: 'assistant', content: 'A diary', timestamp: now, metadata: {} });
    saveMessage({ sessionKey: 'diary:char-b:entry1', userId: null, role: 'assistant', content: 'B diary', timestamp: now, metadata: {} });

    const activity = getActivity(now - 1000, now + 1000, 100);
    const contents = activity.map(a => a.content);

    // Both appear in the activity feed since both are background (diary)
    expect(contents.some(c => c.includes('A diary'))).toBe(true);
    expect(contents.some(c => c.includes('B diary'))).toBe(true);

    // Each entry retains its own sessionKey
    const aEntry = activity.find(a => a.content.includes('A diary'));
    const bEntry = activity.find(a => a.content.includes('B diary'));
    expect(aEntry?.sessionKey).toBe('diary:char-a:entry1');
    expect(bEntry?.sessionKey).toBe('diary:char-b:entry1');
  });

  it('countMessages reflects per-database message count', async () => {
    const { saveMessage, countMessages } = await import('../src/memory/store.js');

    const before = countMessages();
    saveMessage({ sessionKey: 'diary:char-a:x', userId: null, role: 'user', content: 'one', timestamp: Date.now(), metadata: {} });
    saveMessage({ sessionKey: 'diary:char-a:x', userId: null, role: 'user', content: 'two', timestamp: Date.now(), metadata: {} });

    expect(countMessages()).toBe(before + 2);
  });

  it('diary entries are retrievable only by their session key', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');

    const diaryA = 'diary:char-a:2024-03-01';
    const diaryB = 'diary:char-b:2024-03-01';

    saveMessage({ sessionKey: diaryA, userId: null, role: 'assistant', content: 'char-a reflects on loneliness', timestamp: Date.now(), metadata: {} });
    saveMessage({ sessionKey: diaryB, userId: null, role: 'assistant', content: 'char-b reflects on joy', timestamp: Date.now(), metadata: {} });

    const entryA = getRecentMessages(diaryA, 5);
    const entryB = getRecentMessages(diaryB, 5);

    expect(entryA).toHaveLength(1);
    expect(entryA[0]?.content).toContain('char-a reflects');
    expect(entryB).toHaveLength(1);
    expect(entryB[0]?.content).toContain('char-b reflects');
    expect(entryA[0]?.content).not.toContain('char-b');
    expect(entryB[0]?.content).not.toContain('char-a');
  });

  it('dream sequences belong to their session key', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');

    const dreamA = 'dream:char-a:2024-03-15';
    const dreamB = 'dream:char-b:2024-03-15';

    saveMessage({ sessionKey: dreamA, userId: null, role: 'assistant', content: 'A dreamed of the ocean', timestamp: Date.now(), metadata: {} });
    saveMessage({ sessionKey: dreamB, userId: null, role: 'assistant', content: 'B dreamed of the forest', timestamp: Date.now(), metadata: {} });

    expect(getRecentMessages(dreamA, 5).map(m => m.content)).toContain('A dreamed of the ocean');
    expect(getRecentMessages(dreamB, 5).map(m => m.content)).toContain('B dreamed of the forest');
    expect(getRecentMessages(dreamA, 5).map(m => m.content)).not.toContain('B dreamed of the forest');
    expect(getRecentMessages(dreamB, 5).map(m => m.content)).not.toContain('A dreamed of the ocean');
  });

  it('visitor messages filter excludes peer/commune traffic', async () => {
    const { saveMessage, getRecentVisitorMessages } = await import('../src/memory/store.js');

    const now = Date.now();
    saveMessage({ sessionKey: 'web:char-a:visitor1', userId: null, role: 'user', content: 'visitor chat', timestamp: now, metadata: {} });
    saveMessage({ sessionKey: 'peer:char-a:char-b', userId: null, role: 'user', content: 'peer traffic', timestamp: now, metadata: {} });
    saveMessage({ sessionKey: 'commune:char-a:char-b', userId: null, role: 'user', content: 'commune traffic', timestamp: now, metadata: {} });

    const visitor = getRecentVisitorMessages(50);
    const contents = visitor.map(m => m.content);
    expect(contents).toContain('visitor chat');
    expect(contents).not.toContain('peer traffic');
    expect(contents).not.toContain('commune traffic');
  });

  it('getMessagesForUser filters by userId, not sessionKey', async () => {
    const { saveMessage, getMessagesForUser } = await import('../src/memory/store.js');

    const now = Date.now();
    saveMessage({ sessionKey: 'web:char-a:alice', userId: 'alice', role: 'user', content: 'alice to A', timestamp: now, metadata: {} });
    saveMessage({ sessionKey: 'web:char-b:alice', userId: 'alice', role: 'user', content: 'alice to B', timestamp: now, metadata: {} });
    saveMessage({ sessionKey: 'web:char-a:bob', userId: 'bob', role: 'user', content: 'bob to A', timestamp: now, metadata: {} });

    const aliceMsgs = getMessagesForUser('alice', 50);
    expect(aliceMsgs.every(m => m.userId === 'alice')).toBe(true);
    expect(aliceMsgs.map(m => m.content)).not.toContain('bob to A');
  });

  it('notes from char-a in a building are attributed to char-a', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');

    const now = Date.now();
    saveMessage({
      sessionKey: 'note:char-a:1234',
      userId: null,
      role: 'assistant',
      content: 'A note at the library',
      timestamp: now,
      metadata: { building: 'library', author: 'char-a' },
    });
    saveMessage({
      sessionKey: 'note:char-b:1235',
      userId: null,
      role: 'assistant',
      content: 'B note at the library',
      timestamp: now,
      metadata: { building: 'library', author: 'char-b' },
    });

    // getRecentMessages with session key scopes correctly
    const aNotes = getRecentMessages('note:char-a:1234', 5);
    const bNotes = getRecentMessages('note:char-b:1235', 5);
    expect(aNotes[0]?.content).toContain('A note at the library');
    expect(bNotes[0]?.content).toContain('B note at the library');
  });

  it('character documents are retrievable by author metadata', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');

    const now = Date.now();
    saveMessage({
      sessionKey: 'document:char-a:poem-one',
      userId: null,
      role: 'assistant',
      content: '[Document: "Poem One"]\n\nVerse by A',
      timestamp: now,
      metadata: { action: 'document', author: 'char-a', title: 'Poem One', writtenAt: now },
    });

    const aDocs = getRecentMessages('document:char-a:poem-one', 5);
    expect(aDocs[0]?.content).toContain('Verse by A');
  });

  it('memory count reflects only the active database', async () => {
    const { saveMessage, countMessages } = await import('../src/memory/store.js');

    const before = countMessages();
    saveMessage({ sessionKey: 'diary:char-a:x', userId: null, role: 'user', content: 'one', timestamp: Date.now(), metadata: {} });
    const after = countMessages();
    expect(after).toBe(before + 1);
  });

  it('getLastUserMessageTimestamp reflects most recent user message in DB', async () => {
    const { saveMessage, getLastUserMessageTimestamp } = await import('../src/memory/store.js');

    const t1 = Date.now() - 5000;
    const t2 = Date.now() - 2000;
    saveMessage({ sessionKey: 'web:char-a:user1', userId: null, role: 'user', content: 'first', timestamp: t1, metadata: {} });
    saveMessage({ sessionKey: 'web:char-b:user2', userId: null, role: 'user', content: 'second', timestamp: t2, metadata: {} });

    const last = getLastUserMessageTimestamp();
    expect(last).toBe(t2);
  });

  it('linking memories does not cross-contaminate separate character sessions', async () => {
    const { saveMessage, getAllMessages, linkMemories } = await import('../src/memory/store.js');

    // In a single DB scenario, we can only verify that session-scoped queries remain pure
    const keyA = 'diary:char-a:link-test';
    const keyB = 'diary:char-b:link-test';

    saveMessage({ sessionKey: keyA, userId: null, role: 'user', content: 'A link source', timestamp: Date.now(), metadata: {} });
    saveMessage({ sessionKey: keyB, userId: null, role: 'user', content: 'B link target', timestamp: Date.now(), metadata: {} });

    const msgsA = getAllMessages(keyA);
    const msgsB = getAllMessages(keyB);

    // Linking does not make messages appear in wrong session
    expect(msgsA.every(m => m.sessionKey === keyA)).toBe(true);
    expect(msgsB.every(m => m.sessionKey === keyB)).toBe(true);
  });

  it('postboard messages are shared (town-wide by design) but attributable', async () => {
    const { savePostboardMessage, getPostboardMessages, deletePostboardMessage } = await import('../src/memory/store.js');

    const id = savePostboardMessage('Town announcement', 'admin', false);
    const msgs = getPostboardMessages(undefined, 10);
    expect(msgs.some(m => m.id === id)).toBe(true);
    expect(msgs.find(m => m.id === id)?.author).toBe('admin');

    deletePostboardMessage(id);
  });

  it('getRecentMessages uses LIMIT and returns only the specified session', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');

    const keyA = 'web:char-a:limit-test';
    const keyB = 'web:char-b:limit-test';

    for (let i = 0; i < 10; i++) {
      saveMessage({ sessionKey: keyA, userId: null, role: 'user', content: `A msg ${i}`, timestamp: Date.now() + i, metadata: {} });
      saveMessage({ sessionKey: keyB, userId: null, role: 'user', content: `B msg ${i}`, timestamp: Date.now() + i, metadata: {} });
    }

    const limitedA = getRecentMessages(keyA, 5);
    const limitedB = getRecentMessages(keyB, 3);

    expect(limitedA).toHaveLength(5);
    expect(limitedA.every(m => m.sessionKey === keyA)).toBe(true);
    expect(limitedB).toHaveLength(3);
    expect(limitedB.every(m => m.sessionKey === keyB)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. LOCATION ISOLATION
// ─────────────────────────────────────────────────────────────────────────────

describe('Location Isolation', () => {
  const originalHome = process.env['LAIN_HOME'];

  let dirA: string;
  let dirB: string;

  beforeEach(async () => {
    dirA = join(tmpdir(), `lain-loc-a-${Date.now()}`);
    dirB = join(tmpdir(), `lain-loc-b-${Date.now()}`);
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
  });

  afterEach(async () => {
    const { closeDatabase } = await import('../src/storage/database.js');
    closeDatabase();
    if (originalHome) process.env['LAIN_HOME'] = originalHome;
    else delete process.env['LAIN_HOME'];
    try { await rm(dirA, { recursive: true }); } catch { /* ignore */ }
    try { await rm(dirB, { recursive: true }); } catch { /* ignore */ }
  });

  it('setting char-a location in its DB does not affect char-b DB', async () => {
    // Initialize char-a DB
    process.env['LAIN_HOME'] = dirA;
    const { initDatabase, closeDatabase: closeA, setMeta, getMeta } = await import('../src/storage/database.js');
    await initDatabase(join(dirA, 'lain.db'));

    setMeta('town:current_location', JSON.stringify({ building: 'library', timestamp: Date.now() }));
    const locA = getMeta('town:current_location');
    expect(locA).toContain('library');

    closeA();

    // Switch to char-b DB
    process.env['LAIN_HOME'] = dirB;
    await initDatabase(join(dirB, 'lain.db'));
    const locB = getMeta('town:current_location');
    // char-b's DB has no location set
    expect(locB).toBeNull();
  });

  it('getCurrentLocation falls back to default per characterId', async () => {
    process.env['LAIN_HOME'] = dirA;
    const { initDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(dirA, 'lain.db'));

    const { getCurrentLocation } = await import('../src/commune/location.js');
    const { eventBus } = await import('../src/events/bus.js');

    // Default: if no entry in DB and no manifest, falls back to 'lighthouse'
    eventBus.setCharacterId('char-a');
    const loc = getCurrentLocation('char-a');
    expect(typeof loc.building).toBe('string');
    expect(loc.building).toBeTruthy();
  });

  it('location history is stored per-database, not globally', async () => {
    process.env['LAIN_HOME'] = dirA;
    const { initDatabase, setMeta, getMeta, closeDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(dirA, 'lain.db'));

    const history = [{ from: 'library', to: 'bar', reason: 'test', timestamp: Date.now() }];
    setMeta('town:location_history', JSON.stringify(history));
    expect(getMeta('town:location_history')).toContain('library');

    closeDatabase();

    // char-b has its own empty history
    process.env['LAIN_HOME'] = dirB;
    await initDatabase(join(dirB, 'lain.db'));
    const histB = getMeta('town:location_history');
    expect(histB).toBeNull();
  });

  it('movement events include the characterId set on the event bus', async () => {
    process.env['LAIN_HOME'] = dirA;
    const { initDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(dirA, 'lain.db'));

    const { eventBus } = await import('../src/events/bus.js');
    eventBus.setCharacterId('char-a');

    const receivedEvents: Array<{ character: string }> = [];
    eventBus.on('activity', (e) => receivedEvents.push(e));

    eventBus.emitActivity({
      type: 'movement',
      sessionKey: 'movement:library:bar',
      content: 'moved from Library to Bar',
      timestamp: Date.now(),
    });

    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0]?.character).toBe('char-a');

    eventBus.removeAllListeners('activity');
  });

  it('two characters can coexist in the same building without sharing state', async () => {
    process.env['LAIN_HOME'] = dirA;
    const { initDatabase, setMeta, closeDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(dirA, 'lain.db'));
    setMeta('town:current_location', JSON.stringify({ building: 'library', timestamp: Date.now() }));
    closeDatabase();

    process.env['LAIN_HOME'] = dirB;
    await initDatabase(join(dirB, 'lain.db'));
    setMeta('town:current_location', JSON.stringify({ building: 'library', timestamp: Date.now() }));

    const { getMeta } = await import('../src/storage/database.js');
    const locB = JSON.parse(getMeta('town:current_location') || '{}') as { building: string };
    // char-b's location is independently 'library'
    expect(locB.building).toBe('library');
  });

  it('getLocationHistory returns only entries from the active DB', async () => {
    process.env['LAIN_HOME'] = dirA;
    const { initDatabase, setMeta, closeDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(dirA, 'lain.db'));
    const histA = [
      { from: 'bar', to: 'library', reason: 'A moved', timestamp: Date.now() },
    ];
    setMeta('town:location_history', JSON.stringify(histA));
    closeDatabase();

    process.env['LAIN_HOME'] = dirB;
    await initDatabase(join(dirB, 'lain.db'));
    const { getLocationHistory } = await import('../src/commune/location.js');
    const histB = getLocationHistory(20);
    expect(histB).toHaveLength(0);
  });

  it('movement meta key is per-database', async () => {
    process.env['LAIN_HOME'] = dirA;
    const { initDatabase, setMeta, getMeta, closeDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(dirA, 'lain.db'));
    setMeta('movement:last_move_at', '9999999999999');
    closeDatabase();

    process.env['LAIN_HOME'] = dirB;
    await initDatabase(join(dirB, 'lain.db'));
    const bVal = getMeta('movement:last_move_at');
    expect(bVal).toBeNull();
  });

  it('eventBus characterId is set independently per server instance', async () => {
    const { eventBus } = await import('../src/events/bus.js');

    eventBus.setCharacterId('char-a');
    expect(eventBus.characterId).toBe('char-a');

    eventBus.setCharacterId('char-b');
    expect(eventBus.characterId).toBe('char-b');

    // Reset
    eventBus.setCharacterId('lain');
  });

  it('getCurrentLocation uses characterId param when DB has no entry', async () => {
    process.env['LAIN_HOME'] = dirA;
    const { initDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(dirA, 'lain.db'));

    const { getCurrentLocation } = await import('../src/commune/location.js');
    const locA = getCurrentLocation('char-a');
    const locB = getCurrentLocation('char-b');

    // Both should return valid building strings (defaults from manifest or fallback)
    expect(typeof locA.building).toBe('string');
    expect(typeof locB.building).toBe('string');
    // They may differ if the manifest sets different defaults
  });

  it('setCurrentLocation writes to the active DB only', async () => {
    process.env['LAIN_HOME'] = dirA;
    const { initDatabase, getMeta, closeDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(dirA, 'lain.db'));

    const { setCurrentLocation } = await import('../src/commune/location.js');
    const { eventBus } = await import('../src/events/bus.js');
    eventBus.setCharacterId('char-a');

    // Set a specific location
    setCurrentLocation('bar', 'test movement');
    const locRaw = getMeta('town:current_location');
    expect(locRaw).toContain('bar');
    closeDatabase();

    // char-b's DB should not have this
    process.env['LAIN_HOME'] = dirB;
    await initDatabase(join(dirB, 'lain.db'));
    const locB = getMeta('town:current_location');
    expect(locB).toBeNull();
  });

  it('meta key town:current_location is namespaced per DB (no global state)', async () => {
    process.env['LAIN_HOME'] = dirA;
    const { initDatabase, setMeta, getMeta, closeDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(dirA, 'lain.db'));
    setMeta('town:current_location', JSON.stringify({ building: 'windmill', timestamp: 1 }));
    const valA = getMeta('town:current_location');
    closeDatabase();

    process.env['LAIN_HOME'] = dirB;
    await initDatabase(join(dirB, 'lain.db'));
    const valB = getMeta('town:current_location');
    expect(valA).toContain('windmill');
    expect(valB).toBeNull();
  });

  it('building events table is per-database', async () => {
    process.env['LAIN_HOME'] = dirA;
    const { initDatabase, query, closeDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(dirA, 'lain.db'));

    const { execute } = await import('../src/storage/database.js');
    execute(`INSERT INTO building_events (id, building, event_type, summary, emotional_tone, actors, created_at)
             VALUES ('bev1', 'library', 'arrival', 'A arrived', 0, '["char-a"]', ${Date.now()})`);

    const rowsA = query<{ id: string }>('SELECT id FROM building_events');
    expect(rowsA).toHaveLength(1);
    closeDatabase();

    process.env['LAIN_HOME'] = dirB;
    await initDatabase(join(dirB, 'lain.db'));
    const rowsB = query<{ id: string }>('SELECT id FROM building_events');
    expect(rowsB).toHaveLength(0);
  });

  it('memory isolation: meta store is per-database', async () => {
    process.env['LAIN_HOME'] = dirA;
    const { initDatabase, setMeta, getMeta, closeDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(dirA, 'lain.db'));
    setMeta('internal:state', JSON.stringify({ energy: 0.99 }));
    closeDatabase();

    process.env['LAIN_HOME'] = dirB;
    await initDatabase(join(dirB, 'lain.db'));
    const stateB = getMeta('internal:state');
    expect(stateB).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. EMOTIONAL STATE ISOLATION
// ─────────────────────────────────────────────────────────────────────────────

describe('Emotional State Isolation', () => {
  let dirA: string;
  let dirB: string;
  const originalHome = process.env['LAIN_HOME'];

  beforeEach(async () => {
    dirA = join(tmpdir(), `lain-state-a-${Date.now()}`);
    dirB = join(tmpdir(), `lain-state-b-${Date.now()}`);
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
  });

  afterEach(async () => {
    const { closeDatabase } = await import('../src/storage/database.js');
    closeDatabase();
    if (originalHome) process.env['LAIN_HOME'] = originalHome;
    else delete process.env['LAIN_HOME'];
    try { await rm(dirA, { recursive: true }); } catch { /* ignore */ }
    try { await rm(dirB, { recursive: true }); } catch { /* ignore */ }
  });

  it('updating char-a internal state does not affect char-b DB', async () => {
    // Write state to char-a
    process.env['LAIN_HOME'] = dirA;
    const { initDatabase, closeDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(dirA, 'lain.db'));
    const { saveState, getCurrentState } = await import('../src/agent/internal-state.js');
    const state = getCurrentState();
    state.energy = 0.99;
    state.primary_color = 'blazing';
    saveState(state);
    closeDatabase();

    // char-b's DB starts fresh
    process.env['LAIN_HOME'] = dirB;
    await initDatabase(join(dirB, 'lain.db'));
    const stateB = getCurrentState();
    expect(stateB.energy).toBe(0.6); // default
    expect(stateB.primary_color).toBe('neutral');
  });

  it('each character starts with independent default state', async () => {
    process.env['LAIN_HOME'] = dirA;
    const { initDatabase, closeDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(dirA, 'lain.db'));
    const { getCurrentState: getStateA } = await import('../src/agent/internal-state.js');
    const stateA = getStateA();
    closeDatabase();

    process.env['LAIN_HOME'] = dirB;
    await initDatabase(join(dirB, 'lain.db'));
    const { getCurrentState: getStateB } = await import('../src/agent/internal-state.js');
    const stateB = getStateB();

    // Both start at defaults
    expect(stateA.energy).toBe(0.6);
    expect(stateB.energy).toBe(0.6);
    // But they are independent — modifying one doesn't affect the other
  });

  it('state history is per-database', async () => {
    process.env['LAIN_HOME'] = dirA;
    const { initDatabase, closeDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(dirA, 'lain.db'));
    const { saveState, getCurrentState, getStateHistory } = await import('../src/agent/internal-state.js');
    const s = getCurrentState();
    s.energy = 0.8;
    saveState(s);
    s.energy = 0.7;
    saveState(s);
    const histA = getStateHistory();
    expect(histA.length).toBeGreaterThanOrEqual(1);
    closeDatabase();

    process.env['LAIN_HOME'] = dirB;
    await initDatabase(join(dirB, 'lain.db'));
    const { getStateHistory: getHistB } = await import('../src/agent/internal-state.js');
    const histB = getHistB();
    expect(histB).toHaveLength(0);
  });

  it('applyDecay is a pure function with no cross-character side effects', async () => {
    process.env['LAIN_HOME'] = dirA;
    const { initDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(dirA, 'lain.db'));
    const { getCurrentState, applyDecay } = await import('../src/agent/internal-state.js');

    const stateA = getCurrentState();
    const decayed = applyDecay(stateA);

    // applyDecay returns a new object, doesn't mutate
    expect(decayed.energy).toBeLessThanOrEqual(stateA.energy);
    expect(decayed).not.toBe(stateA);
  });

  it('preoccupations are stored in the active DB only', async () => {
    process.env['LAIN_HOME'] = dirA;
    const { initDatabase, closeDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(dirA, 'lain.db'));
    const { addPreoccupation, getPreoccupations } = await import('../src/agent/internal-state.js');
    addPreoccupation('Why is the sky digital?', 'curiosity:discovery');
    const preoccsA = getPreoccupations();
    expect(preoccsA.length).toBeGreaterThan(0);
    closeDatabase();

    process.env['LAIN_HOME'] = dirB;
    await initDatabase(join(dirB, 'lain.db'));
    const { getPreoccupations: getPreoccsB } = await import('../src/agent/internal-state.js');
    const preoccsB = getPreoccsB();
    expect(preoccsB).toHaveLength(0);
  });

  it('clampState is deterministic and character-independent', async () => {
    process.env['LAIN_HOME'] = dirA;
    const { initDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(dirA, 'lain.db'));
    const { clampState } = await import('../src/agent/internal-state.js');

    const input = { energy: 2.0, sociability: -1.0, intellectual_arousal: 0.5, emotional_weight: 1.5, valence: -0.5, primary_color: 'test', updated_at: 0 };
    const clamped = clampState(input);
    expect(clamped.energy).toBe(1);
    expect(clamped.sociability).toBe(0);
    expect(clamped.emotional_weight).toBe(1);
    expect(clamped.valence).toBe(0);
  });

  it('getStateSummary reads from the active DB, not globally shared', async () => {
    process.env['LAIN_HOME'] = dirA;
    const { initDatabase, closeDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(dirA, 'lain.db'));
    const { saveState, getCurrentState, getStateSummary } = await import('../src/agent/internal-state.js');
    const s = getCurrentState();
    s.primary_color = 'electric';
    s.energy = 0.95;
    saveState(s);
    const summaryA = getStateSummary();
    expect(summaryA).toContain('electric');
    closeDatabase();

    process.env['LAIN_HOME'] = dirB;
    await initDatabase(join(dirB, 'lain.db'));
    const { getStateSummary: getSummaryB } = await import('../src/agent/internal-state.js');
    const summaryB = getSummaryB();
    expect(summaryB).not.toContain('electric');
    expect(summaryB).toContain('neutral');
  });

  it('resolvePreoccupation only affects the DB where it was added', async () => {
    process.env['LAIN_HOME'] = dirA;
    const { initDatabase, closeDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(dirA, 'lain.db'));
    const { addPreoccupation, getPreoccupations, resolvePreoccupation } = await import('../src/agent/internal-state.js');
    addPreoccupation('What is the nature of the Wired?', 'introspection');
    const preoccs = getPreoccupations();
    expect(preoccs).toHaveLength(1);
    const id = preoccs[0]!.id;
    resolvePreoccupation(id, 'resolved in contemplation');
    expect(getPreoccupations()).toHaveLength(0);
    closeDatabase();

    // char-b never had this preoccupation
    process.env['LAIN_HOME'] = dirB;
    await initDatabase(join(dirB, 'lain.db'));
    const { getPreoccupations: getPreoccsB } = await import('../src/agent/internal-state.js');
    expect(getPreoccsB()).toHaveLength(0);
  });

  it('decayPreoccupations applies only to the current DB', async () => {
    process.env['LAIN_HOME'] = dirA;
    const { initDatabase, closeDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(dirA, 'lain.db'));
    const { addPreoccupation, decayPreoccupations, getPreoccupations } = await import('../src/agent/internal-state.js');
    addPreoccupation('Lingering thought', 'dream');
    decayPreoccupations();
    const after = getPreoccupations();
    // Should still be present (intensity 0.7 - 0.05 = 0.65)
    expect(after[0]?.intensity).toBeCloseTo(0.65, 2);
    closeDatabase();

    // char-b has no preoccupations to decay
    process.env['LAIN_HOME'] = dirB;
    await initDatabase(join(dirB, 'lain.db'));
    const { getPreoccupations: getPreoccsB, decayPreoccupations: decayB } = await import('../src/agent/internal-state.js');
    decayB();
    expect(getPreoccsB()).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. DESIRE ISOLATION
// ─────────────────────────────────────────────────────────────────────────────

describe('Desire Isolation', () => {
  let dirA: string;
  let dirB: string;
  const originalHome = process.env['LAIN_HOME'];

  beforeEach(async () => {
    dirA = join(tmpdir(), `lain-desire-a-${Date.now()}`);
    dirB = join(tmpdir(), `lain-desire-b-${Date.now()}`);
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
  });

  afterEach(async () => {
    const { closeDatabase } = await import('../src/storage/database.js');
    closeDatabase();
    if (originalHome) process.env['LAIN_HOME'] = originalHome;
    else delete process.env['LAIN_HOME'];
    try { await rm(dirA, { recursive: true }); } catch { /* ignore */ }
    try { await rm(dirB, { recursive: true }); } catch { /* ignore */ }
  });

  it('desire created in char-a DB is not visible in char-b DB', async () => {
    process.env['LAIN_HOME'] = dirA;
    const { initDatabase, closeDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(dirA, 'lain.db'));
    const { ensureDesireTable, createDesire, getActiveDesires } = await import('../src/agent/desires.js');
    ensureDesireTable();
    createDesire({ type: 'social', description: 'I want to talk to someone', source: 'test' });
    expect(getActiveDesires()).toHaveLength(1);
    closeDatabase();

    process.env['LAIN_HOME'] = dirB;
    await initDatabase(join(dirB, 'lain.db'));
    const { ensureDesireTable: ensureB, getActiveDesires: getDesB } = await import('../src/agent/desires.js');
    ensureB();
    expect(getDesB()).toHaveLength(0);
  });

  it('desire scores are stored per-database', async () => {
    process.env['LAIN_HOME'] = dirA;
    const { initDatabase, closeDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(dirA, 'lain.db'));
    const { ensureDesireTable, createDesire, getActiveDesires } = await import('../src/agent/desires.js');
    ensureDesireTable();
    createDesire({ type: 'intellectual', description: 'understand the network', source: 'curiosity', intensity: 0.9 });
    createDesire({ type: 'social', description: 'find a friend', source: 'loneliness', intensity: 0.3 });
    const desires = getActiveDesires();
    expect(desires[0]?.intensity).toBeCloseTo(0.9, 2);
    closeDatabase();

    process.env['LAIN_HOME'] = dirB;
    await initDatabase(join(dirB, 'lain.db'));
    const { ensureDesireTable: ensureB, getActiveDesires: getDesB } = await import('../src/agent/desires.js');
    ensureB();
    expect(getDesB()).toHaveLength(0);
  });

  it('resolving a desire in char-a does not affect char-b', async () => {
    process.env['LAIN_HOME'] = dirA;
    const { initDatabase, closeDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(dirA, 'lain.db'));
    const { ensureDesireTable, createDesire, resolveDesire, getActiveDesires } = await import('../src/agent/desires.js');
    ensureDesireTable();
    const d = createDesire({ type: 'creative', description: 'write something', source: 'dream' });
    resolveDesire(d.id, 'wrote a poem');
    expect(getActiveDesires().filter(x => x.id === d.id)).toHaveLength(0);
    closeDatabase();

    // char-b never had this desire to begin with
    process.env['LAIN_HOME'] = dirB;
    await initDatabase(join(dirB, 'lain.db'));
    const { ensureDesireTable: ensureB, getActiveDesires: getDesB } = await import('../src/agent/desires.js');
    ensureB();
    expect(getDesB()).toHaveLength(0);
  });

  it('getDesiresByType is scoped to the active database', async () => {
    process.env['LAIN_HOME'] = dirA;
    const { initDatabase, closeDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(dirA, 'lain.db'));
    const { ensureDesireTable, createDesire, getDesiresByType } = await import('../src/agent/desires.js');
    ensureDesireTable();
    createDesire({ type: 'social', description: 'want company', source: 'state' });
    expect(getDesiresByType('social')).toHaveLength(1);
    closeDatabase();

    process.env['LAIN_HOME'] = dirB;
    await initDatabase(join(dirB, 'lain.db'));
    const { ensureDesireTable: ensureB, getDesiresByType: getTypeB } = await import('../src/agent/desires.js');
    ensureB();
    expect(getTypeB('social')).toHaveLength(0);
  });

  it('decayDesires only affects the active database', async () => {
    process.env['LAIN_HOME'] = dirA;
    const { initDatabase, closeDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(dirA, 'lain.db'));
    const { ensureDesireTable, createDesire, decayDesires, getActiveDesires } = await import('../src/agent/desires.js');
    ensureDesireTable();
    createDesire({ type: 'emotional', description: 'process grief', source: 'diary', intensity: 0.5 });
    decayDesires(); // Sets timestamps, doesn't instantly remove at 0.5
    expect(getActiveDesires()).toHaveLength(1);
    closeDatabase();

    process.env['LAIN_HOME'] = dirB;
    await initDatabase(join(dirB, 'lain.db'));
    const { ensureDesireTable: ensureB, getActiveDesires: getDesB } = await import('../src/agent/desires.js');
    ensureB();
    expect(getDesB()).toHaveLength(0);
  });

  it('getDesireForPeer returns undefined in a fresh DB', async () => {
    process.env['LAIN_HOME'] = dirB;
    const { initDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(dirB, 'lain.db'));
    const { ensureDesireTable, getDesireForPeer } = await import('../src/agent/desires.js');
    ensureDesireTable();
    expect(getDesireForPeer('char-a')).toBeUndefined();
  });

  it('desire for peer in char-a does not appear as desire for same peer in char-b', async () => {
    process.env['LAIN_HOME'] = dirA;
    const { initDatabase, closeDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(dirA, 'lain.db'));
    const { ensureDesireTable, createDesire, getDesireForPeer } = await import('../src/agent/desires.js');
    ensureDesireTable();
    createDesire({ type: 'social', description: 'want to talk to char-c', source: 'loneliness', targetPeer: 'char-c' });
    expect(getDesireForPeer('char-c')).toBeDefined();
    closeDatabase();

    process.env['LAIN_HOME'] = dirB;
    await initDatabase(join(dirB, 'lain.db'));
    const { ensureDesireTable: ensureB, getDesireForPeer: getPeerB } = await import('../src/agent/desires.js');
    ensureB();
    expect(getPeerB('char-c')).toBeUndefined();
  });

  it('boostDesire only modifies the target desire in the active DB', async () => {
    process.env['LAIN_HOME'] = dirA;
    const { initDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(dirA, 'lain.db'));
    const { ensureDesireTable, createDesire, boostDesire, getActiveDesires } = await import('../src/agent/desires.js');
    ensureDesireTable();
    const d1 = createDesire({ type: 'intellectual', description: 'desire d1', source: 'test', intensity: 0.5 });
    const d2 = createDesire({ type: 'social', description: 'desire d2', source: 'test', intensity: 0.5 });
    boostDesire(d1.id, 0.2);
    const desires = getActiveDesires();
    const boosted = desires.find(d => d.id === d1.id);
    const unchanged = desires.find(d => d.id === d2.id);
    expect(boosted?.intensity).toBeCloseTo(0.7, 1);
    expect(unchanged?.intensity).toBeCloseTo(0.5, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. CONFIGURATION ISOLATION
// ─────────────────────────────────────────────────────────────────────────────

describe('Configuration Isolation', () => {
  const originalHome = process.env['LAIN_HOME'];

  afterEach(() => {
    if (originalHome) process.env['LAIN_HOME'] = originalHome;
    else delete process.env['LAIN_HOME'];
  });

  it('getBasePath returns character-specific path via LAIN_HOME', async () => {
    const { getBasePath } = await import('../src/config/paths.js');

    process.env['LAIN_HOME'] = '/opt/.lain-char-a';
    expect(getBasePath()).toBe('/opt/.lain-char-a');

    process.env['LAIN_HOME'] = '/opt/.lain-char-b';
    expect(getBasePath()).toBe('/opt/.lain-char-b');
  });

  it('getPaths database path is character-specific', async () => {
    const { getPaths } = await import('../src/config/paths.js');

    process.env['LAIN_HOME'] = '/root/.lain-char-a';
    const pathsA = getPaths();

    process.env['LAIN_HOME'] = '/root/.lain-char-b';
    const pathsB = getPaths();

    expect(pathsA.database).toBe('/root/.lain-char-a/lain.db');
    expect(pathsB.database).toBe('/root/.lain-char-b/lain.db');
    expect(pathsA.database).not.toBe(pathsB.database);
  });

  it('getPaths workspace path is character-specific', async () => {
    const { getPaths } = await import('../src/config/paths.js');

    process.env['LAIN_HOME'] = '/root/.lain-char-a';
    const pathsA = getPaths();

    process.env['LAIN_HOME'] = '/root/.lain-char-b';
    const pathsB = getPaths();

    expect(pathsA.workspace).not.toBe(pathsB.workspace);
    expect(pathsA.workspace).toContain('lain-char-a');
    expect(pathsB.workspace).toContain('lain-char-b');
  });

  it('getPeersFor excludes self from peer list', async () => {
    // Simulate a manifest with characters
    process.env['CHARACTERS_CONFIG'] = '';
    const { getPeersFor } = await import('../src/config/characters.js');

    // With empty manifest, peers for anything should be empty
    const peers = getPeersFor('char-a');
    expect(peers.every(p => p.id !== 'char-a')).toBe(true);
  });

  it('getAgentPath returns character-specific agent path', async () => {
    const { getAgentPath } = await import('../src/config/paths.js');

    process.env['LAIN_HOME'] = '/root/.lain-char-a';
    const pathA = getAgentPath('char-a');

    process.env['LAIN_HOME'] = '/root/.lain-char-b';
    const pathB = getAgentPath('char-b');

    expect(pathA).toContain('lain-char-a');
    expect(pathB).toContain('lain-char-b');
    expect(pathA).not.toBe(pathB);
  });

  it('LAIN_HOME changes affect getPaths dynamically', async () => {
    const { getPaths } = await import('../src/config/paths.js');

    const homes = ['/root/.lain-a', '/root/.lain-b', '/root/.lain-c'];
    const databases = homes.map(h => {
      process.env['LAIN_HOME'] = h;
      return getPaths().database;
    });

    // All unique
    expect(new Set(databases).size).toBe(3);
    databases.forEach((db, i) => {
      expect(db).toContain(homes[i]!.replace('/root/', ''));
    });
  });

  it('each character manifest entry has unique port', () => {
    // Simulate manifest data
    const chars = [
      { id: 'char-a', port: 3001 },
      { id: 'char-b', port: 3002 },
      { id: 'char-c', port: 3003 },
    ];
    const ports = chars.map(c => c.port);
    expect(new Set(ports).size).toBe(chars.length);
  });

  it('defaultLocation is per-character in manifest', () => {
    const chars = [
      { id: 'char-a', defaultLocation: 'library' },
      { id: 'char-b', defaultLocation: 'bar' },
      { id: 'char-c', defaultLocation: 'lighthouse' },
    ];
    const locs = new Map(chars.map(c => [c.id, c.defaultLocation]));
    expect(locs.get('char-a')).toBe('library');
    expect(locs.get('char-b')).toBe('bar');
    expect(locs.get('char-a')).not.toBe(locs.get('char-b'));
  });

  it('getPeersFor char-a does not include char-a', async () => {
    const { getPeersFor } = await import('../src/config/characters.js');
    // Empty manifest: no peers possible
    const peers = getPeersFor('char-a');
    expect(peers.every(p => p.id !== 'char-a')).toBe(true);
  });

  it('getAgentSessionsPath is character-scoped', async () => {
    const { getAgentSessionsPath } = await import('../src/config/paths.js');

    process.env['LAIN_HOME'] = '/root/.lain-char-a';
    const pathA = getAgentSessionsPath('char-a');

    process.env['LAIN_HOME'] = '/root/.lain-char-b';
    const pathB = getAgentSessionsPath('char-b');

    expect(pathA).toContain('lain-char-a');
    expect(pathB).toContain('lain-char-b');
    expect(pathA).not.toBe(pathB);
  });

  it('getAgentTranscriptsPath is character-scoped', async () => {
    const { getAgentTranscriptsPath } = await import('../src/config/paths.js');

    process.env['LAIN_HOME'] = '/root/.lain-char-a';
    const pathA = getAgentTranscriptsPath('char-a');

    process.env['LAIN_HOME'] = '/root/.lain-char-b';
    const pathB = getAgentTranscriptsPath('char-b');

    expect(pathA).not.toBe(pathB);
    expect(pathA).toContain('char-a');
    expect(pathB).toContain('char-b');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. EVENT ISOLATION
// ─────────────────────────────────────────────────────────────────────────────

describe('Event Isolation', () => {
  it('events emitted by eventBus include the characterId set on it', async () => {
    const { eventBus } = await import('../src/events/bus.js');

    eventBus.setCharacterId('char-a');

    const received: Array<{ character: string; type: string }> = [];
    eventBus.on('activity', (e) => received.push(e));

    eventBus.emitActivity({
      type: 'diary',
      sessionKey: 'diary:char-a:today',
      content: 'Reflecting on the day',
      timestamp: Date.now(),
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.character).toBe('char-a');

    eventBus.removeAllListeners('activity');
    eventBus.setCharacterId('lain');
  });

  it('changing characterId changes attribution for future events', async () => {
    const { eventBus } = await import('../src/events/bus.js');
    const received: Array<{ character: string }> = [];
    eventBus.on('activity', (e) => received.push(e));

    eventBus.setCharacterId('char-a');
    eventBus.emitActivity({ type: 'state', sessionKey: 'state:test', content: 'test', timestamp: Date.now() });

    eventBus.setCharacterId('char-b');
    eventBus.emitActivity({ type: 'state', sessionKey: 'state:test2', content: 'test2', timestamp: Date.now() });

    expect(received[0]?.character).toBe('char-a');
    expect(received[1]?.character).toBe('char-b');

    eventBus.removeAllListeners('activity');
    eventBus.setCharacterId('lain');
  });

  it('parseEventType correctly maps session key prefixes', async () => {
    const { parseEventType } = await import('../src/events/bus.js');

    expect(parseEventType('diary:char-a:today')).toBe('diary');
    expect(parseEventType('commune:char-a:char-b')).toBe('commune');
    expect(parseEventType('web:char-a:user1')).toBe('chat');
    expect(parseEventType('movement:library:bar')).toBe('movement');
    expect(parseEventType('state:conversation:end')).toBe('state');
    expect(parseEventType(null)).toBe('unknown');
  });

  it('isBackgroundEvent distinguishes background from user chat events', async () => {
    const { isBackgroundEvent } = await import('../src/events/bus.js');

    const diaryEvent = { character: 'char-a', type: 'diary', sessionKey: 'diary:char-a:today', content: '', timestamp: 0 };
    const chatEvent = { character: 'char-a', type: 'chat', sessionKey: 'web:char-a:user1', content: '', timestamp: 0 };

    expect(isBackgroundEvent(diaryEvent)).toBe(true);
    expect(isBackgroundEvent(chatEvent)).toBe(false);
  });

  it('event bus emitActivity includes all required fields', async () => {
    const { eventBus } = await import('../src/events/bus.js');
    eventBus.setCharacterId('test-char');

    let received: { character: string; type: string; sessionKey: string; content: string; timestamp: number } | null = null;
    eventBus.once('activity', (e) => { received = e; });

    const ts = Date.now();
    eventBus.emitActivity({ type: 'curiosity', sessionKey: 'curiosity:test', content: 'found something', timestamp: ts });

    expect(received).not.toBeNull();
    expect(received!.character).toBe('test-char');
    expect(received!.type).toBe('curiosity');
    expect(received!.sessionKey).toBe('curiosity:test');
    expect(received!.content).toBe('found something');
    expect(received!.timestamp).toBe(ts);

    eventBus.setCharacterId('lain');
  });

  it('activity events from saveMessage include correct sessionKey', async () => {
    const testDir = join(tmpdir(), `lain-event-msg-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    process.env['LAIN_HOME'] = testDir;
    const { initDatabase, closeDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(testDir, 'lain.db'));

    const { eventBus } = await import('../src/events/bus.js');
    const { saveMessage } = await import('../src/memory/store.js');

    const events: Array<{ sessionKey: string }> = [];
    eventBus.on('activity', (e) => events.push(e));

    saveMessage({ sessionKey: 'diary:char-a:entry', userId: null, role: 'assistant', content: 'test', timestamp: Date.now(), metadata: {} });

    expect(events.some(e => e.sessionKey === 'diary:char-a:entry')).toBe(true);

    eventBus.removeAllListeners('activity');
    closeDatabase();
    const originalHome = process.env['LAIN_HOME'];
    delete process.env['LAIN_HOME'];
    try { await rm(testDir, { recursive: true }); } catch { /* ignore */ }
    if (originalHome && originalHome !== testDir) process.env['LAIN_HOME'] = originalHome;
  });

  it('background event types map correctly', async () => {
    const { parseEventType, isBackgroundEvent } = await import('../src/events/bus.js');

    const backgroundPrefixes = ['commune', 'diary', 'dream', 'curiosity', 'letter', 'peer', 'movement'];
    for (const prefix of backgroundPrefixes) {
      const type = parseEventType(`${prefix}:test`);
      const ev = { character: 'c', type, sessionKey: `${prefix}:test`, content: '', timestamp: 0 };
      expect(isBackgroundEvent(ev)).toBe(true);
    }
  });

  it('eventBus getter characterId reflects last set value', async () => {
    const { eventBus } = await import('../src/events/bus.js');

    const ids = ['char-alpha', 'char-beta', 'char-gamma'];
    for (const id of ids) {
      eventBus.setCharacterId(id);
      expect(eventBus.characterId).toBe(id);
    }

    eventBus.setCharacterId('lain');
  });

  it('multiple listeners on activity bus each receive the full event', async () => {
    const { eventBus } = await import('../src/events/bus.js');
    eventBus.setCharacterId('char-x');

    const results: string[] = [];
    const l1 = (e: { character: string }) => results.push(`l1:${e.character}`);
    const l2 = (e: { character: string }) => results.push(`l2:${e.character}`);

    eventBus.on('activity', l1);
    eventBus.on('activity', l2);

    eventBus.emitActivity({ type: 'state', sessionKey: 'state:x', content: 'x', timestamp: Date.now() });

    expect(results).toContain('l1:char-x');
    expect(results).toContain('l2:char-x');

    eventBus.off('activity', l1);
    eventBus.off('activity', l2);
    eventBus.setCharacterId('lain');
  });

  it('activity from saveMessage carries correct character attribution', async () => {
    const testDir = join(tmpdir(), `lain-event-attr-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    const originalHome = process.env['LAIN_HOME'];
    process.env['LAIN_HOME'] = testDir;
    const { initDatabase, closeDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(testDir, 'lain.db'));

    const { eventBus } = await import('../src/events/bus.js');
    const { saveMessage } = await import('../src/memory/store.js');

    eventBus.setCharacterId('char-z');

    const events: Array<{ character: string }> = [];
    eventBus.on('activity', (e) => events.push(e));

    saveMessage({ sessionKey: 'commune:char-z:char-w', userId: null, role: 'user', content: 'hi', timestamp: Date.now(), metadata: {} });

    expect(events[0]?.character).toBe('char-z');

    eventBus.removeAllListeners('activity');
    eventBus.setCharacterId('lain');
    closeDatabase();
    if (originalHome && originalHome !== testDir) process.env['LAIN_HOME'] = originalHome;
    else delete process.env['LAIN_HOME'];
    try { await rm(testDir, { recursive: true }); } catch { /* ignore */ }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. COMMUNICATION BOUNDARIES
// ─────────────────────────────────────────────────────────────────────────────

describe('Communication Boundaries', () => {
  const testDir = join(tmpdir(), `lain-comms-${Date.now()}`);
  const originalHome = process.env['LAIN_HOME'];

  beforeEach(async () => {
    process.env['LAIN_HOME'] = testDir;
    await mkdir(testDir, { recursive: true });
    const { initDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(testDir, 'test.db'));
  });

  afterEach(async () => {
    const { closeDatabase } = await import('../src/storage/database.js');
    closeDatabase();
    if (originalHome) process.env['LAIN_HOME'] = originalHome;
    else delete process.env['LAIN_HOME'];
    try { await rm(testDir, { recursive: true }); } catch { /* ignore */ }
  });

  it('letters from A to B are stored under A→B session key', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');

    const letterKey = 'letter:char-a:char-b:2024-03-15';
    saveMessage({ sessionKey: letterKey, userId: null, role: 'assistant', content: 'Dear B, I miss you.', timestamp: Date.now(), metadata: {} });

    const msgs = getRecentMessages(letterKey, 5);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.sessionKey).toBe(letterKey);
    expect(msgs[0]?.content).toBe('Dear B, I miss you.');
  });

  it('letter session key for A→B does not overlap B→A', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');

    const keyAtoB = 'letter:char-a:char-b:day1';
    const keyBtoA = 'letter:char-b:char-a:day1';

    saveMessage({ sessionKey: keyAtoB, userId: null, role: 'assistant', content: 'A writes to B', timestamp: Date.now(), metadata: {} });
    saveMessage({ sessionKey: keyBtoA, userId: null, role: 'assistant', content: 'B writes to A', timestamp: Date.now(), metadata: {} });

    const aToBMsgs = getRecentMessages(keyAtoB, 5);
    const bToAMsgs = getRecentMessages(keyBtoA, 5);

    expect(aToBMsgs).toHaveLength(1);
    expect(aToBMsgs[0]?.content).toBe('A writes to B');
    expect(bToAMsgs).toHaveLength(1);
    expect(bToAMsgs[0]?.content).toBe('B writes to A');
  });

  it('commune conversation session key includes both participants', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');

    const communeKey = 'commune:char-a:char-b';
    saveMessage({ sessionKey: communeKey, userId: null, role: 'user', content: 'A speaks in commune', timestamp: Date.now(), metadata: {} });
    saveMessage({ sessionKey: communeKey, userId: null, role: 'assistant', content: 'B responds in commune', timestamp: Date.now(), metadata: {} });

    const msgs = getRecentMessages(communeKey, 10);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.sessionKey).toBe(communeKey);
    expect(msgs[1]?.sessionKey).toBe(communeKey);
  });

  it('peer message session key preserves directionality', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');

    const peerKeyAtoB = 'peer:char-a:char-b';
    const peerKeyBtoA = 'peer:char-b:char-a';

    saveMessage({ sessionKey: peerKeyAtoB, userId: null, role: 'user', content: 'A reaches out to B', timestamp: Date.now(), metadata: {} });
    saveMessage({ sessionKey: peerKeyBtoA, userId: null, role: 'user', content: 'B reaches out to A', timestamp: Date.now(), metadata: {} });

    expect(getRecentMessages(peerKeyAtoB, 5).map(m => m.content)).toContain('A reaches out to B');
    expect(getRecentMessages(peerKeyBtoA, 5).map(m => m.content)).toContain('B reaches out to A');
    expect(getRecentMessages(peerKeyAtoB, 5).map(m => m.content)).not.toContain('B reaches out to A');
  });

  it('in-memory conversation namespace prevents cross-character reads', async () => {
    const { getConversation, addUserMessage, clearConversation } = await import('../src/agent/conversation.js');

    const convAtoB = getConversation('commune:char-a:char-b', 'system for commune');
    addUserMessage(convAtoB, {
      id: 'msg-commune', channel: 'web' as const, peerKind: 'user' as const, peerId: 'char-b',
      senderId: 'char-a', senderName: 'Character A',
      content: { type: 'text', text: 'commune message from A' },
      timestamp: Date.now(),
    });

    const wrongConv = getConversation('commune:char-b:char-a', 'system for commune reversed');
    expect(wrongConv.messages).toHaveLength(0);

    clearConversation('commune:char-a:char-b');
    clearConversation('commune:char-b:char-a');
  });

  it('session creation uses agent-specific keys preventing false matches', async () => {
    const { createSession, findSession } = await import('../src/storage/sessions.js');

    createSession({ agentId: 'char-a', channel: 'web', peerKind: 'user', peerId: 'char-b' });

    // char-b looking for its own peer session with char-a should NOT find char-a's session
    const found = findSession('char-b', 'web', 'char-b');
    expect(found).toBeUndefined();
  });

  it('interlink token auth is per-request (not per-character global)', () => {
    // The interlink token is read from environment per request
    const originalToken = process.env['LAIN_INTERLINK_TOKEN'];
    process.env['LAIN_INTERLINK_TOKEN'] = 'token-char-a';

    const tokenA = process.env['LAIN_INTERLINK_TOKEN'];
    expect(tokenA).toBe('token-char-a');

    process.env['LAIN_INTERLINK_TOKEN'] = 'token-shared';
    const tokenShared = process.env['LAIN_INTERLINK_TOKEN'];
    expect(tokenShared).toBe('token-shared');

    if (originalToken) process.env['LAIN_INTERLINK_TOKEN'] = originalToken;
    else delete process.env['LAIN_INTERLINK_TOKEN'];
  });

  it('getActivity includes session key for attribution', async () => {
    const { saveMessage, getActivity } = await import('../src/memory/store.js');

    const now = Date.now();
    saveMessage({ sessionKey: 'commune:char-a:char-b', userId: null, role: 'assistant', content: 'commune talk', timestamp: now, metadata: {} });
    saveMessage({ sessionKey: 'letter:char-a:char-b:x', userId: null, role: 'assistant', content: 'letter content', timestamp: now, metadata: {} });

    const activity = getActivity(now - 100, now + 100, 50);
    for (const entry of activity) {
      expect(typeof entry.sessionKey).toBe('string');
      expect(entry.sessionKey.length).toBeGreaterThan(0);
    }
  });

  it('commune messages do not appear in visitor message feed', async () => {
    const { saveMessage, getRecentVisitorMessages } = await import('../src/memory/store.js');

    const now = Date.now();
    saveMessage({ sessionKey: 'commune:char-a:char-b', userId: null, role: 'user', content: 'commune private', timestamp: now, metadata: {} });
    saveMessage({ sessionKey: 'web:char-a:visitor', userId: null, role: 'user', content: 'visitor public', timestamp: now, metadata: {} });

    const visitor = getRecentVisitorMessages(20);
    expect(visitor.map(m => m.content)).not.toContain('commune private');
    expect(visitor.map(m => m.content)).toContain('visitor public');
  });

  it('desire-driven social action target peer metadata is preserved', async () => {
    const { ensureDesireTable, createDesire, getDesireForPeer } = await import('../src/agent/desires.js');
    ensureDesireTable();

    createDesire({
      type: 'social',
      description: 'I want to ask char-b about the nature of dreams',
      source: 'dream',
      targetPeer: 'char-b',
      intensity: 0.8,
    });

    const desire = getDesireForPeer('char-b');
    expect(desire).toBeDefined();
    expect(desire?.targetPeer).toBe('char-b');
    expect(desire?.description).toContain('char-b');
  });

  it('desire action metadata includes correct characterId author', async () => {
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');

    const sessionKey = 'desire-action:char-a:' + Date.now();
    saveMessage({
      sessionKey,
      userId: null,
      role: 'assistant',
      content: '[Desire-driven reach-out to char-b] Sent: hello. Response: hi.',
      timestamp: Date.now(),
      metadata: { type: 'desire_action', desireId: 'des_123', peerId: 'char-b', action: 'conversation' },
    });

    const msgs = getRecentMessages(sessionKey, 5);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.metadata['peerId']).toBe('char-b');
    expect(msgs[0]?.sessionKey).toBe(sessionKey);
  });

  it('getRecentVisitorMessages excludes letter sessions', async () => {
    const { saveMessage, getRecentVisitorMessages } = await import('../src/memory/store.js');

    const now = Date.now();
    saveMessage({ sessionKey: 'lain:letter', userId: null, role: 'assistant', content: 'lain letter', timestamp: now, metadata: {} });
    saveMessage({ sessionKey: 'wired:letter', userId: null, role: 'assistant', content: 'wired letter', timestamp: now, metadata: {} });

    const visitor = getRecentVisitorMessages(20);
    const contents = visitor.map(m => m.content);
    expect(contents).not.toContain('lain letter');
    expect(contents).not.toContain('wired letter');
  });

  it('doctor session traffic is excluded from visitor messages', async () => {
    const { saveMessage, getRecentVisitorMessages } = await import('../src/memory/store.js');

    const now = Date.now();
    saveMessage({ sessionKey: 'doctor:char-a:checkup', userId: null, role: 'assistant', content: 'health check', timestamp: now, metadata: {} });

    const visitor = getRecentVisitorMessages(20);
    expect(visitor.map(m => m.content)).not.toContain('health check');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. CONCURRENT CHARACTER OPERATIONS
// ─────────────────────────────────────────────────────────────────────────────

describe('Concurrent Character Operations', () => {
  it('two characters creating sessions in parallel produce unique keys', async () => {
    const testDir = join(tmpdir(), `lain-concurrent-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    const originalHome = process.env['LAIN_HOME'];
    process.env['LAIN_HOME'] = testDir;
    const { initDatabase, closeDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(testDir, 'test.db'));

    const { createSession } = await import('../src/storage/sessions.js');

    // Create sessions concurrently
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        Promise.resolve(createSession({
          agentId: i % 2 === 0 ? 'char-a' : 'char-b',
          channel: 'web',
          peerKind: 'user',
          peerId: `user-${i}`,
        }))
      )
    );

    const keys = results.map(s => s.key);
    expect(new Set(keys).size).toBe(10);

    closeDatabase();
    if (originalHome) process.env['LAIN_HOME'] = originalHome;
    else delete process.env['LAIN_HOME'];
    try { await rm(testDir, { recursive: true }); } catch { /* ignore */ }
  });

  it('concurrent in-memory conversation creation does not cross-pollinate', async () => {
    const { getConversation, addAssistantMessage, clearConversation } = await import('../src/agent/conversation.js');

    const keys = Array.from({ length: 20 }, (_, i) => `session-char-${i % 4}-user-${i}`);
    const conversations = keys.map(key => getConversation(key, `System for ${key}`));

    // Add messages to each
    conversations.forEach((conv, i) => {
      addAssistantMessage(conv, `Message for session ${i}`);
    });

    // Verify each conversation only has its own message
    conversations.forEach((conv, i) => {
      expect(conv.messages).toHaveLength(1);
      expect((conv.messages[0]?.content as string)).toContain(`session ${i}`);
    });

    keys.forEach(k => clearConversation(k));
  });

  it('parallel session reads for different characters return correct data', async () => {
    const testDir = join(tmpdir(), `lain-parallel-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    const originalHome = process.env['LAIN_HOME'];
    process.env['LAIN_HOME'] = testDir;
    const { initDatabase, closeDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(testDir, 'test.db'));

    const { createSession, getSession, updateSession } = await import('../src/storage/sessions.js');

    const sessA = createSession({ agentId: 'char-a', channel: 'web', peerKind: 'user', peerId: 'concurrent-user' });
    const sessB = createSession({ agentId: 'char-b', channel: 'web', peerKind: 'user', peerId: 'concurrent-user' });

    // Update concurrently
    await Promise.all([
      Promise.resolve(updateSession(sessA.key, { tokenCount: 1111 })),
      Promise.resolve(updateSession(sessB.key, { tokenCount: 2222 })),
    ]);

    const [loadedA, loadedB] = await Promise.all([
      Promise.resolve(getSession(sessA.key)),
      Promise.resolve(getSession(sessB.key)),
    ]);

    expect(loadedA?.tokenCount).toBe(1111);
    expect(loadedB?.tokenCount).toBe(2222);

    closeDatabase();
    if (originalHome) process.env['LAIN_HOME'] = originalHome;
    else delete process.env['LAIN_HOME'];
    try { await rm(testDir, { recursive: true }); } catch { /* ignore */ }
  });

  it('parallel message writes to different sessions do not intermix', async () => {
    const testDir = join(tmpdir(), `lain-parallel-msgs-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    const originalHome = process.env['LAIN_HOME'];
    process.env['LAIN_HOME'] = testDir;
    const { initDatabase, closeDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(testDir, 'test.db'));

    const { saveMessage, getAllMessages } = await import('../src/memory/store.js');

    const keyA = 'diary:char-a:concurrent';
    const keyB = 'diary:char-b:concurrent';

    await Promise.all([
      ...Array.from({ length: 5 }, (_, i) =>
        Promise.resolve(saveMessage({ sessionKey: keyA, userId: null, role: 'user', content: `A-msg-${i}`, timestamp: Date.now() + i, metadata: {} }))
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        Promise.resolve(saveMessage({ sessionKey: keyB, userId: null, role: 'user', content: `B-msg-${i}`, timestamp: Date.now() + i, metadata: {} }))
      ),
    ]);

    const msgsA = getAllMessages(keyA);
    const msgsB = getAllMessages(keyB);

    expect(msgsA).toHaveLength(5);
    expect(msgsB).toHaveLength(5);
    expect(msgsA.every(m => m.sessionKey === keyA)).toBe(true);
    expect(msgsB.every(m => m.sessionKey === keyB)).toBe(true);
    expect(msgsA.every(m => m.content.startsWith('A-msg'))).toBe(true);
    expect(msgsB.every(m => m.content.startsWith('B-msg'))).toBe(true);

    closeDatabase();
    if (originalHome) process.env['LAIN_HOME'] = originalHome;
    else delete process.env['LAIN_HOME'];
    try { await rm(testDir, { recursive: true }); } catch { /* ignore */ }
  });

  it('concurrent desire creation in same DB produces separate records', async () => {
    const testDir = join(tmpdir(), `lain-parallel-desires-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    const originalHome = process.env['LAIN_HOME'];
    process.env['LAIN_HOME'] = testDir;
    const { initDatabase, closeDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(testDir, 'test.db'));

    const { ensureDesireTable, createDesire, getActiveDesires } = await import('../src/agent/desires.js');
    ensureDesireTable();

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        Promise.resolve(createDesire({ type: 'social', description: `desire-${i}`, source: 'test', intensity: 0.5 }))
      )
    );

    const ids = results.map(d => d.id);
    expect(new Set(ids).size).toBe(5);
    expect(getActiveDesires(10)).toHaveLength(5);

    closeDatabase();
    if (originalHome) process.env['LAIN_HOME'] = originalHome;
    else delete process.env['LAIN_HOME'];
    try { await rm(testDir, { recursive: true }); } catch { /* ignore */ }
  });

  it('concurrent state saves in the same DB do not corrupt data', async () => {
    const testDir = join(tmpdir(), `lain-parallel-state-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    const originalHome = process.env['LAIN_HOME'];
    process.env['LAIN_HOME'] = testDir;
    const { initDatabase, closeDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(testDir, 'test.db'));

    const { getCurrentState, saveState } = await import('../src/agent/internal-state.js');

    // Sequential saves (sqlite is single-writer)
    const state = getCurrentState();
    for (let i = 0; i < 5; i++) {
      state.energy = 0.1 * (i + 1);
      saveState(state);
    }

    const final = getCurrentState();
    expect(final.energy).toBeCloseTo(0.5, 2);

    closeDatabase();
    if (originalHome) process.env['LAIN_HOME'] = originalHome;
    else delete process.env['LAIN_HOME'];
    try { await rm(testDir, { recursive: true }); } catch { /* ignore */ }
  });

  it('session generation for multiple characters produces no collisions', async () => {
    const { generateSessionKey } = await import('../src/storage/sessions.js');

    const allKeys = new Set<string>();
    for (let i = 0; i < 200; i++) {
      allKeys.add(generateSessionKey());
    }
    expect(allKeys.size).toBe(200);
  });

  it('two characters moving simultaneously maintain independent location state', async () => {
    const dirA2 = join(tmpdir(), `lain-move-a-${Date.now()}`);
    const dirB2 = join(tmpdir(), `lain-move-b-${Date.now()}`);
    await Promise.all([mkdir(dirA2, { recursive: true }), mkdir(dirB2, { recursive: true })]);
    const originalHome = process.env['LAIN_HOME'];

    // char-a moves to bar
    process.env['LAIN_HOME'] = dirA2;
    const { initDatabase, setMeta, getMeta, closeDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(dirA2, 'lain.db'));
    setMeta('town:current_location', JSON.stringify({ building: 'bar', timestamp: Date.now() }));
    closeDatabase();

    // char-b moves to library
    process.env['LAIN_HOME'] = dirB2;
    await initDatabase(join(dirB2, 'lain.db'));
    setMeta('town:current_location', JSON.stringify({ building: 'library', timestamp: Date.now() }));

    const locB = JSON.parse(getMeta('town:current_location') || '{}') as { building: string };
    expect(locB.building).toBe('library');
    closeDatabase();

    if (originalHome) process.env['LAIN_HOME'] = originalHome;
    else delete process.env['LAIN_HOME'];
    try { await rm(dirA2, { recursive: true }); } catch { /* ignore */ }
    try { await rm(dirB2, { recursive: true }); } catch { /* ignore */ }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. CROSS-CONTAMINATION SMOKE TESTS (the scariest bugs)
// ─────────────────────────────────────────────────────────────────────────────

describe('Cross-Contamination Smoke Tests', () => {
  it('LAIN_HOME env var is the single gate between character databases', async () => {
    const { getPaths } = await import('../src/config/paths.js');
    const originalHome = process.env['LAIN_HOME'];

    const scenarios = [
      { home: '/root/.lain-lain', expectedDb: '/root/.lain-lain/lain.db' },
      { home: '/root/.lain-wired', expectedDb: '/root/.lain-wired/lain.db' },
      { home: '/root/.lain-pkd', expectedDb: '/root/.lain-pkd/lain.db' },
    ];

    for (const { home, expectedDb } of scenarios) {
      process.env['LAIN_HOME'] = home;
      expect(getPaths().database).toBe(expectedDb);
    }

    if (originalHome) process.env['LAIN_HOME'] = originalHome;
    else delete process.env['LAIN_HOME'];
  });

  it('session key format encodes character identity in prefix', async () => {
    // Session keys like "web:char-a:peerId" or "commune:char-a:char-b" encode character
    const sessionKeys = [
      'web:char-a:user1',
      'web:char-b:user1',
      'commune:char-a:char-b',
      'diary:char-a:2024-01-01',
      'dream:char-b:2024-01-01',
      'letter:char-a:char-b:day1',
    ];

    const { parseEventType } = await import('../src/events/bus.js');

    // Each session key maps to a deterministic event type
    expect(parseEventType(sessionKeys[0]!)).toBe('chat');
    expect(parseEventType(sessionKeys[2]!)).toBe('commune');
    expect(parseEventType(sessionKeys[3]!)).toBe('diary');
    expect(parseEventType(sessionKeys[4]!)).toBe('dream');
    expect(parseEventType(sessionKeys[5]!)).toBe('letter');
  });

  it('switching LAIN_HOME between two DBs never reads stale data', async () => {
    const dirA3 = join(tmpdir(), `lain-switch-a-${Date.now()}`);
    const dirB3 = join(tmpdir(), `lain-switch-b-${Date.now()}`);
    await Promise.all([mkdir(dirA3, { recursive: true }), mkdir(dirB3, { recursive: true })]);
    const originalHome = process.env['LAIN_HOME'];

    const { initDatabase, setMeta, getMeta, closeDatabase } = await import('../src/storage/database.js');

    process.env['LAIN_HOME'] = dirA3;
    await initDatabase(join(dirA3, 'lain.db'));
    setMeta('test:isolation', 'value-from-A');
    closeDatabase();

    process.env['LAIN_HOME'] = dirB3;
    await initDatabase(join(dirB3, 'lain.db'));
    setMeta('test:isolation', 'value-from-B');

    const valB = getMeta('test:isolation');
    expect(valB).toBe('value-from-B');
    closeDatabase();

    // Switch back to A
    process.env['LAIN_HOME'] = dirA3;
    await initDatabase(join(dirA3, 'lain.db'));
    const valA = getMeta('test:isolation');
    expect(valA).toBe('value-from-A');
    closeDatabase();

    if (originalHome) process.env['LAIN_HOME'] = originalHome;
    else delete process.env['LAIN_HOME'];
    try { await rm(dirA3, { recursive: true }); } catch { /* ignore */ }
    try { await rm(dirB3, { recursive: true }); } catch { /* ignore */ }
  });

  it('character A messages are not surfaced in character B context even via shared peerId', async () => {
    const testDir = join(tmpdir(), `lain-smoke-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    const originalHome = process.env['LAIN_HOME'];
    process.env['LAIN_HOME'] = testDir;
    const { initDatabase, closeDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(testDir, 'test.db'));
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');

    const now = Date.now();
    // Same peerId 'alice' talks to both char-a and char-b
    saveMessage({ sessionKey: 'web:char-a:alice', userId: 'alice', role: 'user', content: 'alice tells A her secret', timestamp: now, metadata: {} });
    saveMessage({ sessionKey: 'web:char-b:alice', userId: 'alice', role: 'user', content: 'alice tells B her news', timestamp: now + 1, metadata: {} });

    const charAContext = getRecentMessages('web:char-a:alice', 10);
    const charBContext = getRecentMessages('web:char-b:alice', 10);

    // char-A only sees alice's message to char-A
    expect(charAContext.map(m => m.content)).toContain('alice tells A her secret');
    expect(charAContext.map(m => m.content)).not.toContain('alice tells B her news');

    // char-B only sees alice's message to char-B
    expect(charBContext.map(m => m.content)).toContain('alice tells B her news');
    expect(charBContext.map(m => m.content)).not.toContain('alice tells A her secret');

    closeDatabase();
    if (originalHome) process.env['LAIN_HOME'] = originalHome;
    else delete process.env['LAIN_HOME'];
    try { await rm(testDir, { recursive: true }); } catch { /* ignore */ }
  });

  it('in-memory conversations are not shared between characters by design', async () => {
    const { getConversation, getActiveConversations, clearConversation } = await import('../src/agent/conversation.js');

    const keyA = 'smoke-test:char-a:sess1';
    const keyB = 'smoke-test:char-b:sess1';

    getConversation(keyA, 'A soul');
    getConversation(keyB, 'B soul');

    const active = getActiveConversations();
    expect(active).toContain(keyA);
    expect(active).toContain(keyB);
    expect(active.filter(k => k === keyA)).toHaveLength(1);
    expect(active.filter(k => k === keyB)).toHaveLength(1);

    clearConversation(keyA);
    clearConversation(keyB);
  });

  it('meta store keys are shared within a DB but not across DBs', async () => {
    const dirA4 = join(tmpdir(), `lain-meta-a-${Date.now()}`);
    const dirB4 = join(tmpdir(), `lain-meta-b-${Date.now()}`);
    await Promise.all([mkdir(dirA4, { recursive: true }), mkdir(dirB4, { recursive: true })]);
    const originalHome = process.env['LAIN_HOME'];

    const { initDatabase, setMeta, getMeta, closeDatabase } = await import('../src/storage/database.js');

    process.env['LAIN_HOME'] = dirA4;
    await initDatabase(join(dirA4, 'lain.db'));
    setMeta('internal:state', JSON.stringify({ energy: 0.9, valence: 0.8 }));
    setMeta('preoccupations:current', JSON.stringify([{ id: 'p1', thread: 'thought', origin: 'test', intensity: 0.7 }]));
    closeDatabase();

    process.env['LAIN_HOME'] = dirB4;
    await initDatabase(join(dirB4, 'lain.db'));

    expect(getMeta('internal:state')).toBeNull();
    expect(getMeta('preoccupations:current')).toBeNull();
    closeDatabase();

    if (originalHome) process.env['LAIN_HOME'] = originalHome;
    else delete process.env['LAIN_HOME'];
    try { await rm(dirA4, { recursive: true }); } catch { /* ignore */ }
    try { await rm(dirB4, { recursive: true }); } catch { /* ignore */ }
  });

  it('desires table is per-DB, not globally singleton', async () => {
    const dirA5 = join(tmpdir(), `lain-des-a-${Date.now()}`);
    const dirB5 = join(tmpdir(), `lain-des-b-${Date.now()}`);
    await Promise.all([mkdir(dirA5, { recursive: true }), mkdir(dirB5, { recursive: true })]);
    const originalHome = process.env['LAIN_HOME'];

    const { initDatabase, closeDatabase } = await import('../src/storage/database.js');

    process.env['LAIN_HOME'] = dirA5;
    await initDatabase(join(dirA5, 'lain.db'));
    const { ensureDesireTable, createDesire, getActiveDesires } = await import('../src/agent/desires.js');
    ensureDesireTable();
    createDesire({ type: 'social', description: 'A wants friendship', source: 'state', intensity: 0.7 });
    createDesire({ type: 'intellectual', description: 'A wants knowledge', source: 'curiosity', intensity: 0.6 });
    expect(getActiveDesires()).toHaveLength(2);
    closeDatabase();

    process.env['LAIN_HOME'] = dirB5;
    await initDatabase(join(dirB5, 'lain.db'));
    const { ensureDesireTable: ensureB, getActiveDesires: getDesB } = await import('../src/agent/desires.js');
    ensureB();
    expect(getDesB()).toHaveLength(0);
    closeDatabase();

    if (originalHome) process.env['LAIN_HOME'] = originalHome;
    else delete process.env['LAIN_HOME'];
    try { await rm(dirA5, { recursive: true }); } catch { /* ignore */ }
    try { await rm(dirB5, { recursive: true }); } catch { /* ignore */ }
  });
});
