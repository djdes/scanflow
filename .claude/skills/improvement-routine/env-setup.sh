#!/bin/bash
# Скрипт настройки облачной среды (claude.ai/code → среда → Setup script)
# для рутины, которая работает сразу по всем репозиториям в /home/user.
# Ставит зависимости npm в каждом клоне, чтобы проверки (tsc, vitest, smoke)
# шли сразу, без 1–3 минут npm ci на каждом заходе. Ошибка одного репозитория
# не останавливает остальные.
set -u
ROOT="${1:-/home/user}"
for d in scanflow ProjectsFlow OrdersFlow TasksFlow HASSR-Online; do
  dir="$ROOT/$d"
  [ -f "$dir/package-lock.json" ] || { echo "skip $d (нет package-lock.json)"; continue; }
  echo "== npm ci: $d"
  (cd "$dir" && npm ci --no-audit --no-fund >/dev/null 2>&1) \
    && echo "   ok" || echo "   ! npm ci упал в $d — рутина поставит сама"
done
# yesbeatru — PHP, зависимостей npm на корне нет (mjml/ ставится по месту).
exit 0
