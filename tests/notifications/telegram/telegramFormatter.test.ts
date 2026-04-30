import { describe, it, expect } from 'vitest';
import {
  buildInvoiceThread,
  buildUrgentMessage,
  deriveEventState,
  type EventState,
} from '../../../src/notifications/telegram/telegramFormatter';
import type { Invoice } from '../../../src/database/repositories/invoiceRepo';

const NBSP = String.fromCharCode(160);

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 85,
    file_name: 'photo.jpg',
    file_path: '/data/photo.jpg',
    invoice_number: 'НФНФ-000085',
    invoice_date: '2026-04-25',
    supplier: 'Свит лайф фудсервис',
    total_sum: 66714.11,
    invoice_type: 'торг_12',
    supplier_inn: null,
    supplier_bik: null,
    supplier_account: null,
    supplier_corr_account: null,
    supplier_address: null,
    vat_sum: null,
    raw_text: null,
    status: 'processed',
    ocr_engine: null,
    error_message: null,
    created_at: '2026-04-29 11:13:00',
    sent_at: null,
    approved_for_1c: 0,
    approved_at: null,
    file_hash: null,
    items_total_mismatch: 0,
    telegram_message_id: null,
    ...overrides,
  };
}

describe('buildInvoiceThread', () => {
  it('shows pending state for unprocessed invoice', () => {
    const inv = makeInvoice({ status: 'parsing' });
    const state: EventState = {
      photo_uploaded: new Date('2026-04-29T11:13:00Z'),
      invoice_recognized: null,
      approved_for_1c: null,
      sent_to_1c: null,
    };
    const text = buildInvoiceThread(inv, state);
    expect(text).toContain('📄 Накладная № НФНФ-000085');
    expect(text).toContain('Свит лайф фудсервис');
    expect(text).toContain(`66${NBSP}714,11 ₽`);
    expect(text).toContain('✅ Загружена');
    expect(text).toContain('⏳ Распознана');
    expect(text).toContain('⏳ Утверждена');
    expect(text).toContain('⏳ Отправлена в 1С');
  });

  it('shows all steps complete when invoice is sent', () => {
    const inv = makeInvoice({ status: 'sent_to_1c', approved_at: '2026-04-29 11:18:00', sent_at: '2026-04-29 11:20:00' });
    const state: EventState = {
      photo_uploaded: new Date('2026-04-29T11:13:00Z'),
      invoice_recognized: new Date('2026-04-29T11:14:00Z'),
      approved_for_1c: new Date('2026-04-29T11:18:00Z'),
      sent_to_1c: new Date('2026-04-29T11:20:00Z'),
    };
    const text = buildInvoiceThread(inv, state);
    expect(text.match(/✅/g)?.length).toBe(4);
    expect(text).not.toContain('⏳');
  });

  it('falls back to #id when invoice_number is missing', () => {
    const inv = makeInvoice({ invoice_number: null });
    const state = deriveEventState(inv);
    const text = buildInvoiceThread(inv, state);
    expect(text).toContain('Накладная № #85');
  });
});

describe('buildUrgentMessage', () => {
  it('builds recognition_error message with error_message', () => {
    const text = buildUrgentMessage('recognition_error', {
      invoice_id: 1,
      invoice_number: '85',
      supplier: 'X',
      total_sum: 1000,
      error_message: 'Claude API timeout',
    });
    expect(text).toContain('🚨 Ошибка распознавания');
    expect(text).toContain('Накладная: 85');
    expect(text).toContain('Claude API timeout');
  });

  it('builds suspicious_total with both totals', () => {
    const text = buildUrgentMessage('suspicious_total', {
      invoice_id: 1,
      invoice_number: '85',
      supplier: 'Y',
      total_sum: 1000,
      items_total: 980,
    });
    expect(text).toContain('⚠️ Подозрительная сумма');
    expect(text).toContain(`1${NBSP}000,00 ₽`);
    expect(text).toContain('980,00 ₽');
  });

  it('omits items_total line when not provided', () => {
    const text = buildUrgentMessage('suspicious_total', {
      invoice_id: 1,
      invoice_number: '85',
      supplier: 'Y',
      total_sum: 1000,
    });
    expect(text).not.toContain('Сумма строк');
  });

  it('shows "без описания" when error_message missing', () => {
    const text = buildUrgentMessage('recognition_error', {
      invoice_id: 1,
      invoice_number: '85',
      supplier: 'X',
      total_sum: 1000,
    });
    expect(text).toContain('без описания');
  });
});

describe('deriveEventState', () => {
  it('returns null for everything pending when invoice is parsing', () => {
    const inv = makeInvoice({ status: 'parsing', approved_at: null, sent_at: null });
    const state = deriveEventState(inv);
    expect(state.photo_uploaded).toBeInstanceOf(Date);
    expect(state.invoice_recognized).toBeNull();
    expect(state.approved_for_1c).toBeNull();
    expect(state.sent_to_1c).toBeNull();
  });

  it('marks recognized when status is processed', () => {
    const inv = makeInvoice({ status: 'processed' });
    const state = deriveEventState(inv);
    expect(state.invoice_recognized).toBeInstanceOf(Date);
  });

  it('marks all four steps when sent', () => {
    const inv = makeInvoice({
      status: 'sent_to_1c',
      approved_at: '2026-04-29 11:18:00',
      sent_at: '2026-04-29 11:20:00',
    });
    const state = deriveEventState(inv);
    expect(state.photo_uploaded).toBeInstanceOf(Date);
    expect(state.invoice_recognized).toBeInstanceOf(Date);
    expect(state.approved_for_1c).toBeInstanceOf(Date);
    expect(state.sent_to_1c).toBeInstanceOf(Date);
  });
});
