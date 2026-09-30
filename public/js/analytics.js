/* global App, Invoices, Analytics */
// Аналитика: «Качество поставщиков» (#/analytics/quality, п.7) и «Закупочные
// цены» (#/analytics/prices, позиция — #/analytics/prices/<guid>, п.11).
// Данные — /api/analytics/*, строго по компании вошедшего. Разметка строится из
// данных сервера только через App.esc (подсказка графика — через textContent);
// обработчики — делегированные, по data-action (без строк в onclick).
const Analytics = {
  PERIODS: [
    { days: 30, label: '30 дней' },
    { days: 90, label: '90 дней' },
    { days: 180, label: 'Полгода' },
    { days: 365, label: 'Год' },
  ],
  PERIOD_KEY: 'sf_analytics_period',
  CACHE_MS: 120000,
  period: 90,

  TONE_LABEL: { good: 'норма', warn: 'присмотреться', bad: 'проблема' },
  VERDICT: {
    bad: { cls: 'badge-error', text: 'Часто с ошибками' },
    warn: { cls: 'badge-processing', text: 'Бывают ошибки' },
    good: { cls: 'badge-sent', text: 'Без замечаний' },
  },

  // Показатели качества: заголовок столбца и пояснение простыми словами.
  QUALITY_METRICS: [
    { key: 'edited', title: 'Правили строки',
      help: 'Доля строк, в которых после распознавания пришлось исправлять руками количество, единицу, цену, сумму или НДС, пересчитывать единицы, добавлять пропущенную строку или удалять лишнюю. Выбор позиции 1С и своё название для 1С сюда не входят — это сопоставление.' },
    { key: 'flagged', title: 'Пересчёт под вопросом',
      help: 'Доля строк, где ScanFlow не уверен в пересчёте единиц (например, «шт» в «кг») и просит проверить количество.' },
    { key: 'mismatch', title: 'Сумма не сходится',
      help: 'В скольких накладных сумма строк расходится с итогом накладной больше чем на 1% — обычно строка пропущена или прочитана неверно.' },
    { key: 'misaligned', title: 'Строки сдвинуты',
      help: 'В скольких накладных названия, похоже, съехали относительно чисел: строка без количества и цены, одно название у соседних строк или повтор номера строки. Так бывает на фото под углом — сверьте накладную с фото.' },
    { key: 'mapping', title: 'Без позиции 1С',
      help: 'Доля строк без позиции справочника 1С или с неуверенным подбором (меньше 80%). Их нужно сопоставить до отправки в 1С.' },
    { key: 'header', title: 'Правили шапку',
      help: 'Доля накладных, где исправляли номер, дату, поставщика, реквизиты, сумму или НДС. Откат из снимка и сумма платёжки в Сбер не считаются.' },
    { key: 'sent', title: 'В 1С',
      help: 'Сколько накладных уже ушло в 1С и сколько обычно (медиана) проходит от загрузки фото до отправки.' },
  ],

  quality: { data: null, filter: '', sort: 'worst', open: null, seq: 0 },
  prices: {
    q: '', view: 'items', risesSort: 'rub', guid: null, seq: 0, searchTimer: null,
    overview: null, overviewKey: '', overviewAt: 0,
    detail: null, detailKey: '', detailAt: 0,
  },
  _bound: {},
  _resizeTimer: null,

  // ─── Общие помощники ───────────────────────────────────────────────────────

  esc(s) { return App.esc(s); },

  plural(n, one, few, many) {
    const a = Math.abs(Math.trunc(Number(n) || 0));
    const m10 = a % 10;
    const m100 = a % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  },

  /** Доля 0…1 → «12%», «4,5%»; нет данных — «—». */
  share(v) {
    if (v == null || !Number.isFinite(Number(v))) return '—';
    const p = Number(v) * 100;
    const s = p.toLocaleString('ru-RU', { maximumFractionDigits: p < 10 ? 1 : 0 });
    return `${s === '0' && p > 0 ? '0,1' : s}%`;
  },

  /** Цена с копейками, без знака рубля. */
  money(v) { return v == null ? '—' : App.formatMoney(v); },

  /** Сумма в целых рублях. */
  rub(v) {
    if (v == null || !Number.isFinite(Number(v))) return '—';
    return `${Math.round(Number(v)).toLocaleString('ru-RU')} ₽`;
  },

  /** Изменение цены: дороже — ▲ (плохо для закупки), дешевле — ▼. */
  delta(p) {
    if (p == null || !Number.isFinite(Number(p))) return '<span class="an-muted">—</span>';
    const n = Number(p);
    const txt = `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%`;
    if (n > 0) return `<span class="an-delta an-delta--up" title="Дороже"><span aria-hidden="true">▲</span> ${txt}</span>`;
    if (n < 0) return `<span class="an-delta an-delta--down" title="Дешевле"><span aria-hidden="true">▼</span> ${txt}</span>`;
    return `<span class="an-delta">${txt}</span>`;
  },

  /** Медиана дней → «5 ч», «1,5 дня», «3 дня». */
  days(d) {
    if (d == null || !Number.isFinite(Number(d))) return '—';
    const n = Number(d);
    if (n < 1) return `${Math.max(1, Math.round(n * 24))} ч`;
    const word = Number.isInteger(n) ? this.plural(n, 'день', 'дня', 'дней') : 'дня';
    return `${n.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} ${word}`;
  },

  /** «YYYY-MM-DD…» → «ДД.ММ.ГГГГ» без часовых поясов. */
  date(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
    return m ? `${m[3]}.${m[2]}.${m[1]}` : '—';
  },

  _norm(s) { return String(s || '').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/\s+/g, ' ').trim(); },

  _toneLower(v, th) {
    if (v == null || !th) return null;
    return v <= th.good ? 'good' : v <= th.warn ? 'warn' : 'bad';
  },

  _dot(tone) {
    if (!tone) return '';
    return `<span class="an-dot an-dot--${tone}" aria-hidden="true"></span><span class="sr-only">${this.TONE_LABEL[tone]}: </span>`;
  },

  _loading(text = 'Загрузка…') {
    return `<div class="card"><div class="empty-state an-empty"><div>${this.esc(text)}</div></div></div>`;
  },

  _empty(html) {
    return `<div class="card"><div class="empty-state an-empty">${html}</div></div>`;
  },

  _error(message, action) {
    return `<div class="card an-error" role="alert">
      <p>Не удалось загрузить данные: ${this.esc(message || 'ошибка сервера')}</p>
      <button type="button" class="btn btn-outline btn-sm" data-action="${action}">Повторить</button>
    </div>`;
  },

  // ─── Период ────────────────────────────────────────────────────────────────

  _restorePeriod() {
    if (this._periodRestored) return;
    this._periodRestored = true;
    try {
      const saved = Number(localStorage.getItem(this.PERIOD_KEY));
      if (this.PERIODS.some(p => p.days === saved)) this.period = saved;
    } catch { /* хранилище недоступно — по умолчанию 90 дней */ }
  },

  _renderPeriods() {
    const html = this.PERIODS.map(p => `<button type="button" class="an-period__btn${p.days === this.period ? ' is-active' : ''}"
        data-action="period" data-days="${p.days}" aria-pressed="${p.days === this.period ? 'true' : 'false'}">${p.label}</button>`).join('');
    document.querySelectorAll('[data-an-period]').forEach((el) => { el.innerHTML = html; });
  },

  setPeriod(days) {
    if (!this.PERIODS.some(p => p.days === days) || days === this.period) return;
    this.period = days;
    try { localStorage.setItem(this.PERIOD_KEY, String(days)); } catch { /* не страшно */ }
    this._renderPeriods();
    const hash = window.location.hash || '';
    if (hash.startsWith('#/analytics/prices')) this.loadPrices(hash);
    else this.loadQuality();
  },

  // ─── Качество поставщиков ──────────────────────────────────────────────────

  async loadQuality() {
    this._restorePeriod();
    this._bindQuality();
    this._renderPeriods();
    const list = document.getElementById('an-quality-list');
    if (!list) return;
    const search = document.getElementById('an-quality-search');
    if (search && document.activeElement !== search) search.value = this.quality.filter;
    // Перезагрузка (другой период) держит прежнюю таблицу приглушённой, без мигания.
    if (this.quality.data && list.children.length) list.classList.add('an-is-loading');
    else list.innerHTML = this._loading();
    const seq = ++this.quality.seq;
    let data;
    try {
      ({ data } = await App.apiJson(`/analytics/suppliers?days=${this.period}`));
    } catch (e) {
      if (seq !== this.quality.seq) return;
      list.classList.remove('an-is-loading');
      list.innerHTML = this._error(e.message, 'reload-quality');
      return;
    }
    if (seq !== this.quality.seq) return;
    list.classList.remove('an-is-loading');
    this.quality.data = data;
    if (this.quality.open && !(data.suppliers || []).some(s => s.key === this.quality.open)) this.quality.open = null;
    this.renderQuality();
  },

  renderQuality() {
    const d = this.quality.data;
    const list = document.getElementById('an-quality-list');
    if (!d || !list) return;
    const kpis = document.getElementById('an-quality-kpis');
    const note = document.getElementById('an-quality-note');
    const help = document.getElementById('an-quality-help');
    const tools = document.getElementById('an-quality-tools');
    const has = (d.suppliers || []).length > 0;
    if (kpis) kpis.innerHTML = has ? this._qualityKpis(d) : '';
    if (note) note.innerHTML = has ? this._qualityNote(d) : '';
    if (help) help.innerHTML = this._qualityHelp(d);
    if (tools) tools.hidden = !has;
    this._renderQualityTable();
  },

  /** Только таблица: поиск, порядок и раскрытие строки не трогают карточки и пояснения. */
  _renderQualityTable() {
    const d = this.quality.data;
    const list = document.getElementById('an-quality-list');
    if (!d || !list) return;
    if (!(d.suppliers || []).length) {
      list.innerHTML = this._empty(`<div class="empty-icon" aria-hidden="true">📊</div>
        <div>За ${this.esc(this._periodText())} распознанных накладных нет — оценивать пока нечего.</div>
        <div class="an-sub">Выберите период длиннее или загрузите накладные.</div>`);
      return;
    }
    const q = this._norm(this.quality.filter);
    const idx = d.suppliers.map((s, i) => i).filter((i) => {
      if (!q) return true;
      const s = d.suppliers[i];
      return this._norm(s.name).includes(q) || String(s.inn || '').includes(q) || this._norm(s.search).includes(q);
    });
    if (this.quality.sort === 'invoices') idx.sort((a, b) => d.suppliers[b].invoices - d.suppliers[a].invoices || a - b);
    else if (this.quality.sort === 'sum') idx.sort((a, b) => d.suppliers[b].total_sum - d.suppliers[a].total_sum || a - b);
    if (!idx.length) {
      list.innerHTML = this._empty(`<div>По запросу «${this.esc(this.quality.filter)}» поставщиков нет.</div>`);
      return;
    }
    const cols = this.QUALITY_METRICS.map(m => `<th scope="col" title="${this.esc(m.help)}">${this.esc(m.title)}</th>`).join('');
    list.innerHTML = `<div class="table-wrap an-table-wrap">
      <table class="cards-mobile an-table an-qtable">
        <thead><tr><th scope="col">Поставщик</th>${cols}<th scope="col"><span class="sr-only">Подробнее</span></th></tr></thead>
        <tbody>${idx.map(i => this._qualityRow(d.suppliers[i], i, d)).join('')}</tbody>
      </table>
    </div>
    ${this.quality.sort === 'worst' && !q ? '<p class="field-hint an-foot">Порядок «Сначала проблемные»: поставщики с красными показателями, затем с жёлтыми; внутри — по тому, насколько показатели хуже порога. Наведите на заголовок столбца, чтобы прочитать, что он значит.</p>' : ''}`;
  },

  _periodText() {
    const p = this.PERIODS.find(x => x.days === this.period);
    return p && p.days >= 180 ? (p.days === 180 ? 'полгода' : 'год') : `${this.period} дней`;
  },

  _qualityKpis(d) {
    const t = d.totals;
    const th = d.thresholds || {};
    const tile = (value, label, sub, tone) => `<div class="an-kpi${tone ? ` an-kpi--${tone}` : ''}">
        <div class="an-kpi__value">${tone ? this._dot(tone) : ''}${value}</div>
        <div class="an-kpi__label">${label}</div>
        ${sub ? `<div class="an-kpi__sub">${sub}</div>` : ''}
      </div>`;
    const editedLines = t.edited_lines + t.deleted_lines;
    return [
      tile(String(t.invoices), this.plural(t.invoices, 'накладная', 'накладные', 'накладных'),
        `${t.suppliers} ${this.plural(t.suppliers, 'поставщик', 'поставщика', 'поставщиков')} · ${this.rub(t.total_sum)}`),
      tile(this.share(t.edited_share), 'строк правили руками',
        t.tracked_lines ? `${editedLines} из ${t.tracked_lines + t.deleted_lines}` : 'правки ещё не записывались',
        this._toneLower(t.edited_share, th.edited)),
      tile(String(t.mismatch_invoices), `${this.plural(t.mismatch_invoices, 'накладная', 'накладные', 'накладных')} с несходящейся суммой`,
        `строки сдвинуты — в ${t.misaligned_invoices}`, this._toneLower(t.mismatch_share, th.mismatch)),
      tile(this.days(t.median_days_to_1c), 'от фото до 1С (медиана)',
        `ушло в 1С ${t.sent_invoices} из ${t.invoices}`),
    ].join('');
  },

  _qualityNote(d) {
    const t = d.totals;
    const parts = [];
    const untracked = t.invoices - t.tracked_invoices;
    if (d.tracking_since && untracked > 0) {
      parts.push(`Правки и флаги пересчёта ScanFlow записывает с ${this.esc(this.date(d.tracking_since))}. ${untracked} ${this.plural(untracked, 'накладная', 'накладные', 'накладных')} за период ${this.plural(untracked, 'загружена', 'загружены', 'загружены')} раньше: по ним видны сумма, сдвиг строк, сопоставление и отправка в 1С, а доли правок считаются по остальным.`);
    }
    if (d.truncated) parts.push('В периоде слишком много накладных — учтены последние 5 000. Выберите период короче.');
    return parts.length ? `<div class="an-note" role="note">${parts.map(p => `<p>${p}</p>`).join('')}</div>` : '';
  },

  _qualityHelp(d) {
    const th = d.thresholds || {};
    const pct = v => `${Math.round(v * 100)}%`;
    const bounds = (key) => {
      const t = th[key];
      if (!t) return '';
      if (key === 'sent') return ` Норма — от ${pct(t.good)} ушедших, присмотреться — от ${pct(t.warn)}; до 1С — норма до ${th.days ? th.days.good : 2} дней.`;
      return ` Норма — до ${pct(t.good)}, присмотреться — до ${pct(t.warn)}, дальше — проблема.`;
    };
    const items = this.QUALITY_METRICS.map(m => `<dt>${this.esc(m.title)}</dt><dd>${this.esc(m.help)}${this.esc(bounds(m.key))}</dd>`).join('');
    return `<details class="an-help card">
      <summary>Что означают показатели</summary>
      <dl class="an-help__list">${items}
        <dt>Вывод по поставщику</dt>
        <dd>Худший из показателей распознавания: «Часто с ошибками» — хотя бы один красный, «Бывают ошибки» — жёлтый, «Без замечаний» — всё зелёное. Меньше ${Number(d.min_invoices_for_verdict) || 3} накладных — «Мало накладных»: выводы по одной-двум накладным делать рано.</dd>
      </dl>
    </details>`;
  },

  /** Ячейка показателя: точка-подсказка, значение и расшифровка «сколько из скольких». */
  _metricCell(title, tone, main, sub, hint) {
    return `<td data-label="${this.esc(title)}"${hint ? ` title="${this.esc(hint)}"` : ''}>
      <div class="an-cellv an-metric">
        <span class="an-metric__v">${this._dot(tone)}${main}</span>
        ${sub ? `<span class="an-sub">${sub}</span>` : ''}
      </div>
    </td>`;
  },

  _qualityRow(s, i, d) {
    const esc = x => this.esc(x);
    const t = s.tones || {};
    const open = this.quality.open === s.key;
    const verdict = s.verdict ? this.VERDICT[s.verdict] : { cls: 'badge-new', text: 'Мало накладных' };
    const noTrack = s.tracked_invoices === 0;
    const noTrackHint = 'Правки по этим накладным ещё не записывались';
    const editedTotal = s.edited_lines + s.deleted_lines;
    const cells = [
      noTrack
        ? this._metricCell('Правили строки', null, '—', 'нет данных', noTrackHint)
        : this._metricCell('Правили строки', t.edited, this.share(s.edited_share),
          `${editedTotal} из ${s.tracked_lines + s.deleted_lines} стр.`),
      noTrack
        ? this._metricCell('Пересчёт под вопросом', null, '—', 'нет данных', noTrackHint)
        : this._metricCell('Пересчёт под вопросом', t.flagged, this.share(s.flagged_share), `${s.flagged_lines} стр.`),
      this._metricCell('Сумма не сходится', t.mismatch, String(s.mismatch_invoices), `из ${s.invoices}`),
      this._metricCell('Строки сдвинуты', t.misaligned, String(s.misaligned_invoices), `из ${s.invoices}`),
      this._metricCell('Без позиции 1С', t.mapping, this.share(s.mapping_issue_share),
        `${s.unmapped_lines + s.low_conf_lines} из ${s.lines} стр.`),
      noTrack
        ? this._metricCell('Правили шапку', null, '—', 'нет данных', noTrackHint)
        : this._metricCell('Правили шапку', t.header, this.share(s.header_edit_share), `${s.header_edited_invoices} из ${s.tracked_invoices}`),
      this._metricCell('В 1С', t.sent, this.share(s.sent_share),
        s.median_days_to_1c != null ? `за ${this.days(s.median_days_to_1c)}` : 'ещё не отправляли'),
    ].join('');
    return `<tr class="an-qrow${open ? ' is-open' : ''}">
      <td class="an-cell-name" data-label="Поставщик">
        <div class="an-cellv">
          <button type="button" class="an-link an-sname" data-action="toggle-supplier" data-i="${i}" aria-expanded="${open ? 'true' : 'false'}">${esc(s.name)}</button>
          <div class="an-sub">${s.inn ? `ИНН ${esc(s.inn)} · ` : ''}${s.invoices} ${this.plural(s.invoices, 'накладная', 'накладные', 'накладных')} · ${this.rub(s.total_sum)}</div>
          <span class="badge ${verdict.cls} an-verdict">${verdict.text}</span>
        </div>
      </td>
      ${cells}
      <td class="cell-action an-cell-toggle">
        <button type="button" class="btn btn-outline btn-sm" data-action="toggle-supplier" data-i="${i}" aria-expanded="${open ? 'true' : 'false'}">${open ? 'Свернуть' : 'Подробнее'}</button>
      </td>
    </tr>${open ? `<tr class="an-detail-row"><td colspan="${this.QUALITY_METRICS.length + 2}">${this._qualityDetail(s, i, d)}</td></tr>` : ''}`;
  },

  _qualityDetail(s, i, d) {
    const esc = x => this.esc(x);
    const inv = n => `${n} ${this.plural(n, 'накладной', 'накладных', 'накладных')}`;
    const facts = [];
    facts.push(`Накладных за период — ${s.invoices} на ${this.rub(s.total_sum)}: первая загружена ${esc(this.date(s.first_invoice_at))}, последняя — ${esc(this.date(s.last_invoice_at))}.`);
    if (s.tracked_invoices > 0) {
      const scope = s.tracked_invoices < s.invoices ? ` (по ${inv(s.tracked_invoices)}, загруженным после начала журнала правок)` : '';
      const editedTotal = s.edited_lines + s.deleted_lines;
      facts.push(editedTotal
        ? `Руками правили ${editedTotal} из ${s.tracked_lines + s.deleted_lines} строк${s.deleted_lines ? `, из них удалили лишних — ${s.deleted_lines}` : ''}${scope}.`
        : `Строки руками не правили${scope}.`);
      facts.push(s.flagged_lines
        ? `Пересчёт единиц под вопросом — в ${s.flagged_lines} ${this.plural(s.flagged_lines, 'строке', 'строках', 'строках')}.`
        : 'Сомнительных пересчётов единиц не было.');
      facts.push(s.header_edited_invoices
        ? `Шапку (номер, дату, реквизиты, сумму) исправляли в ${s.header_edited_invoices} из ${s.tracked_invoices}.`
        : 'Шапку не исправляли.');
      if (s.clean_streak != null) {
        if (s.clean_streak === 0) facts.push('Самую свежую накладную пришлось править.');
        else if (s.clean_streak === 1) facts.push('Самая свежая накладная — без единой правки, предыдущую правили.');
        else if (s.clean_streak >= s.tracked_invoices) facts.push(`Все ${s.clean_streak} ${this.plural(s.clean_streak, 'накладная', 'накладные', 'накладных')} с начала журнала правок — без единой правки.`);
        else facts.push(`Последние ${s.clean_streak} ${this.plural(s.clean_streak, 'накладная', 'накладные', 'накладных')} подряд — без единой правки.`);
      }
    } else {
      facts.push('Правки по накладным этого поставщика ещё не записывались — видны только сумма, сдвиг строк, сопоставление и отправка в 1С.');
    }
    facts.push(s.mismatch_invoices
      ? `Сумма строк не сошлась с итогом — в ${inv(s.mismatch_invoices)} из ${s.invoices}.`
      : 'Суммы строк везде сходятся с итогом.');
    if (s.misaligned_invoices) facts.push(`Строки, похоже, сдвинуты — в ${inv(s.misaligned_invoices)}: сверьте их с фото.`);
    const mapIssues = s.unmapped_lines + s.low_conf_lines;
    facts.push(mapIssues
      ? `Без позиции 1С — ${s.unmapped_lines} из ${s.lines} ${this.plural(s.lines, 'строки', 'строк', 'строк')}${s.low_conf_lines ? `, ещё ${s.low_conf_lines} — с неуверенным подбором` : ''}.`
      : 'Все строки сопоставлены с позициями 1С.');
    facts.push(s.sent_invoices
      ? `В 1С ушло ${s.sent_invoices} из ${s.invoices}${s.median_days_to_1c != null ? `, обычно через ${this.days(s.median_days_to_1c)} после загрузки` : ''}.`
      : 'В 1С пока не отправляли.');

    const recent = (s.recent_invoices || []).map(r => `<li class="an-inv">
        <a href="#/invoices/${Number(r.id)}" class="an-inv__link">${r.invoice_number ? `№ ${esc(r.invoice_number)}` : `Накладная #${Number(r.id)}`}</a>
        <span class="an-inv__date">${esc(this.date(r.invoice_date || r.created_at))}</span>
        <span class="an-inv__sum">${r.total_sum != null ? `${this.money(r.total_sum)} ₽` : ''}</span>
        <span class="an-chips">${this._invoiceChips(r)}</span>
      </li>`).join('');
    const more = s.invoices > (s.recent_invoices || []).length;
    return `<div class="an-sdetail">
      <ul class="an-facts">${facts.map(f => `<li>${f}</li>`).join('')}</ul>
      ${recent ? `<h4 class="an-h">${more ? 'Последние накладные' : 'Накладные за период'}</h4><ul class="an-invlist">${recent}</ul>` : ''}
      ${s.search ? `<button type="button" class="btn btn-soft btn-sm" data-action="supplier-invoices" data-i="${i}">Все накладные поставщика в списке</button>` : ''}
    </div>`;
  },

  _invoiceChips(r) {
    const chip = (text, cls) => `<span class="an-chip${cls ? ` an-chip--${cls}` : ''}">${text}</span>`;
    const out = [];
    if (r.clean === true) out.push(chip('без правок', 'good'));
    if (r.clean === null) out.push(chip('правки не записывались'));
    if (r.edited_lines) out.push(chip(`правили ${r.edited_lines} стр.`, 'warn'));
    if (r.deleted_lines) out.push(chip(`удалили ${r.deleted_lines} стр.`, 'warn'));
    if (r.header_edits) out.push(chip('правили шапку', 'warn'));
    if (r.flagged_lines) out.push(chip(`пересчёт под вопросом: ${r.flagged_lines}`, 'warn'));
    if (r.mismatch) out.push(chip('сумма не сходится', 'bad'));
    if (r.misaligned) out.push(chip('строки сдвинуты?', 'bad'));
    if (r.sent_at) out.push(chip('в 1С'));
    return out.join('');
  },

  toggleSupplier(i) {
    const s = this.quality.data && this.quality.data.suppliers[i];
    if (!s) return;
    this.quality.open = this.quality.open === s.key ? null : s.key;
    this._renderQualityTable();
  },

  /** Список накладных, отфильтрованный по ИНН (или названию) поставщика. */
  openSupplierInvoices(i) {
    const s = this.quality.data && this.quality.data.suppliers[i];
    if (!s || !s.search) return;
    if (window.Invoices) {
      Invoices.search = s.search;
      Invoices.offset = 0;
      const input = document.getElementById('invoices-search');
      if (input) input.value = s.search;
    }
    App.navigate('#/invoices');
  },

  _bindQuality() {
    if (this._bound.quality) return;
    const view = document.getElementById('view-analytics-quality');
    if (!view) return;
    this._bound.quality = true;
    view.addEventListener('click', (e) => {
      const el = e.target.closest('[data-action]');
      if (!el || !view.contains(el)) return;
      switch (el.dataset.action) {
        case 'period': this.setPeriod(Number(el.dataset.days)); break;
        case 'toggle-supplier': this.toggleSupplier(Number(el.dataset.i)); break;
        case 'supplier-invoices': this.openSupplierInvoices(Number(el.dataset.i)); break;
        case 'reload-quality': this.loadQuality(); break;
        default: break;
      }
    });
    view.addEventListener('input', (e) => {
      if (e.target.id === 'an-quality-search') { this.quality.filter = e.target.value; this._renderQualityTable(); }
    });
    view.addEventListener('change', (e) => {
      if (e.target.id === 'an-quality-sort') { this.quality.sort = e.target.value; this._renderQualityTable(); }
    });
  },

  // ─── Закупочные цены ───────────────────────────────────────────────────────

  _guidFromHash(hash) {
    const m = /^#\/analytics\/prices\/(.+)$/.exec(hash || '');
    if (!m) return null;
    try { return decodeURIComponent(m[1]) || null; } catch { return null; }
  },

  async loadPrices(hash) {
    this._restorePeriod();
    this._bindPrices();
    this._renderPeriods();
    const search = document.getElementById('an-prices-search');
    if (search && document.activeElement !== search) search.value = this.prices.q;
    const guid = this._guidFromHash(hash || window.location.hash);
    this.prices.guid = guid;
    if (guid) await this._loadDetail(guid);
    else await this._loadOverview();
  },

  _fresh(at) { return Date.now() - at < this.CACHE_MS; },

  async _loadOverview(force = false) {
    const body = document.getElementById('an-prices-body');
    if (!body) return;
    const key = `${this.period}|${this.prices.q}`;
    if (!force && this.prices.overview && this.prices.overviewKey === key && this._fresh(this.prices.overviewAt)) {
      this.renderOverview();
      return;
    }
    if (body.dataset.view === 'overview' && body.children.length) body.classList.add('an-is-loading');
    else body.innerHTML = this._loading();
    const seq = ++this.prices.seq;
    const qs = new URLSearchParams({ days: String(this.period) });
    if (this.prices.q) qs.set('q', this.prices.q);
    let data;
    try {
      ({ data } = await App.apiJson(`/analytics/prices?${qs}`));
    } catch (e) {
      if (seq !== this.prices.seq) return;
      body.classList.remove('an-is-loading');
      body.dataset.view = 'error';
      body.innerHTML = this._error(e.message, 'reload-prices');
      return;
    }
    if (seq !== this.prices.seq) return;
    body.classList.remove('an-is-loading');
    this.prices.overview = data;
    this.prices.overviewKey = key;
    this.prices.overviewAt = Date.now();
    this.renderOverview();
  },

  renderOverview() {
    const o = this.prices.overview;
    const body = document.getElementById('an-prices-body');
    if (!o || !body) return;
    body.dataset.view = 'overview';
    if (!o.items.length) {
      body.innerHTML = o.q
        ? this._empty(`<div>По запросу «${this.esc(o.q)}» закупок за ${this.esc(this._periodText())} нет.</div>
            <div class="an-sub">Поиск — по названию позиции в справочнике 1С.</div>`)
        : this._empty(`<div class="empty-icon" aria-hidden="true">🏷️</div>
            <div>За ${this.esc(this._periodText())} нет закупок с позицией 1С.</div>
            <div class="an-sub">Цены появятся, когда строки распознанных накладных будут сопоставлены с номенклатурой 1С — например, на странице <a href="#/new-items">«Новые товары»</a>.</div>`);
      return;
    }
    const notes = [];
    if (o.truncated) notes.push('За период слишком много строк — самые старые закупки не вошли. Выберите период короче.');
    if (o.items_truncated) notes.push(`Показаны ${o.items.length} позиций с наибольшей суммой закупок из ${o.totals.items} — остальные найдутся поиском.`);
    const view = this.prices.view;
    body.innerHTML = `
      <div class="an-kpis">${this._pricesKpis(o)}</div>
      ${notes.length ? `<div class="an-note" role="note">${notes.map(n => `<p>${this.esc(n)}</p>`).join('')}</div>` : ''}
      <div class="tabs an-tabs" role="tablist" aria-label="Что показать">
        <button type="button" class="tab-btn${view === 'items' ? ' active' : ''}" role="tab" aria-selected="${view === 'items'}" data-action="prices-view" data-view="items">Позиции <span class="an-count">${o.totals.items}</span></button>
        <button type="button" class="tab-btn${view === 'rises' ? ' active' : ''}" role="tab" aria-selected="${view === 'rises'}" data-action="prices-view" data-view="rises">Подорожания <span class="an-count">${o.totals.rises}</span></button>
      </div>
      <div class="an-tabpanel" role="tabpanel">${view === 'rises' ? this._risesTable(o) : this._itemsTable(o)}</div>`;
  },

  _pricesKpis(o) {
    const t = o.totals;
    const tile = (value, label, sub) => `<div class="an-kpi">
        <div class="an-kpi__value">${value}</div>
        <div class="an-kpi__label">${label}</div>
        ${sub ? `<div class="an-kpi__sub">${sub}</div>` : ''}
      </div>`;
    return [
      tile(String(t.items), `${this.plural(t.items, 'позиция', 'позиции', 'позиций')} с закупками`,
        `${t.purchases} ${this.plural(t.purchases, 'закупка', 'закупки', 'закупок')}`),
      tile(this.rub(t.spend), 'закуплено', `за ${this.esc(this._periodText())}`),
      tile(String(t.rising_items), `${this.plural(t.rising_items, 'позиция подорожала', 'позиции подорожали', 'позиций подорожали')}`,
        `у поставщика на ${Number(o.rise_threshold_pct) || 5}% и больше`),
      tile(this.rub(t.saving_rub), 'можно было сэкономить',
        `за ${Number(o.recent_days) || 30} дней, если брать у самого дешёвого`),
    ].join('');
  },

  _unitNote(it) {
    const unit = this.esc(it.unit);
    if (it.in_catalog_unit || !it.catalog_unit) return `за ${unit}`;
    return `за ${unit} — как в накладных; в 1С позиция в «${this.esc(it.catalog_unit)}»`;
  },

  _itemsTable(o) {
    const rows = o.items.map((it) => {
      const href = `#/analytics/prices/${encodeURIComponent(it.guid)}`;
      const cheapest = it.cheapest
        ? `<div class="an-cellv"><span>${this.esc(it.cheapest.name)}</span><span class="an-sub">${this.money(it.cheapest.recent_median)} ₽</span></div>`
        : `<span class="an-muted">${it.suppliers === 1 ? 'один поставщик' : '—'}</span>`;
      return `<tr class="clickable an-item-row" data-action="open-item" data-href="${this.esc(href)}">
        <td class="an-cell-name" data-label="Позиция">
          <div class="an-cellv">
            <a class="an-link" href="${this.esc(href)}">${this.esc(it.name)}</a>
            <span class="an-sub">${this._unitNote(it)}</span>
          </div>
        </td>
        <td data-label="Последняя цена">
          <div class="an-cellv">
            <strong class="an-price">${this.money(it.last_price)} ₽</strong>
            <span class="an-sub">${this.esc(this.date(it.last_date))} · ${this.esc(it.last_supplier)}</span>
          </div>
        </td>
        <td data-label="За период">${this.delta(it.period_change_pct)}</td>
        <td data-label="У кого дешевле">${cheapest}</td>
        <td data-label="Закупок" class="an-num">${Number(it.purchases)}</td>
        <td data-label="Сумма" class="an-num">${this.rub(it.spend)}</td>
        <td data-label="Динамика" class="an-spark-cell">${this.sparkline(it.spark)}</td>
      </tr>`;
    }).join('');
    return `<div class="table-wrap an-table-wrap">
      <table class="cards-mobile an-table an-ptable">
        <thead><tr>
          <th scope="col">Позиция 1С</th>
          <th scope="col">Последняя цена</th>
          <th scope="col" title="Медиана последних закупок против медианы первых за период, по всем поставщикам">За период</th>
          <th scope="col" title="По медиане последних закупок у каждого поставщика, в одной единице">У кого дешевле</th>
          <th scope="col">Закупок</th>
          <th scope="col">Сумма</th>
          <th scope="col"><span class="sr-only">Динамика цены</span></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="field-hint an-foot">Цена — за единицу позиции 1С после пересчёта единиц. Строки с пересчётом под вопросом, в другой единице и явные ошибки цены (в 5 раз дальше обычной) не учитываются.</p>`;
  },

  _invoiceLink(id, number, dateStr) {
    const label = `${this.esc(this.date(dateStr))}${number ? `, № ${this.esc(number)}` : ''}`;
    return `<a href="#/invoices/${Number(id)}" title="Открыть накладную">${label}</a>`;
  },

  _risesTable(o) {
    if (!o.rises.length) {
      return this._empty(`<div>За ${this.esc(this._periodText())} ни у одного поставщика цена не выросла на ${Number(o.rise_threshold_pct) || 5}% и больше.</div>
        <div class="an-sub">Сравнивается первая закупка периода с последней у того же поставщика.</div>`);
    }
    const byPct = this.prices.risesSort === 'pct';
    const rises = o.rises.slice().sort(byPct
      ? (a, b) => b.change_pct - a.change_pct || (b.extra_rub ?? -Infinity) - (a.extra_rub ?? -Infinity)
      : (a, b) => (b.extra_rub ?? -Infinity) - (a.extra_rub ?? -Infinity) || b.change_pct - a.change_pct);
    const rows = rises.map((r) => {
      const href = `#/analytics/prices/${encodeURIComponent(r.guid)}`;
      return `<tr>
        <td class="an-cell-name" data-label="Позиция">
          <div class="an-cellv"><a class="an-link" href="${this.esc(href)}">${this.esc(r.name)}</a><span class="an-sub">за ${this.esc(r.unit)} · ${this.esc(r.supplier)}</span></div>
        </td>
        <td data-label="Было"><div class="an-cellv"><span class="an-price">${this.money(r.from_price)} ₽</span><span class="an-sub">${this._invoiceLink(r.from_invoice_id, r.from_invoice_number, r.from_date)}</span></div></td>
        <td data-label="Стало"><div class="an-cellv"><strong class="an-price">${this.money(r.to_price)} ₽</strong><span class="an-sub">${this._invoiceLink(r.to_invoice_id, r.to_invoice_number, r.to_date)}</span></div></td>
        <td data-label="Рост">${this.delta(r.change_pct)}</td>
        <td data-label="Переплата" class="an-num"${r.extra_rub == null ? ' title="Количество в накладных не распознано"' : ''}>${r.extra_rub == null ? '<span class="an-muted">—</span>' : `${r.extra_rub > 0 ? '+' : ''}${this.rub(r.extra_rub)}`}</td>
      </tr>`;
    }).join('');
    return `<div class="an-subtools" role="group" aria-label="Порядок">
        <span class="an-sub">Сначала:</span>
        <button type="button" class="an-period__btn${byPct ? '' : ' is-active'}" data-action="rises-sort" data-sort="rub" aria-pressed="${!byPct}">больше переплата</button>
        <button type="button" class="an-period__btn${byPct ? ' is-active' : ''}" data-action="rises-sort" data-sort="pct" aria-pressed="${byPct}">больше рост</button>
      </div>
      <div class="table-wrap an-table-wrap">
        <table class="cards-mobile an-table an-rtable">
          <thead><tr>
            <th scope="col">Позиция и поставщик</th>
            <th scope="col">Было</th>
            <th scope="col">Стало</th>
            <th scope="col">Рост</th>
            <th scope="col" title="Сколько заплатили сверх цены первой закупки по всем следующим закупкам периода">Переплата</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${o.rises_truncated ? '<p class="field-hint">Показаны первые 300 подорожаний.</p>' : ''}
      <p class="field-hint an-foot">Подорожание — последняя закупка периода у поставщика дороже первой на ${Number(o.rise_threshold_pct) || 5}% и больше. Переплата — сколько заплатили сверх цены первой закупки по всем следующим. Дата и номер ведут в накладную.</p>`;
  },

  async _loadDetail(guid) {
    const body = document.getElementById('an-prices-body');
    if (!body) return;
    const key = `${guid}|${this.period}`;
    if (this.prices.detail && this.prices.detailKey === key && this._fresh(this.prices.detailAt)) {
      this.renderDetail();
      return;
    }
    const sameItem = body.dataset.view === 'detail' && this.prices.detail && this.prices.detail.item.guid === guid;
    if (sameItem) body.classList.add('an-is-loading');
    else body.innerHTML = this._loading();
    const seq = ++this.prices.seq;
    let data;
    try {
      ({ data } = await App.apiJson(`/analytics/prices/${encodeURIComponent(guid)}?days=${this.period}`));
    } catch (e) {
      if (seq !== this.prices.seq) return;
      body.classList.remove('an-is-loading');
      body.dataset.view = 'error';
      body.innerHTML = `<a href="#/analytics/prices" class="back-link">← Все позиции</a>${e.status === 404
        ? this._empty(`<div>За ${this.esc(this._periodText())} закупок этой позиции нет.</div><div class="an-sub">Выберите период длиннее или другую позицию.</div>`)
        : this._error(e.message, 'reload-prices')}`;
      return;
    }
    if (seq !== this.prices.seq) return;
    body.classList.remove('an-is-loading');
    this.prices.detail = data;
    this.prices.detailKey = key;
    this.prices.detailAt = Date.now();
    this.renderDetail();
  },

  renderDetail() {
    const d = this.prices.detail;
    const body = document.getElementById('an-prices-body');
    if (!d || !body) return;
    body.dataset.view = 'detail';
    const it = d.item;
    const esc = x => this.esc(x);
    const unit = esc(it.unit);
    const tile = (value, label, sub, extraCls) => `<div class="an-kpi${extraCls ? ` ${extraCls}` : ''}">
        <div class="an-kpi__value">${value}</div>
        <div class="an-kpi__label">${label}</div>
        ${sub ? `<div class="an-kpi__sub">${sub}</div>` : ''}
      </div>`;
    const ref = it.reference;
    const cheapest = it.cheapest;
    const saving = it.saving;
    const excluded = [];
    if (it.excluded && it.excluded.other_unit) excluded.push(`${it.excluded.other_unit} ${this.plural(it.excluded.other_unit, 'строка', 'строки', 'строк')} в другой единице`);
    if (it.excluded && it.excluded.outliers) excluded.push(`${it.excluded.outliers} ${this.plural(it.excluded.outliers, 'явная ошибка', 'явные ошибки', 'явных ошибок')} цены`);
    const tiles = [
      tile(`${this.money(it.last_price)} ₽`, 'последняя цена',
        `${esc(this.date(it.last_date))} · ${esc(it.last_supplier)} · <a href="#/invoices/${Number(it.last_invoice_id)}">накладная</a>`),
      tile(this.delta(it.period_change_pct), 'за период',
        `от ${this.money(it.min_price)} до ${this.money(it.max_price)} ₽`),
      tile(ref ? `${this.money(ref.median_price)} ₽` : '—', 'обычная цена',
        ref ? `последняя ${this.delta(it.last_vs_reference_pct)} к обычной` : 'мало закупок, чтобы её посчитать'),
      tile(cheapest ? esc(cheapest.name) : (it.suppliers === 1 ? 'Один поставщик' : '—'), 'у кого дешевле',
        cheapest
          ? `${this.money(cheapest.recent_median)} ₽ за ${unit}${saving ? ` · переплата за ${Number(saving.window_days)} дн.: ${this.rub(saving.rub)} (${Number(saving.pct).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%)` : ''}`
          : 'сравнивать не с кем', 'an-kpi--text'),
    ].join('');
    const series = this._chartSeries(d);
    const legend = series.length > 1
      ? `<ul class="an-legend">${series.map(s => `<li><span class="an-key" style="--an-c: ${s.color}" aria-hidden="true"></span>${esc(s.name)}</li>`).join('')}${ref ? '<li><span class="an-key an-key--ref" aria-hidden="true"></span>обычная цена</li>' : ''}</ul>`
      : (ref ? '<ul class="an-legend"><li><span class="an-key an-key--ref" aria-hidden="true"></span>обычная цена</li></ul>' : '');
    body.innerHTML = `
      <a href="#/analytics/prices" class="back-link">← Все позиции</a>
      <div class="an-detail-head">
        <h3 class="an-detail-title">${esc(it.name)}</h3>
        <p class="an-sub">Цена ${this._unitNote(it)}. ${it.purchases} ${this.plural(it.purchases, 'закупка', 'закупки', 'закупок')} за ${esc(this._periodText())} у ${it.suppliers} ${this.plural(it.suppliers, 'поставщика', 'поставщиков', 'поставщиков')}${excluded.length ? `; не учтены: ${excluded.join(', ')}` : ''}.</p>
      </div>
      <div class="an-kpis">${tiles}</div>
      <div class="card an-chart-card">
        <div class="an-chart-head">
          <h4 class="an-h">Цена за ${unit} по закупкам</h4>
          ${legend}
        </div>
        <div class="an-chart" id="an-price-chart" role="group" aria-label="${esc(`График цены «${it.name}» за ${it.unit}: каждая точка — закупка`)}"></div>
        <p class="an-caption">Точка — закупка по накладной; нажмите на неё, чтобы открыть накладную.${ref ? ' Пунктир — обычная цена позиции (медиана последних закупок).' : ''}${d.points_truncated ? ` Показаны последние ${d.points.length} закупок.` : ''}</p>
      </div>
      <h4 class="an-h">Поставщики</h4>
      <p class="field-hint an-lead">«У кого дешевле» — по медиане последних ${Number(d.recent_purchases) || 5} закупок у каждого поставщика, только в «${unit}».${saving ? ` Если бы последние ${Number(saving.window_days)} дней всё брали у ${esc(cheapest.name)}, вышло бы на ${this.rub(saving.rub)} дешевле.` : ''}</p>
      ${this._suppliersTable(d)}
      ${this._pointsTable(d)}`;
    this._drawChart(document.getElementById('an-price-chart'), d);
  },

  _suppliersTable(d) {
    const esc = x => this.esc(x);
    const it = d.item;
    const rows = d.suppliers.map(s => `<tr${s.is_cheapest ? ' class="an-cheapest"' : ''}>
        <td class="an-cell-name" data-label="Поставщик">
          <div class="an-cellv">
            <span>${esc(s.name)}</span>
            ${s.is_cheapest ? '<span class="badge badge-sent an-verdict"><span aria-hidden="true">✓</span> дешевле всех</span>' : ''}
          </div>
        </td>
        <td data-label="Последняя цена"><div class="an-cellv"><strong class="an-price">${this.money(s.last_price)} ₽</strong><span class="an-sub">${this._invoiceLink(s.last_invoice_id, null, s.last_date)}</span></div></td>
        <td data-label="Медиана последних" class="an-num">${this.money(s.recent_median)} ₽</td>
        <td data-label="За период">${this.delta(s.period_change_pct)}</td>
        <td data-label="Закупок" class="an-num">${Number(s.purchases)}</td>
        <td data-label="Объём" class="an-num">${s.qty ? `${App.formatQty(s.qty)} ${esc(it.unit)}` : '—'}</td>
        <td data-label="Сумма" class="an-num">${this.rub(s.spend)}</td>
      </tr>`).join('');
    return `<div class="table-wrap an-table-wrap">
      <table class="cards-mobile an-table an-stable">
        <thead><tr>
          <th scope="col">Поставщик</th>
          <th scope="col">Последняя цена</th>
          <th scope="col" title="Медиана последних ${Number(d.recent_purchases) || 5} закупок — по ней выбирается, у кого дешевле">Медиана последних ${Number(d.recent_purchases) || 5}</th>
          <th scope="col" title="Последняя закупка против первой за период у этого поставщика">За период</th>
          <th scope="col">Закупок</th>
          <th scope="col">Объём</th>
          <th scope="col">Сумма</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  },

  _pointsTable(d) {
    const esc = x => this.esc(x);
    const it = d.item;
    const names = new Map(d.suppliers.map(s => [s.key, s.name]));
    const pts = d.points.slice().reverse();
    const rows = pts.map(p => `<tr>
        <td data-label="Дата">${esc(this.date(p.date))}</td>
        <td data-label="Поставщик" class="an-cell-wrap">${esc(names.get(p.supplier_key) || '—')}</td>
        <td data-label="Цена" class="an-num"><strong>${this.money(p.price)} ₽</strong></td>
        <td data-label="Количество" class="an-num">${p.qty != null ? `${App.formatQty(p.qty)} ${esc(it.unit)}` : '—'}</td>
        <td data-label="Сумма" class="an-num">${p.total != null ? `${this.money(p.total)} ₽` : '—'}</td>
        <td data-label="Накладная"><a href="#/invoices/${Number(p.invoice_id)}">${p.invoice_number ? `№ ${esc(p.invoice_number)}` : 'открыть'}</a></td>
      </tr>`).join('');
    return `<details class="an-points"${pts.length <= 12 ? ' open' : ''}>
      <summary>Все закупки (${pts.length}) — таблицей</summary>
      <div class="table-wrap an-table-wrap">
        <table class="cards-mobile an-table">
          <thead><tr>
            <th scope="col">Дата</th><th scope="col">Поставщик</th><th scope="col">Цена за ${esc(it.unit)}</th>
            <th scope="col">Количество</th><th scope="col">Сумма</th><th scope="col">Накладная</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </details>`;
  },

  // ─── График ────────────────────────────────────────────────────────────────

  // Цвет — за поставщиком (порядок — по числу закупок): первые три — свои
  // цвета (проверены на различимость, в т.ч. при дальтонизме), остальные — серые.
  SERIES_COLORS: ['var(--an-s1)', 'var(--an-s2)', 'var(--an-s3)'],

  _chartSeries(d) {
    const used = new Set(d.points.map(p => p.supplier_key));
    const list = d.suppliers.filter(s => used.has(s.key));
    const series = list.slice(0, this.SERIES_COLORS.length).map((s, i) => ({ keys: [s.key], name: s.name, color: this.SERIES_COLORS[i] }));
    const rest = list.slice(this.SERIES_COLORS.length);
    if (rest.length) {
      series.push({ keys: rest.map(s => s.key), name: `другие (${rest.length})`, color: 'var(--an-other)', other: true });
    }
    return series;
  },

  /** «Круглые» деления шкалы: первое — не больше min, последнее — не меньше max. */
  niceTicks(min, max, count = 4) {
    let lo = min;
    let hi = max;
    if (!(hi > lo)) {
      const pad = Math.abs(lo) * 0.1 || 1;
      lo -= pad;
      hi += pad;
    }
    const raw = (hi - lo) / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const norm = raw / mag;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
    const first = Math.max(0, Math.floor(lo / step));
    const ticks = [];
    for (let k = first; ticks.length < 20; k++) {
      const v = Number((k * step).toPrecision(12)); // без хвостов вида 0.30000000000000004
      ticks.push(v);
      if (v >= hi) break;
    }
    return ticks;
  },

  _tickLabel(v, step) {
    return v.toLocaleString('ru-RU', { maximumFractionDigits: step < 1 ? 2 : 0 });
  },

  _drawChart(host, d) {
    if (!host) return;
    const pts = d.points;
    if (!pts.length) { host.innerHTML = ''; return; }
    const unit = d.item.unit;
    const ref = d.item.reference ? Number(d.item.reference.median_price) : null;
    const series = this._chartSeries(d);
    const colorOf = new Map();
    series.forEach(s => s.keys.forEach(k => colorOf.set(k, s.color)));
    const nameOf = new Map(d.suppliers.map(s => [s.key, s.name]));

    const width = Math.max(260, Math.floor(host.clientWidth || 640));
    const narrow = width < 480;
    const height = narrow ? 220 : 260;
    const m = { top: 14, right: 14, bottom: 28, left: narrow ? 50 : 62 };
    const pw = width - m.left - m.right;
    const ph = height - m.top - m.bottom;
    const DAY = 86400000;
    const times = pts.map(p => Date.parse(`${p.date}T00:00:00Z`));
    let t0 = Math.min(...times);
    let t1 = Math.max(...times);
    if (t1 - t0 < DAY) { t0 -= 3 * DAY; t1 += 3 * DAY; }
    const values = pts.map(p => p.price);
    if (ref) values.push(ref);
    const ticks = this.niceTicks(Math.min(...values), Math.max(...values), narrow ? 3 : 4);
    const step = ticks.length > 1 ? ticks[1] - ticks[0] : 1;
    const v0 = ticks[0];
    const v1 = ticks[ticks.length - 1];
    const x = t => m.left + ((t - t0) / (t1 - t0)) * pw;
    const y = v => m.top + (1 - (v - v0) / (v1 - v0 || 1)) * ph;
    const f = n => n.toFixed(1);

    const grid = ticks.map(v => `<line class="an-grid" x1="${m.left}" x2="${width - m.right}" y1="${f(y(v))}" y2="${f(y(v))}"/>
      <text class="an-axis" x="${m.left - 8}" y="${f(y(v) + 4)}" text-anchor="end">${this._tickLabel(v, step)}</text>`).join('');

    const nX = narrow ? 3 : 5;
    const sameYear = new Date(t0).getUTCFullYear() === new Date(t1).getUTCFullYear();
    const xLabel = (t) => {
      const dt = new Date(t);
      const dd = String(dt.getUTCDate()).padStart(2, '0');
      const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
      return sameYear ? `${dd}.${mm}` : `${dd}.${mm}.${String(dt.getUTCFullYear()).slice(2)}`;
    };
    const xTicks = [];
    for (let i = 0; i < nX; i++) xTicks.push(t0 + ((t1 - t0) * i) / (nX - 1));
    const xAxis = xTicks.map((t, i) => `<text class="an-axis" x="${f(x(t))}" y="${height - 8}" text-anchor="${i === 0 ? 'start' : i === nX - 1 ? 'end' : 'middle'}">${xLabel(t)}</text>`).join('');
    const baseline = `<line class="an-baseline" x1="${m.left}" x2="${width - m.right}" y1="${height - m.bottom}" y2="${height - m.bottom}"/>`;

    const refLine = ref
      ? `<line class="an-ref" x1="${m.left}" x2="${width - m.right}" y1="${f(y(ref))}" y2="${f(y(ref))}"/>
         <text class="an-axis an-axis--ref" x="${width - m.right}" y="${f(y(ref) - 5)}" text-anchor="end">обычная ${this._tickLabel(ref, 0.5)}</text>`
      : '';

    // Линии — по поставщику (у «других» — по каждому отдельно, одним цветом).
    const bySupplier = new Map();
    pts.forEach((p, i) => {
      const list = bySupplier.get(p.supplier_key) || [];
      list.push({ p, i });
      bySupplier.set(p.supplier_key, list);
    });
    const lines = [];
    for (const [key, list] of bySupplier) {
      if (list.length < 2) continue;
      const color = colorOf.get(key) || 'var(--an-other)';
      lines.push(`<polyline class="an-line" style="stroke: ${color}" points="${list.map(({ p }) => `${f(x(Date.parse(`${p.date}T00:00:00Z`)))},${f(y(p.price))}`).join(' ')}"/>`);
    }

    const dots = pts.map((p, i) => {
      const cx = f(x(times[i]));
      const cy = f(y(p.price));
      const color = colorOf.get(p.supplier_key) || 'var(--an-other)';
      const label = `${this.date(p.date)}, ${nameOf.get(p.supplier_key) || 'поставщик'}: ${this.money(p.price)} ₽ за ${unit}${p.invoice_number ? `, накладная № ${p.invoice_number}` : ''}`;
      return `<a class="an-pt" href="#/invoices/${Number(p.invoice_id)}" data-i="${i}" aria-label="${this.esc(label)}">
        <circle class="an-pt__hit" cx="${cx}" cy="${cy}" r="12"/>
        <circle class="an-pt__dot" cx="${cx}" cy="${cy}" r="4.5" style="fill: ${color}"/>
      </a>`;
    }).join('');

    host.innerHTML = `<svg class="an-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      ${grid}${baseline}${refLine}${lines.join('')}${dots}${xAxis}
    </svg><div class="an-tip" role="tooltip" hidden></div>`;

    const tip = host.querySelector('.an-tip');
    const show = (a) => {
      const i = Number(a.dataset.i);
      const p = pts[i];
      if (!p) return;
      tip.textContent = '';
      const v = document.createElement('div');
      v.className = 'an-tip__v';
      v.textContent = `${this.money(p.price)} ₽ за ${unit}`;
      const s = document.createElement('div');
      s.className = 'an-tip__s';
      const key = document.createElement('span');
      key.className = 'an-key';
      key.style.setProperty('--an-c', colorOf.get(p.supplier_key) || 'var(--an-other)');
      s.append(key, document.createTextNode(nameOf.get(p.supplier_key) || 'Поставщик не указан'));
      const meta = document.createElement('div');
      meta.className = 'an-tip__m';
      const bits = [this.date(p.date)];
      if (p.invoice_number) bits.push(`№ ${p.invoice_number}`);
      if (p.qty != null) bits.push(`${App.formatQty(p.qty)} ${unit}`);
      meta.textContent = bits.join(' · ');
      tip.append(v, s, meta);
      tip.hidden = false;
      const px = x(times[i]);
      const py = y(p.price);
      const tw = tip.offsetWidth;
      const th = tip.offsetHeight;
      const left = Math.min(Math.max(4, px - tw / 2), width - tw - 4);
      const top = py - th - 12 >= 0 ? py - th - 12 : py + 14;
      tip.style.left = `${left}px`;
      tip.style.top = `${top}px`;
      a.classList.add('is-active');
    };
    const hide = (a) => {
      tip.hidden = true;
      if (a) a.classList.remove('is-active');
    };
    host.addEventListener('mouseover', (e) => { const a = e.target.closest('.an-pt'); if (a) show(a); });
    host.addEventListener('mouseout', (e) => {
      const a = e.target.closest('.an-pt');
      if (a && !(e.relatedTarget && a.contains(e.relatedTarget))) hide(a);
    });
    host.addEventListener('focusin', (e) => { const a = e.target.closest('.an-pt'); if (a) show(a); });
    host.addEventListener('focusout', (e) => { const a = e.target.closest('.an-pt'); if (a) hide(a); });
  },

  /** Спарклайн последних цен: серая линия, последняя точка — акцентом. */
  sparkline(values) {
    const vals = (values || []).map(Number).filter(v => Number.isFinite(v));
    if (vals.length < 2) return '<span class="an-muted" aria-hidden="true">—</span>';
    const w = 88;
    const h = 26;
    const pad = 4;
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const yOf = v => (max === min ? h / 2 : pad + (1 - (v - min) / (max - min)) * (h - 2 * pad));
    const pts = vals.map((v, i) => [pad + (i / (vals.length - 1)) * (w - 2 * pad), yOf(v)]);
    const last = pts[pts.length - 1];
    return `<svg class="an-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true" focusable="false">
      <polyline points="${pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')}"/>
      <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3"/>
    </svg>`;
  },

  // ─── Обработчики страницы цен ──────────────────────────────────────────────

  _onPricesSearch(value) {
    clearTimeout(this.prices.searchTimer);
    this.prices.searchTimer = setTimeout(() => {
      const q = String(value || '').trim().slice(0, 100);
      if (q === this.prices.q) return;
      this.prices.q = q;
      if (this.prices.guid) App.navigate('#/analytics/prices');
      else this._loadOverview();
    }, 350);
  },

  _bindPrices() {
    if (this._bound.prices) return;
    const view = document.getElementById('view-analytics-prices');
    if (!view) return;
    this._bound.prices = true;
    view.addEventListener('click', (e) => {
      const el = e.target.closest('[data-action]');
      if (!el || !view.contains(el)) return;
      switch (el.dataset.action) {
        case 'period': this.setPeriod(Number(el.dataset.days)); break;
        case 'prices-view':
          this.prices.view = el.dataset.view === 'rises' ? 'rises' : 'items';
          this.renderOverview();
          break;
        case 'rises-sort':
          this.prices.risesSort = el.dataset.sort === 'pct' ? 'pct' : 'rub';
          this.renderOverview();
          break;
        case 'open-item':
          // Ссылки внутри строки (название, накладная) работают сами.
          if (e.target.closest('a')) return;
          if (el.dataset.href) App.navigate(el.dataset.href);
          break;
        case 'reload-prices':
          if (this.prices.guid) { this.prices.detailKey = ''; this._loadDetail(this.prices.guid); } else this._loadOverview(true);
          break;
        default: break;
      }
    });
    view.addEventListener('input', (e) => {
      if (e.target.id === 'an-prices-search') this._onPricesSearch(e.target.value);
    });
    window.addEventListener('resize', () => {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => {
        const host = document.getElementById('an-price-chart');
        if (host && this.prices.detail && view.style.display !== 'none') this._drawChart(host, this.prices.detail);
      }, 150);
    });
  },
};

window.Analytics = Analytics;
