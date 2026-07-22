#!/usr/bin/env ts-node
/* eslint-disable no-console */
// Manual .env load — dotenv 17 silently loads 0 vars from this project's .env
// on Windows (encoding/CRLF issues with Cyrillic comments). Hand-parse to be safe.
import fs from 'fs';
import path from 'path';
const envText = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8');
// Force-override even if env var is already set — the Claude Code CLI's
// own OAuth token (sk-ant-oat01-...) sometimes leaks into the environment
// and would otherwise mask the project's API key from .env.
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}
console.log('DEBUG envText length:', envText.length);
console.log('DEBUG first 200:', envText.slice(0, 200).replace(/\n/g, '\\n'));
console.log('DEBUG ANTHROPIC_API_KEY len:', (process.env.ANTHROPIC_API_KEY ?? '').length);
console.log('DEBUG ANTHROPIC_API_KEY start:', (process.env.ANTHROPIC_API_KEY ?? '').slice(0, 20));
import { analyzeImageWithClaudeApi } from '../ocr/claudeApiAnalyzer';

async function main() {
  const photo = process.argv[2];
  if (!photo) {
    console.error('Usage: npm run test:claude-direct -- <photo.jpg>');
    process.exit(1);
  }
  const key = process.env.ANTHROPIC_API_KEY || '';
  if (!key) {
    console.error('ANTHROPIC_API_KEY missing');
    process.exit(1);
  }
  console.log(`Analyzing ${photo} via Claude API (model: claude-sonnet-5)...`);
  const t0 = Date.now();
  const result = await analyzeImageWithClaudeApi(photo, key, 'claude-sonnet-5');
  const dt = Date.now() - t0;
  console.log(`Done in ${(dt / 1000).toFixed(1)}s`);
  if (!result.success) {
    console.error('FAILED:', result.error);
    process.exit(1);
  }
  const data = result.data!;
  console.log('\n=== Parsed invoice ===');
  console.log(`  type:           ${data.invoice_type}`);
  console.log(`  number:         ${data.invoice_number}`);
  console.log(`  date:           ${data.invoice_date}`);
  console.log(`  supplier:       ${data.supplier}`);
  console.log(`  supplier_inn:   ${data.supplier_inn}`);
  console.log(`  total_sum:      ${data.total_sum}`);
  console.log(`  vat_sum:        ${data.vat_sum}`);
  console.log(`\n  items (${data.items.length}):`);
  for (const it of data.items.slice(0, 12)) {
    const name = (it.name ?? '').slice(0, 50);
    console.log(`    ${name.padEnd(50)} qty=${it.quantity} ${it.unit ?? ''}  ${it.price}×=${it.total}`);
  }
  if (data.items.length > 12) {
    console.log(`    ... +${data.items.length - 12} more`);
  }
}

main().catch(e => {
  console.error('CRASHED:', e);
  process.exit(1);
});
