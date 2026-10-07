import { invoiceRepo } from '../database/repositories/invoiceRepo';
import { aiTargetFromConfig } from '../ai/engine';
import { queueRepo } from '../database/repositories/queueRepo';
import type { CatalogEntry } from '../ocr/claudeApiAnalyzer';
import { llmRemapInvoice, loadLlmCatalog, EMPTY_CATALOG_ERROR } from './llmRemap';
import { isWorkable } from './queue';
import { startQueueJob, assertQueueJobFree, viewQueueJob, QueueStartError, type QueueJobResult, type QueueJobView } from './queueJobs';

/**
 * «Подобрать позиции ИИ» для очереди в 1С (п.13 дизайна 2026-09-29): вторая
 * компания загрузила накладные почти без сопоставлений. Для каждой накладной
 * очереди, где есть строки без позиции 1С, — тот же «LLM-маппинг», что кнопка
 * на карточке (src/services/llmRemap.ts, с проверками v2), строго по одной
 * накладной, в фоне, с прогрессом.
 *
 * Отличия от кнопки на карточке — только в том, что трогать:
 *   - строки, которым человек сам задал название для 1С (в том числе через
 *     «Создать в 1С»), ИИ не трогает — явное решение человека важнее;
 *   - НДС шапки не пересчитывается (keepHeaderVat): страница очереди меняет
 *     только строки;
 *   - одобренные для 1С накладные пропускаются — их строки 1С может забрать
 *     в любой момент.
 * Каталог читается один раз на прогон: тот же массив уходит в каждый запрос и
 * по нему же читается ответ.
 */

export async function llmMapQueueInvoice(
  invoiceId: number,
  ctx: { ownerUserId: number; userId: number | null; catalog: CatalogEntry[] },
): Promise<QueueJobResult> {
  const base = { invoice_id: invoiceId };
  const inv = await invoiceRepo.getById(invoiceId);
  if (!inv || inv.owner_user_id !== ctx.ownerUserId) return { ...base, status: 'skipped', reason: 'not_found' };
  if (!isWorkable(inv)) return { ...base, status: 'skipped', reason: 'not_in_queue' };
  const out = await llmRemapInvoice(inv, {
    includeAll: false, catalog: ctx.catalog, skipNameOverridden: true, keepHeaderVat: true, userId: ctx.userId,
  });
  if (!out.ok) return { ...base, status: 'error', error: out.error };
  return {
    ...base,
    status: 'ok',
    requested: out.data.requested,
    matched: out.data.matched,
    changed: out.data.changed,
    repacked: out.data.repacked,
    guarded: out.guarded,
  };
}

export async function startQueueLlmMap(opts: {
  ownerUserId: number;
  startedBy: number | null;
  invoiceIds?: number[] | null;
}): Promise<{ job: QueueJobView; planned: number }> {
  assertQueueJobFree(opts.ownerUserId);
  // Модель из настроек (ИИ-шлюз): в режиме gpt — GPT по подписке.
  const target = aiTargetFromConfig(await invoiceRepo.getAnalyzerConfig());
  if (target.engine === 'claude' && !target.apiKey) throw new QueueStartError(400, 'Не задан ключ Anthropic — включён режим Claude');
  const catalog = await loadLlmCatalog(opts.ownerUserId);
  if (!catalog.length) throw new QueueStartError(400, EMPTY_CATALOG_ERROR);
  const ids = await queueRepo.queueIds(opts.ownerUserId, { ids: opts.invoiceIds ?? null, onlyWithUnmapped: true });
  if (!ids.length) {
    throw new QueueStartError(400, opts.invoiceIds
      ? 'В выбранных накладных нет строк без позиции 1С, которые можно подобрать (одобренные для 1С не трогаем)'
      : 'В очереди в 1С нет строк без позиции 1С — подбирать нечего');
  }
  const ctx = { ownerUserId: opts.ownerUserId, userId: opts.startedBy, catalog };
  const { job } = startQueueJob({
    kind: 'llm_map',
    ownerUserId: opts.ownerUserId,
    startedBy: opts.startedBy,
    invoiceIds: ids,
    meta: { model: target.model, catalog_size: catalog.length },
    worker: (invoiceId) => llmMapQueueInvoice(invoiceId, ctx),
    resume: (remainingIds) => startQueueLlmMap({ ...opts, invoiceIds: remainingIds }),
  });
  return { job: viewQueueJob(job), planned: ids.length };
}
