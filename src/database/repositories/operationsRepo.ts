import { getDb } from '../db';

function ownerSql(alias: string, ownerUserId: number | null): { clause: string; params: unknown[] } {
  return ownerUserId == null
    ? { clause: '1=1', params: [] }
    : { clause: `${alias}.owner_user_id = ?`, params: [ownerUserId] };
}

export interface ExceptionRow {
  id: number;
  invoice_number: string | null;
  invoice_date: string | null;
  invoice_type: string | null;
  supplier: string | null;
  total_sum: number | null;
  status: string;
  duplicate_of: number | null;
  duplicate_score: number | null;
  duplicate_reasons: string | null;
  items_total_mismatch: number;
  error_message: string | null;
  unmapped_count: number;
  min_confidence: number | null;
  elevated_count: number;
  supplier_verified: number;
  pending_approvals: number;
  failed_approvals: number;
  onec_status: string | null;
  onec_error: string | null;
  created_at: string;
}

export interface ReconciliationRow {
  invoice_id: number;
  invoice_number: string | null;
  invoice_date: string | null;
  supplier: string | null;
  total_sum: number | null;
  payment_id: number | null;
  payment_status: string | null;
  payment_amount: number | null;
  payment_number: string | null;
  payment_created_at: string | null;
  statement_id: number | null;
  statement_date: string | null;
  statement_amount: number | null;
  statement_purpose: string | null;
  statement_match_score: number | null;
  payment_terms_days: number;
  due_date: string | null;
  payment_priority: string;
  payment_hold_reason: string | null;
}

export interface PaymentCalendarRow {
  date: string | null;
  invoices: number;
  amount: number;
  cumulative: number;
  projected_balance: number | null;
  cash_gap: number;
  overdue: boolean;
}

export interface SupplierScoreRow {
  supplier_key: string;
  supplier_inn: string | null;
  supplier: string;
  verified: number;
  payment_terms_days: number;
  verification_risk: string | null;
  invoices: number;
  total_spend: number;
  avg_invoice: number;
  errors: number;
  duplicates: number;
  mismatches: number;
  elevated_prices: number;
  payments: number;
  overdue: number;
  last_invoice_at: string;
  score?: number;
}

export const operationsRepo = {
  async exceptions(ownerUserId: number | null, minConfidence: number, requireVerified: boolean): Promise<ExceptionRow[]> {
    const owner = ownerSql('i', ownerUserId);
    return getDb().prepare(`
      SELECT i.id, i.invoice_number, i.invoice_date, i.invoice_type, i.supplier, i.total_sum,
             i.status, i.duplicate_of, i.duplicate_score, i.duplicate_reasons,
             i.onec_status, i.onec_error,
             COALESCE(i.items_total_mismatch, 0) AS items_total_mismatch,
             i.error_message, i.created_at,
             (SELECT COUNT(*) FROM invoice_items x
               WHERE x.invoice_id = i.id AND (x.onec_guid IS NULL OR x.onec_guid = '')) AS unmapped_count,
             (SELECT MIN(COALESCE(x.mapping_confidence, 0)) FROM invoice_items x
               WHERE x.invoice_id = i.id) AS min_confidence,
             (SELECT COUNT(*) FROM invoice_items x
               JOIN nomenclature_price_stats ps ON ps.onec_guid = x.onec_guid
              WHERE x.invoice_id = i.id AND x.price > ps.median_price * 1.10) AS elevated_count,
             COALESCE((SELECT MAX(s.verified) FROM suppliers s WHERE s.inn = i.supplier_inn), 0) AS supplier_verified,
             (SELECT COUNT(*) FROM approval_requests ar
               WHERE ar.invoice_id = i.id AND ar.status = 'pending') AS pending_approvals
             ,(SELECT COUNT(*) FROM approval_requests ar
                WHERE ar.invoice_id = i.id AND ar.execution_error IS NOT NULL) AS failed_approvals
        FROM invoices i
       WHERE ${owner.clause}
         AND (
           i.status IN ('error', 'failed', 'duplicate') OR i.duplicate_of IS NOT NULL OR
           COALESCE(i.items_total_mismatch, 0) = 1 OR
           EXISTS (SELECT 1 FROM invoice_items x WHERE x.invoice_id = i.id AND (x.onec_guid IS NULL OR x.onec_guid = '')) OR
           EXISTS (SELECT 1 FROM invoice_items x WHERE x.invoice_id = i.id AND COALESCE(x.mapping_confidence, 0) < ?) OR
           EXISTS (SELECT 1 FROM invoice_items x JOIN nomenclature_price_stats ps ON ps.onec_guid = x.onec_guid
                    WHERE x.invoice_id = i.id AND x.price > ps.median_price * 1.10) OR
           EXISTS (SELECT 1 FROM approval_requests ar WHERE ar.invoice_id = i.id AND ar.status = 'pending') OR
           EXISTS (SELECT 1 FROM approval_requests ar WHERE ar.invoice_id = i.id AND ar.execution_error IS NOT NULL) OR
           i.onec_status IN ('error', 'rejected') OR
           (? = 1 AND NOT EXISTS (SELECT 1 FROM suppliers s WHERE s.inn = i.supplier_inn AND s.verified = 1))
         )
       ORDER BY i.created_at DESC
       LIMIT 200
    `).all<ExceptionRow>(...owner.params, minConfidence, requireVerified ? 1 : 0);
  },

  async reconciliation(ownerUserId: number | null): Promise<ReconciliationRow[]> {
    const owner = ownerSql('i', ownerUserId);
    return getDb().prepare(`
      SELECT i.id AS invoice_id, i.invoice_number, i.invoice_date, i.supplier,
             i.total_sum, sp.id AS payment_id, sp.status AS payment_status,
             sp.amount AS payment_amount, sp.sber_payment_number AS payment_number,
             sp.created_at AS payment_created_at,
             bs.id AS statement_id, bs.operation_date AS statement_date,
             bs.amount AS statement_amount, bs.purpose AS statement_purpose,
             bs.match_score AS statement_match_score,
             COALESCE(s.payment_terms_days, 7) AS payment_terms_days,
             COALESCE(DATE_FORMAT(i.payment_due_date, '%Y-%m-%d'),
               CASE WHEN i.invoice_date REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                    THEN DATE_FORMAT(DATE_ADD(STR_TO_DATE(i.invoice_date, '%Y-%m-%d'), INTERVAL COALESCE(s.payment_terms_days, 7) DAY), '%Y-%m-%d')
                    ELSE NULL END) AS due_date,
             i.payment_priority, i.payment_hold_reason
        FROM invoices i
        LEFT JOIN sber_payments sp ON sp.invoice_id = i.id
        LEFT JOIN bank_statement_entries bs ON bs.id = (
          SELECT MAX(bx.id) FROM bank_statement_entries bx WHERE bx.matched_invoice_id = i.id
        )
        LEFT JOIN suppliers s ON s.inn = i.supplier_inn
       WHERE ${owner.clause}
         AND i.status NOT IN ('failed', 'error', 'duplicate')
         AND i.duplicate_of IS NULL
       ORDER BY COALESCE(bs.operation_date, sp.created_at, i.created_at) DESC
       LIMIT 200
    `).all<ReconciliationRow>(...owner.params);
  },

  async supplierScores(ownerUserId: number | null): Promise<SupplierScoreRow[]> {
    const owner = ownerSql('i', ownerUserId);
    const rows = await getDb().prepare(`
      SELECT COALESCE(NULLIF(i.supplier_inn, ''), CONCAT('name:', LOWER(COALESCE(i.supplier, 'unknown')))) AS supplier_key,
             MAX(i.supplier_inn) AS supplier_inn,
             MAX(COALESCE(s.name, i.supplier, 'Без поставщика')) AS supplier,
             MAX(COALESCE(s.verified, 0)) AS verified,
             MAX(COALESCE(s.payment_terms_days, 7)) AS payment_terms_days,
             MAX(s.verification_risk) AS verification_risk,
             COUNT(*) AS invoices,
             COALESCE(SUM(i.total_sum), 0) AS total_spend,
             COALESCE(AVG(i.total_sum), 0) AS avg_invoice,
             SUM(CASE WHEN i.status IN ('error', 'failed') THEN 1 ELSE 0 END) AS errors,
             SUM(CASE WHEN i.duplicate_of IS NOT NULL OR i.status = 'duplicate' THEN 1 ELSE 0 END) AS duplicates,
             SUM(COALESCE(i.items_total_mismatch, 0)) AS mismatches,
             SUM((SELECT COUNT(*) FROM invoice_items x
                    JOIN nomenclature_price_stats ps ON ps.onec_guid = x.onec_guid
                   WHERE x.invoice_id = i.id AND x.price > ps.median_price * 1.10)) AS elevated_prices,
             SUM(CASE WHEN sp.id IS NOT NULL OR bs.id IS NOT NULL THEN 1 ELSE 0 END) AS payments,
             SUM(CASE WHEN i.invoice_date REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                            AND DATE_ADD(STR_TO_DATE(i.invoice_date, '%Y-%m-%d'), INTERVAL COALESCE(s.payment_terms_days, 7) DAY) < CURDATE()
                            AND bs.id IS NULL
                            AND (sp.id IS NULL OR LOWER(sp.status) NOT IN ('paid', 'executed', 'completed', 'success'))
                      THEN 1 ELSE 0 END) AS overdue,
             MAX(i.created_at) AS last_invoice_at
        FROM invoices i
        LEFT JOIN suppliers s ON s.inn = i.supplier_inn
        LEFT JOIN sber_payments sp ON sp.invoice_id = i.id
        LEFT JOIN bank_statement_entries bs ON bs.id = (
          SELECT MAX(bx.id) FROM bank_statement_entries bx WHERE bx.matched_invoice_id = i.id
        )
       WHERE ${owner.clause} AND i.supplier IS NOT NULL
       GROUP BY supplier_key
       ORDER BY total_spend DESC
       LIMIT 100
    `).all<SupplierScoreRow>(...owner.params);
    return rows.map((row) => {
      const denominator = Math.max(1, Number(row.invoices));
      const penalty = (Number(row.errors) / denominator) * 30
        + (Number(row.duplicates) / denominator) * 15
        + (Number(row.mismatches) / denominator) * 20
        + Math.min(15, (Number(row.elevated_prices) / denominator) * 10)
        + (Number(row.overdue) / denominator) * 25
        + (row.verified ? 0 : 10);
      return { ...row, score: Math.max(0, Math.round(100 - penalty)) };
    });
  },

  async forecast(ownerUserId: number | null): Promise<{
    overdue: number; days7: number; days30: number; days90: number; later: number;
    outstanding: number; historicalMonthly: number;
  }> {
    const owner = ownerSql('i', ownerUserId);
    const row = await getDb().prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN due_date < CURDATE() THEN total_sum ELSE 0 END), 0) AS overdue,
        COALESCE(SUM(CASE WHEN due_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY) THEN total_sum ELSE 0 END), 0) AS days7,
        COALESCE(SUM(CASE WHEN due_date > DATE_ADD(CURDATE(), INTERVAL 7 DAY) AND due_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY) THEN total_sum ELSE 0 END), 0) AS days30,
        COALESCE(SUM(CASE WHEN due_date > DATE_ADD(CURDATE(), INTERVAL 30 DAY) AND due_date <= DATE_ADD(CURDATE(), INTERVAL 90 DAY) THEN total_sum ELSE 0 END), 0) AS days90,
        COALESCE(SUM(CASE WHEN due_date > DATE_ADD(CURDATE(), INTERVAL 90 DAY) OR due_date IS NULL THEN total_sum ELSE 0 END), 0) AS later,
        COALESCE(SUM(total_sum), 0) AS outstanding
      FROM (
        SELECT i.total_sum,
               COALESCE(i.payment_due_date,
                 CASE WHEN i.invoice_date REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                      THEN DATE_ADD(STR_TO_DATE(i.invoice_date, '%Y-%m-%d'), INTERVAL COALESCE(s.payment_terms_days, 7) DAY)
                      ELSE NULL END) AS due_date
          FROM invoices i
          LEFT JOIN suppliers s ON s.inn = i.supplier_inn
          LEFT JOIN sber_payments sp ON sp.invoice_id = i.id
         WHERE ${owner.clause}
           AND i.status NOT IN ('failed', 'error', 'duplicate')
           AND i.duplicate_of IS NULL
           AND i.total_sum IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM bank_statement_entries bs WHERE bs.matched_invoice_id = i.id)
           AND (sp.id IS NULL OR LOWER(sp.status) NOT IN ('paid', 'executed', 'completed', 'success'))
      ) obligations
    `).get<{ overdue: number; days7: number; days30: number; days90: number; later: number; outstanding: number }>(...owner.params);
    const historical = await getDb().prepare(`
      SELECT COALESCE(SUM(i.total_sum) / 3, 0) AS monthly
        FROM invoices i
       WHERE ${owner.clause}
         AND i.created_at >= DATE_SUB(NOW(), INTERVAL 90 DAY)
         AND i.status NOT IN ('failed', 'error', 'duplicate')
         AND i.duplicate_of IS NULL
    `).get<{ monthly: number }>(...owner.params);
    return { ...(row ?? { overdue: 0, days7: 0, days30: 0, days90: 0, later: 0, outstanding: 0 }), historicalMonthly: historical?.monthly ?? 0 };
  },

  async calendar(ownerUserId: number | null, cashBalance: number | null): Promise<{
    rows: PaymentCalendarRow[];
    held: { invoices: number; amount: number };
    available_cash: number | null;
  }> {
    const owner = ownerSql('i', ownerUserId);
    const obligations = await getDb().prepare(`
      SELECT i.id, i.total_sum, i.payment_hold_reason,
             COALESCE(DATE_FORMAT(i.payment_due_date, '%Y-%m-%d'),
               CASE WHEN i.invoice_date REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                    THEN DATE_FORMAT(DATE_ADD(STR_TO_DATE(i.invoice_date, '%Y-%m-%d'), INTERVAL COALESCE(s.payment_terms_days, 7) DAY), '%Y-%m-%d')
                    ELSE NULL END) AS due_date
        FROM invoices i
        LEFT JOIN suppliers s ON s.inn = i.supplier_inn
        LEFT JOIN sber_payments sp ON sp.invoice_id = i.id
       WHERE ${owner.clause}
         AND i.status NOT IN ('failed', 'error', 'duplicate') AND i.duplicate_of IS NULL
         AND i.total_sum IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM bank_statement_entries bs WHERE bs.matched_invoice_id = i.id)
         AND (sp.id IS NULL OR LOWER(sp.status) NOT IN ('paid', 'executed', 'completed', 'success'))
       ORDER BY due_date
    `).all<{ id: number; total_sum: number; payment_hold_reason: string | null; due_date: string | null }>(...owner.params);
    const heldRows = obligations.filter(row => !!row.payment_hold_reason);
    const buckets = new Map<string, { invoices: number; amount: number }>();
    for (const row of obligations.filter(item => !item.payment_hold_reason)) {
      const key = row.due_date || 'Без даты';
      const bucket = buckets.get(key) || { invoices: 0, amount: 0 };
      bucket.invoices++;
      bucket.amount += Number(row.total_sum || 0);
      buckets.set(key, bucket);
    }
    const today = new Date().toISOString().slice(0, 10);
    let cumulative = 0;
    const rows = [...buckets.entries()]
      .sort(([a], [b]) => a === 'Без даты' ? 1 : b === 'Без даты' ? -1 : a.localeCompare(b))
      .map(([date, bucket]) => {
        cumulative += bucket.amount;
        const projected = cashBalance == null ? null : cashBalance - cumulative;
        return {
          date: date === 'Без даты' ? null : date,
          invoices: bucket.invoices,
          amount: bucket.amount,
          cumulative,
          projected_balance: projected,
          cash_gap: projected != null && projected < 0 ? Math.abs(projected) : 0,
          overdue: date !== 'Без даты' && date < today,
        };
      });
    return {
      rows,
      held: { invoices: heldRows.length, amount: heldRows.reduce((sum, row) => sum + Number(row.total_sum || 0), 0) },
      available_cash: cashBalance,
    };
  },

  async reports(ownerUserId: number | null): Promise<{
    monthly_spend: Array<{ period: string; invoices: number; amount: number }>;
    document_types: Array<{ document_type: string; invoices: number; amount: number }>;
    bank_coverage: { total: number; reconciled: number; coverage_percent: number };
  }> {
    const owner = ownerSql('i', ownerUserId);
    const monthly = await getDb().prepare(`
      SELECT DATE_FORMAT(COALESCE(STR_TO_DATE(NULLIF(i.invoice_date, ''), '%Y-%m-%d'), i.created_at), '%Y-%m') AS period,
             COUNT(*) AS invoices, COALESCE(SUM(i.total_sum), 0) AS amount
        FROM invoices i
       WHERE ${owner.clause} AND i.status NOT IN ('error', 'failed', 'duplicate')
         AND i.duplicate_of IS NULL
       GROUP BY period ORDER BY period DESC LIMIT 12
    `).all<{ period: string; invoices: number; amount: number }>(...owner.params);
    const documentTypes = await getDb().prepare(`
      SELECT COALESCE(NULLIF(i.invoice_type, ''), 'не определён') AS document_type,
             COUNT(*) AS invoices, COALESCE(SUM(i.total_sum), 0) AS amount
        FROM invoices i
       WHERE ${owner.clause} AND i.status NOT IN ('error', 'failed', 'duplicate')
         AND i.duplicate_of IS NULL
       GROUP BY document_type ORDER BY invoices DESC
    `).all<{ document_type: string; invoices: number; amount: number }>(...owner.params);
    const coverage = await getDb().prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN EXISTS (SELECT 1 FROM bank_statement_entries bs WHERE bs.matched_invoice_id = i.id)
                       OR EXISTS (SELECT 1 FROM sber_payments sp WHERE sp.invoice_id = i.id AND LOWER(sp.status) IN ('paid','executed','completed','success'))
                      THEN 1 ELSE 0 END) AS reconciled
        FROM invoices i
       WHERE ${owner.clause} AND i.status NOT IN ('error', 'failed', 'duplicate') AND i.duplicate_of IS NULL
    `).get<{ total: number; reconciled: number }>(...owner.params);
    const total = Number(coverage?.total || 0);
    const reconciled = Number(coverage?.reconciled || 0);
    return {
      monthly_spend: monthly,
      document_types: documentTypes,
      bank_coverage: { total, reconciled, coverage_percent: total ? Math.round(reconciled / total * 100) : 0 },
    };
  },
};
