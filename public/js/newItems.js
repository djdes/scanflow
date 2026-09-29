/* global App, OnecCatalog, NewItems */
// «Новые товары» (пакет v2, п.12). Строки неотправленных накладных без позиции
// 1С, сгруппированные по товару (ключ названия: регистр, порядок слов, «1/12»,
// скобки не важны). По группе — одно решение сразу на все строки:
//   • «Сопоставить с позицией 1С» — строки получают позицию, все написания
//     становятся подтверждёнными правилами (следующие накладные — сами);
//   • «Создать в 1С» — название, единица и группа новой позиции; модуль 1С
//     получит их в выгрузке (new_item) и создаст позицию как надо, а не «в кг».
// Разметка строится из данных сервера только через App.esc; обработчики —
// делегированные, по data-action и индексу группы (без строк в onclick).
const NewItems = {
  UNITS: ['шт', 'кг', 'л', 'упак'],
  UNIT_CLASS: { 'шт': 'count', 'упак': 'count', 'кг': 'mass', 'л': 'volume' },

  groups: [],
  waiting: [],
  filterText: '',
  open: null,        // { key, mode: 'map' | 'create' }
  picked: null,      // «Сопоставить»: выбранная позиция 1С { guid, name, unit }
  parentFrom: null,  // «Создать»: группа как у позиции { name|null, parent_guid }
  draft: null,       // «Создать»: черновик формы { name, unit }
  _bound: false,

  async load() {
    this._bind();
    const list = document.getElementById('new-items-list');
    if (!list) return;
    if (!this.groups.length) list.innerHTML = '<div class="card"><div class="empty-state"><div>Загрузка…</div></div></div>';
    await OnecCatalog.load();
    try {
      const body = await App.apiJson('/new-items');
      this.groups = Array.isArray(body.data) ? body.data : [];
      this.waiting = Array.isArray(body.waiting) ? body.waiting : [];
    } catch (e) {
      list.innerHTML = `<div class="card">Не удалось загрузить список: ${App.esc(e.message)}</div>`;
      return;
    }
    // Открытая форма остаётся, если её группа ещё есть.
    if (this.open && !this.groups.some(g => g.name_key === this.open.key)) this._resetForm();
    this.renderList();
  },

  // ─── Отрисовка ─────────────────────────────────────────────────────────────

  renderList() {
    const list = document.getElementById('new-items-list');
    if (!list) return;
    const summary = document.getElementById('new-items-summary');
    const search = document.getElementById('new-items-search');
    const totalLines = this.groups.reduce((s, g) => s + (g.lines || 0), 0);
    if (summary) {
      summary.innerHTML = this.groups.length
        ? `Товаров: <strong>${this.groups.length}</strong> · строк: <strong>${totalLines}</strong>`
        : '';
    }
    if (search) search.style.display = this.groups.length ? '' : 'none';

    const q = this.filterText.trim().toLowerCase();
    const rows = [];
    this.groups.forEach((g, i) => {
      if (q && !this._matches(g, q)) return;
      rows.push(this.rowHtml(g, i));
    });

    if (!this.groups.length) {
      list.innerHTML = `<div class="card"><div class="empty-state">
        <div class="empty-icon">&#9989;</div>
        <div>Все строки неотправленных накладных сопоставлены с позициями 1С.</div>
      </div></div>`;
    } else if (!rows.length) {
      list.innerHTML = '<div class="card"><div class="empty-state"><div>Ничего не найдено</div></div></div>';
    } else {
      list.innerHTML = `<div class="table-wrap ni-table-wrap">
        <table class="cards-mobile ni-table">
          <thead><tr>
            <th>Товар из накладных</th>
            <th>Строк / накл.</th>
            <th>Ед.</th>
            <th>Поставщики</th>
            <th>Статус</th>
            <th></th>
          </tr></thead>
          <tbody>${rows.join('')}</tbody>
        </table>
      </div>`;
    }
    this.renderWaiting();
  },

  _matches(g, q) {
    return (g.names || []).some(n => String(n).toLowerCase().includes(q))
      || (g.suppliers || []).some(s => String(s).toLowerCase().includes(q))
      || String(g.suggested_name || '').toLowerCase().includes(q);
  },

  rowHtml(g, i) {
    const esc = (s) => App.esc(s);
    const isOpen = !!(this.open && this.open.key === g.name_key);
    const variants = (g.names || []).filter(n => n !== g.sample_name);
    const nameCell = `<div class="ni-cell">
        <div class="ni-name">${esc(g.sample_name)}</div>
        ${variants.length ? `<div class="ni-sub" title="Другие написания">${variants.map(esc).join(' · ')}</div>` : ''}
      </div>`;
    const priceLine = g.last_price != null
      ? `<div class="ni-sub ni-price">${App.formatMoney(g.last_price)} ₽${g.last_price_unit ? '/' + esc(g.last_price_unit) : ''}</div>`
      : '';
    const extraSuppliers = (g.supplier_count || 0) - (g.suppliers || []).length;
    const suppliers = (g.suppliers || []).length
      ? `<div class="ni-cell">${g.suppliers.map(esc).join(', ')}${extraSuppliers > 0 ? ` <span class="ni-sub">+${extraSuppliers}</span>` : ''}</div>`
      : '—';
    const req = g.request;
    const createLabel = req && req.status === 'pending' ? 'Изменить заявку' : 'Создать в 1С';
    return `
      <tr class="ni-row${isOpen ? ' is-open' : ''}">
        <td data-label="Товар">${nameCell}</td>
        <td data-label="Строк / накладных"><span class="ni-cell"><strong>${Number(g.lines) || 0}</strong> / ${(g.invoices || []).length}</span></td>
        <td data-label="Ед."><div class="ni-cell">${esc(g.unit || '—')}${priceLine}</div></td>
        <td data-label="Поставщики">${suppliers}</td>
        <td data-label="Статус">${this.statusHtml(g)}</td>
        <td class="cell-action">
          <div class="ni-actions">
            <button type="button" class="btn btn-sm btn-outline" data-action="open-map" data-i="${i}">Сопоставить с позицией 1С</button>
            <button type="button" class="btn btn-sm btn-soft" data-action="open-create" data-i="${i}">${createLabel}</button>
          </div>
        </td>
      </tr>${isOpen ? `<tr class="ni-form-row"><td colspan="6">${this.open.mode === 'map' ? this.mapFormHtml(g, i) : this.createFormHtml(g, i)}</td></tr>` : ''}`;
  },

  statusHtml(g) {
    const esc = (s) => App.esc(s);
    const r = g.request;
    if (!r) return '<span class="badge badge-new">Нет в 1С</span>';
    if (r.status === 'created') {
      return `<div class="ni-cell"><span class="badge badge-sent">Создана в 1С</span>
        <div class="ni-sub">Сопоставьте строки с новой позицией</div></div>`;
    }
    const late = g.lines_without_request_name > 0
      ? `<div class="ni-warn-text">${Number(g.lines_without_request_name)} стр. пришли позже и уйдут в 1С под своим названием — «Изменить заявку» → «Создать в 1С» даст им название из заявки</div>`
      : '';
    return `<div class="ni-cell"><span class="badge badge-processing">Ждёт создания в 1С</span>
      <div class="ni-sub">«${esc(r.name)}», ${esc(r.unit)}</div>${late}
      <button type="button" class="link-btn" data-action="cancel-request" data-id="${Number(r.id)}">Отменить заявку</button></div>`;
  },

  mapFormHtml(g, i) {
    const esc = (s) => App.esc(s);
    const p = this.picked;
    const empty = !OnecCatalog.items.length;
    return `<div class="ni-form">
      <div class="ni-form-title">Сопоставить ${Number(g.lines)} стр. «${esc(g.sample_name)}» с позицией справочника 1С</div>
      ${empty ? '<div class="ni-warning">Справочник 1С ещё не выгружен — выбрать не из чего. Выгрузите номенклатуру из 1С или создайте позицию.</div>' : ''}
      <div class="nom-picker ni-picker">
        <input type="text" class="nom-picker-input" data-search="map" value="${esc(p ? p.name : '')}"
               placeholder="Начните вводить название позиции 1С…" autocomplete="off" aria-label="Позиция 1С">
        <div class="nom-picker-dropdown"></div>
      </div>
      ${p ? `<div class="ni-picked">Выбрано: <strong>${esc(p.name)}</strong>${p.unit ? ` · ${esc(p.unit)}` : ''}</div>` : ''}
      <div class="field-hint">Все написания товара станут подтверждёнными правилами — следующие накладные сопоставятся сами.</div>
      <div class="ni-form-actions">
        <button type="button" class="btn btn-primary btn-sm" data-action="submit-map" data-i="${i}"${p ? '' : ' disabled'}>Сопоставить ${Number(g.lines)} стр.</button>
        <button type="button" class="btn btn-outline btn-sm" data-action="close">Отмена</button>
      </div>
    </div>`;
  },

  createFormHtml(g, i) {
    const esc = (s) => App.esc(s);
    const d = this.draft || { name: g.suggested_name, unit: g.suggested_unit };
    const pf = this.parentFrom;
    const parentLine = pf
      ? `<div class="ni-picked">${pf.name ? `Как у «${esc(pf.name)}»` : 'Группа из заявки'}
           <button type="button" class="link-btn" data-action="clear-parent">убрать</button></div>`
      : '';
    return `<div class="ni-form">
      <div class="ni-form-title">Новая позиция в 1С для ${Number(g.lines)} стр. «${esc(g.sample_name)}»</div>
      <div class="ni-form-grid">
        <div class="form-group">
          <label for="ni-name">Название в 1С</label>
          <input type="text" id="ni-name" data-draft="name" maxlength="150" value="${esc(d.name)}" autocomplete="off">
        </div>
        <div class="form-group">
          <label for="ni-unit">Единица</label>
          <select id="ni-unit" data-draft="unit">
            ${this.UNITS.map(u => `<option value="${u}"${u === d.unit ? ' selected' : ''}>${u}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-group">
        <label>Группа в 1С <span class="ni-sub">(необязательно)</span></label>
        ${parentLine}
        <div class="nom-picker ni-picker">
          <input type="text" class="nom-picker-input" data-search="parent"
                 placeholder="Позиция, в чьей группе создать…" autocomplete="off" aria-label="Группа как у позиции">
          <div class="nom-picker-dropdown"></div>
        </div>
      </div>
      <div class="ni-unit-hint">${this.unitHintHtml(g, d.unit)}</div>
      <div class="field-hint">1С создаст позицию при загрузке накладной. Когда позиция появится в справочнике, неотправленные строки сопоставятся с ней сами.</div>
      <div class="ni-form-actions">
        <button type="button" class="btn btn-primary btn-sm" data-action="submit-create" data-i="${i}">Создать в 1С</button>
        <button type="button" class="btn btn-outline btn-sm" data-action="close">Отмена</button>
      </div>
    </div>`;
  },

  // Единица позиции другого класса, чем в накладных («шт» → «кг»): пока
  // позиции нет в справочнике, строки уйдут в 1С в единице накладной.
  unitHintHtml(g, unit) {
    const lineCls = g.unit_class;
    const cls = this.UNIT_CLASS[unit];
    if (!lineCls || !cls || lineCls === cls) return '';
    return `<div class="ni-warning">В накладных — «${App.esc(g.unit)}», новая позиция — в «${App.esc(unit)}». Пока позиции нет в справочнике 1С, строки уйдут в 1С в «${App.esc(g.unit)}».</div>`;
  },

  renderWaiting() {
    const host = document.getElementById('new-items-waiting');
    if (!host) return;
    if (!this.waiting.length) { host.innerHTML = ''; return; }
    const esc = (s) => App.esc(s);
    host.innerHTML = `<div class="card ni-waiting">
      <h3>Ждут появления в справочнике 1С</h3>
      <div class="field-hint">Строк без позиции по этим заявкам на странице уже нет (отправлены в 1С или сопоставлены). Когда 1С выгрузит справочник с позицией, заявка закроется сама.</div>
      <ul class="ni-waiting-list">
        ${this.waiting.map(r => `<li>
          <span>«${esc(r.name)}», ${esc(r.unit)}</span>
          <button type="button" class="link-btn" data-action="cancel-request" data-id="${Number(r.id)}">Отменить</button>
        </li>`).join('')}
      </ul>
    </div>`;
  },

  // ─── Действия ──────────────────────────────────────────────────────────────

  openForm(i, mode) {
    const g = this.groups[i];
    if (!g) return;
    if (this.open && this.open.key === g.name_key && this.open.mode === mode) {
      this.closeForm();
      return;
    }
    this._resetForm();
    this.open = { key: g.name_key, mode };
    const r = g.request;
    if (mode === 'map' && r && r.status === 'created' && r.onec_guid) {
      // Позиция по заявке уже в справочнике — предлагаем именно её.
      const it = OnecCatalog.getByGuid(r.onec_guid);
      if (it) this.picked = { guid: it.guid, name: it.name, unit: it.unit || null };
    }
    if (mode === 'create') {
      this.draft = { name: g.suggested_name || '', unit: g.suggested_unit || 'шт' };
      if (r && r.status === 'pending' && r.parent_guid) {
        const sibling = OnecCatalog.items.find(it => it.parent_guid === r.parent_guid);
        this.parentFrom = { name: sibling ? sibling.name : null, parent_guid: r.parent_guid };
      }
    }
    this.renderList();
    const focusSel = mode === 'map' ? '[data-search="map"]' : '#ni-name';
    const el = document.querySelector(`#new-items-list ${focusSel}`);
    if (el) el.focus();
  },

  _resetForm() {
    this.open = null;
    this.picked = null;
    this.parentFrom = null;
    this.draft = null;
  },

  closeForm(rerender = true) {
    this._resetForm();
    if (rerender) this.renderList();
  },

  onSearch(input) {
    const kind = input.dataset.search;
    const dd = input.parentElement && input.parentElement.querySelector('.nom-picker-dropdown');
    if (!dd) return;
    if (kind === 'map' && this.picked && input.value !== this.picked.name) {
      // Текст поменяли после выбора — прежний выбор больше не действует.
      this.picked = null;
      const form = input.closest('.ni-form');
      const btn = form && form.querySelector('[data-action="submit-map"]');
      if (btn) btn.disabled = true;
      const pickedEl = form && form.querySelector('.ni-picked');
      if (pickedEl) pickedEl.remove();
    }
    const q = input.value.trim();
    if (!q) { dd.style.display = 'none'; return; }
    const esc = (s) => App.esc(s);
    const results = OnecCatalog.search(q, 10);
    dd.innerHTML = results.length
      ? results.map(r => {
        const item = kind === 'parent' ? OnecCatalog.getByGuid(r.guid) : null;
        const tail = kind === 'parent'
          ? (item && item.parent_guid ? '' : '<span class="nom-unit">без группы</span>')
          : (r.unit ? `<span class="nom-unit">${esc(r.unit)}</span>` : '');
        return `<div class="nom-picker-option" data-action="pick" data-kind="${kind === 'parent' ? 'parent' : 'map'}" data-guid="${esc(r.guid)}">
          <strong>${esc(r.name)}</strong>${tail}
        </div>`;
      }).join('')
      : '<div class="nom-picker-option ni-none">Ничего не найдено</div>';
    dd.style.display = 'block';
  },

  pick(kind, guid) {
    const item = OnecCatalog.getByGuid(guid);
    if (!item) return;
    if (kind === 'parent') {
      if (!item.parent_guid) {
        App.notify(`У «${item.name}» в 1С нет группы — выберите другую позицию`, 'error');
        return;
      }
      this.parentFrom = { name: item.name, parent_guid: item.parent_guid };
    } else {
      this.picked = { guid: item.guid, name: item.name, unit: item.unit || null };
    }
    this.renderList();
  },

  onDraft(el) {
    if (!this.draft) this.draft = { name: '', unit: 'шт' };
    this.draft[el.dataset.draft] = el.value;
    if (el.dataset.draft === 'unit') {
      const g = this.open && this.groups.find(x => x.name_key === this.open.key);
      const hint = el.closest('.ni-form') && el.closest('.ni-form').querySelector('.ni-unit-hint');
      if (g && hint) hint.innerHTML = this.unitHintHtml(g, el.value);
    }
  },

  async _mapGroup(g, guid) {
    const { data } = await App.apiJson('/new-items/map', {
      method: 'POST',
      body: { name_key: g.name_key, onec_guid: guid },
    });
    App.notify(`Сопоставлено с «${data.name}»: ${data.lines} стр. в ${data.invoices} накл.`, 'success');
    this.closeForm(false);
    await this.load();
  },

  async submitMap(i, btn) {
    const g = this.groups[i];
    const p = this.picked;
    if (!g || !p) return;
    await App.withBusyButton(btn, async () => {
      try {
        await this._mapGroup(g, p.guid);
      } catch (e) {
        App.notify(e.message || 'Не удалось сопоставить', 'error');
        if (e.status === 404) await this.load();
      }
    });
  },

  async submitCreate(i, btn) {
    const g = this.groups[i];
    if (!g) return;
    const d = this.draft || { name: g.suggested_name, unit: g.suggested_unit };
    const name = String(d.name || '').replace(/\s+/g, ' ').trim();
    if (!name) { App.notify('Укажите название позиции', 'error'); return; }
    const body = {
      name_key: g.name_key,
      name,
      unit: d.unit || g.suggested_unit,
      parent_guid: this.parentFrom ? this.parentFrom.parent_guid : null,
    };
    await App.withBusyButton(btn, async () => {
      try {
        const { data } = await App.apiJson('/new-items/create', { method: 'POST', body });
        App.notify(`1С создаст «${data.request.name}» (${data.request.unit}) — ${data.lines} стр. получили это название`, 'success');
        this.closeForm(false);
        await this.load();
      } catch (e) {
        const ex = e.status === 409 && e.body && e.body.existing;
        if (ex) {
          const msg = `В справочнике 1С уже есть «${ex.name}»${ex.unit ? ` (${ex.unit})` : ''} — вторую позицию с таким названием 1С не создаст.\n\nСопоставить ${g.lines} стр. с ней?`;
          if (window.confirm(msg)) {
            try { await this._mapGroup(g, ex.guid); } catch (e2) { App.notify(e2.message || 'Не удалось сопоставить', 'error'); }
          }
          return;
        }
        App.notify(e.message || 'Не удалось сохранить заявку', 'error');
        if (e.status === 404) await this.load();
      }
    });
  },

  async cancelRequest(id, btn) {
    if (!Number.isInteger(id) || id <= 0) return;
    if (!window.confirm('Отменить заявку «Создать в 1С»?\n\nНазвание строк останется, но 1С создаст позицию с единицей по умолчанию (кг) и без группы.')) return;
    await App.withBusyButton(btn, async () => {
      try {
        await App.apiJson(`/new-items/${id}`, { method: 'DELETE' });
        App.notify('Заявка отменена', 'success');
        await this.load();
      } catch (e) {
        App.notify(e.message || 'Не удалось отменить', 'error');
        await this.load();
      }
    });
  },

  // Один раз на страницу: делегированные обработчики на секции.
  _bind() {
    if (this._bound) return;
    const view = document.getElementById('view-new-items');
    if (!view) return;
    this._bound = true;

    view.addEventListener('click', (e) => {
      const el = e.target.closest('[data-action]');
      if (!el || !view.contains(el)) return;
      const i = Number(el.dataset.i);
      switch (el.dataset.action) {
        case 'open-map': this.openForm(i, 'map'); break;
        case 'open-create': this.openForm(i, 'create'); break;
        case 'close': this.closeForm(); break;
        case 'pick': this.pick(el.dataset.kind, el.dataset.guid); break;
        case 'clear-parent': this.parentFrom = null; this.renderList(); break;
        case 'submit-map': this.submitMap(i, el); break;
        case 'submit-create': this.submitCreate(i, el); break;
        case 'cancel-request': this.cancelRequest(Number(el.dataset.id), el); break;
        default: break;
      }
    });
    // Клик по варианту не должен уводить фокус из поля раньше, чем сработает click.
    view.addEventListener('mousedown', (e) => {
      if (e.target.closest('.nom-picker-option')) e.preventDefault();
    });
    view.addEventListener('input', (e) => {
      const t = e.target;
      if (t.matches('[data-search]')) this.onSearch(t);
      else if (t.matches('[data-draft]')) this.onDraft(t);
      else if (t.id === 'new-items-search') { this.filterText = t.value; this.renderList(); }
    });
    view.addEventListener('change', (e) => {
      if (e.target.matches('select[data-draft]')) this.onDraft(e.target);
    });
    view.addEventListener('focusin', (e) => {
      if (e.target.matches('[data-search]') && e.target.value.trim()) this.onSearch(e.target);
    });
    view.addEventListener('focusout', (e) => {
      if (!e.target.matches('[data-search]')) return;
      const dd = e.target.parentElement && e.target.parentElement.querySelector('.nom-picker-dropdown');
      setTimeout(() => { if (dd) dd.style.display = 'none'; }, 150);
    });
    view.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.open && e.target.id !== 'new-items-search') this.closeForm();
    });
  },
};
