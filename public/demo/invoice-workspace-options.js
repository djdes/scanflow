const demoState = { row: 2, corrected: false, reviewed: new Set(), document: 0 };
function demoToast(text) {
  const node = document.getElementById('demo-toast'); node.textContent = text; node.style.display = 'block';
  clearTimeout(demoToast.timer); demoToast.timer = setTimeout(() => node.style.display = 'none', 3500);
}
function selectMode(mode) {
  if (!['live', 'photo', 'review', 'batch'].includes(mode)) return;
  document.querySelectorAll('.mode').forEach(s => s.classList.toggle('active', s.id === mode));
  document.querySelectorAll('.option').forEach(b => { b.classList.toggle('active', b.dataset.mode === mode); b.setAttribute('aria-pressed', String(b.dataset.mode === mode)); });
  history.replaceState(null, '', '#' + mode);
}
document.querySelectorAll('.option').forEach(b => b.addEventListener('click', () => selectMode(b.dataset.mode)));
selectMode(location.hash.slice(1) || 'live');

function updateVerification() {
  const boxes = [...document.querySelectorAll('.verify-field input')];
  const count = boxes.filter(b => b.checked).length;
  boxes.forEach(b => { b.closest('label').classList.toggle('pending', !b.checked); b.closest('label').querySelector('.checked-label').textContent = b.checked ? 'Сверено' : 'Сверить'; });
  document.getElementById('header-status').textContent = `Проверено ${count} из ${boxes.length}`;
  document.getElementById('verify-hint').textContent = count === boxes.length ? 'Реквизиты сверены. Можно создать черновик; факт оплаты подтвердит банк.' : `Осталось сверить реквизитов: ${boxes.length - count}.`;
  document.getElementById('demo-payment').disabled = count !== boxes.length;
}
document.querySelectorAll('.verify-field input').forEach(b => b.addEventListener('change', updateVerification));
document.getElementById('demo-payment').addEventListener('click', () => demoToast('Демонстрация: после сверки создаётся черновик, затем он подписывается в банке. Платёж не отправлен.'));
document.querySelectorAll('[data-zoom]').forEach(b => b.addEventListener('click', () => { const img = document.getElementById(b.dataset.zoom + '-paper'); img.classList.toggle('zoomed'); b.textContent = img.classList.contains('zoomed') ? 'Вписать' : 'Увеличить'; }));
document.querySelector('[data-rotate]').addEventListener('click', () => document.getElementById('photo-paper').classList.toggle('rotated'));

function selectRow(row) {
  demoState.row = row;
  document.querySelectorAll('.line-table tr[data-row], .problem[data-row]').forEach(r => r.classList.toggle(r.classList.contains('problem') ? 'active' : 'selected', Number(r.dataset.row) === row));
  document.getElementById('row-highlight').style.top = `${(286 + row * 66) / 1080 * 100}%`;
  const arithmetic = row === 2 && !demoState.corrected;
  document.getElementById('selected-issue').textContent = `Строка ${row + 1} · ${arithmetic ? 'расхождение' : row === 4 ? 'цена выросла' : 'проверка'}`;
  document.getElementById('correction-title').textContent = arithmetic ? 'На фото цена 75,00 ₽' : row === 4 ? '650 ₽ вместо обычных 550 ₽' : 'Сверьте выбранную строку с оригиналом';
  document.getElementById('correction-text').textContent = arithmetic ? 'В распознанных данных — 57,00 ₽. Сумма строки 3 600 ₽ соответствует цене 75 ₽ при количестве 48.' : row === 4 ? 'Это изменение цены поставщика. Подтверждение не меняет цену документа; оно фиксирует, что вы заметили повышение.' : 'Название, количество, цена и сумма должны соответствовать строке документа.';
  document.getElementById('apply-correction').hidden = !arithmetic;
}
document.querySelectorAll('[data-row]').forEach(r => r.addEventListener('click', () => selectRow(Number(r.dataset.row))));
function renderCorrection() {
  document.getElementById('wrong-price').textContent = demoState.corrected ? '75,00' : '57,00';
  document.getElementById('wrong-price').classList.toggle('red-text', !demoState.corrected);
  document.getElementById('undo-correction').disabled = !demoState.corrected;
  document.getElementById('review-history').textContent = demoState.corrected ? 'Вы исправили цену: 57 → 75 ₽. Прежнее значение сохранено в истории демонстрации.' : 'После исправления здесь появится запись с прежним значением и возможностью отмены.';
  const remaining = Number(!demoState.corrected) + Number(!demoState.reviewed.has(4));
  document.getElementById('review-status').textContent = remaining ? `Замечаний: ${remaining}` : 'Замечания проверены';
  document.getElementById('review-footer').textContent = remaining ? `Осталось замечаний: ${remaining}` : 'Можно перейти к итоговой проверке и разрешению отправки';
  selectRow(demoState.row);
}
document.getElementById('apply-correction').addEventListener('click', () => { demoState.corrected = true; renderCorrection(); });
document.getElementById('undo-correction').addEventListener('click', () => { demoState.corrected = false; renderCorrection(); });
document.getElementById('mark-reviewed').addEventListener('click', () => { if (demoState.row === 2 && !demoState.corrected) { demoToast('Сначала исправьте расхождение цены или верните документ на уточнение.'); return; } demoState.reviewed.add(demoState.row); renderCorrection(); demoToast(`Строка ${demoState.row + 1} сверена в демонстрации.`); });
document.getElementById('next-demo-document').addEventListener('click', () => demoToast('В рабочем варианте: сохранить изменения и открыть следующий документ текущей очереди.'));
selectRow(2);

const documents = [
  ['РН-1048 · Молочная ферма', 'Требует решения', 'Сумма требует проверки', 'Проверьте оригинал и товары до передачи на согласование. Документ не должен уйти в оплату с нерешённым замечанием.'],
  ['УПД-871 · Рыбный порт', 'Проверяет Анна', 'Документ занят другим сотрудником', 'Можно смотреть документ. Редактирование и согласование станут доступны после завершения проверки Анной.'],
  ['ТН-392 · Овощной мир', 'Сверено', 'Проверка завершена', 'Реквизиты и товары сверены. Передайте документ руководителю на согласование оплаты.'],
];
document.querySelectorAll('[data-document]').forEach(b => b.addEventListener('click', () => {
  demoState.document = Number(b.dataset.document);
  const [title, stage, issue, text] = documents[demoState.document];
  document.querySelectorAll('[data-document]').forEach(n => n.classList.toggle('active', n === b));
  document.getElementById('batch-doc-name').textContent = title;
  document.getElementById('batch-stage').textContent = stage;
  document.getElementById('batch-issue').textContent = issue;
  document.getElementById('batch-description').textContent = text;
  document.getElementById('batch-history').textContent = 'Сейчас · ' + stage;
  document.getElementById('batch-check-total').textContent = demoState.document === 2 ? '✓ Итог сверён' : '○ Итог проверяется';
  document.getElementById('approve-demo-document').disabled = demoState.document !== 2;
  document.getElementById('return-demo-document').disabled = demoState.document === 1;
}));
document.getElementById('approve-demo-document').disabled = true;
document.getElementById('approve-demo-document').addEventListener('click', () => { document.getElementById('batch-stage').textContent = 'На согласовании'; document.getElementById('batch-history').textContent = 'Сейчас · Вы передали документ на согласование'; demoToast('Демонстрация: руководителю назначено согласование. В 1С и Сбер ничего не отправлено.'); });
document.getElementById('return-demo-document').addEventListener('click', () => { document.getElementById('batch-stage').textContent = 'На уточнении'; document.getElementById('batch-history').textContent = 'Сейчас · Документ возвращён на уточнение в демонстрации'; demoToast('Демонстрация: кладовщику предлагается уточнить документ или переснять нечитаемый лист.'); });
