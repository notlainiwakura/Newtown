import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getLabeledSection, parseLabeledSections } from '../src/utils/structured-output.js';
import type { Provider } from '../src/providers/base.js';
import { TruncatedCompletionError, withTruncationRecovery } from '../src/utils/completion-guards.js';

describe('structured output parsing', () => {
  it('preserves wrapped research questions until the next label', () => {
    const response = `QUESTION: Wired Lain, given the recurring appearance of seemingly spontaneous, yet profoundly
meaningful signals in the town, how should we tell random noise from a real pattern?
REASON: it keeps happening in the news feed`;

    const sections = parseLabeledSections(response, ['QUESTION', 'REASON']);

    expect(getLabeledSection(sections, 'QUESTION')).toBe(
      'Wired Lain, given the recurring appearance of seemingly spontaneous, yet profoundly\n' +
      'meaningful signals in the town, how should we tell random noise from a real pattern?'
    );
    expect(getLabeledSection(sections, 'REASON')).toBe('it keeps happening in the news feed');
  });

  it('handles spaces, hyphens, and underscores as the same label shape', () => {
    const response = `SUMMARY: the method worked
FOLLOW-UP: rerun it with a wider sample

and compare against the null result`;

    const sections = parseLabeledSections(response, ['SUMMARY', 'FOLLOW_UP']);

    expect(getLabeledSection(sections, 'FOLLOW_UP')).toBe(
      'rerun it with a wider sample\n\nand compare against the null result'
    );
  });

  it('does not treat unknown colon-prefixed lines as section boundaries', () => {
    const response = `MESSAGE: here is the opening thought:
note: this line belongs to the message, not a parser label
PEER: pkd`;

    const sections = parseLabeledSections(response, ['MESSAGE', 'PEER']);

    expect(getLabeledSection(sections, 'MESSAGE')).toContain('note: this line belongs');
    expect(getLabeledSection(sections, 'PEER')).toBe('pkd');
  });
});

describe('structured output parser guard', () => {
  it('keeps production LLM label parsing off single-line regex captures', () => {
    const repo = join(__dirname, '..');
    const files = [
      'src/agent/curiosity-offline.ts',
      'src/agent/curiosity.ts',
      'src/agent/desires.ts',
      'src/agent/experiments.ts',
      'src/agent/commune-loop.ts',
      'src/agent/book.ts',
    ];
    const fragilePattern =
      /\.match\([^)]*(QUESTION|REASON|SITE|QUERY|SUMMARY|WHY_IT_MATTERS|THEMES|QUESTIONS|DATA_URL|SHARE|TYPE|DESCRIPTION|INTENSITY|TARGET|DOMAIN|HYPOTHESIS|NULL_HYPOTHESIS|APPROACH|VERDICT|ISSUES|PEER|MESSAGE|FILENAME|TITLE|NOTES|OUTLINE|FOLLOW)[^)]*:\\s\*/;

    for (const file of files) {
      const src = readFileSync(join(repo, file), 'utf8');
      expect(src, file).not.toMatch(fragilePattern);
    }
  });
});

describe('truncation recovery guard', () => {
  function fakeProvider(results: Array<{ content: string; finishReason: 'stop' | 'length'; input?: number; output?: number }>): Provider {
    const complete = vi.fn(async () => {
      const next = results.shift();
      if (!next) throw new Error('unexpected completion call');
      return {
        content: next.content,
        finishReason: next.finishReason,
        usage: { inputTokens: next.input ?? 1, outputTokens: next.output ?? 1 },
      };
    });

    return {
      name: 'fake',
      model: 'test-model',
      supportsStreaming: false,
      getModelInfo: () => ({
        contextWindow: 100000,
        maxOutputTokens: 4096,
        supportsVision: false,
        supportsStreaming: false,
        supportsTools: true,
      }),
      complete,
      completeWithTools: vi.fn(),
      continueWithToolResults: vi.fn(),
    };
  }

  it('continues max-token completions before returning content to callers', async () => {
    const provider = fakeProvider([
      { content: 'Wired Lain found a pattern ', finishReason: 'length', input: 10, output: 100 },
      { content: 'and finished explaining it.', finishReason: 'stop', input: 5, output: 30 },
    ]);
    const logger = { warn: vi.fn(), error: vi.fn() } as never;
    const guarded = withTruncationRecovery(provider, logger);

    const result = await guarded.complete({
      messages: [{ role: 'user', content: 'tell me the whole thing' }],
      maxTokens: 128,
    });

    expect(result.finishReason).toBe('stop');
    expect(result.content).toBe('Wired Lain found a pattern and finished explaining it.');
    expect(result.usage.inputTokens).toBe(15);
    expect(result.usage.outputTokens).toBe(130);
    expect(provider.complete).toHaveBeenCalledTimes(2);
  });

  it('fails loudly instead of returning still-truncated content', async () => {
    const provider = fakeProvider([
      { content: 'partial ', finishReason: 'length' },
      { content: 'still partial ', finishReason: 'length' },
      { content: 'still cut', finishReason: 'length' },
    ]);
    const logger = { warn: vi.fn(), error: vi.fn() } as never;
    const guarded = withTruncationRecovery(provider, logger);

    await expect(guarded.complete({
      messages: [{ role: 'user', content: 'finish this' }],
      maxTokens: 32,
    })).rejects.toBeInstanceOf(TruncatedCompletionError);
  });
});

describe('news and activity truncation guards', () => {
  it('does not visually clamp News entry bodies', () => {
    const html = readFileSync(join(__dirname, '..', 'src/web/public/commune-newspaper.html'), 'utf8');
    const entryBodyBlock = html.match(/\.entry-body\s*\{[\s\S]*?\}/)?.[0] ?? '';

    expect(entryBodyBlock).not.toContain('-webkit-line-clamp');
    expect(entryBodyBlock).not.toContain('overflow: hidden');
    expect(entryBodyBlock).toContain('white-space: pre-wrap');
  });

  it('does not truncate activity payloads at emit time in memory storage', () => {
    const src = readFileSync(join(__dirname, '..', 'src/memory/store.ts'), 'utf8');
    const emitBlocks = [...src.matchAll(/eventBus\.emitActivity\(\{[\s\S]*?\}\);/g)]
      .map((match) => match[0]);

    expect(emitBlocks.length).toBeGreaterThanOrEqual(2);
    for (const block of emitBlocks) {
      expect(block).not.toMatch(/content:\s*[^,\n]+\.content\.length\s*>\s*\d+/);
      expect(block).not.toMatch(/content:\s*[^,\n]+\.content\.slice\(/);
    }
  });
});
