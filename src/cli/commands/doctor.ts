/**
 * Doctor command - Diagnose issues
 */

import { access, constants } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, getPaths } from '../../config/index.js';
import { initDatabase, closeDatabase } from '../../storage/database.js';
import { getMasterKey, getAuthToken } from '../../storage/keychain.js';
import {
  displaySection,
  displaySuccess,
  displayError,
  displayWarning,
} from '../utils/prompts.js';

interface DiagnosticResult {
  name: string;
  ok: boolean;
  message: string;
}

const MIN_NODE_VERSION = 22;

/**
 * Run all diagnostics
 */
export async function doctor(): Promise<void> {
  console.log('\nLain Diagnostics\n');

  const results: DiagnosticResult[] = [];

  // Node.js version
  displaySection('Runtime');
  results.push(await checkNodeVersion());

  // Configuration
  displaySection('Configuration');
  results.push(await checkConfigFile());
  results.push(await checkConfigValid());

  // Storage
  displaySection('Storage');
  results.push(await checkDatabase());
  results.push(await checkKeychain());
  results.push(await checkAuthToken());

  // Workspace
  displaySection('Workspace');
  results.push(await checkWorkspace());

  // Town manifest + tokens (findings.md P2:90)
  displaySection('Town');
  results.push(checkCharactersManifest());
  results.push(checkInterlinkToken());
  results.push(checkOwnerToken());

  // Environment
  displaySection('Environment');
  results.push(checkApiKey());

  // Summary
  displaySection('Summary');
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;

  if (failed === 0) {
    displaySuccess(`All ${passed} checks passed`);
  } else {
    displayWarning(`${passed} passed, ${failed} failed`);
  }

  console.log('');

  // Exit with error code if any checks failed
  if (failed > 0) {
    process.exit(1);
  }
}

async function checkNodeVersion(): Promise<DiagnosticResult> {
  const version = process.versions.node;
  const major = parseInt(version.split('.')[0] ?? '0', 10);
  const ok = major >= MIN_NODE_VERSION;

  if (ok) {
    displaySuccess(`Node.js ${version}`);
  } else {
    displayError(`Node.js ${version} (requires ${MIN_NODE_VERSION}+)`);
  }

  return {
    name: 'Node.js version',
    ok,
    message: ok ? `v${version}` : `v${version} (requires ${MIN_NODE_VERSION}+)`,
  };
}

async function checkConfigFile(): Promise<DiagnosticResult> {
  const paths = getPaths();

  try {
    await access(paths.config, constants.R_OK);
    displaySuccess('Config file exists');
    return { name: 'Config file', ok: true, message: 'Found' };
  } catch {
    displayWarning('Config file not found (will use defaults)');
    return { name: 'Config file', ok: true, message: 'Not found, using defaults' };
  }
}

async function checkConfigValid(): Promise<DiagnosticResult> {
  try {
    await loadConfig();
    displaySuccess('Config is valid');
    return { name: 'Config validation', ok: true, message: 'Valid' };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    displayError(`Config invalid: ${message}`);
    return { name: 'Config validation', ok: false, message };
  }
}

async function checkDatabase(): Promise<DiagnosticResult> {
  const paths = getPaths();

  try {
    await initDatabase(paths.database);
    closeDatabase();
    displaySuccess('Database connection OK');
    return { name: 'Database', ok: true, message: 'Connected' };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    displayError(`Database error: ${message}`);
    return { name: 'Database', ok: false, message };
  }
}

async function checkKeychain(): Promise<DiagnosticResult> {
  try {
    await getMasterKey();
    displaySuccess('Keychain access OK');
    return { name: 'Keychain', ok: true, message: 'Accessible' };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    displayError(`Keychain error: ${message}`);
    return { name: 'Keychain', ok: false, message };
  }
}

async function checkAuthToken(): Promise<DiagnosticResult> {
  try {
    const token = await getAuthToken();
    if (token) {
      displaySuccess('Auth token configured');
      return { name: 'Auth token', ok: true, message: 'Configured' };
    } else {
      displayWarning('Auth token not set');
      return { name: 'Auth token', ok: true, message: 'Not set (run onboard)' };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    displayError(`Auth token error: ${message}`);
    return { name: 'Auth token', ok: false, message };
  }
}

async function checkWorkspace(): Promise<DiagnosticResult> {
  // findings.md P2:78 — the doctor workspace check used to look only at
  // `{LAIN_HOME|~/.lain}/workspace/{SOUL,AGENTS,IDENTITY}.md` — the legacy
  // single-user layout. Every healthy town install (which uses
  // `workspace/characters/<id>/`) got "Workspace not initialized",
  // misleading operators. Now: if a characters.json is present, check
  // each character's `<cwd>/<entry.workspace>/` subdir and report
  // per-character. Otherwise fall back to the legacy check.
  const { getManifestPath, getAllCharacters } = await import('../../config/characters.js');
  const manifestPath = getManifestPath();

  if (manifestPath) {
    const characters = getAllCharacters();
    if (characters.length === 0) {
      displayWarning('characters.json present but lists 0 characters');
      return { name: 'Workspace', ok: false, message: 'characters.json has empty characters[]' };
    }
    const files = ['SOUL.md', 'AGENTS.md', 'IDENTITY.md'];
    const perChar: { id: string; missing: string[] }[] = [];
    for (const c of characters) {
      const base = join(process.cwd(), c.workspace);
      const missing: string[] = [];
      for (const f of files) {
        try {
          await access(join(base, f), constants.R_OK);
        } catch {
          missing.push(f);
        }
      }
      perChar.push({ id: c.id, missing });
    }
    const broken = perChar.filter((p) => p.missing.length > 0);
    if (broken.length === 0) {
      displaySuccess(`Multi-char workspace OK (${characters.length} characters)`);
      return {
        name: 'Workspace',
        ok: true,
        message: `Multi-char town: ${characters.length} characters, all workspace files present`,
      };
    }
    for (const p of broken) {
      displayWarning(`  ${p.id}: missing ${p.missing.join(', ')}`);
    }
    return {
      name: 'Workspace',
      ok: false,
      message: `Multi-char town: ${broken.length}/${characters.length} character workspaces incomplete`,
    };
  }

  // Legacy single-user fallback — no characters.json.
  const paths = getPaths();
  const files = ['SOUL.md', 'AGENTS.md', 'IDENTITY.md'];
  const missing: string[] = [];

  for (const file of files) {
    try {
      await access(`${paths.workspace}/${file}`, constants.R_OK);
    } catch {
      missing.push(file);
    }
  }

  if (missing.length === 0) {
    displaySuccess('Workspace files present');
    return { name: 'Workspace', ok: true, message: 'All files present' };
  } else if (missing.length === files.length) {
    displayWarning('Workspace not initialized');
    return { name: 'Workspace', ok: true, message: 'Not initialized (run onboard)' };
  } else {
    displayWarning(`Missing: ${missing.join(', ')}`);
    return { name: 'Workspace', ok: false, message: `Missing: ${missing.join(', ')}` };
  }
}

function checkApiKey(): DiagnosticResult {
  // findings.md P2:90 — surface all three provider keys so operators
  // picking OpenAI or Google as primary don't chase a misleading
  // "ANTHROPIC_API_KEY not set" warning that doesn't actually apply.
  const providers = [
    { name: 'ANTHROPIC_API_KEY', value: process.env['ANTHROPIC_API_KEY'] },
    { name: 'OPENAI_API_KEY', value: process.env['OPENAI_API_KEY'] },
    { name: 'GOOGLE_API_KEY', value: process.env['GOOGLE_API_KEY'] },
  ];
  const set = providers.filter((p) => p.value && p.value.trim().length > 0);

  if (set.length > 0) {
    displaySuccess(`LLM provider keys: ${set.map((p) => p.name).join(', ')}`);
    return {
      name: 'API Key',
      ok: true,
      message: `Set: ${set.map((p) => p.name).join(', ')}`,
    };
  }
  displayWarning('No LLM provider API key set (ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY)');
  return {
    name: 'API Key',
    ok: true,
    message: 'No provider key set (at least one required for AI features)',
  };
}

function checkCharactersManifest(): DiagnosticResult {
  // Mirror findManifestPath()'s search order so doctor sees the same
  // resolution the runtime uses.
  const candidates = [
    process.env['CHARACTERS_CONFIG'],
    join(process.cwd(), 'characters.json'),
    join(process.cwd(), 'characters.json5'),
  ].filter(Boolean) as string[];
  const found = candidates.find((p) => existsSync(p));

  if (!found) {
    displayError('characters.json not found (copy characters.example.json to characters.json)');
    return {
      name: 'Characters manifest',
      ok: false,
      message: 'Not found — copy characters.example.json',
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(found, 'utf-8')) as { characters?: unknown };
    if (!Array.isArray(parsed.characters)) {
      displayError('characters.json has no `characters` array');
      return {
        name: 'Characters manifest',
        ok: false,
        message: 'Missing `characters` array',
      };
    }
    if (parsed.characters.length === 0) {
      displayWarning('characters.json has an empty characters[] — nothing will start');
      return {
        name: 'Characters manifest',
        ok: false,
        message: 'Empty characters[]',
      };
    }
    displaySuccess(`Characters manifest (${parsed.characters.length} characters)`);
    return {
      name: 'Characters manifest',
      ok: true,
      message: `${parsed.characters.length} entries`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    displayError(`characters.json invalid: ${message}`);
    return { name: 'Characters manifest', ok: false, message };
  }
}

function checkInterlinkToken(): DiagnosticResult {
  const token = process.env['LAIN_INTERLINK_TOKEN'];
  if (token && token.trim().length > 0) {
    displaySuccess('LAIN_INTERLINK_TOKEN set');
    return { name: 'Interlink token', ok: true, message: 'Set' };
  }
  displayWarning('LAIN_INTERLINK_TOKEN not set (character-to-character requests will fail)');
  return {
    name: 'Interlink token',
    ok: true,
    message: 'Not set (required for inter-character communication)',
  };
}

function checkOwnerToken(): DiagnosticResult {
  const token = process.env['LAIN_OWNER_TOKEN'];
  if (token && token.trim().length > 0) {
    displaySuccess('LAIN_OWNER_TOKEN set');
    return { name: 'Owner token', ok: true, message: 'Set' };
  }
  displayWarning('LAIN_OWNER_TOKEN not set (owner dashboard/chat access will fail)');
  return {
    name: 'Owner token',
    ok: true,
    message: 'Not set (required for owner routes)',
  };
}
