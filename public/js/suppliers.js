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
