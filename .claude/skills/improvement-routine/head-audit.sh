#!/usr/bin/env bash
# Сверка <head> боевых сайтов за один проход: код ответа, canonical, robots,
# типы JSON-LD и — главное — чем на самом деле отвечает og:image.
# SVG в og:image = ссылка в Telegram/WhatsApp/VK уходит без картинки
# (так найден TasksFlow #17). Только чтение, ничего не меняет.
#   bash head-audit.sh                 # все сайты
#   bash head-audit.sh https://x.ru/a  # свои адреса
set -u
URLS=("$@")
if [ ${#URLS[@]} -eq 0 ]; then
  URLS=(https://scanflow.ru/ https://scanflow.ru/blog https://projectsflow.ru/
        https://ordersflow.ru/ https://ordersflow.ru/blog https://tasksflow.ru/
        https://tasksflow.ru/blog https://yesbeat.ru/ https://wesetup.ru/)
fi
for u in "${URLS[@]}"; do
  html=$(curl -s --retry 2 -m 25 -L -A "Mozilla/5.0" -w '\n__CODE=%{http_code}' "$u") || { echo "== $u  НЕ ОТКРЫЛСЯ"; continue; }
  code=${html##*__CODE=}
  og=$(printf '%s' "$html" | grep -oiE 'property="og:image" content="[^"]+"' | head -1 | sed -E 's/.*content="([^"]+)"/\1/')
  canon=$(printf '%s' "$html" | grep -oiE '<link[^>]*rel="canonical"[^>]*>' | head -1 | grep -oE 'href="[^"]+"')
  robots=$(printf '%s' "$html" | grep -oiE 'name="robots" content="[^"]+"' | head -1)
  types=$(printf '%s' "$html" | grep -oE '"@type": ?"[A-Za-z]+"' | sed -E 's/.*"([A-Za-z]+)"$/\1/' | sort -u | tr '\n' ' ')
  echo "== $u  [$code]"
  echo "   canonical: ${canon:-НЕТ}   ${robots:-}"
  echo "   JSON-LD: ${types:-НЕТ}"
  if [ -z "$og" ]; then echo "   og:image: НЕТ  ← находка"; continue; fi
  ct=$(curl -s --retry 2 -m 20 -L -o /dev/null -A "Mozilla/5.0" -w '%{content_type} %{http_code} %{size_download}' "$og")
  flag=""; case "$ct" in image/png*|image/jpeg*|image/webp*) ;; *) flag="  ← находка: мессенджеры не покажут";; esac
  echo "   og:image: $og → $ct$flag"
done
