import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('Newtown newspaper publisher', () => {
  it('publishes a runtime issue and index for the Paper page', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'newtown-paper-'));
    tempDirs.push(dir);

    const {
      getDefaultNewtownNewspaperConfig,
      publishNewspaperIfNeeded,
    } = await import('../src/agent/newspaper-publisher.js');

    const config = getDefaultNewtownNewspaperConfig(dir);
    config.fetchImpl = async (input) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      const port = url.port;

      const payload = port === '3003'
        ? [{ id: 'a', kind: 'memory', sessionKey: 'movement:station:theater', content: 'Neo headed to the Theater.', timestamp: Date.parse('2026-04-19T18:00:00Z') }]
        : port === '3004'
          ? [{ id: 'b', kind: 'memory', sessionKey: 'curiosity:offline', content: 'Plato asked whether appearance can train desire.', timestamp: Date.parse('2026-04-19T17:00:00Z') }]
          : [{ id: 'c', kind: 'memory', sessionKey: 'diary:daily', content: 'Joe wrote that a normal lunch still counts as a good day.', timestamp: Date.parse('2026-04-19T16:00:00Z') }];

      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    config.completeEdition = async () => [
      '## Ordinary Signals, Clear Skies',
      '',
      'The town moved a little, thought a little, and stayed recognizably itself.',
      '',
      '### Overheard In Town',
      '- Someone still believes lunch matters.',
    ].join('\n');

    const issue = await publishNewspaperIfNeeded(config, Date.parse('2026-04-19T20:00:00Z'));
    expect(issue).not.toBeNull();
    expect(issue?.date).toBe('2026-04-19');
    expect(issue?.activity_count).toBe(3);
    expect(issue?.content).toContain('Ordinary Signals');

    const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as Array<{ date: string }>;
    expect(index).toHaveLength(1);
    expect(index[0]?.date).toBe('2026-04-19');

    const savedIssue = JSON.parse(readFileSync(join(dir, '2026-04-19.json'), 'utf8')) as { editor_name: string };
    expect(['Neo', 'Plato', 'Joe']).toContain(savedIssue.editor_name);
  });

  it('uses Newtown residents as the default editor rotation', async () => {
    const { getDefaultNewtownNewspaperConfig } = await import('../src/agent/newspaper-publisher.js');
    const config = getDefaultNewtownNewspaperConfig('C:\\temp\\newspapers');

    expect(config.editors.map((editor) => editor.id)).toEqual(['neo', 'plato', 'joe']);
    expect(config.characters.map((character) => character.id)).toEqual(['neo', 'plato', 'joe']);
    expect(config.chronicleName).toBe('The Newtown Chronicle');
  });
});
