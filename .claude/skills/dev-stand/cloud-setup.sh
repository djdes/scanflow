#!/bin/bash
# Setup-скрипт облачного окружения Claude для docsflow, scanflow и TasksFlow.
#
# Куда: claude.ai/code → окружение сессии → Edit → Setup script (вставить целиком).
# Выполняется до старта Claude, результат кэшируется снапшотом примерно на 7 дней,
# поэтому должен укладываться в 5 минут и не падать (ошибки гасятся `|| true`).
# Ставит только системное; всё остальное дев-стенды (.claude/skills/dev-stand) доставляют сами,
# так что без этого скрипта они тоже работают, просто первый запуск дольше на ~20 с.

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null 2>&1 || true

# MariaDB 10.11 — та же ветка, что на проде (10.11.14 на 29.10.2026).
apt-get install -y -qq --no-install-recommends mariadb-server mariadb-client unzip >/dev/null 2>&1 || true

# Как на проде: время сервера МСК, utf8mb4.
mkdir -p /etc/mysql/mariadb.conf.d
cat >/etc/mysql/mariadb.conf.d/90-dev-stand.cnf <<'EOF'
# Дев-стенды Claude: как на проде — время сервера МСК, utf8mb4.
[mysqld]
default-time-zone = '+03:00'
character-set-server = utf8mb4
collation-server = utf8mb4_unicode_ci
max_connections = 300
EOF

# Снапшот хранит файлы, а не процессы: сервер базы поднимает stand.sh в сессии.
service mariadb stop >/dev/null 2>&1 || true
exit 0
