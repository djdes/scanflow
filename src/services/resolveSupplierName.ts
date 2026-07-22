import { canonicalizeSupplierName } from '../utils/invoiceNumber';
import { invoiceRepo } from '../database/repositories/invoiceRepo';
import { supplierRepo } from '../database/repositories/supplierRepo';

/**
 * Resolve the supplier NAME to store on a freshly-recognized invoice.
 *
 * Priority:
 *  1. **Verified supplier directory by ИНН.** ИНН is a far more reliable key
 *     than the OCR'd name — if the user has a confirmed card for this ИНН, its
 *     canonical name wins outright, even when OCR misread or missed the name.
 *  2. **Canonical spelling from prior invoices** (exact ИНН, else fuzzy ≥70%)
 *     so OCR drift ("…ГКОМПАНИЙ" vs "…ГКОМПАНИ") doesn't fork one supplier into
 *     near-duplicates.
 *  3. The canonicalized raw OCR name.
 *
 * Returns undefined only when there is neither a directory hit nor any raw name
 * (so callers leave the field untouched).
 *
 * Note: only `verified=1` directory cards are trusted here — auto-extracted
 * (`verified=0`) rows may themselves carry OCR-garbled names, so they don't
 * override recognition. Full requisite substitution (КПП/БИК/счёт/…) still
 * happens downstream via {@link enrichInvoiceWithSupplier} on 1С export / UI.
 */
export async function resolveSupplierName(
  rawSupplier: string | null | undefined,
  inn: string | null | undefined,
  ownerUserId: number | null,
): Promise<string | undefined> {
  const innTrim = inn ? String(inn).trim() : '';
  // Справочник пер-тенантный: без владельца в него не заглядываем — иначе
  // название подставилось бы из карточки чужой компании.
  if (innTrim && ownerUserId != null) {
    const dir = await supplierRepo.findByInn(innTrim, ownerUserId);
    if (dir && dir.verified && dir.name) return dir.name;
  }
  if (!rawSupplier) return undefined;
  const canon = canonicalizeSupplierName(rawSupplier);
  return (await invoiceRepo.findCanonicalSupplier(canon, innTrim || null)) ?? canon;
}
