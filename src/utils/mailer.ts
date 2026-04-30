import nodemailer from 'nodemailer';
import { logger } from './logger';

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const MAIL_TO = process.env.MAIL_TO || '';

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
