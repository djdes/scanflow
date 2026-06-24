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
    dropzone.ondragover = (e) => { e.preventDefault(); dropzone.classList.add('is-dragover'); };
    dropzone.ondragleave = () => dropzone.classList.remove('is-dragover');
    dropzone.ondrop = (e) => {
      e.preventDefault();
      dropzone.classList.remove('is-dragover');
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
      await this._processFile(file, card);
    }
  },

  // Upload + (async) poll one file into `card`. Reused by the "Повторить" button,
  // so it always resets the card to the working state first. Keeps a reference to
  // the original File so a failed card can re-upload it.
  async _processFile(file, card) {
    card.className = 'extract-card is-working';
    card.innerHTML = `<div class="extract-card__head">
      <span class="extract-card__name">${App.esc(file.name)}</span>
      <span class="muted" style="white-space:nowrap"><span class="spinner-dot"></span>распознаю…</span>
    </div>`;
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await App.api('/suppliers/extract-from-photo', { method: 'POST', body: fd });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(this._friendlyError(payload.error, res.status));
      if (payload.jobId) {
        // Dispatcher mode — async. Show progress and poll for the result.
        this._setQueueCardProcessing(card, file.name);
        this._pollExtractStatus(payload.jobId, card, file);
      } else {
        this._renderExtractedCard(card, file.name, payload.extracted || {});
      }
    } catch (err) {
      this._renderFailedCard(card, file, err.message);
    }
  },

  // Map cryptic transient failures to a clear, actionable RU message.
  _friendlyError(serverMsg, status) {
    if (status === 502 || status === 503 || /unreachable|ProjectsFlow|502|503/i.test(serverMsg || '')) {
      return 'Сервис распознавания временно недоступен — нажмите «Повторить».';
    }
    return serverMsg || `HTTP ${status}`;
  },

  _setQueueCardProcessing(card, fileName) {
    card.classList.add('is-working');
    card.innerHTML = `<div class="extract-card__head">
      <span class="extract-card__name">${App.esc(fileName)}</span>
      <span class="muted" style="white-space:nowrap"><span class="spinner-dot"></span>распознаётся…</span>
    </div>
    <p class="muted" style="margin:6px 0 0">Через диспетчер — это может занять несколько минут.</p>`;
  },

  // Poll extract-status until the dispatcher answers. ~5s interval, ~16 min cap
  // (the server marks jobs stale → error after 15 min, so this rarely hits MAX).
  async _pollExtractStatus(jobId, card, file) {
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
        this._renderFailedCard(card, file, err.message);
        return;
      }
      if (data.status === 'done') { this._renderExtractedCard(card, file.name, data.extracted || {}); return; }
      if (data.status === 'error') { this._renderFailedCard(card, file, data.error || 'не распознано'); return; }
    }
    this._renderFailedCard(card, file, 'таймаут распознавания');
  },

  _addQueueCard(queue, fileName) {
    const card = document.createElement('div');
    card.className = 'extract-card is-working';
    card.innerHTML = `<div class="extract-card__head">
      <span class="extract-card__name">${App.esc(fileName)}</span>
      <span class="muted" style="white-space:nowrap"><span class="spinner-dot"></span>распознаю…</span>
    </div>`;
    queue.appendChild(card);
    return card;
  },

  _renderFailedCard(card, file, errMsg) {
    card.classList.remove('is-working');
    card.innerHTML = `
      <div class="extract-card__head">
        <span class="extract-card__name">${App.esc(file.name)}</span>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn btn-soft btn-sm" data-action="retry">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2v6h6"></path><path d="M3.51 15a9 9 0 1 0 2.13-9.36L3 8"></path></svg>
            Повторить
          </button>
          <button class="icon-btn" data-action="dismiss" aria-label="Убрать">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>
      </div>
      <p style="margin:6px 0 0;color:var(--error);font-size:13px">⚠ ${App.esc(errMsg)}</p>`;
    card.querySelector('[data-action=dismiss]').onclick = () => card.remove();
    card.querySelector('[data-action=retry]').onclick = () => this._processFile(file, card);
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
      <label class="extract-field">
        <span>${f.label}</span>
        <input type="text" data-key="${f.key}" value="${App.esc(ex[f.key] || '')}" placeholder="${f.ph}">
      </label>
    `).join('');
    card.classList.remove('is-working');
    card.innerHTML = `
      <div class="extract-card__head" style="margin-bottom:10px">
        <span class="extract-card__name">✓ ${App.esc(fileName)}</span>
        <button class="btn btn-outline btn-sm" data-action="skip">Пропустить</button>
      </div>
      <div>${rows}</div>
      <div style="margin-top:12px;display:flex;gap:10px;align-items:center">
        <button class="btn btn-primary btn-sm" data-action="save">Сохранить поставщика</button>
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
        // Pass the object (not a pre-stringified string): App.api only sets
        // Content-Type: application/json when body is an object — a string body
        // goes out untyped, express.json() skips it, and the route 500s with an
        // HTML page that res.json() can't parse.
        const { mode } = await App.apiJson('/suppliers/merge', { method: 'POST', body: payload });
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
        <td data-label="ИНН">${App.esc(s.inn)}</td>
        <td data-label="Название">${App.esc(s.name)}</td>
        <td data-label="КПП">${App.esc(s.kpp || '')}</td>
        <td data-label="БИК">${App.esc(s.bank_bic)}</td>
        <td data-label="Счёт">${App.esc(s.account || '')}</td>
        <td data-label="Проверен">${s.verified ? '<span class="badge badge-ok" style="padding:2px 8px">✓</span>' : '<span class="badge badge-warn" style="padding:2px 8px">!</span>'}</td>
        <td data-label="Использован">${App.esc(s.last_used_at || '')}</td>
        <td class="cell-action">
          <button class="btn btn-outline btn-sm" onclick="Suppliers.edit('${App.esc(s.inn)}')">✎</button>
          <button class="btn btn-danger btn-sm" onclick="Suppliers.remove('${App.esc(s.inn)}')">🗑</button>
        </td>
      </tr>
    `).join('');
    wrap.innerHTML = `
      <div class="table-wrap">
        <table class="cards-mobile">
          <thead><tr><th>ИНН</th><th>Название</th><th>КПП</th><th>БИК</th><th>Счёт</th><th>Проверен</th><th>Использован</th><th></th></tr></thead>
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
