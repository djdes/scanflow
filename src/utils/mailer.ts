import nodemailer from 'nodemailer';
import { logger } from './logger';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const MAIL_TO = process.env.MAIL_TO || '';
const MAIL_FROM = process.env.MAIL_FROM || 'ScanFlow <noreply@scanflow.ru>';
const SENDMAIL_PATH = process.env.SENDMAIL_PATH || '/usr/sbin/sendmail';

interface MailPayload {
  from: string;
  to: string;
  subject: string;
  html: string;
}
type TransportKind = 'smtp' | 'sendmail' | 'disk';
interface Sender {
  send: (msg: MailPayload) => Promise<void>;
  kind: TransportKind;
}

// MIME-encoded Subject для UTF-8. Если все символы ASCII — оставляем как есть.
function encodeSubject(s: string): string {
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

// Прямой spawn /usr/sbin/sendmail -t -i, без nodemailer'овской обвязки.
// Причина: nodemailer.sendmail-transport всегда приклеивает envelope.to в
// argv (`sendmail -i -t -i recipient@x`), и на FastPanel-exim4 такая
// инвокация молча роняется. Только то, что генерирует PHP mail() — чистый
// `sendmail -t -i` с пайпом RFC822 в stdin — реально шлёт outbound.
// Diff-тест на проде подтвердил: SP1 (ASCII) и SP2 (cyrillic) через
// этот путь доставляются Gmail.
async function pipeToSendmail(msg: MailPayload): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(SENDMAIL_PATH, ['-t', '-i'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.once('error', reject);
    child.once('exit', (code) => code === 0
      ? resolve()
      : reject(new Error(`sendmail exit ${code}: ${stderr.slice(0, 200)}`)));
    const messageId = `<${randomBytes(8).toString('hex')}.${Date.now()}@scanflow.ru>`;
    const body = [
      `To: ${msg.to}`,
      `From: ${msg.from}`,
      `Subject: ${encodeSubject(msg.subject)}`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: ${messageId}`,
      '',
      msg.html,
    ].join('\r\n');
    child.stdin.end(body, 'utf8');
  });
}

// Sender factory. Три стратегии в порядке убывания приоритета:
//   1) SMTP-relay — если SMTP_HOST/USER/PASS заданы (Yandex/Resend/прочее)
//   2) sendmail pipe — Linux + /usr/sbin/sendmail (FastPanel/cPanel-хостинги)
//   3) disk-fallback — Windows-дев или сервер без mailer'а (writeEmailToDisk)
let cachedSender: Sender | null | undefined;
function getSender(): Sender | null {
  if (cachedSender !== undefined) return cachedSender;
  if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      tls: { rejectUnauthorized: false },
    });
    cachedSender = {
      kind: 'smtp',
      send: async (msg) => {
        await transporter.sendMail(msg);
      },
    };
    logger.info('Mailer: using SMTP relay', { host: SMTP_HOST, port: SMTP_PORT });
    return cachedSender;
  }
  if (process.platform !== 'win32' && fs.existsSync(SENDMAIL_PATH)) {
    cachedSender = { kind: 'sendmail', send: pipeToSendmail };
    logger.info('Mailer: using local sendmail (spawn -t -i)', { path: SENDMAIL_PATH });
    return cachedSender;
  }
  cachedSender = null;
  logger.warn('Mailer: no transport available — falling back to disk');
  return cachedSender;
}

let lastSentAt = 0;
const MIN_INTERVAL_MS = 30_000; // max 1 email per 30 seconds

export async function sendErrorEmail(subject: string, details: string): Promise<void> {
  if (!MAIL_TO) {
    logger.debug('MAIL_TO not set, skipping error email', { subject });
    return;
  }
  const sender = getSender();
  if (!sender) return;

  const now = Date.now();
  if (now - lastSentAt < MIN_INTERVAL_MS) {
    logger.debug('Skipping error email (rate limited)', { subject });
    return;
  }

  try {
    lastSentAt = now;
    await sender.send({
      from: SMTP_USER ? `"ScanFlow Errors" <${SMTP_USER}>` : MAIL_FROM,
      to: MAIL_TO,
      subject: `[ScanFlow] ${subject}`,
      html: `
        <h3 style="color:#b91c1c">${subject}</h3>
        <pre style="background:#f8fafc;padding:16px;border-radius:8px;font-size:13px;overflow-x:auto">${details}</pre>
        <p style="color:#94a3b8;font-size:12px">Сервер: ${process.env.HOSTNAME || 'scan.magday.ru'} · ${new Date().toLocaleString('ru-RU')}</p>
      `,
    });
    logger.info('Error email sent', { subject, to: MAIL_TO, via: sender.kind });
  } catch (err) {
    logger.error('Failed to send error email', { error: (err as Error).message, subject });
  }
}

// Send a domain-event notification to a specific recipient. Unlike
// sendErrorEmail, this:
//   - takes the `to` address explicitly (per-user, not global MAIL_TO)
//   - has no rate limit (digest mode handles regulation)
// Throws on failure so the caller can decide whether to retry/log.
export async function sendNotification(to: string, subject: string, html: string): Promise<void> {
  if (!to) throw new Error('sendNotification: empty `to` address');
  const sender = getSender();
  if (!sender) throw new Error('Mailer transport not available (no SMTP, no /usr/sbin/sendmail)');
  await sender.send({
    from: MAIL_FROM,
    to,
    subject: `[ScanFlow] ${subject}`,
    html,
  });
  logger.info('Notification email sent', { subject, to, via: sender.kind });
}

// True if any mailer transport is available (SMTP env vars OR sendmail
// binary on Linux). Used by /api/profile to surface a server-side hint.
export function smtpConfigured(): boolean {
  return getSender() !== null;
}

// ─── Auth (welcome / recover) email ──────────────────────────────────────────
//
// Письмо после регистрации или восстановления: логин, временный пароль и
// большая кнопка «Открыть кабинет» c magic-token URL для one-click входа.
// Тот же template обслуживает оба сценария — отличается только заголовок.
//
// Если SMTP не настроен (dev / staging без MX), письмо пишется в
// logs/emails/<timestamp>-<email>.html чтобы можно было глазами проверить
// верстку через Playwright или открыть в браузере локально.
export type AuthEmailKind = 'welcome' | 'recover';

export interface AuthEmailPayload {
  to: string;
  kind: AuthEmailKind;
  username: string;
  password: string;
  magicUrl: string;
}

export async function sendAuthEmail(payload: AuthEmailPayload): Promise<void> {
  const { to, kind, username, password, magicUrl } = payload;
  const subject = kind === 'welcome'
    ? 'Добро пожаловать в ScanFlow — ваш доступ'
    : 'Восстановление доступа к ScanFlow';
  const html = renderAuthEmailHtml({ kind, username, password, magicUrl });

  const sender = getSender();
  if (!sender) {
    await writeEmailToDisk(to, subject, html);
    logger.info('Auth email written to disk (no transport)', { to, kind });
    return;
  }

  await sender.send({ from: MAIL_FROM, to, subject, html });
  logger.info('Auth email sent', { to, kind, via: sender.kind });
}

async function writeEmailToDisk(to: string, subject: string, html: string): Promise<void> {
  try {
    const dir = path.resolve(process.cwd(), 'logs', 'emails');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeTo = to.replace(/[^a-zA-Z0-9@._-]/g, '_');
    const filePath = path.join(dir, `${stamp}-${safeTo}.html`);
    fs.writeFileSync(filePath, `<!-- subject: ${subject} -->\n${html}`, 'utf8');
  } catch (e) {
    logger.warn('writeEmailToDisk failed', { error: (e as Error).message });
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderAuthEmailHtml(opts: {
  kind: AuthEmailKind;
  username: string;
  password: string;
  magicUrl: string;
}): string {
  const heading = opts.kind === 'welcome'
    ? 'Добро пожаловать в ScanFlow!'
    : 'Восстановление доступа';
  const intro = opts.kind === 'welcome'
    ? 'Вы создали аккаунт. Ниже — ваши данные для входа. Откройте кабинет по кнопке — мы сразу зайдём за вас.'
    : 'Мы получили запрос на восстановление пароля. Старый пароль больше не действует — используйте новые данные ниже.';

  // Inline-стили — email-клиенты типа Gmail/mail.ru вырезают <style> и не
  // поддерживают CSS-vars. Цвета — из дизайн-системы сайта (landing.css):
  // акцент #1a6ed8, текст #171717 / #525252 / #737373, фон #fafafa, линии
  // #e8e8e8. Шрифт системный: веб-шрифты в почте почти нигде не работают.
  const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
  const mono = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <title>${escapeHtml(heading)}</title>
</head>
<body style="margin:0;padding:0;background:#fafafa;font-family:${font};color:#171717;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;padding:40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e8e8e8;border-radius:16px;">
          <tr>
            <td style="padding:32px 32px 0 32px;">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding-right:8px;vertical-align:middle;">
                    <svg width="28" height="28" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <rect width="64" height="64" rx="16" fill="#1a6ed8"/>
                      <path d="M17 21.5h30" stroke="#ffffff" stroke-width="5.5" stroke-linecap="round"/>
                      <path d="M17 32h23" stroke="#ffffff" stroke-width="5.5" stroke-linecap="round" opacity="0.78"/>
                      <path d="M17 42.5h16" stroke="#ffffff" stroke-width="5.5" stroke-linecap="round" opacity="0.56"/>
                    </svg>
                  </td>
                  <td style="vertical-align:middle;font-family:${font};font-size:18px;line-height:28px;font-weight:600;color:#171717;letter-spacing:-0.3px;">ScanFlow</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px 0 32px;">
              <h1 style="margin:0 0 8px;font-family:${font};font-size:24px;line-height:32px;font-weight:600;letter-spacing:-0.5px;color:#171717;">${escapeHtml(heading)}</h1>
              <p style="margin:0;font-family:${font};font-size:16px;line-height:24px;color:#525252;">${escapeHtml(intro)}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px 0 32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;border:1px solid #e8e8e8;border-radius:12px;">
                <tr>
                  <td style="padding:16px 24px 8px 24px;">
                    <div style="font-family:${font};font-size:12px;line-height:16px;color:#737373;margin-bottom:4px;">Логин</div>
                    <div style="font-family:${mono};font-size:16px;line-height:24px;font-weight:500;color:#171717;word-break:break-all;">${escapeHtml(opts.username)}</div>
                  </td>
                </tr>
                <tr>
                  <td style="padding:8px 24px 16px 24px;">
                    <div style="font-family:${font};font-size:12px;line-height:16px;color:#737373;margin-bottom:4px;">Пароль</div>
                    <div style="font-family:${mono};font-size:16px;line-height:24px;font-weight:500;color:#171717;word-break:break-all;">${escapeHtml(opts.password)}</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:32px 32px 8px 32px;">
              <a href="${escapeHtml(opts.magicUrl)}" style="display:inline-block;background:#1a6ed8;color:#ffffff;text-decoration:none;font-family:${font};font-size:16px;line-height:24px;font-weight:600;padding:12px 32px;border-radius:9999px;">Открыть кабинет&nbsp;→</a>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 32px 24px 32px;">
              <p style="margin:0;font-family:${font};font-size:14px;line-height:20px;color:#737373;text-align:center;">Кнопка ведёт в&nbsp;ваш кабинет без ввода пароля и&nbsp;действует один раз в&nbsp;течение 24&nbsp;часов. Если она не&nbsp;работает, войдите вручную с&nbsp;этими данными на&nbsp;<a href="https://scanflow.ru" style="color:#1a6ed8;text-decoration:none;">scanflow.ru</a>.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 32px 32px;">
              <hr style="border:none;border-top:1px solid #e8e8e8;margin:0 0 16px 0;">
              <p style="margin:0;font-family:${font};font-size:12px;line-height:16px;color:#737373;">Это автоматическое письмо, отвечать на&nbsp;него не&nbsp;нужно: входящие на&nbsp;noreply никто не&nbsp;читает. По&nbsp;вопросам пишите на&nbsp;<a href="mailto:bugdenes@gmail.com" style="color:#525252;">bugdenes@gmail.com</a>.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
