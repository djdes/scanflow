import { OcrEngine, OcrResult } from './types';
import { GoogleVisionEngine } from './googleVision';
import { ClaudeCodeBridgeEngine } from './claudeCodeBridge';
import { TesseractEngine } from './tesseract';
import { analyzeTextWithClaude } from './claudeTextAnalyzer';
import { analyzeImageWithClaudeApi, analyzeMultipleImagesWithClaudeApi, analyzeMultiPageTextWithClaudeApi } from './claudeApiAnalyzer';
import { invoiceRepo } from '../database/repositories/invoiceRepo';
import { config } from '../config';
import { logger } from '../utils/logger';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import os from 'os';

const ENGINE_MAP: Record<string, () => OcrEngine> = {
  google_vision: () => new GoogleVisionEngine(),
  claude_cli: () => new ClaudeCodeBridgeEngine(),
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

  async preprocessImage(imagePath: string): Promise<string> {
    const ext = path.extname(imagePath).toLowerCase();
    if (!['.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.webp'].includes(ext)) {
      logger.warn('Unsupported image format, skipping preprocessing', { ext });
      return imagePath;
    }

    const tmpPath = path.join(os.tmpdir(), `ocr_${Date.now()}${ext}`);

    try {
      await sharp(imagePath)
        .resize(2400, 3200, { fit: 'inside', withoutEnlargement: true })
        .sharpen()
        .normalise()
        .toFile(tmpPath);

      logger.debug('Image preprocessed', { original: imagePath, processed: tmpPath });
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
   * Гибридное распознавание: OCR (Google Vision) + структуризация (Claude CLI)
   *
   * Использует MAX подписку Claude Code для интеллектуального парсинга.
   * Если Claude CLI недоступен или возвращает ошибку — fallback на regex-парсер.
   *
   * @param imagePath - путь к изображению
   * @param useClaudeAnalyzer - использовать Claude для структуризации (default: true)
   */
  async recognizeHybrid(imagePath: string, useClaudeAnalyzer = true): Promise<OcrResult> {
    // Step 1: Get raw text via Google Vision (or fallback chain)
    const ocrResult = await this.recognize(imagePath);

    if (!useClaudeAnalyzer) {
      logger.info('Hybrid OCR: Claude analyzer disabled, using raw result');
      return ocrResult;
    }

    // Step 2: Send OCR text to Anthropic API for intelligent structuring
    logger.info('Hybrid OCR: sending text to Anthropic API', { textLength: ocrResult.text.length });

    const analyzerConfig = invoiceRepo.getAnalyzerConfig();
    const apiKey = analyzerConfig.anthropic_api_key || config.anthropicApiKey;

    if (apiKey) {
      const apiResult = await analyzeMultiPageTextWithClaudeApi(ocrResult.text, apiKey, 1);
      if (apiResult.success && apiResult.data) {
        logger.info('Hybrid OCR: Anthropic API text analyzer succeeded', {
          itemsCount: apiResult.data.items?.length ?? 0,
          invoiceNumber: apiResult.data.invoice_number,
        });
        return {
          text: ocrResult.text,
          engine: `${ocrResult.engine}+claude_api_text`,
          confidence: ocrResult.confidence,
          words: ocrResult.words,
          structured: apiResult.data,
        };
      }
      logger.warn('Hybrid OCR: Anthropic API failed', { error: apiResult.error });
    }

    // Fallback: return raw OCR result (will be processed by regex parser)
    logger.warn('Hybrid OCR: analyzer failed, using raw result');
    return ocrResult;
  }

  /**
   * Claude API mode для многостраничных накладных:
   * отправляет ВСЕ страницы в один запрос Anthropic API.
   */
  async recognizeMultiPageWithClaudeApi(imagePaths: string[]): Promise<OcrResult> {
    const analyzerConfig = invoiceRepo.getAnalyzerConfig();
    const apiKey = analyzerConfig.anthropic_api_key || config.anthropicApiKey;

    if (!apiKey) {
      throw new Error('Anthropic API key not configured. Set it in Settings.');
    }

    // No resize for Claude API — it handles large images natively
    const result = await analyzeMultipleImagesWithClaudeApi(imagePaths, apiKey);

    if (result.success && result.data) {
      return {
        text: result.rawText || JSON.stringify(result.data, null, 2),
        engine: 'claude_api_multipage',
        structured: result.data,
      };
    }

    throw new Error(result.error || 'Claude API multi-page analysis failed');
  }

  /**
   * Текстовый анализ объединённого OCR-текста нескольких страниц.
   * Google Vision уже извлёк текст — Claude только структурирует.
   */
  async analyzeMultiPageText(combinedOcrText: string, pageCount: number): Promise<OcrResult> {
    const analyzerConfig = invoiceRepo.getAnalyzerConfig();
    const apiKey = analyzerConfig.anthropic_api_key || config.anthropicApiKey;

    if (!apiKey) {
      throw new Error('Anthropic API key not configured.');
    }

    const result = await analyzeMultiPageTextWithClaudeApi(combinedOcrText, apiKey, pageCount);

    if (result.success && result.data) {
      return {
        text: combinedOcrText,
        engine: 'google_vision+claude_api_multipage',
        structured: result.data,
      };
    }

    throw new Error(result.error || 'Multi-page text analysis failed');
  }

  /**
   * Claude API mode: отправляет изображение напрямую в Anthropic API.
   * Claude сам делает OCR + структуризацию в одном запросе.
   * Google Vision не используется.
   */
  async recognizeWithClaudeApi(imagePath: string): Promise<OcrResult> {
    const analyzerConfig = invoiceRepo.getAnalyzerConfig();
    const apiKey = analyzerConfig.anthropic_api_key || config.anthropicApiKey;

    if (!apiKey) {
      throw new Error('Anthropic API key not configured. Set it in Settings.');
    }

    // No resize for Claude API — it handles large images natively
    // Aggressive resize destroys small text on ТОРГ-12 invoices
    const processedPath = imagePath;

    try {
      const result = await analyzeImageWithClaudeApi(processedPath, apiKey);

      if (result.success && result.data) {
        return {
          text: result.rawText || JSON.stringify(result.data, null, 2),
          engine: 'claude_api',
          structured: result.data,
        };
      }

      throw new Error(result.error || 'Claude API analysis failed');
    } finally {
      if (processedPath !== imagePath) {
        try { fs.unlinkSync(processedPath); } catch { /* ignore */ }
      }
    }
  }
}
