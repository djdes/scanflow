/* global App, Webhook */
const Webhook = {
  loaded: false,

  async load() {
    if (this.loaded) return;
    try {
      const { data } = await App.apiJson('/webhook/config');
      if (data) {
        document.getElementById('wh-url').value = data.url || '';
        document.getElementById('wh-token').value = data.auth_token || '';
        document.getElementById('wh-enabled').checked = !!data.enabled;
        document.getElementById('wh-status-text').textContent = data.enabled ? 'Включён' : 'Выключен';
      }
      this.loaded = true;
    } catch (e) {
      console.error('Failed to load webhook config', e);
    }

    document.getElementById('wh-enabled').addEventListener('change', function () {
      document.getElementById('wh-status-text').textContent = this.checked ? 'Включён' : 'Выключен';
    });
  },

  async save() {
    const body = {
      url: document.getElementById('wh-url').value.trim(),
      enabled: document.getElementById('wh-enabled').checked,
      auth_token: document.getElementById('wh-token').value.trim() || null,
    };

    if (!body.url) {
      App.notify('Укажите URL вебхука', 'error');
      return;
    }

    try {
      const res = await App.api('/webhook/config', { method: 'PUT', body });
      if (res.ok) {
        App.notify('Настройки сохранены', 'success');
      } else {
        const data = await res.json();
        App.notify(data.error || 'Ошибка сохранения', 'error');
      }
    } catch (e) {
      App.notify('Ошибка: ' + e.message, 'error');
    }
  },

  async test() {
    const resultDiv = document.getElementById('wh-test-result');
    resultDiv.innerHTML = '<span style="color:var(--grey)">Отправка тестового запроса...</span>';

    try {
      const res = await App.api('/webhook/test', { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.success) {
        resultDiv.innerHTML = `
          <div class="card" style="background:#f0fdf4;border-color:#bbf7d0">
            <strong>Успешно!</strong> HTTP ${data.status} ${data.statusText}
          </div>`;
      } else {
        resultDiv.innerHTML = `
          <div class="card" style="background:#fef2f2;border-color:#fecaca">
            <strong>Ошибка!</strong> ${data.error || `HTTP ${data.status} ${data.statusText}`}
          </div>`;
      }
    } catch (e) {
      resultDiv.innerHTML = `
        <div class="card" style="background:#fef2f2;border-color:#fecaca">
          <strong>Ошибка!</strong> ${e.message}
        </div>`;
    }
  }
};
