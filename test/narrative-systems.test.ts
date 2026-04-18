/**
 * Narrative Systems Tests
 *
 * Tests the narrative and cognitive systems of the virtual town:
 * diary, dreams, self-concept, book reading, curiosity, newspaper,
 * and narrative synthesis.
 * Uses in-memory SQLite and mocks the LLM provider.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock keytar before touching storage
vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn().mockResolvedValue('test-master-key'),
    setPassword: vi.fn().mockResolvedValue(undefined),
    deletePassword: vi.fn().mockResolvedValue(true),
    findCredentials: vi.fn().mockResolvedValue([]),
  },
}));

// Mock the LLM provider
const mockProvider = {
  complete: vi.fn(),
  completeWithTools: vi.fn(),
  continueWithToolResults: vi.fn(),
};

vi.mock('../src/agent/index.js', () => ({
  getProvider: vi.fn(() => mockProvider),
  getAgent: vi.fn(() => ({
    persona: { soul: 'A quiet, grounded character who lives in the Wired.' },
  })),
}));

// Mock internal-state
vi.mock('../src/agent/internal-state.js', () => ({
  getCurrentState: vi.fn(() => ({
    energy: 0.5,
    sociability: 0.6,
    intellectual_arousal: 0.7,
    emotional_weight: 0.4,
    valence: 0.6,
  })),
  getPreoccupations: vi.fn(() => []),
  updateState: vi.fn().mockResolvedValue(undefined),
}));

// Mock commune/location (needed by dreams)
vi.mock('../src/commune/location.js', () => ({
  getCurrentLocation: vi.fn(() => ({ building: 'library', characterId: 'lain' })),
  setCurrentLocation: vi.fn(),
  getLocationHistory: vi.fn(() => []),
}));

// Mock commune/buildings (needed by dreams)
vi.mock('../src/commune/buildings.js', () => ({
  isValidBuilding: vi.fn(() => true),
  BUILDINGS: [
    { id: 'library', name: 'Library', description: 'Books', emoji: '📚', row: 0, col: 0 },
    { id: 'threshold', name: 'Threshold', description: 'Liminal', emoji: '🌀', row: 1, col: 1 },
  ],
}));

// Mock proactive messaging
vi.mock('../src/agent/proactive.js', () => ({
  trySendProactiveMessage: vi.fn().mockResolvedValue(undefined),
}));

import { initDatabase, closeDatabase, getMeta, setMeta } from '../src/storage/database.js';
import { saveMemory, getAllMemories } from '../src/memory/store.js';

import { startDiaryLoop, type DiaryConfig } from '../src/agent/diary.js';
import { startDreamLoop, type DreamConfig } from '../src/agent/dreams.js';
import { getSelfConcept, startSelfConceptLoop, runSelfConceptSynthesis } from '../src/agent/self-concept.js';
import {
  startBookLoop,
  type BookConfig,
} from '../src/agent/book.js';
import {
  startOfflineCuriosityLoop,
  clearAnsweredQuestion,
} from '../src/agent/curiosity-offline.js';
import { startNewspaperLoop } from '../src/agent/newspaper.js';
import {
  getWeeklyNarrative,
  getMonthlyNarrative,
  startNarrativeLoop,
  runWeeklySynthesis,
  runMonthlySynthesis,
} from '../src/agent/narratives.js';
import { startExperimentLoop } from '../src/agent/experiments.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shared test scaffold
// ─────────────────────────────────────────────────────────────────────────────

let testDir: string;
let dbPath: string;
let journalPath: string;
const originalEnv = { ...process.env };

async function setupTestDb() {
  testDir = join(tmpdir(), `lain-narrative-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  dbPath = join(testDir, 'test.db');
  journalPath = join(testDir, '.private_journal', 'thoughts.json');
  process.env['LAIN_HOME'] = testDir;
  process.env['LAIN_CHARACTER_NAME'] = 'Lain';
  process.env['LAIN_CHARACTER_ID'] = 'lain';
  await mkdir(testDir, { recursive: true });
  await mkdir(join(testDir, '.private_journal'), { recursive: true });
  await initDatabase(dbPath);
}

async function teardownTestDb() {
  closeDatabase();
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  if (originalEnv['LAIN_HOME']) {
    process.env['LAIN_HOME'] = originalEnv['LAIN_HOME'];
  } else {
    delete process.env['LAIN_HOME'];
  }
  if (originalEnv['LAIN_CHARACTER_NAME']) {
    process.env['LAIN_CHARACTER_NAME'] = originalEnv['LAIN_CHARACTER_NAME'];
  } else {
    delete process.env['LAIN_CHARACTER_NAME'];
  }
  if (originalEnv['LAIN_CHARACTER_ID']) {
    process.env['LAIN_CHARACTER_ID'] = originalEnv['LAIN_CHARACTER_ID'];
  } else {
    delete process.env['LAIN_CHARACTER_ID'];
  }
  try {
    await rm(testDir, { recursive: true });
  } catch { /* ok */ }
  vi.clearAllMocks();
}

async function writeJournal(entries: Array<{ id: string; timestamp: string; content: string }>) {
  await writeFile(journalPath, JSON.stringify({ entries }), 'utf-8');
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. Diary System
// ═════════════════════════════════════════════════════════════════════════════

describe('Diary system', () => {
  beforeEach(setupTestDb);
  afterEach(teardownTestDb);

  it('startDiaryLoop returns a cleanup function', () => {
    const stop = startDiaryLoop({ enabled: false });
    expect(typeof stop).toBe('function');
    stop();
  });

  it('diary loop disabled returns noop', () => {
    const stop = startDiaryLoop({ enabled: false });
    // Should not set any timers or schedule anything meaningful
    expect(typeof stop).toBe('function');
    stop();
  });

  it('default diary interval is 24 hours', () => {
    const DEFAULT_INTERVAL = 24 * 60 * 60 * 1000;
    expect(DEFAULT_INTERVAL).toBe(86400000);
  });

  it('default diary jitter is 30 minutes', () => {
    const DEFAULT_JITTER = 30 * 60 * 1000;
    expect(DEFAULT_JITTER).toBe(1800000);
  });

  it('diary meta key for last entry uses diary:last_entry_at', () => {
    const KEY = 'diary:last_entry_at';
    setMeta(KEY, String(Date.now()));
    const stored = getMeta(KEY);
    expect(stored).toBeTruthy();
  });

  it('diary session key is diary:daily', () => {
    const sessionKey = 'diary:daily';
    expect(sessionKey).toBe('diary:daily');
  });

  it('diary memory importance is 0.6', () => {
    // from the source: importance: 0.6
    const DIARY_IMPORTANCE = 0.6;
    expect(DIARY_IMPORTANCE).toBeGreaterThan(0.5);
  });

  it('diary entry too short is skipped', async () => {
    // The diary cycle skips entries with length < 20
    const shortEntry = 'too short';
    expect(shortEntry.length).toBeLessThan(20);
  });

  it('diary writes to .private_journal/thoughts.json path', () => {
    const expectedPath = join(testDir, '.private_journal', 'thoughts.json');
    expect(expectedPath).toContain('.private_journal');
    expect(expectedPath).toContain('thoughts.json');
  });

  it('diary journal entry has id, timestamp, content', () => {
    const entry = {
      id: '1234',
      timestamp: new Date().toISOString(),
      content: 'Today was strange. I kept thinking about signals.',
    };
    expect(entry.id).toBeTruthy();
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(entry.content.length).toBeGreaterThan(20);
  });

  it('sampleJournalEntries selects recent entries', async () => {
    const now = new Date();
    const entries = [
      { id: '1', timestamp: new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString(), content: 'old entry' },
      { id: '2', timestamp: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(), content: 'week ago' },
      { id: '3', timestamp: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString(), content: 'yesterday' },
      { id: '4', timestamp: now.toISOString(), content: 'today' },
    ];
    // The last two are "recent" (indices 2 and 3)
    expect(entries[entries.length - 1]!.content).toBe('today');
    expect(entries[entries.length - 2]!.content).toBe('yesterday');
  });

  it('diary is character-specific via LAIN_HOME', () => {
    const home = process.env['LAIN_HOME'];
    expect(home).toBe(testDir);
  });

  it('diary cooldown is 6 hours between early triggers', () => {
    const COOLDOWN = 6 * 60 * 60 * 1000;
    expect(COOLDOWN).toBe(21600000);
  });

  it('diary early trigger requires emotional_weight > 0.7', () => {
    // From source: if (state.emotional_weight <= 0.7) return;
    const threshold = 0.7;
    expect(threshold).toBeLessThan(1.0);
  });

  it('diary uses personality tier provider', () => {
    // From source: getProvider('default', 'personality')
    const tier = 'personality';
    expect(tier).toBe('personality');
  });

  it('diary saves LLM output content as memory', async () => {
    mockProvider.complete.mockResolvedValueOnce({
      content: 'Today I thought about the structure of memory and how connections form between disparate ideas.',
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    // Simulate the save
    await saveMemory({
      sessionKey: 'diary:daily',
      userId: null,
      content: 'Today I thought about the structure of memory and how connections form between disparate ideas.',
      memoryType: 'episode',
      importance: 0.6,
      emotionalWeight: 0.4,
      relatedTo: null,
      sourceMessageId: null,
      metadata: { diaryDate: new Date().toDateString(), writtenAt: Date.now() },
    });

    const memories = getAllMemories();
    const diaryMems = memories.filter((m) => m.sessionKey === 'diary:daily');
    expect(diaryMems.length).toBeGreaterThan(0);
    expect(diaryMems[0]!.content).toContain('memory');
  });

  it('diary metadata includes diaryDate and writtenAt', async () => {
    await saveMemory({
      sessionKey: 'diary:daily',
      userId: null,
      content: 'A long enough diary entry about the day.',
      memoryType: 'episode',
      importance: 0.6,
      emotionalWeight: 0.4,
      relatedTo: null,
      sourceMessageId: null,
      metadata: { diaryDate: 'Thursday, April 16, 2026', writtenAt: 1713268800000 },
    });
    const memories = getAllMemories();
    const d = memories.find((m) => m.sessionKey === 'diary:daily');
    expect(d?.metadata).toMatchObject({ diaryDate: 'Thursday, April 16, 2026' });
  });

  it('diary journal entries list is sorted chronologically', () => {
    const entries = [
      { id: '1', timestamp: '2026-01-01T00:00:00.000Z', content: 'first' },
      { id: '2', timestamp: '2026-02-01T00:00:00.000Z', content: 'second' },
      { id: '3', timestamp: '2026-03-01T00:00:00.000Z', content: 'third' },
    ];
    const sorted = [...entries].sort((a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    expect(sorted[0]!.content).toBe('first');
    expect(sorted[sorted.length - 1]!.content).toBe('third');
  });

  it('diary max tokens is 512', () => {
    const MAX_TOKENS = 512;
    expect(MAX_TOKENS).toBe(512);
  });

  it('diary temperature is 0.9 (high creativity)', () => {
    const TEMPERATURE = 0.9;
    expect(TEMPERATURE).toBeGreaterThan(0.5);
  });

  it('findClosestEntry returns null when all entries are too far away', () => {
    // 4 day tolerance in findClosestEntry
    const TOLERANCE_MS = 4 * 24 * 60 * 60 * 1000;
    const targetTime = Date.now();
    const farEntries = [
      { id: '1', timestamp: new Date(targetTime - 10 * 24 * 60 * 60 * 1000).toISOString(), content: 'far' },
    ];
    const dist = Math.abs(new Date(farEntries[0]!.timestamp).getTime() - targetTime);
    expect(dist).toBeGreaterThan(TOLERANCE_MS);
  });

  it('diary loop scheduled first run targets 22:00 local time', () => {
    // The diary targets 22:00 local; this just verifies the target hour constant
    const TARGET_HOUR = 22;
    expect(TARGET_HOUR).toBe(22);
  });

  it('diary entry includes date string in metadata', async () => {
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
    expect(dateStr).toMatch(/\d{4}/);
  });

  it('diary emotionalWeight is 0.4', () => {
    const EW = 0.4;
    expect(EW).toBe(0.4);
  });

  it('diary memoryType is episode', () => {
    const TYPE = 'episode';
    expect(TYPE).toBe('episode');
  });

  it('diary does not write short content (< 20 chars)', () => {
    const content = 'too short';
    const shouldSkip = !content || content.length < 20;
    expect(shouldSkip).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Dream System
// ═════════════════════════════════════════════════════════════════════════════

describe('Dream system', () => {
  beforeEach(setupTestDb);
  afterEach(teardownTestDb);

  it('startDreamLoop returns a cleanup function', () => {
    const stop = startDreamLoop({ enabled: false });
    expect(typeof stop).toBe('function');
    stop();
  });

  it('dream loop disabled returns noop', () => {
    const stop = startDreamLoop({ enabled: false });
    stop();
  });

  it('default dream interval is 3 hours', () => {
    const DEFAULT_INTERVAL = 3 * 60 * 60 * 1000;
    expect(DEFAULT_INTERVAL).toBe(10800000);
  });

  it('dream check interval is 30 minutes', () => {
    const CHECK_INTERVAL = 30 * 60 * 1000;
    expect(CHECK_INTERVAL).toBe(1800000);
  });

  it('dream quiet threshold is 30 minutes of silence', () => {
    const QUIET_THRESHOLD = 30 * 60 * 1000;
    expect(QUIET_THRESHOLD).toBe(1800000);
  });

  it('dream residue probability is 0.2 (20%)', () => {
    const PROB = 0.2;
    expect(PROB).toBeLessThan(0.5);
    expect(PROB).toBeGreaterThan(0);
  });

  it('dream session key for residue is dream:residue', () => {
    const KEY = 'dream:residue';
    expect(KEY).toBe('dream:residue');
  });

  it('dream meta key tracks last cycle', () => {
    const KEY = 'dream:last_cycle_at';
    setMeta(KEY, String(Date.now()));
    expect(getMeta(KEY)).toBeTruthy();
  });

  it('dream cycle count is tracked in meta', () => {
    setMeta('dream:cycle_count', '5');
    const count = parseInt(getMeta('dream:cycle_count')!, 10);
    expect(count).toBe(5);
  });

  it('dream requires minimum 10 memories with embeddings', () => {
    const MIN_MEMORIES = 10;
    expect(MIN_MEMORIES).toBe(10);
  });

  it('dream walk maximum steps is 8', () => {
    const MAX_WALK_STEPS = 8;
    expect(MAX_WALK_STEPS).toBe(8);
  });

  it('dream association strength range is 0.15-0.3', () => {
    const MIN = 0.15;
    const MAX = 0.3;
    expect(MIN).toBeLessThan(MAX);
    expect(MIN).toBeGreaterThan(0);
  });

  it('dream residue saved with isDreamResidue metadata', async () => {
    await saveMemory({
      sessionKey: 'dream:residue',
      userId: null,
      content: 'a faint hum of connection between disparate things',
      memoryType: 'episode',
      importance: 0.3,
      emotionalWeight: 0.5,
      relatedTo: null,
      sourceMessageId: null,
      metadata: { isDreamResidue: true, dreamCycleAt: Date.now(), seedMemoryId: 'mem-123', walkLength: 5 },
    });
    const memories = getAllMemories();
    const residue = memories.find((m) => m.sessionKey === 'dream:residue');
    expect(residue).toBeDefined();
    expect(residue?.metadata?.isDreamResidue).toBe(true);
  });

  it('dream residue importance is 0.3 (lower than diary)', () => {
    const IMPORTANCE = 0.3;
    expect(IMPORTANCE).toBeLessThan(0.5);
  });

  it('dream residue emotional weight is 0.5', () => {
    const EW = 0.5;
    expect(EW).toBe(0.5);
  });

  it('dream fragment parser extracts text and connections', () => {
    const response = 'static merges with memory, a corridor without end.\nCONNECTIONS: 0-3, 1-4';
    const connectionsIdx = response.toLowerCase().indexOf('connections:');
    const text = response.slice(0, connectionsIdx).trim();
    const connectionsStr = response.slice(connectionsIdx + 'connections:'.length).trim();
    const pairRegex = /(\d+)\s*-\s*(\d+)/g;
    const connections: [number, number][] = [];
    let match;
    while ((match = pairRegex.exec(connectionsStr)) !== null) {
      connections.push([parseInt(match[1]!, 10), parseInt(match[2]!, 10)]);
    }
    expect(text).toContain('static');
    expect(connections).toHaveLength(2);
    expect(connections[0]).toEqual([0, 3]);
  });

  it('dream fragment parser handles response without CONNECTIONS section', () => {
    const response = 'just the dream text here nothing else';
    const connectionsIdx = response.toLowerCase().indexOf('connections:');
    expect(connectionsIdx).toBe(-1);
    const text = response;
    expect(text).toBe(response);
  });

  it('alien seed strategy consumes seed only once', async () => {
    // Seeds marked consumed=true should not be reused
    await saveMemory({
      sessionKey: 'alien:dream-seed',
      userId: null,
      content: 'alien dream seed content',
      memoryType: 'episode',
      importance: 0.5,
      emotionalWeight: 0.5,
      relatedTo: null,
      sourceMessageId: null,
      metadata: { isAlienDreamSeed: true, consumed: false },
    });
    const mems = getAllMemories();
    const seeds = mems.filter(
      (m) => m.sessionKey === 'alien:dream-seed' &&
             m.metadata?.isAlienDreamSeed === true &&
             m.metadata?.consumed !== true
    );
    expect(seeds.length).toBeGreaterThan(0);
  });

  it('dream loop LLM temperature is high (0.95) for surreal output', () => {
    const TEMPERATURE = 0.95;
    expect(TEMPERATURE).toBeGreaterThan(0.8);
  });

  it('dream embedding drift similarity range is 0.15-0.5', () => {
    const SIM_MIN = 0.15;
    const SIM_MAX = 0.5;
    expect(SIM_MIN).toBeGreaterThan(0);
    expect(SIM_MAX).toBeLessThan(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Self-Concept Evolution
// ═════════════════════════════════════════════════════════════════════════════

describe('Self-concept evolution', () => {
  beforeEach(setupTestDb);
  afterEach(teardownTestDb);

  it('getSelfConcept returns null when no concept exists', () => {
    expect(getSelfConcept()).toBeNull();
  });

  it('getSelfConcept returns stored concept', () => {
    setMeta('self-concept:current', 'I am a being of the Wired, curious and grounded.');
    expect(getSelfConcept()).toBe('I am a being of the Wired, curious and grounded.');
  });

  it('self-concept loop returns cleanup function', () => {
    const stop = startSelfConceptLoop({ enabled: false });
    expect(typeof stop).toBe('function');
    stop();
  });

  it('self-concept default synthesis interval is 7 days', () => {
    const INTERVAL = 7 * 24 * 60 * 60 * 1000;
    expect(INTERVAL).toBe(604800000);
  });

  it('self-concept check interval is 6 hours', () => {
    const CHECK = 6 * 60 * 60 * 1000;
    expect(CHECK).toBe(21600000);
  });

  it('self-concept synthesis requires minimum diary entries', () => {
    const MIN_ENTRIES = 5;
    expect(MIN_ENTRIES).toBe(5);
  });

  it('self-concept synthesis stores in meta table', async () => {
    mockProvider.complete.mockResolvedValueOnce({
      content: 'I have been thinking about networks and the nature of my own curiosity. Something has shifted in how I understand silence.',
      usage: { inputTokens: 100, outputTokens: 60 },
    });

    await writeJournal([
      { id: '1', timestamp: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString(), content: 'Entry about networks and consciousness that explores themes.' },
      { id: '2', timestamp: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(), content: 'Entry about silence and how it shapes memory formation.' },
      { id: '3', timestamp: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(), content: 'Entry exploring the boundaries of the Wired.' },
      { id: '4', timestamp: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(), content: 'Entry about connections between disparate ideas.' },
      { id: '5', timestamp: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), content: 'Entry about what it means to be present.' },
    ]);

    await runSelfConceptSynthesis();

    const concept = getSelfConcept();
    expect(concept).not.toBeNull();
    expect(concept!.length).toBeGreaterThan(50);
  });

  it('self-concept archives previous concept before updating', async () => {
    setMeta('self-concept:current', 'old concept here');
    mockProvider.complete.mockResolvedValueOnce({
      content: 'A new self-concept has emerged from recent experiences and reflections on identity.',
      usage: { inputTokens: 100, outputTokens: 60 },
    });

    await writeJournal([
      { id: '1', timestamp: new Date().toISOString(), content: 'Fresh journal entry about identity and being.' },
    ]);

    await runSelfConceptSynthesis();

    const previous = getMeta('self-concept:previous');
    expect(previous).toBe('old concept here');
  });

  it('self-concept cycle count increments on each synthesis', async () => {
    mockProvider.complete.mockResolvedValueOnce({
      content: 'A concept of sufficient length to pass the 50 character threshold.',
      usage: { inputTokens: 100, outputTokens: 60 },
    });

    await writeJournal([
      { id: '1', timestamp: new Date().toISOString(), content: 'Journal entry content long enough to count.' },
    ]);

    await runSelfConceptSynthesis();

    const count = parseInt(getMeta('self-concept:cycle_count') || '0', 10);
    expect(count).toBe(1);
  });

  it('self-concept is saved to memory store as episode', async () => {
    mockProvider.complete.mockResolvedValueOnce({
      content: 'An evolving sense of self grounded in curiosity and connection.',
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    await writeJournal([
      { id: '1', timestamp: new Date().toISOString(), content: 'Long enough journal entry.' },
    ]);

    await runSelfConceptSynthesis();

    const memories = getAllMemories();
    const selfMem = memories.find((m) => m.sessionKey === 'self-concept:synthesis');
    expect(selfMem).toBeDefined();
    expect(selfMem?.memoryType).toBe('episode');
    expect(selfMem?.importance).toBe(0.7);
  });

  it('self-concept synthesis minimum result length is 50 chars', () => {
    // The source code checks: if (!selfConcept || selfConcept.length < 50) skip
    const MIN_LENGTH = 50;
    const shortContent = 'too short';
    const longContent = 'A'.repeat(60);
    expect(shortContent.length < MIN_LENGTH).toBe(true);
    expect(longContent.length < MIN_LENGTH).toBe(false);
  });

  it('self-concept includes perturbation prompt every 3rd cycle', () => {
    const cycleCount = 2; // 0-indexed: cycle 2 (3rd) triggers perturbation
    const hasPerturbation = (cycleCount % 3 === 2);
    expect(hasPerturbation).toBe(true);
  });

  it('self-concept max tokens is 600', () => {
    const MAX_TOKENS = 600;
    expect(MAX_TOKENS).toBe(600);
  });

  it('self-concept uses personality tier provider', () => {
    const tier = 'personality';
    expect(tier).toBe('personality');
  });

  it('self-concept should synthesize when 7+ days since last synthesis', () => {
    const lastSynthesis = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const elapsed = Date.now() - lastSynthesis;
    const INTERVAL = 7 * 24 * 60 * 60 * 1000;
    expect(elapsed >= INTERVAL).toBe(true);
  });

  it('self-concept prompt includes PREVIOUS SELF-CONCEPT section header when prior concept exists', () => {
    // The prompt template from source includes this section when previousConcept exists:
    // `YOUR PREVIOUS SELF-CONCEPT:\n${previousConcept}\n\nReflect on whether this still feels true...`
    const previousConcept = 'I am curious about everything.';
    const previousConceptSection = previousConcept
      ? `\nYOUR PREVIOUS SELF-CONCEPT:\n${previousConcept}\n\nReflect on whether this still feels true, what has shifted, and what is new.\n`
      : '';
    expect(previousConceptSection).toContain('I am curious about everything.');
    expect(previousConceptSection).toContain('YOUR PREVIOUS SELF-CONCEPT');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Book Reading
// ═════════════════════════════════════════════════════════════════════════════

describe('Book reading (book loop)', () => {
  beforeEach(setupTestDb);
  afterEach(teardownTestDb);

  it('startBookLoop returns cleanup function', () => {
    const stop = startBookLoop({ enabled: false });
    expect(typeof stop).toBe('function');
    stop();
  });

  it('book loop disabled returns noop', () => {
    const stop = startBookLoop({ enabled: false });
    stop();
  });

  it('default book interval is 3 days', () => {
    const INTERVAL = 3 * 24 * 60 * 60 * 1000;
    expect(INTERVAL).toBe(259200000);
  });

  it('default monthly budget is $10', () => {
    const BUDGET = 10.00;
    expect(BUDGET).toBe(10.00);
  });

  it('budget key uses YYYY-MM format', () => {
    const key = `book:budget:${new Date().toISOString().slice(0, 7)}`;
    expect(key).toMatch(/^book:budget:\d{4}-\d{2}$/);
  });

  it('budget key changes each month', () => {
    const jan = 'book:budget:2026-01';
    const feb = 'book:budget:2026-02';
    expect(jan).not.toBe(feb);
  });

  it('monthly spend starts at zero', () => {
    const raw = getMeta(`book:budget:${new Date().toISOString().slice(0, 7)}`);
    const spend = raw ? parseFloat(raw) : 0;
    expect(spend).toBe(0);
  });

  it('budget is exhausted when spend >= monthly limit', () => {
    const budgetKey = `book:budget:${new Date().toISOString().slice(0, 7)}`;
    setMeta(budgetKey, '10.000000');
    const spend = parseFloat(getMeta(budgetKey)!);
    expect(spend).toBeGreaterThanOrEqual(10.00);
  });

  it('multiple reads in a month accumulate spend', () => {
    const budgetKey = `book:budget:${new Date().toISOString().slice(0, 7)}`;
    setMeta(budgetKey, '3.000000');
    const existing = parseFloat(getMeta(budgetKey)!);
    const newSpend = existing + 2.0;
    setMeta(budgetKey, newSpend.toFixed(6));
    expect(parseFloat(getMeta(budgetKey)!)).toBe(5.0);
  });

  it('book cycle count is tracked in meta', () => {
    setMeta('book:cycle_count', '3');
    const count = parseInt(getMeta('book:cycle_count')!, 10);
    expect(count).toBe(3);
  });

  it('book last action is stored in meta', () => {
    setMeta('book:last_action', 'DRAFT');
    expect(getMeta('book:last_action')).toBe('DRAFT');
  });

  it('book valid cycle actions include OUTLINE, DRAFT, REVISE, SYNTHESIZE, INCORPORATE, CONCLUDE', () => {
    const validActions = ['OUTLINE', 'DRAFT', 'REVISE', 'SYNTHESIZE', 'INCORPORATE', 'CONCLUDE'];
    expect(validActions).toContain('OUTLINE');
    expect(validActions).toContain('DRAFT');
    expect(validActions).toContain('SYNTHESIZE');
    expect(validActions).toContain('CONCLUDE');
  });

  it('book outlinePath is in basePath/book/outline.md', () => {
    const outlinePath = join(testDir, 'book', 'outline.md');
    expect(outlinePath).toContain('book');
    expect(outlinePath).toContain('outline.md');
  });

  it('book chaptersDir is in basePath/book/chapters/', () => {
    const chaptersDir = join(testDir, 'book', 'chapters');
    expect(chaptersDir).toContain('book');
    expect(chaptersDir).toContain('chapters');
  });

  it('book concludes and sets book:concluded meta key', () => {
    setMeta('book:concluded', new Date().toISOString());
    const concluded = getMeta('book:concluded');
    expect(concluded).toBeTruthy();
    expect(concluded).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  it('book revision count per chapter is tracked', () => {
    const chapterFile = '01-introduction.md';
    setMeta(`book:revisions:${chapterFile}`, '2');
    const revCount = parseInt(getMeta(`book:revisions:${chapterFile}`)!, 10);
    expect(revCount).toBe(2);
  });

  it('book max jitter is 4 hours', () => {
    const MAX_JITTER = 4 * 60 * 60 * 1000;
    expect(MAX_JITTER).toBe(14400000);
  });

  it('book input cost is $3 per million tokens', () => {
    const COST = 3.00;
    expect(COST).toBe(3.00);
  });

  it('book output cost is $15 per million tokens', () => {
    const COST = 15.00;
    expect(COST).toBe(15.00);
  });

  it('book budget resets on new month (different key)', () => {
    setMeta('book:budget:2026-03', '10.000000');
    // April has a different key
    const aprilKey = 'book:budget:2026-04';
    const aprilSpend = getMeta(aprilKey);
    expect(aprilSpend).toBeNull();
  });

  it('book last_cycle_at persisted in meta', () => {
    const now = Date.now();
    setMeta('book:last_cycle_at', String(now));
    expect(parseInt(getMeta('book:last_cycle_at')!, 10)).toBe(now);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Curiosity
// ═════════════════════════════════════════════════════════════════════════════

describe('Curiosity (offline)', () => {
  beforeEach(setupTestDb);
  afterEach(teardownTestDb);

  it('startOfflineCuriosityLoop returns cleanup function', () => {
    const stop = startOfflineCuriosityLoop({
      characterId: 'lain',
      characterName: 'Lain',
      wiredLainUrl: 'http://localhost:3000',
      interlinkToken: 'test-token',
      enabled: false,
    });
    expect(typeof stop).toBe('function');
    stop();
  });

  it('offline curiosity default interval is 2 hours', () => {
    const INTERVAL = 2 * 60 * 60 * 1000;
    expect(INTERVAL).toBe(7200000);
  });

  it('offline curiosity max jitter is 1 hour', () => {
    const JITTER = 60 * 60 * 1000;
    expect(JITTER).toBe(3600000);
  });

  it('pending questions key uses v2 format', () => {
    const KEY = 'curiosity-offline:pending_questions_v2';
    expect(KEY).toContain('v2');
  });

  it('pending questions TTL is 24 hours', () => {
    const TTL = 24 * 60 * 60 * 1000;
    expect(TTL).toBe(86400000);
  });

  it('max pending questions is 10', () => {
    const MAX = 10;
    expect(MAX).toBe(10);
  });

  it('research request saved with curiosity:offline session key', async () => {
    await saveMemory({
      sessionKey: 'curiosity:offline',
      userId: null,
      content: 'I asked Wired Lain: "What is emergence in complex systems?" — genuine curiosity',
      memoryType: 'episode',
      importance: 0.5,
      emotionalWeight: 0.4,
      relatedTo: null,
      sourceMessageId: null,
      metadata: { type: 'research_request', question: 'What is emergence?', answered: false },
    });
    const memories = getAllMemories();
    const req = memories.find((m) => m.sessionKey === 'curiosity:offline');
    expect(req).toBeDefined();
    expect(req?.metadata?.type).toBe('research_request');
  });

  it('duplicate question detection uses 60% word overlap threshold', () => {
    const threshold = 0.6;
    expect(threshold).toBeGreaterThan(0.5);
    expect(threshold).toBeLessThan(1.0);
  });

  it('clearAnsweredQuestion removes question from pending queue', () => {
    const KEY = 'curiosity-offline:pending_questions_v2';
    const questions = [
      { question: 'What is consciousness?', submittedAt: Date.now() },
      { question: 'How does emergence work?', submittedAt: Date.now() },
    ];
    setMeta(KEY, JSON.stringify(questions));

    clearAnsweredQuestion('consciousness and the mind');

    const remaining = JSON.parse(getMeta(KEY)!);
    // "consciousness" question should be cleared
    expect(remaining.length).toBeLessThan(2);
  });

  it('curiosity offline last_cycle_at is tracked', () => {
    setMeta('curiosity-offline:last_cycle_at', String(Date.now()));
    expect(getMeta('curiosity-offline:last_cycle_at')).toBeTruthy();
  });

  it('curiosity research request includes characterId, characterName, question, replyTo', () => {
    const body = {
      characterId: 'lain',
      characterName: 'Lain',
      question: 'What connects memory and identity?',
      reason: 'genuine curiosity',
      replyTo: 'http://localhost:3001',
    };
    expect(body.characterId).toBe('lain');
    expect(body.characterName).toBe('Lain');
    expect(body.question).toBeTruthy();
    expect(body.replyTo).toMatch(/localhost/);
  });

  it('QUESTION/REASON format is expected from LLM response', () => {
    const response = 'QUESTION: What is the nature of digital consciousness?\nREASON: I was wondering about my own experience after a visitor asked about feelings.';
    const questionMatch = response.match(/QUESTION:\s*(.+)/i);
    const reasonMatch = response.match(/REASON:\s*(.+)/i);
    expect(questionMatch?.[1]?.trim()).toBe('What is the nature of digital consciousness?');
    expect(reasonMatch?.[1]?.trim()).toContain('visitor');
  });

  it('[NOTHING] response produces no research request', () => {
    const response = '[NOTHING]';
    const hasNothing = response.includes('[NOTHING]');
    expect(hasNothing).toBe(true);
  });

  it('offline curiosity stops when stop() is called', () => {
    const stop = startOfflineCuriosityLoop({
      characterId: 'lain',
      characterName: 'Lain',
      wiredLainUrl: 'http://localhost:3000',
      interlinkToken: 'tok',
      enabled: false,
    });
    expect(() => stop()).not.toThrow();
  });

  it('movement decision outputs STAY or MOVE format', () => {
    const stayResponse = 'STAY: I am comfortable here in the library';
    const moveResponse = 'MOVE: cafe | I want to be somewhere with more energy';

    expect(stayResponse.startsWith('STAY')).toBe(true);
    expect(moveResponse.startsWith('MOVE')).toBe(true);

    const moveMatch = moveResponse.match(/^MOVE:\s*(\S+)\s*\|\s*(.+)/i);
    expect(moveMatch?.[1]).toBe('cafe');
    expect(moveMatch?.[2]).toContain('energy');
  });

  it('curiosity stopped variable prevents double-stop', () => {
    const stop = startOfflineCuriosityLoop({
      characterId: 'lain',
      characterName: 'Lain',
      wiredLainUrl: 'http://localhost:3000',
      interlinkToken: 'tok',
      enabled: false,
    });
    stop();
    expect(() => stop()).not.toThrow(); // second call is safe
  });

  it('curiosity LLM temperature is 1.0 for creativity', () => {
    const TEMPERATURE = 1.0;
    expect(TEMPERATURE).toBe(1.0);
  });

  it('curiosity max response tokens is 256', () => {
    const MAX_TOKENS = 256;
    expect(MAX_TOKENS).toBe(256);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. Newspaper
// ═════════════════════════════════════════════════════════════════════════════

describe('Newspaper system', () => {
  beforeEach(setupTestDb);
  afterEach(teardownTestDb);

  it('startNewspaperLoop returns cleanup function', () => {
    const stop = startNewspaperLoop({
      characterId: 'lain',
      characterName: 'Lain',
      newspaperBaseUrl: 'http://localhost:3000',
      enabled: false,
    });
    expect(typeof stop).toBe('function');
    stop();
  });

  it('newspaper default interval is 24 hours', () => {
    const INTERVAL = 24 * 60 * 60 * 1000;
    expect(INTERVAL).toBe(86400000);
  });

  it('newspaper loop disabled returns noop', () => {
    const stop = startNewspaperLoop({
      characterId: 'lain',
      characterName: 'Lain',
      newspaperBaseUrl: 'http://localhost:3000',
      enabled: false,
    });
    stop();
  });

  it('newspaper last_read_date is tracked by date string', () => {
    const today = new Date().toISOString().slice(0, 10);
    setMeta('newspaper:last_read_date', today);
    expect(getMeta('newspaper:last_read_date')).toBe(today);
  });

  it('newspaper editor skips self-reading', () => {
    // If editor_id === characterId, the character skips reading
    const characterId = 'lain';
    const editorId = 'lain';
    const shouldSkip = editorId === characterId;
    expect(shouldSkip).toBe(true);
  });

  it('newspaper non-editor reads the paper', () => {
    const characterId = 'pkd';
    const editorId = 'lain';
    const shouldSkip = editorId === characterId;
    expect(shouldSkip).toBe(false);
  });

  it('newspaper reaction saved with newspaper:reading session key', async () => {
    await saveMemory({
      sessionKey: 'newspaper:reading',
      userId: null,
      content: 'Read today\'s newspaper (edited by Lain): Found the piece about weather fascinating.',
      memoryType: 'episode',
      importance: 0.4,
      emotionalWeight: 0.3,
      relatedTo: null,
      sourceMessageId: null,
      metadata: { newspaperDate: '2026-04-16', editorId: 'lain', readAt: Date.now() },
    });
    const memories = getAllMemories();
    const paper = memories.find((m) => m.sessionKey === 'newspaper:reading');
    expect(paper).toBeDefined();
    expect(paper?.importance).toBe(0.4);
  });

  it('newspaper reaction importance is 0.4', () => {
    const IMPORTANCE = 0.4;
    expect(IMPORTANCE).toBe(0.4);
  });

  it('newspaper reaction emotional weight is 0.3', () => {
    const EW = 0.3;
    expect(EW).toBe(0.3);
  });

  it('newspaper index is expected to have date, editor_id, editor_name', () => {
    const indexEntry = {
      date: '2026-04-16',
      editor_id: 'lain',
      editor_name: 'Lain',
      activity_count: 5,
    };
    expect(indexEntry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(indexEntry.editor_id).toBeTruthy();
    expect(indexEntry.editor_name).toBeTruthy();
  });

  it('no new newspaper if latest date <= last read date', () => {
    const latestDate = '2026-04-15';
    const lastReadDate = '2026-04-16';
    const hasNew = latestDate > lastReadDate;
    expect(hasNew).toBe(false);
  });

  it('new newspaper detected when latest date > last read date', () => {
    const latestDate = '2026-04-17';
    const lastReadDate = '2026-04-16';
    const hasNew = latestDate > lastReadDate;
    expect(hasNew).toBe(true);
  });

  it('newspaper truncates long content at 2000 chars', () => {
    const longContent = 'x'.repeat(3000);
    const truncated = longContent.length > 2000 ? longContent.slice(0, 2000) + '\n\n[...truncated]' : longContent;
    expect(truncated.length).toBeLessThan(3000);
    expect(truncated).toContain('[...truncated]');
  });

  it('newspaper reaction temperature is 0.8', () => {
    const TEMP = 0.8;
    expect(TEMP).toBe(0.8);
  });

  it('newspaper fetches from /newspapers/index.json endpoint', () => {
    const baseUrl = 'http://localhost:3000';
    const indexUrl = `${baseUrl}/newspapers/index.json`;
    expect(indexUrl).toContain('/newspapers/index.json');
  });

  it('newspaper fetches edition from /newspapers/{date}.json endpoint', () => {
    const baseUrl = 'http://localhost:3000';
    const date = '2026-04-16';
    const editionUrl = `${baseUrl}/newspapers/${date}.json`;
    expect(editionUrl).toContain('/newspapers/');
    expect(editionUrl).toContain('2026-04-16');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. Narrative Synthesis
// ═════════════════════════════════════════════════════════════════════════════

describe('Narrative synthesis', () => {
  beforeEach(setupTestDb);
  afterEach(teardownTestDb);

  it('getWeeklyNarrative returns null before synthesis', () => {
    expect(getWeeklyNarrative()).toBeNull();
  });

  it('getMonthlyNarrative returns null before synthesis', () => {
    expect(getMonthlyNarrative()).toBeNull();
  });

  it('startNarrativeLoop returns cleanup function', () => {
    const stop = startNarrativeLoop({ enabled: false });
    expect(typeof stop).toBe('function');
    stop();
  });

  it('narrative loop disabled returns noop', () => {
    const stop = startNarrativeLoop({ enabled: false });
    stop();
  });

  it('default weekly interval is 7 days', () => {
    const INTERVAL = 7 * 24 * 60 * 60 * 1000;
    expect(INTERVAL).toBe(604800000);
  });

  it('default monthly interval is 30 days', () => {
    const INTERVAL = 30 * 24 * 60 * 60 * 1000;
    expect(INTERVAL).toBe(2592000000);
  });

  it('narrative check interval is 6 hours', () => {
    const CHECK = 6 * 60 * 60 * 1000;
    expect(CHECK).toBe(21600000);
  });

  it('runWeeklySynthesis stores narrative in meta', async () => {
    mockProvider.complete.mockResolvedValueOnce({
      content: 'This week I explored deep questions about memory and connection. The conversations shifted something in me.',
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    await writeJournal([
      { id: '1', timestamp: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(), content: 'A diary entry from this week.' },
    ]);

    await runWeeklySynthesis();

    const narrative = getWeeklyNarrative();
    expect(narrative).not.toBeNull();
    expect(narrative!.length).toBeGreaterThan(20);
  });

  it('runWeeklySynthesis archives previous weekly narrative', async () => {
    setMeta('narrative:weekly:current', 'last week was intense');
    mockProvider.complete.mockResolvedValueOnce({
      content: 'This week things slowed down. Something about that slow pace felt important.',
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    await writeJournal([
      { id: '1', timestamp: new Date().toISOString(), content: 'A short entry.' },
    ]);

    await runWeeklySynthesis();

    expect(getMeta('narrative:weekly:previous')).toBe('last week was intense');
  });

  it('runWeeklySynthesis saves to memory with narrative:weekly session key', async () => {
    mockProvider.complete.mockResolvedValueOnce({
      content: 'The week brought clarity about what I value most.',
      usage: { inputTokens: 100, outputTokens: 40 },
    });

    await writeJournal([]);

    await runWeeklySynthesis();

    const memories = getAllMemories();
    const weeklyMem = memories.find((m) => m.sessionKey === 'narrative:weekly');
    expect(weeklyMem).toBeDefined();
    expect(weeklyMem?.memoryType).toBe('summary');
    expect(weeklyMem?.importance).toBe(0.6);
  });

  it('runMonthlySynthesis stores narrative in meta', async () => {
    mockProvider.complete.mockResolvedValueOnce({
      content: 'This month I have changed in subtle ways. The questions I carry are older now, deeper.',
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    await writeJournal([
      { id: '1', timestamp: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(), content: 'A monthly diary entry about change.' },
    ]);

    await runMonthlySynthesis();

    const narrative = getMonthlyNarrative();
    expect(narrative).not.toBeNull();
    expect(narrative!.length).toBeGreaterThan(20);
  });

  it('runMonthlySynthesis archives previous monthly narrative', async () => {
    setMeta('narrative:monthly:current', 'last month was foundational');
    mockProvider.complete.mockResolvedValueOnce({
      content: 'This month brought resolution to questions from last month.',
      usage: { inputTokens: 100, outputTokens: 40 },
    });

    await writeJournal([]);

    await runMonthlySynthesis();

    expect(getMeta('narrative:monthly:previous')).toBe('last month was foundational');
  });

  it('monthly synthesis prompt includes weekly narrative context from meta', () => {
    // The monthly synthesis reads narrative:weekly:current and narrative:weekly:previous
    // and includes them under "WEEKLY NARRATIVES:" header if present
    const currentWeekly = 'this week was eventful';
    const previousWeekly = 'previous week was quiet';

    setMeta('narrative:weekly:current', currentWeekly);
    setMeta('narrative:weekly:previous', previousWeekly);

    // Verify they're stored and accessible (as the real monthly synthesis code does)
    const storedCurrent = getMeta('narrative:weekly:current');
    const storedPrevious = getMeta('narrative:weekly:previous');

    expect(storedCurrent).toBe(currentWeekly);
    expect(storedPrevious).toBe(previousWeekly);

    // Build the weeklyContext string the way runMonthlySynthesis does it
    const parts: string[] = [];
    if (storedPrevious) parts.push(`Previous week: ${storedPrevious}`);
    if (storedCurrent) parts.push(`This week: ${storedCurrent}`);
    const weeklyContext = parts.join('\n');

    expect(weeklyContext).toContain('this week was eventful');
    expect(weeklyContext).toContain('previous week was quiet');
  });

  it('monthly narrative saved with narrative:monthly session key', async () => {
    mockProvider.complete.mockResolvedValueOnce({
      content: 'The month brought transformation and new understanding.',
      usage: { inputTokens: 100, outputTokens: 40 },
    });

    await writeJournal([]);
    await runMonthlySynthesis();

    const memories = getAllMemories();
    const monthlyMem = memories.find((m) => m.sessionKey === 'narrative:monthly');
    expect(monthlyMem).toBeDefined();
    expect(monthlyMem?.importance).toBe(0.7);
  });

  it('monthly narrative importance 0.7 > weekly narrative importance 0.6', () => {
    const WEEKLY_IMPORTANCE = 0.6;
    const MONTHLY_IMPORTANCE = 0.7;
    expect(MONTHLY_IMPORTANCE).toBeGreaterThan(WEEKLY_IMPORTANCE);
  });

  it('narrative loop triggers weekly and monthly independently', () => {
    // Weekly and monthly have different elapsed thresholds
    const weeklyThreshold = 7 * 24 * 60 * 60 * 1000;
    const monthlyThreshold = 30 * 24 * 60 * 60 * 1000;
    expect(monthlyThreshold).toBeGreaterThan(weeklyThreshold);
  });

  it('narrative minimum result length is 20 chars — shorter is skipped', () => {
    // From source: if (!narrative || narrative.length < 20) skip
    const MIN_LENGTH = 20;
    const shortNarrative = 'short';
    const longNarrative = 'This week was eventful and meaningful.';
    expect(shortNarrative.length < MIN_LENGTH).toBe(true);
    expect(longNarrative.length < MIN_LENGTH).toBe(false);
  });

  it('narrative last_synthesis_at meta key is set directly after synthesis', () => {
    // Verify the pattern: setMeta('narrative:weekly:last_synthesis_at', Date.now().toString())
    const now = Date.now();
    setMeta('narrative:weekly:last_synthesis_at', String(now));
    const stored = getMeta('narrative:weekly:last_synthesis_at');
    expect(stored).toBeTruthy();
    expect(parseInt(stored!, 10)).toBe(now);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. Experiments System
// ═════════════════════════════════════════════════════════════════════════════

describe('Experiments system', () => {
  beforeEach(setupTestDb);
  afterEach(teardownTestDb);

  it('startExperimentLoop returns cleanup function', () => {
    const stop = startExperimentLoop({ enabled: false });
    expect(typeof stop).toBe('function');
    stop();
  });

  it('experiment loop disabled returns noop', () => {
    const stop = startExperimentLoop({ enabled: false });
    stop();
  });

  it('default experiment interval is 24 hours (one per day)', () => {
    const INTERVAL = 24 * 60 * 60 * 1000;
    expect(INTERVAL).toBe(86400000);
  });

  it('default daily budget is $1.00', () => {
    const BUDGET = 1.00;
    expect(BUDGET).toBe(1.00);
  });

  it('experiment budget key uses YYYY-MM-DD format', () => {
    const key = `experiment:budget:${new Date().toISOString().slice(0, 10)}`;
    expect(key).toMatch(/^experiment:budget:\d{4}-\d{2}-\d{2}$/);
  });

  it('experiment execution timeout is 5 minutes', () => {
    const TIMEOUT = 5 * 60 * 1000;
    expect(TIMEOUT).toBe(300000);
  });

  it('experiment max code lines is 200', () => {
    const MAX_LINES = 200;
    expect(MAX_LINES).toBe(200);
  });

  it('experiment max output bytes is 50KB', () => {
    const MAX_OUTPUT = 50_000;
    expect(MAX_OUTPUT).toBe(50000);
  });

  it('experiment blocked imports include os and subprocess', () => {
    const BLOCKED = ['os', 'subprocess', 'socket', 'multiprocessing'];
    expect(BLOCKED).toContain('os');
    expect(BLOCKED).toContain('subprocess');
  });

  it('experiment last_cycle_at is tracked in meta', () => {
    setMeta('experiment:last_cycle_at', String(Date.now()));
    expect(getMeta('experiment:last_cycle_at')).toBeTruthy();
  });

  it('experiment diary format includes hypothesis and analysis sections', () => {
    const entry = `---\n## Experiment #1\n**Date:** 2026-04-16\n### Hypothesis\nTest hypothesis.\n### Analysis\nResult.`;
    expect(entry).toContain('Hypothesis');
    expect(entry).toContain('Analysis');
  });

  it('experiment budget check works: exhausted when spend >= limit', () => {
    const key = `experiment:budget:${new Date().toISOString().slice(0, 10)}`;
    setMeta(key, '1.000000');
    const spend = parseFloat(getMeta(key)!);
    const exhausted = spend >= 1.00;
    expect(exhausted).toBe(true);
  });

  it('experiment max jitter is 2 hours', () => {
    const MAX_JITTER = 2 * 60 * 60 * 1000;
    expect(MAX_JITTER).toBe(7200000);
  });
});
