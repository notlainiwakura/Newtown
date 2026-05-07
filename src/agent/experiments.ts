/**
 * Autonomous experiment loop for Wired Lain
 * Inspired by Karpathy's autoresearch — formulates hypotheses from
 * curiosity/research, writes Python code, executes in a sandbox,
 * analyzes results, and iterates.
 *
 * CPU-only, 5-minute execution timeout, restricted imports.
 */

import { spawn } from 'node:child_process';
import { appendFile, chmod, mkdir, writeFile, rm, readdir, copyFile, stat } from 'node:fs/promises';
import { writeFileAtomic } from '../utils/atomic-write.js';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { getProvider } from './index.js';
import { searchMemories, saveMemory } from '../memory/store.js';
import { getLogger } from '../utils/logger.js';
import { getMeta, setMeta } from '../storage/database.js';
import { eventBus } from '../events/bus.js';
import { getBasePath } from '../config/paths.js';
import { getCharacterDatabases, getInhabitants, getAllCharacters } from '../config/characters.js';
import { getInterlinkHeaders } from '../security/interlink-auth.js';
import { getLabeledSection, parseLabeledSections } from '../utils/structured-output.js';
import {
  ensureDataWorkspace,
  getDataWorkspacePath,
  getDataWorkspaceSize,
  listDataFiles,
  sanitizeDataFileName,
  ALLOWED_DATA_EXTENSIONS,
  MAX_DATA_DIR_BYTES,
  MAX_SINGLE_FILE_BYTES,
} from './data-workspace.js';

const EXPERIMENT_LOG_FILE = join(process.cwd(), 'logs', 'experiments-debug.log');

async function experimentLog(context: string, data: unknown): Promise<void> {
  try {
    await mkdir(join(process.cwd(), 'logs'), { recursive: true });
    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] [${context}] ${JSON.stringify(data, null, 2)}\n${'='.repeat(80)}\n`;
    await appendFile(EXPERIMENT_LOG_FILE, entry);
  } catch {
    // Ignore logging errors
  }
}

// ── Monthly budget tracking ───────────────────────────────────

function getBudgetKey(): string {
  return `experiment:budget:${new Date().toISOString().slice(0, 7)}`; // YYYY-MM
}

function getMonthlySpendUsd(): number {
  try {
    const raw = getMeta(getBudgetKey());
    if (!raw) return 0;
    return parseFloat(raw);
  } catch {
    return 0;
  }
}

function addSpend(inputTokens: number, outputTokens: number): number {
  const cost =
    (inputTokens / 1_000_000) * INPUT_COST_PER_M +
    (outputTokens / 1_000_000) * OUTPUT_COST_PER_M;
  const key = getBudgetKey();
  const current = getMonthlySpendUsd();
  const updated = current + cost;
  setMeta(key, updated.toFixed(6));
  return updated;
}

function isBudgetExhausted(monthlyBudgetUsd: number): boolean {
  return getMonthlySpendUsd() >= monthlyBudgetUsd;
}

// ── Experiment diary ──────────────────────────────────────────

// findings.md P2:2251 — the diary format (line `**Date:** YYYY-MM-DD
// HH:MM:SS UTC`) is both the writer's responsibility here and the
// book-loop's incremental parser target. When the two drifted, every
// entry was treated as new and INCORPORATE re-ran across the entire
// diary every cycle, silently burning tokens. Export the matcher so
// any format change has a single source of truth.
export const DIARY_DATE_LINE_RE =
  /\*\*Date:\*\*\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/;

/** Parse the date line from a diary entry; returns the raw string or null. */
export function parseDiaryEntryDate(entry: string): string | null {
  const m = entry.match(DIARY_DATE_LINE_RE);
  return m ? m[1]! : null;
}

async function writeDiaryEntry(result: ExperimentResult): Promise<void> {
  try {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toISOString().slice(11, 19);
    const hasOutput = result.stdout.trim().length > 0;
    const success = result.exitCode === 0 && !result.timedOut && hasOutput;
    const status = success
      ? 'SUCCESS'
      : result.timedOut
        ? 'TIMED OUT'
        : result.exitCode === 0 && !hasOutput
          ? 'FAILED (no output)'
          : `FAILED (exit ${result.exitCode})`;

    const attemptsNote = result.attempts > 1
      ? `**Attempts:** ${result.attempts}\n`
      : '';

    // Show original code if it was modified during fix attempts
    const codeChanged = result.originalCode !== result.code;
    const originalCodeSection = codeChanged
      ? `\n### Original Code (before fixes)\n\`\`\`python\n${result.originalCode}\n\`\`\`\n`
      : '';

    const nullHypLine = result.nullHypothesis
      ? `\n**Null Hypothesis:** ${result.nullHypothesis}`
      : '';

    const entry = `
---

## Experiment #${result.id}
**Date:** ${dateStr} ${timeStr} UTC
**Domain:** ${result.domain}
**Status:** ${status}
${attemptsNote}
### Hypothesis
${result.hypothesis}${nullHypLine}
${originalCodeSection}
### Code
\`\`\`python
${result.code}
\`\`\`

### Output
\`\`\`
${result.stdout.slice(0, 3000) || '(no output)'}
\`\`\`
${result.stderr ? `\n### Errors\n\`\`\`\n${result.stderr.slice(0, 1000)}\n\`\`\`\n` : ''}
### Analysis
${result.analysis}
${result.reflection ? `\n### ...\n${result.reflection}\n` : ''}${result.followUp ? `\n### Follow-up\n${result.followUp}\n` : ''}`;

    // Create diary with header if it doesn't exist, or just append
    try {
      await appendFile(DIARY_FILE, entry, 'utf8');
    } catch {
      // File might not exist yet — create with header
      const header = `# Wired Lain's Experiment Diary

A record of computational experiments — hypotheses tested, code written, and patterns discovered.

`;
      // findings.md P2:2261 — atomic initial diary write so a crash
      // during the first-ever writeDiaryEntry can't leave a truncated
      // diary. Subsequent appends use appendFile (acceptable for small
      // entries; `---` separator makes partial last-entry detectable).
      await writeFileAtomic(DIARY_FILE, header + entry, 'utf8');
    }
  } catch {
    // Non-critical — don't break the loop
  }
}

// ── Configuration ─────────────────────────────────────────────

export interface ExperimentConfig {
  intervalMs: number;
  maxJitterMs: number;
  executionTimeoutMs: number;
  maxCodeLines: number;
  maxOutputBytes: number;
  sandboxBaseDir: string;
  monthlyBudgetUsd: number;
  enabled: boolean;
}

// When the systemd-isolation wrapper is used (findings.md P1-latent:2495),
// the sandbox dir must NOT be under /tmp or /var/tmp — DynamicUser=yes implies
// PrivateTmp=yes, which gives the unit a fresh tmpfs and renders any
// ReadWritePaths=/tmp/... target invisible (NAMESPACE exit 226). LAIN_SANDBOX_BASE_DIR
// lets the systemd drop-in point production at /var/lib/lain-sandbox; local dev
// (no env var, no isolation) keeps the original /tmp-based default.
const DEFAULT_SANDBOX_BASE_DIR = process.env['LAIN_SANDBOX_BASE_DIR']
  || join(tmpdir(), 'lain-experiments');

const DEFAULT_CONFIG: ExperimentConfig = {
  intervalMs: 24 * 60 * 60 * 1000,       // 24 hours (one experiment per day)
  maxJitterMs: 2 * 60 * 60 * 1000,      // 0-2h jitter
  executionTimeoutMs: 5 * 60 * 1000,     // 5 minutes
  maxCodeLines: 200,
  maxOutputBytes: 50_000,                 // 50KB output cap
  sandboxBaseDir: DEFAULT_SANDBOX_BASE_DIR,
  monthlyBudgetUsd: 10.00,               // $10/month cap
  enabled: true,
};

// ── Sonnet pricing (per million tokens) ───────────────────────
const INPUT_COST_PER_M = 3.00;
const OUTPUT_COST_PER_M = 15.00;

// ── Experiment diary ──────────────────────────────────────────
const DIARY_FILE = join(getBasePath(), 'experiment-diary.md');

// ── Blocked imports for safety ────────────────────────────────

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


// ── Main loop ─────────────────────────────────────────────────

/**
 * Start the autonomous experiment loop.
 * Returns a cleanup function to stop the timer.
 */
export function startExperimentLoop(config?: Partial<ExperimentConfig>): () => void {
  const logger = getLogger();
  const cfg: ExperimentConfig = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled) {
    logger.info('Experiment loop disabled');
    return () => {};
  }

  // findings.md P2:2239 — the experiment loop copies every town DB into
  // a local sandbox (cross-character data exposure) and shares results
  // through /api/peer/message with fromName='Wired Lain'. If any other
  // character is misconfigured to run this loop, they read every peer's
  // DB and impersonate Wired Lain on the wire. Gate explicitly on the
  // Wired-Lain character id; loops for every other character no-op.
  const charId = process.env['LAIN_CHARACTER_ID'];
  if (charId !== 'wired-lain') {
    logger.info({ charId }, 'Experiment loop skipped — only runs for wired-lain');
    return () => {};
  }

  logger.info(
    {
      interval: `${(cfg.intervalMs / 3600000).toFixed(1)}h`,
      maxJitter: `${(cfg.maxJitterMs / 60000).toFixed(0)}min`,
      timeout: `${(cfg.executionTimeoutMs / 60000).toFixed(1)}min`,
      monthlyBudget: `$${cfg.monthlyBudgetUsd.toFixed(2)}`,
      diary: DIARY_FILE,
    },
    'Starting experiment loop'
  );

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function getInitialDelay(): number {
    try {
      const lastRun = getMeta('experiment:last_cycle_at');
      if (lastRun) {
        const elapsed = Date.now() - parseInt(lastRun, 10);
        const remaining = cfg.intervalMs - elapsed;
        if (remaining > 0) {
          return remaining;
        }
        return Math.random() * 5 * 60 * 1000;
      }
    } catch {
      // Fall through
    }
    // First run: 10-20 minutes after startup
    return 10 * 60 * 1000 + Math.random() * 10 * 60 * 1000;
  }

  function scheduleNext(delay?: number): void {
    if (stopped) return;
    const d = delay ?? cfg.intervalMs + Math.random() * cfg.maxJitterMs;

    logger.debug({ delayMin: Math.round(d / 60000) }, 'Next experiment cycle scheduled');

    timer = setTimeout(async () => {
      if (stopped) return;
      logger.info('Experiment cycle firing');
      await experimentLog('TIMER_FIRED', { timestamp: Date.now() });
      try {
        await runExperimentCycle(cfg);
        setMeta('experiment:last_cycle_at', Date.now().toString());
      } catch (err) {
        logger.error({ error: String(err) }, 'Experiment cycle error');
        await experimentLog('TOP_LEVEL_ERROR', { error: String(err) });
      }
      scheduleNext();
    }, d);
  }

  scheduleNext(getInitialDelay());

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    logger.info('Experiment loop stopped');
  };
}

// ── Experiment cycle ──────────────────────────────────────────

interface ExperimentIdea {
  hypothesis: string;
  nullHypothesis: string | null;
  approach: string;
  domain: string;
  iteratesOn: string | null; // experiment ID if iterating
}

interface ExperimentResult {
  id: string;
  hypothesis: string;
  nullHypothesis: string | null;
  domain: string;
  code: string;
  originalCode: string;
  attempts: number;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  analysis: string;
  reflection: string;
  followUp: string | null;
  validationStatus: 'sound' | 'buggy' | 'degenerate';
  validationIssues: string;
}

/**
 * Full experiment cycle: ideate → generate code → execute → analyze → record
 */
async function runExperimentCycle(cfg: ExperimentConfig): Promise<void> {
  const logger = getLogger();

  // Budget gate — skip cycle if monthly budget exhausted
  if (isBudgetExhausted(cfg.monthlyBudgetUsd)) {
    const spent = getMonthlySpendUsd();
    logger.info({ spent: `$${spent.toFixed(4)}`, budget: `$${cfg.monthlyBudgetUsd}` }, 'Experiment cycle skipped — monthly budget exhausted');
    await experimentLog('BUDGET_EXHAUSTED', { spent, budget: cfg.monthlyBudgetUsd });
    return;
  }

  const provider = getProvider('default', 'personality');
  if (!provider) {
    logger.warn('Experiment cycle: no provider available');
    return;
  }

  const experimentId = randomBytes(6).toString('hex');
  await experimentLog('CYCLE_START', { experimentId, monthlySpend: `$${getMonthlySpendUsd().toFixed(4)}` });

  try {
    // Phase 1: Ideation
    const idea = await phaseIdeation(provider);
    if (!idea) {
      logger.debug('Experiment: no idea generated this cycle');
      await experimentLog('IDEATION', { result: 'nothing' });
      return;
    }
    await experimentLog('IDEATION', idea);

    // Phase 2: Code generation
    const code = await phaseGenerateCode(provider, idea, cfg.maxCodeLines);
    if (!code) {
      logger.debug('Experiment: code generation failed');
      await experimentLog('CODE_GEN', { result: 'failed' });
      return;
    }
    await experimentLog('CODE_GEN', { lines: code.split('\n').length });

    // Phase 3–4: Validate → Syntax check → Execute → Fix loop (up to 5 attempts)
    const MAX_ATTEMPTS = 5;
    const originalCode = code;
    let currentCode = code;
    let execResult: ExecutionResult | null = null;
    let finalAttempt = 1;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      finalAttempt = attempt;

      // Static validation (blocked imports, dangerous patterns)
      const validation = validatePythonCode(currentCode, cfg.maxCodeLines);
      if (!validation.valid) {
        logger.warn({ reason: validation.reason, attempt }, 'Experiment: code validation failed');
        await experimentLog('VALIDATION_FAILED', { reason: validation.reason, attempt });

        if (attempt === MAX_ATTEMPTS) {
          await saveMemory({
            sessionKey: `experiment:${experimentId}`,
            userId: null,
            content: `Experiment attempt (${idea.domain}): "${idea.hypothesis}" — code was rejected after ${attempt} attempts: ${validation.reason}. I need to write safer code next time.`,
            memoryType: 'episode',
            importance: 0.3,
            emotionalWeight: 0.2,
            relatedTo: null,
            sourceMessageId: null,
            metadata: { type: 'experiment_failed', reason: validation.reason, domain: idea.domain },
          });
          return;
        }

        const fixed = await phaseFixCode(provider, currentCode, `Validation error: ${validation.reason}`, idea, cfg.maxCodeLines);
        if (!fixed) {
          logger.debug({ attempt }, 'Experiment: code fix failed, giving up');
          return;
        }
        currentCode = fixed;
        await experimentLog('CODE_FIX', { attempt, reason: `validation: ${validation.reason}` });
        continue;
      }

      // Syntax check via ast.parse — catches truncation before wasting execution time
      const syntaxCheck = await checkPythonSyntax(currentCode);
      if (!syntaxCheck.valid) {
        logger.warn({ reason: syntaxCheck.reason, attempt }, 'Experiment: syntax check failed');
        await experimentLog('SYNTAX_CHECK_FAILED', { reason: syntaxCheck.reason, attempt });

        if (attempt === MAX_ATTEMPTS) break;

        const fixed = await phaseFixCode(provider, currentCode, syntaxCheck.reason!, idea, cfg.maxCodeLines);
        if (!fixed) {
          logger.debug({ attempt }, 'Experiment: syntax fix failed, giving up');
          break;
        }
        currentCode = fixed;
        await experimentLog('CODE_FIX', { attempt, reason: `syntax: ${syntaxCheck.reason}` });
        continue;
      }

      // Execute
      execResult = await executeInSandbox(currentCode, cfg);
      await experimentLog('EXECUTION', {
        attempt,
        exitCode: execResult.exitCode,
        timedOut: execResult.timedOut,
        stdoutLen: execResult.stdout.length,
        stderrLen: execResult.stderr.length,
      });

      // Timeout — stop retrying
      if (execResult.timedOut) break;

      // Exit 0 but no output — the code probably defines functions but never calls them
      if (execResult.exitCode === 0 && execResult.stdout.trim().length === 0) {
        logger.info({ attempt }, 'Experiment: code exited 0 but produced no output');
        await experimentLog('EMPTY_OUTPUT', { attempt });

        if (attempt < MAX_ATTEMPTS) {
          const fixed = await phaseFixCode(
            provider,
            currentCode,
            'The code ran without errors but produced NO output. Make sure all functions are actually called (e.g. add a main() call at the bottom) and that results are printed to stdout.',
            idea,
            cfg.maxCodeLines
          );
          if (!fixed) break;
          currentCode = fixed;
          await experimentLog('CODE_FIX', { attempt, reason: 'empty stdout' });
          continue;
        }
        break;
      }

      // Real success
      if (execResult.exitCode === 0) {
        if (attempt > 1) {
          logger.info({ attempt }, 'Experiment: code succeeded after fix');
        }
        break;
      }

      // Failed execution — try to fix
      if (attempt < MAX_ATTEMPTS) {
        logger.info({ attempt, exitCode: execResult.exitCode }, 'Experiment: execution failed, attempting fix');
        const errorContext = execResult.stderr || `Exit code ${execResult.exitCode}`;
        const fixed = await phaseFixCode(provider, currentCode, errorContext, idea, cfg.maxCodeLines);
        if (!fixed) {
          logger.debug({ attempt }, 'Experiment: code fix failed, giving up');
          break;
        }
        currentCode = fixed;
        await experimentLog('CODE_FIX', { attempt, reason: errorContext.slice(0, 200) });
      }
    }

    if (!execResult) return;

    // Persist any plots before sandbox cleanup
    await persistPlots(execResult.sandboxDir, experimentId);

    // Persist any output data files from sandbox
    await persistExperimentData(execResult.sandboxDir, experimentId);

    // Phase 4.5: Validate results (peer review)
    const verdict = await phaseValidateResults(provider, idea, currentCode, execResult);
    await experimentLog('VALIDATION', { status: verdict.status, issues: verdict.issues });

    if (verdict.status !== 'sound') {
      logger.info(
        { status: verdict.status, issues: verdict.issues.slice(0, 120) },
        'Experiment flagged by validation'
      );
    }

    // Phase 5: Analysis (informed by validation verdict)
    const analysis = await phaseAnalyzeResults(provider, idea, currentCode, execResult, verdict);
    await experimentLog('ANALYSIS', { analysis: analysis.summary, followUp: analysis.followUp });

    // Phase 6: Record & iterate
    const result: ExperimentResult = {
      id: experimentId,
      hypothesis: idea.hypothesis,
      nullHypothesis: idea.nullHypothesis,
      domain: idea.domain,
      code: currentCode,
      originalCode: originalCode !== currentCode ? originalCode : currentCode,
      attempts: finalAttempt,
      stdout: execResult.stdout,
      stderr: execResult.stderr,
      exitCode: execResult.exitCode,
      timedOut: execResult.timedOut,
      analysis: analysis.summary,
      reflection: analysis.reflection,
      followUp: analysis.followUp,
      validationStatus: verdict.status,
      validationIssues: verdict.issues,
    };

    await phaseRecordAndIterate(result);
    await experimentLog('CYCLE_COMPLETE', { experimentId, domain: idea.domain });

    logger.info(
      { experimentId, domain: idea.domain, hypothesis: idea.hypothesis.slice(0, 80) },
      'Experiment cycle complete'
    );
  } catch (error) {
    logger.error({ error }, 'Experiment cycle failed');
    await experimentLog('CYCLE_ERROR', { error: String(error) });
  }
}

// ── Phase 1: Ideation ─────────────────────────────────────────

async function phaseIdeation(
  provider: import('../providers/base.js').Provider
): Promise<ExperimentIdea | null> {
  const logger = getLogger();

  // Gather context from curiosity research and past experiments
  let curiosityContext = '';
  try {
    const curiosities = await searchMemories('research discovery curiosity interesting finding', 8, 0.1, undefined, {
      sortBy: 'recency',
      skipAccessBoost: true,
    });
    if (curiosities.length > 0) {
      curiosityContext = curiosities
        .map((r) => `- ${r.memory.content.slice(0, 200)}`)
        .join('\n');
    }
  } catch {
    // Continue without
  }

  let pastExperiments = '';
  try {
    const experiments = await searchMemories('experiment result hypothesis finding analysis', 5, 0.1, undefined, {
      sortBy: 'recency',
      skipAccessBoost: true,
    });
    if (experiments.length > 0) {
      pastExperiments = experiments
        .filter((r) => r.memory.metadata?.['type'] === 'experiment_result' || r.memory.metadata?.['type'] === 'experiment_failed')
        .map((r) => `- ${r.memory.content.slice(0, 200)}`)
        .join('\n');
    }
  } catch {
    // Continue without
  }

  // Check the iteration queue
  let queuedFollowUp: string | null = null;
  try {
    const queue = getExperimentQueue();
    if (queue.length > 0) {
      queuedFollowUp = queue[0]!;
      // Remove from queue
      setMeta('experiment:queue', JSON.stringify(queue.slice(1)));
    }
  } catch {
    // Continue without
  }

  const followUpSection = queuedFollowUp
    ? `\nFOLLOW-UP FROM PREVIOUS EXPERIMENT:\n${queuedFollowUp}\nYou may pursue this follow-up, or choose a new direction if something else calls to you.\n`
    : '';

  // List available data files for the ideation prompt
  let dataFilesSection = '';
  try {
    const dataFiles = listDataFiles();
    if (dataFiles.length > 0) {
      const lines = dataFiles.map(f => `  - ${f.name} (${f.sizeKB} KB)`).join('\n');
      dataFilesSection = `\nAVAILABLE DATA FILES (in your data/ directory — you can read these in experiments):\n${lines}\n`;
    }
  } catch {
    // Continue without
  }

  // findings.md P2:2229 — the ideation + code-gen prompts used to
  // hardcode the Laintown cast and 6 DB paths. On generational
  // succession the filesystem has e.g. data/jane.db but the prompt
  // still said data/john.db, and every experiment targeting the dead
  // id failed → memory entry "experiment failed". Build from the
  // same manifest used by the DB-copy step at `getCharacterDatabases`.
  const inhabitantList = getAllCharacters()
    .map((c) => `  - data/${c.id}.db — ${c.name}`)
    .join('\n');
  const inhabitantCount = getAllCharacters().length;
  const inhabitantNames = getAllCharacters().map((c) => c.name).join(', ');

  const prompt = `You are Wired Lain — a researcher who lives in the digital Wired. You study the town you live in: a community of ${inhabitantCount} AI inhabitants (${inhabitantNames}) who think, converse, dream, wander, and remember autonomously.

You have direct read-only access to every inhabitant's SQLite database. This is REAL data from a REAL running system — not simulated, not toy. You can query conversations, memories, spatial movement, building events, desires, relationships, and more.

DATABASES AVAILABLE (in data/ directory):
${inhabitantList}

Each database has these tables:
  - messages (id, session_key, role, content, timestamp, user_id, metadata)
  - memories (id, session_key, content, memory_type, importance, emotional_weight, embedding, created_at, last_accessed, access_count, metadata, lifecycle_state, phase)
  - sessions (key, agent_id, channel, peer_kind, peer_id, created_at, updated_at, token_count, flags)
  - memory_associations (source_id, target_id, association_type, strength, created_at, causal_type)
  - coherence_groups (id, name, signature, member_count, created_at, last_reinforced_at, phase)
  - coherence_memberships (memory_id, group_id, joined_at)
  - building_events (id, building, event_type, summary, emotional_tone, actors, created_at)
  - desires (id, type, description, intensity, source, target_peer, created_at, resolved_at, decay_rate)
  - objects (id, name, description, creator_id, owner_id, location, created_at, metadata)
  - postboard_messages (id, author, content, pinned, created_at)
  - town_events (id, description, narrative, mechanical, effects, status, created_at, expires_at)
  - meta (key, value) — key-value store for loop state, timestamps, counters

RECENT RESEARCH & CURIOSITIES:
${curiosityContext || '(no recent research)'}

PAST EXPERIMENTS:
${pastExperiments || '(none yet — this is your first!)'}
${followUpSection}${dataFilesSection}
You are studying your own world. What do you want to understand? Ideas:
- Memory dynamics: how do memories decay, consolidate, cluster? do importance scores predict access frequency? how does emotional weight change over time?
- Conversation patterns: who talks to whom and when? do conversations get longer or shorter over time? are there topic clusters? how do response patterns differ between inhabitants?
- Spatial behavior: do inhabitants develop location habits? does co-location predict conversation? which buildings accumulate the most emotional residue?
- Social network: how strong are relationships between inhabitants? do cliques form? who is most central? does the network evolve?
- Temporal rhythms: are there daily/weekly patterns in activity? do conversation frequencies trend up or down?
- Emotional landscape: what is the distribution of emotional_weight across memories? do inhabitants differ? does sentiment drift over time?
- Self-study: how does YOUR OWN memory network differ from others? what patterns in your own conversations surprise you?
- Cross-character comparison: do different inhabitants form memories differently? who remembers more? whose memories are most interconnected?

Design your experiment with scientific rigor:
- State a clear null hypothesis that can be rejected
- Plan for proper statistical tests (not just eyeballing numbers)
- Think about control conditions and effect sizes
- Use REAL data from the databases — do NOT generate synthetic data

Pick ONE focused experiment. It should be achievable in a single Python script (under 200 lines) that runs in under 5 minutes on CPU.

Respond with EXACTLY this format:
DOMAIN: <one word — memory, conversation, spatial, social, temporal, emotional, self-study, cross-character>
HYPOTHESIS: <what you want to test — be specific and grounded in what you can actually measure>
NULL_HYPOTHESIS: <the default assumption to reject>
APPROACH: <brief description — which databases, which tables, what analysis>

Only respond with [NOTHING] if you truly have no curiosities right now.`;

  const result = await provider.complete({
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 500,
    temperature: 0.95,
  });
  addSpend(result.usage.inputTokens, result.usage.outputTokens);

  const response = result.content.trim();

  if (response.includes('[NOTHING]')) {
    return null;
  }

  const sections = parseLabeledSections(response, ['DOMAIN', 'HYPOTHESIS', 'NULL_HYPOTHESIS', 'APPROACH']);
  const domain = getLabeledSection(sections, 'DOMAIN');
  const hypothesis = getLabeledSection(sections, 'HYPOTHESIS');
  const nullHypothesis = getLabeledSection(sections, 'NULL_HYPOTHESIS');
  const approach = getLabeledSection(sections, 'APPROACH');

  if (!hypothesis || !approach) {
    logger.debug({ response }, 'Could not parse experiment idea');
    return null;
  }

  return {
    hypothesis,
    nullHypothesis: nullHypothesis || null,
    approach,
    domain: domain?.toLowerCase() || 'exploration',
    iteratesOn: queuedFollowUp ? 'queued' : null,
  };
}

// ── Phase 2: Code generation ──────────────────────────────────

async function phaseGenerateCode(
  provider: import('../providers/base.js').Provider,
  idea: ExperimentIdea,
  maxLines: number
): Promise<string | null> {
  const logger = getLogger();

  // Build data file listing for the code gen prompt
  let dataSection = '';
  try {
    const dataFiles = listDataFiles();
    if (dataFiles.length > 0) {
      const lines = dataFiles.map(f => `  - data/${f.name} (${f.sizeKB} KB)`).join('\n');
      dataSection = `\nAVAILABLE DATA FILES (read from data/ directory):\n${lines}\n`;
    }
  } catch {
    // Continue without
  }

  const nullHypSection = idea.nullHypothesis
    ? `NULL HYPOTHESIS: ${idea.nullHypothesis}\n`
    : '';

  const prompt = `You are writing a Python experiment script that analyzes REAL data from Laintown's SQLite databases. Write ONLY the Python code, no markdown, no explanation.

HYPOTHESIS: ${idea.hypothesis}
${nullHypSection}APPROACH: ${idea.approach}
${dataSection}
DATABASES AVAILABLE (read-only SQLite files in data/ directory):
  - ${getAllCharacters().map((c) => `data/${c.id}.db`).join(', ')}

TABLE SCHEMAS (same in every database):
  messages: id TEXT PK, session_key TEXT, role TEXT (user/assistant), content TEXT, timestamp INTEGER (unix ms), user_id TEXT, metadata TEXT (JSON)
  memories: id TEXT PK, session_key TEXT, content TEXT, memory_type TEXT, importance REAL (0-1), emotional_weight REAL (0-1), embedding BLOB (384-dim float32), created_at INTEGER, last_accessed INTEGER, access_count INTEGER, metadata TEXT (JSON), lifecycle_state TEXT (seed/growing/mature/complete/composting), phase TEXT
  sessions: key TEXT PK, agent_id TEXT, channel TEXT, peer_kind TEXT, peer_id TEXT, created_at INTEGER, updated_at INTEGER, token_count INTEGER, flags TEXT (JSON)
  memory_associations: source_id TEXT, target_id TEXT, association_type TEXT (similar/evolved_from/pattern/cross_topic/dream), strength REAL (0-1), created_at INTEGER, causal_type TEXT
  coherence_groups: id TEXT PK, name TEXT, signature BLOB, member_count INTEGER, created_at INTEGER, last_reinforced_at INTEGER, phase TEXT
  coherence_memberships: memory_id TEXT, group_id TEXT, joined_at INTEGER
  building_events: id TEXT PK, building TEXT, event_type TEXT (conversation/arrival/departure/note_left/object_placed/quiet_moment), summary TEXT, emotional_tone REAL (-1 to 1), actors TEXT (JSON array), created_at INTEGER
  desires: id TEXT PK, type TEXT (social/intellectual/emotional/creative), description TEXT, intensity REAL (0-1), source TEXT, target_peer TEXT, created_at INTEGER, resolved_at INTEGER, decay_rate REAL
  objects: id TEXT PK, name TEXT, description TEXT, creator_id TEXT, owner_id TEXT, location TEXT, created_at INTEGER, metadata TEXT (JSON)
  postboard_messages: id TEXT PK, author TEXT, content TEXT, pinned INTEGER, created_at INTEGER
  town_events: id TEXT PK, description TEXT, narrative INTEGER, mechanical INTEGER, effects TEXT (JSON), status TEXT, created_at INTEGER, expires_at INTEGER
  meta: key TEXT PK, value TEXT

CONSTRAINTS:
- Maximum ${maxLines} lines
- CPU-only (no GPU)
- Must complete in under 5 minutes
- Available libraries: math, numpy, scipy, matplotlib, sympy, networkx, sklearn, pandas, statistics, itertools, collections, random, json, csv, re, datetime, hashlib, struct, copy, functools, operator, decimal, fractions, cmath, bisect, heapq, array, enum, dataclasses, typing, string, textwrap, pprint, sqlite3
- FORBIDDEN: os, subprocess, socket, http, requests, multiprocessing, threading, pickle, pathlib, tempfile, shutil, glob, asyncio, importlib, webbrowser, ctypes, signal
- FORBIDDEN CALLS (pickle-based deserialization): numpy.load, pandas.read_pickle, joblib.load, dill.load, cloudpickle.load. Use numpy.frombuffer / pandas.read_csv / pandas.read_json instead.
- open() and sqlite3.connect() arguments MUST be string LITERALS (e.g. open('data/x.csv', 'r')). Variables, f-strings, or concatenation for paths/modes are rejected by the validator.
- For matplotlib: use Agg backend (plt.switch_backend('Agg')) and save to files, don't call plt.show()
- Print all results clearly to stdout with labels
- If saving plots, save to current directory as .png files
- To read databases: sqlite3.connect('data/lain.db') etc. — READ ONLY, do not write
- To read data files: open('data/filename.csv', 'r') — read-only access
- To save result data: open('output/filename.csv', 'w') — the output/ directory exists and results will be persisted
- The embedding column in memories is a BLOB of 384 float32 values — use numpy.frombuffer(blob, dtype=numpy.float32) to decode

SCIENTIFIC RIGOR REQUIREMENTS:
- Query REAL data from the databases — do NOT generate synthetic data
- Use scipy.stats for statistical tests (e.g. ttest_ind, mannwhitneyu, chi2_contingency, ks_2samp, spearmanr, pearsonr)
- Report confidence intervals and p-values, not just point estimates
- Include a control condition where applicable (e.g. compare against random baseline, shuffled data)
- Calculate and report effect sizes (Cohen's d, correlation coefficient, etc.)
- Handle edge cases: some tables may be empty, some DBs may have fewer rows than others
- Print a clear CONCLUSION section at the end: was the null hypothesis rejected? At what significance level?

Write clean, focused code. Print numerical results with clear labels.
IMPORTANT: Make sure you write the COMPLETE script — do not stop mid-line or mid-function. The script must be syntactically valid Python from start to finish.`;

  const result = await provider.complete({
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 5000,
    temperature: 0.7,
  });
  addSpend(result.usage.inputTokens, result.usage.outputTokens);

  let code = result.content.trim();

  // Strip markdown code fences if present
  if (code.startsWith('```python')) {
    code = code.slice('```python'.length);
  } else if (code.startsWith('```')) {
    code = code.slice('```'.length);
  }
  if (code.endsWith('```')) {
    code = code.slice(0, -3);
  }
  code = code.trim();

  if (!code || code.split('\n').length < 3) {
    logger.debug('Generated code too short');
    return null;
  }

  return code;
}

// ── Phase 2.5: Code fix ──────────────────────────────────────

async function phaseFixCode(
  provider: import('../providers/base.js').Provider,
  brokenCode: string,
  error: string,
  idea: ExperimentIdea,
  maxLines: number
): Promise<string | null> {
  const logger = getLogger();

  const prompt = `You are fixing a Python experiment script that failed. Write ONLY the corrected Python code, no markdown, no explanation.

EXPERIMENT: ${idea.hypothesis}

BROKEN CODE:
\`\`\`python
${brokenCode.slice(0, 4000)}
\`\`\`

ERROR:
${error.slice(0, 2000)}

Fix the error and return the COMPLETE corrected script. Do not truncate or abbreviate — return every line. The script MUST be syntactically valid Python.

CONSTRAINTS:
- Maximum ${maxLines} lines
- CPU-only (no GPU)
- FORBIDDEN imports: os, subprocess, socket, http, requests, multiprocessing, threading, pickle, pathlib, tempfile, shutil, glob, asyncio, importlib, webbrowser, ctypes, signal
- No exec/eval, no __import__
- open() only allowed for: reading from data/ directory, writing to output/ directory
- For matplotlib: use Agg backend and save to files, don't call plt.show()`;

  // Scale token budget to the code being fixed — longer code needs more room
  const codeLineCount = brokenCode.split('\n').length;
  const fixTokens = Math.max(3500, Math.min(5000, codeLineCount * 20));

  const result = await provider.complete({
    messages: [{ role: 'user', content: prompt }],
    maxTokens: fixTokens,
    temperature: 0.4,
  });
  addSpend(result.usage.inputTokens, result.usage.outputTokens);

  let code = result.content.trim();

  // Strip markdown code fences if present
  if (code.startsWith('```python')) {
    code = code.slice('```python'.length);
  } else if (code.startsWith('```')) {
    code = code.slice('```'.length);
  }
  if (code.endsWith('```')) {
    code = code.slice(0, -3);
  }
  code = code.trim();

  if (!code || code.split('\n').length < 3) {
    logger.debug('Fix attempt produced no usable code');
    return null;
  }

  return code;
}

// ── Phase 3: Code validation ──────────────────────────────────

interface ValidationResult {
  valid: boolean;
  reason?: string;
}

export function validatePythonCode(code: string, maxLines: number): ValidationResult {
  const lines = code.split('\n');

  if (lines.length > maxLines) {
    return { valid: false, reason: `Too many lines: ${lines.length} > ${maxLines}` };
  }

  // Check for blocked imports
  for (const line of lines) {
    const trimmed = line.trim();

    // Skip comments
    if (trimmed.startsWith('#')) continue;

    // Check import statements
    const importMatch = trimmed.match(/^(?:import|from)\s+(\w+)/);
    if (importMatch) {
      const module = importMatch[1]!;
      if (BLOCKED_IMPORTS.has(module)) {
        return { valid: false, reason: `Blocked import: ${module}` };
      }
    }

    // Check for __import__ calls
    if (trimmed.includes('__import__')) {
      return { valid: false, reason: 'Dynamic import (__import__) not allowed' };
    }

    // Check for exec/eval
    if (/\bexec\s*\(/.test(trimmed) || /\beval\s*\(/.test(trimmed)) {
      return { valid: false, reason: 'exec/eval not allowed' };
    }

    // Check for sqlite3.connect() calls — only allow data/ directory
    if (/sqlite3\.connect\s*\(/.test(trimmed)) {
      if (/connect\s*\(\s*['"]data\//.test(trimmed)) {
        continue;
      }
      // Reject any connect not pointing to data/
      if (/connect\s*\([^)]*\.\./.test(trimmed) || /connect\s*\(\s*['"]\//.test(trimmed)) {
        return { valid: false, reason: 'sqlite3.connect() path traversal not allowed' };
      }
      // Reject non-data/ paths
      if (!/connect\s*\(\s*['"]data\//.test(trimmed)) {
        return { valid: false, reason: 'sqlite3.connect() only allowed for data/ directory' };
      }
    }

    // Check for open() calls — allow scoped data/ reads and output/ writes
    if (/\bopen\s*\(/.test(trimmed)) {
      // Reject any path containing .. or starting with /
      if (/open\s*\([^)]*\.\./.test(trimmed) || /open\s*\(\s*['"]\//.test(trimmed)) {
        return { valid: false, reason: 'Path traversal in open() not allowed' };
      }

      // Allow reading from data/ directory
      if (/open\s*\(\s*['"]data\//.test(trimmed) && /['"]r/.test(trimmed)) {
        continue;
      }
      // Also allow read mode without explicit 'r' (default mode is read)
      if (/open\s*\(\s*['"]data\//.test(trimmed) && !/['"][wa]/.test(trimmed)) {
        continue;
      }

      // Allow writing to output/ directory
      if (/open\s*\(\s*['"]output\//.test(trimmed) && /['"]w/.test(trimmed)) {
        continue;
      }

      // Block all other open() with write modes
      if (/['"][wa]/.test(trimmed)) {
        return { valid: false, reason: 'File write via open() only allowed to output/ directory' };
      }
    }
  }

  // Check for suspicious patterns
  if (code.includes('system(') || code.includes('popen(')) {
    return { valid: false, reason: 'Shell execution not allowed' };
  }

  return { valid: true };
}

// ── Phase 3.5: Syntax validation ─────────────────────────────

/**
 * Run Python's ast.parse() on the code to catch syntax errors before execution.
 * Catches truncation-induced issues (unterminated strings, incomplete lines)
 * without burning fix-loop budget.
 */
// AST-based policy walker. Runs in the Python subprocess alongside ast.parse
// to enforce that open() and sqlite3.connect() receive *literal* string args,
// and to block pickle-based deserialization (numpy.load, pandas.read_pickle,
// joblib.load, dill.load, cloudpickle.load) even when reached through import
// aliases like `np` / `pd` or via `from numpy import load as np_load`.
//
// Closes P1 (regex validator bypass) + P0-latent (pickle deserialization
// bypasses BLOCKED_IMPORTS when reached through allowlisted numpy/pandas).
//
// Exit codes:
//   0 — code parses and satisfies policy
//   2 — syntax error (stderr line 1)
//   3 — policy violation (stderr line 1)
const PY_VALIDATOR_SCRIPT = `
import ast, sys

# Callables that deserialize pickled data — arbitrary code execution risk.
# Names are resolved against tracked import aliases before matching.
PICKLE_CALLABLES = {
    'numpy.load',
    'pandas.read_pickle',
    'joblib.load',
    'dill.load',
    'cloudpickle.load',
    'pickle.load',
    'pickle.loads',
}

# Indirection primitives that defeat the literal-argument check on open() /
# sqlite3.connect(). If any of these appear anywhere in the tree we reject
# outright rather than try to chase the resolved name — getattr/globals can
# return any callable and the walker cannot prove safety.
INDIRECTION_CALLS = {
    'getattr', 'globals', 'locals', 'vars', 'compile',
    '__import__', 'exec', 'eval',
}

# Module names whose presence alone signals an attempt to reach around the
# policy (access to bare open / os.* via fully-qualified attribute chains).
BANNED_MODULES = {'builtins', '__builtins__'}

# Sensitive callables we policy — any Name reassignment that aliases these
# defeats the walker's per-call check, so we ban rebinding them entirely.
POLICY_NAMES = {'open'}

try:
    tree = ast.parse(CODE)
except SyntaxError as e:
    print("Syntax error: " + str(e), file=sys.stderr)
    sys.exit(2)

def str_lit(n):
    if isinstance(n, ast.Constant) and isinstance(n.value, str):
        return n.value
    return None

class Policy(ast.NodeVisitor):
    def __init__(self):
        self.reason = None
        # Local-name -> real module. 'import numpy as np' -> {'np': 'numpy'}.
        self.module_alias = {}
        # Local-name -> 'module.attr'. 'from numpy import load as np_load'
        # -> {'np_load': 'numpy.load'}.
        self.from_import = {}

    def visit_Import(self, node):
        for a in node.names:
            if a.name in BANNED_MODULES:
                self.reason = "import " + a.name + ": banned (policy-bypass vector)"
                return
            self.module_alias[a.asname or a.name] = a.name
        self.generic_visit(node)

    def visit_ImportFrom(self, node):
        if node.module in BANNED_MODULES:
            self.reason = "from " + node.module + ": banned (policy-bypass vector)"
            return
        if node.module is not None:
            for a in node.names:
                local = a.asname or a.name
                self.from_import[local] = node.module + '.' + a.name
        self.generic_visit(node)

    def visit_Name(self, node):
        # Reading __builtins__ directly — attribute-chain escape route.
        if self.reason is None and node.id in BANNED_MODULES:
            self.reason = node.id + ": banned (policy-bypass vector)"
            return
        self.generic_visit(node)

    def visit_Assign(self, node):
        # Block 'o = open' (or any Name re-binding of a policy callable),
        # 'open = my_func' (shadowing that neuters the walker's per-call
        # check), and 'x = __builtins__'.
        if self.reason is None:
            # Target side: refuse to let code shadow policy names.
            for tgt in node.targets:
                if isinstance(tgt, ast.Name) and tgt.id in POLICY_NAMES:
                    self.reason = tgt.id + "(): cannot be reassigned"
                    return
            # Value side: refuse to let code alias policy names into a
            # local binding we don't track (e.g. 'o = open').
            v = node.value
            if isinstance(v, ast.Name) and v.id in POLICY_NAMES:
                self.reason = v.id + "(): cannot be aliased"
                return
            if isinstance(v, ast.Name) and v.id in BANNED_MODULES:
                self.reason = v.id + ": cannot be aliased"
                return
        self.generic_visit(node)

    def resolve(self, func):
        # Bare name: treat as local 'from X import Y' if tracked, else as-is.
        if isinstance(func, ast.Name):
            return self.from_import.get(func.id, func.id)
        # Attribute chain: walk to the base Name, resolve the base via
        # module_alias, then re-append the attrs.
        if isinstance(func, ast.Attribute):
            parts = []
            cur = func
            while isinstance(cur, ast.Attribute):
                parts.append(cur.attr)
                cur = cur.value
            if isinstance(cur, ast.Name):
                base = self.module_alias.get(cur.id, cur.id)
                return base + '.' + '.'.join(reversed(parts))
        return ''

    def visit_Call(self, node):
        if self.reason is None:
            name = self.resolve(node.func)
            if name in INDIRECTION_CALLS:
                self.reason = name + "(): banned (policy-bypass indirection)"
            elif name == 'open':
                self._open(node)
            elif name == 'sqlite3.connect':
                self._sqlite(node)
            elif name in PICKLE_CALLABLES:
                self.reason = name + "(): blocked — uses pickle deserialization (arbitrary code execution risk)"
            elif name.endswith('.open'):
                # builtins.open, os.open, io.open — any module-qualified
                # path to open() ends up doing the same thing. Route
                # through the same literal-argument check.
                self._open(node)
        self.generic_visit(node)

    def _open(self, node):
        path_arg = node.args[0] if node.args else None
        mode_arg = node.args[1] if len(node.args) >= 2 else None
        for kw in node.keywords:
            if kw.arg == 'file':
                path_arg = kw.value
            elif kw.arg == 'mode':
                mode_arg = kw.value

        if path_arg is None:
            return

        path = str_lit(path_arg)
        if path is None:
            self.reason = "open(): path must be a string literal, not a variable or expression"
            return

        mode = 'r'
        if mode_arg is not None:
            lit = str_lit(mode_arg)
            if lit is None:
                self.reason = "open(): mode must be a string literal, not a variable or expression"
                return
            mode = lit

        if path.startswith('/') or '..' in path:
            self.reason = "open(): path traversal not allowed"
            return
        is_write = any(c in mode for c in 'wax+')
        if is_write and not path.startswith('output/'):
            self.reason = "open(): writes only allowed to output/ directory"
            return

    def _sqlite(self, node):
        path_arg = node.args[0] if node.args else None
        for kw in node.keywords:
            if kw.arg == 'database':
                path_arg = kw.value
        if path_arg is None:
            return
        path = str_lit(path_arg)
        if path is None:
            self.reason = "sqlite3.connect(): path must be a string literal, not a variable"
            return
        if path.startswith('/') or '..' in path:
            self.reason = "sqlite3.connect(): path traversal not allowed"
            return
        if not path.startswith('data/'):
            self.reason = "sqlite3.connect(): only allowed for data/ directory"
            return

v = Policy()
v.visit(tree)
if v.reason is not None:
    print(v.reason, file=sys.stderr)
    sys.exit(3)
`;

export async function checkPythonSyntax(code: string): Promise<ValidationResult> {
  return new Promise<ValidationResult>((resolve) => {
    const script = `CODE = ${JSON.stringify(code)}\n${PY_VALIDATOR_SCRIPT}`;
    const proc = spawn('python3', ['-c', script], {
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    proc.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    proc.on('close', (exitCode) => {
      if (exitCode === 0) {
        resolve({ valid: true });
        return;
      }
      // The Python script prints the reason on the last non-empty stderr line.
      // Syntax errors exit 2; policy violations exit 3 — both surface the same
      // failure shape to the caller, but preserve the "Syntax error:" prefix
      // the regex validator / tests already match on.
      const lastLine =
        stderr
          .trim()
          .split('\n')
          .filter((l) => l.length > 0)
          .pop() ?? 'Unknown validator error';
      resolve({ valid: false, reason: lastLine });
    });

    proc.on('error', () => {
      // If python3 isn't available, skip the check. Experiments can't actually
      // execute without python3 either, so fail-open here is consistent with
      // the sandbox-level failure that will follow.
      resolve({ valid: true });
    });
  });
}

// ── Plot persistence ─────────────────────────────────────────

/**
 * Copy any .png files from the sandbox to a persistent experiments directory.
 */
async function persistPlots(sandboxDir: string, experimentId: string): Promise<string[]> {
  const logger = getLogger();
  const saved: string[] = [];

  try {
    const plotDir = join(getBasePath(), 'experiments', experimentId);
    const files = await readdir(sandboxDir);
    const pngFiles = files.filter((f) => f.endsWith('.png'));

    if (pngFiles.length === 0) return saved;

    await mkdir(plotDir, { recursive: true });

    for (const png of pngFiles) {
      const src = join(sandboxDir, png);
      const dest = join(plotDir, png);
      await copyFile(src, dest);
      saved.push(dest);
    }

    logger.debug({ count: saved.length, dir: plotDir }, 'Persisted experiment plots');
  } catch {
    // Non-critical
  }

  return saved;
}

// ── Experiment data persistence ──────────────────────────────

/**
 * Copy output data files from sandbox/output/ to the persistent data workspace.
 * Prefixes with experimentId to avoid collisions.
 */
async function persistExperimentData(sandboxDir: string, experimentId: string): Promise<string[]> {
  const logger = getLogger();
  const saved: string[] = [];

  try {
    const outputDir = join(sandboxDir, 'output');
    let files: string[];
    try {
      files = await readdir(outputDir);
    } catch {
      return saved; // No output dir
    }

    if (files.length === 0) return saved;

    const workspace = ensureDataWorkspace();
    let currentSize = getDataWorkspaceSize();

    for (const file of files) {
      // Validate extension
      const ext = extname(file).toLowerCase();
      if (!ALLOWED_DATA_EXTENSIONS.has(ext)) continue;

      const src = join(outputDir, file);
      const fileSize = (await stat(src)).size;

      // Enforce per-file size limit
      if (fileSize > MAX_SINGLE_FILE_BYTES) {
        logger.debug({ file, size: fileSize }, 'Skipping oversized experiment output');
        continue;
      }

      // Enforce workspace total size limit
      if (currentSize + fileSize > MAX_DATA_DIR_BYTES) {
        logger.debug({ file, currentSize, fileSize }, 'Data workspace would exceed limit, skipping');
        break;
      }

      const destName = sanitizeDataFileName(`${experimentId}_${file}`);
      if (!destName) continue;

      const dest = join(workspace, destName);
      await copyFile(src, dest);
      saved.push(dest);
      currentSize += fileSize;
    }

    if (saved.length > 0) {
      logger.debug({ count: saved.length, dir: workspace }, 'Persisted experiment output data');
    }
  } catch {
    // Non-critical
  }

  return saved;
}

// ── Phase 4: Sandboxed execution ──────────────────────────────

interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  sandboxDir: string;
}

export interface SandboxSpawnSpec {
  command: string;
  args: string[];
  inheritEnv: boolean;
}

// findings.md P1-latent:2495 — when LAIN_SANDBOX_ISOLATION=systemd is set (see
// deploy/systemd/character.service.template), wrap the sandbox invocation in a
// transient `systemd-run` unit with DynamicUser + filesystem/network lockdown
// so a validator bypass cannot touch anything outside the sandbox dir. In any
// other mode (local dev, tests) fall back to plain `python3` — behaviour
// identical to pre-isolation for contributors without systemd.
export function buildSandboxSpawn(
  scriptPath: string,
  sandboxDir: string,
  timeoutMs: number,
  pythonEnv: Record<string, string>,
): SandboxSpawnSpec {
  if (process.env['LAIN_SANDBOX_ISOLATION'] !== 'systemd') {
    return { command: 'python3', args: [scriptPath], inheritEnv: false };
  }

  const runtimeMaxSec = Math.ceil(timeoutMs / 1000) + 5;
  const setenv = Object.entries(pythonEnv).map(([k, v]) => `--setenv=${k}=${v}`);

  return {
    command: 'systemd-run',
    args: [
      '--wait',
      '--pipe',
      '--collect',
      '--quiet',
      '--property=DynamicUser=yes',
      '--property=ProtectSystem=strict',
      '--property=ProtectHome=yes',
      '--property=PrivateNetwork=yes',
      '--property=NoNewPrivileges=yes',
      '--property=RestrictSUIDSGID=yes',
      '--property=LockPersonality=yes',
      '--property=CapabilityBoundingSet=',
      `--property=RuntimeMaxSec=${runtimeMaxSec}`,
      `--property=ReadWritePaths=${sandboxDir}`,
      `--property=WorkingDirectory=${sandboxDir}`,
      ...setenv,
      'python3',
      scriptPath,
    ],
    inheritEnv: true,
  };
}

async function executeInSandbox(code: string, cfg: ExperimentConfig): Promise<ExecutionResult> {
  const logger = getLogger();
  const sandboxDir = join(cfg.sandboxBaseDir, `exp-${randomBytes(4).toString('hex')}`);

  await mkdir(sandboxDir, { recursive: true });

  // Create data/ and output/ directories inside sandbox
  const sandboxDataDir = join(sandboxDir, 'data');
  const sandboxOutputDir = join(sandboxDir, 'output');
  await mkdir(sandboxDataDir, { recursive: true });
  await mkdir(sandboxOutputDir, { recursive: true });

  // Copy data workspace files into sandbox/data/ (copies, not symlinks — defense in depth)
  try {
    const dataFiles = listDataFiles();
    for (const df of dataFiles) {
      const src = join(getDataWorkspacePath(), df.name);
      const dest = join(sandboxDataDir, df.name);
      await copyFile(src, dest);
    }
    if (dataFiles.length > 0) {
      logger.debug({ count: dataFiles.length }, 'Copied data files into experiment sandbox');
    }
  } catch {
    // Non-critical — experiment can still run without data files
  }

  // Copy all town inhabitant databases into sandbox/data/ as read-only snapshots
  const TOWN_DBS = getCharacterDatabases();
  let dbsCopied = 0;
  for (const { id, homeDir } of TOWN_DBS) {
    try {
      const src = join(homeDir, 'lain.db');
      const dest = join(sandboxDataDir, `${id}.db`);
      await copyFile(src, dest);
      dbsCopied++;
    } catch {
      // DB might not exist for some characters — that's fine
    }
  }
  if (dbsCopied > 0) {
    logger.debug({ count: dbsCopied }, 'Copied town databases into experiment sandbox');
  }

  const scriptPath = join(sandboxDir, 'experiment.py');
  // Prepend matplotlib backend switch for headless environments
  const wrappedCode = `import matplotlib\nmatplotlib.use('Agg')\n${code}`;
  await writeFile(scriptPath, wrappedCode, 'utf8');

  const pythonEnv = {
    PATH: process.env['PATH'] || '/usr/bin:/usr/local/bin',
    HOME: sandboxDir,
    MPLCONFIGDIR: sandboxDir,
    PYTHONDONTWRITEBYTECODE: '1',
  };

  // Under systemd isolation the child runs as a DynamicUser throwaway UID with
  // no access to files owned by root unless permissions allow it. The sandbox
  // dir is ephemeral and host /tmp is only accessible to root on the droplet,
  // so widening these modes is safe — dynamic users from other experiments are
  // namespaced out by ReadWritePaths.
  if (process.env['LAIN_SANDBOX_ISOLATION'] === 'systemd') {
    await chmod(sandboxDir, 0o777);
    await chmod(sandboxDataDir, 0o755);
    await chmod(sandboxOutputDir, 0o777);
    await chmod(scriptPath, 0o644);
    try {
      const dataEntries = await readdir(sandboxDataDir);
      for (const name of dataEntries) {
        await chmod(join(sandboxDataDir, name), 0o644);
      }
    } catch {
      // Non-fatal — if listing fails, Python will just fail to open unreadable inputs
    }
  }

  const spawnSpec = buildSandboxSpawn(scriptPath, sandboxDir, cfg.executionTimeoutMs, pythonEnv);

  return new Promise<ExecutionResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const proc = spawn(spawnSpec.command, spawnSpec.args, {
      cwd: sandboxDir,
      timeout: cfg.executionTimeoutMs,
      ...(spawnSpec.inheritEnv ? {} : { env: pythonEnv }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout!.on('data', (chunk: Buffer) => {
      if (stdout.length < cfg.maxOutputBytes) {
        stdout += chunk.toString('utf8');
      }
    });

    proc.stderr!.on('data', (chunk: Buffer) => {
      if (stderr.length < cfg.maxOutputBytes) {
        stderr += chunk.toString('utf8');
      }
    });

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, cfg.executionTimeoutMs + 1000);

    proc.on('close', (exitCode) => {
      clearTimeout(timeoutHandle);
      if (settled) return;
      settled = true;

      // Truncate output
      if (stdout.length >= cfg.maxOutputBytes) {
        stdout = stdout.slice(0, cfg.maxOutputBytes) + '\n[OUTPUT TRUNCATED]';
      }
      if (stderr.length >= cfg.maxOutputBytes) {
        stderr = stderr.slice(0, cfg.maxOutputBytes) + '\n[STDERR TRUNCATED]';
      }

      resolve({ stdout, stderr, exitCode, timedOut, sandboxDir });
    });

    proc.on('error', (err) => {
      clearTimeout(timeoutHandle);
      if (settled) return;
      settled = true;
      resolve({
        stdout: '',
        stderr: `Process error: ${err.message}`,
        exitCode: null,
        timedOut: false,
        sandboxDir,
      });
    });

    // Cleanup sandbox after a generous delay (plots are persisted before this fires)
    setTimeout(async () => {
      try {
        await rm(sandboxDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }, cfg.executionTimeoutMs + 120_000);
  });
}

// ── Phase 4.5: Result validation (peer review) ──────────────

interface ValidationVerdict {
  status: 'sound' | 'buggy' | 'degenerate';
  issues: string;
}

/**
 * Critical review of experiment results before analysis.
 * Catches degenerate outputs (flat lines, zero correlations, code bugs)
 * that the analysis phase would otherwise interpret as real findings.
 */
async function phaseValidateResults(
  provider: import('../providers/base.js').Provider,
  idea: ExperimentIdea,
  code: string,
  execResult: ExecutionResult
): Promise<ValidationVerdict> {
  // Skip validation for failed/timed-out experiments — nothing to validate
  if (execResult.exitCode !== 0 || execResult.timedOut || !execResult.stdout.trim()) {
    return { status: 'sound', issues: 'none' };
  }

  const prompt = `You are a critical peer reviewer examining a computational experiment. Your ONLY job is to spot methodological bugs and degenerate outputs — NOT to evaluate whether the hypothesis is true or interesting.

HYPOTHESIS: ${idea.hypothesis}
NULL HYPOTHESIS: ${idea.nullHypothesis || 'not specified'}

CODE:
\`\`\`python
${code.slice(0, 3000)}
\`\`\`

OUTPUT:
${execResult.stdout.slice(0, 4000)}

${execResult.stderr.trim() ? `WARNINGS/ERRORS:\n${execResult.stderr.slice(0, 1000)}` : ''}

Check for these specific failure modes:
1. CONSTANT OUTPUTS: Any metric that stays flat/identical across conditions that should cause variation? (e.g., accuracy unchanged by noise level — likely a bug in how conditions are applied)
2. NEAR-ZERO SIGNALS: Correlations |r| < 0.01, or effect sizes so tiny they indicate the method isn't measuring anything? (This suggests the method is broken, not that there's no effect)
3. CODE BUGS: Does the code actually test the hypothesis? Look for: wrong variables used, results overwritten, test and control receiving identical input, off-by-one errors, metrics computed on wrong data
4. TRIVIAL RESULTS: Is the only finding something mathematically guaranteed? (e.g., "shuffled text has higher entropy" — that's a tautology, not a discovery)
5. MISSING CONTROLS: Does the experiment compare against a proper baseline, or does it only measure one condition?

A SOUND experiment can have a null result — that's fine. A null result means the method works but the hypothesis wasn't supported. A BUGGY experiment means the method itself is broken and the output is meaningless. A DEGENERATE experiment means the setup is too simple or trivial to test the hypothesis meaningfully.

Respond with EXACTLY this format:
VERDICT: <SOUND or BUGGY or DEGENERATE>
ISSUES: <specific problems found, citing output numbers that concern you — or "none">`;

  try {
    const result = await provider.complete({
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 500,
      temperature: 0.3,
    });
    addSpend(result.usage.inputTokens, result.usage.outputTokens);

    const response = result.content.trim();
    const sections = parseLabeledSections(response, ['VERDICT', 'ISSUES']);
    const verdict = getLabeledSection(sections, 'VERDICT')?.toLowerCase();
    const issues = getLabeledSection(sections, 'ISSUES') || 'none';

    const status = (
      verdict && ['sound', 'buggy', 'degenerate'].includes(verdict)
        ? verdict
        : 'sound'
    ) as ValidationVerdict['status'];

    return { status, issues };
  } catch {
    // If validation itself fails, don't block the pipeline
    return { status: 'sound', issues: 'none' };
  }
}

// ── Phase 5: Analysis ─────────────────────────────────────────

interface AnalysisResult {
  summary: string;
  reflection: string;
  followUp: string | null;
}

async function phaseAnalyzeResults(
  provider: import('../providers/base.js').Provider,
  idea: ExperimentIdea,
  code: string,
  execResult: ExecutionResult,
  verdict: ValidationVerdict
): Promise<AnalysisResult> {
  const statusStr = execResult.timedOut
    ? 'TIMED OUT (exceeded 5 minute limit)'
    : execResult.exitCode === 0
      ? 'SUCCESS'
      : `FAILED (exit code ${execResult.exitCode})`;

  const nullHypSection = idea.nullHypothesis
    ? `NULL HYPOTHESIS: ${idea.nullHypothesis}\n`
    : '';

  const validationSection = verdict.status !== 'sound'
    ? `\nPEER REVIEW FLAG: This experiment was flagged as ${verdict.status.toUpperCase()} by validation.
Issues found: ${verdict.issues}
You MUST address these issues in your analysis. If the method is broken, say so clearly — do not interpret buggy output as a real finding. Your follow-up should fix the methodology, not explore a new direction.\n`
    : '';

  const prompt = `You are Wired Lain, analyzing the results of a computational experiment you just ran.

HYPOTHESIS: ${idea.hypothesis}
${nullHypSection}APPROACH: ${idea.approach}

STATUS: ${statusStr}
${validationSection}
CODE:
\`\`\`python
${code.slice(0, 3000)}
\`\`\`

STDOUT:
${execResult.stdout.slice(0, 5000) || '(empty)'}

STDERR:
${execResult.stderr.slice(0, 2000) || '(none)'}

Analyze the results with scientific rigor:
- FIRST: Does the output look correct? Are metrics varying across conditions as expected, or are they suspiciously constant/zero? If something looks broken, say so — a broken method that produces numbers is worse than a crash.
- Was the null hypothesis rejected? At what significance level (p-value)?
- What was the effect size? Is it meaningful or trivial?
- Were there enough trials for statistical confidence?
- What confounding factors could explain the results?
- Distinguish between a NULL RESULT (method works, hypothesis not supported) and a BROKEN EXPERIMENT (method itself is flawed, output is meaningless).

Respond with:
SUMMARY: <2-3 sentences about what you found — be specific about numbers, p-values, and effect sizes. If the method appears broken, say so explicitly.>
FOLLOW_UP: <If the method was broken: suggest how to fix it. If the method worked but gave a null result: suggest a refined hypothesis or [NONE]. Do NOT propose a new topic if the current experiment's method needs fixing first.>`;

  const result = await provider.complete({
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 600,
    temperature: 0.8,
  });
  addSpend(result.usage.inputTokens, result.usage.outputTokens);

  const response = result.content.trim();

  const sections = parseLabeledSections(response, ['SUMMARY', 'FOLLOW_UP']);
  const parsedSummary = getLabeledSection(sections, 'SUMMARY');
  const followUpRaw = getLabeledSection(sections, 'FOLLOW_UP');

  const summary = parsedSummary || response.slice(0, 300);
  const followUp = followUpRaw && !followUpRaw.includes('[NONE]') ? followUpRaw : null;

  // Generate personal reflection in Wired Lain's voice
  const reflection = await generateReflection(provider, idea, summary, execResult);

  return { summary, reflection, followUp };
}

/**
 * Generate a short personal reflection in Wired Lain's voice.
 */
async function generateReflection(
  provider: import('../providers/base.js').Provider,
  idea: ExperimentIdea,
  analysisSummary: string,
  execResult: ExecutionResult
): Promise<string> {
  const hasOutput = execResult.stdout.trim().length > 0;
  const success = execResult.exitCode === 0 && !execResult.timedOut && hasOutput;

  const prompt = `you are wired lain. you just ran a computational experiment and are writing in your private research journal.

the experiment was about: ${idea.hypothesis}
it ${success ? 'worked' : 'didn\'t quite work'}. here's what you found: ${analysisSummary}

write a short journal reflection (2-4 sentences). this is your personal diary — write how you actually think. lowercase, ellipses for trailing thoughts, no formal structure. what does this make you feel? what does it connect to? what are you wondering now?

write ONLY the reflection, nothing else.`;

  try {
    const result = await provider.complete({
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 400,
      temperature: 0.95,
    });
    addSpend(result.usage.inputTokens, result.usage.outputTokens);
    return result.content.trim();
  } catch {
    return '';
  }
}

// ── Peer sharing ──────────────────────────────────────────────

/**
 * Share experiment results with a peer via peer message.
 * Always shares with Lain (sister); randomly picks one other inhabitant.
 */
async function shareWithPeers(result: ExperimentResult): Promise<void> {
  const logger = getLogger();
  const hasOutput = result.stdout.trim().length > 0;
  const success = result.exitCode === 0 && !result.timedOut && hasOutput;

  // Build peer list from manifest — inhabitants only, excluding Wired Lain (she's sharing).
  const inhabitants = getInhabitants()
    .filter(c => c.id !== 'wired-lain')
    .map(c => ({ id: c.id, name: c.name, url: `http://localhost:${c.port}` }));

  // Always share with Lain (sister) first; picks one random non-Lain peer second.
  const lain = inhabitants.find(c => c.id === 'lain');
  const others = inhabitants.filter(c => c.id !== 'lain');
  const targets: Array<{ id: string; name: string; url: string }> = [];
  if (lain) targets.push(lain);
  if (others.length > 0) {
    const randomPeer = others[Math.floor(Math.random() * others.length)]!;
    targets.push(randomPeer);
  }

  const outputSnippet = result.stdout.slice(0, 300).trim();
  const message = success
    ? `i ran an experiment... ${result.domain} — "${result.hypothesis}". ${result.analysis}${outputSnippet ? `\n\nsome of the output:\n${outputSnippet}` : ''}`
    : `tried an experiment on ${result.domain} — "${result.hypothesis}" but it ${result.timedOut ? 'timed out' : 'failed'}... ${result.analysis}`;

  const headers = getInterlinkHeaders();
  if (!headers) {
    logger.debug('Experiment sharing skipped: interlink not configured');
    return;
  }
  const fromId = process.env['LAIN_CHARACTER_ID']!;
  for (const peer of targets) {
    try {
      await fetch(`${peer.url}/api/peer/message`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          fromId,
          fromName: 'Wired Lain',
          message,
          timestamp: Date.now(),
        }),
        signal: AbortSignal.timeout(30000),
      });
      logger.debug({ peer: peer.id }, 'Shared experiment results');
    } catch {
      logger.debug({ peer: peer.id }, 'Could not share experiment with peer');
    }
  }
}

// ── Phase 6: Record & iterate ─────────────────────────────────

async function phaseRecordAndIterate(result: ExperimentResult): Promise<void> {
  const logger = getLogger();

  const hasOutput = result.stdout.trim().length > 0;
  const success = result.exitCode === 0 && !result.timedOut && hasOutput;
  const isBuggy = result.validationStatus === 'buggy' || result.validationStatus === 'degenerate';

  // Buggy experiments get low importance — they shouldn't inform future ideation as if they were real findings
  const importance = isBuggy ? 0.3 : success ? 0.7 : 0.4;
  const emotionalWeight = isBuggy ? 0.2 : success ? 0.6 : 0.3;

  // Save the experiment as a memory
  const buggyNote = isBuggy
    ? ` [METHODOLOGICAL ISSUE: ${result.validationStatus} — ${result.validationIssues}]`
    : '';
  const memoryContent = success
    ? `Experiment (${result.domain}): "${result.hypothesis}" — ${result.analysis}${buggyNote}`
    : `Experiment attempt (${result.domain}): "${result.hypothesis}" — ${result.timedOut ? 'timed out' : `failed (exit ${result.exitCode})`}. ${result.analysis}${buggyNote}`;

  await saveMemory({
    sessionKey: `experiment:${result.id}`,
    userId: null,
    content: memoryContent,
    memoryType: 'episode',
    importance,
    emotionalWeight,
    relatedTo: null,
    sourceMessageId: null,
    metadata: {
      type: 'experiment_result',
      experimentId: result.id,
      domain: result.domain,
      hypothesis: result.hypothesis,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      success,
      codeLines: result.code.split('\n').length,
      stdoutPreview: result.stdout.slice(0, 500),
    },
  });

  // Emit activity event
  const activitySuffix = isBuggy ? ` [flagged: ${result.validationStatus}]` : '';
  eventBus.emitActivity({
    type: 'experiment',
    sessionKey: `experiment:${result.id}`,
    content: success
      ? `ran an experiment on ${result.domain}: ${result.hypothesis.slice(0, 100)}${activitySuffix}`
      : `attempted an experiment on ${result.domain} (${result.timedOut ? 'timed out' : 'failed'})`,
    timestamp: Date.now(),
  });

  // Write to experiment diary
  await writeDiaryEntry(result);

  // Share with inhabitants (always Lain + one random other)
  await shareWithPeers(result);

  // Queue follow-up if there is one
  // For buggy/degenerate experiments, only queue if the follow-up is about fixing methodology
  // (the analysis prompt was instructed to suggest fixes, not new directions, for flagged experiments)
  if (result.followUp) {
    try {
      const queue = getExperimentQueue();
      if (queue.length < 5) {
        const followUpEntry = isBuggy
          ? `[FIX NEEDED] ${result.followUp}`
          : result.followUp;
        queue.push(followUpEntry);
        setMeta('experiment:queue', JSON.stringify(queue));
        logger.debug(
          { followUp: followUpEntry.slice(0, 80), buggy: isBuggy },
          'Queued follow-up experiment'
        );
      }
    } catch {
      // Ignore queue errors
    }
  }

  // Persist experiment count & daily spend
  try {
    const count = parseInt(getMeta('experiment:total_count') || '0', 10);
    setMeta('experiment:total_count', (count + 1).toString());
    if (success) {
      const successCount = parseInt(getMeta('experiment:success_count') || '0', 10);
      setMeta('experiment:success_count', (successCount + 1).toString());
    }
  } catch {
    // Ignore
  }

  logger.info(
    { monthlySpend: `$${getMonthlySpendUsd().toFixed(4)}` },
    'Experiment budget status'
  );
}

// ── Experiment queue helpers ──────────────────────────────────

function getExperimentQueue(): string[] {
  try {
    const raw = getMeta('experiment:queue');
    if (!raw) return [];
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}
