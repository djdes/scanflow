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
  elevated_prices:    'Повышенные цены',
  invoice_edited:     'Накладная отредактирована',
  approved_for_1c:    'Утверждена для 1С',
  sent_to_1c:         'Отправлена в 1С',
  sber_payment_overdue: 'Счёт в Сбербанк не выставлен',
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

function pluralRu(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

function invoiceHeaderHtml(p: EventPayload, baseUrl: string): string {
  const num = p.invoice_number ? escapeHtml(String(p.invoice_number)) : `#${p.invoice_id}`;
  const supplier = p.supplier ? escapeHtml(String(p.supplier)) : '—';
  const link = `${baseUrl}/app.html#/invoices/${p.invoice_id}`;
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
  if (eventType === 'sber_payment_overdue') {
    const days = payload.days_overdue != null ? Number(payload.days_overdue) : null;
    const created = payload.created_at ? escapeHtml(String(payload.created_at)) : null;
    const daysText = days != null && Number.isFinite(days)
      ? ` уже ${days} ${pluralRu(days, 'день', 'дня', 'дней')}`
      : '';
    extra = `<p style="margin:8px 0 0;color:#b45309"><b>⏰ Счёт в Сбербанк не выставлен${daysText}.</b>${created ? ` Загружена ${created}.` : ''}</p>`;
  }
  if (eventType === 'elevated_prices' && Array.isArray(payload.elevated_items)) {
    const items = payload.elevated_items as Array<{ name: string; unit: string | null; price: number; median_price: number; deviation_pct: number }>;
    const sorted = [...items].sort((a, b) => b.deviation_pct - a.deviation_pct).slice(0, 30);
    const rows = sorted.map(it => {
      const unit = it.unit ? `/${escapeHtml(it.unit)}` : '';
      const dev = Math.round(it.deviation_pct);
      const color = it.deviation_pct > 50 ? '#b91c1c' : it.deviation_pct > 25 ? '#c2410c' : '#b45309';
      return `<tr>
        <td style="padding:6px 10px;border-bottom:1px solid #eef2f7">${escapeHtml(it.name)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eef2f7;text-align:right;white-space:nowrap">${fmtMoney(it.price)}${unit}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eef2f7;text-align:right;white-space:nowrap;color:#64748b">${fmtMoney(it.median_price)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eef2f7;text-align:right;font-weight:700;color:${color}">+${dev}%</td>
      </tr>`;
    }).join('');
    const more = items.length > sorted.length ? `<p style="margin:6px 0 0;font-size:12px;color:#94a3b8">… и ещё ${items.length - sorted.length}</p>` : '';
    extra = `
      <p style="margin:12px 0 6px;color:#b45309"><b>Найдено ${items.length} ${pluralRu(items.length, 'позиция', 'позиции', 'позиций')} дороже обычного:</b></p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">
        <thead>
          <tr style="background:#f8fafc;color:#64748b;text-transform:uppercase;font-size:11px;letter-spacing:0.4px">
            <th style="padding:8px 10px;text-align:left">Товар</th>
            <th style="padding:8px 10px;text-align:right">Цена</th>
            <th style="padding:8px 10px;text-align:right">Обычно</th>
            <th style="padding:8px 10px;text-align:right">Δ</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>${more}`;
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
      const link = `${baseUrl}/app.html#/invoices/${ev.payload.invoice_id}`;
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
