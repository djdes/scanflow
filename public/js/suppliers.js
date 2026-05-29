/* global App, SberModal */
const Suppliers = {
  state: { items: [], q: '', _searchTimer: null },

  async load() {
    await this.refresh();
    this.bindUi();
  },

  bindUi() {
    const search = document.getElementById('suppliers-search');
    if (search) {
      search.value = this.state.q;
      search.oninput = () => {
        clearTimeout(this.state._searchTimer);
        this.state._searchTimer = setTimeout(() => {
          this.state.q = search.value;
          this.refresh();
        }, 250);
      };
    }
    const addBtn = document.getElementById('supplier-add-btn');
    if (addBtn) addBtn.onclick = () => SberModal.open({}, async (data) => Suppliers.create(data));
    this._bindExtractPanel();
  },

  _bindExtractPanel() {
    const openBtn = document.getElementById('supplier-extract-btn');
    const panel = document.getElementById('supplier-extract-panel');
    const closeBtn = document.getElementById('supplier-extract-close');
    const input = document.getElementById('supplier-extract-input');
    const pickLink = document.getElementById('supplier-extract-pick');
    const dropzone = document.getElementById('supplier-extract-dropzone');
    if (!openBtn || !panel || !input) return;

    openBtn.onclick = () => { panel.style.display = 'block'; };
    closeBtn.onclick = () => { panel.style.display = 'none'; };
    pickLink.onclick = (e) => { e.preventDefault(); input.click(); };
    dropzone.onclick = () => input.click();

    input.onchange = (e) => this._handleFiles(Array.from(e.target.files || []));
    dropzone.ondragover = (e) => { e.preventDefault(); dropzone.style.background = '#eef4ff'; };
    dropzone.ondragleave = () => { dropzone.style.background = '#fbfcfe'; };
    dropzone.ondrop = (e) => {
      e.preventDefault();
      dropzone.style.background = '#fbfcfe';
      this._handleFiles(Array.from(e.dataTransfer.files || []));
    };
  },

  async _handleFiles(files) {
    if (!files.length) return;
    const queue = document.getElementById('supplier-extract-queue');
    // Upload sequentially (sync claude_api mode for 5+ photos risks rate limit);
    // dispatcher jobs poll in the background so multiple recognise in parallel.
    for (const file of files) {
      const card = this._addQueueCard(queue, file.name);
      try {
        const fd = new FormData();
        fd.append('file', file);
        const res = await App.api('/suppliers/extract-from-photo', { method: 'POST', body: fd });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
        if (payload.jobId) {
          // Dispatcher mode — async. Show progress and poll for the result.
          this._setQueueCardProcessing(card, file.name);
          this._pollExtractStatus(payload.jobId, card, file.name);
        } else {
          this._renderExtractedCard(card, file.name, payload.extracted || {});
        }
      } catch (err) {
        this._renderFailedCard(card, file.name, err.message);
      }
    }
  },

  _setQueueCardProcessing(card, fileName) {
    card.innerHTML = `<div><strong>${App.esc(fileName)}</strong> <span class="muted">— распознаётся через диспетчер, это может занять несколько минут…</span></div>`;
  },

  // Poll extract-status until the dispatcher answers. ~5s interval, ~16 min cap
  // (the server marks jobs stale → error after 15 min, so this rarely hits MAX).
  async _pollExtractStatus(jobId, card, fileName) {
    const POLL_MS = 5000;
    const MAX = 200;
    for (let i = 0; i < MAX; i++) {
      await new Promise(r => setTimeout(r, POLL_MS));
      let data;
      try {
        const res = await fetch(App.baseUrl + `/suppliers/extract-status/${jobId}`, { headers: { 'X-API-Key': App.apiKey } });
        data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      } catch (err) {
        this._renderFailedCard(card, fileName, err.message);
        return;
      }
      if (data.status === 'done') { this._renderExtractedCard(card, fileName, data.extracted || {}); return; }
      if (data.status === 'error') { this._renderFailedCard(card, fileName, data.error || 'не распознано'); return; }
    }
    this._renderFailedCard(card, fileName, 'таймаут распознавания');
  },

  _addQueueCard(queue, fileName) {
    const card = document.createElement('div');
    card.className = 'card';
    card.style.padding = '12px';
    card.innerHTML = `<div><strong>${App.esc(fileName)}</strong> <span class="muted">— распознаю…</span></div>`;
    queue.appendChild(card);
    return card;
  },

  _renderFailedCard(card, fileName, errMsg) {
    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div><strong>${App.esc(fileName)}</strong> <span style="color:#c62828">— ошибка: ${App.esc(errMsg)}</span></div>
        <button class="btn btn-ghost" onclick="this.closest('.card').remove()">×</button>
      </div>`;
  },

  _renderExtractedCard(card, fileName, ex) {
    const fields = [
      { key: 'inn',               label: 'ИНН',           ph: '10 или 12 цифр' },
      { key: 'name',              label: 'Название',      ph: '' },
      { key: 'kpp',               label: 'КПП',           ph: '9 цифр' },
      { key: 'bank_bic',          label: 'БИК',           ph: '9 цифр' },
      { key: 'account',           label: 'Счёт',          ph: '20 цифр' },
      { key: 'bank_corr_account', label: 'Корсчёт',       ph: '20 цифр' },
      { key: 'address',           label: 'Адрес',         ph: '' },
    ];
    const rows = fields.map(f => `
      <label style="display:flex;gap:8px;align-items:center;margin:4px 0">
        <span style="width:90px;font-size:12px;color:#667">${f.label}</span>
        <input type="text" data-key="${f.key}" value="${App.esc(ex[f.key] || '')}" placeholder="${f.ph}"
               style="flex:1;padding:4px 8px;font-size:13px;border:1px solid #d0d7e2;border-radius:4px">
      </label>
    `).join('');
    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <strong>${App.esc(fileName)}</strong>
        <button class="btn btn-ghost" data-action="skip">Пропустить</button>
      </div>
      <div>${rows}</div>
      <div style="margin-top:8px;display:flex;gap:8px">
        <button class="btn btn-primary" data-action="save">Сохранить</button>
        <span class="card-status muted"></span>
      </div>`;
    const status = card.querySelector('.card-status');
    card.querySelector('[data-action=skip]').onclick = () => card.remove();
    card.querySelector('[data-action=save]').onclick = async () => {
      const payload = {};
      card.querySelectorAll('input[data-key]').forEach(i => {
        const v = i.value.trim();
        if (v) payload[i.dataset.key] = v;
      });
      status.textContent = 'Сохраняю…';
      try {
        const res = await App.api('/suppliers/merge', { method: 'POST', body: JSON.stringify(payload) });
        if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
        const { mode } = await res.json();
        status.textContent = mode === 'created' ? '✓ Создан' : mode === 'merged' ? '✓ Пустые поля дозаполнены' : '✓ Без изменений (уже полный)';
        status.style.color = '#0d9f6e';
        await this.refresh();
        setTimeout(() => card.remove(), 1500);
      } catch (err) {
        status.textContent = '✗ ' + err.message;
        status.style.color = '#c62828';
      }
    };
  },

  async refresh() {
    const params = new URLSearchParams();
    if (this.state.q) params.set('q', this.state.q);
    const res = await App.api('/suppliers?' + params);
    const { suppliers } = await res.json();
    this.state.items = suppliers;
    this.render();
  },

  render() {
    const wrap = document.getElementById('suppliers-table-wrap');
    if (!wrap) return;
    if (this.state.items.length === 0) {
      wrap.innerHTML = '<p class="muted">Поставщики пока не добавлены. Нажмите «+ Добавить поставщика».</p>';
      return;
    }
    const rows = this.state.items.map(s => `
      <tr>
        <td>${App.esc(s.inn)}</td>
        <td>${App.esc(s.name)}</td>
        <td>${App.esc(s.kpp || '')}</td>
        <td>${App.esc(s.bank_bic)}</td>
        <td>${App.esc(s.account || '')}</td>
        <td>${s.verified ? '<span class="badge badge-ok" style="padding:2px 8px">✓</span>' : '<span class="badge badge-warn" style="padding:2px 8px">!</span>'}</td>
        <td>${App.esc(s.last_used_at || '')}</td>
        <td>
          <button class="btn btn-outline btn-sm" onclick="Suppliers.edit('${App.esc(s.inn)}')">✎</button>
          <button class="btn btn-danger btn-sm" onclick="Suppliers.remove('${App.esc(s.inn)}')">🗑</button>
        </td>
      </tr>
    `).join('');
    wrap.innerHTML = `
      <div class="table-wrap">
        <table>
          <thead><tr><th>ИНН</th><th>Название</th><th>КПП</th><th>БИК</th><th>Счёт</th><th>Verified</th><th>Last used</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  },

  async edit(inn) {
    const res = await App.api('/suppliers/' + encodeURIComponent(inn));
    const { supplier } = await res.json();
    SberModal.open(supplier, async (data) => Suppliers.update(inn, data));
  },

  async create(data) {
    const res = await App.api('/suppliers', {
      method: 'POST',
      body: JSON.stringify(data),
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      App.notify((await res.json()).error || 'Ошибка', 'error');
      return false;
    }
    App.notify('Поставщик добавлен', 'success');
    this.refresh();
    return true;
  },

  async update(inn, data) {
    const res = await App.api('/suppliers/' + encodeURIComponent(inn), {
      method: 'PATCH',
      body: JSON.stringify(data),
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      App.notify((await res.json()).error || 'Ошибка', 'error');
      return false;
    }
    App.notify('Изменения сохранены', 'success');
    this.refresh();
    return true;
  },

  async remove(inn) {
    if (!confirm(`Удалить поставщика ${inn}?`)) return;
    await App.api('/suppliers/' + encodeURIComponent(inn), { method: 'DELETE' });
    this.refresh();
  },
};

window.Suppliers = Suppliers;
