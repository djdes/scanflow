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
        claude_model: current?.claude_model || 'claude-sonnet-4-6',
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
  }
};
