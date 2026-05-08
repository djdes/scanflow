#!/usr/bin/env node
/**
 * Database restore utility.
 *
 * The old SQLite-based restore flow (file copy of data/database.sqlite) no
 * longer applies — ScanFlow now runs on MySQL/MariaDB. Restore via:
 *
 *   mysql -u <user> -p <db> < dump.sql
 *
 * This script is preserved as a stub so `npm run restore:db` still resolves
 * (and prints a helpful message) instead of failing with a TypeScript error.
 */

async function main(): Promise<void> {
  console.log('restore-backup is deprecated for the MySQL backend.');
  console.log('Restore a dump produced by mysqldump using the MySQL client:');
  console.log('  mysql -h <host> -u <user> -p <database> < <dump.sql>');
  console.log('Stop the running app first (pm2 stop scanflow) to avoid concurrent writes.');
}

main().catch((err) => {
  console.error('restore-backup failed:', err);
  process.exit(1);
});
