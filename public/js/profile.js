(function () {
  const TOKEN_PLACEHOLDER = '••••••••••••••••••••••••••••••';

  const ICON_EYE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
  const ICON_EYE_OFF = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/></svg>';

  function renderStatus(connected) {
    const el = document.getElementById('profile-tg-status');
    if (!el) return;
    const text = el.querySelector('.tg-status-text');
    if (connected) {
      el.classList.add('tg-status--online');
      el.classList.remove('tg-status--offline');
      if (text) text.textContent = 'подключён';
    } else {
      el.classList.remove('tg-status--online');
      el.classList.add('tg-status--offline');
      if (text) text.textContent = 'не подключён';
    }
  }

  const Profile = {
    async load() {
      const r = await App.apiJson('/profile');
      const data = r.data || {};

      document.getElementById('profile-tg-chat').value = data.telegram_chat_id || '';

      const tokenSetOnServer = !!data.telegram_bot_token_set;
      const tokenEl = document.getElementById('profile-tg-token');
      tokenEl.value = tokenSetOnServer ? TOKEN_PLACEHOLDER : '';
      tokenEl.type = 'password';
      const toggleBtn = document.getElementById('profile-tg-token-toggle');
      if (toggleBtn) {
        toggleBtn.innerHTML = ICON_EYE;
        toggleBtn.setAttribute('title', 'Показать');
      }

      const enabled = new Set(data.notify_events || []);
      document.querySelectorAll('input[type=checkbox][data-event]').forEach(cb => {
        cb.checked = enabled.has(cb.dataset.event);
      });

      renderStatus(!!data.telegram_chat_id && tokenSetOnServer);
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

    setStatus(text, kind) {
      const el = document.getElementById('profile-status');
      if (!el) return;
      el.textContent = text;
      el.style.color =
        kind === 'success' ? 'var(--success)' :
        kind === 'error'   ? 'var(--error)' :
        'var(--text-secondary)';
    },

    async save() {
      try {
        await App.apiJson('/profile', { method: 'PATCH', body: this.collect() });
        this.setStatus('Сохранено', 'success');
        // Re-load so token UI returns to placeholder
        await this.load();
      } catch (err) {
        this.setStatus('Ошибка: ' + (err.message || err), 'error');
      }
      setTimeout(() => this.setStatus('', ''), 3000);
    },

    async test() {
      this.setStatus('Отправляем тестовое сообщение…', 'muted');
      try {
        await App.apiJson('/profile/test-telegram', { method: 'POST' });
        this.setStatus('Тестовое сообщение отправлено — проверьте Telegram', 'success');
      } catch (err) {
        this.setStatus('Не удалось: ' + (err.message || err), 'error');
      }
    },

    toggleTokenVisibility() {
      const tokenEl = document.getElementById('profile-tg-token');
      const btn = document.getElementById('profile-tg-token-toggle');
      if (tokenEl.type === 'password') {
        tokenEl.type = 'text';
        btn.innerHTML = ICON_EYE_OFF;
        btn.setAttribute('title', 'Скрыть');
      } else {
        tokenEl.type = 'password';
        btn.innerHTML = ICON_EYE;
        btn.setAttribute('title', 'Показать');
      }
    },

    async lookupChatId() {
      const hint = document.getElementById('profile-tg-lookup-hint');
      const btn = document.getElementById('profile-tg-lookup');
      const tokenInputEl = document.getElementById('profile-tg-token');
      const tokenInput = tokenInputEl.value;
      const tokenChanged = tokenInput && tokenInput !== TOKEN_PLACEHOLDER;

      hint.innerHTML = '';
      hint.style.color = '';
      btn.disabled = true;
      btn.textContent = 'Ищем…';

      try {
        const body = tokenChanged ? { telegram_bot_token: tokenInput } : {};
        const r = await App.apiJson('/profile/lookup-telegram-chat-id', { method: 'POST', body });
        document.getElementById('profile-tg-chat').value = r.data.chat_id;
        const sentNote = r.data.confirmation_sent
          ? ' Проверьте Telegram и нажмите «Сохранить».'
          : ' Не удалось отправить подтверждение в Telegram, но Chat ID найден.';
        hint.textContent = ` Найдено: ${r.data.chat_id}.${sentNote}`;
        hint.style.color = 'var(--success)';
      } catch (err) {
        if (err.body && err.body.error === 'no_updates' && err.body.bot_username) {
          // Build DOM via createElement so bot_username is text content, not HTML.
          // Telegram bot usernames are constrained but this is defense-in-depth
          // (and matches how textContent is used elsewhere in the codebase).
          hint.textContent = ' Напишите боту ';
          const a = document.createElement('a');
          a.href = 'https://t.me/' + err.body.bot_username;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = '@' + err.body.bot_username;
          hint.appendChild(a);
          hint.appendChild(document.createTextNode(' команду '));
          const code = document.createElement('code');
          code.textContent = '/start';
          hint.appendChild(code);
          hint.appendChild(document.createTextNode(' и нажмите «Найти» снова.'));
          hint.style.color = 'var(--error)';
        } else {
          hint.textContent = ' ' + (err.message || 'Ошибка');
          hint.style.color = 'var(--error)';
        }
      } finally {
        btn.disabled = false;
        btn.textContent = 'Найти';
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
      document
        .getElementById('profile-tg-lookup')
        .addEventListener('click', () => this.lookupChatId());
      this.load();
    },
  };

  window.Profile = Profile;
})();
