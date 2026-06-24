/* global App, IntegrationsLog */
const IntegrationsLog = {
  filter: '',

  _LABELS: { '1c': '1С', sber: 'Сбербанк', webhook: 'Webhook', nomenclature: 'Справочник 1С' },
  _COLORS: { '1c': '#2563eb', sber: '#16a34a', webhook: '#7c3aed', nomenclature: '#0891b2' },

  async load() {
    this._renderFilters();
    const tbody = document.getElementById('intlog-tbody');
    if (tbody) tbody.innerHTML = '';
    try {
      const url = '/integrations/log?limit=100' + (this.filter ? `&integration=${this.filter}` : '');
      const { data, onec_last_poll_at } = await App.apiJson(url);
      this._renderOnecStatus(onec_last_poll_at);
      if (!tbody) return;
      if (!data || data.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state">Событий пока нет</div></td></tr>`;
        return;
      }
      tbody.innerHTML = data.map(ev => {
        const label = this._LABELS[ev.integration] || App.esc(ev.integration);
        const color = this._COLORS[ev.integration] || '#64748b';
        const badge = `<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:${color}1a;color:${color};font-weight:600;font-size:12px">${label}</span>`;
        const rowStyle = ev.status === 'error' ? ' style="color:#dc2626"' : '';
        const link = ev.invoice_id ? ` <a href="#/invoices/${ev.invoice_id}">№${ev.invoice_id}</a>` : '';
        return `<tr${rowStyle}>
          <td data-label="Время" style="white-space:nowrap">${App.formatDateTime(ev.ts)}</td>
          <td data-label="Интеграция">${badge}</td>
          <td data-label="Событие">${App.esc(ev.event_type)}</td>
          <td data-label="Описание">${App.esc(ev.summary)}${link}</td>
        </tr>`;
      }).join('');
    } catch (e) {
      console.error('Failed to load integration log', e);
      App.notify('Ошибка загрузки журнала', 'error');
    }
  },

  _renderOnecStatus(pollAt) {
    const el = document.getElementById('intlog-onec-status');
    if (!el) return;
    if (pollAt) {
      el.innerHTML = `<strong style="color:#16a34a">✓ 1С на связи</strong> — последний запрос: ${App.formatDateTime(pollAt)}`;
    } else {
      el.innerHTML = `<strong style="color:#b45309">1С пока не обращалась к серверу</strong>
        <div class="muted" style="font-size:12px;margin-top:2px">За последние 7 дней опросов не было. Это нормально, если в 1С ещё не запускали обработку загрузки накладных.</div>`;
    }
  },

  _renderFilters() {
    const el = document.getElementById('intlog-filters');
    if (!el) return;
    const opts = [['', 'Все'], ['1c', '1С'], ['sber', 'Сбербанк'], ['nomenclature', 'Справочник 1С']];
    el.innerHTML = opts.map(([k, lbl]) =>
      `<button class="filter-btn ${this.filter === k ? 'active' : ''}" onclick="IntegrationsLog.setFilter('${k}')">${lbl}</button>`
    ).join('');
  },

  setFilter(k) { this.filter = k; this.load(); },
};
