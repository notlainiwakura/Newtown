# `src/scripts/` (run-kg-migration.ts + run-palace-migration.ts)

Two one-shot migration runners. Each opens the current character's DB (via `LAIN_HOME`) and runs a one-way data migration. Both are invoked per-character (usage docstring: `LAIN_HOME=/root/.lain-pkd node dist/scripts/run-kg-migration.js`).

These scripts matter more than their small line count suggests. The MEMORY.md note "Character memories are sacred during deploys" and "Character integrity is sacred" are directly relevant: a mis-targeted migration run silently mutates the wrong character's DB and there is no rollback.

## Function inventory

**run-kg-migration.ts** (1 fn):
- `main()` — log LAIN_HOME, init DB, count `memory_associations` + `kg_triples`, call `migrateAssociationsToKG()`, report stats

**run-palace-migration.ts** (1 fn):
- `main()` — log LAIN_HOME, init DB, `getMigrationStats()`, call `migrateMemoriesToPalace()`, report stats

## Findings

### P1-latent — Scripts silently run against default `~/.lain` when `LAIN_HOME` is unset

Both scripts:

```ts
const home = process.env['LAIN_HOME'] ?? '~/.lain';
console.log(`[kg-migration] LAIN_HOME=${home}`);
await initDatabase();
```

If an operator forgets to export `LAIN_HOME`, `initDatabase()` falls through to the default-basepath resolution (Lain's DB, `~/.lain/lain.db` on the droplet). The log line prints the literal string `~/.lain` — which is tilde-unexpanded — making it look cosmetically correct while the DB actually opens at the fully-resolved home directory path. Operator stares at the log, sees `~/.lain`, assumes "fine, that's the default," and the migration runs against whichever character that default points to on this host.

On the production droplet, `getBasePath()` typically resolves to `/root/.lain` when LAIN_HOME is unset — which is Lain's real home directory per the MEMORY.md port map. A forgotten env var on the wrong server migrates Lain's DB when the operator intended Wired Lain or PKD.

This is P1-latent because:
- The trigger is "operator types the wrong command" — probability non-zero over dozens of per-character runs
- The impact is silent corruption of a character's memory palace / KG — irreversible without backup
- The mitigation is a one-line enforcement: `if (!process.env['LAIN_HOME']) { console.error('LAIN_HOME must be explicitly set'); process.exit(2); }`

**Fix:** require `LAIN_HOME` explicitly; refuse to run without it.

### P2 — No pre-migration DB backup

Both scripts call `migrateAssociationsToKG()` / `migrateMemoriesToPalace()` directly. `memory/migration.ts` is already flagged as P2 for non-transactional per-memory mutations (Section 3). If the script crashes mid-run — OOM, power loss, SIGKILL, `initDatabase` transient disk error — the DB is left in a partial state with some rows migrated, some not, and no rollback.

The MEMORY.md feedback "Character memories are sacred during deploys — back up every .lain*/lain.db before any destructive git/deploy op" applies directly. Neither script takes a backup; neither script prints a "we recommend backing up first" warning; neither script offers `--dry-run`.

**Fix:** copy DB file to `<dbPath>.pre-migration-<timestamp>.db` before first write; print restoration command on script start; add `--dry-run` mode that counts without mutating.

### P2 — `process.exit(stats.errors > 0 ? 1 : 0)` loses detail on partial success

Both scripts reduce "migration had errors on some rows" to exit code 1 with no structured listing of which memory IDs failed. The operator must re-read stdout and scrape individual error lines (which `migration.ts` may or may not log per-row — another Section 3 concern).

**Fix:** write a `migration-errors-<timestamp>.json` with failed memory IDs + reasons; print path on exit.

### P2 — Scripts share the "log-line-misleads-operator" pattern

The `[kg-migration] LAIN_HOME=${home}` line is the operator's only visual confirmation of target DB. With the `~/.lain` fallback, the log lies. Same pattern in both scripts. The existing `paths.ts::getBasePath()` returns the fully-resolved path; the scripts should log the resolved DB path (what `initDatabase` actually opened), not the env-var input.

**Fix:** after `initDatabase()`, log the resolved DB file path.

### P3 — Scripts don't guard against running on a live production process's DB

SQLite allows multiple readers but writes can collide with a running node process. If the operator runs the migration while `lain-pkd.service` is active on the same `LAIN_HOME`, writes interleave. Neither script refuses to run when the DB's systemd service is up.

**Fix:** check for lockfile / advisory-lock / require `systemctl stop` before run.

### P3 — No idempotency documentation

Docstrings describe usage but not behavior when re-run. `migrateMemoriesToPalace` skips already-migrated rows (verified by the "all memories already have palace placement" exit path in `run-palace-migration.ts:18-21`), so it is safely re-runnable. `migrateAssociationsToKG` also has a "skipped (already exist)" counter, implying idempotency. But this is inferable only by reading the script — the docstring should say "safe to re-run" explicitly.

## Verdict

These scripts are small but they are the single most destructive operator-surface in the repo: one typo, one forgotten export, one missing backup and a character's accumulated memory is silently mis-migrated or corrupted. Every finding here has a one-to-three-line fix and should be taken before the next migration wave.

**Severity summary:** 0 P0, 0 P0-latent, **1 P1-latent lifted** (silent-default-DB fallback), **3 P2 lifted**, 2 P3 noted here.
