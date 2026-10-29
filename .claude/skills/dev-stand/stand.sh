#!/usr/bin/env bash
# Дев-стенд ScanFlow в облачном контейнере Claude: MariaDB 10.11 (МСК) + `npm run dev`
# (nodemon + ts-node) на :8899.
#
#   bash .claude/skills/dev-stand/stand.sh [up]   поднять (база, .env, зависимости, миграции, админ, демо, сервер)
#   bash .claude/skills/dev-stand/stand.sh status | logs [N] | down | reset
#   bash .claude/skills/dev-stand/stand.sh test [файлы vitest]   тесты на отдельной базе scanflow_dev_test
#
# Миграции 1…N накатывает само приложение (initDb); первым это делает reset-admin-password,
# он же создаёт admin с api_key = API_KEY. Вход: admin / DemoPass1 (или ключ API в localStorage).
# Интеграции (1С, Сбер, ИИ, почта, Telegram) на стенде выключены пустыми переменными.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DS_ROOT="$(cd "$HERE/../../.." && pwd)"
. "$HERE/lib.sh"
cd "$DS_ROOT"

DB=scanflow_dev
DB_USER=scanflow_dev
DB_PASS=devpass123
PORT=8899
URL="http://127.0.0.1:$PORT"
API_KEY=dev-stand-api-key-0123456789abcdef
ADMIN_PASSWORD=DemoPass1
# Тип-проверка всего проекта на каждом старте ts-node занимает минуты; CI её тоже не гоняет.
export TS_NODE_TRANSPILE_ONLY=true

write_env() {
  ds_write_env .env <<EOF
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASS
DB_NAME=$DB
API_PORT=$PORT
API_KEY=$API_KEY
JWT_SECRET=dev-stand-jwt-secret-only-for-local-db-0123456789abcdef
LOG_LEVEL=info
BACKUP_DIR=$DS_OUT/scanflow-backups
# Письма не уходят никуда (без SMTP и sendmail пишутся в logs/emails/).
SENDMAIL_PATH=/nonexistent
# Демо-накладные старше 14 дней не должны получать плашку «нет платёжки».
SBER_OVERDUE_DAYS=3650
# ONEC_*_MCP_CONFIG не задавать: с ними стенд синхронизировался бы с боевыми базами 1С.
EOF
}

# Скан для карточки: вымышленная накладная из public/demo, переведённая в PNG.
demo_scan() {
  local png=data/processed/demo-rn1048.png
  [ -f "$png" ] && return 0
  mkdir -p data/processed
  node -e '
    const { chromium } = require("/usr/local/lib/node_modules_global/playwright");
    (async () => {
      const b = await chromium.launch();
      const p = await b.newPage({ viewport: { width: 760, height: 1080 }, deviceScaleFactor: 2 });
      await p.goto("file://" + process.argv[1]);
      await p.screenshot({ path: process.argv[2] });
      await b.close();
    })().catch((e) => { console.error(e.message); process.exit(1); });
  ' "$DS_ROOT/public/demo/invoices-2026-10-02/sample-invoice.svg" "$png" || ds_log "скан для карточки не собрался (карточка покажет «файл удалён»)"
}

up() {
  ds_require_cloud
  ds_mariadb_up
  ds_db_ensure "$DB" "$DB_USER" "$DB_PASS"
  write_env
  ds_deps
  if [ "$(ds_sql -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$DB' AND table_name='users'")" = 0 ] ||
    [ "$(ds_sql -N -e "SELECT COUNT(*) FROM \`$DB\`.users")" = 0 ]; then
    ds_log "миграции и admin: npm run reset-admin-password (лог: output/dev-stand/migrate.log)"
    npm run -s reset-admin-password -- "$ADMIN_PASSWORD" >"$DS_OUT/migrate.log" 2>&1 || {
      tail -30 "$DS_OUT/migrate.log" >&2
      ds_die "миграции упали"
    }
  fi
  if [ "$(ds_sql -N -e "SELECT COUNT(*) FROM \`$DB\`.invoices")" = 0 ]; then
    ds_log "демо-накладные (seed.sql)"
    demo_scan
    sed "s#__ROOT__#$DS_ROOT#g" "$HERE/seed.sql" | ds_sql "$DB" || ds_die "seed.sql упал"
  fi
  ds_start scanflow "$PORT" npm run dev
  ds_log "жду $URL/health…"
  ds_wait_http "$URL/health" 180 || {
    tail -40 "$DS_OUT/scanflow.log" >&2
    ds_die "сервер не ответил, лог: output/dev-stand/scanflow.log"
  }
  echo "ScanFlow: $URL  (вход: admin / $ADMIN_PASSWORD; кабинет $URL/app.html#/invoices; X-API-Key: $API_KEY)"
}

# Тесты с базой: tests/helpers/db.ts пускает только 127.0.0.1/localhost и имя с «test»
# и перед каждым тестом очищает все таблицы — поэтому отдельная база scanflow_dev_test.
run_tests() {
  ds_require_cloud
  ds_mariadb_up
  ds_db_ensure scanflow_dev_test "$DB_USER" "$DB_PASS"
  # SBER_OVERDUE_DAYS из .env стенда (3650) ломал бы тесты просрочки: им нужен штатный срок.
  DB_HOST=127.0.0.1 DB_NAME=scanflow_dev_test SBER_OVERDUE_DAYS=14 npm test -- "$@"
}

case "${1:-up}" in
  up) up ;;
  test)
    shift
    run_tests "$@"
    ;;
  down) ds_stop scanflow ;;
  status) ds_status_line scanflow "$PORT" "$URL/health" ;;
  logs) tail -n "${2:-80}" "$DS_OUT/scanflow.log" ;;
  reset)
    ds_stop scanflow
    ds_mariadb_up
    ds_db_drop "$DB"
    rm -f data/processed/demo-rn1048.png
    up
    ;;
  *) ds_die "команды: up | test [файлы] | status | logs [N] | down | reset" ;;
esac
