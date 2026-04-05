/* global App, Invoices */
const Invoices = {
  currentStatus: null,
  offset: 0,
  limit: 50,

  async showList() {
    document.getElementById('invoices-list').style.display = 'block';
    document.getElementById('invoice-detail').style.display = 'none';
    await Promise.all([this.loadStats(), this.loadTable()]);
  },

  async loadStats() {
    try {
      const { data } = await App.apiJson('/invoices/stats');
      const container = document.getElementById('invoices-stats');
      const counts = {};
      (data.byStatus || []).forEach(s => { counts[s.status] = s.count; });
      container.innerHTML = `
        <div class="stat-card">
          <div class="stat-value">${data.total || 0}</div>
          <div class="stat-label">Всего</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${counts.processed || 0}</div>
          <div class="stat-label">Обработано</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${counts.sent_to_1c || 0}</div>
          <div class="stat-label">Отправлено в 1С</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${counts.error || 0}</div>
          <div class="stat-label">Ошибки</div>
        </div>
      `;
    } catch (e) {
      console.error('Failed to load stats', e);
    }
  },

  async loadTable() {
    const filters = document.getElementById('invoices-filters');
    const statuses = [
      { key: null, label: 'Все' },
      { key: 'new', label: 'Новые' },
      { key: 'processed', label: 'Обработанные' },
      { key: 'sent_to_1c', label: 'Отправленные' },
      { key: 'error', label: 'Ошибки' },
    ];

    filters.innerHTML = statuses.map(s =>
      `<button class="filter-btn ${this.currentStatus === s.key ? 'active' : ''}"
              onclick="Invoices.setFilter(${s.key === null ? 'null' : `'${s.key}'`})">${s.label}</button>`
    ).join('');

    let url = `/invoices?limit=${this.limit}&offset=${this.offset}`;
    if (this.currentStatus) url += `&status=${this.currentStatus}`;

    try {
      const { data } = await App.apiJson(url);
      const tbody = document.getElementById('invoices-tbody');

      if (!data || data.length === 0) {
        tbody.innerHTML = `<tr><td colspan="10"><div class="empty-state">
          <div class="empty-icon">&#128196;</div>
          <div>Накладных пока нет. Загрузите фото или положите в папку data/inbox/</div>
        </div></td></tr>`;
        return;
      }

      tbody.innerHTML = data.map(inv => `
        <tr class="clickable" onclick="App.navigate('#/invoices/${inv.id}')">
          <td>${inv.id}</td>
          <td title="${inv.file_name}">${inv.file_name.length > 30 ? inv.file_name.substring(0, 30) + '...' : inv.file_name}</td>
          <td>${inv.invoice_number || '—'}</td>
          <td>${App.formatDate(inv.invoice_date)}</td>
          <td>${inv.supplier || '—'}</td>
          <td style="text-align:right">${App.formatMoney(inv.total_sum)}</td>
          <td>${App.ocrEngineBadge(inv.ocr_engine)}</td>
          <td>${App.statusBadge(inv.status)}</td>
          <td>${App.formatDate(inv.created_at)}</td>
          <td style="text-align:center">
            <button class="btn-icon-danger" title="Удалить накладную"
                    onclick="Invoices.deleteInvoice(${inv.id}, event)">&#10005;</button>
          </td>
        </tr>
      `).join('');

      // Pagination
      const pagination = document.getElementById('invoices-pagination');
      if (data.length >= this.limit) {
        pagination.innerHTML = `
          ${this.offset > 0 ? `<button class="btn btn-outline btn-sm" onclick="Invoices.prevPage()">&larr; Назад</button>` : ''}
          <button class="btn btn-outline btn-sm" onclick="Invoices.nextPage()">Далее &rarr;</button>
        `;
      } else if (this.offset > 0) {
        pagination.innerHTML = `<button class="btn btn-outline btn-sm" onclick="Invoices.prevPage()">&larr; Назад</button>`;
      } else {
        pagination.innerHTML = '';
      }
    } catch (e) {
      console.error('Failed to load invoices', e);
      App.notify('Ошибка загрузки накладных', 'error');
    }
  },

  setFilter(status) {
    this.currentStatus = status;
    this.offset = 0;
    this.loadTable();
  },

  nextPage() {
    this.offset += this.limit;
    this.loadTable();
  },

  prevPage() {
    this.offset = Math.max(0, this.offset - this.limit);
    this.loadTable();
  },

  async showDetail(id) {
    document.getElementById('invoices-list').style.display = 'none';
    document.getElementById('invoice-detail').style.display = 'block';

    await OnecCatalog.load();

    try {
      const { data } = await App.apiJson(`/invoices/${id}`);
      if (!data) {
        App.notify('Накладная не найдена', 'error');
        App.navigate('#/invoices');
        return;
      }

      // Header fields
      const header = document.getElementById('invoice-header-fields');
      header.innerHTML = `
        <div class="invoice-field">
          <div class="field-label">Номер</div>
          <div class="field-value">${data.invoice_number || '—'}</div>
        </div>
        <div class="invoice-field">
          <div class="field-label">Дата</div>
          <div class="field-value">${App.formatDate(data.invoice_date)}</div>
        </div>
        <div class="invoice-field">
          <div class="field-label">Поставщик</div>
          <div class="field-value">${data.supplier || '—'}</div>
        </div>
        <div class="invoice-field">
          <div class="field-label">Сумма</div>
          <div class="field-value">${App.formatMoney(data.total_sum)}</div>
        </div>
        <div class="invoice-field">
          <div class="field-label">В т.ч. НДС</div>
          <div class="field-value">${data.vat_sum != null ? App.formatMoney(data.vat_sum) : '—'}</div>
        </div>
        <div class="invoice-field">
          <div class="field-label">Статус</div>
          <div class="field-value">${App.statusBadge(data.status)}</div>
        </div>
        <div class="invoice-field">
          <div class="field-label">Обработка</div>
          <div class="field-value">${App.ocrEngineBadge(data.ocr_engine)}</div>
        </div>
        <div class="invoice-field">
          <div class="field-label">Файл</div>
          <div class="field-value">${data.file_name}</div>
        </div>
        <div class="invoice-field">
          <div class="field-label">Создан</div>
          <div class="field-value">${App.formatDate(data.created_at)}</div>
        </div>
      `;

      // Supplier details (banking)
      const supplierBlock = document.getElementById('invoice-supplier-details');
      if (data.supplier_inn || data.supplier_bik || data.supplier_account) {
        let html = '<h3 style="margin-bottom:12px">Реквизиты поставщика</h3><div class="invoice-header">';
        if (data.invoice_type) {
          html += `<div class="invoice-field"><div class="field-label">Тип документа</div><div class="field-value">${data.invoice_type}</div></div>`;
        }
        if (data.supplier_inn) {
          html += `<div class="invoice-field"><div class="field-label">ИНН</div><div class="field-value">${data.supplier_inn}</div></div>`;
        }
        if (data.supplier_bik) {
          html += `<div class="invoice-field"><div class="field-label">БИК</div><div class="field-value">${data.supplier_bik}</div></div>`;
        }
        if (data.supplier_account) {
          html += `<div class="invoice-field"><div class="field-label">Расч. счёт</div><div class="field-value">${data.supplier_account}</div></div>`;
        }
        if (data.supplier_corr_account) {
          html += `<div class="invoice-field"><div class="field-label">Корр. счёт</div><div class="field-value">${data.supplier_corr_account}</div></div>`;
        }
        if (data.supplier_address) {
          html += `<div class="invoice-field"><div class="field-label">Адрес</div><div class="field-value">${data.supplier_address}</div></div>`;
        }
        html += '</div>';
        supplierBlock.innerHTML = html;
        supplierBlock.style.display = 'block';
      } else {
        supplierBlock.style.display = 'none';
      }

      // Actions
      const actions = document.getElementById('invoice-actions');
      let actionsHtml = '';
      const unmappedCount = (data.items || []).filter(it => !it.onec_guid).length;
      if (data.status === 'processed') {
        if (data.approved_for_1c) {
          actionsHtml += `<div class="badge badge-sent" style="padding:8px 16px">✓ Ожидает загрузки в 1С</div>`;
          actionsHtml += `<button class="btn btn-outline" onclick="Invoices.unapproveForOneC(${data.id})">Отозвать отправку</button>`;
        } else {
          const disabled = unmappedCount > 0 ? 'disabled' : '';
          const title = unmappedCount > 0
            ? `title="Сопоставьте ${unmappedCount} товар(ов) с 1С перед отправкой"`
            : '';
          actionsHtml += `<button class="btn btn-primary" ${disabled} ${title} onclick="Invoices.sendTo1C(${data.id})">Отправить в 1С</button>`;
          if (unmappedCount > 0) {
            actionsHtml += `<div class="badge badge-new" style="padding:8px 16px">Не сопоставлено: ${unmappedCount}</div>`;
          }
        }
      }
      if (data.status === 'sent_to_1c') {
        actionsHtml += `<button class="btn btn-outline" onclick="Invoices.resetStatus(${data.id})">Сбросить статус (для повторной загрузки)</button>`;
      }
      if (data.error_message) {
        actionsHtml += `<div class="badge badge-error" style="padding:8px 16px">${data.error_message}</div>`;
      }
      // Delete button (destructive, always visible, pushed to the right)
      actionsHtml += `<button class="btn btn-danger" style="margin-left:auto" onclick="Invoices.deleteInvoice(${data.id})">Удалить накладную</button>`;
      actions.innerHTML = actionsHtml;

      // Items table
      const itemsTbody = document.getElementById('invoice-items-tbody');
      if (data.items && data.items.length > 0) {
        itemsTbody.innerHTML = data.items.map((item, i) => {
          const badge = item.onec_guid
            ? '<span class="nom-badge nom-badge-ok" title="Сопоставлено">✓</span>'
            : '<span class="nom-badge nom-badge-missing" title="Требует сопоставления">●</span>';
          const currentName = item.mapped_name || item.original_name;
          const safeName = currentName.replace(/"/g, '&quot;');
          return `
          <tr data-item-id="${item.id}">
            <td>${i + 1}</td>
            <td>${item.original_name}</td>
            <td>
              <div class="nom-picker">
                ${badge}
                <input type="text" class="nom-picker-input"
                       value="${safeName}"
                       data-invoice-id="${data.id}"
                       data-item-id="${item.id}"
                       data-current-guid="${item.onec_guid || ''}"
                       oninput="Invoices.onNomInput(event)"
                       onfocus="Invoices.onNomFocus(event)"
                       onblur="Invoices.onNomBlur(event)">
                <div class="nom-picker-dropdown" id="nom-dd-${item.id}"></div>
              </div>
            </td>
            <td style="text-align:right">${item.quantity != null ? item.quantity : '—'}</td>
            <td>${item.unit || '—'}</td>
            <td style="text-align:right">${App.formatMoney(item.price)}</td>
            <td style="text-align:right">${App.formatMoney(item.total)}</td>
            <td style="text-align:center">${item.vat_rate != null ? item.vat_rate + '%' : '—'}</td>
            <td>${App.confidenceBadge(item.mapping_confidence || 0)}</td>
          </tr>
        `;
        }).join('');
      } else {
        itemsTbody.innerHTML = '<tr><td colspan="9"><div class="empty-state">Товары не найдены</div></td></tr>';
      }

      // OCR text
      document.getElementById('invoice-ocr-text').textContent = data.raw_text || 'Нет данных';

    } catch (e) {
      console.error('Failed to load invoice detail', e);
      App.notify('Ошибка загрузки накладной', 'error');
    }
  },

  async sendTo1C(id) {
    try {
      const res = await App.api(`/invoices/${id}/send`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        App.notify('Накладная помечена для отправки. Загрузите через обработку в 1С.', 'success');
        this.showDetail(id);
      } else {
        App.notify(data.error || 'Ошибка', 'error');
      }
    } catch (e) {
      App.notify('Ошибка: ' + e.message, 'error');
    }
  },

  async unapproveForOneC(id) {
    try {
      const res = await App.api(`/invoices/${id}/unapprove`, { method: 'POST' });
      if (res.ok) {
        App.notify('Отправка отозвана', 'success');
        this.showDetail(id);
      } else {
        const data = await res.json();
        App.notify(data.error || 'Ошибка', 'error');
      }
    } catch (e) {
      App.notify('Ошибка: ' + e.message, 'error');
    }
  },

  async resetStatus(id) {
    if (!confirm('Сбросить статус накладной? Она станет "Обработан" и исчезнет из списка готовых к 1С. Для повторной отправки нужно будет снова нажать "Отправить в 1С".')) {
      return;
    }
    try {
      const res = await App.api(`/invoices/${id}/reset`, { method: 'POST' });
      if (res.ok) {
        App.notify('Статус сброшен', 'success');
        this.showDetail(id);
      } else {
        const data = await res.json();
        App.notify(data.error || 'Ошибка', 'error');
      }
    } catch (e) {
      App.notify('Ошибка: ' + e.message, 'error');
    }
  },

  async deleteInvoice(id, event) {
    if (event) {
      event.stopPropagation();
      event.preventDefault();
    }
    if (!confirm(`Удалить накладную #${id}? Это действие нельзя отменить.`)) {
      return;
    }
    try {
      const res = await App.api(`/invoices/${id}`, { method: 'DELETE' });
      if (res.ok) {
        App.notify('Накладная удалена', 'success');
        App.navigate('#/invoices');
        this.showList();
      } else {
        const data = await res.json();
        App.notify(data.error || 'Ошибка удаления', 'error');
      }
    } catch (e) {
      App.notify('Ошибка удаления: ' + e.message, 'error');
    }
  },

  onNomInput(event) {
    const input = event.target;
    const dd = document.getElementById('nom-dd-' + input.dataset.itemId);
    if (!dd) return;
    const q = input.value.trim();
    if (!q) { dd.style.display = 'none'; return; }
    const results = OnecCatalog.search(q, 10);
    if (results.length === 0) { dd.style.display = 'none'; return; }
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    // Inline onclick with stringified data was unusable: JSON.stringify wraps
    // names in double quotes, which close the onclick="..." attribute early
    // and the handler silently breaks. Switched to data-* attributes + a
    // single delegated click listener attached once per dropdown.
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
    // Attach delegated click handler once. _clickBound flag prevents duplicate
    // listeners when the dropdown re-renders on each keystroke.
    if (!dd._clickBound) {
      dd.addEventListener('click', (e) => {
        const opt = e.target.closest('.nom-picker-option');
        if (!opt) return;
        this.selectNomItem(input.dataset.invoiceId, input.dataset.itemId, opt.dataset.guid, opt.dataset.name);
      });
      dd._clickBound = true;
    }
  },

  onNomFocus(event) {
    this.onNomInput(event);
  },

  onNomBlur(event) {
    const dd = document.getElementById('nom-dd-' + event.target.dataset.itemId);
    setTimeout(() => { if (dd) dd.style.display = 'none'; }, 150);
  },

  async selectNomItem(invoiceId, itemId, guid, name) {
    try {
      const res = await App.api(`/invoices/${invoiceId}/items/${itemId}/map`, {
        method: 'PUT',
        body: { onec_guid: guid },
      });
      if (res.ok) {
        App.notify(`Сопоставлено: ${name}`, 'success');
        this.showDetail(parseInt(invoiceId, 10));
      } else {
        const data = await res.json();
        App.notify(data.error || 'Ошибка сопоставления', 'error');
      }
    } catch (e) {
      App.notify('Ошибка: ' + e.message, 'error');
    }
  }
};
