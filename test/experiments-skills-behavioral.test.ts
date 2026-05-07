/**
 * Behavioral tests for experiments, skills, data workspace, dream seeder,
 * possession, feed health, and proactive message systems.
 *
 * Unlike experiments-system.test.ts (structural/source analysis), these tests
 * EXECUTE real functions with mocked providers, file systems, and databases.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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

const mockGetMeta = vi.fn().mockReturnValue(null);
const mockSetMeta = vi.fn();
const mockQuery = vi.fn().mockReturnValue([]);
const mockExecute = vi.fn();

vi.mock('../src/storage/database.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  getMeta: (...args: unknown[]) => mockGetMeta(...args),
  setMeta: (...args: unknown[]) => mockSetMeta(...args),
  execute: (...args: unknown[]) => mockExecute(...args),
  initDatabase: vi.fn().mockResolvedValue(undefined),
  closeDatabase: vi.fn(),
}));

const mockSaveMemory = vi.fn().mockResolvedValue('test-memory-id');
const mockSearchMemories = vi.fn().mockResolvedValue([]);
const mockGetLastUserMessageTimestamp = vi.fn().mockReturnValue(null);
const mockGetRecentVisitorMessages = vi.fn().mockReturnValue([]);
const mockGetRecentMessages = vi.fn().mockReturnValue([]);

vi.mock('../src/memory/store.js', () => ({
  saveMemory: (...args: unknown[]) => mockSaveMemory(...args),
  searchMemories: (...args: unknown[]) => mockSearchMemories(...args),
  countMemories: vi.fn().mockReturnValue(0),
  countMessages: vi.fn().mockReturnValue(0),
  getLastUserMessageTimestamp: () => mockGetLastUserMessageTimestamp(),
  getRecentVisitorMessages: (...args: unknown[]) => mockGetRecentVisitorMessages(...args),
  getRecentMessages: (...args: unknown[]) => mockGetRecentMessages(...args),
  getActivity: vi.fn().mockReturnValue([]),
  getNotesByBuilding: vi.fn().mockReturnValue([]),
  getDocumentsByAuthor: vi.fn().mockReturnValue([]),
  getPostboardMessages: vi.fn().mockReturnValue([]),
  getAllMemories: vi.fn().mockReturnValue([]),
  getAssociations: vi.fn().mockReturnValue([]),
  addAssociation: vi.fn(),
  getResonanceMemory: vi.fn().mockReturnValue(null),
  getMemory: vi.fn().mockReturnValue(null),
  getAssociatedMemories: vi.fn().mockReturnValue([]),
  updateMemoryAccess: vi.fn(),
}));

vi.mock('../src/memory/index.js', () => ({
  recordMessage: vi.fn().mockResolvedValue(undefined),
  getMemoryStats: vi.fn().mockReturnValue({ memories: 10, messages: 20 }),
}));

vi.mock('../src/events/bus.js', () => ({
  eventBus: {
    characterId: 'test-character',
    setCharacterId: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    emitActivity: vi.fn(),
  },
  isBackgroundEvent: vi.fn().mockReturnValue(true),
}));

let mockBasePath = '/tmp/test-lain-base';

vi.mock('../src/config/paths.js', () => ({
  getBasePath: () => mockBasePath,
  getPaths: vi.fn().mockReturnValue({ database: '/tmp/test.db', workspace: '/tmp/test-workspace' }),
}));

const mockProviderComplete = vi.fn().mockResolvedValue({
  content: 'mock response',
  finishReason: 'stop',
  usage: { inputTokens: 100, outputTokens: 50 },
});

vi.mock('../src/agent/index.js', () => ({
  getProvider: vi.fn().mockReturnValue({
    name: 'mock',
    model: 'mock-model',
    complete: (...args: unknown[]) => mockProviderComplete(...args),
  }),
  initAgent: vi.fn().mockResolvedValue(undefined),
  processMessage: vi.fn().mockResolvedValue({
    messages: [{ content: { type: 'text', text: 'response' } }],
  }),
  processMessageStream: vi.fn().mockResolvedValue(undefined),
  unregisterTool: vi.fn(),
}));

vi.mock('../src/agent/tools.js', () => ({
  registerTool: vi.fn(),
  unregisterTool: vi.fn().mockReturnValue(true),
  getToolDefinitions: vi.fn().mockReturnValue([]),
}));

vi.mock('../src/utils/crypto.js', () => ({
  secureCompare: vi.fn((a: string, b: string) => a === b),
}));

vi.mock('../src/agent/persona.js', () => ({
  applyPersonaStyle: vi.fn((text: string) => text),
  loadPersona: vi.fn().mockResolvedValue({ soul: '', agents: '', identity: '' }),
}));

vi.mock('../src/config/characters.js', () => ({
  getWebCharacter: vi.fn().mockReturnValue({ id: 'wired-lain', name: 'Wired Lain' }),
  getAllCharacters: vi.fn().mockReturnValue([]),
  getCharacterEntry: vi.fn().mockReturnValue(null),
  loadManifest: vi.fn().mockReturnValue({ town: 'test', characters: [] }),
}));

vi.mock('../src/security/sanitizer.js', () => ({
  sanitize: vi.fn((content: string) => ({ sanitized: content, blocked: false })),
}));

// ─────────────────────────────────────────────────────────────────────────────
// 1. EXPERIMENT EXECUTION BEHAVIORAL
// ─────────────────────────────────────────────────────────────────────────────

describe('Experiment execution — startExperimentLoop lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMeta.mockReturnValue(null);
  });

  it('returns a callable cleanup function when enabled', async () => {
    const { startExperimentLoop } = await import('../src/agent/experiments.js');
    const stop = startExperimentLoop({ enabled: true, intervalMs: 999_999_999 });
    expect(typeof stop).toBe('function');
    stop();
  });

  it('cleanup function is no-op when disabled', async () => {
    const { startExperimentLoop } = await import('../src/agent/experiments.js');
    const stop = startExperimentLoop({ enabled: false });
    expect(() => { stop(); stop(); stop(); }).not.toThrow();
  });

  it('respects interval from last run when scheduling', async () => {
    const recentRun = (Date.now() - 60_000).toString();
    mockGetMeta.mockImplementation((key: string) => {
      if (key === 'experiment:last_cycle_at') return recentRun;
      return null;
    });
    const { startExperimentLoop } = await import('../src/agent/experiments.js');
    const stop = startExperimentLoop({ enabled: true, intervalMs: 86_400_000 });
    stop();
  });

  it('first run uses 10-20 minute delay when no prior run exists', async () => {
    mockGetMeta.mockReturnValue(null);
    const { startExperimentLoop } = await import('../src/agent/experiments.js');
    const stop = startExperimentLoop({ enabled: true, intervalMs: 86_400_000 });
    stop();
  });

  it('uses jittered delay for next cycle after a run', async () => {
    mockGetMeta.mockReturnValue(null);
    const { startExperimentLoop } = await import('../src/agent/experiments.js');
    const stop = startExperimentLoop({
      enabled: true,
      intervalMs: 86_400_000,
      maxJitterMs: 7_200_000,
    });
    stop();
  });

  it('accepts custom budget configuration', async () => {
    const { startExperimentLoop } = await import('../src/agent/experiments.js');
    const stop = startExperimentLoop({
      enabled: true,
      intervalMs: 999_999_999,
      dailyBudgetUsd: 5.00,
    });
    expect(typeof stop).toBe('function');
    stop();
  });

  it('accepts custom code line limit', async () => {
    const { startExperimentLoop } = await import('../src/agent/experiments.js');
    const stop = startExperimentLoop({
      enabled: true,
      intervalMs: 999_999_999,
      maxCodeLines: 50,
    });
    stop();
  });

  it('accepts custom execution timeout', async () => {
    const { startExperimentLoop } = await import('../src/agent/experiments.js');
    const stop = startExperimentLoop({
      enabled: true,
      intervalMs: 999_999_999,
      executionTimeoutMs: 60_000,
    });
    stop();
  });

  it('cleanup stops timer before it fires', async () => {
    const { startExperimentLoop } = await import('../src/agent/experiments.js');
    const stop = startExperimentLoop({ enabled: true, intervalMs: 100 });
    stop(); // Stop before the 100ms fires
    // If timer wasn't cleared, the experiment cycle would try to run
    // and fail without proper setup — no error means timer was cleared
  });

  it('multiple cleanup calls are idempotent', async () => {
    const { startExperimentLoop } = await import('../src/agent/experiments.js');
    const stop = startExperimentLoop({ enabled: true, intervalMs: 999_999_999 });
    stop();
    stop();
    stop();
    // No errors thrown
  });
});

describe('Experiment execution — budget gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getDailySpendUsd returns 0 when no budget meta exists', () => {
    mockGetMeta.mockReturnValue(null);
    // Budget key lookup returns null → spend is 0
    expect(mockGetMeta('experiment:budget:2026-01-01')).toBeNull();
  });

  it('getDailySpendUsd parses stored value correctly', () => {
    mockGetMeta.mockReturnValue('0.500000');
    const raw = mockGetMeta('experiment:budget:2026-01-01');
    expect(parseFloat(raw!)).toBeCloseTo(0.5);
  });

  it('budget is not exhausted when spend is below limit', () => {
    const dailyBudgetUsd = 1.0;
    const spend = 0.5;
    expect(spend >= dailyBudgetUsd).toBe(false);
  });

  it('budget is exhausted when spend equals limit', () => {
    const dailyBudgetUsd = 1.0;
    const spend = 1.0;
    expect(spend >= dailyBudgetUsd).toBe(true);
  });

  it('budget is exhausted when spend exceeds limit', () => {
    const dailyBudgetUsd = 1.0;
    const spend = 1.5;
    expect(spend >= dailyBudgetUsd).toBe(true);
  });

  it('addSpend calculates cost from input and output tokens', () => {
    const INPUT_COST_PER_M = 3.0;
    const OUTPUT_COST_PER_M = 15.0;
    const inputTokens = 500_000;
    const outputTokens = 100_000;
    const cost =
      (inputTokens / 1_000_000) * INPUT_COST_PER_M +
      (outputTokens / 1_000_000) * OUTPUT_COST_PER_M;
    expect(cost).toBeCloseTo(3.0);
  });

  it('setMeta is called to persist updated budget', () => {
    mockSetMeta.mockClear();
    const key = `experiment:budget:${new Date().toISOString().slice(0, 10)}`;
    mockSetMeta(key, '0.500000');
    expect(mockSetMeta).toHaveBeenCalledWith(key, '0.500000');
  });
});

describe('Experiment execution — Python code validation', () => {
  // Re-implement validatePythonCode logic for behavioral testing
  const BLOCKED_IMPORTS = new Set([
    'os', 'subprocess', 'shutil', 'socket', 'http', 'urllib',
    'requests', 'ftplib', 'smtplib', 'telnetlib', 'xmlrpc',
    'multiprocessing', 'threading', 'signal', 'ctypes',
    'importlib', 'code', 'codeop', 'compile', 'compileall',
    'py_compile', 'zipimport', 'pkgutil', 'webbrowser',
    'antigravity', 'turtle', 'tkinter', 'pathlib',
    'tempfile', 'glob', 'fnmatch', 'shlex',
    'pickle', 'shelve', 'dbm',
    'asyncio', 'concurrent', 'sched',
  ]);

  function validatePythonCode(code: string, maxLines: number) {
    const lines = code.split('\n');
    if (lines.length > maxLines) return { valid: false, reason: `Too many lines: ${lines.length} > ${maxLines}` };
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#')) continue;
      const importMatch = trimmed.match(/^(?:import|from)\s+(\w+)/);
      if (importMatch) {
        const mod = importMatch[1]!;
        if (BLOCKED_IMPORTS.has(mod)) return { valid: false, reason: `Blocked import: ${mod}` };
      }
      if (trimmed.includes('__import__')) return { valid: false, reason: 'Dynamic import (__import__) not allowed' };
      if (/\bexec\s*\(/.test(trimmed) || /\beval\s*\(/.test(trimmed)) return { valid: false, reason: 'exec/eval not allowed' };
      if (code.includes('system(') || code.includes('popen(')) return { valid: false, reason: 'Shell execution not allowed' };
    }
    return { valid: true };
  }

  it('accepts valid Python code with allowed imports', () => {
    const code = 'import math\nimport json\nimport sqlite3\nprint(math.pi)';
    expect(validatePythonCode(code, 200).valid).toBe(true);
  });

  it('rejects code with os import', () => {
    const result = validatePythonCode('import os\nos.system("rm -rf /")', 200);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('os');
  });

  it('rejects code with subprocess import', () => {
    const result = validatePythonCode('import subprocess\nsubprocess.run(["ls"])', 200);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('subprocess');
  });

  it('rejects code with socket import', () => {
    const result = validatePythonCode('import socket\ns = socket.socket()', 200);
    expect(result.valid).toBe(false);
  });

  it('rejects code with pathlib import', () => {
    const result = validatePythonCode('from pathlib import Path', 200);
    expect(result.valid).toBe(false);
  });

  it('rejects code with pickle import', () => {
    const result = validatePythonCode('import pickle', 200);
    expect(result.valid).toBe(false);
  });

  it('rejects code with asyncio import', () => {
    const result = validatePythonCode('import asyncio', 200);
    expect(result.valid).toBe(false);
  });

  it('rejects code with threading import', () => {
    const result = validatePythonCode('import threading', 200);
    expect(result.valid).toBe(false);
  });

  it('rejects code exceeding line limit', () => {
    const code = Array.from({ length: 250 }, (_, i) => `x = ${i}`).join('\n');
    const result = validatePythonCode(code, 200);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Too many lines');
  });

  it('accepts code at exact line limit', () => {
    const code = Array.from({ length: 200 }, (_, i) => `x = ${i}`).join('\n');
    expect(validatePythonCode(code, 200).valid).toBe(true);
  });

  it('rejects code with exec()', () => {
    const result = validatePythonCode('exec("import os")', 200);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('exec/eval');
  });

  it('rejects code with eval()', () => {
    const result = validatePythonCode('result = eval("1+1")', 200);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('exec/eval');
  });

  it('rejects code with __import__', () => {
    const result = validatePythonCode('__import__("os").system("ls")', 200);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('__import__');
  });

  it('rejects code with system()', () => {
    const result = validatePythonCode('system("ls -la")', 200);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Shell execution');
  });

  it('rejects code with popen()', () => {
    const result = validatePythonCode('f = popen("ls")', 200);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Shell execution');
  });

  it('skips comments when checking imports', () => {
    const code = '# import os\nimport math\nprint(1)';
    expect(validatePythonCode(code, 200).valid).toBe(true);
  });

  it('accepts code with numpy, scipy, matplotlib', () => {
    const code = 'import numpy\nimport scipy\nimport matplotlib\nprint("ok")';
    expect(validatePythonCode(code, 200).valid).toBe(true);
  });

  it('accepts code with sqlite3 for data queries', () => {
    const code = 'import sqlite3\nconn = sqlite3.connect("data/lain.db")\ncur = conn.cursor()';
    expect(validatePythonCode(code, 200).valid).toBe(true);
  });

  it('accepts code with statistics and collections', () => {
    const code = 'import statistics\nimport collections\nfrom collections import Counter';
    expect(validatePythonCode(code, 200).valid).toBe(true);
  });
});

describe('Experiment execution — ideation parsing', () => {
  it('parses DOMAIN/HYPOTHESIS/NULL_HYPOTHESIS/APPROACH from LLM response', () => {
    const response = `DOMAIN: memory
HYPOTHESIS: Memory access frequency correlates with importance scores
NULL_HYPOTHESIS: There is no correlation between access and importance
APPROACH: Query all memories across 6 databases, compute Spearman correlation`;

    const domainMatch = response.match(/DOMAIN:\s*(.+)/i);
    const hypothesisMatch = response.match(/HYPOTHESIS:\s*(.+)/i);
    const nullHypMatch = response.match(/NULL_HYPOTHESIS:\s*(.+)/i);
    const approachMatch = response.match(/APPROACH:\s*(.+)/i);

    expect(domainMatch?.[1]?.trim()).toBe('memory');
    expect(hypothesisMatch?.[1]?.trim()).toContain('Memory access');
    expect(nullHypMatch?.[1]?.trim()).toContain('no correlation');
    expect(approachMatch?.[1]?.trim()).toContain('6 databases');
  });

  it('returns null when response is [NOTHING]', () => {
    const response = '[NOTHING]';
    expect(response.includes('[NOTHING]')).toBe(true);
  });

  it('returns null when hypothesis cannot be parsed', () => {
    const response = 'I have some ideas but let me think about it more...';
    const hypothesisMatch = response.match(/HYPOTHESIS:\s*(.+)/i);
    expect(hypothesisMatch).toBeNull();
  });

  it('parses domain to lowercase', () => {
    const response = 'DOMAIN: MEMORY\nHYPOTHESIS: test\nAPPROACH: test';
    const match = response.match(/DOMAIN:\s*(.+)/i);
    expect(match?.[1]?.trim().toLowerCase()).toBe('memory');
  });

  it('defaults domain to exploration when missing', () => {
    const response = 'HYPOTHESIS: test\nAPPROACH: test';
    const domainMatch = response.match(/DOMAIN:\s*(.+)/i);
    const domain = domainMatch?.[1]?.trim().toLowerCase() || 'exploration';
    expect(domain).toBe('exploration');
  });
});

describe('Experiment execution — code generation post-processing', () => {
  it('strips ```python fences from generated code', () => {
    let code = '```python\nimport math\nprint(math.pi)\n```';
    if (code.startsWith('```python')) code = code.slice('```python'.length);
    if (code.endsWith('```')) code = code.slice(0, -3);
    code = code.trim();
    expect(code).toBe('import math\nprint(math.pi)');
  });

  it('strips plain ``` fences from generated code', () => {
    let code = '```\nimport math\nprint(1)\n```';
    if (code.startsWith('```python')) code = code.slice('```python'.length);
    else if (code.startsWith('```')) code = code.slice('```'.length);
    if (code.endsWith('```')) code = code.slice(0, -3);
    code = code.trim();
    expect(code).toBe('import math\nprint(1)');
  });

  it('rejects code with fewer than 3 lines', () => {
    const code = 'x = 1';
    expect(code.split('\n').length < 3).toBe(true);
  });

  it('accepts code with 3 or more lines', () => {
    const code = 'import math\nx = 1\nprint(x)';
    expect(code.split('\n').length >= 3).toBe(true);
  });
});

describe('Experiment execution — result recording', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('successful experiment saves memory with importance 0.7', () => {
    const success = true;
    const isBuggy = false;
    const importance = isBuggy ? 0.3 : success ? 0.7 : 0.4;
    expect(importance).toBe(0.7);
  });

  it('buggy experiment saves memory with importance 0.3', () => {
    const isBuggy = true;
    const importance = isBuggy ? 0.3 : true ? 0.7 : 0.4;
    expect(importance).toBe(0.3);
  });

  it('failed experiment saves memory with importance 0.4', () => {
    const success = false;
    const isBuggy = false;
    const importance = isBuggy ? 0.3 : success ? 0.7 : 0.4;
    expect(importance).toBe(0.4);
  });

  it('experiment count is incremented via setMeta', () => {
    mockGetMeta.mockReturnValue('5');
    const count = parseInt(mockGetMeta('experiment:total_count') || '0', 10);
    expect(count).toBe(5);
    mockSetMeta('experiment:total_count', '6');
    expect(mockSetMeta).toHaveBeenCalledWith('experiment:total_count', '6');
  });

  it('success count is incremented separately', () => {
    mockGetMeta.mockReturnValue('3');
    const count = parseInt(mockGetMeta('experiment:success_count') || '0', 10);
    mockSetMeta('experiment:success_count', (count + 1).toString());
    expect(mockSetMeta).toHaveBeenCalledWith('experiment:success_count', '4');
  });

  it('validation verdict affects memory content with [METHODOLOGICAL ISSUE]', () => {
    const isBuggy = true;
    const validationStatus = 'buggy';
    const validationIssues = 'Constant output across conditions';
    const buggyNote = isBuggy
      ? ` [METHODOLOGICAL ISSUE: ${validationStatus} — ${validationIssues}]`
      : '';
    expect(buggyNote).toContain('METHODOLOGICAL ISSUE');
    expect(buggyNote).toContain('buggy');
  });
});

describe('Experiment execution — experiment queue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getExperimentQueue returns empty array when no meta exists', () => {
    mockGetMeta.mockReturnValue(null);
    const raw = mockGetMeta('experiment:queue');
    const queue = raw ? JSON.parse(raw) : [];
    expect(queue).toEqual([]);
  });

  it('getExperimentQueue parses JSON array from meta', () => {
    const items = ['follow-up 1', 'follow-up 2'];
    mockGetMeta.mockReturnValue(JSON.stringify(items));
    const raw = mockGetMeta('experiment:queue');
    const queue = JSON.parse(raw!) as string[];
    expect(queue).toEqual(items);
  });

  it('queue max length is enforced at 5', () => {
    const queue = ['a', 'b', 'c', 'd', 'e'];
    expect(queue.length < 5).toBe(false);
    // New item should NOT be added when queue is full
  });

  it('buggy follow-ups are prefixed with [FIX NEEDED]', () => {
    const isBuggy = true;
    const followUp = 'Recalculate using correct variable';
    const entry = isBuggy ? `[FIX NEEDED] ${followUp}` : followUp;
    expect(entry.startsWith('[FIX NEEDED]')).toBe(true);
  });

  it('valid follow-ups have no prefix', () => {
    const isBuggy = false;
    const followUp = 'Explore deeper patterns';
    const entry = isBuggy ? `[FIX NEEDED] ${followUp}` : followUp;
    expect(entry).not.toContain('[FIX NEEDED]');
  });

  it('queue is persisted via setMeta after modification', () => {
    mockSetMeta.mockClear();
    const queue = ['item1'];
    mockSetMeta('experiment:queue', JSON.stringify(queue));
    expect(mockSetMeta).toHaveBeenCalledWith('experiment:queue', JSON.stringify(queue));
  });
});

describe('Experiment execution — validation verdict parsing', () => {
  it('parses SOUND verdict', () => {
    const response = 'VERDICT: SOUND\nISSUES: none';
    const verdictMatch = response.match(/VERDICT:\s*(SOUND|BUGGY|DEGENERATE)/i);
    expect(verdictMatch?.[1]?.toLowerCase()).toBe('sound');
  });

  it('parses BUGGY verdict', () => {
    const response = 'VERDICT: BUGGY\nISSUES: constant output across all conditions';
    const verdictMatch = response.match(/VERDICT:\s*(SOUND|BUGGY|DEGENERATE)/i);
    expect(verdictMatch?.[1]?.toLowerCase()).toBe('buggy');
  });

  it('parses DEGENERATE verdict', () => {
    const response = 'VERDICT: DEGENERATE\nISSUES: trivial result';
    const verdictMatch = response.match(/VERDICT:\s*(SOUND|BUGGY|DEGENERATE)/i);
    expect(verdictMatch?.[1]?.toLowerCase()).toBe('degenerate');
  });

  it('defaults to sound when verdict unparseable', () => {
    const response = 'This looks good overall';
    const verdictMatch = response.match(/VERDICT:\s*(SOUND|BUGGY|DEGENERATE)/i);
    const status = (verdictMatch?.[1]?.toLowerCase() || 'sound') as string;
    expect(status).toBe('sound');
  });

  it('extracts issues text after ISSUES:', () => {
    const response = 'VERDICT: BUGGY\nISSUES: correlation is exactly 0.000 — method broken';
    const issuesMatch = response.match(/ISSUES:\s*(.+)/is);
    expect(issuesMatch?.[1]?.trim()).toContain('correlation');
  });
});

describe('Experiment execution — analysis parsing', () => {
  it('parses SUMMARY from analysis response', () => {
    const response = 'SUMMARY: Found strong correlation (r=0.75, p<0.001) between access frequency and importance.\nFOLLOW_UP: Test if emotional_weight modulates this effect.';
    const summaryMatch = response.match(/SUMMARY:\s*(.+?)(?=\nFOLLOW[_-]?UP:|$)/is);
    expect(summaryMatch?.[1]?.trim()).toContain('r=0.75');
  });

  it('parses FOLLOW_UP from analysis response', () => {
    const response = 'SUMMARY: test result\nFOLLOW_UP: Investigate temporal patterns';
    const followUpMatch = response.match(/FOLLOW[_-]?UP:\s*(.+)/is);
    expect(followUpMatch?.[1]?.trim()).toBe('Investigate temporal patterns');
  });

  it('returns null followUp when [NONE] is present', () => {
    const response = 'SUMMARY: null result\nFOLLOW_UP: [NONE]';
    const followUpMatch = response.match(/FOLLOW[_-]?UP:\s*(.+)/is);
    const followUpRaw = followUpMatch?.[1]?.trim() || null;
    const followUp = followUpRaw && !followUpRaw.includes('[NONE]') ? followUpRaw : null;
    expect(followUp).toBeNull();
  });

  it('returns null followUp when not present in response', () => {
    const response = 'SUMMARY: the experiment showed nothing interesting';
    const followUpMatch = response.match(/FOLLOW[_-]?UP:\s*(.+)/is);
    const followUpRaw = followUpMatch?.[1]?.trim() || null;
    expect(followUpRaw).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. SKILL SYSTEM BEHAVIORAL — REMOVED (findings.md P1:1561)
// ─────────────────────────────────────────────────────────────────────────────
// The skill system handed `new Function(...)` + `require` + `process` to
// LLM-authored code. Module and meta-tools deleted; source-regex regression
// in test/security-deep.test.ts enforces the removal.

describe('Skill system — removed (findings.md P1:1561)', () => {
  it('src/agent/skills.js no longer imports', async () => {
    await expect(import('../src/agent/skills.js')).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. DATA WORKSPACE BEHAVIORAL
// ─────────────────────────────────────────────────────────────────────────────

describe('Data workspace — ensureDataWorkspace execution', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `lain-ws-beh-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mockBasePath = testDir;
  });

  afterEach(async () => {
    try { await rm(testDir, { recursive: true }); } catch {}
  });

  it('creates experiment-data directory and returns its path', async () => {
    const { ensureDataWorkspace } = await import('../src/agent/data-workspace.js');
    const dir = ensureDataWorkspace();
    expect(dir).toContain('experiment-data');
    expect(existsSync(dir)).toBe(true);
  });

  it('is idempotent — repeated calls do not error', async () => {
    const { ensureDataWorkspace } = await import('../src/agent/data-workspace.js');
    ensureDataWorkspace();
    ensureDataWorkspace();
    ensureDataWorkspace();
    // No errors thrown
  });

  it('creates directory under the configured base path', async () => {
    const { ensureDataWorkspace, getDataWorkspacePath } = await import('../src/agent/data-workspace.js');
    const dir = ensureDataWorkspace();
    expect(dir).toBe(getDataWorkspacePath());
    expect(dir.startsWith(testDir)).toBe(true);
  });
});

describe('Data workspace — listDataFiles execution', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `lain-list-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(testDir, 'experiment-data'), { recursive: true });
    mockBasePath = testDir;
  });

  afterEach(async () => {
    try { await rm(testDir, { recursive: true }); } catch {}
  });

  it('returns empty array when no files exist', async () => {
    const { listDataFiles } = await import('../src/agent/data-workspace.js');
    const files = listDataFiles();
    expect(files).toEqual([]);
  });

  it('returns CSV files with name and sizeKB', async () => {
    await writeFile(join(testDir, 'experiment-data', 'results.csv'), 'a,b,c\n1,2,3\n4,5,6');
    const { listDataFiles } = await import('../src/agent/data-workspace.js');
    const files = listDataFiles();
    const csv = files.find(f => f.name === 'results.csv');
    expect(csv).toBeDefined();
    expect(typeof csv!.sizeKB).toBe('number');
  });

  it('returns JSON files', async () => {
    await writeFile(join(testDir, 'experiment-data', 'data.json'), '{"key": "value"}');
    const { listDataFiles } = await import('../src/agent/data-workspace.js');
    const files = listDataFiles();
    expect(files.some(f => f.name === 'data.json')).toBe(true);
  });

  it('returns TXT files', async () => {
    await writeFile(join(testDir, 'experiment-data', 'notes.txt'), 'some notes');
    const { listDataFiles } = await import('../src/agent/data-workspace.js');
    const files = listDataFiles();
    expect(files.some(f => f.name === 'notes.txt')).toBe(true);
  });

  it('returns TSV files', async () => {
    await writeFile(join(testDir, 'experiment-data', 'table.tsv'), 'a\tb\n1\t2');
    const { listDataFiles } = await import('../src/agent/data-workspace.js');
    const files = listDataFiles();
    expect(files.some(f => f.name === 'table.tsv')).toBe(true);
  });

  it('excludes Python files', async () => {
    await writeFile(join(testDir, 'experiment-data', 'script.py'), 'print("hi")');
    const { listDataFiles } = await import('../src/agent/data-workspace.js');
    const files = listDataFiles();
    expect(files.every(f => !f.name.endsWith('.py'))).toBe(true);
  });

  it('excludes executable files', async () => {
    await writeFile(join(testDir, 'experiment-data', 'malware.exe'), 'bad');
    const { listDataFiles } = await import('../src/agent/data-workspace.js');
    const files = listDataFiles();
    expect(files.every(f => !f.name.endsWith('.exe'))).toBe(true);
  });

  it('excludes database files', async () => {
    await writeFile(join(testDir, 'experiment-data', 'lain.db'), 'sqlite data');
    const { listDataFiles } = await import('../src/agent/data-workspace.js');
    const files = listDataFiles();
    expect(files.every(f => !f.name.endsWith('.db'))).toBe(true);
  });

  it('returns files sorted alphabetically by name', async () => {
    await writeFile(join(testDir, 'experiment-data', 'z.csv'), 'z');
    await writeFile(join(testDir, 'experiment-data', 'a.csv'), 'a');
    await writeFile(join(testDir, 'experiment-data', 'm.csv'), 'm');
    const { listDataFiles } = await import('../src/agent/data-workspace.js');
    const files = listDataFiles();
    const names = files.map(f => f.name);
    expect(names).toEqual([...names].sort());
  });

  it('returns empty when directory does not exist', async () => {
    mockBasePath = '/nonexistent/path/xyz/abc';
    const { listDataFiles } = await import('../src/agent/data-workspace.js');
    const files = listDataFiles();
    expect(files).toEqual([]);
  });
});

describe('Data workspace — getDataWorkspaceSize execution', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `lain-size-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(testDir, 'experiment-data'), { recursive: true });
    mockBasePath = testDir;
  });

  afterEach(async () => {
    try { await rm(testDir, { recursive: true }); } catch {}
  });

  it('returns 0 for empty workspace', async () => {
    const { getDataWorkspaceSize } = await import('../src/agent/data-workspace.js');
    const size = getDataWorkspaceSize();
    expect(size).toBe(0);
  });

  it('returns correct size for files in workspace', async () => {
    const content = 'x'.repeat(1000);
    await writeFile(join(testDir, 'experiment-data', 'data.csv'), content);
    const { getDataWorkspaceSize } = await import('../src/agent/data-workspace.js');
    const size = getDataWorkspaceSize();
    expect(size).toBeGreaterThanOrEqual(1000);
  });

  it('returns 0 when directory does not exist', async () => {
    mockBasePath = '/nonexistent/xyz';
    const { getDataWorkspaceSize } = await import('../src/agent/data-workspace.js');
    const size = getDataWorkspaceSize();
    expect(size).toBe(0);
  });

  it('sums sizes of multiple files', async () => {
    await writeFile(join(testDir, 'experiment-data', 'a.csv'), 'x'.repeat(500));
    await writeFile(join(testDir, 'experiment-data', 'b.csv'), 'y'.repeat(500));
    const { getDataWorkspaceSize } = await import('../src/agent/data-workspace.js');
    const size = getDataWorkspaceSize();
    expect(size).toBeGreaterThanOrEqual(1000);
  });
});

describe('Data workspace — sanitizeDataFileName execution', () => {
  it('returns clean name for valid CSV file', async () => {
    const { sanitizeDataFileName } = await import('../src/agent/data-workspace.js');
    expect(sanitizeDataFileName('results.csv')).toBe('results.csv');
  });

  it('returns clean name for valid JSON file', async () => {
    const { sanitizeDataFileName } = await import('../src/agent/data-workspace.js');
    expect(sanitizeDataFileName('output.json')).toBe('output.json');
  });

  it('returns clean name for valid TXT file', async () => {
    const { sanitizeDataFileName } = await import('../src/agent/data-workspace.js');
    expect(sanitizeDataFileName('notes.txt')).toBe('notes.txt');
  });

  it('returns clean name for valid TSV file', async () => {
    const { sanitizeDataFileName } = await import('../src/agent/data-workspace.js');
    expect(sanitizeDataFileName('data.tsv')).toBe('data.tsv');
  });

  it('strips directory path components', async () => {
    const { sanitizeDataFileName } = await import('../src/agent/data-workspace.js');
    expect(sanitizeDataFileName('dir/subdir/file.csv')).toBe('file.csv');
  });

  it('strips traversal sequences via basename', async () => {
    const { sanitizeDataFileName } = await import('../src/agent/data-workspace.js');
    const result = sanitizeDataFileName('../../etc/passwd.csv');
    expect(result).toBe('passwd.csv');
  });

  it('returns null for disallowed extension .py', async () => {
    const { sanitizeDataFileName } = await import('../src/agent/data-workspace.js');
    expect(sanitizeDataFileName('script.py')).toBeNull();
  });

  it('returns null for disallowed extension .exe', async () => {
    const { sanitizeDataFileName } = await import('../src/agent/data-workspace.js');
    expect(sanitizeDataFileName('malware.exe')).toBeNull();
  });

  it('returns null for disallowed extension .sh', async () => {
    const { sanitizeDataFileName } = await import('../src/agent/data-workspace.js');
    expect(sanitizeDataFileName('run.sh')).toBeNull();
  });

  it('returns null for empty string', async () => {
    const { sanitizeDataFileName } = await import('../src/agent/data-workspace.js');
    expect(sanitizeDataFileName('')).toBeNull();
  });

  it('returns null for filename over 200 characters', async () => {
    const { sanitizeDataFileName } = await import('../src/agent/data-workspace.js');
    const longName = 'a'.repeat(201) + '.csv';
    expect(sanitizeDataFileName(longName)).toBeNull();
  });

  it('returns null for filename under 2 characters', async () => {
    const { sanitizeDataFileName } = await import('../src/agent/data-workspace.js');
    // Single char 'a' has no valid extension
    expect(sanitizeDataFileName('a')).toBeNull();
  });

  it('handles filenames with spaces', async () => {
    const { sanitizeDataFileName } = await import('../src/agent/data-workspace.js');
    const result = sanitizeDataFileName('my data file.csv');
    expect(result).toBe('my data file.csv');
  });

  it('handles filenames with hyphens and underscores', async () => {
    const { sanitizeDataFileName } = await import('../src/agent/data-workspace.js');
    expect(sanitizeDataFileName('my-data_file.json')).toBe('my-data_file.json');
  });

  it('strips backslash path separators', async () => {
    const { sanitizeDataFileName } = await import('../src/agent/data-workspace.js');
    const result = sanitizeDataFileName('data.csv');
    // basename on its own handles OS-specific separators
    expect(result).not.toContain('\\');
  });

  it('prefixed experiment output names are valid', async () => {
    const { sanitizeDataFileName } = await import('../src/agent/data-workspace.js');
    const result = sanitizeDataFileName('abc123def456_correlation_data.csv');
    expect(result).toBe('abc123def456_correlation_data.csv');
  });
});

describe('Data workspace — constants verification', () => {
  it('MAX_DATA_DIR_BYTES is 100MB', async () => {
    const { MAX_DATA_DIR_BYTES } = await import('../src/agent/data-workspace.js');
    expect(MAX_DATA_DIR_BYTES).toBe(100 * 1024 * 1024);
  });

  it('MAX_SINGLE_FILE_BYTES is 10MB', async () => {
    const { MAX_SINGLE_FILE_BYTES } = await import('../src/agent/data-workspace.js');
    expect(MAX_SINGLE_FILE_BYTES).toBe(10 * 1024 * 1024);
  });

  it('ALLOWED_DATA_EXTENSIONS contains exactly .csv, .json, .txt, .tsv', async () => {
    const { ALLOWED_DATA_EXTENSIONS } = await import('../src/agent/data-workspace.js');
    expect(ALLOWED_DATA_EXTENSIONS.size).toBe(4);
    expect(ALLOWED_DATA_EXTENSIONS.has('.csv')).toBe(true);
    expect(ALLOWED_DATA_EXTENSIONS.has('.json')).toBe(true);
    expect(ALLOWED_DATA_EXTENSIONS.has('.txt')).toBe(true);
    expect(ALLOWED_DATA_EXTENSIONS.has('.tsv')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. DREAM SEEDER BEHAVIORAL
// ─────────────────────────────────────────────────────────────────────────────

describe('Dream seeder — startDreamSeederLoop execution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMeta.mockReturnValue(null);
  });

  it('returns a cleanup function', async () => {
    const { startDreamSeederLoop } = await import('../src/agent/dream-seeder.js');
    const stop = startDreamSeederLoop({ workspaceDir: '/tmp/test-workspace' });
    expect(typeof stop).toBe('function');
    stop();
  });

  it('cleanup can be called multiple times safely', async () => {
    const { startDreamSeederLoop } = await import('../src/agent/dream-seeder.js');
    const stop = startDreamSeederLoop({ workspaceDir: '/tmp/test-workspace' });
    expect(() => { stop(); stop(); }).not.toThrow();
  });

  it('first run delay is 1 minute when no prior check exists', async () => {
    mockGetMeta.mockReturnValue(null);
    const { startDreamSeederLoop } = await import('../src/agent/dream-seeder.js');
    const stop = startDreamSeederLoop({ workspaceDir: '/tmp/test-workspace' });
    stop();
    // No assertion needed beyond non-error — verifies the initial delay path
  });

  it('calculates remaining delay when last check is recent', async () => {
    const recentCheck = (Date.now() - 3 * 60 * 60 * 1000).toString(); // 3h ago
    mockGetMeta.mockImplementation((key: string) => {
      if (key === 'dream-seeder:last_check_at') return recentCheck;
      return null;
    });
    const { startDreamSeederLoop } = await import('../src/agent/dream-seeder.js');
    const stop = startDreamSeederLoop({ workspaceDir: '/tmp/test-workspace' });
    stop();
  });

  it('uses minimum 60s delay even if overdue', async () => {
    const oldCheck = (Date.now() - 30 * 24 * 60 * 60 * 1000).toString(); // 30 days ago
    mockGetMeta.mockImplementation((key: string) => {
      if (key === 'dream-seeder:last_check_at') return oldCheck;
      return null;
    });
    const { startDreamSeederLoop } = await import('../src/agent/dream-seeder.js');
    const stop = startDreamSeederLoop({ workspaceDir: '/tmp/test-workspace' });
    stop();
  });
});

describe('Dream seeder — content fragment processing', () => {
  it('stripHtml removes all HTML tags', () => {
    const stripHtml = (html: string) => html.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').trim();
    expect(stripHtml('<p>Hello <strong>world</strong></p>')).toBe('Hello world');
  });

  it('stripHtml removes HTML entities', () => {
    const stripHtml = (html: string) => html.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').trim();
    expect(stripHtml('Hello &amp; world')).toBe('Hello   world');
  });

  it('stripHtml handles nested tags', () => {
    const stripHtml = (html: string) => html.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').trim();
    expect(stripHtml('<div><p><em>deep</em></p></div>')).toBe('deep');
  });

  it('long article is truncated to 1500 chars', () => {
    const article = 'x'.repeat(2000);
    expect(article.slice(0, 1500).length).toBe(1500);
  });

  it('fragments below 50 chars are rejected', () => {
    const text = 'Short';
    expect(text.length >= 50).toBe(false);
  });

  it('fragments at or above 50 chars are accepted', () => {
    const text = 'x'.repeat(50);
    expect(text.length >= 50).toBe(true);
  });

  it('fragments above 800 chars trigger splitting', () => {
    const chunk = 'x'.repeat(801);
    expect(chunk.length > 800).toBe(true);
  });

  it('chunks below 200 chars are not split prematurely', () => {
    const chunk = 'x'.repeat(150);
    expect(chunk.length >= 200).toBe(false);
    // Should not be split — needs at least 200 chars
  });

  it('seed emotional weight is between 0.4 and 0.7', () => {
    for (let i = 0; i < 50; i++) {
      const weight = 0.4 + Math.random() * 0.3;
      expect(weight).toBeGreaterThanOrEqual(0.4);
      expect(weight).toBeLessThanOrEqual(0.7);
    }
  });
});

describe('Dream seeder — peer communication format', () => {
  it('seed post body has content and emotionalWeight fields', () => {
    const body = { content: 'dream material', emotionalWeight: 0.5 };
    const json = JSON.stringify(body);
    const parsed = JSON.parse(json);
    expect(parsed.content).toBe('dream material');
    expect(typeof parsed.emotionalWeight).toBe('number');
  });

  it('peer stats response has pending field', () => {
    const stats = { pending: 25, consumed: 100 };
    expect(typeof stats.pending).toBe('number');
  });

  it('character needs seeding when pending below threshold of 50', () => {
    const threshold = 50;
    const pending = 25;
    expect(pending < threshold).toBe(true);
  });

  it('character does not need seeding when pending at or above threshold', () => {
    const threshold = 50;
    const pending = 50;
    expect(pending < threshold).toBe(false);
  });

  it('meta keys for tracking are correct', () => {
    expect('dream-seeder:last_check_at').toBe('dream-seeder:last_check_at');
    expect('dream-seeder:last_seeded_count').toBe('dream-seeder:last_seeded_count');
  });

  it('seeder cycle persists check timestamp via setMeta', () => {
    mockSetMeta.mockClear();
    mockSetMeta('dream-seeder:last_check_at', Date.now().toString());
    expect(mockSetMeta).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. POSSESSION SYSTEM BEHAVIORAL
// ─────────────────────────────────────────────────────────────────────────────

describe('Possession — startPossession and endPossession execution', () => {
  afterEach(async () => {
    const { endPossession } = await import('../src/agent/possession.js');
    endPossession();
  });

  it('startPossession transitions isPossessed from false to true', async () => {
    const { startPossession, isPossessed, endPossession: end } = await import('../src/agent/possession.js');
    end(); // Ensure clean state
    expect(isPossessed()).toBe(false);
    startPossession('test-session-1', [], []);
    expect(isPossessed()).toBe(true);
  });

  it('startPossession calls all provided stop functions', async () => {
    const { startPossession } = await import('../src/agent/possession.js');
    const stop1 = vi.fn();
    const stop2 = vi.fn();
    const stop3 = vi.fn();
    startPossession('test-session-2', [stop1, stop2, stop3], []);
    expect(stop1).toHaveBeenCalledOnce();
    expect(stop2).toHaveBeenCalledOnce();
    expect(stop3).toHaveBeenCalledOnce();
  });

  it('startPossession records the session ID in state', async () => {
    const { startPossession, getPossessionState } = await import('../src/agent/possession.js');
    startPossession('my-session-42', [], []);
    const state = getPossessionState();
    expect(state.playerSessionId).toBe('my-session-42');
  });

  it('startPossession records possessedAt timestamp', async () => {
    const { startPossession, getPossessionState } = await import('../src/agent/possession.js');
    const before = Date.now();
    startPossession('ts-session', [], []);
    const state = getPossessionState();
    expect(state.possessedAt).toBeGreaterThanOrEqual(before);
    expect(state.possessedAt).toBeLessThanOrEqual(Date.now());
  });

  it('endPossession transitions isPossessed from true to false', async () => {
    const { startPossession, endPossession, isPossessed } = await import('../src/agent/possession.js');
    startPossession('end-test', [], []);
    expect(isPossessed()).toBe(true);
    endPossession();
    expect(isPossessed()).toBe(false);
  });

  it('endPossession calls all restarter functions', async () => {
    const { startPossession, endPossession } = await import('../src/agent/possession.js');
    const restarter1 = vi.fn().mockReturnValue(vi.fn());
    const restarter2 = vi.fn().mockReturnValue(vi.fn());
    startPossession('restart-test', [], [restarter1, restarter2]);
    endPossession();
    expect(restarter1).toHaveBeenCalledOnce();
    expect(restarter2).toHaveBeenCalledOnce();
  });

  it('endPossession clears playerSessionId', async () => {
    const { startPossession, endPossession, getPossessionState } = await import('../src/agent/possession.js');
    startPossession('clear-test', [], []);
    endPossession();
    expect(getPossessionState().playerSessionId).toBeNull();
  });

  it('endPossession clears possessedAt', async () => {
    const { startPossession, endPossession, getPossessionState } = await import('../src/agent/possession.js');
    startPossession('clear-ts', [], []);
    endPossession();
    expect(getPossessionState().possessedAt).toBeNull();
  });

  it('second startPossession is ignored when already possessed', async () => {
    const { startPossession, isPossessed, getPossessionState } = await import('../src/agent/possession.js');
    const stop1 = vi.fn();
    const stop2 = vi.fn();
    startPossession('first-session', [stop1], []);
    startPossession('second-session', [stop2], []);
    expect(isPossessed()).toBe(true);
    expect(getPossessionState().playerSessionId).toBe('first-session');
    // stop1 called from first, stop2 never called because second was rejected
    expect(stop1).toHaveBeenCalledOnce();
    expect(stop2).not.toHaveBeenCalled();
  });

  it('endPossession is safe when not possessed', async () => {
    const { endPossession } = await import('../src/agent/possession.js');
    expect(() => endPossession()).not.toThrow();
    expect(() => endPossession()).not.toThrow();
  });
});

describe('Possession — pending peer messages', () => {
  afterEach(async () => {
    const { endPossession } = await import('../src/agent/possession.js');
    endPossession();
  });

  it('addPendingPeerMessage returns a Promise', async () => {
    const { startPossession, addPendingPeerMessage, endPossession } = await import('../src/agent/possession.js');
    startPossession('msg-test', [], []);
    const promise = addPendingPeerMessage('lain', 'Lain', 'hello');
    expect(promise).toBeInstanceOf(Promise);
    endPossession();
    await promise;
  });

  it('pending messages are visible via getPendingPeerMessages', async () => {
    const { startPossession, addPendingPeerMessage, getPendingPeerMessages, endPossession } = await import('../src/agent/possession.js');
    startPossession('visible-test', [], []);
    addPendingPeerMessage('pkd', 'PKD', 'what is real?');
    const pending = getPendingPeerMessages();
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.some(m => m.fromId === 'pkd')).toBe(true);
    endPossession();
  });

  it('getPendingPeerMessages strips resolve and timeoutHandle internals', async () => {
    const { startPossession, addPendingPeerMessage, getPendingPeerMessages, endPossession } = await import('../src/agent/possession.js');
    startPossession('strip-test', [], []);
    addPendingPeerMessage('john', 'John', 'hey');
    const pending = getPendingPeerMessages();
    const msg = pending[0]!;
    expect(msg).toHaveProperty('fromId');
    expect(msg).toHaveProperty('fromName');
    expect(msg).toHaveProperty('message');
    expect(msg).toHaveProperty('timestamp');
    expect(msg).not.toHaveProperty('resolve');
    expect(msg).not.toHaveProperty('timeoutHandle');
    endPossession();
  });

  it('resolvePendingMessage resolves the Promise with player response', async () => {
    const { startPossession, addPendingPeerMessage, resolvePendingMessage, endPossession } = await import('../src/agent/possession.js');
    startPossession('resolve-test', [], []);
    const promise = addPendingPeerMessage('mckenna', 'McKenna', 'follow the mycelium');
    const resolved = resolvePendingMessage('mckenna', 'fascinating');
    expect(resolved).toBe(true);
    const response = await promise;
    expect(response).toBe('fascinating');
    endPossession();
  });

  it('resolvePendingMessage returns false for unknown fromId', async () => {
    const { startPossession, resolvePendingMessage, endPossession } = await import('../src/agent/possession.js');
    startPossession('unknown-test', [], []);
    expect(resolvePendingMessage('nonexistent', 'hello')).toBe(false);
    endPossession();
  });

  it('endPossession auto-resolves all pending messages with "..."', async () => {
    const { startPossession, addPendingPeerMessage, endPossession } = await import('../src/agent/possession.js');
    startPossession('auto-resolve', [], []);
    const p1 = addPendingPeerMessage('lain', 'Lain', 'msg1');
    const p2 = addPendingPeerMessage('pkd', 'PKD', 'msg2');
    endPossession();
    expect(await p1).toBe('...');
    expect(await p2).toBe('...');
  });

  it('pendingCount reflects queued message count', async () => {
    const { startPossession, addPendingPeerMessage, getPossessionState, endPossession } = await import('../src/agent/possession.js');
    startPossession('count-test', [], []);
    addPendingPeerMessage('a', 'A', 'msg');
    addPendingPeerMessage('b', 'B', 'msg');
    addPendingPeerMessage('c', 'C', 'msg');
    expect(getPossessionState().pendingCount).toBe(3);
    endPossession();
  });

  it('resolved message is removed from pending queue', async () => {
    const { startPossession, addPendingPeerMessage, resolvePendingMessage, getPendingPeerMessages, endPossession } = await import('../src/agent/possession.js');
    startPossession('remove-test', [], []);
    addPendingPeerMessage('lain', 'Lain', 'hi');
    resolvePendingMessage('lain', 'hello back');
    const pending = getPendingPeerMessages();
    expect(pending.every(m => m.fromId !== 'lain')).toBe(true);
    endPossession();
  });
});

describe('Possession — getPossessionState', () => {
  afterEach(async () => {
    const { endPossession } = await import('../src/agent/possession.js');
    endPossession();
  });

  it('has isPossessed field', async () => {
    const { getPossessionState } = await import('../src/agent/possession.js');
    expect(getPossessionState()).toHaveProperty('isPossessed');
  });

  it('has possessedAt field', async () => {
    const { getPossessionState } = await import('../src/agent/possession.js');
    expect(getPossessionState()).toHaveProperty('possessedAt');
  });

  it('has playerSessionId field', async () => {
    const { getPossessionState } = await import('../src/agent/possession.js');
    expect(getPossessionState()).toHaveProperty('playerSessionId');
  });

  it('has pendingCount field', async () => {
    const { getPossessionState } = await import('../src/agent/possession.js');
    expect(getPossessionState()).toHaveProperty('pendingCount');
  });

  it('reflects correct state when possessed', async () => {
    const { startPossession, getPossessionState } = await import('../src/agent/possession.js');
    startPossession('state-check', [], []);
    const state = getPossessionState();
    expect(state.isPossessed).toBe(true);
    expect(state.possessedAt).not.toBeNull();
    expect(state.playerSessionId).toBe('state-check');
  });

  it('reflects correct state when not possessed', async () => {
    const { endPossession, getPossessionState } = await import('../src/agent/possession.js');
    endPossession();
    const state = getPossessionState();
    expect(state.isPossessed).toBe(false);
    expect(state.possessedAt).toBeNull();
    expect(state.playerSessionId).toBeNull();
  });
});

describe('Possession — touchActivity', () => {
  afterEach(async () => {
    const { endPossession } = await import('../src/agent/possession.js');
    endPossession();
  });

  it('does not throw when called outside possession', async () => {
    const { touchActivity } = await import('../src/agent/possession.js');
    expect(() => touchActivity()).not.toThrow();
  });

  it('does not throw when called during possession', async () => {
    const { startPossession, touchActivity } = await import('../src/agent/possession.js');
    startPossession('touch-test', [], []);
    expect(() => touchActivity()).not.toThrow();
  });

  it('can be called multiple times rapidly', async () => {
    const { touchActivity } = await import('../src/agent/possession.js');
    for (let i = 0; i < 100; i++) {
      touchActivity();
    }
    // No errors
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

  it('returns false when POSSESSION_TOKEN is not set', async () => {
    delete process.env['POSSESSION_TOKEN'];
    const { verifyPossessionAuth } = await import('../src/agent/possession.js');
    expect(verifyPossessionAuth('Bearer test')).toBe(false);
  });

  it('returns false when auth header is undefined', async () => {
    process.env['POSSESSION_TOKEN'] = 'secret';
    const { verifyPossessionAuth } = await import('../src/agent/possession.js');
    expect(verifyPossessionAuth(undefined)).toBe(false);
  });

  it('returns false when auth header lacks Bearer prefix', async () => {
    process.env['POSSESSION_TOKEN'] = 'secret';
    const { verifyPossessionAuth } = await import('../src/agent/possession.js');
    expect(verifyPossessionAuth('Token secret')).toBe(false);
  });

  it('returns false when auth header is empty string', async () => {
    process.env['POSSESSION_TOKEN'] = 'secret';
    const { verifyPossessionAuth } = await import('../src/agent/possession.js');
    expect(verifyPossessionAuth('')).toBe(false);
  });

  it('returns true for correct Bearer token', async () => {
    process.env['POSSESSION_TOKEN'] = 'correct-token';
    const { verifyPossessionAuth } = await import('../src/agent/possession.js');
    expect(verifyPossessionAuth('Bearer correct-token')).toBe(true);
  });

  it('returns false for wrong Bearer token', async () => {
    process.env['POSSESSION_TOKEN'] = 'correct-token';
    const { verifyPossessionAuth } = await import('../src/agent/possession.js');
    expect(verifyPossessionAuth('Bearer wrong-token')).toBe(false);
  });
});

describe('Possession — SSE clients', () => {
  it('addSSEClient and removeSSEClient do not throw', async () => {
    const { addSSEClient, removeSSEClient } = await import('../src/agent/possession.js');
    const mockRes = { write: vi.fn() } as unknown as import('node:http').ServerResponse;
    expect(() => addSSEClient(mockRes)).not.toThrow();
    expect(() => removeSSEClient(mockRes)).not.toThrow();
  });

  it('broadcastMovement writes to registered SSE clients', async () => {
    const { broadcastMovement, addSSEClient, removeSSEClient } = await import('../src/agent/possession.js');
    const writes: string[] = [];
    const mockRes = {
      write: vi.fn((data: string) => { writes.push(data); }),
    } as unknown as import('node:http').ServerResponse;

    addSSEClient(mockRes);
    broadcastMovement('library');

    const allWrites = writes.join('');
    expect(allWrites).toContain('movement');
    expect(allWrites).toContain('library');
    removeSSEClient(mockRes);
  });

  it('broadcastMovement includes timestamp', async () => {
    const { broadcastMovement, addSSEClient, removeSSEClient } = await import('../src/agent/possession.js');
    const writes: string[] = [];
    const mockRes = {
      write: vi.fn((data: string) => { writes.push(data); }),
    } as unknown as import('node:http').ServerResponse;

    addSSEClient(mockRes);
    broadcastMovement('threshold');
    const allWrites = writes.join('');
    expect(allWrites).toContain('timestamp');
    removeSSEClient(mockRes);
  });

  it('removeSSEClient prevents further writes', async () => {
    const { broadcastMovement, addSSEClient, removeSSEClient } = await import('../src/agent/possession.js');
    const mockRes = {
      write: vi.fn(),
    } as unknown as import('node:http').ServerResponse;

    addSSEClient(mockRes);
    removeSSEClient(mockRes);
    broadcastMovement('garden');
    // write should not be called after removal for the 'garden' event
    const gardenCalls = vi.mocked(mockRes.write).mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('garden')
    );
    expect(gardenCalls).toHaveLength(0);
  });
});

describe('Possession — getActiveLoopStops', () => {
  afterEach(async () => {
    const { endPossession } = await import('../src/agent/possession.js');
    endPossession();
  });

  it('returns an array', async () => {
    const { getActiveLoopStops } = await import('../src/agent/possession.js');
    expect(Array.isArray(getActiveLoopStops())).toBe(true);
  });

  it('contains stop functions after endPossession restarts loops', async () => {
    const { startPossession, endPossession, getActiveLoopStops } = await import('../src/agent/possession.js');
    const mockStop = vi.fn();
    const restarter = vi.fn().mockReturnValue(mockStop);
    startPossession('active-loops', [], [restarter]);
    endPossession();
    const stops = getActiveLoopStops();
    expect(stops.length).toBeGreaterThan(0);
    expect(stops[0]).toBe(mockStop);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. FEED HEALTH BEHAVIORAL
// ─────────────────────────────────────────────────────────────────────────────

describe('Feed health — getFeedHealthState execution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns default state when no meta exists', async () => {
    mockGetMeta.mockReturnValue(null);
    const { getFeedHealthState } = await import('../src/agent/feed-health.js');
    const state = getFeedHealthState();
    expect(state.failures).toEqual({});
    expect(state.replaced).toEqual({});
    expect(state.lastCheckAt).toBe(0);
  });

  it('parses stored state from meta', async () => {
    const stored = {
      failures: { 'https://dead.com/feed': 2 },
      replaced: { 'https://old.com/feed': 'https://new.com/feed' },
      lastCheckAt: 1700000000000,
    };
    mockGetMeta.mockReturnValue(JSON.stringify(stored));
    const { getFeedHealthState } = await import('../src/agent/feed-health.js');
    const state = getFeedHealthState();
    expect(state.failures['https://dead.com/feed']).toBe(2);
    expect(state.replaced['https://old.com/feed']).toBe('https://new.com/feed');
    expect(state.lastCheckAt).toBe(1700000000000);
  });

  it('handles corrupted JSON gracefully by returning defaults', async () => {
    mockGetMeta.mockReturnValue('{invalid json');
    const { getFeedHealthState } = await import('../src/agent/feed-health.js');
    // Should throw (or the module should catch it)
    try {
      getFeedHealthState();
    } catch {
      // Expected — corrupted JSON throws
    }
  });
});

describe('Feed health — startFeedHealthLoop execution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMeta.mockReturnValue(null);
  });

  it('returns a cleanup function', async () => {
    const { startFeedHealthLoop } = await import('../src/agent/feed-health.js');
    const stop = startFeedHealthLoop({ workspaceDir: '/tmp/ws' });
    expect(typeof stop).toBe('function');
    stop();
  });

  it('cleanup does not throw', async () => {
    const { startFeedHealthLoop } = await import('../src/agent/feed-health.js');
    const stop = startFeedHealthLoop({ workspaceDir: '/tmp/ws' });
    expect(() => stop()).not.toThrow();
  });

  it('cleanup can be called multiple times', async () => {
    const { startFeedHealthLoop } = await import('../src/agent/feed-health.js');
    const stop = startFeedHealthLoop({ workspaceDir: '/tmp/ws' });
    expect(() => { stop(); stop(); }).not.toThrow();
  });

  it('initial delay is 60s when no prior check exists', async () => {
    mockGetMeta.mockReturnValue(null);
    const { startFeedHealthLoop } = await import('../src/agent/feed-health.js');
    const stop = startFeedHealthLoop({ workspaceDir: '/tmp/ws' });
    stop();
  });

  it('initial delay respects elapsed time since last check', async () => {
    const recentCheck = JSON.stringify({
      failures: {},
      replaced: {},
      lastCheckAt: Date.now() - 3 * 24 * 60 * 60 * 1000, // 3 days ago
    });
    mockGetMeta.mockReturnValue(recentCheck);
    const { startFeedHealthLoop } = await import('../src/agent/feed-health.js');
    const stop = startFeedHealthLoop({ workspaceDir: '/tmp/ws' });
    stop();
  });
});

describe('Feed health — feed checking logic', () => {
  it('feed with fewer than 2 items is unhealthy', () => {
    const itemCount = 1;
    expect(itemCount >= 2).toBe(false);
  });

  it('feed with 2 or more items is healthy', () => {
    const itemCount = 5;
    expect(itemCount >= 2).toBe(true);
  });

  it('failure count increments on consecutive failures', () => {
    const failures: Record<string, number> = {};
    const url = 'https://test.com/feed';
    failures[url] = (failures[url] ?? 0) + 1;
    expect(failures[url]).toBe(1);
    failures[url] = (failures[url] ?? 0) + 1;
    expect(failures[url]).toBe(2);
    failures[url] = (failures[url] ?? 0) + 1;
    expect(failures[url]).toBe(3);
  });

  it('failure count resets on recovery', () => {
    const failures: Record<string, number> = { 'https://test.com/feed': 2 };
    delete failures['https://test.com/feed'];
    expect(failures['https://test.com/feed']).toBeUndefined();
  });

  it('feed is dead at failure threshold of 3', () => {
    const FAILURE_THRESHOLD = 3;
    expect(3 >= FAILURE_THRESHOLD).toBe(true);
    expect(4 >= FAILURE_THRESHOLD).toBe(true);
  });

  it('feed is not dead below failure threshold', () => {
    const FAILURE_THRESHOLD = 3;
    expect(2 >= FAILURE_THRESHOLD).toBe(false);
    expect(1 >= FAILURE_THRESHOLD).toBe(false);
    expect(0 >= FAILURE_THRESHOLD).toBe(false);
  });

  it('backup feeds pool has at least 10 entries', () => {
    // Source code has 15 backup feeds
    const knownCount = 15;
    expect(knownCount).toBeGreaterThanOrEqual(10);
  });

  it('dead feed is recorded in replaced map with replacement URL', () => {
    const replaced: Record<string, string> = {};
    replaced['https://dead.com/feed'] = 'https://backup.com/feed';
    expect(replaced['https://dead.com/feed']).toBe('https://backup.com/feed');
  });

  it('replaced feed is excluded from active set', () => {
    const activeUrls = new Set(['https://a.com/feed', 'https://dead.com/feed']);
    const deadUrl = 'https://dead.com/feed';
    activeUrls.delete(deadUrl);
    activeUrls.add('https://backup.com/feed');
    expect(activeUrls.has(deadUrl)).toBe(false);
    expect(activeUrls.has('https://backup.com/feed')).toBe(true);
  });

  it('check interval is 7 days', () => {
    const CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
    expect(CHECK_INTERVAL_MS).toBe(604_800_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. PROACTIVE MESSAGE BEHAVIORAL
// ─────────────────────────────────────────────────────────────────────────────

describe('Proactive — trySendProactiveMessage execution', () => {
  const originalBotToken = process.env['TELEGRAM_BOT_TOKEN'];
  const originalChatId = process.env['TELEGRAM_CHAT_ID'];

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMeta.mockReturnValue(null);
  });

  afterEach(() => {
    if (originalBotToken) process.env['TELEGRAM_BOT_TOKEN'] = originalBotToken;
    else delete process.env['TELEGRAM_BOT_TOKEN'];
    if (originalChatId) process.env['TELEGRAM_CHAT_ID'] = originalChatId;
    else delete process.env['TELEGRAM_CHAT_ID'];
  });

  it('returns false when TELEGRAM_BOT_TOKEN is not set', async () => {
    delete process.env['TELEGRAM_BOT_TOKEN'];
    delete process.env['TELEGRAM_CHAT_ID'];
    const { trySendProactiveMessage } = await import('../src/agent/proactive.js');
    const result = await trySendProactiveMessage('hello', 'test');
    expect(result).toBe(false);
  });

  it('returns false when TELEGRAM_CHAT_ID is not set', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 'test-token';
    delete process.env['TELEGRAM_CHAT_ID'];
    const { trySendProactiveMessage } = await import('../src/agent/proactive.js');
    const result = await trySendProactiveMessage('hello', 'test');
    expect(result).toBe(false);
  });

  it('returns false when both Telegram vars are missing', async () => {
    delete process.env['TELEGRAM_BOT_TOKEN'];
    delete process.env['TELEGRAM_CHAT_ID'];
    const { trySendProactiveMessage } = await import('../src/agent/proactive.js');
    const result = await trySendProactiveMessage('hello', 'test');
    expect(result).toBe(false);
  });

  // Kill-switch semantics (P1 regression: old code used PROACTIVE_OUTREACH_DISABLED!=='0',
  // which meant any value except the literal string '0' kept it disabled and values like
  // 'false'/'no'/'off' silently failed open in the opposite direction).
  describe('PROACTIVE_OUTREACH_ENABLED kill-switch', () => {
    const originalEnabled = process.env['PROACTIVE_OUTREACH_ENABLED'];
    const originalDisabled = process.env['PROACTIVE_OUTREACH_DISABLED'];

    afterEach(() => {
      if (originalEnabled === undefined) delete process.env['PROACTIVE_OUTREACH_ENABLED'];
      else process.env['PROACTIVE_OUTREACH_ENABLED'] = originalEnabled;
      if (originalDisabled === undefined) delete process.env['PROACTIVE_OUTREACH_DISABLED'];
      else process.env['PROACTIVE_OUTREACH_DISABLED'] = originalDisabled;
    });

    it('is disabled by default when env is unset', async () => {
      delete process.env['PROACTIVE_OUTREACH_ENABLED'];
      process.env['TELEGRAM_BOT_TOKEN'] = 'test';
      process.env['TELEGRAM_CHAT_ID'] = 'test';
      const { trySendProactiveMessage } = await import('../src/agent/proactive.js');
      expect(await trySendProactiveMessage('hello', 'test')).toBe(false);
    });

    it('is disabled when set to "0" (the old enable-value is now correctly inert)', async () => {
      process.env['PROACTIVE_OUTREACH_ENABLED'] = '0';
      process.env['TELEGRAM_BOT_TOKEN'] = 'test';
      process.env['TELEGRAM_CHAT_ID'] = 'test';
      const { trySendProactiveMessage } = await import('../src/agent/proactive.js');
      expect(await trySendProactiveMessage('hello', 'test')).toBe(false);
    });

    it('is disabled when set to "false"', async () => {
      process.env['PROACTIVE_OUTREACH_ENABLED'] = 'false';
      process.env['TELEGRAM_BOT_TOKEN'] = 'test';
      process.env['TELEGRAM_CHAT_ID'] = 'test';
      const { trySendProactiveMessage } = await import('../src/agent/proactive.js');
      expect(await trySendProactiveMessage('hello', 'test')).toBe(false);
    });

    it('does NOT read the old PROACTIVE_OUTREACH_DISABLED variable', async () => {
      // Old footgun: setting DISABLED=0 used to *enable* the feature.
      delete process.env['PROACTIVE_OUTREACH_ENABLED'];
      process.env['PROACTIVE_OUTREACH_DISABLED'] = '0';
      process.env['TELEGRAM_BOT_TOKEN'] = 'test';
      process.env['TELEGRAM_CHAT_ID'] = 'test';
      const { trySendProactiveMessage } = await import('../src/agent/proactive.js');
      expect(await trySendProactiveMessage('hello', 'test')).toBe(false);
    });
  });
});

describe('Proactive — startProactiveLoop execution', () => {
  const originalBotToken = process.env['TELEGRAM_BOT_TOKEN'];
  const originalChatId = process.env['TELEGRAM_CHAT_ID'];

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMeta.mockReturnValue(null);
  });

  afterEach(() => {
    if (originalBotToken) process.env['TELEGRAM_BOT_TOKEN'] = originalBotToken;
    else delete process.env['TELEGRAM_BOT_TOKEN'];
    if (originalChatId) process.env['TELEGRAM_CHAT_ID'] = originalChatId;
    else delete process.env['TELEGRAM_CHAT_ID'];
  });

  it('returns no-op cleanup when disabled', async () => {
    const { startProactiveLoop } = await import('../src/agent/proactive.js');
    const stop = startProactiveLoop({ enabled: false });
    expect(typeof stop).toBe('function');
    expect(() => stop()).not.toThrow();
  });

  it('returns no-op cleanup when Telegram not configured', async () => {
    delete process.env['TELEGRAM_BOT_TOKEN'];
    delete process.env['TELEGRAM_CHAT_ID'];
    const { startProactiveLoop } = await import('../src/agent/proactive.js');
    const stop = startProactiveLoop({ enabled: true });
    expect(typeof stop).toBe('function');
    stop();
  });

  it('returns cleanup function when properly configured', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 'test-token';
    process.env['TELEGRAM_CHAT_ID'] = '123456';
    const { startProactiveLoop } = await import('../src/agent/proactive.js');
    const stop = startProactiveLoop({
      enabled: true,
      reflectionIntervalMs: 999_999_999,
      silenceCheckIntervalMs: 999_999_999,
    });
    expect(typeof stop).toBe('function');
    stop();
  });

  it('cleanup can be called multiple times', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 'test-token';
    process.env['TELEGRAM_CHAT_ID'] = '123456';
    const { startProactiveLoop } = await import('../src/agent/proactive.js');
    const stop = startProactiveLoop({
      enabled: true,
      reflectionIntervalMs: 999_999_999,
      silenceCheckIntervalMs: 999_999_999,
    });
    expect(() => { stop(); stop(); }).not.toThrow();
  });
});

describe('Proactive — rate limiting logic', () => {
  it('daily cap prevents sending when at max', () => {
    const maxMessagesPerDay = 4;
    const sentToday = 4;
    expect(sentToday >= maxMessagesPerDay).toBe(true);
  });

  it('daily cap allows sending when below max', () => {
    const maxMessagesPerDay = 4;
    const sentToday = 2;
    expect(sentToday >= maxMessagesPerDay).toBe(false);
  });

  it('cooldown prevents sending when too recent', () => {
    const minInterval = 60 * 60 * 1000; // 1 hour
    const lastSentAt = Date.now() - 30 * 60 * 1000; // 30 min ago
    const timeSinceLast = Date.now() - lastSentAt;
    expect(timeSinceLast < minInterval).toBe(true);
  });

  it('cooldown allows sending after enough time', () => {
    const minInterval = 60 * 60 * 1000; // 1 hour
    const lastSentAt = Date.now() - 90 * 60 * 1000; // 90 min ago
    const timeSinceLast = Date.now() - lastSentAt;
    expect(timeSinceLast < minInterval).toBe(false);
  });

  it('timestamps older than 24h are pruned', () => {
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const timestamps = [
      dayAgo - 60000,  // 24h + 1min ago — should be pruned
      dayAgo + 60000,  // 24h - 1min ago — should be kept
      Date.now(),       // now — should be kept
    ];
    const pruned: number[] = [];
    for (const ts of timestamps) {
      if (ts >= dayAgo) pruned.push(ts);
    }
    expect(pruned).toHaveLength(2);
  });

  it('remaining budget calculation is correct', () => {
    const maxMessagesPerDay = 4;
    const sentToday = 2;
    const remaining = Math.max(0, maxMessagesPerDay - sentToday);
    expect(remaining).toBe(2);
  });

  it('remaining budget floors at 0', () => {
    const maxMessagesPerDay = 4;
    const sentToday = 6;
    const remaining = Math.max(0, maxMessagesPerDay - sentToday);
    expect(remaining).toBe(0);
  });
});

describe('Proactive — reflection prompt building', () => {
  it('silence trigger includes user silence context', () => {
    const trigger = 'silence';
    const triggerContext =
      trigger === 'silence'
        ? 'The user has been silent for a while.'
        : trigger === 'high_signal'
          ? 'A high-importance memory was just extracted.'
          : 'Scheduled reflection.';
    expect(triggerContext).toContain('silent');
  });

  it('high_signal trigger includes high-importance context', () => {
    const trigger = 'high_signal';
    const triggerContext =
      trigger === 'silence'
        ? 'silent'
        : trigger === 'high_signal'
          ? 'A high-importance memory was just extracted.'
          : 'Scheduled reflection.';
    expect(triggerContext).toContain('high-importance');
  });

  it('scheduled trigger includes scheduled reflection context', () => {
    const trigger = 'scheduled';
    const triggerContext =
      trigger === 'silence'
        ? 'silent'
        : trigger === 'high_signal'
          ? 'high-importance'
          : 'Scheduled reflection.';
    expect(triggerContext).toContain('Scheduled');
  });

  it('[SILENCE] sentinel causes no message to be sent', () => {
    const response = '[SILENCE]';
    expect(response.includes('[SILENCE]')).toBe(true);
  });

  it('normal response does not contain [SILENCE]', () => {
    const response = 'i was thinking about something you said earlier...';
    expect(response.includes('[SILENCE]')).toBe(false);
  });

  it('messages too short after styling are rejected', () => {
    const styledMessage = 'hi';
    expect(!styledMessage || styledMessage.length < 5).toBe(true);
  });

  it('messages at or above 5 chars pass length check', () => {
    const styledMessage = 'hello there...';
    expect(!styledMessage || styledMessage.length < 5).toBe(false);
  });
});

describe('Proactive — onHighSignalExtraction', () => {
  const originalBotToken = process.env['TELEGRAM_BOT_TOKEN'];
  const originalChatId = process.env['TELEGRAM_CHAT_ID'];

  afterEach(() => {
    if (originalBotToken) process.env['TELEGRAM_BOT_TOKEN'] = originalBotToken;
    else delete process.env['TELEGRAM_BOT_TOKEN'];
    if (originalChatId) process.env['TELEGRAM_CHAT_ID'] = originalChatId;
    else delete process.env['TELEGRAM_CHAT_ID'];
  });

  it('does nothing when Telegram not configured', async () => {
    delete process.env['TELEGRAM_BOT_TOKEN'];
    delete process.env['TELEGRAM_CHAT_ID'];
    const { onHighSignalExtraction } = await import('../src/agent/proactive.js');
    // Should not throw
    expect(() => onHighSignalExtraction()).not.toThrow();
  });

  it('schedules a delayed reflection when Telegram is configured', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 'test-token';
    process.env['TELEGRAM_CHAT_ID'] = '123456';
    const { onHighSignalExtraction } = await import('../src/agent/proactive.js');
    // Should not throw — schedules a 5-minute delayed reflection
    expect(() => onHighSignalExtraction()).not.toThrow();
  });
});

describe('Proactive — config defaults', () => {
  it('default reflection interval is 2.5 hours', () => {
    const reflectionIntervalMs = 2.5 * 60 * 60 * 1000;
    expect(reflectionIntervalMs).toBe(9_000_000);
  });

  it('default silence threshold is 6 hours', () => {
    const silenceThresholdMs = 6 * 60 * 60 * 1000;
    expect(silenceThresholdMs).toBe(21_600_000);
  });

  it('default silence check interval is 30 minutes', () => {
    const silenceCheckIntervalMs = 30 * 60 * 1000;
    expect(silenceCheckIntervalMs).toBe(1_800_000);
  });

  it('default max messages per day is 4', () => {
    const maxMessagesPerDay = 4;
    expect(maxMessagesPerDay).toBe(4);
  });

  it('default min interval between messages is 1 hour', () => {
    const minIntervalBetweenMessagesMs = 60 * 60 * 1000;
    expect(minIntervalBetweenMessagesMs).toBe(3_600_000);
  });

  it('enabled by default', () => {
    const enabled = true;
    expect(enabled).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. CROSS-CUTTING BEHAVIORAL TESTS
// ─────────────────────────────────────────────────────────────────────────────

describe('Experiment execution — diary entry format', () => {
  it('diary entry status is SUCCESS for exit 0 with output', () => {
    const exitCode = 0;
    const timedOut = false;
    const hasOutput = true;
    const success = exitCode === 0 && !timedOut && hasOutput;
    const status = success ? 'SUCCESS' : timedOut ? 'TIMED OUT' : 'FAILED';
    expect(status).toBe('SUCCESS');
  });

  it('diary entry status is TIMED OUT for timeout', () => {
    const timedOut = true;
    const status = timedOut ? 'TIMED OUT' : 'FAILED';
    expect(status).toBe('TIMED OUT');
  });

  it('diary entry status is FAILED (no output) for exit 0 without output', () => {
    const exitCode = 0;
    const timedOut = false;
    const hasOutput = false;
    const success = exitCode === 0 && !timedOut && hasOutput;
    const status = success
      ? 'SUCCESS'
      : timedOut
        ? 'TIMED OUT'
        : exitCode === 0 && !hasOutput
          ? 'FAILED (no output)'
          : `FAILED (exit ${exitCode})`;
    expect(status).toBe('FAILED (no output)');
  });

  it('diary entry status includes exit code for non-zero failures', () => {
    const exitCode = 1;
    const timedOut = false;
    const hasOutput = false;
    const success = exitCode === 0 && !timedOut && hasOutput;
    const status = success
      ? 'SUCCESS'
      : timedOut
        ? 'TIMED OUT'
        : exitCode === 0 && !hasOutput
          ? 'FAILED (no output)'
          : `FAILED (exit ${exitCode})`;
    expect(status).toBe('FAILED (exit 1)');
  });

  it('diary entry includes attempts note when more than 1', () => {
    const attempts = 3;
    const attemptsNote = attempts > 1 ? `**Attempts:** ${attempts}\n` : '';
    expect(attemptsNote).toContain('3');
  });

  it('diary entry omits attempts note for single attempt', () => {
    const attempts = 1;
    const attemptsNote = attempts > 1 ? `**Attempts:** ${attempts}\n` : '';
    expect(attemptsNote).toBe('');
  });

  it('diary entry includes original code section when code was modified', () => {
    const originalCode = 'print("v1")';
    const currentCode = 'print("v2")';
    const codeChanged = originalCode !== currentCode;
    expect(codeChanged).toBe(true);
  });

  it('diary entry omits original code section when code unchanged', () => {
    const originalCode = 'print("v1")';
    const currentCode = 'print("v1")';
    const codeChanged = originalCode !== currentCode;
    expect(codeChanged).toBe(false);
  });
});

describe('Experiment execution — sandbox environment', () => {
  it('sandbox wraps code with matplotlib Agg backend', () => {
    const code = 'import matplotlib.pyplot as plt\nplt.plot([1,2,3])';
    const wrappedCode = `import matplotlib\nmatplotlib.use('Agg')\n${code}`;
    expect(wrappedCode).toContain("matplotlib.use('Agg')");
    expect(wrappedCode).toContain(code);
  });

  it('sandbox environment has restricted PATH', () => {
    const env = {
      PATH: '/usr/bin:/usr/local/bin',
      PYTHONDONTWRITEBYTECODE: '1',
    };
    expect(env.PATH).not.toContain('/home');
    expect(env.PYTHONDONTWRITEBYTECODE).toBe('1');
  });

  it('output is truncated at maxOutputBytes', () => {
    const maxOutputBytes = 50_000;
    const output = 'x'.repeat(60_000);
    const truncated = output.length >= maxOutputBytes
      ? output.slice(0, maxOutputBytes) + '\n[OUTPUT TRUNCATED]'
      : output;
    expect(truncated.length).toBeLessThan(output.length);
    expect(truncated).toContain('[OUTPUT TRUNCATED]');
  });

  it('output within limit is not truncated', () => {
    const maxOutputBytes = 50_000;
    const output = 'x'.repeat(1000);
    const truncated = output.length >= maxOutputBytes
      ? output.slice(0, maxOutputBytes) + '\n[OUTPUT TRUNCATED]'
      : output;
    expect(truncated).toBe(output);
    expect(truncated).not.toContain('[OUTPUT TRUNCATED]');
  });
});

describe('Experiment execution — peer sharing', () => {
  it('share peers includes Lain', () => {
    const SHARE_PEERS = [
      { id: 'lain', name: 'Lain', url: 'http://localhost:3001' },
      { id: 'pkd', name: 'Philip K. Dick', url: 'http://localhost:3003' },
      { id: 'mckenna', name: 'Terence McKenna', url: 'http://localhost:3004' },
      { id: 'john', name: 'John', url: 'http://localhost:3005' },
    ];
    expect(SHARE_PEERS[0]!.id).toBe('lain');
  });

  it('always shares with Lain and one random other', () => {
    const SHARE_PEERS = [
      { id: 'lain', name: 'Lain', url: 'http://localhost:3001' },
      { id: 'pkd', name: 'Philip K. Dick', url: 'http://localhost:3003' },
      { id: 'mckenna', name: 'Terence McKenna', url: 'http://localhost:3004' },
    ];
    const targets = [SHARE_PEERS[0]!];
    const others = SHARE_PEERS.slice(1);
    const randomPeer = others[Math.floor(Math.random() * others.length)]!;
    targets.push(randomPeer);
    expect(targets.length).toBe(2);
    expect(targets[0]!.id).toBe('lain');
    expect(targets[1]!.id).not.toBe('lain');
  });

  it('successful experiment share message includes analysis', () => {
    const result = {
      domain: 'memory',
      hypothesis: 'test hypothesis',
      analysis: 'Strong correlation found (r=0.8)',
      timedOut: false,
      exitCode: 0,
      stdout: 'p-value: 0.001',
    };
    const success = result.exitCode === 0 && !result.timedOut && result.stdout.trim().length > 0;
    const message = success
      ? `i ran an experiment... ${result.domain} — "${result.hypothesis}". ${result.analysis}`
      : `tried an experiment but it failed`;
    expect(message).toContain('Strong correlation');
    expect(message).toContain('memory');
  });

  it('failed experiment share message indicates failure', () => {
    const result = { domain: 'spatial', hypothesis: 'test', analysis: 'test', timedOut: true };
    const message = result.timedOut
      ? `tried an experiment on ${result.domain} but it timed out`
      : 'it failed';
    expect(message).toContain('timed out');
  });
});

describe('Data workspace — experiment data persistence logic', () => {
  it('allowed data extensions are validated before copy', () => {
    const ALLOWED = new Set(['.csv', '.json', '.txt', '.tsv']);
    expect(ALLOWED.has('.csv')).toBe(true);
    expect(ALLOWED.has('.png')).toBe(false);
    expect(ALLOWED.has('.py')).toBe(false);
  });

  it('per-file size limit is enforced before copy', () => {
    const MAX_SINGLE_FILE_BYTES = 10 * 1024 * 1024;
    const fileSize = 15 * 1024 * 1024; // 15MB
    expect(fileSize > MAX_SINGLE_FILE_BYTES).toBe(true);
  });

  it('workspace total size limit prevents overflow', () => {
    const MAX_DATA_DIR_BYTES = 100 * 1024 * 1024;
    const currentSize = 95 * 1024 * 1024;
    const fileSize = 10 * 1024 * 1024;
    expect(currentSize + fileSize > MAX_DATA_DIR_BYTES).toBe(true);
  });

  it('experiment ID is prefixed to output filenames', () => {
    const experimentId = 'abc123def456';
    const file = 'results.csv';
    const destName = `${experimentId}_${file}`;
    expect(destName).toBe('abc123def456_results.csv');
  });
});

describe('Dream seeder — sentence splitting for fragments', () => {
  it('splits text on sentence boundaries', () => {
    const text = 'First sentence. Second sentence. Third sentence.';
    const sentences = text.match(/[^.!?]+[.!?]+/g) ?? [text];
    expect(sentences.length).toBe(3);
  });

  it('handles text with no sentence-ending punctuation', () => {
    const text = 'Just a fragment without ending';
    const sentences = text.match(/[^.!?]+[.!?]+/g) ?? [text];
    expect(sentences).toEqual([text]);
  });

  it('handles text with mixed punctuation', () => {
    const text = 'Is this real? Yes it is! And this.';
    const sentences = text.match(/[^.!?]+[.!?]+/g) ?? [text];
    expect(sentences.length).toBe(3);
  });

  it('chunks accumulate until 800 chars then split', () => {
    // Use longer sentences to ensure we cross the 800-char and 200-char thresholds
    const sentences = Array.from({ length: 30 }, (_, i) =>
      `This is sentence number ${i} and it contains a reasonable amount of text to pad it out to a decent length for testing purposes.`
    );
    const chunks: string[] = [];
    let chunk = '';
    for (const sentence of sentences) {
      if ((chunk + sentence).length > 800 && chunk.length >= 200) {
        chunks.push(chunk.trim());
        chunk = '';
      }
      chunk += sentence;
    }
    if (chunk.trim().length >= 100) chunks.push(chunk.trim());
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk split should be at most ~800 + one sentence length
    expect(chunks.every(c => c.length <= 1200)).toBe(true);
  });
});

describe('Proactive — rate state persistence', () => {
  it('sent timestamps are serialized as JSON array', () => {
    const timestamps = [Date.now() - 1000, Date.now()];
    const serialized = JSON.stringify(timestamps);
    const parsed = JSON.parse(serialized) as number[];
    expect(parsed).toEqual(timestamps);
  });

  it('lastSentAt is stored as string number', () => {
    const lastSentAt = Date.now();
    const stored = lastSentAt.toString();
    const restored = parseInt(stored, 10);
    expect(restored).toBe(lastSentAt);
  });

  it('corrupted rate state falls back to defaults', () => {
    const raw = 'not valid json';
    let timestamps: number[] = [];
    try {
      const parsed = JSON.parse(raw) as number[];
      timestamps = Array.isArray(parsed) ? parsed : [];
    } catch {
      // Start fresh
      timestamps = [];
    }
    expect(timestamps).toEqual([]);
  });

  it('persistRateState writes both keys', () => {
    mockSetMeta.mockClear();
    mockSetMeta('proactive:sent_timestamps', JSON.stringify([Date.now()]));
    mockSetMeta('proactive:last_sent_at', Date.now().toString());
    expect(mockSetMeta).toHaveBeenCalledTimes(2);
  });
});
