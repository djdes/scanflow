import mysql, { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { config } from '../config';
import { logger } from '../utils/logger';
import { runMigrations } from './migrations';

let pool: Pool | null = null;
let initPromise: Promise<void> | null = null;

function buildPool(): Pool {
  return mysql.createPool({
    host: config.dbHost,
    port: config.dbPort,
    user: config.dbUser,
    password: config.dbPassword,
    database: config.dbName,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: 'utf8mb4',
    dateStrings: true,
    timezone: 'Z',
    multipleStatements: true,
    namedPlaceholders: true,
    decimalNumbers: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
  });
}

export function getPool(): Pool {
  if (!pool) pool = buildPool();
  return pool;
}

/**
 * Initialise DB: open pool, run migrations. Idempotent — repeated calls
 * await the same in-flight initialisation.
 */
export async function initDb(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const p = getPool();
      await runMigrations(p);
      logger.info('Database initialized', {
        host: config.dbHost,
        port: config.dbPort,
        database: config.dbName,
      });
    })();
  }
  return initPromise;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    initPromise = null;
    logger.info('Database connection closed');
  }
}

/**
 * Convert positional `?` argv into named `:p0`, `:p1`, … so that
 * positional binds keep working even though `namedPlaceholders: true`
 * is enabled at the pool level. Required because we mix both styles
 * across the codebase.
 */
function bindParams(sql: string, args: unknown[]): { sql: string; params: Record<string, unknown> } {
  if (args.length === 0) return { sql, params: {} };
  const params: Record<string, unknown> = {};
  let i = 0;
  const newSql = sql.replace(/\?/g, () => {
    const key = `p${i}`;
    params[key] = args[i];
    i++;
    return `:${key}`;
  });
  // If the count of `?` < args.length, treat extras as named-style passed
  // as a single object (legacy better-sqlite3 binding). Caller can pass
  // a single object as the only arg — we handle that branch in the
  // statement wrapper below.
  return { sql: newSql, params };
}

function normaliseArgs(args: unknown[]): { kind: 'positional' | 'named'; payload: unknown } {
  if (args.length === 1 && args[0] !== null && typeof args[0] === 'object' && !Array.isArray(args[0])) {
    return { kind: 'named', payload: args[0] };
  }
  return { kind: 'positional', payload: args };
}

interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

interface Statement {
  get<T = unknown>(...args: unknown[]): Promise<T | undefined>;
  all<T = unknown>(...args: unknown[]): Promise<T[]>;
  run(...args: unknown[]): Promise<RunResult>;
}

export interface DbAdapter {
  prepare(sql: string): Statement;
  exec(sql: string): Promise<void>;
  /**
   * Run an async callback inside a transaction. The supplied callback
   * receives a transactional `DbAdapter` whose statements run on the
   * dedicated connection. Commit on resolve, rollback on throw.
   */
  transaction<T>(fn: (txn: DbAdapter) => Promise<T>): Promise<T>;
}

function adapterFor(executor: Pool | PoolConnection): DbAdapter {
  return {
    prepare(sql: string): Statement {
      return {
        async get<T>(...args: unknown[]): Promise<T | undefined> {
          const a = normaliseArgs(args);
          if (a.kind === 'named') {
            const [rows] = await executor.execute<RowDataPacket[]>(sql, a.payload as never);
            return rows[0] as T | undefined;
          }
          const bound = bindParams(sql, a.payload as never[]);
          const [rows] = await executor.execute<RowDataPacket[]>(bound.sql, bound.params as never);
          return rows[0] as T | undefined;
        },
        async all<T>(...args: unknown[]): Promise<T[]> {
          const a = normaliseArgs(args);
          if (a.kind === 'named') {
            const [rows] = await executor.execute<RowDataPacket[]>(sql, a.payload as never);
            return rows as T[];
          }
          const bound = bindParams(sql, a.payload as never[]);
          const [rows] = await executor.execute<RowDataPacket[]>(bound.sql, bound.params as never);
          return rows as T[];
        },
        async run(...args: unknown[]): Promise<RunResult> {
          const a = normaliseArgs(args);
          let result: ResultSetHeader;
          if (a.kind === 'named') {
            const [r] = await executor.execute<ResultSetHeader>(sql, a.payload as never);
            result = r;
          } else {
            const bound = bindParams(sql, a.payload as never[]);
            const [r] = await executor.execute<ResultSetHeader>(bound.sql, bound.params as never);
            result = r;
          }
          return {
            changes: result.affectedRows ?? 0,
            lastInsertRowid: Number(result.insertId ?? 0),
          };
        },
      };
    },
    async exec(sql: string): Promise<void> {
      // mysql2 query() supports multi-statement DDL when pool has
      // multipleStatements: true. exec() is for migrations; never user input.
      await executor.query(sql);
    },
    async transaction<T>(fn: (txn: DbAdapter) => Promise<T>): Promise<T> {
      // If we are already on a single connection, just run in nested mode.
      // Top-level call grabs a fresh connection.
      if ('beginTransaction' in executor) {
        return fn(adapterFor(executor as PoolConnection));
      }
      const conn = await (executor as Pool).getConnection();
      try {
        await conn.beginTransaction();
        const result = await fn(adapterFor(conn));
        await conn.commit();
        return result;
      } catch (err) {
        try { await conn.rollback(); } catch { /* ignore rollback errors */ }
        throw err;
      } finally {
        conn.release();
      }
    },
  };
}

/**
 * Public DB handle. All repository code goes through this.
 * NOTE: every prepare(...).get/all/run returns a Promise — callers MUST await.
 */
export function getDb(): DbAdapter {
  return adapterFor(getPool());
}

// Test-only escape hatch: replace the underlying pool. Keeps the same
// adapter API for repository code under test.
export function setPool(p: Pool): void {
  pool = p;
  initPromise = null;
}
