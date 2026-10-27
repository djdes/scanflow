/* global App, Upload */
const RecognitionQueue = {
  timer: null,
  loading: false,
  async refresh() {
    if (this.loading || !App.apiKey) return;
    clearTimeout(this.timer);
    this.loading = true;
    const pending = typeof Upload === 'undefined' ? [] : Upload.history.filter(h => h.jobId && h.status === 'server_queued').slice(0, 100);
    try {
      const payload = await App.apiJson('/recognition-queue' + (pending.length ? '?ids=' + pending.map(h => h.jobId).join(',') : ''));
      this.data = payload;
      for (const receipt of payload.receipts || []) {
        const h = pending.find(h => Number(h.jobId) === receipt.id);
        if (!h) continue;
        h.invoiceId = receipt.invoice_id; h.queueError = receipt.last_error; h.serverState = receipt.state;
        if (receipt.state === 'completed') {
          h.status = 'ok';
          if (receipt.invoice_id) Upload._checkElevatedPrices(Upload.history.indexOf(h), receipt.invoice_id).catch(() => {});
        }
        if (receipt.state === 'cancelled') h.status = 'cancelled';
      }
      if (pending.length) { Upload.renderHistory(); Upload.updateCounter(); }
      this.render();
    } catch {
      const host = document.getElementById('recognition-queue-list');
      if (host) host.innerHTML = '<p>Не удалось обновить очередь. Сохранённые задания остаются на сервере. <button type="button" class="btn btn-outline btn-sm" onclick="RecognitionQueue.refresh()">Повторить</button></p>';
    } finally {
      this.loading = false;
      this.timer = setTimeout(() => { if (!document.hidden) this.refresh(); else this.schedule(); }, 10000);
    }
  },
  schedule() { clearTimeout(this.timer); this.timer = setTimeout(() => this.refresh(), 30000); },
  render() {
    const state = this.data;
    if (!state) return;
    const banner = document.getElementById('recognition-queue-banner');
    if (banner) {
      banner.hidden = state.total === 0;
      banner.innerHTML = `<strong>В очереди распознавания: ${Number(state.total)}</strong><span>Фото сохранены на сервере. Обработка продолжится автоматически.</span><a href="#/upload">Открыть очередь →</a>`;
    }
    const host = document.getElementById('recognition-queue-list');
    if (!host) return;
    host.innerHTML = `<div class="recognition-queue-heading"><h3>Постоянная очередь · ${Number(state.total)}</h3><button type="button" class="btn btn-outline btn-sm" onclick="RecognitionQueue.refresh()">Обновить</button></div><p class="recognition-queue-help">Принятые фото останутся здесь до успешного распознавания. Закрытие страницы и перезапуск сервера не удаляют задания.</p>${!state.ai.available && state.total ? `<p class="recognition-queue-reason">${App.esc(state.ai.text)}. Очередь ждёт восстановления.</p>` : ''}${state.data.length ? state.data.map(job => `<article class="recognition-queue-job"><div><strong>${App.esc(job.original_name)}</strong><span>${job.state === 'processing' ? 'Распознаётся' : job.state === 'retry' ? 'Сохранено · ожидает повторной попытки' : 'Сохранено · в очереди'}</span>${job.last_error ? `<p>${App.esc(job.last_error)}</p>` : ''}<small>Принято: ${App.esc(App.formatDateTime(job.created_at))}${job.attempts ? ` · Попыток: ${Number(job.attempts)}` : ''}${job.state === 'retry' ? ` · Следующая: ${App.esc(App.formatDateTime(job.next_attempt_at))}` : ''}</small></div><div>${job.invoice_id ? `<a href="#/invoices/${Number(job.invoice_id)}">Накладная #${Number(job.invoice_id)}</a>` : ''}${job.state === 'retry' ? `<button type="button" class="btn btn-outline btn-sm" data-recognition-retry="${job.id}">Повторить сейчас</button>` : ''}</div></article>`).join('') : '<p class="recognition-queue-help">Нет фотографий, ожидающих обработки.</p>'}${state.total > state.data.length ? `<p>Показаны первые ${state.data.length} из ${Number(state.total)} заданий. Остальные также сохранены и будут обработаны по порядку.</p>` : ''}<p class="recognition-queue-action-error" role="alert" hidden></p>`;
    host.querySelectorAll('[data-recognition-retry]').forEach(button => { button.onclick = async () => {
      button.disabled = true;
      try { await App.apiJson(`/recognition-queue/${button.dataset.recognitionRetry}/retry`, { method: 'POST' }); await this.refresh(); }
      catch (error) { const field = host.querySelector('.recognition-queue-action-error'); field.hidden = false; field.textContent = error.message; }
      finally { button.disabled = false; }
    }; });
  },
};
