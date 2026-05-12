import nodemailer from 'nodemailer';
import { logger } from './logger';
import fs from 'fs';
import path from 'path';

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const MAIL_TO = process.env.MAIL_TO || '';
// Бренд-адрес, видимый получателю. От SMTP_USER (тех. ящик) отличается тем,
// что требует SPF/DMARC/DKIM для scanflow.ru на стороне DNS — иначе письма
// падают в спам Gmail/mail.ru.
const MAIL_FROM = process.env.MAIL_FROM || 'ScanFlow <noreply@scanflow.ru>';

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: false,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
  tls: { rejectUnauthorized: false },
});

let lastSentAt = 0;
const MIN_INTERVAL_MS = 30_000; // max 1 email per 30 seconds

export async function sendErrorEmail(subject: string, details: string): Promise<void> {
  // Skip silently if SMTP not configured — don't spam logs
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !MAIL_TO) {
    logger.debug('SMTP not configured, skipping error email', { subject });
    return;
  }

  const now = Date.now();
  if (now - lastSentAt < MIN_INTERVAL_MS) {
    logger.debug('Skipping error email (rate limited)', { subject });
    return;
  }

  try {
    lastSentAt = now;
    await transporter.sendMail({
      from: `"ScanFlow Errors" <${SMTP_USER}>`,
      to: MAIL_TO,
      subject: `[ScanFlow] ${subject}`,
      html: `
        <h3 style="color:#b91c1c">${subject}</h3>
        <pre style="background:#f8fafc;padding:16px;border-radius:8px;font-size:13px;overflow-x:auto">${details}</pre>
        <p style="color:#94a3b8;font-size:12px">Сервер: ${process.env.HOSTNAME || 'scan.magday.ru'} · ${new Date().toLocaleString('ru-RU')}</p>
      `,
    });
    logger.info('Error email sent', { subject, to: MAIL_TO });
  } catch (err) {
    logger.error('Failed to send error email', { error: (err as Error).message, subject });
  }
}

// Send a domain-event notification to a specific recipient. Unlike
// sendErrorEmail, this:
//   - takes the `to` address explicitly (per-user, not global MAIL_TO)
//   - has no rate limit (digest mode handles regulation)
// SMTP must be configured in env. Returns void on success, throws on
// failure so the caller can decide whether to retry/log.
export async function sendNotification(to: string, subject: string, html: string): Promise<void> {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw new Error('SMTP not configured (SMTP_HOST/SMTP_USER/SMTP_PASS missing)');
  }
  if (!to) {
    throw new Error('sendNotification: empty `to` address');
  }
  await transporter.sendMail({
    from: `"ScanFlow" <${SMTP_USER}>`,
    to,
    subject: `[ScanFlow] ${subject}`,
    html,
  });
  logger.info('Notification email sent', { subject, to });
}

// True if the runtime has the SMTP env vars filled in. Used by
// /api/profile to surface an "SMTP not configured on server" hint
// in the UI.
export function smtpConfigured(): boolean {
  return !!(SMTP_HOST && SMTP_USER && SMTP_PASS);
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

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    // Dev-fallback: пишем письмо на диск, не падаем. Удобно для preview-сервера
    // и smoke-тестов где SMTP не настроен.
    await writeEmailToDisk(to, subject, html);
    logger.info('SMTP not configured — auth email written to disk', { to, kind });
    return;
  }

  await transporter.sendMail({
    from: MAIL_FROM,
    to,
    subject,
    html,
  });
  logger.info('Auth email sent', { to, kind });
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
  // поддерживают CSS-vars. Брендовый голубой #3b82f6 — то же значение что
  // var(--accent-blue) в landing.css.
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(heading)}</title>
</head>
<body style="margin:0;padding:0;background:#f7f9fc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1f2e;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f9fc;padding:40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(15,23,42,0.08);">
          <tr>
            <td style="padding:32px 32px 8px 32px;">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding-right:10px;vertical-align:middle;">
                    <svg width="32" height="32" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <rect x="2" y="2" width="36" height="36" rx="8" stroke="#3b82f6" stroke-width="2.5"/>
                      <line x1="10" y1="14" x2="30" y2="14" stroke="#3b82f6" stroke-width="2" stroke-linecap="round"/>
                      <line x1="10" y1="20" x2="26" y2="20" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-opacity="0.6"/>
                      <line x1="10" y1="26" x2="22" y2="26" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-opacity="0.35"/>
                    </svg>
                  </td>
                  <td style="font-size:18px;font-weight:700;color:#1a1f2e;letter-spacing:-0.3px;">ScanFlow</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 32px 0 32px;">
              <h1 style="margin:24px 0 8px;font-size:24px;font-weight:700;letter-spacing:-0.4px;color:#1a1f2e;">${escapeHtml(heading)}</h1>
              <p style="margin:0;font-size:15px;line-height:1.55;color:#475569;">${escapeHtml(intro)}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px 0 32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5fb;border-radius:12px;border:1px solid #e2e8f0;">
                <tr>
                  <td style="padding:18px 22px;">
                    <div style="font-size:12px;text-transform:uppercase;letter-spacing:0.8px;color:#64748b;margin-bottom:4px;">Логин</div>
                    <div style="font-family:'JetBrains Mono',Menlo,Consolas,monospace;font-size:15px;font-weight:600;color:#1a1f2e;word-break:break-all;">${escapeHtml(opts.username)}</div>
                  </td>
                </tr>
                <tr>
                  <td style="padding:0 22px 18px 22px;">
                    <div style="font-size:12px;text-transform:uppercase;letter-spacing:0.8px;color:#64748b;margin-bottom:4px;">Пароль</div>
                    <div style="font-family:'JetBrains Mono',Menlo,Consolas,monospace;font-size:15px;font-weight:600;color:#1a1f2e;word-break:break-all;">${escapeHtml(opts.password)}</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:28px 32px 8px 32px;">
              <a href="${escapeHtml(opts.magicUrl)}" style="display:inline-block;background:#1a6dff;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:14px 32px;border-radius:10px;box-shadow:0 2px 12px rgba(26,109,255,0.35);">Открыть кабинет →</a>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 32px 24px 32px;">
              <p style="margin:0;font-size:13px;color:#94a3b8;line-height:1.55;text-align:center;">Кнопка ведёт в ваш кабинет без ввода пароля. Если она не работает — войдите вручную с указанными данными на <a href="https://scanflow.ru" style="color:#1a6dff;text-decoration:none;">scanflow.ru</a>.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 32px 32px;">
              <hr style="border:none;border-top:1px solid #eef2f7;margin:0 0 16px 0;">
              <p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.55;">Это автоматическое письмо. Не отвечайте на него — мы не читаем входящие на noreply. По вопросам пишите на <a href="mailto:bugdenes@gmail.com" style="color:#64748b;">bugdenes@gmail.com</a>.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
