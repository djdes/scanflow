import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { beforeAll, describe, expect, it } from 'vitest';

// Мобильное приложение /m/: статусы и тексты простыми словами (спек 2026-11-06).
const script = readFileSync('public/js/mobile-core.js', 'utf8');
let core: any;
beforeAll(() => { core = runInNewContext(`${script}\nMobileCore;`, {}); });

const NBSP = ' ';
const ready = (over: Record<string, unknown> = {}) => ({ id: 1, status: 'processed', approved_for_1c: 0, review_reason: null, ...over });

describe('invoiceState — плашка, пояснение, главная кнопка', () => {
  it.each([
    [{ status: 'duplicate' }, 'Уже есть', null],
    [{ duplicate_of: 7 }, 'Уже есть', null],
    [{ status: 'error' }, 'Не прочиталась', 'retake'],
    [{ status: 'failed' }, 'Не прочиталась', 'retake'],
    [{ status: 'waiting_ai' }, 'Прочитаем позже', null],
    [{ status: 'new' }, 'Читаем', null],
    [{ status: 'ocr_processing' }, 'Читаем', null],
    [{ status: 'parsing' }, 'Читаем', null],
    [{ onec_status: 'error', onec_error: 'Нет склада' }, '1С не приняла', 'review'],
    [{ status: 'sent_to_1c' }, 'В 1С ✓', null],
    [{ approved_for_1c: 1 }, 'Ждёт 1С', null],
    [{ review_reason: 'total' }, 'Проверить', 'review'],
    [{ sibling_is_copy: 1 }, 'Проверить', 'review'],
    [{}, 'Готова', 'send'],
  ])('%o → %s', (over, label, action) => {
    const s = core.invoiceState(ready(over));
    expect(s.label).toBe(label);
    expect(s.action).toBe(action);
    expect(['blue', 'green', 'amber', 'red', 'grey']).toContain(s.tone);
  });

  it.each([
    ['incomplete_pages', 'Не все листы. Доснимите.'],
    ['total', 'Сумма не сходится.'],
    ['header', 'Нет номера, даты или поставщика.'],
    ['items', 'Нет товаров.'],
    ['quantity', 'Проверьте количество.'],
    ['mapping', 'Есть новые товары.'],
    ['supplier', 'Проверьте поставщика.'],
    ['duplicate', 'Похоже на повтор.'],
    ['something_new', 'Откройте и проверьте.'],
  ])('причина %s — одно короткое предложение', (reason, hint) => {
    expect(core.invoiceState(ready({ review_reason: reason })).hint).toBe(hint);
  });

  it('ошибка 1С показывает её текст, без него — общий совет', () => {
    expect(core.invoiceState(ready({ onec_status: 'rejected', onec_error: 'Нет склада' })).hint).toBe('Нет склада');
    expect(core.invoiceState(ready({ onec_status: 'rejected' })).hint).toBe('Откройте и проверьте.');
  });

  it('готовая — зелёная, отправленная — серая (дело сделано)', () => {
    expect(core.invoiceState(ready()).tone).toBe('green');
    expect(core.invoiceState(ready({ status: 'sent_to_1c' })).tone).toBe('grey');
  });
});

describe('форматы', () => {
  it('сумма: пробелы-разделители, без копеек при целом', () => {
    expect(core.formatMoney(12400)).toBe(`12${NBSP}400${NBSP}₽`);
    expect(core.formatMoney(12400.5)).toBe(`12${NBSP}400,50${NBSP}₽`);
    expect(core.formatMoney(1234567.891)).toBe(`1${NBSP}234${NBSP}567,89${NBSP}₽`);
    expect(core.formatMoney(0)).toBe(`0${NBSP}₽`);
    expect(core.formatMoney(null)).toBe('—');
    expect(core.formatMoney('abc')).toBe('—');
  });

  it('дата: в этом году без года', () => {
    const now = new Date(2026, 10, 6);
    expect(core.formatShortDate('2026-11-05', now)).toBe('05.11');
    expect(core.formatShortDate('2025-12-31 10:00:00', now)).toBe('31.12.2025');
    expect(core.formatShortDate(null, now)).toBe('');
    expect(core.formatDate('2026-11-05')).toBe('05.11.2026');
    expect(core.formatDate(undefined)).toBe('');
  });

  it('читается — только пока статус в работе', () => {
    expect(core.isReading({ status: 'ocr_processing' })).toBe(true);
    expect(core.isReading({ status: 'processed' })).toBe(false);
    expect(core.isReading({ status: 'waiting_ai' })).toBe(false);
  });

  it('множественное число', () => {
    expect([1, 2, 5, 11, 21, 22].map(n => core.plural(n, 'фото', 'фото', 'фото'))).toHaveLength(6);
    expect([1, 2, 5, 11, 21].map(n => core.plural(n, 'накладная', 'накладные', 'накладных')))
      .toEqual(['накладная', 'накладные', 'накладных', 'накладных', 'накладная']);
  });
});

describe('uploadSummary — полоса отправки', () => {
  const bar = (tone: string, text: string, extra: Record<string, boolean> = {}) => ({ tone, text, retry: false, dismiss: false, ...extra });
  it('нечего показывать', () => {
    expect(core.uploadSummary([], true)).toBeNull();
    expect(core.uploadSummary([{ status: 'ok' }, { status: 'removed' }], true)).toBeNull();
  });
  it('отправляем', () => {
    expect(core.uploadSummary([{ status: 'uploading' }, { status: 'queued' }], true)).toEqual(bar('blue', 'Отправляем 2 фото…'));
  });
  it('нет интернета — фото сохранены', () => {
    expect(core.uploadSummary([{ status: 'error', autoRetry: true }], false))
      .toEqual(bar('amber', 'Нет интернета. Фото сохранены — отправим сами.'));
  });
  it('сбой связи при сети — повторим сами, можно повторить сразу', () => {
    expect(core.uploadSummary([{ status: 'error', autoRetry: true }, { status: 'error', autoRetry: true }], true))
      .toEqual(bar('red', 'Не отправилось 2 фото. Повторим сами.', { retry: true }));
  });
  it('окончательная ошибка — причина и «Убрать», без обещания повторить', () => {
    expect(core.uploadSummary([{ status: 'error', autoRetry: false, error: 'Файл больше 20 МБ' }], true))
      .toEqual(bar('red', 'Не отправилось 1 фото. Файл больше 20 МБ.', { dismiss: true }));
    expect(core.uploadSummary([{ status: 'lost', error: 'x' }, { status: 'error' }], false))
      .toEqual(bar('red', 'Не отправилось 2 фото.', { dismiss: true }));
  });
  it('сервер принял, читаем', () => {
    expect(core.uploadSummary([{ status: 'server_queued' }, { status: 'processing' }], true)).toEqual(bar('blue', 'Читаем 2 фото…'));
  });
  it('очередь сервера видна и после перезапуска приложения', () => {
    expect(core.uploadSummary([], true, 3)).toEqual(bar('blue', 'Читаем 3 фото…'));
    expect(core.uploadSummary([{ status: 'server_queued' }], true, 0)).toEqual(bar('blue', 'Читаем 1 фото…'));
  });
  it('чтение на паузе — не «читаем», а «прочитаем позже»', () => {
    expect(core.uploadSummary([], true, 2, false)).toEqual(bar('amber', 'Фото сохранены (2). Прочитаем позже.'));
  });
});

describe('sendResultText — ответ на «Отправить в 1С»', () => {
  it('успех', () => expect(core.sendResultText(200, {})).toEqual({ ok: true, text: 'Отправлено. 1С заберёт сама.' }));
  it('не все листы', () => expect(core.sendResultText(409, { code: 'incomplete_pages' })).toEqual({ ok: false, text: 'Не все листы. Доснимите.' }));
  it('нужно согласование', () => expect(core.sendResultText(409, { needs_approval: true })).toEqual({ ok: false, text: 'Нужно согласование. Сумма выше лимита.' }));
  it('прочая ошибка — текст сервера', () => expect(core.sendResultText(400, { error: 'Неверный статус' })).toEqual({ ok: false, text: 'Неверный статус' }));
  it('без текста', () => expect(core.sendResultText(500, null)).toEqual({ ok: false, text: 'Не получилось. Попробуйте ещё раз.' }));
});

describe('logoutWarning — неотправленные фото не уходят под чужим входом', () => {
  it('предупреждает о неотправленных', () => {
    expect(core.logoutWarning([{ status: 'error' }, { status: 'queued' }, { status: 'ok' }]))
      .toBe('Не отправлено фото: 2. Если выйти, они удалятся.');
  });
  it('молчит, когда всё отправлено', () => {
    expect(core.logoutWarning([{ status: 'ok' }, { status: 'server_queued' }])).toBeNull();
  });
});

describe('installHint — как установить', () => {
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
  const ipad = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
  it('уже установлено', () => expect(core.installHint(iphone, true)).toBe('installed'));
  it('iPhone', () => expect(core.installHint(iphone, false)).toBe('ios'));
  it('iPad выдаёт себя за Mac — узнаём по касаниям', () => expect(core.installHint(ipad, false, 5)).toBe('ios'));
  it('Android', () => expect(core.installHint(android, false)).toBe('android'));
  it('компьютер', () => expect(core.installHint('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', false)).toBe('other'));
});

describe('installVariant — какую подсказку установки показать', () => {
  const safari = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const chromeIos = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1';
  const instagram = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0';
  const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
  it('iPhone в Safari — шаги «Поделиться» и стрелка вниз', () => expect(core.installVariant(safari, false, 5, false)).toBe('ios-safari'));
  it('iPhone в Chrome — те же шаги из строки адреса', () => expect(core.installVariant(chromeIos, false, 5, false)).toBe('ios-other'));
  it('встроенный браузер соцсети — сначала открыть в Safari', () => expect(core.installVariant(instagram, false, 5, false)).toBe('ios-inapp'));
  it('Android с системным окном установки — кнопка', () => expect(core.installVariant(android, false, 5, true)).toBe('android-prompt'));
  it('Android без системного окна — через меню браузера', () => expect(core.installVariant(android, false, 5, false)).toBe('android-menu'));
  it('уже установлено или компьютер — не показывать', () => {
    expect(core.installVariant(safari, true, 5, false)).toBeNull();
    expect(core.installVariant('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', false, 0, true)).toBeNull();
  });
});

describe('installDue — «Не сейчас» прячет подсказку на 14 дней', () => {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.UTC(2026, 10, 7);
  it('ещё не закрывали', () => expect(core.installDue(null, now)).toBe(true));
  it('закрыли вчера', () => expect(core.installDue(String(now - day), now)).toBe(false));
  it('закрыли 15 дней назад', () => expect(core.installDue(String(now - 15 * day), now)).toBe(true));
  it('мусор в хранилище не мешает показать', () => expect(core.installDue('abc', now)).toBe(true));
});

describe('sharedFileName — файл из «Поделиться» должен пройти проверку расширения', () => {
  it('имя с расширением не трогаем', () => {
    expect(core.sharedFileName('IMG_20261107_101500.jpg', 'image/jpeg')).toBe('IMG_20261107_101500.jpg');
    expect(core.sharedFileName('Счёт 15.pdf', 'application/pdf')).toBe('Счёт 15.pdf');
  });
  it('без расширения — добавляем по типу файла', () => {
    expect(core.sharedFileName('image', 'image/jpeg')).toBe('image.jpg');
    expect(core.sharedFileName('1000012345', 'image/png')).toBe('1000012345.png');
    expect(core.sharedFileName('document', 'application/pdf')).toBe('document.pdf');
    expect(core.sharedFileName('upd', 'text/xml')).toBe('upd.xml');
  });
  it('без имени — придумываем', () => {
    expect(core.sharedFileName('', 'image/webp')).toBe('shared.webp');
  });
  it('неизвестный тип — как есть: загрузчик сам скажет, что формат не подходит', () => {
    expect(core.sharedFileName('notes', 'text/plain')).toBe('notes');
  });
});
