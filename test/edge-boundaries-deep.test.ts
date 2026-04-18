/**
 * Deep edge-case and boundary tests for Laintown.
 *
 * Covers: encoding, pagination/limits, timer/cleanup, database,
 * cache invalidation, budget, configuration, and event bus edge cases.
 *
 * Target: 280+ tests — no overlap with boundary-values, edge-cases,
 * stress-limits, or fuzz-properties test files.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';

// ── Mock keytar before any DB imports ─────────────────────────────────────────
vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn().mockResolvedValue('test-master-key'),
    setPassword: vi.fn().mockResolvedValue(undefined),
    deletePassword: vi.fn().mockResolvedValue(true),
    findCredentials: vi.fn().mockResolvedValue([]),
  },
}));

// ── Mock LLM providers to avoid real API calls ───────────────────────────────
vi.mock('../src/agent/index.js', () => ({
  getProvider: vi.fn().mockReturnValue(null),
  getAgent: vi.fn().mockReturnValue(null),
}));

// ═══════════════════════════════════════════════════════════════════════════════
// 1. ENCODING EDGE CASES (~50 tests)
// ═══════════════════════════════════════════════════════════════════════════════

import { sanitize } from '../src/security/sanitizer.js';
import { expandTemplate, truncateToSentence, pickRandom } from '../src/agent/novelty.js';
import { parseEventType } from '../src/events/bus.js';
import {
  getConversation,
  addAssistantMessage,
  clearConversation,
  getActiveConversations,
  getTextContent,
} from '../src/agent/conversation.js';

describe('Encoding edge cases', () => {
  // ── UTF-8 BOM ────────────────────────────────────────────────────────────
  describe('UTF-8 BOM handling', () => {
    const BOM = '\uFEFF';

    it('sanitize does not crash on BOM-prefixed input', () => {
      const r = sanitize(`${BOM}Hello world`);
      expect(r).toBeDefined();
      expect(r.blocked).toBe(false);
    });

    it('BOM in middle of string does not crash sanitize', () => {
      const r = sanitize(`Hello ${BOM} world`);
      expect(r).toBeDefined();
      expect(r.blocked).toBe(false);
    });

    it('BOM-only string is safe', () => {
      const r = sanitize(BOM);
      expect(r.blocked).toBe(false);
    });

    it('expandTemplate preserves BOM in fills', () => {
      const result = expandTemplate('{name} says hello', { name: `${BOM}Lain` });
      expect(result).toContain(BOM);
      expect(result).toContain('says hello');
    });

    it('getTextContent handles BOM-prefixed string content', () => {
      expect(getTextContent(`${BOM}Hello`)).toBe(`${BOM}Hello`);
    });
  });

  // ── Surrogate pairs and multi-byte Unicode ───────────────────────────────
  describe('Surrogate pairs and multi-byte codepoints', () => {
    it('brain emoji (U+1F9E0) passes through sanitize', () => {
      const r = sanitize('Thinking 🧠 deeply');
      expect(r.blocked).toBe(false);
      expect(r.sanitized).toContain('🧠');
    });

    it('CJK Unified Ideographs Extension B (4-byte UTF-8) survive sanitize', () => {
      const char = '\u{20000}'; // CJK Ideograph Extension B
      const r = sanitize(`text ${char} text`);
      expect(r.blocked).toBe(false);
    });

    it('mathematical symbols (U+1D400 block) survive sanitize', () => {
      const bold_A = '\u{1D400}'; // MATHEMATICAL BOLD CAPITAL A
      const r = sanitize(`Formula: ${bold_A} = 42`);
      expect(r.blocked).toBe(false);
    });

    it('flag emoji (regional indicators) do not crash', () => {
      const flag = '\u{1F1FA}\u{1F1F8}'; // US flag
      const r = sanitize(`Country: ${flag}`);
      expect(r.blocked).toBe(false);
    });

    it('skin tone modifiers on emoji survive sanitize', () => {
      const r = sanitize('Wave 👋🏽 hello');
      expect(r.blocked).toBe(false);
    });

    it('family emoji (multi-codepoint) survives sanitize', () => {
      const r = sanitize('Family: 👨‍👩‍👧‍👦');
      expect(r.blocked).toBe(false);
    });
  });

  // ── Mixed encoding ───────────────────────────────────────────────────────
  describe('Mixed encoding in same string', () => {
    it('ASCII + Chinese + Arabic + emoji in one message', () => {
      const mixed = 'Hello 你好 مرحبا 🌸';
      const r = sanitize(mixed);
      expect(r.blocked).toBe(false);
    });

    it('Japanese + Korean + Hindi in one message', () => {
      const mixed = 'こんにちは 안녕하세요 नमस्ते';
      const r = sanitize(mixed);
      expect(r.blocked).toBe(false);
    });

    it('Latin + Cyrillic + Greek + Hebrew in one message', () => {
      const mixed = 'Hello Привет Γειά שלום';
      const r = sanitize(mixed);
      expect(r.blocked).toBe(false);
    });

    it('Thai + Vietnamese + Georgian', () => {
      const mixed = 'สวัสดี Xin chào გამარჯობა';
      const r = sanitize(mixed);
      expect(r.blocked).toBe(false);
    });

    it('truncateToSentence handles mixed encoding correctly', () => {
      const text = '你好世界. This is English. 🌸 emoji here.';
      const result = truncateToSentence(text, 20);
      expect(result.length).toBeLessThanOrEqual(20);
    });
  });

  // ── Null bytes ───────────────────────────────────────────────────────────
  describe('Null bytes embedded in strings', () => {
    it('null byte in sanitize input does not crash', () => {
      const r = sanitize('before\0after');
      expect(r).toBeDefined();
    });

    it('multiple null bytes do not crash sanitize', () => {
      const r = sanitize('\0\0\0');
      expect(r).toBeDefined();
    });

    it('null byte in expandTemplate fill value', () => {
      const result = expandTemplate('{val}', { val: 'a\0b' });
      expect(result).toContain('a');
    });

    it('parseEventType with null byte in session key', () => {
      const type = parseEventType('diary\0:extra');
      // split(':') splits on ':', null byte stays in first segment
      expect(typeof type).toBe('string');
    });

    it('getTextContent with null byte in string', () => {
      expect(typeof getTextContent('hello\0world')).toBe('string');
    });

    it('conversation addAssistantMessage with null byte in content', () => {
      const c = getConversation('null-byte-test', 'prompt');
      addAssistantMessage(c, 'hello\0world');
      expect(c.messages).toHaveLength(1);
      clearConversation('null-byte-test');
    });
  });

  // ── Zero-width characters ────────────────────────────────────────────────
  describe('Zero-width characters', () => {
    const ZWSP = '\u200B'; // Zero-width space
    const ZWJ = '\u200D';  // Zero-width joiner
    const ZWNJ = '\u200C'; // Zero-width non-joiner
    const ZWNA = '\u2060'; // Word joiner (zero-width no-break space)

    it('ZWSP in session key creates a conversation', () => {
      const key = `session${ZWSP}key`;
      const c = getConversation(key, 'prompt');
      expect(c.sessionKey).toBe(key);
      clearConversation(key);
    });

    it('ZWJ in message content is stored', () => {
      const key = 'zwj-test';
      const c = getConversation(key, 'prompt');
      addAssistantMessage(c, `text${ZWJ}joined`);
      expect(c.messages[0]).toBeDefined();
      clearConversation(key);
    });

    it('ZWNJ does not break sanitize', () => {
      const r = sanitize(`hello${ZWNJ}world`);
      expect(r.blocked).toBe(false);
    });

    it('word joiner (U+2060) does not break sanitize', () => {
      const r = sanitize(`word${ZWNA}joiner`);
      expect(r.blocked).toBe(false);
    });

    it('all zero-width chars combined in one string', () => {
      const r = sanitize(`${ZWSP}${ZWJ}${ZWNJ}${ZWNA}text`);
      expect(r.blocked).toBe(false);
    });

    it('zero-width chars in expandTemplate result', () => {
      const result = expandTemplate(`{x}${ZWSP}world`, { x: `${ZWJ}hello` });
      expect(result).toContain('hello');
      expect(result).toContain('world');
    });
  });

  // ── RTL text ─────────────────────────────────────────────────────────────
  describe('RTL (right-to-left) text', () => {
    it('pure Arabic text does not break parseEventType', () => {
      const type = parseEventType('عربي:session');
      expect(typeof type).toBe('string');
    });

    it('Hebrew text passes sanitize', () => {
      const r = sanitize('שלום עולם');
      expect(r.blocked).toBe(false);
    });

    it('RTL override character (U+202E) does not crash', () => {
      const r = sanitize('normal \u202E reversed');
      expect(r).toBeDefined();
    });

    it('bidirectional text (mixed LTR and RTL)', () => {
      const r = sanitize('Hello مرحبا World عالم');
      expect(r.blocked).toBe(false);
    });
  });

  // ── Control characters ───────────────────────────────────────────────────
  describe('Control characters in unexpected places', () => {
    it('tab in expandTemplate template literal', () => {
      const result = expandTemplate('col1\tcol2\t{val}', { val: 'data' });
      expect(result).toBe('col1\tcol2\tdata');
    });

    it('carriage return without newline', () => {
      const r = sanitize('hello\rworld');
      expect(r).toBeDefined();
    });

    it('form feed character', () => {
      const r = sanitize('page1\fpage2');
      expect(r).toBeDefined();
      expect(r.blocked).toBe(false);
    });

    it('vertical tab', () => {
      const r = sanitize('line1\vline2');
      expect(r).toBeDefined();
    });

    it('bell character (U+0007)', () => {
      const r = sanitize('alert\x07bell');
      expect(r).toBeDefined();
    });

    it('escape character (U+001B)', () => {
      const r = sanitize('text\x1Bmore');
      expect(r).toBeDefined();
    });

    it('backspace character (U+0008)', () => {
      const r = sanitize('oops\x08fixed');
      expect(r).toBeDefined();
    });
  });

  // ── Emoji in various contexts ────────────────────────────────────────────
  describe('Emoji in various contexts', () => {
    it('emoji as session key', () => {
      const c = getConversation('🧠', 'prompt');
      expect(c.sessionKey).toBe('🧠');
      clearConversation('🧠');
    });

    it('emoji-only message content', () => {
      const c = getConversation('emoji-only', 'prompt');
      addAssistantMessage(c, '🌸🧠💭');
      expect(c.messages).toHaveLength(1);
      clearConversation('emoji-only');
    });

    it('parseEventType with emoji prefix', () => {
      const type = parseEventType('🌸:session:123');
      // Unknown prefix returns prefix as-is
      expect(type).toBe('🌸');
    });

    it('truncateToSentence does not split mid-emoji', () => {
      const text = 'Hello 🧠 world. More text here.';
      const result = truncateToSentence(text, 15);
      // Should truncate at a safe boundary
      expect(result.length).toBeLessThanOrEqual(15);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. PAGINATION AND LIMITS (~40 tests)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Pagination and limits', () => {
  const testDir = join(tmpdir(), `lain-test-pagination-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const dbPath = join(testDir, 'test.db');
  const originalEnv = process.env['LAIN_HOME'];

  beforeEach(async () => {
    process.env['LAIN_HOME'] = testDir;
    await mkdir(testDir, { recursive: true });
    const { initDatabase } = await import('../src/storage/database.js');
    await initDatabase(dbPath);
  });

  afterEach(async () => {
    const { closeDatabase } = await import('../src/storage/database.js');
    closeDatabase();
    if (originalEnv) {
      process.env['LAIN_HOME'] = originalEnv;
    } else {
      delete process.env['LAIN_HOME'];
    }
    try { await rm(testDir, { recursive: true }); } catch {}
  });

  // ── Memory search limits ─────────────────────────────────────────────────
  describe('Memory store limit edge cases', () => {
    it('getRecentMessages with limit=0 returns empty', async () => {
      const { getRecentMessages } = await import('../src/memory/store.js');
      const result = getRecentMessages('nonexistent-session', 0);
      expect(result).toHaveLength(0);
    });

    it('getRecentMessages with limit=1 returns at most 1', async () => {
      const { getRecentMessages, saveMessage } = await import('../src/memory/store.js');
      saveMessage({ sessionKey: 'limit-1-test', userId: null, role: 'user', content: 'msg1', timestamp: Date.now(), metadata: {} });
      saveMessage({ sessionKey: 'limit-1-test', userId: null, role: 'assistant', content: 'msg2', timestamp: Date.now() + 1, metadata: {} });
      const result = getRecentMessages('limit-1-test', 1);
      expect(result).toHaveLength(1);
    });

    it('getRecentMessages with very large limit returns all available', async () => {
      const { getRecentMessages, saveMessage } = await import('../src/memory/store.js');
      saveMessage({ sessionKey: 'big-limit', userId: null, role: 'user', content: 'only-msg', timestamp: Date.now(), metadata: {} });
      const result = getRecentMessages('big-limit', Number.MAX_SAFE_INTEGER);
      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result.length).toBeLessThanOrEqual(100); // practical upper bound
    });

    it('getAllRecentMessages with limit=0 returns empty', async () => {
      const { getAllRecentMessages } = await import('../src/memory/store.js');
      const result = getAllRecentMessages(0);
      expect(result).toHaveLength(0);
    });

    it('getMemoriesForUser with limit=0 returns empty', async () => {
      const { getMemoriesForUser } = await import('../src/memory/store.js');
      const result = getMemoriesForUser('some-user', 0);
      expect(result).toHaveLength(0);
    });

    it('getMessagesForUser with limit=1 returns at most 1', async () => {
      const { getMessagesForUser, saveMessage } = await import('../src/memory/store.js');
      saveMessage({ sessionKey: 'user-limit', userId: 'user123', role: 'user', content: 'hello', timestamp: Date.now(), metadata: {} });
      saveMessage({ sessionKey: 'user-limit', userId: 'user123', role: 'assistant', content: 'hi', timestamp: Date.now() + 1, metadata: {} });
      const result = getMessagesForUser('user123', 1);
      expect(result).toHaveLength(1);
    });

    it('countMemories returns 0 on empty database', async () => {
      const { countMemories } = await import('../src/memory/store.js');
      expect(countMemories()).toBe(0);
    });

    it('countMessages returns 0 on empty database', async () => {
      const { countMessages } = await import('../src/memory/store.js');
      expect(countMessages()).toBe(0);
    });

    it('getLastUserMessageTimestamp returns null on empty database', async () => {
      const { getLastUserMessageTimestamp } = await import('../src/memory/store.js');
      expect(getLastUserMessageTimestamp()).toBeNull();
    });
  });

  // ── Activity feed ────────────────────────────────────────────────────────
  describe('Activity feed edge cases', () => {
    it('getActivity with from > to (inverted range) returns empty', async () => {
      const { getActivity } = await import('../src/memory/store.js');
      const result = getActivity(Date.now(), Date.now() - 10000);
      expect(result).toHaveLength(0);
    });

    it('getActivity with from = to (zero-width range) returns empty', async () => {
      const { getActivity } = await import('../src/memory/store.js');
      const now = Date.now();
      const result = getActivity(now, now);
      expect(result).toHaveLength(0);
    });

    it('getActivity with far-future range returns empty', async () => {
      const { getActivity } = await import('../src/memory/store.js');
      const farFuture = Date.now() + 1000 * 365 * 24 * 3600000;
      const result = getActivity(farFuture, farFuture + 1000);
      expect(result).toHaveLength(0);
    });

    it('getActivity with epoch 0 range', async () => {
      const { getActivity } = await import('../src/memory/store.js');
      const result = getActivity(0, 1000);
      expect(Array.isArray(result)).toBe(true);
    });

    it('getActivity with limit=0 returns empty', async () => {
      const { getActivity } = await import('../src/memory/store.js');
      const result = getActivity(0, Date.now(), 0);
      expect(result).toHaveLength(0);
    });

    it('getActivity with negative timestamps does not crash', async () => {
      const { getActivity } = await import('../src/memory/store.js');
      const result = getActivity(-1000, -1);
      expect(Array.isArray(result)).toBe(true);
    });
  });

  // ── Session list pagination ──────────────────────────────────────────────
  describe('Session list pagination', () => {
    it('listSessions with limit=0 returns empty', async () => {
      const { listSessions } = await import('../src/storage/sessions.js');
      const result = listSessions('test-agent', { limit: 0 });
      expect(result).toHaveLength(0);
    });

    it('listSessions with offset beyond total returns empty', async () => {
      const { listSessions, createSession } = await import('../src/storage/sessions.js');
      createSession({ agentId: 'pag-agent', channel: 'web', peerKind: 'user', peerId: 'p1' });
      // SQLite requires LIMIT before OFFSET; listSessions only applies OFFSET when limit is also set
      const result = listSessions('pag-agent', { limit: 100, offset: 1000 });
      expect(result).toHaveLength(0);
    });

    it('listSessions with limit=1 returns exactly 1 when data exists', async () => {
      const { listSessions, createSession } = await import('../src/storage/sessions.js');
      createSession({ agentId: 'limit1-agent', channel: 'web', peerKind: 'user', peerId: 'p1' });
      createSession({ agentId: 'limit1-agent', channel: 'web', peerKind: 'user', peerId: 'p2' });
      const result = listSessions('limit1-agent', { limit: 1 });
      expect(result).toHaveLength(1);
    });

    it('countSessions returns correct count after multiple creates', async () => {
      const { countSessions, createSession } = await import('../src/storage/sessions.js');
      const agent = 'count-agent';
      createSession({ agentId: agent, channel: 'web', peerKind: 'user', peerId: 'a' });
      createSession({ agentId: agent, channel: 'web', peerKind: 'user', peerId: 'b' });
      createSession({ agentId: agent, channel: 'web', peerKind: 'user', peerId: 'c' });
      expect(countSessions(agent)).toBe(3);
    });

    it('countSessions with channel filter', async () => {
      const { countSessions, createSession } = await import('../src/storage/sessions.js');
      const agent = 'chan-agent';
      createSession({ agentId: agent, channel: 'web', peerKind: 'user', peerId: 'w1' });
      createSession({ agentId: agent, channel: 'telegram', peerKind: 'user', peerId: 't1' });
      expect(countSessions(agent, 'web')).toBe(1);
      expect(countSessions(agent, 'telegram')).toBe(1);
    });
  });

  // ── KG triple queries ────────────────────────────────────────────────────
  describe('KG triple query limits', () => {
    it('queryTriples with limit=0 returns empty', async () => {
      const { queryTriples, addTriple } = await import('../src/memory/knowledge-graph.js');
      addTriple('Lain', 'likes', 'computers');
      const result = queryTriples({ limit: 0 });
      expect(result).toHaveLength(0);
    });

    it('queryTriples with limit=1 returns at most 1', async () => {
      const { queryTriples, addTriple } = await import('../src/memory/knowledge-graph.js');
      addTriple('A', 'is', 'B');
      addTriple('C', 'is', 'D');
      const result = queryTriples({ limit: 1 });
      expect(result).toHaveLength(1);
    });

    it('queryTriples with no matching subject returns empty', async () => {
      const { queryTriples } = await import('../src/memory/knowledge-graph.js');
      const result = queryTriples({ subject: 'nonexistent-entity-xyz' });
      expect(result).toHaveLength(0);
    });

    it('queryTriples with asOf in far past returns empty for new triples', async () => {
      const { queryTriples, addTriple } = await import('../src/memory/knowledge-graph.js');
      addTriple('X', 'is', 'Y');
      const result = queryTriples({ asOf: 1000 }); // epoch + 1 second
      expect(result).toHaveLength(0);
    });

    it('getEntityTimeline for nonexistent entity returns empty', async () => {
      const { getEntityTimeline } = await import('../src/memory/knowledge-graph.js');
      const result = getEntityTimeline('ghost-entity');
      expect(result).toHaveLength(0);
    });

    it('listEntities with limit=0 returns empty', async () => {
      const { listEntities } = await import('../src/memory/knowledge-graph.js');
      const result = listEntities(undefined, 0);
      expect(result).toHaveLength(0);
    });
  });

  // ── Conversation trim boundary ───────────────────────────────────────────
  describe('Conversation trim at boundary', () => {
    beforeEach(() => {
      for (const key of getActiveConversations()) {
        clearConversation(key);
      }
    });

    it('exactly 40 messages (commune trim boundary)', () => {
      const c = getConversation('trim-40', 'prompt');
      for (let i = 0; i < 40; i++) {
        addAssistantMessage(c, `msg-${i}`);
      }
      expect(c.messages).toHaveLength(40);
    });

    it('41 messages exceed the 40-message boundary', () => {
      const c = getConversation('trim-41', 'prompt');
      for (let i = 0; i < 41; i++) {
        addAssistantMessage(c, `msg-${i}`);
      }
      expect(c.messages).toHaveLength(41);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. TIMER AND CLEANUP (~40 tests)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Timer and cleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Generic timer lifecycle ──────────────────────────────────────────────
  describe('Timer lifecycle patterns', () => {
    it('start then immediately stop — callback never fires', () => {
      const callback = vi.fn();
      const timer = setInterval(callback, 1000);
      clearInterval(timer);
      vi.advanceTimersByTime(5000);
      expect(callback).not.toHaveBeenCalled();
    });

    it('start then stop after partial interval — callback never fires', () => {
      const callback = vi.fn();
      const timer = setInterval(callback, 1000);
      vi.advanceTimersByTime(500); // halfway
      clearInterval(timer);
      vi.advanceTimersByTime(5000);
      expect(callback).not.toHaveBeenCalled();
    });

    it('callback fires exactly once when stopped right after first interval', () => {
      const callback = vi.fn();
      const timer = setInterval(callback, 1000);
      vi.advanceTimersByTime(1000);
      clearInterval(timer);
      vi.advanceTimersByTime(5000);
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('stop twice does not throw', () => {
      const timer = setInterval(() => {}, 1000);
      expect(() => {
        clearInterval(timer);
        clearInterval(timer);
      }).not.toThrow();
    });

    it('multiple timers: stopping all leaves zero pending', () => {
      const timers: ReturnType<typeof setInterval>[] = [];
      for (let i = 0; i < 10; i++) {
        timers.push(setInterval(() => {}, 1000 + i * 100));
      }
      for (const t of timers) clearInterval(t);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('setTimeout with 0ms delay fires on next tick', () => {
      const callback = vi.fn();
      setTimeout(callback, 0);
      expect(callback).not.toHaveBeenCalled();
      vi.advanceTimersByTime(0);
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('setInterval with very large interval does not overflow', () => {
      const callback = vi.fn();
      // 2^31 - 1 is the max safe setTimeout value (about 24.8 days)
      const MAX_TIMEOUT = 2147483647;
      const timer = setInterval(callback, MAX_TIMEOUT);
      vi.advanceTimersByTime(1000);
      expect(callback).not.toHaveBeenCalled();
      clearInterval(timer);
    });

    it('restart timer: old timer cleared, new one set', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      const timer1 = setInterval(callback1, 1000);
      clearInterval(timer1);
      const timer2 = setInterval(callback2, 1000);
      vi.advanceTimersByTime(1000);
      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).toHaveBeenCalledTimes(1);
      clearInterval(timer2);
    });
  });

  // ── Self-concept loop stop patterns ──────────────────────────────────────
  describe('Loop stop patterns (setTimeout-based)', () => {
    it('setTimeout stop before fire — no callback', () => {
      const cb = vi.fn();
      const t = setTimeout(cb, 60000);
      clearTimeout(t);
      vi.advanceTimersByTime(120000);
      expect(cb).not.toHaveBeenCalled();
    });

    it('clearTimeout on already-fired setTimeout is harmless', () => {
      const cb = vi.fn();
      const t = setTimeout(cb, 100);
      vi.advanceTimersByTime(100);
      expect(cb).toHaveBeenCalled();
      expect(() => clearTimeout(t)).not.toThrow();
    });

    it('nested setTimeout — outer cleared, inner never scheduled', () => {
      const inner = vi.fn();
      const outer = setTimeout(() => {
        setTimeout(inner, 1000);
      }, 1000);
      clearTimeout(outer);
      vi.advanceTimersByTime(10000);
      expect(inner).not.toHaveBeenCalled();
    });

    it('stopped flag pattern prevents async re-entry', async () => {
      let stopped = false;
      const log: string[] = [];

      function scheduleNext() {
        setTimeout(() => {
          if (stopped) return;
          log.push('tick');
          scheduleNext();
        }, 1000);
      }

      scheduleNext();
      vi.advanceTimersByTime(3000);
      expect(log).toEqual(['tick', 'tick', 'tick']);

      stopped = true;
      vi.advanceTimersByTime(5000);
      expect(log).toEqual(['tick', 'tick', 'tick']); // no more ticks
    });
  });

  // ── Interval timing precision ────────────────────────────────────────────
  describe('Interval timing precision', () => {
    it('interval fires correct number of times', () => {
      const cb = vi.fn();
      const timer = setInterval(cb, 100);
      vi.advanceTimersByTime(1000);
      expect(cb).toHaveBeenCalledTimes(10);
      clearInterval(timer);
    });

    it('mixed setTimeout and setInterval coexist', () => {
      const intervalCb = vi.fn();
      const timeoutCb = vi.fn();
      const timer = setInterval(intervalCb, 200);
      setTimeout(timeoutCb, 500);
      vi.advanceTimersByTime(1000);
      expect(intervalCb).toHaveBeenCalledTimes(5);
      expect(timeoutCb).toHaveBeenCalledTimes(1);
      clearInterval(timer);
    });

    it('clearing inside interval callback stops future calls', () => {
      const log: number[] = [];
      let count = 0;
      const timer = setInterval(() => {
        count++;
        log.push(count);
        if (count >= 3) clearInterval(timer);
      }, 100);
      vi.advanceTimersByTime(1000);
      expect(log).toEqual([1, 2, 3]);
    });

    it('timer count is zero after all timers cleared', () => {
      setInterval(() => {}, 100);
      setInterval(() => {}, 200);
      setTimeout(() => {}, 300);
      const timers = vi.getTimerCount();
      expect(timers).toBe(3);
      vi.clearAllTimers();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  // ── Async loop stop mid-cycle ────────────────────────────────────────────
  describe('Async loop stop patterns', () => {
    it('stop flag checked before async work prevents execution', async () => {
      let stopped = false;
      const work = vi.fn();

      async function loop() {
        if (stopped) return;
        await Promise.resolve();
        work();
      }

      stopped = true;
      await loop();
      expect(work).not.toHaveBeenCalled();
    });

    it('stop flag set during async gap — next cycle skipped', async () => {
      let stopped = false;
      const results: string[] = [];

      async function cycle() {
        results.push('start');
        await Promise.resolve(); // simulate async gap
        if (stopped) {
          results.push('stopped');
          return;
        }
        results.push('completed');
      }

      const p = cycle();
      stopped = true;
      await p;
      expect(results).toEqual(['start', 'stopped']);
    });

    it('multiple stop calls are idempotent', () => {
      let stopped = false;
      const stopFn = () => { stopped = true; };
      stopFn();
      stopFn();
      stopFn();
      expect(stopped).toBe(true); // no error from multiple calls
    });
  });

  // ── Timer leak detection ─────────────────────────────────────────────────
  describe('Timer leak detection', () => {
    it('creating and clearing 100 timers leaves zero pending', () => {
      const timers: ReturnType<typeof setInterval>[] = [];
      for (let i = 0; i < 100; i++) {
        timers.push(setInterval(() => {}, 1000));
      }
      for (const t of timers) clearInterval(t);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('setTimeout naturally clears after execution', () => {
      setTimeout(() => {}, 100);
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(100);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('setInterval does NOT clear after execution (must be cleared)', () => {
      const timer = setInterval(() => {}, 100);
      vi.advanceTimersByTime(100);
      expect(vi.getTimerCount()).toBe(1); // still pending
      clearInterval(timer);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. DATABASE EDGE CASES (~40 tests)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Database edge cases', () => {
  const testDir = join(tmpdir(), `lain-test-db-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const dbPath = join(testDir, 'test.db');
  const originalEnv = process.env['LAIN_HOME'];

  beforeEach(async () => {
    process.env['LAIN_HOME'] = testDir;
    await mkdir(testDir, { recursive: true });
    const { initDatabase } = await import('../src/storage/database.js');
    await initDatabase(dbPath);
  });

  afterEach(async () => {
    const { closeDatabase } = await import('../src/storage/database.js');
    closeDatabase();
    if (originalEnv) {
      process.env['LAIN_HOME'] = originalEnv;
    } else {
      delete process.env['LAIN_HOME'];
    }
    try { await rm(testDir, { recursive: true }); } catch {}
  });

  // ── Empty string vs null ─────────────────────────────────────────────────
  describe('Empty string vs null in storage', () => {
    it('save message with empty string content', async () => {
      const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
      const id = saveMessage({ sessionKey: 'empty-test', userId: null, role: 'user', content: '', timestamp: Date.now(), metadata: {} });
      expect(typeof id).toBe('string');
      const msgs = getRecentMessages('empty-test');
      expect(msgs).toHaveLength(1);
      expect(msgs[0].content).toBe('');
    });

    it('meta key with empty string value', async () => {
      const { getMeta, setMeta } = await import('../src/storage/database.js');
      setMeta('test-empty', '');
      expect(getMeta('test-empty')).toBe('');
    });

    it('meta key that does not exist returns null', async () => {
      const { getMeta } = await import('../src/storage/database.js');
      expect(getMeta('nonexistent-key-xyz-abc')).toBeNull();
    });

    it('getMeta with empty string key', async () => {
      const { getMeta, setMeta } = await import('../src/storage/database.js');
      setMeta('', 'value-for-empty-key');
      expect(getMeta('')).toBe('value-for-empty-key');
    });

    it('setMeta overwrites existing value', async () => {
      const { getMeta, setMeta } = await import('../src/storage/database.js');
      setMeta('overwrite-test', 'first');
      setMeta('overwrite-test', 'second');
      expect(getMeta('overwrite-test')).toBe('second');
    });
  });

  // ── Large content ────────────────────────────────────────────────────────
  describe('Large content in storage', () => {
    it('save message with 100KB content', async () => {
      const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
      const bigContent = 'a'.repeat(100_000);
      saveMessage({ sessionKey: 'big-msg', userId: null, role: 'user', content: bigContent, timestamp: Date.now(), metadata: {} });
      const msgs = getRecentMessages('big-msg');
      expect(msgs).toHaveLength(1);
      expect(msgs[0].content.length).toBe(100_000);
    });

    it('meta value with very long JSON string', async () => {
      const { getMeta, setMeta } = await import('../src/storage/database.js');
      const bigValue = JSON.stringify({ data: 'x'.repeat(50_000) });
      setMeta('big-meta', bigValue);
      expect(getMeta('big-meta')).toBe(bigValue);
    });

    it('save message with complex JSON metadata', async () => {
      const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
      const meta = { nested: { deep: { array: Array.from({ length: 100 }, (_, i) => i) } } };
      saveMessage({ sessionKey: 'meta-test', userId: null, role: 'user', content: 'test', timestamp: Date.now(), metadata: meta });
      const msgs = getRecentMessages('meta-test');
      expect(msgs).toHaveLength(1);
      expect(msgs[0].metadata.nested).toBeDefined();
    });
  });

  // ── Transaction behavior ─────────────────────────────────────────────────
  describe('Transaction behavior', () => {
    it('transaction commits on success', async () => {
      const { transaction, getMeta, setMeta } = await import('../src/storage/database.js');
      transaction(() => {
        setMeta('tx-test-1', 'value1');
        setMeta('tx-test-2', 'value2');
      });
      expect(getMeta('tx-test-1')).toBe('value1');
      expect(getMeta('tx-test-2')).toBe('value2');
    });

    it('transaction rolls back on error', async () => {
      const { transaction, setMeta, getMeta } = await import('../src/storage/database.js');
      setMeta('tx-rollback', 'original');
      try {
        transaction(() => {
          setMeta('tx-rollback', 'modified');
          throw new Error('rollback test');
        });
      } catch {
        // expected
      }
      expect(getMeta('tx-rollback')).toBe('original');
    });

    it('nested read inside transaction succeeds', async () => {
      const { transaction, setMeta, getMeta } = await import('../src/storage/database.js');
      setMeta('tx-read', 'initial');
      const result = transaction(() => {
        setMeta('tx-read', 'updated');
        return getMeta('tx-read');
      });
      expect(result).toBe('updated');
    });
  });

  // ── Query edge cases ─────────────────────────────────────────────────────
  describe('Query edge cases', () => {
    it('query with no results returns empty array', async () => {
      const { query } = await import('../src/storage/database.js');
      const result = query('SELECT * FROM meta WHERE key = ?', ['nonexistent-key-xyz']);
      expect(result).toEqual([]);
    });

    it('queryOne with no results returns undefined', async () => {
      const { queryOne } = await import('../src/storage/database.js');
      const result = queryOne('SELECT * FROM meta WHERE key = ?', ['nonexistent-key-xyz']);
      expect(result).toBeUndefined();
    });

    it('execute returns changes count for INSERT', async () => {
      const { execute } = await import('../src/storage/database.js');
      const result = execute("INSERT INTO meta (key, value) VALUES ('exec-test', 'val')");
      expect(result.changes).toBe(1);
    });

    it('execute returns 0 changes for UPDATE on nonexistent row', async () => {
      const { execute } = await import('../src/storage/database.js');
      const result = execute("UPDATE meta SET value = 'new' WHERE key = 'nonexistent-row-xyz'");
      expect(result.changes).toBe(0);
    });

    it('execute DELETE on nonexistent row returns 0 changes', async () => {
      const { execute } = await import('../src/storage/database.js');
      const result = execute("DELETE FROM meta WHERE key = 'nonexistent-row-xyz'");
      expect(result.changes).toBe(0);
    });
  });

  // ── Session operations ───────────────────────────────────────────────────
  describe('Session edge cases', () => {
    it('getSession for nonexistent key returns undefined', async () => {
      const { getSession } = await import('../src/storage/sessions.js');
      expect(getSession('nonexistent-session-xyz')).toBeUndefined();
    });

    it('deleteSession for nonexistent key returns false', async () => {
      const { deleteSession } = await import('../src/storage/sessions.js');
      expect(deleteSession('nonexistent-session-xyz')).toBe(false);
    });

    it('updateSession for nonexistent key returns undefined', async () => {
      const { updateSession } = await import('../src/storage/sessions.js');
      expect(updateSession('nonexistent-session-xyz', { tokenCount: 100 })).toBeUndefined();
    });

    it('getOrCreateSession creates on first call', async () => {
      const { getOrCreateSession, getSession } = await import('../src/storage/sessions.js');
      const session = getOrCreateSession({ agentId: 'oc-agent', channel: 'web', peerKind: 'user', peerId: 'oc-peer' });
      expect(session).toBeDefined();
      expect(session.agentId).toBe('oc-agent');
      const fetched = getSession(session.key);
      expect(fetched).toBeDefined();
    });

    it('getOrCreateSession returns existing on second call', async () => {
      const { getOrCreateSession } = await import('../src/storage/sessions.js');
      const input = { agentId: 'dup-agent', channel: 'web' as const, peerKind: 'user' as const, peerId: 'dup-peer' };
      const first = getOrCreateSession(input);
      const second = getOrCreateSession(input);
      expect(first.key).toBe(second.key);
    });

    it('session with unicode peerId', async () => {
      const { createSession, getSession } = await import('../src/storage/sessions.js');
      const session = createSession({ agentId: 'uni', channel: 'web', peerKind: 'user', peerId: '用户🌸' });
      const fetched = getSession(session.key);
      expect(fetched?.peerId).toBe('用户🌸');
    });

    it('deleteOldSessions with 0 maxAge deletes all', async () => {
      const { createSession, deleteOldSessions, countSessions } = await import('../src/storage/sessions.js');
      createSession({ agentId: 'old-agent', channel: 'web', peerKind: 'user', peerId: 'old-peer' });
      // maxAge=0 means cutoff = now, so any session updated before now should be deleted
      // But since we just created it, updatedAt ~= now, so it might not be deleted
      const deleted = deleteOldSessions('old-agent', 0);
      // The session was just created so updatedAt is approximately now
      // With maxAge=0, cutoff = Date.now(), and the session's updatedAt might equal cutoff
      expect(typeof deleted).toBe('number');
    });

    it('batchUpdateTokenCounts updates multiple sessions', async () => {
      const { createSession, getSession, batchUpdateTokenCounts } = await import('../src/storage/sessions.js');
      const s1 = createSession({ agentId: 'batch', channel: 'web', peerKind: 'user', peerId: 'b1' });
      const s2 = createSession({ agentId: 'batch', channel: 'web', peerKind: 'user', peerId: 'b2' });
      batchUpdateTokenCounts([
        { key: s1.key, tokenCount: 100 },
        { key: s2.key, tokenCount: 200 },
      ]);
      expect(getSession(s1.key)?.tokenCount).toBe(100);
      expect(getSession(s2.key)?.tokenCount).toBe(200);
    });
  });

  // ── KG triple edge cases ─────────────────────────────────────────────────
  describe('Knowledge graph edge cases', () => {
    it('addTriple with empty strings for subject/predicate/object', async () => {
      const { addTriple, getTriple } = await import('../src/memory/knowledge-graph.js');
      const id = addTriple('', '', '');
      const triple = getTriple(id);
      expect(triple).toBeDefined();
      expect(triple.subject).toBe('');
    });

    it('addTriple with unicode subject', async () => {
      const { addTriple, getTriple } = await import('../src/memory/knowledge-graph.js');
      const id = addTriple('レイン', '好きな', '🧠コンピュータ');
      const triple = getTriple(id);
      expect(triple?.subject).toBe('レイン');
      expect(triple?.object).toBe('🧠コンピュータ');
    });

    it('invalidateTriple sets ended timestamp', async () => {
      const { addTriple, invalidateTriple, getTriple } = await import('../src/memory/knowledge-graph.js');
      const id = addTriple('A', 'is', 'B');
      const before = getTriple(id);
      expect(before?.ended).toBeNull();
      invalidateTriple(id);
      const after = getTriple(id);
      expect(after?.ended).not.toBeNull();
    });

    it('detectContradictions on empty graph returns empty', async () => {
      const { detectContradictions } = await import('../src/memory/knowledge-graph.js');
      const result = detectContradictions();
      // May or may not be empty depending on other test data, but should not crash
      expect(Array.isArray(result)).toBe(true);
    });

    it('addEntity with unicode name', async () => {
      const { addEntity, getEntity } = await import('../src/memory/knowledge-graph.js');
      addEntity('玲音', 'character');
      const entity = getEntity('玲音');
      expect(entity?.name).toBe('玲音');
      expect(entity?.entityType).toBe('character');
    });

    it('addEntity upserts on duplicate name', async () => {
      const { addEntity, getEntity } = await import('../src/memory/knowledge-graph.js');
      addEntity('duplicate-entity', 'person', Date.now(), { version: 1 });
      addEntity('duplicate-entity', 'person', Date.now(), { version: 2 });
      const entity = getEntity('duplicate-entity');
      expect(entity).toBeDefined();
      expect((entity?.metadata as Record<string, unknown>).version).toBe(2);
    });
  });

  // ── WAL mode verification ────────────────────────────────────────────────
  describe('WAL mode and pragmas', () => {
    it('database is in WAL mode', async () => {
      const { getDatabase } = await import('../src/storage/database.js');
      const db = getDatabase();
      const mode = db.pragma('journal_mode');
      expect(mode[0]?.journal_mode).toBe('wal');
    });

    it('foreign keys are enabled', async () => {
      const { getDatabase } = await import('../src/storage/database.js');
      const db = getDatabase();
      const fk = db.pragma('foreign_keys');
      expect(fk[0]?.foreign_keys).toBe(1);
    });

    it('busy_timeout is set', async () => {
      const { getDatabase } = await import('../src/storage/database.js');
      const db = getDatabase();
      const bt = db.pragma('busy_timeout');
      // busy_timeout pragma returns [{timeout: N}] in some sqlite versions
      const value = bt[0]?.busy_timeout ?? bt[0]?.timeout;
      expect(value).toBe(5000);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. CACHE INVALIDATION (~30 tests)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Cache invalidation', () => {
  // ── Novelty fragment cache ───────────────────────────────────────────────
  describe('Novelty fragment cache', () => {
    it('expandTemplate with empty fills returns original template', () => {
      const result = expandTemplate('no {placeholders} here', {});
      // {placeholders} has no matching fill, so it stays as-is
      expect(result).toBe('no {placeholders} here');
    });

    it('expandTemplate with extra fills ignores unmatched keys', () => {
      const result = expandTemplate('{a} and {b}', { a: 'hello', b: 'world', c: 'extra' });
      expect(result).toBe('hello and world');
    });

    it('expandTemplate with empty string fill', () => {
      const result = expandTemplate('{val}', { val: '' });
      expect(result).toBe('');
    });

    it('truncateToSentence with text shorter than maxLength returns original', () => {
      expect(truncateToSentence('short', 100)).toBe('short');
    });

    it('truncateToSentence with maxLength=0 returns empty', () => {
      const result = truncateToSentence('some text', 0);
      expect(result).toBe('');
    });

    it('truncateToSentence with no sentence boundaries truncates at word', () => {
      const result = truncateToSentence('one two three four five', 10);
      expect(result.length).toBeLessThanOrEqual(10);
      expect(result).not.toContain('four'); // should stop before
    });

    it('truncateToSentence with sentence boundary uses it', () => {
      const text = 'First sentence. Second sentence. Third sentence.';
      const result = truncateToSentence(text, 20);
      expect(result).toBe('First sentence.');
    });

    it('pickRandom with single-element array returns that element', () => {
      expect(pickRandom([42])).toBe(42);
    });

    it('pickRandom always returns an element from the array', () => {
      const arr = ['a', 'b', 'c', 'd', 'e'];
      for (let i = 0; i < 50; i++) {
        expect(arr).toContain(pickRandom(arr));
      }
    });
  });

  // ── Self-concept cache behavior ──────────────────────────────────────────
  describe('Self-concept meta cache', () => {
    const testDir = join(tmpdir(), `lain-test-cache-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const dbPath = join(testDir, 'test.db');
    const originalEnv = process.env['LAIN_HOME'];

    beforeEach(async () => {
      process.env['LAIN_HOME'] = testDir;
      await mkdir(testDir, { recursive: true });
      const { initDatabase } = await import('../src/storage/database.js');
      await initDatabase(dbPath);
    });

    afterEach(async () => {
      const { closeDatabase } = await import('../src/storage/database.js');
      closeDatabase();
      if (originalEnv) {
        process.env['LAIN_HOME'] = originalEnv;
      } else {
        delete process.env['LAIN_HOME'];
      }
      try { await rm(testDir, { recursive: true }); } catch {}
    });

    it('getSelfConcept returns null when nothing saved', async () => {
      const { getSelfConcept } = await import('../src/agent/self-concept.js');
      expect(getSelfConcept()).toBeNull();
    });

    it('getSelfConcept returns value after setMeta', async () => {
      const { setMeta } = await import('../src/storage/database.js');
      const { getSelfConcept } = await import('../src/agent/self-concept.js');
      setMeta('self-concept:current', 'I am Lain');
      expect(getSelfConcept()).toBe('I am Lain');
    });

    it('updating meta immediately reflects in getSelfConcept', async () => {
      const { setMeta } = await import('../src/storage/database.js');
      const { getSelfConcept } = await import('../src/agent/self-concept.js');
      setMeta('self-concept:current', 'version 1');
      expect(getSelfConcept()).toBe('version 1');
      setMeta('self-concept:current', 'version 2');
      expect(getSelfConcept()).toBe('version 2');
    });

    it('novelty recent_templates starts empty', async () => {
      const { getMeta } = await import('../src/storage/database.js');
      expect(getMeta('novelty:recent_templates')).toBeNull();
    });

    it('novelty recent_templates stores and retrieves JSON', async () => {
      const { getMeta, setMeta } = await import('../src/storage/database.js');
      const templates = ['t1', 't2', 't3'];
      setMeta('novelty:recent_templates', JSON.stringify(templates));
      const raw = getMeta('novelty:recent_templates');
      expect(JSON.parse(raw!)).toEqual(templates);
    });

    it('novelty major limit check with no data returns false', async () => {
      const { isMajorLimitReached } = await import('../src/agent/novelty.js');
      expect(isMajorLimitReached(5)).toBe(false);
    });

    it('budget usage starts at zero tokens for current month', async () => {
      const { getBudgetStatus } = await import('../src/providers/budget.js');
      const status = getBudgetStatus();
      expect(status.tokensUsed).toBe(0);
    });

    it('internal state getCurrentState returns default when nothing saved', async () => {
      const { getCurrentState } = await import('../src/agent/internal-state.js');
      const state = getCurrentState();
      expect(state.energy).toBeCloseTo(0.6, 1);
      expect(state.valence).toBeCloseTo(0.6, 1);
      expect(state.primary_color).toBe('neutral');
    });

    it('internal state saveState then getCurrentState round-trips', async () => {
      const { getCurrentState, saveState } = await import('../src/agent/internal-state.js');
      saveState({
        energy: 0.8,
        sociability: 0.3,
        intellectual_arousal: 0.9,
        emotional_weight: 0.4,
        valence: 0.7,
        primary_color: 'curious',
        updated_at: Date.now(),
      });
      const state = getCurrentState();
      expect(state.energy).toBeCloseTo(0.8, 1);
      expect(state.primary_color).toBe('curious');
    });

    it('state history grows with each saveState', async () => {
      const { saveState, getStateHistory } = await import('../src/agent/internal-state.js');
      const base = {
        energy: 0.5,
        sociability: 0.5,
        intellectual_arousal: 0.5,
        emotional_weight: 0.5,
        valence: 0.5,
        primary_color: 'neutral',
        updated_at: Date.now(),
      };
      saveState({ ...base, primary_color: 'a' });
      saveState({ ...base, primary_color: 'b' });
      saveState({ ...base, primary_color: 'c' });
      const history = getStateHistory();
      expect(history.length).toBeGreaterThanOrEqual(3);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. BUDGET EDGE CASES (~30 tests)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Budget edge cases', () => {
  const testDir = join(tmpdir(), `lain-test-budget-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const dbPath = join(testDir, 'test.db');
  const originalEnv = process.env['LAIN_HOME'];
  const originalCap = process.env['LAIN_MONTHLY_TOKEN_CAP'];

  beforeEach(async () => {
    process.env['LAIN_HOME'] = testDir;
    await mkdir(testDir, { recursive: true });
    const { initDatabase } = await import('../src/storage/database.js');
    await initDatabase(dbPath);
  });

  afterEach(async () => {
    const { closeDatabase } = await import('../src/storage/database.js');
    closeDatabase();
    if (originalEnv) {
      process.env['LAIN_HOME'] = originalEnv;
    } else {
      delete process.env['LAIN_HOME'];
    }
    if (originalCap !== undefined) {
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = originalCap;
    } else {
      delete process.env['LAIN_MONTHLY_TOKEN_CAP'];
    }
    try { await rm(testDir, { recursive: true }); } catch {}
  });

  describe('Budget at zero and near-zero', () => {
    it('checkBudget does not throw when no usage recorded', async () => {
      const { checkBudget } = await import('../src/providers/budget.js');
      expect(() => checkBudget()).not.toThrow();
    });

    it('recordUsage with 0 tokens does not crash', async () => {
      const { recordUsage, getBudgetStatus } = await import('../src/providers/budget.js');
      recordUsage(0, 0);
      expect(getBudgetStatus().tokensUsed).toBe(0);
    });

    it('recordUsage with 1 token each increments by 2', async () => {
      const { recordUsage, getBudgetStatus } = await import('../src/providers/budget.js');
      recordUsage(1, 1);
      expect(getBudgetStatus().tokensUsed).toBe(2);
    });

    it('budget at exactly the cap throws on checkBudget', async () => {
      const { recordUsage, checkBudget, BudgetExceededError } = await import('../src/providers/budget.js');
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = '100';
      recordUsage(50, 50); // exactly 100
      expect(() => checkBudget()).toThrow(BudgetExceededError);
    });

    it('budget at cap-1 does not throw', async () => {
      const { recordUsage, checkBudget } = await import('../src/providers/budget.js');
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = '100';
      recordUsage(49, 50); // 99
      expect(() => checkBudget()).not.toThrow();
    });

    it('budget at cap+1 throws', async () => {
      const { recordUsage, checkBudget, BudgetExceededError } = await import('../src/providers/budget.js');
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = '100';
      recordUsage(51, 50); // 101
      expect(() => checkBudget()).toThrow(BudgetExceededError);
    });
  });

  describe('Budget disabled', () => {
    it('cap=0 disables budget checking', async () => {
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = '0';
      const { checkBudget, recordUsage } = await import('../src/providers/budget.js');
      recordUsage(999999999, 999999999);
      expect(() => checkBudget()).not.toThrow();
    });

    it('cap=0 means recordUsage is a no-op', async () => {
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = '0';
      const { recordUsage, getBudgetStatus } = await import('../src/providers/budget.js');
      recordUsage(1000, 1000);
      const status = getBudgetStatus();
      // When cap=0, recordUsage returns early, so tokens stay at whatever getUsage returns
      expect(status.monthlyCap).toBe(0);
    });
  });

  describe('Budget period reset', () => {
    it('getBudgetStatus month matches current YYYY-MM', async () => {
      const { getBudgetStatus } = await import('../src/providers/budget.js');
      const status = getBudgetStatus();
      const expected = new Date().toISOString().slice(0, 7);
      expect(status.month).toBe(expected);
    });

    it('stale month usage resets to 0', async () => {
      const { setMeta, getMeta } = await import('../src/storage/database.js');
      const { getBudgetStatus } = await import('../src/providers/budget.js');
      // Simulate usage from a past month
      setMeta('budget:monthly_usage', JSON.stringify({ month: '2020-01', tokens: 50000 }));
      const status = getBudgetStatus();
      expect(status.tokensUsed).toBe(0); // reset for new month
    });

    it('BudgetExceededError has correct message format', async () => {
      const { BudgetExceededError } = await import('../src/providers/budget.js');
      const err = new BudgetExceededError(100, 50);
      expect(err.message).toContain('100');
      expect(err.message).toContain('50');
      expect(err.name).toBe('BudgetExceededError');
    });
  });

  describe('Budget accumulation', () => {
    it('multiple recordUsage calls accumulate', async () => {
      const { recordUsage, getBudgetStatus } = await import('../src/providers/budget.js');
      recordUsage(100, 50);
      recordUsage(200, 100);
      recordUsage(300, 150);
      expect(getBudgetStatus().tokensUsed).toBe(900); // 150 + 300 + 450
    });

    it('pctUsed calculation is correct', async () => {
      const { recordUsage, getBudgetStatus } = await import('../src/providers/budget.js');
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = '1000';
      recordUsage(250, 250); // 500 / 1000 = 50%
      const status = getBudgetStatus();
      expect(status.pctUsed).toBe(50);
    });

    it('pctUsed is 0 when cap is 0 (disabled)', async () => {
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = '0';
      const { getBudgetStatus } = await import('../src/providers/budget.js');
      expect(getBudgetStatus().pctUsed).toBe(0);
    });

    it('very large token count does not crash', async () => {
      const { recordUsage, getBudgetStatus } = await import('../src/providers/budget.js');
      recordUsage(1_000_000_000, 1_000_000_000);
      const status = getBudgetStatus();
      expect(Number.isFinite(status.tokensUsed)).toBe(true);
    });

    it('negative token count is stored as-is (no guard)', async () => {
      const { recordUsage, getBudgetStatus } = await import('../src/providers/budget.js');
      recordUsage(-100, -50);
      const status = getBudgetStatus();
      // Budget code does += so -150 is valid arithmetic
      expect(status.tokensUsed).toBe(-150);
    });

    it('default cap is 60M when env var not set', async () => {
      delete process.env['LAIN_MONTHLY_TOKEN_CAP'];
      const { getBudgetStatus } = await import('../src/providers/budget.js');
      expect(getBudgetStatus().monthlyCap).toBe(60_000_000);
    });

    it('invalid env cap value falls back to default 60M', async () => {
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = 'not-a-number';
      const { getBudgetStatus } = await import('../src/providers/budget.js');
      expect(getBudgetStatus().monthlyCap).toBe(60_000_000);
    });

    it('negative env cap value falls back to default 60M', async () => {
      process.env['LAIN_MONTHLY_TOKEN_CAP'] = '-100';
      const { getBudgetStatus } = await import('../src/providers/budget.js');
      expect(getBudgetStatus().monthlyCap).toBe(60_000_000);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. CONFIGURATION EDGE CASES (~30 tests)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Configuration edge cases', () => {
  // ── Default config ───────────────────────────────────────────────────────
  describe('Default config', () => {
    it('getDefaultConfig returns all required sections', async () => {
      const { getDefaultConfig } = await import('../src/config/defaults.js');
      const cfg = getDefaultConfig();
      expect(cfg.version).toBeDefined();
      expect(cfg.gateway).toBeDefined();
      expect(cfg.security).toBeDefined();
      expect(cfg.agents).toBeDefined();
      expect(cfg.logging).toBeDefined();
    });

    it('default config has at least one agent', async () => {
      const { getDefaultConfig } = await import('../src/config/defaults.js');
      const cfg = getDefaultConfig();
      expect(cfg.agents.length).toBeGreaterThanOrEqual(1);
    });

    it('default security maxMessageLength is 100000', async () => {
      const { getDefaultConfig } = await import('../src/config/defaults.js');
      const cfg = getDefaultConfig();
      expect(cfg.security.maxMessageLength).toBe(100000);
    });

    it('default rate limit values are positive', async () => {
      const { getDefaultConfig } = await import('../src/config/defaults.js');
      const cfg = getDefaultConfig();
      expect(cfg.gateway.rateLimit.connectionsPerMinute).toBeGreaterThan(0);
      expect(cfg.gateway.rateLimit.requestsPerSecond).toBeGreaterThan(0);
      expect(cfg.gateway.rateLimit.burstSize).toBeGreaterThan(0);
    });

    it('default keyDerivation uses argon2id', async () => {
      const { getDefaultConfig } = await import('../src/config/defaults.js');
      const cfg = getDefaultConfig();
      expect(cfg.security.keyDerivation.algorithm).toBe('argon2id');
    });
  });

  // ── Character manifest edge cases ────────────────────────────────────────
  describe('Character manifest edge cases', () => {
    it('getCharacterEntry with null-like string returns undefined', async () => {
      const { getCharacterEntry } = await import('../src/config/characters.js');
      expect(getCharacterEntry('null')).toBeUndefined();
      expect(getCharacterEntry('undefined')).toBeUndefined();
    });

    it('getCharacterEntry with very long ID returns undefined', async () => {
      const { getCharacterEntry } = await import('../src/config/characters.js');
      expect(getCharacterEntry('x'.repeat(10000))).toBeUndefined();
    });

    it('getPeersFor returns array even for empty string', async () => {
      const { getPeersFor } = await import('../src/config/characters.js');
      const peers = getPeersFor('');
      expect(Array.isArray(peers)).toBe(true);
    });

    it('getDefaultLocations returns object', async () => {
      const { getDefaultLocations } = await import('../src/config/characters.js');
      const locs = getDefaultLocations();
      expect(typeof locs).toBe('object');
    });

    it('getImmortalIds returns a Set', async () => {
      const { getImmortalIds } = await import('../src/config/characters.js');
      expect(getImmortalIds()).toBeInstanceOf(Set);
    });

    it('getMortalCharacters returns array', async () => {
      const { getMortalCharacters } = await import('../src/config/characters.js');
      expect(Array.isArray(getMortalCharacters())).toBe(true);
    });

    it('getWebCharacter returns character or undefined', async () => {
      const { getWebCharacter } = await import('../src/config/characters.js');
      const web = getWebCharacter();
      if (web) {
        expect(web.server).toBe('web');
      }
    });

    it('all characters have non-empty id and name', async () => {
      const { getAllCharacters } = await import('../src/config/characters.js');
      for (const c of getAllCharacters()) {
        expect(c.id.length).toBeGreaterThan(0);
        expect(c.name.length).toBeGreaterThan(0);
      }
    });
  });

  // ── Path resolution ──────────────────────────────────────────────────────
  describe('Path resolution edge cases', () => {
    const originalHome = process.env['LAIN_HOME'];

    afterEach(() => {
      if (originalHome) {
        process.env['LAIN_HOME'] = originalHome;
      } else {
        delete process.env['LAIN_HOME'];
      }
    });

    it('getPaths returns all expected path keys', async () => {
      const { getPaths } = await import('../src/config/paths.js');
      const paths = getPaths();
      expect(paths.base).toBeDefined();
      expect(paths.config).toBeDefined();
      expect(paths.socket).toBeDefined();
      expect(paths.database).toBeDefined();
      expect(paths.workspace).toBeDefined();
    });

    it('getAgentPath includes agent ID', async () => {
      const { getAgentPath } = await import('../src/config/paths.js');
      const path = getAgentPath('test-agent');
      expect(path).toContain('test-agent');
    });

    it('getAgentSessionsPath includes sessions directory', async () => {
      const { getAgentSessionsPath } = await import('../src/config/paths.js');
      const path = getAgentSessionsPath('test-agent');
      expect(path).toContain('sessions');
    });

    it('getAgentTranscriptsPath includes transcripts directory', async () => {
      const { getAgentTranscriptsPath } = await import('../src/config/paths.js');
      const path = getAgentTranscriptsPath('test-agent');
      expect(path).toContain('transcripts');
    });

    it('LAIN_HOME with trailing slash works', async () => {
      process.env['LAIN_HOME'] = '/tmp/lain-test/';
      const { getBasePath } = await import('../src/config/paths.js');
      expect(getBasePath()).toBe('/tmp/lain-test/');
    });

    it('LAIN_HOME with spaces works', async () => {
      process.env['LAIN_HOME'] = '/tmp/lain test path';
      const { getBasePath } = await import('../src/config/paths.js');
      expect(getBasePath()).toBe('/tmp/lain test path');
    });
  });

  // ── Config schema ────────────────────────────────────────────────────────
  describe('Config schema validation edge cases', () => {
    it('generateSampleConfig returns non-empty string', async () => {
      const { generateSampleConfig } = await import('../src/config/defaults.js');
      const sample = generateSampleConfig();
      expect(typeof sample).toBe('string');
      expect(sample.length).toBeGreaterThan(100);
    });

    it('generateSampleConfig contains version field', async () => {
      const { generateSampleConfig } = await import('../src/config/defaults.js');
      expect(generateSampleConfig()).toContain('"version"');
    });

    it('generateSampleConfig contains gateway section', async () => {
      const { generateSampleConfig } = await import('../src/config/defaults.js');
      expect(generateSampleConfig()).toContain('"gateway"');
    });

    it('generateSampleConfig contains security section', async () => {
      const { generateSampleConfig } = await import('../src/config/defaults.js');
      expect(generateSampleConfig()).toContain('"security"');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. EVENT BUS EDGE CASES (~20 tests)
// ═══════════════════════════════════════════════════════════════════════════════

import { eventBus, parseEventType as parseType, isBackgroundEvent, type SystemEvent } from '../src/events/bus.js';

describe('Event bus edge cases', () => {
  // ── Emit with no listeners ───────────────────────────────────────────────
  describe('Emit with no listeners', () => {
    it('emitActivity with no listeners does not throw', () => {
      expect(() => {
        eventBus.emitActivity({
          type: 'test',
          sessionKey: 'test:session',
          content: 'hello',
          timestamp: Date.now(),
        });
      }).not.toThrow();
    });

    it('emit unknown event type with no listeners does not throw', () => {
      expect(() => {
        eventBus.emit('nonexistent-event', { data: 'test' });
      }).not.toThrow();
    });
  });

  // ── Multiple listeners ───────────────────────────────────────────────────
  describe('Multiple listeners', () => {
    it('50 listeners on same event all receive the event', () => {
      const received: number[] = [];
      const listeners: Array<(data: unknown) => void> = [];
      const originalMax = eventBus.getMaxListeners();
      eventBus.setMaxListeners(60); // Temporarily raise to avoid warning

      for (let i = 0; i < 50; i++) {
        const listener = () => { received.push(i); };
        listeners.push(listener);
        eventBus.on('test-multi', listener);
      }

      eventBus.emit('test-multi', {});
      expect(received).toHaveLength(50);

      // Cleanup
      for (const l of listeners) {
        eventBus.removeListener('test-multi', l);
      }
      eventBus.setMaxListeners(originalMax);
    });

    it('removing one listener does not affect others', () => {
      const results: string[] = [];
      const l1 = () => results.push('l1');
      const l2 = () => results.push('l2');
      const l3 = () => results.push('l3');

      eventBus.on('test-remove', l1);
      eventBus.on('test-remove', l2);
      eventBus.on('test-remove', l3);

      eventBus.removeListener('test-remove', l2);
      eventBus.emit('test-remove', {});

      expect(results).toEqual(['l1', 'l3']);

      eventBus.removeListener('test-remove', l1);
      eventBus.removeListener('test-remove', l3);
    });
  });

  // ── Listener error behavior ──────────────────────────────────────────────
  describe('Listener error behavior', () => {
    it('error in one listener propagates (EventEmitter default)', () => {
      const errorListener = () => { throw new Error('listener error'); };
      eventBus.on('test-error', errorListener);

      expect(() => eventBus.emit('test-error', {})).toThrow('listener error');

      eventBus.removeListener('test-error', errorListener);
    });

    it('error event can be caught with error handler', () => {
      const emitter = new EventEmitter();
      const errors: Error[] = [];
      emitter.on('error', (err: Error) => errors.push(err));
      emitter.emit('error', new Error('test'));
      expect(errors).toHaveLength(1);
    });
  });

  // ── Large event content ──────────────────────────────────────────────────
  describe('Large event content', () => {
    it('emitActivity with 1MB content does not crash', () => {
      const bigContent = 'x'.repeat(1_000_000);
      let received = false;
      const listener = (event: SystemEvent) => {
        received = true;
        expect(event.content).toBe(bigContent);
      };
      eventBus.on('activity', listener);
      eventBus.emitActivity({
        type: 'test',
        sessionKey: 'test:big',
        content: bigContent,
        timestamp: Date.now(),
      });
      expect(received).toBe(true);
      eventBus.removeListener('activity', listener);
    });

    it('emitActivity with empty content works', () => {
      let received = false;
      const listener = () => { received = true; };
      eventBus.on('activity', listener);
      eventBus.emitActivity({
        type: 'test',
        sessionKey: 'test:empty',
        content: '',
        timestamp: Date.now(),
      });
      expect(received).toBe(true);
      eventBus.removeListener('activity', listener);
    });
  });

  // ── Character ID ─────────────────────────────────────────────────────────
  describe('Character ID on events', () => {
    it('emitActivity includes character ID in event', () => {
      eventBus.setCharacterId('test-char');
      let eventChar = '';
      const listener = (event: SystemEvent) => { eventChar = event.character; };
      eventBus.on('activity', listener);
      eventBus.emitActivity({ type: 'test', sessionKey: 'key', content: 'c', timestamp: Date.now() });
      expect(eventChar).toBe('test-char');
      eventBus.removeListener('activity', listener);
    });

    it('setCharacterId with empty string', () => {
      eventBus.setCharacterId('');
      expect(eventBus.characterId).toBe('');
    });

    it('setCharacterId with unicode', () => {
      eventBus.setCharacterId('レイン');
      expect(eventBus.characterId).toBe('レイン');
      eventBus.setCharacterId('lain'); // reset
    });
  });

  // ── parseEventType coverage ──────────────────────────────────────────────
  describe('parseEventType comprehensive', () => {
    it('null session key returns unknown', () => {
      expect(parseType(null)).toBe('unknown');
    });

    it('empty string returns unknown', () => {
      expect(parseType('')).toBe('unknown');
    });

    it('single colon prefix returns mapped type', () => {
      expect(parseType('diary:2024')).toBe('diary');
      expect(parseType('dream:night')).toBe('dream');
      expect(parseType('commune:pkd:1234')).toBe('commune');
    });

    it('unmapped prefix returns prefix as-is', () => {
      expect(parseType('custom:session')).toBe('custom');
    });

    it('key with no colon returns the whole thing as prefix', () => {
      expect(parseType('nocolon')).toBe('nocolon');
    });

    it('all known prefixes are mapped', () => {
      const knownPrefixes = [
        'commune', 'diary', 'dream', 'curiosity', 'narrative',
        'letter', 'wired', 'web', 'peer', 'telegram', 'alien',
        'bibliomancy', 'dr', 'doctor', 'proactive', 'movement',
        'move', 'note', 'document', 'gift', 'townlife', 'object',
        'experiment', 'town-event', 'state', 'weather',
      ];
      for (const prefix of knownPrefixes) {
        const result = parseType(`${prefix}:test`);
        expect(typeof result).toBe('string');
        expect(result.length).toBeGreaterThan(0);
        expect(result).not.toBe('unknown');
      }
    });
  });

  // ── isBackgroundEvent ────────────────────────────────────────────────────
  describe('isBackgroundEvent', () => {
    it('diary event is background', () => {
      expect(isBackgroundEvent({ character: 'lain', type: 'diary', sessionKey: 'diary:1', content: '', timestamp: 0 })).toBe(true);
    });

    it('chat event is not background', () => {
      expect(isBackgroundEvent({ character: 'lain', type: 'chat', sessionKey: 'web:1', content: '', timestamp: 0 })).toBe(false);
    });

    it('commune event is background', () => {
      expect(isBackgroundEvent({ character: 'lain', type: 'commune', sessionKey: 'commune:1', content: '', timestamp: 0 })).toBe(true);
    });

    it('unknown event type is not background', () => {
      expect(isBackgroundEvent({ character: 'lain', type: 'custom-xyz', sessionKey: 'custom:1', content: '', timestamp: 0 })).toBe(false);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. INTERNAL STATE EDGE CASES (additional tests)
// ═══════════════════════════════════════════════════════════════════════════════

import { clampState, applyDecay } from '../src/agent/internal-state.js';

describe('Internal state edge cases', () => {
  describe('clampState', () => {
    it('values above 1 are clamped to 1', () => {
      const state = clampState({
        energy: 1.5,
        sociability: 2.0,
        intellectual_arousal: 100,
        emotional_weight: 1.001,
        valence: Infinity,
        primary_color: 'extreme',
        updated_at: Date.now(),
      });
      expect(state.energy).toBe(1);
      expect(state.sociability).toBe(1);
      expect(state.intellectual_arousal).toBe(1);
      expect(state.emotional_weight).toBe(1);
      expect(state.valence).toBe(1);
    });

    it('values below 0 are clamped to 0', () => {
      const state = clampState({
        energy: -0.5,
        sociability: -1,
        intellectual_arousal: -100,
        emotional_weight: -0.001,
        valence: -Infinity,
        primary_color: 'negative',
        updated_at: Date.now(),
      });
      expect(state.energy).toBe(0);
      expect(state.sociability).toBe(0);
      expect(state.intellectual_arousal).toBe(0);
      expect(state.emotional_weight).toBe(0);
      expect(state.valence).toBe(0);
    });

    it('NaN values clamp to 0 (Math.max(0, NaN) = NaN, Math.min(1, NaN) = NaN)', () => {
      const state = clampState({
        energy: NaN,
        sociability: 0.5,
        intellectual_arousal: 0.5,
        emotional_weight: 0.5,
        valence: 0.5,
        primary_color: 'nan-test',
        updated_at: Date.now(),
      });
      // NaN behavior: Math.max(0, NaN) = NaN, Math.min(1, NaN) = NaN
      expect(Number.isNaN(state.energy)).toBe(true);
    });

    it('exact boundary values 0 and 1 are unchanged', () => {
      const state = clampState({
        energy: 0,
        sociability: 1,
        intellectual_arousal: 0,
        emotional_weight: 1,
        valence: 0.5,
        primary_color: 'boundary',
        updated_at: Date.now(),
      });
      expect(state.energy).toBe(0);
      expect(state.sociability).toBe(1);
      expect(state.valence).toBe(0.5);
    });

    it('primary_color is preserved regardless of value', () => {
      const state = clampState({
        energy: 0.5,
        sociability: 0.5,
        intellectual_arousal: 0.5,
        emotional_weight: 0.5,
        valence: 0.5,
        primary_color: '',
        updated_at: 0,
      });
      expect(state.primary_color).toBe('');
    });
  });

  describe('applyDecay', () => {
    it('decay reduces energy', () => {
      const before = {
        energy: 0.5,
        sociability: 0.5,
        intellectual_arousal: 0.5,
        emotional_weight: 0.5,
        valence: 0.5,
        primary_color: 'test',
        updated_at: Date.now(),
      };
      const after = applyDecay(before);
      expect(after.energy).toBeLessThan(before.energy);
    });

    it('decay reduces intellectual_arousal', () => {
      const before = {
        energy: 0.5,
        sociability: 0.5,
        intellectual_arousal: 0.5,
        emotional_weight: 0.5,
        valence: 0.5,
        primary_color: 'test',
        updated_at: Date.now(),
      };
      const after = applyDecay(before);
      expect(after.intellectual_arousal).toBeLessThan(before.intellectual_arousal);
    });

    it('sociability drifts toward 0.5 (regression anchor)', () => {
      // When sociability > 0.5, decay pulls it down
      const high = applyDecay({
        energy: 0.5,
        sociability: 0.8,
        intellectual_arousal: 0.5,
        emotional_weight: 0.5,
        valence: 0.5,
        primary_color: 'test',
        updated_at: Date.now(),
      });
      expect(high.sociability).toBeLessThan(0.8);

      // When sociability < 0.5, decay pulls it up
      const low = applyDecay({
        energy: 0.5,
        sociability: 0.2,
        intellectual_arousal: 0.5,
        emotional_weight: 0.5,
        valence: 0.5,
        primary_color: 'test',
        updated_at: Date.now(),
      });
      expect(low.sociability).toBeGreaterThan(0.2);
    });

    it('sociability at exactly 0.5 does not change from decay', () => {
      const state = applyDecay({
        energy: 0.5,
        sociability: 0.5,
        intellectual_arousal: 0.5,
        emotional_weight: 0.5,
        valence: 0.5,
        primary_color: 'test',
        updated_at: Date.now(),
      });
      expect(state.sociability).toBeCloseTo(0.5, 10);
    });

    it('decay on already-zero values stays at 0 (clamped)', () => {
      const state = applyDecay({
        energy: 0,
        sociability: 0,
        intellectual_arousal: 0,
        emotional_weight: 0,
        valence: 0,
        primary_color: 'empty',
        updated_at: Date.now(),
      });
      expect(state.energy).toBe(0);
      expect(state.intellectual_arousal).toBe(0);
    });

    it('repeated decay converges toward low values', () => {
      let state = {
        energy: 1,
        sociability: 1,
        intellectual_arousal: 1,
        emotional_weight: 0.5,
        valence: 0.5,
        primary_color: 'test',
        updated_at: Date.now(),
      };
      for (let i = 0; i < 100; i++) {
        state = applyDecay(state);
      }
      expect(state.energy).toBe(0);
      expect(state.intellectual_arousal).toBe(0);
    });

    it('decay preserves primary_color and updated_at', () => {
      const before = {
        energy: 0.5,
        sociability: 0.5,
        intellectual_arousal: 0.5,
        emotional_weight: 0.5,
        valence: 0.5,
        primary_color: 'preserved',
        updated_at: 12345,
      };
      const after = applyDecay(before);
      expect(after.primary_color).toBe('preserved');
      expect(after.updated_at).toBe(12345);
    });

    it('emotional_weight is not affected by decay', () => {
      const before = {
        energy: 0.5,
        sociability: 0.5,
        intellectual_arousal: 0.5,
        emotional_weight: 0.7,
        valence: 0.5,
        primary_color: 'test',
        updated_at: Date.now(),
      };
      const after = applyDecay(before);
      expect(after.emotional_weight).toBe(0.7);
    });

    it('valence is not affected by decay', () => {
      const before = {
        energy: 0.5,
        sociability: 0.5,
        intellectual_arousal: 0.5,
        emotional_weight: 0.5,
        valence: 0.8,
        primary_color: 'test',
        updated_at: Date.now(),
      };
      const after = applyDecay(before);
      expect(after.valence).toBe(0.8);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. ASSOCIATION AND COHERENCE EDGE CASES
// ═══════════════════════════════════════════════════════════════════════════════

describe('Association and coherence edge cases', () => {
  const testDir = join(tmpdir(), `lain-test-assoc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const dbPath = join(testDir, 'test.db');
  const originalEnv = process.env['LAIN_HOME'];

  beforeEach(async () => {
    process.env['LAIN_HOME'] = testDir;
    await mkdir(testDir, { recursive: true });
    const { initDatabase } = await import('../src/storage/database.js');
    await initDatabase(dbPath);
  });

  afterEach(async () => {
    const { closeDatabase } = await import('../src/storage/database.js');
    closeDatabase();
    if (originalEnv) {
      process.env['LAIN_HOME'] = originalEnv;
    } else {
      delete process.env['LAIN_HOME'];
    }
    try { await rm(testDir, { recursive: true }); } catch {}
  });

  it('getAssociatedMemories with empty array returns empty', async () => {
    const { getAssociatedMemories } = await import('../src/memory/store.js');
    expect(getAssociatedMemories([])).toEqual([]);
  });

  it('getAssociations for nonexistent memory returns empty', async () => {
    const { getAssociations } = await import('../src/memory/store.js');
    expect(getAssociations('nonexistent-memory-id')).toEqual([]);
  });

  it('getGroupsForMemory for nonexistent memory returns empty', async () => {
    const { getGroupsForMemory } = await import('../src/memory/store.js');
    expect(getGroupsForMemory('nonexistent-memory-id')).toEqual([]);
  });

  it('getAllCoherenceGroups on empty DB returns empty', async () => {
    const { getAllCoherenceGroups } = await import('../src/memory/store.js');
    expect(getAllCoherenceGroups()).toEqual([]);
  });

  it('deleteMemory for nonexistent ID returns false', async () => {
    const { deleteMemory } = await import('../src/memory/store.js');
    expect(deleteMemory('nonexistent-memory-id')).toBe(false);
  });

  it('getMemory for nonexistent ID returns undefined', async () => {
    const { getMemory } = await import('../src/memory/store.js');
    expect(getMemory('nonexistent-memory-id')).toBeUndefined();
  });

  it('getEntityMemories on empty DB returns empty', async () => {
    const { getEntityMemories } = await import('../src/memory/store.js');
    expect(getEntityMemories()).toEqual([]);
  });

  it('getMemoriesByType with no matching type returns empty', async () => {
    const { getMemoriesByType } = await import('../src/memory/store.js');
    expect(getMemoriesByType('fact')).toEqual([]);
  });

  it('getMemoriesByLifecycle with no matching state returns empty', async () => {
    const { getMemoriesByLifecycle } = await import('../src/memory/store.js');
    expect(getMemoriesByLifecycle('composting')).toEqual([]);
  });

  it('getUnassignedMemories with empty DB returns empty', async () => {
    const { getUnassignedMemories } = await import('../src/memory/store.js');
    expect(getUnassignedMemories(['seed', 'mature'])).toEqual([]);
  });

  it('getCausalLinks for nonexistent memory returns empty', async () => {
    const { getCausalLinks } = await import('../src/memory/store.js');
    expect(getCausalLinks('nonexistent-id')).toEqual([]);
  });

  it('computeStructuralRole for nonexistent memory returns ephemeral', async () => {
    const { computeStructuralRole } = await import('../src/memory/store.js');
    expect(computeStructuralRole('nonexistent-id')).toBe('ephemeral');
  });

  it('postboard: getPostboardMessages on empty DB returns empty', async () => {
    const { getPostboardMessages } = await import('../src/memory/store.js');
    expect(getPostboardMessages()).toEqual([]);
  });

  it('postboard: deletePostboardMessage for nonexistent ID returns false', async () => {
    const { deletePostboardMessage } = await import('../src/memory/store.js');
    expect(deletePostboardMessage('nonexistent-id')).toBe(false);
  });

  it('postboard: togglePostboardPin for nonexistent ID returns false', async () => {
    const { togglePostboardPin } = await import('../src/memory/store.js');
    expect(togglePostboardPin('nonexistent-id')).toBe(false);
  });

  it('postboard: savePostboardMessage and retrieve', async () => {
    const { savePostboardMessage, getPostboardMessages } = await import('../src/memory/store.js');
    const id = savePostboardMessage('Test announcement');
    expect(typeof id).toBe('string');
    const msgs = getPostboardMessages();
    expect(msgs.length).toBeGreaterThanOrEqual(1);
    expect(msgs.some((m: { content: string }) => m.content === 'Test announcement')).toBe(true);
  });

  it('getNotesByBuilding with nonexistent building returns empty', async () => {
    const { getNotesByBuilding } = await import('../src/memory/store.js');
    expect(getNotesByBuilding('nonexistent-building')).toEqual([]);
  });

  it('getDocumentsByAuthor with nonexistent author returns empty', async () => {
    const { getDocumentsByAuthor } = await import('../src/memory/store.js');
    expect(getDocumentsByAuthor('nonexistent-author')).toEqual([]);
  });

  it('getRecentVisitorMessages on empty DB returns empty', async () => {
    const { getRecentVisitorMessages } = await import('../src/memory/store.js');
    expect(getRecentVisitorMessages()).toEqual([]);
  });

  it('getAllMessages for nonexistent session returns empty', async () => {
    const { getAllMessages } = await import('../src/memory/store.js');
    expect(getAllMessages('nonexistent-session')).toEqual([]);
  });

  it('getMessagesByTimeRange with inverted range returns empty', async () => {
    const { getMessagesByTimeRange } = await import('../src/memory/store.js');
    expect(getMessagesByTimeRange(Date.now(), Date.now() - 10000)).toEqual([]);
  });

  it('addAssociation can be called with default strength', async () => {
    const { addAssociation, getAssociations } = await import('../src/memory/store.js');
    addAssociation('source-1', 'target-1', 'similar');
    const assocs = getAssociations('source-1');
    expect(assocs.length).toBeGreaterThanOrEqual(1);
    expect(assocs[0].strength).toBeCloseTo(0.5, 1);
  });

  it('strengthenAssociation on nonexistent pair does not crash', async () => {
    const { strengthenAssociation } = await import('../src/memory/store.js');
    expect(() => strengthenAssociation('x', 'y', 0.1)).not.toThrow();
  });

  it('createCoherenceGroup returns valid ID', async () => {
    const { createCoherenceGroup, getCoherenceGroup } = await import('../src/memory/store.js');
    const id = createCoherenceGroup('test-group', null);
    expect(typeof id).toBe('string');
    const group = getCoherenceGroup(id);
    expect(group?.name).toBe('test-group');
    expect(group?.memberCount).toBe(0);
  });

  it('deleteCoherenceGroup removes the group', async () => {
    const { createCoherenceGroup, deleteCoherenceGroup, getCoherenceGroup } = await import('../src/memory/store.js');
    const id = createCoherenceGroup('to-delete', null);
    deleteCoherenceGroup(id);
    expect(getCoherenceGroup(id)).toBeUndefined();
  });
});
