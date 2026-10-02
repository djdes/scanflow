import { getDb, type DbAdapter } from '../database/db';
import { ATTR_COLUMNS, ATTR_FIELD_TO_KEY, uncheckedAttrs, invoiceRepo, type Invoice, type InvoiceItem } from '../database/repositories/invoiceRepo';
import { REVIEW_REASON_SQL } from '../database/repositories/invoiceListWorkflow';
import { canonUnit } from '../mapping/unitConverter';
import { serializeEditValue } from '../database/repositories/editLogRepo';
import { recomputeMedianForGuids } from '../pricing/priceStats';
export class ReviewError extends Error {
    constructor(public status: number, message: string) { super(message); }
}
export const HEADER_EDIT_FIELDS = ['invoice_number', 'invoice_date', 'supplier', 'supplier_inn', 'total_sum', 'vat_sum'] as const;
export const ITEM_EDIT_FIELDS = ['quantity', 'unit', 'price', 'total'] as const;
export interface SourceRegion {
    filename: string;
    target_key: string;
    x: number;
    y: number;
    width: number;
    height: number;
    printed_text?: string | null;
    origin: 'manual' | 'ai';
}
export function validRegion(r: unknown): r is SourceRegion {
    if (!r || typeof r !== 'object')
        return false;
    const v = r as SourceRegion;
    return typeof v.filename === 'string' && typeof v.target_key === 'string'
        && [v.x, v.y, v.width, v.height].every(n => typeof n === 'number' && Number.isFinite(n))
        && v.x >= 0 && v.y >= 0 && v.width >= .002 && v.height >= .002
        && v.x + v.width <= 1.000001 && v.y + v.height <= 1.000001
        && (v.printed_text == null || (typeof v.printed_text === 'string' && v.printed_text.length <= 500));
}
export function reviewTargets(inv: Invoice & {
    items: InvoiceItem[];
}) {
    return [
        ...HEADER_EDIT_FIELDS.map(field => ({ key: `header:${field}`, label: field, value: inv[field] })),
        ...inv.items.flatMap(item => ['row', ...ITEM_EDIT_FIELDS].map(field => ({ key: `item:${item.id}:${field}`, label: `${item.original_name} / ${field}`, value: field === 'row' ? item.original_name : item[field as keyof InvoiceItem] }))),
    ];
}
export async function saveRegion(invoiceId: number, region: SourceRegion, db = getDb()) {
    await db.prepare(`INSERT INTO invoice_source_regions
    (invoice_id, filename, target_key, x, y, width, height, printed_text, origin)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE x=VALUES(x), y=VALUES(y), width=VALUES(width), height=VALUES(height),
      printed_text=VALUES(printed_text), origin=VALUES(origin)`)
        .run(invoiceId, region.filename, region.target_key, region.x, region.y, region.width, region.height, region.printed_text ?? null, region.origin);
}
export async function sourceRegions(inv: Invoice & {
    items: InvoiceItem[];
}) {
    const targets = new Set(reviewTargets(inv).map(t => t.key));
    const files = new Set(inv.file_name.split(',').map(s => s.trim()));
    return (await getDb().prepare('SELECT * FROM invoice_source_regions WHERE invoice_id = ? ORDER BY id').all<SourceRegion & {
        id: number;
    }>(inv.id))
        .filter(r => targets.has(r.target_key) && files.has(r.filename));
}
export async function nextReview(owner: number, exclude: number[]) {
    const excluded = exclude.length ? `AND invoices.id NOT IN (${exclude.map(() => '?').join(',')})` : '';
    const unverified = Object.values(ATTR_COLUMNS).map(c => `${c} = 0`).join(' OR ');
    const needs = `((${REVIEW_REASON_SQL}) IS NOT NULL OR (${unverified}))`;
    return getDb().prepare(`SELECT id, invoice_number, supplier, (${REVIEW_REASON_SQL}) AS review_reason
    FROM invoices WHERE owner_user_id = ? AND status IN ('processed','error','duplicate')
      AND approved_for_1c = 0 AND paid_externally = 0 AND ${needs} ${excluded}
    ORDER BY CASE WHEN (${REVIEW_REASON_SQL}) IS NOT NULL THEN 0 ELSE 1 END, created_at ASC, id ASC LIMIT 1`)
        .get(owner, ...exclude);
}
const normalized = (s: string | null | undefined) => String(s ?? '').normalize('NFKC').toLocaleLowerCase('ru').replace(/\s+/g, ' ').trim();
type SupplyPair = { current: InvoiceItem | null; previous: InvoiceItem | null; match: 'guid' | 'name' | 'ambiguous' | 'new' | 'missing' };
function uniquePairs(current: InvoiceItem[], previous: InvoiceItem[]): SupplyPair[] {
    const used = new Set<number>();
    const pairs: SupplyPair[] = current.map(item => {
        const sameGuid = item.onec_guid ? previous.filter(p => p.onec_guid === item.onec_guid) : [];
        const guidUnique = item.onec_guid && current.filter(p => p.onec_guid === item.onec_guid).length === 1;
        const sameName = previous.filter(p => normalized(p.original_name) === normalized(item.original_name));
        const nameUnique = current.filter(p => normalized(p.original_name) === normalized(item.original_name)).length === 1;
        const match = guidUnique && sameGuid.length === 1 ? sameGuid[0]
            : !sameGuid.length && nameUnique && sameName.length === 1 && (!item.onec_guid || !sameName[0].onec_guid || item.onec_guid === sameName[0].onec_guid) ? sameName[0] : null;
        if (match && !used.has(match.id)) {
            used.add(match.id);
            return { current: item, previous: match, match: item.onec_guid && match.onec_guid === item.onec_guid ? 'guid' : 'name' };
        }
        return { current: item, previous: null, match: sameGuid.length || sameName.length ? 'ambiguous' : 'new' };
    });
    for (const old of previous.filter(p => !used.has(p.id))) {
        const ambiguous = current.some(item => (item.onec_guid && item.onec_guid === old.onec_guid) || normalized(item.original_name) === normalized(old.original_name));
        pairs.push({ current: null, previous: old, match: ambiguous ? 'ambiguous' : 'missing' });
    }
    return pairs;
}
export function compareItems(current: InvoiceItem[], previous: InvoiceItem[]) {
    return uniquePairs(current, previous).map(pair => {
        const a = pair.current, b = pair.previous;
        const unitA = canonUnit(a?.unit)?.unit, unitB = canonUnit(b?.unit)?.unit;
        const sameUnit = !!unitA && unitA === unitB;
        const sameVat = a?.vat_rate != null && b?.vat_rate != null && Number(a.vat_rate) === Number(b.vat_rate);
        // A conversion with unknown/conflicting factors is not a comparable price basis.
        const conversionSafe = !a?.qty_flag && !b?.qty_flag && ((a?.conv_factor ?? 1) === (b?.conv_factor ?? 1));
        const comparable = !!a && !!b && sameUnit && sameVat && conversionSafe && Number(a.price) > 0 && Number(b.price) > 0;
        return { ...pair, comparable, price_change_pct: comparable ? (Number(a.price) / Number(b.price) - 1) * 100 : null,
            reason: !a || !b ? pair.match : !sameUnit ? 'different_units' : !sameVat ? 'different_vat' : !conversionSafe ? 'different_conversion' : !comparable ? 'missing_price' : null,
            quantity_changed: !!a && !!b && sameUnit && Number(a.quantity) !== Number(b.quantity),
            packaging_changed: !!a && !!b && (normalized(a.original_name) !== normalized(b.original_name) || (a.conv_factor ?? 1) !== (b.conv_factor ?? 1)),
        };
    });
}
export async function previousSupply(inv: Invoice & {
    items: InvoiceItem[];
}) {
    const supplier = inv.supplier_inn?.trim();
    if (!supplier && !inv.supplier?.trim())
        return null;
    const previous = await getDb().prepare(`SELECT id FROM invoices WHERE owner_user_id = ? AND id <> ?
    AND status IN ('processed','sent_to_1c') AND duplicate_of IS NULL
    AND ${supplier ? 'supplier_inn = ?' : "COALESCE(TRIM(supplier_inn), '') = '' AND TRIM(supplier) = ?"}
    AND (COALESCE(invoice_date, DATE(created_at)) < COALESCE(?, DATE(?))
      OR (COALESCE(invoice_date, DATE(created_at)) = COALESCE(?, DATE(?)) AND created_at < ?)
      OR (COALESCE(invoice_date, DATE(created_at)) = COALESCE(?, DATE(?)) AND created_at = ? AND id < ?))
    ORDER BY COALESCE(invoice_date, DATE(created_at)) DESC, created_at DESC, id DESC LIMIT 1`)
        .get<{
        id: number;
    }>(inv.owner_user_id, inv.id, supplier || inv.supplier!.trim(), inv.invoice_date, inv.created_at, inv.invoice_date, inv.created_at, inv.created_at, inv.invoice_date, inv.created_at, inv.created_at, inv.id);
    if (!previous)
        return null;
    const old = await invoiceRepo.getWithItems(previous.id);
    return old ? { previous: old, current: inv, rows: compareItems(inv.items, old.items), supplier_basis: supplier ? 'inn' : 'name' } : null;
}
export function editable(inv: Invoice) { return inv.status === 'processed' && !inv.approved_for_1c && !inv.paid_externally && !inv.duplicate_of; }
export function decision(inv: Invoice & {
    items: InvoiceItem[];
}) {
    const missing = uncheckedAttrs(inv);
    const sum = inv.items.reduce((n, i) => n + Number(i.total ?? 0), 0);
    return { unchecked: missing, item_sum: Math.round(sum * 100) / 100, editable: editable(inv),
        unmapped: inv.items.filter(i => !i.onec_guid && !i.name_overridden).map(i => i.id),
        quantity: inv.items.filter(i => i.qty_flag).map(i => i.id),
        mismatch: Number(inv.items_total_mismatch) === 1 && !inv.attr_checked_total,
        missing_header: HEADER_EDIT_FIELDS.filter(f => f !== 'vat_sum' && (inv[f] == null || inv[f] === '' || (f === 'total_sum' && Number(inv[f]) <= 0))),
    };
}
export async function applyReviewEdit(invoiceId: number, owner: number, body: Record<string, unknown>) {
    const itemId = body.item_id == null ? null : Number(body.item_id);
    const field = body.field;
    if (typeof field !== 'string' || !(itemId == null ? HEADER_EDIT_FIELDS : ITEM_EDIT_FIELDS).includes(field as never)
        || (itemId != null && (!Number.isInteger(itemId) || itemId <= 0)) || !Object.prototype.hasOwnProperty.call(body, 'expected'))
        throw new ReviewError(400, 'Недопустимое поле или отсутствует исходное значение');
    let value: string | number | null;
    if (['quantity', 'price', 'total', 'total_sum', 'vat_sum'].includes(field)) {
        value = body.value === null || body.value === '' ? null : typeof body.value === 'number' ? body.value : Number(String(body.value).replace(',', '.'));
        if (value != null && (!Number.isFinite(value) || Number(value) < 0 || Number(value) > 1e12))
            throw new ReviewError(400, 'Укажите неотрицательное число');
    }
    else {
        if (typeof body.value !== 'string' && body.value !== null)
            throw new ReviewError(400, 'Укажите текст');
        value = body.value == null ? null : body.value.trim() || null;
        if (value && value.length > (field === 'unit' ? 32 : 500))
            throw new ReviewError(400, 'Слишком длинное значение');
        if (field === 'invoice_date' && value) {
            const date = new Date(value + 'T00:00:00Z');
            if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value)
                throw new ReviewError(400, 'Некорректная дата');
        }
    }
    if (field === 'supplier_inn' && value) {
        const { isValidInn } = await import('../utils/inn');
        if (!isValidInn(String(value)))
            throw new ReviewError(400, 'ИНН не проходит проверку');
    }
    const result = await getDb().transaction(async (db) => {
        const inv = await db.prepare('SELECT * FROM invoices WHERE id = ? AND owner_user_id = ? FOR UPDATE').get<Invoice>(invoiceId, owner);
        if (!inv)
            throw new ReviewError(404, 'Накладная не найдена');
        const payment = await db.prepare("SELECT status FROM sber_payments WHERE invoice_id = ? AND status <> 'failed' FOR UPDATE").get(invoiceId);
        if (!editable(inv) || payment)
            throw new ReviewError(409, 'Правки закрыты: документ в 1С, очереди, дубликат или платёж уже создан');
        const entity = itemId == null ? inv : await db.prepare('SELECT * FROM invoice_items WHERE id = ? AND invoice_id = ? FOR UPDATE').get<InvoiceItem>(itemId, invoiceId);
        if (!entity)
            throw new ReviewError(404, 'Строка не найдена');
        const old = (entity as unknown as Record<string, unknown>)[field] ?? null;
        const equal = (a: unknown, b: unknown) => a == null && b == null || (typeof old === 'number' ? Number(a) === Number(b) && a !== null && b !== null : a === b);
        if (!equal(old, body.expected))
            throw new ReviewError(409, 'Значение уже изменилось. Обновите документ');
        // Caller supplies the before-values of the entire row, so concurrent dependent edits cannot silently change preview arithmetic.
        if (itemId != null) {
            const row = entity as InvoiceItem;
            const expected = body.expected_row as Record<string, unknown> | undefined;
            if (!expected || ITEM_EDIT_FIELDS.some(k => (row[k] ?? null) !== (expected[k] ?? null)))
                throw new ReviewError(409, 'Строка изменилась. Обновите документ');
        }
        const changes: Record<string, unknown> = { [field]: value };
        if (itemId != null) {
            const row = entity as InvoiceItem;
            const q = field === 'quantity' ? value : row.quantity, p = field === 'price' ? value : row.price;
            if (field !== 'total' && field !== 'unit' && q != null && p != null)
                changes.total = Math.round(Number(q) * Number(p) * 100) / 100;
            await db.prepare(`UPDATE invoice_items SET ${Object.keys(changes).map(k => `${k} = ?`).join(', ')} WHERE id = ? AND invoice_id = ?`).run(...Object.values(changes), itemId, invoiceId);
            // Explicitly edited quantities supersede the unresolved conversion warning; raw source values remain untouched.
            if (field === 'quantity' || field === 'unit')
                await db.prepare('UPDATE invoice_items SET qty_flag = NULL, conv_source = ? WHERE id = ?').run('manual', itemId);
            const totals = await db.prepare('SELECT SUM(total) AS total FROM invoice_items WHERE invoice_id = ?').get<{
                total: number | null;
            }>(invoiceId);
            const total = Number(totals?.total ?? 0), doc = Number(inv.total_sum ?? 0), diff = Math.abs(total - doc);
            await db.prepare('UPDATE invoices SET items_total_mismatch = ?, attr_checked_total = 0, attr_checked_vat = 0, attr_checked_vat_rate = 0 WHERE id = ?').run(diff > 1 && diff / Math.max(doc, total, 1) > .01 ? 1 : 0, invoiceId);
        }
        else {
            const attr = ATTR_FIELD_TO_KEY[field];
            const reset = attr ? `, ${ATTR_COLUMNS[attr]} = 0` : '';
            const supplierReset = field === 'supplier' || field === 'supplier_inn' ? ", supplier_match = NULL, attr_checked_supplier = 0" : '';
            await db.prepare(`UPDATE invoices SET ${field} = ?${reset}${supplierReset} WHERE id = ?`).run(value, invoiceId);
            if (field === 'total_sum') {
                const totals = await db.prepare('SELECT SUM(total) AS total FROM invoice_items WHERE invoice_id = ?').get<{
                    total: number | null;
                }>(invoiceId);
                const t = Number(totals?.total ?? 0), d = Number(value ?? 0);
                await db.prepare('UPDATE invoices SET items_total_mismatch = ? WHERE id = ?').run(Math.abs(t - d) > 1 && Math.abs(t - d) / Math.max(t, d, 1) > .01 ? 1 : 0, invoiceId);
            }
        }
        for (const [key, next] of Object.entries(changes))
            await writeAudit(db, owner, invoiceId, itemId, key, (entity as unknown as Record<string, unknown>)[key], next);
        return { itemId, guid: itemId != null ? (entity as InvoiceItem).onec_guid : null };
    });
    if (result.guid)
        void recomputeMedianForGuids([result.guid], owner).catch(() => { });
    return invoiceRepo.getWithItems(invoiceId);
}
async function writeAudit(db: DbAdapter, owner: number, id: number, item: number | null, field: string, old: unknown, value: unknown) {
    await db.prepare('INSERT INTO edit_log (owner_user_id,user_id,invoice_id,item_id,entity,field,old_value,new_value,context) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(owner, owner, id, item, item == null ? 'invoice' : 'item', field, serializeEditValue(old), serializeEditValue(value), JSON.stringify({ source: 'photo_review' }));
}
