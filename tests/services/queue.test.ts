import { describe, it, expect } from 'vitest';
import {
  isInQueue,
  isWorkable,
  sameUnit,
  isLegacyLine,
  priceDeviationPct,
  lineRisks,
  summarizeLines,
  queueReasons,
  queueState,
  plural,
  invoiceFiles,
  LINE_RISK_CODES,
  type RiskLine,
  type LineRiskCode,
} from '../../src/services/queue';
import { newItemGroupKey } from '../../src/services/newItems';

// «Очередь в 1С»: чистые правила — без БД.

function line(p: Partial<RiskLine> = {}): RiskLine {
  return {
    original_name: 'Батон нарезной 0,4кг',
    onec_guid: 'g-1',
    mapping_confidence: 1,
    name_overridden: 0,
    unit: 'шт',
    price: 40,
    qty_flag: null,
    qty_flag_note: null,
    conv_source: 'legacy_stored',
    onec_unit: 'шт',
    median_price: null,
    median_price_unit: null,
    median_samples: null,
    ...p,
  };
}

const codes = (l: RiskLine, keys?: Set<string>) => lineRisks(l, keys).map(r => r.code);

describe('isInQueue / isWorkable', () => {
  const base = { status: 'processed', approved_for_1c: 0, sent_at: null, duplicate_of: null };
  it('обработана, не отправлена, не дубликат → в очереди; не одобрена → строки можно менять', () => {
    expect(isInQueue(base)).toBe(true);
    expect(isWorkable(base)).toBe(true);
  });
  it('одобрена для 1С, но 1С её ещё не забрала — в очереди, но строки не меняем', () => {
    expect(isInQueue({ ...base, approved_for_1c: 1 })).toBe(true);
    expect(isWorkable({ ...base, approved_for_1c: 1 })).toBe(false);
  });
  it('отправлена, дубликат, не обработана → не в очереди', () => {
    for (const inv of [
      { ...base, sent_at: '2026-09-20 10:00:00' },
      { ...base, duplicate_of: 5 },
      { ...base, status: 'sent_to_1c' },
      { ...base, status: 'error' },
    ]) {
      expect(isInQueue(inv)).toBe(false);
      expect(isWorkable(inv)).toBe(false);
    }
  });
});

describe('sameUnit', () => {
  it('разные написания одной единицы совпадают', () => {
    expect(sameUnit('шт.', 'шт')).toBe(true);
    expect(sameUnit('уп', 'упак')).toBe(true);
    expect(sameUnit('гр', 'г')).toBe(true);
    expect(sameUnit('КГ', 'кг')).toBe(true);
  });
  it('разные единицы — нет; неизвестные сравниваются по написанию', () => {
    expect(sameUnit('кг', 'шт')).toBe(false);
    expect(sameUnit('упак', 'шт')).toBe(false);
    expect(sameUnit('м.', 'м')).toBe(true);
    expect(sameUnit('м', 'пог.м')).toBe(false);
  });
});

describe('lineRisks — строка с замечанием', () => {
  it('чистая сопоставленная строка — без замечаний', () => {
    expect(codes(line())).toEqual([]);
  });

  it('флаг пересчёта v2 — замечание с кодом флага; единицу и цену отдельно не дублируем', () => {
    const r = lineRisks(line({ qty_flag: 'needs_weight', qty_flag_note: 'укажите вес', onec_unit: 'кг', median_price: 10, median_price_unit: 'шт', median_samples: 5 }));
    expect(r).toEqual([{ code: 'qty_flag', flag: 'needs_weight', note: 'укажите вес' }]);
  });

  it('единица строки не совпадает с единицей позиции 1С (главный признак строк до v2)', () => {
    const r = lineRisks(line({ unit: 'шт', onec_unit: 'кг' }));
    expect(r).toEqual([{ code: 'unit_mismatch', onec_unit: 'кг' }]);
    expect(codes(line({ unit: 'уп', onec_unit: 'упак' }))).toEqual([]);
  });

  it('«Всё в кг»: строка в кг на штучной позиции — 1С переведёт позицию на кг, а не «единица не как в 1С»', () => {
    expect(lineRisks(line({ unit: 'кг', onec_unit: 'шт' }), new Set(), { allKg: true })).toEqual([{ code: 'unit_to_kg', onec_unit: 'шт' }]);
    // строка не в кг (нет веса) — по-прежнему расхождение; без флага — как раньше
    expect(codes(line({ unit: 'шт', onec_unit: 'л' }))).toEqual(['unit_mismatch']);
    expect(lineRisks(line({ unit: 'упак', onec_unit: 'шт' }), new Set(), { allKg: true })).toEqual([{ code: 'unit_mismatch', onec_unit: 'шт' }]);
    expect(lineRisks(line({ unit: 'кг', onec_unit: 'шт' }))).toEqual([{ code: 'unit_mismatch', onec_unit: 'шт' }]);
  });

  it('цена в 3 раза и больше отличается от обычной (≥3 поставок, та же единица)', () => {
    expect(codes(line({ price: 120, median_price: 40, median_price_unit: 'шт', median_samples: 3 }))).toEqual(['price_outlier']);
    expect(codes(line({ price: 13, median_price: 40, median_price_unit: 'шт', median_samples: 3 }))).toEqual(['price_outlier']);
    // в 2,9 раза — ещё не выброс
    expect(codes(line({ price: 116, median_price: 40, median_price_unit: 'шт', median_samples: 3 }))).toEqual([]);
    // мало поставок / другая единица — судить не по чему
    expect(codes(line({ price: 400, median_price: 40, median_price_unit: 'шт', median_samples: 2 }))).toEqual([]);
    expect(codes(line({ price: 400, median_price: 40, median_price_unit: 'кг', median_samples: 9, onec_unit: 'шт' }))).toEqual([]);
  });

  it('низкая уверенность подбора позиции', () => {
    expect(lineRisks(line({ mapping_confidence: 0.61 }))).toEqual([{ code: 'low_confidence', confidence: 0.61 }]);
    expect(codes(line({ mapping_confidence: 0.8 }))).toEqual([]);
  });

  it('позиции 1С нет → новый товар; своё название или заявка «Создать в 1С» — уже решено', () => {
    const unmapped = line({ onec_guid: null, onec_unit: null, mapping_confidence: 0 });
    expect(codes(unmapped)).toEqual(['new_item']);
    expect(codes({ ...unmapped, name_overridden: 1 })).toEqual([]);
    const keys = new Set([newItemGroupKey('Батон нарезной 0,4кг')]);
    expect(codes(unmapped, keys)).toEqual([]);
  });
});

describe('priceDeviationPct — как в карточке накладной', () => {
  it('+50% при обычной 40 и цене 60', () => {
    expect(priceDeviationPct(line({ price: 60, median_price: 40, median_price_unit: 'шт', median_samples: 4 }))).toBeCloseTo(50);
  });
  it('нет статистики → null', () => {
    expect(priceDeviationPct(line())).toBeNull();
  });
});

describe('summarizeLines', () => {
  it('строки без позиции 1С (все и «ничьи»), с флагом пересчёта, с замечаниями, до v2', () => {
    const s = summarizeLines([
      line(),
      line({ unit: 'шт', onec_unit: 'кг', mapping_confidence: 0.5 }),
      line({ onec_guid: null, onec_unit: null, conv_source: 'name' }),
      line({ onec_guid: null, onec_unit: null, name_overridden: 1, conv_source: 'same' }),
      line({ qty_flag: 'needs_weight', conv_source: 'rule' }),
    ]);
    expect(s).toEqual({
      lines: 5,
      unmapped: 2,
      unmapped_open: 1,
      flagged: 1,
      risky_lines: 3,
      legacy_lines: 2,
      risk_counts: { qty_flag: 1, unit_mismatch: 1, unit_to_kg: 0, price_outlier: 0, low_confidence: 1, new_item: 1 },
    });
  });
});

describe('queueReasons — что держит накладную', () => {
  const zero = () => Object.fromEntries(LINE_RISK_CODES.map(c => [c, 0])) as Record<LineRiskCode, number>;

  it('чистая накладная — причин нет, «готова»', () => {
    const r = queueReasons({ gate: [], supplier_inn: '7724357632', risk_counts: zero() });
    expect(r).toEqual([]);
    expect(queueState({ approved_for_1c: 0 }, r)).toBe('ready');
  });

  it('причины гейта автопилота — как есть; лимит суммы автоотправки к ручной отправке не относится', () => {
    const r = queueReasons({
      gate: [
        { code: 'unmapped', message: 'Не сопоставлено с 1С: 2' },
        { code: 'amount_limit', message: 'Сумма выше лимита автопилота 50000.00 ₽' },
        { code: 'rows_misaligned', message: 'Строки, похоже, сдвинуты' },
      ],
      supplier_inn: '7724357632',
      risk_counts: zero(),
    });
    expect(r.map(x => x.code)).toEqual(['unmapped', 'rows_misaligned']);
    expect(r.every(x => !x.hard)).toBe(true);
    expect(queueState({ approved_for_1c: 0 }, r)).toBe('blocked');
  });

  it('без реквизитов, строк или с согласованием по сумме — «жёсткие»: массово не одобряются', () => {
    const r = queueReasons({
      gate: [
        { code: 'invoice_number', message: 'Не распознан номер накладной' },
        { code: 'items', message: 'В документе нет товарных позиций' },
        { code: 'approval_required', message: 'Сумма требует согласования от 100000.00 ₽' },
      ],
      supplier_inn: '  ',
      risk_counts: zero(),
    });
    expect(r.map(x => [x.code, x.hard])).toEqual([
      ['invoice_number', true], ['items', true], ['approval_required', true], ['supplier_inn', true],
    ]);
  });

  it('ошибка 1С при прошлой загрузке, единица не как в 1С, цена в разы — замечания', () => {
    const counts = { ...zero(), unit_mismatch: 2, unit_to_kg: 1, price_outlier: 1, new_item: 5, low_confidence: 3 };
    const r = queueReasons({
      gate: [], supplier_inn: '7724357632', onec_status: 'rejected', onec_error: 'Не найдена\nединица  «кор»', risk_counts: counts,
    });
    expect(r).toEqual([
      { code: 'onec_error', message: '1С вернула ошибку при загрузке: Не найдена единица «кор»', hard: false },
      { code: 'unit_mismatch', message: 'Единица не совпадает с единицей позиции 1С: 2 строки — проверьте количество', hard: false },
      { code: 'unit_to_kg', message: '1С переведёт позицию на кг: 1 строка — остаток в прежней единице проверьте инвентаризацией', hard: false },
      { code: 'price_outlier', message: 'Цена за единицу в 3 раза и больше отличается от обычной: 1 строка', hard: false },
    ]);
    // new_item и low_confidence — у гейта (unmapped, low_confidence), второй раз не дублируем
    expect(queueReasons({ gate: [], supplier_inn: '1', onec_status: 'queued', risk_counts: { ...zero(), new_item: 3, low_confidence: 1 } })).toEqual([]);
  });

  it('одобренная — «ждёт 1С», даже если есть замечания', () => {
    expect(queueState({ approved_for_1c: 1 }, [{ code: 'unmapped', message: 'x', hard: false }])).toBe('approved');
    expect(queueState({ approved_for_1c: 1 }, [])).toBe('approved');
  });
});

describe('мелочи', () => {
  it('isLegacyLine: legacy_stored и пустой источник — строки до v2', () => {
    expect(isLegacyLine({ conv_source: 'legacy_stored' })).toBe(true);
    expect(isLegacyLine({ conv_source: null })).toBe(true);
    expect(isLegacyLine({ conv_source: 'same' })).toBe(false);
  });
  it('invoiceFiles: список через запятую', () => {
    expect(invoiceFiles(' a.jpg, b.jpg ,')).toEqual(['a.jpg', 'b.jpg']);
    expect(invoiceFiles(null)).toEqual([]);
  });
  it('plural: 1 строка, 2 строки, 5 строк, 11 строк, 21 строка', () => {
    const f = (n: number) => plural(n, 'строка', 'строки', 'строк');
    expect([1, 2, 5, 11, 12, 21, 22, 25, 111].map(f)).toEqual(['строка', 'строки', 'строк', 'строк', 'строк', 'строка', 'строки', 'строк', 'строк']);
  });
});
