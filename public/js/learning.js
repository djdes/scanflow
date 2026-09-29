/* global App */
// «Предложения правил» (пакет v2, п.15): ночной разбор правок количества и
// неуверенных пересчётов предлагает правила «товар + поставщик → единица 1С».
// Ничего не применяется само — человек принимает или отклоняет.
const Learning = {
  status: 'pending',

  async load() {
    const tabs = document.getElementById('learning-status-tabs');
    if (tabs && !tabs.dataset.bound) {
      tabs.dataset.bound = '1';
      tabs.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-status]');
        if (!btn) return;
        this.status = btn.dataset.status;
        tabs.querySelectorAll('[data-status]').forEach(b => b.classList.toggle('active', b === btn));
        this.renderProposals();
      });
    }
    await Promise.all([this.renderProposals(), this.renderRules()]);
  },

  fmtFactor(x) {
    return String(Math.round(Number(x) * 10000) / 10000).replace('.', ',');
  },

  // Название товара — из заметки правила «Название»: …, иначе ключ товара.
  ruleName(r) {
    const m = /^«(.+?)»/.exec(r.note || '');
    return m ? m[1] : r.name_key;
  },

  supplierText(r) {
    if (!r.supplier_key) return 'любой поставщик';
    return r.supplier_label || (r.supplier_key.startsWith('inn:') ? `ИНН ${r.supplier_key.slice(4)}` : 'поставщик');
  },

  async renderProposals() {
    const host = document.getElementById('learning-proposals');
    if (!host) return;
    let body;
    try {
      body = await App.apiJson(`/learning/proposals?status=${encodeURIComponent(this.status)}`);
    } catch (e) {
      host.innerHTML = `<div class="empty-state">Не удалось загрузить: ${App.esc(e.message)}</div>`;
      return;
    }
    const off = document.getElementById('learning-off-hint');
    if (off) off.style.display = body.learning_enabled ? 'none' : 'block';
    const rows = body.data || [];
    if (!rows.length) {
      host.innerHTML = `<div class="empty-state">${this.status === 'pending'
        ? 'Новых предложений нет. Разбор идёт каждую ночь; можно запустить и сейчас.'
        : 'Здесь пока пусто.'}</div>`;
      return;
    }
    host.innerHTML = rows.map(r => this.proposalCard(r)).join('');
  },

  proposalCard(r) {
    const p = r.payload || {};
    const ev = r.evidence || {};
    const examples = (ev.examples || []).map(x => {
      const what = x.from ? `${App.esc(x.from)} → ${App.esc(x.to)}` : App.esc(x.raw || '');
      const price = x.usual_price ? `, обычная цена ${App.esc(String(x.usual_price))} ₽, станет ${App.esc(String(x.price_after))} ₽` : '';
      return `<li><a href="#/invoices/${Number(x.invoice_id)}">накладная №${Number(x.invoice_id)}</a>: ${what}${price}</li>`;
    }).join('');
    const src = r.source === 'llm'
      ? '<span class="badge badge-confidence-medium" title="Коэффициент предложил Claude по названию и обычной цене">ИИ</span>'
      : '<span class="badge badge-processed" title="Найдено в ваших правках и ценах">разбор правок</span>';
    const actions = r.status === 'pending'
      ? `<div class="learning-card__actions">
           <button class="btn btn-primary btn-sm" onclick="Learning.accept(${r.id}, this)">Принять</button>
           <button class="btn btn-soft btn-sm" onclick="Learning.reject(${r.id}, this)">Отклонить</button>
         </div>`
      : `<div class="muted">${r.status === 'accepted' ? 'Принято' : 'Отклонено'} ${App.formatDateTime(r.decided_at)}</div>`;
    return `
      <div class="card learning-card">
        <div class="learning-card__head">
          <div>
            <div class="learning-card__title">${App.esc(p.name || r.name_key)}</div>
            <div class="learning-card__rule">1 ${App.esc(p.raw_unit || '')} = <b>${this.fmtFactor(p.factor)} ${App.esc(p.target_unit || '')}</b>
              <span class="muted">· ${App.esc(this.supplierText(r))}</span></div>
          </div>
          ${src}
        </div>
        ${ev.why ? `<div class="field-hint">Почему: ${App.esc(ev.why)}${ev.count > 1 ? ` (случаев: ${Number(ev.count)})` : ''}</div>` : ''}
        ${examples ? `<ul class="learning-card__examples">${examples}</ul>` : ''}
        ${actions}
      </div>`;
  },

  async accept(id, btn) {
    if (btn) btn.disabled = true;
    try {
      const { data } = await App.apiJson(`/learning/proposals/${id}/accept`, { method: 'POST' });
      App.notify(data.applied_lines
        ? `Правило сохранено, пересчитано строк в неотправленных накладных: ${data.applied_lines}`
        : 'Правило сохранено — применится к следующим накладным', 'success');
      await Promise.all([this.renderProposals(), this.renderRules()]);
    } catch (e) {
      App.notify(e.message || 'Не удалось принять', 'error');
      if (btn) btn.disabled = false;
    }
  },

  async reject(id, btn) {
    if (btn) btn.disabled = true;
    try {
      await App.apiJson(`/learning/proposals/${id}/reject`, { method: 'POST' });
      App.notify('Отклонено — 90 дней не будем предлагать снова', 'info');
      await this.renderProposals();
    } catch (e) {
      App.notify(e.message || 'Не удалось отклонить', 'error');
      if (btn) btn.disabled = false;
    }
  },

  async run(llm, btn) {
    if (btn) btn.disabled = true;
    try {
      const { data } = await App.apiJson('/learning/run', { method: 'POST', body: { llm: !!llm } });
      App.notify(data.created ? `Новых предложений: ${data.created}` : 'Новых предложений нет', data.created ? 'success' : 'info');
      await this.renderProposals();
    } catch (e) {
      App.notify(e.status === 429 ? 'Слишком часто — подождите минуту' : (e.message || 'Не удалось запустить'), 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  },

  async renderRules() {
    const host = document.getElementById('learning-rules');
    if (!host) return;
    let rows = [];
    try { ({ data: rows } = await App.apiJson('/learning/rules')); } catch { host.innerHTML = ''; return; }
    if (!rows.length) {
      host.innerHTML = '<div class="empty-state">Правил пока нет. Они появляются, когда вы нажимаете «Запомнить пересчёт» в строке накладной или принимаете предложение выше.</div>';
      return;
    }
    const srcName = { user: 'вручную', miner: 'разбор правок', llm: 'ИИ', legacy: 'перенесено' };
    host.innerHTML = `
      <div class="table-container"><table class="data-table"><thead><tr>
        <th>Товар</th><th>Поставщик</th><th>Пересчёт</th><th>Источник</th><th>Применялось</th><th>Действует</th>
      </tr></thead><tbody>
      ${rows.map(r => `<tr class="${r.active ? '' : 'row-muted'}">
        <td>${App.esc(this.ruleName(r))}</td>
        <td>${App.esc(this.supplierText(r))}</td>
        <td>1 ${App.esc(r.raw_unit || 'любая')} = ${this.fmtFactor(r.factor)} ${App.esc(r.target_unit)}</td>
        <td>${App.esc(srcName[r.source] || r.source)}</td>
        <td>${Number(r.times_used) || 0}${r.last_used_at ? `<div class="muted">${App.formatDateTime(r.last_used_at)}</div>` : ''}</td>
        <td><label class="switch-inline"><input type="checkbox" ${r.active ? 'checked' : ''} onchange="Learning.toggleRule(${r.id}, this)"> ${r.active ? 'да' : 'нет'}</label></td>
      </tr>`).join('')}
      </tbody></table></div>`;
  },

  async toggleRule(id, input) {
    try {
      await App.apiJson(`/learning/rules/${id}/active`, { method: 'POST', body: { active: input.checked } });
      await this.renderRules();
    } catch (e) {
      input.checked = !input.checked;
      App.notify(e.message || 'Не удалось изменить', 'error');
    }
  },
};
