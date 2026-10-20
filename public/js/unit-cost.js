/* global App, Invoices */
const UnitCost = {
  units: { piece: ['шт.', 'шт.'], label: ['этикетка', 'этикетку'], sheet: ['лист', 'лист'], pair: ['пара', 'пару'] },
  number(value, money = false) {
    const precision = money && value > 0 && value < 1e-8 ? Math.min(20, Math.ceil(-Math.log10(value)) + 3) : 8;
    return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: precision, minimumFractionDigits: money ? 2 : 0 }).format(value);
  },
  price(calculation) { return `${this.number(calculation.unit_price, true)} ₽ за 1 ${this.units[calculation.unit_kind]?.[1] || 'шт.'}`; },
  countUnit(kind, value) {
    const forms = { label: ['этикетка', 'этикетки', 'этикеток'], sheet: ['лист', 'листа', 'листов'], pair: ['пара', 'пары', 'пар'] }[kind];
    const category = new Intl.PluralRules('ru-RU').select(value);
    return forms ? forms[category === 'one' ? 0 : category === 'few' || category === 'other' ? 1 : 2] : 'шт.';
  },
  formula(calculation) {
    return `${this.number(calculation.packages)} × ${this.number(calculation.units_per_pack)} = ${this.number(calculation.total_units)} ${this.countUnit(calculation.unit_kind, calculation.total_units)}; ${this.number(calculation.total, true)} ₽ ÷ ${this.number(calculation.total_units)} = ${this.number(calculation.unit_price, true)} ₽`;
  },
  rowHtml(invoiceId, item) {
    const state = item.unit_cost;
    if (!state?.basis) return '';
    const calculation = state.calculation;
    return `<div class="unit-cost-row">${calculation ? `<strong>${App.esc(this.price(calculation))}</strong><span>${App.esc(this.formula(calculation))}</span>` : ''}<button type="button" class="unit-cost-open" onclick="UnitCost.open(${invoiceId}, ${item.id})">${calculation ? state.rule_id ? 'Сохранённая формула' : 'Проверить и запомнить формулу' : 'Рассчитать цену за единицу'}</button></div>`;
  },
  stopFeed() { clearTimeout(this._feedTimer); this._feedRun = (this._feedRun || 0) + 1; },
  isHome() { return ['#/invoices', '#/', ''].includes(location.hash.split('?')[0]); },
  async loadFeed(more = false) {
    const host = document.getElementById('unit-cost-alerts');
    if (!host || !this.isHome()) return;
    clearTimeout(this._feedTimer);
    const run = this._feedRun = (this._feedRun || 0) + 1;
    try {
      const result = await App.apiJson('/unit-cost/suggestions' + (more && this._cursor ? `?cursor=${this._cursor}` : ''));
      if (run !== this._feedRun || !this.isHome()) return;
      this._feed = more ? [...(this._feed || []), ...result.data] : result.data;
      this._cursor = result.next_cursor;
      this._visible = more ? (this._visible || 3) + 3 : 3;
      this.renderFeed();
    } catch (error) {
      if (run !== this._feedRun || !this.isHome()) return;
      host.hidden = false;
      host.innerHTML = '<p class="unit-cost-feed-error">Не удалось загрузить расчёты цены за единицу. <button type="button" class="btn btn-outline btn-sm" onclick="UnitCost.loadFeed()">Повторить</button></p>';
    } finally {
      if (run === this._feedRun && this.isHome()) this._feedTimer = setTimeout(() => {
        if (!document.hidden) this.loadFeed(); else this.loadFeedWhenVisible();
      }, 60000);
    }
  },
  loadFeedWhenVisible() {
    this._feedTimer = setTimeout(() => { if (this.isHome()) this.loadFeed(); }, 60000);
  },
  renderFeed() {
    const host = document.getElementById('unit-cost-alerts');
    if (!host) return;
    const rows = this._feed || [];
    host.hidden = rows.length === 0;
    if (!rows.length) { host.innerHTML = ''; return; }
    host.innerHTML = `<div class="unit-cost-feed-heading"><strong>Рассчитана цена за единицу</strong><span>Проверьте формулу и сохраните её для следующих поставок</span></div><div class="unit-cost-feed-list">${rows.slice(0, this._visible || 3).map(row => `<article class="unit-cost-alert"><div><a class="unit-cost-position" href="#/invoices/${row.invoice_id}?item=${row.item_id}">${App.esc(row.original_name)}</a><p>${App.esc(row.supplier || 'Поставщик не указан')} · Накладная № ${App.esc(row.invoice_number || row.invoice_id)}</p><strong>${App.esc(this.price(row.calculation))}</strong><p class="unit-cost-equation">${App.esc(this.formula(row.calculation))}</p>${row.rule_id ? '<small>Рассчитано по сохранённой формуле</small>' : '<small>Предложение по названию — требуется ваше подтверждение</small>'}</div><div class="unit-cost-alert-actions"><button type="button" class="btn btn-outline btn-sm" data-cost-edit="${row.item_id}">${row.rule_id ? 'Проверить формулу' : 'Проверить и запомнить'}</button><button type="button" class="unit-cost-dismiss" data-cost-dismiss="${row.item_id}" aria-label="Скрыть этот расчёт с главной">Скрыть</button></div></article>`).join('')}</div>${rows.length > this._visible || this._cursor ? '<button type="button" class="btn btn-outline btn-sm" data-cost-more>Ещё расчёты</button>' : ''}<p class="unit-cost-feed-action-error" role="alert" hidden></p>`;
    host.querySelectorAll('[data-cost-edit]').forEach(button => { button.onclick = () => {
      const row = rows.find(item => item.item_id === Number(button.dataset.costEdit));
      if (row) this.open(row.invoice_id, row.item_id);
    }; });
    host.querySelectorAll('[data-cost-dismiss]').forEach(button => { button.onclick = async () => {
      const row = rows.find(item => item.item_id === Number(button.dataset.costDismiss));
      if (!row) return;
      button.disabled = true;
      try {
        await App.apiJson(this.endpoint(row.invoice_id, row.item_id, 'dismiss'), { method: 'POST', body: { expected: row.expected } });
        this._feed = this._feed.filter(item => item.item_id !== row.item_id);
        this.renderFeed();
      } catch (error) {
        const target = host.querySelector('.unit-cost-feed-action-error');
        if (target) { target.textContent = error.message; target.hidden = false; }
      } finally { button.disabled = false; }
    }; });
    const more = host.querySelector('[data-cost-more]');
    if (more) more.onclick = () => {
      if (rows.length > this._visible) { this._visible += 3; this.renderFeed(); }
      else { more.disabled = true; this.loadFeed(true); }
    };
  },
  endpoint(invoice, item, action) { return `/unit-cost/invoices/${invoice}/items/${item}/${action}`; },
  async open(invoiceId, itemId) {
    invoiceId = Number(invoiceId); itemId = Number(itemId);
    if (![invoiceId, itemId].every(id => Number.isSafeInteger(id) && id > 0)) return;
    const returnFocus = document.activeElement;
    let invoice;
    try { invoice = (await App.apiJson(`/invoices/${invoiceId}`)).data; }
    catch (error) { App.notify(error.message, 'error'); return; }
    const item = invoice.items?.find(row => row.id === itemId);
    let state = item?.unit_cost;
    if (!state?.basis) { App.notify('Для расчёта нужны количество упаковок, единица и сумма строки', 'error'); return; }
    document.getElementById('unit-cost-dialog')?.close();
    const dialog = document.createElement('dialog');
    dialog.id = 'unit-cost-dialog';
    dialog.className = 'unit-cost-dialog';
    dialog.setAttribute('aria-labelledby', 'unit-cost-title');
    dialog.innerHTML = `<div class="unit-cost-dialog-heading"><h2 id="unit-cost-title">Цена за единицу</h2><button type="button" class="unit-cost-close" aria-label="Закрыть расчёт">×</button></div><p class="unit-cost-product">${App.esc(item.original_name)}</p><p class="unit-cost-scope">${App.esc(invoice.supplier || 'Поставщик не указан')} · Накладная № ${App.esc(invoice.invoice_number || invoice.id)}</p><div class="unit-cost-inputs"><label>Единиц в одной упаковке<input id="cost-pack-size" type="number" inputmode="numeric" min="1" max="1000000000" step="1" value="${state.calculation?.units_per_pack || ''}" placeholder="Например, 2000"></label><label>Что считаем<select id="cost-unit">${Object.entries(this.units).map(([key, value]) => `<option value="${key}">${App.esc(value[0])}</option>`).join('')}</select></label></div><button type="button" class="btn btn-outline" data-cost-calculate>Рассчитать</button><div class="unit-cost-result" aria-live="polite"></div><p class="unit-cost-explanation">Формула: количество упаковок × единиц в упаковке. Цена единицы = сумма строки ÷ полученное количество. Сумма учитывает НДС так же, как в строке накладной.</p><p class="unit-cost-saved-note"></p><p class="unit-cost-preserve">Это расчёт расходной единицы. В накладной и при отправке в 1С сохраняются учётные количество, цена и сумма.</p><p class="unit-cost-error" role="alert" hidden></p><div class="unit-cost-dialog-actions"><button type="button" class="btn btn-outline" data-cost-forget>Забыть формулу</button><button type="button" class="btn btn-primary" data-cost-remember>Запомнить для этого товара</button></div>`;
    document.body.appendChild(dialog);
    const count = dialog.querySelector('#cost-pack-size'), unit = dialog.querySelector('#cost-unit');
    const calculate = dialog.querySelector('[data-cost-calculate]'), remember = dialog.querySelector('[data-cost-remember]'), forget = dialog.querySelector('[data-cost-forget]');
    const error = dialog.querySelector('.unit-cost-error'), result = dialog.querySelector('.unit-cost-result'), close = dialog.querySelector('.unit-cost-close');
    unit.value = state.calculation?.unit_kind || (/этикет/i.test(item.original_name) ? 'label' : 'piece');
    let busy = false;
    const inputs = () => ({ units_per_pack: count.value === '' ? null : Number(count.value), unit_kind: unit.value });
    const valid = () => Number.isSafeInteger(inputs().units_per_pack) && inputs().units_per_pack >= 1 && inputs().units_per_pack <= 1e9;
    const dirty = () => !state.calculation || inputs().units_per_pack !== state.calculation.units_per_pack || unit.value !== state.calculation.unit_kind;
    const sync = () => {
      count.disabled = unit.disabled = close.disabled = busy;
      calculate.disabled = busy || !valid();
      remember.disabled = busy || !valid() || dirty() || !state.can_remember;
      forget.disabled = busy;
      forget.hidden = !state.rule_id;
      remember.textContent = state.rule_id ? 'Сохранить формулу для товара' : 'Запомнить для этого товара';
    };
    const render = () => {
      const calculation = state.calculation;
      result.innerHTML = calculation ? `<strong>${App.esc(this.price(calculation))}</strong><p>${App.esc(this.formula(calculation))}</p>${calculation.evidence ? `<small>Из названия: ${App.esc(calculation.evidence)}</small>` : ''}` : '<p>Укажите, сколько единиц находится в одной упаковке, и нажмите «Рассчитать».</p>';
      dialog.querySelector('.unit-cost-product').textContent = state.original_name || item.original_name;
      dialog.querySelector('.unit-cost-saved-note').textContent = !state.can_remember ? 'Чтобы запомнить формулу, укажите поставщика в накладной.' : state.rule_id ? 'Формула уже сохранена для этого наименования и поставщика. Количество и сумма берутся из каждой новой накладной.' : 'После подтверждения формула будет применяться к этому наименованию у этого поставщика. Другой размер упаковки требует отдельного подтверждения.';
      sync();
    };
    const act = async action => {
      if (busy) return;
      busy = true; error.hidden = true; sync();
      try {
        const response = await App.apiJson(this.endpoint(invoiceId, itemId, action), { method: 'POST', body: { ...inputs(), expected: state.expected } });
        state = response.data;
        if (action === 'preview') render();
        else {
          dialog.close();
          App.notify(action === 'forget' ? 'Формула отключена для этого товара' : 'Формула сохранена для следующих поставок', 'success');
          if (location.hash.split('?')[0] === `#/invoices/${invoiceId}`) Invoices.showDetail(invoiceId);
          else if (this.isHome()) this.loadFeed();
        }
      } catch (cause) { error.textContent = cause.message || 'Не удалось сохранить формулу'; error.hidden = false; }
      finally { busy = false; sync(); }
    };
    const change = () => {
      error.hidden = true;
      if (dirty()) result.innerHTML = '<p>Параметры изменены. Нажмите «Рассчитать», чтобы проверить новую цену.</p>';
      else render();
      sync();
    };
    count.addEventListener('input', change); unit.addEventListener('change', change);
    count.addEventListener('keydown', event => { if (event.key === 'Enter' && valid()) { event.preventDefault(); act('preview'); } });
    calculate.onclick = () => act('preview'); remember.onclick = () => act('remember'); forget.onclick = () => act('forget');
    close.onclick = () => dialog.close();
    const onNavigate = () => { if (!busy) dialog.close(); };
    window.addEventListener('hashchange', onNavigate);
    dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    dialog.addEventListener('close', () => {
      window.removeEventListener('hashchange', onNavigate); dialog.remove();
      if (returnFocus?.isConnected) returnFocus.focus();
    }, { once: true });
    render(); dialog.showModal(); count.focus();
  },
  focusRequestedRow() {
    const id = Number(new URLSearchParams(location.hash.split('?')[1] || '').get('item'));
    if (!Number.isSafeInteger(id) || id <= 0) return;
    const row = document.querySelector(`#invoice-items-tbody tr[data-item-id="${id}"]`);
    if (!row) return;
    Invoices.switchTab('items');
    row.classList.add('unit-cost-highlight');
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    row.querySelector('.unit-cost-open')?.focus({ preventScroll: true });
  },
};
