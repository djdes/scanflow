#!/usr/bin/env bash
# Карты сайта и RSS боевых сайтов за один проход: код ответа, валидный ли XML,
# сколько адресов в sitemap и сколько из выборки отвечают не 200, есть ли RSS блога.
# 000 = не ответил (часто прокси облака — перепроверить), 301 = в sitemap редирект.
# Битый адрес в sitemap = робот тратит обход на 404; нет RSS = статьи не попадают
# в Дзен, Feedly и Telegram-боты RSS. Только чтение. Нужен xmllint (libxml2-utils).
#   bash feed-audit.sh                    # все сайты
#   bash feed-audit.sh https://x.ru       # свои
#   SAMPLE=50 bash feed-audit.sh          # сколько адресов sitemap проверять (по умолчанию 15)
set -u
SITES=("$@")
[ ${#SITES[@]} -eq 0 ] && SITES=(https://scanflow.ru https://projectsflow.ru https://ordersflow.ru
                                  https://tasksflow.ru https://yesbeat.ru https://wesetup.ru)
SAMPLE=${SAMPLE:-15}
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
for s in "${SITES[@]}"; do
  echo "== $s"
  code=$(curl -s --retry 2 -m 25 -L -A "Mozilla/5.0" -o "$tmp/sm.xml" -w '%{http_code}' "$s/sitemap.xml") || code=ERR
  if [ "$code" = 200 ] && xmllint --noout "$tmp/sm.xml" 2>/dev/null; then
    grep -oE '<loc>[^<]+</loc>' "$tmp/sm.xml" | sed -E 's#</?loc>##g' > "$tmp/locs"
    total=$(wc -l < "$tmp/locs"); bad=0
    while read -r u; do
      c=$(curl -s --retry 2 -m 20 -o /dev/null -A "Mozilla/5.0" -w '%{http_code}' "$u")
      [ "$c" = 200 ] || { bad=$((bad+1)); echo "   sitemap → $c  $u"; }
    done < <(shuf -n "$SAMPLE" "$tmp/locs")
    echo "   sitemap: $total адресов, в выборке $SAMPLE не 200: $bad"
  else
    echo "   sitemap: $code (или не XML)"
  fi
  found=""
  for p in /blog/rss.xml /rss.xml /feed /blog/feed; do
    c=$(curl -s --retry 2 -m 20 -A "Mozilla/5.0" -o "$tmp/rss" -w '%{http_code}' "$s$p")
    if [ "$c" = 200 ] && grep -q '<rss\|<feed' "$tmp/rss"; then
      xmllint --noout "$tmp/rss" 2>/dev/null && v=ok || v="НЕ XML"
      found="$p ($v, записей: $(grep -c '<item>\|<entry>' "$tmp/rss"))"; break
    fi
  done
  echo "   rss: ${found:-нет}"
done
