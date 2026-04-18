/**
 * Browser automation using Playwright
 */

import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { getLogger } from '../utils/logger.js';
import { checkSSRF } from '../security/ssrf.js';

export interface BrowserConfig {
  headless?: boolean;
  executablePath?: string;
  timeout?: number;
  userAgent?: string;
}

export interface BrowseResult {
  url: string;
  title: string;
  content: string;
  screenshot?: string;
  links: Array<{ text: string; href: string }>;
}

export interface ScreenshotOptions {
  fullPage?: boolean;
  type?: 'png' | 'jpeg';
  quality?: number;
}

let browser: Browser | null = null;
let context: BrowserContext | null = null;

const DEFAULT_CONFIG: BrowserConfig = {
  headless: true,
  timeout: 30000,
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

// Scripts to run in browser context
const EXTRACT_CONTENT_SCRIPT = `
  (() => {
    const body = document.body;
    const clone = body.cloneNode(true);
    clone.querySelectorAll('script, style, noscript').forEach(el => el.remove());
    return clone.innerText?.trim() ?? '';
  })()
`;

const EXTRACT_LINKS_SCRIPT = `
  (() => {
    return Array.from(document.querySelectorAll('a[href]'))
      .map(a => ({
        text: a.textContent?.trim() ?? '',
        href: a.href,
      }))
      .filter(l => l.text && l.href)
      .slice(0, 50);
  })()
`;

/**
 * Initialize the browser
 */
export async function initBrowser(config: BrowserConfig = {}): Promise<void> {
  const logger = getLogger();
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (browser) {
    logger.warn('Browser already initialized');
    return;
  }

  logger.info({ headless: cfg.headless }, 'Initializing browser');

  const launchOptions: Parameters<typeof chromium.launch>[0] = {
    headless: cfg.headless ?? true,
  };
  if (cfg.executablePath) {
    launchOptions.executablePath = cfg.executablePath;
  }

  browser = await chromium.launch(launchOptions);

  const contextOptions: Parameters<typeof browser.newContext>[0] = {};
  if (cfg.userAgent) {
    contextOptions.userAgent = cfg.userAgent;
  }

  context = await browser.newContext(contextOptions);

  // Set default timeout
  context.setDefaultTimeout(cfg.timeout ?? DEFAULT_CONFIG.timeout!);

  logger.info('Browser initialized');
}

/**
 * Check if browser is initialized
 */
export function isBrowserInitialized(): boolean {
  return browser !== null;
}

/**
 * Close the browser
 */
export async function closeBrowser(): Promise<void> {
  const logger = getLogger();

  // Close context and browser
  if (context) {
    await context.close().catch(() => {});
    context = null;
  }

  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }

  logger.info('Browser closed');
}

/**
 * Navigate to a URL and get page content
 */
export async function browse(
  url: string,
  options: {
    waitFor?: 'load' | 'domcontentloaded' | 'networkidle';
    screenshot?: boolean;
  } = {}
): Promise<BrowseResult> {
  const logger = getLogger();

  if (!context) {
    throw new Error('Browser not initialized. Call initBrowser() first.');
  }

  // SSRF protection
  const ssrfCheck = await checkSSRF(url);
  if (!ssrfCheck.safe) {
    throw new Error(`SSRF protection: ${ssrfCheck.reason}`);
  }

  logger.debug({ url }, 'Browsing URL');

  const page = await context.newPage();

  try {
    await page.goto(url, {
      waitUntil: options.waitFor ?? 'domcontentloaded',
    });

    const title = await page.title();

    // Get text content
    const content = await page.evaluate(EXTRACT_CONTENT_SCRIPT) as string;

    // Get links
    const links = await page.evaluate(EXTRACT_LINKS_SCRIPT) as Array<{ text: string; href: string }>;

    // Build result
    const result: BrowseResult = {
      url: page.url(),
      title,
      content: content.slice(0, 10000),
      links,
    };

    // Take screenshot if requested
    if (options.screenshot) {
      const buffer = await page.screenshot({ type: 'jpeg', quality: 80 });
      result.screenshot = `data:image/jpeg;base64,${buffer.toString('base64')}`;
    }

    return result;
  } finally {
    await page.close();
  }
}

/**
 * Take a screenshot of a URL
 */
export async function screenshot(
  url: string,
  options: ScreenshotOptions = {}
): Promise<string> {
  const logger = getLogger();

  if (!context) {
    throw new Error('Browser not initialized. Call initBrowser() first.');
  }

  // SSRF protection
  const ssrfCheck = await checkSSRF(url);
  if (!ssrfCheck.safe) {
    throw new Error(`SSRF protection: ${ssrfCheck.reason}`);
  }

  logger.debug({ url }, 'Taking screenshot');

  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'networkidle' });

    const screenshotOptions: Parameters<typeof page.screenshot>[0] = {
      fullPage: options.fullPage ?? false,
      type: options.type ?? 'png',
    };
    if (options.type === 'jpeg' && options.quality) {
      screenshotOptions.quality = options.quality;
    }

    const buffer = await page.screenshot(screenshotOptions);

    const mimeType = options.type === 'jpeg' ? 'image/jpeg' : 'image/png';
    return `data:${mimeType};base64,${buffer.toString('base64')}`;
  } finally {
    await page.close();
  }
}

/**
 * Execute JavaScript on a page
 */
export async function evaluate<T>(
  url: string,
  script: string
): Promise<T> {
  const logger = getLogger();

  if (!context) {
    throw new Error('Browser not initialized. Call initBrowser() first.');
  }

  // SSRF protection
  const ssrfCheck = await checkSSRF(url);
  if (!ssrfCheck.safe) {
    throw new Error(`SSRF protection: ${ssrfCheck.reason}`);
  }

  logger.debug({ url }, 'Evaluating script');

  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    return await page.evaluate(script) as T;
  } finally {
    await page.close();
  }
}

/**
 * Fill a form on a page
 */
export async function fillForm(
  url: string,
  formData: Record<string, string>,
  submitSelector?: string
): Promise<BrowseResult> {
  const logger = getLogger();

  if (!context) {
    throw new Error('Browser not initialized. Call initBrowser() first.');
  }

  // SSRF protection
  const ssrfCheck = await checkSSRF(url);
  if (!ssrfCheck.safe) {
    throw new Error(`SSRF protection: ${ssrfCheck.reason}`);
  }

  logger.debug({ url, fields: Object.keys(formData) }, 'Filling form');

  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // Fill form fields
    for (const [selector, value] of Object.entries(formData)) {
      await page.fill(selector, value);
    }

    // Submit if selector provided
    if (submitSelector) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
        page.click(submitSelector),
      ]);
    }

    // Get result
    const title = await page.title();
    const content = await page.evaluate(EXTRACT_CONTENT_SCRIPT) as string;
    const links = await page.evaluate(EXTRACT_LINKS_SCRIPT) as Array<{ text: string; href: string }>;

    return {
      url: page.url(),
      title,
      content: content.slice(0, 10000),
      links,
    };
  } finally {
    await page.close();
  }
}

/**
 * Click an element on a page
 */
export async function click(
  url: string,
  selector: string,
  options: { waitForNavigation?: boolean } = {}
): Promise<BrowseResult> {
  const logger = getLogger();

  if (!context) {
    throw new Error('Browser not initialized. Call initBrowser() first.');
  }

  // SSRF protection
  const ssrfCheck = await checkSSRF(url);
  if (!ssrfCheck.safe) {
    throw new Error(`SSRF protection: ${ssrfCheck.reason}`);
  }

  logger.debug({ url, selector }, 'Clicking element');

  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    if (options.waitForNavigation) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
        page.click(selector),
      ]);
    } else {
      await page.click(selector);
      await page.waitForTimeout(1000);
    }

    const title = await page.title();
    const content = await page.evaluate(EXTRACT_CONTENT_SCRIPT) as string;
    const links = await page.evaluate(EXTRACT_LINKS_SCRIPT) as Array<{ text: string; href: string }>;

    return {
      url: page.url(),
      title,
      content: content.slice(0, 10000),
      links,
    };
  } finally {
    await page.close();
  }
}
