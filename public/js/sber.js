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
          <button class="btn btn-primary" onclick="window.location.href='/api/sber/authorize?key='+encodeURIComponent(App.apiKey)">Подключить через OAuth</button>
          <button class="btn btn-outline" onclick="Sber.toggleSeedForm()">Ввести токены вручную</button>
        </div>
        <div id="sber-seed-form" style="display:none"></div>
      `;
      return;
    }
    const expiredText = s.token_expired ? 'просрочен (нужно обновить)' : 'активен';
    const dotColor = s.token_expired ? '#f59e0b' : '#10b981';
    card.innerHTML = `
      <p>● <strong style="color:${dotColor}">Подключено: ${App.esc(s.org_name || '?')}</strong></p>
      <p class="muted">Расчётный счёт: ${App.esc(s.account_number || '?')}</p>
      <p class="muted">Токен: ${expiredText}</p>
      <p class="muted">Реквизиты плательщика: ${s.payer_complete ? 'заполнены' : '<strong style="color:#f59e0b">НЕПОЛНЫЕ — заполните ниже</strong>'}</p>
    `;
    actions.innerHTML = `
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
    document.getElementById('sber-payer-form').addEventListener('submit', (e) => Sber.savePayer(e));
  },

  toggleSeedForm() {
    const wrap = document.getElementById('sber-seed-form');
    if (wrap.style.display === 'none' || !wrap.innerHTML) {
      wrap.innerHTML = `
        <div class="card">
          <h3 style="margin-bottom:12px">Manual seed-token</h3>
          <p class="muted" style="margin-bottom:12px">Вставьте токены и реквизиты с портала developers.sber.ru.</p>
          <form id="seed-form" style="display:grid;gap:12px;max-width:480px">
            <label>Access Token<input name="access_token" required></label>
            <label>Refresh Token<input name="refresh_token" required></label>
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
