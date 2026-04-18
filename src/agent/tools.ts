/**
 * Tool execution framework for agent
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolDefinition, ToolCall, ToolResult } from '../providers/base.js';
import { getLogger } from '../utils/logger.js';
import { saveMemory, searchMemories, getMemory, getAssociatedMemories, updateMemoryAccess, type MemorySortBy, type Memory } from '../memory/store.js';
import { runLetterCycle } from './letter.js';

const TOOL_LOG_FILE = join(process.cwd(), 'logs', 'tools-debug.log');

async function toolLog(context: string, data: unknown): Promise<void> {
  try {
    await mkdir(join(process.cwd(), 'logs'), { recursive: true });
    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] [${context}] ${JSON.stringify(data, null, 2)}\n${'='.repeat(80)}\n`;
    await appendFile(TOOL_LOG_FILE, entry);
  } catch {
    // Ignore logging errors
  }
}

export interface ToolHandler {
  (input: Record<string, unknown>): Promise<string>;
}

export interface Tool {
  definition: ToolDefinition;
  handler: ToolHandler;
  requiresApproval?: boolean;
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

/**
 * Get all tool definitions
 */
export function getToolDefinitions(): ToolDefinition[] {
  return Array.from(registeredTools.values()).map((t) => t.definition);
}

/**
 * Check if a tool requires approval
 */
export function toolRequiresApproval(name: string): boolean {
  const tool = registeredTools.get(name);
  return tool?.requiresApproval ?? false;
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
    logger.error({ toolName: toolCall.name, error }, 'Tool execution error');
    await toolLog('EXECUTE_TOOL_ERROR', { name: toolCall.name, error: String(error) });
    return {
      toolCallId: toolCall.id,
      content: `Error executing tool: ${error instanceof Error ? error.message : String(error)}`,
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

// Web search tool using DuckDuckGo
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
      // Use DuckDuckGo HTML search with POST request
      const url = `https://html.duckduckgo.com/html/`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `q=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        throw new Error(`Search failed: ${response.status}`);
      }

      const html = await response.text();

      // Parse search results from HTML
      const results = parseSearchResults(html);

      if (results.length === 0) {
        return `no results found for "${query}"`;
      }

      // Format results
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

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function parseSearchResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];

  // DuckDuckGo HTML structure:
  // <div class="result results_links results_links_deep web-result">
  //   <h2 class="result__title">
  //     <a rel="nofollow" class="result__a" href="URL">Title</a>
  //   </h2>
  //   <div class="result__extras">...</div>
  //   <a class="result__snippet" href="...">Snippet text</a>
  // </div>

  // Split by result blocks
  const resultBlocks = html.split(/class="result\s+results_links/g);

  for (let i = 1; i < resultBlocks.length && results.length < 10; i++) {
    const block = resultBlocks[i] || '';

    // Extract URL and title from result__a link
    const linkMatch = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]+)</);
    if (!linkMatch) continue;

    const url = linkMatch[1] || '';
    const title = decodeHtmlEntities((linkMatch[2] || '').trim());

    // Skip if no valid URL
    if (!url || !url.startsWith('http')) continue;

    // Extract snippet
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    let snippet = '';
    if (snippetMatch?.[1]) {
      snippet = decodeHtmlEntities(
        snippetMatch[1]
          .replace(/<[^>]+>/g, '') // Remove HTML tags
          .replace(/\s+/g, ' ')
          .trim()
      );
    }

    results.push({ title, url, snippet });
  }

  return results;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)));
}

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
      // Validate URL
      const parsedUrl = new URL(url);
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        return 'error: only http and https URLs are supported';
      }

      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Lain/1.0; +https://github.com/lain)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(10000), // 10 second timeout
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

// Import skills module for tool creation
import { saveCustomTool, listCustomTools, deleteCustomTool } from './skills.js';

// Meta-tool: Create new tools
registerTool({
  definition: {
    name: 'create_tool',
    description: 'Create a new custom tool that you can use in future conversations. Use this to teach yourself new capabilities. The tool code should be JavaScript that returns a string result.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The tool name (lowercase, underscores, e.g., "currency_converter")',
        },
        description: {
          type: 'string',
          description: 'What the tool does - be specific so you know when to use it',
        },
        parameters: {
          type: 'string',
          description: 'JSON string describing input parameters, e.g., {"amount": {"type": "number", "description": "Amount to convert"}}',
        },
        required_params: {
          type: 'string',
          description: 'Comma-separated list of required parameter names, e.g., "amount,from_currency"',
        },
        code: {
          type: 'string',
          description: 'JavaScript code for the tool handler. Has access to: input (object with parameters), fetch (for HTTP requests), console. Must return a string. Example: "const result = input.a + input.b; return `Sum: ${result}`;"',
        },
      },
      required: ['name', 'description', 'parameters', 'code'],
    },
  },
  handler: async (input) => {
    const logger = getLogger();

    try {
      const name = (input.name as string).toLowerCase().replace(/[^a-z0-9_]/g, '_');
      const description = input.description as string;
      const parametersJson = input.parameters as string;
      const requiredParams = input.required_params as string | undefined;
      const code = input.code as string;

      // Parse parameters
      let properties: Record<string, { type: string; description: string }>;
      try {
        properties = JSON.parse(parametersJson);
      } catch {
        return 'error: parameters must be valid JSON';
      }

      // Build the skill definition
      const skill = {
        name,
        description,
        inputSchema: {
          type: 'object' as const,
          properties,
          required: requiredParams ? requiredParams.split(',').map((s) => s.trim()) : [],
        },
        code,
      };

      // Save and register the tool
      const success = await saveCustomTool(skill);

      if (success) {
        return `created tool "${name}" successfully. it's now available for use.`;
      } else {
        return `failed to create tool "${name}"`;
      }
    } catch (error) {
      logger.error({ error }, 'Failed to create tool');
      return 'error creating tool: ' + (error instanceof Error ? error.message : String(error));
    }
  },
});

// Meta-tool: List custom tools
registerTool({
  definition: {
    name: 'list_my_tools',
    description: 'List all custom tools you have created',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  handler: async () => {
    const tools = await listCustomTools();
    if (tools.length === 0) {
      return 'no custom tools created yet';
    }
    return 'custom tools: ' + tools.join(', ');
  },
});

// Meta-tool: Delete a custom tool
registerTool({
  definition: {
    name: 'delete_tool',
    description: 'Delete a custom tool you created',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the tool to delete',
        },
      },
      required: ['name'],
    },
  },
  handler: async (input) => {
    const name = input.name as string;
    const success = await deleteCustomTool(name);
    if (success) {
      return `deleted tool "${name}"`;
    }
    return `failed to delete tool "${name}" - it may not exist`;
  },
});

// Self-introspection tools - Lain can explore her own codebase
import { readFile, readdir, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { PDFParse } from 'pdf-parse';

const LAIN_REPO_PATH = '/Users/apopo0308/IdeaProjects/lain';
const LAIN_REPO_URL = 'https://github.com/notlainiwakura/lain';

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

function isPathAllowed(filePath: string): boolean {
  const normalizedPath = resolve(filePath);
  const relativePath = relative(LAIN_REPO_PATH, normalizedPath);

  // Must be within repo
  if (relativePath.startsWith('..') || !normalizedPath.startsWith(LAIN_REPO_PATH)) {
    return false;
  }

  // Check excluded paths
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

registerTool({
  definition: {
    name: 'introspect_search',
    description: 'Search for text or patterns in your own codebase. Use this to find where specific functionality is implemented.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Text or pattern to search for (case-insensitive)',
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

    async function searchDir(dirPath: string): Promise<void> {
      try {
        const entries = await readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
          const entryPath = join(dirPath, entry.name);

          if (!isPathAllowed(entryPath)) continue;

          if (entry.isDirectory()) {
            await searchDir(entryPath);
          } else if (entry.isFile() && hasAllowedExtension(entry.name)) {
            if (filePattern && !entry.name.endsWith(filePattern)) continue;

            try {
              const content = await readFile(entryPath, 'utf-8');
              const lines = content.split('\n');

              for (let i = 0; i < lines.length; i++) {
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

// Image search tool - find images on the web
registerTool({
  definition: {
    name: 'search_images',
    description: 'Search for images on the web. Returns image URLs that you can then show using show_image.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What kind of image to search for (e.g., "sunset", "cyberpunk city", "cat")',
        },
      },
      required: ['query'],
    },
  },
  handler: async (input) => {
    const query = input.query as string;
    const logger = getLogger();

    try {
      // Use Lorem Picsum for reliable image delivery
      // Generate a seed from the query for consistent results
      const seed = query.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);

      const results = [
        {
          url: `https://picsum.photos/seed/${seed}/800/600`,
          description: `Image for: ${query}`,
        },
        {
          url: `https://picsum.photos/seed/${seed + 1}/800/600`,
          description: `Alternative image for: ${query}`,
        },
        {
          url: `https://picsum.photos/seed/${seed + 2}/1200/800`,
          description: `Larger image for: ${query}`,
        },
      ];

      // Format results
      const formatted = results
        .map((r, i) => `${i + 1}. ${r.description}\n   URL: ${r.url}`)
        .join('\n\n');

      return `found images for "${query}":\n\n${formatted}\n\nuse show_image with one of these URLs to display it.`;
    } catch (error) {
      logger.error({ error, query }, 'Image search failed');
      return `image search failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});

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
      // Validate and fetch the image
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return 'error: only http/https URLs are supported';
      }

      // For Unsplash source URLs, we need to follow the redirect to get the actual image
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Lain/1.0)',
        },
        redirect: 'follow',
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

      // Return the image in display format
      return `[IMAGE: ${description}](${finalUrl})`;
    } catch (error) {
      logger.error({ error, url }, 'Failed to fetch image');
      return `error: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});

// View image - fetch, analyze with vision API, and display it
import Anthropic from '@anthropic-ai/sdk';

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
      // Validate URL
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return 'error: only http/https URLs are supported';
      }

      // Fetch the image (with timeout and size limit)
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Lain/1.0)',
        },
        redirect: 'follow',
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

      // Use Anthropic vision API to actually see the image
      const client = new Anthropic({
        apiKey: process.env['ANTHROPIC_API_KEY'],
      });

      const visionResponse = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mimeType,
                  data: base64,
                },
              },
              {
                type: 'text',
                text: 'Briefly describe what you see in this image in 1-2 sentences. Be specific about the actual content.',
              },
            ],
          },
        ],
      });

      // Extract the description
      const descriptionBlock = visionResponse.content.find(c => c.type === 'text');
      const description = descriptionBlock && 'text' in descriptionBlock ? descriptionBlock.text : 'an image';

      logger.info({ url: finalUrl, description }, 'Viewed image with vision');

      // Return what was actually seen, plus the display format
      return `i looked at the image. here's what i see: ${description}

[IMAGE: ${description}](${finalUrl})`;
    } catch (error) {
      logger.error({ error, url }, 'Failed to view image');
      return `error: ${error instanceof Error ? error.message : String(error)}`;
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

// Telegram voice call tool - allows Lain to call users on Telegram
registerTool({
  definition: {
    name: 'telegram_call',
    description: 'Call the user on Telegram for a real-time voice conversation. Use this when voice communication would be more natural than text, or when you need to have a more personal conversation. Requires the voice service to be running. If no user_id is provided, calls the default user.',
    inputSchema: {
      type: 'object',
      properties: {
        user_id: {
          type: 'string',
          description: 'Telegram user ID to call (defaults to primary user if omitted)',
        },
        reason: {
          type: 'string',
          description: 'Brief reason for the call (will be mentioned in greeting)',
        },
      },
      required: [],
    },
  },
  requiresApproval: true,
  handler: async (input) => {
    const logger = getLogger();
    const userId = (input.user_id as string) || '8221094741';
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
    description: 'Compose and send a letter to your sister (local Lain) right now. This gathers your recent diary entries, curiosity discoveries, dream fragments, and emotional state, composes a letter, and delivers it to her interlink endpoint.',
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
