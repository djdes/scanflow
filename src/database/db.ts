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

    // SQLite's built-in LOWER()/UPPER() and the LIKE operator's case-insensitive
    // mode are ASCII-only. "Картоф" LIKE "%картоф%" returns false. Register a
    // Unicode-aware lower function backed by JS String.prototype.toLowerCase(),
    // so queries can write `WHERE ulower(name) LIKE ulower(?)` to get proper
    // case-insensitive matching for Cyrillic (and any other script).
    db.function('ulower', { deterministic: true }, (value: unknown) => {
      if (value === null || value === undefined) return null;
      return String(value).toLowerCase();
    });

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
