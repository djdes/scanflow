import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { logger } from '../utils/logger';

/**
 * PDF → картинки страниц. GPT читает только картинки (документ-блок PDF был у Claude),
 * поэтому каждая страница рисуется в JPEG 200 dpi и дальше идёт тем же путём, что фото.
 *
 * pdfjs-dist поставляется только ES-модулем, а проект собирается в CommonJS: обычный
 * import() TypeScript превратил бы в require(). Поэтому — настоящий динамический import
 * через new Function. Холст — @napi-rs/canvas (готовые сборки, без системных программ:
 * на сервере нет SSH-доступа, ставить poppler некуда).
 */

export interface PdfPages {
  /** Временные JPEG по порядку страниц. */
  paths: string[];
  totalPages: number;
  /** Прочитаны не все страницы — их больше maxPages. */
  truncated: boolean;
  /** Удалить временные файлы. */
  cleanup(): void;
}

export const PDF_MAX_PAGES = 10;
const DEFAULT_DPI = 200;

export function isPdfPath(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === '.pdf';
}

const PDFJS_SPECIFIER = 'pdfjs-dist/legacy/build/pdf.mjs';

// Настоящий import() для Node без require(esm): TypeScript (CommonJS) превратил бы
// обычный import() в require().
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const nativeImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;

let pdfjsPromise: Promise<any> | null = null;
function pdfjsDir(): string {
  return path.dirname(require.resolve('pdfjs-dist/package.json'));
}
async function importPdfjs(): Promise<any> {
  try {
    // Node 20.19+/22.12+ грузит ES-модуль через require — так же работает и в тестах;
    // на прод-сервере Node 20, на старом минорном — запасной путь ниже.
    return await import(PDFJS_SPECIFIER as string);
  } catch (err) {
    if ((err as { code?: string }).code !== 'ERR_REQUIRE_ESM') throw err;
    return nativeImport(pathToFileURL(path.join(pdfjsDir(), 'legacy', 'build', 'pdf.mjs')).href);
  }
}
/**
 * На сервере Node 20, а pdfjs (ветка 5.4) в Node опирается на более новые возможности:
 * DOMMatrix/ImageData/Path2D (обычно подставляет их сам через process.getBuiltinModule —
 * его нет до Node 20.16), Promise.withResolvers (Node 22). Подставляем до загрузки pdfjs:
 * классы — из того же @napi-rs/canvas, что рисует страницы. Проверено на Node 20.0–25.
 */
function ensureNodePolyfills(): void {
  const g = globalThis as Record<string, unknown>;
  const canvas = require('@napi-rs/canvas') as Record<string, unknown>;
  for (const name of ['DOMMatrix', 'ImageData', 'Path2D']) {
    if (!g[name] && canvas[name]) g[name] = canvas[name];
  }
  const proc = process as unknown as { getBuiltinModule?: (id: string) => unknown };
  if (typeof proc.getBuiltinModule !== 'function') {
    proc.getBuiltinModule = (id: string) => require(String(id).replace(/^node:/, ''));
  }
  const P = Promise as unknown as { withResolvers?: () => unknown };
  if (typeof P.withResolvers !== 'function') {
    P.withResolvers = function withResolvers<T>(this: PromiseConstructor) {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new this<T>((res, rej) => { resolve = res; reject = rej; });
      return { promise, resolve, reject };
    };
  }
}

function loadPdfjs(): Promise<any> {
  if (!pdfjsPromise) {
    ensureNodePolyfills();
    pdfjsPromise = importPdfjs().catch((err) => { pdfjsPromise = null; throw err; });
  }
  return pdfjsPromise;
}

export async function pdfToImages(pdfPath: string, opts: { maxPages?: number; dpi?: number } = {}): Promise<PdfPages> {
  const maxPages = Math.max(1, opts.maxPages ?? PDF_MAX_PAGES);
  const scale = (opts.dpi ?? DEFAULT_DPI) / 72;
  const pdfjs = await loadPdfjs();
  const { createCanvas } = require('@napi-rs/canvas') as typeof import('@napi-rs/canvas');

  const data = new Uint8Array(await fs.promises.readFile(pdfPath));
  // Шрифты из комплекта pdfjs — для PDF без встроенных шрифтов. Путь — с прямыми
  // слешами и «/» в конце, иначе pdfjs его не примет.
  const standardFontDataUrl = path.join(pdfjsDir(), 'standard_fonts').split(path.sep).join('/') + '/';
  const task = pdfjs.getDocument({ data, standardFontDataUrl, isEvalSupported: false, verbosity: 0 });
  let doc: any;
  try {
    doc = await task.promise;
  } catch (err) {
    await task.destroy?.().catch?.(() => {});
    throw new Error(`Не удалось открыть PDF: ${(err as Error).message}`);
  }

  const paths: string[] = [];
  const cleanup = () => {
    for (const p of paths) {
      try { fs.unlinkSync(p); } catch { /* временный файл — не критично */ }
    }
  };
  try {
    const totalPages: number = doc.numPages;
    const count = Math.min(totalPages, maxPages);
    const stamp = `${Date.now()}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
    for (let n = 1; n <= count; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport, canvas }).promise;
      const out = path.join(os.tmpdir(), `pdfpage_${stamp}_${n}.jpg`);
      await fs.promises.writeFile(out, canvas.toBuffer('image/jpeg', 90));
      paths.push(out);
      page.cleanup?.();
    }
    if (totalPages > count) {
      logger.warn('PDF: прочитаны не все страницы', { pdfPath, totalPages, read: count });
    }
    return { paths, totalPages, truncated: totalPages > count, cleanup };
  } catch (err) {
    cleanup();
    throw new Error(`Не удалось прочитать страницы PDF: ${(err as Error).message}`);
  } finally {
    await task.destroy?.().catch?.(() => {});
  }
}
