---
name: dev-stand
description: Поднять дев-версию ScanFlow в облачном контейнере Claude (локальная MariaDB 10.11 с демо-накладными и npm run dev на 127.0.0.1:8899) и прогнать тесты с базой (npm test на отдельной scanflow_dev_test), чтобы запустить приложение, проверить правку в живом кабинете, пройти конвейер на XML-накладной или снять скриншоты. Использовать перед visual-check и для любых тестов, которым нужна MariaDB.
---

# Дев-стенд ScanFlow

```bash
bash .claude/skills/dev-stand/stand.sh          # поднять: около минуты в первый раз, потом секунды
bash .claude/skills/dev-stand/stand.sh test     # весь vitest на базе scanflow_dev_test
bash .claude/skills/dev-stand/stand.sh test tests/xml   # часть тестов
bash .claude/skills/dev-stand/stand.sh status | logs 100 | down | reset
```

`up` по шагам:

1. Ставит и запускает MariaDB 10.11 с временем МСК.
2. Создаёт базу `scanflow_dev` и пишет `.env` с меткой стенда. Чужой `.env` без метки не трогает.
3. Делает `npm ci`, если менялся lock-файл.
4. Накатывает все миграции через `npm run reset-admin-password`: он вызывает тот же `initDb()` и
   заводит `admin` с ключом API из `.env`.
5. Кладёт демо (`seed.sql`): 4 вымышленные накладные в разных состояниях («готова», «требует
   внимания», «в 1С», «оплачена»), справочник 1С, поставщиков и скан к первой накладной.
6. Запускает `npm run dev` (nodemon + ts-node с `TS_NODE_TRANSPILE_ONLY`) и ждёт `/health`.

Логи — в `output/dev-stand/`.

- Адрес: **http://127.0.0.1:8899**, кабинет `/app.html#/invoices`.
- Вход: `admin` / `DemoPass1`. Ключ API для curl: `X-API-Key: dev-stand-api-key-0123456789abcdef`.
- Настоящий конвейер без ИИ: XML-накладные из `tests/xml/fixtures/` проходят распознавание и
  сопоставление без модели.
  `curl -H 'X-API-Key: dev-stand-api-key-0123456789abcdef' -F file=@tests/xml/fixtures/upd_501_ip_utf8.xml 127.0.0.1:8899/api/upload`.
- ИИ (ChatGPT/Claude), 1С (MCP), Сбер, почта и Telegram на стенде выключены пустыми переменными.
  Баннер «Распознавание приостановлено» — норма. `ONEC_*_MCP_CONFIG` не задавать: со стенда
  пошла бы синхронизация с боевыми базами 1С.
- База: `mariadb --protocol=socket -uroot scanflow_dev`.

Ускорить первый запуск: `cloud-setup.sh` рядом — это setup-скрипт облачного окружения. Его вставляют в настройки окружения (claude.ai/code → окружение → Edit → Setup script), и MariaDB с настройками МСК попадает в снапшот. Без него стенд ставит MariaDB сам, это дольше на 20 секунд.

## Правила

- Стенд только для облачного контейнера и только для баз `*_dev` на 127.0.0.1. На прод — скилл `prod`.
- Тесты — только через `stand.sh test`. Он задаёт `DB_HOST=127.0.0.1` и `DB_NAME=scanflow_dev_test`,
  которые требует страж в `tests/helpers/db.ts` (правило 17). Тесты чистят все таблицы своей базы,
  поэтому база у них своя.
- `npm run dev` накатывает миграции текущей ветки на `scanflow_dev`. Миграция, не попавшая в
  `main`, остаётся в `migration_history` стенда; при сомнениях — `stand.sh reset`.
- Снимки — скилл `visual-check`, он сам кладёт ключ API в localStorage.
