/**
 * Tool system tests
 *
 * Validates the tool registry, execution framework, individual tool behaviors,
 * and HTML processing utilities by reading source code and testing structural
 * aspects directly.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Mock keytar before any imports that touch storage
vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn().mockResolvedValue('test-master-key'),
    setPassword: vi.fn().mockResolvedValue(undefined),
    deletePassword: vi.fn().mockResolvedValue(true),
    findCredentials: vi.fn().mockResolvedValue([]),
  },
}));

const TOOLS_PATH = join(process.cwd(), 'src', 'agent', 'tools.ts');
const toolsSource = readFileSync(TOOLS_PATH, 'utf-8');

// Web search primitives (DDG URL/POST, HTML entity decoder) live in the
// shared module now. Both tools.ts's `web_search` and server.ts's
// `webSearch` delegate to it.
const WEB_SEARCH_PATH = join(process.cwd(), 'src', 'utils', 'web-search.ts');
const webSearchSource = readFileSync(WEB_SEARCH_PATH, 'utf-8');

// ─────────────────────────────────────────────────────────
// 1. TOOL REGISTRY — Core registry functions exist and work
// ─────────────────────────────────────────────────────────
describe('Tool Registry', () => {
  it('exports registerTool function', () => {
    expect(toolsSource).toContain('export function registerTool(tool: Tool): void');
  });

  it('exports unregisterTool function', () => {
    expect(toolsSource).toContain('export function unregisterTool(name: string): boolean');
  });

  it('exports getToolDefinitions function', () => {
    // findings.md P2:1887 — signature accepts optional characterId for
    // per-character allowlist filtering.
    expect(toolsSource).toContain('export function getToolDefinitions(characterId?: string): ToolDefinition[]');
  });

  it('exports executeTool function', () => {
    expect(toolsSource).toContain('export async function executeTool(toolCall: ToolCall): Promise<ToolResult>');
  });

  it('registerTool stores tool in registeredTools map', () => {
    expect(toolsSource).toContain('registeredTools.set(tool.definition.name, tool)');
  });

  it('unregisterTool removes from map and returns boolean', () => {
    expect(toolsSource).toContain('registeredTools.delete(name)');
  });

  it('getToolDefinitions maps over registered tools', () => {
    expect(toolsSource).toContain('Array.from(registeredTools.values()).map((t) => t.definition)');
  });

  it('does not ship a dead tool-approval helper', () => {
    // toolRequiresApproval() existed but nothing in the execution path
    // ever called it — see P1 in findings.md. Enforce that if someone
    // re-adds an approval helper they must wire it into executeTool
    // (which currently calls tool.handler unconditionally).
    expect(toolsSource).not.toMatch(/export function toolRequiresApproval\b/);
    expect(toolsSource).not.toMatch(/requiresApproval\?:\s*boolean/);
    expect(toolsSource).not.toMatch(/requiresApproval:\s*true/);
  });
});

// ─────────────────────────────────────────────────────────
// 2. TOOL EXECUTION — Error handling and result processing
// ─────────────────────────────────────────────────────────
describe('Tool Execution', () => {
  it('returns isError result for unknown tools', () => {
    // The executeTool function should return an error result when tool is not found
    expect(toolsSource).toContain('isError: true');
    expect(toolsSource).toContain('Error: Unknown tool');
  });

  it('catches tool execution errors and returns isError result', () => {
    expect(toolsSource).toContain('} catch (error)');
    // P2:1851 — error content returned to the LLM is generic + incident ID,
    // not the raw handler error message.
    expect(toolsSource).toContain('failed (incident ');
    expect(toolsSource).toContain('isError: true');
  });

  it('truncates result to 1000 chars for logging', () => {
    expect(toolsSource).toContain('result.substring(0, 1000)');
  });

  it('logs tool execution start', () => {
    expect(toolsSource).toContain("'EXECUTE_TOOL_START'");
  });

  it('logs tool execution success', () => {
    expect(toolsSource).toContain("'EXECUTE_TOOL_SUCCESS'");
  });

  it('logs tool execution errors', () => {
    expect(toolsSource).toContain("'EXECUTE_TOOL_ERROR'");
  });

  it('logs unknown tool attempts', () => {
    expect(toolsSource).toContain("'UNKNOWN_TOOL'");
  });

  it('executeTools runs all tool calls in parallel', () => {
    expect(toolsSource).toContain('Promise.all(toolCalls.map(executeTool))');
  });
});

// ─────────────────────────────────────────────────────────
// 3. CALCULATE TOOL — Input sanitization
// ─────────────────────────────────────────────────────────
describe('Calculate Tool', () => {
  it('is registered as a tool', () => {
    expect(toolsSource).toContain("name: 'calculate'");
  });

  it('sanitizes expression to allow only safe characters', () => {
    // The regex removes everything except digits, operators, parens, dot, sqrt, and whitespace
    expect(toolsSource).toContain("expression.replace(/[^0-9+\\-*/().sqrt\\s]/g, '')");
  });

  it('blocks semicolons through sanitization regex', () => {
    const sanitizationRegex = /[^0-9+\-*/().sqrt\s]/g;
    expect(';'.replace(sanitizationRegex, '')).toBe('');
  });

  it('blocks require through sanitization regex (removes letters not in sqrt)', () => {
    const sanitizationRegex = /[^0-9+\-*/().sqrt\s]/g;
    // "require" keeps r, q, r (from sqrt charset); result is mangled and non-executable
    const result = 'require("fs")'.replace(sanitizationRegex, '');
    expect(result).not.toContain('require');
    expect(result).not.toContain('"');
  });

  it('blocks import through sanitization regex (removes letters not in sqrt)', () => {
    const sanitizationRegex = /[^0-9+\-*/().sqrt\s]/g;
    const result = 'import("os")'.replace(sanitizationRegex, '');
    expect(result).not.toContain('import');
    expect(result).not.toContain('"');
  });

  it('blocks process through sanitization regex (removes letters not in sqrt)', () => {
    const sanitizationRegex = /[^0-9+\-*/().sqrt\s]/g;
    const result = 'process.env'.replace(sanitizationRegex, '');
    expect(result).not.toContain('process');
  });

  it('replaces sqrt with Math.sqrt', () => {
    expect(toolsSource).toContain("sanitized.replace(/sqrt/g, 'Math.sqrt')");
  });

  it('uses new Function instead of eval', () => {
    expect(toolsSource).toContain('new Function(`return ${withMath}`)()');
  });
});

// ─────────────────────────────────────────────────────────
// 4. REMEMBER TOOL — Importance clamping
// ─────────────────────────────────────────────────────────
describe('Remember Tool', () => {
  it('is registered as a tool', () => {
    expect(toolsSource).toContain("name: 'remember'");
  });

  it('clamps importance to 0-1 range', () => {
    expect(toolsSource).toContain('Math.max(0, Math.min(1, importance))');
  });

  it('defaults importance to 0.8 when not provided', () => {
    expect(toolsSource).toContain("typeof input.importance === 'number' ? input.importance : 0.8");
  });

  it('stores as fact memory type', () => {
    expect(toolsSource).toContain("memoryType: 'fact'");
  });
});

// ─────────────────────────────────────────────────────────
// 5. RECALL TOOL — Sort strategy validation
// ─────────────────────────────────────────────────────────
describe('Recall Tool', () => {
  it('is registered as a tool', () => {
    expect(toolsSource).toContain("name: 'recall'");
  });

  it('supports relevance sort strategy', () => {
    expect(toolsSource).toContain("'relevance'");
  });

  it('supports recency sort strategy', () => {
    expect(toolsSource).toContain("'recency'");
  });

  it('supports importance sort strategy', () => {
    expect(toolsSource).toContain("'importance'");
  });

  it('supports access_count sort strategy', () => {
    expect(toolsSource).toContain("'access_count'");
  });

  it('defines sort_by as enum with all four strategies', () => {
    // The enum should list all four sort strategies
    expect(toolsSource).toContain("enum: ['relevance', 'recency', 'importance', 'access_count']");
  });
});

// ─────────────────────────────────────────────────────────
// 6. WEB_SEARCH TOOL — DuckDuckGo URL pattern
// ─────────────────────────────────────────────────────────
describe('Web Search Tool', () => {
  it('is registered as a tool', () => {
    expect(toolsSource).toContain("name: 'web_search'");
  });

  it('delegates to shared fallback chain in src/utils/web-search.ts', () => {
    // Prior implementation inlined only DDG HTML with no cascade — 202
    // anti-bot challenges were silently swallowed. The shared module
    // cascades DDG HTML → DDG Lite → Wikipedia.
    expect(toolsSource).toContain("import('../utils/web-search.js')");
    expect(toolsSource).toMatch(/const\s*\{\s*searchWeb\s*\}\s*=\s*await\s*import/);
  });

  it('uses DuckDuckGo HTML search endpoint (in shared module)', () => {
    expect(webSearchSource).toContain('https://html.duckduckgo.com/html/');
  });

  it('uses POST method for DDG HTML search (in shared module)', () => {
    expect(webSearchSource).toContain("method: 'POST'");
  });

  it('sends query as form-encoded body (in shared module)', () => {
    expect(webSearchSource).toContain('`q=${encodeURIComponent(query)}`');
  });

  it('cascades through DDG Lite and Wikipedia fallbacks', () => {
    expect(webSearchSource).toContain('lite.duckduckgo.com/lite/');
    expect(webSearchSource).toContain('en.wikipedia.org/w/api.php');
  });
});

// ─────────────────────────────────────────────────────────
// 7. FETCH_WEBPAGE TOOL — URL validation and limits
// ─────────────────────────────────────────────────────────
describe('Fetch Webpage Tool', () => {
  it('is registered as a tool', () => {
    expect(toolsSource).toContain("name: 'fetch_webpage'");
  });

  it('validates URL protocol (http/https only) via safeFetch', () => {
    // Protocol validation moved into safeFetch (src/security/ssrf.ts),
    // which rejects non-http/https schemes and private IPs for all
    // LLM-reachable fetches. The handler simply awaits safeFetch.
    const section = toolsSource.substring(
      toolsSource.indexOf("name: 'fetch_webpage'")
    );
    expect(section).toMatch(/await safeFetch\(url,/);
  });

  it('returns SSRF-protected fetch, not a raw fetch', () => {
    // Scope to the fetch_webpage registerTool block only.
    const match = toolsSource.match(
      /name: 'fetch_webpage'[\s\S]*?\n  \},\n\}\);/
    );
    expect(match).not.toBeNull();
    expect(match![0]).not.toMatch(/await fetch\(url,/);
  });

  it('truncates content at 8000 characters', () => {
    expect(toolsSource).toContain('const maxLength = 8000');
    expect(toolsSource).toContain('text.substring(0, maxLength)');
  });

  it('adds truncation notice when content is cut', () => {
    expect(toolsSource).toContain('[content truncated]');
  });
});

// ─────────────────────────────────────────────────────────
// 8. GET_CURRENT_TIME TOOL — Timezone handling
// ─────────────────────────────────────────────────────────
describe('Get Current Time Tool', () => {
  it('is registered as a tool', () => {
    expect(toolsSource).toContain("name: 'get_current_time'");
  });

  it('defaults to UTC when no timezone provided', () => {
    expect(toolsSource).toContain("const timezone = (input.timezone as string) || 'UTC'");
  });

  it('falls back to UTC on invalid timezone', () => {
    // The catch block returns UTC time
    expect(toolsSource).toContain('Current time (UTC):');
  });

  it('uses toLocaleString with timezone option', () => {
    expect(toolsSource).toContain("now.toLocaleString('en-US', { timeZone: timezone })");
  });
});

// ─────────────────────────────────────────────────────────
// 9. VIEW_IMAGE TOOL — Content-type validation
// ─────────────────────────────────────────────────────────
describe('View Image Tool', () => {
  it('is registered as a tool', () => {
    expect(toolsSource).toContain("name: 'view_image'");
  });

  it('validates content-type starts with image/', () => {
    expect(toolsSource).toContain("!contentType.startsWith('image/')");
  });

  it('rejects non-image content types', () => {
    expect(toolsSource).toContain('error: URL does not point to an image');
  });

  it('validates URL protocol + private IPs via safeFetchFollow', () => {
    // view_image delegates full SSRF (scheme check, private-IP block,
    // DNS pinning, redirect re-validation) to safeFetchFollow.
    const viewImageSection = toolsSource.substring(toolsSource.indexOf("name: 'view_image'"));
    expect(viewImageSection).toMatch(/await safeFetchFollow\(url,/);
  });
});

// ─────────────────────────────────────────────────────────
// 10. INTROSPECT_READ TOOL — Path security and limits
// ─────────────────────────────────────────────────────────
describe('Introspect Read Tool', () => {
  it('is registered as a tool', () => {
    expect(toolsSource).toContain("name: 'introspect_read'");
  });

  it('checks path is allowed with isPathAllowed', () => {
    // introspect_read handler uses isPathAllowed
    expect(toolsSource).toContain('if (!isPathAllowed(fullPath))');
  });

  it('checks file extension with hasAllowedExtension', () => {
    expect(toolsSource).toContain('if (!hasAllowedExtension(fullPath))');
  });

  it('supports line-based pagination with start_line and end_line', () => {
    expect(toolsSource).toContain("start_line");
    expect(toolsSource).toContain("end_line");
  });

  it('truncates content at 10000 characters', () => {
    expect(toolsSource).toContain('const maxLength = 10000');
  });

  it('adds truncation notice suggesting line range parameters', () => {
    expect(toolsSource).toContain('[truncated - use start_line/end_line for specific sections]');
  });
});

// ─────────────────────────────────────────────────────────
// 11. INTROSPECT_LIST TOOL — Extension and path filtering
// ─────────────────────────────────────────────────────────
describe('Introspect List Tool', () => {
  it('is registered as a tool', () => {
    expect(toolsSource).toContain("name: 'introspect_list'");
  });

  it('defines ALLOWED_EXTENSIONS for file filtering', () => {
    expect(toolsSource).toContain('const ALLOWED_EXTENSIONS = [');
  });

  it('includes common code extensions in allowed list', () => {
    expect(toolsSource).toContain("'.ts'");
    expect(toolsSource).toContain("'.js'");
    expect(toolsSource).toContain("'.json'");
    expect(toolsSource).toContain("'.md'");
    expect(toolsSource).toContain("'.html'");
    expect(toolsSource).toContain("'.css'");
  });

  it('defines EXCLUDED_PATHS for security', () => {
    expect(toolsSource).toContain('const EXCLUDED_PATHS = [');
  });

  it('excludes .env from accessible paths', () => {
    expect(toolsSource).toContain("'.env'");
  });

  it('excludes credentials from accessible paths', () => {
    expect(toolsSource).toContain("'credentials'");
  });

  it('excludes node_modules from accessible paths', () => {
    expect(toolsSource).toContain("'node_modules'");
  });

  it('excludes .git internals from accessible paths', () => {
    expect(toolsSource).toContain("'.git/objects'");
    expect(toolsSource).toContain("'.git/hooks'");
  });
});

// ─────────────────────────────────────────────────────────
// 12. isPathAllowed — Security boundary checks
// ─────────────────────────────────────────────────────────
describe('isPathAllowed Security', () => {
  it('resolves paths to absolute form', () => {
    expect(toolsSource).toContain('const normalizedPath = resolve(filePath)');
  });

  it('computes relative path from repo root', () => {
    // P2:1831 — computed against the realpath-resolved form so symlinks can't escape.
    expect(toolsSource).toMatch(/const relativePath = relative\(LAIN_REPO_PATH, \w+\)/);
  });

  it('blocks paths outside the repo (.. traversal)', () => {
    expect(toolsSource).toContain("relativePath.startsWith('..')");
  });

  it('blocks paths that do not start with repo path', () => {
    expect(toolsSource).toContain('!normalizedPath.startsWith(LAIN_REPO_PATH)');
  });

  it('checks against excluded paths list', () => {
    expect(toolsSource).toContain('relativePath.includes(excluded)');
  });

  it('derives LAIN_REPO_PATH at runtime — no hardcoded developer path', () => {
    // P1 regression (audit): previously hardcoded to /Users/apopo0308/IdeaProjects/lain,
    // which broke every introspection tool on the production droplet
    // (repo lives at /opt/local-lain/) and leaked the author's username.
    expect(toolsSource).not.toContain('/Users/apopo0308');
    expect(toolsSource).toMatch(/fileURLToPath\(new URL\('\.',\s*import\.meta\.url\)\)/);
  });
});

// ─────────────────────────────────────────────────────────
// 13. SEND_LETTER TOOL — Existence check
// ─────────────────────────────────────────────────────────
describe('Send Letter Tool', () => {
  it('is registered as a tool', () => {
    expect(toolsSource).toContain("name: 'send_letter'");
  });

  it('calls runLetterCycle on execution', () => {
    expect(toolsSource).toContain('await runLetterCycle()');
  });
});

// ─────────────────────────────────────────────────────────
// 14. TELEGRAM_CALL TOOL — dead approval metadata removed (P1 findings.md)
// ─────────────────────────────────────────────────────────
describe('Telegram Call Tool', () => {
  it('is registered as a tool', () => {
    expect(toolsSource).toContain("name: 'telegram_call'");
  });

  it('does not declare a dead requiresApproval flag', () => {
    // The flag existed but executeTool never consulted it — the tool
    // ran unattended anyway. Metadata removed; if a real approval queue
    // is added later it must gate executeTool itself.
    const telegramSection = toolsSource.substring(toolsSource.indexOf("name: 'telegram_call'"));
    expect(telegramSection).not.toContain('requiresApproval');
  });
});

// ─────────────────────────────────────────────────────────
// 15. HTML ENTITY DECODING — Correct entity handling
// ─────────────────────────────────────────────────────────
describe('HTML Entity Decoding', () => {
  // Moved from tools.ts to the shared web-search module during the
  // web_search fallback-chain consolidation. The decoder is the same.
  it('decodes &amp; to &', () => {
    expect(webSearchSource).toContain(".replace(/&amp;/g, '&')");
  });

  it('decodes &lt; to <', () => {
    expect(webSearchSource).toContain(".replace(/&lt;/g, '<')");
  });

  it('decodes &gt; to >', () => {
    expect(webSearchSource).toContain(".replace(/&gt;/g, '>')");
  });

  it('decodes &quot; to "', () => {
    expect(webSearchSource).toContain('.replace(/&quot;/g, \'"\')');
  });

  it('decodes &#x27; to single quote', () => {
    expect(webSearchSource).toContain("replace(/&#x27;/g, \"'\")");
  });

  it('decodes &#39; to single quote', () => {
    expect(webSearchSource).toContain("replace(/&#39;/g, \"'\")");
  });

  it('decodes &nbsp; to space', () => {
    expect(webSearchSource).toContain(".replace(/&nbsp;/g, ' ')");
  });

  it('decodes numeric character references', () => {
    expect(webSearchSource).toContain('String.fromCharCode(parseInt(num, 10))');
  });
});

// ─────────────────────────────────────────────────────────
// 16. extractTextFromHtml — Tag removal
// ─────────────────────────────────────────────────────────
describe('extractTextFromHtml', () => {
  it('is exported from tools.ts', () => {
    expect(toolsSource).toContain('export function extractTextFromHtml(html: string): string');
  });

  it('removes script tags', () => {
    expect(toolsSource).toContain('<script[\\s\\S]*?<\\/script>');
  });

  it('removes style tags', () => {
    expect(toolsSource).toContain('<style[\\s\\S]*?<\\/style>');
  });

  it('removes nav tags', () => {
    expect(toolsSource).toContain('<nav[\\s\\S]*?<\\/nav>');
  });

  it('removes footer tags', () => {
    expect(toolsSource).toContain('<footer[\\s\\S]*?<\\/footer>');
  });

  it('removes header tags', () => {
    expect(toolsSource).toContain('<header[\\s\\S]*?<\\/header>');
  });

  it('removes noscript tags', () => {
    expect(toolsSource).toContain('<noscript[\\s\\S]*?<\\/noscript>');
  });

  it('tries to extract main content first', () => {
    expect(toolsSource).toContain('<main[\\s\\S]*?<\\/main>');
    expect(toolsSource).toContain('<article[\\s\\S]*?<\\/article>');
  });

  it('strips all HTML tags from final output', () => {
    expect(toolsSource).toContain(".replace(/<[^>]+>/g, ' ')");
  });

  it('collapses whitespace', () => {
    expect(toolsSource).toContain(".replace(/\\s+/g, ' ')");
  });
});

// ─────────────────────────────────────────────────────────
// 17. FUNCTIONAL — extractTextFromHtml actually works
// ─────────────────────────────────────────────────────────
describe('extractTextFromHtml functional', () => {
  // Dynamic import to get the actual function
  let extractTextFromHtml: (html: string) => string;

  beforeAll(async () => {
    const mod = await import('../src/agent/tools.js');
    extractTextFromHtml = mod.extractTextFromHtml;
  });

  it('removes script content completely', () => {
    const html = '<div>Hello<script>alert("xss")</script> World</div>';
    const result = extractTextFromHtml(html);
    expect(result).not.toContain('alert');
    expect(result).toContain('Hello');
    expect(result).toContain('World');
  });

  it('removes style content completely', () => {
    const html = '<div>Hello<style>.red{color:red}</style> World</div>';
    const result = extractTextFromHtml(html);
    expect(result).not.toContain('color');
  });

  it('removes nav content', () => {
    const html = '<nav>Menu Items</nav><div>Main Content</div>';
    const result = extractTextFromHtml(html);
    expect(result).not.toContain('Menu Items');
    expect(result).toContain('Main Content');
  });

  it('removes footer content', () => {
    const html = '<div>Main Content</div><footer>Copyright 2024</footer>';
    const result = extractTextFromHtml(html);
    expect(result).not.toContain('Copyright');
  });

  it('removes header content', () => {
    const html = '<header>Site Header</header><div>Main Content</div>';
    const result = extractTextFromHtml(html);
    expect(result).not.toContain('Site Header');
  });

  it('decodes HTML entities in output', () => {
    const html = '<div>Tom &amp; Jerry &lt;3</div>';
    const result = extractTextFromHtml(html);
    expect(result).toContain('Tom & Jerry <3');
  });

  it('returns trimmed text', () => {
    const html = '<div>  Hello World  </div>';
    const result = extractTextFromHtml(html);
    expect(result).toBe(result.trim());
  });

  it('returns empty string for empty input', () => {
    const result = extractTextFromHtml('');
    expect(result).toBe('');
  });
});

// ─────────────────────────────────────────────────────────
// 18. ADDITIONAL TOOLS — Existence checks
// ─────────────────────────────────────────────────────────
describe('Additional Tool Registration', () => {
  it('registers expand_memory tool', () => {
    expect(toolsSource).toContain("name: 'expand_memory'");
  });

  // create_tool / list_my_tools / delete_tool were removed in findings.md P1:1561.
  // The skills.ts module handed new Function() + require + process to LLM-
  // authored JS, making every injection vector a path to host RCE.
  it('does NOT register the removed create_tool meta-tool (P1 findings.md:1561)', () => {
    expect(toolsSource).not.toContain("name: 'create_tool'");
  });

  it('does NOT register the removed list_my_tools meta-tool (P1 findings.md:1561)', () => {
    expect(toolsSource).not.toContain("name: 'list_my_tools'");
  });

  it('does NOT register the removed delete_tool meta-tool (P1 findings.md:1561)', () => {
    expect(toolsSource).not.toContain("name: 'delete_tool'");
  });

  it('registers introspect_search tool', () => {
    expect(toolsSource).toContain("name: 'introspect_search'");
  });

  it('registers introspect_info tool', () => {
    expect(toolsSource).toContain("name: 'introspect_info'");
  });

  it('registers show_image tool', () => {
    expect(toolsSource).toContain("name: 'show_image'");
  });

  it('registers search_images tool', () => {
    expect(toolsSource).toContain("name: 'search_images'");
  });

  it('registers fetch_and_show_image tool', () => {
    expect(toolsSource).toContain("name: 'fetch_and_show_image'");
  });

  it('registers send_message tool', () => {
    expect(toolsSource).toContain("name: 'send_message'");
  });
});
