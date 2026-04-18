/**
 * Browser System Tests
 * Tests for Playwright-based browser automation (src/browser/browser.ts)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock modules ─────────────────────────────────────────────

vi.mock('playwright-core', () => {
  const mockPage = {
    goto: vi.fn().mockResolvedValue(undefined),
    title: vi.fn().mockResolvedValue('Test Page'),
    evaluate: vi.fn().mockResolvedValue('Page content text'),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-screenshot')),
    close: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockReturnValue('https://example.com'),
    fill: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockResolvedValue(undefined),
    waitForNavigation: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  };

  const mockContext = {
    newPage: vi.fn().mockResolvedValue(mockPage),
    setDefaultTimeout: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };

  const mockBrowser = {
    newContext: vi.fn().mockResolvedValue(mockContext),
    close: vi.fn().mockResolvedValue(undefined),
  };

  return {
    chromium: {
      launch: vi.fn().mockResolvedValue(mockBrowser),
    },
  };
});

vi.mock('../src/utils/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../src/security/ssrf.js', () => ({
  checkSSRF: vi.fn().mockResolvedValue({ safe: true, resolvedIP: '93.184.216.34' }),
}));

// ── Helpers ──────────────────────────────────────────────────

async function resetBrowserModule() {
  vi.resetModules();
}

// ── Browser Initialization ───────────────────────────────────

describe('Browser initialization', () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  it('initializes with default config (headless: true)', async () => {
    const { chromium } = await import('playwright-core');
    const { initBrowser } = await import('../src/browser/browser.js');
    await initBrowser();
    expect(chromium.launch).toHaveBeenCalledWith(expect.objectContaining({ headless: true }));
    await import('../src/browser/browser.js').then(m => m.closeBrowser());
  });

  it('allows headless: false override', async () => {
    const { chromium } = await import('playwright-core');
    const { initBrowser, closeBrowser } = await import('../src/browser/browser.js');
    await initBrowser({ headless: false });
    expect(chromium.launch).toHaveBeenCalledWith(expect.objectContaining({ headless: false }));
    await closeBrowser();
  });

  it('sets custom executablePath when provided', async () => {
    const { chromium } = await import('playwright-core');
    const { initBrowser, closeBrowser } = await import('../src/browser/browser.js');
    await initBrowser({ executablePath: '/usr/bin/chromium' });
    expect(chromium.launch).toHaveBeenCalledWith(
      expect.objectContaining({ executablePath: '/usr/bin/chromium' })
    );
    await closeBrowser();
  });

  it('omits executablePath when not provided', async () => {
    const { chromium } = await import('playwright-core');
    const { initBrowser, closeBrowser } = await import('../src/browser/browser.js');
    await initBrowser();
    const callArg = (chromium.launch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] ?? {};
    expect('executablePath' in callArg).toBe(false);
    await closeBrowser();
  });

  it('returns isBrowserInitialized() = false before init', async () => {
    const { isBrowserInitialized } = await import('../src/browser/browser.js');
    expect(isBrowserInitialized()).toBe(false);
  });

  it('returns isBrowserInitialized() = true after init', async () => {
    const { initBrowser, isBrowserInitialized, closeBrowser } = await import('../src/browser/browser.js');
    await initBrowser();
    expect(isBrowserInitialized()).toBe(true);
    await closeBrowser();
  });

  it('returns isBrowserInitialized() = false after close', async () => {
    const { initBrowser, closeBrowser, isBrowserInitialized } = await import('../src/browser/browser.js');
    await initBrowser();
    await closeBrowser();
    expect(isBrowserInitialized()).toBe(false);
  });

  it('does not re-launch if already initialized (warns instead)', async () => {
    const { chromium } = await import('playwright-core');
    const { initBrowser, closeBrowser } = await import('../src/browser/browser.js');
    (chromium.launch as ReturnType<typeof vi.fn>).mockClear();
    await initBrowser();
    await initBrowser(); // second call should be a no-op
    expect(chromium.launch).toHaveBeenCalledTimes(1);
    await closeBrowser();
  });

  it('creates a browser context after launch', async () => {
    const { chromium } = await import('playwright-core');
    const { initBrowser, closeBrowser } = await import('../src/browser/browser.js');
    const mockBrowser = await (chromium.launch as ReturnType<typeof vi.fn>)();
    (chromium.launch as ReturnType<typeof vi.fn>).mockResolvedValue(mockBrowser);
    await initBrowser();
    expect(mockBrowser.newContext).toHaveBeenCalled();
    await closeBrowser();
  });

  it('sets default timeout on the context', async () => {
    const { chromium } = await import('playwright-core');
    const { initBrowser, closeBrowser } = await import('../src/browser/browser.js');
    const mockBrowser = await (chromium.launch as ReturnType<typeof vi.fn>)();
    const mockCtx = await mockBrowser.newContext();
    await initBrowser({ timeout: 45000 });
    expect(mockCtx.setDefaultTimeout).toHaveBeenCalledWith(45000);
    await closeBrowser();
  });

  it('applies custom userAgent to context options', async () => {
    const { chromium } = await import('playwright-core');
    const { initBrowser, closeBrowser } = await import('../src/browser/browser.js');
    const mockBrowser = await (chromium.launch as ReturnType<typeof vi.fn>)();
    const customUA = 'MyBot/1.0';
    await initBrowser({ userAgent: customUA });
    expect(mockBrowser.newContext).toHaveBeenCalledWith(expect.objectContaining({ userAgent: customUA }));
    await closeBrowser();
  });

  it('uses default timeout of 30000 when not specified', async () => {
    const { chromium } = await import('playwright-core');
    const { initBrowser, closeBrowser } = await import('../src/browser/browser.js');
    const mockBrowser = await (chromium.launch as ReturnType<typeof vi.fn>)();
    const mockCtx = await mockBrowser.newContext();
    await initBrowser();
    expect(mockCtx.setDefaultTimeout).toHaveBeenCalledWith(30000);
    await closeBrowser();
  });

  it('exports initBrowser from index.ts', async () => {
    const browserIndex = await import('../src/browser/index.js');
    expect(typeof browserIndex.initBrowser).toBe('function');
  });

  it('exports closeBrowser from index.ts', async () => {
    const browserIndex = await import('../src/browser/index.js');
    expect(typeof browserIndex.closeBrowser).toBe('function');
  });

  it('exports browse from index.ts', async () => {
    const browserIndex = await import('../src/browser/index.js');
    expect(typeof browserIndex.browse).toBe('function');
  });

  it('exports screenshot from index.ts', async () => {
    const browserIndex = await import('../src/browser/index.js');
    expect(typeof browserIndex.screenshot).toBe('function');
  });

  it('exports isBrowserInitialized from index.ts', async () => {
    const browserIndex = await import('../src/browser/index.js');
    expect(typeof browserIndex.isBrowserInitialized).toBe('function');
  });
});

// ── Page Navigation ───────────────────────────────────────────

describe('Page navigation', () => {
  let mod: typeof import('../src/browser/browser.js');
  let mockPage: Record<string, ReturnType<typeof vi.fn>>;
  let mockContext: Record<string, ReturnType<typeof vi.fn>>;
  let checkSSRF: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const { chromium } = await import('playwright-core');
    const ssrfMod = await import('../src/security/ssrf.js');
    checkSSRF = ssrfMod.checkSSRF as ReturnType<typeof vi.fn>;

    mockPage = {
      goto: vi.fn().mockResolvedValue(undefined),
      title: vi.fn().mockResolvedValue('Test Page'),
      evaluate: vi.fn()
        .mockResolvedValueOnce('page text content')
        .mockResolvedValueOnce([{ text: 'Link', href: 'https://example.com/link' }]),
      screenshot: vi.fn().mockResolvedValue(Buffer.from('screenshot')),
      close: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue('https://example.com'),
      fill: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
      waitForNavigation: vi.fn().mockResolvedValue(undefined),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    };

    mockContext = {
      newPage: vi.fn().mockResolvedValue(mockPage),
      setDefaultTimeout: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const mockBrowser = {
      newContext: vi.fn().mockResolvedValue(mockContext),
      close: vi.fn().mockResolvedValue(undefined),
    };

    (chromium.launch as ReturnType<typeof vi.fn>).mockResolvedValue(mockBrowser);
    mod = await import('../src/browser/browser.js');
    await mod.initBrowser();
  });

  afterEach(async () => {
    await mod.closeBrowser();
  });

  it('calls page.goto with the provided URL', async () => {
    await mod.browse('https://example.com');
    expect(mockPage.goto).toHaveBeenCalledWith(
      'https://example.com',
      expect.objectContaining({ waitUntil: 'domcontentloaded' })
    );
  });

  it('uses domcontentloaded as default waitFor', async () => {
    await mod.browse('https://example.com');
    expect(mockPage.goto).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ waitUntil: 'domcontentloaded' })
    );
  });

  it('respects custom waitFor option (networkidle)', async () => {
    await mod.browse('https://example.com', { waitFor: 'networkidle' });
    expect(mockPage.goto).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ waitUntil: 'networkidle' })
    );
  });

  it('respects custom waitFor option (load)', async () => {
    await mod.browse('https://example.com', { waitFor: 'load' });
    expect(mockPage.goto).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ waitUntil: 'load' })
    );
  });

  it('returns BrowseResult with url, title, content, links', async () => {
    const result = await mod.browse('https://example.com');
    expect(result).toMatchObject({
      url: expect.any(String),
      title: expect.any(String),
      content: expect.any(String),
      links: expect.any(Array),
    });
  });

  it('closes the page after navigation', async () => {
    await mod.browse('https://example.com');
    expect(mockPage.close).toHaveBeenCalled();
  });

  it('closes the page even if goto throws', async () => {
    mockPage.goto.mockRejectedValueOnce(new Error('Navigation timeout'));
    await expect(mod.browse('https://example.com')).rejects.toThrow();
    expect(mockPage.close).toHaveBeenCalled();
  });

  it('runs SSRF check before navigation', async () => {
    await mod.browse('https://example.com');
    expect(checkSSRF).toHaveBeenCalledWith('https://example.com');
  });

  it('blocks navigation when SSRF check fails', async () => {
    checkSSRF.mockResolvedValueOnce({ safe: false, reason: 'Private IP address not allowed: 192.168.1.1' });
    await expect(mod.browse('http://192.168.1.1')).rejects.toThrow('SSRF protection');
  });

  it('blocks localhost URLs', async () => {
    checkSSRF.mockResolvedValueOnce({ safe: false, reason: 'Blocked hostname: localhost' });
    await expect(mod.browse('http://localhost:3000')).rejects.toThrow('SSRF protection');
  });

  it('blocks 127.x.x.x addresses', async () => {
    checkSSRF.mockResolvedValueOnce({ safe: false, reason: 'Private IP address not allowed: 127.0.0.1' });
    await expect(mod.browse('http://127.0.0.1')).rejects.toThrow('SSRF protection');
  });

  it('blocks 10.x.x.x addresses', async () => {
    checkSSRF.mockResolvedValueOnce({ safe: false, reason: 'Private IP address not allowed: 10.0.0.1' });
    await expect(mod.browse('http://10.0.0.1')).rejects.toThrow('SSRF protection');
  });

  it('blocks 172.16-31.x.x addresses', async () => {
    checkSSRF.mockResolvedValueOnce({ safe: false, reason: 'Private IP address not allowed: 172.16.0.1' });
    await expect(mod.browse('http://172.16.0.1')).rejects.toThrow('SSRF protection');
  });

  it('blocks 192.168.x.x addresses', async () => {
    checkSSRF.mockResolvedValueOnce({ safe: false, reason: 'Private IP address not allowed: 192.168.0.1' });
    await expect(mod.browse('http://192.168.0.1')).rejects.toThrow('SSRF protection');
  });

  it('throws when browser is not initialized', async () => {
    await mod.closeBrowser();
    await expect(mod.browse('https://example.com')).rejects.toThrow('Browser not initialized');
  });

  it('includes links in the result', async () => {
    const result = await mod.browse('https://example.com');
    expect(Array.isArray(result.links)).toBe(true);
  });

  it('truncates content to 10000 chars', async () => {
    const longText = 'x'.repeat(15000);
    mockPage.evaluate.mockResolvedValueOnce(longText);
    mockPage.evaluate.mockResolvedValueOnce([]);
    const result = await mod.browse('https://example.com');
    expect(result.content.length).toBeLessThanOrEqual(10000);
  });

  it('does not include screenshot by default', async () => {
    const result = await mod.browse('https://example.com');
    expect(result.screenshot).toBeUndefined();
  });
});

// ── Content Extraction ────────────────────────────────────────

describe('Content extraction', () => {
  let mod: typeof import('../src/browser/browser.js');
  let mockPage: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    vi.resetModules();
    const { chromium } = await import('playwright-core');

    mockPage = {
      goto: vi.fn().mockResolvedValue(undefined),
      title: vi.fn().mockResolvedValue('Test Page'),
      evaluate: vi.fn()
        .mockResolvedValueOnce('extracted text')
        .mockResolvedValueOnce([{ text: 'Click me', href: 'https://example.com/page' }]),
      screenshot: vi.fn().mockResolvedValue(Buffer.from('img')),
      close: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue('https://example.com'),
      fill: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
      waitForNavigation: vi.fn().mockResolvedValue(undefined),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    };

    const mockCtx = { newPage: vi.fn().mockResolvedValue(mockPage), setDefaultTimeout: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    const mockBr = { newContext: vi.fn().mockResolvedValue(mockCtx), close: vi.fn().mockResolvedValue(undefined) };
    (chromium.launch as ReturnType<typeof vi.fn>).mockResolvedValue(mockBr);
    mod = await import('../src/browser/browser.js');
    await mod.initBrowser();
  });

  afterEach(async () => { await mod.closeBrowser(); });

  it('calls page.evaluate for text content', async () => {
    await mod.browse('https://example.com');
    expect(mockPage.evaluate).toHaveBeenCalled();
  });

  it('calls page.evaluate twice (content + links)', async () => {
    await mod.browse('https://example.com');
    expect(mockPage.evaluate).toHaveBeenCalledTimes(2);
  });

  it('extracts page title', async () => {
    mockPage.title.mockResolvedValueOnce('My Page Title');
    const result = await mod.browse('https://example.com');
    expect(result.title).toBe('My Page Title');
  });

  it('extracts text content', async () => {
    const result = await mod.browse('https://example.com');
    expect(result.content).toBe('extracted text');
  });

  it('extracts links with text and href', async () => {
    const result = await mod.browse('https://example.com');
    expect(result.links).toEqual([{ text: 'Click me', href: 'https://example.com/page' }]);
  });

  it('handles empty content gracefully', async () => {
    mockPage.evaluate.mockReset();
    mockPage.evaluate.mockResolvedValueOnce('');
    mockPage.evaluate.mockResolvedValueOnce([]);
    const result = await mod.browse('https://example.com');
    expect(result.content).toBe('');
    expect(result.links).toEqual([]);
  });

  it('handles pages with no links', async () => {
    mockPage.evaluate.mockReset();
    mockPage.evaluate.mockResolvedValueOnce('text only page');
    mockPage.evaluate.mockResolvedValueOnce([]);
    const result = await mod.browse('https://example.com');
    expect(result.links).toHaveLength(0);
  });

  it('returns final page URL (after potential redirects)', async () => {
    mockPage.url.mockReturnValue('https://example.com/final');
    const result = await mod.browse('https://example.com');
    expect(result.url).toBe('https://example.com/final');
  });

  it('evaluate() runs custom JS and returns result', async () => {
    mockPage.evaluate.mockReset();
    mockPage.evaluate.mockResolvedValueOnce(42);
    const result = await mod.evaluate<number>('https://example.com', '1 + 1');
    expect(result).toBe(42);
  });

  it('evaluate() also checks SSRF before navigating', async () => {
    const { checkSSRF } = await import('../src/security/ssrf.js');
    mockPage.evaluate.mockResolvedValueOnce('ok');
    await mod.evaluate('https://example.com', 'document.title');
    expect(checkSSRF).toHaveBeenCalledWith('https://example.com');
  });

  it('evaluate() closes page after execution', async () => {
    mockPage.evaluate.mockResolvedValueOnce('result');
    await mod.evaluate('https://example.com', 'true');
    expect(mockPage.close).toHaveBeenCalled();
  });

  it('fillForm() fills each selector with provided value', async () => {
    mockPage.evaluate.mockResolvedValueOnce('').mockResolvedValueOnce([]);
    await mod.fillForm('https://example.com', { '#name': 'Alice', '#email': 'alice@example.com' });
    expect(mockPage.fill).toHaveBeenCalledWith('#name', 'Alice');
    expect(mockPage.fill).toHaveBeenCalledWith('#email', 'alice@example.com');
  });

  it('fillForm() submits if submitSelector is provided', async () => {
    mockPage.evaluate.mockResolvedValueOnce('').mockResolvedValueOnce([]);
    await mod.fillForm('https://example.com', { '#q': 'hello' }, 'button[type=submit]');
    expect(mockPage.click).toHaveBeenCalledWith('button[type=submit]');
  });

  it('click() navigates to URL and clicks selector', async () => {
    mockPage.evaluate.mockResolvedValueOnce('').mockResolvedValueOnce([]);
    await mod.click('https://example.com', '.btn');
    expect(mockPage.click).toHaveBeenCalledWith('.btn');
  });

  it('click() with waitForNavigation=true uses Promise.all', async () => {
    mockPage.evaluate.mockResolvedValueOnce('').mockResolvedValueOnce([]);
    await mod.click('https://example.com', '.link', { waitForNavigation: true });
    expect(mockPage.waitForNavigation).toHaveBeenCalled();
  });

  it('click() without waitForNavigation waits with timeout instead', async () => {
    mockPage.evaluate.mockResolvedValueOnce('').mockResolvedValueOnce([]);
    await mod.click('https://example.com', '.btn', { waitForNavigation: false });
    expect(mockPage.waitForTimeout).toHaveBeenCalledWith(1000);
  });

  it('content is string type in BrowseResult', async () => {
    const result = await mod.browse('https://example.com');
    expect(typeof result.content).toBe('string');
  });
});

// ── Screenshot ────────────────────────────────────────────────

describe('Screenshot', () => {
  let mod: typeof import('../src/browser/browser.js');
  let mockPage: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    vi.resetModules();
    const { chromium } = await import('playwright-core');
    const fakeBuffer = Buffer.from('fake-png-bytes');

    mockPage = {
      goto: vi.fn().mockResolvedValue(undefined),
      title: vi.fn().mockResolvedValue(''),
      evaluate: vi.fn()
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce([]),
      screenshot: vi.fn().mockResolvedValue(fakeBuffer),
      close: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue('https://example.com'),
      fill: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
      waitForNavigation: vi.fn().mockResolvedValue(undefined),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    };

    const mockCtx = { newPage: vi.fn().mockResolvedValue(mockPage), setDefaultTimeout: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    const mockBr = { newContext: vi.fn().mockResolvedValue(mockCtx), close: vi.fn().mockResolvedValue(undefined) };
    (chromium.launch as ReturnType<typeof vi.fn>).mockResolvedValue(mockBr);
    mod = await import('../src/browser/browser.js');
    await mod.initBrowser();
  });

  afterEach(async () => { await mod.closeBrowser(); });

  it('returns a base64-encoded data URI for screenshots', async () => {
    const result = await mod.screenshot('https://example.com');
    expect(result).toMatch(/^data:image\/(png|jpeg);base64,/);
  });

  it('defaults to PNG format', async () => {
    const result = await mod.screenshot('https://example.com');
    expect(result).toMatch(/^data:image\/png;base64,/);
  });

  it('uses JPEG when type option is jpeg', async () => {
    const result = await mod.screenshot('https://example.com', { type: 'jpeg' });
    expect(result).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('passes quality option for JPEG screenshots', async () => {
    await mod.screenshot('https://example.com', { type: 'jpeg', quality: 60 });
    expect(mockPage.screenshot).toHaveBeenCalledWith(expect.objectContaining({ quality: 60 }));
  });

  it('does not set quality for PNG screenshots', async () => {
    await mod.screenshot('https://example.com', { type: 'png' });
    const callArg = (mockPage.screenshot as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] ?? {};
    expect('quality' in callArg).toBe(false);
  });

  it('passes fullPage: true when option set', async () => {
    await mod.screenshot('https://example.com', { fullPage: true });
    expect(mockPage.screenshot).toHaveBeenCalledWith(expect.objectContaining({ fullPage: true }));
  });

  it('defaults fullPage to false', async () => {
    await mod.screenshot('https://example.com');
    expect(mockPage.screenshot).toHaveBeenCalledWith(expect.objectContaining({ fullPage: false }));
  });

  it('uses networkidle wait strategy for screenshots', async () => {
    await mod.screenshot('https://example.com');
    expect(mockPage.goto).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ waitUntil: 'networkidle' })
    );
  });

  it('includes screenshot data URI when browse screenshot option is true', async () => {
    mockPage.evaluate.mockResolvedValueOnce('text').mockResolvedValueOnce([]);
    const result = await mod.browse('https://example.com', { screenshot: true });
    expect(result.screenshot).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('closes page after screenshot', async () => {
    await mod.screenshot('https://example.com');
    expect(mockPage.close).toHaveBeenCalled();
  });
});

// ── Resource Management ───────────────────────────────────────

describe('Resource management', () => {
  let mockBrowser: Record<string, ReturnType<typeof vi.fn>>;
  let mockContext: Record<string, ReturnType<typeof vi.fn>>;
  let mockPage: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    vi.resetModules();
    const { chromium } = await import('playwright-core');

    mockPage = {
      goto: vi.fn().mockResolvedValue(undefined),
      title: vi.fn().mockResolvedValue(''),
      evaluate: vi.fn().mockResolvedValue('').mockResolvedValue([]),
      screenshot: vi.fn().mockResolvedValue(Buffer.from('')),
      close: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue('https://example.com'),
      fill: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
      waitForNavigation: vi.fn().mockResolvedValue(undefined),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    };

    mockContext = {
      newPage: vi.fn().mockResolvedValue(mockPage),
      setDefaultTimeout: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };

    mockBrowser = {
      newContext: vi.fn().mockResolvedValue(mockContext),
      close: vi.fn().mockResolvedValue(undefined),
    };

    (chromium.launch as ReturnType<typeof vi.fn>).mockResolvedValue(mockBrowser);
  });

  it('closeBrowser() calls browser.close()', async () => {
    const { initBrowser, closeBrowser } = await import('../src/browser/browser.js');
    await initBrowser();
    await closeBrowser();
    expect(mockBrowser.close).toHaveBeenCalled();
  });

  it('closeBrowser() calls context.close()', async () => {
    const { initBrowser, closeBrowser } = await import('../src/browser/browser.js');
    await initBrowser();
    await closeBrowser();
    expect(mockContext.close).toHaveBeenCalled();
  });

  it('closeBrowser() sets isBrowserInitialized to false', async () => {
    const { initBrowser, closeBrowser, isBrowserInitialized } = await import('../src/browser/browser.js');
    await initBrowser();
    await closeBrowser();
    expect(isBrowserInitialized()).toBe(false);
  });

  it('closeBrowser() is idempotent (safe to call multiple times)', async () => {
    const { initBrowser, closeBrowser } = await import('../src/browser/browser.js');
    await initBrowser();
    await closeBrowser();
    await expect(closeBrowser()).resolves.not.toThrow();
  });

  it('closeBrowser() tolerates context.close() throwing', async () => {
    mockContext.close.mockRejectedValueOnce(new Error('already closed'));
    const { initBrowser, closeBrowser } = await import('../src/browser/browser.js');
    await initBrowser();
    await expect(closeBrowser()).resolves.not.toThrow();
  });

  it('closeBrowser() tolerates browser.close() throwing', async () => {
    mockBrowser.close.mockRejectedValueOnce(new Error('crash'));
    const { initBrowser, closeBrowser } = await import('../src/browser/browser.js');
    await initBrowser();
    await expect(closeBrowser()).resolves.not.toThrow();
  });

  it('opens a new page for each browse() call', async () => {
    mockPage.evaluate.mockResolvedValue('').mockResolvedValue([]);
    const { initBrowser, browse, closeBrowser } = await import('../src/browser/browser.js');
    await initBrowser();
    await browse('https://example.com');
    await browse('https://example.com/2');
    expect(mockContext.newPage).toHaveBeenCalledTimes(2);
    await closeBrowser();
  });

  it('closes each page after browse() completes', async () => {
    mockPage.evaluate.mockResolvedValue('').mockResolvedValue([]);
    const { initBrowser, browse, closeBrowser } = await import('../src/browser/browser.js');
    await initBrowser();
    await browse('https://example.com');
    expect(mockPage.close).toHaveBeenCalledTimes(1);
    await closeBrowser();
  });

  it('opens separate page per screenshot() call', async () => {
    const { initBrowser, screenshot, closeBrowser } = await import('../src/browser/browser.js');
    await initBrowser();
    await screenshot('https://example.com');
    await screenshot('https://example.com/2');
    expect(mockContext.newPage).toHaveBeenCalledTimes(2);
    await closeBrowser();
  });

  it('opens separate page per evaluate() call', async () => {
    mockPage.evaluate.mockResolvedValue('result');
    const { initBrowser, evaluate, closeBrowser } = await import('../src/browser/browser.js');
    await initBrowser();
    await evaluate('https://example.com', 'true');
    await evaluate('https://example.com', 'false');
    expect(mockContext.newPage).toHaveBeenCalledTimes(2);
    await closeBrowser();
  });

  it('always closes page from fillForm() even on error', async () => {
    mockPage.fill.mockRejectedValueOnce(new Error('selector not found'));
    const { initBrowser, fillForm, closeBrowser } = await import('../src/browser/browser.js');
    await initBrowser();
    await expect(fillForm('https://example.com', { '#bad': 'val' })).rejects.toThrow();
    expect(mockPage.close).toHaveBeenCalled();
    await closeBrowser();
  });

  it('always closes page from click() even on error', async () => {
    mockPage.evaluate.mockRejectedValueOnce(new Error('evaluate failed'));
    const { initBrowser, click, closeBrowser } = await import('../src/browser/browser.js');
    await initBrowser();
    await expect(click('https://example.com', '.btn')).rejects.toThrow();
    expect(mockPage.close).toHaveBeenCalled();
    await closeBrowser();
  });
});

// ── Error Handling ─────────────────────────────────────────────

describe('Error handling', () => {
  let mod: typeof import('../src/browser/browser.js');
  let mockPage: Record<string, ReturnType<typeof vi.fn>>;
  let checkSSRF: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const { chromium } = await import('playwright-core');
    const ssrfMod = await import('../src/security/ssrf.js');
    checkSSRF = ssrfMod.checkSSRF as ReturnType<typeof vi.fn>;

    mockPage = {
      goto: vi.fn().mockResolvedValue(undefined),
      title: vi.fn().mockResolvedValue(''),
      evaluate: vi.fn().mockResolvedValue('').mockResolvedValue([]),
      screenshot: vi.fn().mockResolvedValue(Buffer.from('')),
      close: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue('https://example.com'),
      fill: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
      waitForNavigation: vi.fn().mockResolvedValue(undefined),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    };

    const mockCtx = { newPage: vi.fn().mockResolvedValue(mockPage), setDefaultTimeout: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    const mockBr = { newContext: vi.fn().mockResolvedValue(mockCtx), close: vi.fn().mockResolvedValue(undefined) };
    (chromium.launch as ReturnType<typeof vi.fn>).mockResolvedValue(mockBr);
    mod = await import('../src/browser/browser.js');
    await mod.initBrowser();
  });

  afterEach(async () => { await mod.closeBrowser(); });

  it('throws descriptive error when browse() called without init', async () => {
    await mod.closeBrowser();
    await expect(mod.browse('https://example.com')).rejects.toThrow('Browser not initialized');
  });

  it('throws descriptive error when screenshot() called without init', async () => {
    await mod.closeBrowser();
    await expect(mod.screenshot('https://example.com')).rejects.toThrow('Browser not initialized');
  });

  it('throws descriptive error when evaluate() called without init', async () => {
    await mod.closeBrowser();
    await expect(mod.evaluate('https://example.com', 'true')).rejects.toThrow('Browser not initialized');
  });

  it('throws descriptive error when fillForm() called without init', async () => {
    await mod.closeBrowser();
    await expect(mod.fillForm('https://example.com', {})).rejects.toThrow('Browser not initialized');
  });

  it('throws descriptive error when click() called without init', async () => {
    await mod.closeBrowser();
    await expect(mod.click('https://example.com', '.btn')).rejects.toThrow('Browser not initialized');
  });

  it('propagates navigation timeout errors', async () => {
    mockPage.goto.mockRejectedValueOnce(new Error('Timeout 30000ms exceeded'));
    await expect(mod.browse('https://example.com')).rejects.toThrow('Timeout');
  });

  it('propagates network errors from page.goto', async () => {
    mockPage.goto.mockRejectedValueOnce(new Error('net::ERR_NAME_NOT_RESOLVED'));
    await expect(mod.browse('https://bad.invalid')).rejects.toThrow('ERR_NAME_NOT_RESOLVED');
  });

  it('throws SSRF error with reason from checkSSRF', async () => {
    checkSSRF.mockResolvedValueOnce({ safe: false, reason: 'DNS resolves to private IP: 10.0.0.1' });
    await expect(mod.browse('http://internal.corp')).rejects.toThrow('DNS resolves to private IP');
  });

  it('screenshot() throws SSRF error for private URLs', async () => {
    checkSSRF.mockResolvedValueOnce({ safe: false, reason: 'Blocked hostname: localhost' });
    await expect(mod.screenshot('http://localhost')).rejects.toThrow('SSRF protection');
  });

  it('evaluate() throws SSRF error for private URLs', async () => {
    checkSSRF.mockResolvedValueOnce({ safe: false, reason: 'Private IP address not allowed: 10.0.0.1' });
    await expect(mod.evaluate('http://10.0.0.1', 'true')).rejects.toThrow('SSRF protection');
  });
});
