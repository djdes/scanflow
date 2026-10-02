import { Router, type Request } from 'express';
import { invoiceRepo, type Invoice, type InvoiceItem } from '../../database/repositories/invoiceRepo';
import { getDb } from '../../database/db';
import { decision, reviewTargets, sourceRegions, saveRegion, validRegion, nextReview, previousSupply, applyReviewEdit, ReviewError } from '../../services/invoiceReview';
import { locateSource, sourceImage } from '../../services/invoiceSourceLocator';
import { logger } from '../../utils/logger';
import { createHash } from 'crypto';
const router = Router();
type ReviewInvoice = Invoice & {
    items: InvoiceItem[];
};
async function owned(req: Request): Promise<ReviewInvoice> {
    const id = Number(req.params.id);
    if (!req.user)
        throw new ReviewError(401, 'Требуется вход');
    const inv = Number.isInteger(id) && id > 0 ? await invoiceRepo.getWithItems(id) : null;
    if (!inv || inv.owner_user_id !== req.user.id)
        throw new ReviewError(404, 'Накладная не найдена');
    return inv;
}
const jobs = new Map<number, {
    owner: number;
    status: 'running' | 'done' | 'error';
    message: string;
    started: number;
}>();
const fingerprint = (i: ReviewInvoice) => createHash('sha256').update(JSON.stringify([i.file_name, i.items.map(t => [t.id, t.original_name])])).digest('hex');
router.get('/review/next', async (req, res) => {
    if (!req.user)
        return res.status(401).json({ error: 'Требуется вход' });
    const raw = String(req.query.exclude ?? '').split(',').filter(Boolean);
    if (raw.length > 500 || raw.some(v => !/^\d+$/.test(v)))
        return res.status(400).json({ error: 'Некорректный список документов' });
    res.json({ data: await nextReview(req.user.id, raw.map(Number)) ?? null });
});
router.get('/:id/review', async (req, res) => {
    const inv = await owned(req);
    const job = jobs.get(inv.id);
    const payment = await getDb().prepare('SELECT status, bank_status FROM sber_payments WHERE invoice_id = ?').get<{
        status: string;
        bank_status: string | null;
    }>(inv.id);
    res.json({ data: { decision: { ...decision(inv), editable: decision(inv).editable && (!payment || payment.status === 'failed') }, regions: await sourceRegions(inv), job: job?.owner === req.user?.id ? job : null, payment: payment ?? null } });
});
router.get('/:id/review/image/:filename', async (req, res) => {
    const inv = await owned(req), filename = String(req.params.filename);
    if (!inv.file_name.split(',').map(s => s.trim()).includes(filename))
        throw new ReviewError(404, 'Фото не найдено');
    try {
        const image = await sourceImage(filename);
        res.set('Cache-Control', 'private, no-store').type('jpeg').send(image);
    }
    catch {
        throw new ReviewError(404, 'Фото недоступно. Откройте исходный файл во вкладке «Фото».');
    }
});
router.put('/:id/review/region', async (req, res) => {
    const inv = await owned(req), region = req.body;
    if (!validRegion(region) || !inv.file_name.split(',').map(s => s.trim()).includes(region.filename)
        || !reviewTargets(inv).some(t => t.key === region.target_key))
        throw new ReviewError(400, 'Некорректная область или строка');
    await saveRegion(inv.id, { ...region, origin: 'manual' });
    res.json({ data: await sourceRegions(inv) });
});
router.delete('/:id/review/region', async (req, res) => {
    const inv = await owned(req);
    if (typeof req.body?.filename !== 'string' || typeof req.body?.target_key !== 'string')
        throw new ReviewError(400, 'Укажите область');
    await getDb().prepare('DELETE FROM invoice_source_regions WHERE invoice_id = ? AND filename = ? AND target_key = ?').run(inv.id, req.body.filename, req.body.target_key);
    res.json({ data: await sourceRegions(inv) });
});
router.post('/:id/review/locate', async (req, res) => {
    const inv = await owned(req), filename = req.body?.filename;
    if (typeof filename !== 'string' || !inv.file_name.split(',').map(s => s.trim()).includes(filename) || !/\.(jpe?g|png|webp|bmp|tiff?)$/i.test(filename))
        throw new ReviewError(400, 'Выберите фото');
    const existing = jobs.get(inv.id);
    if (existing?.status === 'running')
        return res.status(202).json({ data: existing });
    if ([...jobs.values()].filter(j => j.status === 'running').length >= 2)
        throw new ReviewError(429, 'Поиск занят. Повторите позже или выделите область вручную.');
    // Expire completed job status; coordinates themselves live in the database.
    for (const [id, j] of jobs)
        if (j.status !== 'running' && Date.now() - j.started > 600000)
            jobs.delete(id);
    let targets = reviewTargets(inv);
    if (typeof req.body.target_key === 'string') {
        const key = req.body.target_key;
        const prefix = key.startsWith('item:') ? key.split(':').slice(0, 2).join(':') + ':' : key;
        targets = targets.filter(t => t.key.startsWith(prefix));
    }
    else
        targets = targets.filter(t => t.key.startsWith('header:') || t.key.endsWith(':row'));
    if (!targets.length || targets.length > 206)
        throw new ReviewError(400, 'Выберите одну строку для поиска');
    const job = { owner: req.user!.id, status: 'running' as 'running' | 'done' | 'error', message: 'Ищем области на выбранном листе…', started: Date.now() };
    jobs.set(inv.id, job);
    res.status(202).json({ data: job });
    void (async () => {
        try {
            const found = await locateSource(filename, targets);
            await getDb().transaction(async (db) => {
                const locked = await db.prepare('SELECT file_name FROM invoices WHERE id = ? AND owner_user_id = ? FOR UPDATE').get<{
                    file_name: string;
                }>(inv.id, inv.owner_user_id);
                const items = await db.prepare('SELECT id, original_name FROM invoice_items WHERE invoice_id = ? ORDER BY id').all<InvoiceItem>(inv.id);
                const originalItems = [...inv.items].sort((a, b) => a.id - b.id);
                if (!locked || fingerprint({ ...inv, file_name: locked.file_name, items }) !== fingerprint({ ...inv, items: originalItems }))
                    throw new Error('Документ изменился. Повторите поиск на актуальной версии.');
                const manual = await db.prepare("SELECT target_key FROM invoice_source_regions WHERE invoice_id = ? AND filename = ? AND origin = 'manual'").all<{
                    target_key: string;
                }>(inv.id, filename);
                for (const region of found)
                    if (!manual.some(r => r.target_key === region.target_key))
                        await saveRegion(inv.id, region, db);
            });
            job.status = 'done';
            job.message = `Найдено областей: ${found.length}. Выделения ИИ нужно сверить с оригиналом.`;
        }
        catch (err) {
            job.status = 'error';
            job.message = (err as Error).message.startsWith('Документ изменился') ? (err as Error).message : 'Поиск не удался. Попробуйте снова или выделите область вручную.';
            logger.warn('source locator failed', { invoice: inv.id, error: (err as Error).message });
        }
    })();
});
router.get('/:id/review/compare', async (req, res) => res.json({ data: await previousSupply(await owned(req)) }));
router.patch('/:id/review/edit', async (req, res) => { const inv = await owned(req); res.json({ data: await applyReviewEdit(inv.id, req.user!.id, req.body ?? {}) }); });
router.use((err: Error, req: Request, res: import('express').Response, next: import('express').NextFunction) => {
    if (err instanceof ReviewError)
        return res.status(err.status).json({ error: err.message });
    next(err);
});
export default router;
