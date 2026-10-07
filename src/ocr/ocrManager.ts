import { OcrEngine, OcrResult } from './types';
import { GoogleVisionEngine } from './googleVision';
import { TesseractEngine } from './tesseract';
import { analyzeImageWithVerification, analyzeMultipleImagesWithVerification, analyzeMultiPageTextWithVerification, detectOrientation, CatalogEntry } from './claudeApiAnalyzer';
import { isPdfPath, pdfToImages } from './pdfPages';
import { resolveAiTarget } from '../ai/engine';
import { AiUnavailableError } from '../ai/errors';
import type { AiTarget } from '../ai/types';
import { invoiceRepo } from '../database/repositories/invoiceRepo';
import { onecNomenclatureRepo } from '../database/repositories/onecNomenclatureRepo';
import { buildSupplierMemory } from '../learning/supplierMemory';
import { config } from '../config';
import { logger } from '../utils/logger';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import os from 'os';

/**
 * Fetch catalog entries to feed to the model prompt when LLM-mapper is on.
 * Excludes folders. Returns an empty array if the feature is disabled in
 * analyzer_config, so callers can blindly pass the result to the API layer.
 */
async function getCatalogForPrompt(ownerUserId: number): Promise<CatalogEntry[]> {
  const cfg = await invoiceRepo.getAnalyzerConfig();
  if (!cfg.llm_mapper_enabled) return [];
  // Каталог пер-тенантный: в подсказку модели уходит справочник только этой
  // компании, иначе модель сопоставила бы позиции с чужой номенклатурой.
  const rows = await onecNomenclatureRepo.listItems({ ownerUserId, excludeFolders: true });
  return rows.map(r => ({ guid: r.guid, name: r.name, unit: r.unit }));
}

/** Метка движка в invoices.ocr_engine: gpt_api / claude_api (+ _multipage). */
function engineTag(target: AiTarget, suffix = ''): string {
  return `${target.engine === 'gpt' ? 'gpt_api' : 'claude_api'}${suffix}`;
}

const PAGE_SEPARATOR = '\n\n--- СТРАНИЦА ---\n\n';

const ENGINE_MAP: Record<string, () => OcrEngine> = {
  google_vision: () => new GoogleVisionEngine(),
  tesseract: () => new TesseractEngine(),
};

export class OcrManager {
  private engines: Map<string, OcrEngine> = new Map();

  constructor() {
    const chain = config.ocrForceEngine
      ? [config.ocrForceEngine]
      : config.ocrChain;

    for (const name of chain) {
      const factory = ENGINE_MAP[name];
      if (factory) {
        this.engines.set(name, factory());
        logger.info(`OCR engine registered: ${name}`);
      } else {
        logger.warn(`Unknown OCR engine: ${name}, skipping`);
      }
    }

    if (this.engines.size === 0) {
      throw new Error('No OCR engines configured. Check OCR_CHAIN in .env');
    }
  }

  /**
   * На сколько градусов ПО ЧАСОВОЙ повернуть фото, чтобы документ стоял прямо:
   * 0, 90, 180 или 270. Модель сравнивает четыре повёрнутых превью (claudeApiAnalyzer
   * detectOrientation) — дёшево, а фото боком модели читают с грубыми ошибками.
   * Любой сбой — 0 (не повод не распознавать); недоступность модели пробрасывается.
   */
  private async detectTextRotation(imagePath: string, target: AiTarget): Promise<0 | 90 | 180 | 270> {
    try {
      const rotations: [0, 90, 180, 270] = [0, 90, 180, 270];
      const previews = await Promise.all(rotations.map(async (r) => {
        let pipeline = sharp(imagePath).rotate(); // EXIF first
        if (r !== 0) pipeline = pipeline.rotate(r);
        const buf = await pipeline
          .resize(400, 500, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 60 })
          .toBuffer();
        return buf.toString('base64');
      }));
      const rotation = await detectOrientation(previews as [string, string, string, string], target);
      logger.info('Orientation detected', { imagePath, rotation });
      return rotation;
    } catch (err) {
      if (err instanceof AiUnavailableError) throw err;
      logger.warn('Orientation detection failed, keeping as-is', {
        error: (err as Error).message,
      });
      return 0;
    }
  }

  /**
   * EXIF-поворот, поворот по модели (кроме страниц PDF — они уже стоят прямо),
   * ограничение размера, резкость. Возвращает путь к временному файлу.
   */
  async preprocessImage(imagePath: string, opts: { detectRotation?: boolean; target?: AiTarget } = {}): Promise<string> {
    const ext = path.extname(imagePath).toLowerCase();
    if (!['.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.webp'].includes(ext)) {
      logger.warn('Unsupported image format, skipping preprocessing', { ext });
      return imagePath;
    }

    const tmpPath = path.join(os.tmpdir(), `ocr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);

    // Detect rotation first. Falls back to 0 on any error.
    const rotation = opts.detectRotation === false
      ? 0
      : await this.detectTextRotation(imagePath, opts.target ?? await resolveAiTarget());

    try {
      let pipeline = sharp(imagePath).rotate(); // EXIF-based auto-rotate
      if (rotation !== 0) {
        pipeline = pipeline.rotate(rotation);
      }
      await pipeline
        .resize(2400, 3200, { fit: 'inside', withoutEnlargement: true })
        .sharpen()
        .normalise()
        .toFile(tmpPath);

      logger.info('Image preprocessed', {
        original: imagePath, processed: tmpPath, rotation,
      });
      return tmpPath;
    } catch (err) {
      logger.warn('Image preprocessing failed, using original', { error: (err as Error).message });
      return imagePath;
    }
  }

  async recognizeWithEngine(imagePath: string, engineName: string): Promise<OcrResult> {
    const factory = ENGINE_MAP[engineName];
    if (!factory) {
      throw new Error(`Unknown OCR engine: ${engineName}`);
    }

    logger.info(`OCR: using forced engine "${engineName}"`, { imagePath });
    const engine = factory();
    const processedPath = await this.preprocessImage(imagePath);

    try {
      const result = await engine.recognize(processedPath);
      logger.info(`OCR: success with engine "${engineName}"`, { textLength: result.text.length });

      // Clean up temp file
      if (processedPath !== imagePath && fs.existsSync(processedPath)) {
        fs.unlinkSync(processedPath);
      }

      return result;
    } catch (err) {
      // Clean up temp file
      if (processedPath !== imagePath && fs.existsSync(processedPath)) {
        fs.unlinkSync(processedPath);
      }
      throw err;
    }
  }

  async recognize(imagePath: string): Promise<OcrResult> {
    logger.info('OCR: starting recognition chain', { imagePath, engines: Array.from(this.engines.keys()) });

    const processedPath = await this.preprocessImage(imagePath);
    let lastError: Error | null = null;

    for (const [name, engine] of this.engines) {
      try {
        logger.info(`OCR: trying engine "${name}"`);
        const result = await engine.recognize(processedPath);
        logger.info(`OCR: success with engine "${name}"`, { textLength: result.text.length });

        // Clean up temp file
        if (processedPath !== imagePath && fs.existsSync(processedPath)) {
          fs.unlinkSync(processedPath);
        }

        return result;
      } catch (err) {
        lastError = err as Error;
        logger.warn(`OCR: engine "${name}" failed`, { error: lastError.message });
      }
    }

    // Clean up temp file
    if (processedPath !== imagePath && fs.existsSync(processedPath)) {
      fs.unlinkSync(processedPath);
    }

    throw new Error(`All OCR engines failed. Last error: ${lastError?.message}`);
  }

  async recognizeAll(imagePath: string): Promise<Record<string, OcrResult | { error: string }>> {
    const processedPath = await this.preprocessImage(imagePath);
    const results: Record<string, OcrResult | { error: string }> = {};

    for (const [name, engine] of this.engines) {
      try {
        results[name] = await engine.recognize(processedPath);
      } catch (err) {
        results[name] = { error: (err as Error).message };
      }
    }

    if (processedPath !== imagePath && fs.existsSync(processedPath)) {
      fs.unlinkSync(processedPath);
    }

    return results;
  }

  async terminate(): Promise<void> {
    for (const [name, engine] of this.engines) {
      if ('terminate' in engine && typeof engine.terminate === 'function') {
        await engine.terminate();
        logger.info(`OCR engine terminated: ${name}`);
      }
    }
  }

  /**
   * Гибридное распознавание (скрытый режим hybrid): текст даёт цепочка OCR
   * (Google Vision), структурирует его модель через ИИ-шлюз — та же, что и везде.
   * Если модель вернула ошибку — сырой текст уходит в regex-парсер.
   */
  async recognizeHybrid(imagePath: string, ownerUserId: number, useClaudeAnalyzer = true): Promise<OcrResult> {
    // Step 1: Get raw text via Google Vision (or fallback chain)
    const ocrResult = await this.recognize(imagePath);

    if (!useClaudeAnalyzer) {
      logger.info('Hybrid OCR: text analyzer disabled, using raw result');
      return ocrResult;
    }

    logger.info('Hybrid OCR: sending text to the model', { textLength: ocrResult.text.length });
    const target = await resolveAiTarget();
    const catalog = await getCatalogForPrompt(ownerUserId);
    const memory = await buildSupplierMemory(ownerUserId);
    const apiResult = await analyzeMultiPageTextWithVerification(ocrResult.text, target, 1, catalog, memory);
    if (apiResult.success && apiResult.data) {
      logger.info('Hybrid OCR: text analyzer succeeded', {
        itemsCount: apiResult.data.items?.length ?? 0,
        invoiceNumber: apiResult.data.invoice_number,
      });
      return {
        text: ocrResult.text,
        engine: `${ocrResult.engine}+${engineTag(target)}_text`,
        confidence: ocrResult.confidence,
        words: ocrResult.words,
        structured: apiResult.data,
      };
    }
    logger.warn('Hybrid OCR: text analyzer failed, using raw result', { error: apiResult.error });
    // Fallback: return raw OCR result (will be processed by regex parser)
    return ocrResult;
  }

  /**
   * Все страницы фото — в одном запросе к модели.
   */
  async recognizeMultiPageWithClaudeApi(imagePaths: string[], ownerUserId: number): Promise<OcrResult> {
    const target = await resolveAiTarget();
    // Preprocess every page — each can have its own rotation.
    const processedPaths = await Promise.all(imagePaths.map(p => this.preprocessImage(p, { target })));
    const catalog = await getCatalogForPrompt(ownerUserId);
    const memory = await buildSupplierMemory(ownerUserId);
    const result = await analyzeMultipleImagesWithVerification(processedPaths, target, catalog, memory);
    // Clean up temp files
    for (const pp of processedPaths) {
      if (!imagePaths.includes(pp)) {
        try { fs.unlinkSync(pp); } catch { /* ignore */ }
      }
    }

    if (result.success && result.data) {
      return {
        text: result.rawText || JSON.stringify(result.data, null, 2),
        engine: engineTag(target, '_multipage'),
        structured: result.data,
      };
    }

    throw new Error(result.error || 'Multi-page image analysis failed');
  }

  /**
   * Склейка нескольких страниц по их уже прочитанному тексту (JSON-ответам модели
   * или, в режиме hybrid, тексту Google Vision) в единый structured-ответ.
   */
  async analyzeMultiPageText(combinedOcrText: string, pageCount: number, ownerUserId: number): Promise<OcrResult> {
    const analyzerConfig = await invoiceRepo.getAnalyzerConfig();
    const target = await resolveAiTarget();
    const catalog = await getCatalogForPrompt(ownerUserId);
    const memory = await buildSupplierMemory(ownerUserId);
    const result = await analyzeMultiPageTextWithVerification(combinedOcrText, target, pageCount, catalog, memory);

    if (result.success && result.data) {
      // Honest engine tag: only include "google_vision" if we're actually in hybrid mode.
      const engine = analyzerConfig.mode === 'hybrid'
        ? `google_vision+${engineTag(target, '_multipage')}`
        : engineTag(target, '_multipage');
      return {
        text: combinedOcrText,
        engine,
        structured: result.data,
      };
    }

    throw new Error(result.error || 'Multi-page text analysis failed');
  }

  /**
   * Режимы gpt / claude_api: фото читает модель (через ИИ-шлюз) сразу в структуру.
   * PDF сначала превращается в картинки страниц.
   */
  async recognizeWithClaudeApi(imagePath: string, ownerUserId: number): Promise<OcrResult> {
    const target = await resolveAiTarget();
    if (isPdfPath(imagePath)) return this.recognizePdf(imagePath, ownerUserId, target);

    // Preprocess: auto-rotate based on EXIF + detected text orientation,
    // upscale-cap to 2400x3200, sharpen, normalise. Vision models
    // hallucinate heavily on sideways text, so this one step often matters
    // more than any prompt change.
    const processedPath = await this.preprocessImage(imagePath, { target });

    try {
      const catalog = await getCatalogForPrompt(ownerUserId);
      const memory = await buildSupplierMemory(ownerUserId);
      const result = await analyzeImageWithVerification(processedPath, target, catalog, memory);

      if (result.success && result.data) {
        return {
          text: result.rawText || JSON.stringify(result.data, null, 2),
          engine: engineTag(target),
          structured: result.data,
        };
      }

      throw new Error(result.error || 'Image analysis failed');
    } finally {
      if (processedPath !== imagePath) {
        try { fs.unlinkSync(processedPath); } catch { /* ignore */ }
      }
    }
  }

  /**
   * PDF: каждая страница — картинка 200 dpi, читается как фото (без определения
   * поворота), несколько страниц склеиваются так же, как многостраничная фотонакладная.
   */
  private async recognizePdf(pdfPath: string, ownerUserId: number, target: AiTarget): Promise<OcrResult> {
    const pages = await pdfToImages(pdfPath);
    const note = pages.truncated ? `PDF: прочитаны первые ${pages.paths.length} страниц из ${pages.totalPages}\n\n` : '';
    try {
      const catalog = await getCatalogForPrompt(ownerUserId);
      const memory = await buildSupplierMemory(ownerUserId);
      const texts: string[] = [];
      let lastData: OcrResult['structured'];
      for (const pagePath of pages.paths) {
        const prepared = await this.preprocessImage(pagePath, { detectRotation: false });
        try {
          const r = await analyzeImageWithVerification(prepared, target, catalog, memory);
          if (!r.success || !r.data) throw new Error(r.error || 'PDF page analysis failed');
          texts.push(r.rawText || JSON.stringify(r.data, null, 2));
          lastData = r.data;
        } finally {
          if (prepared !== pagePath) {
            try { fs.unlinkSync(prepared); } catch { /* ignore */ }
          }
        }
      }
      if (texts.length === 1) return { text: note + texts[0], engine: engineTag(target), structured: lastData };
      const combined = texts.join(PAGE_SEPARATOR);
      const merged = await analyzeMultiPageTextWithVerification(combined, target, texts.length, catalog, memory);
      if (!merged.success || !merged.data) throw new Error(merged.error || 'PDF multi-page analysis failed');
      return { text: note + combined, engine: engineTag(target, '_multipage'), structured: merged.data };
    } finally {
      pages.cleanup();
    }
  }
}
