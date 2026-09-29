import { Router, Request, Response } from 'express';
import { onecNomenclatureRepo } from '../../database/repositories/onecNomenclatureRepo';
import { newItemRequestRepo } from '../../database/repositories/newItemRequestRepo';
import { invoiceRepo } from '../../database/repositories/invoiceRepo';
import { logEdit } from '../../database/repositories/editLogRepo';
import {
  buildNewItemGroups,
  pendingRequestsWithoutLines,
  validateMapGroupBody,
  validateCreateItemBody,
  findCatalogItemByName,
} from '../../services/newItems';
import { mapNewItemGroup, unsentGroupLines } from '../../services/newItemActions';
import type { NomenclatureMapper } from '../../mapping/nomenclatureMapper';
import { logger } from '../../utils/logger';

/**
 * /api/new-items — «Новые товары» (пакет v2, п.12). Монтируется за apiKeyAuth.
 *
 *   GET    /        группы строк без позиции 1С из неотправленных накладных
 *                   (по ключу товара) + заявки, чьи строки уже ушли в 1С;
 *   POST   /map     {name_key, onec_guid} — сопоставить группу с позицией 1С;
 *   POST   /create  {name_key, name, unit, parent_guid?} — попросить 1С создать
 *                   позицию: строки группы получают это название, а в выгрузке
 *                   /pending — new_item {name, unit, parent_guid};
 *   DELETE /:id     отменить ждущую заявку (названия строк остаются).
 *
 * Всё строго в пределах компании вызывающего (req.user.id = owner_user_id
 * накладных, каталога и заявок) — правило 19, роль admin чужого не открывает.
 */
const router = Router();

let mapper: NomenclatureMapper | null = null;
export function setMapper(m: NomenclatureMapper): void {
  mapper = m;
}

const GONE = 'Строк этой группы уже нет — их сопоставили или отправили в 1С. Обновите страницу.';

function ownerOf(req: Request, res: Response): number | null {
  const id = req.user?.id;
  if (id == null) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  return id;
}

// GET /api/new-items
router.get('/', async (req: Request, res: Response) => {
  const owner = ownerOf(req, res);
  if (owner == null) return;
  const [lines, requests] = await Promise.all([
    newItemRequestRepo.unsentUnmappedLines(owner),
    newItemRequestRepo.list(owner),
  ]);
  const groups = buildNewItemGroups(lines, requests);
  const waiting = pendingRequestsWithoutLines(requests, lines).map(r => ({
    id: r.id, name_key: r.name_key, name: r.name, unit: r.unit, parent_guid: r.parent_guid,
    status: r.status, created_at: r.created_at, updated_at: r.updated_at,
  }));
  res.json({ data: groups, count: groups.length, waiting });
});

// POST /api/new-items/map — {name_key, onec_guid}
router.post('/map', async (req: Request, res: Response) => {
  const owner = ownerOf(req, res);
  if (owner == null) return;
  const v = validateMapGroupBody(req.body);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const { name_key: nameKey, onec_guid: guid } = v.value;

  const onec = await onecNomenclatureRepo.getByGuid(guid, owner);
  if (!onec) return res.status(400).json({ error: 'Такой позиции нет в справочнике 1С вашей компании' });
  if (Number(onec.is_folder) === 1) return res.status(400).json({ error: 'Это группа справочника, а не товар — выберите позицию' });

  const pendingRequest = await newItemRequestRepo.getByKey(owner, nameKey);
  const result = await mapNewItemGroup({
    ownerUserId: owner, nameKey, onecGuid: guid, catalogName: onec.name,
    userId: req.user?.id ?? null, source: 'new_items_page',
    requestId: pendingRequest?.status === 'pending' ? pendingRequest.id : null,
  });
  if (result.lines === 0) return res.status(404).json({ error: GONE });

  // Группа нашла свою позицию — просьба создать новую больше не нужна.
  const requestCancelled = await newItemRequestRepo.cancelPendingByKey(owner, nameKey);
  mapper?.invalidateCache(owner);
  logger.info('New items: group mapped', { ownerUserId: owner, lines: result.lines, invoices: result.invoices, onecGuid: guid });
  res.json({ data: { ...result, onec_guid: guid, name: onec.name, unit: onec.unit, request_cancelled: requestCancelled } });
});

// POST /api/new-items/create — {name_key, name, unit, parent_guid?}
router.post('/create', async (req: Request, res: Response) => {
  const owner = ownerOf(req, res);
  if (owner == null) return;
  const v = validateCreateItemBody(req.body);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const { name_key: nameKey, name, unit, parent_guid: parentGuid } = v.value;

  const lines = await unsentGroupLines(owner, nameKey);
  if (lines.length === 0) return res.status(404).json({ error: GONE });

  const catalog = await onecNomenclatureRepo.listItems({ ownerUserId: owner });
  // Группа: позиция/папка каталога или чья-то «группа» (папки 1С в каталог
  // сайта обычно не выгружаются — у них нет категории).
  if (parentGuid && !catalog.some(r => r.guid === parentGuid || r.parent_guid === parentGuid)) {
    return res.status(400).json({ error: 'Такой группы нет в справочнике 1С вашей компании' });
  }
  // Позицию с таким названием 1С не создаст, а найдёт — со своей единицей и
  // группой. Честнее сразу предложить сопоставить с ней.
  const existing = findCatalogItemByName(name, unit, catalog);
  if (existing) {
    return res.status(409).json({
      error: `В справочнике 1С уже есть «${existing.name}» — сопоставьте строки с этой позицией`,
      existing: { guid: existing.guid, name: existing.name, unit: existing.unit },
    });
  }

  const request = await newItemRequestRepo.upsertPending(owner, {
    nameKey, name, unit, parentGuid, createdBy: req.user?.id ?? null,
  });
  // 1С ищет/создаёт номенклатуру по mapped_name — все строки группы получают
  // ровно это название (как «своё название» на накладной).
  for (const l of lines) {
    await invoiceRepo.setItemCustomName(l.id, name);
    await logEdit({
      ownerUserId: owner, userId: req.user?.id ?? null, invoiceId: l.invoice_id, itemId: l.id,
      entity: 'mapping', field: 'new_item_create', oldValue: l.mapped_name, newValue: name,
      context: { original_name: l.original_name, name_key: nameKey, unit, parent_guid: parentGuid, request_id: request.id },
    });
  }
  logger.info('New items: create in 1C requested', { ownerUserId: owner, requestId: request.id, lines: lines.length, unit });
  res.json({
    data: {
      request: {
        id: request.id, status: request.status, name: request.name, unit: request.unit,
        parent_guid: request.parent_guid, onec_guid: request.onec_guid,
      },
      lines: lines.length,
      invoices: new Set(lines.map(l => l.invoice_id)).size,
    },
  });
});

// DELETE /api/new-items/:id — отменить ждущую заявку
router.delete('/:id', async (req: Request, res: Response) => {
  const owner = ownerOf(req, res);
  if (owner == null) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
  const request = await newItemRequestRepo.getById(owner, id);
  if (!request) return res.status(404).json({ error: 'Заявка не найдена' });
  if (request.status !== 'pending') {
    return res.status(409).json({ error: request.status === 'created' ? 'Позиция уже создана в 1С' : 'Заявка уже отменена' });
  }
  if (!(await newItemRequestRepo.cancel(owner, id))) return res.status(409).json({ error: 'Заявка уже не ждёт создания' });
  await logEdit({
    ownerUserId: owner, userId: req.user?.id ?? null, entity: 'mapping', field: 'new_item_cancel',
    oldValue: { status: 'pending', name: request.name, unit: request.unit, parent_guid: request.parent_guid },
    newValue: { status: 'cancelled' },
    context: { name_key: request.name_key, request_id: id },
  });
  res.json({ data: { id, status: 'cancelled' } });
});

export default router;
