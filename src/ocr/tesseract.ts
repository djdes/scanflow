import Tesseract from 'tesseract.js';
import { OcrEngine, OcrResult } from './types';
import { logger } from '../utils/logger';

export class TesseractEngine implements OcrEngine {
  name = 'tesseract';
  private worker: Tesseract.Worker | null = null;

  private async getWorker(): Promise<Tesseract.Worker> {
    if (!this.worker) {
      this.worker = await Tesseract.createWorker('rus+eng');
      logger.info('Tesseract: worker initialized with rus+eng languages');
    }
    return this.worker;
  }

  async recognize(imagePath: string): Promise<OcrResult> {
    logger.info('Tesseract: starting recognition', { imagePath });

    const worker = await this.getWorker();
    const result = await worker.recognize(imagePath);

    const text = result.data.text;
    const confidence = result.data.confidence;

    if (!text || text.trim().length === 0) {
      throw new Error('Tesseract: no text recognized');
    }

    logger.info('Tesseract: text extracted', { length: text.length, confidence });
    logger.debug('Tesseract: raw text', { text: text.substring(0, 500) });

    return {
      text,
      engine: this.name,
      confidence,
    };
  }

  async terminate(): Promise<void> {
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
      logger.info('Tesseract: worker terminated');
    }
  }
}
