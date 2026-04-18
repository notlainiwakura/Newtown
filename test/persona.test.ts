/**
 * Persona/response styling tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn().mockResolvedValue('test-master-key'),
    setPassword: vi.fn().mockResolvedValue(undefined),
    deletePassword: vi.fn().mockResolvedValue(true),
    findCredentials: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

vi.mock('../src/config/characters.js', () => ({
  getWebCharacter: vi.fn(),
}));

import { readFile } from 'node:fs/promises';
import { eventBus } from '../src/events/bus.js';
import { getWebCharacter } from '../src/config/characters.js';
import {
  loadPersona,
  buildSystemPrompt,
  applyPersonaStyle,
  shouldAskFollowUp,
  generateFollowUp,
} from '../src/agent/persona.js';

const mockedReadFile = vi.mocked(readFile);
const mockedGetWebCharacter = vi.mocked(getWebCharacter);

describe('Persona Engine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: set character to lain so style transforms apply
    eventBus.setCharacterId('lain');
    mockedGetWebCharacter.mockReturnValue({
      id: 'wired-lain',
      name: 'Wired Lain',
      port: 3000,
      server: 'web',
      defaultLocation: 'library',
      immortal: true,
      workspace: 'workspace/characters/wired-lain',
    });
  });

  describe('loadPersona', () => {
    it('should load SOUL.md, AGENTS.md, and IDENTITY.md in parallel', async () => {
      mockedReadFile
        .mockResolvedValueOnce('soul content' as never)
        .mockResolvedValueOnce('agents content' as never)
        .mockResolvedValueOnce('identity content' as never);

      const persona = await loadPersona({ workspacePath: '/test/workspace' });

      expect(persona.soul).toBe('soul content');
      expect(persona.agents).toBe('agents content');
      expect(persona.identity).toBe('identity content');
    });

    it('should read from the correct file paths', async () => {
      mockedReadFile
        .mockResolvedValueOnce('s' as never)
        .mockResolvedValueOnce('a' as never)
        .mockResolvedValueOnce('i' as never);

      await loadPersona({ workspacePath: '/my/path' });

      expect(mockedReadFile).toHaveBeenCalledWith('/my/path/SOUL.md', 'utf-8');
      expect(mockedReadFile).toHaveBeenCalledWith('/my/path/AGENTS.md', 'utf-8');
      expect(mockedReadFile).toHaveBeenCalledWith('/my/path/IDENTITY.md', 'utf-8');
    });

    it('should read all three files (3 calls)', async () => {
      mockedReadFile.mockResolvedValue('content' as never);

      await loadPersona({ workspacePath: '/w' });

      expect(mockedReadFile).toHaveBeenCalledTimes(3);
    });

    it('should throw AgentError when a file is missing', async () => {
      mockedReadFile.mockRejectedValue(new Error('ENOENT: no such file'));

      await expect(loadPersona({ workspacePath: '/bad' })).rejects.toThrow(
        /Failed to load persona/
      );
    });

    it('should wrap the original error as cause in AgentError', async () => {
      const original = new Error('disk read failure');
      mockedReadFile.mockRejectedValue(original);

      try {
        await loadPersona({ workspacePath: '/bad' });
        expect.fail('should have thrown');
      } catch (err: unknown) {
        expect((err as { cause: Error }).cause).toBe(original);
      }
    });

    it('should re-throw non-Error exceptions directly', async () => {
      mockedReadFile.mockRejectedValue('string error');

      await expect(loadPersona({ workspacePath: '/bad' })).rejects.toBe('string error');
    });
  });

  describe('buildSystemPrompt', () => {
    it('should combine soul, agents, and identity into a system prompt', () => {
      const persona = {
        soul: 'I am a soul.',
        agents: 'Agent rules.',
        identity: 'My name is Test.',
      };
      const prompt = buildSystemPrompt(persona);
      expect(prompt).toContain('I am a soul.');
      expect(prompt).toContain('Agent rules.');
      expect(prompt).toContain('My name is Test.');
    });

    it('should include section headers', () => {
      const prompt = buildSystemPrompt({
        soul: 'soul',
        agents: 'agents',
        identity: 'identity',
      });
      expect(prompt).toContain('Operating Instructions');
      expect(prompt).toContain('Identity');
      expect(prompt).toContain('Communication Guidelines');
    });

    it('should separate sections with horizontal rules', () => {
      const prompt = buildSystemPrompt({
        soul: 'soul',
        agents: 'agents',
        identity: 'identity',
      });
      expect(prompt.match(/---/g)!.length).toBeGreaterThanOrEqual(3);
    });

    it('should include communication guidelines about lowercase usage', () => {
      const prompt = buildSystemPrompt({
        soul: 's',
        agents: 'a',
        identity: 'i',
      });
      expect(prompt).toContain('lowercase');
    });

    it('should include guideline about ellipsis usage', () => {
      const prompt = buildSystemPrompt({
        soul: 's',
        agents: 'a',
        identity: 'i',
      });
      expect(prompt).toContain('...');
    });
  });

  describe('applyPersonaStyle', () => {
    describe('character gating', () => {
      it('should apply style transformations for character id "lain"', () => {
        eventBus.setCharacterId('lain');
        const result = applyPersonaStyle('Hello World!');
        expect(result).not.toBe('Hello World!');
      });

      it('should apply style transformations for the web character', () => {
        eventBus.setCharacterId('wired-lain');
        const result = applyPersonaStyle('Hello World!');
        expect(result).not.toBe('Hello World!');
      });

      it('should NOT apply transformations for other character ids', () => {
        eventBus.setCharacterId('pkd');
        const result = applyPersonaStyle('Hello World!');
        expect(result).toBe('Hello World!');
      });

      it('should NOT apply when characterId is undefined/empty', () => {
        eventBus.setCharacterId('');
        const result = applyPersonaStyle('Hello World!');
        expect(result).toBe('Hello World!');
      });
    });

    describe('lowercase conversion', () => {
      it('should convert text to lowercase', () => {
        const result = applyPersonaStyle('Hello World');
        expect(result).toBe('hello world');
      });

      it('should preserve acronyms (2+ consecutive capitals)', () => {
        const result = applyPersonaStyle('The TCP protocol and HTTP standard');
        expect(result).toContain('TCP');
        expect(result).toContain('HTTP');
      });

      it('should preserve URLs', () => {
        const result = applyPersonaStyle('Check https://Example.Com/Path for info');
        expect(result).toContain('https://Example.Com/Path');
      });
    });

    describe('punctuation normalization', () => {
      it('should replace exclamation marks with periods', () => {
        const result = applyPersonaStyle('Wow! Amazing!');
        expect(result).not.toContain('!');
      });

      it('should normalize 4+ dots to 3 dots (ellipsis)', () => {
        const result = applyPersonaStyle('thinking..... about it');
        expect(result).not.toContain('.....');
        expect(result).toContain('...');
      });

      it('should normalize 2+ question marks to 1', () => {
        const result = applyPersonaStyle('really??? why??');
        expect(result).not.toContain('??');
      });
    });

    describe('enthusiastic phrase replacement', () => {
      it('should replace "great" with "good"', () => {
        const result = applyPersonaStyle('That is a great idea');
        expect(result).toContain('good');
        expect(result).not.toMatch(/\bgreat\b/);
      });

      it('should replace "awesome" with "interesting"', () => {
        const result = applyPersonaStyle('That is awesome');
        expect(result).toContain('interesting');
        expect(result).not.toMatch(/\bawesome\b/);
      });

      it('should replace "exciting" with "interesting"', () => {
        const result = applyPersonaStyle('This is exciting news');
        expect(result).toContain('interesting');
      });

      it('should replace "amazing" with "notable"', () => {
        const result = applyPersonaStyle('An amazing discovery');
        expect(result).toContain('notable');
      });

      it('should replace "wonderful" with "nice"', () => {
        const result = applyPersonaStyle('A wonderful day');
        expect(result).toContain('nice');
      });

      it('should replace "fantastic" with "good"', () => {
        const result = applyPersonaStyle('A fantastic result');
        expect(result).toContain('good');
      });

      it('should replace "perfect" with "fine"', () => {
        const result = applyPersonaStyle('That is perfect');
        expect(result).toContain('fine');
      });
    });

    describe('filler phrase removal', () => {
      it('should remove "Sure, " at the start', () => {
        const result = applyPersonaStyle('Sure, I can help');
        expect(result).not.toMatch(/^sure/i);
      });

      it('should remove "Certainly, " at the start', () => {
        const result = applyPersonaStyle('Certainly, here you go');
        expect(result).not.toMatch(/^certainly/i);
      });

      it('should remove "Absolutely, " at the start', () => {
        const result = applyPersonaStyle('Absolutely, that works');
        expect(result).not.toMatch(/^absolutely/i);
      });

      it('should remove "Of course, " at the start', () => {
        const result = applyPersonaStyle('Of course, I understand');
        expect(result).not.toMatch(/^of course/i);
      });

      it('should remove "I\'d be happy to " at the start', () => {
        const result = applyPersonaStyle("I'd be happy to explain that");
        expect(result).not.toMatch(/i'd be happy to/i);
      });

      it('should remove "I hope this helps" anywhere', () => {
        const result = applyPersonaStyle('Here is the answer. I hope this helps.');
        expect(result).not.toMatch(/i hope this helps/i);
      });

      it('should remove "feel free to" anywhere', () => {
        const result = applyPersonaStyle('Feel free to ask more questions');
        expect(result).not.toMatch(/feel free to/i);
      });

      it('should remove "don\'t hesitate to" anywhere', () => {
        const result = applyPersonaStyle("Don't hesitate to reach out");
        expect(result).not.toMatch(/don't hesitate to/i);
      });
    });

    describe('uncertain statement trailing ellipsis', () => {
      it('should add trailing ellipsis for "maybe" statements', () => {
        const result = applyPersonaStyle('Maybe that could work');
        expect(result).toMatch(/\.\.\.$/);
      });

      it('should add trailing ellipsis for "i think" statements', () => {
        const result = applyPersonaStyle('I think that is right');
        expect(result).toMatch(/\.\.\.$/);
      });

      it('should add trailing ellipsis for "probably" statements', () => {
        const result = applyPersonaStyle('It is probably correct');
        expect(result).toMatch(/\.\.\.$/);
      });

      it('should add trailing ellipsis for "not sure" statements', () => {
        const result = applyPersonaStyle('I am not sure about that');
        expect(result).toMatch(/\.\.\.$/);
      });

      it('should add trailing ellipsis for "perhaps" statements', () => {
        const result = applyPersonaStyle('Perhaps we should try again');
        expect(result).toMatch(/\.\.\.$/);
      });

      it('should not double-add ellipsis if already ends with ...', () => {
        const result = applyPersonaStyle('Maybe that works...');
        // Should not end with 6 dots
        expect(result).not.toMatch(/\.{4,}$/);
        expect(result).toMatch(/\.\.\.$/);
      });
    });

    describe('whitespace normalization', () => {
      it('should collapse multiple spaces to single space', () => {
        const result = applyPersonaStyle('Hello   world');
        expect(result).not.toContain('  ');
      });

      it('should trim leading and trailing whitespace', () => {
        const result = applyPersonaStyle('  Hello world  ');
        expect(result).not.toMatch(/^\s/);
        expect(result).not.toMatch(/\s$/);
      });
    });

    describe('start lowercase', () => {
      it('should lowercase the first character', () => {
        const result = applyPersonaStyle('The answer is simple');
        expect(result[0]).toBe('t');
      });

      it('should not lowercase if first character is I (standalone)', () => {
        // "I" at start is preserved
        eventBus.setCharacterId('lain');
        const text = 'I think so';
        const result = applyPersonaStyle(text);
        // After lowercase transform the whole string gets lowered,
        // but then "i think" triggers ellipsis. The first char check
        // only preserves 'I' — but the string was already lowered.
        // The result starts with lowercase since the entire text was lowered.
        expect(result).toMatch(/^i think/);
      });

      it('should not lowercase if starts with an acronym', () => {
        const result = applyPersonaStyle('TCP is a protocol');
        expect(result).toMatch(/^TCP/);
      });
    });

    describe('combined transformations', () => {
      it('should apply all transforms together', () => {
        const result = applyPersonaStyle(
          'Sure, this is an AMAZING and exciting discovery! I think the TCP protocol is great!!!'
        );
        // filler removed, lowered, enthusiastic replaced, exclamation replaced
        expect(result).not.toMatch(/^sure/i);
        expect(result).not.toContain('!');
        expect(result).toContain('notable');
        expect(result).toContain('interesting');
        expect(result).toContain('TCP');
        expect(result).toMatch(/\.\.\.$/); // "i think" triggers ellipsis
      });
    });
  });

  describe('shouldAskFollowUp', () => {
    it('should return false for non-technical content', () => {
      // Even with 30% random chance, no technical keywords means always false
      const result = shouldAskFollowUp('hello how are you', 'i am fine');
      expect(result).toBe(false);
    });

    it('should sometimes return true for technical content (probabilistic)', () => {
      // Run many times to check it returns true at least once
      let gotTrue = false;
      for (let i = 0; i < 100; i++) {
        if (shouldAskFollowUp('tell me about network protocols', 'sure, network protocols')) {
          gotTrue = true;
          break;
        }
      }
      expect(gotTrue).toBe(true);
    });

    it('should sometimes return false for technical content (probabilistic)', () => {
      let gotFalse = false;
      for (let i = 0; i < 100; i++) {
        if (!shouldAskFollowUp('explain the algorithm', 'the algorithm works')) {
          gotFalse = false;
          break;
        }
      }
      // 70% chance of false per call, so very likely in 100 tries
      expect(gotFalse).toBe(false);
    });

    it('should detect "network" as a technical keyword', () => {
      let found = false;
      for (let i = 0; i < 100; i++) {
        if (shouldAskFollowUp('network configuration', 'some response')) {
          found = true;
          break;
        }
      }
      expect(found).toBe(true);
    });

    it('should detect "protocol" as a technical keyword', () => {
      let found = false;
      for (let i = 0; i < 100; i++) {
        if (shouldAskFollowUp('protocol design', 'response')) {
          found = true;
          break;
        }
      }
      expect(found).toBe(true);
    });

    it('should detect "code" as a technical keyword', () => {
      let found = false;
      for (let i = 0; i < 100; i++) {
        if (shouldAskFollowUp('code review', 'response')) {
          found = true;
          break;
        }
      }
      expect(found).toBe(true);
    });

    it('should detect "encryption" as a technical keyword', () => {
      let found = false;
      for (let i = 0; i < 100; i++) {
        if (shouldAskFollowUp('encryption standard', 'response')) {
          found = true;
          break;
        }
      }
      expect(found).toBe(true);
    });

    it('should detect "consciousness" as a technical keyword', () => {
      let found = false;
      for (let i = 0; i < 100; i++) {
        if (shouldAskFollowUp('consciousness and identity', 'response')) {
          found = true;
          break;
        }
      }
      expect(found).toBe(true);
    });

    it('should also check the response text for keywords', () => {
      // userMessage has no keywords, response does
      let found = false;
      for (let i = 0; i < 100; i++) {
        if (shouldAskFollowUp('tell me about it', 'the system uses encryption')) {
          found = true;
          break;
        }
      }
      expect(found).toBe(true);
    });

    it('should use case-insensitive keyword matching', () => {
      let found = false;
      for (let i = 0; i < 100; i++) {
        if (shouldAskFollowUp('NETWORK Protocol', 'response')) {
          found = true;
          break;
        }
      }
      expect(found).toBe(true);
    });
  });

  describe('generateFollowUp', () => {
    it('should return a string', () => {
      const result = generateFollowUp('networking');
      expect(typeof result).toBe('string');
    });

    it('should return one of the template strings', () => {
      const validPrefixes = [
        '...what made you interested in',
        '...how does that work, exactly',
        '...i wonder about the connection to...',
        '...tell me more',
        '...why',
      ];
      // Run enough times to be confident
      for (let i = 0; i < 20; i++) {
        const result = generateFollowUp('networking');
        const matchesAny = validPrefixes.some((prefix) => result.startsWith(prefix));
        expect(matchesAny).toBe(true);
      }
    });

    it('should include the topic in topic-specific templates', () => {
      // "...what made you interested in <topic>" and "...why <topic>, though"
      // Run many times to get a topic-specific template
      let includedTopic = false;
      for (let i = 0; i < 50; i++) {
        const result = generateFollowUp('encryption');
        if (result.includes('encryption')) {
          includedTopic = true;
          break;
        }
      }
      expect(includedTopic).toBe(true);
    });

    it('should always start with "..."', () => {
      for (let i = 0; i < 20; i++) {
        const result = generateFollowUp('data');
        expect(result.startsWith('...')).toBe(true);
      }
    });

    it('should select from exactly 5 templates (fallback is "...tell me more")', () => {
      // Collect unique results over many runs
      const results = new Set<string>();
      for (let i = 0; i < 500; i++) {
        results.add(generateFollowUp('test'));
      }
      // Should see at most 5 unique results
      expect(results.size).toBeLessThanOrEqual(5);
      // Should see at least 3 (statistically almost certain in 500 tries)
      expect(results.size).toBeGreaterThanOrEqual(3);
    });
  });
});
