import { logger } from '../utils/logger';

/**
 * Правовые документы сайта: политика обработки персональных данных (/privacy),
 * согласие на обработку (/consent) и пользовательское соглашение (/terms).
 *
 * Тексты — шаблоны public/legal/*.html. Реквизитов оператора в репозитории нет
 * (их нет и в docs/billing-robokassa.md): они подставляются из env на сервере.
 * Пока LEGAL_OPERATOR_NAME не задан, страницы говорят «реквизиты — по запросу»
 * и пишут предупреждение в лог — выдумывать реквизиты нельзя.
 */

export const LEGAL_PAGES = ['privacy', 'consent', 'terms'] as const;
export type LegalPage = typeof LEGAL_PAGES[number];

/**
 * Редакция текста согласия (public/legal/consent.html). pd_consents хранит,
 * на какую редакцию дано согласие: меняете текст согласия — меняйте и дату.
 */
export const PD_CONSENT_VERSION = '2026-10-26';

export interface LegalOperator {
  /** «ИП Иванов Иван Иванович» или «ООО «Ромашка»» */
  name: string;
  inn: string;
  /** ОГРН или ОГРНИП */
  ogrn: string;
  address: string;
  email: string;
}

const DEFAULT_EMAIL = 'hi@scanflow.ru';

export function legalOperator(env: NodeJS.ProcessEnv = process.env): LegalOperator {
  const v = (key: string) => (env[key] || '').trim();
  return {
    name: v('LEGAL_OPERATOR_NAME'),
    inn: v('LEGAL_OPERATOR_INN'),
    ogrn: v('LEGAL_OPERATOR_OGRN'),
    address: v('LEGAL_OPERATOR_ADDRESS'),
    email: v('LEGAL_CONTACT_EMAIL') || DEFAULT_EMAIL,
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function mailLink(email: string): string {
  const e = escapeHtml(email);
  return `<a href="mailto:${e}">${e}</a>`;
}

/** Блок «Оператор» — в конце каждого документа и в разделе «Кто мы». */
export function renderOperatorBlock(op: LegalOperator): string {
  if (!op.name) {
    return `<p class="legal-operator">Оператор — владелец сервиса ScanFlow (scanflow.ru). `
      + `Полные реквизиты оператора сообщим по запросу на ${mailLink(op.email)}.</p>`;
  }
  const rows: Array<[string, string]> = [['Оператор', op.name]];
  if (op.inn) rows.push(['ИНН', op.inn]);
  if (op.ogrn) rows.push([/^\d{15}$/.test(op.ogrn) ? 'ОГРНИП' : 'ОГРН', op.ogrn]);
  if (op.address) rows.push(['Адрес', op.address]);
  const dl = rows.map(([k, val]) => `<div><dt>${k}</dt><dd>${escapeHtml(val)}</dd></div>`).join('');
  return `<dl class="legal-operator">${dl}<div><dt>Почта</dt><dd>${mailLink(op.email)}</dd></div></dl>`;
}

let warned = false;

/**
 * Подставляет реквизиты в шаблон. Метки в шаблоне — HTML-комментарии, так что
 * незаполненный шаблон не показывает служебных скобок:
 *   <!--LEGAL:operator-->       блок реквизитов
 *   <!--LEGAL:operator-name-->  наименование оператора в тексте
 *   <!--LEGAL:email-->          ссылка на почту для обращений
 * Наименование стоит в тексте в именительном падеже («Оператор — …»):
 * значение из env не склоняется.
 */
export function renderLegalPage(raw: string, op: LegalOperator): string {
  if (!op.name && !warned) {
    warned = true;
    logger.warn('LEGAL_OPERATOR_NAME не задан: в правовых документах нет реквизитов оператора (см. .env.example)');
  }
  const name = op.name ? escapeHtml(op.name) : 'владелец сервиса ScanFlow';
  return raw
    .split('<!--LEGAL:operator-->').join(renderOperatorBlock(op))
    .split('<!--LEGAL:operator-name-->').join(name)
    .split('<!--LEGAL:email-->').join(mailLink(op.email));
}
