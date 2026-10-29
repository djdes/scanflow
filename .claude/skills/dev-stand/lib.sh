#!/usr/bin/env bash
# Общие функции дев-стендов. Один и тот же файл лежит в docsflow, scanflow и TasksFlow:
# правите здесь — правьте и в соседних репозиториях.
#
# Стенд живёт только в облачном контейнере Claude (Linux, root): локальная MariaDB 10.11
# со временем МСК, как на проде, базы строго *_dev на 127.0.0.1, сервер в фоне,
# логи и pid — в output/dev-stand/ (каталог в .gitignore).

set -Eeuo pipefail

DS_ROOT="${DS_ROOT:?}"
# Прод-серверы живут по МСК: даты в базе, «сегодня» в отчётах и кронах считаются в нём.
export TZ="${DS_TZ:-Europe/Moscow}"
DS_OUT="$DS_ROOT/output/dev-stand"
mkdir -p "$DS_OUT"

# Root в Ubuntu входит только через сокет. Переменные MYSQL_HOST/MYSQL_PWD (их читает и клиент
# mariadb, и TasksFlow) уводят его на TCP, где root не пускают, — для служебных вызовов их убираем.
ds_sql() { env -u MYSQL_HOST -u MYSQL_PWD -u MYSQL_TCP_PORT mariadb --protocol=socket -uroot "$@"; }

ds_log() { echo "[dev-stand] $*" >&2; }
ds_die() {
  echo "[dev-stand] ОШИБКА: $*" >&2
  exit 1
}

ds_require_cloud() {
  [ "$(uname -s)" = Linux ] || ds_die "стенд рассчитан на облачный контейнер Linux"
  [ "$(id -u)" = 0 ] || ds_die "нужен root (в облачной сессии Claude он есть)"
}

# MariaDB как на проде: 10.11, время сервера МСК (+03:00), utf8mb4.
ds_mariadb_up() {
  if ! command -v mariadbd >/dev/null 2>&1; then
    ds_log "ставлю MariaDB (apt, ~20 с; быстрее — setup-скрипт окружения)"
    export DEBIAN_FRONTEND=noninteractive
    apt-get install -y -qq mariadb-server mariadb-client >/dev/null 2>&1 ||
      { apt-get update -qq >/dev/null && apt-get install -y -qq mariadb-server mariadb-client >/dev/null; } ||
      ds_die "не удалось поставить mariadb-server"
  fi
  local cnf=/etc/mysql/mariadb.conf.d/90-dev-stand.cnf
  if [ ! -f "$cnf" ]; then
    cat >"$cnf" <<'EOF'
# Дев-стенды Claude: как на проде — время сервера МСК, utf8mb4.
[mysqld]
default-time-zone = '+03:00'
character-set-server = utf8mb4
collation-server = utf8mb4_unicode_ci
max_connections = 300
EOF
    env -u MYSQL_HOST mariadb-admin --protocol=socket ping --silent >/dev/null 2>&1 && service mariadb restart >/dev/null 2>&1 || true
  fi
  if ! env -u MYSQL_HOST mariadb-admin --protocol=socket ping --silent >/dev/null 2>&1; then
    service mariadb start >/dev/null 2>&1 || true
    for _ in $(seq 1 30); do
      env -u MYSQL_HOST mariadb-admin --protocol=socket ping --silent >/dev/null 2>&1 && break
      sleep 1
    done
  fi
  env -u MYSQL_HOST mariadb-admin --protocol=socket ping --silent >/dev/null 2>&1 || ds_die "MariaDB не запустилась (journal: /var/log/mysql)"
}

ds_check_dev_db() {
  case "$1" in
    *_dev | *_dev_*) ;;
    *) ds_die "база «$1»: стенд работает только с базами *_dev" ;;
  esac
}

# База и пользователь с паролем (root в Ubuntu входит только через сокет, а приложения ходят по TCP).
ds_db_ensure() {
  local db="$1" user="$2" pass="$3"
  ds_check_dev_db "$db"
  ds_sql <<SQL
CREATE DATABASE IF NOT EXISTS \`$db\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$user'@'localhost' IDENTIFIED BY '$pass';
CREATE USER IF NOT EXISTS '$user'@'127.0.0.1' IDENTIFIED BY '$pass';
GRANT ALL ON \`$db\`.* TO '$user'@'localhost';
GRANT ALL ON \`$db\`.* TO '$user'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL
}

ds_db_grant() {
  local db="$1" user="$2"
  ds_sql -e "GRANT ALL ON \`$db\`.* TO '$user'@'localhost'; GRANT ALL ON \`$db\`.* TO '$user'@'127.0.0.1';"
}

ds_db_tables() {
  ds_sql -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$1'"
}

ds_db_drop() {
  ds_check_dev_db "$1"
  ds_sql -e "DROP DATABASE IF EXISTS \`$1\`"
}

# npm ci только когда менялись package.json / package-lock.json.
ds_deps() {
  local stamp=node_modules/.dev-stand-deps.sha256 want
  want="$(cat package.json package-lock.json | sha256sum | cut -d' ' -f1)"
  if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$want" ]; then return 0; fi
  ds_log "npm ci (зависимости поменялись или их нет)…"
  npm ci --no-audit --fund=false >"$DS_OUT/npm-ci.log" 2>&1 || {
    tail -30 "$DS_OUT/npm-ci.log" >&2
    ds_die "npm ci упал, полный лог: $DS_OUT/npm-ci.log"
  }
  echo "$want" >"$stamp"
}

# Пишет env-файл стенда. Чужой файл (без метки) не трогает никогда.
ds_write_env() {
  local f="$1" marker="# dev-stand:"
  if [ -f "$f" ] && ! grep -q "^$marker" "$f"; then
    ds_die "$f уже есть и создан не стендом — не трогаю. Переименуйте его, если он не нужен."
  fi
  {
    echo "$marker создан .claude/skills/dev-stand/stand.sh. Только локальная база *_dev, на прод не переносить."
    cat
  } >"$f"
}

ds_port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

ds_wait_http() {
  local url="$1" timeout="${2:-120}" waited=0
  until curl -fsS -o /dev/null --max-time 10 "$url" 2>/dev/null; do
    waited=$((waited + 2))
    [ "$waited" -ge "$timeout" ] && return 1
    sleep 2
  done
}

# Запуск в фоне в своей сессии процессов: переживает завершение вызова Bash.
ds_start() {
  local name="$1" port="$2"
  shift 2
  if ds_port_open "$port"; then
    ds_log "$name уже слушает :$port"
    return 0
  fi
  ds_log "запускаю $name на :$port, лог: output/dev-stand/$name.log"
  setsid nohup "$@" >"$DS_OUT/$name.log" 2>&1 </dev/null &
  echo $! >"$DS_OUT/$name.pid"
}

ds_stop() {
  local name="$1" pidf="$DS_OUT/$1.pid" pid
  [ -f "$pidf" ] || return 0
  pid="$(cat "$pidf")"
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 10); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    kill -KILL -- "-$pid" 2>/dev/null || true
    ds_log "$name остановлен"
  fi
  rm -f "$pidf"
}

ds_status_line() {
  local name="$1" port="$2" health="$3" pid="-" state
  [ -f "$DS_OUT/$name.pid" ] && pid="$(cat "$DS_OUT/$name.pid")"
  if curl -fsS -o /dev/null --max-time 5 "$health" 2>/dev/null; then state="работает"; elif ds_port_open "$port"; then state="порт открыт, health не отвечает"; else state="не запущен"; fi
  echo "$name: $state (pid $pid, :$port, $health)"
}
