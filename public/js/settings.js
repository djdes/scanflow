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
  }
};
