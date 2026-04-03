import { ImageAnnotatorClient } from '@google-cloud/vision';
import { OcrEngine, OcrResult } from './types';
import { config } from '../config';
import { logger } from '../utils/logger';

export class GoogleVisionEngine implements OcrEngine {
  name = 'google_vision';
  private client: ImageAnnotatorClient | null = null;

  private getClient(): ImageAnnotatorClient {
    if (!this.client) {
      this.client = new ImageAnnotatorClient({
        keyFilename: config.googleCredentials,
      });
    }
    return this.client;
  }

  async recognize(imagePath: string): Promise<OcrResult> {
    logger.info('Google Vision: starting recognition', { imagePath });

    const client = this.getClient();
    const [result] = await client.textDetection(imagePath);
    const detections = result.textAnnotations;

    if (!detections || detections.length === 0) {
      throw new Error('Google Vision: no text detected');
    }

    const fullText = detections[0].description || '';
    logger.info('Google Vision: text extracted', { length: fullText.length });
    logger.debug('Google Vision: raw text', { text: fullText.substring(0, 500) });

    // Extract words with bounding boxes (detections[1+] = individual words)
    const words: any[] = [];
    for (let i = 1; i < detections.length; i++) {
      const word = detections[i];
      if (!word.boundingPoly || !word.boundingPoly.vertices || word.boundingPoly.vertices.length === 0) {
        continue;
      }
      const vertices = word.boundingPoly.vertices;
      const x = vertices[0].x || 0;
      const y = vertices[0].y || 0;
      const width = (vertices[1]?.x || 0) - x;
      const height = (vertices[2]?.y || 0) - y;

      words.push({
        text: word.description || '',
        x,
        y,
        width,
        height,
        confidence: word.confidence,
      });
    }

    logger.debug('Google Vision: extracted words with bounding boxes', { count: words.length });

    return {
      text: fullText,
      engine: this.name,
      words,
    };
  }
}
