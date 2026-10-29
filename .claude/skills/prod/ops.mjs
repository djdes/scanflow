#!/usr/bin/env node
// Клиент мостика claude-ops: облачная сессия Claude → GitHub Actions → прод-сервер.
// Прямого SSH из облака нет (наружу открыты только 80/443), поэтому команда едет
// через workflow .github/workflows/claude-ops.yml с секретами деплоя этого репозитория.
// Запрос и ответ зашифрованы (см. agent.mjs), в журнале Actions — только шифротекст.
//
//   node ops.mjs run  [--timeout 300] [--cwd DIR] [--label TEXT] (-c 'команды' | -f file.sh | < stdin)
//   node ops.mjs sql  [--write] [--limit 500] [--format tsv|json|vertical] "SELECT ..."
//   node ops.mjs status                 pm2, диск, здоровье приложения
//   node ops.mjs logs [--lines 200] [--err] [имя pm2]
//   node ops.mjs pubkey [--save]        один раз после выкладки workflow: ключ сервера в server.pub
//   node ops.mjs prepare ... / collect <id>   если gh api не может запустить workflow (см. SKILL.md)
//
// Полный ответ сохраняется в output/ops/<id>.txt (каталог в .gitignore).

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8'));
const PUB_FILE = path.join(HERE, 'server.pub');
const ROOT = path.resolve(HERE, '../../..');
const OUT_DIR = path.join(ROOT, 'output', 'ops');
const STATE_DIR = path.join(os.tmpdir(), 'claude-ops');

// Ответ агента закодирован буквами A–P (см. agent.mjs): каждая буква — полубайт.
const fromAP = (s) => Buffer.from(s.replace(/[^A-P]/g, '').replace(/[A-P]/g, (c) => (c.charCodeAt(0) - 65).toString(16)), 'hex');

const log = (...a) => process.stderr.write(a.join(' ') + '\n');
function fail(msg, code = 2) {
  log(`ops: ${msg}`);
  process.exit(code);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- аргументы ----------
const BOOLEAN = new Set(['write', 'save', 'err', 'out', 'print-dispatch', 'help']);

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      opts._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (BOOLEAN.has(key) || next === undefined || next.startsWith('-')) opts[key] = true;
      else {
        opts[key] = next;
        i++;
      }
    } else if (a === '-c' || a === '-f') {
      opts[a.slice(1)] = argv[++i];
    } else opts._.push(a);
  }
  return opts;
}

// ---------- GitHub через gh api (прокси сессии подставляет токен сам) ----------
function gh(args, { input, binary = false, allowFail = false } = {}) {
  const r = spawnSync('gh', ['api', ...args], {
    input,
    encoding: binary ? 'buffer' : 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) {
    if (allowFail) return null;
    const err = binary ? r.stderr.toString() : r.stderr;
    throw new Error(`gh api ${args[0]} ${args.slice(1).join(' ')}: ${String(err || r.stdout).trim().slice(0, 400)}`);
  }
  return binary ? r.stdout : r.stdout;
}
const ghJson = (args, opts) => {
  const out = gh(args, opts);
  return out === null ? null : JSON.parse(out || 'null');
};
const repoPath = (p) => `repos/${CONFIG.repo}/${p}`;

// ---------- шифрование ----------
function serverPub() {
  if (!fs.existsSync(PUB_FILE)) fail(`нет ${path.relative(ROOT, PUB_FILE)}: сначала node ${path.relative(ROOT, path.join(HERE, 'ops.mjs'))} pubkey --save`);
  const der = Buffer.from(fs.readFileSync(PUB_FILE, 'utf8').trim().split(/\s+/)[0], 'base64');
  return { der, key: crypto.createPublicKey({ key: der, format: 'der', type: 'spki' }) };
}
const hkdf = (secret, salt, info) => Buffer.from(crypto.hkdfSync('sha256', secret, salt, Buffer.from(info), 32));

function sealRequest(req) {
  const s = serverPub();
  const eph = crypto.generateKeyPairSync('x25519');
  const cDer = eph.publicKey.export({ type: 'spki', format: 'der' });
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: s.key });
  const k = hkdf(shared, Buffer.concat([cDer, s.der]), 'claude-ops/v1/request');
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, nonce);
  cipher.setAAD(Buffer.from('claude-ops/v1/request'));
  const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(req))), cipher.final(), cipher.getAuthTag()]);
  const armored = Buffer.from(JSON.stringify({ v: 1, c: cDer.toString('base64'), n: nonce.toString('base64'), d: ct.toString('base64') })).toString('base64url');
  return { armored, priv: eph.privateKey.export({ type: 'pkcs8', format: 'pem' }), cDer: cDer.toString('base64') };
}

function openResponse(blob, state) {
  if (blob[0] !== 1) throw new Error(`unknown response version ${blob[0]}`);
  const rDer = blob.subarray(1, 45);
  const nonce = blob.subarray(45, 57);
  const ct = blob.subarray(57);
  const priv = crypto.createPrivateKey(state.priv);
  const cDer = Buffer.from(state.cDer, 'base64');
  const shared = crypto.diffieHellman({ privateKey: priv, publicKey: crypto.createPublicKey({ key: rDer, format: 'der', type: 'spki' }) });
  const k = hkdf(shared, Buffer.concat([rDer, cDer]), 'claude-ops/v1/response');
  const decipher = crypto.createDecipheriv('aes-256-gcm', k, nonce);
  decipher.setAAD(Buffer.from(`claude-ops/v1/response/${state.id}`));
  decipher.setAuthTag(ct.subarray(ct.length - 16));
  const body = Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]);
  return JSON.parse(zlib.gunzipSync(body).toString('utf8'));
}

// ---------- запуск workflow и сбор ответа ----------
const newId = () => `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;

function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(STATE_DIR, `${state.id}.json`), JSON.stringify(state), { mode: 0o600 });
}
function loadState(id) {
  const f = path.join(STATE_DIR, `${id}.json`);
  if (!fs.existsSync(f)) fail(`нет состояния запроса ${id} (его готовил другой контейнер?)`);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

function dispatchInputs(id, mode, armored) {
  return { id, mode, req: armored || '' };
}

function dispatch(inputs) {
  const url = repoPath(`actions/workflows/${CONFIG.workflow}/dispatches`);
  let out;
  try {
    // return_run_details: GitHub сразу отдаёт id запуска; старый API его не знает — тогда без него.
    out = gh(['-X', 'POST', url, '--input', '-'], { input: JSON.stringify({ ref: CONFIG.ref || 'main', inputs, return_run_details: true }) });
  } catch (e) {
    if (!/422|return_run_details/.test(String(e.message))) throw e;
    out = gh(['-X', 'POST', url, '--input', '-'], { input: JSON.stringify({ ref: CONFIG.ref || 'main', inputs }) });
  }
  try {
    const j = JSON.parse(out || '{}');
    return j.workflow_run_id || j.id || null;
  } catch {
    return null;
  }
}

async function findRun(id, deadlineMs) {
  const title = `claude-ops ${id}`;
  while (Date.now() < deadlineMs) {
    const j = ghJson([repoPath(`actions/workflows/${CONFIG.workflow}/runs?event=workflow_dispatch&per_page=30`)], { allowFail: true });
    const run = j && j.workflow_runs && j.workflow_runs.find((r) => r.display_title === title || r.name === title);
    if (run) return run.id;
    await sleep(3000);
  }
  throw new Error(`run «${title}» не появился в Actions. Workflow ${CONFIG.workflow} есть в ветке ${CONFIG.ref || 'main'}?`);
}

async function waitRun(runId, deadlineMs) {
  let last = '';
  while (Date.now() < deadlineMs) {
    const r = ghJson([repoPath(`actions/runs/${runId}`)], { allowFail: true });
    if (r) {
      if (r.status !== last) {
        log(`ops: run ${runId} ${r.status}`);
        last = r.status;
      }
      if (r.status === 'completed') return r;
    }
    await sleep(3000);
  }
  throw new Error(`run ${runId} не завершился вовремя: https://github.com/${CONFIG.repo}/actions/runs/${runId}`);
}

function runLog(runId) {
  const jobs = ghJson([repoPath(`actions/runs/${runId}/jobs`)]);
  const texts = [];
  for (const job of jobs.jobs || []) {
    const t = gh([repoPath(`actions/jobs/${job.id}/logs`)], { allowFail: true });
    if (t) texts.push(t);
  }
  return texts.join('\n').split(/\r?\n/).map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, ''));
}

function extract(lines, id) {
  const meta = lines.find((l) => l.startsWith(`CLAUDE_OPS_META id=${id}`));
  const err = lines.find((l) => l.startsWith('CLAUDE_OPS_ERROR'));
  const pub = lines.find((l) => l.startsWith('CLAUDE_OPS_PUBKEY'));
  const b = lines.findIndex((l) => l === `-----BEGIN CLAUDE-OPS ${id}-----`);
  const e = lines.findIndex((l) => l === `-----END CLAUDE-OPS ${id}-----`);
  const blob = b !== -1 && e > b ? lines.slice(b + 1, e).join('') : null;
  return { meta, err, pub, blob };
}

async function roundTrip(state, { dispatched = false } = {}) {
  const timeoutMs = ((state.timeout || 300) + 240) * 1000;
  const deadline = Date.now() + timeoutMs;
  let runId = null;
  if (!dispatched) {
    runId = dispatch(dispatchInputs(state.id, state.mode, state.armored));
    log(`ops: запрос ${state.id} отправлен в ${CONFIG.repo} (${state.label || state.mode})`);
  }
  if (!runId) runId = await findRun(state.id, Math.min(deadline, Date.now() + 120000));
  const run = await waitRun(runId, deadline);
  const lines = runLog(runId);
  const { meta, err, pub, blob } = extract(lines, state.id);
  if (CONFIG.deleteLogs !== false) gh(['-X', 'DELETE', repoPath(`actions/runs/${runId}/logs`)], { allowFail: true });
  return { run, runId, meta, err, pub, blob, lines };
}

function writeResult(state, res) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stdout = Buffer.from(res.stdout || '', 'base64').toString('utf8');
  const stderr = Buffer.from(res.stderr || '', 'base64').toString('utf8');
  const file = path.join(OUT_DIR, `${state.id}.txt`);
  const head = `# ${CONFIG.project} ${state.label || ''}\n# id=${state.id} code=${res.code} signal=${res.signal} timedOut=${res.timedOut} ms=${res.ms} truncated=${res.truncated} cwd=${res.cwd} user=${res.user} node=${res.node}\n`;
  fs.writeFileSync(file, `${head}\n## stdout\n${stdout}\n## stderr\n${stderr}`);
  return { stdout, stderr, file };
}

async function execute(script, opts, label) {
  const id = newId();
  const req = { v: 1, id, ts: Date.now(), script, timeout: Number(opts.timeout) || 300, cwd: opts.cwd || CONFIG.appDir, label };
  const sealed = sealRequest(req);
  const state = { id, mode: 'run', armored: sealed.armored, priv: sealed.priv, cDer: sealed.cDer, timeout: req.timeout, label };
  saveState(state);
  if (opts['print-dispatch']) {
    process.stdout.write(JSON.stringify({ owner: CONFIG.repo.split('/')[0], repo: CONFIG.repo.split('/')[1], workflow_id: CONFIG.workflow, ref: CONFIG.ref || 'main', inputs: dispatchInputs(id, 'run', sealed.armored) }) + '\n');
    log(`ops: после запуска через MCP: node ${path.relative(process.cwd(), path.join(HERE, 'ops.mjs'))} collect ${id}`);
    return;
  }
  let rt;
  try {
    rt = await roundTrip(state);
  } catch (e) {
    if (/dispatches/.test(String(e.message)) && /403|Resource not accessible|not accessible by integration/i.test(String(e.message))) {
      fail(`gh api не может запустить workflow (${e.message}).\nЗапустите его инструментом mcp__github__actions_run_trigger: node ops.mjs run --print-dispatch ... и затем collect <id>`);
    }
    throw e;
  }
  return finish(state, rt);
}

function finish(state, rt) {
  if (rt.err) fail(`агент: ${rt.err.replace('CLAUDE_OPS_ERROR ', '')} (run https://github.com/${CONFIG.repo}/actions/runs/${rt.runId})`);
  if (!rt.blob) {
    const tail = rt.lines.filter(Boolean).slice(-25).join('\n');
    fail(`в журнале run ${rt.runId} нет ответа (conclusion=${rt.run.conclusion}). Хвост журнала:\n${tail}`);
  }
  const res = openResponse(fromAP(rt.blob), state);
  const { stdout, stderr, file } = writeResult(state, res);
  const limit = 60000;
  process.stdout.write(stdout.length > limit ? `${stdout.slice(0, limit)}\n… [обрезано, полностью: ${path.relative(process.cwd(), file)}]\n` : stdout);
  if (stderr.trim()) process.stderr.write(stderr.length > 20000 ? `${stderr.slice(-20000)}\n` : stderr);
  log(`ops: code=${res.code}${res.timedOut ? ' (таймаут)' : ''} ${res.ms} ms, ${res.user}@${res.host} → ${path.relative(process.cwd(), file)}`);
  try {
    fs.unlinkSync(path.join(STATE_DIR, `${state.id}.json`));
  } catch {}
  process.exitCode = res.code === 0 ? 0 : res.code || 1;
}

// ---------- готовые сценарии ----------
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function sqlScript(sqlText, opts) {
  const db = CONFIG.db;
  const flags = [
    `--env ${q(db.envFile)}`,
    db.urlVar ? `--url-var ${q(db.urlVar)}` : `--vars ${q(db.vars.join(','))}`,
    `--node-path ${q(db.nodePath)}`,
    `--limit ${Number(opts.limit) || 500}`,
    `--format ${q(opts.format || 'tsv')}`,
    `--timeout ${Number(opts['query-timeout']) || 60}`,
    opts.write ? '--write' : '',
  ].join(' ');
  const tag = `SQL_${crypto.randomBytes(6).toString('hex')}`;
  return `node "$HOME/.claude-ops/bin/sql.cjs" ${flags} <<'${tag}'\n${sqlText}\n${tag}\n`;
}

function statusScript() {
  return [
    'echo "== $(whoami)@$(hostname)  $(date -Is)  uptime:$(uptime -p 2>/dev/null)"',
    'echo "== node $(node -v 2>/dev/null)  pm2 $(pm2 -v 2>/dev/null)"',
    `pm2 jlist 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const i=s.indexOf("[");const l=JSON.parse(i>=0?s.slice(i):"[]");for(const p of l){const e=p.pm2_env||{};console.log([p.name,e.status,"pid="+p.pid,"restarts="+e.restart_time,"up="+(e.pm_uptime?Math.round((Date.now()-e.pm_uptime)/60000)+"m":"-"),"mem="+Math.round(((p.monit||{}).memory||0)/1048576)+"MB","cpu="+((p.monit||{}).cpu||0)+"%"].join("  "))}})'`,
    'echo "== disk"; df -h "$HOME" 2>/dev/null | tail -1',
    `echo "== health"; curl -sS -m 10 -o /dev/null -w "%{http_code} %{time_total}s\\n" ${q(CONFIG.localHealth || CONFIG.health)} || true`,
    `echo "== git/build"; cd ${q(CONFIG.appDir)} 2>/dev/null && { git log --oneline -1 2>/dev/null || cat .build-sha 2>/dev/null || ls -la --time-style=+%F_%T . | head -5; }`,
  ].join('\n');
}

function logsScript(opts) {
  const name = opts._[1] || (CONFIG.pm2 || [])[0];
  const lines = Number(opts.lines) || 200;
  const which = opts.err ? '--err' : opts.out ? '--out' : '';
  return `pm2 logs ${q(name)} --nostream --lines ${lines} ${which} 2>&1 | sed -e 's/\\x1b\\[[0-9;]*m//g'`;
}

// ---------- main ----------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cmd = opts._[0];
  if (!cmd || cmd === 'help' || opts.help) {
    process.stdout.write(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 16).join('\n') + '\n');
    return;
  }
  if (cmd === 'pubkey') {
    const id = newId();
    const state = { id, mode: 'pubkey', armored: '', timeout: 60, label: 'pubkey' };
    const rt = await roundTrip(state);
    if (rt.err) fail(rt.err);
    if (!rt.pub) fail(`ключа нет в журнале run ${rt.runId} (conclusion=${rt.run.conclusion})`);
    const [, ap, fp] = rt.pub.split(/\s+/);
    const der = fromAP(ap);
    const line = `${der.toString('base64')} ${fp} ${CONFIG.project} ${new Date().toISOString().slice(0, 10)}\n`;
    process.stdout.write(line);
    if (opts.save) {
      fs.writeFileSync(PUB_FILE, line);
      log(`ops: сохранено в ${path.relative(process.cwd(), PUB_FILE)} — закоммитьте его`);
    }
    return;
  }
  if (cmd === 'collect') {
    const state = loadState(opts._[1]);
    return finish(state, await roundTrip(state, { dispatched: true }));
  }
  if (cmd === 'run' || cmd === 'prepare') {
    if (cmd === 'prepare') opts['print-dispatch'] = true;
    let script = opts.c;
    if (!script && opts.f) script = fs.readFileSync(opts.f, 'utf8');
    if (!script && opts._.length > 1) script = opts._.slice(1).join(' ');
    if (!script && !process.stdin.isTTY) script = fs.readFileSync(0, 'utf8');
    if (!script || !script.trim()) fail('нечего выполнять: -c "команды", -f файл или stdin');
    return execute(script, opts, opts.label || script.trim().split('\n')[0].slice(0, 80));
  }
  if (cmd === 'sql') {
    const text = opts._.slice(1).join(' ') || (!process.stdin.isTTY ? fs.readFileSync(0, 'utf8') : '');
    if (!text.trim()) fail('нет запроса');
    return execute(sqlScript(text.trim(), opts), opts, `sql${opts.write ? ' WRITE' : ''}: ${text.trim().replace(/\s+/g, ' ').slice(0, 60)}`);
  }
  if (cmd === 'status') return execute(statusScript(), opts, 'status');
  if (cmd === 'logs') return execute(logsScript(opts), opts, 'logs');
  fail(`неизвестная команда ${cmd}; node ops.mjs help`);
}

main().catch((e) => fail(String((e && e.message) || e)));
