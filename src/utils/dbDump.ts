import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { getPool } from '../database/db';

/**
 * Логический дамп схемы в gzip-SQL (как mysqldump, но через уже открытый пул).
 *
 * Почему не mysqldump: на проде стоит клиент MariaDB, а локально — MySQL 9 с
 * caching_sha2_password; единственное, что гарантированно умеет подключаться
 * в обоих местах, — сам mysql2 приложения. Читает в одной транзакции
 * WITH CONSISTENT SNAPSHOT (READ ONLY) — дамп согласован и никого не блокирует.
 * Восстановление: `zcat файл | mysql <схема>` (или скриптом через mysql2).
 */
export interface DumpResult { file: string; bytes: number; tables: number; rows: number }

export async function dumpDatabaseTo(file: string): Promise<DumpResult> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.part`;
  const conn: PoolConnection = await getPool().getConnection();
  const gz = zlib.createGzip({ level: 9 });
  const out = fs.createWriteStream(tmp);
  gz.pipe(out);
  const write = (s: string) => new Promise<void>(resolve => { if (!gz.write(s)) gz.once('drain', () => resolve()); else resolve(); });
  let tables = 0;
  let rows = 0;
  try {
    await conn.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const [[meta]] = await conn.query<RowDataPacket[]>('SELECT VERSION() AS v, DATABASE() AS db, NOW() AS t');
    await write(`-- ScanFlow logical dump\n-- server ${meta.v}, schema ${meta.db}, taken ${meta.t}\nSET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS=0;\nSET UNIQUE_CHECKS=0;\n\n`);
    const [list] = await conn.query<RowDataPacket[]>(
      "SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME");
    for (const { t } of list) {
      const [[ddl]] = await conn.query<RowDataPacket[]>('SHOW CREATE TABLE ??', [t]);
      await write(`DROP TABLE IF EXISTS \`${t}\`;\n${ddl['Create Table']};\n`);
      const [cols] = await conn.query<RowDataPacket[]>(
        'SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION', [t]);
      const colList = cols.map(x => '`' + x.c + '`').join(',');
      // Постранично по 2000 строк: даже журналы в сотни тысяч строк не держим в памяти целиком.
      for (let offset = 0; ; offset += 2000) {
        const [data] = await conn.query({ sql: `SELECT * FROM \`${t}\` LIMIT 2000 OFFSET ${offset}`, rowsAsArray: true }) as unknown as [unknown[][]];
        if (!data.length) break;
        for (let i = 0; i < data.length; i += 500) {
          const chunk = data.slice(i, i + 500).map(r => '(' + r.map(v => conn.escape(v)).join(',') + ')').join(',\n');
          await write(`INSERT INTO \`${t}\` (${colList}) VALUES\n${chunk};\n`);
        }
        rows += data.length;
        if (data.length < 2000) break;
      }
      await write('\n');
      tables++;
    }
    await write('SET FOREIGN_KEY_CHECKS=1;\nSET UNIQUE_CHECKS=1;\n');
    await conn.query('COMMIT');
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    gz.destroy();
    out.destroy();
    fs.promises.unlink(tmp).catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
  gz.end();
  await new Promise<void>((resolve, reject) => { out.on('finish', () => resolve()); out.on('error', reject); });
  fs.renameSync(tmp, file);
  return { file, bytes: fs.statSync(file).size, tables, rows };
}

/** Оставить в каталоге только `keep` самых свежих файлов вида scanflow-YYYY-MM-DD.sql.gz. */
export function rotateDumps(dir: string, keep: number): string[] {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const dumps = names.filter(n => /^scanflow-\d{4}-\d{2}-\d{2}\.sql\.gz$/.test(n)).sort();
  const remove = dumps.slice(0, Math.max(0, dumps.length - keep));
  for (const n of remove) {
    try { fs.unlinkSync(path.join(dir, n)); } catch { /* уже удалён */ }
  }
  return remove;
}
