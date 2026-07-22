#!/usr/bin/env ts-node
/* eslint-disable no-console */
// Standalone ingest: Claude API OCR a photo → persist invoice + items to DB.
// Bypasses file watcher (which has a Windows race that loses files).
//
// Usage: npx ts-node src/scripts/ingest-photo.ts <photo.jpg> [<photo2.jpg> ...]

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// Force-override env from .env (Claude Code CLI leaks its own ANTHROPIC_API_KEY).
const envText = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8');
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}

import { initDb, closeDb } from '../database/db';
import { invoiceRepo } from '../database/repositories/invoiceRepo';
import { analyzeImageWithClaudeApi } from '../ocr/claudeApiAnalyzer';

async function ingest(photoPath: string): Promise<void> {
  if (!fs.existsSync(photoPath)) {
    console.error(`File not found: ${photoPath}`);
    return;
  }
  const fileName = path.basename(photoPath);
  const fileBuf = fs.readFileSync(photoPath);
  const fileHash = crypto.createHash('sha256').update(fileBuf).digest('hex');

  console.log(`\n=== ${fileName} (${fileBuf.length.toLocaleString()} bytes) ===`);
  const t0 = Date.now();
  const result = await analyzeImageWithClaudeApi(
    photoPath,
    process.env.ANTHROPIC_API_KEY!,
    'claude-sonnet-5', // structured outputs require a supporting model (Sonnet 5+)
  );
  console.log(`  OCR done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (!result.success || !result.data) {
    console.error('  FAILED:', result.error);
    return;
  }
  const data = result.data;

  try {
    const invoice = await invoiceRepo.create({
      file_name: fileName,
      file_path: photoPath,
      file_hash: fileHash,
      ocr_engine: 'claude_api',
      invoice_type: data.invoice_type ?? undefined,
      invoice_number: data.invoice_number ?? undefined,
      invoice_date: data.invoice_date ?? undefined,
      supplier: data.supplier ?? undefined,
      supplier_inn: data.supplier_inn ?? undefined,
      supplier_bik: data.supplier_bik ?? undefined,
      supplier_account: data.supplier_account ?? undefined,
      supplier_corr_account: data.supplier_corr_account ?? undefined,
      supplier_address: data.supplier_address ?? undefined,
      total_sum: data.total_sum ?? undefined,
      vat_sum: data.vat_sum ?? undefined,
      raw_text: result.rawText ?? undefined,
    });
    await invoiceRepo.updateStatus(invoice.id, 'processed');
    console.log(`  invoice id=${invoice.id} created`);

    for (const it of data.items) {
      await invoiceRepo.addItem({
        invoice_id: invoice.id,
        original_name: it.name ?? '',
        mapped_name: undefined,
        quantity: it.quantity ?? undefined,
        unit: it.unit ?? undefined,
        price: it.price ?? undefined,
        total: it.total ?? undefined,
        vat_rate: it.vat_rate ?? undefined,
        mapping_confidence: 0,
        onec_guid: undefined,
      });
    }
    console.log(`  ${data.items.length} items written`);
    console.log(`  → http://localhost:8899/#/invoices/${invoice.id}`);
  } catch (e) {
    if ((e as Error).name === 'DuplicateFileHashError') {
      console.log(`  Already in DB (duplicate hash) — skipping`);
    } else {
      console.error(`  DB write failed:`, (e as Error).message);
    }
  }
}

async function main(): Promise<void> {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error('Usage: npx ts-node src/scripts/ingest-photo.ts <photo.jpg> [...]');
    process.exit(1);
  }
  await initDb();
  for (const p of paths) {
    await ingest(p);
  }
  await closeDb();
}

main().catch(e => {
  console.error('CRASHED:', e);
  process.exit(1);
});
