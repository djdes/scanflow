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

    // Show skeleton rows while real data is loading — feels instant
    App.skeletonRows('invoices-tbody', ['w-24', 'w-full', 'w-40', 'w-40', 'w-60', 'w-40', 'w-40', 'w-40', 'w-40', 'w-24'], 6);

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

      tbody.innerHTML = data.map(inv => {
        const fileName = App.esc(inv.file_name || '');
        const fileNameDisplay = (inv.file_name || '').length > 30
          ? App.esc(inv.file_name.substring(0, 30) + '...')
          : fileName;
        return `
        <tr class="clickable" onclick="App.navigate('#/invoices/${inv.id}')">
          <td>${inv.id}</td>
          <td title="${fileName}">${fileNameDisplay}</td>
          <td>${App.esc(inv.invoice_number || '—')}</td>
          <td>${App.formatDate(inv.invoice_date)}</td>
          <td>${App.esc(inv.supplier || '—')}</td>
          <td style="text-align:right">${App.formatMoney(inv.total_sum)}</td>
          <td>${App.ocrEngineBadge(inv.ocr_engine)}</td>
          <td>${App.statusBadge(inv.status)}</td>
          <td>${App.formatDate(inv.created_at)}</td>
          <td style="text-align:center">
            <button class="btn-icon-danger" title="Удалить накладную"
                    aria-label="Удалить накладную ${inv.id}"
                    onclick="Invoices.deleteInvoice(${inv.id}, event)">&#10005;</button>
          </td>
        </tr>
      `;
      }).join('');

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

    this._currentInvoiceId = id;
    this._photosLoaded = false;

    // Reset to items tab
    document.getElementById('invoice-tab-items').style.display = 'block';
    document.getElementById('invoice-tab-photos').style.display = 'none';
    document.getElementById('invoice-tab-ocr').style.display = 'none';
    const tabBtns = document.querySelectorAll('#invoice-detail .tabs .tab-btn');
    tabBtns.forEach((b, i) => b.classList.toggle('active', i === 0));

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
          <div class="field-value">${App.esc(data.invoice_number || '—')}</div>
        </div>
        <div class="invoice-field">
          <div class="field-label">Дата</div>
          <div class="field-value">${App.formatDate(data.invoice_date)}</div>
        </div>
        <div class="invoice-field">
          <div class="field-label">Поставщик</div>
          <div class="field-value">${App.esc(data.supplier || '—')}</div>
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
          <div class="field-value">${App.esc(data.file_name || '')}</div>
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
          html += `<div class="invoice-field"><div class="field-label">Тип документа</div><div class="field-value">${App.esc(data.invoice_type)}</div></div>`;
        }
        if (data.supplier_inn) {
          html += `<div class="invoice-field"><div class="field-label">ИНН</div><div class="field-value">${App.esc(data.supplier_inn)}</div></div>`;
        }
        if (data.supplier_bik) {
          html += `<div class="invoice-field"><div class="field-label">БИК</div><div class="field-value">${App.esc(data.supplier_bik)}</div></div>`;
        }
        if (data.supplier_account) {
          html += `<div class="invoice-field"><div class="field-label">Расч. счёт</div><div class="field-value">${App.esc(data.supplier_account)}</div></div>`;
        }
        if (data.supplier_corr_account) {
          html += `<div class="invoice-field"><div class="field-label">Корр. счёт</div><div class="field-value">${App.esc(data.supplier_corr_account)}</div></div>`;
        }
        if (data.supplier_address) {
          html += `<div class="invoice-field"><div class="field-label">Адрес</div><div class="field-value">${App.esc(data.supplier_address)}</div></div>`;
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
          // Allow sending even with unmatched items — the BSL side calls
          // НайтиИлиСоздатьНоменклатуру() which auto-creates new catalog
          // entries in 1C when no match is found. This is the normal flow
          // for first-time supplier items we haven't ordered before.
          actionsHtml += `<button class="btn btn-primary" onclick="Invoices.sendTo1C(${data.id})">Отправить в 1С</button>`;
          if (unmappedCount > 0) {
            actionsHtml += `<div class="badge badge-new" style="padding:8px 16px" title="Несопоставленные товары будут созданы как новая номенклатура в 1С">Новых товаров: ${unmappedCount}</div>`;
          }
        }
      }
      if (data.status === 'sent_to_1c') {
        actionsHtml += `<button class="btn btn-outline" onclick="Invoices.resetStatus(${data.id})">Сбросить статус (для повторной загрузки)</button>`;
      }
      if (data.error_message) {
        actionsHtml += `<div class="badge badge-error" style="padding:8px 16px">${App.esc(data.error_message)}</div>`;
      }
      // Remap buttons — two separate buttons, planshet-friendly
      if (unmappedCount > 0) {
        actionsHtml += `<button class="btn btn-outline" onclick="Invoices.remap(${data.id}, false)" title="Попытаться сопоставить несопоставленные товары">Сопоставить недостающие</button>`;
      }
      actionsHtml += `<button class="btn btn-outline" onclick="Invoices.remap(${data.id}, true)" title="Пересопоставить все товары заново">Пересопоставить всё</button>`;
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
          const currentName = item.mapped_name || item.original_name || '';
          // esc() also escapes quotes, which is what we need for value="..."
          const safeName = App.esc(currentName);
          return `
          <tr data-item-id="${item.id}">
            <td>${i + 1}</td>
            <td>${App.esc(item.original_name || '')}</td>
            <td>
              <div class="nom-picker">
                ${badge}
                <input type="text" class="nom-picker-input"
                       value="${safeName}"
                       data-invoice-id="${data.id}"
                       data-item-id="${item.id}"
                       data-current-guid="${App.esc(item.onec_guid || '')}"
                       oninput="Invoices.onNomInput(event)"
                       onfocus="Invoices.onNomFocus(event)"
                       onblur="Invoices.onNomBlur(event)">
                <div class="nom-picker-dropdown" id="nom-dd-${item.id}"></div>
              </div>
            </td>
            <td style="text-align:right">${item.quantity != null ? item.quantity : '—'}</td>
            <td>${App.esc(item.unit || '—')}</td>
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
    // If there are unmapped items, confirm the user actually wants 1C to
    // auto-create new nomenclature entries for them. This is a destructive-ish
    // operation (creates real catalog rows in УНФ) so a one-time confirm is
    // worth the minor friction.
    const row = document.querySelector(`tr[data-invoice-id="${id}"]`);
    let unmappedCount = 0;
    try {
      const r = await App.api(`/invoices/${id}`);
      if (r.ok) {
        const j = await r.json();
        unmappedCount = (j.data?.items || []).filter(it => !it.onec_guid).length;
      }
    } catch {}
    if (unmappedCount > 0) {
      const ok = confirm(
        `В накладной ${unmappedCount} несопоставленных товар(ов).\n\n` +
        `При загрузке в 1С они будут созданы как НОВЫЕ позиции в справочнике Номенклатура по их названию из скана.\n\n` +
        `Продолжить?`
      );
      if (!ok) return;
    }
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

  async remap(id, forceAll) {
    const url = forceAll ? `/invoices/${id}/remap?all=true` : `/invoices/${id}/remap`;
    try {
      const res = await App.api(url, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        const remapped = data.data?.remapped ?? 0;
        const changed = data.data?.changed ?? 0;
        if (forceAll) {
          App.notify(`Пересопоставлено: ${remapped}, изменений: ${changed}`, 'success');
        } else if (remapped > 0) {
          App.notify(`Сопоставлено дополнительно: ${remapped}`, 'success');
        } else {
          App.notify('Новых сопоставлений не найдено', 'success');
        }
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

  deleteInvoice(id, event) {
    if (event) {
      event.stopPropagation();
      event.preventDefault();
    }
    this.showConfirm(
      'Удалить накладную?',
      `Накладная #${id} будет удалена вместе с фото. Это действие нельзя отменить.`,
      async () => {
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
      }
    );
  },

  showConfirm(title, text, onOk) {
    const modal = document.getElementById('confirm-modal');
    document.getElementById('confirm-modal-title').textContent = title;
    document.getElementById('confirm-modal-text').textContent = text;
    modal.style.display = 'flex';

    const okBtn = document.getElementById('confirm-modal-ok');
    const cancelBtn = document.getElementById('confirm-modal-cancel');

    const close = () => {
      modal.style.display = 'none';
      okBtn.replaceWith(okBtn.cloneNode(true));
      cancelBtn.replaceWith(cancelBtn.cloneNode(true));
    };

    document.getElementById('confirm-modal-cancel').addEventListener('click', close);
    document.getElementById('confirm-modal-ok').addEventListener('click', () => {
      close();
      onOk();
    });
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); }, { once: true });
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

  switchTab(tab, btn) {
    // Hide all tabs
    document.getElementById('invoice-tab-items').style.display = 'none';
    document.getElementById('invoice-tab-photos').style.display = 'none';
    document.getElementById('invoice-tab-ocr').style.display = 'none';

    // Deactivate all buttons
    btn.parentElement.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    // Show selected tab
    document.getElementById('invoice-tab-' + tab).style.display = 'block';

    // Load photos on first switch
    if (tab === 'photos' && !this._photosLoaded) {
      this.loadPhotos();
    }
  },

  async loadPhotos() {
    const container = document.getElementById('invoice-photos-container');
    const id = this._currentInvoiceId;
    if (!id) return;

    try {
      const { data } = await App.apiJson(`/invoices/${id}/photos`);
      if (!data || data.length === 0) {
        container.innerHTML = '<div class="empty-state">Фото не найдены</div>';
        return;
      }

      container.innerHTML = data.map((photo, i) => `
        <div style="margin-bottom:16px">
          <div style="margin-bottom:4px;color:#888;font-size:13px">Лист ${i + 1}: ${photo.filename}</div>
          <img src="${photo.url}?key=${encodeURIComponent(App.apiKey)}" alt="${photo.filename}"
               style="max-width:100%;border:1px solid #e0e0e0;border-radius:6px"
               onerror="this.outerHTML='<div class=\\'empty-state\\'>Файл не найден на диске</div>'">
        </div>
      `).join('');
      this._photosLoaded = true;
    } catch (e) {
      container.innerHTML = '<div class="empty-state">Ошибка загрузки фото</div>';
    }
  },

  // Detects "(50кг)" / "(1.5 кг)" style pack-size hints in a scanned name.
  // Returns parsed {pack_size, pack_unit} or null. Only kg — по запросу
  // пользователя волюметрия (л/мл) сюда не попадает.
  detectPackKg(scannedName) {
    if (!scannedName) return null;
    const m = scannedName.match(/\(\s*(\d+(?:[.,]\d+)?)\s*кг\s*\)/i);
    if (!m) return null;
    const n = parseFloat(m[1].replace(',', '.'));
    if (!isFinite(n) || n <= 0) return null;
    return { pack_size: n, pack_unit: 'кг' };
  },

  async selectNomItem(invoiceId, itemId, guid, name) {
    // Find the row in the current table so we can read the item's scan name
    // and current quantity for the pack-size prompt. If the row isn't there
    // (edge case — table re-rendered), skip the prompt gracefully.
    let packOverride = null;
    try {
      const row = document.querySelector(`#invoice-items-tbody tr[data-item-id="${itemId}"]`);
      if (row) {
        const scanNameCell = row.querySelector('td:nth-child(2)');
        const scanName = scanNameCell ? scanNameCell.textContent.trim() : '';
        const detected = this.detectPackKg(scanName);
        if (detected) {
          // Read the current quantity from the 4th <td>. If it's a number > 0
          // we can show "1 × 50 = 50 кг" in the prompt. Otherwise fall back to
          // a generic "apply 50 kg per unit?" message.
          const qtyCell = row.querySelector('td:nth-child(4)');
          const qtyText = qtyCell ? qtyCell.textContent.replace(',', '.').replace(/\s/g, '') : '';
          const currentQty = parseFloat(qtyText);
          const hasQty = isFinite(currentQty) && currentQty > 0;
          const newQty = hasQty ? currentQty * detected.pack_size : detected.pack_size;
          const msg = hasQty
            ? `Обнаружено в названии: ${detected.pack_size} ${detected.pack_unit}.\n\n`
              + `Пересчитать эту позицию как ${currentQty} × ${detected.pack_size} = ${newQty} ${detected.pack_unit} `
              + `и запомнить правило для следующих накладных с этим же названием?`
            : `Обнаружено в названии: ${detected.pack_size} ${detected.pack_unit}.\n\n`
              + `Применить упаковку 1 шт = ${detected.pack_size} ${detected.pack_unit} и запомнить правило?`;
          if (confirm(msg)) {
            packOverride = detected;
          }
        }
      }
    } catch {
      // Detection is purely cosmetic — never block saving if it throws.
    }

    try {
      const body = { onec_guid: guid };
      if (packOverride) {
        body.pack_size = packOverride.pack_size;
        body.pack_unit = packOverride.pack_unit;
      }
      const res = await App.api(`/invoices/${invoiceId}/items/${itemId}/map`, {
        method: 'PUT',
        body,
      });
      if (res.ok) {
        const extra = packOverride ? ` (${packOverride.pack_size} ${packOverride.pack_unit})` : '';
        App.notify(`Сопоставлено: ${name}${extra}`, 'success');
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
