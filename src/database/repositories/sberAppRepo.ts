import { getDb } from '../db';

/** Секрет приложения Sber API (миграция 74). Платформенный, не пер-тенантный: client_id — из .env. */
export interface SberAppRow {
  id: number;
  client_id: string;
  client_secret_enc: string | null;
  secret_set_at: string | null;
  secret_expires_at: string | null;
  secret_perpetual: number;
  last_error: string | null;
  /** Клиентский TLS-сертификат, загруженный через кабинет (миграция 94): .p12 (base64) и пароль — зашифрованы. */
  tls_pfx_enc?: string | null;
  tls_pass_enc?: string | null;
  tls_valid_to?: string | null;
  tls_subject?: string | null;
  tls_set_at?: string | null;
  updated_at: string;
}

export const sberAppRepo = {
  async get(clientId: string): Promise<SberAppRow | null> {
    const row = await getDb().prepare('SELECT * FROM sber_app WHERE client_id = ?').get<SberAppRow>(clientId);
    return row ?? null;
  },

  async saveSecret(clientId: string, sealed: string, opts: { perpetual: boolean; expiresAt: string | null }): Promise<void> {
    await getDb().prepare(`
      INSERT INTO sber_app (client_id, client_secret_enc, secret_set_at, secret_expires_at, secret_perpetual, last_error, updated_at)
      VALUES (?, ?, UTC_TIMESTAMP(), ?, ?, NULL, NOW())
      ON DUPLICATE KEY UPDATE client_secret_enc = VALUES(client_secret_enc), secret_set_at = UTC_TIMESTAMP(),
        secret_expires_at = VALUES(secret_expires_at), secret_perpetual = VALUES(secret_perpetual),
        last_error = NULL, updated_at = NOW()
    `).run(clientId, sealed, opts.expiresAt, opts.perpetual ? 1 : 0);
  },

  async setError(clientId: string, message: string | null): Promise<void> {
    await getDb().prepare(`
      INSERT INTO sber_app (client_id, last_error, updated_at) VALUES (?, ?, NOW())
      ON DUPLICATE KEY UPDATE last_error = VALUES(last_error), updated_at = NOW()
    `).run(clientId, message ? message.slice(0, 500) : null);
  },

  /** Сохранить сертификат, загруженный через кабинет. validTo — DATETIME в UTC. */
  async saveTls(clientId: string, data: { pfxEnc: string; passEnc: string; validTo: string; subject: string | null }): Promise<void> {
    await getDb().prepare(`
      INSERT INTO sber_app (client_id, tls_pfx_enc, tls_pass_enc, tls_valid_to, tls_subject, tls_set_at, updated_at)
      VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(), NOW())
      ON DUPLICATE KEY UPDATE tls_pfx_enc = VALUES(tls_pfx_enc), tls_pass_enc = VALUES(tls_pass_enc),
        tls_valid_to = VALUES(tls_valid_to), tls_subject = VALUES(tls_subject),
        tls_set_at = UTC_TIMESTAMP(), updated_at = NOW()
    `).run(clientId, data.pfxEnc, data.passEnc, data.validTo, data.subject);
  },
};
