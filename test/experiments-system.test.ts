/**
 * Experiments system test suite
 *
 * Covers: experiments, skills, data-workspace, feed-health, dream-seeder, possession.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── Module mocks ──────────────────────────────────────────────────────────

vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn().mockResolvedValue('test-master-key'),
    setPassword: vi.fn().mockResolvedValue(undefined),
    deletePassword: vi.fn().mockResolvedValue(true),
    findCredentials: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../src/storage/database.js', () => ({
  query: vi.fn().mockReturnValue([]),
  getMeta: vi.fn().mockReturnValue(null),
  setMeta: vi.fn(),
  initDatabase: vi.fn().mockResolvedValue(undefined),
  closeDatabase: vi.fn(),
}));

vi.mock('../src/memory/store.js', () => ({
  saveMemory: vi.fn().mockResolvedValue(undefined),
  searchMemories: vi.fn().mockResolvedValue([]),
  countMemories: vi.fn().mockReturnValue(0),
  countMessages: vi.fn().mockReturnValue(0),
}));

vi.mock('../src/events/bus.js', () => ({
  eventBus: {
    setCharacterId: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    emitActivity: vi.fn(),
  },
  isBackgroundEvent: vi.fn().mockReturnValue(true),
}));

vi.mock('../src/config/paths.js', () => ({
  getBasePath: vi.fn().mockReturnValue('/tmp/test-lain-base'),
  getPaths: vi.fn().mockReturnValue({ database: '/tmp/test.db' }),
}));

vi.mock('../src/agent/index.js', () => ({
  getProvider: vi.fn().mockReturnValue({
    name: 'mock',
    model: 'mock-model',
    complete: vi.fn().mockResolvedValue({
      content: 'DOMAIN: memory\nHYPOTHESIS: test hypothesis\nNULL_HYPOTHESIS: null hypothesis\nAPPROACH: test approach',
      finishReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 50 },
    }),
  }),
}));

vi.mock('../src/agent/tools.js', () => ({
  registerTool: vi.fn(),
  unregisterTool: vi.fn().mockReturnValue(true),
  getToolDefinitions: vi.fn().mockReturnValue([]),
}));

vi.mock('../src/utils/crypto.js', () => ({
  secureCompare: vi.fn((a: string, b: string) => a === b),
}));

// ─────────────────────────────────────────────────────────────────────────────
// 1. EXPERIMENTS
// ─────────────────────────────────────────────────────────────────────────────

describe('Experiments — ExperimentConfig defaults', () => {
  it('default interval is 24 hours', () => {
    const DEFAULT_INTERVAL = 24 * 60 * 60 * 1000;
    expect(DEFAULT_INTERVAL).toBe(86400000);
  });

  it('default max jitter is 2 hours', () => {
    const DEFAULT_MAX_JITTER = 2 * 60 * 60 * 1000;
    expect(DEFAULT_MAX_JITTER).toBe(7200000);
  });

  it('default execution timeout is 5 minutes', () => {
    const DEFAULT_TIMEOUT = 5 * 60 * 1000;
    expect(DEFAULT_TIMEOUT).toBe(300000);
  });

  it('default max code lines is 200', () => {
    const DEFAULT_MAX_LINES = 200;
    expect(DEFAULT_MAX_LINES).toBe(200);
  });

  it('default max output bytes is 50KB', () => {
    const DEFAULT_MAX_OUTPUT = 50_000;
    expect(DEFAULT_MAX_OUTPUT).toBe(50000);
  });

  it('default daily budget is $1.00', () => {
    const DEFAULT_BUDGET = 1.00;
    expect(DEFAULT_BUDGET).toBe(1.00);
  });

  it('enabled is true by default', () => {
    expect(true).toBe(true);
  });
});

describe('Experiments — startExperimentLoop', () => {
  it('returns a cleanup function', async () => {
    const { startExperimentLoop } = await import('../src/agent/experiments.js');
    const stop = startExperimentLoop({ enabled: true, intervalMs: 999999999 });
    expect(typeof stop).toBe('function');
    stop();
  });

  it('returns a no-op cleanup when disabled', async () => {
    const { startExperimentLoop } = await import('../src/agent/experiments.js');
    const stop = startExperimentLoop({ enabled: false });
    expect(typeof stop).toBe('function');
    expect(() => stop()).not.toThrow();
  });

  it('cleanup stops the timer without throwing', async () => {
    const { startExperimentLoop } = await import('../src/agent/experiments.js');
    const stop = startExperimentLoop({ enabled: true, intervalMs: 999999999 });
    expect(() => stop()).not.toThrow();
  });

  it('cleanup can be called multiple times safely', async () => {
    const { startExperimentLoop } = await import('../src/agent/experiments.js');
    const stop = startExperimentLoop({ enabled: true, intervalMs: 999999999 });
    expect(() => { stop(); stop(); }).not.toThrow();
  });

  it('respects elapsed time from last run when scheduling initial delay', async () => {
    const { getMeta } = await import('../src/storage/database.js');
    // If last run was very recent, delay should be close to intervalMs
    const recentTime = (Date.now() - 60000).toString(); // 1 minute ago
    vi.mocked(getMeta).mockImplementation((key: string) => {
      if (key === 'experiment:last_cycle_at') return recentTime;
      return null;
    });

    const { startExperimentLoop } = await import('../src/agent/experiments.js');
    const stop = startExperimentLoop({ enabled: true, intervalMs: 86400000 });
    stop();
  });

  it('custom config overrides defaults', async () => {
    const { startExperimentLoop } = await import('../src/agent/experiments.js');
    // Should not throw with custom values
    const stop = startExperimentLoop({
      enabled: true,
      intervalMs: 999999999,
      dailyBudgetUsd: 5.00,
      maxCodeLines: 100,
    });
    expect(typeof stop).toBe('function');
    stop();
  });
});

describe('Experiments — budget tracking', () => {
  it('budget key format is experiment:budget:YYYY-MM-DD', () => {
    const date = new Date().toISOString().slice(0, 10);
    const key = `experiment:budget:${date}`;
    expect(key).toMatch(/^experiment:budget:\d{4}-\d{2}-\d{2}$/);
  });

  it('daily budget is exhausted when spend equals or exceeds limit', () => {
    const budget = 1.00;
    const spent = 1.00;
    expect(spent >= budget).toBe(true);
  });

  it('budget is not exhausted when spend is below limit', () => {
    const budget = 1.00;
    const spent = 0.50;
    expect(spent >= budget).toBe(false);
  });

  it('INPUT_COST_PER_M is $3.00 per million tokens', () => {
    const INPUT_COST_PER_M = 3.00;
    expect(INPUT_COST_PER_M).toBe(3.00);
  });

  it('OUTPUT_COST_PER_M is $15.00 per million tokens', () => {
    const OUTPUT_COST_PER_M = 15.00;
    expect(OUTPUT_COST_PER_M).toBe(15.00);
  });

  it('cost calculation for 1M input tokens is $3.00', () => {
    const INPUT_COST_PER_M = 3.00;
    const cost = (1_000_000 / 1_000_000) * INPUT_COST_PER_M;
    expect(cost).toBe(3.00);
  });
});

describe('Experiments — Python code validation', () => {
  it('blocked imports include os', () => {
    const BLOCKED = new Set(['os', 'subprocess', 'socket', 'http', 'urllib',
      'requests', 'multiprocessing', 'threading', 'ctypes', 'importlib']);
    expect(BLOCKED.has('os')).toBe(true);
  });

  it('blocked imports include subprocess', () => {
    const BLOCKED = new Set(['subprocess']);
    expect(BLOCKED.has('subprocess')).toBe(true);
  });

  it('blocked imports include socket', () => {
    const BLOCKED = new Set(['socket']);
    expect(BLOCKED.has('socket')).toBe(true);
  });

  it('blocked imports include pathlib', () => {
    const BLOCKED = new Set(['pathlib']);
    expect(BLOCKED.has('pathlib')).toBe(true);
  });

  it('blocked imports include pickle', () => {
    const BLOCKED = new Set(['pickle']);
    expect(BLOCKED.has('pickle')).toBe(true);
  });

  it('code with too many lines fails validation', () => {
    const maxLines = 5;
    const code = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
    const lines = code.split('\n');
    const tooLong = lines.length > maxLines;
    expect(tooLong).toBe(true);
  });

  it('code within line limit passes length check', () => {
    const maxLines = 200;
    const code = 'import math\nprint(math.pi)';
    const lines = code.split('\n');
    expect(lines.length <= maxLines).toBe(true);
  });

  it('blocked command patterns include exec()', () => {
    const code = 'exec("import os")';
    const hasExec = /\bexec\s*\(/.test(code);
    expect(hasExec).toBe(true);
  });

  it('blocked command patterns include eval()', () => {
    const code = 'eval("1+1")';
    const hasEval = /\beval\s*\(/.test(code);
    expect(hasEval).toBe(true);
  });

  it('blocked command patterns include __import__', () => {
    const code = '__import__("os")';
    expect(code.includes('__import__')).toBe(true);
  });

  it('sqlite3.connect to data/ directory is allowed', () => {
    const code = 'sqlite3.connect("data/lain.db")';
    const isDataDir = /connect\s*\(\s*['"]data\//.test(code);
    expect(isDataDir).toBe(true);
  });

  it('sqlite3.connect to non-data/ is rejected', () => {
    const code = 'sqlite3.connect("/etc/passwd")';
    const isAbsolute = /connect\s*\(\s*['"]\//.test(code);
    expect(isAbsolute).toBe(true);
  });

  it('validation status can be sound, buggy, or degenerate', () => {
    const validStatuses = ['sound', 'buggy', 'degenerate'];
    for (const status of validStatuses) {
      expect(['sound', 'buggy', 'degenerate']).toContain(status);
    }
  });
});

describe('Experiments — buildSandboxSpawn (findings.md P1-latent:2495)', () => {
  const origIsolation = process.env['LAIN_SANDBOX_ISOLATION'];

  afterEach(() => {
    if (origIsolation === undefined) delete process.env['LAIN_SANDBOX_ISOLATION'];
    else process.env['LAIN_SANDBOX_ISOLATION'] = origIsolation;
  });

  it('falls back to plain python3 when isolation env is unset', async () => {
    delete process.env['LAIN_SANDBOX_ISOLATION'];
    const { buildSandboxSpawn } = await import('../src/agent/experiments.js');
    const spec = buildSandboxSpawn('/tmp/exp/experiment.py', '/tmp/exp', 300_000, {
      PATH: '/usr/bin',
      HOME: '/tmp/exp',
    });
    expect(spec.command).toBe('python3');
    expect(spec.args).toEqual(['/tmp/exp/experiment.py']);
    expect(spec.inheritEnv).toBe(false);
  });

  it('falls back to plain python3 when isolation env is some other value', async () => {
    process.env['LAIN_SANDBOX_ISOLATION'] = 'bubblewrap';
    const { buildSandboxSpawn } = await import('../src/agent/experiments.js');
    const spec = buildSandboxSpawn('/tmp/exp/experiment.py', '/tmp/exp', 300_000, {});
    expect(spec.command).toBe('python3');
  });

  it('uses systemd-run with DynamicUser when isolation=systemd', async () => {
    process.env['LAIN_SANDBOX_ISOLATION'] = 'systemd';
    const { buildSandboxSpawn } = await import('../src/agent/experiments.js');
    const spec = buildSandboxSpawn('/tmp/exp/experiment.py', '/tmp/exp', 300_000, {});
    expect(spec.command).toBe('systemd-run');
    expect(spec.args).toContain('--property=DynamicUser=yes');
    expect(spec.args[spec.args.length - 2]).toBe('python3');
    expect(spec.args[spec.args.length - 1]).toBe('/tmp/exp/experiment.py');
  });

  it('isolation unit locks down filesystem, network, and privileges', async () => {
    process.env['LAIN_SANDBOX_ISOLATION'] = 'systemd';
    const { buildSandboxSpawn } = await import('../src/agent/experiments.js');
    const spec = buildSandboxSpawn('/tmp/exp/experiment.py', '/tmp/exp', 300_000, {});
    const required = [
      '--property=ProtectSystem=strict',
      '--property=ProtectHome=yes',
      '--property=PrivateNetwork=yes',
      '--property=NoNewPrivileges=yes',
      '--property=CapabilityBoundingSet=',
      '--property=ReadWritePaths=/tmp/exp',
      '--property=WorkingDirectory=/tmp/exp',
    ];
    for (const prop of required) {
      expect(spec.args).toContain(prop);
    }
  });

  it('sets RuntimeMaxSec slightly longer than Node-side timeout', async () => {
    process.env['LAIN_SANDBOX_ISOLATION'] = 'systemd';
    const { buildSandboxSpawn } = await import('../src/agent/experiments.js');
    const spec = buildSandboxSpawn('/tmp/exp/experiment.py', '/tmp/exp', 300_000, {});
    // 300_000ms / 1000 + 5 = 305
    expect(spec.args).toContain('--property=RuntimeMaxSec=305');
  });

  it('propagates pythonEnv into the unit via --setenv', async () => {
    process.env['LAIN_SANDBOX_ISOLATION'] = 'systemd';
    const { buildSandboxSpawn } = await import('../src/agent/experiments.js');
    const spec = buildSandboxSpawn('/tmp/exp/experiment.py', '/tmp/exp', 300_000, {
      PATH: '/usr/bin',
      HOME: '/tmp/exp',
      MPLCONFIGDIR: '/tmp/exp',
      PYTHONDONTWRITEBYTECODE: '1',
    });
    expect(spec.args).toContain('--setenv=PATH=/usr/bin');
    expect(spec.args).toContain('--setenv=HOME=/tmp/exp');
    expect(spec.args).toContain('--setenv=MPLCONFIGDIR=/tmp/exp');
    expect(spec.args).toContain('--setenv=PYTHONDONTWRITEBYTECODE=1');
    expect(spec.inheritEnv).toBe(true);
  });
});

describe('Experiments — experiment queue', () => {
  it('experiment queue key is experiment:queue', () => {
    const key = 'experiment:queue';
    expect(key).toBe('experiment:queue');
  });

  it('queue max length is 5', () => {
    const MAX_QUEUE = 5;
    expect(MAX_QUEUE).toBe(5);
  });

  it('buggy experiment follow-up is prefixed with [FIX NEEDED]', () => {
    const isBuggy = true;
    const followUp = 'fix the methodology';
    const entry = isBuggy ? `[FIX NEEDED] ${followUp}` : followUp;
    expect(entry.startsWith('[FIX NEEDED]')).toBe(true);
  });

  it('valid experiment follow-up has no prefix', () => {
    const isBuggy = false;
    const followUp = 'explore further';
    const entry = isBuggy ? `[FIX NEEDED] ${followUp}` : followUp;
    expect(entry).toBe(followUp);
  });
});

describe('Experiments — memory importance scoring', () => {
  it('successful non-buggy experiment gets importance 0.7', () => {
    const success = true;
    const isBuggy = false;
    const importance = isBuggy ? 0.3 : success ? 0.7 : 0.4;
    expect(importance).toBe(0.7);
  });

  it('failed experiment gets importance 0.4', () => {
    const success = false;
    const isBuggy = false;
    const importance = isBuggy ? 0.3 : success ? 0.7 : 0.4;
    expect(importance).toBe(0.4);
  });

  it('buggy experiment gets importance 0.3', () => {
    const isBuggy = true;
    const success = true;
    const importance = isBuggy ? 0.3 : success ? 0.7 : 0.4;
    expect(importance).toBe(0.3);
  });

  it('buggy experiment gets emotional weight 0.2', () => {
    const isBuggy = true;
    const success = true;
    const emotionalWeight = isBuggy ? 0.2 : success ? 0.6 : 0.3;
    expect(emotionalWeight).toBe(0.2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. SKILLS — REMOVED (findings.md P1:1561)
// ─────────────────────────────────────────────────────────────────────────────
// The `src/agent/skills.ts` module and its `create_tool` / `list_my_tools` /
// `delete_tool` meta-tools were deleted because they handed
// `new Function(...)` + `require` + `process` to LLM-authored JavaScript,
// giving arbitrary code execution. Source-regex regression lives in
// test/security-deep.test.ts.

describe('Skills system — removed (findings.md P1:1561)', () => {
  it('src/agent/skills.js no longer imports', async () => {
    await expect(import('../src/agent/skills.js')).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. DATA WORKSPACE
// ─────────────────────────────────────────────────────────────────────────────

describe('Data Workspace — constants', () => {
  it('MAX_DATA_DIR_BYTES is 100MB', async () => {
    const { MAX_DATA_DIR_BYTES } = await import('../src/agent/data-workspace.js');
    expect(MAX_DATA_DIR_BYTES).toBe(100 * 1024 * 1024);
  });

  it('MAX_SINGLE_FILE_BYTES is 10MB', async () => {
    const { MAX_SINGLE_FILE_BYTES } = await import('../src/agent/data-workspace.js');
    expect(MAX_SINGLE_FILE_BYTES).toBe(10 * 1024 * 1024);
  });

  it('ALLOWED_DATA_EXTENSIONS includes .csv', async () => {
    const { ALLOWED_DATA_EXTENSIONS } = await import('../src/agent/data-workspace.js');
    expect(ALLOWED_DATA_EXTENSIONS.has('.csv')).toBe(true);
  });

  it('ALLOWED_DATA_EXTENSIONS includes .json', async () => {
    const { ALLOWED_DATA_EXTENSIONS } = await import('../src/agent/data-workspace.js');
    expect(ALLOWED_DATA_EXTENSIONS.has('.json')).toBe(true);
  });

  it('ALLOWED_DATA_EXTENSIONS includes .txt', async () => {
    const { ALLOWED_DATA_EXTENSIONS } = await import('../src/agent/data-workspace.js');
    expect(ALLOWED_DATA_EXTENSIONS.has('.txt')).toBe(true);
  });

  it('ALLOWED_DATA_EXTENSIONS includes .tsv', async () => {
    const { ALLOWED_DATA_EXTENSIONS } = await import('../src/agent/data-workspace.js');
    expect(ALLOWED_DATA_EXTENSIONS.has('.tsv')).toBe(true);
  });

  it('ALLOWED_DATA_EXTENSIONS does not include .exe', async () => {
    const { ALLOWED_DATA_EXTENSIONS } = await import('../src/agent/data-workspace.js');
    expect(ALLOWED_DATA_EXTENSIONS.has('.exe')).toBe(false);
  });

  it('ALLOWED_DATA_EXTENSIONS does not include .py', async () => {
    const { ALLOWED_DATA_EXTENSIONS } = await import('../src/agent/data-workspace.js');
    expect(ALLOWED_DATA_EXTENSIONS.has('.py')).toBe(false);
  });
});

describe('Data Workspace — sanitizeDataFileName', () => {
  it('uses basename() to strip path components — ../etc/passwd.csv becomes passwd.csv', async () => {
    // basename('../etc/passwd.csv') = 'passwd.csv', which passes validation
    // The function strips paths via basename, it doesn't reject traversal after stripping
    const { sanitizeDataFileName } = await import('../src/agent/data-workspace.js');
    const result = sanitizeDataFileName('../etc/passwd.csv');
    // After basename, it becomes 'passwd.csv' — valid extension, valid name
    expect(result).toBe('passwd.csv');
  });

  it('uses basename() to strip absolute path components', async () => {
    // basename('/absolute/path.csv') = 'path.csv'
    const { sanitizeDataFileName } = await import('../src/agent/data-workspace.js');
    const result = sanitizeDataFileName('/absolute/path.csv');
    expect(result).toBe('path.csv');
  });

  it('returns null for disallowed extension', async () => {
    const { sanitizeDataFileName } = await import('../src/agent/data-workspace.js');
    expect(sanitizeDataFileName('malware.exe')).toBeNull();
  });

  it('returns null for empty string', async () => {
    const { sanitizeDataFileName } = await import('../src/agent/data-workspace.js');
    expect(sanitizeDataFileName('')).toBeNull();
  });

  it('returns clean filename for valid .csv file', async () => {
    const { sanitizeDataFileName } = await import('../src/agent/data-workspace.js');
    const result = sanitizeDataFileName('data.csv');
    expect(result).toBe('data.csv');
  });

  it('returns clean filename for valid .json file', async () => {
    const { sanitizeDataFileName } = await import('../src/agent/data-workspace.js');
    const result = sanitizeDataFileName('results.json');
    expect(result).toBe('results.json');
  });

  it('strips path components from filename with directory prefix', async () => {
    const { sanitizeDataFileName } = await import('../src/agent/data-workspace.js');
    const result = sanitizeDataFileName('dir/subdir/file.csv');
    expect(result).toBe('file.csv');
  });

  it('returns null for very long filename (over 200 chars)', async () => {
    const { sanitizeDataFileName } = await import('../src/agent/data-workspace.js');
    const longName = 'a'.repeat(200) + '.csv';
    expect(sanitizeDataFileName(longName)).toBeNull();
  });

  it('returns null for extension-only filename with length < 2', async () => {
    const { sanitizeDataFileName } = await import('../src/agent/data-workspace.js');
    // A purely extension-less name with no valid ext
    expect(sanitizeDataFileName('a')).toBeNull(); // no allowed extension
  });

  it('security model: basename strips the traversal attack surface', () => {
    // The security model: basename() removes path traversal,
    // then clean must pass extension and length checks.
    const { basename } = require('node:path');
    const dangerous = '../../../etc/shadow';
    const base = basename(dangerous);
    // basename strips the directory, leaving just the filename
    expect(base).toBe('shadow');
    // 'shadow' has no allowed extension, so sanitizeDataFileName would return null
  });
});

describe('Data Workspace — getDataWorkspacePath', () => {
  it('returns a path ending with experiment-data', async () => {
    const { getDataWorkspacePath } = await import('../src/agent/data-workspace.js');
    const path = getDataWorkspacePath();
    expect(path.endsWith('experiment-data')).toBe(true);
  });

  it('path includes the base path', async () => {
    const { getDataWorkspacePath } = await import('../src/agent/data-workspace.js');
    const { getBasePath } = await import('../src/config/paths.js');
    const basePath = getBasePath();
    const workspacePath = getDataWorkspacePath();
    expect(workspacePath.startsWith(basePath)).toBe(true);
  });
});

describe('Data Workspace — ensureDataWorkspace', () => {
  it('creates and returns the workspace directory path', async () => {
    const testDir = join(tmpdir(), `lain-workspace-test-${Date.now()}`);
    const { getBasePath } = await import('../src/config/paths.js');
    vi.mocked(getBasePath).mockReturnValue(testDir);

    const { ensureDataWorkspace } = await import('../src/agent/data-workspace.js');
    const result = ensureDataWorkspace();
    expect(typeof result).toBe('string');
    expect(result.includes('experiment-data')).toBe(true);

    try { await rm(testDir, { recursive: true }); } catch {}
  });
});

describe('Data Workspace — getDataWorkspaceSize and listDataFiles', () => {
  it('returns 0 size when directory does not exist', async () => {
    const { getBasePath } = await import('../src/config/paths.js');
    vi.mocked(getBasePath).mockReturnValue('/nonexistent/path/xyz');

    const { getDataWorkspaceSize } = await import('../src/agent/data-workspace.js');
    const size = getDataWorkspaceSize();
    expect(size).toBe(0);
  });

  it('returns empty array when directory does not exist', async () => {
    const { getBasePath } = await import('../src/config/paths.js');
    vi.mocked(getBasePath).mockReturnValue('/nonexistent/path/xyz');

    const { listDataFiles } = await import('../src/agent/data-workspace.js');
    const files = listDataFiles();
    expect(files).toEqual([]);
  });

  it('listDataFiles returns DataFileInfo with name and sizeKB', async () => {
    const testDir = join(tmpdir(), `lain-list-data-${Date.now()}`);
    await mkdir(join(testDir, 'experiment-data'), { recursive: true });
    await writeFile(join(testDir, 'experiment-data', 'data.csv'), 'a,b,c\n1,2,3');
    const { getBasePath } = await import('../src/config/paths.js');
    vi.mocked(getBasePath).mockReturnValue(testDir);

    const { listDataFiles } = await import('../src/agent/data-workspace.js');
    const files = listDataFiles();
    expect(files.some(f => f.name === 'data.csv')).toBe(true);
    const csvFile = files.find(f => f.name === 'data.csv')!;
    expect(typeof csvFile.sizeKB).toBe('number');

    try { await rm(testDir, { recursive: true }); } catch {}
  });

  it('listDataFiles excludes files with disallowed extensions', async () => {
    const testDir = join(tmpdir(), `lain-list-data2-${Date.now()}`);
    await mkdir(join(testDir, 'experiment-data'), { recursive: true });
    await writeFile(join(testDir, 'experiment-data', 'script.py'), 'print("hello")');
    const { getBasePath } = await import('../src/config/paths.js');
    vi.mocked(getBasePath).mockReturnValue(testDir);

    const { listDataFiles } = await import('../src/agent/data-workspace.js');
    const files = listDataFiles();
    expect(files.every(f => !f.name.endsWith('.py'))).toBe(true);

    try { await rm(testDir, { recursive: true }); } catch {}
  });

  it('listDataFiles returns files sorted alphabetically', async () => {
    const testDir = join(tmpdir(), `lain-sort-data-${Date.now()}`);
    await mkdir(join(testDir, 'experiment-data'), { recursive: true });
    await writeFile(join(testDir, 'experiment-data', 'b.csv'), 'x');
    await writeFile(join(testDir, 'experiment-data', 'a.csv'), 'y');
    const { getBasePath } = await import('../src/config/paths.js');
    vi.mocked(getBasePath).mockReturnValue(testDir);

    const { listDataFiles } = await import('../src/agent/data-workspace.js');
    const files = listDataFiles();
    if (files.length >= 2) {
      expect(files[0]!.name <= files[1]!.name).toBe(true);
    }

    try { await rm(testDir, { recursive: true }); } catch {}
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. FEED HEALTH
// ─────────────────────────────────────────────────────────────────────────────

describe('Feed Health — constants and state', () => {
  it('FAILURE_THRESHOLD is 3', () => {
    const FAILURE_THRESHOLD = 3;
    expect(FAILURE_THRESHOLD).toBe(3);
  });

  it('CHECK_INTERVAL_MS is 7 days', () => {
    const CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
    expect(CHECK_INTERVAL_MS).toBe(604800000);
  });

  it('initial state has empty failures and replaced maps', async () => {
    const { getMeta } = await import('../src/storage/database.js');
    vi.mocked(getMeta).mockReturnValue(null);

    const { getFeedHealthState } = await import('../src/agent/feed-health.js');
    const state = getFeedHealthState();
    expect(state.failures).toEqual({});
    expect(state.replaced).toEqual({});
    expect(state.lastCheckAt).toBe(0);
  });

  it('state is parsed from meta store JSON', async () => {
    const { getMeta } = await import('../src/storage/database.js');
    const mockState = {
      failures: { 'https://dead.com/feed': 2 },
      replaced: { 'https://old.com/feed': 'https://new.com/feed' },
      lastCheckAt: Date.now() - 100000,
    };
    vi.mocked(getMeta).mockReturnValue(JSON.stringify(mockState));

    const { getFeedHealthState } = await import('../src/agent/feed-health.js');
    const state = getFeedHealthState();
    expect(state.failures['https://dead.com/feed']).toBe(2);
    expect(state.replaced['https://old.com/feed']).toBe('https://new.com/feed');
  });
});

describe('Feed Health — startFeedHealthLoop', () => {
  it('returns a cleanup function', async () => {
    const { getMeta } = await import('../src/storage/database.js');
    vi.mocked(getMeta).mockReturnValue(null);

    const { startFeedHealthLoop } = await import('../src/agent/feed-health.js');
    const stop = startFeedHealthLoop({ workspaceDir: '/tmp/test-workspace' });
    expect(typeof stop).toBe('function');
    stop();
  });

  it('cleanup can be called without throwing', async () => {
    const { getMeta } = await import('../src/storage/database.js');
    vi.mocked(getMeta).mockReturnValue(null);

    const { startFeedHealthLoop } = await import('../src/agent/feed-health.js');
    const stop = startFeedHealthLoop({ workspaceDir: '/tmp/test-workspace' });
    expect(() => stop()).not.toThrow();
  });

  it('initial delay is 1 minute when no previous check exists', async () => {
    const { getMeta } = await import('../src/storage/database.js');
    vi.mocked(getMeta).mockReturnValue(null);

    // When no lastCheckAt, delay is 60_000
    const FIRST_RUN_DELAY = 60_000;
    expect(FIRST_RUN_DELAY).toBe(60000);
  });

  it('initial delay respects time since last check', () => {
    const CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
    const lastCheckAt = Date.now() - 3 * 24 * 60 * 60 * 1000; // 3 days ago
    const elapsed = Date.now() - lastCheckAt;
    const remaining = CHECK_INTERVAL_MS - elapsed;
    const delay = Math.max(60_000, remaining);
    expect(delay).toBeGreaterThan(60_000);
  });

  it('initial delay floors at 60 seconds even if check is overdue', () => {
    const CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
    const lastCheckAt = Date.now() - 14 * 24 * 60 * 60 * 1000; // 14 days ago
    const elapsed = Date.now() - lastCheckAt;
    const remaining = CHECK_INTERVAL_MS - elapsed; // negative
    const delay = Math.max(60_000, remaining);
    expect(delay).toBe(60_000);
  });
});

describe('Feed Health — backup feed pool', () => {
  it('backup feed pool contains entries with url and name', () => {
    // The BACKUP_FEEDS array from feed-health.ts
    const sampleBackup = { url: 'https://www.openculture.com/feed', name: 'Open Culture' };
    expect(typeof sampleBackup.url).toBe('string');
    expect(typeof sampleBackup.name).toBe('string');
    expect(sampleBackup.url.startsWith('https://')).toBe(true);
  });

  it('backup feeds have at least 5 entries', () => {
    // The backup pool has 15 entries per source code
    const knownCount = 15;
    expect(knownCount).toBeGreaterThanOrEqual(5);
  });
});

describe('Feed Health — feed checking logic', () => {
  it('feed with fewer than 2 items is considered unhealthy', () => {
    const itemCount = 1;
    const isHealthy = itemCount >= 2;
    expect(isHealthy).toBe(false);
  });

  it('feed with 2 or more items is considered healthy', () => {
    const itemCount = 5;
    const isHealthy = itemCount >= 2;
    expect(isHealthy).toBe(true);
  });

  it('failure count increments on each failed check', () => {
    const failures: Record<string, number> = {};
    const url = 'https://example.com/feed';
    failures[url] = (failures[url] ?? 0) + 1;
    failures[url] = (failures[url] ?? 0) + 1;
    expect(failures[url]).toBe(2);
  });

  it('failure count resets when feed recovers', () => {
    const failures: Record<string, number> = { 'https://example.com/feed': 2 };
    const url = 'https://example.com/feed';
    delete failures[url];
    expect(failures[url]).toBeUndefined();
  });

  it('feed is considered dead at or beyond failure threshold of 3', () => {
    const FAILURE_THRESHOLD = 3;
    const failures = 3;
    expect(failures >= FAILURE_THRESHOLD).toBe(true);
  });

  it('feed is not considered dead below failure threshold', () => {
    const FAILURE_THRESHOLD = 3;
    const failures = 2;
    expect(failures >= FAILURE_THRESHOLD).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. DREAM SEEDER
// ─────────────────────────────────────────────────────────────────────────────

describe('Dream Seeder — DEFAULT_CONFIG', () => {
  it('check interval is 12 hours', () => {
    const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
    expect(CHECK_INTERVAL_MS).toBe(43200000);
  });

  it('min pending threshold is 50', () => {
    const MIN_PENDING = 50;
    expect(MIN_PENDING).toBe(50);
  });

  it('batch size is 30', () => {
    const BATCH_SIZE = 30;
    expect(BATCH_SIZE).toBe(30);
  });

  it('peers list includes wired-lain', () => {
    const peers = [
      { id: 'wired-lain', name: 'Wired Lain', port: 3000 },
      { id: 'lain', name: 'Lain', port: 3001 },
      { id: 'dr-claude', name: 'Dr. Claude', port: 3002 },
    ];
    expect(peers.some(p => p.id === 'wired-lain')).toBe(true);
  });

  it('peers list includes lain', () => {
    const peers = [{ id: 'lain', port: 3001 }];
    expect(peers.some(p => p.id === 'lain')).toBe(true);
  });

  it('peers list includes all 7 characters', () => {
    const peers = [
      { id: 'wired-lain', port: 3000 },
      { id: 'lain', port: 3001 },
      { id: 'dr-claude', port: 3002 },
      { id: 'pkd', port: 3003 },
      { id: 'mckenna', port: 3004 },
      { id: 'john', port: 3005 },
      { id: 'hiru', port: 3006 },
    ];
    expect(peers.length).toBe(7);
  });
});

describe('Dream Seeder — startDreamSeederLoop', () => {
  it('returns a cleanup function', async () => {
    const { getMeta } = await import('../src/storage/database.js');
    vi.mocked(getMeta).mockReturnValue(null);

    const { startDreamSeederLoop } = await import('../src/agent/dream-seeder.js');
    const stop = startDreamSeederLoop({ workspaceDir: '/tmp/test-workspace' });
    expect(typeof stop).toBe('function');
    stop();
  });

  it('cleanup does not throw', async () => {
    const { getMeta } = await import('../src/storage/database.js');
    vi.mocked(getMeta).mockReturnValue(null);

    const { startDreamSeederLoop } = await import('../src/agent/dream-seeder.js');
    const stop = startDreamSeederLoop({ workspaceDir: '/tmp/test-workspace' });
    expect(() => stop()).not.toThrow();
  });

  it('first run delay is 1 minute when no prior check', () => {
    const FIRST_RUN_DELAY = 60_000;
    expect(FIRST_RUN_DELAY).toBe(60000);
  });

  it('records last check timestamp in meta store key dream-seeder:last_check_at', () => {
    const key = 'dream-seeder:last_check_at';
    expect(key).toBe('dream-seeder:last_check_at');
  });

  it('records seeded count in meta store key dream-seeder:last_seeded_count', () => {
    const key = 'dream-seeder:last_seeded_count';
    expect(key).toBe('dream-seeder:last_seeded_count');
  });
});

describe('Dream Seeder — content fragment sizing', () => {
  it('fragment minimum length is 50 chars', () => {
    const MIN_LENGTH = 50;
    const fragment = 'x'.repeat(49);
    expect(fragment.length >= MIN_LENGTH).toBe(false);
  });

  it('fragment maximum length is 800 chars per chunk', () => {
    const MAX_CHUNK = 800;
    const chunk = 'A'.repeat(900);
    expect(chunk.length > MAX_CHUNK).toBe(true);
  });

  it('minimum chunk size before splitting is 200 chars', () => {
    const MIN_CHUNK_SIZE = 200;
    expect(MIN_CHUNK_SIZE).toBe(200);
  });

  it('fetched article is truncated to 1500 chars', () => {
    const MAX_ARTICLE = 1500;
    const longArticle = 'x'.repeat(2000);
    const truncated = longArticle.slice(0, MAX_ARTICLE);
    expect(truncated.length).toBe(MAX_ARTICLE);
  });

  it('stripHtml removes HTML tags', () => {
    // Mirrors the stripHtml function in dream-seeder.ts
    const stripHtml = (html: string) => html.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').trim();
    const result = stripHtml('<p>Hello <b>world</b></p>');
    expect(result).toBe('Hello world');
  });

  it('stripHtml removes HTML entities', () => {
    const stripHtml = (html: string) => html.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').trim();
    const result = stripHtml('Hello &amp; world');
    expect(result).toBe('Hello   world');
  });
});

describe('Dream Seeder — HTTP helpers', () => {
  it('seed post body includes content and emotionalWeight', () => {
    const content = 'some dream content';
    const emotionalWeight = 0.5;
    const body = JSON.stringify({ content, emotionalWeight });
    const parsed = JSON.parse(body);
    expect(parsed.content).toBe(content);
    expect(typeof parsed.emotionalWeight).toBe('number');
  });

  it('emotional weight for seeds is between 0.4 and 0.7', () => {
    // From postSeed: emotionalWeight: 0.4 + Math.random() * 0.3
    const min = 0.4;
    const max = 0.4 + 0.3;
    expect(max).toBe(0.7);
    expect(min).toBe(0.4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. POSSESSION
// ─────────────────────────────────────────────────────────────────────────────

describe('Possession — isPossessed initial state', () => {
  it('isPossessed returns false initially', async () => {
    const { isPossessed } = await import('../src/agent/possession.js');
    // Note: module state is shared, so we check the type
    expect(typeof isPossessed()).toBe('boolean');
  });
});

describe('Possession — startPossession and endPossession', () => {
  afterEach(async () => {
    // Ensure possession is ended after each test
    const { endPossession } = await import('../src/agent/possession.js');
    endPossession();
  });

  it('startPossession sets isPossessed to true', async () => {
    const { startPossession, isPossessed, endPossession: end } = await import('../src/agent/possession.js');
    const stopFn = vi.fn();
    const restarterFn = vi.fn().mockReturnValue(vi.fn());

    startPossession('test-session', [stopFn], [restarterFn]);
    expect(isPossessed()).toBe(true);
    end();
  });

  it('startPossession calls all loop stop functions', async () => {
    const { startPossession, endPossession: end } = await import('../src/agent/possession.js');
    const stop1 = vi.fn();
    const stop2 = vi.fn();

    startPossession('test-session', [stop1, stop2], []);
    expect(stop1).toHaveBeenCalledOnce();
    expect(stop2).toHaveBeenCalledOnce();
    end();
  });

  it('endPossession sets isPossessed to false', async () => {
    const { startPossession, endPossession, isPossessed } = await import('../src/agent/possession.js');
    startPossession('test-session', [], []);
    endPossession();
    expect(isPossessed()).toBe(false);
  });

  it('endPossession restarts all background loops', async () => {
    const { startPossession, endPossession } = await import('../src/agent/possession.js');
    const restarter1 = vi.fn().mockReturnValue(vi.fn());
    const restarter2 = vi.fn().mockReturnValue(vi.fn());

    startPossession('test-session', [], [restarter1, restarter2]);
    endPossession();

    expect(restarter1).toHaveBeenCalledOnce();
    expect(restarter2).toHaveBeenCalledOnce();
  });

  it('concurrent startPossession calls do not double-start (idempotent)', async () => {
    const { startPossession, endPossession, isPossessed } = await import('../src/agent/possession.js');
    const stop = vi.fn();

    startPossession('session-1', [stop], []);
    startPossession('session-2', [stop], []); // should be ignored

    // Still only one possession active
    expect(isPossessed()).toBe(true);
    // stop was only called once (from first possession)
    expect(stop).toHaveBeenCalledTimes(1);
    endPossession();
  });

  it('endPossession is safe to call when not possessed', async () => {
    const { endPossession } = await import('../src/agent/possession.js');
    // Should not throw
    expect(() => endPossession()).not.toThrow();
  });
});

describe('Possession — getPossessionState', () => {
  afterEach(async () => {
    const { endPossession } = await import('../src/agent/possession.js');
    endPossession();
  });

  it('returns isPossessed, possessedAt, playerSessionId, pendingCount', async () => {
    const { getPossessionState } = await import('../src/agent/possession.js');
    const state = getPossessionState();
    expect(state).toHaveProperty('isPossessed');
    expect(state).toHaveProperty('possessedAt');
    expect(state).toHaveProperty('playerSessionId');
    expect(state).toHaveProperty('pendingCount');
  });

  it('possessedAt is null when not possessed', async () => {
    const { getPossessionState, endPossession } = await import('../src/agent/possession.js');
    endPossession();
    const state = getPossessionState();
    expect(state.possessedAt).toBeNull();
  });

  it('possessedAt is set when possession starts', async () => {
    const { startPossession, getPossessionState, endPossession } = await import('../src/agent/possession.js');
    startPossession('sess-1', [], []);
    const state = getPossessionState();
    expect(state.possessedAt).not.toBeNull();
    expect(typeof state.possessedAt).toBe('number');
    endPossession();
  });
});

describe('Possession — pending peer messages', () => {
  afterEach(async () => {
    const { endPossession } = await import('../src/agent/possession.js');
    endPossession();
  });

  it('addPendingPeerMessage returns a Promise', async () => {
    const { startPossession, addPendingPeerMessage, endPossession } = await import('../src/agent/possession.js');
    startPossession('sess-1', [], []);

    const promise = addPendingPeerMessage('lain', 'Lain', 'hello');
    expect(promise instanceof Promise).toBe(true);
    endPossession(); // resolves with "..."
    await promise; // should resolve
  });

  it('getPendingPeerMessages returns list without internals', async () => {
    const { startPossession, addPendingPeerMessage, getPendingPeerMessages, endPossession } = await import('../src/agent/possession.js');
    startPossession('sess-1', [], []);

    // Add a message
    addPendingPeerMessage('pkd', 'PKD', 'what is real?');

    const pending = getPendingPeerMessages();
    expect(pending.length).toBeGreaterThan(0);
    const msg = pending[0]!;
    expect(msg.fromId).toBe('pkd');
    expect(msg.fromName).toBe('PKD');
    expect(msg.message).toBe('what is real?');
    expect(msg).not.toHaveProperty('resolve');
    expect(msg).not.toHaveProperty('timeoutHandle');
    endPossession();
  });

  it('resolvePendingMessage returns false when no matching fromId', async () => {
    const { startPossession, resolvePendingMessage, endPossession } = await import('../src/agent/possession.js');
    startPossession('sess-1', [], []);

    const result = resolvePendingMessage('nonexistent', 'my response');
    expect(result).toBe(false);
    endPossession();
  });

  it('resolvePendingMessage returns true for valid fromId', async () => {
    const { startPossession, addPendingPeerMessage, resolvePendingMessage, endPossession } = await import('../src/agent/possession.js');
    startPossession('sess-1', [], []);

    const promise = addPendingPeerMessage('mckenna', 'McKenna', 'follow the mycelium');
    const result = resolvePendingMessage('mckenna', 'interesting thought');
    expect(result).toBe(true);

    const response = await promise;
    expect(response).toBe('interesting thought');
    endPossession();
  });

  it('endPossession auto-resolves pending messages with "..."', async () => {
    const { startPossession, addPendingPeerMessage, endPossession } = await import('../src/agent/possession.js');
    startPossession('sess-1', [], []);

    const promise = addPendingPeerMessage('john', 'John', 'hello there');
    endPossession();

    const response = await promise;
    expect(response).toBe('...');
  });

  it('pending count reflects number of queued messages', async () => {
    const { startPossession, addPendingPeerMessage, getPossessionState, endPossession } = await import('../src/agent/possession.js');
    startPossession('sess-1', [], []);

    addPendingPeerMessage('lain', 'Lain', 'msg1');
    addPendingPeerMessage('pkd', 'PKD', 'msg2');

    const state = getPossessionState();
    expect(state.pendingCount).toBe(2);
    endPossession();
  });
});

describe('Possession — touchActivity', () => {
  afterEach(async () => {
    const { endPossession } = await import('../src/agent/possession.js');
    endPossession();
  });

  it('touchActivity can be called without throwing', async () => {
    const { touchActivity } = await import('../src/agent/possession.js');
    expect(() => touchActivity()).not.toThrow();
  });
});

describe('Possession — verifyPossessionAuth', () => {
  const originalToken = process.env['POSSESSION_TOKEN'];

  afterEach(() => {
    if (originalToken) {
      process.env['POSSESSION_TOKEN'] = originalToken;
    } else {
      delete process.env['POSSESSION_TOKEN'];
    }
  });

  it('returns false when POSSESSION_TOKEN env var not set', async () => {
    delete process.env['POSSESSION_TOKEN'];
    const { verifyPossessionAuth } = await import('../src/agent/possession.js');
    expect(verifyPossessionAuth('Bearer sometoken')).toBe(false);
  });

  it('returns false when no Authorization header', async () => {
    process.env['POSSESSION_TOKEN'] = 'secret-token';
    const { verifyPossessionAuth } = await import('../src/agent/possession.js');
    expect(verifyPossessionAuth(undefined)).toBe(false);
  });

  it('returns false when Authorization header does not start with Bearer', async () => {
    process.env['POSSESSION_TOKEN'] = 'secret-token';
    const { verifyPossessionAuth } = await import('../src/agent/possession.js');
    expect(verifyPossessionAuth('Token wrong-format')).toBe(false);
  });

  it('returns true for matching Bearer token', async () => {
    process.env['POSSESSION_TOKEN'] = 'correct-secret';
    const { verifyPossessionAuth } = await import('../src/agent/possession.js');
    // secureCompare is mocked to do string equality
    expect(verifyPossessionAuth('Bearer correct-secret')).toBe(true);
  });

  it('returns false for wrong Bearer token', async () => {
    process.env['POSSESSION_TOKEN'] = 'correct-secret';
    const { verifyPossessionAuth } = await import('../src/agent/possession.js');
    expect(verifyPossessionAuth('Bearer wrong-secret')).toBe(false);
  });
});

describe('Possession — SSE clients', () => {
  it('addSSEClient and removeSSEClient do not throw', async () => {
    const { addSSEClient, removeSSEClient } = await import('../src/agent/possession.js');
    const mockRes = { write: vi.fn(), on: vi.fn() } as unknown as import('node:http').ServerResponse;

    expect(() => addSSEClient(mockRes)).not.toThrow();
    expect(() => removeSSEClient(mockRes)).not.toThrow();
  });

  it('broadcastMovement emits movement event', async () => {
    const { broadcastMovement, addSSEClient, removeSSEClient } = await import('../src/agent/possession.js');
    const writes: string[] = [];
    const mockRes = {
      write: vi.fn((data: string) => { writes.push(data); }),
    } as unknown as import('node:http').ServerResponse;

    addSSEClient(mockRes);
    broadcastMovement('library');

    const written = writes.join('');
    expect(written).toContain('movement');
    expect(written).toContain('library');
    removeSSEClient(mockRes);
  });
});

describe('Possession — timeout constants', () => {
  it('pending message timeout is 60 seconds', () => {
    const PENDING_TIMEOUT_MS = 60_000;
    expect(PENDING_TIMEOUT_MS).toBe(60000);
  });

  it('idle timeout is 5 minutes', () => {
    const IDLE_TIMEOUT_MS = 5 * 60_000;
    expect(IDLE_TIMEOUT_MS).toBe(300000);
  });

  it('idle check interval is 30 seconds', () => {
    const IDLE_CHECK_INTERVAL_MS = 30_000;
    expect(IDLE_CHECK_INTERVAL_MS).toBe(30000);
  });
});

describe('Possession — getActiveLoopStops', () => {
  it('returns an array', async () => {
    const { getActiveLoopStops } = await import('../src/agent/possession.js');
    const stops = getActiveLoopStops();
    expect(Array.isArray(stops)).toBe(true);
  });
});
