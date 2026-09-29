import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { ruleProposalRepo } from '../../database/repositories/ruleProposalRepo';
import { itemUnitRuleRepo } from '../../database/repositories/itemUnitRuleRepo';
import { runLearning, acceptProposal } from '../../learning/learningService';
import { getEngineFlags } from '../../services/engineFlags';
import { logEdit } from '../../database/repositories/editLogRepo';
import { logger } from '../../utils/logger';
import { getDb } from '../../database/db';
import { makeSupplierKey } from '../../database/repositories/supplierMappingRepo';

/**
 * /api/learning — самообучение (пакет v2, п.15). Монтируется за apiKeyAuth.
 *
 *   GET  /proposals?status=pending   — предложения правил текущей компании
 *   POST /proposals/:id/accept       — принять: правило + пересчёт неотправленных
 *   POST /proposals/:id/reject       — отклонить (90 дней не предлагаем снова)
 *   POST /run                        — разобрать сейчас (без ИИ, если не просили)
 *   GET  /rules                      — действующие правила пересчёта «товар + поставщик»
 *   POST /rules/:id/active {active}  — выключить/включить правило
 *
 * Всё в области владельца (правило 19): чужих предложений и правил не видно.
 */
const router = Router();

function ownerOf(req: Request): number {
  const id = req.user?.id;
  if (id == null) throw new Error('learning route reached without an authenticated user');
  return id;
}

function parseId(raw: unknown): number | null {
  const n = typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseJson(text: string | null | undefined): unknown {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

const STATUSES = new Set(['pending', 'accepted', 'rejected']);

/** Ключ поставщика → название из накладных компании (ключ по названию — хеш, обратно не читается). */
async function supplierLabels(ownerUserId: number): Promise<Map<string, string>> {
  const rows = await getDb().prepare(`
    SELECT supplier, supplier_inn, MAX(id) AS last_id FROM invoices
     WHERE owner_user_id = ? AND (supplier IS NOT NULL OR supplier_inn IS NOT NULL)
     GROUP BY supplier, supplier_inn ORDER BY last_id DESC LIMIT 3000
  `).all<{ supplier: string | null; supplier_inn: string | null }>(ownerUserId);
  const out = new Map<string, string>();
  for (const r of rows) {
    const key = makeSupplierKey(r.supplier_inn, r.supplier);
    if (key && !out.has(key)) out.set(key, r.supplier || `ИНН ${r.supplier_inn}`);
  }
  return out;
}

router.get('/proposals', async (req: Request, res: Response) => {
  const status = typeof req.query.status === 'string' && STATUSES.has(req.query.status) ? req.query.status : 'pending';
  const owner = ownerOf(req);
  const rows = await ruleProposalRepo.list(owner, status);
  const flags = await getEngineFlags();
  const labels = rows.some(r => r.supplier_key) ? await supplierLabels(owner) : new Map<string, string>();
  res.json({
    data: rows.map(r => ({
      ...r, payload: parseJson(r.payload), evidence: parseJson(r.evidence),
      supplier_label: r.supplier_key ? (labels.get(r.supplier_key) ?? null) : null,
    })),
    learning_enabled: flags.learning,
  });
});

router.post('/proposals/:id/accept', async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (id == null) return res.status(400).json({ error: 'invalid id' });
  try {
    const r = await acceptProposal(ownerOf(req), id, req.user?.id ?? null);
    return res.json({ data: r });
  } catch (err) {
    return res.status(404).json({ error: (err as Error).message });
  }
});

router.post('/proposals/:id/reject', async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (id == null) return res.status(400).json({ error: 'invalid id' });
  const owner = ownerOf(req);
  const p = await ruleProposalRepo.get(owner, id);
  if (!p || p.status !== 'pending') return res.status(404).json({ error: 'Предложение не найдено или уже решено' });
  await ruleProposalRepo.decide(owner, id, 'rejected', req.user?.id ?? null);
  await logEdit({
    ownerUserId: owner, userId: req.user?.id ?? null, entity: 'rule', field: 'reject_proposal',
    oldValue: null, newValue: { id, title: p.title }, context: { source: p.source },
  });
  return res.json({ data: { id, status: 'rejected' } });
});

// Ручной запуск: не чаще раза в минуту, ИИ — только по явной просьбе.
const runLimiter = rateLimit({ windowMs: 60_000, max: 2, standardHeaders: true, legacyHeaders: false });
router.post('/run', runLimiter, async (req: Request, res: Response) => {
  const useLlm = (req.body as { llm?: unknown } | undefined)?.llm === true;
  const owner = ownerOf(req);
  const r = await runLearning(owner, { useLlm });
  logger.info('learning: manual run', { owner, useLlm, ...r });
  res.json({ data: r });
});

router.get('/rules', async (req: Request, res: Response) => {
  const owner = ownerOf(req);
  const rules = await itemUnitRuleRepo.list(owner);
  const labels = rules.some(r => r.supplier_key) ? await supplierLabels(owner) : new Map<string, string>();
  res.json({ data: rules.map(r => ({ ...r, supplier_label: r.supplier_key ? (labels.get(r.supplier_key) ?? null) : null })) });
});

router.post('/rules/:id/active', async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (id == null) return res.status(400).json({ error: 'invalid id' });
  const active = (req.body as { active?: unknown } | undefined)?.active;
  if (typeof active !== 'boolean') return res.status(400).json({ error: 'active must be boolean' });
  const owner = ownerOf(req);
  const ok = await itemUnitRuleRepo.setActive(owner, id, active);
  if (!ok) return res.status(404).json({ error: 'Правило не найдено' });
  await logEdit({
    ownerUserId: owner, userId: req.user?.id ?? null, entity: 'rule', field: 'unit_rule_active',
    oldValue: !active, newValue: active, context: { rule_id: id },
  });
  return res.json({ data: { id, active } });
});

export default router;
