import { getDb } from '../db';

export interface AutomationSettings {
  auto_send_1c: boolean;
  auto_send_sber: boolean;
  require_all_mapped: boolean;
  block_total_mismatch: boolean;
  min_mapping_confidence: number;
  max_total: number | null;
  require_verified_supplier: boolean;
  payment_approval_threshold: number | null;
}

interface AutomationRow {
  auto_send_1c: number | null;
  auto_send_sber: number | null;
  auto_require_all_mapped: number | null;
  auto_block_total_mismatch: number | null;
  auto_min_mapping_confidence: number | null;
  auto_max_total: number | null;
  auto_require_verified_supplier: number | null;
  payment_approval_threshold: number | null;
}

export const automationRepo = {
  async get(): Promise<AutomationSettings> {
    const row = await getDb().prepare(`
      SELECT auto_send_1c, auto_send_sber,
             auto_require_all_mapped, auto_block_total_mismatch,
             auto_min_mapping_confidence, auto_max_total,
             auto_require_verified_supplier, payment_approval_threshold
        FROM analyzer_config WHERE id = 1
    `).get<AutomationRow>();
    return {
      auto_send_1c: row?.auto_send_1c === 1,
      auto_send_sber: row?.auto_send_sber === 1,
      require_all_mapped: (row?.auto_require_all_mapped ?? 1) === 1,
      block_total_mismatch: (row?.auto_block_total_mismatch ?? 1) === 1,
      min_mapping_confidence: Math.max(0, Math.min(1, row?.auto_min_mapping_confidence ?? 0.8)),
      max_total: row?.auto_max_total && row.auto_max_total > 0 ? row.auto_max_total : null,
      require_verified_supplier: (row?.auto_require_verified_supplier ?? 1) === 1,
      payment_approval_threshold: row?.payment_approval_threshold && row.payment_approval_threshold > 0
        ? row.payment_approval_threshold
        : null,
    };
  },

  async update(patch: Partial<AutomationSettings>): Promise<AutomationSettings> {
    const columns: Record<keyof AutomationSettings, string> = {
      auto_send_1c: 'auto_send_1c',
      auto_send_sber: 'auto_send_sber',
      require_all_mapped: 'auto_require_all_mapped',
      block_total_mismatch: 'auto_block_total_mismatch',
      min_mapping_confidence: 'auto_min_mapping_confidence',
      max_total: 'auto_max_total',
      require_verified_supplier: 'auto_require_verified_supplier',
      payment_approval_threshold: 'payment_approval_threshold',
    };
    const booleanKeys = new Set<keyof AutomationSettings>([
      'auto_send_1c', 'auto_send_sber', 'require_all_mapped',
      'block_total_mismatch', 'require_verified_supplier',
    ]);
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const key of Object.keys(patch) as Array<keyof AutomationSettings>) {
      if (!(key in columns) || patch[key] === undefined) continue;
      sets.push(`${columns[key]} = ?`);
      values.push(booleanKeys.has(key) ? (patch[key] ? 1 : 0) : patch[key]);
    }
    if (sets.length > 0) {
      await getDb().prepare(`UPDATE analyzer_config SET ${sets.join(', ')} WHERE id = 1`).run(...values);
    }
    return this.get();
  },
};
