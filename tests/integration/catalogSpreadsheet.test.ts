import { describe, expect, it } from 'vitest';
import { parseCatalogSpreadsheet, parseDelimitedTable } from '../../src/integration/catalogSpreadsheet';

describe('catalog spreadsheet parser', () => {
  it('reads a 1C-style CSV with a title before the header', async () => {
    const text = [
      'Список номенклатуры',
      'Код;Наименование;Единица измерения;GUID',
      '0001;Молоко 3,2%;шт;11111111-1111-1111-1111-111111111111',
      '0002;Сахар-песок;кг;',
      ';Итого;;',
    ].join('\n');
    const parsed = await parseCatalogSpreadsheet(Buffer.from(text, 'utf8'), 'catalog.csv');

    expect(parsed.items).toHaveLength(2);
    expect(parsed.headerRow).toBe(2);
    expect(parsed.items[0]).toMatchObject({ code: '0001', name: 'Молоко 3,2%', unit: 'шт' });
    expect(parsed.items[0].guid).toBe('11111111-1111-1111-1111-111111111111');
    expect(parsed.items[1].guid).toMatch(/^manual-[a-f0-9]{48}$/);
    expect(parsed.generatedIds).toBe(1);
  });

  it('accepts a headerless table copied from Excel', async () => {
    const parsed = await parseCatalogSpreadsheet(Buffer.from('0003\tЧай\tшт\n0004\tКофе\tупак', 'utf8'), 'clipboard.tsv');

    expect(parsed.items.map(item => item.name)).toEqual(['Чай', 'Кофе']);
    expect(parsed.detectedColumns).toMatchObject({ code: 'Колонка 1 (код)', name: 'Колонка 2 (название)' });
    expect(parsed.warnings[0]).toContain('Заголовки не найдены');
  });

  it('keeps quoted separators and newlines inside cells', () => {
    expect(parseDelimitedTable('Код;Наименование\n1;"Сахар; белый"\n2;"Чай\nлистовой"')).toEqual([
      ['Код', 'Наименование'],
      ['1', 'Сахар; белый'],
      ['2', 'Чай\nлистовой'],
    ]);
  });

  it('asks to resave legacy XLS files', async () => {
    await expect(parseCatalogSpreadsheet(Buffer.from('legacy'), 'catalog.xls')).rejects.toThrow('XLSX или CSV');
  });
});
