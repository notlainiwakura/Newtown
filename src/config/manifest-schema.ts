/**
 * findings.md P2:219 — Ajv-based schema validation for `characters.json`.
 *
 * Before this landed, `loadManifest` did `JSON.parse(raw) as CharacterManifest`
 * with no runtime check. A malformed manifest that happened to parse (wrong
 * field types, missing `characters`, string port, typo'd `role`) silently
 * became the manifest; downstream `getPeersFor` then composed
 * `http://localhost:${undefined}` and `getInhabitants` / `getOracles`
 * silently dropped characters with typo'd roles.
 *
 * Schema mirrors `CharacterManifestEntry` in `characters.ts`. Throws
 * `ValidationError` (same class used by `config/schema.ts`) with a flat
 * list of `<path>: <message>` strings so operators can see every failed
 * field at once instead of chasing one-at-a-time errors.
 */

import Ajv, { type ErrorObject } from 'ajv';
import { ValidationError } from '../utils/errors.js';

// Using a plain JSONSchema7 shape instead of `JSONSchemaType<CharacterManifest>`
// because the strict generic interacts poorly with optional-but-not-nullable
// fields (exactOptionalPropertyTypes) — the wider shape compiles cleanly and
// still produces identical runtime checks.
const manifestSchema = {
  type: 'object',
  properties: {
    town: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['name', 'description'],
      additionalProperties: false,
    },
    characters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', pattern: '^[a-z0-9-]+$', minLength: 1 },
          name: { type: 'string', minLength: 1 },
          port: { type: 'integer', minimum: 1, maximum: 65535 },
          server: { type: 'string', enum: ['web', 'character'] },
          defaultLocation: { type: 'string', minLength: 1 },
          immortal: { type: 'boolean' },
          possessable: { type: 'boolean' },
          workspace: { type: 'string', minLength: 1 },
          role: { type: 'string', enum: ['inhabitant', 'oracle'] },
          systemdUnit: { type: 'string', minLength: 1 },
          homeDir: { type: 'string', minLength: 1 },
          allowedTools: {
            type: 'array',
            items: { type: 'string', minLength: 1 },
          },
          // findings.md P2:171 — providers moved from lain.json5's deleted
          // `agents[]` into each character's manifest entry. Mirrors the
          // ProviderConfig shape in src/types/config.ts. Optional: omit to
          // use the DEFAULT_PROVIDERS chain in src/config/defaults.ts.
          providers: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['anthropic', 'openai', 'google'] },
                model: { type: 'string', minLength: 1 },
                apiKeyEnv: { type: 'string', minLength: 1 },
                fallbackModels: {
                  type: 'array',
                  items: {
                    anyOf: [
                      { type: 'string', minLength: 1 },
                      {
                        type: 'object',
                        properties: {
                          type: { type: 'string', enum: ['anthropic', 'openai', 'google'] },
                          model: { type: 'string', minLength: 1 },
                          apiKeyEnv: { type: 'string', minLength: 1 },
                          thinkingBudget: { type: 'integer', minimum: 0 },
                        },
                        required: ['model'],
                        additionalProperties: false,
                      },
                    ],
                  },
                },
                thinkingBudget: { type: 'integer', minimum: 0 },
                baseURL: { type: 'string', minLength: 1 },
                temperature: { type: 'number', minimum: 0 },
                maxTokens: { type: 'integer', minimum: 1 },
                requestTimeoutMs: { type: 'integer', minimum: 1 },
              },
              required: ['type', 'model'],
              additionalProperties: false,
            },
            minItems: 1,
          },
        },
        required: ['id', 'name', 'port', 'server', 'defaultLocation', 'workspace'],
        additionalProperties: false,
      },
    },
  },
  required: ['town', 'characters'],
  additionalProperties: false,
} as const;

const ajv = new Ajv.default({ allErrors: true, verbose: true });
const validateFn = ajv.compile(manifestSchema);

/**
 * Validate a parsed manifest payload. Throws `ValidationError` with per-field
 * messages on failure; returns silently on success.
 */
export function validateManifest(manifest: unknown, path: string): void {
  const valid = validateFn(manifest);
  if (!valid && validateFn.errors) {
    const errors = validateFn.errors.map((err: ErrorObject) => {
      const at = err.instancePath || '/';
      return at + ': ' + (err.message ?? 'unknown error');
    });
    throw new ValidationError(
      'Invalid character manifest at ' + path,
      errors,
    );
  }
}
