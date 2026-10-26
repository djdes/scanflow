import { getDb } from '../db';

/**
 * Согласия на обработку персональных данных (миграция 89).
 *
 * 152-ФЗ, ст. 9 ч. 3: доказать, что субъект дал согласие, обязан оператор.
 * Галочка в форме регистрации — само согласие; здесь — когда, на какую редакцию
 * текста (/consent), с какого адреса и браузера оно дано. Строки не удаляются
 * вместе с пользователем: это доказательство законности прошлой обработки.
 */
export interface ConsentRecord {
  userId: number | null;
  email: string;
  /** Какой документ принят: пока только согласие на обработку ПДн. */
  document: 'pd_consent';
  version: string;
  ip: string | null;
  userAgent: string | null;
}

export interface ConsentRow {
  id: number;
  user_id: number | null;
  email: string;
  document: string;
  version: string;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
}

export const consentRepo = {
  async record(c: ConsentRecord): Promise<void> {
    await getDb().prepare(`
      INSERT INTO pd_consents (user_id, email, document, version, ip, user_agent)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      c.userId,
      c.email.slice(0, 255),
      c.document,
      c.version,
      c.ip ? c.ip.slice(0, 64) : null,
      c.userAgent ? c.userAgent.slice(0, 512) : null,
    );
  },

  async listByEmail(email: string): Promise<ConsentRow[]> {
    return getDb().prepare(
      'SELECT * FROM pd_consents WHERE email = ? ORDER BY id'
    ).all<ConsentRow>(email);
  },
};
