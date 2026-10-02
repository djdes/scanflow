/* global App, Invoices */
'use strict';
const InvoiceReview = {
    labels: { invoice_number: 'Номер', invoice_date: 'Дата', supplier: 'Поставщик', supplier_inn: 'ИНН', total_sum: 'Итог документа', vat_sum: 'НДС', quantity: 'Количество', unit: 'Единица', price: 'Цена с НДС', total: 'Сумма строки', row: 'Строка товара' },
    attrs: { number: 'Номер', date: 'Дата', supplier: 'Поставщик', total: 'Сумма', vat: 'НДС', vat_rate: 'Ставка НДС' },
    session: false, seen: [], page: 0, zoom: 1, open: false, binding: false,
    reset(id) {
        if (this.cancelConfirm) this.cancelConfirm();
        this.compareOpen = false;
        clearTimeout(this.timer);
        this.request = (this.request || 0) + 1;
        if (this.id !== id) {
            this.open = this.session;
            this.target = 'header:total_sum';
            this.page = 0;
            this.zoom = 1;
            this.compareOpen = false;
            this.files = [];
            this.regions = [];
        }
        this.id = id;
        this.focusPending = this.open;
        this.invoice = null;
        this.binding = false;
        this.drag = null;
        document.getElementById('invoice-decision').innerHTML = '<div class="review-muted">Загрузка проверки…</div>';
        document.getElementById('invoice-source-workspace').hidden = true;
        document.getElementById('invoice-comparison').hidden = true;
    },
    leave() { clearTimeout(this.timer); this.request = (this.request || 0) + 1; this.session = false; this.invoice = null; this.id = null; if (this.cancelConfirm)
        this.cancelConfirm(); },
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
                if (this.invoice) this.renderDecision();
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
            const status = document.getElementById('review-locate-status');
            if (status)
                status.textContent = data.job?.message || 'Выделения ИИ — подсказки, их нужно сверить с фото.';
            const find = document.getElementById('review-locate');
            if (find)
                find.disabled = data.job?.status === 'running';
        }
        catch (e) {
            if (this.id === id)
                document.getElementById('invoice-decision').innerHTML = `<div class="review-muted">Проверка недоступна: ${App.esc(e.message)} <button type="button" class="btn btn-outline btn-sm" onclick="InvoiceReview.refresh()">Повторить</button></div>`;
        }
    },
    renderDecision() {
        const inv = this.invoice, d = this.state?.decision;
        if (!inv || !d)
            return;
        const issues = [];
        if (inv.status === 'error')
            issues.push('Ошибка распознавания — проверьте исходник или пересканируйте');
        if (inv.duplicate_of || inv.status === 'duplicate')
            issues.push('Возможный дубликат — сначала сравните с основной накладной');
        if (d.missing_header.length)
            issues.push('Заполните: ' + d.missing_header.map(k => this.labels[k]).join(', '));
        if (d.mismatch)
            issues.push(`Сверьте итог: документ ${App.formatMoney(inv.total_sum)} ₽, товары ${App.formatMoney(d.item_sum)} ₽`);
        if (d.quantity.length)
            issues.push('Количество и единицы: ' + d.quantity.length + ' строк');
        if (d.unmapped.length)
            issues.push('Без позиции 1С: ' + d.unmapped.length + ' строк');
        if (inv.supplier_match === 'name')
            issues.push('Поставщик выбран по названию — проверьте ИНН');
        if (inv.alignment_problems?.length)
            issues.push('Возможен сдвиг строк — сверьте таблицу с оригиналом');
        const unchecked = d.unchecked.map(k => this.attrs[k]);
        const blocked = issues.length || unchecked.length;
        const payment = this.state.payment;
        const step = inv.status === 'sent_to_1c' ? 'Документ передан в 1С' : inv.approved_for_1c ? 'Документ в очереди загрузки 1С' : payment && payment.status !== 'failed' ? 'По документу создан платёж — правка закрыта' : blocked ? 'Проверьте замечания и реквизиты перед передачей' : 'Реквизиты сверены. Можно перейти к передаче в 1С или созданию черновика платежа';
        document.getElementById('invoice-decision').innerHTML = `<div class="review-decision-head"><div><span class="review-eyebrow">${this.session ? 'РЕЖИМ ПРОВЕРКИ · ПРОСМОТРЕНО ' + this.seen.length : 'ПРОВЕРКА ДОКУМЕНТА'}</span><h3>${App.esc(step)}</h3></div><span class="review-score">${6 - d.unchecked.length}/6 <small>реквизитов сверено</small></span></div>
      <div class="review-checks">${Object.entries(this.attrs).map(([key, label]) => `<button type="button" class="review-check ${d.unchecked.includes(key) ? '' : 'checked'}" onclick="InvoiceReview.verify('${key}')">${d.unchecked.includes(key) ? '○' : '✓'} ${label}</button>`).join('')}</div>
      ${issues.length ? `<ul class="review-issues">${issues.map(text => `<li>${App.esc(text)}</li>`).join('')}</ul>` : '<p class="review-muted">Замечаний в проверке списка нет. Сопоставления и банковские реквизиты проверяются отдельно при отправке.</p>'}
      <div class="review-decision-actions"><button type="button" class="btn btn-primary btn-sm" onclick="InvoiceReview.toggleSource()">${this.open ? 'Скрыть оригинал' : 'Проверить по оригиналу'}</button><button type="button" class="btn btn-outline btn-sm" onclick="InvoiceReview.compare()">Сравнить с прошлой поставкой</button>
      ${inv.status === 'processed' && !inv.approved_for_1c ? `<button type="button" class="btn btn-outline btn-sm" onclick="Invoices.sendTo1C(${inv.id})">Передать в 1С</button>` : ''}
      <button type="button" class="btn btn-outline btn-sm" onclick="InvoiceReview.payment()">${payment ? 'Посмотреть платёж' : 'К оплате'}</button>
      <button type="button" class="btn btn-outline btn-sm" onclick="InvoiceReview.next()">${this.session ? 'Пропустить / следующая →' : 'Следующая для проверки →'}</button></div>`;
    },
    async verify(attr) {
        if (!this.invoice)
            return;
        const map = { number: 'invoice_number', date: 'invoice_date', supplier: 'supplier', total: 'total_sum', vat: 'vat_sum' };
        if (this.state.decision.unchecked.includes(attr)) {
            await this.select(map[attr] ? 'header:' + map[attr] : 'header:vat_sum');
            const id = this.id;
            if (!await this.confirm('Сверено с оригиналом?', `Подтвердите, что реквизит «${this.attrs[attr]}» сверён с документом.`, { okText: 'Подтвердить' }))
                return;
            if (id !== this.id)
                return;
            await Invoices.toggleAttrCheck(id, attr, true);
        }
        else
            await Invoices.toggleAttrCheck(this.id, attr, false);
    },
    payment() { const el = document.getElementById('invoice-sber-section'); if (el && el.style.display !== 'none')
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else
        App.notify('Подключите СберБизнес для создания черновика. Подписание выполняется в банке.', 'info'); },
    targets() {
        if (!this.invoice)
            return [];
        return [...['invoice_number', 'invoice_date', 'supplier', 'supplier_inn', 'total_sum', 'vat_sum'].map(field => ({ key: 'header:' + field, label: this.labels[field], value: this.invoice[field] })),
            ...(this.invoice.items || []).flatMap((item, i) => ['row', 'quantity', 'unit', 'price', 'total'].map(field => ({ key: `item:${item.id}:${field}`, label: `${i + 1}. ${item.original_name} · ${this.labels[field]}`, value: field === 'row' ? item.original_name : item[field] })))];
    },
    targetInfo() { const parts = (this.target || '').split(':'); return { item: parts[0] === 'item' ? this.invoice?.items.find(i => i.id === Number(parts[1])) : null, field: parts[0] === 'item' ? parts[2] : parts[1], isHeader: parts[0] === 'header' }; },
    linkFields() {
        const headers = ['invoice_number', 'invoice_date', 'supplier', 'total_sum', 'vat_sum'];
        document.querySelectorAll('#invoice-header-fields .invoice-field').forEach((field, i) => { if (headers[i]) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'review-source-link';
            b.textContent = 'На оригинале ↗';
            b.onclick = () => this.select('header:' + headers[i]);
            field.appendChild(b);
        } });
        document.querySelectorAll('#invoice-items-tbody tr[data-item-id]').forEach(tr => {
            const id = tr.dataset.itemId;
            const cell = tr.cells[1];
            if (cell) {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'review-source-link';
                b.textContent = 'Строка на фото ↗';
                b.onclick = () => this.select(`item:${id}:row`);
                cell.appendChild(b);
            }
            tr.querySelectorAll('[data-field]').forEach(input => { input.addEventListener('focus', () => { if (this.open)
                this.select(`item:${id}:${input.dataset.field}`, false); }); });
        });
    },
    async toggleSource() { this.open = !this.open; this.focusPending = this.open; document.getElementById('invoice-source-workspace').hidden = !this.open; this.renderDecision(); if (this.open)
        await this.loadSource(); },
    async select(key, scroll = true) {
        if (!this.targets().some(t => t.key === key))
            return;
        this.target = key;
        this.binding = false;
        this.zoom = 1;
        const region = this.regions.find(r => r.target_key === key && r.filename === this.files[this.page]?.filename)
            || this.regions.find(r => r.target_key === key) || this.regions.find(r => r.target_key === key.split(':').slice(0, 2).join(':') + ':row');
        this.focusPending = true;
        if (region) {
            const page = this.files.findIndex(f => f.filename === region.filename);
            if (page >= 0)
                this.page = page;
        }
        const wasOpen = this.open;
        this.open = true;
        this.renderDecision();
        if (!wasOpen || !document.getElementById('review-surface'))
            await this.loadSource();
        else {
            this.renderSource();
        }
        document.querySelectorAll('#invoice-items-tbody tr').forEach(tr => tr.classList.toggle('review-selected', tr.dataset.itemId === key.split(':')[1]));
        if (scroll)
            document.getElementById('invoice-source-workspace').scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    async loadSource() {
        const id = this.id, el = document.getElementById('invoice-source-workspace');
        el.hidden = false;
        el.innerHTML = '<p class="review-muted">Загрузка оригинала…</p>';
        try {
            const { data } = await App.apiJson(`/invoices/${id}/photos`);
            if (this.id !== id || !this.open)
                return;
            this.files = (data || []).filter(f => f.exists !== false && /\.(jpe?g|png|webp|bmp|tiff?)$/i.test(f.filename));
            const linked = this.regions.find(r => r.target_key === this.target) || this.regions.find(r => r.target_key === this.target.split(':').slice(0, 2).join(':') + ':row');
            if (linked && this.focusPending) { const page = this.files.findIndex(f => f.filename === linked.filename); if (page >= 0) this.page = page; }
            if (this.page >= this.files.length)
                this.page = 0;
            this.renderSource();
        }
        catch (e) {
            if (this.id === id)
                el.innerHTML = `<p class="review-muted">${App.esc(e.message)} <button type="button" class="btn btn-outline btn-sm" onclick="InvoiceReview.loadSource()">Повторить</button></p>`;
        }
    },
    imageUrl(invId, filename) { return `/api/invoices/${invId}/review/image/${encodeURIComponent(filename)}?key=${encodeURIComponent(App.apiKey)}`; },
    renderSource() {
        const el = document.getElementById('invoice-source-workspace');
        if (!this.invoice || !this.open)
            return;
        el.hidden = false;
        if (!this.files.length) {
            el.innerHTML = '<h3>Оригинал документа</h3><p class="review-muted">Нет доступного фото для выделения. Для PDF и XML используйте вкладку «Фото / Документ»; правка реквизитов доступна в карточке.</p><button type="button" class="btn btn-outline btn-sm" onclick="Invoices.switchTab(\'photos\',document.querySelectorAll(\'#invoice-detail .tabs .tab-btn\')[1])">Открыть исходный документ</button>';
            return;
        }
        const file = this.files[this.page], targets = this.targets();
        if (!targets.some(t => t.key === this.target))
            this.target = targets[0]?.key;
        el.innerHTML = `<div class="review-source-head"><div><h3>Оригинал и данные рядом</h3><p class="review-muted">Нажмите выделение на фото для правки. Если выделения нет — найдите его или укажите вручную.</p></div><button type="button" class="btn btn-outline btn-sm" onclick="InvoiceReview.toggleSource()">Закрыть</button></div>
      <div class="review-source-layout"><div class="review-photo-column"><div class="review-photo-tools"><label>Лист <select id="review-page" aria-label="Лист документа">${this.files.map((f, i) => `<option value="${i}" ${this.page === i ? 'selected' : ''}>${i + 1} · ${App.esc(f.filename)}</option>`).join('')}</select></label><button type="button" class="btn btn-outline btn-sm" onclick="InvoiceReview.setZoom(-.5)">−</button><span id="review-zoom">${Math.round(this.zoom * 100)}%</span><button type="button" class="btn btn-outline btn-sm" onclick="InvoiceReview.setZoom(.5)">+</button><button type="button" class="btn btn-outline btn-sm" onclick="InvoiceReview.zoom=1;InvoiceReview.setZoom(0)">Вписать</button></div>
      <div class="review-photo-viewport" id="review-viewport"><div class="review-photo-surface" id="review-surface" style="width:${this.zoom * 100}%"><img id="review-image" draggable="false" src="${this.imageUrl(this.id, file.filename)}" alt="Оригинал листа ${this.page + 1}"><div id="review-regions"></div><div id="review-drag" hidden></div><div id="review-on-photo" hidden></div></div></div>
      <div class="review-photo-tools"><button type="button" class="btn btn-outline btn-sm" id="review-locate" ${this.state?.job?.status === 'running' ? 'disabled' : ''}>Найти на этом листе</button><button type="button" class="btn btn-outline btn-sm" onclick="InvoiceReview.beginBind()">Выделить вручную</button><button type="button" class="btn btn-outline btn-sm" onclick="InvoiceReview.removeRegion()">Убрать выделение</button></div><p id="review-locate-status" class="review-muted" aria-live="polite">${App.esc(this.state?.job?.message || 'Выделения ИИ — подсказки, их нужно сверить с оригиналом.')}</p></div>
      <aside class="review-fields"><label class="review-field-label" for="review-target">Реквизит / строка</label><select id="review-target">${targets.map(t => `<option value="${t.key}" ${this.target === t.key ? 'selected' : ''}>${App.esc(t.label)}</option>`).join('')}</select><div id="review-editor"></div></aside></div>`;
        document.getElementById('review-page').onchange = e => { this.page = Number(e.target.value); this.binding = false; this.renderSource(); };
        document.getElementById('review-target').onchange = e => this.select(e.target.value, false);
        document.getElementById('review-locate').onclick = () => this.locate();
        const img = document.getElementById('review-image');
        img.onload = () => { this.drawRegions(); this.placeEditor(); if (this.focusPending) this.focusRegion(); };
        img.onerror = () => { document.getElementById('review-locate-status').textContent = 'Фото не удалось открыть. Проверьте вкладку «Фото» или выберите другой лист.'; };
        this.installPointer();
        this.drawRegions();
        this.renderEditor();
    },
    setZoom(delta) { this.zoom = Math.max(1, Math.min(4, this.zoom + delta)); const surface = document.getElementById('review-surface'); if (surface)
        surface.style.width = this.zoom * 100 + '%'; const label = document.getElementById('review-zoom'); if (label)
        label.textContent = Math.round(this.zoom * 100) + '%'; this.placeEditor(); },
    focusRegion() {
        this.focusPending = false;
        const region = this.activeRegion(), viewport = document.getElementById('review-viewport'), surface = document.getElementById('review-surface');
        if (!region || !viewport || !surface) return;
        this.zoom = region.width < .3 ? 2.5 : 1.5; this.setZoom(0);
        viewport.scrollLeft = Math.max(0, (region.x + region.width / 2) * surface.clientWidth - viewport.clientWidth / 2);
        viewport.scrollTop = Math.max(0, (region.y + region.height / 2) * surface.clientHeight - viewport.clientHeight / 2);
    },
    activeRegion() { return this.regions.find(r => r.target_key === this.target && r.filename === this.files[this.page]?.filename) || this.regions.find(r => r.target_key === this.target.split(':').slice(0, 2).join(':') + ':row' && r.filename === this.files[this.page]?.filename); },
    drawRegions() {
        const el = document.getElementById('review-regions');
        if (!el || !this.files.length)
            return;
        const filename = this.files[this.page].filename, active = this.activeRegion();
        el.innerHTML = this.regions.filter(r => r.filename === filename).map(r => `<button type="button" class="review-region ${r === active ? 'active' : ''} ${r.target_key.endsWith(':row') ? '' : 'field-region'} ${r.origin === 'ai' ? 'ai' : ''}" style="left:${r.x * 100}%;top:${r.y * 100}%;width:${r.width * 100}%;height:${r.height * 100}%" data-key="${App.esc(r.target_key)}" aria-label="${App.esc(this.targets().find(t => t.key === r.target_key)?.label || r.target_key)}" title="${App.esc((r.origin === 'ai' ? 'Найдено ИИ · ' : 'Выделено вручную · ') + (r.printed_text || ''))}"></button>`).join('');
        el.querySelectorAll('button').forEach(b => b.onclick = e => { e.stopPropagation(); if (this.binding)
            return; this.target = b.dataset.key; document.getElementById('review-target').value = this.target; this.drawRegions(); this.renderEditor(true); });
    },
    renderEditor(onPhoto = false) {
        const el = document.getElementById('review-editor');
        if (!el || !this.invoice)
            return;
        const info = this.targetInfo(), t = this.targets().find(t => t.key === this.target), r = this.activeRegion();
        if (!t)
            return;
        if (info.field === 'row') {
            el.innerHTML = `<h4>${App.esc(info.item?.original_name || 'Строка')}</h4><p class="review-muted">Выберите значение для сверки и исправления.</p><div class="review-row-fields">${['quantity', 'unit', 'price', 'total'].map(field => `<button type="button" class="review-value-button" data-select="item:${info.item.id}:${field}"><small>${this.labels[field]}</small><strong>${App.esc(info.item[field] ?? '—')}</strong></button>`).join('')}</div>`;
            el.querySelectorAll('[data-select]').forEach(b => b.onclick = () => this.select(b.dataset.select, false));
            document.getElementById('review-on-photo').hidden = true;
            return;
        }
        const locked = !this.state?.decision.editable;
        el.innerHTML = `<h4>${App.esc(this.labels[info.field])}</h4><div class="review-before">В системе <b>${App.esc(t.value ?? '—')}</b></div>${r ? `<p class="review-printed">${r.origin === 'ai' ? 'На фото по подсказке ИИ' : 'Выделено вручную'}: <strong>${App.esc(r.printed_text || 'сверьте выделенную область')}</strong></p>` : '<p class="review-muted">Область пока не привязана. Выберите нужный лист и найдите значение или выделите его вручную.</p>'}
      ${locked ? '<div class="review-warning">Документ недоступен для правки: проверьте статус 1С и платежа.</div>' : `<label class="review-field-label" for="review-value">Новое значение</label><input id="review-value" type="${info.field === 'invoice_date' ? 'date' : 'text'}" ${['quantity', 'price', 'total', 'total_sum', 'vat_sum'].includes(info.field) ? 'inputmode="decimal"' : ''} value="${App.esc(t.value ?? '')}" autocomplete="off"><div id="review-preview" class="review-preview"></div><button type="button" class="btn btn-primary" id="review-save">Проверить и сохранить</button><button type="button" class="btn btn-outline btn-sm" id="review-photo-edit">Править на фото</button>`}
      <p class="review-muted">Оригинал сохраняется. Правка попадёт в историю и сбросит соответствующие отметки сверки.</p>`;
        const input = document.getElementById('review-value');
        if (input) {
            input.oninput = () => this.preview();
            document.getElementById('review-save').onclick = () => this.save();
            document.getElementById('review-photo-edit').onclick = () => { if (!r) {
                App.notify('Сначала привяжите область на фото', 'info');
                return;
            } this.renderEditor(true); };
            this.preview();
        }
        const pop = document.getElementById('review-on-photo');
        pop.hidden = true;
        if (onPhoto && r && !locked) {
            pop.hidden = false;
            pop.innerHTML = `<label>${App.esc(this.labels[info.field])} <small>В системе: ${App.esc(t.value ?? '—')}</small></label><input aria-label="Новое значение на фото" id="review-photo-value" value="${App.esc(t.value ?? '')}" ${['quantity', 'price', 'total', 'total_sum', 'vat_sum'].includes(info.field) ? 'inputmode="decimal"' : ''}><div class="review-pop-actions"><button type="button" class="btn btn-primary btn-sm" id="review-photo-save">Сверить →</button><button type="button" class="btn btn-outline btn-sm" id="review-photo-cancel">✕</button></div>`;
            document.getElementById('review-photo-save').onclick = () => { input.value = document.getElementById('review-photo-value').value; this.preview(); this.save(); };
            document.getElementById('review-photo-cancel').onclick = () => pop.hidden = true;
            this.placeEditor();
        }
    },
    placeEditor() { const pop = document.getElementById('review-on-photo'), surface = document.getElementById('review-surface'), region = this.activeRegion(); if (!pop || pop.hidden || !surface || !region)
        return; pop.style.left = Math.max(0, Math.min(surface.clientWidth - 230, region.x * surface.clientWidth)) + 'px'; pop.style.top = Math.max(0, Math.min(surface.clientHeight - 140, (region.y + region.height) * surface.clientHeight)) + 'px'; },
    parsedValue() { const { field } = this.targetInfo(), v = document.getElementById('review-value')?.value.trim() ?? ''; if (['quantity', 'price', 'total', 'total_sum', 'vat_sum'].includes(field))
        return v === '' ? null : Number(v.replace(',', '.')); return v || null; },
    preview() {
        const el = document.getElementById('review-preview');
        if (!el)
            return;
        const { item, field } = this.targetInfo(), v = this.parsedValue();
        if (typeof v === 'number' && (!Number.isFinite(v) || v < 0)) {
            el.textContent = 'Введите неотрицательное число';
            return;
        }
        if (item && ['quantity', 'price', 'total'].includes(field)) {
            const next = field === 'total' ? v : (field === 'quantity' ? v : item.quantity) * (field === 'price' ? v : item.price);
            const old = Number(item.total ?? 0), sum = this.state.decision.item_sum - old + Number(next ?? 0);
            el.textContent = `Сумма строки: ${App.formatMoney(old)} → ${App.formatMoney(next)} ₽. По товарам: ${App.formatMoney(sum)} ₽. Итог оригинала ${App.formatMoney(this.invoice.total_sum)} ₽ сохраняется.`;
        }
        else if (item && field === 'unit')
            el.textContent = 'Меняется только единица. Количество и цена автоматически не пересчитываются — сверьте их отдельно по оригиналу.';
        else
            el.textContent = 'Изменение сохранится после подтверждения. Отметка сверки будет снята.';
    },
    async save() {
        if (this.saving)
            return;
        const id = this.id, key = this.target, { item, field } = this.targetInfo(), value = this.parsedValue();
        const t = this.targets().find(t => t.key === key);
        if (!t || !this.state.decision.editable)
            return;
        if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) {
            App.notify('Некорректное число', 'error');
            return;
        }
        if (!await this.confirm('Сохранить исправление?', `${this.labels[field]}: ${t.value ?? '—'} → ${value ?? 'пусто'}. ${document.getElementById('review-preview').textContent}`, { okText: 'Сохранить' }))
            return;
        if (this.id !== id || this.target !== key)
            return;
        this.saving = true;
        const body = { field, value, expected: t.value ?? null, item_id: item?.id ?? null };
        if (item)
            body.expected_row = Object.fromEntries(['quantity', 'unit', 'price', 'total'].map(k => [k, item[k] ?? null]));
        try {
            await App.apiJson(`/invoices/${id}/review/edit`, { method: 'PATCH', body });
            App.notify('Правка сохранена. Связанные реквизиты нужно сверить снова.', 'success');
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
        const id = this.id, file = this.files[this.page];
        if (!file)
            return;
        const b = document.getElementById('review-locate');
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
    beginBind() { this.binding = true; this.drag = null; document.getElementById('review-on-photo').hidden = true; document.getElementById('review-surface').classList.add('binding'); document.getElementById('review-locate-status').textContent = 'Обведите значение или строку прямоугольником на фото. После выделения подтвердите привязку.'; },
    installPointer() {
        const surface = document.getElementById('review-surface'), rectEl = document.getElementById('review-drag');
        const point = e => { const r = surface.getBoundingClientRect(); return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) }; };
        surface.onpointerdown = e => { if (!this.binding || !document.getElementById('review-image').naturalWidth || e.button !== 0)
            return; e.preventDefault(); surface.setPointerCapture(e.pointerId); this.drag = { start: point(e), id: e.pointerId, invoice: this.id, key: this.target, file: this.files[this.page].filename }; rectEl.hidden = false; };
        surface.onpointermove = e => { if (!this.drag || this.drag.id !== e.pointerId)
            return; const p = point(e), s = this.drag.start; this.drag.region = { x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), width: Math.abs(s.x - p.x), height: Math.abs(s.y - p.y) }; Object.assign(rectEl.style, { left: this.drag.region.x * 100 + '%', top: this.drag.region.y * 100 + '%', width: this.drag.region.width * 100 + '%', height: this.drag.region.height * 100 + '%' }); };
        surface.onpointerup = async (e) => {
            const drag = this.drag;
            if (!drag || drag.id !== e.pointerId)
                return;
            this.drag = null;
            this.binding = false;
            surface.classList.remove('binding');
            rectEl.hidden = true;
            if (!drag.region || drag.region.width < .002 || drag.region.height < .002)
                return;
            if (!await this.confirm('Привязать область?', 'Выделенная область будет связана с выбранным реквизитом или строкой.', { okText: 'Привязать' }))
                return;
            try {
                const { data } = await App.apiJson(`/invoices/${drag.invoice}/review/region`, { method: 'PUT', body: { ...drag.region, filename: drag.file, target_key: drag.key } });
                if (this.id !== drag.invoice)
                    return;
                this.regions = data;
                this.drawRegions();
                this.renderEditor();
                App.notify('Область привязана', 'success');
            }
            catch (err) {
                App.notify(err.message, 'error');
            }
        };
        surface.onpointercancel = () => { this.drag = null; rectEl.hidden = true; };
    },
    async removeRegion() { const r = this.activeRegion(); if (!r)
        return; const id = this.id; try {
        const { data } = await App.apiJson(`/invoices/${id}/review/region`, { method: 'DELETE', body: { filename: r.filename, target_key: r.target_key } });
        if (this.id !== id) return;
        this.regions = data;
        this.drawRegions();
        this.renderEditor();
    }
    catch (e) {
        App.notify(e.message, 'error');
    } },
    async compare() {
        const id = this.id, el = document.getElementById('invoice-comparison');
        if (!id)
            return;
        if (this.compareOpen) {
            this.compareOpen = false;
            el.hidden = true;
            return;
        }
        this.compareOpen = true;
        el.hidden = false;
        el.innerHTML = '<p class="review-muted">Ищем предыдущую поставку…</p>';
        try {
            const { data } = await App.apiJson(`/invoices/${id}/review/compare`);
            if (this.id !== id || !this.compareOpen)
                return;
            if (!data) {
                el.innerHTML = '<h3>Сравнение поставок</h3><p class="review-muted">Предыдущей поставки этого поставщика в вашей компании нет.</p>';
                return;
            }
            this.comparison = data;
            const old = data.previous, now = data.current;
            const reasons = { new: 'Новый товар', missing: 'Нет в текущей', ambiguous: 'Неоднозначное соответствие', different_units: 'Разные единицы', different_vat: 'Разный / неизвестный НДС', different_conversion: 'Разный пересчёт единиц', missing_price: 'Нет цены' };
            el.innerHTML = `<div class="review-source-head"><div><h3>Текущая и предыдущая поставки</h3><p class="review-muted">${data.supplier_basis === 'inn' ? 'Поставщик совпадает по ИНН' : 'Поставщик сопоставлен по точному названию — проверьте соответствие'}. Цена за единицу с НДС; неподходящая база отмечена отдельно.</p></div><button type="button" class="btn btn-outline btn-sm" onclick="InvoiceReview.compare()">Закрыть</button></div><div class="review-compare-head"><div><small>Предыдущая · ${App.formatDate(old.invoice_date)}</small><b>№ ${App.esc(old.invoice_number || old.id)} · ${App.formatMoney(old.total_sum)} ₽</b><button type="button" class="review-source-link" onclick="Invoices.openInvoice(${old.id})">Открыть документ ↗</button></div><div><small>Текущая · ${App.formatDate(now.invoice_date)}</small><b>№ ${App.esc(now.invoice_number || now.id)} · ${App.formatMoney(now.total_sum)} ₽</b></div></div><div class="review-compare-tools"><label><input type="checkbox" id="review-only-changes"> Только отличия</label></div><div class="table-wrap"><table class="review-compare-table"><thead><tr><th>Товар</th><th>Раньше</th><th>Сейчас</th><th>Отличие</th></tr></thead><tbody>${data.rows.map((r, i) => { const a = r.current, b = r.previous, change = r.price_change_pct; const different = !a || !b || r.quantity_changed || r.packaging_changed || !r.comparable || Math.abs(change || 0) > .01; return `<tr data-different="${different}"><td>${App.esc(a?.original_name || b?.original_name)}<small>${r.match === 'name' ? 'По названию' : r.match === 'guid' ? 'Одинаковая позиция 1С' : ''}</small></td><td>${b ? `${App.formatMoney(b.price)} ₽ / ${App.esc(b.unit || '—')}<small>${App.esc(b.quantity ?? '—')} ${App.esc(b.unit || '')} · НДС ${App.esc(b.vat_rate ?? '—')}%</small><button type="button" class="review-source-link" data-compare-source="${i}" data-side="previous">На оригинале ↗</button>` : '—'}</td><td>${a ? `${App.formatMoney(a.price)} ₽ / ${App.esc(a.unit || '—')}<small>${App.esc(a.quantity ?? '—')} ${App.esc(a.unit || '')} · НДС ${App.esc(a.vat_rate ?? '—')}%</small><button type="button" class="review-source-link" data-compare-source="${i}" data-side="current">На оригинале ↗</button>` : '—'}</td><td>${change != null ? `<span class="${change > 0 ? 'review-increase' : 'review-muted'}">${change > 0 ? '+' : ''}${change.toFixed(1)}%</span>` : App.esc(reasons[r.reason] || reasons[r.match] || 'Не сравнивается')}${r.quantity_changed ? '<small>Изменилось количество</small>' : ''}${r.packaging_changed ? '<small>Изменилось название / упаковка</small>' : ''}</td></tr>`; }).join('')}</tbody></table></div><div id="review-compare-source" class="review-compare-source" hidden></div>`;
            document.getElementById('review-only-changes').onchange = e => el.querySelectorAll('tr[data-different="false"]').forEach(tr => tr.hidden = e.target.checked);
            el.querySelectorAll('[data-compare-source]').forEach(b => b.onclick = () => this.compareSource(Number(b.dataset.compareSource), b.dataset.side));
            el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        catch (e) {
            if (this.id === id)
                el.innerHTML = `<p class="review-muted">${App.esc(e.message || 'Сравнение недоступно')}</p>`;
        }
    },
    async compareSource(index, side) {
        const request = this.compareSourceRequest = (this.compareSourceRequest || 0) + 1;
        const data = this.comparison, row = data?.rows[index], item = row?.[side];
        if (!item)
            return;
        const id = this.id, inv = side === 'current' ? data.current : data.previous, el = document.getElementById('review-compare-source');
        el.hidden = false;
        el.textContent = 'Загрузка источника…';
        try {
            const [{ data: review }, { data: files }] = await Promise.all([App.apiJson(`/invoices/${inv.id}/review`), App.apiJson(`/invoices/${inv.id}/photos`)]);
            if (this.id !== id || request !== this.compareSourceRequest || !this.compareOpen)
                return;
            const region = review.regions.find(r => r.target_key === `item:${item.id}:row`);
            const images = files.filter(f => f.exists !== false && /\.(jpe?g|png|webp|bmp|tiff?)$/i.test(f.filename));
            if (!images.length) {
                el.innerHTML = '<p>Фото отсутствует. Откройте исходный PDF / XML в карточке документа.</p>';
                return;
            }
            const file = images.find(f => f.filename === region?.filename) || images[0];
            el.innerHTML = `<h4>${side === 'current' ? 'Текущая' : 'Предыдущая'} · ${App.esc(item.original_name)}</h4><p class="review-muted">${region ? 'Подсвечена связанная строка. Сверьте выделение с оригиналом.' : 'Строка пока не привязана к области. Ниже доступные листы оригинала.'}</p><select id="review-compare-page" aria-label="Лист сравниваемого документа">${images.map(f => `<option value="${App.esc(f.filename)}" ${f.filename === file.filename ? 'selected' : ''}>${App.esc(f.filename)}</option>`).join('')}</select><div class="review-compare-photo"><img src="${this.imageUrl(inv.id, file.filename)}" alt="Оригинал сравниваемой поставки"><div id="review-compare-highlight"></div></div>`;
            const mark = document.getElementById('review-compare-highlight');
            const update = (filename) => { mark.hidden = filename !== region?.filename; if (!mark.hidden)
                Object.assign(mark.style, { left: region.x * 100 + '%', top: region.y * 100 + '%', width: region.width * 100 + '%', height: region.height * 100 + '%' }); };
            update(file.filename);
            document.getElementById('review-compare-page').onchange = e => { el.querySelector('img').src = this.imageUrl(inv.id, e.target.value); update(e.target.value); };
        }
        catch (e) {
            if (this.id === id)
                el.textContent = e.message || 'Не удалось открыть источник';
        }
    },
};
