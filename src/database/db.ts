import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from '../config';
import { logger } from '../utils/logger';
import { runMigrations } from './migrations';

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    const dir = path.dirname(config.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    db = new Database(config.dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    runMigrations(db);
    logger.info('Database initialized', { path: config.dbPath });
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    logger.info('Database connection closed');
  }
}
