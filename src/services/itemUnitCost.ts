import { getDb, type DbAdapter } from '../database/db';
import { itemCostRepo, type CostInvoice, type CostRule } from '../database/repositories/itemCostRepo';
import { makeSupplierKey } from '../database/repositories/supplierMappingRepo';
import { serializeEditValue } from '../database/repositories/editLogRepo';
import { calculateUnitCost, costBasis, costNameKey, costRawUnit, costReviewToken, validCostFormula,
  type CostFormula, type CostLine } from '../pricing/unitCost';

export class UnitCostError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
type InvoiceContext = Pick<CostInvoice, 'id' | 'supplier' | 'supplier_inn'>;
const supplierKey = (invoice: InvoiceContext) => makeSupplierKey(invoice.supplier_inn, invoice.supplier) ?? `invoice:${invoice.id}`;
const ruleKey = (supplier: string, name: string, unit: string) => `${supplier}\n${name}\n${unit}`;
const formulaOf = (rule?: CostRule | null): CostFormula | null => rule?.active
  ? { units_per_pack: Number(rule.units_per_pack), unit_kind: rule.unit_kind } : null;
function view(invoice: InvoiceContext, line: CostLine, rule?: CostRule | null, decision?: string) {
  const formula = formulaOf(rule);
  const expected = costReviewToken(line, supplierKey(invoice), formula);
  return {
    original_name: line.original_name,
    calculation: calculateUnitCost(line, formula), basis: costBasis(line), expected,
    rule_id: formula ? rule!.id : null, dismissed: decision === expected,
    can_remember: !!makeSupplierKey(invoice.supplier_inn, invoice.supplier) && !!line.original_name.trim(),
  };
}
export async function itemCostViews(owner: number, invoice: InvoiceContext, items: CostLine[]) {
  if (!items.length) return [];
  const [rules, decisions] = await Promise.all([itemCostRepo.rules(owner), itemCostRepo.decisions(owner, items.map(item => item.id))]);
  const index = new Map(rules.map(rule => [ruleKey(rule.supplier_key, rule.name_key, rule.raw_unit), rule]));
  return items.map(item => view(invoice, item, index.get(ruleKey(supplierKey(invoice), costNameKey(item.original_name), costRawUnit(item))), decisions.get(item.id)));
}
async function context(db: DbAdapter, owner: number, invoiceId: number, itemId: number, lock = false) {
  const inv = await db.prepare(`SELECT * FROM invoices WHERE id = ? AND owner_user_id = ?${lock ? ' FOR UPDATE' : ''}`).get<CostInvoice>(invoiceId, owner);
  if (!inv) throw new UnitCostError(404, 'Строка не найдена');
  const item = await db.prepare(`SELECT * FROM invoice_items WHERE id = ? AND invoice_id = ?${lock ? ' FOR UPDATE' : ''}`).get<CostLine>(itemId, invoiceId);
  if (!item) throw new UnitCostError(404, 'Строка не найдена');
  const sk = supplierKey(inv), nk = costNameKey(item.original_name), ru = costRawUnit(item);
  const rule = await itemCostRepo.rule(owner, sk, nk, ru, db, lock);
  return { inv, item, rule, sk, nk, ru };
}
export async function previewItemCost(owner: number, invoiceId: number, itemId: number, body: Record<string, unknown>) {
  const ctx = await context(getDb(), owner, invoiceId, itemId);
  const current = view(ctx.inv, ctx.item, ctx.rule);
  if (!validCostFormula(body)) throw new UnitCostError(400, 'Укажите целое число единиц в упаковке от 1 до 1 000 000 000 и единицу расчёта');
  const calculation = calculateUnitCost(ctx.item, body, 'manual');
  if (!calculation) throw new UnitCostError(422, 'Нужны количество упаковок и сумма строки. Проверьте исходные данные накладной');
  return { ...current, calculation };
}
export async function decideItemCost(owner: number, invoiceId: number, itemId: number, action: 'remember' | 'dismiss' | 'forget', body: Record<string, unknown>) {
  if (typeof body.expected !== 'string' || !/^[a-f0-9]{64}$/.test(body.expected)) throw new UnitCostError(400, 'Откройте актуальный расчёт строки');
  return getDb().transaction(async db => {
    const { inv, item, rule, sk, nk, ru } = await context(db, owner, invoiceId, itemId, true);
    const current = view(inv, item, rule);
    if (current.expected !== body.expected) throw new UnitCostError(409, 'Строка или формула изменилась. Откройте расчёт заново');
    if (action === 'remember') {
      if (!validCostFormula(body)) throw new UnitCostError(400, 'Укажите целое положительное число единиц в упаковке и единицу расчёта');
      if (!current.can_remember) throw new UnitCostError(422, 'Сначала укажите поставщика и название товара в накладной');
      const calculation = calculateUnitCost(item, body, 'manual');
      if (!calculation) throw new UnitCostError(422, 'Невозможно рассчитать цену: проверьте количество упаковок и сумму строки');
      await db.prepare(`INSERT INTO item_cost_rules (owner_user_id, supplier_key, name_key, raw_unit, scanned_name, units_per_pack, unit_kind, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE scanned_name = VALUES(scanned_name), units_per_pack = VALUES(units_per_pack),
          unit_kind = VALUES(unit_kind), active = 1, updated_at = NOW()`)
        .run(owner, sk, nk, ru, item.original_name, body.units_per_pack, body.unit_kind, owner);
      const updatedRule = (await itemCostRepo.rule(owner, sk, nk, ru, db))!;
      await decision(db, owner, item.id, costReviewToken(item, sk, formulaOf(updatedRule)), 'remembered');
      await audit(db, owner, inv.id, item.id, item.original_name, formulaOf(rule), formulaOf(updatedRule));
      return view(inv, item, updatedRule);
    }
    if (action === 'forget') {
      if (!rule?.active) throw new UnitCostError(404, 'Сохранённая формула не найдена');
      await db.prepare('UPDATE item_cost_rules SET active = 0, updated_at = NOW() WHERE id = ? AND owner_user_id = ?').run(rule.id, owner);
      await db.prepare('DELETE FROM item_cost_decisions WHERE owner_user_id = ? AND item_id = ?').run(owner, item.id);
      await audit(db, owner, inv.id, item.id, item.original_name, formulaOf(rule), null);
      return view(inv, item);
    }
    if (!current.calculation) throw new UnitCostError(422, 'Для этой строки пока нет расчёта');
    await decision(db, owner, item.id, current.expected, 'dismissed');
    return { ...current, dismissed: true };
  });
}
async function decision(db: DbAdapter, owner: number, item: number, fingerprint: string, action: string) {
  await db.prepare(`INSERT INTO item_cost_decisions (owner_user_id, item_id, fingerprint, action) VALUES (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE fingerprint = VALUES(fingerprint), action = VALUES(action), created_at = NOW()`).run(owner, item, fingerprint, action);
}
async function audit(db: DbAdapter, owner: number, invoice: number, item: number, name: string, before: CostFormula | null, after: CostFormula | null) {
  await db.prepare(`INSERT INTO edit_log (owner_user_id, user_id, invoice_id, item_id, entity, field, old_value, new_value, context)
    VALUES (?, ?, ?, ?, 'rule', 'unit_cost_formula', ?, ?, ?)`)
    .run(owner, owner, invoice, item, serializeEditValue(before), serializeEditValue(after), JSON.stringify({ original_name: name, unit_cost: true }));
}
export async function costSuggestions(owner: number, cursor = Number.MAX_SAFE_INTEGER) {
  const rules = await itemCostRepo.rules(owner);
  const index = new Map(rules.map(rule => [ruleKey(rule.supplier_key, rule.name_key, rule.raw_unit), rule]));
  const data = [];
  let next = cursor;
  while (true) {
    const rows = await itemCostRepo.candidates(owner, next);
    if (!rows.length) return { data, next_cursor: null };
    const decisions = await itemCostRepo.decisions(owner, rows.map(row => row.id));
    for (const item of rows) {
      next = item.id;
      const invoice = { id: item.invoice_id, supplier: item.supplier, supplier_inn: item.supplier_inn };
      const result = view(invoice, item, index.get(ruleKey(supplierKey(invoice), costNameKey(item.original_name), costRawUnit(item))), decisions.get(item.id));
      if (!result.calculation || result.dismissed) continue;
      data.push({ invoice_id: item.invoice_id, item_id: item.id, invoice_number: item.invoice_number,
        supplier: item.supplier, ...result });
      if (data.length === 20) return { data, next_cursor: next };
    }
    if (rows.length < 200) return { data, next_cursor: null };
  }
}
