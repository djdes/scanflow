/**
 * Эталоны (п.17 пакета v2): сравнение «проверенная накладная ↔ повторное
 * распознавание того же фото».
 *
 * Чистый модуль — ни БД, ни сети, ни часов. На вход:
 *   - truth — то, что хранится в накладной и проверено человеком;
 *   - recognized — то, что текущая модель/промпт прочитали с того же фото.
 * На выход — поштучное сравнение полей и сводка точности. Ради этого сравнения
 * эталоны и существуют: заказчику нужно заметить, если после смены модели или
 * промпта «поехали» суммы, НДС или номера счетов, раньше, чем это дойдёт до 1С
 * и банка.
 *
 * Правила (зафиксированы в задаче, не ослаблять без причины):
 *   - номер — после normalizeInvoiceNumber (регистр, кириллица↔латиница,
 *     разделители, «№»): OCR-двойники букв ошибкой не считаются;
 *   - дата — точное совпадение (разрешена только смена записи ДД.ММ.ГГГГ →
 *     ГГГГ-ММ-ДД, значение даты не округляется);
 *   - сумма и НДС — с допуском 0,01; ИНН — точно (без пробелов);
 *   - строки — количество строк должно совпасть, дальше по позиции:
 *     количество ±0,001, цена и сумма ±0,01, единица — без учёта регистра,
 *     пробелов по краям и точки в конце («шт.» = «шт»).
 * Пустое с обеих сторон (null ↔ null) — совпадение: «в документе этого нет»
 * и модель это подтвердила.
 */
import { normalizeInvoiceNumber } from '../utils/invoiceNumber';

export const MONEY_TOLERANCE = 0.01;
export const QTY_TOLERANCE = 0.001;
// Запас на двоичную арифметику: 1932.01 - 1932 = 0.00999999999990905.
const EPS = 1e-9;

export interface GoldenLine {
  quantity: number | null;
  unit: string | null;
  price: number | null;
  total: number | null;
}

export interface GoldenDoc {
  invoice_number: string | null;
  invoice_date: string | null;
  total_sum: number | null;
  vat_sum: number | null;
  supplier_inn: string | null;
  items: GoldenLine[];
}

export type HeaderField = 'invoice_number' | 'invoice_date' | 'total_sum' | 'vat_sum' | 'supplier_inn';
export const HEADER_FIELDS: readonly HeaderField[] = ['invoice_number', 'invoice_date', 'total_sum', 'vat_sum', 'supplier_inn'];

export type LineField = 'quantity' | 'unit' | 'price' | 'total';
export const LINE_FIELDS: readonly LineField[] = ['quantity', 'unit', 'price', 'total'];

export interface FieldCheck {
  field: string;
  expected: string | number | null;
  actual: string | number | null;
  ok: boolean;
}

export interface LineCheck {
  /** Номер строки с 1 (как в таблице накладной). */
  line: number;
  ok: boolean;
  /** Строка есть только с одной стороны: 'actual' — модель её не нашла, 'expected' — лишняя. */
  missing?: 'actual' | 'expected';
  fields: FieldCheck[];
}

export interface GoldenCompareSummary {
  header_ok: number;
  header_total: number;
  items_count_ok: boolean;
  items_ok: number;
  /** max(строк в эталоне, строк в распознавании): лишние/потерянные строки — ошибки. */
  items_total: number;
  /** items_ok / items_total, 1 — если строк нет ни там, ни там. */
  items_ok_ratio: number;
  all_ok: boolean;
  /** Поля шапки, не прошедшие сравнение, + 'items_count', если не сошлось число строк. */
  failed: string[];
  /**
   * Сколько строк не совпало по каждому полю — среди строк, что есть с обеих
   * сторон (потерянные/лишние видны по items_count). Только ненулевые.
   */
  line_failures: Partial<Record<LineField, number>>;
}

export interface GoldenCompareResult {
  header: FieldCheck[];
  items_count: FieldCheck;
  items: LineCheck[];
  summary: GoldenCompareSummary;
}

/** Число из БД/ответа модели: number, строка «1 932,50» или пусто → null. */
export function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const s = v.replace(/[\s ]+/g, '').replace(',', '.');
    if (s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Текст: пустая строка и не-строки (кроме чисел) → null. */
export function toText(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

function numbersClose(a: number | null, b: number | null, tolerance: number): boolean {
  if (a == null || b == null) return a == null && b == null;
  return Math.abs(a - b) <= tolerance + EPS;
}

/** ДД.ММ.ГГГГ → ГГГГ-ММ-ДД (так пишут и модель, и форма реквизитов); остальное — как есть. */
export function normalizeDate(v: string | null): string {
  if (!v) return '';
  const t = v.trim();
  const m = t.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : t;
}

export function normalizeInn(v: string | null): string {
  return v ? v.replace(/\s+/g, '') : '';
}

export function normalizeUnit(v: string | null): string {
  return v ? v.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\.+$/, '') : '';
}

function checkHeader(field: HeaderField, truth: GoldenDoc, rec: GoldenDoc): FieldCheck {
  switch (field) {
    case 'invoice_number':
      return {
        field,
        expected: truth.invoice_number,
        actual: rec.invoice_number,
        ok: normalizeInvoiceNumber(truth.invoice_number) === normalizeInvoiceNumber(rec.invoice_number),
      };
    case 'invoice_date':
      return {
        field,
        expected: truth.invoice_date,
        actual: rec.invoice_date,
        ok: normalizeDate(truth.invoice_date) === normalizeDate(rec.invoice_date),
      };
    case 'supplier_inn':
      return {
        field,
        expected: truth.supplier_inn,
        actual: rec.supplier_inn,
        ok: normalizeInn(truth.supplier_inn) === normalizeInn(rec.supplier_inn),
      };
    case 'total_sum':
    case 'vat_sum':
      return {
        field,
        expected: truth[field],
        actual: rec[field],
        ok: numbersClose(truth[field], rec[field], MONEY_TOLERANCE),
      };
  }
}

function checkLineField(field: LineField, t: GoldenLine, r: GoldenLine): FieldCheck {
  if (field === 'unit') {
    return { field, expected: t.unit, actual: r.unit, ok: normalizeUnit(t.unit) === normalizeUnit(r.unit) };
  }
  const tolerance = field === 'quantity' ? QTY_TOLERANCE : MONEY_TOLERANCE;
  return { field, expected: t[field], actual: r[field], ok: numbersClose(t[field], r[field], tolerance) };
}

export function compareGolden(truth: GoldenDoc, recognized: GoldenDoc): GoldenCompareResult {
  const header = HEADER_FIELDS.map(f => checkHeader(f, truth, recognized));

  const expectedCount = truth.items.length;
  const actualCount = recognized.items.length;
  const items_count: FieldCheck = {
    field: 'items_count',
    expected: expectedCount,
    actual: actualCount,
    ok: expectedCount === actualCount,
  };

  const lineFailures: Partial<Record<LineField, number>> = {};
  const items: LineCheck[] = [];
  const maxLines = Math.max(expectedCount, actualCount);
  for (let i = 0; i < maxLines; i++) {
    const t = truth.items[i];
    const r = recognized.items[i];
    if (t && r) {
      const fields = LINE_FIELDS.map(f => checkLineField(f, t, r));
      for (const fc of fields) {
        if (!fc.ok) lineFailures[fc.field as LineField] = (lineFailures[fc.field as LineField] ?? 0) + 1;
      }
      items.push({ line: i + 1, ok: fields.every(fc => fc.ok), fields });
    } else {
      // Строка только с одной стороны — целиком ошибка; значения показываем,
      // чтобы в отчёте было видно, какую именно строку потеряли/выдумали.
      const present = (t ?? r) as GoldenLine;
      items.push({
        line: i + 1,
        ok: false,
        missing: t ? 'actual' : 'expected',
        fields: LINE_FIELDS.map(f => ({
          field: f,
          expected: t ? present[f] : null,
          actual: r ? present[f] : null,
          ok: false,
        })),
      });
    }
  }

  const headerOk = header.filter(h => h.ok).length;
  const itemsOk = items.filter(l => l.ok).length;
  const itemsTotal = maxLines;
  const failed = header.filter(h => !h.ok).map(h => h.field);
  if (!items_count.ok) failed.push('items_count');

  return {
    header,
    items_count,
    items,
    summary: {
      header_ok: headerOk,
      header_total: header.length,
      items_count_ok: items_count.ok,
      items_ok: itemsOk,
      items_total: itemsTotal,
      items_ok_ratio: itemsTotal === 0 ? 1 : Math.round((itemsOk / itemsTotal) * 10000) / 10000,
      all_ok: headerOk === header.length && items_count.ok && itemsOk === itemsTotal,
      failed,
      line_failures: lineFailures,
    },
  };
}

// ── «Правда» эталона из строк БД ────────────────────────────────────────────

const RAW_KEYS = ['raw_quantity', 'raw_unit', 'raw_price', 'raw_total'] as const;

/**
 * Строка эталона. Пакет v2 хранит в invoice_items значения «как в накладной»
 * (raw_quantity/raw_unit/raw_price/raw_total) рядом с пересчитанными в единицы
 * 1С — сравнивать распознавание нужно именно с ними: модель читает документ,
 * а не пересчитывает упаковки. Пока колонок raw_* нет (или строка их не
 * заполнила — все четыре NULL), берём quantity/unit/price/total. Сумма строки
 * пересчётом не меняется никогда, так что по total сравнение честное в обоих
 * случаях.
 */
export function truthLine(row: object): GoldenLine {
  const r = row as Record<string, unknown>;
  const hasRaw = RAW_KEYS.some(k => k in r) && RAW_KEYS.some(k => r[k] != null);
  if (hasRaw) {
    return {
      quantity: toNumber(r.raw_quantity),
      unit: toText(r.raw_unit),
      price: toNumber(r.raw_price),
      total: toNumber(r.raw_total),
    };
  }
  return {
    quantity: toNumber(r.quantity),
    unit: toText(r.unit),
    price: toNumber(r.price),
    total: toNumber(r.total),
  };
}

export interface TruthHeaderSource {
  invoice_number?: string | null;
  invoice_date?: string | null;
  total_sum?: number | string | null;
  vat_sum?: number | string | null;
  supplier_inn?: string | null;
}

/** Эталон целиком: шапка накладной + строки в порядке хранения (ORDER BY id). */
export function truthFromInvoice(inv: TruthHeaderSource, items: ReadonlyArray<object>): GoldenDoc {
  return {
    invoice_number: toText(inv.invoice_number),
    invoice_date: toText(inv.invoice_date),
    total_sum: toNumber(inv.total_sum),
    vat_sum: toNumber(inv.vat_sum),
    supplier_inn: toText(inv.supplier_inn),
    items: items.map(truthLine),
  };
}
