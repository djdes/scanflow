/* global App, Settings */
const Settings = {
  loaded: false,

  async load() {
    if (this.loaded) return;
    try {
      const { data } = await App.apiJson('/settings/analyzer');
      if (data) {
        const modeRadio = document.querySelector(`input[name="analyzer-mode"][value="${data.mode}"]`);
        if (modeRadio) modeRadio.checked = true;
        if (data.has_api_key) {
          document.getElementById('api-key-status').textContent = 'API-ключ сохранён';
          document.getElementById('api-key-status').style.color = 'var(--green)';
        }
        // Prefill key fields so the admin can view/verify what is stored
        // (kept type=password; the «Показать» button reveals them).
        const apiInput = document.getElementById('settings-api-key');
        if (apiInput && data.anthropic_api_key) apiInput.value = data.anthropic_api_key;
        const dadataInput0 = document.getElementById('settings-dadata-key');
        if (dadataInput0 && data.dadata_api_key) dadataInput0.value = data.dadata_api_key;
        const pfTokenInput0 = document.getElementById('settings-pf-token');
        if (pfTokenInput0 && data.projectsflow_token) pfTokenInput0.value = data.projectsflow_token;
        const pfStatus = document.getElementById('pf-token-status');
        if (pfStatus) {
          pfStatus.textContent = data.has_projectsflow_token ? 'PF-токен сохранён' : 'PF-токен не задан';
          pfStatus.style.color = data.has_projectsflow_token ? 'var(--green)' : 'var(--text-muted, #888)';
        }
        const pfProjectInput = document.getElementById('settings-pf-project-id');
        if (pfProjectInput && data.projectsflow_project_id) {
          pfProjectInput.value = data.projectsflow_project_id;
        }
        if (data.claude_model) {
          document.getElementById('settings-claude-model').value = data.claude_model;
        }
        const llmCb = document.getElementById('settings-llm-mapper');
        if (llmCb) llmCb.checked = !!data.llm_mapper_enabled;
        const dadataStatus = document.getElementById('dadata-key-status');
        if (dadataStatus) {
          dadataStatus.textContent = data.has_dadata_key ? 'DaData-ключ сохранён' : 'DaData-ключ не задан';
          dadataStatus.style.color = data.has_dadata_key ? 'var(--green)' : 'var(--text-muted, #888)';
        }
        Settings._refreshModeVisibility();
      }
      this.loaded = true;
    } catch (e) {
      console.error('Failed to load settings', e);
    }

    // Mode radio change → toggle conditional sections
    document.querySelectorAll('input[name="analyzer-mode"]').forEach(r => {
      r.addEventListener('change', () => Settings._refreshModeVisibility());
    });

    // Auto-send toggles — обе берутся из analyzer_config
    try {
      const { data } = await App.apiJson('/settings/analyzer');
      if (data) {
        const cb1c = document.getElementById('settings-auto-send-1c');
        const lbl1c = document.getElementById('settings-auto-send-1c-text');
        const cbSber = document.getElementById('settings-auto-send-sber');
        const lblSber = document.getElementById('settings-auto-send-sber-text');
        if (cb1c) {
          cb1c.checked = !!data.auto_send_1c;
          lbl1c.textContent = cb1c.checked ? 'Включена' : 'Выключена';
          cb1c.addEventListener('change', () => {
            lbl1c.textContent = cb1c.checked ? 'Включена' : 'Выключена';
          });
        }
        if (cbSber) {
          cbSber.checked = !!data.auto_send_sber;
          lblSber.textContent = cbSber.checked ? 'Включена' : 'Выключена';
          cbSber.addEventListener('change', () => {
            lblSber.textContent = cbSber.checked ? 'Включена' : 'Выключена';
          });
        }
      }
    } catch (e) {
      console.error('Failed to load auto-send settings', e);
    }

    this._renderUsers();
    this._renderEngineFlags();
    this._renderGolden();
  },

  // «Движки v2»: каждый переключатель мгновенно сохраняется. Выключенный
  // движок = прежнее поведение (рычаг отката без деплоя). PUT закрыт
  // requireAdmin — у остальных переключатели только для чтения.
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
      <div class="card" style="margin-top:24px">
        <h3 style="margin-bottom:6px">Движки v2</h3>
        <div class="field-hint" style="margin-bottom:16px">Выключенный движок работает по-старому. Если после обновления что-то считается не так — выключите нужный пункт, изменения применятся к следующим накладным в течение 30 секунд.</div>
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
        ${isAdmin ? '' : '<div class="field-hint">Менять может только администратор.</div>'}
      </div>`;
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
          <p class="field-hint" style="margin-bottom:16px">Администраторы видят все накладные и управляют интеграциями (Сбер, 1С, настройки, диагностика). Обычные пользователи видят только свои накладные, когда включена изоляция данных.</p>
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

  async save() {
    const mode = document.querySelector('input[name="analyzer-mode"]:checked')?.value || 'claude_api';
    const claudeModel = document.getElementById('settings-claude-model').value;
    const llmCb = document.getElementById('settings-llm-mapper');
    const body = {
      mode,
      claude_model: claudeModel,
      llm_mapper_enabled: llmCb ? llmCb.checked : true,
    };
    const apiKeyInput = document.getElementById('settings-api-key');
    if (apiKeyInput.value.trim()) {
      body.anthropic_api_key = apiKeyInput.value.trim();
    }
    const pfTokenInput = document.getElementById('settings-pf-token');
    if (pfTokenInput && pfTokenInput.value.trim()) {
      body.projectsflow_token = pfTokenInput.value.trim();
    }
    const pfProjectInput = document.getElementById('settings-pf-project-id');
    if (pfProjectInput && pfProjectInput.value.trim()) {
      body.projectsflow_project_id = pfProjectInput.value.trim();
    }
    const dadataInput = document.getElementById('settings-dadata-key');
    if (dadataInput && dadataInput.value.trim()) {
      body.dadata_api_key = dadataInput.value.trim();
    }

    try {
      const res = await App.api('/settings/analyzer', { method: 'PUT', body });
      if (res.ok) {
        App.notify('Настройки сохранены', 'success');
        if (dadataInput && dadataInput.value.trim()) {
          const ds = document.getElementById('dadata-key-status');
          if (ds) { ds.textContent = 'DaData-ключ сохранён'; ds.style.color = 'var(--green)'; }
          // Keep the value in the field so it stays viewable for verification.
        }
        if (apiKeyInput.value.trim()) {
          document.getElementById('api-key-status').textContent = 'API-ключ сохранён';
          // Keep the value in the field so it stays viewable for verification.
        }
        if (pfTokenInput && pfTokenInput.value.trim()) {
          const status = document.getElementById('pf-token-status');
          if (status) {
            status.textContent = 'PF-токен сохранён';
            status.style.color = 'var(--green)';
          }
          // Don't clear pf-token input — user wants to see what they saved.
        }
      } else {
        const data = await res.json();
        App.notify(data.error || 'Ошибка сохранения', 'error');
      }
    } catch (e) {
      App.notify('Ошибка: ' + e.message, 'error');
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

  // Show/hide API-key block (only for claude_api), PF-token block (only for dispatcher),
  // and Claude model dropdown (irrelevant in dispatcher — model is decided by the
  // Claude Code session running the dispatcher, not by ScanFlow config).
  _refreshModeVisibility() {
    const mode = document.querySelector('input[name="analyzer-mode"]:checked')?.value || 'claude_api';
    const apiGroup = document.getElementById('api-key-group');
    const pfGroup = document.getElementById('pf-token-group');
    if (apiGroup) apiGroup.style.display = (mode === 'dispatcher') ? 'none' : '';
    if (pfGroup)  pfGroup.style.display  = (mode === 'dispatcher') ? '' : 'none';
    const pfProjectGroup = document.getElementById('pf-project-group');
    if (pfProjectGroup) pfProjectGroup.style.display = (mode === 'dispatcher') ? '' : 'none';
    const modelGroup = document.getElementById('settings-claude-model')?.closest('.form-group');
    if (modelGroup) modelGroup.style.display = (mode === 'dispatcher') ? 'none' : '';
  },

  async saveAutoSend() {
    const cb1c = document.getElementById('settings-auto-send-1c');
    const cbSber = document.getElementById('settings-auto-send-sber');
    try {
      // Подтянем текущие mode и claude_model — PUT валидирует mode, поэтому
      // в payload их нужно пробросить чтобы не сломать конфигурацию.
      const { data: current } = await App.apiJson('/settings/analyzer');
      const body = {
        mode: current?.mode || 'claude_api',
        claude_model: current?.claude_model || 'claude-sonnet-5',
        llm_mapper_enabled: !!current?.llm_mapper_enabled,
        auto_send_1c: !!(cb1c && cb1c.checked),
        auto_send_sber: !!(cbSber && cbSber.checked),
      };
      const res = await App.api('/settings/analyzer', { method: 'PUT', body });
      if (res.ok) {
        App.notify('Настройки автоотправки сохранены', 'success');
      } else {
        const err = await res.json().catch(() => ({}));
        App.notify(err.error || 'Ошибка сохранения', 'error');
      }
    } catch (e) {
      App.notify('Ошибка: ' + e.message, 'error');
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
        <div class="field-hint" style="margin-bottom:16px">Эталон — проверенная накладная, отмеченная кнопкой «☆ В эталоны» на её странице. Прогон заново распознаёт фото эталонов текущей моделью (в сами накладные ничего не записывается) и сравнивает номер, дату, сумму, НДС, ИНН поставщика и строки. Так после обновления видно, не стало ли распознавание хуже. Каждая накладная — отдельный запрос к Claude на 1–3 минуты; многостраничные пока пропускаются.</div>
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
