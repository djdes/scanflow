import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { runInNewContext } from 'vm';

// Повторная загрузка старых фото (17.11.2026): с телефона ушли 13 снимков накладных
// 08–27.10, сохранённых из мессенджера, — те же документы уже были загружены с
// iPhone. Байты другие (мессенджер пережимает), поэтому дедуп по хешу не сработал.
// Upload.photoTakenAt/stalePhotos находят такие фото до отправки.
const script = readFileSync('public/js/upload.js', 'utf8');
let U: any;
beforeAll(() => {
  U = runInNewContext(`${script}\nUpload;`, { App: {}, window: {}, navigator: {}, document: {}, console });
});

const NOW = Date.parse('2026-11-17T15:23:00+03:00');
const file = (name: string, lastModified = NOW, type = 'image/jpeg') => ({ name, lastModified, type });

describe('Upload.photoTakenAt', () => {
  it('время в миллисекундах в начале имени (сохранено из мессенджера)', () => {
    const d = U.photoTakenAt(file('17930794855616114695946486537492.jpg'), NOW);
    expect(new Date(d).toISOString().slice(0, 10)).toBe('2026-10-27');
  });

  it('дата в имени: камера, Telegram, WhatsApp', () => {
    expect(new Date(U.photoTakenAt(file('IMG_20261008_101500.jpg'), NOW)).toISOString().slice(0, 10)).toBe('2026-10-08');
    expect(new Date(U.photoTakenAt(file('photo_2026-10-20_10-43-15.jpg'), NOW)).toISOString().slice(0, 10)).toBe('2026-10-20');
    expect(new Date(U.photoTakenAt(file('IMG-20261009-WA0004.jpg'), NOW)).toISOString().slice(0, 10)).toBe('2026-10-09');
  });

  it('без даты в имени — время изменения файла', () => {
    const old = Date.parse('2026-10-01T09:00:00Z');
    expect(U.photoTakenAt(file('image.jpg', old), NOW)).toBe(old);
  });

  it('берёт более раннюю из даты в имени и времени файла', () => {
    const lm = Date.parse('2026-10-05T09:00:00Z');
    expect(U.photoTakenAt(file('IMG_20261110_101500.jpg', lm), NOW)).toBe(lm);
  });

  it('невозможные даты в имени не учитываются', () => {
    expect(U.photoTakenAt(file('99999999999999.jpg', NOW), NOW)).toBe(NOW);
    expect(U.photoTakenAt(file('scan_20991301.jpg', NOW), NOW)).toBe(NOW);
  });
});

describe('Upload.stalePhotos', () => {
  it('отбирает снимки старше недели, свежие и документы не трогает', () => {
    const files = [
      file('17914730603258793890401903770.jpg'),                     // 08.10
      file('17930794977758295789251101169903.jpg'),                  // 27.10
      file('photo_2026-11-17_10-43-15.jpg'),                         // сегодня
      file('invoice_35804677.pdf', Date.parse('2026-09-01'), 'application/pdf'),
      file('upd.xml', Date.parse('2026-09-01'), 'text/xml'),
    ];
    const old = U.stalePhotos(files, NOW);
    expect(old.map((o: any) => o.file.name)).toEqual([
      '17914730603258793890401903770.jpg',
      '17930794977758295789251101169903.jpg',
    ]);
  });

  it('6 дней назад — ещё свежее', () => {
    const lm = NOW - 6 * 86_400_000;
    expect(U.stalePhotos([file('image.jpg', lm)], NOW)).toHaveLength(0);
  });

  it('текст вопроса называет число и даты снимков', () => {
    const old = U.stalePhotos([
      file('17914730603258793890401903770.jpg'),
      file('17930794977758295789251101169903.jpg'),
    ], NOW);
    const text = U.stalePhotosQuestion(old);
    expect(text).toMatch(/2 фото сняты давно: 08\.10\.2026 — 27\.10\.2026/);
    expect(text).toMatch(/уже загружали/);
  });
});
