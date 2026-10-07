import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pdfToImages, isPdfPath } from '../../src/ocr/pdfPages';

/** Небольшой правильный PDF: страницы с текстом, таблица xref с точными смещениями. */
function buildPdf(pageTexts: string[]): Buffer {
  const objects: string[] = [];
  const pageIds = pageTexts.map((_, i) => 3 + i * 2);
  const fontId = 3 + pageTexts.length * 2;
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageTexts.length} >>`;
  pageTexts.forEach((text, i) => {
    const pageId = pageIds[i];
    const stream = `BT /F1 24 Tf 20 100 Td (${text}) Tj ET`;
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents ${pageId + 1} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`;
    objects[pageId + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  objects[fontId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(out, 'latin1');
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

let dir: string;
beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-pdf-')); });
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('pdfToImages', () => {
  it('каждая страница — JPEG; cleanup удаляет файлы', async () => {
    const pdf = path.join(dir, 'two.pdf');
    fs.writeFileSync(pdf, buildPdf(['Page one', 'Page two']));
    const pages = await pdfToImages(pdf, { dpi: 72 });
    expect(pages.totalPages).toBe(2);
    expect(pages.truncated).toBe(false);
    expect(pages.paths).toHaveLength(2);
    for (const p of pages.paths) {
      const head = fs.readFileSync(p).subarray(0, 2);
      expect([head[0], head[1]]).toEqual([0xff, 0xd8]);
    }
    pages.cleanup();
    for (const p of pages.paths) expect(fs.existsSync(p)).toBe(false);
  }, 60_000);

  it('страниц больше лимита — читаются первые, truncated', async () => {
    const pdf = path.join(dir, 'three.pdf');
    fs.writeFileSync(pdf, buildPdf(['A', 'B', 'C']));
    const pages = await pdfToImages(pdf, { maxPages: 1, dpi: 72 });
    try {
      expect(pages.paths).toHaveLength(1);
      expect(pages.totalPages).toBe(3);
      expect(pages.truncated).toBe(true);
    } finally {
      pages.cleanup();
    }
  }, 60_000);

  it('не PDF — понятная ошибка, процесс не падает', async () => {
    const bad = path.join(dir, 'bad.pdf');
    fs.writeFileSync(bad, 'это не PDF');
    await expect(pdfToImages(bad)).rejects.toThrow('Не удалось открыть PDF');
  }, 60_000);

  it('isPdfPath — по расширению, без учёта регистра', () => {
    expect(isPdfPath('/x/Счёт.PDF')).toBe(true);
    expect(isPdfPath('/x/photo.jpg')).toBe(false);
  });
});
