import { describe, expect, it } from 'vitest';

describe('Newtown CLI', () => {
  it('registers resident commands for Neo, Plato, and Joe', async () => {
    const { program } = await import('../src/cli/index.js');
    const commands = program.commands.map((command) => command.name());
    expect(commands).toContain('neo');
    expect(commands).toContain('plato');
    expect(commands).toContain('joe');
    expect(commands).toContain('web');
  });
});
