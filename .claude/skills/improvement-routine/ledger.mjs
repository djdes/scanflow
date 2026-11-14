#!/usr/bin/env node
// Журнал заходов рутины «улучшения по трендам GitHub» по всем репозиториям.
// Печатает: (1) открытые PR владельца/рутины, ждущие решения; (2) последние
// закрытые/слитые — чтобы не предлагать то же самое повторно.
// Dependabot и чужие боты не показываются. Нужен gh (в облаке он настроен).
//   node .claude/skills/improvement-routine/ledger.mjs [--days 45]
import { execFileSync } from "node:child_process";

const REPOS = ["scanflow", "ProjectsFlow", "OrdersFlow", "yesbeatru", "TasksFlow", "HASSR-Online"];
const BOTS = /\[bot\]$/;
const daysArg = process.argv.indexOf("--days");
const days = daysArg > 0 ? Number(process.argv[daysArg + 1]) : 45;
const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);

function search(q) {
  try {
    const out = execFileSync("gh", ["api", "-X", "GET", "search/issues", "-f", `q=${q}`, "-f", "per_page=50", "-f", "sort=created"], { encoding: "utf8" });
    return JSON.parse(out).items ?? [];
  } catch (e) {
    console.error(`! поиск не удался: ${q}\n  ${String(e.message).split("\n")[0]}`);
    return [];
  }
}

for (const repo of REPOS) {
  const items = search(`repo:djdes/${repo} is:pr created:>=${since}`).filter((i) => !BOTS.test(i.user?.login ?? ""));
  const open = items.filter((i) => i.state === "open");
  const closed = items.filter((i) => i.state !== "open");
  console.log(`\n== ${repo}  (открыто ${open.length}, закрыто ${closed.length} за ${days} дн.)`);
  for (const i of open) console.log(`  ОТКРЫТ  #${i.number} ${i.created_at.slice(0, 10)} ${i.title}`);
  for (const i of closed.slice(0, 15)) {
    const merged = i.pull_request?.merged_at ? "слит  " : "закрыт";
    console.log(`  ${merged}  #${i.number} ${i.created_at.slice(0, 10)} ${i.title}`);
  }
}
