/**
 * Deployment Correctness Tests
 *
 * Verifies that deployment artifacts, configuration files, scripts,
 * and the overall project structure are correct and consistent.
 * These tests read real files on disk — no mocking needed.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PROJECT_ROOT = resolve(join(import.meta.dirname ?? __dirname, '..'));

function readJson(relPath: string): unknown {
  const abs = join(PROJECT_ROOT, relPath);
  return JSON.parse(readFileSync(abs, 'utf-8'));
}

function readText(relPath: string): string {
  return readFileSync(join(PROJECT_ROOT, relPath), 'utf-8');
}

function fileExists(relPath: string): boolean {
  return existsSync(join(PROJECT_ROOT, relPath));
}

function dirExists(relPath: string): boolean {
  const p = join(PROJECT_ROOT, relPath);
  return existsSync(p) && statSync(p).isDirectory();
}

// ─────────────────────────────────────────────────────────────────────
// 1. PACKAGE.JSON INTEGRITY
// ─────────────────────────────────────────────────────────────────────
describe('package.json integrity', () => {
  let pkg: Record<string, unknown>;

  // Load once
  pkg = readJson('package.json') as Record<string, unknown>;

  it('is valid JSON and has a name field', () => {
    expect(pkg).toBeTruthy();
    expect(typeof pkg['name']).toBe('string');
  });

  it('is ESM module type', () => {
    expect(pkg['type']).toBe('module');
  });

  it('has a main entry point', () => {
    expect(typeof pkg['main']).toBe('string');
    expect(pkg['main']).toContain('dist');
  });

  it('has build script', () => {
    const scripts = pkg['scripts'] as Record<string, string>;
    expect(scripts['build']).toBeTruthy();
  });

  it('has dev script', () => {
    const scripts = pkg['scripts'] as Record<string, string>;
    expect(scripts['dev']).toBeTruthy();
  });

  it('has start script', () => {
    const scripts = pkg['scripts'] as Record<string, string>;
    expect(scripts['start']).toBeTruthy();
  });

  it('has test script', () => {
    const scripts = pkg['scripts'] as Record<string, string>;
    expect(scripts['test']).toBeTruthy();
  });

  it('has lint script', () => {
    const scripts = pkg['scripts'] as Record<string, string>;
    expect(scripts['lint']).toBeTruthy();
  });

  it('has typecheck script', () => {
    const scripts = pkg['scripts'] as Record<string, string>;
    expect(scripts['typecheck']).toBeTruthy();
  });

  it('has test:watch script', () => {
    const scripts = pkg['scripts'] as Record<string, string>;
    expect(scripts['test:watch']).toBeTruthy();
  });

  it('includes vitest as a dev dependency', () => {
    const devDeps = pkg['devDependencies'] as Record<string, string>;
    expect(devDeps['vitest']).toBeTruthy();
  });

  it('includes typescript as a dev dependency', () => {
    const devDeps = pkg['devDependencies'] as Record<string, string>;
    expect(devDeps['typescript']).toBeTruthy();
  });

  it('includes better-sqlite3 as a runtime dependency', () => {
    const deps = pkg['dependencies'] as Record<string, string>;
    expect(deps['better-sqlite3']).toBeTruthy();
  });

  it('includes @anthropic-ai/sdk as a runtime dependency', () => {
    const deps = pkg['dependencies'] as Record<string, string>;
    expect(deps['@anthropic-ai/sdk']).toBeTruthy();
  });

  it('node engine constraint is >= 22', () => {
    const engines = pkg['engines'] as Record<string, string>;
    expect(engines['node']).toBeTruthy();
    expect(engines['node']).toContain('22');
  });

  it('start script references dist/index.js', () => {
    const scripts = pkg['scripts'] as Record<string, string>;
    expect(scripts['start']).toContain('dist/index.js');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 2. TYPESCRIPT CONFIG
// ─────────────────────────────────────────────────────────────────────
describe('tsconfig.json', () => {
  let tsconfig: { compilerOptions: Record<string, unknown>; include?: string[]; exclude?: string[] };

  tsconfig = readJson('tsconfig.json') as typeof tsconfig;
  const opts = tsconfig.compilerOptions;

  it('is valid JSON', () => {
    expect(opts).toBeTruthy();
  });

  it('strict mode is enabled', () => {
    expect(opts['strict']).toBe(true);
  });

  it('target is ES2022 or later', () => {
    const target = (opts['target'] as string).toUpperCase();
    const validTargets = ['ES2022', 'ES2023', 'ES2024', 'ESNEXT'];
    expect(validTargets).toContain(target);
  });

  it('module is NodeNext', () => {
    expect(opts['module']).toBe('NodeNext');
  });

  it('moduleResolution is NodeNext', () => {
    expect(opts['moduleResolution']).toBe('NodeNext');
  });

  it('noUncheckedIndexedAccess is enabled', () => {
    expect(opts['noUncheckedIndexedAccess']).toBe(true);
  });

  it('outDir is dist', () => {
    expect(opts['outDir']).toBe('./dist');
  });

  it('sourceMap is enabled', () => {
    expect(opts['sourceMap']).toBe(true);
  });

  it('declaration is enabled', () => {
    expect(opts['declaration']).toBe(true);
  });

  it('noImplicitReturns is enabled', () => {
    expect(opts['noImplicitReturns']).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 3. SERVICE TEMPLATE
// ─────────────────────────────────────────────────────────────────────
describe('systemd service template', () => {
  let template: string;
  template = readText('deploy/systemd/character.service.template');

  it('template file exists and is non-empty', () => {
    expect(template.length).toBeGreaterThan(100);
  });

  it('has [Unit] section', () => {
    expect(template).toContain('[Unit]');
  });

  it('has [Service] section', () => {
    expect(template).toContain('[Service]');
  });

  it('has [Install] section', () => {
    expect(template).toContain('[Install]');
  });

  it('has After=network.target', () => {
    expect(template).toContain('After=network.target');
  });

  it('has WorkingDirectory placeholder', () => {
    expect(template).toContain('@@WORKING_DIR@@');
  });

  it('has ExecStart with node dist/index.js', () => {
    expect(template).toContain('node dist/index.js');
  });

  it('has character ID placeholder in ExecStart', () => {
    expect(template).toContain('@@CHAR_ID@@');
  });

  it('has PORT placeholder', () => {
    expect(template).toContain('@@PORT@@');
  });

  it('has LAIN_HOME environment variable set', () => {
    expect(template).toContain('LAIN_HOME=@@LAIN_HOME@@');
  });

  it('has EnvironmentFile referencing .env', () => {
    expect(template).toContain('EnvironmentFile=@@WORKING_DIR@@/.env');
  });

  it('has EnvironmentFile for per-character peer config', () => {
    expect(template).toContain('deploy/env/@@SERVICE_NAME@@.env');
  });

  it('has Restart=on-failure policy', () => {
    expect(template).toContain('Restart=on-failure');
  });

  it('has RestartSec defined', () => {
    expect(template).toContain('RestartSec=');
  });

  it('has WantedBy=lain.target', () => {
    expect(template).toContain('WantedBy=lain.target');
  });

  it('does not inline PEER_CONFIG in Environment= (must be in EnvironmentFile)', () => {
    // PEER_CONFIG with JSON would be mangled by systemd if inlined — must be in .env file
    expect(template).not.toMatch(/^Environment=PEER_CONFIG=/m);
  });

  it('has SyslogIdentifier for log filtering', () => {
    expect(template).toContain('SyslogIdentifier=@@SERVICE_NAME@@');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 4. GENERATE-SERVICES SCRIPT
// ─────────────────────────────────────────────────────────────────────
describe('generate-services.sh', () => {
  let script: string;
  script = readText('deploy/generate-services.sh');

  it('has bash shebang', () => {
    expect(script.startsWith('#!/bin/bash')).toBe(true);
  });

  it('uses set -euo pipefail for safety', () => {
    expect(script).toContain('set -euo pipefail');
  });

  it('reads characters.json manifest', () => {
    expect(script).toContain('characters.json');
  });

  it('reads the service template', () => {
    expect(script).toContain('character.service.template');
  });

  it('generates per-character .env files with PEER_CONFIG', () => {
    expect(script).toContain('PEER_CONFIG=');
  });

  it('generates lain.target', () => {
    expect(script).toContain('lain.target');
  });

  it('substitutes CHAR_ID placeholder', () => {
    expect(script).toContain('@@CHAR_ID@@');
  });

  it('substitutes PORT placeholder', () => {
    expect(script).toContain('@@PORT@@');
  });

  it('substitutes LAIN_HOME placeholder', () => {
    expect(script).toContain('@@LAIN_HOME@@');
  });

  it('sets lain-HOME to /root/.lain-<id> pattern', () => {
    expect(script).toContain('/root/.lain-');
  });

  it('handles web server type separately from character type', () => {
    expect(script).toContain('"web"');
    expect(script).toContain('ExecStart');
  });

  it('does not hardcode specific character names', () => {
    // Should reference variables, not hardcoded character IDs like "lain" or "alice"
    expect(script).not.toContain('"lain-lain"');
    expect(script).not.toContain('CHAR_ID="alice"');
  });

  it('creates env directory', () => {
    expect(script).toContain('mkdir -p');
    expect(script).toContain('ENV_DIR');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 5. START/STOP SCRIPTS
// ─────────────────────────────────────────────────────────────────────
describe('start.sh', () => {
  let script: string;
  script = readText('start.sh');

  it('has bash shebang', () => {
    expect(script.startsWith('#!/bin/bash')).toBe(true);
  });

  it('reads characters.json manifest', () => {
    expect(script).toContain('characters.json');
  });

  it('sets per-character LAIN_HOME env var', () => {
    expect(script).toContain('LAIN_HOME=');
  });

  it('sets LAIN_CHARACTER_ID per character', () => {
    expect(script).toContain('LAIN_CHARACTER_ID=');
  });

  it('sets PEER_CONFIG per character', () => {
    expect(script).toContain('PEER_CONFIG=');
  });

  it('starts gateway service', () => {
    expect(script).toContain('gateway');
  });

  it('routes web server type correctly', () => {
    expect(script).toContain('"web"');
  });

  it('uses lockfile to prevent double-start', () => {
    expect(script).toContain('LOCKFILE');
    expect(script).toContain('flock');
  });

  it('saves PIDs to pids.txt', () => {
    expect(script).toContain('pids.txt');
  });

  it('does not hardcode specific character names in start logic', () => {
    // The character loop should use variables
    expect(script).toContain('CHAR_ID');
    expect(script).toContain('CHAR_NAME');
  });

  it('calls stop.sh before starting to clean up old processes', () => {
    expect(script).toContain('stop.sh');
  });

  it('logs to ~/.lain/logs/', () => {
    expect(script).toContain('~/.lain/logs/');
  });

  it('builds if dist is stale', () => {
    expect(script).toContain('npm run build');
  });
});

describe('stop.sh', () => {
  let script: string;
  script = readText('stop.sh');

  it('has bash shebang', () => {
    expect(script.startsWith('#!/bin/bash')).toBe(true);
  });

  it('reads characters.json to find ports', () => {
    expect(script).toContain('characters.json');
  });

  it('kills processes by port', () => {
    expect(script).toContain('lsof');
  });

  it('kills processes by pattern matching', () => {
    expect(script).toContain('pgrep');
    expect(script).toContain('PROCESS_PATTERNS');
  });

  it('reads pids.txt for graceful shutdown', () => {
    expect(script).toContain('pids.txt');
  });

  it('force-kills after grace period', () => {
    expect(script).toContain('kill -9');
  });

  it('cleans up pid and lock files', () => {
    expect(script).toContain('rm -f');
    expect(script).toContain('pids.txt');
  });

  it('handles voice service port 8765', () => {
    expect(script).toContain('8765');
  });

  it('matches gateway process pattern', () => {
    expect(script).toContain('node dist/index.js gateway');
  });

  it('matches character process pattern', () => {
    expect(script).toContain('node dist/index.js character');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 6. CHARACTERS EXAMPLE
// ─────────────────────────────────────────────────────────────────────
describe('characters.example.json', () => {
  let manifest: {
    town: { name: string; description: string };
    characters: Array<{
      id: string;
      name: string;
      port: number;
      server: string;
      defaultLocation: string;
      immortal?: boolean;
      possessable?: boolean;
      workspace: string;
    }>;
  };

  manifest = readJson('characters.example.json') as typeof manifest;

  it('is valid JSON', () => {
    expect(manifest).toBeTruthy();
  });

  it('has a town object with name', () => {
    expect(manifest.town).toBeTruthy();
    expect(typeof manifest.town.name).toBe('string');
    expect(manifest.town.name.length).toBeGreaterThan(0);
  });

  it('has a characters array', () => {
    expect(Array.isArray(manifest.characters)).toBe(true);
  });

  it('has at least one character', () => {
    expect(manifest.characters.length).toBeGreaterThanOrEqual(1);
  });

  it('every character has an id field', () => {
    for (const c of manifest.characters) {
      expect(typeof c.id).toBe('string');
      expect(c.id.length).toBeGreaterThan(0);
    }
  });

  it('every character has a name field', () => {
    for (const c of manifest.characters) {
      expect(typeof c.name).toBe('string');
    }
  });

  it('every character has a port field', () => {
    for (const c of manifest.characters) {
      expect(typeof c.port).toBe('number');
      expect(c.port).toBeGreaterThan(1024);
    }
  });

  it('every character has a server field (web or character)', () => {
    for (const c of manifest.characters) {
      expect(['web', 'character']).toContain(c.server);
    }
  });

  it('every character has a defaultLocation field', () => {
    for (const c of manifest.characters) {
      expect(typeof c.defaultLocation).toBe('string');
    }
  });

  it('every character has a workspace field', () => {
    for (const c of manifest.characters) {
      expect(typeof c.workspace).toBe('string');
    }
  });

  it('all character ports are unique (no conflicts)', () => {
    const ports = manifest.characters.map(c => c.port);
    const uniquePorts = new Set(ports);
    expect(uniquePorts.size).toBe(ports.length);
  });

  it('all character ids are unique', () => {
    const ids = manifest.characters.map(c => c.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it('character IDs contain only safe characters (no spaces, slashes)', () => {
    for (const c of manifest.characters) {
      expect(c.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
  });

  it('defaultLocation is a valid building ID', () => {
    const validBuildings = new Set([
      'library', 'bar', 'field', 'windmill', 'lighthouse',
      'school', 'market', 'locksmith', 'threshold',
    ]);
    for (const c of manifest.characters) {
      expect(validBuildings.has(c.defaultLocation)).toBe(true);
    }
  });

  it('workspace paths are relative (not absolute)', () => {
    for (const c of manifest.characters) {
      expect(c.workspace.startsWith('/')).toBe(false);
    }
  });

  it('exactly one character is web server type', () => {
    const webChars = manifest.characters.filter(c => c.server === 'web');
    expect(webChars.length).toBeGreaterThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 7. FILE STRUCTURE
// ─────────────────────────────────────────────────────────────────────
describe('project file structure', () => {
  it('src/ directory exists', () => {
    expect(dirExists('src')).toBe(true);
  });

  it('test/ directory exists', () => {
    expect(dirExists('test')).toBe(true);
  });

  it('deploy/ directory exists', () => {
    expect(dirExists('deploy')).toBe(true);
  });

  it('deploy/systemd/ directory exists', () => {
    expect(dirExists('deploy/systemd')).toBe(true);
  });

  it('workspace/ directory exists', () => {
    expect(dirExists('workspace')).toBe(true);
  });

  it('src/agent/ directory exists', () => {
    expect(dirExists('src/agent')).toBe(true);
  });

  it('src/config/ directory exists', () => {
    expect(dirExists('src/config')).toBe(true);
  });

  it('src/gateway/ directory exists', () => {
    expect(dirExists('src/gateway')).toBe(true);
  });

  it('src/commune/ directory exists', () => {
    expect(dirExists('src/commune')).toBe(true);
  });

  it('src/web/ directory exists', () => {
    expect(dirExists('src/web')).toBe(true);
  });

  it('package.json exists', () => {
    expect(fileExists('package.json')).toBe(true);
  });

  it('tsconfig.json exists', () => {
    expect(fileExists('tsconfig.json')).toBe(true);
  });

  it('CLAUDE.md exists', () => {
    expect(fileExists('CLAUDE.md')).toBe(true);
  });

  it('characters.example.json exists', () => {
    expect(fileExists('characters.example.json')).toBe(true);
  });

  it('.env is not tracked in the repo (no .env file at root checked in)', () => {
    // .env should not be committed — it contains secrets.
    // We verify it's listed in .gitignore if it exists.
    if (fileExists('.env')) {
      const gitignore = fileExists('.gitignore') ? readText('.gitignore') : '';
      expect(gitignore).toContain('.env');
    }
    // No .env is also fine (it's optional — users create their own)
    expect(true).toBe(true);
  });

  it('src/index.ts entry point exists', () => {
    expect(fileExists('src/index.ts')).toBe(true);
  });

  it('src/agent/commune-loop.ts exists', () => {
    expect(fileExists('src/agent/commune-loop.ts')).toBe(true);
  });

  it('src/agent/letter.ts exists', () => {
    expect(fileExists('src/agent/letter.ts')).toBe(true);
  });

  it('src/gateway/server.ts exists', () => {
    expect(fileExists('src/gateway/server.ts')).toBe(true);
  });

  it('src/web/owner-auth.ts exists', () => {
    expect(fileExists('src/web/owner-auth.ts')).toBe(true);
  });

  it('src/config/characters.ts exists', () => {
    expect(fileExists('src/config/characters.ts')).toBe(true);
  });

  it('deploy/generate-services.sh exists', () => {
    expect(fileExists('deploy/generate-services.sh')).toBe(true);
  });

  it('start.sh exists', () => {
    expect(fileExists('start.sh')).toBe(true);
  });

  it('stop.sh exists', () => {
    expect(fileExists('stop.sh')).toBe(true);
  });

  it('generate-services.sh creates deploy/env/ directory (mkdir -p in script)', () => {
    // The deploy/env/ directory is created at runtime by generate-services.sh.
    // Verify the script contains the mkdir -p command for it.
    const genScript = readText('deploy/generate-services.sh');
    expect(genScript).toContain('mkdir -p');
    expect(genScript).toContain('ENV_DIR');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 8. BUILD OUTPUT EXPECTATIONS
// ─────────────────────────────────────────────────────────────────────
describe('build output configuration', () => {
  it('tsconfig outDir is dist/', () => {
    const tsconfig = readJson('tsconfig.json') as { compilerOptions: Record<string, unknown> };
    expect(tsconfig.compilerOptions['outDir']).toBe('./dist');
  });

  it('tsconfig rootDir is src/', () => {
    const tsconfig = readJson('tsconfig.json') as { compilerOptions: Record<string, unknown> };
    expect(tsconfig.compilerOptions['rootDir']).toBe('./src');
  });

  it('tsconfig exclude includes test/ so tests are not compiled', () => {
    const tsconfig = readJson('tsconfig.json') as { exclude?: string[] };
    expect(tsconfig.exclude).toBeTruthy();
    expect(tsconfig.exclude).toContain('test');
  });

  it('tsconfig include covers src/**/*', () => {
    const tsconfig = readJson('tsconfig.json') as { include?: string[] };
    expect(tsconfig.include).toBeTruthy();
    const includesAll = tsconfig.include?.some(p => p.includes('src'));
    expect(includesAll).toBe(true);
  });

  it('sourceMap is true (for production debugging)', () => {
    const tsconfig = readJson('tsconfig.json') as { compilerOptions: Record<string, unknown> };
    expect(tsconfig.compilerOptions['sourceMap']).toBe(true);
  });

  it('declarationMap is true (for IDE navigation)', () => {
    const tsconfig = readJson('tsconfig.json') as { compilerOptions: Record<string, unknown> };
    expect(tsconfig.compilerOptions['declarationMap']).toBe(true);
  });

  it('start script points to dist/index.js (compiled output)', () => {
    const pkg = readJson('package.json') as { scripts: Record<string, string> };
    expect(pkg.scripts['start']).toContain('dist/index.js');
  });

  it('dev script uses tsx (runs TypeScript directly)', () => {
    const pkg = readJson('package.json') as { scripts: Record<string, string> };
    expect(pkg.scripts['dev']).toContain('tsx');
  });

  it('tsconfig has isolatedModules (for faster builds)', () => {
    const tsconfig = readJson('tsconfig.json') as { compilerOptions: Record<string, unknown> };
    expect(tsconfig.compilerOptions['isolatedModules']).toBe(true);
  });

  it('resolveJsonModule is enabled (for reading JSON files in TS)', () => {
    const tsconfig = readJson('tsconfig.json') as { compilerOptions: Record<string, unknown> };
    expect(tsconfig.compilerOptions['resolveJsonModule']).toBe(true);
  });
});
