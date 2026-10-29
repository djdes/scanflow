#!/usr/bin/env node
// Агент мостика claude-ops: живёт на прод-сервере под пользователем деплоя
// (~/.claude-ops/bin/agent.mjs), его туда кладёт и запускает workflow
// .github/workflows/claude-ops.yml. Клиент — ops.mjs в облачной сессии Claude.
//
//   node agent.mjs pubkey        — создать ключ сервера (один раз) и напечатать открытый ключ
//   node agent.mjs run <id>      — stdin: зашифрованный запрос; stdout: зашифрованный ответ
//
// Запрос шифруется на открытый ключ сервера (X25519 + HKDF-SHA256 + AES-256-GCM),
// ответ — на одноразовый ключ клиента, с одноразовым ключом сервера. В журнал
// GitHub Actions попадает только шифротекст: репозиторий может быть публичным.
// Только встроенные модули Node: на сервере нет npm install для этого файла.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';

const STATE = path.join(os.homedir(), '.claude-ops');
const KEY_FILE = path.join(STATE, 'server.key');
const SEEN_DIR = path.join(STATE, 'seen');
const AUDIT = path.join(STATE, 'audit.log');

const MAX_SKEW_MS = 15 * 60 * 1000;
const SEEN_TTL_MS = 2 * 24 * 3600 * 1000;
const DEFAULT_TIMEOUT_S = 300;
const MAX_TIMEOUT_S = 1500;
const DEFAULT_MAX_OUTPUT = 8 * 1024 * 1024;
const LINE = 8000;

// Буквы A–P вместо base64: GitHub маскирует в журнале значения секретов
// (порт, имя пользователя), и случайное совпадение внутри base64 испортило бы шифротекст.
const ALPHA = 'ABCDEFGHIJKLMNOP';
const toAP = (buf) => buf.toString('hex').replace(/[0-9a-f]/g, (c) => ALPHA[parseInt(c, 16)]);

function die(msg) {
  process.stdout.write(`CLAUDE_OPS_ERROR ${msg}\n`);
  process.exit(2);
}

function ensureState() {
  fs.mkdirSync(SEEN_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(STATE, 0o700);
}

function serverKey() {
  ensureState();
  if (!fs.existsSync(KEY_FILE)) {
    const { privateKey } = crypto.generateKeyPairSync('x25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    fs.writeFileSync(KEY_FILE, pem, { mode: 0o600, flag: 'wx' });
  }
  const privateKey = crypto.createPrivateKey(fs.readFileSync(KEY_FILE));
  const publicKey = crypto.createPublicKey(privateKey);
  return { privateKey, publicKey, pubDer: publicKey.export({ type: 'spki', format: 'der' }) };
}

const pubFromDer = (der) => crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });

function hkdf(secret, salt, info) {
  return Buffer.from(crypto.hkdfSync('sha256', secret, salt, Buffer.from(info), 32));
}

function decryptRequest(armored, key) {
  let env;
  try {
    env = JSON.parse(Buffer.from(armored.trim(), 'base64url').toString('utf8'));
  } catch {
    die('request is not valid base64url JSON');
  }
  if (env.v !== 1) die(`unsupported request version ${env.v}`);
  const cDer = Buffer.from(env.c, 'base64');
  const shared = crypto.diffieHellman({ privateKey: key.privateKey, publicKey: pubFromDer(cDer) });
  const k = hkdf(shared, Buffer.concat([cDer, key.pubDer]), 'claude-ops/v1/request');
  const data = Buffer.from(env.d, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(env.n, 'base64'));
  decipher.setAAD(Buffer.from('claude-ops/v1/request'));
  decipher.setAuthTag(data.subarray(data.length - 16));
  let plain;
  try {
    plain = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
  } catch {
    die('request does not decrypt with this server key (server.pub out of date?)');
  }
  return { req: JSON.parse(plain.toString('utf8')), cDer };
}

function encryptResponse(obj, cDer, id) {
  const eph = crypto.generateKeyPairSync('x25519');
  const rDer = eph.publicKey.export({ type: 'spki', format: 'der' });
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: pubFromDer(cDer) });
  const k = hkdf(shared, Buffer.concat([rDer, cDer]), 'claude-ops/v1/response');
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, nonce);
  cipher.setAAD(Buffer.from(`claude-ops/v1/response/${id}`));
  const body = zlib.gzipSync(Buffer.from(JSON.stringify(obj)));
  const ct = Buffer.concat([cipher.update(body), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([Buffer.from([1]), rDer, nonce, ct]);
}

// Повтор того же запроса (перезапуск run в Actions) не исполняется второй раз.
function markSeen(id) {
  const now = Date.now();
  for (const f of fs.readdirSync(SEEN_DIR)) {
    try {
      if (now - fs.statSync(path.join(SEEN_DIR, f)).mtimeMs > SEEN_TTL_MS) fs.unlinkSync(path.join(SEEN_DIR, f));
    } catch {}
  }
  try {
    fs.writeFileSync(path.join(SEEN_DIR, id), String(now), { flag: 'wx', mode: 0o600 });
  } catch {
    die(`request ${id} was already executed (replay)`);
  }
}

function audit(line) {
  try {
    fs.appendFileSync(AUDIT, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
  } catch {}
}

function runScript(req) {
  const timeoutS = Math.min(Math.max(Number(req.timeout) || DEFAULT_TIMEOUT_S, 1), MAX_TIMEOUT_S);
  const maxOut = Math.min(Number(req.maxOutput) || DEFAULT_MAX_OUTPUT, 64 * 1024 * 1024);
  let cwd = os.homedir();
  if (req.cwd) {
    const want = String(req.cwd).replace(/^~(?=\/|$)/, os.homedir());
    if (fs.existsSync(want)) cwd = want;
  }
  // nvm подключается здесь, а не в ~/.bashrc: у пользователей FastPanel он разный.
  const preamble =
    'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1; ' +
    'export PATH="$HOME/.claude-ops/bin:$PATH"\n';
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('bash', ['-c', preamble + req.script], {
      cwd,
      env: { ...process.env, CLAUDE_OPS: '1', CLAUDE_OPS_ID: req.id, TERM: 'dumb', PAGER: 'cat', PM2_NO_INTERACTION: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const out = { stdout: [], stderr: [], size: { stdout: 0, stderr: 0 }, truncated: false };
    for (const name of ['stdout', 'stderr']) {
      child[name].on('data', (chunk) => {
        if (out.size[name] >= maxOut) {
          out.truncated = true;
          return;
        }
        const room = maxOut - out.size[name];
        const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
        if (part.length < chunk.length) out.truncated = true;
        out[name].push(part);
        out.size[name] += part.length;
      });
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {}
      setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
      }, 5000).unref();
    }, timeoutS * 1000);
    const finish = (code, signal, error) => {
      clearTimeout(timer);
      resolve({
        id: req.id,
        code,
        signal: signal || null,
        timedOut,
        error: error || null,
        ms: Date.now() - started,
        cwd,
        truncated: out.truncated,
        stdout: Buffer.concat(out.stdout).toString('base64'),
        stderr: Buffer.concat(out.stderr).toString('base64'),
        host: os.hostname(),
        user: os.userInfo().username,
        node: process.version,
      });
    };
    child.on('error', (e) => finish(null, null, String(e && e.message)));
    child.on('close', (code, signal) => finish(code, signal));
  });
}

async function main() {
  const [mode, id] = process.argv.slice(2);
  if (mode === 'pubkey') {
    const key = serverKey();
    const fp = crypto.createHash('sha256').update(key.pubDer).digest('hex').slice(0, 16);
    process.stdout.write(`CLAUDE_OPS_PUBKEY ${toAP(key.pubDer)} ${fp}\n`);
    return;
  }
  if (mode !== 'run') die('usage: agent.mjs pubkey | run <id>');
  if (!/^[a-z0-9-]{6,64}$/.test(id || '')) die('bad request id');
  const key = serverKey();
  const armored = fs.readFileSync(0, 'utf8');
  const { req, cDer } = decryptRequest(armored, key);
  if (req.id !== id) die('request id does not match the run');
  if (Math.abs(Date.now() - Number(req.ts)) > MAX_SKEW_MS) die('request is too old or from the future');
  if (typeof req.script !== 'string' || !req.script.trim()) die('empty script');
  markSeen(id);
  const scriptHash = crypto.createHash('sha256').update(req.script).digest('hex').slice(0, 16);
  audit(`start id=${id} script=${scriptHash} label=${JSON.stringify(String(req.label || '').slice(0, 80))}`);
  const res = await runScript(req);
  audit(`done  id=${id} code=${res.code} signal=${res.signal} timedOut=${res.timedOut} ms=${res.ms}`);
  const blob = toAP(encryptResponse(res, cDer, id));
  let text = `CLAUDE_OPS_META id=${id} code=${res.code} timedOut=${res.timedOut} ms=${res.ms} truncated=${res.truncated}\n`;
  text += `-----BEGIN CLAUDE-OPS ${id}-----\n`;
  for (let i = 0; i < blob.length; i += LINE) text += blob.slice(i, i + LINE) + '\n';
  text += `-----END CLAUDE-OPS ${id}-----\n`;
  process.stdout.write(text);
}

main().catch((e) => die(String((e && e.stack) || e).replace(/\s+/g, ' ').slice(0, 500)));
