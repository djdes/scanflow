import { ParsedInvoiceData, ParsedInvoiceItem } from './types';

/**
 * Пары «название — числа» по порядку строк (инцидент 30.09.2026, накладная 783).
 *
 * На фото под углом или с изогнутым листом (счёт в файле-вкладыше) числа справа
 * оказываются на уровне соседней строки, причём вверху и внизу листа по-разному.
 * Основное чтение сопоставляет названия с числами по высоте текста и сдвигает
 * пары: первая строка остаётся без чисел, а «лишнюю» строку чисел модель
 * переносит в неё или повторяет название соседней строки. Сумма строк при этом
 * сходится с итогом, так что арифметика ошибку не видит.
 *
 * Отдельное чтение ТОЛЬКО чисел сверху вниз (без названий) на тех же фото
 * стабильно даёт строки чисел в верном порядке (6 прогонов из 6). Здесь пары
 * собираются заново: i-е название ↔ i-я строка чисел. Чистая функция.
 */

/** Строка чисел таблицы, прочитанная отдельно от названий (цена — необязательно). */
export interface NumberRow {
  quantity: number | null;
  unit: string | null;
  total: number | null;
  price?: number | null;
}

export interface PairingOutcome {
  data: ParsedInvoiceData;
  changed: boolean;
  /** Почему пары оставлены или пересобраны — для лога. */
  reason: string;
  /** Изменённые строки: «Баклажаны: 1274 → 513». */
  changes: string[];
}

const MONEY_EPS = 0.011;
const QTY_EPS = 0.0005;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const near = (a: unknown, b: unknown, eps: number) => isNum(a) && isNum(b) && Math.abs(a - b) <= eps;
const sameQty = (a: unknown, b: unknown) => (a == null && b == null) || near(a, b, QTY_EPS);
const normName = (s: unknown) => String(s ?? '').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
const filled = (r: NumberRow) => isNum(r.quantity) || isNum(r.price) || isNum(r.total);
const round2 = (n: number) => Math.round(n * 100) / 100;

export function repairRowPairing(
  data: ParsedInvoiceData,
  numberRows: NumberRow[] | null | undefined,
  opts: { mainHasIssues: boolean },
): PairingOutcome {
  const keep = (reason: string): PairingOutcome => ({ data, changed: false, reason, changes: [] });
  if (!Array.isArray(numberRows)) return keep('нет отдельного чтения чисел');
  // Пустая строка чисел — артефакт того же сдвига (строка сетки без чисел на её уровне).
  const rows = numberRows.filter(filled);
  const items = Array.isArray(data.items) ? data.items : [];
  if (rows.length < 2 || items.length < 2) return keep('меньше двух строк');

  // Отдельное чтение должно быть самосогласованным и сходиться с итогом —
  // иначе оно прочитало не те колонки (например, «без НДС») или ошиблось.
  if (!rows.every(r => isNum(r.total) && r.total > 0)) return keep('в отдельном чтении есть строки без суммы');
  const totalSum = data.total_sum;
  const rowsSum = rows.reduce((s, r) => s + (r.total as number), 0);
  if (!isNum(totalSum) || totalSum <= 0 || Math.abs(rowsSum - totalSum) > Math.max(1, totalSum * 0.005)) {
    return keep('сумма строк отдельного чтения не сходится с итогом');
  }
  const inconsistent = rows.some(r => isNum(r.quantity) && isNum(r.price)
    && Math.abs(r.quantity * r.price - (r.total as number)) > Math.max(1, (r.total as number) * 0.01));
  if (inconsistent) return keep('в отдельном чтении кол-во × цена ≠ сумма');

  // Уже совпадает строка в строку — менять нечего.
  const aligned = items.length === rows.length
    && items.every((it, i) => near(it.total, rows[i].total, MONEY_EPS) && sameQty(it.quantity, rows[i].quantity));
  if (aligned) return keep('пары совпадают');

  // Названия по порядку. Повтор названия у соседних строк — «догоняли» сдвиг:
  // схлопываем, только если после этого число названий совпадает с числом строк.
  let names: ParsedInvoiceItem[] = items;
  if (names.length !== rows.length) {
    const collapsed = items.filter((it, i) => i === 0 || normName(it.name) !== normName(items[i - 1].name));
    if (collapsed.length !== rows.length) return keep(`названий ${items.length}, строк чисел ${rows.length}`);
    names = collapsed;
  }

  // Результат без замечаний меняем, только если это перестановка его же чисел.
  if (!opts.mainHasIssues) {
    const a = items.map(it => it.total).filter(isNum).sort((x, y) => x - y);
    const b = rows.map(r => r.total as number).sort((x, y) => x - y);
    const permutation = a.length === b.length && a.every((t, i) => near(t, b[i], MONEY_EPS));
    if (!permutation) return keep('результат без замечаний, а числа отличаются не только порядком');
  }

  const rates = items.map(it => it.vat_rate).filter(isNum);
  const commonRate = rates.length && rates.every(r => r === rates[0]) ? rates[0] : undefined;
  // Номера «№» оставляем, если они идут подряд; иначе (сдвиг, убранный повтор) —
  // нумеруем подряд от первого (на листе-продолжении нумерация начинается не с 1).
  const nos = names.map(n => n.row_no);
  const consecutive = nos.every((n, i) => isNum(n) && (i === 0 || n === (nos[i - 1] as number) + 1));
  const firstNo = isNum(nos[0]) ? nos[0] : undefined;

  const used = new Set<number>();
  const changes: string[] = [];
  const newItems = names.map((nameItem, i): ParsedInvoiceItem => {
    const r = rows[i];
    // Числа берём из основного чтения, если там есть строка с той же суммой и
    // количеством (его правила колонок точнее), иначе — из отдельного чтения.
    let k = items.findIndex((it, j) => !used.has(j) && near(it.total, r.total, MONEY_EPS)
      && (r.quantity == null || it.quantity == null || near(it.quantity, r.quantity, QTY_EPS)));
    if (k < 0) k = items.findIndex((it, j) => !used.has(j) && near(it.total, r.total, MONEY_EPS));
    if (k >= 0) used.add(k);
    const src = k >= 0 ? items[k] : null;
    const next: ParsedInvoiceItem = {
      ...nameItem,
      quantity: src?.quantity ?? r.quantity ?? undefined,
      unit: src?.unit ?? r.unit ?? undefined,
      price: src?.price ?? r.price ?? (isNum(r.quantity) && r.quantity > 0 && isNum(r.total) ? round2(r.total / r.quantity) : undefined),
      total: src?.total ?? r.total ?? undefined,
      vat_rate: src?.vat_rate ?? commonRate ?? nameItem.vat_rate,
      row_no: consecutive || firstNo == null ? nameItem.row_no : firstNo + i,
    };
    if (!near(nameItem.total, next.total, MONEY_EPS) || !sameQty(nameItem.quantity, next.quantity)) {
      changes.push(`${String(nameItem.name).trim()}: ${nameItem.quantity ?? '—'} ${nameItem.unit ?? ''} = ${nameItem.total ?? '—'} → ${next.quantity ?? '—'} ${next.unit ?? ''} = ${next.total ?? '—'}`);
    }
    return next;
  });

  if (!changes.length && names === items) return keep('пары совпадают');
  return {
    data: { ...data, items: newItems },
    changed: true,
    reason: `пары собраны по порядку строк (${changes.length} из ${newItems.length} изменились${names !== items ? `, убран повтор названия: ${items.length}→${names.length}` : ''})`,
    changes,
  };
}
