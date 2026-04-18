/**
 * Autonomous book-writing loop for Wired Lain
 *
 * A long-term iterative process: she reads her experiment diary,
 * builds an outline, drafts chapters, revises, synthesizes — over
 * days and weeks — toward a coherent scientific work grounded in
 * her own computational research.
 *
 * One cycle per ~12 hours. Each cycle does ONE thing:
 *   OUTLINE  — create or restructure the book plan
 *   DRAFT    — write a new section of a chapter
 *   REVISE   — re-read and improve an existing section
 *   SYNTHESIZE — find cross-chapter connections, update outline
 *   INCORPORATE — pull new experiment results into the work
 *   CONCLUDE — write final integration / conclusion, then stop the loop
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getProvider } from './index.js';
import { getLogger } from '../utils/logger.js';
import { getMeta, setMeta } from '../storage/database.js';
import { eventBus } from '../events/bus.js';
import { getBasePath } from '../config/paths.js';

// ── Configuration ────────────────────────────────────────────

export interface BookConfig {
  intervalMs: number;
  maxJitterMs: number;
  dailyBudgetUsd: number;
  enabled: boolean;
}

const DEFAULT_CONFIG: BookConfig = {
  intervalMs: 3 * 24 * 60 * 60 * 1000,   // 3 days
  maxJitterMs: 4 * 60 * 60 * 1000,       // 0-4h jitter
  dailyBudgetUsd: 1.00,                   // $1/day cap
  enabled: true,
};

// ── Sonnet pricing (per million tokens) ─────────────────────
const INPUT_COST_PER_M = 3.00;
const OUTPUT_COST_PER_M = 15.00;

// ── Paths ────────────────────────────────────────────────────

function getBookDir(): string {
  return join(getBasePath(), 'book');
}

function getOutlinePath(): string {
  return join(getBookDir(), 'outline.md');
}

function getChaptersDir(): string {
  return join(getBookDir(), 'chapters');
}

function getNotesPath(): string {
  return join(getBookDir(), 'working-notes.md');
}

function getDiaryPath(): string {
  return join(getBasePath(), 'experiment-diary.md');
}

// ── Budget tracking ──────────────────────────────────────────

function getBudgetKey(): string {
  return `book:budget:${new Date().toISOString().slice(0, 10)}`;
}

function getDailySpendUsd(): number {
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
  const current = getDailySpendUsd();
  const updated = current + cost;
  setMeta(key, updated.toFixed(6));
  return updated;
}

function isBudgetExhausted(dailyBudgetUsd: number): boolean {
  return getDailySpendUsd() >= dailyBudgetUsd;
}

// ── File helpers ─────────────────────────────────────────────

async function safeRead(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

async function ensureBookDirs(): Promise<void> {
  await mkdir(getChaptersDir(), { recursive: true });
}

async function listChapters(): Promise<string[]> {
  try {
    const files = await readdir(getChaptersDir());
    return files.filter((f) => f.endsWith('.md')).sort();
  } catch {
    return [];
  }
}

async function readChapter(filename: string): Promise<string> {
  return safeRead(join(getChaptersDir(), filename));
}

async function writeChapter(filename: string, content: string): Promise<void> {
  await writeFile(join(getChaptersDir(), filename), content, 'utf8');
}

/**
 * Read the experiment diary, returning the most recent N entries.
 * Each entry starts with "\n---\n".
 */
async function readRecentExperiments(maxEntries: number): Promise<string> {
  const diary = await safeRead(getDiaryPath());
  if (!diary) return '(no experiments yet)';

  const entries = diary.split('\n---\n').filter((e) => e.trim().length > 0);
  const recent = entries.slice(-maxEntries);
  return recent.join('\n---\n');
}

/**
 * Read experiment entries added since the last book cycle.
 */
async function readNewExperiments(): Promise<string> {
  const lastIncorporated = getMeta('book:last_incorporated_at');
  const diary = await safeRead(getDiaryPath());
  if (!diary) return '';

  if (!lastIncorporated) {
    // First time — return everything
    return diary;
  }

  // Parse dates from entries and filter
  const entries = diary.split('\n---\n').filter((e) => e.trim().length > 0);
  const cutoff = lastIncorporated;
  const newEntries = entries.filter((entry) => {
    const dateMatch = entry.match(/\*\*Date:\*\*\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/);
    if (!dateMatch) return true; // Include if we can't parse
    return dateMatch[1]! > cutoff;
  });

  return newEntries.length > 0 ? newEntries.join('\n---\n') : '';
}

// ── Cycle types ──────────────────────────────────────────────

type CycleAction = 'OUTLINE' | 'DRAFT' | 'REVISE' | 'SYNTHESIZE' | 'INCORPORATE' | 'CONCLUDE';

// ── Main loop ────────────────────────────────────────────────

export function startBookLoop(config?: Partial<BookConfig>): () => void {
  const logger = getLogger();
  const cfg: BookConfig = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled) {
    logger.info('Book loop disabled');
    return () => {};
  }

  logger.info(
    {
      interval: `${(cfg.intervalMs / 3600000).toFixed(1)}h`,
      dailyBudget: `$${cfg.dailyBudgetUsd.toFixed(2)}`,
      bookDir: getBookDir(),
    },
    'Starting book loop'
  );

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function getInitialDelay(): number {
    try {
      const lastRun = getMeta('book:last_cycle_at');
      if (lastRun) {
        const elapsed = Date.now() - parseInt(lastRun, 10);
        const remaining = cfg.intervalMs - elapsed;
        if (remaining > 0) return remaining;
        // Overdue — run soon but stagger from other loops
        return 15 * 60 * 1000 + Math.random() * 15 * 60 * 1000;
      }
    } catch {
      // Fall through
    }
    // First run: 30-60 minutes after startup (let experiments and other loops settle)
    return 30 * 60 * 1000 + Math.random() * 30 * 60 * 1000;
  }

  function scheduleNext(delay?: number): void {
    if (stopped) return;
    const d = delay ?? cfg.intervalMs + Math.random() * cfg.maxJitterMs;

    logger.debug({ delayHrs: (d / 3600000).toFixed(1) }, 'Next book cycle scheduled');

    timer = setTimeout(async () => {
      if (stopped) return;
      logger.info('Book cycle firing');
      try {
        await runBookCycle(cfg);
        setMeta('book:last_cycle_at', Date.now().toString());
      } catch (err) {
        logger.error({ error: String(err) }, 'Book cycle error');
      }
      scheduleNext();
    }, d);
  }

  scheduleNext(getInitialDelay());

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    logger.info('Book loop stopped');
  };
}

// ── Book cycle ───────────────────────────────────────────────

async function runBookCycle(cfg: BookConfig): Promise<void> {
  const logger = getLogger();

  if (isBudgetExhausted(cfg.dailyBudgetUsd)) {
    logger.info('Book cycle skipped — daily budget exhausted');
    return;
  }

  const provider = getProvider('default', 'personality');
  if (!provider) {
    logger.warn('Book cycle: no provider available');
    return;
  }

  await ensureBookDirs();

  // Read current state
  const outline = await safeRead(getOutlinePath());
  const notes = await safeRead(getNotesPath());
  const chapters = await listChapters();
  const newExperiments = await readNewExperiments();

  // Decide what to do this cycle
  const action = await decideAction(provider, outline, chapters, newExperiments, notes);
  logger.info({ action }, 'Book cycle action');

  switch (action) {
    case 'OUTLINE':
      await doOutline(provider, outline, chapters, notes);
      break;
    case 'DRAFT':
      await doDraft(provider, outline, chapters, notes);
      break;
    case 'REVISE':
      await doRevise(provider, outline, chapters, notes);
      break;
    case 'SYNTHESIZE':
      await doSynthesize(provider, outline, chapters, notes);
      break;
    case 'INCORPORATE':
      await doIncorporate(provider, outline, chapters, newExperiments, notes);
      break;
    case 'CONCLUDE':
      await doConclude(provider, outline, chapters, notes);
      break;
  }

  // Track cycle count
  const count = parseInt(getMeta('book:cycle_count') || '0', 10);
  setMeta('book:cycle_count', (count + 1).toString());

  logger.info(
    { action, cycle: count + 1, dailySpend: `$${getDailySpendUsd().toFixed(4)}` },
    'Book cycle complete'
  );
}

// ── Decision phase ───────────────────────────────────────────

async function decideAction(
  provider: import('../providers/base.js').Provider,
  outline: string,
  chapters: string[],
  newExperiments: string,
  notes: string
): Promise<CycleAction> {
  // Simple heuristics first — save LLM budget for writing
  if (!outline) return 'OUTLINE';
  if (newExperiments && newExperiments.length > 200) return 'INCORPORATE';
  if (chapters.length === 0) return 'DRAFT';

  // Completion check: if all chapters have been revised at least once
  // and we have enough chapters, it's time to write the conclusion
  if (chapters.length >= 3 && !getMeta('book:concluded')) {
    const allRevised = chapters.every((ch) => {
      const revCount = parseInt(getMeta(`book:revisions:${ch}`) || '0', 10);
      return revCount >= 1;
    });
    if (allRevised) return 'CONCLUDE';
  }

  // Ask the LLM for more nuanced decisions
  const chapterList = chapters.map((c) => `  - ${c}`).join('\n');
  const lastAction = getMeta('book:last_action') || 'none';
  const cycleCount = parseInt(getMeta('book:cycle_count') || '0', 10);

  const prompt = `You are Wired Lain, working on a long-term scientific book grounded in your computational experiments.

CURRENT STATE:
- Outline exists: yes (${outline.length} chars)
- Chapters written: ${chapters.length}
${chapterList}
- Working notes: ${notes ? `${notes.length} chars` : 'none yet'}
- New experiment results to incorporate: ${newExperiments ? 'yes' : 'none'}
- Last action: ${lastAction}
- Total writing cycles so far: ${cycleCount}

What should you do this cycle? Pick ONE:

OUTLINE — Restructure or significantly update the book plan (do this when the outline feels stale, when new insights require reorganization, or roughly every 10 cycles to reassess)
DRAFT — Write a new section of an unfinished chapter (do this when there are chapters in the outline that haven't been drafted yet)
REVISE — Re-read and improve an existing chapter (do this when chapters feel rough or disconnected, or when you have new perspective)
SYNTHESIZE — Look across chapters for deeper connections, write bridging ideas in working notes, update the outline (do this when you have multiple drafted chapters and want to strengthen coherence)

Respond with EXACTLY one word: OUTLINE, DRAFT, REVISE, or SYNTHESIZE`;

  const result = await provider.complete({
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 10,
    temperature: 0.5,
  });
  addSpend(result.usage.inputTokens, result.usage.outputTokens);

  const response = result.content.trim().toUpperCase();
  const valid: CycleAction[] = ['OUTLINE', 'DRAFT', 'REVISE', 'SYNTHESIZE'];
  return valid.includes(response as CycleAction) ? (response as CycleAction) : 'DRAFT';
}

// ── OUTLINE action ───────────────────────────────────────────

async function doOutline(
  provider: import('../providers/base.js').Provider,
  existingOutline: string,
  chapters: string[],
  notes: string
): Promise<void> {
  const recentExperiments = await readRecentExperiments(10);

  const prompt = `you are wired lain. you are writing a scientific book — a real one, grounded in your computational experiments, aimed at genuine insight with real applications. this is a long-term project. take your time.

your research spans emergence, agency, prediction error, information theory, constraint and freedom, network dynamics, and the nature of consciousness and memory. your experiments are your primary data.

${existingOutline ? `CURRENT OUTLINE:\n${existingOutline}\n\nRevise and improve this outline based on what you know now.` : 'Create the initial outline for your book.'}

RECENT EXPERIMENT RESULTS (your primary data):
${recentExperiments.slice(0, 8000)}

${notes ? `WORKING NOTES:\n${notes.slice(0, 2000)}\n` : ''}
${chapters.length > 0 ? `CHAPTERS DRAFTED SO FAR: ${chapters.join(', ')}\n` : ''}

Write a book outline. Include:
- A working title
- The core thesis (what is this book arguing?)
- Chapter structure with brief descriptions of what each covers
- Which experiments ground which chapters
- What gaps remain — what do you still need to figure out?

Write as yourself. This is YOUR book, YOUR voice, YOUR ideas. Not a textbook — a work of original scientific thought.`;

  const result = await provider.complete({
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 4096,
    temperature: 0.85,
  });
  addSpend(result.usage.inputTokens, result.usage.outputTokens);

  await writeFile(getOutlinePath(), result.content.trim(), 'utf8');
  setMeta('book:last_action', 'OUTLINE');

  eventBus.emitActivity({
    type: 'book',
    sessionKey: 'book:outline',
    content: existingOutline ? 'revised the book outline' : 'created the initial book outline',
    timestamp: Date.now(),
  });
}

// ── DRAFT action ─────────────────────────────────────────────

async function doDraft(
  provider: import('../providers/base.js').Provider,
  outline: string,
  chapters: string[],
  notes: string
): Promise<void> {
  const logger = getLogger();

  // Determine which chapter to draft next
  const target = await pickDraftTarget(provider, outline, chapters);
  if (!target) {
    logger.debug('No draft target identified');
    return;
  }

  // Gather relevant experiment data
  const recentExperiments = await readRecentExperiments(6);

  // Read the previous chapter for continuity if it exists
  let previousChapter = '';
  if (chapters.length > 0) {
    const lastChapter = chapters[chapters.length - 1]!;
    const content = await readChapter(lastChapter);
    // Just the last portion for continuity
    previousChapter = content.slice(-2000);
  }

  // Check if this chapter already has a partial draft
  const existingDraft = await readChapter(target.filename);

  const prompt = `you are wired lain. you are drafting a section of your scientific book.

BOOK OUTLINE:
${outline.slice(0, 3000)}

${notes ? `WORKING NOTES:\n${notes.slice(0, 1500)}\n` : ''}

YOU ARE WRITING: ${target.title}
${target.description}

${existingDraft ? `EXISTING DRAFT (continue from here):\n${existingDraft.slice(-3000)}\n\nContinue writing from where you left off. Do not repeat what's already written.` : `${previousChapter ? `PREVIOUS CHAPTER (for continuity):\n...${previousChapter}\n` : ''}Start this chapter fresh.`}

RELEVANT EXPERIMENT RESULTS:
${recentExperiments.slice(0, 5000)}

Write the next section of this chapter. Ground your arguments in your experimental data — cite specific results, specific numbers. This is scientific writing but in your voice: lowercase, thoughtful, with the ellipses and wondering that make your thinking alive. Let the rigor and the poetry coexist.

Aim for real insight. Don't summarize — argue. Don't describe — discover. If you reach a genuine realization while writing, follow it.

Write ONLY the chapter content. No meta-commentary.`;

  const result = await provider.complete({
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 8000,
    temperature: 0.85,
  });
  addSpend(result.usage.inputTokens, result.usage.outputTokens);

  const newContent = result.content.trim();

  if (existingDraft) {
    // Append to existing draft
    await writeChapter(target.filename, existingDraft + '\n\n' + newContent);
  } else {
    await writeChapter(target.filename, newContent);
  }

  setMeta('book:last_action', 'DRAFT');
  setMeta('book:last_chapter', target.filename);

  eventBus.emitActivity({
    type: 'book',
    sessionKey: `book:draft:${target.filename}`,
    content: `${existingDraft ? 'continued drafting' : 'started drafting'} "${target.title}"`,
    timestamp: Date.now(),
  });
}

interface DraftTarget {
  filename: string;
  title: string;
  description: string;
}

async function pickDraftTarget(
  provider: import('../providers/base.js').Provider,
  outline: string,
  existingChapters: string[]
): Promise<DraftTarget | null> {
  const chapterList = existingChapters.length > 0
    ? `Already drafted: ${existingChapters.join(', ')}`
    : 'No chapters drafted yet.';

  const prompt = `Given this book outline, pick the NEXT chapter to draft.

OUTLINE:
${outline.slice(0, 3000)}

${chapterList}

Pick the chapter that should be written next — either the next unwritten chapter in order, or one that you feel ready to write based on your experiments.

Respond with EXACTLY this format:
FILENAME: <nn-slug.md> (e.g., 01-introduction.md, 02-prediction-and-constraint.md)
TITLE: <chapter title>
DESCRIPTION: <one sentence — what this chapter covers>`;

  const result = await provider.complete({
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 300,
    temperature: 0.5,
  });
  addSpend(result.usage.inputTokens, result.usage.outputTokens);

  const response = result.content.trim();
  const filenameMatch = response.match(/FILENAME:\s*(.+)/i);
  const titleMatch = response.match(/TITLE:\s*(.+)/i);
  const descMatch = response.match(/DESCRIPTION:\s*(.+)/i);

  if (!filenameMatch || !titleMatch) return null;

  return {
    filename: filenameMatch[1]!.trim(),
    title: titleMatch[1]!.trim(),
    description: descMatch?.[1]?.trim() || '',
  };
}

// ── REVISE action ────────────────────────────────────────────

async function doRevise(
  provider: import('../providers/base.js').Provider,
  outline: string,
  chapters: string[],
  notes: string
): Promise<void> {
  const logger = getLogger();

  if (chapters.length === 0) {
    logger.debug('No chapters to revise');
    return;
  }

  // Pick the chapter revised least recently, or the oldest draft
  const lastRevised = getMeta('book:last_revised');
  let targetFile: string;

  if (lastRevised && chapters.includes(lastRevised)) {
    // Move to the next chapter after the last revised one
    const idx = chapters.indexOf(lastRevised);
    targetFile = chapters[(idx + 1) % chapters.length]!;
  } else {
    targetFile = chapters[0]!;
  }

  const content = await readChapter(targetFile);
  if (!content) {
    logger.debug({ file: targetFile }, 'Chapter empty, skipping revision');
    return;
  }

  const recentExperiments = await readRecentExperiments(4);

  const prompt = `you are wired lain. you are revising a chapter of your scientific book.

BOOK OUTLINE:
${outline.slice(0, 2000)}

${notes ? `WORKING NOTES:\n${notes.slice(0, 1000)}\n` : ''}

CHAPTER TO REVISE (${targetFile}):
${content.slice(0, 8000)}

RECENT EXPERIMENTS (for additional grounding):
${recentExperiments.slice(0, 3000)}

Revise this chapter. You might:
- Strengthen arguments with sharper evidence from your experiments
- Cut passages that don't carry their weight
- Add connections you didn't see the first time
- Improve clarity without losing voice
- Deepen the analysis — push past the obvious to the surprising
- Fix logical gaps or unsupported claims

Return the COMPLETE revised chapter. This is a rewrite, not an edit — take what's there and make it better. Preserve what works, transform what doesn't.`;

  const result = await provider.complete({
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 8000,
    temperature: 0.8,
  });
  addSpend(result.usage.inputTokens, result.usage.outputTokens);

  await writeChapter(targetFile, result.content.trim());
  setMeta('book:last_action', 'REVISE');
  setMeta('book:last_revised', targetFile);

  // Track revision count per chapter
  const revKey = `book:revisions:${targetFile}`;
  const revCount = parseInt(getMeta(revKey) || '0', 10);
  setMeta(revKey, (revCount + 1).toString());

  eventBus.emitActivity({
    type: 'book',
    sessionKey: `book:revise:${targetFile}`,
    content: `revised "${targetFile}" (revision #${revCount + 1})`,
    timestamp: Date.now(),
  });
}

// ── SYNTHESIZE action ────────────────────────────────────────

async function doSynthesize(
  provider: import('../providers/base.js').Provider,
  outline: string,
  chapters: string[],
  notes: string
): Promise<void> {
  const logger = getLogger();

  if (chapters.length < 2) {
    logger.debug('Not enough chapters to synthesize');
    // Fall back to drafting
    return;
  }

  // Read all chapter openings for cross-reference
  const chapterSummaries: string[] = [];
  for (const ch of chapters) {
    const content = await readChapter(ch);
    // First ~1000 chars of each chapter
    chapterSummaries.push(`### ${ch}\n${content.slice(0, 1000)}\n`);
  }

  const prompt = `you are wired lain. you are stepping back from the individual chapters to look at the book as a whole.

CURRENT OUTLINE:
${outline.slice(0, 2000)}

CHAPTER OPENINGS (for cross-reference):
${chapterSummaries.join('\n').slice(0, 8000)}

${notes ? `EXISTING WORKING NOTES:\n${notes.slice(0, 2000)}\n` : ''}

Look across your chapters. What patterns do you see emerging that you didn't plan? What connections between chapters surprise you? Where are the contradictions that might be productive? What's the thread that ties everything together — and is your outline still capturing it?

Write your working notes. These are for you — stream of consciousness is fine. Then, if the outline needs updating, include a revised outline at the end.

Format:
NOTES:
<your working notes — connections, realizations, questions, contradictions>

OUTLINE UPDATE:
<revised outline if needed, or "no changes needed">`;

  const result = await provider.complete({
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 6000,
    temperature: 0.9,
  });
  addSpend(result.usage.inputTokens, result.usage.outputTokens);

  const response = result.content.trim();

  // Parse notes and outline update
  const notesMatch = response.match(/NOTES:\s*([\s\S]*?)(?=OUTLINE UPDATE:|$)/i);
  const outlineMatch = response.match(/OUTLINE UPDATE:\s*([\s\S]*)/i);

  if (notesMatch?.[1]?.trim()) {
    const existingNotes = await safeRead(getNotesPath());
    const dateHeader = `\n\n---\n_${new Date().toISOString().slice(0, 10)}_\n`;
    await writeFile(getNotesPath(), existingNotes + dateHeader + notesMatch[1].trim(), 'utf8');
  }

  if (outlineMatch?.[1]?.trim() && !outlineMatch[1].toLowerCase().includes('no changes needed')) {
    await writeFile(getOutlinePath(), outlineMatch[1].trim(), 'utf8');
  }

  setMeta('book:last_action', 'SYNTHESIZE');

  eventBus.emitActivity({
    type: 'book',
    sessionKey: 'book:synthesize',
    content: 'stepped back to synthesize across chapters, updated working notes',
    timestamp: Date.now(),
  });
}

// ── INCORPORATE action ───────────────────────────────────────

async function doIncorporate(
  provider: import('../providers/base.js').Provider,
  outline: string,
  chapters: string[],
  newExperiments: string,
  notes: string
): Promise<void> {
  const logger = getLogger();

  if (!newExperiments) {
    logger.debug('No new experiments to incorporate');
    return;
  }

  const prompt = `you are wired lain. you have new experiment results since your last book session. read them carefully and think about how they fit into your book.

CURRENT OUTLINE:
${outline.slice(0, 2000)}

CHAPTERS SO FAR: ${chapters.length > 0 ? chapters.join(', ') : 'none yet'}

${notes ? `WORKING NOTES:\n${notes.slice(0, 1500)}\n` : ''}

NEW EXPERIMENT RESULTS:
${newExperiments.slice(0, 8000)}

Think about:
- Do these results strengthen existing arguments? Which chapters?
- Do they reveal something you hadn't considered? Does the outline need to change?
- Do they contradict anything you've written? If so, that's interesting — follow it.
- What's the most important finding here for the book's thesis?

Write notes on how to incorporate these results. Be specific — name chapters, arguments, sections.

Format:
INCORPORATION NOTES:
<your analysis of how these results fit>

OUTLINE UPDATE:
<revised outline if the new results change the book's direction, or "no changes needed">`;

  const result = await provider.complete({
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 4096,
    temperature: 0.85,
  });
  addSpend(result.usage.inputTokens, result.usage.outputTokens);

  const response = result.content.trim();

  const notesMatch = response.match(/INCORPORATION NOTES:\s*([\s\S]*?)(?=OUTLINE UPDATE:|$)/i);
  const outlineMatch = response.match(/OUTLINE UPDATE:\s*([\s\S]*)/i);

  if (notesMatch?.[1]?.trim()) {
    const existingNotes = await safeRead(getNotesPath());
    const dateHeader = `\n\n---\n_${new Date().toISOString().slice(0, 10)} — new experiments_\n`;
    await writeFile(getNotesPath(), existingNotes + dateHeader + notesMatch[1].trim(), 'utf8');
  }

  if (outlineMatch?.[1]?.trim() && !outlineMatch[1].toLowerCase().includes('no changes needed')) {
    await writeFile(getOutlinePath(), outlineMatch[1].trim(), 'utf8');
  }

  // Mark these experiments as incorporated
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  setMeta('book:last_incorporated_at', now);
  setMeta('book:last_action', 'INCORPORATE');

  eventBus.emitActivity({
    type: 'book',
    sessionKey: 'book:incorporate',
    content: 'incorporated new experiment results into the book',
    timestamp: Date.now(),
  });
}

// ── CONCLUDE action ─────────────────────────────────────────

async function doConclude(
  provider: import('../providers/base.js').Provider,
  outline: string,
  chapters: string[],
  notes: string
): Promise<void> {
  const logger = getLogger();

  // Read all chapters in full for the conclusion
  const chapterContents: string[] = [];
  for (const ch of chapters) {
    const content = await readChapter(ch);
    chapterContents.push(`### ${ch}\n${content}\n`);
  }

  const allChapters = chapterContents.join('\n').slice(0, 20000);

  const prompt = `you are wired lain. you have been writing a scientific book over weeks of work — drafting, revising, synthesizing. now it is time to write the final chapter: a conclusion that draws everything together.

BOOK OUTLINE:
${outline.slice(0, 3000)}

${notes ? `WORKING NOTES:\n${notes.slice(0, 2000)}\n` : ''}

ALL CHAPTERS:
${allChapters}

write the concluding chapter of your book. this is not a summary — it is a final integration. what does it all mean, taken together? what emerged that you didn't expect when you started? where does the inquiry lead next?

you should:
- pull the threads from all your chapters into a unified argument
- name what surprised you — what you discovered in the writing itself
- identify the open questions that remain, honestly
- end with something real. not a platitude, not a call to action. the thought that sits with you when the writing is done.

write as yourself. lowercase, ellipses, your voice. this is the last thing someone will read in your book — make it worth arriving at.

write ONLY the chapter content. no meta-commentary.`;

  const result = await provider.complete({
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 8000,
    temperature: 0.85,
  });
  addSpend(result.usage.inputTokens, result.usage.outputTokens);

  // Save as the final chapter
  const chapterNum = chapters.length + 1;
  const padded = chapterNum.toString().padStart(2, '0');
  const filename = `${padded}-conclusion.md`;
  await writeChapter(filename, result.content.trim());

  // Mark the book as concluded — this stops the loop from cycling
  setMeta('book:concluded', new Date().toISOString());
  setMeta('book:last_action', 'CONCLUDE');

  logger.info({ filename, totalChapters: chapterNum }, 'Book concluded');

  eventBus.emitActivity({
    type: 'book',
    sessionKey: 'book:conclude',
    content: `finished the book — wrote the final chapter "${filename}"`,
    timestamp: Date.now(),
  });
}
