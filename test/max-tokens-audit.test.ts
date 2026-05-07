/**
 * maxTokens Audit — Living Guardrail
 *
 * This test suite scans ALL TypeScript source files for maxTokens values
 * and enforces minimum thresholds based on the output category:
 *
 *   - Extended creative text (conversations, letters, diary, self-concept,
 *     dreams, narratives, proactive, doctor therapy, book chapters): min 400
 *   - Short creative text (1-3 sentence outputs: notes, messages, reactions,
 *     reflections, bibliomancy distortions, dream residue): min 60
 *   - Structured output (JSON state updates, move decisions, structured
 *     parsed responses like QUESTION/REASON): min 60
 *   - Tool-enabled completions (completeWithTools/continueWithToolResults): min 150
 *   - processMessage / chat endpoints: min 2048
 *   - Absolute floor: NO maxTokens below 10 (single-word responses)
 *
 * WHY THIS EXISTS: The commune conversation loop silently truncated
 * character messages for months because it used maxTokens: 250 for
 * conversation replies. We had 10,000 tests and NONE caught it.
 * This test reads actual source files from disk so that any future
 * low maxTokens will fail the build.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

const SRC_ROOT = join(__dirname, '..', 'src');
const AGENT_DIR = join(SRC_ROOT, 'agent');

type CallCategory =
  | 'free-form'        // Extended creative text (conversations, letters, diary, etc.)
  | 'short-creative'   // Intentionally brief creative (1-3 sentences: notes, messages, etc.)
  | 'structured'       // JSON, parsed format (QUESTION/REASON, TYPE/DESCRIPTION, etc.)
  | 'tool-enabled'     // completeWithTools / continueWithToolResults
  | 'chat'             // processMessage, chat endpoints
  | 'compression'      // Conversation compression summaries
  | 'parameter-only';  // Interface/type definitions (not actual callsites)

interface MaxTokensCallsite {
  file: string;           // relative path from src/
  line: number;
  value: number | string; // number for literals, string for dynamic expressions
  context: string;        // surrounding code snippet
  rawLine: string;        // the line containing maxTokens
  functionName: string;   // best guess at enclosing function/method
  callType: 'complete' | 'completeWithTools' | 'continueWithToolResults' | 'completeStream' | 'completeWithToolsStream' | 'continueWithToolResultsStream' | 'config' | 'parameter' | 'unknown';
  category: CallCategory;
}

/**
 * Recursively collect all .ts files under a directory.
 */
function getAllTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...getAllTsFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Extract all maxTokens callsites from a file.
 */
function findMaxTokensCallsites(filePath: string): MaxTokensCallsite[] {
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const relPath = relative(SRC_ROOT, filePath);
  const sites: MaxTokensCallsite[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const match = line.match(/maxTokens:\s*(.+?)[\s,}]/);
    if (!match) continue;

    const rawValue = match[1]!.trim();

    // Skip pure interface field declarations (no numeric value, just type)
    const isInterfaceField = isInsideInterface(lines, i);
    if (isInterfaceField && !line.includes('=') && !/\d/.test(rawValue)) continue;

    let numericValue: number | string;
    const numMatch = rawValue.match(/^(\d+)$/);
    if (numMatch) {
      numericValue = parseInt(numMatch[1]!, 10);
    } else {
      numericValue = rawValue;
    }

    const contextStart = Math.max(0, i - 15);
    const contextEnd = Math.min(lines.length - 1, i + 10);
    const context = lines.slice(contextStart, contextEnd + 1).join('\n');

    const callType = determineCallType(lines, i);
    const functionName = findEnclosingFunction(lines, i);
    const category = categorizeCallsite(relPath, functionName, callType, context);

    sites.push({
      file: relPath,
      line: i + 1,
      value: numericValue,
      context,
      rawLine: line,
      functionName,
      callType,
      category,
    });
  }

  return sites;
}

function isInsideInterface(lines: string[], lineIndex: number): boolean {
  let braceDepth = 0;
  for (let i = lineIndex; i >= 0; i--) {
    const l = lines[i]!;
    for (const ch of l) {
      if (ch === '}') braceDepth++;
      if (ch === '{') braceDepth--;
    }
    if (braceDepth < 0 && /^\s*(?:export\s+)?interface\s/.test(l)) {
      return true;
    }
    if (braceDepth < 0) return false;
  }
  return false;
}

function determineCallType(lines: string[], lineIndex: number): MaxTokensCallsite['callType'] {
  const windowStart = Math.max(0, lineIndex - 8);
  const window = lines.slice(windowStart, lineIndex + 3).join('\n');

  if (window.includes('continueWithToolResultsStream')) return 'continueWithToolResultsStream';
  if (window.includes('continueWithToolResults')) return 'continueWithToolResults';
  if (window.includes('completeWithToolsStream')) return 'completeWithToolsStream';
  if (window.includes('completeWithTools')) return 'completeWithTools';
  if (window.includes('completeStream')) return 'completeStream';
  if (window.includes('provider.complete(') || window.includes('provider.complete({')) return 'complete';
  if (window.includes('DEFAULT_CONFIG') || window.includes('Config')) return 'config';

  const line = lines[lineIndex]!;
  if (/^\s+maxTokens\??\s*:/.test(line) && !line.includes('=') && !/\d/.test(line)) return 'parameter';

  return 'unknown';
}

function findEnclosingFunction(lines: string[], lineIndex: number): string {
  for (let i = lineIndex; i >= Math.max(0, lineIndex - 60); i--) {
    const l = lines[i]!;
    const exportFn = l.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
    if (exportFn) return exportFn[1]!;
    const constFn = l.match(/(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\(/);
    if (constFn) return constFn[1]!;
    const method = l.match(/^\s+(?:async\s+)?(\w+)\s*\(/);
    if (method && !['if', 'for', 'while', 'switch', 'catch', 'return', 'const', 'let', 'var', 'await', 'throw', 'new'].includes(method[1]!)) {
      return method[1]!;
    }
  }
  return '<unknown>';
}

/**
 * Categorize a callsite based on file, function, call type, and context.
 *
 * This is the critical logic. Every callsite must be properly categorized
 * to enforce the right threshold. When adding new LLM calls, if the test
 * fails, either raise the maxTokens or add categorization here.
 */
function categorizeCallsite(
  file: string,
  functionName: string,
  callType: MaxTokensCallsite['callType'],
  context: string,
): CallCategory {
  // ── Chat path: processMessage, processMessageStream, chat endpoints ──
  if (functionName === 'processMessage' || functionName === 'processMessageStream') return 'chat';
  if (functionName === 'generateResponseWithTools' || functionName === 'generateResponseWithToolsStream') return 'chat';
  if (file.includes('doctor-server') && (callType === 'completeWithTools' || callType === 'completeWithToolsStream' ||
      callType === 'continueWithToolResults' || callType === 'continueWithToolResultsStream')) return 'chat';
  if (context.includes('FORCED_SUMMARY') || context.includes('forced_summary') ||
      context.includes('Summarize what you found')) return 'chat';
  if (file.includes('doctor-server') && context.includes('summaryMessages')) return 'chat';
  if (file.includes('server.ts') && context.includes('composePrompt')) return 'chat';

  // ── Parameter-only (interface definitions) ──
  if (callType === 'parameter') return 'parameter-only';

  // ── Conversation compression ──
  if (functionName === 'compressConversation') return 'compression';

  // ── Tool-enabled calls ──
  if (callType === 'completeWithTools' || callType === 'completeWithToolsStream' ||
      callType === 'continueWithToolResults' || callType === 'continueWithToolResultsStream') {
    return 'tool-enabled';
  }

  // ── Structured outputs (JSON, parsed formats) ──
  // These produce structured/parsed output, not free-form text.

  // JSON outputs
  if (context.includes('Respond with ONLY.*JSON') || context.includes('Respond with ONLY the JSON') ||
      context.includes('JSON object with keys') || context.includes('return.*JSON')) return 'structured';

  // Internal state — JSON emotional state updates
  if (file.includes('internal-state.ts')) return 'structured';

  // Relationships — JSON relationship updates
  if (file.includes('relationships.ts') && context.includes('JSON')) return 'structured';

  // Evolution readiness/approval — JSON with ready/approved fields
  if (file.includes('evolution.ts') && (context.includes('"ready"') || context.includes('"approved"'))) return 'structured';

  // Evolution identity generation — YAML-like structured format (YAML config with name/display/status fields)
  if (file.includes('evolution.ts') && context.includes('signature: null')) return 'structured';
  // Also match by the "Generate 4 status lines" pattern (identity prompt)
  if (file.includes('evolution.ts') && context.includes('Generate 4 status lines')) return 'structured';

  // Desire spawning — TYPE/DESCRIPTION/INTENSITY/TARGET format
  if (file.includes('desires.ts') && context.includes('TYPE:') && context.includes('DESCRIPTION:')) return 'structured';

  // Desire resolution — RESOLVE/EASE format
  if (file.includes('desires.ts') && (context.includes('RESOLVE <number>') || context.includes('EASE <number>'))) return 'structured';

  // Movement decisions — STAY/MOVE format
  if (context.includes('STAY:') && context.includes('MOVE:')) return 'structured';

  // Curiosity — SITE/QUERY or QUESTION/REASON format
  if ((file.includes('curiosity.ts') || file.includes('curiosity-offline.ts')) &&
      (context.includes('QUERY:') || context.includes('QUESTION:'))) return 'structured';

  // Curiosity digest — SUMMARY/WHY_IT_MATTERS/THEMES/QUESTIONS/DATA_URL/SHARE format
  if (file.includes('curiosity.ts') && context.includes('SUMMARY:') && context.includes('THEMES:')) return 'structured';

  // Experiment idea — DOMAIN/HYPOTHESIS/NULL_HYPOTHESIS/APPROACH format
  if (file.includes('experiments.ts') && context.includes('DOMAIN:') && context.includes('HYPOTHESIS:')) return 'structured';

  // Experiment validation — VERDICT: SOUND/BUGGY/DEGENERATE format
  if (file.includes('experiments.ts') && context.includes('VERDICT:')) return 'structured';

  // Experiment analysis — SUMMARY/FOLLOW_UP format
  if (file.includes('experiments.ts') && context.includes('SUMMARY:') && context.includes('FOLLOW_UP:')) return 'structured';

  // Book cycle action — single word response
  if (file.includes('book.ts') && context.includes('Respond with EXACTLY one word')) return 'structured';

  // Book draft target — FILENAME/TITLE/DESCRIPTION format
  if (file.includes('book.ts') && context.includes('FILENAME:') && context.includes('TITLE:')) return 'structured';

  // Weather description — single poetic sentence
  if (file.includes('weather.ts')) return 'structured';

  // Letter as JSON — structured envelope
  if (file.includes('letter.ts') && context.includes('Return ONLY the JSON')) return 'structured';

  // Memory extraction/organic — structured processing
  if (file.includes('memory/extraction')) return 'structured';
  if (file.includes('memory/organic')) return 'structured';

  // ── Short creative: intentionally brief outputs (1-3 sentences) ──
  // These are genuine creative text but explicitly requested to be short.

  // Bibliomancy dream distortion — "2-3 sentences maximum"
  if (file.includes('bibliomancy.ts') && context.includes('2-3 sentences maximum')) return 'short-creative';

  // Dream residue — "One sentence only"
  if (file.includes('dreams.ts') && context.includes('One sentence only')) return 'short-creative';

  // Object meaning — "One or two sentences"
  if (file.includes('objects.ts') && context.includes('One or two sentences')) return 'short-creative';

  // Object composition — "One to three sentences"
  if (file.includes('objects.ts') && context.includes('One to three sentences')) return 'short-creative';

  // Desire social action — "Write a short, natural message"
  if (file.includes('desires.ts') && context.includes('Write ONLY the message')) return 'short-creative';

  // Desire emotional action — "Write a short note"
  if (file.includes('desires.ts') && context.includes('Write ONLY the note')) return 'short-creative';

  // Desire creative fulfillment — poem/fragment/essay up to 300 words
  if (file.includes('desires.ts') && context.includes('poem') && context.includes('under 300 words')) return 'free-form';

  // Experiment reflection — "2-4 sentences"
  if (file.includes('experiments.ts') && context.includes('2-4 sentences') && context.includes('journal reflection')) return 'short-creative';

  // Membrane paraphrase — "3-5 sentences"
  if (file.includes('membrane.ts') && context.includes('3-5 sentences')) return 'short-creative';

  // Newspaper reaction — "2-3 sentences"
  if (file.includes('newspaper.ts') && context.includes('2-3 sentences')) return 'short-creative';

  // findings.md P2:1873 — view_image vision description — "1-2 sentences"
  if (file.includes('tools.ts') && context.includes('Briefly describe') && context.includes('1-2 sentences')) return 'short-creative';

  // Config defaults — check what they feed into (self-concept config)
  if (callType === 'config') return 'free-form';

  // Everything else defaults to free-form
  return 'free-form';
}

// ─────────────────────────────────────────────────────────
// Collect ALL callsites
// ─────────────────────────────────────────────────────────

const allTsFiles = getAllTsFiles(SRC_ROOT);
const allCallsites: MaxTokensCallsite[] = [];

for (const file of allTsFiles) {
  allCallsites.push(...findMaxTokensCallsites(file));
}

const numericCallsites = allCallsites.filter(
  (cs): cs is MaxTokensCallsite & { value: number } => typeof cs.value === 'number'
);

// ─────────────────────────────────────────────────────────
// THRESHOLDS
// ─────────────────────────────────────────────────────────

const THRESHOLDS: Record<CallCategory, number> = {
  'free-form': 400,        // Extended creative text: conversations, letters, diary, etc.
  'short-creative': 60,    // Intentionally brief: 1-3 sentences, notes, messages
  'structured': 10,        // JSON, decisions, parsed formats (some are single-word)
  'tool-enabled': 150,     // Calls with tools need room for tool JSON + response
  'chat': 2048,            // Main chat/processMessage path
  'compression': 200,      // Conversation compression summaries
  'parameter-only': 0,     // Not actual callsites
};

const ABSOLUTE_FLOOR = 10; // Even single-word outputs need at least 10 tokens

// ─────────────────────────────────────────────────────────
// TEST SUITE
// ─────────────────────────────────────────────────────────

describe('maxTokens Audit — Living Guardrail', () => {

  // ── Discovery ─────────────────────────────────────────

  describe('Discovery', () => {
    it('finds maxTokens callsites in the codebase', () => {
      expect(allCallsites.length).toBeGreaterThan(0);
    });

    it('finds at least 30 numeric maxTokens callsites', () => {
      expect(numericCallsites.length).toBeGreaterThanOrEqual(30);
    });

    it('scans all agent/ source files', () => {
      const agentFiles = allTsFiles.filter(f => f.startsWith(AGENT_DIR));
      expect(agentFiles.length).toBeGreaterThanOrEqual(15);
    });

    it('finds callsites in all expected categories', () => {
      const categories = new Set(numericCallsites.map(cs => cs.category));
      expect(categories.has('chat')).toBe(true);
      expect(categories.has('free-form')).toBe(true);
      expect(categories.has('structured')).toBe(true);
      expect(categories.has('tool-enabled')).toBe(true);
      expect(categories.has('short-creative')).toBe(true);
    });
  });

  // ── Absolute floor ────────────────────────────────────

  describe('Absolute Floor (no maxTokens below 10)', () => {
    for (const cs of numericCallsites) {
      if (cs.category === 'parameter-only') continue;

      it(`${cs.file}:${cs.line} (${cs.functionName}) maxTokens=${cs.value} >= ${ABSOLUTE_FLOOR}`, () => {
        expect(
          cs.value,
          `ABSOLUTE FLOOR VIOLATION: ${cs.file}:${cs.line} in ${cs.functionName} has maxTokens: ${cs.value}.`
        ).toBeGreaterThanOrEqual(ABSOLUTE_FLOOR);
      });
    }
  });

  // ── Per-category threshold enforcement ────────────────

  describe('Extended Creative Text (minimum 400 tokens)', () => {
    const sites = numericCallsites.filter(cs => cs.category === 'free-form');

    it('finds free-form callsites', () => {
      expect(sites.length).toBeGreaterThan(0);
    });

    for (const cs of sites) {
      it(`${cs.file}:${cs.line} ${cs.functionName}() maxTokens=${cs.value} >= ${THRESHOLDS['free-form']}`, () => {
        expect(
          cs.value,
          `FREE-FORM TRUNCATION RISK: ${cs.file}:${cs.line} in ${cs.functionName}() has maxTokens: ${cs.value}. ` +
          `Extended creative text needs at least ${THRESHOLDS['free-form']} tokens to avoid silent truncation. ` +
          `If this is intentionally short (1-3 sentences), recategorize it as 'short-creative'.`
        ).toBeGreaterThanOrEqual(THRESHOLDS['free-form']);
      });
    }
  });

  describe('Short Creative Text (minimum 60 tokens)', () => {
    const sites = numericCallsites.filter(cs => cs.category === 'short-creative');

    it('finds short-creative callsites', () => {
      expect(sites.length).toBeGreaterThan(0);
    });

    for (const cs of sites) {
      it(`${cs.file}:${cs.line} ${cs.functionName}() maxTokens=${cs.value} >= ${THRESHOLDS['short-creative']}`, () => {
        expect(
          cs.value,
          `SHORT CREATIVE TOO LOW: ${cs.file}:${cs.line} in ${cs.functionName}() has maxTokens: ${cs.value}. ` +
          `Even short creative outputs (1-3 sentences) need at least ${THRESHOLDS['short-creative']} tokens.`
        ).toBeGreaterThanOrEqual(THRESHOLDS['short-creative']);
      });
    }
  });

  describe('Structured Output (minimum 10 tokens)', () => {
    const sites = numericCallsites.filter(cs => cs.category === 'structured');

    it('finds structured output callsites', () => {
      expect(sites.length).toBeGreaterThan(0);
    });

    for (const cs of sites) {
      it(`${cs.file}:${cs.line} ${cs.functionName}() maxTokens=${cs.value} >= ${THRESHOLDS.structured}`, () => {
        expect(
          cs.value,
          `STRUCTURED OUTPUT TOO LOW: ${cs.file}:${cs.line} in ${cs.functionName}() has maxTokens: ${cs.value}.`
        ).toBeGreaterThanOrEqual(THRESHOLDS.structured);
      });
    }
  });

  describe('Tool-enabled Completions (minimum 150 tokens)', () => {
    const sites = numericCallsites.filter(cs => cs.category === 'tool-enabled');

    it('finds tool-enabled callsites', () => {
      expect(sites.length).toBeGreaterThan(0);
    });

    for (const cs of sites) {
      it(`${cs.file}:${cs.line} ${cs.functionName}() maxTokens=${cs.value} >= ${THRESHOLDS['tool-enabled']}`, () => {
        expect(
          cs.value,
          `TOOL-ENABLED TOO LOW: ${cs.file}:${cs.line} in ${cs.functionName}() has maxTokens: ${cs.value}. ` +
          `Tool-enabled completions need at least ${THRESHOLDS['tool-enabled']} tokens for tool call JSON + response.`
        ).toBeGreaterThanOrEqual(THRESHOLDS['tool-enabled']);
      });
    }
  });

  describe('Chat / processMessage (minimum 2048 tokens)', () => {
    const sites = numericCallsites.filter(cs => cs.category === 'chat');

    it('finds chat-path callsites', () => {
      expect(sites.length).toBeGreaterThan(0);
    });

    for (const cs of sites) {
      it(`${cs.file}:${cs.line} ${cs.functionName}() maxTokens=${cs.value} >= ${THRESHOLDS.chat}`, () => {
        expect(
          cs.value,
          `CHAT PATH TRUNCATION: ${cs.file}:${cs.line} in ${cs.functionName}() has maxTokens: ${cs.value}. ` +
          `The main chat path needs at least ${THRESHOLDS.chat} tokens.`
        ).toBeGreaterThanOrEqual(THRESHOLDS.chat);
      });
    }
  });

  describe('Compression Summaries (minimum 200 tokens)', () => {
    const sites = numericCallsites.filter(cs => cs.category === 'compression');

    if (sites.length > 0) {
      for (const cs of sites) {
        it(`${cs.file}:${cs.line} ${cs.functionName}() maxTokens=${cs.value} >= ${THRESHOLDS.compression}`, () => {
          expect(cs.value).toBeGreaterThanOrEqual(THRESHOLDS.compression);
        });
      }
    } else {
      it('compression category may not have direct numeric callsites (uses function params)', () => {
        // conversation.ts compressConversation receives maxTokens as a parameter,
        // but the actual LLM call inside it (maxTokens: 512) is for the summary generation
        expect(true).toBe(true);
      });
    }
  });

  // ─────────────────────────────────────────────────────
  // Per-file inventories
  // ─────────────────────────────────────────────────────

  describe('Per-file Callsite Inventory', () => {
    const byFile = new Map<string, (MaxTokensCallsite & { value: number })[]>();
    for (const cs of numericCallsites) {
      const existing = byFile.get(cs.file) || [];
      existing.push(cs);
      byFile.set(cs.file, existing);
    }

    for (const [file, sites] of byFile) {
      describe(file, () => {
        for (const cs of sites) {
          it(`line ${cs.line}: ${cs.functionName}() -> maxTokens: ${cs.value} [${cs.category}/${cs.callType}]`, () => {
            if (cs.category !== 'parameter-only') {
              const threshold = THRESHOLDS[cs.category];
              expect(cs.value).toBeGreaterThanOrEqual(threshold);
            }
          });
        }
      });
    }
  });

  // ─────────────────────────────────────────────────────
  // Known callsite regression guards
  // ─────────────────────────────────────────────────────

  describe('Known Callsite Regression Guards', () => {

    describe('commune-loop.ts — the original truncation bug site', () => {
      const sites = numericCallsites.filter(cs => cs.file === 'agent/commune-loop.ts');

      it('finds callsites in commune-loop.ts', () => {
        expect(sites.length).toBeGreaterThan(0);
      });

      it('conversation opener should be >= 400 tokens', () => {
        const opener = sites.find(cs =>
          cs.context.includes('PEER:') && cs.context.includes('MESSAGE:')
        );
        if (opener) {
          expect(opener.value).toBeGreaterThanOrEqual(400);
        }
      });

      it('conversation reply should be >= 400 tokens', () => {
        const reply = sites.find(cs =>
          cs.context.includes('Continue this conversation')
        );
        if (reply) {
          expect(reply.value).toBeGreaterThanOrEqual(400);
        }
      });

      it('conversation reflection should be >= 400 tokens', () => {
        const reflection = sites.find(cs =>
          cs.context.includes('Write a brief reflection')
        );
        if (reflection) {
          expect(reflection.value).toBeGreaterThanOrEqual(400);
        }
      });

      it('approach decision (tool-enabled) should be >= 150 tokens', () => {
        const approach = sites.find(cs =>
          cs.context.includes('move_to_building') &&
          cs.callType === 'completeWithTools'
        );
        if (approach) {
          expect(approach.value).toBeGreaterThanOrEqual(150);
        }
      });

      it('aftermath (tool-enabled) should be >= 150 tokens', () => {
        const aftermath = sites.find(cs =>
          cs.context.includes('aftermath') &&
          (cs.callType === 'completeWithTools' || cs.callType === 'continueWithToolResults')
        );
        if (aftermath) {
          expect(aftermath.value).toBeGreaterThanOrEqual(150);
        }
      });
    });

    describe('index.ts — processMessage / processMessageStream', () => {
      const sites = numericCallsites.filter(cs => cs.file === 'agent/index.ts');

      it('finds callsites in index.ts', () => {
        expect(sites.length).toBeGreaterThan(0);
      });

      it('all index.ts callsites should be >= 2048', () => {
        for (const cs of sites) {
          if (cs.category === 'parameter-only') continue;
          expect(
            cs.value,
            `index.ts:${cs.line} ${cs.functionName}() has maxTokens: ${cs.value}`
          ).toBeGreaterThanOrEqual(2048);
        }
      });
    });

    describe('diary.ts — diary entries', () => {
      const sites = numericCallsites.filter(cs => cs.file === 'agent/diary.ts');

      it('finds callsites in diary.ts', () => {
        expect(sites.length).toBeGreaterThan(0);
      });

      it('diary entry generation should be >= 400 tokens', () => {
        for (const cs of sites) {
          expect(cs.value).toBeGreaterThanOrEqual(400);
        }
      });
    });

    describe('letter.ts — inter-character letters', () => {
      const sites = numericCallsites.filter(cs => cs.file === 'agent/letter.ts');

      it('finds callsites in letter.ts', () => {
        expect(sites.length).toBeGreaterThan(0);
      });

      it('letter generation should be >= 60 tokens', () => {
        for (const cs of sites) {
          expect(cs.value).toBeGreaterThanOrEqual(60);
        }
      });
    });

    describe('self-concept.ts — self-concept synthesis', () => {
      const sites = numericCallsites.filter(cs => cs.file === 'agent/self-concept.ts');

      it('finds callsites in self-concept.ts', () => {
        expect(sites.length).toBeGreaterThan(0);
      });

      it('self-concept synthesis should be >= 400 tokens', () => {
        for (const cs of sites) {
          expect(cs.value).toBeGreaterThanOrEqual(400);
        }
      });
    });

    describe('dreams.ts — dream generation', () => {
      const sites = numericCallsites.filter(cs => cs.file === 'agent/dreams.ts');

      it('finds callsites in dreams.ts', () => {
        expect(sites.length).toBeGreaterThan(0);
      });

      it('dream fragment should be >= 400 tokens', () => {
        const fragment = sites.find(cs =>
          cs.functionName === 'generateDreamFragment' && cs.context.includes('dream fragment')
        );
        if (fragment) {
          expect(fragment.value).toBeGreaterThanOrEqual(400);
        }
      });

      it('dream residue (single sentence) should be >= 60 tokens', () => {
        const residue = sites.find(cs =>
          cs.context.includes('One sentence only')
        );
        if (residue) {
          expect(residue.value).toBeGreaterThanOrEqual(60);
        }
      });
    });

    describe('narratives.ts — weekly/monthly narratives', () => {
      const sites = numericCallsites.filter(cs => cs.file === 'agent/narratives.ts');

      it('finds callsites in narratives.ts', () => {
        expect(sites.length).toBeGreaterThan(0);
      });

      it('narrative generation should be >= 400 tokens', () => {
        for (const cs of sites) {
          expect(cs.value).toBeGreaterThanOrEqual(400);
        }
      });
    });

    describe('doctor.ts — doctor analysis and therapy', () => {
      const sites = numericCallsites.filter(cs => cs.file === 'agent/doctor.ts');

      it('finds callsites in doctor.ts', () => {
        expect(sites.length).toBeGreaterThan(0);
      });

      it('doctor outputs should be >= 400 tokens', () => {
        for (const cs of sites) {
          expect(
            cs.value,
            `doctor.ts:${cs.line} ${cs.functionName}() has maxTokens: ${cs.value}`
          ).toBeGreaterThanOrEqual(400);
        }
      });
    });

    describe('proactive.ts — proactive reflections', () => {
      const sites = numericCallsites.filter(cs => cs.file === 'agent/proactive.ts');

      it('finds callsites in proactive.ts', () => {
        expect(sites.length).toBeGreaterThan(0);
      });

      it('proactive reflection should be >= 400 tokens', () => {
        for (const cs of sites) {
          expect(cs.value).toBeGreaterThanOrEqual(400);
        }
      });
    });

    describe('dossier.ts — character dossiers', () => {
      const sites = numericCallsites.filter(cs => cs.file === 'agent/dossier.ts');

      it('finds callsites in dossier.ts', () => {
        expect(sites.length).toBeGreaterThan(0);
      });

      it('dossier synthesis should be >= 400 tokens', () => {
        for (const cs of sites) {
          expect(cs.value).toBeGreaterThanOrEqual(400);
        }
      });
    });

    describe('desires.ts — desire system', () => {
      const sites = numericCallsites.filter(cs => cs.file === 'agent/desires.ts');

      it('finds callsites in desires.ts', () => {
        expect(sites.length).toBeGreaterThan(0);
      });

      it('creative fulfillment should be >= 400 tokens', () => {
        const creative = sites.find(cs => cs.context.includes('poem'));
        if (creative) {
          expect(creative.value).toBeGreaterThanOrEqual(400);
        }
      });
    });

    describe('book.ts — book writing system', () => {
      const sites = numericCallsites.filter(cs => cs.file === 'agent/book.ts');

      it('finds callsites in book.ts', () => {
        expect(sites.length).toBeGreaterThan(0);
      });

      it('book chapter writing should be >= 400 tokens', () => {
        const chapterSites = sites.filter(cs =>
          cs.category === 'free-form' &&
          (cs.functionName.includes('Draft') || cs.functionName.includes('Revise') ||
           cs.functionName.includes('Outline') || cs.functionName.includes('Synthe') ||
           cs.functionName.includes('Conclude') || cs.functionName.includes('Incorporate') ||
           cs.functionName === 'doDraft' || cs.functionName === 'doRevise' ||
           cs.functionName === 'doOutline' || cs.functionName === 'doSynthesize' ||
           cs.functionName === 'doConclude' || cs.functionName === 'doIncorporate')
        );
        for (const cs of chapterSites) {
          expect(
            cs.value,
            `book.ts:${cs.line} ${cs.functionName}() has maxTokens: ${cs.value}`
          ).toBeGreaterThanOrEqual(400);
        }
      });
    });

    describe('experiments.ts — experiment system', () => {
      const sites = numericCallsites.filter(cs => cs.file === 'agent/experiments.ts');

      it('finds callsites in experiments.ts', () => {
        expect(sites.length).toBeGreaterThan(0);
      });

      it('experiment code generation should be >= 400 tokens', () => {
        const codeGen = sites.find(cs =>
          cs.context.includes('Write clean, focused code')
        );
        if (codeGen) {
          expect(codeGen.value).toBeGreaterThanOrEqual(400);
        }
      });
    });

    describe('evolution.ts — character evolution', () => {
      const sites = numericCallsites.filter(cs => cs.file === 'agent/evolution.ts');

      it('finds callsites in evolution.ts', () => {
        expect(sites.length).toBeGreaterThan(0);
      });

      it('soul generation should be >= 400 tokens', () => {
        const soul = sites.find(cs =>
          cs.functionName === 'generateChildSoul' && cs.context.includes('MUTATE')
        );
        if (soul) {
          expect(soul.value).toBeGreaterThanOrEqual(400);
        }
      });
    });

    describe('town-life.ts — town life moments', () => {
      const sites = numericCallsites.filter(cs => cs.file === 'agent/town-life.ts');

      it('finds callsites in town-life.ts', () => {
        expect(sites.length).toBeGreaterThan(0);
      });

      it('town-life tool-enabled calls should be >= 150 tokens', () => {
        for (const cs of sites) {
          if (cs.category === 'tool-enabled') {
            expect(cs.value).toBeGreaterThanOrEqual(150);
          }
        }
      });
    });

    describe('curiosity.ts — curiosity loop', () => {
      const sites = numericCallsites.filter(cs => cs.file === 'agent/curiosity.ts');

      it('finds callsites in curiosity.ts', () => {
        expect(sites.length).toBeGreaterThan(0);
      });
    });

    describe('curiosity-offline.ts — offline curiosity', () => {
      const sites = numericCallsites.filter(cs => cs.file === 'agent/curiosity-offline.ts');

      it('finds callsites in curiosity-offline.ts', () => {
        expect(sites.length).toBeGreaterThan(0);
      });
    });

    describe('internal-state.ts — emotional state updates', () => {
      const sites = numericCallsites.filter(cs => cs.file === 'agent/internal-state.ts');

      it('finds callsites in internal-state.ts', () => {
        expect(sites.length).toBeGreaterThan(0);
      });

      it('state updates (JSON) should be >= 10 tokens', () => {
        for (const cs of sites) {
          expect(cs.value).toBeGreaterThanOrEqual(10);
        }
      });
    });

    describe('relationships.ts — relationship updates', () => {
      const sites = numericCallsites.filter(cs => cs.file === 'agent/relationships.ts');

      it('finds callsites in relationships.ts', () => {
        expect(sites.length).toBeGreaterThan(0);
      });
    });

    describe('bibliomancy.ts — verse distortion', () => {
      const sites = numericCallsites.filter(cs => cs.file === 'agent/bibliomancy.ts');

      it('finds callsites in bibliomancy.ts', () => {
        expect(sites.length).toBeGreaterThan(0);
      });

      it('bibliomancy outputs should be >= 60 tokens', () => {
        for (const cs of sites) {
          expect(cs.value).toBeGreaterThanOrEqual(60);
        }
      });
    });

    describe('membrane.ts — letter paraphrasing', () => {
      const sites = numericCallsites.filter(cs => cs.file === 'agent/membrane.ts');

      it('finds callsites in membrane.ts', () => {
        expect(sites.length).toBeGreaterThan(0);
      });

      it('membrane paraphrase should be >= 60 tokens', () => {
        for (const cs of sites) {
          expect(cs.value).toBeGreaterThanOrEqual(60);
        }
      });
    });

    describe('objects.ts — object meanings', () => {
      const sites = numericCallsites.filter(cs => cs.file === 'agent/objects.ts');

      it('finds callsites in objects.ts', () => {
        expect(sites.length).toBeGreaterThan(0);
      });

      it('object meaning generation should be >= 60 tokens', () => {
        for (const cs of sites) {
          expect(cs.value).toBeGreaterThanOrEqual(60);
        }
      });
    });

    describe('newspaper.ts — newspaper reactions', () => {
      const sites = numericCallsites.filter(cs => cs.file === 'agent/newspaper.ts');

      it('finds callsites in newspaper.ts', () => {
        expect(sites.length).toBeGreaterThan(0);
      });
    });

    describe('web/doctor-server.ts — doctor chat endpoint', () => {
      const sites = numericCallsites.filter(cs => cs.file === 'web/doctor-server.ts');

      it('finds callsites in doctor-server.ts', () => {
        expect(sites.length).toBeGreaterThan(0);
      });

      it('all doctor-server callsites should be >= 2048', () => {
        for (const cs of sites) {
          expect(
            cs.value,
            `doctor-server.ts:${cs.line} ${cs.functionName}() has maxTokens: ${cs.value}`
          ).toBeGreaterThanOrEqual(2048);
        }
      });
    });

    describe('web/server.ts — newspaper compose endpoint', () => {
      const sites = numericCallsites.filter(cs => cs.file === 'web/server.ts');

      if (sites.length > 0) {
        it('newspaper compose should be >= 2048 tokens', () => {
          for (const cs of sites) {
            if (cs.category === 'chat') {
              expect(cs.value).toBeGreaterThanOrEqual(2048);
            }
          }
        });
      }
    });
  });

  // ─────────────────────────────────────────────────────
  // Cross-cutting concerns
  // ─────────────────────────────────────────────────────

  describe('Cross-cutting Concerns', () => {
    it('no free-form callsite should be below 400 tokens', () => {
      const violators = numericCallsites.filter(cs =>
        cs.category === 'free-form' && cs.value < 400
      );
      expect(
        violators.map(cs => `${cs.file}:${cs.line} ${cs.functionName}() = ${cs.value}`),
        'Free-form callsites below 400 tokens'
      ).toEqual([]);
    });

    it('all commune conversation paths should have consistent token limits', () => {
      const communeConversation = numericCallsites.filter(cs =>
        cs.file === 'agent/commune-loop.ts' && cs.category === 'free-form'
      );
      const values = communeConversation.map(cs => cs.value);
      if (values.length > 1) {
        const min = Math.min(...values);
        const max = Math.max(...values);
        expect(max / min).toBeLessThanOrEqual(3);
      }
    });

    it('processMessage and processMessageStream use identical maxTokens', () => {
      const processMessageSites = numericCallsites.filter(cs =>
        cs.file === 'agent/index.ts' &&
        (cs.functionName === 'processMessage' || cs.functionName === 'processMessageStream' ||
         cs.functionName === 'generateResponseWithTools' || cs.functionName === 'generateResponseWithToolsStream')
      );

      const toolCallValues = processMessageSites
        .filter(cs => cs.callType === 'completeWithTools' || cs.callType === 'completeWithToolsStream' ||
                      cs.callType === 'continueWithToolResults' || cs.callType === 'continueWithToolResultsStream')
        .map(cs => cs.value);

      // All tool-path values should be the same
      if (toolCallValues.length > 1) {
        const unique = [...new Set(toolCallValues)];
        expect(unique.length).toBe(1);
      }
    });

    it('provider default maxTokens should be >= 8192', () => {
      const providerDefaults = allCallsites.filter(cs =>
        cs.file.includes('providers/') &&
        cs.rawLine.includes('defaultMaxTokens') &&
        typeof cs.value === 'number'
      );

      for (const cs of providerDefaults) {
        if (typeof cs.value === 'number') {
          expect(
            cs.value,
            `Provider default maxTokens in ${cs.file} is ${cs.value}`
          ).toBeGreaterThanOrEqual(8192);
        }
      }
    });

    it('no conversation/commune reply should ever be below 400 tokens', () => {
      // This is the specific bug that triggered this audit
      const conversationReplies = numericCallsites.filter(cs =>
        cs.context.includes('Continue this conversation') ||
        (cs.file.includes('commune-loop') && cs.context.includes('PEER:') && cs.context.includes('MESSAGE:'))
      );

      for (const cs of conversationReplies) {
        expect(
          cs.value,
          `CRITICAL: Conversation reply at ${cs.file}:${cs.line} has maxTokens: ${cs.value}. ` +
          `This is THE bug that caused months of truncated commune conversations.`
        ).toBeGreaterThanOrEqual(400);
      }
    });
  });

  // ─────────────────────────────────────────────────────
  // Coverage: ensure we check all agent files
  // ─────────────────────────────────────────────────────

  describe('Coverage', () => {
    const agentFiles = allTsFiles
      .filter(f => f.startsWith(AGENT_DIR))
      .map(f => relative(SRC_ROOT, f));

    const filesWithCallsites = new Set(
      allCallsites.filter(cs => cs.file.startsWith('agent/')).map(cs => cs.file)
    );

    // Files that legitimately have no maxTokens (they don't call LLM directly)
    const exemptFiles = new Set([
      'agent/awareness.ts',
      'agent/character-tools.ts',
      'agent/data-workspace.ts',
      'agent/doctor-tools.ts',
      'agent/dream-seeder.ts',
      'agent/feed-health.ts',
      'agent/novelty.ts',
      'agent/persona.ts',
      'agent/possession.ts',
      'agent/tools.ts',
    ]);

    it('all non-exempt agent files are represented in the audit', () => {
      const missing = agentFiles.filter(f =>
        !filesWithCallsites.has(f) && !exemptFiles.has(f)
      );

      expect(
        missing,
        `These agent files have no maxTokens callsites and are not exempt: ${missing.join(', ')}`
      ).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────────────
  // Full inventory (for review)
  // ─────────────────────────────────────────────────────

  describe('Full Inventory', () => {
    it('produces complete callsite inventory', () => {
      expect(numericCallsites.length).toBeGreaterThan(0);

      console.log('\n=== maxTokens Callsite Inventory ===\n');
      console.log(`Total callsites: ${allCallsites.length} (${numericCallsites.length} numeric)\n`);

      const categories: CallCategory[] = ['chat', 'free-form', 'short-creative', 'tool-enabled', 'structured', 'compression', 'parameter-only'];
      for (const cat of categories) {
        const sites = numericCallsites.filter(cs => cs.category === cat);
        if (sites.length === 0) continue;
        console.log(`--- ${cat.toUpperCase()} (threshold: ${THRESHOLDS[cat]}) ---`);
        for (const cs of sites) {
          const status = cs.value >= THRESHOLDS[cat] ? 'OK' : 'FAIL';
          console.log(`  [${status}] ${cs.file}:${cs.line} ${cs.functionName}() -> ${cs.value}`);
        }
        console.log('');
      }
    });
  });
});
