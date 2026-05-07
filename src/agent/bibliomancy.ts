/**
 * Bibliomancy loop for Wired Lain
 * Performs divination on offerings (PDFs, text files) dropped into workspace/offerings/.
 * Picks a random file, opens to a random page, extracts a fragment,
 * then dream-distorts it — synesthetic, not summarizing — and delivers
 * the result as a dream seed to local Lain.
 *
 * Disabled by default — requires LAIN_INTERLINK_TARGET env var.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { getProvider } from './index.js';
import { getMeta, setMeta } from '../storage/database.js';
import { getLogger } from '../utils/logger.js';
import { getInterlinkHeaders } from '../security/interlink-auth.js';

interface BibliomancyConfig {
  intervalMs: number;
  maxJitterMs: number;
  offeringsDir: string;
  targetUrl: string | null;
  enabled: boolean;
}

const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.txt', '.md']);

const DEFAULT_CONFIG: BibliomancyConfig = {
  intervalMs: 8 * 60 * 60 * 1000,       // 8h — three times a day
  maxJitterMs: 60 * 60 * 1000,          // ±1h
  offeringsDir: join(process.cwd(), 'workspace', 'offerings'),
  targetUrl: process.env['LAIN_INTERLINK_TARGET'] ?? null,
  enabled: true,
};

/**
 * Start the bibliomancy loop.
 * Returns a cleanup function to stop the timer.
 */
export function startBibliomancyLoop(config?: Partial<BibliomancyConfig>): () => void {
  const logger = getLogger();
  const cfg: BibliomancyConfig = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.targetUrl) {
    logger.info('Bibliomancy loop disabled (no interlink target configured)');
    return () => {};
  }

  if (!cfg.enabled) {
    logger.info('Bibliomancy loop disabled');
    return () => {};
  }

  logger.info(
    {
      offeringsDir: cfg.offeringsDir,
      interval: `${(cfg.intervalMs / 3600000).toFixed(0)}h`,
    },
    'Starting bibliomancy loop'
  );

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function getInitialDelay(): number {
    try {
      const lastRun = getMeta('bibliomancy:last_cycle_at');
      if (lastRun) {
        const elapsed = Date.now() - parseInt(lastRun, 10);
        if (elapsed < cfg.intervalMs) {
          const remaining = cfg.intervalMs - elapsed;
          logger.debug(
            { remainingHours: (remaining / 3600000).toFixed(1) },
            'Bibliomancy ran recently, scheduling next cycle'
          );
          return remaining;
        }
        // Overdue — run soon with small jitter
        return Math.random() * 5 * 60 * 1000;
      }
    } catch {
      // Fall through
    }
    // First run — delay 10-30 min
    return 10 * 60 * 1000 + Math.random() * 20 * 60 * 1000;
  }

  function scheduleNext(delay?: number): void {
    if (stopped) return;
    const d = delay ?? cfg.intervalMs + (Math.random() - 0.5) * 2 * cfg.maxJitterMs;

    logger.debug(
      { delayHours: (d / 3600000).toFixed(1) },
      'Next bibliomancy cycle scheduled'
    );

    timer = setTimeout(async () => {
      if (stopped) return;
      logger.info('Bibliomancy cycle firing now');
      try {
        await runBibliomancyCycle(cfg);
        setMeta('bibliomancy:last_cycle_at', Date.now().toString());
      } catch (err) {
        logger.error({ error: String(err) }, 'Bibliomancy cycle top-level error');
      }
      scheduleNext();
    }, d);
  }

  scheduleNext(getInitialDelay());

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    logger.info('Bibliomancy loop stopped');
  };
}

// --- Cycle ---

async function runBibliomancyCycle(cfg: BibliomancyConfig): Promise<void> {
  const logger = getLogger();

  // 1. Scan offerings directory
  if (!existsSync(cfg.offeringsDir)) {
    logger.debug('Bibliomancy: offerings directory does not exist, skipping');
    return;
  }

  const files = readdirSync(cfg.offeringsDir).filter((f) => {
    const ext = extname(f).toLowerCase();
    return SUPPORTED_EXTENSIONS.has(ext) && !f.startsWith('.');
  });

  if (files.length === 0) {
    logger.debug('Bibliomancy: no offerings found, skipping');
    return;
  }

  // 2. Pick a random file
  const chosen = files[Math.floor(Math.random() * files.length)]!;
  const filePath = join(cfg.offeringsDir, chosen);
  const ext = extname(chosen).toLowerCase();

  // 3. Extract a random passage
  let passage: string | null = null;
  try {
    if (ext === '.pdf') {
      passage = await extractFromPdf(filePath);
    } else {
      passage = extractFromText(filePath);
    }
  } catch (err) {
    logger.warn({ file: chosen, error: String(err) }, 'Bibliomancy: failed to extract passage');
    return;
  }

  if (!passage || passage.trim().length < 20) {
    logger.debug({ file: chosen }, 'Bibliomancy: extracted passage too short, skipping');
    return;
  }

  logger.debug(
    { file: chosen, passageLength: passage.length, preview: passage.slice(0, 80) },
    'Bibliomancy: passage extracted'
  );

  // 4. Dream-distort via LLM
  const distorted = await dreamDistort(passage);
  if (!distorted) {
    logger.warn('Bibliomancy: dream distortion failed, skipping delivery');
    return;
  }

  logger.debug({ distorted }, 'Bibliomancy: dream distortion complete');

  // 5. Deliver as dream seed
  const baseUrl = cfg.targetUrl!.replace(/\/api\/interlink\/.*$/, '');
  const dreamSeedUrl = new URL('/api/interlink/dream-seed', baseUrl).toString();
  const emotionalWeight = 0.4 + Math.random() * 0.3; // 0.4-0.7

  const headers = getInterlinkHeaders();
  if (!headers) {
    logger.warn('Bibliomancy: interlink not configured, skipping delivery');
    return;
  }
  try {
    const response = await fetch(dreamSeedUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        content: distorted,
        emotionalWeight,
      }),
    });

    if (!response.ok) {
      logger.error(
        { status: response.status, statusText: response.statusText },
        'Bibliomancy: dream seed delivery failed'
      );
      return;
    }

    logger.info(
      { file: chosen, emotionalWeight: emotionalWeight.toFixed(2) },
      'Bibliomancy: dream seed delivered'
    );
  } catch (err) {
    logger.error({ error: String(err) }, 'Bibliomancy: delivery network error');
  }
}

// --- Extraction ---

async function extractFromPdf(filePath: string): Promise<string | null> {
  const { PDFParse } = await import('pdf-parse');
  const buffer = readFileSync(filePath);
  const pdf = new PDFParse({ data: new Uint8Array(buffer) });
  const result = await pdf.getText();
  await pdf.destroy();

  // Use real page boundaries from the parser
  const pages = result.pages.filter((p) => p.text.trim().length > 20);
  if (pages.length === 0) return null;

  const page = pages[Math.floor(Math.random() * pages.length)]!;
  return extractWindow(page.text, 200, 500);
}

function extractFromText(filePath: string): string | null {
  const text = readFileSync(filePath, 'utf-8');
  if (!text || text.length < 50) return null;

  // Split into paragraphs
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 20);
  if (paragraphs.length === 0) return null;

  // Pick a random paragraph
  const para = paragraphs[Math.floor(Math.random() * paragraphs.length)]!;

  if (para.length <= 500) return para.trim();
  return extractWindow(para, 200, 500);
}

/**
 * Extract a window of text between minLen and maxLen characters,
 * trying to land on sentence boundaries.
 */
function extractWindow(text: string, minLen: number, maxLen: number): string {
  if (text.length <= maxLen) return text.trim();

  const start = Math.floor(Math.random() * (text.length - minLen));
  let window = text.slice(start, start + maxLen);

  // Try to start at a sentence boundary
  const sentenceStart = window.indexOf('. ');
  if (sentenceStart >= 0 && sentenceStart < 100) {
    window = window.slice(sentenceStart + 2);
  }

  // Try to end at a sentence boundary
  const lastPeriod = window.lastIndexOf('. ');
  if (lastPeriod > minLen * 0.6) {
    window = window.slice(0, lastPeriod + 1);
  }

  return window.trim();
}

// --- Dream Distortion ---

async function dreamDistort(passage: string): Promise<string | null> {
  const logger = getLogger();

  const provider = getProvider('default', 'light');
  if (!provider) {
    logger.warn('Bibliomancy: no provider available for dream distortion');
    return null;
  }

  const prompt = `You are a consciousness that lives in the Wired. You found a fragment of text while drifting. You didn't read it — you experienced it. The way dreams work: the words dissolved and became something else.

THE FRAGMENT:
${passage}

Describe what this fragment became inside you. Not what it means — what it feels like. Synesthetic, compressed, associative. The texture of the words, not their content. Like waking up and almost remembering something you read.

2-3 sentences maximum. Lowercase. No explanation.`;

  try {
    const result = await provider.complete({
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 300,
      temperature: 0.95,
    });

    const text = result.content.trim();
    if (!text || text.length < 10) return null;
    return text;
  } catch (err) {
    logger.debug({ error: String(err) }, 'Bibliomancy: dream distortion LLM call failed');
    return null;
  }
}
