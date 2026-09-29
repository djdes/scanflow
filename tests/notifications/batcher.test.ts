import { describe, it, expect, vi } from 'vitest';

// Форматтер строит ссылки через config.publicBaseUrl — фиксируем, чтобы тест
// не зависел от .env.
vi.mock('../../src/config', () => ({ config: { publicBaseUrl: 'https://scanflow.ru' } }));

import {
  NotificationBatcher,
  summarizeBatch,
  batchHeadline,
  BATCH_QUIET_MS,
  type BatchEvent,
} from '../../src/notifications/batcher';
import { buildBatchSummaryMessage } from '../../src/notifications/telegram/telegramFormatter';
import { renderBatchSummary } from '../../src/notifications/templates';

const S = 1000;
const MIN = 60 * S;
const U = 7; // получатель

const up = (invoiceId: number): BatchEvent => ({ type: 'photo_uploaded', invoiceId });
const ev = (type: BatchEvent['type'], invoiceId: number, extra: Partial<BatchEvent> = {}): BatchEvent =>
  ({ type, invoiceId, ...extra });

describe('NotificationBatcher — когда включается пакетный режим', () => {
  it('третья загрузка за 2 минуты включает режим; первые две уходят как обычно', () => {
    const b = new NotificationBatcher();
    expect(b.offer(U, up(1), 0)).toBe('send');
    expect(b.offer(U, up(2), 30 * S)).toBe('send');
    expect(b.offer(U, up(3), 2 * MIN)).toBe('start'); // ровно 2 минуты от первой — ещё пачка
    expect(b.isBatching(U)).toBe(true);
    // Дальше всё пакетное копится.
    expect(b.offer(U, up(4), 2 * MIN + S)).toBe('buffer');
    expect(b.offer(U, ev('invoice_recognized', 1), 2 * MIN + 5 * S)).toBe('buffer');
    expect(b.offer(U, ev('elevated_prices', 1), 2 * MIN + 6 * S)).toBe('buffer');
  });

  it('три загрузки, растянутые на 5 минут, — не пачка', () => {
    const b = new NotificationBatcher();
    expect(b.offer(U, up(1), 0)).toBe('send');
    expect(b.offer(U, up(2), 2.5 * MIN)).toBe('send');
    expect(b.offer(U, up(3), 5 * MIN)).toBe('send');
    expect(b.isBatching(U)).toBe(false);
  });

  it('вне пакетного режима распознавание и ошибки уходят как обычно', () => {
    const b = new NotificationBatcher();
    b.offer(U, up(1), 0);
    expect(b.offer(U, ev('invoice_recognized', 1), 40 * S)).toBe('send');
    expect(b.offer(U, ev('recognition_error', 1), 41 * S)).toBe('send');
  });

  it('непакетные события не копятся даже в пакетном режиме', () => {
    const b = new NotificationBatcher();
    [1, 2, 3].forEach((id, i) => b.offer(U, up(id), i * S));
    expect(b.offer(U, ev('approved_for_1c', 1), 10 * S)).toBe('send');
    expect(b.offer(U, ev('sent_to_1c', 1), 11 * S)).toBe('send');
  });

  it('пачка одного получателя не задевает другого', () => {
    const b = new NotificationBatcher();
    [1, 2, 3].forEach((id, i) => b.offer(U, up(id), i * S));
    expect(b.offer(99, up(50), 4 * S)).toBe('send');
    expect(b.offer(99, ev('invoice_recognized', 50), 5 * S)).toBe('send');
    expect(b.isBatching(99)).toBe(false);
  });
});

describe('NotificationBatcher — сводка после 90 секунд тишины', () => {
  it('до 90 с тишины сводку не отдаёт, после — отдаёт один раз и выходит из режима', () => {
    const b = new NotificationBatcher();
    [1, 2, 3].forEach((id, i) => b.offer(U, up(id), i * S));
    b.offer(U, ev('invoice_recognized', 3), 60 * S);

    expect(b.quietDeadline(U)).toBe(60 * S + BATCH_QUIET_MS);
    expect(b.takeIfQuiet(U, 60 * S + BATCH_QUIET_MS - 1)).toBeNull();

    const snap = b.takeIfQuiet(U, 60 * S + BATCH_QUIET_MS);
    expect(snap).not.toBeNull();
    expect(snap!.earlyUploads.map(e => e.invoiceId)).toEqual([1, 2]);
    expect(snap!.events.map(e => [e.type, e.invoiceId])).toEqual([['photo_uploaded', 3], ['invoice_recognized', 3]]);

    expect(b.isBatching(U)).toBe(false);
    expect(b.takeIfQuiet(U, 10 * MIN)).toBeNull();
    // После сводки — снова обычный режим.
    expect(b.offer(U, ev('invoice_recognized', 1), 3 * MIN)).toBe('send');
  });

  it('каждое новое событие продлевает тишину', () => {
    const b = new NotificationBatcher();
    [1, 2, 3].forEach((id, i) => b.offer(U, up(id), i * S));
    b.offer(U, ev('invoice_recognized', 1), 80 * S);
    expect(b.takeIfQuiet(U, 2 * S + BATCH_QUIET_MS)).toBeNull(); // от первой пачки прошло 90 с, от последнего события — нет
    b.offer(U, ev('invoice_recognized', 2), 160 * S);
    expect(b.quietDeadline(U)).toBe(160 * S + BATCH_QUIET_MS);
    expect(b.takeIfQuiet(U, 160 * S + BATCH_QUIET_MS)).not.toBeNull();
  });
});

describe('summarizeBatch — счётчики сводки', () => {
  // 20 фото: 2 ушли поштучно до пачки, 18 — в пачке. Распознано 18, у №775
  // ошибка, у одной накладной сначала ошибка, потом успешное перераспознавание.
  function bigBatch() {
    const earlyUploads = [up(760), up(761)];
    const events: BatchEvent[] = [];
    for (let id = 762; id <= 779; id++) events.push(up(id));
    for (let id = 760; id <= 779; id++) {
      if (id === 775) continue;
      if (id === 776) events.push(ev('recognition_error', 776));
      if (id === 777) continue; // ещё распознаётся
      events.push(ev('invoice_recognized', id, { invoiceNumber: `N-${id}`, supplier: `Поставщик ${id}` }));
    }
    events.push(ev('recognition_error', 775, { supplier: null }));
    events.push(ev('suspicious_total', 764), ev('suspicious_total', 770));
    for (const id of [761, 764, 766, 768]) events.push(ev('elevated_prices', id));
    events.push(ev('elevated_prices', 766)); // повтор — не считается дважды
    return { earlyUploads, events };
  }

  it('считает накладные, а не события; итог — по последнему событию', () => {
    const s = summarizeBatch(bigBatch());
    expect(s.uploaded).toBe(20);
    expect(s.recognized).toBe(18);           // 776 после ошибки распознана
    expect(s.errors.map(e => e.id)).toEqual([775]);
    expect(s.suspicious).toBe(2);
    expect(s.elevated).toBe(4);
    expect(s.deliverable).toBe(true);
    expect(batchHeadline(s)).toBe(
      'Загружено 20 фото: распознано 18, с ошибкой 1 (#775), подозрительная сумма 2, повышенные цены 4',
    );
  });

  it('проблемные накладные идут первыми: ошибка → сумма → цены → остальные', () => {
    const s = summarizeBatch(bigBatch());
    expect(s.invoices.slice(0, 7).map(i => [i.id, i.flags])).toEqual([
      [775, ['error']],
      [764, ['suspicious', 'elevated']],
      [770, ['suspicious']],
      [761, ['elevated']],
      [766, ['elevated']],
      [768, ['elevated']],
      [760, []],
    ]);
    expect(s.invoices).toHaveLength(20);
    expect(s.invoices.find(i => i.id === 762)).toMatchObject({ number: 'N-762', supplier: 'Поставщик 762' });
  });

  it('если получатель подписан только на загрузки, которые выключены, — сводку не шлём', () => {
    const s = summarizeBatch({
      earlyUploads: [{ ...up(1), deliver: false }, { ...up(2), deliver: false }],
      events: [{ ...up(3), deliver: false }],
    });
    expect(s.deliverable).toBe(false);
    expect(s.uploaded).toBe(3);
  });

  it('без ошибок и флагов — короткая строка', () => {
    const s = summarizeBatch({ earlyUploads: [up(1), up(2)], events: [up(3), ev('invoice_recognized', 3)] });
    expect(batchHeadline(s)).toBe('Загружено 3 фото: распознано 1');
  });
});

describe('текст сводки', () => {
  it('Telegram: счётчики, до 15 ссылок и «… и ещё N»', () => {
    const events: BatchEvent[] = [];
    for (let id = 1; id <= 20; id++) events.push(up(id), ev('invoice_recognized', id, { invoiceNumber: String(100 + id) }));
    events.push(ev('recognition_error', 21));
    const text = buildBatchSummaryMessage(summarizeBatch({ earlyUploads: [], events }));
    const lines = text.split('\n');

    expect(lines[0]).toBe('📦 Загружено 20 фото: распознано 20, с ошибкой 1 (#21)');
    expect(lines[2]).toBe('• #21 — 🚨 ошибка распознавания');
    expect(lines[3]).toBe('  https://scanflow.ru/app.html#/invoices/21');
    expect(text.match(/app\.html#\/invoices\/\d+/g)).toHaveLength(15);
    expect(text).toContain('… и ещё 6: https://scanflow.ru/app.html#/invoices');
    expect(text).toContain('• № 101');
  });

  it('письмо: тема с числом фото, ссылки и экранирование названий', () => {
    const s = summarizeBatch({
      earlyUploads: [up(1), up(2)],
      events: [up(3), ev('suspicious_total', 3, { supplier: 'ООО <Ромашка>' })],
    });
    const mail = renderBatchSummary(s);
    expect(mail.subject).toBe('Пакетная загрузка: 3 фото');
    expect(mail.html).toContain('Загружено 3 фото: распознано 0, подозрительная сумма 1');
    expect(mail.html).toContain('https://scanflow.ru/app.html#/invoices/3');
    expect(mail.html).toContain('ООО &lt;Ромашка&gt;');
    expect(mail.html).not.toContain('<Ромашка>');
  });
});
