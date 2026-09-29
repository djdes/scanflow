/* global App */
// Окно «Реквизиты поставщика». Два режима:
//  • справочник (suppliers.js) — просто форма карточки;
//  • отправка в Сбер (sber.js, opts.picker) — плюс выпадающий список всего
//    справочника, подсказки «похожие по названию» и предупреждение, если
//    реквизиты подобраны не по ИНН с фото. Выбранный поставщик закрепляется
//    за накладной на сервере (POST /invoices/:id/send-sber, supplier_overrides).
const SberModal = {
  _onSave: null,
  _opts: {},
  _suppliers: [],

  _FIELDS: [
    ['name', 'Название', true, ''],
    ['inn', 'ИНН', true, 'pattern="[0-9]{10}|[0-9]{12}" inputmode="numeric"'],
    ['kpp', 'КПП', false, 'pattern="[0-9]{9}" inputmode="numeric"'],
    ['bank_bic', 'БИК банка', true, 'pattern="[0-9]{9}" inputmode="numeric"'],
    ['bank_corr_account', 'Корсчёт банка', false, 'pattern="[0-9]{20}" inputmode="numeric"'],
    ['account', 'Расчётный счёт', false, 'pattern="[0-9]{20}" inputmode="numeric"'],
    ['bank_name', 'Название банка', false, ''],
    ['address', 'Адрес', false, ''],
  ],

  _ensureModal() {
    let modal = document.getElementById('sber-modal');
    if (modal) return modal;
    const wide = new Set(['name', 'account', 'bank_name', 'address']);
    const fieldsHtml = this._FIELDS.map(([name, label, required, attrs]) => `
      <label style="display:flex;flex-direction:column;gap:4px;margin:0;${wide.has(name) ? 'grid-column:1/-1' : ''}">
        <span style="font-size:12px;color:var(--text-secondary)">${label}${required ? '<span style="color:var(--error)"> *</span>' : ''}</span>
        <input type="text" name="${name}" ${required ? 'required' : ''} ${attrs} autocomplete="off">
      </label>`).join('');
    modal = document.createElement('div');
    modal.id = 'sber-modal';
    modal.className = 'modal-backdrop';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:none;align-items:center;justify-content:center;z-index:9999;padding:16px';
    modal.innerHTML = `
      <div class="modal-card card" style="max-width:620px;width:100%;max-height:90vh;overflow:auto;margin:0">
        <h3 style="margin-bottom:14px">Реквизиты поставщика</h3>
        <div id="sber-modal-notice"></div>
        <div id="sber-modal-picker" style="display:none;margin-bottom:16px;padding:12px;border:1px solid var(--border);border-radius:var(--radius)">
          <div style="font-size:13px;font-weight:600;margin-bottom:8px">Выбрать из справочника поставщиков</div>
          <input type="search" id="sber-modal-pick-q" placeholder="Поиск по названию или ИНН" autocomplete="off" style="margin-bottom:8px">
          <select id="sber-modal-pick"></select>
          <div style="font-size:12px;color:var(--text-tertiary);margin-top:6px">
            Реквизиты подставятся из карточки, а накладная будет закреплена за выбранным поставщиком.
          </div>
        </div>
        <form id="sber-modal-form" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">
          ${fieldsHtml}
          <div class="form-actions" style="grid-column:1/-1;display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
            <button type="button" class="btn btn-outline" id="sber-modal-dadata">Заполнить по ИНН (DaData)</button>
            <button type="button" class="btn btn-ghost" id="sber-modal-cancel" style="margin-left:auto">Отмена</button>
            <button type="submit" class="btn btn-primary">Сохранить и продолжить</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(modal);
    modal.querySelector('#sber-modal-cancel').onclick = () => SberModal.close();
    modal.querySelector('#sber-modal-dadata').onclick = () => SberModal.fillByInn();
    modal.querySelector('#sber-modal-form').onsubmit = (e) => SberModal.submit(e);
    modal.querySelector('#sber-modal-pick-q').oninput = () => SberModal._renderPicker();
    modal.querySelector('#sber-modal-pick').onchange = (e) => SberModal._pick(e.target.value);
    return modal;
  },

  /**
   * @param prefilled значения полей формы
   * @param onSave    async (data) => boolean — false оставляет окно открытым
   * @param opts      { picker, supplier_match: 'inn'|'name'|null, ocr: {inn,name}, candidates: [{inn,name,verified,score}] }
   */
  open(prefilled, onSave, opts = {}) {
    this._onSave = onSave;
    this._opts = opts || {};
    const modal = this._ensureModal();
    const form = modal.querySelector('#sber-modal-form');
    form.reset();
    this._fill(prefilled || {});

    const picker = modal.querySelector('#sber-modal-picker');
    modal.querySelector('#sber-modal-pick-q').value = '';
    this._suppliers = [];
    picker.style.display = this._opts.picker ? 'block' : 'none';
    this._renderNotice(null);
    if (this._opts.picker) {
      this._renderPicker();
      this._loadSuppliers();
    }
    modal.style.display = 'flex';
  },

  close() {
    const m = document.getElementById('sber-modal');
    if (m) m.style.display = 'none';
  },

  _fill(values) {
    const form = document.getElementById('sber-modal-form');
    for (const [k, v] of Object.entries(values)) {
      const inp = form.querySelector(`[name="${k}"]`);
      if (inp) inp.value = v == null ? '' : v;
    }
  },

  async _loadSuppliers() {
    try {
      const { suppliers } = await App.apiJson('/suppliers?limit=500');
      this._suppliers = (suppliers || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru'));
    } catch (e) {
      console.warn('[sber-modal] suppliers load failed', e);
      this._suppliers = [];
    }
    this._renderPicker();
  },

  _option(s, extra = '') {
    const mark = s.verified ? '' : ' (не подтверждён)';
    return `<option value="${App.esc(s.inn)}">${App.esc(s.name)} — ИНН ${App.esc(s.inn)}${mark}${extra}</option>`;
  },

  _renderPicker() {
    const sel = document.getElementById('sber-modal-pick');
    if (!sel) return;
    const q = document.getElementById('sber-modal-pick-q').value.trim().toLowerCase().replace(/ё/g, 'е');
    const matches = (s) => !q
      || String(s.name).toLowerCase().replace(/ё/g, 'е').includes(q)
      || String(s.inn).includes(q);
    const candidates = (this._opts.candidates || []).filter(matches);
    const candidateInns = new Set(candidates.map(c => c.inn));
    const all = this._suppliers.filter(s => !candidateInns.has(s.inn) && matches(s));

    let html = `<option value="">— не выбран (${this._suppliers.length ? `в справочнике ${this._suppliers.length}` : 'загрузка…'}) —</option>`;
    if (candidates.length) {
      html += `<optgroup label="Похожие по названию">${candidates.map(c => this._option(c, ` · сходство ${Math.round(c.score * 100)}%`)).join('')}</optgroup>`;
    }
    if (all.length) {
      html += `<optgroup label="Все поставщики">${all.map(s => this._option(s)).join('')}</optgroup>`;
    } else if (q && !candidates.length && this._suppliers.length) {
      html += '<option value="" disabled>Ничего не найдено</option>';
    }
    const prev = sel.value;
    sel.innerHTML = html;
    // Поиск перестраивает список — не теряем уже выбранного поставщика.
    if (prev && sel.querySelector(`option[value="${CSS.escape(prev)}"]`)) sel.value = prev;
  },

  async _pick(inn) {
    if (!inn) { this._renderNotice(null); return; }
    let s = this._suppliers.find(x => x.inn === inn);
    if (!s) {
      try { s = (await App.apiJson(`/suppliers/${encodeURIComponent(inn)}`)).supplier; } catch { s = null; }
    }
    if (!s) { App.notify('Не удалось загрузить карточку поставщика', 'error'); return; }
    const form = document.getElementById('sber-modal-form');
    form.reset();
    this._fill({
      inn: s.inn, name: s.name, kpp: s.kpp, bank_bic: s.bank_bic, account: s.account,
      bank_corr_account: s.bank_corr_account, bank_name: s.bank_name, address: s.address,
    });
    this._renderNotice(s);
  },

  // Предупреждение над формой: откуда взялись реквизиты и чем они отличаются
  // от того, что распознано на фото. picked — карточка, выбранная из списка.
  _renderNotice(picked) {
    const box = document.getElementById('sber-modal-notice');
    if (!box) return;
    const o = this._opts;
    if (!o.picker) { box.innerHTML = ''; return; }
    const ocr = o.ocr || {};
    const ocrInnText = ocr.inn ? `ИНН ${App.esc(ocr.inn)}` : 'ИНН не распознан';
    const ocrName = ocr.name ? `«${App.esc(ocr.name)}»` : 'без названия';
    const warn = (html) => `<div class="price-warning-banner"><span class="price-warning-banner__icon">⚠️</span><div>${html}</div></div>`;
    const info = (html) => `<div style="margin-bottom:14px;padding:10px 14px;border:1px solid var(--border);border-radius:var(--radius-lg);font-size:13.5px">${html}</div>`;

    if (picked) {
      const differs = ocr.inn && picked.inn !== ocr.inn;
      const text = `Выбран из справочника: <strong>${App.esc(picked.name)}</strong>, ИНН ${App.esc(picked.inn)}.`;
      box.innerHTML = differs
        ? warn(`${text}<br>ИНН отличается от ИНН на фото (${App.esc(ocr.inn)}) — накладная будет закреплена за выбранным поставщиком.`)
        : info(text);
      return;
    }
    if (o.supplier_match === 'name') {
      box.innerHTML = warn(
        `<strong>Реквизиты подобраны по названию, а не по ИНН.</strong><br>`
        + `На фото: ${ocrName}, ${ocrInnText} — в справочнике такого ИНН нет. `
        + `Проверьте, что это тот же поставщик, или выберите другого из списка ниже.`,
      );
    } else if (o.supplier_match === 'inn') {
      box.innerHTML = info('Карточка поставщика найдена в справочнике по ИНН, но ещё не подтверждена — проверьте реквизиты и сохраните.');
    } else {
      const similar = (o.candidates || []).length
        ? ' Похожие по названию стоят в списке первыми.'
        : '';
      box.innerHTML = warn(
        `<strong>Поставщик не найден в справочнике.</strong><br>`
        + `На фото: ${ocrName}, ${ocrInnText}. Выберите поставщика из списка ниже `
        + `или заполните реквизиты вручную — они сохранятся в справочник.${similar}`,
      );
    }
  },

  async fillByInn() {
    const form = document.getElementById('sber-modal-form');
    const inn = form.querySelector('[name="inn"]').value;
    if (!/^([0-9]{10}|[0-9]{12})$/.test(inn)) {
      App.notify('Сначала введите ИНН (10 или 12 цифр)', 'error');
      return;
    }
    const res = await App.api('/suppliers/lookup-dadata', {
      method: 'POST',
      body: JSON.stringify({ inn }),
      headers: { 'Content-Type': 'application/json' },
    });
    if (res.status === 503) {
      App.notify('DaData не сконфигурирован. Заполните вручную.', 'error');
      return;
    }
    if (!res.ok) {
      App.notify('DaData недоступен', 'error');
      return;
    }
    const { party } = await res.json();
    if (!party) {
      App.notify('Контрагент с таким ИНН не найден в DaData', 'warn');
      return;
    }
    if (party.name) form.querySelector('[name="name"]').value = party.name;
    if (party.kpp) form.querySelector('[name="kpp"]').value = party.kpp;
    if (party.address) form.querySelector('[name="address"]').value = party.address;
    App.notify('Реквизиты подгружены — проверьте и сохраните', 'success');
  },

  async submit(e) {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target).entries());
    // Strip empty strings to undefined
    for (const k of Object.keys(data)) {
      if (data[k] === '') delete data[k];
    }
    const ok = await SberModal._onSave?.(data);
    if (ok !== false) SberModal.close();
  },
};

window.SberModal = SberModal;
