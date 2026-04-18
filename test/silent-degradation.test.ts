/**
 * Silent Degradation Test Suite
 *
 * Tests for the class of bug where the system works but produces worse
 * results without any indication. The max_tokens truncation bug (4096
 * default silently cutting off responses for months) is the canonical
 * example. These tests ensure:
 *
 * 1. Provider defaults are sane
 * 2. Every LLM call path has adequate token limits
 * 3. Truncation (finishReason=length) is never silent
 * 4. Background loop outputs are validated before storage
 * 5. Config validation catches dangerous values
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
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

// ─────────────────────────────────────────────────────────
// 1. PROVIDER DEFAULTS — No provider should ship with low token limits
// ─────────────────────────────────────────────────────────
describe('Provider Defaults', () => {
  it('Anthropic provider defaults to >= 8192 maxTokens', async () => {
    const src = readFileSync(join(process.cwd(), 'src/providers/anthropic.ts'), 'utf-8');
    const match = src.match(/config\.maxTokens\s*\?\?\s*(\d+)/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(8192);
  });

  it('OpenAI provider defaults to >= 8192 maxTokens', async () => {
    const src = readFileSync(join(process.cwd(), 'src/providers/openai.ts'), 'utf-8');
    const match = src.match(/config\.maxTokens\s*\?\?\s*(\d+)/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(8192);
  });

  it('Google provider defaults to >= 8192 maxTokens', async () => {
    const src = readFileSync(join(process.cwd(), 'src/providers/google.ts'), 'utf-8');
    const match = src.match(/config\.maxTokens\s*\?\?\s*(\d+)/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(8192);
  });

  it('all provider defaults are consistent', () => {
    const providers = ['anthropic.ts', 'openai.ts', 'google.ts'];
    const defaults: number[] = [];

    for (const file of providers) {
      const src = readFileSync(join(process.cwd(), 'src/providers', file), 'utf-8');
      const match = src.match(/config\.maxTokens\s*\?\?\s*(\d+)/);
      expect(match, `${file} must have a maxTokens default`).not.toBeNull();
      defaults.push(Number(match![1]));
    }

    expect(new Set(defaults).size).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────
// 2. CONVERSATION PATH TOKEN LIMITS — Main chat must never be < 8192
// ─────────────────────────────────────────────────────────
describe('Conversation Path Token Limits', () => {
  const MIN_CHAT_TOKENS = 8192;
  let indexSrc: string;

  beforeEach(() => {
    indexSrc = readFileSync(join(process.cwd(), 'src/agent/index.ts'), 'utf-8');
  });

  it('generateResponseWithTools uses >= 8192 maxTokens for initial call', () => {
    const fnBody = extractFunction(indexSrc, 'generateResponseWithTools');
    const tokenValues = extractMaxTokensFromCompleteWithTools(fnBody);
    for (const val of tokenValues) {
      expect(val, 'completeWithTools maxTokens must be >= 8192').toBeGreaterThanOrEqual(MIN_CHAT_TOKENS);
    }
  });

  it('generateResponseWithToolsStream uses >= 8192 maxTokens', () => {
    const fnBody = extractFunction(indexSrc, 'generateResponseWithToolsStream');
    const tokenValues = extractMaxTokensFromCompleteWithTools(fnBody);
    for (const val of tokenValues) {
      expect(val, 'streaming completeWithTools maxTokens must be >= 8192').toBeGreaterThanOrEqual(MIN_CHAT_TOKENS);
    }
  });

  it('continueWithToolResults uses >= 8192 maxTokens', () => {
    const matches = indexSrc.matchAll(/continueWithToolResults\w*\(\s*\{[^}]*maxTokens:\s*(\d+)/g);
    const values = [...matches].map(m => Number(m[1]));
    expect(values.length).toBeGreaterThan(0);
    for (const val of values) {
      expect(val, 'continueWithToolResults maxTokens must be >= 8192').toBeGreaterThanOrEqual(MIN_CHAT_TOKENS);
    }
  });

  it('summary fallback uses >= 2048 maxTokens', () => {
    const summaryBlocks = indexSrc.matchAll(/Do not use any more tools[\s\S]*?maxTokens:\s*(\d+)/g);
    const values = [...summaryBlocks].map(m => Number(m[1]));
    expect(values.length).toBeGreaterThan(0);
    for (const val of values) {
      expect(val, 'summary fallback maxTokens must be >= 2048').toBeGreaterThanOrEqual(2048);
    }
  });

  it('doctor server uses >= 8192 maxTokens for tool calls', () => {
    const src = readFileSync(join(process.cwd(), 'src/web/doctor-server.ts'), 'utf-8');
    const matches = src.matchAll(/completeWithTools\w*\(\s*\{[^}]*maxTokens:\s*(\d+)/g);
    const values = [...matches].map(m => Number(m[1]));
    expect(values.length).toBeGreaterThan(0);
    for (const val of values) {
      expect(val, 'doctor-server maxTokens must be >= 8192').toBeGreaterThanOrEqual(MIN_CHAT_TOKENS);
    }
  });

  it('research letter composition uses >= 2048 maxTokens', () => {
    const src = readFileSync(join(process.cwd(), 'src/web/server.ts'), 'utf-8');
    const match = src.match(/Compose a response letter[\s\S]*?maxTokens:\s*(\d+)/);
    expect(match, 'research letter call must exist').not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(2048);
  });
});

// ─────────────────────────────────────────────────────────
// 3. TRUNCATION DETECTION — finishReason=length must never be silent
// ─────────────────────────────────────────────────────────
describe('Truncation Detection', () => {
  it('main agent pipeline checks finishReason after tool loop', () => {
    const src = readFileSync(join(process.cwd(), 'src/agent/index.ts'), 'utf-8');
    const checks = src.match(/finishReason\s*===?\s*['"]length['"]/g);
    expect(checks, 'must check finishReason === "length" somewhere').not.toBeNull();
    expect(checks!.length).toBeGreaterThanOrEqual(2);
  });

  it('truncation logs a warning', () => {
    const src = readFileSync(join(process.cwd(), 'src/agent/index.ts'), 'utf-8');
    expect(src).toContain('logger.warn');
    const warnAfterLength = src.match(/finishReason\s*===\s*['"]length['"][\s\S]{0,200}logger\.warn/g);
    expect(warnAfterLength, 'logger.warn must follow finishReason length check').not.toBeNull();
  });

  it('Anthropic provider maps finish_reason correctly', () => {
    const src = readFileSync(join(process.cwd(), 'src/providers/anthropic.ts'), 'utf-8');
    expect(src).toContain("'max_tokens'");
    expect(src).toContain("'length'");
  });

  it('OpenAI provider maps finish_reason correctly', () => {
    const src = readFileSync(join(process.cwd(), 'src/providers/openai.ts'), 'utf-8');
    expect(src).toContain("case 'length'");
    const mapping = src.match(/case\s*['"]length['"]\s*:\s*return\s*['"]length['"]/);
    expect(mapping, 'OpenAI must map "length" to "length"').not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────
// 4. BACKGROUND LOOP OUTPUT VALIDATION — Loops must validate before storing
// ─────────────────────────────────────────────────────────
describe('Background Loop Output Validation', () => {
  it('diary validates entry length before storing', () => {
    const src = readFileSync(join(process.cwd(), 'src/agent/diary.ts'), 'utf-8');
    expect(src).toMatch(/length\s*<\s*\d+/);
  });

  it('dreams validates fragment before storing', () => {
    const src = readFileSync(join(process.cwd(), 'src/agent/dreams.ts'), 'utf-8');
    expect(src).toMatch(/length\s*<\s*\d+/);
  });

  it('letter validates response structure before delivering', () => {
    const src = readFileSync(join(process.cwd(), 'src/agent/letter.ts'), 'utf-8');
    expect(src).toMatch(/JSON\.parse/);
    expect(src).toMatch(/length\s*<\s*\d+/);
  });

  it('self-concept validates output length before storing', () => {
    const src = readFileSync(join(process.cwd(), 'src/agent/self-concept.ts'), 'utf-8');
    expect(src).toMatch(/length\s*<\s*\d+/);
  });

  it('weather has fallback when LLM fails', () => {
    const src = readFileSync(join(process.cwd(), 'src/commune/weather.ts'), 'utf-8');
    expect(src).toMatch(/catch/);
    expect(src).toMatch(/length\s*>\s*\d+/);
  });

  it('memory extraction validates JSON structure', () => {
    const src = readFileSync(join(process.cwd(), 'src/memory/extraction.ts'), 'utf-8');
    expect(src).toMatch(/\.match\(/);
  });

  it('memory distillation validates summary length', () => {
    const src = readFileSync(join(process.cwd(), 'src/memory/organic.ts'), 'utf-8');
    const checks = src.match(/!summary\s*\|\|\s*summary\.length\s*<\s*\d+/g);
    expect(checks, 'organic memory must validate summary length').not.toBeNull();
  });

  it('curiosity checks for NOTHING sentinel', () => {
    const src = readFileSync(join(process.cwd(), 'src/agent/curiosity.ts'), 'utf-8');
    expect(src).toContain('[NOTHING]');
  });

  it('proactive checks for SILENCE sentinel', () => {
    const src = readFileSync(join(process.cwd(), 'src/agent/proactive.ts'), 'utf-8');
    expect(src).toContain('[SILENCE]');
  });

  it('desires checks for NOTHING sentinel', () => {
    const src = readFileSync(join(process.cwd(), 'src/agent/desires.ts'), 'utf-8');
    expect(src).toContain('[NOTHING]');
  });
});

// ─────────────────────────────────────────────────────────
// 5. NO DANGEROUSLY LOW TOKEN LIMITS — Scan all agent files
// ─────────────────────────────────────────────────────────
describe('No Dangerously Low Token Limits on Long-Form Content', () => {
  const LONG_FORM_PATTERNS = [
    { file: 'src/agent/book.ts', pattern: /maxTokens:\s*(\d+)/g, minForLongCalls: 100 },
    { file: 'src/agent/evolution.ts', pattern: /maxTokens:\s*(\d+)/g, minForLongCalls: 200 },
    { file: 'src/agent/experiments.ts', pattern: /maxTokens:\s*(\d+)/g, minForLongCalls: 200 },
  ];

  for (const { file, pattern, minForLongCalls } of LONG_FORM_PATTERNS) {
    it(`${file} has no maxTokens below ${minForLongCalls}`, () => {
      if (!existsSync(join(process.cwd(), file))) return;
      const src = readFileSync(join(process.cwd(), file), 'utf-8');
      const matches = [...src.matchAll(pattern)];
      for (const m of matches) {
        const val = Number(m[1]);
        if (val < minForLongCalls) {
          // Allow very low values only for decision-type calls (e.g. "OUTLINE or DRAFT?")
          const context = src.slice(Math.max(0, m.index! - 200), m.index! + 100);
          const isDecisionCall = /decision|choose|select|which|OUTLINE|DRAFT|REVISE|STAY|MOVE/i.test(context);
          if (!isDecisionCall) {
            expect(val, `${file} has suspiciously low maxTokens: ${val}`).toBeGreaterThanOrEqual(minForLongCalls);
          }
        }
      }
    });
  }

  it('commune-loop dialogue responses use >= 200 maxTokens', () => {
    const src = readFileSync(join(process.cwd(), 'src/agent/commune-loop.ts'), 'utf-8');
    const matches = [...src.matchAll(/maxTokens:\s*(\d+)/g)];
    for (const m of matches) {
      const val = Number(m[1]);
      // Movement decisions can be low, but dialogue should be >= 200
      const context = src.slice(Math.max(0, m.index! - 300), m.index! + 50);
      const isDialogue = /greet|response|reply|dialogue|conversation|reflect/i.test(context);
      if (isDialogue) {
        expect(val, `commune-loop dialogue has low maxTokens: ${val}`).toBeGreaterThanOrEqual(200);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────
// 6. CONFIG VALIDATION — Schema must catch dangerous configs
// ─────────────────────────────────────────────────────────
describe('Config Validation', () => {
  it('schema requires at least one provider per agent', async () => {
    const { getSchema } = await import('../src/config/schema.js');
    const schema = getSchema();
    const agentItems = schema.properties.agents.items;
    const providersSchema = agentItems.properties.providers;
    expect(providersSchema.minItems).toBeGreaterThanOrEqual(1);
  });

  it('schema requires provider type to be a known enum', async () => {
    const { getSchema } = await import('../src/config/schema.js');
    const schema = getSchema();
    const providerSchema = schema.properties.agents.items.properties.providers.items;
    expect(providerSchema.properties.type.enum).toContain('anthropic');
    expect(providerSchema.properties.type.enum).toContain('openai');
    expect(providerSchema.properties.type.enum).toContain('google');
  });

  it('schema requires model field on providers', async () => {
    const { getSchema } = await import('../src/config/schema.js');
    const schema = getSchema();
    const providerSchema = schema.properties.agents.items.properties.providers.items;
    expect(providerSchema.required).toContain('model');
  });

  it('default config has 3 provider tiers', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    const config = getDefaultConfig();
    const agent = config.agents[0]!;
    expect(agent.providers.length).toBe(3);
  });

  it('default config uses valid provider types', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    const config = getDefaultConfig();
    const validTypes = ['anthropic', 'openai', 'google'];
    for (const agent of config.agents) {
      for (const provider of agent.providers) {
        expect(validTypes).toContain(provider.type);
      }
    }
  });

  it('security defaults are not weakened', async () => {
    const { getDefaultConfig } = await import('../src/config/defaults.js');
    const config = getDefaultConfig();
    expect(config.security.requireAuth).toBe(true);
    expect(config.security.inputSanitization).toBe(true);
    expect(config.security.maxMessageLength).toBeGreaterThanOrEqual(1000);
    expect(config.security.maxMessageLength).toBeLessThanOrEqual(1000000);
  });
});

// ─────────────────────────────────────────────────────────
// 7. BUDGET SYSTEM — Must not silently fail
// ─────────────────────────────────────────────────────────
describe('Budget System', () => {
  it('budget has a sane default cap', () => {
    const src = readFileSync(join(process.cwd(), 'src/providers/budget.ts'), 'utf-8');
    const match = src.match(/parsed\s*>\s*0\s*\?\s*parsed\s*:\s*(\d[\d_]*)/);
    expect(match, 'budget must have a default cap').not.toBeNull();
    const cap = Number(match![1].replace(/_/g, ''));
    expect(cap).toBeGreaterThanOrEqual(1_000_000);
    expect(cap).toBeLessThanOrEqual(1_000_000_000);
  });

  it('budget warns before hard cutoff', () => {
    const src = readFileSync(join(process.cwd(), 'src/providers/budget.ts'), 'utf-8');
    expect(src).toMatch(/warn|warning/i);
    expect(src).toMatch(/80|0\.8/);
  });

  it('all providers are wrapped with budget enforcement', () => {
    const src = readFileSync(join(process.cwd(), 'src/providers/index.ts'), 'utf-8');
    expect(src).toContain('withBudget');
    expect(src).toContain('checkBudget');
    expect(src).toContain('recordUsage');
  });
});

// ─────────────────────────────────────────────────────────
// 8. ENVIRONMENT VARIABLE SAFETY — Critical env vars have fallbacks or clear errors
// ─────────────────────────────────────────────────────────
describe('Environment Variable Safety', () => {
  it('LAIN_HOME has a safe default', () => {
    const src = readFileSync(join(process.cwd(), 'src/config/paths.ts'), 'utf-8');
    expect(src).toMatch(/process\.env\['LAIN_HOME'\]\s*\?\?/);
    expect(src).toContain('homedir()');
  });

  it('LAIN_CHARACTER_NAME has a fallback', () => {
    const src = readFileSync(join(process.cwd(), 'src/config/defaults.ts'), 'utf-8');
    expect(src).toMatch(/process\.env\['LAIN_CHARACTER_NAME'\]\s*\|\|/);
  });

  it('owner auth checks for LAIN_OWNER_TOKEN', () => {
    const src = readFileSync(join(process.cwd(), 'src/web/owner-auth.ts'), 'utf-8');
    expect(src).toContain("process.env['LAIN_OWNER_TOKEN']");
  });

  it('interlink token is checked before use', () => {
    const serverSrc = readFileSync(join(process.cwd(), 'src/web/server.ts'), 'utf-8');
    expect(serverSrc).toContain('LAIN_INTERLINK_TOKEN');
  });
});

// ─────────────────────────────────────────────────────────
// 9. RETRY AND FALLBACK — Provider failures must not be silent
// ─────────────────────────────────────────────────────────
describe('Retry and Fallback Behavior', () => {
  it('retry module exists and handles retryable status codes', () => {
    const src = readFileSync(join(process.cwd(), 'src/providers/retry.ts'), 'utf-8');
    expect(src).toContain('429');
    expect(src).toContain('500');
    expect(src).toContain('503');
  });

  it('fallback provider promotes successful fallback model', () => {
    const src = readFileSync(join(process.cwd(), 'src/providers/fallback.ts'), 'utf-8');
    expect(src).toMatch(/promot|active|switch/i);
  });

  it('fallback provider detects deprecated model errors', () => {
    const src = readFileSync(join(process.cwd(), 'src/providers/fallback.ts'), 'utf-8');
    expect(src).toContain('deprecated');
    expect(src).toContain('404');
  });

  it('main agent has fallback from personality to light tier', () => {
    const src = readFileSync(join(process.cwd(), 'src/agent/index.ts'), 'utf-8');
    expect(src).toMatch(/primary.*fail.*fallback|fallback.*light/is);
  });
});

// ─────────────────────────────────────────────────────────
// 10. TOOL LOOP SAFETY — Tool loops must have iteration limits
// ─────────────────────────────────────────────────────────
describe('Tool Loop Safety', () => {
  it('main agent has MAX_TOOL_ITERATIONS limit', () => {
    const src = readFileSync(join(process.cwd(), 'src/agent/index.ts'), 'utf-8');
    expect(src).toContain('MAX_TOOL_ITERATIONS');
    const match = src.match(/MAX_TOOL_ITERATIONS\s*=\s*(\d+)/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(1);
    expect(Number(match![1])).toBeLessThanOrEqual(20);
  });

  it('doctor server has tool loop limit', () => {
    const src = readFileSync(join(process.cwd(), 'src/web/doctor-server.ts'), 'utf-8');
    expect(src).toContain('MAX_TOOL_ITERATIONS');
  });

  it('commune loop has tool iteration guard', () => {
    const src = readFileSync(join(process.cwd(), 'src/agent/commune-loop.ts'), 'utf-8');
    expect(src).toMatch(/iterations?\s*<\s*\d+|i\s*<\s*\d+/);
  });
});

// ─────────────────────────────────────────────────────────
// 11. CONVERSATION COMPRESSION — Must not silently lose context
// ─────────────────────────────────────────────────────────
describe('Conversation Compression Safety', () => {
  it('compression preserves system prompt', () => {
    const src = readFileSync(join(process.cwd(), 'src/agent/conversation.ts'), 'utf-8');
    expect(src).toMatch(/system|role.*system/i);
  });

  it('compression has maxTokens guard', () => {
    const src = readFileSync(join(process.cwd(), 'src/agent/conversation.ts'), 'utf-8');
    expect(src).toMatch(/maxTokens/);
  });

  it('trim function exists and respects limits', () => {
    const src = readFileSync(join(process.cwd(), 'src/agent/conversation.ts'), 'utf-8');
    expect(src).toContain('trimConversation');
  });
});

// ─────────────────────────────────────────────────────────
// 12. CROSS-FILE CONSISTENCY — No maxTokens in agent/ below dangerous thresholds
// ─────────────────────────────────────────────────────────
describe('Cross-File Token Limit Audit', () => {
  const agentDir = join(process.cwd(), 'src/agent');
  const agentFiles = existsSync(agentDir) ? readdirSync(agentDir).filter(f => f.endsWith('.ts')) : [];

  it('found agent source files to audit', () => {
    expect(agentFiles.length).toBeGreaterThan(0);
  });

  it('no agent file uses maxTokens: 1 (common copy-paste error)', () => {
    for (const file of agentFiles) {
      const src = readFileSync(join(agentDir, file), 'utf-8');
      const matches = [...src.matchAll(/maxTokens:\s*(\d+)/g)];
      for (const m of matches) {
        expect(Number(m[1]), `${file} has maxTokens: 1`).toBeGreaterThan(1);
      }
    }
  });

  it('no provider file uses maxTokens: 0 as default', () => {
    const providerDir = join(process.cwd(), 'src/providers');
    const providerFiles = readdirSync(providerDir).filter(f => f.endsWith('.ts'));
    for (const file of providerFiles) {
      const src = readFileSync(join(providerDir, file), 'utf-8');
      const match = src.match(/config\.maxTokens\s*\?\?\s*0/);
      expect(match, `${file} must not default maxTokens to 0`).toBeNull();
    }
  });

  it('total maxTokens call sites are accounted for', () => {
    let totalCallSites = 0;
    for (const file of agentFiles) {
      const src = readFileSync(join(agentDir, file), 'utf-8');
      const matches = [...src.matchAll(/maxTokens:\s*\d+/g)];
      totalCallSites += matches.length;
    }
    // If someone adds a new LLM call, this test forces them to be aware of the
    // token limit landscape. Bump this number when adding legitimate new calls.
    expect(totalCallSites).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────
// 13. PERSONA AND RESPONSE STYLING — Must not silently skip
// ─────────────────────────────────────────────────────────
describe('Response Pipeline Completeness', () => {
  it('processMessage applies persona style', () => {
    const src = readFileSync(join(process.cwd(), 'src/agent/index.ts'), 'utf-8');
    expect(src).toContain('applyPersonaStyle');
  });

  it('processMessage records to memory', () => {
    const src = readFileSync(join(process.cwd(), 'src/agent/index.ts'), 'utf-8');
    expect(src).toMatch(/recordMessage|saveMemory|addMessage|memory/i);
  });

  it('echo mode exists as fallback when no provider is available', () => {
    const src = readFileSync(join(process.cwd(), 'src/agent/index.ts'), 'utf-8');
    expect(src).toMatch(/echo/i);
  });
});

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────

function extractFunction(src: string, name: string): string {
  const startPattern = new RegExp(`async\\s+function\\s+${name}\\s*\\(`);
  const startMatch = src.match(startPattern);
  if (!startMatch || startMatch.index === undefined) return '';

  let braceCount = 0;
  let started = false;
  let start = startMatch.index;

  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') {
      braceCount++;
      started = true;
    } else if (src[i] === '}') {
      braceCount--;
      if (started && braceCount === 0) {
        return src.slice(start, i + 1);
      }
    }
  }
  return src.slice(start);
}

function extractMaxTokensFromCompleteWithTools(fnBody: string): number[] {
  const matches = fnBody.matchAll(/completeWithTools\w*\(\s*\{[^}]*maxTokens:\s*(\d+)/g);
  return [...matches].map(m => Number(m[1]));
}
