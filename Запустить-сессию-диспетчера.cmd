@echo off
chcp 65001 >nul
rem Сессия-диспетчер ScanFlow (накладные + реквизиты поставщиков) на подписке Max.
rem
rem Ключевой момент: --mcp-config подсовывает АДМИНСКИЙ agent-токен из конфига ralph.
rem Очередь ai-prompt-job'ов отдаётся только диспетчеру проекта (admin@projectsflow.ru);
rem сессия, запущенная обычным способом, ходит токеном Ярослава и видит пустой список.
rem
rem После старта отправь в сессии:  /scanflow-dispatch
cd /d c:\www\ScanFlow
claude --mcp-config c:\www\ralph\mcp-projectsflow.json
