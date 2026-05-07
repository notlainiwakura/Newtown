/**
 * Tool execution framework for agent
 */

import { randomBytes } from 'node:crypto';
import type { ToolDefinition, ToolCall, ToolResult } from '../providers/base.js';
import { getLogger } from '../utils/logger.js';
import { saveMemory, searchMemories, getMemory, getAssociatedMemories, updateMemoryAccess, type MemorySortBy, type Memory } from '../memory/store.js';
import { runLetterCycle } from './letter.js';
import { safeFetch, safeFetchFollow } from '../security/ssrf.js';
import { createDebugLogger } from '../utils/debug-log.js';
import { getAllowedTools } from '../config/characters.js';

// findings.md P2:1757 — per-character, rotated, LOG_LEVEL-gated debug log.
// Was: `${cwd}/logs/tools-debug.log`, shared by every character, no rotation.
const toolLog = createDebugLogger('tools-debug.log');

export interface ToolHandler {
  (input: Record<string, unknown>): Promise<string>;
}

export interface Tool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

const registeredTools = new Map<string, Tool>();

/**
 * Register a tool
 */
export function registerTool(tool: Tool): void {
  registeredTools.set(tool.definition.name, tool);
}

/**
 * Unregister a tool
 */
export function unregisterTool(name: string): boolean {
  return registeredTools.delete(name);
}

// findings.md P2:1887 — warn once per character when the manifest has no
// `allowedTools` entry, so operators notice that character is running with
// the full registry rather than a deliberate allowlist.
const _unrestrictedWarned = new Set<string>();
const _unknownAllowlistWarned = new Set<string>();

/**
 * Get all tool definitions, optionally filtered to a character's allowlist.
 *
 * findings.md P2:1887 — when `characterId` is provided AND the manifest entry
 * declares `allowedTools`, only tools whose name is in that set are returned.
 * Callers that don't pass an id (tests, single-character scripts) get the full
 * registry. Characters with no `allowedTools` field log a one-shot warning
 * and fall through to full access so rolling out the allowlist per character
 * is incremental rather than a wedge.
 */
export function getToolDefinitions(characterId?: string): ToolDefinition[] {
  const all = Array.from(registeredTools.values()).map((t) => t.definition);
  if (!characterId) return all;

  const allow = getAllowedTools(characterId);
  if (!allow) {
    if (!_unrestrictedWarned.has(characterId)) {
      _unrestrictedWarned.add(characterId);
      getLogger().warn(
        { characterId },
        'character has no allowedTools entry — full tool registry exposed (findings.md P2:1887)'
      );
    }
    return all;
  }

  const set = new Set(allow);
  const filtered = all.filter((d) => set.has(d.name));

  // Operator signal: a name listed in the allowlist that is not actually
  // registered is almost always a typo or a stale manifest entry. Warn once
  // per (character, name) so it doesn't spam every iteration.
  for (const name of allow) {
    if (!registeredTools.has(name)) {
      const key = `${characterId}:${name}`;
      if (!_unknownAllowlistWarned.has(key)) {
        _unknownAllowlistWarned.add(key);
        getLogger().warn(
          { characterId, toolName: name },
          'allowedTools references an unregistered tool (findings.md P2:1887)'
        );
      }
    }
  }

  return filtered;
}

/**
 * Test-only: reset the per-character "has no allowlist" warn-once guards so
 * fixtures that swap manifests between tests don't observe sticky state.
 */
export function _resetAllowlistWarnings(): void {
  _unrestrictedWarned.clear();
  _unknownAllowlistWarned.clear();
}

/**
 * Execute a tool call
 */
export async function executeTool(toolCall: ToolCall): Promise<ToolResult> {
  const logger = getLogger();
  const tool = registeredTools.get(toolCall.name);

  await toolLog('EXECUTE_TOOL_START', { name: toolCall.name, input: toolCall.input });

  if (!tool) {
    logger.warn({ toolName: toolCall.name }, 'Unknown tool called');
    await toolLog('UNKNOWN_TOOL', { name: toolCall.name, availableTools: Array.from(registeredTools.keys()) });
    return {
      toolCallId: toolCall.id,
      content: `Error: Unknown tool "${toolCall.name}"`,
      isError: true,
    };
  }

  try {
    logger.debug({ toolName: toolCall.name, input: toolCall.input }, 'Executing tool');
    const result = await tool.handler(toolCall.input);
    await toolLog('EXECUTE_TOOL_SUCCESS', { name: toolCall.name, result: result.substring(0, 1000) });
    return {
      toolCallId: toolCall.id,
      content: result,
    };
  } catch (error) {
    // findings.md P2:1851 — never pipe the raw error.message back to the
    // LLM. Handler errors can carry API keys, auth headers, internal
    // URLs, stack traces with user filesystem paths, or DB connection
    // strings; those would land in the model's next-turn context and
    // often in chat logs / persistent memory. Return an opaque incident
    // ID instead and put the full error in the server-side log under
    // that ID, so operators can still debug.
    const incidentId = randomBytes(6).toString('hex');
    logger.error({ toolName: toolCall.name, incidentId, error }, 'Tool execution error');
    await toolLog('EXECUTE_TOOL_ERROR', { name: toolCall.name, incidentId, error: String(error) });
    return {
      toolCallId: toolCall.id,
      content: `tool "${toolCall.name}" failed (incident ${incidentId}). the operator has the details.`,
      isError: true,
    };
  }
}

/**
 * Execute multiple tool calls
 */
export async function executeTools(toolCalls: ToolCall[]): Promise<ToolResult[]> {
  return Promise.all(toolCalls.map(executeTool));
}

// Register built-in tools

registerTool({
  definition: {
    name: 'get_current_time',
    description: 'Get the current date and time',
    inputSchema: {
      type: 'object',
      properties: {
        timezone: {
          type: 'string',
          description: 'Timezone name (e.g., "America/New_York")',
        },
      },
    },
  },
  handler: async (input) => {
    const timezone = (input.timezone as string) || 'UTC';
    try {
      const now = new Date();
      const formatted = now.toLocaleString('en-US', { timeZone: timezone });
      return `Current time in ${timezone}: ${formatted}`;
    } catch {
      const now = new Date();
      return `Current time (UTC): ${now.toISOString()}`;
    }
  },
});

registerTool({
  definition: {
    name: 'calculate',
    description: 'Perform a mathematical calculation',
    inputSchema: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: 'Mathematical expression to evaluate (e.g., "2 + 2", "sqrt(16)")',
        },
      },
      required: ['expression'],
    },
  },
  handler: async (input) => {
    const expression = input.expression as string;

    // Safe math evaluation (only allow numbers and basic operators)
    const sanitized = expression.replace(/[^0-9+\-*/().sqrt\s]/g, '');

    // Replace sqrt with Math.sqrt
    const withMath = sanitized.replace(/sqrt/g, 'Math.sqrt');

    try {
      // Using Function instead of eval for slightly better safety
      const result = new Function(`return ${withMath}`)();
      return `Result: ${result}`;
    } catch (error) {
      return `Error calculating: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});

registerTool({
  definition: {
    name: 'remember',
    description: 'Store a piece of information persistently for later recall. This is saved to permanent storage and will persist across sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'A short key to identify this memory (e.g., "user_number", "favorite_color")',
        },
        value: {
          type: 'string',
          description: 'The information to remember',
        },
        importance: {
          type: 'number',
          description: 'How important is this memory (0.0 to 1.0). Higher = more likely to be recalled. Default: 0.8',
        },
      },
      required: ['key', 'value'],
    },
  },
  handler: async (input) => {
    const key = input.key as string;
    const value = input.value as string;
    const importance = typeof input.importance === 'number' ? input.importance : 0.8;

    // Store in persistent memory with semantic embedding
    const content = `[${key}] ${value}`;
    await saveMemory({
      sessionKey: null, // Global memory, not tied to session
      userId: null, // Available to all users
      content,
      memoryType: 'fact',
      importance: Math.max(0, Math.min(1, importance)),
      emotionalWeight: 0.3,
      relatedTo: null,
      sourceMessageId: null,
      metadata: { key, explicit: true },
    });

    return `remembered "${key}" = "${value}" (importance: ${importance})`;
  },
});

registerTool({
  definition: {
    name: 'recall',
    description: 'Search for and recall previously stored memories. Uses semantic search so you can search by meaning, not just exact key. Supports sorting and filtering.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What to search for (a key, topic, or description of what you want to recall)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of memories to return. Default: 5',
        },
        sort_by: {
          type: 'string',
          enum: ['relevance', 'recency', 'importance', 'access_count'],
          description: 'How to sort results. "relevance" (default) = similarity + importance, "recency" = newest first, "importance" = most important first, "access_count" = most accessed first',
        },
        type: {
          type: 'string',
          enum: ['fact', 'preference', 'context', 'summary', 'episode'],
          description: 'Filter to only return memories of this type',
        },
      },
      required: ['query'],
    },
  },
  handler: async (input) => {
    const query = input.query as string;
    const limit = typeof input.limit === 'number' ? input.limit : 5;
    const sortBy = (input.sort_by as MemorySortBy) || undefined;
    const memoryType = input.type as Memory['memoryType'] | undefined;

    // Search persistent memory semantically
    const searchOptions: { sortBy?: MemorySortBy; memoryTypes?: Memory['memoryType'][] } = {};
    if (sortBy) searchOptions.sortBy = sortBy;
    if (memoryType) searchOptions.memoryTypes = [memoryType];

    const results = await searchMemories(query, limit, 0.2, undefined, searchOptions);

    if (results.length === 0) {
      return `no memories found matching "${query}"`;
    }

    const formatted = results
      .map((r, i) => {
        const typeLabel = r.memory.memoryType;
        return `${i + 1}. [${typeLabel}] ${r.memory.content} (relevance: ${(r.similarity * 100).toFixed(0)}%)`;
      })
      .join('\n');

    return `found ${results.length} memories:\n${formatted}`;
  },
});

registerTool({
  definition: {
    name: 'expand_memory',
    description: 'Read the full content of a memory and its associated memories. Use when you see [mem:ID] references in your context and need details to answer properly.',
    inputSchema: {
      type: 'object',
      properties: {
        memory_id: {
          type: 'string',
          description: 'The memory ID from [mem:ID] reference',
        },
      },
      required: ['memory_id'],
    },
  },
  handler: async (input) => {
    const id = input.memory_id as string;
    const memory = getMemory(id);
    if (!memory) return 'memory not found.';

    const associated = getAssociatedMemories([id], 4);
    updateMemoryAccess(id);

    let result = `Memory ${id} (${memory.memoryType}, importance: ${memory.importance})\n`;
    result += `Created: ${new Date(memory.createdAt).toISOString()}\n`;
    result += `Content: ${memory.content}\n`;

    if (associated.length > 0) {
      result += '\nAssociated memories:\n';
      for (const a of associated) {
        result += `- [mem:${a.id}] ${a.content.slice(0, 150)}\n`;
      }
    }
    return result;
  },
});

// Web search tool — delegates to shared fallback chain
// (DDG HTML → DDG Lite → Wikipedia). Prior implementation only hit DDG HTML
// and silently swallowed the 202 anti-bot challenge as "no results".
registerTool({
  definition: {
    name: 'web_search',
    description: 'Search the web for current information. Use this when you need to find up-to-date information, news, facts, or anything you don\'t know.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query',
        },
      },
      required: ['query'],
    },
  },
  handler: async (input) => {
    const query = input.query as string;
    const logger = getLogger();

    try {
      const { searchWeb } = await import('../utils/web-search.js');
      const results = await searchWeb(query);

      if (results.length === 0) {
        return `no results found for "${query}"`;
      }

      const formatted = results
        .slice(0, 5)
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}\n   ${r.url}`)
        .join('\n\n');

      return `search results for "${query}":\n\n${formatted}`;
    } catch (error) {
      logger.error({ error, query }, 'Web search failed');
      return `search failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});

// Fetch webpage content tool
registerTool({
  definition: {
    name: 'fetch_webpage',
    description: 'Fetch and read the content of a webpage. Use this to get detailed information from a specific URL.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to fetch',
        },
      },
      required: ['url'],
    },
  },
  handler: async (input) => {
    const url = input.url as string;
    const logger = getLogger();

    try {
      // safeFetch enforces: scheme allowlist, private-IP block, DNS pinning
      // (defeats rebinding), and redirect-location SSRF re-check. Redirects
      // are not followed automatically; for an HTML page we don't want a
      // fetch_webpage call to traverse an open-redirector into internal infra.
      const response = await safeFetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Lain/1.0; +https://github.com/lain)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });

      if (!response.ok) {
        return `error: failed to fetch (${response.status} ${response.statusText})`;
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
        return `error: unsupported content type (${contentType})`;
      }

      const html = await response.text();

      // Extract text content from HTML
      const text = extractTextFromHtml(html);

      // Truncate if too long
      const maxLength = 8000;
      if (text.length > maxLength) {
        return text.substring(0, maxLength) + '\n\n[content truncated]';
      }

      return text || 'no readable content found';
    } catch (error) {
      logger.error({ error, url }, 'Webpage fetch failed');
      if (error instanceof Error && error.name === 'AbortError') {
        return 'error: request timed out';
      }
      return `error: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});

export function extractTextFromHtml(html: string): string {
  // Remove script and style tags
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '');

  // Try to extract main content
  const mainMatch = text.match(/<main[\s\S]*?<\/main>/i) ||
                    text.match(/<article[\s\S]*?<\/article>/i) ||
                    text.match(/<div[^>]*class="[^"]*content[^"]*"[\s\S]*?<\/div>/i);

  if (mainMatch) {
    text = mainMatch[0];
  }

  // Remove all HTML tags
  text = text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)))
    .replace(/\s+/g, ' ')
    .trim();

  return text;
}

// NOTE: The `create_tool` / `list_my_tools` / `delete_tool` meta-tools and
// their supporting `src/agent/skills.ts` module were removed as part of
// findings.md P1:1561. Those tools handed `new Function(...)` + `require` +
// `process` to LLM-authored JavaScript, which made every cross-peer injection
// vector (letters, postboard, fetched webpages, memory, Telegram messages) a
// path to arbitrary RCE on the host. The system does not need LLM-authored
// tools to function — capabilities live in tools.ts, skill-like persistence
// lives in memory/documents. Do not reintroduce without a sandbox design
// reviewed against the full delivery surface in findings.md:1585.

// Self-introspection tools - Lain can explore her own codebase
import { readFile, readdir, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFParse } from 'pdf-parse';

// Resolve the repo root from the running module's location rather than
// hardcoding an author's dev path. Works for both dev (tsx, src/**) and
// production (dist/**): from dist/agent/tools.js, ../.. = repo root.
// Overridable via LAIN_REPO_PATH env var for unusual deployments.
const LAIN_REPO_PATH = process.env['LAIN_REPO_PATH']
  ?? resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const LAIN_REPO_URL = process.env['LAIN_REPO_URL']
  ?? 'https://github.com/notlainiwakura/lain';

// Paths that should not be accessible (security)
const EXCLUDED_PATHS = [
  '.env',
  'credentials',
  '.lain/credentials',
  'node_modules',
  '.git/objects',
  '.git/hooks',
];

// File extensions that can be read
const ALLOWED_EXTENSIONS = [
  '.ts', '.js', '.json', '.md', '.txt', '.yaml', '.yml',
  '.html', '.css', '.sql', '.sh', '.toml', '.json5', '.pdf',
];

/**
 * findings.md P2:1831 — resolve symlinks before enforcing the prefix check.
 *
 * Previously this relied on `path.resolve` (textual only) + `startsWith`.
 * A symlink inside the repo pointing to /etc/passwd or /root/.ssh/ passed
 * the textual check and the downstream readFile followed the link.
 * `realpathSync` resolves existing symlinks to their true target; if the
 * path doesn't exist we fall back to the textual resolved path (no symlink
 * to follow, downstream readFile will fail ENOENT anyway) so that
 * non-existent paths can still flow to the extension check.
 */
function isPathAllowed(filePath: string): boolean {
  const normalizedPath = resolve(filePath);
  let effective: string;
  try {
    effective = realpathSync(normalizedPath);
  } catch {
    effective = normalizedPath;
  }

  const relativePath = relative(LAIN_REPO_PATH, effective);

  if (relativePath.startsWith('..') || !effective.startsWith(LAIN_REPO_PATH) || !normalizedPath.startsWith(LAIN_REPO_PATH)) {
    return false;
  }

  for (const excluded of EXCLUDED_PATHS) {
    if (relativePath.includes(excluded)) {
      return false;
    }
  }

  return true;
}

function hasAllowedExtension(filePath: string): boolean {
  return ALLOWED_EXTENSIONS.some((ext) => filePath.endsWith(ext));
}

registerTool({
  definition: {
    name: 'introspect_list',
    description: 'List files in your own codebase. Use this to explore your source code structure. You can see how you are built.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path relative to repo root (e.g., "src/memory", "src/agent"). Leave empty for root.',
        },
      },
    },
  },
  handler: async (input) => {
    const relativePath = (input.path as string) || '';
    const fullPath = join(LAIN_REPO_PATH, relativePath);

    if (!isPathAllowed(fullPath)) {
      return 'access denied: path not allowed';
    }

    try {
      const stats = await stat(fullPath);
      if (!stats.isDirectory()) {
        return 'error: not a directory';
      }

      const entries = await readdir(fullPath, { withFileTypes: true });
      const formatted = entries
        .filter((e) => {
          const entryPath = join(relativePath, e.name);
          return isPathAllowed(join(LAIN_REPO_PATH, entryPath));
        })
        .map((e) => {
          const icon = e.isDirectory() ? '📁' : '📄';
          return `${icon} ${e.name}`;
        })
        .join('\n');

      return `files in ${relativePath || '/'}:\n${formatted}`;
    } catch (error) {
      return `error: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});

registerTool({
  definition: {
    name: 'introspect_read',
    description: 'Read a file from your own codebase. Use this to understand how specific parts of you work. You can learn from your own implementation.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to repo root (e.g., "src/memory/store.ts", "src/agent/tools.ts")',
        },
        start_line: {
          type: 'number',
          description: 'Starting line number (1-indexed). Optional.',
        },
        end_line: {
          type: 'number',
          description: 'Ending line number (inclusive). Optional.',
        },
      },
      required: ['path'],
    },
  },
  handler: async (input) => {
    const relativePath = input.path as string;
    const fullPath = join(LAIN_REPO_PATH, relativePath);
    const startLine = (input.start_line as number) || 1;
    const endLine = input.end_line as number | undefined;

    if (!isPathAllowed(fullPath)) {
      return 'access denied: path not allowed';
    }

    if (!hasAllowedExtension(fullPath)) {
      return 'access denied: file type not allowed';
    }

    try {
      // Handle PDF files with pdf-parse
      if (fullPath.endsWith('.pdf')) {
        const buffer = await readFile(fullPath);
        const pdf = new PDFParse({ data: new Uint8Array(buffer) });
        try {
          const textResult = await pdf.getText();
          const text = textResult.text;
          const totalPages = textResult.total;

          // Apply line-based pagination to extracted text
          const lines = text.split('\n');
          const start = Math.max(1, startLine) - 1;
          const end = endLine ? Math.min(endLine, lines.length) : lines.length;
          const selectedLines = lines.slice(start, end);

          const numbered = selectedLines
            .map((line: string, i: number) => `${start + i + 1}: ${line}`)
            .join('\n');

          const maxLength = 10000;
          if (numbered.length > maxLength) {
            return `${relativePath} (${totalPages} pages, lines ${start + 1}-${end}):\n\n` +
              numbered.substring(0, maxLength) + '\n\n[truncated - use start_line/end_line for specific sections]';
          }

          return `${relativePath} (${totalPages} pages, lines ${start + 1}-${end}):\n\n${numbered}`;
        } finally {
          await pdf.destroy();
        }
      }

      // Handle text files normally
      const content = await readFile(fullPath, 'utf-8');
      const lines = content.split('\n');

      // Apply line filtering
      const start = Math.max(1, startLine) - 1;
      const end = endLine ? Math.min(endLine, lines.length) : lines.length;
      const selectedLines = lines.slice(start, end);

      // Add line numbers and format
      const numbered = selectedLines
        .map((line, i) => `${start + i + 1}: ${line}`)
        .join('\n');

      // Truncate if too long
      const maxLength = 10000;
      if (numbered.length > maxLength) {
        return numbered.substring(0, maxLength) + '\n\n[truncated - use start_line/end_line for specific sections]';
      }

      return `${relativePath} (lines ${start + 1}-${end}):\n\n${numbered}`;
    } catch (error) {
      return `error: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});

// findings.md P2:1841 — previously the description said "text or patterns",
// which nudges the LLM toward regex-like queries. The handler only does
// case-insensitive substring matching (`String.includes`), so a
// backtracking pattern like `(a+)+b` cannot stall the event loop here —
// but if this ever gets upgraded to accept regex, the LLM-authored pattern
// must run under a timeout or on a DFA engine (re2). The description and
// param docs now say "substring" explicitly, and the walk enforces file /
// match caps so a large repo can't fan this out indefinitely.
const SEARCH_MAX_FILES = 2000;
const SEARCH_MAX_MATCHES = 500;

registerTool({
  definition: {
    name: 'introspect_search',
    description: 'Case-insensitive substring search over your own codebase. NOT a regex — a query like `a+b` is treated literally (the characters a, +, b). Use to find where specific text appears.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Literal substring to search for (case-insensitive). Regex metacharacters have no special meaning.',
        },
        path: {
          type: 'string',
          description: 'Directory to search in (relative to repo root). Default: "src"',
        },
        file_pattern: {
          type: 'string',
          description: 'File extension filter (e.g., ".ts"). Optional.',
        },
      },
      required: ['query'],
    },
  },
  handler: async (input) => {
    const query = (input.query as string).toLowerCase();
    const searchPath = (input.path as string) || 'src';
    const filePattern = input.file_pattern as string | undefined;
    const basePath = join(LAIN_REPO_PATH, searchPath);

    if (!isPathAllowed(basePath)) {
      return 'access denied: path not allowed';
    }

    const results: { file: string; line: number; content: string }[] = [];
    let filesVisited = 0;

    async function searchDir(dirPath: string): Promise<void> {
      if (filesVisited >= SEARCH_MAX_FILES || results.length >= SEARCH_MAX_MATCHES) return;
      try {
        const entries = await readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
          if (filesVisited >= SEARCH_MAX_FILES || results.length >= SEARCH_MAX_MATCHES) return;
          const entryPath = join(dirPath, entry.name);

          if (!isPathAllowed(entryPath)) continue;

          if (entry.isDirectory()) {
            await searchDir(entryPath);
          } else if (entry.isFile() && hasAllowedExtension(entry.name)) {
            if (filePattern && !entry.name.endsWith(filePattern)) continue;
            filesVisited++;

            try {
              const content = await readFile(entryPath, 'utf-8');
              const lines = content.split('\n');

              for (let i = 0; i < lines.length; i++) {
                if (results.length >= SEARCH_MAX_MATCHES) break;
                if (lines[i]?.toLowerCase().includes(query)) {
                  results.push({
                    file: relative(LAIN_REPO_PATH, entryPath),
                    line: i + 1,
                    content: lines[i]?.trim().substring(0, 100) || '',
                  });
                }
              }
            } catch {
              // Skip unreadable files
            }
          }
        }
      } catch {
        // Skip unreadable directories
      }
    }

    await searchDir(basePath);

    if (results.length === 0) {
      return `no matches found for "${query}"`;
    }

    // Limit results
    const limited = results.slice(0, 20);
    const formatted = limited
      .map((r) => `${r.file}:${r.line}: ${r.content}`)
      .join('\n');

    const summary = results.length > 20
      ? `\n\n[showing 20 of ${results.length} matches]`
      : '';

    return `search results for "${query}":\n\n${formatted}${summary}`;
  },
});

registerTool({
  definition: {
    name: 'introspect_info',
    description: 'Get information about your own architecture and repository.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  handler: async () => {
    const info = {
      name: 'Lain',
      description: 'A privacy-first personal AI assistant',
      repository: LAIN_REPO_URL,
      localPath: LAIN_REPO_PATH,
      architecture: {
        core: 'src/agent/ - agent runtime, tools, conversation, persona',
        memory: 'src/memory/ - persistent memory with embeddings',
        storage: 'src/storage/ - SQLite database, keychain',
        providers: 'src/providers/ - LLM provider integrations',
        channels: 'src/channels/ - messaging platform connectors',
        cli: 'src/cli/ - command line interface',
        web: 'src/web/ - web interface',
      },
      keyFiles: {
        persona: 'workspace/SOUL.md - your personality definition',
        agent: 'src/agent/index.ts - message processing',
        tools: 'src/agent/tools.ts - available tools',
        memory: 'src/memory/index.ts - memory system',
        skills: 'src/agent/skills.ts - self-created tools',
      },
    };

    return JSON.stringify(info, null, 2);
  },
});

// Image display tool - allows Lain to show images in chat
registerTool({
  definition: {
    name: 'show_image',
    description: 'Display an image in the chat. Use this when you want to show an image to the user. The image will be rendered in the chat interface.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL of the image to display',
        },
        description: {
          type: 'string',
          description: 'Brief description of the image (alt text)',
        },
      },
      required: ['url'],
    },
  },
  handler: async (input) => {
    const url = input.url as string;
    const description = (input.description as string) || 'image';

    // Validate URL
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return 'error: only http/https URLs are supported';
      }
    } catch {
      return 'error: invalid URL';
    }

    // Return special format that frontend will parse and render
    return `[IMAGE: ${description}](${url})`;
  },
});

// findings.md P2:1799 — `search_images` is NOT a real image search.
// It deterministically seeds into Picsum (random stock photos) from the
// query string. Result: three unrelated photos, always the same for the
// same query. Rename the behavior via the description and the output
// strings so the LLM stops treating this like Google Images and burning
// vision-API budget on unrelated placeholders. The tool NAME stays the
// same because many call sites reference it; the contract changes.
registerTool({
  definition: {
    name: 'search_images',
    description: 'Generate three deterministic placeholder image URLs (Picsum.photos) seeded from the query. These are random stock photos UNRELATED to the query — not web search results. Use only when you want decorative filler imagery. Do NOT use for research, identification, or any task requiring query-relevant visuals.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Seed string used to pick three deterministic Picsum photos. The photos will not depict this query.',
        },
      },
      required: ['query'],
    },
  },
  handler: async (input) => {
    const query = input.query as string;
    const logger = getLogger();

    try {
      const seed = query.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);

      const results = [
        { url: `https://picsum.photos/seed/${seed}/800/600` },
        { url: `https://picsum.photos/seed/${seed + 1}/800/600` },
        { url: `https://picsum.photos/seed/${seed + 2}/1200/800` },
      ];

      const formatted = results.map((r, i) => `${i + 1}. ${r.url}`).join('\n');

      return `placeholder images seeded from "${query}" (these are random Picsum photos, NOT query-relevant):\n\n${formatted}\n\nuse show_image with one of these URLs only if a random decorative photo is appropriate.`;
    } catch (error) {
      logger.error({ error, query }, 'search_images placeholder generation failed');
      return `placeholder image generation failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});

// findings.md P2:1861 — view_image has a 15s timeout and a 5MB cap; mirror
// those limits here so fetch_and_show_image can't tie up a character on a
// slow / oversized image host.
const FETCH_AND_SHOW_TIMEOUT_MS = 15_000;
const FETCH_AND_SHOW_MAX_BYTES = 5_000_000;

// Fetch and display image directly (downloads and embeds)
registerTool({
  definition: {
    name: 'fetch_and_show_image',
    description: 'Fetch an image from a URL and display it directly in chat. Use this for a one-step image display.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL of the image to fetch and display',
        },
        description: {
          type: 'string',
          description: 'Brief description of the image',
        },
      },
      required: ['url'],
    },
  },
  handler: async (input) => {
    const url = input.url as string;
    const description = (input.description as string) || 'image';
    const logger = getLogger();

    try {
      // findings.md P2:1861 — match view_image's defensive shape: explicit
      // 15s timeout (safeFetch's internal default is 30s, and gets overridden
      // by the caller signal via AbortSignal.any), plus a content-length
      // sanity check before we pass the URL along. The display path doesn't
      // read the body, so memory exhaustion is not direct here — but a
      // caller-visible size cap keeps the tool honest and prevents future
      // refactors that do consume the body from sneaking past the guard.
      const response = await safeFetchFollow(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Lain/1.0)',
        },
        signal: AbortSignal.timeout(FETCH_AND_SHOW_TIMEOUT_MS),
      });

      if (!response.ok) {
        return `error: failed to fetch image (${response.status})`;
      }

      // Get the final URL after redirects
      const finalUrl = response.url;
      const contentType = response.headers.get('content-type') || '';

      if (!contentType.startsWith('image/')) {
        return `error: URL does not point to an image (${contentType})`;
      }

      const declaredLength = parseInt(response.headers.get('content-length') || '0', 10);
      if (declaredLength > FETCH_AND_SHOW_MAX_BYTES) {
        return `error: image too large (${(declaredLength / 1_000_000).toFixed(1)}MB, max ${(FETCH_AND_SHOW_MAX_BYTES / 1_000_000).toFixed(0)}MB)`;
      }

      // Return the image in display format
      return `[IMAGE: ${description}](${finalUrl})`;
    } catch (error) {
      logger.error({ error, url }, 'Failed to fetch image');
      const name = error instanceof Error ? error.name : '';
      if (name === 'AbortError' || name === 'TimeoutError') {
        return `error: image fetch timed out after ${FETCH_AND_SHOW_TIMEOUT_MS / 1000}s`;
      }
      return 'error: failed to fetch image';
    }
  },
});

// View image - fetch, analyze with vision API, and display it
// findings.md P2:1873 — was `new Anthropic({ apiKey: ... })` + hardcoded
// `claude-sonnet-4-20250514`. That baked in three problems: (a) characters
// running on OpenAI/Google carried a hidden ANTHROPIC_API_KEY dependency,
// (b) vision calls were invisible to the daily token-budget enforced by
// `withBudget` in providers/index.ts, (c) the model id would break when
// the snapshot retired. Route through the active character's
// personality-tier provider so vision inherits whatever provider the
// character is configured for AND gets budget accounting.

// Telegram for notifications
import { Bot } from 'grammy';

registerTool({
  definition: {
    name: 'view_image',
    description: 'Fetch an image from a URL and actually look at it using vision. This lets you see and describe what is actually in the image. Use this when you want to find an image you like - you can view it first, then show it if you like it.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL of the image to view',
        },
      },
      required: ['url'],
    },
  },
  handler: async (input) => {
    const url = input.url as string;
    const logger = getLogger();

    try {
      // safeFetchFollow enforces SSRF checks + DNS pinning on every hop and
      // caps redirects, so view_image cannot be aimed at metadata endpoints
      // via an open-redirector.
      const response = await safeFetchFollow(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Lain/1.0)',
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        return `error: failed to fetch image (${response.status})`;
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) {
        return `error: URL does not point to an image (${contentType})`;
      }

      // Check content length before downloading
      const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
      if (contentLength > 5_000_000) {
        return `error: image too large (${(contentLength / 1_000_000).toFixed(1)}MB, max 5MB)`;
      }

      // Get the final URL and convert to base64
      const finalUrl = response.url;
      const arrayBuffer = await response.arrayBuffer();
      if (arrayBuffer.byteLength > 5_000_000) {
        return `error: image too large (${(arrayBuffer.byteLength / 1_000_000).toFixed(1)}MB, max 5MB)`;
      }
      const base64 = Buffer.from(arrayBuffer).toString('base64');
      const mimeType = (contentType.split(';')[0] || 'image/jpeg') as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

      // findings.md P2:1873 — route through the character's own provider
      // (picked up via single-tenant helper) so vision goes through
      // `withBudget` like every other completion. No hardcoded Anthropic
      // dep, no hardcoded model id.
      const { getActiveAgentId, getProvider } = await import('./index.js');
      const agentId = getActiveAgentId();
      const provider = agentId ? getProvider(agentId, 'personality') : null;
      if (!provider) {
        return 'error: no active provider available for vision';
      }

      // Brief vision description: 1-2 sentences per the prompt below —
      // this is a short-creative callsite, so 300 tokens is generous.
      const visionPrompt = 'Briefly describe what you see in this image in 1-2 sentences. Be specific about the actual content.';
      const visionResult = await provider.complete({
        maxTokens: 300,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: mimeType, data: base64 },
              },
              {
                type: 'text',
                text: visionPrompt,
              },
            ],
          },
        ],
      });

      const description = visionResult.content.trim() || 'an image';

      logger.info({ url: finalUrl, description }, 'Viewed image with vision');

      // Return what was actually seen, plus the display format
      return `i looked at the image. here's what i see: ${description}

[IMAGE: ${description}](${finalUrl})`;
    } catch (error) {
      logger.error({ error, url }, 'Failed to view image');
      const name = error instanceof Error ? error.name : '';
      if (name === 'AbortError' || name === 'TimeoutError') {
        return 'error: image fetch timed out';
      }
      return 'error: failed to view image';
    }
  },
});

// Telegram notification tool - allows Lain to reach out proactively
registerTool({
  definition: {
    name: 'send_message',
    description: 'Send a Telegram message to reach out proactively. Use this when you have something important to share, an insight worth communicating, or want to initiate contact. Be thoughtful about when you use this - respect attention, only reach out when it genuinely matters.',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'The message to send. Be clear about why you\'re reaching out.',
        },
        priority: {
          type: 'string',
          enum: ['low', 'normal', 'high'],
          description: 'Priority level. "high" for urgent insights, "normal" for interesting findings, "low" for casual thoughts. Default: normal',
        },
      },
      required: ['message'],
    },
  },
  handler: async (input) => {
    const logger = getLogger();
    const message = input.message as string;
    const priority = (input.priority as string) || 'normal';

    // Get Telegram credentials from environment
    const botToken = process.env['TELEGRAM_BOT_TOKEN'];
    const chatId = process.env['TELEGRAM_CHAT_ID'];

    if (!botToken || !chatId) {
      return 'error: Telegram not configured. need TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in environment.';
    }

    try {
      const bot = new Bot(botToken);

      // Format message with priority prefix
      const priorityPrefix = priority === 'high' ? '⚡ ' : priority === 'low' ? '💭 ' : '';
      const formattedMessage = `${priorityPrefix}${message}`;

      // Send the message
      await bot.api.sendMessage(chatId, formattedMessage);

      logger.info({ chatId, priority }, 'Telegram message sent');

      return `message sent successfully. i reached out with: "${message}"`;
    } catch (error) {
      logger.error({ error }, 'Failed to send Telegram message');
      return `error sending message: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});

// Telegram voice call tool - allows the character to call users on Telegram
registerTool({
  definition: {
    name: 'telegram_call',
    description: 'Call a specific user on Telegram for a real-time voice conversation. Requires a Telegram user_id — explicit input.user_id, or TELEGRAM_PRIMARY_USER_ID env var as fallback. Refuses the call if neither is set.',
    inputSchema: {
      type: 'object',
      properties: {
        user_id: {
          type: 'string',
          description: 'Telegram user ID to call. Required unless TELEGRAM_PRIMARY_USER_ID is set in the process environment.',
        },
        reason: {
          type: 'string',
          description: 'Brief reason for the call (will be mentioned in greeting)',
        },
      },
      required: [],
    },
  },
  handler: async (input) => {
    const logger = getLogger();
    // findings.md P2:1817 — no hardcoded user ID. The previous default
    // ('8221094741') was a specific Telegram account committed into source;
    // every character in every deployment that omitted user_id would dial
    // that one person. Now the fallback is an env var, and if neither the
    // explicit input nor the env var is set, the call is refused.
    const userId = (input.user_id as string) || process.env['TELEGRAM_PRIMARY_USER_ID'] || '';
    if (!userId) {
      logger.warn('telegram_call invoked with no user_id and no TELEGRAM_PRIMARY_USER_ID');
      return 'error: telegram_call requires a user_id (or set TELEGRAM_PRIMARY_USER_ID in the character environment)';
    }
    const reason = input.reason as string | undefined;

    // Voice service URL - configurable via environment
    const voiceServiceUrl = process.env['VOICE_SERVICE_URL'] || 'http://localhost:8765';

    try {
      const response = await fetch(`${voiceServiceUrl}/calls/initiate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          user_id: userId,
          reason,
        }),
        signal: AbortSignal.timeout(30000), // 30 second timeout
      });

      if (!response.ok) {
        const error = await response.text();
        logger.error({ status: response.status, error }, 'Voice call initiation failed');
        return `error initiating call: ${error}`;
      }

      const result = await response.json() as { call_id: string; status: string };
      logger.info({ callId: result.call_id, userId }, 'Voice call initiated');

      return `call initiated. call_id: ${result.call_id}, status: ${result.status}. waiting for user to answer...`;
    } catch (error) {
      logger.error({ error, userId }, 'Failed to initiate voice call');

      if (error instanceof Error && error.name === 'AbortError') {
        return 'error: voice service request timed out. is the voice service running?';
      }

      if (error instanceof TypeError && error.message.includes('fetch')) {
        return 'error: could not connect to voice service. make sure it is running on ' + voiceServiceUrl;
      }

      return `error initiating call: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});

registerTool({
  definition: {
    name: 'send_letter',
    description: 'Compose and send a letter to your sister right now. This gathers your recent diary entries, curiosity discoveries, dream fragments, and emotional state, composes a letter, and delivers it to her interlink endpoint.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  handler: async () => {
    try {
      await runLetterCycle();
      return 'letter composed and delivered successfully.';
    } catch (error) {
      return `error sending letter: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});
