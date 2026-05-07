/**
 * One-shot runner: migrate all memory_associations to kg_triples for the current LAIN_HOME.
 * Usage: LAIN_HOME=/root/.lain-pkd node dist/scripts/run-kg-migration.js
 */

import { existsSync, copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initDatabase } from '../storage/database.js';
import { migrateAssociationsToKG } from '../memory/migration.js';
import { queryOne } from '../storage/database.js';
import { getPaths } from '../config/paths.js';

async function main() {
  // Refuse to run without an explicit LAIN_HOME (findings.md P1-latent:2898).
  // Silent fallback to ~/.lain targets Lain's production DB on the droplet
  // and is irreversible without a backup.
  const home = process.env['LAIN_HOME'];
  if (!home || home.length === 0) {
    console.error('[kg-migration] LAIN_HOME is not set. Refusing to run.');
    console.error('[kg-migration] Set it explicitly: LAIN_HOME=/root/.lain-<id> node ...');
    process.exit(2);
  }
  const { database: dbPath } = getPaths();
  console.log(`[kg-migration] LAIN_HOME=${home}`);
  console.log(`[kg-migration] Resolved database: ${dbPath}`);

  // findings.md P2:2916 — back up DB before any destructive write.
  // migration.ts inserts kg_triples per-association non-transactionally; a crash
  // or SIGKILL mid-run leaves half the triples inserted with no clean rollback.
  if (existsSync(dbPath)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${dbPath}.pre-migration-${ts}.db`;
    copyFileSync(dbPath, backupPath);
    console.log(`[kg-migration] Backup created: ${backupPath}`);
    console.log(`[kg-migration] Restore with: cp "${backupPath}" "${dbPath}"`);
  } else {
    console.log(`[kg-migration] DB does not yet exist at ${dbPath} — no backup needed.`);
  }

  await initDatabase();

  // Show before state
  const assocCount = queryOne<{ cnt: number }>('SELECT COUNT(*) as cnt FROM memory_associations')?.cnt ?? 0;
  const tripleCount = queryOne<{ cnt: number }>('SELECT COUNT(*) as cnt FROM kg_triples')?.cnt ?? 0;
  console.log(`[kg-migration] Before: ${assocCount} associations, ${tripleCount} KG triples`);

  if (assocCount === 0) {
    console.log('[kg-migration] No associations to migrate.');
    process.exit(0);
  }

  console.log(`[kg-migration] Migrating ${assocCount} associations to KG triples...`);
  const stats = migrateAssociationsToKG();

  console.log('[kg-migration] Done!');
  console.log(`  Total associations: ${stats.total}`);
  console.log(`  Migrated to triples: ${stats.migrated}`);
  console.log(`  Skipped (already exist): ${stats.skipped}`);
  console.log(`  Errors: ${stats.errors}`);

  const afterTriples = queryOne<{ cnt: number }>('SELECT COUNT(*) as cnt FROM kg_triples')?.cnt ?? 0;
  console.log(`[kg-migration] After: ${afterTriples} KG triples`);

  // findings.md P2:2928 — on partial failure, persist per-row error details so
  // operators can identify failing associations without scraping logs.
  if (stats.errors > 0 && stats.errorDetails.length > 0) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const errorPath = join(home, `migration-errors-${ts}.json`);
    writeFileSync(
      errorPath,
      JSON.stringify(
        { migration: 'kg', timestamp: ts, errors: stats.errorDetails },
        null,
        2,
      ),
    );
    console.error(`[kg-migration] Per-row errors written to: ${errorPath}`);
  }

  process.exit(stats.errors > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[kg-migration] Fatal error:', err);
  process.exit(2);
});
