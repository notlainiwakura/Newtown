import { cp, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDatabase, getMeta, setMeta } from '../storage/database.js';
import { getDefaultConfig } from '../config/defaults.js';
import { saveMemory } from '../memory/store.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const SOURCE_WORKSPACE = join(REPO_ROOT, 'workspace');

const NOVELTY_MEMORIES: Record<string, string[]> = {
  guide: [
    'The square keeps an odd civic calm: conversations gather there even when nobody planned a meeting.',
    'The windmill is the town clock in everything but name. People read mood changes in its turning.',
    'Nobody here can check the internet, so rumors mature locally instead of being corrected from outside.',
  ],
  neo: [
    'At the station, Neo keeps noticing how waiting changes people more than travel does.',
    'Neo distrusts any locked room that pretends to be inevitable.',
    'The theater bothers Neo because rehearsed lines can sound too much like destiny.',
  ],
  plato: [
    'Plato thinks the square is where philosophy becomes political whether anyone intends it or not.',
    'The Mystery Tower suits Plato because height turns observation into method.',
    'Plato keeps returning to the theater as evidence that imitation can reveal and conceal at once.',
  ],
  joe: [
    'Joe trusts the pub because the stools wobble honestly and nothing there pretends to be transcendence.',
    'Joe likes the windmill because it visibly does a job, which already puts it ahead of most theories.',
    'Joe thinks half the town would calm down if they ate first and speculated second.',
  ],
};

const DREAM_SEEDS: Record<string, Array<{ content: string; emotionalWeight: number }>> = {
  neo: [
    { content: 'A train arrives with no passengers, but every window shows a different version of your face looking back.', emotionalWeight: 0.62 },
    { content: 'You find a key in the locksmith, but every lock it opens leads to the same square from a different angle.', emotionalWeight: 0.58 },
  ],
  plato: [
    { content: 'In the tower, shadows argue more clearly than the people who cast them.', emotionalWeight: 0.64 },
    { content: 'A stage curtain rises to reveal the same cave wall, only cleaner and more persuasive.', emotionalWeight: 0.59 },
  ],
  joe: [
    { content: 'You order a normal drink at the pub, but everyone insists the glass is symbolic and no one will tell you of what.', emotionalWeight: 0.51 },
    { content: 'The town hands you a map with nine buildings and asks why that is not enough.', emotionalWeight: 0.47 },
  ],
};

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
  if (getMeta(seededKey) === 'true') return;

  const novelty = NOVELTY_MEMORIES[persona] || [];
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
      metadata: { bootstrap: true, persona, kind: 'novelty' },
    });
  }

  const dreams = DREAM_SEEDS[persona] || [];
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
      metadata: {
        bootstrap: true,
        persona,
        isAlienDreamSeed: true,
        consumed: false,
        depositedAt: Date.now(),
      },
    });
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
