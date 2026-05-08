import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { resetDb } from '../helpers/db';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';
import { onecNomenclatureRepo } from '../../src/database/repositories/onecNomenclatureRepo';
import { getDb } from '../../src/database/db';

// Mock the Claude API caller — we drive its return shape per-test.
vi.mock('../../src/ocr/claudeApiAnalyzer', async () => {
  const actual = await vi.importActual<typeof import('../../src/ocr/claudeApiAnalyzer')>('../../src/ocr/claudeApiAnalyzer');
  return {
    ...actual,
    mapItemsWithClaudeApi: vi.fn(),
  };
});

import invoicesRouter from '../../src/api/routes/invoices';
import { mapItemsWithClaudeApi } from '../../src/ocr/claudeApiAnalyzer';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/invoices', invoicesRouter);
  return app;
}

function seedCatalog() {
  // 1С-карточка для муки: kg-tracked, weighted product
  onecNomenclatureRepo.bulkUpsert([{
    guid: 'guid-mука',
    code: 'НФ-1',
    name: 'Мука пшеничная в\\с',
    unit: 'кг',
    is_weighted: true,
  }]);
  // Поставить ANTHROPIC_API_KEY чтобы /llm-remap не вернул 500
  getDb().prepare(
    `UPDATE analyzer_config SET anthropic_api_key = 'test-key' WHERE id = 1`,
  ).run();
}

describe('POST /api/invoices/:id/llm-remap — pack-transform on freshly mapped item', () => {
  beforeEach(() => {
    resetDb();
    seedCatalog();
    vi.mocked(mapItemsWithClaudeApi).mockReset();
  });

  it('REGRESSION: "Мука (50кг)" qty=1 шт maps to kg-tracked card AND gets pack-transformed via regex even when LLM returns pack_size=null', async () => {
    // Arrange: invoice with one unmapped item
    const inv = invoiceRepo.create({
      file_name: 'a.jpg',
      file_path: '/a.jpg',
      total_sum: 1900,
    });
    const item = invoiceRepo.addItem({
      invoice_id: inv.id,
      original_name: 'Мука (50кг)',
      quantity: 1,
      unit: 'шт',
      price: 1900,
      total: 1900,
    });

    // LLM returns a hit but WITHOUT pack_size — this is the real-world case
    // where the prompt didn't trigger pack hint extraction for "(50кг)" paren
    vi.mocked(mapItemsWithClaudeApi).mockResolvedValue({
      success: true,
      matched: new Map([
        [String(item.id), {
          guid: 'guid-mука',
          name: 'Мука пшеничная в\\с',
          confidence: 1.0,
          pack_size: null,
          unit_override: null,
        }],
      ]),
    });

    // Act
    const res = await request(makeApp()).post(`/api/invoices/${inv.id}/llm-remap`);

    // Assert: item now reflects 50kg × 38r = 1900r (not 1 шт × 1900r)
    expect(res.status).toBe(200);
    const reloaded = invoiceRepo.getItems(inv.id)[0];
    expect(reloaded.unit).toBe('кг');
    expect(reloaded.quantity).toBe(50);
    expect(reloaded.price).toBe(38);
    expect(reloaded.total).toBe(1900);
    expect(reloaded.onec_guid).toBe('guid-mука');
  });

  it('does NOT re-apply pack-transform on already-mapped items with no guid change', async () => {
    // Arrange: invoice item already mapped + already pack-transformed
    const inv = invoiceRepo.create({
      file_name: 'a.jpg',
      file_path: '/a.jpg',
      total_sum: 1900,
    });
    const item = invoiceRepo.addItem({
      invoice_id: inv.id,
      original_name: 'Мука (50кг)',
      quantity: 50,                     // already in kg
      unit: 'кг',
      price: 38,
      total: 1900,
      onec_guid: 'guid-mука',
      mapped_name: 'Мука пшеничная в\\с',
      mapping_confidence: 1.0,
    });

    // LLM returns same guid — wasUnmapped=false, guidChanged=false, canRepack=false
    vi.mocked(mapItemsWithClaudeApi).mockResolvedValue({
      success: true,
      matched: new Map([
        [String(item.id), {
          guid: 'guid-mука',
          name: 'Мука пшеничная в\\с',
          confidence: 1.0,
          pack_size: null,
          unit_override: null,
        }],
      ]),
    });

    const res = await request(makeApp()).post(`/api/invoices/${inv.id}/llm-remap?all=true`);

    expect(res.status).toBe(200);
    const reloaded = invoiceRepo.getItems(inv.id)[0];
    // Quantity must stay 50kg — NOT multiply again to 2500 or similar
    expect(reloaded.quantity).toBe(50);
    expect(reloaded.unit).toBe('кг');
  });
});
