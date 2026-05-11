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
      const cur = this.currentStatus || 'all';
      const cardHtml = (filter, value, label) => `
        <button type="button" class="stat-card${cur === filter ? ' active' : ''}" data-filter="${filter}" onclick="Invoices.setFilter('${filter}')">
          <span class="stat-value">${value || 0}</span>
          <span class="stat-label">${label}</span>
        </button>`;
      container.innerHTML = [
        cardHtml('all',        data.total || 0,            'Всего'),
        cardHtml('processed',  counts.processed || 0,      'Обработано'),
        cardHtml('sent_to_1c', counts.sent_to_1c || 0,     'Отправлено в 1С'),
        cardHtml('error',      counts.error || 0,          'Ошибки'),
      ].join('');
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
    App.skeletonRows('invoices-tbody', ['w-40', 'w-40', 'w-60', 'w-40', 'w-40', 'w-24', 'w-24'], 6);

    try {
      const { data } = await App.apiJson(url);
      const tbody = document.getElementById('invoices-tbody');

      if (!data || data.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">
          <div class="empty-icon">&#128196;</div>
          <div>Накладных пока нет. Загрузите фото или положите в папку data/inbox/</div>
        </div></td></tr>`;
        return;
      }

      tbody.innerHTML = data.map(inv => {
        return `
        <tr class="clickable" onclick="App.navigate('#/invoices/${inv.id}')" title="ID ${inv.id} · файл ${App.esc(inv.file_name || '')} · создан ${App.formatDate(inv.created_at)} · ${App.esc(inv.ocr_engine || '')}">
          <td>${App.esc(inv.invoice_number || '—')}${inv.duplicate_of ? ` <span class="dup-badge" title="Дубликат накладной #${inv.duplicate_of}">🔁 #${inv.duplicate_of}</span>` : ''}</td>
          <td>${App.formatDate(inv.invoice_date)}</td>
          <td>${App.esc(inv.supplier || '—')}</td>
          <td style="text-align:right">${App.formatMoney(inv.total_sum)}${inv.items_total_mismatch ? ' <span title="Сумма расходилась с суммой позиций" style="color:#dc2626">⚠</span>' : ''}</td>
          <td>${App.statusBadge(inv.status)}</td>
          <td style="text-align:center">${this._sberCell(inv)}</td>
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

  // Renders one cell in the invoices list that shows whether a Sber payment
  // exists for this invoice (created/failed/pending), so the user can spot at
  // a glance which invoices have already been pushed to the bank.
  _sberCell(inv) {
    const status = inv.sber_payment_status;
    if (!status) return '<span style="color:#cbd5e1" title="Платёж в Сбер.Бизнес не создан">—</span>';
    const num = inv.sber_payment_number ? ` №${App.esc(inv.sber_payment_number)}` : '';
    if (status === 'created') {
      return `<span style="color:#16a34a;font-size:18px" title="Черновик создан в Сбер.Бизнес${num}">✓</span>`;
    }
    if (status === 'failed') {
      return `<span style="color:#dc2626;font-size:16px" title="Ошибка отправки${num} — открой накладную чтобы увидеть детали">⚠</span>`;
    }
    if (status === 'pending') {
      return `<span style="color:#f59e0b;font-size:16px" title="Отправка в процессе…">⏳</span>`;
    }
    return `<span style="color:#94a3b8" title="Статус: ${App.esc(status)}">●</span>`;
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
          <div class="field-value">
            ${App.formatMoney(data.total_sum)}
            ${data.items_total_mismatch ? '<span class="badge badge-error" title="Сумма в документе расходилась с суммой позиций более чем на 1%. Значение пересчитано из товаров — проверьте глазами." style="margin-left:8px">⚠ требует проверки</span>' : ''}
          </div>
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

      // Duplicate banner — превалирует над всем остальным. Дубликаты не сохраняют
      // items, поэтому 1С/Сбер actions ниже им бесполезны.
      if (data.duplicate_of) {
        actionsHtml += `
          <div class="duplicate-banner">
            <div class="duplicate-banner-text">
              🔁 <strong>Дубликат накладной</strong>
              <a href="#/invoices/${data.duplicate_of}">№${data.duplicate_of}</a>
              — позиции и сумма совпадают с оригиналом, в эту запись items не сохранены.
            </div>
            <div class="duplicate-banner-actions">
              <button class="btn btn-outline btn-sm" onclick="Invoices.unlinkDuplicate(${data.id})">Не дубликат</button>
              <button class="btn btn-danger btn-sm" onclick="Invoices.deleteInvoice(${data.id})">Удалить дубликат</button>
            </div>
          </div>
        `;
        actions.innerHTML = actionsHtml;
        // Items/Sber/1С блоки ниже не нужны для дубликата — выйти из rendering
        if (window.Sber) {
          // Спрятать Sber-секцию если она была от прошлого invoice
          const sberWrap = document.getElementById('invoice-sber-section');
          if (sberWrap) sberWrap.style.display = 'none';
        }
        return;
      }

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
      actionsHtml += `<button class="btn btn-outline" onclick="Invoices.editHeader(${data.id})" title="Редактировать реквизиты накладной">✎ Реквизиты</button>`;
      actionsHtml += `<button class="btn btn-outline" onclick="Invoices.remap(${data.id}, true)" title="Пересопоставить все товары заново">Пересопоставить всё</button>`;
      actionsHtml += `<button class="btn btn-outline" onclick="Invoices.rescan(${data.id})" title="Полный re-OCR + re-Claude + re-mapping исходного фото">🔄 Пересканировать фото</button>`;
      // LLM button is always visible. When everything is already mapped it
      // passes all=true so Claude can reconsider existing picks (catalog may
      // have grown, or an old fuzzy match may be improvable).
      const llmAll = unmappedCount === 0;
      const llmLabel = llmAll ? 'LLM: переделать всё' : 'LLM-маппинг';
      const llmTitle = llmAll
        ? 'Пересобрать все маппинги через Claude LLM (Anthropic API)'
        : 'Сопоставить несопоставленные товары через Claude LLM (Anthropic API)';
      actionsHtml += `<button class="btn btn-outline" onclick="Invoices.llmRemap(${data.id}, ${llmAll})" title="${llmTitle}">${llmLabel}</button>`;
      // Delete button (destructive, always visible, pushed to the right)
      actionsHtml += `<button class="btn btn-danger" style="margin-left:auto" onclick="Invoices.deleteInvoice(${data.id})">Удалить накладную</button>`;
      actions.innerHTML = actionsHtml;

      // Sber section (button + status)
      if (window.Sber) {
        Sber.renderInvoiceSection(data).catch(err => console.error('[sber] render section', err));
      }

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
            <td style="text-align:right">
              <input type="text" inputmode="decimal" class="item-edit item-edit-qty"
                     value="${item.quantity != null ? String(item.quantity).replace('.', ',') : ''}"
                     data-invoice-id="${data.id}" data-item-id="${item.id}" data-field="quantity"
                     onblur="Invoices.onItemEdit(event)" onkeydown="Invoices.onItemEditKey(event)">
            </td>
            <td>
              <input type="text" class="item-edit item-edit-unit"
                     value="${App.esc(item.unit || '')}"
                     data-invoice-id="${data.id}" data-item-id="${item.id}" data-field="unit"
                     onblur="Invoices.onItemEdit(event)" onkeydown="Invoices.onItemEditKey(event)">
            </td>
            <td style="text-align:right">
              <input type="text" inputmode="decimal" class="item-edit item-edit-price"
                     value="${item.price != null ? Number(item.price).toFixed(2).replace('.', ',') : ''}"
                     data-invoice-id="${data.id}" data-item-id="${item.id}" data-field="price"
                     onblur="Invoices.onItemEdit(event)" onkeydown="Invoices.onItemEditKey(event)">
            </td>
            <td style="text-align:right">
              <input type="text" inputmode="decimal" class="item-edit item-edit-total"
                     value="${item.total != null ? Number(item.total).toFixed(2).replace('.', ',') : ''}"
                     data-invoice-id="${data.id}" data-item-id="${item.id}" data-field="total"
                     onblur="Invoices.onItemEdit(event)" onkeydown="Invoices.onItemEditKey(event)">
            </td>
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

  // Guard mutating actions against double-clicks / duplicate submissions.
  // Each action claims a unique token; subsequent clicks while it's active
  // are dropped. Public so other modules (mappings.js, etc.) can reuse.
  _busy: new Set(),
  _withGuard(token, fn) {
    if (this._busy.has(token)) return Promise.resolve(undefined);
    this._busy.add(token);
    return Promise.resolve().then(fn).finally(() => this._busy.delete(token));
  },

  // === Editable header fields & validation ===

  _REQUIRED_FOR_1C: ['invoice_number', 'invoice_date', 'supplier', 'supplier_inn', 'total_sum'],
  _REQUIRED_FOR_SBER: ['supplier', 'supplier_inn', 'supplier_bik', 'total_sum'],

  _FIELD_LABELS: {
    invoice_number: 'Номер накладной',
    invoice_date: 'Дата (YYYY-MM-DD)',
    supplier: 'Поставщик (название)',
    supplier_inn: 'ИНН поставщика',
    supplier_kpp: 'КПП поставщика',
    supplier_bik: 'БИК банка',
    supplier_account: 'Р/с поставщика',
    supplier_corr_account: 'К/с банка',
    supplier_address: 'Адрес поставщика',
    total_sum: 'Сумма',
    vat_sum: 'В т.ч. НДС',
  },

  _missingFields(invoice, fields) {
    return fields.filter(f => {
      const v = invoice[f];
      if (v == null || v === '') return true;
      if (typeof v === 'number' && (!isFinite(v) || v <= 0)) return true;
      return false;
    });
  },

  async editHeader(id) {
    try {
      const j = await App.apiJson(`/invoices/${id}`);
      this._openEditModal({
        invoice: j.data,
        title: 'Редактирование реквизитов',
        onSaved: () => this.showDetail(id),
      });
    } catch (e) {
      App.notify('Не удалось загрузить накладную: ' + e.message, 'error');
    }
  },

  /**
   * Открывает модалку редактирования header'а накладной.
   *
   * options:
   *   - invoice: current invoice data
   *   - title: заголовок модалки
   *   - requiredFields: какие поля показать как «обязательные» (asterisk + красный)
   *   - reasonText: подзаголовок «Не хватает: …» при pre-flight failure
   *   - onSaved: () => void — callback после успешного PATCH (retry send 1C / Sber)
   */
  _openEditModal({ invoice, title = 'Реквизиты накладной', requiredFields = [], reasonText = '', onSaved = () => {} }) {
    let modal = document.getElementById('invoice-edit-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'invoice-edit-modal';
      modal.className = 'modal-backdrop';
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:none;align-items:center;justify-content:center;z-index:9999;padding:20px';
      document.body.appendChild(modal);
    }

    const requiredSet = new Set(requiredFields);
    const missing = new Set(this._missingFields(invoice, requiredFields));

    const fieldOrder = [
      'invoice_number', 'invoice_date', 'total_sum', 'vat_sum',
      'supplier', 'supplier_inn', 'supplier_kpp',
      'supplier_bik', 'supplier_account', 'supplier_corr_account',
      'supplier_address',
    ];
    const fieldsHtml = fieldOrder.map(name => {
      const label = this._FIELD_LABELS[name];
      const isRequired = requiredSet.has(name);
      const isMissing = missing.has(name);
      const value = invoice[name] == null ? '' : String(invoice[name]);
      const star = isRequired ? '<span style="color:#dc2626"> *</span>' : '';
      const inputBg = isMissing ? 'background:#fef2f2;border-color:#dc2626' : '';
      const wide = name === 'supplier' || name === 'supplier_address';
      const inputType = name === 'invoice_date' ? 'date' :
                        (name === 'total_sum' || name === 'vat_sum') ? 'number' : 'text';
      const step = inputType === 'number' ? 'step="0.01"' : '';
      return `
        <label style="display:flex;flex-direction:column;gap:4px;${wide ? 'grid-column:1/-1' : ''}">
          <span style="font-size:12px;color:var(--muted,#64748b)">${label}${star}</span>
          <input type="${inputType}" name="${name}" value="${App.esc(value)}" ${step} style="${inputBg}">
        </label>
      `;
    }).join('');

    const reasonBlock = reasonText ? `
      <div style="background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.4);padding:10px 14px;border-radius:8px;margin-bottom:14px;color:rgb(120,53,15)">
        <strong>${App.esc(reasonText)}</strong>
        ${missing.size > 0 ? `<div style="margin-top:6px;font-size:13px">Не хватает: ${Array.from(missing).map(f => `«${App.esc(this._FIELD_LABELS[f] || f)}»`).join(', ')}</div>` : ''}
      </div>` : '';

    modal.innerHTML = `
      <div class="card" style="max-width:700px;width:100%;max-height:90vh;overflow:auto">
        <h3 style="margin-bottom:16px">${App.esc(title)}</h3>
        ${reasonBlock}
        <form id="invoice-edit-form" style="display:grid;grid-template-columns:repeat(2,1fr);gap:14px">
          ${fieldsHtml}
          <div style="grid-column:1/-1;display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
            <button type="button" class="btn btn-ghost" id="invoice-edit-cancel">Отмена</button>
            <button type="submit" class="btn btn-primary">Сохранить</button>
          </div>
        </form>
      </div>
    `;
    modal.style.display = 'flex';

    modal.querySelector('#invoice-edit-cancel').onclick = () => { modal.style.display = 'none'; };
    modal.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };

    const form = modal.querySelector('#invoice-edit-form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const update = {};
      for (const [k, v] of fd.entries()) {
        update[k] = v;  // backend сам trim'ит и преобразует
      }
      try {
        const res = await App.api(`/invoices/${invoice.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(update),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          App.notify(err.error || 'Ошибка сохранения', 'error');
          return;
        }
        App.notify('Реквизиты обновлены', 'success');
        modal.style.display = 'none';
        await onSaved();
      } catch (err) {
        App.notify('Ошибка: ' + err.message, 'error');
      }
    };

    // Auto-focus на первое missing-поле для pre-flight кейса
    if (missing.size > 0) {
      const firstMissing = Array.from(missing)[0];
      const inp = form.querySelector(`[name="${firstMissing}"]`);
      if (inp) inp.focus();
    }
  },

  async sendTo1C(id) {
    return this._withGuard(`send:${id}`, async () => {
      let invoice;
      try {
        const j = await App.apiJson(`/invoices/${id}`);
        invoice = j.data;
      } catch (e) {
        App.notify('Не удалось загрузить накладную', 'error');
        return;
      }

      // Pre-flight: required fields для 1С.
      const missing = this._missingFields(invoice, this._REQUIRED_FOR_1C);
      if (missing.length > 0) {
        this._openEditModal({
          invoice,
          title: 'Дозаполните реквизиты для отправки в 1С',
          requiredFields: this._REQUIRED_FOR_1C,
          reasonText: '1С не примет накладную без этих полей',
          onSaved: () => this.sendTo1C(id),  // retry после сохранения
        });
        return;
      }

      // Если есть несопоставленные товары — обычное подтверждение.
      const unmappedCount = (invoice.items || []).filter(it => !it.onec_guid).length;
      if (unmappedCount > 0) {
        const ok = confirm(
          `В накладной ${unmappedCount} несопоставленных товар(ов).\n\n` +
          `При загрузке в 1С они будут созданы как НОВЫЕ позиции в справочнике Номенклатура по их названию из скана.\n\n` +
          `Продолжить?`
        );
        if (!ok) return;
      }
      try {
        await App.apiJson(`/invoices/${id}/send`, { method: 'POST' });
        App.notify('Накладная помечена для отправки. Загрузите через обработку в 1С.', 'success');
        this.showDetail(id);
      } catch (e) {
        App.notify('Ошибка: ' + e.message, 'error');
      }
    });
  },

  async unapproveForOneC(id) {
    return this._withGuard(`unapprove:${id}`, async () => {
      try {
        await App.apiJson(`/invoices/${id}/unapprove`, { method: 'POST' });
        App.notify('Отправка отозвана', 'success');
        this.showDetail(id);
      } catch (e) {
        App.notify('Ошибка: ' + e.message, 'error');
      }
    });
  },

  async rescan(id) {
    if (!confirm(
      'Полностью пересканировать фото накладной?\n\n' +
      '• Запустит OCR + Claude API заново для исходного изображения.\n' +
      '• Текущие позиции будут заменены новыми.\n' +
      '• Если это была отметка «дубликат» — она снимется.\n' +
      '• Стоит API-вызов Claude.\n\n' +
      'Продолжить?'
    )) return;
    return this._withGuard(`rescan:${id}`, async () => {
      try {
        App.notify('Пересканирование запущено, ожидайте 10–30 сек…', 'info');
        const res = await App.api(`/invoices/${id}/rescan`, { method: 'POST' });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          App.notify(err.error || `Ошибка ${res.status}`, 'error');
          return;
        }
        App.notify('Накладная пересканирована', 'success');
        this.showDetail(id);
      } catch (e) {
        App.notify('Ошибка: ' + e.message, 'error');
      }
    });
  },

  async remap(id, forceAll) {
    return this._withGuard(`remap:${id}`, async () => {
      const url = forceAll ? `/invoices/${id}/remap?all=true` : `/invoices/${id}/remap`;
      try {
        const data = await App.apiJson(url, { method: 'POST' });
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
      } catch (e) {
        App.notify('Ошибка: ' + e.message, 'error');
      }
    });
  },

  async llmRemap(id, all = false) {
    return this._withGuard(`llmRemap:${id}`, async () => {
      App.notify(all ? 'Пересобираем все маппинги через Claude…' : 'Отправляем несопоставленные товары в Claude…', 'info');
      try {
        const url = all ? `/invoices/${id}/llm-remap?all=true` : `/invoices/${id}/llm-remap`;
        const data = await App.apiJson(url, { method: 'POST' });
        const requested = data.data?.requested ?? 0;
        const matched = data.data?.matched ?? 0;
        const changed = data.data?.changed ?? 0;
        if (requested === 0) {
          App.notify(all ? 'В накладной нет товаров' : 'Нет несопоставленных товаров', 'success');
        } else if (all) {
          if (changed === 0) App.notify(`LLM подтвердил текущие сопоставления (${matched} из ${requested})`, 'success');
          else App.notify(`LLM обновил ${changed} из ${requested} (подтверждено ${matched})`, 'success');
        } else if (matched === 0) {
          App.notify(`LLM не нашёл совпадений (${requested} товаров)`, 'error');
        } else {
          App.notify(`LLM сопоставил ${matched} из ${requested} товаров`, 'success');
        }
        this.showDetail(id);
      } catch (e) {
        App.notify('Ошибка LLM-маппинга: ' + e.message, 'error');
      }
    });
  },

  async resetStatus(id) {
    if (!confirm('Сбросить статус накладной? Она станет "Обработан" и исчезнет из списка готовых к 1С. Для повторной отправки нужно будет снова нажать "Отправить в 1С".')) {
      return;
    }
    return this._withGuard(`reset:${id}`, async () => {
      try {
        await App.apiJson(`/invoices/${id}/reset`, { method: 'POST' });
        App.notify('Статус сброшен', 'success');
        this.showDetail(id);
      } catch (e) {
        App.notify('Ошибка: ' + e.message, 'error');
      }
    });
  },

  async unlinkDuplicate(id) {
    if (!confirm('Снять отметку «дубликат»? Накладная превратится в обычную (status=processed), но items в неё не вернутся — для полноценной обработки нужно её удалить и переотсканировать.')) return;
    try {
      const res = await App.api(`/invoices/${id}/unlink-duplicate`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        App.notify(err.error || 'Ошибка', 'error');
        return;
      }
      App.notify('Отметка снята', 'success');
      this.showDetail(id);
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
        return this._withGuard(`delete:${id}`, async () => {
          try {
            await App.apiJson(`/invoices/${id}`, { method: 'DELETE' });
            App.notify('Накладная удалена', 'success');
            App.navigate('#/invoices');
            this.showList();
          } catch (e) {
            App.notify('Ошибка удаления: ' + e.message, 'error');
          }
        });
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

  // Save the editable qty/unit/price/total on blur. Only sends a PATCH if the
  // value actually changed (to avoid spamming the server when user tabs through).
  async onItemEdit(event) {
    const el = event.target;
    const { invoiceId, itemId, field } = el.dataset;
    const raw = el.value.trim().replace(',', '.');
    // Remember the last-saved value per input to avoid pointless PATCHes.
    const prev = el.dataset.lastSaved ?? el.defaultValue.trim().replace(',', '.');
    if (raw === prev) return;

    let payload;
    if (field === 'unit') {
      payload = { unit: raw || null };
    } else {
      if (raw === '') {
        payload = { [field]: null };
      } else {
        const n = Number(raw);
        if (!Number.isFinite(n)) {
          App.notify('Некорректное число', 'error');
          el.value = prev.replace('.', ',');
          return;
        }
        payload = { [field]: n };
      }
    }

    const guardToken = `item-edit:${itemId}:${field}`;
    return this._withGuard(guardToken, async () => {
      try {
        const resp = await App.apiJson(`/invoices/${invoiceId}/items/${itemId}`, {
          method: 'PATCH',
          body: payload,
        });
        el.dataset.lastSaved = raw;
        // Refresh sibling cells (total may have been auto-derived, plus the
        // invoice-level total badge). Safest: reload the whole detail.
        this.showDetail(Number(invoiceId));
        if (resp?.data?.items_total_mismatch === 0) {
          App.notify('Сохранено', 'success');
        } else {
          App.notify('Сохранено. Сумма расходится с документом — проверьте', 'info');
        }
      } catch (e) {
        App.notify('Не сохранилось: ' + e.message, 'error');
        el.value = prev.replace('.', ',');
      }
    });
  },

  onItemEditKey(event) {
    // Enter commits by losing focus. Escape reverts.
    if (event.key === 'Enter') {
      event.preventDefault();
      event.target.blur();
    } else if (event.key === 'Escape') {
      const el = event.target;
      const prev = el.dataset.lastSaved ?? el.defaultValue;
      el.value = prev;
      el.blur();
    }
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

      // URL comes from the server but still passes through escape — defence in depth
      // against a compromised backend or badly-sanitised filename returned by the API.
      container.innerHTML = data.map((photo, i) => {
        const safeUrl = encodeURI(String(photo.url || ''));
        const safeName = App.esc(photo.filename);
        return `
        <div style="margin-bottom:16px">
          <div style="margin-bottom:4px;color:#888;font-size:13px">Лист ${i + 1}: ${safeName}</div>
          <img src="${safeUrl}?key=${encodeURIComponent(App.apiKey)}" alt="${safeName}"
               style="max-width:100%;border:1px solid #e0e0e0;border-radius:6px"
               onerror="this.outerHTML='<div class=\\'empty-state\\'>Файл не найден на диске</div>'">
        </div>`;
      }).join('');
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
