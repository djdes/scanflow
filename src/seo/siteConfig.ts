/**
 * Настройки публичных страниц, которые нужны скриптам в браузере: номер
 * счётчика Яндекс Метрики и флаг A/B-проверки заголовка главной.
 *
 * Сервер подставляет их в метку <!--SITE-CONFIG--> в <head> главной, блога и
 * правовых документов как window.SF_SITE. Нет номера счётчика — нет ни
 * сообщения о cookie, ни счётчика, ни A/B (без счётчика проверять нечем).
 * Счётчик грузится только после согласия посетителя (public/js/landing.js).
 */
export interface SiteConfig {
  metrika?: number;
  heroAb?: boolean;
}

export function siteConfig(env: NodeJS.ProcessEnv = process.env): SiteConfig {
  const cfg: SiteConfig = {};
  const id = (env.YANDEX_METRIKA_ID || '').trim();
  if (/^\d{1,12}$/.test(id) && Number(id) > 0) cfg.metrika = Number(id);
  if (cfg.metrika && /^(1|true|on|yes)$/i.test((env.SITE_HERO_AB || '').trim())) cfg.heroAb = true;
  return cfg;
}

const MARK = '<!--SITE-CONFIG-->';

/** В скрипт попадают только число и булево — экранировать нечего. */
export function injectSiteConfig(html: string, cfg: SiteConfig = siteConfig()): string {
  const script = cfg.metrika ? `<script>window.SF_SITE=${JSON.stringify(cfg)};</script>` : '';
  return html.split(MARK).join(script);
}
