# `src/config/defaults.ts`

Default `LainConfig` + sample config generator. 2 functions.

## Functions

### `getDefaultConfig()`, line 8

**Purpose:** hard-coded `LainConfig` baseline used (a) as the merge base for `loadConfig()`, (b) directly by `telegram.ts`.

**Gaps / bugs:**
- **agents[0].id = 'default'** — this is the id the Telegram command looks for (`agentId: 'default'` in telegram.ts). If a user overrides in `lain.json5` with `id: 'lain'`, Telegram dispatching breaks. Already lifted as P2 in telegram.md. Reinforcing here.
- **agents[0].name** reads `process.env['LAIN_CHARACTER_NAME'] || 'Assistant'`. Env-var override at default-generation time is clever but silently forks behaviour per process. Any log line mentioning the character name depends on process env. **P3**.
- **Three Anthropic providers, all claude-4-series** — provider[0] sonnet for personality, [1] and [2] both haiku-4.5. The triplet is duplicated — provider[1] and provider[2] are identical. Comment in `generateSampleConfig` calls out "[2]=light" but the light model is the same haiku. Either the shape is supposed to include a cheaper model at [2] (e.g. Haiku 3) OR the layer doesn't actually distinguish [1] vs [2] and the triple is cosmetic. **P2** — needs confirmation during provider audit.
- **No fallback across providers** — if Anthropic is down, there's no openai/google fallback. `fallbackModels` only switches models within the same provider. `providers/fallback.ts` presumably handles cross-provider — defer.
- **`maxMessageLength: 100000`** — 100k chars. Generous. No per-message-type variation.
- **`rateLimit.requestsPerSecond: 10, burstSize: 20`** — per-connection. Fine for local CLI. Town-wide aggregation is enforced elsewhere if at all.
- **`keyDerivation.memoryCost: 65536` (64MiB)** — reasonable for Argon2id. Matches OWASP guidance.

### `generateSampleConfig()`, line 73

**Purpose:** write a commented JSON5 template for `lain onboard`.

**Gaps / bugs:**
- **Sample name is `"Lain"`** but default-generation code uses env-or-`"Assistant"`. Inconsistent. User running `lain onboard` gets a config file with "Lain"; defaults (applied when no config) gives "Assistant". Cosmetic but confusing. **P3**.
- **Sample file omits `fallbackModels`** even though `getDefaultConfig()` sets them — users who regenerate sample and tweak lose the fallback chain silently. **P3**.
- **Sample does NOT reference `characters.json`** at all. New users might think `lain.json5` is authoritative. Given the dualism already flagged in findings (P2), this sample reinforces confusion. **P2**, bundled with the dualism finding.

---

## File-level notes

- Model ids are hard-coded dates (`claude-sonnet-4-20250514`, `claude-haiku-4-5-20251001`). These drift. Ties to the "provider deprecation" angle: if the Sonnet 4.6 id changes, every install without an updated `lain.json5` ships broken. `fallbackModels` mitigates. **P3**.
- Sonnet 4.6 is the current suggested Sonnet model id (`claude-sonnet-4-6`) per system context, but here [0] is `claude-sonnet-4-20250514`. That's Sonnet 4.0, not 4.6. Intentional pin? Defer to provider-layer audit. **P2** — provisional.

## Verdict

**Lift to findings.md:**
- P2: Default providers triple has duplicated haiku at index [1] and [2]. Either intentional (any [1] == [2]) or a mistake. Confirm during provider layer audit.
- P2: Default config pins Sonnet 4.0 (`claude-sonnet-4-20250514`) as personality model. Repo context says latest suggested is Sonnet 4.6. Intentional pin? Fallback list should include Sonnet 4.6.

Bundled with existing dualism finding.
