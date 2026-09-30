import { ParsedInvoiceData } from './types';

/**
 * Server-side arithmetic/format validation of a parsed invoice.
 *
 * Pure function, no I/O — every check runs on the ParsedInvoiceData alone.
 * Мotivation: даже с усиленным промптом и structured outputs Sonnet 5
 * периодически путает колонки цифр или берёт НДС из промежуточного «Итого».
 * Этот модуль ловит такие расхождения детерминированно и (через
 * `analyzeWithVerification` в claudeApiAnalyzer) даёт модели один шанс
 * перечитать проблемные строки.
 *
 * Каждый issue.message пишется по-русски и уходит прямо в repair-промпт,
 * поэтому формулировки конкретные («в строке 3 quantity×price = 1240, а
 * total = 12400 — перечитай строку 3»).
 */
export type ValidationIssueCode =
  | 'row_math'
  | 'qty_digits'
  | 'total_mismatch'
  | 'vat_mismatch'
  | 'inn_checksum'
  | 'kpp_format'
  | 'date_range'
  | 'row_alignment';

export interface ValidationIssue {
  code: ValidationIssueCode;
  rowNo?: number; // для строчных проверок (row_math, qty_digits)
  message: string; // человекочитаемо, по-русски — уходит в repair-промпт
}

// Допуски (см. spec-таблицу и CLAUDE.md п.3).
const ROW_MATH_TOLERANCE = 0.01; // ±1% на qty×price≈total
const TOTAL_SUM_TOLERANCE_RUB = 1; // ±1 ₽ на Σitems≈total_sum
const VAT_TOLERANCE = 0.02; // ±2% на vat_sum≈Σ(total×ставка/(100+ставка))
const MAX_QTY_DIGITS = 4; // ТОРГ-12: количество ≤ 4 значащих цифр
const DATE_PAST_YEARS = 2;
const DATE_FUTURE_DAYS = 7;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Контрольная сумма ИНН (10 или 12 цифр). Возвращает true для валидного
 * номера. Строка должна содержать только цифры нужной длины.
 */
export function isValidInn(inn: string): boolean {
  if (!/^\d{10}$/.test(inn) && !/^\d{12}$/.test(inn)) return false;
  const d = inn.split('').map(Number);
  const check = (coeffs: number[], upto: number): number => {
    let sum = 0;
    for (let i = 0; i < coeffs.length; i++) sum += coeffs[i] * d[i];
    return (sum % 11) % 10;
  };
  if (d.length === 10) {
    return check([2, 4, 10, 3, 5, 9, 4, 6, 8], 9) === d[9];
  }
  // 12 цифр — две контрольные
  const n11 = check([7, 2, 4, 10, 3, 5, 9, 4, 6, 8], 10);
  const n12 = check([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8], 11);
  return n11 === d[10] && n12 === d[11];
}

export function validateParsedInvoice(
  data: ParsedInvoiceData,
  now: Date = new Date(),
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const items = Array.isArray(data.items) ? data.items : [];

  // 1. row_math + qty_digits — построчно.
  for (const it of items) {
    const rowNo = isFiniteNumber(it.row_no) ? it.row_no : undefined;

    if (isFiniteNumber(it.quantity) && isFiniteNumber(it.price) && isFiniteNumber(it.total)
      && it.quantity > 0 && it.price > 0 && it.total !== 0) {
      const expected = it.quantity * it.price;
      const denom = Math.max(Math.abs(expected), Math.abs(it.total));
      if (denom > 0 && Math.abs(expected - it.total) / denom > ROW_MATH_TOLERANCE) {
        issues.push({
          code: 'row_math',
          rowNo,
          message: `В строке ${rowNo ?? '?'} quantity×price = ${expected.toFixed(2)}, `
            + `а total = ${it.total.toFixed(2)} — перечитай строку ${rowNo ?? ''}: `
            + `скорее всего перепутаны колонки «Количество»/«Цена»/«Стоимость с НДС».`,
        });
      }
    }

    if (isFiniteNumber(it.quantity)) {
      const intDigits = Math.abs(Math.trunc(it.quantity)).toString().length;
      if (intDigits > MAX_QTY_DIGITS) {
        issues.push({
          code: 'qty_digits',
          rowNo,
          message: `В строке ${rowNo ?? '?'} quantity = ${it.quantity} — больше ${MAX_QTY_DIGITS} цифр. `
            + `Это почти наверняка код товара (артикул), а не количество. Перечитай колонку «Количество».`,
        });
      }
    }
  }

  // Страница-ПРОДОЛЖЕНИЕ многостраничной накладной содержит лишь ЧАСТЬ позиций.
  // Если на ней есть «Всего по накладной» (последний лист), total_sum — это ОБЩИЙ
  // итог всей накладной и законно больше суммы позиций ЭТОГО листа. Тогда
  // total_mismatch/vat_mismatch дали бы ложное срабатывание, а repair мог бы
  // «починить» его, затерев общий итог суммой одной позиции — поэтому на таких
  // листах эти две проверки пропускаем (построчные row_math/qty_digits работают).
  //
  // Признак продолжения (любого достаточно):
  //   • нет номера документа в шапке (модель вернула invoice_number = null), ИЛИ
  //   • первая позиция листа имеет row_no > 1 (позиции 1..N остались на прошлых
  //     листах). Второй признак надёжнее: некоторые накладные ДУБЛИРУЮТ номер на
  //     каждом листе, и тогда только row_no отличает продолжение от первого листа.
  const headerPresent = data.invoice_number != null && String(data.invoice_number).trim() !== '';
  const rowNos = items.map(it => it.row_no).filter(isFiniteNumber);
  const minRowNo = rowNos.length ? Math.min(...rowNos) : 1;
  const isContinuationPage = !headerPresent || minRowNo > 1;

  // 2. total_mismatch — Σ(items.total) ≈ total_sum. Только на первом/полном листе.
  if (!isContinuationPage && isFiniteNumber(data.total_sum)) {
    const sum = items.reduce((acc, it) => acc + (isFiniteNumber(it.total) ? it.total : 0), 0);
    if (Math.abs(sum - data.total_sum) > TOTAL_SUM_TOLERANCE_RUB) {
      issues.push({
        code: 'total_mismatch',
        message: `Сумма позиций Σ(total) = ${sum.toFixed(2)}, а total_sum = ${data.total_sum.toFixed(2)}. `
          + `Либо пропущена позиция, либо для части строк взят total без НДС, либо total_sum взят из колонки без НДС.`,
      });
    }
  }

  // 3. vat_mismatch — только на первом/полном листе (см. коммент к total_mismatch)
  //    и если есть и vat_sum, и хотя бы одна ставка.
  if (!isContinuationPage && isFiniteNumber(data.vat_sum)) {
    let expectedVat = 0;
    let haveRate = false;
    for (const it of items) {
      if (isFiniteNumber(it.total) && isFiniteNumber(it.vat_rate) && it.vat_rate > 0) {
        expectedVat += it.total * it.vat_rate / (100 + it.vat_rate);
        haveRate = true;
      }
    }
    if (haveRate) {
      const denom = Math.max(Math.abs(expectedVat), Math.abs(data.vat_sum));
      if (denom > 0 && Math.abs(expectedVat - data.vat_sum) / denom > VAT_TOLERANCE) {
        // Подсказка о ставке, вычисленной ИЗ печатного vat_sum — чаще всего
        // расхождение из-за того, что модель угадала ставку 20%, а по факту 22%
        // (счёт на оплату без колонки «ставка НДС»). Печатному vat_sum доверяем
        // больше, чем угаданным ставкам.
        let rateHint = '';
        if (isFiniteNumber(data.total_sum) && data.total_sum - data.vat_sum > 0) {
          const impliedRate = data.vat_sum / (data.total_sum - data.vat_sum) * 100;
          const standard = [10, 20, 22].reduce((best, r) =>
            Math.abs(r - impliedRate) < Math.abs(best - impliedRate) ? r : best, 20);
          rateHint = ` Ставка, вычисленная из vat_sum: ${impliedRate.toFixed(1)}% ≈ ${standard}%.`;
        }
        issues.push({
          code: 'vat_mismatch',
          message: `vat_sum = ${data.vat_sum.toFixed(2)} не сходится со ставками по позициям `
            + `(Σ(total×ставка/(100+ставка)) = ${expectedVat.toFixed(2)}).${rateHint} `
            + `Разберись: (а) если по позициям НЕТ колонки «ставка НДС» — ставки угаданы неверно: `
            + `проставь позициям ставку, вычисленную из vat_sum (см. выше), а vat_sum НЕ меняй; `
            + `(б) если vat_sum случайно взят из промежуточного «Итого» листа — возьми его из строки «Всего по накладной». `
            + `Печатной строке «В том числе НДС» доверяй больше, чем угаданным ставкам.`,
        });
      }
    }
  }

  // 4. inn_checksum — контрольная сумма (и длина) ИНН поставщика.
  if (data.supplier_inn != null && String(data.supplier_inn).trim() !== '') {
    const inn = String(data.supplier_inn).trim();
    if (!isValidInn(inn)) {
      issues.push({
        code: 'inn_checksum',
        message: `ИНН поставщика "${inn}" не проходит проверку контрольной суммы (или неверной длины — должно быть 10 или 12 цифр). Перечитай ИНН в шапке.`,
      });
    }
  }

  // 5. kpp_format — КПП ровно 9 цифр либо null.
  if (data.supplier_kpp != null && String(data.supplier_kpp).trim() !== '') {
    const kpp = String(data.supplier_kpp).trim();
    if (!/^\d{9}$/.test(kpp)) {
      issues.push({
        code: 'kpp_format',
        message: `КПП поставщика "${kpp}" — должно быть ровно 9 цифр. Перечитай КПП в шапке (у ИП КПП отсутствует — тогда null).`,
      });
    }
  }

  // 6. row_alignment — названия и числа строк сдвинуты относительно друг друга.
  const alignment = rowAlignmentProblems(items);
  if (alignment.length) {
    issues.push({
      code: 'row_alignment',
      message: `Похоже, названия и числа строк сдвинуты относительно друг друга: ${alignment.join('; ')}. `
        + `Так бывает, когда фото снято под углом или лист изогнут: числа справа (Кол-во, Цена, Сумма) оказываются `
        + `выше или ниже своего названия, вплоть до уровня соседней строки. Перечитай таблицу, не сопоставляя по `
        + `высоте текста: перечисли сверху вниз названия с номерами «№» и строки чисел; если их поровну — i-я `
        + `строка чисел относится к i-му названию. У каждой строки таблицы ровно одно название и один набор чисел; число строк в items `
        + `равно числу номеров в колонке «№» (и «Всего наименований N», если напечатано). Не повторяй название `
        + `соседней строки и не оставляй строку без чисел (если строка на самом деле без чисел — например, `
        + `заголовок раздела, — не включай её в items).`,
    });
  }

  // 7. date_range — invoice_date в [сегодня−2 года; сегодня+7 дней].
  if (data.invoice_date != null && String(data.invoice_date).trim() !== '') {
    const raw = String(data.invoice_date).trim();
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      issues.push({
        code: 'date_range',
        message: `invoice_date "${raw}" не распознана как дата. Ожидается формат YYYY-MM-DD. Перечитай дату «от DD месяца YYYY г.».`,
      });
    } else {
      const min = new Date(now);
      min.setFullYear(min.getFullYear() - DATE_PAST_YEARS);
      const max = new Date(now);
      max.setDate(max.getDate() + DATE_FUTURE_DAYS);
      if (parsed < min || parsed > max) {
        issues.push({
          code: 'date_range',
          message: `invoice_date "${raw}" вне разумного диапазона (${min.toISOString().slice(0, 10)} … ${max.toISOString().slice(0, 10)}). `
            + `Перечитай год/дату в шапке — возможно перепутаны цифры.`,
        });
      }
    }
  }

  return issues;
}

const normName = (s: unknown) => String(s ?? '').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
const hasNumbers = (it: { quantity?: unknown; price?: unknown; total?: unknown }) =>
  isFiniteNumber(it.quantity) || isFiniteNumber(it.price) || isFiniteNumber(it.total);

/**
 * Признаки того, что названия строк сдвинуты относительно их чисел (фото под
 * углом, числа справа визуально на полстроки выше/ниже). Инцидент — накладная 783
 * (30.09.2026): строка 1 без чисел, названия сдвинуты на строку, в конце «Мука
 * (50кг)» у двух соседних строк; сумма строк при этом совпала с итогом.
 * Чистая функция, возвращает описания для repair-промпта (пусто — всё в порядке).
 */
export function rowAlignmentProblems(items: ParsedInvoiceData['items']): string[] {
  const list = Array.isArray(items) ? items : [];
  if (list.length < 2) return [];
  const problems: string[] = [];
  const label = (i: number) => (isFiniteNumber(list[i].row_no) ? String(list[i].row_no) : `№${i + 1} по порядку`);

  // Строка с названием, но без количества, цены и суммы — при том что у других они есть.
  if (list.some(hasNumbers)) {
    list.forEach((it, i) => {
      if (normName(it.name) && !hasNumbers(it)) problems.push(`строка ${label(i)} «${String(it.name).trim()}» без количества, цены и суммы`);
    });
  }

  // Одно и то же название у соседних строк, а числа разные.
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1];
    const b = list[i];
    if (!normName(a.name) || normName(a.name) !== normName(b.name)) continue;
    const same = a.quantity === b.quantity && a.price === b.price && a.total === b.total;
    if (!same) problems.push(`у соседних строк ${label(i - 1)} и ${label(i)} одно название «${String(b.name).trim()}», а числа разные`);
  }

  // Номер строки из колонки «№» повторяется.
  const seen = new Map<number, number>();
  for (const it of list) if (isFiniteNumber(it.row_no)) seen.set(it.row_no, (seen.get(it.row_no) ?? 0) + 1);
  const dups = [...seen].filter(([, n]) => n > 1).map(([no]) => no);
  if (dups.length) problems.push(`номер строки ${dups.join(', ')} встречается дважды`);

  return problems;
}

/** Обычная цена товара в этой единице по истории компании; null — истории мало. */
export type UsualPriceLookup = (name: string, unit: string | null | undefined) => number | null;

/**
 * «Тихий» сдвиг строк по истории цен: цена строки далека от обычной для этого
 * товара (дальше чем в 1,8 раза), а обычной для него оказывается цена соседней
 * строки (±25%), — и так у двух строк и больше в одну сторону. Структурно такой
 * сдвиг не виден: все строки с числами, дублей нет, сумма сходится. Накладные
 * 748 и 783 (ИП Кнутова, фото в файле-вкладыше) и 756 (ушла в 1С); на 126
 * накладных прода — ровно эти три срабатывания.
 */
export function priceShiftProblems(
  items: Array<{ name?: unknown; unit?: unknown; price?: unknown }>,
  usualPrice: UsualPriceLookup,
): string[] {
  const list = Array.isArray(items) ? items : [];
  const OFF = Math.log(1.8);
  const FIT = Math.log(1.25);
  const round = (n: number) => String(Math.round(n * 100) / 100);
  const up: string[] = [];
  const down: string[] = [];
  list.forEach((it, i) => {
    const name = String(it.name ?? '').trim();
    const price = Number(it.price);
    if (!name || !(price > 0)) return;
    const usual = usualPrice(name, it.unit as string | null | undefined);
    if (!usual || Math.abs(Math.log(price / usual)) <= OFF) return;
    for (const [j, bucket, where] of [[i - 1, up, 'выше'], [i + 1, down, 'ниже']] as const) {
      const nb = list[j];
      if (!nb) continue;
      const nbPrice = Number(nb.price);
      const usualInNbUnit = usualPrice(name, nb.unit as string | null | undefined);
      if (nbPrice > 0 && usualInNbUnit && Math.abs(Math.log(nbPrice / usualInNbUnit)) < FIT) {
        bucket.push(`«${name}» — ${round(price)} ₽, обычно ~${round(usual)} ₽ (такая цена у строки ${where})`);
      }
    }
  });
  const best = up.length >= down.length ? up : down;
  if (best.length < 2) return [];
  const more = best.length > 3 ? ` и ещё ${best.length - 3}` : '';
  return [`цены строк не похожи на обычные для этих товаров, зато совпадают с ценами соседних строк: ${best.slice(0, 3).join('; ')}${more}`];
}
