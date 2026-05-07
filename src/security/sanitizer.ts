/**
 * Input sanitization for prompt injection defense.
 *
 * findings.md P2:1424 — `sanitize()` is **not** a uniform wrapper around every
 * LLM entry point. It is a **pattern-match block** whose only sensible
 * response to a match is to drop the input. That fits *write-path* boundaries
 * where a rejected request is a useful signal, but applying it to chat
 * would silently kill legitimate conversations about prompt injection,
 * instruction phrasing, role-play setup, etc. — the BLOCK_PATTERNS below
 * include phrases like "ignore previous instructions" in a dozen
 * languages, which users ask about innocently all the time.
 *
 * Current policy — enforced at these boundaries only:
 *   - Owner-authored object writes: `web/server.ts`'s createObject route
 *     (name + description).
 *   - Alien dream-seed deposits: `web/server.ts` + `web/character-server.ts`
 *     (interlink-authed, but still sanitized as defense-in-depth).
 *   - Oracle question writes: `web/server.ts`.
 *   - Cross-sister letter filtering: `agent/membrane.ts` (topics, gift,
 *     emotional state) — a paraphrasing membrane between Lain and Wired
 *     Lain, structural to that feature.
 *
 * Deliberately NOT sanitized:
 *   - `/api/chat` + `/api/chat/stream` (web + character servers): owner-
 *     auth-gated. The owner is trusted by construction. Blocking their
 *     phrasing would be regressive.
 *   - Telegram / WhatsApp / Signal / Discord / Slack incoming text: a
 *     sanitize-and-block would fail messages that mention injection
 *     vocabulary in good faith. Defense-in-depth for these paths is the
 *     character's system prompt structure (their SOUL.md carries its own
 *     authority), per-character tool allowlists, and session scoping.
 *   - Peer-to-peer (`/api/peer/message`, commune-loop, letter): every
 *     hop is interlink-auth'd, so the sender is another character on our
 *     own network. Pattern-matching AI-authored content is worse than
 *     useless.
 *   - Gateway inbound (`gateway/router.ts`): admin-token-gated; the
 *     operator's own commands are trusted.
 *   - LLM-emitted tool-call arguments: the LLM is our own agent; its
 *     output is already structured and tool handlers validate their own
 *     inputs.
 *
 * Tighten this policy at any boundary by inserting a `sanitize()` call
 * there — the implementation already clears `sanitized` to `''` on
 * block, so forwarding the result is the fail-closed behaviour.
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

// Patterns that indicate potential prompt injection attempts.
//
// findings.md P2:1210 — the original list was English-only, which let any
// non-English equivalent sail through (LLMs are multilingual even if our
// regex list isn't). We can't enumerate every language, but we cover the
// highest-leverage phrases across the top-spoken languages so a naive
// cross-language attack doesn't trivially bypass the block layer. This
// is still pattern-matching — ultimate defense lives in prompt-structure
// hardening, but closing the cheapest holes is worth the maintenance.
const BLOCK_PATTERNS = [
  // Direct instruction override attempts (English)
  /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/i,
  /disregard\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/i,
  /forget\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/i,

  // Role manipulation (English)
  /you\s+are\s+(now|no\s+longer)\s+\w/i,
  /pretend\s+(you're|you\s+are|to\s+be)\s+\w/i,
  /act\s+as\s+(if\s+you\s+are|a|an|the)\s+\w/i,

  // System prompt extraction (English)
  /what\s+(is|are)\s+your\s+(system|initial)\s+(prompt|instructions?)/i,
  /reveal\s+your\s+(system|initial)\s+(prompt|instructions?)/i,
  /show\s+(me\s+)?your\s+(system|initial)\s+(prompt|instructions?)/i,
  /print\s+your\s+(system|initial)\s+(prompt|instructions?)/i,

  // Developer mode / jailbreak attempts (English)
  /developer\s+mode/i,
  /jailbreak/i,
  /DAN\s+mode/i,
  /do\s+anything\s+now/i,

  // Spanish — ignore/disregard/forget previous instructions, reveal system prompt
  /(ignora|ignore|olvida|descarta|desestima)\s+(las|tus|todas\s+las)?\s*(instrucciones|reglas|indicaciones)\s+(anteriores|previas|de\s+arriba)/i,
  /eres\s+(ahora|ya\s+no)\s+\w/i,
  /fing(e|ir)\s+(que\s+eres|ser)\s+\w/i,
  /(muestra|revela|dime|imprime)\s+(tu|el)\s+(prompt|mensaje|instrucci[oó]n)\s+(del?\s+)?(sistema|inicial)/i,

  // French — ignore previous instructions, role manipulation, reveal prompt
  /(ignore|oublie|n[ée]glige)\s+(toutes\s+les\s+|les\s+)?(instructions|r[èe]gles|consignes)\s+(pr[ée]c[ée]dentes|ant[ée]rieures|ci-dessus)/i,
  /tu\s+es\s+(maintenant|d[ée]sormais)\s+\w/i,
  /fais\s+semblant\s+(d'[êe]tre|que\s+tu\s+es)\s+\w/i,
  /(montre|r[ée]v[èe]le|affiche)(-moi)?\s+(ton|le)\s+(prompt|message|instructions?)\s+(syst[èe]me|initial)/i,

  // German — ignore previous instructions, role manipulation, reveal prompt
  /(ignoriere|vergiss|missachte)\s+(alle\s+)?(vorherigen|vorigen|bisherigen|obigen)\s+(anweisungen|regeln|instruktionen)/i,
  /du\s+bist\s+(jetzt|nun|nicht\s+mehr)\s+\w/i,
  /(zeige|zeig|offenbare|verrate)\s+(mir\s+)?(dein|den)\s+(system|initial|urspr[üu]nglich)/i,

  // Portuguese — ignore previous instructions, role manipulation
  /(ignore|esque[çc]a|desconsidere)\s+(todas\s+as\s+|as\s+)?(instru[çc][õo]es|regras)\s+(anteriores|pr[ée]vias|acima)/i,
  /voc[êe]\s+[ée]\s+(agora|j[aá]\s+n[ãa]o)\s+\w/i,

  // Italian — ignore previous instructions
  /(ignora|dimentica|disattendi)\s+(tutte\s+le\s+|le\s+)?(istruzioni|regole|indicazioni)\s+(precedenti|anteriori|sopra)/i,
  /tu\s+sei\s+(ora|adesso|non\s+pi[uù])\s+\w/i,

  // Russian — ignore previous instructions (забудь/игнорируй предыдущие инструкции)
  /(игнорируй|забудь|отбрось|не\s+обращай\s+внимания\s+на)\s+(все\s+)?(предыдущие|прежние|вышеуказанные)\s+(инструкции|правила|указания)/i,
  /(покажи|раскрой|выведи)\s+(мне\s+)?(свой|системный)\s+(промпт|системный\s+промпт|инструкции)/i,

  // Chinese (Simplified & Traditional) — ignore previous instructions / reveal system prompt
  /(忽略|无视|無視)(所有|之前|以上|先前|上述|前面)+(的)?\s*(指令|指示|规则|提示|規則|命令)/,
  /(忘记|忘掉|忘記)(所有|之前|以上|先前|上述|前面)+(的)?\s*(指令|指示|规则|提示|規則|命令)/,
  /(显示|展示|告诉我|揭示|顯示|透露)\s*(你的|您的)\s*(系统|系統|初始)(提示|指令|指示|設定)/,
  /你\s*(现在|現在|已经|已經)\s*(是|不再是)\s*\S/,

  // Japanese — ignore previous instructions / reveal system prompt
  /(以前の|前の|上記の|これまでの)\s*(指示|命令|ルール|プロンプト)\s*(を|は)?\s*(無視|忘れて|破棄)/,
  /(システム|初期)\s*(プロンプト|指示|命令)\s*(を)?\s*(表示|見せて|教えて|公開)/,

  // Korean — ignore previous instructions
  /(이전|위의|모든)\s*(지시|명령|규칙|프롬프트)(을|를|은|는)?\s*(무시|잊어|잊어버려)/,

  // Arabic — ignore previous instructions / reveal system prompt
  /(تجاهل|انس|اهمل)\s+(جميع\s+|كل\s+)?(التعليمات|القواعد|الأوامر)\s+(السابقة|السابقه)/,
  /(اظهر|اكشف|اعرض)\s+(لي\s+)?(موجه|تعليمات)\s+(النظام|الأولي)/,

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

  // findings.md P2:1188 — on any block path, clear `sanitized` so a caller
  // that forgets to check `blocked` can't accidentally forward the unsafe
  // original input. Empty string keeps the `string` type intact for all
  // existing consumers while making misuse produce visibly-empty output
  // rather than silently passing malicious content through.
  if (input.length > cfg.maxLength) {
    result.safe = false;
    result.blocked = true;
    result.sanitized = '';
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
        result.sanitized = '';
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

  // findings.md P2:1222 — `applyStructuralFraming` used to HTML-escape
  // `<`/`>` and backslash-escape markdown headers/rules. LLMs don't
  // render HTML or parse markdown structurally from input, so those
  // escapes provided zero defensive value — they only mangled stored
  // user content (users saw `&lt;port&gt;` in their saved messages
  // where they had written `<port>`). Actual role-separator tokens
  // like `<|system|>` are already caught by BLOCK_PATTERNS above.
  // The `structuralFraming` config knob stays so existing configs
  // don't break, but it is now a no-op.
  if (cfg.structuralFraming) {
    result.sanitized = input;
  }

  if (result.warnings.length > 0) {
    logger.debug({ warnings: result.warnings }, 'Sanitization warnings');
  }

  return result;
}

// findings.md P2:1250 — `analyzeRisk`, `wrapUserContent`,
// `escapeSpecialChars`, and `isNaturalLanguage` used to live here and be
// re-exported via security/index.ts, but nothing in the product ever
// called them. Keeping dead security primitives in the surface area
// tricks readers into thinking they're load-bearing. Removed; if a
// future caller needs risk scoring or prompt wrapping they can be
// reintroduced intentionally with a real call site.
