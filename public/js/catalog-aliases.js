/* global App, OnecCatalog, InvoiceCard */
const CatalogAliases = {
  async openFromInvoice(invoiceId, itemId) {
    try {
      const invoice = typeof InvoiceCard !== 'undefined' && InvoiceCard.inv?.id === invoiceId ? InvoiceCard.inv : (await App.apiJson(`/invoices/${invoiceId}`)).data;
      const item = invoice?.items?.find(row => row.id === itemId);
      if (!item?.onec_guid) { App.notify('Сначала выберите товар из 1С.', 'info'); return; }
      return this.open(item.onec_guid, item.original_name);
    } catch (error) { App.notify(error.message, 'error'); }
  },
  async open(guid, suggestedName = '', changed) {
    document.getElementById('catalog-aliases-dialog')?.close();
    const dialog = document.createElement('dialog'), focus = document.activeElement;
    dialog.id = 'catalog-aliases-dialog'; dialog.className = 'nomenclature-picker-dialog';
    dialog.setAttribute('aria-labelledby', 'catalog-aliases-title');
    dialog.innerHTML = `<div class="nom-choice-header"><h2 id="catalog-aliases-title">Синонимы товара</h2><button type="button" class="nom-choice-close" aria-label="Закрыть синонимы">×</button></div>
      <p class="nom-choice-source" data-item>Загружаем товар…</p>
      <p class="nom-choice-source">Название из накладной может отличаться от названия в 1С. Сохранённые синонимы используются в поиске и при обработке следующих накладных; подтверждённый выбор важнее предложения ИИ.</p>
      <div class="catalog-aliases-list" aria-live="polite"></div>
      <form class="catalog-aliases-form"><label for="catalog-aliases-input">Добавить названия из накладных — каждое с новой строки</label><textarea id="catalog-aliases-input" rows="3" maxlength="25000" placeholder="Например: Майонез Махеевъ Провансаль 50,5% 9,4кг Ведро"></textarea><button type="submit" class="btn btn-primary">Запомнить синонимы</button></form>
      <p class="nom-choice-status" role="status"></p><p class="nom-choice-error" role="alert" hidden></p>`;
    document.body.appendChild(dialog);
    const input = dialog.querySelector('textarea'), list = dialog.querySelector('.catalog-aliases-list'), errorField = dialog.querySelector('.nom-choice-error'), status = dialog.querySelector('[role=status]');
    input.value = suggestedName || '';
    let busy = false, loading = true, aliases = [];
    const disabled = value => { busy = value; dialog.querySelectorAll('button, textarea').forEach(element => { element.disabled = value; }); };
    const fail = error => { errorField.hidden = false; errorField.textContent = error.message || String(error); };
    const updateCache = async () => {
      await OnecCatalog.load(true);
      const item = OnecCatalog.getByGuid(guid);
      if (item) item.aliases = aliases.map(alias => alias.scanned_name);
      changed?.();
    };
    const render = () => {
      list.innerHTML = aliases.length ? `<p class="nom-choice-status">Подтверждённых синонимов: ${aliases.length}</p>${aliases.map(alias => `<div class="catalog-aliases-row"><span>${App.esc(alias.scanned_name)}</span><button type="button" class="btn btn-outline btn-sm" data-remove="${Number(alias.id)}" aria-label="Удалить синоним ${App.esc(alias.scanned_name)}">Удалить</button></div>`).join('')}` : '<p class="nom-choice-status">Синонимов пока нет.</p>';
      list.querySelectorAll('[data-remove]').forEach(button => { button.onclick = async () => {
        if (busy || !confirm('Забыть этот синоним? Он больше не будет использоваться как подтверждённое правило.')) return;
        disabled(true); errorField.hidden = true;
        try {
          await App.apiJson(`/nomenclature/${encodeURIComponent(guid)}/aliases/${button.dataset.remove}`, { method: 'DELETE' });
          aliases = aliases.filter(alias => alias.id !== Number(button.dataset.remove)); render(); await updateCache(); status.textContent = 'Синоним удалён.';
        } catch (error) { fail(error); }
        finally { disabled(false); }
      }; });
    };
    dialog.querySelector('form').onsubmit = async event => {
      event.preventDefault(); if (busy || loading) return;
      const names = [...new Set(input.value.split(/\r?\n/).map(name => name.trim()).filter(Boolean))];
      if (!names.length || names.length > 50 || names.some(name => name.length > 500)) { fail(new Error('Введите от 1 до 50 названий, каждое не длиннее 500 символов.')); return; }
      disabled(true); errorField.hidden = true;
      try {
        const result = await App.apiJson(`/nomenclature/${encodeURIComponent(guid)}/aliases`, { method: 'POST', body: { aliases: names } });
        aliases = result.data; input.value = ''; render(); await updateCache(); status.textContent = 'Синонимы сохранены. Они будут применяться в следующих накладных.';
      } catch (error) { fail(error); }
      finally { disabled(false); }
    };
    dialog.querySelector('.nom-choice-close').onclick = () => { if (!busy) dialog.close(); };
    dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    const navigate = () => { if (!busy) dialog.close(); };
    window.addEventListener('hashchange', navigate);
    dialog.addEventListener('close', () => { window.removeEventListener('hashchange', navigate); dialog.remove(); if (focus?.isConnected) focus.focus(); }, { once: true });
    dialog.showModal(); dialog.querySelectorAll('form button, textarea').forEach(element => { element.disabled = true; });
    try {
      const result = await App.apiJson(`/nomenclature/${encodeURIComponent(guid)}/aliases`);
      if (!dialog.isConnected) return;
      aliases = result.data; dialog.querySelector('[data-item]').textContent = `${result.item.name}${result.item.code ? ' · ' + result.item.code : ''}`; render();
    } catch (error) { fail(error); }
    finally { loading = false; if (dialog.isConnected) { disabled(false); input.focus(); } }
  },
};
