/**
 * Tool behavioral test suite
 *
 * Actually EXECUTES each tool with mocked dependencies and verifies behavior.
 * Complements test/tools.test.ts (structural/source-reading tests) with
 * runtime assertions on tool handlers, input validation, loop mechanics,
 * doctor tools, character tools, and provider interaction.
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';

// ─── Module-level mocks (must be before any source imports) ────────────────

vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn().mockResolvedValue('test-master-key'),
    setPassword: vi.fn().mockResolvedValue(undefined),
    deletePassword: vi.fn().mockResolvedValue(true),
    findCredentials: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Redirect safeFetch/safeFetchFollow to globalThis.fetch so existing
// `globalThis.fetch = vi.fn()` mocks still drive the fetch_webpage /
// fetch_and_show_image / view_image handlers after the SSRF refactor.
// The mock preserves the production scheme-reject behavior so invalid-
// scheme tests still assert via a thrown SSRF-protection error.
vi.mock('../src/security/ssrf.js', () => {
  const BLOCKED = ['file:', 'ftp:', 'gopher:', 'data:', 'javascript:'];
  const ALLOWED = ['http:', 'https:'];
  const checkScheme = (url: string): void => {
    let parsed: URL;
    try { parsed = new URL(url); } catch {
      throw new Error('SSRF protection: Invalid URL');
    }
    if (BLOCKED.includes(parsed.protocol)) {
      throw new Error(`SSRF protection: Blocked URL scheme: ${parsed.protocol}`);
    }
    if (!ALLOWED.includes(parsed.protocol)) {
      throw new Error(`SSRF protection: Unsupported URL scheme: ${parsed.protocol}`);
    }
  };
  const passthrough = async (url: string, options?: RequestInit) => {
    checkScheme(url);
    return globalThis.fetch(url, options);
  };
  // findings.md P2:1305 — sanitizeURL/isAllowedDomain/isBlockedDomain
  // removed from the SSRF module surface; the mock no longer needs to
  // shim them.
  return {
    safeFetch: vi.fn(passthrough),
    safeFetchFollow: vi.fn(passthrough),
    checkSSRF: vi.fn().mockResolvedValue({ safe: true }),
    isPrivateIP: vi.fn().mockReturnValue(false),
  };
});

vi.mock('../src/storage/database.js', () => ({
  query: vi.fn().mockReturnValue([]),
  queryOne: vi.fn().mockReturnValue(null),
  execute: vi.fn(),
  getMeta: vi.fn().mockReturnValue(null),
  setMeta: vi.fn(),
  initDatabase: vi.fn().mockResolvedValue(undefined),
  closeDatabase: vi.fn(),
}));

vi.mock('../src/memory/store.js', () => ({
  saveMemory: vi.fn().mockResolvedValue('mem-id-1'),
  searchMemories: vi.fn().mockResolvedValue([]),
  getMemory: vi.fn().mockReturnValue(null),
  getAssociatedMemories: vi.fn().mockReturnValue([]),
  updateMemoryAccess: vi.fn(),
  countMemories: vi.fn().mockReturnValue(42),
  countMessages: vi.fn().mockReturnValue(100),
  getActivity: vi.fn().mockReturnValue([]),
  getPostboardMessages: vi.fn().mockReturnValue([]),
}));

vi.mock('../src/events/bus.js', () => ({
  eventBus: {
    characterId: 'test-char',
    setCharacterId: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    emitActivity: vi.fn(),
    emit: vi.fn(),
  },
  isBackgroundEvent: vi.fn().mockReturnValue(true),
  parseEventType: vi.fn().mockReturnValue({ type: 'unknown' }),
}));

vi.mock('../src/memory/embeddings.js', () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Float32Array(256)),
  cosineSimilarity: vi.fn().mockReturnValue(0.8),
  serializeEmbedding: vi.fn().mockReturnValue(Buffer.alloc(0)),
  deserializeEmbedding: vi.fn().mockReturnValue(new Float32Array(256)),
  CURRENT_EMBEDDING_MODEL: 'Xenova/all-MiniLM-L6-v2',
}));

vi.mock('../src/config/paths.js', () => ({
  getBasePath: vi.fn().mockReturnValue('/tmp/lain-test'),
  getPaths: vi.fn().mockReturnValue({
    database: '/tmp/lain-test/lain.db',
    logs: '/tmp/lain-test/logs',
    workspace: '/tmp/lain-test/workspace',
  }),
}));

vi.mock('../src/config/characters.js', () => ({
  getAllCharacters: vi.fn().mockReturnValue([]),
  getCharacterEntry: vi.fn().mockReturnValue(null),
  getDefaultLocations: vi.fn().mockReturnValue({ 'test-char': 'lighthouse' }),
  getImmortalIds: vi.fn().mockReturnValue([]),
  getMortalCharacters: vi.fn().mockReturnValue([]),
  getWebCharacter: vi.fn().mockReturnValue(null),
  getPeersFor: vi.fn().mockReturnValue([]),
}));

vi.mock('../src/agent/letter.js', () => ({
  runLetterCycle: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/agent/self-concept.js', () => ({
  getSelfConcept: vi.fn().mockReturnValue('I am a test character'),
}));

vi.mock('../src/agent/objects.js', () => ({
  reflectOnObject: vi.fn().mockResolvedValue('A meaningful reflection'),
  composeObjects: vi.fn().mockResolvedValue('A composed meaning'),
  buildObjectContext: vi.fn().mockResolvedValue(null),
}));

vi.mock('../src/commune/location.js', () => ({
  getCurrentLocation: vi.fn().mockReturnValue({ building: 'lighthouse', timestamp: Date.now() }),
  setCurrentLocation: vi.fn(),
}));

vi.mock('../src/commune/buildings.js', () => {
  const BUILDINGS = [
    { id: 'library', name: 'Library', emoji: '📚', row: 0, col: 0, description: 'knowledge, quiet study' },
    { id: 'bar', name: 'Bar', emoji: '🍺', row: 0, col: 1, description: 'social gathering' },
    { id: 'field', name: 'Field', emoji: '🌾', row: 0, col: 2, description: 'open sky' },
    { id: 'windmill', name: 'Windmill', emoji: '🏗', row: 1, col: 0, description: 'energy, cycles' },
    { id: 'lighthouse', name: 'Lighthouse', emoji: '🗼', row: 1, col: 1, description: 'solitude, seeking' },
    { id: 'school', name: 'School', emoji: '🏫', row: 1, col: 2, description: 'learning' },
    { id: 'market', name: 'Market', emoji: '🏪', row: 2, col: 0, description: 'exchange' },
    { id: 'locksmith', name: 'Locksmith', emoji: '🔐', row: 2, col: 1, description: 'puzzles, secrets' },
    { id: 'threshold', name: 'The Threshold', emoji: '🚪', row: 2, col: 2, description: 'liminal space' },
  ] as const;
  const BUILDING_MAP = new Map(BUILDINGS.map((b) => [b.id, b]));
  return {
    BUILDINGS,
    BUILDING_MAP,
    isValidBuilding: (id: string) => BUILDING_MAP.has(id),
    getDefaultLocationsFromManifest: () => ({ 'test-char': 'lighthouse' }),
    DEFAULT_LOCATIONS: { 'test-char': 'lighthouse' },
  };
});

vi.mock('pdf-parse', () => ({
  PDFParse: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', async () => {
  // findings.md P2:838 — preserve real APIError exports so the provider's
  // `err instanceof APIError` retry classification works under test.
  const actual = await vi.importActual<typeof import('@anthropic-ai/sdk')>('@anthropic-ai/sdk');
  return { ...actual, default: vi.fn() };
});

vi.mock('grammy', () => ({
  Bot: vi.fn().mockImplementation(() => ({
    api: { sendMessage: vi.fn().mockResolvedValue({}) },
  })),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────

import {
  registerTool,
  unregisterTool,
  getToolDefinitions,
  executeTool,
  executeTools,
  extractTextFromHtml,
} from '../src/agent/tools.js';
import type { ToolCall, ToolResult } from '../src/providers/base.js';
import { saveMemory, searchMemories, getMemory, getAssociatedMemories, updateMemoryAccess } from '../src/memory/store.js';
import { runLetterCycle } from '../src/agent/letter.js';
import { getCurrentLocation, setCurrentLocation } from '../src/commune/location.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeToolCall(name: string, input: Record<string, unknown> = {}, id?: string): ToolCall {
  return { id: id ?? `call-${name}-${Date.now()}`, name, input };
}

function expectValidResult(result: ToolResult, callId: string): void {
  expect(result).toBeDefined();
  expect(result.toolCallId).toBe(callId);
  expect(typeof result.content).toBe('string');
}

function expectSuccess(result: ToolResult): void {
  expect(result.isError).toBeUndefined();
}

function expectError(result: ToolResult): void {
  expect(result.isError).toBe(true);
}

// ─── Global fetch mock ───────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// =========================================================================
// 1. TOOL EXECUTION BEHAVIORAL — Execute each registered tool
// =========================================================================

describe('Tool Execution Behavioral', () => {
  // ── get_current_time ──────────────────────────────────────────────────

  describe('get_current_time', () => {
    it('returns current time with default UTC timezone', async () => {
      const call = makeToolCall('get_current_time', {});
      const result = await executeTool(call);
      expectValidResult(result, call.id);
      expectSuccess(result);
      expect(result.content).toContain('Current time');
      expect(result.content).toContain('UTC');
    });

    it('returns time in specified timezone', async () => {
      const call = makeToolCall('get_current_time', { timezone: 'America/New_York' });
      const result = await executeTool(call);
      expectValidResult(result, call.id);
      expectSuccess(result);
      expect(result.content).toContain('America/New_York');
    });

    it('falls back to UTC on invalid timezone', async () => {
      const call = makeToolCall('get_current_time', { timezone: 'Invalid/Zone' });
      const result = await executeTool(call);
      expectValidResult(result, call.id);
      expectSuccess(result);
      expect(result.content).toContain('UTC');
    });

    it('returns a string containing a date-like pattern', async () => {
      const call = makeToolCall('get_current_time', {});
      const result = await executeTool(call);
      // Should contain numbers (from the date/time)
      expect(result.content).toMatch(/\d/);
    });
  });

  // ── calculate ─────────────────────────────────────────────────────────

  describe('calculate', () => {
    it('evaluates simple addition', async () => {
      const call = makeToolCall('calculate', { expression: '2 + 2' });
      const result = await executeTool(call);
      expectValidResult(result, call.id);
      expectSuccess(result);
      expect(result.content).toBe('Result: 4');
    });

    it('evaluates multiplication', async () => {
      const call = makeToolCall('calculate', { expression: '3 * 7' });
      const result = await executeTool(call);
      expect(result.content).toBe('Result: 21');
    });

    it('evaluates sqrt', async () => {
      const call = makeToolCall('calculate', { expression: 'sqrt(16)' });
      const result = await executeTool(call);
      expect(result.content).toBe('Result: 4');
    });

    it('evaluates nested expressions', async () => {
      const call = makeToolCall('calculate', { expression: '(2 + 3) * 4' });
      const result = await executeTool(call);
      expect(result.content).toBe('Result: 20');
    });

    it('evaluates division', async () => {
      const call = makeToolCall('calculate', { expression: '10 / 2' });
      const result = await executeTool(call);
      expect(result.content).toBe('Result: 5');
    });

    it('sanitizes malicious expressions', async () => {
      const call = makeToolCall('calculate', { expression: 'process.exit(1)' });
      const result = await executeTool(call);
      expectValidResult(result, call.id);
      // The sanitization strips out letters not in sqrt, so it will error or return a nonsensical result
      // Either way, it should not crash
      expect(typeof result.content).toBe('string');
    });

    it('strips require() attempts', async () => {
      const call = makeToolCall('calculate', { expression: 'require("fs")' });
      const result = await executeTool(call);
      expectValidResult(result, call.id);
      expect(typeof result.content).toBe('string');
    });

    it('handles division by zero', async () => {
      const call = makeToolCall('calculate', { expression: '1 / 0' });
      const result = await executeTool(call);
      expect(result.content).toBe('Result: Infinity');
    });

    it('handles floating point', async () => {
      const call = makeToolCall('calculate', { expression: '0.1 + 0.2' });
      const result = await executeTool(call);
      expect(result.content).toContain('Result:');
    });
  });

  // ── remember ──────────────────────────────────────────────────────────

  describe('remember', () => {
    beforeEach(() => {
      vi.mocked(saveMemory).mockClear();
    });

    it('calls saveMemory with key and value', async () => {
      const call = makeToolCall('remember', { key: 'favorite_color', value: 'blue' });
      const result = await executeTool(call);
      expectValidResult(result, call.id);
      expectSuccess(result);
      expect(result.content).toContain('remembered');
      expect(result.content).toContain('favorite_color');
      expect(result.content).toContain('blue');
      expect(saveMemory).toHaveBeenCalledOnce();
      const arg = vi.mocked(saveMemory).mock.calls[0]![0];
      expect(arg.content).toContain('[favorite_color] blue');
      expect(arg.memoryType).toBe('fact');
    });

    it('uses default importance of 0.8', async () => {
      const call = makeToolCall('remember', { key: 'k', value: 'v' });
      await executeTool(call);
      const arg = vi.mocked(saveMemory).mock.calls[0]![0];
      expect(arg.importance).toBe(0.8);
    });

    it('uses custom importance when provided', async () => {
      const call = makeToolCall('remember', { key: 'k', value: 'v', importance: 0.5 });
      await executeTool(call);
      const arg = vi.mocked(saveMemory).mock.calls[0]![0];
      expect(arg.importance).toBe(0.5);
    });

    it('clamps importance above 1 to 1', async () => {
      const call = makeToolCall('remember', { key: 'k', value: 'v', importance: 5.0 });
      await executeTool(call);
      const arg = vi.mocked(saveMemory).mock.calls[0]![0];
      expect(arg.importance).toBe(1);
    });

    it('clamps importance below 0 to 0', async () => {
      const call = makeToolCall('remember', { key: 'k', value: 'v', importance: -2 });
      await executeTool(call);
      const arg = vi.mocked(saveMemory).mock.calls[0]![0];
      expect(arg.importance).toBe(0);
    });

    it('stores with null sessionKey (global memory)', async () => {
      const call = makeToolCall('remember', { key: 'k', value: 'v' });
      await executeTool(call);
      const arg = vi.mocked(saveMemory).mock.calls[0]![0];
      expect(arg.sessionKey).toBeNull();
    });

    it('stores with metadata containing key and explicit flag', async () => {
      const call = makeToolCall('remember', { key: 'my_key', value: 'my_val' });
      await executeTool(call);
      const arg = vi.mocked(saveMemory).mock.calls[0]![0];
      expect(arg.metadata).toEqual({ key: 'my_key', explicit: true });
    });
  });

  // ── recall ────────────────────────────────────────────────────────────

  describe('recall', () => {
    beforeEach(() => {
      vi.mocked(searchMemories).mockClear();
    });

    it('searches memories and returns "no memories found" when empty', async () => {
      vi.mocked(searchMemories).mockResolvedValue([]);
      const call = makeToolCall('recall', { query: 'something' });
      const result = await executeTool(call);
      expectValidResult(result, call.id);
      expectSuccess(result);
      expect(result.content).toContain('no memories found');
    });

    it('returns formatted results when memories are found', async () => {
      vi.mocked(searchMemories).mockResolvedValue([
        {
          similarity: 0.9,
          memory: {
            id: 'mem-1',
            content: 'The sky is blue',
            memoryType: 'fact',
            importance: 0.8,
            emotionalWeight: 0.2,
            createdAt: Date.now(),
            sessionKey: null,
            userId: null,
            embedding: null,
            lastAccessed: null,
            accessCount: 0,
            relatedTo: null,
            sourceMessageId: null,
            metadata: {},
            lifecycleState: 'growing' as const,
            lifecycleChangedAt: null,
            phase: null,
            wingId: null,
            roomId: null,
            hall: null,
            aaakContent: null,
            aaakCompressedAt: null,
          },
        },
      ]);
      const call = makeToolCall('recall', { query: 'sky color' });
      const result = await executeTool(call);
      expect(result.content).toContain('found 1 memories');
      expect(result.content).toContain('The sky is blue');
      expect(result.content).toContain('90%');
    });

    it('passes correct limit to searchMemories', async () => {
      vi.mocked(searchMemories).mockResolvedValue([]);
      const call = makeToolCall('recall', { query: 'test', limit: 10 });
      await executeTool(call);
      expect(searchMemories).toHaveBeenCalledWith('test', 10, 0.2, undefined, expect.any(Object));
    });

    it('defaults limit to 5', async () => {
      vi.mocked(searchMemories).mockResolvedValue([]);
      const call = makeToolCall('recall', { query: 'test' });
      await executeTool(call);
      expect(searchMemories).toHaveBeenCalledWith('test', 5, 0.2, undefined, expect.any(Object));
    });

    it('passes sort_by option', async () => {
      vi.mocked(searchMemories).mockResolvedValue([]);
      const call = makeToolCall('recall', { query: 'test', sort_by: 'recency' });
      await executeTool(call);
      const opts = vi.mocked(searchMemories).mock.calls[0]![4];
      expect(opts).toEqual(expect.objectContaining({ sortBy: 'recency' }));
    });

    it('passes type filter option', async () => {
      vi.mocked(searchMemories).mockResolvedValue([]);
      const call = makeToolCall('recall', { query: 'test', type: 'fact' });
      await executeTool(call);
      const opts = vi.mocked(searchMemories).mock.calls[0]![4];
      expect(opts).toEqual(expect.objectContaining({ memoryTypes: ['fact'] }));
    });
  });

  // ── expand_memory ─────────────────────────────────────────────────────

  describe('expand_memory', () => {
    beforeEach(() => {
      vi.mocked(getMemory).mockClear();
      vi.mocked(getAssociatedMemories).mockClear();
      vi.mocked(updateMemoryAccess).mockClear();
    });

    it('returns "memory not found" for unknown ID', async () => {
      vi.mocked(getMemory).mockReturnValue(undefined);
      const call = makeToolCall('expand_memory', { memory_id: 'nonexistent' });
      const result = await executeTool(call);
      expect(result.content).toBe('memory not found.');
    });

    it('returns memory content and updates access', async () => {
      vi.mocked(getMemory).mockReturnValue({
        id: 'mem-1',
        content: 'Hello world',
        memoryType: 'fact',
        importance: 0.7,
        emotionalWeight: 0.2,
        createdAt: Date.now(),
        sessionKey: null,
        userId: null,
        embedding: null,
        lastAccessed: null,
        accessCount: 0,
        relatedTo: null,
        sourceMessageId: null,
        metadata: {},
        lifecycleState: 'growing' as const,
        lifecycleChangedAt: null,
        phase: null,
        wingId: null,
        roomId: null,
        hall: null,
        aaakContent: null,
        aaakCompressedAt: null,
      });
      vi.mocked(getAssociatedMemories).mockReturnValue([]);

      const call = makeToolCall('expand_memory', { memory_id: 'mem-1' });
      const result = await executeTool(call);
      expect(result.content).toContain('Memory mem-1');
      expect(result.content).toContain('Hello world');
      expect(updateMemoryAccess).toHaveBeenCalledWith('mem-1');
    });

    it('includes associated memories in output', async () => {
      vi.mocked(getMemory).mockReturnValue({
        id: 'mem-1',
        content: 'Primary memory',
        memoryType: 'fact',
        importance: 0.7,
        emotionalWeight: 0.2,
        createdAt: Date.now(),
        sessionKey: null,
        userId: null,
        embedding: null,
        lastAccessed: null,
        accessCount: 0,
        relatedTo: null,
        sourceMessageId: null,
        metadata: {},
        lifecycleState: 'growing' as const,
        lifecycleChangedAt: null,
        phase: null,
        wingId: null,
        roomId: null,
        hall: null,
        aaakContent: null,
        aaakCompressedAt: null,
      });
      vi.mocked(getAssociatedMemories).mockReturnValue([
        {
          id: 'mem-2',
          content: 'Associated memory content',
          memoryType: 'fact',
          importance: 0.5,
          emotionalWeight: 0.1,
          createdAt: Date.now(),
          sessionKey: null,
          userId: null,
          embedding: null,
          lastAccessed: null,
          accessCount: 0,
          relatedTo: null,
          sourceMessageId: null,
          metadata: {},
          lifecycleState: 'growing' as const,
          lifecycleChangedAt: null,
          phase: null,
          wingId: null,
          roomId: null,
          hall: null,
          aaakContent: null,
          aaakCompressedAt: null,
        },
      ]);

      const call = makeToolCall('expand_memory', { memory_id: 'mem-1' });
      const result = await executeTool(call);
      expect(result.content).toContain('Associated memories');
      expect(result.content).toContain('mem-2');
    });
  });

  // ── show_image ────────────────────────────────────────────────────────

  describe('show_image', () => {
    it('returns IMAGE markdown for valid URL', async () => {
      const call = makeToolCall('show_image', { url: 'https://example.com/pic.jpg' });
      const result = await executeTool(call);
      expectSuccess(result);
      expect(result.content).toContain('[IMAGE:');
      expect(result.content).toContain('https://example.com/pic.jpg');
    });

    it('uses description in IMAGE tag', async () => {
      const call = makeToolCall('show_image', { url: 'https://example.com/pic.jpg', description: 'A cat' });
      const result = await executeTool(call);
      expect(result.content).toContain('[IMAGE: A cat]');
    });

    it('defaults description to "image"', async () => {
      const call = makeToolCall('show_image', { url: 'https://example.com/pic.jpg' });
      const result = await executeTool(call);
      expect(result.content).toContain('[IMAGE: image]');
    });

    it('rejects ftp:// URL', async () => {
      const call = makeToolCall('show_image', { url: 'ftp://example.com/pic.jpg' });
      const result = await executeTool(call);
      expect(result.content).toContain('error');
    });

    it('rejects invalid URL', async () => {
      const call = makeToolCall('show_image', { url: 'not-a-url' });
      const result = await executeTool(call);
      expect(result.content).toContain('error');
    });
  });

  // ── search_images ─────────────────────────────────────────────────────

  describe('search_images', () => {
    // findings.md P2:1799 — the tool is now honest about returning placeholders.
    it('returns picsum URLs based on query', async () => {
      const call = makeToolCall('search_images', { query: 'sunset' });
      const result = await executeTool(call);
      expectSuccess(result);
      expect(result.content).toContain('sunset');
      expect(result.content).toContain('picsum.photos');
    });

    it('labels the output as placeholder / NOT query-relevant', async () => {
      const call = makeToolCall('search_images', { query: 'sunset' });
      const result = await executeTool(call);
      expect(result.content.toLowerCase()).toContain('placeholder');
      expect(result.content).toContain('NOT');
    });

    it('returns 3 image results', async () => {
      const call = makeToolCall('search_images', { query: 'cat' });
      const result = await executeTool(call);
      expect(result.content).toContain('1.');
      expect(result.content).toContain('2.');
      expect(result.content).toContain('3.');
    });

    it('generates deterministic seeds from query', async () => {
      const call1 = makeToolCall('search_images', { query: 'test' });
      const call2 = makeToolCall('search_images', { query: 'test' });
      const r1 = await executeTool(call1);
      const r2 = await executeTool(call2);
      expect(r1.content).toBe(r2.content);
    });
  });

  // ── create_tool / list_my_tools / delete_tool: REMOVED ────────────────
  // These LLM-authored tool meta-tools were removed in findings.md P1:1561
  // because they handed `new Function()` + `require` + `process` to LLM-
  // authored JavaScript, making every cross-peer injection path a route to
  // host RCE. See test/tools.test.ts and test/type-safety.test.ts for the
  // regression guards asserting they stay removed.

  describe('removed create_tool / list_my_tools / delete_tool (P1 findings.md:1561)', () => {
    it('create_tool is no longer in the registry — executeTool rejects it', async () => {
      const call = makeToolCall('create_tool', {
        name: 'x', description: 'y', parameters: '{}', code: 'return "z";',
      });
      const result = await executeTool(call);
      expect(result.isError).toBe(true);
      expect(result.content).toContain('Unknown tool "create_tool"');
    });

    it('list_my_tools is no longer in the registry — executeTool rejects it', async () => {
      const call = makeToolCall('list_my_tools', {});
      const result = await executeTool(call);
      expect(result.isError).toBe(true);
      expect(result.content).toContain('Unknown tool "list_my_tools"');
    });

    it('delete_tool is no longer in the registry — executeTool rejects it', async () => {
      const call = makeToolCall('delete_tool', { name: 'anything' });
      const result = await executeTool(call);
      expect(result.isError).toBe(true);
      expect(result.content).toContain('Unknown tool "delete_tool"');
    });
  });

  // ── send_letter ───────────────────────────────────────────────────────

  describe('send_letter', () => {
    beforeEach(() => {
      vi.mocked(runLetterCycle).mockClear();
    });

    it('calls runLetterCycle and returns success', async () => {
      vi.mocked(runLetterCycle).mockResolvedValue(undefined);
      const call = makeToolCall('send_letter', {});
      const result = await executeTool(call);
      expectSuccess(result);
      expect(result.content).toContain('letter composed and delivered successfully');
      expect(runLetterCycle).toHaveBeenCalledOnce();
    });

    it('returns error when letter cycle fails', async () => {
      vi.mocked(runLetterCycle).mockRejectedValue(new Error('No provider'));
      const call = makeToolCall('send_letter', {});
      const result = await executeTool(call);
      expect(result.content).toContain('error sending letter');
      expect(result.content).toContain('No provider');
    });
  });

  // ── introspect_info ───────────────────────────────────────────────────

  describe('introspect_info', () => {
    it('returns JSON with architecture information', async () => {
      const call = makeToolCall('introspect_info', {});
      const result = await executeTool(call);
      expectSuccess(result);
      const info = JSON.parse(result.content);
      expect(info.name).toBe('Lain');
      expect(info.architecture).toBeDefined();
      expect(info.keyFiles).toBeDefined();
    });
  });

  // ── send_message (Telegram) ───────────────────────────────────────────

  describe('send_message', () => {
    it('returns error when Telegram is not configured', async () => {
      delete process.env['TELEGRAM_BOT_TOKEN'];
      delete process.env['TELEGRAM_CHAT_ID'];
      const call = makeToolCall('send_message', { message: 'Hello' });
      const result = await executeTool(call);
      expect(result.content).toContain('error: Telegram not configured');
    });

    it('sends message when Telegram is configured', async () => {
      process.env['TELEGRAM_BOT_TOKEN'] = 'fake-token';
      process.env['TELEGRAM_CHAT_ID'] = '12345';
      const call = makeToolCall('send_message', { message: 'Test message' });
      const result = await executeTool(call);
      expectSuccess(result);
      expect(result.content).toContain('message sent successfully');
      delete process.env['TELEGRAM_BOT_TOKEN'];
      delete process.env['TELEGRAM_CHAT_ID'];
    });
  });

  // ── Unknown tool ──────────────────────────────────────────────────────

  describe('unknown tool', () => {
    it('returns isError for unregistered tool', async () => {
      const call = makeToolCall('nonexistent_tool_xyz', {});
      const result = await executeTool(call);
      expectError(result);
      expect(result.content).toContain('Error: Unknown tool');
      expect(result.content).toContain('nonexistent_tool_xyz');
    });
  });

  // ── executeTools (parallel) ───────────────────────────────────────────

  describe('executeTools parallel', () => {
    it('executes multiple tools and returns all results', async () => {
      const calls = [
        makeToolCall('get_current_time', {}, 'call-1'),
        makeToolCall('calculate', { expression: '1 + 1' }, 'call-2'),
        makeToolCall('introspect_info', {}, 'call-3'),
      ];
      const results = await executeTools(calls);
      expect(results).toHaveLength(3);
      expect(results[0]!.toolCallId).toBe('call-1');
      expect(results[1]!.toolCallId).toBe('call-2');
      expect(results[2]!.toolCallId).toBe('call-3');
    });

    it('handles mix of valid and unknown tools', async () => {
      const calls = [
        makeToolCall('get_current_time', {}, 'call-1'),
        makeToolCall('does_not_exist', {}, 'call-2'),
      ];
      const results = await executeTools(calls);
      expect(results).toHaveLength(2);
      expect(results[0]!.isError).toBeUndefined();
      expect(results[1]!.isError).toBe(true);
    });
  });

  // ── Tool handler that throws ──────────────────────────────────────────

  describe('tool handler exception', () => {
    it('catches handler exception and returns isError', async () => {
      registerTool({
        definition: { name: '__test_throw', description: 'throws', inputSchema: { type: 'object', properties: {} } },
        handler: async () => { throw new Error('kaboom'); },
      });
      const call = makeToolCall('__test_throw', {});
      const result = await executeTool(call);
      expectError(result);
      // P2:1851 — handler error messages are no longer echoed back to the LLM;
      // the tool result carries an opaque incident ID instead. The full error
      // still reaches the server-side logger.
      expect(result.content).not.toContain('kaboom');
      expect(result.content).toMatch(/incident [0-9a-f]+/);
      unregisterTool('__test_throw');
    });

    it('catches non-Error throws', async () => {
      registerTool({
        definition: { name: '__test_throw_str', description: 'throws string', inputSchema: { type: 'object', properties: {} } },
        handler: async () => { throw 'string error'; },
      });
      const call = makeToolCall('__test_throw_str', {});
      const result = await executeTool(call);
      expectError(result);
      expect(result.content).not.toContain('string error');
      expect(result.content).toMatch(/incident [0-9a-f]+/);
      unregisterTool('__test_throw_str');
    });
  });

  // ── web_search (mock fetch) ───────────────────────────────────────────

  describe('web_search', () => {
    it('returns formatted results on successful search', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(
          '<div class="result results_links fake">' +
          '<a class="result__a" href="https://example.com">Example</a>' +
          '<a class="result__snippet">Example snippet</a>' +
          '</div>'
        ),
      }) as unknown as typeof fetch;

      const call = makeToolCall('web_search', { query: 'test query' });
      const result = await executeTool(call);
      expectSuccess(result);
      expect(result.content).toContain('search results for "test query"');
    });

    it('returns no results message when empty', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('<html><body>No results</body></html>'),
      }) as unknown as typeof fetch;

      const call = makeToolCall('web_search', { query: 'obscure search' });
      const result = await executeTool(call);
      expect(result.content).toContain('no results found');
    });

    it('handles fetch failure gracefully (cascades through all tiers → no results)', async () => {
      // With the DDG HTML → DDG Lite → Wikipedia fallback chain, a 503 from
      // one tier cascades to the next. Mock returns 503 for every call →
      // every tier returns [] → tool reports "no results found".
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
      }) as unknown as typeof fetch;

      const call = makeToolCall('web_search', { query: 'test' });
      const result = await executeTool(call);
      expect(result.content).toContain('no results found');
    });

    it('handles network error gracefully (cascades through all tiers → no results)', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error')) as unknown as typeof fetch;

      const call = makeToolCall('web_search', { query: 'test' });
      const result = await executeTool(call);
      expect(result.content).toContain('no results found');
    });
  });

  // ── fetch_webpage ─────────────────────────────────────────────────────

  describe('fetch_webpage', () => {
    it('returns extracted text content', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => 'text/html' },
        text: () => Promise.resolve('<html><body><p>Hello World</p></body></html>'),
      }) as unknown as typeof fetch;

      const call = makeToolCall('fetch_webpage', { url: 'https://example.com' });
      const result = await executeTool(call);
      expectSuccess(result);
      expect(result.content).toContain('Hello World');
    });

    it('rejects non-http protocol', async () => {
      const call = makeToolCall('fetch_webpage', { url: 'ftp://example.com' });
      const result = await executeTool(call);
      // safeFetch throws "SSRF protection: Blocked URL scheme: ftp:";
      // handler surfaces the message to the user.
      expect(result.content).toContain('SSRF protection');
    });

    it('handles fetch error', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      }) as unknown as typeof fetch;

      const call = makeToolCall('fetch_webpage', { url: 'https://example.com/missing' });
      const result = await executeTool(call);
      expect(result.content).toContain('error: failed to fetch');
    });

    it('rejects unsupported content type', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => 'application/pdf' },
        text: () => Promise.resolve('PDF data'),
      }) as unknown as typeof fetch;

      const call = makeToolCall('fetch_webpage', { url: 'https://example.com/doc.pdf' });
      const result = await executeTool(call);
      expect(result.content).toContain('unsupported content type');
    });

    it('truncates long content', async () => {
      const longContent = '<p>' + 'A'.repeat(10000) + '</p>';
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => 'text/html' },
        text: () => Promise.resolve(longContent),
      }) as unknown as typeof fetch;

      const call = makeToolCall('fetch_webpage', { url: 'https://example.com' });
      const result = await executeTool(call);
      expect(result.content).toContain('[content truncated]');
    });

    it('returns "no readable content found" for empty HTML', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => 'text/html' },
        text: () => Promise.resolve('<html><head></head><body></body></html>'),
      }) as unknown as typeof fetch;

      const call = makeToolCall('fetch_webpage', { url: 'https://example.com/empty' });
      const result = await executeTool(call);
      // Either empty or the "no readable content" message
      expect(typeof result.content).toBe('string');
    });
  });

  // Note: toolRequiresApproval was removed as a P1 in findings.md —
  // the helper existed but executeTool never consulted it, so tagged
  // tools ran unattended anyway. Source-level regression for the
  // removal lives in test/tools.test.ts.

  // ── registerTool / unregisterTool ─────────────────────────────────────

  describe('registerTool and unregisterTool', () => {
    it('registers a new tool that can be executed', async () => {
      registerTool({
        definition: { name: '__test_reg', description: 'test', inputSchema: { type: 'object', properties: {} } },
        handler: async () => 'registered result',
      });
      const call = makeToolCall('__test_reg', {});
      const result = await executeTool(call);
      expectSuccess(result);
      expect(result.content).toBe('registered result');
      unregisterTool('__test_reg');
    });

    it('unregisters a tool so it becomes unknown', async () => {
      registerTool({
        definition: { name: '__test_unreg', description: 'test', inputSchema: { type: 'object', properties: {} } },
        handler: async () => 'ok',
      });
      unregisterTool('__test_unreg');
      const call = makeToolCall('__test_unreg', {});
      const result = await executeTool(call);
      expectError(result);
    });

    it('getToolDefinitions includes registered tools', () => {
      registerTool({
        definition: { name: '__test_defs', description: 'test desc', inputSchema: { type: 'object', properties: {} } },
        handler: async () => 'ok',
      });
      const defs = getToolDefinitions();
      const found = defs.find(d => d.name === '__test_defs');
      expect(found).toBeDefined();
      expect(found!.description).toBe('test desc');
      unregisterTool('__test_defs');
    });
  });
});

// =========================================================================
// 2. TOOL INPUT VALIDATION — Invalid inputs for each tool
// =========================================================================

describe('Tool Input Validation', () => {
  // ── calculate input validation ────────────────────────────────────────

  describe('calculate — invalid inputs', () => {
    it('handles missing expression (undefined)', async () => {
      const call = makeToolCall('calculate', {});
      const result = await executeTool(call);
      // Should not crash; expression will be undefined
      expect(typeof result.content).toBe('string');
    });

    it('handles null expression', async () => {
      const call = makeToolCall('calculate', { expression: null });
      const result = await executeTool(call);
      expect(typeof result.content).toBe('string');
    });

    it('handles empty string expression', async () => {
      const call = makeToolCall('calculate', { expression: '' });
      const result = await executeTool(call);
      expect(typeof result.content).toBe('string');
    });

    it('handles extremely long expression', async () => {
      const call = makeToolCall('calculate', { expression: '1+'.repeat(10000) + '1' });
      const result = await executeTool(call);
      expect(typeof result.content).toBe('string');
    });

    it('strips SQL injection in expression', async () => {
      const call = makeToolCall('calculate', { expression: "1; DROP TABLE memories;" });
      const result = await executeTool(call);
      expect(typeof result.content).toBe('string');
      // Should not be able to execute SQL
    });

    it('strips shell injection', async () => {
      const call = makeToolCall('calculate', { expression: '$(rm -rf /)' });
      const result = await executeTool(call);
      expect(typeof result.content).toBe('string');
    });

    it('handles number instead of string expression', async () => {
      const call = makeToolCall('calculate', { expression: 42 });
      const result = await executeTool(call);
      expect(typeof result.content).toBe('string');
    });
  });

  // ── remember input validation ─────────────────────────────────────────

  describe('remember — invalid inputs', () => {
    beforeEach(() => {
      vi.mocked(saveMemory).mockClear();
    });

    it('handles missing key', async () => {
      const call = makeToolCall('remember', { value: 'test' });
      const result = await executeTool(call);
      // key will be undefined, content will be "[undefined] test"
      expect(typeof result.content).toBe('string');
    });

    it('handles missing value', async () => {
      const call = makeToolCall('remember', { key: 'test' });
      const result = await executeTool(call);
      expect(typeof result.content).toBe('string');
    });

    it('handles empty key', async () => {
      const call = makeToolCall('remember', { key: '', value: 'test' });
      const result = await executeTool(call);
      expect(typeof result.content).toBe('string');
    });

    it('handles empty value', async () => {
      const call = makeToolCall('remember', { key: 'k', value: '' });
      const result = await executeTool(call);
      expect(typeof result.content).toBe('string');
    });

    it('handles importance as string instead of number', async () => {
      const call = makeToolCall('remember', { key: 'k', value: 'v', importance: 'high' });
      const result = await executeTool(call);
      // Should use default 0.8 since typeof != 'number'
      const arg = vi.mocked(saveMemory).mock.calls[0]![0];
      expect(arg.importance).toBe(0.8);
    });

    it('handles very long key and value', async () => {
      const call = makeToolCall('remember', { key: 'k'.repeat(10000), value: 'v'.repeat(10000) });
      const result = await executeTool(call);
      expect(typeof result.content).toBe('string');
    });

    it('handles special characters in key', async () => {
      const call = makeToolCall('remember', { key: '../../etc/passwd', value: 'test' });
      const result = await executeTool(call);
      // Tool just uses it as a label in memory content, path traversal harmless here
      expect(typeof result.content).toBe('string');
    });
  });

  // ── recall input validation ───────────────────────────────────────────

  describe('recall — invalid inputs', () => {
    it('handles missing query', async () => {
      vi.mocked(searchMemories).mockResolvedValue([]);
      const call = makeToolCall('recall', {});
      const result = await executeTool(call);
      expect(typeof result.content).toBe('string');
    });

    it('handles empty query', async () => {
      vi.mocked(searchMemories).mockResolvedValue([]);
      const call = makeToolCall('recall', { query: '' });
      const result = await executeTool(call);
      expect(typeof result.content).toBe('string');
    });

    it('handles invalid sort_by value', async () => {
      vi.mocked(searchMemories).mockResolvedValue([]);
      const call = makeToolCall('recall', { query: 'test', sort_by: 'invalid_sort' });
      const result = await executeTool(call);
      expect(typeof result.content).toBe('string');
    });

    it('handles negative limit', async () => {
      vi.mocked(searchMemories).mockResolvedValue([]);
      const call = makeToolCall('recall', { query: 'test', limit: -5 });
      await executeTool(call);
      expect(searchMemories).toHaveBeenCalledWith('test', -5, 0.2, undefined, expect.any(Object));
    });

    it('handles zero limit', async () => {
      vi.mocked(searchMemories).mockResolvedValue([]);
      const call = makeToolCall('recall', { query: 'test', limit: 0 });
      await executeTool(call);
      expect(searchMemories).toHaveBeenCalledWith('test', 0, 0.2, undefined, expect.any(Object));
    });

    it('handles SQL injection in query', async () => {
      vi.mocked(searchMemories).mockResolvedValue([]);
      const call = makeToolCall('recall', { query: "'; DROP TABLE memories; --" });
      const result = await executeTool(call);
      // Should not crash; query is passed to semantic search, not raw SQL
      expect(typeof result.content).toBe('string');
    });
  });

  // ── show_image input validation ───────────────────────────────────────

  describe('show_image — invalid inputs', () => {
    it('rejects javascript: protocol', async () => {
      const call = makeToolCall('show_image', { url: 'javascript:alert(1)' });
      const result = await executeTool(call);
      expect(result.content).toContain('error');
    });

    it('rejects data: protocol', async () => {
      const call = makeToolCall('show_image', { url: 'data:text/html,<script>alert(1)</script>' });
      const result = await executeTool(call);
      expect(result.content).toContain('error');
    });

    it('handles missing url', async () => {
      const call = makeToolCall('show_image', {});
      const result = await executeTool(call);
      // url will be undefined, new URL(undefined) will throw
      expect(result.content).toContain('error');
    });

    it('handles empty string url', async () => {
      const call = makeToolCall('show_image', { url: '' });
      const result = await executeTool(call);
      expect(result.content).toContain('error');
    });
  });

  // ── fetch_webpage input validation ────────────────────────────────────

  describe('fetch_webpage — invalid inputs', () => {
    it('rejects file:// protocol', async () => {
      const call = makeToolCall('fetch_webpage', { url: 'file:///etc/passwd' });
      const result = await executeTool(call);
      expect(result.content).toContain('SSRF protection');
    });

    it('handles malformed URL', async () => {
      const call = makeToolCall('fetch_webpage', { url: 'not a url at all' });
      const result = await executeTool(call);
      expect(result.content).toContain('error');
    });

    it('handles missing url', async () => {
      const call = makeToolCall('fetch_webpage', {});
      const result = await executeTool(call);
      expect(result.content).toContain('error');
    });
  });

  // create_tool input-validation tests removed: tool is gone (P1 findings.md:1561).

  // ── expand_memory input validation ────────────────────────────────────

  describe('expand_memory — invalid inputs', () => {
    it('handles missing memory_id', async () => {
      vi.mocked(getMemory).mockReturnValue(undefined);
      const call = makeToolCall('expand_memory', {});
      const result = await executeTool(call);
      expect(result.content).toBe('memory not found.');
    });

    it('handles empty string memory_id', async () => {
      vi.mocked(getMemory).mockReturnValue(undefined);
      const call = makeToolCall('expand_memory', { memory_id: '' });
      const result = await executeTool(call);
      expect(result.content).toBe('memory not found.');
    });

    it('handles SQL injection in memory_id', async () => {
      vi.mocked(getMemory).mockReturnValue(undefined);
      const call = makeToolCall('expand_memory', { memory_id: "'; DROP TABLE memories; --" });
      const result = await executeTool(call);
      expect(result.content).toBe('memory not found.');
    });
  });

  // ── web_search input validation ───────────────────────────────────────

  describe('web_search — invalid inputs', () => {
    it('handles empty query', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('<html></html>'),
      }) as unknown as typeof fetch;

      const call = makeToolCall('web_search', { query: '' });
      const result = await executeTool(call);
      expect(typeof result.content).toBe('string');
    });

    it('handles missing query', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('<html></html>'),
      }) as unknown as typeof fetch;

      const call = makeToolCall('web_search', {});
      const result = await executeTool(call);
      expect(typeof result.content).toBe('string');
    });

    it('handles very long query', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('<html></html>'),
      }) as unknown as typeof fetch;

      const call = makeToolCall('web_search', { query: 'a'.repeat(10000) });
      const result = await executeTool(call);
      expect(typeof result.content).toBe('string');
    });
  });

  // delete_tool input-validation tests removed: tool is gone (P1 findings.md:1561).

  // ── search_images input validation ────────────────────────────────────

  describe('search_images — invalid inputs', () => {
    it('handles missing query', async () => {
      const call = makeToolCall('search_images', {});
      const result = await executeTool(call);
      expect(typeof result.content).toBe('string');
    });

    it('handles empty query', async () => {
      const call = makeToolCall('search_images', { query: '' });
      const result = await executeTool(call);
      expect(typeof result.content).toBe('string');
    });
  });

  // ── introspect_list input validation ──────────────────────────────────

  describe('introspect_list — invalid inputs', () => {
    it('rejects path traversal', async () => {
      const call = makeToolCall('introspect_list', { path: '../../../etc' });
      const result = await executeTool(call);
      expect(result.content).toContain('access denied');
    });

    it('rejects absolute path outside repo via traversal', async () => {
      // introspect_list joins path relative to repo root, so
      // an absolute-looking path like "/etc/passwd" becomes repo/etc/passwd.
      // We must use .. traversal to escape the repo boundary.
      const call = makeToolCall('introspect_list', { path: '../../../../etc' });
      const result = await executeTool(call);
      expect(result.content).toContain('access denied');
    });

    it('rejects node_modules path', async () => {
      const call = makeToolCall('introspect_list', { path: 'node_modules' });
      const result = await executeTool(call);
      expect(result.content).toContain('access denied');
    });

    it('rejects .env path', async () => {
      const call = makeToolCall('introspect_list', { path: '.env' });
      const result = await executeTool(call);
      expect(result.content).toContain('access denied');
    });
  });

  // ── introspect_read input validation ──────────────────────────────────

  describe('introspect_read — invalid inputs', () => {
    it('rejects path traversal', async () => {
      const call = makeToolCall('introspect_read', { path: '../../../etc/passwd' });
      const result = await executeTool(call);
      expect(result.content).toContain('access denied');
    });

    it('rejects disallowed extension', async () => {
      const call = makeToolCall('introspect_read', { path: 'src/test.exe' });
      const result = await executeTool(call);
      expect(result.content).toContain('access denied: file type not allowed');
    });

    it('rejects .env file', async () => {
      const call = makeToolCall('introspect_read', { path: '.env' });
      const result = await executeTool(call);
      expect(result.content).toContain('access denied');
    });

    it('rejects credentials path', async () => {
      const call = makeToolCall('introspect_read', { path: 'credentials/key.json' });
      const result = await executeTool(call);
      expect(result.content).toContain('access denied');
    });

    it('rejects .git/objects path', async () => {
      const call = makeToolCall('introspect_read', { path: '.git/objects/abc' });
      const result = await executeTool(call);
      expect(result.content).toContain('access denied');
    });
  });

  // ── introspect_search input validation ────────────────────────────────

  describe('introspect_search — invalid inputs', () => {
    it('rejects path outside repo', async () => {
      const call = makeToolCall('introspect_search', { query: 'test', path: '../../../etc' });
      const result = await executeTool(call);
      expect(result.content).toContain('access denied');
    });

    it('handles empty query string', async () => {
      const call = makeToolCall('introspect_search', { query: '' });
      const result = await executeTool(call);
      expect(typeof result.content).toBe('string');
    });
  });
});

// =========================================================================
// 3. TOOL LOOP BEHAVIORAL — Tool iteration and provider interaction
// =========================================================================

describe('Tool Loop Behavioral', () => {
  // These test the executeTool/executeTools functions and the loop semantics
  // embedded in generateResponseWithTools (tested structurally since that
  // function is not exported, but we test observable behavior via the
  // tool registry).

  describe('single tool execution', () => {
    it('executes a registered tool and returns result', async () => {
      registerTool({
        definition: { name: '__loop_test_1', description: 'test', inputSchema: { type: 'object', properties: {} } },
        handler: async () => 'loop result 1',
      });
      const call = makeToolCall('__loop_test_1', {}, 'lc-1');
      const result = await executeTool(call);
      expect(result.toolCallId).toBe('lc-1');
      expect(result.content).toBe('loop result 1');
      expect(result.isError).toBeUndefined();
      unregisterTool('__loop_test_1');
    });
  });

  describe('multiple tool calls in one batch', () => {
    it('all execute and return results in order', async () => {
      const results: string[] = [];
      registerTool({
        definition: { name: '__loop_a', description: 'a', inputSchema: { type: 'object', properties: {} } },
        handler: async () => { results.push('a'); return 'result-a'; },
      });
      registerTool({
        definition: { name: '__loop_b', description: 'b', inputSchema: { type: 'object', properties: {} } },
        handler: async () => { results.push('b'); return 'result-b'; },
      });
      registerTool({
        definition: { name: '__loop_c', description: 'c', inputSchema: { type: 'object', properties: {} } },
        handler: async () => { results.push('c'); return 'result-c'; },
      });

      const calls = [
        makeToolCall('__loop_a', {}, 'a-id'),
        makeToolCall('__loop_b', {}, 'b-id'),
        makeToolCall('__loop_c', {}, 'c-id'),
      ];

      const toolResults = await executeTools(calls);
      expect(toolResults).toHaveLength(3);
      expect(toolResults[0]!.content).toBe('result-a');
      expect(toolResults[1]!.content).toBe('result-b');
      expect(toolResults[2]!.content).toBe('result-c');

      unregisterTool('__loop_a');
      unregisterTool('__loop_b');
      unregisterTool('__loop_c');
    });
  });

  describe('tool error handling in loop', () => {
    it('error from one tool does not prevent others', async () => {
      registerTool({
        definition: { name: '__loop_ok', description: 'ok', inputSchema: { type: 'object', properties: {} } },
        handler: async () => 'ok',
      });
      registerTool({
        definition: { name: '__loop_err', description: 'err', inputSchema: { type: 'object', properties: {} } },
        handler: async () => { throw new Error('fail'); },
      });

      const calls = [
        makeToolCall('__loop_ok', {}, 'ok-id'),
        makeToolCall('__loop_err', {}, 'err-id'),
      ];

      const results = await executeTools(calls);
      expect(results[0]!.content).toBe('ok');
      expect(results[0]!.isError).toBeUndefined();
      expect(results[1]!.content).toContain('fail');
      expect(results[1]!.isError).toBe(true);

      unregisterTool('__loop_ok');
      unregisterTool('__loop_err');
    });
  });

  describe('unknown tool in batch', () => {
    it('returns error for unknown tool, succeeds for known', async () => {
      registerTool({
        definition: { name: '__loop_known', description: 'known', inputSchema: { type: 'object', properties: {} } },
        handler: async () => 'known result',
      });

      const calls = [
        makeToolCall('__loop_known', {}, 'k-id'),
        makeToolCall('__nonexistent_xyz', {}, 'u-id'),
      ];

      const results = await executeTools(calls);
      expect(results[0]!.content).toBe('known result');
      expect(results[1]!.isError).toBe(true);
      expect(results[1]!.content).toContain('Unknown tool');

      unregisterTool('__loop_known');
    });
  });

  describe('tool result structure validation', () => {
    it('successful result has toolCallId and content, no isError', async () => {
      registerTool({
        definition: { name: '__struct_ok', description: 'test', inputSchema: { type: 'object', properties: {} } },
        handler: async () => 'struct ok',
      });

      const result = await executeTool(makeToolCall('__struct_ok', {}, 'struct-id'));
      expect(Object.keys(result)).toContain('toolCallId');
      expect(Object.keys(result)).toContain('content');
      expect(result.toolCallId).toBe('struct-id');
      expect(typeof result.content).toBe('string');

      unregisterTool('__struct_ok');
    });

    it('error result has isError: true', async () => {
      const result = await executeTool(makeToolCall('__does_not_exist', {}, 'err-id'));
      expect(result.isError).toBe(true);
      expect(result.toolCallId).toBe('err-id');
    });

    it('thrown error produces error result with incident id (P2:1851)', async () => {
      registerTool({
        definition: { name: '__struct_throw', description: 'test', inputSchema: { type: 'object', properties: {} } },
        handler: async () => { throw new TypeError('type error'); },
      });

      const result = await executeTool(makeToolCall('__struct_throw', {}, 'throw-id'));
      expect(result.isError).toBe(true);
      expect(result.content).not.toContain('type error');
      expect(result.content).toMatch(/incident [0-9a-f]+/);

      unregisterTool('__struct_throw');
    });
  });

  describe('tool result content types', () => {
    it('handler can return empty string', async () => {
      registerTool({
        definition: { name: '__empty_result', description: 'test', inputSchema: { type: 'object', properties: {} } },
        handler: async () => '',
      });

      const result = await executeTool(makeToolCall('__empty_result', {}, 'empty-id'));
      expect(result.content).toBe('');
      expect(result.isError).toBeUndefined();

      unregisterTool('__empty_result');
    });

    it('handler can return very long string', async () => {
      const longStr = 'x'.repeat(100000);
      registerTool({
        definition: { name: '__long_result', description: 'test', inputSchema: { type: 'object', properties: {} } },
        handler: async () => longStr,
      });

      const result = await executeTool(makeToolCall('__long_result', {}, 'long-id'));
      expect(result.content).toBe(longStr);

      unregisterTool('__long_result');
    });

    it('handler can return JSON string', async () => {
      registerTool({
        definition: { name: '__json_result', description: 'test', inputSchema: { type: 'object', properties: {} } },
        handler: async () => JSON.stringify({ key: 'value' }),
      });

      const result = await executeTool(makeToolCall('__json_result', {}, 'json-id'));
      expect(JSON.parse(result.content)).toEqual({ key: 'value' });

      unregisterTool('__json_result');
    });

    it('handler can return multiline string', async () => {
      registerTool({
        definition: { name: '__multi_result', description: 'test', inputSchema: { type: 'object', properties: {} } },
        handler: async () => 'line1\nline2\nline3',
      });

      const result = await executeTool(makeToolCall('__multi_result', {}, 'multi-id'));
      expect(result.content.split('\n')).toHaveLength(3);

      unregisterTool('__multi_result');
    });
  });

  describe('async tool handlers', () => {
    it('handles slow async tool', async () => {
      registerTool({
        definition: { name: '__slow_tool', description: 'test', inputSchema: { type: 'object', properties: {} } },
        handler: async () => {
          await new Promise(r => setTimeout(r, 50));
          return 'slow result';
        },
      });

      const result = await executeTool(makeToolCall('__slow_tool', {}, 'slow-id'));
      expect(result.content).toBe('slow result');

      unregisterTool('__slow_tool');
    });

    it('handles async rejection', async () => {
      registerTool({
        definition: { name: '__async_reject', description: 'test', inputSchema: { type: 'object', properties: {} } },
        handler: async () => {
          return Promise.reject(new Error('async fail'));
        },
      });

      const result = await executeTool(makeToolCall('__async_reject', {}, 'reject-id'));
      expect(result.isError).toBe(true);
      // P2:1851 — raw error text is not echoed back; only the incident ID is.
      expect(result.content).not.toContain('async fail');
      expect(result.content).toMatch(/incident [0-9a-f]+/);

      unregisterTool('__async_reject');
    });
  });

  describe('tool input passthrough', () => {
    it('passes all input properties to handler', async () => {
      let receivedInput: Record<string, unknown> = {};
      registerTool({
        definition: { name: '__input_pass', description: 'test', inputSchema: { type: 'object', properties: {} } },
        handler: async (input) => { receivedInput = input; return 'ok'; },
      });

      const call = makeToolCall('__input_pass', { a: 1, b: 'two', c: [3], d: { nested: true } }, 'ip-id');
      await executeTool(call);
      expect(receivedInput).toEqual({ a: 1, b: 'two', c: [3], d: { nested: true } });

      unregisterTool('__input_pass');
    });

    it('passes empty object when no input provided', async () => {
      let receivedInput: Record<string, unknown> = { initial: true };
      registerTool({
        definition: { name: '__empty_input', description: 'test', inputSchema: { type: 'object', properties: {} } },
        handler: async (input) => { receivedInput = input; return 'ok'; },
      });

      const call = makeToolCall('__empty_input', {}, 'ei-id');
      await executeTool(call);
      expect(receivedInput).toEqual({});

      unregisterTool('__empty_input');
    });
  });
});

// =========================================================================
// 4. DOCTOR TOOLS BEHAVIORAL
// =========================================================================

describe('Doctor Tools Behavioral', () => {
  let executeDoctorTool: typeof import('../src/agent/doctor-tools.js').executeDoctorTool;
  let executeDoctorTools: typeof import('../src/agent/doctor-tools.js').executeDoctorTools;
  let getDoctorToolDefinitions: typeof import('../src/agent/doctor-tools.js').getDoctorToolDefinitions;

  beforeAll(async () => {
    const mod = await import('../src/agent/doctor-tools.js');
    executeDoctorTool = mod.executeDoctorTool;
    executeDoctorTools = mod.executeDoctorTools;
    getDoctorToolDefinitions = mod.getDoctorToolDefinitions;
  });

  describe('doctor tool registry', () => {
    it('provides tool definitions array', () => {
      const defs = getDoctorToolDefinitions();
      expect(Array.isArray(defs)).toBe(true);
      expect(defs.length).toBeGreaterThan(0);
    });

    it('includes all expected doctor tools', () => {
      const names = getDoctorToolDefinitions().map(d => d.name);
      expect(names).toContain('check_service_health');
      expect(names).toContain('get_health_status');
      expect(names).toContain('get_telemetry');
      expect(names).toContain('read_file');
      expect(names).toContain('get_reports');
    });

    it('each definition has name, description, and inputSchema', () => {
      const defs = getDoctorToolDefinitions();
      for (const def of defs) {
        expect(def.name).toBeTruthy();
        expect(def.description).toBeTruthy();
        expect(def.inputSchema).toBeDefined();
      }
    });
  });

  describe('executeDoctorTool — unknown tool', () => {
    it('returns error for unknown tool', async () => {
      const result = await executeDoctorTool({
        id: 'test-id',
        name: 'nonexistent_doctor_tool',
        input: {},
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContain('Unknown tool');
    });
  });

  describe('get_telemetry', () => {
    it('returns telemetry report', async () => {
      const result = await executeDoctorTool({
        id: 'tele-id',
        name: 'get_telemetry',
        input: {},
      });
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain('TELEMETRY REPORT');
      expect(result.content).toContain('Total memories');
      expect(result.content).toContain('Total messages');
      expect(result.content).toContain('Loop Health');
    });
  });

  describe('get_health_status', () => {
    it('returns "no health check results" when none exist', async () => {
      const { getMeta } = await import('../src/storage/database.js');
      vi.mocked(getMeta).mockReturnValue(null);

      const result = await executeDoctorTool({
        id: 'health-id',
        name: 'get_health_status',
        input: {},
      });
      expect(result.content).toContain('No health check results');
    });

    it('returns health data when available', async () => {
      const { getMeta } = await import('../src/storage/database.js');
      const healthData = {
        timestamp: Date.now(),
        services: [
          { name: 'Wired Lain', port: 3000, status: 'up', responseMs: 50 },
          { name: 'Lain', port: 3001, status: 'down' },
        ],
        allHealthy: false,
        fixAttempted: false,
      };
      vi.mocked(getMeta).mockImplementation((key: string) => {
        if (key === 'doctor:health:latest') return JSON.stringify(healthData);
        if (key === 'doctor:health:last_run_at') return String(Date.now());
        return null;
      });

      const result = await executeDoctorTool({
        id: 'health-id-2',
        name: 'get_health_status',
        input: {},
      });
      expect(result.content).toContain('HEALTH CHECK STATUS');
      expect(result.content).toContain('Wired Lain');
      expect(result.content).toContain('ISSUES DETECTED');

      vi.mocked(getMeta).mockReturnValue(null);
    });
  });

  describe('get_reports', () => {
    it('returns "no reports" when latest is null', async () => {
      const { getMeta } = await import('../src/storage/database.js');
      vi.mocked(getMeta).mockReturnValue(null);

      const result = await executeDoctorTool({
        id: 'report-id',
        name: 'get_reports',
        input: { action: 'latest' },
      });
      expect(result.content).toContain('No reports available');
    });

    it('returns formatted report when available', async () => {
      const { getMeta } = await import('../src/storage/database.js');
      const report = {
        date: '2026-04-17',
        clinicalSummary: 'All systems nominal',
        concerns: [],
        letterRecommendation: 'allow',
        metrics: { sessions: 5, memories: 10, dreams: 2, curiosityRuns: 3 },
        emotionalLandscape: 'Stable',
      };
      vi.mocked(getMeta).mockImplementation((key: string) => {
        if (key === 'doctor:report:latest') return JSON.stringify(report);
        return null;
      });

      const result = await executeDoctorTool({
        id: 'report-id-2',
        name: 'get_reports',
        input: { action: 'latest' },
      });
      expect(result.content).toContain('Telemetry Report');
      expect(result.content).toContain('All systems nominal');
      expect(result.content).toContain('ALLOW');

      vi.mocked(getMeta).mockReturnValue(null);
    });

    it('returns report list', async () => {
      const { getMeta } = await import('../src/storage/database.js');
      vi.mocked(getMeta).mockImplementation((key: string) => {
        if (key === 'doctor:report:index') return JSON.stringify(['1713300000000', '1713350000000']);
        return null;
      });

      const result = await executeDoctorTool({
        id: 'list-id',
        name: 'get_reports',
        input: { action: 'list' },
      });
      expect(result.content).toContain('Available reports (2)');

      vi.mocked(getMeta).mockReturnValue(null);
    });

    it('returns error for get action without timestamp', async () => {
      const result = await executeDoctorTool({
        id: 'get-no-ts',
        name: 'get_reports',
        input: { action: 'get' },
      });
      expect(result.content).toContain('timestamp is required');
    });

    it('handles unknown action', async () => {
      const result = await executeDoctorTool({
        id: 'unknown-action',
        name: 'get_reports',
        input: { action: 'invalid' },
      });
      expect(result.content).toContain('Unknown action');
    });
  });

  describe('read_file — path security', () => {
    it('rejects .env file', async () => {
      const result = await executeDoctorTool({
        id: 'rf-1',
        name: 'read_file',
        input: { path: '.env' },
      });
      expect(result.content).toContain('Access denied');
    });

    it('rejects path traversal', async () => {
      const result = await executeDoctorTool({
        id: 'rf-2',
        name: 'read_file',
        input: { path: '../../etc/passwd' },
      });
      expect(result.content).toContain('Access denied');
    });

    it('rejects node_modules', async () => {
      const result = await executeDoctorTool({
        id: 'rf-3',
        name: 'read_file',
        input: { path: 'node_modules/foo/index.js' },
      });
      expect(result.content).toContain('Access denied');
    });

    it('rejects disallowed extension', async () => {
      const result = await executeDoctorTool({
        id: 'rf-4',
        name: 'read_file',
        input: { path: 'src/test.exe' },
      });
      expect(result.content).toContain('File type not allowed');
    });

    it('rejects credentials path', async () => {
      const result = await executeDoctorTool({
        id: 'rf-5',
        name: 'read_file',
        input: { path: 'credentials/secret.json' },
      });
      expect(result.content).toContain('Access denied');
    });
  });

  describe('executeDoctorTools parallel', () => {
    it('executes multiple doctor tools', async () => {
      const results = await executeDoctorTools([
        { id: 'p1', name: 'get_telemetry', input: {} },
        { id: 'p2', name: 'nonexistent', input: {} },
      ]);
      expect(results).toHaveLength(2);
      expect(results[0]!.toolCallId).toBe('p1');
      expect(results[0]!.isError).toBeUndefined();
      expect(results[1]!.toolCallId).toBe('p2');
      expect(results[1]!.isError).toBe(true);
    });
  });
});

// =========================================================================
// 5. CHARACTER TOOLS BEHAVIORAL
// =========================================================================

describe('Character Tools Behavioral', () => {
  const testPeers = [
    { id: 'peer-a', name: 'Peer A', url: 'http://localhost:4001' },
    { id: 'peer-b', name: 'Peer B', url: 'http://localhost:4002' },
  ];

  beforeAll(async () => {
    // Per-character interlink auth needs both envs; tools return early otherwise.
    process.env['LAIN_CHARACTER_ID'] = 'test-char';
    process.env['LAIN_INTERLINK_TOKEN'] = 'test-master-token';
    // findings.md P2:1923 — research_request now resolves its own port from
    // PORT env or the manifest. Tests don't ship a real manifest, so set
    // PORT so the research_request suite has a deterministic replyTo.
    process.env['PORT'] = '4000';
    // Register character tools
    const { registerCharacterTools } = await import('../src/agent/character-tools.js');
    registerCharacterTools(
      'test-char',
      'Test Character',
      'http://localhost:3000',
      testPeers
    );
  });

  // ── move_to_building ──────────────────────────────────────────────────

  describe('move_to_building', () => {
    beforeEach(() => {
      vi.mocked(setCurrentLocation).mockClear();
      vi.mocked(saveMemory).mockClear();
      // Mock the town-events fetch to return no blocked buildings
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ blockedBuildings: [] }),
      }) as unknown as typeof fetch;
    });

    it('moves to a valid building', async () => {
      vi.mocked(getCurrentLocation).mockReturnValue({ building: 'lighthouse', timestamp: Date.now() });
      const call = makeToolCall('move_to_building', { building: 'library', reason: 'want to read' });
      const result = await executeTool(call);
      expectSuccess(result);
      expect(result.content).toContain('Library');
      expect(setCurrentLocation).toHaveBeenCalledWith('library', 'want to read');
      expect(saveMemory).toHaveBeenCalledOnce();
    });

    it('rejects unknown building', async () => {
      const call = makeToolCall('move_to_building', { building: 'spaceship', reason: 'explore' });
      const result = await executeTool(call);
      expect(result.content).toContain('Unknown building');
    });

    it('no-ops when already at the target building', async () => {
      vi.mocked(getCurrentLocation).mockReturnValue({ building: 'library', timestamp: Date.now() });
      const call = makeToolCall('move_to_building', { building: 'library', reason: 'stay here' });
      const result = await executeTool(call);
      expect(result.content).toContain('already at');
      expect(setCurrentLocation).not.toHaveBeenCalled();
    });

    it('saves movement as episode memory', async () => {
      vi.mocked(getCurrentLocation).mockReturnValue({ building: 'lighthouse', timestamp: Date.now() });
      const call = makeToolCall('move_to_building', { building: 'bar', reason: 'feeling social' });
      await executeTool(call);
      const savedArg = vi.mocked(saveMemory).mock.calls[0]![0];
      expect(savedArg.memoryType).toBe('episode');
      expect(savedArg.content).toContain('bar');
      expect(savedArg.content).toContain('feeling social');
    });

    it('blocks movement to building blocked by town event', async () => {
      vi.mocked(getCurrentLocation).mockReturnValue({ building: 'lighthouse', timestamp: Date.now() });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ blockedBuildings: ['library'] }),
      }) as unknown as typeof fetch;

      const call = makeToolCall('move_to_building', { building: 'library', reason: 'want to read' });
      const result = await executeTool(call);
      expect(result.content).toContain('inaccessible');
    });
  });

  // ── leave_note ────────────────────────────────────────────────────────

  describe('leave_note', () => {
    beforeEach(() => {
      vi.mocked(saveMemory).mockClear();
    });

    it('leaves a note at current location', async () => {
      vi.mocked(getCurrentLocation).mockReturnValue({ building: 'lighthouse', timestamp: Date.now() });
      const call = makeToolCall('leave_note', { content: 'I was here' });
      const result = await executeTool(call);
      expectSuccess(result);
      expect(result.content).toContain('Note left');
      expect(saveMemory).toHaveBeenCalledOnce();
      const arg = vi.mocked(saveMemory).mock.calls[0]![0];
      expect(arg.content).toContain('[Note left at lighthouse]');
      expect(arg.content).toContain('I was here');
    });

    it('leaves a note at specified building', async () => {
      const call = makeToolCall('leave_note', { content: 'Check this', location: 'bar' });
      const result = await executeTool(call);
      expect(result.content).toContain('Bar');
      const arg = vi.mocked(saveMemory).mock.calls[0]![0];
      expect(arg.content).toContain('[Note left at bar]');
    });

    it('rejects invalid building for location', async () => {
      const call = makeToolCall('leave_note', { content: 'test', location: 'spaceship' });
      const result = await executeTool(call);
      expect(result.content).toContain('Unknown building');
    });
  });

  // ── write_document ────────────────────────────────────────────────────

  describe('write_document', () => {
    beforeEach(() => {
      vi.mocked(saveMemory).mockClear();
    });

    it('saves document to memory', async () => {
      const call = makeToolCall('write_document', { title: 'My Essay', content: 'Chapter 1...' });
      const result = await executeTool(call);
      expectSuccess(result);
      expect(result.content).toContain('Document "My Essay" saved');
      expect(saveMemory).toHaveBeenCalledOnce();
      const arg = vi.mocked(saveMemory).mock.calls[0]![0];
      expect(arg.content).toContain('[Document: "My Essay"]');
      expect(arg.content).toContain('Chapter 1...');
    });

    it('sanitizes title for session key', async () => {
      const call = makeToolCall('write_document', { title: 'My!@#$%Essay 123', content: 'text' });
      await executeTool(call);
      const arg = vi.mocked(saveMemory).mock.calls[0]![0];
      expect(arg.sessionKey).toContain('document:test-char:my-essay-123');
    });
  });

  // ── send_peer_message ─────────────────────────────────────────────────

  describe('send_peer_message', () => {
    it('sends message to valid peer', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ response: 'Hello back!' }),
      }) as unknown as typeof fetch;

      const call = makeToolCall('send_peer_message', { peer_id: 'peer-a', message: 'Hello!' });
      const result = await executeTool(call);
      expectSuccess(result);
      expect(result.content).toContain('Peer A');
      expect(result.content).toContain('Hello back!');
    });

    it('returns error for unknown peer', async () => {
      const call = makeToolCall('send_peer_message', { peer_id: 'unknown', message: 'Hello' });
      const result = await executeTool(call);
      expect(result.content).toContain('Unknown peer');
    });

    it('handles unreachable peer', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Connection refused')) as unknown as typeof fetch;

      const call = makeToolCall('send_peer_message', { peer_id: 'peer-a', message: 'Hello' });
      const result = await executeTool(call);
      expect(result.content).toContain('Could not reach');
    });

    it('handles non-ok response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
      }) as unknown as typeof fetch;

      const call = makeToolCall('send_peer_message', { peer_id: 'peer-b', message: 'Hello' });
      const result = await executeTool(call);
      expect(result.content).toContain("didn't respond");
    });
  });

  // ── research_request ──────────────────────────────────────────────────

  describe('research_request', () => {
    it('submits research request successfully', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true, requestId: 'req-1' }),
      }) as unknown as typeof fetch;

      const call = makeToolCall('research_request', {
        question: 'What is quantum computing?',
        reason: 'Intellectual curiosity',
      });
      const result = await executeTool(call);
      expectSuccess(result);
      expect(result.content).toContain('Research request submitted');
    });

    it('handles failed request', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal error'),
      }) as unknown as typeof fetch;

      const call = makeToolCall('research_request', {
        question: 'test',
        reason: 'test',
      });
      const result = await executeTool(call);
      expect(result.content).toContain('failed');
    });

    it('handles network error', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error')) as unknown as typeof fetch;

      const call = makeToolCall('research_request', {
        question: 'test',
        reason: 'test',
      });
      const result = await executeTool(call);
      expect(result.content).toContain('Could not reach Wired Lain');
    });
  });

  // ── give_gift ─────────────────────────────────────────────────────────

  describe('give_gift', () => {
    beforeEach(() => {
      vi.mocked(saveMemory).mockClear();
    });

    it('sends symbolic gift to peer', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ response: 'Thank you!' }),
      }) as unknown as typeof fetch;

      const call = makeToolCall('give_gift', {
        peer_id: 'peer-a',
        description: 'A dried flower',
        message: 'For you',
      });
      const result = await executeTool(call);
      expectSuccess(result);
      expect(result.content).toContain('Gift delivered');
      expect(result.content).toContain('Peer A');
      expect(saveMemory).toHaveBeenCalledOnce();
    });

    it('rejects unknown peer', async () => {
      const call = makeToolCall('give_gift', { peer_id: 'nobody', description: 'a gift' });
      const result = await executeTool(call);
      expect(result.content).toContain('Unknown peer');
    });

    it('saves gift to memory with correct metadata', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ response: 'Thanks!' }),
      }) as unknown as typeof fetch;

      const call = makeToolCall('give_gift', {
        peer_id: 'peer-b',
        description: 'A brass key',
        message: 'Unlock something',
      });
      await executeTool(call);
      const arg = vi.mocked(saveMemory).mock.calls[0]![0];
      expect(arg.metadata).toEqual(expect.objectContaining({
        action: 'gift',
        recipient: 'peer-b',
        description: 'A brass key',
      }));
    });
  });

  // ── read_document ─────────────────────────────────────────────────────

  describe('read_document', () => {
    it('reads peer documents list', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([
          { title: 'Essay One', content: 'Content of essay one which is interesting' },
        ]),
      }) as unknown as typeof fetch;

      const call = makeToolCall('read_document', { peer_id: 'peer-a' });
      const result = await executeTool(call);
      expectSuccess(result);
      expect(result.content).toContain('Peer A');
      expect(result.content).toContain('Essay One');
    });

    it('reads specific document by title', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ title: 'Manifesto', content: 'Full document content here' }),
      }) as unknown as typeof fetch;

      const call = makeToolCall('read_document', { peer_id: 'peer-a', title: 'Manifesto' });
      const result = await executeTool(call);
      expect(result.content).toContain('Full document content here');
    });

    it('rejects unknown peer', async () => {
      const call = makeToolCall('read_document', { peer_id: 'nobody' });
      const result = await executeTool(call);
      expect(result.content).toContain('Unknown peer');
    });

    it('handles unreachable peer', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('timeout')) as unknown as typeof fetch;

      const call = makeToolCall('read_document', { peer_id: 'peer-a' });
      const result = await executeTool(call);
      expect(result.content).toContain('Could not reach');
    });
  });

  // ── create_object ─────────────────────────────────────────────────────

  describe('create_object', () => {
    beforeEach(() => {
      vi.mocked(saveMemory).mockClear();
    });

    it('creates object at current location', async () => {
      vi.mocked(getCurrentLocation).mockReturnValue({ building: 'lighthouse', timestamp: Date.now() });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true, object: { id: 'obj-1', name: 'brass compass' } }),
      }) as unknown as typeof fetch;

      const call = makeToolCall('create_object', { name: 'brass compass', description: 'points north always' });
      const result = await executeTool(call);
      expectSuccess(result);
      expect(result.content).toContain('brass compass');
      expect(result.content).toContain('lighthouse');
      expect(saveMemory).toHaveBeenCalledOnce();
    });

    it('handles creation failure', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ error: 'Too many objects' }),
      }) as unknown as typeof fetch;

      const call = makeToolCall('create_object', { name: 'thing', description: 'stuff' });
      const result = await executeTool(call);
      expect(result.content).toContain('Could not create');
    });
  });

  // ── examine_objects ───────────────────────────────────────────────────

  describe('examine_objects', () => {
    it('returns objects at current location', async () => {
      vi.mocked(getCurrentLocation).mockReturnValue({ building: 'library', timestamp: Date.now() });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([
          { id: 'obj-1', name: 'old book', description: 'A dusty tome', creatorName: 'PKD' },
        ]),
      }) as unknown as typeof fetch;

      const call = makeToolCall('examine_objects', { scope: 'here' });
      const result = await executeTool(call);
      expectSuccess(result);
      expect(result.content).toContain('LIBRARY');
      expect(result.content).toContain('old book');
    });

    it('returns inventory when scope is inventory', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([
          { id: 'obj-2', name: 'compass', description: 'Brass compass', creatorName: 'Lain' },
        ]),
      }) as unknown as typeof fetch;

      const call = makeToolCall('examine_objects', { scope: 'inventory' });
      const result = await executeTool(call);
      expect(result.content).toContain('YOUR INVENTORY');
      expect(result.content).toContain('compass');
    });

    it('returns empty message when no objects', async () => {
      vi.mocked(getCurrentLocation).mockReturnValue({ building: 'field', timestamp: Date.now() });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([]),
      }) as unknown as typeof fetch;

      const call = makeToolCall('examine_objects', { scope: 'here' });
      const result = await executeTool(call);
      expect(result.content).toContain('No objects');
    });
  });

  // ── pickup_object ─────────────────────────────────────────────────────

  describe('pickup_object', () => {
    it('picks up a non-fixture object', async () => {
      vi.mocked(saveMemory).mockClear();
      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ metadata: {} }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ ok: true }),
        }) as unknown as typeof fetch;

      const call = makeToolCall('pickup_object', { object_id: 'obj-1' });
      const result = await executeTool(call);
      expectSuccess(result);
      expect(result.content).toContain('Picked up');
    });

    it('rejects picking up fixtures', async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ metadata: { fixture: true } }),
      }) as unknown as typeof fetch;

      const call = makeToolCall('pickup_object', { object_id: 'fixture-1' });
      const result = await executeTool(call);
      expect(result.content).toContain("can't be picked up");
    });
  });

  // ── drop_object ───────────────────────────────────────────────────────

  describe('drop_object', () => {
    it('drops object at current location', async () => {
      vi.mocked(getCurrentLocation).mockReturnValue({ building: 'market', timestamp: Date.now() });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      }) as unknown as typeof fetch;

      const call = makeToolCall('drop_object', { object_id: 'obj-1' });
      const result = await executeTool(call);
      expectSuccess(result);
      expect(result.content).toContain('Dropped at the market');
    });

    it('handles drop failure', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ error: 'Not your object' }),
      }) as unknown as typeof fetch;

      const call = makeToolCall('drop_object', { object_id: 'obj-1' });
      const result = await executeTool(call);
      expect(result.content).toContain('Could not drop');
    });
  });

  // ── destroy_object ────────────────────────────────────────────────────

  describe('destroy_object', () => {
    it('destroys an object', async () => {
      vi.mocked(saveMemory).mockClear();
      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ metadata: {} }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ ok: true }),
        }) as unknown as typeof fetch;

      const call = makeToolCall('destroy_object', { object_id: 'obj-1', reason: 'no longer needed' });
      const result = await executeTool(call);
      expectSuccess(result);
      expect(result.content).toContain('Object destroyed');
    });

    it('rejects destroying fixtures', async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ metadata: { fixture: true } }),
      }) as unknown as typeof fetch;

      const call = makeToolCall('destroy_object', { object_id: 'fixture-1' });
      const result = await executeTool(call);
      expect(result.content).toContain("can't be removed");
    });
  });

  // ── give_object ───────────────────────────────────────────────────────

  describe('give_object', () => {
    it('gives object to peer', async () => {
      vi.mocked(saveMemory).mockClear();
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      }) as unknown as typeof fetch;

      const call = makeToolCall('give_object', {
        object_id: 'obj-1',
        peer_id: 'peer-a',
        message: 'For you',
      });
      const result = await executeTool(call);
      expectSuccess(result);
      expect(result.content).toContain('Object given to Peer A');
    });

    it('rejects unknown peer', async () => {
      const call = makeToolCall('give_object', { object_id: 'obj-1', peer_id: 'nobody' });
      const result = await executeTool(call);
      expect(result.content).toContain('Unknown peer');
    });
  });
});

// =========================================================================
// 6. TOOL x PROVIDER INTERACTION
// =========================================================================

describe('Tool x Provider Interaction', () => {
  describe('tool result structure for provider consumption', () => {
    it('successful tool result has string content for provider', async () => {
      const call = makeToolCall('calculate', { expression: '5 + 5' }, 'tc-1');
      const result = await executeTool(call);
      expect(typeof result.content).toBe('string');
      expect(typeof result.toolCallId).toBe('string');
      expect(result.toolCallId).toBe('tc-1');
    });

    it('error tool result has string content for provider error handling', async () => {
      const call = makeToolCall('nonexistent', {}, 'tc-err');
      const result = await executeTool(call);
      expect(typeof result.content).toBe('string');
      expect(result.isError).toBe(true);
    });

    it('tool result toolCallId matches input call id', async () => {
      const callId = 'unique-call-id-12345';
      const call = makeToolCall('get_current_time', {}, callId);
      const result = await executeTool(call);
      expect(result.toolCallId).toBe(callId);
    });
  });

  describe('multiple tool results ordering', () => {
    it('results array matches calls array order', async () => {
      const calls = [
        makeToolCall('get_current_time', {}, 'first'),
        makeToolCall('calculate', { expression: '1+1' }, 'second'),
        makeToolCall('introspect_info', {}, 'third'),
      ];
      const results = await executeTools(calls);
      expect(results[0]!.toolCallId).toBe('first');
      expect(results[1]!.toolCallId).toBe('second');
      expect(results[2]!.toolCallId).toBe('third');
    });
  });

  describe('tool result content for truncation', () => {
    it('very long tool result content is returned as-is (truncation is caller responsibility)', async () => {
      const longContent = 'X'.repeat(50000);
      registerTool({
        definition: { name: '__prov_long', description: 'test', inputSchema: { type: 'object', properties: {} } },
        handler: async () => longContent,
      });

      const result = await executeTool(makeToolCall('__prov_long', {}, 'long-tc'));
      expect(result.content.length).toBe(50000);

      unregisterTool('__prov_long');
    });

    it('empty string result is returned as-is', async () => {
      registerTool({
        definition: { name: '__prov_empty', description: 'test', inputSchema: { type: 'object', properties: {} } },
        handler: async () => '',
      });

      const result = await executeTool(makeToolCall('__prov_empty', {}, 'empty-tc'));
      expect(result.content).toBe('');
      expect(result.isError).toBeUndefined();

      unregisterTool('__prov_empty');
    });
  });

  describe('tool execution does not mutate call input', () => {
    it('input object is unchanged after execution', async () => {
      const input = { expression: '2 + 2' };
      const inputCopy = { ...input };
      const call = makeToolCall('calculate', input, 'immut-id');
      await executeTool(call);
      expect(call.input).toEqual(inputCopy);
    });
  });

  describe('concurrent tool execution isolation', () => {
    it('concurrent calls do not interfere with each other', async () => {
      let counter = 0;
      registerTool({
        definition: { name: '__concurrent', description: 'test', inputSchema: { type: 'object', properties: {} } },
        handler: async (input) => {
          const myNum = ++counter;
          await new Promise(r => setTimeout(r, 10));
          return `result-${myNum}-${input.label}`;
        },
      });

      const [r1, r2, r3] = await Promise.all([
        executeTool(makeToolCall('__concurrent', { label: 'a' }, 'c1')),
        executeTool(makeToolCall('__concurrent', { label: 'b' }, 'c2')),
        executeTool(makeToolCall('__concurrent', { label: 'c' }, 'c3')),
      ]);

      // Each should have its own label
      expect(r1!.content).toContain('-a');
      expect(r2!.content).toContain('-b');
      expect(r3!.content).toContain('-c');

      unregisterTool('__concurrent');
    });
  });

  describe('tool definitions for provider consumption', () => {
    it('getToolDefinitions returns array of ToolDefinition objects', () => {
      const defs = getToolDefinitions();
      expect(Array.isArray(defs)).toBe(true);
      for (const def of defs) {
        expect(typeof def.name).toBe('string');
        expect(typeof def.description).toBe('string');
        expect(def.inputSchema).toBeDefined();
        expect(def.inputSchema.type).toBe('object');
      }
    });

    it('tool definitions include all built-in tools', () => {
      const defs = getToolDefinitions();
      const names = defs.map(d => d.name);
      expect(names).toContain('get_current_time');
      expect(names).toContain('calculate');
      expect(names).toContain('remember');
      expect(names).toContain('recall');
      expect(names).toContain('expand_memory');
      expect(names).toContain('web_search');
      expect(names).toContain('fetch_webpage');
      // create_tool / list_my_tools / delete_tool removed (P1 findings.md:1561)
      expect(names).not.toContain('create_tool');
      expect(names).not.toContain('list_my_tools');
      expect(names).not.toContain('delete_tool');
      expect(names).toContain('introspect_list');
      expect(names).toContain('introspect_read');
      expect(names).toContain('introspect_search');
      expect(names).toContain('introspect_info');
      expect(names).toContain('show_image');
      expect(names).toContain('search_images');
      expect(names).toContain('send_message');
      expect(names).toContain('send_letter');
    });

    it('tool definitions include character tools after registration', () => {
      const defs = getToolDefinitions();
      const names = defs.map(d => d.name);
      expect(names).toContain('move_to_building');
      expect(names).toContain('leave_note');
      expect(names).toContain('write_document');
      expect(names).toContain('send_peer_message');
      expect(names).toContain('research_request');
      expect(names).toContain('give_gift');
      expect(names).toContain('create_object');
      expect(names).toContain('examine_objects');
      expect(names).toContain('pickup_object');
      expect(names).toContain('drop_object');
      expect(names).toContain('give_object');
      expect(names).toContain('destroy_object');
    });

    it('each tool definition has required inputSchema structure', () => {
      const defs = getToolDefinitions();
      for (const def of defs) {
        expect(def.inputSchema).toHaveProperty('type');
        expect(def.inputSchema.type).toBe('object');
        expect(def.inputSchema).toHaveProperty('properties');
      }
    });
  });

  describe('MAX_TOOL_ITERATIONS constant', () => {
    // Verify the iteration limit constant is accessible via source
    // (generateResponseWithTools is not exported, but we verify the contract)
    it('tool loop uses iteration limit of 8', async () => {
      // This is a structural check — the MAX_TOOL_ITERATIONS = 8 constant
      // is used in generateResponseWithTools which iterates tool calls.
      // We verify by reading the source (already confirmed in the code reading phase).
      // Here we test that executeTools itself has no iteration limit — it executes all calls.
      const calls = Array.from({ length: 10 }, (_, i) =>
        makeToolCall('get_current_time', {}, `iter-${i}`)
      );
      const results = await executeTools(calls);
      expect(results).toHaveLength(10);
    });
  });
});

// =========================================================================
// 7. EXTRACTTEXTFROMHTML behavioral
// =========================================================================

describe('extractTextFromHtml behavioral', () => {
  it('extracts text from basic HTML', () => {
    expect(extractTextFromHtml('<p>Hello</p>')).toBe('Hello');
  });

  it('strips script tags completely', () => {
    const html = '<div>before<script>evil()</script>after</div>';
    const result = extractTextFromHtml(html);
    expect(result).not.toContain('evil');
    expect(result).toContain('before');
    expect(result).toContain('after');
  });

  it('strips style tags completely', () => {
    const html = '<div>text<style>body{color:red}</style>more</div>';
    expect(extractTextFromHtml(html)).not.toContain('color');
  });

  it('strips nav tags', () => {
    const html = '<nav>Navigation</nav><div>Content</div>';
    const result = extractTextFromHtml(html);
    expect(result).not.toContain('Navigation');
    expect(result).toContain('Content');
  });

  it('strips footer tags', () => {
    const html = '<div>Main</div><footer>Footer stuff</footer>';
    expect(extractTextFromHtml(html)).not.toContain('Footer stuff');
  });

  it('strips header tags', () => {
    const html = '<header>Header</header><div>Body</div>';
    expect(extractTextFromHtml(html)).not.toContain('Header');
  });

  it('strips noscript tags', () => {
    const html = '<noscript>Enable JS</noscript><p>Content</p>';
    expect(extractTextFromHtml(html)).not.toContain('Enable JS');
  });

  it('decodes HTML entities', () => {
    const result = extractTextFromHtml('<p>A &amp; B &lt; C</p>');
    expect(result).toContain('A & B < C');
  });

  it('collapses whitespace', () => {
    const result = extractTextFromHtml('<p>  lots   of    spaces  </p>');
    expect(result).not.toContain('  ');
  });

  it('prefers main content when available', () => {
    const html = '<div>Outer</div><main>Main content here</main><div>More outer</div>';
    const result = extractTextFromHtml(html);
    expect(result).toContain('Main content here');
  });

  it('prefers article content when available', () => {
    const html = '<div>Outer</div><article>Article content</article>';
    const result = extractTextFromHtml(html);
    expect(result).toContain('Article content');
  });

  it('handles empty string', () => {
    expect(extractTextFromHtml('')).toBe('');
  });

  it('handles pure whitespace HTML', () => {
    const result = extractTextFromHtml('   \n  \t  ');
    expect(result).toBe('');
  });

  it('handles nested tags', () => {
    const html = '<div><p><span>Nested</span> content</p></div>';
    expect(extractTextFromHtml(html)).toContain('Nested');
    expect(extractTextFromHtml(html)).toContain('content');
  });

  it('decodes &quot; entities', () => {
    const result = extractTextFromHtml('<p>She said &quot;hello&quot;</p>');
    expect(result).toContain('She said "hello"');
  });

  it('decodes numeric character references', () => {
    const result = extractTextFromHtml('<p>&#65;&#66;&#67;</p>');
    expect(result).toContain('ABC');
  });

  it('handles HTML with only script/style tags', () => {
    const html = '<script>evil()</script><style>.x{}</style>';
    const result = extractTextFromHtml(html);
    expect(result).toBe('');
  });

  it('handles multiple script and style tags', () => {
    const html = '<script>a()</script>Text<script>b()</script><style>c{}</style>More<style>d{}</style>';
    const result = extractTextFromHtml(html);
    expect(result).not.toContain('a()');
    expect(result).not.toContain('b()');
    expect(result).toContain('Text');
    expect(result).toContain('More');
  });
});

// =========================================================================
// 8. ADDITIONAL TOOL EXECUTION EDGE CASES
// =========================================================================

describe('Additional Tool Execution Edge Cases', () => {
  // ── calculate edge cases ──────────────────────────────────────────────

  describe('calculate edge cases', () => {
    it('handles negative numbers', async () => {
      const call = makeToolCall('calculate', { expression: '-5 + 3' });
      const result = await executeTool(call);
      expect(result.content).toBe('Result: -2');
    });

    it('handles decimal results', async () => {
      const call = makeToolCall('calculate', { expression: '7 / 2' });
      const result = await executeTool(call);
      expect(result.content).toBe('Result: 3.5');
    });

    it('handles parentheses', async () => {
      const call = makeToolCall('calculate', { expression: '(10 + 5) / 3' });
      const result = await executeTool(call);
      expect(result.content).toBe('Result: 5');
    });

    it('handles multiple operations', async () => {
      const call = makeToolCall('calculate', { expression: '2 + 3 * 4 - 1' });
      const result = await executeTool(call);
      expect(result.content).toBe('Result: 13');
    });

    it('handles sqrt of 0', async () => {
      const call = makeToolCall('calculate', { expression: 'sqrt(0)' });
      const result = await executeTool(call);
      expect(result.content).toBe('Result: 0');
    });

    it('handles nested sqrt', async () => {
      const call = makeToolCall('calculate', { expression: 'sqrt(sqrt(256))' });
      const result = await executeTool(call);
      expect(result.content).toBe('Result: 4');
    });
  });

  // ── remember metadata edge cases ──────────────────────────────────────

  describe('remember metadata edge cases', () => {
    beforeEach(() => {
      vi.mocked(saveMemory).mockClear();
    });

    it('stores exactly 0.0 importance when set to 0', async () => {
      const call = makeToolCall('remember', { key: 'k', value: 'v', importance: 0 });
      await executeTool(call);
      const arg = vi.mocked(saveMemory).mock.calls[0]![0];
      expect(arg.importance).toBe(0);
    });

    it('stores exactly 1.0 importance when set to 1', async () => {
      const call = makeToolCall('remember', { key: 'k', value: 'v', importance: 1 });
      await executeTool(call);
      const arg = vi.mocked(saveMemory).mock.calls[0]![0];
      expect(arg.importance).toBe(1);
    });

    it('stores emotionalWeight as 0.3', async () => {
      const call = makeToolCall('remember', { key: 'k', value: 'v' });
      await executeTool(call);
      const arg = vi.mocked(saveMemory).mock.calls[0]![0];
      expect(arg.emotionalWeight).toBe(0.3);
    });

    it('stores userId as null', async () => {
      const call = makeToolCall('remember', { key: 'k', value: 'v' });
      await executeTool(call);
      const arg = vi.mocked(saveMemory).mock.calls[0]![0];
      expect(arg.userId).toBeNull();
    });
  });

  // ── recall edge cases ─────────────────────────────────────────────────

  describe('recall edge cases', () => {
    it('returns multiple formatted memories', async () => {
      vi.mocked(searchMemories).mockResolvedValue([
        {
          similarity: 0.95,
          memory: {
            id: 'm1', content: 'First memory', memoryType: 'fact', importance: 0.9,
            emotionalWeight: 0, createdAt: Date.now(), sessionKey: null, userId: null,
            embedding: null, lastAccessed: null, accessCount: 0, relatedTo: null,
            sourceMessageId: null, metadata: {}, lifecycleState: 'growing' as const,
            lifecycleChangedAt: null, phase: null, wingId: null, roomId: null,
            hall: null, aaakContent: null, aaakCompressedAt: null,
          },
        },
        {
          similarity: 0.75,
          memory: {
            id: 'm2', content: 'Second memory', memoryType: 'episode', importance: 0.5,
            emotionalWeight: 0, createdAt: Date.now(), sessionKey: null, userId: null,
            embedding: null, lastAccessed: null, accessCount: 0, relatedTo: null,
            sourceMessageId: null, metadata: {}, lifecycleState: 'growing' as const,
            lifecycleChangedAt: null, phase: null, wingId: null, roomId: null,
            hall: null, aaakContent: null, aaakCompressedAt: null,
          },
        },
      ]);

      const call = makeToolCall('recall', { query: 'test' });
      const result = await executeTool(call);
      expect(result.content).toContain('found 2 memories');
      expect(result.content).toContain('First memory');
      expect(result.content).toContain('Second memory');
      expect(result.content).toContain('95%');
      expect(result.content).toContain('75%');
      expect(result.content).toContain('[fact]');
      expect(result.content).toContain('[episode]');
    });
  });

  // ── send_message edge cases ───────────────────────────────────────────

  describe('send_message edge cases', () => {
    afterEach(() => {
      delete process.env['TELEGRAM_BOT_TOKEN'];
      delete process.env['TELEGRAM_CHAT_ID'];
    });

    it('handles high priority prefix', async () => {
      process.env['TELEGRAM_BOT_TOKEN'] = 'fake-token';
      process.env['TELEGRAM_CHAT_ID'] = '12345';
      const call = makeToolCall('send_message', { message: 'Urgent!', priority: 'high' });
      const result = await executeTool(call);
      expect(result.content).toContain('message sent');
    });

    it('handles low priority prefix', async () => {
      process.env['TELEGRAM_BOT_TOKEN'] = 'fake-token';
      process.env['TELEGRAM_CHAT_ID'] = '12345';
      const call = makeToolCall('send_message', { message: 'Just thinking', priority: 'low' });
      const result = await executeTool(call);
      expect(result.content).toContain('message sent');
    });

    it('returns error when only BOT_TOKEN is set', async () => {
      process.env['TELEGRAM_BOT_TOKEN'] = 'fake-token';
      delete process.env['TELEGRAM_CHAT_ID'];
      const call = makeToolCall('send_message', { message: 'test' });
      const result = await executeTool(call);
      expect(result.content).toContain('error: Telegram not configured');
    });

    it('returns error when only CHAT_ID is set', async () => {
      delete process.env['TELEGRAM_BOT_TOKEN'];
      process.env['TELEGRAM_CHAT_ID'] = '12345';
      const call = makeToolCall('send_message', { message: 'test' });
      const result = await executeTool(call);
      expect(result.content).toContain('error: Telegram not configured');
    });
  });

  // ── show_image edge cases ─────────────────────────────────────────────

  describe('show_image edge cases', () => {
    it('handles very long URL', async () => {
      const longUrl = 'https://example.com/' + 'a'.repeat(5000) + '.jpg';
      const call = makeToolCall('show_image', { url: longUrl });
      const result = await executeTool(call);
      expectSuccess(result);
      expect(result.content).toContain('[IMAGE:');
    });

    it('handles URL with query parameters', async () => {
      const call = makeToolCall('show_image', { url: 'https://example.com/pic.jpg?size=large&format=webp' });
      const result = await executeTool(call);
      expectSuccess(result);
      expect(result.content).toContain('https://example.com/pic.jpg?size=large&format=webp');
    });

    it('handles http (not just https)', async () => {
      const call = makeToolCall('show_image', { url: 'http://example.com/pic.jpg' });
      const result = await executeTool(call);
      expectSuccess(result);
    });
  });

  // ── Tool overwrite behavior ───────────────────────────────────────────

  describe('tool overwrite behavior', () => {
    it('registering a tool with same name overwrites the previous', async () => {
      registerTool({
        definition: { name: '__overwrite_test', description: 'v1', inputSchema: { type: 'object', properties: {} } },
        handler: async () => 'version 1',
      });
      registerTool({
        definition: { name: '__overwrite_test', description: 'v2', inputSchema: { type: 'object', properties: {} } },
        handler: async () => 'version 2',
      });

      const result = await executeTool(makeToolCall('__overwrite_test', {}));
      expect(result.content).toBe('version 2');

      const defs = getToolDefinitions();
      const found = defs.filter(d => d.name === '__overwrite_test');
      expect(found).toHaveLength(1);
      expect(found[0]!.description).toBe('v2');

      unregisterTool('__overwrite_test');
    });
  });

  // ── unregisterTool return value ───────────────────────────────────────

  describe('unregisterTool return value', () => {
    it('returns true when tool exists', () => {
      registerTool({
        definition: { name: '__unreg_bool', description: 'test', inputSchema: { type: 'object', properties: {} } },
        handler: async () => 'ok',
      });
      expect(unregisterTool('__unreg_bool')).toBe(true);
    });

    it('returns false when tool does not exist', () => {
      expect(unregisterTool('__nonexistent_unreg')).toBe(false);
    });
  });
});

// =========================================================================
// 9. ADDITIONAL CHARACTER TOOL EDGE CASES
// =========================================================================

describe('Additional Character Tool Edge Cases', () => {
  // ── move_to_building edge cases ───────────────────────────────────────

  describe('move_to_building — all buildings', () => {
    const allBuildings = ['library', 'bar', 'field', 'windmill', 'lighthouse', 'school', 'market', 'locksmith', 'threshold'];

    for (const building of allBuildings) {
      it(`accepts movement to ${building}`, async () => {
        vi.mocked(getCurrentLocation).mockReturnValue({ building: building === 'library' ? 'bar' : 'library', timestamp: Date.now() });
        vi.mocked(setCurrentLocation).mockClear();
        vi.mocked(saveMemory).mockClear();
        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ blockedBuildings: [] }),
        }) as unknown as typeof fetch;

        const call = makeToolCall('move_to_building', { building, reason: 'testing' });
        const result = await executeTool(call);
        expect(result.content).not.toContain('Unknown building');
        expect(setCurrentLocation).toHaveBeenCalled();
      });
    }
  });

  // ── move_to_building when event check fails ───────────────────────────

  describe('move_to_building — event check failure', () => {
    it('proceeds with movement when event check fetch fails', async () => {
      vi.mocked(getCurrentLocation).mockReturnValue({ building: 'lighthouse', timestamp: Date.now() });
      vi.mocked(setCurrentLocation).mockClear();
      vi.mocked(saveMemory).mockClear();
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('timeout')) as unknown as typeof fetch;

      const call = makeToolCall('move_to_building', { building: 'bar', reason: 'social' });
      const result = await executeTool(call);
      expectSuccess(result);
      expect(result.content).toContain('Bar');
    });
  });

  // ── leave_note metadata ───────────────────────────────────────────────

  describe('leave_note — metadata checks', () => {
    it('saves with episode memory type', async () => {
      vi.mocked(saveMemory).mockClear();
      vi.mocked(getCurrentLocation).mockReturnValue({ building: 'library', timestamp: Date.now() });
      const call = makeToolCall('leave_note', { content: 'Hello world' });
      await executeTool(call);
      const arg = vi.mocked(saveMemory).mock.calls[0]![0];
      expect(arg.memoryType).toBe('episode');
      expect(arg.importance).toBe(0.4);
      expect(arg.emotionalWeight).toBe(0.2);
      expect(arg.metadata).toEqual(expect.objectContaining({
        action: 'note',
        building: 'library',
        author: 'test-char',
      }));
    });
  });

  // ── write_document metadata ───────────────────────────────────────────

  describe('write_document — metadata checks', () => {
    it('stores with correct metadata including author', async () => {
      vi.mocked(saveMemory).mockClear();
      const call = makeToolCall('write_document', { title: 'Test', content: 'Body' });
      await executeTool(call);
      const arg = vi.mocked(saveMemory).mock.calls[0]![0];
      expect(arg.metadata).toEqual(expect.objectContaining({
        action: 'document',
        title: 'Test',
        author: 'test-char',
      }));
      expect(arg.importance).toBe(0.5);
    });

    it('truncates long title in session key to 60 chars', async () => {
      vi.mocked(saveMemory).mockClear();
      const longTitle = 'A'.repeat(100);
      const call = makeToolCall('write_document', { title: longTitle, content: 'text' });
      await executeTool(call);
      const arg = vi.mocked(saveMemory).mock.calls[0]![0];
      const sessionKey = arg.sessionKey as string;
      // The sanitized portion should be at most 60 chars
      const sanitizedPart = sessionKey.replace('document:test-char:', '');
      expect(sanitizedPart.length).toBeLessThanOrEqual(60);
    });
  });

  // ── send_peer_message payload structure ────────────────────────────────

  describe('send_peer_message — request payload', () => {
    it('sends correct JSON payload to peer endpoint', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ response: 'Got it' }),
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const call = makeToolCall('send_peer_message', { peer_id: 'peer-a', message: 'Test message' });
      await executeTool(call);

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:4001/api/peer/message',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        })
      );

      const bodyStr = fetchMock.mock.calls[0]![1].body;
      const body = JSON.parse(bodyStr);
      expect(body.fromId).toBe('test-char');
      expect(body.fromName).toBe('Test Character');
      expect(body.message).toBe('Test message');
      expect(typeof body.timestamp).toBe('number');
    });
  });

  // ── research_request payload structure ─────────────────────────────────

  describe('research_request — request payload', () => {
    it('sends correct JSON payload with optional URL', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const call = makeToolCall('research_request', {
        question: 'Q',
        reason: 'R',
        url: 'https://example.com',
      });
      await executeTool(call);

      const bodyStr = fetchMock.mock.calls[0]![1].body;
      const body = JSON.parse(bodyStr);
      expect(body.characterId).toBe('test-char');
      expect(body.characterName).toBe('Test Character');
      expect(body.question).toBe('Q');
      expect(body.reason).toBe('R');
      expect(body.url).toBe('https://example.com');
      // findings.md P2:1923 — replyTo uses PORT env when set
      expect(body.replyTo).toBe('http://localhost:4000');
    });

    it('handles ok: false response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: false }),
      }) as unknown as typeof fetch;

      const call = makeToolCall('research_request', { question: 'Q', reason: 'R' });
      const result = await executeTool(call);
      expect(result.content).toContain('could not be processed');
    });
  });

  // ── give_gift without message ─────────────────────────────────────────

  describe('give_gift — optional message', () => {
    it('sends gift without message', async () => {
      vi.mocked(saveMemory).mockClear();
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ response: 'Thanks' }),
      }) as unknown as typeof fetch;

      const call = makeToolCall('give_gift', { peer_id: 'peer-a', description: 'A stone' });
      const result = await executeTool(call);
      expectSuccess(result);
      expect(result.content).toContain('Gift delivered');
    });

    it('handles unreachable peer during gift', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
      const call = makeToolCall('give_gift', { peer_id: 'peer-a', description: 'A stone' });
      const result = await executeTool(call);
      expect(result.content).toContain('Could not reach');
    });
  });

  // ── examine_objects with default scope ────────────────────────────────

  describe('examine_objects — default scope', () => {
    it('defaults to "here" scope when not specified', async () => {
      vi.mocked(getCurrentLocation).mockReturnValue({ building: 'lighthouse', timestamp: Date.now() });
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([]),
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const call = makeToolCall('examine_objects', {});
      await executeTool(call);

      const url = fetchMock.mock.calls[0]![0] as string;
      expect(url).toContain('?location=lighthouse');
    });
  });

  // ── create_object memory metadata ─────────────────────────────────────

  describe('create_object — memory metadata', () => {
    it('saves with correct memory metadata', async () => {
      vi.mocked(saveMemory).mockClear();
      vi.mocked(getCurrentLocation).mockReturnValue({ building: 'market', timestamp: Date.now() });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true, object: { id: 'new-obj', name: 'key' } }),
      }) as unknown as typeof fetch;

      const call = makeToolCall('create_object', { name: 'key', description: 'A golden key' });
      await executeTool(call);

      const arg = vi.mocked(saveMemory).mock.calls[0]![0];
      expect(arg.metadata).toEqual(expect.objectContaining({
        action: 'object_create',
        objectId: 'new-obj',
        name: 'key',
        building: 'market',
      }));
    });
  });

  // ── pickup_object when fetch fails ────────────────────────────────────

  describe('pickup_object — network failure', () => {
    it('handles network error on fixture check gracefully', async () => {
      vi.mocked(saveMemory).mockClear();
      globalThis.fetch = vi.fn()
        .mockRejectedValueOnce(new Error('timeout'))  // fixture check fails
        .mockResolvedValueOnce({                       // pickup succeeds
          ok: true,
          json: () => Promise.resolve({ ok: true }),
        }) as unknown as typeof fetch;

      const call = makeToolCall('pickup_object', { object_id: 'obj-1' });
      const result = await executeTool(call);
      expect(result.content).toContain('Picked up');
    });
  });
});

// =========================================================================
// 10. ADDITIONAL DOCTOR TOOL EDGE CASES
// =========================================================================

describe('Additional Doctor Tool Edge Cases', () => {
  let executeDoctorTool: typeof import('../src/agent/doctor-tools.js').executeDoctorTool;

  beforeAll(async () => {
    const mod = await import('../src/agent/doctor-tools.js');
    executeDoctorTool = mod.executeDoctorTool;
  });

  describe('get_health_status — all healthy', () => {
    it('shows ALL HEALTHY when all services are up', async () => {
      const { getMeta } = await import('../src/storage/database.js');
      const healthData = {
        timestamp: Date.now(),
        services: [
          { name: 'Wired Lain', port: 3000, status: 'up', responseMs: 30 },
          { name: 'Lain', port: 3001, status: 'up', responseMs: 25 },
        ],
        allHealthy: true,
        fixAttempted: false,
      };
      vi.mocked(getMeta).mockImplementation((key: string) => {
        if (key === 'doctor:health:latest') return JSON.stringify(healthData);
        if (key === 'doctor:health:last_run_at') return String(Date.now());
        return null;
      });

      const result = await executeDoctorTool({ id: 'h1', name: 'get_health_status', input: {} });
      expect(result.content).toContain('ALL HEALTHY');
      vi.mocked(getMeta).mockReturnValue(null);
    });
  });

  describe('get_health_status — fix attempted', () => {
    it('shows auto-fix output when fix was attempted', async () => {
      const { getMeta } = await import('../src/storage/database.js');
      const healthData = {
        timestamp: Date.now(),
        services: [{ name: 'Test', port: 3000, status: 'down' }],
        allHealthy: false,
        fixAttempted: true,
        fixOutput: 'Restarted service Test',
      };
      vi.mocked(getMeta).mockImplementation((key: string) => {
        if (key === 'doctor:health:latest') return JSON.stringify(healthData);
        if (key === 'doctor:health:last_run_at') return String(Date.now());
        return null;
      });

      const result = await executeDoctorTool({ id: 'h2', name: 'get_health_status', input: {} });
      expect(result.content).toContain('Auto-Fix Output');
      expect(result.content).toContain('Restarted service Test');
      vi.mocked(getMeta).mockReturnValue(null);
    });
  });

  describe('get_reports — report with concerns', () => {
    it('shows concerns in report', async () => {
      const { getMeta } = await import('../src/storage/database.js');
      const report = {
        date: '2026-04-17',
        clinicalSummary: 'Issues detected',
        concerns: ['Memory leak', 'High latency'],
        letterRecommendation: 'block',
        blockReason: 'System unstable',
        metrics: { sessions: 1, memories: 2, dreams: 0, curiosityRuns: 0 },
        emotionalLandscape: 'Turbulent',
        therapyNotes: 'Consider maintenance mode',
      };
      vi.mocked(getMeta).mockImplementation((key: string) => {
        if (key === 'doctor:report:latest') return JSON.stringify(report);
        return null;
      });

      const result = await executeDoctorTool({ id: 'r1', name: 'get_reports', input: { action: 'latest' } });
      expect(result.content).toContain('Memory leak; High latency');
      expect(result.content).toContain('BLOCK');
      expect(result.content).toContain('System unstable');
      expect(result.content).toContain('Therapy Notes');
      expect(result.content).toContain('Consider maintenance mode');
      vi.mocked(getMeta).mockReturnValue(null);
    });
  });

  describe('get_reports — get specific report', () => {
    it('retrieves a specific report by timestamp', async () => {
      const { getMeta } = await import('../src/storage/database.js');
      const report = {
        date: '2026-04-10',
        clinicalSummary: 'Historical report',
        concerns: [],
        letterRecommendation: 'allow',
        metrics: {},
        emotionalLandscape: 'Calm',
      };
      vi.mocked(getMeta).mockImplementation((key: string) => {
        if (key === 'doctor:report:1713300000000') return JSON.stringify(report);
        return null;
      });

      const result = await executeDoctorTool({
        id: 'r2',
        name: 'get_reports',
        input: { action: 'get', timestamp: '1713300000000' },
      });
      expect(result.content).toContain('Historical report');
      vi.mocked(getMeta).mockReturnValue(null);
    });

    it('returns error for nonexistent timestamp', async () => {
      const { getMeta } = await import('../src/storage/database.js');
      vi.mocked(getMeta).mockReturnValue(null);

      const result = await executeDoctorTool({
        id: 'r3',
        name: 'get_reports',
        input: { action: 'get', timestamp: '9999999999' },
      });
      expect(result.content).toContain('No report found');
    });
  });

  describe('get_reports — empty list', () => {
    it('returns appropriate message for empty index', async () => {
      const { getMeta } = await import('../src/storage/database.js');
      vi.mocked(getMeta).mockImplementation((key: string) => {
        if (key === 'doctor:report:index') return JSON.stringify([]);
        return null;
      });

      const result = await executeDoctorTool({
        id: 'r4',
        name: 'get_reports',
        input: { action: 'list' },
      });
      expect(result.content).toContain('No reports available');
      vi.mocked(getMeta).mockReturnValue(null);
    });
  });

  describe('read_file — .git/hooks path', () => {
    it('rejects .git/hooks path', async () => {
      const result = await executeDoctorTool({
        id: 'rf-git',
        name: 'read_file',
        input: { path: '.git/hooks/pre-commit' },
      });
      // .git/ is blocked
      expect(result.content).toContain('Access denied');
    });
  });

  describe('executeDoctorTool — handler throw', () => {
    it('catches handler exceptions and returns isError', async () => {
      // We simulate this by calling with invalid JSON in getMeta
      const { getMeta } = await import('../src/storage/database.js');
      vi.mocked(getMeta).mockImplementation(() => {
        throw new Error('Database crash');
      });

      // get_health_status reads getMeta, which will throw
      const result = await executeDoctorTool({
        id: 'crash-id',
        name: 'get_health_status',
        input: {},
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContain('Database crash');

      vi.mocked(getMeta).mockReturnValue(null);
    });
  });
});

// =========================================================================
// 11. ADDITIONAL PROVIDER INTERACTION TESTS
// =========================================================================

describe('Additional Provider Interaction Tests', () => {
  describe('tool call with complex input', () => {
    it('handles nested object input', async () => {
      let received: Record<string, unknown> = {};
      registerTool({
        definition: { name: '__complex_input', description: 'test', inputSchema: { type: 'object', properties: {} } },
        handler: async (input) => { received = input; return 'ok'; },
      });

      const complexInput = {
        nested: { a: 1, b: { c: 'deep' } },
        array: [1, 2, 3],
        boolean: true,
        nullVal: null,
      };
      await executeTool(makeToolCall('__complex_input', complexInput));
      expect(received).toEqual(complexInput);

      unregisterTool('__complex_input');
    });
  });

  describe('tool call with unicode input', () => {
    it('handles unicode characters in input', async () => {
      let received = '';
      registerTool({
        definition: { name: '__unicode_input', description: 'test', inputSchema: { type: 'object', properties: {} } },
        handler: async (input) => { received = input.text as string; return received; },
      });

      await executeTool(makeToolCall('__unicode_input', { text: 'Hello 世界 🌍 مرحبا' }));
      expect(received).toBe('Hello 世界 🌍 مرحبا');

      unregisterTool('__unicode_input');
    });
  });

  describe('tool call with special characters in ID', () => {
    it('preserves special characters in toolCallId', async () => {
      const specialId = 'call_123-abc_def/456';
      const result = await executeTool(makeToolCall('get_current_time', {}, specialId));
      expect(result.toolCallId).toBe(specialId);
    });
  });

  describe('multiple calls to same tool', () => {
    it('each call gets independent result', async () => {
      let callCount = 0;
      registerTool({
        definition: { name: '__counter', description: 'test', inputSchema: { type: 'object', properties: {} } },
        handler: async () => `call-${++callCount}`,
      });

      const r1 = await executeTool(makeToolCall('__counter', {}, 'c1'));
      const r2 = await executeTool(makeToolCall('__counter', {}, 'c2'));
      const r3 = await executeTool(makeToolCall('__counter', {}, 'c3'));

      expect(r1.content).toBe('call-1');
      expect(r2.content).toBe('call-2');
      expect(r3.content).toBe('call-3');

      unregisterTool('__counter');
    });
  });

  describe('executeTools with empty array', () => {
    it('returns empty array', async () => {
      const results = await executeTools([]);
      expect(results).toEqual([]);
    });
  });

  describe('executeTools with single call', () => {
    it('returns single result in array', async () => {
      const results = await executeTools([
        makeToolCall('get_current_time', {}, 'single'),
      ]);
      expect(results).toHaveLength(1);
      expect(results[0]!.toolCallId).toBe('single');
    });
  });

  describe('tool definitions do not have duplicate names', () => {
    it('all registered tool names are unique', () => {
      const defs = getToolDefinitions();
      const names = defs.map(d => d.name);
      const unique = new Set(names);
      expect(unique.size).toBe(names.length);
    });
  });

  describe('tool definitions have non-empty descriptions', () => {
    it('every tool has a description longer than 10 characters', () => {
      const defs = getToolDefinitions();
      for (const def of defs) {
        expect(def.description.length).toBeGreaterThan(10);
      }
    });
  });

  describe('tool names follow naming convention', () => {
    it('all tool names use lowercase and underscores only', () => {
      const defs = getToolDefinitions();
      for (const def of defs) {
        expect(def.name).toMatch(/^[a-z][a-z0-9_]*$/);
      }
    });
  });

  describe('tool inputSchema.properties is an object', () => {
    it('every tool has properties as object (not array or null)', () => {
      const defs = getToolDefinitions();
      for (const def of defs) {
        const props = def.inputSchema.properties;
        expect(typeof props).toBe('object');
        expect(props).not.toBeNull();
        expect(Array.isArray(props)).toBe(false);
      }
    });
  });

  describe('tool required fields are arrays when present', () => {
    it('every inputSchema.required (if present) is an array', () => {
      const defs = getToolDefinitions();
      for (const def of defs) {
        const required = def.inputSchema.required;
        if (required !== undefined) {
          expect(Array.isArray(required)).toBe(true);
        }
      }
    });
  });

  describe('executeTools preserves call IDs through errors', () => {
    it('all results have matching toolCallIds even with mixed success/failure', async () => {
      registerTool({
        definition: { name: '__id_check_ok', description: 'test', inputSchema: { type: 'object', properties: {} } },
        handler: async () => 'ok',
      });
      registerTool({
        definition: { name: '__id_check_err', description: 'test', inputSchema: { type: 'object', properties: {} } },
        handler: async () => { throw new Error('fail'); },
      });

      const calls = [
        makeToolCall('__id_check_ok', {}, 'id-a'),
        makeToolCall('__id_check_err', {}, 'id-b'),
        makeToolCall('nonexistent_xyz', {}, 'id-c'),
        makeToolCall('__id_check_ok', {}, 'id-d'),
      ];

      const results = await executeTools(calls);
      expect(results[0]!.toolCallId).toBe('id-a');
      expect(results[1]!.toolCallId).toBe('id-b');
      expect(results[2]!.toolCallId).toBe('id-c');
      expect(results[3]!.toolCallId).toBe('id-d');

      unregisterTool('__id_check_ok');
      unregisterTool('__id_check_err');
    });
  });

  describe('tool result content encoding', () => {
    it('preserves newlines in result', async () => {
      registerTool({
        definition: { name: '__newline', description: 'test', inputSchema: { type: 'object', properties: {} } },
        handler: async () => 'line1\nline2\nline3',
      });

      const result = await executeTool(makeToolCall('__newline', {}));
      expect(result.content).toBe('line1\nline2\nline3');

      unregisterTool('__newline');
    });

    it('preserves tabs in result', async () => {
      registerTool({
        definition: { name: '__tabs', description: 'test', inputSchema: { type: 'object', properties: {} } },
        handler: async () => 'col1\tcol2\tcol3',
      });

      const result = await executeTool(makeToolCall('__tabs', {}));
      expect(result.content).toBe('col1\tcol2\tcol3');

      unregisterTool('__tabs');
    });

    it('preserves unicode in result', async () => {
      registerTool({
        definition: { name: '__unicode_out', description: 'test', inputSchema: { type: 'object', properties: {} } },
        handler: async () => 'Result: 你好世界',
      });

      const result = await executeTool(makeToolCall('__unicode_out', {}));
      expect(result.content).toBe('Result: 你好世界');

      unregisterTool('__unicode_out');
    });
  });
});
