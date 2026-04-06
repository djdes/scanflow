/* global App, OnecCatalog, Mappings */
const Mappings = {
  mode: 'all',
  allMappings: [],
  suppliers: [],
  currentSupplier: null,
  currentSupplierMappings: [],
  editingId: null,

  async load() {
    await OnecCatalog.load();
    this.updateCatalogStatus();
    if (this.mode === 'all') {
      await this.loadAll();
    } else if (this.mode === 'catalog') {
      this.renderCatalog();
    } else {
      await this.loadSuppliers();
    }
  },

  updateCatalogStatus() {
    const el = document.getElementById('mappings-catalog-status');
    if (!el) return;
    if (OnecCatalog.items.length === 0) {
      el.innerHTML = '<span style="color:#b91c1c">Справочник не выгружен. Запустите команду "Выгрузить номенклатуру" в обработке 1С.</span>';
    } else {
      const ts = OnecCatalog.lastSyncedAt ? new Date(OnecCatalog.lastSyncedAt).toLocaleString('ru-RU') : '—';
      el.innerHTML = `Справочник из 1С: <strong>${OnecCatalog.items.length}</strong> товаров · Последняя выгрузка: ${ts}`;
    }
  },

  setMode(mode) {
    this.mode = mode;
    document.getElementById('mappings-mode-all').classList.toggle('active', mode === 'all');
    document.getElementById('mappings-mode-by-supplier').classList.toggle('active', mode === 'by-supplier');
    document.getElementById('mappings-mode-catalog').classList.toggle('active', mode === 'catalog');
    document.getElementById('mappings-mode-all-pane').style.display = mode === 'all' ? 'block' : 'none';
    document.getElementById('mappings-mode-by-supplier-pane').style.display = mode === 'by-supplier' ? 'block' : 'none';
    document.getElementById('mappings-mode-catalog-pane').style.display = mode === 'catalog' ? 'block' : 'none';
    this.load();
  },

  async loadAll() {
    try {
      const { data } = await App.apiJson('/mappings');
      this.allMappings = data || [];
      this.renderAll();
    } catch (e) {
      console.error('Failed to load mappings', e);
      App.notify('Ошибка загрузки соответствий', 'error');
    }
  },

  filter(query) { this.renderAll(query); },

  renderAll(filterQuery = '') {
    const tbody = document.getElementById('mappings-tbody');
    let items = this.allMappings;
    if (filterQuery) {
      const q = filterQuery.toLowerCase();
      items = items.filter(m =>
        (m.scanned_name || '').toLowerCase().includes(q) ||
        (m.mapped_name_1c || '').toLowerCase().includes(q) ||
        (m.last_seen_supplier || '').toLowerCase().includes(q)
      );
    }
    if (items.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">
        <div class="empty-icon">&#128218;</div>
        <div>${filterQuery ? 'Ничего не найдено' : 'Соответствия ещё не добавлены'}</div>
      </div></td></tr>`;
      return;
    }
    tbody.innerHTML = items.map(m => this.editingId === m.id ? this.editRow(m) : this.viewRow(m)).join('');
  },

  viewRow(m) {
    const guidShort = m.onec_guid ? m.onec_guid.substring(0, 8) + '…' : '<span style="color:#b91c1c">—</span>';
    return `
      <tr>
        <td>${m.id}</td>
        <td>${m.scanned_name}</td>
        <td>${m.mapped_name_1c}</td>
        <td><code style="font-size:11px">${guidShort}</code></td>
        <td>${m.last_seen_supplier || '—'}</td>
        <td style="text-align:right">${m.times_seen || 0}</td>
        <td>
          <button class="btn btn-outline btn-sm" onclick="Mappings.startEdit(${m.id})">Ред.</button>
          <button class="btn btn-danger btn-sm" onclick="Mappings.remove(${m.id})">Удалить</button>
        </td>
      </tr>
    `;
  },

  editRow(m) {
    const guidValue = m.onec_guid || '';
    const nameValue = m.mapped_name_1c || '';
    return `
      <tr class="inline-form">
        <td>${m.id}</td>
        <td><input type="text" id="edit-scanned" value="${m.scanned_name}"></td>
        <td>
          <div class="nom-picker">
            <input type="text" class="nom-picker-input" id="edit-nom-input"
                   value="${nameValue.replace(/"/g, '&quot;')}"
                   oninput="Mappings.onEditNomInput()"
                   onfocus="Mappings.onEditNomInput()"
                   onblur="setTimeout(() => document.getElementById('edit-nom-dropdown').style.display='none', 150)">
            <div class="nom-picker-dropdown" id="edit-nom-dropdown"></div>
          </div>
          <input type="hidden" id="edit-onec-guid" value="${guidValue}">
        </td>
        <td><code style="font-size:11px" id="edit-guid-preview">${guidValue ? guidValue.substring(0, 8) + '…' : '—'}</code></td>
        <td colspan="2">
          <button class="btn btn-primary btn-sm" onclick="Mappings.saveEdit(${m.id})">Сохр.</button>
          <button class="btn btn-outline btn-sm" onclick="Mappings.cancelEdit()">Отм.</button>
        </td>
      </tr>
    `;
  },

  onEditNomInput() {
    const input = document.getElementById('edit-nom-input');
    const dd = document.getElementById('edit-nom-dropdown');
    if (!input || !dd) return;
    const q = input.value.trim();
    if (!q) { dd.style.display = 'none'; return; }
    const results = OnecCatalog.search(q, 10);
    if (results.length === 0) { dd.style.display = 'none'; return; }
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    // Inline onclick with JSON.stringify(name) broke the HTML attribute
    // because nested double quotes closed it early. Use data-* + delegated
    // click handler bound once per dropdown instead.
    dd.innerHTML = results.map(r => `
      <div class="nom-picker-option"
           data-guid="${esc(r.guid)}"
           data-name="${esc(r.name)}"
           onmousedown="event.preventDefault()">
        <strong>${esc(r.name)}</strong>
        ${r.unit ? '<span class="nom-unit">' + esc(r.unit) + '</span>' : ''}
      </div>
    `).join('');
    dd.style.display = 'block';
    if (!dd._clickBound) {
      dd.addEventListener('click', (e) => {
        const opt = e.target.closest('.nom-picker-option');
        if (!opt) return;
        this.pickEditNom(opt.dataset.guid, opt.dataset.name);
      });
      dd._clickBound = true;
    }
  },

  pickEditNom(guid, name) {
    document.getElementById('edit-nom-input').value = name;
    document.getElementById('edit-onec-guid').value = guid;
    document.getElementById('edit-guid-preview').textContent = guid.substring(0, 8) + '…';
    document.getElementById('edit-nom-dropdown').style.display = 'none';
  },

  startEdit(id) {
    this.editingId = id;
    if (this.mode === 'all') this.renderAll(document.getElementById('mappings-search').value);
    else this.renderSupplierMappings();
  },

  cancelEdit() {
    this.editingId = null;
    if (this.mode === 'all') this.renderAll(document.getElementById('mappings-search').value);
    else this.renderSupplierMappings();
  },

  async saveEdit(id) {
    const data = {
      scanned_name: document.getElementById('edit-scanned').value.trim(),
      mapped_name_1c: document.getElementById('edit-nom-input').value.trim(),
      onec_guid: document.getElementById('edit-onec-guid').value.trim() || null,
    };
    if (!data.scanned_name || !data.mapped_name_1c) {
      App.notify('Заполните обязательные поля', 'error');
      return;
    }
    try {
      await App.api(`/mappings/${id}`, { method: 'PUT', body: data });
      this.editingId = null;
      App.notify('Соответствие обновлено', 'success');
      await this.load();
    } catch (e) {
      App.notify('Ошибка сохранения', 'error');
    }
  },

  showAddForm() {
    // Inject an inline add row into whichever tbody is active
    const tbody = this.mode === 'all'
      ? document.getElementById('mappings-tbody')
      : document.getElementById('supplier-mappings-tbody');
    if (document.getElementById('add-scanned')) return;
    const row = document.createElement('tr');
    row.className = 'inline-form';
    row.innerHTML = `
      <td>—</td>
      <td><input type="text" id="add-scanned" placeholder="Название из скана"></td>
      <td>
        <div class="nom-picker">
          <input type="text" class="nom-picker-input" id="add-nom-input" placeholder="Выберите из 1С..."
                 oninput="Mappings.onAddNomInput()"
                 onfocus="Mappings.onAddNomInput()"
                 onblur="setTimeout(() => document.getElementById('add-nom-dropdown').style.display='none', 150)">
          <div class="nom-picker-dropdown" id="add-nom-dropdown"></div>
        </div>
        <input type="hidden" id="add-onec-guid" value="">
      </td>
      <td><code style="font-size:11px" id="add-guid-preview">—</code></td>
      <td colspan="3">
        <button class="btn btn-primary btn-sm" onclick="Mappings.saveNew()">Добавить</button>
        <button class="btn btn-outline btn-sm" onclick="this.closest('tr').remove()">Отм.</button>
      </td>
    `;
    tbody.insertBefore(row, tbody.firstChild);
    document.getElementById('add-scanned').focus();
  },

  onAddNomInput() {
    const input = document.getElementById('add-nom-input');
    const dd = document.getElementById('add-nom-dropdown');
    if (!input || !dd) return;
    const q = input.value.trim();
    if (!q) { dd.style.display = 'none'; return; }
    const results = OnecCatalog.search(q, 10);
    if (results.length === 0) { dd.style.display = 'none'; return; }
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    dd.innerHTML = results.map(r => `
      <div class="nom-picker-option"
           data-guid="${esc(r.guid)}"
           data-name="${esc(r.name)}"
           onmousedown="event.preventDefault()">
        <strong>${esc(r.name)}</strong>
        ${r.unit ? '<span class="nom-unit">' + esc(r.unit) + '</span>' : ''}
      </div>
    `).join('');
    dd.style.display = 'block';
    if (!dd._clickBound) {
      dd.addEventListener('click', (e) => {
        const opt = e.target.closest('.nom-picker-option');
        if (!opt) return;
        this.pickAddNom(opt.dataset.guid, opt.dataset.name);
      });
      dd._clickBound = true;
    }
  },

  pickAddNom(guid, name) {
    document.getElementById('add-nom-input').value = name;
    document.getElementById('add-onec-guid').value = guid;
    document.getElementById('add-guid-preview').textContent = guid.substring(0, 8) + '…';
    document.getElementById('add-nom-dropdown').style.display = 'none';
  },

  async saveNew() {
    const data = {
      scanned_name: document.getElementById('add-scanned').value.trim(),
      mapped_name_1c: document.getElementById('add-nom-input').value.trim(),
      onec_guid: document.getElementById('add-onec-guid').value.trim() || null,
    };
    if (!data.scanned_name || !data.mapped_name_1c) {
      App.notify('Заполните Скан-имя и выберите товар из 1С', 'error');
      return;
    }
    try {
      await App.api('/mappings', { method: 'POST', body: data });
      App.notify('Соответствие добавлено', 'success');
      await this.load();
    } catch (e) {
      App.notify('Ошибка добавления', 'error');
    }
  },

  async remove(id) {
    if (!confirm('Удалить это соответствие?')) return;
    try {
      await App.api(`/mappings/${id}`, { method: 'DELETE' });
      App.notify('Удалено', 'success');
      await this.load();
    } catch (e) {
      App.notify('Ошибка удаления', 'error');
    }
  },

  async loadSuppliers() {
    try {
      const { data } = await App.apiJson('/nomenclature/suppliers');
      this.suppliers = data.suppliers || [];
      const unmappedCount = data.unmapped_count || 0;
      this.renderSupplierList(unmappedCount);
    } catch (e) {
      console.error('Failed to load suppliers', e);
      App.notify('Ошибка загрузки поставщиков', 'error');
    }
  },

  renderSupplierList(unmappedCount) {
    const container = document.getElementById('supplier-list');
    const unmappedItem = `
      <div class="supplier-item ${this.currentSupplier === '__unmapped__' ? 'active' : ''}"
           onclick="Mappings.selectSupplier('__unmapped__')">
        🔴 Не сопоставлено <span class="supplier-count">${unmappedCount}</span>
      </div>
    `;
    const rows = this.suppliers.map(s => `
      <div class="supplier-item ${this.currentSupplier === s.supplier ? 'active' : ''}"
           onclick="Mappings.selectSupplier(${JSON.stringify(s.supplier).replace(/"/g, '&quot;')})">
        ${s.supplier} <span class="supplier-count">${s.mappings_count}</span>
      </div>
    `).join('');
    container.innerHTML = unmappedItem + rows;
  },

  async selectSupplier(supplier) {
    this.currentSupplier = supplier;
    const header = document.getElementById('supplier-header');
    const qs = supplier === '__unmapped__' ? '?unmapped=true' : `?supplier=${encodeURIComponent(supplier)}`;
    header.textContent = supplier === '__unmapped__' ? 'Несопоставленные маппинги' : supplier;
    try {
      const { data } = await App.apiJson('/mappings' + qs);
      this.currentSupplierMappings = data || [];
      this.renderSupplierMappings();
      // Re-render sidebar to update active highlight
      await this.loadSuppliers();
    } catch (e) {
      App.notify('Ошибка загрузки маппингов поставщика', 'error');
    }
  },

  renderSupplierMappings() {
    const tbody = document.getElementById('supplier-mappings-tbody');
    if (this.currentSupplierMappings.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state">Нет данных</div></td></tr>';
      return;
    }
    tbody.innerHTML = this.currentSupplierMappings.map(m => {
      if (this.editingId === m.id) return this.editRow(m);
      const guidShort = m.onec_guid ? m.onec_guid.substring(0, 8) + '…' : '<span style="color:#b91c1c">—</span>';
      return `
        <tr>
          <td>${m.id}</td>
          <td>${m.scanned_name}</td>
          <td>${m.mapped_name_1c}</td>
          <td><code style="font-size:11px">${guidShort}</code></td>
          <td style="text-align:right">${m.times_seen || 0}</td>
          <td>
            <button class="btn btn-outline btn-sm" onclick="Mappings.startEdit(${m.id})">Ред.</button>
            <button class="btn btn-danger btn-sm" onclick="Mappings.remove(${m.id})">Удалить</button>
          </td>
        </tr>
      `;
    }).join('');
  },

  filterCatalog(query) { this.renderCatalog(query); },

  renderCatalog(filterQuery = '') {
    const tbody = document.getElementById('catalog-tbody');
    if (!tbody) return;
    let items = OnecCatalog.items || [];
    if (filterQuery) {
      const q = filterQuery.toLowerCase();
      items = items.filter(it =>
        (it.name || '').toLowerCase().includes(q) ||
        (it.full_name || '').toLowerCase().includes(q) ||
        (it.code || '').toLowerCase().includes(q)
      );
    }
    if (items.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">
        <div class="empty-icon">&#128230;</div>
        <div>${filterQuery ? 'Ничего не найдено' : 'Справочник пуст. Выгрузите номенклатуру из 1С.'}</div>
      </div></td></tr>`;
      return;
    }
    tbody.innerHTML = items.map((it, i) => {
      const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const guidShort = it.guid ? it.guid.substring(0, 8) + '…' : '—';
      return `
        <tr>
          <td>${i + 1}</td>
          <td>${esc(it.code) || '—'}</td>
          <td><strong>${esc(it.name)}</strong></td>
          <td>${esc(it.full_name) || '—'}</td>
          <td>${esc(it.unit) || '—'}</td>
          <td><code style="font-size:11px" title="${esc(it.guid)}">${guidShort}</code></td>
        </tr>
      `;
    }).join('');
  },
};
