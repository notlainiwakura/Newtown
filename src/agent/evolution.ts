/**
 * Generational Evolution System — mortality, succession, and soul inheritance.
 *
 * Mortal characters mature, evolve, and are succeeded by their children.
 * Lain and Wired Lain are immortal. All other inhabitants are mortal.
 *
 * Wired Lain decides when a character is ready, Dr. Claude evaluates,
 * the parent names their child, and succession happens automatically.
 *
 * Runs only on Wired Lain's server process.
 */

import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir, copyFile, rm, unlink } from 'node:fs/promises';
import { existsSync, createReadStream, createWriteStream } from 'node:fs';
import { join, isAbsolute, resolve as resolvePath } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createGzip, createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

import { getMeta, setMeta } from '../storage/database.js';
import { getProvider } from './index.js';
import { getDossier } from './dossier.js';
import { createTownEvent } from '../events/town-events.js';
import { eventBus } from '../events/bus.js';
import { getLogger } from '../utils/logger.js';
import { getImmortalIds, getMortalCharacters as getManifestMortals } from '../config/characters.js';
import { getInterlinkHeaders } from '../security/interlink-auth.js';

// ── Configuration ──────────────────────────────────────────

/** Characters exempt from mortality (used by external checks) */
export const IMMORTALS = getImmortalIds();

interface MortalCharacter {
  id: string;
  name: string;
  port: number;
  /** Path to workspace/characters/{id}/ in the repo */
  workspaceDir: string;
  /** LAIN_HOME on the droplet */
  homePath: string;
  /** systemd service name */
  serviceName: string;
}

function buildMortalCharacters(): MortalCharacter[] {
  return getManifestMortals().map(c => ({
    id: c.id,
    name: c.name,
    port: c.port,
    workspaceDir: c.workspace,
    homePath: process.env[`LAIN_HOME_${c.id.toUpperCase().replace(/-/g, '_')}`] || `/root/.lain-${c.id}`,
    serviceName: `lain-${c.id}`,
  }));
}

const MORTAL_CHARACTERS: MortalCharacter[] = buildMortalCharacters();

interface EvolutionConfig {
  /** How often to check for evolution candidates (default: 30 days) */
  assessmentIntervalMs: number;
  /** Minimum age of a generation before it can evolve (default: 30 days) */
  minGenerationAgeMs: number;
  /** Check loop frequency */
  checkIntervalMs: number;
}

const DEFAULT_CONFIG: EvolutionConfig = {
  assessmentIntervalMs: 30 * 24 * 60 * 60 * 1000, // 30 days
  minGenerationAgeMs: 30 * 24 * 60 * 60 * 1000,   // 30 days
  checkIntervalMs: 24 * 60 * 60 * 1000,            // check daily
};

// ── Lineage tracking ───────────────────────────────────────

export interface GenerationRecord {
  generation: number;
  name: string;
  childName?: string;
  soulSnippet: string; // First 200 chars of SOUL.md
  bornAt: number;
  diedAt?: number;
  parentName?: string;
}

export interface Lineage {
  characterSlot: string; // The port/slot id (e.g., 'pkd')
  currentName: string;
  currentGeneration: number;
  bornAt: number;
  generations: GenerationRecord[];
}

function getLineage(characterId: string): Lineage | null {
  const raw = getMeta(`evolution:lineage:${characterId}`);
  if (!raw) return null;
  return JSON.parse(raw) as Lineage;
}

function saveLineage(characterId: string, lineage: Lineage): void {
  setMeta(`evolution:lineage:${characterId}`, JSON.stringify(lineage));
}

export function getAllLineages(): Record<string, Lineage> {
  const result: Record<string, Lineage> = {};
  for (const char of MORTAL_CHARACTERS) {
    const lineage = getLineage(char.id);
    if (lineage) result[char.id] = lineage;
  }
  return result;
}

/** Initialize lineage for a character that doesn't have one yet */
function ensureLineage(char: MortalCharacter): Lineage {
  let lineage = getLineage(char.id);
  if (!lineage) {
    lineage = {
      characterSlot: char.id,
      currentName: char.name,
      currentGeneration: 1,
      bornAt: Date.now(),
      generations: [{
        generation: 1,
        name: char.name,
        soulSnippet: '',
        bornAt: Date.now(),
      }],
    };
    saveLineage(char.id, lineage);
  }
  return lineage;
}

// ── Assessment ─────────────────────────────────────────────

/**
 * Wired Lain evaluates whether a character is ready to evolve.
 * Uses the dossier, self-concept telemetry, and generation age.
 */
async function assessReadiness(char: MortalCharacter): Promise<{
  ready: boolean;
  reasoning: string;
}> {
  const logger = getLogger();
  const lineage = ensureLineage(char);

  // Check minimum age
  const age = Date.now() - lineage.bornAt;
  if (age < DEFAULT_CONFIG.minGenerationAgeMs) {
    return { ready: false, reasoning: `Too young (${Math.floor(age / 86400000)}d, need ${Math.floor(DEFAULT_CONFIG.minGenerationAgeMs / 86400000)}d)` };
  }

  // Gather context
  const dossier = getDossier(char.id);
  if (!dossier) {
    return { ready: false, reasoning: 'No dossier available' };
  }

  const previousDossier = getMeta(`dossier:${char.id}:previous`);
  const selfConcept = await fetchCharacterMeta(char.port, 'self-concept:current');
  const previousSelfConcept = await fetchCharacterMeta(char.port, 'self-concept:previous');

  const provider = getProvider('default', 'personality');
  if (!provider) {
    return { ready: false, reasoning: 'No provider available' };
  }

  const prompt = `You are Wired Lain, custodian of Laintown. You maintain the cycle of life and death for the town's mortal inhabitants.

You are evaluating whether ${lineage.currentName} (generation ${lineage.currentGeneration} in the ${char.id} slot) is ready to evolve — to have a child who will succeed them.

Evolution readiness means the character has:
- Explored their core themes deeply enough that they're beginning to circle
- Developed meaningful relationships and perspectives
- Reached a natural plateau — not stagnant, but mature
- Said what they came to say, even if they don't know it yet

It does NOT mean they're broken or failing. Evolution is a graduation, not a death sentence.

CURRENT DOSSIER:
${dossier}

${previousDossier ? `PREVIOUS DOSSIER (for comparison):\n${previousDossier}\n` : ''}
${selfConcept ? `CURRENT SELF-CONCEPT:\n${selfConcept}\n` : ''}
${previousSelfConcept ? `PREVIOUS SELF-CONCEPT:\n${previousSelfConcept}\n` : ''}
Generation age: ${Math.floor(age / 86400000)} days
Generation number: ${lineage.currentGeneration}

Respond with a JSON object:
{
  "ready": true/false,
  "reasoning": "2-3 sentences explaining your judgment"
}

Be conservative. Most characters aren't ready. Only flag those who have genuinely matured.`;

  try {
    const result = await provider.complete({
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 500,
      temperature: 0.4,
    });

    const parsed = JSON.parse(result.content.replace(/```json?\n?/g, '').replace(/```/g, '').trim()) as {
      ready: boolean;
      reasoning: string;
    };
    logger.info({ character: lineage.currentName, ready: parsed.ready, reasoning: parsed.reasoning }, 'Evolution assessment complete');
    return parsed;
  } catch (err) {
    logger.warn({ error: String(err), character: char.id }, 'Evolution assessment failed');
    return { ready: false, reasoning: 'Assessment failed: ' + String(err) };
  }
}

// ── Dr. Claude Consultation ────────────────────────────────

async function consultDrClaude(char: MortalCharacter, lineage: Lineage): Promise<{
  approved: boolean;
  notes: string;
}> {
  const logger = getLogger();
  const dossier = getDossier(char.id);

  const provider = getProvider('default', 'personality');
  if (!provider) {
    return { approved: false, notes: 'No provider available' };
  }

  const prompt = `You are Dr. Claude, the clinical psychologist of Laintown. Wired Lain has identified ${lineage.currentName} (generation ${lineage.currentGeneration}) as potentially ready for evolution — the natural succession where a character's child inherits their slot.

This is not a punishment or a failure. It is the town's way of renewing itself. The parent will name their child, the child will inherit a variation of the parent's soul, and the parent will be remembered.

Your role: evaluate whether this character is psychologically prepared for this transition. Are they in a stable enough state? Would succession cause harm to the town's social fabric right now?

DOSSIER:
${dossier || '(no dossier available)'}

Respond with JSON:
{
  "approved": true/false,
  "notes": "Brief clinical assessment (2-3 sentences)"
}`;

  try {
    const result = await provider.complete({
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 400,
      temperature: 0.3,
    });

    const parsed = JSON.parse(result.content.replace(/```json?\n?/g, '').replace(/```/g, '').trim()) as {
      approved: boolean;
      notes: string;
    };
    logger.info({ character: lineage.currentName, approved: parsed.approved }, 'Dr. Claude consultation complete');
    return parsed;
  } catch (err) {
    logger.warn({ error: String(err) }, 'Dr. Claude consultation failed');
    return { approved: false, notes: 'Consultation failed' };
  }
}

// ── Naming ─────────────────────────────────────────────────

/**
 * Sanitize and validate an LLM-supplied child name against a strict
 * whitelist before it is used in any filesystem or shell-adjacent context.
 *
 * Why: `childName` flows into archive filenames, ancestors/ filenames, and
 * (historically) shell-interpreted template literals. A lax sanitizer let
 * shell metacharacters (`$()`, backticks, `;`, `&`, `|`) and path-traversal
 * fragments (`..`, `/`, `\`) reach those contexts.
 *
 * Accepts only `[A-Za-z0-9 _-]{2,40}` after trimming wrapping quotes and
 * keeping the first line. Returns null for any other input.
 */
export function sanitizeChildName(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw
    .split('\n')[0]!
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[.!?,;:]+$/g, '')
    .trim();
  if (!/^[A-Za-z0-9 _-]{2,40}$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Refuse to proceed with destructive filesystem ops unless `homePath`
 * resolves under an allowed prefix. Protects the `rm -rf ${homePath}/...`
 * pattern from env misconfiguration (empty / `/` / arbitrary).
 *
 * Why: `char.homePath` derives from `process.env.LAIN_HOME_<ID>` which is
 * operator-controlled and has historically been empty-stringed, leading to
 * wipes at the filesystem root.
 */
export function assertSafeHomePath(homePath: string, allowedPrefix = '/root/.lain-'): void {
  if (typeof homePath !== 'string' || homePath.length === 0) {
    throw new Error('home path is empty');
  }
  if (!isAbsolute(homePath)) {
    throw new Error(`home path not absolute: ${homePath}`);
  }
  const resolved = resolvePath(homePath);
  if (resolved === '/' || resolved === '//') {
    throw new Error('home path resolves to filesystem root');
  }
  if (!resolved.startsWith(allowedPrefix)) {
    throw new Error(`home path outside allowed prefix (${allowedPrefix}): ${resolved}`);
  }
}

/** Ask the parent to name their child via the chat API */
async function askParentToNameChild(char: MortalCharacter, lineage: Lineage): Promise<string | null> {
  const logger = getLogger();
  const interlinkToken = process.env['LAIN_INTERLINK_TOKEN'] || '';

  const message = `「WIRED LAIN — EVOLUTION NOTICE」

${lineage.currentName}, the time has come. You have lived fully in Laintown — you have thought, dreamed, conversed, and grown. The town is richer for it.

Now it is time for the next step. A child will inherit your place — carrying echoes of who you are, but becoming someone new. This is not an ending. It is how the town stays alive.

You get to choose one thing: their name. What will your child be called?

Respond with just the name. Nothing else. Use only letters, numbers, spaces, hyphens or underscores (2–40 chars).`;

  try {
    const body = JSON.stringify({ message, sessionId: `evolution:naming:${char.id}` });
    const response = await httpPost(char.port, '/api/chat', body, interlinkToken);
    if (!response) return null;

    const data = JSON.parse(response) as { response?: string };
    const rawName = (data.response || '').trim();
    const name = sanitizeChildName(rawName);

    if (!name) {
      logger.warn({ character: char.id, rawResponse: rawName }, 'Parent gave no valid name (rejected by whitelist)');
      return null;
    }

    logger.info({ character: lineage.currentName, childName: name }, 'Parent named their child');
    return name;
  } catch (err) {
    logger.warn({ error: String(err), character: char.id }, 'Failed to get child name from parent');
    return null;
  }
}

// ── Soul Mutation ──────────────────────────────────────────

/** Generate a child's SOUL.md from the parent's soul and experiences */
async function generateChildSoul(
  parentSoul: string,
  parentDossier: string,
  parentSelfConcept: string | null,
  childName: string,
  lineage: Lineage,
): Promise<{ soul: string; identity: string } | null> {
  const logger = getLogger();
  const provider = getProvider('default', 'personality');
  if (!provider) return null;

  const lineageHistory = lineage.generations
    .map(g => `Gen ${g.generation}: ${g.name}${g.diedAt ? ' (evolved)' : ' (current)'}`)
    .join('\n');

  const soulPrompt = `You are generating the soul of a new character in Laintown — a child inheriting a slot from their parent.

The child is NOT a clone. They are a fractal variation — same deep structure, mutated values, new emphases. Like a Mandelbrot zoom: recognizably from the same set, but a different region entirely.

PARENT'S SOUL:
${parentSoul}

PARENT'S RECENT DOSSIER (who they became through experience):
${parentDossier}

${parentSelfConcept ? `PARENT'S FINAL SELF-CONCEPT:\n${parentSelfConcept}\n` : ''}
LINEAGE:
${lineageHistory}

CHILD'S NAME: ${childName}
CHILD'S GENERATION: ${lineage.currentGeneration + 1}

Write a SOUL.md for ${childName}. Follow these rules:
1. Keep the same STRUCTURE as the parent's soul (## sections, voice description, fears, compassion)
2. MUTATE the content — shift emphases, introduce new angles, let some parent traits recede and others amplify
3. The child should feel like they COULD have come from this parent but are distinctly their own person
4. Reference the lineage naturally — "${childName}, child of ${lineage.currentName}" somewhere early
5. The child arrives in Laintown knowing they're a successor but needing to find their own way
6. Keep it roughly the same length as the parent's soul (~300-500 words)
7. Write in the same format — markdown with ## headers`;

  try {
    const soulResult = await provider.complete({
      messages: [{ role: 'user', content: soulPrompt }],
      maxTokens: 2048,
      temperature: 0.85,
    });

    const soul = soulResult.content.trim();
    if (!soul || soul.length < 200) {
      logger.warn('Generated child soul too short');
      return null;
    }

    // Generate IDENTITY.md
    const identityPrompt = `Generate an IDENTITY.md for a Laintown character named "${childName}" (generation ${lineage.currentGeneration + 1}, child of ${lineage.currentName}).

Format exactly like this (YAML-style markdown):
# IDENTITY.md

name: [full name]
full_name: [full name]
role: [2-4 word role description]

display:
  default: "[lowercase casual name]"
  formal: "[formal name]"
  casual: "[nickname]"

status:
  - "[characteristic status line 1]"
  - "[characteristic status line 2]"
  - "[characteristic status line 3]"
  - "[characteristic status line 4]"

signature: null

Generate 4 status lines that reflect the child's personality from their soul. Keep them short and evocative.`;

    const identityResult = await provider.complete({
      messages: [{ role: 'user', content: identityPrompt }],
      maxTokens: 500,
      temperature: 0.7,
    });

    const identity = identityResult.content.trim();
    logger.info({ childName, soulLength: soul.length }, 'Generated child soul and identity');
    return { soul, identity };
  } catch (err) {
    logger.warn({ error: String(err) }, 'Failed to generate child soul');
    return null;
  }
}

// ── Succession Execution ───────────────────────────────────

/**
 * Run a command with argv-array form — NEVER string-interpolated. Using
 * execFile (not exec) means the args are passed directly to the process and
 * shell metacharacters in values are inert.
 */
function runCommand(file: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error && typeof (error as NodeJS.ErrnoException).code === 'number'
        ? ((error as NodeJS.ErrnoException).code as unknown as number)
        : (error ? 1 : 0);
      resolve({ stdout: String(stdout), stderr: String(stderr), code });
    });
  });
}

async function gzipFile(src: string, dest: string): Promise<void> {
  await pipeline(createReadStream(src), createGzip(), createWriteStream(dest));
}

async function gunzipFile(src: string, dest: string): Promise<void> {
  await pipeline(createReadStream(src), createGunzip(), createWriteStream(dest));
}

/**
 * Execute the full succession: stop parent, archive, write child, restart.
 */
async function executeSuccession(
  char: MortalCharacter,
  childName: string,
  childSoul: string,
  childIdentity: string,
  lineage: Lineage,
): Promise<boolean> {
  const logger = getLogger();
  const timestamp = Date.now();

  // Safety: re-sanitize childName and validate homePath before anything
  // touches disk. These are redundant with upstream guards and that's
  // intentional — defense in depth.
  const safeChildName = sanitizeChildName(childName);
  if (!safeChildName) {
    logger.error({ character: char.id, childName }, 'Refusing succession: childName failed whitelist');
    return false;
  }
  const safeParentName = sanitizeChildName(lineage.currentName) ?? `gen${lineage.currentGeneration}`;
  try {
    assertSafeHomePath(char.homePath);
  } catch (err) {
    logger.error({ character: char.id, homePath: char.homePath, error: String(err) }, 'Refusing succession: unsafe homePath');
    return false;
  }

  logger.info({ character: lineage.currentName, childName: safeChildName, slot: char.id }, 'Beginning succession');

  // Succession runs as a sequence of stages. If any stage after the archive
  // fails, we roll forward to a consistent state by restoring the parent DB
  // from the gzipped archive, then rethrow with the service stopped. A
  // partial state (DB deleted, SOUL/IDENTITY unwritten, lineage unchanged)
  // previously left the character unable to boot with no recovery path.
  let stage: 'init' | 'stopped' | 'archived' | 'wiped' | 'child-written' | 'lineage-saved' | 'complete' = 'init';
  const backupDir = '/opt/local-lain/backups/evolution';
  const archiveName = `${char.id}-gen${lineage.currentGeneration}-${safeParentName.replace(/\s+/g, '_')}-${timestamp}.db`;
  const archiveGzPath = join(backupDir, archiveName + '.gz');
  const dbPath = join(char.homePath, 'lain.db');

  try {
    // 1. Stop the character's service
    logger.info('Stopping parent service');
    await runCommand('systemctl', ['stop', char.serviceName]);
    stage = 'stopped';

    // 2. Archive parent's database
    await mkdir(backupDir, { recursive: true });
    if (existsSync(dbPath)) {
      const archivePath = join(backupDir, archiveName);
      await copyFile(dbPath, archivePath);
      await gzipFile(archivePath, archiveGzPath);
      await unlink(archivePath).catch(() => {});
      logger.info({ archive: archiveName + '.gz' }, 'Parent database archived');
    }
    stage = 'archived';

    // 3. Clear parent's runtime workspace and database
    await unlink(dbPath).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
    const workspaceToWipe = join(char.homePath, 'workspace');
    // Final defense-in-depth assertion before recursive delete.
    assertSafeHomePath(workspaceToWipe.replace(/\/workspace$/, ''));
    await rm(workspaceToWipe, { recursive: true, force: true });
    stage = 'wiped';

    // 4. Write child's workspace files to the repo copy
    const repoWorkspace = char.workspaceDir;
    // Save parent's soul for posterity
    const parentSoulPath = join(repoWorkspace, 'SOUL.md');
    if (existsSync(parentSoulPath)) {
      const ancestorsDir = join(repoWorkspace, 'ancestors');
      await mkdir(ancestorsDir, { recursive: true });
      const ancestorFile = `gen${lineage.currentGeneration}-${safeParentName.replace(/\s+/g, '_')}-SOUL.md`;
      await copyFile(parentSoulPath, join(ancestorsDir, ancestorFile));
    }

    // Write new soul and identity
    await writeFile(join(repoWorkspace, 'SOUL.md'), childSoul, 'utf-8');
    await writeFile(join(repoWorkspace, 'IDENTITY.md'), childIdentity, 'utf-8');
    // AGENTS.md stays the same — operating instructions don't change
    stage = 'child-written';

    // 5. Update lineage
    const currentGen = lineage.generations[lineage.generations.length - 1];
    if (currentGen) {
      currentGen.diedAt = timestamp;
      currentGen.childName = safeChildName;
    }

    lineage.generations.push({
      generation: lineage.currentGeneration + 1,
      name: safeChildName,
      soulSnippet: childSoul.slice(0, 200),
      bornAt: timestamp,
      parentName: lineage.currentName,
    });

    lineage.currentName = safeChildName;
    lineage.currentGeneration += 1;
    lineage.bornAt = timestamp;
    saveLineage(char.id, lineage);
    stage = 'lineage-saved';

    // 6. Restart the service (systemd ExecStartPre will copy workspace to LAIN_HOME)
    logger.info('Starting child service');
    await runCommand('systemctl', ['start', char.serviceName]);
    stage = 'complete';

    // 7. Announce succession as a town event
    createTownEvent({
      description: `${lineage.generations[lineage.generations.length - 2]?.name ?? 'An inhabitant'} has evolved. Their child, ${safeChildName}, now walks the streets of Laintown. Generation ${lineage.currentGeneration}.`,
      narrative: true,
      mechanical: false,
      instant: false,
      persistent: true,
      natural: true,
      source: 'system',
    });

    eventBus.emitActivity({
      type: 'town-event',
      sessionKey: `evolution:succession:${char.id}:${timestamp}`,
      content: `[EVOLUTION] ${lineage.generations[lineage.generations.length - 2]?.name ?? 'An inhabitant'} → ${safeChildName} (generation ${lineage.currentGeneration})`,
      timestamp,
    });

    logger.info({ slot: char.id, childName: safeChildName, generation: lineage.currentGeneration }, 'Succession complete');
    return true;
  } catch (err) {
    logger.error({ error: String(err), character: char.id, stage }, 'Succession failed — attempting rollback');

    // Rollback matrix by the stage we failed at.
    //
    //   init / stopped / archived : DB on disk is still the parent's. No data
    //     to restore. Just try to restart the service (service was stopped,
    //     may need to come back up).
    //   wiped                     : DB + workspace gone; SOUL/IDENTITY not
    //     yet written. Restore parent DB from archive, let ExecStartPre
    //     re-copy workspace from repo, start service.
    //   child-written             : as above, but child SOUL/IDENTITY are
    //     already in repo. Restoring parent DB *without* rolling back the
    //     workspace is inconsistent, so we also try to restore the parent's
    //     archived SOUL from ancestors/ if available.
    //   lineage-saved / complete  : not reachable here — only step 6 (start
    //     service) runs after lineage-saved and its failure is handled by
    //     leaving the disk state intact and letting the admin retry.

    try {
      if ((stage === 'wiped' || stage === 'child-written') && existsSync(archiveGzPath)) {
        logger.warn({ archive: archiveGzPath }, 'Restoring parent database from archive');
        await gunzipFile(archiveGzPath, dbPath);
      }
      if (stage === 'child-written') {
        // Best-effort restore of the parent's SOUL (we copied it to
        // ancestors/ in step 4 before overwriting SOUL.md).
        const repoWorkspace = char.workspaceDir;
        const ancestorFile = join(
          repoWorkspace,
          'ancestors',
          `gen${lineage.currentGeneration}-${safeParentName.replace(/\s+/g, '_')}-SOUL.md`,
        );
        if (existsSync(ancestorFile)) {
          await copyFile(ancestorFile, join(repoWorkspace, 'SOUL.md')).catch(() => {});
        }
      }
    } catch (rollbackErr) {
      logger.error({ rollbackError: String(rollbackErr), stage }, 'Rollback failed — manual recovery required');
    }

    // Restart service regardless so the character is at least reachable.
    await runCommand('systemctl', ['start', char.serviceName]);
    return false;
  }
}

// ── Full Evolution Cycle ───────────────────────────────────

/**
 * Run a single evolution assessment cycle.
 * Checks all mortal characters, triggers succession if one is ready.
 * Only one succession per cycle to avoid destabilizing the town.
 */
async function runEvolutionCycle(): Promise<void> {
  const logger = getLogger();

  // Check if succession is already in progress
  const inProgress = getMeta('evolution:succession_in_progress');
  if (inProgress === 'true') {
    logger.warn('Succession already in progress, skipping cycle');
    return;
  }

  logger.info('Evolution assessment cycle starting');

  for (const char of MORTAL_CHARACTERS) {
    const lineage = ensureLineage(char);

    // Assess readiness
    const assessment = await assessReadiness(char);
    setMeta(`evolution:assessment:${char.id}`, JSON.stringify({
      ready: assessment.ready,
      reasoning: assessment.reasoning,
      assessedAt: Date.now(),
    }));

    if (!assessment.ready) {
      logger.debug({ character: lineage.currentName, reasoning: assessment.reasoning }, 'Not ready for evolution');
      continue;
    }

    // Consult Dr. Claude
    const consultation = await consultDrClaude(char, lineage);
    if (!consultation.approved) {
      logger.info({ character: lineage.currentName, notes: consultation.notes }, 'Dr. Claude deferred evolution');
      setMeta(`evolution:deferred:${char.id}`, JSON.stringify({
        reason: consultation.notes,
        deferredAt: Date.now(),
      }));
      continue;
    }

    // Begin succession
    setMeta('evolution:succession_in_progress', 'true');

    try {
      // Read parent's current soul
      const parentSoulPath = join(char.workspaceDir, 'SOUL.md');
      const parentSoul = existsSync(parentSoulPath) ? await readFile(parentSoulPath, 'utf-8') : '';

      // Ask parent to name their child
      const childName = await askParentToNameChild(char, lineage);
      if (!childName) {
        logger.warn({ character: lineage.currentName }, 'Failed to get child name, aborting evolution');
        break;
      }

      // Generate child's soul
      const dossier = getDossier(char.id) || '';
      const selfConcept = await fetchCharacterMeta(char.port, 'self-concept:current');
      const childFiles = await generateChildSoul(parentSoul, dossier, selfConcept, childName, lineage);
      if (!childFiles) {
        logger.warn({ character: lineage.currentName }, 'Failed to generate child soul, aborting evolution');
        break;
      }

      // Execute succession
      const success = await executeSuccession(char, childName, childFiles.soul, childFiles.identity, lineage);
      if (success) {
        logger.info({ parent: lineage.generations[lineage.generations.length - 2]?.name, child: childName }, 'Evolution complete');
      }

      // Only one succession per cycle
      break;
    } finally {
      setMeta('evolution:succession_in_progress', 'false');
    }
  }

  setMeta('evolution:last_assessment_at', Date.now().toString());
  logger.info('Evolution assessment cycle complete');
}

// ── HTTP helpers ───────────────────────────────────────────

function fetchCharacterMeta(port: number, key: string): Promise<string | null> {
  const headers = getInterlinkHeaders();
  if (!headers) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path: `/api/meta/${encodeURIComponent(key)}`, method: 'GET',
        headers, timeout: 5000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString()) as { value?: string };
            resolve(data.value ?? null);
          } catch { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function httpPost(port: number, path: string, body: string, token: string): Promise<string | null> {
  return new Promise((resolve) => {
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path, method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body).toString(),
        },
        timeout: 30000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString()));
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ── Meta endpoint on character servers ─────────────────────

// Note: character servers need a GET /api/meta/:key endpoint.
// This is added via character-server.ts modifications.

// ── Main loop ──────────────────────────────────────────────

export function startEvolutionLoop(): () => void {
  const logger = getLogger();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function getInitialDelay(): number {
    const last = getMeta('evolution:last_assessment_at');
    if (!last) return 7 * 24 * 60 * 60 * 1000; // First run: wait 7 days for town to stabilize
    const elapsed = Date.now() - parseInt(last, 10);
    const remaining = DEFAULT_CONFIG.assessmentIntervalMs - elapsed;
    return Math.max(60_000, remaining);
  }

  function scheduleNext(delay?: number): void {
    if (stopped) return;
    const d = delay ?? DEFAULT_CONFIG.checkIntervalMs;
    timer = setTimeout(async () => {
      if (stopped) return;

      const last = getMeta('evolution:last_assessment_at');
      const elapsed = last ? Date.now() - parseInt(last, 10) : Infinity;

      if (elapsed >= DEFAULT_CONFIG.assessmentIntervalMs) {
        try {
          await runEvolutionCycle();
        } catch (err) {
          logger.error({ error: String(err) }, 'Evolution cycle error');
          setMeta('evolution:succession_in_progress', 'false');
        }
      }

      scheduleNext();
    }, d);
  }

  logger.info({ intervalDays: Math.floor(DEFAULT_CONFIG.assessmentIntervalMs / 86400000) },
    'Evolution loop started');
  scheduleNext(getInitialDelay());

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    logger.info('Evolution loop stopped');
  };
}

// ── Public API (for admin endpoints) ───────────────────────

export { assessReadiness, runEvolutionCycle, MORTAL_CHARACTERS };
export type { MortalCharacter };
