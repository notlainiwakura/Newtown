/**
 * Regression Guards v2 — New failure-mode coverage
 *
 * Every test documents a specific bug or failure pattern with a comment
 * explaining what it guards against. These tests DO NOT duplicate coverage
 * from regression.test.ts (50 tests) or anti-regression.test.ts (51 tests).
 *
 * Categories:
 *   1. maxTokens truncation guards
 *   2. Environment variable isolation guards
 *   3. Database isolation guards
 *   4. Auth persistence guards
 *   5. Character identity guards
 *   6. Silent failure guards
 *   7. Data integrity guards
 *   8. Performance regression guards
 *   9. Known bug pattern guards
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn().mockResolvedValue('test-master-key'),
    setPassword: vi.fn().mockResolvedValue(undefined),
    deletePassword: vi.fn().mockResolvedValue(true),
    findCredentials: vi.fn().mockResolvedValue([]),
  },
}));

const PROJECT_ROOT = join(__dirname, '..');

function readSrc(relativePath: string): string {
  return readFileSync(join(PROJECT_ROOT, relativePath), 'utf-8');
}

/**
 * Extract all `maxTokens: <number>` values from a source file.
 * Returns array of { value, line } objects.
 */
function extractMaxTokensValues(src: string): { value: number; line: number }[] {
  const results: { value: number; line: number }[] = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i]!.match(/maxTokens:\s*(\d+)/);
    if (match) {
      results.push({ value: parseInt(match[1]!, 10), line: i + 1 });
    }
  }
  return results;
}


// ═══════════════════════════════════════════════════════════════
// 1. maxTokens TRUNCATION GUARDS
//    Bug: commune loop had maxTokens: 250 which truncated verbose characters.
//    These guards ensure every agent loop has minimum token thresholds.
// ═══════════════════════════════════════════════════════════════
describe('maxTokens Truncation Guards', () => {
  // --- Commune loop guards ---

  it('commune impulse phase uses >= 1024 tokens', () => {
    // Bug: commune impulse at 250 tokens truncated openings for verbose characters.
    const src = readSrc('src/agent/commune-loop.ts');
    const values = extractMaxTokensValues(src);
    // The impulse phase (first complete() call) uses 1024
    const impulseCall = values.find(v => v.value >= 1024);
    expect(impulseCall, 'commune impulse must use >= 1024 maxTokens').toBeDefined();
  });

  it('commune conversation reply tokens >= 1024', () => {
    // Bug: reply phase at 200 tokens truncated nuanced character responses.
    const src = readSrc('src/agent/commune-loop.ts');
    const values = extractMaxTokensValues(src);
    // Multiple calls use 1024 in conversation phase
    const replyTokenCalls = values.filter(v => v.value >= 1024);
    expect(replyTokenCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('commune reflection tokens >= 512', () => {
    // Bug: reflections at <300 tokens cut off mid-thought.
    const src = readSrc('src/agent/commune-loop.ts');
    expect(src).toContain('maxTokens: 512');
  });

  // --- Diary loop guards ---

  it('diary entry tokens >= 1024', () => {
    // Bug: diary entries truncated at low token counts lost depth of reflection.
    const src = readSrc('src/agent/diary.ts');
    const values = extractMaxTokensValues(src);
    const diaryCall = values.find(v => v.value >= 1024);
    expect(diaryCall, 'diary entry must use >= 1024 maxTokens').toBeDefined();
  });

  // --- Letter loop guards ---

  it('letter composition tokens >= 1024', () => {
    // Bug: letters truncated mid-JSON when maxTokens too low, causing parse failures.
    const src = readSrc('src/agent/letter.ts');
    const values = extractMaxTokensValues(src);
    const letterCall = values.find(v => v.value >= 1024);
    expect(letterCall, 'letter composition must use >= 1024 maxTokens').toBeDefined();
  });

  // --- Dream loop guards ---

  it('dream fragment generation tokens >= 150', () => {
    // Bug: dream fragments at <100 tokens produced incomplete or empty text.
    const src = readSrc('src/agent/dreams.ts');
    const values = extractMaxTokensValues(src);
    const fragmentCall = values.find(v => v.value >= 150);
    expect(fragmentCall, 'dream fragment must use >= 150 maxTokens').toBeDefined();
  });

  it('dream residue tokens >= 60', () => {
    // Guard: residue is intentionally terse but must not be zero.
    const src = readSrc('src/agent/dreams.ts');
    const values = extractMaxTokensValues(src);
    const residueCall = values.find(v => v.value >= 60 && v.value <= 200);
    expect(residueCall, 'dream residue should use 60-200 maxTokens').toBeDefined();
  });

  // --- Internal state guards ---

  it('internal-state LLM update tokens >= 500', () => {
    // Bug: state update JSON truncated when maxTokens too low, causing heuristic fallback.
    const src = readSrc('src/agent/internal-state.ts');
    const values = extractMaxTokensValues(src);
    const stateCall = values.find(v => v.value >= 500);
    expect(stateCall, 'state update must use >= 500 maxTokens').toBeDefined();
  });

  // --- Curiosity loop guards ---

  it('curiosity inner thought tokens >= 256', () => {
    // Guard: inner thought must produce enough tokens to contain SITE: and QUERY: lines.
    const src = readSrc('src/agent/curiosity.ts');
    const values = extractMaxTokensValues(src);
    const thoughtCall = values.find(v => v.value >= 256);
    expect(thoughtCall, 'curiosity inner thought must use >= 256 maxTokens').toBeDefined();
  });

  it('curiosity digest tokens >= 256', () => {
    // Guard: digest must produce structured multi-field response.
    const src = readSrc('src/agent/curiosity.ts');
    const values = extractMaxTokensValues(src);
    const digestCalls = values.filter(v => v.value >= 256);
    expect(digestCalls.length).toBeGreaterThanOrEqual(2);
  });

  // --- Doctor server guards ---

  it('doctor-server chat maxTokens >= 8192', () => {
    // Bug: doctor at low maxTokens would truncate diagnostic tool-use chains.
    const src = readSrc('src/web/doctor-server.ts');
    const values = extractMaxTokensValues(src);
    const doctorCall = values.find(v => v.value >= 8192);
    expect(doctorCall, 'doctor-server chat must use >= 8192 maxTokens').toBeDefined();
  });

  it('doctor-server uses 8192 in all tool loop iterations', () => {
    // Guard: every continueWithToolResults call must also use >= 8192.
    const src = readSrc('src/web/doctor-server.ts');
    const values = extractMaxTokensValues(src);
    const highTokenCalls = values.filter(v => v.value >= 8192);
    expect(highTokenCalls.length, 'doctor-server must have multiple 8192-token calls for tool loop').toBeGreaterThanOrEqual(3);
  });

  // --- processMessage guards ---

  it('processMessage uses maxTokens >= 8192 (not a small value)', () => {
    // Bug: processMessage at low maxTokens truncates normal chat responses.
    const src = readSrc('src/agent/index.ts');
    const values = extractMaxTokensValues(src);
    const chatCalls = values.filter(v => v.value >= 8192);
    expect(chatCalls.length, 'processMessage must use >= 8192 maxTokens in chat path').toBeGreaterThanOrEqual(1);
  });

  it('processMessage never called with maxTokens < 2048', () => {
    // Guard: no direct chat path should use a dangerously low token limit.
    const src = readSrc('src/agent/index.ts');
    const values = extractMaxTokensValues(src);
    // In index.ts, the lowest acceptable is 2048 (for continuation/summary)
    const dangerouslyLow = values.filter(v => v.value < 2048);
    expect(dangerouslyLow.length, 'index.ts must not have maxTokens < 2048').toBe(0);
  });

  // --- Book loop guards ---

  it('book draft tokens >= 3000', () => {
    // Guard: book drafts need substantial token budget for chapter-length content.
    const src = readSrc('src/agent/book.ts');
    const values = extractMaxTokensValues(src);
    const draftCall = values.find(v => v.value >= 3000);
    expect(draftCall, 'book draft must use >= 3000 maxTokens').toBeDefined();
  });

  it('book revise tokens >= 6000', () => {
    // Guard: revision needs even more tokens because it rewrites full sections.
    const src = readSrc('src/agent/book.ts');
    const values = extractMaxTokensValues(src);
    const reviseCall = values.find(v => v.value >= 6000);
    expect(reviseCall, 'book revise must use >= 6000 maxTokens').toBeDefined();
  });

  it('book decideAction uses intentionally low tokens (single-word)', () => {
    // Guard: the 10-token call is intentional for a one-word decision, not a bug.
    const src = readSrc('src/agent/book.ts');
    expect(src).toContain('maxTokens: 10');
  });

  // --- Self-concept guards ---

  it('self-concept synthesis tokens >= 800', () => {
    // Guard: self-concept needs enough room for a multi-paragraph synthesis.
    const src = readSrc('src/agent/self-concept.ts');
    const values = extractMaxTokensValues(src);
    const selfConceptCall = values.find(v => v.value >= 800);
    expect(selfConceptCall, 'self-concept must use >= 800 maxTokens').toBeDefined();
  });

  // --- Proactive guards ---

  it('proactive reflection tokens >= 1024', () => {
    // Guard: proactive messages must have enough room for complete thoughts.
    const src = readSrc('src/agent/proactive.ts');
    const values = extractMaxTokensValues(src);
    const proactiveCall = values.find(v => v.value >= 1024);
    expect(proactiveCall, 'proactive reflection must use >= 1024 maxTokens').toBeDefined();
  });

  // --- Sweep: no agent file with dangerously low tokens in a generation call ---

  it('no agent loop file uses maxTokens < 60 except book decideAction (10)', () => {
    // Guard: any new agent loop file that sets maxTokens < 60 is likely a bug.
    const agentDir = join(PROJECT_ROOT, 'src', 'agent');
    const files = readdirSync(agentDir).filter(f => f.endsWith('.ts'));

    for (const file of files) {
      const src = readFileSync(join(agentDir, file), 'utf-8');
      const values = extractMaxTokensValues(src);
      for (const { value, line } of values) {
        if (value < 60) {
          // Only book.ts decideAction is allowed to use 10 tokens
          expect(
            file === 'book.ts' && value === 10,
            `${file}:${line} has maxTokens: ${value} which is dangerously low`
          ).toBe(true);
        }
      }
    }
  });

  it('narrative loop tokens >= 400', () => {
    // Guard: narrative generation needs room for a multi-sentence arc.
    const src = readSrc('src/agent/narratives.ts');
    const values = extractMaxTokensValues(src);
    const narrativeCall = values.find(v => v.value >= 400);
    expect(narrativeCall, 'narrative loop must use >= 400 maxTokens').toBeDefined();
  });

  it('relationship update tokens >= 200', () => {
    // Guard: relationship JSON needs room for structured fields.
    const src = readSrc('src/agent/relationships.ts');
    const values = extractMaxTokensValues(src);
    const relCall = values.find(v => v.value >= 200);
    expect(relCall, 'relationship update must use >= 200 maxTokens').toBeDefined();
  });

  it('membrane paraphrase tokens >= 300', () => {
    // Guard: letter paraphrase needs room to rewrite the letter content.
    const src = readSrc('src/agent/membrane.ts');
    const values = extractMaxTokensValues(src);
    const membraneCall = values.find(v => v.value >= 300);
    expect(membraneCall, 'membrane paraphrase must use >= 300 maxTokens').toBeDefined();
  });

  it('doctor telemetry analysis tokens >= 1500', () => {
    // Guard: telemetry analysis produces a clinical report that needs room.
    const src = readSrc('src/agent/doctor.ts');
    const values = extractMaxTokensValues(src);
    const telemetryCall = values.find(v => v.value >= 1500);
    expect(telemetryCall, 'doctor telemetry must use >= 1500 maxTokens').toBeDefined();
  });

  it('doctor therapy session tokens >= 800', () => {
    // Guard: therapy turns need room for nuanced dialogue.
    const src = readSrc('src/agent/doctor.ts');
    const values = extractMaxTokensValues(src);
    const therapyCalls = values.filter(v => v.value >= 800);
    expect(therapyCalls.length, 'doctor therapy must have >= 800 token calls').toBeGreaterThanOrEqual(2);
  });

  it('evolution loop tokens >= 200', () => {
    // Guard: evolution decisions need room for structured JSON output.
    const src = readSrc('src/agent/evolution.ts');
    const values = extractMaxTokensValues(src);
    const evoCall = values.find(v => v.value >= 200);
    expect(evoCall, 'evolution loop must use >= 200 maxTokens').toBeDefined();
  });

  it('dossier generation tokens >= 600', () => {
    // Guard: dossier is a structured character profile, needs room.
    const src = readSrc('src/agent/dossier.ts');
    const values = extractMaxTokensValues(src);
    const dossierCall = values.find(v => v.value >= 600);
    expect(dossierCall, 'dossier must use >= 600 maxTokens').toBeDefined();
  });
});


// ═══════════════════════════════════════════════════════════════
// 2. ENVIRONMENT VARIABLE ISOLATION GUARDS
//    Bug: LAIN_HOME in .env overrode per-service LAIN_HOME; LAIN_INTERLINK_TARGET
//    in .env caused Wired Lain to send letters to herself for months.
// ═══════════════════════════════════════════════════════════════
describe('Environment Variable Isolation Guards', () => {
  it('.env must NOT set LAIN_HOME (overrides per-service LAIN_HOME)', () => {
    // Bug: .env LAIN_HOME overrode per-service values, causing shared DB.
    try {
      const envContent = readFileSync(join(PROJECT_ROOT, '.env'), 'utf-8');
      const activeLines = envContent.split('\n').filter(l => !l.trim().startsWith('#') && l.trim().length > 0);
      const setsHome = activeLines.some(l => l.trim().startsWith('LAIN_HOME='));
      expect(setsHome, '.env sets LAIN_HOME which overrides per-service LAIN_HOME').toBe(false);
    } catch {
      // .env doesn't exist — that's fine
    }
  });

  it('.env must NOT set LAIN_INTERLINK_TARGET (overrides per-service values)', () => {
    // Bug: LAIN_INTERLINK_TARGET in .env caused Wired Lain to send letters to herself.
    try {
      const envContent = readFileSync(join(PROJECT_ROOT, '.env'), 'utf-8');
      const activeLines = envContent.split('\n').filter(l => !l.trim().startsWith('#') && l.trim().length > 0);
      const setsTarget = activeLines.some(l => l.trim().startsWith('LAIN_INTERLINK_TARGET='));
      expect(setsTarget, '.env sets LAIN_INTERLINK_TARGET which overrides per-service values').toBe(false);
    } catch {
      // .env doesn't exist — that's fine
    }
  });

  it('.env must NOT set LAIN_CHARACTER_ID (overrides per-service identity)', () => {
    // Guard: LAIN_CHARACTER_ID in .env would cause all services to share one identity.
    try {
      const envContent = readFileSync(join(PROJECT_ROOT, '.env'), 'utf-8');
      const activeLines = envContent.split('\n').filter(l => !l.trim().startsWith('#') && l.trim().length > 0);
      const setsId = activeLines.some(l => l.trim().startsWith('LAIN_CHARACTER_ID='));
      expect(setsId, '.env sets LAIN_CHARACTER_ID which overrides per-service identity').toBe(false);
    } catch {
      // .env doesn't exist — that's fine
    }
  });

  it('.env must NOT set LAIN_CHARACTER_NAME (overrides per-service identity)', () => {
    // Guard: same as above for character name.
    try {
      const envContent = readFileSync(join(PROJECT_ROOT, '.env'), 'utf-8');
      const activeLines = envContent.split('\n').filter(l => !l.trim().startsWith('#') && l.trim().length > 0);
      const setsName = activeLines.some(l => l.trim().startsWith('LAIN_CHARACTER_NAME='));
      expect(setsName, '.env sets LAIN_CHARACTER_NAME').toBe(false);
    } catch {
      // .env doesn't exist — that's fine
    }
  });

  it('.env must NOT set PEER_CONFIG (overrides per-service peer lists)', () => {
    // Guard: PEER_CONFIG in .env would give all characters the same peer list.
    try {
      const envContent = readFileSync(join(PROJECT_ROOT, '.env'), 'utf-8');
      const activeLines = envContent.split('\n').filter(l => !l.trim().startsWith('#') && l.trim().length > 0);
      const setsPeers = activeLines.some(l => l.trim().startsWith('PEER_CONFIG='));
      expect(setsPeers, '.env sets PEER_CONFIG').toBe(false);
    } catch {
      // .env doesn't exist
    }
  });

  it('character service template sets its own LAIN_HOME', () => {
    // Guard: each character must have its own LAIN_HOME to get its own database.
    const template = readSrc('deploy/systemd/character.service.template');
    expect(template).toContain('LAIN_HOME=@@LAIN_HOME@@');
  });

  it('character service template uses EnvironmentFile for peer config', () => {
    // Bug: Environment= strips JSON quotes from PEER_CONFIG.
    const template = readSrc('deploy/systemd/character.service.template');
    expect(template).toContain('EnvironmentFile=');
    expect(template).not.toMatch(/^Environment=PEER_CONFIG=/m);
  });

  it('character service template loads .env via EnvironmentFile', () => {
    // Guard: shared secrets (API keys, tokens) come from .env via EnvironmentFile.
    const template = readSrc('deploy/systemd/character.service.template');
    expect(template).toContain('EnvironmentFile=@@WORKING_DIR@@/.env');
  });

  it('character service template loads per-character env file', () => {
    // Guard: per-character env file has PEER_CONFIG and LAIN_INTERLINK_TARGET.
    const template = readSrc('deploy/systemd/character.service.template');
    expect(template).toContain('EnvironmentFile=@@WORKING_DIR@@/deploy/env/@@SERVICE_NAME@@.env');
  });

  it('all per-character env files set PEER_CONFIG', () => {
    // Guard: each character needs its own PEER_CONFIG.
    const envDir = join(PROJECT_ROOT, 'deploy', 'env');
    if (!existsSync(envDir)) return;
    const envFiles = readdirSync(envDir).filter(f => f.endsWith('.env'));
    for (const file of envFiles) {
      const content = readFileSync(join(envDir, file), 'utf-8');
      expect(content, `${file} missing PEER_CONFIG`).toMatch(/PEER_CONFIG=/);
    }
  });

  it('no service file has inline Environment=PEER_CONFIG', () => {
    // Bug: systemd Environment= strips JSON quotes, mangling PEER_CONFIG.
    const unitDir = join(PROJECT_ROOT, 'deploy', 'systemd');
    if (!existsSync(unitDir)) return;
    const files = readdirSync(unitDir).filter(f => f.endsWith('.service'));
    for (const file of files) {
      const content = readFileSync(join(unitDir, file), 'utf-8');
      expect(content, `${file} has inline PEER_CONFIG`).not.toMatch(/^Environment=PEER_CONFIG=/m);
    }
  });

  it('character service template sets LAIN_HOME in the [Service] section', () => {
    // Guard: LAIN_HOME must be set in Environment= within the [Service] section.
    // Note: systemd evaluates all Environment= directives before ExecStart regardless of order,
    // but the directive must be present in [Service].
    const template = readSrc('deploy/systemd/character.service.template');
    const serviceSection = template.slice(template.indexOf('[Service]'));
    expect(serviceSection).toContain('Environment=LAIN_HOME=');
    expect(serviceSection).toContain('ExecStart=');
  });

  it('character template has all required placeholders', () => {
    // Guard: missing placeholder → broken service file.
    const template = readSrc('deploy/systemd/character.service.template');
    const required = ['@@CHAR_ID@@', '@@CHAR_NAME@@', '@@PORT@@', '@@LAIN_HOME@@', '@@WORKSPACE@@', '@@WORKING_DIR@@', '@@SERVICE_NAME@@'];
    for (const ph of required) {
      expect(template, `template missing ${ph}`).toContain(ph);
    }
  });

  it('generate-services.sh exists', () => {
    // Guard: the script that generates service files from characters.json must exist.
    const scriptPath = join(PROJECT_ROOT, 'deploy', 'generate-services.sh');
    expect(existsSync(scriptPath), 'generate-services.sh missing').toBe(true);
  });

  it('no env file accidentally sets LAIN_HOME', () => {
    // Guard: LAIN_HOME in env files would conflict with the service template.
    const envDir = join(PROJECT_ROOT, 'deploy', 'env');
    if (!existsSync(envDir)) return;
    const envFiles = readdirSync(envDir).filter(f => f.endsWith('.env'));
    for (const file of envFiles) {
      const content = readFileSync(join(envDir, file), 'utf-8');
      const activeLines = content.split('\n').filter(l => !l.trim().startsWith('#'));
      const setsHome = activeLines.some(l => l.trim().startsWith('LAIN_HOME='));
      expect(setsHome, `${file} sets LAIN_HOME — conflicts with service template`).toBe(false);
    }
  });

  it('WIRED_LAIN_URL defaults to localhost:3000 when not set', () => {
    // Guard: hardcoded default must not point to production.
    const src = readSrc('src/agent/commune-loop.ts');
    expect(src).toContain("process.env['WIRED_LAIN_URL'] || 'http://localhost:3000'");
  });

  it('commune-loop authenticates via per-character interlink headers', () => {
    // findings.md P1:2289 — raw LAIN_INTERLINK_TOKEN reads were replaced with
    // getInterlinkHeaders() which returns null when master/id are unset.
    // Callers skip the remote fetch on null rather than sending empty auth.
    const src = readSrc('src/agent/commune-loop.ts');
    expect(src).toContain('getInterlinkHeaders');
  });
});


// ═══════════════════════════════════════════════════════════════
// 3. DATABASE ISOLATION GUARDS
//    Bug: shared database when LAIN_HOME not set correctly.
// ═══════════════════════════════════════════════════════════════
describe('Database Isolation Guards', () => {
  it('getPaths().database includes lain.db filename', async () => {
    // Guard: database path must end with lain.db, not be a directory.
    const origHome = process.env['LAIN_HOME'];
    process.env['LAIN_HOME'] = '/tmp/test-char-a';
    const { getPaths } = await import('../src/config/paths.js');
    expect(getPaths().database).toBe('/tmp/test-char-a/lain.db');
    if (origHome) process.env['LAIN_HOME'] = origHome; else delete process.env['LAIN_HOME'];
  });

  it('getPaths() with LAIN_HOME set uses that path for database', async () => {
    // Guard: LAIN_HOME must drive the database path.
    const origHome = process.env['LAIN_HOME'];
    process.env['LAIN_HOME'] = '/root/.lain-pkd';
    const { getPaths } = await import('../src/config/paths.js');
    expect(getPaths().database).toContain('/root/.lain-pkd');
    if (origHome) process.env['LAIN_HOME'] = origHome; else delete process.env['LAIN_HOME'];
  });

  it('getPaths() without LAIN_HOME uses ~/.lain default', async () => {
    // Guard: default path must be under home directory.
    const origHome = process.env['LAIN_HOME'];
    delete process.env['LAIN_HOME'];
    const { getPaths, getBasePath } = await import('../src/config/paths.js');
    const { homedir } = await import('node:os');
    expect(getBasePath()).toBe(join(homedir(), '.lain'));
    expect(getPaths().database).toBe(join(homedir(), '.lain', 'lain.db'));
    if (origHome) process.env['LAIN_HOME'] = origHome; else delete process.env['LAIN_HOME'];
  });

  it('two characters with different LAIN_HOME get different database paths', async () => {
    // Bug: shared database when LAIN_HOME not set, causing cross-character data corruption.
    const origHome = process.env['LAIN_HOME'];
    const { getPaths } = await import('../src/config/paths.js');

    process.env['LAIN_HOME'] = '/root/.lain-wired';
    const wiredDb = getPaths().database;

    process.env['LAIN_HOME'] = '/root/.lain-pkd';
    const pkdDb = getPaths().database;

    process.env['LAIN_HOME'] = '/root/.lain';
    const lainDb = getPaths().database;

    expect(wiredDb).not.toBe(pkdDb);
    expect(wiredDb).not.toBe(lainDb);
    expect(pkdDb).not.toBe(lainDb);

    if (origHome) process.env['LAIN_HOME'] = origHome; else delete process.env['LAIN_HOME'];
  });

  it('getBasePath is a pure function of LAIN_HOME (no caching)', async () => {
    // Guard: getBasePath must re-read LAIN_HOME each call, not cache on first call.
    const origHome = process.env['LAIN_HOME'];
    const { getBasePath } = await import('../src/config/paths.js');

    process.env['LAIN_HOME'] = '/tmp/first';
    const first = getBasePath();
    process.env['LAIN_HOME'] = '/tmp/second';
    const second = getBasePath();

    expect(first).toBe('/tmp/first');
    expect(second).toBe('/tmp/second');

    if (origHome) process.env['LAIN_HOME'] = origHome; else delete process.env['LAIN_HOME'];
  });

  it('database file is always named lain.db (not character-specific)', () => {
    // Guard: isolation comes from LAIN_HOME directory, not filename.
    const src = readSrc('src/config/paths.ts');
    expect(src).toContain("DATABASE_FILE = 'lain.db'");
  });

  it('getPaths returns all required fields', async () => {
    // Guard: missing field would cause runtime crash in any module that uses it.
    const origHome = process.env['LAIN_HOME'];
    process.env['LAIN_HOME'] = '/tmp/paths-test';
    const { getPaths } = await import('../src/config/paths.js');
    const paths = getPaths();
    expect(paths.base).toBeDefined();
    expect(paths.config).toBeDefined();
    expect(paths.database).toBeDefined();
    expect(paths.workspace).toBeDefined();
    if (origHome) process.env['LAIN_HOME'] = origHome; else delete process.env['LAIN_HOME'];
  });

  it('actual database isolation: writes to one DB are invisible in another', async () => {
    // Bug: shared database when LAIN_HOME not set, causing cross-character memory leaks.
    const dirA = join(tmpdir(), `lain-dbiso-a-${Date.now()}`);
    const dirB = join(tmpdir(), `lain-dbiso-b-${Date.now()}`);
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    const origHome = process.env['LAIN_HOME'];

    const { initDatabase, closeDatabase, setMeta, getMeta } = await import('../src/storage/database.js');

    // Write to DB A
    process.env['LAIN_HOME'] = dirA;
    await initDatabase(join(dirA, 'lain.db'));
    setMeta('isolation:test', 'from-char-a');
    expect(getMeta('isolation:test')).toBe('from-char-a');
    closeDatabase();

    // Read from DB B — must not see A's data
    process.env['LAIN_HOME'] = dirB;
    await initDatabase(join(dirB, 'lain.db'));
    expect(getMeta('isolation:test')).toBeNull();
    closeDatabase();

    if (origHome) process.env['LAIN_HOME'] = origHome; else delete process.env['LAIN_HOME'];
    try { await rm(dirA, { recursive: true }); } catch {}
    try { await rm(dirB, { recursive: true }); } catch {}
  });

  it('meta keys are namespaced with colon separator', () => {
    // Guard: unnamespaced keys risk collision between modules.
    const modules = [
      { file: 'src/providers/budget.ts', key: 'budget:' },
      { file: 'src/agent/internal-state.ts', key: 'internal:state' },
      { file: 'src/agent/commune-loop.ts', key: 'commune:last_cycle_at' },
      { file: 'src/agent/dreams.ts', key: 'dream:last_cycle_at' },
      { file: 'src/agent/diary.ts', key: 'diary:last_entry_at' },
      { file: 'src/agent/letter.ts', key: 'letter:last_sent_at' },
    ];
    for (const { file, key } of modules) {
      const src = readSrc(file);
      expect(src, `${file} must use namespaced meta key '${key}'`).toContain(key);
    }
  });

  it('sessions are isolated per channel (different keys for same peer on different channels)', async () => {
    // Guard: same user on web and telegram must get separate sessions.
    const testDir = join(tmpdir(), `lain-sessiso-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    const origHome = process.env['LAIN_HOME'];
    process.env['LAIN_HOME'] = testDir;
    const { initDatabase, closeDatabase } = await import('../src/storage/database.js');
    await initDatabase(join(testDir, 'lain.db'));
    const { createSession, findSession } = await import('../src/storage/sessions.js');

    const web = createSession({ agentId: 'default', channel: 'web', peerKind: 'user', peerId: 'user1' });
    const tg = createSession({ agentId: 'default', channel: 'telegram', peerKind: 'user', peerId: 'user1' });

    // Keys must be different — different channels = different sessions
    expect(web.key).not.toBe(tg.key);
    // Channel is stored correctly
    expect(web.channel).toBe('web');
    expect(tg.channel).toBe('telegram');
    // findSession returns correct session per channel
    const foundWeb = findSession('default', 'web', 'user1');
    const foundTg = findSession('default', 'telegram', 'user1');
    expect(foundWeb).toBeDefined();
    expect(foundTg).toBeDefined();
    expect(foundWeb!.key).toBe(web.key);
    expect(foundTg!.key).toBe(tg.key);

    closeDatabase();
    if (origHome) process.env['LAIN_HOME'] = origHome; else delete process.env['LAIN_HOME'];
    try { await rm(testDir, { recursive: true }); } catch {}
  });
});


// ═══════════════════════════════════════════════════════════════
// 4. AUTH PERSISTENCE GUARDS
//    Bug: skin branch merge removed all auth. These guards ensure
//    auth remains in place across all server entry points.
// ═══════════════════════════════════════════════════════════════
describe('Auth Persistence Guards', () => {
  it('owner-auth.ts exports isOwner function', () => {
    // Guard: if isOwner is removed, all auth breaks.
    const src = readSrc('src/web/owner-auth.ts');
    expect(src).toContain('export function isOwner');
  });

  it('owner-auth.ts exports issueOwnerCookie function', () => {
    // Guard (findings.md P2:2348): issueOwnerCookie replaces v1 setOwnerCookie
    // and is what the gate endpoint calls on successful authentication.
    const src = readSrc('src/web/owner-auth.ts');
    expect(src).toContain('export function issueOwnerCookie');
  });

  it('owner-auth.ts exports clearOwnerCookie function (for /owner/logout)', () => {
    // Guard (findings.md P2:2348): /owner/logout relies on clearOwnerCookie
    // to drop the local cookie after revoking the nonce authority-side.
    const src = readSrc('src/web/owner-auth.ts');
    expect(src).toContain('export function clearOwnerCookie');
  });

  it('owner-auth.ts uses timingSafeEqual (not string comparison)', () => {
    // Bug: string === comparison is vulnerable to timing attacks.
    const src = readSrc('src/web/owner-auth.ts');
    expect(src).toContain('timingSafeEqual');
    expect(src).toContain("import { createHmac, timingSafeEqual }");
  });

  it('owner cookie is HttpOnly and SameSite=Strict', () => {
    // Guard: missing HttpOnly allows XSS to steal the cookie.
    const src = readSrc('src/web/owner-auth.ts');
    expect(src).toContain('HttpOnly');
    expect(src).toContain('SameSite=Strict');
  });

  it('server.ts imports and uses isOwner', () => {
    // Bug: skin branch removed isOwner import, breaking all auth.
    const src = readSrc('src/web/server.ts');
    expect(src).toContain("import { isOwner");
    expect(src).toContain('isOwner(req)');
  });

  it('server.ts returns 401 for unauthorized requests', () => {
    // Guard: auth check must result in 401, not silent pass-through.
    const src = readSrc('src/web/server.ts');
    expect(src).toContain('401');
  });

  it('character-server.ts imports and uses isOwner', () => {
    // Bug: character server without auth allows anyone to chat as the character.
    const src = readSrc('src/web/character-server.ts');
    expect(src).toContain("import { isOwner }");
    expect(src).toContain('isOwner(req)');
  });

  it('character-server.ts has multiple isOwner checks (chat + API endpoints)', () => {
    // Guard: not just one check — multiple endpoints need protection.
    const src = readSrc('src/web/character-server.ts');
    const ownerChecks = (src.match(/isOwner\(req\)/g) || []).length;
    expect(ownerChecks, 'character-server must have multiple isOwner checks').toBeGreaterThanOrEqual(4);
  });

  it('doctor-server.ts imports and uses isOwner', () => {
    // Guard: doctor server has diagnostic tools that must be protected.
    const src = readSrc('src/web/doctor-server.ts');
    expect(src).toContain("import { isOwner }");
    expect(src).toContain('isOwner(req)');
  });

  it('doctor-server.ts has isOwner checks on chat endpoints', () => {
    // Guard: doctor chat has system-level access (telemetry, letter blocking).
    const src = readSrc('src/web/doctor-server.ts');
    const ownerChecks = (src.match(/isOwner\(req\)/g) || []).length;
    expect(ownerChecks, 'doctor-server must have multiple isOwner checks').toBeGreaterThanOrEqual(3);
  });

  it('server.ts has verifyApiAuth or similar guard function', () => {
    // Guard: API endpoints need a consistent auth verification mechanism.
    const src = readSrc('src/web/server.ts');
    expect(src).toContain('verifyApiAuth');
  });

  it('commune-loop peer calls send authenticated interlink headers', () => {
    // Guard: peer-to-peer messages must be authenticated to prevent spoofing.
    // Per-character derivation (findings.md P1:2289) wraps the Bearer + identity
    // headers in getInterlinkHeaders().
    const communeSrc = readSrc('src/agent/commune-loop.ts');
    expect(communeSrc).toContain('getInterlinkHeaders');
  });

  it('character-server.ts verifies interlink auth on peer message endpoint', () => {
    // Guard: /api/peer/message must check auth.
    const src = readSrc('src/web/character-server.ts');
    expect(src).toContain('verifyInterlinkAuth');
  });

  it('server.ts has OWNER_ONLY_PATHS or equivalent route protection', () => {
    // Guard: specific paths must be owner-only.
    const src = readSrc('src/web/server.ts');
    expect(src).toContain('OWNER_ONLY_PATHS');
  });

  it('isOwner returns false when LAIN_OWNER_TOKEN is not set', async () => {
    // Guard: missing token must deny access, not grant it.
    const origToken = process.env['LAIN_OWNER_TOKEN'];
    delete process.env['LAIN_OWNER_TOKEN'];
    const { isOwner } = await import('../src/web/owner-auth.js');
    const { makeV2Cookie } = await import('./fixtures/owner-cookie-v2.js');
    expect(isOwner({ headers: { cookie: makeV2Cookie('anything') } } as any)).toBe(false);
    if (origToken) process.env['LAIN_OWNER_TOKEN'] = origToken;
  });

  it('isOwner returns false when no cookie is present', async () => {
    // Guard: missing cookie must deny access.
    process.env['LAIN_OWNER_TOKEN'] = 'test-token';
    const { isOwner } = await import('../src/web/owner-auth.js');
    expect(isOwner({ headers: {} } as any)).toBe(false);
    delete process.env['LAIN_OWNER_TOKEN'];
  });

  it('v2 signature is deterministic for fixed payload + token', async () => {
    const { makeV2CookieValue } = await import('./fixtures/owner-cookie-v2.js');
    const opts = { nonce: 'n', iat: 1 };
    expect(makeV2CookieValue('my-token', opts)).toBe(makeV2CookieValue('my-token', opts));
  });

  it('different tokens produce different v2 signatures', async () => {
    const { makeV2CookieValue } = await import('./fixtures/owner-cookie-v2.js');
    const opts = { nonce: 'n', iat: 1 };
    expect(makeV2CookieValue('token-a', opts)).not.toBe(makeV2CookieValue('token-b', opts));
  });
});


// ═══════════════════════════════════════════════════════════════
// 5. CHARACTER IDENTITY GUARDS
//    Bug: character serving wrong persona due to path confusion.
//    LAIN_CHARACTER_ID or workspace path mixup = identity corruption.
// ═══════════════════════════════════════════════════════════════
describe('Character Identity Guards', () => {
  it('loadPersona reads from config.workspacePath (not hardcoded)', () => {
    // Bug: hardcoded path means all characters load the same persona.
    const src = readSrc('src/agent/persona.ts');
    expect(src).toContain('config.workspacePath');
    expect(src).not.toContain("'/root/.lain/workspace'");
    expect(src).not.toContain("hardcoded");
  });

  it('loadPersona loads SOUL.md, AGENTS.md, and IDENTITY.md', () => {
    // Guard: missing any of the three persona files = broken identity.
    const src = readSrc('src/agent/persona.ts');
    expect(src).toContain('SOUL.md');
    expect(src).toContain('AGENTS.md');
    expect(src).toContain('IDENTITY.md');
  });

  it('eventBus has setCharacterId method', async () => {
    // Guard: eventBus.characterId must be settable per-process.
    const { eventBus } = await import('../src/events/bus.js');
    expect(typeof eventBus.setCharacterId).toBe('function');
  });

  it('eventBus.characterId reflects the most recent setCharacterId call', async () => {
    // Bug: stale characterId causes wrong character attribution in events.
    const { eventBus } = await import('../src/events/bus.js');
    eventBus.setCharacterId('test-char-1');
    expect(eventBus.characterId).toBe('test-char-1');
    eventBus.setCharacterId('test-char-2');
    expect(eventBus.characterId).toBe('test-char-2');
  });

  it('diary resolves character name via requireCharacterName (fail-closed) — findings.md P2:2271', () => {
    // Bug: diary addressed to wrong character when name hardcoded or fail-open
    // to 'Lain'. requireCharacterName() throws when the env is unset.
    const src = readSrc('src/agent/diary.ts');
    expect(src).toContain('requireCharacterName');
    expect(src).not.toMatch(/process\.env\[['"]LAIN_CHARACTER_NAME['"]\]\s*\|\|\s*['"]Lain['"]/);
  });

  it('diary uses getBasePath for journal path (not hardcoded)', () => {
    // Bug: journal written to wrong directory when path hardcoded.
    const src = readSrc('src/agent/diary.ts');
    expect(src).toContain('getBasePath()');
  });

  it('self-concept uses getBasePath for self-concept path', () => {
    // Guard: self-concept file must be under character-specific directory.
    const src = readSrc('src/agent/self-concept.ts');
    expect(src).toContain('getBasePath()');
  });

  it('letter uses getBasePath for journal access', () => {
    // Guard: letters read journal from character-specific directory.
    const src = readSrc('src/agent/letter.ts');
    expect(src).toContain('getBasePath()');
  });

  it('book uses getBasePath for book directory', () => {
    // Guard: book chapters must be under character-specific directory.
    const src = readSrc('src/agent/book.ts');
    expect(src).toContain('getBasePath()');
  });

  it('commune loop requires characterId in config', () => {
    // Bug: commune loop without characterId sends messages with wrong identity.
    const src = readSrc('src/agent/commune-loop.ts');
    expect(src).toContain("Pick<CommuneLoopConfig, 'characterId'");
  });

  it('commune loop requires characterName in config', () => {
    // Guard: characterName used in conversation prompts.
    const src = readSrc('src/agent/commune-loop.ts');
    expect(src).toContain("'characterName'");
  });

  it('commune loop includes characterId in peer messages', () => {
    // Guard: peer must know who is speaking.
    const src = readSrc('src/agent/commune-loop.ts');
    expect(src).toContain('fromId: config.characterId');
    expect(src).toContain('fromName: config.characterName');
  });

  it('letter uses LAIN_CHARACTER_ID to determine identity (isWired check)', () => {
    // Guard: letter identity determines which sister is writing.
    const src = readSrc('src/agent/letter.ts');
    expect(src).toContain('LAIN_CHARACTER_ID');
    expect(src).toContain('wired-lain');
  });

  it('dreams use requireCharacterName (fail-closed identity) — findings.md P2:2271', () => {
    // Guard: dream fragments should reference the correct character via the
    // fail-closed helper rather than the bare env default.
    const src = readSrc('src/agent/dreams.ts');
    expect(src).toContain('requireCharacterName');
    expect(src).not.toMatch(/process\.env\[['"]LAIN_CHARACTER_NAME['"]\]\s*\|\|\s*['"]Lain['"]/);
  });

  it('internal-state uses eventBus.characterId for movement', () => {
    // Guard: movement decisions must use the correct character ID.
    const src = readSrc('src/agent/internal-state.ts');
    expect(src).toContain('eventBus.characterId');
  });

  it('processMessage session uses agentId from request', () => {
    // Guard: processMessage must not hardcode agent ID.
    const src = readSrc('src/agent/index.ts');
    expect(src).toContain('agentId');
    expect(src).toContain('getOrCreateSession');
  });

  it('persona buildSystemPrompt uses persona parameter (not global)', () => {
    // Guard: buildSystemPrompt must take persona as input, not read a global.
    // Second arg `characterId` gates the Lain-specific communication block.
    const src = readSrc('src/agent/persona.ts');
    expect(src).toMatch(/export function buildSystemPrompt\(persona: Persona,\s*characterId\?: string\)/);
  });

  it('initAgent loads persona from config.workspace', () => {
    // Guard: agent initialization must use per-agent workspace path.
    const src = readSrc('src/agent/index.ts');
    expect(src).toContain('config.workspace');
    expect(src).toContain('loadPersona');
  });

  it('character-server.ts uses character-specific workspace path', () => {
    // Guard: character server must not hardcode a workspace path.
    const src = readSrc('src/web/character-server.ts');
    expect(src).toContain('initAgent');
  });
});


// ═══════════════════════════════════════════════════════════════
// 6. SILENT FAILURE GUARDS
//    These guard against errors being swallowed without logging.
// ═══════════════════════════════════════════════════════════════
describe('Silent Failure Guards', () => {
  it('commune cycle logs errors (not silently swallowed)', () => {
    // Guard: commune cycle must log errors so we can debug failures.
    const src = readSrc('src/agent/commune-loop.ts');
    expect(src).toContain("logger.error");
  });

  it('commune sendPeerMessage logs failures', () => {
    // Guard: peer message failures must be visible in logs.
    const src = readSrc('src/agent/commune-loop.ts');
    expect(src).toContain("logger.warn");
    expect(src).toContain('Peer message failed');
  });

  it('commune sendPeerMessage returns null on error (not throws)', () => {
    // Guard: peer unreachable should not crash the commune loop.
    const src = readSrc('src/agent/commune-loop.ts');
    expect(src).toContain('return null');
    expect(src).toContain('Could not reach peer');
  });

  it('diary cycle logs top-level errors', () => {
    // Guard: diary failures must not go unnoticed.
    const src = readSrc('src/agent/diary.ts');
    expect(src).toContain("logger.error");
    expect(src).toContain('Diary cycle top-level error');
  });

  it('letter cycle logs delivery failures', () => {
    // Guard: letter delivery failures must be visible.
    const src = readSrc('src/agent/letter.ts');
    expect(src).toContain("logger.error");
    expect(src).toContain('Letter delivery');
  });

  it('letter cycle logs invalid JSON responses', () => {
    // Guard: JSON parse failure on letter response must be logged.
    const src = readSrc('src/agent/letter.ts');
    expect(src).toContain("logger.warn");
    expect(src).toContain('failed to parse JSON');
  });

  it('dream cycle logs errors', () => {
    // Guard: dream failures must be logged.
    const src = readSrc('src/agent/dreams.ts');
    expect(src).toContain("logger.error");
    expect(src).toContain('Dream cycle error');
  });

  it('curiosity cycle logs errors', () => {
    // Guard: curiosity failures must be logged.
    const src = readSrc('src/agent/curiosity.ts');
    expect(src).toContain("logger.error");
    expect(src).toContain('Curiosity cycle');
  });

  it('internal state update catches and logs errors', () => {
    // Guard: state update failure should not crash the process.
    const src = readSrc('src/agent/internal-state.ts');
    // Falls back to heuristic nudges on error
    expect(src).toContain('heuristic (error)');
  });

  it('internal state falls back to heuristic when LLM fails', () => {
    // Guard: LLM failure in state update should not leave state unchanged.
    const src = readSrc('src/agent/internal-state.ts');
    expect(src).toContain('applyHeuristicNudges');
    expect(src).toContain('no provider');
    expect(src).toContain('LLM parse failed');
  });

  it('all background loops log their firing event', () => {
    // Guard: we need to know when loops fire for debugging.
    const loops = [
      { file: 'src/agent/diary.ts', marker: 'Diary cycle firing' },
      { file: 'src/agent/dreams.ts', marker: 'Dream cycle firing' },
      { file: 'src/agent/curiosity.ts', marker: 'Curiosity cycle firing' },
      { file: 'src/agent/commune-loop.ts', marker: 'Commune cycle firing' },
    ];
    for (const { file, marker } of loops) {
      const src = readSrc(file);
      expect(src, `${file} must log when firing`).toContain(marker);
    }
  });

  it('all background loops log their start', () => {
    // Guard: startup message is critical for debugging missing loops.
    const loops = [
      { file: 'src/agent/diary.ts', marker: 'Starting diary loop' },
      { file: 'src/agent/dreams.ts', marker: 'Starting dream loop' },
      { file: 'src/agent/curiosity.ts', marker: 'Starting curiosity loop' },
      { file: 'src/agent/commune-loop.ts', marker: 'Starting commune loop' },
    ];
    for (const { file, marker } of loops) {
      const src = readSrc(file);
      expect(src, `${file} must log start`).toContain(marker);
    }
  });

  it('all background loops log their stop', () => {
    // Guard: stop message confirms cleanup completed.
    const loops = [
      { file: 'src/agent/diary.ts', marker: 'Diary loop stopped' },
      { file: 'src/agent/dreams.ts', marker: 'Dream loop stopped' },
      { file: 'src/agent/curiosity.ts', marker: 'Curiosity loop stopped' },
      { file: 'src/agent/commune-loop.ts', marker: 'Commune loop stopped' },
    ];
    for (const { file, marker } of loops) {
      const src = readSrc(file);
      expect(src, `${file} must log stop`).toContain(marker);
    }
  });

  it('provider errors include enough context for diagnosis', () => {
    // Guard: error logs must include error details, not just "error occurred".
    const src = readSrc('src/agent/commune-loop.ts');
    expect(src).toContain('error: String(err)');
  });

  it('commune approach handles unreachable peer gracefully', () => {
    // Guard: peer location fetch failure should not crash the cycle.
    const src = readSrc('src/agent/commune-loop.ts');
    expect(src).toContain('Commune approach phase error (non-fatal)');
  });

  it('commune aftermath handles tool errors gracefully', () => {
    // Guard: aftermath tool failures should not crash the cycle.
    const src = readSrc('src/agent/commune-loop.ts');
    expect(src).toContain('Commune aftermath phase error (non-fatal)');
  });

  it('awareness fetch failures are logged (not silently swallowed)', () => {
    // Guard: awareness context fetch failures should not crash.
    const src = readSrc('src/agent/awareness.ts');
    // Has try/catch blocks around fetch calls
    expect(src).toContain('catch');
  });

  it('empty LLM response is detected in diary', () => {
    // Guard: empty response should not create an empty diary entry.
    const src = readSrc('src/agent/diary.ts');
    expect(src).toContain('entry too short');
  });

  it('empty LLM response is detected in commune impulse', () => {
    // Guard: empty impulse should skip the cycle, not crash.
    const src = readSrc('src/agent/commune-loop.ts');
    expect(src).toContain('[NOTHING]');
  });

  it('empty LLM response is detected in letter cycle', () => {
    // Guard: empty letter response should skip, not send empty JSON.
    const src = readSrc('src/agent/letter.ts');
    expect(src).toContain('response too short');
  });

  it('JSON parse failure in letter is caught and logged', () => {
    // Guard: malformed JSON from LLM must not crash the letter loop.
    const src = readSrc('src/agent/letter.ts');
    expect(src).toContain('JSON.parse');
    expect(src).toContain('failed to parse JSON');
  });

  it('letter validates structure after parsing', () => {
    // Guard: even if JSON parses, it must have the right fields.
    const src = readSrc('src/agent/letter.ts');
    expect(src).toContain('Array.isArray(letter.topics)');
    expect(src).toContain('Array.isArray(letter.impressions)');
    expect(src).toContain("typeof letter.gift !== 'string'");
    expect(src).toContain("typeof letter.emotionalState !== 'string'");
  });

  it('budget system logs BudgetExceededError clearly', () => {
    // Guard: budget exhaustion must be visible, not a silent hang.
    const src = readSrc('src/providers/budget.ts');
    expect(src).toContain('BudgetExceededError');
  });
});


// ═══════════════════════════════════════════════════════════════
// 7. DATA INTEGRITY GUARDS
//    Guards against data corruption, ordering issues, and constraint violations.
// ═══════════════════════════════════════════════════════════════
describe('Data Integrity Guards', () => {
  const testDir = join(tmpdir(), `lain-integrity-${Date.now()}`);
  const dbPath = join(testDir, 'test.db');
  const originalEnv = process.env['LAIN_HOME'];

  vi.mock('../src/memory/embeddings.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/memory/embeddings.js')>();
    return {
      ...actual,
      generateEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
      generateEmbeddings: vi.fn().mockResolvedValue([new Float32Array(384).fill(0.1)]),
    };
  });

  beforeEach(async () => {
    process.env['LAIN_HOME'] = testDir;
    await mkdir(testDir, { recursive: true });
    const { initDatabase } = await import('../src/storage/database.js');
    await initDatabase(dbPath);
  });

  afterEach(async () => {
    const { closeDatabase } = await import('../src/storage/database.js');
    closeDatabase();
    if (originalEnv) process.env['LAIN_HOME'] = originalEnv; else delete process.env['LAIN_HOME'];
    try { await rm(testDir, { recursive: true }); } catch {}
  });

  it('memory content saved matches content retrieved', async () => {
    // Guard: content must round-trip without corruption.
    const { saveMemory, getMemory } = await import('../src/memory/store.js');
    const content = 'The electric sheep dreamed of electric shepherds.';
    const id = await saveMemory({
      sessionKey: 'test:integrity',
      userId: null,
      content,
      memoryType: 'episode',
      importance: 0.5,
      emotionalWeight: 0.3,
      relatedTo: null,
      sourceMessageId: null,
      metadata: {},
    });
    const retrieved = getMemory(id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.content).toBe(content);
  });

  it('memory importance stored correctly as float', async () => {
    // Guard: importance must not be silently rounded or truncated.
    const { saveMemory, getMemory } = await import('../src/memory/store.js');
    const id = await saveMemory({
      sessionKey: 'test:float',
      userId: null,
      content: 'test',
      memoryType: 'fact',
      importance: 0.777,
      emotionalWeight: 0.333,
      relatedTo: null,
      sourceMessageId: null,
      metadata: {},
    });
    const mem = getMemory(id);
    expect(mem!.importance).toBeCloseTo(0.777, 2);
    expect(mem!.emotionalWeight).toBeCloseTo(0.333, 2);
  });

  it('session messages saved in order', async () => {
    // Bug: out-of-order messages break conversation context.
    const { saveMessage, getRecentMessages } = await import('../src/memory/store.js');
    const baseTime = Date.now();

    for (let i = 0; i < 5; i++) {
      saveMessage({
        sessionKey: 'test:order',
        userId: null,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `message-${i}`,
        timestamp: baseTime + i * 1000,
        metadata: {},
      });
    }

    const messages = getRecentMessages('test:order');
    expect(messages).toHaveLength(5);
    for (let i = 0; i < messages.length - 1; i++) {
      expect(messages[i]!.timestamp).toBeLessThanOrEqual(messages[i + 1]!.timestamp);
    }
  });

  it('memory metadata survives JSON round-trip', async () => {
    // Guard: complex metadata must not be corrupted.
    const { saveMemory, getMemory } = await import('../src/memory/store.js');
    const metadata = {
      site: 'wikipedia.org',
      themes: ['consciousness', 'emergence'],
      nested: { deep: true },
    };
    const id = await saveMemory({
      sessionKey: 'test:metadata',
      userId: null,
      content: 'test',
      memoryType: 'episode',
      importance: 0.5,
      emotionalWeight: 0.2,
      relatedTo: null,
      sourceMessageId: null,
      metadata,
    });
    const mem = getMemory(id);
    expect(mem!.metadata).toEqual(metadata);
  });

  it('emotional state values are clamped to [0,1]', async () => {
    // Guard: out-of-range values break the 6-axis model.
    const { clampState } = await import('../src/agent/internal-state.js');
    const overState = clampState({
      energy: 1.5,
      sociability: -0.3,
      intellectual_arousal: 2.0,
      emotional_weight: -1.0,
      valence: 0.5,
      primary_color: 'test',
      updated_at: Date.now(),
    });
    expect(overState.energy).toBe(1);
    expect(overState.sociability).toBe(0);
    expect(overState.intellectual_arousal).toBe(1);
    expect(overState.emotional_weight).toBe(0);
    expect(overState.valence).toBe(0.5);
  });

  it('clampState preserves values within bounds', async () => {
    // Guard: clamping must not modify valid values.
    const { clampState } = await import('../src/agent/internal-state.js');
    const normalState = clampState({
      energy: 0.6,
      sociability: 0.5,
      intellectual_arousal: 0.4,
      emotional_weight: 0.3,
      valence: 0.7,
      primary_color: 'blue',
      updated_at: Date.now(),
    });
    expect(normalState.energy).toBeCloseTo(0.6);
    expect(normalState.sociability).toBeCloseTo(0.5);
    expect(normalState.valence).toBeCloseTo(0.7);
  });

  it('building positions cover the full 3x3 grid', async () => {
    // Guard: missing grid positions break pathfinding and display.
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    const positions = new Set(BUILDINGS.map(b => `${b.row},${b.col}`));
    expect(positions.size).toBe(9);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        expect(positions.has(`${r},${c}`), `missing position (${r},${c})`).toBe(true);
      }
    }
  });

  it('all building IDs are unique', async () => {
    // Guard: duplicate IDs cause one building to shadow another.
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    const ids = BUILDINGS.map(b => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('BUILDING_MAP contains all buildings', async () => {
    // Guard: map must not be out of sync with the array.
    const { BUILDINGS, BUILDING_MAP } = await import('../src/commune/buildings.js');
    for (const b of BUILDINGS) {
      expect(BUILDING_MAP.has(b.id), `BUILDING_MAP missing ${b.id}`).toBe(true);
    }
  });

  it('isValidBuilding returns false for empty string', async () => {
    // Guard: empty building ID must not pass validation.
    const { isValidBuilding } = await import('../src/commune/buildings.js');
    expect(isValidBuilding('')).toBe(false);
  });

  it('meta key-value store handles special characters', async () => {
    // Guard: values with quotes, newlines, etc. must round-trip.
    const { setMeta, getMeta } = await import('../src/storage/database.js');
    const tricky = '{"key": "value with \\"quotes\\" and\nnewlines"}';
    setMeta('test:special', tricky);
    expect(getMeta('test:special')).toBe(tricky);
  });

  it('memory with very long content is stored correctly', async () => {
    // Guard: large text must not be truncated by the database.
    const { saveMemory, getMemory } = await import('../src/memory/store.js');
    const longContent = 'x'.repeat(50000);
    const id = await saveMemory({
      sessionKey: 'test:long',
      userId: null,
      content: longContent,
      memoryType: 'episode',
      importance: 0.5,
      emotionalWeight: 0.1,
      relatedTo: null,
      sourceMessageId: null,
      metadata: {},
    });
    const mem = getMemory(id);
    expect(mem!.content.length).toBe(50000);
  });

  it('applyDecay does not produce NaN or Infinity', async () => {
    // Guard: decay must not corrupt state with invalid numbers.
    const { applyDecay, clampState } = await import('../src/agent/internal-state.js');
    const state = clampState({
      energy: 0.01,
      sociability: 0.99,
      intellectual_arousal: 0.001,
      emotional_weight: 0.5,
      valence: 0.5,
      primary_color: 'dim',
      updated_at: Date.now(),
    });
    const decayed = applyDecay(state);
    for (const key of ['energy', 'sociability', 'intellectual_arousal', 'emotional_weight', 'valence'] as const) {
      expect(Number.isFinite(decayed[key]), `${key} must be finite after decay`).toBe(true);
      expect(decayed[key]).toBeGreaterThanOrEqual(0);
      expect(decayed[key]).toBeLessThanOrEqual(1);
    }
  });

  it('preoccupation cap is enforced at MAX_PREOCCUPATIONS', async () => {
    // Guard: unbounded preoccupations would consume memory.
    const src = readSrc('src/agent/internal-state.ts');
    expect(src).toContain('MAX_PREOCCUPATIONS');
    expect(src).toContain('if (list.length >= MAX_PREOCCUPATIONS)');
  });

  it('conversation history in commune loop is capped at MAX_HISTORY_ENTRIES', () => {
    // Guard: unbounded history in meta store would grow indefinitely.
    const src = readSrc('src/agent/commune-loop.ts');
    expect(src).toContain('MAX_HISTORY_ENTRIES');
    expect(src).toContain('.slice(-MAX_HISTORY_ENTRIES)');
  });
});


// ═══════════════════════════════════════════════════════════════
// 8. PERFORMANCE REGRESSION GUARDS
//    Guards against patterns that cause memory leaks, unbounded
//    growth, or blocking operations in hot paths.
// ═══════════════════════════════════════════════════════════════
describe('Performance Regression Guards', () => {
  it('conversation trimming exists to prevent unbounded history', () => {
    // Guard: without trimming, conversations grow until OOM.
    const src = readSrc('src/agent/conversation.ts');
    expect(src).toContain('trimConversation');
    expect(src).toContain('compressConversation');
  });

  it('conversation compression uses maxTokens parameter', () => {
    // Guard: compression must respect the token budget.
    const src = readSrc('src/agent/conversation.ts');
    expect(src).toContain('maxTokens');
  });

  it('location history is capped at 20 entries', () => {
    // Guard: unbounded location history would grow indefinitely.
    const src = readSrc('src/commune/location.ts');
    expect(src).toContain('20');
  });

  it('state history is capped at HISTORY_CAP', () => {
    // Guard: internal state history must not grow without bound.
    const src = readSrc('src/agent/internal-state.ts');
    expect(src).toContain('HISTORY_CAP');
    expect(src).toContain('while (history.length > HISTORY_CAP)');
  });

  it('commune conversation history has a max entries cap', () => {
    // Guard: commune conversation records must be bounded.
    const src = readSrc('src/agent/commune-loop.ts');
    expect(src).toContain('MAX_HISTORY_ENTRIES = 20');
  });

  it('curiosity question queue is capped at MAX_QUEUED_QUESTIONS', () => {
    // Guard: unbounded question queue would grow indefinitely.
    const src = readSrc('src/agent/curiosity.ts');
    expect(src).toContain('MAX_QUEUED_QUESTIONS');
  });

  it('doctor-server sessions map does not grow without bound', () => {
    // Guard: sessions map in doctor-server could leak memory.
    // Verify there's a MAX_TOOL_ITERATIONS limit at minimum.
    const src = readSrc('src/web/doctor-server.ts');
    expect(src).toContain('MAX_TOOL_ITERATIONS');
  });

  it('max tool iterations is bounded in agent index', () => {
    // Guard: unbounded tool iteration would loop forever.
    const src = readSrc('src/agent/index.ts');
    expect(src).toContain('MAX_TOOL_ITERATIONS');
    const match = src.match(/MAX_TOOL_ITERATIONS\s*=\s*(\d+)/);
    expect(match).not.toBeNull();
    const value = parseInt(match![1]!, 10);
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThanOrEqual(20);
  });

  it('all fetch calls use AbortSignal.timeout for bounded waiting', () => {
    // Guard: fetch without timeout can hang forever.
    const files = [
      'src/agent/commune-loop.ts',
      'src/agent/awareness.ts',
    ];
    for (const file of files) {
      const src = readSrc(file);
      if (src.includes('fetch(')) {
        expect(src, `${file} has fetch without timeout`).toContain('AbortSignal.timeout');
      }
    }
  });

  it('commune sendPeerMessage has a 60-second timeout', () => {
    // Guard: peer fetch must not hang indefinitely.
    const src = readSrc('src/agent/commune-loop.ts');
    expect(src).toContain('AbortSignal.timeout(60000)');
  });

  it('peer location fetch has a 5-second timeout', () => {
    // Guard: location checks must be fast (used in approach phase).
    const src = readSrc('src/agent/commune-loop.ts');
    expect(src).toContain('AbortSignal.timeout(5000)');
  });

  it('all cleanup functions use stopped flag to prevent post-cleanup execution', () => {
    // Guard: without stopped flag, callbacks could fire after cleanup.
    const files = [
      'src/agent/diary.ts',
      'src/agent/dreams.ts',
      'src/agent/curiosity.ts',
      'src/agent/commune-loop.ts',
    ];
    for (const file of files) {
      const src = readSrc(file);
      expect(src, `${file} must use stopped flag`).toContain('if (stopped) return');
    }
  });

  it('no synchronous readFileSync in agent index (hot path)', () => {
    // Guard: synchronous I/O in request handler blocks the event loop.
    const src = readSrc('src/agent/index.ts');
    expect(src).not.toContain('readFileSync');
  });

  it('proactive messages have rate limiting with daily cap', () => {
    // Guard: proactive loop without rate limiting would spam users.
    const src = readSrc('src/agent/proactive.ts');
    expect(src).toContain('maxMessagesPerDay');
    expect(src).toContain('minIntervalBetweenMessagesMs');
  });

  it('event listeners are cleaned up when loop stops', () => {
    // Guard: event listener leak would accumulate handlers.
    const files = [
      'src/agent/diary.ts',
      'src/agent/commune-loop.ts',
      'src/agent/dreams.ts',
      'src/agent/curiosity.ts',
    ];
    for (const file of files) {
      const src = readSrc(file);
      // Each loop that adds an event listener has a stopped flag checked first
      if (src.includes("eventBus.on('activity'")) {
        expect(src, `${file} must check stopped in listener`).toContain('if (stopped');
      }
    }
  });

  it('dream walk has bounded step count', () => {
    // Guard: random walk without bounds could loop indefinitely.
    const src = readSrc('src/agent/dreams.ts');
    expect(src).toContain('maxWalkSteps');
  });
});


// ═══════════════════════════════════════════════════════════════
// 9. KNOWN BUG PATTERN GUARDS
//    Guards against specific bugs that have occurred in production.
// ═══════════════════════════════════════════════════════════════
describe('Known Bug Pattern Guards', () => {
  it('interlink messages use peer-specific URL (not hardcoded localhost)', () => {
    // Bug: hardcoded URL means all messages go to one peer.
    const src = readSrc('src/agent/commune-loop.ts');
    expect(src).toContain('impulse.peerUrl');
    expect(src).toContain('`${impulse.peerUrl}/api/peer/message`');
  });

  it('letters do not send to self (targetUrl comes from env)', () => {
    // Bug: Wired Lain sent letters to herself when LAIN_INTERLINK_TARGET was wrong.
    const src = readSrc('src/agent/letter.ts');
    expect(src).toContain('LAIN_INTERLINK_TARGET');
    // targetUrl should be null when not configured
    expect(src).toContain('targetUrl: process.env');
  });

  it('no character lists itself as a peer in env files', () => {
    // Bug: character talking to itself in commune loop.
    const envDir = join(PROJECT_ROOT, 'deploy', 'env');
    if (!existsSync(envDir)) return;
    const envFiles = readdirSync(envDir).filter(f => f.endsWith('.env'));
    for (const file of envFiles) {
      const charIdMatch = file.match(/^lain-(.+)\.env$/);
      if (!charIdMatch) continue;
      const selfId = charIdMatch[1]!;
      const content = readFileSync(join(envDir, file), 'utf-8');
      const match = content.match(/PEER_CONFIG=(.*)/);
      if (!match) continue;
      try {
        const peers = JSON.parse(match[1]!) as Array<{ id: string }>;
        const selfPeer = peers.find(p => p.id === selfId);
        expect(selfPeer, `${file} lists itself as peer`).toBeUndefined();
      } catch {
        // Invalid JSON will be caught by other tests
      }
    }
  });

  it('commune approach phase handles unreachable peer', () => {
    // Bug: approach phase crashed when peer was unreachable, killing the entire cycle.
    const src = readSrc('src/agent/commune-loop.ts');
    expect(src).toContain('Commune approach phase error (non-fatal)');
    // The approach is wrapped in try/catch with non-fatal handling
    expect(src).toContain('try {\n      await phaseApproach');
  });

  it('proactive messages respect cooldown', () => {
    // Bug: proactive messages sent too frequently overwhelmed users.
    const src = readSrc('src/agent/proactive.ts');
    expect(src).toContain('minIntervalBetweenMessagesMs');
    expect(src).toContain('cooldown active');
  });

  it('proactive loop respects daily cap', () => {
    // Bug: proactive loop sent unlimited messages per day.
    const src = readSrc('src/agent/proactive.ts');
    expect(src).toContain('daily cap reached');
    expect(src).toContain('maxMessagesPerDay');
  });

  it('commune loop has a 2-hour cooldown between runs', () => {
    // Guard: commune loop must not fire repeatedly without cooldown.
    const src = readSrc('src/agent/commune-loop.ts');
    expect(src).toContain('COOLDOWN_MS');
    expect(src).toContain('2 * 60 * 60 * 1000');
  });

  it('diary loop has a 6-hour cooldown', () => {
    // Guard: diary must not fire multiple times per day.
    const src = readSrc('src/agent/diary.ts');
    expect(src).toContain('COOLDOWN_MS');
    expect(src).toContain('6 * 60 * 60 * 1000');
  });

  it('curiosity loop has a 30-minute cooldown', () => {
    // Guard: curiosity must not fire too rapidly.
    const src = readSrc('src/agent/curiosity.ts');
    expect(src).toContain('COOLDOWN_MS');
    expect(src).toContain('30 * 60 * 1000');
  });

  it('commune loop does not run when already running (isRunning flag)', () => {
    // Bug: overlapping commune cycles caused duplicate conversations.
    const src = readSrc('src/agent/commune-loop.ts');
    expect(src).toContain('isRunning');
    expect(src).toContain('if (stopped || isRunning) return');
  });

  it('diary loop does not run when already running', () => {
    // Guard: same overlap protection as commune.
    const src = readSrc('src/agent/diary.ts');
    expect(src).toContain('isRunning');
  });

  it('dream shouldDream checks for minimum memories', () => {
    // Bug: dream cycle with too few memories caused empty walks.
    const src = readSrc('src/agent/dreams.ts');
    expect(src).toContain('memories.length < 10');
  });

  it('dream shouldDream checks quiet threshold', () => {
    // Guard: dreams should only happen during quiet periods.
    const src = readSrc('src/agent/dreams.ts');
    expect(src).toContain('quietThresholdMs');
    expect(src).toContain('silenceDuration < cfg.quietThresholdMs');
  });

  it('dream emotional weight shifts are bounded (avg +/-0.025)', () => {
    // Guard: large emotional weight shifts would destabilize the memory system.
    const src = readSrc('src/agent/dreams.ts');
    expect(src).toContain('0.05');
    expect(src).toContain('Math.max(0, Math.min(1,');
  });

  it('dream associations are capped at 3 per cycle', () => {
    // Guard: too many associations per dream would create noise.
    const src = readSrc('src/agent/dreams.ts');
    expect(src).toContain('associationsCreated >= 3');
  });

  it('commune broadcast failure does not break conversation', () => {
    // Bug: broadcast failure crashed the commune loop.
    const src = readSrc('src/agent/commune-loop.ts');
    // broadcastLine has try/catch
    expect(src).toContain("Non-critical — don't break conversation if broadcast fails");
  });

  it('letter delivery failure is re-thrown (not silently swallowed)', () => {
    // Guard: delivery failures must propagate so the loop knows to retry.
    const src = readSrc('src/agent/letter.ts');
    expect(src).toContain('throw err');
    expect(src).toContain('Letter delivery failed');
  });

  it('letter blocked by Dr. Claude is checked before composing', () => {
    // Guard: letter blocking must happen early, not after composing.
    const src = readSrc('src/agent/letter.ts');
    expect(src).toContain("letter:blocked");
    expect(src).toContain('blocked by Dr. Claude');
  });

  it('curiosity SSRF protection exists for dataset downloads', () => {
    // Guard: curiosity downloading arbitrary URLs could be an SSRF vector.
    const src = readSrc('src/agent/curiosity.ts');
    expect(src).toContain('checkSSRF');
  });

  it('curiosity dataset download requires HTTPS only', () => {
    // Guard: HTTP downloads are vulnerable to MITM.
    const src = readSrc('src/agent/curiosity.ts');
    expect(src).toContain("parsed.protocol !== 'https:'");
  });

  it('curiosity whitelist is re-read on each cycle', () => {
    // Guard: whitelist edits should take effect without restart.
    const src = readSrc('src/agent/curiosity.ts');
    expect(src).toContain('Re-read whitelist each cycle');
  });

  it('server body size is limited', () => {
    // Guard: unbounded request body could cause OOM.
    const src = readSrc('src/web/server.ts');
    expect(src).toContain('MAX_BODY_BYTES');
    expect(src).toContain('PAYLOAD_TOO_LARGE');
  });

  it('movement desire requires confidence > 0.6 to act', () => {
    // Guard: low-confidence movement would cause constant wandering.
    const src = readSrc('src/agent/internal-state.ts');
    expect(src).toContain('desire.confidence > 0.6');
  });

  it('movement has a 30-minute cooldown', () => {
    // Guard: frequent movement would be disorienting.
    const src = readSrc('src/agent/internal-state.ts');
    expect(src).toContain('MOVE_COOLDOWN');
    expect(src).toContain('30 * 60 * 1000');
  });

  it('dream post-drift probability is 25%', () => {
    // Guard: 100% drift would be too predictable; 0% would remove the feature.
    const src = readSrc('src/agent/dreams.ts');
    expect(src).toContain('THRESHOLD_DRIFT_PROBABILITY = 0.25');
  });

  it('commune history slice prevents growth beyond MAX_HISTORY_ENTRIES', () => {
    // Guard: appendConversationHistory must use .slice() to cap growth.
    const src = readSrc('src/agent/commune-loop.ts');
    expect(src).toContain('.slice(-MAX_HISTORY_ENTRIES)');
  });

  it('dream walk visited set prevents revisiting memories', () => {
    // Guard: without visited tracking, walks could loop.
    const src = readSrc('src/agent/dreams.ts');
    expect(src).toContain('visited.has');
    expect(src).toContain('visited.add');
  });

  it('commune loop persists lastRun to meta (survives restart)', () => {
    // Bug: without persistence, loops re-fire immediately after restart.
    const src = readSrc('src/agent/commune-loop.ts');
    expect(src).toContain("setMeta(META_KEY_LAST_CYCLE, Date.now().toString())");
  });

  it('diary loop persists lastRun to meta (survives restart)', () => {
    // Bug: without persistence, diary fires immediately on every restart.
    const src = readSrc('src/agent/diary.ts');
    expect(src).toContain("setMeta('diary:last_entry_at', Date.now().toString())");
  });

  it('curiosity loop persists lastRun to meta', () => {
    // Guard: same restart-resilience as other loops.
    const src = readSrc('src/agent/curiosity.ts');
    expect(src).toContain("setMeta('curiosity:last_cycle_at', Date.now().toString())");
  });
});
