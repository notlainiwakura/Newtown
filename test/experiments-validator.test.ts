/**
 * Regression tests for experiments.ts Python code validator.
 *
 * Guards against the P1 from docs/audit/findings.md: the original
 * regex-based validator could be bypassed by routing the path or mode
 * through a Python variable, f-string, or concatenation. The AST-based
 * policy check in checkPythonSyntax is the authoritative gate.
 */

import { describe, it, expect, vi } from 'vitest';

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

import { validatePythonCode, checkPythonSyntax } from '../src/agent/experiments.js';

describe('validatePythonCode (regex pre-pass)', () => {
  it('accepts literal open() reads from data/', () => {
    const r = validatePythonCode(`with open('data/lain.db', 'r') as f: pass`, 200);
    expect(r.valid).toBe(true);
  });

  it('accepts literal open() writes to output/', () => {
    const r = validatePythonCode(`with open('output/results.csv', 'w') as f: pass`, 200);
    expect(r.valid).toBe(true);
  });

  it('rejects literal open() writes to non-output/ paths', () => {
    const r = validatePythonCode(`open('data/x.csv', 'w')`, 200);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/output/i);
  });

  it('rejects literal absolute paths in open()', () => {
    const r = validatePythonCode(`open('/etc/passwd', 'r')`, 200);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/traversal/i);
  });

  it('rejects path-traversal in open()', () => {
    const r = validatePythonCode(`open('data/../../../etc/passwd', 'r')`, 200);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/traversal/i);
  });
});

describe('checkPythonSyntax — AST policy enforcement (P1 regression)', () => {
  it('accepts literal open() read of data/', async () => {
    const r = await checkPythonSyntax(`open('data/lain.db', 'r')\n`);
    expect(r.valid).toBe(true);
  });

  it('accepts default-mode open() read', async () => {
    const r = await checkPythonSyntax(`open('data/lain.db')\n`);
    expect(r.valid).toBe(true);
  });

  it('accepts literal open() write to output/', async () => {
    const r = await checkPythonSyntax(`open('output/x.csv', 'w')\n`);
    expect(r.valid).toBe(true);
  });

  // P1 REGRESSION: variable-path + variable-mode bypass
  it('rejects open() with variable path', async () => {
    const code = `p = '/etc/passwd'\nopen(p, 'r')\n`;
    const r = await checkPythonSyntax(code);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/path.*(string literal|literal)/i);
  });

  it('rejects open() with variable path and variable mode', async () => {
    const code = `p = '/etc/passwd'\nm = 'w'\nopen(p, m)\n`;
    const r = await checkPythonSyntax(code);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/literal/i);
  });

  it('rejects open() with literal path and variable mode', async () => {
    const code = `m = 'w'\nopen('data/x.csv', m)\n`;
    const r = await checkPythonSyntax(code);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/mode.*literal/i);
  });

  it('rejects open() with f-string path', async () => {
    const code = `x = 'passwd'\nopen(f'/etc/{x}', 'r')\n`;
    const r = await checkPythonSyntax(code);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/literal/i);
  });

  it('rejects open() with concatenated path', async () => {
    const code = `open('ou' + 'tput/foo.csv', 'w')\n`;
    const r = await checkPythonSyntax(code);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/literal/i);
  });

  it('rejects open() write to non-output/ with literal path', async () => {
    const r = await checkPythonSyntax(`open('data/foo.csv', 'w')\n`);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/output/i);
  });

  it('rejects open() with path traversal', async () => {
    const r = await checkPythonSyntax(`open('data/../../../etc/passwd', 'r')\n`);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/traversal/i);
  });

  it('rejects open() via file= keyword with variable', async () => {
    const code = `p = '/etc/shadow'\nopen(file=p)\n`;
    const r = await checkPythonSyntax(code);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/literal/i);
  });

  it('rejects open() via mode= keyword with variable', async () => {
    const code = `m = 'w'\nopen('data/x.csv', mode=m)\n`;
    const r = await checkPythonSyntax(code);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/mode.*literal/i);
  });

  it('rejects sqlite3.connect with variable path', async () => {
    const code = `import sqlite3\np = '/etc/other.db'\nsqlite3.connect(p)\n`;
    const r = await checkPythonSyntax(code);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/literal/i);
  });

  it('rejects sqlite3.connect to path outside data/', async () => {
    const code = `import sqlite3\nsqlite3.connect('/tmp/x.db')\n`;
    const r = await checkPythonSyntax(code);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/traversal|data\//i);
  });

  it('accepts sqlite3.connect to literal data/ path', async () => {
    const code = `import sqlite3\nsqlite3.connect('data/lain.db')\n`;
    const r = await checkPythonSyntax(code);
    expect(r.valid).toBe(true);
  });

  it('reports syntax errors distinctly from policy violations', async () => {
    const r = await checkPythonSyntax(`def foo(:\n    pass\n`);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/syntax/i);
  });
});

describe('checkPythonSyntax — pickle deserialization blocklist (P0-latent regression)', () => {
  it('rejects numpy.load()', async () => {
    const code = `import numpy\nnumpy.load('data/x.npy')\n`;
    const r = await checkPythonSyntax(code);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/pickle|blocked/i);
  });

  it('rejects aliased np.load()', async () => {
    const code = `import numpy as np\nnp.load('data/x.npy', allow_pickle=True)\n`;
    const r = await checkPythonSyntax(code);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/pickle|blocked/i);
  });

  it('rejects from-import: from numpy import load', async () => {
    const code = `from numpy import load\nload('data/x.npy')\n`;
    const r = await checkPythonSyntax(code);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/pickle|blocked/i);
  });

  it('rejects from-import with alias: from numpy import load as np_load', async () => {
    const code = `from numpy import load as np_load\nnp_load('data/x.npy')\n`;
    const r = await checkPythonSyntax(code);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/pickle|blocked/i);
  });

  it('rejects pandas.read_pickle()', async () => {
    const code = `import pandas\npandas.read_pickle('data/x.pkl')\n`;
    const r = await checkPythonSyntax(code);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/pickle|blocked/i);
  });

  it('rejects aliased pd.read_pickle()', async () => {
    const code = `import pandas as pd\npd.read_pickle('data/x.pkl')\n`;
    const r = await checkPythonSyntax(code);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/pickle|blocked/i);
  });

  it('rejects joblib.load()', async () => {
    const code = `import joblib\njoblib.load('data/model.bin')\n`;
    const r = await checkPythonSyntax(code);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/pickle|blocked/i);
  });

  it('rejects dill.load()', async () => {
    const code = `import dill\ndill.load(open('data/x.bin'))\n`;
    const r = await checkPythonSyntax(code);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/pickle|blocked/i);
  });

  it('rejects cloudpickle.load()', async () => {
    const code = `import cloudpickle\ncloudpickle.load(open('data/x.bin'))\n`;
    const r = await checkPythonSyntax(code);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/pickle|blocked/i);
  });

  it('still accepts numpy.frombuffer (the sanctioned embedding reader)', async () => {
    const code = `import numpy\nnumpy.frombuffer(b'\\x00\\x00', dtype=numpy.float32)\n`;
    const r = await checkPythonSyntax(code);
    expect(r.valid).toBe(true);
  });

  it('still accepts pandas.read_csv', async () => {
    const code = `import pandas as pd\npd.read_csv('data/x.csv')\n`;
    const r = await checkPythonSyntax(code);
    expect(r.valid).toBe(true);
  });
});

describe('checkPythonSyntax — aliasing / indirection bypasses (P1 regression)', () => {
  // The literal-argument check on open() / sqlite3.connect() was defeated
  // by re-binding the name, importing builtins, or routing through
  // getattr/globals. The walker now bans those approach vectors outright.

  it('rejects local-alias bypass: o = open; o(p, m)', async () => {
    const code = `p = '/etc/passwd'\nm = 'w'\no = open\no(p, m)\n`;
    const r = await checkPythonSyntax(code);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/alias|banned|reassign/i);
  });

  it('rejects shadowing open() with another function', async () => {
    const code = `def open(*a, **k):\n    pass\nopen('anywhere', 'w')\n`;
    const r = await checkPythonSyntax(code);
    expect(r.valid).toBe(false);
  });

  it('rejects `import builtins`', async () => {
    const code = `import builtins\nbuiltins.open('/etc/passwd', 'w')\n`;
    const r = await checkPythonSyntax(code);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/builtins|banned/i);
  });

  it('rejects `from builtins import open`', async () => {
    const code = `from builtins import open\nopen('/etc/passwd', 'w')\n`;
    const r = await checkPythonSyntax(code);
    expect(r.valid).toBe(false);
  });

  it('rejects __builtins__ attribute access', async () => {
    const code = `f = __builtins__.open('/etc/passwd', 'w')\n`;
    const r = await checkPythonSyntax(code);
    expect(r.valid).toBe(false);
  });

  it('rejects getattr() — arbitrary attribute lookup', async () => {
    const code = `f = getattr(__builtins__, 'open')\nf('/etc/passwd', 'w')\n`;
    const r = await checkPythonSyntax(code);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/getattr|banned/i);
  });

  it('rejects globals()/locals()/vars() indirection', async () => {
    for (const call of ['globals', 'locals', 'vars']) {
      const r = await checkPythonSyntax(`${call}()['open']('/etc/passwd', 'w')\n`);
      expect(r.valid).toBe(false);
      expect(r.reason).toMatch(new RegExp(`${call}|banned`, 'i'));
    }
  });

  it('rejects exec() / eval() / compile() / __import__', async () => {
    for (const call of ['exec', 'eval', 'compile', '__import__']) {
      const r = await checkPythonSyntax(`${call}('x')\n`);
      expect(r.valid).toBe(false);
    }
  });

  it('still accepts legitimate data/ + output/ patterns', async () => {
    const code = `with open('data/input.csv', 'r') as f:\n    data = f.read()\nwith open('output/result.txt', 'w') as g:\n    g.write('hi')\n`;
    const r = await checkPythonSyntax(code);
    expect(r.valid).toBe(true);
  });
});
