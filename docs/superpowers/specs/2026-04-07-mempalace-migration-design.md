# MemPalace Memory Migration Design

> Replace the engine of Laintown's memory system with MemPalace concepts — palace hierarchy, AAAK compression, SQLite-vec vector search, and temporal knowledge graph — while keeping all external behavior identical.

## Motivation

The current memory system stores ~13K memories across 6 characters in flat SQLite tables with brute-force cosine similarity search. It works, but:

- **Context window bloat**: `buildMemoryContext()` spends ~7000 tokens to surface maybe 20 memories. AAAK compression can fit 30x more in the same budget.
- **No temporal awareness**: Associations are unweighted pairs with no time dimension. Can't answer "what did I know about X in March?"
- **No contradiction detection**: If a visitor says conflicting things months apart, the system stores both without flagging the conflict.
- **Linear search scaling**: Loading all embeddings into JS and looping is O(n). At 13K it's fine; at 50K+ it won't be.
- **Flat structure**: All memories are peers. No hierarchy to scope searches or understand which memories relate to which domains.

MemPalace (https://github.com/milla-jovovich/mempalace) solves all of these. Rather than adding a Python dependency, we port the core concepts into the existing TypeScript memory system.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Runtime | Port to TypeScript | No Python dependency, fits existing stack |
| Palace hierarchy | Wings/rooms/halls in SQLite | One palace per character (existing separate DBs) |
| Existing data | Full migration of all ~13K memories | Nothing left behind |
| Vector search | SQLite-vec | Same .db file, no new processes, proper ANN indexing |
| AAAK compression | Background job in organic loop | No read/write latency impact, recent memories stay readable |
| Association migration | Evolve into temporal KG | Associations become triples, coherence groups become rooms, no data lost |
| External interfaces | Unchanged | Same types, same `buildMemoryContext()`, same extraction pipeline |

## Schema Changes

All changes are additive (ALTER TABLE + new tables). Existing queries continue to work throughout migration.

### Palace Structure (new columns on existing `memories` table)

```sql
ALTER TABLE memories ADD COLUMN wing_id TEXT REFERENCES palace_wings(id);
ALTER TABLE memories ADD COLUMN room_id TEXT REFERENCES palace_rooms(id);
ALTER TABLE memories ADD COLUMN hall TEXT;
ALTER TABLE memories ADD COLUMN aaak_content TEXT;
ALTER TABLE memories ADD COLUMN aaak_compressed_at INTEGER;
```

### Palace Wings & Rooms (new tables)

```sql
CREATE TABLE palace_wings (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL,
  memory_count INTEGER DEFAULT 0
);

CREATE TABLE palace_rooms (
  id TEXT PRIMARY KEY,
  wing_id TEXT NOT NULL REFERENCES palace_wings(id),
  name TEXT NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL,
  memory_count INTEGER DEFAULT 0
);
```

### Halls

Five standardized memory-type corridors, stored as a TEXT column:

| Hall | Contains | Migrated from |
|------|----------|---------------|
| `truths` | Facts, preferences, locked-in knowledge | `fact`, `preference` |
| `encounters` | Conversations, therapy, commune interactions | `context`, `episode` (default) |
| `discoveries` | Curiosity browsing, breakthroughs | `episode` where `sessionKey = 'curiosity:browse'` |
| `dreams` | Dream sequences, subconscious material | `episode` where `sessionKey = 'dreams:*'` |
| `reflections` | Diary, self-concept, letters, internal monologue | `summary`, `episode` where `sessionKey = 'diary:*' or 'letter:*'` |

### Temporal Knowledge Graph (replaces `memory_associations`)

```sql
CREATE TABLE kg_triples (
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

CREATE TABLE kg_entities (
  name TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,  -- person, project, concept, place, character
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  metadata TEXT DEFAULT '{}'
);

CREATE INDEX idx_kg_subject ON kg_triples(subject);
CREATE INDEX idx_kg_object ON kg_triples(object);
CREATE INDEX idx_kg_predicate ON kg_triples(predicate);
CREATE INDEX idx_kg_valid ON kg_triples(valid_from, ended);
```

### SQLite-vec (vector search)

```sql
CREATE VIRTUAL TABLE memory_embeddings USING vec0(
  embedding float[384] distance_metric=cosine,
  +memory_id text    -- auxiliary column returned in KNN results
);
```

Replaces brute-force JS cosine similarity loop. Queries become:

```sql
SELECT m.*, e.distance
FROM memory_embeddings e
JOIN memories m ON m.id = e.memory_id
WHERE e.embedding MATCH ?
  AND k = ?
ORDER BY e.distance
```

Optional wing/room/hall filters via JOIN conditions.

## Wing & Room Strategy

Wings form organically per character:

| Wing type | Key | Example |
|-----------|-----|---------|
| Visitor | userId | `visitor-YbYf4Q90` |
| Character relationship | characterId | `wired-lain`, `pkd` |
| Self | `self` | Diary, dreams, identity |
| Curiosity | `curiosity` | Browsing discoveries |
| Town | `town` | Commune events, building events |

Rooms form within wings as topic clusters. During migration, rooms are seeded from existing coherence groups and embedding similarity clustering. Post-migration, the organic maintenance loop detects new clusters (3+ memories in a wing with pairwise cosine similarity > 0.7 that don't belong to an existing room) and creates rooms automatically. Room names are generated by the LLM from the cluster's content.

### Example Palace (Lain)

```
palace/
  self/
    dreams/          (dream sequences)
    diary/           (daily reflections)
    identity/        (self-concept evolution)
  curiosity/
    cybernetics/     (browsing cluster)
    philosophy/      (browsing cluster)
  visitor-YbYf4Q90/
    conversations/   (everything about this visitor)
  wired-lain/
    letters/         (correspondence with her sister)
  town/
    commune-life/    (town events, weather, buildings)
```

## AAAK Compression

Added as a new step in the organic maintenance loop (`organic.ts`).

### Compression Flow

1. Find memories where `aaak_content IS NULL AND created_at < now - 24h`
2. Batch by wing/room (~20 memories per batch for context)
3. LLM call with AAAK compression prompt
4. Store in `memories.aaak_content`, set `aaak_compressed_at`

### AAAK Prompt

```
Compress these memories into AAAK notation — structured shorthand that any LLM
can read without a decoder. Rules:
- Use CAPS for category headers
- Parenthetical for attributes: NAME(role,tenure)
- Pipe | for peer-level separation
- Arrow -> for causation/sequence
- Preserve ALL facts, names, dates, relationships — zero information loss
- Target: ~30x compression ratio

Memories to compress:
[batch]
```

### Context Builder Changes

`buildMemoryContext()` in `index.ts`:
- Layer 1 (Identity): prefers `aaak_content` when available
- Layers 2-4: use `aaak_content` when available, fall back to plain `content`
- Same 7000-token budget now fits ~30x more memories

## Knowledge Graph

### Association Migration

| Association type | KG predicate |
|-----------------|--------------|
| `similar` | `similar_to` |
| `evolved_from` | `evolved_from` |
| `pattern` | `shares_pattern` |
| `cross_topic` | `cross_references` |
| `dream` | `dream_linked` |

Each gets `valid_from` set to original `created_at`, `ended = NULL`.

### Coherence Groups to Rooms

Existing coherence groups map to palace rooms. Group members become the room's memories. Group signature embedding becomes the room's signature for auto-filing.

### Contradiction Detection

Runs in organic maintenance loop:
1. For each new KG triple, check for conflicting active triples (same subject + predicate, different object)
2. Check temporal consistency (dates, tenure claims)
3. Flag severity: error (direct conflict) or warning (stale/suspicious)
4. Log contradictions; optionally surface to character during context building

### Entity Extraction

`extraction.ts` already extracts entities. Post-migration, entities also produce KG triples:
- `(entityName, is_a, entityType, valid_from=now)`
- `(entityName, mentioned_in, memoryId, valid_from=now)`
- Relationship triples from context (e.g., "Alex works at Acme" → `(Alex, works_at, Acme)`)

## File-by-File Impact

| File | Changes |
|------|---------|
| `store.ts` | **Heavy rewrite.** Add palace CRUD (wings, rooms), KG CRUD (triples, entities), rewrite `searchMemories()` to use SQLite-vec with palace scoping, add migration helpers. Keep existing function signatures. |
| `embeddings.ts` | **Light.** Remove `findTopK()` and `cosineSimilarity()` (moved to SQLite-vec). Keep `generateEmbedding()`, `generateEmbeddings()`, `computeCentroid()`, serialization helpers. |
| `extraction.ts` | **Light.** After extracting memories, also create KG triples for entities. Extraction prompt unchanged. |
| `organic.ts` | **Medium.** Add AAAK compression step. Add contradiction detection step. Existing decay/forgetting/pattern logic unchanged. |
| `topology.ts` | **Medium.** Lifecycle advancement unchanged. Coherence group logic evolves to room management. Causal link inference writes to KG instead of associations. |
| `index.ts` | **Medium.** `buildMemoryContext()` updated to read from palace hierarchy, prefer AAAK content. Same function signature, same 4-layer structure, same token budgets. |

## Migration Stages

### Stage 1: Schema + Infrastructure
- Add palace columns + tables alongside existing schema
- Add SQLite-vec dependency and virtual table
- No behavior change — old system runs unmodified
- **Reversible:** DROP new columns/tables

### Stage 2: Canary Migration (Dr. Claude)
- Migration script maps existing memories to wings/rooms/halls
- Run on Dr. Claude (293 memories, smallest DB)
- Validate: memory counts match, content intact, embeddings in vec0
- **Reversible:** SET palace columns to NULL, drop vec0 data

### Stage 3: Swap Store Layer
- `store.ts` reads/writes palace hierarchy
- Dual-read: try palace path first, fall back to legacy path
- Validate Dr. Claude in production for 2-3 days
- **Reversible:** revert store.ts, palace data remains inert

### Stage 4: Migrate Remaining Characters
- Run migration on: Lain (1108), PKD (2357), McKenna (2441), John (2617), Wired Lain (4166)
- Validate each after migration
- Remove dual-read fallback
- **Reversible per character:** re-run migration with --rollback flag

### Stage 5: Knowledge Graph
- Add KG tables
- Migrate 848+ associations to triples
- Coherence groups become rooms
- Add contradiction detection to organic loop
- **Reversible:** DROP KG tables, associations still exist in old table

### Stage 6: AAAK Compression
- Add compression step to organic maintenance
- Memories older than 24h get compressed in background
- Update `buildMemoryContext()` to prefer AAAK content
- **Reversible:** ignore aaak_content column, revert context builder

### Stage 7: Cleanup
- Drop old `memory_associations` table
- Drop `memories.embedding` BLOB column (vec0 is source of truth)
- Remove dual-read fallback code
- Remove legacy function aliases
- **Not reversible** — only execute after full validation of all characters

## Testing Strategy

Each stage has its own validation:

1. **Unit tests:** Run existing `test/` suite after each stage — nothing should break
2. **Migration validation:** Count memories before/after, spot-check content, verify embedding search returns same results
3. **Production monitoring:** Check logs for errors, verify response quality doesn't degrade, watch memory retrieval patterns
4. **Rollback drill:** Before each stage, verify the rollback procedure works on Dr. Claude

## Backups

- Pre-migration backups taken 2026-04-07 at `/root/memory-backups/20260407/`
- Fresh backup required before each migration stage
- All 6 databases pass SQLite integrity checks

## Dependencies

| Package | Purpose | New? |
|---------|---------|------|
| `sqlite-vec` | Vector search in SQLite | Yes |
| `@xenova/transformers` | Embedding generation | Existing |
| `better-sqlite3` | SQLite driver | Existing |
| `nanoid` | ID generation | Existing |
