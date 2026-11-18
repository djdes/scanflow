import { createHash } from 'node:crypto';
import { getDb } from '../database/db';
import type { Invoice, InvoiceItem } from '../database/repositories/invoiceRepo';
import { serializeEditValue } from '../database/repositories/editLogRepo';
import { itemUnitRuleRepo } from '../database/repositories/itemUnitRuleRepo';
import { makeSupplierKey } from '../database/repositories/supplierMappingRepo';
import { itemNameKey } from '../mapping/nameKey';
import { canonUnit } from '../mapping/unitConverter';
import { companyAllKg } from './companyUnits';

export class QuantityConfirmationError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Token for the exact row the person saw; never confirm a newer background result. */
export function quantityReviewToken(item: InvoiceItem): string {
  return createHash('sha256').update(JSON.stringify([
    item.id, item.invoice_id, item.original_name, item.onec_guid, item.mapped_name,
    item.quantity, item.unit, item.price, item.total,
    item.raw_quantity ?? null, item.raw_unit ?? null, item.raw_price ?? null, item.raw_total ?? null,
    item.conv_source ?? null, item.conv_factor ?? null, item.qty_flag ?? null, Number(item.qty_confirmed ?? 0),
  ])).digest('hex');
}

export function canRememberItemWeight(item: InvoiceItem, targetUnit: string | null): boolean {
  return Number(item.raw_quantity) > 0 && canonUnit(item.raw_unit)?.cls === 'count'
    && canonUnit(targetUnit)?.unit === 'кг';
}

export async function confirmItemQuantity(invoiceId: number, itemId: number, owner: number, body: Record<string, unknown>) {
  const rememberWeight = body.remember_weight === true;
  if (![invoiceId, itemId, owner].every(id => Number.isSafeInteger(id) && id > 0)
      || typeof body.confirmed !== 'boolean' || typeof body.expected !== 'string' || !/^[a-f0-9]{64}$/.test(body.expected)
      || (body.remember_weight !== undefined && typeof body.remember_weight !== 'boolean') || (rememberWeight && !body.confirmed)) {
    throw new QuantityConfirmationError(400, 'Нужны состояние подтверждения и актуальная версия строки');
  }
  const allKg = rememberWeight && await companyAllKg(owner);
  const result = await getDb().transaction(async db => {
    const inv = await db.prepare('SELECT * FROM invoices WHERE id = ? AND owner_user_id = ? FOR UPDATE').get<Invoice>(invoiceId, owner);
    if (!inv) throw new QuantityConfirmationError(404, 'Строка не найдена');
    const item = await db.prepare('SELECT * FROM invoice_items WHERE id = ? AND invoice_id = ? FOR UPDATE').get<InvoiceItem>(itemId, invoiceId);
    if (!item) throw new QuantityConfirmationError(404, 'Строка не найдена');
    const payment = await db.prepare("SELECT status FROM sber_payments WHERE invoice_id = ? AND status <> 'failed' FOR UPDATE").get(invoiceId);
    if (inv.status !== 'processed' || inv.approved_for_1c || inv.paid_externally || inv.duplicate_of || payment) {
      throw new QuantityConfirmationError(409, 'Правки закрыты: документ уже в очереди, в 1С или для него создан платёж');
    }
    if (quantityReviewToken(item) !== body.expected) throw new QuantityConfirmationError(409, 'Строка изменилась. Откройте проверку заново');
    let quantity = item.quantity;
    let unit = item.unit;
    if (body.confirmed) {
      if (typeof body.quantity !== 'number' || !Number.isFinite(body.quantity) || body.quantity <= 0 || body.quantity > 1e12
          || typeof body.unit !== 'string' || !body.unit.trim() || body.unit.trim().length > 32 || /[\u0000-\u001f]/.test(body.unit)) {
        throw new QuantityConfirmationError(400, 'Укажите положительное количество и единицу измерения');
      }
      quantity = body.quantity;
      unit = body.unit.trim();
    }
    if (rememberWeight) {
      const catalog = !allKg && item.onec_guid
        ? await db.prepare('SELECT unit FROM onec_nomenclature_cards WHERE owner_user_id = ? AND guid = ?')
          .get<{ unit: string | null }>(owner, item.onec_guid)
        : undefined;
      const target = allKg ? 'кг' : catalog?.unit ?? null;
      const supplierKey = makeSupplierKey(inv.supplier_inn, inv.supplier);
      const nameKey = itemNameKey(item.original_name);
      const rawUnit = canonUnit(item.raw_unit)?.unit ?? null;
      const factor = Number(quantity) / Number(item.raw_quantity);
      if (!supplierKey || !nameKey || !canRememberItemWeight(item, target) || canonUnit(unit)?.unit !== 'кг'
          || !Number.isFinite(factor) || factor <= 0 || factor > 100000) {
        throw new QuantityConfirmationError(400, 'Вес можно запомнить при пересчёте количества упаковок в кг для известного поставщика');
      }
      const note = `1 ${rawUnit} = ${factor} кг (проверка количества)`;
      await itemUnitRuleRepo.upsert(owner, { supplierKey, nameKey, rawUnit, targetUnit: 'кг', factor,
        source: 'user', note, createdBy: owner }, db);
      await db.prepare('INSERT INTO edit_log (owner_user_id,user_id,invoice_id,item_id,entity,field,old_value,new_value,context) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(owner, owner, invoiceId, itemId, 'rule', 'unit_rule', null,
          serializeEditValue({ factor, target_unit: 'кг', raw_unit: rawUnit, supplier_key: supplierKey }),
          JSON.stringify({ source: 'quantity_review', original_name: item.original_name }));
    }
    const changed = quantity !== item.quantity || unit !== item.unit;
    if (!changed && body.confirmed === (Number(item.qty_confirmed) === 1)) return item;
    // Correct the final quantity without changing the invoice's money or raw OCR.
    const price = quantity !== item.quantity && quantity != null && item.total != null
      ? Math.round(item.total / quantity * 10000) / 10000 : item.price;
    if (price != null && !Number.isFinite(price)) throw new QuantityConfirmationError(400, 'Количество слишком мало для суммы строки');
    const factor = changed && item.raw_quantity && quantity != null ? quantity / item.raw_quantity : item.conv_factor ?? null;
    if (factor != null && !Number.isFinite(factor)) throw new QuantityConfirmationError(400, 'Некорректный коэффициент пересчёта');
    const previous = { confirmed: Number(item.qty_confirmed) === 1, quantity: item.quantity, unit: item.unit, price: item.price };
    await db.prepare(`UPDATE invoice_items SET quantity = ?, unit = ?, price = ?,
      qty_confirmed = ?, qty_confirmed_at = ${body.confirmed ? 'NOW()' : 'NULL'}, qty_confirmed_by = ?,
      conv_source = ?, conv_note = ?, conv_factor = ? WHERE id = ? AND invoice_id = ?`)
      .run(quantity, unit, price, body.confirmed ? 1 : 0, body.confirmed ? owner : null,
        changed ? 'manual' : item.conv_source ?? null,
        changed ? `Проверено вручную: ${quantity} ${unit}`.slice(0, 255) : item.conv_note ?? null,
        factor,
        itemId, invoiceId);
    const next = { confirmed: body.confirmed, quantity, unit, price };
    await db.prepare('INSERT INTO edit_log (owner_user_id,user_id,invoice_id,item_id,entity,field,old_value,new_value,context) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(owner, owner, invoiceId, itemId, 'item', 'qty_confirmed', serializeEditValue(previous), serializeEditValue(next),
        JSON.stringify({ source: 'quantity_review', original_name: item.original_name, total: item.total, qty_flag: item.qty_flag ?? null }));
    return (await db.prepare('SELECT * FROM invoice_items WHERE id = ?').get<InvoiceItem>(itemId))!;
  });
  return { ...result, qty_review_token: quantityReviewToken(result) };
}
