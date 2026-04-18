/**
 * One-shot runner: migrate all memories to palace format for the current LAIN_HOME.
 * Usage: LAIN_HOME=/root/.lain-pkd node dist/scripts/run-palace-migration.js
 */

import { initDatabase } from '../storage/database.js';
import { migrateMemoriesToPalace, getMigrationStats } from '../memory/migration.js';

async function main() {
  const home = process.env['LAIN_HOME'] ?? '~/.lain';
  console.log(`[palace-migration] LAIN_HOME=${home}`);

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

  process.exit(stats.errors > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[palace-migration] Fatal error:', err);
  process.exit(2);
});
