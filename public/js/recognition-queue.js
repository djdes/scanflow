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
        if (receipt.state === 'completed' && receipt.last_error) {
          // Окончательная ошибка (битый XML): повтор не поможет — показываем причину, без автоповтора.
          h.status = 'error'; h.error = receipt.last_error; h.autoRetry = false;
          if (h.id) Upload.dbDelete(h.id).catch(() => {});
        } else if (receipt.state === 'completed') {
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
  /** Задания сервера без тех, что уже в списке загрузок этой вкладки. */
  visibleJobs(state, history) {
    const local = new Set((history || []).filter(h => h.jobId && h.status !== 'removed').map(h => Number(h.jobId)));
    return (state.data || []).filter(job => !local.has(Number(job.id)));
  },
  /** Состояние задания простыми словами — те же tone, что у строк загрузки. */
  jobView(job) {
    if (job.state === 'processing') return { tone: 'work', label: 'Распознаётся…' };
    if (job.state === 'retry') {
      const at = this.shortTime(job.next_attempt_at);
      return { tone: 'warn', label: `Не распознали — повторим ${at ? `в ${at}` : 'позже'}`, detail: job.last_error || '' };
    }
    return { tone: 'wait', label: 'В очереди на распознавание', detail: job.last_error || '' };
  },
  /** «16:03» сегодня, «22.11, 16:03» — в другой день. */
  shortTime(value, now = new Date()) {
    const d = new Date(String(value || '').replace(' ', 'T'));
    if (isNaN(d.getTime())) return '';
    const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === now.toDateString() ? time
      : `${d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}, ${time}`;
  },
  render() {
    const state = this.data;
    if (!state) return;
    const banner = document.getElementById('recognition-queue-banner');
    if (banner) {
      banner.hidden = state.total === 0;
      banner.innerHTML = `<strong>Распознаём фото: ${Number(state.total)}</strong><button type="button" class="info-tip" data-tip="Фото сохранены на сервере. Распознавание продолжится само, даже если закрыть страницу." aria-label="Подробнее об очереди распознавания">i</button><a href="#/upload">Смотреть →</a>`;
    }
    const host = document.getElementById('recognition-queue-list');
    if (!host || typeof Upload === 'undefined') return;
    // Файлы, загруженные в этой вкладке, уже есть в списке выше — второй раз не показываем.
    const jobs = this.visibleJobs(state, Upload.history);
    const shown = Number(state.total) - (state.data.length - jobs.length);
    const reason = !state.ai.available && state.total
      ? `<p class="recognition-queue-reason">${App.esc(state.ai.text)}. Файлы сохранены — распознаем, как только ИИ снова заработает.</p>` : '';
    // Пустую очередь не показываем (2026-11-17): блок появляется, только когда есть что ждать.
    host.hidden = shown <= 0 && !reason;
    const rows = jobs.map(job => {
      const view = this.jobView(job);
      const side = (job.invoice_id ? Upload.invoiceLink(job.invoice_id, false) : '')
        + (job.state === 'retry' ? `<button type="button" class="btn btn-outline btn-sm" data-recognition-retry="${Number(job.id)}">Повторить сейчас</button>` : '');
      return Upload.rowHtml({ thumb: Upload.fileThumb(job.original_name), name: job.original_name, tone: view.tone,
        label: view.label, meta: `принято ${this.shortTime(job.created_at)}`, detail: view.detail, side });
    }).join('');
    const more = state.total > state.data.length
      ? `<p class="recognition-queue-help">И ещё ${Number(state.total) - state.data.length} — распознаем по порядку.</p>` : '';
    host.innerHTML = `${shown > 0 ? `<div class="recognition-queue-heading"><h3>Ждут распознавания · ${shown}</h3><button type="button" class="info-tip" data-tip="Файлы уже на сервере и распознаются по очереди. Страницу можно закрыть — ничего не пропадёт." aria-label="Подробнее об очереди распознавания">i</button></div>` : ''}${reason}${rows}${shown > 0 ? more : ''}<p class="recognition-queue-action-error" role="alert" hidden></p>`;
    host.querySelectorAll('[data-recognition-retry]').forEach(button => { button.onclick = async () => {
      button.disabled = true;
      try { await App.apiJson(`/recognition-queue/${button.dataset.recognitionRetry}/retry`, { method: 'POST' }); await this.refresh(); }
      catch (error) { const field = host.querySelector('.recognition-queue-action-error'); field.hidden = false; field.textContent = error.message; }
      finally { button.disabled = false; }
    }; });
  },
};
