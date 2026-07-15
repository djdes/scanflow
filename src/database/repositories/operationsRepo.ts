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
  payment_terms_days: number;
  due_date: string | null;
}

export interface SupplierScoreRow {
  supplier_key: string;
  supplier_inn: string | null;
  supplier: string;
  verified: number;
  payment_terms_days: number;
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
      SELECT i.id, i.invoice_number, i.invoice_date, i.supplier, i.total_sum,
             i.status, i.duplicate_of, i.duplicate_score, i.duplicate_reasons,
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
             COALESCE(s.payment_terms_days, 7) AS payment_terms_days,
             CASE WHEN i.invoice_date REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                  THEN DATE_FORMAT(DATE_ADD(STR_TO_DATE(i.invoice_date, '%Y-%m-%d'), INTERVAL COALESCE(s.payment_terms_days, 7) DAY), '%Y-%m-%d')
                  ELSE NULL END AS due_date
        FROM invoices i
        LEFT JOIN sber_payments sp ON sp.invoice_id = i.id
        LEFT JOIN suppliers s ON s.inn = i.supplier_inn
       WHERE ${owner.clause}
         AND i.status NOT IN ('failed', 'error', 'duplicate')
         AND i.duplicate_of IS NULL
       ORDER BY COALESCE(sp.created_at, i.created_at) DESC
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
             COUNT(*) AS invoices,
             COALESCE(SUM(i.total_sum), 0) AS total_spend,
             COALESCE(AVG(i.total_sum), 0) AS avg_invoice,
             SUM(CASE WHEN i.status IN ('error', 'failed') THEN 1 ELSE 0 END) AS errors,
             SUM(CASE WHEN i.duplicate_of IS NOT NULL OR i.status = 'duplicate' THEN 1 ELSE 0 END) AS duplicates,
             SUM(COALESCE(i.items_total_mismatch, 0)) AS mismatches,
             SUM((SELECT COUNT(*) FROM invoice_items x
                    JOIN nomenclature_price_stats ps ON ps.onec_guid = x.onec_guid
                   WHERE x.invoice_id = i.id AND x.price > ps.median_price * 1.10)) AS elevated_prices,
             SUM(CASE WHEN sp.id IS NOT NULL THEN 1 ELSE 0 END) AS payments,
             SUM(CASE WHEN i.invoice_date REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                            AND DATE_ADD(STR_TO_DATE(i.invoice_date, '%Y-%m-%d'), INTERVAL COALESCE(s.payment_terms_days, 7) DAY) < CURDATE()
                            AND (sp.id IS NULL OR LOWER(sp.status) NOT IN ('paid', 'executed', 'completed', 'success'))
                      THEN 1 ELSE 0 END) AS overdue,
             MAX(i.created_at) AS last_invoice_at
        FROM invoices i
        LEFT JOIN suppliers s ON s.inn = i.supplier_inn
        LEFT JOIN sber_payments sp ON sp.invoice_id = i.id
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
               CASE WHEN i.invoice_date REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                    THEN DATE_ADD(STR_TO_DATE(i.invoice_date, '%Y-%m-%d'), INTERVAL COALESCE(s.payment_terms_days, 7) DAY)
                    ELSE NULL END AS due_date
          FROM invoices i
          LEFT JOIN suppliers s ON s.inn = i.supplier_inn
          LEFT JOIN sber_payments sp ON sp.invoice_id = i.id
         WHERE ${owner.clause}
           AND i.status NOT IN ('failed', 'error', 'duplicate')
           AND i.duplicate_of IS NULL
           AND i.total_sum IS NOT NULL
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
};
