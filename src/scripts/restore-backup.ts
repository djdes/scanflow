#!/usr/bin/env node
/**
 * Database restore utility.
 *
 * Usage:
 *   npm run restore:db                 # list available backups
 *   npm run restore:db -- latest       # restore newest backup
 *   npm run restore:db -- <filename>   # restore a specific file
 *
 * Safety: this tool NEVER auto-confirms. It prints the plan and requires
 * the user to type "yes" to proceed. It also keeps a pre-restore snapshot
 * of the current DB at data/backups/pre-restore-<ts>.sqlite so the operator
 * can roll forward if the restore turns out to be wrong.
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { config } from '../config';
import { verifySqliteFile } from '../utils/backup';

const BACKUP_DIR = path.join(path.dirname(config.dbPath), 'backups');

function listBackups(): Array<{ name: string; path: string; mtime: Date; sizeMB: string }> {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('database-') && f.endsWith('.sqlite'))
    .map(f => {
      const p = path.join(BACKUP_DIR, f);
      const stat = fs.statSync(p);
      return { name: f, path: p, mtime: stat.mtime, sizeMB: (stat.size / 1024 / 1024).toFixed(2) };
    })
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  const backups = listBackups();

  if (!arg) {
    console.log(`\nAvailable backups in ${BACKUP_DIR}:`);
    if (backups.length === 0) {
      console.log('  (none)');
    } else {
      for (const b of backups) {
        console.log(`  ${b.name}   ${b.sizeMB} MB   ${b.mtime.toISOString()}`);
      }
    }
    console.log('\nUsage: npm run restore:db -- latest');
    console.log('       npm run restore:db -- <filename>');
    return;
  }

  let target: { name: string; path: string } | undefined;
  if (arg === 'latest') {
    target = backups[0];
    if (!target) { console.error('No backups found.'); process.exit(1); }
  } else {
    target = backups.find(b => b.name === arg) ?? backups.find(b => b.name.startsWith(arg));
    if (!target) { console.error(`Backup not found: ${arg}`); process.exit(1); }
  }

  // Verify backup BEFORE we touch the live database.
  const verdict = verifySqliteFile(target.path);
  if (!verdict.ok) {
    console.error(`Backup file is not a valid SQLite database: ${verdict.error}`);
    process.exit(2);
  }

  console.log('\nRestore plan:');
  console.log(`  From:   ${target.path}`);
  console.log(`  To:     ${config.dbPath}`);
  console.log(`  Source mtime: ${fs.statSync(target.path).mtime.toISOString()}`);
  if (fs.existsSync(config.dbPath)) {
    console.log(`  Current DB mtime: ${fs.statSync(config.dbPath).mtime.toISOString()}`);
  } else {
    console.log('  Current DB: MISSING (will be created)');
  }
  console.log('\nIMPORTANT: Stop the running app first (pm2 stop scanflow), otherwise');
  console.log('the WAL will desync and the restored DB may lose recent writes.\n');

  const answer = (await ask('Type "yes" to proceed: ')).trim().toLowerCase();
  if (answer !== 'yes') {
    console.log('Aborted.');
    return;
  }

  // Snapshot the current DB before overwriting — belt-and-braces.
  if (fs.existsSync(config.dbPath)) {
    const snapshotTs = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const snapshotPath = path.join(BACKUP_DIR, `pre-restore-${snapshotTs}.sqlite`);
    fs.copyFileSync(config.dbPath, snapshotPath);
    console.log(`Pre-restore snapshot saved: ${snapshotPath}`);
  }

  // Copy WAL / SHM aside if present — they belong to the OLD database and
  // will confuse SQLite if left next to the restored file.
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = config.dbPath + suffix;
    if (fs.existsSync(sidecar)) {
      fs.renameSync(sidecar, sidecar + '.pre-restore');
      console.log(`Moved stale ${suffix} file: ${sidecar} → ${sidecar}.pre-restore`);
    }
  }

  fs.copyFileSync(target.path, config.dbPath);
  const postVerdict = verifySqliteFile(config.dbPath);
  if (!postVerdict.ok) {
    console.error(`Post-restore verification FAILED: ${postVerdict.error}`);
    process.exit(3);
  }

  console.log('\n✓ Restore completed successfully.');
  console.log('Now start the app: pm2 start scanflow');
}

main().catch(err => {
  console.error('Restore failed:', err);
  process.exit(1);
});
