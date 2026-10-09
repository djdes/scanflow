/* global App, IntegrationsLog, InvoicePhotoViewer, Invoices */
// Журнал интеграций простыми словами: «Отправлена в 1С накладная №…», «1С провела
// накладную №… → Приходная накладная 2644». Номер накладной открывает её скан.
// Опросы очереди 1С в список не попадают (их сотни) — связь видна в карточке сверху.
const IntegrationsLog = {
  filter: '',
  _events: new Map(),

  _LABELS: { '1c': '1С', sber: 'Сбербанк', webhook: 'Webhook', nomenclature: 'Справочник 1С' },

  async load() {
    this._renderFilters();
    const tbody = document.getElementById('intlog-tbody');
    if (tbody) tbody.innerHTML = '';
    try {
      const url = '/integrations/log?limit=150' + (this.filter ? `&integration=${this.filter}` : '');
      const { data, onec_last_poll_at } = await App.apiJson(url);
      this._renderOnecStatus(onec_last_poll_at);
      if (!tbody) return;
      this._events = new Map((data || []).map(ev => [ev.id, ev]));
      if (!data || data.length === 0) {
        tbody.innerHTML = `<tr><td colspan="2"><div class="empty-state">Событий пока нет</div></td></tr>`;
        return;
      }
      let day = '';
      tbody.innerHTML = data.map(ev => {
        const d = this._dayLabel(ev.ts);
        const head = d !== day ? `<tr class="intlog-day"><td colspan="2">${App.esc(d)}</td></tr>` : '';
        day = d;
        const { icon, html, error } = this._describe(ev);
        const card = ev.invoice_id ? ` <a href="#/invoices/${ev.invoice_id}" class="intlog-card" title="Карточка накладной">карточка →</a>` : '';
        return `${head}<tr class="intlog-row${error ? ' intlog-row--error' : ''}">
          <td data-label="Время" class="intlog-time">${App.esc(this._time(ev.ts))}</td>
          <td data-label="Что произошло"><span class="intlog-icon" aria-hidden="true">${icon}</span>${html}${card}</td>
        </tr>`;
      }).join('');
    } catch (e) {
      console.error('Failed to load integration log', e);
      App.notify('Ошибка загрузки журнала: ' + (e.message || e), 'error');
    }
  },

  // Одна понятная фраза на событие. Неизвестное событие — его текст как есть.
  // Номер накладной в фразе — ссылка на её скан (_invoiceRef, падеж слова — от фразы).
  _describe(ev) {
    const inv = (word) => this._invoiceRef(ev, word);
    const err = this._errorText(ev);
    const tail = (summary) => App.esc(String(summary || '').replace(/^[^:]*:s*/, ''));
    const waiting = ev.invoice_id && !ev.sent_at ? ' <span class="muted">— ждёт, пока 1С её заберёт</span>' : '';
    switch (`${ev.integration}:${ev.event_type}`) {
      case '1c:approved': return { icon: '📤', html: `Отправлена в 1С ${inv('накладная')}${waiting}` };
      case '1c:document_posted': return { icon: '✅', html: `1С провела ${inv('накладную')}${this._docRef(ev)}` };
      case '1c:document_created': return { icon: '📄', html: `1С создала документ по ${inv('накладной')}${this._docRef(ev)} <span class="muted">— не проведён</span>` };
      case '1c:sent': return { icon: '✅', html: `Загружена в 1С ${inv('накладная')}` };
      case '1c:document_rejected':
      case '1c:document_error': return { icon: '⚠️', html: `1С не приняла ${inv('накладную')}${err ? `: ${App.esc(err)}` : ''}`, error: true };
      case '1c:unapproved': return { icon: '↩️', html: `Отозвана отправка в 1С: ${inv('накладная')}` };
      case '1c:reset': return { icon: '🔁', html: `Можно снова отправить в 1С: ${inv('накладная')}` };
      case '1c:poll': return { icon: '🔄', html: '1С проверила очередь' };
      case 'nomenclature:sync_requested': return { icon: '🆕', html: `Новые товары в ${inv('накладной')} — справочник 1С выгрузится заново` };
      case 'nomenclature:catalog_synced':
      case 'nomenclature:catalog_imported': return { icon: '📚', html: `Справочник 1С обновлён: ${tail(ev.summary)}` };
      case 'sber:payment_created': return { icon: '💳', html: `Создан черновик платёжки в СберБизнес по ${inv('накладной')}` };
      case 'sber:payment_failed': return { icon: '⚠️', html: `Не создана платёжка в СберБизнес по ${inv('накладной')}${err ? `: ${App.esc(err)}` : ''}`, error: true };
      case 'sber:payment_status': return { icon: '💳', html: `Платёжка по ${inv('накладной')}: ${tail(ev.summary)}`, error: ev.status === 'error' };
      case 'sber:paid_externally_set': return { icon: '💰', html: `Отмечена оплаченной без Сбера ${inv('накладная')}` };
      case 'sber:paid_externally_cleared': return { icon: '💰', html: `Снята отметка «оплачена без Сбера»: ${inv('накладная')}` };
      case 'webhook:webhook_sent': return { icon: '📨', html: `Вебхук отправлен по ${inv('накладной')}` };
      case 'webhook:webhook_failed': return { icon: '⚠️', html: `Вебхук не отправлен по ${inv('накладной')}`, error: true };
      default: {
        const label = this._LABELS[ev.integration] || ev.integration;
        return { icon: '•', html: `<span class="muted">${App.esc(label)}:</span> ${App.esc(ev.summary || ev.event_type)}`, error: ev.status === 'error' };
      }
    }
  },

  // «накладную №17-0605773 · Свит Лайф Фудсервис · 107 528,07 ₽»; номер открывает скан.
  _invoiceRef(ev, word) {
    if (!ev.invoice_id) return word;
    const num = ev.invoice_number ? `№${ev.invoice_number}` : `#${ev.invoice_id}`;
    const parts = [];
    if (ev.supplier) parts.push(App.esc(ev.supplier));
    if (ev.total_sum != null) parts.push(`${App.formatMoney(ev.total_sum)} ₽`);
    return `${word} <a href="#/invoices/${ev.invoice_id}" class="intlog-inv" title="Открыть скан накладной"
      onclick="event.preventDefault(); IntegrationsLog.openScan(${ev.invoice_id}, ${ev.id})">${App.esc(num)}</a>`
      + (parts.length ? ` <span class="muted">· ${parts.join(' · ')}</span>` : '');
  },

  // «… → Приходная накладная 2644 (вх. 17-0605773)» — из текста статуса 1С.
  _docRef(ev) {
    const m = String(ev.summary || '').match(/статус \w+,\s*(.+)$/);
    return m ? ` <span class="muted">→ ${App.esc(m[1])}</span>` : '';
  },

  _errorText(ev) {
    if (!ev.detail) return '';
    try {
      const d = typeof ev.detail === 'string' ? JSON.parse(ev.detail) : ev.detail;
      return String(d.error || '').slice(0, 300);
    } catch { return ''; }
  },

  // Скан прямо из журнала: фото — в просмотрщике, PDF — в новой вкладке,
  // иначе (файла нет) — карточка накладной.
  async openScan(invoiceId, eventId) {
    const ev = this._events.get(eventId) || {};
    const title = ev.invoice_number ? `Накладная №${ev.invoice_number}` : `Накладная #${invoiceId}`;
    try {
      const { data } = await App.apiJson(`/invoices/${invoiceId}/photos`);
      const files = (data || []).map((p, page) => ({ ...p, page })).filter(p => p.exists !== false);
      const kind = (p) => p.kind || (/\.pdf$/i.test(p.filename) ? 'pdf' : /\.xml$/i.test(p.filename) ? 'xml' : 'image');
      const urlOf = (p) => `${encodeURI(String(p.url || ''))}?key=${encodeURIComponent(App.apiKey)}`;
      const images = files.filter(p => kind(p) === 'image').map(p => ({
        src: urlOf(p), page: p.page, name: p.filename,
        rotation: window.Invoices?._getPhotoRotation ? Invoices._getPhotoRotation(invoiceId, p.page) : 0,
      }));
      if (images.length) {
        InvoicePhotoViewer.open(images, images[0].page, title, (page, delta) => {
          if (!window.Invoices?._savePhotoRotation) return;
          const deg = ((Invoices._getPhotoRotation(invoiceId, page) + delta) % 360 + 360) % 360;
          Invoices._savePhotoRotation(invoiceId, page, deg);
        });
        return;
      }
      const pdf = files.find(p => kind(p) === 'pdf');
      if (pdf) { window.open(urlOf(pdf), '_blank', 'noopener'); return; }
    } catch (e) {
      console.error('openScan failed', e);
    }
    App.navigate(`#/invoices/${invoiceId}`);
  },

  _date(ts) { return new Date(String(ts).replace(' ', 'T')); },

  _time(ts) {
    const d = this._date(ts);
    return isNaN(d) ? String(ts || '') : d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  },

  _dayLabel(ts) {
    const d = this._date(ts);
    if (isNaN(d)) return '';
    const today = new Date();
    const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((start(today) - start(d)) / 86400000);
    const date = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
    if (diff === 0) return `Сегодня, ${date}`;
    if (diff === 1) return `Вчера, ${date}`;
    return date;
  },

  _renderOnecStatus(pollAt) {
    const el = document.getElementById('intlog-onec-status');
    if (!el) return;
    if (pollAt) {
      el.innerHTML = `<strong style="color:var(--success)">✓ 1С на связи</strong> — последний раз проверяла очередь: ${App.esc(this._dayLabel(pollAt).toLowerCase())} в ${App.esc(this._time(pollAt))}`;
    } else {
      el.innerHTML = `<strong style="color:#b45309">1С пока не обращалась к серверу</strong>
        <div class="muted" style="font-size:12px;margin-top:2px">Это нормально, если в 1С ещё не подключили обработку загрузки накладных (Профиль → «Подключение 1С»).</div>`;
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
