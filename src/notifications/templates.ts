import type { EventType, EventPayload } from './types';

interface RenderedEmail {
  subject: string;
  html: string;
}

const EVENT_LABELS: Record<EventType, string> = {
  photo_uploaded:     'Фото загружено',
  invoice_recognized: 'Накладная распознана',
  recognition_error:  'Ошибка распознавания',
  suspicious_total:   'Подозрительная сумма',
  invoice_edited:     'Накладная отредактирована',
  approved_for_1c:    'Утверждена для 1С',
  sent_to_1c:         'Отправлена в 1С',
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtMoney(n: number | null | undefined): string {
  if (n == null) return '—';
  return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n) + ' ₽';
}

function invoiceHeaderHtml(p: EventPayload, baseUrl: string): string {
  const num = p.invoice_number ? escapeHtml(String(p.invoice_number)) : `#${p.invoice_id}`;
  const supplier = p.supplier ? escapeHtml(String(p.supplier)) : '—';
  const link = `${baseUrl}/#invoices/${p.invoice_id}`;
  return `
    <p style="margin:0 0 8px"><b>Накладная:</b> <a href="${link}" style="color:#2563eb">№ ${num}</a></p>
    <p style="margin:0 0 8px"><b>Поставщик:</b> ${supplier}</p>
    <p style="margin:0 0 8px"><b>Сумма:</b> ${fmtMoney(p.total_sum as number | null | undefined)}</p>
  `;
}

export function renderRealtime(eventType: EventType, payload: EventPayload, baseUrl = 'https://scanflow.ru'): RenderedEmail {
  const label = EVENT_LABELS[eventType];
  const headerHtml = invoiceHeaderHtml(payload, baseUrl);

  let extra = '';
  if (eventType === 'recognition_error' && payload.error_message) {
    extra = `<p style="margin:8px 0 0;color:#b91c1c"><b>Ошибка:</b> ${escapeHtml(String(payload.error_message))}</p>`;
  }
  if (eventType === 'suspicious_total' && payload.items_total != null) {
    extra = `<p style="margin:8px 0 0;color:#b45309"><b>Сумма строк:</b> ${fmtMoney(payload.items_total as number)} <i>(не сходится с total_sum)</i></p>`;
  }

  const html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px">
      <h3 style="color:#0f172a;margin:0 0 12px">${label}</h3>
      ${headerHtml}
      ${extra}
      <p style="color:#94a3b8;font-size:12px;margin-top:16px">ScanFlow · ${new Date().toLocaleString('ru-RU')}</p>
    </div>
  `;
  return { subject: label, html };
}

export interface DigestGroup {
  event_type: EventType;
  events: { payload: EventPayload; created_at: string }[];
}

export function renderDigest(groups: DigestGroup[], baseUrl = 'https://scanflow.ru'): RenderedEmail {
  const totalEvents = groups.reduce((acc, g) => acc + g.events.length, 0);
  if (totalEvents === 0) {
    return { subject: 'Дайджест ScanFlow (пусто)', html: '<p>Нет событий за период.</p>' };
  }

  const sectionsHtml = groups.map(g => {
    const rows = g.events.map(ev => {
      const num = ev.payload.invoice_number ? escapeHtml(String(ev.payload.invoice_number)) : `#${ev.payload.invoice_id}`;
      const supplier = ev.payload.supplier ? escapeHtml(String(ev.payload.supplier)) : '—';
      const link = `${baseUrl}/#invoices/${ev.payload.invoice_id}`;
      return `
        <tr>
          <td style="padding:6px 12px;border-bottom:1px solid #e2e8f0"><a href="${link}" style="color:#2563eb">${num}</a></td>
          <td style="padding:6px 12px;border-bottom:1px solid #e2e8f0">${supplier}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #e2e8f0;text-align:right">${fmtMoney(ev.payload.total_sum as number | null | undefined)}</td>
        </tr>
      `;
    }).join('');
    return `
      <h4 style="margin:16px 0 8px;color:#0f172a">${EVENT_LABELS[g.event_type]} (${g.events.length})</h4>
      <table style="border-collapse:collapse;width:100%;font-size:14px">
        <thead><tr style="background:#f8fafc"><th style="padding:6px 12px;text-align:left">№</th><th style="padding:6px 12px;text-align:left">Поставщик</th><th style="padding:6px 12px;text-align:right">Сумма</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }).join('');

  const html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:720px">
      <h2 style="margin:0 0 8px;color:#0f172a">Дайджест ScanFlow</h2>
      <p style="margin:0 0 16px;color:#64748b">Всего событий: ${totalEvents}</p>
      ${sectionsHtml}
      <p style="color:#94a3b8;font-size:12px;margin-top:24px">ScanFlow · ${new Date().toLocaleString('ru-RU')}</p>
    </div>
  `;
  return { subject: `Дайджест (${totalEvents} событий)`, html };
}
