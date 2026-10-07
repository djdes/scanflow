/* global App, Queue, Invoices */
// «Очередь в 1С» (#/queue): накладные компании, которые ещё не ушли в 1С.
// По каждой — готова ли к 1С и что держит (причины гейта автопилота + то, что
// 1С не примет), строки без позиции 1С и с количеством под вопросом, платёжка
// в Сбере, перераспознавание фото.
//   • «→ 1С» — существующее массовое одобрение POST /api/invoices/send-1c-batch
//     (его правила не дублируем; здесь только не отправляем то, что 1С точно
//     не примет, и спрашиваем подтверждение для накладных с замечаниями);
//   • «Подобрать позиции ИИ» и «Перераспознать» — фоновые задачи на сервере,
//     строго по одной накладной; ход — опросом /api/queue/{reocr|llm-map}/status;
//   • перераспознавание шапку не меняет, строки — только по кнопке «Применить»
//     в раскрытой накладной; прежние строки возвращаются кнопкой «Вернуть».
// Разметка — из данных сервера только через App.esc; обработчики —
// делегированные, по data-action (без строк в onclick).
const Queue = {
  rows: [],
  summary: null,
  jobs: null,
  filter: 'all',          // all | ready | blocked | approved
  selected: new Set(),
  open: null,             // id накладной с раскрытой панелью
  card: null,             // GET /queue/:id раскрытой накладной
  cardError: null,
  hiddenJobs: new Set(),  // id законченных задач, итог которых скрыли
  _bound: false,
  _pollTimer: null,
  _loadSeq: 0,
  _cardSeq: 0,

  POLL_MS: 3000,
  JOB_PATH: { reocr: 'reocr', llm_map: 'llm-map' },
  JOB_TITLE: { reocr: 'Перераспознавание', llm_map: 'Подбор позиций ИИ' },

  // ─── Загрузка ──────────────────────────────────────────────────────────────

  async load(opts = {}) {
    this._bind();
    const list = document.getElementById('queue-list');
    if (!list) return;
    const seq = ++this._loadSeq;
    if (!this.summary && !opts.quiet) list.innerHTML = '<div class="card"><div class="empty-state"><div>Загрузка…</div></div></div>';
    let body;
    try {
      body = await App.apiJson('/queue');
    } catch (e) {
      if (seq !== this._loadSeq) return;
      if (!opts.quiet) list.innerHTML = `<div class="card">Не удалось загрузить очередь: ${App.esc(e.message)}</div>`;
      else App.notify('Не удалось обновить очередь: ' + e.message, 'error');
      return;
    }
    if (seq !== this._loadSeq) return;
    this.rows = Array.isArray(body.data) ? body.data : [];
    this.summary = body.summary || null;
    this.jobs = body.jobs || null;
    const ids = new Set(this.rows.map(r => r.id));
    for (const id of [...this.selected]) if (!ids.has(id)) this.selected.delete(id);
    if (this.open != null && !ids.has(this.open)) { this.open = null; this.card = null; }
    this.render();
    if (this.open != null) this._loadCard(this.open);
    this._ensurePolling();
  },

  async _loadCard(id) {
    const seq = ++this._cardSeq;
    try {
      const { data } = await App.apiJson(`/queue/${id}`);
      if (seq !== this._cardSeq || this.open !== id) return;
      this.card = data;
      this.cardError = null;
    } catch (e) {
      if (seq !== this._cardSeq || this.open !== id) return;
      this.card = null;
      this.cardError = e.message || 'Не удалось загрузить накладную';
    }
    this._renderPanel();
  },

  row(id) {
    return this.rows.find(r => r.id === id) || null;
  },

  // ─── Отрисовка ─────────────────────────────────────────────────────────────

  render() {
    this.renderSummary();
    this.renderJobs();
    this.renderActions();
    this.renderList();
    this.renderBulkBar();
  },

  renderSummary() {
    const host = document.getElementById('queue-summary');
    if (!host) return;
    const s = this.summary;
    if (!s) { host.innerHTML = ''; return; }
    const tile = (key, label, value, sub, mod) => `
      <button type="button" class="queue-tile${mod ? ` queue-tile--${mod}` : ''}${this.filter === key ? ' is-active' : ''}"
              data-action="filter" data-filter="${key}" aria-pressed="${this.filter === key}">
        <span class="queue-tile__value">${value}</span>
        <span class="queue-tile__label">${label}</span>
        ${sub ? `<small>${sub}</small>` : ''}
      </button>`;
    const oldestApproved = this.rows.filter(r => r.state === 'approved' && r.approved_at)
      .map(r => r.approved_at).sort()[0];
    host.innerHTML = `
      <div class="queue-tiles" role="group" aria-label="Фильтр очереди">
        ${tile('all', 'в очереди', s.count, `${App.formatMoney(s.total_sum)} ₽`, '')}
        ${tile('ready', 'готовы к 1С', s.ready, s.ready ? 'замечаний нет' : '', 'ready')}
        ${tile('blocked', 'с замечаниями', s.blocked, s.blocked ? 'нужно посмотреть' : '', 'blocked')}
        ${tile('approved', 'одобрены, ждут 1С', s.approved, oldestApproved ? `ждут с ${App.esc(this._day(oldestApproved))}` : '', 'approved')}
      </div>
      ${s.sber_created ? `<p class="queue-note">Платёжки в Сбере созданы по ${s.sber_created} ${this._plural(s.sber_created, 'накладной', 'накладным', 'накладным')} из очереди${s.sber_paid ? ` — по <strong>${s.sber_paid}</strong> банк уже исполнил оплату, а в 1С их ещё нет` : ''}.</p>` : ''}`;
  },

  // Задачи на сервере: идущая — прогресс и «Остановить», законченная — итог.
  renderJobs() {
    const host = document.getElementById('queue-jobs');
    if (!host) return;
    const blocks = [];
    for (const kind of ['reocr', 'llm_map']) {
      const st = this.jobs && this.jobs[kind];
      const job = st && st.job;
      if (!job || this.hiddenJobs.has(`${kind}:${job.id}`)) continue;
      if (job.status !== 'running' && !this._recent(job.finished_at)) continue;
      blocks.push(this._jobHtml(kind, job));
    }
    const busy = this._busyForeign();
    if (busy && !blocks.length) {
      blocks.push(`<div class="queue-job queue-job--muted">Сервер сейчас выполняет такую задачу для другой компании — перераспознавание и подбор ИИ идут по одной. Кнопки станут доступны, когда она закончится.</div>`);
    }
    host.innerHTML = blocks.join('');
  },

  _jobHtml(kind, job) {
    const title = this.JOB_TITLE[kind];
    const planned = Number(job.planned) || 0;
    const done = Number(job.processed) || 0;
    const pct = planned ? Math.round((done / planned) * 100) : 0;
    if (job.status === 'running') {
      const current = job.current_invoice_id ? this.row(job.current_invoice_id) : null;
      const cur = current ? `сейчас ${App.esc(this._title(current))}` : '';
      const pace = kind === 'reocr' ? 'каждая накладная — до пары минут' : 'каждая накладная — до минуты';
      return `<div class="queue-job" role="status">
        <div class="queue-job__head">
          <strong>${title}: ${done} из ${planned}</strong>
          ${job.cancel_requested
            ? '<span class="queue-sub">остановится после текущей накладной</span>'
            : `<button type="button" class="btn btn-outline btn-sm" data-action="cancel-job" data-kind="${kind}">Остановить</button>`}
        </div>
        <div class="queue-progress" aria-hidden="true"><div style="width:${pct}%"></div></div>
        <div class="queue-sub">${[cur, pace, 'можно уйти со страницы — работа идёт на сервере'].filter(Boolean).join(' · ')}</div>
      </div>`;
    }
    const counts = job.counts || {};
    const parts = [];
    if (kind === 'reocr') {
      const results = Array.isArray(job.results) ? job.results : [];
      const withDiff = results.filter(r => r.status === 'done' && (Number(r.changed) + Number(r.added) + Number(r.removed)) > 0).length;
      const same = (counts.done || 0) - withDiff;
      if (withDiff) parts.push(`расхождения в строках — ${withDiff}`);
      if (same > 0) parts.push(`совпадает — ${same}`);
      if (counts.no_photo) parts.push(`нет фото — ${counts.no_photo}`);
    } else {
      const results = Array.isArray(job.results) ? job.results : [];
      const matched = results.reduce((s, r) => s + (Number(r.changed) || 0), 0);
      const guarded = results.reduce((s, r) => s + (Number(r.guarded) || 0), 0);
      parts.push(`подобрано позиций — ${matched}`);
      if (guarded) parts.push(`отклонено проверками (правило, «не это», размер) — ${guarded}`);
    }
    if (counts.error) parts.push(`ошибок — ${counts.error}`);
    if (counts.skipped) parts.push(`пропущено — ${counts.skipped}`);
    if (job.status === 'paused') {
      return `<div class="queue-job" role="status">
        <div class="queue-job__head">
          <strong>${title}: на паузе, ${done} из ${planned}</strong>
          <button type="button" class="btn btn-outline btn-sm" data-action="cancel-job" data-kind="${kind}">Остановить</button>
        </div>
        <div class="queue-sub">${App.esc(job.error || 'GPT сейчас недоступен — продолжится само.')}</div>
      </div>`;
    }
    const head = job.status === 'cancelled'
      ? `${title} остановлено: ${done} из ${planned}`
      : job.status === 'error'
        ? `${title} прервано ошибкой: ${App.esc(job.error || '')}`
        : `${title} закончено: ${done} ${this._plural(done, 'накладная', 'накладные', 'накладных')}`;
    const hint = kind === 'reocr' && parts.length ? ' Расхождения — в раскрытых накладных, строки меняются только по кнопке «Применить».' : '';
    return `<div class="queue-job queue-job--done" role="status">
      <div class="queue-job__head">
        <strong>${head}</strong>
        <button type="button" class="link-btn" data-action="hide-job" data-kind="${kind}" data-job="${Number(job.id)}">Скрыть</button>
      </div>
      <div class="queue-sub">${parts.join(' · ')}${hint}</div>
    </div>`;
  },

  renderActions() {
    const host = document.getElementById('queue-actions');
    if (!host) return;
    const s = this.summary;
    if (!s || !s.count) { host.innerHTML = ''; return; }
    const blocked = this._jobBlocked();
    const dis = (n) => (blocked || !n ? ' disabled' : '');
    host.innerHTML = `
      <button type="button" class="btn btn-soft btn-sm" data-action="llm-all"${dis(s.llm_todo)}
              title="Claude подберёт позиции справочника 1С для строк без позиции (кроме строк со своим названием и одобренных накладных)">
        Подобрать позиции ИИ${s.llm_todo ? ` (${s.llm_todo})` : ''}
      </button>
      <button type="button" class="btn btn-soft btn-sm" data-action="reocr-all"${dis(s.reocr_todo)}
              title="Фото распознаются заново текущим движком. Шапку не меняем, строки — только после вашей проверки. Уже перераспознанные пропускаются — после перезапуска сервера прогон продолжится.">
        Перераспознать очередь${s.reocr_todo ? ` (${s.reocr_todo})` : ''}
      </button>`;
  },

  _visibleRows() {
    if (this.filter === 'all') return this.rows;
    return this.rows.filter(r => r.state === this.filter);
  },

  renderList() {
    const list = document.getElementById('queue-list');
    if (!list) return;
    if (!this.rows.length) {
      list.innerHTML = `<div class="card"><div class="empty-state">
        <div class="empty-icon">&#9989;</div>
        <div>Очередь пуста — все распознанные накладные ушли в 1С.</div>
      </div></div>`;
      return;
    }
    const rows = this._visibleRows();
    if (!rows.length) {
      list.innerHTML = '<div class="card"><div class="empty-state"><div>В этом отборе накладных нет.</div></div></div>';
      return;
    }
    list.innerHTML = `<div class="table-wrap queue-table-wrap">
      <table class="queue-table">
        <thead><tr>
          <th class="col-check"><input type="checkbox" data-action="select-all" aria-label="Выбрать все в отборе"></th>
          <th>Накладная</th>
          <th class="queue-num">Сумма</th>
          <th>Готовность</th>
          <th>Строки</th>
          <th>Сбер</th>
          <th>Перераспознавание</th>
          <th></th>
        </tr></thead>
        <tbody>${rows.map(r => this.rowHtml(r)).join('')}</tbody>
      </table>
    </div>`;
    this._syncSelectAll();
  },

  _title(r) {
    const num = r.invoice_number ? `№ ${r.invoice_number}` : `без номера (#${r.id})`;
    return r.invoice_date ? `${num} от ${App.formatDate(r.invoice_date)}` : num;
  },

  rowHtml(r) {
    const esc = (s) => App.esc(s);
    const isOpen = this.open === r.id;
    const checked = this.selected.has(r.id) ? ' checked' : '';
    return `
      <tr class="queue-row queue-row--${r.state}${isOpen ? ' is-open' : ''}" data-row="${r.id}">
        <td class="col-check" data-label="Выбрать"><input type="checkbox" data-action="select" data-id="${r.id}"${checked} aria-label="Выбрать: ${esc(this._title(r))}"></td>
        <td data-label="Накладная">
          <div class="queue-cell">
            <a class="queue-inv" href="#/invoices/${r.id}" title="Открыть накладную">${esc(this._title(r))}</a>
            <div class="queue-sub">${esc(r.supplier || 'поставщик не распознан')}</div>
          </div>
        </td>
        <td class="queue-num" data-label="Сумма">
          <div class="queue-cell">${App.formatMoney(r.total_sum)}${this._vatLine(r)}</div>
        </td>
        <td data-label="Готовность"><div class="queue-cell">${this.readinessHtml(r)}</div></td>
        <td data-label="Строки"><div class="queue-cell">${this.linesHtml(r)}</div></td>
        <td data-label="Сбер"><div class="queue-cell">${this.sberHtml(r)}</div></td>
        <td data-label="Перераспознавание"><div class="queue-cell">${this.reocrCellHtml(r)}</div></td>
        <td class="cell-action">
          <button type="button" class="btn btn-outline btn-sm" data-action="toggle" data-id="${r.id}" aria-expanded="${isOpen}">${isOpen ? 'Свернуть' : 'Разобрать'}</button>
        </td>
      </tr>${isOpen ? `<tr class="queue-panel-row"><td colspan="8" id="queue-panel">${this.panelHtml()}</td></tr>` : ''}`;
  },

  _vatLine(r) {
    if (r.vat_sum == null) return '';
    const v = Number(r.vat_sum);
    if (!Number.isFinite(v)) return '';
    return v > 0 ? `<div class="list-vat">в т.ч. НДС ${App.formatMoney(v)}</div>` : '<div class="list-vat">без НДС</div>';
  },

  readinessHtml(r) {
    const esc = (s) => App.esc(s);
    if (r.state === 'approved') {
      const since = r.approved_at ? ` ${esc(this._day(r.approved_at))}` : '';
      const pulled = r.onec_pulled_at ? `<div class="queue-sub">1С забрала ${esc(App.formatDateTime(r.onec_pulled_at))}, подтверждения нет</div>` : '';
      return `<span class="badge badge-processed" title="Одобрена для 1С — ждёт, пока обработка 1С её заберёт">Одобрена, ждёт 1С</span>
        <div class="queue-sub">одобрена${since}</div>${pulled}`;
    }
    if (r.state === 'ready') return '<span class="badge badge-sent">Готова к 1С</span>';
    const hard = (r.reasons || []).some(x => x.hard);
    const n = (r.reasons || []).length;
    const top = (r.reasons || []).slice(0, 2).map(x => `<li${x.hard ? ' class="is-hard"' : ''}>${esc(x.message)}</li>`).join('');
    const more = n > 2 ? `<li class="queue-sub">ещё ${n - 2}…</li>` : '';
    return `<span class="badge ${hard ? 'badge-error' : 'badge-processing'}">${hard ? '1С не примет' : `Замечаний: ${n}`}</span>
      <ul class="queue-reasons">${top}${more}</ul>`;
  },

  linesHtml(r) {
    const parts = [];
    if (r.unmapped) parts.push(`<span${r.unmapped_open ? ' class="queue-warn"' : ''}>без позиции 1С: ${r.unmapped}</span>`);
    if (r.flagged) parts.push(`<span class="queue-bad">кол-во под вопросом: ${r.flagged}</span>`);
    if (r.risk_counts && r.risk_counts.unit_mismatch) parts.push(`<span class="queue-warn">ед. не как в 1С: ${r.risk_counts.unit_mismatch}</span>`);
    const legacy = r.legacy_lines ? `<div class="queue-sub" title="Строки записаны до пакета v2: пересчёт единиц мог быть неверным — перераспознайте, чтобы сравнить">до v2: ${r.legacy_lines}</div>` : '';
    return `${Number(r.lines) || 0} стр.${parts.length ? `<div class="queue-sub queue-line-flags">${parts.join('')}</div>` : ''}${legacy}`;
  },

  sberHtml(r) {
    const esc = (s) => App.esc(s);
    if (r.paid_externally) return '<span class="queue-sub" title="Оплачено вне сервиса — платёж в Сбер не нужен">оплачено вне сервиса</span>';
    const s = r.sber;
    if (!s) return '<span class="queue-muted" title="Платёжка в Сбер.Бизнес не создана">—</span>';
    const num = s.number ? ` №${esc(s.number)}` : '';
    if (s.status === 'failed') return `<span class="queue-bad" title="Ошибка отправки — детали в карточке накладной">ошибка отправки</span>`;
    if (s.status === 'pending') return '<span class="queue-sub">отправляется…</span>';
    if (s.bank_kind === 'paid') return `<span class="sber-cell-paid" title="Платёжка${num} исполнена банком">₽ ✓ исполнен</span>`;
    if (s.bank_kind === 'failed') return `<span class="queue-bad" title="Платёжка${num}">${esc(s.bank_label || 'отклонён')}</span>`;
    return `<span class="queue-sub" title="Черновик платёжки${num} в Сбер.Бизнес">${esc(s.bank_label || 'черновик создан')}</span>`;
  },

  reocrCellHtml(r) {
    const esc = (s) => App.esc(s);
    const x = r.reocr;
    if (!x) return r.photo === 'ok' ? '<span class="queue-muted">не было</span>' : '<span class="queue-muted" title="Фото удалено по сроку хранения — перераспознать нельзя">нет фото</span>';
    if (x.status === 'running') return '<span class="queue-sub">идёт…</span>';
    if (x.status === 'error') return `<span class="queue-bad" title="${esc(x.error || '')}">ошибка</span>`;
    if (x.status === 'no_photo') return `<span class="queue-muted" title="${esc(x.error || '')}">нет фото</span>`;
    if (x.status === 'skipped') return `<span class="queue-muted" title="${esc(x.error || '')}">пропущена</span>`;
    if (x.status === 'reverted') return '<span class="queue-sub">возвращено как было</span>';
    if (x.applied_at) return `<span class="queue-good">применено ${esc(this._day(x.applied_at))}</span>`;
    const s = x.summary || {};
    const changes = (Number(s.changed) || 0) + (Number(s.added) || 0) + (Number(s.removed) || 0);
    const head = Number(s.header_diff) ? '<div class="queue-sub">шапка на фото иначе</div>' : '';
    const stale = x.stale ? '<div class="queue-sub">строки меняли после</div>' : '';
    return changes
      ? `<span class="queue-warn">расхождения: ${changes} ${this._plural(changes, 'строка', 'строки', 'строк')}</span>${head}${stale}`
      : `<span class="queue-good">строки совпадают</span>${head}`;
  },

  // ─── Раскрытая накладная ───────────────────────────────────────────────────

  _renderPanel() {
    const host = document.getElementById('queue-panel');
    if (host) host.innerHTML = this.panelHtml();
  },

  panelHtml() {
    const esc = (s) => App.esc(s);
    const r = this.row(this.open);
    if (!r) return '';
    if (this.cardError) return `<div class="queue-panel"><p class="queue-bad">${esc(this.cardError)}</p></div>`;
    const c = this.card;
    if (!c || !c.invoice || c.invoice.id !== r.id) return '<div class="queue-panel"><p class="queue-sub">Загрузка…</p></div>';

    const reasons = (c.reasons || []).length
      ? `<ul class="queue-reason-list">${c.reasons.map(x => `<li${x.hard ? ' class="is-hard"' : ''}>${esc(x.message)}</li>`).join('')}</ul>`
      : '<p class="queue-good">Замечаний нет — можно отправлять в 1С.</p>';
    const approvedNote = c.state === 'approved'
      ? '<p class="queue-sub">Одобрена для 1С и ждёт, пока обработка 1С её заберёт. Строки не меняем; чтобы поправить, отзовите одобрение в карточке накладной.</p>'
      : '';
    const legacyNote = c.legacy_lines && c.workable
      ? `<p class="queue-sub">${c.legacy_lines} ${this._plural(c.legacy_lines, 'строка записана', 'строки записаны', 'строк записаны')} до пакета v2 — пересчёт единиц в них мог быть неверным. Перераспознайте фото, чтобы сравнить.</p>`
      : '';

    const risky = (c.items || []).filter(i => (i.risks || []).length);
    const clean = (c.items || []).length - risky.length;
    const riskText = (i) => (i.risks || []).map(x => this._riskText(x)).join('; ');
    const linesBlock = risky.length
      ? `<div class="table-wrap queue-mini-wrap"><table class="queue-mini">
          <thead><tr><th>Строка</th><th>Кол-во</th><th>Цена</th><th>Сумма</th><th>Замечание</th></tr></thead>
          <tbody>${risky.map(i => `<tr>
            <td><div class="queue-name">${esc(i.original_name)}</div>${i.mapped_name && i.mapped_name !== i.original_name ? `<div class="queue-sub">1С: ${esc(i.mapped_name)}</div>` : ''}</td>
            <td class="queue-num">${App.formatQty(i.quantity)} ${esc(i.unit || '')}</td>
            <td class="queue-num">${App.formatMoney(i.price)}</td>
            <td class="queue-num">${App.formatMoney(i.total)}</td>
            <td>${esc(riskText(i))}</td>
          </tr>`).join('')}</tbody>
        </table></div>${clean ? `<p class="queue-sub">ещё ${clean} ${this._plural(clean, 'строка', 'строки', 'строк')} без замечаний</p>` : ''}`
      : `<p class="queue-sub">${(c.items || []).length ? 'Строк с замечаниями нет.' : 'Строк нет.'}</p>`;

    const blocked = this._jobBlocked();
    const hard = (c.reasons || []).some(x => x.hard);
    const actions = [`<a class="btn btn-outline btn-sm" href="#/invoices/${r.id}">Открыть накладную</a>`];
    if (c.workable && !hard) {
      actions.push(`<button type="button" class="btn btn-primary btn-sm" data-action="approve-one" data-id="${r.id}">&rarr; 1С (одобрить)</button>`);
    }
    if (c.workable && c.unmapped_open) {
      actions.push(`<button type="button" class="btn btn-soft btn-sm" data-action="llm-one" data-id="${r.id}"${blocked ? ' disabled' : ''}>Подобрать позиции ИИ (${c.unmapped_open})</button>`);
    }

    return `<div class="queue-panel">
      <div class="queue-panel__cols">
        <div class="queue-panel__block">
          <h4>Что держит</h4>
          ${reasons}${approvedNote}${legacyNote}
        </div>
        <div class="queue-panel__block">
          <h4>Строки с замечаниями${risky.length ? ` — ${risky.length} из ${(c.items || []).length}` : ''}</h4>
          ${linesBlock}
        </div>
      </div>
      <div class="queue-panel__block queue-reocr">
        <h4>Перераспознавание фото</h4>
        ${this.reocrPanelHtml(c, r, blocked)}
      </div>
      <div class="queue-panel__actions">${actions.join('')}</div>
    </div>`;
  },

  _riskText(x) {
    switch (x.code) {
      case 'qty_flag': return x.note ? `количество под вопросом: ${x.note}` : 'количество под вопросом — проверьте пересчёт единиц';
      case 'unit_mismatch': return `в 1С позиция в «${x.onec_unit}» — проверьте количество`;
      case 'price_outlier': return `цена в ${String(x.ratio).replace('.', ',')} раза от обычной (${App.formatMoney(x.median_price)})`;
      case 'low_confidence': return `позиция 1С подобрана неуверенно (${Math.round((x.confidence || 0) * 100)}%)`;
      case 'new_item': return 'позиции в 1С нет — 1С создаст новую';
      default: return x.code;
    }
  },

  reocrPanelHtml(c, r, blocked) {
    const esc = (s) => App.esc(s);
    const x = c.reocr;
    const canRun = c.workable && c.photo !== 'missing';
    const runBtn = (label) => (canRun
      ? `<button type="button" class="btn btn-soft btn-sm" data-action="reocr-one" data-id="${r.id}"${blocked ? ' disabled' : ''}>${label}</button>`
      : '');
    const intro = '<p class="queue-sub">Фото распознаётся заново текущим движком и сравнивается с сохранёнными строками. Номер, дата, поставщик, сумма и НДС накладной не меняются; строки заменяются только по кнопке «Применить», прежние можно вернуть.</p>';
    const noPhoto = c.photo === 'missing' ? '<p class="queue-sub">Фото накладной нет (удалено по сроку хранения) — перераспознать нельзя.</p>' : '';
    const notWorkable = !c.workable ? '<p class="queue-sub">Накладная одобрена для 1С — её строки не меняем.</p>' : '';
    if (!x) return `${intro}${noPhoto}${notWorkable}${runBtn('Перераспознать')}`;
    if (x.status === 'running') return '<p class="queue-sub">Идёт распознавание… Результат появится здесь.</p>';
    if (x.status === 'error') return `<p class="queue-bad">Не удалось: ${esc(x.error || 'ошибка')}</p>${runBtn('Перераспознать ещё раз')}`;
    if (x.status === 'no_photo' || x.status === 'skipped') return `<p class="queue-sub">${esc(x.error || '')}</p>${notWorkable}${runBtn('Перераспознать ещё раз')}`;
    if (x.status === 'reverted') return `<p class="queue-sub">Строки перераспознавания применяли, потом вернули прежние.</p>${runBtn('Перераспознать ещё раз')}`;

    const when = x.finished_at ? `<span class="queue-sub"> · ${esc(App.formatDateTime(x.finished_at))}${x.model ? `, ${esc(x.model)}` : ''}</span>` : '';
    const header = (x.header_diff || []).length
      ? `<div class="queue-header-diff"><strong>Шапка на фото читается иначе</strong> — её не меняем; если на фото верно, поправьте в карточке накладной:
          <ul>${x.header_diff.map(h => `<li>${esc(this._headerLabel(h.field))}: ${esc(this._headerValue(h.field, h.stored))} → ${esc(this._headerValue(h.field, h.recognized))}</li>`).join('')}</ul></div>`
      : '';

    if (x.applied_at) {
      const rs = x.replaced_summary;
      const revert = x.can_revert && rs
        ? `<button type="button" class="btn btn-outline btn-sm" data-action="revert" data-id="${r.id}">Вернуть прежние строки (${rs.lines} стр. на ${App.formatMoney(rs.sum)} ₽)</button>`
        : '';
      return `<p class="queue-good">Применено ${esc(App.formatDateTime(x.applied_at))}: строки заменены распознанными.${when}</p>${header}${revert}`;
    }

    const d = x.diff;
    if (!d) return `${header}${runBtn('Перераспознать ещё раз')}`;
    const s = d.summary;
    const changes = s.changed + s.added + s.removed;
    const notes = [];
    if (x.stale) notes.push('Строки накладной меняли после перераспознавания — сравнение ниже уже с текущими.');
    if (changes && s.manual_lines) notes.push(`${s.manual_lines} ${this._plural(s.manual_lines, 'строку', 'строки', 'строк')} правили вручную (количество или своё название) — при применении эти правки пропадут.`);
    const diffRows = d.rows.filter(row => row.kind !== 'same');
    const same = d.rows.length - diffRows.length;
    const table = diffRows.length
      ? `<div class="table-wrap queue-mini-wrap"><table class="queue-mini queue-diff">
          <thead><tr><th></th><th>Сейчас</th><th>По фото</th></tr></thead>
          <tbody>${diffRows.map(row => this._diffRowHtml(row)).join('')}</tbody>
        </table></div>${same ? `<p class="queue-sub">ещё ${same} ${this._plural(same, 'строка совпадает', 'строки совпадают', 'строк совпадают')}</p>` : ''}`
      : '';
    const summaryLine = changes
      ? `<p><strong>Расхождения в строках:</strong> изменится ${s.changed}, новых ${s.added}, пропадёт ${s.removed}. Сумма строк: ${App.formatMoney(s.sum_current)} → ${App.formatMoney(s.sum_proposed)} ₽.${when}</p>`
      : `<p class="queue-good">Строки совпадают с распознанными — менять нечего.${when}</p>`;
    const apply = x.can_apply
      ? `<button type="button" class="btn btn-primary btn-sm" data-action="apply" data-id="${r.id}">Применить строки по фото</button>`
      : '';
    return `${summaryLine}${header}${notes.map(n => `<p class="queue-sub">${esc(n)}</p>`).join('')}${notWorkable}${table}
      <div class="queue-panel__actions">${apply}${runBtn('Перераспознать ещё раз')}</div>`;
  },

  _diffRowHtml(row) {
    const esc = (s) => App.esc(s);
    const kind = { changed: 'изменится', added: 'новая', removed: 'пропадёт' }[row.kind] || row.kind;
    const f = new Set(row.fields || []);
    const mark = (field, html) => (f.has(field) ? `<mark>${html}</mark>` : html);
    const side = (l, isCur) => {
      if (!l) return '<span class="queue-muted">—</span>';
      const onec = l.onec_guid ? (l.mapped_name || 'позиция 1С') : (l.mapped_name ? `новая: ${l.mapped_name}` : 'без позиции 1С');
      const qty = `${App.formatQty(l.quantity)} ${esc(l.unit || '')}`;
      const raw = !isCur && l.raw_quantity != null && (l.raw_quantity !== l.quantity || (l.raw_unit || '') !== (l.unit || ''))
        ? `<div class="queue-sub">в накладной: ${App.formatQty(l.raw_quantity)} ${esc(l.raw_unit || '')}</div>` : '';
      const flag = !isCur && l.qty_flag ? `<div class="queue-bad">${esc(l.qty_flag_note || 'количество под вопросом')}</div>` : '';
      const manual = isCur && l.manual ? '<div class="queue-sub">правили вручную</div>' : '';
      return `<div class="queue-name">${mark('name', esc(l.original_name))}</div>
        <div>${mark('quantity', qty)} × ${mark('price', App.formatMoney(l.price))} = ${mark('total', App.formatMoney(l.total))}${l.vat_rate != null ? ` · ${mark('vat_rate', `НДС ${esc(l.vat_rate)}%`)}` : ''}</div>
        <div class="queue-sub">1С: ${mark('onec', esc(onec))}</div>${raw}${flag}${manual}`;
    };
    return `<tr class="queue-diff--${row.kind}">
      <td><span class="queue-diff-kind">${kind}</span></td>
      <td>${side(row.current, true)}</td>
      <td>${side(row.proposed, false)}</td>
    </tr>`;
  },

  _headerLabel(field) {
    return { invoice_number: 'Номер', invoice_date: 'Дата', supplier_inn: 'ИНН поставщика', total_sum: 'Сумма', vat_sum: 'НДС' }[field] || field;
  },

  _headerValue(field, v) {
    if (v == null || v === '') return '—';
    if (field === 'total_sum' || field === 'vat_sum') return App.formatMoney(v);
    if (field === 'invoice_date') return App.formatDate(v);
    return String(v);
  },

  renderBulkBar() {
    const bar = document.getElementById('queue-bulk-bar');
    if (!bar) return;
    const n = this.selected.size;
    if (!n) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
    const rows = [...this.selected].map(id => this.row(id)).filter(Boolean);
    const approved = rows.filter(r => r.state === 'approved').length;
    const sum = rows.reduce((s, r) => s + Number(r.total_sum || 0), 0);
    const blocked = this._jobBlocked();
    bar.style.display = '';
    bar.innerHTML = `
      <span class="bulk-count">Выбрано ${n} на ${App.formatMoney(sum)} ₽</span>
      <button type="button" class="btn btn-primary btn-sm" data-action="approve-selected">&rarr; 1С (одобрить)</button>
      <button type="button" class="btn btn-soft btn-sm" data-action="llm-selected"${blocked ? ' disabled' : ''}>Подобрать позиции ИИ</button>
      <button type="button" class="btn btn-soft btn-sm" data-action="reocr-selected"${blocked ? ' disabled' : ''}>Перераспознать</button>
      <button type="button" class="btn btn-outline btn-sm" data-action="clear-selection">Снять выделение</button>
      ${approved ? `<span class="bulk-warn">одобренных: ${approved} — их строки не меняем</span>` : ''}`;
  },

  // ─── Действия ──────────────────────────────────────────────────────────────

  toggle(id) {
    if (this.open === id) {
      this.open = null;
      this.card = null;
    } else {
      this.open = id;
      this.card = null;
      this.cardError = null;
      this._loadCard(id);
    }
    this.renderList();
  },

  setFilter(key) {
    this.filter = key;
    this.renderSummary();
    this.renderList();
  },

  // Галочки не перерисовывают таблицу (фокус и раскрытая накладная остаются).
  toggleSelect(id, checked) {
    if (checked) this.selected.add(id); else this.selected.delete(id);
    this._syncSelectAll();
    this.renderBulkBar();
  },

  toggleSelectAll(checked) {
    for (const r of this._visibleRows()) {
      if (checked) this.selected.add(r.id); else this.selected.delete(r.id);
    }
    document.querySelectorAll('#queue-list [data-action="select"]').forEach((cb) => {
      cb.checked = this.selected.has(Number(cb.dataset.id));
    });
    this._syncSelectAll();
    this.renderBulkBar();
  },

  clearSelection() {
    this.selected.clear();
    document.querySelectorAll('#queue-list [data-action="select"]').forEach((cb) => { cb.checked = false; });
    this._syncSelectAll();
    this.renderBulkBar();
  },

  _syncSelectAll() {
    const all = document.querySelector('#queue-list [data-action="select-all"]');
    if (!all) return;
    const rows = this._visibleRows();
    const n = rows.filter(r => this.selected.has(r.id)).length;
    all.checked = rows.length > 0 && n === rows.length;
    all.indeterminate = n > 0 && n < rows.length;
  },

  // Одобрение для 1С — существующий POST /api/invoices/send-1c-batch.
  // Без реквизитов/строк или с согласованием по сумме не отправляем (1С не
  // примет / нужен отдельный путь), с замечаниями — после подтверждения.
  async approve(ids, btn) {
    const rows = ids.map(id => this.row(id)).filter(Boolean);
    const already = rows.filter(r => r.state === 'approved');
    const hard = rows.filter(r => r.state !== 'approved' && (r.reasons || []).some(x => x.hard));
    const soft = rows.filter(r => r.state === 'blocked' && !(r.reasons || []).some(x => x.hard));
    const send = rows.filter(r => r.state === 'ready').concat(soft);
    const names = (list) => list.slice(0, 5).map(r => this._title(r)).join(', ') + (list.length > 5 ? ` и ещё ${list.length - 5}` : '');
    if (!send.length) {
      const why = hard.length ? `у ${names(hard)} нет реквизитов для 1С или нужно согласование по сумме — откройте карточку` : 'все выбранные уже одобрены';
      App.notify(`Одобрять нечего: ${why}.`, 'info');
      return;
    }
    const sum = send.reduce((s, r) => s + Number(r.total_sum || 0), 0);
    let msg = `Одобрить для 1С ${send.length} ${this._plural(send.length, 'накладную', 'накладные', 'накладных')} на ${App.formatMoney(sum)} ₽?\n\nОбработка 1С заберёт их при следующей загрузке.`;
    if (soft.length) msg += `\n\nС замечаниями: ${soft.length} (${names(soft)}) — уйдут в 1С как есть.`;
    if (hard.length) msg += `\n\nПропускаем ${hard.length} — нет реквизитов для 1С или нужно согласование по сумме: ${names(hard)}.`;
    if (already.length) msg += `\n\nУже одобрены: ${already.length}.`;
    if (!window.confirm(msg)) return;
    await App.withBusyButton(btn, async () => {
      try {
        const { data } = await App.apiJson('/invoices/send-1c-batch', { method: 'POST', body: { ids: send.map(r => r.id) } });
        if (typeof Invoices !== 'undefined' && Invoices._showBulkReport) Invoices._showBulkReport([['1С', data]]);
        else App.notify(`1С: ${data.sent} одобрено, ${data.skipped.length} пропущено`, data.skipped.length ? 'info' : 'success');
        for (const r of send) this.selected.delete(r.id);
      } catch (e) {
        App.notify('Не удалось одобрить: ' + e.message, 'error');
      }
      await this.load({ quiet: true });
    });
  },

  async startJob(kind, ids, btn, opts = {}) {
    const n = ids ? ids.length : (kind === 'reocr' ? this.summary.reocr_todo : this.summary.llm_todo);
    const what = `${n} ${this._plural(n, 'накладной', 'накладных', 'накладных')}`;
    let msg;
    if (kind === 'reocr') {
      const minutes = Math.max(1, Math.round(n * 0.5));
      msg = `Перераспознать фото ${what}?\n\nНакладные идут по одной, каждая — до пары минут (всего примерно ${minutes}–${n * 2} мин.). Можно закрыть страницу — работа идёт на сервере.\n\nНомер, дата, поставщик, сумма и НДС не меняются. Строки меняются только после вашей проверки — кнопкой «Применить» в каждой накладной.`;
      if (!ids) msg += '\n\nУже перераспознанные накладные пропускаются.';
    } else {
      msg = `Подобрать позиции 1С с помощью ИИ для строк без позиции в ${what}?\n\nСтроки со своим названием для 1С и одобренные накладные не трогаются. Подтверждённые правила и отклонённые «не это» позиции ИИ не перебивает.`;
    }
    if (ids && ids.some(id => (this.row(id) || {}).state === 'approved')) msg += '\n\nОдобренные для 1С накладные пропускаются — их строки не меняем.';
    if (!opts.skipConfirm && !window.confirm(msg)) return;
    await App.withBusyButton(btn, async () => {
      try {
        const body = ids ? { ids } : {};
        const { data } = await App.apiJson(`/queue/${this.JOB_PATH[kind]}`, { method: 'POST', body });
        App.notify(`${this.JOB_TITLE[kind]}: запущено для ${data.planned} ${this._plural(data.planned, 'накладной', 'накладных', 'накладных')}`, 'success');
      } catch (e) {
        App.notify(e.message || 'Не удалось запустить', 'error');
      }
      await this.load({ quiet: true });
    });
  },

  async cancelJob(kind, btn) {
    await App.withBusyButton(btn, async () => {
      try {
        const { data } = await App.apiJson(`/queue/${this.JOB_PATH[kind]}/cancel`, { method: 'POST' });
        App.notify(data.cancelled ? 'Остановится после текущей накладной' : 'Задача уже закончилась', 'info');
      } catch (e) {
        App.notify(e.message, 'error');
      }
      await this.load({ quiet: true });
    });
  },

  async applyReocr(id, btn) {
    const x = this.card && this.card.invoice && this.card.invoice.id === id ? this.card.reocr : null;
    if (!x || !x.can_apply || !x.diff) return;
    const s = x.diff.summary;
    let msg = `Заменить строки накладной строками, распознанными по фото?\n\nИзменится ${s.changed}, новых ${s.added}, пропадёт ${s.removed}. Сумма строк: ${App.formatMoney(s.sum_current)} → ${App.formatMoney(s.sum_proposed)} ₽.\n\nНомер, дата, поставщик, сумма и НДС накладной не меняются. Прежние строки сохраняются — их можно вернуть кнопкой «Вернуть прежние строки».`;
    if (s.manual_lines) msg += `\n\nРучные правки в ${s.manual_lines} ${this._plural(s.manual_lines, 'строке', 'строках', 'строках')} пропадут.`;
    if (!window.confirm(msg)) return;
    await this._lineAction(id, 'apply', x.fingerprint, btn, (d) => `Строки заменены: было ${d.deleted}, стало ${d.inserted}`);
  },

  async revertReocr(id, btn) {
    const x = this.card && this.card.invoice && this.card.invoice.id === id ? this.card.reocr : null;
    if (!x || !x.can_revert || !x.replaced_summary) return;
    const rs = x.replaced_summary;
    const msg = `Вернуть строки, какие были до применения (${rs.lines} стр. на ${App.formatMoney(rs.sum)} ₽)?\n\nПравки строк, сделанные после применения, тоже пропадут.`;
    if (!window.confirm(msg)) return;
    await this._lineAction(id, 'revert', x.fingerprint, btn, (d) => `Прежние строки возвращены: ${d.inserted} стр.`);
  },

  async _lineAction(id, path, fingerprint, btn, okText) {
    await App.withBusyButton(btn, async () => {
      try {
        const { data } = await App.apiJson(`/queue/${id}/reocr/${path}`, { method: 'POST', body: { fingerprint } });
        const mismatch = data.items_total_mismatch ? ' — сумма строк расходится с итогом накладной, проверьте' : '';
        App.notify(okText(data) + mismatch, mismatch ? 'info' : 'success');
      } catch (e) {
        App.notify(e.message || 'Не удалось', 'error');
      }
      await this.load({ quiet: true });
    });
  },

  // ─── Фоновые задачи: опрос ─────────────────────────────────────────────────

  _runningKinds() {
    if (!this.jobs) return [];
    return ['reocr', 'llm_map'].filter(k => this.jobs[k] && this.jobs[k].job && this.jobs[k].job.status === 'running');
  },

  _busyForeign() {
    if (!this.jobs) return false;
    return ['reocr', 'llm_map'].some(k => this.jobs[k] && this.jobs[k].busy && !this.jobs[k].busy.own);
  },

  // Идёт своя задача или чужая — новые не запускаем (сервер делает их по одной).
  _jobBlocked() {
    return this._runningKinds().length > 0 || this._busyForeign();
  },

  _ensurePolling() {
    if (this._pollTimer) return;
    // Своя задача — часто (ход виден сразу); чужая — редко и только статусом:
    // она может идти час, а список очереди — сотни запросов к базе.
    if (this._runningKinds().length) this._pollTimer = setTimeout(() => this._poll(), this.POLL_MS);
    else if (this._busyForeign()) this._pollTimer = setTimeout(() => this._poll(), this.POLL_MS * 5);
  },

  async _poll() {
    this._pollTimer = null;
    if (window.location.hash !== '#/queue') return; // ушли со страницы — опрос остановлен, load() возобновит
    const running = this._runningKinds();
    if (!running.length) {
      try {
        const { data } = await App.apiJson('/queue/reocr/status');
        if (data && data.busy && !data.busy.own) { this._ensurePolling(); return; }
      } catch { this._ensurePolling(); return; }
      await this.load({ quiet: true }); // сервер освободился — кнопки снова доступны
      return;
    }
    let changed = false;
    for (const kind of running) {
      try {
        const { data } = await App.apiJson(`/queue/${this.JOB_PATH[kind]}/status`);
        const prev = this.jobs[kind] && this.jobs[kind].job;
        this.jobs[kind] = data;
        const cur = data && data.job;
        if (!cur || !prev || cur.id !== prev.id || cur.processed !== prev.processed || cur.status !== prev.status) changed = true;
      } catch { /* сеть моргнула — попробуем в следующий раз */ }
    }
    if (window.location.hash !== '#/queue') return;
    if (changed) {
      // Накладная обработана или задача закончилась — обновить строки очереди.
      await this.load({ quiet: true });
    } else {
      this.renderJobs();
      this._ensurePolling();
    }
  },

  _recent(iso) {
    if (!iso) return false;
    const t = Date.parse(iso);
    return Number.isFinite(t) && Date.now() - t < 30 * 60 * 1000;
  },

  // Дата из DATETIME базы («ГГГГ-ММ-ДД ЧЧ:ММ:СС»): Safari не разбирает её с
  // пробелом, поэтому берём только день.
  _day(s) {
    return s ? App.formatDate(String(s).slice(0, 10)) : '';
  },

  _plural(n, one, few, many) {
    const m10 = n % 10;
    const m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  },

  // Один раз на страницу: делегированные обработчики на секции.
  _bind() {
    if (this._bound) return;
    const view = document.getElementById('view-queue');
    if (!view) return;
    this._bound = true;

    view.addEventListener('click', (e) => {
      const el = e.target.closest('[data-action]');
      if (!el || !view.contains(el)) {
        // Клик по строке (не по ссылке и не по кнопке) раскрывает накладную.
        const tr = e.target.closest('tr.queue-row');
        if (tr && !e.target.closest('a, button, input, label')) this.toggle(Number(tr.dataset.row));
        return;
      }
      const id = Number(el.dataset.id);
      switch (el.dataset.action) {
        case 'reload': App.withBusyButton(el, () => this.load({ quiet: true })); break;
        case 'filter': this.setFilter(el.dataset.filter); break;
        case 'toggle': this.toggle(id); break;
        case 'clear-selection': this.clearSelection(); break;
        case 'approve-selected': this.approve([...this.selected], el); break;
        case 'approve-one': this.approve([id], el); break;
        case 'llm-all': this.startJob('llm_map', null, el); break;
        case 'llm-selected': this.startJob('llm_map', [...this.selected], el); break;
        case 'llm-one': this.startJob('llm_map', [id], el, { skipConfirm: true }); break;
        case 'reocr-all': this.startJob('reocr', null, el); break;
        case 'reocr-selected': this.startJob('reocr', [...this.selected], el); break;
        case 'reocr-one': this.startJob('reocr', [id], el, { skipConfirm: true }); break;
        case 'cancel-job': this.cancelJob(el.dataset.kind, el); break;
        case 'hide-job': this.hiddenJobs.add(`${el.dataset.kind}:${el.dataset.job}`); this.renderJobs(); break;
        case 'apply': this.applyReocr(id, el); break;
        case 'revert': this.revertReocr(id, el); break;
        default: break;
      }
    });
    view.addEventListener('change', (e) => {
      const t = e.target;
      if (t.matches('[data-action="select"]')) this.toggleSelect(Number(t.dataset.id), t.checked);
      else if (t.matches('[data-action="select-all"]')) this.toggleSelectAll(t.checked);
    });
    view.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.open != null && !e.target.matches('input, textarea, select')) {
        this.open = null;
        this.card = null;
        this.renderList();
      }
    });
  },
};
