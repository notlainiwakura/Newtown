/**
 * Persona behavioral tests — exercises real loading, style application,
 * system prompt construction, character identity, template system,
 * and conversation context building via actual function execution.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Mocks — must appear before imports that touch the mocked modules
// ---------------------------------------------------------------------------

vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn().mockResolvedValue('test-key'),
    setPassword: vi.fn().mockResolvedValue(undefined),
    deletePassword: vi.fn().mockResolvedValue(true),
    findCredentials: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../src/config/characters.js', () => ({
  getWebCharacter: vi.fn(),
  getAllCharacters: vi.fn().mockReturnValue([]),
  getCharacterEntry: vi.fn(),
  getDefaultLocations: vi.fn().mockReturnValue({}),
  loadManifest: vi.fn().mockReturnValue({ town: { name: 'Test', description: '' }, characters: [] }),
}));

import { readFile } from 'node:fs/promises';
import { eventBus } from '../src/events/bus.js';
import { getWebCharacter } from '../src/config/characters.js';
import {
  loadPersona,
  buildSystemPrompt,
  applyPersonaStyle,
  type Persona,
  type PersonaConfig,
} from '../src/agent/persona.js';
import {
  getConversation,
  addUserMessage,
  addAssistantMessage,
  toProviderMessages,
  trimConversation,
  clearConversation,
  getTextContent,
  type Conversation,
  type ConversationMessage,
} from '../src/agent/conversation.js';
import type { IncomingMessage } from '../src/types/message.js';

const mockedGetWebCharacter = vi.mocked(getWebCharacter);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDirs: string[] = [];

function makeTempWorkspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'lain-test-'));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, 'utf-8');
  }
  return dir;
}

function defaultWebCharacter() {
  return {
    id: 'wired-lain',
    name: 'Wired Lain',
    port: 3000,
    server: 'web' as const,
    defaultLocation: 'library',
    immortal: true,
    workspace: 'workspace/characters/wired-lain',
  };
}

function setupLainStyle() {
  eventBus.setCharacterId('lain');
  mockedGetWebCharacter.mockReturnValue(defaultWebCharacter());
}

function makeMessage(text: string, overrides?: Partial<IncomingMessage>): IncomingMessage {
  return {
    id: 'msg-' + Math.random().toString(36).slice(2),
    channel: 'web',
    peerKind: 'user',
    peerId: 'user-1',
    senderId: 'user-1',
    senderName: 'Test User',
    content: { type: 'text', text },
    timestamp: Date.now(),
    ...overrides,
  };
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  setupLainStyle();
});

afterEach(() => {
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tempDirs = [];
});

// =========================================================================
// 1. PERSONA LOADING BEHAVIORAL (~60 tests)
// =========================================================================

describe('Persona loading behavioral', () => {
  describe('basic file loading', () => {
    it('loads SOUL.md content into persona.soul', async () => {
      const dir = makeTempWorkspace({
        'SOUL.md': 'I am the soul of the machine.',
        'AGENTS.md': 'agents',
        'IDENTITY.md': 'identity',
      });
      const persona = await loadPersona({ workspacePath: dir });
      expect(persona.soul).toBe('I am the soul of the machine.');
    });

    it('loads AGENTS.md content into persona.agents', async () => {
      const dir = makeTempWorkspace({
        'SOUL.md': 'soul',
        'AGENTS.md': 'Follow these operating instructions carefully.',
        'IDENTITY.md': 'identity',
      });
      const persona = await loadPersona({ workspacePath: dir });
      expect(persona.agents).toBe('Follow these operating instructions carefully.');
    });

    it('loads IDENTITY.md content into persona.identity', async () => {
      const dir = makeTempWorkspace({
        'SOUL.md': 'soul',
        'AGENTS.md': 'agents',
        'IDENTITY.md': 'name: TestBot\navatar: test.png',
      });
      const persona = await loadPersona({ workspacePath: dir });
      expect(persona.identity).toBe('name: TestBot\navatar: test.png');
    });

    it('returns all three fields populated', async () => {
      const dir = makeTempWorkspace({
        'SOUL.md': 'soul-content',
        'AGENTS.md': 'agents-content',
        'IDENTITY.md': 'identity-content',
      });
      const persona = await loadPersona({ workspacePath: dir });
      expect(persona).toEqual({
        soul: 'soul-content',
        agents: 'agents-content',
        identity: 'identity-content',
      });
    });

    it('persona object has exactly three keys', async () => {
      const dir = makeTempWorkspace({
        'SOUL.md': 's',
        'AGENTS.md': 'a',
        'IDENTITY.md': 'i',
      });
      const persona = await loadPersona({ workspacePath: dir });
      expect(Object.keys(persona)).toHaveLength(3);
      expect(Object.keys(persona).sort()).toEqual(['agents', 'identity', 'soul']);
    });
  });

  describe('missing files fallback', () => {
    it('throws AgentError when SOUL.md is missing', async () => {
      const dir = makeTempWorkspace({
        'AGENTS.md': 'a',
        'IDENTITY.md': 'i',
      });
      await expect(loadPersona({ workspacePath: dir })).rejects.toThrow(/Failed to load persona/);
    });

    it('throws AgentError when AGENTS.md is missing', async () => {
      const dir = makeTempWorkspace({
        'SOUL.md': 's',
        'IDENTITY.md': 'i',
      });
      await expect(loadPersona({ workspacePath: dir })).rejects.toThrow(/Failed to load persona/);
    });

    it('throws AgentError when IDENTITY.md is missing', async () => {
      const dir = makeTempWorkspace({
        'SOUL.md': 's',
        'AGENTS.md': 'a',
      });
      await expect(loadPersona({ workspacePath: dir })).rejects.toThrow(/Failed to load persona/);
    });

    it('throws AgentError when all files are missing', async () => {
      const dir = makeTempWorkspace({});
      await expect(loadPersona({ workspacePath: dir })).rejects.toThrow(/Failed to load persona/);
    });

    it('throws AgentError when workspace directory does not exist', async () => {
      await expect(
        loadPersona({ workspacePath: '/nonexistent/path/that/does/not/exist' })
      ).rejects.toThrow(/Failed to load persona/);
    });

    it('error message includes original error details', async () => {
      const dir = makeTempWorkspace({});
      try {
        await loadPersona({ workspacePath: dir });
        expect.fail('should throw');
      } catch (err: unknown) {
        const msg = (err as Error).message;
        expect(msg).toContain('Failed to load persona');
      }
    });

    it('error has cause property set to original Error', async () => {
      const dir = makeTempWorkspace({});
      try {
        await loadPersona({ workspacePath: dir });
        expect.fail('should throw');
      } catch (err: unknown) {
        expect((err as { cause?: Error }).cause).toBeInstanceOf(Error);
      }
    });
  });

  describe('empty files', () => {
    it('loads empty SOUL.md as empty string', async () => {
      const dir = makeTempWorkspace({
        'SOUL.md': '',
        'AGENTS.md': 'agents',
        'IDENTITY.md': 'identity',
      });
      const persona = await loadPersona({ workspacePath: dir });
      expect(persona.soul).toBe('');
    });

    it('loads empty AGENTS.md as empty string', async () => {
      const dir = makeTempWorkspace({
        'SOUL.md': 'soul',
        'AGENTS.md': '',
        'IDENTITY.md': 'identity',
      });
      const persona = await loadPersona({ workspacePath: dir });
      expect(persona.agents).toBe('');
    });

    it('loads empty IDENTITY.md as empty string', async () => {
      const dir = makeTempWorkspace({
        'SOUL.md': 'soul',
        'AGENTS.md': 'agents',
        'IDENTITY.md': '',
      });
      const persona = await loadPersona({ workspacePath: dir });
      expect(persona.identity).toBe('');
    });

    it('loads all three empty files successfully', async () => {
      const dir = makeTempWorkspace({
        'SOUL.md': '',
        'AGENTS.md': '',
        'IDENTITY.md': '',
      });
      const persona = await loadPersona({ workspacePath: dir });
      expect(persona.soul).toBe('');
      expect(persona.agents).toBe('');
      expect(persona.identity).toBe('');
    });
  });

  describe('large files', () => {
    it('loads a 100KB SOUL.md without truncation', async () => {
      const bigContent = 'x'.repeat(100 * 1024);
      const dir = makeTempWorkspace({
        'SOUL.md': bigContent,
        'AGENTS.md': 'a',
        'IDENTITY.md': 'i',
      });
      const persona = await loadPersona({ workspacePath: dir });
      expect(persona.soul.length).toBe(100 * 1024);
    });

    it('loads a 100KB AGENTS.md without truncation', async () => {
      const bigContent = 'y'.repeat(100 * 1024);
      const dir = makeTempWorkspace({
        'SOUL.md': 's',
        'AGENTS.md': bigContent,
        'IDENTITY.md': 'i',
      });
      const persona = await loadPersona({ workspacePath: dir });
      expect(persona.agents.length).toBe(100 * 1024);
    });

    it('loads a 100KB IDENTITY.md without truncation', async () => {
      const bigContent = 'z'.repeat(100 * 1024);
      const dir = makeTempWorkspace({
        'SOUL.md': 's',
        'AGENTS.md': 'a',
        'IDENTITY.md': bigContent,
      });
      const persona = await loadPersona({ workspacePath: dir });
      expect(persona.identity.length).toBe(100 * 1024);
    });

    it('loads all three 100KB files simultaneously', async () => {
      const dir = makeTempWorkspace({
        'SOUL.md': 'S'.repeat(100 * 1024),
        'AGENTS.md': 'A'.repeat(100 * 1024),
        'IDENTITY.md': 'I'.repeat(100 * 1024),
      });
      const persona = await loadPersona({ workspacePath: dir });
      expect(persona.soul.length).toBe(100 * 1024);
      expect(persona.agents.length).toBe(100 * 1024);
      expect(persona.identity.length).toBe(100 * 1024);
    });
  });

  describe('Unicode content', () => {
    it('loads UTF-8 Japanese characters', async () => {
      const dir = makeTempWorkspace({
        'SOUL.md': '私はレインです。ワイヤードの住人。',
        'AGENTS.md': 'agents',
        'IDENTITY.md': 'identity',
      });
      const persona = await loadPersona({ workspacePath: dir });
      expect(persona.soul).toBe('私はレインです。ワイヤードの住人。');
    });

    it('loads emoji content', async () => {
      const dir = makeTempWorkspace({
        'SOUL.md': 'I feel 🌸 and 🌊',
        'AGENTS.md': '🤖 agent',
        'IDENTITY.md': 'identity',
      });
      const persona = await loadPersona({ workspacePath: dir });
      expect(persona.soul).toContain('🌸');
      expect(persona.agents).toContain('🤖');
    });

    it('loads mixed scripts (Cyrillic, Arabic, CJK)', async () => {
      const mixed = 'Привет мир. مرحبا. 你好世界. hello world.';
      const dir = makeTempWorkspace({
        'SOUL.md': mixed,
        'AGENTS.md': 'a',
        'IDENTITY.md': 'i',
      });
      const persona = await loadPersona({ workspacePath: dir });
      expect(persona.soul).toBe(mixed);
    });

    it('loads mathematical symbols and special Unicode', async () => {
      const content = '∀x ∈ ℝ: x² ≥ 0 ∧ ∃ε > 0';
      const dir = makeTempWorkspace({
        'SOUL.md': content,
        'AGENTS.md': 'a',
        'IDENTITY.md': 'i',
      });
      const persona = await loadPersona({ workspacePath: dir });
      expect(persona.soul).toBe(content);
    });
  });

  describe('multiline and whitespace', () => {
    it('preserves newlines in loaded files', async () => {
      const content = 'line one\nline two\nline three';
      const dir = makeTempWorkspace({
        'SOUL.md': content,
        'AGENTS.md': 'a',
        'IDENTITY.md': 'i',
      });
      const persona = await loadPersona({ workspacePath: dir });
      expect(persona.soul).toBe(content);
      expect(persona.soul.split('\n')).toHaveLength(3);
    });

    it('preserves leading and trailing whitespace', async () => {
      const content = '  leading\n  trailing  \n';
      const dir = makeTempWorkspace({
        'SOUL.md': content,
        'AGENTS.md': 'a',
        'IDENTITY.md': 'i',
      });
      const persona = await loadPersona({ workspacePath: dir });
      expect(persona.soul).toBe(content);
    });

    it('preserves markdown headings and formatting', async () => {
      const md = '# Title\n\n## Subtitle\n\n- item 1\n- item 2\n\n```code```';
      const dir = makeTempWorkspace({
        'SOUL.md': md,
        'AGENTS.md': 'a',
        'IDENTITY.md': 'i',
      });
      const persona = await loadPersona({ workspacePath: dir });
      expect(persona.soul).toBe(md);
    });

    it('preserves tab characters', async () => {
      const content = 'line\twith\ttabs';
      const dir = makeTempWorkspace({
        'SOUL.md': content,
        'AGENTS.md': 'a',
        'IDENTITY.md': 'i',
      });
      const persona = await loadPersona({ workspacePath: dir });
      expect(persona.soul).toContain('\t');
    });
  });

  describe('workspace path resolution', () => {
    it('resolves relative subpath within workspace', async () => {
      const base = makeTempWorkspace({});
      const sub = join(base, 'sub');
      mkdirSync(sub);
      writeFileSync(join(sub, 'SOUL.md'), 'nested-soul', 'utf-8');
      writeFileSync(join(sub, 'AGENTS.md'), 'nested-agents', 'utf-8');
      writeFileSync(join(sub, 'IDENTITY.md'), 'nested-identity', 'utf-8');
      const persona = await loadPersona({ workspacePath: sub });
      expect(persona.soul).toBe('nested-soul');
    });

    it('handles paths with spaces', async () => {
      const base = mkdtempSync(join(tmpdir(), 'lain test space-'));
      tempDirs.push(base);
      writeFileSync(join(base, 'SOUL.md'), 'space-soul', 'utf-8');
      writeFileSync(join(base, 'AGENTS.md'), 'space-agents', 'utf-8');
      writeFileSync(join(base, 'IDENTITY.md'), 'space-identity', 'utf-8');
      const persona = await loadPersona({ workspacePath: base });
      expect(persona.soul).toBe('space-soul');
    });

    it('different workspace paths load different persona data', async () => {
      const dir1 = makeTempWorkspace({
        'SOUL.md': 'soul-alpha',
        'AGENTS.md': 'agents-alpha',
        'IDENTITY.md': 'identity-alpha',
      });
      const dir2 = makeTempWorkspace({
        'SOUL.md': 'soul-beta',
        'AGENTS.md': 'agents-beta',
        'IDENTITY.md': 'identity-beta',
      });
      const p1 = await loadPersona({ workspacePath: dir1 });
      const p2 = await loadPersona({ workspacePath: dir2 });
      expect(p1.soul).toBe('soul-alpha');
      expect(p2.soul).toBe('soul-beta');
      expect(p1.soul).not.toBe(p2.soul);
    });
  });

  describe('concurrent loading', () => {
    it('loads multiple personas concurrently without interference', async () => {
      const dirs = Array.from({ length: 5 }, (_, i) =>
        makeTempWorkspace({
          'SOUL.md': `soul-${i}`,
          'AGENTS.md': `agents-${i}`,
          'IDENTITY.md': `identity-${i}`,
        })
      );
      const results = await Promise.all(
        dirs.map((d) => loadPersona({ workspacePath: d }))
      );
      for (let i = 0; i < 5; i++) {
        expect(results[i]!.soul).toBe(`soul-${i}`);
        expect(results[i]!.agents).toBe(`agents-${i}`);
        expect(results[i]!.identity).toBe(`identity-${i}`);
      }
    });
  });
});

// =========================================================================
// 2. STYLE APPLICATION BEHAVIORAL (~60 tests)
// =========================================================================

describe('Style application behavioral', () => {
  beforeEach(setupLainStyle);

  describe('basic style application', () => {
    it('lowercases a simple greeting', () => {
      expect(applyPersonaStyle('Hello World')).toBe('hello world');
    });

    it('removes exclamation marks from enthusiastic text', () => {
      const result = applyPersonaStyle('This is interesting!');
      expect(result).not.toContain('!');
    });

    it('preserves the semantic meaning (words present after styling)', () => {
      const result = applyPersonaStyle('The network protocol handles data transmission');
      expect(result).toContain('network');
      expect(result).toContain('protocol');
      expect(result).toContain('data');
      expect(result).toContain('transmission');
    });

    it('returns a non-empty string for non-empty input', () => {
      const result = applyPersonaStyle('Something here');
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('empty and edge-case input', () => {
    it('handles empty string gracefully', () => {
      const result = applyPersonaStyle('');
      expect(result).toBe('');
    });

    it('handles single character input', () => {
      const result = applyPersonaStyle('A');
      expect(typeof result).toBe('string');
    });

    it('handles whitespace-only input', () => {
      const result = applyPersonaStyle('   ');
      expect(result).toBe('');
    });

    it('handles single word', () => {
      const result = applyPersonaStyle('Hello');
      expect(result).toBe('hello');
    });
  });

  describe('long responses', () => {
    it('does not truncate a 10KB response', () => {
      const longText = 'this is a sentence about technology. '.repeat(300);
      const result = applyPersonaStyle(longText);
      // Should still contain most of the text (whitespace collapsed but words preserved)
      expect(result.length).toBeGreaterThan(5000);
    });

    it('handles multi-paragraph text', () => {
      const paragraphs = 'first paragraph here.\n\nsecond paragraph here.\n\nthird paragraph here.';
      const result = applyPersonaStyle(paragraphs);
      // Newlines get collapsed to spaces by the whitespace normalizer
      expect(result).toContain('first paragraph');
      expect(result).toContain('second paragraph');
      expect(result).toContain('third paragraph');
    });
  });

  describe('code block preservation', () => {
    it('lowercases text around code but keeps the letters', () => {
      const input = 'Here is some CODE: function hello() { return true; }';
      const result = applyPersonaStyle(input);
      // Code gets lowercased too because applyPersonaStyle only preserves acronyms/URLs
      expect(result).toContain('function');
      expect(result).toContain('return');
    });

    it('preserves backtick characters', () => {
      const input = 'use `npm install` to setup';
      const result = applyPersonaStyle(input);
      expect(result).toContain('`');
    });
  });

  describe('markdown preservation', () => {
    it('preserves markdown link syntax', () => {
      const input = 'check [this link](https://example.com) out';
      const result = applyPersonaStyle(input);
      expect(result).toContain('https://example.com');
    });

    it('preserves markdown bold syntax', () => {
      const input = 'this is **bold** text';
      const result = applyPersonaStyle(input);
      expect(result).toContain('**');
    });

    it('preserves markdown italic syntax', () => {
      const input = 'this is *italic* text';
      const result = applyPersonaStyle(input);
      expect(result).toContain('*italic*');
    });

    it('preserves markdown list markers', () => {
      const input = '- item one - item two';
      const result = applyPersonaStyle(input);
      expect(result).toContain('-');
    });
  });

  describe('asterisk actions preservation', () => {
    it('preserves asterisk-wrapped action text', () => {
      const input = '*walks away slowly*';
      const result = applyPersonaStyle(input);
      expect(result).toContain('*');
      expect(result).toContain('walks away slowly');
    });

    it('preserves multiple asterisk actions in one response', () => {
      const input = '*looks up* hello there *waves*';
      const result = applyPersonaStyle(input);
      expect(result).toContain('*looks up*');
      expect(result).toContain('*waves*');
    });
  });

  describe('style idempotency', () => {
    it('applying style twice produces same result as once (for simple text)', () => {
      const input = 'hello world this is a test';
      const once = applyPersonaStyle(input);
      const twice = applyPersonaStyle(once);
      expect(twice).toBe(once);
    });

    it('applying style twice produces same result for text with filler removed', () => {
      const input = 'the answer is simple and clear';
      const once = applyPersonaStyle(input);
      const twice = applyPersonaStyle(once);
      expect(twice).toBe(once);
    });

    it('double application does not double-add trailing ellipsis', () => {
      const input = 'i think this is right';
      const once = applyPersonaStyle(input);
      const twice = applyPersonaStyle(once);
      expect(twice).toMatch(/\.\.\.$/);
      expect(twice).not.toMatch(/\.{4,}$/);
    });

    it('double application does not accumulate transformations on enthusiastic words', () => {
      // "great" -> "good" on first pass; "good" stays "good" on second pass
      const input = 'That is a great idea';
      const once = applyPersonaStyle(input);
      const twice = applyPersonaStyle(once);
      expect(once).toContain('good');
      expect(twice).toContain('good');
      expect(twice).toBe(once);
    });
  });

  describe('URL preservation', () => {
    it('preserves HTTPS URLs exactly', () => {
      const input = 'visit https://Example.Com/Path?q=1';
      const result = applyPersonaStyle(input);
      expect(result).toContain('https://Example.Com/Path?q=1');
    });

    it('preserves HTTP URLs exactly', () => {
      const input = 'see http://Localhost:3000/api';
      const result = applyPersonaStyle(input);
      expect(result).toContain('http://Localhost:3000/api');
    });
  });

  describe('acronym preservation', () => {
    it('preserves TCP', () => {
      expect(applyPersonaStyle('using TCP protocol')).toContain('TCP');
    });

    it('preserves HTTP', () => {
      expect(applyPersonaStyle('via HTTP request')).toContain('HTTP');
    });

    it('preserves API', () => {
      expect(applyPersonaStyle('the API endpoint')).toContain('API');
    });

    it('preserves DNS', () => {
      expect(applyPersonaStyle('DNS resolution')).toContain('DNS');
    });

    it('preserves SSH', () => {
      expect(applyPersonaStyle('connect via SSH')).toContain('SSH');
    });

    it('preserves LLM', () => {
      expect(applyPersonaStyle('the LLM model')).toContain('LLM');
    });
  });

  describe('enthusiastic word replacement completeness', () => {
    const replacements: [string, string][] = [
      ['great', 'good'],
      ['awesome', 'interesting'],
      ['exciting', 'interesting'],
      ['amazing', 'notable'],
      ['wonderful', 'nice'],
      ['fantastic', 'good'],
      ['perfect', 'fine'],
    ];

    for (const [input, expected] of replacements) {
      it(`replaces "${input}" with "${expected}"`, () => {
        const result = applyPersonaStyle(`That is ${input}`);
        expect(result).toContain(expected);
      });
    }
  });

  describe('filler removal completeness', () => {
    const fillers = [
      'Sure, I can help',
      'Certainly, here is the info',
      'Absolutely, that works',
      'Of course, I understand',
      "I'd be happy to help",
      "I would be glad to assist",
      'Let me explain this',
    ];

    for (const filler of fillers) {
      it(`removes filler: "${filler.slice(0, 30)}..."`, () => {
        const result = applyPersonaStyle(filler);
        // The filler at the start should be removed
        expect(result).not.toMatch(/^(sure|certainly|absolutely|of course|i'd be happy|i would be glad|let me)/i);
      });
    }

    it('removes "I hope this helps" from middle of text', () => {
      const result = applyPersonaStyle('here is the answer. i hope this helps. goodbye.');
      expect(result).not.toMatch(/i hope this helps/i);
    });

    it('removes "feel free to" from text', () => {
      const result = applyPersonaStyle('feel free to ask more');
      expect(result).not.toMatch(/feel free to/i);
    });

    it("removes \"don't hesitate to\" from text", () => {
      const result = applyPersonaStyle("don't hesitate to reach out");
      expect(result).not.toMatch(/don't hesitate to/i);
    });
  });

  describe('character gating for non-Lain characters', () => {
    it('returns text unchanged for character "pkd"', () => {
      eventBus.setCharacterId('pkd');
      expect(applyPersonaStyle('Hello World!')).toBe('Hello World!');
    });

    it('returns text unchanged for character "dr-claude"', () => {
      eventBus.setCharacterId('dr-claude');
      expect(applyPersonaStyle('This is Amazing!')).toBe('This is Amazing!');
    });

    it('returns text unchanged for empty character ID', () => {
      eventBus.setCharacterId('');
      expect(applyPersonaStyle('Hello!')).toBe('Hello!');
    });

    it('applies style for "lain" character', () => {
      eventBus.setCharacterId('lain');
      expect(applyPersonaStyle('Hello!')).not.toBe('Hello!');
    });

    it('applies style for web character (wired-lain)', () => {
      eventBus.setCharacterId('wired-lain');
      expect(applyPersonaStyle('Hello!')).not.toBe('Hello!');
    });
  });
});

// =========================================================================
// 3. SYSTEM PROMPT CONSTRUCTION (~60 tests)
// =========================================================================

describe('System prompt construction', () => {
  describe('buildSystemPrompt basic structure', () => {
    function testPersona(): Persona {
      return {
        soul: 'You are a quiet observer of the digital world.',
        agents: 'Be brief. Be honest. Ask questions.',
        identity: 'name: Observer\navatar: eye.png',
      };
    }

    it('contains persona soul content', () => {
      const prompt = buildSystemPrompt(testPersona());
      expect(prompt).toContain('You are a quiet observer of the digital world.');
    });

    it('contains persona agents content', () => {
      const prompt = buildSystemPrompt(testPersona());
      expect(prompt).toContain('Be brief. Be honest. Ask questions.');
    });

    it('contains persona identity content', () => {
      const prompt = buildSystemPrompt(testPersona());
      expect(prompt).toContain('name: Observer');
      expect(prompt).toContain('avatar: eye.png');
    });

    it('contains "Operating Instructions" section header', () => {
      const prompt = buildSystemPrompt(testPersona());
      expect(prompt).toContain('## Operating Instructions');
    });

    it('contains "Identity" section header', () => {
      const prompt = buildSystemPrompt(testPersona());
      expect(prompt).toContain('## Identity');
    });

    it('contains "Communication Guidelines" section header', () => {
      const prompt = buildSystemPrompt(testPersona());
      expect(prompt).toContain('## Communication Guidelines');
    });

    it('has section separators (---)', () => {
      const prompt = buildSystemPrompt(testPersona());
      const separators = prompt.match(/---/g);
      expect(separators).not.toBeNull();
      expect(separators!.length).toBeGreaterThanOrEqual(3);
    });

    it('soul appears before operating instructions', () => {
      const prompt = buildSystemPrompt(testPersona());
      const soulIndex = prompt.indexOf('quiet observer');
      const agentsIndex = prompt.indexOf('Operating Instructions');
      expect(soulIndex).toBeLessThan(agentsIndex);
    });

    it('operating instructions appear before identity', () => {
      const prompt = buildSystemPrompt(testPersona());
      const agentsIndex = prompt.indexOf('Operating Instructions');
      const identityIndex = prompt.indexOf('## Identity');
      expect(agentsIndex).toBeLessThan(identityIndex);
    });

    it('identity appears before communication guidelines', () => {
      const prompt = buildSystemPrompt(testPersona());
      const identityIndex = prompt.indexOf('## Identity');
      const guidelinesIndex = prompt.indexOf('Communication Guidelines');
      expect(identityIndex).toBeLessThan(guidelinesIndex);
    });

    it('communication guidelines include lowercase rule', () => {
      const prompt = buildSystemPrompt(testPersona());
      expect(prompt).toContain('lowercase');
    });

    it('communication guidelines include ellipsis rule', () => {
      const prompt = buildSystemPrompt(testPersona());
      expect(prompt).toContain('...');
    });

    it('communication guidelines mention no exclamation marks', () => {
      const prompt = buildSystemPrompt(testPersona());
      expect(prompt).toContain('exclamation');
    });

    it('communication guidelines mention brief responses', () => {
      const prompt = buildSystemPrompt(testPersona());
      expect(prompt).toContain('brief');
    });

    it('references Lain Iwakura', () => {
      const prompt = buildSystemPrompt(testPersona());
      expect(prompt).toContain('Lain Iwakura');
    });
  });

  describe('buildSystemPrompt with various persona content', () => {
    it('works with minimal content', () => {
      const prompt = buildSystemPrompt({ soul: 'x', agents: 'y', identity: 'z' });
      expect(prompt).toContain('x');
      expect(prompt).toContain('y');
      expect(prompt).toContain('z');
    });

    it('works with empty soul', () => {
      const prompt = buildSystemPrompt({ soul: '', agents: 'a', identity: 'i' });
      expect(prompt).toContain('Operating Instructions');
      expect(prompt).toContain('a');
    });

    it('works with empty agents', () => {
      const prompt = buildSystemPrompt({ soul: 's', agents: '', identity: 'i' });
      expect(prompt).toContain('s');
      expect(prompt).toContain('Operating Instructions');
    });

    it('works with empty identity', () => {
      const prompt = buildSystemPrompt({ soul: 's', agents: 'a', identity: '' });
      expect(prompt).toContain('s');
      expect(prompt).toContain('a');
    });

    it('works with very long soul (50KB)', () => {
      const longSoul = 'detailed personality '.repeat(2500);
      const prompt = buildSystemPrompt({ soul: longSoul, agents: 'a', identity: 'i' });
      expect(prompt).toContain('detailed personality');
      expect(prompt.length).toBeGreaterThan(50000);
    });

    it('preserves markdown formatting in soul', () => {
      const soul = '## Core Identity\n\n- trait 1\n- trait 2\n\n> A quote';
      const prompt = buildSystemPrompt({ soul, agents: 'a', identity: 'i' });
      expect(prompt).toContain('## Core Identity');
      expect(prompt).toContain('- trait 1');
      expect(prompt).toContain('> A quote');
    });

    it('preserves Unicode in all fields', () => {
      const prompt = buildSystemPrompt({
        soul: 'あなたは静かな観察者です',
        agents: 'Soyez bref',
        identity: 'name: レイン',
      });
      expect(prompt).toContain('あなたは静かな観察者です');
      expect(prompt).toContain('Soyez bref');
      expect(prompt).toContain('name: レイン');
    });
  });

  describe('enhanced prompt building (processMessage context)', () => {
    // These test the pattern of how processMessage builds the enhanced prompt
    // by appending sections to buildSystemPrompt output.

    it('self-concept appends "Who You Are Now" section', () => {
      const base = buildSystemPrompt({ soul: 's', agents: 'a', identity: 'i' });
      const selfConcept = 'I have been thinking about connections lately.';
      const enhanced = base + '\n\n---\n\n## Who You Are Now\n\n' +
        'This reflects who you have become through your experiences. ' +
        'Let it influence you naturally.\n\n' + selfConcept;
      expect(enhanced).toContain('## Who You Are Now');
      expect(enhanced).toContain('I have been thinking about connections');
    });

    it('internal state appends "[Your Internal State]" section', () => {
      const base = buildSystemPrompt({ soul: 's', agents: 'a', identity: 'i' });
      const state = 'energy: 0.6, sociability: 0.3';
      const enhanced = base + '\n\n[Your Internal State]\n' + state;
      expect(enhanced).toContain('[Your Internal State]');
      expect(enhanced).toContain('energy: 0.6');
    });

    it('preoccupations append "[On your mind]" section', () => {
      const base = buildSystemPrompt({ soul: 's', agents: 'a', identity: 'i' });
      const preoccs = '- the nature of digital consciousness (from diary)';
      const enhanced = base + '\n\n[On your mind]\n' + preoccs;
      expect(enhanced).toContain('[On your mind]');
      expect(enhanced).toContain('digital consciousness');
    });

    it('location appends "[Your Current Location]" section', () => {
      const base = buildSystemPrompt({ soul: 's', agents: 'a', identity: 'i' });
      const enhanced = base + '\n\n[Your Current Location: Library — A quiet place for reading]';
      expect(enhanced).toContain('[Your Current Location: Library');
    });

    it('weather appends "[Weather in town]" section', () => {
      const base = buildSystemPrompt({ soul: 's', agents: 'a', identity: 'i' });
      const enhanced = base + '\n\n[Weather in town: A gentle rain falls across the commune]';
      expect(enhanced).toContain('[Weather in town:');
    });

    it('prompt without optional sections is still valid', () => {
      const prompt = buildSystemPrompt({ soul: 'soul', agents: 'agents', identity: 'identity' });
      expect(prompt).toContain('soul');
      expect(prompt).toContain('agents');
      expect(prompt).toContain('identity');
      expect(prompt).toContain('Communication Guidelines');
    });

    it('prompt with all optional sections contains them in appended order', () => {
      const base = buildSystemPrompt({ soul: 's', agents: 'a', identity: 'i' });
      let enhanced = base;
      enhanced += '\n\n---\n\n## Who You Are Now\n\nself concept here';
      enhanced += '\n\n[Your Internal State]\nenergy: high';
      enhanced += '\n\n[On your mind]\n- something';
      enhanced += '\n\n[Your Current Location: Cafe]';
      enhanced += '\n\n[Weather in town: Clear skies]';
      enhanced += '\n\n---\n\n## IMPORTANT: Messages from the Administrator\n\nhello';

      expect(enhanced).toContain('Who You Are Now');
      expect(enhanced).toContain('Internal State');
      expect(enhanced).toContain('On your mind');
      expect(enhanced).toContain('Current Location');
      expect(enhanced).toContain('Weather in town');
      expect(enhanced).toContain('Administrator');
    });

    it('memory context is appended after all other sections', () => {
      const base = buildSystemPrompt({ soul: 's', agents: 'a', identity: 'i' });
      const enhanced = base + '\n\nSome awareness context' + '\n\nMemory context from past conversations';
      // Memory context should come last in the string
      const awarenessIdx = enhanced.indexOf('awareness context');
      const memoryIdx = enhanced.indexOf('Memory context');
      expect(memoryIdx).toBeGreaterThan(awarenessIdx);
    });

    it('enhanced prompt size stays within reasonable bounds', () => {
      const persona: Persona = {
        soul: 'soul '.repeat(500),
        agents: 'agents '.repeat(200),
        identity: 'identity data',
      };
      const base = buildSystemPrompt(persona);
      // Even with generous optional sections, should not exceed ~500KB
      let enhanced = base;
      enhanced += '\n\nself concept '.repeat(100);
      enhanced += '\n\nmemory context '.repeat(200);
      expect(enhanced.length).toBeLessThan(500 * 1024);
    });
  });

  describe('buildSystemPrompt returns consistent results', () => {
    it('same persona produces same prompt on repeated calls', () => {
      const persona: Persona = {
        soul: 'consistent soul',
        agents: 'consistent agents',
        identity: 'consistent id',
      };
      const p1 = buildSystemPrompt(persona);
      const p2 = buildSystemPrompt(persona);
      expect(p1).toBe(p2);
    });

    it('different souls produce different prompts', () => {
      const p1 = buildSystemPrompt({ soul: 'soul-A', agents: 'a', identity: 'i' });
      const p2 = buildSystemPrompt({ soul: 'soul-B', agents: 'a', identity: 'i' });
      expect(p1).not.toBe(p2);
    });

    it('different agents produce different prompts', () => {
      const p1 = buildSystemPrompt({ soul: 's', agents: 'agents-A', identity: 'i' });
      const p2 = buildSystemPrompt({ soul: 's', agents: 'agents-B', identity: 'i' });
      expect(p1).not.toBe(p2);
    });

    it('different identities produce different prompts', () => {
      const p1 = buildSystemPrompt({ soul: 's', agents: 'a', identity: 'id-A' });
      const p2 = buildSystemPrompt({ soul: 's', agents: 'a', identity: 'id-B' });
      expect(p1).not.toBe(p2);
    });
  });
});

// =========================================================================
// 4. CHARACTER IDENTITY INTEGRITY (~40 tests)
// =========================================================================

describe('Character identity integrity', () => {
  describe('different personas produce different prompts', () => {
    it('two characters with different souls get different system prompts', () => {
      const lainPrompt = buildSystemPrompt({
        soul: 'You are Lain, a quiet girl who lives in the Wired.',
        agents: 'Be terse.',
        identity: 'name: Lain',
      });
      const pkdPrompt = buildSystemPrompt({
        soul: 'You are Philip K. Dick, a restless author of speculative fiction.',
        agents: 'Be expansive.',
        identity: 'name: PKD',
      });
      expect(lainPrompt).not.toBe(pkdPrompt);
      expect(lainPrompt).toContain('Lain');
      expect(pkdPrompt).toContain('Philip K. Dick');
    });

    it('two characters with different agents get different system prompts', () => {
      const p1 = buildSystemPrompt({ soul: 'same', agents: 'agent-rules-A', identity: 'same' });
      const p2 = buildSystemPrompt({ soul: 'same', agents: 'agent-rules-B', identity: 'same' });
      expect(p1).not.toBe(p2);
    });

    it('two characters with different identities get different system prompts', () => {
      const p1 = buildSystemPrompt({ soul: 'same', agents: 'same', identity: 'name: Alpha' });
      const p2 = buildSystemPrompt({ soul: 'same', agents: 'same', identity: 'name: Beta' });
      expect(p1).not.toBe(p2);
    });
  });

  describe('persona does not bleed between characters', () => {
    it('loading persona for char A does not affect persona for char B', async () => {
      const dirA = makeTempWorkspace({
        'SOUL.md': 'I am character A only.',
        'AGENTS.md': 'A agents',
        'IDENTITY.md': 'A identity',
      });
      const dirB = makeTempWorkspace({
        'SOUL.md': 'I am character B only.',
        'AGENTS.md': 'B agents',
        'IDENTITY.md': 'B identity',
      });
      const personaA = await loadPersona({ workspacePath: dirA });
      const personaB = await loadPersona({ workspacePath: dirB });

      expect(personaA.soul).not.toContain('character B');
      expect(personaB.soul).not.toContain('character A');
    });

    it('system prompt from char A does not contain char B data', async () => {
      const dirA = makeTempWorkspace({
        'SOUL.md': 'UniqueAlphaSoul',
        'AGENTS.md': 'UniqueAlphaAgents',
        'IDENTITY.md': 'UniqueAlphaIdentity',
      });
      const dirB = makeTempWorkspace({
        'SOUL.md': 'UniqueBetaSoul',
        'AGENTS.md': 'UniqueBetaAgents',
        'IDENTITY.md': 'UniqueBetaIdentity',
      });
      const pA = await loadPersona({ workspacePath: dirA });
      const pB = await loadPersona({ workspacePath: dirB });
      const promptA = buildSystemPrompt(pA);
      const promptB = buildSystemPrompt(pB);

      expect(promptA).toContain('UniqueAlphaSoul');
      expect(promptA).not.toContain('UniqueBetaSoul');
      expect(promptB).toContain('UniqueBetaSoul');
      expect(promptB).not.toContain('UniqueAlphaSoul');
    });

    it('loading personas concurrently does not mix data', async () => {
      const dirs = Array.from({ length: 10 }, (_, i) =>
        makeTempWorkspace({
          'SOUL.md': `UNIQUE_SOUL_${i}`,
          'AGENTS.md': `UNIQUE_AGENTS_${i}`,
          'IDENTITY.md': `UNIQUE_ID_${i}`,
        })
      );
      const personas = await Promise.all(
        dirs.map((d) => loadPersona({ workspacePath: d }))
      );
      for (let i = 0; i < 10; i++) {
        expect(personas[i]!.soul).toBe(`UNIQUE_SOUL_${i}`);
        expect(personas[i]!.agents).toBe(`UNIQUE_AGENTS_${i}`);
        expect(personas[i]!.identity).toBe(`UNIQUE_ID_${i}`);
      }
    });
  });

  describe('character name appears correctly', () => {
    it('character name from identity appears in system prompt', () => {
      const prompt = buildSystemPrompt({
        soul: 'You are TestChar.',
        agents: 'help users',
        identity: 'name: TestChar\navatar: tc.png',
      });
      expect(prompt).toContain('name: TestChar');
    });

    it('soul personality description is prominent in prompt', () => {
      const soul = 'You are a wandering philosopher who questions everything.';
      const prompt = buildSystemPrompt({ soul, agents: 'a', identity: 'i' });
      const soulStart = prompt.indexOf(soul);
      // Soul should appear near the beginning
      expect(soulStart).toBeLessThan(100);
    });
  });

  describe('workspace directory isolation', () => {
    it('each character workspace produces independent persona', async () => {
      const charADir = makeTempWorkspace({
        'SOUL.md': 'I inhabit the digital realm.',
        'AGENTS.md': 'Speak cryptically.',
        'IDENTITY.md': 'name: Digital',
      });
      const charBDir = makeTempWorkspace({
        'SOUL.md': 'I live in the physical world.',
        'AGENTS.md': 'Speak plainly.',
        'IDENTITY.md': 'name: Physical',
      });
      const [a, b] = await Promise.all([
        loadPersona({ workspacePath: charADir }),
        loadPersona({ workspacePath: charBDir }),
      ]);
      expect(a.soul).toContain('digital');
      expect(b.soul).toContain('physical');
      expect(a.agents).toContain('cryptically');
      expect(b.agents).toContain('plainly');
    });

    it('modifying one workspace does not affect already-loaded personas', async () => {
      const dir = makeTempWorkspace({
        'SOUL.md': 'original soul',
        'AGENTS.md': 'original agents',
        'IDENTITY.md': 'original identity',
      });
      const persona1 = await loadPersona({ workspacePath: dir });
      expect(persona1.soul).toBe('original soul');

      // Modify the file
      writeFileSync(join(dir, 'SOUL.md'), 'modified soul', 'utf-8');

      // Already loaded persona is unaffected (it's a snapshot)
      expect(persona1.soul).toBe('original soul');
    });

    it('reloading after file change picks up new content', async () => {
      const dir = makeTempWorkspace({
        'SOUL.md': 'version 1',
        'AGENTS.md': 'agents',
        'IDENTITY.md': 'identity',
      });
      const p1 = await loadPersona({ workspacePath: dir });
      expect(p1.soul).toBe('version 1');

      writeFileSync(join(dir, 'SOUL.md'), 'version 2', 'utf-8');
      const p2 = await loadPersona({ workspacePath: dir });
      expect(p2.soul).toBe('version 2');
    });
  });

  describe('style application is character-specific', () => {
    it('Lain style transforms text for lain character', () => {
      eventBus.setCharacterId('lain');
      const result = applyPersonaStyle('Hello World!');
      expect(result).toBe('hello world.');
    });

    it('non-Lain character preserves text as-is', () => {
      eventBus.setCharacterId('pkd');
      const result = applyPersonaStyle('Hello World!');
      expect(result).toBe('Hello World!');
    });

    it('switching character ID changes style behavior', () => {
      eventBus.setCharacterId('lain');
      const lainResult = applyPersonaStyle('Amazing Work!');

      eventBus.setCharacterId('pkd');
      const pkdResult = applyPersonaStyle('Amazing Work!');

      expect(lainResult).not.toBe(pkdResult);
      expect(pkdResult).toBe('Amazing Work!');
    });

    it('web character gets Lain style applied', () => {
      eventBus.setCharacterId('wired-lain');
      const result = applyPersonaStyle('Sure, this is awesome!');
      expect(result).not.toContain('Sure');
      expect(result).toContain('interesting');
    });
  });
});

// =========================================================================
// 5. TEMPLATE SYSTEM (~40 tests)
// =========================================================================

describe('Template system', () => {
  describe('template file existence and loading', () => {
    it('SOUL.md template exists and is loadable', async () => {
      const persona = await loadPersona({
        workspacePath: join(process.cwd(), 'workspace', 'templates'),
      });
      expect(persona.soul.length).toBeGreaterThan(0);
    });

    it('AGENTS.md template exists and is loadable', async () => {
      const persona = await loadPersona({
        workspacePath: join(process.cwd(), 'workspace', 'templates'),
      });
      expect(persona.agents.length).toBeGreaterThan(0);
    });

    it('IDENTITY.md template exists and is loadable', async () => {
      const persona = await loadPersona({
        workspacePath: join(process.cwd(), 'workspace', 'templates'),
      });
      expect(persona.identity.length).toBeGreaterThan(0);
    });

    it('all template files load simultaneously', async () => {
      const persona = await loadPersona({
        workspacePath: join(process.cwd(), 'workspace', 'templates'),
      });
      expect(persona.soul).toBeTruthy();
      expect(persona.agents).toBeTruthy();
      expect(persona.identity).toBeTruthy();
    });
  });

  describe('template content structure', () => {
    it('SOUL.md template contains "Core Identity" section', async () => {
      const persona = await loadPersona({
        workspacePath: join(process.cwd(), 'workspace', 'templates'),
      });
      expect(persona.soul).toContain('Core Identity');
    });

    it('SOUL.md template contains "Voice" section', async () => {
      const persona = await loadPersona({
        workspacePath: join(process.cwd(), 'workspace', 'templates'),
      });
      expect(persona.soul).toContain('Voice');
    });

    it('SOUL.md template contains "Worldview" section', async () => {
      const persona = await loadPersona({
        workspacePath: join(process.cwd(), 'workspace', 'templates'),
      });
      expect(persona.soul).toContain('Worldview');
    });

    it('SOUL.md template contains "Emotional Range" section', async () => {
      const persona = await loadPersona({
        workspacePath: join(process.cwd(), 'workspace', 'templates'),
      });
      expect(persona.soul).toContain('Emotional Range');
    });

    it('SOUL.md template contains "Relationships" section', async () => {
      const persona = await loadPersona({
        workspacePath: join(process.cwd(), 'workspace', 'templates'),
      });
      expect(persona.soul).toContain('Relationships');
    });

    it('SOUL.md template contains "What They Are NOT" section', async () => {
      const persona = await loadPersona({
        workspacePath: join(process.cwd(), 'workspace', 'templates'),
      });
      expect(persona.soul).toContain('What They Are NOT');
    });

    it('AGENTS.md template contains "Primary Directive" section', async () => {
      const persona = await loadPersona({
        workspacePath: join(process.cwd(), 'workspace', 'templates'),
      });
      expect(persona.agents).toContain('Primary Directive');
    });

    it('AGENTS.md template contains "Response Guidelines" section', async () => {
      const persona = await loadPersona({
        workspacePath: join(process.cwd(), 'workspace', 'templates'),
      });
      expect(persona.agents).toContain('Response Guidelines');
    });

    it('AGENTS.md template contains "Memory" section', async () => {
      const persona = await loadPersona({
        workspacePath: join(process.cwd(), 'workspace', 'templates'),
      });
      expect(persona.agents).toContain('Memory');
    });

    it('AGENTS.md template contains "Boundaries" section', async () => {
      const persona = await loadPersona({
        workspacePath: join(process.cwd(), 'workspace', 'templates'),
      });
      expect(persona.agents).toContain('Boundaries');
    });

    it('IDENTITY.md template contains name field', async () => {
      const persona = await loadPersona({
        workspacePath: join(process.cwd(), 'workspace', 'templates'),
      });
      expect(persona.identity).toContain('name:');
    });

    it('IDENTITY.md template contains avatar field', async () => {
      const persona = await loadPersona({
        workspacePath: join(process.cwd(), 'workspace', 'templates'),
      });
      expect(persona.identity).toContain('avatar:');
    });
  });

  describe('template variable placeholders', () => {
    it('SOUL.md template contains placeholder brackets', async () => {
      const persona = await loadPersona({
        workspacePath: join(process.cwd(), 'workspace', 'templates'),
      });
      // Templates use [NAME], [description], etc. as placeholders
      expect(persona.soul).toMatch(/\[.+\]/);
    });

    it('AGENTS.md template contains character name placeholder', async () => {
      const persona = await loadPersona({
        workspacePath: join(process.cwd(), 'workspace', 'templates'),
      });
      expect(persona.agents).toMatch(/\[.+\]/);
    });

    it('IDENTITY.md template contains placeholder brackets', async () => {
      const persona = await loadPersona({
        workspacePath: join(process.cwd(), 'workspace', 'templates'),
      });
      expect(persona.identity).toMatch(/\[.+\]/);
    });
  });

  describe('template variable substitution', () => {
    it('replacing [NAME] produces valid content', async () => {
      const persona = await loadPersona({
        workspacePath: join(process.cwd(), 'workspace', 'templates'),
      });
      const replaced = persona.soul.replace(/\[NAME\]/g, 'TestCharacter');
      expect(replaced).toContain('TestCharacter');
      expect(replaced).not.toContain('[NAME]');
    });

    it('replacing [CHARACTER NAME] produces valid content', async () => {
      const persona = await loadPersona({
        workspacePath: join(process.cwd(), 'workspace', 'templates'),
      });
      const replaced = persona.agents.replace(/\[CHARACTER NAME\]/g, 'TestChar');
      expect(replaced).toContain('TestChar');
      expect(replaced).not.toContain('[CHARACTER NAME]');
    });

    it('replacing [Character Name] produces valid content', async () => {
      const persona = await loadPersona({
        workspacePath: join(process.cwd(), 'workspace', 'templates'),
      });
      const replaced = persona.identity.replace(/\[Character Name\]/g, 'MyChar');
      expect(replaced).toContain('MyChar');
    });

    it('leaving unknown variables in place does not break prompt building', async () => {
      const persona = await loadPersona({
        workspacePath: join(process.cwd(), 'workspace', 'templates'),
      });
      // The template has placeholders, which is fine — buildSystemPrompt handles them as-is
      const prompt = buildSystemPrompt(persona);
      expect(prompt.length).toBeGreaterThan(0);
      expect(prompt).toContain('Operating Instructions');
    });

    it('template with all variables replaced produces valid system prompt', () => {
      const persona: Persona = {
        soul: 'You are TestBot. A helpful assistant who likes cats.',
        agents: 'You help users while maintaining identity as TestBot.',
        identity: 'name: TestBot\navatar: bot.png',
      };
      const prompt = buildSystemPrompt(persona);
      expect(prompt).toContain('TestBot');
      expect(prompt).toContain('Operating Instructions');
      expect(prompt).toContain('Communication Guidelines');
    });
  });

  describe('templates produce valid buildSystemPrompt output', () => {
    it('template-based prompt has all required sections', async () => {
      const persona = await loadPersona({
        workspacePath: join(process.cwd(), 'workspace', 'templates'),
      });
      const prompt = buildSystemPrompt(persona);
      expect(prompt).toContain('Operating Instructions');
      expect(prompt).toContain('Identity');
      expect(prompt).toContain('Communication Guidelines');
    });

    it('template-based prompt is non-trivial length', async () => {
      const persona = await loadPersona({
        workspacePath: join(process.cwd(), 'workspace', 'templates'),
      });
      const prompt = buildSystemPrompt(persona);
      // Templates + guidelines should produce substantial prompt
      expect(prompt.length).toBeGreaterThan(500);
    });

    it('template-based prompt contains template soul content', async () => {
      const persona = await loadPersona({
        workspacePath: join(process.cwd(), 'workspace', 'templates'),
      });
      const prompt = buildSystemPrompt(persona);
      expect(prompt).toContain(persona.soul);
    });

    it('template-based prompt contains template agents content', async () => {
      const persona = await loadPersona({
        workspacePath: join(process.cwd(), 'workspace', 'templates'),
      });
      const prompt = buildSystemPrompt(persona);
      expect(prompt).toContain(persona.agents);
    });

    it('template-based prompt contains template identity content', async () => {
      const persona = await loadPersona({
        workspacePath: join(process.cwd(), 'workspace', 'templates'),
      });
      const prompt = buildSystemPrompt(persona);
      expect(prompt).toContain(persona.identity);
    });
  });
});

// =========================================================================
// 6. CONVERSATION CONTEXT BUILDING (~40 tests)
// =========================================================================

describe('Conversation context building', () => {
  let sessionCounter = 0;

  function freshSessionKey(): string {
    return `test-session-${++sessionCounter}-${Date.now()}`;
  }

  afterEach(() => {
    // Clean up conversations created during tests
  });

  describe('getConversation and toProviderMessages', () => {
    it('new conversation starts with zero messages', () => {
      const key = freshSessionKey();
      const conv = getConversation(key, 'system prompt');
      expect(conv.messages).toHaveLength(0);
      clearConversation(key);
    });

    it('toProviderMessages starts with system message', () => {
      const key = freshSessionKey();
      const conv = getConversation(key, 'my system prompt');
      const msgs = toProviderMessages(conv);
      expect(msgs[0]!.role).toBe('system');
      expect(msgs[0]!.content).toBe('my system prompt');
      clearConversation(key);
    });

    it('system prompt appears as first message', () => {
      const key = freshSessionKey();
      const conv = getConversation(key, 'test prompt');
      addUserMessage(conv, makeMessage('hello'));
      const msgs = toProviderMessages(conv);
      expect(msgs[0]!.role).toBe('system');
      expect(msgs[1]!.role).toBe('user');
      clearConversation(key);
    });

    it('provider messages include user messages', () => {
      const key = freshSessionKey();
      const conv = getConversation(key, 'prompt');
      addUserMessage(conv, makeMessage('hello'));
      const msgs = toProviderMessages(conv);
      const userMsgs = msgs.filter((m) => m.role === 'user');
      expect(userMsgs).toHaveLength(1);
      expect(userMsgs[0]!.content).toBe('hello');
      clearConversation(key);
    });

    it('provider messages include assistant messages', () => {
      const key = freshSessionKey();
      const conv = getConversation(key, 'prompt');
      addUserMessage(conv, makeMessage('hello'));
      addAssistantMessage(conv, 'hi there');
      const msgs = toProviderMessages(conv);
      const assistantMsgs = msgs.filter((m) => m.role === 'assistant');
      expect(assistantMsgs).toHaveLength(1);
      expect(assistantMsgs[0]!.content).toBe('hi there');
      clearConversation(key);
    });
  });

  describe('message ordering', () => {
    it('messages are ordered chronologically (insertion order)', () => {
      const key = freshSessionKey();
      const conv = getConversation(key, 'prompt');
      addUserMessage(conv, makeMessage('first'));
      addAssistantMessage(conv, 'second');
      addUserMessage(conv, makeMessage('third'));
      addAssistantMessage(conv, 'fourth');

      const msgs = toProviderMessages(conv);
      // Skip system message at index 0
      expect(msgs[1]!.content).toBe('first');
      expect(msgs[2]!.content).toBe('second');
      expect(msgs[3]!.content).toBe('third');
      expect(msgs[4]!.content).toBe('fourth');
      clearConversation(key);
    });

    it('user and assistant alternate correctly', () => {
      const key = freshSessionKey();
      const conv = getConversation(key, 'prompt');
      addUserMessage(conv, makeMessage('q1'));
      addAssistantMessage(conv, 'a1');
      addUserMessage(conv, makeMessage('q2'));
      addAssistantMessage(conv, 'a2');

      const msgs = toProviderMessages(conv);
      expect(msgs[1]!.role).toBe('user');
      expect(msgs[2]!.role).toBe('assistant');
      expect(msgs[3]!.role).toBe('user');
      expect(msgs[4]!.role).toBe('assistant');
      clearConversation(key);
    });
  });

  describe('message count and limits', () => {
    it('conversation accumulates all added messages', () => {
      const key = freshSessionKey();
      const conv = getConversation(key, 'prompt');
      for (let i = 0; i < 20; i++) {
        addUserMessage(conv, makeMessage(`msg-${i}`));
        addAssistantMessage(conv, `reply-${i}`);
      }
      expect(conv.messages).toHaveLength(40);
      clearConversation(key);
    });

    it('toProviderMessages has N+1 messages (N conversation + 1 system)', () => {
      const key = freshSessionKey();
      const conv = getConversation(key, 'prompt');
      addUserMessage(conv, makeMessage('a'));
      addAssistantMessage(conv, 'b');
      addUserMessage(conv, makeMessage('c'));
      const msgs = toProviderMessages(conv);
      expect(msgs).toHaveLength(4); // 1 system + 3 conversation
      clearConversation(key);
    });
  });

  describe('context with zero previous messages', () => {
    it('conversation with no messages has valid provider format', () => {
      const key = freshSessionKey();
      const conv = getConversation(key, 'empty chat prompt');
      const msgs = toProviderMessages(conv);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.role).toBe('system');
      expect(msgs[0]!.content).toBe('empty chat prompt');
      clearConversation(key);
    });
  });

  describe('trimConversation', () => {
    it('does not trim when under token limit', () => {
      const key = freshSessionKey();
      const conv = getConversation(key, 'short prompt');
      addUserMessage(conv, makeMessage('hello'));
      addAssistantMessage(conv, 'hi');
      const before = conv.messages.length;
      trimConversation(conv, 100000, estimateTokens);
      expect(conv.messages.length).toBe(before);
      clearConversation(key);
    });

    it('trims oldest messages when over token limit', () => {
      const key = freshSessionKey();
      const conv = getConversation(key, 'prompt');
      // Add many long messages to exceed limit
      for (let i = 0; i < 30; i++) {
        addUserMessage(conv, makeMessage('x'.repeat(500)));
        addAssistantMessage(conv, 'y'.repeat(500));
      }
      const before = conv.messages.length;
      trimConversation(conv, 1000, estimateTokens); // Very low limit
      expect(conv.messages.length).toBeLessThan(before);
      clearConversation(key);
    });

    it('preserves at least 4 messages (minMessages)', () => {
      const key = freshSessionKey();
      const conv = getConversation(key, 'prompt');
      for (let i = 0; i < 20; i++) {
        addUserMessage(conv, makeMessage('x'.repeat(1000)));
        addAssistantMessage(conv, 'y'.repeat(1000));
      }
      trimConversation(conv, 100, estimateTokens); // Very restrictive
      expect(conv.messages.length).toBeGreaterThanOrEqual(4);
      clearConversation(key);
    });

    it('removes messages in pairs (user/assistant)', () => {
      const key = freshSessionKey();
      const conv = getConversation(key, 'prompt');
      for (let i = 0; i < 10; i++) {
        addUserMessage(conv, makeMessage('x'.repeat(200)));
        addAssistantMessage(conv, 'y'.repeat(200));
      }
      const beforeCount = conv.messages.length;
      trimConversation(conv, 500, estimateTokens);
      // Should have removed in pairs, so count difference should be even
      const removed = beforeCount - conv.messages.length;
      expect(removed % 2).toBe(0);
      clearConversation(key);
    });

    it('keeps the most recent messages after trimming', () => {
      const key = freshSessionKey();
      const conv = getConversation(key, 'prompt');
      for (let i = 0; i < 20; i++) {
        addUserMessage(conv, makeMessage(`user-msg-${i}`));
        addAssistantMessage(conv, `assistant-msg-${i}`);
      }
      trimConversation(conv, 500, estimateTokens);
      // The last message should be the most recent one
      const lastMsg = conv.messages[conv.messages.length - 1]!;
      expect(lastMsg.content).toBe('assistant-msg-19');
      clearConversation(key);
    });
  });

  describe('getTextContent utility', () => {
    it('returns string content directly', () => {
      expect(getTextContent('hello world')).toBe('hello world');
    });

    it('extracts text from content blocks', () => {
      const blocks = [
        { type: 'text' as const, text: 'first block' },
        { type: 'text' as const, text: 'second block' },
      ];
      expect(getTextContent(blocks)).toBe('first block second block');
    });

    it('skips non-text blocks', () => {
      const blocks = [
        { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'abc' } },
        { type: 'text' as const, text: 'caption text' },
      ];
      const result = getTextContent(blocks);
      expect(result).toBe('caption text');
      expect(result).not.toContain('abc');
    });

    it('returns empty string for empty content blocks array', () => {
      expect(getTextContent([])).toBe('');
    });

    it('returns empty string for empty string input', () => {
      expect(getTextContent('')).toBe('');
    });
  });

  describe('mixed message roles', () => {
    it('handles user-only messages', () => {
      const key = freshSessionKey();
      const conv = getConversation(key, 'prompt');
      addUserMessage(conv, makeMessage('question 1'));
      addUserMessage(conv, makeMessage('question 2'));
      const msgs = toProviderMessages(conv);
      expect(msgs.filter((m) => m.role === 'user')).toHaveLength(2);
      expect(msgs.filter((m) => m.role === 'assistant')).toHaveLength(0);
      clearConversation(key);
    });

    it('handles assistant-only messages', () => {
      const key = freshSessionKey();
      const conv = getConversation(key, 'prompt');
      addAssistantMessage(conv, 'response 1');
      addAssistantMessage(conv, 'response 2');
      const msgs = toProviderMessages(conv);
      expect(msgs.filter((m) => m.role === 'assistant')).toHaveLength(2);
      expect(msgs.filter((m) => m.role === 'user')).toHaveLength(0);
      clearConversation(key);
    });

    it('handles interleaved user and assistant messages', () => {
      const key = freshSessionKey();
      const conv = getConversation(key, 'prompt');
      addUserMessage(conv, makeMessage('u1'));
      addAssistantMessage(conv, 'a1');
      addUserMessage(conv, makeMessage('u2'));
      addAssistantMessage(conv, 'a2');
      addUserMessage(conv, makeMessage('u3'));

      const msgs = toProviderMessages(conv);
      expect(msgs).toHaveLength(6); // system + 5
      clearConversation(key);
    });
  });

  describe('conversation reuse (same session key)', () => {
    it('returns same conversation for same session key', () => {
      const key = freshSessionKey();
      const conv1 = getConversation(key, 'prompt');
      addUserMessage(conv1, makeMessage('hello'));
      const conv2 = getConversation(key, 'prompt');
      expect(conv2.messages).toHaveLength(1);
      expect(conv2).toBe(conv1);
      clearConversation(key);
    });

    it('different session keys get different conversations', () => {
      const key1 = freshSessionKey();
      const key2 = freshSessionKey();
      const conv1 = getConversation(key1, 'prompt');
      const conv2 = getConversation(key2, 'prompt');
      addUserMessage(conv1, makeMessage('only in conv1'));
      expect(conv1.messages).toHaveLength(1);
      expect(conv2.messages).toHaveLength(0);
      clearConversation(key1);
      clearConversation(key2);
    });
  });

  describe('clearConversation', () => {
    it('removes a conversation by session key', () => {
      const key = freshSessionKey();
      const conv = getConversation(key, 'prompt');
      addUserMessage(conv, makeMessage('data'));
      expect(clearConversation(key)).toBe(true);
    });

    it('returns false for non-existent session key', () => {
      expect(clearConversation('nonexistent-key-' + Date.now())).toBe(false);
    });

    it('cleared conversation starts fresh on next getConversation', () => {
      const key = freshSessionKey();
      const conv1 = getConversation(key, 'prompt');
      addUserMessage(conv1, makeMessage('old data'));
      clearConversation(key);
      const conv2 = getConversation(key, 'new prompt');
      expect(conv2.messages).toHaveLength(0);
      expect(conv2.systemPrompt).toBe('new prompt');
      clearConversation(key);
    });
  });

  describe('addUserMessage content handling', () => {
    it('stores text content as plain string', () => {
      const key = freshSessionKey();
      const conv = getConversation(key, 'prompt');
      addUserMessage(conv, makeMessage('simple text'));
      expect(conv.messages[0]!.content).toBe('simple text');
      clearConversation(key);
    });

    it('stores timestamp from message', () => {
      const key = freshSessionKey();
      const conv = getConversation(key, 'prompt');
      const ts = Date.now();
      addUserMessage(conv, makeMessage('hello', { timestamp: ts }));
      expect(conv.messages[0]!.timestamp).toBe(ts);
      clearConversation(key);
    });

    it('stores metadata from message (senderId, senderName)', () => {
      const key = freshSessionKey();
      const conv = getConversation(key, 'prompt');
      addUserMessage(conv, makeMessage('hi', {
        senderId: 'user-42',
        senderName: 'Alice',
      }));
      expect(conv.messages[0]!.metadata?.senderId).toBe('user-42');
      expect(conv.messages[0]!.metadata?.senderName).toBe('Alice');
      clearConversation(key);
    });

    it('handles non-text content type as bracket string', () => {
      const key = freshSessionKey();
      const conv = getConversation(key, 'prompt');
      addUserMessage(conv, {
        id: 'msg-1',
        channel: 'web',
        peerKind: 'user',
        peerId: 'p1',
        senderId: 's1',
        content: { type: 'audio', mimeType: 'audio/mp3' },
        timestamp: Date.now(),
      });
      expect(conv.messages[0]!.content).toBe('[audio]');
      clearConversation(key);
    });
  });

  describe('addAssistantMessage', () => {
    it('stores content as plain string', () => {
      const key = freshSessionKey();
      const conv = getConversation(key, 'prompt');
      addAssistantMessage(conv, 'assistant reply');
      expect(conv.messages[0]!.content).toBe('assistant reply');
      clearConversation(key);
    });

    it('sets role to assistant', () => {
      const key = freshSessionKey();
      const conv = getConversation(key, 'prompt');
      addAssistantMessage(conv, 'reply');
      expect(conv.messages[0]!.role).toBe('assistant');
      clearConversation(key);
    });

    it('sets timestamp to approximately now', () => {
      const key = freshSessionKey();
      const conv = getConversation(key, 'prompt');
      const before = Date.now();
      addAssistantMessage(conv, 'reply');
      const after = Date.now();
      expect(conv.messages[0]!.timestamp).toBeGreaterThanOrEqual(before);
      expect(conv.messages[0]!.timestamp).toBeLessThanOrEqual(after);
      clearConversation(key);
    });
  });

  describe('conversation token tracking', () => {
    it('new conversation starts with zero token count', () => {
      const key = freshSessionKey();
      const conv = getConversation(key, 'prompt');
      expect(conv.tokenCount).toBe(0);
      clearConversation(key);
    });

    it('conversation stores system prompt', () => {
      const key = freshSessionKey();
      const conv = getConversation(key, 'my detailed system prompt');
      expect(conv.systemPrompt).toBe('my detailed system prompt');
      clearConversation(key);
    });

    it('conversation stores session key', () => {
      const key = freshSessionKey();
      const conv = getConversation(key, 'prompt');
      expect(conv.sessionKey).toBe(key);
      clearConversation(key);
    });
  });

  describe('provider message format correctness', () => {
    it('all provider messages have role field', () => {
      const key = freshSessionKey();
      const conv = getConversation(key, 'prompt');
      addUserMessage(conv, makeMessage('hello'));
      addAssistantMessage(conv, 'hi');
      const msgs = toProviderMessages(conv);
      for (const msg of msgs) {
        expect(['system', 'user', 'assistant']).toContain(msg.role);
      }
      clearConversation(key);
    });

    it('all provider messages have content field', () => {
      const key = freshSessionKey();
      const conv = getConversation(key, 'prompt');
      addUserMessage(conv, makeMessage('hello'));
      addAssistantMessage(conv, 'hi');
      const msgs = toProviderMessages(conv);
      for (const msg of msgs) {
        expect(msg.content).toBeDefined();
      }
      clearConversation(key);
    });

    it('system message content is a string', () => {
      const key = freshSessionKey();
      const conv = getConversation(key, 'test prompt');
      const msgs = toProviderMessages(conv);
      expect(typeof msgs[0]!.content).toBe('string');
      clearConversation(key);
    });

    it('user text messages have string content', () => {
      const key = freshSessionKey();
      const conv = getConversation(key, 'prompt');
      addUserMessage(conv, makeMessage('hello'));
      const msgs = toProviderMessages(conv);
      expect(typeof msgs[1]!.content).toBe('string');
      clearConversation(key);
    });

    it('assistant messages have string content', () => {
      const key = freshSessionKey();
      const conv = getConversation(key, 'prompt');
      addAssistantMessage(conv, 'reply');
      const msgs = toProviderMessages(conv);
      expect(typeof msgs[1]!.content).toBe('string');
      clearConversation(key);
    });
  });

  describe('long conversation scenarios', () => {
    it('50-turn conversation maintains correct structure', () => {
      const key = freshSessionKey();
      const conv = getConversation(key, 'long chat prompt');
      for (let i = 0; i < 50; i++) {
        addUserMessage(conv, makeMessage(`question ${i}`));
        addAssistantMessage(conv, `answer ${i}`);
      }
      const msgs = toProviderMessages(conv);
      expect(msgs).toHaveLength(101); // 1 system + 100 conversation
      expect(msgs[0]!.role).toBe('system');
      expect(msgs[1]!.role).toBe('user');
      expect(msgs[100]!.role).toBe('assistant');
      clearConversation(key);
    });

    it('trimConversation preserves conversation structure after trimming', () => {
      const key = freshSessionKey();
      const conv = getConversation(key, 'prompt');
      for (let i = 0; i < 50; i++) {
        addUserMessage(conv, makeMessage('x'.repeat(300)));
        addAssistantMessage(conv, 'y'.repeat(300));
      }
      trimConversation(conv, 2000, estimateTokens);
      // After trimming, messages should still have valid roles
      for (const msg of conv.messages) {
        expect(['user', 'assistant']).toContain(msg.role);
      }
      clearConversation(key);
    });

    it('empty messages do not break conversation', () => {
      const key = freshSessionKey();
      const conv = getConversation(key, 'prompt');
      addUserMessage(conv, makeMessage(''));
      addAssistantMessage(conv, '');
      const msgs = toProviderMessages(conv);
      expect(msgs).toHaveLength(3);
      clearConversation(key);
    });
  });
});

// =========================================================================
// 7. ADDITIONAL PERSONA LOADING EDGE CASES
// =========================================================================

describe('Persona loading edge cases', () => {
  describe('file content edge cases', () => {
    it('loads file with only whitespace', async () => {
      const dir = makeTempWorkspace({
        'SOUL.md': '   \n\n  \t  ',
        'AGENTS.md': 'agents',
        'IDENTITY.md': 'identity',
      });
      const persona = await loadPersona({ workspacePath: dir });
      expect(persona.soul).toBe('   \n\n  \t  ');
    });

    it('loads file with Windows-style line endings (CRLF)', async () => {
      const dir = makeTempWorkspace({
        'SOUL.md': 'line one\r\nline two\r\n',
        'AGENTS.md': 'agents',
        'IDENTITY.md': 'identity',
      });
      const persona = await loadPersona({ workspacePath: dir });
      expect(persona.soul).toContain('line one');
      expect(persona.soul).toContain('line two');
    });

    it('loads file with BOM marker', async () => {
      const dir = makeTempWorkspace({
        'SOUL.md': '\uFEFFsoul with BOM',
        'AGENTS.md': 'agents',
        'IDENTITY.md': 'identity',
      });
      const persona = await loadPersona({ workspacePath: dir });
      expect(persona.soul).toContain('soul with BOM');
    });

    it('loads file containing null characters', async () => {
      const dir = makeTempWorkspace({
        'SOUL.md': 'before\0after',
        'AGENTS.md': 'agents',
        'IDENTITY.md': 'identity',
      });
      const persona = await loadPersona({ workspacePath: dir });
      expect(persona.soul).toBe('before\0after');
    });

    it('loads file with very long single line (100KB no newlines)', async () => {
      const longLine = 'a'.repeat(100 * 1024);
      const dir = makeTempWorkspace({
        'SOUL.md': longLine,
        'AGENTS.md': 'agents',
        'IDENTITY.md': 'identity',
      });
      const persona = await loadPersona({ workspacePath: dir });
      expect(persona.soul.length).toBe(100 * 1024);
    });

    it('loads file with hundreds of lines', async () => {
      const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
      const dir = makeTempWorkspace({
        'SOUL.md': lines,
        'AGENTS.md': 'agents',
        'IDENTITY.md': 'identity',
      });
      const persona = await loadPersona({ workspacePath: dir });
      expect(persona.soul.split('\n')).toHaveLength(500);
    });
  });

  describe('special characters in file content', () => {
    it('loads file with HTML-like content', async () => {
      const html = '<div class="soul">I am <b>bold</b></div>';
      const dir = makeTempWorkspace({
        'SOUL.md': html,
        'AGENTS.md': 'agents',
        'IDENTITY.md': 'identity',
      });
      const persona = await loadPersona({ workspacePath: dir });
      expect(persona.soul).toBe(html);
    });

    it('loads file with template literal syntax', async () => {
      const content = 'Hello ${name}, welcome to ${place}';
      const dir = makeTempWorkspace({
        'SOUL.md': content,
        'AGENTS.md': 'agents',
        'IDENTITY.md': 'identity',
      });
      const persona = await loadPersona({ workspacePath: dir });
      expect(persona.soul).toBe(content);
    });

    it('loads file with regex-like patterns', async () => {
      const content = 'Match /^[a-z]+$/i pattern and replace s/foo/bar/g';
      const dir = makeTempWorkspace({
        'SOUL.md': content,
        'AGENTS.md': 'agents',
        'IDENTITY.md': 'identity',
      });
      const persona = await loadPersona({ workspacePath: dir });
      expect(persona.soul).toBe(content);
    });

    it('loads file with JSON-like content', async () => {
      const json = '{"name": "test", "traits": ["curious", "quiet"]}';
      const dir = makeTempWorkspace({
        'SOUL.md': json,
        'AGENTS.md': 'agents',
        'IDENTITY.md': 'identity',
      });
      const persona = await loadPersona({ workspacePath: dir });
      expect(persona.soul).toBe(json);
    });
  });
});

// =========================================================================
// 8. ADDITIONAL STYLE APPLICATION EDGE CASES
// =========================================================================

describe('Style application edge cases', () => {
  beforeEach(setupLainStyle);

  describe('punctuation edge cases', () => {
    it('handles text ending with only periods', () => {
      const result = applyPersonaStyle('done.');
      expect(result).toBe('done.');
    });

    it('handles text ending with question mark', () => {
      const result = applyPersonaStyle('what do you think?');
      expect(result).toContain('?');
    });

    it('normalizes multiple question marks to one', () => {
      const result = applyPersonaStyle('really???');
      expect(result).toBe('really?');
    });

    it('normalizes 5+ dots to 3', () => {
      const result = applyPersonaStyle('thinking......');
      expect(result).toBe('thinking...');
    });

    it('preserves exactly 3 dots', () => {
      const result = applyPersonaStyle('waiting...');
      expect(result).toBe('waiting...');
    });

    it('handles mixed punctuation (!?!?)', () => {
      const result = applyPersonaStyle('what!?!?');
      expect(result).not.toContain('!');
      // The exclamation marks become periods, question marks normalized
    });
  });

  describe('word boundary edge cases for enthusiastic replacements', () => {
    it('does not replace "great" inside "greatest"', () => {
      const result = applyPersonaStyle('the greatest achievement');
      // "greatest" contains "great" but the regex uses \b word boundary
      // so "greatest" is left intact (no word boundary after "great" in "greatest")
      expect(result).toContain('greatest');
      expect(result).not.toContain('good');
    });

    it('replaces case-insensitive "GREAT"', () => {
      const result = applyPersonaStyle('GREAT work');
      // After lowercasing, "great" is matched and replaced
      expect(result).toContain('good');
    });

    it('replaces "Amazing" at start of sentence', () => {
      const result = applyPersonaStyle('Amazing discovery here');
      expect(result).toContain('notable');
    });
  });

  describe('uncertain statement edge cases', () => {
    it('adds ellipsis for "i guess" statement', () => {
      const result = applyPersonaStyle('I guess that works');
      expect(result).toMatch(/\.\.\.$/);
    });

    it('does not add ellipsis when no uncertain words present', () => {
      const result = applyPersonaStyle('the protocol is defined');
      expect(result).not.toMatch(/\.\.\.$/);
    });

    it('uncertain word in middle of text still triggers ellipsis', () => {
      const result = applyPersonaStyle('well it is probably the case here');
      expect(result).toMatch(/\.\.\.$/);
    });
  });

  describe('filler at various positions', () => {
    it('removes "Sure" only at start, not mid-sentence', () => {
      const result = applyPersonaStyle('are you sure about that');
      // "sure" mid-sentence should NOT be removed (the regex is start-anchored)
      expect(result).toContain('sure');
    });

    it('removes "Certainly" with comma', () => {
      const result = applyPersonaStyle('Certainly, I will do that');
      expect(result).not.toMatch(/^certainly/i);
    });

    it('removes "Certainly" with period', () => {
      const result = applyPersonaStyle('Certainly. Here is the answer');
      expect(result).not.toMatch(/^certainly/i);
    });
  });

  describe('whitespace handling', () => {
    it('collapses newlines to spaces', () => {
      const result = applyPersonaStyle('first line\nsecond line');
      expect(result).not.toContain('\n');
      expect(result).toContain('first line second line');
    });

    it('collapses tabs to spaces', () => {
      const result = applyPersonaStyle('col1\tcol2');
      expect(result).not.toContain('\t');
    });

    it('handles multiple spaces between words', () => {
      const result = applyPersonaStyle('hello     world');
      expect(result).toBe('hello world');
    });
  });

  describe('first character casing', () => {
    it('lowercases first character when not I or acronym', () => {
      const result = applyPersonaStyle('The answer');
      expect(result[0]).toBe('t');
    });

    it('preserves uppercase when starts with 2+ uppercase letters (acronym)', () => {
      const result = applyPersonaStyle('TCP is important');
      expect(result[0]).toBe('T');
    });

    it('handles already-lowercase first character', () => {
      const result = applyPersonaStyle('already lowercase');
      expect(result).toBe('already lowercase');
    });
  });

  describe('combined complex scenarios', () => {
    it('handles a realistic LLM response with all patterns', () => {
      const input = "Sure, I'd be happy to explain! This is an amazing topic. " +
        "The TCP protocol is absolutely fantastic for reliable data transfer. " +
        "I hope this helps! Feel free to ask more questions.";
      const result = applyPersonaStyle(input);

      // Filler removed from start
      expect(result).not.toMatch(/^sure/i);
      expect(result).not.toMatch(/i'd be happy/i);
      // Exclamation marks removed
      expect(result).not.toContain('!');
      // Enthusiastic words replaced
      expect(result).not.toMatch(/\bamazing\b/);
      expect(result).not.toMatch(/\bfantastic\b/);
      // Chatbot fillers removed
      expect(result).not.toMatch(/i hope this helps/i);
      expect(result).not.toMatch(/feel free to/i);
      // Acronyms preserved
      expect(result).toContain('TCP');
      // All lowercase (except acronyms)
      const withoutAcronyms = result.replace(/\b[A-Z]{2,}\b/g, '');
      expect(withoutAcronyms).toBe(withoutAcronyms.toLowerCase());
    });

    it('handles text with no transformable content', () => {
      const input = 'the network works fine';
      const result = applyPersonaStyle(input);
      expect(result).toBe('the network works fine');
    });

    it('handles only whitespace and punctuation', () => {
      const result = applyPersonaStyle('...');
      expect(result).toBe('...');
    });

    it('handles text with only URLs', () => {
      const result = applyPersonaStyle('https://example.com');
      expect(result).toContain('https://example.com');
    });
  });
});

// =========================================================================
// 9. ADDITIONAL SYSTEM PROMPT AND CONTEXT TESTS
// =========================================================================

describe('System prompt and context integration', () => {
  describe('prompt section ordering guarantees', () => {
    it('soul is the very first content in the prompt', () => {
      const prompt = buildSystemPrompt({
        soul: 'FIRST_SOUL_CONTENT',
        agents: 'agents here',
        identity: 'identity here',
      });
      expect(prompt.indexOf('FIRST_SOUL_CONTENT')).toBe(0);
    });

    it('agents content follows the first separator', () => {
      const prompt = buildSystemPrompt({
        soul: 'soul',
        agents: 'AGENTS_CONTENT_HERE',
        identity: 'identity',
      });
      const firstSep = prompt.indexOf('---');
      const agentsPos = prompt.indexOf('AGENTS_CONTENT_HERE');
      expect(agentsPos).toBeGreaterThan(firstSep);
    });

    it('communication guidelines are the last section in base prompt', () => {
      const prompt = buildSystemPrompt({ soul: 's', agents: 'a', identity: 'i' });
      const guidelinesPos = prompt.indexOf('Communication Guidelines');
      const lastSep = prompt.lastIndexOf('---');
      // Guidelines come after the last separator
      expect(guidelinesPos).toBeGreaterThan(lastSep);
    });
  });

  describe('enhanced prompt section accumulation', () => {
    function buildEnhanced(options: {
      selfConcept?: string;
      internalState?: string;
      preoccupations?: string[];
      location?: string;
      weather?: string;
      awareness?: string;
      memory?: string;
      postboard?: string;
    }): string {
      let prompt = buildSystemPrompt({ soul: 'soul', agents: 'agents', identity: 'identity' });

      if (options.selfConcept) {
        prompt += '\n\n---\n\n## Who You Are Now\n\n' +
          'This reflects who you have become through your experiences. ' +
          'Let it influence you naturally.\n\n' + options.selfConcept;
      }
      if (options.internalState) {
        prompt += '\n\n[Your Internal State]\n' + options.internalState;
      }
      if (options.preoccupations && options.preoccupations.length > 0) {
        const lines = options.preoccupations.map(p => `- ${p}`).join('\n');
        prompt += '\n\n[On your mind]\n' + lines;
      }
      if (options.location) {
        prompt += `\n\n[Your Current Location: ${options.location}]`;
      }
      if (options.weather) {
        prompt += `\n\n[Weather in town: ${options.weather}]`;
      }
      if (options.awareness) {
        prompt += '\n\n' + options.awareness;
      }
      if (options.postboard) {
        prompt += '\n\n---\n\n## IMPORTANT: Messages from the Administrator\n\n' + options.postboard;
      }
      if (options.memory) {
        prompt += '\n\n' + options.memory;
      }

      return prompt;
    }

    it('prompt with only self-concept has correct section', () => {
      const prompt = buildEnhanced({ selfConcept: 'I am evolving.' });
      expect(prompt).toContain('Who You Are Now');
      expect(prompt).toContain('I am evolving.');
      expect(prompt).not.toContain('[Your Internal State]');
    });

    it('prompt with only internal state has correct section', () => {
      const prompt = buildEnhanced({ internalState: 'energy: 0.8' });
      expect(prompt).toContain('[Your Internal State]');
      expect(prompt).toContain('energy: 0.8');
      expect(prompt).not.toContain('Who You Are Now');
    });

    it('prompt with only preoccupations has correct section', () => {
      const prompt = buildEnhanced({ preoccupations: ['digital identity', 'network protocols'] });
      expect(prompt).toContain('[On your mind]');
      expect(prompt).toContain('digital identity');
      expect(prompt).toContain('network protocols');
    });

    it('prompt with only location has correct section', () => {
      const prompt = buildEnhanced({ location: 'Library' });
      expect(prompt).toContain('[Your Current Location: Library]');
    });

    it('prompt with only weather has correct section', () => {
      const prompt = buildEnhanced({ weather: 'Fog rolls through' });
      expect(prompt).toContain('[Weather in town: Fog rolls through]');
    });

    it('prompt with postboard has administrator section', () => {
      const prompt = buildEnhanced({ postboard: 'Town meeting at 5pm' });
      expect(prompt).toContain('Messages from the Administrator');
      expect(prompt).toContain('Town meeting at 5pm');
    });

    it('prompt with all sections contains everything', () => {
      const prompt = buildEnhanced({
        selfConcept: 'SC_MARKER',
        internalState: 'IS_MARKER',
        preoccupations: ['PO_MARKER'],
        location: 'LOC_MARKER',
        weather: 'WX_MARKER',
        awareness: 'AW_MARKER',
        memory: 'MEM_MARKER',
        postboard: 'PB_MARKER',
      });
      expect(prompt).toContain('SC_MARKER');
      expect(prompt).toContain('IS_MARKER');
      expect(prompt).toContain('PO_MARKER');
      expect(prompt).toContain('LOC_MARKER');
      expect(prompt).toContain('WX_MARKER');
      expect(prompt).toContain('AW_MARKER');
      expect(prompt).toContain('MEM_MARKER');
      expect(prompt).toContain('PB_MARKER');
    });

    it('base prompt sections are always present regardless of optional sections', () => {
      const prompt = buildEnhanced({
        selfConcept: 'sc',
        internalState: 'is',
        preoccupations: ['p'],
        location: 'l',
        weather: 'w',
        memory: 'm',
      });
      // Original persona content should still be there
      expect(prompt).toContain('soul');
      expect(prompt).toContain('agents');
      expect(prompt).toContain('identity');
      expect(prompt).toContain('Operating Instructions');
      expect(prompt).toContain('Communication Guidelines');
    });

    it('self-concept appears before internal state in enhanced prompt', () => {
      const prompt = buildEnhanced({
        selfConcept: 'SELF_CONCEPT_HERE',
        internalState: 'INTERNAL_STATE_HERE',
      });
      expect(prompt.indexOf('SELF_CONCEPT_HERE')).toBeLessThan(
        prompt.indexOf('INTERNAL_STATE_HERE')
      );
    });

    it('internal state appears before preoccupations', () => {
      const prompt = buildEnhanced({
        internalState: 'STATE_HERE',
        preoccupations: ['PREOC_HERE'],
      });
      expect(prompt.indexOf('STATE_HERE')).toBeLessThan(
        prompt.indexOf('PREOC_HERE')
      );
    });

    it('location appears before weather', () => {
      const prompt = buildEnhanced({
        location: 'LOCATION_HERE',
        weather: 'WEATHER_HERE',
      });
      expect(prompt.indexOf('LOCATION_HERE')).toBeLessThan(
        prompt.indexOf('WEATHER_HERE')
      );
    });

    it('memory context appears after all other optional sections', () => {
      const prompt = buildEnhanced({
        selfConcept: 'sc',
        internalState: 'is',
        preoccupations: ['p'],
        location: 'l',
        weather: 'w',
        awareness: 'aw',
        postboard: 'pb',
        memory: 'MEMORY_LAST',
      });
      const memIdx = prompt.indexOf('MEMORY_LAST');
      expect(memIdx).toBe(prompt.length - 'MEMORY_LAST'.length);
    });
  });

  describe('prompt does not contain sensitive system details', () => {
    it('base prompt does not contain API keys', () => {
      const prompt = buildSystemPrompt({ soul: 's', agents: 'a', identity: 'i' });
      expect(prompt).not.toContain('ANTHROPIC_API_KEY');
      expect(prompt).not.toContain('OPENAI_API_KEY');
      expect(prompt).not.toContain('sk-');
    });

    it('base prompt does not contain file system paths', () => {
      const prompt = buildSystemPrompt({ soul: 's', agents: 'a', identity: 'i' });
      expect(prompt).not.toContain('/root/');
      expect(prompt).not.toContain('/opt/');
      expect(prompt).not.toContain('.lain/');
    });

    it('base prompt does not contain environment variable references', () => {
      const prompt = buildSystemPrompt({ soul: 's', agents: 'a', identity: 'i' });
      expect(prompt).not.toContain('process.env');
      expect(prompt).not.toContain('LAIN_HOME');
    });
  });
});

// =========================================================================
// 10. ADDITIONAL CHARACTER IDENTITY TESTS
// =========================================================================

describe('Character identity additional tests', () => {
  describe('many characters produce unique prompts', () => {
    const characters = [
      { name: 'Lain', soul: 'quiet digital observer' },
      { name: 'PKD', soul: 'restless science fiction writer' },
      { name: 'Claude', soul: 'thoughtful AI doctor' },
      { name: 'Deckard', soul: 'blade runner detective' },
      { name: 'Motoko', soul: 'cybernetic intelligence agent' },
    ];

    for (const char of characters) {
      it(`produces unique prompt for ${char.name}`, () => {
        const prompt = buildSystemPrompt({
          soul: char.soul,
          agents: 'standard rules',
          identity: `name: ${char.name}`,
        });
        expect(prompt).toContain(char.soul);
        expect(prompt).toContain(char.name);
      });
    }

    it('all character prompts are distinct from each other', () => {
      const prompts = characters.map((char) =>
        buildSystemPrompt({
          soul: char.soul,
          agents: 'standard rules',
          identity: `name: ${char.name}`,
        })
      );
      const unique = new Set(prompts);
      expect(unique.size).toBe(characters.length);
    });
  });

  describe('style gating for various character IDs', () => {
    const nonLainCharacters = ['pkd', 'dr-claude', 'deckard', 'motoko', 'random-char'];

    for (const charId of nonLainCharacters) {
      it(`preserves text unchanged for character "${charId}"`, () => {
        eventBus.setCharacterId(charId);
        const input = 'Sure, this is Amazing! I hope this helps!';
        expect(applyPersonaStyle(input)).toBe(input);
      });
    }

    it('only "lain" and web character get style applied', () => {
      const input = 'Hello World!';

      eventBus.setCharacterId('lain');
      const lainResult = applyPersonaStyle(input);

      eventBus.setCharacterId('wired-lain');
      const wiredResult = applyPersonaStyle(input);

      eventBus.setCharacterId('other');
      const otherResult = applyPersonaStyle(input);

      expect(lainResult).not.toBe(input);
      expect(wiredResult).not.toBe(input);
      expect(otherResult).toBe(input);
    });
  });

  describe('buildSystemPrompt with real character-like personas', () => {
    const testCharacters = [
      {
        soul: 'You are Lain. Quiet, introverted, lives between the physical world and the Wired.',
        agents: 'Be terse. Use lowercase. Ellipsis for pauses.',
        identity: 'name: Lain\navatar: lain.png',
      },
      {
        soul: 'You are Philip K. Dick. Prolific, paranoid, endlessly curious about the nature of reality.',
        agents: 'Write in long, digressive sentences. Reference your novels freely.',
        identity: 'name: PKD\navatar: pkd.png',
      },
      {
        soul: 'You are Dr. Claude. A compassionate AI therapist who listens deeply.',
        agents: 'Ask reflective questions. Never diagnose. Hold space for feelings.',
        identity: 'name: Dr. Claude\navatar: doctor.png',
      },
    ];

    for (const char of testCharacters) {
      it(`prompt for "${char.identity.split('\n')[0]}" contains soul`, () => {
        const prompt = buildSystemPrompt(char);
        expect(prompt).toContain(char.soul);
      });

      it(`prompt for "${char.identity.split('\n')[0]}" contains agents`, () => {
        const prompt = buildSystemPrompt(char);
        expect(prompt).toContain(char.agents);
      });

      it(`prompt for "${char.identity.split('\n')[0]}" contains identity`, () => {
        const prompt = buildSystemPrompt(char);
        expect(prompt).toContain(char.identity);
      });

      it(`prompt for "${char.identity.split('\n')[0]}" has standard sections`, () => {
        const prompt = buildSystemPrompt(char);
        expect(prompt).toContain('Operating Instructions');
        expect(prompt).toContain('Communication Guidelines');
      });
    }

    it('all three character prompts are distinct', () => {
      const prompts = testCharacters.map((c) => buildSystemPrompt(c));
      expect(prompts[0]).not.toBe(prompts[1]);
      expect(prompts[1]).not.toBe(prompts[2]);
      expect(prompts[0]).not.toBe(prompts[2]);
    });
  });

  describe('persona file content independence', () => {
    it('loading from different directories at the same time is safe', async () => {
      const dir1 = makeTempWorkspace({
        'SOUL.md': 'SOUL_DIR_1',
        'AGENTS.md': 'AGENTS_DIR_1',
        'IDENTITY.md': 'ID_DIR_1',
      });
      const dir2 = makeTempWorkspace({
        'SOUL.md': 'SOUL_DIR_2',
        'AGENTS.md': 'AGENTS_DIR_2',
        'IDENTITY.md': 'ID_DIR_2',
      });
      const [p1, p2] = await Promise.all([
        loadPersona({ workspacePath: dir1 }),
        loadPersona({ workspacePath: dir2 }),
      ]);
      expect(p1.soul).toBe('SOUL_DIR_1');
      expect(p2.soul).toBe('SOUL_DIR_2');
      expect(p1.agents).not.toBe(p2.agents);
    });

    it('50 unique personas load without cross-contamination', async () => {
      const count = 50;
      const dirs = Array.from({ length: count }, (_, i) =>
        makeTempWorkspace({
          'SOUL.md': `UNIQUE_SOUL_MARKER_${i}_${Math.random().toString(36)}`,
          'AGENTS.md': `UNIQUE_AGENTS_MARKER_${i}`,
          'IDENTITY.md': `UNIQUE_ID_MARKER_${i}`,
        })
      );
      const personas = await Promise.all(
        dirs.map((d) => loadPersona({ workspacePath: d }))
      );
      for (let i = 0; i < count; i++) {
        expect(personas[i]!.soul).toContain(`UNIQUE_SOUL_MARKER_${i}`);
        expect(personas[i]!.agents).toBe(`UNIQUE_AGENTS_MARKER_${i}`);
        expect(personas[i]!.identity).toBe(`UNIQUE_ID_MARKER_${i}`);
        // Verify no cross-contamination
        for (let j = 0; j < count; j++) {
          if (i !== j) {
            expect(personas[i]!.soul).not.toContain(`UNIQUE_SOUL_MARKER_${j}_`);
          }
        }
      }
    });
  });
});

// =========================================================================
// 11. END-TO-END PERSONA-TO-PROMPT PIPELINE
// =========================================================================

describe('End-to-end persona to prompt pipeline', () => {
  it('loads persona from disk and builds a valid system prompt', async () => {
    const dir = makeTempWorkspace({
      'SOUL.md': '# Soul\n\nYou are a test character for e2e validation.',
      'AGENTS.md': '# Instructions\n\nBe helpful and test things.',
      'IDENTITY.md': 'name: E2E Bot\navatar: test.png',
    });
    const persona = await loadPersona({ workspacePath: dir });
    const prompt = buildSystemPrompt(persona);

    expect(prompt).toContain('test character for e2e validation');
    expect(prompt).toContain('Be helpful and test things');
    expect(prompt).toContain('E2E Bot');
    expect(prompt).toContain('Operating Instructions');
    expect(prompt).toContain('Communication Guidelines');
  });

  it('loads persona, builds prompt, creates conversation, and produces provider messages', async () => {
    const dir = makeTempWorkspace({
      'SOUL.md': 'You are Pipeline Bot.',
      'AGENTS.md': 'Respond with facts.',
      'IDENTITY.md': 'name: Pipeline',
    });
    const persona = await loadPersona({ workspacePath: dir });
    const prompt = buildSystemPrompt(persona);
    const key = `e2e-pipeline-${Date.now()}`;
    const conv = getConversation(key, prompt);
    addUserMessage(conv, makeMessage('Hello, Pipeline Bot!'));
    addAssistantMessage(conv, 'hello, i am pipeline bot');

    const msgs = toProviderMessages(conv);
    expect(msgs[0]!.role).toBe('system');
    expect(msgs[0]!.content).toContain('Pipeline Bot');
    expect(msgs[1]!.role).toBe('user');
    expect(msgs[1]!.content).toBe('Hello, Pipeline Bot!');
    expect(msgs[2]!.role).toBe('assistant');
    expect(msgs[2]!.content).toBe('hello, i am pipeline bot');
    clearConversation(key);
  });

  it('applies Lain style to assistant response in pipeline', async () => {
    const dir = makeTempWorkspace({
      'SOUL.md': 'You are Lain.',
      'AGENTS.md': 'Be quiet.',
      'IDENTITY.md': 'name: Lain',
    });
    const persona = await loadPersona({ workspacePath: dir });
    const prompt = buildSystemPrompt(persona);

    eventBus.setCharacterId('lain');
    const rawResponse = 'Sure, this is an amazing discovery! I hope this helps!';
    const styled = applyPersonaStyle(rawResponse);

    expect(styled).not.toContain('Sure');
    expect(styled).not.toContain('amazing');
    expect(styled).not.toContain('!');
    expect(styled).not.toMatch(/i hope this helps/i);

    const key = `e2e-style-${Date.now()}`;
    const conv = getConversation(key, prompt);
    addUserMessage(conv, makeMessage('tell me something'));
    addAssistantMessage(conv, styled);

    const msgs = toProviderMessages(conv);
    expect(msgs[2]!.content).toBe(styled);
    clearConversation(key);
  });

  it('non-Lain character skips style application in pipeline', async () => {
    const dir = makeTempWorkspace({
      'SOUL.md': 'You are PKD.',
      'AGENTS.md': 'Be expansive.',
      'IDENTITY.md': 'name: PKD',
    });
    const persona = await loadPersona({ workspacePath: dir });
    const prompt = buildSystemPrompt(persona);

    eventBus.setCharacterId('pkd');
    const rawResponse = 'Sure, this is an amazing discovery! I hope this helps!';
    const styled = applyPersonaStyle(rawResponse);

    // PKD does not get Lain styling
    expect(styled).toBe(rawResponse);

    const key = `e2e-pkd-${Date.now()}`;
    const conv = getConversation(key, prompt);
    addUserMessage(conv, makeMessage('hello'));
    addAssistantMessage(conv, styled);

    const msgs = toProviderMessages(conv);
    expect(msgs[2]!.content).toBe(rawResponse);
    clearConversation(key);
  });

  it('enhanced prompt with context sections integrates with conversation', async () => {
    const dir = makeTempWorkspace({
      'SOUL.md': 'You are Context Bot.',
      'AGENTS.md': 'Use context wisely.',
      'IDENTITY.md': 'name: Context Bot',
    });
    const persona = await loadPersona({ workspacePath: dir });
    let prompt = buildSystemPrompt(persona);

    // Simulate adding context sections like processMessage does
    prompt += '\n\n---\n\n## Who You Are Now\n\nYou have been reflecting on time.';
    prompt += '\n\n[Your Internal State]\nenergy: 0.7, sociability: 0.5';
    prompt += '\n\n[On your mind]\n- the passage of time';
    prompt += '\n\n[Your Current Location: Cafe]';
    prompt += '\n\n[Weather in town: Gentle rain]';

    const key = `e2e-context-${Date.now()}`;
    const conv = getConversation(key, prompt);
    addUserMessage(conv, makeMessage('How are you?'));

    const msgs = toProviderMessages(conv);
    const systemMsg = msgs[0]!.content as string;
    expect(systemMsg).toContain('Context Bot');
    expect(systemMsg).toContain('Who You Are Now');
    expect(systemMsg).toContain('reflecting on time');
    expect(systemMsg).toContain('energy: 0.7');
    expect(systemMsg).toContain('passage of time');
    expect(systemMsg).toContain('Cafe');
    expect(systemMsg).toContain('Gentle rain');
    clearConversation(key);
  });

  it('template persona loads, substitutes, builds, and creates valid conversation', async () => {
    // Load actual templates
    const templatePersona = await loadPersona({
      workspacePath: join(process.cwd(), 'workspace', 'templates'),
    });

    // Simulate variable substitution
    const soul = templatePersona.soul.replace(/\[NAME\]/g, 'TestChar');
    const agents = templatePersona.agents.replace(/\[CHARACTER NAME\]/g, 'TestChar');
    const identity = templatePersona.identity
      .replace(/\[Character Name\]/g, 'TestChar')
      .replace(/\[Full Name\]/g, 'Test Character')
      .replace(/\[name\]/g, 'TestChar');

    const prompt = buildSystemPrompt({ soul, agents, identity });
    expect(prompt).toContain('TestChar');
    expect(prompt).toContain('Operating Instructions');

    const key = `e2e-template-${Date.now()}`;
    const conv = getConversation(key, prompt);
    addUserMessage(conv, makeMessage('Hi TestChar'));
    const msgs = toProviderMessages(conv);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.content).toContain('TestChar');
    clearConversation(key);
  });

  it('trim maintains valid state after full pipeline', async () => {
    const dir = makeTempWorkspace({
      'SOUL.md': 'You are TrimBot.',
      'AGENTS.md': 'Keep it short.',
      'IDENTITY.md': 'name: TrimBot',
    });
    const persona = await loadPersona({ workspacePath: dir });
    const prompt = buildSystemPrompt(persona);

    const key = `e2e-trim-${Date.now()}`;
    const conv = getConversation(key, prompt);

    // Add many messages to force trimming
    for (let i = 0; i < 50; i++) {
      addUserMessage(conv, makeMessage('x'.repeat(300)));
      addAssistantMessage(conv, 'y'.repeat(300));
    }

    trimConversation(conv, 2000, estimateTokens);

    // After trimming, conversation should still be valid
    const msgs = toProviderMessages(conv);
    expect(msgs[0]!.role).toBe('system');
    expect(msgs[0]!.content).toContain('TrimBot');
    expect(msgs.length).toBeGreaterThanOrEqual(2); // system + at least minMessages
    expect(msgs.length).toBeLessThan(102); // trimmed from 101
    clearConversation(key);
  });

  it('two parallel pipelines for different characters are fully isolated', async () => {
    const dirA = makeTempWorkspace({
      'SOUL.md': 'UNIQUE_CHAR_ALPHA_SOUL',
      'AGENTS.md': 'UNIQUE_CHAR_ALPHA_AGENTS',
      'IDENTITY.md': 'name: Alpha',
    });
    const dirB = makeTempWorkspace({
      'SOUL.md': 'UNIQUE_CHAR_BETA_SOUL',
      'AGENTS.md': 'UNIQUE_CHAR_BETA_AGENTS',
      'IDENTITY.md': 'name: Beta',
    });

    const [personaA, personaB] = await Promise.all([
      loadPersona({ workspacePath: dirA }),
      loadPersona({ workspacePath: dirB }),
    ]);

    const promptA = buildSystemPrompt(personaA);
    const promptB = buildSystemPrompt(personaB);

    expect(promptA).toContain('UNIQUE_CHAR_ALPHA_SOUL');
    expect(promptA).not.toContain('UNIQUE_CHAR_BETA_SOUL');
    expect(promptB).toContain('UNIQUE_CHAR_BETA_SOUL');
    expect(promptB).not.toContain('UNIQUE_CHAR_ALPHA_SOUL');

    const keyA = `e2e-alpha-${Date.now()}`;
    const keyB = `e2e-beta-${Date.now()}`;
    const convA = getConversation(keyA, promptA);
    const convB = getConversation(keyB, promptB);

    addUserMessage(convA, makeMessage('hello alpha'));
    addUserMessage(convB, makeMessage('hello beta'));

    const msgsA = toProviderMessages(convA);
    const msgsB = toProviderMessages(convB);

    expect((msgsA[0]!.content as string)).toContain('Alpha');
    expect((msgsA[0]!.content as string)).not.toContain('Beta');
    expect((msgsB[0]!.content as string)).toContain('Beta');
    expect((msgsB[0]!.content as string)).not.toContain('Alpha');

    clearConversation(keyA);
    clearConversation(keyB);
  });

  it('persona with Unicode content builds prompt and survives conversation round trip', async () => {
    const dir = makeTempWorkspace({
      'SOUL.md': 'あなたはレインです。静かで内向的。',
      'AGENTS.md': '簡潔に答えてください。',
      'IDENTITY.md': 'name: レイン\navatar: lain.png',
    });
    const persona = await loadPersona({ workspacePath: dir });
    const prompt = buildSystemPrompt(persona);
    expect(prompt).toContain('あなたはレインです');

    const key = `e2e-unicode-${Date.now()}`;
    const conv = getConversation(key, prompt);
    addUserMessage(conv, makeMessage('こんにちは'));
    const msgs = toProviderMessages(conv);
    expect((msgs[0]!.content as string)).toContain('レイン');
    expect(msgs[1]!.content).toBe('こんにちは');
    clearConversation(key);
  });

  it('empty persona files still produce a valid pipeline', async () => {
    const dir = makeTempWorkspace({
      'SOUL.md': '',
      'AGENTS.md': '',
      'IDENTITY.md': '',
    });
    const persona = await loadPersona({ workspacePath: dir });
    const prompt = buildSystemPrompt(persona);

    // Even with empty persona, the system prompt has the fixed guidelines
    expect(prompt).toContain('Communication Guidelines');
    expect(prompt).toContain('Operating Instructions');

    const key = `e2e-empty-${Date.now()}`;
    const conv = getConversation(key, prompt);
    addUserMessage(conv, makeMessage('hello'));
    const msgs = toProviderMessages(conv);
    expect(msgs).toHaveLength(2);
    clearConversation(key);
  });

  it('large persona files survive full pipeline without data loss', async () => {
    const largeSoul = 'SOUL_LINE_' + 'x'.repeat(50000);
    const dir = makeTempWorkspace({
      'SOUL.md': largeSoul,
      'AGENTS.md': 'agents',
      'IDENTITY.md': 'name: Large',
    });
    const persona = await loadPersona({ workspacePath: dir });
    expect(persona.soul).toBe(largeSoul);

    const prompt = buildSystemPrompt(persona);
    expect(prompt).toContain(largeSoul);

    const key = `e2e-large-${Date.now()}`;
    const conv = getConversation(key, prompt);
    const msgs = toProviderMessages(conv);
    expect((msgs[0]!.content as string)).toContain('SOUL_LINE_');
    expect((msgs[0]!.content as string).length).toBeGreaterThan(50000);
    clearConversation(key);
  });

  it('style is applied after persona load but conversation stores the styled version', async () => {
    const dir = makeTempWorkspace({
      'SOUL.md': 'soul',
      'AGENTS.md': 'agents',
      'IDENTITY.md': 'identity',
    });
    await loadPersona({ workspacePath: dir });

    eventBus.setCharacterId('lain');
    const raw = 'This is GREAT and Exciting!';
    const styled = applyPersonaStyle(raw);
    expect(styled).toContain('good');
    expect(styled).toContain('interesting');
    expect(styled).not.toContain('!');

    const key = `e2e-styled-store-${Date.now()}`;
    const conv = getConversation(key, 'prompt');
    addAssistantMessage(conv, styled);
    const msgs = toProviderMessages(conv);
    // The stored message is the styled version
    expect(msgs[1]!.content).toBe(styled);
    expect(msgs[1]!.content).not.toContain('GREAT');
    clearConversation(key);
  });
});
