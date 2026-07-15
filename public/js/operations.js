/* global App */
const Operations = {
  data: null,
  channels: null,
  onec: null,
  activeTab: 'control',
  loading: false,
  assistantMessages: [],
  onecSecret: null,
  selectedExceptions: new Set(),
  selectedApprovals: new Set(),

  money(value) {
    return App.formatMoney(Number(value || 0));
  },

  async load(force = false) {
    if (this.loading) return;
    if (this.data && !force) { this.render(); return; }
    this.loading = true;
    const content = document.getElementById('operations-content');
    if (content) content.innerHTML = '<div class="empty-state">Собираем операционные данные…</div>';
    try {
      const [overview, channels] = await Promise.all([
        App.apiJson('/operations/overview'),
        App.apiJson('/inbound/status'),
      ]);
      this.data = overview.data;
      this.channels = channels.data;
      if (this.data.permissions?.manage) {
        try { this.onec = (await App.apiJson('/onec/connections')).data; } catch { this.onec = null; }
      }
      this.renderKpis();
      this.render();
    } catch (error) {
      if (content) content.innerHTML = `<div class="empty-state empty-state--error">${App.esc(error.message)}</div>`;
    } finally {
      this.loading = false;
    }
  },

  switchTab(tab, button) {
    this.activeTab = tab;
    document.querySelectorAll('[data-operations-tab]').forEach(el => {
      const active = el.dataset.operationsTab === tab;
      el.classList.toggle('active', active);
      el.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    if (button) button.focus({ preventScroll: true });
    this.render();
  },

  renderKpis() {
    const el = document.getElementById('operations-kpis');
    if (!el || !this.data) return;
    const pending = this.data.approvals.filter(row => row.status === 'pending').length;
    const autopilot = [this.data.settings.auto_send_1c && '1С', this.data.settings.auto_send_sber && 'Сбер'].filter(Boolean).join(' + ');
    el.innerHTML = `
      <button type="button" class="operations-kpi operations-kpi--warning" onclick="Operations.switchTab('control')">
        <span>${this.data.exceptions.length}</span><small>исключений</small>
      </button>
      <button type="button" class="operations-kpi operations-kpi--violet" onclick="Operations.switchTab('control')">
        <span>${pending}</span><small>на согласовании</small>
      </button>
      <button type="button" class="operations-kpi operations-kpi--danger" onclick="Operations.switchTab('suppliers')">
        <span>${this.money(this.data.forecast.overdue)}</span><small>просрочено</small>
      </button>
      <button type="button" class="operations-kpi operations-kpi--success" onclick="Operations.switchTab('control')">
        <span>${autopilot || 'Выкл.'}</span><small>автопилот</small>
      </button>`;
  },

  render() {
    const el = document.getElementById('operations-content');
    if (!el || !this.data) return;
    if (this.activeTab === 'payments') el.innerHTML = this.renderPayments();
    else if (this.activeTab === 'suppliers') el.innerHTML = this.renderSuppliers();
    else if (this.activeTab === 'channels') el.innerHTML = this.renderChannels();
    else if (this.activeTab === 'reports') el.innerHTML = this.renderReports();
    else if (this.activeTab === 'onec') el.innerHTML = this.renderOnec();
    else if (this.activeTab === 'assistant') el.innerHTML = this.renderAssistant();
    else el.innerHTML = this.renderControl();
  },

  renderControl() {
    const s = this.data.settings;
    const exceptions = this.data.exceptions;
    const canManage = this.data.permissions?.manage === true;
    const canApprove = this.data.permissions?.approve === true;
    const approvals = this.data.approvals.filter(row => row.status === 'pending' || row.execution_error);
    return `
      <div class="operations-grid operations-grid--control">
        <article class="card operations-panel">
          <div class="operations-panel__head">
            <div><span class="operations-eyebrow">Автопилот 2.0</span><h3>Правила безопасной обработки</h3></div>
            <span class="status-badge ${s.auto_send_1c || s.auto_send_sber ? 'status-processed' : 'status-new'}">${s.auto_send_1c || s.auto_send_sber ? 'Активен' : 'Выключен'}</span>
          </div>
          <div class="operations-switches">
            ${this.toggle('ops-auto-1c', 'Автоматически передавать в 1С', s.auto_send_1c, !canManage)}
            ${this.toggle('ops-auto-sber', 'Создавать черновик в СберБизнес', s.auto_send_sber, !canManage)}
            ${this.toggle('ops-require-mapped', 'Требовать сопоставление всех товаров', s.require_all_mapped, !canManage)}
            ${this.toggle('ops-block-mismatch', 'Блокировать расхождение суммы', s.block_total_mismatch, !canManage)}
            ${this.toggle('ops-require-supplier', 'Требовать подтверждённого поставщика', s.require_verified_supplier, !canManage)}
          </div>
          <div class="operations-form-grid">
            <label>Минимальная точность, %<input id="ops-min-confidence" type="number" min="0" max="100" step="1" value="${Math.round(s.min_mapping_confidence * 100)}"${canManage ? '' : ' disabled'}></label>
            <label>Лимит автопилота, ₽<input id="ops-max-total" type="number" min="0" step="1000" value="${s.max_total || ''}" placeholder="Без лимита"${canManage ? '' : ' disabled'}></label>
            <label>Согласование платежа от, ₽<input id="ops-approval-threshold" type="number" min="0" step="1000" value="${s.payment_approval_threshold || ''}" placeholder="Не требуется"${canManage ? '' : ' disabled'}></label>
            <label>Доступно для платежей, ₽<input id="ops-cash-balance" type="number" min="0" step="1000" value="${s.payment_cash_balance ?? ''}" placeholder="Не задано"${canManage ? '' : ' disabled'}></label>
          </div>
          ${canManage ? '<button type="button" class="btn btn-primary btn-sm" onclick="Operations.saveAutopilot()">Сохранить правила</button>' : '<small class="muted">Изменять правила может администратор.</small>'}
        </article>

        <article class="card operations-panel">
          <div class="operations-panel__head"><div><span class="operations-eyebrow">Согласования</span><h3>Требуют внимания</h3></div><strong>${approvals.length}</strong></div>
          ${canApprove && approvals.some(row => row.status === 'pending') ? `<div class="operations-bulkbar operations-bulkbar--compact">
            <button class="btn btn-outline btn-sm" onclick="Operations.decideSelectedApprovals('rejected')">Отклонить выбранные</button>
            <button class="btn btn-primary btn-sm" onclick="Operations.decideSelectedApprovals('approved')">Одобрить выбранные</button>
          </div>` : ''}
          <div class="operations-stack">${approvals.length ? approvals.map(row => this.approvalCard(row)).join('') : this.empty('Нет запросов на согласование')}</div>
        </article>
      </div>

      <article class="card operations-panel operations-panel--wide">
        <div class="operations-panel__head"><div><span class="operations-eyebrow">Центр исключений</span><h3>Требуют внимания</h3></div><strong>${exceptions.length}</strong></div>
        ${exceptions.length ? `<div class="operations-bulkbar">
          <label><input type="checkbox" onchange="Operations.selectAllExceptions(this.checked)"> Выбрать все</label>
          <span id="operations-selected-count">${this.selectedExceptions.size} выбрано</span>
          <button class="btn btn-outline btn-sm" onclick="Operations.bulkExceptions('request_1c')">На согласование в 1С</button>
          <button class="btn btn-outline btn-sm" onclick="Operations.bulkExceptions('verify_supplier')">Проверить поставщиков</button>
          ${canManage ? '<button class="btn btn-primary btn-sm" onclick="Operations.bulkExceptions(\'approve_1c\')">Одобрить и передать в 1С</button>' : ''}
        </div>` : ''}
        <div class="operations-exceptions">${exceptions.length ? exceptions.map(row => `
          <div class="operation-row ${this.selectedExceptions.has(row.id) ? 'is-selected' : ''}">
            <input class="operation-row__check" type="checkbox" aria-label="Выбрать накладную ${App.esc(row.invoice_number || row.id)}" ${this.selectedExceptions.has(row.id) ? 'checked' : ''} onchange="Operations.selectException(${row.id}, this.checked)">
            <a class="operation-row__main" href="#/invoices/${row.id}"><strong>№${App.esc(row.invoice_number || row.id)}</strong><small>${App.esc(row.supplier || 'Поставщик не определён')}</small></a>
            <span class="operation-row__reasons">${row.reasons.map(reason => `<span>${App.esc(reason)}</span>`).join('')}</span>
            <strong class="operation-row__amount">${this.money(row.total_sum)}</strong>
          </div>`).join('') : this.empty('Исключений нет — текущие правила качества выполнены')}</div>
      </article>

      ${this.renderRootCauses()}
      ${canManage ? this.renderDelegates() : (canApprove ? `<article class="card operations-panel operations-panel--wide"><span class="operations-eyebrow">Делегирование</span><h3>Вы можете согласовывать документы${this.data.permissions.approval_limit == null ? ' без лимита' : ` до ${this.money(this.data.permissions.approval_limit)}`}</h3></article>` : '')}`;
  },

  renderRootCauses() {
    const root = this.data.root_causes || {};
    const group = (title, rows) => `<div class="root-cause-group"><strong>${title}</strong>${(rows || []).slice(0, 6).map(row => `<div><span>${App.esc(row.name)}</span><b>${row.count}</b></div>`).join('') || '<small>Нет данных</small>'}</div>`;
    return `<article class="card operations-panel operations-panel--wide">
      <div class="operations-panel__head"><div><span class="operations-eyebrow">Первопричины</span><h3>Где теряется качество</h3></div><small>Группировка текущих исключений</small></div>
      <div class="root-cause-grid">${group('По причине', root.by_reason)}${group('По поставщику', root.by_supplier)}${group('По типу документа', root.by_document_type)}</div>
    </article>`;
  },

  renderDelegates() {
    const users = (this.data.approval_users || []).filter(user => user.role !== 'admin');
    const delegates = this.data.approval_delegates || [];
    return `<article class="card operations-panel operations-panel--wide">
      <div class="operations-panel__head"><div><span class="operations-eyebrow">Роли согласования</span><h3>Заместители и лимиты</h3></div><small>Доступ действует до указанной даты и не даёт прав администратора</small></div>
      <form class="delegate-form" onsubmit="Operations.createApprovalDelegate(event)"><select id="delegate-user" required><option value="">Выберите пользователя</option>${users.map(user => `<option value="${user.id}">${App.esc(user.username)}</option>`).join('')}</select><input id="delegate-limit" type="number" min="0" placeholder="Лимит суммы, ₽"><input id="delegate-until" type="date"><button class="btn btn-primary btn-sm" type="submit">Назначить</button></form>
      <div class="delegate-list">${delegates.map(row => `<div><span><strong>${App.esc(row.delegate_name)}</strong><small>${row.max_amount == null ? 'без лимита' : `до ${this.money(row.max_amount)}`} · ${row.valid_until ? `до ${App.esc(row.valid_until)}` : 'без срока'}</small></span><b>${row.active ? 'активен' : 'отозван'}</b>${row.active ? `<button class="btn btn-outline btn-sm" onclick="Operations.revokeApprovalDelegate(${row.id})">Отозвать</button>` : ''}</div>`).join('') || this.empty('Заместители не назначены')}</div>
    </article>`;
  },

  toggle(id, label, checked, disabled = false) {
    return `<label class="operations-toggle"><input id="${id}" type="checkbox"${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}><span class="operations-toggle__box" aria-hidden="true"></span><span>${label}</span></label>`;
  },

  approvalCard(row) {
    const action = row.action === 'sber' ? 'Платёж в Сбер' : 'Передача в 1С';
    const canManage = this.data.permissions?.approve === true;
    const error = row.execution_error
      ? `<small class="approval-card__error">Не выполнено: ${App.esc(row.execution_error)}</small>`
      : '';
    const actions = row.status === 'pending' && canManage
      ? `<button class="btn btn-outline btn-sm" onclick="Operations.decideApproval(${row.id}, 'rejected')">Отклонить</button>
         <button class="btn btn-primary btn-sm" onclick="Operations.decideApproval(${row.id}, 'approved')">Одобрить</button>`
      : `<a class="btn btn-outline btn-sm" href="#/invoices/${row.invoice_id}">Открыть</a>`;
    return `<div class="approval-card">
      ${row.status === 'pending' && canManage ? `<input type="checkbox" aria-label="Выбрать согласование" ${this.selectedApprovals.has(row.id) ? 'checked' : ''} onchange="Operations.selectApproval(${row.id}, this.checked)">` : ''}
      <div><strong>${action} · №${App.esc(row.invoice_number || row.invoice_id)}</strong><small>${App.esc(row.supplier || '')} · ${this.money(row.total_sum)}</small>${error}</div>
      <div class="approval-card__actions">${actions}</div>
    </div>`;
  },

  renderPayments() {
    const summary = this.data.payment_summary;
    const rows = this.data.reconciliation;
    const calendar = this.data.calendar || { rows: [], held: { invoices: 0, amount: 0 }, available_cash: null };
    return `
      <div class="operations-summary-strip">
        ${this.summaryChip('Оплачено', summary.paid || 0, 'success')}
        ${this.summaryChip('В обработке', summary.pending || 0, 'info')}
        ${this.summaryChip('Без платежа', summary.missing || 0, 'muted')}
        ${this.summaryChip('Просрочено', summary.overdue || 0, 'danger')}
        ${this.summaryChip('Расхождения', summary.amount_mismatch || 0, 'warning')}
      </div>
      <article class="card operations-panel operations-panel--wide bank-import-card">
        <div><span class="operations-eyebrow">Банковская выписка</span><h3>Полная сверка фактических операций</h3><p>CSV из любого банка: дата, сумма/дебет/кредит, ИНН и назначение платежа.</p></div>
        <form onsubmit="Operations.importBankStatement(event)"><input id="operations-bank-file" type="file" accept=".csv,.txt" required><button class="btn btn-primary btn-sm" type="submit">Импортировать и сверить</button></form>
      </article>
      <article class="card operations-panel operations-panel--wide">
        <div class="operations-panel__head"><div><span class="operations-eyebrow">Платёжный календарь</span><h3>Потребность в деньгах</h3></div><small>${calendar.available_cash == null ? 'Задайте доступный остаток в правилах' : `Доступно ${this.money(calendar.available_cash)}`} · На паузе ${calendar.held.invoices} (${this.money(calendar.held.amount)})</small></div>
        <div class="calendar-grid">${calendar.rows.length ? calendar.rows.slice(0, 18).map(day => `<div class="calendar-day ${day.overdue ? 'calendar-day--overdue' : ''} ${day.cash_gap ? 'calendar-day--gap' : ''}">
          <span>${App.esc(day.date || 'Без срока')}</span><strong>${this.money(day.amount)}</strong><small>${day.invoices} док. · накопительно ${this.money(day.cumulative)}</small>${day.cash_gap ? `<b>Кассовый разрыв ${this.money(day.cash_gap)}</b>` : ''}
        </div>`).join('') : this.empty('Открытых обязательств нет')}</div>
      </article>
      <article class="card operations-panel operations-panel--wide">
        <div class="operations-panel__head"><div><span class="operations-eyebrow">Сверка платежей</span><h3>Накладные, Сбер и банковские операции</h3></div><small>Автосопоставление объясняется суммой, ИНН, номером и датой</small></div>
        <div class="table-wrap"><table class="operations-table"><thead><tr><th>Накладная</th><th>Поставщик</th><th>Срок и приоритет</th><th>Сумма</th><th>Платёж</th><th>Пауза</th></tr></thead><tbody>
          ${rows.map(row => `<tr>
            <td><a href="#/invoices/${row.invoice_id}"><strong>№${App.esc(row.invoice_number || row.invoice_id)}</strong></a><small>${App.esc(row.invoice_date || '')}</small></td>
            <td>${App.esc(row.supplier || '—')}</td>
            <td><input class="calendar-date" id="ops-due-${row.invoice_id}" type="date" value="${App.esc(row.due_date || '')}"><select id="ops-priority-${row.invoice_id}">${['low','normal','high','critical'].map(value => `<option value="${value}"${row.payment_priority === value ? ' selected' : ''}>${({ low: 'низкий', normal: 'обычный', high: 'высокий', critical: 'критичный' })[value]}</option>`).join('')}</select></td>
            <td>${this.money(row.total_sum)}</td>
            <td><span class="reconcile-badge reconcile-badge--${row.reconciliation.tone}">${App.esc(row.reconciliation.label)}</span>${row.statement_match_score ? `<small>Совпадение ${row.statement_match_score}%: ${App.esc(row.statement_purpose || '')}</small>` : ''}</td>
            <td><input class="calendar-hold" id="ops-hold-${row.invoice_id}" value="${App.esc(row.payment_hold_reason || '')}" placeholder="Причина паузы"><button class="btn btn-outline btn-sm" onclick="Operations.savePaymentPlan(${row.invoice_id})">Сохранить</button></td>
          </tr>`).join('')}
        </tbody></table></div>
      </article>`;
  },

  summaryChip(label, value, tone) {
    return `<div class="operations-summary-chip operations-summary-chip--${tone}"><strong>${value}</strong><span>${label}</span></div>`;
  },

  renderSuppliers() {
    const f = this.data.forecast;
    return `
      <article class="card operations-panel operations-panel--wide">
        <div class="operations-panel__head"><div><span class="operations-eyebrow">Прогноз расходов</span><h3>${this.money(f.outstanding)} открытых обязательств</h3></div><small>Исторический темп: ${this.money(f.historicalMonthly)} / месяц</small></div>
        <div class="forecast-grid">
          ${this.forecastCard('Просрочено', f.overdue, 'danger')}
          ${this.forecastCard('До 7 дней', f.days7, 'warning')}
          ${this.forecastCard('8–30 дней', f.days30, 'info')}
          ${this.forecastCard('31–90 дней', f.days90, 'success')}
        </div>
      </article>
      <article class="card operations-panel operations-panel--wide">
        <div class="operations-panel__head"><div><span class="operations-eyebrow">Рейтинг поставщиков</span><h3>Надёжность и качество документов</h3></div>${this.data.permissions?.manage ? '<button class="btn btn-outline btn-sm" onclick="Operations.verifyAllSuppliers()">Проверить реквизиты по ЕГРЮЛ</button>' : ''}</div>
        <div class="supplier-score-grid">${this.data.suppliers.map(row => `
          <div class="supplier-score-card">
            <div class="supplier-score-card__head"><strong>${App.esc(row.supplier)}</strong><span class="supplier-score supplier-score--${row.score >= 80 ? 'good' : row.score >= 60 ? 'medium' : 'risk'}">${row.score}</span></div>
            <div class="supplier-score-card__meta"><span>${row.invoices} накл.</span><span>${this.money(row.total_spend)}</span><span>${row.verified ? 'Реквизиты проверены' : 'Нужна проверка'}</span></div>
            <div class="supplier-score-card__issues">Ошибки ${row.errors} · Расхождения ${row.mismatches} · Цены выше нормы ${row.elevated_prices} · Просрочки ${row.overdue}</div>
            ${row.verification_risk ? `<div class="supplier-risk">Риск реквизитов: ${App.esc((() => { try { return JSON.parse(row.verification_risk).join(', '); } catch { return row.verification_risk; } })())}</div>` : ''}
            ${row.supplier_inn ? (this.data.permissions?.manage
              ? `<label class="supplier-terms">Срок оплаты <input type="number" min="0" max="365" value="${row.payment_terms_days}" onchange="Operations.saveTerms('${App.esc(row.supplier_inn)}', this.value)"> дней</label>`
              : `<span class="supplier-terms">Срок оплаты: ${row.payment_terms_days} дней</span>`) : ''}
          </div>`).join('')}</div>
      </article>`;
  },

  forecastCard(label, value, tone) {
    return `<div class="forecast-card forecast-card--${tone}"><span>${label}</span><strong>${this.money(value)}</strong></div>`;
  },

  renderChannels() {
    const c = this.channels || {};
    return `<div class="operations-grid operations-grid--channels">
      <article class="card channel-card">
        <div class="channel-card__icon">✈</div><div><span class="operations-eyebrow">Telegram</span><h3>Фото прямо в бот</h3><p>Отправьте фото или изображение-документ настроенному боту — накладная появится в ScanFlow.</p></div>
        <div class="channel-card__footer"><span class="reconcile-badge reconcile-badge--${c.telegram_enabled ? 'success' : 'muted'}">${c.telegram_enabled ? 'Приём включён' : c.telegram_ready ? 'Готов к включению' : 'Настройте бот в профиле'}</span>
          <button class="btn ${c.telegram_enabled ? 'btn-outline' : 'btn-primary'} btn-sm" onclick="Operations.toggleTelegram(${c.telegram_enabled ? 'false' : 'true'})">${c.telegram_enabled ? 'Выключить' : 'Включить'}</button></div>
      </article>
      <article class="card channel-card">
        <div class="channel-card__icon">@</div><div><span class="operations-eyebrow">Email</span><h3>Вложения из почты</h3><p>Сгенерируйте защищённый webhook и укажите его в сервисе пересылки входящих писем. Поддерживаются изображения и PDF до 20 МБ.</p></div>
        <div id="operations-email-url"></div>
        <div class="channel-card__footer"><span class="reconcile-badge reconcile-badge--${c.email_enabled ? 'success' : 'muted'}">${c.email_enabled ? 'Webhook активен' : 'Выключено'}</span>
          <button class="btn ${c.email_enabled ? 'btn-outline' : 'btn-primary'} btn-sm" onclick="Operations.toggleEmail(${c.email_enabled ? 'false' : 'true'})">${c.email_enabled ? 'Выключить' : 'Создать webhook'}</button></div>
      </article>
    </div>`;
  },

  renderReports() {
    const reports = this.data.reports || {};
    const monthly = reports.monthly_spend || [];
    const types = reports.document_types || [];
    const coverage = reports.bank_coverage || { total: 0, reconciled: 0, coverage_percent: 0 };
    return `<div class="report-toolbar"><div><span class="operations-eyebrow">Управленческие отчёты</span><h3>Расходы, качество и покрытие платежей</h3></div><div><button class="btn btn-outline btn-sm" onclick="Operations.exportReportsCsv()">Скачать CSV</button><button class="btn btn-primary btn-sm" onclick="window.print()">Печать / PDF</button></div></div>
      <div class="report-grid">
        <article class="card report-card"><span>Покрытие сверкой</span><strong>${coverage.coverage_percent}%</strong><small>${coverage.reconciled} из ${coverage.total} документов</small><div class="report-progress"><i style="width:${Math.min(100, coverage.coverage_percent)}%"></i></div></article>
        <article class="card operations-panel"><div class="operations-panel__head"><div><span class="operations-eyebrow">12 месяцев</span><h3>Расходы по месяцам</h3></div></div><div class="report-list">${monthly.map(row => `<div><span>${App.esc(row.period)} <small>${row.invoices} док.</small></span><strong>${this.money(row.amount)}</strong></div>`).join('') || this.empty('Нет данных')}</div></article>
        <article class="card operations-panel"><div class="operations-panel__head"><div><span class="operations-eyebrow">Документы</span><h3>Структура потока</h3></div></div><div class="report-list">${types.map(row => `<div><span>${App.esc(row.document_type)} <small>${row.invoices} док.</small></span><strong>${this.money(row.amount)}</strong></div>`).join('') || this.empty('Нет данных')}</div></article>
      </div>${this.renderRootCauses()}`;
  },

  renderOnec() {
    if (!this.data.permissions?.manage) return `<div class="empty-state">Подключения 1С настраивает администратор.</div>`;
    const state = this.onec || { connections: [], catalog: {}, sync_state: {} };
    const connections = state.connections || [];
    const secret = this.onecSecret ? `<div class="channel-secret onec-secret"><strong>Скопируйте токен сейчас — повторно он не показывается</strong><code>${App.esc(this.onecSecret.token)}</code><code>${App.esc(this.onecSecret.exchange_url)}</code><button class="btn btn-primary btn-sm" onclick="Operations.copyOnecSecret()">Скопировать настройки</button></div>` : '';
    return `<div class="operations-grid operations-grid--control">
      <article class="card operations-panel">
        <div class="operations-panel__head"><div><span class="operations-eyebrow">Новая база 1С</span><h3>Безопасное подключение</h3></div><span class="status-badge status-processed">Scoped token</span></div>
        <p>Отдельный токен имеет доступ только к каталогу, одобренным документам, фото и возврату статуса.</p>
        <form class="onec-create" onsubmit="Operations.createOnecConnection(event)"><input id="onec-connection-name" required maxlength="128" placeholder="Например: УНФ — новый магазин"><button class="btn btn-primary" type="submit">Создать подключение</button></form>${secret}
      </article>
      <article class="card operations-panel">
        <div class="operations-panel__head"><div><span class="operations-eyebrow">Каталог товаров</span><h3>${state.catalog?.items || 0} позиций из 1С</h3></div><small>${state.catalog?.last_synced_at ? `Обновлён ${App.esc(state.catalog.last_synced_at)}` : 'Ещё не выгружен'}</small></div>
        <div class="onec-health"><div><span>Последний опрос</span><strong>${App.esc(state.last_poll_at || 'нет')}</strong></div><div><span>Нужна пересинхронизация</span><strong>${state.sync_state?.requested ? 'Да' : 'Нет'}</strong></div></div>
        <button class="btn btn-outline btn-sm" onclick="Operations.downloadOnecSource('object')">Скачать модуль обработки</button>
        <button class="btn btn-outline btn-sm" onclick="Operations.downloadOnecSource('form')">Скачать модуль формы</button>
      </article>
    </div>
    <article class="card operations-panel operations-panel--wide"><div class="operations-panel__head"><div><span class="operations-eyebrow">Подключённые базы</span><h3>${connections.length}</h3></div></div><div class="onec-connections">${connections.map(row => `<div><span class="connection-dot ${row.active ? 'is-active' : ''}"></span><div><strong>${App.esc(row.name)}</strong><small>${row.active ? `токен ${App.esc(row.token_prefix)}… · использован ${App.esc(row.last_used_at || 'ещё нет')}` : `отозван ${App.esc(row.revoked_at || '')}`}</small></div>${row.active ? `<button class="btn btn-outline btn-sm" onclick="Operations.revokeOnecConnection(${row.id})">Отозвать</button>` : ''}</div>`).join('') || this.empty('Подключений пока нет')}</div></article>
    <article class="card operations-panel operations-panel--wide"><div class="operations-panel__head"><div><span class="operations-eyebrow">Последовательность</span><h3>Первый обмен за 6 шагов</h3></div></div><ol class="onec-steps"><li>Создайте подключение и сохраните токен.</li><li>Обновите или соберите внешнюю обработку из исходников.</li><li>Вставьте токен в поле обработки и нажмите «Сохранить подключение».</li><li>Выберите категории и выгрузите номенклатуру.</li><li>Одобрите тестовую накладную в ScanFlow и загрузите её в 1С.</li><li>После проверки включите регламентную синхронизацию каждые 10–15 минут.</li></ol></article>`;
  },

  renderAssistant() {
    const messages = this.assistantMessages.length
      ? this.assistantMessages.map(message => `<div class="assistant-message assistant-message--${message.role}"><div>${App.esc(message.text)}</div>${(message.links || []).map(link => `<a href="${App.esc(link.href)}">${App.esc(link.label)}</a>`).join('')}</div>`).join('')
      : `<div class="assistant-welcome"><span>AI</span><h3>Спросите о работе ScanFlow</h3><p>«Что нужно оплатить за 7 дней?», «покажи исключения», «какой поставщик самый надёжный?»</p></div>`;
    return `<article class="card assistant-shell">
      <div id="operations-assistant-messages" class="assistant-messages">${messages}</div>
      <form class="assistant-compose" onsubmit="Operations.askAssistant(event)">
        <textarea id="operations-assistant-input" rows="2" placeholder="Задайте вопрос о накладных, платежах или поставщиках"></textarea>
        <button type="button" class="btn btn-outline assistant-mic" onclick="Operations.startVoice()" title="Голосовой ввод" aria-label="Голосовой ввод">🎙</button>
        <button type="submit" class="btn btn-primary">Спросить</button>
      </form>
    </article>`;
  },

  empty(text) { return `<div class="operations-empty">✓ ${App.esc(text)}</div>`; },

  async saveAutopilot() {
    const numberOrNull = id => {
      const value = Number(document.getElementById(id)?.value || 0);
      return value > 0 ? value : null;
    };
    try {
      const response = await App.apiJson('/operations/autopilot', { method: 'PUT', body: {
        auto_send_1c: document.getElementById('ops-auto-1c').checked,
        auto_send_sber: document.getElementById('ops-auto-sber').checked,
        require_all_mapped: document.getElementById('ops-require-mapped').checked,
        block_total_mismatch: document.getElementById('ops-block-mismatch').checked,
        require_verified_supplier: document.getElementById('ops-require-supplier').checked,
        min_mapping_confidence: Number(document.getElementById('ops-min-confidence').value || 0) / 100,
        max_total: numberOrNull('ops-max-total'),
        payment_approval_threshold: numberOrNull('ops-approval-threshold'),
        payment_cash_balance: document.getElementById('ops-cash-balance').value === '' ? null : Number(document.getElementById('ops-cash-balance').value),
      } });
      this.data.settings = response.data;
      App.notify('Правила автопилота сохранены', 'success');
      this.renderKpis(); this.render();
    } catch (error) { App.notify(error.message, 'error'); }
  },

  async decideApproval(id, decision) {
    try {
      await App.apiJson(`/operations/approvals/${id}/decision`, { method: 'POST', body: { decision } });
      App.notify(decision === 'approved' ? 'Согласовано и отправлено на выполнение' : 'Запрос отклонён', 'success');
      this.data = null; await this.load(true);
    } catch (error) { App.notify(error.message, 'error'); this.data = null; await this.load(true); }
  },

  selectException(id, selected) {
    if (selected) this.selectedExceptions.add(id); else this.selectedExceptions.delete(id);
    const counter = document.getElementById('operations-selected-count');
    if (counter) counter.textContent = `${this.selectedExceptions.size} выбрано`;
  },

  selectAllExceptions(selected) {
    this.selectedExceptions.clear();
    if (selected) this.data.exceptions.forEach(row => this.selectedExceptions.add(row.id));
    this.render();
  },

  async bulkExceptions(action) {
    const invoiceIds = [...this.selectedExceptions];
    if (!invoiceIds.length) { App.notify('Сначала выберите документы', 'error'); return; }
    try {
      const response = await App.apiJson('/operations/exceptions/bulk', { method: 'POST', body: { invoice_ids: invoiceIds, action } });
      const failed = response.data.results.filter(row => !row.success);
      App.notify(failed.length ? `Выполнено ${invoiceIds.length - failed.length}, ошибок ${failed.length}` : `Обработано документов: ${invoiceIds.length}`, failed.length ? 'error' : 'success');
      this.selectedExceptions.clear(); this.data = null; await this.load(true);
    } catch (error) { App.notify(error.message, 'error'); }
  },

  selectApproval(id, selected) {
    if (selected) this.selectedApprovals.add(id); else this.selectedApprovals.delete(id);
  },

  async decideSelectedApprovals(decision) {
    const ids = [...this.selectedApprovals];
    if (!ids.length) { App.notify('Выберите запросы на согласование', 'error'); return; }
    try {
      const response = await App.apiJson('/operations/approval-batches/decision', { method: 'POST', body: { approval_ids: ids, decision } });
      const failed = response.data.results.filter(row => row.error);
      App.notify(failed.length ? `Решения сохранены, ошибок исполнения: ${failed.length}` : 'Групповое решение выполнено', failed.length ? 'error' : 'success');
      this.selectedApprovals.clear(); this.data = null; await this.load(true);
    } catch (error) { App.notify(error.message, 'error'); }
  },

  async createApprovalDelegate(event) {
    event.preventDefault();
    try {
      await App.apiJson('/operations/approval-delegates', { method: 'POST', body: {
        delegate_user_id: Number(document.getElementById('delegate-user').value),
        max_amount: document.getElementById('delegate-limit').value || null,
        valid_until: document.getElementById('delegate-until').value || null,
      } });
      App.notify('Заместитель назначен', 'success'); this.data = null; await this.load(true);
    } catch (error) { App.notify(error.message, 'error'); }
  },

  async revokeApprovalDelegate(id) {
    try {
      await App.apiJson(`/operations/approval-delegates/${id}`, { method: 'DELETE' });
      App.notify('Делегирование отозвано', 'success'); this.data = null; await this.load(true);
    } catch (error) { App.notify(error.message, 'error'); }
  },

  async importBankStatement(event) {
    event.preventDefault();
    const file = document.getElementById('operations-bank-file')?.files?.[0];
    if (!file) return;
    const form = new FormData(); form.append('file', file);
    try {
      const response = await App.apiJson('/operations/bank-statement/import', { method: 'POST', body: form });
      App.notify(`Импортировано ${response.data.imported}, сопоставлено ${response.data.matched}, дубликатов ${response.data.skipped}`, 'success');
      this.data = null; await this.load(true);
    } catch (error) { App.notify(error.message, 'error'); }
  },

  async savePaymentPlan(invoiceId) {
    try {
      await App.apiJson(`/operations/calendar/${invoiceId}`, { method: 'PATCH', body: {
        payment_due_date: document.getElementById(`ops-due-${invoiceId}`)?.value || null,
        payment_priority: document.getElementById(`ops-priority-${invoiceId}`)?.value || 'normal',
        payment_hold_reason: document.getElementById(`ops-hold-${invoiceId}`)?.value || null,
      } });
      App.notify('План платежа сохранён', 'success'); this.data = null; await this.load(true);
    } catch (error) { App.notify(error.message, 'error'); }
  },

  async verifyAllSuppliers() {
    const inns = this.data.suppliers.map(row => row.supplier_inn).filter(Boolean);
    if (!inns.length) { App.notify('Нет поставщиков с ИНН', 'error'); return; }
    try {
      const response = await App.apiJson('/operations/suppliers/verify', { method: 'POST', body: { inns } });
      const ok = response.data.results.filter(row => row.status === 'verified').length;
      const risk = response.data.results.filter(row => row.risk?.length).length;
      App.notify(`Проверено ${ok}; с отличиями ${risk}`, risk ? 'error' : 'success');
      this.data = null; await this.load(true);
    } catch (error) { App.notify(error.message, 'error'); }
  },

  exportReportsCsv() {
    const report = this.data.reports || {};
    const rows = [['Раздел', 'Период/тип', 'Документов', 'Сумма']];
    (report.monthly_spend || []).forEach(row => rows.push(['Расходы', row.period, row.invoices, row.amount]));
    (report.document_types || []).forEach(row => rows.push(['Тип документа', row.document_type, row.invoices, row.amount]));
    const cell = value => { const raw = String(value ?? ''); const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw; return `"${safe.replace(/"/g, '""')}"`; };
    const csv = '\uFEFF' + rows.map(row => row.map(cell).join(';')).join('\n');
    const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); link.download = `scanflow-report-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(link.href);
  },

  async createOnecConnection(event) {
    event.preventDefault();
    const name = document.getElementById('onec-connection-name')?.value?.trim();
    if (!name) return;
    try {
      const response = await App.apiJson('/onec/connections', { method: 'POST', body: { name } });
      this.onecSecret = response.data;
      this.onec = (await App.apiJson('/onec/connections')).data;
      this.render(); App.notify('Подключение создано — сохраните токен', 'success');
    } catch (error) { App.notify(error.message, 'error'); }
  },

  copyOnecSecret() {
    if (!this.onecSecret) return;
    navigator.clipboard.writeText(`Адрес: ${this.onecSecret.exchange_url}\nТокен: ${this.onecSecret.token}\nЗаголовок: X-1C-Token`);
    App.notify('Настройки подключения скопированы', 'success');
  },

  async revokeOnecConnection(id) {
    if (!confirm('Отозвать токен? Эта база 1С сразу потеряет доступ к обмену.')) return;
    try {
      await App.apiJson(`/onec/connections/${id}`, { method: 'DELETE' });
      this.onec = (await App.apiJson('/onec/connections')).data; this.render(); App.notify('Токен отозван', 'success');
    } catch (error) { App.notify(error.message, 'error'); }
  },

  async downloadOnecSource(part) {
    try {
      const response = await App.api(`/onec/source/${part}`);
      if (!response.ok) throw new Error('Не удалось скачать исходник');
      const blob = await response.blob(); const link = document.createElement('a');
      link.href = URL.createObjectURL(blob); link.download = part === 'form' ? 'ScanFlow_FormModule.bsl' : 'ScanFlow_ObjectModule.bsl'; link.click(); URL.revokeObjectURL(link.href);
    } catch (error) { App.notify(error.message, 'error'); }
  },

  async saveTerms(inn, value) {
    try {
      await App.apiJson(`/operations/suppliers/${encodeURIComponent(inn)}/terms`, { method: 'PATCH', body: { payment_terms_days: Number(value) } });
      App.notify('Срок оплаты сохранён', 'success');
    } catch (error) { App.notify(error.message, 'error'); }
  },

  async toggleTelegram(enabled) {
    try {
      await App.apiJson(`/inbound/telegram/${enabled ? 'enable' : 'disable'}`, { method: 'POST' });
      this.channels.telegram_enabled = enabled;
      App.notify(enabled ? 'Приём фото из Telegram включён' : 'Telegram-приём выключен', 'success');
      this.render();
    } catch (error) { App.notify(error.message, 'error'); }
  },

  async toggleEmail(enabled) {
    try {
      const response = await App.apiJson(`/inbound/email/${enabled ? 'enable' : 'disable'}`, { method: 'POST' });
      this.channels.email_enabled = enabled;
      this.render();
      if (enabled && response.data?.webhook_url && response.data?.webhook_token) {
        const holder = document.getElementById('operations-email-url');
        const configText = `POST ${response.data.webhook_url}\nX-Inbound-Token: ${response.data.webhook_token}`;
        if (holder) holder.innerHTML = `<div class="channel-secret"><strong>Скопируйте сейчас — токен показывается один раз</strong><code>${App.esc(configText)}</code><button class="btn btn-outline btn-sm" id="operations-copy-email">Копировать</button></div>`;
        document.getElementById('operations-copy-email')?.addEventListener('click', () => {
          navigator.clipboard.writeText(configText);
          App.notify('Скопировано', 'success');
        });
      }
      App.notify(enabled ? 'Email webhook создан' : 'Email webhook выключен', 'success');
    } catch (error) { App.notify(error.message, 'error'); }
  },

  async askAssistant(event) {
    event.preventDefault();
    const input = document.getElementById('operations-assistant-input');
    const question = input.value.trim();
    if (!question) return;
    this.assistantMessages.push({ role: 'user', text: question });
    input.value = '';
    this.render();
    try {
      const response = await App.apiJson('/operations/assistant', { method: 'POST', body: { question } });
      this.assistantMessages.push({ role: 'assistant', text: response.data.answer, links: response.data.links });
    } catch (error) {
      this.assistantMessages.push({ role: 'assistant', text: `Не удалось получить ответ: ${error.message}` });
    }
    this.render();
    document.getElementById('operations-assistant-input')?.focus();
  },

  startVoice() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) { App.notify('Голосовой ввод не поддерживается этим браузером', 'error'); return; }
    const recognition = new Recognition();
    recognition.lang = 'ru-RU';
    recognition.interimResults = false;
    recognition.onresult = event => {
      const input = document.getElementById('operations-assistant-input');
      if (input) input.value = event.results[0][0].transcript;
    };
    recognition.onerror = () => App.notify('Не удалось распознать речь', 'error');
    recognition.start();
  },
};

window.Operations = Operations;
