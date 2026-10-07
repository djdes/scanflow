/* global App, Settings */
const Settings = {
  loaded: false,
  /** Режим из настроек: сохраняем его как есть — смена режима только кнопкой «Перейти на GPT». */
  _mode: 'gpt',
  _canEdit: false,

  async load() {
    if (this.loaded) return;
    try {
      const { data } = await App.apiJson('/settings/analyzer');
      if (data) {
        this._mode = data.mode || 'gpt';
        this._canEdit = !!data.can_edit;
        const gptSelect = document.getElementById('settings-gpt-model');
        if (gptSelect && data.gpt_model) {
          // Модель, которой нет в списке (задана через API), всё равно показываем.
          if (![...gptSelect.options].some(o => o.value === data.gpt_model)) {
            gptSelect.add(new Option(data.gpt_model, data.gpt_model));
          }
          gptSelect.value = data.gpt_model;
        }
        const llmCb = document.getElementById('settings-llm-mapper');
        if (llmCb) llmCb.checked = !!data.llm_mapper_enabled;
        const dadataInput = document.getElementById('settings-dadata-key');
        if (dadataInput && data.dadata_api_key) dadataInput.value = data.dadata_api_key;
        this._setDadataStatus(!!data.has_dadata_key);
        this._initAutoSend(data);
        this._applyEditRights();
        const warn = document.getElementById('mode-warning');
        if (warn) warn.style.display = (this._canEdit && this._mode !== 'gpt') ? '' : 'none';
        this.chatgptRefresh();
      }
      this.loaded = true;
    } catch (e) {
      console.error('Failed to load settings', e);
    }

    this._renderUsers();
    this._renderCompanies();
    this._renderEngineFlags();
    this._renderGolden();
  },

  // Менять настройки может только админ: остальным — те же значения, но без правки.
  _applyEditRights() {
    const ids = ['settings-gpt-model', 'settings-llm-mapper', 'settings-auto-send-1c', 'settings-auto-send-sber', 'settings-dadata-key'];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) el.disabled = !this._canEdit;
    }
    document.querySelectorAll('#view-settings .settings-admin-only').forEach(el => {
      el.style.display = this._canEdit ? '' : 'none';
    });
    const actions = document.getElementById('chatgpt-actions');
    if (actions) actions.style.display = this._canEdit ? 'flex' : 'none';
  },

  _setDadataStatus(saved) {
    const el = document.getElementById('dadata-key-status');
    if (!el) return;
    el.textContent = saved ? 'Ключ сохранён' : 'Ключ не задан';
    el.style.color = saved ? 'var(--green)' : 'var(--text-muted, #888)';
  },

  // «Сразу отправлять в 1С» и «Сразу создавать платёжку» сохраняются при переключении.
  _initAutoSend(data) {
    for (const [id, field] of [['settings-auto-send-1c', 'auto_send_1c'], ['settings-auto-send-sber', 'auto_send_sber']]) {
      const cb = document.getElementById(id);
      if (!cb) continue;
      cb.checked = !!data[field];
      cb.addEventListener('change', async () => {
        cb.disabled = true;
        const ok = await this._put({ [field]: cb.checked });
        if (ok) App.notify(`${cb.checked ? 'Включено' : 'Выключено'}: ${cb.closest('.form-group').querySelector('.toggle-wrap > span').textContent}`, 'success');
        else cb.checked = !cb.checked;
        cb.disabled = false;
      });
    }
  },

  /** PUT /settings/analyzer с текущим режимом (API требует mode) и нужными полями. */
  async _put(fields) {
    try {
      const res = await App.api('/settings/analyzer', { method: 'PUT', body: { mode: this._mode, ...fields } });
      if (res.ok) return true;
      const data = await res.json().catch(() => ({}));
      App.notify(data.error || 'Не удалось сохранить', 'error');
    } catch (e) {
      App.notify('Ошибка: ' + e.message, 'error');
    }
    return false;
  },

  async save() {
    const gptModel = document.getElementById('settings-gpt-model')?.value;
    const llmCb = document.getElementById('settings-llm-mapper');
    const ok = await this._put({ gpt_model: gptModel, llm_mapper_enabled: llmCb ? llmCb.checked : true });
    if (ok) App.notify('Настройки сохранены', 'success');
  },

  async saveDadata() {
    const input = document.getElementById('settings-dadata-key');
    const value = input ? input.value.trim() : '';
    if (!value) { App.notify('Вставьте ключ DaData', 'error'); return; }
    if (await this._put({ dadata_api_key: value })) {
      this._setDadataStatus(true);
      App.notify('Ключ DaData сохранён', 'success');
    }
  },

  async switchToGpt() {
    if (await this._put({ mode: 'gpt' })) {
      this._mode = 'gpt';
      document.getElementById('mode-warning').style.display = 'none';
      App.notify('Распознавание переключено на GPT', 'success');
    }
  },

  // «Проверки и пересчёт» (флаги движков v2): каждый переключатель сохраняется сразу.
  // Выключенный — прежнее поведение (рычаг отката без выкладки). Менять может только админ.
  async _renderEngineFlags() {
    const host = document.getElementById('settings-engine-flags');
    if (!host) return;
    let flags;
    let isAdmin = false;
    try {
      const resp = await App.apiJson('/settings/engine-flags');
      flags = resp.data;
      isAdmin = !!resp.can_edit;
    } catch (e) {
      host.innerHTML = '';
      return;
    }
    host.innerHTML = `
      <details class="card settings-details" style="margin-top:24px">
        <summary><h3 style="display:inline">Проверки и пересчёт</h3></summary>
        <div class="field-hint" style="margin:10px 0 16px">Выключенный пункт работает по-старому — на случай, если что-то стало считаться не так.</div>
        ${flags.map(f => `
          <div class="form-group" style="margin-bottom:14px">
            <div class="toggle-wrap">
              <label class="toggle">
                <input type="checkbox" data-engine-flag="${App.esc(f.key)}" ${f.enabled ? 'checked' : ''} ${isAdmin ? '' : 'disabled'}>
                <span class="toggle-slider"></span>
              </label>
              <span><strong>${App.esc(f.title)}</strong></span>
            </div>
            <div class="field-hint">${App.esc(f.hint)}</div>
          </div>`).join('')}
      </details>`;
    host.querySelectorAll('input[data-engine-flag]').forEach(cb => {
      cb.addEventListener('change', async () => {
        const key = cb.getAttribute('data-engine-flag');
        cb.disabled = true;
        try {
          await App.apiJson('/settings/engine-flags', { method: 'PUT', body: { [key]: cb.checked } });
          App.notify(`${cb.checked ? 'Включено' : 'Выключено'}: ${cb.closest('.form-group').querySelector('strong').textContent}`, 'success');
        } catch (e) {
          cb.checked = !cb.checked;
          App.notify(e.message || 'Не удалось сохранить', 'error');
        } finally {
          cb.disabled = false;
        }
      });
    });
  },

  // Admin-only "Команда и роли" card. Always asks the backend: a 200 means the
  // caller is admin (render the card); a 403 means non-admin (render nothing).
  // requireAdmin on /api/users is the real enforcement — this is just UI gating.
  async _renderUsers() {
    const host = document.getElementById('settings-users');
    if (!host) return;
    try {
      const res = await App.api('/users');
      if (!res.ok) { host.innerHTML = ''; return; }
      const { data } = await res.json();
      const esc = (s) => App.esc(String(s ?? ''));
      const rows = (data || []).map((u) => `
        <tr>
          <td>${u.id}</td>
          <td><strong>${esc(u.username)}</strong></td>
          <td>${esc(u.email || '—')}</td>
          <td>${u.last_login_at ? esc(u.last_login_at) : '<span class="muted">—</span>'}</td>
          <td>
            <select class="role-select" data-prev="${esc(u.role)}" onchange="Settings.changeRole(${u.id}, this.value, this)">
              <option value="user"${u.role !== 'admin' ? ' selected' : ''}>Пользователь</option>
              <option value="admin"${u.role === 'admin' ? ' selected' : ''}>Администратор</option>
            </select>
          </td>
        </tr>`).join('');
      host.innerHTML = `
        <div class="card" style="margin-top:24px">
          <h3 style="margin-bottom:6px">Команда и роли</h3>
          <p class="field-hint" style="margin-bottom:16px">Администратор управляет настройками и интеграциями; пользователь видит накладные своей компании.</p>
          <div class="table-wrap">
            <table>
              <thead><tr><th>ID</th><th>Логин</th><th>Email</th><th>Последний вход</th><th>Роль</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>`;
    } catch (e) {
      host.innerHTML = '';
      console.error('Failed to load users', e);
    }
  },

  // «Компании» (только администратор): кто чем пользуется, очередь в 1С,
  // покрытие сопоставлениями. 403 для не-админа — карточка не рисуется.
  async _renderCompanies() {
    const host = document.getElementById('settings-companies');
    if (!host) return;
    try {
      const res = await App.api('/users/companies');
      if (!res.ok) { host.innerHTML = ''; return; }
      const { data } = await res.json();
      const esc = (s) => App.esc(String(s ?? ''));
      const date = (s) => s ? esc(String(s).slice(0, 10).split('-').reverse().join('.')) : '<span class="muted">—</span>';
      const rub = (n) => `${Math.round(Number(n) || 0).toLocaleString('ru-RU')} ₽`;
      const rows = (data || []).map((c) => {
        const stalled = c.last_sent_at && c.sent_7d === 0 && c.invoices_7d > 0 && c.queue_count > 0;
        return `
        <tr>
          <td><strong>${esc(c.username || ('#' + c.owner_user_id))}</strong></td>
          <td>${c.invoices_30d} <span class="muted">/ ${c.invoices_total}</span></td>
          <td>${date(c.last_upload_at)}</td>
          <td>${date(c.last_sent_at)}${stalled ? ' <span class="badge badge-error" title="За неделю есть новые накладные, но в 1С ничего не ушло">стоит</span>' : ''}</td>
          <td>${c.queue_count ? `${c.queue_count} · ${rub(c.queue_sum)}` : '—'}${c.queue_with_sber_payment ? `<div class="muted">с платёжкой: ${c.queue_with_sber_payment}</div>` : ''}</td>
          <td>${c.unmapped_lines_in_queue || '—'}</td>
          <td>${c.mappings} <span class="muted">/ ${c.catalog_items}</span></td>
          <td>${c.sber_connected ? '✓' : '—'}</td>
        </tr>`;
      }).join('');
      host.innerHTML = `
        <div class="card" style="margin-top:24px">
          <h3 style="margin-bottom:6px">Компании</h3>
          <p class="field-hint" style="margin-bottom:16px">«Стоит» — за неделю загружены накладные, но в 1С ничего не ушло.</p>
          <div class="table-wrap">
            <table class="data-table">
              <thead><tr><th>Компания</th><th>Накладных 30 дн. / всего</th><th>Последняя загрузка</th><th>Последняя отправка в 1С</th><th>Очередь в 1С</th><th>Строк без позиции 1С</th><th>Сопоставлений / каталог</th><th>Сбер</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>`;
    } catch (e) {
      host.innerHTML = '';
      console.error('Failed to load companies', e);
    }
  },

  // Change a user's role via PATCH /api/users/:id/role; revert the <select> on
  // failure (e.g. server refuses to demote the last admin).
  async changeRole(id, role, sel) {
    const prev = sel.getAttribute('data-prev') || 'user';
    try {
      const res = await App.api(`/users/${id}/role`, { method: 'PATCH', body: { role } });
      if (res.ok) {
        App.notify('Роль обновлена', 'success');
        sel.setAttribute('data-prev', role);
      } else {
        const d = await res.json().catch(() => ({}));
        App.notify(d.error || 'Не удалось изменить роль', 'error');
        sel.value = prev;
      }
    } catch (e) {
      App.notify('Ошибка: ' + e.message, 'error');
      sel.value = prev;
    }
  },

  // Toggle a password field between hidden and revealed so the admin can verify
  // a stored key. Flips the input type and the button label.
  toggleReveal(inputId, btn) {
    const inp = document.getElementById(inputId);
    if (!inp) return;
    const reveal = inp.type === 'password';
    inp.type = reveal ? 'text' : 'password';
    if (btn) btn.textContent = reveal ? 'Скрыть' : 'Показать';
  },

  // ── Подписка ChatGPT: вход по коду, как у `codex login --device-auth` ──
  _chatgptPollTimer: null,
  _chatgptLoginExpires: 0,

  async chatgptRefresh() {
    const statusEl = document.getElementById('chatgpt-status');
    if (!statusEl) return;
    try {
      const { data } = await App.apiJson('/chatgpt');
      this._chatgptRender(data);
      if (data.pending_login) this._chatgptShowLogin(data.pending_login);
    } catch (e) {
      if (e.status !== 403) {
        statusEl.textContent = 'Не удалось получить состояние: ' + e.message;
        return;
      }
      // Не админ: подключение не видно, но состояние распознавания — да.
      try {
        const { data } = await App.apiJson('/ai/status');
        statusEl.textContent = data.available ? 'Работает.' : data.text;
        statusEl.style.color = data.available ? 'var(--success)' : 'var(--warning)';
      } catch {
        statusEl.textContent = 'Подключение настраивает администратор.';
      }
    }
  },

  _chatgptRender(d) {
    const fmt = iso => (iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
    let text;
    let color;
    if (!d.connected) {
      text = 'Не подключено.';
      color = 'var(--text-secondary)';
    } else if (d.status === 'reauth_required') {
      text = 'Нужно войти заново.';
      color = 'var(--error)';
    } else if (d.rate_limited_until) {
      text = `Подключено (${d.account_email || 'аккаунт ChatGPT'}). Лимит подписки исчерпан до ${fmt(d.rate_limited_until)} — накладные подождут.`;
      color = 'var(--warning)';
    } else {
      text = `Подключено: ${d.account_email || 'аккаунт ChatGPT'}${d.plan_type ? `, ${d.plan_type}` : ''}.`;
      color = 'var(--success)';
    }
    if (!d.proxy_configured) text += ' Не задан прокси для OpenAI (OPENAI_PROXY_URL).';
    const statusEl = document.getElementById('chatgpt-status');
    statusEl.textContent = text;
    statusEl.style.color = color;
    statusEl.title = d.last_error || '';
    document.getElementById('chatgpt-login-btn').textContent = d.connected ? 'Войти заново' : 'Войти по коду';
    document.getElementById('chatgpt-test-btn').style.display = d.connected ? '' : 'none';
    document.getElementById('chatgpt-disconnect-btn').style.display = d.connected ? '' : 'none';
  },

  _chatgptShowLogin(login) {
    const box = document.getElementById('chatgpt-login');
    const url = App.esc(login.verification_url);
    box.style.display = '';
    box.innerHTML = `Откройте <a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>, войдите в ChatGPT `
      + `и введите код <strong style="font-size:18px;letter-spacing:2px">${App.esc(login.user_code)}</strong>. `
      + `Код действует до ${new Date(login.expires_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}. `
      + '<button type="button" class="btn btn-outline btn-sm" onclick="Settings.chatgptCancel()">Отменить</button>';
    this._chatgptLoginExpires = new Date(login.expires_at).getTime();
    this._chatgptSchedulePoll(login.interval_sec || 5);
  },

  _chatgptHideLogin() {
    clearTimeout(this._chatgptPollTimer);
    const box = document.getElementById('chatgpt-login');
    box.style.display = 'none';
    box.innerHTML = '';
  },

  _chatgptSchedulePoll(intervalSec) {
    clearTimeout(this._chatgptPollTimer);
    if (Date.now() > this._chatgptLoginExpires) {
      this._chatgptHideLogin();
      App.notify('Код истёк — начните вход заново', 'error');
      return;
    }
    this._chatgptPollTimer = setTimeout(() => this._chatgptPoll(intervalSec), intervalSec * 1000);
  },

  async _chatgptPoll(intervalSec) {
    try {
      const { data } = await App.apiJson('/chatgpt/login/poll', { method: 'POST' });
      if (data.result === 'pending') { this._chatgptSchedulePoll(intervalSec); return; }
      this._chatgptHideLogin();
      if (data.result === 'connected') {
        App.notify('ChatGPT подключён', 'success');
        this._chatgptRender(data);
      } else if (data.result === 'expired') {
        App.notify('Код истёк — начните вход заново', 'error');
      }
    } catch {
      // Сбой сети или OpenAI — пробуем дальше, пока код жив.
      this._chatgptSchedulePoll(intervalSec);
    }
  },

  async chatgptLogin() {
    try {
      const { data } = await App.apiJson('/chatgpt/login', { method: 'POST' });
      this._chatgptShowLogin(data.pending_login);
    } catch (e) {
      App.notify('Не удалось начать вход: ' + e.message, 'error');
    }
  },

  async chatgptCancel() {
    this._chatgptHideLogin();
    try { await App.apiJson('/chatgpt/login', { method: 'DELETE' }); } catch { /* код и так истечёт */ }
  },

  async chatgptDisconnect() {
    if (!confirm('Отключить ChatGPT? Пока не войдёте снова, накладные будут ждать.')) return;
    try {
      await App.apiJson('/chatgpt', { method: 'DELETE' });
      App.notify('ChatGPT отключён', 'success');
      this.chatgptRefresh();
    } catch (e) {
      App.notify('Ошибка: ' + e.message, 'error');
    }
  },

  async chatgptTest() {
    const btn = document.getElementById('chatgpt-test-btn');
    btn.disabled = true;
    try {
      const model = document.getElementById('settings-gpt-model')?.value;
      const { data } = await App.apiJson('/chatgpt/test', { method: 'POST', body: { model } });
      if (data.ok) App.notify(`Связь есть: ${data.model}, ответ за ${(data.latencyMs / 1000).toFixed(1)} с`, 'success');
      else App.notify('Проверка не прошла: ' + data.error, 'error');
      this.chatgptRefresh();
    } catch (e) {
      App.notify('Ошибка: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  },

  // ── Эталонные накладные (п.17 v2) ─────────────────────────────────────────
  // Только админ: GET /api/golden/runs отдаёт 403 остальным — тогда карточку не
  // рисуем (как «Команда и роли»). Прогон идёт на сервере в фоне; пока он идёт,
  // таблица сама обновляется раз в 20 секунд.
  _goldenPollTimer: null,
  _goldenShownRun: null,

  async _renderGolden() {
    const host = document.getElementById('settings-golden');
    if (!host) return;
    let payload;
    try {
      const res = await App.api('/golden/runs');
      if (!res.ok) { host.innerHTML = ''; return; }
      payload = await res.json();
    } catch (e) {
      host.innerHTML = '';
      return;
    }
    host.innerHTML = `
      <div class="card" style="margin-top:24px">
        <h3 style="margin-bottom:6px">Эталонные накладные</h3>
        <div class="field-hint" style="margin-bottom:16px">Прогон заново распознаёт проверенные накладные («☆ В эталоны») и показывает, что не совпало. В сами накладные ничего не пишется.</div>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px">
          <button type="button" class="btn btn-primary" id="golden-run-btn">Прогнать эталоны</button>
          <label style="display:flex;gap:6px;align-items:center;margin:0;font-weight:400">не больше
            <input type="number" id="golden-run-limit" min="1" max="50" value="10" style="width:76px"> накладных</label>
          <button type="button" class="btn btn-outline btn-sm" id="golden-refresh-btn">Обновить</button>
          <span class="field-hint" id="golden-count"></span>
        </div>
        <div id="golden-runs"></div>
        <div id="golden-run-detail" style="margin-top:18px"></div>
      </div>`;
    document.getElementById('golden-run-btn').addEventListener('click', (ev) => Settings._goldenStart(ev.currentTarget));
    document.getElementById('golden-refresh-btn').addEventListener('click', () => Settings._goldenRefresh());
    this._goldenRenderRuns(payload);
  },

  async _goldenStart(btn) {
    const input = document.getElementById('golden-run-limit');
    const limit = Math.max(1, Math.min(50, parseInt(input && input.value, 10) || 10));
    await App.withBusyButton(btn, async () => {
      try {
        const r = await App.apiJson('/golden/run', { method: 'POST', body: { limit } });
        App.notify(`Прогон №${r.run_id} запущен: накладных — ${r.invoice_count}. Результаты появятся ниже.`, 'success');
        this._goldenShownRun = r.run_id;
      } catch (e) {
        App.notify(e.message || 'Не удалось запустить прогон', 'error');
      }
    });
    await this._goldenRefresh();
  },

  async _goldenRefresh() {
    try {
      this._goldenRenderRuns(await App.apiJson('/golden/runs'));
    } catch (e) {
      console.error('Failed to refresh golden runs', e);
    }
  },

  _goldenPct(v) {
    return v == null ? '—' : `${Math.round(v * 1000) / 10}%`;
  },

  _goldenFieldLabel(key) {
    const labels = {
      invoice_number: 'номер', invoice_date: 'дата', total_sum: 'сумма', vat_sum: 'НДС', supplier_inn: 'ИНН',
      items_count: 'число строк', quantity: 'кол-во', unit: 'ед.', price: 'цена', total: 'сумма строки',
      'line.quantity': 'кол-во в строках', 'line.unit': 'ед. в строках', 'line.price': 'цена в строках', 'line.total': 'суммы строк',
    };
    return labels[key] || key;
  },

  _goldenRenderRuns(payload) {
    const host = document.getElementById('golden-runs');
    if (!host) return;
    const runs = (payload && payload.data) || [];
    const count = document.getElementById('golden-count');
    if (count) count.textContent = `Эталонов: ${(payload && payload.golden_count) || 0}`;
    const runBtn = document.getElementById('golden-run-btn');
    if (runBtn && !runBtn.classList.contains('is-busy')) runBtn.disabled = !!(payload && payload.active_run_id);

    host.innerHTML = runs.length
      ? `<div class="table-wrap"><table>
          <thead><tr><th>№</th><th>Запущен</th><th>Статус</th><th>Модель</th><th>Накладные</th><th>Шапка</th><th>Строки</th><th>Не совпало</th><th></th></tr></thead>
          <tbody>${runs.map(r => this._goldenRunRow(r)).join('')}</tbody>
        </table></div>`
      : '<div class="field-hint">Прогонов ещё не было.</div>';

    const running = runs.some(r => r.status === 'running');
    const shown = runs.find(r => r.id === this._goldenShownRun);
    if (shown) this._goldenShowRun(shown.id);

    clearTimeout(this._goldenPollTimer);
    this._goldenPollTimer = running ? setTimeout(() => this._goldenRefresh(), 20000) : null;
  },

  _goldenRunRow(r) {
    const s = r.summary || {};
    const status = r.status === 'running'
      ? `<span class="badge badge-processing">идёт: ${Number(s.processed) || 0} из ${Number(s.planned) || 0}</span>`
      : r.status === 'done'
        ? '<span class="badge badge-sent">готово</span>'
        : `<span class="badge badge-error" title="${App.esc(s.error || '')}">ошибка</span>`;
    const parts = [`сравнено ${Number(s.compared) || 0}`];
    if (s.skipped) parts.push(`пропущено ${Number(s.skipped)}`);
    if (s.errors) parts.push(`с ошибкой ${Number(s.errors)}`);
    const header = s.header_total ? `${s.header_ok}/${s.header_total} · ${this._goldenPct(s.header_accuracy)}` : '—';
    const items = s.items_total ? `${s.items_ok}/${s.items_total} · ${this._goldenPct(s.items_accuracy)}` : '—';
    const failures = Object.entries(s.field_failures || {})
      .map(([k, n]) => `${this._goldenFieldLabel(k)} ×${n}`).join(', ');
    return `<tr>
      <td>${Number(r.id)}</td>
      <td>${App.esc(App.formatDateTime(r.started_at))}</td>
      <td>${status}</td>
      <td>${App.esc(r.model || '—')}</td>
      <td>${App.esc(parts.join(', '))}</td>
      <td style="white-space:nowrap">${App.esc(header)}</td>
      <td style="white-space:nowrap">${App.esc(items)}</td>
      <td>${App.esc(failures || (s.compared ? 'всё совпало' : '—'))}</td>
      <td><button type="button" class="btn btn-outline btn-sm" onclick="Settings._goldenShowRun(${Number(r.id)})">Подробнее</button></td>
    </tr>`;
  },

  async _goldenShowRun(id) {
    const host = document.getElementById('golden-run-detail');
    if (!host) return;
    this._goldenShownRun = Number(id);
    let run;
    try {
      ({ data: run } = await App.apiJson(`/golden/runs/${Number(id)}`));
    } catch (e) {
      host.innerHTML = `<div class="field-hint">${App.esc(e.message || 'Не удалось загрузить прогон')}</div>`;
      return;
    }
    if (this._goldenShownRun !== Number(id)) return; // пока грузили, открыли другой прогон
    const s = run.summary || {};
    const results = Array.isArray(run.results) ? run.results : [];
    const took = run.finished_at ? `, ${App.formatDuration(run.started_at, run.finished_at)}` : '';
    host.innerHTML = `
      <h4 style="margin:0 0 8px">Прогон №${Number(run.id)} · ${App.esc(run.model || '')} · ${App.esc(App.formatDateTime(run.started_at))}${App.esc(took)}</h4>
      ${s.error ? `<div class="field-hint" style="color:#991b1b;margin-bottom:8px">${App.esc(s.error)}</div>` : ''}
      ${results.length
        ? `<div class="table-wrap"><table>
            <thead><tr><th>Накладная</th><th>Итог</th><th>Шапка</th><th>Строки</th><th>Что не совпало (эталон → распознано)</th></tr></thead>
            <tbody>${results.map(r => this._goldenResultRow(r)).join('')}</tbody>
          </table></div>`
        : '<div class="field-hint">Результатов пока нет.</div>'}`;
  },

  _goldenResultRow(r) {
    const id = Number(r.invoice_id);
    const title = `<a href="#/invoices/${id}">#${id}</a>${r.invoice_number ? ' №' + App.esc(r.invoice_number) : ''}`
      + (r.supplier ? `<div class="muted">${App.esc(r.supplier)}</div>` : '');
    const skipReasons = {
      multipage: 'многостраничная — пока не перепроверяется',
      no_photo: 'фото не найдено на диске',
      not_found: 'накладная удалена',
      xml: 'документ из XML — распознавания нет',
    };
    if (r.status === 'skipped') {
      return `<tr><td>${title}</td><td><span class="badge badge-new">пропущена</span></td><td>—</td><td>—</td><td>${App.esc(skipReasons[r.reason] || r.reason || '')}</td></tr>`;
    }
    if (r.status === 'error' || !r.compare) {
      return `<tr><td>${title}</td><td><span class="badge badge-error">ошибка</span></td><td>—</td><td>—</td><td>${App.esc(r.error || '')}</td></tr>`;
    }
    const c = r.compare;
    const cs = c.summary || {};
    const verdict = r.status === 'ok'
      ? '<span class="badge badge-sent">совпало</span>'
      : '<span class="badge badge-error">расхождения</span>';
    return `<tr>
      <td>${title}</td>
      <td>${verdict}</td>
      <td style="white-space:nowrap">${Number(cs.header_ok) || 0}/${Number(cs.header_total) || 0}</td>
      <td style="white-space:nowrap">${Number(cs.items_ok) || 0}/${Number(cs.items_total) || 0}</td>
      <td>${this._goldenDiffHtml(c)}</td>
    </tr>`;
  },

  _goldenDiffHtml(c) {
    const v = (x) => (x == null || x === '' ? '∅' : String(x));
    const out = [];
    for (const h of c.header || []) {
      if (!h.ok) out.push(`<div><strong>${App.esc(this._goldenFieldLabel(h.field))}</strong>: ${App.esc(v(h.expected))} → ${App.esc(v(h.actual))}</div>`);
    }
    if (c.items_count && !c.items_count.ok) {
      out.push(`<div><strong>число строк</strong>: ${App.esc(v(c.items_count.expected))} → ${App.esc(v(c.items_count.actual))}</div>`);
    }
    const bad = (c.items || []).filter(l => !l.ok);
    for (const l of bad.slice(0, 5)) {
      const what = l.missing === 'actual' ? 'модель не нашла строку'
        : l.missing === 'expected' ? 'лишняя строка'
          : (l.fields || []).filter(f => !f.ok)
            .map(f => `${this._goldenFieldLabel(f.field)} ${v(f.expected)} → ${v(f.actual)}`).join('; ');
      out.push(`<div class="muted">строка ${Number(l.line)}: ${App.esc(what)}</div>`);
    }
    if (bad.length > 5) out.push(`<div class="muted">…и ещё строк: ${bad.length - 5}</div>`);
    return out.join('') || 'всё совпало';
  }
};
