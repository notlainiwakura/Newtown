/**
 * One-shot runner: migrate all memories to palace format for the current LAIN_HOME.
 * Usage: LAIN_HOME=/root/.lain-pkd node dist/scripts/run-palace-migration.js
 */

import { existsSync, copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initDatabase } from '../storage/database.js';
import { migrateMemoriesToPalace, getMigrationStats } from '../memory/migration.js';
import { getPaths } from '../config/paths.js';

async function main() {
  // Refuse to run without an explicit LAIN_HOME (findings.md P1-latent:2898).
  // Silent fallback to ~/.lain targets Lain's production DB on the droplet
  // and is irreversible without a backup.
  const home = process.env['LAIN_HOME'];
  if (!home || home.length === 0) {
    console.error('[palace-migration] LAIN_HOME is not set. Refusing to run.');
    console.error('[palace-migration] Set it explicitly: LAIN_HOME=/root/.lain-<id> node ...');
    process.exit(2);
  }
  const { database: dbPath } = getPaths();
  console.log(`[palace-migration] LAIN_HOME=${home}`);
  console.log(`[palace-migration] Resolved database: ${dbPath}`);

  // findings.md P2:2916 — back up DB before any destructive write.
  // migration.ts mutates per-row and is non-transactional; a crash or SIGKILL
  // mid-migration leaves the DB partially migrated with no rollback path.
  if (existsSync(dbPath)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${dbPath}.pre-migration-${ts}.db`;
    copyFileSync(dbPath, backupPath);
    console.log(`[palace-migration] Backup created: ${backupPath}`);
    console.log(`[palace-migration] Restore with: cp "${backupPath}" "${dbPath}"`);
  } else {
    console.log(`[palace-migration] DB does not yet exist at ${dbPath} — no backup needed.`);
  }

  await initDatabase();

  const before = getMigrationStats();
  console.log(`[palace-migration] Before: ${before.total} total, ${before.migrated} migrated, ${before.unmigrated} unmigrated`);

  if (before.unmigrated === 0) {
    console.log('[palace-migration] Nothing to migrate — all memories already have palace placement.');
    process.exit(0);
  }

  console.log(`[palace-migration] Migrating ${before.unmigrated} memories...`);
  const stats = await migrateMemoriesToPalace();

  console.log('[palace-migration] Done!');
  console.log(`  Total: ${stats.total}`);
  console.log(`  Migrated: ${stats.migrated}`);
  console.log(`  Skipped: ${stats.skipped}`);
  console.log(`  Errors: ${stats.errors}`);
  console.log(`  Wings created: ${stats.wings}`);
  console.log(`  Rooms created: ${stats.rooms}`);
  console.log(`  Vec embeddings inserted: ${stats.vecInserted}`);

  const after = getMigrationStats();
  console.log(`[palace-migration] After: ${after.total} total, ${after.migrated} migrated, ${after.unmigrated} unmigrated`);

  // findings.md P2:2928 — on partial failure, persist per-row error details so
  // operators can identify failing memory IDs without scraping logs.
  if (stats.errors > 0 && stats.errorDetails.length > 0) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const errorPath = join(home, `migration-errors-${ts}.json`);
    writeFileSync(
      errorPath,
      JSON.stringify(
        { migration: 'palace', timestamp: ts, errors: stats.errorDetails },
        null,
        2,
      ),
    );
    console.error(`[palace-migration] Per-row errors written to: ${errorPath}`);
  }

  process.exit(stats.errors > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[palace-migration] Fatal error:', err);
  process.exit(2);
});
