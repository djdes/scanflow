---
name: improvement-routine
description: Порядок плановой рутины «тренды GitHub → предложения по улучшению» по всем репозиториям djdes (scanflow, ProjectsFlow, OrdersFlow, yesbeatru, TasksFlow, HASSR-Online). Журнал уже сделанного (ledger.mjs), чек-лист идей по визуалу, SEO и финансам, правила, что трогать нельзя, и формат письма владельцу. Использовать в начале каждого захода этой рутины, до поиска трендов.
---

# Рутина «тренды GitHub → предложения»

Владелец получает письмо с PR и сам решает: мерджить или удалить ветку.
**Эта рутина PR не сливает** (в отличие от рутины визуальных багов из CLAUDE.md,
у которой своё правило «сливать до и после»).

## 0. Подготовка (1–2 мин)

```bash
cd /home/user
for d in */; do (cd "$d" && git fetch --all --prune -q && echo "$d $(git rev-list --left-right --count HEAD...origin/main 2>/dev/null)"); done
node scanflow/.claude/skills/improvement-routine/ledger.mjs --days 30
```

`ledger.mjs` — журнал: открытые PR (ждут решения владельца) и закрытые/слитые за
период, без Dependabot. **Не предлагай то, что уже есть в журнале** — ни открытым,
ни слитым, ни закрытым (закрытый = владелец отказался).

Если в среде нет `node_modules` — `bash scanflow/.claude/skills/improvement-routine/env-setup.sh`
(его же стоит поставить в Setup script облачной среды, см. ниже).

## 1. Тренды

```bash
gh api -X GET search/repositories -f q="created:>$(date -d '-30 days' +%F) stars:>300" -f sort=stars -f per_page=30 \
  --jq '.items[]|"\(.full_name) ★\(.stargazers_count) \(.description)"'
gh api -X GET search/repositories -f q="topic:seo pushed:>$(date -d '-14 days' +%F) stars:>200" -f sort=stars -f per_page=10 --jq '.items[]|.full_name'
gh api -X GET search/repositories -f q="topic:claude-skills stars:>100" -f sort=updated -f per_page=10 --jq '.items[]|.full_name'
```

Бери только то, что реально применимо к стеку (Node/Express/React/vanilla JS, PHP/Smarty
у yesbeatru). Абстрактный хайп (инференс моделей, игры, CAD) — мимо.

## 2. Выбор: приоритет — визуал, SEO, финансы

Один-два PR за заход, но законченных: тест, `tsc`/lint, сниппет «до/после» в описании.
Каждый PR — в своём репозитории, в его назначенной ветке `claude/*`.

### Уже сделано (не повторять)

| Репозиторий | Сделано |
|---|---|
| ProjectsFlow | JSON-LD главной с ценами и FAQ (#28), Dependabot (#26), soft-404 → настоящий 404 у SPA (#92) |
| OrdersFlow | og:image в PNG (#6, закрыт), цена тарифа в пререндере и JSON-LD (#11) |
| TasksFlow | Тарифы в JSON-LD `AggregateOffer` (#12), выгода длинного срока (#15), LCP лендинга (#16), `og:image` в PNG (#17, ждёт решения) |
| scanflow | Dependabot (#15), gitleaks (#8), npm audit (#6, #9) — ждут решения |
| yesbeatru | проверка секретов в PR (#537) |
| scanflow, OrdersFlow | `lastmod` в sitemap без «сегодня» (27.11) |

Дополняй таблицу в каждом PR этого скилла — или полагайся на `ledger.mjs`.

### Ждут слияния (не повторять)

- **TasksFlow**: `og:image` в PNG вместо SVG — [#17](https://github.com/djdes/TasksFlow/pull/17).
- **yesbeatru**: зачёркнутая цена и `priceValidUntil` в JSON-LD товара. Открыты [#590 в `main`](https://github.com/djdes/yesbeatru/pull/590) и [#591 в `prod`](https://github.com/djdes/yesbeatru/pull/591).

### Идеи, ещё не сделанные (бери сверху, вычёркивай)

- ~~**scanflow**: JSON-LD главной и статей~~ — уже есть (`SoftwareApplication`, `FAQPage`, `BlogPosting`). Цена «0 ₽, открытая бета»
  в разметке верна, пока идёт бета: тарифы 990/4 990 ₽ переносить в `offers` — когда включится оплата.
  Осталось: RSS блога (`/blog/rss.xml`, как у OrdersFlow).
- ~~**OrdersFlow**: `Restaurant`/`Menu` JSON-LD на `/m/:slug`~~ — не делать: страница `noindex`, разметку поиск не увидит.
- **yesbeatru**: ~~`Product` + `Offer`~~ (уже есть с 10.09); осталось `ItemList` в каталоге и `MusicRecording` (BPM, длительность) в карточке трека (цена, BPM, длительность) —
  витрина в Google/Яндексе; `ItemList` в каталоге. Выкладка — двумя PR (main + prod).
- **TasksFlow**: прайс-якорь «за сотрудника в месяц». (`HowTo` не делать: Google убрал этот расширенный сниппет в 2023.)
- **HASSR-Online**: аудит Core Web Vitals лендинга (LCP-картинка с `fetchpriority=high`, `font-display`).
- Финансы везде: годовая оплата со скидкой (если в биллинге есть `months: 12`) — показать экономию на лендинге.
- Визуал: прогнать скилл [`heydamir/unslop`](https://github.com/heydamir/unslop) по одной странице
  и взять только 2–3 правки, совместимые с дизайн-системой репозитория.

## 3. Что не трогать

- PR Dependabot и других ботов, PR людей и других сессий — не сливать, не закрывать, не комментировать.
- Старые PR этой рутины — только перечислить в письме «ждут решения».
- Не мержить свой PR: решение владельца. Деплой — только через `main`.
- Секреты, `.env`, прод-данные — никогда в коммит и в письмо.

## 4. Письмо владельцу (PushNotification = пуш + почта)

```
<routine_summary>
<главное: что за PR и зачем — одна фраза>. <ссылка>.
Что сделано: … Эффект: … Риски: … Проверки: …
Ждут решения с прошлых заходов: …
Идея для рутины: <каждый раз новая, см. п. 5>
</routine_summary>
```

## 5. Улучшение самой рутины — каждый раз новое

В конце письма одна новая идея, которой нет в этом списке; добавь её сюда же в PR.

Уже предложено: скилл с журналом (этот файл), Setup script среды (`env-setup.sh`),
правило «ботов не трогать», готовый текст промпта (`PROMPT.md`),
сверка «разметка ↔ видимая цена» на проде: `curl` главной, вытащить `offers` из JSON-LD и
числа рядом с «₽» из HTML без JS — расхождение = находка (так найден OrdersFlow #11: робот
видел «0 ₽», а разметка — 4 900–19 900 ₽ при цене 15 000).
Тренды по языку стека, а не по звёздам вообще (в общем топе — эмуляторы и хайп):
`gh api -X GET search/repositories -f q="language:PHP created:>$(date -d '-90 days' +%F) stars:>100" -f sort=stars`
(и `TypeScript`). OSS Insight trends с 01.03.2026 недоступен — не тратить на него время.
Сверка `<head>` всех боевых сайтов одной командой — `bash head-audit.sh` (рядом с этим файлом): код ответа,
canonical, типы JSON-LD и чем на самом деле отвечает `og:image`. SVG или не-картинка в `og:image` = ссылка в
Telegram/WhatsApp/VK без превью (так найден TasksFlow #17). Запускать в п. 0, до выбора идеи; единичное
«НЕ ОТКРЫЛСЯ» — сбой прокси облака, перепроверить.
Обход soft-404 по всем сайтам: `curl -o /dev/null -w '%{http_code}' https://<сайт>/no-such-page-xyz`;
200 = находка (так найден ProjectsFlow #92; scanflow, OrdersFlow и TasksFlow уже отдают 404).
Проверки боевых сайтов (и `head-audit.sh`) — с раннера GitHub Actions, а не из облачного контейнера: 21.11 из
контейнера не открылись scanflow.ru, wesetup.ru и yesbeat.ru (len=0), projectsflow.ru — через раз.
Нужен еженедельный workflow `seo-probe.yml` (curl: код главной, неизвестного пути, robots,
sitemap, llms.txt, canonical, og:image) с отчётом в summary; рутина читает итог через `actions_list`.
SEO-инварианты по исходникам — `bash seo-grep.sh` (рядом с этим файлом): `lastmod` = «сегодня» в sitemap,
SVG в `og:image`, `noindex`, canonical на http/localhost — grep по всем репозиториям, сеть не нужна. Запускать
в п. 0 вместе с `head-audit.sh`: 27.11 из облака не открылся ни один боевой сайт, а grep нашёл «сегодня» в
sitemap scanflow и OrdersFlow.
Кандидаты на следующие разы: проверка сниппетов через Rich Results Test в Playwright;
ежемесячный отчёт по позициям из Яндекс.Вебмастера (нужен токен в секретах среды);
снимки «до/после» визуальных PR прямо в описании (скилл visual-check).

## Облачная среда: Setup script

claude.ai/code → настройки среды рутины → **Setup script**: вставить содержимое
`env-setup.sh` (или `bash /home/user/scanflow/.claude/skills/improvement-routine/env-setup.sh`,
если репозитории к этому моменту уже клонированы). Тогда `npm ci` не тратит время в каждом заходе.
