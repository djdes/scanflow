/**
 * Извлечь сопоставления из SQL-дампа для «Номенклатура → Вернуть правила из
 * резервной копии» (POST /api/mappings/restore). Работает ЛОКАЛЬНО с файлом,
 * в базу не ходит.
 *
 *   npx ts-node --transpile-only src/scripts/restore-mappings-from-dump.ts <dump.sql> [table] [--owner=N] > rows.json
 *
 * table — nomenclature_mappings (дампы до разделения по компаниям, по
 * умолчанию) или nomenclature_mapping_cards (тогда --owner обязателен).
 * Понимает и mysqldump, и собственный дампер ScanFlow (INSERT со списком колонок).
 */
import fs from 'fs';

export type DumpRow = Record<string, string | number | null>;

function columnsFromCreate(sql: string, table: string): string[] | null {
  const m = new RegExp('CREATE TABLE `' + table + '` \\(([\\s\\S]*?)\\n\\)', 'm').exec(sql);
  if (!m) return null;
  return m[1].split('\n').map(l => l.trim()).filter(l => l.startsWith('`')).map(l => l.slice(1, l.indexOf('`', 1)));
}

function parseTuples(s: string, start: number): { rows: Array<Array<string | number | null>>; end: number } {
  const rows: Array<Array<string | number | null>> = [];
  let i = start;
  for (;;) {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
    if (i >= s.length || s[i] === ';') return { rows, end: i + 1 };
    if (s[i] !== '(') throw new Error(`dump parse: expected "(" at ${i}`);
    i++;
    const row: Array<string | number | null> = [];
    for (;;) {
      while (/\s/.test(s[i])) i++;
      if (s[i] === "'") {
        i++;
        let out = '';
        for (;;) {
          const c = s[i];
          if (c === undefined) throw new Error('dump parse: unterminated string');
          if (c === '\\') {
            const d = s[i + 1];
            out += d === 'n' ? '\n' : d === 'r' ? '\r' : d === 't' ? '\t' : d === '0' ? '\0' : d === 'Z' ? '\x1a' : d;
            i += 2;
          } else if (c === "'") {
            if (s[i + 1] === "'") { out += "'"; i += 2; } else { i++; break; }
          } else { out += c; i++; }
        }
        row.push(out);
      } else {
        let j = i;
        while (s[j] !== ',' && s[j] !== ')') j++;
        const tok = s.slice(i, j).trim();
        row.push(tok === 'NULL' ? null : /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(tok) ? Number(tok) : tok);
        i = j;
      }
      while (s[i] === ' ') i++;
      if (s[i] === ',') { i++; continue; }
      if (s[i] === ')') { i++; break; }
      throw new Error(`dump parse: bad tuple at ${i}`);
    }
    rows.push(row);
  }
}

/** Все строки таблицы из текста дампа. */
export function parseDumpTable(sql: string, table: string): DumpRow[] {
  const createCols = columnsFromCreate(sql, table);
  const head = 'INSERT INTO `' + table + '`';
  const out: DumpRow[] = [];
  let pos = 0;
  for (;;) {
    const k = sql.indexOf(head, pos);
    if (k < 0) break;
    let i = k + head.length;
    while (sql[i] === ' ') i++;
    let cols = createCols;
    if (sql[i] === '(') {
      const close = sql.indexOf(')', i);
      cols = sql.slice(i + 1, close).split(',').map(c => c.trim().replace(/`/g, ''));
      i = close + 1;
    }
    if (!cols) throw new Error(`dump parse: no column list for ${table}`);
    i = sql.indexOf('VALUES', i) + 'VALUES'.length;
    const { rows, end } = parseTuples(sql, i);
    for (const r of rows) out.push(Object.fromEntries(cols.map((c, idx) => [c, r[idx] ?? null])));
    pos = end;
  }
  return out;
}

/** Строки дампа → тело для POST /api/mappings/restore (только с позицией 1С). */
export function toRestoreRows(rows: DumpRow[], owner?: number): Array<Record<string, unknown>> {
  return rows
    .filter(r => owner == null || Number(r.owner_user_id) === owner)
    .filter(r => r.scanned_name && r.onec_guid)
    .map(r => ({
      scanned_name: r.scanned_name, onec_guid: r.onec_guid,
      pack_size: r.pack_size ?? null, pack_unit: r.pack_unit ?? null,
      default_unit: r.default_unit ?? null, category: r.category ?? null,
    }));
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  const table = args.filter(a => !a.startsWith('--'))[1] ?? 'nomenclature_mappings';
  const ownerArg = args.find(a => a.startsWith('--owner='));
  const owner = ownerArg ? Number(ownerArg.split('=')[1]) : undefined;
  if (!file) {
    process.stderr.write('usage: restore-mappings-from-dump.ts <dump.sql> [table] [--owner=N]\n');
    process.exit(1);
  }
  if (table === 'nomenclature_mapping_cards' && owner == null) {
    process.stderr.write('--owner=N обязателен для nomenclature_mapping_cards\n');
    process.exit(1);
  }
  const rows = toRestoreRows(parseDumpTable(fs.readFileSync(file, 'utf8'), table), owner);
  process.stdout.write(JSON.stringify({ label: `${file.split(/[\\/]/).pop()}:${table}`, rows }));
  process.stderr.write(`${table}: ${rows.length} rows with onec_guid\n`);
}
