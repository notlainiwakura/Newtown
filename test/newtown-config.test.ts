import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('Newtown configuration', () => {
  const originalLainHome = process.env['LAIN_HOME'];
  const originalNewtownHome = process.env['NEWTOWN_HOME'];
  const originalCharactersConfig = process.env['CHARACTERS_CONFIG'];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();

    if (originalLainHome === undefined) delete process.env['LAIN_HOME'];
    else process.env['LAIN_HOME'] = originalLainHome;

    if (originalNewtownHome === undefined) delete process.env['NEWTOWN_HOME'];
    else process.env['NEWTOWN_HOME'] = originalNewtownHome;

    if (originalCharactersConfig === undefined) delete process.env['CHARACTERS_CONFIG'];
    else process.env['CHARACTERS_CONFIG'] = originalCharactersConfig;
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

  it('prefers LAIN_HOME for per-character process isolation', async () => {
    process.env['LAIN_HOME'] = '/tmp/newtown-character';
    process.env['NEWTOWN_HOME'] = '/tmp/newtown-root';
    const { getBasePath } = await import('../src/config/paths.js');
    expect(getBasePath()).toBe('/tmp/newtown-character');
  });

  it('uses a Windows named pipe for the gateway socket on win32', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('win32');
    process.env['LAIN_HOME'] = 'C:\\Users\\akaik\\.newtown\\guide';
    delete process.env['NEWTOWN_HOME'];
    const { getPaths } = await import('../src/config/paths.js');
    expect(getPaths().socket).toContain('\\\\.\\pipe\\');
  });

  it('manifest providers point at MiniMax through the OpenAI-compatible endpoint', async () => {
    delete process.env['CHARACTERS_CONFIG'];
    const { getProvidersFor } = await import('../src/config/characters.js');
    const providers = getProvidersFor('newtown');
    expect(providers[0]?.type).toBe('openai');
    expect(providers[0]?.model).toBe('MiniMax-M2.7');
    expect(providers[0]?.baseURL).toContain('/v1');
  });
});
