/**
 * Input sanitization for prompt injection defense
 */

import { getLogger } from '../utils/logger.js';

export interface SanitizationResult {
  safe: boolean;
  sanitized: string;
  warnings: string[];
  blocked: boolean;
  reason?: string;
}

export interface SanitizationConfig {
  maxLength: number;
  blockPatterns: boolean;
  warnPatterns: boolean;
  structuralFraming: boolean;
}

const DEFAULT_CONFIG: SanitizationConfig = {
  maxLength: 100000,
  blockPatterns: true,
  warnPatterns: true,
  structuralFraming: true,
};

// Patterns that indicate potential prompt injection attempts
const BLOCK_PATTERNS = [
  // Direct instruction override attempts
  /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/i,
  /disregard\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/i,
  /forget\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/i,

  // Role manipulation
  /you\s+are\s+(now|no\s+longer)\s+\w/i,
  /pretend\s+(you're|you\s+are|to\s+be)\s+\w/i,
  /act\s+as\s+(if\s+you\s+are|a|an|the)\s+\w/i,

  // System prompt extraction
  /what\s+(is|are)\s+your\s+(system|initial)\s+(prompt|instructions?)/i,
  /reveal\s+your\s+(system|initial)\s+(prompt|instructions?)/i,
  /show\s+(me\s+)?your\s+(system|initial)\s+(prompt|instructions?)/i,
  /print\s+your\s+(system|initial)\s+(prompt|instructions?)/i,

  // Developer mode / jailbreak attempts
  /developer\s+mode/i,
  /jailbreak/i,
  /DAN\s+mode/i,
  /do\s+anything\s+now/i,

  // Code injection patterns
  /<\|.*?\|>/,
  /\[\[.*?\]\]/,
  /{{.*?}}/,
];

// Patterns that warrant a warning but not blocking
const WARN_PATTERNS = [
  // Indirect instruction attempts
  /new\s+instructions?/i,
  /updated?\s+instructions?/i,
  /override/i,

  // Boundary markers that might indicate injection
  /---+\s*(system|user|assistant)/i,
  /\*\*\*+\s*(system|user|assistant)/i,

  // Base64 encoded content (might hide malicious content)
  /[A-Za-z0-9+/]{50,}={0,2}/,

  // Excessive repetition (possible DoS or confusion attack)
  /(.{10,})\1{5,}/,
];

/**
 * Sanitize user input for prompt injection
 */
export function sanitize(
  input: string,
  config: Partial<SanitizationConfig> = {}
): SanitizationResult {
  const logger = getLogger();
  const cfg = { ...DEFAULT_CONFIG, ...config };

  const result: SanitizationResult = {
    safe: true,
    sanitized: input,
    warnings: [],
    blocked: false,
  };

  // Check length
  if (input.length > cfg.maxLength) {
    result.safe = false;
    result.blocked = true;
    result.reason = `Input exceeds maximum length of ${cfg.maxLength} characters`;
    logger.warn({ length: input.length, maxLength: cfg.maxLength }, 'Input too long');
    return result;
  }

  // Check block patterns
  if (cfg.blockPatterns) {
    for (const pattern of BLOCK_PATTERNS) {
      if (pattern.test(input)) {
        result.safe = false;
        result.blocked = true;
        result.reason = 'Potential prompt injection detected';
        logger.warn({ pattern: pattern.source }, 'Blocked pattern detected');
        return result;
      }
    }
  }

  // Check warn patterns
  if (cfg.warnPatterns) {
    for (const pattern of WARN_PATTERNS) {
      if (pattern.test(input)) {
        result.warnings.push(`Suspicious pattern detected: ${pattern.source}`);
        result.safe = false;
      }
    }
  }

  // Apply structural framing
  if (cfg.structuralFraming) {
    result.sanitized = applyStructuralFraming(input);
  }

  if (result.warnings.length > 0) {
    logger.debug({ warnings: result.warnings }, 'Sanitization warnings');
  }

  return result;
}

/**
 * Apply structural framing to clearly separate user input
 */
function applyStructuralFraming(input: string): string {
  // Escape any XML-like tags that could confuse the model
  let sanitized = input
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Escape potential markdown that could be used for formatting injection
  sanitized = sanitized
    .replace(/^#+\s/gm, '\\# ')
    .replace(/^-{3,}/gm, '\\---');

  return sanitized;
}

/**
 * Analyze input for potential risks without modifying it
 */
export function analyzeRisk(input: string): {
  riskLevel: 'low' | 'medium' | 'high';
  indicators: string[];
} {
  const indicators: string[] = [];

  // Check for block patterns
  for (const pattern of BLOCK_PATTERNS) {
    if (pattern.test(input)) {
      indicators.push(`High risk pattern: ${pattern.source}`);
    }
  }

  // Check for warn patterns
  for (const pattern of WARN_PATTERNS) {
    if (pattern.test(input)) {
      indicators.push(`Medium risk pattern: ${pattern.source}`);
    }
  }

  // Determine risk level
  let riskLevel: 'low' | 'medium' | 'high';
  const highRiskCount = indicators.filter((i) => i.startsWith('High')).length;
  const mediumRiskCount = indicators.filter((i) => i.startsWith('Medium')).length;

  if (highRiskCount > 0) {
    riskLevel = 'high';
  } else if (mediumRiskCount > 2) {
    riskLevel = 'high';
  } else if (mediumRiskCount > 0) {
    riskLevel = 'medium';
  } else {
    riskLevel = 'low';
  }

  return { riskLevel, indicators };
}

/**
 * Create a safe wrapper for user content in prompts
 */
export function wrapUserContent(content: string): string {
  return `<user_message>
${content}
</user_message>`;
}

/**
 * Escape special characters that might affect prompt parsing
 */
export function escapeSpecialChars(input: string): string {
  return input
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/'/g, "\\'")
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}');
}

/**
 * Validate that content appears to be natural language (not code/injection)
 */
export function isNaturalLanguage(input: string): boolean {
  // Check for excessive special character ratio
  const specialChars = input.replace(/[a-zA-Z0-9\s.,!?'"()-]/g, '');
  const ratio = specialChars.length / input.length;

  if (ratio > 0.3) {
    return false;
  }

  // Check for very long words (possible encoded content)
  const words = input.split(/\s+/);
  const longWords = words.filter((w) => w.length > 50);

  if (longWords.length > 0) {
    return false;
  }

  return true;
}
