import { getDb } from '../database/db';
import { editLogRepo, logEdit } from '../database/repositories/editLogRepo';
import { ruleProposalRepo } from '../database/repositories/ruleProposalRepo';
import { itemUnitRuleRepo } from '../database/repositories/itemUnitRuleRepo';
import { invoiceRepo } from '../database/repositories/invoiceRepo';
import { makeSupplierKey } from '../database/repositories/supplierMappingRepo';
import { itemNameKey } from '../mapping/nameKey';
import { canonUnit } from '../mapping/unitConverter';
import { getReferencePrice } from '../pricing/priceStats';
import { reconvertStoredItem } from '../services/itemReconvert';
import { getEngineFlags } from '../services/engineFlags';
import { config } from '../config';
import { logger } from '../utils/logger';
import { mineFromEdits, mineFromPriceOutliers, type QtyEdit, type FlaggedLine, type UnitRuleProposal } from './ruleMiner';
import { adviseWithLlm } from './llmAdvisor';

/**
 * Самообучение (пакет v2, п.15): разбор правок и неуверенных пересчётов →
 * предложения правил. Ничего не применяется без человека.
 */
export interface LearningResult { mined: number; llm: number; created: number }

const running = new Set<number>();

export async function runLearning(ownerUserId: number, opts: { useLlm?: boolean } = {}): Promise<LearningResult> {
  const res: LearningResult = { mined: 0, llm: 0, created: 0 };
  if (running.has(ownerUserId)) return res;
  running.add(ownerUserId);
  try {
    const db = getDb();
    // 1) Ручные правки количества (журнал правок, 90 дней).
    const edits = (await editLogRepo.listForOwnerSince(ownerUserId, 90, 'item')).filter(e => e.field === 'quantity');
    const guids = new Set<string>();
    const parsedEdits: Array<{ ctx: Record<string, any>; newQ: number; e: typeof edits[number] }> = [];
    for (const e of edits) {
      let ctx: Record<string, any> = {};
      try { ctx = e.context ? JSON.parse(e.context) : {}; } catch { continue; }
      const newQ = Number(e.new_value);
      if (!Number.isFinite(newQ)) continue;
      if (ctx.onec_guid) guids.add(String(ctx.onec_guid));
      parsedEdits.push({ ctx, newQ, e });
    }
    const unitByGuid = new Map<string, string>();
    if (guids.size) {
      const rows = await db.prepare(
        `SELECT guid, unit FROM onec_nomenclature_cards WHERE owner_user_id = ? AND guid IN (${[...guids].map(() => '?').join(',')})`,
      ).all<{ guid: string; unit: string | null }>(ownerUserId, ...guids);
      for (const r of rows) if (r.unit) unitByGuid.set(r.guid, r.unit);
    }
    const qtyEdits: QtyEdit[] = [];
    for (const { ctx, newQ, e } of parsedEdits) {
      const raw = ctx.raw ?? ctx.before ?? {};
      const onecUnit = ctx.onec_guid ? unitByGuid.get(String(ctx.onec_guid)) : undefined;
      if (!onecUnit || raw.quantity == null || !raw.unit || !ctx.original_name) continue;
      qtyEdits.push({
        name: String(ctx.original_name), supplier_key: makeSupplierKey(ctx.supplier_inn ?? null, ctx.supplier ?? null) ?? '',
        raw_quantity: Number(raw.quantity), raw_unit: String(raw.unit), new_quantity: newQ, onec_unit: onecUnit,
        invoice_id: Number(e.invoice_id), item_id: Number(e.item_id),
      });
    }

    // 2) Строки с флагом пересчёта (60 дней).
    const flagged = await db.prepare(`
      SELECT ii.id, ii.invoice_id, ii.original_name AS name, ii.raw_quantity, ii.raw_unit, ii.raw_total,
             ii.qty_flag AS flag, ii.onec_guid, i.supplier_inn, i.supplier, onc.name AS onec_name, onc.unit AS onec_unit
        FROM invoice_items ii
        JOIN invoices i ON i.id = ii.invoice_id
        LEFT JOIN onec_nomenclature_cards onc ON onc.guid = ii.onec_guid AND onc.owner_user_id = i.owner_user_id
       WHERE i.owner_user_id = ? AND ii.qty_flag IS NOT NULL AND i.created_at >= (NOW() - INTERVAL 60 DAY)
       ORDER BY ii.id DESC LIMIT 400
    `).all<Record<string, any>>(ownerUserId);
    const medianCache = new Map<string, number | null>();
    const lines: FlaggedLine[] = [];
    for (const r of flagged) {
      const key = `${r.onec_guid}|${r.onec_unit}`;
      if (!medianCache.has(key)) medianCache.set(key, await getReferencePrice(r.onec_guid, ownerUserId, r.onec_unit));
      lines.push({
        id: Number(r.id), invoice_id: Number(r.invoice_id), name: String(r.name),
        supplier_key: makeSupplierKey(r.supplier_inn ?? null, r.supplier ?? null) ?? '',
        raw_quantity: Number(r.raw_quantity), raw_unit: String(r.raw_unit ?? 'шт'), raw_total: Number(r.raw_total),
        onec_unit: r.onec_unit ?? null, onec_name: r.onec_name ?? null, flag: String(r.flag), median: medianCache.get(key) ?? null,
      });
    }

    // 3) Детерминированный разбор.
    const proposals: UnitRuleProposal[] = [...mineFromEdits(qtyEdits), ...mineFromPriceOutliers(lines)];
    res.mined = proposals.length;

    // 4) Claude — для неразобранных строк с позицией 1С (не «нужен вес» — там решает фактический вес).
    if (opts.useLlm) {
      const covered = new Set(proposals.map(p => `${p.supplier_key}|${p.name_key}`));
      const todo = lines.filter(l => l.onec_unit && l.flag !== 'needs_weight' && !covered.has(`${l.supplier_key}|${itemNameKey(l.name)}`));
      if (todo.length) {
        const cfg = await invoiceRepo.getAnalyzerConfig();
        const apiKey = cfg.anthropic_api_key || config.anthropicApiKey;
        if (apiKey) {
          const advice = await adviseWithLlm(todo, apiKey, cfg.claude_model || 'claude-sonnet-5');
          for (const a of advice.filter(x => x.confidence >= 0.7)) {
            const l = todo.find(x => x.id === a.id);
            if (!l || !l.onec_unit) continue;
            const from = canonUnit(l.raw_unit)?.unit ?? l.raw_unit;
            const to = canonUnit(l.onec_unit)?.unit ?? l.onec_unit;
            proposals.push({
              kind: 'unit_rule', supplier_key: l.supplier_key, name_key: itemNameKey(l.name),
              title: `«${l.name}»: 1 ${from} = ${String(a.factor).replace('.', ',')} ${to} (предложение ИИ)`,
              payload: { raw_unit: from, target_unit: to, factor: a.factor, name: l.name },
              evidence: { count: 1, examples: [{ invoice_id: l.invoice_id, item_id: l.id, raw: `${l.raw_quantity} ${from} на ${l.raw_total} ₽` }], why: a.reason },
              source: 'llm',
            });
            res.llm++;
          }
        }
      }
    }

    // 5) Сохранить новые (без дублей и без уже действующих правил).
    for (const p of proposals) {
      const existing = await itemUnitRuleRepo.find(ownerUserId, p.supplier_key || null, p.name_key, p.payload.raw_unit);
      if (existing && Math.abs(existing.factor - p.payload.factor) <= 0.01 * p.payload.factor) continue;
      if (await ruleProposalRepo.createIfNew(ownerUserId, p)) res.created++;
    }
    if (res.created) logger.info('learning: proposals created', { ownerUserId, ...res });
  } catch (err) {
    logger.warn('learning: run failed', { ownerUserId, error: (err as Error).message });
  } finally {
    running.delete(ownerUserId);
  }
  return res;
}

/** Принять предложение: создать правило и пересчитать этот товар в неотправленных накладных. */
export async function acceptProposal(ownerUserId: number, id: number, userId: number | null): Promise<{ applied_lines: number }> {
  const p = await ruleProposalRepo.get(ownerUserId, id);
  if (!p || p.status !== 'pending') throw new Error('Предложение не найдено или уже решено');
  const payload = JSON.parse(p.payload) as { raw_unit: string; target_unit: string; factor: number };
  if (p.kind !== 'unit_rule') throw new Error('Неизвестный вид предложения');
  await itemUnitRuleRepo.upsert(ownerUserId, {
    supplierKey: p.supplier_key || null, nameKey: p.name_key, rawUnit: payload.raw_unit, targetUnit: payload.target_unit,
    factor: payload.factor, source: p.source === 'llm' ? 'llm' : 'miner', note: p.title.slice(0, 255), createdBy: userId,
  });
  await ruleProposalRepo.decide(ownerUserId, id, 'accepted', userId);

  let applied = 0;
  const invoices = await getDb().prepare(`
    SELECT id FROM invoices WHERE owner_user_id = ? AND status = 'processed' AND approved_for_1c = 0 AND sent_at IS NULL
       AND created_at >= (NOW() - INTERVAL 90 DAY)
  `).all<{ id: number }>(ownerUserId);
  for (const { id: invId } of invoices) {
    const inv = await invoiceRepo.getById(invId);
    if (!inv) continue;
    if (p.supplier_key && makeSupplierKey(inv.supplier_inn, inv.supplier) !== p.supplier_key) continue;
    const items = await invoiceRepo.getItems(invId);
    let touched = 0;
    for (const it of items) {
      // Ручную правку количества не трогаем — человек уже решил за эту строку.
      if (it.conv_source === 'manual' || itemNameKey(it.original_name) !== p.name_key) continue;
      if (await reconvertStoredItem(it, inv, { force: true })) touched++;
    }
    if (touched) { await invoiceRepo.recalculateTotal(invId); applied += touched; }
  }
  await logEdit({
    ownerUserId, userId, entity: 'rule', field: 'accept_proposal', oldValue: null,
    newValue: { id, title: p.title, factor: payload.factor }, context: { applied_lines: applied, source: p.source },
  });
  return { applied_lines: applied };
}

/** Ночной запуск для всех активных компаний (флаг learning). Последовательно. */
export async function runNightlyLearning(): Promise<void> {
  if (!(await getEngineFlags()).learning) return;
  const owners = await getDb().prepare(`
    SELECT DISTINCT owner_user_id FROM invoices
     WHERE owner_user_id IS NOT NULL AND created_at >= (NOW() - INTERVAL 60 DAY)
  `).all<{ owner_user_id: number }>();
  for (const { owner_user_id } of owners) {
    await runLearning(owner_user_id, { useLlm: true });
  }
}
