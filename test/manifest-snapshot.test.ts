import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import {
  _resetManifestCache,
  getInhabitants,
  getOracles,
  getHealthCheckTargets,
  getDossierSubjects,
  getDreamSeedTargets,
  getCharacterDatabases,
  getSystemdUnit,
  getHomeDir,
} from '../src/config/characters.js';

describe('Manifest snapshot — production shape canary', () => {
  const fixturePath = join(process.cwd(), 'test', 'fixtures', 'manifest-production.json');
  const originalEnv = process.env['CHARACTERS_CONFIG'];

  beforeEach(() => {
    process.env['CHARACTERS_CONFIG'] = fixturePath;
    _resetManifestCache();
  });

  afterEach(() => {
    if (originalEnv) process.env['CHARACTERS_CONFIG'] = originalEnv;
    else delete process.env['CHARACTERS_CONFIG'];
    _resetManifestCache();
  });

  it('getInhabitants returns the 6 non-oracle characters', () => {
    expect(getInhabitants().map(c => c.id)).toEqual([
      'wired-lain', 'lain', 'pkd', 'mckenna', 'john', 'hiru',
    ]);
  });

  it('getOracles returns Dr. Claude only', () => {
    expect(getOracles().map(c => c.id)).toEqual(['dr-claude']);
  });

  it('getHealthCheckTargets returns all 7 characters', () => {
    expect(getHealthCheckTargets().map(c => c.id)).toEqual([
      'wired-lain', 'lain', 'dr-claude', 'pkd', 'mckenna', 'john', 'hiru',
    ]);
  });

  it('getDossierSubjects("wired-lain") returns 6 characters', () => {
    expect(getDossierSubjects('wired-lain').map(c => c.id)).toEqual([
      'lain', 'dr-claude', 'pkd', 'mckenna', 'john', 'hiru',
    ]);
  });

  it('getDreamSeedTargets returns all 7 characters', () => {
    expect(getDreamSeedTargets().map(c => c.id)).toEqual([
      'wired-lain', 'lain', 'dr-claude', 'pkd', 'mckenna', 'john', 'hiru',
    ]);
  });

  it('getCharacterDatabases returns id+homeDir for all 7', () => {
    expect(getCharacterDatabases()).toEqual([
      { id: 'wired-lain', homeDir: '/root/.lain-wired' },
      { id: 'lain', homeDir: '/root/.lain' },
      { id: 'dr-claude', homeDir: '/root/.lain-dr-claude' },
      { id: 'pkd', homeDir: '/root/.lain-pkd' },
      { id: 'mckenna', homeDir: '/root/.lain-mckenna' },
      { id: 'john', homeDir: '/root/.lain-john' },
      { id: 'hiru', homeDir: '/root/.lain-hiru' },
    ]);
  });

  it('getSystemdUnit resolves overrides then convention', () => {
    expect(getSystemdUnit('lain')).toBe('lain-main');
    expect(getSystemdUnit('wired-lain')).toBe('lain-wired');
    expect(getSystemdUnit('pkd')).toBe('lain-pkd');
    expect(getSystemdUnit('dr-claude')).toBe('lain-dr-claude');
  });

  it('getHomeDir resolves overrides then convention', () => {
    expect(getHomeDir('lain')).toBe('/root/.lain');
    expect(getHomeDir('wired-lain')).toBe('/root/.lain-wired');
    expect(getHomeDir('pkd')).toBe('/root/.lain-pkd');
    expect(getHomeDir('hiru')).toBe('/root/.lain-hiru');
  });

  it('drift fix — experiment DBs include Hiru', () => {
    const ids = getCharacterDatabases().map(c => c.id);
    expect(ids).toContain('hiru');
  });

  it('drift fix — experiment share-peers include Hiru and exclude wired-lain and dr-claude', () => {
    const inhabitants = getInhabitants().filter(c => c.id !== 'wired-lain');
    const ids = inhabitants.map(c => c.id);
    expect(ids).toContain('hiru');
    expect(ids).not.toContain('wired-lain');
    expect(ids).not.toContain('dr-claude');
  });

  it('drift fix — town-events notifies Hiru, skips Dr. Claude (oracle)', () => {
    const ids = getInhabitants().map(c => c.id);
    expect(ids).toContain('hiru');
    expect(ids).not.toContain('dr-claude');
  });

  it('drift fix — integrity check covers all inhabitants (excludes Dr. Claude oracle)', () => {
    const ids = getInhabitants().map(c => c.id);
    expect(ids).toContain('hiru');
    expect(ids).not.toContain('dr-claude');
  });

  it('drift fix — health-check tool covers all characters including Dr. Claude', () => {
    const ids = getHealthCheckTargets().map(c => c.id);
    expect(ids).toContain('dr-claude');
    expect(ids).toContain('hiru');
  });
});
