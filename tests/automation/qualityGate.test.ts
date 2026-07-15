import { describe, expect, it } from 'vitest';
import { evaluateQualitySubject, QualitySubject } from '../../src/automation/qualityGate';
import { AutomationSettings } from '../../src/database/repositories/automationRepo';

const settings: AutomationSettings = {
  auto_send_1c: true,
  auto_send_sber: false,
  require_all_mapped: true,
  block_total_mismatch: true,
  min_mapping_confidence: 0.8,
  max_total: 50000,
  require_verified_supplier: true,
  payment_approval_threshold: 50000,
};

const clean: QualitySubject = {
  status: 'processed', duplicate_of: null, invoice_number: '42', invoice_date: '2026-07-15',
  supplier: 'ООО Тест', total_sum: 1000, items_total_mismatch: 0,
  items_count: 2, unmapped_count: 0, min_confidence: 0.95, supplier_verified: 1,
};

describe('autopilot quality gate', () => {
  it('allows a complete reliable invoice', () => {
    expect(evaluateQualitySubject(clean, settings)).toMatchObject({ allowed: true, score: 100, reasons: [] });
  });

  it('returns explicit blockers instead of silently sending', () => {
    const result = evaluateQualitySubject({
      ...clean, total_sum: 75000, unmapped_count: 1, items_total_mismatch: 1, supplier_verified: 0,
    }, settings);
    expect(result.allowed).toBe(false);
    expect(result.reasons.map(reason => reason.code)).toEqual(expect.arrayContaining([
      'amount_limit', 'unmapped', 'total_mismatch', 'supplier_unverified',
      'approval_required',
    ]));
  });
});
