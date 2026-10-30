/* global App */
'use strict';
const ProductAssistant = {
  // Safe Markdown subset: HTML and links never become active content.
  answerHtml(value) {
    return App.esc(String(value || '')).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  },
  learningText(value) {
    return ({ synced: 'Выбор сохранён в общей базе знаний', pending: 'Выбор сохранён помощником и ожидает синхронизации',
      known: 'Этот выбор уже есть в общей базе знаний', conflict: 'В базе есть другое решение. Проверьте сопоставление',
      rejected: 'Помощник отклонил выбор. Проверьте товар и отметки «Не это»', suggestion_only: 'Ответ получен; правило не сохранено' })[value] || 'Ответ получен';
  },
  async poll(accepted, { active = () => true, update = () => {}, scope = {}, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    let state = accepted;
    if (!/^[a-f0-9]{32}$/i.test(state.request_id || '')) throw new Error('Помощник не вернул номер запроса');
    const deadline = Date.now() + 360000;
    while (active()) {
      update(state);
      if (state.status === 'completed') return state;
      if (state.status === 'failed') { const error = new Error('Помощник не смог выполнить запрос. Отправьте его заново'); error.terminal = true; throw error; }
      if (!['queued', 'running'].includes(state.status)) throw new Error('Неизвестное состояние запроса помощника');
      if (Date.now() > deadline) throw new Error('Ответ пока не готов. Можно повторить проверку этого запроса');
      await delay(2000);
      if (!active()) return null;
      state = (await App.apiJson('/product-assistant/requests/' + accepted.request_id + '?' + new URLSearchParams(scope))).data;
    }
    return null;
  },
  mount(dialog, { invoiceId, itemId, originalName, queryInput, save }) {
    const host = dialog.querySelector('.nom-assistant');
    let enabled = false, disposed = false, sequence = 0, timer, sessionId, pending, candidates = [], saving = false;
    let chatBusy = false;
    const confirmationKeys = new Map();
    const active = () => !disposed && dialog.isConnected;
    const ready = App.apiJson('/product-assistant/config').then(({ data }) => {
      if (!active() || !data.enabled) return;
      enabled = true;
      host.hidden = false;
      host.innerHTML = `<div class="nom-assistant-head"><h3>${App.esc(data.label)}</h3><span>Похожие и привычные товары</span></div>
        <p class="field-hint">Поиск учитывает подтверждённые выборы и общую базу знаний вашей компании.</p>
        <p data-search-status role="status"></p><div data-products></div>
        <label class="nom-assistant-share"><input type="checkbox" data-share checked> Запоминать мой выбор в общей базе знаний помощника</label>
        <details><summary>Спросить помощника об этой строке</summary><div data-messages class="nom-assistant-messages" aria-live="polite"></div>
          <form data-chat><label for="nom-assistant-question">Вопрос о товаре или пересчёте количества</label><textarea id="nom-assistant-question" maxlength="8000" rows="2" placeholder="Какой товар выбрать и почему?"></textarea>
          <p class="field-hint">Помощнику передаются название, поставщик и количество из этой строки. Ответ — подсказка; выбор подтверждаете вы.</p>
          <button type="submit" class="btn btn-outline btn-sm">Спросить</button><button type="button" data-resume class="btn btn-outline btn-sm" hidden>Повторить проверку</button>
          <p data-chat-status role="status"></p></form></details>`;
      host.querySelector('[data-chat]').onsubmit = event => { event.preventDefault(); ask(); };
      host.querySelector('[data-resume]').onclick = () => ask(true);
      host.querySelector('[data-products]').onclick = event => {
        const button = event.target.closest('button[data-guid]');
        const row = candidates.find(p => p.onec_guid === button?.dataset.guid);
        if (row && !saving) save({ guid: row.onec_guid, name: row.name });
      };
      search();
    }).catch(() => { /* Optional integration must not block the local catalog. */ });
    const search = async () => {
      if (!enabled || !active()) return;
      const turn = ++sequence;
      const label = host.querySelector('[data-search-status]');
      const results = host.querySelector('[data-products]');
      const q = (queryInput.value.trim() || originalName).slice(0, 150);
      candidates = [];
      results.innerHTML = '';
      if (!q) { label.textContent = 'Введите название товара'; return; }
      label.textContent = 'Ищем в базе знаний…';
      try {
        const params = new URLSearchParams({ q, invoice_id: invoiceId, item_id: itemId });
        const { data } = await App.apiJson('/product-assistant/products/search?' + params);
        if (!active() || turn !== sequence) return;
        candidates = data.products || [];
        label.textContent = candidates.length ? `Найдено: ${candidates.length}` : 'В базе знаний подходящих товаров нет. Используйте справочник ниже или задайте вопрос';
        results.innerHTML = candidates.map(row => {
          const known = (row.matching_aliases || []).some(alias => alias.source === 'knowledge');
          const badges = [row.confirmed ? 'Подтверждённый выбор' : '', known ? 'Из базы знаний' : '',
            Number(row.times_selected) > 0 ? `Выбирали ${Number(row.times_selected)} раз` : ''].filter(Boolean).join(' · ');
          return `<button type="button" class="nom-choice-result" data-guid="${App.esc(row.onec_guid)}" ${saving ? 'disabled' : ''}><span class="nom-choice-result-copy"><strong>${App.esc(row.name)}</strong><small>${App.esc([row.code, row.unit].filter(Boolean).join(' · '))}</small>${badges ? `<small>${App.esc(badges)}</small>` : ''}</span><span class="nom-choice-result-action">Выбрать</span></button>`;
        }).join('');
      } catch (error) { if (active() && turn === sequence) label.textContent = error.message + '. Поиск в справочнике ниже доступен'; }
    };
    const addMessage = (title, value) => {
      const message = document.createElement('div');
      message.className = 'nom-assistant-message';
      message.innerHTML = `<strong>${App.esc(title)}</strong><div>${this.answerHtml(value)}</div>`;
      host.querySelector('[data-messages]').appendChild(message);
      return message;
    };
    const ask = async resume => {
      if (!enabled || !active() || chatBusy || saving) return;
      const textarea = host.querySelector('textarea');
      const submit = host.querySelector('[type=submit]');
      const retry = host.querySelector('[data-resume]');
      const label = host.querySelector('[data-chat-status]');
      if (!resume) {
        const message = textarea.value.trim();
        if (!message) { textarea.focus(); return; }
        pending = { key: crypto.randomUUID(), body: { invoice_id: invoiceId, item_id: itemId, message, auto_learn: false,
          candidate_guids: candidates.map(row => row.onec_guid), ...(sessionId ? { session_id: sessionId } : {}) } };
        addMessage('Вы', message);
        textarea.value = '';
      }
      if (!pending) return;
      chatBusy = true;
      submit.disabled = textarea.disabled = true;
      retry.hidden = true;
      try {
        if (!pending.accepted) pending.accepted = (await App.apiJson('/product-assistant/chat', { method: 'POST',
          headers: { 'Idempotency-Key': pending.key }, body: pending.body })).data;
        sessionId = pending.accepted.session_id;
        const state = await this.poll(pending.accepted, { active, scope: { invoice_id: invoiceId, item_id: itemId }, update: state => {
          label.textContent = state.status === 'queued' ? 'Вопрос в очереди…' : 'Помощник готовит ответ…';
        } });
        if (!state || !active()) return;
        const result = state.result || {};
        const message = addMessage('Помощник', result.answer || 'Ответ не содержит текста');
        if (result.match?.onec_guid) {
          const button = document.createElement('button');
          button.type = 'button'; button.className = 'btn btn-outline btn-sm';
          button.textContent = 'Выбрать: ' + result.match.mapped_name_1c;
          button.onclick = () => { if (!saving) save({ guid: result.match.onec_guid, name: result.match.mapped_name_1c }); };
          message.appendChild(button);
        }
        label.textContent = result.learning?.status ? this.learningText(result.learning.status) : 'Ответ получен. Выбор строки пока не изменён';
        pending = null;
      } catch (error) {
        if (!active()) return;
        label.textContent = error.message;
        // Terminal failures need a new question/key. Transport failures resume
        // the exact same POST, or poll the accepted request without resubmitting.
        if (error.terminal) pending = null;
        retry.hidden = !pending;
      } finally { chatBusy = false; submit.disabled = textarea.disabled = saving; }
    };
    const onInput = () => {
      ++sequence; clearTimeout(timer);
      timer = setTimeout(search, 300);
    };
    queryInput.addEventListener('input', onInput);
    return {
      async confirmSaved(row) {
        await ready;
        if (!enabled || !host.querySelector('[data-share]')?.checked) return;
        if (!confirmationKeys.has(row.guid)) confirmationKeys.set(row.guid, crypto.randomUUID());
        let data;
        try {
          ({ data } = await App.apiJson('/product-assistant/mappings', { method: 'POST', headers: { 'Idempotency-Key': confirmationKeys.get(row.guid) },
            body: { invoice_id: invoiceId, item_id: itemId, onec_guid: row.guid } }));
        } catch (error) { throw new Error('В строке выбор сохранён, но в базу знаний не отправлен: ' + error.message + '. Повторите выбор или снимите «Запоминать»'); }
        const identity = App.apiKey;
        ProductAssistant.poll(data, { active: () => App.apiKey === identity, scope: { invoice_id: invoiceId, item_id: itemId } }).then(state => {
          if (state) App.notify(ProductAssistant.learningText(state.result?.status), ['conflict', 'rejected'].includes(state.result?.status) ? 'info' : 'success');
        }).catch(error => { if (App.apiKey === identity) App.notify('Выбор сохранён в строке. База знаний: ' + error.message, 'info'); });
      },
      setBusy(value) {
        saving = value;
        host.querySelectorAll('button, textarea, input').forEach(el => { el.disabled = value || (chatBusy && (el.tagName === 'TEXTAREA' || el.type === 'submit')); });
      },
      refresh: search,
      dispose() { disposed = true; sequence++; clearTimeout(timer); queryInput.removeEventListener('input', onInput); },
    };
  },
};
