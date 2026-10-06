import { describe, it, expect } from 'vitest';
import { DEFAULT_GPT_MODEL, isGptModel, isVisionLlmMode, toGptContent, visionModelFor } from '../../src/ocr/gptVision';

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

describe('visionModelFor', () => {
  const base = { anthropic_api_key: 'sk-ant-test', claude_model: 'claude-sonnet-5' };
  it('в режиме gpt — модель GPT без ключа Anthropic, по умолчанию основная', () => {
    expect(visionModelFor({ ...base, mode: 'gpt', gpt_model: 'gpt-6-luna' })).toEqual({ modelId: 'gpt-6-luna', apiKey: '' });
    expect(visionModelFor({ ...base, mode: 'gpt', gpt_model: null })).toEqual({ modelId: DEFAULT_GPT_MODEL, apiKey: '' });
  });
  it('PDF в режиме gpt читает Claude', () => {
    expect(visionModelFor({ ...base, mode: 'gpt', gpt_model: 'gpt-6-luna' }, { pdf: true }))
      .toEqual({ modelId: 'claude-sonnet-5', apiKey: 'sk-ant-test' });
  });
  it('в режиме claude_api — Claude с ключом из настроек', () => {
    expect(visionModelFor({ ...base, mode: 'claude_api', gpt_model: 'gpt-6-luna' }))
      .toEqual({ modelId: 'claude-sonnet-5', apiKey: 'sk-ant-test' });
  });
});

describe('toGptContent', () => {
  it('текст и base64-картинки Claude → input_text / input_image', () => {
    const out = toGptContent([
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } },
      { type: 'text', text: 'Прочитай' },
    ]);
    expect(out).toEqual([
      { type: 'input_image', image_url: 'data:image/jpeg;base64,QUJD', detail: 'high' },
      { type: 'input_text', text: 'Прочитай' },
    ]);
  });
  it('строка — один текстовый блок', () => {
    expect(toGptContent('Склей страницы')).toEqual([{ type: 'input_text', text: 'Склей страницы' }]);
  });
  it('PDF-документ не поддерживается — понятная ошибка', () => {
    expect(() => toGptContent([{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBE' } }]))
      .toThrow(/PDF распознаётся через Claude/);
  });
});
