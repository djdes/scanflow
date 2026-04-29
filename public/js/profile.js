/* global App, Profile */
const Profile = {
  loaded: false,
  _statusTimer: null,
  _saving: false,
  _testing: false,

  async load() {
    try {
      const { data } = await App.apiJson('/profile');
      if (data) {
        document.getElementById('profile-email').value = data.email || '';

        const mode = data.notify_mode || 'digest_hourly';
        const modeRadio = document.querySelector(`input[name="profile-notify-mode"][value="${mode}"]`);
        if (modeRadio) modeRadio.checked = true;

        const events = Array.isArray(data.notify_events) ? data.notify_events : [];
        document.querySelectorAll('input[type="checkbox"][data-event]').forEach(cb => {
          cb.checked = events.includes(cb.dataset.event);
        });

        const hint = document.getElementById('smtp-hint');
        if (hint) {
          hint.textContent = data.smtp_configured === false ? '⚠ SMTP не настроен на сервере' : '';
        }
      }
      this.loaded = true;
    } catch (e) {
      console.error('Failed to load profile', e);
      App.notify('Не удалось загрузить профиль', 'error');
    }
  },

  collect() {
    const emailRaw = document.getElementById('profile-email').value.trim();
    const mode = document.querySelector('input[name="profile-notify-mode"]:checked')?.value || 'digest_hourly';
    const events = Array.from(document.querySelectorAll('input[type="checkbox"][data-event]:checked'))
      .map(cb => cb.dataset.event);
    return {
      email: emailRaw === '' ? null : emailRaw,
      notify_mode: mode,
      notify_events: events,
    };
  },

  _setStatus(text, kind) {
    const el = document.getElementById('profile-status');
    if (!el) return;
    el.textContent = text;
    el.style.color = kind === 'error'
      ? 'var(--error)'
      : kind === 'success'
        ? 'var(--success)'
        : 'var(--text-secondary)';
    if (this._statusTimer) {
      clearTimeout(this._statusTimer);
      this._statusTimer = null;
    }
    if (kind === 'success') {
      this._statusTimer = setTimeout(() => {
        if (el.textContent === text) el.textContent = '';
      }, 3000);
    }
  },

  async save() {
    if (this._saving) return;
    this._saving = true;
    this._setStatus('Сохраняем…', 'info');
    try {
      const body = this.collect();
      const res = await App.api('/profile', { method: 'PATCH', body });
      if (res.ok) {
        this._setStatus('Сохранено', 'success');
      } else {
        let msg = `Ошибка сохранения (HTTP ${res.status})`;
        try { const data = await res.json(); if (data && data.error) msg = data.error; } catch {}
        this._setStatus(msg, 'error');
      }
    } catch (e) {
      this._setStatus('Ошибка: ' + (e && e.message || 'запрос не удался'), 'error');
    } finally {
      this._saving = false;
    }
  },

  async test() {
    if (this._testing) return;
    this._testing = true;
    this._setStatus('Отправляем тестовое письмо…', 'info');
    try {
      const res = await App.api('/profile/test-email', { method: 'POST' });
      if (res.ok) {
        this._setStatus('Тестовое письмо отправлено — проверьте почту', 'success');
      } else {
        let msg = `HTTP ${res.status}`;
        try { const data = await res.json(); if (data && data.error) msg = data.error; } catch {}
        this._setStatus('Не удалось: ' + msg, 'error');
      }
    } catch (e) {
      this._setStatus('Не удалось: ' + (e && e.message || 'запрос не удался'), 'error');
    } finally {
      this._testing = false;
    }
  },

  init() {
    const saveBtn = document.getElementById('profile-save-btn');
    const testBtn = document.getElementById('profile-test-btn');
    if (saveBtn && !saveBtn._wired) {
      saveBtn.addEventListener('click', () => this.save());
      saveBtn._wired = true;
    }
    if (testBtn && !testBtn._wired) {
      testBtn.addEventListener('click', () => this.test());
      testBtn._wired = true;
    }
    this.load();
  },
};
