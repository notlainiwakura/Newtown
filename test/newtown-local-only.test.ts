import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { initDatabase, closeDatabase } from '../src/storage/database.js';
import { getDefaultConfig } from '../src/config/defaults.js';
import { saveMemory, getAllMemories } from '../src/memory/store.js';
import { execute, getMeta, setMeta } from '../src/storage/database.js';
import { purgeLocalOnlyResearchArtifacts } from '../src/memory/local-only.js';
import { isResearchEnabled } from '../src/config/features.js';
import { registerCharacterTools } from '../src/agent/character-tools.js';
import { getToolDefinitions, unregisterTool } from '../src/agent/tools.js';

describe('Newtown local-only mode', () => {
  const originalEnv = process.env['ENABLE_RESEARCH'];
  const originalHome = process.env['LAIN_HOME'];
  const tmpHome = join(process.cwd(), 'tmp-test-local-only');

  beforeEach(async () => {
    rmSync(tmpHome, { recursive: true, force: true });
    mkdirSync(tmpHome, { recursive: true });
    process.env['LAIN_HOME'] = tmpHome;
    process.env['ENABLE_RESEARCH'] = '0';
    await initDatabase(join(tmpHome, 'newtown.db'), getDefaultConfig().security.keyDerivation);
  });

  afterEach(() => {
    unregisterTool('research_request');
    closeDatabase();
    rmSync(tmpHome, { recursive: true, force: true });
    if (originalEnv === undefined) delete process.env['ENABLE_RESEARCH'];
    else process.env['ENABLE_RESEARCH'] = originalEnv;
    if (originalHome === undefined) delete process.env['LAIN_HOME'];
    else process.env['LAIN_HOME'] = originalHome;
    vi.restoreAllMocks();
  });

  it('treats ENABLE_RESEARCH=0 as local-only and unset as legacy-enabled', () => {
    expect(isResearchEnabled({ ENABLE_RESEARCH: '0' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isResearchEnabled({ ENABLE_RESEARCH: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isResearchEnabled({} as NodeJS.ProcessEnv)).toBe(true);
  });

  it('does not register research_request when research is disabled', () => {
    unregisterTool('research_request');
    registerCharacterTools('neo', 'Neo', 'http://localhost:3000', []);
    const names = getToolDefinitions().map((tool) => tool.name);
    expect(names).not.toContain('research_request');
  });

  it('purges leftover research artifacts from local-only databases', async () => {
    await saveMemory({
      sessionKey: 'curiosity:offline',
      userId: null,
      content: 'I asked Wired Lain: "What is the Matrix?" — it stayed with me',
      memoryType: 'episode',
      importance: 0.5,
      emotionalWeight: 0.4,
      relatedTo: null,
      sourceMessageId: null,
      metadata: { type: 'research_request' },
      skipEmbedding: true,
    });
    await saveMemory({
      sessionKey: 'research:received:req-1',
      userId: null,
      content: 'Neo asked me to research: "What is the Matrix?"',
      memoryType: 'episode',
      importance: 0.5,
      emotionalWeight: 0.4,
      relatedTo: null,
      sourceMessageId: null,
      metadata: { type: 'research_received' },
      skipEmbedding: true,
    });
    execute(
      `INSERT INTO messages (id, session_key, role, content, timestamp, metadata)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['msg-1', 'research:received:req-1', 'assistant', 'Wired Lain said hello', Date.now(), '{}']
    );
    setMeta('curiosity-offline:pending_questions_v2', JSON.stringify([{ question: 'What is the Matrix?', submittedAt: Date.now() }]));

    const result = purgeLocalOnlyResearchArtifacts();

    expect(result.memoriesRemoved).toBeGreaterThanOrEqual(2);
    expect(result.messagesRemoved).toBeGreaterThanOrEqual(1);
    expect(result.metaRemoved).toBeGreaterThanOrEqual(1);
    expect(getAllMemories().length).toBe(0);
    expect(getMeta('curiosity-offline:pending_questions_v2')).toBeFalsy();
  });
});
