/* global App */
// «Претензия поставщику» (2026-11-17): письмо из данных накладной — позиции дороже обычной
// цены (медиана прошлых поставок, как подсветка «цена +N%» в строке) и расхождение суммы
// строк с итогом. Ничего не отправляем сами: текст можно поправить, скопировать, скачать
// или открыть в почте.
const Claim = {
  // Порог как у подсветки в строке товара: «цена +N%» показывается при N > 10.
  THRESHOLD_PCT: 10,

  money(v) {
    return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(v) || 0);
  },
  date(d) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ''));
    return m ? `${m[3]}.${m[2]}.${m[1]}` : (d || '');
  },

  /** Позиции с ценой выше обычной и переплата по каждой (чистая функция). */
  overpriced(inv) {
    return (inv.items || []).filter(it => it.price_deviation_pct != null && Number(it.price_deviation_pct) > this.THRESHOLD_PCT
        && it.median_price != null && Number(it.price) > Number(it.median_price))
      .map(it => {
        const qty = Number(it.quantity) || 0;
        const over = Math.round((Number(it.price) - Number(it.median_price)) * qty * 100) / 100;
        return { name: it.original_name || it.mapped_name || 'Товар', unit: it.unit || '', qty, price: Number(it.price), usual: Number(it.median_price), pct: Math.round(Number(it.price_deviation_pct)), over };
      });
  },

  /** Расхождение суммы строк с итогом накладной, ₽ (0 — сходится). */
  totalGap(inv) {
    if (Number(inv.items_total_mismatch) !== 1 || inv.total_sum == null) return 0;
    const sum = (inv.items || []).reduce((acc, it) => acc + (Number(it.total) || 0), 0);
    return Math.round((Number(inv.total_sum) - sum) * 100) / 100;
  },

  available(inv) {
    return this.overpriced(inv).length > 0 || this.totalGap(inv) !== 0;
  },

  /** Текст претензии (чистая функция — тесты в tests/frontend/claim.test.ts). */
  build(inv, today = new Date()) {
    const rows = this.overpriced(inv);
    const gap = this.totalGap(inv);
    const doc = `накладной № ${inv.invoice_number || inv.id}${inv.invoice_date ? ` от ${this.date(inv.invoice_date)}` : ''}`;
    const lines = [
      `Кому: ${inv.supplier || 'поставщику'}${inv.supplier_inn ? ` (ИНН ${inv.supplier_inn})` : ''}`,
      '',
      `Претензия по ${doc}`,
      '',
    ];
    let claimSum = 0;
    if (rows.length) {
      lines.push('Следующие позиции поставлены по цене выше обычной (средняя цена наших прошлых закупок у вас):');
      rows.forEach((r, i) => {
        claimSum += r.over;
        lines.push(`${i + 1}. ${r.name}: ${this.money(r.price)} ₽${r.unit ? ` за ${r.unit}` : ''} вместо обычных ${this.money(r.usual)} ₽ (+${r.pct}%), количество ${r.qty} — переплата ${this.money(r.over)} ₽.`);
      });
      lines.push('', `Итого переплата: ${this.money(claimSum)} ₽.`, '');
    }
    if (gap !== 0) {
      lines.push(`Сумма по строкам накладной не совпадает с итогом документа: расхождение ${this.money(Math.abs(gap))} ₽ (${gap > 0 ? 'итог больше суммы строк' : 'итог меньше суммы строк'}).`, '');
    }
    const ask = rows.length && gap !== 0
      ? 'Просим скорректировать цены и итог документа и прислать корректировочный документ (УКД).'
      : rows.length
        ? `Просим подтвердить цены или прислать корректировочный документ (УКД) на сумму ${this.money(claimSum)} ₽.`
        : 'Просим проверить итог документа и прислать исправленный или корректировочный документ (УКД).';
    lines.push(ask, '', `Дата: ${this.date(today.toISOString().slice(0, 10))}`);
    return { text: lines.join('\n'), subject: `Претензия по ${doc}`, claimSum, rows, gap };
  },

  open(inv) {
    const { text, subject } = this.build(inv);
    let dlg = document.getElementById('claim-dialog');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'claim-dialog';
      dlg.className = 'claim-dialog';
      dlg.innerHTML = `<div class="claim-head"><h2>Претензия поставщику</h2><button type="button" class="shortcuts-close" data-claim-close aria-label="Закрыть">×</button></div>
        <p class="claim-hint">Текст собран из цен выше обычных и расхождения суммы. Поправьте его при необходимости — мы ничего не отправляем сами.</p>
        <textarea id="claim-text" rows="16" spellcheck="true" aria-label="Текст претензии"></textarea>
        <div class="claim-actions"><button type="button" class="btn btn-outline btn-sm" data-claim-download>Скачать .txt</button><a class="btn btn-outline btn-sm" data-claim-mail href="#">Открыть в почте</a><button type="button" class="btn btn-primary btn-sm" data-claim-copy>Скопировать</button></div>`;
      document.body.appendChild(dlg);
      dlg.querySelector('[data-claim-close]').onclick = () => dlg.close();
      dlg.addEventListener('click', ev => { if (ev.target === dlg) dlg.close(); });
    }
    const area = dlg.querySelector('#claim-text');
    area.value = text;
    const current = () => area.value;
    dlg.querySelector('[data-claim-copy]').onclick = async () => {
      try { await navigator.clipboard.writeText(current()); App.notify('Текст претензии скопирован', 'success'); }
      catch { area.select(); document.execCommand('copy'); App.notify('Текст претензии скопирован', 'success'); }
    };
    dlg.querySelector('[data-claim-download]').onclick = () => {
      const blob = new Blob([current()], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `Претензия ${String(inv.invoice_number || inv.id).replace(/[\\/:*?"<>|]/g, '_')}.txt`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    dlg.querySelector('[data-claim-mail]').onclick = (ev) => {
      ev.preventDefault();
      window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(current())}`;
    };
    dlg.showModal();
  },
};

if (typeof window !== 'undefined') window.Claim = Claim;
