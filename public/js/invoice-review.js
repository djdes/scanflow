/* global App, Invoices, InvoiceCard, InvoicePhotoViewer */
'use strict';
// Сверка накладной со сканом (спек docs/superpowers/specs/2026-10-09-invoice-card-redesign-design.md).
// Панель шага «Сверка» (#invoice-decision): шесть реквизитов и замечания проверки.
// Скан — правая панель (#invoice-source-workspace): листы, масштаб, поворот, рамки ИИ,
// сверка реквизита («Совпадает» / «Исправить») и правка значения. Файл скана не меняется:
// поворот только для просмотра, правка значения уходит в журнал правок.
const irEl = (id) => document.getElementById(id);
const irIcon = (paths, size = 16, stroke = 2) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const InvoiceReview = {
    labels: { invoice_number: 'Номер', invoice_date: 'Дата', supplier: 'Поставщик', supplier_inn: 'ИНН', total_sum: 'Итог документа', vat_sum: 'НДС', quantity: 'Количество', unit: 'Единица', price: 'Цена с НДС', total: 'Сумма строки', row: 'Строка товара' },
    attrs: { number: 'Номер', date: 'Дата', supplier: 'Поставщик', total: 'Сумма', vat: 'НДС', vat_rate: 'Ставки НДС' },
    // Где на листе искать реквизит: у ставок НДС своей рамки нет — смотрим сумму НДС.
    ATTR_TARGET: { number: 'header:invoice_number', date: 'header:invoice_date', supplier: 'header:supplier', total: 'header:total_sum', vat: 'header:vat_sum', vat_rate: 'header:vat_sum' },
    ICON: {
        minus: irIcon('<path d="M5 12h14"/>'),
        plus: irIcon('<path d="M5 12h14"/><path d="M12 5v14"/>'),
        fit: irIcon('<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/>'),
        rotL: irIcon('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>'),
        rotR: irIcon('<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>'),
        expand: irIcon('<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>'),
        close: irIcon('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
        check: irIcon('<path d="M20 6 9 17l-5-5"/>', 13, 3),
    },
    session: false, seen: [], page: 0, zoom: 1, rotation: 0, open: false, binding: false,
    files: [], allFiles: [], regions: [], pendingVerify: null, editing: false, built: null,

    // ── Жизненный цикл ─────────────────────────────────────────────────────
    reset(id) {
        if (this.cancelConfirm)
            this.cancelConfirm();
        clearTimeout(this.timer);
        this.request = (this.request || 0) + 1;
        this.compareOpen = false;
        const comparison = irEl('invoice-comparison');
        if (comparison)
            comparison.hidden = true;
        if (this.id !== id) {
            // Скан остаётся открытым при переходе стрелками ←/→ — но уже с листом новой накладной.
            this.open = this.session || (this.open && this.id != null);
            this.target = 'header:total_sum';
            this.page = 0;
            this.zoom = 1;
            this.rotation = 0;
            this.files = [];
            this.allFiles = [];
            this.regions = [];
            this.state = null;
            this.pendingVerify = null;
            this.editing = false;
            this.built = null;
            this.filesSig = null;
            const decision = irEl('invoice-decision');
            if (decision)
                decision.innerHTML = '<p class="ic-muted">Загрузка проверки…</p>';
            if (this.open)
                this.drawerLoading();
            else
                this.showDrawer(false);
        }
        this.id = id;
        this.focusPending = false;
        this.invoice = null;
        this.binding = false;
        this.drag = null;
        this.pan = null;
    },
    leave() {
        clearTimeout(this.timer);
        this.request = (this.request || 0) + 1;
        this.session = false;
        this.invoice = null;
        this.id = null;
        this.open = false;
        this.pendingVerify = null;
        if (this.cancelConfirm)
            this.cancelConfirm();
        this.showDrawer(false);
    },
    confirm(title, text, options = {}) {
        if (this.cancelConfirm)
            this.cancelConfirm();
        return new Promise(resolve => {
            const dialog = document.createElement('dialog');
            dialog.className = 'review-confirm';
            dialog.innerHTML = `<h3>${App.esc(title)}</h3><p>${App.esc(text)}</p><div class="review-decision-actions"><button type="button" class="btn btn-outline" data-cancel>Отмена</button><button type="button" class="btn btn-primary" data-ok>${App.esc(options.okText || 'Подтвердить')}</button></div>`;
            const done = value => { dialog.close(); dialog.remove(); this.cancelConfirm = null; resolve(value); };
            this.cancelConfirm = () => done(false);
            dialog.querySelector('[data-cancel]').onclick = () => done(false);
            dialog.querySelector('[data-ok]').onclick = () => done(true);
            dialog.oncancel = e => { e.preventDefault(); done(false); };
            document.body.appendChild(dialog);
            dialog.showModal();
        });
    },
    async start() { this.seen = []; this.session = true; await this.next(false); },
    async next(skip = true) {
        if (this.nextBusy)
            return;
        this.nextBusy = true;
        try {
            if (skip && this.id && !this.seen.includes(this.id))
                this.seen.push(this.id);
            const { data } = await App.apiJson('/invoices/review/next?exclude=' + encodeURIComponent(this.seen.slice(-500).join(',')));
            if (!data) {
                this.session = false;
                if (this.invoice)
                    this.renderDecision();
                App.notify(this.seen.length ? 'В этой сессии больше нет документов для проверки. Пропущенные остаются в очереди.' : 'Нет документов для проверки', 'success');
                return;
            }
            this.session = true;
            this.open = true;
            Invoices.openInvoice(data.id);
        }
        catch (e) {
            App.notify(e.message || 'Не удалось открыть следующий документ', 'error');
        }
        finally {
            this.nextBusy = false;
        }
    },
    async mount(invoice) {
        if (this.id !== invoice.id)
            return;
        this.invoice = invoice;
        this.linkFields();
        this.renderDecision();
        await this.refresh();
        if (this.open && this.id === invoice.id)
            await this.loadSource();
    },
    async refresh() {
        const id = this.id;
        if (!id || !this.invoice)
            return;
        const request = ++this.request;
        try {
            const { data } = await App.apiJson(`/invoices/${id}/review`);
            if (this.id !== id || request !== this.request || Invoices._currentInvoiceId !== id)
                return;
            this.state = data;
            this.regions = data.regions || [];
            this.renderDecision();
            this.drawRegions();
            if (!this.editing)
                this.renderEditor();
            if (data.job?.status === 'running')
                this.timer = setTimeout(() => this.refresh(), 2000);
            else {
                clearTimeout(this.timer);
                if (this.locating && data.job?.status === 'done' && this.locatorContext?.key === this.target && this.locatorContext?.file === this.files[this.page]?.filename) {
                    this.focusRegion();
                    this.renderEditor();
                }
                this.locating = false;
            }
            const status = irEl('review-locate-status');
            if (status)
                status.textContent = data.job?.message || 'Рамки ИИ — подсказки: сверяйте с самим листом.';
            const find = irEl('review-locate');
            if (find)
                find.disabled = data.job?.status === 'running';
        }
        catch (e) {
            const el = irEl('invoice-decision');
            if (this.id === id && el)
                el.innerHTML = `<p class="ic-muted">Проверка недоступна: ${App.esc(e.message)} <button type="button" class="ic-link" onclick="InvoiceReview.refresh()">Повторить</button></p>`;
        }
    },

    // ── Панель шага «Сверка» ───────────────────────────────────────────────
    renderDecision() {
        const inv = this.invoice, el = irEl('invoice-decision');
        if (!inv || !el)
            return;
        const d = this.state?.decision || null;
        const reqs = InvoiceCard.requisites(inv);
        const left = reqs.filter(r => !r.checked).length;
        const xml = App.isXmlInvoice(inv);
        const issues = this.issues(inv, d);
        const head = left
            ? `<b>Сверьте реквизиты ${xml ? 'с документом' : 'со сканом'}</b> <span>— нажмите на реквизит, сравните с бумагой и подтвердите</span>`
            : '<b>Все реквизиты сверены</b> <span>— можно отправлять в 1С и создавать платёжку</span>';
        const eyebrow = this.session ? `<span class="ic-eyebrow">Режим проверки · просмотрено ${this.seen.length}</span>` : '';
        const scanLabel = this.open ? 'Скрыть скан' : xml ? 'Открыть документ' : 'Открыть скан для сверки';
        const lock = d && !d.editable ? this.lockReason(inv) : '';
        el.innerHTML = `
      <div class="ic-verify-head"><div>${eyebrow}${head}</div>
        <button type="button" class="btn ${left && !this.open ? 'btn-primary' : 'btn-outline'} btn-sm" onclick="InvoiceReview.toggleSource()" aria-expanded="${this.open}" aria-controls="invoice-source-workspace">${scanLabel}</button></div>
      <div class="ic-reqs">${reqs.map(r => `<button type="button" class="ic-req${r.checked ? ' is-ok' : ''}${this.pendingVerify === r.key ? ' is-pending' : ''}" aria-pressed="${r.checked}" onclick="InvoiceReview.verify('${r.key}')" title="${r.checked ? 'Сверено. Нажмите, чтобы снять отметку' : 'Нажмите, чтобы сверить со сканом'}"><span>${r.checked ? this.ICON.check : ''}${App.esc(r.label)}</span><b title="${App.esc(r.value)}">${App.esc(r.value)}</b></button>`).join('')}</div>
      ${issues.length ? `<ul class="ic-issues">${issues.map(t => `<li>${App.esc(t)}</li>`).join('')}</ul>` : ''}
      ${lock ? `<p class="ic-muted">${App.esc(lock)}</p>` : ''}
      <div class="ic-panel-actions">
        <button type="button" class="ic-link" onclick="InvoiceReview.compare()">${this.compareOpen ? 'Скрыть сравнение' : 'Сравнить с прошлой поставкой'}</button>
        ${d?.editable ? `<button type="button" class="ic-link" onclick="Invoices.editHeader(${inv.id})">Изменить реквизиты</button>` : ''}
        <button type="button" class="ic-link ic-link--push" onclick="InvoiceReview.next()">${this.session ? 'Пропустить — следующая →' : 'Следующая на проверку →'}</button>
      </div>`;
    },
    /** Замечания проверки простыми словами (дубликат и строки без позиции 1С — в своих блоках). */
    issues(inv, d) {
        const out = [];
        if (inv.status === 'error')
            out.push('Ошибка распознавания — проверьте скан или пересканируйте (меню «⋯»)');
        if (!d)
            return out;
        if (d.missing_header.length)
            out.push('Не заполнено: ' + d.missing_header.map(k => this.labels[k] || k).join(', '));
        if (d.mismatch)
            out.push(`Итог документа ${App.formatMoney(inv.total_sum)} ₽, а сумма строк ${App.formatMoney(d.item_sum)} ₽ — сверьте с бумагой`);
        if (d.quantity.length)
            out.push(`${d.quantity.length} ${InvoiceCard.plural(d.quantity.length, 'строка', 'строки', 'строк')} — проверьте количество и единицы`);
        if (inv.supplier_match === 'name')
            out.push('Поставщик найден по названию, а не по ИНН — сверьте ИНН');
        if (inv.alignment_problems?.length)
            out.push('Возможен сдвиг строк — сверьте таблицу со сканом');
        return out;
    },
    /** Почему правка закрыта — то же условие, что у сервера (editable в src/services/invoiceReview.ts). */
    lockReason(inv) {
        if (!inv)
            return 'Правка сейчас недоступна.';
        if (inv.duplicate_of || inv.status === 'duplicate')
            return 'Дубликат не правится — исправляйте основную накладную.';
        if (inv.status === 'sent_to_1c')
            return 'Накладная уже в 1С — правка закрыта. Чтобы исправить, сбросьте статус «В 1С» в меню «⋯».';
        if (inv.approved_for_1c)
            return 'Накладная ждёт загрузки в 1С — чтобы править, отзовите отправку на шаге «Отправка в 1С».';
        if (inv.paid_externally)
            return 'Накладная оплачена вне сервиса — правка закрыта.';
        if (this.state?.payment && this.state.payment.status !== 'failed')
            return 'По накладной создана платёжка — правка закрыта.';
        if (inv.status !== 'processed')
            return 'Накладная ещё не распознана — править пока нечего.';
        return 'Правка сейчас недоступна.';
    },
    /** Нажатие на реквизит: несверенный — показать на скане и спросить «Совпадает?», сверенный — снять отметку. */
    async verify(attr) {
        const inv = this.invoice;
        if (!inv || !this.attrs[attr])
            return;
        const req = InvoiceCard.requisites(inv).find(r => r.key === attr);
        if (req?.checked) {
            if (this.pendingVerify === attr)
                this.pendingVerify = null;
            await Invoices.toggleAttrCheck(this.id, attr, false);
            return;
        }
        this.pendingVerify = attr;
        this.editing = false;
        await this.select(this.ATTR_TARGET[attr]);
    },
    renderConfirmBar() {
        const el = irEl('review-confirm-bar');
        if (!el)
            return;
        const inv = this.invoice, attr = this.pendingVerify;
        const reqs = inv ? InvoiceCard.requisites(inv) : [];
        const req = attr ? reqs.find(r => r.key === attr) : null;
        const show = !!req && !req.checked;
        el.hidden = !show;
        el.closest('.ic-drawer-foot--docs')?.toggleAttribute('hidden', !show);
        if (!show) {
            el.innerHTML = '';
            return;
        }
        const done = reqs.filter(r => r.checked).length;
        el.innerHTML = `<div class="ic-confirm-text"><small>Сверьте ${this.files.length ? 'со сканом' : 'с документом'} · сверено ${done} из 6</small><b>${App.esc(req.label)}: ${App.esc(req.value)}</b></div>
      <button type="button" class="btn btn-primary btn-sm" id="review-verify-ok">Совпадает</button>
      <button type="button" class="btn btn-outline btn-sm" id="review-verify-fix">Исправить</button>
      <button type="button" class="ic-tool ic-tool--ghost" id="review-verify-skip" aria-label="Не сверять сейчас" title="Не сейчас">${this.ICON.close}</button>`;
        irEl('review-verify-ok').onclick = () => this.confirmVerify();
        irEl('review-verify-fix').onclick = () => this.fixVerify();
        irEl('review-verify-skip').onclick = () => { this.pendingVerify = null; this.renderConfirmBar(); this.renderDecision(); };
    },
    /** «Совпадает»: отметить реквизит и перейти к следующему несверенному. */
    async confirmVerify() {
        const attr = this.pendingVerify, id = this.id;
        if (!attr || this.verifying)
            return;
        this.verifying = true;
        try {
            await Invoices.toggleAttrCheck(id, attr, true);
        }
        finally {
            this.verifying = false;
        }
        if (id !== this.id || !this.invoice)
            return;
        const reqs = InvoiceCard.requisites(this.invoice);
        if (!reqs.find(r => r.key === attr)?.checked)
            return; // отметка не сохранилась — об этом уже сказали
        const order = reqs.map(r => r.key), from = order.indexOf(attr);
        const next = [...order.slice(from + 1), ...order.slice(0, from)].find(k => !reqs.find(r => r.key === k).checked);
        if (next)
            await this.verify(next);
        else {
            this.pendingVerify = null;
            this.renderConfirmBar();
            this.renderDecision();
            App.notify('Все реквизиты сверены', 'success');
        }
    },
    /** «Исправить»: открыть правку значения (ставки НДС правят в строках). */
    fixVerify() {
        if (this.pendingVerify === 'vat_rate') {
            Invoices.switchTab('items');
            App.notify('Ставку НДС меняют в колонке «НДС» у строк или «НДС всем строкам» под таблицей', 'info');
            return;
        }
        if (!this.state?.decision?.editable) {
            App.notify(this.lockReason(this.invoice), 'info');
            return;
        }
        if (!irEl('review-editor')) {
            // PDF или XML — правки на листе нет, реквизиты правят в окне шапки.
            Invoices.editHeader(this.id);
            return;
        }
        this.editing = true;
        this.renderEditor();
        irEl('review-value')?.focus();
    },

    // ── Цели сверки: реквизиты шапки и поля строк ──────────────────────────
    targets() {
        if (!this.invoice)
            return [];
        return [...['invoice_number', 'invoice_date', 'supplier', 'supplier_inn', 'total_sum', 'vat_sum'].map(field => ({ key: 'header:' + field, label: this.labels[field], value: this.invoice[field] })),
            ...(this.invoice.items || []).flatMap((item, i) => ['row', 'quantity', 'unit', 'price', 'total'].map(field => ({ key: `item:${item.id}:${field}`, label: `${i + 1}. ${item.original_name} · ${this.labels[field]}`, value: field === 'row' ? item.original_name : item[field] })))];
    },
    targetInfo() { const parts = (this.target || '').split(':'); return { item: parts[0] === 'item' ? this.invoice?.items.find(i => i.id === Number(parts[1])) : null, field: parts[0] === 'item' ? parts[2] : parts[1], isHeader: parts[0] === 'header' }; },
    rowKey(key) { return key.split(':').slice(0, 2).join(':') + ':row'; },
    /** Фокус в поле строки при открытом скане — показать эту строку на листе. */
    linkFields() {
        document.querySelectorAll('#invoice-items-tbody tr[data-item-id]').forEach(tr => {
            const id = tr.dataset.itemId;
            tr.querySelectorAll('[data-field]').forEach(input => input.addEventListener('focus', () => {
                if (this.open)
                    this.select(`item:${id}:${input.dataset.field}`, false);
            }));
        });
    },
    async select(key, scroll = true) {
        if (!this.targets().some(t => t.key === key))
            return;
        if (this.target !== key)
            this.editing = false;
        this.target = key;
        this.binding = false;
        const region = this.regions.find(r => r.target_key === key && r.filename === this.files[this.page]?.filename)
            || this.regions.find(r => r.target_key === key) || this.regions.find(r => r.target_key === this.rowKey(key));
        if (region) {
            const page = this.files.findIndex(f => f.filename === region.filename);
            if (page >= 0 && page !== this.page) {
                this.page = page;
                this.rotation = this.rotationFor(this.files[page]);
            }
        }
        this.focusPending = !!region;
        const wasOpen = this.open;
        this.open = true;
        this.renderDecision();
        if (!wasOpen || !this.built)
            await this.loadSource();
        else
            this.updateSource();
        document.querySelectorAll('#invoice-items-tbody tr[data-item-id]').forEach(tr => tr.classList.toggle('review-selected', key.startsWith('item:') && tr.dataset.itemId === key.split(':')[1]));
        if (scroll)
            irEl('invoice-source-workspace')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    },

    // ── Правая панель со сканом ────────────────────────────────────────────
    showDrawer(visible) {
        const el = irEl('invoice-source-workspace');
        if (el)
            el.hidden = !visible;
        irEl('ic-layout')?.classList.toggle('is-scan-open', visible);
        document.body.classList.toggle('ic-scan-lock', visible);
        irEl('ic-thumb')?.setAttribute('aria-expanded', String(visible));
        if (!visible) {
            this.disconnectResize();
            this.built = null;
        }
        this.bindEscape(visible);
        this.bindFit(visible);
    },
    /** Высота панели — до низа окна: и у верха карточки, и после прокрутки (панель липнет под шапкой). */
    fitDrawer() {
        const el = irEl('invoice-source-workspace');
        if (!el || el.hidden)
            return;
        if (window.matchMedia('(max-width: 1100px)').matches) {
            el.style.height = '';
            return;
        }
        const top = Math.max(72, el.getBoundingClientRect().top);
        el.style.height = Math.max(360, Math.round(window.innerHeight - top - 12)) + 'px';
    },
    bindFit(on) {
        if (on && !this._fit) {
            let frame = 0;
            this._fit = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => this.fitDrawer()); };
            window.addEventListener('scroll', this._fit, { passive: true });
            window.addEventListener('resize', this._fit);
        }
        else if (!on && this._fit) {
            window.removeEventListener('scroll', this._fit);
            window.removeEventListener('resize', this._fit);
            this._fit = null;
            const el = irEl('invoice-source-workspace');
            if (el)
                el.style.height = '';
        }
        if (on)
            this.fitDrawer();
    },
    /** Esc закрывает скан, если не открыт диалог, меню или поле ввода. */
    bindEscape(on) {
        if (on && !this._esc) {
            this._esc = e => {
                if (e.key !== 'Escape' || !this.open || e.defaultPrevented)
                    return;
                if (document.querySelector('dialog[open], .ic-menu') || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target?.tagName || ''))
                    return;
                // Открыто окно подтверждения или правки реквизитов — Esc относится к нему.
                if ([...document.querySelectorAll('.modal-overlay, .modal-backdrop')].some(m => m.getClientRects().length > 0))
                    return;
                this.toggleSource();
            };
            document.addEventListener('keydown', this._esc);
        }
        else if (!on && this._esc) {
            document.removeEventListener('keydown', this._esc);
            this._esc = null;
        }
    },
    drawerHead(title, tools = '') {
        return `<div class="ic-drawer-head"><h3>${title}</h3>${tools}<button type="button" class="ic-tool" onclick="InvoiceReview.toggleSource()" aria-label="Закрыть скан" title="Закрыть (Esc)">${this.ICON.close}</button></div>`;
    },
    drawerLoading(text = 'Загрузка скана…') {
        const el = irEl('invoice-source-workspace');
        if (!el)
            return;
        this.showDrawer(true);
        this.built = null;
        el.innerHTML = `${this.drawerHead('Скан')}<p class="ic-drawer-note">${App.esc(text)}</p>`;
    },
    async toggleSource() {
        this.open = !this.open;
        if (!this.open) {
            this.pendingVerify = null;
            this.editing = false;
            this.binding = false;
            this.showDrawer(false);
            const el = irEl('invoice-source-workspace');
            if (el)
                el.innerHTML = '';
            document.querySelectorAll('#invoice-items-tbody tr.review-selected').forEach(tr => tr.classList.remove('review-selected'));
            this.renderDecision();
            return;
        }
        this.focusPending = false;
        this.renderDecision();
        await this.loadSource();
    },
    rotationFor(file) { return file ? Invoices._getPhotoRotation(this.id, file.index) : 0; },
    buildKey(file) { return `${this.id}:${file.filename}`; },
    async loadSource() {
        const id = this.id, el = irEl('invoice-source-workspace');
        if (!el || !id)
            return;
        if (!this.built)
            this.drawerLoading();
        else
            this.showDrawer(true);
        try {
            const { data } = await App.apiJson(`/invoices/${id}/photos`);
            if (this.id !== id || !this.open)
                return;
            this.allFiles = (data || []).map((f, index) => ({ ...f, index }));
            this.files = this.allFiles.filter(f => f.exists !== false && /\.(jpe?g|png|webp|bmp|tiff?)$/i.test(f.filename));
            // Набор файлов тот же (перерисовка после правки) — лист и PDF не перезагружаем;
            // добавили страницы или объединили накладные — собираем панель заново.
            const sig = this.allFiles.map(f => `${f.filename}:${f.exists !== false}`).join('|');
            const sameFiles = this.filesSig === sig;
            this.filesSig = sig;
            if (sameFiles && this.built === 'docs:' + id) {
                this.updateSource();
                return;
            }
            const linked = this.target && (this.regions.find(r => r.target_key === this.target) || this.regions.find(r => r.target_key === this.rowKey(this.target)));
            if (linked && this.focusPending) {
                const page = this.files.findIndex(f => f.filename === linked.filename);
                if (page >= 0)
                    this.page = page;
            }
            if (this.page >= this.files.length)
                this.page = 0;
            const file = this.files[this.page];
            this.rotation = this.rotationFor(file);
            if (sameFiles && file && this.built === this.buildKey(file) && irEl('review-image'))
                this.updateSource();
            else
                this.renderSource();
        }
        catch (e) {
            if (this.id === id)
                el.innerHTML = `${this.drawerHead('Скан')}<p class="ic-drawer-note">${App.esc(e.message || 'Скан не загрузился')} <button type="button" class="ic-link" onclick="InvoiceReview.loadSource()">Повторить</button></p>`;
        }
    },
    imageUrl(invId, filename) { return `/api/invoices/${invId}/review/image/${encodeURIComponent(filename)}?key=${encodeURIComponent(App.apiKey)}`; },
    renderSource() {
        const el = irEl('invoice-source-workspace');
        if (!el || !this.invoice || !this.open)
            return;
        this.showDrawer(true);
        this.disconnectResize();
        if (!this.files.length) {
            this.renderDocs(el);
            return;
        }
        const file = this.files[this.page], targets = this.targets(), n = this.files.length, I = this.ICON;
        if (!targets.some(t => t.key === this.target))
            this.target = targets[0]?.key;
        const pages = n > 1 ? `<select id="review-page" class="ic-page-select" aria-label="Лист документа">${this.files.map((f, i) => `<option value="${i}"${i === this.page ? ' selected' : ''}>Лист ${i + 1} из ${n}</option>`).join('')}</select>` : '';
        // PDF и XML рядом с фото (накладная из нескольких файлов) — ссылкой.
        const others = this.allFiles.filter(f => f.exists !== false && !this.files.includes(f));
        el.innerHTML = `${this.drawerHead('Скан', `${pages}<div class="ic-tools" role="toolbar" aria-label="Масштаб и поворот листа">
        <button type="button" class="ic-tool" data-act="out" aria-label="Уменьшить" title="Уменьшить">${I.minus}</button>
        <output class="ic-zoom" id="review-zoom">${Math.round(this.zoom * 100)}%</output>
        <button type="button" class="ic-tool" data-act="in" aria-label="Увеличить" title="Увеличить">${I.plus}</button>
        <button type="button" class="ic-tool" data-act="fit" aria-label="Вписать лист по ширине" title="По ширине">${I.fit}</button>
        <button type="button" class="ic-tool" data-act="rotl" aria-label="Повернуть лист влево" title="Повернуть влево">${I.rotL}</button>
        <button type="button" class="ic-tool" data-act="rotr" aria-label="Повернуть лист вправо" title="Повернуть вправо">${I.rotR}</button>
        <button type="button" class="ic-tool" data-act="full" aria-label="Открыть лист на весь экран" title="На весь экран">${I.expand}</button></div>`)}
      <div class="review-photo-viewport" id="review-viewport" tabindex="0" aria-label="Скан накладной. Ctrl и колесо мыши — масштаб, перетаскивание — сдвиг">
        <div class="ic-rot-wrap" id="review-rot"><div class="review-photo-surface" id="review-surface">
          <img id="review-image" draggable="false" src="${this.imageUrl(this.id, file.filename)}" alt="Скан накладной, лист ${this.page + 1}">
          <div id="review-regions"></div><div id="review-drag" hidden></div><div id="review-on-photo" hidden></div>
        </div></div>
      </div>
      <div class="ic-drawer-foot">
        <div id="review-confirm-bar" class="ic-confirm" hidden></div>
        <div class="ic-target"><label for="review-target">Сверяем</label><select id="review-target">${targets.map(t => `<option value="${t.key}"${this.target === t.key ? ' selected' : ''}>${App.esc(t.label)}</option>`).join('')}</select></div>
        <div id="review-editor" class="ic-edit"></div>
        <div class="ic-drawer-tools">
          <button type="button" class="ic-link" id="review-locate"${this.state?.job?.status === 'running' ? ' disabled' : ''}>Найти на листе</button>
          <button type="button" class="ic-link" id="review-bind">Выделить вручную</button>
          <button type="button" class="ic-link" id="review-unbind">Убрать выделение</button>
          ${others.map(f => /\.xml$/i.test(f.filename)
            ? `<a class="ic-link" href="${Invoices._fileUrl(f)}" download>Скачать XML</a>`
            : `<a class="ic-link" href="${Invoices._fileUrl(f)}" target="_blank" rel="noopener">Открыть ${App.esc(f.filename)}</a>`).join('')}
        </div>
        <p id="review-locate-status" class="ic-drawer-status" aria-live="polite">${App.esc(this.state?.job?.message || 'Рамки ИИ — подсказки: сверяйте с самим листом.')}</p>
      </div>`;
        el.querySelector('.ic-tools').onclick = e => {
            const act = e.target.closest('[data-act]')?.dataset.act;
            if (act === 'out')
                this.zoomTo(this.zoom - 0.5);
            if (act === 'in')
                this.zoomTo(this.zoom + 0.5);
            if (act === 'fit')
                this.zoomTo(1);
            if (act === 'rotl')
                this.rotate(-90);
            if (act === 'rotr')
                this.rotate(90);
            if (act === 'full')
                this.fullscreen();
        };
        const pageSelect = irEl('review-page');
        if (pageSelect)
            pageSelect.onchange = e => { this.page = Number(e.target.value); this.binding = false; this.zoom = 1; this.rotation = this.rotationFor(this.files[this.page]); this.renderSource(); };
        irEl('review-target').onchange = e => this.select(e.target.value, false);
        irEl('review-locate').onclick = () => this.locate();
        irEl('review-bind').onclick = () => this.beginBind();
        irEl('review-unbind').onclick = () => this.removeRegion();
        const img = irEl('review-image');
        img.onload = () => { this.applyLayout(); this.drawRegions(); this.placeEditor(); if (this.focusPending) this.focusRegion(); };
        img.onerror = () => { const s = irEl('review-locate-status'); if (s) s.textContent = 'Лист не открылся. Закройте скан и откройте его ещё раз.'; };
        this.built = this.buildKey(file);
        this.applyLayout();
        this.installPointer();
        this.observeResize();
        this.drawRegions();
        this.renderEditor();
        this.renderConfirmBar();
    },
    /** Тот же лист уже на экране — обновить рамки и правку, не перезагружая картинку. */
    updateSource() {
        if (!this.open || !this.invoice)
            return;
        const file = this.files[this.page];
        if (!file) {
            this.renderConfirmBar();
            return;
        }
        if (this.built !== this.buildKey(file) || !irEl('review-image')) {
            this.renderSource();
            return;
        }
        const select = irEl('review-target');
        if (select)
            select.value = this.target;
        this.drawRegions();
        this.renderEditor();
        this.renderConfirmBar();
        const img = irEl('review-image');
        if (this.focusPending && img.complete && img.naturalWidth)
            this.focusRegion();
    },
    /** Документ без фото: PDF показываем в панели, XML — описанием и ссылкой. */
    renderDocs(el) {
        const xml = App.isXmlInvoice(this.invoice);
        el.innerHTML = `${this.drawerHead(xml ? 'Документ' : 'Скан')}
      <div class="ic-drawer-docs" id="invoice-photos-container"><p class="ic-drawer-note">Загрузка…</p></div>
      <div class="ic-drawer-foot ic-drawer-foot--docs" hidden><div id="review-confirm-bar" class="ic-confirm" hidden></div></div>`;
        this.built = 'docs:' + this.id;
        this.renderConfirmBar();
        Invoices.loadPhotos();
    },
    // Поворот и масштаб. transform не меняет размер блока, поэтому повёрнутый лист
    // раскладываем руками: обёртка #review-rot занимает экранный габарит, лист внутри
    // повёрнут вокруг левого верхнего угла и сдвинут обратно в обёртку.
    applyLayout() {
        const vp = irEl('review-viewport'), rot = irEl('review-rot'), surface = irEl('review-surface'), img = irEl('review-image');
        if (!vp || !rot || !surface)
            return;
        const label = irEl('review-zoom');
        if (label)
            label.textContent = Math.round(this.zoom * 100) + '%';
        const deg = this.rotation;
        surface.classList.toggle('is-rotated', !!deg);
        if (!deg || !img?.naturalWidth) {
            Object.assign(rot.style, { width: '', height: '' });
            Object.assign(surface.style, { position: '', left: '', top: '', width: this.zoom * 100 + '%', height: '', minWidth: '', transform: '', transformOrigin: '', visibility: deg ? 'hidden' : '' });
            this.placeEditor();
            return;
        }
        const width = vp.clientWidth, w = img.naturalWidth, h = img.naturalHeight, quarter = deg === 90 || deg === 270;
        const sw = quarter ? this.zoom * width * (w / h) : this.zoom * width, sh = sw * h / w;
        Object.assign(rot.style, { width: (quarter ? sh : sw) + 'px', height: (quarter ? sw : sh) + 'px' });
        const shift = deg === 90 ? `translate(${sh}px, 0)` : deg === 270 ? `translate(0, ${sw}px)` : `translate(${sw}px, ${sh}px)`;
        Object.assign(surface.style, { position: 'absolute', left: '0', top: '0', width: sw + 'px', height: sh + 'px', minWidth: '0', transformOrigin: '0 0', transform: `${shift} rotate(${deg}deg)`, visibility: '' });
    },
    /** Масштаб с сохранением точки под курсором (по умолчанию — центра). */
    zoomTo(zoom, ax, ay) {
        const vp = irEl('review-viewport');
        if (!vp)
            return;
        const next = Math.max(1, Math.min(4, zoom));
        const x = ax ?? vp.clientWidth / 2, y = ay ?? vp.clientHeight / 2;
        const fx = (vp.scrollLeft + x) / Math.max(1, vp.scrollWidth), fy = (vp.scrollTop + y) / Math.max(1, vp.scrollHeight);
        this.zoom = next;
        this.applyLayout();
        vp.scrollLeft = fx * vp.scrollWidth - x;
        vp.scrollTop = fy * vp.scrollHeight - y;
        this.placeEditor();
    },
    setZoom(delta) { this.zoomTo(this.zoom + delta); },
    rotate(delta) {
        const file = this.files[this.page];
        if (!file)
            return;
        this.rotation = ((this.rotation + delta) % 360 + 360) % 360;
        Invoices._savePhotoRotation(this.id, file.index, this.rotation);
        const pop = irEl('review-on-photo');
        if (pop)
            pop.hidden = true;
        this.zoom = 1;
        this.applyLayout();
        const vp = irEl('review-viewport');
        if (vp) {
            vp.scrollLeft = 0;
            vp.scrollTop = 0;
        }
    },
    fullscreen() {
        if (!this.files.length)
            return;
        const pages = this.files.map(f => ({ src: this.imageUrl(this.id, f.filename), page: f.index, name: f.filename, rotation: this.rotationFor(f) }));
        InvoicePhotoViewer.open(pages, this.files[this.page].index, `Накладная ${this.invoice?.invoice_number || '#' + this.id}`, (index, delta) => {
            const deg = ((Invoices._getPhotoRotation(this.id, index) + delta) % 360 + 360) % 360;
            Invoices._savePhotoRotation(this.id, index, deg);
            if (this.files[this.page]?.index === index) {
                this.rotation = deg;
                this.zoom = 1;
                this.applyLayout();
            }
        });
    },
    observeResize() {
        const vp = irEl('review-viewport');
        if (!vp || typeof ResizeObserver === 'undefined')
            return;
        this._ro = new ResizeObserver(() => { if (this.rotation) this.applyLayout(); this.placeEditor(); });
        this._ro.observe(vp);
    },
    disconnectResize() { this._ro?.disconnect(); this._ro = null; },
    // Доли листа ↔ доли экранного прямоугольника при повороте по часовой стрелке на deg.
    // Рамки хранятся в долях неповёрнутого листа; экран — то, что видно после поворота.
    sheetToScreen(deg, x, y) {
        if (deg === 90)
            return { u: 1 - y, v: x };
        if (deg === 180)
            return { u: 1 - x, v: 1 - y };
        if (deg === 270)
            return { u: y, v: 1 - x };
        return { u: x, v: y };
    },
    screenToSheet(deg, u, v) {
        if (deg === 90)
            return { x: v, y: 1 - u };
        if (deg === 180)
            return { x: 1 - u, y: 1 - v };
        if (deg === 270)
            return { x: 1 - v, y: u };
        return { x: u, y: v };
    },
    focusRegion() {
        this.focusPending = false;
        const region = this.activeRegion(), vp = irEl('review-viewport'), surface = irEl('review-surface'), rot = irEl('review-rot');
        if (!region || !vp || !surface || !rot)
            return;
        this.zoom = region.width < .3 ? 2.5 : 1.5;
        this.applyLayout();
        const deg = this.rotation, width = deg ? rot.offsetWidth : surface.offsetWidth, height = deg ? rot.offsetHeight : surface.offsetHeight;
        const { u, v } = this.sheetToScreen(deg, region.x + region.width / 2, region.y + region.height / 2);
        vp.scrollLeft = Math.max(0, u * width - vp.clientWidth / 2);
        vp.scrollTop = Math.max(0, v * height - vp.clientHeight / 2);
        this.placeEditor();
    },
    activeRegion() {
        if (!this.target)
            return undefined;
        const filename = this.files[this.page]?.filename;
        return this.regions.find(r => r.target_key === this.target && r.filename === filename) || this.regions.find(r => r.target_key === this.rowKey(this.target) && r.filename === filename);
    },
    drawRegions() {
        const el = irEl('review-regions');
        if (!el || !this.files.length)
            return;
        const filename = this.files[this.page].filename, active = this.activeRegion();
        el.innerHTML = this.regions.filter(r => r.filename === filename).map(r => `<button type="button" class="review-region ${r === active ? 'active' : ''} ${r.target_key.endsWith(':row') ? '' : 'field-region'} ${r.origin === 'ai' ? 'ai' : ''}" style="left:${r.x * 100}%;top:${r.y * 100}%;width:${r.width * 100}%;height:${r.height * 100}%" data-key="${App.esc(r.target_key)}" aria-label="${App.esc(this.targets().find(t => t.key === r.target_key)?.label || r.target_key)}" title="${App.esc((r.origin === 'ai' ? 'Нашёл ИИ · ' : 'Выделено вручную · ') + (r.printed_text || ''))}"></button>`).join('');
        el.querySelectorAll('button').forEach(b => b.onclick = e => {
            e.stopPropagation();
            if (this.binding)
                return;
            this.target = b.dataset.key;
            this.editing = false;
            const select = irEl('review-target');
            if (select)
                select.value = this.target;
            this.drawRegions();
            this.renderEditor(true);
        });
    },
    fmt(field, v) {
        if (v == null || v === '')
            return '—';
        if (['total_sum', 'vat_sum', 'price', 'total'].includes(field))
            return `${App.formatMoney(v)} ₽`;
        if (field === 'invoice_date')
            return App.formatDate(v);
        if (field === 'quantity')
            return App.formatQty(v);
        return String(v);
    },
    renderEditor(onPhoto = false) {
        const el = irEl('review-editor');
        if (!el || !this.invoice)
            return;
        const info = this.targetInfo(), t = this.targets().find(x => x.key === this.target), r = this.activeRegion();
        const pop = irEl('review-on-photo');
        if (pop)
            pop.hidden = true;
        if (!t) {
            el.innerHTML = '';
            return;
        }
        if (info.field === 'row') {
            el.innerHTML = `<div class="ic-edit-fields">${['quantity', 'unit', 'price', 'total'].map(field => `<button type="button" class="ic-edit-field" data-select="item:${info.item.id}:${field}"><small>${this.labels[field]}</small><b>${App.esc(this.fmt(field, info.item[field]))}</b></button>`).join('')}</div>`;
            el.querySelectorAll('[data-select]').forEach(b => b.onclick = () => this.select(b.dataset.select, false));
            return;
        }
        const editable = !!this.state?.decision?.editable;
        const numeric = ['quantity', 'price', 'total', 'total_sum', 'vat_sum'].includes(info.field);
        const now = `<div class="ic-edit-val"><small>В накладной</small><b>${App.esc(this.fmt(info.field, t.value))}</b></div>`;
        const seen = r
            ? `<div class="ic-edit-val"><small>${r.origin === 'ai' ? 'На скане · нашёл ИИ' : 'На скане · выделено'}</small><b>${App.esc(r.printed_text || 'см. рамку на листе')}</b></div>`
            : '<div class="ic-edit-val ic-edit-val--none"><small>На скане</small><b>не отмечено</b></div>';
        if (!this.editing) {
            el.innerHTML = `<div class="ic-edit-row">${now}${seen}<button type="button" class="btn btn-outline btn-sm" id="review-edit-open"${editable ? '' : ` disabled title="${App.esc(this.lockReason(this.invoice))}"`}>Исправить</button></div>`;
            irEl('review-edit-open').onclick = () => { this.editing = true; this.renderEditor(); irEl('review-value')?.focus(); };
        }
        else {
            el.innerHTML = `<div class="ic-edit-row">${now}${seen}</div>
        <div class="ic-edit-form"><label class="sr-only" for="review-value">Новое значение: ${App.esc(this.labels[info.field])}</label>
          <input id="review-value" type="${info.field === 'invoice_date' ? 'date' : 'text'}"${numeric ? ' inputmode="decimal"' : ''} value="${App.esc(t.value ?? '')}" autocomplete="off">
          <button type="button" class="btn btn-primary btn-sm" id="review-save">Сохранить</button>
          <button type="button" class="btn btn-outline btn-sm" id="review-edit-cancel">Отмена</button></div>
        <p id="review-preview" class="ic-edit-hint"></p>`;
            const input = irEl('review-value');
            input.oninput = () => this.preview();
            input.onkeydown = e => {
                if (e.key === 'Enter') { e.preventDefault(); this.save(); }
                if (e.key === 'Escape') { e.preventDefault(); this.editing = false; this.renderEditor(); }
            };
            irEl('review-save').onclick = () => this.save();
            irEl('review-edit-cancel').onclick = () => { this.editing = false; this.renderEditor(); };
            this.preview();
        }
        // Правка прямо на листе — по нажатию на рамку (на повёрнутом листе — только внизу).
        if (onPhoto && r && editable && !this.rotation && pop) {
            pop.hidden = false;
            pop.innerHTML = `<label>${App.esc(this.labels[info.field])} <small>В накладной: ${App.esc(this.fmt(info.field, t.value))}</small></label><input aria-label="Новое значение" id="review-photo-value" value="${App.esc(t.value ?? '')}"${numeric ? ' inputmode="decimal"' : ''}><div class="review-pop-actions"><button type="button" class="btn btn-primary btn-sm" id="review-photo-save">Сохранить</button><button type="button" class="btn btn-outline btn-sm" id="review-photo-cancel" aria-label="Закрыть">✕</button></div>`;
            irEl('review-photo-save').onclick = () => this.save(irEl('review-photo-value').value);
            irEl('review-photo-cancel').onclick = () => { pop.hidden = true; };
            this.placeEditor();
        }
    },
    placeEditor() {
        const pop = irEl('review-on-photo'), surface = irEl('review-surface'), region = this.activeRegion();
        if (!pop || pop.hidden || !surface || !region || this.rotation)
            return;
        pop.style.left = Math.max(0, Math.min(surface.clientWidth - 230, region.x * surface.clientWidth)) + 'px';
        pop.style.top = Math.max(0, Math.min(surface.clientHeight - 140, (region.y + region.height) * surface.clientHeight)) + 'px';
    },
    parsedValue(raw) {
        const { field } = this.targetInfo(), v = String(raw ?? '').trim();
        if (['quantity', 'price', 'total', 'total_sum', 'vat_sum'].includes(field))
            return v === '' ? null : Number(v.replace(/\s/g, '').replace(',', '.'));
        return v || null;
    },
    previewText(v) {
        const { item, field } = this.targetInfo();
        if (typeof v === 'number' && (!Number.isFinite(v) || v < 0))
            return 'Введите неотрицательное число';
        if (item && ['quantity', 'price', 'total'].includes(field)) {
            const next = field === 'total' ? v : (field === 'quantity' ? v : item.quantity) * (field === 'price' ? v : item.price);
            const old = Number(item.total ?? 0), sum = (this.state?.decision?.item_sum ?? 0) - old + Number(next ?? 0);
            return `Сумма строки: ${App.formatMoney(old)} → ${App.formatMoney(next)} ₽. По товарам: ${App.formatMoney(sum)} ₽, итог документа ${App.formatMoney(this.invoice.total_sum)} ₽ не меняется.`;
        }
        if (item && field === 'unit')
            return 'Меняется только единица: количество и цена сами не пересчитываются — сверьте их по скану.';
        return 'После сохранения этот реквизит нужно будет сверить заново.';
    },
    preview() {
        const el = irEl('review-preview');
        if (el)
            el.textContent = this.previewText(this.parsedValue(irEl('review-value')?.value));
    },
    async save(raw) {
        if (this.saving)
            return;
        const id = this.id, key = this.target, { item, field } = this.targetInfo();
        const value = this.parsedValue(raw ?? irEl('review-value')?.value);
        const t = this.targets().find(x => x.key === key);
        if (!t || !this.state?.decision?.editable)
            return;
        if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) {
            App.notify('Некорректное число', 'error');
            return;
        }
        if (!await this.confirm('Сохранить исправление?', `${this.labels[field]}: ${this.fmt(field, t.value)} → ${value == null ? 'пусто' : this.fmt(field, value)}.\n${this.previewText(value)}`, { okText: 'Сохранить' }))
            return;
        if (this.id !== id || this.target !== key)
            return;
        this.saving = true;
        const body = { field, value, expected: t.value ?? null, item_id: item?.id ?? null };
        if (item)
            body.expected_row = Object.fromEntries(['quantity', 'unit', 'price', 'total'].map(k => [k, item[k] ?? null]));
        try {
            await App.apiJson(`/invoices/${id}/review/edit`, { method: 'PATCH', body });
            App.notify('Исправление сохранено. Связанные реквизиты нужно сверить снова.', 'success');
            this.editing = false;
            if (this.id === id)
                await Invoices.showDetail(id);
        }
        catch (e) {
            App.notify(e.message || 'Не удалось сохранить', 'error');
        }
        finally {
            this.saving = false;
        }
    },
    async locate() {
        const id = this.id, file = this.files[this.page], b = irEl('review-locate');
        if (!file || !b)
            return;
        b.disabled = true;
        this.locating = true;
        this.locatorContext = { key: this.target, file: file.filename };
        try {
            await App.apiJson(`/invoices/${id}/review/locate`, { method: 'POST', body: { filename: file.filename, target_key: this.target } });
            if (this.id === id)
                await this.refresh();
        }
        catch (e) {
            this.locating = false;
            App.notify(e.message || 'Поиск недоступен', 'error');
            if (this.id === id)
                b.disabled = false;
        }
    },
    beginBind() {
        const surface = irEl('review-surface');
        if (!surface)
            return;
        this.binding = true;
        this.drag = null;
        const pop = irEl('review-on-photo');
        if (pop)
            pop.hidden = true;
        surface.classList.add('binding');
        const status = irEl('review-locate-status');
        if (status)
            status.textContent = 'Обведите значение или строку на листе рамкой — потом подтвердите привязку.';
    },
    // Мышь: перетаскивание листа — сдвиг, Ctrl + колесо — масштаб; в режиме «Выделить вручную» — рамка.
    // Экранная точка переводится в координаты неповёрнутого листа (в них хранятся рамки).
    installPointer() {
        const surface = irEl('review-surface'), vp = irEl('review-viewport'), rectEl = irEl('review-drag');
        if (!surface || !vp || !rectEl)
            return;
        const clamp = v => Math.max(0, Math.min(1, v));
        const point = e => {
            const r = surface.getBoundingClientRect();
            return this.screenToSheet(this.rotation, clamp((e.clientX - r.left) / r.width), clamp((e.clientY - r.top) / r.height));
        };
        surface.onpointerdown = e => {
            if (e.button !== 0)
                return;
            if (this.binding) {
                if (!irEl('review-image')?.naturalWidth)
                    return;
                e.preventDefault();
                surface.setPointerCapture(e.pointerId);
                this.drag = { start: point(e), id: e.pointerId, invoice: this.id, key: this.target, file: this.files[this.page].filename };
                rectEl.hidden = false;
                return;
            }
            if (e.pointerType !== 'mouse' || e.target.closest('.review-region, #review-on-photo'))
                return;
            this.pan = { id: e.pointerId, x: e.clientX, y: e.clientY, left: vp.scrollLeft, top: vp.scrollTop };
            surface.setPointerCapture(e.pointerId);
        };
        surface.onpointermove = e => {
            if (this.pan?.id === e.pointerId) {
                vp.scrollLeft = this.pan.left - (e.clientX - this.pan.x);
                vp.scrollTop = this.pan.top - (e.clientY - this.pan.y);
                surface.classList.add('is-panning');
                return;
            }
            if (!this.drag || this.drag.id !== e.pointerId)
                return;
            const p = point(e), s = this.drag.start;
            this.drag.region = { x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), width: Math.abs(s.x - p.x), height: Math.abs(s.y - p.y) };
            Object.assign(rectEl.style, { left: this.drag.region.x * 100 + '%', top: this.drag.region.y * 100 + '%', width: this.drag.region.width * 100 + '%', height: this.drag.region.height * 100 + '%' });
        };
        surface.onpointerup = async (e) => {
            if (this.pan?.id === e.pointerId) {
                this.pan = null;
                surface.classList.remove('is-panning');
                return;
            }
            const drag = this.drag;
            if (!drag || drag.id !== e.pointerId)
                return;
            this.drag = null;
            this.binding = false;
            surface.classList.remove('binding');
            rectEl.hidden = true;
            if (!drag.region || drag.region.width < .002 || drag.region.height < .002)
                return;
            if (!await this.confirm('Привязать область?', 'Выделенная рамка будет связана с выбранным реквизитом или строкой.', { okText: 'Привязать' }))
                return;
            try {
                const { data } = await App.apiJson(`/invoices/${drag.invoice}/review/region`, { method: 'PUT', body: { ...drag.region, filename: drag.file, target_key: drag.key } });
                if (this.id !== drag.invoice)
                    return;
                this.regions = data;
                this.drawRegions();
                this.renderEditor();
                App.notify('Рамка привязана', 'success');
            }
            catch (err) {
                App.notify(err.message, 'error');
            }
        };
        surface.onpointercancel = () => { this.pan = null; this.drag = null; surface.classList.remove('is-panning'); rectEl.hidden = true; };
        vp.onwheel = e => {
            if (!e.ctrlKey && !e.metaKey)
                return; // обычное колесо — прокрутка листа
            e.preventDefault();
            const r = vp.getBoundingClientRect();
            this.zoomTo(this.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX - r.left, e.clientY - r.top);
        };
    },
    async removeRegion() {
        const r = this.activeRegion();
        if (!r)
            return;
        const id = this.id;
        try {
            const { data } = await App.apiJson(`/invoices/${id}/review/region`, { method: 'DELETE', body: { filename: r.filename, target_key: r.target_key } });
            if (this.id !== id)
                return;
            this.regions = data;
            this.drawRegions();
            this.renderEditor();
        }
        catch (e) {
            App.notify(e.message, 'error');
        }
    },

    // ── Сравнение с прошлой поставкой ──────────────────────────────────────
    async compare() {
        const id = this.id, el = irEl('invoice-comparison');
        if (!id || !el)
            return;
        if (this.compareOpen) {
            this.compareOpen = false;
            el.hidden = true;
            this.renderDecision();
            return;
        }
        this.compareOpen = true;
        el.hidden = false;
        this.renderDecision();
        el.innerHTML = '<p class="ic-muted">Ищем предыдущую поставку…</p>';
        try {
            const { data } = await App.apiJson(`/invoices/${id}/review/compare`);
            if (this.id !== id || !this.compareOpen)
                return;
            if (!data) {
                el.innerHTML = '<div class="review-source-head"><h3>Сравнение поставок</h3><button type="button" class="btn btn-outline btn-sm" onclick="InvoiceReview.compare()">Закрыть</button></div><p class="ic-muted">Предыдущей поставки этого поставщика в вашей компании нет.</p>';
                return;
            }
            this.comparison = data;
            const old = data.previous, now = data.current;
            const reasons = { new: 'Новый товар', missing: 'Нет в текущей', ambiguous: 'Неоднозначное соответствие', different_units: 'Разные единицы', different_vat: 'Разный / неизвестный НДС', different_conversion: 'Разный пересчёт единиц', missing_price: 'Нет цены' };
            el.innerHTML = `<div class="review-source-head"><div><h3>Текущая и предыдущая поставки</h3><p class="review-muted">${data.supplier_basis === 'inn' ? 'Поставщик совпадает по ИНН' : 'Поставщик сопоставлен по точному названию — проверьте соответствие'}. Цена за единицу с НДС; неподходящая база отмечена отдельно.</p></div><button type="button" class="btn btn-outline btn-sm" onclick="InvoiceReview.compare()">Закрыть</button></div><div class="review-compare-head"><div><small>Предыдущая · ${App.formatDate(old.invoice_date)}</small><b>№ ${App.esc(old.invoice_number || old.id)} · ${App.formatMoney(old.total_sum)} ₽</b><button type="button" class="review-source-link" onclick="Invoices.openInvoice(${old.id})">Открыть документ ↗</button></div><div><small>Текущая · ${App.formatDate(now.invoice_date)}</small><b>№ ${App.esc(now.invoice_number || now.id)} · ${App.formatMoney(now.total_sum)} ₽</b></div></div><div class="review-compare-tools"><label><input type="checkbox" id="review-only-changes"> Только отличия</label></div><div class="table-wrap"><table class="review-compare-table"><thead><tr><th>Товар</th><th>Раньше</th><th>Сейчас</th><th>Отличие</th></tr></thead><tbody>${data.rows.map((r, i) => { const a = r.current, b = r.previous, change = r.price_change_pct; const different = !a || !b || r.quantity_changed || r.packaging_changed || !r.comparable || Math.abs(change || 0) > .01; return `<tr data-different="${different}"><td>${App.esc(a?.original_name || b?.original_name)}<small>${r.match === 'name' ? 'По названию' : r.match === 'guid' ? 'Одинаковая позиция 1С' : ''}</small></td><td>${b ? `${App.formatMoney(b.price)} ₽ / ${App.esc(b.unit || '—')}<small>${App.esc(b.quantity ?? '—')} ${App.esc(b.unit || '')} · НДС ${App.esc(b.vat_rate ?? '—')}%</small><button type="button" class="review-source-link" data-compare-source="${i}" data-side="previous">На скане ↗</button>` : '—'}</td><td>${a ? `${App.formatMoney(a.price)} ₽ / ${App.esc(a.unit || '—')}<small>${App.esc(a.quantity ?? '—')} ${App.esc(a.unit || '')} · НДС ${App.esc(a.vat_rate ?? '—')}%</small><button type="button" class="review-source-link" data-compare-source="${i}" data-side="current">На скане ↗</button>` : '—'}</td><td>${change != null ? `<span class="${change > 0 ? 'review-increase' : 'review-muted'}">${change > 0 ? '+' : ''}${change.toFixed(1)}%</span>` : App.esc(reasons[r.reason] || reasons[r.match] || 'Не сравнивается')}${r.quantity_changed ? '<small>Изменилось количество</small>' : ''}${r.packaging_changed ? '<small>Изменилось название / упаковка</small>' : ''}</td></tr>`; }).join('')}</tbody></table></div><div id="review-compare-source" class="review-compare-source" hidden></div>`;
            irEl('review-only-changes').onchange = e => el.querySelectorAll('tr[data-different="false"]').forEach(tr => tr.hidden = e.target.checked);
            el.querySelectorAll('[data-compare-source]').forEach(b => b.onclick = () => this.compareSource(Number(b.dataset.compareSource), b.dataset.side));
            el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        catch (e) {
            if (this.id === id)
                el.innerHTML = `<p class="ic-muted">${App.esc(e.message || 'Сравнение недоступно')}</p>`;
        }
    },
    async compareSource(index, side) {
        const request = this.compareSourceRequest = (this.compareSourceRequest || 0) + 1;
        const data = this.comparison, row = data?.rows[index], item = row?.[side];
        if (!item)
            return;
        const id = this.id, inv = side === 'current' ? data.current : data.previous, el = irEl('review-compare-source');
        el.hidden = false;
        el.textContent = 'Загрузка скана…';
        try {
            const [{ data: review }, { data: files }] = await Promise.all([App.apiJson(`/invoices/${inv.id}/review`), App.apiJson(`/invoices/${inv.id}/photos`)]);
            if (this.id !== id || request !== this.compareSourceRequest || !this.compareOpen)
                return;
            const region = review.regions.find(r => r.target_key === `item:${item.id}:row`);
            const images = files.filter(f => f.exists !== false && /\.(jpe?g|png|webp|bmp|tiff?)$/i.test(f.filename));
            if (!images.length) {
                el.innerHTML = '<p>Фото нет — откройте исходный PDF или XML в карточке той накладной.</p>';
                return;
            }
            const file = images.find(f => f.filename === region?.filename) || images[0];
            el.innerHTML = `<h4>${side === 'current' ? 'Текущая' : 'Предыдущая'} · ${App.esc(item.original_name)}</h4><p class="review-muted">${region ? 'Подсвечена связанная строка — сверьте её с листом.' : 'Строка пока не привязана к рамке. Ниже — листы той накладной.'}</p><select id="review-compare-page" aria-label="Лист сравниваемого документа">${images.map(f => `<option value="${App.esc(f.filename)}" ${f.filename === file.filename ? 'selected' : ''}>${App.esc(f.filename)}</option>`).join('')}</select><div class="review-compare-photo"><img src="${this.imageUrl(inv.id, file.filename)}" alt="Скан сравниваемой поставки"><div id="review-compare-highlight"></div></div>`;
            const mark = irEl('review-compare-highlight');
            const update = (filename) => {
                mark.hidden = filename !== region?.filename;
                if (!mark.hidden)
                    Object.assign(mark.style, { left: region.x * 100 + '%', top: region.y * 100 + '%', width: region.width * 100 + '%', height: region.height * 100 + '%' });
            };
            update(file.filename);
            irEl('review-compare-page').onchange = e => { el.querySelector('img').src = this.imageUrl(inv.id, e.target.value); update(e.target.value); };
        }
        catch (e) {
            if (this.id === id)
                el.textContent = e.message || 'Не удалось открыть скан';
        }
    },
};
