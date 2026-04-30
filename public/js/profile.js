(function () {
  const TOKEN_PLACEHOLDER = '••••••••';

  const Profile = {
    async load() {
      const r = await App.apiJson('/profile');
      const data = r.data || {};

      document.getElementById('profile-tg-chat').value = data.telegram_chat_id || '';

      const tokenSetOnServer = !!data.telegram_bot_token_set;
      const tokenEl = document.getElementById('profile-tg-token');
      tokenEl.value = tokenSetOnServer ? TOKEN_PLACEHOLDER : '';
      tokenEl.type = 'password';
      document.getElementById('profile-tg-token-toggle').textContent = 'Показать';

      const enabled = new Set(data.notify_events || []);
      document.querySelectorAll('input[type=checkbox][data-event]').forEach(cb => {
        cb.checked = enabled.has(cb.dataset.event);
      });
    },

    collect() {
      const chat = document.getElementById('profile-tg-chat').value.trim() || null;
      const tokenInputValue = document.getElementById('profile-tg-token').value;
      // Don't overwrite the token on server if user didn't change the placeholder
      const sendToken = tokenInputValue !== TOKEN_PLACEHOLDER;

      const events = Array.from(
        document.querySelectorAll('input[type=checkbox][data-event]:checked'),
      ).map(cb => cb.dataset.event);

      const body = { telegram_chat_id: chat, notify_events: events };
      if (sendToken) body.telegram_bot_token = tokenInputValue || null;
      return body;
    },

    async save() {
      const status = document.getElementById('profile-status');
      try {
        await App.apiJson('/profile', { method: 'PATCH', body: this.collect() });
        status.textContent = 'Сохранено';
        status.style.color = '#16a34a';
        // Re-load so token UI returns to placeholder
        await this.load();
      } catch (err) {
        status.textContent = 'Ошибка: ' + (err.message || err);
        status.style.color = '#b91c1c';
      }
      setTimeout(() => { status.textContent = ''; }, 3000);
    },

    async test() {
      const status = document.getElementById('profile-status');
      status.textContent = 'Отправляем тестовое сообщение…';
      status.style.color = '';
      try {
        await App.apiJson('/profile/test-telegram', { method: 'POST' });
        status.textContent = 'Тестовое сообщение отправлено — проверьте Telegram';
        status.style.color = '#16a34a';
      } catch (err) {
        status.textContent = 'Не удалось: ' + (err.message || err);
        status.style.color = '#b91c1c';
      }
    },

    toggleTokenVisibility() {
      const tokenEl = document.getElementById('profile-tg-token');
      const btn = document.getElementById('profile-tg-token-toggle');
      if (tokenEl.type === 'password') {
        tokenEl.type = 'text';
        btn.textContent = 'Скрыть';
      } else {
        tokenEl.type = 'password';
        btn.textContent = 'Показать';
      }
    },

    init() {
      if (this._wired) {
        this.load();
        return;
      }
      this._wired = true;
      document.getElementById('profile-save').addEventListener('click', () => this.save());
      document.getElementById('profile-test').addEventListener('click', () => this.test());
      document
        .getElementById('profile-tg-token-toggle')
        .addEventListener('click', () => this.toggleTokenVisibility());
      this.load();
    },
  };

  window.Profile = Profile;
})();
