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
      }
      this.loaded = true;
    } catch (e) {
      console.error('Failed to load settings', e);
    }

    // Load auto-send setting from webhook config
    try {
      const { data } = await App.apiJson('/webhook/config');
      const cb = document.getElementById('settings-auto-send');
      const label = document.getElementById('settings-auto-send-text');
      if (data) {
        cb.checked = !!data.auto_send_1c;
        label.textContent = cb.checked ? 'Включена' : 'Выключена';
      }
      cb.addEventListener('change', () => {
        label.textContent = cb.checked ? 'Включена' : 'Выключена';
      });
    } catch (e) {
      console.error('Failed to load auto-send setting', e);
    }
  },

  async save() {
    const mode = document.querySelector('input[name="analyzer-mode"]:checked')?.value || 'claude_api';
    const claudeModel = document.getElementById('settings-claude-model').value;
    const body = { mode, claude_model: claudeModel };
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
    const cb = document.getElementById('settings-auto-send');
    try {
      const { data: current } = await App.apiJson('/webhook/config');
      const body = {
        url: current?.url || '',
        enabled: current?.enabled || 0,
        auth_token: current?.auth_token || '',
        auto_send_1c: cb.checked ? 1 : 0,
      };
      const res = await App.api('/webhook/config', { method: 'PUT', body });
      if (res.ok) {
        App.notify(cb.checked ? 'Автоотправка включена' : 'Автоотправка выключена', 'success');
      } else {
        App.notify('Ошибка сохранения', 'error');
      }
    } catch (e) {
      App.notify('Ошибка: ' + e.message, 'error');
    }
  }
};
