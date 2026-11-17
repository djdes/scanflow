/* global App */
// Корзина (2026-11-17): удалённые накладные своей компании за 30 дней.
// «Вернуть» — с тем же номером записи, товарами и фото; «Удалить навсегда» — сразу.
const Trash = {
  async load() {
    const tbody = document.getElementById('trash-tbody');
    if (!tbody) return;
    App.skeletonRows('trash-tbody', ['w-40', 'w-60', 'w-24', 'w-40', 'w-40'], 4);
    try {
      const { data } = await App.apiJson('/invoices/trash');
      this.render(data || []);
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state">Не удалось загрузить корзину. <button class="btn btn-outline btn-sm" onclick="Trash.load()">Повторить</button></div></td></tr>`;
    }
  },

  reasonText(reason) {
    return { duplicates_24h: 'дубликаты за 24 ч', batch: 'выбранные', manual: '' }[reason] || '';
  },

  render(rows) {
    const tbody = document.getElementById('trash-tbody');
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state">Корзина пуста</div></td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(r => {
      const why = this.reasonText(r.reason);
      const left = Number(r.days_left);
      return `<tr data-trash-id="${r.id}">
        <td data-label="Документ"><div class="invoice-cell-stack"><strong>${App.esc(r.invoice_number || 'Без номера')}</strong><small>#${r.invoice_id}</small></div></td>
        <td data-label="Поставщик">${App.esc(r.supplier || 'Не указан')}</td>
        <td class="invoice-money-cell" data-label="Сумма">${r.total_sum != null ? App.formatMoney(r.total_sum) : '—'}</td>
        <td data-label="Удалена"><div class="invoice-cell-stack"><span>${App.esc(App.formatDateTime(r.deleted_at))}</span><small>${why ? `${App.esc(why)} · ` : ''}${left > 0 ? `ещё ${left} ${this.plural(left, 'день', 'дня', 'дней')}` : 'удалится сегодня ночью'}</small></div></td>
        <td class="cell-action"><button type="button" class="btn btn-outline btn-sm" onclick="Trash.restore(${r.id}, event)">Вернуть</button><button type="button" class="btn-link trash-forever" onclick="Trash.forever(${r.id}, event)">Удалить навсегда</button></td>
      </tr>`;
    }).join('');
  },

  plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  },

  async restore(id, ev) {
    return App.withBusyButton(ev?.currentTarget, async () => {
      try {
        const { data } = await App.apiJson(`/invoices/trash/${id}/restore`, { method: 'POST' });
        App.notify(`Накладная #${data.invoice_id} возвращена`, 'success');
        this.load();
      } catch (e) {
        App.notify(e.message || 'Не удалось вернуть накладную', 'error');
      }
    });
  },

  async forever(id, ev) {
    if (!window.confirm('Удалить накладную навсегда вместе с фото? Вернуть её уже не получится.')) return;
    return App.withBusyButton(ev?.currentTarget, async () => {
      try {
        await App.apiJson(`/invoices/trash/${id}`, { method: 'DELETE' });
        this.load();
      } catch (e) {
        App.notify(e.message || 'Не удалось удалить', 'error');
      }
    });
  },
};

if (typeof window !== 'undefined') window.Trash = Trash;
