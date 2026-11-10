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
| ProjectsFlow | JSON-LD главной с ценами и FAQ (#28), Dependabot (#26) |
| OrdersFlow | og:image в PNG (#6, ждёт решения) |
| TasksFlow | Тарифы в JSON-LD `AggregateOffer` (#12) |
| scanflow | Dependabot (#15), gitleaks (#8), npm audit (#6, #9) — ждут решения |
| yesbeatru | проверка секретов в PR (#537) |

Дополняй таблицу в каждом PR этого скилла — или полагайся на `ledger.mjs`.

### Идеи, ещё не сделанные (бери сверху, вычёркивай)

- **scanflow** (лендинг/блог): JSON-LD `SoftwareApplication` + `Offer` по тарифам и `FAQPage`
  на главной; `BlogPosting` + `BreadcrumbList` в статьях; `hreflang`/canonical на пагинации.
- **OrdersFlow**: `Restaurant`/`Menu` JSON-LD на гостевом меню `/m/:slug` — сниппеты в поиске для ресторанов клиентов.
- **yesbeatru**: `MusicRecording`/`Product` + `Offer` в карточке трека (цена, BPM, длительность) —
  витрина в Google/Яндексе; `ItemList` в каталоге. Выкладка — двумя PR (main + prod).
- **TasksFlow**: `HowTo`-разметка на кластерных страницах блога; прайс-якорь «за сотрудника в месяц».
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
правило «ботов не трогать», готовый текст промпта (`PROMPT.md`).
Кандидаты на следующие разы: проверка сниппетов через Rich Results Test в Playwright;
ежемесячный отчёт по позициям из Яндекс.Вебмастера (нужен токен в секретах среды);
снимки «до/после» визуальных PR прямо в описании (скилл visual-check).

## Облачная среда: Setup script

claude.ai/code → настройки среды рутины → **Setup script**: вставить содержимое
`env-setup.sh` (или `bash /home/user/scanflow/.claude/skills/improvement-routine/env-setup.sh`,
если репозитории к этому моменту уже клонированы). Тогда `npm ci` не тратит время в каждом заходе.
