/* global App, Invoices */
const Sber = {
  state: { status: null },

  async load() {
    const res = await App.api('/sber/status');
    this.state.status = await res.json();
    this.renderConnectPage();
  },

  renderConnectPage() {
    const card = document.getElementById('sber-status-card');
    const actions = document.getElementById('sber-actions');
    const s = this.state.status;
    if (!s.connected) {
      card.innerHTML = '<p>● <strong>Не подключено</strong></p>';
      actions.innerHTML = `
        <div style="display:flex;gap:8px;margin-bottom:16px">
          <button id="sber-connect-oauth" class="btn btn-primary" onclick="window.location.href='/api/sber/authorize?key='+encodeURIComponent(App.apiKey)">Подключить через OAuth</button>
          <button class="btn btn-outline" onclick="Sber.toggleSeedForm()">Ввести токены вручную</button>
        </div>
        <div id="sber-seed-form" style="display:none"></div>
      `;
      return;
    }
    const expiredText = s.token_expired
      ? '<strong style="color:#f59e0b">просрочен — обновите ниже</strong>'
      : '<strong style="color:#10b981">активен</strong>';
    const dotColor = s.token_expired ? '#f59e0b' : '#10b981';
    card.innerHTML = `
      <p>● <strong style="color:${dotColor}">Подключено: ${App.esc(s.org_name || '?')}</strong></p>
      <p class="muted">Расчётный счёт: ${App.esc(s.account_number || '?')}</p>
      <p class="muted">Токен: ${expiredText}</p>
      <p class="muted">Реквизиты плательщика: ${s.payer_complete ? 'заполнены' : '<strong style="color:#f59e0b">НЕПОЛНЫЕ — заполните ниже</strong>'}</p>
    `;
    const tokenBorder = s.token_expired ? 'border-color:#f59e0b' : '';
    actions.innerHTML = `
      <div class="card" style="margin-bottom:24px;${tokenBorder}">
        <h3 style="margin-bottom:4px">Токен API СберБизнес</h3>
        <p class="muted" style="margin-bottom:12px">
          Вставьте новый Access и Refresh токен, чтобы продлить доступ — реквизиты плательщика при этом сохранятся.
        </p>
        ${this.tokenHelpHtml()}
        <form id="sber-token-form" style="display:grid;gap:12px;max-width:480px;margin-top:16px">
          <label>Access Token<input name="access_token" autocomplete="off" spellcheck="false" required></label>
          <label>Refresh Token<input name="refresh_token" autocomplete="off" spellcheck="false" required></label>
          <label>Действует до <span class="muted" style="font-weight:400">(необязательно, по умолчанию +30 дней)</span><input name="expires_at" type="date"></label>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-primary" type="submit">Сохранить токен</button>
            <button type="button" class="btn btn-outline" onclick="window.location.href='/api/sber/authorize?key='+encodeURIComponent(App.apiKey)">Обновить через OAuth (автоматически)</button>
          </div>
        </form>
      </div>
      <h3 style="margin-bottom:12px">Реквизиты плательщика</h3>
      <form id="sber-payer-form" style="display:grid;gap:12px;max-width:480px;margin-bottom:16px">
        <label>ИНН<input name="payer_inn" value="${App.esc(s.payer_inn || '')}" pattern="[0-9]{10}|[0-9]{12}" required></label>
        <label>КПП<input name="payer_kpp" value="${App.esc(s.payer_kpp || '')}" pattern="[0-9]{9}"></label>
        <label>БИК банка<input name="payer_bank_bic" value="${App.esc(s.payer_bank_bic || '')}" pattern="[0-9]{9}" required></label>
        <label>Корсчёт банка<input name="payer_bank_corr_account" value="${App.esc(s.payer_bank_corr_account || '')}" pattern="[0-9]{20}" required></label>
        <button class="btn btn-primary" type="submit">Сохранить реквизиты</button>
      </form>
      <button class="btn btn-danger" onclick="Sber.disconnect()">Отключить Сбербанк</button>
    `;
    document.getElementById('sber-token-form').addEventListener('submit', (e) => Sber.saveSeed(e));
    document.getElementById('sber-payer-form').addEventListener('submit', (e) => Sber.savePayer(e));
  },

  // Пошаговая инструкция «где взять токен на СберБизнес». Используется и в
  // подключённом состоянии (обновление токена), и в форме первичного ввода.
  tokenHelpHtml() {
    const SBBOL_URL = 'https://sbi.sberbank.ru:9443/ic/ufs/host/index.html#/sbbapi/org-account';
    return `
      <details class="help-block">
        <summary>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
          Где взять токен на СберБизнес и какой именно
        </summary>
        <ol class="help-steps">
          <li>
            <span class="help-step-num">1</span>
            <div>Откройте <b>СберБизнес → раздел «Интеграция по API»</b>. Кнопка ниже ведёт прямо на нужную страницу управления API-доступом.
              <div style="margin-top:8px">
                <a href="${SBBOL_URL}" target="_blank" rel="noopener" class="btn btn-outline btn-sm">Открыть СберБизнес →</a>
              </div>
            </div>
          </li>
          <li>
            <span class="help-step-num">2</span>
            <div>Выберите вашу организацию и <b>расчётный счёт</b>, по которому пойдут платежи.</div>
          </li>
          <li>
            <span class="help-step-num">3</span>
            <div>В правах доступа отметьте продукт <b>«Платежи»</b> — право <code>PAY_DOC_RU</code>. Без него ScanFlow не сможет создавать платёжные поручения.</div>
          </li>
          <li>
            <span class="help-step-num">4</span>
            <div>Подтвердите доступ (токен/SMS). Портал покажет <b>два значения</b>:
              <ul style="margin:6px 0 0;padding-left:18px">
                <li><b>Access token</b> (токен доступа) — им ScanFlow подписывает каждый запрос. Именно он «протухает» через несколько часов/дней — тогда его и нужно обновить здесь.</li>
                <li><b>Refresh token</b> (токен обновления) — длинный, живёт дольше; используется, чтобы автоматически продлевать access-токен.</li>
              </ul>
            </div>
          </li>
          <li>
            <span class="help-step-num">5</span>
            <div>Скопируйте оба значения и вставьте в поля ниже: access → в <b>«Access Token»</b>, refresh → в <b>«Refresh Token»</b>. Если портал показал срок действия — впишите его в <b>«Действует до»</b>.</div>
          </li>
          <li>
            <span class="help-step-num">6</span>
            <div>Нажмите <b>«Сохранить токен»</b>. Готово — доступ продлён.</div>
          </li>
        </ol>
        <p class="muted" style="margin-top:8px;font-size:12px">
          Названия разделов на портале могут немного отличаться. Чтобы не обновлять токен вручную каждый раз — нажмите
          <b>«Обновить через OAuth»</b>: ScanFlow проведёт авторизацию и будет продлевать access-токен сам.
        </p>
      </details>
    `;
  },

  toggleSeedForm() {
    const wrap = document.getElementById('sber-seed-form');
    if (wrap.style.display === 'none' || !wrap.innerHTML) {
      wrap.innerHTML = `
        <div class="card">
          <h3 style="margin-bottom:12px">Ввод токенов вручную</h3>
          <p class="muted" style="margin-bottom:12px">Вставьте Access и Refresh токен с СберБизнес, а также реквизиты плательщика.</p>
          ${this.tokenHelpHtml()}
          <form id="seed-form" style="display:grid;gap:12px;max-width:480px;margin-top:16px">
            <label>Access Token<input name="access_token" autocomplete="off" spellcheck="false" required></label>
            <label>Refresh Token<input name="refresh_token" autocomplete="off" spellcheck="false" required></label>
            <label>Номер расчётного счёта (20 цифр)<input name="account_number" pattern="[0-9]{20}"></label>
            <label>Наименование организации<input name="org_name"></label>
            <label>ИНН<input name="payer_inn" pattern="[0-9]{10}|[0-9]{12}"></label>
            <label>КПП<input name="payer_kpp" pattern="[0-9]{9}"></label>
            <label>БИК банка<input name="payer_bank_bic" pattern="[0-9]{9}"></label>
            <label>Корсчёт банка<input name="payer_bank_corr_account" pattern="[0-9]{20}"></label>
            <button class="btn btn-primary" type="submit">Сохранить</button>
          </form>
        </div>
      `;
      wrap.style.display = 'block';
      document.getElementById('seed-form').addEventListener('submit', (e) => Sber.saveSeed(e));
    } else {
      wrap.style.display = 'none';
    }
  },

  async saveSeed(e) {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target).entries());
    for (const k of Object.keys(data)) if (data[k] === '') delete data[k];
    const res = await App.api('/sber/seed-token', {
      method: 'POST',
      body: JSON.stringify(data),
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      const err = await res.json();
      App.notify(err.error || 'Ошибка', 'error');
      return;
    }
    App.notify('Токены сохранены', 'success');
    this.load();
  },

  async savePayer(e) {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target).entries());
    const res = await App.api('/sber/payer', {
      method: 'PATCH',
      body: JSON.stringify(data),
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      const err = await res.json();
      App.notify(err.error || 'Ошибка', 'error');
      return;
    }
    App.notify('Реквизиты сохранены', 'success');
    this.load();
  },

  async disconnect() {
    if (!confirm('Точно отключить Сбербанк?')) return;
    await App.api('/sber/disconnect', { method: 'POST' });
    this.load();
  },

  // ===== Section на странице деталей накладной =====
  async renderInvoiceSection(invoice) {
    const wrap = document.getElementById('invoice-sber-section');
    if (!wrap) return;
    wrap.style.display = 'block';
    const status = this.state.status || (await (await App.api('/sber/status')).json());
    this.state.status = status;
    if (!status.connected || !status.payer_complete) {
      wrap.innerHTML = `
        <h3 style="margin-bottom:8px">Сбербанк</h3>
        <p class="muted">Сбербанк не подключён или нет реквизитов плательщика. <a href="#/sber">Открыть настройки</a></p>
      `;
      return;
    }
    const stRes = await App.api(`/invoices/${invoice.id}/sber-status`);
    const { payment } = await stRes.json();
    if (payment && payment.status === 'created') {
      wrap.innerHTML = `
        <h3 style="margin-bottom:8px">Сбербанк</h3>
        <div class="badge badge-sent" style="padding:8px 16px;display:inline-block">✓ Платёж создан в Сбере (черновик № ${App.esc(payment.sber_payment_number || '?')}). Подпишите в Сбер.Бизнес.</div>
        <div style="margin-top:12px">
          <div style="font-size:12px;color:var(--muted);margin-bottom:4px">Назначение платежа:</div>
          <div style="font-family:var(--font-mono,monospace);font-size:13px;background:var(--code-bg,rgba(0,0,0,0.04));padding:8px 12px;border-radius:6px;border:1px solid var(--border,rgba(0,0,0,0.08))">${App.esc(payment.payment_purpose || '')}</div>
        </div>
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
          <button class="btn btn-outline" onclick="Sber.editTemplate()">⚙ Шаблон назначения</button>
          <button class="btn btn-outline" onclick="Sber.resend(${invoice.id})">⟳ Отправить повторно</button>
          <button class="btn btn-danger" onclick="Sber.deletePayment(${invoice.id})">🗑 Удалить черновик</button>
        </div>
      `;
      return;
    }
    if (payment && payment.status === 'failed') {
      wrap.innerHTML = `
        <h3 style="margin-bottom:8px">Сбербанк</h3>
        <p style="color:#dc2626">Ошибка предыдущей отправки: ${App.esc(payment.error_message || 'unknown')}</p>
        <button class="btn btn-primary" id="sber-send-btn" onclick="Sber.sendToSber(${invoice.id})">Попробовать снова</button>
        <button class="btn btn-outline" onclick="Sber.editTemplate()" style="margin-left:8px">⚙ Шаблон назначения</button>
      `;
      return;
    }
    wrap.innerHTML = `
      <h3 style="margin-bottom:8px">Сбербанк</h3>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-primary" id="sber-send-btn" onclick="Sber.sendToSber(${invoice.id})">Отправить в Сбербанк →</button>
        <button class="btn btn-outline" onclick="Sber.editTemplate()">⚙ Шаблон назначения</button>
      </div>
    `;
  },

  async editTemplate() {
    const res = await App.api('/profile/sber-template');
    const { template } = await res.json();
    const PLACEHOLDERS = '{invoice_number} {invoice_date_dot} {invoice_date_iso} {total} {vat_amount} {vat_rate} {supplier} {vat_clause}';
    const newTpl = window.prompt(
      'Шаблон назначения платежа (≤210 символов после подстановки).\n\n' +
      'Доступные плейсхолдеры:\n' + PLACEHOLDERS + '\n\n' +
      'Дефолт: Оплата по накладной № {invoice_number} от {invoice_date_dot}, {vat_clause}',
      template || ''
    );
    if (newTpl === null) return; // отмена
    if (newTpl.trim() === (template || '').trim()) {
      App.notify('Шаблон не изменён', 'info');
      return;
    }
    const saveRes = await App.api('/profile/sber-template', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template: newTpl }),
    });
    if (!saveRes.ok) {
      const err = await saveRes.json().catch(() => ({}));
      App.notify(err.error || 'Ошибка сохранения шаблона', 'error');
      return;
    }
    App.notify('Шаблон сохранён. Применится к следующему платежу.', 'success');
  },

  async deletePayment(invoiceId) {
    if (!window.confirm(
      'Удалить запись о платеже из ScanFlow?\n\n' +
      'ВАЖНО: реальный черновик платёжки В САМОМ Сбер.Бизнес НЕ будет удалён ' +
      '(API не позволяет). Если черновик там не нужен — удали его вручную ' +
      'в личном кабинете Сбер.Бизнес перед нажатием.'
    )) return;
    const res = await App.api(`/invoices/${invoiceId}/sber-payment`, { method: 'DELETE' });
    if (!res.ok) {
      App.notify('Ошибка удаления', 'error');
      return;
    }
    App.notify('Запись удалена. Кнопка «Отправить в Сбербанк» снова доступна.', 'success');
    Invoices.showDetail(invoiceId);
  },

  async resend(invoiceId) {
    if (!window.confirm(
      'Создать ЕЩЁ ОДИН платёж в Сбер.Бизнес?\n\n' +
      'ВНИМАНИЕ: предыдущий черновик НЕ удалится автоматически — он останется ' +
      'в банке как отдельная платёжка. Если предыдущий не нужен, сначала ' +
      'удали его вручную в Сбер.Бизнес, потом нажми «Отправить повторно».'
    )) return;
    // Удаляем нашу запись и сразу отправляем заново
    const delRes = await App.api(`/invoices/${invoiceId}/sber-payment`, { method: 'DELETE' });
    if (!delRes.ok) {
      App.notify('Не удалось очистить запись', 'error');
      return;
    }
    await Sber.sendToSber(invoiceId);
  },

  async sendToSber(invoiceId, supplierOverrides) {
    // Pre-flight: required header fields для платёжки.
    if (!supplierOverrides && window.Invoices?._missingFields) {
      try {
        const j = await App.api(`/invoices/${invoiceId}`).then(r => r.json());
        const missing = window.Invoices._missingFields(j.data, window.Invoices._REQUIRED_FOR_SBER);
        if (missing.length > 0) {
          window.Invoices._openEditModal({
            invoice: j.data,
            title: 'Дозаполните реквизиты для отправки в Сбербанк',
            requiredFields: window.Invoices._REQUIRED_FOR_SBER,
            reasonText: 'Без этих полей Сбер не примет платёжку',
            onSaved: () => Sber.sendToSber(invoiceId),
          });
          return;
        }
      } catch (e) {
        // Если не можем проверить — продолжаем как есть, backend всё равно отвергнет
        console.warn('[sber] pre-flight check failed', e);
      }
    }

    const btn = document.getElementById('sber-send-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Создание платежа...'; }
    const body = supplierOverrides ? { supplier_overrides: supplierOverrides } : {};
    const res = await App.api(`/invoices/${invoiceId}/send-sber`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
    if (res.status === 409) {
      const data = await res.json();
      if (data.needs_supplier_confirmation) {
        SberModal.open(data.prefilled, async (overrides) => {
          await Sber.sendToSber(invoiceId, overrides);
          return true;
        });
        if (btn) { btn.disabled = false; btn.textContent = 'Отправить в Сбербанк →'; }
        return;
      }
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      App.notify(err.error || `Ошибка ${res.status}`, 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Отправить в Сбербанк →'; }
      return;
    }
    const ok = await res.json();
    App.notify(`Черновик создан в Сбере (№ ${ok.payment_number || '?'}). Подпишите в Сбер.Бизнес.`, 'success');
    Invoices.showDetail(invoiceId);
  },
};

window.Sber = Sber;
