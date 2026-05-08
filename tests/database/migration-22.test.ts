import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from '../helpers/db';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';
import { getDb } from '../../src/database/db';

describe('migration 22 — auto_send flags in analyzer_config', () => {
  beforeEach(() => resetDb());

  it('auto_send_1c and auto_send_sber columns exist with default 0', () => {
    const cols = getDb().prepare(`PRAGMA table_info(analyzer_config)`).all() as Array<{ name: string; dflt_value: string | null }>;
    const auto1c = cols.find(c => c.name === 'auto_send_1c');
    const autoSber = cols.find(c => c.name === 'auto_send_sber');
    expect(auto1c).toBeDefined();
    expect(autoSber).toBeDefined();
    expect(auto1c?.dflt_value).toBe('0');
    expect(autoSber?.dflt_value).toBe('0');
  });

  it('getAnalyzerConfig returns false for auto_send flags by default', () => {
    const cfg = invoiceRepo.getAnalyzerConfig();
    expect(cfg.auto_send_1c).toBe(false);
    expect(cfg.auto_send_sber).toBe(false);
  });

  it('updateAnalyzerConfig persists auto_send flags', () => {
    invoiceRepo.updateAnalyzerConfig('claude_api', undefined, undefined, undefined, true, false);
    let cfg = invoiceRepo.getAnalyzerConfig();
    expect(cfg.auto_send_1c).toBe(true);
    expect(cfg.auto_send_sber).toBe(false);

    invoiceRepo.updateAnalyzerConfig('claude_api', undefined, undefined, undefined, false, true);
    cfg = invoiceRepo.getAnalyzerConfig();
    expect(cfg.auto_send_1c).toBe(false);
    expect(cfg.auto_send_sber).toBe(true);
  });
});
