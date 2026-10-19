/* global App */
const Billing = {
  data: null,
  selectedPlanId: 'pro',
  historyTab: 'payments',
  requestId: 0,

  async load() {
    const container = document.getElementById('billing-content');
    if (!container) return;
    const requestId = ++this.requestId;
    this.data = null;
    container.setAttribute('aria-busy', 'true');
    container.innerHTML = '<div class="billing-loading" role="status"><span class="sr-only">Загружаем сведения об оплате</span><div></div><div></div><div></div></div>';
    try {
      const { data } = await App.apiJson('/billing');
      if (requestId !== this.requestId) return;
      if (!data || data.mode !== 'beta' || !Array.isArray(data.plans) || data.payments?.enabled !== false) {
        throw new Error('Не удалось получить сведения об оплате');
      }
      this.data = data;
      this.render();
    } catch (error) {
      if (requestId !== this.requestId) return;
      container.innerHTML = `<div class="billing-error" role="alert"><h2>Не удалось загрузить раздел</h2><p>${App.esc(error.message || 'Проверьте подключение и попробуйте ещё раз.')}</p><button type="button" class="btn btn-outline" onclick="Billing.load()">Попробовать снова</button></div>`;
    } finally {
      if (requestId === this.requestId) container.setAttribute('aria-busy', 'false');
    }
  },

  money(kopecks) { return new Intl.NumberFormat('ru-RU').format(kopecks / 100) + ' ₽'; },

  selectPlan(id) {
    if (!this.data?.plans.some(plan => plan.id === id)) return;
    this.selectedPlanId = id;
    document.querySelectorAll('#billing-plans [data-plan]').forEach(button => {
      const selected = button.dataset.plan === id;
      button.setAttribute('aria-pressed', String(selected));
      button.closest('.billing-plan').classList.toggle('is-selected', selected);
    });
    this.renderPlanDetail();
  },

  renderPlanDetail() {
    const target = document.getElementById('billing-plan-detail');
    const plan = this.data?.plans.find(plan => plan.id === this.selectedPlanId);
    if (!target || !plan) return;
    target.innerHTML = `<div><span class="billing-muted">Просмотр тарифа</span><h3>${App.esc(plan.name)} <span>${App.esc(this.money(plan.monthlyPriceKopecks))} / месяц</span></h3><p>После запуска: ${App.esc(new Intl.NumberFormat('ru-RU').format(plan.pagesPerMonth))} страниц в месяц. Сейчас лимит не применяется.</p></div><div class="billing-plan-action"><button type="button" class="btn btn-primary" disabled aria-describedby="billing-payment-hint">Оплата пока недоступна</button><span id="billing-payment-hint">Тариф не меняется, деньги не списываются</span></div>`;
  },

  showHistory(tab) {
    if (!['payments', 'documents'].includes(tab)) return;
    this.historyTab = tab;
    this.renderHistory();
  },

  renderHistory() {
    document.querySelectorAll('[data-billing-history]').forEach(button => {
      const selected = button.dataset.billingHistory === this.historyTab;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    const target = document.getElementById('billing-history-panel');
    if (!target) return;
    const documents = this.historyTab === 'documents';
    target.setAttribute('aria-labelledby', documents ? 'billing-tab-documents' : 'billing-tab-payments');
    target.innerHTML = `<div class="billing-empty-mark" aria-hidden="true">${documents ? '—' : '₽'}</div><h3>${documents ? 'Документов пока нет' : 'Платежей пока нет'}</h3><p>${documents ? 'После запуска оплаты здесь будут доступны документы по вашим платежам.' : 'Здесь появятся дата, сумма, тариф и статус каждой оплаты. Пока ScanFlow работает бесплатно.'}</p>`;
  },

  historyKeydown(event) {
    const tabs = ['payments', 'documents'];
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'payments' : event.key === 'End' ? 'documents' : tabs[1 - tabs.indexOf(this.historyTab)];
    this.showHistory(next);
    document.getElementById(`billing-tab-${next}`)?.focus();
  },

  render() {
    const container = document.getElementById('billing-content');
    if (!container || !this.data) return;
    const e = App.esc;
    if (!this.data.plans.some(plan => plan.id === this.selectedPlanId)) this.selectedPlanId = this.data.plans[0]?.id;
    const state = new URLSearchParams(location.hash.split('?')[1] || '').get('payment');
    const returnNote = ['returned', 'cancelled'].includes(state)
      ? '<div class="billing-return" role="status">Вы вернулись в раздел оплаты. Приём платежей ещё не открыт; статус доступа не изменился.</div>' : '';
    container.innerHTML = `${returnNote}
      <div class="billing-access">
        <div class="billing-access-main"><span class="billing-access-label">Ваш текущий доступ</span><h2>Пользуйтесь бесплатно</h2><p>Во время открытой беты все возможности ScanFlow доступны без оплаты и лимита страниц. О переходе на платные тарифы предупредим заранее.</p><a href="#/upload" class="btn btn-outline">Загрузить накладную</a></div>
        <div class="billing-access-price"><strong>0 <span>₽</span></strong><span>за использование сервиса</span><span class="billing-free-tag">Доступ открыт</span></div>
      </div>
      <div class="billing-facts">
        <div><span>Следующее списание</span><strong>Не назначено</strong><small>Платная подписка не оформлена</small></div>
        <div><span>Автопродление</span><strong>Выключено</strong><small>Регулярные списания не подключены</small></div>
        <div><span>Способ оплаты</span><strong>Не добавлен</strong><small>Станет доступен после запуска оплаты</small></div>
      </div>
      <div class="billing-block-heading"><h2>Тарифы после беты</h2><p>Сравните варианты заранее. Просмотр тарифа не меняет ваш текущий доступ.</p></div>
      <div class="billing-plans" id="billing-plans" role="group" aria-label="Просмотр будущих тарифов">${this.data.plans.map(plan => `<article class="billing-plan ${plan.id === this.selectedPlanId ? 'is-selected' : ''}"><div class="billing-plan-heading"><h3>${e(plan.name)}</h3>${plan.id === 'pro' ? '<span>Для регулярной работы</span>' : ''}</div><p class="billing-plan-price">${e(this.money(plan.monthlyPriceKopecks))}<span> / месяц</span></p><p class="billing-plan-quota">${e(new Intl.NumberFormat('ru-RU').format(plan.pagesPerMonth))} страниц в месяц</p><p class="billing-plan-description">${e(plan.description)}</p><ul>${plan.features.map(feature => `<li>${e(feature)}</li>`).join('')}</ul><button type="button" class="btn btn-outline" data-plan="${e(plan.id)}" aria-pressed="${plan.id === this.selectedPlanId}" onclick="Billing.selectPlan(this.dataset.plan)">Посмотреть тариф <span class="sr-only">${e(plan.name)}</span></button></article>`).join('')}</div>
      <div class="billing-plan-detail" id="billing-plan-detail" aria-live="polite"></div>
      <div class="billing-enterprise"><div><h3>Нужен индивидуальный формат?</h3><p>Enterprise — отдельный экземпляр, свои интеграции и условия для большого объёма.</p></div><a class="btn btn-outline" href="mailto:hi@scanflow.ru?subject=ScanFlow%20Enterprise">Обсудить условия</a></div>
      <div class="billing-history"><div class="billing-history-heading"><h2>История и документы</h2><span class="billing-muted">Только операции по оплате ScanFlow</span></div><div class="billing-history-tabs" role="tablist" aria-label="Платежи и документы" onkeydown="Billing.historyKeydown(event)"><button type="button" id="billing-tab-payments" role="tab" aria-controls="billing-history-panel" data-billing-history="payments" onclick="Billing.showHistory('payments')">Платежи</button><button type="button" id="billing-tab-documents" role="tab" aria-controls="billing-history-panel" data-billing-history="documents" onclick="Billing.showHistory('documents')">Документы</button></div><div class="billing-history-panel" id="billing-history-panel" role="tabpanel" tabindex="0"></div></div>
      <div class="billing-bottom"><div class="billing-provider"><span class="billing-provider-badge">R</span><div><h3>Онлайн-оплата через Robokassa</h3><p>Скоро в ScanFlow. Пока подключать карту и оплачивать сервис не нужно.</p><span>Приём платежей не подключён</span></div></div><div class="billing-faq"><h2>Об оплате</h2><details><summary>Нужно ли выбирать тариф сейчас?</summary><p>Нет. Во время открытой беты доступ бесплатный и не зависит от выбранного для просмотра тарифа.</p></details><details><summary>Будут ли деньги списываться автоматически?</summary><p>Сейчас автопродление выключено. Платная подписка и регулярные списания не подключены.</p></details><details><summary>Что появится в истории?</summary><p>После запуска оплаты — реальные операции с датой, суммой и статусом, а также доступные платёжные документы. Сейчас операций нет.</p></details></div></div>`;
    this.renderPlanDetail();
    this.renderHistory();
  },
};
