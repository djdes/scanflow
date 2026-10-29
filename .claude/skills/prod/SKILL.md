---
name: prod
description: Доступ к прод-серверу и боевой базе ScanFlow из облачной сессии Claude: статус и логи PM2, команды на сервере, SQL только на чтение, запись только после явного «да» владельца. Использовать, когда нужно посмотреть, что происходит на проде, проверить данные в боевой базе, разобрать ошибку по логам или выполнить серверную операцию.
---

# Прод через мостик claude-ops

Из облачного контейнера SSH на сервер не открыть: наружу пропускаются только 80 и 443.
Команда идёт так:

1. `ops.mjs` шифрует запрос на ключ сервера (`server.pub`) и запускает workflow
   `.github/workflows/claude-ops.yml` через `gh api`.
2. GitHub Actions заходит на сервер по SSH с секретами деплоя этого репозитория и
   передаёт запрос `agent.mjs` (`~/.claude-ops/bin/` на сервере; кладётся заново при каждом запуске).
3. Агент выполняет bash-скрипт под пользователем деплоя и печатает ответ, зашифрованный
   на одноразовый ключ клиента. В журнале Actions только шифротекст, после чтения журнал удаляется.

Один вызов занимает 20–40 секунд. Несколько команд лучше собрать в один скрипт.

## Команды (из корня репозитория)

```bash
node .claude/skills/prod/ops.mjs status                      # pm2, диск, здоровье, версия
node .claude/skills/prod/ops.mjs logs --lines 300 [--err] [имя pm2]
node .claude/skills/prod/ops.mjs run -c 'команды'            # cwd — каталог приложения
node .claude/skills/prod/ops.mjs run --timeout 900 -f script.sh
node .claude/skills/prod/ops.mjs sql "SELECT ... "           # только чтение, до 500 строк
node .claude/skills/prod/ops.mjs sql --format vertical "SELECT * FROM t WHERE id = 1"
node .claude/skills/prod/ops.mjs sql --write "UPDATE ..."    # только после «да» владельца
```

Полный ответ сохраняется в `output/ops/<id>.txt`, в stdout попадают первые 60 КБ.
Даты из `sql` приходят строкой как лежат в базе (без перевода часовых поясов).

## Правила

1. **По умолчанию только чтение.** `status`, `logs`, `sql` без `--write`, `run` с командами,
   которые ничего не меняют (`ls`, `cat` логов, `grep`, `df`, `pm2 jlist`, `curl` на localhost).
2. **Любое изменение на проде — только после явного «да» владельца в чате.** Это рестарт или
   остановка PM2, правка и удаление файлов, `sql --write`, `npm`, миграции, crontab, выкладка.
   Сначала покажите точную команду и что она изменит. Код на прод попадает только через `main`
   (push → Deploy): правка руками на сервере стирается следующим деплоем.
3. **Секреты не печатать.** Не выводить `.env`, ключи, токены и пароли. Проверить переменную
   так: `grep -c '^NAME=' .env` или `grep -o '^NAME=' .env`, без значения.
4. **Персональные данные не выгружать в чат.** Email, телефоны, ИНН физлиц, суммы конкретных
   клиентов: только `COUNT`, агрегаты, `LIMIT` и маскирование. Нужна выборка — в файл
   `output/ops/…`, человеку сводка.
5. **Беречь базу:** запросы с `LIMIT` и по индексам. На запрос стоит `max_statement_time` 60 с
   (`--query-timeout`), `SELECT` без `LIMIT` обрезается до `--limit`+1 строк.

## Первый запуск и поломки

- Первый запрос после выкладки workflow сам получает ключ сервера и сохраняет его в
  `.claude/skills/prod/server.pub`. Этот файл нужно закоммитить: он открытый, секрета в нём нет.
  Явно получить ключ: `node .claude/skills/prod/ops.mjs pubkey --save`.
- `run «claude-ops …» не появился`: workflow ещё не в `main`, его нужно смержить.
- `request does not decrypt`: ключ сервера пересоздан, повторите `pubkey --save`.
- Ошибка 403 на `dispatches`: у `gh` нет права запускать workflow. Обходной путь:
  `node .claude/skills/prod/ops.mjs prepare -c '…'` печатает JSON. Передайте его в
  `mcp__github__actions_run_trigger` (`method: run_workflow`, `owner`, `repo`, `workflow_id`,
  `ref`, `inputs`), затем `node .claude/skills/prod/ops.mjs collect <id>`.
- Run упал до агента (SSH, секреты): журнал покажут `mcp__github__actions_list` и
  `mcp__github__get_job_logs`. Хвост журнала `ops.mjs` печатает сам.
- Журнал сервера: `~/.claude-ops/audit.log` (время, id, хеш скрипта, код выхода).

## Этот проект

- Пользователь деплоя `magday`, приложение — `~/www/scanflow.ru/app` (rsync из `main`, `.env` и `data/` серверные), PM2 `scanflow`.
- Логи Winston — `~/www/scanflow.ru/app/logs/`, конвейер файлов — `data/inbox|processed|failed`, суточные дампы базы — `data/backups/scanflow-ГГГГ-ММ-ДД.sql.gz` (14 штук).
- База — MariaDB 10.11, схема `scanflow`, переменные `DB_*` в `.env`. Время базы — МСК (`NOW()` = МСК), сроки токенов Сбера — UTC (правило 29).
- Миграции применяются при старте процесса (`pm2 restart`), номер прогнанной миграции не менять (правило 16).
- Изоляция компаний: `invoices.owner_user_id`; выборки по чужим компаниям в чат не выносить.
