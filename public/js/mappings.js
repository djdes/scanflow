/* global App, OnecCatalog, Mappings */
const Mappings = {
  mode: 'all',
  grouped: [],    // [{ onec_guid, mapped_name, variants: [...] }]
  unmapped: [],   // [{ id, scanned_name, ... }]
  expandedGuid: null,

  async load() {
    await OnecCatalog.load();
    this.updateCatalogStatus();
    if (this.mode === 'all') {
      await this.loadGrouped();
    } else if (this.mode === 'unmapped') {
      await this.loadGrouped(); // same endpoint, render differently
    } else {
      this.renderCatalog();
    }
  },

  updateCatalogStatus() {
    const el = document.getElementById('mappings-catalog-status');
    if (!el) return;
    if (OnecCatalog.items.length === 0) {
      el.innerHTML = '<span style="color:#b91c1c">Справочник не выгружен.</span>';
    } else {
      const ts = OnecCatalog.lastSyncedAt ? new Date(OnecCatalog.lastSyncedAt).toLocaleString('ru-RU') : '—';
      el.innerHTML = `Справочник из 1С: <strong>${OnecCatalog.items.length}</strong> товаров · Последняя выгрузка: ${ts}`;
    }
  },

  setMode(mode) {
    this.mode = mode;
    document.getElementById('mappings-mode-all').classList.toggle('active', mode === 'all');
    document.getElementById('mappings-mode-unmapped').classList.toggle('active', mode === 'unmapped');
    document.getElementById('mappings-mode-catalog').classList.toggle('active', mode === 'catalog');
    document.getElementById('mappings-mode-all-pane').style.display = mode === 'all' ? 'block' : 'none';
    document.getElementById('mappings-mode-unmapped-pane').style.display = mode === 'unmapped' ? 'block' : 'none';
    document.getElementById('mappings-mode-catalog-pane').style.display = mode === 'catalog' ? 'block' : 'none';
    this.load();
  },

  async loadGrouped() {
    try {
      const { data } = await App.apiJson('/mappings');
      this.grouped = data.grouped || [];
      this.unmapped = data.unmapped || [];
      if (this.mode === 'all') this.renderGrouped();
      else this.renderUnmapped();
    } catch (e) {
      console.error('Failed to load mappings', e);
    }
  },

  filter(query) { this.renderGrouped(query); },

  renderGrouped(filterQuery = '') {
    const tbody = document.getElementById('mappings-tbody');
    let items = this.grouped;
    if (filterQuery) {
      const q = filterQuery.toLowerCase();
      items = items.filter(g =>
        g.mapped_name.toLowerCase().includes(q) ||
        g.variants.some(v => v.scanned_name.toLowerCase().includes(q))
      );
    }
    if (items.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state">
        <div class="empty-icon">&#128218;</div>
        <div>${filterQuery ? 'Ничего не найдено' : 'Соответствия ещё не добавлены'}</div>
      </div></td></tr>`;
      return;
    }
    const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    tbody.innerHTML = items.map(g => {
      const total = g.variants.reduce((s, v) => s + (v.times_seen || 0), 0);
      const isExpanded = this.expandedGuid === g.onec_guid;
      const shown = isExpanded ? g.variants : g.variants.slice(0, 3);
      const more = g.variants.length - 3;

      const chips = shown.map(v =>
        `<span class="mapping-chip" title="${esc(v.scanned_name)}">${esc(v.scanned_name)}</span>`
      ).join('');
      const moreHtml = !isExpanded && more > 0
        ? `<span class="mapping-chip mapping-chip-more">+${more}</span>`
        : '';

      let expandedRows = '';
      if (isExpanded) {
        expandedRows = g.variants.map(v => `
          <tr class="mapping-expanded-row">
            <td></td>
            <td>${esc(v.scanned_name)}</td>
            <td style="text-align:right">${v.times_seen || 0}×</td>
            <td><button class="btn-icon-danger" title="Удалить вариант" onclick="Mappings.removeVariant(${v.id}, event)">&#10005;</button></td>
          </tr>
        `).join('');
        // Add inline "add variant" row
        expandedRows += `
          <tr class="mapping-expanded-row">
            <td></td>
            <td colspan="2">
              <div style="display:flex;gap:8px;align-items:center">
                <input type="text" id="add-variant-${esc(g.onec_guid)}" placeholder="Новый вариант..." style="flex:1;padding:4px 8px;border:1px solid var(--border);border-radius:4px;font-size:13px"
                       onclick="event.stopPropagation()"
                       onkeydown="if(event.key==='Enter'){event.stopPropagation();Mappings.addVariant('${esc(g.onec_guid)}','${esc(g.mapped_name)}')}">
                <button class="btn btn-sm btn-primary" onclick="event.stopPropagation();Mappings.addVariant('${esc(g.onec_guid)}','${esc(g.mapped_name)}')">+</button>
              </div>
            </td>
            <td></td>
          </tr>`;
      }

      return `
        <tr class="clickable" onclick="Mappings.toggleExpand('${esc(g.onec_guid)}')">
          <td><strong>${esc(g.mapped_name)}</strong></td>
          <td>${chips}${moreHtml}</td>
          <td style="text-align:right">${total}×</td>
          <td><span class="expand-arrow">${isExpanded ? '▼' : '▶'}</span></td>
        </tr>
        ${expandedRows}
      `;
    }).join('');
  },

  toggleExpand(guid) {
    this.expandedGuid = this.expandedGuid === guid ? null : guid;
    this.renderGrouped(document.getElementById('mappings-search')?.value || '');
  },

  async addVariant(guid, mappedName) {
    const input = document.getElementById('add-variant-' + guid);
    if (!input) return;
    const scanned = input.value.trim();
    if (!scanned) { App.notify('Введите название', 'error'); return; }
    try {
      const res = await App.api('/mappings', {
        method: 'POST',
        body: { scanned_name: scanned, mapped_name_1c: mappedName, onec_guid: guid },
      });
      if (res.ok) {
        App.notify('Вариант добавлен', 'success');
        this.loadGrouped();
      } else {
        const data = await res.json();
        App.notify(data.error || 'Ошибка', 'error');
      }
    } catch (e) {
      App.notify('Ошибка: ' + e.message, 'error');
    }
  },

  async removeVariant(id, event) {
    if (event) { event.stopPropagation(); event.preventDefault(); }
    if (!confirm('Удалить этот вариант сопоставления?')) return;
    try {
      const res = await App.api(`/mappings/${id}`, { method: 'DELETE' });
      if (res.ok) {
        App.notify('Вариант удалён', 'success');
        this.loadGrouped();
      }
    } catch (e) {
      App.notify('Ошибка: ' + e.message, 'error');
    }
  },

  renderUnmapped() {
    const tbody = document.getElementById('unmapped-tbody');
    if (this.unmapped.length === 0) {
      tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state">
        <div class="empty-icon">&#9989;</div>
        <div>Все товары сопоставлены!</div>
      </div></td></tr>`;
      return;
    }
    const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    tbody.innerHTML = this.unmapped.map(m => `
      <tr>
        <td>${esc(m.scanned_name)}</td>
        <td>
          <div class="nom-picker">
            <input type="text" class="nom-picker-input" id="unmap-input-${m.id}"
                   placeholder="Начните вводить..."
                   oninput="Mappings.onUnmapInput(${m.id})"
                   onfocus="Mappings.onUnmapInput(${m.id})"
                   onblur="setTimeout(() => { const dd = document.getElementById('unmap-dd-${m.id}'); if(dd) dd.style.display='none'; }, 150)">
            <div class="nom-picker-dropdown" id="unmap-dd-${m.id}"></div>
          </div>
        </td>
        <td><button class="btn btn-sm btn-danger" onclick="Mappings.removeVariant(${m.id}, event)">Удалить</button></td>
      </tr>
    `).join('');
  },

  onUnmapInput(id) {
    const input = document.getElementById(`unmap-input-${id}`);
    const dd = document.getElementById(`unmap-dd-${id}`);
    if (!input || !dd) return;
    const q = input.value.trim();
    if (!q) { dd.style.display = 'none'; return; }
    const results = OnecCatalog.search(q, 10);
    if (results.length === 0) { dd.style.display = 'none'; return; }
    const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    dd.innerHTML = results.map(r => `
      <div class="nom-picker-option" data-guid="${esc(r.guid)}" data-name="${esc(r.name)}"
           onmousedown="event.preventDefault(); Mappings.pickUnmap(${id}, '${esc(r.guid)}', '${esc(r.name)}')">
        <strong>${esc(r.name)}</strong>
        ${r.unit ? '<span class="nom-unit">' + esc(r.unit) + '</span>' : ''}
      </div>
    `).join('');
    dd.style.display = 'block';
  },

  async pickUnmap(id, guid, name) {
    try {
      const res = await App.api(`/mappings/${id}`, {
        method: 'PUT',
        body: { mapped_name_1c: name, onec_guid: guid },
      });
      if (res.ok) {
        App.notify(`Сопоставлено: ${name}`, 'success');
        this.loadGrouped();
      }
    } catch (e) {
      App.notify('Ошибка: ' + e.message, 'error');
    }
  },

  // --- Add mapping form ---
  showAddForm() {
    document.getElementById('add-mapping-form').style.display = 'block';
    document.getElementById('add-map-scanned').value = '';
    document.getElementById('add-map-nom-input').value = '';
    document.getElementById('add-map-guid').value = '';
    document.getElementById('add-map-scanned').focus();
  },

  hideAddForm() {
    document.getElementById('add-mapping-form').style.display = 'none';
  },

  onAddInput() {
    const input = document.getElementById('add-map-nom-input');
    const dd = document.getElementById('add-map-dd');
    if (!input || !dd) return;
    const q = input.value.trim();
    if (!q) { dd.style.display = 'none'; return; }
    const results = OnecCatalog.search(q, 10);
    if (results.length === 0) { dd.style.display = 'none'; return; }
    const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    dd.innerHTML = results.map(r => `
      <div class="nom-picker-option" onmousedown="event.preventDefault(); Mappings.pickAdd('${esc(r.guid)}', '${esc(r.name)}')">
        <strong>${esc(r.name)}</strong>
        ${r.unit ? '<span class="nom-unit">' + esc(r.unit) + '</span>' : ''}
      </div>
    `).join('');
    dd.style.display = 'block';
  },

  pickAdd(guid, name) {
    document.getElementById('add-map-nom-input').value = name;
    document.getElementById('add-map-guid').value = guid;
    document.getElementById('add-map-dd').style.display = 'none';
  },

  async saveNew() {
    const scanned = document.getElementById('add-map-scanned').value.trim();
    const name = document.getElementById('add-map-nom-input').value.trim();
    const guid = document.getElementById('add-map-guid').value;
    if (!scanned) { App.notify('Введите название из накладной', 'error'); return; }
    if (!name || !guid) { App.notify('Выберите товар 1С', 'error'); return; }
    try {
      const res = await App.api('/mappings', {
        method: 'POST',
        body: { scanned_name: scanned, mapped_name_1c: name, onec_guid: guid },
      });
      if (res.ok) {
        App.notify('Сопоставление добавлено', 'success');
        this.hideAddForm();
        this.loadGrouped();
      } else {
        const data = await res.json();
        App.notify(data.error || 'Ошибка', 'error');
      }
    } catch (e) {
      App.notify('Ошибка: ' + e.message, 'error');
    }
  },

  // --- Catalog tab ---
  filterCatalog(query) { this.renderCatalog(query); },

  renderCatalog(filterQuery = '') {
    const tbody = document.getElementById('catalog-tbody');
    if (!tbody) return;
    // Show sync info
    const syncEl = document.getElementById('catalog-sync-info');
    if (syncEl) {
      const ts = OnecCatalog.lastSyncedAt ? new Date(OnecCatalog.lastSyncedAt).toLocaleString('ru-RU') : '—';
      syncEl.textContent = `${OnecCatalog.items.length} товаров · Обновлено: ${ts}`;
    }
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
        <div>${filterQuery ? 'Ничего не найдено' : 'Справочник пуст.'}</div>
      </div></td></tr>`;
      return;
    }
    tbody.innerHTML = items.map((it, i) => {
      const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const guidShort = it.guid ? it.guid.substring(0, 8) + '…' : '—';
      return `<tr>
        <td>${i + 1}</td>
        <td>${esc(it.code) || '—'}</td>
        <td><strong>${esc(it.name)}</strong></td>
        <td>${esc(it.full_name) || '—'}</td>
        <td>${esc(it.unit) || '—'}</td>
        <td><code style="font-size:11px" title="${esc(it.guid)}">${guidShort}</code></td>
      </tr>`;
    }).join('');
  },
};
