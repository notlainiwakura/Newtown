/**
 * Dr. Claude's tool set — diagnostics, file operations, shell commands
 */

import { readFile } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { query, getMeta } from '../storage/database.js';
import { countMemories, countMessages } from '../memory/store.js';
import { getBasePath } from '../config/paths.js';
import { getHealthCheckTargets } from '../config/characters.js';
import { registerTool } from './tools.js';
import type { ToolDefinition, ToolCall, ToolResult } from '../providers/base.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = resolve(join(__dirname, '..', '..'));

// Security: blocked paths.
//
// findings.md P2:1959 — the old list had 4 entries and let Dr. Claude
// read SSH keys, deploy-env secrets, character-integrity files, and the
// package manifest. Only `read_file` is wired through isPathSafe today,
// but the belt-and-suspenders reasoning applies to any future write/edit
// tool: if it ever lands, it MUST route through isPathSafe against this
// same list so the blocklist cannot be silently sidestepped.
//
// Matching is substring-on-relative-path (see isPathSafe). Keep entries
// as path fragments, not globs.
const BLOCKED_PATHS = [
  // Secrets & keys
  '.env',
  'credentials',
  '.ssh/',
  '.pem',
  '.key',
  'id_rsa',
  'id_ed25519',
  // Infra / build artifacts
  'node_modules',
  '.git/',
  // Deploy-layer: per-service env files and unit files
  'deploy/env/',
  'deploy/systemd/',
  // Introspection & hook state
  '.private_journal/',
  '.claude/',
  // Character-integrity files — corrupting these silently changes identity
  'SOUL.md',
  'AGENTS.md',
  'IDENTITY.md',
  'WIRED_SOUL.md',
  // Package & lockfile — supply-chain risk
  'package.json',
  'package-lock.json',
];
const ALLOWED_EXTENSIONS = [
  '.ts', '.js', '.json', '.md', '.txt', '.yaml', '.yml',
  '.html', '.css', '.sql', '.sh', '.toml', '.json5',
];

/**
 * findings.md P2:1831 — resolve symlinks before enforcing the prefix check.
 *
 * Textual `path.resolve` + `startsWith` let a symlink inside the project
 * smuggle reads of /etc/passwd, /root/.ssh/authorized_keys, or any file
 * the process can open. `realpathSync` resolves existing symlinks to their
 * true target. Non-existent paths have no symlink to follow, so we fall
 * back to the textual resolved form and let the extension / readFile
 * checks downstream produce a specific error.
 */
function isPathSafe(filePath: string): boolean {
  const textual = resolve(filePath);
  let effective: string;
  try {
    effective = realpathSync(textual);
  } catch {
    effective = textual;
  }

  const rel = relative(PROJECT_ROOT, effective);

  if (rel.startsWith('..') || !effective.startsWith(PROJECT_ROOT) || !textual.startsWith(PROJECT_ROOT)) {
    return false;
  }

  for (const blocked of BLOCKED_PATHS) {
    if (rel.includes(blocked)) return false;
  }

  return true;
}

function isExtensionAllowed(filePath: string): boolean {
  return ALLOWED_EXTENSIONS.some((ext) => filePath.endsWith(ext));
}

export interface DoctorTool {
  definition: ToolDefinition;
  handler: (input: Record<string, unknown>) => Promise<string>;
}

// ============================================================
// Tool definitions
// ============================================================

const checkServiceHealth: DoctorTool = {
  definition: {
    name: 'check_service_health',
    description:
      'Check if all commune services are running and healthy. Checks Wired Lain (:3000), Dr. Claude (:3002), PKD (:3003), McKenna (:3004), John (:3005), and the commune map dashboard.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  handler: async () => {
    const results: string[] = ['=== COMMUNE SERVICE HEALTH ===', ''];

    // All character services
    const services = getHealthCheckTargets().map(c => ({
      name: c.name,
      port: c.port,
      identityPath: '/api/meta/identity',
    }));

    for (const svc of services) {
      try {
        const res = await fetch(`http://localhost:${svc.port}${svc.identityPath}`, {
          signal: AbortSignal.timeout(3000),
        });
        if (svc.identityPath === '/api/meta/identity' && res.ok) {
          const data = await res.json() as { id: string; name: string };
          results.push(`${svc.name} (:${svc.port}): UP — id=${data.id}, name=${data.name}`);
        } else {
          results.push(`${svc.name} (:${svc.port}): UP (${res.status})`);
        }
      } catch {
        results.push(`${svc.name} (:${svc.port}): DOWN`);
      }
    }

    // Check commune map accessibility
    results.push('');
    try {
      const res = await fetch('http://localhost:3000/commune-map.html', {
        signal: AbortSignal.timeout(3000),
      });
      results.push(`Commune Map: ${res.ok ? 'ACCESSIBLE' : `ERROR (${res.status})`}`);
    } catch {
      results.push('Commune Map: UNREACHABLE');
    }

    // Check SSE event stream availability
    try {
      const res = await fetch('http://localhost:3000/api/events', {
        signal: AbortSignal.timeout(3000),
      });
      results.push(`Event stream (SSE): ${res.status === 200 || res.status === 401 ? 'AVAILABLE' : `ERROR (${res.status})`}`);
    } catch {
      results.push('Event stream (SSE): UNREACHABLE');
    }

    // Check running node processes
    results.push('');
    const psOutput = await pgrepNodeProcesses();
    results.push(`Node processes:\n${psOutput}`);

    return results.join('\n');
  },
};

const getTelemetry: DoctorTool = {
  definition: {
    name: 'get_telemetry',
    description:
      'Get telemetry data for this character\'s instance: memory counts, session activity by type (commune, diary, dream, curiosity, chat, peer, etc.), emotional weights, loop health, and recent diary entries. This reflects the local database — each character process sees its own data.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  handler: async () => {
    const sinceMs = Date.now() - 24 * 60 * 60 * 1000;

    const totalMemories = countMemories();
    const totalMessages = countMessages();

    // Memory types (last 24h)
    const memoryTypes = query<{ memory_type: string; count: number }>(
      `SELECT memory_type, COUNT(*) as count FROM memories
       WHERE created_at > ? GROUP BY memory_type`,
      [sinceMs]
    );

    // Avg emotional weight (last 24h)
    const avgEmotional = query<{ avg_ew: number }>(
      `SELECT AVG(emotional_weight) as avg_ew FROM memories WHERE created_at > ?`,
      [sinceMs]
    );

    // High emotional weight memories (last 24h)
    const emotionalMemories = query<{
      content: string;
      emotional_weight: number;
      memory_type: string;
    }>(
      `SELECT content, emotional_weight, memory_type FROM memories
       WHERE created_at > ? AND emotional_weight > 0.3
       ORDER BY emotional_weight DESC LIMIT 10`,
      [sinceMs]
    );

    // Session activity by prefix (last 24h) — shows commune, diary, dream, etc.
    const sessionCounts = query<{ session_key: string; count: number }>(
      `SELECT session_key, COUNT(*) as count FROM messages
       WHERE timestamp > ? GROUP BY session_key`,
      [sinceMs]
    );

    // Activity by session prefix (aggregate)
    const prefixCounts: Record<string, number> = {};
    for (const row of sessionCounts) {
      const prefix = row.session_key.split(':')[0] ?? 'unknown';
      prefixCounts[prefix] = (prefixCounts[prefix] ?? 0) + row.count;
    }

    // Loop health from meta
    const loops: Record<string, string> = {
      'Dream cycles': getMeta('dream:cycle_count') ?? '0',
      'Curiosity last run': formatMetaTimestamp(getMeta('curiosity:last_cycle_at')),
      'Commune last run': formatMetaTimestamp(getMeta('commune:last_cycle_at')),
      'Letter last sent': formatMetaTimestamp(getMeta('letter:last_sent_at')),
      'Letter blocked': getMeta('letter:blocked') ?? 'false',
      'Bibliomancy last run': formatMetaTimestamp(getMeta('bibliomancy:last_cycle_at')),
      'Diary last entry': formatMetaTimestamp(getMeta('diary:last_entry_at')),
      'Self-concept last updated': formatMetaTimestamp(getMeta('self-concept:last_synthesis_at')),
      'Narrative weekly': formatMetaTimestamp(getMeta('narrative:weekly:last_synthesis_at')),
      'Narrative monthly': formatMetaTimestamp(getMeta('narrative:monthly:last_synthesis_at')),
    };

    // Previous analysis
    const previousAnalysis = getMeta('doctor:previous_analysis');

    // Recent diary entries
    let recentDiary = '(no diary entries)';
    try {
      const journalPath = join(getBasePath(), '.private_journal', 'thoughts.json');
      if (existsSync(journalPath)) {
        const raw = readFileSync(journalPath, 'utf-8');
        const data = JSON.parse(raw) as { entries?: Array<{ timestamp: string; content: string }> };
        const entries = (data.entries ?? []).filter(
          (e) => new Date(e.timestamp).getTime() > sinceMs
        );
        if (entries.length > 0) {
          recentDiary = entries
            .slice(-3)
            .map((e) => `[${e.timestamp}] ${e.content.slice(0, 300)}`)
            .join('\n\n');
        }
      }
    } catch {
      // ignore
    }

    // Build report
    const lines: string[] = [
      '=== TELEMETRY REPORT ===',
      '',
      `Total memories: ${totalMemories}`,
      `Total messages: ${totalMessages}`,
      '',
      '--- New Memories (last 24h) ---',
      ...(memoryTypes.length > 0
        ? memoryTypes.map((r) => `  ${r.memory_type}: ${r.count}`)
        : ['  (none)']),
      '',
      `Avg emotional weight (24h): ${(avgEmotional[0]?.avg_ew ?? 0).toFixed(3)}`,
      '',
      '--- High Emotional Weight Memories (24h) ---',
      ...(emotionalMemories.length > 0
        ? emotionalMemories.map(
            (m) =>
              `  [ew=${m.emotional_weight.toFixed(2)}, ${m.memory_type}] ${m.content.slice(0, 120)}`
          )
        : ['  (none)']),
      '',
      '--- Activity by Type (24h) ---',
      ...(Object.keys(prefixCounts).length > 0
        ? Object.entries(prefixCounts)
            .sort((a, b) => b[1] - a[1])
            .map(([prefix, count]) => `  ${prefix}: ${count} messages`)
        : ['  (no activity)']),
      '',
      '--- Session Detail (24h) ---',
      ...(sessionCounts.length > 0
        ? sessionCounts.map((r) => `  ${r.session_key}: ${r.count} messages`)
        : ['  (no activity)']),
      '',
      '--- Loop Health ---',
      ...Object.entries(loops).map(([k, v]) => `  ${k}: ${v}`),
      '',
      '--- Recent Diary ---',
      recentDiary,
    ];

    if (previousAnalysis) {
      lines.push('', '--- Previous Dr. Claude Analysis ---', previousAnalysis);
    }

    return lines.join('\n');
  },
};

const readFileTool: DoctorTool = {
  definition: {
    name: 'read_file',
    description:
      'Read a file from the Lain project. Paths are relative to the project root.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to project root (e.g., "src/agent/index.ts")',
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
    const relPath = input.path as string;
    const fullPath = join(PROJECT_ROOT, relPath);
    const startLine = (input.start_line as number) || 1;
    const endLine = input.end_line as number | undefined;

    if (!isPathSafe(fullPath)) {
      return 'Error: Access denied — path is restricted.';
    }

    if (!isExtensionAllowed(fullPath)) {
      return `Error: File type not allowed. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`;
    }

    try {
      const content = await readFile(fullPath, 'utf-8');
      const lines = content.split('\n');
      const start = Math.max(1, startLine) - 1;
      const end = endLine ? Math.min(endLine, lines.length) : lines.length;
      const selected = lines.slice(start, end);

      const numbered = selected.map((line, i) => `${start + i + 1}: ${line}`).join('\n');

      if (numbered.length > 12000) {
        return (
          numbered.substring(0, 12000) +
          '\n\n[Truncated — use start_line/end_line for specific sections]'
        );
      }

      return `${relPath} (lines ${start + 1}-${end}):\n\n${numbered}`;
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};

// ============================================================
// Helpers
// ============================================================

function pgrepNodeProcesses(): Promise<string> {
  return new Promise((resolvePromise) => {
    execFile(
      'pgrep',
      ['-fa', 'node dist/index.js'],
      { timeout: 5000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        // pgrep exits 1 when no matches — treat as empty result, not error.
        const out = (stdout || '').trim();
        if (!out) {
          resolvePromise('(no node processes found)');
          return;
        }
        if (error && !('code' in error && (error as { code: number }).code === 1)) {
          resolvePromise(`pgrep failed: ${error.message}`);
          return;
        }
        resolvePromise(out);
      }
    );
  });
}

function formatMetaTimestamp(value: string | null): string {
  if (!value) return 'never';
  try {
    return new Date(parseInt(value, 10)).toISOString();
  } catch {
    return value;
  }
}

// ============================================================
// Exported registry
// ============================================================

const getHealthStatus: DoctorTool = {
  definition: {
    name: 'get_health_status',
    description:
      'Get the latest automated health check results. Dr. Claude runs health checks every 10 minutes — this returns the most recent result including which services are up/down, response times, and any auto-fix attempts.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  handler: async () => {
    const latest = getMeta('doctor:health:latest');
    const lastRun = getMeta('doctor:health:last_run_at');

    if (!latest) {
      return 'No health check results yet. The first check runs ~2 minutes after startup.';
    }

    const result = JSON.parse(latest) as {
      timestamp: number;
      services: Array<{
        name: string;
        port: number;
        status: string;
        responseMs?: number;
        identity?: string;
      }>;
      allHealthy: boolean;
      fixAttempted: boolean;
      fixOutput?: string;
    };

    const lines: string[] = [
      '=== HEALTH CHECK STATUS ===',
      '',
      `Last check: ${lastRun ? new Date(parseInt(lastRun, 10)).toISOString() : 'unknown'}`,
      `Overall: ${result.allHealthy ? 'ALL HEALTHY' : 'ISSUES DETECTED'}`,
      '',
      '--- Services ---',
    ];

    for (const svc of result.services) {
      const icon = svc.status === 'up' ? 'UP' : 'DOWN';
      const ms = svc.responseMs != null ? ` (${svc.responseMs}ms)` : '';
      const id = svc.identity ? ` [${svc.identity}]` : '';

      // Check consecutive failure count
      const failCount = getMeta(`doctor:health:failures:${svc.port}`) ?? '0';
      const failSuffix = parseInt(failCount, 10) > 0 ? ` — ${failCount} consecutive failures` : '';

      lines.push(`  ${svc.name} (:${svc.port}): ${icon}${ms}${id}${failSuffix}`);
    }

    if (result.fixAttempted) {
      lines.push('', '--- Auto-Fix Output ---', result.fixOutput ?? '(no output)');
    }

    return lines.join('\n');
  },
};

export const doctorTools: DoctorTool[] = [
  checkServiceHealth,
  getHealthStatus,
  getTelemetry,
  readFileTool,
];

export function getDoctorToolDefinitions(): ToolDefinition[] {
  return doctorTools.map((t) => t.definition);
}

export async function executeDoctorTool(toolCall: ToolCall): Promise<ToolResult> {
  const tool = doctorTools.find((t) => t.definition.name === toolCall.name);

  if (!tool) {
    return {
      toolCallId: toolCall.id,
      content: `Error: Unknown tool "${toolCall.name}"`,
      isError: true,
    };
  }

  try {
    const result = await tool.handler(toolCall.input);
    return {
      toolCallId: toolCall.id,
      content: result,
    };
  } catch (error) {
    return {
      toolCallId: toolCall.id,
      content: `Error: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}

// --- Report retrieval tool ---

const getReportsTool: DoctorTool = {
  definition: {
    name: 'get_reports',
    description: 'Retrieve saved telemetry reports. Returns the latest report by default, or lists available reports so the user can pick one. Use this when someone asks about reports, telemetry, or how Lain is doing.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['latest', 'list', 'get'],
          description: '"latest" = get the most recent report, "list" = show available report dates, "get" = get a specific report by timestamp',
        },
        timestamp: {
          type: 'string',
          description: 'The timestamp of a specific report to retrieve (from the list action)',
        },
      },
      required: ['action'],
    },
  },
  handler: async (input: Record<string, unknown>) => {
    const action = input.action as string;

    if (action === 'latest') {
      const latest = getMeta('doctor:report:latest');
      if (!latest) return 'No reports available yet. The first telemetry cycle has not run.';
      const report = JSON.parse(latest) as Record<string, unknown>;
      return formatReport(report);
    }

    if (action === 'list') {
      const indexRaw = getMeta('doctor:report:index');
      if (!indexRaw) return 'No reports available yet.';
      const index = JSON.parse(indexRaw) as string[];
      if (index.length === 0) return 'No reports available yet.';

      const lines = index.map((ts) => {
        const date = new Date(parseInt(ts, 10)).toISOString().replace('T', ' ').slice(0, 19);
        return `- ${date} UTC (timestamp: ${ts})`;
      });
      return `Available reports (${index.length}):\n${lines.join('\n')}\n\nUse action "get" with the timestamp to retrieve a specific report.`;
    }

    if (action === 'get') {
      const ts = input.timestamp as string;
      if (!ts) return 'Error: timestamp is required for "get" action.';
      const reportRaw = getMeta(`doctor:report:${ts}`);
      if (!reportRaw) return `No report found for timestamp ${ts}.`;
      const report = JSON.parse(reportRaw) as Record<string, unknown>;
      return formatReport(report);
    }

    return 'Unknown action. Use "latest", "list", or "get".';
  },
};

function formatReport(report: Record<string, unknown>): string {
  const date = (report.date as string) || 'unknown';
  const summary = (report.clinicalSummary as string) || '(no summary)';
  const concerns = (report.concerns as string[]) || [];
  const letterRec = (report.letterRecommendation as string) || 'unknown';
  const blockReason = report.blockReason as string | null;
  const metrics = (report.metrics as Record<string, number>) || {};
  const emotional = (report.emotionalLandscape as string) || '(none)';
  const therapy = report.therapyNotes as string | null;

  let text = `=== Telemetry Report — ${date} ===\n\n`;
  text += `Clinical Summary:\n${summary}\n\n`;
  text += `Concerns: ${concerns.length > 0 ? concerns.join('; ') : 'None'}\n\n`;
  text += `Letter Recommendation: ${letterRec.toUpperCase()}${blockReason ? ` — ${blockReason}` : ''}\n\n`;
  text += `Metrics:\n  Sessions: ${metrics.sessions ?? '?'}\n  New memories: ${metrics.memories ?? '?'}\n  Dream cycles: ${metrics.dreams ?? '?'}\n  Curiosity runs: ${metrics.curiosityRuns ?? '?'}\n\n`;
  text += `Emotional Landscape:\n${emotional}\n`;
  if (therapy) {
    text += `\nTherapy Notes:\n${therapy}\n`;
  }
  return text;
}

doctorTools.push(getReportsTool);

export async function executeDoctorTools(toolCalls: ToolCall[]): Promise<ToolResult[]> {
  return Promise.all(toolCalls.map(executeDoctorTool));
}

/**
 * Register all doctor tools into the standard agent tool registry.
 * Called by character-server when starting Dr. Claude as a full inhabitant.
 */
export function registerDoctorTools(): void {
  for (const tool of doctorTools) {
    registerTool({
      definition: tool.definition,
      handler: tool.handler,
    });
  }
}
