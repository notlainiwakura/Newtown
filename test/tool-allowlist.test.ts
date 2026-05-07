// findings.md P2:1887 — per-character tool allowlist in the manifest.
// `getToolDefinitions(characterId)` intersects the full registry with the
// character's `allowedTools`. Characters without the field keep full access
// (backward-compat) but the fallback emits a warn-once log.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { _resetManifestCache, getAllowedTools } from '../src/config/characters.js';
import { getToolDefinitions, _resetAllowlistWarnings } from '../src/agent/tools.js';
import { getLogger } from '../src/utils/logger.js';

const fixturePath = join(process.cwd(), 'test', 'fixtures', 'manifest-production.json');

describe('findings.md P2:1887 — per-character tool allowlist', () => {
  const originalEnv = process.env['CHARACTERS_CONFIG'];

  beforeEach(() => {
    process.env['CHARACTERS_CONFIG'] = fixturePath;
    _resetManifestCache();
    _resetAllowlistWarnings();
  });

  afterEach(() => {
    if (originalEnv) process.env['CHARACTERS_CONFIG'] = originalEnv;
    else delete process.env['CHARACTERS_CONFIG'];
    _resetManifestCache();
    _resetAllowlistWarnings();
    vi.restoreAllMocks();
  });

  it('no characterId arg returns the full registered set (legacy callers)', () => {
    const full = getToolDefinitions();
    expect(full.length).toBeGreaterThan(0);
    expect(full.some((t) => t.name === 'get_current_time')).toBe(true);
    expect(full.some((t) => t.name === 'fetch_webpage')).toBe(true);
  });

  it("Lain's allowlist hides fetch_webpage and web_search (she uses WL for research)", () => {
    const lainTools = getToolDefinitions('lain').map((t) => t.name);
    expect(lainTools).not.toContain('fetch_webpage');
    expect(lainTools).not.toContain('web_search');
    // Still has her signature introspection + telegram + send_letter.
    expect(lainTools).toContain('introspect_read');
    expect(lainTools).toContain('send_message');
    expect(lainTools).toContain('send_letter');
  });

  it("PKD's allowlist hides tech tools (introspect_*, telegram_*, web)", () => {
    // Peer/object tools from character-tools.ts are registered at startup by
    // registerCharacterTools(), not at module load. This test doesn't run
    // that init, so only built-ins are in the registry — we check built-ins.
    const pkdTools = getToolDefinitions('pkd').map((t) => t.name);
    expect(pkdTools).not.toContain('fetch_webpage');
    expect(pkdTools).not.toContain('web_search');
    expect(pkdTools).not.toContain('introspect_read');
    expect(pkdTools).not.toContain('introspect_list');
    expect(pkdTools).not.toContain('telegram_call');
    expect(pkdTools).not.toContain('send_message');
    // But he still gets memory + letters (built-ins that are in his allowlist).
    expect(pkdTools).toContain('remember');
    expect(pkdTools).toContain('recall');
    expect(pkdTools).toContain('send_letter');
  });

  it('Wired Lain has the research surface (web_search + fetch_webpage)', () => {
    const wlTools = getToolDefinitions('wired-lain').map((t) => t.name);
    expect(wlTools).toContain('web_search');
    expect(wlTools).toContain('fetch_webpage');
  });

  it('characters with no allowedTools field warn once then return full set', () => {
    const logger = getLogger();
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const first = getToolDefinitions('mckenna');
    const second = getToolDefinitions('mckenna');

    expect(first.length).toBe(second.length);
    expect(first.length).toBeGreaterThan(0);

    const matchingCalls = warnSpy.mock.calls.filter((c) => {
      const payload = c[0] as { characterId?: string } | undefined;
      return payload?.characterId === 'mckenna';
    });
    expect(matchingCalls.length).toBe(1);
  });

  it('unknown characterId returns full set (fallback, not a throw)', () => {
    const logger = getLogger();
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const tools = getToolDefinitions('character-that-does-not-exist');
    expect(tools.length).toBeGreaterThan(0);
  });

  it('getAllowedTools mirrors the manifest entry', () => {
    expect(getAllowedTools('lain')).toBeTruthy();
    expect(getAllowedTools('lain')).not.toContain('fetch_webpage');
    expect(getAllowedTools('pkd')).toBeTruthy();
    expect(getAllowedTools('mckenna')).toBeNull();
    expect(getAllowedTools('does-not-exist')).toBeNull();
  });

  it('warns once per unknown name listed in an allowlist', () => {
    // Swap in a fixture that lists a nonexistent tool for a test character.
    // We simulate by monkey-patching the manifest cache through the loader.
    process.env['CHARACTERS_CONFIG'] = join(process.cwd(), 'test', 'fixtures', 'manifest-allowlist-typo.json');
    _resetManifestCache();
    _resetAllowlistWarnings();

    const logger = getLogger();
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    getToolDefinitions('lain');
    getToolDefinitions('lain'); // second call should not re-warn

    const typoWarnings = warnSpy.mock.calls.filter((c) => {
      const payload = c[0] as { toolName?: string } | undefined;
      return payload?.toolName === 'nonexistent_tool';
    });
    expect(typoWarnings.length).toBe(1);
  });
});
