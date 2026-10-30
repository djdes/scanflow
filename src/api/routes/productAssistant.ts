import { Router, Request } from 'express';
import rateLimit from 'express-rate-limit';
import { productAssistantRepo } from '../../database/repositories/productAssistantRepo';
import { invoiceRepo } from '../../database/repositories/invoiceRepo';
import { onecNomenclatureRepo } from '../../database/repositories/onecNomenclatureRepo';
import { rejectionRepo } from '../../database/repositories/rejectionRepo';
import { itemNameKey } from '../../mapping/nameKey';
import { assistantPublicConfig, assistantReadiness, assistantRequest, AssistantData, object, ProductAssistantError, saveAssistantConfig } from '../../integration/productAssistant';

const router = Router();
const owner = (req: Request): number => req.user!.id;
const actor = (req: Request): string => `scanflow-user-${owner(req)}`;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const opaqueId = /^[a-f0-9]{32}$/i;
function id(value: unknown): number {
  if (!['string', 'number'].includes(typeof value) || !/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new ProductAssistantError(400, 'Некорректный номер накладной или строки');
  return Number(value);
}
function text(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ProductAssistantError(400, `${label}: от 1 до ${max} символов`);
  return value.trim();
}
function key(req: Request): string {
  const value = req.get('Idempotency-Key');
  if (!value || !/^[A-Za-z0-9._:-]{1,160}$/.test(value)) throw new ProductAssistantError(400, 'Нужен Idempotency-Key (до 160 символов)');
  return value;
}
async function line(req: Request, source: AssistantData) {
  const invoice = await invoiceRepo.getById(id(source.invoice_id));
  if (!invoice || invoice.owner_user_id !== owner(req)) throw new ProductAssistantError(404, 'Накладная не найдена');
  const item = await invoiceRepo.getItemById(id(source.item_id));
  if (!item || item.invoice_id !== invoice.id) throw new ProductAssistantError(404, 'Строка не найдена');
  return { invoice, item };
}
async function allowedProduct(guid: string, req: Request, blocked: Set<string>) {
  if (!uuid.test(guid) || blocked.has(guid.toLowerCase())) return null;
  const row = await onecNomenclatureRepo.getByGuid(guid, owner(req));
  return row && !row.is_folder ? row : null;
}
async function blockedFor(req: Request, name: string) {
  return new Set([...(await rejectionRepo.guidsFor(owner(req), itemNameKey(name)))].map(g => g.toLowerCase()));
}

router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
router.get('/config', async (req, res) => res.json({ data: assistantPublicConfig(await productAssistantRepo.get(owner(req))) }));
router.put('/config', async (req, res) => {
  if (!object(req.body)) throw new ProductAssistantError(400, 'Некорректные настройки');
  await saveAssistantConfig(owner(req), req.body);
  res.json({ data: assistantPublicConfig(await productAssistantRepo.get(owner(req))) });
});
router.delete('/config', async (req, res) => { await productAssistantRepo.remove(owner(req)); res.json({ success: true }); });
router.get('/status', async (req, res) => {
  const status = await assistantRequest(owner(req), '/status');
  res.json({ data: { ...status, readiness: assistantReadiness(status) } });
});

router.get('/products/search', async (req, res) => {
  const q = text(req.query.q, 150, 'Поиск');
  const { item, invoice } = await line(req, req.query);
  const params = new URLSearchParams({ q, limit: '10', scanned_name: text(item.original_name, 255, 'Название строки') });
  if (invoice.supplier) params.set('supplier', invoice.supplier.slice(0, 255));
  const data = await assistantRequest(owner(req), '/products/search?' + params);
  if (!Array.isArray(data.products)) throw new ProductAssistantError(502, 'Помощник вернул неверный список товаров');
  const blocked = await blockedFor(req, item.original_name);
  const products = [];
  for (const candidate of data.products.slice(0, 30)) {
    if (!object(candidate) || typeof candidate.onec_guid !== 'string') continue;
    const row = await allowedProduct(candidate.onec_guid, req, blocked);
    if (row) products.push({ ...candidate, onec_guid: row.guid, name: row.name, code: row.code, unit: row.unit });
  }
  res.json({ data: { ...data, products, total: products.length } });
});

const mutationLimit = rateLimit({ windowMs: 60_000, max: 20, keyGenerator: req => String(owner(req)),
  standardHeaders: true, legacyHeaders: false, message: { error: 'Слишком много обращений к помощнику. Подождите минуту' } });
router.post('/chat', mutationLimit, async (req, res) => {
  if (!object(req.body)) throw new ProductAssistantError(400, 'Некорректный запрос');
  const requestKey = key(req);
  const message = text(req.body.message, 8000, 'Вопрос');
  const { item, invoice } = await line(req, req.body);
  if (req.body.session_id !== undefined && (typeof req.body.session_id !== 'string' || !opaqueId.test(req.body.session_id))) throw new ProductAssistantError(400, 'Некорректный диалог');
  if (req.body.auto_learn !== undefined && typeof req.body.auto_learn !== 'boolean') throw new ProductAssistantError(400, 'Некорректное разрешение на обучение');
  const rawCandidates = req.body.candidate_guids ?? [];
  if (!Array.isArray(rawCandidates) || rawCandidates.length > 30 || rawCandidates.some(g => typeof g !== 'string' || !uuid.test(g))) throw new ProductAssistantError(400, 'Некорректный список кандидатов');
  const blocked = await blockedFor(req, item.original_name);
  const candidates = [];
  for (const guid of new Set(rawCandidates as string[])) if (await allowedProduct(guid, req, blocked)) candidates.push(guid);
  const quantity = item.raw_quantity ?? item.quantity;
  const unit = item.raw_unit ?? item.unit;
  const context = { scanned_name: text(item.original_name, 255, 'Название строки'), supplier: invoice.supplier?.slice(0, 255),
    invoice_id: invoice.id,
    ...(typeof item.row_no === 'number' && Number.isFinite(item.row_no) && item.row_no >= 0 ? { row_no: item.row_no } : {}),
    ...(typeof quantity === 'number' && Number.isFinite(quantity) && quantity >= 0 ? { quantity } : {}),
    ...(typeof unit === 'string' && unit.trim() ? { unit: unit.slice(0, 255) } : {}),
    candidate_guids: candidates };
  const data = await assistantRequest(owner(req), '/chat', { key: requestKey, body: {
    actor_id: actor(req), company_id: owner(req), message, context,
    auto_learn: req.body.auto_learn === true, ...(req.body.session_id ? { session_id: req.body.session_id } : {}),
  } });
  res.status(202).json({ data });
});

router.get('/requests/:requestId', async (req, res) => {
  if (!opaqueId.test(String(req.params.requestId))) throw new ProductAssistantError(400, 'Некорректный запрос');
  const data = await assistantRequest(owner(req), `/requests/${req.params.requestId}?` + new URLSearchParams({ actor_id: actor(req) }));
  if (object(data.result) && object(data.result.match)) {
    const match = data.result.match;
    const { item } = await line(req, req.query);
    const product = typeof match.onec_guid === 'string'
      ? await allowedProduct(match.onec_guid, req, await blockedFor(req, item.original_name)) : null;
    data.result.match = product ? { ...match, onec_guid: product.guid, mapped_name_1c: product.name, code_1c: product.code, unit: product.unit } : null;
  }
  // Do not follow poll_url from an external service. All URLs are constructed here.
  res.json({ data });
});

router.post('/mappings', mutationLimit, async (req, res) => {
  if (!object(req.body)) throw new ProductAssistantError(400, 'Некорректный запрос');
  const requestKey = key(req);
  const { item, invoice } = await line(req, req.body);
  const guid = req.body.onec_guid;
  if (typeof guid !== 'string' || !uuid.test(guid)) throw new ProductAssistantError(400, 'Некорректный товар');
  const row = await allowedProduct(guid, req, await blockedFor(req, item.original_name));
  if (!row) throw new ProductAssistantError(409, 'Товар недоступен или отмечен «Не это»');
  if (item.onec_guid?.toLowerCase() !== guid.toLowerCase()) throw new ProductAssistantError(409, 'Сначала сохраните выбор в строке накладной');
  const data = await assistantRequest(owner(req), '/mappings', { key: requestKey, body: {
    actor_id: actor(req), company_id: owner(req), scanned_name: text(item.original_name, 255, 'Название строки'),
    onec_guid: row.guid, supplier: invoice.supplier?.slice(0, 255),
  } });
  res.status(202).json({ data });
});

router.use((error: unknown, _req: Request, res: import('express').Response, _next: import('express').NextFunction) => {
  const known = error instanceof ProductAssistantError;
  res.status(known ? error.status : 500).json({ error: known ? error.message : 'Не удалось выполнить запрос помощника' });
});
export default router;
