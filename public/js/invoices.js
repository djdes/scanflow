/* global App, Invoices */
const Invoices = {
  currentStatus: null,
  currentView: 'all',
  _listRequest: 0,
  offset: 0,
  limit: 50,
  search: '',
  dateFrom: null,
  dateTo: null,
  period: 'all',
  // Пер-колоночные фильтры из строки под шапкой. Статус и даты живут в
  // currentStatus/dateFrom/dateTo (их же используют чипсы периода), здесь —
  // только то, чего раньше не было.
  colFilters: { number: '', supplier: '', sumFrom: '', sumTo: '', sber: '' },
  _searchTimer: null,
  _filterTimer: null,
  _selected: new Set(),   // выбранные id для массовой отправки (сбрасывается в loadTable)

  // ── Visited-invoice tracking ──────────────────────────────────────────────
  // Persist a Set of viewed invoice IDs in localStorage (current session only).
  // Used to visually dim already-seen invoices in the nav buttons and the list.
  _VISITED_KEY: 'sf_visited_invoices',

  _getVisited() {
    try {
      const raw = localStorage.getItem(this._VISITED_KEY);
      return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch { return new Set(); }
  },

  _markVisited(id) {
    try {
      const s = this._getVisited();
      s.add(id);
      // Cap at 500 most-recent to avoid unbounded growth
      const arr = [...s];
      if (arr.length > 500) arr.splice(0, arr.length - 500);
      localStorage.setItem(this._VISITED_KEY, JSON.stringify(arr));
    } catch { /* localStorage unavailable */ }
  },

  isVisited(id) { return this._getVisited().has(id); },

  // ── Prev/next navigation ──────────────────────────────────────────────────
  async _loadNeighbours(id) {
    const nav = document.getElementById('invoice-nav');
    if (!nav) return;
    nav.innerHTML = '';
    try {
      const { data } = await App.apiJson(`/invoices/${id}/neighbours`);
      if (this._currentInvoiceId !== id) return; // switched mid-flight
      const { prev, next } = data || {};
      const visited = this._getVisited();

      const mkBtn = (inv, dir) => {
        if (!inv) return '';
        const arrow = dir === 'prev' ? '←' : '→';
        const label = inv.supplier
          ? App.esc(inv.supplier)
          : (inv.invoice_number ? `№ ${App.esc(inv.invoice_number)}` : `#${inv.id}`);
        const visitedCls = visited.has(inv.id) ? ' visited' : '';
        const ttip = [inv.supplier || '', inv.invoice_number ? `№${inv.invoice_number}` : ''].filter(Boolean).join(' ');
        // Стрелка и имя — отдельные спаны: имя обрезается многоточием, стрелка
        // всегда видна (см. .inv-nav-arrow / .inv-nav-label). Полное имя — в title.
        const a = `<span class="inv-nav-arrow">${arrow}</span>`;
        const l = `<span class="inv-nav-label">${label}</span>`;
        return `<a class="inv-nav-btn${visitedCls}" href="#" title="${App.esc(ttip)}"
                   onclick="event.preventDefault();Invoices.openInvoice(${inv.id})"
                >${dir === 'prev' ? a + l : l + a}</a>`;
      };

      nav.innerHTML = mkBtn(prev, 'prev') + mkBtn(next, 'next');
    } catch { /* nav is optional */ }
  },

  // Открытие детали. Позицию прокрутки СПИСКА сохраняем только когда список виден
  // (клик по строке) — при прыжках деталь→деталь стрелками ←/→ список скрыт, и
  // перезаписывать сохранённую позицию скроллом страницы детали нельзя, иначе
  // «Назад к накладным» вернёт не туда. Восстанавливается один раз в loadTable.
  openInvoice(id) {
    const listVisible = document.getElementById('invoices-list')?.style.display !== 'none';
    if (listVisible) this._listScrollY = window.scrollY;
    App.navigate('#/invoices/' + id);
  },

  async showList() {
    if (typeof InvoiceReview !== 'undefined') InvoiceReview.leave();
    InvoicePhotoViewer.close();
    this._currentInvoiceId = null;
    if (typeof InvoiceCard !== 'undefined') InvoiceCard.closeMenu();
    document.getElementById('view-invoices')?.classList.remove('is-detail');
    document.getElementById('invoices-list').style.display = 'block';
    document.getElementById('invoice-detail').style.display = 'none';
    await this.loadTable();
  },

  async loadStats() {
    const request = this._statsRequest = (this._statsRequest || 0) + 1;
    try {
      const { data } = await App.apiJson('/invoices/stats');
      if (request !== this._statsRequest) return;
      this._stats = data;
      this._renderSummary();
      const container = document.getElementById('invoices-stats');
      container.textContent = data.unreadCount ? `Непрочитанных: ${data.unreadCount} · Сводка показывает все накладные компании` : 'Сводка показывает все накладные компании';
    } catch (e) {
      console.error('Failed to load stats', e);
    }
    this._loadAiStatus();
  },

  // Строка над списком: GPT недоступен (лимит подписки, вход) или накладные ждут его.
  async _loadAiStatus() {
    const el = document.getElementById('ai-status-banner');
    if (!el) return;
    try {
      const { data } = await App.apiJson('/ai/status');
      if (data.available && !data.waiting) { el.hidden = true; return; }
      const head = data.available
        ? 'GPT снова доступен — накладные, которые ждали, распознаются'
        : `Распознавание приостановлено: ${data.text}`;
      el.textContent = data.waiting ? `${head}. Ждут: ${data.waiting}.` : `${head}.`;
      el.hidden = false;
    } catch {
      el.hidden = true;
    }
  },

  // Пять равных карточек-фильтров (спек 2026-10-09): число крупно, подпись мелко, выбранная — в рамке.
  _renderSummary() {
    const data = this._stats || {};
    const w = data.workflow || {};
    const cards = [
      ['all', 'Все накладные', data.total, 'Вся компания', 'neutral'],
      ['attention', 'Требуют внимания', w.attention, 'Реквизиты, товары, ошибки', 'warning'],
      ['ready', 'Готовы к отправке', w.ready, 'Без замечаний', 'success'],
      ['queue', 'В очереди 1С', w.queue, 'Ждут загрузки в 1С', 'primary'],
      ['payment', 'Без платёжки', w.payment, w.paymentSum ? `На ${App.formatMoney(w.paymentSum)} ₽` : 'В СберБизнес', 'neutral'],
    ];
    document.getElementById('invoices-summary').innerHTML = cards.map(([key, label, count, hint, tone]) => `
      <button type="button" class="invoice-summary-card invoice-summary-card--${tone}" aria-pressed="${this.currentView === key}" onclick="Invoices.setView('${key}')">
        <span>${label}</span><strong>${count ?? '—'}</strong><small>${App.esc(hint)}</small>
      </button>`).join('');
  },

  setView(view) {
    if (!['all', 'attention', 'ready', 'queue', 'payment'].includes(view)) return;
    this.currentView = view;
    this.currentStatus = null;
    this.colFilters.sber = '';
    ['filter-status', 'filter-sber'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    this.offset = 0;
    clearTimeout(this._searchTimer);
    clearTimeout(this._filterTimer);
    this._syncFilterReset();
    this._renderSummary();
    this.loadTable();
  },

  toggleFilters() {
    const panel = document.getElementById('invoice-filters');
    panel.hidden = !panel.hidden;
    document.getElementById('invoice-filter-toggle').setAttribute('aria-expanded', String(!panel.hidden));
  },

  _reviewText(inv) {
    const reasons = { error: 'Ошибка распознавания — откройте документ', duplicate: 'Возможный дубликат', incomplete_pages: 'Накладная снята не полностью — проверьте страницы', total: 'Сумма расходилась с товарами — сверьте с фото', header: 'Не заполнены обязательные реквизиты', items: 'Нет распознанных товаров', quantity: 'Проверьте количество и единицы', mapping: 'Есть товары без сопоставления с 1С', supplier: 'Поставщик подобран по названию — проверьте ИНН' };
    return reasons[inv.review_reason] || '';
  },

  _rowAction(inv) {
    if (inv.review_reason) return `<button type="button" class="btn btn-outline btn-sm inv-act" onclick="event.stopPropagation();Invoices.openInvoice(${inv.id})">Проверить</button>`;
    if (inv.status === 'processed' && !inv.approved_for_1c && !inv.duplicate_of) return `<button type="button" class="btn btn-primary btn-sm inv-act" onclick="Invoices.sendTo1C(${inv.id}, event, true)">В 1С →</button>`;
    return `<button type="button" class="btn btn-outline btn-sm inv-act" onclick="event.stopPropagation();Invoices.openInvoice(${inv.id})">Открыть</button>`;
  },

  async loadTable() {
    const request = ++this._listRequest;
    this.loadStats();
    this._renderPeriod();
    // Набор строк меняется — прежнее выделение больше не относится к этим строкам.
    this._selected.clear();
    this._renderBulkBar();

    let url = `/invoices?limit=${this.limit}&offset=${this.offset}`;
    if (this.currentView !== 'all') url += `&view=${this.currentView}`;
    if (this.currentStatus) url += `&status=${this.currentStatus}`;
    if (this.search) url += `&q=${encodeURIComponent(this.search)}`;
    if (this.dateFrom) url += `&from=${this.dateFrom}`;
    if (this.dateTo) url += `&to=${this.dateTo}`;
    const f = this.colFilters;
    if (f.number) url += `&number=${encodeURIComponent(f.number)}`;
    if (f.supplier) url += `&supplier=${encodeURIComponent(f.supplier)}`;
    if (f.sumFrom) url += `&sum_from=${encodeURIComponent(f.sumFrom)}`;
    if (f.sumTo) url += `&sum_to=${encodeURIComponent(f.sumTo)}`;
    if (f.sber) url += `&sber=${encodeURIComponent(f.sber)}`;

    // Show skeleton rows while real data is loading — feels instant
    App.skeletonRows('invoices-tbody', ['w-24', 'w-40', 'w-60', 'w-40', 'w-40', 'w-24', 'w-24'], 6);

    try {
      const { data, total } = await App.apiJson(url);
      if (request !== this._listRequest) return;
      const resultTotal = Number(total ?? data?.length ?? 0);
      document.getElementById('invoices-results').textContent = `Показано ${data?.length ? this.offset + 1 : 0}–${this.offset + (data?.length || 0)} из ${resultTotal}`;
      document.getElementById('invoices-pagination').innerHTML = '';
      // Запоминаем строки: панель массовых действий должна знать, у каких из
      // выделенных накладных закрыт чек-лист сверки (флаги приходят в списке).
      this._rowsById = new Map((data || []).map(r => [r.id, r]));
      const tbody = document.getElementById('invoices-tbody');

      if (!data || data.length === 0) {
        const filtered = this.search || this._anyColumnFilter() || this.currentView !== 'all';
        tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">
          <div class="empty-icon">&#128196;</div>
          <div>${filtered
            ? 'Ничего не найдено — измените поиск, период или фильтр.'
            : 'Накладных пока нет. Загрузите фото, PDF или XML документа'}</div>
        </div></td></tr>`;
        return;
      }

      // Group rows by upload day with a date-header row, so the list reads
      // chronologically — the ID column alone gives no sense of "when".
      const dayCounts = {};
      for (const inv of data) { const k = this._dayKey(inv); dayCounts[k] = (dayCounts[k] || 0) + 1; }

      let _lastDay = null;
      const rowsHtml = [];
      for (const inv of data) {
        const day = Invoices._dayKey(inv);
        if (day !== _lastDay) {
          _lastDay = day;
          rowsHtml.push(`
        <tr class="date-group-row" data-day="${day}">
          <td colspan="7">${Invoices._dayHeaderLabel(day, dayCounts[day])}</td>
        </tr>`);
        }
        const review = this._reviewText(inv);
        const priceCount = Number(inv.elevated_price_count) || 0;
        const notes = [review, priceCount ? `${priceCount} ${this._plural(priceCount, 'позиция', 'позиции', 'позиций')} дороже обычного` : ''].filter(Boolean);
        rowsHtml.push(`
          <tr class="clickable${inv.review_reason ? ' invoice-needs-review' : ''}${!inv.read_at ? ' unread' : ''}${this.isVisited(inv.id) ? ' inv-visited' : ''}" data-day="${day}" onclick="Invoices.openInvoice(${inv.id})">
            <td class="col-check"><input type="checkbox" class="row-check" data-id="${inv.id}" onclick="event.stopPropagation()" onchange="Invoices.toggleSelect(${inv.id}, this.checked)" aria-label="Выбрать накладную ${App.esc(inv.invoice_number || inv.id)}"></td>
            <td data-label="Документ"><div class="invoice-cell-stack"><a class="invoice-document-number" href="#/invoices/${inv.id}" onclick="event.preventDefault();event.stopPropagation();Invoices.openInvoice(${inv.id})">${App.esc(inv.invoice_number || 'Без номера')}</a><small>${App.formatDate(inv.invoice_date)} · #${inv.id}</small>${inv.duplicate_of ? `<a href="#/invoices/${inv.duplicate_of}" onclick="event.stopPropagation()" class="invoice-duplicate-link">Дубликат #${inv.duplicate_of}</a>` : ''}</div></td>
            <td data-label="Поставщик"><div class="invoice-cell-stack"><span class="inv-supplier">${App.esc(inv.supplier || 'Не указан')}</span>${notes.length ? `<small class="inv-notes">${notes.map(n => App.esc(n)).join(' · ')}</small>` : ''}</div></td>
            <td class="invoice-money-cell" data-label="Сумма"><div class="invoice-cell-stack"><strong>${App.formatMoney(inv.total_sum)}</strong>${this._vatLine(inv)}</div></td>
            <td class="col-state" data-label="1С"><div class="invoice-cell-stack">${this._onecPill(inv)}</div></td>
            <td class="col-state" data-label="Оплата"><div class="invoice-cell-stack">${this._payPill(inv)}</div></td>
            <td class="cell-action">${this._rowAction(inv)}<button type="button" class="btn-icon-gear" aria-label="Другие действия для накладной ${inv.id}" title="Другие действия" onclick="Invoices.openRowMenu(${inv.id}, ${inv.read_at ? 1 : 0}, ${inv.paid_externally ? 1 : 0}, event)">•••</button></td>
          </tr>`);
      }
      tbody.innerHTML = rowsHtml.join('');
      this._syncSelectAll(); // выбор сброшен в начале loadTable — привести шапку в тон

      // Pagination
      const pagination = document.getElementById('invoices-pagination');
      if (this.offset + data.length < resultTotal) {
        pagination.innerHTML = `
          ${this.offset > 0 ? `<button class="btn btn-outline btn-sm" onclick="Invoices.prevPage()">&larr; Назад</button>` : ''}
          <button class="btn btn-outline btn-sm" onclick="Invoices.nextPage()">Далее &rarr;</button>
        `;
      } else if (this.offset > 0) {
        pagination.innerHTML = `<button class="btn btn-outline btn-sm" onclick="Invoices.prevPage()">&larr; Назад</button>`;
      } else {
        pagination.innerHTML = '';
      }

      // Вернуть позицию прокрутки, сохранённую при переходе в накладную (открытие
      // через openInvoice → «Назад к накладным»). Потребляем один раз, чтобы
      // обычная загрузка списка / пагинация / фильтр начинались сверху. rAF —
      // чтобы страница успела получить полную высоту после рендера строк.
      if (this._listScrollY != null) {
        const y = this._listScrollY;
        this._listScrollY = null;
        requestAnimationFrame(() => window.scrollTo(0, y));
      }
    } catch (e) {
      if (request !== this._listRequest) return;
      document.getElementById('invoices-tbody').innerHTML = '<tr><td colspan="7"><div class="empty-state">Не удалось загрузить накладные. <button class="btn btn-outline btn-sm" onclick="Invoices.loadTable()">Повторить</button></div></td></tr>';
      console.error('Failed to load invoices', e);
      App.notify('Ошибка загрузки накладных', 'error');
    }
  },

  // ── Массовый выбор + отправка в 1С/Сбер ───────────────────────────────────
  toggleSelect(id, checked) {
    if (checked) this._selected.add(id); else this._selected.delete(id);
    this._syncSelectAll();
    this._renderBulkBar();
  },

  toggleSelectAll(checked) {
    for (const cb of document.querySelectorAll('#invoices-tbody .row-check')) {
      cb.checked = checked;
      const id = Number(cb.dataset.id);
      if (checked) this._selected.add(id); else this._selected.delete(id);
    }
    this._renderBulkBar();
  },

  _syncSelectAll() {
    const all = document.getElementById('invoices-select-all');
    if (!all) return;
    const boxes = document.querySelectorAll('#invoices-tbody .row-check');
    const checked = [...boxes].filter(b => b.checked).length;
    all.checked = boxes.length > 0 && checked === boxes.length;
    all.indeterminate = checked > 0 && checked < boxes.length;
  },

  clearSelection() {
    this._selected.clear();
    for (const cb of document.querySelectorAll('#invoices-tbody .row-check')) cb.checked = false;
    this._syncSelectAll();
    this._renderBulkBar();
  },

  _renderBulkBar() {
    const bar = document.getElementById('invoices-bulk-bar');
    if (!bar) return;
    const n = this._selected.size;
    if (n === 0) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
    bar.style.display = '';

    // Сбер требует закрытого чек-листа сверки — сервер отклонит непроверенные
    // (см. гейт в POST /:id/send-sber). Показываем это ДО нажатия: раньше
    // кнопка выглядела рабочей, а накладные молча уезжали в «пропущено».
    const unverified = this._unverifiedSelected();
    const noneReady = unverified === n;
    const sberAttrs = noneReady
      ? ' disabled title="Ни у одной выделенной накладной не сверены реквизиты — откройте накладную и отметьте"'
      : (unverified > 0
        ? ` title="У ${unverified} из ${n} не сверены реквизиты — они будут пропущены"`
        : '');
    const hint = unverified > 0
      ? `<span class="bulk-warn" title="Сбер не примет накладную, пока реквизиты не сверены с фото">⚠ не сверено: ${unverified} из ${n}</span>`
      : '';

    bar.innerHTML = `
      <span class="bulk-count">Выбрано ${n}</span>
      <button class="btn btn-primary btn-sm" onclick="Invoices.bulkSend('onec', event)">&rarr; 1С</button>
      <button class="btn btn-primary btn-sm"${sberAttrs} onclick="Invoices.bulkSend('sber', event)">&rarr; Сбер</button>
      <button class="btn btn-primary btn-sm"${sberAttrs} onclick="Invoices.bulkSend('both', event)">&rarr; 1С и Сбер</button>
      <button class="btn btn-outline btn-sm" onclick="Invoices.clearSelection()">Снять выделение</button>
      ${hint}`;
  },

  // Сколько выделенных накладных ещё не прошли сверку реквизитов.
  // Если строки почему-то нет в кеше (например, список перерисовали) — считаем
  // накладную непроверенной: осторожная сторона, сервер всё равно перепроверит.
  _unverifiedSelected() {
    const keys = ['attr_checked_number', 'attr_checked_date', 'attr_checked_supplier',
                  'attr_checked_total', 'attr_checked_vat', 'attr_checked_vat_rate'];
    let n = 0;
    for (const id of this._selected) {
      const row = this._rowsById?.get(id);
      if (!row || !keys.every(k => row[k])) n++;
    }
    return n;
  },

  async bulkSend(target, ev) {
    const btn = ev?.currentTarget || ev?.target || null;
    const ids = [...this._selected];
    if (ids.length === 0) return;
    return this._withGuard('bulkSend', () => App.withBusyButton(btn, async () => {
      try {
        const reports = [];
        if (target === 'onec' || target === 'both') {
          const { data } = await App.apiJson('/invoices/send-1c-batch', { method: 'POST', body: { ids } });
          reports.push(['1С', data]);
        }
        if (target === 'sber' || target === 'both') {
          const { data } = await App.apiJson('/invoices/send-sber-batch', { method: 'POST', body: { ids } });
          reports.push(['Сбер', data]);
        }
        this._showBulkReport(reports);
        this.loadTable(); // обновить статусы + сбросить выбор
      } catch (e) {
        App.notify('Ошибка массовой отправки: ' + e.message, 'error');
      }
    }));
  },

  _showBulkReport(reports) {
    const LABELS = {
      not_processed: 'не в статусе «Обработан»',
      already_approved: 'уже отправлена в 1С',
      incomplete_pages: 'накладная снята не полностью — добавьте недостающие страницы',
      over_threshold: 'выше лимита — отправьте по одной',
      supplier_unverified: 'поставщик не подтверждён — отправьте по одной',
      already_paid: 'платёж уже создан',
      attrs_unchecked: 'реквизиты не сверены с фото — откройте накладную и отметьте',
      no_inn: 'нет ИНН поставщика',
      no_total: 'нет суммы',
      sber_not_connected: 'Сбер не подключён',
      payer_incomplete: 'реквизиты плательщика не заполнены',
      no_owner: 'нет владельца',
      api_error: 'ошибка Сбербанка',
      invalid: 'нельзя отправить',
      error: 'ошибка',
    };
    const lines = reports.map(([name, d]) => `${name}: ${d.sent} отправлено, ${d.skipped.length} пропущено`);
    const allClean = reports.every(([, d]) => d.skipped.length === 0);
    App.notify(lines.join('. '), allClean ? 'success' : 'info');
    if (allClean) return;

    const skippedBlocks = reports.filter(([, d]) => d.skipped.length > 0).map(([name, d]) => {
      const byReason = {};
      for (const s of d.skipped) { (byReason[s.reason] = byReason[s.reason] || []).push(s.id); }
      const items = Object.entries(byReason).map(([reason, ids]) =>
        `<li><b>${App.esc(LABELS[reason] || reason)}</b>: №${ids.join(', №')}</li>`).join('');
      return `<div style="margin-top:12px"><div style="font-weight:600">${App.esc(name)} — пропущено ${d.skipped.length}:</div><ul style="margin:6px 0 0;padding-left:20px;line-height:1.6">${items}</ul></div>`;
    }).join('');

    let modal = document.getElementById('bulk-report-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'bulk-report-modal';
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:none;align-items:center;justify-content:center;z-index:9999;padding:20px';
      document.body.appendChild(modal);
    }
    modal.innerHTML = `<div style="background:var(--card,#fff);border-radius:12px;max-width:520px;width:100%;padding:22px;max-height:80vh;overflow:auto">
      <div style="font-size:16px;font-weight:600;margin-bottom:8px">Результат массовой отправки</div>
      <div style="color:var(--text-secondary,#64748b)">${lines.map(l => App.esc(l)).join('<br>')}</div>
      ${skippedBlocks}
      <div style="margin-top:18px;text-align:right"><button class="btn btn-primary" id="bulk-report-ok">Понятно</button></div>
    </div>`;
    modal.style.display = 'flex';
    modal.querySelector('#bulk-report-ok').onclick = () => { modal.style.display = 'none'; };
    modal.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };
  },

  setFilter(status) {
    this.currentStatus = (status && status !== 'all') ? status : null;
    this.offset = 0;
    this.loadTable();
  },

  nextPage() {
    this.offset += this.limit;
    this.loadTable();
  },

  prevPage() {
    this.offset = Math.max(0, this.offset - this.limit);
    this.loadTable();
  },

  // ===== Upload-day helpers (used by the in-table date-group headers) =====

  // Upload-day key "YYYY-MM-DD". The DB layer uses dateStrings, so created_at is
  // "YYYY-MM-DD HH:MM:SS" in local server time — its first 10 chars are the
  // calendar day with no timezone drift.
  _dayKey(inv) {
    return String((inv && inv.created_at) || '').slice(0, 10);
  },

  _localKey(dt) {
    const p = n => String(n).padStart(2, '0');
    return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
  },

  // Friendly label for a day key: «Сегодня»/«Вчера», else DD.MM.YYYY; plus a
  // short weekday sub-line.
  _dayLabel(key) {
    if (!key) return { main: 'Без даты', sub: '' };
    const today = this._localKey(new Date());
    const yest = this._localKey(new Date(Date.now() - 86400000));
    const [y, m, d] = key.split('-');
    const main = key === today ? 'Сегодня' : key === yest ? 'Вчера' : `${d}.${m}.${y}`;
    let sub = '';
    try { sub = new Date(key + 'T00:00:00').toLocaleDateString('ru-RU', { weekday: 'short' }); } catch { /* ignore */ }
    return { main, sub };
  },

  // Full header for an in-table date-group row: «вторник, 16 июня 2026 · 6 накладных»,
  // with a «Сегодня»/«Вчера» prefix for the two most recent days.
  _dayHeaderLabel(key, count) {
    if (!key) return '<span class="date-group-row__date">Без даты загрузки</span>';
    const { main } = this._dayLabel(key);
    let full = key;
    try {
      full = new Date(key + 'T00:00:00').toLocaleDateString('ru-RU',
        { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      full = full.charAt(0).toUpperCase() + full.slice(1);
    } catch { /* ignore */ }
    const rel = (main === 'Сегодня' || main === 'Вчера') ? `${main} · ` : '';
    const noun = this._plural(count || 0, 'накладная', 'накладные', 'накладных');
    const cnt = count ? ` <span class="date-group-row__count">${count} ${noun}</span>` : '';
    return `<span class="date-group-row__date">${rel}${full}</span>${cnt}`;
  },

  // Compact "Период" presets. Server-side, so they span ALL pages — unlike the
  // old left sidebar, which only hid rows already loaded on the current page.
  _renderPeriod() {
    const el = document.getElementById('invoices-period');
    if (!el) return;
    const presets = [
      { key: 'all', label: 'Все' },
      { key: 'today', label: 'Сегодня' },
      { key: 'yesterday', label: 'Вчера' },
      { key: '7d', label: '7 дней' },
      { key: '30d', label: '30 дней' },
    ];
    el.innerHTML = `<span class="period-filter__label">Период:</span>` + presets.map(p =>
      `<button type="button" class="period-btn${this.period === p.key ? ' active' : ''}" aria-pressed="${this.period === p.key ? 'true' : 'false'}" onclick="Invoices.setPeriod('${p.key}')">${p.label}</button>`
    ).join('');
  },

  // Set the upload-date range from a preset and reload from the server (offset
  // reset). `to` is the EXCLUSIVE upper bound (next day).
  setPeriod(key) {
    this.period = key;
    const pad = n => String(n).padStart(2, '0');
    const iso = dt => `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const add = (base, n) => { const x = new Date(base); x.setDate(x.getDate() + n); return x; };
    let from = null, to = null;
    if (key === 'today') { from = iso(today); to = iso(add(today, 1)); }
    else if (key === 'yesterday') { from = iso(add(today, -1)); to = iso(today); }
    else if (key === '7d') { from = iso(add(today, -6)); to = iso(add(today, 1)); }
    else if (key === '30d') { from = iso(add(today, -29)); to = iso(add(today, 1)); }
    this.dateFrom = from;
    this.dateTo = to;
    this.offset = 0;
    // Держим поля дат в строке фильтров в тон выбранному пресету, иначе чипс и
    // календарь показывали бы разное. В поле «по» кладём ВКЛЮЧИТЕЛЬНУЮ дату
    // (to минус день), потому что на сервер уходит эксклюзивная граница.
    const fromEl = document.getElementById('filter-date-from');
    const toEl = document.getElementById('filter-date-to');
    if (fromEl) fromEl.value = from || '';
    if (toEl) toEl.value = to ? this._prevDayIso(to) : '';
    this._syncFilterReset();
    this.loadTable();
  },

  _prevDayIso(iso) {
    const d = new Date(`${iso}T00:00:00`);
    if (Number.isNaN(d.getTime())) return '';
    d.setDate(d.getDate() - 1);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  },

  // ── Пер-колоночные фильтры ────────────────────────────────────────────────
  // Один вход на все поля строки фильтров. Текст дебаунсим (пользователь печатает),
  // select'ы и даты применяем сразу — там значение меняется разом.
  setColumnFilter(field, value) {
    const v = (value || '').trim();
    let immediate = true;
    if (field === 'status') {
      this.currentStatus = v || null;
    } else if (field === 'dateFrom' || field === 'dateTo') {
      // Явная дата отменяет пресет периода: иначе следующий loadTable
      // перерисовал бы чипсы с подсвеченным «Все», хотя диапазон уже свой.
      // dateTo делаем ЭКСКЛЮЗИВНОЙ верхней границей (+1 день), чтобы выбранный
      // в календаре день попадал в выборку целиком — так же, как в setPeriod.
      this.period = 'custom';
      if (field === 'dateFrom') {
        this.dateFrom = v || null;
      } else {
        this.dateTo = v ? this._nextDayIso(v) : null;
      }
    } else {
      this.colFilters[field] = v;
      immediate = (field === 'sber');
    }
    this.offset = 0;
    this._syncFilterReset();
    clearTimeout(this._filterTimer);
    if (immediate) this.loadTable();
    else this._filterTimer = setTimeout(() => this.loadTable(), 300);
  },

  // Верхняя граница диапазона дат на сервере эксклюзивна (created_at < :to),
  // поэтому выбранный пользователем день сдвигаем на сутки вперёд.
  _nextDayIso(iso) {
    const d = new Date(`${iso}T00:00:00`);
    if (Number.isNaN(d.getTime())) return null;
    d.setDate(d.getDate() + 1);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  },

  _anyColumnFilter() {
    const f = this.colFilters;
    return !!(f.number || f.supplier || f.sumFrom || f.sumTo || f.sber
      || this.currentStatus || this.dateFrom || this.dateTo || this.currentView !== 'all');
  },

  // Кнопка «Сбросить» появляется, только когда что-то реально выбрано.
  _syncFilterReset() {
    const btn = document.getElementById('filter-reset');
    if (btn) btn.hidden = !this._anyColumnFilter();
  },

  resetColumnFilters() {
    this.currentView = 'all';
    this._renderSummary();
    this.colFilters = { number: '', supplier: '', sumFrom: '', sumTo: '', sber: '' };
    this.currentStatus = null;
    this.dateFrom = null;
    this.dateTo = null;
    this.period = 'all';
    this.offset = 0;
    ['filter-number', 'filter-supplier', 'filter-sum-from', 'filter-sum-to',
     'filter-date-from', 'filter-date-to', 'filter-status', 'filter-sber']
      .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    this._syncFilterReset();
    clearTimeout(this._filterTimer);
    this.loadTable();
  },

  // Debounced server-side search over invoice number / supplier / ИНН.
  setSearch(q) {
    this.search = (q || '').trim();
    this.offset = 0;
    clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => this.loadTable(), 300);
  },

  // Renders the «Цены ↑» cell: how many line items are priced >10% above the
  // usual (median) price. Reddish badge when > 0, muted «—» when none. The
  // count is computed server-side (attachElevatedPriceCount) using the same
  // rule as the detail page, so list and card never disagree.
  _elevatedCell(inv) {
    const n = inv.elevated_price_count || 0;
    if (n <= 0) return '<span style="color:#cbd5e1" title="Нет позиций дороже обычного">—</span>';
    const noun = this._plural(n, 'позиция', 'позиции', 'позиций');
    return `<span style="display:inline-block;min-width:20px;padding:2px 7px;border-radius:10px;background:#fee2e2;color:#dc2626;font-weight:600;font-size:12px" title="${n} ${noun} дороже обычного более чем на 10%">${n}</span>`;
  },

  // Плашка статуса в списке: точка + текст, подпись мелко под ней. Цвета одни на
  // обе колонки: серый — ещё нет, синий — в работе, зелёный — готово, янтарный —
  // нужно внимание, красный — ошибка. note приходит уже экранированным.
  _pill(tone, text, note = '') {
    return `<span class="inv-pill inv-pill--${tone}"><i aria-hidden="true"></i>${text}</span>${note ? `<small class="inv-pill-note" title="${note}">${note}</small>` : ''}`;
  },

  // Колонка «1С»: где накладная на пути в 1С.
  _onecPill(inv) {
    if (inv.duplicate_of || inv.status === 'duplicate') return this._pill('amber', 'Дубликат', 'не отправляется');
    if (inv.status === 'error') return this._pill('red', 'Ошибка', 'распознавания');
    if (inv.status === 'waiting_ai') return this._pill('blue', 'Ждёт GPT', 'распознается позже');
    if (['new', 'ocr_processing', 'parsing'].includes(inv.status)) return this._pill('blue', 'Распознаётся');
    if (['error', 'rejected'].includes(inv.onec_status)) return this._pill('red', 'Не принята', App.esc(inv.onec_error || 'ошибка 1С'));
    // «В 1С» — по статусу накладной: после «Сбросить статус» onec_status остаётся прежним.
    if (inv.status === 'sent_to_1c') return this._pill('green', 'В 1С', inv.onec_status === 'created' ? 'не проведена' : '');
    if (inv.approved_for_1c) return this._pill('blue', 'В очереди', 'ждёт загрузки');
    if (inv.review_reason) return this._pill('amber', 'Проверить');
    return this._pill('grey', 'Не отправлена');
  },

  // ── Чек-лист «сверено с фото» ─────────────────────────────────────────────
  // Пять реквизитов шапки, которые бухгалтер сверяет глазами перед оплатой.
  // Пока не отмечены все пять, сервер не даёт создать платёж в Сбере (запрет
  // живёт на бэкенде — disabled-кнопка это лишь удобство).
  ATTR_FIELDS: {
    number: 'invoice_number',
    date: 'invoice_date',
    supplier: 'supplier',
    total: 'total_sum',
    vat: 'vat_sum',
    vat_rate: null,   // ставка живёт в позициях, отдельного поля шапки нет
  },

  // Отметить/снять один реквизит. Состояние берём ИЗ ОТВЕТА сервера, а не из
  // предположения: так интерфейс не разойдётся с базой, если запрос не прошёл.
  async toggleAttrCheck(id, attr, value) {
    try {
      const { data } = await App.apiJson(`/invoices/${id}/attr-check`, {
        method: 'POST', body: { attr, value },
      });
      this._applyAttrState(data);
    } catch (e) {
      App.notify('Не удалось сохранить отметку', 'error');
      this._syncSberGate();
    }
  },

  // Общая галочка у кнопки отправки — ставит/снимает все пять разом.
  async toggleAllAttrChecks(id, value) {
    try {
      const { data } = await App.apiJson(`/invoices/${id}/attr-check`, {
        method: 'POST', body: { attr: 'all', value },
      });
      this._applyAttrState(data);
    } catch (e) {
      App.notify('Не удалось сохранить отметку', 'error');
    }
  },

  // Состояние сверки с сервера: в карточку (шаг «Сверка»), гейт Сбера и панель проверки.
  _applyAttrState(state) {
    if (!state) return;
    const inv = typeof InvoiceCard !== 'undefined' ? InvoiceCard.inv : null;
    if (inv && inv.id === this._currentInvoiceId) {
      Object.keys(this.ATTR_FIELDS).forEach(attr => { inv[`attr_checked_${attr}`] = state[attr] ? 1 : 0; });
      InvoiceCard.renderSteps();
    }
    this._syncSberGate();
    if (typeof InvoiceReview !== 'undefined') { InvoiceReview.renderDecision(); InvoiceReview.refresh(); }
  },

  // Единственное место, где решается, можно ли жать «Отправить в Сбербанк».
  // Зовётся и после переключения галочки, и после отрисовки блока Сбера.
  _syncSberGate() {
    const inv = typeof InvoiceCard !== 'undefined' ? InvoiceCard.inv : null;
    if (!inv || inv.id !== this._currentInvoiceId) return;
    const missing = InvoiceCard.requisites(inv).filter(r => !r.checked).map(r => r.label);
    const all = missing.length === 0;

    const master = document.getElementById('sber-attrs-all');
    if (master) master.checked = all;

    const btn = document.getElementById('sber-send-btn');
    if (btn) {
      btn.disabled = !all;
      btn.title = all
        ? 'Создать черновик платёжного поручения в СберБизнес'
        : `Сначала сверьте с фото: ${missing.join(', ')}`;
    }
    const hint = document.getElementById('sber-attrs-hint');
    if (hint) {
      hint.textContent = all ? '' : `Не сверено: ${missing.join(', ')}`;
      hint.hidden = all;
    }
  },

  // «в т.ч. НДС» под суммой в списке — раньше НДС был виден только внутри накладной.
  _vatLine(inv) {
    if (inv.vat_sum == null) return '';
    const v = Number(inv.vat_sum);
    if (!Number.isFinite(v)) return '';
    return v > 0
      ? `<div class="list-vat">в т.ч. НДС ${App.formatMoney(v)}</div>`
      : '<div class="list-vat">без НДС</div>';
  },

  // Колонка «Оплата»: платёжка в СберБизнес или отметка «оплачено вне сервиса».
  _payPill(inv) {
    if (inv.paid_externally) return this._pill('green', 'Оплачено', 'вне сервиса');
    const status = inv.sber_payment_status, kind = inv.sber_bank_kind;
    if (status === 'created' && kind === 'paid') return this._pill('green', 'Оплачено', 'исполнено банком');
    if (status === 'failed' || kind === 'failed') return this._pill('red', 'Ошибка', App.esc(inv.sber_bank_label || 'платёжка не создана'));
    if (status === 'pending') return this._pill('blue', 'Создаётся');
    if (status === 'created') {
      const draft = !kind || kind === 'draft' || kind === 'unknown';
      return this._pill('blue', draft ? 'Черновик' : 'В банке', draft ? 'ждёт подписи' : App.esc(inv.sber_bank_label || 'в работе банка'));
    }
    if (inv.sber_overdue) return this._pill('amber', 'Нет платёжки', `больше ${Number(inv.sber_overdue_days) || 14} дней`);
    return this._pill('grey', 'Нет платёжки');
  },

  async showDetail(id) {
    if (typeof InvoiceReview !== 'undefined') InvoiceReview.reset(id);
    document.getElementById('invoices-list').style.display = 'none';
    document.getElementById('invoice-detail').style.display = 'block';
    document.getElementById('view-invoices')?.classList.add('is-detail');

    const switching = this._currentInvoiceId !== id;
    this._currentInvoiceId = id;
    this._photosLoaded = false;
    this._photoFiles = [];
    InvoicePhotoViewer.close();
    if (typeof InvoiceCard !== 'undefined') InvoiceCard.closeMenu();
    this._markVisited(id);
    this._loadNeighbours(id);
    // Другая накладная — с вкладки «Товары»; та же (перерисовка после правки) — вкладку не трогаем.
    if (switching) this.switchTab('items');

    await OnecCatalog.load();

    try {
      const { data } = await App.apiJson(`/invoices/${id}`);
      if (id !== this._currentInvoiceId) return;
      if (!data) {
        App.notify('Накладная не найдена', 'error');
        App.navigate('#/invoices');
        return;
      }

      // Электронный документ из XML: в скане — сам документ, внизу «Истории» — разобранные данные.
      const isXml = App.isXmlInvoice(data);
      this._currentXml = isXml ? this._xmlMeta(data) : null;
      this._photoTitle = `Накладная ${data.invoice_number || '#' + data.id}`;
      const ocrSummary = document.getElementById('ic-ocr-summary');
      if (ocrSummary) ocrSummary.textContent = isXml ? 'Данные XML' : 'Текст распознавания';
      const count = document.getElementById('ic-items-count');
      if (count) count.textContent = (data.items || []).length ? `· ${data.items.length}` : '';

      // Шапка, шаги и панель шага — InvoiceCard (public/js/invoice-card.js).
      InvoiceCard.render(data);

      // История — для любой накладной, в т.ч. дубликата.
      this.renderHistory(data).catch(e => console.error('renderHistory failed', e));

      // Поставщик и банк — словами, без служебных кодов.
      this._renderSupplierTab(data);

      // Пропущенные страницы (разрыв в нумерации строк) — над шагами.
      this._renderCompleteness(data);

      // Дубликат: позиции не сохраняются, шаги 1С и оплаты недоступны.
      const dupEl = document.getElementById('ic-duplicate');
      if (data.duplicate_of) {
        let duplicateReasons = [];
        try { duplicateReasons = JSON.parse(data.duplicate_reasons || '[]'); } catch { duplicateReasons = []; }
        const evidence = duplicateReasons.length
          ? duplicateReasons.map(reason => App.esc(reason)).join(' · ')
          : 'Совпали ключевые реквизиты документа';
        const probability = data.duplicate_score ? `, вероятность ${Math.round(data.duplicate_score * 100)}%` : '';
        dupEl.innerHTML = `
          <div class="duplicate-banner">
            <div class="duplicate-banner-text">
              <strong>Дубликат накладной</strong>
              <a href="#/invoices/${data.duplicate_of}">№${data.duplicate_of}</a>
              ${App.esc(probability)} — ${evidence}. Позиции в эту запись не сохранены.
            </div>
            <div class="duplicate-banner-actions">
              <button class="btn btn-outline btn-sm" onclick="Invoices.unlinkDuplicate(${data.id})">Не дубликат</button>
              <button class="btn btn-danger btn-sm" onclick="Invoices.deleteInvoice(${data.id})">Удалить дубликат</button>
            </div>
          </div>`;
        document.getElementById('invoice-items-tbody').innerHTML = '<tr><td colspan="7"><div class="empty-state">Позиции дубликата не сохраняются — откройте основную накладную</div></td></tr>';
        document.getElementById('invoice-items-toolbar').innerHTML = '';
        document.getElementById('invoice-price-warning').innerHTML = '';
        const banner = document.getElementById('invoice-sibling-banner');
        if (banner) banner.style.display = 'none';
        const sberWrap = document.getElementById('invoice-sber-section');
        if (sberWrap) sberWrap.innerHTML = '<p class="ic-muted">Дубликат не оплачивается — платёжку создают по основной накладной.</p>';
        document.getElementById('invoice-ocr-text').textContent = data.raw_text || 'Нет данных';
        if (typeof InvoiceReview !== 'undefined') InvoiceReview.mount(data);
        return;
      }
      if (dupEl) dupEl.innerHTML = '';

      // Похоже на ту же накладную (те же номер, поставщик и дата): предложить объединить.
      const sibs = data.possible_siblings || [];
      const banner = document.getElementById('invoice-sibling-banner');
      if (sibs.length > 0) {
        const sentWarn = data.status === 'sent_to_1c' || data.approved_for_1c
          || sibs.some(s => s.status === 'sent_to_1c' || s.approved_for_1c);
        banner.style.display = 'block';
        banner.innerHTML = sibs.map(s => `
          <div class="duplicate-banner">
            <div class="duplicate-banner-text">
              <strong>Похоже на ту же накладную:</strong>
              <a href="#/invoices/${s.id}">№${s.id}</a>
              — ${s.items_count} позиц., ${App.formatMoney(s.total_sum)} ₽${s.status === 'sent_to_1c' ? ', уже в 1С' : ''}.
              ${isXml
                ? 'Эта накладная загружена из XML целиком — если там фото того же документа, лишнюю накладную удалите.'
                : 'Возможно, это страницы одной накладной.'}
            </div>
            ${isXml ? '' : `<div class="duplicate-banner-actions">
              <button class="btn btn-primary btn-sm"
                onclick="Invoices.mergeSibling(${data.id}, ${s.id}, ${sentWarn})">Объединить</button>
            </div>`}
          </div>
        `).join('');
      } else if (banner) {
        banner.style.display = 'none';
      }

      // Оплата — в панели шага 3.
      if (window.Sber) {
        Sber.renderInvoiceSection(data).catch(err => console.error('[sber] render section', err));
      }

      // Товары
      const itemsTbody = document.getElementById('invoice-items-tbody');
      if (data.items && data.items.length > 0) {
        itemsTbody.innerHTML = data.items.map((item, i) => this._itemRow(data, item, i)).join('');
      } else {
        itemsTbody.innerHTML = '<tr><td colspan="7"><div class="empty-state">Товары не найдены</div></td></tr>';
      }

      // Правка строк: добавить пропущенную, одна ставка НДС на все строки.
      const tb = document.getElementById('invoice-items-toolbar');
      if (tb) tb.innerHTML = this._itemsToolbar(data.id);

      // Предупреждения над товарами + счётчики цены на телефоне.
      this._renderPriceWarning(data.items || [], data.alignment_problems || []);
      this._renderPriceBadges(data.items || []);

      // Для строк без позиции 1С — уверенное предложение из каталога (подтверждается кликом)
      // и три кандидата «в один клик».
      this._suggestUnmapped(data.id, data.items || []);
      this._loadCandidates(data.id).catch(e => console.warn('candidates failed', e));

      document.getElementById('invoice-ocr-text').textContent = data.raw_text || 'Нет данных';
      if (typeof InvoiceReview !== 'undefined') InvoiceReview.mount(data);

    } catch (e) {
      // Страница могла войти в другую накладную: уведомление «фото загружено»
      // уходит до распознавания, поэтому ссылка на неё успевает разойтись по
      // чатам, а сама строка при склейке удаляется. Сервер подсказывает
      // приёмника — переключаемся на него вместо «не найдено».
      const mergedInto = e?.body?.merged_into;
      if (mergedInto) {
        App.notify(`Эта страница вошла в накладную #${mergedInto} — открываем её`, 'info');
        App.navigate(`#/invoices/${mergedInto}`);
        return;
      }
      console.error('Failed to load invoice detail', e);
      App.notify('Ошибка загрузки накладной', 'error');
    }
  },

  // Строка товара: «как в накладной» + позиция 1С, количество с пересчётом серым,
  // цена (с обычной ценой), сумма, НДС, меню строки «⋯». Проблема — меткой у названия.
  _itemRow(data, item, i) {
    // Номер как напечатан — только если номера уникальны (у многостраничной накладной
    // нумерация на каждом листе с 1, тогда — по порядку).
    if (data._printedRowNo === undefined) {
      const nums = (data.items || []).map(it => it.row_no);
      data._printedRowNo = nums.every(n => Number.isInteger(n) && n > 0) && new Set(nums).size === nums.length;
    }
    const no = data._printedRowNo ? item.row_no : i + 1;
    const badge = item.name_overridden
      ? '<span class="nom-badge nom-badge-custom" title="Своё название — будет создано в 1С под этим именем">✎</span>'
      : item.onec_guid
        ? '<span class="nom-badge nom-badge-ok" title="Сопоставлено с 1С">✓</span>'
        : '<span class="nom-badge nom-badge-missing" title="Нет позиции 1С">●</span>';
    const safeName = App.esc(item.mapped_name || item.original_name || '');
    const tags = this._itemTags(data, item);
    const flagged = tags.includes('ic-tag--amber') || tags.includes('ic-tag--red');
    const rawDiffers = item.raw_quantity != null && (Number(item.raw_quantity) !== Number(item.quantity) || this._normUnit(item.raw_unit) !== this._normUnit(item.unit));
    const convText = item.conv_note
      ? String(item.conv_note).split(' = ')[0].replace(/\s*—\s*подобрано.*$/, '').replace(/\s*\([^)]*\)\s*$/, '')
      : rawDiffers ? `в накладной: ${App.formatQty(item.raw_quantity)} ${item.raw_unit || ''}`.trim() : '';
    const median = item.median_price != null
      ? `<span class="ic-sub-line" title="Обычная цена: медиана за ${item.median_samples ?? 0} поставок">обычно ${App.formatMoney(item.median_price)}</span>`
      : '';
    const editAttrs = (field) => `data-invoice-id="${data.id}" data-item-id="${item.id}" data-field="${field}" onblur="Invoices.onItemEdit(event)" onkeydown="Invoices.onItemEditKey(event)"`;
    return `
      <tr data-item-id="${item.id}" class="${flagged ? 'ic-row--flag' : ''}">
        <td class="ic-row-no">${no}</td>
        <td class="ic-cell-name">
          <div class="ic-row-name">${App.esc(item.original_name || '')}${tags}</div>
          <div class="ic-row-onec">
            <div class="nom-picker">
              ${badge}
              <input type="text" class="nom-picker-input" value="${safeName}" aria-label="Позиция 1С для строки ${no}"
                     data-invoice-id="${data.id}" data-item-id="${item.id}" data-current-guid="${App.esc(item.onec_guid || '')}"
                     placeholder="Выбрать позицию 1С…"
                     oninput="Invoices.onNomInput(event)" onfocus="Invoices.onNomFocus(event)" onblur="Invoices.onNomBlur(event)">
              <div class="nom-picker-dropdown" id="nom-dd-${item.id}"></div>
            </div>
            ${(!item.onec_guid || (item.mapping_confidence ?? 0) < 0.8) && !item.name_overridden
              ? `<div class="nom-cands" id="nom-cands-${item.id}" data-invoice-id="${data.id}" data-item-id="${item.id}"></div>`
              : ''}
            ${item.name_overridden ? '<div class="nom-custom-note" title="Это название уйдёт в 1С для создания товара">Своё название — товар создастся в 1С</div>' : ''}
          </div>
        </td>
        <td class="ic-num" data-label="Кол-во">
          <span class="ic-qty"><input type="text" inputmode="decimal" class="item-edit item-edit-qty" aria-label="Количество"
                 value="${item.quantity != null ? String(item.quantity).replace('.', ',') : ''}" ${editAttrs('quantity')}><input type="text" class="item-edit item-edit-unit" aria-label="Единица"
                 value="${App.esc(item.unit || '')}" ${editAttrs('unit')}></span>
          ${convText ? `<span class="ic-sub-line" title="${App.esc(item.conv_note || '')}">${App.esc(convText)}</span>` : ''}
        </td>
        <td class="ic-num" data-label="Цена с НДС">
          <input type="text" inputmode="decimal" class="item-edit item-edit-price" aria-label="Цена с НДС" title="Цена за единицу с НДС — сумма пересчитается"
                 value="${item.price != null ? Number(item.price).toFixed(2).replace('.', ',') : ''}" ${editAttrs('price')}>${median}
        </td>
        <td class="ic-num" data-label="Сумма">
          <input type="text" inputmode="decimal" class="item-edit item-edit-total" aria-label="Сумма строки"
                 value="${item.total != null ? Number(item.total).toFixed(2).replace('.', ',') : ''}" ${editAttrs('total')}>
        </td>
        <td class="ic-num" data-label="НДС">${this._vatSelect(data.id, item)}</td>
        <td class="ic-cell-menu"><button type="button" class="ic-row-more" aria-haspopup="menu" aria-expanded="false" aria-label="Действия со строкой ${no}" title="Действия со строкой" onclick="InvoiceCard.openRowMenu(this, ${item.id})"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg></button></td>
      </tr>`;
  },

  // Метки проблем строки у названия: нужен вес, количество под вопросом, цена выше обычной,
  // нет позиции 1С, позиция под вопросом, «1С переведёт на кг».
  _itemTags(data, item) {
    const tags = [];
    const flag = item.qty_flag;
    if (flag === 'needs_weight') {
      tags.push(`<button type="button" class="ic-tag ic-tag--red" title="${App.esc(item.qty_flag_note || 'Вес единицы в названии не найден')}" onclick="Invoices.itemRememberRule(${data.id}, ${item.id})">нужен вес</button>`);
    } else if (flag) {
      const label = flag === 'price_outlier' ? 'проверьте количество' : 'единица не как в 1С';
      tags.push(`<button type="button" class="ic-tag ic-tag--amber" title="${App.esc(item.qty_flag_note || '')}" onclick="Invoices.itemReconvert(${data.id}, ${item.id})">${label}</button>`);
    } else if (this._unitMismatch(item)) {
      tags.push(`<button type="button" class="ic-tag ic-tag--amber" title="Количество не в той единице — пересчитать от значений «как в накладной»" onclick="Invoices.itemReconvert(${data.id}, ${item.id})">${this._normUnit(item.target_unit) === 'кг' ? 'не в кг' : `в 1С учёт в «${App.esc(item.onec_unit || '')}»`}</button>`);
    } else if (this._onecSwitchesToKg(item)) {
      tags.push(`<span class="ic-tag ic-tag--blue" title="В 1С позиция ведётся в «${App.esc(item.onec_unit)}» — при загрузке 1С переведёт её на кг">1С переведёт на кг</span>`);
    }
    if (item.price_deviation_pct != null && item.price_deviation_pct > 10) {
      tags.push(`<span class="ic-tag ic-tag--amber" title="Цена выше обычной на ${Math.round(item.price_deviation_pct)}%">цена +${Math.round(item.price_deviation_pct)}%</span>`);
    }
    if (!item.onec_guid && !item.name_overridden) {
      tags.push('<span class="ic-tag ic-tag--red" title="1С создаст товар по названию из накладной, если не выбрать позицию">нет позиции 1С</span>');
    } else if (item.onec_guid && (item.mapping_confidence ?? 1) < 0.8) {
      tags.push(`<span class="ic-tag ic-tag--amber" title="Позиция 1С подобрана неуверенно — проверьте">позиция ${Math.round((item.mapping_confidence || 0) * 100)}%</span>`);
    }
    return tags.join('');
  },

  // Вкладка «Поставщик и банк»: реквизиты словами, предупреждение о привязке по названию.
  _INVOICE_TYPES: { 'счет_на_оплату': 'Счёт на оплату', 'торг_12': 'ТОРГ-12', 'упд': 'УПД', 'счет_фактура': 'Счёт-фактура', 'акт': 'Акт', 'кассовый_чек': 'Кассовый чек', 'авансовый_отчет': 'Авансовый отчёт', 'прочее': 'Другой документ' },

  _renderSupplierTab(data) {
    const el = document.getElementById('invoice-supplier-details');
    if (!el) return;
    const row = (label, value, wide = false) => value ? `<div class="invoice-field${wide ? ' invoice-field--wide' : ''}"><div class="field-label">${label}</div><div class="field-value">${App.esc(value)}</div></div>` : '';
    const fields = [
      row('Поставщик', data.supplier),
      row('ИНН', data.supplier_inn),
      row('КПП', data.supplier_kpp),
      row('Тип документа', this._INVOICE_TYPES[data.invoice_type] || (App.isXmlInvoice(data) ? 'Электронный документ (XML)' : '')),
      row('Банк, БИК', data.supplier_bik),
      row('Расчётный счёт', data.supplier_account),
      row('Корр. счёт', data.supplier_corr_account),
      row('Адрес', data.supplier_address, true),
    ].join('');
    el.innerHTML = this._supplierMatchBanner(data)
      + (fields ? `<div class="invoice-header">${fields}</div>` : '<p class="ic-muted">Реквизиты поставщика не распознаны — их можно ввести в «⋯ → Изменить реквизиты».</p>');
  },

  _VAT_OPTIONS: [['', '—'], ['0', '0%'], ['5', '5%'], ['7', '7%'], ['10', '10%'], ['18', '18%'], ['20', '20%'], ['22', '22%']],

  _vatSelect(invoiceId, item) {
    const cur = item.vat_rate == null ? '' : String(Number(item.vat_rate));
    return `<select class="item-vat-select" title="Ставка НДС строки (уходит в 1С)"
                    onchange="Invoices.onItemVatChange(${invoiceId}, ${item.id}, this)">
      ${this._VAT_OPTIONS.map(([v, l]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${l}</option>`).join('')}
    </select>`;
  },

  async onItemVatChange(invoiceId, itemId, sel) {
    try {
      await App.apiJson(`/invoices/${invoiceId}/items/${itemId}`, { method: 'PATCH', body: { vat_rate: sel.value === '' ? null : Number(sel.value) } });
      App.notify('Ставка НДС сохранена', 'success');
    } catch (e) {
      App.notify('Не сохранилось: ' + e.message, 'error');
    }
    this.showDetail(Number(invoiceId));
  },

  async setAllVat(invoiceId, sel) {
    if (sel.value === '__') return;
    const label = sel.options[sel.selectedIndex].text;
    if (!window.confirm(`Поставить НДС ${label} всем строкам?`)) { sel.value = '__'; return; }
    try {
      const { data } = await App.apiJson(`/invoices/${invoiceId}/items/vat-rate`, { method: 'POST', body: { vat_rate: sel.value === '' ? null : Number(sel.value) } });
      App.notify(`НДС ${label} — у ${data.lines} строк`, 'success');
    } catch (e) {
      App.notify('Не сохранилось: ' + e.message, 'error');
    }
    this.showDetail(Number(invoiceId));
  },

  async deleteItem(invoiceId, itemId, name) {
    if (!window.confirm(`Удалить строку «${name}»?\n\nСумма накладной не изменится — если строка была в итоге документа, поправьте сумму в реквизитах.`)) return;
    try {
      await App.apiJson(`/invoices/${invoiceId}/items/${itemId}`, { method: 'DELETE' });
      App.notify('Строка удалена', 'success');
    } catch (e) {
      App.notify('Не удалилось: ' + e.message, 'error');
    }
    this.showDetail(Number(invoiceId));
  },

  _itemsToolbar(invoiceId) {
    return `
      <div class="items-toolbar">
        <button type="button" class="btn btn-soft btn-sm" onclick="Invoices.toggleAddItem(${invoiceId})">+ Добавить строку</button>
        <label class="items-toolbar-vat">НДС для всех строк
          <select onchange="Invoices.setAllVat(${invoiceId}, this)">
            <option value="__" selected>выбрать…</option>
            ${this._VAT_OPTIONS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
          </select>
        </label>
      </div>
      <form id="add-item-form" class="add-item-form" hidden onsubmit="Invoices.submitAddItem(event, ${invoiceId})">
        <input name="original_name" placeholder="Название товара" required>
        <input name="quantity" inputmode="decimal" placeholder="Кол-во" required>
        <input name="unit" placeholder="Ед." value="шт">
        <input name="price" inputmode="decimal" placeholder="Цена с НДС">
        <input name="total" inputmode="decimal" placeholder="или сумма">
        <select name="vat_rate">${this._VAT_OPTIONS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
        <button class="btn btn-primary btn-sm" type="submit">Добавить</button>
      </form>`;
  },

  toggleAddItem() {
    const f = document.getElementById('add-item-form');
    if (!f) return;
    f.hidden = !f.hidden;
    if (!f.hidden) f.querySelector('input[name="original_name"]').focus();
  },

  async submitAddItem(e, invoiceId) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    if (body.vat_rate === '') body.vat_rate = null;
    try {
      await App.apiJson(`/invoices/${invoiceId}/items`, { method: 'POST', body });
      App.notify('Строка добавлена — выберите позицию 1С в строке', 'success');
      this.showDetail(Number(invoiceId));
    } catch (err) {
      App.notify('Не добавилось: ' + err.message, 'error');
    }
  },

  // Mobile square counters (top-right of the invoice): how many positions are
  // moderately overpriced (orange, 10–50% above usual) vs severely (red, >50%).
  _renderPriceBadges(items) {
    const el = document.getElementById('invoice-price-badges');
    if (!el) return;
    const orange = items.filter(it => it.price_deviation_pct != null && it.price_deviation_pct > 10 && it.price_deviation_pct <= 50).length;
    const red = items.filter(it => it.price_deviation_pct != null && it.price_deviation_pct > 50).length;
    const icon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>';
    let html = '';
    if (orange) html += `<span class="price-badge price-badge--orange" title="${orange}: цена выше обычной на 10–50%">${icon}<b>${orange}</b></span>`;
    if (red) html += `<span class="price-badge price-badge--red" title="${red}: цена выше обычной более чем на 50%">${icon}<b>${red}</b></span>`;
    el.innerHTML = html;
  },

  // «История» tab: processing/lifecycle timeline + live remarks. Built from the
  // already-loaded invoice `data`; the Sber payment timestamp is fetched lazily.
  // «С какого устройства» словами вместо строки браузера (полная — в подсказке).
  _deviceLabel(ua) {
    const s = String(ua || '');
    if (!s) return '';
    const device = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad'
      : /Android/.test(s) ? 'телефон Android'
      : /Windows/.test(s) ? 'компьютер Windows' : /Macintosh|Mac OS X/.test(s) ? 'компьютер Mac'
      : /Linux/.test(s) ? 'компьютер Linux' : '';
    const browser = /YaBrowser/.test(s) ? 'Яндекс Браузер' : /SamsungBrowser/.test(s) ? 'Samsung Internet'
      : /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox'
      : /Chrome\/|CriOS\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : '';
    const label = [device, browser].filter(Boolean).join(', ');
    return label ? label.replace(/^[а-яё]/, c => c.toUpperCase()) : 'Другое устройство';
  },

  async renderHistory(data) {
    const el = document.getElementById('invoice-tab-history');
    if (!el) return;

    const SOURCE_LABELS = {
      web: 'Загрузка с сайта',
      camera: 'Камера телефона',
      inbox: 'Папка-инбокс / автозагрузка',
      telegram: 'Telegram-бот',
      email: 'Входящая почта',
    };
    const sourceLabel = data.upload_source
      ? (SOURCE_LABELS[data.upload_source] || App.esc(data.upload_source))
      : '—';
    const device = this._deviceLabel(data.upload_user_agent);
    const ua = device
      ? `<div class="muted" style="font-size:12px;margin-top:2px" title="${App.esc(data.upload_user_agent)}">${App.esc(device)}</div>`
      : '';
    const duration = App.formatDuration(data.created_at, data.recognized_at);

    const field = (label, valueHtml) =>
      `<div class="invoice-field"><div class="field-label">${label}</div><div class="field-value">${valueHtml}</div></div>`;

    const procRows = [
      field('Отправлено', App.formatDateTime(data.created_at)),
      field('Источник', `${sourceLabel}${ua}`),
      field('Распознавание завершено', App.formatDateTime(data.recognized_at)),
    ];
    if (duration) procRows.push(field('Затрачено', duration));
    if (data.approved_at) procRows.push(field('Одобрено для 1С', App.formatDateTime(data.approved_at)));
    if (data.sent_at) procRows.push(field('Отправлено в 1С', App.formatDateTime(data.sent_at)));

    // --- Live remarks ---
    const items = data.items || [];
    const remarks = [];
    if (data.error_message) {
      remarks.push('Ошибка распознавания: ' + App.esc(data.error_message));
    }
    // For duplicate invoices this tab IS rendered (renderHistory runs before
    // showDetail's duplicate early-return), so this remark links to the original.
    if (data.duplicate_of) {
      remarks.push(`Дубликат накладной <a href="#/invoices/${data.duplicate_of}">№${data.duplicate_of}</a> — позиции в эту запись не сохранялись`);
    }
    const unmapped = items.filter(it => !it.onec_guid);
    if (unmapped.length) {
      const names = unmapped.slice(0, 5)
        .map(it => App.esc(it.original_name || it.mapped_name || '')).join(', ');
      const more = unmapped.length > 5 ? ` и ещё ${unmapped.length - 5}` : '';
      const noun = this._plural(unmapped.length, 'товар', 'товара', 'товаров');
      remarks.push(`Не сопоставлено с 1С: ${unmapped.length} ${noun} — ${names}${more}`);
    }
    if (data.items_total_mismatch) {
      remarks.push('Сумма позиций расходится с суммой документа более чем на 1% — проверьте глазами');
    }
    const overpriced = items.filter(it => it.price_deviation_pct != null && it.price_deviation_pct > 10);
    if (overpriced.length) {
      const top = overpriced
        .slice().sort((a, b) => b.price_deviation_pct - a.price_deviation_pct).slice(0, 3)
        .map(it => `${App.esc(it.mapped_name || it.original_name || '')} (+${Math.round(it.price_deviation_pct)}%)`)
        .join(', ');
      const more = overpriced.length > 3 ? ` и ещё ${overpriced.length - 3}` : '';
      const noun = this._plural(overpriced.length, 'позиция', 'позиции', 'позиций');
      remarks.push(`Цена выше обычной: ${overpriced.length} ${noun} — ${top}${more}`);
    }

    const remarksHtml = remarks.length
      ? '<ul style="margin:0;padding-left:18px;line-height:1.7">' +
          remarks.map(r => `<li>⚠ ${r}</li>`).join('') + '</ul>'
      : '<div class="muted">Замечаний нет ✓</div>';

    el.innerHTML = `
      <h3 style="margin-bottom:12px">Обработка</h3>
      <div class="invoice-header">${procRows.join('')}</div>
      <h3 style="margin:20px 0 12px">Замечания</h3>
      ${remarksHtml}
      <div id="invoice-history-edits"></div>
    `;
    this._renderEditsAndSnapshots(data).catch(e => console.warn('edits/snapshots render failed', e));

    // Lifecycle: Sber payment is stored in a separate table — fetch and append
    // its «создан» timestamp when present. Optional; failure degrades silently.
    try {
      const { payment } = await App.apiJson(`/invoices/${data.id}/sber-status`);
      // Bail if the user switched to another invoice while this fetch was in
      // flight — otherwise we'd patch this invoice's Sber row into a different
      // invoice's already-rendered history tab (same pattern as loadPhotos).
      if (this._currentInvoiceId !== data.id) return;
      if (payment && payment.created_at) {
        const header = el.querySelector('.invoice-header');
        if (header) {
          header.insertAdjacentHTML('beforeend',
            field('Платёж в Сбер создан', App.formatDateTime(payment.created_at)));
        }
      }
    } catch { /* sber status optional */ }
  },

  // Правки «было → стало» и снимки шапки (номер/дата/сумма/НДС) с кнопкой
  // «вернуть» — страховка пакета v2: к правильным суммам, НДС и номерам можно
  // вернуться в один клик.
  async _renderEditsAndSnapshots(data) {
    const host = document.getElementById('invoice-history-edits');
    if (!host) return;
    let payload;
    try {
      ({ data: payload } = await App.apiJson(`/invoices/${data.id}/edits`));
    } catch { return; }
    if (this._currentInvoiceId !== data.id) return;
    const LABELS = {
      invoice_number: 'Номер', invoice_date: 'Дата', total_sum: 'Сумма', vat_sum: 'НДС',
      supplier: 'Поставщик', supplier_inn: 'ИНН поставщика', supplier_kpp: 'КПП', supplier_bik: 'БИК',
      supplier_account: 'Счёт', supplier_corr_account: 'Корсчёт', supplier_address: 'Адрес',
      invoice_type: 'Тип документа', quantity: 'Количество', unit: 'Единица', price: 'Цена',
      total: 'Сумма строки', mapped_name: 'Название (1С)', onec_guid: 'Позиция 1С',
    };
    const fmt = (v) => (v == null || v === '') ? '—' : App.esc(String(v).replace(/^"|"$/g, ''));
    const MONEY_FIELDS = new Set(['total_sum', 'vat_sum', 'price', 'total']);
    const fmtVal = (field, v) => (MONEY_FIELDS.has(field) && v != null && v !== '' && isFinite(Number(v)))
      ? App.formatMoney(Number(v)) : fmt(v);
    const edits = payload.edits || [];
    const editsHtml = edits.length
      ? `<div class="table-container"><table class="data-table"><thead><tr><th>Когда</th><th>Что</th><th>Было</th><th>Стало</th></tr></thead><tbody>${
        edits.map(e => {
          let ctx = {};
          try { ctx = e.context ? JSON.parse(e.context) : {}; } catch { ctx = {}; }
          const what = (LABELS[e.field] || App.esc(e.field)) + (ctx.original_name ? `<div class="muted" style="font-size:12px">${App.esc(ctx.original_name)}</div>` : '');
          const oldV = e.field === 'onec_guid' ? fmt(ctx.old_name) : fmtVal(e.field, e.old_value);
          const newV = e.field === 'onec_guid' ? fmt(ctx.new_name) : fmtVal(e.field, e.new_value);
          const src = ctx.restored_from ? ` <span class="muted">(откат из снимка)</span>` : '';
          return `<tr><td>${App.formatDateTime(e.created_at)}</td><td>${what}${src}</td><td>${oldV}</td><td>${newV}</td></tr>`;
        }).join('')}</tbody></table></div>`
      : '<div class="muted">Правок не было</div>';

    const snaps = payload.snapshots || [];
    const latest = (kind) => snaps.find(sn => sn.kind === kind);
    const money = (v) => v == null ? '—' : App.formatMoney ? App.formatMoney(v) : String(v);
    const differs = (sn) => sn && (
      String(sn.invoice_number ?? '') !== String(data.invoice_number ?? '')
      || String(sn.invoice_date ?? '') !== String(data.invoice_date ?? '')
      || (sn.total_sum != null && Math.abs(Number(sn.total_sum) - Number(data.total_sum ?? 0)) >= 0.005)
      || (sn.vat_sum != null && Math.abs(Number(sn.vat_sum) - Number(data.vat_sum ?? 0)) >= 0.005)
    );
    const snapRow = (kind, title) => {
      const sn = latest(kind);
      if (!sn) return '';
      const btn = differs(sn)
        ? `<button class="btn btn-sm btn-outline" data-restore-kind="${kind}">Вернуть номер, дату, сумму и НДС</button>`
        : '<span class="muted">совпадает с текущими</span>';
      return `<tr><td>${title}<div class="muted" style="font-size:12px">${App.formatDateTime(sn.created_at)}</div></td>
        <td>${fmt(sn.invoice_number)}</td><td>${fmt(sn.invoice_date)}</td><td>${money(sn.total_sum)}</td><td>${money(sn.vat_sum)}</td><td>${btn}</td></tr>`;
    };
    const snapsRows = snapRow('recognized', 'Как распознано') + snapRow('baseline', 'До обновления v2 (29.09)');
    const snapsHtml = snapsRows
      ? `<div class="table-container"><table class="data-table"><thead><tr><th>Снимок</th><th>Номер</th><th>Дата</th><th>Сумма</th><th>НДС</th><th></th></tr></thead><tbody>${snapsRows}</tbody></table></div>`
      : '<div class="muted">Снимков пока нет</div>';

    host.innerHTML = `
      <h3 style="margin:20px 0 12px">Правки</h3>
      ${editsHtml}
      <h3 style="margin:20px 0 12px">Снимки шапки</h3>
      ${snapsHtml}`;
    host.querySelectorAll('button[data-restore-kind]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const kind = btn.getAttribute('data-restore-kind');
        if (!window.confirm('Вернуть номер, дату, сумму и НДС из этого снимка? Строки накладной не изменятся.')) return;
        btn.disabled = true;
        try {
          const { data: r } = await App.apiJson(`/invoices/${data.id}/restore-snapshot`, { method: 'POST', body: { kind } });
          const n = Object.keys(r.restored || {}).length;
          App.notify(n ? `Восстановлено полей: ${n}` : 'Значения уже совпадали', 'success');
          this.showDetail(data.id);
        } catch (e) {
          App.notify(e.message || 'Не удалось восстановить', 'error');
          btn.disabled = false;
        }
      });
    });
  },

  _plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  },

  // Summary banner above the items table: rows that look shifted by a skewed
  // photo, then positions priced >10% above the usual price. Empty (cleared)
  // when there are none.
  // «Накладная снята не полностью» (в сквозной нумерации строк есть разрыв) — под шапкой
  // карточки, видно с любой вкладки; без страниц шаг «Отправка в 1С» закрыт и на сервере.
  _renderCompleteness(data) {
    const el = document.getElementById('ic-completeness');
    if (!el) return;
    const c = data?.completeness;
    const message = c?.message;
    // Коротко из диапазонов («позиции 1–20, 31»), полный текст сервера — если диапазонов нет.
    const ranges = (c?.missing_ranges || []).slice(0, 6).map(r => (r.from === r.to ? `${r.from}` : `${r.from}–${r.to}`));
    const detail = ranges.length
      ? `Не найдены позиции ${ranges.join(', ')}${(c.missing_ranges.length > 6) ? ' и другие' : ''}. Добавьте фото недостающих страниц или сверьте нумерацию с бумагой.`
      : message;
    el.innerHTML = message ? `
      <div class="price-warning-banner ic-alert" role="alert">
        <span class="price-warning-banner__icon" aria-hidden="true">⚠</span>
        <div class="ic-alert-text">
          <strong>Накладная снята не полностью</strong>
          <div>${App.esc(detail)}</div>
        </div>
        <div class="ic-alert-actions">
          <button type="button" class="btn btn-outline btn-sm" onclick="Invoices.addPages(${Number(data.id)}, event)">Добавить страницы</button>
          <button type="button" class="ic-link" onclick="Invoices.setPagesConfirmed(${Number(data.id)}, true)">Все страницы на месте</button>
        </div>
      </div>` : '';
  },

  // «Все страницы на месте»: разрыв в номерах строк — опечатка или ошибка чтения, а не
  // пропущенный лист. Снимает проверку полноты; вернуть — в меню «⋯» карточки.
  setPagesConfirmed(id, value) {
    const save = async () => {
      try {
        await App.apiJson(`/invoices/${id}/pages-confirmed`, { method: 'POST', body: { value } });
        App.notify(value ? 'Отмечено: все страницы на месте' : 'Проверка страниц снова включена', 'success');
        this.showDetail(id);
      } catch (e) {
        App.notify(e.message || 'Не удалось сохранить отметку', 'error');
      }
    };
    if (!value) return save();
    this.showConfirm('Все страницы на месте?',
      'Сверьте накладную с бумагой. Если страниц больше нет, а в номерах строк пропуск — опечатка или ошибка чтения, отметьте накладную: отправка в 1С станет доступна.\nОтметку можно снять в меню «⋯».',
      save, { okLabel: 'Все страницы на месте', okClass: 'btn-primary' });
    return undefined;
  },

  _renderPriceWarning(items, alignment = []) {
    const el = document.getElementById('invoice-price-warning');
    if (!el) return;
    const shifted = alignment.length ? `
      <div class="price-warning-banner">
        <span class="price-warning-banner__icon">⚠</span>
        <div>
          <strong>Строки могли распознаться со сдвигом</strong> — названия и числа не совпадают по строкам (так бывает, когда фото снято под углом). Сверьте таблицу со сканом или пересканируйте фото (меню «⋯»).
          <div class="muted" style="margin-top:2px">${alignment.map(p => App.esc(p)).join('; ')}</div>
        </div>
      </div>` : '';
    const flagged = items.filter(it => it.price_deviation_pct != null && it.price_deviation_pct > 10);
    if (!flagged.length) { el.innerHTML = shifted; return; }
    const worst = Math.round(Math.max(...flagged.map(f => f.price_deviation_pct)));
    const names = flagged
      .sort((a, b) => b.price_deviation_pct - a.price_deviation_pct)
      .slice(0, 3)
      .map(f => App.esc(f.mapped_name || f.original_name || ''))
      .join(', ');
    const more = flagged.length > 3 ? ` и ещё ${flagged.length - 3}` : '';
    const noun = this._plural(flagged.length, 'позиция', 'позиции', 'позиций');
    el.innerHTML = shifted + `
      <div class="price-warning-banner">
        <span class="price-warning-banner__icon">⚠</span>
        <div>
          <strong>Повышенная цена: ${flagged.length} ${noun}</strong> дороже обычной более чем на 10% (до +${worst}%).
          <div class="muted" style="margin-top:2px">${names}${more}</div>
        </div>
      </div>`;
  },

  // Map a price-deviation percentage to a row class.
  // Нормализованная единица для сравнения «в накладной» vs «в 1С».
  _normUnit(u) {
    const s = String(u || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[.\s]+/g, '').trim();
    const alias = { 'штук': 'шт', 'штука': 'шт', 'гр': 'г', 'килограмм': 'кг', 'литр': 'л', 'дм3': 'л', 'уп': 'упак', 'упаковка': 'упак' };
    return alias[s] || s;
  },

  // Единица строки не та, в которую её надо считать: «Всё в кг» — кг, иначе —
  // единица позиции 1С (target_unit приходит с сервера).
  _unitMismatch(item) {
    const target = item.target_unit || item.onec_unit;
    return !!(item.onec_guid && target && item.unit && this._normUnit(item.unit) !== this._normUnit(target));
  },

  // Строка в кг, а позиция 1С — в штуках/литрах: при загрузке обработка 1С
  // переведёт позицию на кг. Не ошибка, но остаток в прежней единице надо проверить.
  _onecSwitchesToKg(item) {
    return !!(item.onec_unit && item.unit && this._normUnit(item.unit) === 'кг' && this._normUnit(item.onec_unit) !== 'кг'
      && this._normUnit(item.target_unit) === 'кг');
  },

  // Топ-3 позиции 1С «в один клик» для строк без сопоставления или с низкой
  // уверенностью (пакет v2, п.13). Клик = подтверждённое правило.
  async _loadCandidates(invoiceId) {
    const slots = Array.from(document.querySelectorAll('.nom-cands')).slice(0, 25);
    for (const slot of slots) {
      if (this._currentInvoiceId !== invoiceId) return;
      const itemId = slot.getAttribute('data-item-id');
      let list = [];
      try {
        ({ data: list } = await App.apiJson(`/invoices/${invoiceId}/items/${itemId}/candidates`));
      } catch { continue; }
      if (!list || !list.length) continue;
      slot.innerHTML = `<span class="muted">Похоже на:</span> ` + list.map(c => `
        <button type="button" class="nom-cand${c.conflict ? ' nom-cand-conflict' : ''}"
          title="${App.esc(c.conflict ? 'Не совпадает: ' + c.conflict : 'Сходство ' + Math.round(c.confidence * 100) + '%')}"
          onclick="Invoices.pickCandidate(${invoiceId}, ${itemId}, '${App.esc(c.guid)}')">${App.esc(c.name)}${c.unit ? ` <span class="muted">(${App.esc(c.unit)})</span>` : ''}</button>`).join(' ');
    }
  },

  async pickCandidate(invoiceId, itemId, guid) {
    try {
      await App.apiJson(`/invoices/${invoiceId}/items/${itemId}/map`, { method: 'PUT', body: { onec_guid: guid } });
      App.notify('Сопоставлено и запомнено', 'success');
      this.showDetail(invoiceId);
    } catch (e) { App.notify(e.message || 'Не удалось сопоставить', 'error'); }
  },

  async confirmMappings(invoiceId, event) {
    if (event) { event.stopPropagation(); event.preventDefault(); }
    if (!window.confirm('Подтвердить текущие позиции 1С всех строк? Они станут правилами, которые важнее выбора ИИ, для следующих накладных.')) return;
    try {
      const { data } = await App.apiJson(`/invoices/${invoiceId}/confirm-mappings`, { method: 'POST' });
      App.notify(`Подтверждено правил: ${data.confirmed}`, 'success');
      this.showDetail(invoiceId);
    } catch (e) { App.notify(e.message || 'Не удалось подтвердить', 'error'); }
  },

  async itemReconvert(invoiceId, itemId) {
    try {
      const { data } = await App.apiJson(`/invoices/${invoiceId}/items/${itemId}/reconvert`, { method: 'POST' });
      App.notify(data && data.conv_note ? `Пересчитано: ${data.conv_note}` : 'Пересчитано', data && data.qty_flag ? 'warn' : 'success');
      this.showDetail(invoiceId);
    } catch (e) { App.notify(e.message || 'Не удалось пересчитать', 'error'); }
  },

  async itemRevertRaw(invoiceId, itemId) {
    if (!window.confirm('Вернуть количество, единицу, цену и сумму строки как в накладной?')) return;
    try {
      await App.apiJson(`/invoices/${invoiceId}/items/${itemId}/revert-raw`, { method: 'POST' });
      App.notify('Строка возвращена как в накладной', 'success');
      this.showDetail(invoiceId);
    } catch (e) { App.notify(e.message || 'Не удалось вернуть', 'error'); }
  },

  async itemRememberRule(invoiceId, itemId) {
    let item;
    try {
      const { data } = await App.apiJson(`/invoices/${invoiceId}`);
      item = (data.items || []).find(it => it.id === itemId);
    } catch { /* ниже сообщим */ }
    if (!item) { App.notify('Строка не найдена', 'error'); return; }
    const rawUnit = item.raw_unit || item.unit || 'ед.';
    const target = item.target_unit || item.onec_unit || item.unit || '';
    const guess = item.conv_factor && item.conv_factor > 0 ? String(Math.round(item.conv_factor * 1000) / 1000).replace('.', ',') : '';
    const answer = window.prompt(`Сколько «${target}» в одной «${rawUnit}» для «${item.original_name}»?
Например, батон 0,4 кг → 0,4; упаковка по 100 шт → 100.
Правило запомнится для этого товара у этого поставщика.`, guess);
    if (answer == null) return;
    const factor = Number(String(answer).replace(',', '.').trim());
    if (!Number.isFinite(factor) || factor <= 0) { App.notify('Нужно положительное число', 'error'); return; }
    try {
      await App.apiJson(`/invoices/${invoiceId}/items/${itemId}/unit-rule`, { method: 'POST', body: { factor, target_unit: target } });
      App.notify(`Запомнено: 1 ${rawUnit} = ${String(factor).replace('.', ',')} ${target}`, 'success');
      this.showDetail(invoiceId);
    } catch (e) { App.notify(e.message || 'Не удалось запомнить', 'error'); }
  },

  // Each action claims a unique token; subsequent clicks while it's active
  // are dropped. Public so other modules (mappings.js, etc.) can reuse.
  _busy: new Set(),
  _withGuard(token, fn) {
    if (this._busy.has(token)) return Promise.resolve(undefined);
    this._busy.add(token);
    return Promise.resolve().then(fn).finally(() => this._busy.delete(token));
  },

  // Откуда взяты реквизиты поставщика (invoices.supplier_match). 'name' —
  // ИНН с фото в справочнике не нашёлся, карточка подобрана по названию:
  // предупреждаем, чтобы не заплатить не тому. 'manual' — выбран вручную.
  _supplierMatchBanner(data) {
    const ocrInn = data.supplier_inn_ocr ? `ИНН ${App.esc(data.supplier_inn_ocr)}` : 'ИНН не распознан';
    const ocrName = data.supplier_name_ocr ? `«${App.esc(data.supplier_name_ocr)}»` : '';
    const card = `<strong>${App.esc(data.supplier || '')}</strong>, ИНН ${App.esc(data.supplier_inn || '')}`;
    if (data.supplier_match === 'name') {
      return `<div class="price-warning-banner"><span class="price-warning-banner__icon">⚠️</span><div>
        <strong>Реквизиты подобраны по названию поставщика, а не по ИНН.</strong><br>
        На фото: ${ocrName ? ocrName + ', ' : ''}${ocrInn} — подтверждённой карточки с верным ИНН по нему не нашлось.
        Использована карточка справочника ${card}. Проверьте перед оплатой — при отправке в Сбербанк поставщика нужно будет подтвердить.
      </div></div>`;
    }
    if (data.supplier_match === 'manual' && (data.supplier_inn_ocr || data.supplier_name_ocr)) {
      return `<div style="margin-bottom:14px;font-size:13px;color:var(--text-secondary)">
        Поставщик выбран вручную из справочника: ${card}. На фото было: ${ocrName ? ocrName + ', ' : ''}${ocrInn}.
      </div>`;
    }
    return '';
  },

  // === Editable header fields & validation ===

  _REQUIRED_FOR_1C: ['invoice_number', 'invoice_date', 'supplier', 'supplier_inn', 'total_sum'],
  // Поставщика (ИНН/БИК) для Сбера не требуем здесь: если его нет в
  // справочнике, окно отправки предложит выбрать карточку из списка.
  _REQUIRED_FOR_SBER: ['total_sum'],

  _FIELD_LABELS: {
    invoice_type: 'Тип документа',
    invoice_number: 'Номер накладной',
    invoice_date: 'Дата (YYYY-MM-DD)',
    supplier: 'Поставщик (название)',
    supplier_inn: 'ИНН поставщика',
    supplier_kpp: 'КПП поставщика',
    supplier_bik: 'БИК банка',
    supplier_account: 'Р/с поставщика',
    supplier_corr_account: 'К/с банка',
    supplier_address: 'Адрес поставщика',
    total_sum: 'Сумма',
    vat_sum: 'В т.ч. НДС',
  },

  _missingFields(invoice, fields) {
    return fields.filter(f => {
      const v = invoice[f];
      if (v == null || v === '') return true;
      if (typeof v === 'number' && (!isFinite(v) || v <= 0)) return true;
      return false;
    });
  },

  async editHeader(id) {
    try {
      const j = await App.apiJson(`/invoices/${id}`);
      this._openEditModal({
        invoice: j.data,
        title: 'Редактирование реквизитов',
        onSaved: () => this.showDetail(id),
      });
    } catch (e) {
      App.notify('Не удалось загрузить накладную: ' + e.message, 'error');
    }
  },

  /**
   * Открывает модалку редактирования header'а накладной.
   *
   * options:
   *   - invoice: current invoice data
   *   - title: заголовок модалки
   *   - requiredFields: какие поля показать как «обязательные» (asterisk + красный)
   *   - reasonText: подзаголовок «Не хватает: …» при pre-flight failure
   *   - onSaved: () => void — callback после успешного PATCH (retry send 1C / Sber)
   */
  _openEditModal({ invoice, title = 'Реквизиты накладной', requiredFields = [], reasonText = '', onSaved = () => {} }) {
    let modal = document.getElementById('invoice-edit-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'invoice-edit-modal';
      modal.className = 'modal-backdrop';
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:none;align-items:center;justify-content:center;z-index:9999;padding:20px';
      document.body.appendChild(modal);
    }

    const requiredSet = new Set(requiredFields);
    const missing = new Set(this._missingFields(invoice, requiredFields));

    const fieldOrder = [
      'invoice_type', 'invoice_number', 'invoice_date', 'total_sum', 'vat_sum',
      'supplier', 'supplier_inn', 'supplier_kpp',
      'supplier_bik', 'supplier_account', 'supplier_corr_account',
      'supplier_address',
    ];
    const fieldsHtml = fieldOrder.map(name => {
      const label = this._FIELD_LABELS[name];
      const isRequired = requiredSet.has(name);
      const isMissing = missing.has(name);
      const value = invoice[name] == null ? '' : String(invoice[name]);
      const star = isRequired ? '<span style="color:#dc2626"> *</span>' : '';
      const inputBg = isMissing ? 'background:#fef2f2;border-color:#dc2626' : '';
      const wide = name === 'supplier' || name === 'supplier_address';
      const inputType = name === 'invoice_date' ? 'date' :
                        (name === 'total_sum' || name === 'vat_sum') ? 'number' : 'text';
      const step = inputType === 'number' ? 'step="0.01"' : '';
      if (name === 'invoice_type') {
        const types = [['счет_на_оплату','Счёт на оплату'],['торг_12','ТОРГ-12'],['упд','УПД'],['счет_фактура','Счёт-фактура'],['акт','Акт'],['кассовый_чек','Кассовый чек'],['авансовый_отчет','Авансовый отчёт'],['прочее','Прочее']];
        return `<label style="display:flex;flex-direction:column;gap:4px"><span style="font-size:12px;color:var(--muted,#64748b)">${label}</span><select name="invoice_type">${types.map(([type, title]) => `<option value="${type}"${value === type ? ' selected' : ''}>${title}</option>`).join('')}</select></label>`;
      }
      return `
        <label style="display:flex;flex-direction:column;gap:4px;${wide ? 'grid-column:1/-1' : ''}">
          <span style="font-size:12px;color:var(--muted,#64748b)">${label}${star}</span>
          <input type="${inputType}" name="${name}" value="${App.esc(value)}" ${step} style="${inputBg}">
        </label>
      `;
    }).join('');

    const reasonBlock = reasonText ? `
      <div style="background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.4);padding:10px 14px;border-radius:8px;margin-bottom:14px;color:rgb(120,53,15)">
        <strong>${App.esc(reasonText)}</strong>
        ${missing.size > 0 ? `<div style="margin-top:6px;font-size:13px">Не хватает: ${Array.from(missing).map(f => `«${App.esc(this._FIELD_LABELS[f] || f)}»`).join(', ')}</div>` : ''}
      </div>` : '';

    modal.innerHTML = `
      <div class="card" style="max-width:700px;width:100%;max-height:90vh;overflow:auto">
        <h3 style="margin-bottom:16px">${App.esc(title)}</h3>
        ${reasonBlock}
        <form id="invoice-edit-form" style="display:grid;grid-template-columns:repeat(2,1fr);gap:14px">
          ${fieldsHtml}
          <div style="grid-column:1/-1;display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
            <button type="button" class="btn btn-ghost" id="invoice-edit-cancel">Отмена</button>
            <button type="submit" class="btn btn-primary">Сохранить</button>
          </div>
        </form>
      </div>
    `;
    modal.style.display = 'flex';

    modal.querySelector('#invoice-edit-cancel').onclick = () => { modal.style.display = 'none'; };
    modal.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };

    const form = modal.querySelector('#invoice-edit-form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const update = {};
      for (const [k, v] of fd.entries()) {
        update[k] = v;  // backend сам trim'ит и преобразует
      }
      try {
        const res = await App.api(`/invoices/${invoice.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(update),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          App.notify(err.error || 'Ошибка сохранения', 'error');
          return;
        }
        App.notify('Реквизиты обновлены', 'success');
        modal.style.display = 'none';
        await onSaved();
      } catch (err) {
        App.notify('Ошибка: ' + err.message, 'error');
      }
    };

    // Auto-focus на первое missing-поле для pre-flight кейса
    if (missing.size > 0) {
      const firstMissing = Array.from(missing)[0];
      const inp = form.querySelector(`[name="${firstMissing}"]`);
      if (inp) inp.focus();
    }
  },

  // fromList=true → invoked from a row's «→ 1С» button: swallow the row click
  // (so we don't also navigate to the detail page) and, on success, refresh the
  // list in place instead of opening the invoice.
  async sendTo1C(id, event, fromList) {
    if (event) { event.stopPropagation(); event.preventDefault(); }
    return this._withGuard(`send:${id}`, async () => {
      let invoice;
      try {
        const j = await App.apiJson(`/invoices/${id}`);
        invoice = j.data;
      } catch (e) {
        App.notify('Не удалось загрузить накладную', 'error');
        return;
      }

      // Pre-flight: required fields для 1С.
      const missing = this._missingFields(invoice, this._REQUIRED_FOR_1C);
      if (missing.length > 0) {
        this._openEditModal({
          invoice,
          title: 'Дозаполните реквизиты для отправки в 1С',
          requiredFields: this._REQUIRED_FOR_1C,
          reasonText: '1С не примет накладную без этих полей',
          onSaved: () => this.sendTo1C(id, null, fromList),  // retry после сохранения
        });
        return;
      }

      // Если есть несопоставленные товары — обычное подтверждение.
      const unmappedCount = (invoice.items || []).filter(it => !it.onec_guid).length;
      if (unmappedCount > 0) {
        const ok = confirm(
          `В накладной ${unmappedCount} несопоставленных товар(ов).\n\n` +
          `При загрузке в 1С они будут созданы как НОВЫЕ позиции в справочнике Номенклатура по их названию из скана.\n\n` +
          `Продолжить?`
        );
        if (!ok) return;
      }
      // Пакет v2: строки, где количество под вопросом (флаг пересчёта или
      // единица не совпадает с 1С), — главная причина неверных остатков в 1С.
      const suspect = (invoice.items || []).filter(it => it.qty_flag || this._unitMismatch(it));
      if (suspect.length > 0) {
        const names = suspect.slice(0, 5).map(it => '• ' + (it.original_name || it.mapped_name || '')).join('\n');
        const ok = confirm(
          `Количество под вопросом в ${suspect.length} строк(ах):\n${names}${suspect.length > 5 ? '\n…' : ''}\n\n` +
          `Проверьте пересчёт единиц (кнопки под количеством). Всё равно отправить в 1С?`
        );
        if (!ok) return;
      }
      try {
        await App.apiJson(`/invoices/${id}/send`, { method: 'POST' });
        App.notify('Накладная помечена для отправки. Загрузите через обработку в 1С.', 'success');
        if (fromList) this.loadTable(); else this.showDetail(id);
      } catch (e) {
        App.notify('Ошибка: ' + e.message, 'error');
      }
    });
  },

  async unapproveForOneC(id) {
    return this._withGuard(`unapprove:${id}`, async () => {
      try {
        await App.apiJson(`/invoices/${id}/unapprove`, { method: 'POST' });
        App.notify('Отправка отозвана', 'success');
        this.showDetail(id);
      } catch (e) {
        App.notify('Ошибка: ' + e.message, 'error');
      }
    });
  },

  rescan(id, ev, isXml = false) {
    // Кнопку запоминаем ДО показа модалки: к моменту подтверждения событие уже
    // отработало и currentTarget будет null, а сам узел кнопки останется живым.
    const btn = ev?.currentTarget || ev?.target || null;
    this.showConfirm(
      'Вы уверены?',
      isXml
        ? 'Исходный XML будет разобран заново, товары — пересопоставлены с 1С; текущие позиции заменятся новыми.'
        : 'Фото будет заново распознано через Claude API, текущие позиции заменятся новыми.',
      () => this._withGuard(`rescan:${id}`, () => App.withBusyButton(btn, async () => {
        try {
          App.notify(isXml ? 'Перечитываем XML…' : 'Пересканирование запущено, ожидайте 10–30 сек…', 'info');
          const res = await App.api(`/invoices/${id}/rescan`, { method: 'POST' });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            App.notify(err.error || `Ошибка ${res.status}`, 'error');
            return;
          }
          App.notify(isXml ? 'Документ перечитан' : 'Накладная пересканирована', 'success');
          this.showDetail(id);
        } catch (e) {
          App.notify('Ошибка: ' + e.message, 'error');
        }
      })),
      { okLabel: 'Да', cancelLabel: 'Нет', okClass: 'btn-primary' }
    );
  },

  // "Дофоткать страницы" — pick/take photo(s), upload to the invoice; their
  // recognized items append to it. OCR is async on the server, so we poll the
  // invoice until its item count grows, then reload the detail.
  addPages(id, ev) {
    // Как и в rescan: между кликом и реальной работой стоит выбор файлов,
    // поэтому узел кнопки берём синхронно, пока событие ещё диспатчится.
    const btn = ev?.currentTarget || ev?.target || null;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', async () => {
      const files = Array.from(input.files || []);
      input.remove();
      if (files.length === 0) return;
      await this._withGuard(`addPages:${id}`, () => App.withBusyButton(btn, async () => {
        let before = 0;
        try { before = (await App.apiJson(`/invoices/${id}`)).data?.items?.length ?? 0; } catch { /* ignore */ }
        const fd = new FormData();
        let resp;
        try {
          for (const f of files) fd.append('files', await Upload.memoryBlob(f), f.name);
          resp = await App.api(`/invoices/${id}/add-pages`, { method: 'POST', body: fd });
        } catch (e) { App.notify('Ошибка загрузки: ' + e.message, 'error'); return; }
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          App.notify(err.error || `Ошибка ${resp.status}`, 'error');
          return;
        }
        App.notify(`Загружено страниц: ${files.length}. Распознавание идёт (~${Math.max(1, files.length)} мин)…`, 'info');
        const deadline = Date.now() + 60000 * Math.max(2, files.length * 2);
        // Опрос завёрнут в Promise, чтобы спиннер крутился до РЕАЛЬНОГО
        // результата (позиции появились или вышло время), а не до конца
        // загрузки файлов: распознавание на сервере идёт асинхронно и занимает
        // основную часть ожидания.
        await new Promise((resolve) => {
          const poll = async () => {
            try {
              const now = (await App.apiJson(`/invoices/${id}`)).data?.items?.length ?? 0;
              if (now > before) {
                App.notify(`Страницы добавлены (+${now - before} позиц.)`, 'success');
                this.showDetail(id);
                resolve();
                return;
              }
            } catch { /* ignore, keep polling */ }
            if (Date.now() < deadline) setTimeout(poll, 5000);
            else {
              App.notify('Обработка затянулась — обновите страницу позже', 'info');
              this.showDetail(id);
              resolve();
            }
          };
          setTimeout(poll, 5000);
        });
      }));
    }, { once: true });
    input.click();
  },

  async mergePagesFromList(id) {
    return this._withGuard(`merge-candidates:${id}`, async () => {
      try {
        const { data } = await App.apiJson(`/invoices/${id}`);
        if (String(data.ocr_engine || '').startsWith('xml') || /\.xml$/i.test(data.file_name || '')) {
          App.notify('XML уже содержит накладную целиком — страницы объединять не нужно.', 'info');
          return;
        }
        const siblings = data.possible_siblings || [];
        if (!siblings.length) {
          App.notify('Других страниц с тем же номером, датой и поставщиком не найдено.', 'info');
          return;
        }
        if (siblings.length > 1) {
          this.openInvoice(id);
          App.notify('Выберите страницу для объединения в карточке накладной.', 'info');
          return;
        }
        const sibling = siblings[0];
        await this.mergeSibling(id, sibling.id, data.status === 'sent_to_1c' || data.approved_for_1c
          || sibling.status === 'sent_to_1c' || sibling.approved_for_1c);
      } catch (e) {
        App.notify('Ошибка поиска страниц: ' + e.message, 'error');
      }
    });
  },

  // Fold two split-page invoices into one via the existing merge-into endpoint.
  // Canonical target = the lower id (page 1, owns the header); the higher id is
  // the source that gets deleted. When either side is already in/awaiting 1C we
  // confirm first — the merge fixes ScanFlow but 1C already has the stray doc.
  async mergeSibling(currentId, siblingId, sentWarning) {
    const target = Math.min(currentId, siblingId);
    const source = Math.max(currentId, siblingId);
    const base = 'Объединить эти две накладные в одну (#' + target + ')?';
    const msg = sentWarning
      ? base + '\n\nОдна из накладных уже отправлена в 1С. Объединение исправит дубль в ScanFlow, но в 1С документ уже создан — лишний нужно удалить вручную.'
      : base;
    if (!confirm(msg)) return;

    await this._withGuard(`merge:${source}->${target}`, async () => {
      let resp;
      try {
        resp = await App.api(`/invoices/${source}/merge-into/${target}`, { method: 'POST' });
      } catch (e) { App.notify('Ошибка объединения: ' + e.message, 'error'); return; }
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        App.notify(err.error || `Ошибка ${resp.status}`, 'error');
        return;
      }
      App.notify('Накладные объединены', 'success');
      App.navigate(`#/invoices/${target}`);
      this.showDetail(target);
    });
  },

  async remap(id, forceAll, ev) {
    // currentTarget живёт только на время диспатча события — запоминаем СРАЗУ,
    // до первого await, иначе получим null.
    const btn = ev?.currentTarget || ev?.target || null;
    return this._withGuard(`remap:${id}`, () => App.withBusyButton(btn, async () => {
      const url = forceAll ? `/invoices/${id}/remap?all=true` : `/invoices/${id}/remap`;
      try {
        const data = await App.apiJson(url, { method: 'POST' });
        const remapped = data.data?.remapped ?? 0;
        const changed = data.data?.changed ?? 0;
        if (forceAll) {
          App.notify(`Пересопоставлено: ${remapped}, изменений: ${changed}`, 'success');
        } else if (remapped > 0) {
          App.notify(`Сопоставлено дополнительно: ${remapped}`, 'success');
        } else {
          App.notify('Новых сопоставлений не найдено', 'success');
        }
        this.showDetail(id);
      } catch (e) {
        App.notify('Ошибка: ' + e.message, 'error');
      }
    }));
  },

  async llmRemap(id, all = false, ev) {
    const btn = ev?.currentTarget || ev?.target || null;
    return this._withGuard(`llmRemap:${id}`, () => App.withBusyButton(btn, async () => {
      App.notify(all ? 'Пересобираем все маппинги через Claude…' : 'Отправляем несопоставленные товары в Claude…', 'info');
      try {
        const url = all ? `/invoices/${id}/llm-remap?all=true` : `/invoices/${id}/llm-remap`;
        const data = await App.apiJson(url, { method: 'POST' });
        const requested = data.data?.requested ?? 0;
        const matched = data.data?.matched ?? 0;
        const changed = data.data?.changed ?? 0;
        if (requested === 0) {
          App.notify(all ? 'В накладной нет товаров' : 'Нет несопоставленных товаров', 'success');
        } else if (all) {
          if (changed === 0) App.notify(`LLM подтвердил текущие сопоставления (${matched} из ${requested})`, 'success');
          else App.notify(`LLM обновил ${changed} из ${requested} (подтверждено ${matched})`, 'success');
        } else if (matched === 0) {
          App.notify(`LLM не нашёл совпадений (${requested} товаров)`, 'error');
        } else {
          App.notify(`LLM сопоставил ${matched} из ${requested} товаров`, 'success');
        }
        this.showDetail(id);
      } catch (e) {
        App.notify('Ошибка LLM-маппинга: ' + e.message, 'error');
      }
    }));
  },

  async resetStatus(id) {
    if (!confirm('Сбросить статус накладной? Она станет "Обработан" и исчезнет из списка готовых к 1С. Для повторной отправки нужно будет снова нажать "Отправить в 1С".')) {
      return;
    }
    return this._withGuard(`reset:${id}`, async () => {
      try {
        await App.apiJson(`/invoices/${id}/reset`, { method: 'POST' });
        App.notify('Статус сброшен', 'success');
        this.showDetail(id);
      } catch (e) {
        App.notify('Ошибка: ' + e.message, 'error');
      }
    });
  },

  async unlinkDuplicate(id) {
    if (!confirm('Снять отметку «дубликат»? Накладная превратится в обычную (status=processed), но items в неё не вернутся — для полноценной обработки нужно её удалить и переотсканировать.')) return;
    try {
      const res = await App.api(`/invoices/${id}/unlink-duplicate`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        App.notify(err.error || 'Ошибка', 'error');
        return;
      }
      App.notify('Отметка снята', 'success');
      this.showDetail(id);
    } catch (e) {
      App.notify('Ошибка: ' + e.message, 'error');
    }
  },

  deleteInvoice(id, event) {
    if (event) {
      event.stopPropagation();
      event.preventDefault();
    }
    this.showConfirm(
      'Удалить накладную?',
      `Накладная #${id} будет удалена вместе с фото. Это действие нельзя отменить.`,
      async () => {
        return this._withGuard(`delete:${id}`, async () => {
          try {
            await App.apiJson(`/invoices/${id}`, { method: 'DELETE' });
            App.notify('Накладная удалена', 'success');
            App.navigate('#/invoices');
            this.showList();
          } catch (e) {
            App.notify('Ошибка удаления: ' + e.message, 'error');
          }
        });
      }
    );
  },

  // opts (all optional):
  //   okLabel / cancelLabel — button captions (default 'Удалить' / 'Отмена')
  //   okClass — CSS class for the confirm button (default 'btn-danger')
  // Defaults preserve the original delete-confirm look for existing callers.
  showConfirm(title, text, onOk, opts = {}) {
    const modal = document.getElementById('confirm-modal');
    document.getElementById('confirm-modal-title').textContent = title;
    const textEl = document.getElementById('confirm-modal-text');
    textEl.textContent = text;
    // Render \n in the body as line breaks (bullet lists) without innerHTML/XSS.
    textEl.style.whiteSpace = 'pre-line';
    modal.style.display = 'flex';

    const okBtn = document.getElementById('confirm-modal-ok');
    const cancelBtn = document.getElementById('confirm-modal-cancel');
    okBtn.textContent = opts.okLabel || 'Удалить';
    cancelBtn.textContent = opts.cancelLabel || 'Отмена';
    okBtn.className = 'btn ' + (opts.okClass || 'btn-danger');

    const close = () => {
      modal.style.display = 'none';
      okBtn.replaceWith(okBtn.cloneNode(true));
      cancelBtn.replaceWith(cancelBtn.cloneNode(true));
    };

    document.getElementById('confirm-modal-cancel').addEventListener('click', close);
    document.getElementById('confirm-modal-ok').addEventListener('click', () => {
      close();
      onOk();
    });
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); }, { once: true });
  },

  // Меню «•••» строки списка — то же меню, что «⋯» в карточке (InvoiceCard.openMenu):
  // текст без значков, удаление — красным и последним. XML не объединяют.
  openRowMenu(id, read, paid, event) {
    if (event) { event.stopPropagation(); event.preventDefault(); }
    const anchor = event && event.currentTarget;
    if (!anchor || typeof InvoiceCard === 'undefined') return;
    const row = this._rowsById?.get(id);
    const xml = row ? App.isXmlInvoice(row) : false;
    InvoiceCard.openMenu(anchor, [
      { label: read ? 'Пометить непрочитанной' : 'Пометить прочитанной', onClick: () => this._markRead(id, !read) },
      { label: paid ? 'Снять отметку «оплачено»' : 'Оплачено без Сбера', onClick: () => this._markPaidExternally(id, !paid) },
      xml ? null : { label: 'Объединить страницы', onClick: () => this.mergePagesFromList(id) },
      null,
      { label: 'Удалить накладную', danger: true, onClick: () => this.deleteInvoice(id) },
    ].filter((it, i, all) => it !== null || all[i - 1] !== null), 'Действия с накладной');
  },

  async _markRead(id, read) {
    return this._withGuard(`read:${id}`, async () => {
      try {
        await App.apiJson(`/invoices/${id}/read`, { method: 'POST', body: { read } });
        this.showList();
      } catch (e) {
        App.notify('Ошибка: ' + e.message, 'error');
      }
    });
  },

  async _markPaidExternally(id, value) {
    return this._withGuard(`paid:${id}`, async () => {
      try {
        await App.apiJson(`/invoices/${id}/paid-externally`, { method: 'POST', body: { value } });
        App.notify(value ? 'Отмечено «оплачено вне сервиса»' : 'Отметка «оплачено сами» снята', 'success');
        // Из карточки (шаг «Оплата») — остаёмся в ней, из списка — обновляем список.
        if (this._currentInvoiceId === id) this.showDetail(id); else this.showList();
      } catch (e) {
        App.notify('Ошибка: ' + e.message, 'error');
      }
    });
  },

  onNomInput(event) {
    const input = event.target;
    const dd = document.getElementById('nom-dd-' + input.dataset.itemId);
    if (!dd) return;
    const q = input.value.trim();
    if (!q) { dd.style.display = 'none'; return; }
    const results = OnecCatalog.search(q, 10);
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    // Inline onclick with stringified data was unusable: JSON.stringify wraps
    // names in double quotes, which close the onclick="..." attribute early
    // and the handler silently breaks. Switched to data-* attributes + a
    // single delegated click listener attached once per dropdown.
    const matchesHtml = results.map(r => `
      <div class="nom-picker-option"
           data-guid="${esc(r.guid)}"
           data-name="${esc(r.name)}"
           onmousedown="event.preventDefault()">
        <strong>${esc(r.name)}</strong>
        ${r.unit ? '<span class="nom-unit">' + esc(r.unit) + '</span>' : ''}
      </div>
    `).join('');
    // Always offer "create in 1C as new" with the EXACT typed text — this is the
    // name that will be sent for НайтиИлиСоздатьНоменклатуру. Explicit click =
    // the user confirms what 1C will receive (no silent guessing).
    const createHtml = `
      <div class="nom-picker-option nom-picker-create"
           data-create="1" data-name="${esc(q)}"
           onmousedown="event.preventDefault()">
        ➕ Отправить в 1С как новое: <strong>${esc(q)}</strong>
      </div>`;
    dd.innerHTML = matchesHtml + createHtml;
    dd.style.display = 'block';
    // Attach delegated click handler once. _clickBound flag prevents duplicate
    // listeners when the dropdown re-renders on each keystroke.
    if (!dd._clickBound) {
      dd.addEventListener('click', (e) => {
        const opt = e.target.closest('.nom-picker-option');
        if (!opt) return;
        if (opt.dataset.create) {
          this.saveCustomName(input.dataset.invoiceId, input.dataset.itemId, opt.dataset.name);
        } else {
          this.selectNomItem(input.dataset.invoiceId, input.dataset.itemId, opt.dataset.guid, opt.dataset.name);
        }
      });
      dd._clickBound = true;
    }
  },

  // Persist a user-typed name for an unmatched item — exactly what 1C will create
  // Номенклатура from. Clears any catalog match + flags the override (✎ mark).
  async saveCustomName(invoiceId, itemId, name) {
    const clean = String(name || '').trim();
    if (!clean) return;
    try {
      const res = await App.api(`/invoices/${invoiceId}/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mapped_name: clean }),
      });
      if (res.ok) {
        App.notify(`В 1С уйдёт название: «${clean}»`, 'success');
        this.showDetail(parseInt(invoiceId, 10));
      } else {
        const err = await res.json().catch(() => ({}));
        App.notify(err.error || 'Не удалось сохранить название', 'error');
      }
    } catch (e) {
      App.notify('Ошибка: ' + e.message, 'error');
    }
  },

  // For each unmapped item, find the best client-catalog match and, when it's
  // confident, pre-select it in the picker input + offer one-click apply. Best
  // effort: silent on any error, never blocks the detail view.
  _suggestUnmapped(invoiceId, items) {
    if (typeof OnecCatalog === 'undefined' || !OnecCatalog.loaded) return;
    const CONFIDENT = 0.8;
    for (const item of items) {
      if (item.onec_guid) continue;
      const scan = item.original_name || '';
      if (!scan) continue;
      let hits = [];
      try { hits = OnecCatalog.search(scan, 1); } catch { continue; }
      const top = hits[0];
      if (!top || top.confidence < CONFIDENT) continue;

      const row = document.querySelector(`#invoice-items-tbody tr[data-item-id="${item.id}"]`);
      const picker = row && row.querySelector('.nom-picker');
      const input = picker && picker.querySelector('.nom-picker-input');
      if (!picker || !input || picker.querySelector('.nom-suggest')) continue;

      // Auto-select: show the confident match in the field; keep the ● badge so
      // it's clearly still pending until the user confirms.
      input.value = top.name;
      input.dataset.suggestedGuid = top.guid;

      const chip = document.createElement('div');
      chip.className = 'nom-suggest';
      chip.style.cssText = 'margin-top:4px;font-size:12px;color:var(--text-muted,#888);display:flex;gap:6px;align-items:center;flex-wrap:wrap';
      const label = document.createElement('span');
      label.textContent = 'Подобрано из каталога';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-outline';
      btn.style.cssText = 'padding:2px 8px;font-size:12px';
      btn.textContent = 'Применить';
      btn.addEventListener('click', () =>
        Invoices.selectNomItem(String(invoiceId), String(item.id), top.guid, top.name));
      chip.append(label, btn);
      picker.appendChild(chip);
    }
  },

  onNomFocus(event) {
    this.onNomInput(event);
  },

  onNomBlur(event) {
    const dd = document.getElementById('nom-dd-' + event.target.dataset.itemId);
    setTimeout(() => { if (dd) dd.style.display = 'none'; }, 150);
  },

  // Save the editable qty/unit/price/total on blur. Only sends a PATCH if the
  // value actually changed (to avoid spamming the server when user tabs through).
  async onItemEdit(event) {
    const el = event.target;
    const { invoiceId, itemId, field } = el.dataset;
    const raw = el.value.trim().replace(',', '.');
    // Remember the last-saved value per input to avoid pointless PATCHes.
    const prev = el.dataset.lastSaved ?? el.defaultValue.trim().replace(',', '.');
    if (raw === prev) return;

    let payload;
    if (field === 'unit') {
      payload = { unit: raw || null };
    } else {
      if (raw === '') {
        payload = { [field]: null };
      } else {
        const n = Number(raw);
        if (!Number.isFinite(n)) {
          App.notify('Некорректное число', 'error');
          el.value = prev.replace('.', ',');
          return;
        }
        payload = { [field]: n };
      }
    }

    const guardToken = `item-edit:${itemId}:${field}`;
    return this._withGuard(guardToken, async () => {
      try {
        const resp = await App.apiJson(`/invoices/${invoiceId}/items/${itemId}`, {
          method: 'PATCH',
          body: payload,
        });
        el.dataset.lastSaved = raw;
        // Refresh sibling cells (total may have been auto-derived, plus the
        // invoice-level total badge). Safest: reload the whole detail.
        this.showDetail(Number(invoiceId));
        if (resp?.data?.items_total_mismatch === 0) {
          App.notify('Сохранено', 'success');
        } else {
          App.notify('Сохранено. Сумма расходится с документом — проверьте', 'info');
        }
      } catch (e) {
        App.notify('Не сохранилось: ' + e.message, 'error');
        el.value = prev.replace('.', ',');
      }
    });
  },

  onItemEditKey(event) {
    // Enter commits by losing focus. Escape reverts.
    if (event.key === 'Enter') {
      event.preventDefault();
      event.target.blur();
    } else if (event.key === 'Escape') {
      const el = event.target;
      const prev = el.dataset.lastSaved ?? el.defaultValue;
      el.value = prev;
      el.blur();
    }
  },

  openPhotoViewer(page) {
    const images = (this._photoFiles || []).map((p, index) => ({ ...p, page: index }))
      .filter(p => p.exists !== false && (p.kind || this._fileKind(p.filename)) === 'image')
      .map(p => ({ src: this._fileUrl(p), page: p.page, name: p.filename, rotation: this._getPhotoRotation(this._currentInvoiceId, p.page) }));
    InvoicePhotoViewer.open(images, page, this._photoTitle, (pageIndex, delta) => this.rotatePhoto(this._currentInvoiceId, pageIndex, delta));
  },

  // Вкладки карточки: «Товары», «Поставщик и банк», «История» (с текстом распознавания).
  switchTab(tab) {
    const panels = { items: 'invoice-tab-items', supplier: 'invoice-tab-supplier', history: 'invoice-tab-history-wrap' };
    if (!panels[tab]) tab = 'items';
    Object.entries(panels).forEach(([key, id]) => { const el = document.getElementById(id); if (el) el.hidden = key !== tab; });
    document.querySelectorAll('#invoice-detail .ic-tab').forEach(b => {
      const on = b.dataset.tab === tab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    });
  },

  async loadPhotos() {
    const container = document.getElementById('invoice-photos-container');
    const id = this._currentInvoiceId;
    if (!id || !container) return;

    try {
      const { data } = await App.apiJson(`/invoices/${id}/photos`);
      if (id !== this._currentInvoiceId) return;
      this._photoFiles = data || [];
      if (!data || data.length === 0) {
        container.innerHTML = '<div class="empty-state">Фото не найдены</div>';
        return;
      }

      // URL comes from the server but still passes through escape — defence in depth
      // against a compromised backend or badly-sanitised filename returned by the API.
      container.innerHTML = data.map((photo, i) => {
        const kind = photo.kind || this._fileKind(photo.filename);
        if (kind === 'xml') return this._xmlDocBlock(photo);
        if (kind === 'pdf') return this._pdfDocBlock(photo, i);
        const safeUrl = encodeURI(String(photo.url || ''));
        const safeName = App.esc(photo.filename);
        const deg = this._getPhotoRotation(id, i);
        if (photo.exists === false) {
          return `<div class="photo-block"><div class="photo-toolbar"><span class="photo-caption">Лист ${i + 1}: ${safeName}</span></div>
            <div class="empty-state">Фото удалено с сервера по сроку хранения</div></div>`;
        }
        return `
        <div class="photo-block" data-page="${i}">
          <div class="photo-toolbar">
            <span class="photo-caption">Лист ${i + 1}: ${safeName}</span>
            <span class="photo-rotate-controls">
              <button type="button" class="btn btn-outline btn-sm" onclick="Invoices.openPhotoViewer(${i})" aria-label="Открыть лист ${i + 1} на весь экран">На весь экран</button>
              <button type="button" class="btn btn-outline btn-sm" title="Повернуть влево (90°)"
                      aria-label="Повернуть лист ${i + 1} влево"
                      onclick="Invoices.rotatePhoto(${id}, ${i}, -90)">↺</button>
              <button type="button" class="btn btn-outline btn-sm" title="Повернуть вправо (90°)"
                      aria-label="Повернуть лист ${i + 1} вправо"
                      onclick="Invoices.rotatePhoto(${id}, ${i}, 90)">↻</button>
            </span>
          </div>
          <div class="photo-frame" data-rot="${deg}" role="button" tabindex="0" aria-label="Увеличить лист ${i + 1}" onclick="Invoices.openPhotoViewer(${i})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();Invoices.openPhotoViewer(${i})}">
            <img src="${safeUrl}?key=${encodeURIComponent(App.apiKey)}" alt="${safeName}"
                 onerror="this.closest('.photo-frame').outerHTML='<div class=\\'empty-state\\'>Файл не найден на диске</div>'">
          </div>
        </div>`;
      }).join('');

      // Габариты считаем только после загрузки: до неё naturalWidth = 0.
      container.querySelectorAll('.photo-frame img').forEach(img => {
        if (img.complete && img.naturalWidth) this._layoutPhoto(img.closest('.photo-frame'));
        else img.addEventListener('load', () => this._layoutPhoto(img.closest('.photo-frame')), { once: true });
      });
      // Ширина карточки меняется при ресайзе и при сворачивании меню — пересчёт
      // нужен, иначе повёрнутое фото перестанет попадать в контейнер.
      if (!this._photoResizeBound) {
        window.addEventListener('resize', () => {
          document.querySelectorAll('#invoice-photos-container .photo-frame')
            .forEach(f => this._layoutPhoto(f));
        });
        this._photoResizeBound = true;
      }
      this._photosLoaded = true;
    } catch (e) {
      if (id !== this._currentInvoiceId) return;
      container.innerHTML = '<div class="empty-state">Ошибка загрузки фото. <button class="btn btn-outline btn-sm" onclick="Invoices.loadPhotos()">Повторить</button></div>';
    }
  },

  // ── Не-фото во вкладке «Фото»: электронный документ XML и PDF ─────────────
  _fileKind(name) {
    const n = String(name || '').trim().toLowerCase();
    if (n.endsWith('.xml')) return 'xml';
    return n.endsWith('.pdf') ? 'pdf' : 'image';
  },

  _fileUrl(photo) {
    return `${encodeURI(String(photo.url || ''))}?key=${encodeURIComponent(App.apiKey)}`;
  },

  // Что за документ — из разбора XML (invoices.raw_text: JSON с document,
  // function, warnings — см. src/xml/index.ts). Битый JSON — общие слова.
  _xmlMeta(data) {
    let raw = {};
    try { raw = JSON.parse(data.raw_text || '{}') || {}; } catch { raw = {}; }
    const FUNCTIONS = {
      'СЧФДОП': 'счёт-фактура и передаточный документ',
      'ДОП': 'передаточный документ',
      'СЧФ': 'счёт-фактура',
    };
    return {
      title: typeof raw.document === 'string' ? raw.document : 'Электронный документ ФНС',
      func: FUNCTIONS[raw.function] || null,
      warnings: Array.isArray(raw.warnings) ? raw.warnings.filter(w => typeof w === 'string') : [],
    };
  },

  _xmlDocBlock(photo) {
    const meta = this._currentXml || { title: 'Электронный документ ФНС', func: null, warnings: [] };
    const download = photo.exists === false
      ? '<span class="xml-doc__missing">Исходный файл удалён с сервера по сроку хранения.</span>'
      : `<a class="btn btn-outline btn-sm" href="${this._fileUrl(photo)}" download>Скачать исходный XML</a>`;
    const warnings = meta.warnings.length
      ? `<div class="xml-doc__warnings"><strong>Замечания к документу</strong>
           <ul>${meta.warnings.map(w => `<li>${App.esc(w)}</li>`).join('')}</ul></div>`
      : '';
    return `
      <div class="photo-block xml-doc">
        <div class="xml-doc__icon" aria-hidden="true">XML</div>
        <div class="xml-doc__body">
          <div class="xml-doc__title">Документ из XML</div>
          <div class="xml-doc__meta">${App.esc(meta.title)}${meta.func ? ` · ${App.esc(meta.func)}` : ''}</div>
          <p class="xml-doc__hint">Электронный документ из ЭДО: номер, суммы и строки взяты из файла как есть, без распознавания.</p>
          <div class="xml-doc__actions">${download}<span class="xml-doc__file">${App.esc(photo.filename)}</span></div>
          ${warnings}
        </div>
      </div>`;
  },

  // PDF в <img> не показывается (было «Файл не найден на диске») — встроенным
  // просмотром браузера в панели скана и ссылкой на отдельную вкладку.
  _pdfDocBlock(photo, i) {
    const missing = photo.exists === false;
    const open = missing
      ? '<span class="xml-doc__missing">Файл удалён с сервера по сроку хранения.</span>'
      : `<a class="btn btn-outline btn-sm" href="${this._fileUrl(photo)}" target="_blank" rel="noopener">Открыть в новой вкладке</a>`;
    return `
      <div class="photo-block">
        <div class="xml-doc">
          <div class="xml-doc__icon xml-doc__icon--pdf" aria-hidden="true">PDF</div>
          <div class="xml-doc__body">
            <div class="xml-doc__title">PDF-документ${i > 0 ? `, файл ${i + 1}` : ''}</div>
            <div class="xml-doc__actions">${open}</div>
          </div>
        </div>
        ${missing ? '' : `<iframe class="ic-pdf" src="${this._fileUrl(photo)}#view=FitH" title="PDF-документ ${App.esc(photo.filename)}" loading="lazy"></iframe>`}
      </div>`;
  },

  // ── Поворот фото во вкладке «Фото» ────────────────────────────────────────
  // Накладные обычно фотографируют вертикально, а читать их так неудобно.
  // Поворот чисто клиентский: сам файл не трогаем (его читал OCR, и переписывать
  // исходник ради просмотра неправильно). Выбор запоминаем по накладной и листу,
  // чтобы при следующем открытии не крутить заново.
  _PHOTO_ROT_KEY: 'sf_photo_rotation',

  _readPhotoRotations() {
    try { return JSON.parse(localStorage.getItem(this._PHOTO_ROT_KEY) || '{}'); }
    catch { return {}; }
  },

  _getPhotoRotation(invoiceId, page) {
    const v = this._readPhotoRotations()[`${invoiceId}:${page}`];
    return Number.isFinite(v) ? ((v % 360) + 360) % 360 : 0;
  },

  _savePhotoRotation(invoiceId, page, deg) {
    try {
      const all = this._readPhotoRotations();
      const key = `${invoiceId}:${page}`;
      if (deg === 0) delete all[key];       // 0° — состояние по умолчанию, не храним
      else all[key] = deg;
      // Ограничиваем рост: храним 300 последних записей (как в _markVisited).
      const keys = Object.keys(all);
      if (keys.length > 300) keys.slice(0, keys.length - 300).forEach(k => delete all[k]);
      localStorage.setItem(this._PHOTO_ROT_KEY, JSON.stringify(all));
    } catch { /* приватный режим / переполнение — поворот просто не запомнится */ }
  },

  rotatePhoto(invoiceId, page, delta) {
    const frame = document.querySelector(`#invoice-photos-container .photo-block[data-page="${page}"] .photo-frame`);
    if (!frame) return;
    const deg = ((Number(frame.dataset.rot || 0) + delta) % 360 + 360) % 360;
    frame.dataset.rot = String(deg);
    this._savePhotoRotation(invoiceId, page, deg);
    this._layoutPhoto(frame);
  },

  /**
   * Раскладка повёрнутого фото. transform: rotate() НЕ меняет layout-бокс:
   * повёрнутая на 90° вертикальная фотография вылезла бы за карточку и наехала
   * на соседний лист. Поэтому считаем габариты руками:
   *   0°/180° — вписываем по ширине контейнера, высота по пропорции;
   *   90°/270° — на экране ширина и высота меняются местами, значит по ширине
   *   контейнера надо вписать ВЫСОТУ исходника, а рамке задать высоту, равную
   *   ширине картинки.
   * Само изображение позиционируем абсолютно от центра рамки — тогда поворот
   * вокруг центра не сдвигает его вбок при любом угле.
   */
  _layoutPhoto(frame) {
    if (!frame) return;
    const img = frame.querySelector('img');
    if (!img || !img.naturalWidth || !img.naturalHeight) return;
    const deg = ((Number(frame.dataset.rot || 0) % 360) + 360) % 360;
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    const avail = frame.parentElement ? frame.parentElement.clientWidth : nw;
    const quarter = deg === 90 || deg === 270;

    // Ширина, которую займёт САМА картинка (до поворота).
    const width = quarter
      ? Math.min(nw, avail * (nw / nh))   // на экране это станет высотой
      : Math.min(nw, avail);
    const height = width * (nh / nw);

    img.style.width = `${width}px`;
    img.style.height = 'auto';
    img.style.transform = `translate(-50%, -50%) rotate(${deg}deg)`;
    // Высота рамки = вертикальный габарит ПОСЛЕ поворота.
    frame.style.height = `${Math.round(quarter ? width : height)}px`;
  },

  // Detects "(50кг)" / "(1.5 кг)" style pack-size hints in a scanned name.
  // Returns parsed {pack_size, pack_unit} or null. Only kg — по запросу
  // пользователя волюметрия (л/мл) сюда не попадает.
  detectPackKg(scannedName) {
    if (!scannedName) return null;
    const m = scannedName.match(/\(\s*(\d+(?:[.,]\d+)?)\s*кг\s*\)/i);
    if (!m) return null;
    const n = parseFloat(m[1].replace(',', '.'));
    if (!isFinite(n) || n <= 0) return null;
    return { pack_size: n, pack_unit: 'кг' };
  },

  async selectNomItem(invoiceId, itemId, guid, name) {
    // Название «как в накладной» и количество для вопроса об упаковке — из данных
    // карточки, а не из ячеек: в ячейке названия теперь ещё метки и выбор позиции 1С
    // (его варианты вроде «Сахар (50 кг)» ложно давали «упаковку 50 кг»).
    // Строки нет (таблицу успели перерисовать) — вопрос просто не задаём.
    let packOverride = null;
    try {
      const card = typeof InvoiceCard !== 'undefined' ? InvoiceCard.inv : null;
      const item = card && card.id === Number(invoiceId)
        ? (card.items || []).find(it => it.id === Number(itemId))
        : null;
      if (item) {
        const scanName = String(item.original_name || '').trim();
        const detected = this.detectPackKg(scanName);
        if (detected) {
          // Количество > 0 — показываем «1 × 50 = 50 кг», иначе общий вопрос.
          const currentQty = Number(item.quantity);
          const hasQty = isFinite(currentQty) && currentQty > 0;
          const newQty = hasQty ? currentQty * detected.pack_size : detected.pack_size;
          const msg = hasQty
            ? `Обнаружено в названии: ${detected.pack_size} ${detected.pack_unit}.\n\n`
              + `Пересчитать эту позицию как ${currentQty} × ${detected.pack_size} = ${newQty} ${detected.pack_unit} `
              + `и запомнить правило для следующих накладных с этим же названием?`
            : `Обнаружено в названии: ${detected.pack_size} ${detected.pack_unit}.\n\n`
              + `Применить упаковку 1 шт = ${detected.pack_size} ${detected.pack_unit} и запомнить правило?`;
          if (confirm(msg)) {
            packOverride = detected;
          }
        }
      }
    } catch {
      // Detection is purely cosmetic — never block saving if it throws.
    }

    try {
      const body = { onec_guid: guid };
      if (packOverride) {
        body.pack_size = packOverride.pack_size;
        body.pack_unit = packOverride.pack_unit;
      }
      const res = await App.api(`/invoices/${invoiceId}/items/${itemId}/map`, {
        method: 'PUT',
        body,
      });
      if (res.ok) {
        const extra = packOverride ? ` (${packOverride.pack_size} ${packOverride.pack_unit})` : '';
        App.notify(`Сопоставлено: ${name}${extra}`, 'success');
        this.showDetail(parseInt(invoiceId, 10));
      } else {
        const data = await res.json();
        App.notify(data.error || 'Ошибка сопоставления', 'error');
      }
    } catch (e) {
      App.notify('Ошибка: ' + e.message, 'error');
    }
  }
};
