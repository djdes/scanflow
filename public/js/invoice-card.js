/* global App, Invoices, InvoiceReview, Sber, InvoicePhotoViewer */
'use strict';
// Карточка накладной «по шагам» (спек docs/superpowers/specs/2026-10-09-invoice-card-redesign-design.md):
// шапка с превью скана и меню «⋯», три шага «Сверка → 1С → Оплата», панель выбранного
// шага. Строки товаров рисует Invoices, панель сверки и скан — InvoiceReview, оплату — Sber.
// Чистые функции (stepStates, defaultStep, menuItems, requisites) не трогают DOM —
// их проверяет tests/frontend/invoiceCard.test.ts.
const InvoiceCard = {
  ATTRS: [['number', 'Номер'], ['date', 'Дата'], ['supplier', 'Поставщик'], ['total', 'Сумма'], ['vat', 'НДС'], ['vat_rate', 'Ставки НДС']],
  STEPS: ['verify', 'onec', 'pay'],

  inv: null,
  activeStep: null,
  sber: null,        // { connected, payer_complete } — после загрузки
  payment: undefined, // undefined — ещё не загружен, null — платежа нет

  // ── Чистые функции ──────────────────────────────────────────────────────

  /** Шесть реквизитов сверки: значение для показа и отметка «сверено с бумагой». */
  requisites(inv) {
    const money = (v) => (v == null || v === '' ? '—' : `${App.formatMoney(v)} ₽`);
    const rates = [...new Set((inv.items || []).map(i => i.vat_rate).filter(r => r != null && r !== '').map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
    const values = {
      number: inv.invoice_number || '—',
      date: inv.invoice_date ? App.formatDate(inv.invoice_date) : '—',
      supplier: inv.supplier || '—',
      total: money(inv.total_sum),
      vat: inv.vat_sum == null ? '—' : Number(inv.vat_sum) > 0 ? money(inv.vat_sum) : 'без НДС',
      vat_rate: rates.length ? rates.map(r => `${r}%`).join(', ') : '—',
    };
    return this.ATTRS.map(([key, label]) => ({ key, label, value: values[key], checked: !!Number(inv[`attr_checked_${key}`] || 0) }));
  },

  /** Сколько из шести реквизитов сверено. */
  checkedCount(inv) {
    return this.requisites(inv).filter(r => r.checked).length;
  },

  unmappedCount(inv) {
    return (inv.items || []).filter(it => !it.onec_guid).length;
  },

  /**
   * Состояние трёх шагов. sber — { connected, payer_complete } или null (не загружено),
   * payment — строка sber_payments (+ bank_status_kind/label) или null; undefined — не загружено.
   */
  stepStates(inv, sber = null, payment = undefined) {
    const checked = this.checkedCount(inv);
    const duplicate = !!inv.duplicate_of || inv.status === 'duplicate';
    const recognizing = ['new', 'ocr_processing', 'parsing', 'waiting_ai'].includes(inv.status);

    const verify = duplicate
      ? { state: 'blocked', hint: 'дубликат' }
      : checked === 6
        ? { state: 'done', hint: '6 из 6 реквизитов' }
        : { state: 'current', hint: `${checked} из 6 реквизитов` };

    let onec;
    // «В 1С» — только по статусу накладной: «Сбросить статус» возвращает его в «Обработан»,
    // а onec_status (что ответила 1С в прошлый раз) остаётся прежним.
    const onecDone = inv.status === 'sent_to_1c';
    if (duplicate) onec = { state: 'blocked', hint: 'дубликат не отправляется' };
    else if (recognizing) onec = { state: 'blocked', hint: inv.status === 'waiting_ai' ? 'ждёт распознавания' : 'распознаётся' };
    else if (inv.status === 'error') onec = { state: 'blocked', hint: 'ошибка распознавания' };
    else if (inv.completeness?.message && !inv.approved_for_1c && inv.status !== 'sent_to_1c') onec = { state: 'blocked', hint: 'снята не полностью — добавьте страницы' };
    else if (onecDone) {
      const ref = this.shortDocRef(inv.onec_document_ref);
      onec = { state: 'done', hint: inv.onec_status === 'created' ? `${ref || 'документ создан'} · не проведён` : (ref || 'загружена в 1С') };
    } else if (['error', 'rejected'].includes(inv.onec_status)) onec = { state: 'error', hint: '1С не приняла накладную' };
    else if (inv.approved_for_1c) onec = { state: 'queued', hint: 'ждёт загрузки в 1С' };
    else {
      const n = this.unmappedCount(inv);
      onec = { state: 'idle', hint: n ? `${n} ${this.plural(n, 'новый товар', 'новых товара', 'новых товаров')} создастся в 1С` : 'можно отправить', action: { kind: 'send1c', label: 'Отправить в 1С' } };
    }

    let pay;
    if (inv.paid_externally) pay = { state: 'done', hint: 'оплачено вне сервиса' };
    else if (duplicate) pay = { state: 'blocked', hint: 'дубликат не оплачивается' };
    else if (payment && payment.status === 'created') {
      const kind = payment.bank_status_kind;
      if (kind === 'paid') pay = { state: 'done', hint: 'оплачено' };
      else if (kind === 'failed') pay = { state: 'error', hint: payment.bank_status_label || 'банк отклонил платёж' };
      else if (kind === 'in_progress') pay = { state: 'progress', hint: payment.bank_status_label || 'в работе банка' };
      else pay = { state: 'progress', hint: 'черновик · ждёт подписи' };
    } else if (payment && payment.status === 'pending') pay = { state: 'progress', hint: 'создаётся' };
    else if (payment && payment.status === 'failed') pay = { state: 'error', hint: 'платёжка не создана', action: { kind: 'pay', label: 'Повторить' } };
    else if (sber && (!sber.connected || !sber.payer_complete)) pay = { state: 'off', hint: 'СберБизнес не подключён' };
    else if (!sber || payment === undefined) pay = { state: 'idle', hint: '…' };
    else pay = { state: 'idle', hint: checked === 6 ? 'сумма и назначение заполнены' : `нужна сверка 6 из 6`, action: { kind: 'pay', label: 'Создать платёжку' } };

    return { verify, onec, pay };
  },

  /** Какой шаг открыть сразу: первый, где есть что делать. */
  defaultStep(states) {
    if (states.verify.state === 'current') return 'verify';
    if (['idle', 'error'].includes(states.onec.state)) return 'onec';
    if (['idle', 'error', 'progress'].includes(states.pay.state)) return 'pay';
    if (states.onec.state === 'queued') return 'onec';
    return states.pay.state === 'done' ? 'pay' : 'onec';
  },

  /** Пункты меню «⋯» — только применимые к накладной; null — разделитель. */
  menuItems(inv) {
    const xml = App.isXmlInvoice(inv);
    if (inv.duplicate_of || inv.status === 'duplicate') {
      return [{ id: 'notDuplicate', label: 'Это не дубликат' }, null, { id: 'delete', label: 'Удалить дубликат', danger: true }];
    }
    const unmapped = this.unmappedCount(inv);
    const mapped = (inv.items || []).some(it => it.onec_guid);
    const golden = Number(inv.golden) === 1;
    const items = [
      { id: 'rescan', label: xml ? 'Перечитать XML' : 'Пересканировать фото' },
      xml ? null : { id: 'addPages', label: 'Добавить страницы' },
      null,
      unmapped ? { id: 'remapMissing', label: 'Подобрать недостающие позиции 1С' } : null,
      { id: 'remapAll', label: 'Подобрать позиции 1С заново' },
      { id: 'llm', label: unmapped ? 'Подобрать позиции с помощью ИИ' : 'Переподобрать все позиции с помощью ИИ' },
      mapped ? { id: 'confirmMappings', label: 'Подтвердить все позиции 1С' } : null,
      null,
      { id: 'editHeader', label: 'Изменить реквизиты' },
      { id: 'compare', label: 'Сравнить с прошлой поставкой' },
      !xml || golden ? { id: 'golden', label: golden ? 'Убрать из эталонов' : 'Отметить эталоном' } : null,
      inv.status === 'sent_to_1c' ? { id: 'resetStatus', label: 'Сбросить статус «В 1С»' } : null,
      null,
      { id: 'delete', label: 'Удалить накладную', danger: true },
    ];
    // Разделители — только между группами: без двойных, без первого и последнего.
    const out = [];
    for (const it of items) {
      if (it === null) { if (out.length && out[out.length - 1] !== null) out.push(null); continue; }
      out.push(it);
    }
    while (out.length && out[out.length - 1] === null) out.pop();
    return out;
  },

  /** «Приходная накладная 2644 (вх. 17-0605773) от 07.10.2026» → «Приходная накладная 2644». */
  shortDocRef(ref) {
    const s = String(ref || '').trim();
    if (!s) return '';
    return s.replace(/\s*\(вх\.[^)]*\)/, '').replace(/\s+от\s+\d{2}\.\d{2}\.\d{4}.*$/, '').trim();
  },

  plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  },

  // ── Отрисовка ──────────────────────────────────────────────────────────

  ICON: {
    back: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
    more: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>',
    check: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
    doc: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/></svg>',
  },

  /** Отрисовать шапку, шаги и панели для накладной из GET /api/invoices/:id. */
  render(inv) {
    const sameInvoice = this.inv && this.inv.id === inv.id;
    this.inv = inv;
    if (!sameInvoice) { this.activeStep = null; this._userPicked = false; this.payment = undefined; this._thumbFor = null; }
    this.renderHeader();
    this.renderSteps();
    this.loadPayment(inv.id);
    this.loadThumb(inv.id);
  },

  renderHeader() {
    const inv = this.inv, el = document.getElementById('ic-head-main');
    if (!el) return;
    const title = inv.invoice_number ? `№ ${App.esc(inv.invoice_number)}` : 'Без номера';
    const date = inv.invoice_date ? ` <span class="ic-title-date">от ${App.esc(App.formatDate(inv.invoice_date))}</span>` : '';
    const parts = [];
    if (inv.supplier) parts.push(App.esc(inv.supplier));
    if (inv.total_sum != null) parts.push(`${App.formatMoney(inv.total_sum)} ₽`);
    if (inv.vat_sum != null && Number(inv.vat_sum) > 0) parts.push(`НДС ${App.formatMoney(inv.vat_sum)} ₽`);
    const n = (inv.items || []).length;
    if (n) parts.push(`${n} ${this.plural(n, 'позиция', 'позиции', 'позиций')}`);
    const pills = [];
    if (inv.duplicate_of || inv.status === 'duplicate') pills.push('<span class="ic-pill ic-pill--amber">Дубликат</span>');
    if (inv.status === 'error') pills.push('<span class="ic-pill ic-pill--red">Ошибка распознавания</span>');
    if (inv.status === 'waiting_ai') pills.push('<span class="ic-pill ic-pill--blue">Ждёт GPT</span>');
    if (['new', 'ocr_processing', 'parsing'].includes(inv.status)) pills.push('<span class="ic-pill ic-pill--blue">Распознаётся</span>');
    if (Number(inv.golden) === 1) pills.push('<span class="ic-pill ic-pill--grey" title="По этой накладной проверяется распознавание после обновлений">Эталон</span>');
    el.innerHTML = `<h1 class="ic-title">${title}${date}${pills.join('')}</h1><div class="ic-sub">${parts.join(' · ') || '&nbsp;'}</div>`;
  },

  renderSteps() {
    const inv = this.inv, el = document.getElementById('ic-steps');
    if (!el || !inv) return;
    const states = this.stepStates(inv, this.sber, this.payment);
    this.states = states;
    if (!this.activeStep) this.activeStep = this.defaultStep(states);
    const titles = { verify: 'Сверка с оригиналом', onec: 'Отправка в 1С', pay: 'Оплата в СберБизнес' };
    el.innerHTML = this.STEPS.map((key, i) => {
      const s = states[key];
      const active = this.activeStep === key;
      const mark = s.state === 'done' ? this.ICON.check : s.state === 'error' ? '!' : String(i + 1);
      // Главная кнопка — в панели открытого шага; на других шагах — короткий путь, без заливки.
      const action = s.action && !active && !['blocked', 'off'].includes(s.state)
        ? `<button type="button" class="btn btn-outline btn-sm ic-step-action" onclick="event.stopPropagation();InvoiceCard.stepAction('${s.action.kind}', this)">${App.esc(s.action.label)}</button>`
        : '';
      return `<div class="ic-step ic-step--${s.state}${active ? ' is-active' : ''}" role="tab" tabindex="0" aria-selected="${active}" data-step="${key}"
        onclick="InvoiceCard.selectStep('${key}')" onkeydown="if(event.target===this&&(event.key==='Enter'||event.key===' ')){event.preventDefault();InvoiceCard.selectStep('${key}')}">
        <span class="ic-step-mark">${mark}</span>
        <span class="ic-step-text"><b>${titles[key]}</b><small>${App.esc(s.hint)}</small></span>${action}</div>`;
    }).join('');
    this.showPanel();
    this.renderOnecPanel();
  },

  selectStep(key) {
    if (!this.STEPS.includes(key)) return;
    this.activeStep = key;
    this._userPicked = true;
    this.renderSteps();
  },

  showPanel() {
    document.querySelectorAll('#ic-panels [data-panel]').forEach(p => { p.hidden = p.dataset.panel !== this.activeStep; });
  },

  stepAction(kind, btn) {
    const inv = this.inv;
    if (!inv) return;
    if (kind === 'send1c') return Invoices.sendTo1C(inv.id, null);
    if (kind === 'pay') {
      this.selectStep('pay');
      document.getElementById('ic-panels')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    return undefined;
  },

  /** Панель шага «Отправка в 1С»: что с накладной в 1С и что можно сделать. */
  renderOnecPanel() {
    const inv = this.inv, el = document.getElementById('ic-onec-panel');
    if (!el || !inv) return;
    const s = this.states?.onec || this.stepStates(inv).onec;
    const n = this.unmappedCount(inv);
    const ref = App.esc(inv.onec_document_ref || '');
    // Строка состояния слева, действия справа (на узкой колонке — под ней).
    const row = (tone, title, note, actions = '') => `<div class="ic-panel-row">
        <div class="ic-onec-line${tone ? ` ic-onec-line--${tone}` : ''}">${tone === 'ok' ? this.ICON.check : '<span class="ic-dot"></span>'}<div><b>${title}</b>${note ? `<small>${note}</small>` : ''}</div></div>
        ${actions ? `<div class="ic-panel-actions">${actions}</div>` : ''}</div>`;
    let body;
    if (s.state === 'done') {
      const when = inv.sent_at ? `Отправлена ${App.esc(App.formatDateTime(inv.sent_at))}` : '';
      body = row('ok', `Загружена в 1С${ref ? `: ${ref}` : ''}`,
        inv.onec_status === 'created' ? `${when}${when ? ' · ' : ''}документ создан, но не проведён — проведите его в 1С` : when,
        `<button type="button" class="ic-link" onclick="Invoices.resetStatus(${inv.id})">Сбросить статус «В 1С»</button>`);
    } else if (s.state === 'queued') {
      body = row('blue', 'Ждёт загрузки в 1С', '1С забирает очередь раз в минуту. Пока не забрала — отправку можно отозвать.',
        `<button type="button" class="btn btn-outline btn-sm" onclick="Invoices.unapproveForOneC(${inv.id})">Отозвать отправку</button>`);
    } else if (s.state === 'error') {
      body = row('red', '1С не приняла накладную', App.esc(inv.onec_error || 'Причина не передана — откройте журнал интеграций'),
        `<a class="ic-link" href="#/integrations-log">Журнал интеграций</a>${inv.approved_for_1c
          ? `<button type="button" class="btn btn-outline btn-sm" onclick="Invoices.unapproveForOneC(${inv.id})">Отозвать отправку</button>`
          : inv.status === 'processed' ? `<button type="button" class="btn btn-primary btn-sm" onclick="Invoices.sendTo1C(${inv.id}, null)">Отправить снова</button>` : ''}`);
    } else if (s.state === 'blocked') {
      body = row('', 'Отправить в 1С пока нельзя', App.esc(inv.completeness?.message || inv.error_message || s.hint),
        inv.completeness?.message ? `<button type="button" class="btn btn-outline btn-sm" onclick="Invoices.addPages(${inv.id}, event)">Добавить страницы</button>` : '');
    } else {
      body = row('', 'Накладная ещё не отправлена в 1С',
        n ? `${n} ${this.plural(n, 'строка', 'строки', 'строк')} без позиции 1С — 1С создаст ${n === 1 ? 'товар' : 'товары'} по названию из накладной.` : 'Все строки сопоставлены с позициями 1С.',
        `${n ? `<button type="button" class="ic-link" onclick="Invoices.remap(${inv.id}, false, event)">Подобрать недостающие позиции</button>` : ''}
         <button type="button" class="btn btn-primary btn-sm" onclick="Invoices.sendTo1C(${inv.id}, null)">Отправить в 1С</button>`);
    }
    el.innerHTML = body;
  },

  /** Статус Сбера и платёж — для шага 3; блок оплаты рисует Sber.renderInvoiceSection. */
  async loadPayment(id) {
    try {
      // Статус Сбера берём у модуля Sber (его обновляет страница подключения), свой — запасной.
      const st = window.Sber?.state?.status || this.sber || await App.apiJson('/sber/status');
      this.sber = st && typeof st === 'object' ? st : { connected: false };
      if (window.Sber?.state && !window.Sber.state.status) window.Sber.state.status = this.sber;
      const res = await App.apiJson(`/invoices/${id}/sber-status`);
      if (!this.inv || this.inv.id !== id) return;
      this.payment = res?.payment ?? null;
    } catch {
      if (!this.inv || this.inv.id !== id) return;
      this.payment = null;
    }
    // Шаг по умолчанию мог зависеть от платежа — пересчитать, если пользователь ещё не выбирал.
    if (!this._userPicked) this.activeStep = null;
    this.renderSteps();
  },

  /** Превью первого листа в шапке; PDF и XML — значок документа. */
  async loadThumb(id) {
    const btn = document.getElementById('ic-thumb');
    if (!btn) return;
    // Та же накладная с теми же файлами — превью уже на месте; добавили страницы — обновить.
    const key = `${id}:${this.inv?.file_name || ''}`;
    if (this._thumbFor === key) return;
    this._thumbFor = key;
    const label = (files, kind) => {
      const n = files.length;
      if (kind === 'xml') return 'XML-документ';
      if (kind === 'pdf') return 'PDF';
      return n > 1 ? `${n} ${this.plural(n, 'лист', 'листа', 'листов')}` : '1 лист';
    };
    btn.innerHTML = `<span class="ic-thumb-img ic-thumb-img--empty">${this.ICON.doc}</span><span class="ic-thumb-text"><b>Скан</b><small>…</small></span>`;
    try {
      const { data } = await App.apiJson(`/invoices/${id}/photos`);
      if (!this.inv || this.inv.id !== id) return;
      const files = (data || []).filter(f => f.exists !== false);
      const image = files.find(f => (f.kind || 'image') === 'image' && !/\.(pdf|xml)$/i.test(f.filename));
      const kind = image ? 'image' : files.some(f => /\.xml$/i.test(f.filename)) ? 'xml' : files.some(f => /\.pdf$/i.test(f.filename)) ? 'pdf' : 'none';
      const img = image
        ? `<img class="ic-thumb-img" alt="" src="/api/invoices/${id}/review/image/${encodeURIComponent(image.filename)}?key=${encodeURIComponent(App.apiKey)}">`
        : `<span class="ic-thumb-img ic-thumb-img--empty">${this.ICON.doc}</span>`;
      btn.innerHTML = `${img}<span class="ic-thumb-text"><b>${kind === 'none' ? 'Файл удалён' : 'Скан'}</b><small>${kind === 'none' ? 'по сроку хранения' : label(files, kind)}</small></span>`;
      btn.disabled = kind === 'none';
    } catch {
      btn.innerHTML = `<span class="ic-thumb-img ic-thumb-img--empty">${this.ICON.doc}</span><span class="ic-thumb-text"><b>Скан</b><small>открыть</small></span>`;
    }
  },

  /** Скан в правой панели: target — реквизит или строка; без него превью открывает и закрывает скан. */
  openScan(target) {
    if (typeof InvoiceReview === 'undefined') return;
    if (target) InvoiceReview.select(target);
    else InvoiceReview.toggleSource();
  },

  // ── Меню «⋯» (общее для шапки и строк) ─────────────────────────────────

  openMore(anchor) {
    const inv = this.inv;
    if (!inv) return;
    const actions = {
      notDuplicate: () => Invoices.unlinkDuplicate(inv.id),
      rescan: (ev) => Invoices.rescan(inv.id, ev, App.isXmlInvoice(inv)),
      addPages: (ev) => Invoices.addPages(inv.id, ev),
      remapMissing: (ev) => Invoices.remap(inv.id, false, ev),
      remapAll: (ev) => Invoices.remap(inv.id, true, ev),
      llm: (ev) => Invoices.llmRemap(inv.id, this.unmappedCount(inv) === 0, ev),
      confirmMappings: (ev) => Invoices.confirmMappings(inv.id, ev),
      editHeader: () => Invoices.editHeader(inv.id),
      compare: () => InvoiceReview.compare(),
      golden: () => this.toggleGolden(),
      resetStatus: () => Invoices.resetStatus(inv.id),
      delete: () => Invoices.deleteInvoice(inv.id),
    };
    this.openMenu(anchor, this.menuItems(inv).map(it => it && { ...it, onClick: actions[it.id] }), 'Действия с накладной');
  },

  async toggleGolden() {
    const inv = this.inv;
    const next = Number(inv.golden) !== 1;
    try {
      await App.apiJson(`/golden/invoices/${inv.id}`, { method: 'PATCH', body: { golden: next } });
      inv.golden = next ? 1 : 0;
      this.renderHeader();
      App.notify(next ? 'Накладная отмечена эталоном' : 'Накладная убрана из эталонов', 'success');
    } catch (e) {
      App.notify(e.message || 'Не удалось изменить отметку эталона', 'error');
    }
  },

  /** Всплывающее меню у кнопки: items — [{label, onClick, danger}] и null-разделители. */
  openMenu(anchor, items, label = 'Меню') {
    // Повторное нажатие на ту же кнопку закрывает меню.
    if (this._menu && this._menu.anchor === anchor) { this.closeMenu(); return; }
    this.closeMenu();
    const menu = document.createElement('div');
    menu.className = 'ic-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', label);
    items.forEach(it => {
      if (!it) { const hr = document.createElement('div'); hr.className = 'ic-menu-sep'; hr.setAttribute('role', 'separator'); menu.appendChild(hr); return; }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ic-menu-item' + (it.danger ? ' ic-menu-item--danger' : '');
      b.setAttribute('role', 'menuitem');
      b.textContent = it.label;
      b.onclick = (ev) => { this.closeMenu(); it.onClick?.(ev); };
      menu.appendChild(b);
    });
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    const w = menu.offsetWidth, h = menu.offsetHeight;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w));
    const below = r.bottom + 6 + h <= window.innerHeight;
    menu.style.left = `${left + window.scrollX}px`;
    menu.style.top = `${(below ? r.bottom + 6 : Math.max(8, r.top - h - 6)) + window.scrollY}px`;
    anchor.setAttribute('aria-expanded', 'true');
    this._menu = { el: menu, anchor };
    menu.querySelector('button')?.focus();
    setTimeout(() => {
      this._menuOutside = (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) this.closeMenu(); };
      this._menuKey = (e) => {
        if (e.key === 'Escape') { this.closeMenu(); anchor.focus(); }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          const btns = [...menu.querySelectorAll('button')];
          const i = btns.indexOf(document.activeElement);
          btns[(i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length]?.focus();
          e.preventDefault();
        }
      };
      document.addEventListener('mousedown', this._menuOutside);
      document.addEventListener('keydown', this._menuKey);
    });
  },

  closeMenu() {
    if (!this._menu) return;
    this._menu.anchor.setAttribute('aria-expanded', 'false');
    this._menu.el.remove();
    this._menu = null;
    document.removeEventListener('mousedown', this._menuOutside);
    document.removeEventListener('keydown', this._menuKey);
  },

  /** Меню строки товара: показать на скане, вернуть «как в накладной», пересчитать, запомнить, удалить. */
  openRowMenu(anchor, itemId) {
    const inv = this.inv;
    const item = (inv?.items || []).find(it => it.id === itemId);
    if (!item) return;
    const rawDiffers = item.raw_quantity != null && (Number(item.raw_quantity) !== Number(item.quantity) || Invoices._normUnit(item.raw_unit) !== Invoices._normUnit(item.unit));
    const needsWork = !!item.qty_flag || Invoices._unitMismatch(item);
    const hasImages = !App.isXmlInvoice(inv);
    const items = [
      hasImages ? { label: 'Показать на скане', onClick: () => this.openScan(`item:${item.id}:row`) } : null,
      rawDiffers ? { label: `Как в накладной (${App.formatQty(item.raw_quantity)} ${item.raw_unit || ''}`.trim() + ')', onClick: () => Invoices.itemRevertRaw(inv.id, item.id) } : null,
      needsWork ? { label: 'Пересчитать количество', onClick: () => Invoices.itemReconvert(inv.id, item.id) } : null,
      (item.onec_guid || item.target_unit) && (needsWork || rawDiffers) ? { label: 'Запомнить пересчёт для поставщика', onClick: () => Invoices.itemRememberRule(inv.id, item.id) } : null,
      null,
      { label: 'Удалить строку', danger: true, onClick: () => Invoices.deleteItem(inv.id, item.id, String(item.original_name || '').slice(0, 60)) },
    ].filter((x, i, a) => x !== null || (i > 0 && a[i - 1] !== null));
    if (items[0] === null) items.shift();
    this.openMenu(anchor, items, 'Действия со строкой');
  },
};

if (typeof window !== 'undefined') window.InvoiceCard = InvoiceCard;
