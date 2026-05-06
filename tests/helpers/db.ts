import Database from 'better-sqlite3';
import { runMigrations } from '../../src/database/migrations';
import { setDb } from '../../src/database/db';

let testDb: Database.Database | null = null;

export function resetDb(): Database.Database {
  if (testDb) testDb.close();
  testDb = new Database(':memory:');
  runMigrations(testDb);
  setDb(testDb);
  return testDb;
}
