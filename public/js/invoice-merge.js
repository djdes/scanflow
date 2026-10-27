/* global App, Invoices */
const InvoiceMerge = {
  label(row) { return `${row.invoice_number ? '№ ' + row.invoice_number : 'Без номера'} · #${row.id}`; },
  compatible(a, b) {
    const number = v => String(v || '').replace(/[^\p{L}\p{N}]/gu, '').toUpperCase();
    return a.id !== b.id && !App.isXmlInvoice(b) && !b.duplicate_of && b.status !== 'duplicate'
      && !(a.invoice_number && b.invoice_number && number(a.invoice_number) !== number(b.invoice_number))
      && !(a.invoice_date && b.invoice_date && a.invoice_date !== b.invoice_date)
      && !(a.supplier_inn && b.supplier_inn && a.supplier_inn !== b.supplier_inn);
  },
  preferredTarget(a, b) {
    if (Boolean(a.invoice_number) !== Boolean(b.invoice_number)) return a.invoice_number ? a : b;
    return a.id < b.id ? a : b;
  },
  async open(id) {
    let current;
    try { current = (await App.apiJson(`/invoices/${Number(id)}`)).data; }
    catch (error) { App.notify(error.message, 'error'); return; }
    if (App.isXmlInvoice(current)) { App.notify('XML содержит документ целиком — объединять страницы не нужно.', 'info'); return; }
    document.getElementById('invoice-merge-dialog')?.close();
    const dialog = document.createElement('dialog');
    dialog.id = 'invoice-merge-dialog'; dialog.className = 'nomenclature-picker-dialog';
    dialog.setAttribute('aria-labelledby', 'merge-title');
    dialog.innerHTML = `<div class="nom-choice-header"><h2 id="merge-title">Объединить страницы накладной</h2><button type="button" class="nom-choice-close" aria-label="Закрыть">×</button></div>
      <p class="nom-choice-source">Выбрано: <strong>${App.esc(this.label(current))}</strong> · ${App.esc(current.supplier || 'Поставщик не определён')}</p>
      <p class="nom-choice-source">Номер на второй странице может отсутствовать. Найдите основной документ: фотографии и все строки товаров сохранятся в одной карточке.</p>
      <form class="nom-choice-search"><label for="merge-query">Номер накладной, поставщик или ID карточки (#893)</label><input id="merge-query" type="search" autocomplete="off"><button type="submit" class="btn btn-outline btn-sm">Найти</button></form>
      <p class="nom-choice-status" role="status"></p><div class="nom-choice-results"></div>
      <div class="invoice-merge-preview" hidden></div><p class="nom-choice-error" role="alert" hidden></p>`;
    document.body.appendChild(dialog);
    const returnFocus = document.activeElement, query = dialog.querySelector('input'), results = dialog.querySelector('.nom-choice-results');
    const preview = dialog.querySelector('.invoice-merge-preview'), errorField = dialog.querySelector('.nom-choice-error'), status = dialog.querySelector('.nom-choice-status');
    let busy = false, version = 0, selected = null, target = null;
    const showError = error => { errorField.hidden = false; errorField.textContent = error.message || String(error); };
    const describe = row => `<strong>${App.esc(this.label(row))}</strong><small>${App.esc(row.supplier || 'Без поставщика')} · ${App.esc(App.formatDate(row.invoice_date) || 'Без даты')} · ${App.formatMoney(row.total_sum)} ₽</small>`;
    const showPreview = () => {
      const source = target.id === current.id ? selected : current;
      const sent = [current, selected].some(row => row.status === 'sent_to_1c' || row.approved_for_1c);
      preview.hidden = false;
      preview.innerHTML = `<h3>После объединения</h3><p>Основная карточка: <strong>${App.esc(this.label(target))}</strong></p><p>Страницы и товары из ${App.esc(this.label(source))} перейдут в неё. Ссылка на исходную карточку будет вести на объединённый документ.</p><p>Итог по документу: ${App.formatMoney(Math.max(Number(current.total_sum || 0), Number(selected.total_sum || 0)))} ₽. Суммы страниц не складываются; итог нужно сверить со сканом.</p>${sent ? '<p class="nom-choice-warning">Один документ уже отправлен или ожидает отправки в 1С. Изменения в ScanFlow не исправят созданные документы в 1С — проверьте их отдельно.</p>' : ''}<label><input type="checkbox" data-confirm> Это страницы одной накладной</label><div class="invoice-merge-actions"><button type="button" data-swap class="btn btn-outline">Сменить основную карточку</button><button type="button" data-merge class="btn btn-primary" disabled>Объединить</button></div>`;
      const merge = preview.querySelector('[data-merge]');
      preview.querySelector('[data-confirm]').onchange = event => { merge.disabled = !event.target.checked; };
      preview.querySelector('[data-swap]').onclick = () => { target = target.id === current.id ? selected : current; showPreview(); };
      merge.onclick = async () => {
        if (busy || merge.disabled) return;
        busy = true; errorField.hidden = true;
        dialog.querySelectorAll('button, input').forEach(el => { el.disabled = true; });
        try {
          await App.apiJson(`/invoices/${source.id}/merge-into/${target.id}`, { method: 'POST' });
          dialog.close(); App.notify('Страницы и товары объединены. Проверьте итог по скану.', 'success');
          App.navigate(`#/invoices/${target.id}`); Invoices.showDetail(target.id);
        } catch (error) {
          showError(error); dialog.querySelectorAll('button, input').forEach(el => { el.disabled = false; });
        } finally { busy = false; }
      };
    };
    const search = async () => {
      if (busy) return;
      const sequence = ++version, text = query.value.trim();
      preview.hidden = true; errorField.hidden = true; results.innerHTML = ''; status.textContent = 'Ищем накладные…';
      try {
        let rows, total;
        if (/^#\d+$/.test(text)) { const response = await App.apiJson('/invoices/' + text.slice(1)); rows = [response.data]; total = 1; }
        else {
          const response = await App.apiJson('/invoices?limit=100&q=' + encodeURIComponent(text)); rows = response.data || []; total = response.total ?? rows.length;
        }
        if (sequence !== version || !dialog.isConnected) return;
        const candidates = rows.filter(row => this.compatible(current, row));
        candidates.sort((a, b) => Number(b.supplier === current.supplier) - Number(a.supplier === current.supplier) || b.id - a.id);
        status.textContent = `Подходящих карточек: ${candidates.length}${total > 100 ? ' · Показаны последние 100. Уточните поиск.' : ''}`;
        results.innerHTML = candidates.length ? candidates.map(row => `<button type="button" class="nom-choice-result" data-id="${row.id}"><span class="nom-choice-result-copy">${describe(row)}</span><span class="nom-choice-result-action">Выбрать</span></button>`).join('')
          : '<div class="nom-choice-empty"><h3>Подходящие накладные не найдены</h3><p>Попробуйте номер основной накладной, поставщика или #ID карточки. Документы с разными номерами, датами или ИНН объединять нельзя.</p></div>';
        results.querySelectorAll('[data-id]').forEach(button => { button.onclick = async () => {
          clearTimeout(timer);
          const choiceVersion = ++version;
          errorField.hidden = true;
          try {
            const row = (await App.apiJson('/invoices/' + button.dataset.id)).data;
            if (choiceVersion !== version || !dialog.isConnected) return;
            if (!this.compatible(current, row)) throw Error('Реквизиты выбранной накладной изменились. Обновите поиск.');
            selected = row; target = this.preferredTarget(current, row); showPreview();
          } catch (error) { showError(error); }
        }; });
      } catch (error) { if (sequence === version) { status.textContent = 'Поиск не завершён'; showError(error); } }
    };
    dialog.querySelector('form').onsubmit = event => { event.preventDefault(); clearTimeout(timer); search(); };
    let timer;
    query.oninput = () => { clearTimeout(timer); ++version; preview.hidden = true; timer = setTimeout(search, 300); };
    dialog.querySelector('.nom-choice-close').onclick = () => { if (!busy) dialog.close(); };
    dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    const navigate = () => { if (!busy) dialog.close(); };
    window.addEventListener('hashchange', navigate);
    dialog.addEventListener('close', () => { ++version; clearTimeout(timer); window.removeEventListener('hashchange', navigate); dialog.remove(); returnFocus?.focus?.(); }, { once: true });
    dialog.showModal(); query.focus(); await search();
  },
};
