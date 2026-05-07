import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getLogger } from '../utils/logger.js';
import { validateManifest } from './manifest-schema.js';
import { DEFAULT_PROVIDERS } from './defaults.js';
import { getPaths } from './paths.js';
import type { AgentConfig, ProviderConfig } from '../types/config.js';

export interface CharacterManifestEntry {
  id: string;
  name: string;
  port: number;
  server: 'web' | 'character';
  defaultLocation: string;
  immortal?: boolean;
  possessable?: boolean;
  workspace: string;
  role?: 'inhabitant' | 'oracle';
  systemdUnit?: string;
  homeDir?: string;
  // findings.md P2:1887 — per-character tool allowlist. If present, the
  // agent's tool registry is filtered to this set at `getToolDefinitions`
  // time, so a character whose persona refuses (say) `fetch_webpage` is not
  // offered that tool by the LLM. If absent, every registered tool is
  // exposed (legacy behaviour).
  allowedTools?: string[];
  // findings.md P2:171 — per-character LLM provider chain. Moved here from
  // `LainConfig.agents[].providers`. Tiered `[personality, memory, light]`
  // (see src/agent/index.ts:183-194). Omitting this field falls back to
  // `DEFAULT_PROVIDERS` in src/config/defaults.ts.
  providers?: ProviderConfig[];
}

export interface TownConfig {
  name: string;
  description: string;
}

export interface CharacterManifest {
  town: TownConfig;
  characters: CharacterManifestEntry[];
}

let _manifest: CharacterManifest | null = null;
let _warnedMissingManifest = false;

/** Test-only: clear the module-level manifest cache so tests can reload fixtures. */
export function _resetManifestCache(): void {
  _manifest = null;
  _warnedMissingManifest = false;
}

function getManifestCandidates(): string[] {
  const explicitConfig = process.env['CHARACTERS_CONFIG'];
  if (explicitConfig) return [explicitConfig];
  return [
    join(process.cwd(), 'characters.json'),
    join(process.cwd(), 'characters.json5'),
  ];
}

function findManifestPath(): string | null {
  for (const p of getManifestCandidates()) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * findings.md P2:78 — exposed so CLI diagnostics (`doctor`, `status`,
 * `onboard`) can tell "single-user install" apart from "multi-char town".
 * Returns the resolved manifest path (same logic as `loadManifest`), or
 * null if no characters.json is present in any candidate location.
 */
export function getManifestPath(): string | null {
  return findManifestPath();
}

export function loadManifest(): CharacterManifest {
  if (_manifest) return _manifest;

  const path = findManifestPath();
  if (!path) {
    // findings.md P2:221 — absent manifest used to degrade to an empty
    // town silently: peers, telemetry, weather and commune loop all went
    // no-op with nothing in the logs. Warn once, attaching the list of
    // paths we searched so operators can diagnose cwd / env issues
    // without having to grep the source.
    if (!_warnedMissingManifest) {
      _warnedMissingManifest = true;
      getLogger().warn(
        { searched: getManifestCandidates() },
        'characters.json not found; starting with empty town. Set CHARACTERS_CONFIG or place characters.json in the working directory.',
      );
    }
    return { town: { name: 'Town', description: '' }, characters: [] };
  }

  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  // findings.md P2:219 — refuse to return a manifest we haven't shape-
  // checked. A string port or typo'd role used to silently corrupt
  // peer URLs and inhabitant/oracle partitions; now the process fails
  // loudly at startup with a list of the exact bad fields.
  validateManifest(parsed, path);
  _manifest = parsed as CharacterManifest;
  return _manifest;
}

export function getCharacterEntry(id: string): CharacterManifestEntry | undefined {
  return loadManifest().characters.find(c => c.id === id);
}

/**
 * findings.md P2:1887 — returns the character's tool allowlist, or null if
 * the manifest entry does not declare one (legacy / unrestricted characters
 * keep full access to every registered tool).
 */
export function getAllowedTools(id: string): string[] | null {
  const entry = getCharacterEntry(id);
  if (!entry || !entry.allowedTools) return null;
  return entry.allowedTools;
}

export function getAllCharacters(): CharacterManifestEntry[] {
  return loadManifest().characters;
}

export function getDefaultLocations(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const c of loadManifest().characters) {
    result[c.id] = c.defaultLocation;
  }
  return result;
}

/**
 * findings.md P2:2271 — fail-closed replacement for the pattern
 * `process.env['LAIN_CHARACTER_NAME'] || 'Lain'`, which silently mis-
 * identified every non-Lain character if the env was unset or mis-
 * propagated through systemd. Throw instead so the failure is loud
 * (service doesn't start, log line is unmistakable) rather than quiet
 * (every LLM prompt is addressed to "Lain" regardless of character).
 */
export function requireCharacterName(): string {
  const name = process.env['LAIN_CHARACTER_NAME'];
  if (!name || name.trim().length === 0) {
    throw new Error(
      'LAIN_CHARACTER_NAME is not set — refusing to fail-open to "Lain". ' +
      'Every per-character service must export LAIN_CHARACTER_NAME.'
    );
  }
  return name;
}

export function getImmortalIds(): Set<string> {
  return new Set(
    loadManifest().characters.filter(c => c.immortal).map(c => c.id)
  );
}

export function getMortalCharacters(): CharacterManifestEntry[] {
  return loadManifest().characters.filter(c => !c.immortal);
}

export function getWebCharacter(): CharacterManifestEntry | undefined {
  return loadManifest().characters.find(c => c.server === 'web');
}

/**
 * findings.md P2:171 — resolve a character's LLM provider chain.
 * Returns the manifest entry's `providers` when defined, otherwise the
 * baked-in `DEFAULT_PROVIDERS` chain. Callers may assume the result has
 * at least one entry (personality tier).
 */
export function getProvidersFor(characterId: string): ProviderConfig[] {
  const entry = getCharacterEntry(characterId);
  if (entry?.providers && entry.providers.length > 0) return entry.providers;
  return DEFAULT_PROVIDERS;
}

/**
 * findings.md P2:171 — assemble the `AgentConfig` that `initAgent` expects
 * from a character's manifest entry. Throws when no entry exists so the
 * single-tenant invariant in `initAgent` (and every caller) gets a loud
 * failure instead of silently running with a default-id persona.
 *
 * `workspace` is resolved from `getPaths().workspace` (i.e.
 * `$LAIN_HOME/workspace`), not the manifest's `workspace` field. The
 * manifest field is a deploy-time pointer used by `deploy/generate-services.sh`
 * to seed each character's home directory; at runtime, every service sets
 * its own `LAIN_HOME` and reads `SOUL.md` / `AGENTS.md` / `IDENTITY.md`
 * from there. Using the manifest path at runtime would break production
 * installs where `$LAIN_HOME/workspace` is absolute but the manifest
 * stores a repo-relative path.
 */
export function getAgentConfigFor(characterId: string): AgentConfig {
  const entry = getCharacterEntry(characterId);
  if (!entry) {
    throw new Error(
      `getAgentConfigFor: no characters.json entry for '${characterId}'; add one to the manifest.`,
    );
  }
  return {
    id: entry.id,
    name: entry.name,
    enabled: true,
    workspace: getPaths().workspace,
    providers: getProvidersFor(entry.id),
  };
}

export function getPeersFor(characterId: string): Array<{ id: string; name: string; url: string }> {
  return loadManifest().characters
    .filter(c => c.id !== characterId)
    .map(c => ({ id: c.id, name: c.name, url: `http://localhost:${c.port}` }));
}

/**
 * Resolve the systemd unit name for a character.
 * Uses manifest override when present; otherwise falls back to `lain-${id}`.
 */
export function getSystemdUnit(id: string): string {
  const entry = getCharacterEntry(id);
  return entry?.systemdUnit ?? `lain-${id}`;
}

/**
 * Resolve the production home directory for a character.
 * Uses manifest override when present; otherwise falls back to `/root/.lain-${id}`.
 */
export function getHomeDir(id: string): string {
  const entry = getCharacterEntry(id);
  return entry?.homeDir ?? `/root/.lain-${id}`;
}

// findings.md P2:219 — role is now shape-checked by `validateManifest`, so
// a typo'd value causes `loadManifest` to throw rather than quietly
// dropping the character from both getInhabitants() and getOracles().
// getInhabitants() ∪ getOracles() == getAllCharacters() is therefore a
// safe invariant in validated manifests.

/**
 * Returns all characters that are "inhabitants" of the town — i.e. NOT oracles.
 * Characters with no explicit role are treated as inhabitants (default).
 * Use for: telemetry aggregation, share-peers, town-event notifications.
 *
 * Characters with `role: 'oracle'` are returned by `getOracles()` instead.
 */
export function getInhabitants(): CharacterManifestEntry[] {
  return loadManifest().characters.filter(c => (c.role ?? 'inhabitant') === 'inhabitant');
}

/**
 * Returns characters with role='oracle' — observers/monitors who participate
 * in the town but are not themselves inhabitants (e.g. Dr. Claude).
 */
export function getOracles(): CharacterManifestEntry[] {
  return loadManifest().characters.filter(c => c.role === 'oracle');
}

/**
 * Returns all characters eligible for HTTP health-checks. Includes oracles —
 * they are runnable services that can go down.
 */
export function getHealthCheckTargets(): CharacterManifestEntry[] {
  return loadManifest().characters;
}

/**
 * Returns the characters a dossier-writer composes dossiers about —
 * everyone except the writer themselves.
 */
export function getDossierSubjects(writerId: string): CharacterManifestEntry[] {
  return loadManifest().characters.filter(c => c.id !== writerId);
}

/**
 * Returns all characters that can receive seeded dreams.
 */
export function getDreamSeedTargets(): CharacterManifestEntry[] {
  return loadManifest().characters;
}

/**
 * Returns {id, homeDir} for every character, using the manifest override when
 * present and falling back to the `/root/.lain-${id}` convention otherwise.
 * Used by experiments to snapshot each character's SQLite DB into a sandbox.
 */
export function getCharacterDatabases(): Array<{ id: string; homeDir: string }> {
  return loadManifest().characters.map(c => ({
    id: c.id,
    homeDir: c.homeDir ?? `/root/.lain-${c.id}`,
  }));
}
