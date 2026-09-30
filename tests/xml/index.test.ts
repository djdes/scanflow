import { describe, it, expect, vi } from 'vitest';
import path from 'path';

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  FnsXmlError, invoiceFileKind, isXmlFileName, isXmlInvoice, isXmlMimeType, isXmlOcrEngine,
  readFnsXmlInvoice, xmlDownloadName, XML_ENGINE_TORG12, XML_ENGINE_UPD,
} from '../../src/xml';
import { unitFromOkei, isMultiplierOkei } from '../../src/xml/okei';

const FIXTURES = path.join(__dirname, 'fixtures');

describe('readFnsXmlInvoice', () => {
  it('УПД → OcrResult: structured — разобранные данные, text — JSON для raw_text', async () => {
    const r = await readFnsXmlInvoice(path.join(FIXTURES, 'upd_503_ul_win1251.xml'));
    expect(r.engine).toBe(XML_ENGINE_UPD);
    expect(r.structured?.invoice_number).toBe('ТД-01234');
    const raw = JSON.parse(r.text);
    expect(raw).toMatchObject({
      source: 'xml',
      document: 'УПД (формат ФНС 5.03)',
      function: 'СЧФДОП',
      encoding: 'windows-1251',
      invoice_number: 'ТД-01234',
      total_sum: 7740.25,
      warnings: [],
    });
    expect(raw.file_id).toMatch(/^ON_NSCHFDOPPR_/);
    expect(raw.items).toHaveLength(4);
    // /remap восстанавливает итог шапки регуляркой по raw_text — формат должен ей подходить.
    expect(r.text).toMatch(/"total_sum"\s*:\s*7740\.25/);
  });

  it('ТОРГ-12 → движок xml_torg12', async () => {
    const r = await readFnsXmlInvoice(path.join(FIXTURES, 'torg12_551_win1251.xml'));
    expect(r.engine).toBe(XML_ENGINE_TORG12);
    expect(r.structured?.invoice_type).toBe('торг_12');
  });

  it('повреждённый файл → FnsXmlError', async () => {
    await expect(readFnsXmlInvoice(path.join(FIXTURES, 'upd_malformed.xml'))).rejects.toBeInstanceOf(FnsXmlError);
  });
});

describe('признаки XML-накладной', () => {
  it('имя файла и MIME', () => {
    expect(isXmlFileName('ON_NSCHFDOPPR_1.XML')).toBe(true);
    expect(isXmlFileName(' upload-1.xml ')).toBe(true);
    expect(isXmlFileName('photo.jpg')).toBe(false);
    expect(isXmlFileName(null)).toBe(false);
    expect(isXmlMimeType('application/xml')).toBe(true);
    expect(isXmlMimeType('Text/XML; charset=windows-1251')).toBe(true);
    expect(isXmlMimeType('application/octet-stream')).toBe(false);
    expect(isXmlMimeType(undefined)).toBe(false);
  });

  it('накладная — по движку или по имени файла (пока движок не записан)', () => {
    expect(isXmlOcrEngine('xml_upd')).toBe(true);
    expect(isXmlOcrEngine('claude_api')).toBe(false);
    expect(isXmlInvoice({ ocr_engine: 'xml_torg12', file_name: 'x.bin' })).toBe(true);
    expect(isXmlInvoice({ ocr_engine: null, file_name: 'upload-1.xml' })).toBe(true);
    expect(isXmlInvoice({ ocr_engine: 'claude_api', file_name: 'p1.jpg, p2.jpg' })).toBe(false);
    expect(isXmlInvoice(null)).toBe(false);
  });

  it('вид файла для карточки', () => {
    expect(invoiceFileKind('a.xml')).toBe('xml');
    expect(invoiceFileKind('a.PDF')).toBe('pdf');
    expect(invoiceFileKind('a.jpeg')).toBe('image');
  });
});

describe('xmlDownloadName', () => {
  it('имя из ИдФайл, без опасных символов', () => {
    expect(xmlDownloadName(JSON.stringify({ file_id: 'ON_NSCHFDOPPR_2BM-1_2BM-2_20260928_ab-cd' }), 'upload-1.xml'))
      .toBe('ON_NSCHFDOPPR_2BM-1_2BM-2_20260928_ab-cd.xml');
    expect(xmlDownloadName(JSON.stringify({ file_id: '../../etc/passwd' }), 'upload-1.xml')).toBe('etc_passwd.xml');
    expect(xmlDownloadName(JSON.stringify({ file_id: 'RL-NB-146830-MARK' }), 'u.xml')).toBe('RL-NB-146830-MARK.xml');
  });

  it('нет ИдФайл или raw_text не JSON — имя на диске', () => {
    expect(xmlDownloadName(null, 'upload-1.xml')).toBe('upload-1.xml');
    expect(xmlDownloadName('не json', 'upload-1.xml')).toBe('upload-1.xml');
    expect(xmlDownloadName(JSON.stringify({ file_id: null }), 'upload-1.xml')).toBe('upload-1.xml');
    expect(xmlDownloadName(JSON.stringify({ file_id: '...' }), 'upload-1.xml')).toBe('upload-1.xml');
  });
});

describe('ОКЕИ', () => {
  it.each([
    ['796', 'шт'], ['166', 'кг'], ['112', 'л'], ['778', 'упак'], ['163', 'г'], ['111', 'мл'],
    ['006', 'м'], ['6', 'м'], ['0006', 'м'], ['055', 'м2'], ['625', 'лист'], ['868', 'бут'], ['0796', 'шт'],
  ])('%s → %s', (code, unit) => {
    expect(unitFromOkei(code)).toBe(unit);
  });

  it('неизвестный и мусорный код → null', () => {
    expect(unitFromOkei('999')).toBeNull();
    expect(unitFromOkei('шт')).toBeNull();
    expect(unitFromOkei('')).toBeNull();
    expect(unitFromOkei(undefined)).toBeNull();
  });

  it('единицы-множители', () => {
    expect(isMultiplierOkei('798')).toBe(true);
    expect(isMultiplierOkei('796')).toBe(false);
  });
});
