#!/usr/bin/env ts-node
/* eslint-disable no-console */
// Pre-populate nomenclature_mappings: for each onec_nomenclature row,
// generate 5-7 plausible OCR/abbreviation variants via Claude, then
// INSERT IGNORE into the mappings table (UNIQUE on scanned_name).
//
// Run against LOCAL (or override with env). DOES NOT touch prod unless
// DB_HOST / DB_NAME are pointed at it.
//
// Usage: npx ts-node src/scripts/generate-mappings.ts [--batch=25]

import fs from 'fs';
import path from 'path';

// Force-override env from .env (Claude Code CLI leaks its own ANTHROPIC_API_KEY).
const envText = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8');
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}

import Anthropic from '@anthropic-ai/sdk';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { initDb, getDb, closeDb } from '../database/db';
import { jsonrepair } from 'jsonrepair';

interface OnecRow {
  guid: string;
  name: string;
  unit: string | null;
}

function getBatchSize(): number {
  const arg = process.argv.find(a => a.startsWith('--batch='));
  if (!arg) return 25;
  return Math.max(5, Math.min(50, parseInt(arg.split('=')[1], 10)));
}

function createClient(apiKey: string): Anthropic {
  const proxyUrl = process.env.ANTHROPIC_PROXY_URL;
  if (proxyUrl) {
    const dispatcher = new ProxyAgent(proxyUrl);
    const proxiedFetch: typeof globalThis.fetch = (url, init) =>
      undiciFetch(url as any, { ...init as any, dispatcher }) as any;
    return new Anthropic({ apiKey, fetch: proxiedFetch });
  }
  return new Anthropic({ apiKey });
}

const SYSTEM_PROMPT = `Ты помогаешь магазину предзаполнить справочник «как поставщики могут писать товар в накладных» для автоматического сопоставления OCR-результатов с 1С-справочником.

Для каждого товара из 1С верни 5-8 ПРАВДОПОДОБНЫХ вариантов того, как этот же товар мог бы быть напечатан в накладной/счёте от разных поставщиков:
  • полное название как в 1С (с теми же словами/порядком)
  • краткие формы (Капуста б/к, Капуста бк, Капуста)
  • перестановки слов («Молоко 1л» / «1л молоко»)
  • вариации единиц (если 1С говорит «кг», можно «кг» и «гр»; «шт» можно «уп» если возможно)
  • опечатки/OCR-ошибки (одна буква не та, "о"→"а"), но ОДНА ошибка, не каша
  • с лишним прилагательным («натуральный», «свежий») если уместно
  • БЕЗ выдуманных брендов и СКУ кодов

ВАЖНО:
  • Не делай вариант, который мог бы относиться к ДРУГОМУ товару из этого же списка — это запутает маппер.
  • Каждый вариант — отдельная строка, без пояснений.
  • НЕ выдумывай товары которых нет в списке.

Верни СТРОГО валидный JSON, никакого markdown:
{"variants":{"<guid>":["вариант1","вариант2",...],...}}`;

async function generateVariantsBatch(client: Anthropic, batch: OnecRow[]): Promise<Record<string, string[]>> {
  const itemsBlock = batch.map(r => `[${r.guid}] ${r.name}${r.unit ? ' (' + r.unit + ')' : ''}`).join('\n');
  const userMsg = `Сгенерируй варианты для следующих ${batch.length} позиций:\n\n${itemsBlock}`;

  const resp = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMsg }],
  });
  const block = resp.content.find(b => b.type === 'text');
  if (!block || block.type !== 'text') throw new Error('no text in response');
  let raw = block.text.trim();
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON object in response');
  let parsed: { variants?: Record<string, string[]> };
  try {
    parsed = JSON.parse(m[0]);
  } catch {
    parsed = JSON.parse(jsonrepair(m[0]));
  }
  return parsed.variants || {};
}

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY!;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY missing');
  const dbHost = process.env.DB_HOST || '';
  const dbName = process.env.DB_NAME || '';
  console.log(`Target DB: ${dbHost}/${dbName}`);
  if (dbName !== 'scanflow') {
    console.error('Safety stop: this script expects DB_NAME=scanflow (local or prod).');
    process.exit(1);
  }
  if (dbHost !== '127.0.0.1' && dbHost !== 'localhost') {
    console.error(`Refusing to run against non-local DB_HOST="${dbHost}". Override only after confirming with user.`);
    process.exit(1);
  }

  await initDb();
  const db = getDb();
  const rows = await db.prepare(
    `SELECT guid, name, unit FROM onec_nomenclature_cards WHERE is_folder = 0 OR is_folder IS NULL ORDER BY name`
  ).all<OnecRow>();
  console.log(`Catalog: ${rows.length} items`);

  const batchSize = getBatchSize();
  const client = createClient(apiKey);

  let totalInserted = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(rows.length / batchSize);
    process.stdout.write(`  [${batchNum}/${totalBatches}] ${batch.length} items → `);
    let variants: Record<string, string[]>;
    try {
      const t0 = Date.now();
      variants = await generateVariantsBatch(client, batch);
      process.stdout.write(`${((Date.now() - t0) / 1000).toFixed(1)}s, `);
    } catch (e) {
      console.log(`FAIL: ${(e as Error).message}`);
      totalFailed += batch.length;
      continue;
    }

    let inserted = 0, skipped = 0;
    for (const onec of batch) {
      const list = variants[onec.guid] || [];
      for (const v of list) {
        const clean = (v || '').trim();
        if (!clean || clean.length > 500) continue;
        try {
          const res = await db.prepare(
            `INSERT INTO nomenclature_mappings (scanned_name, mapped_name_1c, default_unit, approved, onec_guid, times_seen)
             VALUES (?, ?, ?, 1, ?, 0)`
          ).run(clean, onec.name, onec.unit ?? null, onec.guid);
          if ((res as any).changes > 0) inserted++;
          else skipped++;
        } catch (e) {
          if (/Duplicate entry|UNIQUE/i.test((e as Error).message)) skipped++;
          else { console.error('  insert err:', (e as Error).message); totalFailed++; }
        }
      }
    }
    totalInserted += inserted;
    totalSkipped += skipped;
    console.log(`${inserted} inserted, ${skipped} dups`);
  }

  console.log(`\n=== DONE ===`);
  console.log(`Inserted: ${totalInserted}`);
  console.log(`Skipped (dups): ${totalSkipped}`);
  console.log(`Failed batches/inserts: ${totalFailed}`);

  await closeDb();
}

main().catch(e => {
  console.error('CRASHED:', e);
  process.exit(1);
});
