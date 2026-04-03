/* global App, Mappings */
const Mappings = {
  allMappings: [],
  editingId: null,

  async load() {
    try {
      const { data } = await App.apiJson('/mappings');
      this.allMappings = data || [];
      this.render();
    } catch (e) {
      console.error('Failed to load mappings', e);
      App.notify('Ошибка загрузки номенклатуры', 'error');
    }
  },

  filter(query) {
    this.render(query);
  },

  render(filterQuery = '') {
    const tbody = document.getElementById('mappings-tbody');
    let items = this.allMappings;
    if (filterQuery) {
      const q = filterQuery.toLowerCase();
      items = items.filter(m =>
        (m.scanned_name || '').toLowerCase().includes(q) ||
        (m.mapped_name_1c || '').toLowerCase().includes(q) ||
        (m.category || '').toLowerCase().includes(q)
      );
    }

    if (items.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">
        <div class="empty-icon">&#128218;</div>
        <div>${filterQuery ? 'Ничего не найдено' : 'Соответствия ещё не добавлены'}</div>
      </div></td></tr>`;
      return;
    }

    tbody.innerHTML = items.map(m => this.editingId === m.id ? this.editRow(m) : `
      <tr>
        <td>${m.id}</td>
        <td>${m.scanned_name}</td>
        <td>${m.mapped_name_1c}</td>
        <td>${m.category || '—'}</td>
        <td>${m.default_unit || '—'}</td>
        <td>${m.approved ? '&#10003;' : '—'}</td>
        <td>
          <button class="btn btn-outline btn-sm" onclick="Mappings.startEdit(${m.id})">Ред.</button>
          <button class="btn btn-danger btn-sm" onclick="Mappings.remove(${m.id})">Удалить</button>
        </td>
      </tr>
    `).join('');
  },

  editRow(m) {
    return `
      <tr class="inline-form">
        <td>${m.id}</td>
        <td><input type="text" id="edit-scanned" value="${m.scanned_name}"></td>
        <td><input type="text" id="edit-mapped" value="${m.mapped_name_1c}"></td>
        <td><input type="text" id="edit-category" value="${m.category || ''}"></td>
        <td><input type="text" id="edit-unit" value="${m.default_unit || ''}" style="width:60px"></td>
        <td><input type="checkbox" id="edit-approved" ${m.approved ? 'checked' : ''}></td>
        <td>
          <button class="btn btn-primary btn-sm" onclick="Mappings.saveEdit(${m.id})">Сохр.</button>
          <button class="btn btn-outline btn-sm" onclick="Mappings.cancelEdit()">Отм.</button>
        </td>
      </tr>
    `;
  },

  startEdit(id) {
    this.editingId = id;
    this.render(document.getElementById('mappings-search').value);
  },

  cancelEdit() {
    this.editingId = null;
    this.render(document.getElementById('mappings-search').value);
  },

  async saveEdit(id) {
    const data = {
      scanned_name: document.getElementById('edit-scanned').value.trim(),
      mapped_name_1c: document.getElementById('edit-mapped').value.trim(),
      category: document.getElementById('edit-category').value.trim() || null,
      default_unit: document.getElementById('edit-unit').value.trim() || null,
      approved: document.getElementById('edit-approved').checked,
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
    const tbody = document.getElementById('mappings-tbody');
    // Check if add form already exists
    if (document.getElementById('add-scanned')) return;

    const addRow = document.createElement('tr');
    addRow.className = 'inline-form';
    addRow.innerHTML = `
      <td>—</td>
      <td><input type="text" id="add-scanned" placeholder="Название из скана"></td>
      <td><input type="text" id="add-mapped" placeholder="Название в 1С"></td>
      <td><input type="text" id="add-category" placeholder="Категория"></td>
      <td><input type="text" id="add-unit" placeholder="Ед." style="width:60px"></td>
      <td><input type="checkbox" id="add-approved"></td>
      <td>
        <button class="btn btn-primary btn-sm" onclick="Mappings.saveNew()">Добавить</button>
        <button class="btn btn-outline btn-sm" onclick="this.closest('tr').remove()">Отм.</button>
      </td>
    `;
    tbody.insertBefore(addRow, tbody.firstChild);
    document.getElementById('add-scanned').focus();
  },

  async saveNew() {
    const data = {
      scanned_name: document.getElementById('add-scanned').value.trim(),
      mapped_name_1c: document.getElementById('add-mapped').value.trim(),
      category: document.getElementById('add-category').value.trim() || undefined,
      default_unit: document.getElementById('add-unit').value.trim() || undefined,
      approved: document.getElementById('add-approved').checked,
    };

    if (!data.scanned_name || !data.mapped_name_1c) {
      App.notify('Заполните Скан-имя и Имя в 1С', 'error');
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
      App.notify('Соответствие удалено', 'success');
      await this.load();
    } catch (e) {
      App.notify('Ошибка удаления', 'error');
    }
  }
};
