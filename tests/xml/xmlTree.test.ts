import { describe, it, expect } from 'vitest';
import {
  attr, child, childrenNamed, decodeCp1251, decodeXmlBytes, descendant, parseXml, XmlParseError,
} from '../../src/xml/xmlTree';

const td1251 = new TextDecoder('windows-1251');
/** Кодирование в windows-1251 для тестов: обратная таблица к TextDecoder. */
function cp1251(text: string): Uint8Array {
  const rev = new Map<string, number>();
  for (let b = 0; b < 256; b++) rev.set(td1251.decode(Uint8Array.of(b)), b);
  return Uint8Array.from([...text].map(ch => {
    const b = rev.get(ch);
    if (b === undefined) throw new Error(`не кодируется в cp1251: ${ch}`);
    return b;
  }));
}

describe('decodeCp1251', () => {
  it('совпадает с TextDecoder(windows-1251) на всех 256 байтах', () => {
    const all = Uint8Array.from({ length: 256 }, (_, b) => b);
    expect(decodeCp1251(all)).toBe(td1251.decode(all));
  });
});

describe('decodeXmlBytes', () => {
  const doc = '<Файл ИдФайл="Тест №1"><Документ/></Файл>';

  it('windows-1251 из пролога', () => {
    const r = decodeXmlBytes(cp1251(`<?xml version="1.0" encoding="windows-1251"?>${doc}`));
    expect(r.encoding).toBe('windows-1251');
    expect(r.text).toContain('ИдФайл="Тест №1"');
  });

  it('пролог говорит windows-1251, а байты — UTF-8 (файл пересохранили редактором)', () => {
    const r = decodeXmlBytes(Buffer.from(`<?xml version="1.0" encoding="WINDOWS-1251"?>${doc}`, 'utf8'));
    expect(r.encoding).toBe('utf-8');
    expect(r.text).toContain('Тест №1');
  });

  it('пролога нет, байты не UTF-8 → windows-1251', () => {
    const r = decodeXmlBytes(cp1251(doc));
    expect(r.encoding).toBe('windows-1251');
    expect(r.text).toBe(doc);
  });

  it('UTF-8 с BOM', () => {
    const r = decodeXmlBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(doc, 'utf8')]));
    expect(r.encoding).toBe('utf-8');
    expect(r.text).toBe(doc);
  });

  it('UTF-16LE с BOM и без BOM', () => {
    const body = Buffer.from(`<?xml version="1.0" encoding="UTF-16"?>${doc}`, 'utf16le');
    expect(decodeXmlBytes(Buffer.concat([Buffer.from([0xff, 0xfe]), body])).text).toContain('Тест №1');
    const noBom = decodeXmlBytes(body);
    expect(noBom.encoding).toBe('utf-16le');
    expect(parseXml(noBom.text).name).toBe('Файл');
  });

  it('объявлена неизвестная кодировка → понятная ошибка', () => {
    expect(() => decodeXmlBytes(Buffer.from('<?xml version="1.0" encoding="x-unknown-42"?><a/>')))
      .toThrow(XmlParseError);
  });
});

describe('parseXml', () => {
  it('элементы, атрибуты, пространства имён, сущности, CDATA, комментарии', () => {
    const root = parseXml(`<?xml version="1.0"?>
      <!-- комментарий <Файл> -->
      <ns:Файл xmlns:ns="urn:x" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ИдФайл="a&amp;b">
        <Документ Функция="СЧФ">
          <СвПрод НаимОрг="ООО &quot;Ромашка&quot; &#1040;&#x411;" Пусто="  "/>
          <Текст>до <![CDATA[<не тег> & всё]]> после &lt;1&gt;</Текст>
          <?pi игнорируется?>
          <СвПрод НаимОрг='второй'/>
        </Документ>
      </ns:Файл>`);
    expect(root.name).toBe('Файл');
    expect(root.attrs['ИдФайл']).toBe('a&b');
    const doc = child(root, 'Документ');
    expect(attr(doc, 'Функция')).toBe('СЧФ');
    const sellers = childrenNamed(doc, 'СвПрод');
    expect(sellers).toHaveLength(2);
    expect(attr(sellers[0], 'НаимОрг')).toBe('ООО "Ромашка" АБ');
    expect(attr(sellers[0], 'Пусто')).toBeNull();
    expect(attr(sellers[1], 'НаимОрг')).toBe('второй');
    expect(descendant(root, 'Текст')?.text).toBe('до <не тег> & всё после <1>');
  });

  it('переводы строк в атрибуте нормализуются в пробел, &#10; сохраняется', () => {
    const root = parseXml('<a b="x\r\ny\tz" c="1&#10;2"/>');
    expect(root.attrs.b).toBe('x y z');
    expect(root.attrs.c).toBe('1\n2');
  });

  it('DOCTYPE пропускается, объявленные сущности не раскрываются (нет XXE)', () => {
    const root = parseXml(`<!DOCTYPE Файл [
      <!ENTITY xxe SYSTEM "file:///etc/passwd">
      <!ENTITY lol "lol">
    ]><Файл a="&xxe;">&lol;</Файл>`);
    expect(root.attrs.a).toBe('&xxe;');
    expect(root.text).toBe('&lol;');
  });

  it('BOM-символ в начале строки не мешает', () => {
    expect(parseXml('﻿<a/>').name).toBe('a');
  });

  it.each([
    ['<a><b></a>', /ожидался <\/b>/],
    ['<a><b>', /файл обрывается: не закрыт тег <b>/],
    ['<a b=1/>', /не в кавычках/],
    ['<a b="<"/>', /символ «<»/],
    ['<a/><b/>', /второй корневой элемент/],
    ['просто текст', /это не XML/],
    ['', /нет ни одного элемента/],
    ['<a></a>хвост', /текст после корневого элемента/],
    ['</a>', /лишний закрывающий тег/],
    ['<a b></a>', /нет значения/],
  ])('ошибка разбора: %s', (src, message) => {
    expect(() => parseXml(src)).toThrow(message);
  });

  it('в ошибке — номер строки', () => {
    try {
      parseXml('<a>\n  <b>\n  </c>\n</a>');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(XmlParseError);
      expect((err as XmlParseError).line).toBe(3);
      expect((err as Error).message).toContain('строка 3');
    }
  });
});
