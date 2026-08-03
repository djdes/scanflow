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

      const emailEl = document.getElementById('profile-email');
      if (emailEl) emailEl.value = data.email || '';

      // Чаты живут отдельным списком, а инпут — только поле ввода нового.
      this._chatIds = this.parseIds(data.telegram_chat_id);
      document.getElementById('profile-tg-chat').value = '';
      this.renderChatChips();

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
      this.loadOnecStatus();
    },

    collect() {
      // Источник правды — список чипсов, а НЕ содержимое инпута: там лежит
      // недобавленный черновик, и молча сохранять его нельзя.
      const chat = (this._chatIds || []).join(',') || null;
      const tokenInputValue = document.getElementById('profile-tg-token').value;
      // Don't overwrite the token on server if user didn't change the placeholder
      const sendToken = tokenInputValue !== TOKEN_PLACEHOLDER;

      const events = Array.from(
        document.querySelectorAll('input[type=checkbox][data-event]:checked'),
      ).map(cb => cb.dataset.event);

      const emailVal = (document.getElementById('profile-email')?.value || '').trim();
      const body = { telegram_chat_id: chat, notify_events: events, email: emailVal || null };
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

    // ── Чаты как пузыри ───────────────────────────────────────────────────
    // Список добавленных chat_id. Инпут держит только новый, ещё не добавленный
    // идентификатор — поэтому сохраняем всегда отсюда, а не из поля ввода.
    _chatIds: [],

    // Правило то же, что на сервере (notifications/telegram/chatIds.ts):
    // у групп id отрицательный, всё остальное — целое число.
    isValidId(v) { return /^-?\d{1,32}$/.test(v); },

    parseIds(raw) {
      if (!raw) return [];
      const parts = String(raw).split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
      return [...new Set(parts)];
    },

    renderChatChips() {
      const box = document.getElementById('profile-tg-chips');
      if (!box) return;
      const ids = this._chatIds || [];
      if (ids.length === 0) {
        box.innerHTML = '<span class="chip-empty">Чаты не добавлены — уведомления никуда не уйдут</span>';
        return;
      }
      box.innerHTML = ids.map(id => `
        <span class="chip" data-id="${App.esc(id)}">
          <button type="button" class="chip-label" title="Изменить"
                  onclick="Profile.editChatId('${App.esc(id)}')">${App.esc(id)}</button>
          <button type="button" class="chip-remove" title="Удалить"
                  aria-label="Удалить чат ${App.esc(id)}"
                  onclick="Profile.removeChatId('${App.esc(id)}')">✕</button>
        </span>`).join('');
    },

    // Enter в поле — добавить. Вставку списка тоже поддерживаем: человек может
    // скопировать «111, 222» разом, и дробить это на два ввода незачем.
    onChatIdKey(ev) {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      this.addChatIdFromInput();
    },

    addChatIdFromInput() {
      const el = document.getElementById('profile-tg-chat');
      if (!el) return;
      const parsed = this.parseIds(el.value);
      if (parsed.length === 0) return;

      const bad = parsed.filter(v => !this.isValidId(v));
      if (bad.length) {
        App.notify(`Не похоже на chat_id: ${bad.slice(0, 3).join(', ')}`, 'error');
        return;
      }
      const dupes = parsed.filter(v => this._chatIds.includes(v));
      const fresh = parsed.filter(v => !this._chatIds.includes(v));
      if (fresh.length === 0) {
        App.notify(`Этот чат уже добавлен: ${dupes[0]}`, 'info');
        return;
      }
      this._chatIds = [...this._chatIds, ...fresh];
      el.value = '';
      this.renderChatChips();
      App.notify(fresh.length === 1 ? `Чат ${fresh[0]} добавлен` : `Добавлено чатов: ${fresh.length}`, 'success');
      this.saveChatIds();
    },

    // Редактирование = вернуть значение в поле ввода. Отдельный inline-редактор
    // здесь избыточен: id короткий, проще перенабрать и нажать Enter.
    editChatId(id) {
      const el = document.getElementById('profile-tg-chat');
      this._chatIds = this._chatIds.filter(x => x !== id);
      this.renderChatChips();
      if (el) { el.value = id; el.focus(); el.select(); }
      this.saveChatIds();
    },

    removeChatId(id) {
      this._chatIds = this._chatIds.filter(x => x !== id);
      this.renderChatChips();
      App.notify(`Чат ${id} удалён`, 'info');
      this.saveChatIds();
    },

    // Пишем сразу, не дожидаясь общей кнопки «Сохранить»: пузырь на экране
    // должен означать «уже настроено», иначе человек уйдёт со страницы,
    // будучи уверенным, что чат добавлен. PATCH частичный — трогаем только
    // список чатов, токен и события не задеваются.
    async saveChatIds() {
      try {
        await App.apiJson('/profile', {
          method: 'PATCH',
          body: { telegram_chat_id: this._chatIds.join(',') || null },
        });
      } catch (err) {
        App.notify('Не удалось сохранить список чатов: ' + (err.message || err), 'error');
      }
    },

    async test() {
      this.setStatus('Отправляем тестовое сообщение…', 'muted');
      const box = document.getElementById('profile-tg-test-results');
      if (box) { box.hidden = true; box.innerHTML = ''; }
      try {
        const { data } = await App.apiJson('/profile/test-telegram', { method: 'POST' });
        this._renderTestResults(data);
        this.setStatus(
          data && data.sent === data.total
            ? 'Тестовое сообщение отправлено — проверьте Telegram'
            : `Отправлено в ${data.sent} из ${data.total} — смотрите список ниже`,
          data && data.sent === data.total ? 'success' : 'error',
        );
      } catch (err) {
        // При полном провале сервер отвечает 500, но тело с разбивкой по чатам
        // всё равно приходит — показываем его, иначе непонятно, какой чат виноват.
        this._renderTestResults(err?.data);
        this.setStatus('Не удалось: ' + (err.message || err), 'error');
      }
    },

    // Построчный итог: при нескольких получателях общий «ошибка» бесполезен —
    // надо видеть, какой именно чат не принял сообщение и почему.
    _renderTestResults(data) {
      const box = document.getElementById('profile-tg-test-results');
      if (!box || !data || !Array.isArray(data.results)) return;
      box.hidden = false;
      box.innerHTML = data.results.map(r => r.ok
        ? `<div class="tg-test-ok">✓ ${App.esc(r.chat_id)}</div>`
        : `<div class="tg-test-fail">✗ ${App.esc(r.chat_id)} — ${App.esc(r.error || 'ошибка')}</div>`
      ).join('');
    },

    async loadOnecStatus() {
      const el = document.getElementById('profile-onec-status');
      if (!el) return;
      try {
        const { data } = await App.apiJson('/onec/pairing-status');
        el.innerHTML = '';
        if (data.connected) {
          el.className = 'onec-conn-status onec-conn-status--on';
          const strong = document.createElement('strong');
          strong.textContent = '✓ База 1С подключена';
          el.appendChild(strong);
          const last = (data.connections[0] || {}).last_used_at;
          if (last) {
            const small = document.createElement('small');
            small.textContent = ' · последняя активность ' + last;
            el.appendChild(small);
          }
        } else {
          el.className = 'onec-conn-status onec-conn-status--off';
          el.textContent = 'База 1С пока не подключена';
        }
      } catch (err) {
        el.innerHTML = '';
        el.className = 'onec-conn-status';
      }
    },

    async generateOnecCode() {
      const btn = document.getElementById('profile-onec-btn');
      const box = document.getElementById('profile-onec-code');
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Создаём…';
      try {
        const { data } = await App.apiJson('/onec/pairing-code', { method: 'POST', body: { base_name: '' } });
        // Build via DOM so the server value is text content, not HTML.
        box.innerHTML = '';
        const label = document.createElement('span');
        label.textContent = 'Код подключения (действует ~15 мин):';
        const code = document.createElement('code');
        code.textContent = data.code;
        box.appendChild(label);
        box.appendChild(code);
        box.hidden = false;
      } catch (err) {
        this.setStatus('Не удалось создать код: ' + (err.message || err), 'error');
        setTimeout(() => this.setStatus('', ''), 3000);
      } finally {
        btn.disabled = false;
        btn.textContent = original;
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
        // Найденный chat_id кладём прямо в поле ввода: дальше пользователю
        // остаётся нажать Enter, а не искать его в переписке с ботом.
        const found = r.data.chat_id;
        if (found && this.isValidId(String(found))) {
          const el = document.getElementById('profile-tg-chat');
          if (el) { el.value = String(found); el.focus(); }
        }
        if (r.data.confirmation_sent) {
          hint.textContent = ` Бот написал вам в Telegram. ID подставлен в поле — нажмите Enter, чтобы добавить.`;
          hint.style.color = 'var(--success)';
        } else {
          // Fallback: server found the chat_id but couldn't DM it. Show it in the hint
          // since otherwise the user has no way to learn it.
          hint.textContent = ` Найдено: ${found}. Нажмите Enter в поле, чтобы добавить.`;
          hint.style.color = 'var(--warning)';
        }
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
      const onecBtn = document.getElementById('profile-onec-btn');
      if (onecBtn) onecBtn.addEventListener('click', () => this.generateOnecCode());
      this.load();
    },
  };

  window.Profile = Profile;
})();
