# `src/storage/database.ts`

SQLite wrapper with optional SQLCipher encryption + sqlite-vec extension. 11 migrations declared inline. 10 functions + module-level singleton.

## Functions

### `initDatabase(dbPath?, keyDerivationConfig?)`, line 277

**Purpose:** open (or create) the SQLite DB, load sqlite-vec, optionally apply SQLCipher PRAGMA key, enable WAL, run migrations.

**Fits the system?** Central to everything. Each character process opens one database under its `LAIN_HOME`.

**Gaps / bugs:**
- **P0 latent bug — salt is regenerated on every open**. Line 304: `const salt = generateSalt(16)`. Combined with line 307 `deriveKey(masterKey, salt, config)`, the derived key is different every time. The comment on line 303 *says* "Use a deterministic salt derived from the path for consistency" — but the code doesn't do that. It generates a new random salt. Consequences:
  - If SQLCipher is compiled in: subsequent opens fail because `PRAGMA key` computes a different key than was used on first create. The user's encrypted DB becomes unreadable. **P0 under SQLCipher**.
  - If SQLCipher is NOT compiled in (current state — see line 316-324 comment "For standard better-sqlite3, we skip encryption"): the `PRAGMA key` is silently ignored by stock SQLite, so the wrong-key never matters. **Latent**.
  - Either way, this is a serious gap that will bite the day anyone flips encryption on. Needs deterministic salt, persisted either in keychain alongside the master key or in a file next to the DB.

- **Silent SQLCipher fallback** (lines 319-324): `try { db.pragma('key = ...') } catch {}`. If PRAGMA fails, encryption is silently skipped and we keep going with an **unencrypted** DB. The `try` block has no `catch` body beyond a TODO comment "Log warning in production". Users think the DB is encrypted; it isn't. **P1** — lift.

- **`db.pragma(\`key = '${hexKey}'\`)`** — template literal interpolation of a pragma value. For SQLCipher the pragma syntax doesn't accept bound parameters, so this is the standard pattern. Since `hexKey` is pure hex, no injection risk. **No finding.**

- **`sqliteVec.load(db)`** — native extension. If the binary isn't present (sqlite-vec install failed), this throws. The outer try/catch reports as `StorageError` but with a cryptic underlying message. **P3** — add a helpful "install sqlite-vec or check your build" hint.

- **`foreign_keys = ON` and `journal_mode = WAL`** — correct defaults.
- **`busy_timeout = 5000`** — 5 seconds. Reasonable.

### `getDatabase()`, line 347 / `isDatabaseInitialized()`, line 357 / `closeDatabase()`, line 364

Trivial singleton accessors. `closeDatabase` sets `db = null` after `close()`. Fine.

### `runMigrations(database)`, line 374

**Purpose:** read current version from `meta` table, iterate migrations from `currentVersion` to `MIGRATIONS.length`, split into ALTER-per-line + CREATE batch, apply, catch duplicate-column errors, bump version.

**Gaps / bugs:**
- **Line-based SQL splitter is fragile.** It checks if a line starts with `ALTER TABLE`. If any future migration has a multi-line ALTER (`ALTER TABLE foo\n  ADD COLUMN bar TEXT;`), the splitter puts the first line in `alters` and the `ADD COLUMN` line in `rest`, producing invalid SQL. Current migrations fit on one line; this is a trip-wire. **P3** — flag as "future maintenance hazard."
- **Final version bump is AFTER the loop** — if any migration throws, `SCHEMA_VERSION` is NOT written, so migrations are re-attempted on next boot. Combined with `IF NOT EXISTS` on CREATEs and duplicate-column catches on ALTERs, this is effectively idempotent. **Good**, but subtle.
- **No per-migration version recording** — if migration 7 partially succeeds, then fails, and someone fixes migration 7 in a new deploy, the old DB will re-run 1-6 (no-ops thanks to IF NOT EXISTS) plus the fixed 7. Works by luck of the IF-NOT-EXISTS convention. **P3**.
- **No down-migrations**. Rolling back a deploy that changed schema requires manual work. **P3** — architectural.
- **Migrations run inside the same transaction as the caller?** `exec()` auto-commits each statement. Mixed migrations (some ALTER, some CREATE) aren't atomic. Partial-apply recovery depends on idempotency (which is ok here).

### `query<T>(sql, params?)`, line 433

Wraps `prepare().all()` with a try/catch that throws `StorageError`. Fine.

### `queryOne<T>(sql, params?)`, line 449

Wraps `prepare().get()`. Fine.

### `execute(sql, params?)`, line 465

Wraps `prepare().run()`. Returns `{ changes, lastInsertRowid }`. Fine.

### `transaction<T>(fn)`, line 484

Wraps `db.transaction(fn)()`. Correct — better-sqlite3 pattern.

### `getMeta(key)`, `setMeta(key, value)`, lines 492 / 500

Typed key-value accessors on the `meta` table. Fine.

---

## File-level notes

- **Schema dictionary**: sessions, credentials, meta, messages, memories, memory_associations, coherence_groups, coherence_memberships, postboard_messages, objects, town_events, building_events, palace_wings, palace_rooms, kg_triples, kg_entities, memory_embeddings (virtual). 17 tables at schema version 11.
- **`memories` table is the hot table**: ~12 ALTER adds across migrations (user_id, related_to, source_message_id, emotional_weight, lifecycle_state, lifecycle_changed_at, phase, wing_id, room_id, hall, aaak_content, aaak_compressed_at). Wide table. Normalization opportunities exist but defer to memory audit.
- **`memory_embeddings`** virtual table uses `vec0(embedding float[384] distance_metric=cosine, +memory_id text)`. 384-dim = `all-MiniLM-L6-v2` or similar. Cosine distance. Correct.
- **Per-character DBs**: each of the 6+ characters has its own copy of all 17 tables. Storage blows up linearly with character count. **P3** — architectural.
- **No `VACUUM` schedule**: after heavy deletes (e.g. memory decay, session pruning), DB file stays bloated. **P3**.
- **`migration.ts` / `migration-palace.ts` exist as separate files** (referenced elsewhere in the repo). Those are NOT in the `MIGRATIONS` array here — they're one-off backfills run by `scripts/run-*-migration.ts`. Dual migration systems. **P2** — lift: "Two parallel migration systems" risks inconsistency.

## Verdict

**Lift to findings.md:**
- **P1**: Silent SQLCipher fallback — `try { db.pragma('key = ...') } catch {}` with empty catch means encryption is silently skipped on any `PRAGMA key` failure, and users think their DB is encrypted when it isn't. Fix: throw on pragma failure if encryption was requested (pass a `requireEncryption` flag into `initDatabase`).
- **P0 latent (will be P0 the moment encryption is enabled)**: salt regenerated on every open. Comment claims deterministic salt; code does random. Enabling SQLCipher breaks all existing databases on restart. Fix: persist salt alongside master key in keychain, OR derive deterministically from a fixed path + master key.
- **P2**: Two parallel migration systems (inline `MIGRATIONS` array + one-off `src/memory/migration.ts` + `src/memory/migration-palace.ts`). Risks inconsistent schema state. Confirm during memory audit.
