/**
 * Минимальный разбор XML в дерево — для электронных документов ФНС (УПД,
 * счёт-фактура, ТОРГ-12), которые поставщики присылают из ЭДО (Диадок, СБИС).
 *
 * Почему не библиотека: файлы ФНС машинные и простые (элементы + атрибуты,
 * текста почти нет), а нужно ровно дерево с атрибутами. Разбор строгий к
 * структуре — несогласованный или незакрытый тег даёт ошибку с номером строки,
 * а не «пустую накладную». Ничего не подгружается извне: DOCTYPE пропускается,
 * объявленные в нём сущности не раскрываются (нет XXE и «миллиарда смешков»).
 */

export interface XmlElement {
  /** Локальное имя: префикс пространства имён отброшен («ns:Файл» → «Файл»). */
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** Текст непосредственно внутри элемента (без текста детей), сущности раскрыты. */
  text: string;
}

export class XmlParseError extends Error {
  constructor(message: string, public readonly line?: number) {
    super(message);
    this.name = 'XmlParseError';
  }
}

// ── Байты → строка ──────────────────────────────────────────────────────────

/**
 * windows-1251, байты 0x80–0xBF (0xC0–0xFF — это подряд «А»…«я», U+0410–U+044F).
 * Своя таблица, а не TextDecoder('windows-1251'): тот есть только в сборках Node
 * с полным ICU, а кодировка — основная для файлов ФНС. Тест сверяет таблицу с
 * TextDecoder на всех 256 байтах.
 */
const CP1251_80_BF =
  'ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏ'
  + 'ђ‘’“”•–—\u0098™љ›њќћџ'
  + ' ЎўЈ¤Ґ¦§Ё©Є«¬­®Ї'
  + '°±Ііґµ¶·ё№є»јЅѕї';

const CP1251_TABLE: Uint16Array = (() => {
  const t = new Uint16Array(256);
  for (let b = 0; b < 256; b++) {
    t[b] = b < 0x80 ? b : b < 0xc0 ? CP1251_80_BF.charCodeAt(b - 0x80) : 0x410 + (b - 0xc0);
  }
  return t;
})();

export function decodeCp1251(bytes: Uint8Array): string {
  const units = new Uint16Array(bytes.length);
  for (let k = 0; k < bytes.length; k++) units[k] = CP1251_TABLE[bytes[k]];
  let out = '';
  const CHUNK = 8192;
  for (let k = 0; k < units.length; k += CHUNK) out += String.fromCharCode(...units.subarray(k, k + CHUNK));
  return out;
}

const CP1251_LABELS = new Set(['windows-1251', 'cp1251', 'win-1251', 'win1251', 'x-cp1251', 'cp-1251']);
const UTF8_LABELS = new Set(['utf-8', 'utf8', 'unicode-1-1-utf-8']);

function strictUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Байты файла → текст. Порядок: BOM → кодировка из пролога <?xml … encoding?> →
 * UTF-8. Две поправки на реальные файлы:
 *   - пролог говорит windows-1251, а байты — валидный UTF-8 с кириллицей: файл
 *     пересохранили редактором, не поправив пролог (обратное почти невозможно —
 *     русский текст в 1251 не бывает валидным UTF-8);
 *   - пролога нет (или он говорит UTF-8), а байты не UTF-8 — это windows-1251.
 */
export function decodeXmlBytes(bytes: Uint8Array): { text: string; encoding: string } {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8' };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: Buffer.from(bytes.subarray(2)).toString('utf16le'), encoding: 'utf-16le' };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const body = Buffer.from(bytes.subarray(2, 2 + ((bytes.length - 2) & ~1)));
    return { text: body.swap16().toString('utf16le'), encoding: 'utf-16be' };
  }
  // UTF-16 без BOM: «<» с нулевым байтом рядом. Иначе нули прошли бы как
  // «валидный UTF-8», и файл упал бы с непонятной ошибкой разбора.
  if (bytes.length >= 4 && bytes[0] === 0x3c && bytes[1] === 0x00 && bytes[3] === 0x00) {
    return { text: Buffer.from(bytes.subarray(0, bytes.length & ~1)).toString('utf16le'), encoding: 'utf-16le' };
  }
  if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x3c && bytes[2] === 0x00) {
    const body = Buffer.from(bytes.subarray(0, bytes.length & ~1));
    return { text: body.swap16().toString('utf16le'), encoding: 'utf-16be' };
  }
  const head = Buffer.from(bytes.subarray(0, 256)).toString('latin1');
  const m = /^\s*<\?xml[^>]*?\sencoding\s*=\s*["']([A-Za-z0-9._:-]+)["']/.exec(head);
  const declared = m ? m[1].toLowerCase() : null;

  if (declared && CP1251_LABELS.has(declared)) {
    const asUtf8 = strictUtf8(bytes);
    if (asUtf8 != null && /[^\x00-\x7f]/.test(asUtf8)) return { text: asUtf8, encoding: 'utf-8' };
    return { text: decodeCp1251(bytes), encoding: 'windows-1251' };
  }
  if (!declared || UTF8_LABELS.has(declared)) {
    const asUtf8 = strictUtf8(bytes);
    if (asUtf8 != null) return { text: asUtf8, encoding: 'utf-8' };
    return { text: decodeCp1251(bytes), encoding: 'windows-1251' };
  }
  try {
    return { text: new TextDecoder(declared).decode(bytes), encoding: declared };
  } catch {
    throw new XmlParseError(`неподдерживаемая кодировка «${declared}»`);
  }
}

// ── Строка → дерево ─────────────────────────────────────────────────────────

const PREDEFINED_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9._-]*);/g, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      const ok = Number.isFinite(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
      return ok ? String.fromCodePoint(code) : whole;
    }
    // Сущности из DOCTYPE не раскрываем сознательно — оставляем как есть.
    return PREDEFINED_ENTITIES[ref] ?? whole;
  });
}

function isSpace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
}

/** Конец имени тега/атрибута: пробел, «/», «>», «=». */
function isNameEnd(c: number): boolean {
  return isSpace(c) || c === 0x2f || c === 0x3e || c === 0x3d;
}

function localName(qname: string): string {
  return qname.slice(qname.lastIndexOf(':') + 1);
}

function lineAt(src: string, pos: number): number {
  let line = 1;
  for (let k = 0; k < pos && k < src.length; k++) if (src.charCodeAt(k) === 0x0a) line++;
  return line;
}

export function parseXml(src: string): XmlElement {
  const n = src.length;
  let i = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  const stack: Array<{ el: XmlElement; text: string[] }> = [];
  let root: XmlElement | null = null;

  const fail: (message: string, at: number) => never = (message, at) => {
    const line = lineAt(src, at);
    throw new XmlParseError(`${message} (строка ${line})`, line);
  };

  while (i < n) {
    const lt = src.indexOf('<', i);
    const textEnd = lt === -1 ? n : lt;
    if (textEnd > i) {
      const raw = src.slice(i, textEnd);
      if (stack.length) stack[stack.length - 1].text.push(decodeEntities(raw));
      else if (raw.trim()) fail(root ? 'текст после корневого элемента' : 'текст до первого тега — это не XML', i);
      i = textEnd;
      if (lt === -1) break;
    }

    if (src.startsWith('<?', i)) {
      const end = src.indexOf('?>', i + 2);
      if (end === -1) fail('не закрыта инструкция <?…?>', i);
      i = end + 2;
      continue;
    }
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      if (end === -1) fail('не закрыт комментарий', i);
      i = end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i + 9);
      if (end === -1) fail('не закрыт блок CDATA', i);
      if (!stack.length) fail('CDATA вне корневого элемента', i);
      stack[stack.length - 1].text.push(src.slice(i + 9, end));
      i = end + 3;
      continue;
    }
    if (src.startsWith('<!', i)) {
      // DOCTYPE и прочие объявления пропускаем целиком, вместе с внутренним [...].
      let j = i + 2;
      let depth = 0;
      for (; j < n; j++) {
        const c = src[j];
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
      }
      if (j >= n) fail('не закрыто объявление <!…>', i);
      i = j + 1;
      continue;
    }
    if (src.startsWith('</', i)) {
      const end = src.indexOf('>', i + 2);
      if (end === -1) fail('не закрыт тег', i);
      const name = localName(src.slice(i + 2, end).trim());
      const top = stack.pop();
      if (!top) return fail(`лишний закрывающий тег </${name}>`, i);
      if (top.el.name !== name) fail(`ожидался </${top.el.name}>, а встретился </${name}>`, i);
      top.el.text = top.text.join('');
      i = end + 1;
      continue;
    }

    // Открывающий тег.
    let j = i + 1;
    while (j < n && !isNameEnd(src.charCodeAt(j))) j++;
    const rawName = src.slice(i + 1, j);
    if (!rawName) fail('тег без имени', i);
    const el: XmlElement = { name: localName(rawName), attrs: {}, children: [], text: '' };
    let selfClosing = false;
    for (;;) {
      while (j < n && isSpace(src.charCodeAt(j))) j++;
      if (j >= n) fail(`не закрыт тег <${rawName}>`, i);
      const c = src[j];
      if (c === '>') { j++; break; }
      if (c === '/') {
        if (src[j + 1] !== '>') fail(`ошибка в теге <${rawName}>`, j);
        selfClosing = true;
        j += 2;
        break;
      }
      const nameStart = j;
      while (j < n && !isNameEnd(src.charCodeAt(j))) j++;
      const attrName = src.slice(nameStart, j);
      if (!attrName) fail(`ошибка в атрибутах тега <${rawName}>`, j);
      while (j < n && isSpace(src.charCodeAt(j))) j++;
      if (src[j] !== '=') fail(`у атрибута ${attrName} нет значения`, j);
      j++;
      while (j < n && isSpace(src.charCodeAt(j))) j++;
      const quote = src[j];
      if (quote !== '"' && quote !== "'") fail(`значение атрибута ${attrName} не в кавычках`, j);
      const valueEnd = src.indexOf(quote, j + 1);
      if (valueEnd === -1) fail(`не закрыта кавычка у атрибута ${attrName}`, j);
      const rawValue = src.slice(j + 1, valueEnd);
      if (rawValue.includes('<')) fail(`символ «<» в значении атрибута ${attrName}`, j);
      // Нормализация значения атрибута по стандарту XML: переводы строк и табы → пробел.
      el.attrs[attrName] = decodeEntities(rawValue.replace(/\r\n|[\t\n\r]/g, ' '));
      j = valueEnd + 1;
    }

    if (stack.length) stack[stack.length - 1].el.children.push(el);
    else if (root) fail('второй корневой элемент', i);
    else root = el;
    if (!selfClosing) stack.push({ el, text: [] });
    i = j;
  }

  if (stack.length) fail(`файл обрывается: не закрыт тег <${stack[stack.length - 1].el.name}>`, n);
  if (!root) throw new XmlParseError('в файле нет ни одного элемента');
  return root;
}

// ── Навигация ───────────────────────────────────────────────────────────────

export function child(el: XmlElement | null | undefined, name: string): XmlElement | undefined {
  return el?.children.find(c => c.name === name);
}

export function childrenNamed(el: XmlElement | null | undefined, name: string): XmlElement[] {
  return el ? el.children.filter(c => c.name === name) : [];
}

/** Все потомки (в порядке документа), подходящие под условие. */
export function findAll(el: XmlElement | null | undefined, match: (e: XmlElement) => boolean): XmlElement[] {
  const out: XmlElement[] = [];
  if (!el) return out;
  const stack = [...el.children].reverse();
  while (stack.length) {
    const cur = stack.pop()!;
    if (match(cur)) out.push(cur);
    for (let k = cur.children.length - 1; k >= 0; k--) stack.push(cur.children[k]);
  }
  return out;
}

/** Первый потомок (в порядке документа), подходящий под условие. */
export function findFirst(el: XmlElement | null | undefined, match: (e: XmlElement) => boolean): XmlElement | undefined {
  if (!el) return undefined;
  const stack = [...el.children].reverse();
  while (stack.length) {
    const cur = stack.pop()!;
    if (match(cur)) return cur;
    for (let k = cur.children.length - 1; k >= 0; k--) stack.push(cur.children[k]);
  }
  return undefined;
}

export function descendant(el: XmlElement | null | undefined, name: string): XmlElement | undefined {
  return findFirst(el, e => e.name === name);
}

/** Значение атрибута без краевых пробелов; пустое — как отсутствующее. */
export function attr(el: XmlElement | null | undefined, name: string): string | null {
  const v = el?.attrs[name];
  if (v == null) return null;
  const t = v.trim();
  return t === '' ? null : t;
}
