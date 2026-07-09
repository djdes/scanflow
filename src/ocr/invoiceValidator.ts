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
  | 'date_range';

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

  // 6. date_range — invoice_date в [сегодня−2 года; сегодня+7 дней].
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
