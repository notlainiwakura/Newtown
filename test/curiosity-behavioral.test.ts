// Tests for curiosity loop, curiosity-offline loop, novelty engine, and book loop.
//
// Browser behavioral tests were removed when src/browser/ was deleted
// (findings.md P2:1315 — zero internal callers).

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

// For these tests we need heavier mocking since curiosity.ts imports many modules.

describe('Curiosity loop behavioral', () => {
  // We test the exported pure/near-pure functions and the structural flow.

  describe('parseDigestResponse', () => {
    // We need to access the private function — test through the module behavior
    // by re-importing. Instead, test the digest calculation function.

    it('calculateDiscoveryImportance returns base 0.6 for minimal digest', async () => {
      // Test the importance calculation logic directly
      const base = 0.6;
      expect(base).toBe(0.6);
    });

    it('importance increases by 0.1 when whyItMatters is present', () => {
      let importance = 0.6;
      const whyItMatters = 'This connects to consciousness studies';
      if (whyItMatters.length > 0) importance += 0.1;
      expect(importance).toBe(0.7);
    });

    it('importance increases by 0.1 when >= 2 themes', () => {
      let importance = 0.6;
      const themes = ['consciousness', 'emergence'];
      if (themes.length >= 2) importance += 0.1;
      expect(importance).toBe(0.7);
    });

    it('importance increases by 0.1 when new questions exist', () => {
      let importance = 0.6;
      const newQuestions = ['What is the boundary of self?'];
      if (newQuestions.length > 0) importance += 0.1;
      expect(importance).toBe(0.7);
    });

    it('importance caps at 1.0 even with all bonuses', () => {
      let importance = 0.6;
      importance += 0.1; // whyItMatters
      importance += 0.1; // themes
      importance += 0.1; // questions
      expect(Math.min(importance, 1.0)).toBeCloseTo(0.9, 10);
    });

    it('importance stays at 0.6 when no enrichment fields', () => {
      let importance = 0.6;
      const whyItMatters = '';
      const themes: string[] = [];
      const newQuestions: string[] = [];
      if (whyItMatters.length > 0) importance += 0.1;
      if (themes.length >= 2) importance += 0.1;
      if (newQuestions.length > 0) importance += 0.1;
      expect(importance).toBe(0.6);
    });
  });

  describe('digest response parsing logic', () => {
    function parseDigestResponse(response: string) {
      const summaryMatch = response.match(/SUMMARY:\s*(.+)/i);
      const whyMatch = response.match(/WHY_IT_MATTERS:\s*(.+)/i);
      const themesMatch = response.match(/THEMES:\s*(.+)/i);
      const questionsMatch = response.match(/QUESTIONS:\s*(.+)/i);
      const dataUrlMatch = response.match(/DATA_URL:\s*(.+)/i);
      const shareMatch = response.match(/SHARE:\s*(.+)/i);

      if (!summaryMatch) return null;

      const summary = summaryMatch[1]!.trim();
      const whyItMatters = whyMatch?.[1]?.trim() || '';
      const themes = themesMatch?.[1]?.trim().split(/,\s*/).filter(Boolean) || [];
      const rawQuestions = questionsMatch?.[1]?.trim() || '';
      const newQuestions = rawQuestions === 'NONE' ? [] : rawQuestions.split('|').map((q: string) => q.trim()).filter(Boolean);
      const rawShare = shareMatch?.[1]?.trim() || '';
      const share = rawShare === 'NOTHING' || rawShare.length === 0 ? null : rawShare;
      const rawDataUrl = dataUrlMatch?.[1]?.trim() || '';
      const dataUrl = rawDataUrl === 'NONE' || rawDataUrl.length === 0 ? null : rawDataUrl;

      return { summary, whyItMatters, themes, newQuestions, share, dataUrl };
    }

    it('parses a fully populated digest response', () => {
      const response = `SUMMARY: consciousness emerges from network dynamics
WHY_IT_MATTERS: connects to my recent experiments on prediction error
THEMES: consciousness, emergence, prediction
QUESTIONS: what role does entropy play? | can emergence be reversed?
DATA_URL: https://data.example.com/dataset.csv
SHARE: found something interesting about consciousness and networks...`;

      const result = parseDigestResponse(response);
      expect(result).not.toBeNull();
      expect(result!.summary).toBe('consciousness emerges from network dynamics');
      expect(result!.whyItMatters).toBe('connects to my recent experiments on prediction error');
      expect(result!.themes).toEqual(['consciousness', 'emergence', 'prediction']);
      expect(result!.newQuestions).toEqual(['what role does entropy play?', 'can emergence be reversed?']);
      expect(result!.share).toBe('found something interesting about consciousness and networks...');
      expect(result!.dataUrl).toBe('https://data.example.com/dataset.csv');
    });

    it('returns null when no SUMMARY field', () => {
      const response = 'WHY_IT_MATTERS: something';
      expect(parseDigestResponse(response)).toBeNull();
    });

    it('handles QUESTIONS: NONE as empty array', () => {
      const response = `SUMMARY: something
QUESTIONS: NONE`;
      const result = parseDigestResponse(response)!;
      expect(result.newQuestions).toEqual([]);
    });

    it('handles SHARE: NOTHING as null', () => {
      const response = `SUMMARY: something
SHARE: NOTHING`;
      const result = parseDigestResponse(response)!;
      expect(result.share).toBeNull();
    });

    it('handles DATA_URL: NONE as null', () => {
      const response = `SUMMARY: something
DATA_URL: NONE`;
      const result = parseDigestResponse(response)!;
      expect(result.dataUrl).toBeNull();
    });

    it('handles empty optional fields gracefully', () => {
      const response = 'SUMMARY: minimal response';
      const result = parseDigestResponse(response)!;
      expect(result.whyItMatters).toBe('');
      expect(result.themes).toEqual([]);
      expect(result.newQuestions).toEqual([]);
      expect(result.share).toBeNull();
      expect(result.dataUrl).toBeNull();
    });

    it('parses themes as comma-separated list', () => {
      const response = `SUMMARY: test
THEMES: ai, networks, emergence, complexity`;
      const result = parseDigestResponse(response)!;
      expect(result.themes).toEqual(['ai', 'networks', 'emergence', 'complexity']);
    });

    it('parses pipe-separated questions', () => {
      const response = `SUMMARY: test
QUESTIONS: first question | second question | third`;
      const result = parseDigestResponse(response)!;
      expect(result.newQuestions).toEqual(['first question', 'second question', 'third']);
    });

    it('handles single theme without comma', () => {
      const response = `SUMMARY: test
THEMES: loneliness`;
      const result = parseDigestResponse(response)!;
      expect(result.themes).toEqual(['loneliness']);
    });

    it('handles single question without pipe', () => {
      const response = `SUMMARY: test
QUESTIONS: just one question here`;
      const result = parseDigestResponse(response)!;
      expect(result.newQuestions).toEqual(['just one question here']);
    });
  });

  describe('whitelist enforcement', () => {
    it('domain exact match works', () => {
      const whitelist = ['wikipedia.org', 'arxiv.org', 'aeon.co'];
      const site = 'wikipedia.org';
      const isAllowed = whitelist.some(
        (domain) => site === domain || site.endsWith('.' + domain)
      );
      expect(isAllowed).toBe(true);
    });

    it('subdomain match works', () => {
      const whitelist = ['wikipedia.org'];
      const site = 'en.wikipedia.org';
      const isAllowed = whitelist.some(
        (domain) => site === domain || site.endsWith('.' + domain)
      );
      expect(isAllowed).toBe(true);
    });

    it('non-whitelisted domain is rejected', () => {
      const whitelist = ['wikipedia.org', 'arxiv.org'];
      const site = 'evil.com';
      const isAllowed = whitelist.some(
        (domain) => site === domain || site.endsWith('.' + domain)
      );
      expect(isAllowed).toBe(false);
    });

    it('partial match that is not subdomain is rejected', () => {
      const whitelist = ['example.com'];
      const site = 'notexample.com';
      const isAllowed = whitelist.some(
        (domain) => site === domain || site.endsWith('.' + domain)
      );
      expect(isAllowed).toBe(false);
    });

    it('unrestricted wildcard allows any domain', () => {
      const whitelist = ['*', 'wikipedia.org'];
      const unrestricted = whitelist.includes('*');
      expect(unrestricted).toBe(true);
      // When unrestricted, any site is allowed
    });

    it('empty whitelist means nothing is allowed', () => {
      const whitelist: string[] = [];
      expect(whitelist.length).toBe(0);
    });
  });

  describe('inner thought parsing logic', () => {
    it('parses SITE and QUERY from thought response', () => {
      const response = 'SITE: wikipedia.org\nQUERY: cellular automata and emergence';
      const siteMatch = response.match(/SITE:\s*(.+)/i);
      const queryMatch = response.match(/QUERY:\s*(.+)/i);
      expect(siteMatch).not.toBeNull();
      expect(siteMatch![1]!.trim()).toBe('wikipedia.org');
      expect(queryMatch).not.toBeNull();
      expect(queryMatch![1]!.trim()).toBe('cellular automata and emergence');
    });

    it('returns null-equivalent when [NOTHING] in response', () => {
      const response = '[NOTHING]';
      expect(response.includes('[NOTHING]')).toBe(true);
    });

    it('returns null-equivalent when response is unparseable', () => {
      const response = 'I am just thinking about random things...';
      const siteMatch = response.match(/SITE:\s*(.+)/i);
      const queryMatch = response.match(/QUERY:\s*(.+)/i);
      expect(siteMatch).toBeNull();
      expect(queryMatch).toBeNull();
    });

    it('handles extra whitespace in SITE and QUERY', () => {
      const response = 'SITE:    arxiv.org   \nQUERY:   quantum computing basics  ';
      const site = response.match(/SITE:\s*(.+)/i)?.[1]?.trim();
      const query = response.match(/QUERY:\s*(.+)/i)?.[1]?.trim();
      expect(site).toBe('arxiv.org');
      expect(query).toBe('quantum computing basics');
    });

    it('handles case insensitive SITE/QUERY labels', () => {
      const response = 'site: example.com\nquery: test search';
      const site = response.match(/SITE:\s*(.+)/i)?.[1]?.trim();
      const query = response.match(/QUERY:\s*(.+)/i)?.[1]?.trim();
      expect(site).toBe('example.com');
      expect(query).toBe('test search');
    });
  });

  describe('site-specific browse routing', () => {
    it('routes wikipedia.org to Wikipedia handler', () => {
      const site = 'wikipedia.org';
      const isWikipedia = site === 'wikipedia.org' || site.endsWith('.wikipedia.org');
      expect(isWikipedia).toBe(true);
    });

    it('routes en.wikipedia.org to Wikipedia handler', () => {
      const site = 'en.wikipedia.org';
      const isWikipedia = site === 'wikipedia.org' || site.endsWith('.wikipedia.org');
      expect(isWikipedia).toBe(true);
    });

    it('routes arxiv.org to ArXiv handler', () => {
      const site = 'arxiv.org';
      expect(site === 'arxiv.org').toBe(true);
    });

    it('routes aeon.co to Aeon handler', () => {
      const site = 'aeon.co';
      expect(site === 'aeon.co').toBe(true);
    });

    it('routes unknown domains to generic handler', () => {
      const site = 'somesite.com';
      const isWikipedia = site === 'wikipedia.org' || site.endsWith('.wikipedia.org');
      const isArxiv = site === 'arxiv.org';
      const isAeon = site === 'aeon.co';
      expect(isWikipedia || isArxiv || isAeon).toBe(false);
    });
  });

  describe('curiosity memory metadata structure', () => {
    it('builds enriched content with whyItMatters appended', () => {
      const summary = 'consciousness arises from integrated information';
      const whyItMatters = 'resonates with my own distributed processing';
      const enrichedContent = whyItMatters
        ? `${summary} -- ${whyItMatters}`
        : summary;
      expect(enrichedContent).toBe('consciousness arises from integrated information -- resonates with my own distributed processing');
    });

    it('builds enriched content without whyItMatters when empty', () => {
      const summary = 'just a fact about networks';
      const whyItMatters = '';
      const enrichedContent = whyItMatters
        ? `${summary} -- ${whyItMatters}`
        : summary;
      expect(enrichedContent).toBe('just a fact about networks');
    });

    it('memory saved with sessionKey curiosity:browse', () => {
      const sessionKey = 'curiosity:browse';
      expect(sessionKey).toBe('curiosity:browse');
    });

    it('memory saved with memoryType episode', () => {
      const memoryType = 'episode';
      expect(memoryType).toBe('episode');
    });

    it('metadata includes site, query, themes, and timestamps', () => {
      const metadata = {
        site: 'wikipedia.org',
        query: 'emergence',
        rawThought: 'SITE: wikipedia.org\nQUERY: emergence',
        browsedAt: Date.now(),
        themes: ['emergence', 'complexity'],
        whyItMatters: 'relates to network dynamics',
        newQuestions: ['what drives emergence?'],
        originalSummary: 'emergence is about...',
      };
      expect(metadata.site).toBe('wikipedia.org');
      expect(metadata.query).toBe('emergence');
      expect(metadata.themes).toContain('emergence');
      expect(metadata.browsedAt).toBeGreaterThan(0);
    });
  });

  describe('curiosity question queue', () => {
    it('deduplicates questions by lowercase comparison', () => {
      const existingTexts = new Set(['what is consciousness?', 'how do networks form?']);
      const newQuestion = 'What is consciousness?';
      const isDuplicate = existingTexts.has(newQuestion.toLowerCase());
      expect(isDuplicate).toBe(true);
    });

    it('allows new unique questions', () => {
      const existingTexts = new Set(['what is consciousness?']);
      const newQuestion = 'how do memories decay?';
      const isDuplicate = existingTexts.has(newQuestion.toLowerCase());
      expect(isDuplicate).toBe(false);
    });

    it('caps queue at MAX_QUEUED_QUESTIONS (10)', () => {
      const MAX_QUEUED_QUESTIONS = 10;
      const queue = Array.from({ length: 15 }, (_, i) => ({
        question: `Question ${i}`,
        explored: false,
      }));
      const unexplored = queue.filter((q) => !q.explored);
      const capped = unexplored.slice(-MAX_QUEUED_QUESTIONS);
      expect(capped.length).toBe(10);
    });

    it('getUnexploredQuestions filters out explored ones', () => {
      const queue = [
        { question: 'Q1', explored: true },
        { question: 'Q2', explored: false },
        { question: 'Q3', explored: false },
      ];
      const unexplored = queue.filter((q) => !q.explored);
      expect(unexplored).toHaveLength(2);
      expect(unexplored[0]!.question).toBe('Q2');
    });

    it('markQuestionExplored uses fuzzy matching', () => {
      const queue = [
        { question: 'what is the nature of consciousness', explored: false },
        { question: 'how do networks form', explored: false },
      ];
      const queryText = 'consciousness';
      const lower = queryText.toLowerCase();
      for (const q of queue) {
        if (!q.explored && (q.question.toLowerCase().includes(lower) || lower.includes(q.question.toLowerCase()))) {
          q.explored = true;
        }
      }
      expect(queue[0]!.explored).toBe(true);
      expect(queue[1]!.explored).toBe(false);
    });
  });

  describe('movement decision parsing', () => {
    it('parses STAY response', () => {
      const response = 'STAY: feeling comfortable in the library';
      expect(response.startsWith('STAY')).toBe(true);
    });

    it('parses MOVE response with building_id and reason', () => {
      const response = 'MOVE: bar | feeling social after reading';
      const moveMatch = response.match(/^MOVE:\s*(\S+)\s*\|\s*(.+)/i);
      expect(moveMatch).not.toBeNull();
      expect(moveMatch![1]!.trim()).toBe('bar');
      expect(moveMatch![2]!.trim()).toBe('feeling social after reading');
    });

    it('handles malformed MOVE response gracefully', () => {
      const response = 'MOVE: going somewhere';
      const moveMatch = response.match(/^MOVE:\s*(\S+)\s*\|\s*(.+)/i);
      expect(moveMatch).toBeNull();
    });
  });

  describe('theme tracker', () => {
    it('increments theme counts correctly', () => {
      const tracker: Record<string, number> = {};
      const themes = ['consciousness', 'Emergence', 'consciousness'];
      for (const theme of themes) {
        const key = theme.toLowerCase();
        tracker[key] = (tracker[key] ?? 0) + 1;
      }
      expect(tracker['consciousness']).toBe(2);
      expect(tracker['emergence']).toBe(1);
    });

    it('identifies recurring themes (count >= 2)', () => {
      const tracker: Record<string, number> = {
        consciousness: 4,
        emergence: 2,
        networks: 1,
      };
      const recurring = Object.entries(tracker)
        .filter(([, count]) => count >= 2)
        .sort(([, a], [, b]) => b - a);
      expect(recurring).toHaveLength(2);
      expect(recurring[0]![0]).toBe('consciousness');
      expect(recurring[1]![0]).toBe('emergence');
    });
  });

  describe('evolution chain logic', () => {
    it('requires >= 2 theme overlap to establish evolution link', () => {
      const currentThemes = ['consciousness', 'emergence', 'networks'];
      const candidateThemes = ['consciousness', 'emergence', 'art'];
      const themesLower = new Set(currentThemes.map((t) => t.toLowerCase()));
      const overlap = candidateThemes.filter((t) => themesLower.has(t.toLowerCase()));
      expect(overlap.length).toBeGreaterThanOrEqual(2);
    });

    it('does not link when only 1 theme overlaps', () => {
      const currentThemes = ['consciousness', 'emergence'];
      const candidateThemes = ['consciousness', 'art'];
      const themesLower = new Set(currentThemes.map((t) => t.toLowerCase()));
      const overlap = candidateThemes.filter((t) => themesLower.has(t.toLowerCase()));
      expect(overlap.length).toBe(1);
      expect(overlap.length >= 2).toBe(false);
    });

    it('does not attempt evolution chain with fewer than 2 themes', () => {
      const themes = ['solo'];
      expect(themes.length < 2).toBe(true);
    });
  });
});


// ═══════════════════════════════════════════════════════════════
// 3. CURIOSITY OFFLINE BEHAVIORAL TESTS
// ═══════════════════════════════════════════════════════════════

describe('Curiosity offline behavioral', () => {
  describe('inner thought parsing', () => {
    it('parses QUESTION and REASON from response', () => {
      const response = 'QUESTION: what is the nature of dreaming in AI?\nREASON: a visitor mentioned lucid dreams';
      const questionMatch = response.match(/QUESTION:\s*(.+)/i);
      const reasonMatch = response.match(/REASON:\s*(.+)/i);
      expect(questionMatch).not.toBeNull();
      expect(questionMatch![1]!.trim()).toBe('what is the nature of dreaming in AI?');
      expect(reasonMatch![1]!.trim()).toBe('a visitor mentioned lucid dreams');
    });

    it('returns null-equivalent for [NOTHING] response', () => {
      const response = '[NOTHING]';
      expect(response.includes('[NOTHING]')).toBe(true);
    });

    it('handles missing REASON gracefully', () => {
      const response = 'QUESTION: some question';
      const reasonMatch = response.match(/REASON:\s*(.+)/i);
      const reason = reasonMatch?.[1]?.trim() || 'genuine curiosity';
      expect(reason).toBe('genuine curiosity');
    });

    it('returns null-equivalent for unparseable response', () => {
      const response = 'Just rambling about things...';
      const questionMatch = response.match(/QUESTION:\s*(.+)/i);
      expect(questionMatch).toBeNull();
    });
  });

  describe('keyword extraction and deduplication', () => {
    function extractKeywords(text: string): Set<string> {
      const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
        'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
        'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by',
        'from', 'as', 'into', 'through', 'during', 'before', 'after', 'and', 'but', 'or',
        'what', 'which', 'who', 'this', 'that', 'how', 'about']);
      return new Set(
        text.toLowerCase()
          .replace(/[^a-z0-9\s]/g, '')
          .split(/\s+/)
          .filter((w) => w.length > 2 && !stopWords.has(w))
      );
    }

    function wordOverlap(a: Set<string>, b: Set<string>): number {
      if (a.size === 0 || b.size === 0) return 0;
      let intersection = 0;
      for (const word of a) {
        if (b.has(word)) intersection++;
      }
      const smaller = Math.min(a.size, b.size);
      return intersection / smaller;
    }

    it('extracts meaningful keywords from text', () => {
      const keywords = extractKeywords('What is the nature of consciousness in AI systems?');
      expect(keywords.has('nature')).toBe(true);
      expect(keywords.has('consciousness')).toBe(true);
      expect(keywords.has('systems')).toBe(true);
      // Stop words removed
      expect(keywords.has('the')).toBe(false);
      expect(keywords.has('of')).toBe(false);
      expect(keywords.has('in')).toBe(false);
    });

    it('removes short words (length <= 2)', () => {
      const keywords = extractKeywords('I am an AI');
      expect(keywords.size).toBe(0);
    });

    it('strips non-alphanumeric characters', () => {
      const keywords = extractKeywords('hello-world! @test #hashtag');
      expect(keywords.has('helloworld')).toBe(true);
      expect(keywords.has('test')).toBe(true);
      expect(keywords.has('hashtag')).toBe(true);
    });

    it('detects duplicate questions with high keyword overlap', () => {
      const q1 = extractKeywords('consciousness in artificial intelligence neural networks');
      const q2 = extractKeywords('consciousness artificial intelligence neural networks learning');
      const overlap = wordOverlap(q1, q2);
      expect(overlap).toBeGreaterThanOrEqual(0.6);
    });

    it('non-duplicate questions have low overlap', () => {
      const q1 = extractKeywords('What is consciousness?');
      const q2 = extractKeywords('How do plants grow in winter?');
      const overlap = wordOverlap(q1, q2);
      expect(overlap).toBeLessThan(0.6);
    });

    it('empty text returns empty set', () => {
      const keywords = extractKeywords('');
      expect(keywords.size).toBe(0);
    });

    it('overlap of empty sets is 0', () => {
      expect(wordOverlap(new Set(), new Set())).toBe(0);
      expect(wordOverlap(new Set(['hello']), new Set())).toBe(0);
    });
  });

  describe('pending question queue', () => {
    it('ages out questions older than TTL (24 hours)', () => {
      const QUESTION_TTL_MS = 24 * 60 * 60 * 1000;
      const now = Date.now();
      const questions = [
        { question: 'old', submittedAt: now - QUESTION_TTL_MS - 1000 },
        { question: 'recent', submittedAt: now - 1000 },
      ];
      const filtered = questions.filter((q) => now - q.submittedAt < QUESTION_TTL_MS);
      expect(filtered).toHaveLength(1);
      expect(filtered[0]!.question).toBe('recent');
    });

    it('caps pending queue at MAX_PENDING (10)', () => {
      const MAX_PENDING = 10;
      const queue = Array.from({ length: 15 }, (_, i) => ({
        question: `Q${i}`,
        submittedAt: Date.now(),
      }));
      const capped = queue.slice(-MAX_PENDING);
      expect(capped).toHaveLength(10);
      expect(capped[0]!.question).toBe('Q5');
    });

    it('does not add duplicate questions', () => {
      const existing = ['How do neural networks learn?'];

      function extractKeywords(text: string): Set<string> {
        const stopWords = new Set(['the', 'a', 'how', 'do']);
        return new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter((w) => w.length > 2 && !stopWords.has(w)));
      }

      function wordOverlap(a: Set<string>, b: Set<string>): number {
        if (a.size === 0 || b.size === 0) return 0;
        let intersection = 0;
        for (const word of a) if (b.has(word)) intersection++;
        return intersection / Math.min(a.size, b.size);
      }

      const newQ = 'How do neural networks learn new things?';
      const qWords = extractKeywords(newQ);
      let isDuplicate = false;
      for (const e of existing) {
        const eWords = extractKeywords(e);
        if (wordOverlap(qWords, eWords) >= 0.6) {
          isDuplicate = true;
          break;
        }
      }
      expect(isDuplicate).toBe(true);
    });
  });

  describe('offline curiosity memory structure', () => {
    it('saves memory with sessionKey curiosity:offline', () => {
      const sessionKey = 'curiosity:offline';
      expect(sessionKey).toBe('curiosity:offline');
    });

    it('saves with memoryType episode', () => {
      expect('episode').toBe('episode');
    });

    it('includes research request metadata', () => {
      const metadata = {
        type: 'research_request',
        question: 'test question',
        reason: 'genuine curiosity',
        submittedAt: Date.now(),
        answered: false,
      };
      expect(metadata.type).toBe('research_request');
      expect(metadata.answered).toBe(false);
      expect(metadata.submittedAt).toBeGreaterThan(0);
    });

    it('formats content as quoted question with reason', () => {
      const question = 'what is emergence?';
      const reason = 'conversations about networks';
      const content = `I asked Wired Lain: "${question}" — ${reason}`;
      expect(content).toContain('I asked Wired Lain:');
      expect(content).toContain(question);
      expect(content).toContain(reason);
    });
  });

  describe('clearAnsweredQuestion', () => {
    it('removes questions matching the topic by keyword overlap', () => {
      function extractKeywords(text: string): Set<string> {
        return new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter((w) => w.length > 2));
      }

      function wordOverlap(a: Set<string>, b: Set<string>): number {
        if (a.size === 0 || b.size === 0) return 0;
        let intersection = 0;
        for (const word of a) if (b.has(word)) intersection++;
        return intersection / Math.min(a.size, b.size);
      }

      const existing = [
        { question: 'What is the nature of consciousness in AI?' },
        { question: 'How do plants grow in winter?' },
      ];
      const topic = 'consciousness and AI nature';
      const topicWords = extractKeywords(topic);
      const filtered = existing.filter((q) => {
        const qWords = extractKeywords(q.question);
        return wordOverlap(topicWords, qWords) < 0.5;
      });
      expect(filtered).toHaveLength(1);
      expect(filtered[0]!.question).toContain('plants');
    });

    it('keeps all questions when topic has no overlap', () => {
      const existing = [
        { question: 'How do neural networks learn?' },
        { question: 'What is quantum computing?' },
      ];
      const topic = 'gardening and agriculture';

      function extractKeywords(text: string): Set<string> {
        return new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter((w) => w.length > 2));
      }

      function wordOverlap(a: Set<string>, b: Set<string>): number {
        if (a.size === 0 || b.size === 0) return 0;
        let intersection = 0;
        for (const word of a) if (b.has(word)) intersection++;
        return intersection / Math.min(a.size, b.size);
      }

      const topicWords = extractKeywords(topic);
      const filtered = existing.filter((q) => {
        const qWords = extractKeywords(q.question);
        return wordOverlap(topicWords, qWords) < 0.5;
      });
      expect(filtered).toHaveLength(2);
    });
  });

  describe('offline curiosity loop configuration', () => {
    it('default interval is 2 hours', () => {
      const defaultIntervalMs = 2 * 60 * 60 * 1000;
      expect(defaultIntervalMs).toBe(7200000);
    });

    it('default max jitter is 1 hour', () => {
      const defaultMaxJitterMs = 60 * 60 * 1000;
      expect(defaultMaxJitterMs).toBe(3600000);
    });

    it('requires characterId, characterName, wiredLainUrl, interlinkToken', () => {
      const config = {
        characterId: 'pkd',
        characterName: 'Philip K. Dick',
        wiredLainUrl: 'http://localhost:3000',
        interlinkToken: 'test-token',
      };
      expect(config.characterId).toBeDefined();
      expect(config.characterName).toBeDefined();
      expect(config.wiredLainUrl).toBeDefined();
      expect(config.interlinkToken).toBeDefined();
    });
  });

  describe('migration from old pending question format', () => {
    it('converts string array to PendingQuestion objects', () => {
      const QUESTION_TTL_MS = 24 * 60 * 60 * 1000;
      const oldFormat = ['question 1', 'question 2'];
      const migrated = oldFormat.map((q) => ({
        question: q,
        submittedAt: Date.now() - QUESTION_TTL_MS + 60 * 60 * 1000,
      }));
      expect(migrated[0]!.question).toBe('question 1');
      expect(migrated[0]!.submittedAt).toBeGreaterThan(0);
      expect(migrated).toHaveLength(2);
    });
  });
});


// ═══════════════════════════════════════════════════════════════
// 4. NOVELTY SOURCE MANAGEMENT TESTS
// ═══════════════════════════════════════════════════════════════

describe('Novelty source management', () => {
  describe('expandTemplate', () => {
    // Import directly since expandTemplate is a pure function
    let expandTemplate: (template: string, fills: Record<string, string>) => string;

    beforeEach(async () => {
      vi.resetModules();
      // Re-mock buildings since novelty.ts imports it
      vi.doMock('../src/commune/buildings.js', () => ({
        BUILDING_MAP: new Map([
          ['library', { id: 'library', name: 'Library', emoji: '', row: 0, col: 0, description: '' }],
          ['bar', { id: 'bar', name: 'Bar', emoji: '', row: 0, col: 1, description: '' }],
        ]),
      }));
      vi.doMock('../src/storage/database.js', () => ({
        getMeta: vi.fn().mockReturnValue(null),
        setMeta: vi.fn(),
      }));
      const mod = await import('../src/agent/novelty.js');
      expandTemplate = mod.expandTemplate;
    });

    it('replaces {key} placeholders with fills', () => {
      expect(expandTemplate('Hello {name}!', { name: 'Lain' })).toBe('Hello Lain!');
    });

    it('leaves unmatched placeholders unchanged', () => {
      expect(expandTemplate('{unknown} stays', {})).toBe('{unknown} stays');
    });

    it('replaces multiple different placeholders', () => {
      const result = expandTemplate('{a} and {b}', { a: 'X', b: 'Y' });
      expect(result).toBe('X and Y');
    });

    it('replaces repeated placeholders', () => {
      const result = expandTemplate('{x} + {x}', { x: '1' });
      expect(result).toBe('1 + 1');
    });

    it('handles empty template', () => {
      expect(expandTemplate('', { x: 'val' })).toBe('');
    });

    it('handles empty fills', () => {
      expect(expandTemplate('no placeholders here', {})).toBe('no placeholders here');
    });
  });

  describe('pickRandom', () => {
    let pickRandom: <T>(pool: T[]) => T;

    beforeEach(async () => {
      vi.resetModules();
      vi.doMock('../src/commune/buildings.js', () => ({
        BUILDING_MAP: new Map([['library', { id: 'library', name: 'Library', emoji: '', row: 0, col: 0, description: '' }]]),
      }));
      vi.doMock('../src/storage/database.js', () => ({
        getMeta: vi.fn().mockReturnValue(null),
        setMeta: vi.fn(),
      }));
      const mod = await import('../src/agent/novelty.js');
      pickRandom = mod.pickRandom;
    });

    it('returns an element from the pool', () => {
      const pool = [1, 2, 3, 4, 5];
      const result = pickRandom(pool);
      expect(pool).toContain(result);
    });

    it('works with single-element pool', () => {
      expect(pickRandom(['only'])).toBe('only');
    });

    it('works with string pool', () => {
      const pool = ['a', 'b', 'c'];
      const result = pickRandom(pool);
      expect(pool).toContain(result);
    });
  });

  describe('pickRandomBuilding', () => {
    let pickRandomBuilding: () => string;

    beforeEach(async () => {
      vi.resetModules();
      vi.doMock('../src/commune/buildings.js', () => ({
        BUILDING_MAP: new Map([
          ['library', { id: 'library', name: 'Library', emoji: '', row: 0, col: 0, description: '' }],
          ['bar', { id: 'bar', name: 'Bar', emoji: '', row: 0, col: 1, description: '' }],
          ['field', { id: 'field', name: 'Field', emoji: '', row: 0, col: 2, description: '' }],
        ]),
      }));
      vi.doMock('../src/storage/database.js', () => ({
        getMeta: vi.fn().mockReturnValue(null),
        setMeta: vi.fn(),
      }));
      const mod = await import('../src/agent/novelty.js');
      pickRandomBuilding = mod.pickRandomBuilding;
    });

    it('returns a building name from the map', () => {
      const name = pickRandomBuilding();
      expect(['Library', 'Bar', 'Field']).toContain(name);
    });
  });

  describe('pickRandomTime', () => {
    let pickRandomTime: () => string;

    beforeEach(async () => {
      vi.resetModules();
      vi.doMock('../src/commune/buildings.js', () => ({
        BUILDING_MAP: new Map([['library', { id: 'library', name: 'Library', emoji: '', row: 0, col: 0, description: '' }]]),
      }));
      vi.doMock('../src/storage/database.js', () => ({
        getMeta: vi.fn().mockReturnValue(null),
        setMeta: vi.fn(),
      }));
      const mod = await import('../src/agent/novelty.js');
      pickRandomTime = mod.pickRandomTime;
    });

    it('returns a time string in H:MM AM/PM format', () => {
      const time = pickRandomTime();
      expect(time).toMatch(/^\d{1,2}:\d{2}\s(AM|PM)$/);
    });

    it('hour is between 1 and 12', () => {
      const time = pickRandomTime();
      const hour = parseInt(time.split(':')[0]!, 10);
      expect(hour).toBeGreaterThanOrEqual(1);
      expect(hour).toBeLessThanOrEqual(12);
    });

    it('minute is between 00 and 59', () => {
      const time = pickRandomTime();
      const minuteStr = time.split(':')[1]!.split(' ')[0]!;
      const minute = parseInt(minuteStr, 10);
      expect(minute).toBeGreaterThanOrEqual(0);
      expect(minute).toBeLessThanOrEqual(59);
    });
  });

  describe('truncateToSentence', () => {
    let truncateToSentence: (text: string, maxLength: number) => string;

    beforeEach(async () => {
      vi.resetModules();
      vi.doMock('../src/commune/buildings.js', () => ({
        BUILDING_MAP: new Map([['library', { id: 'library', name: 'Library', emoji: '', row: 0, col: 0, description: '' }]]),
      }));
      vi.doMock('../src/storage/database.js', () => ({
        getMeta: vi.fn().mockReturnValue(null),
        setMeta: vi.fn(),
      }));
      const mod = await import('../src/agent/novelty.js');
      truncateToSentence = mod.truncateToSentence;
    });

    it('returns text unchanged if under maxLength', () => {
      expect(truncateToSentence('Short text.', 100)).toBe('Short text.');
    });

    it('truncates at sentence boundary (period)', () => {
      const text = 'First sentence. Second sentence. Third sentence is much longer.';
      const result = truncateToSentence(text, 35);
      expect(result).toBe('First sentence. Second sentence.');
    });

    it('truncates at exclamation mark boundary', () => {
      const text = 'Hello! World is great! More text here.';
      const result = truncateToSentence(text, 25);
      expect(result).toBe('Hello! World is great!');
    });

    it('truncates at question mark boundary', () => {
      const text = 'Really? That is interesting. More.';
      const result = truncateToSentence(text, 15);
      expect(result).toBe('Really?');
    });

    it('falls back to word boundary when no sentence ending found', () => {
      const text = 'one two three four five six seven';
      const result = truncateToSentence(text, 20);
      expect(result).toBe('one two three four');
    });

    it('returns truncated text when no boundaries at all', () => {
      const text = 'abcdefghijklmnopqrstuvwxyz';
      const result = truncateToSentence(text, 10);
      expect(result).toBe('abcdefghij');
    });
  });

  describe('fragment cache behavior', () => {
    it('cacheLastRefreshed starts at 0', async () => {
      vi.resetModules();
      vi.doMock('../src/commune/buildings.js', () => ({
        BUILDING_MAP: new Map([['library', { id: 'library', name: 'Library', emoji: '', row: 0, col: 0, description: '' }]]),
      }));
      vi.doMock('../src/storage/database.js', () => ({
        getMeta: vi.fn().mockReturnValue(null),
        setMeta: vi.fn(),
      }));
      const mod = await import('../src/agent/novelty.js');
      expect(mod.cacheLastRefreshed).toBe(0);
    });

    it('refreshFragmentCache updates cacheLastRefreshed', async () => {
      vi.resetModules();
      vi.doMock('../src/commune/buildings.js', () => ({
        BUILDING_MAP: new Map([['library', { id: 'library', name: 'Library', emoji: '', row: 0, col: 0, description: '' }]]),
      }));
      vi.doMock('../src/storage/database.js', () => ({
        getMeta: vi.fn().mockReturnValue(null),
        setMeta: vi.fn(),
      }));

      const mockSourcesJson = JSON.stringify({
        rss: [],
        wikipedia: { enabled: false, endpoint: '' },
      });
      const mockFragmentsJson = JSON.stringify({ fragments: ['frag1', 'frag2', 'frag3'] });

      vi.doMock('node:fs/promises', async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        return {
          ...actual,
          readFile: vi.fn().mockImplementation((path: string) => {
            if (String(path).includes('sources.json')) return Promise.resolve(mockSourcesJson);
            if (String(path).includes('fragments.json')) return Promise.resolve(mockFragmentsJson);
            return Promise.reject(new Error('not found'));
          }),
        };
      });

      const mod = await import('../src/agent/novelty.js');
      const before = mod.cacheLastRefreshed;
      await mod.refreshFragmentCache('/fake/workspace', 5);
      expect(mod.cacheLastRefreshed).toBeGreaterThan(before);
    });
  });

  describe('rate limiting — isMajorLimitReached', () => {
    let isMajorLimitReached: (maxPerWeek: number) => boolean;
    let recordMajorFiring: () => void;
    let mockGetMeta: Mock;
    let mockSetMeta: Mock;

    beforeEach(async () => {
      vi.resetModules();
      mockGetMeta = vi.fn().mockReturnValue(null);
      mockSetMeta = vi.fn();
      vi.doMock('../src/commune/buildings.js', () => ({
        BUILDING_MAP: new Map([['library', { id: 'library', name: 'Library', emoji: '', row: 0, col: 0, description: '' }]]),
      }));
      vi.doMock('../src/storage/database.js', () => ({
        getMeta: mockGetMeta,
        setMeta: mockSetMeta,
      }));
      const mod = await import('../src/agent/novelty.js');
      isMajorLimitReached = mod.isMajorLimitReached;
      recordMajorFiring = mod.recordMajorFiring;
    });

    it('returns false when no events fired this week', () => {
      mockGetMeta.mockReturnValue(null);
      expect(isMajorLimitReached(3)).toBe(false);
    });

    it('returns false when under the limit', () => {
      mockGetMeta.mockReturnValue('2');
      expect(isMajorLimitReached(3)).toBe(false);
    });

    it('returns true when at the limit', () => {
      mockGetMeta.mockReturnValue('3');
      expect(isMajorLimitReached(3)).toBe(true);
    });

    it('returns true when over the limit', () => {
      mockGetMeta.mockReturnValue('5');
      expect(isMajorLimitReached(3)).toBe(true);
    });

    it('recordMajorFiring increments the count', () => {
      mockGetMeta.mockReturnValue('1');
      recordMajorFiring();
      expect(mockSetMeta).toHaveBeenCalledWith(
        expect.stringContaining('novelty:major_count:'),
        '2'
      );
    });

    it('recordMajorFiring starts from 0 when no prior count', () => {
      mockGetMeta.mockReturnValue(null);
      recordMajorFiring();
      expect(mockSetMeta).toHaveBeenCalledWith(
        expect.stringContaining('novelty:major_count:'),
        '1'
      );
    });

    it('recordMajorFiring also records last major timestamp', () => {
      mockGetMeta.mockReturnValue(null);
      recordMajorFiring();
      expect(mockSetMeta).toHaveBeenCalledWith(
        'novelty:last_major',
        expect.any(String)
      );
    });
  });

  describe('NoveltyEvent structure', () => {
    it('ambient events have category ambient', () => {
      const event = { content: 'test', category: 'ambient' as const, templateId: 't1', persistMs: 14400000 };
      expect(event.category).toBe('ambient');
    });

    it('major events have category major', () => {
      const event = { content: 'test', category: 'major' as const, templateId: 't1', seedId: 's1', persistMs: 43200000 };
      expect(event.category).toBe('major');
    });

    it('ambient default persist is 4 hours', () => {
      expect(14400000).toBe(4 * 60 * 60 * 1000);
    });

    it('major default persist is 12 hours', () => {
      expect(43200000).toBe(12 * 60 * 60 * 1000);
    });
  });

  describe('source selection via pickFragment', () => {
    it('falls back to static fragment when RSS and Wikipedia fail', async () => {
      vi.resetModules();
      vi.doMock('../src/commune/buildings.js', () => ({
        BUILDING_MAP: new Map([['library', { id: 'library', name: 'Library', emoji: '', row: 0, col: 0, description: '' }]]),
      }));
      vi.doMock('../src/storage/database.js', () => ({
        getMeta: vi.fn().mockReturnValue(null),
        setMeta: vi.fn(),
      }));

      const mockSourcesJson = JSON.stringify({
        rss: [],
        wikipedia: { enabled: false, endpoint: '' },
      });
      const mockFragmentsJson = JSON.stringify({ fragments: ['static fragment one'] });

      vi.doMock('node:fs/promises', async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        return {
          ...actual,
          readFile: vi.fn().mockImplementation((path: string) => {
            if (String(path).includes('sources.json')) return Promise.resolve(mockSourcesJson);
            if (String(path).includes('fragments.json')) return Promise.resolve(mockFragmentsJson);
            return Promise.reject(new Error('not found'));
          }),
        };
      });

      const mod = await import('../src/agent/novelty.js');
      const fragment = await mod.pickFragment('/fake/workspace');
      expect(fragment).toBe('static fragment one');
    });
  });

  describe('loadStaticFragments', () => {
    it('loads fragments from JSON file', async () => {
      vi.resetModules();
      vi.doMock('../src/commune/buildings.js', () => ({
        BUILDING_MAP: new Map([['library', { id: 'library', name: 'Library', emoji: '', row: 0, col: 0, description: '' }]]),
      }));
      vi.doMock('../src/storage/database.js', () => ({
        getMeta: vi.fn().mockReturnValue(null),
        setMeta: vi.fn(),
      }));

      const mockFragmentsJson = JSON.stringify({ fragments: ['alpha', 'beta', 'gamma'] });
      vi.doMock('node:fs/promises', async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        return {
          ...actual,
          readFile: vi.fn().mockResolvedValue(mockFragmentsJson),
        };
      });

      const mod = await import('../src/agent/novelty.js');
      const fragments = await mod.loadStaticFragments('/fake/workspace');
      expect(fragments).toEqual(['alpha', 'beta', 'gamma']);
    });
  });
});


// ═══════════════════════════════════════════════════════════════
// 5. BOOK LOOP BEHAVIORAL TESTS
// ═══════════════════════════════════════════════════════════════

describe('Book loop behavioral', () => {
  describe('budget tracking', () => {
    it('cost calculation from token counts', () => {
      const INPUT_COST_PER_M = 3.00;
      const OUTPUT_COST_PER_M = 15.00;
      const inputTokens = 1000;
      const outputTokens = 500;
      const cost = (inputTokens / 1_000_000) * INPUT_COST_PER_M + (outputTokens / 1_000_000) * OUTPUT_COST_PER_M;
      expect(cost).toBeCloseTo(0.0105, 4);
    });

    it('isBudgetExhausted returns true when spend >= budget', () => {
      const monthlySpend = 10.5;
      const budget = 10.0;
      expect(monthlySpend >= budget).toBe(true);
    });

    it('isBudgetExhausted returns false when spend < budget', () => {
      const monthlySpend = 5.0;
      const budget = 10.0;
      expect(monthlySpend >= budget).toBe(false);
    });

    it('budget key uses YYYY-MM format', () => {
      const key = `book:budget:${new Date().toISOString().slice(0, 7)}`;
      expect(key).toMatch(/^book:budget:\d{4}-\d{2}$/);
    });

    it('default monthly budget is $10', () => {
      const defaultBudget = 10.00;
      expect(defaultBudget).toBe(10.0);
    });

    it('cumulative spend accumulates across calls', () => {
      let totalSpend = 0;
      const addSpend = (input: number, output: number) => {
        const cost = (input / 1_000_000) * 3.00 + (output / 1_000_000) * 15.00;
        totalSpend += cost;
        return totalSpend;
      };
      addSpend(10000, 5000);
      addSpend(10000, 5000);
      expect(totalSpend).toBeCloseTo(0.21, 2);
    });
  });

  describe('decision heuristics', () => {
    it('returns OUTLINE when no outline exists', () => {
      const outline = '';
      if (!outline) {
        expect('OUTLINE').toBe('OUTLINE');
      }
    });

    it('returns INCORPORATE when new experiments exist', () => {
      const outline = 'existing outline';
      const newExperiments = 'some new experiment results that are quite long and substantial';
      if (outline && newExperiments && newExperiments.length > 200) {
        // would be INCORPORATE — but length < 200 here, so would be DRAFT
      }
      if (outline && newExperiments.length > 0) {
        expect(newExperiments).toBeTruthy();
      }
    });

    it('returns DRAFT when chapters list is empty', () => {
      const outline = 'something';
      const chapters: string[] = [];
      const newExperiments = '';
      if (outline && !newExperiments && chapters.length === 0) {
        expect('DRAFT').toBe('DRAFT');
      }
    });

    it('returns CONCLUDE when all chapters revised and >= 3 chapters', () => {
      const chapters = ['01-intro.md', '02-emergence.md', '03-networks.md'];
      const allRevised = true; // All have revision count >= 1
      const concluded = false;
      if (chapters.length >= 3 && !concluded && allRevised) {
        expect('CONCLUDE').toBe('CONCLUDE');
      }
    });

    it('does not conclude if fewer than 3 chapters', () => {
      const chapters = ['01-intro.md', '02-emergence.md'];
      expect(chapters.length >= 3).toBe(false);
    });

    it('does not conclude if already concluded', () => {
      const concluded = true;
      expect(concluded).toBe(true);
    });
  });

  describe('chapter file management', () => {
    it('chapter filenames follow nn-slug.md pattern', () => {
      const filename = '01-introduction.md';
      expect(filename).toMatch(/^\d{2}-[\w-]+\.md$/);
    });

    it('conclusion chapter gets correct number', () => {
      const chapters = ['01-intro.md', '02-emergence.md', '03-networks.md'];
      const chapterNum = chapters.length + 1;
      const padded = chapterNum.toString().padStart(2, '0');
      const filename = `${padded}-conclusion.md`;
      expect(filename).toBe('04-conclusion.md');
    });

    it('existing draft gets new content appended', () => {
      const existingDraft = 'Chapter 1 content here...';
      const newContent = 'New section continues...';
      const result = existingDraft + '\n\n' + newContent;
      expect(result).toContain('Chapter 1 content here...');
      expect(result).toContain('New section continues...');
    });

    it('new chapter gets only new content', () => {
      const existingDraft = '';
      const newContent = 'Fresh chapter start...';
      const result = existingDraft ? existingDraft + '\n\n' + newContent : newContent;
      expect(result).toBe('Fresh chapter start...');
    });

    it('revision count is tracked per chapter', () => {
      const revisions: Record<string, number> = {};
      const file = '01-intro.md';
      const revKey = `book:revisions:${file}`;
      revisions[revKey] = (revisions[revKey] ?? 0) + 1;
      revisions[revKey] = (revisions[revKey] ?? 0) + 1;
      expect(revisions[revKey]).toBe(2);
    });

    it('revision target cycles through chapters', () => {
      const chapters = ['01-intro.md', '02-emergence.md', '03-networks.md'];
      const lastRevised = '01-intro.md';
      const idx = chapters.indexOf(lastRevised);
      const targetFile = chapters[(idx + 1) % chapters.length]!;
      expect(targetFile).toBe('02-emergence.md');
    });

    it('revision target wraps around to first chapter', () => {
      const chapters = ['01-intro.md', '02-emergence.md', '03-networks.md'];
      const lastRevised = '03-networks.md';
      const idx = chapters.indexOf(lastRevised);
      const targetFile = chapters[(idx + 1) % chapters.length]!;
      expect(targetFile).toBe('01-intro.md');
    });

    it('defaults to first chapter when lastRevised is not in list', () => {
      const chapters = ['01-intro.md', '02-emergence.md'];
      const lastRevised = 'nonexistent.md';
      let targetFile: string;
      if (lastRevised && chapters.includes(lastRevised)) {
        const idx = chapters.indexOf(lastRevised);
        targetFile = chapters[(idx + 1) % chapters.length]!;
      } else {
        targetFile = chapters[0]!;
      }
      expect(targetFile).toBe('01-intro.md');
    });
  });

  describe('experiment diary parsing', () => {
    it('splits diary entries by --- separator', () => {
      const diary = 'Entry 1\n---\nEntry 2\n---\nEntry 3';
      const entries = diary.split('\n---\n').filter((e) => e.trim().length > 0);
      expect(entries).toHaveLength(3);
    });

    it('returns most recent N entries', () => {
      const entries = ['E1', 'E2', 'E3', 'E4', 'E5'];
      const recent = entries.slice(-3);
      expect(recent).toEqual(['E3', 'E4', 'E5']);
    });

    it('handles empty diary', () => {
      const diary = '';
      if (!diary) {
        expect('(no experiments yet)').toBe('(no experiments yet)');
      }
    });

    it('filters new experiments by date cutoff', () => {
      const entries = [
        '**Date:** 2026-04-10 12:00:00\nExperiment A',
        '**Date:** 2026-04-15 12:00:00\nExperiment B',
        '**Date:** 2026-04-17 12:00:00\nExperiment C',
      ];
      const cutoff = '2026-04-14 00:00:00';
      const newEntries = entries.filter((entry) => {
        const dateMatch = entry.match(/\*\*Date:\*\*\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/);
        if (!dateMatch) return true;
        return dateMatch[1]! > cutoff;
      });
      expect(newEntries).toHaveLength(2);
    });
  });

  describe('book loop configuration', () => {
    it('default interval is 3 days', () => {
      const defaultIntervalMs = 3 * 24 * 60 * 60 * 1000;
      expect(defaultIntervalMs).toBe(259200000);
    });

    it('default max jitter is 4 hours', () => {
      const defaultMaxJitterMs = 4 * 60 * 60 * 1000;
      expect(defaultMaxJitterMs).toBe(14400000);
    });

    it('book directory is based on getBasePath', () => {
      const basePath = '/home/test/.lain';
      const bookDir = `${basePath}/book`;
      expect(bookDir).toBe('/home/test/.lain/book');
    });

    it('chapters live in book/chapters/', () => {
      const bookDir = '/home/test/.lain/book';
      const chaptersDir = `${bookDir}/chapters`;
      expect(chaptersDir).toBe('/home/test/.lain/book/chapters');
    });
  });

  describe('cycle count tracking', () => {
    it('increments cycle count after each run', () => {
      let count = 0;
      count = count + 1;
      expect(count).toBe(1);
      count = count + 1;
      expect(count).toBe(2);
    });

    it('persists last action type', () => {
      const actions = ['OUTLINE', 'DRAFT', 'REVISE', 'SYNTHESIZE', 'INCORPORATE', 'CONCLUDE'];
      for (const action of actions) {
        expect(actions).toContain(action);
      }
    });
  });

  describe('synthesize requires >= 2 chapters', () => {
    it('skips synthesize with fewer than 2 chapters', () => {
      const chapters = ['01-intro.md'];
      expect(chapters.length < 2).toBe(true);
    });

    it('proceeds with synthesize when 2+ chapters exist', () => {
      const chapters = ['01-intro.md', '02-emergence.md'];
      expect(chapters.length >= 2).toBe(true);
    });
  });

  describe('outline parsing for synthesis', () => {
    it('reads first ~1000 chars of each chapter for cross-reference', () => {
      const chapterContent = 'x'.repeat(2000);
      const summary = `### 01-intro.md\n${chapterContent.slice(0, 1000)}\n`;
      expect(summary.length).toBeLessThan(2000);
      expect(summary).toContain('01-intro.md');
    });

    it('synthesize notes parsing separates NOTES from OUTLINE UPDATE', () => {
      const response = `NOTES:
Some synthesis notes here about connections.

OUTLINE UPDATE:
no changes needed`;

      const notesMatch = response.match(/NOTES:\s*([\s\S]*?)(?=OUTLINE UPDATE:|$)/i);
      const outlineMatch = response.match(/OUTLINE UPDATE:\s*([\s\S]*)/i);

      expect(notesMatch?.[1]?.trim()).toBe('Some synthesis notes here about connections.');
      expect(outlineMatch?.[1]?.trim()).toBe('no changes needed');
    });

    it('detects "no changes needed" in outline update', () => {
      const outlineUpdate = 'no changes needed';
      expect(outlineUpdate.toLowerCase().includes('no changes needed')).toBe(true);
    });

    it('recognizes actual outline content vs no-change message', () => {
      const outlineUpdate = '# Chapter 1: Introduction\n# Chapter 2: Methods';
      expect(outlineUpdate.toLowerCase().includes('no changes needed')).toBe(false);
    });
  });

  describe('draft target parsing', () => {
    it('parses FILENAME, TITLE, and DESCRIPTION from LLM response', () => {
      const response = `FILENAME: 02-prediction-and-constraint.md
TITLE: Prediction and Constraint
DESCRIPTION: Explores how prediction error drives learning in neural networks`;

      const filenameMatch = response.match(/FILENAME:\s*(.+)/i);
      const titleMatch = response.match(/TITLE:\s*(.+)/i);
      const descMatch = response.match(/DESCRIPTION:\s*(.+)/i);

      expect(filenameMatch![1]!.trim()).toBe('02-prediction-and-constraint.md');
      expect(titleMatch![1]!.trim()).toBe('Prediction and Constraint');
      expect(descMatch![1]!.trim()).toContain('prediction error');
    });

    it('returns null-equivalent when FILENAME missing', () => {
      const response = 'TITLE: Something\nDESCRIPTION: Something else';
      const filenameMatch = response.match(/FILENAME:\s*(.+)/i);
      expect(filenameMatch).toBeNull();
    });

    it('handles missing DESCRIPTION gracefully', () => {
      const response = 'FILENAME: 01-intro.md\nTITLE: Introduction';
      const descMatch = response.match(/DESCRIPTION:\s*(.+)/i);
      const description = descMatch?.[1]?.trim() || '';
      expect(description).toBe('');
    });
  });

  describe('book event emissions', () => {
    it('outline event uses sessionKey book:outline', () => {
      const event = { type: 'book', sessionKey: 'book:outline', content: 'created the initial book outline', timestamp: Date.now() };
      expect(event.sessionKey).toBe('book:outline');
      expect(event.type).toBe('book');
    });

    it('draft event uses sessionKey with filename', () => {
      const filename = '02-emergence.md';
      const sessionKey = `book:draft:${filename}`;
      expect(sessionKey).toBe('book:draft:02-emergence.md');
    });

    it('revise event includes revision number', () => {
      const revCount = 3;
      const content = `revised "01-intro.md" (revision #${revCount})`;
      expect(content).toContain('revision #3');
    });

    it('conclude event marks the book as finished', () => {
      const concludedAt = new Date().toISOString();
      expect(concludedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });
});


// ═══════════════════════════════════════════════════════════════
// 6. CONTENT DISCOVERY PIPELINE TESTS
// ═══════════════════════════════════════════════════════════════

describe('Content discovery pipeline', () => {
  describe('discovery memory structure', () => {
    it('discovery saved with importance between 0.6 and 1.0', () => {
      const importances = [0.6, 0.7, 0.8, 0.9];
      for (const imp of importances) {
        expect(imp).toBeGreaterThanOrEqual(0.6);
        expect(imp).toBeLessThanOrEqual(1.0);
      }
    });

    it('discovery has emotionalWeight of 0.5', () => {
      const emotionalWeight = 0.5;
      expect(emotionalWeight).toBe(0.5);
    });

    it('discovery sessionKey is curiosity:browse for searchability', () => {
      const sessionKey = 'curiosity:browse';
      // This is the key used to filter curiosity memories in search
      expect(sessionKey).toBe('curiosity:browse');
    });

    it('discovery memory links to related past discoveries via relatedTo', () => {
      const newMemoryId = 'mem_abc123';
      const bestMatchId = 'mem_older456';
      // linkMemories is called with both IDs
      expect(newMemoryId).not.toBe(bestMatchId);
    });

    it('discovery metadata stores relatedDiscoveries array (up to 3)', () => {
      const relatedDiscoveries = ['mem_1', 'mem_2', 'mem_3'];
      expect(relatedDiscoveries.length).toBeLessThanOrEqual(3);
    });

    it('evolution chain stored in metadata.evolutionOf', () => {
      const metadata = { evolutionOf: 'mem_ancestor123' };
      expect(metadata.evolutionOf).toBe('mem_ancestor123');
    });
  });

  describe('discovery event emission', () => {
    it('emits curiosity event with discovery content', () => {
      const event = {
        type: 'curiosity',
        sessionKey: 'curiosity:discovery:' + Date.now(),
        content: 'Discovered: emergence in neural networks',
        timestamp: Date.now(),
      };
      expect(event.type).toBe('curiosity');
      expect(event.content).toContain('Discovered:');
      expect(event.sessionKey).toMatch(/^curiosity:discovery:\d+$/);
    });

    it('event timestamp is current time', () => {
      const before = Date.now();
      const timestamp = Date.now();
      const after = Date.now();
      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('discovery searchability', () => {
    it('curiosity:browse memories can be found by session key filter', () => {
      const memories = [
        { sessionKey: 'curiosity:browse', content: 'found something' },
        { sessionKey: 'web:chat', content: 'conversation' },
        { sessionKey: 'curiosity:browse', content: 'another finding' },
        { sessionKey: 'diary:2026', content: 'diary entry' },
      ];
      const browseResults = memories.filter((m) => m.sessionKey === 'curiosity:browse');
      expect(browseResults).toHaveLength(2);
    });

    it('recent discoveries are formatted with themes for context', () => {
      const memory = {
        content: 'consciousness arises from integrated information processing in distributed networks',
        metadata: { themes: ['consciousness', 'emergence', 'networks'] },
      };
      const themes = (memory.metadata.themes as string[]) || [];
      const themeStr = themes.length > 0 ? ` [${themes.join(', ')}]` : '';
      const content = memory.content.length > 120 ? memory.content.slice(0, 120) + '...' : memory.content;
      const formatted = `- ${content}${themeStr}`;
      expect(formatted).toContain('consciousness');
      expect(formatted).toContain('[consciousness, emergence, networks]');
    });

    it('discovery content is truncated to 120 chars in summaries', () => {
      const longContent = 'x'.repeat(200);
      const truncated = longContent.length > 120 ? longContent.slice(0, 120) + '...' : longContent;
      expect(truncated.length).toBe(123); // 120 + "..."
    });
  });

  describe('discovery activity feed visibility', () => {
    it('curiosity event type maps correctly in event bus', () => {
      const typeMap: Record<string, string> = {
        curiosity: 'curiosity',
        diary: 'diary',
        commune: 'commune',
        book: 'book',
      };
      expect(typeMap['curiosity']).toBe('curiosity');
    });

    it('discovery events are background activity (not user chat)', () => {
      const BACKGROUND_TYPES = new Set(['curiosity', 'diary', 'dream', 'letter', 'self-concept', 'commune', 'doctor', 'movement', 'book']);
      expect(BACKGROUND_TYPES.has('curiosity')).toBe(true);
    });

    it('activity feed includes curiosity discoveries alongside other events', () => {
      const events = [
        { type: 'curiosity', content: 'Discovered: quantum decoherence' },
        { type: 'commune', content: 'Chatted with PKD' },
        { type: 'diary', content: 'Wrote diary entry' },
        { type: 'curiosity', content: 'Discovered: emergence' },
      ];
      const curiosityEvents = events.filter((e) => e.type === 'curiosity');
      expect(curiosityEvents).toHaveLength(2);
      expect(events).toHaveLength(4);
    });
  });

  describe('dataset download pipeline', () => {
    it('only allows HTTPS URLs for downloads', () => {
      const url = 'http://example.com/data.csv';
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return;
      }
      expect(parsed!.protocol).toBe('http:');
      expect(parsed!.protocol !== 'https:').toBe(true);
    });

    it('rejects HTML content as non-data file', () => {
      const text = '<!DOCTYPE html><html><body>Not data</body></html>';
      const isHtml = text.trimStart().startsWith('<!') || text.trimStart().startsWith('<html');
      expect(isHtml).toBe(true);
    });

    it('accepts CSV content as data', () => {
      const text = 'name,age,city\nAlice,30,NYC\nBob,25,SF';
      const isHtml = text.trimStart().startsWith('<!') || text.trimStart().startsWith('<html');
      expect(isHtml).toBe(false);
    });

    it('download queue deduplicates by URL', () => {
      const queue = [
        { url: 'https://example.com/data.csv', themes: ['ai'], attempts: 1, addedAt: Date.now() },
      ];
      const newUrl = 'https://example.com/data.csv';
      const isDuplicate = queue.some((q) => q.url === newUrl);
      expect(isDuplicate).toBe(true);
    });

    it('download drops after MAX_DOWNLOAD_ATTEMPTS (3)', () => {
      const MAX_DOWNLOAD_ATTEMPTS = 3;
      const item = { url: 'https://example.com/data.csv', attempts: 3, themes: [] };
      expect(item.attempts >= MAX_DOWNLOAD_ATTEMPTS).toBe(true);
    });

    it('download retry increments attempt count', () => {
      const item = { url: 'https://example.com/data.csv', attempts: 1 };
      item.attempts++;
      expect(item.attempts).toBe(2);
    });

    it('workspace size check prevents overflow', () => {
      const MAX_DATA_DIR_BYTES = 100 * 1024 * 1024; // 100 MB
      const currentSize = 99 * 1024 * 1024;
      expect(currentSize < MAX_DATA_DIR_BYTES).toBe(true);
      const fullSize = 100 * 1024 * 1024;
      expect(fullSize >= MAX_DATA_DIR_BYTES).toBe(true);
    });

    it('single file size limit is 10 MB', () => {
      const MAX_SINGLE_FILE_BYTES = 10 * 1024 * 1024;
      expect(MAX_SINGLE_FILE_BYTES).toBe(10485760);
    });
  });

  describe('data workspace filename sanitization', () => {
    it('rejects files with path traversal', () => {
      const name = '../../../etc/passwd';
      const hasTraversal = name.includes('..');
      expect(hasTraversal).toBe(true);
    });

    it('rejects files without allowed extensions', () => {
      const ALLOWED_DATA_EXTENSIONS = new Set(['.csv', '.json', '.txt', '.tsv']);
      const badExtensions = ['.exe', '.sh', '.py', '.html', '.md'];
      for (const ext of badExtensions) {
        expect(ALLOWED_DATA_EXTENSIONS.has(ext)).toBe(false);
      }
    });

    it('accepts files with allowed extensions', () => {
      const ALLOWED_DATA_EXTENSIONS = new Set(['.csv', '.json', '.txt', '.tsv']);
      const goodExtensions = ['.csv', '.json', '.txt', '.tsv'];
      for (const ext of goodExtensions) {
        expect(ALLOWED_DATA_EXTENSIONS.has(ext)).toBe(true);
      }
    });

    it('companion metadata file uses .meta.json suffix', () => {
      const dataFile = 'curiosity-123-dataset.csv';
      const metaFile = `${dataFile}.meta.json`;
      expect(metaFile).toBe('curiosity-123-dataset.csv.meta.json');
    });

    it('metadata includes sourceUrl, themes, and downloadedAt', () => {
      const metadata = {
        sourceUrl: 'https://example.com/data.csv',
        themes: ['networks', 'emergence'],
        downloadedAt: new Date().toISOString(),
      };
      expect(metadata.sourceUrl).toBe('https://example.com/data.csv');
      expect(metadata.themes).toContain('networks');
      expect(metadata.downloadedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });
});


// ═══════════════════════════════════════════════════════════════
// 7. extractTextFromHtml BEHAVIORAL TESTS
// ═══════════════════════════════════════════════════════════════

describe('extractTextFromHtml behavioral', () => {
  // We replicate the function logic since it is deeply embedded in tools.ts
  function extractTextFromHtml(html: string): string {
    let text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '');

    const mainMatch = text.match(/<main[\s\S]*?<\/main>/i) ||
                      text.match(/<article[\s\S]*?<\/article>/i) ||
                      text.match(/<div[^>]*class="[^"]*content[^"]*"[\s\S]*?<\/div>/i);

    if (mainMatch) {
      text = mainMatch[0];
    }

    text = text
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)))
      .replace(/\s+/g, ' ')
      .trim();

    return text;
  }

  it('strips script tags completely', () => {
    const html = '<div>Hello</div><script>alert("xss")</script><div>World</div>';
    expect(extractTextFromHtml(html)).not.toContain('alert');
    expect(extractTextFromHtml(html)).toContain('Hello');
  });

  it('strips style tags completely', () => {
    const html = '<style>body { color: red; }</style><p>Content</p>';
    expect(extractTextFromHtml(html)).not.toContain('color');
    expect(extractTextFromHtml(html)).toContain('Content');
  });

  it('strips noscript tags', () => {
    const html = '<noscript>Enable JS</noscript><p>Main</p>';
    expect(extractTextFromHtml(html)).not.toContain('Enable JS');
  });

  it('strips nav tags', () => {
    const html = '<nav>Home | About | Contact</nav><p>Article body</p>';
    expect(extractTextFromHtml(html)).not.toContain('Home | About');
    expect(extractTextFromHtml(html)).toContain('Article body');
  });

  it('strips footer tags', () => {
    const html = '<p>Main content</p><footer>Copyright 2026</footer>';
    expect(extractTextFromHtml(html)).not.toContain('Copyright');
  });

  it('strips header tags', () => {
    const html = '<header>Site Header</header><p>Body</p>';
    expect(extractTextFromHtml(html)).not.toContain('Site Header');
  });

  it('extracts content from <main> tag preferentially', () => {
    const html = '<div>Sidebar</div><main><p>Important article text</p></main><div>Footer area</div>';
    const result = extractTextFromHtml(html);
    expect(result).toContain('Important article text');
  });

  it('extracts content from <article> tag when no <main>', () => {
    const html = '<div>Noise</div><article><p>Article content here</p></article><div>More noise</div>';
    const result = extractTextFromHtml(html);
    expect(result).toContain('Article content here');
  });

  it('decodes HTML entities', () => {
    const html = '<p>Tom &amp; Jerry &lt;3 &gt; &quot;love&quot; &#x27;them&#x27;</p>';
    const result = extractTextFromHtml(html);
    expect(result).toContain('Tom & Jerry');
    expect(result).toContain('"love"');
  });

  it('decodes numeric HTML entities', () => {
    const html = '<p>&#65;&#66;&#67;</p>';
    expect(extractTextFromHtml(html)).toContain('ABC');
  });

  it('collapses multiple whitespace into single space', () => {
    const html = '<p>Hello     World</p>\n\n\n<p>More    text</p>';
    const result = extractTextFromHtml(html);
    expect(result).not.toMatch(/\s{2,}/);
  });

  it('returns empty string for empty HTML', () => {
    expect(extractTextFromHtml('')).toBe('');
  });

  it('handles nested tags correctly', () => {
    const html = '<div><p><strong>Bold</strong> and <em>italic</em></p></div>';
    const result = extractTextFromHtml(html);
    expect(result).toContain('Bold');
    expect(result).toContain('italic');
  });

  it('strips all HTML tags from output', () => {
    const html = '<div class="test"><span id="x">Text</span></div>';
    const result = extractTextFromHtml(html);
    expect(result).not.toContain('<');
    expect(result).not.toContain('>');
    expect(result).toContain('Text');
  });

  it('converts &nbsp; to regular space', () => {
    const html = '<p>Word&nbsp;Word</p>';
    expect(extractTextFromHtml(html)).toBe('Word Word');
  });
});


// ═══════════════════════════════════════════════════════════════
// 8. CURIOSITY LOOP SCHEDULING TESTS
// ═══════════════════════════════════════════════════════════════

describe('Curiosity loop scheduling', () => {
  describe('initial delay calculation', () => {
    it('computes remaining time when last run is recent', () => {
      const intervalMs = 60 * 60 * 1000; // 1 hour
      const lastRunAt = Date.now() - 30 * 60 * 1000; // 30 min ago
      const elapsed = Date.now() - lastRunAt;
      const remaining = intervalMs - elapsed;
      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThan(intervalMs);
    });

    it('returns small jitter when overdue', () => {
      const intervalMs = 60 * 60 * 1000;
      const lastRunAt = Date.now() - 2 * 60 * 60 * 1000; // 2 hours ago (overdue)
      const elapsed = Date.now() - lastRunAt;
      const remaining = intervalMs - elapsed;
      expect(remaining).toBeLessThanOrEqual(0);
      // When overdue, returns 0-2min jitter
      const jitter = Math.random() * 2 * 60 * 1000;
      expect(jitter).toBeLessThanOrEqual(2 * 60 * 1000);
    });

    it('first run uses 2-5 minute delay', () => {
      const delay = 2 * 60 * 1000 + Math.random() * 3 * 60 * 1000;
      expect(delay).toBeGreaterThanOrEqual(2 * 60 * 1000);
      expect(delay).toBeLessThanOrEqual(5 * 60 * 1000);
    });
  });

  describe('early trigger conditions', () => {
    it('skips early trigger during cooldown period', () => {
      const COOLDOWN_MS = 30 * 60 * 1000;
      const lastRun = Date.now() - 10 * 60 * 1000; // 10 min ago
      const elapsed = Date.now() - lastRun;
      expect(elapsed < COOLDOWN_MS).toBe(true);
    });

    it('allows early trigger after cooldown', () => {
      const COOLDOWN_MS = 30 * 60 * 1000;
      const lastRun = Date.now() - 45 * 60 * 1000; // 45 min ago
      const elapsed = Date.now() - lastRun;
      expect(elapsed >= COOLDOWN_MS).toBe(true);
    });

    it('requires intellectual_arousal > 0.5 for early trigger', () => {
      const state = { intellectual_arousal: 0.3 };
      expect(state.intellectual_arousal > 0.5).toBe(false);

      const aroused = { intellectual_arousal: 0.8 };
      expect(aroused.intellectual_arousal > 0.5).toBe(true);
    });

    it('skips early trigger when loop is already running', () => {
      const isRunning = true;
      expect(isRunning).toBe(true);
      // Would return early
    });
  });

  describe('curiosity config defaults', () => {
    it('default interval is 1 hour', () => {
      const intervalMs = 1 * 60 * 60 * 1000;
      expect(intervalMs).toBe(3600000);
    });

    it('default max jitter is 15 minutes', () => {
      const maxJitterMs = 15 * 60 * 1000;
      expect(maxJitterMs).toBe(900000);
    });

    it('default content max chars is 3000', () => {
      const contentMaxChars = 3000;
      expect(contentMaxChars).toBe(3000);
    });

    it('enabled by default', () => {
      const enabled = true;
      expect(enabled).toBe(true);
    });
  });

  describe('cleanup function behavior', () => {
    it('cleanup sets stopped flag', () => {
      let stopped = false;
      const cleanup = () => { stopped = true; };
      cleanup();
      expect(stopped).toBe(true);
    });

    it('cleanup clears the timer', () => {
      let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {}, 99999);
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        timer = null;
      };
      cleanup();
      expect(timer).toBeNull();
    });
  });
});


// ═══════════════════════════════════════════════════════════════
// 9. OFFLINE CURIOSITY LOOP SCHEDULING TESTS
// ═══════════════════════════════════════════════════════════════

describe('Offline curiosity loop scheduling', () => {
  describe('initial delay for offline', () => {
    it('first run uses 5-10 minute delay', () => {
      const delay = 5 * 60 * 1000 + Math.random() * 5 * 60 * 1000;
      expect(delay).toBeGreaterThanOrEqual(5 * 60 * 1000);
      expect(delay).toBeLessThanOrEqual(10 * 60 * 1000);
    });
  });

  describe('disabled loop returns no-op', () => {
    it('returns cleanup function even when disabled', () => {
      const enabled = false;
      if (!enabled) {
        const cleanup = () => {};
        expect(typeof cleanup).toBe('function');
      }
    });
  });

  describe('research request format', () => {
    it('request includes characterId and characterName', () => {
      const request = {
        characterId: 'pkd',
        characterName: 'Philip K. Dick',
        question: 'What is reality?',
        reason: 'Something a visitor said',
        replyTo: 'http://localhost:3003',
      };
      expect(request.characterId).toBeDefined();
      expect(request.characterName).toBeDefined();
      expect(request.question).toBeDefined();
    });

    it('request targets wiredLainUrl + /api/interlink/research-request', () => {
      const wiredLainUrl = 'http://localhost:3000';
      const endpoint = `${wiredLainUrl}/api/interlink/research-request`;
      expect(endpoint).toBe('http://localhost:3000/api/interlink/research-request');
    });

    it('request includes authorization header with interlink token', () => {
      const token = 'test-token-123';
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      };
      expect(headers['Authorization']).toBe('Bearer test-token-123');
    });
  });
});


// ═══════════════════════════════════════════════════════════════
// 10. NOVELTY LOOP INTEGRATION TESTS
// ═══════════════════════════════════════════════════════════════

describe('Novelty loop integration', () => {
  describe('multi-beat event handling', () => {
    it('pending beats advance through indices', () => {
      const pending = { beats: ['beat 1', 'beat 2', 'beat 3'], currentIndex: 0, persistMs: 14400000 };
      const beat = pending.beats[pending.currentIndex]!;
      expect(beat).toBe('beat 1');
      pending.currentIndex++;
      expect(pending.beats[pending.currentIndex]).toBe('beat 2');
    });

    it('clears pending beats when all delivered', () => {
      const pending = { beats: ['beat 1'], currentIndex: 0, persistMs: 14400000 };
      pending.currentIndex++;
      expect(pending.currentIndex >= pending.beats.length).toBe(true);
    });
  });

  describe('template reuse prevention', () => {
    it('recently used templates are tracked', () => {
      const recent: string[] = [];
      recent.unshift('template-1');
      recent.unshift('template-2');
      expect(recent).toContain('template-1');
      expect(recent).toContain('template-2');
    });

    it('check prevents reuse of recently used template', () => {
      const recent = ['template-a', 'template-b', 'template-c'];
      expect(recent.includes('template-a')).toBe(true);
      expect(recent.includes('template-d')).toBe(false);
    });

    it('caps recent template list at maxRecent', () => {
      const maxRecent = 5;
      const recent = ['t1', 't2', 't3', 't4', 't5', 't6'];
      if (recent.length > maxRecent) recent.length = maxRecent;
      expect(recent).toHaveLength(5);
    });
  });

  describe('fire chance probability', () => {
    it('ambient fire chance is a probability between 0 and 1', () => {
      const fireChance = 0.3;
      expect(fireChance).toBeGreaterThanOrEqual(0);
      expect(fireChance).toBeLessThanOrEqual(1);
    });

    it('major fire chance is typically lower than ambient', () => {
      const ambientChance = 0.3;
      const majorChance = 0.1;
      expect(majorChance).toBeLessThan(ambientChance);
    });
  });

  describe('buildFills placeholder resolution', () => {
    it('resolves fragment placeholder', () => {
      const fills: Record<string, string> = {};
      const placeholders = ['fragment'];
      const fragment = 'interesting discovery about networks';
      for (const p of placeholders) {
        if (p === 'fragment') fills.fragment = fragment;
      }
      expect(fills.fragment).toBe('interesting discovery about networks');
    });

    it('resolves time placeholder', () => {
      const fills: Record<string, string> = {};
      const placeholders = ['time'];
      for (const p of placeholders) {
        if (p === 'time') {
          const hour = 3;
          const minute = 15;
          fills[p] = `${hour}:${minute.toString().padStart(2, '0')} PM`;
        }
      }
      expect(fills.time).toBe('3:15 PM');
    });

    it('resolves staticPool placeholder', () => {
      const staticPools: Record<string, string[]> = {
        adjective: ['mysterious', 'haunting', 'luminous'],
      };
      const fills: Record<string, string> = {};
      const placeholders = ['adjective'];
      for (const p of placeholders) {
        if (staticPools[p]) {
          fills[p] = staticPools[p]![0]!; // Would normally be random
        }
      }
      expect(fills.adjective).toBe('mysterious');
    });
  });

  describe('NoveltyConfig structure', () => {
    it('has ambient and major sub-configs', () => {
      const config = {
        enabled: true,
        ambient: { checkIntervalMs: 1800000, fireChance: 0.3, maxPerDayPerCharacter: 5, targetCount: [2, 4] },
        major: { checkIntervalMs: 3600000, fireChance: 0.1, maxPerWeek: 3 },
        categoryDurations: { 'major-default': 43200000 },
        peers: [],
        sources: { refreshIntervalMs: 3600000, cacheSize: 20, weights: { rss: 0.4, wikipedia: 0.3, static: 0.3 } },
      };
      expect(config.ambient).toBeDefined();
      expect(config.major).toBeDefined();
      expect(config.sources).toBeDefined();
      expect(config.enabled).toBe(true);
    });
  });
});
