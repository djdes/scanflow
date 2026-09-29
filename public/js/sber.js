/* global App, Invoices */
const Sber = {
  state: { status: null },

  async load() {
    // Возврат от Сбера после входа: #/sber?sber=connected | ?sber=error&sber_error=…
    const q = new URLSearchParams((window.location.hash.split('?')[1]) || '');
    if (q.get('sber') === 'connected') App.notify('Сбербанк подключён — доступ будет обновляться автоматически', 'success');
    if (q.get('sber') === 'error') App.notify(`Вход через Сбербанк не удался: ${q.get('sber_error') || 'неизвестная ошибка'}`, 'error');
    if (q.get('sber')) history.replaceState(null, '', '#/sber');
    const res = await App.api('/sber/status');
    this.state.status = await res.json();
    this.renderConnectPage();
  },

  async startOAuth(btn) {
    if (btn) btn.disabled = true;
    try {
      const { url } = await App.apiJson('/sber/authorize-url');
      window.location.href = url;
    } catch (e) {
      App.notify(e.message || 'Не удалось начать вход через Сбербанк', 'error');
      if (btn) btn.disabled = false;
    }
  },

  _fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  },

  // Состояние доступа к Сбербанку: токены, автообновление, ключ приложения.
  authHtml(s) {
    const a = s.auth || {};
    const sec = a.secret || {};
    const autoOk = !a.last_refresh_error && a.last_refresh_at;
    const autoLine = a.last_refresh_error
      ? `<div class="sber-auth-warn">⚠ Автообновление не работает: ${App.esc(a.last_refresh_error)}</div>`
      : autoOk
        ? `<div class="sber-auth-ok">✓ Доступ обновляется автоматически (последний раз ${this._fmtDate(a.last_refresh_at)})</div>`
        : '<div class="muted">Автообновление ещё не проверялось — нажмите «Обновить доступ сейчас».</div>';
    const secretLine = sec.perpetual
      ? '<b style="color:var(--green,#16a34a)">бессрочный ✓</b>'
      : sec.source === 'db' && sec.days_left != null
        ? (sec.days_left <= 5 ? `<b style="color:#dc2626">истекает через ${sec.days_left} дн.</b>` : `действует ещё ${sec.days_left} дн.`)
        : sec.source === 'env' ? 'задан в настройках сервера, срок неизвестен (живёт 40 дней)' : '<b style="color:#dc2626">не задан</b>';
    return `
      <div class="card sber-auth-card">
        <h3 style="margin-bottom:8px">Доступ к API СберБизнес</h3>
        ${autoLine}
        <div class="sber-auth-grid">
          <span class="muted">Токен доступа до</span><span>${this._fmtDate(a.access_expires_at)}</span>
          <span class="muted">Токен обновления до</span><span>${this._fmtDate(a.refresh_expires_at)} <span class="muted">(продлевается при каждом обновлении)</span></span>
          <span class="muted">Ключ приложения (client_secret)</span><span>${secretLine}</span>
        </div>
        ${sec.last_error ? `<div class="sber-auth-warn" style="margin-top:6px">Последняя ошибка ключа: ${App.esc(sec.last_error)}</div>` : ''}
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
          <button class="btn btn-soft btn-sm" onclick="Sber.refreshNow(this)">Обновить доступ сейчас</button>
          <button class="btn btn-soft btn-sm" onclick="Sber.startOAuth(this)">Войти через Сбербанк заново</button>
          <button class="btn btn-soft btn-sm" onclick="Sber.syncPayments(this)">Проверить статусы платёжек</button>
        </div>
        <details class="help-block" style="margin-top:14px">
          <summary>Ключ приложения (client_secret)</summary>
          <p class="field-hint" style="margin:8px 0">Сбер выдаёт client_secret на 40 дней; без действующего ключа доступ не обновляется. ScanFlow может заменить его на <b>бессрочный</b> — тогда ничего не придётся обновлять вручную. Если этот же client_id используется ещё в какой-то программе, после замены ключ там тоже нужно будет обновить.</p>
          ${sec.perpetual ? '' : '<button class="btn btn-primary btn-sm" onclick="Sber.makePerpetual(this)">Сделать текущий ключ бессрочным</button>'}
          <form id="sber-secret-form" style="display:grid;gap:8px;max-width:480px;margin-top:12px">
            <label>Новый client_secret из личного кабинета Sber API<input name="client_secret" autocomplete="off" spellcheck="false" required></label>
            <label class="switch-inline"><input type="checkbox" name="make_perpetual" checked> сразу сделать бессрочным</label>
            <div><button class="btn btn-soft btn-sm" type="submit">Сохранить ключ</button></div>
          </form>
        </details>
      </div>`;
  },

  async refreshNow(btn) {
    if (btn) btn.disabled = true;
    try {
      await App.apiJson('/sber/refresh-now', { method: 'POST' });
      App.notify('Доступ обновлён — автообновление работает', 'success');
    } catch (e) {
      App.notify(e.message || 'Не удалось обновить доступ', 'error');
    } finally {
      await this.load();
    }
  },

  async makePerpetual(btn) {
    if (!window.confirm('Заменить client_secret на бессрочный?\n\nТекущий ключ перестанет действовать. Если этот client_id используется ещё в какой-то программе — там ключ нужно будет обновить.')) return;
    if (btn) btn.disabled = true;
    try {
      await App.apiJson('/sber/client-secret/perpetual', { method: 'POST' });
      App.notify('Ключ приложения теперь бессрочный', 'success');
    } catch (e) {
      App.notify(e.message || 'Не удалось сделать ключ бессрочным', 'error');
    } finally {
      await this.load();
    }
  },

  async saveSecret(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const { data } = await App.apiJson('/sber/client-secret', {
        method: 'POST',
        body: { client_secret: String(fd.get('client_secret') || ''), make_perpetual: fd.get('make_perpetual') === 'on' },
      });
      App.notify(data.perpetual ? 'Ключ сохранён и стал бессрочным' : (data.warning ? `Ключ сохранён на 40 дней. Бессрочным сделать не удалось: ${data.warning}` : 'Ключ сохранён на 40 дней'), data.warning ? 'info' : 'success');
    } catch (err) {
      App.notify(err.message || 'Не удалось сохранить ключ', 'error');
    } finally {
      await this.load();
    }
  },

  async syncPayments(btn) {
    if (btn) btn.disabled = true;
    try {
      const { data } = await App.apiJson('/sber/payments/sync', { method: 'POST' });
      App.notify(`Проверено платёжек: ${data.checked}, изменилось: ${data.changed}${data.errors ? `, ошибок: ${data.errors}` : ''}`, data.errors ? 'info' : 'success');
    } catch (e) {
      App.notify(e.message || 'Не удалось проверить статусы', 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  },

  renderConnectPage() {
    const card = document.getElementById('sber-status-card');
    const actions = document.getElementById('sber-actions');
    const s = this.state.status;
    if (!s.connected) {
      card.innerHTML = '<p>● <strong>Не подключено</strong></p>';
      actions.innerHTML = `
        <div style="display:flex;gap:8px;margin-bottom:16px">
          <button id="sber-connect-oauth" class="btn btn-primary" onclick="Sber.startOAuth(this)">Войти через Сбербанк</button>
          <button class="btn btn-outline" onclick="Sber.toggleSeedForm()">Вставить токены из личного кабинета</button>
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
    actions.innerHTML = `
      ${s.auth ? this.authHtml(s) : ''}
      <details class="card" style="margin-bottom:24px">
        <summary style="cursor:pointer;font-weight:600">Вставить пару токенов вручную (запасной вариант)</summary>
        <p class="muted" style="margin:10px 0 12px">
          Обычно не нужно: доступ обновляется сам. Пара из личного кабинета Sber API: access — 30 дней, refresh — 180 дней. После вставки ScanFlow сразу проверит, что сможет обновлять её автоматически.
        </p>
        ${this.tokenHelpHtml()}
        <form id="sber-token-form" style="display:grid;gap:12px;max-width:480px;margin-top:16px">
          <label>Access Token<input name="access_token" autocomplete="off" spellcheck="false" required></label>
          <label>Refresh Token<input name="refresh_token" autocomplete="off" spellcheck="false" required></label>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-primary" type="submit">Сохранить токены</button>
          </div>
        </form>
      </details>
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
    document.getElementById('sber-secret-form')?.addEventListener('submit', (e) => Sber.saveSecret(e));
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
                <li><b>Access token</b> (токен доступа) — им ScanFlow подписывает каждый запрос. Из личного кабинета он живёт 30 дней, дальше ScanFlow продлевает его сам.</li>
                <li><b>Refresh token</b> (токен обновления) — живёт 180 дней и продлевается при каждом обновлении; по нему ScanFlow получает новые токены без вас.</li>
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
          Названия разделов на портале могут немного отличаться. Проще всего — кнопка <b>«Войти через Сбербанк»</b>:
          ScanFlow получит токены сам и будет их продлевать.
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
    const ok = await res.json().catch(() => ({}));
    if (ok.auto_refresh === 'failed') {
      App.notify(`Токены сохранены (работают 30 дней), но автообновление не работает: ${ok.warning || 'причина неизвестна'}`, 'error');
    } else {
      App.notify('Токены сохранены — дальше доступ обновляется автоматически', 'success');
    }
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
      const kind = payment.bank_status_kind;
      const badgeCls = kind === 'paid' ? 'badge-sent' : kind === 'failed' ? 'badge-error' : 'badge-processing';
      const bankLine = payment.bank_status
        ? `<div class="badge ${badgeCls}" style="padding:6px 12px;display:inline-block;margin-top:8px">В банке: ${App.esc(payment.bank_status_label || payment.bank_status)}</div>
           ${payment.bank_comment ? `<div class="field-hint" style="margin-top:4px">Комментарий банка: ${App.esc(payment.bank_comment)}</div>` : ''}`
        : '';
      wrap.innerHTML = `
        <h3 style="margin-bottom:8px">Сбербанк</h3>
        <div class="badge badge-sent" style="padding:8px 16px;display:inline-block">✓ Платёж создан в Сбере (черновик № ${App.esc(payment.sber_payment_number || '?')}${payment.amount != null ? `, ${App.esc(String(payment.amount).replace('.', ','))} ₽` : ''}). Подпишите в Сбер.Бизнес.</div>
        ${bankLine}
        <div style="margin-top:12px">
          <div style="font-size:12px;color:var(--muted);margin-bottom:4px">Назначение платежа:</div>
          <div style="font-family:var(--font-mono,monospace);font-size:13px;background:var(--code-bg,rgba(0,0,0,0.04));padding:8px 12px;border-radius:6px;border:1px solid var(--border,rgba(0,0,0,0.08))">${App.esc(payment.payment_purpose || '')}</div>
        </div>
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
          <button class="btn btn-outline" onclick="Sber.checkInvoicePayment(${invoice.id}, this)">↻ Проверить статус</button>
          <button class="btn btn-outline" onclick="Sber.editTemplate()">⚙ Шаблон назначения</button>
          <button class="btn btn-outline" onclick="Sber.resend(${invoice.id})">⟳ Отправить повторно</button>
          <button class="btn btn-danger" onclick="Sber.deletePayment(${invoice.id})">🗑 Удалить черновик</button>
        </div>
      `;
      return;
    }
    const preview = await this._loadPreview(invoice.id);
    if (payment && payment.status === 'failed') {
      wrap.innerHTML = `
        <h3 style="margin-bottom:8px">Сбербанк</h3>
        <p style="color:#dc2626">Ошибка предыдущей отправки: ${App.esc(payment.error_message || 'unknown')}</p>
        ${this._presendHtml(preview)}
        ${this._attrGateRow(invoice)}
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-primary" id="sber-send-btn" onclick="Sber.sendToSber(${invoice.id})">Попробовать снова</button>
          <button class="btn btn-outline" onclick="Sber.editTemplate()">⚙ Шаблон назначения</button>
        </div>
      `;
      Invoices._syncSberGate();
      return;
    }
    wrap.innerHTML = `
      <h3 style="margin-bottom:8px">Сбербанк</h3>
      ${this._presendHtml(preview)}
      ${this._attrGateRow(invoice)}
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-primary" id="sber-send-btn" onclick="Sber.sendToSber(${invoice.id})">Отправить в Сбербанк →</button>
        <button class="btn btn-outline" onclick="Sber.editTemplate()">⚙ Шаблон назначения</button>
      </div>
    `;
    // Начальное состояние кнопки считаем от галочек в шапке — одна точка
    // истины на весь экран (Invoices._syncSberGate).
    Invoices._syncSberGate();
  },

  // Что уйдёт в Сбер: сумма и назначение этой платёжки (можно поправить, не
  // меняя накладную). Пусто — сервер возьмёт сумму накладной и шаблон.
  async _loadPreview(invoiceId) {
    try {
      const { data } = await App.apiJson(`/invoices/${invoiceId}/sber-preview`);
      this.state.preview = { invoiceId, ...data };
      return this.state.preview;
    } catch {
      this.state.preview = null;
      return null;
    }
  },

  _money(n) {
    return n == null ? '—' : Number(n).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  },

  _presendHtml(p) {
    if (!p) return '';
    const amount = p.amount != null ? String(p.amount.toFixed(2)).replace('.', ',') : '';
    return `
      <div class="sber-presend">
        <label>Сумма платежа, ₽
          <input id="sber-amount" inputmode="decimal" value="${App.esc(amount)}" autocomplete="off">
        </label>
        <div class="field-hint">Сумма накладной: ${this._money(p.total_sum)} ₽${p.vat_sum != null ? ` · в т.ч. НДС ${this._money(p.vat_sum)} ₽` : ''}. Поменяете здесь — изменится только эта платёжка.</div>
        <label style="margin-top:8px">Назначение платежа <span class="muted">(до 210 символов)</span>
          <textarea id="sber-purpose" rows="2" maxlength="210">${App.esc(p.purpose || '')}</textarea>
        </label>
      </div>`;
  },

  _presendOverrides(invoiceId) {
    const p = this.state.preview;
    if (!p || p.invoiceId !== invoiceId) return {};
    const out = {};
    const amountEl = document.getElementById('sber-amount');
    const purposeEl = document.getElementById('sber-purpose');
    if (amountEl) {
      const n = Number(String(amountEl.value).replace(/\s/g, '').replace(',', '.'));
      if (Number.isFinite(n) && n > 0 && Math.abs(n - (p.amount ?? 0)) >= 0.005) out.amount_override = Math.round(n * 100) / 100;
    }
    if (purposeEl && purposeEl.value.trim() && purposeEl.value.trim() !== (p.purpose || '').trim()) out.purpose_override = purposeEl.value.trim();
    return out;
  },

  async checkInvoicePayment(invoiceId, btn) {
    if (btn) btn.disabled = true;
    try {
      await App.apiJson('/sber/payments/sync', { method: 'POST' });
    } catch (e) {
      App.notify(e.message || 'Не удалось проверить статус', 'error');
    }
    Invoices.showDetail(invoiceId);
  },

  // Общая галочка «Все реквизиты сверены» + подсказка о недостающих полях.
  // Своего флага в БД у неё нет: она отражает и переключает те же пять отметок.
  _attrGateRow(invoice) {
    return `
      <label class="sber-attrs-all">
        <input type="checkbox" id="sber-attrs-all"
               onchange="Invoices.toggleAllAttrChecks(${invoice.id}, this.checked)">
        <span>Все реквизиты сверены с фото</span>
      </label>
      <div class="sber-attrs-hint" id="sber-attrs-hint" hidden></div>
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

    // Спиннер и восстановление состояния кнопки — через общий хелпер: он сам
    // вернёт исходный текст и disabled в finally. Ручное восстановление здесь
    // было опасно тем, что затирало состояние гейта чек-листа (кнопка могла
    // «разблокироваться», хотя реквизиты не сверены).
    const btn = document.getElementById('sber-send-btn');
    await App.withBusyButton(btn, async () => {
      const body = { ...Sber._presendOverrides(invoiceId), ...(supplierOverrides ? { supplier_overrides: supplierOverrides } : {}) };
      if (body.amount_override != null && !window.confirm(`Сумма платежа ${Sber._money(body.amount_override)} ₽ отличается от суммы накладной. Отправить так?`)) return;
      const res = await App.api(`/invoices/${invoiceId}/send-sber`, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      });
      if (res.status === 409) {
        const data = await res.json();
        if (data.needs_supplier_confirmation) {
          // Поставщика нет в справочнике по ИНН (или он подобран по названию) —
          // даём выбрать карточку из справочника; выбор закрепится за накладной.
          SberModal.open(data.prefilled, async (overrides) => {
            await Sber.sendToSber(invoiceId, overrides);
            return true;
          }, {
            picker: true,
            supplier_match: data.supplier_match ?? null,
            inn_invalid: !!data.inn_invalid,
            ocr: data.ocr || {},
            candidates: data.candidates || [],
          });
          return;
        }
        // Прочие 409 (чек-лист не закрыт, лимит согласования, платёж уже есть)
        // — показываем текст сервера, он объясняет причину.
        App.notify(data.error || 'Отправка отклонена', 'error');
        return;
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        App.notify(err.error || `Ошибка ${res.status}`, 'error');
        return;
      }
      const ok = await res.json();
      App.notify(`Черновик создан в Сбере (№ ${ok.payment_number || '?'}). Подпишите в Сбер.Бизнес.`, 'success');
      Invoices.showDetail(invoiceId);
    });
  },
};

window.Sber = Sber;
