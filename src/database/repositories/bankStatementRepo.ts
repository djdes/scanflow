import { getDb } from '../db';
import { ParsedBankEntry } from '../../operations/bankStatement';

export interface BankStatementRow {
  id: number;
  owner_user_id: number | null;
  operation_date: string;
  amount: number;
  direction: 'debit' | 'credit';
  counterparty: string | null;
  counterparty_inn: string | null;
  account: string | null;
  purpose: string | null;
  external_id: string | null;
  operation_hash: string;
  matched_invoice_id: number | null;
  match_score: number | null;
  match_reason: string | null;
  created_at: string;
}

interface CandidateInvoice {
  id: number;
  invoice_number: string | null;
  invoice_date: string | null;
  supplier: string | null;
  supplier_inn: string | null;
  total_sum: number | null;
}

function compact(value: string | null): string {
  return (value || '').toLocaleLowerCase('ru-RU').replace(/[ё]/g, 'е').replace(/[^a-zа-я0-9]+/g, '');
}

function scoreEntry(entry: ParsedBankEntry, invoice: CandidateInvoice): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const total = Number(invoice.total_sum || 0);
  if (total > 0) {
    const delta = Math.abs(entry.amount - total);
    if (delta <= 1) { score += 45; reasons.push('сумма'); }
    else if (delta / total <= 0.01) { score += 30; reasons.push('сумма ±1%'); }
  }
  if (entry.counterpartyInn && invoice.supplier_inn && entry.counterpartyInn === invoice.supplier_inn) {
    score += 30; reasons.push('ИНН');
  }
  const purpose = compact(entry.purpose);
  const number = compact(invoice.invoice_number);
  if (number.length >= 2 && purpose.includes(number)) { score += 30; reasons.push('номер документа'); }
  const supplier = compact(invoice.supplier);
  if (supplier.length >= 5 && purpose.includes(supplier.slice(0, Math.min(18, supplier.length)))) {
    score += 10; reasons.push('поставщик');
  }
  if (invoice.invoice_date) {
    const days = Math.abs((Date.parse(entry.operationDate) - Date.parse(invoice.invoice_date)) / 86_400_000);
    if (Number.isFinite(days) && days <= 120) { score += days <= 45 ? 10 : 5; reasons.push('дата'); }
  }
  return { score, reasons };
}

export const bankStatementRepo = {
  async import(entries: ParsedBankEntry[], importedBy: number, invoiceOwner: number | null): Promise<{ imported: number; skipped: number; matched: number }> {
    const ownerFilter = invoiceOwner == null ? { sql: '1=1', args: [] as unknown[] } : { sql: 'i.owner_user_id = ?', args: [invoiceOwner] };
    const candidates = await getDb().prepare(`
      SELECT i.id, i.invoice_number, i.invoice_date, i.supplier, i.supplier_inn, i.total_sum
        FROM invoices i
       WHERE ${ownerFilter.sql}
         AND i.status NOT IN ('error', 'failed', 'duplicate') AND i.duplicate_of IS NULL
         AND i.total_sum IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM bank_statement_entries b WHERE b.matched_invoice_id = i.id)
       ORDER BY i.created_at DESC LIMIT 1000
    `).all<CandidateInvoice>(...ownerFilter.args);
    const claimed = new Set<number>();
    let imported = 0;
    let skipped = 0;
    let matched = 0;
    for (const entry of entries.slice(0, 5000)) {
      let matchedInvoiceId: number | null = null;
      let matchScore: number | null = null;
      let matchReason: string | null = null;
      if (entry.direction === 'debit') {
        const ranked = candidates.filter(candidate => !claimed.has(candidate.id))
          .map(candidate => ({ candidate, ...scoreEntry(entry, candidate) }))
          .sort((a, b) => b.score - a.score);
        if (ranked[0] && ranked[0].score >= 60 && (!ranked[1] || ranked[0].score - ranked[1].score >= 10)) {
          matchedInvoiceId = ranked[0].candidate.id;
          matchScore = ranked[0].score;
          matchReason = ranked[0].reasons.join(', ').slice(0, 512);
        }
      }
      const result = await getDb().prepare(`
        INSERT IGNORE INTO bank_statement_entries
          (owner_user_id, operation_date, amount, direction, counterparty, counterparty_inn,
           account, purpose, external_id, operation_hash, matched_invoice_id, match_score,
           match_reason, imported_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(importedBy, entry.operationDate, entry.amount, entry.direction, entry.counterparty,
        entry.counterpartyInn, entry.account, entry.purpose, entry.externalId, entry.operationHash,
        matchedInvoiceId, matchScore, matchReason, importedBy);
      if (result.changes > 0) {
        imported++;
        if (matchedInvoiceId != null) { claimed.add(matchedInvoiceId); matched++; }
      } else skipped++;
    }
    return { imported, skipped, matched };
  },

  async list(ownerUserId: number | null, limit = 500): Promise<BankStatementRow[]> {
    const lim = Math.max(1, Math.min(1000, Math.trunc(limit) || 500));
    return ownerUserId == null
      ? getDb().prepare(`SELECT * FROM bank_statement_entries ORDER BY operation_date DESC, id DESC LIMIT ${lim}`).all<BankStatementRow>()
      : getDb().prepare(`SELECT * FROM bank_statement_entries WHERE owner_user_id = ? ORDER BY operation_date DESC, id DESC LIMIT ${lim}`).all<BankStatementRow>(ownerUserId);
  },
};
