import nodemailer from 'nodemailer';
import { logger } from './logger';

const SMTP_HOST = process.env.SMTP_HOST || 'wesetup.ru';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER || 'tech@wesetup.ru';
const SMTP_PASS = process.env.SMTP_PASS || '0M2r8H4t';
const MAIL_TO = process.env.MAIL_TO || 'tech@wesetup.ru';

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
