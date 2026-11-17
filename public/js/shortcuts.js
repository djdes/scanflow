/* global App, Invoices */
// Горячие клавиши и общий поиск (2026-11-17).
//
// Список накладных: J/K или ↓/↑ — по строкам, Enter — открыть, X — отметить,
// A — «В 1С →» у готовой. Карточка: J/K — следующая/предыдущая, Esc — к списку.
// Везде: Ctrl+K (⌘K) — поиск по накладным, товарам с ценами и поставщикам; ? — подсказка.
const Shortcuts = {
  _row: -1,

  isEditing(target) {
    return target instanceof HTMLElement && (target.matches('input, textarea, select') || target.isContentEditable);
  },
  route() { return (window.location.hash || '#/invoices').split('?')[0]; },
  onList() { const h = this.route(); return h === '#/invoices' || h === '#/' || h === ''; },
  onCard() { return /^#\/invoices\/\d+$/.test(this.route()); },
  anyDialogOpen() { return !!document.querySelector('dialog[open]'); },

  rows() { return [...document.querySelectorAll('#invoices-tbody tr.clickable')]; },
  focusRow(index) {
    const rows = this.rows();
    if (!rows.length) return;
    this._row = Math.max(0, Math.min(rows.length - 1, index));
    rows.forEach((r, i) => r.classList.toggle('kb-focus', i === this._row));
    rows[this._row].scrollIntoView({ block: 'nearest' });
  },
  currentRow() { const rows = this.rows(); return this._row >= 0 ? rows[this._row] : null; },

  init() {
    document.addEventListener('keydown', (e) => this.onKey(e));
    // Перерисовка списка сбрасывает подсветку строки.
    const tbody = document.getElementById('invoices-tbody');
    if (tbody) new MutationObserver(() => { this._row = -1; }).observe(tbody, { childList: true });
  },

  onKey(e) {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'k' || e.key === 'K' || e.key === 'л' || e.key === 'Л')) {
      e.preventDefault();
      this.openSearch();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || this.isEditing(e.target) || this.anyDialogOpen()) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    // Русская раскладка: о/л = j/k, ч = x, ф = a.
    const k = { 'о': 'j', 'л': 'k', 'ч': 'x', 'ф': 'a' }[key] || key;
    if (k === '?' || (k === ',' && e.shiftKey)) { e.preventDefault(); this.openHelp(); return; }

    if (this.onList()) {
      if (k === 'j' || k === 'ArrowDown') { e.preventDefault(); this.focusRow(this._row + 1); }
      else if (k === 'k' || k === 'ArrowUp') { if (this._row < 0) return; e.preventDefault(); this.focusRow(this._row - 1); }
      else if (k === 'Enter') { const row = this.currentRow(); if (row) { e.preventDefault(); row.click(); } }
      else if (k === 'x') { const cb = this.currentRow()?.querySelector('.row-check'); if (cb) { e.preventDefault(); cb.click(); } }
      else if (k === 'a') { const btn = this.currentRow()?.querySelector('button.inv-act'); if (btn) { e.preventDefault(); btn.click(); } }
    } else if (this.onCard()) {
      const nav = [...document.querySelectorAll('#invoice-nav .inv-nav-btn')];
      const prev = nav.find(a => a.querySelector('.inv-nav-arrow')?.textContent === '←');
      const next = nav.find(a => a.querySelector('.inv-nav-arrow')?.textContent === '→');
      if (k === 'j' && next) { e.preventDefault(); next.click(); }
      else if (k === 'k' && prev) { e.preventDefault(); prev.click(); }
      else if (k === 'Escape' && !document.querySelector('.ic-menu, .info-tip__pop') && !document.getElementById('ic-layout')?.classList.contains('is-scan-open')) { App.navigate('#/invoices'); }
    }
  },

  // ── Подсказка по клавишам ───────────────────────────────────────────────
  openHelp() {
    let dlg = document.getElementById('shortcuts-help');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'shortcuts-help';
      dlg.className = 'shortcuts-dialog';
      const row = (keys, text) => `<div><span>${keys.map(k => `<kbd>${k}</kbd>`).join(' ')}</span><span>${text}</span></div>`;
      dlg.innerHTML = `<div class="shortcuts-head"><h2>Горячие клавиши</h2><button type="button" class="shortcuts-close" aria-label="Закрыть">×</button></div>
        <h3>Везде</h3>${row(['Ctrl', 'K'], 'поиск по накладным, товарам и поставщикам')}${row(['?'], 'эта подсказка')}
        <h3>Список накладных</h3>${row(['J', '↓'], 'следующая строка')}${row(['K', '↑'], 'предыдущая строка')}${row(['Enter'], 'открыть накладную')}${row(['X'], 'отметить строку')}${row(['A'], '«В 1С →» у готовой накладной')}${row(['/'], 'строка поиска')}
        <h3>Накладная</h3>${row(['J'], 'следующая накладная')}${row(['K'], 'предыдущая накладная')}${row(['Esc'], 'назад к списку')}`;
      document.body.appendChild(dlg);
      dlg.querySelector('.shortcuts-close').onclick = () => dlg.close();
      dlg.addEventListener('click', ev => { if (ev.target === dlg) dlg.close(); });
    }
    dlg.showModal();
  },

  // ── Общий поиск Ctrl+K ──────────────────────────────────────────────────
  openSearch() {
    let dlg = document.getElementById('global-search');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'global-search';
      dlg.className = 'global-search';
      dlg.setAttribute('aria-label', 'Поиск');
      dlg.innerHTML = `<div class="global-search__field"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input type="search" id="global-search-input" placeholder="Номер накладной, товар или поставщик" autocomplete="off" aria-label="Что найти"><kbd>Esc</kbd></div><div class="global-search__results" id="global-search-results" role="listbox"></div>`;
      document.body.appendChild(dlg);
      const input = dlg.querySelector('input');
      input.addEventListener('input', () => {
        clearTimeout(this._searchTimer);
        this._searchTimer = setTimeout(() => this.runSearch(input.value.trim()), 250);
      });
      input.addEventListener('keydown', ev => this.searchKey(ev));
      dlg.addEventListener('click', ev => { if (ev.target === dlg) dlg.close(); });
    }
    dlg.showModal();
    const input = dlg.querySelector('input');
    input.select();
    if (!input.value) this.renderResults(null);
  },

  async runSearch(q) {
    const run = this._run = (this._run || 0) + 1;
    if (q.length < 2) { this.renderResults(null); return; }
    const enc = encodeURIComponent(q);
    const safe = p => p.catch(() => null);
    const [inv, prices, sup] = await Promise.all([
      safe(App.apiJson(`/invoices?limit=6&offset=0&q=${enc}`)),
      safe(App.apiJson(`/analytics/prices?q=${enc}&days=365`)),
      safe(App.apiJson(`/suppliers?q=${enc}&limit=5`)),
    ]);
    if (run !== this._run) return;
    const groups = [];
    const invoices = inv?.data || [];
    if (invoices.length) groups.push({ title: 'Накладные', items: invoices.map(r => ({
      href: `#/invoices/${r.id}`,
      main: `№ ${r.invoice_number || 'без номера'} · ${r.supplier || 'поставщик не указан'}`,
      sub: `${App.formatDate(r.invoice_date)} · ${App.formatMoney(r.total_sum)} ₽`,
    })) });
    const items = (prices?.data?.items || []).slice(0, 6);
    if (items.length) groups.push({ title: 'Товары и цены', items: items.map(r => ({
      href: `#/analytics/prices/${encodeURIComponent(r.guid)}`,
      main: r.name,
      sub: `последняя цена ${App.formatMoney(r.last_price)} ₽${r.unit ? ` за ${r.unit}` : ''}${r.last_date ? ` · ${App.formatDate(r.last_date)}` : ''}`,
    })) });
    const suppliers = sup?.suppliers || [];
    if (suppliers.length) groups.push({ title: 'Поставщики', items: suppliers.map(r => ({
      supplier: r.name, main: r.name, sub: `ИНН ${r.inn} · накладные поставщика`,
    })) });
    this.renderResults(groups, q);
  },

  renderResults(groups, q) {
    const host = document.getElementById('global-search-results');
    if (!host) return;
    this._active = -1;
    if (groups == null) {
      host.innerHTML = '<p class="global-search__hint">Ищет по номеру и поставщику накладной, по товарам (последняя цена) и по справочнику поставщиков.</p>';
      return;
    }
    if (!groups.length) { host.innerHTML = `<p class="global-search__hint">По «${App.esc(q)}» ничего не нашлось</p>`; return; }
    host.innerHTML = groups.map(g => `<div class="global-search__group"><h3>${g.title}</h3>${g.items.map(it =>
      `<a class="global-search__item" role="option" href="${it.href || '#/invoices'}"${it.supplier ? ` data-supplier="${App.esc(it.supplier)}"` : ''}><strong>${App.esc(it.main)}</strong><small>${App.esc(it.sub)}</small></a>`).join('')}</div>`).join('');
    host.querySelectorAll('.global-search__item').forEach(a => a.addEventListener('click', ev => this.pick(a, ev)));
  },

  pick(a, ev) {
    const dlg = document.getElementById('global-search');
    if (a.dataset.supplier && typeof Invoices !== 'undefined') {
      ev?.preventDefault();
      Invoices.resetColumnFilters?.();
      Invoices.colFilters.supplier = a.dataset.supplier;
      const el = document.getElementById('filter-supplier');
      if (el) el.value = a.dataset.supplier;
      dlg?.close();
      if (this.onList()) { Invoices._syncFilterReset(); Invoices.loadTable(); } else App.navigate('#/invoices');
      return;
    }
    dlg?.close();
  },

  searchKey(ev) {
    // В поле type=search браузер на Esc только стирает текст и не закрывает окно.
    if (ev.key === 'Escape') { ev.preventDefault(); document.getElementById('global-search')?.close(); return; }
    const items = [...document.querySelectorAll('#global-search-results .global-search__item')];
    if (!items.length) return;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      this._active = ev.key === 'ArrowDown' ? Math.min(items.length - 1, this._active + 1) : Math.max(0, this._active - 1);
      items.forEach((a, i) => a.classList.toggle('is-active', i === this._active));
      items[this._active].scrollIntoView({ block: 'nearest' });
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const a = items[Math.max(0, this._active)];
      if (a.dataset.supplier) this.pick(a, ev); else { document.getElementById('global-search')?.close(); App.navigate(a.getAttribute('href')); }
    }
  },
};

if (typeof window !== 'undefined') {
  window.Shortcuts = Shortcuts;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => Shortcuts.init());
  else Shortcuts.init();
}
