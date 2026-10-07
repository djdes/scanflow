import { describe, it, expect } from 'vitest';
import { isGptModel, isVisionLlmMode } from '../../src/ocr/gptVision';
import { toGptInput } from '../../src/ai/gptEngine';

describe('isGptModel / isVisionLlmMode', () => {
  it('отличает модели GPT от Claude и мусора', () => {
    expect(isGptModel('gpt-6.1-sol')).toBe(true);
    expect(isGptModel('gpt-6-luna')).toBe(true);
    expect(isGptModel('claude-sonnet-5')).toBe(false);
    expect(isGptModel('gpt-')).toBe(false);
    expect(isGptModel('gpt-6 sol; rm')).toBe(false);
    expect(isGptModel(null)).toBe(false);
  });
  it('модель читает фото в режимах claude_api и gpt', () => {
    expect(isVisionLlmMode('claude_api')).toBe(true);
    expect(isVisionLlmMode('gpt')).toBe(true);
    expect(isVisionLlmMode('hybrid')).toBe(false);
    expect(isVisionLlmMode('dispatcher')).toBe(false);
  });
});

describe('toGptInput', () => {
  it('текст и base64-картинки → input_text / input_image', () => {
    const out = toGptInput([
      { type: 'image', mediaType: 'image/jpeg', data: 'QUJD' },
      { type: 'text', text: 'Прочитай' },
    ]);
    expect(out).toEqual([
      { type: 'input_image', image_url: 'data:image/jpeg;base64,QUJD', detail: 'high' },
      { type: 'input_text', text: 'Прочитай' },
    ]);
  });
  it('строка — один текстовый блок', () => {
    expect(toGptInput('Склей страницы')).toEqual([{ type: 'input_text', text: 'Склей страницы' }]);
  });
});
