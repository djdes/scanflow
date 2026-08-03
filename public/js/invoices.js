/* global App, Invoices */
const Invoices = {
  currentStatus: null,
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
    document.getElementById('invoices-list').style.display = 'block';
    document.getElementById('invoice-detail').style.display = 'none';
    await Promise.all([this.loadStats(), this.loadTable()]);
  },

  async loadStats() {
    try {
      const { data } = await App.apiJson('/invoices/stats');
      const container = document.getElementById('invoices-stats');
      const counts = {};
      (data.byStatus || []).forEach(s => { counts[s.status] = s.count; });
      const sber = data.sberUnsent || { count: 0, totalSum: 0 };

      const parts = [];
      const unread = data.unreadCount || 0;
      if (unread > 0) parts.push(`Не прочитанных ${unread}`);
      const errors = counts.error || 0;
      if (errors > 0) parts.push(`Ошибки ${errors}`);
      const unpaidSum = Math.round(Number(sber.totalSum));
      if (unpaidSum > 0) parts.push(`Не оплачено ${unpaidSum.toLocaleString('ru-RU')} руб`);

      container.textContent = parts.join(' / ');
      container.style.display = parts.length > 0 ? '' : 'none';
    } catch (e) {
      console.error('Failed to load stats', e);
    }
  },

  async loadTable() {
    this._renderPeriod();
    // Набор строк меняется — прежнее выделение больше не относится к этим строкам.
    this._selected.clear();
    this._renderBulkBar();

    let url = `/invoices?limit=${this.limit}&offset=${this.offset}`;
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
    App.skeletonRows('invoices-tbody', ['w-24', 'w-24', 'w-40', 'w-40', 'w-60', 'w-40', 'w-24', 'w-40', 'w-24', 'w-24'], 6);

    try {
      const { data } = await App.apiJson(url);
      const tbody = document.getElementById('invoices-tbody');

      if (!data || data.length === 0) {
        const filtered = this.search || this._anyColumnFilter();
        tbody.innerHTML = `<tr><td colspan="10"><div class="empty-state">
          <div class="empty-icon">&#128196;</div>
          <div>${filtered
            ? 'Ничего не найдено — измените поиск, период или фильтр.'
            : 'Накладных пока нет. Загрузите фото или положите в папку data/inbox/'}</div>
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
          <td colspan="10">${Invoices._dayHeaderLabel(day, dayCounts[day])}</td>
        </tr>`);
        }
        const overdueDays = Number(inv.sber_overdue_days) || 14;
        const _visited = this.isVisited(inv.id);
        rowsHtml.push(`
        <tr class="clickable${inv.sber_overdue ? ' sber-overdue' : ''}${!inv.read_at ? ' unread' : ''}${_visited ? ' inv-visited' : ''}" data-day="${day}"
            ${inv.sber_overdue ? `style="box-shadow:inset 3px 0 0 #f59e0b" title="Счёт в Сбербанк не выставлен более ${overdueDays} дней"` : ''}
            onclick="Invoices.openInvoice(${inv.id})">
          <td class="col-check"><input type="checkbox" class="row-check" data-id="${inv.id}" ${this._selected.has(inv.id) ? 'checked' : ''} onclick="event.stopPropagation()" onchange="Invoices.toggleSelect(${inv.id}, this.checked)" aria-label="Выбрать накладную ${inv.id}"></td>
          <td class="col-id" data-label="ID">${inv.id}</td>
          <td data-label="Номер">${App.esc(inv.invoice_number || '—')}${inv.duplicate_of ? ` <span class="dup-badge" title="Дубликат накладной #${inv.duplicate_of}${inv.duplicate_score ? `, вероятность ${Math.round(inv.duplicate_score * 100)}%` : ''}">🔁 #${inv.duplicate_of}</span>` : ''}</td>
          <td data-label="Дата">${App.formatDate(inv.invoice_date)}</td>
          <td data-label="Поставщик">${App.esc(inv.supplier || '—')}</td>
          <td style="text-align:right" data-label="Сумма">${App.formatMoney(inv.total_sum)}${inv.items_total_mismatch ? ' <span title="Сумма расходилась с суммой позиций" style="color:#dc2626">⚠</span>' : ''}</td>
          <td style="text-align:center" data-label="Цены ↑">${this._elevatedCell(inv)}</td>
          <td data-label="Статус">${this._statusCell(inv)}</td>
          <td style="text-align:center" data-label="Сбер">${this._sberCell(inv)}</td>
          <td style="text-align:right;white-space:nowrap" class="cell-action">
            ${inv.status === 'processed' && !inv.approved_for_1c
              ? `<button class="btn btn-primary btn-sm" style="margin-right:4px" title="Отправить в 1С"
                    onclick="Invoices.sendTo1C(${inv.id}, event, true)">&rarr; 1С</button>`
              : `<button class="btn btn-primary btn-sm" style="margin-right:4px;visibility:hidden" tabindex="-1" aria-hidden="true" disabled>&rarr; 1С</button>`}
            <button class="btn-icon-gear" title="Действия"
                    aria-label="Действия для накладной ${inv.id}"
                    onclick="Invoices.openRowMenu(${inv.id}, ${inv.read_at ? 1 : 0}, ${inv.paid_externally ? 1 : 0}, event)">&#9881;</button>
          </td>
        </tr>`);
      }
      tbody.innerHTML = rowsHtml.join('');
      this._syncSelectAll(); // выбор сброшен в начале loadTable — привести шапку в тон

      // Pagination
      const pagination = document.getElementById('invoices-pagination');
      if (data.length >= this.limit) {
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
    bar.innerHTML = `
      <span class="bulk-count">Выбрано ${n}</span>
      <button class="btn btn-primary btn-sm" onclick="Invoices.bulkSend('onec')">&rarr; 1С</button>
      <button class="btn btn-primary btn-sm" onclick="Invoices.bulkSend('sber')">&rarr; Сбер</button>
      <button class="btn btn-primary btn-sm" onclick="Invoices.bulkSend('both')">&rarr; 1С и Сбер</button>
      <button class="btn btn-outline btn-sm" onclick="Invoices.clearSelection()">Снять выделение</button>`;
  },

  async bulkSend(target) {
    const ids = [...this._selected];
    if (ids.length === 0) return;
    return this._withGuard('bulkSend', async () => {
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
    });
  },

  _showBulkReport(reports) {
    const LABELS = {
      not_processed: 'не в статусе «Обработан»',
      already_approved: 'уже отправлена в 1С',
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
      || this.currentStatus || this.dateFrom || this.dateTo);
  },

  // Кнопка «Сбросить» появляется, только когда что-то реально выбрано.
  _syncFilterReset() {
    const btn = document.getElementById('filter-reset');
    if (btn) btn.hidden = !this._anyColumnFilter();
  },

  resetColumnFilters() {
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

  // Status badge for the list. A 'processed' invoice that's been approved for 1C
  // pickup shows a distinct «Ожидает 1С» badge (full text in the tooltip) instead
  // of the plain «Обработан» — mirrors the detail page's "Ожидает загрузки в 1С".
  _statusCell(inv) {
    if (inv.status === 'processed' && inv.approved_for_1c) {
      return '<span class="badge badge-sent" title="Ожидает загрузки в 1С">Ожидает 1С</span>';
    }
    return App.statusBadge(inv.status);
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

  // Ставка НДС хранится по позициям, поэтому в шапке показываем набор
  // уникальных ставок: «10%», «10%, 20%» на смешанной накладной или «—», если
  // ставку не распознали. Сверять есть что именно здесь — в таблице позиций
  // ставка тонет среди строк.
  _vatRatesText(items) {
    const rates = [...new Set((items || [])
      .map(i => i.vat_rate)
      .filter(r => r != null && r !== ''))]
      .map(Number)
      .filter(r => Number.isFinite(r))
      .sort((a, b) => a - b);
    if (!rates.length) return '<span class="muted">—</span>';
    return rates.map(r => `${r}%`).join(', ');
  },

  _attrCheckbox(data, attr) {
    const checked = data[`attr_checked_${attr}`] ? ' checked' : '';
    return `<label class="attr-check" title="Отметить, что реквизит сверён с фотографией">
      <input type="checkbox"${checked} data-attr="${attr}"
             onchange="Invoices.toggleAttrCheck(${data.id}, '${attr}', this.checked)"
             aria-label="Сверено с фото">
    </label>`;
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
      // Откатываем визуально: сервер состояние не принял.
      const box = document.querySelector(`.attr-check input[data-attr="${attr}"]`);
      if (box) box.checked = !value;
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

  // Разложить состояние с сервера по чекбоксам полей и пересчитать гейт.
  _applyAttrState(state) {
    if (!state) return;
    Object.keys(this.ATTR_FIELDS).forEach(attr => {
      const box = document.querySelector(`.attr-check input[data-attr="${attr}"]`);
      if (box) box.checked = !!state[attr];
    });
    this._syncSberGate();
  },

  // Единственное место, где решается, можно ли жать «Отправить в Сбербанк».
  // Зовётся и после переключения галочки, и после отрисовки блока Сбера.
  _syncSberGate() {
    const boxes = [...document.querySelectorAll('.attr-check input[data-attr]')];
    if (!boxes.length) return;
    const missing = boxes.filter(b => !b.checked)
      .map(b => ({
        number: 'Номер', date: 'Дата', supplier: 'Поставщик',
        total: 'Сумма', vat: 'НДС', vat_rate: 'Ставка НДС',
      })[b.dataset.attr]);
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

  // Renders one cell in the invoices list that shows whether a Sber payment
  // exists for this invoice (created/failed/pending), so the user can spot at
  // a glance which invoices have already been pushed to the bank.
  _sberCell(inv) {
    const status = inv.sber_payment_status;
    // «Оплачено вне сервиса» — приоритетнее всего: такую накладную не платят через
    // Сбер, она исключена из overdue/бэклога на бэкенде, показываем нейтральный бейдж.
    if (inv.paid_externally) {
      return '<span style="color:#64748b;white-space:nowrap" title="Оплачено вне сервиса — платёж в Сбер не нужен">💵 Сами</span>';
    }
    // Overdue takes precedence: a payable invoice with no (non-failed) Sber
    // payment past the threshold. The server-side sber_overdue flag already
    // encodes "payable AND old AND no created/pending payment".
    if (inv.sber_overdue) {
      const overdueDays = Number(inv.sber_overdue_days) || 14;
      return `<span style="color:#d97706;font-weight:600;white-space:nowrap" title="Счёт в Сбербанк не выставлен более ${overdueDays} дней">⏰ ${overdueDays}д+</span>`;
    }
    if (!status) return '<span style="color:#cbd5e1" title="Платёж в Сбер.Бизнес не создан">—</span>';
    const num = inv.sber_payment_number ? ` №${App.esc(inv.sber_payment_number)}` : '';
    if (status === 'created') {
      return `<span style="color:#16a34a;font-size:18px" title="Черновик создан в Сбер.Бизнес${num}">✓</span>`;
    }
    if (status === 'failed') {
      return `<span style="color:#dc2626;font-size:16px" title="Ошибка отправки${num} — открой накладную чтобы увидеть детали">⚠</span>`;
    }
    if (status === 'pending') {
      return `<span style="color:#f59e0b;font-size:16px" title="Отправка в процессе…">⏳</span>`;
    }
    return `<span style="color:#94a3b8" title="Статус: ${App.esc(status)}">●</span>`;
  },

  async showDetail(id) {
    document.getElementById('invoices-list').style.display = 'none';
    document.getElementById('invoice-detail').style.display = 'block';

    this._currentInvoiceId = id;
    this._photosLoaded = false;
    this._markVisited(id);
    this._loadNeighbours(id);

    // Reset to items tab
    document.getElementById('invoice-tab-items').style.display = 'block';
    document.getElementById('invoice-tab-photos').style.display = 'none';
    document.getElementById('invoice-tab-ocr').style.display = 'none';
    document.getElementById('invoice-tab-history').style.display = 'none';
    document.getElementById('invoice-tab-history').innerHTML = '';
    const tabBtns = document.querySelectorAll('#invoice-detail .tabs .tab-btn');
    tabBtns.forEach((b, i) => b.classList.toggle('active', i === 0));

    await OnecCatalog.load();

    try {
      const { data } = await App.apiJson(`/invoices/${id}`);
      if (!data) {
        App.notify('Накладная не найдена', 'error');
        App.navigate('#/invoices');
        return;
      }

      // Header fields
      const header = document.getElementById('invoice-header-fields');
      header.innerHTML = `
        <div class="invoice-field">
          <div class="field-label">${this._attrCheckbox(data, 'number')}Номер</div>
          <div class="field-value">${App.esc(data.invoice_number || '—')}</div>
        </div>
        <div class="invoice-field">
          <div class="field-label">${this._attrCheckbox(data, 'date')}Дата</div>
          <div class="field-value">${App.formatDate(data.invoice_date)}</div>
        </div>
        <div class="invoice-field">
          <div class="field-label">${this._attrCheckbox(data, 'supplier')}Поставщик</div>
          <div class="field-value">${App.esc(data.supplier || '—')}</div>
        </div>
        <div class="invoice-field">
          <div class="field-label">${this._attrCheckbox(data, 'total')}Сумма</div>
          <div class="field-value">
            ${App.formatMoney(data.total_sum)}
            ${data.items_total_mismatch ? '<span class="badge badge-error" title="Сумма в документе расходилась с суммой позиций более чем на 1%. Значение пересчитано из товаров — проверьте глазами." style="margin-left:8px">⚠ требует проверки</span>' : ''}
          </div>
        </div>
        <div class="invoice-field">
          <div class="field-label">${this._attrCheckbox(data, 'vat')}В т.ч. НДС</div>
          <div class="field-value">${data.vat_sum != null ? App.formatMoney(data.vat_sum) : '—'}</div>
        </div>
        <div class="invoice-field">
          <div class="field-label">${this._attrCheckbox(data, 'vat_rate')}Ставка НДС</div>
          <div class="field-value">${this._vatRatesText(data.items)}</div>
        </div>
        <div class="invoice-field">
          <div class="field-label">Статус</div>
          <div class="field-value">${App.statusBadge(data.status)}</div>
        </div>
        <div class="invoice-field">
          <div class="field-label">Обработка</div>
          <div class="field-value">${App.ocrEngineBadge(data.ocr_engine)}</div>
        </div>
        <div class="invoice-field">
          <div class="field-label">Файл</div>
          <div class="field-value">${App.esc(data.file_name || '')}</div>
        </div>
        <div class="invoice-field">
          <div class="field-label">Создан</div>
          <div class="field-value">${App.formatDate(data.created_at)}</div>
        </div>
      `;

      // История tab — render for every invoice (incl. duplicates), before any
      // early-return. .catch keeps a rejection from masking showDetail success.
      this.renderHistory(data).catch(e => console.error('renderHistory failed', e));

      // Supplier details (banking)
      const supplierBlock = document.getElementById('invoice-supplier-details');
      if (data.supplier_inn || data.supplier_bik || data.supplier_account) {
        let html = '<h3 style="margin-bottom:12px">Реквизиты поставщика</h3><div class="invoice-header">';
        if (data.invoice_type) {
          html += `<div class="invoice-field"><div class="field-label">Тип документа</div><div class="field-value">${App.esc(data.invoice_type)}</div></div>`;
        }
        if (data.onec_status && data.onec_status !== 'not_sent') {
          html += `<div class="invoice-field"><div class="field-label">Статус в 1С</div><div class="field-value">${App.esc(data.onec_status)}${data.onec_document_ref ? ` · ${App.esc(data.onec_document_ref)}` : ''}${data.onec_error ? `<small class="text-danger">${App.esc(data.onec_error)}</small>` : ''}</div></div>`;
        }
        if (data.supplier_inn) {
          html += `<div class="invoice-field"><div class="field-label">ИНН</div><div class="field-value">${App.esc(data.supplier_inn)}</div></div>`;
        }
        if (data.supplier_bik) {
          html += `<div class="invoice-field"><div class="field-label">БИК</div><div class="field-value">${App.esc(data.supplier_bik)}</div></div>`;
        }
        if (data.supplier_account) {
          html += `<div class="invoice-field"><div class="field-label">Расч. счёт</div><div class="field-value">${App.esc(data.supplier_account)}</div></div>`;
        }
        if (data.supplier_corr_account) {
          html += `<div class="invoice-field"><div class="field-label">Корр. счёт</div><div class="field-value">${App.esc(data.supplier_corr_account)}</div></div>`;
        }
        if (data.supplier_address) {
          html += `<div class="invoice-field"><div class="field-label">Адрес</div><div class="field-value">${App.esc(data.supplier_address)}</div></div>`;
        }
        html += '</div>';
        supplierBlock.innerHTML = html;
        supplierBlock.style.display = 'block';
      } else {
        supplierBlock.style.display = 'none';
      }

      // Actions
      const actions = document.getElementById('invoice-actions');
      let actionsHtml = '';

      // Duplicate banner — превалирует над всем остальным. Дубликаты не сохраняют
      // items, поэтому 1С/Сбер actions ниже им бесполезны.
      if (data.duplicate_of) {
        let duplicateReasons = [];
        try { duplicateReasons = JSON.parse(data.duplicate_reasons || '[]'); } catch { duplicateReasons = []; }
        const evidence = duplicateReasons.length
          ? duplicateReasons.map(reason => App.esc(reason)).join(' · ')
          : 'Совпали ключевые реквизиты документа';
        const probability = data.duplicate_score ? `, вероятность ${Math.round(data.duplicate_score * 100)}%` : '';
        actionsHtml += `
          <div class="duplicate-banner">
            <div class="duplicate-banner-text">
              🔁 <strong>Дубликат накладной</strong>
              <a href="#/invoices/${data.duplicate_of}">№${data.duplicate_of}</a>
              ${App.esc(probability)} — ${evidence}. Позиции в эту запись не сохранены.
            </div>
            <div class="duplicate-banner-actions">
              <button class="btn btn-outline btn-sm" onclick="Invoices.unlinkDuplicate(${data.id})">Не дубликат</button>
              <button class="btn btn-danger btn-sm" onclick="Invoices.deleteInvoice(${data.id})">Удалить дубликат</button>
            </div>
          </div>
        `;
        actions.innerHTML = actionsHtml;
        // Items/Sber/1С блоки ниже не нужны для дубликата — выйти из rendering
        if (window.Sber) {
          // Спрятать Sber-секцию если она была от прошлого invoice
          const sberWrap = document.getElementById('invoice-sber-section');
          if (sberWrap) sberWrap.style.display = 'none';
        }
        return;
      }

      // Possible split-page duplicate: same number+supplier+date as another row.
      // Auto-merge (fileWatcher Strategy A) only fires within 10 min and skips
      // sent invoices, so late/post-send pages fork into a separate invoice.
      // Offer a one-click fold-in using the existing merge-into endpoint.
      const sibs = data.possible_siblings || [];
      if (sibs.length > 0) {
        const sentWarn = data.status === 'sent_to_1c' || data.approved_for_1c
          || sibs.some(s => s.status === 'sent_to_1c' || s.approved_for_1c);
        const banner = document.getElementById('invoice-sibling-banner');
        banner.style.display = 'block';
        banner.innerHTML = sibs.map(s => `
          <div class="duplicate-banner">
            <div class="duplicate-banner-text">
              ⚠ <strong>Похоже на ту же накладную:</strong>
              <a href="#/invoices/${s.id}">№${s.id}</a>
              — ${s.items_count} позиц., ${App.formatMoney(s.total_sum)}${s.status === 'sent_to_1c' ? ', «Отправлен»' : ''}.
              Возможно, это страницы одной накладной.
            </div>
            <div class="duplicate-banner-actions">
              <button class="btn btn-primary btn-sm"
                onclick="Invoices.mergeSibling(${data.id}, ${s.id}, ${sentWarn})">Объединить →</button>
            </div>
          </div>
        `).join('');
      } else {
        const banner = document.getElementById('invoice-sibling-banner');
        if (banner) banner.style.display = 'none';
      }

      const unmappedCount = (data.items || []).filter(it => !it.onec_guid).length;
      if (data.status === 'processed') {
        if (data.approved_for_1c) {
          actionsHtml += `<div class="badge badge-sent" style="padding:8px 16px">✓ Ожидает загрузки в 1С</div>`;
          actionsHtml += `<button class="btn btn-outline" onclick="Invoices.unapproveForOneC(${data.id})">Отозвать отправку</button>`;
        } else {
          // Allow sending even with unmatched items — the BSL side calls
          // НайтиИлиСоздатьНоменклатуру() which auto-creates new catalog
          // entries in 1C when no match is found. This is the normal flow
          // for first-time supplier items we haven't ordered before.
          actionsHtml += `<button class="btn btn-primary" onclick="Invoices.sendTo1C(${data.id})">Отправить в 1С</button>`;
          if (unmappedCount > 0) {
            actionsHtml += `<div class="badge badge-new" style="padding:8px 16px" title="Несопоставленные товары будут созданы как новая номенклатура в 1С">Новых товаров: ${unmappedCount}</div>`;
          }
        }
      }
      if (data.status === 'sent_to_1c') {
        actionsHtml += `<button class="btn btn-outline" onclick="Invoices.resetStatus(${data.id})" title="Сбросить статус «Отправлен», чтобы можно было повторно отправить в 1С">↻ Сбросить статус</button>`;
      }
      if (data.error_message) {
        actionsHtml += `<div class="badge badge-error" style="padding:8px 16px">${App.esc(data.error_message)}</div>`;
      }
      // Remap buttons — two separate buttons, planshet-friendly
      if (unmappedCount > 0) {
        actionsHtml += `<button class="btn btn-outline" onclick="Invoices.remap(${data.id}, false)" title="Попытаться сопоставить несопоставленные товары">Сопоставить недостающие</button>`;
      }
      actionsHtml += `<button class="btn btn-outline" onclick="Invoices.editHeader(${data.id})" title="Редактировать реквизиты накладной">✎ Реквизиты</button>`;
      actionsHtml += `<button class="btn btn-outline" onclick="Invoices.remap(${data.id}, true)" title="Пересопоставить все товары заново">Пересопоставить всё</button>`;
      actionsHtml += `<button class="btn btn-outline" onclick="Invoices.rescan(${data.id})" title="Полный re-OCR + re-Claude + re-mapping исходного фото">🔄 Пересканировать фото</button>`;
      actionsHtml += `<button class="btn btn-outline" onclick="Invoices.addPages(${data.id})" title="Дофоткать страницы — их позиции добавятся в эту накладную">📎 Добавить страницы</button>`;
      // LLM button is always visible. When everything is already mapped it
      // passes all=true so Claude can reconsider existing picks (catalog may
      // have grown, or an old fuzzy match may be improvable).
      const llmAll = unmappedCount === 0;
      const llmLabel = llmAll ? 'LLM: переделать всё' : 'LLM-маппинг';
      const llmTitle = llmAll
        ? 'Пересобрать все маппинги через Claude LLM (Anthropic API)'
        : 'Сопоставить несопоставленные товары через Claude LLM (Anthropic API)';
      actionsHtml += `<button class="btn btn-outline" onclick="Invoices.llmRemap(${data.id}, ${llmAll})" title="${llmTitle}">${llmLabel}</button>`;
      // Delete button (destructive, always visible, pushed to the right)
      actionsHtml += `<button class="btn btn-danger" style="margin-left:auto" onclick="Invoices.deleteInvoice(${data.id})">Удалить накладную</button>`;
      actions.innerHTML = actionsHtml;

      // Sber section (button + status)
      if (window.Sber) {
        Sber.renderInvoiceSection(data).catch(err => console.error('[sber] render section', err));
      }

      // Items table
      const itemsTbody = document.getElementById('invoice-items-tbody');
      if (data.items && data.items.length > 0) {
        itemsTbody.innerHTML = data.items.map((item, i) => {
          const badge = item.name_overridden
            ? '<span class="nom-badge nom-badge-custom" title="Своё название — будет создано в 1С под этим именем">✎</span>'
            : item.onec_guid
              ? '<span class="nom-badge nom-badge-ok" title="Сопоставлено с 1С">✓</span>'
              : '<span class="nom-badge nom-badge-missing" title="Требует сопоставления">●</span>';
          const currentName = item.mapped_name || item.original_name || '';
          // esc() also escapes quotes, which is what we need for value="..."
          const safeName = App.esc(currentName);
          return `
          <tr data-item-id="${item.id}" class="${Invoices._rowClassForDeviation(item.price_deviation_pct)}">
            <td>${i + 1}</td>
            <td>${App.esc(item.original_name || '')}</td>
            <td>
              <div class="nom-picker">
                ${badge}
                <input type="text" class="nom-picker-input"
                       value="${safeName}"
                       data-invoice-id="${data.id}"
                       data-item-id="${item.id}"
                       data-current-guid="${App.esc(item.onec_guid || '')}"
                       oninput="Invoices.onNomInput(event)"
                       onfocus="Invoices.onNomFocus(event)"
                       onblur="Invoices.onNomBlur(event)">
                <div class="nom-picker-dropdown" id="nom-dd-${item.id}"></div>
                ${item.name_overridden
                  ? '<div class="nom-custom-note" title="Это название уйдёт в 1С для создания товара">✎ Своё название → создастся в 1С</div>'
                  : ''}
              </div>
            </td>
            <td style="text-align:right">
              <input type="text" inputmode="decimal" class="item-edit item-edit-qty"
                     value="${item.quantity != null ? String(item.quantity).replace('.', ',') : ''}"
                     data-invoice-id="${data.id}" data-item-id="${item.id}" data-field="quantity"
                     onblur="Invoices.onItemEdit(event)" onkeydown="Invoices.onItemEditKey(event)">
            </td>
            <td>
              <input type="text" class="item-edit item-edit-unit"
                     value="${App.esc(item.unit || '')}"
                     data-invoice-id="${data.id}" data-item-id="${item.id}" data-field="unit"
                     onblur="Invoices.onItemEdit(event)" onkeydown="Invoices.onItemEditKey(event)">
            </td>
            <td style="text-align:right">
              ${Invoices._priceCell(item)}
            </td>
            ${Invoices._medianCell(item)}
            <td style="text-align:right">
              <input type="text" inputmode="decimal" class="item-edit item-edit-total"
                     value="${item.total != null ? Number(item.total).toFixed(2).replace('.', ',') : ''}"
                     data-invoice-id="${data.id}" data-item-id="${item.id}" data-field="total"
                     onblur="Invoices.onItemEdit(event)" onkeydown="Invoices.onItemEditKey(event)">
            </td>
            <td style="text-align:center">${item.vat_rate != null ? item.vat_rate + '%' : '—'}</td>
            <td>${App.confidenceBadge(item.mapping_confidence || 0)}</td>
          </tr>
        `;
        }).join('');
      } else {
        itemsTbody.innerHTML = '<tr><td colspan="10"><div class="empty-state">Товары не найдены</div></td></tr>';
      }

      // Elevated-price warning banner + mobile square counters.
      this._renderPriceWarning(data.items || []);
      this._renderPriceBadges(data.items || []);

      // Q4: for items left unmapped, auto-select a confident catalog match so
      // the user only confirms (the item still needs a click — we don't silently
      // write a sub-1.0 guess, per the ingest auto-apply policy).
      this._suggestUnmapped(data.id, data.items || []);

      // OCR text
      document.getElementById('invoice-ocr-text').textContent = data.raw_text || 'Нет данных';

    } catch (e) {
      console.error('Failed to load invoice detail', e);
      App.notify('Ошибка загрузки накладной', 'error');
    }
  },

  // Guard mutating actions against double-clicks / duplicate submissions.
  // Render «Цена» as read-only «X,XX ₽/<unit>». Per-unit cost = item.price
  // (OCR parses price as total/qty per ScanFlow convention, so it's already
  // per-unit). Falls back to «—» when price is null.
  _priceCell(item) {
    if (item.price == null) return '<span class="muted">—</span>';
    const v = Number(item.price).toFixed(2).replace('.', ',');
    const u = item.unit ? `/${App.esc(item.unit)}` : '';
    return `<span class="price-readonly">${v} ₽${u}</span>${Invoices._priceBadge(item)}`;
  },

  // Inline "повышенная цена" pill — shown when the scanned price is >10% above
  // the usual (median) price. Tiered colour matches the row heatmap.
  _priceBadge(item) {
    const pct = item.price_deviation_pct;
    if (pct == null || pct <= 10) return '';
    const r = Math.round(pct);
    const cls = pct > 50 ? 'price-flag-anomaly' : pct > 25 ? 'price-flag-alert' : 'price-flag-warn';
    return `<div class="price-flag-wrap"><span class="price-flag ${cls}" title="Цена выше обычной на ${r}%">↑ +${r}%</span></div>`;
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
    const ua = data.upload_user_agent
      ? `<div class="muted" style="font-size:12px;margin-top:2px;word-break:break-all">${App.esc(data.upload_user_agent)}</div>`
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
    `;

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

  _plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  },

  // Summary banner above the items table: counts positions priced >10% above
  // the usual price. Empty (cleared) when there are none.
  _renderPriceWarning(items) {
    const el = document.getElementById('invoice-price-warning');
    if (!el) return;
    const flagged = items.filter(it => it.price_deviation_pct != null && it.price_deviation_pct > 10);
    if (!flagged.length) { el.innerHTML = ''; return; }
    const worst = Math.round(Math.max(...flagged.map(f => f.price_deviation_pct)));
    const names = flagged
      .sort((a, b) => b.price_deviation_pct - a.price_deviation_pct)
      .slice(0, 3)
      .map(f => App.esc(f.mapped_name || f.original_name || ''))
      .join(', ');
    const more = flagged.length > 3 ? ` и ещё ${flagged.length - 3}` : '';
    const noun = this._plural(flagged.length, 'позиция', 'позиции', 'позиций');
    el.innerHTML = `
      <div class="price-warning-banner">
        <span class="price-warning-banner__icon">⚠</span>
        <div>
          <strong>Повышенная цена: ${flagged.length} ${noun}</strong> дороже обычной более чем на 10% (до +${worst}%).
          <div class="muted" style="margin-top:2px">${names}${more}</div>
        </div>
      </div>`;
  },

  // Map a price-deviation percentage to a row class.
  _rowClassForDeviation(pct) {
    if (pct == null) return '';
    if (pct <= -10) return 'row-price-good';
    if (pct <= 10) return '';
    if (pct <= 25) return 'row-price-warn';
    if (pct <= 50) return 'row-price-alert';
    return 'row-price-anomaly';
  },

  // Format the «Обычная» cell. Returns the cell HTML.
  _medianCell(item) {
    if (item.median_price == null) return '<td></td>';
    const price = Number(item.median_price).toFixed(2).replace('.', ',');
    const samples = item.median_samples ?? 0;
    return `<td style="text-align:right"><div>${price} ₽</div><small class="muted">${samples} поставок</small></td>`;
  },

  // Each action claims a unique token; subsequent clicks while it's active
  // are dropped. Public so other modules (mappings.js, etc.) can reuse.
  _busy: new Set(),
  _withGuard(token, fn) {
    if (this._busy.has(token)) return Promise.resolve(undefined);
    this._busy.add(token);
    return Promise.resolve().then(fn).finally(() => this._busy.delete(token));
  },

  // === Editable header fields & validation ===

  _REQUIRED_FOR_1C: ['invoice_number', 'invoice_date', 'supplier', 'supplier_inn', 'total_sum'],
  _REQUIRED_FOR_SBER: ['supplier', 'supplier_inn', 'supplier_bik', 'total_sum'],

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

  rescan(id) {
    this.showConfirm(
      'Вы уверены?',
      'Фото будет заново распознано через Claude API, текущие позиции заменятся новыми.',
      () => this._withGuard(`rescan:${id}`, async () => {
        try {
          App.notify('Пересканирование запущено, ожидайте 10–30 сек…', 'info');
          const res = await App.api(`/invoices/${id}/rescan`, { method: 'POST' });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            App.notify(err.error || `Ошибка ${res.status}`, 'error');
            return;
          }
          App.notify('Накладная пересканирована', 'success');
          this.showDetail(id);
        } catch (e) {
          App.notify('Ошибка: ' + e.message, 'error');
        }
      }),
      { okLabel: 'Да', cancelLabel: 'Нет', okClass: 'btn-primary' }
    );
  },

  // "Дофоткать страницы" — pick/take photo(s), upload to the invoice; their
  // recognized items append to it. OCR is async on the server, so we poll the
  // invoice until its item count grows, then reload the detail.
  addPages(id) {
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
      await this._withGuard(`addPages:${id}`, async () => {
        let before = 0;
        try { before = (await App.apiJson(`/invoices/${id}`)).data?.items?.length ?? 0; } catch { /* ignore */ }
        const fd = new FormData();
        for (const f of files) fd.append('files', f);
        let resp;
        try {
          resp = await App.api(`/invoices/${id}/add-pages`, { method: 'POST', body: fd });
        } catch (e) { App.notify('Ошибка загрузки: ' + e.message, 'error'); return; }
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          App.notify(err.error || `Ошибка ${resp.status}`, 'error');
          return;
        }
        App.notify(`Загружено страниц: ${files.length}. Распознавание идёт (~${Math.max(1, files.length)} мин)…`, 'info');
        const deadline = Date.now() + 60000 * Math.max(2, files.length * 2);
        const poll = async () => {
          try {
            const now = (await App.apiJson(`/invoices/${id}`)).data?.items?.length ?? 0;
            if (now > before) {
              App.notify(`Страницы добавлены (+${now - before} позиц.)`, 'success');
              this.showDetail(id);
              return;
            }
          } catch { /* ignore, keep polling */ }
          if (Date.now() < deadline) setTimeout(poll, 5000);
          else { App.notify('Обработка затянулась — обновите страницу позже', 'info'); this.showDetail(id); }
        };
        setTimeout(poll, 5000);
      });
    }, { once: true });
    input.click();
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

  async remap(id, forceAll) {
    return this._withGuard(`remap:${id}`, async () => {
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
    });
  },

  async llmRemap(id, all = false) {
    return this._withGuard(`llmRemap:${id}`, async () => {
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
    });
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

  // Small per-row action menu opened by the ⚙ button. One floating element is
  // (re)built and positioned under the gear. `read`/`paid` are the row's current
  // 0/1 flags so the toggle captions reflect state without a refetch.
  openRowMenu(id, read, paid, event) {
    if (event) { event.stopPropagation(); event.preventDefault(); }
    this._closeRowMenu();
    const btn = event && event.currentTarget;
    const menu = document.createElement('div');
    menu.className = 'row-action-menu';
    menu.id = 'row-action-menu';
    menu.innerHTML = `
      <button class="ram-item" data-act="read">${read ? '&#9711; Пометить непрочитанной' : '&#10003; Пометить прочитанной'}</button>
      <button class="ram-item" data-act="paid">${paid ? '&#8617; Снять «оплачено сами»' : '&#128181; Оплатили сами'}</button>
      <button class="ram-item ram-danger" data-act="delete">&#128465; Удалить</button>`;
    document.body.appendChild(menu);
    if (btn) {
      const r = btn.getBoundingClientRect();
      menu.style.top = `${window.scrollY + r.bottom + 4}px`;
      menu.style.left = `${Math.max(8, window.scrollX + r.right - menu.offsetWidth)}px`;
    }
    menu.querySelector('[data-act="read"]').onclick = (e) => { e.stopPropagation(); this._closeRowMenu(); this._markRead(id, !read); };
    menu.querySelector('[data-act="paid"]').onclick = (e) => { e.stopPropagation(); this._closeRowMenu(); this._markPaidExternally(id, !paid); };
    menu.querySelector('[data-act="delete"]').onclick = (e) => { e.stopPropagation(); this._closeRowMenu(); this.deleteInvoice(id); };
    // Defer listener attach so THIS click (which opened the menu) doesn't close it.
    setTimeout(() => {
      this._rowMenuOutside = (e) => { if (!menu.contains(e.target)) this._closeRowMenu(); };
      this._rowMenuEsc = (e) => { if (e.key === 'Escape') this._closeRowMenu(); };
      document.addEventListener('click', this._rowMenuOutside);
      document.addEventListener('keydown', this._rowMenuEsc);
    }, 0);
  },

  _closeRowMenu() {
    const m = document.getElementById('row-action-menu');
    if (m) m.remove();
    if (this._rowMenuOutside) { document.removeEventListener('click', this._rowMenuOutside); this._rowMenuOutside = null; }
    if (this._rowMenuEsc) { document.removeEventListener('keydown', this._rowMenuEsc); this._rowMenuEsc = null; }
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
        this.showList();
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

  switchTab(tab, btn) {
    // Hide all tabs
    document.getElementById('invoice-tab-items').style.display = 'none';
    document.getElementById('invoice-tab-photos').style.display = 'none';
    document.getElementById('invoice-tab-ocr').style.display = 'none';
    document.getElementById('invoice-tab-history').style.display = 'none';

    // Deactivate all buttons
    btn.parentElement.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    // Show selected tab
    document.getElementById('invoice-tab-' + tab).style.display = 'block';

    // Load photos on first switch
    if (tab === 'photos' && !this._photosLoaded) {
      this.loadPhotos();
    }
  },

  async loadPhotos() {
    const container = document.getElementById('invoice-photos-container');
    const id = this._currentInvoiceId;
    if (!id) return;

    try {
      const { data } = await App.apiJson(`/invoices/${id}/photos`);
      if (!data || data.length === 0) {
        container.innerHTML = '<div class="empty-state">Фото не найдены</div>';
        return;
      }

      // URL comes from the server but still passes through escape — defence in depth
      // against a compromised backend or badly-sanitised filename returned by the API.
      container.innerHTML = data.map((photo, i) => {
        const safeUrl = encodeURI(String(photo.url || ''));
        const safeName = App.esc(photo.filename);
        return `
        <div style="margin-bottom:16px">
          <div style="margin-bottom:4px;color:#888;font-size:13px">Лист ${i + 1}: ${safeName}</div>
          <img src="${safeUrl}?key=${encodeURIComponent(App.apiKey)}" alt="${safeName}"
               style="max-width:100%;border:1px solid #e0e0e0;border-radius:6px"
               onerror="this.outerHTML='<div class=\\'empty-state\\'>Файл не найден на диске</div>'">
        </div>`;
      }).join('');
      this._photosLoaded = true;
    } catch (e) {
      container.innerHTML = '<div class="empty-state">Ошибка загрузки фото</div>';
    }
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
    // Find the row in the current table so we can read the item's scan name
    // and current quantity for the pack-size prompt. If the row isn't there
    // (edge case — table re-rendered), skip the prompt gracefully.
    let packOverride = null;
    try {
      const row = document.querySelector(`#invoice-items-tbody tr[data-item-id="${itemId}"]`);
      if (row) {
        const scanNameCell = row.querySelector('td:nth-child(2)');
        const scanName = scanNameCell ? scanNameCell.textContent.trim() : '';
        const detected = this.detectPackKg(scanName);
        if (detected) {
          // Read the current quantity from the 4th <td>. If it's a number > 0
          // we can show "1 × 50 = 50 кг" in the prompt. Otherwise fall back to
          // a generic "apply 50 kg per unit?" message.
          const qtyCell = row.querySelector('td:nth-child(4)');
          const qtyText = qtyCell ? qtyCell.textContent.replace(',', '.').replace(/\s/g, '') : '';
          const currentQty = parseFloat(qtyText);
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
