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
        if (data.claude_model) {
          document.getElementById('settings-claude-model').value = data.claude_model;
        }
        const llmCb = document.getElementById('settings-llm-mapper');
        if (llmCb) llmCb.checked = !!data.llm_mapper_enabled;
      }
      this.loaded = true;
    } catch (e) {
      console.error('Failed to load settings', e);
    }

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

    try {
      const res = await App.api('/settings/analyzer', { method: 'PUT', body });
      if (res.ok) {
        App.notify('Настройки сохранены', 'success');
        document.getElementById('api-key-status').textContent = 'API-ключ сохранён';
        apiKeyInput.value = '';
      } else {
        const data = await res.json();
        App.notify(data.error || 'Ошибка сохранения', 'error');
      }
    } catch (e) {
      App.notify('Ошибка: ' + e.message, 'error');
    }
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
