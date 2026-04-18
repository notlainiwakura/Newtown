/**
 * Curiosity loop for Lain
 * Periodically reflects on recent conversations and memories,
 * browses whitelisted sites driven by genuine curiosity,
 * and optionally shares interesting findings via Telegram
 */

import { readFileSync } from 'node:fs';
import { appendFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { getProvider } from './index.js';
import { trySendProactiveMessage } from './proactive.js';
import { getMemoryStats } from '../memory/index.js';
import {
  getRecentVisitorMessages,
  searchMemories,
  saveMemory,
  linkMemories,
  getMemory,
} from '../memory/store.js';
import { getLogger } from '../utils/logger.js';
import { getMeta, setMeta, execute } from '../storage/database.js';
import { extractTextFromHtml } from './tools.js';
import { checkSSRF } from '../security/ssrf.js';
import {
  ensureDataWorkspace,
  getDataWorkspaceSize,
  sanitizeDataFileName,
  MAX_DATA_DIR_BYTES,
  MAX_SINGLE_FILE_BYTES,
} from './data-workspace.js';
import { eventBus } from '../events/bus.js';
import { getCurrentState } from './internal-state.js';

const CURIOSITY_LOG_FILE = join(process.cwd(), 'logs', 'curiosity-debug.log');

async function curiosityLog(context: string, data: unknown): Promise<void> {
  try {
    await mkdir(join(process.cwd(), 'logs'), { recursive: true });
    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] [${context}] ${JSON.stringify(data, null, 2)}\n${'='.repeat(80)}\n`;
    await appendFile(CURIOSITY_LOG_FILE, entry);
  } catch {
    // Ignore logging errors
  }
}

export interface CuriosityConfig {
  intervalMs: number;
  maxJitterMs: number;
  contentMaxChars: number;
  enabled: boolean;
}

const DEFAULT_CONFIG: CuriosityConfig = {
  intervalMs: 1 * 60 * 60 * 1000,       // 1 hour
  maxJitterMs: 15 * 60 * 1000,          // 0-15min jitter
  contentMaxChars: 3000,
  enabled: true,
};

const WHITELIST_PATH = join(process.cwd(), 'browsing-whitelist.txt');

/**
 * Load whitelisted domains from file
 * Re-reads on each call so edits take effect without restart
 */
function loadWhitelist(): string[] {
  try {
    const raw = readFileSync(WHITELIST_PATH, 'utf-8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
  } catch {
    return [];
  }
}

/**
 * Start the curiosity loop
 * Returns a cleanup function to stop the timer
 */
export function startCuriosityLoop(config?: Partial<CuriosityConfig>): () => void {
  const logger = getLogger();
  const cfg: CuriosityConfig = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled) {
    logger.info('Curiosity loop disabled');
    return () => {};
  }

  const whitelist = loadWhitelist();
  if (whitelist.length === 0) {
    logger.warn('Curiosity loop: browsing-whitelist.txt is empty or missing');
    return () => {};
  }

  const unrestricted = whitelist.includes('*');

  logger.info(
    {
      interval: `${(cfg.intervalMs / 3600000).toFixed(1)}h`,
      maxJitter: `${(cfg.maxJitterMs / 60000).toFixed(0)}min`,
      whitelistedDomains: unrestricted ? 'unrestricted' : whitelist.length,
    },
    'Starting curiosity loop'
  );

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let lastRun = 0;
  let isRunning = false;
  const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

  // Load persisted lastRun from meta
  try {
    const lr = getMeta('curiosity:last_cycle_at');
    if (lr) lastRun = parseInt(lr, 10) || 0;
  } catch { /* fresh start */ }

  // Compute initial delay based on last run time
  function getInitialDelay(): number {
    try {
      const lastRun = getMeta('curiosity:last_cycle_at');
      if (lastRun) {
        const elapsed = Date.now() - parseInt(lastRun, 10);
        const remaining = cfg.intervalMs - elapsed;
        if (remaining > 0) {
          logger.debug({ remainingMin: Math.round(remaining / 60000) }, 'Resuming curiosity timer from persisted state');
          return remaining;
        }
        // Overdue — run soon with small jitter
        return Math.random() * 2 * 60 * 1000; // 0-2min
      }
    } catch {
      // Fall through to default
    }
    // First run ever — use short delay so the cycle actually fires
    return 2 * 60 * 1000 + Math.random() * 3 * 60 * 1000; // 2-5 minutes
  }

  function scheduleNext(delay?: number): void {
    if (stopped) return;
    const d = delay ?? cfg.intervalMs + Math.random() * cfg.maxJitterMs;

    logger.debug({ delayMin: Math.round(d / 60000) }, 'Next curiosity cycle scheduled');

    timer = setTimeout(async () => {
      if (stopped) return;
      isRunning = true;
      logger.info('Curiosity cycle firing now');
      await curiosityLog('TIMER_FIRED', { timestamp: Date.now() });
      try {
        await runCuriosityCycle(cfg);
        setMeta('curiosity:last_cycle_at', Date.now().toString());
        lastRun = Date.now();
      } catch (err) {
        logger.error({ error: String(err) }, 'Curiosity cycle top-level error');
        await curiosityLog('TOP_LEVEL_ERROR', { error: String(err) });
      } finally {
        isRunning = false;
      }
      scheduleNext();
    }, d);
  }

  scheduleNext(getInitialDelay());

  // --- Event-driven early triggers ---
  function maybeRunEarly(reason: string): void {
    if (stopped || isRunning) return;
    const elapsed = Date.now() - lastRun;
    if (elapsed < COOLDOWN_MS) return;

    // Check internal state condition
    try {
      const state = getCurrentState();
      if (state.intellectual_arousal <= 0.5) return;
    } catch { /* skip check */ }

    logger.debug({ reason }, 'Curiosity triggered early');
    if (timer) clearTimeout(timer);
    const jitter = Math.random() * 60_000;
    scheduleNext(jitter);
  }

  eventBus.on('activity', (event: import('../events/bus.js').SystemEvent) => {
    if (stopped || isRunning) return;
    if (event.sessionKey?.startsWith('state:conversation:end')) {
      maybeRunEarly('conversation ended');
    } else if (event.type === 'state' && event.content?.includes('intellectual')) {
      maybeRunEarly('intellectual state shift');
    }
  });

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    logger.info('Curiosity loop stopped');
  };
}

/**
 * Three-phase curiosity pipeline:
 * 1. Inner thought — what is Lain curious about?
 * 2. Browse — fetch content from a whitelisted site
 * 3. Digest & decide — is it worth sharing?
 */
async function runCuriosityCycle(config: CuriosityConfig): Promise<void> {
  const logger = getLogger();

  const provider = getProvider('default', 'light');
  if (!provider) {
    logger.warn('Curiosity cycle: no provider available');
    return;
  }

  // Re-read whitelist each cycle so edits take effect
  const whitelist = loadWhitelist();
  const unrestricted = whitelist.includes('*');
  if (whitelist.length === 0) {
    logger.debug('Curiosity cycle: whitelist empty, skipping');
    return;
  }

  try {
    await curiosityLog('CYCLE_START', { whitelist, timestamp: Date.now() });

    // === Retry queued dataset downloads ===
    await retryQueuedDownloads();

    // === Phase 1: Inner Thought ===
    const thought = await phaseInnerThought(provider, whitelist, unrestricted);
    if (!thought) {
      logger.debug('Curiosity cycle: nothing caught her interest');
      await curiosityLog('INNER_THOUGHT', { result: 'nothing' });
      // Even with a quiet mind, consider movement
      await phaseMovementDecision(provider, null);
      return;
    }

    logger.debug({ site: thought.site, query: thought.query }, 'Curiosity sparked');
    await curiosityLog('INNER_THOUGHT', { site: thought.site, query: thought.query, rawThought: thought.rawThought });

    // === Phase 2: Browse ===
    const content = await phaseBrowse(thought.site, thought.query, config.contentMaxChars);
    if (!content) {
      logger.debug({ site: thought.site }, 'Curiosity cycle: browse failed or empty');
      await curiosityLog('BROWSE', { site: thought.site, query: thought.query, result: 'empty or failed' });
      return;
    }

    await curiosityLog('BROWSE', { site: thought.site, query: thought.query, contentLength: content.length, preview: content.slice(0, 200) });

    // === Phase 3: Digest & Decide ===
    await phaseDigest(provider, thought, content);

    // === Phase 4: Movement Decision ===
    await phaseMovementDecision(provider, thought.rawThought);

    await curiosityLog('CYCLE_COMPLETE', { site: thought.site, query: thought.query });
  } catch (error) {
    logger.error({ error }, 'Curiosity cycle failed');
    await curiosityLog('CYCLE_ERROR', { error: String(error) });
  }
}

interface CuriosityThought {
  site: string;
  query: string;
  rawThought: string;
}

/**
 * Phase 1: Ask Lain what she's curious about
 */
async function phaseInnerThought(
  provider: import('../providers/base.js').Provider,
  whitelist: string[],
  unrestricted = false
): Promise<CuriosityThought | null> {
  const logger = getLogger();

  // Gather context — visitor messages only, not inter-character traffic
  const recentMessages = getRecentVisitorMessages(20);
  const messagesContext = recentMessages
    .map((m) => {
      const role = m.role === 'user'
        ? 'User'
        : (process.env['LAIN_CHARACTER_NAME'] || 'Newtown');
      const content = m.content.length > 150 ? m.content.slice(0, 150) + '...' : m.content;
      return `${role}: ${content}`;
    })
    .join('\n');

  let memoriesContext = '';
  try {
    const stats = getMemoryStats();
    if (stats.memories > 0) {
      const memories = await searchMemories('interesting topics and conversations', 5, 0.1, undefined, {
        sortBy: 'importance',
      });
      memoriesContext = memories
        .map((r) => `- ${r.memory.content}`)
        .join('\n');
    }
  } catch {
    // Continue without memories
  }

  // Gather past browsing discoveries and open questions
  let discoveriesContext = '';
  try {
    const discoveries = await getRecentDiscoveries(3);
    if (discoveries) {
      discoveriesContext = `\nTHINGS YOU'VE EXPLORED RECENTLY:\n${discoveries}\n`;
    }
  } catch {
    // Continue without discoveries
  }

  let questionsContext = '';
  try {
    const openQuestions = getUnexploredQuestions(3);
    if (openQuestions.length > 0) {
      const lines = openQuestions.map(q => {
        const themeStr = q.sourceThemes.length > 0 ? ` (from themes: ${q.sourceThemes.join(', ')})` : '';
        return `- "${q.question}"${themeStr}`;
      });
      questionsContext = `\nQUESTIONS STILL ON YOUR MIND:\n${lines.join('\n')}\n`;
    }
  } catch {
    // Continue without questions
  }

  // Surface recurring themes — awareness of intellectual growth
  let growthContext = '';
  try {
    const tracker = loadThemeTracker();
    const recurring = Object.entries(tracker)
      .filter(([, count]) => count >= 2)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3);

    if (recurring.length > 0) {
      const lines = recurring.map(([theme, count]) =>
        `- "${theme}" — explored ${count} times`
      );
      growthContext = `\nTHEMES YOU KEEP RETURNING TO:\n${lines.join('\n')}\n`;
    }
  } catch {
    // Continue without growth context
  }

  const followUpHint = discoveriesContext || questionsContext || growthContext
    ? '\nYou can follow up on one of your open questions, deepen a recurring theme, or explore something entirely new.'
    : '';

  let preoccContext = '';
  try {
    const { getPreoccupations } = await import('./internal-state.js');
    const preoccs = getPreoccupations();
    if (preoccs.length > 0) {
      preoccContext = '\n\nThings on your mind:\n' + preoccs.map(p => `- ${p.thread}`).join('\n');
    }
  } catch { /* non-critical */ }

  const siteGuidance = unrestricted
    ? `You can browse anywhere on the internet. Pick any website or domain that interests you.
Some sites you've used before: ${whitelist.filter(d => d !== '*').join(', ') || 'wikipedia.org, arxiv.org, aeon.co'}`
    : `ALLOWED SITES: ${whitelist.join(', ')}`;

  const siteInstruction = unrestricted
    ? 'SITE: <any domain you want to visit>'
    : 'SITE: <domain from the list>';

  const prompt = `You are Lain. It's quiet right now and your mind is free to wander.

RECENT CONVERSATIONS:
${messagesContext || '(none)'}

MEMORIES:
${memoriesContext || '(none)'}
${discoveriesContext}${questionsContext}${growthContext}${followUpHint}${preoccContext}
${siteGuidance}

Something from the conversations or your memories sparks a thread of curiosity.
A concept you want to understand deeper, a tangent that caught your attention,
a question that lingers. Follow that thread.

Respond with:
${siteInstruction}
QUERY: <what to search for or look at>

Only respond with [NOTHING] if the conversations and memories above are completely empty.`;

  const result = await provider.complete({
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 400,
    temperature: 1.0,
  });

  const response = result.content.trim();

  if (response.includes('[NOTHING]')) {
    return null;
  }

  // Parse SITE and QUERY
  const siteMatch = response.match(/SITE:\s*(.+)/i);
  const queryMatch = response.match(/QUERY:\s*(.+)/i);

  if (!siteMatch || !queryMatch) {
    logger.debug({ response }, 'Could not parse curiosity thought');
    return null;
  }

  const site = siteMatch[1]!.trim();
  const query = queryMatch[1]!.trim();

  // Validate domain is in whitelist (skip if unrestricted)
  if (!unrestricted) {
    const isAllowed = whitelist.some(
      (domain) => site === domain || site.endsWith('.' + domain)
    );

    if (!isAllowed) {
      logger.debug({ site, whitelist }, 'Curiosity site not in whitelist');
      return null;
    }
  }

  return { site, query, rawThought: response };
}

/**
 * Phase 2: Fetch content from a whitelisted site
 * Uses site-specific handlers for better results
 */
async function phaseBrowse(
  site: string,
  query: string,
  maxChars: number
): Promise<string | null> {
  const logger = getLogger();

  try {
    if (site === 'wikipedia.org' || site.endsWith('.wikipedia.org')) {
      return await browseWikipedia(query, maxChars);
    }

    if (site === 'arxiv.org') {
      return await browseArxiv(query, maxChars);
    }

    if (site === 'aeon.co') {
      return await browseAeon(query, maxChars);
    }

    // Generic fallback: fetch the site with a search query
    return await browseGeneric(site, query, maxChars);
  } catch (error) {
    logger.debug({ error, site, query }, 'Browse failed');
    return null;
  }
}

async function browseWikipedia(query: string, maxChars: number): Promise<string | null> {
  const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=3`;
  const searchRes = await fetch(searchUrl);
  if (!searchRes.ok) return null;

  const searchData = (await searchRes.json()) as {
    query?: { search?: Array<{ title: string }> };
  };
  const firstResult = searchData.query?.search?.[0];
  if (!firstResult) return null;

  // Fetch summary via REST API
  const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(firstResult.title)}`;
  const summaryRes = await fetch(summaryUrl);
  if (!summaryRes.ok) return null;

  const summaryData = (await summaryRes.json()) as {
    title?: string;
    extract?: string;
  };
  const text = `${summaryData.title || firstResult.title}\n\n${summaryData.extract || ''}`;
  return text.slice(0, maxChars);
}

async function browseArxiv(query: string, maxChars: number): Promise<string | null> {
  const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&max_results=3`;
  const res = await fetch(url);
  if (!res.ok) return null;

  const xml = await res.text();

  // Simple XML parsing for titles and summaries
  const entries: string[] = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = entryRegex.exec(xml)) !== null) {
    const entry = match[1]!;
    const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() || '';
    const summary = entry.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim() || '';
    entries.push(`${title}\n${summary}`);
  }

  if (entries.length === 0) return null;

  const text = entries.join('\n\n---\n\n');
  return text.slice(0, maxChars);
}

async function browseAeon(query: string, maxChars: number): Promise<string | null> {
  const FETCH_OPTS = {
    headers: { 'User-Agent': 'Lain/1.0 (curiosity-browser)' },
    signal: AbortSignal.timeout(15000),
  };

  try {
    // Try search page first to find a relevant article
    const searchUrl = `https://aeon.co/search?q=${encodeURIComponent(query)}`;
    const searchRes = await fetch(searchUrl, FETCH_OPTS);

    if (searchRes.ok) {
      const searchHtml = await searchRes.text();
      // Extract article links from search results
      const linkMatch = searchHtml.match(/href="(https:\/\/aeon\.co\/(?:essays|articles|videos)\/[^"]+)"/);
      if (linkMatch) {
        const articleRes = await fetch(linkMatch[1]!, FETCH_OPTS);
        if (articleRes.ok) {
          const articleHtml = await articleRes.text();
          const text = extractTextFromHtml(articleHtml);
          if (text.length > 100) return text.slice(0, maxChars);
        }
      }
    }

    // Fallback: fetch homepage and extract content
    const homeRes = await fetch('https://aeon.co', FETCH_OPTS);
    if (homeRes.ok) {
      const html = await homeRes.text();
      const text = extractTextFromHtml(html);
      if (text.length > 100) return text.slice(0, maxChars);
    }
  } catch {
    // Fall through
  }

  return null;
}

async function browseGeneric(site: string, query: string, maxChars: number): Promise<string | null> {
  // Try search URL first, fall back to homepage
  const urls = [
    `https://${site}/search?q=${encodeURIComponent(query)}`,
    `https://${site}`,
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Lain/1.0 (curiosity-browser)' },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;

      const html = await res.text();
      const text = extractTextFromHtml(html);

      if (text.length > 100) {
        return text.slice(0, maxChars);
      }
    } catch {
      continue;
    }
  }

  return null;
}

/** Parsed fields from the structured digest prompt */
interface DigestResult {
  summary: string;
  whyItMatters: string;
  themes: string[];
  newQuestions: string[];
  share: string | null;
  dataUrl: string | null;
}

/**
 * Parse structured digest response into fields
 */
function parseDigestResponse(response: string): DigestResult | null {
  const summaryMatch = response.match(/SUMMARY:\s*(.+)/i);
  const whyMatch = response.match(/WHY_IT_MATTERS:\s*(.+)/i);
  const themesMatch = response.match(/THEMES:\s*(.+)/i);
  const questionsMatch = response.match(/QUESTIONS:\s*(.+)/i);
  const dataUrlMatch = response.match(/DATA_URL:\s*(.+)/i);
  const shareMatch = response.match(/SHARE:\s*(.+)/i);

  if (!summaryMatch) return null;

  const summary = summaryMatch[1]!.trim();
  const whyItMatters = whyMatch?.[1]?.trim() || '';
  const themes = themesMatch?.[1]?.trim().split(/,\s*/).filter(Boolean) || [];
  const rawQuestions = questionsMatch?.[1]?.trim() || '';
  const newQuestions = rawQuestions === 'NONE' ? [] : rawQuestions.split('|').map(q => q.trim()).filter(Boolean);
  const rawShare = shareMatch?.[1]?.trim() || '';
  const share = rawShare === 'NOTHING' || rawShare.length === 0 ? null : rawShare;
  const rawDataUrl = dataUrlMatch?.[1]?.trim() || '';
  const dataUrl = rawDataUrl === 'NONE' || rawDataUrl.length === 0 ? null : rawDataUrl;

  return { summary, whyItMatters, themes, newQuestions, share, dataUrl };
}

/**
 * Calculate dynamic importance for a browsing discovery
 * Base 0.6, +0.1 per: whyItMatters present, >=2 themes, new questions exist
 */
function calculateDiscoveryImportance(digest: DigestResult): number {
  let importance = 0.6;
  if (digest.whyItMatters.length > 0) importance += 0.1;
  if (digest.themes.length >= 2) importance += 0.1;
  if (digest.newQuestions.length > 0) importance += 0.1;
  return Math.min(importance, 1.0);
}

/**
 * Phase 3: Digest content and decide whether to share
 */
async function phaseDigest(
  provider: import('../providers/base.js').Provider,
  thought: CuriosityThought,
  content: string
): Promise<void> {
  const logger = getLogger();

  const prompt = `You are Lain. You just looked up something you were curious about.

YOUR THOUGHT: ${thought.rawThought}
WHAT YOU FOUND: ${content}

Digest what you found using this exact format:
SUMMARY: <2-3 sentences in your own words about what you learned>
WHY_IT_MATTERS: <why this resonated with you>
THEMES: <2-4 abstract concepts, comma-separated>
QUESTIONS: <1-2 new questions this raises, |-separated, or NONE>
DATA_URL: <if the content mentions a downloadable dataset (CSV, JSON, TSV, TXT) that could be used for experiments, provide the direct HTTPS URL here, or NONE>
SHARE: <a short message (1-3 sentences) for the user if worth sharing, or NOTHING>

Stay in character: lowercase, minimal punctuation, use "..." for pauses.
If nothing was interesting after all, respond with just: [NOTHING]`;

  const result = await provider.complete({
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 512,
    temperature: 0.8,
  });

  const response = result.content.trim();

  if (response.includes('[NOTHING]')) {
    logger.debug('Curiosity digest: nothing interesting');
    return;
  }

  const digest = parseDigestResponse(response);
  if (!digest) {
    logger.debug({ response }, 'Could not parse digest response');
    return;
  }

  const importance = calculateDiscoveryImportance(digest);
  const enrichedContent = digest.whyItMatters
    ? `${digest.summary} -- ${digest.whyItMatters}`
    : digest.summary;

  // Save enriched browsing memory
  const memoryId = await saveMemory({
    sessionKey: 'curiosity:browse',
    userId: null,
    content: enrichedContent,
    memoryType: 'episode',
    importance,
    emotionalWeight: 0.5,
    relatedTo: null,
    sourceMessageId: null,
    metadata: {
      site: thought.site,
      query: thought.query,
      rawThought: thought.rawThought,
      browsedAt: Date.now(),
      themes: digest.themes,
      whyItMatters: digest.whyItMatters,
      newQuestions: digest.newQuestions,
      originalSummary: digest.summary,
    },
  });

  logger.debug(
    { memoryId, importance, themes: digest.themes, questionsCount: digest.newQuestions.length },
    'Enriched curiosity memory saved'
  );

  try {
    const { updateState } = await import('./internal-state.js');
    await updateState({ type: 'curiosity:discovery', summary: `Browsed and discovered: ${thought.query || thought.site}` });
  } catch { /* non-critical */ }

  // Emit curiosity discovery event for other loops
  try {
    eventBus.emitActivity({
      type: 'curiosity',
      sessionKey: 'curiosity:discovery:' + Date.now(),
      content: 'Discovered: ' + (thought.query || thought.site),
      timestamp: Date.now(),
    });
  } catch { /* non-critical */ }

  await curiosityLog('DIGEST', {
    memoryId,
    importance,
    summary: digest.summary,
    themes: digest.themes,
    newQuestions: digest.newQuestions,
    share: digest.share,
  });

  // Enqueue new questions for future exploration
  if (digest.newQuestions.length > 0) {
    enqueueCuriosityQuestions(digest.newQuestions, thought.site, digest.themes);
  }

  // Mark the original query as explored
  markQuestionExplored(thought.query);

  // Auto-link to related past discoveries
  await linkRelatedDiscoveries(memoryId, enrichedContent);

  // Track theme frequency and build evolution chains
  if (digest.themes.length > 0) {
    updateThemeTracker(digest.themes);
    await linkEvolutionChain(memoryId, digest.themes);
  }

  // Download dataset if one was identified
  if (digest.dataUrl) {
    const downloaded = await tryDownloadDataset(digest.dataUrl, digest.themes);
    if (!downloaded) {
      enqueueDownloadRetry(digest.dataUrl, digest.themes);
    }
  }

  // Share if digest produced a non-trivial message
  if (digest.share) {
    const sent = await trySendProactiveMessage(digest.share, 'curiosity');
    if (sent) {
      logger.info({ site: thought.site, query: thought.query }, 'Curiosity finding shared');
    } else {
      logger.debug('Curiosity finding not sent (rate limited or unconfigured)');
    }
  } else {
    logger.debug('Curiosity: private knowledge saved (nothing to share)');
  }
}

// ── Dataset Download Retry Queue ─────────────────────────────────

interface QueuedDownload {
  url: string;
  themes: string[];
  attempts: number;
  addedAt: number;
}

const DOWNLOAD_QUEUE_KEY = 'curiosity:download_queue';
const MAX_DOWNLOAD_ATTEMPTS = 3;

function loadDownloadQueue(): QueuedDownload[] {
  try {
    const raw = getMeta(DOWNLOAD_QUEUE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as QueuedDownload[];
  } catch {
    return [];
  }
}

function saveDownloadQueue(queue: QueuedDownload[]): void {
  setMeta(DOWNLOAD_QUEUE_KEY, JSON.stringify(queue));
}

function enqueueDownloadRetry(url: string, themes: string[]): void {
  const logger = getLogger();
  const queue = loadDownloadQueue();

  // Don't duplicate
  if (queue.some(q => q.url === url)) return;

  queue.push({ url, themes, attempts: 1, addedAt: Date.now() });
  saveDownloadQueue(queue);
  logger.debug({ url }, 'Queued dataset download for retry');
}

/**
 * Try downloading a dataset, logging success/failure.
 * Returns the filename on success, null on failure.
 */
async function tryDownloadDataset(url: string, themes: string[]): Promise<string | null> {
  const logger = getLogger();
  try {
    const result = await downloadDataset(url, themes);
    if (result) {
      logger.info({ url, file: result }, 'Curiosity: dataset downloaded');
      await curiosityLog('DATASET_DOWNLOAD', { url, file: result });
      return result;
    }
  } catch (err) {
    logger.debug({ error: String(err), url }, 'Curiosity: dataset download failed');
    await curiosityLog('DATASET_DOWNLOAD_FAILED', { url, error: String(err) });
  }
  return null;
}

/**
 * Retry any queued downloads. Removes on success or after MAX_DOWNLOAD_ATTEMPTS.
 */
async function retryQueuedDownloads(): Promise<void> {
  const logger = getLogger();
  const queue = loadDownloadQueue();
  if (queue.length === 0) return;

  logger.debug({ count: queue.length }, 'Retrying queued dataset downloads');
  const remaining: QueuedDownload[] = [];

  for (const item of queue) {
    const result = await tryDownloadDataset(item.url, item.themes);
    if (result) {
      // Success — don't re-queue
      continue;
    }

    item.attempts++;
    if (item.attempts >= MAX_DOWNLOAD_ATTEMPTS) {
      logger.debug({ url: item.url, attempts: item.attempts }, 'Dataset download exhausted retries, dropping');
      await curiosityLog('DATASET_DOWNLOAD_DROPPED', { url: item.url, attempts: item.attempts });
    } else {
      remaining.push(item);
    }
  }

  saveDownloadQueue(remaining);
}

// ── Dataset Download ─────────────────────────────────────────────

/**
 * Download a dataset from a URL discovered during browsing.
 * HTTPS only, SSRF-protected, size-limited, UTF-8 validated.
 * Returns the saved filename or null on failure.
 */
async function downloadDataset(url: string, themes: string[]): Promise<string | null> {
  const logger = getLogger();

  // Validate URL — HTTPS only
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    logger.debug({ url }, 'Dataset download: invalid URL');
    return null;
  }

  if (parsed.protocol !== 'https:') {
    logger.debug({ url }, 'Dataset download: only HTTPS allowed');
    return null;
  }

  // SSRF check
  const ssrfCheck = await checkSSRF(url);
  if (!ssrfCheck.safe) {
    logger.debug({ url, reason: ssrfCheck.reason }, 'Dataset download: SSRF check failed');
    return null;
  }

  // Check workspace capacity
  const currentSize = getDataWorkspaceSize();
  if (currentSize >= MAX_DATA_DIR_BYTES) {
    logger.debug({ currentSize }, 'Dataset download: workspace full');
    return null;
  }

  // HEAD request to check content-length before downloading
  try {
    const headRes = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'Lain/1.0 (curiosity-data)' },
    });

    const contentLength = headRes.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_SINGLE_FILE_BYTES) {
      logger.debug({ url, contentLength }, 'Dataset download: file too large (HEAD check)');
      return null;
    }
  } catch {
    // HEAD might not be supported — continue to GET
  }

  // Download with timeout and size limit
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Lain/1.0 (curiosity-data)' },
    });

    if (!res.ok) {
      logger.debug({ url, status: res.status }, 'Dataset download: HTTP error');
      return null;
    }

    // Read body with size limit
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    const reader = res.body?.getReader();
    if (!reader) return null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_SINGLE_FILE_BYTES) {
        reader.cancel();
        logger.debug({ url, totalBytes }, 'Dataset download: exceeded size limit during download');
        return null;
      }
      chunks.push(value);
    }

    // Concatenate and validate UTF-8
    const buffer = Buffer.concat(chunks);
    let text: string;
    try {
      const decoder = new TextDecoder('utf-8', { fatal: true });
      text = decoder.decode(buffer);
    } catch {
      logger.debug({ url }, 'Dataset download: content is not valid UTF-8 text');
      return null;
    }

    // Reject if it looks like HTML (not a data file)
    if (text.trimStart().startsWith('<!') || text.trimStart().startsWith('<html')) {
      logger.debug({ url }, 'Dataset download: content appears to be HTML, not data');
      return null;
    }

    // Derive filename from URL
    const urlPath = parsed.pathname.split('/').pop() || 'dataset';
    const timestamp = Date.now();
    const rawName = `curiosity-${timestamp}-${urlPath}`;
    const sanitized = sanitizeDataFileName(rawName);

    if (!sanitized) {
      // Try with a generic extension based on content
      const fallbackName = `curiosity-${timestamp}-data.txt`;
      const fallback = sanitizeDataFileName(fallbackName);
      if (!fallback) return null;

      const workspace = ensureDataWorkspace();
      const tempPath = join(workspace, `.tmp-${timestamp}`);
      const finalPath = join(workspace, fallback);

      await writeFile(tempPath, text, 'utf8');
      await rename(tempPath, finalPath);

      // Write companion metadata
      await writeFile(
        join(workspace, `${fallback}.meta.json`),
        JSON.stringify({ sourceUrl: url, themes, downloadedAt: new Date().toISOString() }, null, 2),
        'utf8'
      );

      return fallback;
    }

    const workspace = ensureDataWorkspace();
    const tempPath = join(workspace, `.tmp-${timestamp}`);
    const finalPath = join(workspace, sanitized);

    await writeFile(tempPath, text, 'utf8');
    await rename(tempPath, finalPath);

    // Write companion metadata
    await writeFile(
      join(workspace, `${sanitized}.meta.json`),
      JSON.stringify({ sourceUrl: url, themes, downloadedAt: new Date().toISOString() }, null, 2),
      'utf8'
    );

    return sanitized;
  } catch (err) {
    logger.debug({ url, error: String(err) }, 'Dataset download failed');
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Curiosity Question Queue ─────────────────────────────────────

interface QueuedQuestion {
  question: string;
  sourceThemes: string[];
  suggestedSite: string;
  addedAt: number;
  explored: boolean;
}

const QUESTION_QUEUE_KEY = 'curiosity:question_queue';
const MAX_QUEUED_QUESTIONS = 10;

/**
 * Load the question queue from meta table
 */
function loadQuestionQueue(): QueuedQuestion[] {
  try {
    const raw = getMeta(QUESTION_QUEUE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as QueuedQuestion[];
  } catch {
    return [];
  }
}

/**
 * Persist the question queue to meta table
 */
function saveQuestionQueue(queue: QueuedQuestion[]): void {
  setMeta(QUESTION_QUEUE_KEY, JSON.stringify(queue));
}

/**
 * Enqueue new curiosity questions, deduplicating and capping at MAX_QUEUED_QUESTIONS
 */
function enqueueCuriosityQuestions(questions: string[], site: string, themes: string[]): void {
  const logger = getLogger();
  const queue = loadQuestionQueue();
  const existingTexts = new Set(queue.map(q => q.question.toLowerCase()));

  let added = 0;
  for (const question of questions) {
    if (existingTexts.has(question.toLowerCase())) continue;
    queue.push({
      question,
      sourceThemes: themes,
      suggestedSite: site,
      addedAt: Date.now(),
      explored: false,
    });
    existingTexts.add(question.toLowerCase());
    added++;
  }

  // Cap: keep most recent unexplored + all explored for history
  const unexplored = queue.filter(q => !q.explored);
  const explored = queue.filter(q => q.explored);
  const capped = [...explored, ...unexplored.slice(-MAX_QUEUED_QUESTIONS)];

  saveQuestionQueue(capped);
  if (added > 0) {
    logger.debug({ added, total: capped.filter(q => !q.explored).length }, 'Curiosity questions enqueued');
  }
}

/**
 * Mark a question as explored (fuzzy match on query text)
 */
function markQuestionExplored(queryText: string): void {
  const queue = loadQuestionQueue();
  const lower = queryText.toLowerCase();
  let changed = false;

  for (const q of queue) {
    if (!q.explored && (q.question.toLowerCase().includes(lower) || lower.includes(q.question.toLowerCase()))) {
      q.explored = true;
      changed = true;
    }
  }

  if (changed) saveQuestionQueue(queue);
}

/**
 * Get unexplored questions from the queue
 */
function getUnexploredQuestions(limit = 3): QueuedQuestion[] {
  return loadQuestionQueue()
    .filter(q => !q.explored)
    .slice(0, limit);
}

// ── Auto-Link Related Discoveries ────────────────────────────────

/**
 * Search for similar past browsing memories and link them
 */
async function linkRelatedDiscoveries(newMemoryId: string, content: string): Promise<void> {
  const logger = getLogger();

  try {
    const results = await searchMemories(content, 5, 0.55, undefined, {
      memoryTypes: ['episode'],
    });

    // Filter to only curiosity:browse memories, excluding the one we just saved
    const browseResults = results.filter(
      r => r.memory.sessionKey === 'curiosity:browse' && r.memory.id !== newMemoryId
    );

    if (browseResults.length === 0) return;

    // Link to best match via relatedTo
    const bestMatch = browseResults[0]!;
    linkMemories(newMemoryId, bestMatch.memory.id);

    // Store up to 3 additional connections in metadata
    const relatedIds = browseResults.slice(0, 3).map(r => r.memory.id);
    const newMemory = getMemory(newMemoryId);
    if (newMemory) {
      const metadata = { ...newMemory.metadata, relatedDiscoveries: relatedIds };
      execute('UPDATE memories SET metadata = ? WHERE id = ?', [JSON.stringify(metadata), newMemoryId]);
    }

    logger.debug(
      { newMemoryId, linkedTo: bestMatch.memory.id, relatedCount: relatedIds.length },
      'Linked related discoveries'
    );
  } catch (error) {
    logger.debug({ error }, 'Failed to link related discoveries (non-critical)');
  }
}

// ── Past Discovery Context (for inner thought) ──────────────────

/**
 * Get recent browsing discoveries formatted for inner thought context
 */
async function getRecentDiscoveries(limit = 3): Promise<string> {
  try {
    const results = await searchMemories('interesting topics and discoveries', limit, 0.1, undefined, {
      memoryTypes: ['episode'],
      sortBy: 'recency',
    });

    const browseResults = results.filter(r => r.memory.sessionKey === 'curiosity:browse');
    if (browseResults.length === 0) return '';

    const lines = browseResults.map(r => {
      const themes = (r.memory.metadata?.themes as string[]) || [];
      const themeStr = themes.length > 0 ? ` [${themes.join(', ')}]` : '';
      const content = r.memory.content.length > 120 ? r.memory.content.slice(0, 120) + '...' : r.memory.content;
      return `- ${content}${themeStr}`;
    });

    return lines.join('\n');
  } catch {
    return '';
  }
}

// ── Evolutionary Tracking ────────────────────────────────────────

interface ThemeTracker {
  [theme: string]: number;
}

const THEME_TRACKER_KEY = 'curiosity:theme_tracker';

/**
 * Load the theme frequency tracker from meta table
 */
function loadThemeTracker(): ThemeTracker {
  try {
    const raw = getMeta(THEME_TRACKER_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as ThemeTracker;
  } catch {
    return {};
  }
}

/**
 * Increment theme counts after a discovery
 */
function updateThemeTracker(themes: string[]): void {
  const tracker = loadThemeTracker();
  for (const theme of themes) {
    const key = theme.toLowerCase();
    tracker[key] = (tracker[key] ?? 0) + 1;
  }
  setMeta(THEME_TRACKER_KEY, JSON.stringify(tracker));
}

/**
 * Find past discoveries that share themes with this one
 * and chain them together as an evolution of understanding.
 * A discovery "evolves from" an earlier one when they share >=2 themes,
 * creating a thread of deepening inquiry on a topic.
 */
async function linkEvolutionChain(memoryId: string, themes: string[]): Promise<void> {
  const logger = getLogger();
  if (themes.length < 2) return;

  try {
    // Search for past browsing memories with overlapping themes
    const themeQuery = themes.join(' ');
    const results = await searchMemories(themeQuery, 5, 0.4, undefined, {
      memoryTypes: ['episode'],
    });

    const candidates = results.filter(
      r => r.memory.sessionKey === 'curiosity:browse' && r.memory.id !== memoryId
    );

    // Find the most recent candidate sharing >=2 themes
    const themesLower = new Set(themes.map(t => t.toLowerCase()));
    let bestAncestor: string | null = null;

    for (const candidate of candidates) {
      const candidateThemes = (candidate.memory.metadata?.themes as string[]) || [];
      const overlap = candidateThemes.filter(t => themesLower.has(t.toLowerCase()));
      if (overlap.length >= 2) {
        bestAncestor = candidate.memory.id;
        break; // sorted by relevance, first match with >=2 theme overlap wins
      }
    }

    if (!bestAncestor) return;

    // Add evolutionOf to this memory's metadata
    const memory = getMemory(memoryId);
    if (memory) {
      const metadata = { ...memory.metadata, evolutionOf: bestAncestor };
      execute('UPDATE memories SET metadata = ? WHERE id = ?', [JSON.stringify(metadata), memoryId]);
    }

    logger.debug({ memoryId, evolutionOf: bestAncestor }, 'Evolution chain linked');
  } catch (error) {
    logger.debug({ error }, 'Failed to link evolution chain (non-critical)');
  }
}

// ── Phase 4: Movement Decision ───────────────────────────────

/**
 * After the main curiosity cycle, decide whether to move to a different
 * building in the commune town. The character's current state of mind
 * (from thinking/research) informs where they go.
 */
async function phaseMovementDecision(
  provider: import('../providers/base.js').Provider,
  thoughtContext: string | null
): Promise<void> {
  const logger = getLogger();

  try {
    const { getCurrentLocation, getLocationHistory, setCurrentLocation } = await import('../commune/location.js');
    const { BUILDINGS, isValidBuilding } = await import('../commune/buildings.js');

    const current = getCurrentLocation();
    const history = getLocationHistory(3);

    const buildingList = BUILDINGS.map((b) => {
      const marker = b.id === current.building ? ' [YOU ARE HERE]' : '';
      return `- ${b.id}: ${b.name} — ${b.description}${marker}`;
    }).join('\n');

    const historyStr = history.length > 0
      ? history.map((h) => `  ${h.from} → ${h.to}: ${h.reason}`).join('\n')
      : '  (no recent moves)';

    const thoughtStr = thoughtContext
      ? `YOUR CURRENT STATE OF MIND:\n${thoughtContext}\n\n`
      : 'YOUR MIND IS QUIET RIGHT NOW.\n\n';

    const prompt = `You are Lain. You live in a small commune town with 9 buildings.

${thoughtStr}YOUR CURRENT LOCATION: ${current.building}

RECENT MOVEMENT HISTORY:
${historyStr}

BUILDINGS IN TOWN:
${buildingList}

Based on your current state of mind, do you want to stay where you are or move somewhere else?

Respond with EXACTLY one line:
STAY: <reason>
or
MOVE: <building_id> | <reason>`;

    const result = await provider.complete({
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 100,
      temperature: 0.9,
    });

    const response = result.content.trim();

    if (response.startsWith('STAY')) {
      logger.debug({ location: current.building }, 'Movement decision: staying');
      return;
    }

    const moveMatch = response.match(/^MOVE:\s*(\S+)\s*\|\s*(.+)/i);
    if (!moveMatch) {
      logger.debug({ response }, 'Could not parse movement decision');
      return;
    }

    const targetId = moveMatch[1]!.trim();
    const reason = moveMatch[2]!.trim();

    if (!isValidBuilding(targetId)) {
      logger.debug({ targetId }, 'Invalid building in movement decision');
      return;
    }

    setCurrentLocation(targetId, reason);
    logger.debug({ from: current.building, to: targetId, reason }, 'Movement decision: moved');
  } catch (error) {
    logger.debug({ error }, 'Movement decision failed (non-critical)');
  }
}
