import { afterEach, describe, expect, it } from 'vitest';

describe('Newtown configuration', () => {
  const originalLainHome = process.env['LAIN_HOME'];
  const originalNewtownHome = process.env['NEWTOWN_HOME'];

  afterEach(() => {
    if (originalLainHome === undefined) delete process.env['LAIN_HOME'];
    else process.env['LAIN_HOME'] = originalLainHome;

    if (originalNewtownHome === undefined) delete process.env['NEWTOWN_HOME'];
    else process.env['NEWTOWN_HOME'] = originalNewtownHome;
  });

  it('defaults to a dedicated .newtown home when no env vars are set', async () => {
    delete process.env['LAIN_HOME'];
    delete process.env['NEWTOWN_HOME'];
    const { getBasePath } = await import('../src/config/paths.js');
    expect(getBasePath().endsWith('.newtown')).toBe(true);
  });

  it('uses NEWTOWN_HOME when LAIN_HOME is not set', async () => {
    delete process.env['LAIN_HOME'];
    process.env['NEWTOWN_HOME'] = '/tmp/newtown-home';
    const { getBasePath } = await import('../src/config/paths.js');
    expect(getBasePath()).toBe('/tmp/newtown-home');
  });

  it('default config points at MiniMax through the OpenAI-compatible endpoint', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    const config = getDefaultConfig();
    expect(config.agents[0]?.providers[0]?.type).toBe('openai');
    expect(config.agents[0]?.providers[0]?.model).toBeTruthy();
    expect(config.agents[0]?.providers[0]?.baseURL).toContain('/v1');
  });
});
