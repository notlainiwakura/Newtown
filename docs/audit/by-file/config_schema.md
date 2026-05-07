# `src/config/schema.ts`

Ajv schema for `LainConfig`. 1 schema const + 2 exported functions.

## Functions

### `validate(config): config is LainConfig`, line 115

**Purpose:** run Ajv validation. On failure, throw `ValidationError` with per-field messages. Returns type-predicate `true`.

**Gaps / bugs:**
- `return true;` — never reached in the `valid === false` branch (the throw short-circuits). But if `valid` is `true`, returns `true`. Fine.
- Ajv is imported as `Ajv.default` — ESM/CJS interop. Fine as-is but fragile to ajv version bumps.
- `ValidationError(message, errors)` — `errors` is `string[]`. No structured path / code info, consistent with the `utils/errors.ts` shape.

### `getSchema()`, line 132

**Purpose:** return schema for docs. Never called in any known path. Defer to see if anything uses it.

## Schema observations

- `agents[].id` pattern: `^[a-z0-9-]+$` — lowercase + digits + hyphens. Good.
- `agents[].providers` `minItems: 1`. Good.
- `agents` root `minItems: 1`. Blocks empty-config boot; matches `characters.json` which also requires at least one character for a functional town.
- `security.keyDerivation.algorithm` const `'argon2id'` — consistent with `types/config.ts`.
- `security.tokenLength` `minimum: 16` (bytes → 32 hex chars). OK.
- `logging.file` nullable — stdout-only by default.
- `additionalProperties: false` everywhere — strict. Any new top-level field in the types requires a schema update; today that's manually coupled. **P3**.
- **No validation of `characters.json`.** This file has no schema at all. Anywhere `loadManifest()` is called, malformed data (wrong types, missing fields) would crash downstream. **P2** — lifted earlier conceptually, reinforced here.

---

## File-level notes

- `ajv.compile` at module-import time — prevents schema compile cost per-validate. Good.
- No coercion enabled — types must match exactly. Correct for strict schema.
- `@typescript-eslint/no-explicit-any` not needed here; types are JSONSchemaType-driven. Clean.

## Verdict

No new findings to lift. Reinforces the earlier-lifted "no characters.json schema" gap.
