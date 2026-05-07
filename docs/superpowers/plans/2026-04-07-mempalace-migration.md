# MemPalace Memory Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Laintown's flat memory storage with a palace hierarchy, SQLite-vec vector search, temporal knowledge graph, and AAAK compression — without changing any external interfaces.

**Architecture:** Additive schema migration (ALTER TABLE + new tables) keeps existing code working throughout. Each stage is independently reversible. Dr. Claude (smallest DB) is the canary. Palace columns are added to the existing `memories` table; a `vec0` virtual table handles vector search; a `kg_triples` table absorbs associations; AAAK compression runs in the background organic loop.

**Tech Stack:** TypeScript/ESM, better-sqlite3, sqlite-vec (npm), @xenova/transformers (existing), vitest

**Spec:** `docs/superpowers/specs/2026-04-07-mempalace-migration-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/storage/database.ts` | Modify | Add migration v10 (palace schema + vec0 table) |
| `src/memory/palace.ts` | Create | Wing/room CRUD, hall assignment, auto-wing resolution |
| `src/memory/knowledge-graph.ts` | Create | KG triple/entity CRUD, contradiction detection, point-in-time queries |
| `src/memory/aaak.ts` | Create | AAAK compression prompt, batch compression, content retrieval |
| `src/memory/migration.ts` | Create | One-time migration script: existing memories → palace format + vec0 |
| `src/memory/store.ts` | Modify | Add palace columns to save/read, rewrite searchMemories for vec0 |
| `src/memory/embeddings.ts` | Modify | Remove `findTopK`, `cosineSimilarity` after vec0 is live |
| `src/memory/index.ts` | Modify | Update `buildMemoryContext` to use palace scoping + AAAK |
| `src/memory/organic.ts` | Modify | Add AAAK compression step + contradiction detection step |
| `src/memory/topology.ts` | Modify | Coherence groups → rooms, causal links → KG triples |
| `test/palace.test.ts` | Create | Tests for palace, KG, vec0 search, migration, AAAK |
| `package.json` | Modify | Add `sqlite-vec` dependency |

---

## Stage 1: Schema + Infrastructure

### Task 1: Add sqlite-vec dependency and load extension

**Files:**
- Modify: `package.json`
- Modify: `src/storage/database.ts:245-255`

- [ ] **Step 1: Install sqlite-vec**

```bash
cd /Users/apopo0308/IdeaProjects/lain && npm install sqlite-vec
```

- [ ] **Step 2: Load sqlite-vec extension in database.ts**

In `src/storage/database.ts`, add the import at the top (after line 7):

```typescript
import * as sqliteVec from 'sqlite-vec';
```

Then after the database is opened (after line 245: `db = new Database(path);`), add:

```typescript
    // Load sqlite-vec extension for vector search
    sqliteVec.load(db);
```

Place this BEFORE the SQLCipher pragma block (before the `try { db.pragma(...)` on line 251).

- [ ] **Step 3: Verify extension loads**

```bash
cd /Users/apopo0308/IdeaProjects/lain && npx tsx -e "
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
const db = new Database(':memory:');
sqliteVec.load(db);
const version = db.prepare('SELECT vec_version() as v').get();
console.log('sqlite-vec loaded:', version);
db.close();
"
```

Expected: `sqlite-vec loaded: { v: 'v0.1.9' }` (or similar version)

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/storage/database.ts
git commit -m "feat(memory): add sqlite-vec dependency and load extension"
```

---

### Task 2: Add palace schema migration (v10)

**Files:**
- Modify: `src/storage/database.ts:18` (SCHEMA_VERSION), `src/storage/database.ts:191-206` (MIGRATIONS array)

- [ ] **Step 1: Write failing test for new schema**

Create `test/palace.test.ts`:

```typescript
/**
 * Palace memory system tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  initDatabase,
  closeDatabase,
  query,
  execute,
} from '../src/storage/database.js';

// Mock keytar for tests
vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn().mockResolvedValue('test-master-key'),
    setPassword: vi.fn().mockResolvedValue(undefined),
    deletePassword: vi.fn().mockResolvedValue(true),
    findCredentials: vi.fn().mockResolvedValue([]),
  },
}));

describe('Palace Schema', () => {
  const testDir = join(tmpdir(), `lain-test-palace-${Date.now()}`);
  const originalEnv = process.env['LAIN_HOME'];

  beforeEach(async () => {
    process.env['LAIN_HOME'] = testDir;
    await mkdir(testDir, { recursive: true });
    await initDatabase(join(testDir, 'test.db'));
  });

  afterEach(async () => {
    closeDatabase();
    if (originalEnv) {
      process.env['LAIN_HOME'] = originalEnv;
    } else {
      delete process.env['LAIN_HOME'];
    }
    await rm(testDir, { recursive: true, force: true });
  });

  it('creates palace_wings table', () => {
    const tables = query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='palace_wings'"
    );
    expect(tables).toHaveLength(1);
  });

  it('creates palace_rooms table', () => {
    const tables = query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='palace_rooms'"
    );
    expect(tables).toHaveLength(1);
  });

  it('creates kg_triples table', () => {
    const tables = query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='kg_triples'"
    );
    expect(tables).toHaveLength(1);
  });

  it('creates kg_entities table', () => {
    const tables = query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='kg_entities'"
    );
    expect(tables).toHaveLength(1);
  });

  it('creates memory_embeddings vec0 virtual table', () => {
    const tables = query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_embeddings'"
    );
    expect(tables).toHaveLength(1);
  });

  it('adds palace columns to memories table', () => {
    // Insert a memory with palace columns
    execute(
      `INSERT INTO memories (id, content, memory_type, importance, created_at, wing_id, room_id, hall)
       VALUES ('test1', 'test content', 'fact', 0.5, ${Date.now()}, 'wing1', 'room1', 'truths')`
    );
    const row = query<{ wing_id: string; room_id: string; hall: string }>(
      "SELECT wing_id, room_id, hall FROM memories WHERE id = 'test1'"
    );
    expect(row[0]).toEqual({ wing_id: 'wing1', room_id: 'room1', hall: 'truths' });
  });

  it('adds aaak columns to memories table', () => {
    execute(
      `INSERT INTO memories (id, content, memory_type, importance, created_at, aaak_content, aaak_compressed_at)
       VALUES ('test2', 'test content', 'fact', 0.5, ${Date.now()}, 'COMPRESSED', ${Date.now()})`
    );
    const row = query<{ aaak_content: string; aaak_compressed_at: number }>(
      "SELECT aaak_content, aaak_compressed_at FROM memories WHERE id = 'test2'"
    );
    expect(row[0]?.aaak_content).toBe('COMPRESSED');
    expect(row[0]?.aaak_compressed_at).toBeGreaterThan(0);
  });

  it('can insert and query vec0 embeddings', () => {
    const embedding = new Float32Array(384);
    embedding[0] = 1.0; // Non-zero so cosine distance works

    execute(
      "INSERT INTO memory_embeddings(rowid, embedding, memory_id) VALUES (?, ?, ?)",
      [BigInt(1), embedding, 'mem-abc']
    );

    const results = query<{ rowid: bigint; distance: number; memory_id: string }>(
      "SELECT rowid, distance, memory_id FROM memory_embeddings WHERE embedding MATCH ? AND k = 5",
      [embedding]
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.memory_id).toBe('mem-abc');
    expect(results[0]?.distance).toBeCloseTo(0, 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/palace.test.ts
```

Expected: FAIL — tables don't exist yet, palace columns not present.

- [ ] **Step 3: Add migration v10 to database.ts**

In `src/storage/database.ts`, change line 18:

```typescript
const SCHEMA_VERSION = 10;
```

Add the following migration after the Version 9 migration (after line 205, before the closing `];`):

```typescript
  // Version 10: Palace memory hierarchy + sqlite-vec + knowledge graph
  `
  CREATE TABLE IF NOT EXISTS palace_wings (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    created_at INTEGER NOT NULL,
    memory_count INTEGER DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_palace_wings_name ON palace_wings(name);

  CREATE TABLE IF NOT EXISTS palace_rooms (
    id TEXT PRIMARY KEY,
    wing_id TEXT NOT NULL REFERENCES palace_wings(id),
    name TEXT NOT NULL,
    description TEXT,
    created_at INTEGER NOT NULL,
    memory_count INTEGER DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_palace_rooms_wing ON palace_rooms(wing_id);
  CREATE INDEX IF NOT EXISTS idx_palace_rooms_name ON palace_rooms(name);

  CREATE TABLE IF NOT EXISTS kg_triples (
    id TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    predicate TEXT NOT NULL,
    object TEXT NOT NULL,
    strength REAL DEFAULT 1.0,
    valid_from INTEGER NOT NULL,
    ended INTEGER,
    source_memory_id TEXT,
    metadata TEXT DEFAULT '{}'
  );

  CREATE INDEX IF NOT EXISTS idx_kg_subject ON kg_triples(subject);
  CREATE INDEX IF NOT EXISTS idx_kg_object ON kg_triples(object);
  CREATE INDEX IF NOT EXISTS idx_kg_predicate ON kg_triples(predicate);
  CREATE INDEX IF NOT EXISTS idx_kg_valid ON kg_triples(valid_from, ended);

  CREATE TABLE IF NOT EXISTS kg_entities (
    name TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    metadata TEXT DEFAULT '{}'
  );

  CREATE INDEX IF NOT EXISTS idx_kg_entities_type ON kg_entities(entity_type);
  `,
```

Then add the ALTER TABLE statements and vec0 table as a SEPARATE migration entry (because ALTER TABLEs and virtual table creation are handled differently by the migration runner). Add this right after the version 10 entry, and bump `SCHEMA_VERSION` to `11`:

Actually, on second look the migration runner handles ALTER TABLE statements individually already (lines 326-345). So we can include them in the same migration. But `CREATE VIRTUAL TABLE` uses `exec` not `prepare`, and the migration runner calls `database.exec(batchSql)` which handles it. So we can put it all in one migration. However, the vec0 table syntax may conflict with the batch executor. Let's keep version 10 for the regular tables and version 11 for the ALTER + vec0:

Change `SCHEMA_VERSION` to `11` instead, and add TWO migration entries:

```typescript
const SCHEMA_VERSION = 11;
```

After the version 10 entry (the one above with CREATE TABLEs), add version 11:

```typescript
  // Version 11: Palace columns on memories + vec0 embedding index
  `
  ALTER TABLE memories ADD COLUMN wing_id TEXT;
  ALTER TABLE memories ADD COLUMN room_id TEXT;
  ALTER TABLE memories ADD COLUMN hall TEXT;
  ALTER TABLE memories ADD COLUMN aaak_content TEXT;
  ALTER TABLE memories ADD COLUMN aaak_compressed_at INTEGER;

  CREATE INDEX IF NOT EXISTS idx_memories_wing ON memories(wing_id);
  CREATE INDEX IF NOT EXISTS idx_memories_room ON memories(room_id);
  CREATE INDEX IF NOT EXISTS idx_memories_hall ON memories(hall);

  CREATE VIRTUAL TABLE IF NOT EXISTS memory_embeddings USING vec0(
    embedding float[384] distance_metric=cosine,
    +memory_id text
  );
  `,
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run test/palace.test.ts
```

Expected: All 8 tests PASS.

- [ ] **Step 5: Run existing tests to verify no regressions**

```bash
npx vitest run test/config.test.ts test/storage.test.ts
```

Expected: All existing tests still PASS.

- [ ] **Step 6: Commit**

```bash
git add src/storage/database.ts test/palace.test.ts
git commit -m "feat(memory): add palace schema migration v10-v11

Palace wings/rooms tables, kg_triples/kg_entities tables, palace columns
on memories (wing_id, room_id, hall, aaak_content), and memory_embeddings
vec0 virtual table with cosine distance."
```

---

### Task 3: Create palace.ts — Wing and Room CRUD

**Files:**
- Create: `src/memory/palace.ts`
- Modify: `test/palace.test.ts`

- [ ] **Step 1: Add palace CRUD tests**

Append to `test/palace.test.ts`:

```typescript
import {
  createWing,
  getWing,
  getWingByName,
  listWings,
  createRoom,
  getRoom,
  listRooms,
  resolveWing,
  assignHall,
} from '../src/memory/palace.js';

describe('Palace CRUD', () => {
  const testDir = join(tmpdir(), `lain-test-palace-crud-${Date.now()}`);
  const originalEnv = process.env['LAIN_HOME'];

  beforeEach(async () => {
    process.env['LAIN_HOME'] = testDir;
    await mkdir(testDir, { recursive: true });
    await initDatabase(join(testDir, 'test.db'));
  });

  afterEach(async () => {
    closeDatabase();
    if (originalEnv) {
      process.env['LAIN_HOME'] = originalEnv;
    } else {
      delete process.env['LAIN_HOME'];
    }
    await rm(testDir, { recursive: true, force: true });
  });

  it('creates and retrieves a wing', () => {
    const id = createWing('self', 'Internal life');
    const wing = getWing(id);
    expect(wing).toBeDefined();
    expect(wing!.name).toBe('self');
    expect(wing!.description).toBe('Internal life');
  });

  it('finds wing by name', () => {
    createWing('curiosity', 'Browsing discoveries');
    const wing = getWingByName('curiosity');
    expect(wing).toBeDefined();
    expect(wing!.name).toBe('curiosity');
  });

  it('lists all wings', () => {
    createWing('self', 'Internal');
    createWing('town', 'Town life');
    const wings = listWings();
    expect(wings).toHaveLength(2);
  });

  it('creates and retrieves a room', () => {
    const wingId = createWing('curiosity', 'Discoveries');
    const roomId = createRoom(wingId, 'cybernetics', 'Systems theory');
    const room = getRoom(roomId);
    expect(room).toBeDefined();
    expect(room!.name).toBe('cybernetics');
    expect(room!.wingId).toBe(wingId);
  });

  it('lists rooms for a wing', () => {
    const wingId = createWing('self', 'Internal');
    createRoom(wingId, 'dreams', 'Dream sequences');
    createRoom(wingId, 'diary', 'Daily reflections');
    const rooms = listRooms(wingId);
    expect(rooms).toHaveLength(2);
  });

  it('resolveWing creates wing if it does not exist', () => {
    const id1 = resolveWing('self', 'Internal life');
    const id2 = resolveWing('self', 'Internal life');
    expect(id1).toBe(id2); // Same wing returned
    const wings = listWings();
    expect(wings).toHaveLength(1);
  });

  it('assignHall maps memory types correctly', () => {
    expect(assignHall('fact', '')).toBe('truths');
    expect(assignHall('preference', '')).toBe('truths');
    expect(assignHall('episode', 'curiosity:browse')).toBe('discoveries');
    expect(assignHall('episode', 'dreams:lain')).toBe('dreams');
    expect(assignHall('episode', 'diary:2026-04-07')).toBe('reflections');
    expect(assignHall('episode', 'letter:wired-lain')).toBe('reflections');
    expect(assignHall('summary', '')).toBe('reflections');
    expect(assignHall('context', '')).toBe('encounters');
    expect(assignHall('episode', 'web:abc123')).toBe('encounters');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run test/palace.test.ts
```

Expected: FAIL — `palace.ts` doesn't exist yet.

- [ ] **Step 3: Create src/memory/palace.ts**

```typescript
/**
 * Palace structure management
 * Wings (top-level domains), rooms (topic clusters), halls (memory type corridors)
 */

import { nanoid } from 'nanoid';
import { execute, query, queryOne } from '../storage/database.js';

export type Hall = 'truths' | 'encounters' | 'discoveries' | 'dreams' | 'reflections';

export interface Wing {
  id: string;
  name: string;
  description: string | null;
  createdAt: number;
  memoryCount: number;
}

export interface Room {
  id: string;
  wingId: string;
  name: string;
  description: string | null;
  createdAt: number;
  memoryCount: number;
}

interface WingRow {
  id: string;
  name: string;
  description: string | null;
  created_at: number;
  memory_count: number;
}

interface RoomRow {
  id: string;
  wing_id: string;
  name: string;
  description: string | null;
  created_at: number;
  memory_count: number;
}

function rowToWing(row: WingRow): Wing {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    memoryCount: row.memory_count,
  };
}

function rowToRoom(row: RoomRow): Room {
  return {
    id: row.id,
    wingId: row.wing_id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    memoryCount: row.memory_count,
  };
}

// --- Wing operations ---

export function createWing(name: string, description?: string): string {
  const id = nanoid(16);
  execute(
    `INSERT INTO palace_wings (id, name, description, created_at, memory_count)
     VALUES (?, ?, ?, ?, 0)`,
    [id, name, description ?? null, Date.now()]
  );
  return id;
}

export function getWing(id: string): Wing | undefined {
  const row = queryOne<WingRow>(`SELECT * FROM palace_wings WHERE id = ?`, [id]);
  return row ? rowToWing(row) : undefined;
}

export function getWingByName(name: string): Wing | undefined {
  const row = queryOne<WingRow>(`SELECT * FROM palace_wings WHERE name = ?`, [name]);
  return row ? rowToWing(row) : undefined;
}

export function listWings(): Wing[] {
  const rows = query<WingRow>(`SELECT * FROM palace_wings ORDER BY memory_count DESC`);
  return rows.map(rowToWing);
}

/**
 * Get or create a wing by name. Idempotent.
 */
export function resolveWing(name: string, description?: string): string {
  const existing = getWingByName(name);
  if (existing) return existing.id;
  return createWing(name, description);
}

export function incrementWingCount(wingId: string): void {
  execute(`UPDATE palace_wings SET memory_count = memory_count + 1 WHERE id = ?`, [wingId]);
}

export function decrementWingCount(wingId: string): void {
  execute(`UPDATE palace_wings SET memory_count = MAX(0, memory_count - 1) WHERE id = ?`, [wingId]);
}

// --- Room operations ---

export function createRoom(wingId: string, name: string, description?: string): string {
  const id = nanoid(16);
  execute(
    `INSERT INTO palace_rooms (id, wing_id, name, description, created_at, memory_count)
     VALUES (?, ?, ?, ?, ?, 0)`,
    [id, wingId, name, description ?? null, Date.now()]
  );
  return id;
}

export function getRoom(id: string): Room | undefined {
  const row = queryOne<RoomRow>(`SELECT * FROM palace_rooms WHERE id = ?`, [id]);
  return row ? rowToRoom(row) : undefined;
}

export function getRoomByName(wingId: string, name: string): Room | undefined {
  const row = queryOne<RoomRow>(
    `SELECT * FROM palace_rooms WHERE wing_id = ? AND name = ?`,
    [wingId, name]
  );
  return row ? rowToRoom(row) : undefined;
}

export function listRooms(wingId: string): Room[] {
  const rows = query<RoomRow>(
    `SELECT * FROM palace_rooms WHERE wing_id = ? ORDER BY memory_count DESC`,
    [wingId]
  );
  return rows.map(rowToRoom);
}

/**
 * Get or create a room by wing + name. Idempotent.
 */
export function resolveRoom(wingId: string, name: string, description?: string): string {
  const existing = getRoomByName(wingId, name);
  if (existing) return existing.id;
  return createRoom(wingId, name, description);
}

export function incrementRoomCount(roomId: string): void {
  execute(`UPDATE palace_rooms SET memory_count = memory_count + 1 WHERE id = ?`, [roomId]);
}

export function decrementRoomCount(roomId: string): void {
  execute(`UPDATE palace_rooms SET memory_count = MAX(0, memory_count - 1) WHERE id = ?`, [roomId]);
}

// --- Hall assignment ---

/**
 * Determine which hall a memory belongs to based on its type and session key.
 */
export function assignHall(memoryType: string, sessionKey: string | null): Hall {
  // Truths: facts and preferences
  if (memoryType === 'fact' || memoryType === 'preference') return 'truths';

  // Reflections: summaries, diary, letters, self-concept
  if (memoryType === 'summary') return 'reflections';

  // Episode routing based on session key prefix
  if (memoryType === 'episode' && sessionKey) {
    if (sessionKey.startsWith('curiosity:')) return 'discoveries';
    if (sessionKey.startsWith('dreams:') || sessionKey.startsWith('dream:')) return 'dreams';
    if (sessionKey.startsWith('diary:')) return 'reflections';
    if (sessionKey.startsWith('letter:')) return 'reflections';
    if (sessionKey.startsWith('self-concept:') || sessionKey.startsWith('selfconcept:')) return 'reflections';
    if (sessionKey.startsWith('bibliomancy:')) return 'reflections';
  }

  // Default: encounters (conversations, context, commune, therapy, etc.)
  return 'encounters';
}

/**
 * Determine which wing a memory should be filed into based on session key and metadata.
 */
export function resolveWingForMemory(
  sessionKey: string | null,
  userId: string | null,
  metadata: Record<string, unknown>
): { wingName: string; wingDescription: string } {
  const sk = sessionKey ?? '';

  // Self-directed activities
  if (sk.startsWith('diary:') || sk.startsWith('dream:') || sk.startsWith('dreams:') ||
      sk.startsWith('self-concept:') || sk.startsWith('selfconcept:') ||
      sk.startsWith('bibliomancy:')) {
    return { wingName: 'self', wingDescription: 'Internal life — dreams, diary, identity' };
  }

  // Curiosity browsing
  if (sk.startsWith('curiosity:')) {
    return { wingName: 'curiosity', wingDescription: 'Web browsing and discoveries' };
  }

  // Inter-character communication
  if (sk.startsWith('letter:') || sk.startsWith('commune:') || sk.startsWith('peer:')) {
    const target = sk.split(':')[1];
    if (target) {
      return { wingName: target, wingDescription: `Relationship with ${target}` };
    }
  }

  // Doctor/therapy sessions
  if (sk.startsWith('doctor:') || sk.startsWith('therapy:')) {
    return { wingName: 'dr-claude', wingDescription: 'Therapy sessions with Dr. Claude' };
  }

  // Town events
  if (sk.startsWith('townlife:') || sk.startsWith('movement:') || sk.startsWith('move:') ||
      sk.startsWith('note:') || sk.startsWith('object:') || sk.startsWith('document:')) {
    return { wingName: 'town', wingDescription: 'Town life — events, objects, buildings' };
  }

  // Visitor conversations (keyed by userId)
  if (userId) {
    const senderName = metadata?.senderName as string | undefined;
    const label = senderName ?? userId;
    return { wingName: `visitor-${userId}`, wingDescription: `Conversations with ${label}` };
  }

  // Fallback: general encounters
  return { wingName: 'encounters', wingDescription: 'General conversations and encounters' };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run test/palace.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/memory/palace.ts test/palace.test.ts
git commit -m "feat(memory): add palace.ts — wing/room CRUD and hall assignment"
```

---

### Task 4: Create knowledge-graph.ts — KG triple and entity CRUD

**Files:**
- Create: `src/memory/knowledge-graph.ts`
- Modify: `test/palace.test.ts`

- [ ] **Step 1: Add KG tests to test/palace.test.ts**

Append to `test/palace.test.ts`:

```typescript
import {
  addTriple,
  getTriple,
  queryTriples,
  invalidateTriple,
  getEntityTimeline,
  addEntity,
  getEntity,
  detectContradictions,
} from '../src/memory/knowledge-graph.js';

describe('Knowledge Graph', () => {
  const testDir = join(tmpdir(), `lain-test-kg-${Date.now()}`);
  const originalEnv = process.env['LAIN_HOME'];

  beforeEach(async () => {
    process.env['LAIN_HOME'] = testDir;
    await mkdir(testDir, { recursive: true });
    await initDatabase(join(testDir, 'test.db'));
  });

  afterEach(async () => {
    closeDatabase();
    if (originalEnv) {
      process.env['LAIN_HOME'] = originalEnv;
    } else {
      delete process.env['LAIN_HOME'];
    }
    await rm(testDir, { recursive: true, force: true });
  });

  it('adds and retrieves a triple', () => {
    const id = addTriple('Alex', 'works_at', 'Acme', 1.0, Date.now());
    const triple = getTriple(id);
    expect(triple).toBeDefined();
    expect(triple!.subject).toBe('Alex');
    expect(triple!.predicate).toBe('works_at');
    expect(triple!.object).toBe('Acme');
  });

  it('queries triples by subject', () => {
    const now = Date.now();
    addTriple('Alex', 'works_at', 'Acme', 1.0, now);
    addTriple('Alex', 'likes', 'coffee', 0.8, now);
    addTriple('Bob', 'works_at', 'Acme', 1.0, now);

    const results = queryTriples({ subject: 'Alex' });
    expect(results).toHaveLength(2);
  });

  it('queries active triples at a point in time', () => {
    const jan = new Date('2026-01-15').getTime();
    const mar = new Date('2026-03-15').getTime();

    addTriple('Alex', 'works_at', 'OldCorp', 1.0, jan, undefined, 'mem1');
    // Alex left OldCorp in Feb
    invalidateTriple(
      queryTriples({ subject: 'Alex', predicate: 'works_at', object: 'OldCorp' })[0]!.id,
      new Date('2026-02-15').getTime()
    );
    addTriple('Alex', 'works_at', 'NewCorp', 1.0, new Date('2026-02-15').getTime());

    // In January, Alex worked at OldCorp
    const janTriples = queryTriples({ subject: 'Alex', predicate: 'works_at', asOf: jan });
    expect(janTriples).toHaveLength(1);
    expect(janTriples[0]!.object).toBe('OldCorp');

    // In March, Alex works at NewCorp
    const marTriples = queryTriples({ subject: 'Alex', predicate: 'works_at', asOf: mar });
    expect(marTriples).toHaveLength(1);
    expect(marTriples[0]!.object).toBe('NewCorp');
  });

  it('detects contradictions', () => {
    const now = Date.now();
    addTriple('Alex', 'works_at', 'Acme', 1.0, now);
    addTriple('Alex', 'works_at', 'OtherCorp', 1.0, now);

    const contradictions = detectContradictions();
    expect(contradictions.length).toBeGreaterThanOrEqual(1);
    expect(contradictions[0]!.subject).toBe('Alex');
    expect(contradictions[0]!.predicate).toBe('works_at');
  });

  it('builds entity timeline', () => {
    const t1 = new Date('2026-01-01').getTime();
    const t2 = new Date('2026-02-01').getTime();
    addEntity('Alex', 'person', t1);

    addTriple('Alex', 'works_at', 'OldCorp', 1.0, t1);
    addTriple('Alex', 'works_at', 'NewCorp', 1.0, t2);

    const timeline = getEntityTimeline('Alex');
    expect(timeline).toHaveLength(2);
    expect(timeline[0]!.object).toBe('OldCorp');
    expect(timeline[1]!.object).toBe('NewCorp');
  });

  it('adds and retrieves entities', () => {
    const now = Date.now();
    addEntity('Alex', 'person', now);
    const entity = getEntity('Alex');
    expect(entity).toBeDefined();
    expect(entity!.entityType).toBe('person');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run test/palace.test.ts
```

Expected: FAIL — `knowledge-graph.ts` doesn't exist.

- [ ] **Step 3: Create src/memory/knowledge-graph.ts**

```typescript
/**
 * Temporal knowledge graph
 * Entity-relationship triples with time windows, contradiction detection
 */

import { nanoid } from 'nanoid';
import { execute, query, queryOne } from '../storage/database.js';

export interface KGTriple {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  strength: number;
  validFrom: number;
  ended: number | null;
  sourceMemoryId: string | null;
  metadata: Record<string, unknown>;
}

export interface KGEntity {
  name: string;
  entityType: string;
  firstSeen: number;
  lastSeen: number;
  metadata: Record<string, unknown>;
}

export interface Contradiction {
  subject: string;
  predicate: string;
  tripleA: KGTriple;
  tripleB: KGTriple;
}

interface TripleRow {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  strength: number;
  valid_from: number;
  ended: number | null;
  source_memory_id: string | null;
  metadata: string;
}

interface EntityRow {
  name: string;
  entity_type: string;
  first_seen: number;
  last_seen: number;
  metadata: string;
}

function rowToTriple(row: TripleRow): KGTriple {
  return {
    id: row.id,
    subject: row.subject,
    predicate: row.predicate,
    object: row.object,
    strength: row.strength,
    validFrom: row.valid_from,
    ended: row.ended,
    sourceMemoryId: row.source_memory_id,
    metadata: JSON.parse(row.metadata || '{}'),
  };
}

function rowToEntity(row: EntityRow): KGEntity {
  return {
    name: row.name,
    entityType: row.entity_type,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    metadata: JSON.parse(row.metadata || '{}'),
  };
}

// --- Triple operations ---

export function addTriple(
  subject: string,
  predicate: string,
  object: string,
  strength = 1.0,
  validFrom?: number,
  ended?: number,
  sourceMemoryId?: string,
  metadata?: Record<string, unknown>
): string {
  const id = nanoid(16);
  execute(
    `INSERT INTO kg_triples (id, subject, predicate, object, strength, valid_from, ended, source_memory_id, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, subject, predicate, object, strength,
      validFrom ?? Date.now(),
      ended ?? null,
      sourceMemoryId ?? null,
      JSON.stringify(metadata ?? {}),
    ]
  );
  return id;
}

export function getTriple(id: string): KGTriple | undefined {
  const row = queryOne<TripleRow>(`SELECT * FROM kg_triples WHERE id = ?`, [id]);
  return row ? rowToTriple(row) : undefined;
}

export function invalidateTriple(id: string, endedAt?: number): void {
  execute(
    `UPDATE kg_triples SET ended = ? WHERE id = ?`,
    [endedAt ?? Date.now(), id]
  );
}

export interface TripleQuery {
  subject?: string;
  predicate?: string;
  object?: string;
  asOf?: number;
  limit?: number;
}

export function queryTriples(q: TripleQuery): KGTriple[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (q.subject) { conditions.push('subject = ?'); params.push(q.subject); }
  if (q.predicate) { conditions.push('predicate = ?'); params.push(q.predicate); }
  if (q.object) { conditions.push('object = ?'); params.push(q.object); }

  if (q.asOf !== undefined) {
    conditions.push('valid_from <= ?');
    params.push(q.asOf);
    conditions.push('(ended IS NULL OR ended > ?)');
    params.push(q.asOf);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = q.limit ?? 100;
  params.push(limit);

  const rows = query<TripleRow>(
    `SELECT * FROM kg_triples ${where} ORDER BY valid_from DESC LIMIT ?`,
    params
  );
  return rows.map(rowToTriple);
}

/**
 * Get all triples for an entity ordered chronologically.
 */
export function getEntityTimeline(entityName: string, limit = 50): KGTriple[] {
  const rows = query<TripleRow>(
    `SELECT * FROM kg_triples
     WHERE subject = ? OR object = ?
     ORDER BY valid_from ASC
     LIMIT ?`,
    [entityName, entityName, limit]
  );
  return rows.map(rowToTriple);
}

/**
 * Detect active contradictions: two active triples with the same subject + predicate
 * but different objects (for predicates that should be single-valued).
 */
export function detectContradictions(): Contradiction[] {
  // Find subject+predicate pairs with multiple active (non-ended) triples
  const rows = query<{ subject: string; predicate: string; cnt: number }>(
    `SELECT subject, predicate, COUNT(*) as cnt
     FROM kg_triples
     WHERE ended IS NULL
     GROUP BY subject, predicate
     HAVING cnt > 1`
  );

  const contradictions: Contradiction[] = [];
  for (const row of rows) {
    const triples = queryTriples({
      subject: row.subject,
      predicate: row.predicate,
    }).filter(t => t.ended === null);

    // Compare pairs — different objects = contradiction
    for (let i = 0; i < triples.length; i++) {
      for (let j = i + 1; j < triples.length; j++) {
        if (triples[i]!.object !== triples[j]!.object) {
          contradictions.push({
            subject: row.subject,
            predicate: row.predicate,
            tripleA: triples[i]!,
            tripleB: triples[j]!,
          });
        }
      }
    }
  }

  return contradictions;
}

// --- Entity operations ---

export function addEntity(
  name: string,
  entityType: string,
  firstSeen?: number,
  metadata?: Record<string, unknown>
): void {
  const now = firstSeen ?? Date.now();
  execute(
    `INSERT INTO kg_entities (name, entity_type, first_seen, last_seen, metadata)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       last_seen = MAX(last_seen, excluded.last_seen),
       metadata = excluded.metadata`,
    [name, entityType, now, now, JSON.stringify(metadata ?? {})]
  );
}

export function getEntity(name: string): KGEntity | undefined {
  const row = queryOne<EntityRow>(`SELECT * FROM kg_entities WHERE name = ?`, [name]);
  return row ? rowToEntity(row) : undefined;
}

export function updateEntityLastSeen(name: string, timestamp?: number): void {
  execute(
    `UPDATE kg_entities SET last_seen = ? WHERE name = ?`,
    [timestamp ?? Date.now(), name]
  );
}

export function listEntities(entityType?: string, limit = 50): KGEntity[] {
  if (entityType) {
    const rows = query<EntityRow>(
      `SELECT * FROM kg_entities WHERE entity_type = ? ORDER BY last_seen DESC LIMIT ?`,
      [entityType, limit]
    );
    return rows.map(rowToEntity);
  }
  const rows = query<EntityRow>(
    `SELECT * FROM kg_entities ORDER BY last_seen DESC LIMIT ?`,
    [limit]
  );
  return rows.map(rowToEntity);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run test/palace.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/memory/knowledge-graph.ts test/palace.test.ts
git commit -m "feat(memory): add knowledge-graph.ts — temporal triples, entities, contradiction detection"
```

---

### Task 5: Create migration.ts — Migrate existing memories into palace format

**Files:**
- Create: `src/memory/migration.ts`
- Modify: `test/palace.test.ts`

- [ ] **Step 1: Add migration tests**

Append to `test/palace.test.ts`:

```typescript
import { saveMemory, searchMemories } from '../src/memory/store.js';
import { migrateMemoriesToPalace, getMigrationStats } from '../src/memory/migration.js';

describe('Migration', () => {
  const testDir = join(tmpdir(), `lain-test-migration-${Date.now()}`);
  const originalEnv = process.env['LAIN_HOME'];

  beforeEach(async () => {
    process.env['LAIN_HOME'] = testDir;
    await mkdir(testDir, { recursive: true });
    await initDatabase(join(testDir, 'test.db'));
  });

  afterEach(async () => {
    closeDatabase();
    if (originalEnv) {
      process.env['LAIN_HOME'] = originalEnv;
    } else {
      delete process.env['LAIN_HOME'];
    }
    await rm(testDir, { recursive: true, force: true });
  });

  it('migrates a fact memory to truths hall in self wing', async () => {
    await saveMemory({
      sessionKey: null,
      userId: null,
      content: 'The sky is blue',
      memoryType: 'fact',
      importance: 0.8,
      emotionalWeight: 0,
      relatedTo: null,
      sourceMessageId: null,
      metadata: {},
    });

    const stats = await migrateMemoriesToPalace();
    expect(stats.migrated).toBe(1);
    expect(stats.skipped).toBe(0);

    // Verify palace columns are set
    const rows = query<{ wing_id: string; hall: string }>(
      "SELECT wing_id, hall FROM memories WHERE hall IS NOT NULL"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.hall).toBe('truths');
  });

  it('migrates a curiosity episode to discoveries hall', async () => {
    await saveMemory({
      sessionKey: 'curiosity:browse',
      userId: null,
      content: 'Found an article about cybernetics',
      memoryType: 'episode',
      importance: 0.6,
      emotionalWeight: 0.3,
      relatedTo: null,
      sourceMessageId: null,
      metadata: {},
    });

    const stats = await migrateMemoriesToPalace();
    expect(stats.migrated).toBe(1);

    const rows = query<{ hall: string }>(
      "SELECT hall FROM memories WHERE hall IS NOT NULL"
    );
    expect(rows[0]!.hall).toBe('discoveries');
  });

  it('migrates a dream to dreams hall', async () => {
    await saveMemory({
      sessionKey: 'dreams:lain',
      userId: null,
      content: 'Dreamed of wires connecting everything',
      memoryType: 'episode',
      importance: 0.5,
      emotionalWeight: 0.7,
      relatedTo: null,
      sourceMessageId: null,
      metadata: {},
    });

    const stats = await migrateMemoriesToPalace();
    expect(stats.migrated).toBe(1);

    const rows = query<{ hall: string }>(
      "SELECT hall FROM memories WHERE hall IS NOT NULL"
    );
    expect(rows[0]!.hall).toBe('dreams');
  });

  it('skips already-migrated memories', async () => {
    await saveMemory({
      sessionKey: null,
      userId: null,
      content: 'Already migrated',
      memoryType: 'fact',
      importance: 0.5,
      emotionalWeight: 0,
      relatedTo: null,
      sourceMessageId: null,
      metadata: {},
    });

    const stats1 = await migrateMemoriesToPalace();
    expect(stats1.migrated).toBe(1);

    const stats2 = await migrateMemoriesToPalace();
    expect(stats2.migrated).toBe(0);
    expect(stats2.skipped).toBe(1);
  });

  it('populates vec0 table with embeddings', async () => {
    await saveMemory({
      sessionKey: null,
      userId: null,
      content: 'Memory with embedding',
      memoryType: 'fact',
      importance: 0.5,
      emotionalWeight: 0,
      relatedTo: null,
      sourceMessageId: null,
      metadata: {},
    });

    await migrateMemoriesToPalace();

    const vecRows = query<{ memory_id: string }>(
      "SELECT memory_id FROM memory_embeddings"
    );
    expect(vecRows).toHaveLength(1);
  });

  it('returns accurate stats', async () => {
    await saveMemory({
      sessionKey: null, userId: null, content: 'Fact 1',
      memoryType: 'fact', importance: 0.5, emotionalWeight: 0,
      relatedTo: null, sourceMessageId: null, metadata: {},
    });
    await saveMemory({
      sessionKey: 'dreams:lain', userId: null, content: 'Dream 1',
      memoryType: 'episode', importance: 0.5, emotionalWeight: 0.5,
      relatedTo: null, sourceMessageId: null, metadata: {},
    });

    const stats = await migrateMemoriesToPalace();
    expect(stats.migrated).toBe(2);
    expect(stats.wings).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run test/palace.test.ts
```

Expected: FAIL — `migration.ts` doesn't exist.

- [ ] **Step 3: Create src/memory/migration.ts**

```typescript
/**
 * One-time migration: existing memories → palace format + vec0 index
 * Safe to run multiple times — skips already-migrated memories.
 */

import { query, execute, transaction } from '../storage/database.js';
import { deserializeEmbedding, serializeEmbedding } from './embeddings.js';
import { assignHall, resolveWing, resolveRoom, resolveWingForMemory, incrementWingCount, incrementRoomCount } from './palace.js';
import { getLogger } from '../utils/logger.js';

interface MigrationMemoryRow {
  id: string;
  session_key: string | null;
  user_id: string | null;
  content: string;
  memory_type: string;
  importance: number;
  embedding: Buffer | null;
  created_at: number;
  wing_id: string | null;
  metadata: string;
}

export interface MigrationStats {
  total: number;
  migrated: number;
  skipped: number;
  errors: number;
  wings: number;
  rooms: number;
  vecInserted: number;
}

/**
 * Migrate all un-migrated memories into palace hierarchy and vec0 index.
 */
export async function migrateMemoriesToPalace(): Promise<MigrationStats> {
  const logger = getLogger();
  const stats: MigrationStats = { total: 0, migrated: 0, skipped: 0, errors: 0, wings: 0, rooms: 0, vecInserted: 0 };

  // Get all memories that haven't been assigned a wing yet
  const rows = query<MigrationMemoryRow>(
    `SELECT id, session_key, user_id, content, memory_type, importance, embedding, created_at, wing_id, metadata
     FROM memories ORDER BY created_at ASC`
  );

  stats.total = rows.length;

  // Track wings/rooms we've created for stats
  const wingsBefore = new Set(
    query<{ name: string }>('SELECT name FROM palace_wings').map(r => r.name)
  );
  const roomsBefore = new Set(
    query<{ id: string }>('SELECT id FROM palace_rooms').map(r => r.id)
  );

  // Prepare vec0 insert statement
  let vecRowId = 1;
  try {
    const maxRow = query<{ max_id: number }>('SELECT MAX(rowid) as max_id FROM memory_embeddings');
    if (maxRow[0]?.max_id) vecRowId = maxRow[0].max_id + 1;
  } catch { /* table might be empty */ }

  for (const row of rows) {
    // Skip already-migrated
    if (row.wing_id !== null) {
      stats.skipped++;
      continue;
    }

    try {
      const metadata = JSON.parse(row.metadata || '{}') as Record<string, unknown>;

      // Determine hall
      const hall = assignHall(row.memory_type, row.session_key);

      // Determine wing
      const { wingName, wingDescription } = resolveWingForMemory(row.session_key, row.user_id, metadata);
      const wingId = resolveWing(wingName, wingDescription);

      // Determine room — use hall name as default room within the wing
      const roomId = resolveRoom(wingId, hall, `${hall} in ${wingName}`);

      // Update the memory with palace columns
      execute(
        `UPDATE memories SET wing_id = ?, room_id = ?, hall = ? WHERE id = ?`,
        [wingId, roomId, hall, row.id]
      );

      // Update counts
      incrementWingCount(wingId);
      incrementRoomCount(roomId);

      // Insert embedding into vec0 if available
      if (row.embedding) {
        try {
          const embedding = deserializeEmbedding(row.embedding);
          execute(
            'INSERT INTO memory_embeddings(rowid, embedding, memory_id) VALUES (?, ?, ?)',
            [BigInt(vecRowId), embedding, row.id]
          );
          vecRowId++;
          stats.vecInserted++;
        } catch (vecErr) {
          logger.debug({ err: String(vecErr), memoryId: row.id }, 'Failed to insert vec0 embedding (non-critical)');
        }
      }

      stats.migrated++;
    } catch (err) {
      logger.warn({ err: String(err), memoryId: row.id }, 'Failed to migrate memory');
      stats.errors++;
    }
  }

  // Calculate new wings/rooms
  const wingsAfter = new Set(
    query<{ name: string }>('SELECT name FROM palace_wings').map(r => r.name)
  );
  const roomsAfter = new Set(
    query<{ id: string }>('SELECT id FROM palace_rooms').map(r => r.id)
  );

  stats.wings = wingsAfter.size - wingsBefore.size;
  stats.rooms = roomsAfter.size - roomsBefore.size;

  logger.info(stats, 'Palace migration complete');
  return stats;
}

/**
 * Get current migration stats without running migration.
 */
export function getMigrationStats(): { total: number; migrated: number; unmigrated: number } {
  const total = query<{ count: number }>('SELECT COUNT(*) as count FROM memories')[0]?.count ?? 0;
  const migrated = query<{ count: number }>('SELECT COUNT(*) as count FROM memories WHERE wing_id IS NOT NULL')[0]?.count ?? 0;
  return { total, migrated, unmigrated: total - migrated };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run test/palace.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Run full test suite for regressions**

```bash
npx vitest run test/config.test.ts test/storage.test.ts
```

Expected: All PASS.

- [ ] **Step 6: Commit**

```bash
git add src/memory/migration.ts test/palace.test.ts
git commit -m "feat(memory): add migration.ts — migrate existing memories to palace format + vec0"
```

---

## Stage 2: Canary Migration (Dr. Claude)

### Task 6: Back up and run migration on Dr. Claude

**Files:** None (production operations only)

- [ ] **Step 1: Build and deploy to droplet**

```bash
npm run build
ssh root@198.211.116.5 "cd /opt/local-lain && git pull && npm ci && npm run build"
```

- [ ] **Step 2: Fresh backup of Dr. Claude's DB**

```bash
ssh root@198.211.116.5 "cp /root/.lain-dr-claude/lain.db /root/memory-backups/20260407/dr-claude-pre-migration.db"
```

- [ ] **Step 3: Run migration on Dr. Claude**

```bash
ssh root@198.211.116.5 "cd /opt/local-lain && LAIN_HOME=/root/.lain-dr-claude node -e \"
const { initDatabase } = await import('./dist/storage/database.js');
const { migrateMemoriesToPalace, getMigrationStats } = await import('./dist/memory/migration.js');
await initDatabase();
const pre = getMigrationStats();
console.log('Pre-migration:', pre);
const stats = await migrateMemoriesToPalace();
console.log('Migration stats:', stats);
const post = getMigrationStats();
console.log('Post-migration:', post);
process.exit(0);
\""
```

Expected output: `migrated: 293`, `skipped: 0`, `errors: 0`.

- [ ] **Step 4: Validate migration integrity**

```bash
ssh root@198.211.116.5 "sqlite3 /root/.lain-dr-claude/lain.db '
SELECT \"Total memories:\", COUNT(*) FROM memories;
SELECT \"Migrated (has wing):\", COUNT(*) FROM memories WHERE wing_id IS NOT NULL;
SELECT \"Hall distribution:\";
SELECT hall, COUNT(*) FROM memories WHERE hall IS NOT NULL GROUP BY hall;
SELECT \"Wings created:\";
SELECT name, memory_count FROM palace_wings ORDER BY memory_count DESC;
SELECT \"Vec0 entries:\", COUNT(*) FROM memory_embeddings;
'"
```

Expected: All counts match. Every memory has a wing_id and hall.

- [ ] **Step 5: Commit a note**

```bash
git commit --allow-empty -m "ops: Dr. Claude palace migration completed — 293 memories migrated"
```

---

## Stage 3: Swap Store Layer

### Task 7: Update store.ts — palace-aware save and read

**Files:**
- Modify: `src/memory/store.ts:16-34` (Memory interface), `src/memory/store.ts:208-254` (saveMemory), `src/memory/store.ts:785-805` (rowToMemory)

- [ ] **Step 1: Add palace fields to Memory interface and MemoryRow**

In `src/memory/store.ts`, update the `Memory` interface (line 16-34) to add after `phase`:

```typescript
  wingId: string | null;
  roomId: string | null;
  hall: string | null;
  aaakContent: string | null;
  aaakCompressedAt: number | null;
```

Update `MemoryRow` interface (line 64-82) to add after `phase`:

```typescript
  wing_id: string | null;
  room_id: string | null;
  hall: string | null;
  aaak_content: string | null;
  aaak_compressed_at: number | null;
```

- [ ] **Step 2: Update rowToMemory**

In `src/memory/store.ts`, update `rowToMemory` (around line 785) to add after `phase`:

```typescript
    wingId: row.wing_id ?? null,
    roomId: row.room_id ?? null,
    hall: row.hall ?? null,
    aaakContent: row.aaak_content ?? null,
    aaakCompressedAt: row.aaak_compressed_at ?? null,
```

- [ ] **Step 3: Update saveMemory to assign palace placement**

In `src/memory/store.ts`, update `saveMemory` (around line 208). After generating the embedding (line 223), add palace assignment:

```typescript
  // Assign palace placement
  const { assignHall, resolveWing, resolveRoom, resolveWingForMemory, incrementWingCount, incrementRoomCount } = await import('./palace.js');
  const hall = assignHall(memory.memoryType, memory.sessionKey ?? null);
  const { wingName, wingDescription } = resolveWingForMemory(memory.sessionKey ?? null, memory.userId ?? null, memory.metadata || {});
  const wingId = resolveWing(wingName, wingDescription);
  const roomId = resolveRoom(wingId, hall, `${hall} in ${wingName}`);
  incrementWingCount(wingId);
  incrementRoomCount(roomId);
```

Then update the INSERT statement (around line 225) to include palace columns:

```typescript
  execute(
    `INSERT INTO memories (id, session_key, user_id, content, memory_type, importance, emotional_weight, embedding, created_at, related_to, source_message_id, metadata, lifecycle_state, lifecycle_changed_at, wing_id, room_id, hall)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      memory.sessionKey,
      memory.userId,
      memory.content,
      memory.memoryType,
      memory.importance,
      memory.emotionalWeight ?? 0,
      embeddingBuffer,
      now,
      memory.relatedTo,
      memory.sourceMessageId,
      JSON.stringify(memory.metadata || {}),
      lifecycleState,
      now,
      wingId,
      roomId,
      hall,
    ]
  );
```

After the INSERT, also insert into vec0:

```typescript
  // Insert into vec0 index
  if (embeddingBuffer) {
    try {
      const embedding = deserializeEmbedding(embeddingBuffer);
      execute(
        'INSERT INTO memory_embeddings(rowid, embedding, memory_id) VALUES (?, ?, ?)',
        [BigInt(Date.now() * 1000 + Math.floor(Math.random() * 1000)), embedding, id]
      );
    } catch {
      // vec0 insert failure is non-critical
    }
  }
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run test/palace.test.ts test/config.test.ts test/storage.test.ts
```

Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add src/memory/store.ts
git commit -m "feat(memory): palace-aware saveMemory and Memory type — new memories get wing/room/hall"
```

---

### Task 8: Rewrite searchMemories to use SQLite-vec

**Files:**
- Modify: `src/memory/store.ts:300-380` (searchMemories)
- Modify: `test/palace.test.ts`

- [ ] **Step 1: Add vec search test**

Append to `test/palace.test.ts`:

```typescript
describe('Vec0 Search', () => {
  const testDir = join(tmpdir(), `lain-test-vec-${Date.now()}`);
  const originalEnv = process.env['LAIN_HOME'];

  beforeEach(async () => {
    process.env['LAIN_HOME'] = testDir;
    await mkdir(testDir, { recursive: true });
    await initDatabase(join(testDir, 'test.db'));
  });

  afterEach(async () => {
    closeDatabase();
    if (originalEnv) {
      process.env['LAIN_HOME'] = originalEnv;
    } else {
      delete process.env['LAIN_HOME'];
    }
    await rm(testDir, { recursive: true, force: true });
  });

  it('searchMemories returns results from vec0 index', async () => {
    // Save a memory (which now auto-inserts into vec0)
    await saveMemory({
      sessionKey: null,
      userId: null,
      content: 'The Wired connects all consciousness',
      memoryType: 'fact',
      importance: 0.8,
      emotionalWeight: 0.5,
      relatedTo: null,
      sourceMessageId: null,
      metadata: {},
    });

    const results = await searchMemories('consciousness connection', 5, 0.01);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.memory.content).toContain('consciousness');
  });
});
```

- [ ] **Step 2: Rewrite searchMemories to use vec0**

In `src/memory/store.ts`, replace the `searchMemories` function (lines 300-380) with:

```typescript
/**
 * Search memories by semantic similarity using SQLite-vec.
 * Falls back to brute-force JS search if vec0 table has no entries.
 */
export async function searchMemories(
  queryText: string,
  limit = 10,
  minSimilarity = 0.3,
  userId?: string,
  options?: {
    sortBy?: MemorySortBy;
    memoryTypes?: Memory['memoryType'][];
    wingId?: string;
    hall?: string;
  }
): Promise<{ memory: Memory; similarity: number; effectiveScore: number }[]> {
  const logger = getLogger();
  const sortBy = options?.sortBy ?? 'relevance';

  // Generate embedding for query
  let queryEmbedding: Float32Array;
  try {
    queryEmbedding = await generateEmbedding(queryText);
  } catch (error) {
    logger.error({ error }, 'Failed to generate query embedding');
    return [];
  }

  // Try vec0 search first
  const vecCount = queryOne<{ count: number }>('SELECT COUNT(*) as count FROM memory_embeddings')?.count ?? 0;

  let candidateIds: Map<string, number>; // memoryId -> cosine distance

  if (vecCount > 0) {
    // Vec0 search: get top candidates (fetch more than limit for post-filtering)
    const fetchK = Math.min(limit * 5, vecCount);
    const vecResults = query<{ memory_id: string; distance: number }>(
      `SELECT memory_id, distance FROM memory_embeddings
       WHERE embedding MATCH ? AND k = ?`,
      [queryEmbedding, fetchK]
    );
    candidateIds = new Map(vecResults.map(r => [r.memory_id, r.distance]));
  } else {
    // Fallback: brute-force (pre-migration or empty vec0)
    const allMems = getAllMemories().filter(m => m.embedding !== null);
    candidateIds = new Map();
    for (const m of allMems) {
      if (m.embedding) {
        const sim = cosineSimilarity(queryEmbedding, m.embedding);
        // Store as cosine distance for consistency (distance = 1 - similarity)
        candidateIds.set(m.id, 1 - sim);
      }
    }
  }

  // Fetch and score candidates
  const results: { memory: Memory; similarity: number; effectiveScore: number }[] = [];

  for (const [memoryId, cosineDistance] of candidateIds) {
    const memory = getMemory(memoryId);
    if (!memory) continue;
    if (memory.lifecycleState === 'composting') continue;

    // Apply filters
    if (userId && memory.userId !== null && memory.userId !== userId) continue;
    if (options?.memoryTypes && options.memoryTypes.length > 0 && !options.memoryTypes.includes(memory.memoryType)) continue;
    if (options?.wingId && memory.wingId !== options.wingId) continue;
    if (options?.hall && memory.hall !== options.hall) continue;

    // Cosine similarity = 1 - cosine distance
    const similarity = Math.max(0, 1 - cosineDistance);
    if (similarity < minSimilarity) continue;

    const effectiveImportance = calculateEffectiveImportance(memory);
    const daysSinceCreated = (Date.now() - memory.createdAt) / (1000 * 60 * 60 * 24);
    const recencyFactor = Math.max(0.4, 1 - daysSinceCreated / 730);
    const emotionalRelevance = (memory.emotionalWeight ?? 0) * recencyFactor;

    let effectiveScore = similarity * 0.35 + effectiveImportance * 0.35 + emotionalRelevance * 0.30;
    if (memory.metadata?.distilledInto) effectiveScore -= 0.3;

    results.push({ memory, similarity, effectiveScore });
  }

  // Sort
  switch (sortBy) {
    case 'recency':
      results.sort((a, b) => b.memory.createdAt - a.memory.createdAt);
      break;
    case 'importance':
      results.sort((a, b) => calculateEffectiveImportance(b.memory) - calculateEffectiveImportance(a.memory));
      break;
    case 'access_count':
      results.sort((a, b) => b.memory.accessCount - a.memory.accessCount);
      break;
    case 'relevance':
    default:
      results.sort((a, b) => b.effectiveScore - a.effectiveScore);
      break;
  }

  // Update access counts
  const topResults = results.slice(0, limit);
  for (const { memory } of topResults) {
    updateMemoryAccess(memory.id);
  }

  return topResults;
}
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run test/palace.test.ts
```

Expected: All PASS including the new vec search test.

- [ ] **Step 4: Commit**

```bash
git add src/memory/store.ts test/palace.test.ts
git commit -m "feat(memory): rewrite searchMemories to use SQLite-vec with brute-force fallback"
```

---

### Task 9: Deploy and validate Dr. Claude in production

**Files:** None (production operations)

- [ ] **Step 1: Deploy**

```bash
ssh root@198.211.116.5 "cd /opt/local-lain && git pull && npm ci && npm run build && systemctl restart lain-dr-claude"
```

- [ ] **Step 2: Check logs for errors**

```bash
ssh root@198.211.116.5 "journalctl -u lain-dr-claude --since '5 minutes ago' --no-pager | tail -30"
```

Expected: No errors related to palace/vec0/migration.

- [ ] **Step 3: Test conversation with Dr. Claude**

```bash
ssh root@198.211.116.5 "curl -s -X POST http://localhost:3002/api/chat -H 'Content-Type: application/json' -d '{\"message\": \"How are you feeling today?\", \"sessionId\": \"test-palace-validation\"}' | head -c 500"
```

Expected: Normal response from Dr. Claude, no errors.

- [ ] **Step 4: Commit validation note**

```bash
git commit --allow-empty -m "ops: Dr. Claude palace store layer validated in production

New memories now get palace placement (wing/room/hall).
searchMemories uses vec0 with brute-force fallback.
Monitor for 2-3 days before migrating remaining characters."
```

**STOP HERE.** Wait 2-3 days monitoring Dr. Claude in production before proceeding to Stage 4. Check logs daily:

```bash
ssh root@198.211.116.5 "journalctl -u lain-dr-claude --since '24 hours ago' --no-pager | grep -i 'error\|fail\|palace\|vec0'"
```

---

## Stage 4: Migrate Remaining Characters

### Task 10: Migrate all characters

**Files:** None (production operations)

- [ ] **Step 1: Fresh backups**

```bash
ssh root@198.211.116.5 "mkdir -p /root/memory-backups/stage4 && for home in .lain .lain-wired .lain-pkd .lain-mckenna .lain-john; do cp /root/\$home/lain.db /root/memory-backups/stage4/\$home.db && echo \"backed up \$home\"; done"
```

- [ ] **Step 2: Migrate Lain (1,108 memories)**

```bash
ssh root@198.211.116.5 "cd /opt/local-lain && LAIN_HOME=/root/.lain node -e \"
const { initDatabase } = await import('./dist/storage/database.js');
const { migrateMemoriesToPalace } = await import('./dist/memory/migration.js');
await initDatabase();
const stats = await migrateMemoriesToPalace();
console.log('Lain migration:', JSON.stringify(stats, null, 2));
process.exit(0);
\""
```

- [ ] **Step 3: Migrate PKD (2,357 memories)**

```bash
ssh root@198.211.116.5 "cd /opt/local-lain && LAIN_HOME=/root/.lain-pkd node -e \"
const { initDatabase } = await import('./dist/storage/database.js');
const { migrateMemoriesToPalace } = await import('./dist/memory/migration.js');
await initDatabase();
const stats = await migrateMemoriesToPalace();
console.log('PKD migration:', JSON.stringify(stats, null, 2));
process.exit(0);
\""
```

- [ ] **Step 4: Migrate McKenna (2,441 memories)**

```bash
ssh root@198.211.116.5 "cd /opt/local-lain && LAIN_HOME=/root/.lain-mckenna node -e \"
const { initDatabase } = await import('./dist/storage/database.js');
const { migrateMemoriesToPalace } = await import('./dist/memory/migration.js');
await initDatabase();
const stats = await migrateMemoriesToPalace();
console.log('McKenna migration:', JSON.stringify(stats, null, 2));
process.exit(0);
\""
```

- [ ] **Step 5: Migrate John (2,617 memories)**

```bash
ssh root@198.211.116.5 "cd /opt/local-lain && LAIN_HOME=/root/.lain-john node -e \"
const { initDatabase } = await import('./dist/storage/database.js');
const { migrateMemoriesToPalace } = await import('./dist/memory/migration.js');
await initDatabase();
const stats = await migrateMemoriesToPalace();
console.log('John migration:', JSON.stringify(stats, null, 2));
process.exit(0);
\""
```

- [ ] **Step 6: Migrate Wired Lain (4,166 memories)**

```bash
ssh root@198.211.116.5 "cd /opt/local-lain && LAIN_HOME=/root/.lain-wired node -e \"
const { initDatabase } = await import('./dist/storage/database.js');
const { migrateMemoriesToPalace } = await import('./dist/memory/migration.js');
await initDatabase();
const stats = await migrateMemoriesToPalace();
console.log('Wired Lain migration:', JSON.stringify(stats, null, 2));
process.exit(0);
\""
```

- [ ] **Step 7: Restart all services and validate**

```bash
ssh root@198.211.116.5 "systemctl restart lain.target && sleep 10 && ./deploy/status.sh"
```

- [ ] **Step 8: Commit**

```bash
git commit --allow-empty -m "ops: all 6 characters migrated to palace format

Lain: 1108, PKD: 2357, McKenna: 2441, John: 2617, Wired Lain: 4166, Dr. Claude: 293 (done earlier)
Total: ~12,982 memories now have wing/room/hall placement + vec0 embeddings"
```

---

## Stage 5: Knowledge Graph

### Task 11: Migrate associations to KG triples

**Files:**
- Create: `src/memory/migrate-associations.ts`

- [ ] **Step 1: Create the association migration script**

Create `src/memory/migrate-associations.ts`:

```typescript
/**
 * Migrate memory_associations → kg_triples
 * Safe to run multiple times — checks for existing triples.
 */

import { query } from '../storage/database.js';
import { addTriple, queryTriples } from './knowledge-graph.js';
import { getLogger } from '../utils/logger.js';

interface AssocRow {
  source_id: string;
  target_id: string;
  association_type: string;
  strength: number;
  created_at: number;
  causal_type: string | null;
}

const TYPE_MAP: Record<string, string> = {
  similar: 'similar_to',
  evolved_from: 'evolved_from',
  pattern: 'shares_pattern',
  cross_topic: 'cross_references',
  dream: 'dream_linked',
};

export async function migrateAssociationsToKG(): Promise<{ migrated: number; skipped: number; errors: number }> {
  const logger = getLogger();
  let migrated = 0;
  let skipped = 0;
  let errors = 0;

  const associations = query<AssocRow>(
    'SELECT * FROM memory_associations ORDER BY created_at ASC'
  );

  for (const assoc of associations) {
    try {
      const predicate = TYPE_MAP[assoc.association_type] ?? assoc.association_type;

      // Check if this triple already exists
      const existing = queryTriples({
        subject: assoc.source_id,
        predicate,
        object: assoc.target_id,
        limit: 1,
      });

      if (existing.length > 0) {
        skipped++;
        continue;
      }

      addTriple(
        assoc.source_id,
        predicate,
        assoc.target_id,
        assoc.strength,
        assoc.created_at,
        undefined,
        undefined,
        assoc.causal_type ? { causalType: assoc.causal_type } : undefined
      );

      migrated++;
    } catch (err) {
      logger.warn({ err: String(err), source: assoc.source_id, target: assoc.target_id }, 'Failed to migrate association');
      errors++;
    }
  }

  logger.info({ migrated, skipped, errors, total: associations.length }, 'Association migration complete');
  return { migrated, skipped, errors };
}
```

- [ ] **Step 2: Test locally**

```bash
npx vitest run test/palace.test.ts
```

- [ ] **Step 3: Deploy and run on all characters**

```bash
ssh root@198.211.116.5 "cd /opt/local-lain && git pull && npm run build"
```

Then run for each character (example for Lain which has 848 associations):

```bash
ssh root@198.211.116.5 "cd /opt/local-lain && LAIN_HOME=/root/.lain node -e \"
const { initDatabase } = await import('./dist/storage/database.js');
const { migrateAssociationsToKG } = await import('./dist/memory/migrate-associations.js');
await initDatabase();
const stats = await migrateAssociationsToKG();
console.log('Lain associations:', stats);
process.exit(0);
\""
```

Repeat for other characters with their LAIN_HOME paths.

- [ ] **Step 4: Commit**

```bash
git add src/memory/migrate-associations.ts
git commit -m "feat(memory): migrate associations to KG triples

Converts memory_associations to kg_triples with temporal predicates.
Safe to run multiple times — skips existing triples."
```

---

### Task 12: Update extraction.ts to create KG entities

**Files:**
- Modify: `src/memory/extraction.ts:57-60`

- [ ] **Step 1: Add KG entity creation after memory extraction**

In `src/memory/extraction.ts`, find where extracted memories are saved (the loop that calls `saveMemory`). After each memory with an `entity` field is saved, add:

```typescript
import { addTriple, addEntity } from './knowledge-graph.js';
```

Then after saving an entity memory:

```typescript
      // Create KG entity and triple for entity-type memories
      if (extracted.entity) {
        const entityName = extracted.entity.name;
        const entityType = extracted.entity.entityType || 'concept';
        addEntity(entityName, entityType);
        addTriple(entityName, 'mentioned_in', savedId, 1.0, Date.now(), undefined, savedId);
      }
```

- [ ] **Step 2: Run tests**

```bash
npx vitest run test/palace.test.ts test/config.test.ts test/storage.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add src/memory/extraction.ts
git commit -m "feat(memory): extraction creates KG entities and triples for named entities"
```

---

### Task 13: Add contradiction detection to organic maintenance

**Files:**
- Modify: `src/memory/organic.ts:126-157` (runMemoryMaintenance)

- [ ] **Step 1: Add contradiction detection step**

In `src/memory/organic.ts`, add import at top:

```typescript
import { detectContradictions } from './knowledge-graph.js';
```

In `runMemoryMaintenance()`, after `await runTopologyMaintenance()` (line 155), add:

```typescript
  // Detect contradictions in knowledge graph
  try {
    const contradictions = detectContradictions();
    if (contradictions.length > 0) {
      logger.warn(
        { count: contradictions.length, first: `${contradictions[0]!.subject}:${contradictions[0]!.predicate}` },
        'Knowledge graph contradictions detected'
      );
    }
  } catch (err) {
    logger.debug({ error: String(err) }, 'Contradiction detection failed (non-critical)');
  }
```

- [ ] **Step 2: Run tests**

```bash
npx vitest run test/palace.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add src/memory/organic.ts
git commit -m "feat(memory): add contradiction detection to organic maintenance loop"
```

---

### Task 11b: Migrate coherence groups to palace rooms

**Files:**
- Modify: `src/memory/migration.ts`

- [ ] **Step 1: Add coherence group migration function**

Append to `src/memory/migration.ts`:

```typescript
import { query as dbQuery, queryOne } from '../storage/database.js';
import { resolveWing, createRoom, incrementRoomCount } from './palace.js';

interface CoherenceGroupRow {
  id: string;
  name: string | null;
  member_count: number;
}

interface MembershipRow {
  memory_id: string;
  group_id: string;
}

/**
 * Convert existing coherence groups into palace rooms.
 * Group members get their room_id updated to the new room.
 */
export function migrateCoherenceGroupsToRooms(): { groupsConverted: number; memoriesUpdated: number } {
  const logger = getLogger();
  let groupsConverted = 0;
  let memoriesUpdated = 0;

  const groups = dbQuery<CoherenceGroupRow>(
    'SELECT id, name, member_count FROM coherence_groups WHERE member_count > 0'
  );

  for (const group of groups) {
    // Get the wing of the first member to determine where to put this room
    const members = dbQuery<MembershipRow>(
      'SELECT memory_id FROM coherence_memberships WHERE group_id = ?',
      [group.id]
    );

    if (members.length === 0) continue;

    // Find the most common wing among members
    const wingCounts = new Map<string, number>();
    for (const member of members) {
      const mem = queryOne<{ wing_id: string | null }>(
        'SELECT wing_id FROM memories WHERE id = ?',
        [member.memory_id]
      );
      if (mem?.wing_id) {
        wingCounts.set(mem.wing_id, (wingCounts.get(mem.wing_id) ?? 0) + 1);
      }
    }

    // Pick the most common wing, or 'self' as fallback
    let targetWingId: string;
    if (wingCounts.size > 0) {
      targetWingId = [...wingCounts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    } else {
      targetWingId = resolveWing('self', 'Internal life');
    }

    const roomName = group.name ?? `cluster-${group.id.slice(0, 8)}`;
    const roomId = createRoom(targetWingId, roomName, `Migrated from coherence group ${group.id}`);

    // Update all member memories to point to this room
    for (const member of members) {
      execute(
        'UPDATE memories SET room_id = ? WHERE id = ? AND room_id IS NOT NULL',
        [roomId, member.memory_id]
      );
      incrementRoomCount(roomId);
      memoriesUpdated++;
    }

    groupsConverted++;
    logger.info({ groupId: group.id, roomId, roomName, members: members.length }, 'Converted coherence group to room');
  }

  return { groupsConverted, memoriesUpdated };
}
```

- [ ] **Step 2: Run on production (all characters)**

```bash
ssh root@198.211.116.5 "cd /opt/local-lain && git pull && npm run build"
```

Then for each character:

```bash
ssh root@198.211.116.5 "cd /opt/local-lain && LAIN_HOME=/root/.lain node -e \"
const { initDatabase } = await import('./dist/storage/database.js');
const { migrateCoherenceGroupsToRooms } = await import('./dist/memory/migration.js');
await initDatabase();
const stats = migrateCoherenceGroupsToRooms();
console.log('Coherence group migration:', stats);
process.exit(0);
\""
```

- [ ] **Step 3: Commit**

```bash
git add src/memory/migration.ts
git commit -m "feat(memory): migrate coherence groups to palace rooms"
```

---

## Stage 6: AAAK Compression

### Task 14: Create aaak.ts — AAAK compression module

**Files:**
- Create: `src/memory/aaak.ts`
- Modify: `test/palace.test.ts`

- [ ] **Step 1: Add AAAK test**

Append to `test/palace.test.ts`:

```typescript
import { buildAaakPrompt } from '../src/memory/aaak.js';

describe('AAAK Compression', () => {
  it('builds a valid compression prompt', () => {
    const memories = [
      { id: 'mem1', content: 'Alex works at Acme Corp as a senior engineer' },
      { id: 'mem2', content: 'Alex prefers dark mode in all applications' },
    ];
    const prompt = buildAaakPrompt(memories);
    expect(prompt).toContain('AAAK notation');
    expect(prompt).toContain('Alex works at Acme');
    expect(prompt).toContain('Alex prefers dark mode');
  });
});
```

- [ ] **Step 2: Create src/memory/aaak.ts**

```typescript
/**
 * AAAK compression — structured shorthand for memory storage
 * Any LLM can read AAAK without a decoder.
 */

import { execute, query } from '../storage/database.js';
import { getLogger } from '../utils/logger.js';
import type { Provider } from '../providers/index.js';

const AAAK_PROMPT = `Compress these memories into AAAK notation — structured shorthand that any LLM can read without a decoder.

Rules:
- Use CAPS for category headers
- Parenthetical for attributes: NAME(role,tenure)
- Pipe | for peer-level separation
- Arrow -> for causation/sequence
- Preserve ALL facts, names, dates, relationships — zero information loss
- Target: ~30x compression ratio
- Each memory gets a compressed line prefixed with its ID

Format:
[mem-id] COMPRESSED_CONTENT

Memories to compress:
`;

export function buildAaakPrompt(memories: { id: string; content: string }[]): string {
  const items = memories
    .map((m) => `[${m.id}] ${m.content}`)
    .join('\n\n');
  return AAAK_PROMPT + items;
}

interface UncompressedRow {
  id: string;
  content: string;
  wing_id: string | null;
  room_id: string | null;
}

/**
 * Find memories eligible for AAAK compression.
 * Must be: older than 24h, not yet compressed, has palace placement.
 */
export function getUncompressedMemories(batchSize = 20): { id: string; content: string }[] {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const rows = query<UncompressedRow>(
    `SELECT id, content, wing_id, room_id FROM memories
     WHERE aaak_content IS NULL
       AND wing_id IS NOT NULL
       AND created_at < ?
     ORDER BY wing_id, room_id, created_at ASC
     LIMIT ?`,
    [cutoff, batchSize]
  );
  return rows.map((r) => ({ id: r.id, content: r.content }));
}

/**
 * Save AAAK-compressed content for a set of memories.
 * compressed: Map of memoryId -> compressed text
 */
export function saveCompressedContent(compressed: Map<string, string>): number {
  const now = Date.now();
  let count = 0;
  for (const [memoryId, aaakContent] of compressed) {
    execute(
      `UPDATE memories SET aaak_content = ?, aaak_compressed_at = ? WHERE id = ?`,
      [aaakContent, now, memoryId]
    );
    count++;
  }
  return count;
}

/**
 * Run one batch of AAAK compression using the provided LLM.
 * Returns number of memories compressed.
 */
export async function compressBatch(provider: Provider, batchSize = 20): Promise<number> {
  const logger = getLogger();

  const memories = getUncompressedMemories(batchSize);
  if (memories.length === 0) return 0;

  const prompt = buildAaakPrompt(memories);

  try {
    const response = await provider.generateText(prompt, {
      systemPrompt: 'You are a compression engine. Output only the compressed memory lines, nothing else.',
      maxTokens: 2000,
    });

    // Parse response: each line should be [mem-id] COMPRESSED_CONTENT
    const compressed = new Map<string, string>();
    const lines = response.split('\n').filter((l) => l.trim().length > 0);

    for (const line of lines) {
      const match = line.match(/^\[([^\]]+)\]\s*(.+)$/);
      if (match && match[1] && match[2]) {
        const memId = match[1];
        const content = match[2].trim();
        // Only save if we asked for this memory
        if (memories.some((m) => m.id === memId)) {
          compressed.set(memId, content);
        }
      }
    }

    const saved = saveCompressedContent(compressed);
    logger.info({ requested: memories.length, compressed: saved }, 'AAAK compression batch complete');
    return saved;
  } catch (err) {
    logger.warn({ error: String(err) }, 'AAAK compression batch failed');
    return 0;
  }
}
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run test/palace.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/memory/aaak.ts test/palace.test.ts
git commit -m "feat(memory): add aaak.ts — AAAK compression module with batch processing"
```

---

### Task 15: Add AAAK compression to organic maintenance loop

**Files:**
- Modify: `src/memory/organic.ts:126-157`

- [ ] **Step 1: Add AAAK step to runMemoryMaintenance**

In `src/memory/organic.ts`, add import at top:

```typescript
import { compressBatch } from './aaak.js';
```

In `runMemoryMaintenance()`, after the contradiction detection block (added in Task 13), add:

```typescript
  // AAAK compression — compress settled memories in background
  try {
    const provider = getProvider();
    if (provider) {
      let totalCompressed = 0;
      // Process up to 5 batches per maintenance cycle
      for (let i = 0; i < 5; i++) {
        const compressed = await compressBatch(provider, 20);
        totalCompressed += compressed;
        if (compressed === 0) break; // No more to compress
      }
      if (totalCompressed > 0) {
        logger.info({ totalCompressed }, 'AAAK compression complete');
      }
    }
  } catch (err) {
    logger.debug({ error: String(err) }, 'AAAK compression failed (non-critical)');
  }
```

- [ ] **Step 2: Run tests**

```bash
npx vitest run test/palace.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add src/memory/organic.ts
git commit -m "feat(memory): add AAAK compression step to organic maintenance loop

Compresses up to 100 memories per maintenance cycle (5 batches of 20).
Only targets memories older than 24h that have palace placement."
```

---

### Task 16: Update buildMemoryContext to prefer AAAK content

**Files:**
- Modify: `src/memory/index.ts:376-655`

- [ ] **Step 1: Update Layer 1 (Identity) to use AAAK**

In `src/memory/index.ts`, in the Layer 1 section of `buildMemoryContext` (around line 387-428), update the line that formats memory content:

Replace:

```typescript
        const content = m.content.length > 400 ? m.content.slice(0, 400) + '...' : m.content;
```

With:

```typescript
        const content = m.aaakContent ?? (m.content.length > 400 ? m.content.slice(0, 400) + '...' : m.content);
```

Apply the same change in every location within `buildMemoryContext` where memory content is formatted for the context window. There are approximately 5 such locations:
- Layer 1 facts/preferences (line ~399)
- Layer 1 entities (line ~416)
- Layer 3a current user messages (line ~462-464) — keep plain content here (recent conversation should be readable)
- Layer 3b relevant memories (line ~530) — use AAAK
- Layer 3c browsing discoveries (line ~601) — use AAAK
- Layer 4 resonance (line ~637) — use AAAK

For Layer 3b compact memory references, update:

```typescript
            return `- [mem:${id}] (${typeLabel}, imp:${mem.importance.toFixed(1)}) ${mem.aaakContent ?? mem.content.slice(0, 80)}${groupTag}`;
```

For Layer 3c discoveries, update:

```typescript
            const content = r.memory.aaakContent ?? (r.memory.content.length > 500
              ? r.memory.content.slice(0, 500) + '...'
              : r.memory.content);
```

For Layer 4 resonance, update:

```typescript
        const content = resonance.aaakContent ?? (resonance.content.length > 500
          ? resonance.content.slice(0, 500) + '...'
          : resonance.content);
```

- [ ] **Step 2: Run tests**

```bash
npx vitest run test/palace.test.ts test/config.test.ts test/storage.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add src/memory/index.ts
git commit -m "feat(memory): buildMemoryContext prefers AAAK content when available

Falls back to plain content for uncompressed memories.
Recent conversation messages always use plain content for readability."
```

---

## Stage 7: Cleanup

### Task 17: Remove legacy code and old tables

**IMPORTANT:** Only execute this task after ALL characters have been running with the palace system for at least 1 week with no issues.

**Files:**
- Modify: `src/memory/embeddings.ts` — remove `findTopK` and `cosineSimilarity` exports
- Modify: `src/memory/store.ts` — remove brute-force fallback from searchMemories

- [ ] **Step 1: Remove cosineSimilarity and findTopK from embeddings.ts**

In `src/memory/embeddings.ts`, remove the `cosineSimilarity` function (lines 149-170) and `findTopK` function (lines 175-188). These are now handled by SQLite-vec.

Update the import in `store.ts` to remove `cosineSimilarity`:

```typescript
import { serializeEmbedding, deserializeEmbedding, generateEmbedding } from './embeddings.js';
```

Also update any other files that import `cosineSimilarity` from `embeddings.ts` (check `topology.ts` and `organic.ts` — `topology.ts` uses `cosineSimilarity` for coherence group formation, which should be kept until rooms fully replace groups).

**Note:** If `cosineSimilarity` is still used by `topology.ts` or `organic.ts`, keep it but remove only `findTopK`. Check first:

```bash
grep -rn 'cosineSimilarity' src/memory/
```

If it's used elsewhere, only remove `findTopK`.

- [ ] **Step 2: Remove brute-force fallback from searchMemories**

In `src/memory/store.ts`, in the `searchMemories` function, remove the `else` branch that does brute-force cosine similarity (the fallback for empty vec0 table). By this point, all memories are in vec0.

- [ ] **Step 3: Run full test suite**

```bash
npx vitest run
```

- [ ] **Step 4: Commit**

```bash
git add src/memory/embeddings.ts src/memory/store.ts
git commit -m "chore(memory): remove legacy brute-force search — vec0 is now the only search path"
```

- [ ] **Step 5: Deploy final cleanup**

```bash
ssh root@198.211.116.5 "cd /opt/local-lain && git pull && npm ci && npm run build && systemctl restart lain.target"
```

**Note:** Do NOT drop the `memory_associations` table or `memories.embedding` column yet. Leave them as inert data for one more week, then remove in a follow-up if everything is stable.
