/* global App */
'use strict';
const ProductAssistantSettings = {
  async load() {
    const host = document.getElementById('profile-product-assistant');
    if (!host) return;
    try {
      const { data } = await App.apiJson('/product-assistant/config');
      if (!host.isConnected) return;
      host.innerHTML = `<h2>Помощник по товарам</h2><p class="card-subtitle">Подключите своего шеф-бота или другого помощника для поиска по общей базе знаний. Подключение необязательно и действует только для вашей компании.</p>
        <form><div class="form-group"><label><input type="checkbox" name="enabled" ${data.enabled ? 'checked' : ''}> Использовать помощника при выборе товара</label></div>
        <div class="form-group"><label for="pa-label">Название помощника</label><input id="pa-label" name="label" maxlength="80" value="${App.esc(data.label)}" required></div>
        <div class="form-group"><label for="pa-url">Базовый адрес API</label><input id="pa-url" name="api_base_url" type="url" maxlength="500" placeholder="https://bot.example/api/scanflow" value="${App.esc(data.api_base_url)}" required></div>
        <div class="form-group"><label for="pa-token">Токен API</label><input id="pa-token" name="api_token" type="password" autocomplete="new-password" maxlength="4096" placeholder="${data.token_set ? 'Токен сохранён. Оставьте пустым, чтобы не менять' : 'Токен вашего помощника'}"></div>
        <p class="field-hint">Токен хранится зашифрованным и используется сервером. Бот должен поддерживать единый протокол ScanFlow; адрес сервиса разрешает администратор сервера.</p>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Сохранить подключение</button><button class="btn btn-outline" type="button" data-test>Проверить</button><button class="btn btn-outline" type="button" data-remove ${data.token_set ? '' : 'hidden'}>Удалить подключение</button></div>
        <p role="status" aria-live="polite"></p></form>
        <details class="assistant-api-help"><summary>Как подключить своего бота</summary><p>Разработчику бота нужен <a href="https://github.com/djdes/scanflow/blob/main/docs/product-assistant-api.md" target="_blank" rel="noopener noreferrer">единый API-контракт ScanFlow v1</a>: поиск товаров, консультация и запоминание ручного выбора. Укажите адрес с префиксом API целиком. Для шеф-бота MAG это адрес сервера с путём <code>/api/chef/scanflow</code>. У других компаний — собственный сервис и собственный токен.</p></details>`;
      const form = host.querySelector('form');
      const status = form.querySelector('[role=status]');
      const run = async task => {
        const buttons = [...form.querySelectorAll('button')];
        buttons.forEach(b => { b.disabled = true; }); status.textContent = '';
        try { await task(); } catch (error) { status.textContent = error.message || 'Не удалось сохранить подключение'; }
        finally { buttons.forEach(b => { b.disabled = false; }); }
      };
      form.onsubmit = event => {
        event.preventDefault();
        run(async () => {
          const body = { enabled: form.elements.enabled.checked, label: form.elements.label.value.trim(), api_base_url: form.elements.api_base_url.value.trim() };
          if (form.elements.api_token.value) body.api_token = form.elements.api_token.value;
          await App.apiJson('/product-assistant/config', { method: 'PUT', body });
          form.elements.api_token.value = '';
          await this.load();
          App.notify('Подключение помощника сохранено', 'success');
        });
      };
      host.querySelector('[data-test]').onclick = () => run(async () => {
        const { data } = await App.apiJson('/product-assistant/status');
        status.textContent = data.readiness?.message || 'Подключение и компания проверены';
      });
      host.querySelector('[data-remove]').onclick = () => run(async () => {
        await App.apiJson('/product-assistant/config', { method: 'DELETE' });
        await this.load(); App.notify('Подключение помощника удалено', 'success');
      });
    } catch (error) { host.innerHTML = `<h2>Помощник по товарам</h2><p>${App.esc(error.message)}</p><button class="btn btn-outline" type="button">Повторить</button>`; host.querySelector('button').onclick = () => this.load(); }
  },
};
