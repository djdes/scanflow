/* global App */
const Operations = {
  data: null,
  channels: null,
  activeTab: 'control',
  loading: false,
  assistantMessages: [],

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
    else if (this.activeTab === 'assistant') el.innerHTML = this.renderAssistant();
    else el.innerHTML = this.renderControl();
  },

  renderControl() {
    const s = this.data.settings;
    const exceptions = this.data.exceptions;
    const canManage = this.data.permissions?.manage === true;
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
          </div>
          ${canManage ? '<button type="button" class="btn btn-primary btn-sm" onclick="Operations.saveAutopilot()">Сохранить правила</button>' : '<small class="muted">Изменять правила может администратор.</small>'}
        </article>

        <article class="card operations-panel">
          <div class="operations-panel__head"><div><span class="operations-eyebrow">Согласования</span><h3>Требуют внимания</h3></div><strong>${approvals.length}</strong></div>
          <div class="operations-stack">${approvals.length ? approvals.map(row => this.approvalCard(row)).join('') : this.empty('Нет запросов на согласование')}</div>
        </article>
      </div>

      <article class="card operations-panel operations-panel--wide">
        <div class="operations-panel__head"><div><span class="operations-eyebrow">Центр исключений</span><h3>Требуют внимания</h3></div><strong>${exceptions.length}</strong></div>
        <div class="operations-exceptions">${exceptions.length ? exceptions.map(row => `
          <a class="operation-row" href="#/invoices/${row.id}">
            <span class="operation-row__main"><strong>№${App.esc(row.invoice_number || row.id)}</strong><small>${App.esc(row.supplier || 'Поставщик не определён')}</small></span>
            <span class="operation-row__reasons">${row.reasons.map(reason => `<span>${App.esc(reason)}</span>`).join('')}</span>
            <strong class="operation-row__amount">${this.money(row.total_sum)}</strong>
          </a>`).join('') : this.empty('Исключений нет — текущие правила качества выполнены')}</div>
      </article>`;
  },

  toggle(id, label, checked, disabled = false) {
    return `<label class="operations-toggle"><input id="${id}" type="checkbox"${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}><span class="operations-toggle__box" aria-hidden="true"></span><span>${label}</span></label>`;
  },

  approvalCard(row) {
    const action = row.action === 'sber' ? 'Платёж в Сбер' : 'Передача в 1С';
    const canManage = this.data.permissions?.manage === true;
    const error = row.execution_error
      ? `<small class="approval-card__error">Не выполнено: ${App.esc(row.execution_error)}</small>`
      : '';
    const actions = row.status === 'pending' && canManage
      ? `<button class="btn btn-outline btn-sm" onclick="Operations.decideApproval(${row.id}, 'rejected')">Отклонить</button>
         <button class="btn btn-primary btn-sm" onclick="Operations.decideApproval(${row.id}, 'approved')">Одобрить</button>`
      : `<a class="btn btn-outline btn-sm" href="#/invoices/${row.invoice_id}">Открыть</a>`;
    return `<div class="approval-card">
      <div><strong>${action} · №${App.esc(row.invoice_number || row.invoice_id)}</strong><small>${App.esc(row.supplier || '')} · ${this.money(row.total_sum)}</small>${error}</div>
      <div class="approval-card__actions">${actions}</div>
    </div>`;
  },

  renderPayments() {
    const summary = this.data.payment_summary;
    const rows = this.data.reconciliation;
    return `
      <div class="operations-summary-strip">
        ${this.summaryChip('Оплачено', summary.paid || 0, 'success')}
        ${this.summaryChip('В обработке', summary.pending || 0, 'info')}
        ${this.summaryChip('Без платежа', summary.missing || 0, 'muted')}
        ${this.summaryChip('Просрочено', summary.overdue || 0, 'danger')}
        ${this.summaryChip('Расхождения', summary.amount_mismatch || 0, 'warning')}
      </div>
      <article class="card operations-panel operations-panel--wide">
        <div class="operations-panel__head"><div><span class="operations-eyebrow">Сверка СберБизнес</span><h3>Накладные и платежи</h3></div><small>На основе платежей, созданных ScanFlow</small></div>
        <div class="table-wrap"><table class="operations-table"><thead><tr><th>Накладная</th><th>Поставщик</th><th>Срок</th><th>Сумма</th><th>Платёж</th></tr></thead><tbody>
          ${rows.map(row => `<tr onclick="location.hash='#/invoices/${row.invoice_id}'">
            <td><strong>№${App.esc(row.invoice_number || row.invoice_id)}</strong><small>${App.esc(row.invoice_date || '')}</small></td>
            <td>${App.esc(row.supplier || '—')}</td>
            <td>${App.esc(row.due_date || '—')}</td>
            <td>${this.money(row.total_sum)}</td>
            <td><span class="reconcile-badge reconcile-badge--${row.reconciliation.tone}">${App.esc(row.reconciliation.label)}</span></td>
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
        <div class="operations-panel__head"><div><span class="operations-eyebrow">Рейтинг поставщиков</span><h3>Надёжность и качество документов</h3></div></div>
        <div class="supplier-score-grid">${this.data.suppliers.map(row => `
          <div class="supplier-score-card">
            <div class="supplier-score-card__head"><strong>${App.esc(row.supplier)}</strong><span class="supplier-score supplier-score--${row.score >= 80 ? 'good' : row.score >= 60 ? 'medium' : 'risk'}">${row.score}</span></div>
            <div class="supplier-score-card__meta"><span>${row.invoices} накл.</span><span>${this.money(row.total_spend)}</span><span>${row.verified ? 'Реквизиты проверены' : 'Нужна проверка'}</span></div>
            <div class="supplier-score-card__issues">Ошибки ${row.errors} · Расхождения ${row.mismatches} · Цены выше нормы ${row.elevated_prices} · Просрочки ${row.overdue}</div>
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
