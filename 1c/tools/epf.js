#!/usr/bin/env node
// Обновление обработки КНД_ЗагрузкаНакладныхСканер без Конфигуратора.
//
//   node 1c/tools/epf.js build  <база.epf> <новая.epf>   — модуль объекта из исходника → в копию собранной обработки
//   node 1c/tools/epf.js backup <файл.epf>               — скачать обработку, которая сейчас стоит в 1С
//   node 1c/tools/epf.js check  <файл.epf>               — подключить и скомпилировать в 1С, ничего не записывая
//   node 1c/tools/epf.js deploy <файл.epf>               — записать в «Дополнительные отчёты и обработки»
//
// build меняет ТОЛЬКО текст модуля объекта: формы и реквизиты берутся из базового
// .epf как есть. Если с момента его сборки менялись формы/реквизиты — собирать в
// Конфигураторе (docs: reference_1c_epf_build_workflow). check/backup/deploy идут
// через MCP Toolkit в 1С: MCP1C_URL (по умолчанию http://192.168.33.213:6004),
// MCP1C_TOKEN — токен из формы MCP Toolkit в 1С (в репозиторий не класть).
const fs = require('fs');
const path = require('path');
const v8 = require('./v8container');

const MODULE = path.join(__dirname, '..', 'КНД_ЗагрузкаНакладныхСканер', 'КНД_ЗагрузкаНакладныхСканер', 'Ext', 'ObjectModule.bsl');
const OBJECT_NAME = 'КНД_ЗагрузкаНакладныхСканер';
const BLOCK_RX = /\r\n[0-9a-f]{8} [0-9a-f]{8} [0-9a-f]{8} \r\n/g;
const blocks = (buf) => [...buf.toString('latin1').matchAll(BLOCK_RX)].map(m => m.index + ':' + m[0].trim());

function build(basePath, outPath) {
  const src = fs.readFileSync(basePath);
  const outer = v8.parse(src);
  if (!v8.build(outer).equals(src)) throw new Error('внешний контейнер не воспроизводится — формат не тот, собирайте в Конфигураторе');
  const root = v8.inflate(outer.files.find(f => f.name === 'root').data).toString('utf8');
  const mainId = root.match(/\{2,([0-9a-f-]{36}),/)[1];
  const desc = v8.inflate(outer.files.find(f => f.name === mainId).data).toString('utf8');
  const objId = desc.match(new RegExp(`\\{1,0,([0-9a-f-]{36})\\},"${OBJECT_NAME}"`))[1];
  const modEntry = outer.files.find(f => f.name === objId + '.0');
  const innerRaw = v8.inflate(modEntry.data);
  const inner = v8.parse(innerRaw);
  // Вложенный контейнер 1С пишет без добивки оглавления; мусор в добивке блоков не важен.
  const re = v8.build(v8.parse(innerRaw), { tocPad: false });
  if (re.length !== innerRaw.length || blocks(re).join('|') !== blocks(innerRaw).join('|')) throw new Error('вложенный контейнер не воспроизводится');

  const textEntry = inner.files.find(f => f.name === 'text');
  const s = fs.readFileSync(MODULE, 'utf8').replace(/^﻿/, '').replace(/\r?\n/g, '\r\n');
  const newText = Buffer.from('﻿' + s, 'utf8');
  console.log(`модуль: было ${textEntry.data.length} байт, стало ${newText.length}`);
  textEntry.data = newText;
  modEntry.data = v8.deflate(v8.build(inner, { tocPad: false }));
  const out = v8.build(outer);

  // Всё, кроме текста модуля, — побайтно как в базовом файле.
  const chk = v8.parse(out);
  const orig = v8.parse(src);
  if (chk.files.map(f => f.name).join() !== orig.files.map(f => f.name).join()) throw new Error('состав файлов');
  for (const f of chk.files) {
    const o = orig.files.find(x => x.name === f.name);
    if (!o.header.equals(f.header)) throw new Error('заголовок ' + f.name);
    if (f.name !== modEntry.name) { if (!f.data.equals(o.data)) throw new Error('данные ' + f.name); continue; }
    const a = v8.parse(v8.inflate(f.data)).files;
    const b = v8.parse(v8.inflate(o.data)).files;
    for (const x of a) {
      const y = b.find(z => z.name === x.name);
      if (!y || !x.header.equals(y.header)) throw new Error('модуль: ' + x.name);
      if (x.name === 'text' ? !x.data.equals(newText) : !x.data.equals(y.data)) throw new Error('модуль: ' + x.name);
    }
  }
  fs.writeFileSync(outPath, out);
  console.log(`готово: ${outPath} (${out.length} байт)`);
}

// ── MCP Toolkit 1С (транспорт SSE: GET /mcp → endpoint, POST JSON-RPC, ответы в поток) ──
async function mcpExecute(code) {
  const base = process.env.MCP1C_URL || 'http://192.168.33.213:6004';
  const token = process.env.MCP1C_TOKEN;
  if (!token) throw new Error('нужен MCP1C_TOKEN — токен из формы MCP Toolkit в 1С');
  const headers = { Authorization: `Bearer ${token}` };
  const ctrl = new AbortController();
  const res = await fetch(base + '/mcp', { headers: { ...headers, Accept: 'text/event-stream' }, signal: ctrl.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const waiters = new Map();
  let buf = '';
  let endpoint;
  let gotEndpoint;
  const endpointP = new Promise(r => { gotEndpoint = r; });
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const ev = buf.slice(0, i); buf = buf.slice(i + 2);
          const type = (ev.match(/^event: (.*)$/m) || [])[1] || 'message';
          const data = ev.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
          if (type === 'endpoint') { endpoint = data; gotEndpoint(); continue; }
          try { const m = JSON.parse(data); if (waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); } } catch { /* не JSON */ }
        }
      }
    } catch (e) { if (e.name !== 'AbortError') console.error('SSE:', e.message); }
  })();
  await endpointP;
  let id = 0;
  const rpc = async (method, params, notify = false) => {
    const body = notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++id, method, params };
    const p = notify ? null : new Promise((resolve, reject) => { waiters.set(body.id, resolve); setTimeout(() => reject(new Error('таймаут')), 300000).unref(); });
    const r = await fetch(base + endpoint, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status >= 400) throw new Error(`${method}: HTTP ${r.status}`);
    return p;
  };
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'scanflow-epf', version: '1.0' } });
  await rpc('notifications/initialized', {}, true);
  const m = await rpc('tools/call', { name: 'execute_code', arguments: { code } });
  // Закрыть поток SSE и не звать process.exit(): abort() + exit() роняет Node на Windows (libuv).
  await reader.cancel().catch(() => {});
  ctrl.abort();
  const text = m.result?.content?.[0]?.text ?? JSON.stringify(m.error ?? m);
  const j = JSON.parse(text);
  if (!j.success) throw new Error(j.error || text);
  return j.data; // JSON или TOON — как настроено в форме MCP Toolkit
}

const findRef = `Ссылка = Справочники.ДополнительныеОтчетыИОбработки.НайтиПоРеквизиту("ИмяОбъекта", "${OBJECT_NAME}");
Если НЕ ЗначениеЗаполнено(Ссылка) Тогда ВызватьИсключение "обработка ${OBJECT_NAME} не зарегистрирована"; КонецЕсли;`;

async function main() {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'build') return build(a, b);
  if (cmd === 'backup') {
    const data = await mcpExecute(`${findRef}\nРезультат = Новый Структура("ИмяФайла, Base64", Ссылка.ИмяФайла, Base64Строка(Ссылка.ХранилищеОбработки.Получить()));`);
    const raw = typeof data === 'string' ? data.match(/Base64: "([^"]*)"/)[1] : data.Base64;
    const bin = Buffer.from(raw.split('\\r').join('').split('\\n').join('').replace(/\s+/g, ''), 'base64');
    fs.writeFileSync(a, bin);
    return console.log(`сохранено: ${a} (${bin.length} байт)`);
  }
  const b64 = fs.readFileSync(a).toString('base64');
  if (cmd === 'check') {
    // Подключение компилирует модуль: синтаксическая ошибка → исключение. В справочник ничего не пишется.
    return console.log(await mcpExecute(`ДД = Base64Значение("${b64}");
Имя = ВнешниеОбработки.Подключить(ПоместитьВоВременноеХранилище(ДД, Новый УникальныйИдентификатор), , Ложь);
Сведения = ВнешниеОбработки.Создать(Имя).СведенияОВнешнейОбработке();
Команды = Новый Массив;
Для Каждого К Из Сведения.Команды Цикл Команды.Добавить(К.Идентификатор); КонецЦикла;
Результат = Новый Структура("Имя, Версия, Команды", Имя, Сведения.Версия, СтрСоединить(Команды, ", "));`));
  }
  if (cmd === 'deploy') {
    // Как форма элемента БСП: хранилище со сжатием 9. Команды и расписание не трогаем
    // (без ДополнительныеСвойства.АктуальныеКоманды ПриЗаписи их не пересоздаёт).
    return console.log(await mcpExecute(`ДД = Base64Значение("${b64}");
${findRef}
Объект = Ссылка.ПолучитьОбъект();
Объект.ХранилищеОбработки = Новый ХранилищеЗначения(ДД, Новый СжатиеДанных(9));
Объект.ИмяФайла = "${path.basename(a)}";
Объект.Записать();
Имя = ДополнительныеОтчетыИОбработки.ПодключитьВнешнююОбработку(Ссылка);
ВнешниеОбработки.Создать(Имя);
Результат = Новый Структура("ИмяФайла, Размер, Совпадает", Ссылка.ИмяФайла, ДД.Размер(), Base64Строка(Ссылка.ХранилищеОбработки.Получить()) = Base64Строка(ДД));`));
  }
  console.log('команды: build | backup | check | deploy');
}

main().catch(e => { console.error('ошибка:', e.message); process.exitCode = 1; });
