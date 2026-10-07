import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';

// Модель подменена на уровне шлюза: проверяем, как распознавание обращается с ответами и ошибками.
const h = vi.hoisted(() => ({ structured: vi.fn(), text: vi.fn() }));
vi.mock('../../src/ai/gateway', () => ({ aiStructured: h.structured, aiText: h.text }));
vi.mock('../../src/services/engineFlags', () => ({ getEngineFlags: vi.fn(async () => ({ row_pairing: false })) }));

import { analyzeImageWithVerification, mapItemsWithAi, detectOrientation } from '../../src/ocr/claudeApiAnalyzer';
import { AiUnavailableError } from '../../src/ai/errors';
import type { AiTarget } from '../../src/ai/types';

const GPT: AiTarget = { engine: 'gpt', model: 'gpt-6.1-sol', apiKey: null };
let dir: string;
let photo: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-analyzer-'));
  photo = path.join(dir, 'page.jpg');
  await sharp({ create: { width: 60, height: 80, channels: 3, background: '#ffffff' } }).jpeg().toFile(photo);
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
beforeEach(() => vi.resetAllMocks());

const reading = (over: Record<string, unknown> = {}) => JSON.stringify({
  invoice_type: 'торг_12', invoice_number: '1', invoice_date: '2026-10-01', supplier: 'ООО Ромашка',
  supplier_inn: null, supplier_kpp: null, total_sum: 100, vat_sum: null,
  items: [{ name: 'Хлеб', quantity: 2, unit: 'шт', price: 50, total: 100, vat_rate: null, row_no: 1, pack_size: null }],
  ...over,
});

describe('распознавание через шлюз', () => {
  it('картинка уходит в шлюз с моделью из target и схемой invoice', async () => {
    h.structured.mockResolvedValue({ text: reading(), truncated: false });
    const r = await analyzeImageWithVerification(photo, GPT);
    expect(r.success).toBe(true);
    const req = h.structured.mock.calls[0][0];
    expect(req.target).toBe(GPT);
    expect(req.schemaName).toBe('invoice');
    expect(req.content[0]).toMatchObject({ type: 'image', mediaType: 'image/jpeg' });
  });

  it('модель недоступна — AiUnavailableError наружу (накладная будет ждать), а не {success:false}', async () => {
    h.structured.mockRejectedValue(new AiUnavailableError('rate_limited', Date.now() + 60_000));
    await expect(analyzeImageWithVerification(photo, GPT)).rejects.toBeInstanceOf(AiUnavailableError);
  });

  it('прочая ошибка модели — {success:false} с текстом', async () => {
    h.structured.mockRejectedValue(new Error('ChatGPT 400: bad'));
    const r = await analyzeImageWithVerification(photo, GPT);
    expect(r).toMatchObject({ success: false });
    expect(r.error).toContain('ChatGPT 400: bad');
  });

  it('модель пропала перед до-чтением — остаётся первое чтение', async () => {
    // Σ строк 100 ≠ итог 999 → проверка просит до-чтение, а модель уже недоступна.
    h.structured
      .mockResolvedValueOnce({ text: reading({ total_sum: 999 }), truncated: false })
      .mockRejectedValueOnce(new AiUnavailableError('network', null));
    const r = await analyzeImageWithVerification(photo, GPT);
    expect(r.success).toBe(true);
    expect(r.data?.total_sum).toBe(999);
    expect(h.structured).toHaveBeenCalledTimes(2);
  });

  it('PDF до анализатора не доходит — понятная ошибка, модель не вызывается', async () => {
    const pdf = path.join(dir, 'doc.pdf');
    fs.writeFileSync(pdf, '%PDF-1.4');
    const r = await analyzeImageWithVerification(pdf, GPT);
    expect(r.success).toBe(false);
    expect(r.error).toContain('PDF');
    expect(h.structured).not.toHaveBeenCalled();
  });
});

describe('mapItemsWithAi', () => {
  const catalog = [{ guid: 'g1', name: 'Хлеб', unit: 'шт' }, { guid: 'g2', name: 'Мука', unit: 'кг' }];

  it('ответ по схеме matches → позиции каталога; упаковка без единицы → «шт»', async () => {
    h.structured.mockResolvedValue({
      text: JSON.stringify({ matches: [
        { key: 'a', catalog_idx: 1, pack_size: null, unit_override: null },
        { key: 'b', catalog_idx: 2, pack_size: 50, unit_override: null },
        { key: 'c', catalog_idx: null, pack_size: null, unit_override: null },
      ] }),
      truncated: false,
    });
    const r = await mapItemsWithAi([{ key: 'a', name: 'Хлеб' }, { key: 'b', name: 'Мука (50кг)' }, { key: 'c', name: 'Что-то' }], catalog, GPT);
    expect(r.success).toBe(true);
    expect(r.matched?.get('a')).toMatchObject({ guid: 'g1', pack_size: null, unit_override: null });
    expect(r.matched?.get('b')).toMatchObject({ guid: 'g2', pack_size: 50, unit_override: 'шт' });
    expect(r.matched?.has('c')).toBe(false);
    expect(h.structured.mock.calls[0][0]).toMatchObject({ target: GPT, schemaName: 'matches' });
  });

  it('модель недоступна — исключение наружу', async () => {
    h.structured.mockRejectedValue(new AiUnavailableError('reauth_required', null));
    await expect(mapItemsWithAi([{ key: 'a', name: 'Хлеб' }], catalog, GPT)).rejects.toBeInstanceOf(AiUnavailableError);
  });
});

describe('detectOrientation', () => {
  const previews: [string, string, string, string] = ['AAA', 'BBB', 'CCC', 'DDD'];

  it('ответ «2» → 90°, картинки в низкой детализации', async () => {
    h.text.mockResolvedValue({ text: '2', truncated: false });
    expect(await detectOrientation(previews, GPT)).toBe(90);
    expect(h.text.mock.calls[0][0]).toMatchObject({ imageDetail: 'low', effort: 'low' });
  });

  it('сбой дважды → 0 (без поворота); недоступность — наружу', async () => {
    h.text.mockRejectedValue(new Error('timeout'));
    expect(await detectOrientation(previews, GPT)).toBe(0);
    expect(h.text).toHaveBeenCalledTimes(2);
    h.text.mockReset();
    h.text.mockRejectedValue(new AiUnavailableError('not_connected', null));
    await expect(detectOrientation(previews, GPT)).rejects.toBeInstanceOf(AiUnavailableError);
  });
});
