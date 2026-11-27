#!/usr/bin/env bash
# SEO-инварианты по ИСХОДНИКАМ всех репозиториев — работает, даже когда из облака
# не открываются боевые сайты (27.11: head-audit.sh не достучался ни до одного, кроме
# scanflow.ru/blog). Только чтение. Каждая строка вывода — кандидат в находку, проверить глазами.
#   bash seo-grep.sh            # все репозитории в /home/user
set -u
ROOT=${ROOT:-/home/user}
EXCL=(--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=.next --exclude-dir=compiled --exclude-dir=cache)
section() { echo; echo "== $1"; }

section "lastmod = «сегодня» (робот перестаёт верить lastmod всего sitemap; так найдены scanflow и OrdersFlow 27.11)"
grep -rnE "lastmod.*(today|new Date\(\)|date\('Y-m-d'\)|toISOString)" "${EXCL[@]}" --include=*.ts --include=*.tsx --include=*.mts --include=*.php "$ROOT" 2>/dev/null | grep -viE "test|smoke|\.date\.toISOString" | head -20

section "SVG в og:image / twitter:image (мессенджеры не покажут превью)"
grep -rnE "(og:image|twitter:image)[^>]{0,120}\.svg" "${EXCL[@]}" --include=*.ts --include=*.tsx --include=*.html --include=*.tpl --include=*.astro "$ROOT" 2>/dev/null | head -20

section "noindex вне служебных страниц (проверить, что это намеренно)"
grep -rnE "(robots[^>]{0,40}noindex|X-Robots-Tag[^)]{0,40}noindex)" "${EXCL[@]}" --include=*.ts --include=*.tsx --include=*.html --include=*.tpl --include=*.astro "$ROOT" 2>/dev/null | grep -viE "test|admin|cabinet|/m/|login|404" | head -20

section "canonical на http:// или с localhost"
grep -rnE "rel=.?canonical[^>]{0,120}(http://|localhost)" "${EXCL[@]}" "$ROOT" 2>/dev/null | head -10
