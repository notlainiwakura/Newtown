/**
 * Security module exports
 */

// findings.md P2:1250 — trimmed re-exports to match sanitizer's real
// surface area. `analyzeRisk`, `wrapUserContent`, `escapeSpecialChars`,
// and `isNaturalLanguage` were dead code with no callers.
export {
  sanitize,
  type SanitizationResult,
  type SanitizationConfig,
} from './sanitizer.js';

// findings.md P2:1305 — dropped `sanitizeURL`, `isAllowedDomain`, and
// `isBlockedDomain`. The intended use was a per-character URL policy
// (allow/blocklist) that was never wired in. `sanitizeURL` remains as
// a non-exported helper inside ssrf.ts where safeFetch consumes it.
export {
  checkSSRF,
  isPrivateIP,
  safeFetch,
  safeFetchFollow,
  type SSRFCheckResult,
} from './ssrf.js';

export {
  deriveInterlinkToken,
  getInterlinkHeaders,
  verifyInterlinkRequest,
  assertBodyIdentity,
  type InterlinkHeaders,
  type InterlinkAuthResult,
} from './interlink-auth.js';
