import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDatabase, getMeta, setMeta } from '../storage/database.js';
import { getDefaultConfig } from '../config/defaults.js';
import { saveMemory, saveMessage } from '../memory/store.js';
import {
  DREAM_SEEDS,
  INITIAL_SELF_CONCEPTS,
  RESIDENT_CHATS,
  NOVELTY_MEMORIES,
  RESIDENT_LETTERS,
} from './bootstrap-data.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const SOURCE_WORKSPACE = join(REPO_ROOT, 'workspace');

function parseArgs(): Record<string, string> {
  const args = process.argv.slice(2);
  const result: Record<string, string> = {};

  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    const value = args[i + 1];
    if (key?.startsWith('--') && value) {
      result[key.slice(2)] = value;
    }
  }

  return result;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

async function copyWorkspaceTemplate(targetWorkspace: string, persona: string): Promise<void> {
  await ensureDir(targetWorkspace);
  await ensureDir(join(targetWorkspace, 'offerings'));

  const offerings = join(SOURCE_WORKSPACE, 'offerings');
  if (await pathExists(offerings)) {
    const files = await readdir(offerings);
    for (const file of files) {
      await cp(join(offerings, file), join(targetWorkspace, 'offerings', file), { force: true, recursive: true });
    }
  }

  if (persona === 'guide') {
    await cp(join(SOURCE_WORKSPACE, 'SOUL.md'), join(targetWorkspace, 'SOUL.md'), { force: true });
    await cp(join(SOURCE_WORKSPACE, 'AGENTS.md'), join(targetWorkspace, 'AGENTS.md'), { force: true });
    await cp(join(SOURCE_WORKSPACE, 'IDENTITY.md'), join(targetWorkspace, 'IDENTITY.md'), { force: true });
    return;
  }

  const personaDir = join(SOURCE_WORKSPACE, 'characters', persona);
  await cp(join(personaDir, 'SOUL.md'), join(targetWorkspace, 'SOUL.md'), { force: true });
  await cp(join(personaDir, 'AGENTS.md'), join(targetWorkspace, 'AGENTS.md'), { force: true });
  await cp(join(personaDir, 'IDENTITY.md'), join(targetWorkspace, 'IDENTITY.md'), { force: true });
}

async function seedResidentMemories(persona: string): Promise<void> {
  const seededKey = `bootstrap:${persona}:seeded`;
  const legacySeeded = getMeta(seededKey) === 'true';
  const noveltySeeded = legacySeeded || getMeta(`bootstrap:${persona}:novelty_seeded`) === 'true';
  const dreamsSeeded = legacySeeded || getMeta(`bootstrap:${persona}:dreams_seeded`) === 'true';
  const selfSeeded = getMeta(`bootstrap:${persona}:self_seeded`) === 'true';
  const lettersSeeded = getMeta(`bootstrap:${persona}:letters_seeded`) === 'true';
  const chatsSeeded = getMeta(`bootstrap:${persona}:chats_seeded`) === 'true';

  const novelty = NOVELTY_MEMORIES[persona] || [];
  if (!noveltySeeded) {
    for (const content of novelty) {
      await saveMemory({
        sessionKey: `bootstrap:${persona}:novelty`,
        userId: null,
        content,
        memoryType: 'episode',
        importance: 0.32,
        emotionalWeight: 0.16,
        relatedTo: null,
        sourceMessageId: null,
        skipEmbedding: true,
        metadata: { bootstrap: true, persona, kind: 'novelty' },
      });
    }
    setMeta(`bootstrap:${persona}:novelty_seeded`, 'true');
  }

  const dreams = DREAM_SEEDS[persona] || [];
  if (!dreamsSeeded) {
    for (const dream of dreams) {
      await saveMemory({
        sessionKey: 'alien:dream-seed',
        userId: null,
        content: dream.content,
        memoryType: 'episode',
        importance: 0.4,
        emotionalWeight: dream.emotionalWeight,
        relatedTo: null,
        sourceMessageId: null,
        skipEmbedding: true,
        metadata: {
          bootstrap: true,
          persona,
          isAlienDreamSeed: true,
          consumed: false,
          depositedAt: Date.now(),
        },
      });
    }
    setMeta(`bootstrap:${persona}:dreams_seeded`, 'true');
  }

  if (!selfSeeded) {
    const existingSelfConcept = getMeta('self-concept:current');
    const selfConcept = INITIAL_SELF_CONCEPTS[persona];
    if (!existingSelfConcept && selfConcept) {
      const now = Date.now();
      await saveMemory({
        sessionKey: 'self-concept:synthesis',
        userId: null,
        content: selfConcept,
        memoryType: 'episode',
        importance: 0.58,
        emotionalWeight: 0.24,
        relatedTo: null,
        sourceMessageId: null,
        skipEmbedding: true,
        metadata: {
          bootstrap: true,
          persona,
          kind: 'self-concept',
          synthesizedAt: now,
        },
      });
      setMeta('self-concept:current', selfConcept);
      setMeta('self-concept:last_synthesis_at', now.toString());
      setMeta('self-concept:cycle_count', '1');
      await mkdir(join(process.env['LAIN_HOME']!, '.private_journal'), { recursive: true });
      const markdown = `# Self-Concept\n\n*Last updated: ${new Date(now).toISOString()}*\n\n${selfConcept}\n`;
      await writeFile(join(process.env['LAIN_HOME']!, '.private_journal', 'self-concept.md'), markdown, 'utf-8');
    }
    setMeta(`bootstrap:${persona}:self_seeded`, 'true');
  }

  if (!lettersSeeded) {
    const letters = RESIDENT_LETTERS[persona] || [];
    for (const letter of letters) {
      await saveMemory({
        sessionKey: `letter:${persona}:${letter.to}:bootstrap`,
        userId: null,
        content: letter.content,
        memoryType: 'episode',
        importance: 0.48,
        emotionalWeight: 0.22,
        relatedTo: null,
        sourceMessageId: null,
        skipEmbedding: true,
        metadata: {
          bootstrap: true,
          persona,
          kind: 'letter',
          from: persona,
          to: letter.to,
        },
      });
    }
    setMeta(`bootstrap:${persona}:letters_seeded`, 'true');
  }

  if (!chatsSeeded) {
    const chatSession = `${persona}:bootstrap-intro`;
    const chats = RESIDENT_CHATS[persona] || [];
    let offset = 0;
    for (const message of chats) {
      saveMessage({
        sessionKey: chatSession,
        userId: null,
        role: message.role,
        content: message.content,
        timestamp: Date.now() + offset,
        metadata: {
          bootstrap: true,
          persona,
          kind: 'chat',
        },
      });
      offset += 1;
    }
    setMeta(`bootstrap:${persona}:chats_seeded`, 'true');
  }

  setMeta(seededKey, 'true');
}

async function cleanWorkspaceRoot(targetWorkspace: string): Promise<void> {
  const allowed = new Set(['SOUL.md', 'AGENTS.md', 'IDENTITY.md', 'offerings']);
  if (!(await pathExists(targetWorkspace))) return;

  const entries = await readdir(targetWorkspace);
  for (const entry of entries) {
    if (!allowed.has(entry)) {
      await rm(join(targetWorkspace, entry), { recursive: true, force: true });
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  const home = args.home;
  const persona = args.persona || 'guide';

  if (!home) {
    throw new Error('Missing --home argument');
  }

  process.env.LAIN_HOME = home;

  const workspacePath = join(home, 'workspace');
  await ensureDir(dirname(workspacePath));
  await cleanWorkspaceRoot(workspacePath);
  await copyWorkspaceTemplate(workspacePath, persona);

  const defaults = getDefaultConfig();
  await initDatabase(join(home, 'newtown.db'), defaults.security.keyDerivation);

  if (persona !== 'guide') {
    await seedResidentMemories(persona);
  }

  const identity = await readFile(join(workspacePath, 'IDENTITY.md'), 'utf-8');
  console.log(`bootstrapped ${persona} home at ${home}`);
  console.log(identity.split('\n')[0] || persona);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
