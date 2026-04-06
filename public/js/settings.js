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
        this.toggleApiKeyField(data.mode);
        if (data.has_api_key) {
          document.getElementById('api-key-status').textContent = 'API-ключ сохранён';
          document.getElementById('api-key-status').style.color = 'var(--green)';
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

    document.querySelectorAll('input[name="analyzer-mode"]').forEach(radio => {
      radio.addEventListener('change', () => this.toggleApiKeyField(radio.value));
    });
  },

  toggleApiKeyField(mode) {
    const apiKeyGroup = document.getElementById('api-key-group');
    apiKeyGroup.style.display = mode === 'claude_api' ? 'block' : 'none';
  },

  async save() {
    const mode = document.querySelector('input[name="analyzer-mode"]:checked')?.value;
    if (!mode) return;

    const body = { mode };
    const apiKeyInput = document.getElementById('settings-api-key');
    if (mode === 'claude_api' && apiKeyInput.value.trim()) {
      body.anthropic_api_key = apiKeyInput.value.trim();
    }

    try {
      const res = await App.api('/settings/analyzer', { method: 'PUT', body });
      if (res.ok) {
        App.notify('Настройки анализатора сохранены', 'success');
        document.getElementById('api-key-status').textContent = mode === 'claude_api' ? 'API-ключ сохранён' : '';
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
      // Read current webhook config, update only auto_send_1c
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
