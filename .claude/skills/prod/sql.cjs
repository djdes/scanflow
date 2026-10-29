#!/usr/bin/env node
// SQL к прод-базе через мостик claude-ops (запускается на сервере, см. ops.mjs sql).
// По умолчанию ТОЛЬКО ЧТЕНИЕ: разрешены SELECT/SHOW/DESCRIBE/EXPLAIN/WITH, сессия
// переводится в READ ONLY (MariaDB тогда отвергает и INSERT/UPDATE, и CREATE/DROP),
// а SELECT без LIMIT ограничен sql_select_limit. Запись — только с --write.
//
//   node sql.cjs --env <файл .env> (--url-var DATABASE_URL | --vars HOST,PORT,USER,PASS,DB)
//                --node-path <каталог node_modules>[:<ещё>] [--write] [--limit 500]
//                [--format tsv|json|vertical] [--timeout 60]   < запрос в stdin

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
}
const flag = (name) => process.argv.includes(`--${name}`);
const expand = (p) => String(p || '').replace(/^~(?=\/|$)/, os.homedir());

function fail(msg) {
  process.stderr.write(`sql: ${msg}\n`);
  process.exit(2);
}

function parseEnv(file) {
  const out = {};
  const text = fs.readFileSync(file, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v.replace(/\\\$/g, '$');
  }
  return out;
}

function connectionConfig() {
  const envFile = expand(arg('env'));
  if (!envFile || !fs.existsSync(envFile)) fail(`env file not found: ${envFile}`);
  const env = parseEnv(envFile);
  const urlVar = arg('url-var');
  if (urlVar) {
    const raw = env[urlVar];
    if (!raw) fail(`${urlVar} is empty in ${envFile}`);
    const u = new URL(raw);
    return {
      host: u.hostname || 'localhost',
      port: Number(u.port || 3306),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: decodeURIComponent(u.pathname.replace(/^\//, '')),
    };
  }
  const vars = String(arg('vars', '')).split(',');
  if (vars.length !== 5) fail('--vars needs HOST,PORT,USER,PASS,DB variable names');
  const [h, p, us, pw, db] = vars.map((k) => env[k]);
  return { host: h || 'localhost', port: Number(p || 3306), user: us, password: pw, database: db };
}

function loadDriver() {
  const dirs = String(arg('node-path', '')).split(':').map(expand).filter(Boolean);
  for (const dir of dirs) {
    const req = createRequire(path.join(dir, 'noop.js'));
    for (const name of ['mysql2/promise', 'mariadb']) {
      try {
        return { name, mod: req(name) };
      } catch {}
    }
  }
  fail(`no mysql2 or mariadb driver under ${dirs.join(', ')}`);
}

const READ_OK = /^(select|show|desc|describe|explain|with)\b/i;

function stripLeadingComments(sql) {
  let s = sql.trim();
  for (;;) {
    if (s.startsWith('--') || s.startsWith('#')) s = s.replace(/^[^\n]*\n?/, '').trim();
    else if (s.startsWith('/*')) s = s.replace(/^\/\*[\s\S]*?\*\//, '').trim();
    else return s;
  }
}

function cell(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'bigint') return v.toString();
  if (Buffer.isBuffer(v)) return v.length > 64 ? `<blob ${v.length} bytes>` : `0x${v.toString('hex')}`;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
  return String(v);
}

async function main() {
  const write = flag('write');
  const limit = Math.max(1, Number(arg('limit', 500)));
  const format = arg('format', 'tsv');
  const timeoutS = Math.max(1, Number(arg('timeout', 60)));
  const sql = stripLeadingComments(fs.readFileSync(0, 'utf8')).replace(/;\s*$/, '');
  if (!sql) fail('empty query');
  if (!write && !READ_OK.test(sql)) fail('read-only mode allows SELECT/SHOW/DESCRIBE/EXPLAIN/WITH; pass --write for changes');
  if (sql.includes(';')) {
    // Один запрос за вызов: иначе READ ONLY можно было бы снять следующим оператором.
    const quoted = sql.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`]*`/g, '');
    if (quoted.includes(';')) fail('one statement per call');
  }

  const cfg = connectionConfig();
  const { name, mod } = loadDriver();
  const common = { ...cfg, dateStrings: true, connectTimeout: 10000 };
  // Большие BIGINT строкой: числом JS они теряют младшие разряды.
  const conn = name === 'mariadb' ? await mod.createConnection({ ...common, bigIntAsNumber: false }) : await mod.createConnection({ ...common, supportBigNumbers: true, bigNumberStrings: true });
  const q = async (text) => {
    const r = await conn.query(text);
    return name === 'mariadb' ? [r, r && r.meta] : r;
  };
  try {
    await q(`SET SESSION max_statement_time = ${timeoutS}`).catch(() => {});
    if (!write) {
      await q('SET SESSION TRANSACTION READ ONLY');
      await q(`SET SESSION sql_select_limit = ${limit + 1}`);
    }
    const started = Date.now();
    const [rows, fields] = await q(sql);
    const ms = Date.now() - started;
    if (!Array.isArray(rows)) {
      const r = rows || {};
      process.stdout.write(`affectedRows=${cell(r.affectedRows)} insertId=${cell(r.insertId)} warnings=${cell(r.warningStatus ?? r.warnings)} ms=${ms}\n`);
      return;
    }
    // У mysql2 имя колонки — свойство, у драйвера mariadb 3.x — метод name().
    const colName = (f) => (typeof f.name === 'function' ? f.name() : f.name) || f.columnName || String(f);
    const cols = fields && fields.length ? fields.map(colName) : Object.keys(rows[0] || {});
    const shown = rows.slice(0, limit);
    if (format === 'json') {
      for (const r of shown) process.stdout.write(JSON.stringify(r, (_k, x) => (typeof x === 'bigint' ? x.toString() : Buffer.isBuffer(x) ? cell(x) : x)) + '\n');
    } else if (format === 'vertical') {
      shown.forEach((r, i) => {
        process.stdout.write(`*************************** ${i + 1}. row ***************************\n`);
        const w = Math.max(...cols.map((c) => c.length));
        for (const c of cols) process.stdout.write(`${c.padStart(w)}: ${cell(r[c])}\n`);
      });
    } else {
      process.stdout.write(cols.join('\t') + '\n');
      for (const r of shown) process.stdout.write(cols.map((c) => cell(r[c]).replace(/\t/g, ' ').replace(/\r?\n/g, '\\n')).join('\t') + '\n');
    }
    const more = rows.length > limit ? ` (обрезано до ${limit}; уточните запрос или --limit)` : '';
    process.stderr.write(`-- ${shown.length} row(s)${more}, ${ms} ms, ${name}${write ? ', WRITE' : ', read-only'}\n`);
  } finally {
    await conn.end().catch(() => {});
  }
}

main().catch((e) => fail(String((e && e.message) || e)));
