import { NextFunction, Request, Response, Router } from 'express';
import fs from 'fs';
import path from 'path';
import { config } from '../../config';
import { getDb } from '../../database/db';
import { invoiceRepo } from '../../database/repositories/invoiceRepo';
import { integrationEventRepo } from '../../database/repositories/integrationEventRepo';
import { mappingRepo } from '../../database/repositories/mappingRepo';
import { onecConnectionRepo, OnecConnectionRow } from '../../database/repositories/onecConnectionRepo';
import { onecNomenclatureRepo, OnecNomenclatureInput } from '../../database/repositories/onecNomenclatureRepo';
import { onecPairingRepo } from '../../database/repositories/onecPairingRepo';
import { syncStateRepo } from '../../database/repositories/syncStateRepo';
import { logIntegrationEvent } from '../../integration/integrationLog';
import { logger } from '../../utils/logger';
import { NomenclatureMapper } from '../../mapping/nomenclatureMapper';

declare module 'express-serve-static-core' {
  interface Request {
    onecConnection?: OnecConnectionRow;
  }
}

export const onecAdminRouter = Router();
export const onecExchangeRouter = Router();
export const onecUserRouter = Router();
export const onecPairRouter = Router();

// ПУБЛИЧНЫЙ: обменивает одноразовый код на scoped-токен подключения 1С.
onecPairRouter.post('/', async (req: Request, res: Response) => {
  const code = String(req.body?.code || '').trim();
  if (!code) return res.status(400).json({ error: 'code_invalid_or_expired' });
  const redeemed = await onecPairingRepo.redeem(code);
  if (!redeemed) return res.status(400).json({ error: 'code_invalid_or_expired' });
  const created = await onecConnectionRepo.create(
    redeemed.ownerUserId, redeemed.baseName || 'Подключение 1С',
  );
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.setHeader('Cache-Control', 'no-store');
  return res.status(201).json({
    data: {
      token: created.token,
      exchange_url: `${baseUrl}/api/onec/exchange`,
      header: 'X-1C-Token',
    },
  });
});

// Доступен ЛЮБОМУ авторизованному пользователю (в т.ч. роль user) — self-service.
onecUserRouter.post('/pairing-code', async (req: Request, res: Response) => {
  const ownerUserId = req.user?.id;
  if (ownerUserId == null) return res.status(401).json({ error: 'Unauthorized' });
  const baseName = String(req.body?.base_name || '').trim();
  const { code, expiresAt } = await onecPairingRepo.create(ownerUserId, baseName);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(201).json({ data: { code, expires_at: expiresAt } });
});

// Статус подключения 1С для текущего пользователя — доступен роли user,
// чтобы кабинет показывал «подключено / не подключено» без админских прав.
onecUserRouter.get('/pairing-status', async (req: Request, res: Response) => {
  const ownerUserId = req.user?.id;
  if (ownerUserId == null) return res.status(401).json({ error: 'Unauthorized' });
  const connections = (await onecConnectionRepo.list(ownerUserId)).filter((c) => c.active);
  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    data: {
      connected: connections.length > 0,
      connections: connections.map((c) => ({
        name: c.name,
        created_at: c.created_at,
        last_used_at: c.last_used_at,
      })),
    },
  });
});

let mapper: NomenclatureMapper | null = null;
export function setOnecMapper(value: NomenclatureMapper): void { mapper = value; }

async function onecTokenAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = String(req.headers['x-1c-token'] || req.headers['x-api-key'] || '');
  const connection = await onecConnectionRepo.authenticate(token, req.ip || null);
  if (!connection) {
    res.status(401).json({ error: 'Недействительный или отозванный токен подключения 1С' });
    return;
  }
  req.onecConnection = connection;
  next();
}

onecExchangeRouter.use(onecTokenAuth);

// Каталог пер-тенантный НЕЗАВИСИМО от флага скоупинга: обмен всегда идёт в
// контексте конкретного подключения 1С, у которого владелец обязателен.
function catalogOwner(req: Request): number {
  const id = req.onecConnection?.owner_user_id;
  if (id == null) throw new Error('1C exchange route reached without a connection owner');
  return id;
}

function exchangeOwner(req: Request): number | null {
  // Обмен всегда идёт в контексте своего подключения 1С: владелец обязателен,
  // и -1 (несуществующая компания) безопаснее, чем отсутствие фильтра.
  return req.onecConnection?.owner_user_id ?? -1;
}

async function canAccess(req: Request, invoiceId: number): Promise<boolean> {
  const invoice = await invoiceRepo.getById(invoiceId);
  if (!invoice) return false;
  const owner = exchangeOwner(req);
  return owner == null || invoice.owner_user_id === owner;
}

onecAdminRouter.get('/connections', async (req: Request, res: Response) => {
  // Это АДМИНСКИЙ роутер (apiKeyAuth + requireAdmin), а не обмен по токену 1С:
  // req.onecConnection здесь не заполняется, поэтому владелец берётся из
  // req.user — тем же способом, что и в соседнем onecConnectionRepo.list.
  const ownerUserId = req.user?.id ?? -1;
  const [connections, catalog, syncState, lastPoll] = await Promise.all([
    onecConnectionRepo.list(ownerUserId),
    onecNomenclatureRepo.stats(ownerUserId),
    syncStateRepo.getNomenclatureSyncState(ownerUserId),
    integrationEventRepo.last1cPollAt(),
  ]);
  res.json({ data: { connections, catalog, sync_state: syncState, last_poll_at: lastPoll } });
});

onecAdminRouter.post('/connections', async (req: Request, res: Response) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Укажите название базы 1С' });
  const created = await onecConnectionRepo.create(req.user?.id ?? -1, name);
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.setHeader('Cache-Control', 'no-store');
  res.status(201).json({
    data: {
      connection: created.connection,
      token: created.token,
      exchange_url: `${baseUrl}/api/onec/exchange`,
      header: 'X-1C-Token',
      notice: 'Токен показывается один раз. Сохраните его в настройках обработки 1С.',
    },
  });
});

onecAdminRouter.delete('/connections/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Некорректный идентификатор' });
  const revoked = await onecConnectionRepo.revoke(id, req.user?.id ?? -1);
  if (!revoked) return res.status(404).json({ error: 'Активное подключение не найдено' });
  res.json({ success: true });
});

onecAdminRouter.get('/setup', async (req: Request, res: Response) => {
  const baseUrl = `${req.protocol}://${req.get('host')}/api/onec/exchange`;
  res.json({ data: {
    exchange_url: baseUrl,
    steps: [
      'Создайте подключение и сразу сохраните одноразовый токен.',
      'Откройте внешнюю обработку ScanFlow в новой базе 1С:УНФ.',
      'Укажите адрес обмена и токен в настройках обработки, затем проверьте соединение.',
      'Выберите группы номенклатуры и выполните первую выгрузку каталога.',
      'Одобрите тестовую накладную в ScanFlow и загрузите её обработкой в 1С.',
      'Для автоматики добавьте команду синхронизации обработки в регламентное задание.',
    ],
    endpoints: {
      status: `${baseUrl}/status`,
      catalog: `${baseUrl}/nomenclature/sync`,
      pending: `${baseUrl}/invoices/pending`,
      result: `${baseUrl}/invoices/{id}/status`,
    },
  } });
});

onecAdminRouter.get('/source/:part', (req: Request, res: Response) => {
  const files: Record<string, { path: string; name: string }> = {
    object: {
      path: path.resolve(process.cwd(), '1c', 'КНД_ЗагрузкаНакладныхСканер', 'КНД_ЗагрузкаНакладныхСканер', 'Ext', 'ObjectModule.bsl'),
      name: 'ScanFlow_ObjectModule.bsl',
    },
    form: {
      path: path.resolve(process.cwd(), '1c', 'КНД_ЗагрузкаНакладныхСканер', 'КНД_ЗагрузкаНакладныхСканер', 'Forms', 'Форма', 'Ext', 'Form', 'Module.bsl'),
      name: 'ScanFlow_FormModule.bsl',
    },
  };
  const file = files[String(req.params.part)];
  if (!file || !fs.existsSync(file.path)) return res.status(404).json({ error: 'Исходник не найден' });
  res.download(file.path, file.name);
});

onecExchangeRouter.get('/status', async (req: Request, res: Response) => {
  const [catalog, syncState] = await Promise.all([onecNomenclatureRepo.stats(catalogOwner(req)), syncStateRepo.getNomenclatureSyncState(catalogOwner(req))]);
  res.json({ data: { ok: true, connection: req.onecConnection?.name, catalog, sync_state: syncState, server_time: new Date().toISOString() } });
});

onecExchangeRouter.get('/invoices/pending', async (req: Request, res: Response) => {
  const limitRaw = Number(req.query.limit);
  const offsetRaw = Number(req.query.offset);
  const result = await invoiceRepo.getPendingWithItems({
    limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 100,
    offset: Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0,
    ownerUserId: exchangeOwner(req) ?? undefined,
  });
  void logIntegrationEvent({ integration: '1c', event_type: 'poll', status: 'info', summary: `Подключение «${req.onecConnection?.name}» запросило очередь: ${result.rows.length}` });
  res.json({ data: result.rows, count: result.rows.length, total: result.total });
});

onecExchangeRouter.get('/invoices/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || !(await canAccess(req, id))) return res.status(404).json({ error: 'Документ не найден' });
  res.json({ data: await invoiceRepo.getWithItems(id) });
});

onecExchangeRouter.get('/invoices/:id/photos', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || !(await canAccess(req, id))) return res.status(404).json({ error: 'Документ не найден' });
  const invoice = await invoiceRepo.getById(id);
  const photos = (invoice?.file_name || '').split(',').map(value => value.trim()).filter(Boolean)
    .map(filename => ({ filename, url: `/api/onec/exchange/invoices/${id}/photos/${encodeURIComponent(filename)}` }));
  res.json({ data: photos });
});

onecExchangeRouter.get('/invoices/:id/photos/:filename', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || !(await canAccess(req, id))) return res.status(404).json({ error: 'Документ не найден' });
  const invoice = await invoiceRepo.getById(id);
  const requested = String(req.params.filename);
  const allowed = (invoice?.file_name || '').split(',').map(value => value.trim());
  if (!allowed.includes(requested)) return res.status(404).json({ error: 'Файл не относится к документу' });
  const safeName = path.basename(requested);
  const found = [config.processedDir, config.failedDir, config.inboxDir]
    .map(dir => path.join(dir, safeName)).find(candidate => fs.existsSync(candidate));
  if (!found) return res.status(404).json({ error: 'Файл отсутствует на диске' });
  res.sendFile(found);
});

onecExchangeRouter.post('/invoices/:id/status', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const status = String(req.body?.status || '');
  if (!Number.isFinite(id) || !(await canAccess(req, id))) return res.status(404).json({ error: 'Документ не найден' });
  if (!['created', 'posted', 'rejected', 'error'].includes(status)) return res.status(400).json({ error: 'status: created, posted, rejected или error' });
  const documentRef = String(req.body?.document_ref || '').trim().slice(0, 255) || null;
  const error = String(req.body?.error || '').trim().slice(0, 4000) || null;
  if (status === 'created' || status === 'posted') {
    await invoiceRepo.markSent(id);
    await getDb().prepare(`UPDATE invoices SET approved_for_1c = 0, onec_status = ?, onec_document_ref = ?, onec_error = NULL, onec_updated_at = NOW() WHERE id = ?`)
      .run(status, documentRef, id);
  } else {
    await getDb().prepare(`UPDATE invoices SET onec_status = ?, onec_document_ref = ?, onec_error = ?, onec_updated_at = NOW(),
      onec_pulled_at = NULL, approved_for_1c = CASE WHEN ? = 'rejected' THEN 0 ELSE approved_for_1c END WHERE id = ?`)
      .run(status, documentRef, error, status, id);
  }
  void logIntegrationEvent({
    integration: '1c', event_type: `document_${status}`, status: status === 'error' || status === 'rejected' ? 'error' : 'ok', invoice_id: id,
    summary: `1С «${req.onecConnection?.name}»: статус ${status}${documentRef ? `, ${documentRef}` : ''}`,
    detail: error ? { error } : undefined,
  });
  res.json({ data: { id, status, document_ref: documentRef } });
});

onecExchangeRouter.delete('/nomenclature', async (req: Request, res: Response) => {
  const deleted = await onecNomenclatureRepo.clearAll(catalogOwner(req));
  mapper?.invalidateCache(catalogOwner(req));
  res.json({ data: { deleted } });
});

onecExchangeRouter.post('/nomenclature/sync', async (req: Request, res: Response) => {
  const items = req.body?.items as OnecNomenclatureInput[] | undefined;
  if (!Array.isArray(items) || items.length === 0 || items.length > 5000) return res.status(400).json({ error: 'items: от 1 до 5000 позиций' });
  if (items.some(item => !String(item?.guid || '').trim() || !String(item?.name || '').trim())) return res.status(400).json({ error: 'У каждой позиции обязательны guid и name' });
  try {
    const upserted = await onecNomenclatureRepo.bulkUpsert(items, catalogOwner(req));
    const orphaned = await mappingRepo.removeOrphaned(catalogOwner(req));
    mapper?.invalidateCache(catalogOwner(req));
    void logIntegrationEvent({ integration: 'nomenclature', event_type: 'catalog_synced', summary: `1С «${req.onecConnection?.name}»: синхронизировано ${upserted} позиций` });
    res.json({ data: { upserted, total: items.length, orphaned_removed: orphaned } });
  } catch (error) {
    logger.error('Scoped 1C catalog sync failed', { connectionId: req.onecConnection?.id, error: (error as Error).message });
    res.status(500).json({ error: 'Не удалось синхронизировать каталог' });
  }
});

onecExchangeRouter.get('/nomenclature/sync-flag', async (req: Request, res: Response) => {
  const state = await syncStateRepo.getNomenclatureSyncState(catalogOwner(req));
  res.json({ data: { ...state, nomenclature_sync_requested: state.requested } });
});

onecExchangeRouter.post('/nomenclature/sync-flag/clear', async (req: Request, res: Response) => {
  const since = String(req.body?.since || '');
  if (!since) return res.status(400).json({ error: 'since обязателен' });
  res.json({ data: await syncStateRepo.clearNomenclatureSync(since, catalogOwner(req)) });
});
