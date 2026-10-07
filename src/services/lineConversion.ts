import { convertLine, canonUnit, type RawLine } from '../mapping/unitConverter';
import { resolveAndApplyPackTransform } from '../mapping/packTransform';
import { itemNameKey } from '../mapping/nameKey';
import { itemUnitRuleRepo } from '../database/repositories/itemUnitRuleRepo';
import { onecNomenclatureRepo } from '../database/repositories/onecNomenclatureRepo';
import { mappingRepo } from '../database/repositories/mappingRepo';
import type { ItemConversionColumns } from '../database/repositories/invoiceRepo';
import { getReferencePrice } from '../pricing/priceStats';
import { getEngineFlags } from './engineFlags';
import { companyAllKg } from './companyUnits';
import { logger } from '../utils/logger';

/**
 * Единая точка пересчёта строки накладной в единицу 1С (пакет v2, п.1).
 *
 * Все пути конвейера (приём, склейка страниц, перераспознавание, «дофоткать»,
 * диспетчер, /remap, /llm-remap, ручной выбор позиции) зовут эту функцию,
 * а не каждый свою формулу — до v2 их было восемь и они расходились.
 *
 * units_v2 = off → прежний resolveAndApplyPackTransform (поведение до v2), но
 * значения «как в накладной» всё равно сохраняются — к ним можно вернуться.
 *
 * «Всё в кг» (флаг all_kg И настройка компании users.units_all_kg, companyAllKg) →
 * единица строки всегда «кг», а не единица позиции 1С: вес из названия, литры = кг,
 * яйца по категории. Медиана цены позиции сравнивается, только если позиция 1С тоже
 * ведётся в кг. Компания без этой настройки считает в единицах своей 1С.
 */
export interface LineConversionArgs {
  ownerUserId: number | null;
  /** makeSupplierKey(inn, name) — для правил «поставщик + товар». */
  supplierKey: string | null;
  name: string;
  /** Значения «как в накладной» (после OCR-исправлений и НДС-санитайзеров, до пересчёта). */
  raw: RawLine;
  onecGuid: string | null;
  /** Название позиции 1С (для прежнего Mode B, когда размер записан в названии 1С). */
  mappedName?: string | null;
  /** Сохранённая упаковка сопоставления (pack_size/pack_unit) и его id. */
  mapping?: { mapping_id: number | null; pack_size: number | null; pack_unit: string | null } | null;
  /** Подсказка Claude: сколько учётных единиц в одной единице строки. */
  llmPackHint?: number | null;
}

export interface LineConversion {
  quantity: number | null;
  unit: string | null;
  price: number | null;
  total: number | null;
  conversion: ItemConversionColumns;
}

export async function convertInvoiceLine(a: LineConversionArgs): Promise<LineConversion> {
  const flags = await getEngineFlags();
  const raw = a.raw;
  const rawCols = {
    raw_quantity: raw.quantity ?? null,
    raw_unit: raw.unit ?? null,
    raw_price: raw.price ?? null,
    raw_total: raw.total ?? null,
  };
  const onec = a.onecGuid && a.ownerUserId != null
    ? await onecNomenclatureRepo.getByGuid(a.onecGuid, a.ownerUserId).catch(() => undefined)
    : undefined;
  const onecUnit = onec?.unit ?? null;

  if (!flags.units_v2) {
    const hintedSize = a.llmPackHint ?? a.mapping?.pack_size ?? null;
    const hintedUnit = a.llmPackHint ? 'шт' : (a.mapping?.pack_unit ?? null);
    const r = resolveAndApplyPackTransform(
      { quantity: raw.quantity, unit: raw.unit, price: raw.price, total: raw.total },
      a.name, hintedSize, hintedUnit, a.mappedName ?? onec?.name ?? null, onecUnit,
    );
    if (a.mapping?.mapping_id && r.usedFallback && r.packSize && r.packUnit && a.ownerUserId != null) {
      await mappingRepo.update(a.mapping.mapping_id, a.ownerUserId, { pack_size: r.packSize, pack_unit: r.packUnit })
        .catch(err => logger.warn('lineConversion(legacy): pack persist failed', { error: (err as Error).message }));
    }
    const q = r.item.quantity ?? null;
    return {
      quantity: q, unit: r.item.unit ?? null, price: r.item.price ?? null, total: r.item.total ?? null,
      conversion: {
        ...rawCols,
        conv_factor: q != null && raw.quantity ? q / raw.quantity : null,
        conv_note: null, conv_source: 'legacy', qty_flag: null, qty_flag_note: null,
      },
    };
  }

  const nameKey = itemNameKey(a.name);
  const rawUnitCanon = canonUnit(raw.unit)?.unit ?? null;
  const allKg = await companyAllKg(a.ownerUserId);
  const targetUnit = allKg ? 'кг' : onecUnit;
  const rule = a.ownerUserId != null
    ? await itemUnitRuleRepo.find(a.ownerUserId, a.supplierKey, nameKey, rawUnitCanon).catch(() => null)
    : null;
  // История цен позиции — в единице 1С: с другой единицей строки сравнивать нельзя.
  const sameUnitAsOnec = !!onecUnit && canonUnit(onecUnit)?.unit === canonUnit(targetUnit)?.unit;
  const median = flags.price_guard && sameUnitAsOnec ? await getReferencePrice(a.onecGuid, a.ownerUserId, onecUnit) : null;
  const legacyPack = a.mapping?.pack_size && a.mapping.pack_unit ? { size: a.mapping.pack_size, unit: a.mapping.pack_unit } : null;

  const r = convertLine({
    raw, name: a.name, onecUnit: targetUnit, onecName: onec?.name ?? null, forcedTarget: allKg,
    rule: rule ? { factor: rule.factor, targetUnit: rule.target_unit, source: rule.source } : null,
    legacyPack, llmPackHint: a.llmPackHint ?? null, medianPrice: median,
  });
  if (rule && r.source === 'rule') void itemUnitRuleRepo.touch(rule.id).catch(() => {});

  // Флаг «цена выбивается» — только при включённой проверке цены.
  const flag = r.flag === 'price_outlier' && !flags.price_guard ? null : r.flag;
  return {
    quantity: r.quantity, unit: r.unit, price: r.price, total: r.total,
    conversion: {
      ...rawCols,
      conv_factor: r.factor,
      conv_note: r.note ? r.note.slice(0, 255) : null,
      conv_source: r.source,
      qty_flag: flag,
      qty_flag_note: flag && r.flagNote ? r.flagNote.slice(0, 255) : null,
    },
  };
}
