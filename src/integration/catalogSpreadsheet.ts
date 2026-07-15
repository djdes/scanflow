import crypto from 'crypto';
import readXlsxFile from 'read-excel-file/node';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { OnecNomenclatureInput } from '../database/repositories/onecNomenclatureRepo';

const MAX_ROWS = 50_000;
const MAX_COLUMNS = 100;
const HEADER_SCAN_ROWS = 25;

type CatalogField = 'guid' | 'code' | 'name' | 'full_name' | 'unit' | 'parent_guid' | 'is_folder' | 'is_weighted';
type TableCell = unknown;
type TableRow = TableCell[];

export interface ParsedCatalogSpreadsheet {
  items: OnecNomenclatureInput[];
  sourceRows: number;
  skippedRows: number;
  duplicateRows: number;
  sheet: string | null;
  headerRow: number | null;
  detectedColumns: Partial<Record<CatalogField, string>>;
  generatedIds: number;
  warnings: string[];
}

const HEADER_ALIASES: Record<CatalogField, string[]> = {
  guid: ['guid', 'uuid', 'уникальный идентификатор', 'идентификатор', 'идентификатор 1с', 'id 1c', 'id 1с'],
  code: ['код', 'код номенклатуры', 'артикул', 'sku', 'code'],
  name: ['наименование', 'название', 'товар', 'номенклатура', 'наименование номенклатуры', 'name'],
  full_name: ['полное наименование', 'наименование полное', 'полное название', 'full name'],
  unit: ['ед', 'ед.', 'единица', 'единица измерения', 'базовая единица', 'базовая единица измерения', 'unit'],
  parent_guid: ['guid родителя', 'uuid родителя', 'идентификатор родителя', 'parent guid', 'parent uuid'],
  is_folder: ['это группа', 'группа', 'является группой', 'is folder'],
  is_weighted: ['весовой', 'весовой товар', 'это весовой товар', 'is weighted'],
};

function normalizeHeader(value: string): string {
  return value.toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[^a-zа-я0-9]+/g, ' ')
    .trim();
}

const NORMALIZED_ALIASES = Object.fromEntries(
  Object.entries(HEADER_ALIASES).map(([field, aliases]) => [field, new Set(aliases.map(normalizeHeader))])
) as Record<CatalogField, Set<string>>;

function cellText(value: TableCell): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') return '';
  return String(value)
    // A few XLSX exporters encode Cyrillic as numeric XML entities and some
    // lightweight readers return those entities verbatim.
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(parseInt(code, 10)))
    .replace(/\u00a0/g, ' ')
    .trim();
}

function decodeText(buffer: Buffer): string {
  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8.replace(/^\uFEFF/, '');
  return new TextDecoder('windows-1251').decode(buffer).replace(/^\uFEFF/, '');
}

function delimiterFor(text: string): string {
  const lines = text.split(/\r?\n/).filter(value => value.trim()).slice(0, 20);
  const candidates = ['\t', ';', ','];
  const score = (delimiter: string) => lines.reduce((total, line) => total + line.split(delimiter).length - 1, 0);
  return candidates.sort((a, b) => score(b) - score(a))[0];
}

function assertSafeXlsxArchive(buffer: Buffer): void {
  const eocdSignature = 0x06054b50;
  const centralSignature = 0x02014b50;
  if (buffer.length < 22) throw new Error('Повреждённый XLSX');
  let eocd = -1;
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 65_557); index--) {
    if (buffer.readUInt32LE(index) === eocdSignature) { eocd = index; break; }
  }
  if (eocd < 0) throw new Error('Повреждённый XLSX: не найден каталог ZIP');
  const entries = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error('Слишком большой XLSX (ZIP64 не поддерживается)');
  }
  if (entries > 2_000 || centralOffset + centralSize > buffer.length) throw new Error('Повреждённый или слишком сложный XLSX');
  let offset = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== centralSignature) throw new Error('Повреждённый XLSX');
    const uncompressed = buffer.readUInt32LE(offset + 24);
    if (uncompressed === 0xffffffff) throw new Error('Слишком большой XLSX');
    totalUncompressed += uncompressed;
    if (totalUncompressed > 50 * 1024 * 1024) throw new Error('XLSX распаковывается больше чем в 50 МБ. Оставьте только нужные колонки.');
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    offset += 46 + nameLength + extraLength + commentLength;
  }
}

function removeEmptyInlineStringCells(buffer: Buffer): Buffer {
  const files = unzipSync(new Uint8Array(buffer));
  let changed = false;
  for (const [name, value] of Object.entries(files)) {
    if (!/^xl\/worksheets\/[^/]+\.xml$/i.test(name)) continue;
    const xml = strFromU8(value);
    const cleaned = xml
      .replace(/<c\b(?=[^>]*\bt=["']inlineStr["'])[^>]*>\s*<\/c>/gi, '')
      .replace(/<c\b(?=[^>]*\bt=["']inlineStr["'])[^>]*\/>/gi, '');
    if (cleaned !== xml) {
      files[name] = strToU8(cleaned);
      changed = true;
    }
  }
  return changed ? Buffer.from(zipSync(files, { level: 6 })) : buffer;
}

export function parseDelimitedTable(text: string): string[][] {
  const delimiter = delimiterFor(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  const pushCell = () => { row.push(cell.trim()); cell = ''; };
  const pushRow = () => {
    pushCell();
    if (row.some(value => value.trim())) rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { cell += '"'; index++; }
      else quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      pushCell();
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[index + 1] === '\n') index++;
      pushRow();
    } else {
      cell += char;
    }
  }
  if (cell || row.length) pushRow();
  return rows;
}

async function readTable(buffer: Buffer, filename: string): Promise<{ rows: TableRow[]; sheet: string | null }> {
  const lower = filename.toLocaleLowerCase('ru-RU');
  const isZip = buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
  if (lower.endsWith('.xls')) throw new Error('Старый формат XLS не поддерживается. В 1С выберите «Сохранить как» → XLSX или CSV.');
  if (lower.endsWith('.xlsx') || isZip) {
    assertSafeXlsxArchive(buffer);
    let sheets: Array<{ sheet: string; data: TableRow[] }>;
    try {
      sheets = await readXlsxFile<string>(buffer, { trim: true, parseNumber: value => value }) as Array<{ sheet: string; data: TableRow[] }>;
    } catch (error) {
      // Some exporters emit empty `inlineStr` cells. They are semantically
      // blank but strict readers reject them, so remove only those empty cells
      // and retry without evaluating or rewriting any actual values.
      if (error instanceof Error && /inline string/i.test(error.message)) {
        try {
          const cleaned = removeEmptyInlineStringCells(buffer);
          sheets = await readXlsxFile<string>(cleaned, { trim: true, parseNumber: value => value }) as Array<{ sheet: string; data: TableRow[] }>;
        } catch {
          throw new Error('Не удалось прочитать XLSX. Пересохраните файл в 1С/Excel или используйте CSV.');
        }
      } else {
        throw new Error('Не удалось прочитать XLSX. Пересохраните файл в 1С/Excel или используйте CSV.');
      }
    }
    const first = sheets.find(candidate => candidate.data.some(row => row.some(value => cellText(value))));
    if (!first) throw new Error('В книге Excel нет заполненных листов');
    return { rows: first.data as TableRow[], sheet: first.sheet };
  }
  if (!/\.(csv|tsv|txt)$/i.test(lower)) throw new Error('Поддерживаются XLSX, CSV и TSV');
  return { rows: parseDelimitedTable(decodeText(buffer)), sheet: null };
}

function detectHeader(rows: TableRow[]): {
  rowIndex: number | null;
  indexes: Partial<Record<CatalogField, number>>;
  labels: Partial<Record<CatalogField, string>>;
  fallback: boolean;
} {
  let best: { rowIndex: number; score: number; indexes: Partial<Record<CatalogField, number>>; labels: Partial<Record<CatalogField, string>> } | null = null;
  for (let rowIndex = 0; rowIndex < Math.min(HEADER_SCAN_ROWS, rows.length); rowIndex++) {
    const indexes: Partial<Record<CatalogField, number>> = {};
    const labels: Partial<Record<CatalogField, string>> = {};
    rows[rowIndex].slice(0, MAX_COLUMNS).forEach((value, columnIndex) => {
      const original = cellText(value);
      const header = normalizeHeader(original);
      if (!header) return;
      for (const field of Object.keys(NORMALIZED_ALIASES) as CatalogField[]) {
        if (indexes[field] == null && NORMALIZED_ALIASES[field].has(header)) {
          indexes[field] = columnIndex;
          labels[field] = original;
          break;
        }
      }
    });
    if (indexes.name == null) continue;
    const score = Object.keys(indexes).length;
    if (!best || score > best.score) best = { rowIndex, score, indexes, labels };
  }
  if (best) return { rowIndex: best.rowIndex, indexes: best.indexes, labels: best.labels, fallback: false };

  const firstIndex = rows.findIndex(row => row.some(value => cellText(value)));
  if (firstIndex < 0) return { rowIndex: null, indexes: {}, labels: {}, fallback: true };
  const first = rows[firstIndex].map(cellText);
  const indexes: Partial<Record<CatalogField, number>> = {};
  const labels: Partial<Record<CatalogField, string>> = {};
  const looksLikeCode = /^[a-zа-я0-9._/-]{1,40}$/i.test(first[0] || '') && !/\s/.test(first[0] || '') && Boolean(first[1]);
  if (looksLikeCode) {
    indexes.code = 0;
    indexes.name = 1;
    labels.code = 'Колонка 1 (код)';
    labels.name = 'Колонка 2 (название)';
    if (first[2]) { indexes.unit = 2; labels.unit = 'Колонка 3 (единица)'; }
  } else {
    indexes.name = 0;
    labels.name = 'Колонка 1 (название)';
  }
  return { rowIndex: firstIndex - 1, indexes, labels, fallback: true };
}

function valueAt(row: TableRow, index: number | undefined, maxLength: number): string | null {
  if (index == null) return null;
  const value = cellText(row[index]).replace(/\s+/g, ' ').trim();
  return value ? value.slice(0, maxLength) : null;
}

function booleanAt(row: TableRow, index: number | undefined): boolean {
  const value = normalizeHeader(valueAt(row, index, 32) || '');
  return ['1', 'да', 'истина', 'true', 'yes', 'группа'].includes(value);
}

function stableLocalGuid(code: string | null, name: string): string {
  const fingerprint = `${code || ''}\u0000${name}`.toLocaleLowerCase('ru-RU').trim();
  return `manual-${crypto.createHash('sha256').update(fingerprint).digest('hex').slice(0, 48)}`;
}

function normalizeGuid(value: string | null): string | null {
  if (!value) return null;
  const cleaned = value.replace(/^\{([0-9a-f-]+)\}$/i, '$1').trim();
  if (!cleaned || cleaned.length > 64) return null;
  return cleaned;
}

export async function parseCatalogSpreadsheet(buffer: Buffer, filename: string): Promise<ParsedCatalogSpreadsheet> {
  if (!buffer.length) throw new Error('Файл пуст');
  const { rows, sheet } = await readTable(buffer, filename);
  if (rows.length > MAX_ROWS + HEADER_SCAN_ROWS) throw new Error(`В файле больше ${MAX_ROWS.toLocaleString('ru-RU')} строк. Разделите каталог на несколько файлов.`);
  if (rows.some(row => row.length > MAX_COLUMNS)) throw new Error(`В файле больше ${MAX_COLUMNS} колонок. Оставьте только Код, Наименование, Единицу и GUID.`);

  const detected = detectHeader(rows);
  if (detected.indexes.name == null) throw new Error('Не найдена колонка с названием товара');
  const firstDataRow = Math.max(0, (detected.rowIndex ?? -1) + 1);
  const itemsByGuid = new Map<string, OnecNomenclatureInput>();
  let skippedRows = 0;
  let duplicateRows = 0;
  const generatedGuids = new Set<string>();

  for (const row of rows.slice(firstDataRow)) {
    const name = valueAt(row, detected.indexes.name, 512);
    if (!name || /^итого:?$/i.test(name)) { skippedRows++; continue; }
    const code = valueAt(row, detected.indexes.code, 64);
    const sourceGuid = normalizeGuid(valueAt(row, detected.indexes.guid, 128));
    const guid = sourceGuid || stableLocalGuid(code, name);
    if (!sourceGuid) generatedGuids.add(guid);
    if (itemsByGuid.has(guid)) duplicateRows++;
    itemsByGuid.set(guid, {
      guid,
      code,
      name,
      full_name: valueAt(row, detected.indexes.full_name, 1024),
      unit: valueAt(row, detected.indexes.unit, 32),
      parent_guid: normalizeGuid(valueAt(row, detected.indexes.parent_guid, 128)),
      is_folder: booleanAt(row, detected.indexes.is_folder),
      is_weighted: booleanAt(row, detected.indexes.is_weighted),
    });
  }

  const items = [...itemsByGuid.values()];
  const generatedIds = generatedGuids.size;
  if (items.length === 0) throw new Error('Не удалось прочитать ни одного товара');
  const warnings: string[] = [];
  if (detected.fallback) warnings.push('Заголовки не найдены — колонки распознаны по расположению. Проверьте первые позиции после импорта.');
  if (generatedIds > 0) warnings.push(`У ${generatedIds} позиций нет GUID 1С — созданы стабильные локальные идентификаторы для пробного запуска.`);

  return {
    items,
    sourceRows: Math.max(0, rows.length - firstDataRow),
    skippedRows,
    duplicateRows,
    sheet,
    headerRow: detected.rowIndex == null || detected.rowIndex < 0 ? null : detected.rowIndex + 1,
    detectedColumns: detected.labels,
    generatedIds,
    warnings,
  };
}
