# `src/types/config.ts`

Type declarations only. 10 interfaces. No runtime code.

## Interfaces

- `LainConfig` (top-level) — `version`, `gateway`, `security`, `agents[]`, `logging`
- `GatewayConfig` — socket paths + rate limit
- `RateLimitConfig` — `connectionsPerMinute`, `requestsPerSecond`, `burstSize`
- `SecurityConfig` — `requireAuth`, `tokenLength`, `inputSanitization`, `maxMessageLength`, `keyDerivation`
- `KeyDerivationConfig` — `algorithm: 'argon2id'`, `memoryCost`, `timeCost`, `parallelism`
- `AgentConfig` — `id`, `name`, `enabled`, `workspace`, `providers[]`
- `ProviderConfig` — `type: 'anthropic' | 'openai' | 'google'`, `model`, `apiKeyEnv?`, `fallbackModels?`
- `LoggingConfig` — `level`, `prettyPrint`, `file?`
- `ConfigPaths` — `base`, `config`, `socket`, `pidFile`, `database`, `workspace`, `agents`, `extensions`, `credentials`

## Gaps / bugs

- **`AgentConfig` and `characters.json` are parallel universes.** `AgentConfig` defines `id`, `name`, `enabled`, `workspace`, `providers[]`. `characters.json` carries `id`, `name`, `port`, `possessable`, `homeDir`, `systemdUnit`, plus location defaults. Nothing in the runtime maps between them. A town operator editing `lain.json5` for LLM provider changes edits one file; for character membership, another. Two sources of truth for overlapping concerns. **P2** — big architectural-debt flag, lifted.
- **`ProviderConfig` has no `baseUrl` / `apiVersion` / `temperature` / `maxTokens`.** All of these are hard-coded inside provider modules or derived from env at call time. Any change to per-provider defaults requires code edits. For a BYOK commune-platform (per the project vision in MEMORY), this rigidity limits what users can tune. **P2**.
- **`KeyDerivationConfig.algorithm` is literal `'argon2id'`.** No future-proofing for `argon2i`, `scrypt`, or `pbkdf2`. Fine until it isn't. **P3**.
- **`ConfigPaths` doesn't include character-specific paths** (`~/.lain-<id>/` home dirs). Multi-char paths are derived via `LAIN_HOME` env override. Consistent with the "one process = one character" deploy model, but means `ConfigPaths` only describes one character's view of the world. **P3** — architectural note.
- **No `requestTimeoutMs` or `abortOnTimeoutMs` fields** in `ProviderConfig` — ties to the `withTimeout` P2 already lifted.

---

## File-level notes

- `ProviderConfig.fallbackModels?: string[]` — new-ish since model deprecation became a concern. No cap on length, no per-entry validation. Schema validation lives in `config/schema.ts`, defer.
- `SecurityConfig.inputSanitization: boolean` — single bool governing multiple sanitization strategies (see `security/sanitizer.ts`). Coarse knob. **P3**.

## Verdict

**Lift to findings.md:**
- P2: `lain.json5 AgentConfig` and `characters.json` both describe characters. No mapping. Two sources of truth.
- P2: `ProviderConfig` lacks tunables (baseUrl, temperature, maxTokens, timeout). Platform-ization and per-character tuning will hit this wall.
