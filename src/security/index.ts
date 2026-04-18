/**
 * Security module exports
 */

export {
  sanitize,
  analyzeRisk,
  wrapUserContent,
  escapeSpecialChars,
  isNaturalLanguage,
  type SanitizationResult,
  type SanitizationConfig,
} from './sanitizer.js';

export {
  checkSSRF,
  isPrivateIP,
  sanitizeURL,
  safeFetch,
  isAllowedDomain,
  isBlockedDomain,
  type SSRFCheckResult,
} from './ssrf.js';
