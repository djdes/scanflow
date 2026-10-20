/* global App, Invoices, InvoiceCard, OnecCatalog */
const NomenclaturePicker = {
  async open(invoiceId, itemId) {
    invoiceId = Number(invoiceId);
    itemId = Number(itemId);
    if (![invoiceId, itemId].every(id => Number.isSafeInteger(id) && id > 0)) return;
    const returnFocus = document.activeElement;
    let invoice = typeof InvoiceCard !== 'undefined' && InvoiceCard.inv?.id === invoiceId ? InvoiceCard.inv : null;
    try {
      if (!invoice) invoice = (await App.apiJson(`/invoices/${invoiceId}`)).data;
    } catch (error) { App.notify(error.message || 'Не удалось открыть строку', 'error'); return; }
    const item = invoice?.items?.find(row => row.id === itemId);
    if (!item) { App.notify('Строка не найдена. Обновите накладную.', 'error'); return; }
    document.getElementById('nomenclature-picker-dialog')?.close();
    const dialog = document.createElement('dialog');
    dialog.id = 'nomenclature-picker-dialog';
    dialog.className = 'nomenclature-picker-dialog';
    dialog.setAttribute('aria-labelledby', 'nom-choice-title');
    dialog.innerHTML = `<div class="nom-choice-header"><h2 id="nom-choice-title">Выбрать товар из 1С</h2><button type="button" class="nom-choice-close" aria-label="Закрыть выбор товара">×</button></div>
      <p class="nom-choice-source">Как в накладной: <strong>${App.esc(item.original_name || '')}</strong></p>
      ${item.onec_guid ? `<p class="nom-choice-current">Сейчас выбрано: ${App.esc(item.mapped_name || '')}</p>` : ''}
      <div class="nom-choice-search"><label for="nom-choice-query">Поиск по названию или коду товара</label><input id="nom-choice-query" type="search" autocomplete="off" placeholder="Например: сахар, этикетка или код товара"><button type="button" class="btn btn-outline btn-sm" data-refresh>Обновить список</button></div>
      <p class="nom-choice-warning" role="status" hidden></p><p class="nom-choice-status" aria-live="polite"></p>
      <div class="nom-choice-results" aria-label="Товары вашей компании из 1С" aria-busy="true"></div>
      <p class="nom-choice-error" role="alert" hidden></p>
      <details class="nom-choice-new"><summary>Товара действительно нет в 1С?</summary><p>Можно указать название новой позиции. Она создастся в 1С при отправке накладной; сейчас сохранится только название строки.</p><label for="nom-choice-new-name">Название новой позиции</label><input id="nom-choice-new-name" type="text" maxlength="500" value="${App.esc(item.mapped_name || item.original_name || '')}"><button type="button" class="btn btn-outline" data-create>Сохранить как новый товар</button></details>`;
    document.body.appendChild(dialog);
    const search = dialog.querySelector('#nom-choice-query');
    const results = dialog.querySelector('.nom-choice-results');
    const status = dialog.querySelector('.nom-choice-status');
    const error = dialog.querySelector('.nom-choice-error');
    const warning = dialog.querySelector('.nom-choice-warning');
    const refreshButton = dialog.querySelector('[data-refresh]');
    const closeButton = dialog.querySelector('.nom-choice-close');
    const newName = dialog.querySelector('#nom-choice-new-name');
    const createButton = dialog.querySelector('[data-create]');
    let busy = false;
    let loading = false;
    const syncDisabled = () => {
      refreshButton.disabled = busy || loading;
      search.disabled = busy || loading;
      newName.disabled = busy;
      createButton.disabled = busy || loading || !newName.value.trim();
      closeButton.disabled = busy;
      results.querySelectorAll('button').forEach(button => { button.disabled = busy; });
    };
    const render = () => {
      if (!dialog.isConnected) return;
      const catalog = OnecCatalog;
      warning.hidden = !catalog.loaded || !catalog.lastError;
      warning.textContent = catalog.lastError ? 'Не удалось обновить список. Показан ранее загруженный справочник; можно повторить обновление.' : '';
      if (!catalog.loaded) {
        status.textContent = 'Справочник недоступен';
        results.innerHTML = '<div class="nom-choice-empty"><h3>Не удалось загрузить товары из 1С</h3><p>Нажмите «Обновить список», чтобы попробовать ещё раз.</p></div>';
      } else if (!catalog.items.length) {
        status.textContent = 'Справочник вашей компании пуст';
        results.innerHTML = '<div class="nom-choice-empty"><h3>Номенклатура ещё не загружена</h3><p>Выгрузите справочник из 1С в ScanFlow, затем нажмите «Обновить список».</p></div>';
      } else {
        const query = search.value.trim();
        const matches = query ? catalog.search(query, 40) : catalog.items.slice(0, 40);
        status.textContent = `В справочнике ${catalog.items.length} позиций · Показано ${matches.length}${query ? ' вариантов по запросу' : ''}`;
        results.innerHTML = matches.length ? matches.map(row => `<button type="button" class="nom-choice-result" data-guid="${App.esc(row.guid)}"><span class="nom-choice-result-copy"><strong>${App.esc(row.name)}</strong><small>${row.code ? `Код: ${App.esc(row.code)}` : ''}${row.code && row.unit ? ' · ' : ''}${row.unit ? `Ед.: ${App.esc(row.unit)}` : ''}</small></span><span class="nom-choice-result-action">Выбрать</span></button>`).join('')
          : '<div class="nom-choice-empty"><h3>По этому запросу ничего не найдено</h3><p>Попробуйте часть названия или код товара. Если позиции нет в справочнике, обновите выгрузку из 1С или укажите ниже название нового товара.</p></div>';
      }
      results.setAttribute('aria-busy', 'false');
      syncDisabled();
    };
    const refresh = async force => {
      if (busy || loading) return;
      loading = true;
      syncDisabled();
      status.textContent = 'Загружаем справочник 1С…';
      results.setAttribute('aria-busy', 'true');
      results.innerHTML = '<div class="nom-choice-loading">Загружаем товары вашей компании…</div>';
      await OnecCatalog.load(force);
      loading = false;
      render();
      if (dialog.isConnected && !busy) search.focus();
    };
    const save = async (row, customName) => {
      if (busy || loading) return;
      busy = true;
      error.hidden = true;
      syncDisabled();
      try {
        const options = { refresh: false, throwOnError: true };
        const saved = row
          ? await Invoices.selectNomItem(invoiceId, itemId, row.guid, row.name, options)
          : await Invoices.saveCustomName(invoiceId, itemId, customName, options);
        if (!saved) throw new Error('Выбор не сохранён. Повторите попытку.');
        dialog.close();
        if (location.hash.split('?')[0] === `#/invoices/${invoiceId}`) Invoices.showDetail(invoiceId);
      } catch (cause) {
        error.textContent = cause.message || 'Не удалось сохранить выбор';
        error.hidden = false;
      } finally { busy = false; syncDisabled(); }
    };
    search.addEventListener('input', render);
    search.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'Enter') {
        event.preventDefault();
        results.querySelector('button')?.focus();
      }
    });
    results.addEventListener('click', event => {
      const button = event.target.closest('button[data-guid]');
      if (!button) return;
      const row = OnecCatalog.getByGuid(button.dataset.guid);
      if (row) save(row);
    });
    results.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      const buttons = Array.from(results.querySelectorAll('button'));
      const index = buttons.indexOf(document.activeElement);
      if (index < 0) return;
      event.preventDefault();
      if (index === 0 && event.key === 'ArrowUp') search.focus();
      else buttons[index + (event.key === 'ArrowDown' ? 1 : -1)]?.focus();
    });
    refreshButton.onclick = () => refresh(true);
    closeButton.onclick = () => dialog.close();
    newName.addEventListener('input', syncDisabled);
    createButton.onclick = () => save(null, newName.value.trim());
    const onNavigate = () => { if (!busy) dialog.close(); };
    window.addEventListener('hashchange', onNavigate);
    dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    dialog.addEventListener('close', () => {
      window.removeEventListener('hashchange', onNavigate);
      dialog.remove();
      if (returnFocus?.isConnected) returnFocus.focus();
    }, { once: true });
    dialog.showModal();
    refresh(false);
  },
};
