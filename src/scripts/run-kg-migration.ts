/**
 * One-shot runner: migrate all memory_associations to kg_triples for the current LAIN_HOME.
 * Usage: LAIN_HOME=/root/.lain-pkd node dist/scripts/run-kg-migration.js
 */

import { initDatabase } from '../storage/database.js';
import { migrateAssociationsToKG } from '../memory/migration.js';
import { queryOne } from '../storage/database.js';

async function main() {
  const home = process.env['LAIN_HOME'] ?? '~/.lain';
  console.log(`[kg-migration] LAIN_HOME=${home}`);

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

  process.exit(stats.errors > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[kg-migration] Fatal error:', err);
  process.exit(2);
});
