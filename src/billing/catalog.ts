// Published plans from public/index.html. These are previews during open beta;
// superadmins can also assign specific plans/limits per account.
export const billingPlans = [
  { id: 'start', name: 'Старт', monthlyPriceKopecks: 0, pagesPerMonth: 50,
    description: 'Для небольшого потока документов',
    features: ['Распознавание основных типов документов', 'Многостраничные накладные', 'Выгрузка в 1С:УНФ', 'Уведомления в Telegram'] },
  { id: 'pro', name: 'Pro', monthlyPriceKopecks: 99000, pagesPerMonth: 1000,
    description: 'Для регулярной работы с накладными',
    features: ['Всё из тарифа «Старт»', 'Черновики платежей в СберБизнес', 'ИИ-подбор товаров из каталога 1С', 'Приоритетная поддержка в Telegram'] },
  { id: 'business', name: 'Бизнес', monthlyPriceKopecks: 499000, pagesPerMonth: 10000,
    description: 'Для большого объёма закупок',
    features: ['Всё из тарифа Pro', 'Webhook на свои события', 'Помощь с настройкой 1С', 'Расширенное сопровождение'] },
] as const;

export interface BillingUserContext {
  tariff_plan?: string | null;
  tariff_limit?: number | null;
  tariff_expires_at?: string | null;
}

export function getBillingOverview(user?: BillingUserContext) {
  const rawPlan = user?.tariff_plan && user.tariff_plan !== 'beta' ? user.tariff_plan : null;
  const matchedPlan = rawPlan ? billingPlans.find((p) => p.id === rawPlan) : undefined;

  let subscription = {
    planId: null as string | null,
    name: 'Открытая бета',
    monthlyPriceKopecks: 0,
    nextPaymentAt: user?.tariff_expires_at ?? null,
    autoRenewal: false,
    pageLimit: user?.tariff_limit ?? null,
  };

  if (matchedPlan) {
    subscription = {
      planId: matchedPlan.id,
      name: matchedPlan.name,
      monthlyPriceKopecks: matchedPlan.monthlyPriceKopecks,
      nextPaymentAt: user?.tariff_expires_at ?? null,
      autoRenewal: false,
      pageLimit: user?.tariff_limit !== undefined && user?.tariff_limit !== null
        ? user.tariff_limit
        : matchedPlan.pagesPerMonth,
    };
  } else if (rawPlan === 'unlimited') {
    subscription = {
      planId: 'unlimited',
      name: 'Безлимит',
      monthlyPriceKopecks: 0,
      nextPaymentAt: user?.tariff_expires_at ?? null,
      autoRenewal: false,
      pageLimit: user?.tariff_limit ?? null,
    };
  }

  return {
    mode: 'beta', currency: 'RUB',
    subscription,
    payments: { enabled: false, provider: 'robokassa', connected: false },
    plans: billingPlans,
    // No payment ledger exists yet. Never synthesize transactions or receipts.
    history: [], documents: [],
  };
}
