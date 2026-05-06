/* global App */
const SberModal = {
  _onSave: null,

  open(prefilled, onSave) {
    this._onSave = onSave;
    let modal = document.getElementById('sber-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'sber-modal';
      modal.className = 'modal-backdrop';
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:none;align-items:center;justify-content:center;z-index:9999';
      modal.innerHTML = `
        <div class="modal-card card" style="max-width:560px;width:90%;max-height:90vh;overflow:auto">
          <h3 style="margin-bottom:16px">Реквизиты поставщика</h3>
          <form id="sber-modal-form" class="form-grid" style="display:grid;gap:12px">
            <label>ИНН *<input name="inn" required pattern="[0-9]{10}|[0-9]{12}"></label>
            <label>Название *<input name="name" required></label>
            <label>КПП<input name="kpp" pattern="[0-9]{9}"></label>
            <label>БИК банка *<input name="bank_bic" required pattern="[0-9]{9}"></label>
            <label>Счёт<input name="account" pattern="[0-9]{20}"></label>
            <label>Корсчёт банка<input name="bank_corr_account" pattern="[0-9]{20}"></label>
            <label>Название банка<input name="bank_name"></label>
            <label>Адрес<input name="address"></label>
            <div class="form-actions" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
              <button type="button" class="btn btn-outline" id="sber-modal-dadata">Заполнить по ИНН (DaData)</button>
              <button type="button" class="btn btn-ghost" id="sber-modal-cancel" style="margin-left:auto">Отмена</button>
              <button type="submit" class="btn btn-primary">Сохранить и продолжить</button>
            </div>
          </form>
        </div>
      `;
      document.body.appendChild(modal);
    }
    const form = modal.querySelector('#sber-modal-form');
    form.reset();
    for (const [k, v] of Object.entries(prefilled || {})) {
      const inp = form.querySelector(`[name="${k}"]`);
      if (inp && v != null) inp.value = v;
    }
    modal.style.display = 'flex';
    modal.querySelector('#sber-modal-cancel').onclick = () => SberModal.close();
    modal.querySelector('#sber-modal-dadata').onclick = () => SberModal.fillByInn();
    form.onsubmit = (e) => SberModal.submit(e);
  },

  close() {
    const m = document.getElementById('sber-modal');
    if (m) m.style.display = 'none';
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
