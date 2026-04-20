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
    // Reject non-http(s) URLs (javascript:, data:, file:) before the server sees them.
    try {
      const parsed = new URL(body.url);
      if (!/^https?:$/.test(parsed.protocol)) {
        App.notify('URL должен начинаться с http:// или https://', 'error');
        return;
      }
    } catch {
      App.notify('Некорректный URL', 'error');
      return;
    }

    if (this._saving) return;
    this._saving = true;
    try {
      const res = await App.api('/webhook/config', { method: 'PUT', body });
      if (res.ok) {
        App.notify('Настройки сохранены', 'success');
      } else {
        let msg = 'Ошибка сохранения';
        try { const data = await res.json(); if (data && data.error) msg = data.error; } catch {}
        App.notify(msg, 'error');
      }
    } catch (e) {
      App.notify('Ошибка: ' + (e && e.message || 'запрос не удался'), 'error');
    } finally {
      this._saving = false;
    }
  },

  async test() {
    const resultDiv = document.getElementById('wh-test-result');
    if (this._testing) return;
    this._testing = true;
    resultDiv.innerHTML = '<span style="color:var(--grey)">Отправка тестового запроса...</span>';

    try {
      const res = await App.api('/webhook/test', { method: 'POST' });
      let data = {};
      try { data = await res.json(); } catch {}
      if (res.ok && data.success) {
        resultDiv.innerHTML = `
          <div class="card" style="background:#f0fdf4;border-color:#bbf7d0">
            <strong>Успешно!</strong> HTTP ${App.esc(data.status)} ${App.esc(data.statusText)}
          </div>`;
      } else {
        const msg = data.error || `HTTP ${data.status || '?'} ${data.statusText || ''}`;
        resultDiv.innerHTML = `
          <div class="card" style="background:#fef2f2;border-color:#fecaca">
            <strong>Ошибка!</strong> ${App.esc(msg)}
          </div>`;
      }
    } catch (e) {
      resultDiv.innerHTML = `
        <div class="card" style="background:#fef2f2;border-color:#fecaca">
          <strong>Ошибка!</strong> ${App.esc(e && e.message || 'запрос не удался')}
        </div>`;
    } finally {
      this._testing = false;
    }
  }
};
